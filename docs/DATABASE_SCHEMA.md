# CRAYvings Monitoring System — Database Schema

**Database:** `crayvings_monitoring_system_db` (PostgreSQL)

---

## Overview

The database stores user accounts, device registry, sensor readings, alert state,
activity/audit trails, SMS recipients, and SMS send history for the Smart
Aquaculture Monitoring System for Crayfish Production. Foreign keys are enforced
so related data is referenced, not duplicated.

---

## Table: `users`

Stores application login accounts with PBKDF2-hashed passwords and session
tokens.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `name` | VARCHAR(100) | NOT NULL | Display name |
| `username` | VARCHAR(50) | NOT NULL | Login name (FK target for `activity_logs`). UNIQUE only while active (partial index `idx_users_username_active`) |
| `email` | VARCHAR(255) | NOT NULL | UNIQUE only while active (partial index `idx_users_email_active`) |
| `password_hash` | TEXT | NOT NULL | PBKDF2 (`iterations:salt:hash`) |
| `role` | VARCHAR(20) | NOT NULL DEFAULT `'user'` | `admin` or `user` |
| `token` | VARCHAR(255) | | Active session token |
| `created_at` | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| `updated_at` | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| `token_expires_at` | TIMESTAMPTZ | | 24-hour session token expiry (timezone-aware so `new Date()` checks are unambiguous) |
| `status` | VARCHAR(20) | NOT NULL DEFAULT `'active'` | `active`, `pending_deletion`, `deleted` (legacy), or `archived` (soft-delete lifecycle). Login only succeeds for `active` |
| `deleted_at` | TIMESTAMPTZ | | Set when the account is archived (soft-deleted); cleared on restore |
| `pending_deletion_at` | TIMESTAMPTZ | | When a deletion request was made (account kept working until approval) |
| `pending_deletion_requested_by` | VARCHAR(100) | | Username of the admin who requested deletion |

**Indexes**

| Index | Definition |
|---|---|
| `idx_users_status` | `(status)` |
| `idx_users_username_active` | `UNIQUE (username) WHERE status IS DISTINCT FROM 'archived'` |
| `idx_users_email_active` | `UNIQUE (email) WHERE status IS DISTINCT FROM 'archived'` |

**Archiving (migration 006)**

- Deleting an account is a **soft delete**: `status` flips to `archived` and
  `deleted_at = NOW()` (the row is kept so it can be restored).
- Restore sets `status='active'` and clears `deleted_at`.
- Permanently purging an archived account is the only irreversible action
  (`DELETE FROM users WHERE status = 'archived'`).
- The full-column UNIQUE constraints are replaced by the two **partial** unique
  indexes above, so a new active account may reuse a username/email held by an
  archived row. The owner account is guarded from archiving.

---

## Table: `devices`

Canonical registry of ESP32 devices. Referenced by `sensors` and `last_alerts`.
Star-topology: each device maps to one tank; the central server also records the
device's static IP (used to poll `GET /status`) and last health check.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `device_id` | VARCHAR(50) | PRIMARY KEY | ESP32 device identifier. `idx_devices_device_id_ci` adds a **case-insensitive** unique index on `LOWER(device_id)` (migration 014) so `esp32-01` and `ESP32-01` cannot both be registered. Archived rows keep the ID reserved forever |
| `name` | VARCHAR(100) | | Optional friendly name. Written by `POST /devices` alongside `tank_name` |
| `is_active` | BOOLEAN | NOT NULL DEFAULT true | Whether the device is enabled. Cleared on archive, restored on un-archive |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | Device first seen (migration 007) |
| `last_seen` | TIMESTAMPTZ | | Latest reading timestamp (migration 007) |
| `ip_address` | TEXT | | Static LAN IP of the device (e.g. `192.168.4.101`); needed by the device poller to reach `GET /status` |
| `tank_name` | VARCHAR(100) | | Friendly tank label (e.g. "Tank 3 - Bayside") — the actual display label everywhere |
| `tank_location` | VARCHAR(100) | | Physical location / zone |
| `device_secret` | VARCHAR(255) | | Optional per-device ingestion secret (migration 008). When set, `POST /sensor` accepts this value in `X-Device-Secret` for this device; otherwise the shared `DEVICE_SECRET` applies. Deliberately opt-in — no secrets are auto-generated |
| `last_health_seen` | TIMESTAMPTZ | | Last successful `GET /status` poll (health only; `sensors` rows are **not** written by the poller) |
| `registered_via` | VARCHAR(20) | NOT NULL DEFAULT 'auto', CHECK IN ('manual','auto') | How the row entered the registry (migration 014). `manual` = `POST /devices`; `auto` = first-contact upsert from `POST /sensor`. Read-only provenance — it never blocks ingestion |
| `ip_source` | VARCHAR(10) | NOT NULL DEFAULT 'auto', CHECK IN ('manual','auto') | Who last set `ip_address` (migration 014). When `manual`, sensor ingest will **not** overwrite the IP, so an Owner-entered address survives firmware that reports a different one |
| `archived_at` | TIMESTAMPTZ | | Soft-delete marker (migration 014). NULL = live. Indexed via `idx_devices_archived_at`. All active-list queries filter `archived_at IS NULL` |
| `archived_by` | VARCHAR(100) | | Username of the admin who archived the device (migration 014) |

