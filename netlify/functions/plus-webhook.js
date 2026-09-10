// POST /api/plus-webhook — called by our Telegram bot after successful Stars payment.
// Auth: header X-Plus-Secret must match env PLUS_WEBHOOK_SECRET.
// Body: { link_token, plan: "monthly"|"yearly", telegram_user_id, charge_id }
//
// We can't reverse link_token → email (it's a HMAC hash), so we store the token itself
// and the site-side plus-status lookup will compute the same token and match.
//
// The 'plus' store is keyed by email though — so the bot flow needs to know email.
// Simpler approach: bot sends {email, plan}; site never exposes emails to bot, but
// the user re-enters their site email during /start conversation. Alternatively,
// site sends email inside link_token payload (encrypted). For MVP we accept both.

const { openStore, emailToken } = require('./_shared');

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function addDays(iso, days) {
  const d = iso ? new Date(iso) : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  const secret = event.headers['x-plus-secret'] || event.headers['X-Plus-Secret'];
  if (!secret || secret !== process.env.PLUS_WEBHOOK_SECRET) {
    return json(401, { error: 'unauthorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }
  const { email, plan = 'monthly', telegram_user_id, charge_id, link_token } = body;
  if (!email) return json(400, { error: 'email required' });

  // Optional: verify link_token matches the email (prevents cross-account activation)
  if (link_token && link_token !== emailToken(email)) {
    return json(400, { error: 'token_mismatch' });
  }

  const days = plan === 'yearly' ? 365 : 30;
  const store = openStore('plus');
  const key = email.trim().toLowerCase();
  const prev = (await store.get(key, { type: 'json' })) || {};
  const from = prev.plus_until && Date.parse(prev.plus_until) > Date.now() ? prev.plus_until : null;
  const next = addDays(from, days);
  const rec = {
    plus_until: next,
    plan,
    last_telegram_user_id: telegram_user_id || null,
    last_charge_id: charge_id || null,
    updated_at: new Date().toISOString(),
    history: [...(prev.history || []), { plan, days, charge_id, at: new Date().toISOString() }].slice(-20)
  };
  await store.setJSON(key, rec);
  return json(200, { ok: true, plus_until: next });
};
