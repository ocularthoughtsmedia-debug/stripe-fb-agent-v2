// ═══════════════════════════════════════════════════════════════
// tests/allocation-guard.test.js
//
// Proves the ad-spend allocation ledger prevents DOUBLE-FUNDING when Stripe
// redelivers a webhook after a partial Facebook failure.
//
// What is REAL here:
//   • the real Postgres schema (db/schema.sql from otm-ad-predictor), loaded
//     into a throwaway local cluster — the partial unique index is enforced by
//     Postgres, not by the test
//   • the real adSpendLog.js talking to that database over pg
//   • the real facebookApi.js guard logic
//   • the real stripeWebhook.js route, mounted on a real express app and called
//     over real HTTP with a real Stripe signature (generateTestHeaderString),
//     so the 200/500 decisions under test are the ones the service will make
//
// What is FAKED:
//   • Facebook. A stateful fake that holds actual budget numbers, applies POSTs
//     to them, and logs every write attempt. The central assertion is against
//     those numbers: if the guard fails, a budget is visibly funded twice.
//   • clients.js (test registry), reminderRunner (no SMS/timers) and
//     reportsStore (in memory, so a deploy wipe can be simulated)
//
// Run:  node tests/allocation-guard.test.js
// Requires DATABASE_URL pointing at a TEST database. It TRUNCATEs tables.
// ═══════════════════════════════════════════════════════════════

const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DEAD_LEDGER_MODE = process.argv.includes("--dead-ledger");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_for_allocation_guard";
process.env.FB_PAGE_ACCESS_TOKEN = "fake-token";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be set to a TEST database. Refusing to run.");
  process.exit(2);
}

