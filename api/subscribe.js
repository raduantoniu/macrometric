// api/subscribe.js
// Vercel serverless function — receives email signup, sends to Brevo with double opt-in

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, firstName } = req.body || {};

  // Basic validation
  if (!email || !firstName) {
    return res.status(400).json({ error: 'Missing email or firstName' });
  }

  const emailRegex = /^\S+@\S+\.\S+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // Read secrets from environment variables (set in Vercel dashboard)
  const apiKey = process.env.BREVO_API_KEY;
  const listId = parseInt(process.env.BREVO_LIST_ID, 10);
  const templateId = parseInt(process.env.BREVO_DOI_TEMPLATE_ID, 10);
  const redirectionUrl = process.env.BREVO_REDIRECT_URL || 'https://example.com/welcome';

  if (!apiKey || !listId || !templateId) {
    console.error('Missing Brevo configuration');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const brevoResponse = await fetch('https://api.brevo.com/v3/contacts/doubleOptinConfirmation', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        email: email,
        attributes: {
          FIRSTNAME: firstName,
        },
        includeListIds: [listId],
        templateId: templateId,
        redirectionUrl: redirectionUrl,
      }),
    });

    if (brevoResponse.ok || brevoResponse.status === 204) {
      return res.status(200).json({ success: true });
    }

    // Brevo returned an error
    const errorData = await brevoResponse.json().catch(() => ({}));
    console.error('Brevo error:', brevoResponse.status, errorData);

    // If contact already exists, that's actually fine for our purposes
    if (errorData.code === 'duplicate_parameter') {
      return res.status(200).json({ success: true, alreadySubscribed: true });
    }

    return res.status(500).json({ error: 'Failed to subscribe', details: errorData });
  } catch (err) {
    console.error('Subscribe error:', err);
    return res.status(500).json({ error: 'Network error' });
  }
}