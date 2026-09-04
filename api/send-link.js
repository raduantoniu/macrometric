// =====================================================
// POST /api/send-link
// Body: { email }
// Looks the email up in Airtable. If it's an active member, signs a
// 15-minute magic token and emails a login link that points back to
// THIS app's /api/verify. Always answers the same way whether or not
// the email is a member, so the form can't be used to test who is in
// the community.
// =====================================================

import {
  sign,
  normalizeEmail,
  isValidEmail,
  findActiveMember,
  sendMagicEmail,
  MAGIC_TTL_MS,
} from './_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false });
  }

  const email = normalizeEmail(req.body && req.body.email);

  // Invalid input gets the same generic answer, no email sent.
  if (!isValidEmail(email)) {
    return res.status(200).json({ ok: true });
  }

  try {
    const member = await findActiveMember(email);

    if (member) {
      const token = sign({
        email: member.email,
        purpose: 'magic',
        exp: Date.now() + MAGIC_TTL_MS,
      });

      // Build the link back to the app the request came from, so the
      // member lands where they started after clicking.
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const link = `https://${host}/api/verify?token=${encodeURIComponent(token)}`;

      await sendMagicEmail(member.email, link);
    }
    // Non-members: intentionally do nothing.
  } catch (err) {
    // Log for your own debugging (visible in Vercel's function logs).
    // Still return generic success so a failure doesn't reveal
    // whether the address was a member.
    console.error('[send-link]', err);
  }

  return res.status(200).json({ ok: true });
}