// =============================================================================
// 018_water_level_calibration.cjs - HC-SR04 geometry: per-tank calibration and
//                                  raw distance on every sensors row
// Idempotent (safe to run repeatedly). Run:  node db/migrations/018_water_level_calibration.cjs
//
//   Two problems this fixes:
//
//   1. The HC-SR04's EMPTY_CM (distance at minimum fill = 0%) and FULL_CM
//      (distance at maximum fill = 100%) lived only as #defines in the firmware.
//      A tank whose sensor was re-mounted, or whose placeholder FULL_CM had
//      never been measured, could only be fixed by reflashing the board - which
//      means physically going to the tank. `sensor_calibration` moves that pair
//      into PostgreSQL, editable per tank over HTTP.
//
//   2. `sensors` stored only the resulting percentage. A percentage is a lossy
//      projection of the measured distance: once it is stored, the distance
//      needed to re-derive the correct percentage is gone. `water_distance_cm`
//      keeps the raw measurement alongside it, so a calibration corrected today
//      can be applied to history rather than only to future rows.
//
//   NOT stored here, deliberately: sensor_settings.water_level_min/max and
//   device_threshold_overrides.water_level_min/max. Those are ALERT thresholds
//   ("warn below 40%"), not geometry. Calibrating a sensor must not move the
//   alert lines.
//
//   No backfill: sensors.water_distance_cm is NULL for every historical row
//   because the firmware did not send it, and NULL correctly means "distance
//   unknown" rather than 0. There is nothing to invent.
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

// Defaults mirror server.cjs (WATER_LEVEL_EMPTY_CM / WATER_LEVEL_FULL_CM).
// They are only a starting point; the server applies the same pair for any tank
// with no row, so this seed is a convenience rather than a requirement.
const DEFAULT_EMPTY_CM = 23.5;
const DEFAULT_FULL_CM = 8.0;

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- 1. Raw distance on the time series ------------------------------
    // ADD COLUMN IF NOT EXISTS keeps this re-runnable on a database where an
    // earlier attempt half-completed.
    await client.query(`
      ALTER TABLE sensors
        ADD COLUMN IF NOT EXISTS water_distance_cm DECIMAL(6,2)
    `);

    await client.query(`
      COMMENT ON COLUMN sensors.water_distance_cm IS
        'Raw HC-SR04 distance from sensor to water surface, cm. NULL = not reported by this firmware version or failed sensor. Not the tank wall height.'
    `);

    // Bound it to the module's usable range rather than leaving it unconstrained
    // like water_level was, so a nonsense distance cannot enter the history that
    // a later recalibration will be applied to. 400 cm is the HC-SR04 ceiling;
    // 0.01 keeps it clear of a hard-zero default being mistaken for a real value.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_sensors_water_distance_valid'
        ) THEN
          ALTER TABLE sensors
            ADD CONSTRAINT chk_sensors_water_distance_valid
            CHECK (water_distance_cm IS NULL OR (water_distance_cm > 0 AND water_distance_cm <= 400));
          RAISE NOTICE 'Added chk_sensors_water_distance_valid';
        END IF;
      END $$
    `);

    // ---- 2. Per-tank calibration -----------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS sensor_calibration (
        device_id VARCHAR(50) PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
        -- Distance from the sensor to the water surface at MINIMUM fill (0%).
        empty_cm DECIMAL(6,2) NOT NULL,
        -- Distance from the sensor to the water surface at MAXIMUM fill (100%).
        full_cm DECIMAL(6,2) NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by VARCHAR(100),
        -- Enforced here as well as in the Zod schema: the whole table exists to
        -- be read by a formula that divides by (empty_cm - full_cm), so an
        -- empty_cm <= full_cm row would be a divide-by-zero waiting to happen.
        CONSTRAINT chk_sensor_calibration_span CHECK (empty_cm > full_cm),
        -- The 2 cm floor is the HC-SR04's near-field blind spot, not a policy.
        CONSTRAINT chk_sensor_calibration_range CHECK (
          full_cm >= 2 AND empty_cm <= 400
        )
      )
    `);

    await client.query(`
      COMMENT ON TABLE sensor_calibration IS
        'HC-SR04 water-level geometry per tank. empty_cm = distance at 0% level, full_cm = distance at 100% level. ALERT thresholds live in sensor_settings / device_threshold_overrides, not here.'
    `);

    // Seed every existing device so the numbers are visible and editable in the
    // UI straight away. ON CONFLICT DO NOTHING means re-running the migration
    // never overwrites a calibration somebody has since tuned.
    await client.query(
      `INSERT INTO sensor_calibration (device_id, empty_cm, full_cm, updated_by)
         SELECT device_id, $1, $2, 'migration 018 default'
           FROM devices
       ON CONFLICT (device_id) DO NOTHING`,
      [DEFAULT_EMPTY_CM, DEFAULT_FULL_CM],
    );

    // ---- 3. Record the migration ------------------------------------------
    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('018', 'water_level_calibration')
       ON CONFLICT (version) DO NOTHING`,
    );

    await client.query("COMMIT");

    // ---- verification report ---------------------------------------------------
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'sensors' AND column_name = 'water_distance_cm'`,
    );
    console.log("sensors.water_distance_cm ->");
    for (const r of cols.rows) {
      console.log(`  ${r.column_name}  ${r.data_type}  nullable=${r.is_nullable}`);
    }

    const constraints = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('chk_sensors_water_distance_valid',
                          'chk_sensor_calibration_span',
                          'chk_sensor_calibration_range')
        ORDER BY conname`,
    );
    for (const r of constraints.rows) console.log(`constraint -> ${r.conname}`);

    const seeded = await client.query(
      `SELECT COUNT(*) AS n FROM sensor_calibration`,
    );
    console.log(`sensor_calibration rows -> ${seeded.rows[0].n}`);

    console.log(
      `[migration] 018_water_level_calibration applied (defaults: empty=${DEFAULT_EMPTY_CM} cm, full=${DEFAULT_FULL_CM} cm - MEASURE the real full-tank distance and correct it per tank via PUT /calibration/water-level)`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
})().catch((err) => {
  console.error("[migration] 018_water_level_calibration failed:", err.message);
  process.exit(1);
});