// Guard against ever pointing this at production by accident.
if (/render\.com/.test(process.env.DATABASE_URL)) {
  console.error("DATABASE_URL points at Render. This test TRUNCATEs tables. Refusing to run.");
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────
// Assertions
// ─────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`   ✅ ${label}`);
  } else {
    failures.push(label);
    console.log(`   ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Key order must not matter (status tallies) and a numeric budget must compare
// equal whether Facebook handed it back as 56625 or "56625".
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${k}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return String(Number(v));
  return String(v);
}

function eq(label, actual, expected) {
  const a = canonical(actual);
  const e = canonical(expected);
  ok(`${label} (${a})`, a === e, `expected ${e}, got ${a}`);
}

function section(title) {
  console.log(`\n${"─".repeat(74)}\n${title}\n${"─".repeat(74)}`);
}

// ─────────────────────────────────────────────────────────────
// The fake Facebook — stateful, so double-funding is observable
// ─────────────────────────────────────────────────────────────
const fb = {
  budgets: new Map(), // objectId -> lifetime_budget in cents
  writes: [], // every budget write ATTEMPT, successful or not
  endDateWrites: [],
  reads: [],
  failGet: new Set(),
  // objectId -> 'reject' | 'lost_response'
  budgetPostFailures: new Map(),
  failEndDate: new Set(),

  reset(initial) {
    this.budgets = new Map(Object.entries(initial || {}));
    this.writes = [];
    this.endDateWrites = [];
    this.reads = [];
    this.failGet = new Set();
    this.budgetPostFailures = new Map();
    this.failEndDate = new Set();
  },
  budgetOf(id) {
    return this.budgets.get(id);
  },
  // How many times we actually tried to write a budget to this object.
  writeAttempts(id) {
    return this.writes.filter((w) => w.objectId === id).length;
  },
};

function idFromUrl(url) {
  const m = String(url).match(/v19\.0\/([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

function fbGet(url) {
  const id = idFromUrl(url);
  fb.reads.push(id);
  if (fb.failGet.has(id)) throw new Error(`FB GET failed for ${id}`);
  const b = fb.budgets.get(id);
  return { data: { lifetime_budget: b === undefined ? undefined : String(b) } };
}

function fbPost(url, params) {
  const id = idFromUrl(url);

  // End-date extension — no budget involved.
  if (params && params.end_time !== undefined) {
    fb.endDateWrites.push({ objectId: id, endTime: params.end_time });
    if (fb.failEndDate.has(id)) throw new Error(`FB end-date POST failed for ${id}`);
    return { data: { success: true } };
  }

  const target = Number(params.lifetime_budget);
  const mode = fb.budgetPostFailures.get(id);

  if (mode === "reject") {
    // Facebook refused: budget UNCHANGED.
    fb.writes.push({ objectId: id, target, outcome: "rejected" });
    const err = new Error(`FB POST rejected for ${id}`);
    err.response = { data: { error: { message: "transient failure", code: 2 } } };
    throw err;
  }

  if (mode === "lost_response") {
    // The nastiest case: Facebook COMMITS, then the response is lost.
    fb.budgets.set(id, target);
    fb.writes.push({ objectId: id, target, outcome: "applied_but_response_lost" });
    const err = new Error("socket hang up");
    err.code = "ECONNRESET";
    throw err;
  }

  fb.budgets.set(id, target);
  fb.writes.push({ objectId: id, target, outcome: "applied" });
  return { data: { success: true } };
}

const fakeAxios = (cfg) => {
  if (cfg.method === "GET") {
    // Campaign reads pass fields via params, not the query string.
    return Promise.resolve(fbGet(cfg.url));
  }
  return Promise.resolve(fbPost(cfg.url, cfg.params));
};
fakeAxios.get = async (url) => fbGet(url);
fakeAxios.post = async (url, body, cfg) => fbPost(url, cfg.params);

// ─────────────────────────────────────────────────────────────
// Module stubs — installed BEFORE requiring the code under test
// ─────────────────────────────────────────────────────────────
function stub(request, exports) {
  const resolved = require.resolve(request, { paths: [ROOT] });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub("axios", fakeAxios);

// Three adsets at $66.25 — the Big Zaddy's shape from the plan.
const CUSTOMER = "cus_TESTBIGZADDY";
const ADSETS = ["120000000001", "120000000002", "120000000003"];
const INCREASE = 66.25;
const INCREASE_CENTS = 6625;
const START_BUDGET = 50000; // $500.00 on each adset

stub("./clients", {
  [CUSTOMER]: {
    name: "Big Zaddy's Burgers (TEST)",
    phone: "",
    timezone: "America/New_York",
    billing: { cadence: "weekly", paymentsPerCycle: 4, reportDelayDays: 2 },
    campaigns: [{ type: "adset", increase: INCREASE, extendDays: 7, adsets: ADSETS }],
  },
});

const markPaidCalls = [];
stub("./reminderRunner", {
  markPaid: (a) => markPaidCalls.push(a),
  scheduleFailedInvoice: () => {},
  startReminderRunner: () => {},
});

// In-memory reports store, so `wipe()` can simulate a Render deploy resetting
// the ephemeral, git-committed reports.json.
const reportStore = {
  data: new Map(),
  wipe() {
    this.data = new Map();
  },
};
stub("./reportsStore", {
  getClientReportState: (id) =>
    reportStore.data.get(id) || {
      cycleCount: 0,
      cycleStartAt: null,
      lastPaymentAt: null,
      reportScheduledAt: null,
      reportSentAt: null,
      lastInvoiceIdProcessed: null,
      lastInvoiceProcessedAt: null,
    },
  setClientReportState: (id, state) => reportStore.data.set(id, { ...state }),
});

// ─────────────────────────────────────────────────────────────
// The code under test
// ─────────────────────────────────────────────────────────────
const express = require("express");
const Stripe = require("stripe");
const adSpendLog = require(path.join(ROOT, "adSpendLog"));
const stripeWebhookRouter = require(path.join(ROOT, "stripeWebhook"));

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const pg = require("pg");
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: adSpendLog._internal.sslConfig(process.env.DATABASE_URL),
});

let server;
let baseUrl;

function startServer() {
  return new Promise((resolve) => {
    const app = express();
    app.use("/webhook", express.raw({ type: "application/json" }), stripeWebhookRouter);
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/webhook`;
      resolve();
    });
  });
}

// Deliver a genuine, correctly-signed Stripe webhook over HTTP.
async function deliver(invoiceId, { type = "invoice.payment_succeeded" } = {}) {
  const payload = JSON.stringify({
    id: `evt_${invoiceId}_${Math.floor(process.hrtime()[1] / 1000)}`,
    type,
    data: {
      object: {
        id: invoiceId,
        customer: CUSTOMER,
        amount_due: 6625,
        hosted_invoice_url: "https://example.com/pay",
      },
    },
  });

  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });

  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payload,
  });
  return { status: res.status, body: await res.text() };
}

