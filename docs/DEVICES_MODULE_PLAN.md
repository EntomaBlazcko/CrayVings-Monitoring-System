# Devices Module — Requirements Review & Implementation Plan

**Status:** ✅ **Implemented & tested.** Backend (migration 014, API, poller) and
frontend (Devices page, admin-only nav entry) are complete. `npm run test:devices`
passes 91/91, plus unit, regression, lint, `tsc -b`, and a production build.
**Date:** 2026-09-27
**Scope:** New "Devices" page with Add Device form, dynamic device registration, device archiving.

> **Note:** the analysis below is the *original* review, written before coding.
> The verdicts it reaches are the ones that were implemented. Where a design
> conflict was flagged for decision, the resolved answer is recorded in §4
> ("Final decisions") — that section, not the open questions, is authoritative now.

---

## 0. Executive summary

Four of the five stated requirements are either already satisfied or require no
change. One requirement is based on a **premise that does not hold** — there is no
3-device cap anywhere in the codebase. One requirement has a genuine **design
conflict** that needs a decision before implementation.

| # | Requirement | Verdict |
|---|---|---|
| 1 | New "Devices" page with Add Device form | **New work** — no create endpoint exists |
| 2 | Device ID unique system-wide, validated on add | **Mostly done** — already the PRIMARY KEY; needs an endpoint + UX |
| 3 | Remove fixed/hardcoded device limit (was 3) | **No-op** — no such limit exists; see §2.1 |
| 4 | No auto-provisioning / no web flasher | **Nothing to do** — no flasher exists |
| 5 | Device archiving (soft delete) | **Already works** — via `is_active = false`; semantics only |

---

## 1. How requirements map to what already exists

### 1.1 Requirement mapping table

| Requirement | Current state | Gap |
|---|---|---|
| Device ID unique system-wide, validated on add | `devices.device_id VARCHAR(50) PRIMARY KEY` — already globally unique at the DB level (`docs/DATABASE_SCHEMA.md:67`). No endpoint creates a device. | Need `POST /devices` + frontend pre-check |
| Remove fixed/hardcoded device limit (was 3) | **No device cap exists anywhere.** Zero matches for `MAX_DEVICES`, `deviceLimit`, `slice(0, 3)`, `limit: 3`. `GET /devices` has no `LIMIT` (`server.cjs:1631`); the frontend tank list is built dynamically from the response. | Nothing to remove — see §2.1 |
| Add Device form (ID, Name, IP) | Nothing. `devices.name` exists (`DATABASE_SCHEMA.md:68`) but **no code path ever writes it** — it is dead. The real display label is `tank_name`. | New endpoint + page |
| No auto-provisioning / no web flasher | Nothing to do — there is no web flasher. Firmware is `.ino` files flashed manually. | None |
| Device archiving (soft delete) | **Already works** via `is_active = false`. `PUT /devices/:deviceId { is_active: false }` (`server.cjs:1655`), UI in `src/components/deviceActions.tsx:183` (`DeviceHide`), restore in `src/hooks/useHiddenDevices.ts`. FKs from `sensors` / `last_alerts` / `system_logs` / `device_threshold_overrides` are all `NO ACTION` (no CASCADE), so history survives. | Semantics only — see §2.3 |

### 1.2 Existing `devices` table

From `docs/DATABASE_SCHEMA.md:65-76`:

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `device_id` | VARCHAR(50) | **PRIMARY KEY** | ESP32 device identifier |
| `name` | VARCHAR(100) | | Optional friendly name — **never written by any code path** |
| `is_active` | BOOLEAN | NOT NULL DEFAULT true | Whether the device is enabled |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | Device first seen (migration 007) |
| `last_seen` | TIMESTAMPTZ | | Latest reading timestamp (migration 007) |
| `ip_address` | TEXT | | Static LAN IP, used by the poller to reach `GET /status` |
| `tank_name` | VARCHAR(100) | | Friendly tank label — **the actual display label everywhere** |
| `tank_location` | VARCHAR(100) | | Physical location / zone |
| `device_secret` | VARCHAR(255) | | Optional per-device ingestion secret (migration 008) |
| `last_health_seen` | TIMESTAMPTZ | | Last successful `GET /status` poll |

