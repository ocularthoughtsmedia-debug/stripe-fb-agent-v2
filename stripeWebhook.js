const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const clients = require('./clients');  // ⭐ client registry

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

router.post('/', async (req, res) => {
const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
// ===============================
// REGISTRY CLIENT HANDLER (Tierra + future new clients)
// ===============================
const { handleRegistryClientUpdate } = require('./facebookApi');
const { scheduleFailedInvoice, markPaid } = require('./reminderRunner');

// Payment failed → schedule reminders (NO Facebook updates)
if (event.type === "invoice.payment_failed") {
  const invoice = event.data.object;
  const client = clients[invoice.customer];

  if (client) {
    console.log(`📩 Payment failed for registry client: ${client.name}`);

    scheduleFailedInvoice({
      customerId: invoice.customer,
      invoiceId: invoice.id,
      invoiceUrl: invoice.hosted_invoice_url || invoice.invoice_pdf || "",
      amountDue: invoice.amount_due,
      phone: client.phone,
      timezone: client.timezone
    });
  } else {
    console.log(`⚠️ Payment failed for unknown customer: ${invoice.customer}`);
  }

  return res.status(200).json({ received: true });
}

// Payment succeeded → cancel reminders + update ads
if (event.type === "invoice.payment_succeeded" || event.type === "invoice.paid") {
  const invoice = event.data.object;
  const client = clients[invoice.customer];

  if (client) {
    console.log(`✅ Payment recovered for registry client: ${client.name}`);
    markPaid({ invoiceId: invoice.id });

    // Trigger Facebook updates using the registry config
    await handleRegistryClientUpdate(client);

    return res.status(200).json({ received: true });
  }
}


  // --- PAYMENT FAILED: schedule reminders (NO Facebook updates)
if (event.type === "invoice.payment_failed") {
  const invoice = event.data.object;

  scheduleFailedInvoice({
    customerId: invoice.customer,
    invoiceId: invoice.id,
    invoiceUrl: invoice.hosted_invoice_url || invoice.invoice_pdf || "",
    amountDue: invoice.amount_due,
  });

  return res.status(200).json({ received: true });
}

// --- PAYMENT SUCCEEDED / PAID: stop reminders
if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
  const invoice = event.data.object;
  markPaid({ invoiceId: invoice.id });
  // DO NOT return — let FB logic continue
}

// ...
if (event.type === "invoice.payment_failed") {
  const invoice = event.data.object;

  // invoice.hosted_invoice_url is usually what you want
  scheduleFailedInvoice({
    customerId: invoice.customer,
    invoiceId: invoice.id,
    invoiceUrl: invoice.hosted_invoice_url || invoice.invoice_pdf || "",
    amountDue: invoice.amount_due,
  });

  return res.status(200).json({ received: true });
}

if (event.type === "invoice.payment_succeeded" || event.type === "invoice.paid") {
  const invoice = event.data.object;

  markPaid({
    customerId: invoice.customer,
    invoiceId: invoice.id,
  });

  // keep your existing “update Facebook budgets/end dates” logic below
}

// ✅ Ignore this specific old Stripe event so it stops retrying
if (event.id === "evt_1SW2owBjZM5iQBk42BvHfZz7") {
    console.log("Ignoring old Stripe event:", event.id);
    return res.status(200).json({ received: true });
}
  // 🤖 AUTO-CLIENT HANDLER: use clients.js for new clients
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    const clientConfig = clients[invoice.customer];

    if (clientConfig) {
      console.log('🤖 Auto client match for', clientConfig.name, '(', invoice.customer, ')');
      const { handleRegistryClientUpdate } = require('./facebookApi');

      await handleRegistryClientUpdate(clientConfig);

      return res.status(200).json({ received: true });
    }
  }

  // ✅ Stripe event verified — now handle it // ⭐ SCOOPS & SUBS — Detect this client's payments ⭐// ⭐ CLIENT: Automatic Weekly Update (Campaign Budget + End Dates)
if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    // This client's Stripe customer ID
    const CLIENT_TWO_ID = "cus_SDerLwePwWxkc5";

    if (invoice.customer === CLIENT_TWO_ID) {
        console.log("➡️ Client Two payment detected!");

        // Load the handler function
        const { handleClientTwoWeeklyUpdate } = require('./facebookApi');

        await handleClientTwoWeeklyUpdate();
        return res.status(200).json({ received: true });
    }
}

