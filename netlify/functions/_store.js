// Единый слой хранения кредитов на Supabase.
// Все функции (chat, image, credits, admin-credits) используют get/setCredits отсюда.
//
// Переменные окружения (Netlify):
//   SUPABASE_URL              — https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — секретный service_role ключ (обходит RLS)
//
// Если переменные не заданы — падаем в in-memory fallback (чтобы сайт работал
// хотя бы в пределах одного холодного запуска функции).

const FREE_STARTING_CREDITS = 1000;

const _mem = new Map();

function _hasSupabase() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function _sbFetch(path, opts = {}) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${base}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function getCredits(user) {
  if (!_hasSupabase()) {
    return _mem.get(user) || { user_email: user, credits: FREE_STARTING_CREDITS, img_day: null, img_used_today: 0 };
  }
  const arr = await _sbFetch(`/askhub_credits?user_email=eq.${encodeURIComponent(user)}&select=*`);
  if (arr && arr.length) return arr[0];
  // Создаём запись со стартовым бонусом
  const created = await _sbFetch('/askhub_credits', {
    method: 'POST',
    body: JSON.stringify({ user_email: user, credits: FREE_STARTING_CREDITS }),
  });
  return Array.isArray(created) ? created[0] : created;
}

async function saveCredits(user, patch) {
  if (!_hasSupabase()) {
    const cur = _mem.get(user) || { user_email: user, credits: FREE_STARTING_CREDITS, img_day: null, img_used_today: 0 };
    const next = { ...cur, ...patch, user_email: user };
    _mem.set(user, next);
    return next;
  }
  const body = { ...patch, user_email: user, updated_at: new Date().toISOString() };
  const arr = await _sbFetch(
    `/askhub_credits?on_conflict=user_email`,
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(body),
    }
  );
  return Array.isArray(arr) ? arr[0] : arr;
}

module.exports = { getCredits, saveCredits, FREE_STARTING_CREDITS };
