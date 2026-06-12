import React, { useState, useEffect } from 'react';
import { ArrowRight, ArrowLeft, Check, Loader2, ChevronDown, ChevronUp, ExternalLink, AlertTriangle, Copy } from 'lucide-react';

// =====================================================
// MEALFRAME HANDOFF
// PLACEHOLDER — set this to MealFrame's real deployed URL when it's live.
// The "Continue to MealFrame" button appends ?code=<MM1 code>, mirroring the
// PhysiquePlan → MacroMetric click-through.
// =====================================================
const MEALFRAME_URL = 'https://mealframe.raduantoniu.com';

// =====================================================
// UNIT CONVERSION HELPERS
// =====================================================

const cmToFtIn = (cm) => {
  const totalInches = cm / 2.54;
  const ft = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches - ft * 12);
  return { ft, inches };
};

const ftInToCm = (ft, inches) => (parseFloat(ft) * 12 + parseFloat(inches)) * 2.54;
const kgToLb = (kg) => kg * 2.20462;
const lbToKg = (lb) => lb / 2.20462;

// =====================================================
// ROUNDING HELPERS
// =====================================================

const roundUpTo50 = (x) => Math.ceil(x / 50) * 50;
const roundToNearest5 = (x) => Math.round(x / 5) * 5;

// =====================================================
// PLAN DURATION
// The block destination AND the recommended rate of change are SHIPPED in the
// SS1 code (fields 13 & 14). MacroMetric no longer owns a rate model — it reads
// the rate off the code and derives the same duration PhysiquePlan displays:
//   cut  → rate is fractional bodyweight / WEEK
//   bulk → rate is fractional bodyweight / MONTH
// Mirror of PhysiquePlan's formatDuration / duration math so the two agree.
// =====================================================

function planDurationWeeks({ direction, weight, destWeight, rate }) {
  if (!rate || rate <= 0) return 0;
  if (direction === 'cut') {
    const weeklyLoss = weight * rate;
    return Math.max(0, (weight - destWeight) / weeklyLoss);
  }
  const monthlyGain = weight * rate;
  const months = Math.max(0, (destWeight - weight) / monthlyGain);
  return months * (52 / 12);
}

function formatDuration(weeks) {
  const w = Math.max(1, Math.round(weeks));
  if (w < 14) return { weeks: w, label: `${w} weeks` };
  const months = Math.round(w / 4.345);
  return { weeks: w, label: `${w} weeks (~${months} months)` };
}

// =====================================================
// ░░░ TUNING SURFACE ░░░
// Calorie knobs a coach would retune live here. NOTE: the RATE of bodyweight
// change is no longer here — PhysiquePlan owns it and ships it in the SS1 code
// (field 14). What remains below are MacroMetric-side calorie decisions only.
// =====================================================

// --- MAINTENANCE: muscle-mass adjustment -------------------------------------
const TIER_MAINTENANCE_ADJ = { novice: 0, intermediate: 40, proficient: 80, advanced: 120 }; // kcal/day

// Per-step NET cost above resting.
const STEPS_KCAL_PER_STEP = 0.03;

const WORKOUT_KCAL = 200; // per resistance-training session

// Per minute of NON-STEP cardio only (cycling, swimming, rowing, elliptical, yoga).
const CARDIO_KCAL_PER_MIN = 7;

// --- CUTTING: deficit ceiling ------------------------------------------------
// The cut RATE comes from the code. This is the kcal/day deficit CAP — a pure
// calorie-side safety bound (keeps the cut sane/hormonal for heavier clients).
// It rarely binds for the intermediate clientele; when it does, the calories
// trail the shipped rate slightly while the DISPLAYED duration still uses the
// shipped rate (so PhysiquePlan and MacroMetric print the same number).
const CUT_DEFICIT_CAP_BY_HEIGHTDIFF = [
  { maxDiff: 70,       cap: 800 },
  { maxDiff: 80,       cap: 700 },
  { maxDiff: 90,       cap: 600 },
  { maxDiff: 100,      cap: 600 },
  { maxDiff: Infinity, cap: 500 },
];

function getCutDeficitCap(heightDiff) {
  const band = CUT_DEFICIT_CAP_BY_HEIGHTDIFF.find((b) => heightDiff <= b.maxDiff)
    || CUT_DEFICIT_CAP_BY_HEIGHTDIFF[CUT_DEFICIT_CAP_BY_HEIGHTDIFF.length - 1];
  return band.cap;
}

// --- BULKING: surplus (calorie knob — NOT the gain rate) ---------------------
// The gain RATE comes from the code. The surplus % below is a separate calorie
// decision (how big a surplus to run), so it stays here.
const BULK_SURPLUS_PCT = { novice: 0.15, intermediate: 0.11, proficient: 0.08, advanced: 0.06 };
const BULK_SURPLUS_SUBBRACKET_MULT = [1.10, 1.00, 0.90]; // [low, mid, high]
const BULK_SURPLUS_CAP = 500; // kcal/day

// --- PROTEIN ----------------------------------------------------------------
const PROTEIN_COEFF = {
  cut:  { novice: 0.85, intermediate: 0.88, proficient: 0.92, advanced: 1.00 },
  bulk: { novice: 0.75, intermediate: 0.80, proficient: 0.85, advanced: 0.90 },
};
const PROTEIN_SUBBRACKET_NUDGE = [-0.02, 0.00, 0.02]; // [low, mid, high]

// --- FAT --------------------------------------------------------------------
const FAT_PCT = { cut: 0.35, bulk: 0.30 };

// --- FIBER ------------------------------------------------------------------
const FIBER_PER_1000KCAL = 14;

// =====================================================
// SHREDSMART CODE — decoder (schema v1)
// Contract: SS1-<base64url(payload)>-<checksum>
// payload = 14 fields joined by '|'. MUST mirror PhysiquePlan's encoder exactly.
// Fields 13-14 are the destination + rate PhysiquePlan now ships:
//   13 destWeight  block destination (kg) — the target weight for THIS plan
//   14 rate        fractional bodyweight change (cut: /week, bulk: /month)
// =====================================================

const SCHEMA_PREFIX = 'SS1';
const TIER_NAME = ['novice', 'intermediate', 'proficient', 'advanced'];

function checksum2(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) % 1296; // 36^2
  }
  return h.toString(36).padStart(2, '0');
}

function base64urlDecode(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return atob(t);
}

// Returns { ok:true, data } or { ok:false, error } where error is one of:
// 'empty' | 'format' | 'version' | 'corrupt' | 'checksum' | 'fields'
function decodeShredSmartCode(raw) {
  if (!raw || !raw.trim()) return { ok: false, error: 'empty' };
  const parts = raw.trim().split('-');
  if (parts.length !== 3) return { ok: false, error: 'format' };
  const [prefix, body, checksum] = parts;

  if (prefix !== SCHEMA_PREFIX) {
    // A recognizable-but-newer schema (SS2, SS3…) → ask for a re-run, don't misdecode.
    if (/^SS\d+$/i.test(prefix)) return { ok: false, error: 'version' };
    return { ok: false, error: 'format' };
  }

  let payload;
  try {
    payload = base64urlDecode(body);
  } catch {
    return { ok: false, error: 'corrupt' };
  }
  if (checksum2(payload) !== checksum) return { ok: false, error: 'checksum' };

  const f = payload.split('|');
  if (f.length < 14) return { ok: false, error: 'fields' };

  const tierIdx = parseInt(f[4], 10);
  const data = {
    units: f[0] === 'i' ? 'imperial' : 'metric', // 1
    sex: f[1] || 'm',                             // 2
    height: parseInt(f[2], 10),                   // 3  cm
    weight: parseFloat(f[3]),                     // 4  kg
    tier: TIER_NAME[tierIdx] ?? 'novice',         // 5
    tierIdx,
    score: parseFloat(f[5]),                      // 6
    subBracket: parseInt(f[6], 10),               // 7  0/1/2
    archetypeId: parseInt(f[7], 10),              // 8  narrative only
    direction: f[8] === 'c' ? 'cut' : 'bulk',     // 9  recommendation
    goalLow: parseFloat(f[9]),                    // 10 kg (ultimate goal, north star)
    goalHigh: parseFloat(f[10]),                  // 11 kg
    genDate: f[11],                               // 12 YYYYMMDD
    destWeight: parseFloat(f[12]),                // 13 kg  block destination
    rate: parseFloat(f[13]),                      // 14 fractional (cut /wk, bulk /mo)
  };

  if (
    isNaN(data.height) || isNaN(data.weight) || isNaN(data.subBracket) ||
    isNaN(data.destWeight) || isNaN(data.rate)
  ) {
    return { ok: false, error: 'fields' };
  }
  return { ok: true, data };
}

// Age of the plan in weeks, for the staleness nudge. null if undateable.
function genDateAgeWeeks(genDate) {
  if (!genDate || genDate.length !== 8) return null;
  const y = +genDate.slice(0, 4);
  const m = +genDate.slice(4, 6) - 1;
  const d = +genDate.slice(6, 8);
  const then = new Date(y, m, d);
  if (isNaN(then.getTime())) return null;
  return (Date.now() - then.getTime()) / (1000 * 60 * 60 * 24 * 7);
}

// =====================================================
// MACROMETRIC CODE — encoder (schema MM1)
// The handoff to MealFrame™, mirroring the SS1 design. Carries MacroMetric's
// COMPUTED outputs (target/macros/fiber/maintenance) PLUS pass-through fields
// so downstream apps never re-decode SS1, INCLUDING the rate (field 14) so a
// returning check-in pre-fills the target rate by reading it — MacroMetric no
// longer owns a rate model to recompute it from.
//
// Contract (14 fields, '|'-joined — MealFrame's decoder MUST mirror EXACTLY):
//   1  units        'i' | 'm'              (display only)
//   2  direction    'c' (cut) | 'b' (bulk)
//   3  targetKcal   int
//   4  protein      int  g
//   5  fat          int  g
//   6  carbs        int  g
//   7  fiber        int  g    (minimum target)
//   8  tier         int  0-3  (matches SS1 tierIdx)
//   9  subBracket   int  0|1|2 (low/mid/high — matches SS1 subBracket)
//   10 weight       kg, ≤1 decimal (pass-through / latest check-in)
//   11 height       int cm        (pass-through from SS1)
//   12 maintenance  int kcal      (computed here from age/activity)
//   13 genDate      YYYYMMDD      (staleness)
//   14 rate         fractional bodyweight change (cut /wk, bulk /mo) — from SS1
// Wrapped: MM1-<base64url(payload)>-<checksum>
//
// MealFrame ignores field 14 (its decoder gates on length, append-only), so this
// addition is backward-compatible with the MealFrame MM1 decoder.
// =====================================================

const MM_SCHEMA_PREFIX = 'MM1';

function base64urlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function genDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function buildMacroMetricCode(result, units) {
  const tierIdx = TIER_NAME.indexOf(result.tier); // word → index; mirrors SS1
  const fields = [
    units === 'imperial' ? 'i' : 'm',             // 1  units (display)
    result.direction === 'cut' ? 'c' : 'b',       // 2  direction
    String(Math.round(result.target)),            // 3  target kcal
    String(Math.round(result.protein)),           // 4  protein g
    String(Math.round(result.fat)),               // 5  fat g
    String(Math.round(result.carbs)),             // 6  carbs g
    String(Math.round(result.fiber)),             // 7  fiber g
    String(tierIdx >= 0 ? tierIdx : 0),           // 8  tier index 0-3
    String(result.subBracket),                    // 9  subBracket 0/1/2
    String(Math.round(result.weight * 10) / 10),  // 10 weight kg (≤1 dp)
    String(Math.round(result.height)),            // 11 height cm
    String(Math.round(result.maintenance)),       // 12 maintenance kcal
    genDateStr(),                                 // 13 genDate
    (result.rate ?? 0).toFixed(5),                // 14 rate (cut /wk, bulk /mo)
  ];
  const payload = fields.join('|');
  return `${MM_SCHEMA_PREFIX}-${base64urlEncode(payload)}-${checksum2(payload)}`;
}

