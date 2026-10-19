// reportRunner.js
// Sends each client's 30-day performance report when its cycle comes due.
//
// State lives in Postgres (reportCycleStore.js), so schedules and "already
// sent" survive deploys, restarts and more than one running instance.
//
// ═══ ONE MESSAGE PER CYCLE, EVEN WHEN THINGS FAIL ═══
//   claim         atomic UPDATE; only one runner can take a due cycle
//   Meta query    failure → back to 'scheduled' with backoff (nothing sent)
//   markSending   written BEFORE Twilio is called
//   Twilio        accepted → 'sent'
//                 definitively rejected (4xx) → 'failed', never retried
//                 rate-limited (429) → retried with backoff
//                 anything else (timeout, 5xx, crash) → 'uncertain', never
//                 retried automatically — Twilio may have accepted it
//
// ═══ SAFE DEFAULTS ═══
//   REPORTS_DRY_RUN defaults to ON: previews are logged and nothing is sent
//   until it is explicitly set to "false".
//   Cycles more than REPORT_MAX_LATE_HOURS overdue are never auto-sent.
//   Reports go out only inside the client's local send window.

const crypto = require("crypto");
const { DateTime } = require("luxon");
const defaultStore = require("./reportCycleStore");
const reportDb = require("./reportDb");
const { fetchReportMetrics, validCampaignIds, MetaInsightsError } = require("./metaInsights");
const {
  buildReportSms,
  findForbiddenContent,
  parseVisitEstimateConfig,
  reportDisplayName,
  DEFAULT_MAX_SEGMENTS,
} = require("./reportFormat");
const { reconcilePayments } = require("./reportReconciler");

const PHONE_RE = /^\+[1-9]\d{7,14}$/;

function flag(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(value));
}

