// SEO monitor — daily technical health + indexing + rank sampling.
// Runs on schedule (see netlify.toml) and can be triggered manually via GET.
//
// Sends a compact report to a Telegram chat via TELEGRAM_BOT_TOKEN + SEO_TG_CHAT_ID.
//
// What it checks:
//  1. HTTP status of key pages (200 vs 3xx/4xx/5xx)
//  2. Response time (TTFB-ish)
//  3. Presence of critical <meta>, canonical, hreflang, schema.org, analytics tags
//  4. robots.txt and sitemap.xml availability + URL count in sitemap
//  5. yandex-verification meta + google-site-verification file still live
//  6. Approximate indexed page count on Yandex (site: query, HTML parse) and Google
//  7. Rank sampling for a few core keywords via Google/Yandex search HTML
//  8. Broken internal links (sampled from sitemap: fetch each URL, check status)
//
// Storage of previous snapshot in Supabase table `seo_snapshots` (id text pk, data jsonb, created_at)
// so the report can show diffs (positions moved, new errors, etc.)

const SITE = 'https://askhub.net';

const KEYWORDS = [
  { q: 'askhub', region: 'ru' },
  { q: 'askhub net', region: 'ru' },
  { q: 'один чат все ии модели', region: 'ru' },
  { q: 'gpt claude gemini сравнение', region: 'ru' },
  { q: 'цена за 1000 токенов', region: 'ru' },
  { q: 'смета ремонта белград ии', region: 'ru' },
  { q: 'ai chat all models', region: 'en' },
  { q: 'ai price per 1000 tokens', region: 'en' },
  { q: 'ai renovation estimate belgrade', region: 'en' },
];

const KEY_PAGES = [
  '/',
  '/chat.html',
  '/blog/',
  '/blog/en/',
  '/blog/sr/',
  '/blog/gpt-vs-claude-vs-gemini-2026.html',
  '/blog/skolko-stoit-1000-tokenov-2026.html',
  '/blog/promty-smeta-remonta-belgrad.html',
  '/robots.txt',
  '/sitemap.xml',
  '/llms.txt',
  '/google0c69ad513b465995.html',
];

const UA = 'Mozilla/5.0 (compatible; AskHubSEOBot/1.0; +https://askhub.net)';

async function fetchWithTiming(url, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      signal: AbortSignal.timeout(opts.timeout || 15000),
    });
    const ms = Date.now() - t0;
    let text = '';
    try { text = await r.text(); } catch {}
    return { ok: r.ok, status: r.status, ms, text, headers: Object.fromEntries(r.headers) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(e).slice(0, 200), text: '' };
  }
}

