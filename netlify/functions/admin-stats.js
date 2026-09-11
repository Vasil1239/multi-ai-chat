// Бизнес-аналитика: агрегаты по событиям.
// Требует заголовок X-Admin-Token = process.env.ADMIN_TOKEN.
// GET /api/admin-stats?days=30

async function sbQuery(sql) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${base}/rest/v1/rpc/exec_readonly_sql`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error('Supabase RPC ' + res.status + ': ' + raw);
  try { return JSON.parse(raw); } catch { return raw; }
}

// Проще: используем REST-таблицу askhub_events напрямую через PostgREST
async function sbSelect(path) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${base}/rest/v1${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + raw);
  return JSON.parse(raw);
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const json = (s, p) => ({ statusCode: s, headers: JSON_HEADERS, body: JSON.stringify(p) });

exports.handler = async function (event) {
  try {
    const adminToken = event.headers['x-admin-token'] || event.headers['X-Admin-Token'];
    if (!process.env.ADMIN_TOKEN || adminToken !== process.env.ADMIN_TOKEN) {
      return json(401, { error: 'invalid_admin_token' });
    }
    const days = Math.max(1, Math.min(365, parseInt((event.queryStringParameters || {}).days || '30', 10)));
    const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

    // Тянем все события за период (в пределах разумного объёма ≈ 10k строк)
    const events = await sbSelect(
      `/askhub_events?created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=20000`
    );

    // Считаем агрегаты в памяти
    let revenue = 0, cost = 0, chatMsgs = 0, freeMsgs = 0, paidMsgs = 0;
    let imgStd = 0, imgHd = 0, imgUltra = 0, imgFree = 0;
    let topups = 0, topupRevenue = 0;
    const users = new Set();
    const byDay = new Map();      // 'YYYY-MM-DD' → {revenue, cost, chat, image, topup}
    const byModel = new Map();    // model → {msgs, revenue, cost}
    const perUser = new Map();    // email → {revenue, cost, chat, image}

    for (const e of events) {
      const d = (e.created_at || '').slice(0, 10);
      const rev = Number(e.revenue_usd) || 0;
      const cst = Number(e.cost_usd) || 0;
      revenue += rev; cost += cst;
      users.add(e.user_email);

      if (!byDay.has(d)) byDay.set(d, { day: d, revenue: 0, cost: 0, chat: 0, image: 0, topup: 0 });
      const bd = byDay.get(d);
      bd.revenue += rev; bd.cost += cst;

      if (e.kind === 'chat') {
        chatMsgs++;
        bd.chat++;
        if (e.is_free) freeMsgs++; else paidMsgs++;
      } else if (e.kind === 'image') {
        bd.image++;
        if (e.model === 'image:standard') imgStd++;
        else if (e.model === 'image:hd') imgHd++;
        else if (e.model === 'image:ultra') imgUltra++;
        if (e.is_free) imgFree++;
      } else if (e.kind === 'topup') {
        topups++;
        topupRevenue += rev;
        bd.topup++;
      }

      const mk = e.model || '(none)';
      if (!byModel.has(mk)) byModel.set(mk, { model: mk, msgs: 0, revenue: 0, cost: 0 });
      const bm = byModel.get(mk);
      bm.msgs++; bm.revenue += rev; bm.cost += cst;

      if (!perUser.has(e.user_email)) perUser.set(e.user_email, { user: e.user_email, revenue: 0, cost: 0, chat: 0, image: 0 });
      const pu = perUser.get(e.user_email);
      pu.revenue += rev; pu.cost += cst;
      if (e.kind === 'chat') pu.chat++;
      if (e.kind === 'image') pu.image++;
    }

    const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
    const finalize = (arr) => arr.map(x => ({ ...x, revenue: round(x.revenue), cost: round(x.cost), profit: round(x.revenue - x.cost) }));

    return json(200, {
      period_days: days,
      totals: {
        revenue_usd: round(revenue),
        cost_usd: round(cost),
        profit_usd: round(revenue - cost),
        margin_pct: revenue > 0 ? Math.round((1 - cost / revenue) * 1000) / 10 : 0,
        users: users.size,
        events: events.length,
      },
      chat: { total: chatMsgs, free: freeMsgs, paid: paidMsgs },
      images: { standard: imgStd, hd: imgHd, ultra: imgUltra, free_used: imgFree },
      topups: { count: topups, revenue_usd: round(topupRevenue) },
      by_day: finalize([...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))),
      by_model: finalize([...byModel.values()].sort((a, b) => b.revenue - a.revenue)).slice(0, 20),
      top_users: finalize([...perUser.values()].sort((a, b) => b.revenue - a.revenue)).slice(0, 20),
    });
  } catch (e) {
    return json(500, { error: 'admin-stats: ' + (e.message || 'unknown') });
  }
};
