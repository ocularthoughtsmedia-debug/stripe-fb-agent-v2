// scripts/report-config-audit.js
// Offline, read-only review of clientsData.json for the 30-day report.
// Makes NO network calls and writes nothing.
//
//   node scripts/report-config-audit.js
//
// Flags clients the runner would hold (no phone, no/invalid campaign IDs),
// shows the name each report would print, and points out cadence settings
// worth a human look. It never changes cadence: that is a billing fact only
// you know.

const path = require("path");
const ROOT = path.join(__dirname, "..");
const clients = require(path.join(ROOT, "clientsData.json"));
const { reportDisplayName, reportLabel, deriveBusinessName } = require(path.join(ROOT, "reportFormat"));
const { validCampaignIds } = require(path.join(ROOT, "metaInsights"));

const PHONE_RE = /^\+[1-9]\d{7,14}$/;

const rows = [];
for (const [id, c] of Object.entries(clients)) {
  const issues = [];
  if (!PHONE_RE.test(String(c.phone || ""))) issues.push("NO VALID PHONE - report held");
  if (!validCampaignIds(c.analytics?.campaignIds)) issues.push("NO VALID analytics.campaignIds - report held");
  if (c.reportsEnabled === false) issues.push("reportsEnabled=false");

  const name = reportDisplayName(c);
  if (!c.reportName) {
    // A personal-name-shaped result ("Kenneth Brown") means the registry name
    // is "Business - Owner" rather than "Owner - Business".
    const PERSON = /^[A-Z][a-z]+( [A-Z]\.?)? [A-Z][a-z]+$/;
    const before = String(c.name).split(" - ")[0].trim();
    if (/ - /.test(c.name) && PERSON.test(name) && !PERSON.test(before)) {
      issues.push(`derived name "${name}" looks like a PERSON - set reportName`);
    }
  }
  if (!c.reportLabel && /mortuary|funeral|hair|salon|restoration|electric|clinic/i.test(name)) {
    issues.push(`not a restaurant? report says "Restaurant:" - consider reportLabel`);
  }

  const cadence = c.billing?.cadence || "(none → weekly)";
  const extend = [...new Set((c.campaigns || []).map((k) => k.extendDays).filter((x) => x !== undefined))];
  if (!c.billing?.cadence) issues.push("billing.cadence missing (treated as weekly: 14-day grace)");
  if (c.billing?.cadence === "weekly" && c.billing?.paymentsPerCycle === 1) {
    issues.push("cadence weekly but paymentsPerCycle 1 - review");
  }
  if (c.billing?.cadence === "monthly" && extend.some((d) => d < 28)) {
    issues.push(`cadence monthly but extendDays ${extend.join("/")} - review`);
  }

  rows.push({ id, registry: c.name, name, label: reportLabel(c), cadence, delay: c.billing?.reportDelayDays, extend, issues });
}

console.log(`\n30-day report configuration audit — ${rows.length} clients\n`);
for (const r of rows) {
  const mark = r.issues.some((i) => /held/.test(i)) ? "⛔" : r.issues.length ? "⚠️ " : "✅";
  console.log(`${mark} ${r.id}  ${r.registry}`);
  console.log(`     report shows: "${r.label}: ${r.name}"   cadence=${r.cadence}  delay=${r.delay}d  extendDays=${r.extend.join("/") || "-"}`);
  for (const i of r.issues) console.log(`     - ${i}`);
}

const held = rows.filter((r) => r.issues.some((i) => /held/.test(i)));
console.log(`\n${held.length} client(s) would be HELD (no report): ${held.map((r) => deriveBusinessName(r.registry)).join(", ") || "none"}`);
console.log(
  "\nCadence note: the grace check uses billing.cadence (weekly = 14 days, monthly = 45 days since the last\n" +
    "payment). Clients moved to a once-every-30-days payment but still marked weekly get the 14-day grace;\n" +
    "a monthly payment that is a few days late will hold their report. Confirm each and edit by hand.\n"
);
