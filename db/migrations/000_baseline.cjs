// =============================================================================
// 000_baseline.cjs - Genesis schema for fresh databases (defect D7)
// Idempotent (safe to run repeatedly). Run:  node db/migrations/000_baseline.cjs
//
// WHY: the eight base tables (users, devices, sensors, sensor_settings,
// system_logs, last_alerts, activity_logs, system_state) were created outside
// the migration ledger, so the only way to obtain them was to copy the live
// database. This file makes `createdb + 000 + 001..025` a complete provisioning
// path. On the LIVE database every statement is a no-op (the tables already
// exist); the only visible effect is recording version '000' in the ledger.
//
// REPLAY DESIGN - this baseline is the tables in their FINAL live shape
// (2026-10-18 dump), with two deliberate genesis artifacts that the chain
// needs in order to replay correctly:
//
//   1. users.username / users.email keep their FULL-UNIQUE constraints.
//      Live has only the PARTIAL indexes idx_users_username_active /
//      idx_users_email_active (migration 006). Migration 002 attaches
//      activity_logs_user_name_fkey to users(username) with an unguarded
//      ALTER TABLE - an FK cannot reference a partial index - so a fresh
//      replay NEEDS the full UNIQUE until 006 replaces it (006's
//      DROP CONSTRAINT ... CASCADE removes the 002 FK again, which is how
//      live got into its current state).
//   2. activity_logs is created WITHOUT any foreign key. Migration 001's
//      FK-relaxation loop only fires when an FK already exists; 002 is the
//      step that introduces one. This preserves the exact 001 -> 002 -> 006
//      history.
//
// Every other object that migrations 001-021 create (columns with
// ADD COLUMN IF NOT EXISTS, tables/indexes with IF NOT EXISTS, guarded
// constraints) is deliberately LEFT OUT here so the chain creates it exactly
// once; all of those statements are guarded and were verified safe against
// both shapes during the 2026-10-18 audit. Type conversions in 005/007/016
// are data_type-guarded, so declaring the FINAL types here makes them skip.
//
// KNOWN DELIBERATE DIVERGENCES (fresh replay vs. live):
//   - The unguarded genesis CHECK on system_state (if present in live) is not
//     recreated: no migration depends on it and its exact definition could
//     not be verified from the dump.
//   - Genesis CHECKs on the base tables (beyond those migrations 009/014/015/
//     018 add) are not recreated for the same reason.
//   - activity_logs_user_name_fkey exists after 002 and is dropped by 006,
//     matching how live evolved.
//
// ROLLBACK: DROP TABLE (in reverse dependency order) if the database was
// meant to stay empty. Never run against a populated database - the CREATE
// TABLE IF NOT EXISTS statements will simply no-op there anyway.
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

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Ledger first: every migration records itself here (010 created this
    // table on live; on a fresh database 000 creates it so version '000' can
    // be recorded before 010's CREATE TABLE IF NOT EXISTS no-ops on it).
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum VARCHAR(64)
      )
    `);

    // ---- users ---------------------------------------------------------------
    // password_hash declared TEXT (live final type; 005's ALTER to TEXT is a
    // no-op). token_expires_at TIMESTAMPTZ (005's conversion is type-guarded).
    // created_at / updated_at stay naive TIMESTAMP on purpose: migration 025
    // converts them along with the other three remaining naive columns.
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        username VARCHAR(50) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'user',
        token VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        token_expires_at TIMESTAMPTZ
      )
    `);

    // ---- devices -------------------------------------------------------------
    // name/created_at/last_seen predate migration 007 (which only converts
    // the two timestamps, type-guarded). Everything 007/008/014/015 adds is
    // created by those migrations.
    await client.query(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMPTZ
      )
    `);

    // ---- sensors -------------------------------------------------------------
    // DEFAULT 0 on the three reading columns is the PRE-022 state, on
    // purpose: migration 022 drops it as part of the chain, exactly as it
    // did on live. temperature/ammonia DEFAULT 0 already contradict the
    // migration-009 CHECKs; they survive only until 022 runs.
    await client.query(`
      CREATE TABLE IF NOT EXISTS sensors (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(50) NOT NULL,
        temperature DECIMAL(5,2) DEFAULT 0,
        water_level DECIMAL(5,2) DEFAULT 0,
        ammonia DECIMAL(5,2) DEFAULT 0,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_sensors_device FOREIGN KEY (device_id) REFERENCES devices(device_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sensors_timestamp ON sensors (timestamp DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sensors_device_id ON sensors (device_id)`);

    // ---- sensor_settings -----------------------------------------------------
    // Singleton alert-threshold row; migration 023 enforces id = 1.
    // Ammonia defaults are the 005 values (005's SET DEFAULT is idempotent).
    await client.query(`
      CREATE TABLE IF NOT EXISTS sensor_settings (
        id SERIAL PRIMARY KEY,
        temp_min DECIMAL(5,2) DEFAULT 20.0,
        temp_max DECIMAL(5,2) DEFAULT 31.0,
        water_level_min DECIMAL(5,2) DEFAULT 10.0,
        water_level_max DECIMAL(5,2) DEFAULT 100.0,
        ammonia_min DECIMAL(5,2) DEFAULT 0.25,
        ammonia_max DECIMAL(5,2) DEFAULT 1.00,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ---- system_logs ---------------------------------------------------------
    // ack_* columns predate 016 (which only converts acknowledged_at,
    // type-guarded). device_id is migration 011's guarded ADD COLUMN.
    // timestamp TIMESTAMPTZ = 007's final type (its conversion is guarded).
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id SERIAL PRIMARY KEY,
        action VARCHAR(100) NOT NULL,
        parameter VARCHAR(100) NOT NULL,
        old_value VARCHAR(50),
        new_value VARCHAR(50),
        ack_status VARCHAR(20),
        acknowledged_at TIMESTAMPTZ,
        acknowledged_by VARCHAR(100),
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON system_logs (timestamp DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_action ON system_logs (action)`);

    // ---- last_alerts ---------------------------------------------------------
    // Composite PK (device_id, sensor_key); sensor_key values are the three
    // hard-coded sensor names in server.cjs. timestamp TIMESTAMPTZ = 016's
    // final type (guarded conversion).
    await client.query(`
      CREATE TABLE IF NOT EXISTS last_alerts (
        device_id VARCHAR(50) NOT NULL,
        sensor_key VARCHAR(50) NOT NULL,
        status VARCHAR(20),
        value DECIMAL(5,2),
        timestamp TIMESTAMPTZ,
        PRIMARY KEY (device_id, sensor_key),
        CONSTRAINT fk_lastalerts_device FOREIGN KEY (device_id) REFERENCES devices(device_id)
      )
    `);

    // ---- activity_logs -------------------------------------------------------
    // user_name starts NOT NULL (001 drops that); NO foreign key here -
    // 002 introduces activity_logs_user_name_fkey and 006's CASCADE removes
    // it again, which is exactly how live reached its current FK-less state.
    // user_id + fk_activity_logs_user come from 019.
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        user_name VARCHAR(100) NOT NULL,
        action_type VARCHAR(50) NOT NULL,
        description TEXT,
        module VARCHAR(100),
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON activity_logs (timestamp DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_action_type ON activity_logs (action_type)`);

    // ---- system_state --------------------------------------------------------
    // Key/value runtime state (013 uses key 'auth_token_hashed', etc.).
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_state (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT
      )
    `);

    await client.query(
      `INSERT INTO schema_migrations (version, name)
         VALUES ('000', 'baseline')
       ON CONFLICT (version) DO NOTHING`
    );

    await client.query("COMMIT");

    // ---- verification report ---------------------------------------------------
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users','devices','sensors','sensor_settings',
                           'system_logs','last_alerts','activity_logs',
                           'system_state','schema_migrations')
      ORDER BY table_name
    `);
    console.log("base tables present ->", tables.rows.map((r) => r.table_name).join(", "));
    const uniq = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'users' AND indexdef LIKE '%UNIQUE%' AND indexdef NOT LIKE '%WHERE%'
      ORDER BY indexname
    `);
    console.log("users full-unique indexes ->", uniq.rows.map((r) => r.indexname).join(", ") || "MISSING");
    const ver = await client.query(`SELECT version FROM schema_migrations WHERE version = '000'`);
    console.log("ledger row 000 ->", ver.rows.length === 1 ? "present" : "MISSING");

    console.log("[migration] 000_baseline applied");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migration] 000_baseline failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
