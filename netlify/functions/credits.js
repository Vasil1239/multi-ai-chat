// Возврат баланса кредитов и остатка бесплатной квоты пользователя (для UI).
const { getCredits } = require('./_store');

const FREE_MSG_PER_DAY = 30;

function checkAccessCode(event) {
  const required = process.env.SITE_ACCESS_CODE;
  if (!required) return true;
  const provided = event.headers['x-access-code'] || event.headers['X-Access-Code'];
  return provided === required;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const json = (s, p) => ({ statusCode: s, headers: JSON_HEADERS, body: JSON.stringify(p) });

exports.handler = async function (event) {
  try {
    if (!checkAccessCode(event)) return json(401, { error: 'invalid_access_code' });
    const user = (event.queryStringParameters || {}).user;
    if (!user) return json(400, { error: 'user required' });
    const rec = await getCredits(user);
    const today = new Date().toISOString().slice(0,10);
    const usedToday = (rec.free_day === today) ? (rec.free_used_today || 0) : 0;
    return json(200, {
      credits: rec.credits,
      freeQuotaDaily: FREE_MSG_PER_DAY,
      freeLeftToday: Math.max(0, FREE_MSG_PER_DAY - usedToday)
    });
  } catch (e) {
    return json(500, { error: 'Внутренняя ошибка: ' + (e.message || 'unknown') });
  }
};
