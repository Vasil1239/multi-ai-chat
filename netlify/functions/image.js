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

const FREE_TRIAL_DAYS = 7;
const FREE_IMAGES_PER_DAY = 3;

const IMAGE_COST_STANDARD = 50;   // Gemini 2.5 Flash Image  ~$0.04 → маржа ~92%
const IMAGE_COST_HD       = 150;  // Gemini 3.1 Flash Image  ~$0.06 → маржа ~60%
const IMAGE_COST_ULTRA    = 300;  // Gemini 3 Pro Image      ~$0.20 → маржа ~33%

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
  if (Array.isArray(msg?.content)) {
    for (const p of msg.content) {
      if (p?.type === 'image_url' && p.image_url?.url) {
        return { imageUrl: p.image_url.url, provider: `openrouter:${usedModel}` };
      }
    }
  }
  throw new Error('OpenRouter не вернул картинку (модель может не поддерживать генерацию).');
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
