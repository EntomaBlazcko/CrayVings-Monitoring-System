// =============================================================================
// FILE: db/migrations/008_device_secrets.cjs
// PURPOSE: Add per-device secret column for ESP32 authentication
// =============================================================================

const { Pool } = require("pg");

const db = new Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

async function migrate() {
  console.log("Running migration 008: Add per-device secrets...");

  try {
    // Add device_secret column to devices table
    await db.query(`
      ALTER TABLE devices 
      ADD COLUMN IF NOT EXISTS device_secret VARCHAR(255);
    `);
    console.log("✅ Added device_secret column to devices table");

    // Create index for faster lookups
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_devices_device_secret 
      ON devices(device_secret) 
      WHERE device_secret IS NOT NULL;
    `);
    console.log("✅ Created index on device_secret");

    // NOTE: no secrets are auto-generated. Per-device secrets are deliberately
    // opt-in: an admin sets devices.device_secret for a specific ESP32 and
    // flashes the same value into that device's config portal. Until then the
    // server's shared DEVICE_SECRET fallback keeps existing firmware working.

    console.log("Migration 008 completed successfully");
  } catch (err) {
    console.error("❌ Migration 008 failed:", err.message);
    throw err;
  } finally {
    await db.end();
  }
}

migrate();