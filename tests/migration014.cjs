// =============================================================================
// tests/migration014.cjs - case-insensitive device_id uniqueness (audit D2)
// =============================================================================
// Run:  npm run test:migration
//
// The unique index on LOWER(device_id) is the only DB-level guarantee that two
// rows can never differ only by case. Migration 014 used to SKIP that index when
// it found pre-existing case-variant duplicates, print a console.error, and then
// still record version 014 in schema_migrations and exit 0 — so the runner saw
// a completed migration, never retried, and case-insensitive uniqueness stayed
// silently unenforced.
//
// These tests cover the three things that must never regress:
//   1. The happy path: the index exists AND is actually UNIQUE.
//   2. The blocked path: with duplicates present, no unique index is created and
//      the run reports incomplete.
//   3. The re-run path: once duplicates are gone, the unique index is built even
//      if a non-unique index already occupies the target name (the
//      CREATE ... IF NOT EXISTS trap).
//
// Everything that mutates schema/data runs inside a transaction that is rolled
// back, so the live database is never left altered.
// =============================================================================

require("dotenv").config();
const assert = require("assert");
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

const CI_INDEX = "idx_devices_device_id_ci";
const FOLDED_INDEX = "idx_devices_device_id_folded";

let checks = 0;
let failures = 0;

function check(name, cond, extra = "") {
  checks++;
  if (cond) console.log(`PASS  ${name}${extra ? "  -> " + extra : ""}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${extra ? "  -> " + extra : ""}`);
  }
}

// Looks up a devices index and reports whether it is present and whether it is
// UNIQUE. pg_indexes alone cannot answer the second question, which is exactly
// the gap that let a non-unique index masquerade as the constraint.
async function indexState(client, name) {
  const r = await client.query(
    `SELECT i.indisunique
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1 AND i.indrelid = 'devices'::regclass`,
    [name]
  );
  if (r.rows.length === 0) return { present: false, unique: false };
  return { present: true, unique: r.rows[0].indisunique };
}

async function caseVariantDuplicates(client) {
  const r = await client.query(
    `SELECT lower(device_id) AS folded, count(*)::int AS n,
            array_agg(device_id ORDER BY device_id) AS ids
       FROM devices GROUP BY lower(device_id) HAVING count(*) > 1`
  );
  return r.rows;
}

// A device_id that differs only by case from an existing row, or null when the
// table is empty.
async function existingDeviceId(client) {
  const r = await client.query("SELECT device_id FROM devices LIMIT 1");
  return r.rows.length > 0 ? r.rows[0].device_id : null;
}

