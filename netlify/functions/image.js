// Генерация изображений для AskHub.
// Три тарифа (все через один ключ OpenRouter — карта OpenAI не нужна):
//   quality:"standard" → google/gemini-2.5-flash-image       ~$0.04 → 50 кр (маржа 92%)
//   quality:"hd"       → google/gemini-3.1-flash-image       ~$0.06 → 150 кр (маржа 60%)
//   quality:"ultra"    → google/gemini-3-pro-image           ~$0.20 → 300 кр (маржа 33%)
//
// Fallback: если задан OPENAI_API_KEY и quality:"hd"/"ultra" с параметром provider:"openai",
// пойдём в оригинальный OpenAI gpt-image-1 (нужен пополненный баланс OpenAI).
//
// Бесплатные картинки: 3/сутки только на standard и только в первые FREE_TRIAL_DAYS от регистрации.
// HD и Ultra всегда платные.

const { getCredits, saveCredits } = require('./_store');
const { logEvent } = require('./_analytics');

// Ориентировочные цены OpenRouter за картинку
const COST_USD = { standard: 0.04, hd: 0.06, ultra: 0.20 };

const FREE_TRIAL_DAYS = 7;
const FREE_IMAGES_PER_DAY = 3;

// Цель: ≥150% чистой прибыли (выручка ≥ ×2.5 к себестоимости).
const IMAGE_COST_STANDARD = 100;  // Gemini 2.5 Flash Image  $0.04 → 100 кр = $0.10 → маржа +150%
const IMAGE_COST_HD       = 150;  // Gemini 3.1 Flash Image  $0.06 → 150 кр = $0.15 → маржа +150%
const IMAGE_COST_ULTRA    = 500;  // Gemini 3 Pro Image      $0.20 → 500 кр = $0.50 → маржа +150%

const MODEL_STANDARD = 'google/gemini-2.5-flash-image';
const MODEL_HD       = 'google/gemini-3.1-flash-image';
const MODEL_ULTRA    = 'google/gemini-3-pro-image';

function isInFreeTrialWindow(record) {
  if (!record || !record.created_at) return true;
  const daysPassed = (Date.now() - new Date(record.created_at).getTime()) / (1000 * 60 * 60 * 24);
  return daysPassed <= FREE_TRIAL_DAYS;
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// -------- OpenAI gpt-image-1 (опциональный fallback) --------
async function generateWithOpenAI({ prompt, size }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

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
  }, 90000);

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

// -------- OpenRouter (все Gemini image модели) --------
async function generateWithOpenRouter({ prompt, model }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const usedModel = model || MODEL_STANDARD;

  // Nano Banana Pro (gemini-3-pro-image) требует включённый reasoning в запросе
  const reqBody = {
    model: usedModel,
    modalities: ['image', 'text'],
    messages: [{ role: 'user', content: prompt }],
  };
  if (usedModel === MODEL_ULTRA) {
    reqBody.reasoning = { enabled: true };
  }

  const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.URL || 'https://askhub.net',
      'X-Title': 'AskHub Image',
    },
    body: JSON.stringify(reqBody),
  }, 120000);

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch (_) {
    throw new Error(`OpenRouter вернул не JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `OpenRouter HTTP ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  const msg = data?.choices?.[0]?.message;

  // Пробуем все известные поля, где разные модели кладут картинку
  const tryExtract = (raw) => {
    if (!raw) return null;
    if (typeof raw === 'string') {
      if (raw.startsWith('data:image')) return { imageB64: raw.split(',')[1] };
      if (/^https?:\/\//.test(raw)) return { imageUrl: raw };
      // Nano Banana Pro иногда возвращает чистый base64 без префикса
      if (/^[A-Za-z0-9+/=]{500,}$/.test(raw)) return { imageB64: raw };
      return null;
    }
    if (raw.image_url?.url) return tryExtract(raw.image_url.url);
    if (raw.b64_json)      return { imageB64: raw.b64_json };
    if (raw.url)           return tryExtract(raw.url);
    if (raw.image)         return tryExtract(raw.image);
    if (raw.data)          return tryExtract(raw.data);
    if (raw.source?.data)  return { imageB64: raw.source.data };
    return null;
  };

  // 1) message.images: [...]
  if (Array.isArray(msg?.images)) {
    for (const it of msg.images) {
      const e = tryExtract(it);
      if (e) return { ...e, provider: `openrouter:${usedModel}` };
    }
  }
  // 2) message.content: [...parts...] (multimodal)
  if (Array.isArray(msg?.content)) {
    for (const p of msg.content) {
      if (p?.type === 'image_url' && p.image_url?.url) {
        const e = tryExtract(p.image_url.url);
        if (e) return { ...e, provider: `openrouter:${usedModel}` };
      }
      if (p?.type === 'image' && (p.source?.data || p.image?.url)) {
        const e = tryExtract(p.source?.data ? { b64_json: p.source.data } : p.image.url);
        if (e) return { ...e, provider: `openrouter:${usedModel}` };
      }
      if (p?.type === 'output_image' && p.image_data) {
        return { imageB64: p.image_data, provider: `openrouter:${usedModel}` };
      }
    }
  }
  // 3) message.content: строка с markdown-картинкой ![](data:image...) или ![](https://...)
  if (typeof msg?.content === 'string') {
    const md = msg.content.match(/!\[[^\]]*\]\((data:image[^)]+|https?:\/\/[^)]+)\)/);
    if (md) {
      const e = tryExtract(md[1]);
      if (e) return { ...e, provider: `openrouter:${usedModel}` };
    }
    // голый base64 в тексте — как fallback
    const e = tryExtract(msg.content);
    if (e) return { ...e, provider: `openrouter:${usedModel}` };
  }

  // Для отладки: выкинем ключи ответа, чтобы видеть, где модель положила картинку
  const dump = {
    msgKeys: msg ? Object.keys(msg) : [],
    contentType: Array.isArray(msg?.content) ? 'array' : typeof msg?.content,
    contentPreview: typeof msg?.content === 'string' ? msg.content.slice(0, 200) : undefined,
    finish: data?.choices?.[0]?.finish_reason,
  };
  throw new Error('OpenRouter не вернул картинку. Debug: ' + JSON.stringify(dump));
}

