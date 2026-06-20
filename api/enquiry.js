// api/enquiry.js  —  Sanctum Concierge enquiry handler (Vercel serverless function)
// Runs automatically at  https://yoursite.com/api/enquiry  once pushed to the repo.
//
// Environment variables (set them in Vercel):
//   TURNSTILE_SECRET   — your Cloudflare Turnstile secret key
//   AC_API_URL         — your ActiveCampaign API URL
//   AC_API_KEY         — your ActiveCampaign API key
//   RESEND_API_KEY     — your Resend API key  (this is what emails the alert to you)
//
// The function finds your "Concierge Enquiry" custom field and tag BY NAME,
// so you don't need to look up any ID numbers.
//
// WHO SENDS WHAT:
//   • The alert to YOU (the full enquiry) is sent here, by this function, via Resend.
//   • The "we'll be in touch within 24 hours" reply to the ENQUIRER is sent by your
//     ActiveCampaign automation (a plain "Send an email" action), triggered by the tag.

const FIELD_NAME = 'Concierge Enquiry';   // must match the custom field name in ActiveCampaign
const TAG_NAME   = 'Concierge Enquiry';   // must match the tag name in ActiveCampaign

// Where your enquiry alerts go, and who they come from.
// The FROM address must be on a domain you've verified in Resend.
const TEAM_EMAIL = 'hello@theglobalsanctum.com';
const FROM_EMAIL = 'Sanctum Concierge <concierge@theglobalsanctum.com>';

let cachedFieldId = null;   // remembered between requests while the function is warm
let cachedTagId = null;

// Email the full enquiry to the team via Resend. Never throws — a notification
// problem must not stop the enquiry from being saved or the visitor from getting
// their confirmation. If RESEND_API_KEY isn't set yet, it quietly does nothing.
async function sendTeamAlert({ subject, text, replyTo }) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const payload = { from: FROM_EMAIL, to: [TEAM_EMAIL], subject, text };
    if (replyTo) payload.reply_to = replyTo;   // lets you reply straight to the enquirer
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Team alert email failed (enquiry still saved):', e);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { name = '', email = '', phone = '', role = '', fields = [], token = '' } = req.body || {};
    if (!email) {
      res.status(400).json({ error: 'Email is required.' });
      return;
    }

    // 1) Verify the Cloudflare Turnstile (captcha) token
    const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET,
        response: token,
        remoteip: req.headers['x-forwarded-for'] || ''
      })
    });
    const verifyData = await verify.json();
    if (!verifyData.success) {
      res.status(400).json({ error: 'Verification failed. Please try again.' });
      return;
    }

    const base = (process.env.AC_API_URL || '').replace(/\/$/, '');
    const headers = { 'Api-Token': process.env.AC_API_KEY, 'Content-Type': 'application/json' };

    // 2) Build one readable block containing the WHOLE enquiry
    const roleLabel = { guest: 'Wellness Guest', host: 'Retreat Host', partner: 'Venue Owner' }[role] || role || 'Not specified';
    const lines = ['Audience: ' + roleLabel];
    if (name)  lines.push('Name: ' + name);
    if (email) lines.push('Email: ' + email);
    if (phone) lines.push('Phone: ' + phone);
    lines.push('—');
    (fields || []).forEach(f => { if (f && f.label && f.value) lines.push(f.label + ': ' + f.value); });
    const summary = lines.join('\n');

    // 2b) Email the full enquiry to the team straight away (via Resend).
    //     Done before the ActiveCampaign calls so you're alerted even if AC ever fails.
    await sendTeamAlert({
      subject: 'New Concierge Enquiry — ' + roleLabel + (name ? ' — ' + name : ''),
      text: summary,
      replyTo: email || undefined
    });

    // 3) Find the custom field's ID by name (looked up once, then cached)
    if (!cachedFieldId) {
      const r = await fetch(base + '/api/3/fields?limit=100', { headers });
      const d = await r.json();
      const field = (d.fields || []).find(f => (f.title || '').trim().toLowerCase() === FIELD_NAME.toLowerCase());
      cachedFieldId = field ? field.id : null;
    }

    // 4) Create or update the contact, storing the full enquiry in that field
    const contactBody = { contact: { email, firstName: name, phone } };
    if (cachedFieldId) contactBody.contact.fieldValues = [{ field: cachedFieldId, value: summary }];
    const syncRes = await fetch(base + '/api/3/contact/sync', {
      method: 'POST', headers, body: JSON.stringify(contactBody)
    });
    const syncData = await syncRes.json();
    const contactId = syncData && syncData.contact && syncData.contact.id;

    // 5) Find the tag by name (or create it if missing), then cache it
    if (!cachedTagId) {
      const r = await fetch(base + '/api/3/tags?search=' + encodeURIComponent(TAG_NAME), { headers });
      const d = await r.json();
      let tag = (d.tags || []).find(t => (t.tag || '').trim().toLowerCase() === TAG_NAME.toLowerCase());
      if (!tag) {
        const cr = await fetch(base + '/api/3/tags', {
          method: 'POST', headers,
          body: JSON.stringify({ tag: { tag: TAG_NAME, tagType: 'contact', description: 'New concierge enquiry submitted' } })
        });
        tag = (await cr.json()).tag;
      }
      cachedTagId = tag ? tag.id : null;
    }

    // 6) Apply the tag — this is what triggers your ActiveCampaign autoresponder
    if (contactId && cachedTagId) {
      await fetch(base + '/api/3/contactTags', {
        method: 'POST', headers,
        body: JSON.stringify({ contactTag: { contact: contactId, tag: cachedTagId } })
      });
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Enquiry error:', err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  }
};
