// =============================================================================
// FILE: db/migrations/009_sensor_constraints.cjs
// PURPOSE: Convert stored sensor-failure sentinels to NULL, then add CHECK
// constraints and a partial index to the sensors table.
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
  console.log("Running migration 009: sensor sentinel cleanup + CHECK constraints...");

  try {
    // 1) Convert stored failure sentinels to NULL so historical data matches
    //    the new ingestion behavior (sentinels are never stored going forward).
    //    ESP32 sentinels: temperature -127 (and 0), water_level -1, ammonia -1.
    const cleaned = await db.query(`
      UPDATE sensors
         SET temperature = NULL
       WHERE temperature IS NOT NULL AND (temperature <= -100 OR temperature = 0);
    `);
    console.log(`  NULLed ${cleaned.rowCount} temperature sentinel row(s)`);

    const cleanedWater = await db.query(`
      UPDATE sensors
         SET water_level = NULL
       WHERE water_level IS NOT NULL AND water_level < 0;
    `);
    console.log(`  NULLed ${cleanedWater.rowCount} water_level sentinel row(s)`);

    const cleanedAmmonia = await db.query(`
      UPDATE sensors
         SET ammonia = NULL
       WHERE ammonia IS NOT NULL AND ammonia < 0;
    `);
    console.log(`  NULLed ${cleanedAmmonia.rowCount} ammonia sentinel row(s)`);

    // 2) CHECK constraints (idempotent via pg_constraint lookup).
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_sensors_temperature_valid'
            AND conrelid = 'sensors'::regclass
        ) THEN
          ALTER TABLE sensors
            ADD CONSTRAINT chk_sensors_temperature_valid
            CHECK (temperature IS NULL OR (temperature > -100 AND temperature <= 100));
          RAISE NOTICE 'Added chk_sensors_temperature_valid';
        END IF;
      END $$;
    `);

    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_sensors_water_level_valid'
            AND conrelid = 'sensors'::regclass
        ) THEN
          ALTER TABLE sensors
            ADD CONSTRAINT chk_sensors_water_level_valid
            CHECK (water_level IS NULL OR (water_level >= 0 AND water_level <= 200));
          RAISE NOTICE 'Added chk_sensors_water_level_valid';
        END IF;
      END $$;
    `);

    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_sensors_ammonia_valid'
            AND conrelid = 'sensors'::regclass
        ) THEN
          ALTER TABLE sensors
            ADD CONSTRAINT chk_sensors_ammonia_valid
            CHECK (ammonia IS NULL OR (ammonia >= 0 AND ammonia <= 1000));
          RAISE NOTICE 'Added chk_sensors_ammonia_valid';
        END IF;
      END $$;
    `);
    console.log("  CHECK constraints verified/added");

    // 3) Partial index covering rows that contain at least one valid reading —
    //    speeds up the history/trend queries which filter sentinels out.
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_sensors_valid_readings
      ON sensors(device_id, timestamp DESC)
      WHERE temperature IS NOT NULL
         OR water_level IS NOT NULL
         OR ammonia IS NOT NULL;
    `);
    console.log("  Partial index idx_sensors_valid_readings verified/created");

    console.log("Migration 009 completed successfully");
  } catch (err) {
    console.error("❌ Migration 009 failed:", err.message);
    throw err;
  } finally {
    await db.end();
  }
}

migrate();