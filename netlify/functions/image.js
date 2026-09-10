// Генерация изображений для AskHub.
// Провайдеры (в порядке приоритета, автоматический fallback):
//   1) OpenAI gpt-image-1  — если задан OPENAI_API_KEY (лучшее качество/текст)
//   2) OpenRouter image-модель (google/gemini-2.5-flash-image, black-forest-labs/flux-1.1-pro и т.п.)
//   3) Понятная человеческая ошибка, если ни один ключ не настроен.
//
// Ответ клиенту всегда JSON: { imageUrl?: string, imageB64?: string, error?: string, provider?: string, credits?: number }
// Тарификация — единая ставка за одно изображение (см. IMAGE_CREDIT_COST). Free-режим отключён (картинки всегда платные).

const { getCredits, saveCredits } = require('./_store');

const IMAGE_CREDIT_COST = 50;      // 50 кредитов за картинку
const FREE_IMAGES_PER_DAY = 5;     // 5 бесплатных картинок в сутки, не накапливаются

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

    // Кредиты и бесплатный дневной лимит
    let record = await getCredits(user);

    const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    if (!record.img_day || record.img_day !== todayKey) {
      record.img_day = todayKey;
      record.img_used_today = 0;
    }
    // Бесплатные картинки — только в первые 7 дней от регистрации и только на Gemini (стандарт)
    const inTrial = isInFreeTrialWindow(record);
    const freeLeftToday = (inTrial && !wantHD)
      ? Math.max(0, FREE_IMAGES_PER_DAY - (record.img_used_today || 0))
      : 0;
    const useFree = freeLeftToday > 0;

    const costCredits = wantHD ? IMAGE_COST_HD : IMAGE_COST_STANDARD;

    if (!useFree && record.credits < costCredits) {
      return json(402, {
        error: 'insufficient_credits',
        credits: record.credits,
        needed: costCredits,
        freeLeftToday: 0,
        message: wantHD
          ? `HD-картинка стоит ${costCredits} кредитов. Пополните баланс.`
          : `Картинка стоит ${costCredits} кредитов.` + (inTrial ? ` В trial-режиме доступно ${FREE_IMAGES_PER_DAY} бесплатных/сутки.` : ' Пополните баланс.'),
      });
    }

    // Маршрутизация: HD → только OpenAI, std → только Gemini (не жжём OpenAI на бесплатках)
    let result = null;
    const attempts = [];
    try {
      result = wantHD
        ? await generateWithOpenAI({ prompt, size })
        : await generateWithOpenRouter({ prompt, model });
    } catch (e) { attempts.push(e.message || String(e)); }

    if (!result) {
      const detail = attempts.length ? attempts.join(' | ') : 'провайдер не настроен';
      if (wantHD) {
        return json(503, { error: 'hd_unavailable', message: 'HD недоступен: ' + detail + '. Добавьте OPENAI_API_KEY в Netlify.' });
      }
      return json(500, { error: 'Не удалось сгенерировать изображение: ' + detail });
    }

    // Списываем: сначала бесплатный лимит дня, потом — кредиты
    let creditsCharged = 0;
    let newCredits = record.credits;
    let newImgUsed = record.img_used_today || 0;
    if (useFree) {
      newImgUsed += 1;
    } else {
      newCredits -= costCredits;
      creditsCharged = costCredits;
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
      freeLeftToday: inTrial && !wantHD ? Math.max(0, FREE_IMAGES_PER_DAY - newImgUsed) : 0,
      mode: wantHD ? 'hd' : 'standard',
      trial: inTrial,
    });
  } catch (e) {
    console.error('image.js unhandled:', e);
    return json(500, { error: 'Внутренняя ошибка: ' + (e.message || 'unknown') });
  }
};
