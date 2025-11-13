const express = require('express');
const app = express();

// Apply express.json() globally for all other routes
app.use(express.json());

// Mount /webhook route with raw body parser
const stripeWebhook = require('./stripeWebhook');
app.use('/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

// Example: Mount other routes if you have them
// app.use('/sms', require('./sendSms'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
