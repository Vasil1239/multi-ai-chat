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

const FREE_STARTING_CREDITS = 100;

function checkAccessCode(event) {
  const required = process.env.SITE_ACCESS_CODE;
  if (!required) return true;
  const provided = event.headers['x-access-code'] || event.headers['X-Access-Code'];
  return provided === required;
}

exports.handler = async function (event) {
  if (!checkAccessCode(event)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'invalid_access_code' }) };
  }

  const user = (event.queryStringParameters || {}).user;
  if (!user) return { statusCode: 400, body: JSON.stringify({ error: 'user required' }) };

  const store = openStore('credits');
  let record = await store.get(user, { type: 'json' });
  if (!record) {
    record = { credits: FREE_STARTING_CREDITS };
    await store.setJSON(user, record);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credits: record.credits })
  };
};
