require("dotenv").config();

const express = require("express");
const app = express();

// ✅ Stripe webhook MUST use raw body (so signature verification works)
const stripeWebhook = require("./stripeWebhook");
app.use("/webhook", express.raw({ type: "application/json" }), stripeWebhook);

// ✅ All other routes can use JSON parsing
app.use(express.json());

// ✅ Import reminder runner functions ONCE (no duplicates)
const { startReminderRunner, scheduleFailedInvoice, markPaid } = require("./reminderRunner");

startReminderRunner();
const { startReportRunner } = require("./reportRunner");
startReportRunner();


// ✅ Health check
app.get("/", (req, res) => res.send("OK"));

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
