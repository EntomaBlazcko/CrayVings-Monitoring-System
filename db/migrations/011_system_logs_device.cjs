// =============================================================================
// 011_system_logs_device.cjs - Per-tank alert/log attribution
// Idempotent (safe to run repeatedly). Run:  node db/migrations/011_system_logs_device.cjs
//
//   1. system_logs gains a nullable device_id column (FK -> devices, ON DELETE
//      SET NULL) so threshold alerts, alert-resolves, device disconnects, and
//      settings changes can be attributed to a tank. NULL = farm-wide/global
//      row (also covers all history that predates this migration).
//   2. Backfill the only derivable rows: "Device Disconnect" entries embed the
//      device_id in `parameter` (see server.cjs checkDeviceDisconnects).
//      Non-matching disconnect strings (DEVICE / ESP32 / TEST) stay NULL.
//   3. Composite (device_id, timestamp DESC) index for per-tank log queries.
//   4. schema_migrations bookkeeping: the tracking table (010) was never
//      applied to the live DB, so it is created here and seeded 001-011 via
//      ON CONFLICT DO NOTHING (safe whether or not 010 ran).
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

const MIGRATION_HISTORY = [
  { version: "001", name: "user_deletion" },
  { version: "002", name: "owner_admin" },
  { version: "003", name: "sms_integration" },
  { version: "004", name: "sms_delivery" },
  { version: "005", name: "schema_consistency" },
  { version: "006", name: "archive_restore" },
  { version: "007", name: "multi_device" },
  { version: "008", name: "device_secrets" },
  { version: "009", name: "sensor_constraints" },
  { version: "010", name: "schema_migrations" },
  { version: "011", name: "system_logs_device" },
];

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- 1. schema_migrations tracking table (010 was never applied) --------
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum VARCHAR(64)
      )
    `);
    for (const m of MIGRATION_HISTORY) {
      await client.query(
        `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)
           ON CONFLICT (version) DO NOTHING`,
        [m.version, m.name]
      );
    }

    // ---- 2. system_logs.device_id -------------------------------------------
    await client.query(
      `ALTER TABLE system_logs
         ADD COLUMN IF NOT EXISTS device_id VARCHAR(50)
         REFERENCES devices(device_id) ON DELETE SET NULL`
    );

    // ---- 3. backfill derivable rows ------------------------------------------
    const backfill = await client.query(
      `UPDATE system_logs sl
         SET device_id = sl.parameter
       WHERE sl.device_id IS NULL
         AND sl.action = 'Device Disconnect'
         AND sl.parameter IN (SELECT device_id FROM devices)`
    );

    // ---- 4. per-tank query index ----------------------------------------------
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_system_logs_device_ts
         ON system_logs (device_id, timestamp DESC)`
    );

    await client.query("COMMIT");

    // ---- verification report ---------------------------------------------------
    const cols = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'system_logs' AND column_name = 'device_id'`
    );
    console.log("system_logs.device_id ->", cols.rows[0]?.data_type ?? "MISSING");

    const idx = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'system_logs' AND indexname = 'idx_system_logs_device_ts'`
    );
    console.log("composite index ->", idx.rows[0]?.indexname ?? "MISSING");

    console.log("disconnect rows backfilled ->", backfill.rowCount);

    const attributed = await client.query(
      `SELECT COUNT(*)::int AS c FROM system_logs WHERE device_id IS NOT NULL`
    );
    console.log("system_logs rows with device_id ->", attributed.rows[0].c);

    console.log("[migration] 011_system_logs_device applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 011_system_logs_device failed:", err.message);
  process.exit(1);
});
