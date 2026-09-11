// Paddle Webhook — приём transaction.completed / transaction.paid и начисление кредитов.
// Подпись проверяется через HMAC-SHA256 согласно https://developer.paddle.com/webhooks/signature-verification
//
// Env:
//   PADDLE_WEBHOOK_SECRET — из Paddle Dashboard → Developer Tools → Notifications → Endpoint secret

const crypto = require('crypto');
const { getCredits, saveCredits, payReferralBonusIfEligible } = require('./_store');
const { logEvent } = require('./_analytics');

function verifyPaddleSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  // Header format: "ts=1234567890;h1=<hex>"
  const parts = Object.fromEntries(
    header.split(';').map(kv => {
      const [k, v] = kv.split('=');
      return [k.trim(), (v || '').trim()];
    })
  );
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  const signed = `${ts}:${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(h1, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) {
    return false;
  }
}

exports.handler = async function (event) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) return { statusCode: 500, body: 'PADDLE_WEBHOOK_SECRET not configured' };

  const sigHeader = event.headers['paddle-signature'] || event.headers['Paddle-Signature'];
  const rawBody = event.body || '';

  if (!verifyPaddleSignature(rawBody, sigHeader, secret)) {
    return { statusCode: 400, body: 'Invalid Paddle signature' };
  }

  let ev;
  try { ev = JSON.parse(rawBody); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  const type = ev.event_type;
  // Начисляем только по completed/paid (окончательное успешное списание)
  if (type !== 'transaction.completed' && type !== 'transaction.paid') {
    return { statusCode: 200, body: JSON.stringify({ ignored: type }) };
  }

  const data = ev.data || {};
  const custom = (data.custom_data) || {};
  const user = custom.user_email;
  const credits = parseInt(custom.credits || '0', 10);

  if (!user || !credits) {
    return { statusCode: 200, body: JSON.stringify({ error: 'no user/credits in custom_data', tx: data.id }) };
  }

  const rec = await getCredits(user);
  await saveCredits(user, { credits: (rec.credits || 0) + credits });

  let referralPayout = null;
  try { referralPayout = await payReferralBonusIfEligible(user); }
  catch (e) { console.warn('referral payout failed:', e.message); }

  // Сумма в USD (details.totals.total — в minor units валюты счёта)
  let amountUsd = 0;
  try {
    const totals = data.details && data.details.totals;
    if (totals && totals.total) {
      // Paddle отдаёт в валюте покупателя; для внутренней аналитики берём grand_total из USD оборота
      amountUsd = parseFloat(totals.total) / 100;
    }
  } catch (_) {}

  logEvent({
    user_email: user,
    kind: 'topup',
    model: custom.pack || null,
    credits_charged: credits,
    cost_usd: amountUsd * 0.05 + 0.50, // Paddle комиссия 5% + $0.50
    revenue_usd: amountUsd,
    meta: {
      provider: 'paddle',
      transaction_id: data.id,
      currency: data.currency_code,
      referral_payout: referralPayout,
    },
  }).catch(() => {});

  return { statusCode: 200, body: JSON.stringify({ received: true, credits_added: credits }) };
};
