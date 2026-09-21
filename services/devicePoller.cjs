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

const CONCURRENCY = 3; // max simultaneous HTTP GETs to ESP32s
const REQ_TIMEOUT_MS = 2000; // fail fast on a hung device
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
      `UPDATE devices SET last_health_seen = NOW() WHERE device_id = $1`,
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
  // device can never reject the batch and delay the next one.
  for (let i = 0; i < devices.length; i += CONCURRENCY) {
    const batch = devices.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map((dev) => checkDevice(pool, dev)));
  }
}

// Starts the background poller. Safe to call once at boot; never throws.
function startDevicePoller(pool) {
  pollOnce(pool).catch((err) => {
    console.error(`[POLL] Initial poll failed:`, err.message);
  });
  setInterval(() => {
    pollOnce(pool).catch(() => {}); // swallow: interval must never crash
  }, POLL_INTERVAL_MS);
  console.log(`[POLL] ESP32 status poller started (every ${POLL_INTERVAL_MS / 1000}s, concurrency ${CONCURRENCY}, timeout ${REQ_TIMEOUT_MS}ms)`);
}

module.exports = { startDevicePoller };