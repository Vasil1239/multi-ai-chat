const { getCredits, saveCredits } = require('./_store');

const CREDIT_VALUE_USD = 0.0001; // 1 кредит = $0.0001 реальной стоимости OpenRouter. Пользователь покупает кредит за $0.001 → маржа ×10
const MIN_CREDITS_PER_MESSAGE = 1; // минимум для любой платной модели, даже если токенов было мало
const FREE_MSG_PER_DAY = 30;       // сколько сообщений на free-моделях можно в сутки бесплатно

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

    let record = await getCredits(user);

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

    // Дневной счётчик free-сообщений — сбрасывается на новом UTC-дне
    const todayKey = new Date().toISOString().slice(0, 10);
    if (!record.free_day || record.free_day !== todayKey) {
      record.free_day = todayKey;
      record.free_used_today = 0;
    }
    const freeUsedToday = record.free_used_today || 0;
    const freeLeftToday = Math.max(0, FREE_MSG_PER_DAY - freeUsedToday);

    if (isFree && freeLeftToday <= 0) {
      return json(402, {
        error: 'free_quota_exhausted',
        credits: record.credits,
        freeLeftToday: 0,
        freeQuotaDaily: FREE_MSG_PER_DAY,
        message: `Бесплатных сообщений на сегодня не осталось (${FREE_MSG_PER_DAY}/сутки). Переключитесь на платную модель или подождите до полуночи UTC.`,
      });
    }

    if (!isFree && record.credits < MIN_CREDITS_PER_MESSAGE) {
      return json(402, { error: 'insufficient_credits', credits: record.credits, freeLeftToday, freeQuotaDaily: FREE_MSG_PER_DAY });
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
    let newFreeUsed = freeUsedToday;
    if (isFree) {
      newFreeUsed = freeUsedToday + 1;
      record = await saveCredits(user, {
        credits: record.credits,
        free_day: todayKey,
        free_used_today: newFreeUsed,
      });
    } else {
      const routedId = data.model || model;
      const price = pricing.get(routedId) || pricing.get(model) || { prompt: 0, completion: 0 };
      const usage = data.usage || {};
      const costUsd =
        (usage.prompt_tokens || 0) * price.prompt +
        (usage.completion_tokens || 0) * price.completion;
      creditsCharged = Math.max(MIN_CREDITS_PER_MESSAGE, Math.ceil(costUsd / CREDIT_VALUE_USD));
      record = await saveCredits(user, { credits: record.credits - creditsCharged });
    }

    const text = data.choices?.[0]?.message?.content || '';
    const routedModel = data.model || model;

    return json(200, {
      text,
      credits: record.credits,
      isFree,
      routedModel,
      creditsCharged,
      freeLeftToday: Math.max(0, FREE_MSG_PER_DAY - newFreeUsed),
      freeQuotaDaily: FREE_MSG_PER_DAY,
    });
  } catch (e) {
    console.error('chat.js unhandled error:', e);
    return json(500, { error: 'Внутренняя ошибка: ' + (e.message || 'unknown') });
  }
};
