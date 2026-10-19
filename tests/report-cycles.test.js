// ═══════════════════════════════════════════════════════════════
// tests/report-cycles.test.js
//
// End-to-end lifecycle of the 30-day report system against a REAL Postgres
// (the real migration from otm-ad-predictor), with a SIMULATED CLOCK.
//
// REAL:  migration DDL, reportCycleStore SQL, reportRunner state machine,
//        stripeWebhook route over HTTP with real Stripe signatures,
//        reportFormat, metaInsights parsing / aggregation requests
// FAKE:  Meta (canned insights), Twilio (records calls, can fail on demand),
//        Facebook budget path and reminders (stubbed: never called for real)
//
// Run:   DATABASE_URL=postgres://postgres@127.0.0.1:55432/report_test node tests/report-cycles.test.js
// Refuses to run against anything but localhost: it DROPs the report tables.
// ═══════════════════════════════════════════════════════════════

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const MIGRATION =
  process.env.REPORT_MIGRATION_PATH ||
  path.join(ROOT, "..", "otm-ad-predictor", "db", "migrations", "2026-10-19_report_cycles.sql");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must point at a local TEST database. Refusing to run.");
  process.exit(2);
}
const dbHost = new URL(process.env.DATABASE_URL).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(dbHost)) {
  console.error(`DATABASE_URL host is ${dbHost}. This test DROPs tables — local databases only.`);
  process.exit(2);
}

process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_report_cycles_test";
// Must be set before stripeWebhook loads its report config.
process.env.REPORT_PERIOD_DAYS = "30";
process.env.REPORT_CONTIGUOUS_GAP_DAYS = "7";
process.env.REPORT_SEND_WINDOW_START_HOUR = "10";

// ─────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`   ✅ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`   ❌ ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`);
  }
}

