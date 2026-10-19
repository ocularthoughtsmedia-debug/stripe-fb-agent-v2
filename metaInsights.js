// metaInsights.js
// Read-only Meta Ads Insights for the 30-day client report.
//
// Separate from facebookApi.js on purpose: that file is the budget/end-date
// money path and is not touched by the report system. (Its old
// getCampaign30DayInsights is no longer called — it requested fields that are
// not Ads Insights fields, so every call failed.)
//
// ═══ NO FINANCIAL FIELDS ═══
// INSIGHTS_FIELDS below is the complete list of what is requested. It contains
// no spend, cost, CPM, CPC, budget, bid or objective field, so no financial
// number can reach a client report even by accident. tests/report-format.test.js
// fails if one is ever added.
//
// ═══ AGGREGATION ACROSS CAMPAIGNS ═══
// Reach, frequency and unique link clicks are counts of PEOPLE. Summing them
// per campaign double-counts anyone reached by two campaigns, and frequency
// (impressions / reach) inherits the error. So for more than one campaign we
// do not sum: we ask Meta for a single account-level row filtered to exactly
// those campaigns, and Meta deduplicates the people itself. Plain event counts
// (impressions, ThruPlays, video views, reactions, comments, shares) come back
// summed in that same row. If the campaigns span more than one ad account
// there is no single query that deduplicates them, and we refuse rather than
// report an inflated reach.

const axios = require("axios");

const DEFAULT_GRAPH_VERSION = "v25.0";

const INSIGHTS_FIELDS = [
  "reach",
  "impressions",
  "frequency",
  "unique_inline_link_clicks",
  "actions",
  "video_thruplay_watched_actions",
];

// action_type values inside `actions`. Meta counts a "video_view" action at
// three seconds of play (or near-completion for very short videos).
const ACTION_TYPES = {
  videoViews: "video_view",
  reactions: "post_reaction",
  comments: "comment",
  shares: "post",
};

const CAMPAIGN_ID_RE = /^\d{6,25}$/;

class MetaInsightsError extends Error {
  // retryable=false means a retry cannot fix it (bad config, aggregation that
  // would be inaccurate) and the cycle should go to a human.
  constructor(message, { retryable = true, metaCode = null } = {}) {
    super(message);
    this.name = "MetaInsightsError";
    this.retryable = retryable;
    this.metaCode = metaCode;
  }
}

function validCampaignIds(ids) {
  return Array.isArray(ids) && ids.length > 0 && ids.every((id) => CAMPAIGN_ID_RE.test(String(id)));
}

// Never include axios' config in a message or log: it carries the token.
function describeAxiosError(e) {
  const fb = e?.response?.data?.error;
  if (fb) {
    return {
      message: `Meta API error ${fb.code}${fb.error_subcode ? `/${fb.error_subcode}` : ""}: ${fb.message}`,
      metaCode: fb.code,
      status: e.response.status,
    };
  }
  return { message: `Meta request failed: ${e?.code || ""} ${e?.message || e}`.trim(), metaCode: null, status: null };
}

function toInt(v, label) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new MetaInsightsError(`Unparseable ${label}: ${JSON.stringify(v)}`);
  return Math.round(n);
}

function sumActions(list, actionType, label) {
  if (list === undefined || list === null) return 0;
  if (!Array.isArray(list)) throw new MetaInsightsError(`Unexpected ${label} shape: ${typeof list}`);
  return list
    .filter((a) => a && a.action_type === actionType)
    .reduce((acc, a) => acc + toInt(a.value, `${label}.${actionType}`), 0);
}

/**
 * Turn one Ads Insights row into report metrics. `data: []` from Meta means no
 * delivery at all in the window, which is returned as zeros with
 * hasDelivery=false so the caller can decide not to send it.
 */
function parseInsightsRow(row) {
  if (!row) {
    return {
      thruplays: 0, reach: 0, impressions: 0, frequency: 0, videoViews: 0,
      uniqueLinkClicks: 0, uniqueLinkCtr: null, reactions: 0, comments: 0, shares: 0,
      hasDelivery: false,
    };
  }

  const reach = toInt(row.reach, "reach");
  const impressions = toInt(row.impressions, "impressions");
  const uniqueLinkClicks = toInt(row.unique_inline_link_clicks, "unique_inline_link_clicks");

  // Meta's frequency when present; otherwise the same definition from the
  // same deduplicated row.
  let frequency = Number(row.frequency);
  if (!Number.isFinite(frequency)) frequency = reach > 0 ? impressions / reach : 0;

  return {
    // ThruPlay counts PLAYS (to completion, or 15s+), not people.
    thruplays: sumActions(row.video_thruplay_watched_actions, "video_view", "video_thruplay_watched_actions"),
    reach,
    impressions,
    frequency,
    videoViews: sumActions(row.actions, ACTION_TYPES.videoViews, "actions"),
    uniqueLinkClicks,
    // Unique link CTR = unique link clicks / reach, both from the same
    // deduplicated row, so it is exact rather than an average of averages.
    uniqueLinkCtr: reach > 0 ? (uniqueLinkClicks / reach) * 100 : null,
    reactions: sumActions(row.actions, ACTION_TYPES.reactions, "actions"),
    comments: sumActions(row.actions, ACTION_TYPES.comments, "actions"),
    shares: sumActions(row.actions, ACTION_TYPES.shares, "actions"),
    hasDelivery: impressions > 0,
  };
}

