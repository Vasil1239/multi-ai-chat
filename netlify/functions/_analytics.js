// Логирование бизнес-событий в public.askhub_events (Supabase).
// Не блокирует ответ пользователю: любые ошибки поглощаются.

function _hasSupabase() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function logEvent(evt) {
  if (!_hasSupabase()) return;
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const body = {
      user_email: evt.user_email || 'unknown',
      kind: evt.kind || 'other',
      model: evt.model || null,
      is_free: !!evt.is_free,
      credits_charged: evt.credits_charged || 0,
      cost_usd: evt.cost_usd || 0,
      revenue_usd: evt.revenue_usd || 0,
      prompt_tokens: evt.prompt_tokens || null,
      completion_tokens: evt.completion_tokens || null,
      meta: evt.meta || null,
    };
    await fetch(`${base}/rest/v1/askhub_events`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('analytics logEvent failed:', e.message || e);
  }
}

module.exports = { logEvent };
