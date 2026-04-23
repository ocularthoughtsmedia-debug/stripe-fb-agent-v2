const axios = require('axios');
const { DateTime } = require('luxon');

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
// 🔥 Update AdSet Budget by ADDING to the current budget
async function updateAdSetBudget(adsetId, increaseAmount) {
    const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;

    // 1️⃣ Get current ad set info first
    const readUrl = `https://graph.facebook.com/v19.0/${adsetId}?fields=lifetime_budget&access_token=${accessToken}`;
    const updateUrl = `https://graph.facebook.com/v19.0/${adsetId}`;

    try {
        console.log(`📘 Fetching current budget for ad set ${adsetId}...`);

        const readResponse = await axios.get(readUrl);
        const currentBudget = Number(readResponse.data.lifetime_budget);

        console.log(`💰 Current budget: $${currentBudget / 100}`);

        // 2️⃣ Add weekly increase to the current budget
        const newBudget = currentBudget + Math.round(increaseAmount * 100);

        console.log(`🆕 New budget will be: $${newBudget / 100}`);

        // 3️⃣ Send update to Facebook
        const updateResponse = await axios.post(updateUrl, null, {
            params: {
                access_token: accessToken,
                lifetime_budget: newBudget
            }
        });

        console.log(`✔️ Updated ad set ${adsetId} to new budget: $${newBudget / 100}`, updateResponse.data);

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
    const adset2 = "120231973096780513";
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

    const adset1 = "120229009215670513";   // ✅ Corrected Ad Set 1 ID
    const adset2 = "120232388733760513";   // Correct Ad Set 2 ID
    const weeklyIncrease = 66.25;
    const daysToExtend = 7;

    console.log("🍔 Starting Mikey's Drive Thru weekly update...");

    try {
        // Increase budgets
        await updateAdSetBudget(adset1, weeklyIncrease);
        await updateAdSetBudget(adset2, weeklyIncrease);
        console.log(`💵 Budgets increased by +$${weeklyIncrease} for both ad sets`);

        // Extend end dates
        await extendAdSetEndDate(adset1, daysToExtend);
        await extendAdSetEndDate(adset2, daysToExtend);
        console.log(`📅 Ad Sets extended +${daysToExtend} days each`);

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
    const adsetB3 = "120237988282320513";
    const weeklyIncreaseB = 132.50;
    const daysToExtendB = 7;

    console.log("🍗 Sisters of the New South – Campaign B update starting...");

    try {
        // Increase campaign lifetime budget (uses your existing helper)
        await updateCampaignBudget(campaignBId, weeklyIncreaseB);
        console.log(`💵 Campaign B: campaign budget increased by +$${weeklyIncreaseB}`);

        // Extend adset end dates
        await extendAdSetEndDate(adsetB1, daysToExtendB);
        await extendAdSetEndDate(adsetB2, daysToExtendB);
        await extendAdSetEndDate(adsetB3, daysToExtendB);
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
// ⭐ CLIENT 8 – Middleton's Mortuary (Myron Middleton)
// AdSet Budget + End Date Monthly Update
async function handleMiddletonsMortuaryUpdate() {

    const adsetId = "120214022610590513";   // Middleton's Ad Set ID
    const monthlyIncrease = 177;             // Amount to add
    const daysToExtend = 30;                 // Extend 30 days

    console.log("⚰️ Starting Middleton's Mortuary monthly update...");

    try {
        // Increase ad set budget
        await updateAdSetBudget(adsetId, monthlyIncrease);
        console.log(`💰 AdSet budget increased by +$${monthlyIncrease}`);

        // Extend end date
        await extendAdSetEndDate(adsetId, daysToExtend);
        console.log(`📅 Ad Set extended +${daysToExtend} days`);

        console.log("⚰️ Middleton's Mortuary monthly update completed.");
    } catch (err) {
        console.error("❌ Error in Middleton's Mortuary update:", err.message);
        throw err;
    }
}
// ⭐ CLIENT 9 – The Q Spot (Rasheda Brown)
// Campaign Budget + AdSet End Date Monthly Update
async function handleQSpotUpdate() {

    const campaignId = "120207128523590513";    // Q Spot Campaign ID
    const adsetId = "120228753459290513";       // Q Spot Ad Set ID
    const monthlyIncrease = 265;                 // Amount to add
    const daysToExtend = 30;                     // Extend by 30 days

    console.log("🍽️ Starting Q Spot monthly update...");

    try {
        // Increase campaign lifetime budget
        await updateCampaignBudget(campaignId, monthlyIncrease);
        console.log(`💰 Campaign budget increased by +$${monthlyIncrease}`);

        // Extend ad set end date
        await extendAdSetEndDate(adsetId, daysToExtend);
        console.log(`📅 Ad Set extended +${daysToExtend} days`);

        console.log("🍽️ Q Spot monthly update completed.");
    } catch (err) {
        console.error("❌ Error in Q Spot update:", err.message);
        throw err;
    }
}

// ⭐ Generic handler for clients defined in clients.js
async function handleRegistryClientUpdate(clientConfig) {
  console.log(`🤖 Auto handler: updating client ${clientConfig.name}`);

  for (const campaign of clientConfig.campaigns) {
    if (campaign.type === "adset") {
  // Adset-level budgets + end dates
  for (const adsetId of campaign.adsets) {
    await updateAdSetBudget(adsetId, campaign.increase);
    await extendAdSetEndDate(adsetId, campaign.extendDays);
  }

} else if (campaign.type === "enddate_only") {
  // ✅ End date only (daily budgets — do NOT change budget)
  for (const adsetId of campaign.adsets) {
    await extendAdSetEndDate(adsetId, campaign.extendDays);
  }

} else if (campaign.type === "campaign") {
  // Campaign-level budget + (optional) adset end dates
  await updateCampaignBudget(campaign.campaignId, campaign.increase);

  if (campaign.adsets?.length) {
    for (const adsetId of campaign.adsets) {
      await extendAdSetEndDate(adsetId, campaign.extendDays);
    }
  }

} else {
  console.log(`⚠️ Unknown campaign type "${campaign.type}" for client ${clientConfig.name} – skipping`);
}

  }

  console.log(`✅ Auto handler finished for ${clientConfig.name}`);
}
// Pull last 30 days campaign-level metrics
async function getCampaign30DayInsights(campaignId) {
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/v19.0/${campaignId}/insights`;

  const fields = [
    "reach",
    "frequency",
    "impressions",
    "unique_link_clicks",
    "unique_ctr",
    "post_reactions",
    "post_comments",
    "post_shares"
  ].join(",");

  const since = DateTime.now().minus({ days: 30 }).toFormat("yyyy-MM-dd");
const until = DateTime.now().toFormat("yyyy-MM-dd");

const params = {
  access_token: accessToken,
  time_range: JSON.stringify({ since, until }),
  fields
};

  const res = await axios.get(url, { params });
  const row = res.data?.data?.[0] || {};

  return {
    reach: row.reach || 0,
    frequency: row.frequency || 0,
    impressions: row.impressions || 0,
    unique_link_clicks: row.unique_link_clicks || 0,
    unique_ctr: row.unique_ctr || 0,
    post_reactions: row.post_reactions || 0,
    post_comments: row.post_comments || 0,
    post_shares: row.post_shares || 0
  };
}

// Export it
module.exports = {
    updateCampaign,                // FIXED
    handleScoopsAndSubsPayment,
    handleClientTwoWeeklyUpdate,
    handleSpillTheBeansUpdate,
    handleSaltAndKoUpdate,
    handleBigZaddysUpdate,
    handleMikeysUpdate,
    handleSistersOfTheNewSouthUpdate,
    handleMiddletonsMortuaryUpdate,
    handleQSpotUpdate,
    updateAdSetBudget,
    extendAdSetEndDate,
    handleRegistryClientUpdate,
    getCampaign30DayInsights,

};






