// Возврат баланса и статистики рефералов пользователя (для UI).
const { getCredits, getReferralStats } = require('./_store');

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
    const q = event.queryStringParameters || {};
    const user = q.user;
    if (!user) return json(400, { error: 'user required' });

    // ref-код передаётся при первом обращении, если пользователь пришёл по ссылке /?r=XXXX
    const refCode = (q.ref || '').toString().toLowerCase().trim() || null;

    const rec = await getCredits(user, refCode ? { refCode } : {});
    const today = new Date().toISOString().slice(0,10);
    const usedToday = (rec.free_day === today) ? (rec.free_used_today || 0) : 0;

    let referralStats = { invitedCount: 0, bonusEarned: 0 };
    try { referralStats = await getReferralStats(user); } catch (_) {}

    return json(200, {
      credits: rec.credits,
      freeQuotaDaily: FREE_MSG_PER_DAY,
      freeLeftToday: Math.max(0, FREE_MSG_PER_DAY - usedToday),
      refCode: rec.ref_code || null,
      referredBy: rec.referred_by || null,
      referral: referralStats,
    });
  } catch (e) {
    return json(500, { error: 'Внутренняя ошибка: ' + (e.message || 'unknown') });
  }
};
