require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/db');
const { assertRequiredEnv } = require('./config/env');
const { startRateSyncSchedule } = require('./jobs/rateSyncJob');

const PORT = process.env.PORT || 5050;

async function start() {
  try {
    assertRequiredEnv();
    await connectDB();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    // Only a long-lived process can hold a timer. On Vercel this is never
    // reached and Vercel Cron calls POST /api/rates/sync/cron instead.
    startRateSyncSchedule();
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();