Devices can be registered explicitly with `POST /devices` (admin only), which sets
`registered_via='manual'` and records the activity. They are **also** still
auto-registered server-side on first sensor ingest
(`INSERT INTO devices ... ON CONFLICT ... UPDATE` → `registered_via='auto'`) so the
`sensors.device_id` FK never fails for an un-registered board. Auto-registration is
a safety net, not the intended workflow. `tank_name` / `tank_location` / `name` are
static registry metadata and are never overwritten by ingests; `ip_address` is
overwritten by ingest only while `ip_source='auto'`.

### Archiving vs. hiding (migration 014)

These are deliberately two different concepts:

| | Hide | Archive |
|---|---|---|
| Mechanism | `is_active = false` | `is_active = false` **+** `archived_at`/`archived_by` set |
| Endpoint | `PUT /devices/:deviceId` | `POST /devices/:deviceId/archive` |
| Reversible | yes (`is_active = true`) | yes (`POST /devices/:deviceId/restore`) |
| Device ID reusable | n/a | **no — never**, even after restore or archive |
| In `GET /devices` | no (unless `include_hidden=1`) | no (unless `include_archived=1`, which returns archived rows even with `is_active=false`) |
| Polled for health | no | no |
| Sensor readings retained | yes | yes — `sensors`, `last_alerts`, and `system_logs` FKs are `NO ACTION` |

`chk_devices_archived_pair` enforces that `archived_at` and `archived_by` are either
both set or both NULL. There is no hard delete and no purge endpoint, so historical
readings always remain addressable.

---

## Table: `sensors`

Time-series log of ESP32 sensor readings. One row per reading (delta logging:
unchanged heartbeats write no row).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `device_id` | VARCHAR(50) | NOT NULL, FK → `devices.device_id` | ESP32 device identifier |
| `temperature` | DECIMAL(5,2) | DEFAULT 0, NULLABLE | Degrees Celsius. `NULL` when the DS18B20 failed (firmware reports −1 / 0) |
| `water_level` | DECIMAL(5,2) | DEFAULT 0, NULLABLE | Percent (%). `NULL` when the HC-SR04 failed (firmware reports −1) |
| `ammonia` | DECIMAL(5,3) | DEFAULT 0, NULLABLE | ppm (MQ-137 sensor). `NULL` when the MQ-137 failed (firmware reports −1) |
| `timestamp` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | Reading time (migration 007) |

Since migration 009 the server converts firmware failure sentinels to `NULL`
before the row is written; existing sentinel rows were migrated to `NULL`. Both
firmwares convert the DS18B20's −127 disconnect code to −1 before sending, so
the **wire** sentinels are: `temperature` −1 or 0, `water_level` −1, `ammonia`
−1. `temperature <= 0` is treated as a failure (tropical farm; the client chart
filter and alert engine use the same rule). CHECK constraints enforce this at
the database level.

**Check constraints (migration 009)**

| Constraint | Definition |
|---|---|
| `chk_sensors_temperature_valid` | `temperature IS NULL OR (temperature > 0 AND temperature <= 100)` |
| `chk_sensors_water_level_valid` | `water_level IS NULL OR (water_level >= 0 AND water_level <= 200)` |
| `chk_sensors_ammonia_valid` | `ammonia IS NULL OR (ammonia >= 0 AND ammonia <= 1000)` |

