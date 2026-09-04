// =====================================================
// ShredSmart membership gate — shared auth library
// Imported by send-link.js, verify.js, session.js, logout.js.
// The leading underscore in /api/_lib keeps Vercel from turning
// this into a routable endpoint. It is import-only.
//
// No npm dependencies: Node's built-in crypto plus the global
// fetch that ships with Vercel's Node runtime.
// =====================================================

import crypto from 'crypto';

// ---- Config pulled from environment variables --------
// These are set in the Vercel dashboard, per project. AUTH_SECRET
// and COOKIE_DOMAIN MUST be identical across all three gated apps,
// or a cookie set by one app won't validate on the others.
const SECRET        = process.env.AUTH_SECRET;
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '.raduantoniu.com';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TBL  = process.env.AIRTABLE_TABLE || 'Members';
const AIRTABLE_TOK  = process.env.AIRTABLE_TOKEN;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const MAIL_FROM     = process.env.MAIL_FROM; // e.g. login@mail.raduantoniu.com

export const COOKIE_NAME = 'ss_session';

// Lifetimes
export const MAGIC_TTL_MS   = 15 * 60 * 1000;             // magic link: 15 minutes
export const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;   // session cookie: 60 days
export const RECHECK_MS     = 24 * 60 * 60 * 1000;        // re-verify against Airtable once/day

// =====================================================
// TOKEN SIGNING
// Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
// The payload is readable but cannot be altered or forged without
// AUTH_SECRET. Every token carries an `exp` (epoch ms) and a
// `purpose` so a magic-link token can't be replayed as a session.
// =====================================================

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

export function sign(payload) {
  if (!SECRET) throw new Error('AUTH_SECRET is not set');
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verify(token) {
  if (!SECRET) throw new Error('AUTH_SECRET is not set');
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;

  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

// =====================================================
// COOKIES
// HttpOnly  → page JavaScript can't read it (blunts XSS token theft)
// Secure    → HTTPS only
// SameSite=Lax → survives the top-level click from the email link,
//                and is fine because all four apps are one site
// Domain=.raduantoniu.com → one sign-in covers every subdomain
// =====================================================

export function sessionCookie(value, maxAgeSec) {
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Domain=${COOKIE_DOMAIN}`,
    `Max-Age=${maxAgeSec}`,
  ].join('; ');
}

export function clearedCookie() {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Domain=${COOKIE_DOMAIN}`,
    'Max-Age=0',
  ].join('; ');
}

export function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers.cookie || '';
  const hit = header
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + '='));
  if (!hit) return null;
  return decodeURIComponent(hit.slice(name.length + 1));
}

// =====================================================
// EMAIL HELPERS
// =====================================================

export function normalizeEmail(raw) {
  return (raw || '').toString().trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// =====================================================
// AIRTABLE LOOKUP
// Returns the member { email, name } if the email exists AND Status
// is active (or blank), otherwise null. Case-insensitive on email.
// Throws on a network/API failure so callers can decide how to react.
// =====================================================

export async function findActiveMember(email) {
  if (!AIRTABLE_BASE || !AIRTABLE_TOK) throw new Error('Airtable env vars not set');

  const safe = email.replace(/'/g, "\\'"); // escape quotes for the formula
  const formula = `LOWER({Email})='${safe}'`;
  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TBL)}` +
    `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOK}` } });
  if (!res.ok) throw new Error(`Airtable responded ${res.status}`);

  const data = await res.json();
  const rec = data.records && data.records[0];
  if (!rec) return null;

  const status = (rec.fields.Status || '').toString().toLowerCase();
  if (status && status !== 'active') return null; // cancelled/paused etc.

  return {
    email: normalizeEmail(rec.fields.Email),
    name: rec.fields.Name || '',
  };
}

// =====================================================
// SEND THE MAGIC-LINK EMAIL VIA RESEND
// Kept as plain as possible (short text + one button) because heavy
// HTML is the fastest way into a spam folder.
// =====================================================

export async function sendMagicEmail(toEmail, link) {
  if (!RESEND_KEY || !MAIL_FROM) throw new Error('Resend env vars not set');

  const text =
    `Tap this link to sign in to ShredSmart. ` +
    `It works for the next 15 minutes and signs you in on the device you open it on.\n\n` +
    `${link}\n\n` +
    `If you did not request this, you can ignore this email.`;

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1c1917;">` +
      `<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Tap the button to sign in to ShredSmart. This link works for 15 minutes and signs you in on the device you open it on.</p>` +
      `<p style="margin:0 0 24px;"><a href="${link}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:9999px;">Sign in</a></p>` +
      `<p style="font-size:13px;color:#78716c;line-height:1.5;margin:0 0 12px;">Or paste this link into your browser:<br>${link}</p>` +
      `<p style="font-size:13px;color:#78716c;line-height:1.5;margin:0;">If you did not request this, ignore this email.</p>` +
    `</div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `ShredSmart <${MAIL_FROM}>`,
      to: [toEmail],
      subject: 'Your ShredSmart login link',
      text,
      html,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend responded ${res.status}: ${detail}`);
  }
}