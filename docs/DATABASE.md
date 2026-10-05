# CRAYvings Monitoring System — Database Schema

**Database:** `crayvings_monitoring_system_db` (PostgreSQL)

> **Verified against the live database 2026-09-28**, after applying migrations
> through 016. Every table, column, type, nullability, default, index, check
> constraint, and foreign key below was read back from `information_schema` /
> `pg_catalog` — not inferred from the migration scripts.
>
> **14 tables. 4 foreign keys, all `device_id` → `devices.device_id`.** The DBML
> block near the bottom is ready to paste into <https://dbdiagram.io>.
>
> **Two relationships that look like they should be foreign keys but are not:**
>
> - `sms_logs.recipient_phone` → `authorized_recipients.phone_number` — cannot
>   be an FK, because migration 006 made `phone_number` unique only via a
>   *partial* index. Enforced by trigger `trg_sms_logs_recipient` instead.
> - `activity_logs.user_name` → `users.username` — **no FK exists at all.**
>   Migrations 001/002 create it; something later removed it. A genuine gap,
>   also blocked by a partial index. Not drawn as a `Ref` in the DBML, because
>   drawing an unenforced relationship as enforced is how a diagram starts
>   lying.

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
| `username` | VARCHAR(50) | NOT NULL | Login name. **Intended** FK target for `activity_logs.user_name`, but no such foreign key currently exists — see *Foreign Key Relationships*. UNIQUE only while active (partial index `idx_users_username_active`) |
| `email` | VARCHAR(255) | NOT NULL | UNIQUE only while active (partial index `idx_users_email_active`) |
| `password_hash` | TEXT | NOT NULL | PBKDF2 (`iterations:salt:hash`) |
| `role` | VARCHAR(20) | NOT NULL DEFAULT `'user'` | `admin` or `user` |
| `token` | VARCHAR(255) | | Active session token, stored **hashed** as SHA-256 (migration 013) — never the raw value, so a DB read cannot impersonate a user. Clients keep the raw 64-char hex token and every comparison hashes it first |
| `created_at` | **TIMESTAMP** | DEFAULT CURRENT_TIMESTAMP | Timezone-naive |
| `updated_at` | **TIMESTAMP** | DEFAULT CURRENT_TIMESTAMP | Timezone-naive |
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
| `device_id` | VARCHAR(50) | PRIMARY KEY | ESP32 device identifier. `idx_devices_device_id_ci` adds a **case-insensitive** unique index on `LOWER(device_id)` (migration 014) so `esp32-01` and `ESP32-01` cannot both be registered. Archived rows keep the ID reserved forever. If duplicate case-variants exist when 014 runs, the unique index is **not** created and a non-unique `idx_devices_device_id_folded` is added instead — see "Blocked migration 014" below |
| `name` | VARCHAR(100) | | Optional friendly name. Written by `POST /devices` alongside `tank_name` |
| `is_active` | BOOLEAN | NOT NULL DEFAULT true | Whether the device is enabled. Cleared on archive, restored on un-archive |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | Device first seen (migration 007) |
| `last_seen` | TIMESTAMPTZ | | Latest reading timestamp (migration 007) |
| `ip_address` | TEXT | | Static LAN IP of the device (e.g. `192.168.4.101`); needed by the device poller to reach `GET /status`. An admin may correct it via `PUT /devices/:deviceId { ip_address }`, which also flips `ip_source` to `'manual'` so ingest stops overwriting it |
| `tank_name` | VARCHAR(100) | | Friendly tank label (e.g. "Tank 3 - Bayside") — the actual display label everywhere |
| `tank_location` | VARCHAR(100) | | Physical location / zone |
| `device_secret` | VARCHAR(255) | | Optional per-device ingestion secret (migration 008). When set, `POST /sensor` accepts this value in `X-Device-Secret` for this device; otherwise the shared `DEVICE_SECRET` applies. Deliberately opt-in — nothing is auto-generated, but an admin can issue one via `POST /devices/:deviceId/rotate-secret` (see below) |
| `last_health_seen` | TIMESTAMPTZ | | Last successful `GET /status` poll (health only; `sensors` rows are **not** written by the poller) |
| `registered_via` | VARCHAR(20) | NOT NULL DEFAULT 'auto', CHECK IN ('manual','auto') | How the row entered the registry (migration 014). `manual` = `POST /devices`; `auto` = first-contact upsert from `POST /sensor`. Read-only provenance — it never blocks ingestion |
| `ip_source` | VARCHAR(10) | NOT NULL DEFAULT 'auto', CHECK IN ('manual','auto') | Who last set `ip_address` (migration 014). When `manual`, sensor ingest will **not** overwrite the IP, so an Owner-entered address survives firmware that reports a different one |
| `archived_at` | TIMESTAMPTZ | | Soft-delete marker (migration 014). NULL = live. Indexed via `idx_devices_archived_at`. All active-list queries filter `archived_at IS NULL` |
| `archived_by` | VARCHAR(100) | | Username of the admin who archived the device (migration 014) |
| `device_secret_rotated_at` | TIMESTAMPTZ | | When the current per-device secret was issued (migration 015). Metadata only; `NULL` for a device that has never had a per-device secret. Read endpoints expose this — never the secret itself |
| `device_secret_prev` | VARCHAR(255) | | The **outgoing** per-device secret, still accepted until its deadline (migration 015). `NULL` when there is no live grace window (never rotated, revoked immediately, or first-secret migration) |
| `device_secret_prev_expires_at` | TIMESTAMPTZ | | The instant `device_secret_prev` stops being accepted (migration 015). The deadline is compared in SQL on every `POST /sensor`, so a lapsed secret dies on its own with no cleanup job. Pairs with `device_secret_prev` via `chk_devices_secret_prev_pair` |

