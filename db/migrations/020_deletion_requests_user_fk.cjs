// =============================================================================
// 020_deletion_requests_user_fk.cjs - FK from the deletion-request audit chain
//                                     to the account it is about
// Idempotent (safe to run repeatedly). Run:  node db/migrations/020_deletion_requests_user_fk.cjs
//
//   Migration 001 created user_deletion_requests with user_id NOT NULL and
//   deliberately no foreign key, because the table documents the hard delete
//   of that very account: once the purge runs (DELETE FROM users), an FK
//   target would be gone and every later write or cascade would fail. The
//   docs/DATABASE.md note said so explicitly - "user_deletion_requests ...
//   deliberately define no foreign key constraints so the request/OTP
//   pipeline still works after the target account is hard-deleted."
//
//   ON DELETE SET NULL resolves that paradox rather than avoiding it: when
//   the account is purged, user_id becomes NULL and user_username (NOT NULL,
//   written at request time) keeps the name forever. The audit chain stays
//   complete - WHO requested, WHO verified, WHO executed - while the reference
//   honestly records that the account itself no longer exists. NULL here has
//   the same meaning as everywhere else in this database: gone, not zero.
//
//   DROP NOT NULL is therefore a prerequisite, not a side effect - SET NULL
//   cannot write into a NOT NULL column, and with the column left NOT NULL
//   the purge this flow itself performs would violate the FK we are adding.
//
//   Orphan repair runs first so accounts purged *before* this migration (the
//   reason 001 could not add the FK in the first place) are grandfathered
//   instead of blocking validation. Those rows keep user_username; only the
//   unresolvable id is cleared.
//
//   Existing index idx_deletion_requests_user (user_id) from migration 001
//   already serves the FK's referential-integrity probes - no new index.
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

    // ---- 1. Nullable, so SET NULL can ever fire ---------------------------
    // DROP NOT NULL on an already-nullable column is a no-op, so re-running
    // after a half-completed attempt is safe.
    await client.query(`
      ALTER TABLE user_deletion_requests
        ALTER COLUMN user_id DROP NOT NULL
    `);

    await client.query(`
      COMMENT ON COLUMN user_deletion_requests.user_id IS
        'FK to users.id of the account being deleted. NULL after the target account is hard-deleted; user_username preserves the name either way.'
    `);

    // ---- 2. Orphan repair -------------------------------------------------
    // Rows written before this migration can point at accounts that were
    // already purged - exactly the situation 001 anticipated. Clear those ids
    // so the constraint below validates; user_username is untouched.
    const repaired = await client.query(`
      UPDATE user_deletion_requests
         SET user_id = NULL
       WHERE user_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = user_deletion_requests.user_id)
    `);
    if (repaired.rowCount > 0) {
      console.log(`[migration] 020 nulled ${repaired.rowCount} orphaned user_id value(s) (names kept in user_username)`);
    }

    // ---- 3. The foreign key ----------------------------------------------
    // pg_constraint guard instead of the unsupported ADD CONSTRAINT IF NOT
    // EXISTS - same pattern as migrations 018 and 019.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_deletion_requests_user'
        ) THEN
          ALTER TABLE user_deletion_requests
            ADD CONSTRAINT fk_user_deletion_requests_user
            FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE SET NULL;
          RAISE NOTICE 'Added fk_user_deletion_requests_user';
        END IF;
      END $$
    `);

    await client.query(`
      COMMENT ON CONSTRAINT fk_user_deletion_requests_user ON user_deletion_requests IS
        'Request -> target account. SET NULL so the flow can hard-delete the account it documents; user_username keeps the identity.'
    `);

    // ---- 4. Record the migration ------------------------------------------
    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('020', 'deletion_requests_user_fk')
       ON CONFLICT (version) DO NOTHING`,
    );

    await client.query("COMMIT");

    // ---- verification report ------------------------------------------------
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'user_deletion_requests' AND column_name = 'user_id'`,
    );
    console.log("user_deletion_requests.user_id ->");
    for (const r of cols.rows) {
      console.log(`  ${r.column_name}  ${r.data_type}  nullable=${r.is_nullable}`);
    }

    const fk = await client.query(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conname = 'fk_user_deletion_requests_user'`,
    );
    console.log(fk.rows.length > 0
      ? `constraint -> ${fk.rows[0].conname} (delete rule: ${fk.rows[0].confdeltype === 'n' ? 'SET NULL' : fk.rows[0].confdeltype})`
      : "constraint -> MISSING");

    const stats = await client.query(
      `SELECT COUNT(*) AS total,
              COUNT(user_id) AS linked,
              COUNT(*) - COUNT(user_id) AS unlinked
         FROM user_deletion_requests`,
    );
    console.log(`user_deletion_requests rows -> ${stats.rows[0].total} total, ${stats.rows[0].linked} linked to a live account, ${stats.rows[0].unlinked} unlinked (target purged)`);

    console.log("[migration] 020_deletion_requests_user_fk applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 020_deletion_requests_user_fk failed:", err.message);
  process.exit(1);
});