### 1.3 Incoming references to `devices`

| Table | Column | FK behaviour |
|---|---|---|
| `sensors` | `device_id` | `NO ACTION` — history preserved on archive |
| `last_alerts` | `device_id` (composite PK) | `NO ACTION` |
| `system_logs` | `device_id` (nullable, migration 011) | `NO ACTION` |
| `device_threshold_overrides` | `device_id` (PK, migration 012) | `NO ACTION` |

No CASCADE anywhere. This is why archiving already preserves historical data.

### 1.4 Existing device API surface

| Method | Path | Auth | Line |
|---|---|---|---|
| GET | `/devices` | `requireAuth` | `server.cjs:1631` |
| PUT | `/devices/:deviceId` | `requireAuth` | `server.cjs:1655` |
| GET | `/devices/latest` | `requireAuth` | `server.cjs:1716` |
| GET | `/devices/:deviceId/status` | `requireAuth` | `server.cjs:1735` |
| POST | `/sensor` (ingest, auto-registers) | `X-Device-Secret` | `server.cjs:1348` |

**There is no `POST /devices`.** That is the core missing piece.

---

## 2. Conflicts, risks, and recommended deviations

### 2.1 There is no 3-device limit — the "3" is something else

The only `3`s in the codebase:

| Value | Location | Actual meaning |
|---|---|---|
| `3` | `services/devicePoller.cjs:19` | `CONCURRENCY = 3` — max **simultaneous HTTP GETs**, not a device cap |
| `3` | `services/devicePoller.cjs:22` | `FAILURE_THRESHOLD = 3` — consecutive failures before a health warning |
| `"ESP32_01"` | `ESP32_main_code.ino:226` | Firmware default device ID, one per physical board |
| `"ESP32_02"` | `NODE_main_code.ino:226` | Firmware default device ID, one per physical board |
| `deviceId[50]` | both `.ino` files | 50-char buffer matching the DB column width |

`POST /sensor` upserts *any* unknown `device_id` (`server.cjs:1440-1445`), so the
registry was never capped. `scripts/mock-device.js:440` also accepts an arbitrary
device list. An exhaustive search across the whole repository for device-cap
patterns returned **zero matches**.

> **Action required:** confirm whether a 3-device limit was actually observed, or
> whether it came from the proposal/write-up. If it was observed, the location needs
> to be identified. If not, requirement #3 is a no-op and no code will be changed.

**Real scaling limit that does exist:** `CONCURRENCY = 3` in
`services/devicePoller.cjs:19` with `REQ_TIMEOUT_MS = 2000` and a 5s poll cadence.
At 12 devices a full poll cycle is 4 batches, and a hung device stalls its whole
batch for 2s. This is the only thing that meaningfully throttles the system at 10+
devices. Recommended fix: `Math.min(10, devices.length)`.

Other 10+ device considerations (all currently safe, noted for completeness):

- `sensorIngestLimiter` is keyed per device (`device:<device_id>`), 12/sec — fine.
- In-memory Maps (`latestDeviceReadings`, `lastSensorReading`, `lastAmmoniaReading`,
  `deviceOnlineSince`, `disconnectedDevices`) are unbounded but small; they need
  eviction on archive to avoid a slow leak.
- `GET /devices/latest` (`server.cjs:1716`) does one query then loops — fine.
- SMS mute-list fetches (`server.cjs:934-935`, `:3099`) are single queries — fine.
- SSE `/sensor/stream` broadcast rate scales linearly with device count.
- `SMS_DAILY_CAP` becomes relevant with more devices generating more alerts.

### 2.2 `POST /sensor` auto-registration conflicts with "unique, validated on add"

