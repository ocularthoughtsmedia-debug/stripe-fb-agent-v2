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
// ⭐ Update Ad Set Budget
async function updateAdSetBudget(adsetId, increaseAmount) {

    const url = `https://graph.facebook.com/v19.0/${adsetId}`;
    const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;

    try {
        console.log(`➡️ Updating ad set ${adsetId} budget by $${increaseAmount}`);

        const response = await axios({
            method: 'POST',
            url: url,
            params: {
                access_token: accessToken,
                lifetime_budget: Math.round(increaseAmount * 100)  // Facebook expects cents
            }
        });

        console.log(`✔️ Budget updated for ad set ${adsetId}:`, response.data);

    } catch (err) {
        console.error(`❌ Error updating budget for ad set ${adsetId}:`, err.response?.data || err.message);
        throw err;
    }
}

// ⭐ Extend Ad Set End Date
async function extendAdSetEndDate(adsetId, daysToAdd) {

    const url = `https://graph.facebook.com/v19.0/${adsetId}`;
    const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;

    const currentEndTime = Math.floor(Date.now() / 1000);
    const newEndTime = currentEndTime + (daysToAdd * 24 * 60 * 60);

    try {
        console.log(`➡️ Extending end date for ad set ${adsetId} by ${daysToAdd} days`);

        const response = await axios({
            method: 'POST',
            url: url,
            params: {
                access_token: accessToken,
                end_time: newEndTime
            }
        });

        console.log(`✔️ End date updated for ad set ${adsetId}:`, response.data);

    } catch (err) {
        console.error(`❌ Error extending end date for ad set ${adsetId}:`, err.response?.data || err.message);
        throw err;
    }
}

// ⭐ Update Campaign Budget (Lifetime Budget Addition)
async function updateCampaignBudget(campaignId, increaseAmount) {
    const url = `https://graph.facebook.com/v19.0/${campaignId}`;
    const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;

    try {
        console.log(`➡️ Updating campaign ${campaignId} budget by $${increaseAmount}`);

        const response = await axios({
            method: 'POST',
            url: url,
            params: {
                access_token: accessToken,
                lifetime_budget: Math.round(increaseAmount * 100)
            }
        });

        console.log(`✔️ Campaign budget updated:`, response.data);

    } catch (err) {
        console.error(`❌ Error updating campaign budget:`, err.response?.data || err.message);
        throw err;
    }


module.exports.updateCampaignBudget = updateCampaignBudget;

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
module.exports.updateAdSetBudget = updateAdSetBudget;
module.exports.extendAdSetEndDate = extendAdSetEndDate;
// ⭐ CLIENT TWO — Weekly Update Logic (Campaign Budget + Adset End Dates)
async function handleClientTwoWeeklyUpdate() {

    // ENV is not needed for this one; we use static IDs you provided
    const campaignId = "120217539262580513";

    const adset1 = "120217539262570513";
    const adset2 = "120228751295640513";

    const weeklyIncrease = 66.25;  // dollars
    const daysToExtend = 7;

    console.log("➡️ Starting Client Two weekly update...");

    try {
        // Increase campaign budget
        await updateCampaignBudget(campaignId, weeklyIncrease);
        console.log("✔️ Campaign budget increased by +$66.25");

        // Extend adset #1
        await extendAdSetEndDate(adset1, daysToExtend);
        console.log("✔️ Ad Set 1 extended +7 days");

        // Extend adset #2
        await extendAdSetEndDate(adset2, daysToExtend);
        console.log("✔️ Ad Set 2 extended +7 days");

        console.log("🎯 Client Two weekly update completed.");
    } catch (err) {
        console.error("❌ Error in Client Two update:", err.message);
        throw err;
    }
}

// Export it
module.exports.handleClientTwoWeeklyUpdate = handleClientTwoWeeklyUpdate;}



