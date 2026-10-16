# Devices — Operating the Fleet

The Devices module lets you register, monitor, and retire **ESP32 / ESP8266
(NodeMCU)** boards without ever editing the database by hand.

This document merges the former `DEVICES_MODULE_HOWTO.md` (the operating manual)
and `DEVICES_MODULE_PLAN.md` (the design review and its rationale). Part 1 is
what to click; Part 2 is *why it works that way*, kept because every one of those
decisions can be undone by accident by a well-meaning later change.

> **Key distinction:** The firmware sends data **TO** your server IP. The Dashboard
> needs the board's **own LAN IP** for health checks. These are two different IPs —
> see "Two IPs You Must Not Confuse" below.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) for data flow and the API map,
[DATABASE.md](DATABASE.md) for the `devices` table, [TESTING.md](TESTING.md) for
the mock simulator and the fleet verification runbooks.

---

# Part 1 — Operating the module

## Two IPs You Must Not Confuse

| IP Type | Purpose | Where to Use |
|---------|---------|--------------|
| **Server IP** | Your dashboard/api host (where ESP32/NodeMCU pushes data) | **Firmware code** -> `POST http://SERVER_IP:3000/sensor` |
| **Device IP** | ESP32/NodeMCU's own LAN IP (health poller pulls status from it) | **Dashboard Devices page** -> register this so poller calls `http://DEVICE_IP/status` |

**Example:**
- Server (dashboard) runs on `192.168.1.100:3000`
- NodeMCU connects to WiFi, gets `192.168.1.150`
- **In NodeMCU firmware:** `serverIP = "192.168.1.100"` (Server IP)
- **In Dashboard Devices page:** IP Address = `192.168.1.150` (Device IP)

```
NodeMCU (192.168.1.150) --POST /sensor--> Server (192.168.1.100:3000)
Server <--GET /status-- Health Poller (checks device health every 5s)
```

## Open the page

1. Sign in as an **admin** account.
2. In the left sidebar, click **Devices** (CPU icon).
   - The page is hidden from non-admin users because every write action requires admin rights.

## Register a new ESP32 / NodeMCU

1. Click **Add Device** (top-right).
2. Fill the form:
   - **Device ID** — the exact `device_id` the board reports (e.g. `ESP32_03`, `NODEMCU_01`, `tank-01`).
     - Must be unique **system-wide, case-insensitively**.
     - A retired (archived) ID can never be reused — you will get a clear error if you try.
     - **Must match firmware exactly** (case-sensitive in POST payload, case-insensitive in DB).
   - **Device Name** — friendly label shown everywhere on the dashboard (e.g. `Tank 3 - Bayside`).
     - Written to both `name` and `tank_name` columns so every existing view picks it up.
   - **IP Address** (optional) — static LAN IP of the board (e.g. `192.168.1.150`).
     - **This is the board's own LAN IP**, not your server IP.
     - Find it: Serial Monitor on boot, router DHCP list, or `WiFi.localIP()` in code.
     - If you enter it, the backend **locks it** (`ip_source = 'manual'`). Later sensor ingests will **not** overwrite it.
     - Leave blank to let the board announce its own IP on first contact (`ip_source = 'auto'`).
3. Click **Register**.
   - On success the device appears in the **Active** table immediately.
   - The row shows a **Manual** badge (provenance = you registered it).
   - If the board has already reported data, you'll see its last reading time and health status.

## View the fleet

The page has two tabs:

### Active
- All devices where `archived_at IS NULL` and `is_active = true`.
- Columns: Device ID, Name, IP, Registered Via, Last Reading, Last Health, Status, Actions.
- **Status** chip is driven by the heartbeat, **not** by the health poller:
  - **Online** (green) — `GET /devices` reports `online: true`, i.e. `last_seen` is
    fresher than `DISCONNECT_STALE_MS` (default **30 s**, env-tunable;
    `server.cjs:2285-2291`).
  - **Offline** (red) — `last_seen` is older than that window. A board that stops
    posting goes offline on the heartbeat, whatever its IP is doing.
  - **Unknown** (gray) — never seen at all, so `last_seen IS NULL`.
  - The dashboard tiles apply the same 30 s rule client-side via
    `HEARTBEAT_STALE_MS` (`src/contexts/SensorProvider.tsx:55,121`).