`server.cjs:1440-1445`:

```js
const clientIp = normalizeClientIp(req);
await pool.query(
  `INSERT INTO devices (device_id, ip_address, last_seen) VALUES ($1, $2, $3)
     ON CONFLICT (device_id) DO UPDATE
        SET last_seen = $3, ip_address = COALESCE($2, devices.ip_address)`,
  [device_id, clientIp, arrivalTs]
);
```

Any ESP32 presenting the shared `DEVICE_SECRET` creates its own registry row. This
makes an Add Device form **advisory, not authoritative** — a typo'd or rogue device
ID silently appears in the registry. Worse: archiving a device whose board is still
transmitting means the upsert keeps refreshing `last_seen` and `ip_address` on the
archived row indefinitely.

**Two options — decision required:**

- **Option A — keep auto-registration, add provenance (RECOMMENDED).**
  Add `registered_via VARCHAR(20) DEFAULT 'auto'`. The form writes `'manual'`, the
  ingest upsert writes `'auto'`. The Devices page shows an "auto-discovered, not
  registered" badge. Zero risk of a board going dark; the `sensors` FK is always
  safe.

- **Option B — strict: reject unregistered `device_id` on ingest.**
  Returns 403 "device not registered". Matches the requirement literally, but
  archiving a still-transmitting device instantly starts a rejection storm plus
  disconnect alerts.

### 2.3 Archiving: do not reuse `is_active`, and never make `device_id` reusable

The codebase already has **two** archive patterns, both introduced by
`db/migrations/006_archive_restore.cjs`:

- `users.status = 'archived'` — enum-style, with `deleted_at` and
  `pending_deletion_at` timestamps.
- `authorized_recipients.archived_at` — timestamp-style, NULL = active.

**Recommended: add `archived_at TIMESTAMPTZ` (+ `archived_by`) to `devices`**, not a
status enum, because:

1. `is_active` already has a distinct, live meaning — "hidden from the tank
   dropdown, reversible" (`server.cjs:1640`, `src/hooks/useHiddenDevices.ts`).
   Overloading it for decommissioning conflates two different concepts.
2. It matches the `authorized_recipients` pattern, and archiving is a terminal
   state while hiding is not.
3. Archive implies `is_active = false`, so **every existing `WHERE is_active = true`
   filter keeps working untouched**:

   | Site | Effect of archiving |
   |---|---|
   | `server.cjs:1365` | per-device secret lookup stops matching |
   | `server.cjs:1718` | drops out of `/devices/latest` |
   | `server.cjs:3099` | drops out of the SMS alert list |
   | `services/devicePoller.cjs:32` | stops being health-polled |
   | `server.cjs:1640` | drops out of `GET /devices` |

   Zero changes required at those five sites.

> **Do NOT make `device_id` reusable, even for archived rows.** Migration 006 does
> exactly that for usernames and phone numbers via partial unique indexes. Applying
> the same pattern to `device_id` would mean a *new* physical board reusing
> `ESP32_03` silently inherits the old board's entire `sensors` history through the
> FK. That is data-integrity poison. Archived device IDs stay permanently taken.

### 2.4 The manual IP Address will get clobbered

`server.cjs:1440-1443` overwrites `ip_address` from the live peer on **every**
ingest. `normalizeClientIp` (`server.cjs:588-612`) unwraps IPv4-mapped IPv6, strips
IPv6 zone IDs, normalises `::1` → `127.0.0.1`, and then **returns `null` for
loopback** (so local test tools do not poison the registry).

Consequence: if the Node server is not on the same subnet as the tanks, the address
it records is the router/NAT address — not a LAN address the poller can dial at
`http://<ip>/status`.

**Recommended:** make a manually-entered IP authoritative. Add
`ip_source VARCHAR(10) DEFAULT 'auto'`; the ingest upsert overwrites `ip_address`
only when `ip_source = 'auto'`. The poller needs a LAN-reachable static/DHCP IP, so
the Add Device form is the right place for it.

