const { Pool } = require("pg");
const crypto = require("crypto");
require("dotenv").config();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

async function seedAdmin() {
  const pool = new Pool({
    host: process.env.PG_HOST || "localhost",
    port: process.env.PG_PORT || 5432,
    database: process.env.PG_DATABASE || "crayvings_monitoring_system_db",
    user: process.env.PG_USER || "postgres",
    password: process.env.PG_PASSWORD,
  });

  try {
    const password = process.env.ADMIN_INITIAL_PASSWORD || "Admin@123";
    console.log("Checking admin account...");
    const result = await pool.query("SELECT id FROM users WHERE username = $1", ["admin"]);

    if (result.rows.length === 0) {
      const hash = hashPassword(password);
      await pool.query(
        `INSERT INTO users (name, username, email, password_hash, role)
         VALUES ('Administrator', 'admin', 'admin@crayvings.com', $1, 'admin')`,
        [hash]
      );
      console.log("✅ Admin account created!");
      console.log("\n🔑 Login credentials:");
      console.log("   Username: admin");
      console.log("   Password: " + password + "\n");
    } else {
      console.log("ℹ️ Admin account already exists — password not changed.");
      console.log("   Run the server and reset the password via the Settings page if needed.");
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await pool.end();
  }
}

seedAdmin();
