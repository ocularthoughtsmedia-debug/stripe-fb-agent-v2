// adSpendLog.js
// Permanent, append-only ledger of Facebook ad-budget allocations.
//
// Writes into the otm-ad-predictor Postgres (otm-predictor-db, Render paid
// Basic-256mb) — the same database that service's dashboard already reads.
// The table DDL lives THERE, in db/schema.sql, which runs idempotently on that
// service's boot. This module only INSERTs and SELECTs; it never migrates.
//
// Why not a JSON file: Render's filesystem is ephemeral. reports.json and
// reminders.json are committed to git, so every deploy overwrites whatever the
// running service had written. A log file here would lose history on each
// deploy, which is the opposite of the requirement.
//
// ═══ NEVER THROWS, NEVER BLOCKS THE MONEY PATH ═══
// Every exported function resolves; none reject. A database that is down, slow,
// unconfigured — or a `pg` module that isn't even installed — must not stop a
// paid client's ads from being funded, and must not turn a successful Facebook
// update into a 500 that makes Stripe retry work that already happened.
//
// The read functions are deliberately three-valued, because "no rows" and
// "could not ask" are different facts that the retry logic must not confuse:
// reads return null when the database could not be consulted at all.

const CONNECT_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = 10000;

let pool = null;
let poolFailed = false; // sticky: don't rebuild a pool that can't be built
let warnedNoUrl = false;
let warnedNoDriver = false;

// Lazy, guarded require. If `pg` is missing from node_modules, this module must
// degrade to a no-op rather than crash the whole service at import time —
// facebookApi.js requires this file, and that is on the payment path.
function loadPg() {
  try {
    return require("pg");
  } catch (e) {
    if (!warnedNoDriver) {
      warnedNoDriver = true;
      console.warn("⚠️ adSpendLog: `pg` is not installed — ad-spend logging disabled.");
    }
    return null;
  }
}

// Render's managed Postgres requires SSL. A local cluster (used by the test
// harness) doesn't support it at all, and forcing it there fails the connection
// outright — so SSL is decided from the host rather than hardcoded on.
function sslConfig(connectionString) {
  const str = String(connectionString || "");
  if (/[?&]sslmode=disable\b/.test(str)) return false;
  try {
    const host = new URL(str).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  } catch (_) {
    // Unparseable URL: fall through to the safe default (SSL on).
  }
  return { rejectUnauthorized: false };
}

function getPool() {
  if (poolFailed) return null;
  if (pool) return pool;

  if (!process.env.DATABASE_URL) {
    if (!warnedNoUrl) {
      warnedNoUrl = true;
      console.warn(
        "⚠️ adSpendLog: DATABASE_URL is not set — ad-spend allocations will NOT be recorded."
      );
    }
    return null;
  }

  const pg = loadPg();
  if (!pg) {
    poolFailed = true;
    return null;
  }

  try {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfig(process.env.DATABASE_URL),
      // Small on purpose. This database is a shared 256mb instance whose main
      // consumer is the predictor's dashboard; this service writes a handful of
      // rows per payment and has no business holding connections open.
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      // Both halves of the timeout, set here rather than with a `SET LOCAL`
      // query: SET LOCAL only applies inside a transaction block, and pooled
      // queries run in autocommit, so it would have been silently ignored.
      // statement_timeout is enforced by Postgres, query_timeout by the driver
      // (which also covers a connection that stops responding entirely).
      statement_timeout: QUERY_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
    });

    // An idle-client error must not become an unhandled 'error' event, which
    // would take the process down and with it the webhook endpoint.
    pool.on("error", (err) => {
      console.error("❌ adSpendLog: idle client error:", err.message);
    });

    return pool;
  } catch (e) {
    poolFailed = true;
    console.error("❌ adSpendLog: could not create connection pool:", e.message);
    return null;
  }
}

// Single choke point, so no caller can accidentally let a database problem
// escape into the payment path.
async function safeQuery(sql, params, label) {
  const p = getPool();
  if (!p) return null;

  try {
    // pool.query checks out, runs and releases a client, so a thrown error
    // can't leak a connection the way a hand-rolled connect/release can.
    return await p.query(sql, params);
  } catch (e) {
    console.error(`❌ adSpendLog: ${label} failed:`, e.message);
    return null;
  }
}

