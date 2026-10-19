// reportFormat.js
// Builds the client-facing 30-day report SMS. Pure functions, no I/O.

const { DateTime } = require("luxon");

// ─────────────────────────────────────────────────────────────
// Display name
// ─────────────────────────────────────────────────────────────
// Registry names are mostly "Owner Name - Business (City, ST)", but not all:
// some are just the business, and at least one is "Business - Owner Name".
// So a heuristic is a fallback only; clientsData.json `reportName` (and
// `reportLabel`, for clients that are not restaurants) always win.
// scripts/report-config-audit.js prints every derived name for review.
function deriveBusinessName(registryName) {
  let s = String(registryName || "").trim();
  s = s.replace(/\s*\([^)]*,\s*[A-Z]{2}\)\s*$/, ""); // trailing "(City, ST)"
  const dash = s.indexOf(" - ");
  if (dash !== -1) s = s.slice(dash + 3);
  return s.trim();
}

function reportDisplayName(client) {
  return String(client?.reportName || "").trim() || deriveBusinessName(client?.name);
}

function reportLabel(client) {
  return String(client?.reportLabel || "").trim() || "Restaurant";
}

// ─────────────────────────────────────────────────────────────
// SMS encoding
// ─────────────────────────────────────────────────────────────
// One character outside GSM-7 (a curly apostrophe in "Big Zaddy’s", an en
// dash, an emoji) switches the WHOLE message to UCS-2: 70 characters per
// segment instead of 160, which roughly doubles the segment count. Normalise
// the common typographic characters to their GSM-7 equivalents.
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENDED = "^{}\\[~]|€";

