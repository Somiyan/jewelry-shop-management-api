/**
 * Vercel serverless entrypoint.
 *
 * Vercel never calls app.listen() — it hands each request straight to this
 * handler — so the DB connection that src/server.js makes at boot has to be
 * established (and cached) here instead, per invocation.
 */
require('dotenv').config();

const app = require('../src/app');
const connectDB = require('../src/config/db');
const { assertRequiredEnv } = require('../src/config/env');

const isHealthProbe = (url) => String(url || '').split('?')[0].startsWith('/api/health');

module.exports = async function handler(req, res) {
  try {
    assertRequiredEnv();
    await connectDB();
  } catch (err) {
    console.error('Startup failed:', err.message);

    // A health probe is most useful precisely when startup is broken, so let
    // it through to report *why* rather than answering with a generic 503.
    if (isHealthProbe(req.url)) {
      req.startupError = err.message;
      return app(req, res);
    }

    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: 'Service unavailable: backend is not configured correctly' }));
    return;
  }

  return app(req, res);
};
