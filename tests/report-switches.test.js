// tests/report-switches.test.js
// Proves the two production switches, using the REAL startReportRunner():
//   REPORTS_ENABLED=false  → runner never starts: no timers, no checks,
//                            no reconciliation, no sends — and a typo fails SAFE
//   REPORTS_DRY_RUN        → defaults ON; only an explicit false turns it off
//
// Each case boots the runner in its own child process (startReportRunner is
// once-per-process), with timers intercepted and Twilio replaced by a trap
// that records any send. No database, no network.
//
// Run: node tests/report-switches.test.js

const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { loadConfig } = require(path.join(ROOT, "reportRunner"));

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

// Boot startReportRunner() in a child with the given REPORTS_ENABLED value.
// Returns { timers, sends, logs } as observed inside that process.
function boot(enabledValue) {
  const child = `
    const path = require("path");
    const ROOT = ${JSON.stringify(ROOT)};
    const stub = (rel, exports) => {
      const r = require.resolve(path.join(ROOT, rel));
      require.cache[r] = { id: r, filename: r, loaded: true, exports };
    };
    const sends = [];
    stub("./twilioSms", { sendSms: async (to, body) => { sends.push(to); throw new Error("TRAP: send attempted"); } });
    stub("./clients", {});
    const timers = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => { timers.push(["timeout", ms]); return { unref() {} }; };
    global.setInterval = (fn, ms) => { timers.push(["interval", ms]); return { unref() {} }; };
    const logs = [];
    for (const k of ["log", "warn", "error"]) console[k] = (...a) => logs.push(a.join(" "));
    require(path.join(ROOT, "reportRunner")).startReportRunner();
    realSetTimeout(() => {
      process.stdout.write(JSON.stringify({ timers, sends, logs }));
      process.exit(0);
    }, 300);
  `;
  const env = { ...process.env, DATABASE_URL: "postgres://nobody@127.0.0.1:59997/none", TWILIO_MESSAGING_SERVICE_SID: "MGtest" };
  delete env.REPORTS_ENABLED;
  delete env.REPORTS_DRY_RUN;
  if (enabledValue !== undefined) env.REPORTS_ENABLED = enabledValue;
  const r = spawnSync(process.execPath, ["-e", child], { env, encoding: "utf8", timeout: 20000 });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

console.log("\n▸ REPORTS_ENABLED — emergency shutdown");

for (const v of ["false", "FALSE", "0", "off", "no", " false "]) {
  test(`REPORTS_ENABLED=${JSON.stringify(v)} → runner never starts (no timers, no sends)`, () => {
    const r = boot(v);
    assert.deepStrictEqual(r.timers, [], `timers scheduled: ${JSON.stringify(r.timers)}`);
    assert.deepStrictEqual(r.sends, []);
    assert.ok(r.logs.some((l) => /Report runner DISABLED/.test(l)), r.logs.join("\n"));
    assert.ok(!r.logs.some((l) => /Report runner started|reconciliation: every/.test(l)));
  });
}

for (const v of ["flase", "disabled", "stop", "nope", "2"]) {
  test(`typo/unknown REPORTS_ENABLED=${JSON.stringify(v)} fails SAFE → disabled`, () => {
    const r = boot(v);
    assert.deepStrictEqual(r.timers, []);
    assert.ok(r.logs.some((l) => /DISABLED/.test(l)));
  });
}

for (const v of [undefined, "true", "1", "yes", "on", "TRUE"]) {
  test(`REPORTS_ENABLED=${v === undefined ? "(unset)" : JSON.stringify(v)} → runner starts (check + reconcile timers)`, () => {
    const r = boot(v);
    assert.strictEqual(r.timers.filter(([k]) => k === "interval").length, 2, JSON.stringify(r.timers));
    assert.ok(r.logs.some((l) => /Report runner started/.test(l)));
    assert.deepStrictEqual(r.sends, []);
  });
}

console.log("\n▸ REPORTS_DRY_RUN");

test("unset → dry run ON (the started log says so)", () => {
  const r = boot(undefined);
  assert.ok(r.logs.some((l) => /DRY RUN — nothing will be sent/.test(l)), r.logs.join("\n"));
});

test("only an explicit 0/false/no/off turns dry run OFF; typos keep it ON", () => {
  for (const v of [undefined, "", "true", "1", "yes", "flase", "ture", "live?"]) {
    assert.strictEqual(loadConfig({ REPORTS_DRY_RUN: v }).dryRun, true, `REPORTS_DRY_RUN=${v}`);
  }
  for (const v of ["false", "FALSE", "0", "no", "off"]) {
    assert.strictEqual(loadConfig({ REPORTS_DRY_RUN: v }).dryRun, false, `REPORTS_DRY_RUN=${v}`);
  }
});

console.log(`\n${failures.length ? "❌" : "✅"} report-switches: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
