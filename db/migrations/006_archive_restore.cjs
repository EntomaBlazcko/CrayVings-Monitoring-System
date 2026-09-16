// =============================================================================
// 006_archive_restore.cjs - Soft-delete (archive) + restore support
// Idempotent (safe to run repeatedly). Run:  node db/migrations/006_archive_restore.cjs
//
// Turns the previous HARD deletes into soft archives so admins can restore:
//   1. users
//        - Existing `status`/`deleted_at` columns are reused: a deleted account
//          becomes status='archived', deleted_at=NOW() instead of being removed.
//        - The full-column UNIQUE constraints on users.username / users.email are
//          replaced with PARTIAL unique indexes restricted to non-archived rows.
//          That way a new active account can reuse a dead username/email, and a
//          restore only fails if the identity is taken by a LIVE row.
//   2. authorized_recipients
//        - Adds `archived_at TIMESTAMPTZ` (NULL = active). Archive sets it;
//          restore clears it.
//        - The phone_number UNIQUE constraint becomes a PARTIAL unique index
//          (WHERE archived_at IS NULL) so archived numbers don't block re-adds.
//
// Archiving is reversible; nothing in this migration deletes data.
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

// Drop every UNIQUE constraint that references `columnName` on `tableName`
// (finding names dynamically so we don't depend on PG's auto-generated names).
async function dropUniqueConstraints(client, tableName, columnName) {
  const result = await client.query(
    `SELECT tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
      WHERE tc.table_name = $1
        AND tc.constraint_type = 'UNIQUE'
        AND kcu.column_name = $2
      GROUP BY tc.constraint_name`,
    [tableName, columnName]
  );
  for (const row of result.rows) {
    await client.query(
      `ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${row.constraint_name} CASCADE`
    );
    console.log(`[migration] dropped UNIQUE constraint ${row.constraint_name} on ${tableName}.${columnName}`);
  }
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- 1. users: replace full-column UNIQUE with partial (active-only) ----
    await dropUniqueConstraints(client, "users", "username");
    await dropUniqueConstraints(client, "users", "email");
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_active
         ON users (username) WHERE status IS DISTINCT FROM 'archived'`
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_active
         ON users (email) WHERE status IS DISTINCT FROM 'archived'`
    );

    // ---- 2. authorized_recipients: archived_at column + partial unique -------
    await client.query(
      `ALTER TABLE authorized_recipients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_recipients_archived_at ON authorized_recipients (archived_at)`
    );
    await dropUniqueConstraints(client, "authorized_recipients", "phone_number");
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_recipients_phone_active
         ON authorized_recipients (phone_number) WHERE archived_at IS NULL`
    );

    await client.query("COMMIT");

    // ---- verification report --------------------------------------------------
    const userIdx = await client.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'users'
        AND indexname IN ('idx_users_username_active','idx_users_email_active')
        ORDER BY indexname`
    );
    console.log("users partial indexes ->", userIdx.rows.map((r) => r.indexname).join(", "));

    const recipCol = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'authorized_recipients' AND column_name = 'archived_at'`
    );
    console.log("authorized_recipients.archived_at ->", recipCol.rows[0]?.data_type ?? "MISSING");

    const recipIdx = await client.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'authorized_recipients'
        AND indexname = 'idx_recipients_phone_active'`
    );
    console.log("authorized_recipients partial unique index ->", recipIdx.rows[0]?.indexname ?? "MISSING");

    const userUniq = await client.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.table_constraints
        WHERE table_name = 'users' AND constraint_type = 'UNIQUE'
        AND constraint_name IN ('users_username_key','users_email_key')`
    );
    console.log("legacy users UNIQUE constraints remaining ->", userUniq.rows[0].n);

    console.log("[migration] 006_archive_restore applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 006_archive_restore failed:", err.message);
  process.exit(1);
});