function singleRow(data, where) {
  const rows = data?.data;
  if (!Array.isArray(rows)) throw new MetaInsightsError(`Unexpected insights response from ${where}`);
  if (rows.length > 1) {
    // No breakdowns are requested, so more than one row means the request
    // was not what we think it is. Refuse rather than guess which to report.
    throw new MetaInsightsError(`Expected one insights row from ${where}, got ${rows.length}`, { retryable: false });
  }
  return rows[0] || null;
}

/**
 * Fetch deduplicated performance metrics for a client's campaigns over an
 * inclusive date range (YYYY-MM-DD, interpreted by Meta in the ad account's
 * timezone).
 *
 * Returns { metrics, reachIsDeduplicated, query } — query describes how the
 * numbers were obtained, for the audit trail. Throws MetaInsightsError.
 */
async function fetchReportMetrics({ campaignIds, since, until, http = axios, accessToken, graphVersion }) {
  const token = accessToken || process.env.META_INSIGHTS_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN;
  const version = graphVersion || process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
  const base = `https://graph.facebook.com/${version}`;

  if (!token) throw new MetaInsightsError("No Meta access token configured", { retryable: false });
  if (!validCampaignIds(campaignIds)) {
    throw new MetaInsightsError(`Invalid campaign IDs: ${JSON.stringify(campaignIds)}`, { retryable: false });
  }
  const ids = [...new Set(campaignIds.map(String))];
  const time_range = JSON.stringify({ since, until });

  const get = async (url, params, where) => {
    try {
      const res = await http.get(url, { params: { ...params, access_token: token }, timeout: 30000 });
      return res.data;
    } catch (e) {
      const d = describeAxiosError(e);
      // 100 = invalid parameter / field: a retry will get the same answer.
      throw new MetaInsightsError(`${where}: ${d.message}`, {
        retryable: d.metaCode !== 100,
        metaCode: d.metaCode,
      });
    }
  };

  if (ids.length === 1) {
    const data = await get(
      `${base}/${ids[0]}/insights`,
      { level: "campaign", fields: INSIGHTS_FIELDS.join(","), time_range },
      `campaign ${ids[0]} insights`
    );
    return {
      metrics: parseInsightsRow(singleRow(data, `campaign ${ids[0]}`)),
      reachIsDeduplicated: true,
      query: { level: "campaign", campaignIds: ids, since, until, graphVersion: version },
    };
  }

  // Several campaigns: find their ad account(s) in one call, then one
  // deduplicated account-level row filtered to just those campaigns.
  const owners = await get(`${base}/`, { ids: ids.join(","), fields: "account_id" }, "campaign account lookup");
  const accounts = new Set(ids.map((id) => owners?.[id]?.account_id).filter(Boolean));
  if (accounts.size !== 1 || ids.some((id) => !owners?.[id]?.account_id)) {
    throw new MetaInsightsError(
      `Campaigns ${ids.join(", ")} are not all in one readable ad account — reach cannot be deduplicated, refusing to report`,
      { retryable: false }
    );
  }
  const accountId = [...accounts][0];

  const data = await get(
    `${base}/act_${accountId}/insights`,
    {
      level: "account",
      fields: INSIGHTS_FIELDS.join(","),
      time_range,
      filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: ids }]),
    },
    `account ${accountId} insights`
  );
  return {
    metrics: parseInsightsRow(singleRow(data, `account ${accountId}`)),
    reachIsDeduplicated: true,
    query: { level: "account", accountId, campaignIds: ids, since, until, graphVersion: version },
  };
}

module.exports = {
  fetchReportMetrics,
  parseInsightsRow,
  validCampaignIds,
  MetaInsightsError,
  INSIGHTS_FIELDS,
  ACTION_TYPES,
  DEFAULT_GRAPH_VERSION,
};
