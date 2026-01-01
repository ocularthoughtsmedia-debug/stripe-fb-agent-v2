// generateClientsJs.js
// Converts clientsData.json -> clients.js (the runtime registry)
// Usage: node generateClientsJs.js

const fs = require("fs");
const path = require("path");

const dataPath = path.join(__dirname, "clientsData.json");
const outPath = path.join(__dirname, "clients.js");

function main() {
  if (!fs.existsSync(dataPath)) {
    console.error("❌ clientsData.json not found. Create it in the project root.");
    process.exit(1);
  }

  const raw = fs.readFileSync(dataPath, "utf8");
  const data = JSON.parse(raw);

  // Safety check: keys should look like cus_...
  for (const key of Object.keys(data)) {
    if (!key.startsWith("cus_")) {
      console.warn(`⚠️ Key "${key}" does not start with cus_. Stripe customer IDs usually do.`);
    }
  }

  const header = `// clients.js
// AUTO-GENERATED FILE — DO NOT EDIT MANUALLY
// Edit clientsData.json and run: node generateClientsJs.js

module.exports = `;

  const body = JSON.stringify(data, null, 2) + ";\n";

  fs.writeFileSync(outPath, header + body, "utf8");

  console.log("✅ clients.js generated successfully from clientsData.json");
}

main();