async function checkPage(path) {
  const url = SITE + path;
  const r = await fetchWithTiming(url);
  const c = { url, status: r.status, ms: r.ms };
  if (!r.text || !r.status) return c;
  const html = r.text;
  if (path.endsWith('.html') || path === '/' || path.endsWith('/')) {
    c.title = (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || null;
    c.description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [])[1] || null;
    c.canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i) || [])[1] || null;
    c.hreflangCount = (html.match(/rel=["']alternate["'][^>]+hreflang=/g) || []).length;
    c.hasSchema = /application\/ld\+json/i.test(html);
    c.hasYm = /mc\.yandex\.ru\/metrika/.test(html) || /ym\(\s*\d+/.test(html);
    c.hasGa = /googletagmanager\.com\/gtag/.test(html) || /gtag\(\s*['"]config/.test(html);
    c.hasYandexVerification = /yandex-verification/i.test(html);
    c.htmlSize = html.length;
  }
  if (path === '/sitemap.xml') {
    c.urlCount = (html.match(/<loc>/g) || []).length;
  }
  if (path === '/robots.txt') {
    c.hasSitemap = /Sitemap:/i.test(html);
    c.blocksImportant = /Disallow:\s*\/\s*$/mi.test(html) && !/User-agent:\s*Googlebot/i.test(html);
  }
  return c;
}

async function checkSitemapUrls(sitemapText, limit = 20) {
  const urls = [...sitemapText.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const sample = urls.slice(0, limit);
  const results = await Promise.all(sample.map(async u => {
    const r = await fetchWithTiming(u, { timeout: 10000 });
    return { url: u, status: r.status, ms: r.ms };
  }));
  const broken = results.filter(r => r.status < 200 || r.status >= 400);
  const redirects = results.filter(r => r.status >= 300 && r.status < 400);
  return { total: urls.length, sampled: sample.length, broken, redirects, slow: results.filter(r => r.ms > 3000) };
}

// Rank sampling.
//   - Yandex: XML API (requires YANDEX_XML_USER + YANDEX_XML_KEY) — https://xml.yandex.ru
//   - Google: Custom Search JSON API (requires GOOGLE_CSE_ID + GOOGLE_CSE_KEY) — 100 req/day free
//   - Fallback: DuckDuckGo HTML (zero-cost, imprecise, best-effort)
async function rankViaGoogleCSE(query, domain) {
  const key = process.env.GOOGLE_CSE_KEY, cx = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return null;
  const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=10`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    const items = j.items || [];
    for (let i = 0; i < items.length; i++) {
      if ((items[i].link || '').includes(domain)) return { rank: i + 1, foundUrl: items[i].link };
    }
    return { rank: null };
  } catch (e) { return { rank: null, error: String(e).slice(0,80) }; }
}

async function rankViaYandexXML(query, domain) {
  const user = process.env.YANDEX_XML_USER, key = process.env.YANDEX_XML_KEY;
  if (!user || !key) return null;
  const url = `https://yandex.ru/search/xml?user=${encodeURIComponent(user)}&key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}&l10n=ru&sortby=rlv&groupby=attr%3D.mode%3Ddeep.groups-on-page%3D10.docs-in-group%3D1`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const xml = await r.text();
    // Extract <url>…</url> sequence order
    const urls = [...xml.matchAll(/<url>([^<]+)<\/url>/g)].map(m => m[1]);
    for (let i = 0; i < urls.length; i++) {
      if (urls[i].includes(domain)) return { rank: i + 1, foundUrl: urls[i] };
    }
    return { rank: null };
  } catch (e) { return { rank: null, error: String(e).slice(0,80) }; }
}

async function rankViaDuckDuckGo(query, domain) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const r = await fetchWithTiming(url, { timeout: 12000, headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.9',
    }});
    if (!r.text) return { rank: null };
    // DuckDuckGo wraps external links in /l/?uddg=<url>
    const matches = [...r.text.matchAll(/uddg=([^"'&]+)/g)].map(m => decodeURIComponent(m[1]));
    const seen = new Set();
    let pos = 0;
    for (const u of matches) {
      const clean = u.split('#')[0];
      if (seen.has(clean)) continue;
      seen.add(clean);
      pos++;
      if (clean.includes(domain)) return { rank: pos, foundUrl: clean };
    }
    return { rank: null };
  } catch (e) { return { rank: null, error: String(e).slice(0,80) }; }
}

async function estimateRank(query, engine = 'google', domain = 'askhub.net') {
  let res = null;
  let source = 'none';
  if (engine === 'google') {
    res = await rankViaGoogleCSE(query, domain);
    if (res) source = 'cse';
    else { res = await rankViaDuckDuckGo(query, domain); source = 'ddg'; }
  } else {
    res = await rankViaYandexXML(query, domain);
    if (res) source = 'xml';
    else { res = await rankViaDuckDuckGo(query + ' site:.ru', domain); source = 'ddg'; }
  }
  return { engine, query, source, rank: res?.rank ?? null, foundUrl: res?.foundUrl || null };
}

async function estimateIndexed(engine, domain) {
  // Try APIs first, then fallback.
  if (engine === 'google') {
    const key = process.env.GOOGLE_CSE_KEY, cx = process.env.GOOGLE_CSE_ID;
    if (key && cx) {
      try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent('site:' + domain)}&num=1`;
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const j = await r.json();
        const total = parseInt(j?.searchInformation?.totalResults || 0, 10);
        if (total) return total;
      } catch {}
    }
  } else {
    const user = process.env.YANDEX_XML_USER, key = process.env.YANDEX_XML_KEY;
    if (user && key) {
      try {
        const url = `https://yandex.ru/search/xml?user=${encodeURIComponent(user)}&key=${encodeURIComponent(key)}&query=${encodeURIComponent('site:' + domain)}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const xml = await r.text();
        const m = xml.match(/<found priority="phrase">(\d+)<\/found>/) || xml.match(/<found priority="all">(\d+)<\/found>/);
        if (m) return parseInt(m[1], 10);
      } catch {}
    }
  }
  // DuckDuckGo fallback — approximate
  try {
    const q = `site:${domain}`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const r = await fetchWithTiming(url, { timeout: 10000 });
    if (!r.text) return null;
    const domainCount = (r.text.match(new RegExp(domain.replace(/\./g, '\\.'), 'g')) || []).length;
    return domainCount > 0 ? domainCount : null;
  } catch { return null; }
}

function fmt(n) { return typeof n === 'number' ? n.toLocaleString('ru-RU') : String(n); }

function buildReport(snap, prev) {
  const p = snap.pages;
  const errPages = p.filter(x => x.status !== 200);
  const slowPages = p.filter(x => x.ms > 2000);
  const brokenAnalytics = p.filter(x => x.url.endsWith('.html') || x.url.endsWith('/'))
    .filter(x => x.status === 200 && (x.hasYm === false || x.hasGa === false));
  const missingSchema = p.filter(x => x.status === 200 && x.canonical !== null && x.hasSchema === false);

  const lines = [];
  lines.push(`🔍 <b>AskHub SEO — ${new Date().toLocaleString('ru-RU',{timeZone:'Europe/Belgrade'})}</b>`);
  lines.push('');
  // Тех состояние
  lines.push(`<b>🏥 Состояние сайта</b>`);
  lines.push(`• Проверено страниц: ${p.length}`);
  lines.push(`• Ошибки (не 200): ${errPages.length}`);
  if (errPages.length) errPages.slice(0,5).forEach(e => lines.push(`   ↳ <code>${e.status}</code> ${e.url}`));
  lines.push(`• Медленных (>2с): ${slowPages.length}`);
  if (slowPages.length) slowPages.slice(0,3).forEach(e => lines.push(`   ↳ ${e.ms}мс ${e.url}`));
  lines.push('');
  // Sitemap
  if (snap.sitemap) {
    lines.push(`<b>🗺 Sitemap</b>`);
    lines.push(`• URL: ${snap.sitemap.total}`);
    lines.push(`• Битых: ${snap.sitemap.broken.length}`);
    if (snap.sitemap.broken.length) snap.sitemap.broken.slice(0,5).forEach(e => lines.push(`   ↳ <code>${e.status}</code> ${e.url}`));
    lines.push(`• Медленных: ${snap.sitemap.slow.length}`);
    lines.push('');
  }
  // Верификации
  const verOk = p.find(x => x.url.endsWith('/google0c69ad513b465995.html'))?.status === 200;
  const yaVerOk = p.find(x => x.url === SITE + '/')?.hasYandexVerification === true;
  lines.push(`<b>✅ Верификации</b>`);
  lines.push(`• Google HTML‑файл: ${verOk ? '✅ OK' : '❌ пропал!'}`);
  lines.push(`• Яндекс мета‑тег: ${yaVerOk ? '✅ OK' : '❌ пропал!'}`);
  lines.push('');
  // Аналитика
  lines.push(`<b>📊 Счётчики на страницах</b>`);
  lines.push(`• Без Метрики: ${brokenAnalytics.filter(x=>!x.hasYm).length}`);
  lines.push(`• Без GA4: ${brokenAnalytics.filter(x=>!x.hasGa).length}`);
  if (missingSchema.length) lines.push(`• Без Schema.org: ${missingSchema.length}`);
  lines.push('');
  // Индексация
  lines.push(`<b>📚 Индексация</b>`);
  lines.push(`• Google (site:): ${snap.indexed.google ?? '—'}`);
  lines.push(`• Yandex (site:): ${snap.indexed.yandex ?? '—'}`);
  if (prev?.indexed) {
    const dg = (snap.indexed.google || 0) - (prev.indexed.google || 0);
    const dy = (snap.indexed.yandex || 0) - (prev.indexed.yandex || 0);
    if (dg) lines.push(`   Δ Google: ${dg > 0 ? '+' : ''}${dg}`);
    if (dy) lines.push(`   Δ Yandex: ${dy > 0 ? '+' : ''}${dy}`);
  }
  lines.push('');
  // Позиции
  lines.push(`<b>🎯 Позиции (top‑50)</b>`);
  const prevRanks = new Map();
  (prev?.ranks || []).forEach(r => prevRanks.set(`${r.engine}|${r.query}`, r.rank));
  snap.ranks.forEach(r => {
    const p0 = prevRanks.get(`${r.engine}|${r.query}`);
    const now = r.rank ? `#${r.rank}` : '—';
    let delta = '';
    if (r.rank && p0) { const d = p0 - r.rank; delta = d ? ` (${d>0?'↑':'↓'}${Math.abs(d)})` : ''; }
    else if (r.rank && !p0) delta = ' 🆕';
    else if (!r.rank && p0) delta = ' ❗️упал';
    lines.push(`• [${r.engine==='google'?'G':'Y'}] ${r.query.slice(0,40)}: ${now}${delta}`);
  });

  return lines.join('\n');
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.SEO_TG_CHAT_ID;
  if (!token || !chatId) return { skipped: 'no tg env' };
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  return await r.json();
}

async function loadPrev() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url}/rest/v1/seo_snapshots?id=eq.latest&select=data`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.[0]?.data || null;
  } catch { return null; }
}

async function savePrev(snap) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/seo_snapshots?id=eq.latest`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ data: snap, created_at: new Date().toISOString() }),
    });
    // insert if not exists
    await fetch(`${url}/rest/v1/seo_snapshots`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ id: 'latest', data: snap, created_at: new Date().toISOString() }),
    });
  } catch {}
}