// ─────────────────────────────────────────────────────────────
// Ledger helpers
// ─────────────────────────────────────────────────────────────
async function ledgerRows(invoiceId) {
  const r = await db.query(
    `SELECT fb_object_id, status, allocated_cents, previous_budget_cents, new_budget_cents, error
       FROM ad_spend_allocations
      WHERE stripe_invoice_id = $1
      ORDER BY id`,
    [invoiceId]
  );
  return r.rows;
}

async function appliedCentsTotal(invoiceId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(allocated_cents), 0)::bigint AS total
       FROM ad_spend_allocations
      WHERE stripe_invoice_id = $1 AND status = 'applied'`,
    [invoiceId]
  );
  return Number(r.rows[0].total);
}

function statusCounts(rows) {
  return rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
}

async function resetAll(initialBudgets) {
  await db.query("TRUNCATE ad_spend_allocations");
  fb.reset(initialBudgets);
  reportStore.wipe();
  markPaidCalls.length = 0;
}

function budgetSnapshot() {
  return ADSETS.map((id) => fb.budgetOf(id));
}

// Real FB budget delta across all adsets — the ground truth for money moved.
function totalBudgetDelta(startBudget) {
  return ADSETS.reduce((sum, id) => sum + (Number(fb.budgetOf(id)) - startBudget), 0);
}

// ═══════════════════════════════════════════════════════════════
// PART A — the double-funding scenario
// ═══════════════════════════════════════════════════════════════
async function partA() {
  section("PART A — 3-adset client, adset #3 fails, Stripe redelivers");

  const INVOICE = "in_TEST_PARTA";
  await resetAll({
    [ADSETS[0]]: START_BUDGET,
    [ADSETS[1]]: START_BUDGET,
    [ADSETS[2]]: START_BUDGET,
  });

  // ── Delivery 1: adset #3's budget POST is rejected ──
  console.log("\n▸ Delivery 1 of 1 — adset #3 rejected by Facebook");
  fb.budgetPostFailures.set(ADSETS[2], "reject");

  const d1 = await deliver(INVOICE);

  eq("HTTP 500 so Stripe will redeliver", d1.status, 500);
  eq("adset #1 funded once", fb.budgetOf(ADSETS[0]), String(START_BUDGET + INCREASE_CENTS));
  eq("adset #2 funded once", fb.budgetOf(ADSETS[1]), String(START_BUDGET + INCREASE_CENTS));
  eq("adset #3 NOT funded (POST rejected)", fb.budgetOf(ADSETS[2]), String(START_BUDGET));
  ok(
    "loop continued past the failure (all 3 adsets were attempted)",
    fb.writeAttempts(ADSETS[0]) === 1 && fb.writeAttempts(ADSETS[1]) === 1 && fb.writeAttempts(ADSETS[2]) === 1,
    `attempts: ${ADSETS.map((a) => fb.writeAttempts(a)).join(",")}`
  );
  ok(
    "end dates still extended for all 3 adsets",
    fb.endDateWrites.length === 3,
    `got ${fb.endDateWrites.length}`
  );

  let rows = await ledgerRows(INVOICE);
  eq("ledger: 2 applied + 1 failed", statusCounts(rows), { applied: 2, failed: 1 });

  const failedRow = rows.find((r) => r.status === "failed");
  eq("failed row records the budget it was trying to reach", Number(failedRow.new_budget_cents), START_BUDGET + INCREASE_CENTS);
  eq("failed row records the budget before the attempt", Number(failedRow.previous_budget_cents), START_BUDGET);

  const state1 = reportStore.data.get(CUSTOMER);
  eq("completion marker NOT written (this is the bug that was fixed)", state1.lastInvoiceIdProcessed, null);
  ok("but the payment was still seen/recorded", Boolean(state1.lastInvoiceSeenAt), "lastInvoiceSeenAt missing");
  eq("reminders were stopped", markPaidCalls.length, 1);

  // ── Delivery 2: Stripe redelivers. THE test. ──
  console.log("\n▸ Delivery 2 — Stripe redelivers the SAME invoice; adset #3 now succeeds");
  fb.budgetPostFailures.delete(ADSETS[2]);
  const writesBefore = fb.writes.length;

  const d2 = await deliver(INVOICE);

  eq("HTTP 200 — nothing left to retry", d2.status, 200);

  console.log("\n   ══ THE DOUBLE-FUNDING CHECK ══");
  eq(
    "adset #1 still funded EXACTLY ONCE (not twice)",
    fb.budgetOf(ADSETS[0]),
    String(START_BUDGET + INCREASE_CENTS)
  );
  eq(
    "adset #2 still funded EXACTLY ONCE (not twice)",
    fb.budgetOf(ADSETS[1]),
    String(START_BUDGET + INCREASE_CENTS)
  );
  eq("adset #3 now funded once", fb.budgetOf(ADSETS[2]), String(START_BUDGET + INCREASE_CENTS));

  const newWrites = fb.writes.slice(writesBefore);
  ok(
    "NO second write was even ATTEMPTED for adsets #1 and #2",
    newWrites.every((w) => w.objectId === ADSETS[2]),
    `redelivery wrote to: ${newWrites.map((w) => w.objectId).join(", ") || "(nothing)"}`
  );
  eq("redelivery made exactly 1 budget write, to adset #3", newWrites.length, 1);

  rows = await ledgerRows(INVOICE);
  eq("ledger: 3 applied + 1 failed (both attempts kept)", statusCounts(rows), { applied: 3, failed: 1 });

  eq(
    "ledger total matches money actually moved at Facebook",
    await appliedCentsTotal(INVOICE),
    totalBudgetDelta(START_BUDGET)
  );
  eq("that total is 3 × $66.25", await appliedCentsTotal(INVOICE), INCREASE_CENTS * 3);

  const state2 = reportStore.data.get(CUSTOMER);
  eq("completion marker written now that FB work finished", state2.lastInvoiceIdProcessed, INVOICE);

  // ── Delivery 3: a plain duplicate ──
  console.log("\n▸ Delivery 3 — duplicate delivery after completion (fast path)");
  const before3 = fb.writes.length;
  const d3 = await deliver(INVOICE);
  eq("HTTP 200", d3.status, 200);
  eq("zero budget writes attempted", fb.writes.length - before3, 0);
  eq("budgets unchanged", budgetSnapshot(), [
    String(START_BUDGET + INCREASE_CENTS),
    String(START_BUDGET + INCREASE_CENTS),
    String(START_BUDGET + INCREASE_CENTS),
  ]);

  // ── Delivery 4: deploy wipes reports.json, then Stripe redelivers ──
  console.log("\n▸ Delivery 4 — Render deploy wipes reports.json, then a redelivery arrives");
  reportStore.wipe(); // exactly what a deploy does to the committed reports.json
  const before4 = fb.writes.length;

  const d4 = await deliver(INVOICE);

  eq("HTTP 200", d4.status, 200);
  ok(
    "fast path was GONE (the handler re-read Facebook, proving it did not short-circuit)",
    fb.reads.length > 0,
    "no reads recorded"
  );
  eq("still ZERO budget writes — Postgres guard held without reports.json", fb.writes.length - before4, 0);
  eq("budgets STILL funded exactly once each", budgetSnapshot(), [
    String(START_BUDGET + INCREASE_CENTS),
    String(START_BUDGET + INCREASE_CENTS),
    String(START_BUDGET + INCREASE_CENTS),
  ]);
  eq("ledger unchanged", statusCounts(await ledgerRows(INVOICE)), { applied: 3, failed: 1 });
}

// ═══════════════════════════════════════════════════════════════
// PART B — Facebook committed, response lost
// ═══════════════════════════════════════════════════════════════
async function partB() {
  section("PART B — Facebook applied the increase but the response was lost");

  const INVOICE = "in_TEST_PARTB";
  await resetAll({
    [ADSETS[0]]: START_BUDGET,
    [ADSETS[1]]: START_BUDGET,
    [ADSETS[2]]: START_BUDGET,
  });

  // adset #1 commits at Facebook, then the connection dies.
  fb.budgetPostFailures.set(ADSETS[0], "lost_response");

  console.log("\n▸ Delivery 1 — adset #1's POST lands at Facebook, response never arrives");
  const d1 = await deliver(INVOICE);

  eq("HTTP 500 (we believe it failed)", d1.status, 500);
  eq(
    "Facebook DID apply it",
    fb.budgetOf(ADSETS[0]),
    String(START_BUDGET + INCREASE_CENTS)
  );
  const rows1 = await ledgerRows(INVOICE);
  eq("we recorded it as failed", statusCounts(rows1), { applied: 2, failed: 1 });

  console.log("\n▸ Delivery 2 — redelivery must NOT add a second increase");
  fb.budgetPostFailures.delete(ADSETS[0]);
  const writesBefore = fb.writes.length;

  const d2 = await deliver(INVOICE);

  eq("HTTP 200", d2.status, 200);
  eq(
    "adset #1 funded exactly once — NOT $132.50",
    fb.budgetOf(ADSETS[0]),
    String(START_BUDGET + INCREASE_CENTS)
  );
  eq("no further budget write attempted", fb.writes.length - writesBefore, 0);

  const rows2 = await ledgerRows(INVOICE);
  eq("the failed row was reconciled to applied", statusCounts(rows2), { applied: 3, failed: 1 });
  const reconciled = rows2.filter((r) => r.status === "applied" && r.fb_object_id === ADSETS[0]);
  ok(
    "reconciliation is recorded with its reasoning",
    reconciled.length === 1 && /reconciled/i.test(reconciled[0].error || ""),
    `error text: ${reconciled[0] && reconciled[0].error}`
  );
  eq(
    "ledger total still matches Facebook reality",
    await appliedCentsTotal(INVOICE),
    totalBudgetDelta(START_BUDGET)
  );
}

// ═══════════════════════════════════════════════════════════════
// PART C — someone edits the budget in Ads Manager
// ═══════════════════════════════════════════════════════════════
async function partC() {
  section("PART C — budget edited in Ads Manager between attempts → needs_review");

  const INVOICE = "in_TEST_PARTC";
  await resetAll({
    [ADSETS[0]]: START_BUDGET,
    [ADSETS[1]]: START_BUDGET,
    [ADSETS[2]]: START_BUDGET,
  });

  fb.budgetPostFailures.set(ADSETS[0], "reject");
  console.log("\n▸ Delivery 1 — adset #1 rejected");
  await deliver(INVOICE);
  eq("recorded failed", statusCounts(await ledgerRows(INVOICE)), { applied: 2, failed: 1 });

  console.log("\n▸ Carl edits adset #1's budget by hand in Ads Manager ($500 → $712.34)");
  fb.budgets.set(ADSETS[0], 71234);
  fb.budgetPostFailures.delete(ADSETS[0]);
  const writesBefore = fb.writes.length;

  console.log("▸ Delivery 2 — the increase can no longer be proven either way");
  const d2 = await deliver(INVOICE);

  eq("no budget write attempted — refuses to guess", fb.writes.length - writesBefore, 0);
  eq("manual value untouched", fb.budgetOf(ADSETS[0]), 71234);
  const rows = await ledgerRows(INVOICE);
  eq("flagged needs_review", statusCounts(rows), { applied: 2, failed: 1, needs_review: 1 });
  eq("HTTP 200 — a retry cannot resolve this", d2.status, 200);

  console.log("▸ Delivery 3 — plain duplicate: short-circuits on the fast path");
  const before3 = fb.writes.length;
  const readsBefore3 = fb.reads.length;
  await deliver(INVOICE);
  eq("no budget write", fb.writes.length - before3, 0);
  eq("did not even read Facebook — completion marker stopped it", fb.reads.length - readsBefore3, 0);
  eq("ledger untouched", statusCounts(await ledgerRows(INVOICE)), {
    applied: 2,
    failed: 1,
    needs_review: 1,
  });

  // The fast path is what stopped delivery 3, so the sticky branch has not
  // actually been exercised yet. Wipe reports.json (a deploy) to force the
  // handler to re-evaluate from the ledger alone.
  console.log("▸ Delivery 4 — deploy wipe forces re-evaluation: the flag must be STICKY");
  reportStore.wipe();
  const before4 = fb.writes.length;
  await deliver(INVOICE);
  eq("still no budget write", fb.writes.length - before4, 0);
  ok("it did re-read Facebook this time", fb.reads.length > readsBefore3, "no new reads");
  const rows4 = await ledgerRows(INVOICE);
  eq("flagged again rather than silently applied", statusCounts(rows4), {
    applied: 2,
    failed: 1,
    needs_review: 2,
  });
  ok(
    "adset #1 never got an 'applied' row",
    !rows4.some((r) => r.fb_object_id === ADSETS[0] && r.status === "applied"),
    "an applied row appeared"
  );
  eq("manual value still untouched after both redeliveries", fb.budgetOf(ADSETS[0]), 71234);
}

// ═══════════════════════════════════════════════════════════════
// PART D — the database itself refuses a double 'applied'
// ═══════════════════════════════════════════════════════════════
async function partD() {
  section("PART D — Postgres enforces the invariant, not just the app code");

  await db.query("TRUNCATE ad_spend_allocations");

  const insert = (status) =>
    db.query(
      `INSERT INTO ad_spend_allocations
         (stripe_customer_id, stripe_invoice_id, fb_object_type, fb_object_id,
          allocated_cents, status)
       VALUES ('cus_X', 'in_DB', 'adset', '999', 6625, $1)`,
      [status]
    );

  await insert("applied");
  let rejected = false;
  let message = "";
  try {
    await insert("applied");
  } catch (e) {
    rejected = true;
    message = e.message;
  }
  ok("a second 'applied' row for the same invoice+object is REJECTED", rejected, "it was accepted");
  ok(
    "rejected by idx_ad_spend_one_applied specifically",
    /idx_ad_spend_one_applied/.test(message),
    message
  );

  // Failures must still be free to accumulate.
  await insert("failed");
  await insert("failed");
  await insert("needs_review");
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM ad_spend_allocations WHERE stripe_invoice_id = 'in_DB'`
  );
  eq("failed / needs_review rows accumulate freely (attempt history kept)", r.rows[0].n, 4);

  await db.query("TRUNCATE ad_spend_allocations");
}

