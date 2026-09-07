const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const { version } = require('../../package.json');

const READY_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

const PING_TIMEOUT_MS = 3000;

/**
 * Actually round-trips a command to MongoDB rather than trusting readyState:
 * a driver can report "connected" while the server is unreachable, which is
 * exactly the case a health check exists to catch. Bounded so a hung cluster
 * can't hold the request open.
 */
async function pingDatabase() {
  const state = mongoose.connection.readyState;
  const base = {
    status: READY_STATES[state] || 'unknown',
    name: mongoose.connection.name || null,
    host: mongoose.connection.host || null,
  };

  if (state !== 1 || !mongoose.connection.db) {
    return { ...base, reachable: false };
  }

  const startedAt = Date.now();
  let timer;
  try {
    await Promise.race([
      mongoose.connection.db.admin().ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Ping timed out after ${PING_TIMEOUT_MS}ms`)), PING_TIMEOUT_MS);
      }),
    ]);
    return { ...base, reachable: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { ...base, reachable: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/health
 * Full health report. 200 when the database answers, 503 when it doesn't, so
 * uptime monitors and container orchestrators can key off the status code
 * alone while humans read the body.
 */
const getHealth = asyncHandler(async (req, res) => {
  const database = await pingDatabase();
  const healthy = database.reachable === true;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    // Set by the serverless entrypoint when configuration/connection failed,
    // so a broken deploy explains itself instead of just reporting 'degraded'.
    ...(req.startupError ? { startupError: req.startupError } : {}),
    service: 'jewelry-shop-management-api',
    version,
    environment: process.env.NODE_ENV || 'development',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    database,
  });
});

/**
 * GET /api/health/live
 * Liveness only: is this process running and able to answer? Deliberately
 * touches nothing external, so a database outage never restarts the process.
 */
const getLiveness = asyncHandler(async (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

/**
 * GET /api/health/ready
 * Readiness: can this instance serve real traffic (i.e. reach the database)?
 */
const getReadiness = asyncHandler(async (req, res) => {
  const database = await pingDatabase();
  const ready = database.reachable === true;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not-ready',
    ...(req.startupError ? { startupError: req.startupError } : {}),
    database,
    timestamp: new Date().toISOString(),
  });
});

module.exports = { getHealth, getLiveness, getReadiness };
