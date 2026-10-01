// =============================================================================
// services/devicePoller.cjs - Star-topology ESP32 health poller
// =============================================================================
// Reads the device registry (devices.ip_address, populated by the admin/frontend
// and seeded on first sensor contact) and polls each ESP32's read-only GET
// /status endpoint for health/diagnostics only. Sensor data still flows the
// other way (ESP32 -> POST /sensor); this poller never writes sensors rows.
//
// Fail-safe design:
//   - Bounded concurrency (Promise.allSettled in batches) so one hung ESP32 can
//     never delay the others.
//   - Per-request timeout so a dead device fails fast.
//   - Per-device failure counts with backoff-gated warnings (no alert spam).
//   - Never throws from the interval tick.
// =============================================================================

const axios = require("axios");

// Max simultaneous HTTP GETs to ESP32s. Scales with the fleet: a fixed 3 would
// make a 12-device farm need four sequential batches, so one unreachable board
// (REQ_TIMEOUT_MS) would stall a third of the fleet's health checks each cycle.
// Capped so a large farm still cannot flood the LAN with simultaneous requests.
const MAX_CONCURRENCY = 10;
// Per-request timeout. Kept well under POLL_INTERVAL_MS on purpose: a cycle
// polls the fleet in ceil(n/MAX_CONCURRENCY) batches, so the timeout bounds how
// long a cycle can run. Env-tunable because a board that genuinely needs longer
// should not require a code change - but see createTick() for why a slow cycle
// can no longer stack on top of the next one.
const REQ_TIMEOUT_MS = parseInt(process.env.POLL_TIMEOUT_MS) || 2000;
const POLL_INTERVAL_MS = 5000; // cadence
const FAILURE_THRESHOLD = 3; // consecutive failures before a warning is logged
const FAILURE_WARN_BACKOFF_MS = 30000; // don't re-warn more often than this

const failureCounts = new Map();
const lastWarnedMs = new Map();

async function getRegisteredDevices(pool) {
  const result = await pool.query(
    `SELECT device_id, ip_address, tank_name
       FROM devices
      WHERE is_active = true
        AND archived_at IS NULL
        AND ip_address IS NOT NULL
        AND ip_address <> ''`
  );
  return result.rows;
}

async function checkDevice(pool, dev) {
  try {
    const res = await axios.get(`http://${dev.ip_address}/status`, {
      timeout: REQ_TIMEOUT_MS,
    });
    const status = res.data || {};

    // Belt-and-braces: never trust the IP alone. The ESP32 echoes its real
    // device_id in the /status payload; a mismatch means a misconfigured IP.
    if (status.device_id && status.device_id !== dev.device_id) {
      console.warn(
        `[POLL] IP ${dev.ip_address} reported device_id "${status.device_id}", expected "${dev.device_id}" - check registry`
      );
      return;
    }

    await pool.query(
      `UPDATE devices SET last_seen = NOW(), last_health_seen = NOW() WHERE device_id = $1`,
      [dev.device_id]
    );

    failureCounts.set(dev.device_id, 0);
  } catch (err) {
    const failures = (failureCounts.get(dev.device_id) || 0) + 1;
    failureCounts.set(dev.device_id, failures);

    const now = Date.now();
    if (failures >= FAILURE_THRESHOLD && now - (lastWarnedMs.get(dev.device_id) || 0) >= FAILURE_WARN_BACKOFF_MS) {
      lastWarnedMs.set(dev.device_id, now);
      console.warn(
        `[POLL] Device ${dev.device_id} (${dev.ip_address}) unreachable for ${failures} consecutive polls: ${err.message}`
      );
    }
  }
}

async function pollOnce(pool) {
  let devices;
  try {
    devices = await getRegisteredDevices(pool);
  } catch (err) {
    console.error(`[POLL] Failed to load device list:`, err.message);
    return;
  }
  if (devices.length === 0) return;

  // Batched bounded concurrency: Promise.allSettled means a timeout on one
  // device can never reject the batch and delay the next one. The batch size
  // follows the fleet size so a 2-device farm is not throttled and a 20-device
  // farm is not serialised into seven rounds.
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, devices.length));
  for (let i = 0; i < devices.length; i += concurrency) {
    const batch = devices.slice(i, i + concurrency);
    await Promise.allSettled(batch.map((dev) => checkDevice(pool, dev)));
  }
}

// Re-entrancy guard for the interval tick.
//
// A cycle polls the fleet in ceil(n / MAX_CONCURRENCY) batches, so its worst-case
// duration is that many timeouts. At the defaults that is ~2 s per batch, which
// means a fleet of 21+ slow boards already outruns the 5 s interval - and
// setInterval fires regardless of whether the previous cycle finished. Cycles
// would then stack: 2 cycles in flight, 4 a moment later, doubling the load on
// a LAN that is already struggling, and making a transient slowdown look like a
// hard failure. A tick that arrives mid-cycle is dropped so cycles serialise.
function createTick(pool, { onSkip } = {}) {
  let running = false;
  let skippedStreak = 0;

  return {
    get running() {
      return running;
    },
    get skippedStreak() {
      return skippedStreak;
    },
    async run() {
      if (running) {
        skippedStreak++;
        // Warn on the first skip of a streak, then roughly every 20th, so a
        // persistently overrunning poller cannot turn into log spam.
        if (onSkip && (skippedStreak === 1 || skippedStreak % 20 === 0)) onSkip(skippedStreak);
        return false;
      }
      running = true;
      try {
        await pollOnce(pool);
        return true;
      } catch (err) {
        console.error("[POLL] Poll cycle failed:", err.message);
        return false;
      } finally {
        running = false;
        skippedStreak = 0;
      }
    },
  };
}

// Starts the background poller. Safe to call once at boot; never throws.
function startDevicePoller(pool) {
  const tick = createTick(pool, {
    onSkip: (n) =>
      console.warn(
        `[POLL] Previous cycle still running; skipped ${n} tick(s) in a row. ` +
          `Cycles are taking longer than ${POLL_INTERVAL_MS}ms - raise POLL_TIMEOUT_MS ` +
          `or lower MAX_CONCURRENCY.`
      ),
  });

  tick.run();
  setInterval(() => {
    tick.run(); // never rejects: createTick.run() swallows its own errors
  }, POLL_INTERVAL_MS);
  console.log(`[POLL] ESP32 status poller started (every ${POLL_INTERVAL_MS / 1000}s, up to ${MAX_CONCURRENCY} concurrent, timeout ${REQ_TIMEOUT_MS}ms)`);
}

// pollOnce is exported so the batching/concurrency behaviour can be unit tested
// without a database or a running interval. It is not part of the boot path.
// createTick is exported so the overlap guard is testable the same way.
module.exports = { startDevicePoller, pollOnce, createTick, MAX_CONCURRENCY, REQ_TIMEOUT_MS };
