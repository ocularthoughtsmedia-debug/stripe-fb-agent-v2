// reportCycleStore.js
// Durable state for the 30-day report system. Replaces reports.json for
// reporting (reports.json is still used by stripeWebhook.js as its advisory
// Facebook fast-path guard; that is untouched).
//
// Tables (DDL owned by otm-ad-predictor, db/migrations/2026-10-19_report_cycles.sql):
//   report_payments  one row per paid invoice — the webhook dedupe
//   report_cycles    one row per reporting period — the send state machine
//
// Every function takes `now` explicitly instead of calling NOW() so the whole
// lifecycle can be tested against a simulated clock.

const { DateTime } = require("luxon");
const db = require("./reportDb");

const DEFAULT_TIMEZONE = "America/New_York";

// DATE columns come back as text so no JS Date (and no host timezone) ever
// touches a calendar date.
const CYCLE_COLS = `
  id, stripe_customer_id, client_name, timezone,
  period_start::text AS period_start, period_end::text AS period_end,
  report_due_at, opened_by_invoice_id, status, attempt_count, next_attempt_at,
  claim_token, claimed_at, send_started_at, sent_at, sent_to, twilio_sid,
  sms_body, metrics, hold_reason, last_error, last_preview_at,
  late_send_approved_at, review_note, created_at, updated_at`;

function clientTimezone(client) {
  const tz = client?.timezone;
  return tz && DateTime.now().setZone(tz).isValid ? tz : DEFAULT_TIMEZONE;
}