**Secret columns never leave the database.** The shared `DEVICE_COLUMNS` projection
used by every device read endpoint lists only `device_secret_rotated_at` and
`device_secret_prev_expires_at`; `device_secret` and `device_secret_prev` are
excluded. A new secret is returned exactly once, by the
`POST /devices/:deviceId/rotate-secret` response that created it, and is never
written to `system_logs`, `activity_logs`, or the server log — only the *fact* of
a rotation is recorded (`activity_logs.action_type = 'DEVICE_SECRET_ROTATED'`).

### Secret rotation (migration 015)

A board can only learn a new secret through its WiFiManager config portal, so
rotating is inherently a physical task: somebody has to reach the tank. Rotating
with no overlap would guarantee an outage, and for a board that is *already*
unreachable — the usual reason to rotate after a suspected compromise — it would
leave it unable to report until someone carries a laptop to the tank. So the
outgoing secret stays valid for a bounded, explicit grace window.

| Rule | Behaviour |
|---|---|
| Default grace | 24h. Caller may pass `grace_hours` (0–168, hard-capped at 7 days); `DEVICE_SECRET_GRACE_MS` overrides the default |
| Immediate revoke | `grace_hours: 0` parks **no** previous secret — the old one stops working at once (a compromise response) |
| Deadline enforcement | `device_secret_prev_expires_at > NOW()` inside the auth query, so a lapsed secret stops working the moment its window closes without depending on any cleanup job |
| First-secret migration | A device still on the shared `DEVICE_SECRET` cannot be *rotated*; `POST .../rotate-secret` returns `409` with `can_migrate_from_shared`, and the caller must explicitly send `migrate_from_shared: true`. Both prev columns stay `NULL` because there is no previous **per-device** secret to park, and the response reports `devices_still_on_shared_secret` |
| Atomicity | One `UPDATE` swaps `device_secret` while parking the old value, so a reader can never see both columns `NULL` (locked out) or both set to the same value |
| Archived devices | Rejected with `409` — an archived ID is permanently retired, so there is nothing to rotate |

**Check constraints**

| Constraint | Definition |
|---|---|
| `chk_devices_secret_prev_pair` | `(device_secret_prev IS NULL) = (device_secret_prev_expires_at IS NULL)` — the secret and its deadline are meaningless apart; storing one without the other would either silently disable the grace window or make the auth path compare against a secret it can never expire |

**Indexes**

| Index | Definition | Purpose |
|---|---|---|
| `idx_devices_device_id_ci` | `UNIQUE (LOWER(device_id))` | Case-insensitive uniqueness. This — not `devices_pkey` — is the guarantee that `esp32-01` and `ESP32-01` cannot both exist (migration 014) |
| `idx_devices_archived_at` | `(archived_at)` | Supports the `archived_at IS NULL` filter on every active-device query |
| `idx_devices_device_secret` | `(device_secret) WHERE device_secret IS NOT NULL` | PARTIAL: per-device ingest secret lookup. Devices with no secret stay `NULL` and are excluded |
| `idx_devices_secret_prev` | `(device_secret_prev) WHERE device_secret_prev IS NOT NULL` | PARTIAL: the auth lookup for a previous secret. Most devices never rotate and stay `NULL` |
| `idx_devices_secret_prev_expires` | `(device_secret_prev_expires_at) WHERE device_secret_prev_expires_at IS NOT NULL` | PARTIAL: expiry is evaluated per request, so a lapsed window must be bulk-cleanable rather than only on that device's next request |

`idx_devices_device_id_folded` is deliberately **not** listed: migration 014
creates it only as a fallback when case-variant duplicates make the unique index
impossible. It does not exist on the live database.

Devices can be registered explicitly with `POST /devices` (admin only), which sets
`registered_via='manual'` and records the activity. They are **also** still
auto-registered server-side on first sensor ingest
(`INSERT INTO devices ... ON CONFLICT ... UPDATE` → `registered_via='auto'`) so the
`sensors.device_id` FK never fails for an un-registered board. Auto-registration is
a safety net, not the intended workflow. `tank_name` / `tank_location` / `name` are
static registry metadata and are never overwritten by ingests; `ip_address` is
overwritten by ingest only while `ip_source='auto'`.

### Claiming an auto-discovered device

`POST /devices` doubles as the claim operation, so an un-registered board does not
have to be renamed in firmware to get a tank name. A duplicate `device_id` is
rejected with `409` **only** when the existing row is archived (permanently
retired) or already `registered_via='manual'`. When the existing row is
`registered_via='auto'` and live, the request instead **updates** it in place:

- `registered_via` flips `'auto'` → `'manual'`, `is_active` is set `true`, and
  `name` / `tank_name` / `tank_location` / `ip_address` are set with `COALESCE`
  (a submitted `ip_address` also flips `ip_source` to `'manual'`).
- `activity_logs` gets `action_type = 'DEVICE_CLAIMED'`.
- The response is `200` (not `201`) and computes `online` from `last_seen`, because
  a board that had to be claimed is usually already reporting — hardcoding
  `online: false` would flash "Offline" until the next reload.

The upsert uses `RETURNING (xmax = 0) AS auto_registered` to tell a row a request
*created* from one it merely refreshed. That flag is logged server-side and
returned on both `POST /sensor` response paths, so the classic
firmware/registration mismatch is visible on the board's serial monitor instead of
only as an "Auto-discovered" badge.

### Blocked migration 014 (case-insensitive uniqueness) — did NOT happen

**This is a contingency, not a description of the live database.** Verified
2026-09-28: `idx_devices_device_id_ci` exists and **is unique**, and
`schema_migrations` contains version `014`. Migration 014 applied cleanly, and
`idx_devices_device_id_folded` does not exist. Nothing is blocked.

The behaviour below is retained for reference in case it is ever needed again.

If pre-existing rows contain case-variant duplicates (`esp32-01` / `ESP32-01`),
migration 014 still commits its columns, checks, and backfill — rolling those back
would be worse than the problem — but it **cannot** create
`idx_devices_device_id_ci`, so it:

