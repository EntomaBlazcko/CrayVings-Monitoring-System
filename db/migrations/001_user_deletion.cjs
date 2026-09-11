// =============================================================================
// 001_user_deletion.cjs - Secure account deletion supporting schema
// Idempotent (safe to run repeatedly). Run:  node db/migrations/001_user_deletion.cjs
//
// What this adds and why (audit-first design):
//   1. users soft-delete columns -> enables the PENDING -> APPROVED
//      hold so the account can keep authenticating until deletion is approved
//      and only then hard-deleted (requester keeps working day-to-day).
//   2. user_deletion_requests -> the audit chain: WHO requested, WHO was the
//      OTP sent to, WHO verified, WHO approved, WHO executed — with timestamps
//      at each stage. Drives feature 1's "audit log of who requested/approved/
//      executed".
//   3. email_otps -> delivery + second-factor store for the deletion OTP.
//      The code is HASHED (SHA-256 with a per-row salt), never stored in
//      plaintext; expires after 10 minutes; capped at 5 attempts to resist
//      brute force. No FK to users so it still works for an account already
//      marked pending (and is trivially purgeable when the request completes).
//   4. activity_logs.user_name -> made NULLABLE and the FK REPLACED with
//      ON DELETE SET NULL. Today that FK is RESTRICT (verified against the
//      live information_schema), which makes "DELETE FROM users" FAIL as soon
//      as a user has any audit rows. With SET NULL the audit row is preserved
//      (description/module/timestamp all kept) but decoupled from the deleted
//      account, so the hard delete succeeds AND the audit trail survives.
//
// -----------------------------------------------------------------------------
// AFTER running this once, ALSO run its sibling:
//     node db/migrations/002_activity_log_secrets.cjs
// only if you want the "no more forgeable 'admin' fallback" hardening
// (it flips activity-log ingestion + audit-write endpoints to auth-only).
// -----------------------------------------------------------------------------
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

    // ---- 1. users soft-delete columns ----------------------------------------
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'`
    );
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE`
    );
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_deletion_at TIMESTAMP WITH TIME ZONE`
    );
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_deletion_requested_by VARCHAR(100)`
    );
    // Normalise any pre-existing weirdness (empty string, NULL) back to 'active'
    await client.query(
      `UPDATE users SET status = 'active'
        WHERE status IS NULL OR status = '' OR status NOT IN ('active','pending_deletion')`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_users_status ON users (status)`
    );

    // ---- 2. user_deletion_requests audit chain --------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_deletion_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        user_username VARCHAR(100) NOT NULL,
        requester_username VARCHAR(100) NOT NULL,
        requester_email VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending_otp',
        reason TEXT,
        otp_hash VARCHAR(64),
        otp_salt VARCHAR(32),
        otp_expires_at TIMESTAMP WITH TIME ZONE,
        otp_attempts INTEGER NOT NULL DEFAULT 0,
        otp_verified_at TIMESTAMP WITH TIME ZONE,
        otp_verified_by VARCHAR(100),
        requested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        approver VARCHAR(100),
        approved_at TIMESTAMP WITH TIME ZONE,
        executed_by VARCHAR(100),
        executed_at TIMESTAMP WITH TIME ZONE,
        status_history JSONB NOT NULL DEFAULT '[]'::JSONB
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_deletion_requests_status ON user_deletion_requests (status)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_deletion_requests_user ON user_deletion_requests (user_id)`
    );

    // ---- 3. email_otps (second factor) ---------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_otps (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        code_hash VARCHAR(64) NOT NULL,
        code_salt VARCHAR(32) NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        used_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps (email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_email_otps_expires ON email_otps (expires_at)`);

    // ---- 4. relax activity_logs FK (RESTRICT -> SET NULL) --------------------
    // Find the actual auto-generated constraint name so we can drop + re-add.
    const fkResult = await client.query(
      `SELECT tc.constraint_name
         FROM information_schema.table_constraints tc
        WHERE tc.table_name = 'activity_logs'
          AND tc.constraint_type = 'FOREIGN KEY'`
    );
    for (const row of fkResult.rows) {
      const constraintName = row.constraint_name;
      // Only touch the FK that references users (there is one FK on the table;
      // guard anyway so future FKs don't get clobbered)
      const refResult = await client.query(
        `SELECT ccu.table_name AS ref_table
           FROM information_schema.constraint_column_usage ccu
          WHERE ccu.constraint_name = $1`,
        [constraintName]
      );
      if (refResult.rows.some((r) => r.ref_table === "users")) {
        await client.query(
          `ALTER TABLE activity_logs DROP CONSTRAINT IF EXISTS ${constraintName}`
        );
        await client.query(
          `ALTER TABLE activity_logs
             ADD CONSTRAINT activity_logs_user_name_fkey
             FOREIGN KEY (user_name) REFERENCES users (username)
             ON DELETE SET NULL`
        );
      }
    }
    // Make the column nullable so SET NULL can actually null it out.
    await client.query(
      `ALTER TABLE activity_logs ALTER COLUMN user_name DROP NOT NULL`
    );

    // ---- 5. keep the deletion-service API key (for audit users' SIGHUP?) ------
    // (No-op placeholder replaced below; see 002_activity_log_secrets for the
    //  service-token endpoints.)

    await client.query("COMMIT");

    // ---- verification (idempotent-safety report) -----------------------------
    const check = await client.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'activity_logs' AND column_name = 'user_name'`
    );
    console.log(
      "activity_logs.user_name is_nullable ->",
      check.rows[0]?.is_nullable ?? "MISSING"
    );
    const delRule = await client.query(
      `SELECT rc.delete_rule FROM information_schema.referential_constraints rc
        WHERE rc.constraint_name = 'activity_logs_user_name_fkey'`
    );
    console.log(
      "activity_logs FK delete_rule ->",
      delRule.rows[0]?.delete_rule ?? "MISSING (not yet re-added)"
    );

    console.log("[migration] 001_user_deletion applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 001_user_deletion failed:", err.message);
  process.exit(1);
});
