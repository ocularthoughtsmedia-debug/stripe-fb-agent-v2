const express = require('express');
const router = express.Router();
const Stripe = require('stripe');

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

        const {
            handleSistersCampaignAUpdate,
            handleSistersCampaignBUpdate
        } = require('./facebookApi');

        // Run BOTH campaigns
        await handleSistersCampaignAUpdate();
        await handleSistersCampaignBUpdate();

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


  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    console.log("⚠️ No matching client handler for:", invoice.customer);
    console.log("Payment amount:", invoice.amount_paid);
}


  res.status(200).json({ received: true });
});

module.exports = router;
