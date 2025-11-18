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

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    console.log('✅ Payment succeeded for customer:', invoice.customer);
    console.log('💵 Amount paid:', invoice.amount_paid);

    const updateCampaign = require('./facebookApi');
    await updateCampaign(invoice.amount_paid);
  }

  res.status(200).json({ received: true });
});

module.exports = router;