**Indexes**

| Index | Definition | Purpose |
|---|---|---|
| `idx_sensors_timestamp` | `(timestamp DESC)` | |
| `idx_sensors_device_id` | `(device_id)` | |
| `idx_sensors_device_timestamp` | `(device_id, timestamp DESC)` | per-tank history / trend queries (migration 007) |
| `idx_sensors_valid_readings` | `(device_id, timestamp DESC) WHERE temperature IS NOT NULL OR water_level IS NOT NULL OR ammonia IS NOT NULL` | PARTIAL: rows with at least one valid reading (migration 009) |

---

## Table: `sensor_settings`

Singleton row of current alert thresholds for each sensor parameter.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `temp_min` | DECIMAL(5,2) | NOT NULL DEFAULT 20.0 | Min temperature (°C) |
| `temp_max` | DECIMAL(5,2) | NOT NULL DEFAULT 31.0 | Max temperature (°C) |
| `water_level_min` | DECIMAL(5,2) | NOT NULL DEFAULT 10.0 | Min water level (%) |
| `water_level_max` | DECIMAL(5,2) | NOT NULL DEFAULT 100.0 | Max water level (%) |
| `ammonia_min` | DECIMAL(5,2) | NOT NULL DEFAULT 0.25 | Min ammonia (ppm) |
| `ammonia_max` | DECIMAL(5,2) | NOT NULL DEFAULT 1.00 | Max ammonia (ppm) |
| `updated_at` | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

---

## Table: `system_logs`

Change and alert records for sensor parameters (feed the Alerts & Logs page and
PDF export). Standalone — stores human-readable strings, no foreign keys.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `action` | VARCHAR(100) | NOT NULL | e.g. `Alert`, `Change`, `Alert Resolved`, `Alert Muted` |
| `parameter` | VARCHAR(100) | NOT NULL | e.g. `Temperature`, `Water Level`, `Ammonia` |
| `old_value` | VARCHAR(50) | | Previous value or Low/High/status |
| `new_value` | VARCHAR(50) | | New value or status (`good`, `warning`, `critical`) |
| `ack_status` | VARCHAR(20) | | `confirmed` or `allowed` (set when an alert is acknowledged) |
| `acknowledged_at` | TIMESTAMP | | When acknowledged |
| `acknowledged_by` | VARCHAR(100) | | Username of the acknowledger |
| `timestamp` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | (migration 007) |

**Indexes**

| Index | Definition |
|---|---|
| `idx_system_logs_timestamp` | `(timestamp DESC)` |
| `idx_system_logs_action` | `(action)` |

---

## Table: `last_alerts`

Current alert state per device per sensor key (used for alert
deduplication/cooldown and restored from DB on server start).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `device_id` | VARCHAR(50) | PRIMARY KEY (composite), FK → `devices.device_id` | ESP32 device identifier |
| `sensor_key` | VARCHAR(50) | PRIMARY KEY (composite) | e.g. `Temperature`, `Water Level`, `Ammonia` |
| `status` | VARCHAR(20) | | `good`, `warning`, or `critical` |
| `value` | DECIMAL | | Reading that triggered / cleared the state |
| `timestamp` | TIMESTAMP | | |

---

## Table: `activity_logs`

Audit trail of user interactions (navigation, settings changes, device
connect/disconnect, login/logout).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `user_name` | VARCHAR(100) | NULLABLE, FK → `users.username` | Username of acting user; `NULL` once the account is deleted (audit row kept via `ON DELETE SET NULL`) |
| `action_type` | VARCHAR(50) | NOT NULL | e.g. `navigation`, `settings_change`, `device_connect`, `device_disconnect`, `login`, `logout` |
| `description` | TEXT | | Human-readable event description |
| `module` | VARCHAR(100) | | App module where the event occurred |
| `timestamp` | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Indexes**

| Index | Definition |
|---|---|
| `idx_activity_logs_timestamp` | `(timestamp DESC)` |
| `idx_activity_logs_action_type` | `(action_type)` |

---

## Table: `user_deletion_requests`