// Preserves the old webhook's semantics exactly: no billing block → 2 days;
// a billing block without reportDelayDays → 0.
function reportDelayDays(client) {
  const billing = client?.billing || { reportDelayDays: 2 };
  const n = Number(billing.reportDelayDays || 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Pure period arithmetic for a payment that falls outside every existing
 * cycle.
 *
 * Contiguity: if the previous period ended no more than `contiguousGapDays`
 * before this payment, the new period starts the day after it, so a client
 * paying weekly gets back-to-back reports with no unreported days in between
 * (those days were funded by the previous payment). After a longer lapse the
 * period starts on the payment date instead.
 */
function computeCycleWindow({ paidAt, timezone, previousPeriodEnd, periodDays, contiguousGapDays, delayDays, sendHour }) {
  const paidDate = DateTime.fromJSDate(paidAt, { zone: timezone }).startOf("day");

  let start = paidDate;
  if (previousPeriodEnd) {
    const prevEnd = DateTime.fromISO(previousPeriodEnd, { zone: timezone }).startOf("day");
    const gap = paidDate.diff(prevEnd, "days").days;
    if (gap >= 1 && gap <= contiguousGapDays) start = prevEnd.plus({ days: 1 });
  }

  const end = start.plus({ days: periodDays - 1 });
  // First moment the whole period is a COMPLETE past day, plus the delay that
  // lets Meta finish settling the last day's numbers, at the send-window start.
  const due = end.plus({ days: 1 + delayDays }).set({ hour: sendHour, minute: 0, second: 0, millisecond: 0 });

  return {
    periodStart: start.toISODate(),
    periodEnd: end.toISODate(),
    reportDueAt: due.toJSDate(),
    paidDate: paidDate.toISODate(),
  };
}

/**
 * Record a successful invoice and, if it falls outside every existing period,
 * open the next reporting cycle.
 *
 * Idempotent per invoice. Serialised per customer with an advisory lock, so
 * concurrent deliveries cannot open two overlapping cycles.
 *
 * Returns { outcome, cycle? } where outcome is one of:
 *   duplicate      invoice already recorded; nothing changed
 *   within_cycle   payment belongs to an existing period
 *   out_of_order   an older invoice arrived after a later period opened; the
 *                  payment is recorded for the grace check, no cycle is opened
 *   cycle_opened   a new period was created
 */
async function recordPayment({ customerId, invoiceId, paidAt, client, now, config }) {
  if (!customerId || !invoiceId) throw new Error("recordPayment: customerId and invoiceId are required");
  if (!(paidAt instanceof Date) || Number.isNaN(paidAt.getTime())) {
    throw new Error("recordPayment: paidAt must be a valid Date");
  }

  const timezone = clientTimezone(client);

  return db.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`report_cycles:${customerId}`]);

    const inserted = await tx.query(
      `INSERT INTO report_payments (stripe_invoice_id, stripe_customer_id, paid_at, received_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stripe_invoice_id) DO NOTHING
       RETURNING stripe_invoice_id`,
      [invoiceId, customerId, paidAt, now]
    );
    if (inserted.rowCount === 0) return { outcome: "duplicate" };

    const paidDate = DateTime.fromJSDate(paidAt, { zone: timezone }).toISODate();

    const covering = await tx.query(
      `SELECT ${CYCLE_COLS} FROM report_cycles
        WHERE stripe_customer_id = $1 AND period_start <= $2 AND period_end >= $2
        ORDER BY period_start DESC LIMIT 1`,
      [customerId, paidDate]
    );
    if (covering.rows[0]) {
      await tx.query("UPDATE report_payments SET cycle_id = $1 WHERE stripe_invoice_id = $2", [
        covering.rows[0].id,
        invoiceId,
      ]);
      return { outcome: "within_cycle", cycle: covering.rows[0] };
    }

    const later = await tx.query(
      "SELECT 1 FROM report_cycles WHERE stripe_customer_id = $1 AND period_start > $2 LIMIT 1",
      [customerId, paidDate]
    );
    if (later.rowCount > 0) return { outcome: "out_of_order" };

    const previous = await tx.query(
      `SELECT period_end::text AS period_end FROM report_cycles
        WHERE stripe_customer_id = $1 AND period_end < $2
        ORDER BY period_end DESC LIMIT 1`,
      [customerId, paidDate]
    );

    const w = computeCycleWindow({
      paidAt,
      timezone,
      previousPeriodEnd: previous.rows[0]?.period_end || null,
      periodDays: config.periodDays,
      contiguousGapDays: config.contiguousGapDays,
      delayDays: reportDelayDays(client),
      sendHour: config.sendWindowStartHour,
    });

    // A cycle that is already due the moment it is created means a payment
    // was recorded long after the fact (a late redelivery or a manual
    // backfill). Never auto-send those: park them for a human.
    const overdue = w.reportDueAt.getTime() <= now.getTime();

    const created = await tx.query(
      `INSERT INTO report_cycles
         (stripe_customer_id, client_name, timezone, period_start, period_end,
          report_due_at, opened_by_invoice_id, status, last_error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       ON CONFLICT (stripe_customer_id, period_start) DO NOTHING
       RETURNING ${CYCLE_COLS}`,
      [
        customerId,
        client?.name || null,
        timezone,
        w.periodStart,
        w.periodEnd,
        w.reportDueAt,
        invoiceId,
        overdue ? "needs_review" : "scheduled",
        overdue ? "created_overdue: cycle was already due when its payment was recorded" : null,
        now,
      ]
    );

    let cycle = created.rows[0];
    if (!cycle) {
      // Unreachable under the advisory lock; handled rather than assumed.
      const existing = await tx.query(
        `SELECT ${CYCLE_COLS} FROM report_cycles WHERE stripe_customer_id = $1 AND period_start = $2`,
        [customerId, w.periodStart]
      );
      cycle = existing.rows[0];
    }

    await tx.query("UPDATE report_payments SET cycle_id = $1 WHERE stripe_invoice_id = $2", [cycle.id, invoiceId]);
    return { outcome: "cycle_opened", cycle };
  });
}

async function paymentExists(invoiceId) {
  const r = await db.query("SELECT 1 FROM report_payments WHERE stripe_invoice_id = $1", [invoiceId]);
  return r.rowCount > 0;
}

async function lastPaymentAt(customerId) {
  const r = await db.query("SELECT MAX(paid_at) AS last FROM report_payments WHERE stripe_customer_id = $1", [
    customerId,
  ]);
  return r.rows[0]?.last || null;
}

async function listDueCycles(now) {
  const r = await db.query(
    `SELECT ${CYCLE_COLS} FROM report_cycles
      WHERE status = 'scheduled'
        AND report_due_at <= $1
        AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
      ORDER BY report_due_at, id`,
    [now]
  );
  return r.rows;
}

