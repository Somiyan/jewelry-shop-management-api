require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/db');
const { assertRequiredEnv } = require('./config/env');

const PORT = process.env.PORT || 5050;

async function start() {
  try {
    assertRequiredEnv();
    await connectDB();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();
