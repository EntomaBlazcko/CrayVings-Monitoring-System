const { Pool } = require("pg");
const crypto = require("crypto");
require("dotenv").config();

const PBKDF2_ITERATIONS = 600000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = "sha512";

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return `${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

// The initial admin's identity comes entirely from env — there is no hardcoded
// default account. The owner (ADMIN_USERNAME / ADMIN_EMAIL) is the sole
// privileged account the system bootstraps on a fresh database.
async function seedAdmin() {
  const pool = new Pool({
    host: process.env.PG_HOST || "localhost",
    port: process.env.PG_PORT || 5432,
    database: process.env.PG_DATABASE || "crayvings_monitoring_system_db",
    user: process.env.PG_USER || "postgres",
    password: process.env.PG_PASSWORD,
  });

  try {
    const password = process.env.ADMIN_INITIAL_PASSWORD;
    if (!password) {
      console.error("❌ ADMIN_INITIAL_PASSWORD is not set. Set it in .env to create the initial admin.");
      return;
    }
    const username = (process.env.ADMIN_USERNAME || "owner").trim();
    const email = (process.env.ADMIN_EMAIL || process.env.SMTP_USER || "").trim();
    const name = process.env.ADMIN_NAME || "Owner";

    console.log("Checking for an existing admin account...");
    const result = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");

    if (result.rows[0].n === 0) {
      const hash = hashPassword(password);
      await pool.query(
        `INSERT INTO users (name, username, email, password_hash, role)
         VALUES ($1, $2, $3, $4, 'admin')`,
        [name, username, email, hash]
      );
      console.log("✅ Owner admin account created!");
      console.log("\n🔑 Login credentials:");
      console.log("   Username: " + username);
      console.log("   Email:    " + email);
      console.log("   Password: " + password + "\n");
    } else {
      console.log("ℹ️ An admin account already exists — password not changed.");
      console.log("   Run the server and reset the password via the Settings page if needed.");
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await pool.end();
  }
}

seedAdmin();