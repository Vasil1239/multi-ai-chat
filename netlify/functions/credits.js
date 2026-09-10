// Возврат баланса кредитов пользователя (для UI).
const { getCredits } = require('./_store');

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
    return json(200, { credits: rec.credits });
  } catch (e) {
    return json(500, { error: 'Внутренняя ошибка: ' + (e.message || 'unknown') });
  }
};
