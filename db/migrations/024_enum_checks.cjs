// =============================================================================
// 024_enum_checks.cjs - Bound the status/role/key enums, fix case drift
//                         (defects D3 + D4)
// Idempotent (safe to run repeatedly). Run:  node db/migrations/024_enum_checks.cjs
//
// WHY (D3): six "enum" columns are free-form VARCHAR with no CHECK, so a
// typo in any future code path stores silently and every
// status = 'admin'-style filter misses it:
//   users.role, users.status, last_alerts.status, last_alerts.sensor_key,
//   sms_logs.status, user_deletion_requests.status
// The value sets below were verified against the code on 2026-10-18:
//   users.role                  -> 'admin' | 'user'
//     ("owner" is NEVER stored - isOwnerUser() derives it at runtime from the
//      OWNER_USERNAME / OWNER_EMAIL env vars; migration 002 seeds role
//     'admin'; the UI and every test suite use only 'user' / 'admin')
//   users.status                -> 'active' | 'pending_deletion' | 'deleted' | 'archived'
//     ('deleted' is legacy but must keep passing for old rows)
//   last_alerts.status          -> 'good' | 'warning' | 'critical' (NULL allowed)
//   last_alerts.sensor_key      -> 'Temperature' | 'Water Level' | 'Ammonia'
//     (the three hard-coded sensorChecks keys in server.cjs)
//   sms_logs.status             -> 'queued' | 'delivered' | 'failed' | 'capped'
//   user_deletion_requests.status -> 'PENDING_OTP' | 'EXPIRED' | 'COMPLETED'
//
// WHY (D4): user_deletion_requests.status is the one enum that DRIFTED IN
// CASE. The column default is 'pending_otp' (lowercase, migration 001) but
// every write and compare in server.cjs uses UPPERCASE ('PENDING_OTP',
// 'EXPIRED', 'COMPLETED'), so a row left on the default is invisible to
// "fetch the pending request" queries. The default is corrected to
// 'PENDING_OTP' and existing values upper-cased. Meaning is preserved: no
// code path has ever read the lowercase spelling.
//
// SAFETY: every value set is checked FIRST; the migration aborts (rolling
// back everything) if any row holds an unexpected value, printing the
// offenders so they can be fixed by hand. Nothing is deleted or truncated.
//
// ROLLBACK (previous state; the upper-casing of user_deletion_requests.status
// is intentionally NOT reverted - the app has never consumed the lowercase
// values, so reverting would only reintroduce the invisibility):
//   ALTER TABLE users DROP CONSTRAINT chk_users_role;
//   ALTER TABLE users DROP CONSTRAINT chk_users_status;
//   ALTER TABLE last_alerts DROP CONSTRAINT chk_lastalerts_status;
//   ALTER TABLE last_alerts DROP CONSTRAINT chk_lastalerts_sensor_key;
//   ALTER TABLE sms_logs DROP CONSTRAINT chk_sms_logs_status;
//   ALTER TABLE user_deletion_requests DROP CONSTRAINT chk_deletion_requests_status;
//   ALTER TABLE user_deletion_requests ALTER COLUMN status SET DEFAULT 'pending_otp';
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

