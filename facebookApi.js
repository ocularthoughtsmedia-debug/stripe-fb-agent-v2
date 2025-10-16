const axios = require('axios');

async function updateCampaign(campaignId, amount) {
  const url = `https://graph.facebook.com/v19.0/${campaignId}`;
  const newEndTime = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days from now

  const payload = {
    access_token: process.env.FB_ACCESS_TOKEN,
    lifetime_budget: amount,
    end_time: newEndTime,
  };

  try {
    await axios.post(url, null, { params: payload });
    console.log(`📈 Updated Facebook campaign ${campaignId} with $${amount / 100} and end time.`);
  } catch (err) {
    console.error('❌ Facebook API Error:', err.response?.data || err.message);
  }
}

module.exports = updateCampaign;
