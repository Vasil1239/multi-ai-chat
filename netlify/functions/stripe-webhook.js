const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');
const { logEvent } = require('./_analytics');

// In-memory fallback store: используется если Netlify Blobs недоступен
const _memStore = new Map();
function memStore() {
  return {
    async get(key, opts) {
      const v = _memStore.get(key);
      if (v == null) return null;
      return (opts && opts.type === 'json') ? v : JSON.stringify(v);
    },
    async setJSON(key, value) { _memStore.set(key, value); },
    async set(key, value) { _memStore.set(key, value); },
    async delete(key) { _memStore.delete(key); },
    async list() { return { blobs: [...(_memStore.keys())].map(k => ({ key: k })) }; }
  };
}
function openStore(name) {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  try {
    if (siteID && token) return getStore({ name, siteID, token, consistency: 'strong' });
    return getStore(name);
  } catch (e) {
    console.warn('Blobs unavailable, using in-memory store:', e.message);
    return memStore();
  }
}

exports.handler = async function (event) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    return { statusCode: 500, body: 'Stripe keys not configured' };
  }

  const stripe = Stripe(secretKey);
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  let stripeEvent;
  try {
    // event.body должен быть "сырым" (не распарсенным) — Netlify Functions отдают его строкой
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (e) {
    return { statusCode: 400, body: 'Webhook signature verification failed: ' + e.message };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const user = session.metadata && session.metadata.user;
    const credits = parseInt((session.metadata && session.metadata.credits) || '0', 10);

    if (user && credits > 0) {
      const store = openStore('credits');
      let record = await store.get(user, { type: 'json' });
      if (!record) record = { credits: 0 };
      record.credits += credits;
      await store.setJSON(user, record);

      // Аналитика — выручка от Stripe (amount_total в центах)
      const amount = (session.amount_total || 0) / 100;
      logEvent({
        user_email: user,
        kind: 'topup',
        model: session.metadata?.pack || null,
        credits_charged: credits,
        cost_usd: amount * 0.029 + 0.30, // Stripe fee оценка
        revenue_usd: amount,
        meta: { session_id: session.id, currency: session.currency },
      }).catch(() => {});
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
