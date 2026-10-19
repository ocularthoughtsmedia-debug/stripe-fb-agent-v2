// scripts/send-test-report.js
// Build one client's 30-day report and show it — or send it to ADMIN_PHONE
// ONLY. It can never text a client.
//
//   node scripts/send-test-report.js --customer cus_XXX            preview, real Meta data
//   node scripts/send-test-report.js --customer cus_XXX --mock     preview, mock data, no network
//   node scripts/send-test-report.js --customer cus_XXX --send     text the preview to ADMIN_PHONE
//   options: --since YYYY-MM-DD --until YYYY-MM-DD   (default: last 30 complete days)
//            --with-estimate                         include the visit estimate
//
// Never touches the database (no cycle is created, claimed or marked sent),
// never touches Facebook budgets or end dates, never uses a client's phone.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const { DateTime } = require("luxon");
const ROOT = path.join(__dirname, "..");
const clients = require(path.join(ROOT, "clients"));
const { fetchReportMetrics, parseInsightsRow } = require(path.join(ROOT, "metaInsights"));
const { buildReportSms, findForbiddenContent, parseVisitEstimateConfig, reportDisplayName } = require(path.join(ROOT, "reportFormat"));

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const customerId = opt("customer");
const client = clients[customerId];
if (!client) {
  console.error(`Unknown --customer ${customerId}. Use a cus_... id from clientsData.json.`);
  process.exit(2);
}

const admin = String(process.env.ADMIN_PHONE || "").trim();
const send = has("send");
if (send) {
  if (!/^\+[1-9]\d{7,14}$/.test(admin)) {
    console.error("ADMIN_PHONE is missing or not E.164 (+1...). Refusing to send.");
    process.exit(2);
  }
  const clash = Object.values(clients).find((c) => String(c.phone || "").trim() === admin);
  if (clash) {
    console.error(`ADMIN_PHONE matches a CLIENT's phone (${clash.name}). Refusing to send.`);
    process.exit(2);
  }
  if (!process.env.TWILIO_MESSAGING_SERVICE_SID) {
    console.error("TWILIO_MESSAGING_SERVICE_SID is not set — reports must go through the approved Messaging Service. Refusing to send.");
    process.exit(2);
  }
}

const tz = client.timezone || "America/New_York";
const until = opt("until") || DateTime.now().setZone(tz).minus({ days: 1 }).toISODate();
const since = opt("since") || DateTime.fromISO(until, { zone: tz }).minus({ days: 29 }).toISODate();

// Clearly fake numbers, all different so a mix-up is visible.
const MOCK_ROW = {
  reach: "12345",
  impressions: "40321",
  frequency: "3.27",
  unique_inline_link_clicks: "187",
  actions: [
    { action_type: "video_view", value: "9876" },
    { action_type: "post_reaction", value: "210" },
    { action_type: "comment", value: "34" },
    { action_type: "post", value: "19" },
  ],
  video_thruplay_watched_actions: [{ action_type: "video_view", value: "5432" }],
};

(async () => {
  let metrics;
  let reachIsDeduplicated = true;
  if (has("mock")) {
    metrics = parseInsightsRow(MOCK_ROW);
  } else {
    const r = await fetchReportMetrics({ campaignIds: client.analytics?.campaignIds, since, until });
    metrics = r.metrics;
    reachIsDeduplicated = r.reachIsDeduplicated;
  }

  const visitConfig = has("with-estimate")
    ? parseVisitEstimateConfig({ ...process.env, REPORT_VISIT_ESTIMATE_ENABLED: "true" })
    : parseVisitEstimateConfig();

  const sms = buildReportSms({ client, periodStart: since, periodEnd: until, metrics, reachIsDeduplicated, visitConfig });
  const forbidden = findForbiddenContent(sms.body, { displayName: reportDisplayName(client) });

  console.log(`${has("mock") ? "MOCK DATA" : "REAL META DATA"} — ${client.name} — ${since}..${until}`);
  console.log(`${sms.segments.segments} segment(s), ${sms.segments.encoding}, ${sms.segments.units} chars`);
  for (const w of sms.warnings) console.log(`⚠️  ${w}`);
  if (forbidden.length) console.log(`🛑 content guard: ${forbidden.join(", ")} — the runner would NOT send this`);
  if (!metrics.hasDelivery) console.log("🛑 zero impressions — the runner would NOT send this");
  console.log(`\n${sms.body}\n`);

  if (!send) {
    console.log("(preview only — add --send to text this to ADMIN_PHONE)");
    return;
  }
  if (forbidden.length) process.exit(1);

  const { sendSms } = require(path.join(ROOT, "twilioSms"));
  const body = `[ADMIN TEST - not sent to client]\n${sms.body}`;
  const msg = await sendSms(admin, body);
  console.log(`✅ Sent to ADMIN_PHONE only. Twilio SID ${msg.sid}, status ${msg.status}`);
})().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
