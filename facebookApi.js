const axios = require('axios');

async function updateCampaign(amount) {
  const campaignId = process.env.FB_CAMPAIGN_ID;
  const url = `https://graph.facebook.com/v19.0/${campaignId}`;
  const newEndTime = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days from now

  const payload = {
    access_token: process.env.FB_ACCESS_TOKEN,
    lifetime_budget: amount,
    end_time: newEndTime,
  };

  try {
    const response = await axios({
      method: 'POST',
      url: url,
      params: payload,
      timeout: 10000, // 10 seconds to avoid hangs
    });

    console.log(`✅ Updated Facebook campaign ${campaignId} with $${amount / 100} and end time.`);
    console.log('📡 FB API Response:', response.data);
  } catch (err) {
    console.error('❌ Facebook API Error:', err?.response?.data || err.message);
  }
}

module.exports = updateCampaign;
// ⭐ SCOOPS & SUBS — Permanent weekly update logic ⭐
async function handleScoopsAndSubsPayment() {
    const adset1 = process.env.FB_ADSET_1_ID;
    const adset2 = process.env.FB_ADSET_2_ID;

    const weeklyIncrease = 66.25; 
    const daysToExtend = 7;

    console.log("➡️ Starting Scoops & Subs update...");

    try {
        // Increase budgets
        await updateAdSetBudget(adset1, weeklyIncrease);
        await updateAdSetBudget(adset2, weeklyIncrease);
        console.log("✔️ Budgets increased by +$66.25 for each ad set");

        // Extend end dates
        await extendAdSetEndDate(adset1, daysToExtend);
        await extendAdSetEndDate(adset2, daysToExtend);
        console.log("✔️ End dates extended by +7 days for each ad set");

        console.log("🎯 Scoops & Subs update completed.");
    } catch (err) {
        console.error("❌ Error updating Scoops & Subs:", err.message);
        throw err;
    }
}

// Export the function so stripeWebhook.js can use it
module.exports.handleScoopsAndSubsPayment = handleScoopsAndSubsPayment;