// =====================================================
// MACROMETRIC CODE — decoder (schema MM1)
// Mirror of buildMacroMetricCode. Used by the CHECK-IN flow so a returning user
// pastes the MM1 code and we recover tier/subBracket/height/maintenance/rate —
// the fields the check-in form never collects but a complete output needs.
//
// Returns { ok:true, data } or { ok:false, error } where error is one of:
// 'empty' | 'format' | 'version' | 'wrongcode' | 'corrupt' | 'checksum' | 'fields'
// =====================================================

function decodeMacroMetricCode(raw) {
  if (!raw || !raw.trim()) return { ok: false, error: 'empty' };
  const parts = raw.trim().split('-');
  if (parts.length !== 3) return { ok: false, error: 'format' };
  const [prefix, body, checksum] = parts;

  if (prefix !== MM_SCHEMA_PREFIX) {
    if (/^MM\d+$/i.test(prefix)) return { ok: false, error: 'version' };
    if (/^SS\d+$/i.test(prefix)) return { ok: false, error: 'wrongcode' };
    return { ok: false, error: 'format' };
  }

  let payload;
  try {
    payload = base64urlDecode(body);
  } catch {
    return { ok: false, error: 'corrupt' };
  }
  if (checksum2(payload) !== checksum) return { ok: false, error: 'checksum' };

  const f = payload.split('|');
  // Current MM1 is 14 fields; anything shorter is an older/partial code → re-run.
  if (f.length < 14) return { ok: false, error: 'fields' };

  const tierIdx = parseInt(f[7], 10);
  const data = {
    units: f[0] === 'i' ? 'imperial' : 'metric', // 1
    direction: f[1] === 'c' ? 'cut' : 'bulk',     // 2
    target: parseInt(f[2], 10),                   // 3
    protein: parseInt(f[3], 10),                  // 4
    fat: parseInt(f[4], 10),                      // 5
    carbs: parseInt(f[5], 10),                    // 6
    fiber: parseInt(f[6], 10),                    // 7
    tier: TIER_NAME[tierIdx] ?? 'novice',         // 8
    tierIdx,
    subBracket: parseInt(f[8], 10),               // 9
    weight: parseFloat(f[9]),                     // 10 kg
    height: parseInt(f[10], 10),                  // 11 cm
    maintenance: parseInt(f[11], 10),             // 12 kcal
    genDate: f[12],                               // 13
    rate: parseFloat(f[13]),                      // 14 fractional (cut /wk, bulk /mo)
  };

  if (
    isNaN(data.target) || isNaN(data.protein) ||
    isNaN(data.weight) || isNaN(data.height) || isNaN(data.subBracket) ||
    isNaN(data.rate)
  ) {
    return { ok: false, error: 'fields' };
  }
  return { ok: true, data };
}

// =====================================================
// CLASSIFICATION LABELS (narrative only — no math reads these)
// =====================================================

const ARCHETYPE_NAMES = [
  'Skinny-Fat (Higher Body Fat)',   // 0
  'Skinny-Fat (Lower Body Fat)',    // 1
  'Hard Gainer / Skinny',           // 2
  'Decent Muscle, Higher Body Fat', // 3
  'Intermediate, Mid-Range',        // 4
  'Lean Intermediate',              // 5
  'Strong but Higher Body Fat',     // 6
  'Almost There',                   // 7
  'Lean & Muscular',                // 8
  'Advanced Lifter',                // 9
];

const SUBBRACKET_WORD = { 0: 'Low', 1: '', 2: 'High' };

function subBracketTierLabel(tier, subBracket) {
  const tierWord = {
    novice: 'Novice',
    intermediate: 'Intermediate',
    proficient: 'Proficient',
    advanced: 'Advanced',
  }[tier] || 'Novice';
  const w = SUBBRACKET_WORD[subBracket];
  return w ? `${w}-${tierWord}` : tierWord;
}

// =====================================================
// MAINTENANCE CALCULATION
// Mifflin-St Jeor (male) + factorial components × 1.10 TEF, + tier muscle adj.
// =====================================================

function calculateMaintenance({ weight, height, age, workouts, cardio, steps, job, tier }) {
  const bmr = 10 * weight + 6.25 * height - 5 * age + 5;
  const neat = bmr * 0.20;
  const workoutsKcal = (workouts * WORKOUT_KCAL) / 7;
  const cardioKcal = (cardio * CARDIO_KCAL_PER_MIN) / 7;
  const stepsKcal = steps * STEPS_KCAL_PER_STEP;
  const jobKcal = { desk: 0, feet: 100, physical: 200 }[job];
  const muscleAdj = TIER_MAINTENANCE_ADJ[tier] ?? 0;
  const subtotal = bmr + neat + workoutsKcal + cardioKcal + stepsKcal + jobKcal + muscleAdj;
  const tdee = subtotal * 1.10;
  return { bmr, neat, workoutsKcal, cardioKcal, stepsKcal, jobKcal, muscleAdj, subtotal, tdee };
}

// =====================================================
// DEFICIT CALCULATION (cutting)
// Rate comes from the SS1 code (fractional bw/week). The deficit ceiling is a
// MacroMetric-side calorie safety bound keyed by heightDiff.
// =====================================================

function calculateCuttingTarget({ maintenance, weight, height, rate }) {
  const heightDiff = height - weight;
  const cap = getCutDeficitCap(heightDiff);
  const rateBasedDeficit = (weight * rate * 7700) / 7;
  const dailyDeficit = Math.min(rateBasedDeficit, cap);
  let target = roundUpTo50(maintenance - dailyDeficit);

  // Minimum target floor (sanity + hormones)
  const floor = height > 175 ? 2000 : 1800;
  let floorApplied = false;
  if (target < floor) {
    target = floor;
    floorApplied = true;
  }

  const targetWeeklyLoss = weight * rate;

  return {
    target,
    weeklyRate: rate,
    cap,
    rateBasedDeficit,
    appliedDeficit: dailyDeficit,
    targetWeeklyLoss,
    floor,
    floorApplied,
  };
}

// =====================================================
// SURPLUS CALCULATION (bulking)
// Surplus % is a MacroMetric calorie knob (tier × sub-bracket). The target gain
// RATE comes from the SS1 code (fractional bw/month).
// =====================================================

function calculateBulkingTarget({ maintenance, weight, tier, subBracket, rate }) {
  const basePct = BULK_SURPLUS_PCT[tier] ?? 0.08;
  const pct = basePct * (BULK_SURPLUS_SUBBRACKET_MULT[subBracket] ?? 1);
  const rawSurplus = maintenance * pct;
  const surplus = Math.min(rawSurplus, BULK_SURPLUS_CAP);
  const target = roundUpTo50(maintenance + surplus);

  // Target gain rate comes straight from the shipped rate (fractional bw/month).
  const targetMonthlyGain = weight * rate;

  return {
    target,
    surplusPct: pct,
    appliedSurplus: surplus,
    targetMonthlyGain,
    gainRatePct: rate * 100,
  };
}

// =====================================================
// PROTEIN CALCULATION — height × tier coeff (+ sub-bracket nudge)
// =====================================================

function calculateProtein(height, tier, subBracket, direction) {
  const base = (PROTEIN_COEFF[direction] && PROTEIN_COEFF[direction][tier]) ?? 0.85;
  const coeff = base + (PROTEIN_SUBBRACKET_NUDGE[subBracket] ?? 0);
  return roundToNearest5(height * coeff);
}

// =====================================================
// FAT & CARBS
// =====================================================

function calculateFat(calories, direction) {
  const pct = FAT_PCT[direction] ?? 0.30;
  return roundToNearest5((calories * pct) / 9);
}

function calculateCarbs(calories, proteinG, fatG) {
  const remainingKcal = calories - (proteinG * 4) - (fatG * 9);
  let carbs = roundToNearest5(remainingKcal / 4);
  if (carbs < 100) carbs = 100;
  return carbs;
}

function calculateFiber(calories) {
  return roundToNearest5((calories / 1000) * FIBER_PER_1000KCAL);
}

// =====================================================
// FULL PRESCRIPTION
// data = decoded code (tier, subBracket, direction, height, weight, archetypeId,
//        goalLow, goalHigh, destWeight, rate) + collected (age, workouts, cardio,
//        steps, job)
// =====================================================

function buildPrescription(data) {
  const maint = calculateMaintenance({ ...data });
  const { direction, tier, subBracket, rate, destWeight } = data;

  let calorieResult;
  if (direction === 'cut') {
    calorieResult = calculateCuttingTarget({
      maintenance: maint.tdee,
      weight: data.weight,
      height: data.height,
      rate,
    });
  } else {
    calorieResult = calculateBulkingTarget({
      maintenance: maint.tdee,
      weight: data.weight,
      tier,
      subBracket,
      rate,
    });
  }

  const protein = calculateProtein(data.height, tier, subBracket, direction);
  const fat = calculateFat(calorieResult.target, direction);
  const carbs = calculateCarbs(calorieResult.target, protein, fat);
  const fiber = calculateFiber(calorieResult.target);

  const durationWeeks = planDurationWeeks({
    direction,
    weight: data.weight,
    destWeight,
    rate,
  });

  return {
    maintenance: Math.round(maint.tdee),
    target: calorieResult.target,
    protein,
    fat,
    carbs,
    fiber,
    direction,
    tier,
    subBracket,
    archetypeId: data.archetypeId,
    weight: data.weight,
    height: data.height,
    goalLow: data.goalLow,
    goalHigh: data.goalHigh,
    destWeight,
    rate,
    durationWeeks,
    weeklyRate: calorieResult.weeklyRate,
    targetWeeklyLoss: calorieResult.targetWeeklyLoss,
    targetMonthlyGain: calorieResult.targetMonthlyGain,
    surplusPct: calorieResult.surplusPct,
    floorApplied: calorieResult.floorApplied,
  };
}

// =====================================================
// CHECK-IN → MM1 CODE
// A check-in produces a COMPLETE MM1 code only when started from an MM1 code (so
// tier/subBracket/height/maintenance/rate are known). The rate passes through
// unchanged (the check-in adjusts the TARGET, not the recommended pace).
// Returns null for a manual-entry check-in — we can't fabricate the carried fields.
// =====================================================

function buildCheckInCode(result, direction, ingestedPlan, units) {
  if (!ingestedPlan) return null;
  const target = result.newTarget;
  const protein = result.newProtein;
  const fat = calculateFat(target, direction);
  const carbs = calculateCarbs(target, protein, fat);
  const fiber = calculateFiber(target);
  const plan = {
    direction,
    target,
    protein,
    fat,
    carbs,
    fiber,
    tier: ingestedPlan.tier,
    subBracket: ingestedPlan.subBracket,
    weight: result.currentWeight ?? ingestedPlan.weight, // latest measured weight
    height: ingestedPlan.height,
    maintenance: ingestedPlan.maintenance,
    rate: ingestedPlan.rate, // carried forward unchanged
  };
  return buildMacroMetricCode(plan, units);
}

// =====================================================
// FORMAT HELPERS
// =====================================================

const formatWeight = (kg, units) => {
  if (units === 'imperial') return `${(kgToLb(kg)).toFixed(1)} lb`;
  return `${kg.toFixed(1)} kg`;
};

const formatWeightRange = (kgLow, kgHigh, units) => {
  if (units === 'imperial') return `${Math.round(kgToLb(kgLow))}-${Math.round(kgToLb(kgHigh))} lb`;
  return `${Math.round(kgLow)}-${Math.round(kgHigh)} kg`;
};

// =====================================================
// SHARED COMPONENTS — mirroring PhysiquePlan
// =====================================================

const Container = ({ children }) => (
  <div className="min-h-screen bg-stone-50 flex flex-col" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
    <Header />
    <main className="flex-1 flex items-center justify-center px-4 py-8">
      {children}
    </main>
    <Footer />
  </div>
);

const LOGO_URL = '/logo.png';

