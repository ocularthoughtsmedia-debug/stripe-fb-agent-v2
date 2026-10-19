// scripts/review-reports.js
// Human review queue for 30-day reports: late, held, failed and uncertain
// cycles. Nothing here sends a message — approving only puts a cycle back in
// the runner's queue, where every normal check (send window, phone, payment
// grace, content guard, zero delivery) still applies.
//
//   node scripts/review-reports.js                       list what needs attention
//   node scripts/review-reports.js --approve 42 --note "client was on hold, OK to send"
//   node scripts/review-reports.js --approve 42 --confirm-not-delivered --note "..."
//                                                        (required for 'uncertain': check
//                                                         Twilio logs first, or the client
//                                                         may get the report twice)
//   node scripts/review-reports.js --cancel 42 --note "too old to be useful"
//
// Uses DATABASE_URL from the environment / .env.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const store = require(path.join(__dirname, "..", "reportCycleStore"));
const db = require(path.join(__dirname, "..", "reportDb"));

const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n) => argv.includes(`--${n}`);

(async () => {
  const now = new Date();

  if (has("approve") || has("cancel")) {
    const id = Number(opt("approve") || opt("cancel"));
    if (!Number.isInteger(id)) throw new Error("Give a numeric cycle id");
    const note = opt("note");
    if (!note) throw new Error("--note is required so the decision is recorded");

    if (has("cancel")) {
      const c = await store.cancelCycle(id, note, now);
      console.log(c ? `🗑️  Cycle #${id} cancelled.` : `Cycle #${id} not found or not cancellable.`);
    } else {
      const before = await store.getCycle(id);
      if (before?.status === "uncertain" && !has("confirm-not-delivered")) {
        throw new Error(
          `Cycle #${id} is 'uncertain' — Twilio may already have delivered it. Check the Twilio logs for ` +
            `${before.sent_to}; only if nothing was delivered, re-run with --confirm-not-delivered.`
        );
      }
      const c = await store.approveForSend(id, { note, confirmNotDelivered: has("confirm-not-delivered") }, now);
      console.log(
        c
          ? `✅ Cycle #${id} approved; the runner will send it in the client's next send window (if every other check passes).`
          : `Cycle #${id} not found or not in an approvable state (needs_review / failed / uncertain).`
      );
    }
    return;
  }

  const rows = await store.listAttention();
  if (!rows.length) {
    console.log("Nothing needs attention.");
    return;
  }
  for (const c of rows) {
    console.log(
      `#${c.id}  ${c.status.padEnd(12)} ${c.client_name}  ${c.period_start}..${c.period_end}  ` +
        `due ${new Date(c.report_due_at).toISOString()}`
    );
    if (c.hold_reason) console.log(`      held: ${c.hold_reason}`);
    if (c.last_error) console.log(`      reason: ${c.last_error}`);
    if (c.review_note) console.log(`      note: ${c.review_note}`);
  }
})()
  .catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
