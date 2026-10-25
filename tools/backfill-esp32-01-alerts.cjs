/**
 * backfill-esp32-01-alerts.cjs
 *
 * Replays the threshold evaluation the server runs on every POST /sensor over an
 * already-stored window of readings, and writes the system_logs rows it would
 * have produced.
 *
 * Why this exists: alerts are only ever logged inside POST /sensor (the
 * setImmediate block in server.cjs after a reading is stored). History that was
 * bulk-inserted straight into `sensors` - tools/seed-esp32-01-historical.cjs -
 * therefore shows threshold breaches on the dashboard charts while contributing
 * nothing to the Alerts page, the report's Alert Summary or the PDF export: the
 * "Critical" card is computed in the browser from the newest reading, but the
 * alert count comes from system_logs, which never saw that reading. This script
 * replays the same getThresholdStatus() + ALERT_COOLDOWN_MS logic with the
 * historical timestamps so those surfaces finally agree.
 *
 * - Window: 2026-08-01T00:00:00Z .. 2026-08-31T23:59:59Z (override with the FROM
 *   and TO env vars), device ESP32_01 (override with DEVICE).
 * - Thresholds: the same effective values the server would use - per-tank
 *   device_threshold_overrides layered on the global sensor_settings singleton.
 * - Dedup: mirrors the server exactly - "Alert" is written for every reading
 *   whose status is not "good" unless the status is unchanged and still inside
 *   the 120s cooldown, and one "Alert Resolved" closes each episode. The seeded
 *   readings are 5 min apart, so a spike records one alert per reading (the
 *   120s cooldown only collapses bursts, as it does for live 1s data).
 * - last_alerts is deliberately NOT touched: it is the live dedup state that the
 *   server reloads on boot, and seeding it with months-old readings would only
 *   misrepresent the current state.
 * - Add-only: aborts if the window already contains generated rows, so a re-run
 *   can never duplicate them. Pass --replace to delete just this device's
 *   'Alert'/'Alert Resolved' rows in the window first. Nothing outside the
 *   window is ever deleted.
 * - Retention guard: the backend purges system_logs older than
 *   SYSTEM_LOGS_RETENTION_DAYS (default 30) on startup and daily, which would
 *   delete these rows again on the next restart. Aborts when that window is on;
 *   --force overrides (the rows will then be purged on the next backend start).
 *
 * Usage:
 *   node tools/backfill-esp32-01-alerts.cjs
 *   node tools/backfill-esp32-01-alerts.cjs --replace
 *   DEVICE=ESP32_02 FROM=2026-08-01T00:00:00Z TO=2026-09-01T00:00:00Z \
 *     node tools/backfill-esp32-01-alerts.cjs
 */
const { Pool } = require('pg');
require('dotenv').config();

// Must match ALERT_COOLDOWN_MS in server.cjs: readings with the same non-good
// status inside this window are collapsed into the alert already written.
const ALERT_COOLDOWN_MS = 120000;

const DEVICE = process.env.DEVICE || 'ESP32_01';
const FROM = new Date(process.env.FROM || '2026-08-01T00:00:00.000Z');
const TO = new Date(process.env.TO || '2026-08-31T23:59:59.000Z');
const REPLACE = process.argv.includes('--replace');
const FORCE = process.argv.includes('--force');

// Mirrors DEFAULT_THRESHOLDS in server.cjs, used when sensor_settings is empty.
const DEFAULT_THRESHOLDS = { temp_min: 20, temp_max: 31, water_level_min: 10, water_level_max: 100, ammonia_min: 0.25, ammonia_max: 1 };

