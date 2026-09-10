const Stripe = require('stripe');

// Наценка: 1 кредит = $0.001 для покупателя (в 10 раз дороже реальной себестоимости OpenRouter).
// amount указан в центах для Stripe.
const PACKS = {
  pack_s: { credits: 5000,  amount: 500,  label: '5 000 кредитов' },    // $5   (base)
  pack_m: { credits: 22000, amount: 2000, label: '22 000 кредитов' },   // $20  (+10% бонус)
  pack_l: { credits: 60000, amount: 5000, label: '60 000 кредитов' }    // $50  (+20% бонус)
};

function checkAccessCode(event) {
  const required = process.env.SITE_ACCESS_CODE;
  if (!required) return true;
  const provided = event.headers['x-access-code'] || event.headers['X-Access-Code'];
  return provided === required;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!checkAccessCode(event)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'invalid_access_code' }) };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'STRIPE_SECRET_KEY не настроен в Netlify' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Некорректный JSON' }) };
  }

  const { user, pack } = body;
  const p = PACKS[pack];
  if (!user || !p) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Нужны user и корректный pack' }) };
  }

  const stripe = Stripe(secretKey);
  const siteUrl = process.env.URL || 'https://example.netlify.app';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: p.label + ' — Multi AI Chat' },
          unit_amount: p.amount
        },
        quantity: 1
      }],
      metadata: { user, credits: String(p.credits) },
      success_url: siteUrl + '/?paid=success',
      cancel_url: siteUrl + '/?paid=cancelled'
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