### Archived
- Devices you have retired. They are **excluded** from:
  - Tank dropdowns on every other page
  - Health polling
  - SMS alerting
- Their historical sensor data, alerts, and logs remain fully queryable via `GET /sensor?device_id=...` and the Historical Data page.
- Click **Restore** to bring a device back to Active (clears `archived_at`/`archived_by`, sets `is_active = true`).

## Edit an active device

In the Active table, click the **pencil** icon on a row:
- Change the **Name** (updates `tank_name` everywhere).
- Change the **IP Address** (switches `ip_source` to `manual`).
- Toggle **Active** off to hide the device without archiving it (it stops being polled and drops out of tank selectors, but the ID stays reservable for restore).

Click **Save**.

## Archive (retire) a device

1. In the Active table, click the **archive box** icon.
2. A confirmation modal explains:
   - The device will disappear from all active views and tank dropdowns.
   - Health polling stops.
   - SMS alerts stop.
   - **All historical readings are preserved.**
   - **The Device ID is permanently retired — it can never be registered again, even after restore.**
3. Type the Device ID to confirm, then click **Archive**.
   - The row moves to the Archived tab with a **Archived** badge and the admin name / timestamp.

## Restore an archived device

1. Switch to the **Archived** tab.
2. Click the **rotate-ccw** (restore) icon on the row.
3. The device returns to the Active tab, `is_active = true`, `archived_at`/`archived_by` cleared.
   - Note: the Device ID was never released, so no conflict is possible.

## Live health check (on-demand)

Any row with an IP address shows a **Live Check** button (Wi-Fi icon). Click it to:
- Fire an immediate `GET /status` to that ESP32 (3 s timeout).
- See the raw JSON response (firmware version, uptime, Wi-Fi RSSI, sensor snapshot).
- If the board replies with a mismatched `device_id`, the modal warns you — the IP in the registry points to a different physical board.

## Rotate a device secret

`POST /devices/:deviceId/rotate-secret` (admin) issues a new per-device
`device_secret`. The previous secret keeps working until
`device_secret_prev_expires_at`, which gives a board time to learn the new value
through its WiFiManager portal without a window where it is locked out. The grace
period defaults to **24 h**, the caller may pass `grace_hours` (0–168, hard-capped
at 7 days), and `DEVICE_SECRET_GRACE_MS` overrides the default. A device still on
the shared `DEVICE_SECRET` cannot simply be rotated: the call returns `409` with
`can_migrate_from_shared`, and the caller must explicitly send
`migrate_from_shared: true`. Rotation is surfaced in the UI as metadata only
(`device_secret_rotated_at`, `device_secret_prev_expires_at`) — the new secret is
returned exactly once, in the response that created it.

> Why a grace window at all: a board can only learn a new secret through its
> WiFiManager config portal, i.e. somebody has to physically reach the tank. A
> zero-grace rotation would mean every rotation is an outage until someone walks
> out to the pond with a laptop.

## What happens automatically

| Event | What the backend does |
|-------|----------------------|
| ESP32/NodeMCU posts to `/sensor` with an **unknown** `device_id` | Auto-creates a row (`registered_via = 'auto'`), so the FK never fails. You'll see an **Auto** badge on the Devices page — register it properly later to get a Manual badge and set the name/IP. |
| ESP32/NodeMCU posts with a **manual IP** already set | The ingest **ignores** the IP in the payload; your entered address wins. |
| Health poller runs (every 5 s) | Polls up to **10 devices concurrently**. A hung board times out in 2 s and never blocks the others. |
| Device hits 3 consecutive poll failures | A warning is logged once per 30 s per device (backoff-limited). The poller does **not** write an offline flag; offline state is derived from the heartbeat. |
| You archive a device | `archived_at` + `archived_by` set, `is_active = false`. Poller's query (`WHERE archived_at IS NULL`) excludes it immediately, and the in-memory maps are evicted. |
| You restore a device | `archived_at`/`archived_by` cleared, `is_active = true`. Poller picks it up on the next cycle. |
| An archived device keeps sending readings | Ingest still accepts them (so a retired board cannot break the FK) but no active query surfaces it. |

