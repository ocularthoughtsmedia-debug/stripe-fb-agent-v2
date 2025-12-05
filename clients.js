// clients.js
//
// This file controls ALL “registry clients” in your automation system.
// Only add new clients here. Existing hard-coded clients in
// stripeWebhook.js will keep working as-is.

module.exports = {
  // EXAMPLE – use this pattern for NEW clients only.
  //
  // "cus_NEWCLIENTID": {
  //   name: "New Restaurant Name",
  //   campaigns: [
  //     {
  //       type: "adset",
  //       increase: 66.25,      // amount to add each billing period
  //       extendDays: 7,        // how many days to extend
  //       adsets: [
  //         "ADSET_ID_1",
  //         "ADSET_ID_2"
  //       ]
  //     },
  //     {
  //       type: "campaign",
  //       campaignId: "CAMPAIGN_ID_HERE",
  //       increase: 66.25,
  //       extendDays: 7,
  //       adsets: [
  //         "ADSET_ID_FOR_ENDDATE_1",
  //         "ADSET_ID_FOR_ENDDATE_2"
  //       ]
  //     }
  //   ]
  // }

};