const Logo = ({ size = 32 }) => {
  if (LOGO_URL) {
    return (
      <img
        src={LOGO_URL}
        alt="ShredSmart logo"
        width={size}
        height={size}
        className="rounded-lg"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="rounded-lg bg-stone-200 border border-stone-300 flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <span className="text-stone-400 text-[10px] font-medium">LOGO</span>
    </div>
  );
};

const Header = () => (
  <header className="w-full px-6 py-4 flex items-center justify-between border-b border-stone-200 bg-white">
    <div className="flex items-center gap-2.5">
      <Logo size={32} />
      <span className="font-semibold text-stone-900 tracking-tight">ShredSmart™</span>
    </div>
    <span className="text-xs text-stone-500 tracking-wider">MacroMetric™</span>
  </header>
);

const Footer = () => (
  <footer className="w-full px-6 py-4 border-t border-stone-200 bg-white text-xs text-stone-500 flex justify-between">
    <span>ShredSmart™</span>
    <span>by Radu Antoniu</span>
  </footer>
);

const Card = ({ children, className = '' }) => (
  <div className={`bg-white border border-stone-200 rounded-2xl shadow-sm p-8 max-w-xl w-full ${className}`}>
    {children}
  </div>
);

const PrimaryButton = ({ onClick, children, disabled = false, className = '' }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`w-full ${disabled ? 'bg-stone-300 cursor-not-allowed text-stone-500' : 'bg-stone-900 hover:bg-stone-800 text-white'} font-medium py-3.5 px-6 rounded-full transition-colors flex items-center justify-center gap-2 ${className}`}
  >
    {children}
  </button>
);

const SecondaryButton = ({ onClick, children, className = '' }) => (
  <button
    onClick={onClick}
    className={`w-full bg-stone-100 hover:bg-stone-200 text-stone-900 font-medium py-3.5 px-6 rounded-full transition-colors flex items-center justify-center gap-2 ${className}`}
  >
    {children}
  </button>
);

const BackButton = ({ onClick }) => (
  <button
    onClick={onClick}
    className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900 transition-colors mb-4"
  >
    <ArrowLeft className="w-4 h-4" /> Back
  </button>
);

const StepIndicator = ({ current, total }) => (
  <div className="flex items-center gap-2 mb-8">
    {Array.from({ length: total }).map((_, i) => (
      <div
        key={i}
        className={`h-1.5 flex-1 rounded-full transition-colors ${
          i < current ? 'bg-orange-500' : 'bg-stone-200'
        }`}
      />
    ))}
  </div>
);

// =====================================================
// PLAN SETUP SCREENS
// =====================================================

const LandingScreen = ({ onStart, onCheckIn }) => (
  <Card className="max-w-3xl">
    <div className="grid md:grid-cols-2 gap-10 items-center">
      <div>
        <span className="text-xs font-semibold text-orange-600 tracking-widest">MacroMetric™</span>
        <h1 className="mt-3 text-4xl md:text-5xl font-bold text-stone-900 tracking-tight leading-tight">
          Get your <em className="italic font-semibold text-orange-600">nutrition targets</em>.
        </h1>
        <p className="mt-4 text-stone-600 leading-relaxed">
          The exact calories and macros to eat each day across your ShredSmart plan. Built around your strength profile, scaled to your body, designed to actually work.
        </p>
      </div>
      <div className="bg-stone-50 border border-stone-200 rounded-xl p-6">
        <h2 className="font-semibold text-stone-900">What you'll get</h2>
        <ul className="mt-3 space-y-2.5 text-sm text-stone-700">
          <li className="flex gap-2">
            <Check className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
            <span>Your target rate of fat loss or weight gain</span>
          </li>
          <li className="flex gap-2">
            <Check className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
            <span>Exact calories and macros to eat daily</span>
          </li>
          <li className="flex gap-2">
            <Check className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
            <span>The pitfalls to avoid that derail most lifters</span>
          </li>
          <li className="flex gap-2">
            <Check className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
            <span>Confidence in your numbers — no more guessing</span>
          </li>
        </ul>
        <div className="mt-5">
          <PrimaryButton onClick={onStart}>
            Set up my plan <ArrowRight className="w-4 h-4" />
          </PrimaryButton>
        </div>
        <button
          onClick={onCheckIn}
          className="mt-2 w-full bg-stone-50 hover:bg-stone-100 text-stone-900 font-medium py-3.5 px-6 rounded-full transition-colors text-sm border border-stone-200"
        >
          I'm in the middle of a plan
        </button>
        <p className="text-xs text-stone-500 text-center mt-3">Takes about 3 minutes.</p>
      </div>
    </div>
  </Card>
);

// --- CODE INGESTION (replaces units + physique-check + archetype + direction) ---

const CODE_ERROR_COPY = {
  version: "This code is from a newer version of PhysiquePlan™. Re-run PhysiquePlan to get a compatible code.",
  checksum: "That code doesn't look right — a character may be off. Copy it again from your PhysiquePlan™ blueprint, or use the “Continue to MacroMetric™” button there to skip typing.",
  corrupt: "That code couldn't be read. Copy it again from your PhysiquePlan™ blueprint, or use the “Continue to MacroMetric™” button there.",
  format: "That doesn't look like a ShredSmart code. It should start with “SS1-”. Copy it again from your PhysiquePlan™ blueprint.",
  fields: "That code is incomplete or from an older version of PhysiquePlan™. Re-run PhysiquePlan to get a current code.",
  empty: "Paste your code to continue.",
};

// Error copy for the MM1 code the CHECK-IN flow ingests.
const MM_CODE_ERROR_COPY = {
  version: "This code is from a newer version of MacroMetric™. Re-run your MacroMetric plan to get a compatible code.",
  wrongcode: "That looks like a PhysiquePlan™ code (SS1), not a MacroMetric™ code. Paste the MacroMetric code from the end of your plan or your last check-in.",
  checksum: "That code doesn't look right — a character may be off. Copy it again from MacroMetric™ (end of your plan, or your last check-in result).",
  corrupt: "That code couldn't be read. Copy it again from MacroMetric™.",
  format: "That doesn't look like a MacroMetric™ code. It should start with “MM1-”.",
  fields: "That code is incomplete or from an older version of MacroMetric™. Re-run your MacroMetric plan to get a current code.",
  empty: "Paste your MacroMetric™ code to continue.",
};

const PLAN_URL = 'https://plan.raduantoniu.com';

