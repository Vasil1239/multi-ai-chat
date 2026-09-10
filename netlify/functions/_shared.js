// Shared helpers: KV store (Netlify Blobs OR Supabase), Plus status, session limits, access code
//
// Хранилище выбирается автоматически:
//   1. Netlify Blobs, если доступны (в prod mylty работают)
//   2. Supabase (таблица public.askhub_kv), если заданы SUPABASE_URL + SUPABASE_SERVICE_KEY
//   3. In-memory (только для локальной разработки — не сохраняет данные между вызовами)
//
// Чтобы перевесить с бета на прод: замерджить ветку в main и, при желании,
// добавить те же две env vars на prod. Прод уже работает на Blobs — Supabase не помешает,
// а если Blobs сломаются, будет автоматический фолбэк.

const { getStore } = require('@netlify/blobs');

// ─────────────────────────────────────────────────────────────────────────────
// In-memory (fallback of last resort)
// ─────────────────────────────────────────────────────────────────────────────
const _memStore = new Map();
function memStore(name) {
  const prefix = name + '\x00';
  return {
    async get(key, opts) {
      const v = _memStore.get(prefix + key);
      if (v == null) return null;
      return (opts && opts.type === 'json') ? v : JSON.stringify(v);
    },
    async setJSON(key, value) { _memStore.set(prefix + key, value); },
    async set(key, value)     { _memStore.set(prefix + key, value); },
    async delete(key)         { _memStore.delete(prefix + key); },
    async list(opts) {
      const p = prefix + (opts?.prefix || '');
      return {
        blobs: [..._memStore.keys()]
          .filter(k => k.startsWith(p))
          .map(k => ({ key: k.slice(prefix.length) })),
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase KV — эмулирует интерфейс Netlify Blobs через таблицу askhub_kv
// ─────────────────────────────────────────────────────────────────────────────
function supabaseAvailable() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

function supabaseStore(name) {
  const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const key  = process.env.SUPABASE_SERVICE_KEY;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  const table = `${base}/rest/v1/askhub_kv`;
  const enc = encodeURIComponent;

  async function upsert(k, value) {
    const res = await fetch(table, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ store: name, key: k, value }]),
    });
    if (!res.ok) throw new Error(`Supabase upsert ${res.status}: ${await res.text()}`);
  }

  return {
    async get(k, opts) {
      const url = `${table}?store=eq.${enc(name)}&key=eq.${enc(k)}&select=value&limit=1`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Supabase get ${res.status}: ${await res.text()}`);
      const rows = await res.json();
      if (!rows.length) return null;
      const v = rows[0].value;
      return (opts && opts.type === 'json') ? v : JSON.stringify(v);
    },
    async setJSON(k, value) { await upsert(k, value); },
    async set(k, value) {
      // Blobs API принимает и строку, и объект. Строку храним как {__raw: "..."}.
      const v = typeof value === 'string' ? { __raw: value } : value;
      await upsert(k, v);
    },
    async delete(k) {
      const url = `${table}?store=eq.${enc(name)}&key=eq.${enc(k)}`;
      const res = await fetch(url, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Supabase delete ${res.status}: ${await res.text()}`);
      }
    },
    async list(opts) {
      const prefix = opts?.prefix || '';
      // key=like.<prefix>*  (в PostgREST шаблон использует * вместо %)
      const url = `${table}?store=eq.${enc(name)}&select=key`
        + (prefix ? `&key=like.${enc(prefix + '*')}` : '');
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Supabase list ${res.status}: ${await res.text()}`);
      const rows = await res.json();
      return { blobs: rows.map(r => ({ key: r.key })) };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// openStore — единая точка входа, выбирает бэкенд
// ─────────────────────────────────────────────────────────────────────────────
// Порядок:
//   1. Netlify Blobs (если process.env.NETLIFY_BLOBS_CONTEXT или явно siteID+token) — prod.
//   2. Supabase (если задан SUPABASE_URL + SUPABASE_SERVICE_KEY) — beta.
//   3. In-memory (dev only).
//
// FORCE_SUPABASE=1 — принудительно Supabase (для отладки).
function openStore(name) {
  const forceSupabase = process.env.FORCE_SUPABASE === '1';

  if (!forceSupabase) {
    // Пробуем Netlify Blobs.
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    try {
      const store = (siteID && token)
        ? getStore({ name, siteID, token, consistency: 'strong' })
        : getStore(name);
      return _wrapWithSupabaseFallback(store, name);
    } catch (e) {
      // не удалось создать — пробуем следующее
      console.warn('Netlify Blobs unavailable at open:', e.message);
    }
  }

  if (supabaseAvailable()) {
    return supabaseStore(name);
  }

  console.warn('No persistent store configured — using in-memory (data will NOT persist).');
  return memStore(name);
}

// Если Netlify Blobs открылись, но при первом реальном вызове бросают
// "environment not configured" / 401 — автоматически откатываемся к Supabase.
function _wrapWithSupabaseFallback(primary, name) {
  if (!supabaseAvailable()) return primary; // некуда fallback-ить
  let fallback = null;
  function fb() {
    if (!fallback) {
      console.warn(`[askhub_kv] Blobs failed, using Supabase for store="${name}"`);
      fallback = supabaseStore(name);
    }
    return fallback;
  }
  const isBlobFail = (e) => {
    const m = (e && e.message) || '';
    return /environment has not been configured|401|BlobsInternalError|Blobs unavailable/i.test(m);
  };
  return {
    async get(k, opts)       { try { return await primary.get(k, opts); }    catch (e) { if (isBlobFail(e)) return fb().get(k, opts);    throw e; } },
    async setJSON(k, v)      { try { return await primary.setJSON(k, v); }   catch (e) { if (isBlobFail(e)) return fb().setJSON(k, v);   throw e; } },
    async set(k, v)          { try { return await primary.set(k, v); }       catch (e) { if (isBlobFail(e)) return fb().set(k, v);       throw e; } },
    async delete(k)          { try { return await primary.delete(k); }       catch (e) { if (isBlobFail(e)) return fb().delete(k);       throw e; } },
    async list(opts)         { try { return await primary.list(opts); }      catch (e) { if (isBlobFail(e)) return fb().list(opts);      throw e; } },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Existing helpers (unchanged public surface)
// ─────────────────────────────────────────────────────────────────────────────
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