### 2.5 Security issue found in passing

`PUT /devices/:deviceId` is guarded by `requireAuth`, **not** `requireAdmin`
(`server.cjs:1655`). Any logged-in non-admin user can currently rename or hide any
tank. `POST /devices` must be `requireAdmin`, consistent with `POST /auth/users`
(`:2280`) and `POST /settings/recipients` (`:2825`). Recommend also tightening PUT
to `requireAdmin` while in there.

Separately: the shared device secret is compared with plain `===`
(`server.cjs:1358`), not `timingSafeEqual` as the password path does. Worth
hardening.

### 2.6 Where the code lives (implementation notes)

- **Routing is not react-router.** It is a `MenuKey` string union persisted to
  `localStorage` (`src/App.tsx:29-49`), with lazy-loaded pages, a `renderPage`
  switch (`:122-164`), and role gating at `:53-62`. Adding a page = 4 small edits in
  `App.tsx` plus one new file.
- **Forms:** plain controlled `useState` + Zod. No react-hook-form. Reference:
  `src/pages/AuthPage.tsx:7-13`, `src/components/deviceActions.tsx:123-146`.
- **API client:** a single Axios instance in `src/api/client.ts:20-26`; device calls
  at `:165-198`.
- **Migrations:** standalone idempotent `db/migrations/0NN_*.cjs` scripts, run
  manually. There is **no migration runner** and no npm script for them. Next free
  number is `014`.
- **Styling:** Tailwind v4 CSS-first, tokens in `src/index.css:1-46`
  (`brand-*`, `good`/`warning`/`critical`, `surface*`). No dark mode.
- **Known doc drift:** `docs/DATABASE_SCHEMA.md`'s DBML block (`:451-461`) omits
  `devices.device_secret`. Base tables are not in version control (created by hand
  per `DATABASE_SCHEMA.md:395-399`), and `schema_migrations` exists but is not
  maintained by the server.

---

## 3. Open questions — ANSWERED

These were put to the Owner before implementation. The answers are what shipped.

1. **The 3-device cap** — a limit was *not* observed at runtime. The "3" was the
   device poller's batch size, not a cap. **Resolution: no cap work needed** beyond
   raising poller concurrency (done: `MAX_CONCURRENCY = 10`). Nothing in the schema
   or the API limits fleet size.
2. **Auto-registration** — **Option A: keep it**, tag it with `registered_via` so the
   UI can badge it. Rejecting (Option B) was rejected because a board that has never
   been through the Devices page would otherwise report *no data at all*, and the
   FK guarantee is valuable. `registered_via` is provenance, never a gate.
3. **"Device Name" → which column?** — **Both.** `POST /devices` writes the Owner-
   entered name to `name` *and* `tank_name`, so every existing display path (which
   all read `tank_name`) shows it, and `name` stops being dead. No second field in
   the form; `tank_location` remains separately editable.
4. **IP behaviour** — **Accepted `ip_source`.** An Owner-entered IP is authoritative
   and ingest will not overwrite it while `ip_source='manual'`; the form field
   effectively switches the device to manual-IP mode on creation.
5. **Menu visibility** — **Admin-only.** All four writes on the page are
   `requireAdmin`, so showing it to a `user` would only present controls that all
   fail. `"Devices"` is in `VALID_MENU_KEYS` but omitted from `USER_MENU_KEYS`.
6. **Reclaiming archived devices** — **Archive-and-retain is sufficient; no purge.**
   No hard-delete endpoint was added, and archived IDs are permanently reserved, so
   a future board can never inherit a retired ID's historical readings.

---

## 4. Implementation plan

### Step 0 — Write this document
`docs/DEVICES_MODULE_PLAN.md`. *(Done.)*

### Step 1 — Migration: `db/migrations/014_device_registration.cjs`

