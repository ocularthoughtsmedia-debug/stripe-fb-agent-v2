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
     phone: "+18438176803", // <-- client phone number (E.164)
    campaigns: [
      {
        type: "adset",
        increase: 66.25,
        extendDays: 7,
        adsets: [
          "120215555974230513"
        ]
      }
    ]
  }

  // Add more registry clients below using this same pattern

};
