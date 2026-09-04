// =====================================================
// GET /api/session
// Called by the gate on every app load. Verifies the signed cookie
// LOCALLY (no network, so this is cheap and stays well under
// Airtable's rate limits). At most once per day it re-checks the
// member against Airtable to catch cancellations, then re-stamps the
// cookie. Returns { authed: true|false }.
//
// Revocation timing: deleting a row (or flipping Status to cancelled)
// removes access within ~24h, not instantly. That is deliberate — a
// lapsed member running the tools for another day costs nothing, and
// it keeps this endpoint from hitting Airtable on every page view.
// =====================================================

import {
  verify,
  sign,
  readCookie,
  sessionCookie,
  clearedCookie,
  findActiveMember,
  RECHECK_MS,
} from './_lib/auth.js';

export default async function handler(req, res) {
  const raw = readCookie(req);
  const data = verify(raw);

  if (!data || data.purpose !== 'session') {
    return res.status(200).json({ authed: false });
  }

  const now = Date.now();

  // Time for the daily Airtable re-check?
  if (now - (data.lastChecked || 0) > RECHECK_MS) {
    try {
      const member = await findActiveMember(data.email);

      if (!member) {
        // Cancelled or removed → clear the cookie and lock out.
        res.setHeader('Set-Cookie', clearedCookie());
        return res.status(200).json({ authed: false });
      }

      // Still active → refresh lastChecked, keep the original 60-day
      // expiry (so re-verification via email still happens every 60d).
      const refreshed = sign({ ...data, lastChecked: now });
      const remainingSec = Math.max(0, Math.floor((data.exp - now) / 1000));
      res.setHeader('Set-Cookie', sessionCookie(refreshed, remainingSec));
    } catch (err) {
      // Airtable unreachable: FAIL OPEN. Keep the member signed in
      // rather than locking everyone out during a provider outage.
      // The re-check simply retries on the next load.
      console.error('[session] recheck failed, failing open', err);
    }
  }

  return res.status(200).json({ authed: true, email: data.email });
}