## API reference (for integrations)

| Method | Path | Auth | Body / Params | Notes |
|--------|------|------|---------------|-------|
| GET | `/devices` | user/admin | `?include_hidden=1` `?include_archived=1` | Returns `registered_via`, `ip_source`, `archived_at` |
| GET | `/devices/latest` | user/admin | — | Latest reading for every device |
| POST | `/devices` | admin | `{ device_id, device_name, ip_address? }` | 409 if ID taken (case-insensitive, even vs archived) |
| PUT | `/devices/:id` | admin | `{ name?, ip_address?, is_active?, tank_location? }` | |
| POST | `/devices/:id/archive` | admin | — | Sets `archived_at`/`archived_by`, `is_active=false` |
| POST | `/devices/:id/restore` | admin | — | Clears archive fields, `is_active=true` |
| GET | `/devices/:id/status` | user/admin | — | Live `GET /status` to the ESP32 (3 s timeout) |
| POST | `/devices/:id/rotate-secret` | admin | — | Rotates the per-device secret, with a grace window |

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| "Device ID already registered" on a brand-new board | The ID exists in the table (active, hidden, **or archived**). Check the Archived tab. IDs are never reusable. |
| IP keeps reverting after I set it | You didn't save, or the board is still `ip_source = 'auto'`. Edit the row, enter the IP, Save — the badge switches to **Manual**. |
| Device shows **Unknown** status forever | No IP configured. Edit the row and add the static LAN IP. |
| Archived device still appears in a tank dropdown | Impossible — the dropdown queries `WHERE archived_at IS NULL`. Clear your browser cache / hard-refresh. |
| "Cannot reach server" on Live Check | The ESP32/NodeMCU is powered off, on a different VLAN, or the IP in the registry is wrong. Use the Live Check modal to see the exact error. |
| Live Check warns about a `device_id` mismatch | The registry IP points at a different physical board. Fix the IP, or the ID in firmware. |
| Non-admin user sees the Devices link | They shouldn't. The menu entry is gated by `USER_MENU_KEYS` (admin only). If you see it, check `src/types/index.ts` `VALID_MENU_KEYS` vs `USER_MENU_KEYS`. |

## Quick checklist for a new tank

1. Physically install the ESP32/NodeMCU, give it a static DHCP reservation (or static IP).
2. Open **Devices -> Add Device**.
3. Enter the board's `device_id`, a friendly **Name**, and the static **IP**.
4. Click **Register** -> verify **Manual** badge, **Online** status after ~5 s.
5. Go to **Sensors** or **Dashboard** — the tank now appears in every dropdown.
6. Set per-tank thresholds in **Settings** if they differ from global defaults.
7. Add SMS recipients in **Settings -> Recipients** if this tank needs its own alerts.

That's it — the board is now a first-class citizen of the fleet.

## Complete step-by-step: adding a new device

### A. Real ESP32 / NodeMCU (your spare hardware)

#### 1. Prepare the board hardware

| Action | Details |
|--------|---------|
| **Flash firmware** | Use the ESP32 firmware in `water_monitoring_system/ESP32_main_code/` or the NodeMCU sketch in `NODE_main_code/`. Compile with your Wi-Fi credentials. |
| **Set the device secret** | In the firmware config portal: `device_secret` — must match `.env` (`DEVICE_SECRET`) or a per-device secret on the server. |
| **Static IP (recommended)** | Configure a DHCP reservation on your router, or set a static IP in the firmware portal (`static_ip` / `static_gateway` / `static_subnet`). |
| **Power on** | Connect to power. Watch the serial monitor — it should connect to Wi-Fi and start posting to `/sensor`. |

#### 2. Verify it's talking to the server (before registering)

```bash
# Check server logs for auto-registration
grep "Auto-registered\|devices.*ON CONFLICT" server.log

# Or via API (admin session required)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/devices
```

