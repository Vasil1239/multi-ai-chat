// GET/POST /api/plus-bot-admin?action=setWebhook  — one-shot admin endpoint.
// Auth: header X-Admin-Secret must equal PLUS_BOT_WEBHOOK_SECRET.
// Actions:
//   setWebhook   — install webhook at https://<host>/api/plus-bot with drop_pending_updates
//   getMe        — verify token
//   getWebhookInfo
//   setCommands  — install /start, /status menu
//   deleteWebhook

const TG = 'https://api.telegram.org';

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function tg(method, payload) {
  const token = process.env.PLUS_BOT_TOKEN;
  if (!token) throw new Error('PLUS_BOT_TOKEN missing');
  const r = await fetch(`${TG}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  return r.json().catch(() => ({}));
}

exports.handler = async function (event) {
  const secret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  if (!secret || secret !== process.env.PLUS_BOT_WEBHOOK_SECRET) {
    return json(401, { error: 'unauthorized' });
  }
  const q = event.queryStringParameters || {};
  const action = q.action || 'getMe';
  const host = event.headers['x-forwarded-host'] || event.headers.host || 'askhub-beta.netlify.app';
  const webhookUrl = `https://${host}/api/plus-bot`;

  try {
    if (action === 'getMe') {
      return json(200, await tg('getMe'));
    }
    if (action === 'getWebhookInfo') {
      return json(200, await tg('getWebhookInfo'));
    }
    if (action === 'setWebhook') {
      const res = await tg('setWebhook', {
        url: webhookUrl,
        secret_token: process.env.PLUS_BOT_WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
        drop_pending_updates: true
      });
      return json(200, { requested_url: webhookUrl, tg: res });
    }
    if (action === 'deleteWebhook') {
      return json(200, await tg('deleteWebhook', { drop_pending_updates: true }));
    }
    if (action === 'setCommands') {
      const res = await tg('setMyCommands', {
        commands: [
          { command: 'start',  description: 'Начать оформление AskHub Plus' },
          { command: 'status', description: 'Проверить статус подписки' },
          { command: 'help',   description: 'Как это работает' }
        ]
      });
      return json(200, res);
    }
    if (action === 'setName') {
      return json(200, await tg('setMyName', { name: 'AskHub Plus' }));
    }
    if (action === 'setDescription') {
      return json(200, await tg('setMyDescription', {
        description:
          'Подписка AskHub Plus. История чатов, поиск, снятие лимита сессии и +5000 кредитов/мес. Оплата — Telegram Stars.'
      }));
    }
    if (action === 'setShortDescription') {
      return json(200, await tg('setMyShortDescription', {
        short_description: 'Оформить AskHub Plus за Telegram Stars'
      }));
    }
    if (action === 'sendTestMessage') {
      const chatId = q.chat_id;
      if (!chatId) return json(400, { error: 'chat_id_required' });
      return json(200, await tg('sendMessage', { chat_id: Number(chatId), text: 'ping from admin endpoint ✅' }));
    }
    return json(400, { error: 'unknown_action', action });
  } catch (e) {
    return json(500, { error: String(e && e.message || e) });
  }
};
