// CRUD for user chats (projects). Storage: Netlify Blobs, store="chats"
// Keys:
//   idx:<user>          -> { chats: [{id,title,updated_at,pinned}] }
//   msg:<user>:<chatId> -> { messages: [...] }
//
// Access requires Plus for READ of history from other sessions,
// but WRITES are allowed regardless (so free users can still save current-session state).
// Free users are limited to 3 saved projects — anything beyond that is dropped.
const { openStore, checkAccessCode, getPlusStatus } = require('./_shared');

const FREE_MAX_PROJECTS = 3;

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
function slug() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

exports.handler = async function (event) {
  if (!checkAccessCode(event)) return json(401, { error: 'invalid_access_code' });

  const method = event.httpMethod;
  const q = event.queryStringParameters || {};
  const user = (q.user || '').trim().toLowerCase();
  if (!user) return json(400, { error: 'user required' });

  const store = openStore('chats');
  const plus = (await getPlusStatus(user)).plus;

  if (method === 'GET') {
    // GET /api/chats?user=X                 -> list
    // GET /api/chats?user=X&id=Y            -> single with messages
    const idx = (await store.get(`idx:${user}`, { type: 'json' })) || { chats: [] };
    if (q.id) {
      const meta = idx.chats.find(c => c.id === q.id);
      if (!meta) return json(404, { error: 'not_found' });
      const msgs = (await store.get(`msg:${user}:${q.id}`, { type: 'json' })) || { messages: [] };
      return json(200, { chat: meta, messages: msgs.messages, plus });
    }
    // Free users see only the most recent chat; Plus see all.
    const list = plus ? idx.chats : idx.chats.slice(0, 1);
    return json(200, { chats: list, plus, limit: plus ? null : FREE_MAX_PROJECTS });
  }

  if (method === 'POST') {
    // POST /api/chats?user=X   body: { id?, title?, messages }
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }
    const idx = (await store.get(`idx:${user}`, { type: 'json' })) || { chats: [] };
    const id = body.id || slug();
    const title = (body.title || (body.messages?.[0]?.content?.slice(0, 60)) || 'Новый чат').trim();
    const now = new Date().toISOString();

    // save messages
    await store.setJSON(`msg:${user}:${id}`, { messages: body.messages || [] });

    // upsert index entry
    const existing = idx.chats.findIndex(c => c.id === id);
    if (existing >= 0) {
      idx.chats[existing] = { ...idx.chats[existing], title, updated_at: now };
    } else {
      idx.chats.unshift({ id, title, updated_at: now });
    }
    // sort by updated_at desc
    idx.chats.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

    // Free-tier cap
    if (!plus && idx.chats.length > FREE_MAX_PROJECTS) {
      const drop = idx.chats.splice(FREE_MAX_PROJECTS);
      for (const c of drop) await store.delete(`msg:${user}:${c.id}`);
    }
    await store.setJSON(`idx:${user}`, idx);
    return json(200, { ok: true, id, title, plus });
  }

  if (method === 'DELETE') {
    // DELETE /api/chats?user=X&id=Y
    if (!q.id) return json(400, { error: 'id required' });
    const idx = (await store.get(`idx:${user}`, { type: 'json' })) || { chats: [] };
    idx.chats = idx.chats.filter(c => c.id !== q.id);
    await store.setJSON(`idx:${user}`, idx);
    await store.delete(`msg:${user}:${q.id}`);
    return json(200, { ok: true });
  }

  return json(405, { error: 'method_not_allowed' });
};
