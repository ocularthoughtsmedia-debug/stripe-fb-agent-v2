// twilioSms.js
const twilio = require("twilio");

function getTwilioClient() {
  // Either AUTH TOKEN method OR API KEY/SECRET method will work.
  // We'll prefer API KEY if present, otherwise fallback to AUTH TOKEN.
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKey = process.env.TWILIO_API_KEY;
  const apiSecret = process.env.TWILIO_API_SECRET;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid) throw new Error("Missing TWILIO_ACCOUNT_SID");

  if (apiKey && apiSecret) return twilio(apiKey, apiSecret, { accountSid });
  if (authToken) return twilio(accountSid, authToken);

  throw new Error("Missing TWILIO credentials (API KEY/SECRET or AUTH TOKEN).");
}

async function sendSms(to, body) {
  const client = getTwilioClient();

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_PHONE_NUMBER;

  if (messagingServiceSid) {
    return client.messages.create({ messagingServiceSid, to, body });
  }

  if (!from) throw new Error("Missing TWILIO_PHONE_NUMBER");
  return client.messages.create({ from, to, body });
}

module.exports = { sendSms };
