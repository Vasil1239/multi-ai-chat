// Генерация изображений для AskHub.
// Провайдеры (в порядке приоритета, автоматический fallback):
//   1) OpenAI gpt-image-1  — если задан OPENAI_API_KEY (лучшее качество/текст)
//   2) OpenRouter image-модель (google/gemini-2.5-flash-image, black-forest-labs/flux-1.1-pro и т.п.)
//   3) Понятная человеческая ошибка, если ни один ключ не настроен.
//
// Ответ клиенту всегда JSON: { imageUrl?: string, imageB64?: string, error?: string, provider?: string, credits?: number }
// Тарификация — единая ставка за одно изображение (см. IMAGE_CREDIT_COST). Free-режим отключён (картинки всегда платные).

const { getStore } = require('@netlify/blobs');

const IMAGE_CREDIT_COST = 50; // 50 кредитов за одну картинку (~$0.005 маржа при $0.001 = 1 кредит)
const FREE_STARTING_CREDITS = 20;

const _memStore = new Map();
function memStore() {
  return {
    async get(key, opts) {
      const v = _memStore.get(key);
      if (v == null) return null;
      return (opts && opts.type === 'json') ? v : JSON.stringify(v);
    },
    async setJSON(key, value) { _memStore.set(key, value); },
  };
}
function openStore(name) {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  try {
    if (siteID && token) return getStore({ name, siteID, token, consistency: 'strong' });
    return getStore(name);
  } catch (_) {
    return memStore();
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
function json(statusCode, payload) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

function checkAccessCode(event) {
  const required = process.env.SITE_ACCESS_CODE;
  if (!required) return true;
  const provided = event.headers['x-access-code'] || event.headers['X-Access-Code'];
  return provided === required;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// -------- Провайдер 1: OpenAI gpt-image-1 --------
async function generateWithOpenAI({ prompt, size }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null; // не настроен — молча пропускаем

  const res = await fetchWithTimeout('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: size || '1024x1024',
      n: 1,
    }),
  }, 60000);

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch (_) {
    throw new Error(`OpenAI вернул не JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg = data?.error?.message || `OpenAI HTTP ${res.status}`;
    throw new Error(msg);
  }
  const item = data?.data?.[0];
  if (item?.b64_json) return { imageB64: item.b64_json, provider: 'openai:gpt-image-1' };
  if (item?.url)      return { imageUrl: item.url,      provider: 'openai:gpt-image-1' };
  throw new Error('OpenAI: пустой ответ');
}

// -------- Провайдер 2: OpenRouter image-модели --------
// Модели с генерацией картинок в OpenRouter: google/gemini-2.5-flash-image, black-forest-labs/flux-1.1-pro, etc.
async function generateWithOpenRouter({ prompt, model }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const usedModel = model || 'google/gemini-2.5-flash-image';

  const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.URL || 'https://askhub.net',
      'X-Title': 'AskHub Image',
    },
    body: JSON.stringify({
      model: usedModel,
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content: prompt }],
    }),
  }, 60000);

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch (_) {
    throw new Error(`OpenRouter вернул не JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `OpenRouter HTTP ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  // Форматов может быть несколько — вытаскиваем аккуратно:
  const msg = data?.choices?.[0]?.message;
  // 1) массив images (OpenRouter стандарт для мульти-модальных)
  const imgArr = msg?.images;
  if (Array.isArray(imgArr) && imgArr.length) {
    const first = imgArr[0];
    const url = first?.image_url?.url || first?.url || first;
    if (typeof url === 'string' && url.startsWith('data:image')) {
      const b64 = url.split(',')[1];
      return { imageB64: b64, provider: `openrouter:${usedModel}` };
    }
    if (typeof url === 'string') return { imageUrl: url, provider: `openrouter:${usedModel}` };
  }
  // 2) content массив с image_url
  if (Array.isArray(msg?.content)) {
    for (const p of msg.content) {
      if (p?.type === 'image_url' && p.image_url?.url) {
        return { imageUrl: p.image_url.url, provider: `openrouter:${usedModel}` };
      }
    }
  }
  throw new Error('OpenRouter не вернул картинку (модель может не поддерживать генерацию изображений).');
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!checkAccessCode(event))     return json(401, { error: 'invalid_access_code' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return json(400, { error: 'Некорректный JSON в запросе' }); }

    const { user, prompt, size, model } = body;
    if (!user || !prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
      return json(400, { error: 'Нужны user и prompt (минимум 3 символа)' });
    }

    // Кредиты
    const store = openStore('credits');
    let record = await store.get(user, { type: 'json' });
    if (!record) { record = { credits: FREE_STARTING_CREDITS }; await store.setJSON(user, record); }

    if (record.credits < IMAGE_CREDIT_COST) {
      return json(402, { error: 'insufficient_credits', credits: record.credits, needed: IMAGE_CREDIT_COST });
    }

    // Пробуем провайдеров по очереди
    const attempts = [];
    let result = null;

    for (const gen of [generateWithOpenAI, () => generateWithOpenRouter({ prompt, model })]) {
      try {
        const r = typeof gen === 'function'
          ? await gen({ prompt, size, model })
          : null;
        if (r) { result = r; break; }
      } catch (e) {
        attempts.push(e.message || String(e));
      }
    }

    if (!result) {
      const detail = attempts.length ? attempts.join(' | ') : 'ни один провайдер не настроен';
      return json(500, {
        error: 'Не удалось сгенерировать изображение: ' + detail +
               '. Добавьте OPENAI_API_KEY или OPENROUTER_API_KEY в переменные Netlify.'
      });
    }

    // Списываем кредиты только при успехе
    record.credits -= IMAGE_CREDIT_COST;
    await store.setJSON(user, record);

    return json(200, {
      ...result,
      credits: record.credits,
      creditsCharged: IMAGE_CREDIT_COST,
    });
  } catch (e) {
    console.error('image.js unhandled:', e);
    return json(500, { error: 'Внутренняя ошибка: ' + (e.message || 'unknown') });
  }
};
