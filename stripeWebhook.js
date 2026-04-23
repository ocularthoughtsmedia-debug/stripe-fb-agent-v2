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

    // idempotency guard (prevents processing same invoice twice)
    const state = getClientReportState(customerId);
    if (state.lastInvoiceIdProcessed === invoice.id) {
      console.log(`🟡 Duplicate invoice ignored for ${client.name}: ${invoice.id}`);
      return res.status(200).json({ received: true });
    }

    console.log(`✅ Payment succeeded for client: ${client.name}`);

    // stop reminders for this invoice
    markPaid({ invoiceId: invoice.id });

   // cycle/report tracking (TRUE 30-day schedule)
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

// keep your idempotency fields
state.lastInvoiceIdProcessed = invoice.id;
state.lastInvoiceProcessedAt = Date.now();

setClientReportState(customerId, state);

    setClientReportState(customerId, state);

    // ✅ the ONLY FB update path
    await handleRegistryClientUpdate(client);

    return res.status(200).json({ received: true });
  }

  return res.status(200).json({ received: true });
});

module.exports = router;