Audit chain for the secure account-deletion flow: WHO requested, WHO the OTP was
sent to, WHO verified it, WHO approved, and WHO executed the hard delete. Set up
by migration 001.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `user_id` | INTEGER | NOT NULL | Target user id |
| `user_username` | VARCHAR(100) | NOT NULL | Target username |
| `requester_username` | VARCHAR(100) | NOT NULL | Admin who requested |
| `requester_email` | VARCHAR(255) | NOT NULL | Admin's email (OTP destination) |
| `status` | VARCHAR(20) | NOT NULL DEFAULT `'pending_otp'` | `PENDING_OTP`, `EXPIRED`, `COMPLETED` |
| `reason` | TEXT | | Deletion reason |
| `otp_hash` | VARCHAR(64) | | SHA-256 hash of OTP |
| `otp_salt` | VARCHAR(32) | | Per-row salt |
| `otp_expires_at` | TIMESTAMPTZ | | OTP validity window |
| `otp_attempts` | INTEGER | NOT NULL DEFAULT 0 | Brute-force counter |
| `otp_verified_at` | TIMESTAMPTZ | | |
| `otp_verified_by` | VARCHAR(100) | | |
| `requested_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `approver` | VARCHAR(100) | | |
| `approved_at` | TIMESTAMPTZ | | |
| `executed_by` | VARCHAR(100) | | |
| `executed_at` | TIMESTAMPTZ | | |
| `status_history` | JSONB | NOT NULL DEFAULT `'[]'::JSONB` | Full state log |

**Indexes**

| Index | Definition |
|---|---|
| `idx_deletion_requests_status` | `(status)` |
| `idx_deletion_requests_user` | `(user_id)` |

---

## Table: `email_otps`

Second-factor store for deletion OTPs. The code is stored **hashed** (SHA-256
with a per-row salt), never in plaintext; expires after 10 minutes; capped at 5
attempts. No FK to `users` so it still works for an account already marked
pending. Set up by migration 001.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `email` | VARCHAR(255) | NOT NULL | Recipient email |
| `code_hash` | VARCHAR(64) | NOT NULL | SHA-256 of the code |
| `code_salt` | VARCHAR(32) | NOT NULL | Per-row salt |
| `expires_at` | TIMESTAMPTZ | NOT NULL | |
| `attempts` | INTEGER | NOT NULL DEFAULT 0 | |
| `max_attempts` | INTEGER | NOT NULL DEFAULT 5 | |
| `used_at` | TIMESTAMPTZ | | |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |

**Indexes**

| Index | Definition |
|---|---|
| `idx_email_otps_email` | `(email)` |
| `idx_email_otps_expires` | `(expires_at)` |

---

## Table: `system_state`

Simple key/value store for server-persisted runtime state (survives restarts).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `key` | VARCHAR(255) | PRIMARY KEY | e.g. `last_hourly_update_ts`, `sms_mute_until` |
| `value` | TEXT | | |

---

## Table: `authorized_recipients`

SMS recipients allowed to receive alert notifications.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `phone_number` | VARCHAR(20) | NOT NULL | Contact number in E.164 format. UNIQUE only while active (partial index `idx_recipients_phone_active`) |
| `name` | VARCHAR(100) | | Recipient display name |
| `is_active` | BOOLEAN | DEFAULT true | Whether alerts are sent here |
| `archived_at` | TIMESTAMPTZ | | `NULL` = active. Set when the recipient is archived (soft-deleted); cleared on restore |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | |

**Indexes**

| Index | Definition |
|---|---|
| `idx_recipients_archived_at` | `(archived_at)` |
| `idx_recipients_phone_active` | `UNIQUE (phone_number) WHERE archived_at IS NULL` |

**Archive/restore (migration 006)**

- Archive sets `archived_at = NOW()` (row kept, restorable); restore clears it.
- SMS sending only considers recipients `WHERE is_active = true AND archived_at IS NULL`.
- `phone_number`'s plain UNIQUE constraint was replaced by the partial unique
  index above so an archived number does not block re-adding it later.
- Permanently purging an archived recipient is the only irreversible action.

---

## Table: `sms_logs`

Audit trail of every SMS send attempt (`queued`/`delivered`/`failed`/`capped`).
`queued` rows are reconciled by the delivery poller against httpsms, which nails
down `delivered_at` / `failure_reason` so every SMS reaches a terminal state.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `recipient_phone` | VARCHAR(20) | NOT NULL, FK → `authorized_recipients.phone_number` | Phone SMS was sent to |
| `message` | TEXT | NOT NULL | Full message body |
| `status` | VARCHAR(20) | NOT NULL | `queued`, `delivered`, `failed`, or `capped` |
| `error_message` | TEXT | | Failure reason |
| `sms_id` | VARCHAR(100) | | httpsms message identifier |
| `delivered_at` | TIMESTAMPTZ | | Set when the delivery poller confirms receipt |
| `failure_reason` | TEXT | | Delivery failure reason |
| `sent_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | |

