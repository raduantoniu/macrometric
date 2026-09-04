// =====================================================
// /api/logout   (optional, bonus)
// Clears the shared session cookie. Useful for a "sign out" control
// on a shared or borrowed device. Because the cookie is scoped to
// .raduantoniu.com, signing out here signs out of all four apps.
// =====================================================

import { clearedCookie } from './_lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Set-Cookie', clearedCookie());
  return res.status(200).json({ ok: true });
}