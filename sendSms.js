// sendSms.js
// Simple Twilio SMS helper. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE in .env

const twilio = require('twilio');

let client;
try {
  client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} catch (err) {
  // Keep module load-safe if env vars missing; actual send calls will fail until configured.
  console.warn('⚠️ Twilio client not configured. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env');
}

async function sendSms(to, message) {
  if (!client) {
    console.error('❌ Twilio client missing. Cannot send SMS to', to);
    return;
  }

  try {
    const msg = await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE,
      to,
    });
    console.log(`📲 SMS sent to ${to} — SID: ${msg.sid}`);
  } catch (err) {
    console.error('❌ Failed to send SMS:', err.message || err);
  }
}

module.exports = sendSms;
