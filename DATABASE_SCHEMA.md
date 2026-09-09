# CRAYvings Monitoring System - Database Schema

> Database: `crayvings_monitoring_system_db` (PostgreSQL)

## Overview

The database stores user accounts, device registry, sensor readings, alert state, activity/audit trails, SMS recipients, and SMS send history for the Smart Aquaculture Monitoring System for Crayfish Production. Foreign keys are enforced so related data is referenced, not duplicated.

## Table: users

Stores application login accounts with PBKDF2-hashed passwords and session tokens.

| Column            | Type         | Constraints              | Notes                                  |
| ----------------- | ------------ | ------------------------ | -------------------------------------- |
| id                | SERIAL       | PRIMARY KEY              |                                        |
| name              | VARCHAR(100) | NOT NULL                 | Display name                           |
| username          | VARCHAR(50)  | NOT NULL UNIQUE          | Login name (FK target for activity_logs) |
| email             | VARCHAR(255) | NOT NULL UNIQUE          |                                        |
| password_hash     | TEXT         | NOT NULL                 | PBKDF2 (`iterations:salt:hash`)        |
| role              | VARCHAR(20)  | NOT NULL DEFAULT 'user'  | `admin` or `user`                      |
| token             | VARCHAR(255) |                          | Active session token                   |
| created_at        | TIMESTAMP    | DEFAULT CURRENT_TIMESTAMP|                                        |
| updated_at        | TIMESTAMP    | DEFAULT CURRENT_TIMESTAMP|                                        |
| token_expires_at  | TIMESTAMP    |                          | 24-hour session token expiry           |

## Table: devices

Canonical registry of ESP32 devices. Referenced by `sensors` and `last_alerts`.

| Column     | Type         | Constraints              | Notes                                  |
| ---------- | ------------ | ------------------------ | -------------------------------------- |
| device_id  | VARCHAR(50)  | PRIMARY KEY              | ESP32 device identifier                |
| name       | VARCHAR(100) |                          | Optional friendly name                 |
| is_active  | BOOLEAN      | NOT NULL DEFAULT true    | Whether the device is enabled          |
| created_at | TIMESTAMP    | DEFAULT CURRENT_TIMESTAMP| Device first seen                      |
| last_seen  | TIMESTAMP    |                          | Latest reading timestamp               |

Devices are auto-registered server-side on first sensor ingest (`INSERT INTO devices ... ON CONFLICT ... UPDATE`) so the `sensors.device_id` FK never fails.

## Table: sensors

Time-series log of ESP32 sensor readings. One row per reading.

| Column       | Type          | Constraints                           | Notes                   |
| ------------ | ------------- | ------------------------------------- | ----------------------- |
| id           | SERIAL        | PRIMARY KEY                           |                         |
| device_id    | VARCHAR(50)   | NOT NULL, FK → `devices.device_id`    | ESP32 device identifier |
| temperature  | DECIMAL(5,2)  | DEFAULT 0                             | Degrees Celsius         |
| water_level  | DECIMAL(5,2)  | DEFAULT 0                             | Percent (%)             |
| ammonia      | DECIMAL(5,3)  | DEFAULT 0                             | ppm (MQ-137 sensor)     |
| timestamp    | TIMESTAMP     | DEFAULT CURRENT_TIMESTAMP             | Reading time            |

**Indexes:** `idx_sensors_timestamp` (timestamp DESC), `idx_sensors_device_id` (device_id).

## Table: sensor_settings

Singleton row of current alert thresholds for each sensor parameter.

| Column            | Type         | Constraints                    | Notes               |
| ----------------- | ------------ | ------------------------------ | ------------------- |
| id                | SERIAL       | PRIMARY KEY                    |                     |
| temp_min          | DECIMAL(5,2) | NOT NULL DEFAULT 20.0          | Min temperature (°C)|
| temp_max          | DECIMAL(5,2) | NOT NULL DEFAULT 31.0          | Max temperature (°C)|
| water_level_min   | DECIMAL(5,2) | NOT NULL DEFAULT 10.0          | Min water level (%) |
| water_level_max   | DECIMAL(5,2) | NOT NULL DEFAULT 100.0         | Max water level (%) |
| ammonia_min       | DECIMAL(5,2) | NOT NULL DEFAULT 0.25          | Min ammonia (ppm)   |
| ammonia_max       | DECIMAL(5,2) | NOT NULL DEFAULT 1.00          | Max ammonia (ppm)   |
| updated_at        | TIMESTAMP    | DEFAULT CURRENT_TIMESTAMP      |                     |

