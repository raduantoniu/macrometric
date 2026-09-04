// =====================================================
// GET /api/verify?token=...
// The target of the magic link in the email. Validates the token,
// and on success sets the shared session cookie (60 days, scoped to
// .raduantoniu.com so all four apps see it) then redirects into the
// app. On a bad or expired token, redirects to the login screen with
// a flag the gate turns into a friendly message.
// =====================================================

import {
  verify,
  sign,
  sessionCookie,
  SESSION_TTL_MS,
} from './_lib/auth.js';

export default async function handler(req, res) {
  const token = req.query && req.query.token;
  const data = verify(token);

  if (!data || data.purpose !== 'magic') {
    return res.redirect(302, '/?auth=expired');
  }

  const now = Date.now();
  const session = sign({
    email: data.email,
    purpose: 'session',
    iat: now,
    exp: now + SESSION_TTL_MS,
    lastChecked: now, // first Airtable re-check happens 24h from now
  });

  res.setHeader('Set-Cookie', sessionCookie(session, Math.floor(SESSION_TTL_MS / 1000)));
  return res.redirect(302, '/?auth=ok');
}