You should see the new board with:
- **Device ID**: whatever firmware reports (e.g., `ESP32_07` or `NODEMCU_01`)
- **Badge**: **Auto** (auto-discovered)
- **IP**: whatever the server saw (may be a NAT address if the server is not on the same subnet)
- **Name**: empty

#### 3. Register it properly on the Dashboard (Devices page)

| Field | What to enter | Why |
|-------|---------------|-----|
| **Device ID** | Exact ID from firmware (case-sensitive): `ESP32_07` | Must match exactly or ingest will create a second row |
| **Device Name** | Friendly label: `Grow-out Tank 3` | Shows everywhere — Dashboard, Sensors, Reports |
| **IP Address** | **Your static LAN IP**: `192.168.1.150` | Locks it (`ip_source=manual`); health poller needs a LAN-reachable IP |
| **Location** (optional) | `Greenhouse B, Row 2` | Extra context |

Click **Register** -> row gets a **Manual** badge and **Online** status (green) within ~5 s.

#### 4. Verify end-to-end

| Check | How |
|-------|-----|
| **Dashboard** | Tank appears in selector, live readings show |
| **Sensors page** | Tank in dropdown, history loads |
| **Live Check** (Devices page) | Click Wi-Fi icon -> see firmware version, RSSI, uptime |
| **Alerts** | Set thresholds in Settings -> trigger test alert |
| **Reports** | Weekly/range reports include the new tank |

### B. Mock Device (no hardware, for dev/demo)

