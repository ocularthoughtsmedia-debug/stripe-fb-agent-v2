// clientsConfigRoute.js
// Read-only endpoint that serves the current contents of clientsData.json.
// Purely additive — does not touch the generated clients.js registry that
// stripeWebhook.js / reportRunner.js rely on.

const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

const DATA_PATH = path.join(__dirname, "clientsData.json");

// 🔒 Placeholder auth. Today it's a pass-through. To turn it on later, set
// CLIENTS_CONFIG_API_KEY in the environment and callers must send
// x-api-key: <that value>. No other file needs to change.
function requireApiKey(req, res, next) {
  const expected = process.env.CLIENTS_CONFIG_API_KEY;
  if (!expected) return next(); // no key configured → open, as today

  const provided = req.get("x-api-key");
  if (provided !== expected) {
    return res.status(401).json({ error: "Invalid or missing x-api-key header" });
  }
  return next();
}

router.get("/", requireApiKey, async (req, res) => {
  try {
    const raw = await fs.promises.readFile(DATA_PATH, "utf-8");
    const data = JSON.parse(raw); // parse so malformed JSON is a 500, not a broken body
    return res.status(200).json(data);
  } catch (e) {
    console.error("❌ /clients-config read error:", e.message);
    return res.status(500).json({
      error: "Could not read clientsData.json",
      detail: e.message,
    });
  }
});

module.exports = router;
