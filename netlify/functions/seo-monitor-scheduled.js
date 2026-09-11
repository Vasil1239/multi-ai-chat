// Scheduled wrapper — bypasses secret guard.
const monitor = require('./seo-monitor.js');

exports.handler = async (event, context) => {
  // Pass a scheduled marker; run() ignores secret when this flag is present.
  return await monitor.run({ ...event, scheduled: true }, context);
};

exports.config = { schedule: '0 6 * * *' }; // 06:00 UTC = 08:00 Belgrade