**Indexes**

| Index | Definition |
|---|---|
| `idx_sms_logs_sent_at` | `(sent_at DESC)` |
| `idx_sms_logs_status` | `(status)` |

---

## Table: `schema_migrations`

Version tracking for the `db/migrations/*.cjs` scripts (migration 010). Seeded
with the history of migrations 001-010 so operators can see which structural
changes have been applied.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `version` | VARCHAR(50) | PRIMARY KEY | Migration number (e.g. `"009"`) |
| `name` | VARCHAR(255) | NOT NULL | Migration slug |
| `applied_at` | TIMESTAMPTZ | NOT NULL (DEFAULT NOW()) | When it was applied |
| `checksum` | VARCHAR(64) | | Reserved for future use |

---

## Foreign Key Relationships (enforced)

| Constraint | Column(s) | References | Delete rule |
|---|---|---|---|
| `fk_activity_logs_user` | `activity_logs.user_name` | `users.username` | `SET NULL` (update `CASCADE`) |
| `fk_sms_logs_recipient` | `sms_logs.recipient_phone` | `authorized_recipients.phone_number` | `CASCADE` |
| `fk_sensors_device` | `sensors.device_id` | `devices.device_id` | `NO ACTION` |
| `fk_lastalerts_device` | `last_alerts.device_id` | `devices.device_id` | `NO ACTION` |

**Notes**

- `activity_logs.user_name` is derived from the session token server-side. The FK
  is `ON DELETE SET NULL` so an audit row survives the account being deleted
  (`user_name` becomes `NULL`); `ON UPDATE CASCADE` keeps it in sync when a
  username is renamed (owner admin rename in migration 002).
- `user_deletion_requests` and `email_otps` deliberately define **no** foreign
  key constraints so the request/OTP pipeline still works after the target
  account is hard-deleted.
- `last_alerts` is keyed by `(device_id, sensor_key)` so each device keeps its
  own alert state; derived from the latest `sensors` reading by the alert engine.
- `users.token` + `users.token_expires_at` implement 24-hour session
  authentication.
- `sensor_settings`, `system_state`, and `system_logs` are standalone tables (no
  foreign relationships).

---

## Data Retention

- `system_logs` older than 30 days are purged and `sms_logs` older than
  `SMS_RETENTION_DAYS` (default 30) are purged; cleanup runs on server startup and
  periodically (see `runSmsMaintenance` in `server.cjs`).
- The alert engine enforces SMS cooldowns (warning vs critical intervals) and a
  daily SMS cap (`SMS_DAILY_CAP`, 0 = unlimited) stored in the server config.

---

## Notes