// Mirrors envDays("SYSTEM_LOGS_RETENTION_DAYS", 30) so the guard agrees with the
// running backend rather than assuming retention is off.
const rawRetention = parseInt(process.env.SYSTEM_LOGS_RETENTION_DAYS, 10);
const systemLogRetentionDays = Number.isFinite(rawRetention) && rawRetention >= 0 ? rawRetention : 30;
if (systemLogRetentionDays > 0 && !FORCE) {
  const cutoffMs = Date.now() - systemLogRetentionDays * 24 * 60 * 60 * 1000;
  console.error(
    `[ABORT] SYSTEM_LOGS_RETENTION_DAYS=${systemLogRetentionDays} is active, so the backend would\n` +
    `        delete these alerts on its next startup/daily cleanup (everything older than\n` +
    `        ${new Date(cutoffMs).toISOString()}).\n` +
    '        Set SYSTEM_LOGS_RETENTION_DAYS=0 in .env and restart the backend, then re-run.\n' +
    '        --force writes them anyway, but they will be purged on the next backend start.'
  );
  process.exit(1);
}

// Mirrors getThresholdStatus() in server.cjs: 15% deviation beyond the range is
// critical, anything outside the range is at least a warning.
function getThresholdStatus(value, min, max) {
  const rangeSize = max - min;
  const criticalMargin = rangeSize * 0.15;
  if (value < min) {
    const deviation = min - value;
    return deviation >= criticalMargin ? 'critical' : 'warning';
  }
  if (value > max) {
    const deviation = value - max;
    return deviation >= criticalMargin ? 'critical' : 'warning';
  }
  return 'good';
}

// Mirrors getThresholdsForDevice() in server.cjs: per-tank overrides win, NULL
// override columns fall back to the global singleton, and a missing override
// table degrades to global quietly.
async function getThresholdsForDevice(client, deviceId) {
  const [settingsResult, overrideResult] = await Promise.all([
    client.query('SELECT * FROM sensor_settings LIMIT 1'),
    client
      .query('SELECT * FROM device_threshold_overrides WHERE device_id = $1', [deviceId])
      .catch(() => ({ rows: [] })),
  ]);
  const global = settingsResult.rows[0] || DEFAULT_THRESHOLDS;
  const override = overrideResult.rows[0] || {};
  const pick = (o, g, d) => Number(o != null ? o : (g != null ? g : d));
  return {
    temp_min: pick(override.temp_min, global.temp_min, DEFAULT_THRESHOLDS.temp_min),
    temp_max: pick(override.temp_max, global.temp_max, DEFAULT_THRESHOLDS.temp_max),
    water_level_min: pick(override.water_level_min, global.water_level_min, DEFAULT_THRESHOLDS.water_level_min),
    water_level_max: pick(override.water_level_max, global.water_level_max, DEFAULT_THRESHOLDS.water_level_max),
    ammonia_min: pick(override.ammonia_min, global.ammonia_min, DEFAULT_THRESHOLDS.ammonia_min),
    ammonia_max: pick(override.ammonia_max, global.ammonia_max, DEFAULT_THRESHOLDS.ammonia_max),
  };
}

