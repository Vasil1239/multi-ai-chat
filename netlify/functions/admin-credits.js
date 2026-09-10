// Административная выдача/установка кредитов.
// Защищено секретом ADMIN_TOKEN (передаётся в заголовке X-Admin-Token или в body.token).
// POST /api/admin-credits  { user: "email@x.com", set?: 200, add?: 500, token?: "..." }
// Возвращает { user, credits, changed }

const { getStore } = require('@netlify/blobs');

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
  } catch (_) { return memStore(); }
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const json = (s, p) => ({ statusCode: s, headers: JSON_HEADERS, body: JSON.stringify(p) });

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    const expected = process.env.ADMIN_TOKEN;
    if (!expected) return json(500, { error: 'ADMIN_TOKEN не настроен в Netlify' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return json(400, { error: 'Некорректный JSON' }); }

    const provided = event.headers['x-admin-token'] || event.headers['X-Admin-Token'] || body.token;
    if (provided !== expected) return json(401, { error: 'invalid_admin_token' });

    const { user, set, add } = body;
    if (!user) return json(400, { error: 'user required' });
    if (typeof set !== 'number' && typeof add !== 'number') {
      return json(400, { error: 'нужно указать set (число) или add (число)' });
    }

    const store = openStore('credits');
    let record = await store.get(user, { type: 'json' }) || { credits: 0 };

    if (typeof set === 'number') record.credits = Math.max(0, Math.floor(set));
    if (typeof add === 'number') record.credits = Math.max(0, Math.floor(record.credits + add));

    await store.setJSON(user, record);
    return json(200, { user, credits: record.credits, changed: true });
  } catch (e) {
    return json(500, { error: 'Внутренняя ошибка: ' + (e.message || 'unknown') });
  }
};
