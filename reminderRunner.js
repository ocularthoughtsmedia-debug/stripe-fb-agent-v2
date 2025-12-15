const { sendSms } = require("./twilioSms");
const store = require("./remindersStore");
const clients = require("./clients");

function makeKey(customerId, invoiceId) {
  return `${customerId}:${invoiceId}`;
}

function nowMs() {
  return Date.now();
}

function oneDayMs() {
  return 24 * 60 * 60 * 1000;
}

/**
 * Schedule up to 3 reminders, once per day.
 * If already exists, don’t reset the counter unless invoice changes.
 */
function scheduleFailedInvoice({ customerId, invoiceId, invoiceUrl, amountDue }) {
  const key = makeKey(customerId, invoiceId);
  const existing = store.get(key);

  // If already active, keep it
  if (existing && existing.status === "active") return;

  const clientCfg = clients[customerId];
  if (!clientCfg?.phone) {
    console.log(`⚠️ No phone on file in clients.js for ${customerId}. Not scheduling reminders.`);
    return;
  }

  store.set(key, {
    status: "active",
    customerId,
    invoiceId,
    invoiceUrl,
    amountDue,
    attemptCount: 0,
    nextSendAt: nowMs(), // send first reminder ASAP
    createdAt: nowMs(),
    clientName: clientCfg.name,
    phone: clientCfg.phone,
  });

  console.log(`📌 Scheduled reminders for ${clientCfg.name} (${customerId}) invoice ${invoiceId}`);
}

function markPaid({ customerId, invoiceId }) {
  const key = makeKey(customerId, invoiceId);
  const existing = store.get(key);
  if (!existing) return;

  existing.status = "paid";
  store.set(key, existing);
  console.log(`✅ Marked paid, stopping reminders: ${key}`);
}

/**
 * Runs every minute: sends due reminders.
 * Stops after 3 sends.
 */
async function runDueReminders() {
  const data = store.all();
  const keys = Object.keys(data);

  for (const key of keys) {
    const r = data[key];
    if (!r || r.status !== "active") continue;
    if (r.nextSendAt > nowMs()) continue;

    // Stop after 3 attempts
    if (r.attemptCount >= 3) {
      r.status = "stopped";
      store.set(key, r);
      console.log(`🛑 Reminder sequence finished (3/3): ${key}`);
      continue;
    }

    // Build message
    const attemptNum = r.attemptCount + 1;
    const msg =
      `Hi ${r.clientName.split(" - ")[0]}, this is Ocular Thoughts Media.\n` +
      `Your invoice is still unpaid (${attemptNum}/3).\n` +
      `Pay here: ${r.invoiceUrl}`;

    try {
      // NOTE: will fail until A2P approved — that’s okay, we’ll keep scheduling.
      const res = await sendSms(r.phone, msg);
      console.log(`📩 Sent reminder ${attemptNum}/3 to ${r.phone}: ${res.sid}`);

      r.attemptCount = attemptNum;
      r.nextSendAt = nowMs() + oneDayMs();
      store.set(key, r);
    } catch (err) {
      console.log(`❌ SMS send failed for ${key}:`, err.message);

      // Don’t spam: push next attempt to tomorrow even if send failed
      // (you can change this later if you want retries sooner)
      r.nextSendAt = nowMs() + oneDayMs();
      store.set(key, r);
    }
  }
}

function startReminderLoop() {
  // Run immediately, then every 60 seconds
  runDueReminders().catch(() => {});
  setInterval(() => runDueReminders().catch(() => {}), 60 * 1000);
  console.log("⏱️ Reminder loop started (runs every 60s)");
}

module.exports = {
  scheduleFailedInvoice,
  markPaid,
  startReminderLoop,
};