- adds a non-unique `idx_devices_device_id_folded` on `LOWER(device_id)` to keep
  the app's `lower(device_id)` lookups index-backed. It is deliberately *not*
  named `idx_devices_device_id_ci`, because `CREATE UNIQUE INDEX IF NOT EXISTS` is
  a no-op when *any* index of that name exists — reusing the name would leave a
  non-unique index sitting on the target forever.
- **does not** record version `014` in `schema_migrations` and exits non-zero, so a
  migration runner cannot treat a half-applied version as complete.
- drops a non-unique `idx_devices_device_id_ci` left by an earlier blocked run
  before building the unique one, and reports whether the index is present *and*
  unique (a non-unique index of the right name otherwise reads as "present").

Resolve the duplicates listed in the migration output and re-run 014.

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
| Sensor readings retained | yes | yes — `sensors` and `last_alerts` FKs are `NO ACTION`, `system_logs` is `SET NULL`, `device_threshold_overrides` is `CASCADE` (configuration, not history) |

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
| `ammonia` | DECIMAL(5,2) | DEFAULT 0, NULLABLE | ppm (MQ-137 sensor). `NULL` when the MQ-137 failed (firmware reports −1). **Precision is (5,2)**, verified against the live database — it was previously documented here as (5,3) |
| `timestamp` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | Reading time (migration 007) |

Since migration 009 the server converts firmware failure sentinels to `NULL`
before the row is written; existing sentinel rows were migrated to `NULL`. Both
firmwares convert the DS18B20's −127 disconnect code to −1 before sending, so
the **wire** sentinels are: `temperature` −1 or 0, `water_level` −1, `ammonia`
−1. `temperature <= 0` is treated as a failure (tropical farm; the client chart
filter and alert engine use the same rule). CHECK constraints enforce this at
the database level.

All three columns are nullable in practice — a NULL reading records a failed
sensor rather than a rejected row, which is why the CHECK constraints below all
permit NULL.

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
| `idx_sensors_device_id_ci` | `(LOWER(device_id), timestamp DESC)` | The app resolves tanks case-insensitively (`lower(device_id)` in `server.cjs`), which the plain btree indexes above cannot serve — `EXPLAIN` showed a `Seq Scan` on every history query. Built `CONCURRENTLY` by migration 016 so ingest is never blocked. Verified: the planner now reports `Bitmap Index Scan on idx_sensors_device_id_ci` |

**Check constraints** (migration 009) — each permits `NULL`, because a NULL
reading records a failed sensor rather than a valid one:

| Constraint | Rule |
|---|---|
| `chk_sensors_temperature_valid` | `0 < temperature <= 100` |
| `chk_sensors_water_level_valid` | `0 <= water_level <= 200` |
| `chk_sensors_ammonia_valid` | `0 <= ammonia <= 1000` |

---

## Table: `sensor_settings`

Singleton row of current alert thresholds for each sensor parameter.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `temp_min` | DECIMAL(5,2) | NULLABLE, DEFAULT 20.0 | Min temperature (°C) |
| `temp_max` | DECIMAL(5,2) | NULLABLE, DEFAULT 31.0 | Max temperature (°C) |
| `water_level_min` | DECIMAL(5,2) | NULLABLE, DEFAULT 10.0 | Min water level (%) |
| `water_level_max` | DECIMAL(5,2) | NULLABLE, DEFAULT 100.0 | Max water level (%) |
| `ammonia_min` | DECIMAL(5,2) | NULLABLE, DEFAULT 0.25 | Min ammonia (ppm) |
| `ammonia_max` | DECIMAL(5,2) | NULLABLE, DEFAULT 1.00 | Max ammonia (ppm) |
| `updated_at` | **TIMESTAMP** | DEFAULT CURRENT_TIMESTAMP | Timezone-naive |

All six range columns have defaults but **no `NOT NULL` constraint** — verified
against `information_schema.columns`. This document previously listed them as
`NOT NULL`.

---

## Table: `device_threshold_overrides`

Per-tank threshold ranges layered on top of the global `sensor_settings`
singleton (migration 012). At most one row per device. **Every range column is
nullable and `NULL` means "inherit the global value"**, resolved at read time as
`COALESCE(override, global)` by `getThresholdsForDevice` in `server.cjs`.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `device_id` | VARCHAR(50) | PRIMARY KEY, FK → `devices.device_id` (`ON DELETE CASCADE`) | Tank the override applies to |
| `temp_min` | DECIMAL(5,2) | NULLABLE | Overrides `sensor_settings.temp_min`. `NULL` = inherit |
| `temp_max` | DECIMAL(5,2) | NULLABLE | Overrides `sensor_settings.temp_max`. `NULL` = inherit |
| `water_level_min` | DECIMAL(5,2) | NULLABLE | Overrides `sensor_settings.water_level_min`. `NULL` = inherit |
| `water_level_max` | DECIMAL(5,2) | NULLABLE | Overrides `sensor_settings.water_level_max`. `NULL` = inherit |
| `ammonia_min` | DECIMAL(5,2) | NULLABLE | Overrides `sensor_settings.ammonia_min`. `NULL` = inherit |
| `ammonia_max` | DECIMAL(5,2) | NULLABLE | Overrides `sensor_settings.ammonia_max`. `NULL` = inherit |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | Last write to the row |

**Notes**

- No backfill exists or is needed: the *absence* of a row **is** the
  inherit-from-global state, so every tank starts on the current global
  thresholds and existing data is untouched.
- Overrides are per-column, not per-row — setting only `temp_max` leaves
  `temp_min` on the global value.
- If the table is missing (migration 012 not applied), `getThresholdsForDevice`
  catches the query and degrades quietly to the global thresholds, so alerting
  keeps working on a server started without migrations.
- `server.cjs` also runs `CREATE TABLE IF NOT EXISTS` for this table on boot,
  mirroring migration 012, so a fresh database is usable before the migration is
  run manually.
