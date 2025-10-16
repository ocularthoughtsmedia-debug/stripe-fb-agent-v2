const updateCampaign = require('./facebookApi');
const sendSms = require('./sendSms');

// Confirm this runs every time
console.log('✅ stripeWebhook.js has loaded');

async function handleStripeEvent(event) {
  console.log('⚡️ Stripe event received:', event.type); // <-- THIS SHOULD PRINT

  const invoice = event.data.object;
  const customerId = invoice.customer;

  if (event.type === 'invoice.payment_succeeded') {
    const campaignId = await getCampaignIdFromCustomer(customerId);
    const amount = invoice.amount_paid;
    console.log(`📈 Updating Facebook campaign for customer ${customerId} with $${amount / 100}`);
    await updateCampaign(campaignId, amount);
  }

  if (event.type === 'invoice.payment_failed') {
    const phone = await getPhoneNumberFromCustomer(customerId);
    const invoiceUrl = invoice.hosted_invoice_url;
    console.log(`📲 Sending SMS to ${phone} for failed payment`);
    await sendSms(phone, `Your payment failed. Please complete it here: ${invoiceUrl}`);
  }
}

async function getCampaignIdFromCustomer(customerId) {
  return '123456789012345'; // placeholder
}

async function getPhoneNumberFromCustomer(customerId) {
  return process.env.ADMIN_PHONE || '+15555555555';
}

module.exports = handleStripeEvent;
