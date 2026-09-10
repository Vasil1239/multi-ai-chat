// Shared helpers: Blobs store, Plus status, session limits, access code
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
    async set(key, value) { _memStore.set(key, value); },
    async delete(key) { _memStore.delete(key); },
    async list(opts) {
      const prefix = opts?.prefix || '';
      return { blobs: [...(_memStore.keys())].filter(k => k.startsWith(prefix)).map(k => ({ key: k })) };
    }
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

function checkAccessCode(event) {
  const required = process.env.SITE_ACCESS_CODE;
  if (!required) return true;
  const provided = event.headers['x-access-code'] || event.headers['X-Access-Code'];
  return provided === required;
}

// Plus status: reads from 'plus' store, key = user email
async function getPlusStatus(user) {
  const store = openStore('plus');
  const rec = await store.get(user, { type: 'json' });
  if (!rec || !rec.plus_until) return { plus: false, plus_until: null };
  const now = Date.now();
  const until = Date.parse(rec.plus_until);
  return { plus: until > now, plus_until: rec.plus_until };
}

// Simple hash for linking site email → Telegram bot start param
function emailToken(email, salt) {
  const crypto = require('crypto');
  const s = salt || process.env.PLUS_LINK_SALT || 'askhub-default-salt-change-me';
  return crypto.createHmac('sha256', s).update(email.toLowerCase().trim()).digest('hex').slice(0, 24);
}

const SESSION_MSG_LIMIT_FREE = 100;

module.exports = {
  openStore, checkAccessCode, getPlusStatus, emailToken,
  SESSION_MSG_LIMIT_FREE
};
