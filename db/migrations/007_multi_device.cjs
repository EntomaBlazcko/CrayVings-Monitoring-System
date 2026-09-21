// =============================================================================
// 007_multi_device.cjs - Star-topology / multi-tank support
// Idempotent (safe to run repeatedly). Run:  node db/migrations/007_multi_device.cjs
//
//   1. devices gains the properties the central server + poller need to
//      identify and monitor each ESP32 in the star topology:
//        - ip_address       (192.168.4.x static IP of the device)
//        - tank_name        (friendly label, e.g. "Tank 3 - Bayside")
//        - tank_location    (physical location / zone)
//        - last_health_seen (last successful GET /status from the poller)
//   2. devices.created_at / last_seen -> TIMESTAMPTZ so the server's
//      new Date() comparisons (offline detection) are timezone-safe.
//   3. sensors / system_logs.timestamp -> TIMESTAMPTZ (same pattern as 005).
//   4. Composite (device_id, timestamp DESC) index so per-tank history and
//      trend queries stay fast once more devices are writing at 1 Hz.
// =============================================================================

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

async function typeOf(client, table, column) {
  const res = await client.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return res.rows[0] ? res.rows[0].data_type : null;
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- 1. devices registry enrichment -----------------------------------
    await client.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS ip_address TEXT`
    );
    await client.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS tank_name VARCHAR(100)`
    );
    await client.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS tank_location VARCHAR(100)`
    );
    await client.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_health_seen TIMESTAMPTZ`
    );

    // ---- 2. devices timezone-aware timestamps -----------------------------
    if ((await typeOf(client, "devices", "created_at")) === "timestamp without time zone") {
      await client.query(
        `ALTER TABLE devices ALTER COLUMN created_at TYPE TIMESTAMPTZ
           USING created_at AT TIME ZONE 'UTC'`
      );
    }
    if ((await typeOf(client, "devices", "last_seen")) === "timestamp without time zone") {
      await client.query(
        `ALTER TABLE devices ALTER COLUMN last_seen TYPE TIMESTAMPTZ
           USING last_seen AT TIME ZONE 'UTC'`
      );
    }

    // ---- 3. sensors / system_logs -> TIMESTAMPTZ --------------------------
    if ((await typeOf(client, "sensors", "timestamp")) === "timestamp without time zone") {
      await client.query(
        `ALTER TABLE sensors ALTER COLUMN timestamp TYPE TIMESTAMPTZ
           USING timestamp AT TIME ZONE 'UTC'`
      );
    }
    if ((await typeOf(client, "system_logs", "timestamp")) === "timestamp without time zone") {
      await client.query(
        `ALTER TABLE system_logs ALTER COLUMN timestamp TYPE TIMESTAMPTZ
           USING timestamp AT TIME ZONE 'UTC'`
      );
    }

    // ---- 4. per-tank query index ------------------------------------------
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_sensors_device_timestamp
         ON sensors (device_id, timestamp DESC)`
    );

    await client.query("COMMIT");

    // ---- verification report ----------------------------------------------
    const devCols = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'devices'
        ORDER BY ordinal_position`
    );
    console.log("devices columns ->");
    for (const r of devCols.rows) {
      console.log(`  ${r.column_name}  ${r.data_type}`);
    }

    const idx = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'sensors' AND indexname = 'idx_sensors_device_timestamp'`
    );
    console.log("composite index ->", idx.rows[0]?.indexname ?? "MISSING");

    for (const [t, c] of [["sensors", "timestamp"], ["system_logs", "timestamp"]]) {
      const ty = await typeOf(client, t, c);
      console.log(`${t}.${c} -> ${ty}`);
    }

    console.log("[migration] 007_multi_device applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 007_multi_device failed:", err.message);
  process.exit(1);
});