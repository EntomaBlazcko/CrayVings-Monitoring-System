// =============================================================================
// 004_sms_delivery.cjs - SMS delivery-state columns for sms_logs
// Idempotent (safe to run repeatedly). Run:  node db/migrations/004_sms_delivery.cjs
//
// Adds delivery tracking to `sms_logs` so an SMS accepted by HTTPSMS ("queued")
// can be reconciled to `delivered` (with delivered_at) or `failed` (with
// failure_reason) once the httpsms /v1/messages poller checks the gateway.
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
      ALTER TABLE sms_logs
        ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS failure_reason TEXT
    `);

    const cols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sms_logs' AND table_schema = current_schema()
      ORDER BY ordinal_position
    `);

    const count = await client.query("SELECT COUNT(*)::int AS n FROM sms_logs");
    const delivered = await client.query("SELECT COUNT(*)::int AS n FROM sms_logs WHERE delivered_at IS NOT NULL");
    const failed = await client.query("SELECT COUNT(*)::int AS n FROM sms_logs WHERE status = 'failed'");

    await client.query("COMMIT");

    console.log(`[migration] 004_sms_delivery applied (columns: ${cols.rows.map((c) => c.column_name).join(", ")})`);
    console.log(`[migration] rows total=${count.rows[0].n}, delivered=${delivered.rows[0].n}, failed=${failed.rows[0].n}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 004_sms_delivery failed:", err.message);
  process.exit(1);
});