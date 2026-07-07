// api/platform-updates.js  —  Platform Waitlist sign-up handler (Vercel serverless function)
// Runs automatically at  https://sanctumconcierge.com/api/platform-updates  once pushed to the repo.
//
// This is the "Stay updated on the platform" section — a SEPARATE, low-commitment sign-up
// from both the Sanctum Journal newsletter and the Concierge enquiry form. It exists purely
// to let guests, hosts, and venue owners register interest and be notified when the TGS
// platform opens. It shares NO tags or lists purpose with the Journal or the Enquiry form —
// someone signing up here is not added to the Journal, and vice versa.
//
// Uses the SAME environment variables you already set for the other two functions, plus one
// new Turnstile secret for this form's own widget:
//   AC_API_URL                — your ActiveCampaign API URL
//   AC_API_KEY                — your ActiveCampaign API key
//   RESEND_API_KEY            — your Resend API key (sends you the new-signup alert)
//   TURNSTILE_SECRET_PLATFORM — the secret for the "Platform Waitlist" Turnstile widget
//                               (its own sitekey + secret, separate from the other two
//                               widgets). Falls back to TURNSTILE_SECRET if you haven't
//                               created the dedicated widget in Cloudflare yet.
//
// WHAT IT DOES, in order:
//   1. Basic spam check (honeypot).
//   2. Turnstile check against this form's own secret.
//   3. Creates or updates the contact in ActiveCampaign.
//   4. Subscribes the contact to the Master Contact List. IMPORTANT: ActiveCampaign will
//      NOT send an automated email to a contact with zero list subscriptions, even if a
//      tag-based automation trigger fires correctly. This step exists purely to satisfy
//      that requirement — the tag below is still what determines what they actually receive.
//   5. Applies the "Platform Waitlist" tag — this is a BROAD marketing consent
//      ("I agree to receive updates and marketing communications from The Global Sanctum"),
//      so you are free to send this segment anything TGS-wide, not just platform-launch news.
//   6. If a role was selected (guest / host / venue owner), also applies a role-specific tag
//      so you can send more targeted launch content later if you want to.
//   7. Emails you an alert via Resend.
//
// THINGS TO CONFIRM (see CONFIG below):
//   • LIST_NAME must exactly match your Master Contact List's name in ActiveCampaign.
//   • TAG_NAME must exactly match (or will be created as) the tag name in ActiveCampaign.
//   • Your ActiveCampaign automation for the "you're on the waitlist" email should be
//     triggered off this tag being added.

// ---------- CONFIG ----------
const LIST_NAME = 'Master Contact List';   // <-- must match your ActiveCampaign list name exactly
const TAG_NAME   = 'Platform Waitlist';    // <-- broad marketing-consent tag applied to everyone who signs up here

// Optional role-specific tags, applied ADDITIONALLY if the visitor picked a role from the dropdown.
// Purely for your own future segmentation — not required, not shown to the visitor.
const ROLE_TAG = {
  guest:   'Platform Waitlist — Wellness Guest',
  host:    'Platform Waitlist — Retreat Host',
  partner: 'Platform Waitlist — Venue Owner'
};

const TEAM_EMAIL = 'hello@theglobalsanctum.com';
const FROM_EMAIL = 'The Global Sanctum <concierge@theglobalsanctum.com>';  // must be on your Resend-verified domain
// ----------------------------

let cachedListId = null;
let cachedTagId = null;
const cachedRoleTagIds = {};   // one cache slot per role, filled in as needed

// Email the alert to the team via Resend. Never throws — an alert problem must not
// stop the sign-up from being saved. If RESEND_API_KEY isn't set, it quietly does nothing.
async function sendTeamAlert({ subject, text, replyTo }) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const payload = { from: FROM_EMAIL, to: [TEAM_EMAIL], subject, text };
    if (replyTo) payload.reply_to = replyTo;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Platform waitlist alert email failed (sign-up still saved):', e);
  }
}