async function main() {
  const pool = new Pool({
    host: process.env.PG_HOST || process.env.DB_HOST || 'localhost',
    port: Number(process.env.PG_PORT || process.env.DB_PORT || 5432),
    database: process.env.PG_DATABASE || process.env.DB_NAME,
    user: process.env.PG_USER || process.env.DB_USER,
    password: process.env.PG_PASSWORD || process.env.DB_PASSWORD,
  });
  const client = await pool.connect();
  try {
    const thresholds = await getThresholdsForDevice(client, DEVICE);
    // Same keys, columns, validity floors and order as the server's sensorChecks.
    const checks = [
      { key: 'Temperature', col: 'temperature', min: thresholds.temp_min, max: thresholds.temp_max, minValid: 0.0001 },
      { key: 'Water Level', col: 'water_level', min: thresholds.water_level_min, max: thresholds.water_level_max, minValid: 0 },
      { key: 'Ammonia', col: 'ammonia', min: thresholds.ammonia_min, max: thresholds.ammonia_max, minValid: 0 },
    ];
    console.log('[INFO] thresholds', thresholds);

    const readings = await client.query(
      'SELECT timestamp, temperature, water_level, ammonia FROM sensors WHERE device_id = $1 AND timestamp >= $2 AND timestamp <= $3 ORDER BY timestamp ASC',
      [DEVICE, FROM, TO]
    );
    if (readings.rowCount === 0) {
      console.error(`[ERROR] no readings for ${DEVICE} between ${FROM.toISOString()} and ${TO.toISOString()} - run tools/seed-esp32-01-historical.cjs first`);
      process.exit(1);
    }
    console.log(`[INFO] replaying ${readings.rowCount} readings`);

    const existing = await client.query(
      `SELECT COUNT(*)::int AS c FROM system_logs
       WHERE device_id = $1 AND action IN ('Alert', 'Alert Resolved') AND timestamp >= $2 AND timestamp <= $3`,
      [DEVICE, FROM, TO]
    );
    if (existing.rows[0].c > 0) {
      if (!REPLACE) {
        console.error(
          `[ERROR] ${existing.rows[0].c} generated system_logs rows already exist in the window.\n` +
          `        Re-run with --replace to delete them first, or clear them manually:\n` +
          `        DELETE FROM system_logs WHERE device_id = '${DEVICE}' AND action IN ('Alert', 'Alert Resolved')\n` +
          `          AND timestamp >= '${FROM.toISOString()}' AND timestamp <= '${TO.toISOString()}';`
        );
        process.exit(1);
      }
      const removed = await client.query(
        `DELETE FROM system_logs
         WHERE device_id = $1 AND action IN ('Alert', 'Alert Resolved') AND timestamp >= $2 AND timestamp <= $3`,
        [DEVICE, FROM, TO]
      );
      console.log(`[INFO] --replace removed ${removed.rowCount} existing rows`);
    }

    // The server's per-sensor dedup state, keyed `${deviceId}:${sensor}` as one
    // entry per sensor per tank; here it only lives for the replay.
    const state = {};
    const out = [];
    for (const r of readings.rows) {
      const ts = new Date(r.timestamp).getTime();
      for (const s of checks) {
        const val = Number(r[s.col]);
        if (!Number.isFinite(val) || val < s.minValid) continue;
        const status = getThresholdStatus(val, s.min, s.max);
        const last = state[s.key] || {};

        if (status === 'good') {
          if (last.status && last.status !== 'good') {
            out.push(['Alert Resolved', s.key, last.status, 'good', DEVICE, r.timestamp]);
            state[s.key] = { status: 'good', ts };
          }
          continue;
        }

        if (status === last.status && ts - (last.ts || 0) < ALERT_COOLDOWN_MS) continue;

        const direction = val < s.min ? 'Low' : 'High';
        out.push(['Alert', s.key, direction, String(val), DEVICE, r.timestamp]);
        state[s.key] = { status, ts };
      }
    }

    let ins = 0;
    const chunkSize = 1000;
    for (let i = 0; i < out.length; i += chunkSize) {
      const chunk = out.slice(i, i + chunkSize);
      const values = [];
      const placeholders = [];
      for (let j = 0; j < chunk.length; j++) {
        const b = j * 6;
        placeholders.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
        values.push(...chunk[j]);
      }
      await client.query(
        `INSERT INTO system_logs (action, parameter, old_value, new_value, device_id, timestamp) VALUES ${placeholders.join(',')}`,
        values
      );
      ins += chunk.length;
    }

    const byAction = {};
    const byParam = {};
    for (const row of out) {
      byAction[row[0]] = (byAction[row[0]] || 0) + 1;
      byParam[row[1]] = (byParam[row[1]] || 0) + 1;
    }
    console.log('[SUCCESS] inserted', ins, 'system_logs rows');
    console.log('[INFO] by action:', byAction);
    console.log('[INFO] by parameter:', byParam);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('[ERR]', e); process.exit(1); });
