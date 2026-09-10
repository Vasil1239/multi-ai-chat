const Stripe = require('stripe');

const PACKS = {
  pack_s: { credits: 100, amount: 500, label: '100 кредитов' },   // $5
  pack_m: { credits: 550, amount: 2000, label: '550 кредитов' },  // $20 (бонус за объём)
  pack_l: { credits: 1500, amount: 5000, label: '1500 кредитов' } // $50
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
