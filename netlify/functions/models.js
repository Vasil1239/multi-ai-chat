// Публичный каталог моделей OpenRouter (не требует ключа для чтения списка).
// Отдаём фронтенду упрощённый и размеченный список: провайдер, бесплатна ли модель, цена.

exports.handler = async function () {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    const json = await res.json();

    const models = (json.data || []).map((m) => {
      const promptPrice = parseFloat(m.pricing?.prompt || '0');
      const completionPrice = parseFloat(m.pricing?.completion || '0');
      const free = promptPrice === 0 && completionPrice === 0;
      const provider = (m.id.split('/')[0] || 'other');
      return {
        id: m.id,
        name: m.name || m.id,
        provider,
        free,
        context: m.context_length || null
      };
    }).sort((a, b) => (a.provider + a.name).localeCompare(b.provider + b.name));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ models })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
