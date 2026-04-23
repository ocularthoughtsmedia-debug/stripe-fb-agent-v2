// reportsStore.js
const fs = require("fs");
const path = require("path");
const STORE_PATH = path.join(__dirname, "reports.json");

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      fs.writeFileSync(STORE_PATH, "{}", "utf8");
      return {};
    }

    const raw = fs.readFileSync(STORE_PATH, "utf8").trim();
    if (!raw) return {};

    return JSON.parse(raw);
  } catch (e) {
    console.error("❌ reportsStore: failed to read/parse reports.json:", e.message);

    // Backup the corrupted file so you don't lose it
    try {
      const backupPath = STORE_PATH.replace(/\.json$/, `.corrupt.${Date.now()}.json`);
      fs.copyFileSync(STORE_PATH, backupPath);
      console.error("🧾 Backed up corrupt reports.json to:", backupPath);
    } catch (_) {}

    // Reset to empty store
    try {
      fs.writeFileSync(STORE_PATH, "{}", "utf8");
    } catch (_) {}

    return {};
  }
}

function writeStore(data) {
  const tmpPath = STORE_PATH + ".tmp";
  const payload = JSON.stringify(data, null, 2);

  fs.writeFileSync(tmpPath, payload, "utf8");
  fs.renameSync(tmpPath, STORE_PATH);
}

function getClientReportState(customerId) {
  const store = readStore();
  return store[customerId] || {
  cycleCount: 0,
  cycleStartAt: null,
  lastPaymentAt: null,
  reportScheduledAt: null,
  reportSentAt: null,
  lastInvoiceIdProcessed: null,
  lastInvoiceProcessedAt: null,
};
}

function setClientReportState(customerId, state) {
  const store = readStore();
  store[customerId] = state;
  writeStore(store);
}

module.exports = { getClientReportState, setClientReportState };
