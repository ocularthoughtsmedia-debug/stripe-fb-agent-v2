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
    const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;

    try {
        console.log(`🔍 Fetching current budget for campaign ${campaignId}...`);

        // STEP 1 — Get existing budget
        const getResponse = await axios({
            method: 'GET',
            url: `https://graph.facebook.com/v19.0/${campaignId}`,
            params: {
                access_token: accessToken,
                fields: 'lifetime_budget'
            }
        });

        const currentBudgetCents = getResponse.data.lifetime_budget;
        const currentBudget = currentBudgetCents / 100;

        console.log(`💰 Current campaign budget: $${currentBudget}`);

        // STEP 2 — Add increaseAmount
        const newBudget = currentBudget + increaseAmount;
        const newBudgetCents = Math.round(newBudget * 100);

        console.log(`⬆️ New campaign budget will be: $${newBudget}`);

        // STEP 3 — Update the campaign budget
        const updateResponse = await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v19.0/${campaignId}`,
            params: {
                access_token: accessToken,
                lifetime_budget: newBudgetCents
            }
        });

        console.log(`✅ Campaign budget updated to $${newBudget}`, updateResponse.data);

    } catch (err) {
        console.error(`❌ Error updating campaign budget:`, err.response?.data || err.message);
        throw err;
    }
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
// ⭐ CLIENT 3 — Spill The Beans Update (AdSet Budgets + End Date)
async function handleSpillTheBeansUpdate() {

    const adset1 = "120230160869600513";   // Spill The Beans ad set ID
    const weeklyIncrease = 66.25;
    const daysToExtend = 7;

    console.log("☕ Starting Spill The Beans weekly update...");

    try {
        // Increase ad set budget
        await updateAdSetBudget(adset1, weeklyIncrease);
        console.log(`☕ AdSet budget increased by +$${weeklyIncrease}`);

        // Add 7 days to end date
        await extendAdSetEndDate(adset1, daysToExtend);
        console.log(`☕ AdSet extended +${daysToExtend} days`);

        console.log("☕ Spill The Beans weekly update completed.");
    } catch (err) {
        console.error("❌ Error in Spill The Beans update:", err.message);
        throw err;
    }
}
// ⭐ CLIENT 4 – Salt & KO Weekly Update (AdSet Budgets + End Dates)
async function handleSaltAndKoUpdate() {

    const adset1 = "120226475065410513";   // Salt & KO Ad Set 1 ID
    const adset2 = "120232314137180513";   // Salt & KO Ad Set 2 ID
    const weeklyIncrease = 66.25;
    const daysToExtend = 7;

    console.log("🧂 Starting Salt & KO weekly update...");

    try {

        // Increase both ad set budgets
        await updateAdSetBudget(adset1, weeklyIncrease);
        await updateAdSetBudget(adset2, weeklyIncrease);
        console.log(`✔️ Budgets increased by +$${weeklyIncrease} for both ad sets`);

        // Extend both ad sets by 7 days
        await extendAdSetEndDate(adset1, daysToExtend);
        await extendAdSetEndDate(adset2, daysToExtend);
        console.log(`✔️ Ad Sets extended +${daysToExtend} days each`);

        console.log("🎉 Salt & KO weekly update completed.");

    } catch (err) {
        console.error("❌ Error in Salt & KO update:", err.message);
        throw err;
    }
}
// ⭐ CLIENT 5 – Big Zaddy’s Burgers Weekly Update (AdSet Budgets + End Dates)
async function handleBigZaddysUpdate() {

    const adset1 = "120230224956520513";
    const adset2 = "120230224956530513";
    const adset3 = "120233905457990513";

    const weeklyIncrease = 66.25;
    const daysToExtend = 7;

    console.log("🍔 Starting Big Zaddy’s weekly update...");

    try {
        // Increase budgets for all 3 ad sets
        await updateAdSetBudget(adset1, weeklyIncrease);
        await updateAdSetBudget(adset2, weeklyIncrease);
        await updateAdSetBudget(adset3, weeklyIncrease);
        console.log(`💵 Budgets increased by +$${weeklyIncrease} for all 3 ad sets`);

        // Extend all 3 ad sets by 7 days
        await extendAdSetEndDate(adset1, daysToExtend);
        await extendAdSetEndDate(adset2, daysToExtend);
        await extendAdSetEndDate(adset3, daysToExtend);
        console.log(`📅 All 3 ad sets extended +${daysToExtend} days`);

        console.log("🍔 Big Zaddy’s weekly update completed.");
    } catch (err) {
        console.error("❌ Error in Big Zaddy’s update:", err.message);
        throw err;
    }
}
// ⭐ CLIENT 6 – Mikey's Drive Thru Weekly Update (AdSet Budgets + End Dates)
async function handleMikeysUpdate() {

    const adset1 = "120229009215660513";  // Mikey's Ad Set 1 ID
    const adset2 = "120232388733760513";  // Mikey's Ad Set 2 ID
    const weeklyIncrease = 66.25;
    const daysToExtend = 7;

    console.log("🍔 Starting Mikey's Drive Thru weekly update...");

    try {
        // Increase ad set budgets
        await updateAdSetBudget(adset1, weeklyIncrease);
        await updateAdSetBudget(adset2, weeklyIncrease);
        console.log(`💸 Budgets increased by +$${weeklyIncrease} for both ad sets`);

        // Extend end dates
        await extendAdSetEndDate(adset1, daysToExtend);
        await extendAdSetEndDate(adset2, daysToExtend);
        console.log(`⏳ Ad Sets extended +${daysToExtend} days each`);

        console.log("✅ Mikey's Drive Thru weekly update completed.");
    } catch (err) {
        console.error("❌ Error in Mikey's Drive Thru update:", err.message);
        throw err;
    }
}
// ⭐ CLIENT 7 – Sisters of the New South (Kenneth Brown)

// Campaign A – Adset-level budgets + end dates
async function handleSistersCampaignAUpdate() {
    const adsetA1 = "120219858584840513";
    const adsetA2 = "120224236882420513";
    const weeklyIncreaseA = 45.57;
    const daysToExtendA = 7;

    console.log("🍗 Sisters of the New South – Campaign A update starting...");

    try {
        // Increase adset budgets
        await updateAdSetBudget(adsetA1, weeklyIncreaseA);
        await updateAdSetBudget(adsetA2, weeklyIncreaseA);
        console.log(`💵 Campaign A: budgets increased by +$${weeklyIncreaseA} for both ad sets`);

        // Extend adset end dates
        await extendAdSetEndDate(adsetA1, daysToExtendA);
        await extendAdSetEndDate(adsetA2, daysToExtendA);
        console.log(`📅 Campaign A: both ad sets extended +${daysToExtendA} days`);

    } catch (err) {
        console.error("❌ Error in Sisters Campaign A update:", err.message);
        throw err;
    }
}

// Campaign B – Campaign-level budget + adset end dates
async function handleSistersCampaignBUpdate() {
    const campaignBId = "120215309917460513";
    const adsetB1 = "120215309917450513";
    const adsetB2 = "120228847438770513";
    const weeklyIncreaseB = 66.25;
    const daysToExtendB = 7;

    console.log("🍗 Sisters of the New South – Campaign B update starting...");

    try {
        // Increase campaign lifetime budget (uses your existing helper)
        await updateCampaignBudget(campaignBId, weeklyIncreaseB);
        console.log(`💵 Campaign B: campaign budget increased by +$${weeklyIncreaseB}`);

        // Extend adset end dates
        await extendAdSetEndDate(adsetB1, daysToExtendB);
        await extendAdSetEndDate(adsetB2, daysToExtendB);
        console.log(`📅 Campaign B: both ad sets extended +${daysToExtendB} days`);

    } catch (err) {
        console.error("❌ Error in Sisters Campaign B update:", err.message);
        throw err;
    }
}

// Master handler – run both Campaign A and B for this client
async function handleSistersOfTheNewSouthUpdate() {
    console.log("🍗 Starting Sisters of the New South full weekly update (Campaign A + B)...");

    try {
        await handleSistersCampaignAUpdate();
        await handleSistersCampaignBUpdate();

        console.log("✅ Sisters of the New South weekly update completed (Campaign A + B).");
    } catch (err) {
        console.error("❌ Error in Sisters of the New South master update:", err.message);
        throw err;
    }
}


// Export it
module.exports = {
    updateCampaignBudget,
    handleScoopsAndSubsPayment,
    handleClientTwoWeeklyUpdate,
    handleSpillTheBeansUpdate,
    handleSaltAndKoUpdate,
    handleBigZaddysUpdate,
    handleMikeysUpdate,
    handleSistersOfTheNewSouthUpdate,
    updateAdSetBudget,
    extendAdSetEndDate
};