if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    // Replace this with Arah Williams' actual Stripe customer ID
    const SCOOPS_CUSTOMER_ID = "cus_StFbuW9XQ1IERH";

    if (invoice.customer === SCOOPS_CUSTOMER_ID) {
        console.log("➡️ Scoops & Subs payment detected!");

        // Load the handler function
        const { handleScoopsAndSubsPayment } = require('./facebookApi');

        await handleScoopsAndSubsPayment();
        return res.status(200).json({ received: true });
    }
}
// ⭐ CLIENT 3 — Spill The Beans (Robbie Wilkerson)
if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    const SPILL_CUSTOMER_ID = "cus_TEyLO2B2ut8Mcx";

    if (invoice.customer === SPILL_CUSTOMER_ID) {
        console.log("☕ Spill The Beans payment detected!");

        const { handleSpillTheBeansUpdate } = require('./facebookApi');
        await handleSpillTheBeansUpdate();

        return res.status(200).json({ received: true });
    }
}
// ⭐ CLIENT 4 – Salt & KO (Ryan Salter)
if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    const SALT_KO_CUSTOMER_ID = "cus_SyBU8uZluGlMnx";

    if (invoice.customer === SALT_KO_CUSTOMER_ID) {
        console.log("🧂 Salt & KO payment detected!");

        const { handleSaltAndKoUpdate } = require('./facebookApi');
        await handleSaltAndKoUpdate();

        return res.status(200).json({ received: true });
    }
}
// ⭐ CLIENT 5 – Big Zaddy’s Burgers (Lex Lindsey)
if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    const BIG_ZADDYS_CUSTOMER_ID = "cus_T9qdTAlveyKzmV";

    if (invoice.customer === BIG_ZADDYS_CUSTOMER_ID) {
        console.log("🍔 Big Zaddy’s Burgers payment detected!");

        const { handleBigZaddysUpdate } = require('./facebookApi');
        await handleBigZaddysUpdate();

        return res.status(200).json({ received: true });
    }
}
// ⭐ CLIENT 6 – Mikey's Drive Thru (Nel Ancrum)
if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    const MIKEYS_CUSTOMER_ID = "cus_T4otdg14dN1oVK";

    if (invoice.customer === MIKEYS_CUSTOMER_ID) {
        console.log("🍔 Mikey's Drive Thru payment detected!");

        const { handleMikeysUpdate } = require('./facebookApi');
        await handleMikeysUpdate();

        return res.status(200).json({ received: true });
    }
}
// ⭐ CLIENT 7 – Sisters of the New South (Kenneth Brown)
if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    const SISTERS_CUSTOMER_ID = "cus_RqnzWFn5JhZNOP";

    if (invoice.customer === SISTERS_CUSTOMER_ID) {
        console.log("🍽️ Sisters of the New South payment detected!");

        const { handleSistersOfTheNewSouthUpdate } = require('./facebookApi');

await handleSistersOfTheNewSouthUpdate();


        return res.status(200).json({ received: true });
    }
}
// ⭐ CLIENT 8 – Middleton's Mortuary (Myron Middleton)
if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    const MIDDLETONS_CUSTOMER_ID = "cus_RVuVWsYQeqaWk4";

    if (invoice.customer === MIDDLETONS_CUSTOMER_ID) {
        console.log("⚰️ Middleton's Mortuary payment detected!");

        const { handleMiddletonsMortuaryUpdate } = require('./facebookApi');
        await handleMiddletonsMortuaryUpdate();

        return res.status(200).json({ received: true });
    }
}
// ⭐ CLIENT 9 – The Q Spot (Rasheda Brown)
if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    const QSPOT_CUSTOMER_ID = "cus_TOAHOHfXHuTdKU";

    if (invoice.customer === QSPOT_CUSTOMER_ID) {
        console.log("🍽️ Q Spot payment detected!");

        const { handleQSpotUpdate } = require('./facebookApi');
        await handleQSpotUpdate();

        return res.status(200).json({ received: true });
    }
}


  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    console.log("⚠️ No matching client handler for:", invoice.customer);
    console.log("Payment amount:", invoice.amount_paid);
}


  res.status(200).json({ received: true });
});

module.exports = router;