async function main() {
  console.log("=== Migration 014: case-insensitive device_id uniqueness ===\n");

  const client = await pool.connect();
  try {
    // -----------------------------------------------------------------------
    console.log("--- A. Current live state ---");
    // -----------------------------------------------------------------------
    const liveCi = await indexState(client, CI_INDEX);
    check(`${CI_INDEX} exists`, liveCi.present);
    check(`${CI_INDEX} is UNIQUE`, liveCi.present && liveCi.unique, `unique=${liveCi.unique}`);

    const liveDupes = await caseVariantDuplicates(client);
    check("no case-variant duplicates in the live database", liveDupes.length === 0,
      liveDupes.length ? JSON.stringify(liveDupes) : "none");

    const recorded = await client.query(
      "SELECT 1 FROM schema_migrations WHERE version = '014'"
    );
    check("014 is recorded in schema_migrations", recorded.rows.length > 0);

    // -----------------------------------------------------------------------
    console.log("\n--- B. The unique index actually rejects a case variant ---");
    // -----------------------------------------------------------------------
    const seedId = await existingDeviceId(client);
    if (seedId) {
      const variant = seedId.toLowerCase() === seedId
        ? seedId.toUpperCase()
        : seedId.toLowerCase();
      let rejected = false;
      let code = "";
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO devices (device_id, registered_via, ip_source) VALUES ($1, 'auto', 'auto')`,
          [variant]
        );
        await client.query("ROLLBACK");
      } catch (err) {
        rejected = true;
        code = err.code || "";
        await client.query("ROLLBACK").catch(() => {});
      }
      check(`inserting case variant "${variant}" is rejected by the index`, rejected, `sqlstate=${code}`);
      check("the rejection is a unique violation (23505)", code === "23505", `sqlstate=${code}`);
    } else {
      console.log("SKIP  devices table is empty; cannot test insert rejection");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- C. Blocked path: duplicates present => no unique index ---");
    // -----------------------------------------------------------------------
    // Everything below runs in one transaction and is rolled back at the end, so
    // the live schema and rows are restored exactly as they were.
    await client.query("BEGIN");
    try {
      // Free the name so a case variant can be inserted, simulating a database
      // that predates the constraint (which is the situation the migration has
      // to cope with).
      await client.query(`DROP INDEX IF EXISTS ${CI_INDEX}`);

      const dupBase = await existingDeviceId(client);
      if (dupBase) {
        const variant = dupBase.toLowerCase() === dupBase ? dupBase.toUpperCase() : dupBase.toLowerCase();
        await client.query(
          `INSERT INTO devices (device_id, registered_via, ip_source) VALUES ($1, 'auto', 'auto')`,
          [variant]
        );
      } else {
        await client.query(
          `INSERT INTO devices (device_id, registered_via, ip_source) VALUES ('D2_TEST_A', 'auto', 'auto')`
        );
        await client.query(
          `INSERT INTO devices (device_id, registered_via, ip_source) VALUES ('d2_test_a', 'auto', 'auto')`
        );
      }

      const dupes = await caseVariantDuplicates(client);
      check("test fixture really does contain case-variant duplicates", dupes.length > 0,
        JSON.stringify(dupes.map((d) => d.ids)));

      // This mirrors what migration 014 does when it finds duplicates: it must
      // create the differently-named non-unique fallback, and must NOT build the
      // unique index.
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${FOLDED_INDEX} ON devices (LOWER(device_id))`
      );
      const blockedCi = await indexState(client, CI_INDEX);
      check("blocked run does NOT create the unique index", !blockedCi.present, `present=${blockedCi.present}`);

      const folded = await indexState(client, FOLDED_INDEX);
      check("blocked run creates the non-unique folded index instead", folded.present && !folded.unique,
        `present=${folded.present} unique=${folded.unique}`);

      // And the fallback must not squat on the unique index's name, or the
      // re-run below would be skipped by IF NOT EXISTS.
      check("the fallback index does not occupy the unique index's name",
        FOLDED_INDEX !== CI_INDEX, `${FOLDED_INDEX} vs ${CI_INDEX}`);

      await client.query(`DROP INDEX IF EXISTS ${FOLDED_INDEX}`);
    } finally {
      await client.query("ROLLBACK");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- D. Re-run path: a non-unique index on the target name ---");
    // -----------------------------------------------------------------------
    await client.query("BEGIN");
    try {
      // Simulate the trap: a NON-unique index already owns the unique index's
      // name. Plain `CREATE UNIQUE INDEX IF NOT EXISTS` would be a silent no-op.
      await client.query(`DROP INDEX IF EXISTS ${CI_INDEX}`);
      await client.query(`CREATE INDEX ${CI_INDEX} ON devices (LOWER(device_id))`);
      const squatter = await indexState(client, CI_INDEX);
      check("fixture: a non-unique index squats the target name",
        squatter.present && !squatter.unique, `unique=${squatter.unique}`);

      // The migration's remediation: drop the squatter, then build the real one.
      const existingCi = await client.query(
        `SELECT i.indisunique
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = $1 AND i.indrelid = 'devices'::regclass`,
        [CI_INDEX]
      );
      if (existingCi.rows.length > 0 && !existingCi.rows[0].indisunique) {
        await client.query(`DROP INDEX ${CI_INDEX}`);
      }
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${CI_INDEX} ON devices (LOWER(device_id))`);

      const rebuilt = await indexState(client, CI_INDEX);
      check("re-run replaces the non-unique squatter with a UNIQUE index",
        rebuilt.present && rebuilt.unique, `present=${rebuilt.present} unique=${rebuilt.unique}`);
    } finally {
      await client.query("ROLLBACK");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- E. Live state is untouched ---");
    // -----------------------------------------------------------------------
    const afterCi = await indexState(client, CI_INDEX);
    check(`${CI_INDEX} still present and UNIQUE after all tests`,
      afterCi.present && afterCi.unique, `present=${afterCi.present} unique=${afterCi.unique}`);
    const afterFolded = await indexState(client, FOLDED_INDEX);
    check("no fallback index leaked into the live schema", !afterFolded.present);
    const afterDupes = await caseVariantDuplicates(client);
    check("no duplicate rows leaked into the live data", afterDupes.length === 0);
    const totalDevices = await client.query("SELECT count(*)::int AS n FROM devices");
    console.log(`      live device rows: ${totalDevices.rows[0].n}`);

    console.log(
      `\n${failures === 0 ? "=== ALL MIGRATION 014 TESTS PASSED ===" : `=== ${failures} FAILED ===`} (${checks} checks)`
    );
  } finally {
    client.release();
    await pool.end();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("migration014 test crashed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
