// =============================================================================
// 003_sms_integration.cjs - SMS alert recipients + delivery log
// Idempotent (safe to run repeatedly). Run:  node db/migrations/003_sms_integration.cjs
//
// SMS alerts (via HTTPSMS) send to phone numbers in `authorized_recipients`.
// Every send attempt is recorded in `sms_logs` (status: sent/failed) so the
// delivery history is auditable. Both tables already exist in the live DB from
// the earlier version of the app; this makes them reproducible on fresh installs.
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
      CREATE TABLE IF NOT EXISTS authorized_recipients (
        id          SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) NOT NULL UNIQUE,
        name        VARCHAR(100),
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sms_logs (
        id             SERIAL PRIMARY KEY,
        recipient_phone VARCHAR(20) NOT NULL,
        message        TEXT NOT NULL,
        status         VARCHAR(20) NOT NULL,
        error_message  TEXT,
        sms_id         VARCHAR(100),
        sent_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const recipCount = await client.query("SELECT COUNT(*)::int AS n FROM authorized_recipients");
    const logCount = await client.query("SELECT COUNT(*)::int AS n FROM sms_logs");

    await client.query("COMMIT");

    console.log(`[migration] 003_sms_integration applied (recipients=${recipCount.rows[0].n}, sms_logs=${logCount.rows[0].n})`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 003_sms_integration failed:", err.message);
  process.exit(1);
});