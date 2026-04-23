require("dotenv").config();

const express = require("express");
const app = express();

// ✅ Stripe webhook MUST use raw body (so signature verification works)
const stripeWebhook = require("./stripeWebhook");
app.use("/webhook", express.raw({ type: "application/json" }), stripeWebhook);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/twilio/status", (req, res) => {
  console.log("📬 Twilio delivery status callback:", req.body);
  res.sendStatus(200);
});


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