exports.handler = async (event) => {
  // Optional shared-secret guard for manual invocations.
  // Scheduled runs go through seo-monitor-scheduled.js (which bypasses this check).
  const secret = process.env.SEO_MONITOR_SECRET;
  if (secret && event && !event.scheduled) {
    const provided = (event.queryStringParameters && event.queryStringParameters.key)
      || (event.headers && (event.headers['x-seo-key'] || event.headers['X-SEO-Key']));
    if (provided !== secret) {
      return { statusCode: 401, body: 'unauthorized' };
    }
  }
  const started = Date.now();
  // 1. Pages
  const pages = await Promise.all(KEY_PAGES.map(checkPage));
  // 2. Sitemap URL check
  const sitemapPage = pages.find(p => p.url.endsWith('/sitemap.xml'));
  const sitemapRes = sitemapPage && sitemapPage.status === 200
    ? await checkSitemapUrls((await fetchWithTiming(SITE + '/sitemap.xml')).text)
    : null;
  // 3. Rank sampling (limit parallelism to avoid throttling)
  const ranks = [];
  for (const kw of KEYWORDS) {
    // eslint-disable-next-line no-await-in-loop
    const [g, y] = await Promise.all([
      estimateRank(kw.q, 'google'),
      estimateRank(kw.q, 'yandex'),
    ]);
    ranks.push(g, y);
  }
  // 4. Indexed counts
  const [gIdx, yIdx] = await Promise.all([
    estimateIndexed('google', 'askhub.net'),
    estimateIndexed('yandex', 'askhub.net'),
  ]);
  const snap = {
    ts: new Date().toISOString(),
    pages,
    sitemap: sitemapRes,
    ranks,
    indexed: { google: gIdx, yandex: yIdx },
    tookMs: Date.now() - started,
  };
  const prev = await loadPrev();
  const report = buildReport(snap, prev);
  const tg = await sendTelegram(report);
  await savePrev(snap);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, tookMs: snap.tookMs, tg, report }),
  };
};

// Manual endpoint (no schedule). The scheduled runner lives in seo-monitor-scheduled.js
// and simply invokes the same logic (re-exported via module.exports.run below).
module.exports.run = exports.handler;
