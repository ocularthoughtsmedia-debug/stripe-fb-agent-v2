// scripts/backfill-report-payments.js
// ONE-TIME, targeted seeding of report payments older than the automatic
// 7-day reconciliation window — e.g. a monthly client whose last payment was
// before the deploy (Yancy's Oct 12, 2026 restart payment).
//
//   node scripts/backfill-report-payments.js --since 2026-10-12 --customer cus_VPVaHVjywZtpRa
//        PREVIEW (default): reads Stripe and report_payments, writes NOTHING
//   node scripts/backfill-report-payments.js --since 2026-10-12 --customer cus_VPVaHVjywZtpRa --apply
//        records those payments (opens their report cycle)
//
//   --customer may be repeated or comma-separated; omit it to preview every
//   registered client (only do that in preview mode, then pick customers).
//
// Safe by construction:
//   • never sends an SMS and never touches Facebook budgets/end dates
//   • only customer ids in clientsData.json (an old subscription's id is ignored)
//   • idempotent: an invoice already recorded is skipped
//   • a cycle that would already be due is created as needs_review, never auto-sent
//
// Needs DATABASE_URL (production) and a Stripe key (REPORT_STRIPE_READ_KEY or
// STRIPE_SECRET_KEY). Run in the Render Shell, where both are already set.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const { DateTime } = require("luxon");
const ROOT = path.join(__dirname, "..");
const clients = require(path.join(ROOT, "clients"));
const store = require(path.join(ROOT, "reportCycleStore"));
const db = require(path.join(ROOT, "reportDb"));
const { reconcilePayments } = require(path.join(ROOT, "reportReconciler"));
const { loadConfig } = require(path.join(ROOT, "reportRunner"));

const argv = process.argv.slice(2);
const values = (n) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] ? argv[i + 1].split(",") : []));
const apply = argv.includes("--apply");
const sinceArg = values("since")[0];
const customers = values("customer").map((s) => s.trim()).filter(Boolean);

(async () => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sinceArg || ""))) throw new Error("--since YYYY-MM-DD is required");
  const unknown = customers.filter((c) => !clients[c]);
  if (unknown.length) throw new Error(`Not in clientsData.json (refusing): ${unknown.join(", ")}`);
  if (apply && customers.length === 0) throw new Error("--apply requires at least one --customer (preview first, then choose)");

  const config = loadConfig();
  const now = new Date();
  const paidSince = DateTime.fromISO(sinceArg, { zone: "America/New_York" }).startOf("day").toJSDate();
  const customerIds = customers.length ? new Set(customers) : null;

  console.log(`${apply ? "APPLY" : "PREVIEW (no writes)"} — paid invoices since ${sinceArg} (00:00 New York)` +
    (customerIds ? ` for ${customers.join(", ")}` : " for all registered clients"));

  const r = await reconcilePayments({ clients, store, now, config, paidSince, customerIds, dryRun: !apply });

  if (!apply) {
    if (!r.wouldRecord.length) console.log("Nothing to record: every matching paid invoice is already in report_payments.");
    for (const w of r.wouldRecord.sort((a, b) => a.paidAt - b.paidAt)) {
      const win = store.computeCycleWindow({
        paidAt: w.paidAt,
        timezone: store.clientTimezone(w.client),
        previousPeriodEnd: null,
        periodDays: config.periodDays,
        contiguousGapDays: config.contiguousGapDays,
        delayDays: store.reportDelayDays(w.client),
        sendHour: config.sendWindowStartHour,
      });
      const overdue = win.reportDueAt <= now;
      console.log(
        `  would record ${w.invoiceId}  ${w.clientName}  paid ${w.paidAt.toISOString()}\n` +
          `     → if it opens a cycle: ${win.periodStart}..${win.periodEnd}, due ${win.reportDueAt.toISOString()}` +
          (overdue ? "  [ALREADY DUE → would be needs_review, not sent]" : "")
      );
    }
    console.log(`\nScanned ${r.scanned} paid invoice(s). Nothing was written. Re-run with --apply to record.`);
  } else {
    for (const x of r.recovered) console.log(`  recorded ${x.invoiceId} (${x.customerId}) → ${x.outcome}`);
    console.log(`\nScanned ${r.scanned}, recorded ${r.recovered.length}, errors ${r.errors}. No SMS sent.`);
    if (r.errors) process.exitCode = 1;
  }
})()
  .catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
