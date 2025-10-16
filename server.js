require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const handleStripeEvent = require('./stripeWebhook');

const app = express();
app.use(bodyParser.raw({ type: 'application/json' }));

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    console.log('✅ Webhook received:', event.type);
    await handleStripeEvent(event);
    res.status(200).end();
  } catch (err) {
    console.error('❌ Error handling event:', err.message);
    res.status(500).end();
  }
});

const PORT = 4242;
app.listen(PORT, () => {
  console.log(`✅ Webhook server running on http://localhost:${PORT}`);
});
