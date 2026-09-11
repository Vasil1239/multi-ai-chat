const Stripe = require('stripe');
const { getCredits, saveCredits, payReferralBonusIfEligible } = require('./_store');
const { logEvent } = require('./_analytics');

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
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (e) {
    return { statusCode: 400, body: 'Webhook signature verification failed: ' + e.message };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const user = session.metadata && session.metadata.user;
    const credits = parseInt((session.metadata && session.metadata.credits) || '0', 10);

    if (user && credits > 0) {
      // Начисляем оплаченные кредиты в Supabase (единый источник правды)
      const rec = await getCredits(user);
      await saveCredits(user, { credits: (rec.credits || 0) + credits });

      // Реферальная выплата пригласившему — только после ПЕРВОЙ оплаты приглашённого
      let referralPayout = null;
      try { referralPayout = await payReferralBonusIfEligible(user); } catch (e) { console.warn('referral payout failed:', e.message); }

      const amount = (session.amount_total || 0) / 100;
      logEvent({
        user_email: user,
        kind: 'topup',
        model: session.metadata?.pack || null,
        credits_charged: credits,
        cost_usd: amount * 0.029 + 0.30,
        revenue_usd: amount,
        meta: {
          session_id: session.id,
          currency: session.currency,
          referral_payout: referralPayout, // { inviterEmail, bonus } | null
        },
      }).catch(() => {});
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