// Find a tag by exact name (creating it if missing), returning its id.
async function findOrCreateTag(base, headers, tagName, description) {
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
  return tag ? tag.id : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { email = '', role = '', company = '', token = '' } = req.body || {};

    // 1) Honeypot: real people leave this empty. If it's filled, pretend success and stop.
    if (company) { res.status(200).json({ ok: true }); return; }

    // Basic email sanity check
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: 'A valid email is required.' });
      return;
    }

    // 2) Turnstile check — verifies against this form's own secret.
    const turnstileSecret = process.env.TURNSTILE_SECRET_PLATFORM || process.env.TURNSTILE_SECRET;
    if (!token || !turnstileSecret) {
      res.status(400).json({ error: 'Verification failed. Please try again.' });
      return;
    }
    {
      const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: turnstileSecret,
          response: token,
          remoteip: req.headers['x-forwarded-for'] || ''
        })
      });
      const verifyData = await verify.json();
      if (!verifyData.success) {
        res.status(400).json({ error: 'Verification failed. Please try again.' });
        return;
      }
    }

    const base = (process.env.AC_API_URL || '').replace(/\/$/, '');
    const headers = { 'Api-Token': process.env.AC_API_KEY, 'Content-Type': 'application/json' };

    const roleLabel = { guest: 'Wellness Guest', host: 'Retreat Host', partner: 'Venue Owner' }[role] || 'Not specified';

    // Alert you straight away (before the AC calls) so you never miss a sign-up
    await sendTeamAlert({
      subject: 'New Platform Waitlist sign-up',
      text: 'Email: ' + email + '\nInterested as: ' + roleLabel,
      replyTo: email
    });

    // 3) Create or update the contact
    const syncRes = await fetch(base + '/api/3/contact/sync', {
      method: 'POST', headers,
      body: JSON.stringify({ contact: { email } })
    });
    const syncData = await syncRes.json();
    const contactId = syncData && syncData.contact && syncData.contact.id;

    // 4) Subscribe to the Master Contact List — required for AC to actually deliver the
    //    automated email below. This does NOT expose them to unrelated content; the tag
    //    is still what determines what they actually receive.
    if (!cachedListId) {
      const r = await fetch(base + '/api/3/lists?limit=100', { headers });
      const d = await r.json();
      const list = (d.lists || []).find(l => (l.name || '').trim().toLowerCase() === LIST_NAME.toLowerCase());
      cachedListId = list ? list.id : null;
    }
    if (contactId && cachedListId) {
      await fetch(base + '/api/3/contactLists', {
        method: 'POST', headers,
        body: JSON.stringify({ contactList: { list: cachedListId, contact: contactId, status: 1 } })
      });
    }

    // 5) Apply the broad "Platform Waitlist" tag
    if (!cachedTagId) {
      cachedTagId = await findOrCreateTag(
        base, headers, TAG_NAME,
        'Agreed to receive updates and marketing communications from The Global Sanctum'
      );
    }
    if (contactId && cachedTagId) {
      await fetch(base + '/api/3/contactTags', {
        method: 'POST', headers,
        body: JSON.stringify({ contactTag: { contact: contactId, tag: cachedTagId } })
      });
    }

    // 6) If a role was picked, also apply that role-specific tag (optional, purely for
    //    your own future segmentation when the platform actually launches)
    const roleTagName = ROLE_TAG[role];
    if (roleTagName && contactId) {
      if (!cachedRoleTagIds[role]) {
        cachedRoleTagIds[role] = await findOrCreateTag(
          base, headers, roleTagName, 'Platform Waitlist sign-up — ' + roleLabel
        );
      }
      const roleTagId = cachedRoleTagIds[role];
      if (roleTagId) {
        await fetch(base + '/api/3/contactTags', {
          method: 'POST', headers,
          body: JSON.stringify({ contactTag: { contact: contactId, tag: roleTagId } })
        });
      }
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Platform waitlist error:', err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  }
};