## Table: system_logs

Change and alert records for sensor parameters (feed the Alerts & Logs page and PDF export). Standalone — stores human-readable strings, no foreign keys.

| Column    | Type          | Constraints | Notes                                  |
| --------- | ------------- | ----------- | -------------------------------------- |
| id        | SERIAL        | PRIMARY KEY |                                        |
| action    | VARCHAR(100)  | NOT NULL    | e.g. `Alert`, `Change`, `Alert Resolved`, `Alert Muted` |
| parameter | VARCHAR(100)  | NOT NULL    | e.g. `Temperature`, `Water Level`, `Ammonia` |
| old_value | VARCHAR(50)   |             | Previous value or `Low`/`High`/status  |
| new_value | VARCHAR(50)   |             | New value or status (`good`, `warning`, `critical`) |
| timestamp | TIMESTAMP     | DEFAULT CURRENT_TIMESTAMP |                        |

**Indexes:** `idx_system_logs_timestamp` (timestamp DESC), `idx_system_logs_action` (action).

## Table: last_alerts

Current alert state per device per sensor key (used for alert deduplication/cooldown and restored from DB on server start).

| Column     | Type          | Constraints                                | Notes                                  |
| ---------- | ------------- | ------------------------------------------ | -------------------------------------- |
| device_id  | VARCHAR(50)   | PRIMARY KEY (composite), FK → `devices.device_id` | ESP32 device identifier |
| sensor_key | VARCHAR(50)   | PRIMARY KEY (composite)                    | e.g. `Temperature`, `Water Level`, `Ammonia` |
| status     | VARCHAR(20)   |                                            | `good`, `warning`, or `critical`       |
| value      | DECIMAL       |                                            | Reading that triggered/cleared the state |
| timestamp  | TIMESTAMP     |                                            |                                        |

## Table: activity_logs

Audit trail of user interactions (navigation, settings changes, device connect/disconnect, login/logout).

| Column       | Type         | Constraints                                        | Notes                                     |
| ------------ | ------------ | -------------------------------------------------- | ----------------------------------------- |
| id           | SERIAL       | PRIMARY KEY                                        |                                           |
| user_name    | VARCHAR(100) | DEFAULT 'Admin', FK → `users.username`             | Username of acting user                   |
| action_type  | VARCHAR(50)  | NOT NULL                                           | e.g. `navigation`, `settings_change`, `device_connect`, `device_disconnect`, `login`, `logout` |
| description  | TEXT         |                                                    | Human-readable event description          |
| module       | VARCHAR(100) |                                                    | App module where the event occurred       |
| timestamp    | TIMESTAMP    | DEFAULT CURRENT_TIMESTAMP                          |                                           |

**Indexes:** `idx_activity_logs_timestamp` (timestamp DESC), `idx_activity_logs_action_type` (action_type).

## Table: system_state

Simple key/value store for server-persisted runtime state (survives restarts).

| Column | Type         | Constraints | Notes                                           |
| ------ | ------------ | ----------- | ----------------------------------------------- |
| key    | VARCHAR(255) | PRIMARY KEY | e.g. `last_hourly_update_ts`, `sms_mute_until`  |
| value  | TEXT         |             |                                                 |

## Table: authorized_recipients

SMS recipients allowed to receive alert notifications.

| Column       | Type          | Constraints              | Notes                          |
| ------------ | ------------- | ------------------------ | ------------------------------ |
| id           | SERIAL        | PRIMARY KEY              |                                |
| phone_number | VARCHAR(20)   | NOT NULL UNIQUE          | Contact number in E.164 format |
| name         | VARCHAR(100)  |                          | Recipient display name         |
| is_active    | BOOLEAN       | DEFAULT true             | Whether alerts are sent here   |
| created_at   | TIMESTAMP     | DEFAULT CURRENT_TIMESTAMP|                                |
| updated_at   | TIMESTAMP     | DEFAULT CURRENT_TIMESTAMP|                                |

## Table: sms_logs

Audit trail of every SMS send attempt (sent/failed/muted) including SkySMS message IDs.

| Column          | Type        | Constraints                              | Notes                     |
| --------------- | ----------- | ---------------------------------------- | ------------------------- |
| id              | SERIAL      | PRIMARY KEY                              |                           |
| recipient_phone | VARCHAR(20) | NOT NULL, FK → `authorized_recipients.phone_number` | Phone SMS was sent to |
| message         | TEXT        | NOT NULL                                 | Full message body         |
| status          | VARCHAR(20) | NOT NULL                                 | `sent`, `failed`, `muted` |
| error_message   | TEXT        |                                          | Failure reason            |
| sms_id          | VARCHAR(100)|                                          | SkySMS message identifier |
| sent_at         | TIMESTAMP   | DEFAULT CURRENT_TIMESTAMP                |                           |

