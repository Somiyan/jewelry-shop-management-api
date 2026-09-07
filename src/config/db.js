const mongoose = require('mongoose');

/**
 * Serverless-safe Mongo connection.
 *
 * Vercel reuses a warm Lambda for many requests but re-evaluates modules on
 * every cold start, so the connection is cached on globalThis: without this
 * each invocation opens its own pool and Atlas hits its connection limit.
 * A failed attempt clears the cached promise so the next request can retry.
 */
const cache = globalThis.__jewelryMongo || (globalThis.__jewelryMongo = { conn: null, promise: null });

async function connectDB() {
  if (cache.conn) return cache.conn;

  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set — cannot connect to MongoDB');
  }

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(uri, {
        // Keep the pool small: a shop this size runs a handful of concurrent
        // users, and every warm Lambda holds its own pool against Atlas.
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10000,
      })
      .then((m) => {
        console.log(`MongoDB connected: ${m.connection.host}`);
        return m.connection;
      });
  }

  try {
    cache.conn = await cache.promise;
  } catch (err) {
    cache.promise = null; // let the next request try again
    throw err;
  }

  return cache.conn;
}

module.exports = connectDB;
