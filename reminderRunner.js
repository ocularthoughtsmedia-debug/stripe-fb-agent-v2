const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");

const STORE_PATH = path.join(__dirname, "reminders.json");

// How often to check the reminder store (seconds)
const CHECK_EVERY_SECONDS = Number(process.env.REMINDER_CHECK_SECONDS || 60);

// How long between reminders (minutes) after a failed invoice is scheduled/sent
// (Default 24 hours = 1440 minutes)
const REMINDER_INTERVAL_MINUTES = Number(process.env.REMINDER_INTERVAL_MINUTES || 1440);

// Max reminders to send before stopping
const MAX_ATTEMPTS = Number(process.env.REMINDER_MAX_ATTEMPTS || 3);

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("❌ Failed to read reminders store:", e.message);
    return [];
  }
}

function writeStore(reminders) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(reminders, null, 2), "utf8");
  } catch (e) {
    console.error("❌ Failed to write reminders store:", e.message);
  }
}

function upsertReminder(reminder) {
  const reminders = readStore();
  const idx = reminders.findIndex((r) => r.invoiceId === reminder.invoiceId);
  if (idx >= 0) reminders[idx] = { ...reminders[idx], ...reminder };
  else reminders.push(reminder);
  writeStore(reminders);
}

function markPaid({ invoiceId }) {
  if (!invoiceId) return;

  const reminders = readStore();
  const idx = reminders.findIndex((r) => r.invoiceId === invoiceId);
  if (idx === -1) return;

  reminders[idx].status = "paid";
  reminders[idx].paidAt = DateTime.now().toISO();
  reminders[idx].nextSendAt = null;

  writeStore(reminders);
}

function scheduleFailedInvoice({ customerId, invoiceId, invoiceUrl, amountDue }) {
  if (!invoiceId) throw new Error("invoiceId is required");
  if (!invoiceUrl) throw new Error("invoiceUrl is required");

  // ✅ This is what your current file is missing
  const nextSendAt = DateTime.now().plus({ minutes: 1 }).toISO(); // 1 minute for easy local testing

  upsertReminder({
    customerId: customerId || null,
    invoiceId,
    invoiceUrl,
    amountDue: Number.isFinite(amountDue) ? amountDue : null,
    status: "unpaid",
    attempts: 0,
    lastSentAt: null,
    nextSendAt,
    createdAt: DateTime.now().toISO(),
  });
}

async function sendReminder(reminder) {
  // ✅ For now we just log. Later we’ll plug in Twilio/Google Voice.
  console.log("📩 REMINDER SEND (stub)");
  console.log({
    invoiceId: reminder.invoiceId,
    customerId: reminder.customerId,
    invoiceUrl: reminder.invoiceUrl,
    amountDue: reminder.amountDue,
    attempts: reminder.attempts,
  });
}

let _runnerStarted = false;

function startReminderRunner() {
  if (_runnerStarted) return;
  _runnerStarted = true;

  console.log(`🧠 Reminder runner started (checks every ${CHECK_EVERY_SECONDS}s)`);

  setInterval(async () => {
    const reminders = readStore();
    if (!reminders.length) return;

    const now = DateTime.now();

    let changed = false;

    for (const r of reminders) {
      if (r.status !== "unpaid") continue;
      if (!r.nextSendAt) continue;

      const due = DateTime.fromISO(r.nextSendAt);
      if (!due.isValid) continue;

      if (due <= now) {
        const attempts = Number(r.attempts || 0);

        if (attempts >= MAX_ATTEMPTS) {
          r.status = "stopped";
          r.nextSendAt = null;
          r.stoppedAt = now.toISO();
          console.log(`🛑 Max attempts reached. Stopping reminders for ${r.invoiceId}`);
          changed = true;
          continue;
        }

        await sendReminder(r);

        r.attempts = attempts + 1;
        r.lastSentAt = now.toISO();

        // After sending, schedule the next reminder
        r.nextSendAt = now.plus({ minutes: REMINDER_INTERVAL_MINUTES }).toISO();
        changed = true;
      }
    }

    if (changed) writeStore(reminders);
  }, CHECK_EVERY_SECONDS * 1000);
}

module.exports = {
  scheduleFailedInvoice,
  markPaid,
  startReminderRunner,
};
