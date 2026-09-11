// Собственный оркестратор веб-поиска: Tavily -> подмешиваем результаты в системный
// промт -> отвечает выбранная пользователем модель через OpenRouter.
//
// Плюсы vs sonar:
//   - можно использовать ЛЮБУЮ модель (GPT-5, Claude, Gemini, DeepSeek…)
//   - контроль над выдачей: сколько результатов брать, как форматировать цитаты
//   - себестоимость: Tavily $0.008/поиск (basic) + токены выбранной модели
//
// ENV:
//   TAVILY_API_KEY            — ключ Tavily (получить на tavily.com)
//   OPENROUTER_API_KEY        — уже есть
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — уже есть

const { getCredits, saveCredits } = require('./_store');
const { logEvent } = require('./_analytics');

const CREDIT_VALUE_USD = 0.0001;    // 1 кредит = $0.0001 себестоимости
const MIN_CREDITS_PER_MESSAGE = 20;
const TAVILY_COST_USD = 0.008;      // basic search

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const json = (s, p) => ({ statusCode: s, headers: JSON_HEADERS, body: JSON.stringify(p) });

function checkAccessCode(event) {
  const required = process.env.SITE_ACCESS_CODE;
  if (!required) return true;
  const provided = event.headers['x-access-code'] || event.headers['X-Access-Code'];
  return provided === required;
}

async function tavilySearch(query, { maxResults = 5 } = {}) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY_NOT_CONFIGURED');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: 'basic',
      include_answer: false,
      max_results: maxResults,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${JSON.stringify(data)}`);
  return data && Array.isArray(data.results) ? data.results : [];
}

function buildContext(results) {
  if (!results.length) return '';
  const lines = ['Результаты поиска (используй только их для фактов, обязательно ставь ссылки [1], [2]… в тексте ответа):', ''];
  results.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title || '(без заголовка)'} — ${r.url}`);
    if (r.content) lines.push(String(r.content).slice(0, 800));
    lines.push('');
  });
  lines.push('В конце ответа выведи блок «Источники:» с нумерованным списком URL.');
  return lines.join('\n');
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  try {
    if (!checkAccessCode(event)) return json(401, { error: 'invalid_access_code' });
    const body = JSON.parse(event.body || '{}');
    const user = body.user;
    const query = (body.query || '').toString().trim();
    const model = body.model || 'openai/gpt-5-mini';
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!user)  return json(400, { error: 'user required' });
    if (!query) return json(400, { error: 'query required' });

    // Баланс — считаем чуть заранее
    const record = await getCredits(user);
    if (!record || (record.credits || 0) <= 0) {
      return json(402, { error: 'no_credits', message: 'Нет кредитов. Пополните баланс.' });
    }

    // 1) Поиск в интернете
    let results = [];
    try {
      results = await tavilySearch(query, { maxResults: 5 });
    } catch (e) {
      if (String(e.message).includes('TAVILY_API_KEY_NOT_CONFIGURED')) {
        return json(500, { error: 'search_not_configured', message: 'Режим поиска ещё не настроен: администратору нужно добавить TAVILY_API_KEY.' });
      }
      return json(502, { error: 'search_failed', message: 'Ошибка поиска: ' + e.message });
    }

    const contextBlock = buildContext(results);
    const userPromptForModel = messages && messages.length
      ? messages
      : [{ role: 'user', content: query }];

    const systemMsg = {
      role: 'system',
      content:
        'Ты — веб-ассистент AskHub. Отвечай кратко, по-русски (если пользователь пишет на другом языке — на его языке). ' +
        'Используй ТОЛЬКО факты из блока «Результаты поиска». Обязательно ставь ссылки [1], [2]… к каждому фактическому утверждению. ' +
        'В конце — блок «Источники:» с нумерованным списком полных URL.\n\n' + contextBlock,
    };

    // 2) Запрос к модели через OpenRouter
    const orKey = process.env.OPENROUTER_API_KEY;
    if (!orKey) return json(500, { error: 'openrouter_not_configured' });

    const t0 = Date.now();
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${orKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://askhub.net',
        'X-Title': 'AskHub Search',
      },
      body: JSON.stringify({
        model,
        messages: [systemMsg, ...userPromptForModel],
        temperature: 0.3,
      }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) return json(resp.status, { error: 'openrouter_failed', detail: data });

    const answer = data?.choices?.[0]?.message?.content || '';
    const usage = data?.usage || {};

    // 3) Тарификация: Tavily $0.008 + токены модели (заниженная оценка $0.0002 за 1k вход, $0.0006 за 1k выход,
    // фактические цифры разнятся — базовая защита ниже)
    const inTok  = usage.prompt_tokens || 0;
    const outTok = usage.completion_tokens || 0;
    const tokenCost = (inTok / 1000) * 0.0005 + (outTok / 1000) * 0.0015; // усреднённо, ×3 запас
    const costUsd = TAVILY_COST_USD + tokenCost;
    const creditsCharged = Math.max(MIN_CREDITS_PER_MESSAGE, Math.ceil(costUsd / CREDIT_VALUE_USD));

    await saveCredits(user, { credits: (record.credits || 0) - creditsCharged });

    logEvent({
      user_email: user,
      kind: 'search',
      model,
      credits_charged: creditsCharged,
      cost_usd: costUsd,
      revenue_usd: creditsCharged * 0.001,
      prompt_tokens: inTok,
      completion_tokens: outTok,
      meta: { query, results_count: results.length, latency_ms: Date.now() - t0 },
    }).catch(() => {});

    return json(200, {
      answer,
      sources: results.map(r => ({ title: r.title, url: r.url })),
      credits: (record.credits || 0) - creditsCharged,
      creditsCharged,
    });
  } catch (e) {
    return json(500, { error: 'internal', message: e.message || 'unknown' });
  }
};
