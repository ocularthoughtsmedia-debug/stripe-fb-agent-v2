const express = require('express');
const app = express();

// Mount /webhook route with raw body parser BEFORE json()
const stripeWebhook = require('./stripeWebhook');
app.use('/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

// Apply express.json() globally AFTER webhook
app.use(express.json());

const { startReminderLoop } = require("./reminderRunner");
startReminderLoop();

// Example: Mount other routes
// app.use('/sms', require('./sendSms'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
