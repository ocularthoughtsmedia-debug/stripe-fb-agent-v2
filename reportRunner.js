const { DateTime } = require("luxon");
const clients = require("./clients");
const { getClientReportState, setClientReportState } = require("./reportsStore");
const { sendSms } = require("./twilioSms"); // uses your existing Twilio sender
const { getCampaign30DayInsights } = require("./facebookApi");

const LOOP_MS = 5 * 60 * 1000; // every 5 minutes

function formatReport(clientName, metrics) {
  return (
    `📊 30-Day Ad Report — ${clientName}\n` +
    `Reach: ${metrics.reach}\n` +
    `Frequency: ${metrics.frequency}\n` +
    `Impressions: ${metrics.impressions}\n` +
    `Unique Link Clicks: ${metrics.unique_link_clicks}\n` +
    `Unique CTR: ${metrics.unique_ctr}\n` +
    `Reactions: ${metrics.post_reactions}\n` +
    `Comments: ${metrics.post_comments}\n` +
    `Shares: ${metrics.post_shares}`
  );
}

async function processDueReports() {
  const now = Date.now();

  for (const customerId of Object.keys(clients)) {
    const client = clients[customerId];
    if (!client?.phone || !client?.analytics?.campaignIds?.length) continue;

    const state = getClientReportState(customerId);

    // Only send if scheduled and not already sent
    if (!state.reportScheduledAt || state.reportSentAt) continue;
    if (now < state.reportScheduledAt) continue;

    // Pull and compile metrics across all campaign IDs (campaign level)
    let combined = {
      reach: 0,
      frequency: 0,
      impressions: 0,
      unique_link_clicks: 0,
      unique_ctr: 0,
      post_reactions: 0,
      post_comments: 0,
      post_shares: 0
    };

    for (const campaignId of client.analytics.campaignIds) {
      const m = await getCampaign30DayInsights(campaignId);

      combined.reach += Number(m.reach) || 0;
      combined.impressions += Number(m.impressions) || 0;
      combined.unique_link_clicks += Number(m.unique_link_clicks) || 0;
      combined.post_reactions += Number(m.post_reactions) || 0;
      combined.post_comments += Number(m.post_comments) || 0;
      combined.post_shares += Number(m.post_shares) || 0;

      // frequency / ctr aren’t additive; we’ll compute after
      combined.frequency = Math.max(Number(combined.frequency) || 0, Number(m.frequency) || 0);
    }

    // Compute CTR from totals if unique_ctr not reliable across campaigns
    const ctr = combined.impressions > 0
      ? ((combined.unique_link_clicks / combined.impressions) * 100).toFixed(2) + "%"
      : "0%";
    combined.unique_ctr = ctr;

    const msg = formatReport(client.name, combined);

    await sendSms(client.phone, msg);

    // Mark sent and reset cycle
    state.reportSentAt = now;
    state.reportScheduledAt = null;
    state.cycleCount = 0;
    state.cycleStartAt = null;
    state.lastPaymentAt = null;
    setClientReportState(customerId, state);

    console.log(`✅ Sent 30-day report to ${client.name}`);
  }
}

function startReportRunner() {
  console.log("📅 Report runner started (checks every 5 minutes)");
  setInterval(() => processDueReports().catch(() => {}), LOOP_MS);
}

module.exports = { startReportRunner };
