// Единый слой хранения кредитов на Supabase.
// Все функции (chat, image, credits, admin-credits, stripe-webhook) используют его.
//
// Переменные окружения (Netlify):
//   SUPABASE_URL              — https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — секретный service_role ключ (обходит RLS)

const FREE_STARTING_CREDITS = 300;
const FREE_TRIAL_DAYS = 7;

// Реферальная программа
const REFERRAL_INVITEE_BONUS = 100; // приглашённому — сразу при регистрации
const REFERRAL_INVITER_BONUS = 200; // пригласившему — после первой оплаты приглашённого

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

function _genRefCode(email) {
  // 8 символов md5-подобных — стабильно для одного email
  let h = 0;
  const s = (email || '') + '::askhub';
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return (Math.abs(h).toString(16).padStart(4, '0').slice(-4) + rand).toLowerCase();
}

async function getCredits(user, opts = {}) {
  const refCodeFromInvite = (opts.refCode || '').toString().toLowerCase().trim() || null;

  if (!_hasSupabase()) {
    let rec = _mem.get(user);
    if (rec) return rec;
    rec = {
      user_email: user,
      credits: FREE_STARTING_CREDITS + (refCodeFromInvite ? REFERRAL_INVITEE_BONUS : 0),
      img_day: null,
      img_used_today: 0,
      created_at: new Date().toISOString(),
      ref_code: _genRefCode(user),
      referred_by: null,
      referral_bonus_paid: false,
    };
    _mem.set(user, rec);
    return rec;
  }

  const arr = await _sbFetch(`/askhub_credits?user_email=eq.${encodeURIComponent(user)}&select=*`);
  if (arr && arr.length) {
    let rec = arr[0];
    // Дозаливаем ref_code, если его ещё нет
    if (!rec.ref_code) {
      const code = _genRefCode(user);
      rec = await saveCredits(user, { ref_code: code });
    }
    return rec;
  }

  // Приглашение: ищем пригласившего по коду
  let referredByEmail = null;
  if (refCodeFromInvite) {
    try {
      const inv = await _sbFetch(`/askhub_credits?ref_code=eq.${encodeURIComponent(refCodeFromInvite)}&select=user_email`);
      if (inv && inv.length && inv[0].user_email && inv[0].user_email !== user) {
        referredByEmail = inv[0].user_email;
      }
    } catch (_) {}
  }

  const startCredits = FREE_STARTING_CREDITS + (referredByEmail ? REFERRAL_INVITEE_BONUS : 0);
  const created = await _sbFetch('/askhub_credits', {
    method: 'POST',
    body: JSON.stringify({
      user_email: user,
      credits: startCredits,
      ref_code: _genRefCode(user),
      referred_by: referredByEmail,
      referral_bonus_paid: false,
    }),
  });
  return Array.isArray(created) ? created[0] : created;
}

function isInFreeTrialWindow(record) {
  if (!record || !record.created_at) return true;
  const created = new Date(record.created_at).getTime();
  const now = Date.now();
  const daysPassed = (now - created) / (1000 * 60 * 60 * 24);
  return daysPassed <= FREE_TRIAL_DAYS;
}

async function saveCredits(user, patch) {
  if (!_hasSupabase()) {
    const cur = _mem.get(user) || { user_email: user, credits: FREE_STARTING_CREDITS, img_day: null, img_used_today: 0, ref_code: _genRefCode(user) };
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

// ==== Рефералка: статистика для UI ====
async function getReferralStats(user) {
  if (!_hasSupabase()) {
    return { invitedCount: 0, bonusEarned: 0 };
  }
  const arr = await _sbFetch(
    `/askhub_credits?referred_by=eq.${encodeURIComponent(user)}&select=user_email,referral_bonus_paid`
  );
  const invitedCount = arr ? arr.length : 0;
  const paidCount = arr ? arr.filter(r => r.referral_bonus_paid).length : 0;
  return {
    invitedCount,
    bonusEarned: paidCount * REFERRAL_INVITER_BONUS,
  };
}

// ==== Рефералка: выплата пригласившему после первой оплаты приглашённого ====
async function payReferralBonusIfEligible(inviteeEmail) {
  if (!_hasSupabase()) return null;
  const rec = await getCredits(inviteeEmail);
  if (!rec || !rec.referred_by || rec.referral_bonus_paid) return null;

  const inviter = await getCredits(rec.referred_by);
  if (!inviter) return null;

  await saveCredits(rec.referred_by, { credits: (inviter.credits || 0) + REFERRAL_INVITER_BONUS });
  await saveCredits(inviteeEmail, { referral_bonus_paid: true });
  return { inviterEmail: rec.referred_by, bonus: REFERRAL_INVITER_BONUS };
}

module.exports = {
  getCredits,
  saveCredits,
  getReferralStats,
  payReferralBonusIfEligible,
  FREE_STARTING_CREDITS,
  FREE_TRIAL_DAYS,
  REFERRAL_INVITEE_BONUS,
  REFERRAL_INVITER_BONUS,
  isInFreeTrialWindow,
};
