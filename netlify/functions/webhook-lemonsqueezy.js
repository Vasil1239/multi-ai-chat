// LemonSqueezy Webhook — приём order_created и начисление кредитов.
// Подпись: X-Signature = HMAC-SHA256(raw_body, LEMONSQUEEZY_WEBHOOK_SECRET).hex()
// https://docs.lemonsqueezy.com/help/webhooks
//
// Env:
//   LEMONSQUEEZY_WEBHOOK_SECRET — задаётся при создании webhook в LS Dashboard

const crypto = require('crypto');
const { getCredits, saveCredits, payReferralBonusIfEligible } = require('./_store');
const { logEvent } = require('./_analytics');

function verifyLsSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(header, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) {
    return false;
  }
}

exports.handler = async function (event) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) return { statusCode: 500, body: 'LEMONSQUEEZY_WEBHOOK_SECRET not configured' };

  const sig = event.headers['x-signature'] || event.headers['X-Signature'];
  const rawBody = event.body || '';

  if (!verifyLsSignature(rawBody, sig, secret)) {
    return { statusCode: 400, body: 'Invalid LemonSqueezy signature' };
  }

  let ev;
  try { ev = JSON.parse(rawBody); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  // LS кладёт тип в meta.event_name, кастомные поля — в meta.custom_data
  const meta = ev.meta || {};
  const type = meta.event_name;

  // Кредиты начисляем только по order_created (успешная оплата) или subscription_payment_success
  if (type !== 'order_created' && type !== 'subscription_payment_success') {
    return { statusCode: 200, body: JSON.stringify({ ignored: type }) };
  }

  const custom = meta.custom_data || {};
  const user = custom.user_email;
  const credits = parseInt(custom.credits || '0', 10);

  if (!user || !credits) {
    return {
      statusCode: 200,
      body: JSON.stringify({ error: 'no user/credits in custom_data', event: type })
    };
  }

  const rec = await getCredits(user);
  await saveCredits(user, { credits: (rec.credits || 0) + credits });

  let referralPayout = null;
  try { referralPayout = await payReferralBonusIfEligible(user); }
  catch (e) { console.warn('referral payout failed:', e.message); }

  // Сумма в USD из data.attributes.total (в центах)
  let amountUsd = 0;
  try {
    const attrs = (ev.data && ev.data.attributes) || {};
    if (attrs.total != null) amountUsd = parseInt(attrs.total, 10) / 100;
  } catch (_) {}

  logEvent({
    user_email: user,
    kind: 'topup',
    model: custom.pack || null,
    credits_charged: credits,
    cost_usd: amountUsd * 0.05 + 0.50, // LS комиссия 5% + $0.50
    revenue_usd: amountUsd,
    meta: {
      provider: 'lemonsqueezy',
      order_id: ev.data && ev.data.id,
      referral_payout: referralPayout,
    },
  }).catch(() => {});

  return { statusCode: 200, body: JSON.stringify({ received: true, credits_added: credits }) };
};
