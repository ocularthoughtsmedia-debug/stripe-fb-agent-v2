// remindersStore.js
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "reminders.json");

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { invoices: {} };
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return { invoices: {} };
    if (!data.invoices) data.invoices = {};
    return data;
  } catch (e) {
    console.error("❌ remindersStore load error:", e.message);
    return { invoices: {} };
  }
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function upsertInvoice(invoiceId, patch) {
  const store = loadStore();
  if (!store.invoices[invoiceId]) store.invoices[invoiceId] = {};
  store.invoices[invoiceId] = { ...store.invoices[invoiceId], ...patch };
  saveStore(store);
  return store.invoices[invoiceId];
}

function getInvoice(invoiceId) {
  const store = loadStore();
  return store.invoices[invoiceId] || null;
}

function markInvoicePaid(invoiceId) {
  return upsertInvoice(invoiceId, { status: "paid", paidAt: Date.now() });
}

function listUnpaidInvoices() {
  const store = loadStore();
  return Object.entries(store.invoices)
    .map(([invoiceId, v]) => ({ invoiceId, ...v }))
    .filter((v) => v.status !== "paid");
}

module.exports = {
  loadStore,
  saveStore,
  upsertInvoice,
  getInvoice,
  markInvoicePaid,
  listUnpaidInvoices,
};