function stub(request, exports) {
  const resolved = require.resolve(path.join(ROOT, request));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Registry. Phones are 555-01xx fiction numbers.
const CLIENTS = {
  cus_A: {
    name: "Alice Owner - Alpha Grill (Atlanta, GA)",
    phone: "+15555550101",
    timezone: "America/New_York",
    billing: { cadence: "weekly", paymentsPerCycle: 4, reportDelayDays: 2 },
    analytics: { level: "campaign", campaignIds: ["111111111111"] },
    campaigns: [],
  },
  cus_B: {
    name: "Bob Owner - Bravo BBQ (Dallas, TX)",
    phone: "+15555550102",
    timezone: "America/Chicago",
    billing: { cadence: "weekly", paymentsPerCycle: 4, reportDelayDays: 2 },
    analytics: { level: "campaign", campaignIds: ["222222222222"] },
    campaigns: [],
  },
  cus_NOPHONE: {
    name: "No Phone Diner",
    phone: "",
    timezone: "America/New_York",
    billing: { cadence: "weekly", reportDelayDays: 2 },
    analytics: { campaignIds: ["555555555555"] },
    campaigns: [],
  },
  cus_BADIDS: {
    name: "Bad Ids Cafe",
    phone: "+15555550104",
    timezone: "America/New_York",
    billing: { cadence: "weekly", reportDelayDays: 2 },
    analytics: { campaignIds: [] },
    campaigns: [],
  },
  cus_MONTHLY: {
    name: "Mona Owner - Monthly Kitchen",
    phone: "+15555550105",
    timezone: "America/New_York",
    billing: { cadence: "monthly", paymentsPerCycle: 1, reportDelayDays: 2 },
    analytics: { campaignIds: ["666666666666"] },
    campaigns: [],
  },
  cus_MULTI: {
    name: "Multi Owner - Multi Campaign Tacos",
    phone: "+15555550106",
    timezone: "America/New_York",
    billing: { cadence: "weekly", reportDelayDays: 2 },
    analytics: { campaignIds: ["333333333333", "444444444444"] },
    campaigns: [],
  },
};
stub("./clients", CLIENTS);

// The Facebook money path must never run for real in this test.
const fbCalls = [];
stub("./facebookApi", {
  handleRegistryClientUpdate: async (client, meta) => {
    fbCalls.push({ client: client.name, ...meta });
    return { applied: 1, skipped: 0, retryable: 0, needsReview: 0, ledgerAvailable: true };
  },
});
stub("./reminderRunner", { markPaid: () => {}, scheduleFailedInvoice: () => {}, startReminderRunner: () => {} });
const legacyStore = new Map();
stub("./reportsStore", {
  getClientReportState: (id) => ({ ...(legacyStore.get(id) || {}) }),
  setClientReportState: (id, s) => legacyStore.set(id, { ...s }),
});

const db = require(path.join(ROOT, "reportDb"));
const store = require(path.join(ROOT, "reportCycleStore"));
const { createReportRunner, loadConfig } = require(path.join(ROOT, "reportRunner"));
const metaInsights = require(path.join(ROOT, "metaInsights"));

// ─────────────────────────────────────────────────────────────
// Simulated clock, fake Meta, fake Twilio, captured logs
// ─────────────────────────────────────────────────────────────
let NOW = new Date("2026-09-01T14:00:00Z");
const clock = () => new Date(NOW);
const at = (iso) => (NOW = new Date(iso));

function insightsRow(seed) {
  return {
    reach: String(10000 + seed),
    impressions: String(30000 + seed),
    frequency: "3.0",
    unique_inline_link_clicks: String(100 + seed),
    actions: [
      { action_type: "video_view", value: String(8000 + seed) },
      { action_type: "post_reaction", value: "200" },
      { action_type: "comment", value: "30" },
      { action_type: "post", value: "12" },
    ],
    video_thruplay_watched_actions: [{ action_type: "video_view", value: String(5000 + seed) }],
  };
}

const metaBehaviour = {}; // campaignId -> "ok" | "fail" | "invalid" | "zero"
const metaCalls = [];
async function fakeFetchMetrics({ campaignIds, since, until }) {
  metaCalls.push({ campaignIds, since, until });
  const mode = metaBehaviour[campaignIds[0]] || "ok";
  if (mode === "fail") throw new metaInsights.MetaInsightsError("Meta API error 2: Service temporarily unavailable");
  if (mode === "invalid") throw new metaInsights.MetaInsightsError("Meta API error 100: bad field", { retryable: false });
  const row = mode === "zero" ? null : insightsRow(Number(campaignIds[0].slice(0, 1)));
  return {
    metrics: metaInsights.parseInsightsRow(row),
    reachIsDeduplicated: true,
    query: { level: "campaign", campaignIds, since, until },
  };
}

const sms = [];
let twilioMode = "ok"; // ok | reject | optout | ratelimit | timeout | nosid
async function fakeSendSms(to, body) {
  if (twilioMode === "reject") throw Object.assign(new Error("The 'To' number is not valid"), { status: 400, code: 21211 });
  if (twilioMode === "optout") throw Object.assign(new Error("Attempt to send to unsubscribed recipient"), { status: 400, code: 21610 });
  if (twilioMode === "ratelimit") throw Object.assign(new Error("Too many requests"), { status: 429, code: 20429 });
  if (twilioMode === "timeout") throw Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" });
  sms.push({ to, body, at: clock().toISOString() });
  if (twilioMode === "nosid") return {};
  return { sid: `SM${String(sms.length).padStart(32, "0")}` };
}

const logs = [];
const logger = {
  log: (m) => logs.push(["log", m]),
  warn: (m) => logs.push(["warn", m]),
  error: (m) => logs.push(["error", m]),
};

const LIVE = { ...loadConfig({ REPORTS_DRY_RUN: "false", TWILIO_MESSAGING_SERVICE_SID: "MGtest" }) };
const DRY = { ...loadConfig({ REPORTS_DRY_RUN: "true", TWILIO_MESSAGING_SERVICE_SID: "MGtest" }) };

function runner(config = LIVE, over = {}) {
  return createReportRunner({ store, clients: CLIENTS, sendSms: fakeSendSms, fetchMetrics: fakeFetchMetrics, clock, config, logger, ...over });
}

function pay(customerId, invoiceId, paidAtISO, client = CLIENTS[customerId]) {
  return store.recordPayment({ customerId, invoiceId, paidAt: new Date(paidAtISO), client, now: clock(), config: LIVE });
}

// A weekly client in good standing: five weekly invoices across the period,
// so the 14-day payment grace check passes when the report comes due.
async function payWeekly(customerId, startISODate, weeks = 5) {
  const start = new Date(`${startISODate}T15:00:00Z`).getTime();
  for (let w = 0; w < weeks; w++) {
    await pay(customerId, `in_${customerId}_${startISODate}_w${w}`, new Date(start + w * 7 * 86400000).toISOString());
  }
}

async function cycles(customerId) {
  const r = await db.query(
    `SELECT id, status, period_start::text AS ps, period_end::text AS pe, report_due_at, attempt_count,
            next_attempt_at, hold_reason, last_error, twilio_sid, sms_body, last_preview_at, metrics
       FROM report_cycles WHERE stripe_customer_id = $1 ORDER BY period_start`,
    [customerId]
  );
  return r.rows;
}

const smsTo = (phone) => sms.filter((m) => m.to === phone);

async function resetDb() {
  await db.query("TRUNCATE report_payments, report_cycles RESTART IDENTITY");
  sms.length = 0;
  metaCalls.length = 0;
  logs.length = 0;
  twilioMode = "ok";
  for (const k of Object.keys(metaBehaviour)) delete metaBehaviour[k];
}

// ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`Database: ${new URL(process.env.DATABASE_URL).host}`);
  console.log(`Migration: ${MIGRATION}`);

  console.log("\n▸ Migration");
  await db.query("DROP TABLE IF EXISTS report_payments, report_cycles");
  const ddl = fs.readFileSync(MIGRATION, "utf8");

  await test("migration applies cleanly, and is idempotent (second run is a no-op)", async () => {
    await db.query(ddl);
    await db.query(ddl);
    const t = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('report_cycles','report_payments') ORDER BY 1"
    );
    assert.deepStrictEqual(t.rows.map((r) => r.table_name), ["report_cycles", "report_payments"]);
  });

  await test("database rejects an unknown status", async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO report_cycles (stripe_customer_id, timezone, period_start, period_end, report_due_at, opened_by_invoice_id, status)
         VALUES ('x','UTC','2026-01-01','2026-01-30',NOW(),'in_x','bogus')`
      ),
      /check constraint/
    );
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ Scheduling from payments");
  await resetDb();

  await test("first payment opens a 30-day cycle; due period_end+1+2 days at 10:00 local", async () => {
    at("2026-09-01T14:00:00Z");
    const r = await pay("cus_A", "in_A1", "2026-09-01T13:30:00Z");
    assert.strictEqual(r.outcome, "cycle_opened");
    const [c] = await cycles("cus_A");
    assert.strictEqual(c.ps, "2026-09-01");
    assert.strictEqual(c.pe, "2026-09-30");
    assert.strictEqual(c.status, "scheduled");
    // Oct 3, 10:00 America/New_York (EDT, UTC-4)
    assert.strictEqual(new Date(c.report_due_at).toISOString(), "2026-10-03T14:00:00.000Z");
  });

  await test("timezone decides the calendar date (late-evening Chicago payment)", async () => {
    // 2026-09-02T03:30Z is still Sept 1 in Chicago.
    await pay("cus_B", "in_B1", "2026-09-02T03:30:00Z");
    const [c] = await cycles("cus_B");
    assert.strictEqual(c.ps, "2026-09-01");
    assert.strictEqual(new Date(c.report_due_at).toISOString(), "2026-10-03T15:00:00.000Z"); // 10:00 CDT
  });

  await test("duplicate webhook for the same invoice changes nothing", async () => {
    const r = await pay("cus_A", "in_A1", "2026-09-01T13:30:00Z");
    assert.strictEqual(r.outcome, "duplicate");
    assert.strictEqual((await cycles("cus_A")).length, 1);
  });

  await test("5 concurrent deliveries of a NEW invoice → exactly one payment, one cycle", async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => pay("cus_MONTHLY", "in_M1", "2026-09-01T15:00:00Z")));
    assert.strictEqual(rs.filter((r) => r.outcome === "cycle_opened").length, 1);
    assert.strictEqual(rs.filter((r) => r.outcome === "duplicate").length, 4);
    assert.strictEqual((await cycles("cus_MONTHLY")).length, 1);
    const p = await db.query("SELECT COUNT(*)::int n FROM report_payments WHERE stripe_customer_id='cus_MONTHLY'");
    assert.strictEqual(p.rows[0].n, 1);
  });

  await test("weekly payments inside the period stay in the same cycle", async () => {
    for (const [inv, d] of [["in_A2", "08"], ["in_A3", "15"], ["in_A4", "22"], ["in_A5", "29"]]) {
      const r = await pay("cus_A", inv, `2026-09-${d}T13:30:00Z`);
      assert.strictEqual(r.outcome, "within_cycle", inv);
    }
    assert.strictEqual((await cycles("cus_A")).length, 1);
  });

  await test("two concurrent different-invoice payments in a gap open ONE cycle (advisory lock)", async () => {
    const rs = await Promise.all([
      pay("cus_MULTI", "in_X1", "2026-09-01T15:00:00Z"),
      pay("cus_MULTI", "in_X2", "2026-09-01T16:00:00Z"),
    ]);
    assert.deepStrictEqual(rs.map((r) => r.outcome).sort(), ["cycle_opened", "within_cycle"]);
    assert.strictEqual((await cycles("cus_MULTI")).length, 1);
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ Sending");

  await test("nothing is sent before the due time", async () => {
    at("2026-10-03T13:59:00Z");
    await runner().tick();
    assert.strictEqual(sms.length, 0);
  });

  await test("due but outside the local send window → waits (no send, no hold)", async () => {
    // Make cus_A due at 08:00 local by moving the clock to a day later 06:00 local.
    at("2026-10-04T10:00:00Z"); // 06:00 New York
    await runner().tick();
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 0);
    const [c] = await cycles("cus_A");
    assert.strictEqual(c.status, "scheduled");
    assert.strictEqual(c.hold_reason, null);
  });

  await test("in the window → the report is sent exactly once, to the client's phone", async () => {
    at("2026-10-04T14:05:00Z");
    await runner().tick();
    const a = smsTo(CLIENTS.cus_A.phone);
    assert.strictEqual(a.length, 1);
    const [c] = await cycles("cus_A");
    assert.strictEqual(c.status, "sent");
    assert.ok(c.twilio_sid.startsWith("SM"));
    assert.strictEqual(c.sms_body, a[0].body);
    assert.ok(a[0].body.includes("Restaurant: Alpha Grill"));
    assert.ok(a[0].body.includes("Period: Sep 1 - Sep 30, 2026"));
    assert.ok(a[0].body.includes("THRUPLAYS: 5,001"));
    assert.ok(!/\$|spend|cost|budget/i.test(a[0].body));
    assert.ok(a[0].body.includes("Estimated Potential Customer Visits: 50-80\nHypothetical:"), "visit estimate is on by default");
  });

  await test("Meta was queried for exactly the cycle's complete days", async () => {
    const q = metaCalls.find((m) => m.campaignIds[0] === "111111111111");
    assert.deepStrictEqual([q.since, q.until], ["2026-09-01", "2026-09-30"]);
    assert.ok(new Date("2026-09-30T23:59:59-04:00") < clock(), "period end must be a completed day");
  });

  await test("audit metrics stored without any financial field", async () => {
    const [c] = await cycles("cus_A");
    assert.ok(!/spend|cost|cpm|cpc|budget|roas/i.test(JSON.stringify(c.metrics)));
    assert.strictEqual(c.metrics.thruplays, 5001);
  });

  await test("further ticks never resend", async () => {
    for (const h of [15, 16, 17]) {
      at(`2026-10-04T${h}:00:00Z`);
      await runner().tick();
    }
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 1);
  });

  await test("REDEPLOY: fresh pool + fresh runner → still not resent; schedules intact", async () => {
    await db.close(); // what a Render deploy does to every in-process connection
    at("2026-10-04T18:00:00Z");
    await runner().tick();
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 1);
    assert.strictEqual((await cycles("cus_A"))[0].status, "sent");
  });

  await test("two runner instances ticking at the same moment → one message", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_B", "2026-09-01");
    at("2026-10-03T16:00:00Z"); // 11:00 Chicago
    await Promise.all([runner().tick(), runner().tick(), runner().tick()]);
    assert.strictEqual(smsTo(CLIENTS.cus_B.phone).length, 1);
  });

  await test("overlapping ticks on ONE runner are skipped, not doubled", async () => {
    const r = runner();
    const [x, y] = await Promise.all([r.tick(), r.tick()]);
    assert.ok(x.skipped || y.skipped);
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ Recurring cycles");

  await test("cycle 2 opens contiguously when the next payment comes after period end", async () => {
    // cus_B cycle 1 is Sep 1..Sep 30. Weekly payer pays Oct 6 (6 days after).
    at("2026-10-06T15:00:00Z");
    const r = await pay("cus_B", "in_B6", "2026-10-06T15:00:00Z");
    assert.strictEqual(r.outcome, "cycle_opened");
    const cs = await cycles("cus_B");
    assert.strictEqual(cs.length, 2);
    assert.deepStrictEqual([cs[1].ps, cs[1].pe], ["2026-10-01", "2026-10-30"]);
  });

  await test("cycle 2 report is sent too (not a one-per-lifetime report)", async () => {
    for (const d of ["13", "20", "27"]) await pay("cus_B", `in_B_oct${d}`, `2026-10-${d}T15:00:00Z`);
    at("2026-11-02T16:00:00Z"); // Oct 30 + 1 + 2 = Nov 2, 10:00 CST = 16:00Z
    await runner().tick();
    assert.strictEqual(smsTo(CLIENTS.cus_B.phone).length, 2);
    assert.deepStrictEqual((await cycles("cus_B")).map((c) => c.status), ["sent", "sent"]);
  });

  await test("after a long lapse the next cycle starts at the payment date, not contiguously", async () => {
    at("2027-01-10T15:00:00Z");
    await pay("cus_B", "in_B_late", "2027-01-10T15:00:00Z");
    const cs = await cycles("cus_B");
    assert.deepStrictEqual([cs[2].ps, cs[2].pe], ["2027-01-10", "2027-02-08"]);
  });

  await test("an old invoice redelivered after a newer cycle opened → recorded, no new cycle", async () => {
    const r = await pay("cus_B", "in_B_old", "2026-08-15T15:00:00Z");
    assert.strictEqual(r.outcome, "out_of_order");
    assert.strictEqual((await cycles("cus_B")).length, 3);
  });

  await test("a payment recorded so late its cycle is already due → needs_review, never sent", async () => {
    await resetDb();
    at("2026-12-01T15:00:00Z");
    await pay("cus_A", "in_A_backfill", "2026-09-01T15:00:00Z");
    const [c] = await cycles("cus_A");
    assert.strictEqual(c.status, "needs_review");
    await runner().tick();
    assert.strictEqual(sms.length, 0);
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ Eligibility");
  await resetDb();
  at("2026-09-01T14:00:00Z");
  await pay("cus_NOPHONE", "in_N1", "2026-09-01T15:00:00Z");
  await pay("cus_BADIDS", "in_D1", "2026-09-01T15:00:00Z");
  await pay("cus_A", "in_A1", "2026-09-01T15:00:00Z"); // weekly, then STOPS paying
  await pay("cus_MONTHLY", "in_M1", "2026-09-01T15:00:00Z"); // monthly, single payment

  await test("missing phone / invalid campaign IDs → held with a reason, logged ONCE", async () => {
    at("2026-10-03T14:30:00Z");
    for (let i = 0; i < 3; i++) await runner().tick();
    assert.strictEqual((await cycles("cus_NOPHONE"))[0].hold_reason, "missing_or_invalid_phone");
    assert.strictEqual((await cycles("cus_BADIDS"))[0].hold_reason, "missing_or_invalid_campaign_ids");
    assert.strictEqual(logs.filter(([, m]) => /No Phone Diner.*held/.test(m)).length, 1);
  });

  await test("weekly client with no payment in 14 days → held as payment_overdue, not sent", async () => {
    const [c] = await cycles("cus_A");
    assert.match(c.hold_reason, /^payment_overdue/);
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 0);
  });

  await test("monthly client paid 32 days ago is still inside its 45-day grace → sent", async () => {
    assert.strictEqual(smsTo(CLIENTS.cus_MONTHLY.phone).length, 1);
  });

  await test("held client that pays is sent on the next tick (hold clears)", async () => {
    at("2026-10-03T15:00:00Z");
    await pay("cus_A", "in_A_catchup", "2026-10-03T14:55:00Z");
    await runner().tick();
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 1);
  });

  await test("a cycle held beyond REPORT_MAX_LATE_HOURS goes to needs_review, never auto-sent", async () => {
    at("2026-10-06T15:00:00Z"); // > 72h after Oct 3 10:00
    await runner().tick();
    assert.strictEqual((await cycles("cus_NOPHONE"))[0].status, "needs_review");
    assert.strictEqual((await cycles("cus_BADIDS"))[0].status, "needs_review");
  });

  await test("client removed from the registry → held, not crashed", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await store.recordPayment({
      customerId: "cus_GONE", invoiceId: "in_G1", paidAt: new Date("2026-09-01T15:00:00Z"),
      client: { name: "Gone", timezone: "America/New_York", billing: { reportDelayDays: 2 } }, now: clock(), config: LIVE,
    });
    at("2026-10-03T15:00:00Z");
    await runner().tick();
    const r = await db.query("SELECT hold_reason FROM report_cycles WHERE stripe_customer_id='cus_GONE'");
    assert.strictEqual(r.rows[0].hold_reason, "client_not_in_registry");
  });

  await test("live sends are held when TWILIO_MESSAGING_SERVICE_SID is missing", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    at("2026-10-03T15:00:00Z");
    await runner(loadConfig({ REPORTS_DRY_RUN: "false" })).tick();
    assert.strictEqual(sms.length, 0);
    assert.strictEqual((await cycles("cus_A"))[0].hold_reason, "twilio_messaging_service_not_configured");
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ Failures and recovery");

  await test("one client's Meta failure does not stop another client's report", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    await pay("cus_MONTHLY", "in_M1", "2026-09-01T15:00:00Z");
    metaBehaviour["111111111111"] = "fail";
    at("2026-10-03T15:00:00Z");
    await runner().tick();
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 0);
    assert.strictEqual(smsTo(CLIENTS.cus_MONTHLY.phone).length, 1);
    const [a] = await cycles("cus_A");
    assert.strictEqual(a.status, "scheduled");
    assert.strictEqual(a.attempt_count, 1);
    assert.strictEqual(new Date(a.next_attempt_at).toISOString(), "2026-10-03T15:15:00.000Z");
    assert.ok(logs.some(([lvl, m]) => lvl === "error" && /Meta request failed/.test(m)), "failure must be logged");
  });

  await test("backoff respected; recovers and sends once when Meta comes back", async () => {
    at("2026-10-03T15:10:00Z");
    await runner().tick();
    assert.strictEqual(metaCalls.filter((m) => m.campaignIds[0] === "111111111111").length, 1, "retried before backoff");
    delete metaBehaviour["111111111111"];
    at("2026-10-03T15:16:00Z");
    await runner().tick();
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 1);
  });

  await test("Meta keeps failing → 'failed' after REPORT_MAX_ATTEMPTS, never sent", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    metaBehaviour["111111111111"] = "fail";
    const cfg = { ...LIVE, maxAttempts: 3 };
    at("2026-10-03T15:00:00Z");
    // Backoff is 15m, 30m, ... — step 40 minutes so every attempt is eligible.
    for (let i = 0; i < 6; i++) {
      await runner(cfg).tick();
      NOW = new Date(NOW.getTime() + 40 * 60000);
    }
    const [a] = await cycles("cus_A");
    assert.strictEqual(a.status, "failed");
    assert.match(a.last_error, /after 3 attempts/);
    assert.strictEqual(sms.length, 0);
  });

  await test("non-retryable Meta error (invalid field) → needs_review immediately", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    metaBehaviour["111111111111"] = "invalid";
    at("2026-10-03T15:00:00Z");
    await runner().tick();
    assert.strictEqual((await cycles("cus_A"))[0].status, "needs_review");
  });

  await test("zero ad delivery in the period → needs_review, not a report full of zeros", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    metaBehaviour["111111111111"] = "zero";
    at("2026-10-03T15:00:00Z");
    await runner().tick();
    const [a] = await cycles("cus_A");
    assert.strictEqual(a.status, "needs_review");
    assert.match(a.last_error, /0 impressions/);
    assert.strictEqual(sms.length, 0);
  });

  for (const [mode, expected, again] of [
    ["reject", "failed", false],
    ["optout", "failed", false],
    ["timeout", "uncertain", false],
    ["nosid", "uncertain", false],
  ]) {
    await test(`Twilio ${mode} → '${expected}', and never automatically resent`, async () => {
      await resetDb();
      at("2026-09-01T14:00:00Z");
      await payWeekly("cus_A", "2026-09-01");
      at("2026-10-03T15:00:00Z");
      twilioMode = mode;
      await runner().tick();
      const before = sms.length;
      twilioMode = "ok";
      for (let i = 1; i <= 4; i++) {
        at(`2026-10-03T${15 + i}:00:00Z`);
        await runner().tick();
      }
      const [a] = await cycles("cus_A");
      assert.strictEqual(a.status, expected);
      assert.strictEqual(sms.length, before, "must not resend");
      if (mode === "optout") assert.match(a.last_error, /opted out/);
    });
  }

  await test("Twilio 429 → retried with backoff, then sent once", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    at("2026-10-03T15:00:00Z");
    twilioMode = "ratelimit";
    await runner().tick();
    assert.strictEqual((await cycles("cus_A"))[0].status, "scheduled");
    twilioMode = "ok";
    at("2026-10-03T15:20:00Z");
    await runner().tick();
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 1);
  });

  await test("CRASH while querying Meta (stale 'processing') → requeued and sent once", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    at("2026-10-03T15:00:00Z");
    const [c] = await cycles("cus_A");
    await store.claim(c.id, "dead-runner", clock()); // then the process "dies"
    at("2026-10-03T15:20:00Z");
    await runner().tick();
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 1);
    assert.strictEqual((await cycles("cus_A"))[0].status, "sent");
  });

  await test("CRASH after starting the Twilio send (stale 'sending') → 'uncertain', NOT resent", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    at("2026-10-03T15:00:00Z");
    const [c] = await cycles("cus_A");
    await store.claim(c.id, "dead-runner", clock());
    await store.markSending(c.id, "dead-runner", { smsBody: "x", metrics: {}, sentTo: CLIENTS.cus_A.phone }, clock());
    at("2026-10-03T15:20:00Z");
    for (let i = 0; i < 3; i++) await runner().tick();
    assert.strictEqual(sms.length, 0);
    assert.strictEqual((await cycles("cus_A"))[0].status, "uncertain");
    assert.ok(logs.some(([, m]) => /uncertain/.test(m)));
  });

  await test("database unreachable → tick logs the failure and sends nothing", async () => {
    const saved = process.env.DATABASE_URL;
    await db.close();
    process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:59997/none";
    const res = await runner().tick();
    await db.close();
    process.env.DATABASE_URL = saved;
    assert.strictEqual(res.errors, 1);
    assert.ok(logs.some(([lvl, m]) => lvl === "error" && /tick failed/.test(m)));
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ Dry run");

  await test("REPORTS_DRY_RUN defaults ON when unset", async () => {
    assert.strictEqual(loadConfig({}).dryRun, true);
    assert.strictEqual(loadConfig({ REPORTS_DRY_RUN: "false" }).dryRun, false);
  });

  await test("dry run previews once, sends nothing, and leaves the cycle 'scheduled'", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    at("2026-10-03T15:00:00Z");
    for (let i = 0; i < 3; i++) await runner(DRY).tick();
    assert.strictEqual(sms.length, 0);
    const [c] = await cycles("cus_A");
    assert.strictEqual(c.status, "scheduled");
    assert.ok(c.last_preview_at);
    assert.ok(c.sms_body.includes("THRUPLAYS"));
    assert.strictEqual(logs.filter(([, m]) => /DRY RUN — would send/.test(m)).length, 1);
  });

  await test("dry run sends NOTHING from any sendable state (due, approved-late, retry-ready, approved-uncertain)", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    for (const cus of ["cus_A", "cus_MONTHLY", "cus_MULTI"]) await payWeekly(cus, "2026-09-01");
    await payWeekly("cus_B", "2026-09-01");
    const [a] = await cycles("cus_A");
    const [mo] = await cycles("cus_MONTHLY");
    const [mu] = await cycles("cus_MULTI");
    const [b] = await cycles("cus_B");
    // approved late
    await db.query("UPDATE report_cycles SET status='needs_review', last_error='late: test' WHERE id=$1", [mo.id]);
    await store.approveForSend(mo.id, { note: "approved" }, clock());
    // retry-ready (a failed attempt whose backoff has passed)
    await db.query("UPDATE report_cycles SET attempt_count=2, next_attempt_at='2026-10-01T00:00:00Z' WHERE id=$1", [mu.id]);
    // uncertain, then approved with confirmation
    await db.query("UPDATE report_cycles SET status='uncertain' WHERE id=$1", [b.id]);
    await store.approveForSend(b.id, { note: "checked Twilio", confirmNotDelivered: true }, clock());

    for (const iso of ["2026-10-03T15:00:00Z", "2026-10-03T17:00:00Z", "2026-10-04T15:00:00Z", "2026-10-12T15:00:00Z"]) {
      at(iso);
      await runner(DRY).tick();
      await runner(DRY, { reconcileFn: async () => ({ scanned: 0, recovered: [], errors: 0 }) }).reconcile();
    }
    assert.strictEqual(sms.length, 0, `dry run sent ${sms.length} message(s)`);
    const statuses = (await db.query("SELECT DISTINCT status FROM report_cycles")).rows.map((r) => r.status);
    assert.deepStrictEqual(statuses, ["scheduled"], "dry run must not change any status");
    for (const id of [a.id, mo.id, mu.id, b.id]) assert.ok((await store.getCycle(id)).last_preview_at, `cycle ${id} previewed`);
  });

  await test("dry run never moves stale cycles to needs_review", async () => {
    at("2026-10-10T15:00:00Z");
    await runner(DRY).tick();
    assert.strictEqual((await cycles("cus_A"))[0].status, "scheduled");
  });

  await test("switching dry run off later sends the real report (in time)", async () => {
    at("2026-10-04T15:00:00Z");
    await runner(LIVE).tick();
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 1);
    assert.strictEqual((await cycles("cus_A"))[0].status, "sent");
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ Visit estimate in the live path");

  await test("estimate ON → included, computed from reach only, still passes content guard", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    at("2026-10-03T15:00:00Z");
    const cfg = { ...LIVE, visit: { enabled: true, low: 0.005, high: 0.008, valid: true } };
    await runner(cfg).tick();
    const [m] = smsTo(CLIENTS.cus_A.phone);
    // fake reach for campaign 111… = 10001 → 50.005→50, 80.008→80
    assert.ok(
      m.body.includes(
        "Estimated Potential Customer Visits: 50-80\nHypothetical: assumes 0.5%-0.8% of people reached visit. Not confirmed customers or measured conversions."
      ),
      m.body
    );
    assert.ok(m.body.endsWith("Reply STOP to opt out, HELP for help."));
  });

  await test("estimate disabled by config → report sent without it", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    at("2026-10-03T15:00:00Z");
    await runner(loadConfig({ REPORTS_DRY_RUN: "false", TWILIO_MESSAGING_SERVICE_SID: "MGtest", REPORT_VISIT_ESTIMATE_ENABLED: "false" })).tick();
    const [m] = smsTo(CLIENTS.cus_A.phone);
    assert.ok(!/Estimated/.test(m.body));
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ SMS length — never truncated");

  await test("message over the segment budget → needs_review, NOT truncated, NOT sent", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    at("2026-10-03T15:00:00Z");
    await runner({ ...LIVE, maxSegments: 2 }).tick();
    assert.strictEqual(sms.length, 0);
    const [c] = await cycles("cus_A");
    assert.strictEqual(c.status, "needs_review");
    assert.match(c.last_error, /not truncated, not sent/);
  });

  await test("the stored body equals exactly what Twilio was given, ending in STOP/HELP", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    at("2026-10-03T15:00:00Z");
    await runner().tick();
    const [c] = await cycles("cus_A");
    const [m] = smsTo(CLIENTS.cus_A.phone);
    assert.strictEqual(c.sms_body, m.body);
    assert.ok(m.body.endsWith("\nReply STOP to opt out, HELP for help."));
    assert.ok(m.body.length <= 612, `${m.body.length} chars`);
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ Late reports — flagged, then sent only with approval");

  await test("late report → needs_review with a logged reason that names the approve command", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    at("2026-10-07T15:00:00Z"); // ~4 days after due: service was down
    await runner().tick();
    const [c] = await cycles("cus_A");
    assert.strictEqual(c.status, "needs_review");
    assert.match(c.last_error, /^late: overdue by \d+h \(limit 72h\).*--approve \d+/);
    assert.ok(logs.some(([lvl, m]) => lvl === "error" && /late: overdue/.test(m)));
    assert.strictEqual(sms.length, 0);
    // stays flagged — not dropped, not resent on later ticks
    at("2026-10-08T15:00:00Z");
    await runner().tick();
    assert.strictEqual((await cycles("cus_A"))[0].status, "needs_review");
    assert.strictEqual(sms.length, 0);
  });

  await test("after approval, the late report is sent once (in the send window)", async () => {
    const [c] = await cycles("cus_A");
    at("2026-10-09T11:00:00Z"); // 07:00 New York — outside window
    const approved = await store.approveForSend(c.id, { note: "test approval" }, clock());
    assert.strictEqual(approved.status, "scheduled");
    assert.ok(approved.late_send_approved_at);
    await runner().tick();
    assert.strictEqual(sms.length, 0, "approval must not bypass the send window");
    at("2026-10-09T15:00:00Z");
    await runner().tick();
    await runner().tick();
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 1);
    const [after] = await cycles("cus_A");
    assert.strictEqual(after.status, "sent");
  });

  await test("approval cannot resurrect a 'sent' cycle", async () => {
    const [c] = await cycles("cus_A");
    assert.strictEqual(await store.approveForSend(c.id, { note: "x" }, clock()), null);
  });

  await test("'uncertain' needs explicit confirm-not-delivered before it can be approved", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    at("2026-10-03T15:00:00Z");
    twilioMode = "timeout";
    await runner().tick();
    twilioMode = "ok";
    const [c] = await cycles("cus_A");
    assert.strictEqual(c.status, "uncertain");
    assert.strictEqual(await store.approveForSend(c.id, { note: "x" }, clock()), null);
    assert.ok(await store.approveForSend(c.id, { note: "Twilio shows no delivery", confirmNotDelivered: true }, clock()));
    at("2026-10-03T16:00:00Z");
    await runner().tick();
    assert.strictEqual(smsTo(CLIENTS.cus_A.phone).length, 1);
  });

  await test("an approved cycle still gets every other check (zero delivery → needs_review again)", async () => {
    await resetDb();
    at("2026-09-01T14:00:00Z");
    await payWeekly("cus_A", "2026-09-01");
    metaBehaviour["111111111111"] = "zero";
    at("2026-10-03T15:00:00Z");
    await runner().tick();
    const [c] = await cycles("cus_A");
    await store.approveForSend(c.id, { note: "x" }, clock());
    await runner().tick();
    assert.strictEqual((await cycles("cus_A"))[0].status, "needs_review");
    assert.strictEqual(sms.length, 0);
  });

  await test("cancel removes it from the queue for good", async () => {
    const [c] = await cycles("cus_A");
    assert.ok(await store.cancelCycle(c.id, "not useful", clock()));
    assert.strictEqual(await store.approveForSend(c.id, { note: "x" }, clock()), null);
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ Payment reconciliation (webhook recording lost)");

  const fbBeforeReconcile = () => fbCalls.length;
  function fakeStripe(invoices) {
    const calls = [];
    return {
      calls,
      invoices: {
        list(params) {
          calls.push(params);
          const matching = invoices.filter((i) => i.status === params.status && i.created >= params.created.gte);
          return {
            async *[Symbol.asyncIterator]() {
              for (const i of matching) yield i;
            },
          };
        },
      },
    };
  }
  const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);
  const inv = (id, customer, paidISO, amount = 33125, status = "paid") => ({
    id, customer, status, amount_paid: amount, created: unix(paidISO) - 3600,
    status_transitions: { paid_at: unix(paidISO) },
  });

  await test("a paid invoice the webhook never recorded is recovered; Facebook is not called", async () => {
    await resetDb();
    const fb0 = fbBeforeReconcile();
    at("2026-09-03T12:00:00Z");
    const stripe = fakeStripe([inv("in_LOST", "cus_A", "2026-09-01T15:00:00Z")]);
    const r = await runner(LIVE, { reconcileFn: (a) => require(path.join(ROOT, "reportReconciler")).reconcilePayments({ ...a, stripe }) }).reconcile();
    assert.deepStrictEqual(r.recovered.map((x) => [x.invoiceId, x.outcome]), [["in_LOST", "cycle_opened"]]);
    const [c] = await cycles("cus_A");
    assert.deepStrictEqual([c.ps, c.status], ["2026-09-01", "scheduled"]); // anchored on Stripe's paid_at
    assert.strictEqual(fbCalls.length, fb0, "reconciliation must never touch Facebook");
    assert.ok(logs.some(([, m]) => /Reconciled report payment.*in_LOST/.test(m)));
  });

  await test("running reconciliation again is a no-op", async () => {
    const stripe = fakeStripe([inv("in_LOST", "cus_A", "2026-09-01T15:00:00Z")]);
    const { reconcilePayments } = require(path.join(ROOT, "reportReconciler"));
    const r = await reconcilePayments({ stripe, clients: CLIENTS, store, now: clock(), config: LIVE, logger });
    assert.strictEqual(r.recovered.length, 0);
    assert.strictEqual((await cycles("cus_A")).length, 1);
  });

  await test("skips unregistered customers, $0 invoices and anything paid before the lookback", async () => {
    await resetDb();
    at("2026-09-20T12:00:00Z");
    const stripe = fakeStripe([
      inv("in_STRANGER", "cus_UNKNOWN", "2026-09-19T15:00:00Z"),
      inv("in_ZERO", "cus_A", "2026-09-19T15:00:00Z", 0),
      inv("in_OLD", "cus_A", "2026-09-01T15:00:00Z"), // 19 days ago > 7-day lookback
    ]);
    const { reconcilePayments } = require(path.join(ROOT, "reportReconciler"));
    const r = await reconcilePayments({ stripe, clients: CLIENTS, store, now: clock(), config: LIVE, logger });
    assert.strictEqual(r.recovered.length, 0);
    assert.strictEqual((await db.query("SELECT COUNT(*)::int n FROM report_payments")).rows[0].n, 0);
    // looks further back on creation than on payment (late-paid retries)
    assert.ok(stripe.calls[0].created.gte <= unix("2026-09-13T12:00:00Z") - 45 * 86400);
  });

  await test("webhook and reconciliation racing on the same invoice → one payment, one cycle", async () => {
    await resetDb();
    at("2026-09-01T16:00:00Z");
    const stripe = fakeStripe([inv("in_RACE", "cus_A", "2026-09-01T15:00:00Z")]);
    const { reconcilePayments } = require(path.join(ROOT, "reportReconciler"));
    await Promise.all([
      reconcilePayments({ stripe, clients: CLIENTS, store, now: clock(), config: LIVE, logger }),
      pay("cus_A", "in_RACE", "2026-09-01T15:00:00Z"),
      reconcilePayments({ stripe, clients: CLIENTS, store, now: clock(), config: LIVE, logger }),
    ]);
    assert.strictEqual((await db.query("SELECT COUNT(*)::int n FROM report_payments")).rows[0].n, 1);
    assert.strictEqual((await cycles("cus_A")).length, 1);
  });

  // A client who paused and restarted under a NEW Stripe customer id, paying
  // once every 30 days, whose restart payment predates the 7-day window.
  CLIENTS.cus_RESTART_NEW = {
    name: "Gary Owner - Restart Wings",
    phone: "+15555550107",
    timezone: "America/New_York",
    billing: { cadence: "weekly", paymentsPerCycle: 4, reportDelayDays: 2 },
    analytics: { campaignIds: ["777777777777"] },
    campaigns: [],
  };
  const restartStripe = () =>
    fakeStripe([
      inv("in_restart", "cus_RESTART_NEW", "2026-10-12T18:00:00Z"),
      inv("in_old_sub", "cus_RESTART_OLD", "2026-10-05T18:00:00Z"), // old id, no longer in registry
      inv("in_A_week", "cus_A", "2026-09-25T15:00:00Z"), // another client, older than 7 days
    ]);

  await test("restart payment 9 days before deploy: the hourly 7-day reconciliation does NOT record it", async () => {
    await resetDb();
    at("2026-10-21T16:00:00Z");
    const { reconcilePayments } = require(path.join(ROOT, "reportReconciler"));
    const r = await reconcilePayments({ stripe: restartStripe(), clients: CLIENTS, store, now: clock(), config: LIVE, logger });
    assert.strictEqual(r.recovered.length, 0);
  });

  await test("backfill PREVIEW lists it and writes nothing", async () => {
    const { reconcilePayments } = require(path.join(ROOT, "reportReconciler"));
    const r = await reconcilePayments({
      stripe: restartStripe(), clients: CLIENTS, store, now: clock(), config: LIVE, logger,
      paidSince: new Date("2026-10-12T04:00:00Z"), customerIds: new Set(["cus_RESTART_NEW"]), dryRun: true,
    });
    assert.deepStrictEqual(r.wouldRecord.map((w) => w.invoiceId), ["in_restart"]);
    assert.strictEqual((await db.query("SELECT COUNT(*)::int n FROM report_payments")).rows[0].n, 0);
    assert.strictEqual((await db.query("SELECT COUNT(*)::int n FROM report_cycles")).rows[0].n, 0);
  });

  await test("backfill APPLY opens the restart cycle (Oct 12..Nov 10, due Nov 13) — and only that", async () => {
    const { reconcilePayments } = require(path.join(ROOT, "reportReconciler"));
    const fb0 = fbCalls.length;
    const r = await reconcilePayments({
      stripe: restartStripe(), clients: CLIENTS, store, now: clock(), config: LIVE, logger,
      paidSince: new Date("2026-10-12T04:00:00Z"), customerIds: new Set(["cus_RESTART_NEW"]),
    });
    assert.deepStrictEqual(r.recovered.map((x) => [x.invoiceId, x.outcome]), [["in_restart", "cycle_opened"]]);
    const [c] = await cycles("cus_RESTART_NEW");
    assert.deepStrictEqual([c.ps, c.pe, c.status], ["2026-10-12", "2026-11-10", "scheduled"]);
    assert.strictEqual(new Date(c.report_due_at).toISOString(), "2026-11-13T15:00:00.000Z"); // 10:00 EST
    assert.strictEqual((await cycles("cus_A")).length, 0, "customer filter must exclude other clients");
    assert.strictEqual(fbCalls.length, fb0, "no Facebook calls");
    assert.strictEqual(sms.length, 0, "no SMS");
  });

  await test("old customer id carries no history: its invoices are never recorded, even when unfiltered", async () => {
    const { reconcilePayments } = require(path.join(ROOT, "reportReconciler"));
    await reconcilePayments({
      stripe: restartStripe(), clients: CLIENTS, store, now: clock(), config: LIVE, logger,
      paidSince: new Date("2026-09-01T04:00:00Z"), dryRun: true,
    }).then((r) => assert.ok(!r.wouldRecord.some((w) => w.customerId === "cus_RESTART_OLD")));
    const p = await db.query("SELECT COUNT(*)::int n FROM report_payments WHERE stripe_customer_id = 'cus_RESTART_OLD'");
    assert.strictEqual(p.rows[0].n, 0);
  });

  await test("backfill APPLY again is a no-op", async () => {
    const { reconcilePayments } = require(path.join(ROOT, "reportReconciler"));
    const r = await reconcilePayments({
      stripe: restartStripe(), clients: CLIENTS, store, now: clock(), config: LIVE, logger,
      paidSince: new Date("2026-10-12T04:00:00Z"), customerIds: new Set(["cus_RESTART_NEW"]),
    });
    assert.strictEqual(r.recovered.length, 0);
    assert.strictEqual((await cycles("cus_RESTART_NEW")).length, 1);
  });

  await test("restart client's next monthly payment (Nov 11) opens the contiguous next cycle", async () => {
    at("2026-11-11T18:00:00Z");
    await pay("cus_RESTART_NEW", "in_restart_nov", "2026-11-11T18:00:00Z");
    const cs = await cycles("cus_RESTART_NEW");
    assert.deepStrictEqual(cs.map((c) => [c.ps, c.pe]), [["2026-10-12", "2026-11-10"], ["2026-11-11", "2026-12-10"]]);
    // ...and the Oct 12 cycle sends on Nov 13 (last payment 2 days ago passes the grace check)
    at("2026-11-13T15:30:00Z");
    await runner().tick();
    assert.strictEqual(smsTo("+15555550107").length, 1);
    delete CLIENTS.cus_RESTART_NEW;
  });

  await test("Stripe API failure during reconciliation is logged and retried next run, not thrown", async () => {
    const broken = { invoices: { list() { return { async *[Symbol.asyncIterator]() { throw new Error("Stripe 500"); } }; } } };
    const r = await runner(LIVE, {
      reconcileFn: (a) => require(path.join(ROOT, "reportReconciler")).reconcilePayments({ ...a, stripe: broken }),
    }).reconcile();
    assert.match(r.error, /Stripe 500/);
    assert.ok(logs.some(([lvl, m]) => lvl === "error" && /reconciliation failed/.test(m)));
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ Multi-campaign aggregation (real metaInsights, fake HTTP)");

  await test("several campaigns → ONE deduplicated account-level query, not a per-campaign sum", async () => {
    const calls = [];
    const fakeHttp = {
      get: async (url, { params }) => {
        calls.push({ url, params });
        if (params.ids) return { data: { "333333333333": { account_id: "999" }, "444444444444": { account_id: "999" } } };
        return { data: { data: [{ ...insightsRow(0), reach: "15000" }] } };
      },
    };
    const r = await metaInsights.fetchReportMetrics({
      campaignIds: ["333333333333", "444444444444"], since: "2026-09-01", until: "2026-09-30",
      http: fakeHttp, accessToken: "t", graphVersion: "v25.0",
    });
    const insights = calls.find((c) => c.url.endsWith("/act_999/insights"));
    assert.ok(insights, "must query the ad account");
    assert.strictEqual(insights.params.level, "account");
    assert.deepStrictEqual(JSON.parse(insights.params.filtering), [
      { field: "campaign.id", operator: "IN", value: ["333333333333", "444444444444"] },
    ]);
    assert.strictEqual(r.metrics.reach, 15000);
    assert.strictEqual(r.reachIsDeduplicated, true);
    assert.ok(!/spend|cost|cpm|cpc/.test(insights.params.fields));
  });

  await test("campaigns in different ad accounts → refused (needs_review), not summed", async () => {
    const fakeHttp = {
      get: async (url, { params }) =>
        params.ids ? { data: { "333333333333": { account_id: "1" }, "444444444444": { account_id: "2" } } } : { data: { data: [] } },
    };
    await assert.rejects(
      metaInsights.fetchReportMetrics({ campaignIds: ["333333333333", "444444444444"], since: "a", until: "b", http: fakeHttp, accessToken: "t" }),
      (e) => e.retryable === false && /cannot be deduplicated/.test(e.message)
    );
  });

  await test("single campaign → campaign-level query with complete-day time_range", async () => {
    let seen;
    const fakeHttp = { get: async (url, { params }) => ((seen = { url, params }), { data: { data: [insightsRow(1)] } }) };
    await metaInsights.fetchReportMetrics({ campaignIds: ["111111111111"], since: "2026-09-01", until: "2026-09-30", http: fakeHttp, accessToken: "t", graphVersion: "v25.0" });
    assert.strictEqual(seen.url, "https://graph.facebook.com/v25.0/111111111111/insights");
    assert.deepStrictEqual(JSON.parse(seen.params.time_range), { since: "2026-09-01", until: "2026-09-30" });
  });

  await test("Meta error messages never include the access token", async () => {
    const fakeHttp = {
      get: async () => {
        const e = new Error("Request failed with status code 400");
        e.config = { params: { access_token: "SECRET_TOKEN_123" } };
        e.response = { status: 400, data: { error: { code: 190, message: "Invalid OAuth access token" } } };
        throw e;
      },
    };
    await assert.rejects(
      metaInsights.fetchReportMetrics({ campaignIds: ["111111111111"], since: "a", until: "b", http: fakeHttp, accessToken: "SECRET_TOKEN_123" }),
      (e) => !e.message.includes("SECRET_TOKEN_123") && /190/.test(e.message)
    );
  });

  // ───────────────────────────────────────────────────────────
  console.log("\n▸ Stripe webhook integration (real route, real signatures)");
  await resetDb();

  const express = require("express");
  const Stripe = require("stripe");
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const app = express();
  app.use("/webhook", express.raw({ type: "application/json" }), require(path.join(ROOT, "stripeWebhook")));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/webhook`;

  function deliver(event) {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }
  const event = (id, invoiceId, paidAtUnix) => ({
    id, object: "event", type: "invoice.payment_succeeded", created: paidAtUnix + 5,
    data: { object: { id: invoiceId, object: "invoice", customer: "cus_A", status_transitions: { paid_at: paidAtUnix } } },
  });
  const settle = () => new Promise((r) => setTimeout(r, 400)); // recording is fire-and-forget

  await test("invoice.payment_succeeded → 200, Facebook path still runs once, cycle recorded", async () => {
    fbCalls.length = 0;
    const paid = Math.floor(new Date("2026-09-01T15:00:00Z").getTime() / 1000);
    assert.strictEqual(await deliver(event("evt_1", "in_W1", paid)), 200);
    await settle();
    assert.strictEqual(fbCalls.length, 1);
    const cs = await cycles("cus_A");
    assert.strictEqual(cs.length, 1);
    assert.strictEqual(cs[0].ps, "2026-09-01"); // from Stripe's paid_at, not arrival time
  });

  await test("Stripe redelivers the same invoice 3x → still one payment, one cycle, FB fast-path unchanged", async () => {
    const paid = Math.floor(new Date("2026-09-01T15:00:00Z").getTime() / 1000);
    for (const id of ["evt_1", "evt_1b", "evt_1c"]) assert.strictEqual(await deliver(event(id, "in_W1", paid)), 200);
    await settle();
    assert.strictEqual(fbCalls.length, 1, "legacy fast-path must still suppress the FB update");
    const p = await db.query("SELECT COUNT(*)::int n FROM report_payments WHERE stripe_invoice_id='in_W1'");
    assert.strictEqual(p.rows[0].n, 1);
    assert.strictEqual((await cycles("cus_A")).length, 1);
  });

  await test("REDEPLOY wipes reports.json, then a redelivery → cycle not duplicated", async () => {
    legacyStore.clear();
    await db.close();
    const paid = Math.floor(new Date("2026-09-01T15:00:00Z").getTime() / 1000);
    assert.strictEqual(await deliver(event("evt_1d", "in_W1", paid)), 200);
    await settle();
    assert.strictEqual((await cycles("cus_A")).length, 1);
  });

  await test("report database down → webhook still answers 200 and still funds Facebook", async () => {
    const saved = process.env.DATABASE_URL;
    await db.close();
    process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:59997/none";
    fbCalls.length = 0;
    const paid = Math.floor(new Date("2026-09-08T15:00:00Z").getTime() / 1000);
    const status = await deliver(event("evt_2", "in_W2", paid));
    await new Promise((r) => setTimeout(r, 1500));
    await db.close();
    process.env.DATABASE_URL = saved;
    assert.strictEqual(status, 200);
    assert.strictEqual(fbCalls.length, 1);
    const p = await db.query("SELECT 1 FROM report_payments WHERE stripe_invoice_id='in_W2'");
    assert.strictEqual(p.rowCount, 0, "precondition: the recording really was lost");
  });

  await test("…and reconciliation later recovers exactly that invoice, without another FB update", async () => {
    const fb0 = fbCalls.length;
    at("2026-09-09T12:00:00Z");
    const paidISO = "2026-09-08T15:00:00Z";
    const stripe = {
      invoices: {
        list: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              id: "in_W2", customer: "cus_A", status: "paid", amount_paid: 33125,
              created: Math.floor(new Date(paidISO).getTime() / 1000) - 60,
              status_transitions: { paid_at: Math.floor(new Date(paidISO).getTime() / 1000) },
            };
          },
        }),
      },
    };
    const { reconcilePayments } = require(path.join(ROOT, "reportReconciler"));
    const r = await reconcilePayments({ stripe, clients: CLIENTS, store, now: clock(), config: LIVE, logger });
    assert.deepStrictEqual(r.recovered.map((x) => x.invoiceId), ["in_W2"]);
    const p = await db.query("SELECT 1 FROM report_payments WHERE stripe_invoice_id='in_W2'");
    assert.strictEqual(p.rowCount, 1);
    assert.strictEqual(fbCalls.length, fb0);
  });

  server.close();
  await db.close();

  console.log(`\n${failures.length ? "❌" : "✅"} report-cycles: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
