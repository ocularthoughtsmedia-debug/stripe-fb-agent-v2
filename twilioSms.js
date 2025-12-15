const twilio = require("twilio");

function getTwilioClient() {
  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    // You also have API KEY/SECRET, but simplest is Account SID + Auth Token
  } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio env vars missing: TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN");
  }

  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function sendSms(to, body) {
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) throw new Error("Missing TWILIO_PHONE_NUMBER");

  const client = getTwilioClient();

  return client.messages.create({
    from,
    to,
    body,
  });
}

module.exports = { sendSms };