// One preflight shape: list the distinct offending values for a column.
async function offenders(client, label, sql) {
  const res = await client.query(sql);
  if (res.rows.length > 0) {
    const detail = res.rows
      .map((r) => `${r.v === null ? "NULL" : `'${r.v}'`} (x${r.n})`)
      .join(", ");
    console.error(`  VIOLATION ${label}: ${detail}`);
  }
  return res.rows.length;
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- 1. preflight: print + collect every unexpected value ----------------
    console.log("preflight distinct values:");
    for (const [label, sql] of [
      ["users.role", `SELECT role AS v, COUNT(*)::int AS n FROM users GROUP BY role ORDER BY role`],
      ["users.status", `SELECT status AS v, COUNT(*)::int AS n FROM users GROUP BY status ORDER BY status`],
      ["last_alerts.status", `SELECT status AS v, COUNT(*)::int AS n FROM last_alerts GROUP BY status ORDER BY status`],
      ["last_alerts.sensor_key", `SELECT sensor_key AS v, COUNT(*)::int AS n FROM last_alerts GROUP BY sensor_key ORDER BY sensor_key`],
      ["sms_logs.status", `SELECT status AS v, COUNT(*)::int AS n FROM sms_logs GROUP BY status ORDER BY status`],
      ["user_deletion_requests.status", `SELECT status AS v, COUNT(*)::int AS n FROM user_deletion_requests GROUP BY status ORDER BY status`],
    ]) {
      const res = await client.query(sql);
      console.log(`  ${label} -> ${res.rows.map((r) => `${r.v === null ? "NULL" : `'${r.v}'`} (x${r.n})`).join(", ") || "(table empty)"}`);
    }

    let bad = 0;
    bad += await offenders(client, "users.role", `
      SELECT role AS v, COUNT(*)::int AS n FROM users
      WHERE role IS NULL OR role NOT IN ('admin', 'user') GROUP BY role`);
    bad += await offenders(client, "users.status", `
      SELECT status AS v, COUNT(*)::int AS n FROM users
      WHERE status IS NULL OR status NOT IN ('active', 'pending_deletion', 'deleted', 'archived')
      GROUP BY status`);
    // NULL last_alerts.status is legal (no alert state recorded) - only
    // non-NULL values must be one of the three threshold states.
    bad += await offenders(client, "last_alerts.status", `
      SELECT status AS v, COUNT(*)::int AS n FROM last_alerts
      WHERE status IS NOT NULL AND status NOT IN ('good', 'warning', 'critical')
      GROUP BY status`);
    bad += await offenders(client, "last_alerts.sensor_key", `
      SELECT sensor_key AS v, COUNT(*)::int AS n FROM last_alerts
      WHERE sensor_key IS NULL OR sensor_key NOT IN ('Temperature', 'Water Level', 'Ammonia')
      GROUP BY sensor_key`);
    bad += await offenders(client, "sms_logs.status", `
      SELECT status AS v, COUNT(*)::int AS n FROM sms_logs
      WHERE status IS NULL OR status NOT IN ('queued', 'delivered', 'failed', 'capped')
      GROUP BY status`);
    // Deletion-request status may arrive in either case until the UPDATE
    // below normalizes it; both spellings of the three states are accepted.
    bad += await offenders(client, "user_deletion_requests.status", `
      SELECT status AS v, COUNT(*)::int AS n FROM user_deletion_requests
      WHERE status IS NULL
         OR UPPER(status) NOT IN ('PENDING_OTP', 'EXPIRED', 'COMPLETED')
      GROUP BY status`);
    if (bad > 0) {
      throw new Error(`${bad} column value set(s) hold unexpected values (see VIOLATION lines above) - fix the data, then re-run`);
    }

    // ---- 2. D4: normalize case + correct the default -------------------------
    const normalized = await client.query(
      `UPDATE user_deletion_requests SET status = UPPER(status)
        WHERE status IS DISTINCT FROM UPPER(status)`
    );
    console.log(`  upper-cased user_deletion_requests.status on ${normalized.rowCount} row(s)`);
    await client.query(
      `ALTER TABLE user_deletion_requests ALTER COLUMN status SET DEFAULT 'PENDING_OTP'`
    );

    // ---- 3. D3: the CHECK constraints (guarded, house DO-block pattern) ------
    for (const [conname, table, check] of [
      ["chk_users_role", "users", `role IN ('admin', 'user')`],
      ["chk_users_status", "users", `status IN ('active', 'pending_deletion', 'deleted', 'archived')`],
      ["chk_lastalerts_status", "last_alerts", `status IS NULL OR status IN ('good', 'warning', 'critical')`],
      ["chk_lastalerts_sensor_key", "last_alerts", `sensor_key IN ('Temperature', 'Water Level', 'Ammonia')`],
      ["chk_sms_logs_status", "sms_logs", `status IS NULL OR status IN ('queued', 'delivered', 'failed', 'capped')`],
      ["chk_deletion_requests_status", "user_deletion_requests", `status IN ('PENDING_OTP', 'EXPIRED', 'COMPLETED')`],
    ]) {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = '${conname}'
              AND conrelid = '${table}'::regclass
          ) THEN
            ALTER TABLE ${table}
              ADD CONSTRAINT ${conname}
              CHECK (${check});
            RAISE NOTICE 'Added ${conname}';
          END IF;
        END $$;
      `);
    }

    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('024', 'enum_checks')
       ON CONFLICT (version) DO NOTHING`
    );

    await client.query("COMMIT");

    // ---- verification report ---------------------------------------------------
    const cons = await client.query(`
      SELECT conrelid::regclass::text AS table_name, conname
      FROM pg_constraint
      WHERE conname IN ('chk_users_role','chk_users_status','chk_lastalerts_status',
                        'chk_lastalerts_sensor_key','chk_sms_logs_status',
                        'chk_deletion_requests_status')
      ORDER BY table_name, conname
    `);
    console.log("enum CHECK constraints ->", cons.rows.map((r) => `${r.table_name}.${r.conname}`).join(", ") || "NONE");
    const def = await client.query(`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'user_deletion_requests' AND column_name = 'status'
    `);
    console.log("user_deletion_requests.status default ->", def.rows[0]?.column_default ?? "(none)");

    console.log("[migration] 024_enum_checks applied");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migration] 024_enum_checks failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
