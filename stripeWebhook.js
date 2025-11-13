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

  // ✅ Stripe event verified — now handle it
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
