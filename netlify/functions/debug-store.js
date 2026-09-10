// Debug: probe openStore()
const { openStore } = require('./_shared');

exports.handler = async () => {
  const results = {};
  try {
    const s = openStore('plus');
    await s.setJSON('__probe__', { at: new Date().toISOString(), n: Math.random() });
    const back = await s.get('__probe__', { type: 'json' });
    results.plus = { ok: true, back };
  } catch (e) {
    results.plus = { ok: false, err: e.message, stack: (e.stack||'').split('\n').slice(0,3) };
  }
  results.env = {
    hasSupaUrl: !!process.env.SUPABASE_URL,
    hasSupaKey: !!process.env.SUPABASE_SERVICE_KEY,
    hasBlobsCtx: !!process.env.NETLIFY_BLOBS_CONTEXT,
    hasSiteId: !!process.env.NETLIFY_SITE_ID,
    force: process.env.FORCE_SUPABASE || null,
  };
  return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify(results, null, 2) };
};