Full simulator documentation — profiles, CLI options, recipes — is in
[TESTING.md § Part 2](TESTING.md#part-2--mock-simulator-no-hardware). The short version:

```bash
# Terminal 1
npm run server

# Terminal 2
npm run dev

# Terminal 3 — single tank, healthy readings
npm run mock

# Or with options:
npm run mock -- --device ESP32_09 --profile healthy --interval 5000
npm run mock -- --profile fleet      # two tanks in parallel
  npm run mock -- --profile fleet10    # tanks 4-10
npm run mock -- --profile ammonia_spike
npm run mock -- --list-profiles      # see all 8 profiles
```

| Option | Meaning |
|--------|---------|
| `--device ESP32_09` | Device ID to use (auto-registers if new) |
| `--profile healthy` | Normal readings |
| `--profile warming` | Temperature slowly rises -> triggers warning |
| `--profile ammonia_spike` | Ammonia spikes -> critical alert + SMS |
| `--interval 5000` | Post every 5 s (default) |

On the first POST the server creates the row with `registered_via=auto` and an
**Auto** badge. To promote it: **Devices -> pencil -> enter a Name and a static IP
(`192.0.2.99` for TEST-NET) -> Save**. The badge flips to **Manual** and the IP is
locked.

### Quick Comparison

| Step | Real ESP32 / NodeMCU | Mock Device |
|------|---------------------|-------------|
| **Identity** | Flashed in firmware (`device_id` compile-time) | Passed via `--device` flag |
| **Auth** | `X-Device-Secret` header (shared or per-device) | Same, uses `DEVICE_SECRET` from `.env` |
| **IP** | Real LAN IP (health poller must reach it) | Any IP (health check will fail unless real) |
| **Auto-reg** | Happens on first sensor post | Same |
| **Manual reg** | Devices page -> Add Device | Same |
| **IP lock** | Enter static IP in Dashboard -> `ip_source=manual` | Same |
| **Alerts** | Real thresholds | Profile-driven (warming, ammonia_spike) |

### Common Gotchas

| Problem | Fix |
|---------|-----|
| **Duplicate ID error** | ID already exists (active, hidden, **or archived**). Check the Archived tab. |
| **IP keeps reverting** | You didn't save, or the board is `ip_source=auto`. Edit -> enter IP -> Save. |
| **Status = Unknown forever** | No IP configured. Edit the row, add the static LAN IP. |
| **Live Check = "Cannot reach server"** | Wrong IP, board offline, or server not on the same VLAN. |
| **Mock shows Auto but no readings** | Mock script not running, or wrong `DEVICE_SECRET`. |

### For your capstone demo script

> **60-second live demo:**
> 1. "Here's the Devices page — two real tanks."
> 2. "Add Device -> `DEMO_01`, `Demo Tank`, `192.0.2.50` -> Register."
> 3. "Instantly appears with a **Manual** badge. Now in every dropdown."
> 4. "Live Check -> shows firmware, RSSI."
> 5. "Archive -> gone from selectors, history retained."
> 6. "Try to re-add `DEMO_01` -> rejected: *ID permanently retired*."

## API smoke test (curl / Postman)

```bash
# Get an admin token (from your login session or the DB)
TOKEN="your_admin_token_here"

# List active fleet
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/devices

# List including archived
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/devices?include_archived=1"

# Register via API
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"device_id":"API_TEST_01","device_name":"API Tank","ip_address":"192.0.2.50"}' \
  http://localhost:3000/devices

# Archive via API
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/devices/API_TEST_01/archive

# Restore via API
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/devices/API_TEST_01/restore
```

## Verifying the module

The manual UI walkthroughs (registration, duplicate-ID protection, manual IP lock,
"does the tank appear everywhere") live in [TESTING.md](TESTING.md), together with
the automated suites:

```bash
npm run test:devices    # registration, uniqueness, claiming, archiving, IP provenance
npm run test:secrets    # per-device secret rotation, grace window, revocation
npm run test:all        # lint -> encoding -> build -> unit -> poller -> devices ->
                        # migration -> secrets -> regression
```

If a step fails: check the Troubleshooting table above, or run `npm run test:all`
to see which automated check catches it.

---

# Part 2 — Why it is built this way

> Everything below is the reasoning behind Part 1, preserved from the original
> design review so the decisions are not silently reversed. The review was written
> 2026-09-27; the verdicts it reached are the ones that shipped.

## Requirement review

| # | Requirement | Verdict at the time |
|---|---|---|
| 1 | New "Devices" page with Add Device form | **New work** — no create endpoint existed |
| 2 | Device ID unique system-wide, validated on add | **Mostly done** — already the PRIMARY KEY; needed an endpoint + UX |
| 3 | Remove fixed/hardcoded device limit (was 3) | **No-op** — no such limit existed; see below |
| 4 | No auto-provisioning / no web flasher | **Nothing to do** — no flasher exists |
| 5 | Device archiving (soft delete) | **Already worked** — via `is_active = false`; semantics only |

### There is no 3-device limit — the "3" was something else

The only `3`s in the codebase:

| Value | Location | Actual meaning |
|---|---|---|
| `3` | `services/devicePoller.cjs` | `FAILURE_THRESHOLD = 3` — consecutive failures before a health warning |
| `3` | (originally) | `CONCURRENCY = 3` — max *simultaneous HTTP GETs*, not a device cap. **Raised to `MAX_CONCURRENCY = 10`.** |
| `"ESP32_01"` | `ESP32_main_code.ino` | Firmware default device ID, one per physical board |
| `"ESP32_02"` | `NODE_main_code.ino` | Firmware default device ID, one per physical board |
| `deviceId[50]` | both `.ino` files | 50-char buffer matching the DB column width |

`POST /sensor` upserts *any* unknown `device_id`, so the registry was never
capped. The frontend tank list is built dynamically from `GET /devices`, which
has no `LIMIT`.

**The real scaling limit that did exist** was `CONCURRENCY = 3` with
`REQ_TIMEOUT_MS = 2000` on a 5 s poll cadence: at 12 devices a full poll cycle
is 4 batches, and a hung device stalls its whole batch for 2 s. Fixed by raising
`MAX_CONCURRENCY` to 10 — it is now the only thing that meaningfully throttles
the system at 10+ devices.

Other 10+ device considerations (all currently safe):

- `sensorIngestLimiter` is keyed per device (`device:<device_id>`), 12/sec — fine.
- In-memory Maps (`latestDeviceReadings`, `lastSensorReading`, `lastAmmoniaReading`,
  `deviceOnlineSince`, `disconnectedDevices`) are unbounded but small; they are
  evicted on archive to avoid a slow leak.
- `GET /devices/latest` does one query then loops — fine.
- SMS mute-list fetches are single queries — fine.
- SSE `/sensor/stream` broadcast rate scales linearly with device count.
- `SMS_DAILY_CAP` becomes relevant with more devices generating more alerts.

### Auto-registration conflicted with "unique, validated on add"

Any ESP32 presenting the shared `DEVICE_SECRET` creates its own registry row.
That makes an Add Device form **advisory, not authoritative** — a typo'd or rogue
device ID silently appears in the registry. Worse: archiving a device whose board
is still transmitting would mean the upsert keeps refreshing `last_seen` and
`ip_address` on the archived row indefinitely.

Two options were weighed:

- **Option A — keep auto-registration, add provenance (CHOSEN).**
  `registered_via VARCHAR(20) DEFAULT 'auto'`. The form writes `'manual'`, the
  ingest upsert writes `'auto'`. The Devices page shows an "auto-discovered, not
  registered" badge. Zero risk of a board going dark; the `sensors` FK is always
  safe.
- **Option B — strict: reject unregistered `device_id` on ingest.** Returns 403
  "device not registered". Matches the requirement literally, but archiving a
  still-transmitting device instantly starts a rejection storm plus disconnect
  alerts.

### Archiving: do not reuse `is_active`, and never make `device_id` reusable

The codebase already had **two** archive patterns, both introduced by
`db/migrations/006_archive_restore.cjs`:

- `users.status = 'archived'` — enum-style, with `deleted_at` and
  `pending_deletion_at` timestamps.
- `authorized_recipients.archived_at` — timestamp-style, NULL = active.

**Chosen: `archived_at TIMESTAMPTZ` (+ `archived_by`) on `devices`**, not a status
enum, because:

1. `is_active` already has a distinct, live meaning — "hidden from the tank
   dropdown, reversible". Overloading it for decommissioning conflates two
   different concepts.
2. It matches the `authorized_recipients` pattern, and archiving is a terminal
   state while hiding is not.
3. Archive implies `is_active = false`, so **every existing `WHERE is_active = true`
   filter keeps working untouched** — the per-device secret lookup, `/devices/latest`,
   the SMS alert list, the health poller, and `GET /devices` all drop an archived
   device with no change at those sites.

> **Do NOT make `device_id` reusable, even for archived rows.** Migration 006 does
> exactly that for usernames and phone numbers via partial unique indexes.
> Applying the same pattern to `device_id` would mean a *new* physical board
> reusing `ESP32_03` silently inherits the old board's entire `sensors` history
> through the FK. That is data-integrity poison. Archived device IDs stay
> permanently taken.

### The manual IP Address would have been clobbered

Ingest overwrites `ip_address` from the live peer on **every** POST, and
`normalizeClientIp` returns `null` for loopback (so local test tools do not
poison the registry). If the Node server is not on the same subnet as the tanks,
the address it records is the router/NAT address — not a LAN address the poller
can dial.

**Chosen: make a manually-entered IP authoritative.** `ip_source VARCHAR(10)
DEFAULT 'auto'`; the ingest upsert overwrites `ip_address` only when
`ip_source = 'auto'`. The poller needs a LAN-reachable static/DHCP IP, so the Add
Device form is the right place for it.

### Security issues found in passing

- `PUT /devices/:deviceId` was guarded by `requireAuth`, **not** `requireAdmin` —
  any logged-in non-admin user could rename or hide any tank. It and every other
  device write are now `requireAdmin`, consistent with `POST /auth/users` and
  `POST /settings/recipients`.
- The shared device secret was compared with plain `===`, not `timingSafeEqual` as
  the password path does. Hardened: `safeEqual()` is now used for the shared and
  per-device secrets on `POST /sensor`.

## Decisions put to the Owner before implementation

1. **The 3-device cap** — a limit was *not* observed at runtime. The "3" was the
   device poller's batch size, not a cap. **Resolution: no cap work needed** beyond
   raising poller concurrency to 10. Nothing in the schema or the API limits fleet
   size.
2. **Auto-registration** — **Option A: keep it**, tag it with `registered_via` so the
   UI can badge it. Rejecting (Option B) was rejected because a board that has never
   been through the Devices page would otherwise report *no data at all*, and the
   FK guarantee is valuable. `registered_via` is provenance, never a gate.
3. **"Device Name" → which column?** — **Both.** `POST /devices` writes the
   Owner-entered name to `name` *and* `tank_name`, so every existing display path
   (which all read `tank_name`) shows it, and `name` stops being dead. No second
   field in the form; `tank_location` remains separately editable.
4. **IP behaviour** — **Accepted `ip_source`.** An Owner-entered IP is authoritative
   and ingest will not overwrite it while `ip_source='manual'`; the form field
   effectively switches the device to manual-IP mode on creation.
5. **Menu visibility** — **Admin-only.** All the writes on the page are
   `requireAdmin`, so showing it to a `user` would only present controls that all
   fail. `"Devices"` is in `VALID_MENU_KEYS` but omitted from `USER_MENU_KEYS`.
6. **Reclaiming archived devices** — **Archive-and-retain is sufficient; no purge.**
   No hard-delete endpoint was added, and archived IDs are permanently reserved, so
   a future board can never inherit a retired ID's historical readings.

## What shipped

| Area | Change |
|---|---|
| `db/migrations/014_device_registration.cjs` | `archived_at`, `archived_by`, `registered_via`, `ip_source`; 3 CHECKs; `idx_devices_archived_at`; case-insensitive unique `idx_devices_device_id_ci`; backfill. Idempotent — verified over 3 consecutive runs. See [DATABASE.md](DATABASE.md) for the full migration table |
| `db/migrations/015_device_secret_rotation.cjs` | `device_secret_rotated_at`, `device_secret_prev`, `device_secret_prev_expires_at`; check + partial indexes |
| `server.cjs` | `isIpv4` / `blankToUndefined` / `createDeviceSchema` / `DEVICE_COLUMNS`; `POST /devices`; `archive` + `restore` + `rotate-secret` routes; archived columns in registry responses; `include_archived`; `PUT` → `requireAdmin`; `evictDeviceFromMemory()`; provenance-preserving ingest; `archived_at IS NULL` guards on active queries |
| `services/devicePoller.cjs` | excludes archived devices; `MAX_CONCURRENCY = 10` |
| `tests/devices.cjs` (+ `test:devices` script) | the device registry suite |
| `src/types/index.ts` | `DeviceEntry` extended; `CreateDevicePayload`; `DeviceArchiveResult`; `"Devices"` in `VALID_MENU_KEYS` |
| `src/api/client.ts` | `createDevice`, `archiveDevice`, `restoreDevice`, `rotateDeviceSecret`; `fetchDevices(includeHidden, signal, includeArchived)` |
| `src/pages/DevicesPage.tsx` | Add Device form (Zod), active/archive toggle, provenance badges, live check, archive confirmation, restore |
| `src/App.tsx` | lazy import, `Cpu` menu entry, `renderPage` case, admin-only gating |
| `docs/DATABASE.md`, `docs/ARCHITECTURE.md` | migration 014 documented; `device_secret` added to the DBML; archive-vs-hide table; endpoint map; poller concurrency |

## Notes for future maintainers

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
- **`GET /devices/:deviceId/status` requires a session.** It is *not* the path the
  health poller uses — the poller calls the **board's** own `/status` on
  `http://<device-ip>/status` over the LAN. Do not put secrets on either.
- **`DEVICE_COLUMNS` in `server.cjs` is the security boundary for device reads.**
  Every read endpoint hands out exactly those columns. It must never gain a secret
  column (`device_secret`, `device_secret_prev`); rotation is metadata only.

## Historical state at the time of the review

Preserved because it explains *why* each piece above was new work. All of it has
since shipped.

| Requirement | State before | Gap |
|---|---|---|
| Device ID unique system-wide, validated on add | `devices.device_id VARCHAR(50) PRIMARY KEY` — already globally unique at the DB level. No endpoint created a device. | Needed `POST /devices` + a frontend pre-check |
| Remove fixed/hardcoded device limit | No device cap existed anywhere | Nothing to remove |
| Add Device form (ID, Name, IP) | `devices.name` existed but **no code path ever wrote it** — it was dead. The real display label is `tank_name`. | New endpoint + page |
| No auto-provisioning / no web flasher | Nothing to do — firmware is `.ino` files flashed manually | None |
| Device archiving | Worked via `is_active = false`; FKs from `sensors` / `last_alerts` are `NO ACTION` and `system_logs` is `SET NULL`, so history survived | Semantics only |

The `devices` table columns at that point, for reference:

| Column | Type | Notes |
|---|---|---|
| `device_id` | VARCHAR(50) | **PRIMARY KEY** — ESP32 device identifier |
| `name` | VARCHAR(100) | Optional friendly name — **was never written by any code path** |
| `is_active` | BOOLEAN | NOT NULL DEFAULT true |
| `created_at` | TIMESTAMPTZ | Device first seen (migration 007) |
| `last_seen` | TIMESTAMPTZ | Latest reading timestamp (migration 007) |
| `ip_address` | TEXT | Static LAN IP, used by the poller to reach `GET /status` |
| `tank_name` | VARCHAR(100) | Friendly tank label — **the actual display label everywhere** |
| `tank_location` | VARCHAR(100) | Physical location / zone |
| `device_secret` | VARCHAR(255) | Optional per-device ingestion secret (migration 008) |
| `last_health_seen` | TIMESTAMPTZ | Last successful `GET /status` poll |

And the API surface, which had no create path at all:

| Method | Path | Auth |
|---|---|---|
| GET | `/devices` | `requireAuth` (now the same, plus archived columns) |
| PUT | `/devices/:deviceId` | `requireAuth` → **now `requireAdmin`** |
| GET | `/devices/latest` | `requireAuth` |
| GET | `/devices/:deviceId/status` | `requireAuth` |
| POST | `/sensor` (ingest, auto-registers) | `X-Device-Secret` |

Incoming references to `devices`, and what happens to them on archive:

| Table | Column | FK behaviour |
|---|---|---|
| `sensors` | `device_id` | `NO ACTION` — history preserved on archive |
| `last_alerts` | `device_id` (composite PK) | `NO ACTION` |
| `system_logs` | `device_id` (nullable, migration 011) | `SET NULL` — the log row survives, its tank attribution is dropped |
| `device_threshold_overrides` | `device_id` (PK, migration 012) | `CASCADE` — configuration, not history, so it goes with the device |

No CASCADE into history: `sensors` and `last_alerts` are `NO ACTION` and
`system_logs` is `SET NULL`, so archiving preserves every reading and every log
row. The only `CASCADE` is `device_threshold_overrides`, and it holds per-tank
threshold configuration rather than data worth keeping — a restored device simply
falls back to the global `sensor_settings` values. In practice none of these fire,
because the system has no hard delete or purge endpoint for a device.

---

## Doc corrections (2026-10)

Recorded while merging `DEVICES_MODULE_HOWTO.md` and `DEVICES_MODULE_PLAN.md`.

| Claim | Was | Now | Verified against |
|---|---|---|---|
| `test:devices` size | 91 checks | **104 checks** | `TESTING_GUIDE.md` suite table |
| `test:all` scope | "all 4 test suites (115+ checks)" | **9 steps**: lint, encoding, build, unit, poller, devices, migration, secrets, regression | `package.json` |
| Poller suite size | 19 checks | **34 checks** | `tests/devicePoller.cjs` |
| Poller concurrency | `CONCURRENCY = 3` | **`MAX_CONCURRENCY = 10`** | `services/devicePoller.cjs:23` |
| Next free migration number | `014` | **017** | `db/migrations/` |
| `PUT /devices/:deviceId` auth | `requireAuth` | **`requireAdmin`** | `server.cjs:2310` |
| `GET /devices/:deviceId/status` auth | "unauthenticated by design" | **`requireAuth`** — and the poller never used it; it calls the board's `/status` | `server.cjs:2663`, `services/devicePoller.cjs:51` |
| Poll failure handling | "marks the device offline" | **logs a backoff-limited warning**; offline is derived from the heartbeat | `services/devicePoller.cjs:71-82` |
| `devices.device_secret` missing from the DBML | flagged as drift | **present** | [DATABASE.md](DATABASE.md) |

---

*End of the devices module.*