**Indexes:** `idx_sms_logs_sent_at` (sent_at DESC), `idx_sms_logs_status` (status).

## Foreign Key Relationships (enforced)

| Constraint            | Column(s)                                  | References                    | Delete rule          |
| --------------------- | ------------------------------------------ | ----------------------------- | -------------------- |
| `fk_activity_logs_user` | `activity_logs.user_name`                | `users.username`              | RESTRICT (update CASCADE) |
| `fk_sms_logs_recipient` | `sms_logs.recipient_phone`               | `authorized_recipients.phone_number` | CASCADE        |
| `fk_sensors_device`   | `sensors.device_id`                        | `devices.device_id`           | NO ACTION           |
| `fk_lastalerts_device`| `last_alerts.device_id`                    | `devices.device_id`           | NO ACTION           |

Notes:
- `activity_logs.user_name` is derived from the session token server-side for an accurate audit trail; falls back to the built-in `admin` account when no token is present.
- `last_alerts` is keyed by `(device_id, sensor_key)` so each device keeps its own alert state; derived from the latest `sensors` reading by the alert engine.
- `users.token` + `users.token_expires_at` implement 24-hour session authentication.
- `sensor_settings`, `system_state`, and `system_logs` are standalone tables (no foreign relationships).

## Data Retention

- `system_logs` and `sms_logs` older than **30 days** are automatically purged (cleanup runs on server startup and daily).
- The alert engine enforces SMS cooldowns (`warning` vs `critical` intervals) stored in the server config.

## Notes

- **Schema creation:** Tables are created outside this repository (e.g., manual setup in pgAdmin / SQL shell). The server only creates `system_state` and applies additive migrations (`ADD COLUMN IF NOT EXISTS`) for columns like `ammonia`, `ammonia_min/max`, and `token_expires_at`.
- **Hash format:** `password_hash` = `PBKDF2_ITERATIONS:salt_hex:hash_hex` (sha512, 600,000 iterations, 64-byte key).
- **Default admin:** seeded via `seed-admin.cjs` (`Administrator` / `admin` / `admin@crayvings.com`).
- **Device auto-registration:** the backend upserts `devices` on every sensor ingest so unknown ESP32 `device_id`s never violate `fk_sensors_device`.

---

## dbdiagram.io Schema (DBML)

Copy the block below into [dbdiagram.io](https://dbdiagram.io) to render the full diagram.

```dbml
Table users {
  id int [pk, increment]
  name varchar(100) [not null]
  username varchar(50) [not null, unique]
  email varchar(255) [not null, unique]
  password_hash text [not null]
  role varchar(20) [not null, default: "'user'"]
  token varchar(255)
  created_at timestamp [default: `now()`]
  updated_at timestamp [default: `now()`]
  token_expires_at timestamp
}

Table devices {
  device_id varchar(50) [pk]
  name varchar(100)
  is_active boolean [not null, default: true]
  created_at timestamp [default: `now()`]
  last_seen timestamp
}

Table sensors {
  id int [pk, increment]
  device_id varchar(50) [not null]
  temperature decimal(5,2) [default: 0]
  water_level decimal(5,2) [default: 0]
  ammonia decimal(5,3) [default: 0]
  timestamp timestamp [default: `now()`]

  Indexes {
    (timestamp) [name: 'idx_sensors_timestamp']
    (device_id) [name: 'idx_sensors_device_id']
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
  timestamp timestamp [default: `now()`]

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
  user_name varchar(100) [default: "'Admin'"]
  action_type varchar(50) [not null]
  description text
  module varchar(100)
  timestamp timestamp [default: `now()`]

  Indexes {
    (timestamp) [name: 'idx_activity_logs_timestamp']
    (action_type) [name: 'idx_activity_logs_action_type']
  }
}

Table system_state {
  key varchar(255) [pk]
  value text
}

Table authorized_recipients {
  id int [pk, increment]
  phone_number varchar(20) [not null, unique]
  name varchar(100)
  is_active boolean [default: true]
  created_at timestamp [default: `now()`]
  updated_at timestamp [default: `now()`]
}

Table sms_logs {
  id int [pk, increment]
  recipient_phone varchar(20) [not null]
  message text [not null]
  status varchar(20) [not null]
  error_message text
  sms_id varchar(100)
  sent_at timestamp [default: `now()`]

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