- This is the one FK into `devices` with `ON DELETE CASCADE`: overrides are
  configuration, not history, so they go when the device does. There is no hard
  delete of a device in this system, so in practice it never fires.

---

## Table: `system_logs`

Change and alert records for sensor parameters (feed the Alerts & Logs page and
PDF export). Stores human-readable strings; the only relationship is the
per-tank attribution added in migration 011.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `action` | VARCHAR(100) | NOT NULL | e.g. `Alert`, `Change`, `Alert Resolved`, `Alert Muted`, `Device Disconnect` |
| `parameter` | VARCHAR(100) | NOT NULL | e.g. `Temperature`, `Water Level`, `Ammonia`; for a `Device Disconnect` row it carries the `device_id` |
| `old_value` | VARCHAR(50) | | Previous value or Low/High/status |
| `new_value` | VARCHAR(50) | | New value or status (`good`, `warning`, `critical`) |
| `ack_status` | VARCHAR(20) | | `confirmed` or `allowed` (set when an alert is acknowledged) |
| `acknowledged_at` | TIMESTAMPTZ | | When acknowledged. Converted from naive `TIMESTAMP` by migration 016 |
| `acknowledged_by` | VARCHAR(100) | | Username of the acknowledger |
| `timestamp` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | (migration 007) |
| `device_id` | VARCHAR(50) | NULLABLE, FK → `devices.device_id` (migration 011, `ON DELETE SET NULL`) | Per-tank attribution for threshold alerts, alert-resolves, device disconnects, and settings changes. `NULL` = farm-wide/global, which also covers every row that predates migration 011. Indexed with `timestamp` for per-tank log queries |

Migration 011 backfilled the only derivable rows: `Device Disconnect` entries
whose `parameter` matches a live `device_id`. Disconnect strings that do not
(`DEVICE` / `ESP32` / `TEST`) deliberately stay `NULL`.

**Data anomaly (pre-existing, left uncorrected):** 2 of the 6 acknowledged rows
(`id` 1982 and 2002, both by `admin`, dated 2026-09-12/13) hold
`acknowledged_at` values roughly 8 hours *earlier* than the `timestamp` on the
same row. That is the `Asia/Kuala_Lumpur` (+8) UTC offset, so the admin's client
was on UTC while the server is +8. This predates migration 016 and is not
caused by it — the naive `TIMESTAMP` column simply made it invisible. The values
were **not** patched, because the correct value is ambiguous and overwriting
would destroy the evidence.

**Indexes**

| Index | Definition |
|---|---|
| `idx_system_logs_timestamp` | `(timestamp DESC)` |
| `idx_system_logs_action` | `(action)` |
| `idx_system_logs_ack_status` | `(ack_status)` — created on server boot (`server.cjs`), not by a migration script |
| `idx_system_logs_device_ts` | `(device_id, timestamp DESC)` — per-tank log queries (migration 011) |

---

## Table: `last_alerts`

Current alert state per device per sensor key (used for alert
deduplication/cooldown and restored from DB on server start).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `device_id` | VARCHAR(50) | PRIMARY KEY (composite), FK → `devices.device_id` | ESP32 device identifier |
| `sensor_key` | VARCHAR(50) | PRIMARY KEY (composite) | e.g. `Temperature`, `Water Level`, `Ammonia` |
| `status` | VARCHAR(20) | | `good`, `warning`, or `critical` |
| `value` | DECIMAL(5,2) | | Reading that triggered / cleared the state |
| `timestamp` | TIMESTAMPTZ | | Alert state change time. Converted from naive `TIMESTAMP` by migration 016 |

---

## Table: `activity_logs`

Audit trail of user interactions (navigation, settings changes, device
connect/disconnect, login/logout).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `user_name` | VARCHAR(100) | NULLABLE. **No FK exists** — see below | Username of acting user, derived server-side from the session. Intended `ON DELETE SET NULL` (migrations 001/002) so an audit row survives account deletion |
| `action_type` | VARCHAR(50) | NOT NULL | e.g. `navigation`, `settings_change`, `device_connect`, `device_disconnect`, `login`, `logout`, `DEVICE_CLAIMED`, `DEVICE_SECRET_ROTATED` |
| `description` | TEXT | | Human-readable event description |
| `module` | VARCHAR(100) | | App module where the event occurred |
| `timestamp` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | Converted from naive `TIMESTAMP` by migration 016 |

**Indexes**

| Index | Definition |
|---|---|
| `idx_activity_logs_timestamp` | `(timestamp DESC)` |
| `idx_activity_logs_action_type` | `(action_type)` |

**This is the only table in the database with no foreign key at all**, and it is
the source of the largest documentation error in this file's history. Migrations
001 and 002 both add `activity_logs_user_name_fkey` referencing
`users.username` with `ON DELETE SET NULL` / `ON UPDATE CASCADE`, so the
constraint existed and was later removed — nothing in the current migration set
re-creates it. 2,700+ rows can name a `user_name` matching no account.

It cannot simply be re-added, for the same structural reason as
`sms_logs.recipient_phone`: `users.username` is unique only via the *partial*
index `idx_users_username_active (WHERE status IS DISTINCT FROM 'archived')`, and
PostgreSQL will not reference a partial index from a foreign key. Restoring a
full `UNIQUE` would undo migration 006's deliberate username-reuse-after-archive
design.

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
| `created_at` | **TIMESTAMP** | DEFAULT NOW() | Timezone-naive, unlike `archived_at` on this same row |
| `updated_at` | **TIMESTAMP** | DEFAULT NOW() | Timezone-naive |

**Indexes**

| Index | Definition |
|---|---|
| `idx_recipients_archived_at` | `(archived_at)` |
| `idx_recipients_phone_active` | `UNIQUE (phone_number) WHERE archived_at IS NULL` |

**Archive/restore (migration 006)**