function resolveTier({ quality, model }) {
  // Явные алиасы
  const q = (quality || '').toLowerCase();
  const m = (model || '').toLowerCase();

  if (q === 'ultra' || m.includes('gemini-3-pro') || m === 'nano-banana-pro') {
    return { tier: 'ultra', cost: IMAGE_COST_ULTRA, model: MODEL_ULTRA, useOpenAI: false };
  }
  if (q === 'hd' || m.includes('gemini-3.1') || m === 'nano-banana-2') {
    // hd + provider openai → пробуем OpenAI, иначе Gemini 3.1 Flash Image
    return { tier: 'hd', cost: IMAGE_COST_HD, model: MODEL_HD, useOpenAI: m === 'openai' || m === 'gpt-image-1' };
  }
  return { tier: 'standard', cost: IMAGE_COST_STANDARD, model: MODEL_STANDARD, useOpenAI: false };
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!checkAccessCode(event))     return json(401, { error: 'invalid_access_code' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return json(400, { error: 'Некорректный JSON в запросе' }); }

    const { user, prompt, size, model, quality, provider } = body;
    if (!user || !prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
      return json(400, { error: 'Нужны user и prompt (минимум 3 символа)' });
    }

    const resolved = resolveTier({ quality, model: model || provider });
    const { tier, cost, model: routedModel, useOpenAI } = resolved;
    const isPaidTier = tier !== 'standard';

    let record = await getCredits(user);

    const todayKey = new Date().toISOString().slice(0, 10);
    if (!record.img_day || record.img_day !== todayKey) {
      record.img_day = todayKey;
      record.img_used_today = 0;
    }

    const inTrial = isInFreeTrialWindow(record);
    const freeLeftToday = (inTrial && !isPaidTier)
      ? Math.max(0, FREE_IMAGES_PER_DAY - (record.img_used_today || 0))
      : 0;
    const useFree = freeLeftToday > 0;

    if (!useFree && record.credits < cost) {
      return json(402, {
        error: 'insufficient_credits',
        credits: record.credits,
        needed: cost,
        tier,
        freeLeftToday: 0,
        message: isPaidTier
          ? `${tier.toUpperCase()}-картинка стоит ${cost} кредитов. Пополните баланс.`
          : `Картинка стоит ${cost} кредитов.` + (inTrial ? ` В trial-режиме доступно ${FREE_IMAGES_PER_DAY} бесплатных/сутки.` : ' Пополните баланс.'),
      });
    }

    let result = null;
    const attempts = [];

    // Приоритетно: OpenAI только если явно попросили provider=openai для HD и ключ есть
    if (useOpenAI && process.env.OPENAI_API_KEY) {
      try { result = await generateWithOpenAI({ prompt, size }); }
      catch (e) { attempts.push('openai:' + (e.message || String(e))); }
    }

    // Основной путь — OpenRouter (тот же ключ на все тарифы)
    if (!result) {
      try { result = await generateWithOpenRouter({ prompt, model: routedModel }); }
      catch (e) { attempts.push('openrouter:' + (e.message || String(e))); }
    }

    if (!result) {
      const detail = attempts.length ? attempts.join(' | ') : 'провайдер не настроен';
      return json(502, {
        error: 'image_failed',
        tier,
        message: `Не удалось сгенерировать (${tier}): ${detail}`,
      });
    }

    let creditsCharged = 0;
    let newCredits = record.credits;
    let newImgUsed = record.img_used_today || 0;
    if (useFree) {
      newImgUsed += 1;
    } else {
      newCredits -= cost;
      creditsCharged = cost;
    }
    const saved = await saveCredits(user, {
      credits: newCredits,
      img_day: todayKey,
      img_used_today: newImgUsed,
    });

    // Аналитика
    logEvent({
      user_email: user,
      kind: 'image',
      model: 'image:' + tier,
      is_free: useFree,
      credits_charged: creditsCharged,
      cost_usd: COST_USD[tier] || 0,
      revenue_usd: creditsCharged * 0.001,
      meta: { routedModel, trial: inTrial },
    }).catch(() => {});

    return json(200, {
      ...result,
      credits: saved.credits,
      creditsCharged,
      usedFreeToday: useFree,
      freeLeftToday: inTrial && !isPaidTier ? Math.max(0, FREE_IMAGES_PER_DAY - newImgUsed) : 0,
      mode: tier,
      trial: inTrial,
    });
  } catch (e) {
    console.error('image.js unhandled:', e);
    return json(500, { error: 'Внутренняя ошибка: ' + (e.message || 'unknown') });
  }
};
