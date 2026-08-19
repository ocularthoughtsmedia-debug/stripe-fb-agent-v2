const express = require("express");
const router = express.Router();
const Stripe = require("stripe");

const clients = require("./clients"); // generated registry
const { handleRegistryClientUpdate } = require("./facebookApi");
const { scheduleFailedInvoice, markPaid } = require("./reminderRunner");
const { getClientReportState, setClientReportState } = require("./reportsStore");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

router.post("/", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("⚠️ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Only act on invoice.* events
  if (!event?.type?.startsWith("invoice.")) {
    return res.status(200).json({ received: true });
  }

  const invoice = event.data.object;
  const customerId = invoice.customer;
  const client = clients[customerId];

  // ---------------------------
  // PAYMENT FAILED → reminders only (NO FB updates)
  // ---------------------------
  if (event.type === "invoice.payment_failed") {
    if (client) {
      console.log(`📩 Payment failed for client: ${client.name}`);

      scheduleFailedInvoice({
        customerId,
        invoiceId: invoice.id,
        invoiceUrl: invoice.hosted_invoice_url || invoice.invoice_pdf || "",
        amountDue: invoice.amount_due,
        phone: client.phone,
        name: client.name,
        timezone: client.timezone,
      });
    } else {
      console.log(`⚠️ Payment failed for unknown customer: ${customerId}`);
    }

    return res.status(200).json({ received: true });
  }

  // ---------------------------
  // INVOICE PAID → stop reminders only
  // (prevents double FB updates when Stripe sends both events)
  // ---------------------------
  if (event.type === "invoice.paid") {
    markPaid({ invoiceId: invoice.id });
    return res.status(200).json({ received: true });
  }

  // ---------------------------
  // PAYMENT SUCCEEDED → stop reminders + FB update + report tracking
  // ---------------------------
  if (event.type === "invoice.payment_succeeded") {
    if (!client) {
      console.log(`⚠️ Payment succeeded for unknown customer: ${customerId}`);
      return res.status(200).json({ received: true });
    }

    // ── Idempotency, fast path ──
    // lastInvoiceIdProcessed now means "the Facebook work for this invoice
    // COMPLETED", and is written only after that is true (see below).
    //
    // Advisory only. reports.json lives on Render's ephemeral filesystem AND is
    // committed to git, so every deploy resets it — this guard cannot be
    // trusted as the sole defence. The authoritative, deploy-proof guard is the
    // ad_spend_allocations ledger, enforced per Facebook object.
    const state = getClientReportState(customerId);
    if (state.lastInvoiceIdProcessed === invoice.id) {
      console.log(`🟡 Duplicate invoice ignored for ${client.name}: ${invoice.id}`);
      return res.status(200).json({ received: true });
    }

    console.log(`✅ Payment succeeded for client: ${client.name}`);

    // stop reminders for this invoice
    markPaid({ invoiceId: invoice.id });

    // ── Non-Facebook bookkeeping runs NOW ──
    // All of it is safe to repeat if Stripe redelivers: the cycle clock is
    // set-once, lastPaymentAt is just a refresh, and markPaid is idempotent.
    // None of it spends money, so none of it needs to wait for Facebook.
    const billing = client.billing || { reportDelayDays: 2 };

    // Start cycle clock on first successful payment
    if (!state.cycleStartAt) {
      state.cycleStartAt = Date.now();

      // schedule report for 30 days + delayDays after cycle start
      const delayDays = Number(billing.reportDelayDays || 0);
      state.reportScheduledAt =
        state.cycleStartAt + (30 + delayDays) * 24 * 60 * 60 * 1000;

      console.log(
        `📌 Scheduled 30-day report for ${client.name} at ${new Date(state.reportScheduledAt).toISOString()}`
      );
    }

    // always track latest successful payment
    state.lastPaymentAt = Date.now();

    // "We have seen this invoice", which is NOT the same fact as "we have
    // finished funding it". Keeping them separate is the whole fix.
    state.lastInvoiceSeenAt = Date.now();

    setClientReportState(customerId, state);

    // ✅ the ONLY FB update path
    // Each budget increase is recorded permanently in ad_spend_allocations, and
    // that ledger is what makes the redelivery below safe: an object already
    // funded by this invoice is skipped rather than funded twice.
    const result = await handleRegistryClientUpdate(client, {
      stripeCustomerId: customerId,
      stripeInvoiceId: invoice.id,
    });

    // ── Ask Stripe to redeliver, but only when a redelivery is both useful
    //    and safe ──
    // Useful: at least one failure a retry could actually fix.
    // Safe: the ledger was readable, so the retry can tell what already landed.
    // Without the ledger we deliberately answer 200 and accept an under-funded
    // client over risking a double-funded one — a Facebook increase is additive
    // and cannot be taken back.
    if (result.retryable > 0 && result.ledgerAvailable) {
      console.error(
        `🔁 ${client.name}: ${result.retryable} budget update(s) failed for invoice ${invoice.id} — ` +
          `returning 500 so Stripe redelivers. Already-applied increases will be skipped.`
      );
      return res.status(500).json({ error: "ad budget update incomplete" });
    }

    if (result.retryable > 0) {
      console.error(
        `🚨 ${client.name}: ${result.retryable} budget update(s) failed for invoice ${invoice.id}, ` +
          `but the allocation ledger was UNREACHABLE. Answering 200 to suppress Stripe's retry, ` +
          `because without the ledger a redelivery could double-fund. Needs a manual check.`
      );
    }

    if (result.needsReview > 0) {
      console.error(
        `🛑 ${client.name}: ${result.needsReview} allocation(s) for invoice ${invoice.id} need review — ` +
          `a retry cannot resolve these. See ad_spend_allocations WHERE status = 'needs_review'.`
      );
    }

    // Facebook work is done (or is not retryable): NOW record completion.
    state.lastInvoiceIdProcessed = invoice.id;
    state.lastInvoiceProcessedAt = Date.now();
    setClientReportState(customerId, state);

    return res.status(200).json({ received: true });
  }

  return res.status(200).json({ received: true });
});

module.exports = router;