// =============================================================================
// 014_device_registration.cjs - Device registration + archiving support
// Idempotent (safe to run repeatedly). Run:  node db/migrations/014_device_registration.cjs
//
// Adds four columns to `devices` so a device can be REGISTERED by an Owner
// (not merely auto-discovered on first ingest) and later ARCHIVED without
// losing any of its history.
//
//   1. registered_via / ip_source  (provenance)
//        `POST /sensor` auto-registers any unknown device_id so the
//        sensors.device_id FK can never fail. That makes an Add Device form
//        advisory rather than authoritative unless the registry records HOW a
//        row came to exist:
//          registered_via = 'manual' -> an Owner created it from the Devices page
//                          = 'auto'   -> a board first pushed data with the
//                                        shared DEVICE_SECRET ("needs attention")
//        ip_source = 'manual' -> the Owner typed the address; the ingest upsert
//                               must stop overwriting it. The health poller dials
//                               http://<ip>/status, so it needs a LAN-reachable
//                               address that auto-detection cannot guarantee when
//                               the API server is not on the tanks' subnet.
//                 = 'auto'   -> the address is learned from the live peer on every
//                               ingest (the pre-existing behaviour).
//
//   2. archived_at / archived_by  (soft delete)
//        Archive is a TERMINAL, Owner-initiated decommissioning that keeps every
//        reading. It is deliberately SEPARATE from `is_active`, which already
//        means "hidden from the tank dropdown but reversible"
//        (PUT /devices/:id, useHiddenDevices). Archiving also forces
//        is_active = false, which means every existing `WHERE is_active = true`
//        filter keeps working untouched: per-device secret lookup, /devices/latest,
//        the SMS alert list, and the device health poller all stop picking the
//        device up automatically.
//
//   device_id STAYS GLOBALLY UNIQUE, including for archived rows. Migration 006
//   made usernames / phone numbers re-usable via partial unique indexes; that
//   pattern must NOT be copied here. A replacement ESP32 reusing `ESP32_03`
//   would silently inherit the dead board's entire `sensors` history through the
//   FK. A device ID is permanently retired once used.
//
//   Nothing in this migration deletes data.
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

