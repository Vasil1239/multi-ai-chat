const { getStore } = require('@netlify/blobs');

const FREE_STARTING_CREDITS = 20;

function checkAccessCode(event) {
  const required = process.env.SITE_ACCESS_CODE;
  if (!required) return true;
  const provided = event.headers['x-access-code'] || event.headers['X-Access-Code'];
  return provided === required;
}

exports.handler = async function (event) {
  if (!checkAccessCode(event)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'invalid_access_code' }) };
  }

  const user = (event.queryStringParameters || {}).user;
  if (!user) return { statusCode: 400, body: JSON.stringify({ error: 'user required' }) };

  const store = getStore('credits');
  let record = await store.get(user, { type: 'json' });
  if (!record) {
    record = { credits: FREE_STARTING_CREDITS };
    await store.setJSON(user, record);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credits: record.credits })
  };
};
