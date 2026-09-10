const { getStore } = require('@netlify/blobs');
const { getPlusStatus, SESSION_MSG_LIMIT_FREE } = require('./_shared');

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


const FREE_STARTING_CREDITS = 20;
const CREDIT_VALUE_USD = 0.0001; // 1 кредит = $0.0001 реальной стоимости OpenRouter. Пользователь покупает кредит за $0.001 → маржа ×10
const MIN_CREDITS_PER_MESSAGE = 1; // минимум для любой платной модели, даже если токенов было мало

// Кэш каталога моделей на время жизни функции (сбрасывается раз в 10 минут)
let catalogCache = { free: null, pricing: null, ts: 0 };

async function getCatalog() {
  const now = Date.now();
  if (catalogCache.free && now - catalogCache.ts < 10 * 60 * 1000) return catalogCache;

  const res = await fetch('https://openrouter.ai/api/v1/models');
  const json = await res.json();
  const free = new Set();
  const pricing = new Map(); // id -> { prompt: $/токен, completion: $/токен }

  (json.data || []).forEach((m) => {
    const p = parseFloat(m.pricing?.prompt || '0');
    const c = parseFloat(m.pricing?.completion || '0');
    pricing.set(m.id, { prompt: p, completion: c });
    if (p === 0 && c === 0) free.add(m.id);
  });
  free.add('openrouter/free');

  catalogCache = { free, pricing, ts: now };
  return catalogCache;
}

function checkAccessCode(event) {
  const required = process.env.SITE_ACCESS_CODE;
  if (!required) return true; // защита не включена — пропускаем всех
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

  // Session message limit for free users (client-reported counter). Plus users are unlimited.
  const sessionCount = parseInt(event.headers['x-session-msg-count'] || event.headers['X-Session-Msg-Count'] || '0', 10);
  const userForPlus = (() => { try { return (JSON.parse(event.body || '{}').user || '').trim().toLowerCase(); } catch { return ''; } })();
  const plusStatus = userForPlus ? await getPlusStatus(userForPlus) : { plus: false };
  if (!plusStatus.plus && sessionCount >= SESSION_MSG_LIMIT_FREE) {
    return {
      statusCode: 429,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'session_limit',
        limit: SESSION_MSG_LIMIT_FREE,
        message: `Лимит ${SESSION_MSG_LIMIT_FREE} запросов в сессии. Откройте новый проект или оформите AskHub Plus.`
      })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Некорректный JSON' }) };
  }

  const { user, model, messages } = body;
  if (!user || !model || !Array.isArray(messages)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Нужны user, model и messages' }) };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'OPENROUTER_API_KEY не настроен в Netlify' }) };
  }

  const store = openStore('credits');
  let record = await store.get(user, { type: 'json' });
  if (!record) {
    record = { credits: FREE_STARTING_CREDITS };
    await store.setJSON(user, record);
  }

  const { free, pricing } = await getCatalog();
  const isFree = free.has(model);

  // Предварительная проверка: не пускаем с нулевым/отрицательным балансом на платную модель.
  // Точная стоимость (которая может быть чуть выше 1 кредита для дорогих моделей) спишется после ответа.
  if (!isFree && record.credits < MIN_CREDITS_PER_MESSAGE) {
    return {
      statusCode: 402,
      body: JSON.stringify({ error: 'insufficient_credits', credits: record.credits })
    };
  }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.URL || 'https://netlify.app',
        'X-Title': 'Multi AI Chat'
      },
      body: JSON.stringify({ model, messages })
    });
    const data = await res.json();

    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.error?.message || 'Ошибка запроса к модели' }) };
    }

    let creditsCharged = 0;
    if (!isFree) {
      const routedId = data.model || model;
      const price = pricing.get(routedId) || pricing.get(model) || { prompt: 0, completion: 0 };
      const usage = data.usage || {};
      const costUsd =
        (usage.prompt_tokens || 0) * price.prompt +
        (usage.completion_tokens || 0) * price.completion;
      creditsCharged = Math.max(MIN_CREDITS_PER_MESSAGE, Math.ceil(costUsd / CREDIT_VALUE_USD));
      record.credits -= creditsCharged;
      await store.setJSON(user, record);
    }

    const text = data.choices?.[0]?.message?.content || '';
    const routedModel = data.model || model;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, credits: record.credits, isFree, routedModel, creditsCharged })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
