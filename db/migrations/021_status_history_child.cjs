// =============================================================================
// 021_status_history_child.cjs - user_deletion_requests.status_history (JSONB)
//                                becomes a real child table
// Idempotent (safe to run repeatedly). Run:  node db/migrations/021_status_history_child.cjs
//
//   Migration 001 stored the deletion flow's state log as a JSONB array inside
//   the parent row: one {"from","to","by","at"} object appended per transition.
//   That shape has three problems:
//
//     1. It is invisible to the relational model - no FK, no index into the
//        entries, no way to join a transition to the account that recorded it,
//        and an ERD cannot draw it. The capstone diagram models this history
//        as a proper child table, and the table it names did not exist.
//     2. The log grows inside the parent row, so every read of the request
//        drags every transition along with it.
//     3. Nothing at the database level constrains an entry's shape; a typo'd
//        key silently disappears from the log instead of failing loudly.
//
//   This migration creates user_deletion_request_status_history as the table
//   the ERD describes, relocates every entry into it, then drops the JSONB
//   column. Relocation, not deletion: backfill and DROP run in the same
//   transaction, so the data is either moved intact or nothing changes.
//
//   Column mapping: status = the 'to' state of the transition (the 'from'
//   state is deliberately NOT stored - it is the previous row's status, and
//   duplicating it per row only invites the two copies to disagree later),
//   recorded_by = 'by', recorded_at = 'at' (guarded: entries whose 'at' is not
//   parseable fall back to the request's requested_at rather than failing the
//   whole migration). Entries that are not objects, or carry no 'to', cannot
//   be represented in a NOT NULL status column - they are skipped and counted
//   in the report instead of inventing a state.
//
//   Ordering: WITH ORDINALITY + ORDER BY preserves the array's order, so ids
//   read chronologically (the id sequence is consumed in that order).
//
//   ON DELETE CASCADE: when a request row is removed - server.cjs deletes a
//   just-created request if the OTP email fails, treating it as never
//   happened - its history rows go with it, which is the same verdict.
//
//   DEPLOY NOTE: server.cjs still writes status_history at request creation
//   and completion until the matching code change in this same release.
//   Restart the backend promptly after running this migration - the old
//   INSERT names the dropped column and will fail.
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

    // ---- 1. The child table ----------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_deletion_request_status_history (
        id           SERIAL PRIMARY KEY,
        request_id   INTEGER NOT NULL REFERENCES user_deletion_requests(id) ON DELETE CASCADE,
        status       VARCHAR(20) NOT NULL,
        recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        recorded_by  VARCHAR(100)
      )
    `);

    await client.query(`
      COMMENT ON TABLE user_deletion_request_status_history IS
        'State transitions of user_deletion_requests, one row per transition. status = the state entered. Replaces migration 001''s status_history JSONB column (dropped below after relocation).'
    `);

    // Serves both the FK's RI probes and the natural "history for this
    // request" read; request_id is NOT NULL, so no partial predicate.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_deletion_status_history_request
        ON user_deletion_request_status_history (request_id)
    `);

    // ---- 2. Relocate, then drop -------------------------------------------
    // Column-existence check makes the whole migration re-runnable: on a
    // completed run there is nothing left to copy, and the verification query
    // below must not reference a column that is gone.
    const col = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'user_deletion_requests' AND column_name = 'status_history'
    `);

    if (col.rows.length > 0) {
      const expected = await client.query(`
        SELECT COUNT(*) AS n
          FROM user_deletion_requests r
               CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.status_history, '[]'::jsonb)) e
         WHERE jsonb_typeof(e) = 'object'
           AND e->>'to' IS NOT NULL
      `);

      const migrated = await client.query(`
        INSERT INTO user_deletion_request_status_history
          (request_id, status, recorded_at, recorded_by)
        SELECT r.id,
               e.entry->>'to',
               COALESCE(
                 CASE WHEN e.entry->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}[T ]'
                      THEN (e.entry->>'at')::TIMESTAMPTZ END,
                 r.requested_at,
                 NOW()
               ),
               e.entry->>'by'
          FROM user_deletion_requests r
               CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.status_history, '[]'::jsonb))
                     WITH ORDINALITY AS e(entry, ord)
         WHERE jsonb_typeof(e.entry) = 'object'
           AND e.entry->>'to' IS NOT NULL
           AND NOT EXISTS (
                 SELECT 1 FROM user_deletion_request_status_history h
                  WHERE h.request_id = r.id
               )
         ORDER BY r.id, e.ord
      `);

      console.log(`[migration] 021 relocated ${migrated.rowCount} of ${expected.rows[0].n} JSONB entry/entries`);

      // The column is redundant the moment the rows above exist. Dropping it
      // in the same transaction as the copy is what makes this a move.
      await client.query(`
        ALTER TABLE user_deletion_requests DROP COLUMN IF EXISTS status_history
      `);
    } else {
      console.log("[migration] 021 status_history column already dropped - nothing to relocate");
    }

    // ---- 3. Record the migration ------------------------------------------
    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('021', 'status_history_child')
       ON CONFLICT (version) DO NOTHING`,
    );

    await client.query("COMMIT");

    // ---- verification report ------------------------------------------------
    const schema = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'user_deletion_request_status_history'
        ORDER BY ordinal_position`,
    );
    console.log("user_deletion_request_status_history ->");
    for (const r of schema.rows) {
      console.log(`  ${r.column_name}  ${r.data_type}  nullable=${r.is_nullable}`);
    }

    const fk = await client.query(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conrelid = 'user_deletion_request_status_history'::regclass
          AND contype = 'f'`,
    );
    for (const r of fk.rows) {
      console.log(`constraint -> ${r.conname} (delete rule: ${r.confdeltype === 'c' ? 'CASCADE' : r.confdeltype})`);
    }

    const counts = await client.query(`
      SELECT (SELECT COUNT(*) FROM user_deletion_requests)                       AS requests,
             (SELECT COUNT(*) FROM user_deletion_request_status_history)         AS history_rows
    `);
    console.log(`${counts.rows[0].requests} deletion request(s), ${counts.rows[0].history_rows} history row(s)`);

    console.log("[migration] 021_status_history_child applied (restart the backend before the next deletion flow use)");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 021_status_history_child failed:", err.message);
  process.exit(1);
});