- **Schema creation:** tables are created outside this repository (e.g. manual
  setup in pgAdmin / SQL shell). The server only creates `system_state` and
  applies additive migrations (`ADD COLUMN IF NOT EXISTS`) for columns like
  `ammonia`, `ammonia_min/max`, `token_expires_at`, and the alert ack columns.
  Structural changes ship as idempotent migration scripts in `db/migrations/`:

  | Migration | What it does |
  |---|---|
  | `001_user_deletion.cjs` | `users` soft-delete columns + indexes, `user_deletion_requests`, `email_otps`, `activity_logs.user_name` nullable + FK `ON DELETE SET NULL` |
  | `002_owner_admin.cjs` | `activity_logs` FK `ON UPDATE CASCADE`; converts legacy `admin` account into the owner; seeds owner from env on fresh DBs |
  | `003_sms_integration.cjs` | `authorized_recipients` + `sms_logs` tables |
  | `004_sms_delivery.cjs` | `sms_logs.delivered_at`, `failure_reason` (delivery-polling support) |
  | `005_schema_consistency.cjs` | Aligns the live schema with this doc: `sensor_settings.ammonia_min/max` defaults 0.25/1.00; drops stray `last_alerts.device_id` and `activity_logs.user_name` defaults; `users.password_hash` → TEXT; makes `users.token_expires_at` + `sms_logs.sent_at` TIMESTAMPTZ |
  | `006_archive_restore.cjs` | Soft-delete (archive) + restore: `users` `status='archived'` reuse + partial unique indexes on username/email; `authorized_recipients.archived_at` column + partial unique index on `phone_number` |
  | `007_multi_device.cjs` | Multi-tank/star-topology support: `devices.ip_address`/`tank_name`/`tank_location`/`last_health_seen`; `devices`, `sensors` & `system_logs` timestamps → TIMESTAMPTZ; composite index `idx_sensors_device_timestamp` (`device_id, timestamp DESC`) |
  | `008_device_secrets.cjs` | `devices.device_secret` (per-device ingestion secret) |
  | `009_sensor_constraints.cjs` | `sensors` value constraints/ranges |
  | `010_schema_migrations.cjs` | `schema_migrations` bookkeeping table |
  | `011_system_logs_device.cjs` | `system_logs.device_id` FK to `devices` |
  | `012_device_thresholds.cjs` | `device_threshold_overrides` (per-device thresholds) |
  | `013_token_hash.cjs` | `users.token` → stored as a hash |
  | `014_device_registration.cjs` | Device registration & archive: `devices.archived_at`/`archived_by`/`registered_via`/`ip_source`; checks `chk_devices_registered_via`/`chk_devices_ip_source`/`chk_devices_archived_pair`; indexes `idx_devices_archived_at` + case-insensitive unique `idx_devices_device_id_ci` on `LOWER(device_id)`; backfills `registered_via='manual'` for pre-existing rows that had a `tank_name` |

- **Hash format:** `password_hash = PBKDF2_ITERATIONS:salt_hex:hash_hex` (sha512,
  600,000 iterations, 64-byte key).
- **Owner/root admin:** seeded by `db/migrations/002_owner_admin.cjs` from
  `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` (no hardcoded
  default admin).
- **Device auto-registration:** the backend upserts `devices` on every sensor
  ingest so unknown ESP32 `device_id`s never violate `fk_sensors_device`.

---

## dbdiagram.io Schema (DBML)

Copy the block below into <https://dbdiagram.io> to render the full diagram.

