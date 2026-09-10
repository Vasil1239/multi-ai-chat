// GET /api/plus?user=X  → { plus:bool, plus_until:isoStr|null, link_token, bot_start_url }
const { checkAccessCode, getPlusStatus, emailToken } = require('./_shared');

exports.handler = async function (event) {
  if (!checkAccessCode(event)) return { statusCode: 401, body: JSON.stringify({ error: 'invalid_access_code' }) };
  const user = ((event.queryStringParameters || {}).user || '').trim().toLowerCase();
  if (!user) return { statusCode: 400, body: JSON.stringify({ error: 'user required' }) };

  const status = await getPlusStatus(user);
  const token = emailToken(user);
  const bot = process.env.PLUS_BOT_USERNAME || 'askhub_plus_bot';
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...status,
      link_token: token,
      bot_start_url: `https://t.me/${bot}?start=${token}`
    })
  };
};
