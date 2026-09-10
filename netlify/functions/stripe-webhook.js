const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');

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
      const store = getStore('credits');
      let record = await store.get(user, { type: 'json' });
      if (!record) record = { credits: 0 };
      record.credits += credits;
      await store.setJSON(user, record);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