- Archive sets `archived_at = NOW()` (row kept, restorable); restore clears it.
- SMS sending only considers recipients `WHERE is_active = true AND archived_at IS NULL`.
- `phone_number`'s plain UNIQUE constraint was replaced by the partial unique
  index above so an archived number does not block re-adding it later. This is
  also precisely why `sms_logs.recipient_phone` **cannot** be a foreign key to
  it — see *Foreign Key Relationships*.
- Permanently purging an archived recipient is the only irreversible action.

---

## Table: `sms_logs`

Audit trail of every SMS send attempt (`queued`/`delivered`/`failed`/`capped`).
`queued` rows are reconciled by the delivery poller against httpsms, which nails
down `delivered_at` / `failure_reason` so every SMS reaches a terminal state.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `recipient_phone` | VARCHAR(20) | NOT NULL; no FK (see note below) | Phone SMS was sent to |
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

**Referential integrity**

`recipient_phone` is *not* a foreign key, and cannot be one while migration 006's
partial unique index `idx_recipients_phone_active` exists — see the
**`sms_logs.recipient_phone` has NO foreign key, by necessity** section under
*Foreign Key Relationships*.

Migration 016 enforces the intent with the trigger `trg_sms_logs_recipient`
(installed, `enabled=origin`), which fires `BEFORE INSERT OR UPDATE OF
recipient_phone` and raises a `foreign_key_violation` when no matching
`authorized_recipients` row exists.

The 5 pre-existing orphan rows (ids 970, 974, 979, 984, 989 — all one recipient
number, all 2026-09-16, 4 `queued` + 1 `failed`) were **left in place by
design**: whether an alert was actually delivered is an operator decision, and
deleting or reassigning them would fabricate a delivery record.

---

## Table: `schema_migrations`

Version tracking for the `db/migrations/*.cjs` scripts (migration 010). Seeded
with the history of migrations 001-010 so operators can see which structural
changes have been applied. Verified present: versions `001`–`016`, with `016`
applied 2026-09-28.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `version` | VARCHAR(50) | PRIMARY KEY | Migration number (e.g. `"009"`) |
| `name` | VARCHAR(255) | NOT NULL | Migration slug |
| `applied_at` | TIMESTAMPTZ | NOT NULL (DEFAULT NOW()) | When it was applied |
| `checksum` | VARCHAR(64) | | Reserved for future use |

---

## Foreign Key Relationships (enforced)

Verified against `information_schema.referential_constraints` on 2026-09-28.
There are **exactly four** foreign keys, all `device_id` → `devices.device_id`:

| Constraint | Column(s) | References | Delete rule |
|---|---|---|---|
| `fk_sensors_device` | `sensors.device_id` | `devices.device_id` | `NO ACTION` |
| `fk_lastalerts_device` | `last_alerts.device_id` | `devices.device_id` | `NO ACTION` |
| `fk_system_logs_device` | `system_logs.device_id` | `devices.device_id` | `SET NULL` (migration 011) |
| `fk_device_threshold_overrides_device` | `device_threshold_overrides.device_id` | `devices.device_id` | `CASCADE` (migration 012) |

The first column lists logical labels. No migration names these constraints, so in
the live database they carry the PostgreSQL defaults (`sensors_device_id_fkey`,
`last_alerts_device_id_fkey`, `system_logs_device_id_fkey`,
`device_threshold_overrides_device_id_fkey`).

### `activity_logs.user_name` is NOT a foreign key — a real gap

This document previously listed `fk_activity_logs_user` (`ON DELETE SET NULL`,
update `CASCADE`) in the table above. **That constraint does not exist in the
live database.** Migrations 001 and 002 both add it under the name
`activity_logs_user_name_fkey`, so it existed at some point and was removed
later; nothing in the current migration set re-creates it. Verified by querying
`information_schema.referential_constraints`: the four `device_id` constraints
above are the complete set.

The practical consequence: 2,700+ `activity_logs` rows can name a `user_name`
that no longer matches any `users.username`, and a new row can name a user that
never existed. Nothing rejects it at the database level — the value is
server-derived from the session, so it is correct in normal operation, but the
database is not guarding it.

It also cannot simply be added, for the same structural reason as
`sms_logs.recipient_phone`: `users.username`'s `UNIQUE` is the *partial* index
`idx_users_username_active (WHERE status IS DISTINCT FROM 'archived')`, and a
foreign key cannot reference a partial index. Restoring a full `UNIQUE` would
undo migration 006's deliberate username-reuse-after-archive design.

Closing this needs a real decision, not a mechanical fix — leave it unenforced
and rely on the server, or change the uniqueness model to allow the FK. It is
**not** drawn as a `Ref` in the DBML below, because drawing an unenforced
relationship as an enforced one is exactly the kind of drift that makes a
diagram lie.

A trigger, as used for `sms_logs` below, is an option worth considering here
too — it would enforce the same intent for new rows without needing a unique
index. It was not added because it is a change you have not asked for, and
unlike the SMS case there is no live corruption to stop.

### `sms_logs.recipient_phone` has NO foreign key, by necessity

This document previously listed `fk_sms_logs_recipient ... ON DELETE CASCADE`.
That constraint has never existed — no migration in `db/migrations/` ever
created it; `003_sms_integration.cjs` created both tables without it — and it
cannot be added as originally intended, because a foreign key must reference a
`UNIQUE` **constraint** or a non-partial unique index, while migration 006
replaced `authorized_recipients.phone_number`'s `UNIQUE` with the *partial*
index `idx_recipients_phone_active (... WHERE archived_at IS NULL)`. PostgreSQL
rejects the reference with *"there is no unique constraint matching given keys."*

Restoring a full `UNIQUE` would undo 006's deliberate design (letting an archived
recipient's number be reused), and a column cannot back both a foreign key and a
partial index. The conflict is structural, not an oversight.

Migration 016 therefore enforces the same intent with a trigger,
`trg_sms_logs_recipient` (function `check_sms_logs_recipient`), which rejects
`INSERT` and `UPDATE OF recipient_phone` when no matching recipient exists. The
5 pre-existing orphan rows are deliberately left in place: whether an alert was
actually delivered is an operator decision, not something a migration may invent.

