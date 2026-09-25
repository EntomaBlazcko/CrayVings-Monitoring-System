// =============================================================================
// 013_token_hash.cjs - Hash stored session tokens (SHA-256)
// Idempotent (guarded by a system_state flag). Run:
//   node db/migrations/013_token_hash.cjs
//
//   users.token held PLAINTEXT session tokens, so any DB read (backup leak,
//   pgAdmin session) could impersonate a user. This migration hashes every
//   stored token in place; server.cjs now compares SHA-256(presented token).
//   Clients keep the ORIGINAL raw token (browser localStorage), so live
//   sessions survive: hash(raw) == the new stored value.
//
//   - Tokens that are 64-char lowercase hex (the generateToken() shape) are
//     hashed in place.
//   - Anything else (legacy/garbage) is nulled -> that user re-logs in.
//   - Re-runs are skipped via system_state key 'auth_token_hashed', so hashes
//     are never double-hashed.
// =============================================================================

require("dotenv").config();
const crypto = require("crypto");
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

    const flag = await client.query("SELECT value FROM system_state WHERE key = 'auth_token_hashed'");
    if (flag.rows.length > 0) {
      console.log("[migration] 013_token_hash already applied - skipping");
      await client.query("COMMIT");
      return;
    }

    const users = await client.query("SELECT id, token FROM users WHERE token IS NOT NULL AND token <> ''");
    let hashed = 0;
    let nulled = 0;
    for (const user of users.rows) {
      if (/^[0-9a-f]{64}$/.test(user.token)) {
        const hash = crypto.createHash("sha256").update(user.token, "utf8").digest("hex");
        await client.query("UPDATE users SET token = $1 WHERE id = $2", [hash, user.id]);
        hashed++;
      } else {
        // Not the generateToken() shape: cannot be re-derived safely -> force a
        // fresh login instead of leaving a value no code path can ever match.
        await client.query("UPDATE users SET token = NULL, token_expires_at = NULL WHERE id = $1", [user.id]);
        nulled++;
      }
    }

    await client.query(
      `INSERT INTO system_state (key, value) VALUES ('auth_token_hashed', '1')
         ON CONFLICT (key) DO UPDATE SET value = '1'`
    );
    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('013', 'token_hash')
       ON CONFLICT (version) DO NOTHING`
    );

    await client.query("COMMIT");

    console.log(`session tokens hashed -> ${hashed}`);
    console.log(`non-conforming tokens nulled (forced re-login) -> ${nulled}`);
    console.log("[migration] 013_token_hash applied");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 013_token_hash failed:", err.message);
  process.exit(1);
}).finally(() => pool.end());
