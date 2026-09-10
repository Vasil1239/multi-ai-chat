const { getStore } = require('@netlify/blobs');

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

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  let json;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const raw = await res.text();
    if (!ct.includes('application/json')) throw new Error('non-json catalog');
    json = JSON.parse(raw);
  } finally {
    clearTimeout(t);
  }
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

// Единый helper: всегда JSON + Content-Type
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
function json(statusCode, payload) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

// Безопасное чтение ответа fetch: если сервер вернул HTML/пусто — не падаем,
// а возвращаем осмысленный объект с текстом ошибки, чтобы клиент увидел JSON.
async function safeReadJson(res) {
  const raw = await res.text();
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!raw) return { ok: false, data: null, error: `Пустой ответ провайдера (HTTP ${res.status})` };
  if (ct.includes('application/json')) {
    try { return { ok: true, data: JSON.parse(raw) }; }
    catch (e) { return { ok: false, data: null, error: 'Провайдер вернул повреждённый JSON' }; }
  }
  // Не-JSON ответ (обычно HTML-страница ошибки CDN/провайдера)
  try { return { ok: true, data: JSON.parse(raw) }; }
  catch (_) {
    const snippet = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    return { ok: false, data: null, error: `Провайдер вернул не JSON (HTTP ${res.status}): ${snippet || 'нет тела'}` };
  }
}

// Fetch с таймаутом — чтобы функция не висла до таймаута Netlify (26с)
// и всегда возвращала JSON, а не HTML-заглушку от платформы.
async function fetchWithTimeout(url, options = {}, timeoutMs = 22000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }

    if (!checkAccessCode(event)) {
      return json(401, { error: 'invalid_access_code' });
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return json(400, { error: 'Некорректный JSON в запросе' });
    }

    const { user, model, messages } = body;
    if (!user || !model || !Array.isArray(messages)) {
      return json(400, { error: 'Нужны user, model и messages' });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { error: 'OPENROUTER_API_KEY не настроен в Netlify' });
    }

    const store = openStore('credits');
    let record = await store.get(user, { type: 'json' });
    if (!record) {
      record = { credits: FREE_STARTING_CREDITS };
      await store.setJSON(user, record);
    }

    // Каталог моделей — не критичен: если OpenRouter отвалился, считаем модель бесплатной
    // только если id заканчивается на ":free", иначе не блокируем запрос.
    let free = new Set(), pricing = new Map();
    try {
      const catalog = await getCatalog();
      free = catalog.free;
      pricing = catalog.pricing;
    } catch (e) {
      console.warn('Не удалось загрузить каталог моделей:', e.message);
    }
    const isFree = free.has(model) || /:free$/i.test(model);

    if (!isFree && record.credits < MIN_CREDITS_PER_MESSAGE) {
      return json(402, { error: 'insufficient_credits', credits: record.credits });
    }

    let res;
    try {
      res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.URL || 'https://askhub.net',
          'X-Title': 'AskHub'
        },
        body: JSON.stringify({ model, messages })
      }, 22000);
    } catch (e) {
      const msg = e.name === 'AbortError'
        ? 'Модель отвечала слишком долго. Попробуйте другой вопрос или другую модель.'
        : ('Сеть недоступна: ' + e.message);
      return json(504, { error: msg });
    }

    const parsed = await safeReadJson(res);
    if (!parsed.ok) {
      return json(res.status >= 400 ? res.status : 502, { error: parsed.error });
    }
    const data = parsed.data;

    if (!res.ok) {
      const msg = (data && (data.error?.message || data.error || data.message)) || `Ошибка провайдера (HTTP ${res.status})`;
      return json(res.status, { error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
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

    return json(200, { text, credits: record.credits, isFree, routedModel, creditsCharged });
  } catch (e) {
    console.error('chat.js unhandled error:', e);
    return json(500, { error: 'Внутренняя ошибка: ' + (e.message || 'unknown') });
  }
};