function toGsm7Friendly(text) {
  return String(text)
    .replace(/[‘’‚′´`]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ");
}

function isGsm7(text) {
  for (const ch of text) {
    if (!GSM7_BASIC.includes(ch) && !GSM7_EXTENDED.includes(ch)) return false;
  }
  return true;
}

function smsSegments(text) {
  if (isGsm7(text)) {
    let units = 0;
    for (const ch of text) units += GSM7_EXTENDED.includes(ch) ? 2 : 1;
    return { encoding: "GSM-7", units, segments: units <= 160 ? 1 : Math.ceil(units / 153) };
  }
  // UCS-2 counts UTF-16 code units; an emoji is two.
  const units = text.length;
  return { encoding: "UCS-2", units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

// ─────────────────────────────────────────────────────────────
// Estimated potential customer visits (modelled, NOT measured)
// ─────────────────────────────────────────────────────────────
// Applied to deduplicated REACH only — never impressions or ThruPlays, which
// count the same person more than once. ON by default (the approved setup);
// REPORT_VISIT_ESTIMATE_ENABLED=false turns it off.
function parseVisitEstimateConfig(env = process.env) {
  const raw = env.REPORT_VISIT_ESTIMATE_ENABLED;
  const enabled = raw === undefined || raw === "" ? true : !/^(0|false|no|off)$/i.test(String(raw));
  const low = Number(env.REPORT_VISIT_RATE_LOW ?? 0.005);
  const high = Number(env.REPORT_VISIT_RATE_HIGH ?? 0.008);
  const valid = Number.isFinite(low) && Number.isFinite(high) && low > 0 && high >= low && high <= 0.05;
  return { enabled, low, high, valid };
}

/**
 * Returns { lower, upper, rateLow, rateHigh } or { omitted: reason }.
 * Only computed when reach is trustworthy as a count of distinct people:
 * deduplicated by Meta in a single query, positive, and not larger than
 * impressions (which would mean the row is not what we think it is).
 */
function estimateVisits({ reach, impressions, reachIsDeduplicated }, cfg) {
  if (!cfg?.enabled) return { omitted: "disabled" };
  if (!cfg.valid) return { omitted: `invalid rate configuration (low=${cfg.low}, high=${cfg.high})` };
  if (reachIsDeduplicated !== true) return { omitted: "reach is not deduplicated across campaigns" };
  if (!Number.isFinite(reach) || reach <= 0) return { omitted: "no reach" };
  if (Number.isFinite(impressions) && reach > impressions) {
    return { omitted: `reach (${reach}) exceeds impressions (${impressions}) — not reliable` };
  }
  return {
    lower: Math.round(reach * cfg.low),
    upper: Math.round(reach * cfg.high),
    rateLow: cfg.low,
    rateHigh: cfg.high,
  };
}

function formatRatePercent(rate) {
  // 0.005 → "0.5%", 0.0075 → "0.75%"; no float noise like 0.7999999.
  return `${Number((rate * 100).toFixed(3))}%`;
}

// ─────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────
const nf = new Intl.NumberFormat("en-US");

function fmtInt(n) {
  return nf.format(Math.round(Number(n) || 0));
}

function fmtPeriod(startISO, endISO) {
  const s = DateTime.fromISO(startISO);
  const e = DateTime.fromISO(endISO);
  if (s.year === e.year) return `${s.toFormat("LLL d")} - ${e.toFormat("LLL d, yyyy")}`;
  return `${s.toFormat("LLL d, yyyy")} - ${e.toFormat("LLL d, yyyy")}`;
}

// Twilio rejects bodies over 1600 characters (10 segments); we stay far
// below that. A message over budget is NEVER cut: optional lines are dropped
// (and logged), and if that is still not enough the report is not sent.
const DEFAULT_MAX_SEGMENTS = 4;

// Required lines are never removed. Optional lines go first-listed-first
// when the message is over budget.
const OPTIONAL_DROP_ORDER = ["thanks", "thruplayNote"];

/**
 * Build the SMS. `metrics` comes from metaInsights.parseInsightsRow.
 * Returns { body, segments, visitEstimate, warnings, overBudget, dropped }.
 * overBudget=true means even the required lines exceed maxSegments: the
 * caller must not send it.
 */
function buildReportSms({
  client,
  periodStart,
  periodEnd,
  periodDays = 30,
  metrics,
  reachIsDeduplicated,
  visitConfig,
  maxSegments = DEFAULT_MAX_SEGMENTS,
}) {
  const warnings = [];
  const name = reportDisplayName(client);
  const label = reportLabel(client);

  const visitEstimate = estimateVisits(
    { reach: metrics.reach, impressions: metrics.impressions, reachIsDeduplicated },
    visitConfig
  );
  if (visitEstimate.omitted && visitEstimate.omitted !== "disabled") {
    warnings.push(`visit estimate omitted: ${visitEstimate.omitted}`);
  }

  // [key, text]; key null = required.
  const parts = [
    [null, "OCULAR THOUGHTS MEDIA"],
    [null, `${periodDays}-Day Advertising Report`],
    [null, `${label}: ${name}`],
    [null, `Period: ${fmtPeriod(periodStart, periodEnd)}`],
    [null, ""],
    [null, `THRUPLAYS: ${fmtInt(metrics.thruplays)}`],
    // What a ThruPlay is, so it is not read as "people" or "full views".
    ["thruplayNote", "(video plays to the end or 15+ sec)"],
    [null, ""],
    [null, `Reach: ${fmtInt(metrics.reach)}`],
    [null, `Impressions: ${fmtInt(metrics.impressions)}`],
    [null, `Frequency: ${(Number(metrics.frequency) || 0).toFixed(2)}`],
    [null, `Video Views: ${fmtInt(metrics.videoViews)}`],
    [null, `Unique Link Clicks: ${fmtInt(metrics.uniqueLinkClicks)}`],
  ];
  if (metrics.uniqueLinkCtr !== null && Number.isFinite(metrics.uniqueLinkCtr)) {
    parts.push([null, `Unique Link CTR: ${metrics.uniqueLinkCtr.toFixed(2)}%`]);
  }
  parts.push(
    [null, `Reactions: ${fmtInt(metrics.reactions)}`],
    [null, `Comments: ${fmtInt(metrics.comments)}`],
    [null, `Shares: ${fmtInt(metrics.shares)}`]
  );
  if (!visitEstimate.omitted) {
    parts.push(
      [null, ""],
      [null, `Estimated Potential Customer Visits: ${fmtInt(visitEstimate.lower)}-${fmtInt(visitEstimate.upper)}`],
      [
        null,
        `Hypothetical: assumes ${formatRatePercent(visitEstimate.rateLow)}-${formatRatePercent(visitEstimate.rateHigh)} ` +
          `of people reached visit. Not confirmed customers or measured conversions.`,
      ]
    );
  }
  parts.push([null, ""], ["thanks", "Thank you for partnering with us!"], [null, "Reply STOP to opt out, HELP for help."]);

  const render = (drop) => toGsm7Friendly(parts.filter(([k]) => !drop.has(k)).map(([, t]) => t).join("\n"));

  const dropped = new Set();
  let body = render(dropped);
  let segments = smsSegments(body);
  for (const key of OPTIONAL_DROP_ORDER) {
    if (segments.segments <= maxSegments) break;
    dropped.add(key);
    body = render(dropped);
    segments = smsSegments(body);
    warnings.push(`dropped optional line "${key}" to stay within ${maxSegments} segments`);
  }
  const overBudget = segments.segments > maxSegments;
  if (overBudget) warnings.push(`message is ${segments.segments} segments even without optional lines (limit ${maxSegments})`);
  if (segments.encoding !== "GSM-7") warnings.push("message is UCS-2 encoded (non-GSM character present)");

  return { body, segments, visitEstimate, warnings, overBudget, dropped: [...dropped] };
}

// ─────────────────────────────────────────────────────────────
// Content guard — last check before anything is sent
// ─────────────────────────────────────────────────────────────
// Belt and braces: the Meta request has no financial fields, so none of this
// should ever match. If it does, something upstream changed, and the report is
// parked for review instead of sent.
const FORBIDDEN_PATTERNS = [
  [/\$/, "currency symbol"],
  [/\b(spend|spent|budget|cost|costs|cpm|cpc|cpv|cpa|roas|roi|revenue|profit|price|bid)\b/i, "financial term"],
  [/\bcost per\b/i, "cost metric"],
  [/\b(three|3)[\s-]*sec(ond)?s?\b/i, "three-second wording"],
  [/\b(objective|optimi[sz]ed?|optimi[sz]ation|ad ?set|campaign id)\b/i, "internal campaign structure"],
];

function findForbiddenContent(body, { displayName } = {}) {
  // The restaurant name is client-supplied text; only the report's own words
  // are checked, so "Budget Burgers" cannot block its own report.
  let text = String(body);
  const name = displayName && toGsm7Friendly(displayName);
  if (name) text = text.split(name).join("");
  return FORBIDDEN_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

module.exports = {
  deriveBusinessName,
  reportDisplayName,
  reportLabel,
  toGsm7Friendly,
  isGsm7,
  smsSegments,
  parseVisitEstimateConfig,
  estimateVisits,
  formatRatePercent,
  buildReportSms,
  DEFAULT_MAX_SEGMENTS,
  findForbiddenContent,
};
