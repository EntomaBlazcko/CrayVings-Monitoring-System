// =============================================================================
// 025_timestamps_timestamptz.cjs - Convert the last 5 naive timestamp columns
//                                   (defect D5)
// Idempotent (safe to run repeatedly). Run:  node db/migrations/025_timestamps_timestamptz.cjs
//
// WHY: these five columns are still `timestamp without time zone`
// (verified live 2026-10-18 - the defect list previously said 7; the other
// naive timestamps were already converted by 005/007/016):
//   users.created_at, users.updated_at,
//   sensor_settings.updated_at,
//   authorized_recipients.created_at, authorized_recipients.updated_at
//
// A naive column stores a wall-clock number with no zone, so the instant it
// represents depends on who looks at it. node-postgres parses a naive value
// as a Date in the SERVER PROCESS'S local zone. The conversion therefore
// interprets stored values in the process zone (Intl ... timeZone), not the
// database session's TimeZone - that is what makes the converted instants
// display-identical to what every API response has always shown, regardless
// of how the DB cluster is configured. The chosen zone is printed before any
// DDL runs so the operator can confirm it matches the server host.
//
// SAFETY:
//   - A backup is REQUIRED before running (see TESTING_GUIDE): ALTER TYPE
//     rewrites the table under an ACCESS EXCLUSIVE lock. All three tables
//     are tiny (users/accounts, one settings row, a handful of recipients),
//     so the lock lasts milliseconds - still run at low traffic.
//   - Defaults: CURRENT_TIMESTAMP stays valid across the type change.
//   - Re-runs skip columns that are already timezone-aware.
//   - Any OTHER naive timestamp column still hiding in the schema is printed
//     as a warning and left untouched.
//
// ROLLBACK (previous state; use the zone printed by the run - replace ZONE):
//   ALTER TABLE users ALTER COLUMN created_at TYPE TIMESTAMP
//     USING created_at AT TIME ZONE 'ZONE';
//   ALTER TABLE users ALTER COLUMN updated_at TYPE TIMESTAMP
//     USING updated_at AT TIME ZONE 'ZONE';
//   ALTER TABLE sensor_settings ALTER COLUMN updated_at TYPE TIMESTAMP
//     USING updated_at AT TIME ZONE 'ZONE';
//   ALTER TABLE authorized_recipients ALTER COLUMN created_at TYPE TIMESTAMP
//     USING created_at AT TIME ZONE 'ZONE';
//   ALTER TABLE authorized_recipients ALTER COLUMN updated_at TYPE TIMESTAMP
//     USING updated_at AT TIME ZONE 'ZONE';
// The round-trip is lossless: the same zone is used in both directions.
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

// The five conversion targets, in dependency-friendly (smallest first) order.
const TARGETS = [
  { table: "sensor_settings", column: "updated_at" },
  { table: "authorized_recipients", column: "created_at" },
  { table: "authorized_recipients", column: "updated_at" },
  { table: "users", column: "created_at" },
  { table: "users", column: "updated_at" },
];

(async () => {
  const client = await pool.connect();
  try {
    // ---- 0. zone selection (before any DDL, before BEGIN) --------------------
    // node-postgres renders naive timestamps in the process zone; converting
    // with that same zone keeps every stored wall-clock reading displayed
    // exactly as before.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || !/^[A-Za-z0-9_+/-]+$/i.test(zone)) {
      throw new Error(`unusable process time zone: ${JSON.stringify(zone)}`);
    }
    const session = await client.query(`SHOW TimeZone`);
    console.log(`process time zone -> ${zone}`);
    console.log(`session time zone -> ${session.rows[0].TimeZone}`);

    await client.query("BEGIN");

    // ---- 1. preflight: what is naive right now? ------------------------------
    const naive = await client.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type = 'timestamp without time zone'
      ORDER BY table_name, column_name
    `);
    const targetSet = new Set(TARGETS.map((t) => `${t.table}.${t.column}`));
    console.log("naive timestamp columns found ->",
      naive.rows.map((r) => `${r.table_name}.${r.column_name}`).join(", ") || "(none)");
    for (const r of naive.rows) {
      if (!targetSet.has(`${r.table_name}.${r.column_name}`)) {
        console.warn(`  WARNING: ${r.table_name}.${r.column_name} is naive but not in this migration's target list - left untouched`);
      }
    }

    // ---- 2. convert each still-naive target ----------------------------------
    let converted = 0;
    for (const { table, column } of TARGETS) {
      const col = await client.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      if (col.rows.length === 0) {
        console.warn(`  WARNING: ${table}.${column} does not exist - skipped`);
        continue;
      }
      if (col.rows[0].data_type === "timestamp without time zone") {
        // Zone is validated above against a strict charset and embedded as a
        // SQL literal: ALTER ... USING does not accept bind parameters.
        await client.query(
          `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TIMESTAMPTZ
             USING ${column} AT TIME ZONE '${zone}'`
        );
        converted++;
        console.log(`  converted ${table}.${column}`);
      } else {
        console.log(`  ${table}.${column} already timezone-aware - skipped`);
      }
    }

    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('025', 'timestamps_timestamptz')
       ON CONFLICT (version) DO NOTHING`
    );

    await client.query("COMMIT");

    // ---- verification report ---------------------------------------------------
    const still = await client.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type = 'timestamp without time zone'
      ORDER BY table_name, column_name
    `);
    console.log(`columns converted this run -> ${converted}`);
    console.log("remaining naive columns ->",
      still.rows.map((r) => `${r.table_name}.${r.column_name}`).join(", ") || "(none)");
    const sample = await client.query(
      `SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM users`
    );
    console.log(`users.created_at range -> ${sample.rows[0].oldest} .. ${sample.rows[0].newest}`);

    console.log("[migration] 025_timestamps_timestamptz applied");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migration] 025_timestamps_timestamptz failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
