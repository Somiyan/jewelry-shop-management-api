const cron = require('node-cron');
const { fetchAndStoreRates } = require('../services/rateService');
const { config } = require('../config/rateProvider');

/**
 * Daily live-rate sync.
 *
 * Scheduled for 14:00 Asia/Kolkata. The timezone is stated explicitly rather
 * than inherited from the host, because the server's own clock is UTC in both
 * Docker and Vercel and "2 PM" would otherwise land at 7:30 PM IST.
 */
const CRON_EXPRESSION = process.env.RATE_SYNC_CRON || '0 14 * * *';
const CRON_TIMEZONE = process.env.RATE_SYNC_TIMEZONE || 'Asia/Kolkata';

/**
 * Runs one sync and logs the outcome. Never throws: a scheduled job that
 * throws on a provider outage would take the process down with it, and the
 * shop must keep trading on the last stored rate.
 */
async function runRateSync({ trigger = 'cron', userId = null } = {}) {
  const startedAt = new Date();
  try {
    const result = await fetchAndStoreRates({
      userId,
      reason: trigger === 'cron' ? 'Scheduled daily rate sync' : 'Manual rate sync',
    });

    const summary = result.stored
      .map((r) => `${r.metalType}=${r.ratePerGram}/g`)
      .join(' ');

    console.log(
      `[rates] Gold/Silver rates updated successfully | trigger=${trigger} | ${summary || 'no change'} | ` +
        `stored=${result.stored.length} skipped=${result.skipped.length} attempts=${result.attempts} | ` +
        `source=RapidAPI | at=${startedAt.toISOString()}`
    );
    result.warnings.forEach((w) => console.warn(`[rates] warning: ${w}`));

    return { ok: true, ...result };
  } catch (err) {
    // The message is already redacted by the provider client.
    console.error(
      `[rates] Failed to fetch Gold/Silver rates | trigger=${trigger} | error=${err.message} | ` +
        `status=${err.status ?? 'n/a'} | attempts=${err.attempts ?? config.maxAttempts} | ` +
        `at=${startedAt.toISOString()} | stored rates left unchanged`
    );
    return { ok: false, error: err.message, status: err.status ?? null };
  }
}

let task = null;

/**
 * Registers the schedule on a long-running server (local, Docker, any VM).
 *
 * On Vercel there is no long-lived process to hold a timer, so this is a no-op
 * there and Vercel Cron calls POST /api/rates/sync/cron instead — see
 * vercel.json. Both paths run the same runRateSync().
 */
function startRateSyncSchedule() {
  if (process.env.RATE_SYNC_ENABLED === 'false') {
    console.log('[rates] scheduled sync disabled via RATE_SYNC_ENABLED=false');
    return null;
  }
  if (!config.isConfigured()) {
    console.warn('[rates] scheduled sync not started: RAPIDAPI_KEY is not configured');
    return null;
  }
  if (task) return task;

  if (!cron.validate(CRON_EXPRESSION)) {
    console.error(`[rates] invalid cron expression "${CRON_EXPRESSION}" — scheduled sync not started`);
    return null;
  }

  task = cron.schedule(CRON_EXPRESSION, () => { void runRateSync({ trigger: 'cron' }); }, {
    scheduled: true,
    timezone: CRON_TIMEZONE,
  });

  console.log(`[rates] scheduled daily sync at "${CRON_EXPRESSION}" (${CRON_TIMEZONE})`);
  return task;
}

function stopRateSyncSchedule() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { runRateSync, startRateSyncSchedule, stopRateSyncSchedule, CRON_EXPRESSION, CRON_TIMEZONE };
