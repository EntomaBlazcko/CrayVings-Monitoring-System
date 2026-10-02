// =============================================================================
// tests/devicePoller.cjs - Device health poller: batching + active-only filter
// =============================================================================
// Pure unit tests, no database and no server required. The poller is the one part
// of the Devices module whose behaviour (how many ESP32s are hit at once) is not
// visible through the API, so it is verified directly here.
//
//   Run:  npm run test:poller
//
// The two things that actually matter and could silently regress:
//   1. Bounded concurrency must scale with the fleet but stay <= MAX_CONCURRENCY,
//      so a 12-board farm is not serialised into four rounds of timeouts while a
//      200-board farm cannot flood the LAN.
//   2. The device query must exclude archived devices, or a retired ESP32 keeps
//      being health-polled forever.
// =============================================================================


// axios is required by the poller; stub .get before the poller is loaded so the
// poller captures the stub through the shared module instance.
const axios = require("axios");

const { pollOnce, createTick, MAX_CONCURRENCY, REQ_TIMEOUT_MS } = require("../services/devicePoller.cjs");

let checks = 0;
let failures = 0;

function check(name, cond, extra = "") {
  checks++;
  if (cond) console.log(`PASS  ${name}${extra ? "  -> " + extra : ""}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${extra ? "  -> " + extra : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Records every device-list query the poller issues, so the WHERE clause can be
// asserted on.
function makePool(devices) {
  const queries = [];
  return {
    queries,
    query(sql, params) {
      queries.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) return Promise.resolve({ rows: devices });
      return Promise.resolve({ rows: [] }); // the last_health_seen UPDATE
    },
  };
}

const makeDevice = (n) => ({
  device_id: `POLL_${n}`,
  ip_address: `192.0.2.${n}`,
  tank_name: `Tank ${n}`,
});

// Replaces axios.get with a fake that tracks how many calls overlap, and takes
// `delayMs` to answer. Rejected promises model an unreachable ESP32.
function stubAxios({ delayMs = 40, fail = false } = {}) {
  let inFlight = 0;
  let peakInFlight = 0;
  const called = [];
  const timeouts = [];

  axios.get = (url, opts) => {
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    called.push(url);
    if (opts && opts.timeout !== undefined) timeouts.push(opts.timeout);
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        inFlight--;
        if (fail) reject(new Error("connect ECONNREFUSED"));
        else resolve({ data: {} });
      }, delayMs);
    });
  };

  return {
    called,
    timeouts,
    get peak() {
      return peakInFlight;
    },
  };
}

async function main() {
  console.log("=== Device poller unit tests ===\n");

  // --- A. Active-only filter ------------------------------------------------
  console.log("--- A. Active-only device query ---");

  const poolA = makePool([makeDevice(1)]);
  await pollOnce(poolA);
  const select = poolA.queries.find((q) => /^\s*SELECT/i.test(q.sql));
  check("poller issues a device-list SELECT", Boolean(select));
  check("query filters is_active", /is_active\s*=\s*true/i.test(select.sql));
  check(
    "query excludes archived devices",
    /archived_at\s+IS\s+NULL/i.test(select.sql),
    "archived_at IS NULL present"
  );
  check(
    "query skips devices with no IP",
    /ip_address\s+IS\s+NOT\s+NULL/i.test(select.sql) && /ip_address\s*<>/i.test(select.sql)
  );

  // --- B. Empty fleet -------------------------------------------------------
  console.log("\n--- B. Empty fleet ---");

  const stubB = stubAxios();
  await pollOnce(makePool([]));
  check("empty fleet makes no HTTP calls", stubB.called.length === 0, `${stubB.called.length} calls`);

  // --- C. Concurrency is bounded and scales with the fleet -----------------
  console.log("\n--- C. Bounded concurrency ---");

  // 4 devices: never throttled below the fleet size.
  const stubC4 = stubAxios({ delayMs: 40 });
  await pollOnce(makePool([1, 2, 3, 4].map(makeDevice)));
  check(
    "4 devices are polled simultaneously (no needless throttling)",
    stubC4.peak === 4,
    `peak in flight = ${stubC4.peak}, expected 4`
  );

  // 12 devices: exactly MAX_CONCURRENCY at a time, not 12 and not 3.
  const stubC12 = stubAxios({ delayMs: 40 });
  await pollOnce(makePool(Array.from({ length: 12 }, (_, i) => makeDevice(i + 1))));
  check(
    `12 devices never exceed MAX_CONCURRENCY (${MAX_CONCURRENCY})`,
    stubC12.peak <= MAX_CONCURRENCY,
    `peak in flight = ${stubC12.peak}, cap = ${MAX_CONCURRENCY}`
  );
  check(
    "12 devices actually reach full concurrency (not serialised)",
    stubC12.peak === MAX_CONCURRENCY,
    `peak in flight = ${stubC12.peak}, expected ${MAX_CONCURRENCY}`
  );
  check("all 12 devices were polled", stubC12.called.length === 12, `${stubC12.called.length} calls`);

  // 60 devices: the cap still holds, so a large farm cannot flood the LAN.
  const stubC60 = stubAxios({ delayMs: 15 });
  await pollOnce(makePool(Array.from({ length: 60 }, (_, i) => makeDevice(i + 1))));
  check(
    `60 devices still respect the cap of ${MAX_CONCURRENCY}`,
    stubC60.peak <= MAX_CONCURRENCY,
    `peak in flight = ${stubC60.peak}`
  );
  check("all 60 devices were polled", stubC60.called.length === 60, `${stubC60.called.length} calls`);

  // --- D. One dead board must not stall the batch --------------------------
  console.log("\n--- D. Failure isolation ---");

  // Every device unreachable: allSettled must absorb it and still poll everyone.
  const stubD = stubAxios({ delayMs: 30, fail: true });
  let threw = false;
  try {
    await pollOnce(makePool(Array.from({ length: 12 }, (_, i) => makeDevice(i + 1))));
  } catch {
    threw = true;
  }
  check("a fully unreachable fleet does not throw", threw === false);
  check(
    "all 12 still attempted despite every one failing",
    stubD.called.length === 12,
    `${stubD.called.length} calls`
  );

  // --- E. Successful poll writes last_health_seen --------------------------
  console.log("\n--- E. Health write-back ---");

  const stubE = stubAxios({ delayMs: 5 }); // healthy board
  const poolE = makePool([makeDevice(7)]);
  await pollOnce(poolE);
  check("successful poll issues exactly one GET", stubE.called.length === 1, `${stubE.called.length} calls`);
  const update = poolE.queries.find((q) => /UPDATE\s+devices/i.test(q.sql));
  check("successful poll records last_health_seen", Boolean(update));
  check(
    "update targets the polled device",
    update && update.params && update.params[0] === "POLL_7",
    update ? JSON.stringify(update.params) : "no update"
  );
  check(
    "the health UPDATE is not archived-guarded (pollers only see active rows)",
    update && !/archived/i.test(update.sql)
  );

  // --- F. Mismatched device_id is refused (no false health) ----------------
  console.log("\n--- F. Misconfigured IP ---");

  axios.get = () => Promise.resolve({ data: { device_id: "SOMEONE_ELSE" } });
  const poolF = makePool([makeDevice(1)]);
  await pollOnce(poolF);
  check(
    "a /status echoing a different device_id is not credited as healthy",
    !poolF.queries.some((q) => /UPDATE/i.test(q.sql)),
    "no last_health_seen write"
  );

  // --- G. Timing: the timeout is forwarded, and stays bounded ---------------
  console.log("\n--- G. Cycle timing and request timeout ---");

  const stubG = stubAxios({ delayMs: 2000 }); // every board hangs, worst case
  await pollOnce(makePool(Array.from({ length: 12 }, (_, i) => makeDevice(i + 1))));
  check(
    "the configured per-request timeout is passed to axios",
    stubG.timeouts.length > 0 && stubG.timeouts.every((t) => t === REQ_TIMEOUT_MS),
    `timeouts=${JSON.stringify(stubG.timeouts)} REQ_TIMEOUT_MS=${REQ_TIMEOUT_MS}`
  );
  // The default is deliberately kept at 2s (env-tunable via POLL_TIMEOUT_MS).
  // At 2s a 12-board worst case is 2 batches = ~4s, inside the 5s interval. The
  // original finding proposed 5000ms, which would push this to ~10s and let
  // cycles overlap the next tick - the overlap guard in H is what makes a longer
  // timeout safe, not the arithmetic.
  check(
    "default timeout keeps a 12-device cycle inside the poll interval",
    REQ_TIMEOUT_MS * 2 < 5000,
    `2 batches x ${REQ_TIMEOUT_MS}ms`
  );

  // --- H. Overlap safety: cycles must never stack ---------------------------
  console.log("\n--- H. Overlap safety (re-entrancy guard) ---");

  // A slow cycle must make the next tick a no-op rather than a second cycle.
  // 12 boards at a 300ms stub delay = 2 batches ~600ms, enough to overlap a
  // second run() call issued immediately after the first.
  const stubH = stubAxios({ delayMs: 300 });
  const tickH = createTick(makePool(Array.from({ length: 12 }, (_, i) => makeDevice(i + 1))));
  const first = tickH.run();
  await sleep(50);
  check("tick reports running while a cycle is in flight", tickH.running === true);
  const second = await tickH.run();
  check("a tick during an in-flight cycle is skipped", second === false);
  check("the skip is counted", tickH.skippedStreak === 1, `streak=${tickH.skippedStreak}`);
  check("the skipped tick issued no extra requests", stubH.called.length <= MAX_CONCURRENCY, `${stubH.called.length} calls`);
  const firstResult = await first;
  check("the first cycle completed", firstResult === true);
  check("tick is idle again once the cycle finished", tickH.running === false);
  check("skip streak resets after a completed cycle", tickH.skippedStreak === 0, `streak=${tickH.skippedStreak}`);

  // Sequential ticks still work - the guard must not permanently wedge the poller.
  const stubH2 = stubAxios({ delayMs: 5 });
  const tickH2 = createTick(makePool([makeDevice(1)]));
  check("a fresh tick runs", (await tickH2.run()) === true);
  check("a following tick also runs", (await tickH2.run()) === true);
  check("both sequential cycles hit the device", stubH2.called.length === 2, `${stubH2.called.length} calls`);

  // A rejected device-list query is absorbed by pollOnce itself, so the cycle
  // completes normally and the tick must be released.
  const dbDownPool = { query: () => Promise.reject(new Error("db down")) };
  const tickDb = createTick(dbDownPool);
  check("a rejected device-list query does not reject the tick", (await tickDb.run()) === true);
  check("tick is released after a swallowed DB error", tickDb.running === false);

  // A cycle that throws *outside* pollOnce's own try/catch must still release the
  // tick, or the guard would wedge the poller permanently after one bad cycle.
  const brokenPool = { query: () => Promise.resolve({ rows: null }) }; // rows null -> .length throws
  const tickBroken = createTick(brokenPool);
  check("a cycle that throws does not reject the tick", (await tickBroken.run()) === false);
  check("tick is released after a thrown cycle", tickBroken.running === false);

  console.log(
    `\n${failures === 0 ? "=== ALL DEVICE POLLER TESTS PASSED ===" : `=== ${failures} FAILED ===`} (${checks} checks)`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("poller test crashed:", err);
  process.exit(1);
});
