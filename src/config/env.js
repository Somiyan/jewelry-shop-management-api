/**
 * Fail fast on missing configuration.
 *
 * On a serverless host a missing MONGO_URI used to fall back to localhost,
 * which produces a connection timeout minutes later instead of an error —
 * so required vars are checked once, up front, on every entrypoint.
 */
const REQUIRED = ['MONGO_URI', 'JWT_SECRET'];

function assertRequiredEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them in .env locally, or in the Vercel project settings when deployed.'
    );
  }
}

module.exports = { assertRequiredEnv, REQUIRED };