// ═══════════════════════════════════════════════════════════════
// PART E — ledger unreachable: must NOT ask Stripe to retry
// (runs in a child process so adSpendLog gets a dead DATABASE_URL)
// ═══════════════════════════════════════════════════════════════
async function partEChild() {
  const INVOICE = "in_TEST_PARTE";
  fb.reset({
    [ADSETS[0]]: START_BUDGET,
    [ADSETS[1]]: START_BUDGET,
    [ADSETS[2]]: START_BUDGET,
  });
  reportStore.wipe();

  fb.budgetPostFailures.set(ADSETS[2], "reject");
  const d1 = await deliver(INVOICE);

  const state = reportStore.data.get(CUSTOMER);
  const result = {
    status: d1.status,
    adset3Budget: String(fb.budgetOf(ADSETS[2])),
    adset1Budget: String(fb.budgetOf(ADSETS[0])),
    markerSet: state.lastInvoiceIdProcessed === INVOICE,
  };
  console.log(`__CHILD_RESULT__${JSON.stringify(result)}`);
}

function partE() {
  section("PART E — ledger unreachable during a partial failure");
  console.log("   (child process, DATABASE_URL pointed at a dead port)\n");

  const res = spawnSync(
    process.execPath,
    [__filename, "--dead-ledger"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:59998/dead",
      },
      encoding: "utf8",
    }
  );

  const line = (res.stdout || "").split("\n").find((l) => l.includes("__CHILD_RESULT__"));
  if (!line) {
    failures.push("PART E child did not report a result");
    console.log("   ❌ child produced no result");
    console.log((res.stdout || "").slice(-1500));
    console.log((res.stderr || "").slice(-800));
    return;
  }

  const out = JSON.parse(line.split("__CHILD_RESULT__")[1]);
  eq("HTTP 200, NOT 500 — a retry would be unsafe without the ledger", out.status, 200);
  eq("the successful increase still went through", out.adset1Budget, String(START_BUDGET + INCREASE_CENTS));
  eq("the failed one did not", out.adset3Budget, String(START_BUDGET));
  ok("completion marker written to stop an unsafe redelivery", out.markerSet, "marker not set");
}

