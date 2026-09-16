// =============================================================================
// 005_schema_consistency.cjs - Align live schema with docs/DATABASE_SCHEMA.txt
// Idempotent (safe to run repeatedly). Run:  node db/migrations/005_schema_consistency.cjs
//
// Reconciles a few drifting bits between the live DB and the documented schema:
//   1. sensor_settings.ammonia_min / ammonia_max column DEFAULTS -> 0.25 / 1.00
//      (the live columns were created by an earlier app version with 0.0 / 0.5;
//      the code, docs, and fresh-install path all use 0.25 / 1.00).
//   2. Drops the stray DEFAULT 'ESP32_01' on last_alerts.device_id (undocumented).
//   3. Drops the stray DEFAULT 'Admin' on activity_logs.user_name (undocumented).
//   4. users.password_hash -> TEXT (docs say TEXT; live is unbounded VARCHAR).
//   5. users.token_expires_at -> TIMESTAMPTZ (timezone-aware so the server's
//      new Date() comparisons are unambiguous; already correct on installed DBs).
//   6. sms_logs.sent_at -> TIMESTAMPTZ (docs + migration 003 define it as
//      TIMESTAMPTZ; existing naive timestamps are reinterpreted in the session
//      timezone so the underlying instant is preserved).
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

    // ---- 1. sensor_settings ammonia defaults -----------------------------
    await client.query(
      `ALTER TABLE sensor_settings ALTER COLUMN ammonia_min SET DEFAULT 0.25`
    );
    await client.query(
      `ALTER TABLE sensor_settings ALTER COLUMN ammonia_max SET DEFAULT 1.00`
    );

    // ---- 2. drop stray default on last_alerts.device_id ------------------
    await client.query(
      `ALTER TABLE last_alerts ALTER COLUMN device_id DROP DEFAULT`
    );

    // ---- 3. drop stray default on activity_logs.user_name -----------------
    await client.query(
      `ALTER TABLE activity_logs ALTER COLUMN user_name DROP DEFAULT`
    );

    // ---- 4. users.password_hash -> TEXT ----------------------------------
    await client.query(
      `ALTER TABLE users ALTER COLUMN password_hash TYPE TEXT`
    );

    // ---- 5. users.token_expires_at -> TIMESTAMPTZ ------------------------
    const tzCol = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'token_expires_at'`
    );
    if (tzCol.rows[0] && tzCol.rows[0].data_type === "timestamp without time zone") {
      // Naive values written by the pre-fix server are treated as UTC here;
      // on already-timezone-aware DBs this is a no-op.
      await client.query(
        `ALTER TABLE users ALTER COLUMN token_expires_at TYPE TIMESTAMPTZ
           USING token_expires_at AT TIME ZONE 'UTC'`
      );
    }

    // ---- 6. sms_logs.sent_at -> TIMESTAMPTZ ------------------------------
    const sentCol = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'sms_logs' AND column_name = 'sent_at'`
    );
    if (sentCol.rows[0] && sentCol.rows[0].data_type === "timestamp without time zone") {
      // Reinterpret stored local wall-clock values in the session timezone so
      // the absolute instant they represented is preserved.
      await client.query(
        `ALTER TABLE sms_logs ALTER COLUMN sent_at TYPE TIMESTAMPTZ
           USING sent_at AT TIME ZONE current_setting('TimeZone')`
      );
    }

    await client.query("COMMIT");

    // ---- verification report ----------------------------------------------
    const settingsDefaults = await client.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'sensor_settings'
          AND column_name IN ('ammonia_min','ammonia_max')
        ORDER BY column_name`
    );
    console.log("sensor_settings defaults ->", JSON.stringify(settingsDefaults.rows));

    const lastAlertsDefault = await client.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'last_alerts' AND column_name = 'device_id'`
    );
    console.log("last_alerts.device_id default ->", lastAlertsDefault.rows[0]?.column_default ?? "(none)");

    const activityDefault = await client.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'activity_logs' AND column_name = 'user_name'`
    );
    console.log("activity_logs.user_name default ->", activityDefault.rows[0]?.column_default ?? "(none)");

    const types = await client.query(
      `SELECT table_name, data_type FROM information_schema.columns
        WHERE (table_name = 'users' AND column_name = 'password_hash')
           OR (table_name = 'users' AND column_name = 'token_expires_at')
           OR (table_name = 'sms_logs' AND column_name = 'sent_at')
        ORDER BY table_name, column_name`
    );
    for (const r of types.rows) {
      console.log(`${r.table_name} -> ${r.data_type}`);
    }

    console.log("[migration] 005_schema_consistency applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 005_schema_consistency failed:", err.message);
  process.exit(1);
});