function toCents(dollars) {
  const n = Number(dollars);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function intOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Postgres rejects NUL bytes inside text values, and Facebook error bodies are
// arbitrary strings we don't control. Strip them and cap the length so an
// enormous error payload can't be the thing that breaks the insert.
function cleanText(v, max = 2000) {
  if (v === null || v === undefined) return null;
  return String(v).replace(/\u0000/g, "").slice(0, max) || null;
}

function asJson(v) {
  if (v === null || v === undefined) return null;
  try {
    return JSON.stringify(v).replace(/\u0000/g, "").slice(0, 20000);
  } catch (_) {
    return null; // circular or otherwise unserialisable — the row still writes
  }
}

/**
 * Record one allocation attempt against one Facebook object.
 *
 * Resolves true if the row was written, false otherwise (including when the
 * database is unreachable, or when the partial unique index rejected a second
 * 'applied' row for the same invoice+object — which is the guard working, not
 * an error, and is logged as such).
 */
async function recordAllocation(row) {
  if (!row || !row.stripeInvoiceId || !row.fbObjectId) {
    console.warn("⚠️ adSpendLog: refusing to record an allocation without invoice/object id.");
    return false;
  }

  let allocatedCents = toCents(row.allocatedDollars);
  if (allocatedCents === null || allocatedCents < 0) {
    console.warn(
      `⚠️ adSpendLog: unusable allocation amount (${row.allocatedDollars}) for ${row.fbObjectId} — recording as 0.`
    );
    allocatedCents = 0;
  }

  const res = await safeQuery(
    `INSERT INTO ad_spend_allocations
       (stripe_customer_id, stripe_invoice_id, client_name, campaign_type,
        fb_object_type, fb_object_id, allocated_cents,
        previous_budget_cents, new_budget_cents, status, error, raw_response,
        occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      cleanText(row.stripeCustomerId, 255),
      cleanText(row.stripeInvoiceId, 255),
      cleanText(row.clientName, 255),
      cleanText(row.campaignType, 64),
      row.fbObjectType === "campaign" ? "campaign" : "adset",
      cleanText(row.fbObjectId, 255),
      allocatedCents,
      intOrNull(row.previousBudgetCents),
      intOrNull(row.newBudgetCents),
      row.status,
      cleanText(row.error),
      asJson(row.rawResponse),
    ],
    "recordAllocation"
  );

  if (!res) return false;

  if (res.rowCount === 0) {
    // idx_ad_spend_one_applied refused a duplicate 'applied' row: the increase
    // was already recorded as funded for this invoice+object. This is the
    // double-funding guard firing, not a logging failure.
    console.warn(
      `🟡 adSpendLog: ${row.fbObjectId} on ${row.stripeInvoiceId} is already recorded as applied — not duplicated.`
    );
    return false;
  }

  return true;
}

/**
 * Everything the retry guard needs to know about one invoice+object, in one
 * round trip.
 *
 * Returns:
 *   {
 *     hasApplied:     this invoice already funded this object — never do it again
 *     hasNeedsReview: previously flagged for a human; the flag is sticky
 *     attemptCount / failedCount
 *     latest: the most recent attempt, or null if there has never been one
 *   }
 * or null when the database could not be consulted at all.
 *
 * null must never be treated as "no history". "Nothing was applied" and "we
 * don't know what was applied" lead to opposite decisions about whether it is
 * safe to send money to Facebook again.
 *
 * The aggregates use window functions so the latest row and the counts over ALL
 * rows come back together: OVER () spans every row matching the WHERE clause,
 * and is computed before LIMIT trims the result to the newest one.
 */
async function getObjectHistory(stripeInvoiceId, fbObjectId) {
  if (!stripeInvoiceId || !fbObjectId) return null;

  const res = await safeQuery(
    `SELECT status,
            allocated_cents,
            previous_budget_cents,
            new_budget_cents,
            occurred_at,
            COUNT(*)                                     OVER () AS attempt_count,
            COUNT(*) FILTER (WHERE status = 'failed')     OVER () AS failed_count,
            bool_or(status = 'applied')                   OVER () AS has_applied,
            bool_or(status = 'needs_review')              OVER () AS has_needs_review
       FROM ad_spend_allocations
      WHERE stripe_invoice_id = $1
        AND fb_object_id = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [stripeInvoiceId, fbObjectId],
    "getObjectHistory"
  );

  if (!res) return null;

  if (res.rows.length === 0) {
    return { hasApplied: false, hasNeedsReview: false, attemptCount: 0, failedCount: 0, latest: null };
  }

  const r = res.rows[0];
  return {
    hasApplied: Boolean(r.has_applied),
    hasNeedsReview: Boolean(r.has_needs_review),
    attemptCount: Number(r.attempt_count),
    failedCount: Number(r.failed_count),
    latest: {
      status: r.status,
      allocatedCents: intOrNull(r.allocated_cents),
      previousBudgetCents: intOrNull(r.previous_budget_cents),
      newBudgetCents: intOrNull(r.new_budget_cents),
      occurredAt: r.occurred_at,
    },
  };
}

// True when logging is actually wired up. Callers use this to warn loudly at
// boot rather than discovering it silently at the first payment.
function isConfigured() {
  return Boolean(process.env.DATABASE_URL) && !poolFailed;
}

module.exports = {
  recordAllocation,
  getObjectHistory,
  isConfigured,
  // exported for a connectivity check / tests
  _internal: { toCents, cleanText, asJson, intOrNull, safeQuery, sslConfig },
};
