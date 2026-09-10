// POST /api/plus-bot  — Telegram webhook for @askhub_plus_bot
//
// Flow:
//   1. User clicks "Get Plus" on site → https://t.me/askhub_plus_bot?start=<hash>
//   2. Bot receives /start <hash>, asks for email + plan
//   3. Bot sends Telegram Stars invoice (XTR currency)
//   4. On successful pre_checkout_query → OK
//   5. On successful_payment → activate Plus in 'plus' Blob store
//
// Auth of webhook: Telegram sends a secret_token header we set at setWebhook time.
//   header 'x-telegram-bot-api-secret-token' must match env PLUS_BOT_WEBHOOK_SECRET.
//
// Required env vars:
//   PLUS_BOT_TOKEN                      — from BotFather
//   PLUS_BOT_WEBHOOK_SECRET             — random string, set at setWebhook
//   PLUS_LINK_SALT                      — same as site (HMAC salt)
//   PLUS_PRICE_MONTHLY_STARS (default 200)
//   PLUS_PRICE_YEARLY_STARS  (default 2000)

const { openStore, emailToken } = require('./_shared');

const TG = 'https://api.telegram.org';

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
function ok() { return { statusCode: 200, body: 'ok' }; }

async function tg(method, payload) {
  const token = process.env.PLUS_BOT_TOKEN;
  if (!token) throw new Error('PLUS_BOT_TOKEN missing');
  const r = await fetch(`${TG}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.warn('TG', method, 'failed:', j);
  return j;
}

function addDays(iso, days) {
  const d = iso ? new Date(iso) : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// Simple per-user session store (Blobs)
async function getSession(userId) {
  const s = openStore('plus_bot_sessions');
  return (await s.get(String(userId), { type: 'json' })) || {};
}
async function setSession(userId, patch) {
  const s = openStore('plus_bot_sessions');
  const prev = await getSession(userId);
  const next = { ...prev, ...patch, updated_at: new Date().toISOString() };
  await s.setJSON(String(userId), next);
  return next;
}

async function activatePlus({ email, plan, telegramUserId, chargeId, linkToken }) {
  const key = email.trim().toLowerCase();
  const store = openStore('plus');
  const prev = (await store.get(key, { type: 'json' })) || {};
  const days = plan === 'yearly' ? 365 : 30;
  const from = prev.plus_until && Date.parse(prev.plus_until) > Date.now() ? prev.plus_until : null;
  const next = addDays(from, days);
  const rec = {
    plus_until: next,
    plan,
    last_telegram_user_id: telegramUserId || null,
    last_charge_id: chargeId || null,
    link_token: linkToken || emailToken(key),
    updated_at: new Date().toISOString(),
    history: [...(prev.history || []), { plan, days, charge_id: chargeId, at: new Date().toISOString() }].slice(-20)
  };
  await store.setJSON(key, rec);
  return rec;
}

function priceStars(plan) {
  if (plan === 'yearly') return Number(process.env.PLUS_PRICE_YEARLY_STARS || 2000);
  return Number(process.env.PLUS_PRICE_MONTHLY_STARS || 200);
}

function planLabel(plan) {
  return plan === 'yearly' ? 'AskHub Plus — Год' : 'AskHub Plus — Месяц';
}

function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());
}

async function handleStart(chat, args) {
  const linkToken = (args || '').trim();
  await setSession(chat.id, { step: 'await_email', link_token: linkToken || null });
  const greet =
    'Привет — это подписка AskHub Plus.\n\n' +
    'История чатов, боковая панель с поиском, снятие лимита сессии, +5000 кредитов/мес.\n\n' +
    'Отправьте ваш email, которым вы пользуетесь на askhub-beta.netlify.app (или askhub.net).';
  await tg('sendMessage', { chat_id: chat.id, text: greet });
}

async function askPlan(chat) {
  await tg('sendMessage', {
    chat_id: chat.id,
    text: 'Выберите план:',
    reply_markup: {
      inline_keyboard: [
        [{ text: `Месяц — ${priceStars('monthly')} ⭐`, callback_data: 'plan:monthly' }],
        [{ text: `Год — ${priceStars('yearly')} ⭐ (экономия)`,   callback_data: 'plan:yearly' }]
      ]
    }
  });
}

async function sendInvoice(chat, plan) {
  const sess = await getSession(chat.id);
  const email = sess.email;
  if (!email) return tg('sendMessage', { chat_id: chat.id, text: 'Сначала отправьте email.' });
  const stars = priceStars(plan);
  // Attach email + plan into payload so we can restore on successful_payment
  const payload = JSON.stringify({ email, plan, link_token: sess.link_token || emailToken(email) });
  await tg('sendInvoice', {
    chat_id: chat.id,
    title: planLabel(plan),
    description: `Активация Plus для ${email}. Один клик — сохранённая история, поиск, снятие лимита.`,
    payload,
    provider_token: '',        // empty for Telegram Stars (XTR)
    currency: 'XTR',
    prices: [{ label: planLabel(plan), amount: stars }],
    start_parameter: 'plus'
  });
}

async function handleMessage(msg) {
  const chat = msg.chat;
  const text = (msg.text || '').trim();

  // Successful payment notification arrives as msg.successful_payment
  if (msg.successful_payment) {
    const sp = msg.successful_payment;
    let payload = {};
    try { payload = JSON.parse(sp.invoice_payload || '{}'); } catch {}
    const email = payload.email;
    const plan  = payload.plan || 'monthly';
    if (!email) {
      await tg('sendMessage', { chat_id: chat.id, text: 'Оплата получена, но не нашёл email в payload. Напишите email — активирую вручную.' });
      return;
    }
    const rec = await activatePlus({
      email, plan,
      telegramUserId: msg.from && msg.from.id,
      chargeId: sp.telegram_payment_charge_id,
      linkToken: payload.link_token
    });
    await setSession(chat.id, { step: 'done', last_charge_id: sp.telegram_payment_charge_id });
    await tg('sendMessage', {
      chat_id: chat.id,
      text: `✅ Plus активирован для ${email} до ${rec.plus_until.slice(0,10)}.\n\nОткройте сайт — история включится сразу.`
    });
    return;
  }

  // /start [hash]
  if (text.startsWith('/start')) {
    const args = text.slice(6).trim();
    await handleStart(chat, args);
    return;
  }

  if (text === '/status') {
    const sess = await getSession(chat.id);
    if (!sess.email) return tg('sendMessage', { chat_id: chat.id, text: 'Не привязан email. /start' });
    const store = openStore('plus');
    const rec = await store.get(sess.email.toLowerCase(), { type: 'json' });
    if (!rec) return tg('sendMessage', { chat_id: chat.id, text: 'Plus не активен для ' + sess.email });
    return tg('sendMessage', {
      chat_id: chat.id,
      text: `Email: ${sess.email}\nPlus до: ${rec.plus_until}\nПлан: ${rec.plan}`
    });
  }

  // Flow: awaiting email
  const sess = await getSession(chat.id);
  if (sess.step === 'await_email') {
    if (!validEmail(text)) {
      return tg('sendMessage', { chat_id: chat.id, text: 'Похоже, это не email. Введите ваш email:' });
    }
    await setSession(chat.id, { email: text.toLowerCase(), step: 'await_plan' });
    await tg('sendMessage', { chat_id: chat.id, text: `Email принят: ${text}` });
    return askPlan(chat);
  }

  // Fallback
  return tg('sendMessage', {
    chat_id: chat.id,
    text: 'Команды: /start — начать, /status — проверить подписку.'
  });
}

async function handleCallback(cb) {
  const chat = cb.message && cb.message.chat;
  const data = cb.data || '';
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  if (data.startsWith('plan:')) {
    const plan = data.slice(5);
    if (plan !== 'monthly' && plan !== 'yearly') return;
    return sendInvoice(chat, plan);
  }
}

async function handlePreCheckout(pcq) {
  // Basic validation of payload
  let payload = {};
  try { payload = JSON.parse(pcq.invoice_payload || '{}'); } catch {}
  const okFlag = Boolean(payload.email && payload.plan);
  return tg('answerPreCheckoutQuery', {
    pre_checkout_query_id: pcq.id,
    ok: okFlag,
    error_message: okFlag ? undefined : 'Некорректная сессия оплаты. Начните заново: /start'
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return ok();

  // Telegram secret header check
  const expected = process.env.PLUS_BOT_WEBHOOK_SECRET;
  if (expected) {
    const got = event.headers['x-telegram-bot-api-secret-token'] || event.headers['X-Telegram-Bot-Api-Secret-Token'];
    if (got !== expected) return json(401, { error: 'bad_secret' });
  }

  let update;
  try { update = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }

  try {
    if (update.message)            await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.pre_checkout_query) await handlePreCheckout(update.pre_checkout_query);
    // Ignore everything else silently
  } catch (e) {
    console.error('plus-bot error', e);
  }
  return ok();
};
