// =============================================================================
// 002_owner_admin.cjs - Convert the legacy default admin into the owner account
// Idempotent (safe to run repeatedly). Run:  node db/migrations/002_owner_admin.cjs
//
// Goal: there is NO hardcoded default admin anymore. The owner (from env:
// ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD) is the single
// privileged account. This migration:
//
//   1. Rebuilds the activity_logs FK on users(username) with ON UPDATE CASCADE
//      (so renaming the owner's username propagates to existing audit rows) plus
//      the existing ON DELETE SET NULL from migration 001.
//   2. Converts a legacy `admin` / admin@crayvings.com row (if present) into the
//      owner account, resetting its password to ADMIN_INITIAL_PASSWORD. Only that
//      exact legacy sentinel is touched — real team accounts are left alone.
//   3. Seeds the owner admin from env if no admin-role user exists (fresh DBs).
// =============================================================================

require("dotenv").config();
const { Pool } = require("pg");
const crypto = require("crypto");

const PBKDF2_ITERATIONS = 600000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = "sha512";

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return `${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

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

    const ownerUsername = (process.env.ADMIN_USERNAME || process.env.SMTP_USER?.split("@")[0] || "owner").trim();
    const ownerEmail = (process.env.ADMIN_EMAIL || process.env.SMTP_USER || "").trim();
    const ownerName = process.env.ADMIN_NAME || "Owner";

    // ---- 1. activity_logs FK -> ON UPDATE CASCADE (ON DELETE SET NULL keeps) --
    await client.query("ALTER TABLE activity_logs DROP CONSTRAINT IF EXISTS activity_logs_user_name_fkey");
    await client.query(
      `ALTER TABLE activity_logs
         ADD CONSTRAINT activity_logs_user_name_fkey
         FOREIGN KEY (user_name) REFERENCES users (username)
         ON UPDATE CASCADE ON DELETE SET NULL`
    );

    // ---- 2. convert the legacy default admin sentinel into the owner account --
    const legacy = await client.query(
      `SELECT id FROM users WHERE username = 'admin' AND role = 'admin' AND email = 'admin@crayvings.com'`
    );
    for (const row of legacy.rows) {
      const newPass = process.env.ADMIN_INITIAL_PASSWORD;
      if (newPass) {
        await client.query(
          `UPDATE users SET username = $1, email = $2, name = $3, password_hash = $4 WHERE id = $5`,
          [ownerUsername, ownerEmail, ownerName, hashPassword(newPass), row.id]
        );
      } else {
        await client.query(
          `UPDATE users SET username = $1, email = $2, name = $3 WHERE id = $4`,
          [ownerUsername, ownerEmail, ownerName, row.id]
        );
      }
      console.log(`converted legacy 'admin' -> '${ownerUsername}' (${ownerEmail})`);
    }

    // ---- 3. seed the owner admin when no admin-role user exists (fresh DB) ----
    const adminCount = await client.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");
    if (adminCount.rows[0].n === 0) {
      const pw = process.env.ADMIN_INITIAL_PASSWORD;
      if (!pw) {
        throw new Error("ADMIN_INITIAL_PASSWORD is not set; cannot seed the owner admin.");
      }
      await client.query(
        `INSERT INTO users (name, username, email, password_hash, role)
         VALUES ($1, $2, $3, $4, 'admin')`,
        [ownerName, ownerUsername, ownerEmail, hashPassword(pw)]
      );
      console.log(`seeded owner admin '${ownerUsername}' (${ownerEmail})`);
    }

    await client.query("COMMIT");

    const who = await client.query(
      "SELECT id, name, username, email, role FROM users WHERE role = 'admin' OR username = $1 ORDER BY id",
      [ownerUsername]
    );
    console.log("admins:", JSON.stringify(who.rows));
    const delRule = await client.query(
      `SELECT rc.delete_rule, rc.update_rule FROM information_schema.referential_constraints rc
        WHERE rc.constraint_name = 'activity_logs_user_name_fkey'`
    );
    console.log("activity_logs FK rules ->", JSON.stringify(delRule.rows[0] ?? null));
    console.log("[migration] 002_owner_admin applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 002_owner_admin failed:", err.message);
  process.exit(1);
});