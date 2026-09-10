// Административная установка/пополнение кредитов.
// POST /api/admin-credits  { user, set?, add?, token? }  + заголовок X-Admin-Token
const { getCredits, saveCredits } = require('./_store');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const json = (s, p) => ({ statusCode: s, headers: JSON_HEADERS, body: JSON.stringify(p) });

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    const expected = process.env.ADMIN_TOKEN;
    if (!expected) return json(500, { error: 'ADMIN_TOKEN не настроен в Netlify' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return json(400, { error: 'Некорректный JSON' }); }

    const provided = event.headers['x-admin-token'] || event.headers['X-Admin-Token'] || body.token;
    if (provided !== expected) return json(401, { error: 'invalid_admin_token' });

    const { user, set, add } = body;
    if (!user) return json(400, { error: 'user required' });
    if (typeof set !== 'number' && typeof add !== 'number') {
      return json(400, { error: 'нужно указать set (число) или add (число)' });
    }

    const cur = await getCredits(user);
    let next = cur.credits;
    if (typeof set === 'number') next = Math.max(0, Math.floor(set));
    if (typeof add === 'number') next = Math.max(0, Math.floor(next + add));

    const saved = await saveCredits(user, { credits: next });
    return json(200, { user, credits: saved.credits, changed: true });
  } catch (e) {
    return json(500, { error: 'Внутренняя ошибка: ' + (e.message || 'unknown') });
  }
};
