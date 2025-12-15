// testSms.js
require('dotenv').config();
const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;
const toNumber = process.env.TWILIO_MONITOR_NUMBER; // your phone

console.log('TWILIO_ACCOUNT_SID:', accountSid);
console.log('TWILIO_FROM_NUMBER:', fromNumber);
console.log('TWILIO_MONITOR_NUMBER:', toNumber);

if (!accountSid || !authToken || !fromNumber || !toNumber) {
  console.error('❌ Missing one or more Twilio env vars – check your .env file.');
  process.exit(1);
}

const client = twilio(accountSid, authToken);

(async () => {
  try {
    const msg = await client.messages.create({
      from: fromNumber,
      to: toNumber,
      body: 'Test SMS from stripe-fb-agent-v2 ✅'
    });
    console.log('✅ SMS sent. SID:', msg.sid);
  } catch (err) {
    console.error('❌ Error sending SMS:', err.message);
  }
})();
