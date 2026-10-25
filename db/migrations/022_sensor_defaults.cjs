// =============================================================================
// 022_sensor_defaults.cjs - Drop vestigial DEFAULT 0 from sensors (defect D1)
// Idempotent (safe to run repeatedly). Run:  node db/migrations/022_sensor_defaults.cjs
//
// WHY: temperature, water_level and ammonia still carry DEFAULT 0 from before
// migration 009 taught the server that a failed sensor is NULL, never 0. The
// default is not just dead weight - it actively contradicts the 009 CHECK
// constraints: temperature = 0 fails chk_sensors_temperature_valid
// (temperature > 0), so an INSERT that omits the column writes 0 and is then
// REJECTED by the database. water_level = 0 is legal (an empty tank), so that
// default is merely misleading. Verified live 2026-10-18.
//
// SAFETY: the single INSERT into sensors (server.cjs, POST /sensor) always
// supplies all reading columns explicitly (NULL for a failed sensor), so
// nothing depends on the defaults. The mock simulator and every test suite
// go through the same endpoint.
//
// This migration is deliberately tiny: three DROP DEFAULT statements plus the
// ledger entry. It pairs with a server.cjs boot-DDL edit that stops recreating
// the defaults on a fresh database.
//
// ROLLBACK (previous state, restores the defect):
//   ALTER TABLE sensors ALTER COLUMN temperature SET DEFAULT 0;
//   ALTER TABLE sensors ALTER COLUMN water_level  SET DEFAULT 0;
//   ALTER TABLE sensors ALTER COLUMN ammonia      SET DEFAULT 0;
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

    // DROP DEFAULT is a no-op when the column has no default, so re-runs and
    // a fresh database (where 000_baseline still creates the pre-022 shape)
    // both converge on the same state.
    await client.query(`ALTER TABLE sensors ALTER COLUMN temperature DROP DEFAULT`);
    await client.query(`ALTER TABLE sensors ALTER COLUMN water_level DROP DEFAULT`);
    await client.query(`ALTER TABLE sensors ALTER COLUMN ammonia DROP DEFAULT`);

    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('022', 'sensor_defaults')
       ON CONFLICT (version) DO NOTHING`
    );

    await client.query("COMMIT");

    // ---- verification report ---------------------------------------------------
    const defs = await client.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'sensors'
          AND column_name IN ('temperature','water_level','ammonia')
        ORDER BY column_name`
    );
    console.log("sensors defaults ->");
    for (const r of defs.rows) {
      console.log(`  ${r.column_name}  default=${r.column_default ?? "(none)"}`);
    }

    console.log("[migration] 022_sensor_defaults applied");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migration] 022_sensor_defaults failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