async function getCycle(id) {
  const r = await db.query(`SELECT ${CYCLE_COLS} FROM report_cycles WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

// Returns true only when the reason actually changed, so the runner logs a
// hold once rather than every five minutes.
async function setHold(id, reason, now) {
  const r = await db.query(
    `UPDATE report_cycles SET hold_reason = $2, updated_at = $3
      WHERE id = $1 AND status = 'scheduled' AND hold_reason IS DISTINCT FROM $2`,
    [id, reason, now]
  );
  return r.rowCount > 0;
}

async function markNeedsReview(id, reason, now) {
  const r = await db.query(
    `UPDATE report_cycles
        SET status = 'needs_review', last_error = $2, hold_reason = NULL,
            claim_token = NULL, updated_at = $3
      WHERE id = $1 AND status IN ('scheduled', 'processing')`,
    [id, reason, now]
  );
  return r.rowCount > 0;
}

// Atomic claim. Only one runner can move a row out of 'scheduled'; every
// other runner (another instance, an overlapping tick) gets null.
async function claim(id, token, now) {
  const r = await db.query(
    `UPDATE report_cycles
        SET status = 'processing', claim_token = $2, claimed_at = $3,
            hold_reason = NULL, updated_at = $3
      WHERE id = $1 AND status = 'scheduled'
        AND report_due_at <= $3
        AND (next_attempt_at IS NULL OR next_attempt_at <= $3)
      RETURNING ${CYCLE_COLS}`,
    [id, token, now]
  );
  return r.rows[0] || null;
}

// Back to the queue after a failure that provably sent nothing.
async function releaseForRetry(id, token, error, nextAttemptAt, now) {
  const r = await db.query(
    `UPDATE report_cycles
        SET status = 'scheduled', claim_token = NULL, attempt_count = attempt_count + 1,
            next_attempt_at = $3, last_error = $4, updated_at = $5
      WHERE id = $1 AND claim_token = $2 AND status IN ('processing', 'sending')
      RETURNING attempt_count`,
    [id, token, nextAttemptAt, error, now]
  );
  return r.rows[0]?.attempt_count ?? null;
}

// Commit to sending. Written BEFORE Twilio is called: from here on, a crash
// means "maybe sent" and the row can only become 'uncertain', never resent.
async function markSending(id, token, { smsBody, metrics, sentTo }, now) {
  const r = await db.query(
    `UPDATE report_cycles
        SET status = 'sending', send_started_at = $3, sms_body = $4, metrics = $5,
            sent_to = $6, updated_at = $3
      WHERE id = $1 AND claim_token = $2 AND status = 'processing'`,
    [id, token, now, smsBody, JSON.stringify(metrics), sentTo]
  );
  return r.rowCount > 0;
}

async function markSent(id, token, twilioSid, now) {
  const r = await db.query(
    `UPDATE report_cycles
        SET status = 'sent', sent_at = $3, twilio_sid = $4, claim_token = NULL,
            last_error = NULL, updated_at = $3
      WHERE id = $1 AND claim_token = $2 AND status = 'sending'`,
    [id, token, now, twilioSid]
  );
  return r.rowCount > 0;
}

// Terminal outcomes: 'failed' (definitively not sent) or 'uncertain'.
async function markTerminal(id, token, status, error, now) {
  if (!["failed", "uncertain", "needs_review"].includes(status)) {
    throw new Error(`markTerminal: invalid status ${status}`);
  }
  const r = await db.query(
    `UPDATE report_cycles
        SET status = $3, last_error = $4, claim_token = NULL, updated_at = $5
      WHERE id = $1 AND claim_token = $2 AND status IN ('processing', 'sending')`,
    [id, token, status, error, now]
  );
  return r.rowCount > 0;
}

// Dry-run bookkeeping. Deliberately touches nothing but the preview columns.
async function markPreview(id, { smsBody, metrics }, now) {
  await db.query(
    `UPDATE report_cycles SET last_preview_at = $2, sms_body = $3, metrics = $4
      WHERE id = $1 AND status = 'scheduled'`,
    [id, now, smsBody, JSON.stringify(metrics)]
  );
}

/**
 * Recover rows abandoned by a crashed or redeployed runner.
 *   processing (stale) → scheduled   nothing was sent yet; safe to retry
 *   sending    (stale) → uncertain   Twilio may have accepted it; never resend
 */
async function recoverStale(now, staleMinutes) {
  const cutoff = new Date(now.getTime() - staleMinutes * 60 * 1000);

  const requeued = await db.query(
    `UPDATE report_cycles
        SET status = 'scheduled', claim_token = NULL, updated_at = $2,
            last_error = 'recovered: runner stopped while querying Meta (nothing was sent)'
      WHERE status = 'processing' AND claimed_at < $1
      RETURNING id, stripe_customer_id`,
    [cutoff, now]
  );

  const uncertain = await db.query(
    `UPDATE report_cycles
        SET status = 'uncertain', claim_token = NULL, updated_at = $2,
            last_error = 'runner stopped after starting the Twilio send — check Twilio logs before resending'
      WHERE status = 'sending' AND send_started_at < $1
      RETURNING id, stripe_customer_id`,
    [cutoff, now]
  );

  return { requeued: requeued.rows, uncertain: uncertain.rows };
}

// Stripe's own paid timestamp, so a redelivery days later still lands in the
// period the payment belongs to. Falls back to the event time, then to now.
function invoicePaidAt(invoice, event, now) {
  const paid = Number(invoice?.status_transitions?.paid_at);
  if (Number.isFinite(paid) && paid > 0) return new Date(paid * 1000);
  const created = Number(event?.created);
  if (Number.isFinite(created) && created > 0) return new Date(created * 1000);
  return now;
}

/**
 * Webhook entry point. NEVER THROWS and never affects the webhook response:
 * the payment → Facebook path must behave exactly as it did before reports
 * moved to Postgres. A failure is logged loudly with the invoice id so the
 * cycle can be reconciled by hand.
 */
async function recordPaymentFromWebhook({ client, customerId, invoice, event, config, now = new Date() }) {
  try {
    if (!db.isConfigured()) {
      console.error(`🚨 Report cycle NOT recorded for ${client?.name} / ${invoice?.id}: DATABASE_URL is not set`);
      return null;
    }
    const r = await recordPayment({
      customerId,
      invoiceId: invoice.id,
      paidAt: invoicePaidAt(invoice, event, now),
      client,
      now,
      config,
    });
    if (r.outcome === "cycle_opened") {
      const c = r.cycle;
      console.log(
        c.status === "scheduled"
          ? `📌 30-day report cycle opened for ${client.name}: ${c.period_start}..${c.period_end}, due ${new Date(c.report_due_at).toISOString()}`
          : `🛑 30-day report cycle for ${client.name} (${c.period_start}..${c.period_end}) was already overdue when recorded → needs_review`
      );
    } else if (r.outcome === "out_of_order") {
      console.log(`📎 ${client.name}: invoice ${invoice.id} predates the current report cycle; payment recorded, no new cycle`);
    }
    return r;
  } catch (e) {
    console.error(
      `🚨 Report cycle NOT recorded for ${client?.name} / invoice ${invoice?.id}: ${e.message} ` +
        `— reconciliation will pick it up from Stripe (reportReconciler.js)`
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Human review (scripts/review-reports.js)
// ─────────────────────────────────────────────────────────────
async function listAttention() {
  const r = await db.query(
    `SELECT ${CYCLE_COLS} FROM report_cycles
      WHERE status IN ('needs_review', 'failed', 'uncertain')
         OR (status = 'scheduled' AND hold_reason IS NOT NULL)
      ORDER BY report_due_at, id`
  );
  return r.rows;
}

/**
 * Put a reviewed cycle back in the queue, with permission to send it late.
 * 'uncertain' cycles may already have been delivered, so they need an
 * explicit confirmation that Twilio's logs show no delivery.
 */
async function approveForSend(id, { note, confirmNotDelivered = false } = {}, now) {
  const allowed = confirmNotDelivered ? ["needs_review", "failed", "uncertain"] : ["needs_review", "failed"];
  const r = await db.query(
    `UPDATE report_cycles
        SET status = 'scheduled', late_send_approved_at = $3, review_note = $4,
            attempt_count = 0, next_attempt_at = NULL, claim_token = NULL,
            hold_reason = NULL, updated_at = $3
      WHERE id = $1 AND status = ANY($2::text[])
      RETURNING ${CYCLE_COLS}`,
    [id, allowed, now, note || null]
  );
  return r.rows[0] || null;
}

async function cancelCycle(id, note, now) {
  const r = await db.query(
    `UPDATE report_cycles
        SET status = 'cancelled', review_note = $2, claim_token = NULL, updated_at = $3
      WHERE id = $1 AND status IN ('scheduled', 'needs_review', 'failed', 'uncertain')
      RETURNING ${CYCLE_COLS}`,
    [id, note || null, now]
  );
  return r.rows[0] || null;
}

async function countByStatus() {
  const r = await db.query("SELECT status, COUNT(*)::int AS n FROM report_cycles GROUP BY status");
  return Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
}

module.exports = {
  computeCycleWindow,
  clientTimezone,
  reportDelayDays,
  recordPayment,
  recordPaymentFromWebhook,
  invoicePaidAt,
  paymentExists,
  lastPaymentAt,
  listDueCycles,
  getCycle,
  setHold,
  markNeedsReview,
  claim,
  releaseForRetry,
  markSending,
  markSent,
  markTerminal,
  markPreview,
  recoverStale,
  listAttention,
  approveForSend,
  cancelCycle,
  countByStatus,
};
