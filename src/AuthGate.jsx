import React, { useState, useEffect } from 'react';
import { Loader2, ArrowRight } from 'lucide-react';

// =====================================================
// ShredSmart membership gate — front-end wrapper
//
// Wrap your app's root with this. It checks /api/session on load and
// only renders the app once the member is signed in; otherwise it
// shows the magic-link login screen. Same file drops into MacroMetric,
// MealFrame and OptiWorkout — the only thing you change per app is
// APP_NAME below.
//
// Usage (in main.jsx / index.jsx):
//   import AuthGate from './AuthGate';
//   root.render(<AuthGate><App /></AuthGate>);
// =====================================================

// CHANGE THIS PER APP: 'MacroMetric™' | 'MealFrame™' | 'OptiWorkout™'
const APP_NAME = 'MacroMetric™';

const LOGO_URL = '/logo.png';

// ---- Chrome (mirrors the app's own Container/Header/Footer/Card) ----

const Logo = ({ size = 32 }) => (
  <img
    src={LOGO_URL}
    alt="ShredSmart logo"
    width={size}
    height={size}
    className="rounded-lg"
    style={{ width: size, height: size }}
  />
);

const Shell = ({ appName, children }) => (
  <div
    className="min-h-screen bg-stone-50 flex flex-col"
    style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}
  >
    <header className="w-full px-6 py-4 flex items-center justify-between border-b border-stone-200 bg-white">
      <div className="flex items-center gap-2.5">
        <Logo size={32} />
        <span className="font-semibold text-stone-900 tracking-tight">ShredSmart™</span>
      </div>
      <span className="text-xs text-stone-500 tracking-wider">{appName}</span>
    </header>

    <main className="flex-1 flex items-center justify-center px-4 py-8">{children}</main>

    <footer className="w-full px-6 py-4 border-t border-stone-200 bg-white text-xs text-stone-500 flex justify-between">
      <span>ShredSmart™</span>
      <span>by Radu Antoniu</span>
    </footer>
  </div>
);

const Card = ({ children }) => (
  <div className="bg-white border border-stone-200 rounded-2xl shadow-sm p-8 max-w-xl w-full">
    {children}
  </div>
);

// ---- The gate ----

export default function AuthGate({ children, appName = APP_NAME }) {
  const [state, setState] = useState('checking'); // checking | login | sent | authed
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState('');

  useEffect(() => {
    // Turn ?auth=expired from a dead link into a visible message, then
    // strip the flag so it doesn't linger in the URL.
    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    if (auth === 'expired') {
      setError('That link expired. Enter your email to get a new one.');
    }
    if (auth) {
      params.delete('auth');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
    }
    checkSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkSession() {
    setState('checking');
    try {
      const r = await fetch('/api/session', { credentials: 'same-origin' });
      const d = await r.json();
      setState(d.authed ? 'authed' : 'login');
    } catch {
      setState('login');
    }
  }

  async function submit() {
    const value = email.trim();
    if (!value) return;
    setSubmitting(true);
    setError(null);
    try {
      await fetch('/api/send-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value }),
      });
      setSentTo(value);
      setState('sent');
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Authed: render the real app ----
  if (state === 'authed') return children;

  // ---- Checking session: quiet spinner in the app chrome ----
  if (state === 'checking') {
    return (
      <Shell appName={appName}>
        <div className="flex flex-col items-center py-12">
          <Loader2 className="w-6 h-6 text-stone-400 animate-spin" />
        </div>
      </Shell>
    );
  }

  // ---- Sent: check-your-inbox confirmation ----
  if (state === 'sent') {
    return (
      <Shell appName={appName}>
        <Card>
          <span className="text-xs font-semibold text-orange-600 tracking-widest uppercase">
            Check your inbox
          </span>
          <h1 className="mt-2 text-3xl font-bold text-stone-900 tracking-tight">
            Link on the way.
          </h1>
          <p className="text-stone-600 mt-3 leading-relaxed">
            If <span className="font-medium text-stone-900">{sentTo}</span> is a ShredSmart member,
            a login link is on its way. It works for 15 minutes and signs you in on this device.
          </p>
          <p className="text-stone-600 mt-3 leading-relaxed text-sm">
            No email? Check your spam folder, and make sure you used the email attached to your
            ShredSmart Skool account.
          </p>
          <button
            onClick={() => { setState('login'); setError(null); }}
            className="mt-6 text-sm text-stone-500 hover:text-stone-900 transition-colors underline underline-offset-2"
          >
            Use a different email
          </button>
        </Card>
      </Shell>
    );
  }

  // ---- Login: the email form ----
  return (
    <Shell appName={appName}>
      <Card>
        <span className="text-xs font-semibold text-orange-600 tracking-widest uppercase">
          ShredSmart™ Members
        </span>
        <h1 className="mt-2 text-3xl font-bold text-stone-900 tracking-tight">
          Sign in to {appName}
        </h1>
        <p className="text-stone-600 mt-3 leading-relaxed">
          Enter the email you use for the ShredSmart Skool community. You'll get a link that signs
          you in on this device.
        </p>

        <div className="mt-6">
          <label className="text-sm font-medium text-stone-700">Email address</label>
          <input
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="you@example.com"
            className="mt-1 w-full px-4 py-3 rounded-lg border border-stone-200 bg-white text-stone-900 focus:outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
          />

          {error && (
            <p className="mt-3 text-sm text-amber-700">{error}</p>
          )}

          <button
            onClick={submit}
            disabled={submitting || !email.trim()}
            className={`mt-4 w-full ${
              submitting || !email.trim()
                ? 'bg-stone-300 cursor-not-allowed text-stone-500'
                : 'bg-stone-900 hover:bg-stone-800 text-white'
            } font-medium py-3.5 px-6 rounded-full transition-colors flex items-center justify-center gap-2`}
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Sending
              </>
            ) : (
              <>
                Send me a login link <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>

          <p className="mt-3 text-xs text-stone-500">
            No password. The link works for 15 minutes and signs you in on this device.
          </p>
        </div>
      </Card>
    </Shell>
  );
}