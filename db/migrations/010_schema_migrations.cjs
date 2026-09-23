// =============================================================================
// FILE: db/migrations/010_schema_migrations.cjs
// PURPOSE: Create schema_migrations tracking table for version management
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
  console.log("Running migration 010: Create schema_migrations table...");

  try {
    // Create schema_migrations table
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum VARCHAR(64)
      );
    `);
    console.log("✅ Created schema_migrations table");

    // Insert initial migration records for existing migrations
    const migrations = [
      { version: "001", name: "user_deletion" },
      { version: "002", name: "owner_admin" },
      { version: "003", name: "sms_integration" },
      { version: "004", name: "sms_delivery" },
      { version: "005", name: "schema_consistency" },
      { version: "006", name: "archive_restore" },
      { version: "007", name: "multi_device" },
      { version: "008", name: "device_secrets" },
      { version: "009", name: "sensor_constraints" },
      { version: "010", name: "schema_migrations" },
    ];

    for (const migration of migrations) {
      await db.query(`
        INSERT INTO schema_migrations (version, name)
        VALUES ($1, $2)
        ON CONFLICT (version) DO NOTHING;
      `, [migration.version, migration.name]);
    }
    console.log("✅ Inserted migration history records");

    console.log("Migration 010 completed successfully");
  } catch (err) {
    console.error("❌ Migration 010 failed:", err.message);
    throw err;
  } finally {
    await db.end();
  }
}

migrate();