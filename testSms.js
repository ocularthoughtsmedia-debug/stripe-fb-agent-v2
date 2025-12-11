require('dotenv').config();
const { sendSms } = require('./sendSms');

(async () => {
  try {
    await sendSms(
      '+18435648755',
      'Test message from your Stripe-FB Agent + Twilio ✔️'
    );
    console.log('Done.');
  } catch (err) {
    console.error('Failed:', err.message);
  }
})();
