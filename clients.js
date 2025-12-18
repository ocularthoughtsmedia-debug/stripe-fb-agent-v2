//
// clients.js
//
// This file controls ALL "registry clients" in your automation system.
// Only add new clients here. Existing hard-coded clients in
// stripeWebhook.js will keep working as-is.
//

module.exports = {

  // ---------------------------
  // ⭐ EXAMPLE TEMPLATE (KEEP IT)
  // ---------------------------
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
  //     }
  //   ]
  // },

  // --------------------------------------
  // ⭐ Tierra Rivers – Carolina Hair Restoration Center
  // --------------------------------------
  "cus_TZaC5DLP8RGTxn": {
  name: "Tierra Rivers - Carolina Hair Restoration Center",
  phone: "+18438176803",
  timezone: "America/New_York",

  billing: {
    cadence: "weekly",
    paymentsPerCycle: 4,     // 4 weekly payments = 1 “month”
    reportDelayDays: 2       // send report 2 days after payment #4
  },

  analytics: {
    level: "campaign",
    campaignIds: ["1202XXXXXXXXXXXXXXX"]   // <-- put her campaign ID here
  },

  campaigns: [
    {
      type: "adset",
      increase: 66.25,
      extendDays: 7,
      adsets: ["120215555974230513"]
    }
  ]
}


  // Add more registry clients below using this same pattern

};