Idempotent, same style and header-comment convention as `006_archive_restore.cjs`
and `012_device_thresholds.cjs`. Run manually: `node db/migrations/014_device_registration.cjs`.

```sql
ALTER TABLE devices ADD COLUMN IF NOT EXISTS archived_at     TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS archived_by     VARCHAR(100);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS registered_via  VARCHAR(20) NOT NULL DEFAULT 'auto';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS ip_source       VARCHAR(10) NOT NULL DEFAULT 'auto';

CREATE INDEX IF NOT EXISTS idx_devices_archived ON devices (archived_at);
```

Backfill — existing rows with a `tank_name` were admin-registered, so mark them manual:

```sql
UPDATE devices SET registered_via = 'manual' WHERE tank_name IS NOT NULL;
```

Deliberately **no change** to the `device_id` PRIMARY KEY (see §2.3).

Include the verification-report block at the bottom of the script, matching the
pattern in `006_archive_restore.cjs:87-114`.

### Step 2 — Server changes in `server.cjs`

1. **`POST /devices`** (`requireAdmin`) — create/register a device.
   - Zod schema: `device_id` 1–50 chars, `^[A-Za-z0-9_-]+$`; `name` / `tank_name`
     ≤100; `ip_address` validated as IPv4 (or hostname if static IPs are not
     guaranteed).
   - Explicit pre-check `SELECT 1 FROM devices WHERE device_id = $1` → **409** with a
     clear duplicate message; still catch Postgres `23505` as a backstop.
   - Insert with `registered_via = 'manual'`, `ip_source = 'manual'` (when an IP is
     supplied), `is_active = true`.
   - Write an `activity_logs` row (`action_type = 'DEVICE_REGISTERED'`, module
     `devices`).
2. **Archive / restore endpoints** — `POST /devices/:id/archive` and
   `POST /devices/:id/restore`, both `requireAdmin`. Archive sets `archived_at`,
   `archived_by`, and forces `is_active = false`. Restore clears both.
3. **`GET /devices`** — add `archived_at`, `archived_by`, `registered_via`,
   `ip_source` to the SELECT (`:1636`); add `?include_archived=1` alongside the
   existing `?include_hidden=1`.
4. **`POST /sensor` (`:1440-1445`)** — gate the `ip_address` overwrite on
   `ip_source = 'auto'`; mark upsert-created rows `registered_via = 'auto'`; and per
   the §2.2 decision either reject or ignore ingest from archived devices.
5. **Permissions** — change `PUT /devices/:deviceId` from `requireAuth` to
   `requireAdmin`.
6. **Memory hygiene** — evict archived devices from `latestDeviceReadings`,
   `lastSensorReading`, `lastAmmoniaReading`, `deviceOnlineSince`, and
   `disconnectedDevices` when archived.
7. **Optional** — raise `CONCURRENCY` in `services/devicePoller.cjs:19` to
   `Math.min(10, devices.length)`.

### Step 3 — Frontend changes

1. **`src/types/index.ts`**
   - Add `"Devices"` to `VALID_MENU_KEYS` (`:29-38`).
   - Extend `DeviceEntry` (`:168-190`) with `archived_at`, `archived_by`,
     `registered_via`, `ip_source`.
   - Add `CreateDevicePayload` and an `ApiError`-compatible duplicate-detection
     helper.
2. **`src/api/client.ts`**
   - `createDevice(payload)` → `POST /devices`.
   - `archiveDevice(id)` / `restoreDevice(id)`.
   - Extend the `updateDevice` payload type (`:184`).
3. **`src/pages/DevicesPage.tsx`** (new file, `export default`)
   - Table of all devices with an active/archived toggle.
   - Online/offline dot, `tankOptionLabel` disambiguation (`:184-189`).
   - "Add Device" form: Zod validation, inline 409 duplicate error surfaced from
     `ApiError`.
   - Archive / restore with a confirm step.
   - Reuse `DeviceLiveCheck`, `DeviceRename`, `DeviceHide` from
     `src/components/deviceActions.tsx`; log every mutation via `logActivity`.