// The emergency switch fails SAFE: only an unset value or an explicit yes
// keeps reports running. A typo ("flase") or any other word ("disabled",
// "stop") turns them off rather than being read as "on".
function enabledSwitch(value) {
  if (value === undefined || value === null || String(value).trim() === "") return true;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function num(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
}

function loadConfig(env = process.env) {
  return {
    enabled: enabledSwitch(env.REPORTS_ENABLED),
    // Also fails safe, the other way round: only an explicit 0/false/no/off
    // turns dry run OFF. A typo keeps it ON.
    dryRun: flag(env.REPORTS_DRY_RUN, true),
    checkMinutes: num(env.REPORT_CHECK_MINUTES, 5),
    periodDays: num(env.REPORT_PERIOD_DAYS, 30),
    contiguousGapDays: num(env.REPORT_CONTIGUOUS_GAP_DAYS, 7),
    sendWindowStartHour: num(env.REPORT_SEND_WINDOW_START_HOUR, 10),
    sendWindowEndHour: num(env.REPORT_SEND_WINDOW_END_HOUR, 19),
    maxLateHours: num(env.REPORT_MAX_LATE_HOURS, 72),
    maxAttempts: num(env.REPORT_MAX_ATTEMPTS, 6),
    staleClaimMinutes: num(env.REPORT_STALE_CLAIM_MINUTES, 15),
    graceDaysWeekly: num(env.REPORT_GRACE_DAYS_WEEKLY, 14),
    graceDaysMonthly: num(env.REPORT_GRACE_DAYS_MONTHLY, 45),
    maxSegments: num(env.REPORT_MAX_SEGMENTS, DEFAULT_MAX_SEGMENTS),
    reconcileMinutes: num(env.REPORT_RECONCILE_MINUTES, 60),
    reconcileLookbackDays: num(env.REPORT_RECONCILE_LOOKBACK_DAYS, 7),
    // Reports must go through the approved A2P Messaging Service, never a
    // bare from-number fallback.
    messagingServiceConfigured: Boolean(env.TWILIO_MESSAGING_SERVICE_SID),
    visit: parseVisitEstimateConfig(env),
  };
}

function backoffMs(attempt) {
  return Math.min(15 * 60 * 1000 * 2 ** attempt, 6 * 60 * 60 * 1000);
}

// Twilio's RestException carries the HTTP status. A 4xx means Twilio refused
// the request and created no message; anything without one (timeout, socket
// reset) or a 5xx means we cannot know.
function classifyTwilioError(err) {
  const status = Number(err?.status);
  const code = err?.code ? String(err.code) : "";
  const detail = `Twilio ${status || "no-status"}${code ? ` code ${code}` : ""}: ${err?.message || err}`;
  if (status === 429) return { kind: "retry", detail };
  if (status >= 400 && status < 500) return { kind: "rejected", detail, optedOut: code === "21610" };
  return { kind: "uncertain", detail };
}

function createReportRunner({
  store = defaultStore,
  clients = require("./clients"),
  sendSms = require("./twilioSms").sendSms,
  fetchMetrics = fetchReportMetrics,
  clock = () => new Date(),
  config = loadConfig(),
  logger = console,
  reconcileFn = reconcilePayments,
} = {}) {
  let running = false;
  const dryRunErrorLoggedAt = new Map();

  const tag = (cycle, client) => `[report #${cycle.id} ${client?.name || cycle.client_name || cycle.stripe_customer_id}]`;

  // Returns a hold reason, or null when the client can be reported on now.
  async function eligibility(cycle, client, now) {
    if (!client) return "client_not_in_registry";
    if (client.reportsEnabled === false) return "reports_disabled_for_client";
    if (!PHONE_RE.test(String(client.phone || ""))) return "missing_or_invalid_phone";
    if (!validCampaignIds(client.analytics?.campaignIds)) return "missing_or_invalid_campaign_ids";
    if (!reportDisplayName(client)) return "missing_report_name";
    if (!config.messagingServiceConfigured && !config.dryRun) return "twilio_messaging_service_not_configured";

    const cadence = client.billing?.cadence === "monthly" ? "monthly" : "weekly";
    const graceDays = cadence === "monthly" ? config.graceDaysMonthly : config.graceDaysWeekly;
    const last = await store.lastPaymentAt(cycle.stripe_customer_id);
    if (!last || now.getTime() - new Date(last).getTime() > graceDays * 86400000) {
      return `payment_overdue (no payment in ${graceDays} days, cadence ${cadence})`;
    }
    return null;
  }

  function inSendWindow(cycle, now) {
    const hour = DateTime.fromJSDate(now, { zone: cycle.timezone }).hour;
    return hour >= config.sendWindowStartHour && hour < config.sendWindowEndHour;
  }

  async function buildFor(cycle, client) {
    const result = await fetchMetrics({
      campaignIds: client.analytics.campaignIds,
      since: cycle.period_start,
      until: cycle.period_end,
    });
    const sms = buildReportSms({
      client,
      periodStart: cycle.period_start,
      periodEnd: cycle.period_end,
      periodDays: config.periodDays,
      metrics: result.metrics,
      reachIsDeduplicated: result.reachIsDeduplicated,
      visitConfig: config.visit,
      maxSegments: config.maxSegments,
    });
    const forbidden = findForbiddenContent(sms.body, { displayName: reportDisplayName(client) });
    const auditMetrics = {
      ...result.metrics,
      reachIsDeduplicated: result.reachIsDeduplicated,
      query: result.query,
      visitEstimate: sms.visitEstimate,
      segments: sms.segments,
    };
    return { result, sms, forbidden, auditMetrics };
  }

  async function processCycle(cycle, now) {
    const client = clients[cycle.stripe_customer_id];
    const t = tag(cycle, client);

    // Overdue beyond tolerance (the service was down, or a cycle sat on hold):
    // flagged for review, NOT dropped. It is sent only after someone approves
    // it with scripts/review-reports.js, which sets late_send_approved_at.
    const lateHours = (now.getTime() - new Date(cycle.report_due_at).getTime()) / 3600000;
    if (lateHours > config.maxLateHours && !cycle.late_send_approved_at) {
      const reason =
        `late: overdue by ${Math.round(lateHours)}h (limit ${config.maxLateHours}h)` +
        (cycle.hold_reason ? `; was held because ${cycle.hold_reason}` : "") +
        ` — awaiting approval (scripts/review-reports.js --approve ${cycle.id})`;
      if (config.dryRun) {
        logger.warn(`⏰ ${t} DRY RUN: would move to needs_review: ${reason}`);
      } else if (await store.markNeedsReview(cycle.id, reason, now)) {
        logger.error(`🛑 ${t} moved to needs_review: ${reason}`);
      }
      return;
    }

    const hold = await eligibility(cycle, client, now);
    if (hold) {
      if (await store.setHold(cycle.id, hold, now)) logger.warn(`⏸️ ${t} report due but held: ${hold}`);
      return;
    }

    if (!inSendWindow(cycle, now)) return; // waits quietly for local business hours

    if (config.dryRun) return previewCycle(cycle, client, now, t);

    const token = crypto.randomUUID();
    const claimed = await store.claim(cycle.id, token, now);
    if (!claimed) return; // another runner has it

    let built;
    try {
      built = await buildFor(claimed, client);
    } catch (e) {
      const retryable = !(e instanceof MetaInsightsError) || e.retryable;
      const msg = `metrics: ${e.message}`;
      if (!retryable) {
        await store.markTerminal(cycle.id, token, "needs_review", msg, now);
        logger.error(`🛑 ${t} Meta error a retry cannot fix → needs_review: ${e.message}`);
      } else if (claimed.attempt_count + 1 >= config.maxAttempts) {
        await store.markTerminal(cycle.id, token, "failed", `${msg} (after ${config.maxAttempts} attempts)`, now);
        logger.error(`❌ ${t} Meta failed ${config.maxAttempts} times → failed: ${e.message}`);
      } else {
        const next = new Date(now.getTime() + backoffMs(claimed.attempt_count));
        await store.releaseForRetry(cycle.id, token, msg, next, now);
        logger.error(`⚠️ ${t} Meta request failed (attempt ${claimed.attempt_count + 1}/${config.maxAttempts}), retry at ${next.toISOString()}: ${e.message}`);
      }
      return;
    }

    const { result, sms, forbidden, auditMetrics } = built;

    if (!result.metrics.hasDelivery) {
      await store.markTerminal(cycle.id, token, "needs_review", "no ad delivery (0 impressions) in period", now);
      logger.error(`🛑 ${t} zero impressions for ${cycle.period_start}..${cycle.period_end} → needs_review, not sent`);
      return;
    }
    if (sms.overBudget) {
      // Never truncated: cutting a report could drop metrics, the estimate
      // disclaimer or STOP/HELP.
      const why = `message is ${sms.segments.segments} segments (limit ${config.maxSegments}) — not truncated, not sent`;
      await store.markTerminal(cycle.id, token, "needs_review", why, now);
      logger.error(`🛑 ${t} ${why} → needs_review`);
      return;
    }
    if (forbidden.length) {
      await store.markTerminal(cycle.id, token, "needs_review", `content guard: ${forbidden.join(", ")}`, now);
      logger.error(`🛑 ${t} content guard blocked the message (${forbidden.join(", ")}) → needs_review`);
      return;
    }
    for (const w of sms.warnings) logger.warn(`⚠️ ${t} ${w}`);

    if (!(await store.markSending(cycle.id, token, { smsBody: sms.body, metrics: auditMetrics, sentTo: client.phone }, now))) {
      logger.error(`⚠️ ${t} lost its claim before sending — not sent by this runner`);
      return;
    }

    let msg;
    try {
      msg = await sendSms(client.phone, sms.body);
    } catch (e) {
      const c = classifyTwilioError(e);
      if (c.kind === "retry" && claimed.attempt_count + 1 < config.maxAttempts) {
        const next = new Date(now.getTime() + backoffMs(claimed.attempt_count));
        await store.releaseForRetry(cycle.id, token, c.detail, next, now);
        logger.error(`⚠️ ${t} Twilio rate-limited, retry at ${next.toISOString()}: ${c.detail}`);
      } else if (c.kind === "rejected" || c.kind === "retry") {
        await store.markTerminal(cycle.id, token, "failed", c.optedOut ? `opted out: ${c.detail}` : c.detail, now);
        logger.error(`❌ ${t} Twilio rejected the report → failed (not retried): ${c.detail}`);
      } else {
        await store.markTerminal(cycle.id, token, "uncertain", c.detail, now);
        logger.error(`❓ ${t} Twilio outcome unknown → uncertain. Check Twilio logs before resending: ${c.detail}`);
      }
      return;
    }

    if (!msg?.sid) {
      await store.markTerminal(cycle.id, token, "uncertain", "Twilio returned no message SID", now);
      logger.error(`❓ ${t} Twilio returned no SID → uncertain`);
      return;
    }

    if (await store.markSent(cycle.id, token, msg.sid, now)) {
      logger.log(
        `✅ ${t} 30-day report sent (${cycle.period_start}..${cycle.period_end}), SID ${msg.sid}, ` +
          `${sms.segments.segments} segment(s) ${sms.segments.encoding}`
      );
    } else {
      // Twilio accepted it but the record did not update; the row stays in
      // 'sending' and recovery will mark it 'uncertain', never resend.
      logger.error(`🚨 ${t} SENT (SID ${msg.sid}) but could not record it — will surface as 'uncertain'`);
    }
  }

  async function previewCycle(cycle, client, now, t) {
    if (cycle.last_preview_at) return; // one preview per cycle
    try {
      const { sms, forbidden, auditMetrics, result } = await buildFor(cycle, client);
      await store.markPreview(cycle.id, { smsBody: sms.body, metrics: auditMetrics }, now);
      logger.log(
        `🧪 ${t} DRY RUN — would send to ${client.phone} (${sms.segments.segments} segment(s) ${sms.segments.encoding})` +
          (result.metrics.hasDelivery ? "" : " [WOULD NOT SEND: zero impressions]") +
          (forbidden.length ? ` [WOULD NOT SEND: content guard ${forbidden.join(", ")}]` : "") +
          (sms.overBudget ? ` [WOULD NOT SEND: over ${config.maxSegments} segments]` : "") +
          (sms.warnings.length ? ` [${sms.warnings.join("; ")}]` : "") +
          `\n----- preview -----\n${sms.body}\n-------------------`
      );
    } catch (e) {
      const last = dryRunErrorLoggedAt.get(cycle.id) || 0;
      if (now.getTime() - last > 3600000) {
        dryRunErrorLoggedAt.set(cycle.id, now.getTime());
        logger.error(`⚠️ ${t} DRY RUN: could not build report: ${e.message}`);
      }
    }
  }

  async function tick() {
    if (running) return { skipped: "previous tick still running" };
    running = true;
    const summary = { due: 0, errors: 0 };
    try {
      const now = clock();
      const recovered = await store.recoverStale(now, config.staleClaimMinutes);
      for (const r of recovered.requeued) logger.warn(`♻️ [report #${r.id} ${r.stripe_customer_id}] stale claim requeued (nothing had been sent)`);
      for (const r of recovered.uncertain) {
        logger.error(`❓ [report #${r.id} ${r.stripe_customer_id}] runner stopped mid-send → uncertain. Check Twilio logs before resending.`);
      }

      const due = await store.listDueCycles(now);
      summary.due = due.length;
      // One client's failure never stops the others.
      for (const cycle of due) {
        try {
          await processCycle(cycle, clock());
        } catch (e) {
          summary.errors++;
          logger.error(`❌ [report #${cycle.id} ${cycle.stripe_customer_id}] unexpected error: ${e.stack || e.message}`);
        }
      }
    } catch (e) {
      summary.errors++;
      logger.error(`❌ Report runner tick failed (database unreachable?): ${e.message}`);
    } finally {
      running = false;
    }
    return summary;
  }

  let reconciling = false;

  // Recover report payments the webhook failed to record (see
  // reportReconciler.js). Records payments only; never sends, never touches
  // Facebook. Runs in dry-run mode too, so schedules are complete either way.
  async function reconcile() {
    if (reconciling) return { skipped: "previous reconciliation still running" };
    reconciling = true;
    try {
      const r = await reconcileFn({ clients, store, now: clock(), config, logger });
      if (r.recovered.length || r.errors) {
        logger.warn(`🩹 Report reconciliation: scanned ${r.scanned} paid invoice(s), recovered ${r.recovered.length}, errors ${r.errors}`);
      }
      return r;
    } catch (e) {
      logger.error(`❌ Report reconciliation failed (will retry next run): ${e.message}`);
      return { error: e.message };
    } finally {
      reconciling = false;
    }
  }

  return { tick, reconcile, processCycle, config };
}

let started = false;

function startReportRunner() {
  if (started) return;
  started = true;

  const config = loadConfig();
  if (!config.enabled) {
    // No timers at all: no report checks, no sends, no reconciliation.
    // (The webhook still records payments, which sends nothing, so schedules
    // stay complete for when reports are switched back on.)
    console.warn(`🛑 Report runner DISABLED (REPORTS_ENABLED=${JSON.stringify(process.env.REPORTS_ENABLED)}) — no reports will be sent`);
    return;
  }
  if (!reportDb.isConfigured()) {
    console.error("🚨 Report runner NOT started: DATABASE_URL is not set, so report schedules cannot be stored.");
    return;
  }

  const runner = createReportRunner({ config });
  console.log(
    `📅 Report runner started (every ${config.checkMinutes} min, ${config.dryRun ? "DRY RUN — nothing will be sent" : "LIVE"}, ` +
      `window ${config.sendWindowStartHour}:00-${config.sendWindowEndHour}:00 local, ` +
      `visit estimate ${config.visit.enabled ? (config.visit.valid ? "ON" : "INVALID CONFIG - omitted") : "off"})`
  );
  if (!config.messagingServiceConfigured) {
    console.warn("⚠️ TWILIO_MESSAGING_SERVICE_SID is not set — live report sends will be held.");
  }

  defaultStore
    .countByStatus()
    .then((c) => console.log("📅 Report cycles by status:", JSON.stringify(c)))
    .catch((e) => console.error("🚨 Report runner cannot read report_cycles (migration applied?):", e.message));

  const run = () =>
    runner.tick().catch((e) => console.error("❌ Report runner tick crashed:", e.stack || e.message));
  setTimeout(run, 30 * 1000); // first check shortly after boot, not 5 minutes later
  setInterval(run, config.checkMinutes * 60 * 1000);

  // Boot-time reconciliation also covers a deploy that killed the process
  // mid-recording: whatever the previous instance dropped is picked up here.
  const reconcile = () => runner.reconcile();
  setTimeout(reconcile, 15 * 1000);
  setInterval(reconcile, config.reconcileMinutes * 60 * 1000);
  console.log(
    `🩹 Report payment reconciliation: every ${config.reconcileMinutes} min, last ${config.reconcileLookbackDays} days of paid invoices`
  );
}

module.exports = { startReportRunner, createReportRunner, loadConfig, classifyTwilioError, backoffMs };
