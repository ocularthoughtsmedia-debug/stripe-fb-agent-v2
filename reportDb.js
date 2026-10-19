// reportDb.js
// Postgres connection for the 30-day report system (report_cycles,
// report_payments). Same database and conventions as adSpendLog.js — the
// otm-ad-predictor Postgres, whose repo owns the DDL
// (db/migrations/2026-10-19_report_cycles.sql). This module never migrates.
//
// Deliberately NOT adSpendLog's pool. adSpendLog swallows every error because
// it sits on the money path and must never block funding. The report system
// wants the opposite: a database it cannot reach must stop sends loudly
// (fail closed), because a report sent without its "sent" record being written
// is a report that will be sent again.

const { sslConfig } = require("./adSpendLog")._internal;

const CONNECT_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = 10000;

let pool = null;

function isConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (pool) return pool;
  if (!isConfigured()) {
    throw new Error("DATABASE_URL is not set — report scheduling is unavailable");
  }

  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig(process.env.DATABASE_URL),
    // Small on purpose: shared 256mb instance (see adSpendLog.js).
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });

  // An idle-client error must not become an unhandled 'error' event and take
  // the webhook endpoint down with it.
  pool.on("error", (err) => {
    console.error("❌ reportDb: idle client error:", err.message);
  });

  return pool;
}

function query(sql, params) {
  return getPool().query(sql, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = { isConfigured, query, withTransaction, close };