4. **`src/App.tsx`**
   - `lazy(() => import("./pages/DevicesPage"))` near `:38`.
   - `menuDefinitions` entry with a `Cpu` icon (`:40-49`).
   - `renderPage` case (`:141-149`).
   - Role gating at `:53-62` per the answer to question 5.
5. **`docs/DATABASE_SCHEMA.md`** — document the four new columns; add the missing
   `devices.device_secret` to the DBML block (`:451-461`).

### Step 4 — Verification

```bash
node db/migrations/014_device_registration.cjs
npm run lint
npx tsc -b
npm test
npm run test:regression      # needs a live API + PostgreSQL
npm run test:devices         # 91 checks
npm run build
```

Manual checks:

- Register 10+ devices; confirm `GET /devices` returns all of them with no cap and
  the poller handles them without stalling.
- Attempt to register a duplicate `device_id`; confirm 409 and a clear UI message.
- Archive a device; confirm it disappears from the tank dropdown, stops being
  polled, stops generating SMS, and that its `sensors` history is still queryable
  via `GET /sensor?device_id=...`.
- Restore the device; confirm it returns to the active list.
- Confirm a non-admin user cannot reach the Add Device form or `POST /devices`.

---

## 5. What actually shipped

| Area | Change |
|---|---|
| `db/migrations/014_device_registration.cjs` | `archived_at`, `archived_by`, `registered_via`, `ip_source`; 3 CHECKs; `idx_devices_archived_at`; case-insensitive unique `idx_devices_device_id_ci`; backfill. Idempotent — verified over 3 consecutive runs |
| `server.cjs` | `isIpv4` / `blankToUndefined` / `createDeviceSchema` / `DEVICE_COLUMNS`; `POST /devices`; `archive` + `restore` routes; archived columns in registry responses; `include_archived`; `PUT` → `requireAdmin`; `evictDeviceFromMemory()`; provenance-preserving ingest; `archived_at IS NULL` guards on active queries |
| `services/devicePoller.cjs` | excludes archived devices; `MAX_CONCURRENCY = 10` |
| `tests/devices.cjs` (+ `test:devices` script) | 91 checks, all passing |
| `src/types/index.ts` | `DeviceEntry` extended; `CreateDevicePayload`; `DeviceArchiveResult`; `"Devices"` in `VALID_MENU_KEYS` |
| `src/api/client.ts` | `createDevice`, `archiveDevice`, `restoreDevice`; `fetchDevices(includeHidden, signal, includeArchived)` |
| `src/pages/DevicesPage.tsx` | Add Device form (Zod), active/archive toggle, provenance badges, live check, archive confirmation, restore |
| `src/App.tsx` | lazy import, `Cpu` menu entry, `renderPage` case, admin-only gating |
| `docs/DATABASE_SCHEMA.md`, `docs/HOW_IT_WORKS.md` | migration 014 documented; missing `device_secret` added to DBML; archive-vs-hide table; endpoint table; poller concurrency |

### Notes for future maintainers

- **The `name` column is no longer dead.** `POST /devices` writes `name` and
  `tank_name` together. If you ever expose a separate Device Name / Tank Label
  pair, `PUT /devices/:deviceId` can still diverge them — but nothing does today,
  and the display layer only reads `tank_name`.
- **`registered_via` is never a gate.** Do not add a check that rejects readings
  from `registered_via='auto'` devices. Its purpose is to let the Owner see which
  boards skipped the Devices page.
- **Archived devices may still send readings.** Archiving stops *polling* and
  *surfacing*; it does not close the ingest door, so a retired board cannot break
  the FK. The flip side: check `archived_at IS NULL` in any new "active fleet"
  query, or archived boards will quietly reappear in your UI.
- **`/devices/:id/status` is unauthenticated by design** (see §2.5) — the LAN-
  reachable HTTP path the health poller uses. Do not put secrets on it.
