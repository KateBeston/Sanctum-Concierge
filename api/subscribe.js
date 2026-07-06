// api/subscribe.js  —  Sanctum Journal newsletter sign-up handler (Vercel serverless function)
// Runs automatically at  https://sanctumconcierge.com/api/subscribe  once pushed to the repo.
//
// Uses the SAME environment variables you already set for the enquiry function, so there is
// nothing new to add in Vercel for the AC/Resend side:
//   AC_API_URL              — your ActiveCampaign API URL
//   AC_API_KEY               — your ActiveCampaign API key
//   RESEND_API_KEY           — your Resend API key (sends you the new-subscriber alert)
//   TURNSTILE_SECRET_JOURNAL — the secret for the "Sanctum Concierge — Newsletter" Turnstile
//                              widget (a separate widget from the enquiry form, so it has its
//                              own sitekey + secret). Falls back to TURNSTILE_SECRET if you
//                              haven't created the second widget yet, so nothing breaks.
//
// WHAT IT DOES, in order:
//   1. Basic spam check (honeypot).
//   2. Optional Turnstile check (only if a token is sent).
//   3. Creates or updates the contact in ActiveCampaign.
//   4. Subscribes them to your Sanctum Journal list  (this is what lets AC actually SEND).
//   5. Applies the "Sanctum Journal" tag.
//   6. Emails you an alert via Resend.
//
// WHO SENDS THE CONFIRMATION:
//   The "You're on the list" email to the SUBSCRIBER is sent by YOUR ActiveCampaign
//   automation. Point that automation's trigger at EITHER of the two things this
//   function does: "subscribes to the Sanctum Journal list", OR "tag Sanctum Journal
//   is added". Whichever you choose, the automation fires. You do not need both.
//
// TWO THINGS TO CONFIRM (see the CONFIG just below):
//   • LIST_NAME must exactly match the name of your Journal list in ActiveCampaign.
//   • TAG_NAME is the tag applied on signup. Match your automation trigger to it, or to the list.

// ---------- CONFIG ----------
const LIST_NAME = 'Sanctum Journal';   // <-- must match your ActiveCampaign list name exactly
const TAG_NAME  = 'Sanctum Journal';   // <-- tag applied on signup (point your automation here, or at the list)

const TEAM_EMAIL = 'hello@theglobalsanctum.com';
const FROM_EMAIL = 'Sanctum Journal <concierge@theglobalsanctum.com>';  // must be on your Resend-verified domain
// ----------------------------

let cachedListId = null;   // remembered between requests while the function is warm
let cachedTagId  = null;

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { email = '', company = '', token = '' } = req.body || {};

    // 1) Honeypot: real people leave this empty. If it's filled, pretend success and stop.
    if (company) { res.status(200).json({ ok: true }); return; }

    // Basic email sanity check
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: 'A valid email is required.' });
      return;
    }

    // 2) Turnstile check — verifies against the Newsletter widget's own secret.
    //    Falls back to TURNSTILE_SECRET if you haven't created a separate journal
    //    widget/secret in Cloudflare yet.
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
      text: 'Email: ' + email,
      replyTo: email
    });

    // 3) Create or update the contact
    const syncRes = await fetch(base + '/api/3/contact/sync', {
      method: 'POST', headers,
      body: JSON.stringify({ contact: { email } })
    });
    const syncData = await syncRes.json();
    const contactId = syncData && syncData.contact && syncData.contact.id;

    // 4) Find the Sanctum Journal list by name, then subscribe the contact to it.
    //    AC will not SEND to a contact who is not on a list, so this unblocks the confirmation.
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

    // 5) Find the tag by name (create it if missing), then apply it
    if (!cachedTagId) {
      const r = await fetch(base + '/api/3/tags?search=' + encodeURIComponent(TAG_NAME), { headers });
      const d = await r.json();
      let tag = (d.tags || []).find(t => (t.tag || '').trim().toLowerCase() === TAG_NAME.toLowerCase());
      if (!tag) {
        const cr = await fetch(base + '/api/3/tags', {
          method: 'POST', headers,
          body: JSON.stringify({ tag: { tag: TAG_NAME, tagType: 'contact', description: 'Sanctum Journal newsletter sign-up' } })
        });
        tag = (await cr.json()).tag;
      }
      cachedTagId = tag ? tag.id : null;
    }
    if (contactId && cachedTagId) {
      await fetch(base + '/api/3/contactTags', {
        method: 'POST', headers,
        body: JSON.stringify({ contactTag: { contact: contactId, tag: cachedTagId } })
      });
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  }
};
