// =============================================================================
// 012_device_thresholds.cjs - Per-tank threshold overrides
// Idempotent (safe to run repeatedly). Run:  node db/migrations/012_device_thresholds.cjs
//
//   Creates device_threshold_overrides: per-tank threshold ranges layered on
//   top of the global sensor_settings singleton. Every range column is
//   nullable — NULL (or absence of a row) means "inherit the global value".
//   Resolution order at read time: COALESCE(override, global).
//
//   No backfill is needed: the absence of a row IS the inherit-from-global
//   state, so existing data is untouched and every tank starts on the
//   current global thresholds.
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

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS device_threshold_overrides (
        device_id VARCHAR(50) PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
        temp_min DECIMAL(5,2),
        temp_max DECIMAL(5,2),
        water_level_min DECIMAL(5,2),
        water_level_max DECIMAL(5,2),
        ammonia_min DECIMAL(5,2),
        ammonia_max DECIMAL(5,2),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('012', 'device_thresholds')
       ON CONFLICT (version) DO NOTHING`
    );

    await client.query("COMMIT");

    // ---- verification report ---------------------------------------------------
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'device_threshold_overrides' ORDER BY ordinal_position`
    );
    console.log("device_threshold_overrides columns ->");
    for (const r of cols.rows) {
      console.log(`  ${r.column_name}  ${r.data_type}  nullable=${r.is_nullable}`);
    }

    const registered = await client.query(
      `SELECT version, name FROM schema_migrations WHERE version IN ('011','012') ORDER BY version`
    );
    for (const r of registered.rows) {
      console.log(`schema_migrations -> ${r.version} ${r.name}`);
    }

    console.log("[migration] 012_device_thresholds applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 012_device_thresholds failed:", err.message);
  process.exit(1);
});
