// api/subscribe.js  —  Sanctum Journal newsletter sign-up handler (Vercel serverless function)
// Runs automatically at  https://sanctumconcierge.com/api/subscribe  once pushed to the repo.
//
// Uses the SAME environment variables you already set for the enquiry function, so there is
// nothing new to add in Vercel for the AC/Resend side:
//   AC_API_URL              — your ActiveCampaign API URL
//   AC_API_KEY               — your ActiveCampaign API key
//   RESEND_API_KEY           — your Resend API key (sends you the new-subscriber alert)
//   TURNSTILE_SECRET_JOURNAL — the secret for the Journal Turnstile widget (its own sitekey +
//                              secret, separate from the enquiry form's). Falls back to
//                              TURNSTILE_SECRET if the second widget hasn't been created yet.
//
// WHAT IT DOES, in order:
//   1. Basic spam check (honeypot).
//   2. Turnstile check against the Journal widget's own secret.
//   3. Creates or updates the contact in ActiveCampaign.
//   4. Subscribes the contact to the Master Contact List. IMPORTANT: ActiveCampaign will
//      NOT send an automated email to a contact with zero list subscriptions, even if a
//      tag-based automation trigger fires correctly. This step exists purely to satisfy
//      that requirement — it does NOT mean the contact receives general marketing; the
//      tag below is still what actually controls who receives what content.
//   5. Applies the "Sanctum Journal" tag (this is what your AC automation should trigger on).
//   6. If the visitor also ticked the second, optional checkbox, applies the
//      "TGS General Updates" tag too — a SEPARATE, broader marketing consent, not the Journal.
//   7. Emails you an alert via Resend.
//
// WHO SENDS THE CONFIRMATION:
//   The "You're on the list" email to the SUBSCRIBER is sent by YOUR ActiveCampaign
//   automation, triggered off the "Sanctum Journal" tag being added.
//
// ONE THING TO CONFIRM:
//   LIST_NAME, TAG_NAME, and GENERAL_TAG_NAME must exactly match the list/tag names in
//   ActiveCampaign (tags will be created fresh if missing; the list will NOT be created —
//   it must already exist under this exact name, or the subscribe step will be skipped).

// ---------- CONFIG ----------
const LIST_NAME        = 'Master Contact List';   // <-- must match your ActiveCampaign list name exactly
const TAG_NAME         = 'Sanctum Journal';       // <-- tag applied on every signup
const GENERAL_TAG_NAME = 'TGS General Updates';   // <-- applied ONLY if the second checkbox is ticked

const TEAM_EMAIL = 'hello@theglobalsanctum.com';
const FROM_EMAIL = 'Sanctum Journal <concierge@theglobalsanctum.com>';  // must be on your Resend-verified domain
// ----------------------------

let cachedListId = null;
let cachedTagId = null;
let cachedGeneralTagId = null;

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
    console.error('Subscriber alert email failed (sign-up still saved):', e);
  }
}

// Find a tag by exact name (creating it if missing), returning its id.
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { email = '', company = '', token = '', generalMarketing = false } = req.body || {};

    // 1) Honeypot: real people leave this empty. If it's filled, pretend success and stop.
    if (company) { res.status(200).json({ ok: true }); return; }

    // Basic email sanity check
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: 'A valid email is required.' });
      return;
    }

    // 2) Turnstile check — verifies against the Journal widget's own secret.
    const turnstileSecret = process.env.TURNSTILE_SECRET_JOURNAL || process.env.TURNSTILE_SECRET;
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

    // Alert you straight away (before the AC calls) so you never miss a sign-up
    await sendTeamAlert({
      subject: 'New Sanctum Journal subscriber',
      text: 'Email: ' + email + (generalMarketing ? '\n(also opted into general TGS updates)' : ''),
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

    // 5) Apply the "Sanctum Journal" tag — this is what your AC automation should trigger on
    const tagId = await findOrCreateTag(
      base, headers, TAG_NAME, 'Sanctum Journal newsletter sign-up',
      () => cachedTagId, (id) => { cachedTagId = id; }
    );
    if (contactId && tagId) {
      await fetch(base + '/api/3/contactTags', {
        method: 'POST', headers,
        body: JSON.stringify({ contactTag: { contact: contactId, tag: tagId } })
      });
    }

    // 6) If they also ticked the second, optional checkbox, apply the SEPARATE
    //    "TGS General Updates" tag. This is a broader marketing consent, distinct
    //    from the Journal — ticking this does NOT subscribe them to the Journal,
    //    and vice versa.
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
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  }
};