// ═══════════════════════════════════════════════════════════════
// PART F — NEGATIVE CONTROL
//
// Everything above shows the guard holding. That alone doesn't prove the guard
// is what's holding it — the redelivery might be harmless for some other
// reason. So: blind the guard (exactly the behaviour before this work) and
// confirm the double-funding really does appear. If this part shows single
// funding, then Part A proves nothing and the assertions there are decoration.
// ═══════════════════════════════════════════════════════════════
async function partF() {
  section("PART F — negative control: with the guard blinded, does it double-fund?");

  const INVOICE = "in_TEST_PARTF";
  await resetAll({
    [ADSETS[0]]: START_BUDGET,
    [ADSETS[1]]: START_BUDGET,
    [ADSETS[2]]: START_BUDGET,
  });

  console.log("\n▸ Delivery 1 — adset #3 rejected (identical to Part A)");
  fb.budgetPostFailures.set(ADSETS[2], "reject");
  const d1 = await deliver(INVOICE);
  eq("HTTP 500", d1.status, 500);
  eq("adsets #1/#2 funded once", [fb.budgetOf(ADSETS[0]), fb.budgetOf(ADSETS[1])], [
    START_BUDGET + INCREASE_CENTS,
    START_BUDGET + INCREASE_CENTS,
  ]);

  console.log("\n▸ Blinding the guard (simulating the pre-ledger code) and redelivering");
  const realGetObjectHistory = adSpendLog.getObjectHistory;
  adSpendLog.getObjectHistory = async () => ({
    hasApplied: false,
    hasNeedsReview: false,
    attemptCount: 0,
    failedCount: 0,
    latest: null,
  });
  fb.budgetPostFailures.delete(ADSETS[2]);

  try {
    await deliver(INVOICE);
  } finally {
    adSpendLog.getObjectHistory = realGetObjectHistory;
  }

  console.log("\n   ══ CONTROL: the bug must be visible here ══");
  eq(
    "adset #1 got a SECOND $66.25 — double-funded",
    fb.budgetOf(ADSETS[0]),
    START_BUDGET + INCREASE_CENTS * 2
  );
  eq(
    "adset #2 got a SECOND $66.25 — double-funded",
    fb.budgetOf(ADSETS[1]),
    START_BUDGET + INCREASE_CENTS * 2
  );
  eq("two write attempts on adset #1, versus one in Part A", fb.writeAttempts(ADSETS[0]), 2);
  eq(
    "$132.50 of unintended spend across the two adsets",
    totalBudgetDelta(START_BUDGET) - INCREASE_CENTS * 3,
    13250
  );

  // Postgres still refuses to RECORD the duplicate, so the ledger and Facebook
  // now disagree — which is exactly the signature of a broken guard.
  const rows = await ledgerRows(INVOICE);
  eq("the database still refused the duplicate 'applied' rows", statusCounts(rows), {
    applied: 3,
    failed: 1,
  });
  ok(
    "ledger total no longer matches Facebook — the divergence a broken guard causes",
    (await appliedCentsTotal(INVOICE)) !== totalBudgetDelta(START_BUDGET),
    "they still matched, so the control did not reproduce the bug"
  );
  console.log(
    `      ledger says ${await appliedCentsTotal(INVOICE)} cents, Facebook moved ${totalBudgetDelta(START_BUDGET)} cents`
  );
}

// ═══════════════════════════════════════════════════════════════
async function main() {
  await startServer();

  if (DEAD_LEDGER_MODE) {
    await partEChild();
    server.close();
    return;
  }

  console.log("Allocation guard — double-funding proof");
  console.log(`Database: ${new URL(process.env.DATABASE_URL).host}`);

  try {
    await partA();
    await partB();
    await partC();
    await partD();
    partE();
    await partF();
  } finally {
    server.close();
    await db.end();
  }

  console.log(`\n${"═".repeat(74)}`);
  if (failures.length === 0) {
    console.log(`ALL ${passed} ASSERTIONS PASSED`);
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`);
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  }
  console.log("═".repeat(74));

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nHARNESS ERROR:", e);
  process.exit(3);
});
