// Временный диагностический эндпоинт для проверки OpenAI-биллинга.
// Требует заголовок X-Admin-Token (тот же ADMIN_TOKEN).
// НЕ возвращает сам ключ, только статус.
// После проверки этот файл надо удалить.

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const json = (s, p) => ({ statusCode: s, headers: JSON_HEADERS, body: JSON.stringify(p, null, 2) });

exports.handler = async function (event) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return json(500, { error: 'ADMIN_TOKEN не задан' });
  const provided = event.headers['x-admin-token'] || event.headers['X-Admin-Token'];
  if (provided !== expected) return json(401, { error: 'invalid_admin_token' });

  const key = process.env.OPENAI_API_KEY;
  if (!key) return json(200, { openaiKeyPresent: false, message: 'OPENAI_API_KEY не задан в Netlify env' });

  const out = {
    openaiKeyPresent: true,
    keyLength: key.length,
    keyStartsWith: key.slice(0, 3), // только 'sk-' или другой префикс, не больше
    tests: {},
  };

  // 1) models list - самый простой запрос: работает всегда, если ключ живой
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch (_) { d = text.slice(0, 200); }
    out.tests.models = {
      httpStatus: r.status,
      ok: r.ok,
      modelCount: Array.isArray(d?.data) ? d.data.length : null,
      error: d?.error?.message || null,
    };
  } catch (e) { out.tests.models = { error: e.message }; }

  // 2) 1-токенный chat.completion на самой дешёвой модели (~$0.00001) - только чтобы увидеть биллинг-ошибку, если она есть
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    });
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch (_) { d = { raw: text.slice(0, 200) }; }
    out.tests.chat = {
      httpStatus: r.status,
      ok: r.ok,
      errorCode: d?.error?.code || null,
      errorType: d?.error?.type || null,
      errorMessage: d?.error?.message || null,
    };
  } catch (e) { out.tests.chat = { error: e.message }; }

  // 3) organization/me - иногда даёт подсказку про orgId
  try {
    const r = await fetch('https://api.openai.com/v1/organizations', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch (_) { d = null; }
    out.tests.organizations = { httpStatus: r.status, ok: r.ok, count: d?.data?.length ?? null };
  } catch (e) { out.tests.organizations = { error: e.message }; }

  return json(200, out);
};