const CodeScreen = ({ initialCode = '', initialError = null, onDecoded, onBack }) => {
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState(initialError);

  const submit = () => {
    const res = decodeShredSmartCode(code);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onDecoded(res.data, code);
  };

  return (
    <Card>
      <BackButton onClick={onBack} />
      <div>
        <span className="text-xs font-semibold text-stone-400 tracking-widest uppercase">Bring your plan over</span>
        <h2 className="mt-2 text-2xl font-bold text-stone-900">Paste your PhysiquePlan™ code</h2>
        <p className="text-stone-600 mt-2 text-sm">
          PhysiquePlan generated a code at the bottom of your blueprint. Paste it here and MacroMetric pre-fills everything — your stats, your strength tier, your direction. No re-entering anything.
        </p>

        <div className="mt-5">
          <label className="text-sm font-medium text-stone-700">Your code</label>
          <input
            type="text"
            value={code}
            onChange={(e) => { setCode(e.target.value); if (error) setError(null); }}
            placeholder="SS1-…"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
          />
          {error && (
            <p className="text-sm text-red-600 mt-2 leading-relaxed">{CODE_ERROR_COPY[error] || CODE_ERROR_COPY.format}</p>
          )}
        </div>

        <PrimaryButton onClick={submit} disabled={!code.trim()} className="mt-5">
          Load my plan <ArrowRight className="w-4 h-4" />
        </PrimaryButton>

        <a
          href={PLAN_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 w-full bg-stone-100 hover:bg-stone-200 text-stone-900 font-medium py-3.5 px-6 rounded-full transition-colors text-center flex items-center justify-center gap-2 text-sm"
        >
          I don't have a code — do PhysiquePlan™ first <ExternalLink className="w-4 h-4" />
        </a>
      </div>
    </Card>
  );
};

const StalenessNotice = ({ weeks, onRerun }) => (
  <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3">
    <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
    <div className="text-sm text-stone-700">
      <span className="font-medium text-stone-900">These numbers are a few months old.</span> Your plan was generated about {Math.round(weeks / 4)} months ago — your body has likely moved on. You can proceed, but a fresh PhysiquePlan read will be more accurate.
      <button onClick={onRerun} className="mt-2 text-amber-700 font-medium underline underline-offset-2 hover:text-amber-800">
        Re-run PhysiquePlan™
      </button>
    </div>
  </div>
);

// Confirmation + intro, shown once a code is loaded.
const IntroScreen = ({ decoded, units, onContinue, onBack, onRerun }) => {
  const tierLabel = subBracketTierLabel(decoded.tier, decoded.subBracket);
  const dirLabel = decoded.direction === 'cut' ? 'Cut (lose fat)' : 'Lean bulk (build muscle)';
  const weeks = genDateAgeWeeks(decoded.genDate);
  const stale = weeks !== null && weeks > 12;
  const planWeeks = Math.max(1, Math.round(planDurationWeeks({
    direction: decoded.direction,
    weight: decoded.weight,
    destWeight: decoded.destWeight,
    rate: decoded.rate,
  })));

  return (
    <Card>
      <BackButton onClick={onBack} />
      <div className="text-center">
        <span className="text-xs font-semibold text-orange-600 tracking-widest uppercase">Plan loaded</span>
        <h2 className="mt-2 text-3xl font-bold text-stone-900">Got it — let's set your targets.</h2>
        <p className="text-stone-600 mt-3 leading-relaxed text-sm">
          This takes about 3 minutes. We just need your age and activity — everything else came over in your code.
        </p>
      </div>

      <div className="mt-5 bg-stone-50 border border-stone-200 rounded-xl p-5 text-left">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-stone-500 uppercase tracking-wider">Strength tier</div>
            <div className="font-semibold text-stone-900 mt-0.5">{tierLabel}</div>
          </div>
          <div>
            <div className="text-xs text-stone-500 uppercase tracking-wider">Direction</div>
            <div className="font-semibold text-stone-900 mt-0.5">{dirLabel}</div>
          </div>
          <div>
            <div className="text-xs text-stone-500 uppercase tracking-wider">Current weight</div>
            <div className="font-semibold text-stone-900 mt-0.5">{formatWeight(decoded.weight, units)}</div>
          </div>
          <div>
            <div className="text-xs text-stone-500 uppercase tracking-wider">Plan target</div>
            <div className="font-semibold text-stone-900 mt-0.5">{formatWeight(decoded.destWeight, units)} <span className="font-normal text-stone-500">in ~{planWeeks} wks</span></div>
          </div>
        </div>
      </div>

      {stale && <StalenessNotice weeks={weeks} onRerun={onRerun} />}

      <PrimaryButton onClick={onContinue} className="mt-6">
        Let's go <ArrowRight className="w-4 h-4" />
      </PrimaryButton>
    </Card>
  );
};

const PrincipleScreen = ({ onContinue, onBack }) => (
  <Card>
    <BackButton onClick={onBack} />
    <h2 className="text-2xl font-bold text-stone-900">Before we calculate — read this.</h2>
    <p className="text-stone-600 mt-2 text-sm">Most macro calculators give you four numbers and demand you hit all four perfectly. That's unrealistic and unnecessary.</p>

    <div className="mt-6 space-y-4">
      <div className="bg-orange-50 border border-orange-200 rounded-xl p-5">
        <span className="text-xs font-semibold text-orange-700 uppercase tracking-wider">What actually matters</span>
        <p className="text-stone-900 font-medium mt-1">Hit your calories and protein.</p>
        <p className="text-stone-700 text-sm mt-2">
          These two numbers drive your results. As long as you're consistent on both, your body will respond.
        </p>
      </div>

      <div className="bg-stone-50 border border-stone-200 rounded-xl p-5">
        <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider">What's a floor, not a target</span>
        <p className="text-stone-900 font-medium mt-1">Fat and carbs are minimums.</p>
        <p className="text-stone-600 text-sm mt-2">
          You'll get prescribed numbers, but think of them as floors. Some days fat will be 40% of calories, some days 25%. Fine. Just don't consistently drop below <strong>~60g of fat</strong> (for hormones and satiety) or below <strong>~100g of carbs cutting / 200g bulking</strong> (for sleep and training).
        </p>
      </div>
    </div>

    <p className="text-stone-600 text-sm mt-4">
      Hit calories and protein. Stay above the fat and carb floors. That's the system.
    </p>

    <PrimaryButton onClick={onContinue} className="mt-6">
      Got it — let's set my targets <ArrowRight className="w-4 h-4" />
    </PrimaryButton>
  </Card>
);

// Age + activity in one screen (height/weight came from the code).
const DetailsScreen = ({ onContinue, currentStep, totalSteps, onBack }) => {
  const [age, setAge] = useState('');
  const [workouts, setWorkouts] = useState('');
  const [cardio, setCardio] = useState('');
  const [steps, setSteps] = useState('');
  const [job, setJob] = useState('');

  const ageValue = parseInt(age);
  const isValid =
    ageValue >= 16 && ageValue <= 90 &&
    workouts !== '' && parseInt(workouts) >= 0 && parseInt(workouts) <= 14 &&
    cardio !== '' && parseInt(cardio) >= 0 && parseInt(cardio) <= 2000 &&
    steps !== '' && parseInt(steps) >= 0 && parseInt(steps) <= 50000 &&
    job !== '';

  return (
    <Card>
      <BackButton onClick={onBack} />
      <StepIndicator current={currentStep} total={totalSteps} />
      <span className="text-xs font-semibold text-stone-400 tracking-widest uppercase">STEP {currentStep} OF {totalSteps}</span>
      <h2 className="mt-2 text-2xl font-bold text-stone-900">A few details for your maintenance</h2>
      <p className="text-stone-600 mt-2 text-sm">Concrete numbers, not vibes. This lets us calculate your real expenditure instead of guessing.</p>

      <div className="space-y-4 mt-5">
        <div>
          <label className="text-sm font-medium text-stone-700">Age (years)</label>
          <input
            type="number"
            value={age}
            onChange={(e) => setAge(e.target.value)}
            placeholder="e.g. 30"
            className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-stone-700">Workouts per week</label>
          <input
            type="number"
            value={workouts}
            onChange={(e) => setWorkouts(e.target.value)}
            placeholder="e.g. 4"
            className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
          />
          <p className="text-xs text-stone-500 mt-1">Resistance training sessions (lifts, calisthenics, etc.)</p>
        </div>
        <div>
          <label className="text-sm font-medium text-stone-700">Average steps per day</label>
          <input
            type="number"
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            placeholder="e.g. 8000"
            className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
          />
          <p className="text-xs text-stone-500 mt-1">From your phone or watch — your honest average. This already covers all your walking, running, and hiking.</p>
        </div>
        <div>
          <label className="text-sm font-medium text-stone-700">Cardio that doesn't add steps (minutes/week)</label>
          <input
            type="number"
            value={cardio}
            onChange={(e) => setCardio(e.target.value)}
            placeholder="e.g. 60"
            className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
          />
          <p className="text-xs text-stone-500 mt-1">
            <strong>Only</strong> activities that don't show up in your step count: cycling, swimming, rowing, elliptical, yoga.
            <br />
            <span className="text-stone-400">Don't include running, jogging, walking, or treadmill — those are already in your steps above. Enter 0 if none.</span>
          </p>
        </div>
        <div>
          <label className="text-sm font-medium text-stone-700">Job type</label>
          <div className="space-y-2 mt-2">
            {[
              { id: 'desk', label: 'Desk job', sub: 'Mostly seated, computer-based' },
              { id: 'feet', label: 'On your feet', sub: 'Teacher, retail, healthcare, hospitality' },
              { id: 'physical', label: 'Highly physical', sub: 'Construction, warehouse, manual labor' },
            ].map(opt => (
              <button
                key={opt.id}
                onClick={() => setJob(opt.id)}
                className={`w-full text-left p-3 rounded-lg border transition-colors ${
                  job === opt.id ? 'border-orange-500 bg-orange-50' : 'border-stone-200 hover:border-orange-500 hover:bg-orange-50'
                }`}
              >
                <div className="font-medium text-stone-900 text-sm">{opt.label}</div>
                <div className="text-xs text-stone-500">{opt.sub}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <PrimaryButton
        onClick={() => isValid && onContinue({
          age: ageValue,
          workouts: parseInt(workouts),
          cardio: parseInt(cardio),
          steps: parseInt(steps),
          job,
        })}
        disabled={!isValid}
        className="mt-6"
      >
        Calculate my targets <ArrowRight className="w-4 h-4" />
      </PrimaryButton>
    </Card>
  );
};

const LoadingScreen = ({ message = 'Calculating your targets...' }) => (
  <Card>
    <div className="text-center py-8">
      <Loader2 className="w-10 h-10 mx-auto text-orange-500 animate-spin" />
      <p className="mt-4 font-medium text-stone-900">{message}</p>
      <p className="text-sm text-stone-500 mt-1">Running the formula, scaling to your strength profile...</p>
    </div>
  </Card>
);

// =====================================================
// RESULTS SCREEN
// =====================================================

const QAItem = ({ question, children }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-stone-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-stone-50 transition-colors"
      >
        <span className="font-medium text-stone-900 text-sm pr-3">{question}</span>
        {open ? <ChevronUp className="w-4 h-4 text-stone-500 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-stone-500 flex-shrink-0" />}
      </button>
      {open && (
        <div className="px-5 pb-4 text-sm text-stone-700 leading-relaxed border-t border-stone-200 pt-3">
          {children}
        </div>
      )}
    </div>
  );
};

const ResultsScreen = ({ result, units, onRestart, onBack }) => {
  const direction = result.direction;
  const isCut = direction === 'cut';
  const tierLabel = subBracketTierLabel(result.tier, result.subBracket);
  const { weeks: planWeeks, label: durationLabel } = formatDuration(result.durationWeeks);
  const mealFrameCode = buildMacroMetricCode(result, units);
  const [copied, setCopied] = useState(false);

  const goToMealFrame = () => {
    window.open(`${MEALFRAME_URL}?code=${encodeURIComponent(mealFrameCode)}`, '_blank');
  };
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(mealFrameCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be unavailable; code is still visible to copy manually
    }
  };
  const archetypeName = ARCHETYPE_NAMES[result.archetypeId] || '';

  // Calorie split for display
  const proteinKcal = result.protein * 4;
  const fatKcal = result.fat * 9;
  const carbsKcal = result.carbs * 4;
  const totalKcal = proteinKcal + fatKcal + carbsKcal;
  const proteinPct = Math.round((proteinKcal / totalKcal) * 100);
  const fatPct = Math.round((fatKcal / totalKcal) * 100);
  const carbsPct = 100 - proteinPct - fatPct;

  return (
    <Card className="max-w-2xl">
      <BackButton onClick={onBack} />
      <div>
        <span className="text-xs font-semibold text-orange-600 tracking-widest uppercase">Your Nutrition Targets</span>
        <h2 className="mt-2 text-3xl font-bold text-stone-900">
          {isCut ? 'Your cutting plan' : 'Your lean bulk plan'}
        </h2>
        <p className="text-stone-600 mt-2 text-sm">
          For a <strong>{tierLabel}</strong> lifter · {isCut ? 'cutting' : 'lean bulking'}
          {archetypeName ? <span className="text-stone-400"> · {archetypeName}</span> : null}
        </p>

        {/* The headline number */}
        <div className="mt-6 bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-200 rounded-xl p-6">
          <div className="text-xs font-semibold text-orange-700 uppercase tracking-wider">Daily calorie target</div>
          <div className="text-5xl font-bold text-stone-900 mt-1">{result.target}</div>
          <div className="text-sm text-stone-600 mt-1">kcal per day</div>

          <div className="mt-4 pt-4 border-t border-orange-200 grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-stone-500 uppercase tracking-wider">Maintenance</div>
              <div className="font-semibold text-stone-900">{roundUpTo50(result.maintenance)} kcal</div>
            </div>
            <div>
              <div className="text-xs text-stone-500 uppercase tracking-wider">{isCut ? 'Daily deficit' : 'Daily surplus'}</div>
              <div className="font-semibold text-stone-900">
                {isCut ? '−' : '+'}{roundUpTo50(Math.abs(result.maintenance - result.target))} kcal
              </div>
            </div>
          </div>
        </div>

        {/* Macros */}
        <div className="mt-5">
          <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-3">Daily macros</h3>
          <div className="space-y-2">
            <div className="bg-white border border-stone-200 rounded-xl p-4 flex items-center justify-between">
              <div>
                <div className="font-semibold text-stone-900">Protein</div>
                <div className="text-xs text-stone-500">Hit this every day</div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-stone-900">{result.protein}g</div>
                <div className="text-xs text-stone-500">{proteinPct}% of calories</div>
              </div>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-4 flex items-center justify-between">
              <div>
                <div className="font-semibold text-stone-900">Fat</div>
                <div className="text-xs text-stone-500">Stay above ~60g daily</div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-stone-900">{result.fat}g</div>
                <div className="text-xs text-stone-500">{fatPct}% of calories</div>
              </div>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-4 flex items-center justify-between">
              <div>
                <div className="font-semibold text-stone-900">Carbs</div>
                <div className="text-xs text-stone-500">
                  Stay above ~{isCut ? '100g' : '200g'} daily
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-stone-900">{result.carbs}g</div>
                <div className="text-xs text-stone-500">{carbsPct}% of calories</div>
              </div>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-4 flex items-center justify-between">
              <div>
                <div className="font-semibold text-stone-900">Fiber</div>
                <div className="text-xs text-stone-500">Minimum — aim for at least this</div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-stone-900">{result.fiber}g</div>
                <div className="text-xs text-stone-500">14g per 1,000 kcal</div>
              </div>
            </div>
          </div>
        </div>

        {/* Target rate of weight change */}
        <div className="mt-5 bg-stone-50 border border-stone-200 rounded-xl p-5">
          <div className="text-xs font-semibold text-stone-500 uppercase tracking-wider">Your target rate</div>
          {isCut ? (
            <>
              <div className="text-lg font-bold text-stone-900 mt-1">
                {formatWeight(result.targetWeeklyLoss, units)} per week
              </div>
              <p className="text-sm text-stone-600 mt-2">
                That's {(result.weeklyRate * 100).toFixed(1)}% of your bodyweight weekly. Write this number down — you'll need it for your weekly check-ins.
              </p>
            </>
          ) : (
            <>
              <div className="text-lg font-bold text-stone-900 mt-1">
                +{formatWeight(result.targetMonthlyGain, units)} per month
              </div>
              <p className="text-sm text-stone-600 mt-2">
                Slow lean bulks build muscle while staying lean. Write this number down — you'll need it for your monthly check-ins.
              </p>
            </>
          )}
        </div>

        {/* Plan target leads; ultimate goal stays as the north star */}
        <div className="mt-4 bg-stone-50 border border-stone-200 rounded-xl p-5">
          <div className="text-xs font-semibold text-stone-500 uppercase tracking-wider">Your plan target weight</div>
          <div className="text-2xl font-bold text-stone-900 mt-1">{formatWeight(result.destWeight, units)} <span className="text-base font-normal text-stone-500">in ~{planWeeks} weeks</span></div>
          <p className="text-sm text-stone-600 mt-2">
            This is where this plan takes you — your job for the next {durationLabel}. You're ultimately heading for your next physique milestone which is to be lean at a body weight of <strong>{formatWeightRange(result.goalLow, result.goalHigh, units)}</strong> (your north star from PhysiquePlan™), but for now, aim here.
          </p>
        </div>

        {/* Reminder of the principle */}
        <div className="mt-4 bg-orange-50 border border-orange-200 rounded-xl p-5">
          <h3 className="font-semibold text-stone-900 text-sm">Remember the system:</h3>
          <p className="text-sm text-stone-700 mt-2 leading-relaxed">
            Hit your calories and protein every day. Fat and carbs can fluctuate — just keep them above the floors. That's it.
          </p>
        </div>

        {/* Q&A */}
        <div className="mt-6">
          <h3 className="font-semibold text-stone-900 mb-3">Common questions</h3>
          <div className="space-y-2">
            <QAItem question="What's more important — hitting protein or calories?">
              <p>Protein is more important because it helps prevent muscle loss. Rebuilding lost muscle takes more time than you save by holding the deficit.</p>
              <p className="mt-2"><strong>If your protein is below 90% of target:</strong> eat more protein even if it reduces your deficit for the day.</p>
              <p className="mt-2"><strong>If protein is above 90% of target:</strong> hold the full deficit. Lower protein days once in a while aren't a big deal.</p>
            </QAItem>
            <QAItem question="Can I have higher-calorie and lower-calorie days?">
              <p>It's better to keep your daily calorie intake constant — even on training days vs rest days. The benefit of getting used to a steady diet structure (better hunger signals, ingrained habits, predictability) outweighs any small benefits of cycling.</p>
              <p className="mt-2">Eat the same every day. It's easier and it works better.</p>
            </QAItem>
            {isCut ? (
              <QAItem question="What if I want to cut faster?">
                <p>Don't. Deficits larger than what you're prescribed lead to muscle loss, can't be maintained long-term, and don't help you build the habits that keep you lean afterward.</p>
                <p className="mt-2">The time you save with an aggressive cut gets repaid with interest later — through rebuilding muscle, binges, or yo-yo dieting. Stick to the program.</p>
              </QAItem>
            ) : (
              <QAItem question="What if I want to bulk faster?">
                <p>Don't. A bigger surplus doesn't build muscle faster — muscle growth has a speed limit set by your training and recovery, not by how much you eat. Past that limit, every extra calorie just becomes fat.</p>
                <p className="mt-2">That fat is fat you'll have to cut off later, which costs you time and muscle. A slow, lean bulk gets you to the goal physique faster than a fast, sloppy one. Stick to the program.</p>
              </QAItem>
            )}
            <QAItem question="Why isn't my protein higher?">
              <p>MacroMetric sets protein based on your actual muscle development and lean mass — your true needs. Most calculators set protein based on bodyweight, which severely overestimates the requirements of anyone carrying a moderate amount of body fat.</p>
              <p className="mt-2">ShredSmart sets protein squarely in the optimal range, but intentionally on the medium-to-lower end. Going higher would mean less fat and carbs, which hurts hormonal balance, sleep, training, and meal variety.</p>
              <p className="mt-2">You can go a bit above your prescribed number if your diet preferences favor it — but don't go significantly higher when cutting. Trust the number — it's set this way deliberately, and it's good for you.</p>
            </QAItem>
            <QAItem question="Should I eat back the calories I burn through exercise?">
              <p>Only if the activity isn't already captured in your maintenance calculation.</p>
              <p className="mt-2"><strong>Don't eat them back</strong> for your normal workouts and cardio. Those are already built into your maintenance number — you told MacroMetric about them when you set up your plan. Eating them back would double-count.</p>
              <p className="mt-2"><strong>Do eat them back</strong> for non-routine activity. If you go on a long hike and burn an extra 1000 kcal, eat those 1000 kcal more that day. Same goes for an extra workout, an extra cardio session, or a full day of physical work you don't normally do.</p>
            </QAItem>
            <QAItem question="If I overeat one day, should I eat less the next day to make up for it?">
              <p>No. Return to your normal target as if nothing happened.</p>
              <p className="mt-2">Cutting calories the day after an overeat seems logical but creates two problems. First, it makes the plan feel harder — you've turned one bad day into two punishing days. Second, and more importantly, once you allow yourself to "borrow from tomorrow," you'll overeat more often today. Research is clear on this: people who believe they can compensate later are dramatically more likely to indulge now.</p>
              <p className="mt-2">Let the mistake be a mistake. Feel the sting of it. Then return to the normal plan tomorrow. Maintaining a constant daily target is what builds the habits, satiety signals, and consistency that actually keep you lean long-term.</p>
            </QAItem>
            <QAItem question="What if I don't hit my macros to the gram?">
              <p>You don't need to. Hitting calories and protein within a few grams of target produces results indistinguishable from hitting each macro perfectly — as long as fat and carbs stay above their floors.</p>
              <p className="mt-2">Fat at 25% of calories one day and 40% the next is totally fine. Don't make this harder than it needs to be.</p>
            </QAItem>
            <QAItem question="Why is fiber on here, and how much do I need?">
              <p>Fiber isn't a macronutrient, but it's one of the most useful things you can prioritize on a cut — which is why it's on your numbers. Aim for at least <strong>14g per 1,000 calories</strong> you eat. Treat it as a floor, not a ceiling.</p>
              <p className="mt-2">High-fiber foods make a deficit far easier to live with. They require more chewing, which stretches out your meals and makes them feel bigger. Fiber also slows digestion and nutrient absorption, which delays hunger between meals — so you stay full longer on fewer calories.</p>
              <p className="mt-2">It also keeps you regular. Constipation is common on a high-protein diet with reduced calories, and adequate fiber prevents it. Build most of your meals around vegetables or other high-fiber foods — legumes, fruit, whole grains, mushrooms.</p>
            </QAItem>
            <QAItem question="Why do I need to update my numbers as I progress?">
              {isCut ? (
                <p>As you cut, your body adapts. Maintenance drops, NEAT decreases, and your body becomes more efficient at the lower weight. The initial calorie target won't stay accurate forever.</p>
              ) : (
                <p>As you gain weight, your maintenance rises — more bodyweight simply costs more calories to carry around. That means the surplus you started with slowly shrinks, and if you don't bump your intake your gains will stall. The initial calorie target won't stay accurate forever.</p>
              )}
              <p className="mt-2">{isCut ? 'Check in weekly with MacroMetric to keep your numbers calibrated.' : 'Check in monthly with MacroMetric to keep your numbers calibrated.'}</p>
            </QAItem>
          </div>
        </div>

        {/* CTAs */}
        <div className="border-t border-stone-200 my-6"></div>

        {/* MealFrame code — paste fallback, mirrors PhysiquePlan's handoff */}
        <div className="bg-stone-900 rounded-xl p-5 text-center">
          <h4 className="text-xs font-semibold text-orange-400 uppercase tracking-wider">Your MacroMetric™ Code - Save this!</h4>
          <p className="text-stone-400 text-xs mt-1">This code represents all your current data and we use it to build your meal plan in MealFrame™. You also use it to adjut your numbers during your check-ins here in MacroMetric™. Save it in your notes!</p>
          <div className="mt-3 bg-stone-800 border border-stone-700 rounded-lg px-3 py-3">
            <code className="text-orange-300 text-xs break-all leading-relaxed">{mealFrameCode}</code>
          </div>
          <button
            onClick={copyCode}
            className="mt-3 inline-flex items-center gap-2 bg-white text-stone-900 text-sm font-medium py-2 px-4 rounded-full hover:bg-stone-100 transition-colors"
          >
            <Copy className="w-4 h-4" /> {copied ? 'Copied!' : 'Copy code'}
          </button>
        </div>

        <div className="text-center mt-6">
          <h3 className="text-xl font-bold text-stone-900">What's next?</h3>
          <p className="text-stone-600 mt-2 text-sm leading-relaxed">
            Continue to <strong>MealFrame™</strong> to turn these numbers into a meal structure that fits your life.
          </p>
          <div className="space-y-2 mt-5">
            <PrimaryButton onClick={goToMealFrame}>
              Continue to MealFrame™ <ArrowRight className="w-4 h-4" />
            </PrimaryButton>
          </div>

          <button onClick={onRestart} className="text-xs text-stone-500 hover:text-stone-700 mt-4 underline underline-offset-2">
            Start over with a new code
          </button>
        </div>
      </div>
    </Card>
  );
};

// =====================================================
// CHECK-IN: paste your MM1 code (primary entry)
// =====================================================

const CheckInCodeScreen = ({ onDecoded, onManual, onBack }) => {
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);

  const submit = () => {
    const res = decodeMacroMetricCode(code);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onDecoded(res.data);
  };

  return (
    <Card>
      <BackButton onClick={onBack} />
      <div>
        <span className="text-xs font-semibold text-stone-400 tracking-widest uppercase">Check-in</span>
        <h2 className="mt-2 text-2xl font-bold text-stone-900">Paste your MacroMetric™ code</h2>
        <p className="text-stone-600 mt-2 text-sm">
          Use the code from the end of your plan — or from your last check-in. MacroMetric pre-fills your current numbers, so you only enter this period's measurements. If your targets change, you'll get a fresh code to take to MealFrame™.
        </p>

        <div className="mt-5">
          <label className="text-sm font-medium text-stone-700">Your MacroMetric™ code</label>
          <input
            type="text"
            value={code}
            onChange={(e) => { setCode(e.target.value); if (error) setError(null); }}
            placeholder="MM1-…"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
          />
          {error && (
            <p className="text-sm text-red-600 mt-2 leading-relaxed">{MM_CODE_ERROR_COPY[error] || MM_CODE_ERROR_COPY.format}</p>
          )}
        </div>

        <PrimaryButton onClick={submit} disabled={!code.trim()} className="mt-5">
          Load my numbers <ArrowRight className="w-4 h-4" />
        </PrimaryButton>

        <SecondaryButton onClick={onManual} className="mt-2 text-sm">
          I don't have my code — enter manually
        </SecondaryButton>
        <p className="text-xs text-stone-500 text-center mt-3">
          Manual check-ins still work — they just can't generate a MealFrame™ code.
        </p>
      </div>
    </Card>
  );
};

// =====================================================
// CHECK-IN: cut/bulk selection (manual fallback only — the code carries direction)
// =====================================================

const CheckInRouterScreen = ({ onSelect, onBack }) => (
  <Card>
    <BackButton onClick={onBack} />
    <div>
      <span className="text-xs font-semibold text-stone-400 tracking-widest uppercase">Check-in</span>
      <h2 className="mt-2 text-2xl font-bold text-stone-900">Are you cutting or bulking?</h2>
      <p className="text-stone-600 mt-2 text-sm">
        The check-in is different for each. Cutting is weekly because fat loss is fast and loud. Bulking is monthly because muscle gain is slow and quiet.
      </p>

      <div className="space-y-2 mt-6">
        <button
          onClick={() => onSelect('cut')}
          className="w-full text-left p-5 rounded-xl border border-stone-200 hover:border-orange-500 hover:bg-orange-50 transition-colors"
        >
          <div className="font-semibold text-stone-900">Cutting</div>
          <div className="text-xs text-stone-500 mt-0.5">Weekly check-in with two-week trend math</div>
        </button>
        <button
          onClick={() => onSelect('bulk')}
          className="w-full text-left p-5 rounded-xl border border-stone-200 hover:border-orange-500 hover:bg-orange-50 transition-colors"
        >
          <div className="font-semibold text-stone-900">Lean bulking</div>
          <div className="text-xs text-stone-500 mt-0.5">Monthly check-in based on weight + strength</div>
        </button>
      </div>
    </div>
  </Card>
);

// Units selector — only needed for the manual check-in fallback (no code there).
const UnitsScreen = ({ onSelect, onBack }) => (
  <Card>
    <BackButton onClick={onBack} />
    <div className="text-center">
      <span className="text-xs font-semibold text-stone-400 tracking-widest uppercase">First — your preferred units</span>
      <h2 className="mt-3 text-2xl font-bold text-stone-900">Metric or Imperial?</h2>
      <p className="text-stone-600 mt-2 text-sm">All your inputs and results will be shown in this format.</p>
      <div className="space-y-2 mt-6">
        <button
          onClick={() => onSelect('metric')}
          className="w-full text-left p-5 rounded-xl border border-stone-200 hover:border-orange-500 hover:bg-orange-50 transition-colors"
        >
          <div className="font-semibold text-stone-900">Metric</div>
          <div className="text-xs text-stone-500 mt-0.5">Centimeters, kilograms</div>
        </button>
        <button
          onClick={() => onSelect('imperial')}
          className="w-full text-left p-5 rounded-xl border border-stone-200 hover:border-orange-500 hover:bg-orange-50 transition-colors"
        >
          <div className="font-semibold text-stone-900">Imperial</div>
          <div className="text-xs text-stone-500 mt-0.5">Feet/inches, pounds</div>
        </button>
      </div>
    </div>
  </Card>
);

// =====================================================
// CUTTING CHECK-IN  (logic untouched — never read archetype)
// `prefill` (optional) seeds the fields we can recover from the ingested MM1
// code: current target, protein, height, and the target rate (read from the
// code's rate field). All editable.
// =====================================================

const CuttingCheckInScreen = ({ onSubmit, units, onBack, prefill = {} }) => {
  const [tracked, setTracked] = useState(null);
  const [currentTarget, setCurrentTarget] = useState(prefill.currentTarget || '');
  const [actualIntake, setActualIntake] = useState('');
  const [bwTwoWeeksAgo, setBwTwoWeeksAgo] = useState('');
  const [bwThisWeek, setBwThisWeek] = useState('');
  const [targetRate, setTargetRate] = useState(prefill.targetRate || '');
  const [height, setHeight] = useState(prefill.height || '');
  const [proteinTarget, setProteinTarget] = useState(prefill.proteinTarget || '');

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [waist2w, setWaist2w] = useState('');
  const [waistNow, setWaistNow] = useState('');
  const [strengthUp, setStrengthUp] = useState(null);

  const isPrefilled = !!prefill.currentTarget;

  const unitW = units === 'metric' ? 'kg' : 'lb';
  const unitH = units === 'metric' ? 'cm' : 'in';
  const unitWaist = units === 'metric' ? 'cm' : 'in';

  const isValid =
    tracked !== null &&
    currentTarget && parseInt(currentTarget) > 800 &&
    actualIntake && parseInt(actualIntake) > 500 &&
    bwTwoWeeksAgo && parseFloat(bwTwoWeeksAgo) > 30 &&
    bwThisWeek && parseFloat(bwThisWeek) > 30 &&
    targetRate && parseFloat(targetRate) > 0 &&
    height && parseFloat(height) > 100 &&
    proteinTarget && parseInt(proteinTarget) > 30;

  const handleSubmit = () => {
    if (!isValid) return;
    onSubmit({
      tracked,
      currentTarget: parseInt(currentTarget),
      actualIntake: parseInt(actualIntake),
      bwTwoWeeksAgo: units === 'metric' ? parseFloat(bwTwoWeeksAgo) : lbToKg(parseFloat(bwTwoWeeksAgo)),
      bwThisWeek: units === 'metric' ? parseFloat(bwThisWeek) : lbToKg(parseFloat(bwThisWeek)),
      targetRate: units === 'metric' ? parseFloat(targetRate) : lbToKg(parseFloat(targetRate)),
      height: units === 'metric' ? parseFloat(height) : parseFloat(height) * 2.54,
      proteinTarget: parseInt(proteinTarget),
      waist2w: waist2w ? (units === 'metric' ? parseFloat(waist2w) : parseFloat(waist2w) * 2.54) : null,
      waistNow: waistNow ? (units === 'metric' ? parseFloat(waistNow) : parseFloat(waistNow) * 2.54) : null,
      strengthUp,
    });
  };

  return (
    <Card>
      <BackButton onClick={onBack} />
      <div>
        <span className="text-xs font-semibold text-stone-400 tracking-widest uppercase">Weekly check-in</span>
        <h2 className="mt-2 text-2xl font-bold text-stone-900">Cutting check-in</h2>
        <p className="text-stone-600 mt-2 text-sm">
          Tell MacroMetric how your last two weeks went. We'll use the trend to decide if your numbers need adjusting.
        </p>

        {isPrefilled && (
          <p className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 mt-3">
            Pre-filled from your MacroMetric™ code — just add this period's numbers below (edit anything that's changed).
          </p>
        )}

        <div className="space-y-4 mt-5">
          <div>
            <label className="text-sm font-medium text-stone-700">Did you track your intake accurately last week?</label>
            <div className="grid grid-cols-2 gap-2 mt-2">
              {[{ v: true, l: 'Yes' }, { v: false, l: 'No' }].map((opt) => (
                <button
                  key={opt.l}
                  onClick={() => setTracked(opt.v)}
                  className={`p-3 rounded-lg border transition-colors ${
                    tracked === opt.v ? 'border-orange-500 bg-orange-50' : 'border-stone-200 hover:border-orange-500 hover:bg-orange-50'
                  }`}
                >
                  <span className="font-medium text-stone-900 text-sm">{opt.l}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Your current daily calorie target (kcal)</label>
            <input
              type="number"
              value={currentTarget}
              onChange={(e) => setCurrentTarget(e.target.value)}
              placeholder="e.g. 2400"
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Your current protein target (g)</label>
            <input
              type="number"
              value={proteinTarget}
              onChange={(e) => setProteinTarget(e.target.value)}
              placeholder="e.g. 165"
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Your average daily intake last week (kcal)</label>
            <input
              type="number"
              value={actualIntake}
              onChange={(e) => setActualIntake(e.target.value)}
              placeholder="e.g. 2380"
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Average bodyweight 2 weeks ago ({unitW})</label>
            <input
              type="number"
              step="0.1"
              value={bwTwoWeeksAgo}
              onChange={(e) => setBwTwoWeeksAgo(e.target.value)}
              placeholder={units === 'metric' ? 'e.g. 84.5' : 'e.g. 186.0'}
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Average bodyweight this week ({unitW})</label>
            <input
              type="number"
              step="0.1"
              value={bwThisWeek}
              onChange={(e) => setBwThisWeek(e.target.value)}
              placeholder={units === 'metric' ? 'e.g. 83.6' : 'e.g. 184.2'}
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Your target weekly weight loss ({unitW}/week)</label>
            <input
              type="number"
              step="0.1"
              value={targetRate}
              onChange={(e) => setTargetRate(e.target.value)}
              placeholder={units === 'metric' ? 'e.g. 0.5' : 'e.g. 1.1'}
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
            <p className="text-xs text-stone-500 mt-1">From your original MacroMetric plan</p>
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Your height ({unitH})</label>
            <input
              type="number"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              placeholder={units === 'metric' ? 'e.g. 180' : 'e.g. 71'}
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
          </div>

          {/* Advanced inputs */}
          <div className="border-t border-stone-200 pt-4">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between text-left"
            >
              <div>
                <div className="font-medium text-stone-900 text-sm">Help MacroMetric be more accurate</div>
                <div className="text-xs text-stone-500 mt-0.5">Unlock recomp detection — prevents being told to cut harder when you're already winning</div>
              </div>
              {showAdvanced ? <ChevronUp className="w-4 h-4 text-stone-500" /> : <ChevronDown className="w-4 h-4 text-stone-500" />}
            </button>

            {showAdvanced && (
              <div className="space-y-4 mt-4 pl-3 border-l-2 border-orange-200">
                <div>
                  <label className="text-sm font-medium text-stone-700">Waist 2 weeks ago ({unitWaist})</label>
                  <input
                    type="number"
                    step="0.1"
                    value={waist2w}
                    onChange={(e) => setWaist2w(e.target.value)}
                    placeholder={units === 'metric' ? 'e.g. 85.0' : 'e.g. 33.5'}
                    className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-stone-700">Waist this week ({unitWaist})</label>
                  <input
                    type="number"
                    step="0.1"
                    value={waistNow}
                    onChange={(e) => setWaistNow(e.target.value)}
                    placeholder={units === 'metric' ? 'e.g. 84.0' : 'e.g. 33.0'}
                    className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-stone-700">Is your strength going up?</label>
                  <p className="text-xs text-stone-500 mt-0.5">More reps or load on most lifts compared to 2 weeks ago</p>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    {[{ v: true, l: 'Yes' }, { v: false, l: 'No' }].map((opt) => (
                      <button
                        key={opt.l}
                        onClick={() => setStrengthUp(opt.v)}
                        className={`p-3 rounded-lg border transition-colors ${
                          strengthUp === opt.v ? 'border-orange-500 bg-orange-50' : 'border-stone-200 hover:border-orange-500 hover:bg-orange-50'
                        }`}
                      >
                        <span className="font-medium text-stone-900 text-sm">{opt.l}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <PrimaryButton onClick={handleSubmit} disabled={!isValid} className="mt-6">
          Run my check-in <ArrowRight className="w-4 h-4" />
        </PrimaryButton>
      </div>
    </Card>
  );
};

// =====================================================
// CUTTING CHECK-IN LOGIC  (unchanged)
// =====================================================

function processCuttingCheckIn(input, units = 'metric') {
  const wUnit = units === 'imperial' ? 'lb' : 'kg';
  const fmt = (kg) => units === 'imperial' ? kgToLb(kg).toFixed(2) : kg.toFixed(2);

  // Step 1: Accuracy gate
  if (input.tracked === false) {
    return {
      verdict: 'no_change',
      reason: 'accuracy',
      message: "We can't adjust without clean data. Track every meal this week with the same care you would when prepping for a photoshoot, then come back. The whole system depends on knowing what you actually ate.",
      newTarget: input.currentTarget,
      newProtein: input.proteinTarget,
    };
  }

  // Step 2: Calculate trend
  const weightChange = input.bwTwoWeeksAgo - input.bwThisWeek;
  const actualRate = weightChange / 2;
  const gap = input.targetRate - actualRate;

  // Step 3: Tolerance check
  const tolerance = 0.25 * input.targetRate;
  if (Math.abs(gap) <= tolerance) {
    return {
      verdict: 'no_change',
      reason: 'on_track',
      message: "You're on track. No change. Keep going.",
      detail: `You lost ${fmt(actualRate)} ${wUnit}/week vs your target of ${fmt(input.targetRate)} ${wUnit}/week. That's right in the zone.`,
      newTarget: input.currentTarget,
      newProtein: input.proteinTarget,
      actualRate,
      gap,
    };
  }

  // Step 4: Body recomp check (only if optional data provided AND losing slower)
  if (
    actualRate < input.targetRate &&
    input.waist2w !== null && input.waistNow !== null && input.strengthUp !== null
  ) {
    const waistChange = input.waist2w - input.waistNow;
    const weeklyWaistLoss = waistChange / 2;
    const recompThreshold = 0.75 * input.targetRate;

    if (weeklyWaistLoss >= recompThreshold && input.strengthUp === true) {
      return {
        verdict: 'no_change',
        reason: 'recomp',
        message: "Your scale isn't moving as fast as planned — but your waist is shrinking and your strength is rising. This is body recomposition: the best possible outcome of a cut.",
        detail: `You're losing fat and gaining muscle at the same time. The scale doesn't show it because muscle replaces some of the lost fat. Don't change a thing.`,
        newTarget: input.currentTarget,
        newProtein: input.proteinTarget,
        actualRate,
        gap,
      };
    }
  }

  // Step 5: Calculate adjustment
  const rawAdjustment = (gap * 7700) / 7;
  const halfAdjustment = rawAdjustment / 2;
  const cappedAdjustment = Math.min(Math.abs(halfAdjustment), 150) * Math.sign(halfAdjustment);

  let newTarget;
  let adjustmentDirection;
  if (actualRate < input.targetRate) {
    // losing too slow → eat less
    newTarget = input.currentTarget - cappedAdjustment;
    adjustmentDirection = 'down';
  } else {
    // losing too fast → eat more
    newTarget = input.currentTarget + Math.abs(cappedAdjustment);
    adjustmentDirection = 'up';
  }

  newTarget = roundUpTo50(newTarget);

  // Step 6: Apply floor
  const floor = input.height > 175 ? 2000 : 1800;
  let floorApplied = false;
  if (newTarget < floor) {
    newTarget = floor;
    floorApplied = true;
  }

  // Recalculate macros
  const newFat = roundToNearest5((newTarget * 0.35) / 9);
  const newCarbs = calculateCarbs(newTarget, input.proteinTarget, newFat);

  let message, detail;
  if (adjustmentDirection === 'down') {
    message = `You're losing slower than planned. Reducing your target by ${Math.abs(Math.round(cappedAdjustment))} kcal/day.`;
    detail = `You lost ${fmt(actualRate)} ${wUnit}/week vs your target of ${fmt(input.targetRate)} ${wUnit}/week. We're easing into the adjustment — half of what the math suggests, capped at 150 kcal. Don't expect overnight changes; cuts work over weeks, not days.`;
  } else {
    message = `You're losing faster than planned. Bumping your target up by ${Math.round(Math.abs(cappedAdjustment))} kcal/day.`;
    detail = `You lost ${fmt(actualRate)} ${wUnit}/week vs your target of ${fmt(input.targetRate)} ${wUnit}/week. Aggressive cuts cost muscle — let's slow it down.`;
  }

  if (floorApplied) {
    detail += ` Note: we hit the ${floor} kcal floor that protects sanity and hormones. Going below isn't worth it.`;
  }

  return {
    verdict: 'change',
    reason: adjustmentDirection,
    message,
    detail,
    newTarget,
    newProtein: input.proteinTarget,
    newFat,
    newCarbs,
    actualRate,
    gap,
    adjustmentAmount: Math.round(Math.abs(cappedAdjustment)),
  };
}

// =====================================================
// BULKING CHECK-IN  (logic untouched — never read archetype)
// `prefill` (optional) seeds current target, protein, and target monthly gain
// (read from the code's rate field). All editable.
// =====================================================

const BulkingCheckInScreen = ({ onSubmit, units, onBack, prefill = {} }) => {
  const [currentTarget, setCurrentTarget] = useState(prefill.currentTarget || '');
  const [proteinTarget, setProteinTarget] = useState(prefill.proteinTarget || '');
  const [bwLastMonth, setBwLastMonth] = useState('');
  const [bwThisMonth, setBwThisMonth] = useState('');
  const [targetMonthlyGain, setTargetMonthlyGain] = useState(prefill.targetMonthlyGain || '');
  const [strengthUp, setStrengthUp] = useState(null);

  const isPrefilled = !!prefill.currentTarget;

  const unitW = units === 'metric' ? 'kg' : 'lb';

  const isValid =
    currentTarget && parseInt(currentTarget) > 800 &&
    proteinTarget && parseInt(proteinTarget) > 30 &&
    bwLastMonth && parseFloat(bwLastMonth) > 30 &&
    bwThisMonth && parseFloat(bwThisMonth) > 30 &&
    targetMonthlyGain && parseFloat(targetMonthlyGain) > 0 &&
    strengthUp !== null;

  const handleSubmit = () => {
    if (!isValid) return;
    onSubmit({
      currentTarget: parseInt(currentTarget),
      proteinTarget: parseInt(proteinTarget),
      bwLastMonth: units === 'metric' ? parseFloat(bwLastMonth) : lbToKg(parseFloat(bwLastMonth)),
      bwThisMonth: units === 'metric' ? parseFloat(bwThisMonth) : lbToKg(parseFloat(bwThisMonth)),
      targetMonthlyGain: units === 'metric' ? parseFloat(targetMonthlyGain) : lbToKg(parseFloat(targetMonthlyGain)),
      strengthUp,
    });
  };

  return (
    <Card>
      <BackButton onClick={onBack} />
      <div>
        <span className="text-xs font-semibold text-stone-400 tracking-widest uppercase">Monthly check-in</span>
        <h2 className="mt-2 text-2xl font-bold text-stone-900">Bulking check-in</h2>
        <p className="text-stone-600 mt-2 text-sm">
          Bulking moves slowly. We check monthly because weekly bulking signals are too noisy to act on. We don't need precise calorie tracking — your weight and strength tell us what we need to know.
        </p>

        {isPrefilled && (
          <p className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 mt-3">
            Pre-filled from your MacroMetric™ code — just add this month's numbers below (edit anything that's changed).
          </p>
        )}

        <div className="space-y-4 mt-5">
          <div>
            <label className="text-sm font-medium text-stone-700">Your current daily calorie target (kcal)</label>
            <input
              type="number"
              value={currentTarget}
              onChange={(e) => setCurrentTarget(e.target.value)}
              placeholder="e.g. 3000"
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Your current protein target (g)</label>
            <input
              type="number"
              value={proteinTarget}
              onChange={(e) => setProteinTarget(e.target.value)}
              placeholder="e.g. 135"
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Average bodyweight last month ({unitW})</label>
            <input
              type="number"
              step="0.1"
              value={bwLastMonth}
              onChange={(e) => setBwLastMonth(e.target.value)}
              placeholder={units === 'metric' ? 'e.g. 75.0' : 'e.g. 165.3'}
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Average bodyweight this month ({unitW})</label>
            <input
              type="number"
              step="0.1"
              value={bwThisMonth}
              onChange={(e) => setBwThisMonth(e.target.value)}
              placeholder={units === 'metric' ? 'e.g. 75.8' : 'e.g. 167.1'}
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Your target monthly weight gain ({unitW}/month)</label>
            <input
              type="number"
              step="0.1"
              value={targetMonthlyGain}
              onChange={(e) => setTargetMonthlyGain(e.target.value)}
              placeholder={units === 'metric' ? 'e.g. 1.0' : 'e.g. 2.2'}
              className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
            />
            <p className="text-xs text-stone-500 mt-1">From your original MacroMetric plan</p>
          </div>

          <div>
            <label className="text-sm font-medium text-stone-700">Has your strength gone up clearly since last month?</label>
            <p className="text-xs text-stone-500 mt-0.5">More reps or load on most lifts</p>
            <div className="grid grid-cols-2 gap-2 mt-2">
              {[{ v: true, l: 'Yes' }, { v: false, l: 'No' }].map((opt) => (
                <button
                  key={opt.l}
                  onClick={() => setStrengthUp(opt.v)}
                  className={`p-3 rounded-lg border transition-colors ${
                    strengthUp === opt.v ? 'border-orange-500 bg-orange-50' : 'border-stone-200 hover:border-orange-500 hover:bg-orange-50'
                  }`}
                >
                  <span className="font-medium text-stone-900 text-sm">{opt.l}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <PrimaryButton onClick={handleSubmit} disabled={!isValid} className="mt-6">
          Run my check-in <ArrowRight className="w-4 h-4" />
        </PrimaryButton>
      </div>
    </Card>
  );
};

// =====================================================
// BULKING CHECK-IN LOGIC  (unchanged)
// =====================================================

function processBulkingCheckIn(input, units = 'metric') {
  const wUnit = units === 'imperial' ? 'lb' : 'kg';
  const fmt = (kg) => units === 'imperial' ? kgToLb(kg).toFixed(1) : kg.toFixed(1);

  const actualGain = input.bwThisMonth - input.bwLastMonth;
  const target = input.targetMonthlyGain;
  const tooFast = 1.5 * target;

  let verdict, reason, message, detail, newTarget = input.currentTarget;

  if (actualGain >= target && actualGain <= tooFast && input.strengthUp === true) {
    // CASE 1
    verdict = 'no_change';
    reason = 'on_track';
    message = "Keep going. You're growing exactly the way you should.";
    detail = `You gained ${fmt(actualGain)} ${wUnit} vs your target of ${fmt(target)} ${wUnit}, and your strength is rising. Don't touch anything.`;
  } else if (actualGain < target && input.strengthUp === false) {
    // CASE 2
    verdict = 'change';
    reason = 'up';
    message = "Time to eat more. Your body isn't getting enough fuel to grow.";
    detail = `You gained ${fmt(actualGain)} ${wUnit} vs your target of ${fmt(target)} ${wUnit}, and strength hasn't moved. Bumping calories up by 150/day.`;
    newTarget = roundUpTo50(input.currentTarget + 150);
  } else if (actualGain > tooFast) {
    // CASE 3
    verdict = 'change';
    reason = 'down';
    message = "You're outpacing the muscle-building rate your body can use. The extra calories are going to fat.";
    detail = `You gained ${fmt(actualGain)} ${wUnit} vs your target of ${fmt(target)} ${wUnit}. Cutting back by 150/day to keep the bulk lean.`;
    newTarget = roundUpTo50(input.currentTarget - 150);
  } else if (actualGain >= target && actualGain <= tooFast && input.strengthUp === false) {
    // CASE 4
    verdict = 'no_change';
    reason = 'strength_lag';
    message = "You're gaining as expected, but strength hasn't moved.";
    detail = `Sometimes strength lags weight. Wait another month before changing anything. Make sure you're pushing every working set close to failure.`;
  } else if (actualGain < target && input.strengthUp === true) {
    // CASE 5
    verdict = 'no_change';
    reason = 'weight_lag';
    message = "The scale isn't moving but your strength is. Your body is growing.";
    detail = `Sometimes weight lags strength early in a bulk, and some of the surplus is being absorbed by metabolic adaptation without showing on the scale. Hold the line. Re-check in a month.`;
  } else {
    // catchall
    verdict = 'no_change';
    reason = 'on_track';
    message = "No change needed.";
    detail = `You gained ${fmt(actualGain)} ${wUnit} vs your target of ${fmt(target)} ${wUnit}.`;
  }

  let newFat, newCarbs;
  if (verdict === 'change') {
    newFat = roundToNearest5((newTarget * 0.30) / 9);
    newCarbs = calculateCarbs(newTarget, input.proteinTarget, newFat);
  }

  return {
    verdict,
    reason,
    message,
    detail,
    newTarget,
    newProtein: input.proteinTarget,
    newFat,
    newCarbs,
    actualGain,
  };
}

// =====================================================
// CHECK-IN RESULT SCREEN
// =====================================================

const CheckInResultScreen = ({ result, direction, units, ingestedPlan, onRestart, onBack }) => {
  const isNoChange = result.verdict === 'no_change';
  const isCut = direction === 'cut';
  const [copied, setCopied] = useState(false);

  // Complete only when the check-in was started from a code. null for manual.
  const updatedCode = buildCheckInCode(result, direction, ingestedPlan, units);
  // Only worth refreshing MealFrame when the numbers actually changed.
  const showCode = updatedCode && !isNoChange;

  const goToMealFrame = () => {
    if (!updatedCode) return;
    window.open(`${MEALFRAME_URL}?code=${encodeURIComponent(updatedCode)}`, '_blank');
  };
  const copyCode = async () => {
    if (!updatedCode) return;
    try {
      await navigator.clipboard.writeText(updatedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be unavailable; code is still visible to copy manually
    }
  };

  const footerNote = isCut
    ? "Come back next week with another two weeks of data. Most weeks should produce 'no change' — that's the system working."
    : "Come back in a month. Patience is the dominant virtue of a clean lean bulk.";

  return (
    <Card className="max-w-2xl">
      <BackButton onClick={onBack} />
      <div>
        <span className="text-xs font-semibold text-orange-600 tracking-widest uppercase">Check-in result</span>

        {isNoChange ? (
          <>
            <h2 className="mt-2 text-3xl font-bold text-stone-900">
              {result.reason === 'on_track' && "You're on track."}
              {result.reason === 'recomp' && "You're recomping."}
              {result.reason === 'accuracy' && "Track better, come back."}
              {result.reason === 'strength_lag' && "Hold the line."}
              {result.reason === 'weight_lag' && "Hold the line."}
              {!['on_track', 'recomp', 'accuracy', 'strength_lag', 'weight_lag'].includes(result.reason) && "No change needed."}
            </h2>
            <p className="text-stone-700 mt-3 leading-relaxed">{result.message}</p>
            {result.detail && (
              <p className="text-stone-600 mt-3 text-sm leading-relaxed">{result.detail}</p>
            )}

            <div className="mt-6 bg-stone-50 border border-stone-200 rounded-xl p-5">
              <div className="text-xs font-semibold text-stone-500 uppercase tracking-wider">Keep eating</div>
              <div className="text-4xl font-bold text-stone-900 mt-1">{result.newTarget}</div>
              <div className="text-sm text-stone-600">kcal per day · same as before</div>
            </div>
          </>
        ) : (
          <>
            <h2 className="mt-2 text-3xl font-bold text-stone-900">
              {result.reason === 'down' ? 'Reducing your target.' : 'Bumping your target up.'}
            </h2>
            <p className="text-stone-700 mt-3 leading-relaxed">{result.message}</p>
            {result.detail && (
              <p className="text-stone-600 mt-3 text-sm leading-relaxed">{result.detail}</p>
            )}

            <div className="mt-6 bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-200 rounded-xl p-6">
              <div className="text-xs font-semibold text-orange-700 uppercase tracking-wider">Your new daily target</div>
              <div className="text-5xl font-bold text-stone-900 mt-1">{result.newTarget}</div>
              <div className="text-sm text-stone-600 mt-1">kcal per day</div>
            </div>

            {result.newFat !== undefined && (
              <div className="mt-4">
                <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-3">Updated macros</h3>
                <div className="space-y-2">
                  <div className="bg-white border border-stone-200 rounded-xl p-4 flex items-center justify-between">
                    <div className="font-medium text-stone-900">Protein</div>
                    <div className="text-xl font-bold text-stone-900">{result.newProtein}g</div>
                  </div>
                  <div className="bg-white border border-stone-200 rounded-xl p-4 flex items-center justify-between">
                    <div className="font-medium text-stone-900">Fat</div>
                    <div className="text-xl font-bold text-stone-900">{result.newFat}g</div>
                  </div>
                  <div className="bg-white border border-stone-200 rounded-xl p-4 flex items-center justify-between">
                    <div className="font-medium text-stone-900">Carbs</div>
                    <div className="text-xl font-bold text-stone-900">{result.newCarbs}g</div>
                  </div>
                  <div className="bg-white border border-stone-200 rounded-xl p-4 flex items-center justify-between">
                    <div className="font-medium text-stone-900">Fiber <span className="text-xs font-normal text-stone-500">(min)</span></div>
                    <div className="text-xl font-bold text-stone-900">{calculateFiber(result.newTarget)}g</div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* MealFrame handoff — only when targets changed AND we have a full code */}
        {showCode && (
          <>
            <div className="border-t border-stone-200 my-6"></div>
            <div className="bg-stone-900 rounded-xl p-5 text-center">
              <h4 className="text-xs font-semibold text-orange-400 uppercase tracking-wider">Your Updated MacroMetric™ Code</h4>
              <p className="text-stone-400 text-xs mt-1">Your numbers changed — paste this into MealFrame™ to refresh your meal structure and examples. Keep it for your next check-in, too.</p>
              <div className="mt-3 bg-stone-800 border border-stone-700 rounded-lg px-3 py-3">
                <code className="text-orange-300 text-xs break-all leading-relaxed">{updatedCode}</code>
              </div>
              <button
                onClick={copyCode}
                className="mt-3 inline-flex items-center gap-2 bg-white text-stone-900 text-sm font-medium py-2 px-4 rounded-full hover:bg-stone-100 transition-colors"
              >
                <Copy className="w-4 h-4" /> {copied ? 'Copied!' : 'Copy code'}
              </button>
            </div>

            <div className="text-center mt-6">
              <h3 className="text-xl font-bold text-stone-900">Refresh your meals</h3>
              <p className="text-stone-600 mt-2 text-sm leading-relaxed">
                Your targets moved, so your meal structure should too. Continue to <strong>MealFrame™</strong> with your updated code.
              </p>
              <div className="space-y-2 mt-5">
                <PrimaryButton onClick={goToMealFrame}>
                  Continue to MealFrame™ <ArrowRight className="w-4 h-4" />
                </PrimaryButton>
              </div>
            </div>
          </>
        )}

        {/* Targets changed but the check-in was started manually — can't build a complete code */}
        {result.verdict === 'change' && !updatedCode && (
          <div className="mt-6 bg-stone-50 border border-stone-200 rounded-xl p-4 text-xs text-stone-500 text-center leading-relaxed">
            Your targets changed. To get a MealFrame™ code automatically next time, start your check-in from your MacroMetric™ code instead of entering numbers by hand.
          </div>
        )}

        {/* No change → existing MealFrame plan is still current */}
        {isNoChange && ingestedPlan && (
          <div className="mt-6 bg-stone-50 border border-stone-200 rounded-xl p-4 text-xs text-stone-500 text-center leading-relaxed">
            Your numbers didn't change, so your current MealFrame™ structure is still on point — no refresh needed.
          </div>
        )}

        <div className="mt-6 bg-stone-50 border border-stone-200 rounded-xl p-5 text-sm text-stone-600">
          {footerNote}
        </div>

        <div className="text-center mt-6">
          <button onClick={onRestart} className="text-xs text-stone-500 hover:text-stone-700 underline underline-offset-2">
            Run another check-in or set up a new plan
          </button>
        </div>
      </div>
    </Card>
  );
};

// =====================================================
// MAIN APP
// =====================================================

export default function App() {
  const [screen, setScreen] = useState('landing');
  const [units, setUnits] = useState('metric');
  const [decoded, setDecoded] = useState(null);       // the SS1 code payload
  const [pastedCode, setPastedCode] = useState('');   // for the code screen prefill
  const [codeError, setCodeError] = useState(null);   // for URL-prefill failures
  const [details, setDetails] = useState({});         // age + activity
  const [result, setResult] = useState(null);

  const [checkInResult, setCheckInResult] = useState(null);
  const [checkInDirection, setCheckInDirection] = useState(null);
  const [ingestedPlan, setIngestedPlan] = useState(null); // decoded MM1 for check-in (null = manual)
  const [checkInPrefill, setCheckInPrefill] = useState({}); // display-unit prefill for the form

  // Click-through from PhysiquePlan: ?code=… → auto-load, zero typing.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const c = params.get('code');
      if (!c) return;
      const res = decodeShredSmartCode(c);
      if (res.ok) {
        setDecoded(res.data);
        setUnits(res.data.units);
        setPastedCode(c);
        setScreen('intro');
      } else {
        setPastedCode(c);
        setCodeError(res.error);
        setScreen('code');
      }
    } catch {
      // window unavailable (SSR/sandbox) — ignore, user can paste manually.
    }
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  useEffect(() => {
    if (screen === 'loading' && decoded) {
      const t = setTimeout(() => {
        const prescription = buildPrescription({
          height: decoded.height,
          weight: decoded.weight,
          tier: decoded.tier,
          subBracket: decoded.subBracket,
          direction: decoded.direction,
          archetypeId: decoded.archetypeId,
          goalLow: decoded.goalLow,
          goalHigh: decoded.goalHigh,
          destWeight: decoded.destWeight,
          rate: decoded.rate,
          ...details,
        });
        setResult(prescription);
        setScreen('results');
      }, 1800);
      return () => clearTimeout(t);
    }
  }, [screen, decoded, details]);

  const restart = () => {
    setScreen('landing');
    setUnits('metric');
    setDecoded(null);
    setPastedCode('');
    setCodeError(null);
    setDetails({});
    setResult(null);
    setCheckInResult(null);
    setCheckInDirection(null);
    setIngestedPlan(null);
    setCheckInPrefill({});
  };

  const goRerun = () => window.open(PLAN_URL, '_blank');

  // An MM1 code was pasted into the check-in flow: recover everything, pre-fill
  // the form (in display units), and route straight to the right check-in. The
  // target rate is READ from the code's rate field (no rate model here anymore).
  const onCheckInCodeDecoded = (mm1) => {
    setIngestedPlan(mm1);
    setUnits(mm1.units);
    setCheckInDirection(mm1.direction);

    const toDispW = (kg) => mm1.units === 'imperial'
      ? String(Math.round(kgToLb(kg) * 10) / 10)
      : String(Math.round(kg * 10) / 10);

    if (mm1.direction === 'cut') {
      const weeklyLossKg = mm1.weight * mm1.rate; // rate is fractional bw / week
      setCheckInPrefill({
        currentTarget: String(mm1.target),
        proteinTarget: String(mm1.protein),
        height: mm1.units === 'imperial' ? String(Math.round(mm1.height / 2.54)) : String(mm1.height),
        targetRate: toDispW(weeklyLossKg),
      });
      setScreen('checkin_cut');
    } else {
      const monthlyGainKg = mm1.weight * mm1.rate; // rate is fractional bw / month
      setCheckInPrefill({
        currentTarget: String(mm1.target),
        proteinTarget: String(mm1.protein),
        targetMonthlyGain: toDispW(monthlyGainKg),
      });
      setScreen('checkin_bulk');
    }
  };

  // Manual fallback: no code, clear any ingested plan/prefill.
  const onCheckInManual = () => {
    setIngestedPlan(null);
    setCheckInPrefill({});
    setScreen('checkin_router');
  };

  return (
    <Container>
      {screen === 'landing' && (
        <LandingScreen
          onStart={() => setScreen('code')}
          onCheckIn={() => setScreen('checkin_code')}
        />
      )}

      {/* PLAN SETUP FLOW */}
      {screen === 'code' && (
        <CodeScreen
          initialCode={pastedCode}
          initialError={codeError}
          onDecoded={(data, code) => {
            setDecoded(data);
            setUnits(data.units);
            setPastedCode(code);
            setCodeError(null);
            setScreen('intro');
          }}
          onBack={() => setScreen('landing')}
        />
      )}
      {screen === 'intro' && decoded && (
        <IntroScreen
          decoded={decoded}
          units={units}
          onContinue={() => setScreen('principle')}
          onBack={() => setScreen('code')}
          onRerun={goRerun}
        />
      )}
      {screen === 'principle' && (
        <PrincipleScreen
          onContinue={() => setScreen('details')}
          onBack={() => setScreen('intro')}
        />
      )}
      {screen === 'details' && (
        <DetailsScreen
          currentStep={1}
          totalSteps={1}
          onContinue={(data) => { setDetails(data); setScreen('loading'); }}
          onBack={() => setScreen('principle')}
        />
      )}
      {screen === 'loading' && <LoadingScreen />}
      {screen === 'results' && result && (
        <ResultsScreen
          result={result}
          units={units}
          onRestart={restart}
          onBack={() => setScreen('details')}
        />
      )}

      {/* CHECK-IN FLOW */}
      {screen === 'checkin_code' && (
        <CheckInCodeScreen
          onDecoded={onCheckInCodeDecoded}
          onManual={onCheckInManual}
          onBack={() => setScreen('landing')}
        />
      )}
      {screen === 'checkin_router' && (
        <CheckInRouterScreen
          onSelect={(d) => {
            setCheckInDirection(d);
            setScreen(d === 'cut' ? 'checkin_cut_units' : 'checkin_bulk_units');
          }}
          onBack={() => setScreen('checkin_code')}
        />
      )}
      {screen === 'checkin_cut_units' && (
        <UnitsScreen
          onSelect={(u) => { setUnits(u); setScreen('checkin_cut'); }}
          onBack={() => setScreen('checkin_router')}
        />
      )}
      {screen === 'checkin_cut' && (
        <CuttingCheckInScreen
          units={units}
          prefill={checkInPrefill}
          onSubmit={(data) => {
            const res = processCuttingCheckIn(data, units);
            setCheckInResult({ ...res, currentWeight: data.bwThisWeek });
            setScreen('checkin_result');
          }}
          onBack={() => setScreen(ingestedPlan ? 'checkin_code' : 'checkin_cut_units')}
        />
      )}
      {screen === 'checkin_bulk_units' && (
        <UnitsScreen
          onSelect={(u) => { setUnits(u); setScreen('checkin_bulk'); }}
          onBack={() => setScreen('checkin_router')}
        />
      )}
      {screen === 'checkin_bulk' && (
        <BulkingCheckInScreen
          units={units}
          prefill={checkInPrefill}
          onSubmit={(data) => {
            const res = processBulkingCheckIn(data, units);
            setCheckInResult({ ...res, currentWeight: data.bwThisMonth });
            setScreen('checkin_result');
          }}
          onBack={() => setScreen(ingestedPlan ? 'checkin_code' : 'checkin_bulk_units')}
        />
      )}
      {screen === 'checkin_result' && checkInResult && (
        <CheckInResultScreen
          result={checkInResult}
          direction={checkInDirection}
          units={units}
          ingestedPlan={ingestedPlan}
          onRestart={restart}
          onBack={() => setScreen(checkInDirection === 'cut' ? 'checkin_cut' : 'checkin_bulk')}
        />
      )}
    </Container>
  );
}