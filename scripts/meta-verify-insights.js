// scripts/meta-verify-insights.js
// ONE read-only GET to Meta Ads Insights, using exactly the request the report
// runner makes, to verify the fields and action types are real.
//
//   node scripts/meta-verify-insights.js [campaignId]
//   node scripts/meta-verify-insights.js [campaignId] --probe video_3_sec_watched_actions
//
// Token: META_INSIGHTS_ACCESS_TOKEN or FB_PAGE_ACCESS_TOKEN, from the
// environment or the gitignored .env. The token is never printed.
//
// Reads only. No budgets, end dates, Stripe, Twilio or database. Requests no
// spend or cost fields. --probe makes ONE extra request asking only for the
// named field(s), so an invalid probe field cannot mask the main result.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const axios = require("axios");
const { DateTime } = require("luxon");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const clients = require(path.join(ROOT, "clients"));
const { INSIGHTS_FIELDS, ACTION_TYPES, parseInsightsRow, DEFAULT_GRAPH_VERSION } = require(path.join(ROOT, "metaInsights"));
const { buildReportSms, parseVisitEstimateConfig } = require(path.join(ROOT, "reportFormat"));

const args = process.argv.slice(2);
const probeIdx = args.indexOf("--probe");
const probe = probeIdx >= 0 ? String(args[probeIdx + 1] || "") : "";
const positional = args.filter((a, i) => !a.startsWith("--") && !(probeIdx >= 0 && i === probeIdx + 1));

const token = process.env.META_INSIGHTS_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN;
const version = process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
if (!token) {
  console.error("Set FB_PAGE_ACCESS_TOKEN (or META_INSIGHTS_ACCESS_TOKEN) in .env first. Nothing was requested.");
  process.exit(2);
}

const entry = positional[0]
  ? Object.entries(clients).find(([, c]) => c.analytics?.campaignIds?.includes(positional[0]))
  : Object.entries(clients).find(([, c]) => c.phone && c.analytics?.campaignIds?.length === 1);
const campaignId = positional[0] || entry?.[1].analytics.campaignIds[0];
const client = entry?.[1] || { name: "(unregistered campaign)" };
if (!/^\d{6,25}$/.test(String(campaignId || ""))) {
  console.error(`Not a campaign id: ${campaignId}`);
  process.exit(2);
}

// The last 30 COMPLETE days (yesterday back), in the client's timezone.
const tz = client.timezone || "America/New_York";
const until = DateTime.now().setZone(tz).minus({ days: 1 }).toISODate();
const since = DateTime.fromISO(until, { zone: tz }).minus({ days: 29 }).toISODate();

function redactUrl(u) {
  return String(u).replace(/access_token=[^&]+/, "access_token=<redacted>");
}

async function request(fields) {
  const url = `https://graph.facebook.com/${version}/${campaignId}/insights`;
  const params = { level: "campaign", fields, time_range: JSON.stringify({ since, until }), access_token: token };
  try {
    const res = await axios.get(url, { params, timeout: 30000 });
    return { ok: true, status: res.status, servedVersion: res.headers["facebook-api-version"], data: res.data };
  } catch (e) {
    return {
      ok: false,
      status: e.response?.status,
      servedVersion: e.response?.headers?.["facebook-api-version"],
      error: e.response?.data?.error || { message: e.message },
    };
  }
}

(async () => {
  console.log(`Client:     ${client.name}`);
  console.log(`Campaign:   ${campaignId}`);
  console.log(`Range:      ${since} .. ${until} (complete days, ${tz})`);
  console.log(`Version:    requested ${version}`);
  console.log(`Fields:     ${INSIGHTS_FIELDS.join(",")}\n`);

  const r = await request(INSIGHTS_FIELDS.join(","));
  console.log(`HTTP ${r.status}, served by Graph API version: ${r.servedVersion || "(header absent)"}`);
  if (!r.ok) {
    console.log("❌ Meta rejected the request:", JSON.stringify(r.error, null, 2));
    process.exit(1);
  }

  const rows = r.data?.data || [];
  console.log(`Rows returned: ${rows.length}${rows.length === 0 ? " (no delivery in range)" : ""}`);
  const row = rows[0];
  if (row) {
    console.log("\nField presence:");
    for (const f of INSIGHTS_FIELDS) {
      const v = row[f];
      const shape = v === undefined ? "ABSENT" : Array.isArray(v) ? `array[${v.length}]` : JSON.stringify(v);
      console.log(`  ${f.padEnd(34)} ${shape}`);
    }
    console.log("\nactions[] action_types returned:");
    for (const a of row.actions || []) {
      const used = Object.entries(ACTION_TYPES).find(([, t]) => t === a.action_type);
      console.log(`  ${a.action_type.padEnd(40)} ${String(a.value).padStart(10)}${used ? `   ← report: ${used[0]}` : ""}`);
    }
    console.log("\nvideo_thruplay_watched_actions:", JSON.stringify(row.video_thruplay_watched_actions || null));
    for (const [k, t] of Object.entries(ACTION_TYPES)) {
      if (!(row.actions || []).some((a) => a.action_type === t)) console.log(`  ⚠️  no "${t}" action in this range (${k} will read 0)`);
    }
  }

  const metrics = parseInsightsRow(row || null);
  console.log("\nParsed report metrics:", JSON.stringify(metrics, null, 2));

  const sms = buildReportSms({
    client,
    periodStart: since,
    periodEnd: until,
    metrics,
    reachIsDeduplicated: true,
    visitConfig: { ...parseVisitEstimateConfig({ REPORT_VISIT_ESTIMATE_ENABLED: "true" }) },
  });
  console.log(`\nSMS preview (estimate shown for review; ${sms.segments.segments} segments ${sms.segments.encoding}):\n${sms.body}`);

  if (probe) {
    console.log(`\n── Probe: ${probe} (one extra request) ──`);
    const p = await request(probe);
    if (p.ok) console.log(`✅ accepted. Row: ${JSON.stringify(p.data?.data?.[0] || null)}`);
    else console.log(`❌ rejected: ${JSON.stringify(p.error)}`);
  }
})().catch((e) => {
  console.error("Unexpected:", redactUrl(e.message));
  process.exit(1);
});