```dbml
Table users {
  id int [pk, increment]
  name varchar(100) [not null]
  username varchar(50) [not null]
  email varchar(255) [not null]
  password_hash text [not null]
  role varchar(20) [not null, default: "'user'"]
  token varchar(255)
  created_at timestamp [default: `now()`]
  updated_at timestamp [default: `now()`]
  token_expires_at timestamptz
  status varchar(20) [not null, default: "'active'"]
  deleted_at timestamptz
  pending_deletion_at timestamptz
  pending_deletion_requested_by varchar(100)

  Indexes {
    (status) [name: 'idx_users_status']
    // PARTIAL unique: WHERE status IS DISTINCT FROM 'archived'
    (username) [unique, name: 'idx_users_username_active']
    // PARTIAL unique: WHERE status IS DISTINCT FROM 'archived'
    (email) [unique, name: 'idx_users_email_active']
  }
}

Table devices {
  device_id varchar(50) [pk]
  name varchar(100)
  is_active boolean [not null, default: true]
  created_at timestamptz [default: `now()`]
  last_seen timestamptz
  ip_address text
  tank_name varchar(100)
  tank_location varchar(100)
  last_health_seen timestamptz
  device_secret varchar(255)
  registered_via varchar(20) [not null, default: "'auto'"]
  ip_source varchar(10) [not null, default: "'auto'"]
  archived_at timestamptz
  archived_by varchar(100)

  Indexes {
    // Case-insensitive uniqueness: 'esp32-01' and 'ESP32-01' collide.
    (device_id) [unique, name: 'idx_devices_device_id_ci', note: 'on LOWER(device_id)']
    (archived_at) [name: 'idx_devices_archived_at']
  }
}

Table sensors {
  id int [pk, increment]
  device_id varchar(50) [not null]
  temperature decimal(5,2) [default: 0]
  water_level decimal(5,2) [default: 0]
  ammonia decimal(5,3) [default: 0]
  timestamp timestamptz [default: `now()`]

  Indexes {
    (timestamp) [name: 'idx_sensors_timestamp']
    (device_id) [name: 'idx_sensors_device_id']
    (device_id, timestamp) [name: 'idx_sensors_device_timestamp']
  }
}

Table sensor_settings {
  id int [pk, increment]
  temp_min decimal(5,2) [not null, default: 20.00]
  temp_max decimal(5,2) [not null, default: 31.00]
  water_level_min decimal(5,2) [not null, default: 10.00]
  water_level_max decimal(5,2) [not null, default: 100.00]
  ammonia_min decimal(5,2) [not null, default: 0.25]
  ammonia_max decimal(5,2) [not null, default: 1.00]
  updated_at timestamp [default: `now()`]
}

Table system_logs {
  id int [pk, increment]
  action varchar(100) [not null]
  parameter varchar(100) [not null]
  old_value varchar(50)
  new_value varchar(50)
  ack_status varchar(20)
  acknowledged_at timestamp
  acknowledged_by varchar(100)
  timestamp timestamptz [default: `now()`]

  Indexes {
    (timestamp) [name: 'idx_system_logs_timestamp']
    (action) [name: 'idx_system_logs_action']
  }
}

Table last_alerts {
  device_id varchar(50) [pk]
  sensor_key varchar(50) [pk]
  status varchar(20)
  value decimal
  timestamp timestamp
}

Table activity_logs {
  id int [pk, increment]
  user_name varchar(100)
  action_type varchar(50) [not null]
  description text
  module varchar(100)
  timestamp timestamp [default: `now()`]

  Indexes {
    (timestamp) [name: 'idx_activity_logs_timestamp']
    (action_type) [name: 'idx_activity_logs_action_type']
  }
}

Table user_deletion_requests {
  id int [pk, increment]
  user_id int [not null]
  user_username varchar(100) [not null]
  requester_username varchar(100) [not null]
  requester_email varchar(255) [not null]
  status varchar(20) [not null, default: "'pending_otp'"]
  reason text
  otp_hash varchar(64)
  otp_salt varchar(32)
  otp_expires_at timestamp
  otp_attempts int [not null, default: 0]
  otp_verified_at timestamp
  otp_verified_by varchar(100)
  requested_at timestamp [default: `now()`]
  approver varchar(100)
  approved_at timestamp
  executed_by varchar(100)
  executed_at timestamp
  status_history jsonb [not null, default: "'[]'"]

  Indexes {
    (status) [name: 'idx_deletion_requests_status']
    (user_id) [name: 'idx_deletion_requests_user']
  }
}

Table email_otps {
  id int [pk, increment]
  email varchar(255) [not null]
  code_hash varchar(64) [not null]
  code_salt varchar(32) [not null]
  expires_at timestamp [not null]
  attempts int [not null, default: 0]
  max_attempts int [not null, default: 5]
  used_at timestamp
  created_at timestamp [default: `now()`]

  Indexes {
    (email) [name: 'idx_email_otps_email']
    (expires_at) [name: 'idx_email_otps_expires']
  }
}

Table system_state {
  key varchar(255) [pk]
  value text
}

Table authorized_recipients {
  id int [pk, increment]
  phone_number varchar(20) [not null]
  name varchar(100)
  is_active boolean [default: true]
  archived_at timestamptz
  created_at timestamptz [default: `now()`]
  updated_at timestamptz [default: `now()`]

  Indexes {
    (archived_at) [name: 'idx_recipients_archived_at']
    // PARTIAL unique: WHERE archived_at IS NULL
    (phone_number) [unique, name: 'idx_recipients_phone_active']
  }
}

Table sms_logs {
  id int [pk, increment]
  recipient_phone varchar(20) [not null]
  message text [not null]
  status varchar(20) [not null]
  error_message text
  sms_id varchar(100)
  delivered_at timestamp
  failure_reason text
  sent_at timestamptz [default: `now()`]

  Indexes {
    (sent_at) [name: 'idx_sms_logs_sent_at']
    (status) [name: 'idx_sms_logs_status']
  }
}

Ref: activity_logs.user_name > users.username
Ref: sms_logs.recipient_phone > authorized_recipients.phone_number
Ref: sensors.device_id > devices.device_id
Ref: last_alerts.device_id > devices.device_id
```

---

*End of database schema.*
