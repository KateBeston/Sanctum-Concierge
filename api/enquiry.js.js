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
// It also subscribes each enquirer to the list that matches their audience, so
// ActiveCampaign will actually SEND the autoresponder (AC refuses to send to a
// contact who is not on any list):
//   Retreat Host  -> list 5     Wellness Guest -> list 6     Venue Owner -> list 4
//
// WHO SENDS WHAT:
//   • The alert to YOU (the full enquiry) is sent here, by this function, via Resend.
//   • The "we'll be in touch within 24 hours" reply to the ENQUIRER is sent by your
//     ActiveCampaign automation (a plain "Send an email" action), triggered by the tag.
//
// GENERAL MARKETING OPT-IN (added alongside the main enquiry):
//   The enquiry form now also has a SECOND, optional checkbox: "Also send me general
//   updates and news from The Global Sanctum." If ticked, the contact additionally gets
//   the SEPARATE "TGS General Updates" tag. This is a broader marketing consent, distinct
//   from the Concierge Enquiry tag — it does not change how the enquiry itself is handled.

const FIELD_NAME = 'Concierge Enquiry';   // must match the custom field name in ActiveCampaign
const TAG_NAME   = 'Concierge Enquiry';   // must match the tag name in ActiveCampaign
const GENERAL_TAG_NAME = 'TGS General Updates';   // <-- applied ONLY if the second checkbox is ticked

// Which ActiveCampaign list each audience joins (by list ID).
// This is what unblocks the autoresponder send AND segments the contact.
const LIST_BY_ROLE = {
  host:    5,   // Retreat Hosts
  guest:   6,   // Wellness Guests
  partner: 4    // Venues / Venue Owners
};

// Where your enquiry alerts go, and who they come from.
// The FROM address must be on a domain you've verified in Resend.
const TEAM_EMAIL = 'hello@theglobalsanctum.com';
const FROM_EMAIL = 'Sanctum Concierge <concierge@theglobalsanctum.com>';

let cachedFieldId = null;   // remembered between requests while the function is warm
let cachedTagId = null;
let cachedGeneralTagId = null;

// Split a single "Your name" field into firstName / lastName for ActiveCampaign.
// "Kate Beston" -> firstName "Kate", lastName "Beston"
// "Mary Anne Smith" -> firstName "Mary", lastName "Anne Smith" (first word only as first name,
// everything else as last name — this matches how most CRMs split full names)
// "Kate" (single word) -> firstName "Kate", lastName "" (left blank, not guessed at)
function splitName(fullName) {
  const trimmed = (fullName || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return { firstName: '', lastName: '' };
  const parts = trimmed.split(' ');
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ');
  return { firstName, lastName };
}

// Find a tag by exact name (creating it if missing), returning its id.
// `cacheGet`/`cacheSet` let each tag be looked up once per warm function instance.
async function findOrCreateTag(base, headers, tagName, description, cacheGet, cacheSet) {
  const cached = cacheGet();
  if (cached) return cached;
  const r = await fetch(base + '/api/3/tags?search=' + encodeURIComponent(tagName), { headers });
  const d = await r.json();
  let tag = (d.tags || []).find(t => (t.tag || '').trim().toLowerCase() === tagName.toLowerCase());
  if (!tag) {
    const cr = await fetch(base + '/api/3/tags', {
      method: 'POST', headers,
      body: JSON.stringify({ tag: { tag: tagName, tagType: 'contact', description } })
    });
    tag = (await cr.json()).tag;
  }
  const id = tag ? tag.id : null;
  cacheSet(id);
  return id;
}

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
    const { name = '', email = '', phone = '', role = '', fields = [], token = '', generalMarketing = false } = req.body || {};
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
      text: summary + (generalMarketing ? '\n\n(also opted into general TGS updates)' : ''),
      replyTo: email || undefined
    });

    // 3) Find the custom field's ID by name (looked up once, then cached)
    if (!cachedFieldId) {
      const r = await fetch(base + '/api/3/fields?limit=100', { headers });
      const d = await r.json();
      const field = (d.fields || []).find(f => (f.title || '').trim().toLowerCase() === FIELD_NAME.toLowerCase());
      cachedFieldId = field ? field.id : null;
    }

    // 4) Create or update the contact, storing the full enquiry in that field.
    //    The single "Your name" field is split into firstName/lastName so
    //    ActiveCampaign stores them properly rather than dumping the whole
    //    name into firstName.
    const { firstName, lastName } = splitName(name);
    const contactBody = { contact: { email, firstName, lastName, phone } };
    if (cachedFieldId) contactBody.contact.fieldValues = [{ field: cachedFieldId, value: summary }];
    const syncRes = await fetch(base + '/api/3/contact/sync', {
      method: 'POST', headers, body: JSON.stringify(contactBody)
    });
    const syncData = await syncRes.json();
    const contactId = syncData && syncData.contact && syncData.contact.id;

    // 5) Subscribe the contact to the list that matches their audience.
    //    AC will not SEND the autoresponder unless the contact is on a list,
    //    so this step is what unblocks the email — and it segments them too.
    const listId = LIST_BY_ROLE[role];
    if (contactId && listId) {
      await fetch(base + '/api/3/contactLists', {
        method: 'POST', headers,
        body: JSON.stringify({ contactList: { list: listId, contact: contactId, status: 1 } })
      });
    }

    // 6) Apply the "Concierge Enquiry" tag — this is what triggers your ActiveCampaign autoresponder
    const tagId = await findOrCreateTag(
      base, headers, TAG_NAME, 'New concierge enquiry submitted',
      () => cachedTagId, (id) => { cachedTagId = id; }
    );
    if (contactId && tagId) {
      await fetch(base + '/api/3/contactTags', {
        method: 'POST', headers,
        body: JSON.stringify({ contactTag: { contact: contactId, tag: tagId } })
      });
    }

    // 7) If they also ticked the second, optional checkbox, apply the SEPARATE
    //    "TGS General Updates" tag — a broader marketing consent, distinct from
    //    the enquiry itself.
    if (generalMarketing) {
      const generalTagId = await findOrCreateTag(
        base, headers, GENERAL_TAG_NAME, 'Opted into general TGS marketing communications',
        () => cachedGeneralTagId, (id) => { cachedGeneralTagId = id; }
      );
      if (contactId && generalTagId) {
        await fetch(base + '/api/3/contactTags', {
          method: 'POST', headers,
          body: JSON.stringify({ contactTag: { contact: contactId, tag: generalTagId } })
        });
      }
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Enquiry error:', err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  }
};
