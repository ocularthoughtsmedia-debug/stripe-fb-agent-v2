// tests/report-format.test.js
// Pure tests for the report SMS, Meta parsing and the visit estimate.
// No database, no network.  Run: node tests/report-format.test.js

const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const f = require(path.join(ROOT, "reportFormat"));
const meta = require(path.join(ROOT, "metaInsights"));
const { classifyTwilioError } = require(path.join(ROOT, "reportRunner"));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`   ✅ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`   ❌ ${name}\n      ${e.message}`);
  }
}

// A realistic Meta row: ThruPlays, impressions, reach, link clicks and the
// three engagement actions all DIFFERENT, so a test can tell which one a
// calculation actually used.
const ROW = {
  reach: "12345",
  impressions: "40321",
  frequency: "3.266208",
  unique_inline_link_clicks: "187",
  actions: [
    { action_type: "video_view", value: "9876" },
    { action_type: "post_reaction", value: "210" },
    { action_type: "comment", value: "34" },
    { action_type: "post", value: "19" },
    { action_type: "post_engagement", value: "10500" },
    { action_type: "link_click", value: "240" },
  ],
  video_thruplay_watched_actions: [{ action_type: "video_view", value: "5432" }],
  date_start: "2026-09-01",
  date_stop: "2026-09-30",
};

const CLIENT = {
  name: "Gary Yancy - Yancy's Wingz & Thingz",
  phone: "+15555550100",
  timezone: "America/New_York",
};

const VISITS_ON = { enabled: true, low: 0.005, high: 0.008, valid: true };
const VISITS_OFF = { enabled: false, low: 0.005, high: 0.008, valid: true };

function build(over = {}) {
  return f.buildReportSms({
    client: CLIENT,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    metrics: meta.parseInsightsRow(ROW),
    reachIsDeduplicated: true,
    visitConfig: VISITS_OFF,
    ...over,
  });
}

console.log("\n▸ Meta request and parsing");

test("requested fields contain no financial or objective fields", () => {
  const banned = /spend|cost|cpm|cpc|cpp|ctr_cost|budget|bid|roas|purchase_roas|value|objective|optimization|revenue/i;
  for (const field of meta.INSIGHTS_FIELDS) assert.ok(!banned.test(field), `financial field requested: ${field}`);
});

test("parses ThruPlays from video_thruplay_watched_actions, video views from actions.video_view", () => {
  const m = meta.parseInsightsRow(ROW);
  assert.strictEqual(m.thruplays, 5432);
  assert.strictEqual(m.videoViews, 9876);
  assert.strictEqual(m.reactions, 210);
  assert.strictEqual(m.comments, 34);
  assert.strictEqual(m.shares, 19);
  assert.strictEqual(m.reach, 12345);
  assert.strictEqual(m.impressions, 40321);
  assert.strictEqual(m.uniqueLinkClicks, 187);
  assert.ok(Math.abs(m.uniqueLinkCtr - (187 / 12345) * 100) < 1e-9);
  assert.strictEqual(m.hasDelivery, true);
});

test("empty insights (no delivery) parse to zeros with hasDelivery=false", () => {
  const m = meta.parseInsightsRow(null);
  assert.strictEqual(m.hasDelivery, false);
  assert.strictEqual(m.thruplays, 0);
  assert.strictEqual(m.uniqueLinkCtr, null);
});

test("missing action types count as 0, not as an error", () => {
  const m = meta.parseInsightsRow({ reach: "10", impressions: "20", actions: [] });
  assert.strictEqual(m.shares, 0);
  assert.strictEqual(m.thruplays, 0);
});

test("garbage numbers are rejected rather than reported", () => {
  assert.throws(() => meta.parseInsightsRow({ reach: "abc", impressions: "1" }), /Unparseable reach/);
  assert.throws(() => meta.parseInsightsRow({ reach: "1", impressions: "1", actions: "x" }), /Unexpected actions shape/);
});

test("campaign ID validation", () => {
  assert.ok(meta.validCampaignIds(["120249931469490513"]));
  assert.ok(!meta.validCampaignIds([]));
  assert.ok(!meta.validCampaignIds(undefined));
  assert.ok(!meta.validCampaignIds(["act_123"]));
  assert.ok(!meta.validCampaignIds(["120249931469490513", ""]));
});

console.log("\n▸ SMS content");

test("ThruPlays is the headline metric, before every other number", () => {
  const { body } = build();
  const thru = body.indexOf("THRUPLAYS: 5,432");
  assert.ok(thru > 0, body);
  for (const label of ["Reach:", "Impressions:", "Video Views:", "Unique Link Clicks:", "Reactions:"]) {
    assert.ok(body.indexOf(label) > thru, `${label} should come after ThruPlays`);
  }
});

test("all required metrics present with real values and thousands separators", () => {
  const { body } = build();
  for (const line of [
    "Restaurant: Yancy's Wingz & Thingz",
    "Period: Sep 1 - Sep 30, 2026",
    "Reach: 12,345",
    "Impressions: 40,321",
    "Frequency: 3.27",
    "Video Views: 9,876",
    "Unique Link Clicks: 187",
    "Unique Link CTR: 1.51%",
    "Reactions: 210",
    "Comments: 34",
    "Shares: 19",
    "Reply STOP to opt out, HELP for help.",
  ]) {
    assert.ok(body.includes(line), `missing "${line}" in:\n${body}`);
  }
});

test("never says three-second / 3-second", () => {
  const { body } = build();
  assert.ok(!/three|3[\s-]*sec/i.test(body));
});

test("never describes ThruPlays as unique people or full completions", () => {
  const { body } = build();
  assert.ok(!/unique (people|viewers)|watched (the )?(entire|whole|full)|completed/i.test(body));
});

test("no financial content, and the content guard passes it", () => {
  const { body } = build({ visitConfig: VISITS_ON });
  assert.deepStrictEqual(f.findForbiddenContent(body, { displayName: "Yancy's Wingz & Thingz" }), []);
});

test("content guard catches financial terms and three-second wording", () => {
  assert.ok(f.findForbiddenContent("Amount spent: $40").length > 0);
  assert.ok(f.findForbiddenContent("Cost per ThruPlay 0.02").length > 0);
  assert.ok(f.findForbiddenContent("CPM 4.10").length > 0);
  assert.ok(f.findForbiddenContent("3-second video views: 10").length > 0);
  assert.ok(f.findForbiddenContent("Objective: ThruPlay").length > 0);
});

test("content guard ignores the client's own name", () => {
  const body = "Restaurant: Budget Bites\nTHRUPLAYS: 5";
  assert.deepStrictEqual(f.findForbiddenContent(body, { displayName: "Budget Bites" }), []);
});

test("CTR line omitted when reach is 0 (no divide-by-zero)", () => {
  const { body } = build({ metrics: meta.parseInsightsRow({ reach: "0", impressions: "5" }) });
  assert.ok(!body.includes("Unique Link CTR"));
});

test("period spanning a year boundary shows both years", () => {
  const { body } = build({ periodStart: "2026-12-15", periodEnd: "2027-01-13" });
  assert.ok(body.includes("Period: Dec 15, 2026 - Jan 13, 2027"));
});

console.log("\n▸ Names");

test("derives the business from 'Owner - Business (City, ST)'", () => {
  assert.strictEqual(f.deriveBusinessName("Don Que - Don Que's Southern BBQ (Brunswick, GA)"), "Don Que's Southern BBQ");
  assert.strictEqual(f.deriveBusinessName("Boscoe's Babys"), "Boscoe's Babys");
});

test("reportName and reportLabel override the heuristic", () => {
  const c = { name: "Sisters of the New South - Kenneth Brown", reportName: "Sisters of the New South" };
  assert.strictEqual(f.reportDisplayName(c), "Sisters of the New South");
  const { body } = build({ client: { ...CLIENT, reportName: "Carolina Hair Restoration Center", reportLabel: "Business" } });
  assert.ok(body.includes("Business: Carolina Hair Restoration Center"));
});

console.log("\n▸ Encoding / segments");

test("curly apostrophes and dashes are normalised to GSM-7", () => {
  const { body, segments } = build({ client: { ...CLIENT, name: "Big Zaddy’s Burgers" } });
  assert.ok(body.includes("Restaurant: Big Zaddy's Burgers"));
  assert.strictEqual(segments.encoding, "GSM-7");
});

test("segment arithmetic", () => {
  assert.deepStrictEqual(f.smsSegments("a".repeat(160)), { encoding: "GSM-7", units: 160, segments: 1 });
  assert.strictEqual(f.smsSegments("a".repeat(161)).segments, 2);
  assert.strictEqual(f.smsSegments("a".repeat(306)).segments, 2);
  assert.strictEqual(f.smsSegments("a".repeat(307)).segments, 3);
  assert.strictEqual(f.smsSegments("€".repeat(80)).units, 160); // extended chars cost 2
  assert.strictEqual(f.smsSegments("📊 hi").encoding, "UCS-2");
});

test("full report (with estimate) fits 4 segments, nothing dropped", () => {
  const r = build({ visitConfig: VISITS_ON });
  assert.strictEqual(r.segments.encoding, "GSM-7");
  assert.ok(r.segments.segments <= 4, `report is ${r.segments.segments} segments`);
  assert.deepStrictEqual(r.dropped, []);
  assert.strictEqual(r.overBudget, false);
});

test("worst case (longest name, 7-digit numbers, year-spanning period) still fits 4 segments", () => {
  const big = {
    reach: "1234567", impressions: "9876543", frequency: "8.0", unique_inline_link_clicks: "123456",
    actions: [
      { action_type: "video_view", value: "7654321" }, { action_type: "post_reaction", value: "123456" },
      { action_type: "comment", value: "12345" }, { action_type: "post", value: "12345" },
    ],
    video_thruplay_watched_actions: [{ action_type: "video_view", value: "2345678" }],
  };
  const r = build({
    client: { name: "Lateasha R Dowdy - NuVibez Restaurant Bar & Lounge" },
    periodStart: "2026-12-15", periodEnd: "2027-01-13",
    metrics: meta.parseInsightsRow(big), visitConfig: VISITS_ON,
  });
  assert.ok(r.segments.segments <= 4, `${r.segments.segments} segments`);
  assert.strictEqual(r.overBudget, false);
});

const REQUIRED_LINES = [
  "OCULAR THOUGHTS MEDIA", "30-Day Advertising Report", "Restaurant: ", "Period: ", "THRUPLAYS: ",
  "Reach: ", "Impressions: ", "Frequency: ", "Video Views: ", "Unique Link Clicks: ", "Unique Link CTR: ",
  "Reactions: ", "Comments: ", "Shares: ", "Estimated Potential Customer Visits: ",
  "Hypothetical: assumes 0.5%-0.8% of people reached visit. Not confirmed customers or measured conversions.",
];

test("NEVER truncated: STOP/HELP is always the complete final line", () => {
  for (const maxSegments of [1, 2, 3, 4, 10]) {
    const { body } = build({ visitConfig: VISITS_ON, maxSegments });
    assert.ok(body.endsWith("\nReply STOP to opt out, HELP for help."), `maxSegments=${maxSegments}`);
  }
});

test("over budget: only optional lines are dropped (logged), every required line kept", () => {
  // 4 segments is the real budget; force pressure with 3.
  const r = build({ visitConfig: VISITS_ON, maxSegments: 3 });
  assert.deepStrictEqual(r.dropped, ["thanks", "thruplayNote"]);
  assert.ok(r.warnings.some((w) => /dropped optional line "thanks"/.test(w)));
  for (const line of REQUIRED_LINES) assert.ok(r.body.includes(line), `missing "${line}"`);
});

test("still over budget after dropping optional lines → overBudget=true, body intact (caller must not send)", () => {
  const r = build({ visitConfig: VISITS_ON, maxSegments: 2 });
  assert.strictEqual(r.overBudget, true);
  for (const line of REQUIRED_LINES) assert.ok(r.body.includes(line), `missing "${line}"`);
  assert.ok(r.body.endsWith("Reply STOP to opt out, HELP for help."));
});

test("every metric appears exactly once (no duplicated lines)", () => {
  for (const visitConfig of [VISITS_ON, VISITS_OFF]) {
    for (const maxSegments of [3, 4]) {
      const { body } = build({ visitConfig, maxSegments });
      const lines = body.split("\n").filter(Boolean);
      assert.strictEqual(new Set(lines).size, lines.length, `duplicate line in:\n${body}`);
      for (const label of [
        "THRUPLAYS:", "Reach:", "Impressions:", "Frequency:", "Video Views:", "Unique Link Clicks:",
        "Unique Link CTR:", "Reactions:", "Comments:", "Shares:", "Restaurant:", "Period:",
      ]) {
        const n = lines.filter((l) => l.startsWith(label)).length;
        assert.strictEqual(n, 1, `${label} appears ${n} times`);
      }
      assert.strictEqual(lines.filter((l) => l.startsWith("Estimated Potential")).length, visitConfig.enabled ? 1 : 0);
      assert.strictEqual(lines.filter((l) => l.startsWith("Reply STOP")).length, 1);
    }
  }
});

test("ThruPlay note explains plays, not people", () => {
  const { body } = build();
  assert.ok(body.includes("THRUPLAYS: 5,432\n(video plays to the end or 15+ sec)"));
});

console.log("\n▸ Estimated potential customer visits");

test("calculated from REACH x 0.5% and x 0.8%, rounded", () => {
  const e = f.estimateVisits({ reach: 12345, reachIsDeduplicated: true }, VISITS_ON);
  assert.strictEqual(e.lower, 62); // 61.725
  assert.strictEqual(e.upper, 99); // 98.76
  const e2 = f.estimateVisits({ reach: 10000, reachIsDeduplicated: true }, VISITS_ON);
  assert.deepStrictEqual([e2.lower, e2.upper], [50, 80]);
});

test("never computed from impressions or ThruPlays", () => {
  // ROW has impressions 40,321 and ThruPlays 5,432; only reach 12,345 gives 62-99.
  const { body, visitEstimate } = build({ visitConfig: VISITS_ON });
  assert.strictEqual(visitEstimate.lower, 62);
  assert.strictEqual(visitEstimate.upper, 99);
  assert.ok(body.includes("Estimated Potential Customer Visits: 62-99\n"));
  assert.notStrictEqual(visitEstimate.lower, Math.round(40321 * 0.005)); // 202
  assert.notStrictEqual(visitEstimate.lower, Math.round(5432 * 0.005)); // 27
});

test("wording marks it as hypothetical, not confirmed customers or measured conversions", () => {
  const { body } = build({ visitConfig: VISITS_ON });
  assert.ok(
    body.includes(
      "Estimated Potential Customer Visits: 62-99\n" +
        "Hypothetical: assumes 0.5%-0.8% of people reached visit. Not confirmed customers or measured conversions."
    ),
    body
  );
  // "confirmed"/"measured" may appear ONLY inside the negating disclaimer.
  const outsideDisclaimer = body.replace("Not confirmed customers or measured conversions.", "");
  assert.ok(!/\b(confirmed|measured|verified|actual|customers gained|new customers|sales|conversions|roi|return on|revenue)\b/i.test(outsideDisclaimer));
});

test("estimate is not the headline and comes after the measured metrics", () => {
  const { body } = build({ visitConfig: VISITS_ON });
  assert.ok(body.indexOf("Estimated Potential") > body.indexOf("Shares:"));
  assert.ok(body.indexOf("THRUPLAYS") < body.indexOf("Estimated Potential"));
});

test("enabled by default (approved setup); REPORT_VISIT_ESTIMATE_ENABLED=false disables", () => {
  assert.strictEqual(f.parseVisitEstimateConfig({}).enabled, true);
  assert.ok(build({ visitConfig: f.parseVisitEstimateConfig({}) }).body.includes("Estimated Potential"));
  for (const v of ["false", "0", "off", "no"]) {
    const cfg = f.parseVisitEstimateConfig({ REPORT_VISIT_ESTIMATE_ENABLED: v });
    assert.strictEqual(cfg.enabled, false, v);
    assert.ok(!build({ visitConfig: cfg }).body.includes("Estimated"), v);
  }
});

test("omitted (with a warning) when reach exceeds impressions — reach not reliable", () => {
  const r = build({ visitConfig: VISITS_ON, metrics: meta.parseInsightsRow({ reach: "500", impressions: "400" }) });
  assert.ok(!r.body.includes("Estimated"));
  assert.ok(r.warnings.some((w) => /not reliable/.test(w)));
});

test("omitted unless reachIsDeduplicated is explicitly true", () => {
  for (const d of [undefined, null, "yes", 1]) {
    assert.ok(!build({ visitConfig: VISITS_ON, reachIsDeduplicated: d }).body.includes("Estimated"), String(d));
  }
});

test("rates are configurable", () => {
  const cfg = f.parseVisitEstimateConfig({
    REPORT_VISIT_ESTIMATE_ENABLED: "true",
    REPORT_VISIT_RATE_LOW: "0.004",
    REPORT_VISIT_RATE_HIGH: "0.0075",
  });
  const { body } = build({ visitConfig: cfg });
  assert.ok(body.includes("Estimated Potential Customer Visits: 49-93\nHypothetical: assumes 0.4%-0.75% of people reached visit."), body);
});

test("invalid rate configuration omits the estimate (and warns) instead of sending nonsense", () => {
  for (const env of [
    { REPORT_VISIT_RATE_LOW: "0.009", REPORT_VISIT_RATE_HIGH: "0.008" }, // low > high
    { REPORT_VISIT_RATE_LOW: "-1", REPORT_VISIT_RATE_HIGH: "0.008" },
    { REPORT_VISIT_RATE_LOW: "0.005", REPORT_VISIT_RATE_HIGH: "0.5" }, // 50%: implausible
    { REPORT_VISIT_RATE_LOW: "abc", REPORT_VISIT_RATE_HIGH: "0.008" },
  ]) {
    const cfg = f.parseVisitEstimateConfig({ REPORT_VISIT_ESTIMATE_ENABLED: "1", ...env });
    const r = build({ visitConfig: cfg });
    assert.ok(!r.body.includes("Estimated"), JSON.stringify(env));
    assert.ok(r.warnings.some((w) => /invalid rate/.test(w)), JSON.stringify(env));
  }
});

test("omitted (with a warning) when reach is not deduplicated across campaigns", () => {
  const r = build({ visitConfig: VISITS_ON, reachIsDeduplicated: false });
  assert.ok(!r.body.includes("Estimated"));
  assert.ok(r.warnings.some((w) => /not deduplicated/.test(w)));
});

test("omitted when reach is 0", () => {
  const r = build({ visitConfig: VISITS_ON, metrics: meta.parseInsightsRow({ reach: "0", impressions: "3" }) });
  assert.ok(!r.body.includes("Estimated"));
});

console.log("\n▸ Twilio error classification");

test("4xx = definitively rejected; 429 = retry; 5xx / no status = uncertain", () => {
  assert.strictEqual(classifyTwilioError({ status: 400, code: 21211, message: "invalid To" }).kind, "rejected");
  const optOut = classifyTwilioError({ status: 400, code: 21610, message: "unsubscribed" });
  assert.strictEqual(optOut.kind, "rejected");
  assert.strictEqual(optOut.optedOut, true);
  assert.strictEqual(classifyTwilioError({ status: 429, code: 20429 }).kind, "retry");
  assert.strictEqual(classifyTwilioError({ status: 503 }).kind, "uncertain");
  assert.strictEqual(classifyTwilioError(new Error("socket hang up")).kind, "uncertain");
});

console.log(`\n${failures.length ? "❌" : "✅"} report-format: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
