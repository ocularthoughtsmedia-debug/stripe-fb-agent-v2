// sendSms.js
const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;

if (!accountSid || !authToken || !fromNumber) {
  console.warn('⚠️ Twilio environment variables missing.');
}

const client = twilio(accountSid, authToken);

async function sendSms(to, body) {
  try {
    const msg = await client.messages.create({
      from: fromNumber,
      to,
      body,
    });

    console.log(`📨 SMS sent to ${to}. SID: ${msg.sid}`);
    return msg;
  } catch (err) {
    console.error('❌ Error sending SMS:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = { sendSms };
