// reportReconciler.js
// Safety net for report payments the webhook failed to record.
//
// The webhook records report payments without waiting (so it can never delay
// or change the Facebook path). That means a database outage, a crash or a
// deploy at the wrong moment can drop a recording AFTER Stripe already got
// its 200 — and Stripe will not redeliver an event it considers delivered.
//
// So Stripe itself is treated as the source of truth: periodically list the
// recently PAID invoices (read-only) and record any registered client's
// invoice that report_payments does not have yet. recordPayment is
// idempotent per invoice and serialised per customer, so the webhook and this
// job can race freely — whichever arrives second is a no-op.
//
// ═══ NEVER TOUCHES FACEBOOK ═══
// This module does not import facebookApi and does not call the webhook
// handler. It only writes report_payments / report_cycles. Ad budgets are
// funded by the webhook path alone, exactly as before.

const defaultStore = require("./reportCycleStore");

const DAY_MS = 86400000;
// Invoices can be paid well after they are created (Smart Retries run for
// weeks), and Stripe's list filter is on `created`, so look further back on
// creation than on payment.
const CREATED_MARGIN_DAYS = 45;

function stripeClient() {
  const key = process.env.REPORT_STRIPE_READ_KEY || process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("No Stripe key (REPORT_STRIPE_READ_KEY or STRIPE_SECRET_KEY) for reconciliation");
  return require("stripe")(key);
}

/**
 * Returns { scanned, recovered: [{customerId, invoiceId, outcome}], errors }.
 *
 * The automatic hourly run uses only config.reconcileLookbackDays. The
 * one-time backfill script (scripts/backfill-report-payments.js) also passes:
 *   paidSince    Date — look back further than the hourly window
 *   customerIds  Set  — restrict to these customers
 *   dryRun       true — write nothing; report what WOULD be recorded
 */
async function reconcilePayments({
  stripe = stripeClient(),
  clients = require("./clients"),
  store = defaultStore,
  now = new Date(),
  config,
  logger = console,
  paidSince: paidSinceOverride = null,
  customerIds = null,
  dryRun = false,
}) {
  const paidSince = paidSinceOverride
    ? paidSinceOverride.getTime()
    : now.getTime() - config.reconcileLookbackDays * DAY_MS;
  const createdGte = Math.floor((paidSince - CREATED_MARGIN_DAYS * DAY_MS) / 1000);

  const result = { scanned: 0, recovered: [], errors: 0, wouldRecord: [] };

  for await (const inv of stripe.invoices.list({ status: "paid", created: { gte: createdGte }, limit: 100 })) {
    result.scanned++;
    const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
    // Registry only: an invoice under a customer id that is no longer in
    // clientsData.json (e.g. a client's old subscription) is never recorded.
    const client = clients[customerId];
    if (!client) continue;
    if (customerIds && !customerIds.has(customerId)) continue;

    const paidAtSec = Number(inv.status_transitions?.paid_at);
    if (!Number.isFinite(paidAtSec) || paidAtSec <= 0) continue;
    const paidAt = new Date(paidAtSec * 1000);
    // Only fill recent gaps. Older history is deliberately not backfilled.
    if (paidAt.getTime() < paidSince) continue;
    if (!(Number(inv.amount_paid) > 0)) continue;

    if (dryRun) {
      if (!(await store.paymentExists(inv.id))) {
        result.wouldRecord.push({ customerId, clientName: client.name, invoiceId: inv.id, paidAt, client });
      }
      continue;
    }

    try {
      const r = await store.recordPayment({ customerId, invoiceId: inv.id, paidAt, client, now, config });
      if (r.outcome !== "duplicate") {
        result.recovered.push({ customerId, invoiceId: inv.id, outcome: r.outcome });
        logger.warn(
          `🩹 Reconciled report payment the webhook did not record: ${client.name} / ${inv.id} ` +
            `(paid ${paidAt.toISOString()}) → ${r.outcome}` +
            (r.cycle ? ` ${r.cycle.period_start}..${r.cycle.period_end} [${r.cycle.status}]` : "")
        );
      }
    } catch (e) {
      result.errors++;
      logger.error(`❌ Reconciliation could not record ${client.name} / ${inv.id}: ${e.message}`);
    }
  }

  return result;
}

module.exports = { reconcilePayments };
