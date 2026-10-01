// =============================================================================
// 015_device_secret_rotation.cjs - Per-device secret rotation with a grace window
// Idempotent (safe to run repeatedly). Run:  node db/migrations/015_device_secret_rotation.cjs
//
// Migration 008 gave every device an optional `device_secret`, and POST /sensor
// accepts either that per-device secret or the shared DEVICE_SECRET. Nothing
// could ever invalidate one: a board that leaks its secret (sold, stolen,
// imaged from a compromised flash, or simply cloned by whoever read the
// firmware) stayed authorised until somebody edited the database by hand.
//
// This migration adds the storage rotation needs:
//
//   1. device_secret_rotated_at
//        When the current secret was issued. Metadata only - lets the UI say
//        "rotated 3 days ago" and lets an operator spot a fleet that has never
//        been rotated, without ever exposing the secret itself.
//
//   2. device_secret_prev + device_secret_prev_expires_at
//        The OUTGOING secret plus the instant it stops being accepted.
//
// Why a grace window at all: a board can only learn a new secret through its
// WiFiManager config portal, i.e. somebody has to physically reach the tank.
// Rotating with no overlap would therefore guarantee an outage - and for a
// device that is already unreachable (which is exactly when you would rotate
// after a suspected compromise) it guarantees a permanently bricked board that
// can only be recovered by carrying a laptop to the tank.
//
// So rotation keeps the previous secret valid for a bounded, explicit window
// (default 24h, capped at 7 days). The window is what makes rotation safe for
// reachable hardware, and grace 0 remains available for a device that must lose
// access immediately. The two columns are cleared together by the expiry check,
// so a stale secret can never linger past its deadline.
//
// Nothing in this migration deletes data or invalidates a live secret.
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

async function ensureCheck(client, name, ddl) {
  const existing = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
  if (existing.rows.length > 0) {
    console.log(`[migration] CHECK ${name} already present`);
    return;
  }
  await client.query(`ALTER TABLE devices ADD CONSTRAINT ${name} ${ddl}`);
  console.log(`[migration] added CHECK ${name}`);
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_secret_rotated_at TIMESTAMPTZ`
    );
    await client.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_secret_prev VARCHAR(255)`
    );
    await client.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_secret_prev_expires_at TIMESTAMPTZ`
    );

    // A previous secret and its deadline are meaningless apart: storing one
    // without the other would either silently disable the grace window or make
    // the auth path compare against a secret it can never expire.
    await ensureCheck(
      client,
      "chk_devices_secret_prev_pair",
      "CHECK ((device_secret_prev IS NULL) = (device_secret_prev_expires_at IS NULL))"
    );

    // Supports the auth lookup for the previous secret. Partial, because the
    // overwhelming majority of devices never rotate and stay NULL.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_devices_secret_prev
         ON devices (device_secret_prev) WHERE device_secret_prev IS NOT NULL`
    );

    // Expiry is evaluated per request, so a device whose window has closed must
    // be cleanable in bulk rather than only on its next request.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_devices_secret_prev_expires
         ON devices (device_secret_prev_expires_at) WHERE device_secret_prev_expires_at IS NOT NULL`
    );

    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('015', 'device_secret_rotation')
       ON CONFLICT (version) DO NOTHING`
    );

    await client.query("COMMIT");

    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'devices'
          AND column_name LIKE 'device_secret%'
        ORDER BY column_name`
    );
    console.log("devices secret columns ->");
    for (const r of cols.rows) {
      console.log(`  ${r.column_name.padEnd(32)} ${r.data_type.padEnd(28)} nullable=${r.is_nullable}`);
    }

    const checks = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'devices'::regclass AND contype = 'c' AND conname = 'chk_devices_secret_prev_pair'`
    );
    console.log("chk_devices_secret_prev_pair ->", checks.rows.length ? "present" : "MISSING");

    const idx = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'devices'
          AND indexname IN ('idx_devices_secret_prev', 'idx_devices_secret_prev_expires')
        ORDER BY indexname`
    );
    console.log("rotation indexes ->", idx.rows.map((r) => r.indexname).join(", ") || "MISSING");

    console.log("[migration] 015_device_secret_rotation applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
})().catch(async (err) => {
  console.error("[migration] 015_device_secret_rotation failed:", err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
