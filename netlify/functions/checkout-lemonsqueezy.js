// LemonSqueezy Checkout — быстрая альтернатива Paddle для мирового рынка.
// MoR (Merchant of Record): LS сам платит VAT/налоги, чарджбэки, работает с 135+ странами.
// Комиссия: 5% + $0.50 за транзакцию. Payout — на IBAN сербского ИП.
//
// Env:
//   LEMONSQUEEZY_API_KEY   — Bearer, из Settings → API
//   LEMONSQUEEZY_STORE_ID  — числовой ID магазина (из URL дашборда или /stores)
//   LEMONSQUEEZY_VARIANT_PACK_S / _M / _L — variant_id для каждого пакета
//     (создаётся в Store → Products → variant; type=one-time, price = USD amount)
//
// Docs: https://docs.lemonsqueezy.com/api/checkouts/create-checkout

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

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!checkAccessCode(event)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'invalid_access_code' }) };
  }

  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  const storeId = process.env.LEMONSQUEEZY_STORE_ID;
  if (!apiKey || !storeId) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'LemonSqueezy env not configured',
        missing: {
          LEMONSQUEEZY_API_KEY: !apiKey,
          LEMONSQUEEZY_STORE_ID: !storeId
        }
      })
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Некорректный JSON' }) }; }

  const { user, pack, refCode } = body;
  const p = PACKS[pack];
  if (!user || !p) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Нужны user и корректный pack (pack_s|pack_m|pack_l)' }) };
  }

  const variantId = process.env['LEMONSQUEEZY_VARIANT_' + pack.toUpperCase()];
  if (!variantId) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'variant_id_not_set',
        detail: `Установите LEMONSQUEEZY_VARIANT_${pack.toUpperCase()} в Netlify env (создайте variant в LS Dashboard → Products)`
      })
    };
  }

  const siteUrl = process.env.URL || 'https://askhub.net';

  // LS API v1 — spec JSON:API
  const payload = {
    data: {
      type: 'checkouts',
      attributes: {
        checkout_data: {
          email: user,
          custom: {
            user_email: user,
            credits: String(p.credits),
            pack,
            ref_code: String(refCode || 'none'),
            source: 'askhub_web'
          }
        },
        product_options: {
          name: p.label,
          description: `Пополнение баланса AskHub на ${p.credits.toLocaleString('ru-RU')} кредитов`,
          redirect_url: siteUrl + '/?paid=success',
          receipt_button_text: 'Вернуться в AskHub',
          receipt_link_url: siteUrl,
          receipt_thank_you_note: 'Спасибо! Кредиты уже начислены на ваш аккаунт.'
        },
        checkout_options: {
          embed: false,
          media: false,
          logo: true,
          desc: true,
          discount: true,
          dark: false,
          subscription_preview: false,
          button_color: '#7C3AED'
        }
      },
      relationships: {
        store:   { data: { type: 'stores',   id: String(storeId)  } },
        variant: { data: { type: 'variants', id: String(variantId) } }
      }
    }
  };

  try {
    const res = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/vnd.api+json'
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
        body: JSON.stringify({ error: 'lemonsqueezy_error', details: data })
      };
    }

    const checkoutUrl = data && data.data && data.data.attributes && data.data.attributes.url;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'lemonsqueezy',
        checkout_id: data && data.data && data.data.id,
        checkout_url: checkoutUrl
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
