// =============================================================================
// 019_activity_logs_user_id.cjs - a real foreign key from the audit trail to
//                                 the account that acted
// Idempotent (safe to run repeatedly). Run:  node db/migrations/019_activity_logs_user_id.cjs
//
//   The problem: activity_logs identifies its actor only by user_name, a bare
//   VARCHAR. Migrations 001 and 002 both tried to FK that column to
//   users.username and the constraint was later removed; it cannot be
//   re-created now for the structural reason documented in docs/DATABASE.md:
//   users.username's UNIQUE is the *partial* index idx_users_username_active
//   (WHERE status IS DISTINCT FROM 'archived'), and a foreign key may not
//   reference a partial index. The same wall blocked sms_logs.recipient_phone,
//   which migration 016 solved with a trigger - but a trigger here would only
//   validate the name, not link the row to an account.
//
//   The fix that actually works: link on users.id instead. A new nullable
//   user_id carries the reference; user_name stays as the human-readable
//   display string the UI already renders.
//
//   Why ON DELETE SET NULL: this is migration 001's original intent achieved
//   through the id rather than the name - purging an account must not delete
//   its audit rows, because "who did what" is exactly what the audit trail
//   exists to answer after a compromise. NULL user_id therefore means "actor
//   not resolvable to a surviving account" (never 0 - the house rule that a
//   missing value is NULL, not a sentinel).
//
//   The backfill is deliberately conservative. It links a historical row only
//   when BOTH hold:
//
//     1. Exactly one users row carries that username. Usernames are reusable
//        after archive (006) and after purge (no row survives at all), so two
//        rows sharing a name makes attribution a guess - and guessing wrong in
//        an audit trail is worse than an honest NULL.
//     2. The row was written no earlier than that account's created_at. A
//        purged predecessor leaves no row to detect, so the timestamp is the
//        only thing stopping old history from being adopted by a successor
//        who happens to reuse the name.
//
//   Timestamp comparison note: users.created_at is timezone-naive (written
//   before migration 016's TIMESTAMPTZ sweep), activity_logs.timestamp is
//   TIMESTAMPTZ. Casting the instant to naive in the session zone lines the
//   two up exactly the way CURRENT_TIMESTAMP was recorded into created_at.
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

    // ---- 1. The column ----------------------------------------------------
    // ADD COLUMN IF NOT EXISTS keeps this re-runnable on a database where an
    // earlier attempt half-completed.
    await client.query(`
      ALTER TABLE activity_logs
        ADD COLUMN IF NOT EXISTS user_id INTEGER
    `);

    await client.query(`
      COMMENT ON COLUMN activity_logs.user_id IS
        'FK to users.id of the acting account. NULL = actor no longer resolvable (purged account or written before migration 019). user_name remains the display string.'
    `);

    // ---- 2. Backfill ------------------------------------------------------
    // Two-part guard, explained in the header: unambiguous name AND written
    // after the account existed. Both conditions failing simply leaves NULL,
    // which is the correct answer rather than a skipped error.
    const backfilled = await client.query(`
      UPDATE activity_logs a
         SET user_id = u.id
        FROM users u
       WHERE a.user_id IS NULL
         AND a.user_name = u.username
         AND NOT EXISTS (
               SELECT 1 FROM users u2
                WHERE u2.username = a.user_name
                  AND u2.id <> u.id
             )
         AND (a.timestamp AT TIME ZONE current_setting('TimeZone')) >= u.created_at
    `);
    console.log(`[migration] 019 backfilled user_id on ${backfilled.rowCount} activity_logs rows`);

    // ---- 3. Repair before the constraint ----------------------------------
    // The backfill only ever assigns ids taken from a live join, so this is a
    // no-op on a healthy run. It exists so a re-run after somebody purged an
    // account in between cannot trip the FK validation below.
    const repaired = await client.query(`
      UPDATE activity_logs
         SET user_id = NULL
       WHERE user_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = activity_logs.user_id)
    `);
    if (repaired.rowCount > 0) {
      console.log(`[migration] 019 nulled ${repaired.rowCount} orphaned user_id value(s)`);
    }

    // ---- 4. Index ---------------------------------------------------------
    // Partial: NULL user_id rows are the unresolvable ones and are never
    // probed - the FK's RI lookup and any "activity by user" query both bind a
    // concrete id, so indexing NULLs would only grow the tree.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id
        ON activity_logs (user_id)
        WHERE user_id IS NOT NULL
    `);

    // ---- 5. The foreign key ----------------------------------------------
    // Guarded through pg_constraint rather than ADD CONSTRAINT IF NOT EXISTS,
    // which PostgreSQL does not support - same pattern as migration 018.
    // Backfill + repair guarantee no orphans, so the constraint validates in
    // one pass; no NOT VALID grandfathering is needed.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_activity_logs_user'
        ) THEN
          ALTER TABLE activity_logs
            ADD CONSTRAINT fk_activity_logs_user
            FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE SET NULL;
          RAISE NOTICE 'Added fk_activity_logs_user';
        END IF;
      END $$
    `);

    await client.query(`
      COMMENT ON CONSTRAINT fk_activity_logs_user ON activity_logs IS
        'Audit row -> acting account. SET NULL (not CASCADE) so purging an account keeps its audit history.'
    `);

    // ---- 6. Record the migration ------------------------------------------
    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('019', 'activity_logs_user_id')
       ON CONFLICT (version) DO NOTHING`,
    );

    await client.query("COMMIT");

    // ---- verification report ------------------------------------------------
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'activity_logs' AND column_name = 'user_id'`,
    );
    console.log("activity_logs.user_id ->");
    for (const r of cols.rows) {
      console.log(`  ${r.column_name}  ${r.data_type}  nullable=${r.is_nullable}`);
    }

    const fk = await client.query(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conname = 'fk_activity_logs_user'`,
    );
    console.log(fk.rows.length > 0
      ? `constraint -> ${fk.rows[0].conname} (delete rule: ${fk.rows[0].confdeltype === 'n' ? 'SET NULL' : fk.rows[0].confdeltype})`
      : "constraint -> MISSING");

    const stats = await client.query(
      `SELECT COUNT(*) AS total,
              COUNT(user_id) AS linked,
              COUNT(*) - COUNT(user_id) AS unlinked
         FROM activity_logs`,
    );
    console.log(`activity_logs rows -> ${stats.rows[0].total} total, ${stats.rows[0].linked} linked, ${stats.rows[0].unlinked} unlinked (NULL = actor unresolvable)`);

    console.log("[migration] 019_activity_logs_user_id applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 019_activity_logs_user_id failed:", err.message);
  process.exit(1);
});
