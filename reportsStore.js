// reportsStore.js
const fs = require("fs");
const path = require("path");
const STORE_PATH = path.join(__dirname, "reports.json");

function readStore() {
  if (!fs.existsSync(STORE_PATH)) fs.writeFileSync(STORE_PATH, "{}");
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
}

function writeStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function getClientReportState(customerId) {
  const store = readStore();
  return store[customerId] || {
    cycleCount: 0,
    cycleStartAt: null,
    lastPaymentAt: null,
    reportScheduledAt: null,
    reportSentAt: null
  };
}

function setClientReportState(customerId, state) {
  const store = readStore();
  store[customerId] = state;
  writeStore(store);
}

module.exports = { getClientReportState, setClientReportState };
