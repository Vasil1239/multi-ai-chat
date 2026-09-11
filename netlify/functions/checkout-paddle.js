// Paddle Checkout — создание транзакции для пользователей вне СНГ.
// Цены и кредиты синхронизированы с create-checkout.js (Stripe legacy) и позднее checkout-yookassa.js.
// Маржа +150% сохранена (себестоимость → продажа). Валюта USD по умолчанию, Paddle сам конвертирует под страну.
//
// Env: PADDLE_API_KEY (Bearer). Окружение (sandbox/production) определяется
// автоматически по префиксу ключа: pdl_sdbx_* → sandbox, pdl_prd_* → production.
// Env для маппинга price_id → creds: PADDLE_PRICE_PACK_S/M/L
// Fallback: если price IDs не заданы — используем price_data через inline items

const PACKS = {
  pack_s: { credits: 5000,  amount: '5.00',  label: '5 000 кредитов AskHub' },
  pack_m: { credits: 20000, amount: '20.00', label: '20 000 кредитов AskHub' },
  pack_l: { credits: 50000, amount: '50.00', label: '50 000 кредитов AskHub' }
};

function checkAccessCode(event) {
  const required = process.env.SITE_ACCESS_CODE;
  if (!required) return true;
  const provided = event.headers['x-access-code'] || event.headers['X-Access-Code'];
  return provided === required;
}

function paddleBase(apiKey) {
  // Sandbox ключи начинаются с pdl_sdbx_, production — с pdl_prd_ (или пусто = production по умолчанию)
  const isSandbox = (apiKey || '').startsWith('pdl_sdbx_');
  return isSandbox
    ? 'https://sandbox-api.paddle.com'
    : 'https://api.paddle.com';
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!checkAccessCode(event)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'invalid_access_code' }) };
  }

  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'PADDLE_API_KEY не настроен в Netlify' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Некорректный JSON' }) }; }

  const { user, pack, refCode } = body;
  const p = PACKS[pack];
  if (!user || !p) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Нужны user и корректный pack (pack_s|pack_m|pack_l)' }) };
  }

  const siteUrl = process.env.URL || 'https://askhub.net';

  // Пытаемся использовать заранее созданный price_id (быстрее, отчётность красивее в Paddle Dashboard)
  const priceIdEnv = process.env['PADDLE_PRICE_' + pack.toUpperCase()];

  const items = priceIdEnv
    ? [{ price_id: priceIdEnv, quantity: 1 }]
    : [{
        quantity: 1,
        price: {
          description: p.label,
          name: p.label,
          unit_price: { currency_code: 'USD', amount: String(Math.round(parseFloat(p.amount) * 100)) },
          product: {
            name: p.label,
            // 'standard' — единственная auto-approved категория. Для production
            // рекомендуется 'saas' или 'digital-goods' (требуют approval через Paddle).
            tax_category: 'standard'
          }
        }
      }];

  const payload = {
    items,
    customer: { email: user },
    custom_data: {
      user_email: user,
      credits: String(p.credits),
      pack,
      ref_code: refCode || null,
      source: 'askhub_web'
    },
    checkout: {
      url: siteUrl + '/?paid=success'
    },
    collection_mode: 'automatic',
    billing_details: null,
    currency_code: 'USD'
  };

  try {
    const res = await fetch(paddleBase(apiKey) + '/transactions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Paddle-Version': '1'
      },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'paddle_error', details: data })
      };
    }

    // Paddle возвращает transaction, из которой строим checkout URL:
    // либо через inline sdk (client-side token), либо через hosted checkout ссылку.
    const tx = data && data.data;
    const checkoutUrl = tx && tx.checkout && tx.checkout.url;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transaction_id: tx && tx.id,
        checkout_url: checkoutUrl,
        // альтернативно клиент может использовать Paddle.Checkout.open({ transactionId })
        client_token: process.env.PADDLE_CLIENT_TOKEN || null
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
