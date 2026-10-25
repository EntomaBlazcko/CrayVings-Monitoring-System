// =============================================================================
// 023_sensor_settings_singleton.cjs - Enforce the one-row invariant (defect D2)
// Idempotent (safe to run repeatedly). Run:  node db/migrations/023_sensor_settings_singleton.cjs
//
// WHY: sensor_settings is a singleton by convention only. Every read does
// SELECT * FROM sensor_settings LIMIT 1 (no ORDER BY), and server.cjs has two
// INSERT sites (PUT /settings and POST /settings/reset) that fire when the
// table is empty - they never supplied an id, so the SERIAL sequence decided
// it. After any delete the sequence's next value is 2, 3, ... and the next
// "empty-table" save silently creates a SECOND row. From then on LIMIT 1
// returns whichever row the planner likes, thresholds flap between values,
// and the singleton fiction is gone.
//
// WHAT THIS DOES (all inside one transaction):
//   1. Aborts loudly if more than one row exists - that is pre-existing data
//      corruption this migration will not guess how to merge.
//   2. Rewrites the surviving row's id to 1 (nothing references
//      sensor_settings, so a PK rewrite is free of FK consequences).
//   3. Resets the sequence so the next nextval() is deterministic.
//   4. Adds CHECK (id = 1): every insert is forced onto the one legal id.
//
// PAIRED CODE CHANGE (server.cjs): both sensor_settings INSERTs now supply
// id = 1 explicitly and use ON CONFLICT (id) DO UPDATE, so the constraint
// can never fire in normal operation - it is the backstop, not the mechanism.
// The migration alone is already safe: with the sequence reset, even the old
// code's first empty-table insert lands on id = 1.
//
// ROLLBACK:
//   ALTER TABLE sensor_settings DROP CONSTRAINT chk_sensor_settings_singleton;
//   (the renumbered id stays 1 - values are preserved, only the original
//   surrogate numbering is unrecoverable, and nothing depends on it)
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

    // ---- 1. preflight: the table must hold zero or one row -------------------
    const rows = await client.query(`SELECT id, temp_min, temp_max FROM sensor_settings ORDER BY id`);
    if (rows.rows.length > 1) {
      throw new Error(
        `sensor_settings holds ${rows.rows.length} rows (ids: ${rows.rows
          .map((r) => r.id)
          .join(", ")}) - refusing to pick a winner. ` +
          `Keep the correct row, delete the rest manually, then re-run.`
      );
    }

    // ---- 2. normalize the survivor onto id = 1 -------------------------------
    if (rows.rows.length === 1 && rows.rows[0].id !== 1) {
      const oldId = rows.rows[0].id;
      await client.query(`UPDATE sensor_settings SET id = 1 WHERE id = $1`, [oldId]);
      console.log(`  renumbered sensor_settings row ${oldId} -> 1`);
    }

    // ---- 3. deterministic sequence: next nextval() = 1 -----------------------
    // is_called = false so the first nextval() after this returns 1 even on an
    // empty table; with a row already at id = 1, a stray sequence-based insert
    // collides and is absorbed by the ON CONFLICT clause in server.cjs.
    await client.query(
      `SELECT setval(pg_get_serial_sequence('sensor_settings', 'id'), 1, false)`
    );

    // ---- 4. the invariant itself (guarded, house DO-block pattern) -----------
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_sensor_settings_singleton'
            AND conrelid = 'sensor_settings'::regclass
        ) THEN
          ALTER TABLE sensor_settings
            ADD CONSTRAINT chk_sensor_settings_singleton
            CHECK (id = 1);
          RAISE NOTICE 'Added chk_sensor_settings_singleton';
        END IF;
      END $$;
    `);

    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('023', 'sensor_settings_singleton')
       ON CONFLICT (version) DO NOTHING`
    );

    await client.query("COMMIT");

    // ---- verification report ---------------------------------------------------
    const state = await client.query(`SELECT id FROM sensor_settings ORDER BY id`);
    console.log("sensor_settings ids ->", state.rows.map((r) => r.id).join(", ") || "(empty)");
    const seq = await client.query(
      `SELECT last_value, is_called FROM ${await seqName(client)}`
    );
    console.log(`sequence -> last_value=${seq.rows[0].last_value} is_called=${seq.rows[0].is_called}`);
    const con = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conname = 'chk_sensor_settings_singleton' AND conrelid = 'sensor_settings'::regclass`
    );
    console.log("constraint ->", con.rows[0]?.conname ?? "MISSING");

    console.log("[migration] 023_sensor_settings_singleton applied");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migration] 023_sensor_settings_singleton failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();

// pg_get_serial_sequence returns an unqualified name; quote it safely for the
// verification SELECT.
async function seqName(client) {
  const r = await client.query(`SELECT pg_get_serial_sequence('sensor_settings', 'id') AS seq`);
  return `"${r.rows[0].seq.replace(/^.*\./, "")}"`;
}