This is **weaker** than a foreign key in one respect worth knowing: the trigger
only fires on write to `sms_logs`. If a recipient row is later hard-deleted, an
FK's `ON DELETE CASCADE` would have removed its `sms_logs` rows; the trigger
does not. Recipients are archived rather than deleted, so this path is rare.

**Notes**

- `activity_logs.user_name` is derived from the session token server-side, so it
  is correct in normal operation. The FK described above (`ON DELETE SET NULL` so
  an audit row survives account deletion, `ON UPDATE CASCADE` for renames) is
  **not currently present** — see the section above.
- `user_deletion_requests` and `email_otps` deliberately define **no** foreign
  key constraints so the request/OTP pipeline still works after the target
  account is hard-deleted.
- `last_alerts` is keyed by `(device_id, sensor_key)` so each device keeps its
  own alert state; derived from the latest `sensors` reading by the alert engine.
- `users.token` + `users.token_expires_at` implement 24-hour session
  authentication.
- `system_state` and `schema_migrations` are standalone by nature. The only
  relationship on `system_logs` is the nullable per-tank attribution added in
  migration 011. `sensor_settings` is a deliberate singleton with no FK — it
  holds one global threshold row, and per-tank overrides live in
  `device_threshold_overrides` instead.

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
  | `014_device_registration.cjs` | Device registration & archive: `devices.archived_at`/`archived_by`/`registered_via`/`ip_source`; checks `chk_devices_registered_via`/`chk_devices_ip_source`/`chk_devices_archived_pair`; indexes `idx_devices_archived_at` + case-insensitive unique `idx_devices_device_id_ci` on `LOWER(device_id)`; backfills `registered_via='manual'` for pre-existing rows that had a `tank_name`. Records itself in `schema_migrations` **only** when the unique index is genuinely in place; on case-variant duplicates it commits the rest, falls back to a non-unique `idx_devices_device_id_folded`, and exits non-zero |
  | `015_device_secret_rotation.cjs` | Per-device secret rotation: `devices.device_secret_rotated_at`, `devices.device_secret_prev`, `devices.device_secret_prev_expires_at`; check `chk_devices_secret_prev_pair`; partial indexes `idx_devices_secret_prev` + `idx_devices_secret_prev_expires` |
  | `016_audit_fixes.cjs` | Fixes from the 2026-09-28 read-only audit: functional index `idx_sensors_device_id_ci` on `sensors (LOWER(device_id), "timestamp" DESC)` built `CONCURRENTLY`; `sms_logs.recipient_phone` integrity via trigger `trg_sms_logs_recipient` (an FK is impossible while 006's partial unique index exists); clears `token`/`token_expires_at` on non-active users; `system_logs.acknowledged_at`, `activity_logs.timestamp`, `last_alerts.timestamp` → `TIMESTAMPTZ` |

- **Hash format:** `password_hash = PBKDF2_ITERATIONS:salt_hex:hash_hex` (sha512,
  600,000 iterations, 64-byte key).
- **Owner/root admin:** seeded by `db/migrations/002_owner_admin.cjs` from
  `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` (no hardcoded
  default admin).
- **Device auto-registration:** the backend upserts `devices` on every sensor
  ingest so unknown ESP32 `device_id`s never violate `fk_sensors_device`.

---

## ERD Source (DBML for dbdiagram.io)

Copy the block below into <https://dbdiagram.io> to render the diagram. It
contains all **14 tables** and the **4 real foreign keys**, verified against the
live database.

Things to know before you paste it:

- **The `users` table will look disconnected.** It is the only table with no
  foreign keys pointing into it, because `activity_logs.user_name` is
  unenforced. If you want the intended relationship visible in the diagram, add
  this line yourself — but know that it is aspirational, not enforced:
  `Ref: activity_logs.user_name > users.username`
- **`sms_logs` will also look disconnected** from `authorized_recipients`, and
  that one is structural — it *cannot* be a foreign key. Integrity is enforced
  by a trigger, which no ERD tool can draw.
- `schema_migrations` is bookkeeping and has no relationships; it is included
  only so the table count matches. Delete it freely if you want a cleaner
  diagram.
- Indexes are included but most ERD tools ignore them — they are there for
  documentation, not for rendering.

```dbml
// Full schema and enforcement notes: see DATABASE.md

Table users {
  id int [pk, increment]
  name varchar(100) [not null]
  username varchar(50) [not null]
  email varchar(255) [not null]
  password_hash text [not null]
  role varchar(20) [not null, default: "'user'"]
  token varchar(255)
  // NOTE: created_at/updated_at are `timestamp` (naive) in the live database,
  // not timestamptz. token_expires_at was converted by migration 005.
  created_at timestamp [default: `now()`]
  updated_at timestamp [default: `now()`]
  token_expires_at timestamptz
  status varchar(20) [not null, default: "'active'"]
  deleted_at timestamptz
  pending_deletion_at timestamptz
  pending_deletion_requested_by varchar(100)

  Note: 'Referenced by username (soft reference) from several audit columns. Usernames can be reused after archiving (migration 006).'

  Indexes {
    (status) [name: 'idx_users_status']
    // Allows an archived account's username to be reused by a new account.
    (username) [unique, name: 'idx_users_username_active', note: 'PARTIAL: WHERE status IS DISTINCT FROM \'archived\' (migration 006)']
    (email) [unique, name: 'idx_users_email_active', note: 'PARTIAL: WHERE status IS DISTINCT FROM \'archived\'']
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
  // Secret rotation (migration 015). Of the four secret columns, the API only
  // ever projects the two *_rotated_at / *_prev_expires_at metadata fields.
  device_secret_rotated_at timestamptz
  device_secret_prev varchar(255)
  device_secret_prev_expires_at timestamptz

  // Check constraints (migrations 014 / 015):
  //   chk_devices_registered_via: registered_via IN ('manual','auto')
  //   chk_devices_ip_source:      ip_source IN ('manual','auto')
  //   chk_devices_archived_pair:   (archived_at IS NULL) = (archived_by IS NULL)
  //   chk_devices_secret_prev_pair:(device_secret_prev IS NULL)
  //                               = (device_secret_prev_expires_at IS NULL)
  //
  // idx_devices_device_id_folded is NOT listed: migration 014 creates it only
  // when case-variant duplicates block the unique index. It does not exist live.

  Note: 'Devices are archived (archived_at), not deleted. FKs from sensors and last_alerts therefore use the default NO ACTION.'

  Indexes {
    // 'esp32-01' and 'ESP32-01' collide. This is the UNIQUE guarantee, not devices_pkey.
    (`lower(device_id)`) [unique, name: 'idx_devices_device_id_ci']
    (archived_at) [name: 'idx_devices_archived_at']
    (device_secret) [name: 'idx_devices_device_secret', note: 'PARTIAL: WHERE device_secret IS NOT NULL']
    (device_secret_prev) [name: 'idx_devices_secret_prev', note: 'PARTIAL: WHERE device_secret_prev IS NOT NULL']
    (device_secret_prev_expires_at) [name: 'idx_devices_secret_prev_expires', note: 'PARTIAL: WHERE device_secret_prev_expires_at IS NOT NULL']
  }
}

Table sensors {
  id int [pk, increment]
  device_id varchar(50) [not null]
  temperature decimal(5,2) [default: 0]
  water_level decimal(5,2) [default: 0]
  // precision is (5,2), not (5,3) - verified against the live database
  ammonia decimal(5,2) [default: 0]
  timestamp timestamptz [default: `now()`]

  // Range checks (migration 009). Each allows NULL - a NULL reading means the
  // sensor failed, which is recorded rather than rejected.
  //   chk_sensors_temperature_valid: 0 < temperature <= 100
  //   chk_sensors_water_level_valid:  0 <= water_level <= 200
  //   chk_sensors_ammonia_valid:      0 <= ammonia <= 1000

  Indexes {
    (timestamp) [name: 'idx_sensors_timestamp']
    (device_id) [name: 'idx_sensors_device_id']
    (device_id, timestamp) [name: 'idx_sensors_device_timestamp']
    (device_id, timestamp) [name: 'idx_sensors_valid_readings', note: 'PARTIAL: WHERE temperature IS NOT NULL OR water_level IS NOT NULL OR ammonia IS NOT NULL']
    // Functional index (migration 016) for case-insensitive tank lookups in server.cjs.
    (`lower(device_id)`, timestamp) [name: 'idx_sensors_device_id_ci']
  }
}

Table sensor_settings {
  id int [pk, increment]
  // All six range columns are NULLABLE in the live database (defaults, but no
  // NOT NULL constraint) - verified against information_schema.columns
  temp_min decimal(5,2) [default: 20.00]
  temp_max decimal(5,2) [default: 31.00]
  water_level_min decimal(5,2) [default: 10.00]
  water_level_max decimal(5,2) [default: 100.00]
  ammonia_min decimal(5,2) [default: 0.25]
  ammonia_max decimal(5,2) [default: 1.00]
  // NOTE: naive `timestamp` in the live database, not timestamptz
  updated_at timestamp [default: `now()`]

  Note: 'Global thresholds. Per-tank values live in device_threshold_overrides (NULL there = inherit from here). Not linked by FK.'
}

Table device_threshold_overrides {
  device_id varchar(50) [pk]
  // Every range column is nullable; NULL = inherit the global sensor_settings value.
  temp_min decimal(5,2)
  temp_max decimal(5,2)
  water_level_min decimal(5,2)
  water_level_max decimal(5,2)
  ammonia_min decimal(5,2)
  ammonia_max decimal(5,2)
  updated_at timestamptz [not null, default: `now()`]
}

Table system_logs {
  id int [pk, increment]
  action varchar(100) [not null]
  parameter varchar(100) [not null]
  old_value varchar(50)
  new_value varchar(50)
  ack_status varchar(20)
  // timestamptz since migration 016 (was naive)
  acknowledged_at timestamptz
  // Soft reference by username, not an FK. Ambiguous if a username is reused.
  acknowledged_by varchar(100)
  timestamp timestamptz [default: `now()`]
  // Per-tank attribution (migration 011). NULL = farm-wide / pre-011 history.
  device_id varchar(50)

  Indexes {
    (timestamp) [name: 'idx_system_logs_timestamp']
    (action) [name: 'idx_system_logs_action']
    (ack_status) [name: 'idx_system_logs_ack_status']
    (device_id, timestamp) [name: 'idx_system_logs_device_ts']
  }
}

Table last_alerts {
  // Composite PK: each device keeps its own alert state per sensor_key.
  device_id varchar(50) [not null]
  sensor_key varchar(50) [not null]
  status varchar(20)
  value decimal(5,2)
  // timestamptz since migration 016 (was naive)
  timestamp timestamptz

  Indexes {
    (device_id, sensor_key) [pk]
  }
}

Table activity_logs {
  id int [pk, increment]
  // INTENDED to reference users.username, but NOT enforced (see bottom of file).
  user_name varchar(100)
  action_type varchar(50) [not null]
  description text
  module varchar(100)
  // timestamptz since migration 016 (was naive)
  timestamp timestamptz [default: `now()`]

  Note: 'user_name is an intended but unenforced reference to users.username.'

  Indexes {
    (timestamp) [name: 'idx_activity_logs_timestamp']
    (action_type) [name: 'idx_activity_logs_action_type']
  }
}

Table user_deletion_requests {
  id int [pk, increment]
  // TODO: confirm whether the missing FK to users.id is deliberate (e.g. the
  // audit trail must survive a hard delete). It COULD be enforced, since
  // users.id is a plain primary key.
  user_id int [not null]
  user_username varchar(100) [not null]
  requester_username varchar(100) [not null]
  requester_email varchar(255) [not null]
  status varchar(20) [not null, default: "'pending_otp'"]
  reason text
  otp_hash varchar(64)
  otp_salt varchar(32)
  otp_expires_at timestamptz
  otp_attempts int [not null, default: 0]
  otp_verified_at timestamptz
  otp_verified_by varchar(100)
  requested_at timestamptz [default: `now()`]
  approver varchar(100)
  approved_at timestamptz
  executed_by varchar(100)
  executed_at timestamptz
  status_history jsonb [not null, default: "'[]'"]

  Note: 'user_id has no FK to users.id (unenforced). approver / executed_by / otp_verified_by are soft references by username.'

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
  expires_at timestamptz [not null]
  attempts int [not null, default: 0]
  max_attempts int [not null, default: 5]
  used_at timestamptz
  created_at timestamptz [default: `now()`]

  Indexes {
    (email) [name: 'idx_email_otps_email']
    (expires_at) [name: 'idx_email_otps_expires']
  }
}

Table system_state {
  key varchar(255) [pk]
  value text
}

Table schema_migrations {
  // Bookkeeping only - no relationships. Included so the diagram matches
  // the live database's 14 tables.
  version varchar(50) [pk]
  name varchar(255) [not null]
  applied_at timestamptz [not null, default: `now()`]
  checksum varchar(64)
}

Table authorized_recipients {
  id int [pk, increment]
  phone_number varchar(20) [not null]
  name varchar(100)
  is_active boolean [default: true]
  archived_at timestamptz
  // NOTE: naive `timestamp` in the live database, not timestamptz
  created_at timestamp [default: `now()`]
  updated_at timestamp [default: `now()`]

  Note: 'sms_logs.recipient_phone matches phone_number via trigger trg_sms_logs_recipient, not an FK (see bottom of file).'

  Indexes {
    (archived_at) [name: 'idx_recipients_archived_at']
    // An archived recipient's number can be reused by a new recipient.
    (phone_number) [unique, name: 'idx_recipients_phone_active', note: 'PARTIAL: WHERE archived_at IS NULL (migration 006)']
  }
}

Table sms_logs {
  id int [pk, increment]
  // NOT a foreign key and cannot be one. Integrity is enforced by trigger
  // trg_sms_logs_recipient (migration 016).
  recipient_phone varchar(20) [not null]
  message text [not null]
  status varchar(20) [not null]
  error_message text
  sms_id varchar(100)
  delivered_at timestamptz
  failure_reason text
  sent_at timestamptz [default: `now()`]

  Note: 'recipient_phone is validated by trigger trg_sms_logs_recipient, not an FK.'

  Indexes {
    (sent_at) [name: 'idx_sms_logs_sent_at']
    (status) [name: 'idx_sms_logs_status']
  }
}

// ---------------------------------------------------------------------------
// TABLE GROUPS
// ---------------------------------------------------------------------------
TableGroup monitoring {
  devices
  sensors
  last_alerts
  system_logs
}

// Threshold configuration, not measurements. Per-tank values inherit from
// sensor_settings when the matching override column is NULL.
TableGroup config {
  sensor_settings
  device_threshold_overrides
}

TableGroup auth_and_users {
  users
  email_otps
  user_deletion_requests
  activity_logs
}

TableGroup sms_alerts {
  authorized_recipients
  sms_logs
}

TableGroup system {
  system_state
  schema_migrations
}

// ---------------------------------------------------------------------------
// ENFORCED FOREIGN KEYS
// The four that actually exist. Verified against
// information_schema.referential_constraints on 2026-09-28.
// sensors and last_alerts use NO ACTION (default): devices are archived,
// never hard-deleted.
// ---------------------------------------------------------------------------
Ref: sensors.device_id > devices.device_id
Ref: last_alerts.device_id > devices.device_id
Ref: system_logs.device_id > devices.device_id [delete: set null]
// device_id is the PK of the overrides table, so this is one-to-one.
Ref: device_threshold_overrides.device_id - devices.device_id [delete: cascade]

// ---------------------------------------------------------------------------
// DELIBERATELY NOT DRAWN AS A Ref
// Drawing these would assert something the database does not enforce.
// ---------------------------------------------------------------------------

// (1) activity_logs.user_name > users.username  -- UNENFORCED, a real gap.
// Migrations 001 and 002 both add the constraint (activity_logs_user_name_fkey,
// ON DELETE SET NULL), but no such FK exists on the live database. Audit rows
// can name a user that no longer exists, or never did.
// It cannot simply be added: users.username is unique only via the PARTIAL
// index idx_users_username_active, and a foreign key cannot reference a
// partial index. Restoring a full UNIQUE would undo migration 006's
// username-reuse-after-archive design. Needs a decision: leave it unenforced,
// or change the uniqueness model.

// (2) sms_logs.recipient_phone > authorized_recipients.phone_number
//     -- STRUCTURALLY IMPOSSIBLE, not a gap.
// phone_number is unique only via the PARTIAL index idx_recipients_phone_active,
// and PostgreSQL requires a foreign key to reference a UNIQUE constraint or a
// NON-PARTIAL unique index. Integrity is enforced instead by trigger
// trg_sms_logs_recipient (function check_sms_logs_recipient, migration 016),
// which rejects INSERT and UPDATE OF recipient_phone when no matching recipient
// exists. ERD tools do not draw triggers.

// (3) user_deletion_requests.user_id > users.id  -- UNENFORCED, unexplained.
// Could be enforced (users.id is a plain PK). Confirm whether it is deliberate.

// (4) Soft references by username: activity_logs.user_name,
// system_logs.acknowledged_by, devices.archived_by,
// users.pending_deletion_requested_by, and approver / executed_by /
// otp_verified_by in user_deletion_requests. Because usernames can be reused
// after archiving, an old audit row may point at a different person.
```

---

*End of database schema.*