// Add a CHECK constraint only if it is not already present (Postgres has no
// ADD CONSTRAINT IF NOT EXISTS).
async function ensureCheck(client, name, ddl) {
  const existing = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1`,
    [name]
  );
  if (existing.rows.length > 0) {
    console.log(`[migration] CHECK ${name} already present`);
    return;
  }
  await client.query(`ALTER TABLE devices ADD CONSTRAINT ${name} ${ddl}`);
  console.log(`[migration] added CHECK ${name}`);
}

// Tracks whether the case-insensitive UNIQUE index actually got built. Declared
// out here so the process-exit handler can report the outcome: a migration that
// silently skipped a required constraint must not exit 0.
let ciUniqueEnsured = false;

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- 1. provenance + archiving columns ---------------------------------
    await client.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`
    );
    await client.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS archived_by VARCHAR(100)`
    );
    await client.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS registered_via VARCHAR(20) NOT NULL DEFAULT 'auto'`
    );
    await client.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS ip_source VARCHAR(10) NOT NULL DEFAULT 'auto'`
    );

    // ---- 2. constraints -----------------------------------------------------
    await ensureCheck(
      client,
      "chk_devices_registered_via",
      "CHECK (registered_via IN ('manual', 'auto'))"
    );
    await ensureCheck(
      client,
      "chk_devices_ip_source",
      "CHECK (ip_source IN ('manual', 'auto'))"
    );
    // An archived row must record who archived it; a live row must not claim an
    // archive timestamp. Catches a half-finished archive/restore.
    await ensureCheck(
      client,
      "chk_devices_archived_pair",
      "CHECK ((archived_at IS NULL) = (archived_by IS NULL))"
    );

    // ---- 3. index for the archived filter ----------------------------------
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_devices_archived_at ON devices (archived_at)`
    );

    // ---- 3b. case-insensitive uniqueness on device_id --------------------
    // The PRIMARY KEY is case-SENSITIVE, so without this an Owner could
    // register `esp32_01` alongside the existing `ESP32_01` and end up with two
    // rows for one physical board — while the ESP32 only ever pushes ONE of the
    // two spellings, so the other silently collects no data. Enforce that two
    // rows can never differ only by case. The device_id is still stored exactly
    // as supplied, so an existing mixed-case identity keeps working.
    const ciDupes = await client.query(
      `SELECT lower(device_id) AS folded, count(*)::int AS n,
              array_agg(device_id ORDER BY device_id) AS ids
         FROM devices
        GROUP BY lower(device_id)
       HAVING count(*) > 1`
    );
    if (ciDupes.rows.length > 0) {
      // Never fail the migration on pre-existing data: the columns and checks
      // above are still wanted, and rolling them back would be worse than the
      // problem. Instead keep the app's lower(device_id) lookups index-backed
      // and make the missing constraint impossible to overlook.
      //
      // This fallback index is deliberately NOT named idx_devices_device_id_ci.
      // `CREATE UNIQUE INDEX IF NOT EXISTS` is a no-op when *any* index of that
      // name exists, so reusing the name would leave a non-unique index sitting
      // on the target forever — the constraint silently missing even after the
      // duplicates were resolved and the migration re-run.
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_devices_device_id_folded ON devices (LOWER(device_id))`
      );
      console.error("[migration] BLOCKED: case-variant device_id duplicates exist:");
      for (const d of ciDupes.rows) {
        console.error(`  ${d.folded} -> ${d.ids.join(", ")} (${d.n} rows)`);
      }
      console.error("[migration] idx_devices_device_id_ci NOT created (a non-unique folded index was added instead).");
      console.error("[migration] Case-insensitive uniqueness is NOT enforced until this is resolved. Re-run this migration afterwards.");
    } else {
      // An earlier blocked run may have left a NON-unique index sitting on the
      // target name (e.g. hand-created, or left by an older version of this
      // script). IF NOT EXISTS would then skip the unique build and leave the
      // database unprotected with no error, so drop it first.
      const existingCi = await client.query(
        `SELECT i.indisunique
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'idx_devices_device_id_ci'
            AND i.indrelid = 'devices'::regclass`
      );
      if (existingCi.rows.length > 0 && !existingCi.rows[0].indisunique) {
        await client.query("DROP INDEX idx_devices_device_id_ci");
        console.log("[migration] dropped a NON-unique idx_devices_device_id_ci left by an earlier blocked run");
      }
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_device_id_ci ON devices (LOWER(device_id))`
      );
      ciUniqueEnsured = true;
    }

    // ---- 4. backfill ------------------------------------------------------
    // Only rows an Owner actually named were registered by hand; everything else
    // was auto-discovered by the ingest upsert. This keeps the Devices page's
    // "needs attention" list honest without touching any live behaviour.
    //
    // ip_source is intentionally LEFT at 'auto' for existing rows: their
    // ip_address was (almost certainly) written by the ingest upsert rather than
    // by a human, so we cannot prove it was manual. Defaulting to 'auto'
    // preserves today's behaviour for every already-registered device; only
    // devices added through the new form get ip_source = 'manual'.
    const backfilled = await client.query(
      `UPDATE devices
          SET registered_via = 'manual'
        WHERE registered_via = 'auto'
          AND tank_name IS NOT NULL
          AND btrim(tank_name) <> ''
        RETURNING device_id`
    );
    console.log(
      `[migration] backfilled registered_via='manual' for ${backfilled.rows.length} row(s)` +
        (backfilled.rows.length ? `: ${backfilled.rows.map((r) => r.device_id).join(", ")}` : "")
    );

    // Recorded in schema_migrations ONLY when the unique index is genuinely in
    // place. Recording it while the constraint is missing is what made this fail
    // open: the runner saw 014 as done, never retried, and the console error
    // scrolled away unnoticed while case-insensitive uniqueness stayed unenforced.
    if (ciUniqueEnsured) {
      await client.query(
        `INSERT INTO schema_migrations (version, name)
           VALUES ('014', 'device_registration')
         ON CONFLICT (version) DO NOTHING`
      );
    } else {
      console.error(
        "[migration] 014 NOT recorded in schema_migrations - idx_devices_device_id_ci is still missing. " +
          "A migration runner must not treat this version as complete."
      );
    }

    await client.query("COMMIT");

    // ---- verification report --------------------------------------------------
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'devices'
          AND column_name IN ('archived_at','archived_by','registered_via','ip_source')
        ORDER BY column_name`
    );
    console.log("devices new columns ->");
    for (const r of cols.rows) {
      console.log(
        `  ${r.column_name.padEnd(15)} ${r.data_type.padEnd(28)} nullable=${r.is_nullable} default=${r.column_default ?? "-"}`
      );
    }

    const checks = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'devices'::regclass AND contype = 'c'
        ORDER BY conname`
    );
    console.log("devices CHECK constraints ->", checks.rows.map((r) => r.conname).join(", "));

    const idx = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'devices' AND indexname = 'idx_devices_archived_at'`
    );
    console.log("idx_devices_archived_at ->", idx.rows[0] ? "present" : "MISSING");

    // Report the index the way it must be judged: UNIQUE, or not there at all.
    // pg_indexes only lists the name, so a non-unique index of the same name
    // would otherwise read as "present".
    const ciIdx = await client.query(
      `SELECT i.indisunique
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'idx_devices_device_id_ci'
          AND i.indrelid = 'devices'::regclass`
    );
    if (ciIdx.rows.length === 0) {
      console.log("idx_devices_device_id_ci -> MISSING (case-insensitive uniqueness NOT enforced)");
    } else if (!ciIdx.rows[0].indisunique) {
      console.log("idx_devices_device_id_ci -> present but NOT UNIQUE (case-insensitive uniqueness NOT enforced)");
    } else {
      console.log("idx_devices_device_id_ci -> present and UNIQUE");
    }

    const foldedIdx = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'devices' AND indexname = 'idx_devices_device_id_folded'`
    );
    if (foldedIdx.rows.length > 0) {
      console.log("idx_devices_device_id_folded -> present (fallback from a blocked run)");
    }

    const counts = await client.query(
      `SELECT registered_via, ip_source, count(*)::int AS n,
              count(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archived
         FROM devices GROUP BY registered_via, ip_source ORDER BY registered_via, ip_source`
    );
    console.log("devices provenance ->");
    for (const r of counts.rows) {
      console.log(`  registered_via=${r.registered_via} ip_source=${r.ip_source} count=${r.n} archived=${r.archived}`);
    }

    const pkey = await client.query(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'devices'::regclass AND i.indisprimary`
    );
    console.log(
      "devices PRIMARY KEY (must remain device_id only) ->",
      pkey.rows.map((r) => `${r.attname} ${r.type}`).join(", ")
    );

    if (ciUniqueEnsured) {
      console.log("[migration] 014_device_registration applied");
    } else {
      console.error(
        "[migration] 014_device_registration INCOMPLETE: the columns, checks and backfill above were committed, " +
          "but case-insensitive device_id uniqueness is NOT enforced. Resolve the duplicates, then re-run this migration."
      );
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
  if (!ciUniqueEnsured) process.exit(1);
})().catch(async (err) => {
  console.error("[migration] 014_device_registration failed:", err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
