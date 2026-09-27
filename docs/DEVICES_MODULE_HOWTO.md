# How to Use the Devices Module

The Devices module lets you register, monitor, and retire ESP32 boards without ever editing the database by hand.

---

## Open the page

1. Sign in as an **admin** account.
2. In the left sidebar, click **Devices** (CPU icon).
   - The page is hidden from non-admin users because every write action requires admin rights.

---

## Register a new ESP32

1. Click **Add Device** (top-right).
2. Fill the form:
   - **Device ID** — the exact `device_id` the ESP32 reports (e.g. `ESP32_03`, `tank-01`, `ABC123`).
     - Must be unique **system-wide, case-insensitively**.
     - A retired (archived) ID can never be reused — you will get a clear error if you try.
   - **Device Name** — friendly label shown everywhere on the dashboard (e.g. `Tank 3 – Bayside`).
     - Written to both `name` and `tank_name` columns so every existing view picks it up.
   - **IP Address** (optional) — static LAN IP of the board (e.g. `192.168.4.103`).
     - If you enter it, the backend **locks it** (`ip_source = 'manual'`). Later sensor ingests will **not** overwrite it.
     - Leave blank to let the board announce its own IP on first contact (`ip_source = 'auto'`).
3. Click **Register**.
   - On success the device appears in the **Active** table immediately.
   - The row shows a **Manual** badge (provenance = you registered it).
   - If the board has already reported data, you’ll see its last reading time and health status.

---

## View the fleet

The page has two tabs:

### Active
- All devices where `archived_at IS NULL` and `is_active = true`.
- Columns: Device ID, Name, IP, Registered Via, Last Reading, Last Health, Status, Actions.
- **Status** chip:
  - **Online** (green) — health poll succeeded within the last ~15 s.
  - **Offline** (red) — 3+ consecutive failed health polls.
  - **Unknown** (gray) — no IP configured yet, or never polled.

### Archived
- Devices you have retired. They are **excluded** from:
  - Tank dropdowns on every other page
  - Health polling
  - SMS alerting
- Their historical sensor data, alerts, and logs remain fully queryable via `GET /sensor?device_id=...` and the Historical Data page.
- Click **Restore** to bring a device back to Active (clears `archived_at`/`archived_by`, sets `is_active = true`).

---

## Edit an active device

In the Active table, click the **pencil** icon on a row:
- Change the **Name** (updates `tank_name` everywhere).
- Change the **IP Address** (switches `ip_source` to `manual`).
- Toggle **Active** off to hide the device without archiving it (it stops being polled and drops out of tank selectors, but the ID stays reservable for restore).

Click **Save**.

---

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

---

## Restore an archived device

1. Switch to the **Archived** tab.
2. Click the **rotate-ccw** (restore) icon on the row.
3. The device returns to the Active tab, `is_active = true`, `archived_at`/`archived_by` cleared.
   - Note: the Device ID was never released, so no conflict is possible.

---

## Live health check (on-demand)

Any row with an IP address shows a **Live Check** button (Wi-Fi icon). Click it to:
- Fire an immediate `GET /status` to that ESP32 (3 s timeout).
- See the raw JSON response (firmware version, uptime, Wi-Fi RSSI, sensor snapshot).
- If the board replies with a mismatched `device_id`, the modal warns you — the IP in the registry points to a different physical board.

---

## What happens automatically

| Event | What the backend does |
|-------|----------------------|
| ESP32 posts to `/sensor` with an **unknown** `device_id` | Auto-creates a row (`registered_via = 'auto'`), so the FK never fails. You’ll see an **Auto** badge on the Devices page — register it properly later to get a Manual badge and set the name/IP. |
| ESP32 posts with a **manual IP** already set | The ingest **ignores** the IP in the payload; your entered address wins. |
| Health poller runs (every 5 s) | Polls up to **10 devices concurrently** (was 3). A hung board times out in 2 s and never blocks the others. |
| Device hits 3 consecutive poll failures | Marked **Offline** in the UI; a single warning is logged (rate-limited to once per 30 s per device). |
| You archive a device | `archived_at` + `archived_by` set, `is_active = false`. Poller’s query (`WHERE archived_at IS NULL`) excludes it immediately. |
| You restore a device | `archived_at`/`archived_by` cleared, `is_active = true`. Poller picks it up on the next cycle. |

---

## API reference (for integrations)

| Method | Path | Auth | Body / Params | Notes |
|--------|------|------|---------------|-------|
| GET | `/devices` | user/admin | `?include_hidden=1` `?include_archived=1` | Returns `registered_via`, `ip_source`, `archived_at` |
| POST | `/devices` | admin | `{ device_id, device_name, ip_address? }` | 409 if ID taken (case-insensitive, even vs archived) |
| PUT | `/devices/:id` | admin | `{ name?, ip_address?, is_active?, tank_location? }` | |
| POST | `/devices/:id/archive` | admin | — | Sets `archived_at`/`archived_by`, `is_active=false` |
| POST | `/devices/:id/restore` | admin | — | Clears archive fields, `is_active=true` |
| GET | `/devices/:id/status` | user/admin | — | Live `GET /status` to the ESP32 (3 s timeout) |

---

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| “Device ID already registered” on a brand-new board | The ID exists in the table (active, hidden, **or archived**). Check the Archived tab. IDs are never reusable. |
| IP keeps reverting after I set it | You didn’t save, or the board is still `ip_source = 'auto'`. Edit the row, enter the IP, Save — the badge switches to **Manual**. |
| Device shows **Unknown** status forever | No IP configured. Edit the row and add the static LAN IP. |
| Archived device still appears in a tank dropdown | Impossible — the dropdown queries `WHERE archived_at IS NULL`. Clear your browser cache / hard-refresh. |
| “Cannot reach server” on Live Check | The ESP32 is powered off, on a different VLAN, or the IP in the registry is wrong. Use the Live Check modal to see the exact error. |
| Non-admin user sees the Devices link | They shouldn’t. The menu entry is gated by `USER_MENU_KEYS` (admin only). If you see it, check `src/types/index.ts` `VALID_MENU_KEYS` vs `USER_MENU_KEYS`. |

---

## Quick checklist for a new tank

1. Physically install the ESP32, give it a static DHCP reservation (or static IP).
2. Open **Devices → Add Device**.
3. Enter the board’s `device_id`, a friendly **Name**, and the static **IP**.
4. Click **Register** → verify **Manual** badge, **Online** status after ~5 s.
5. Go to **Sensors** or **Dashboard** — the tank now appears in every dropdown.
6. Set per-tank thresholds in **Settings** if they differ from global defaults.
7. Add SMS recipients in **Settings → Recipients** if this tank needs its own alerts.

That’s it — the board is now a first-class citizen of the fleet.

---

## Complete Step-by-Step: Adding a New Device (Real ESP32 or Mock)

### A. Real ESP32 (your spare hardware)

#### 1. Prepare the ESP32 hardware
| Action | Details |
|--------|---------|
| **Flash firmware** | Use the ESP32 firmware repo (separate). Compile with your Wi-Fi credentials. |
| **Set `DEVICE_SECRET`** | In firmware config: `#define DEVICE_SECRET "your_shared_secret"` — must match `.env` on server. |
| **Static IP (recommended)** | Configure DHCP reservation on your router, or set static IP in firmware: `IPAddress(192,168,4,107)` |
| **Power on** | Connect to power. Watch serial monitor — it should connect to Wi-Fi and start posting to `/sensor`. |

#### 2. Verify it's talking to the server (before registering)
```bash
# Check server logs for auto-registration
grep "Auto-registered\|devices.*ON CONFLICT" server.log

# Or via API (admin token needed)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/devices
```
You should see the new board with:
- **Device ID**: whatever firmware reports (e.g., `ESP32_07`)
- **Badge**: **Auto** (auto-discovered)
- **IP**: whatever the server saw (may be NAT address if server not on same subnet)
- **Name**: empty

#### 3. Register it properly on the Dashboard (Devices page)
| Field | What to enter | Why |
|-------|---------------|-----|
| **Device ID** | Exact ID from firmware (case-sensitive): `ESP32_07` | Must match exactly or ingest will create a second row |
| **Device Name** | Friendly label: `Grow-out Tank 3` | Shows everywhere — Dashboard, Sensors, Reports |
| **IP Address** | **Your static LAN IP**: `192.168.4.107` | Locks it (`ip_source=manual`); health poller needs LAN-reachable IP |
| **Location** (optional) | `Greenhouse B, Row 2` | Extra context |

Click **Register** → row gets **Manual** badge, **Online** status (green) within ~5s.

#### 4. Verify end-to-end
| Check | How |
|-------|-----|
| **Dashboard** | Tank appears in selector, live readings show |
| **Sensors page** | Tank in dropdown, history loads |
| **Live Check** (Devices page) | Click Wi-Fi icon → see firmware version, RSSI, uptime |
| **Alerts** | Set thresholds in Settings → trigger test alert |
| **Reports** | Weekly/range reports include the new tank |

---

### B. Mock Device (no hardware, for dev/demo)

#### 1. Start backend + frontend (if not running)
```bash
# Terminal 1
npm run server

# Terminal 2
npm run dev
```

#### 2. Run the mock script
```bash
# Basic: single tank, healthy readings
npm run mock

# Or with options:
npm run mock -- --device ESP32_09 --profile healthy --interval 5000
npm run mock -- --profile fleet    # two tanks in parallel
npm run mock -- --profile ammonia_spike
npm run mock -- --list-profiles   # see all 8 profiles
```

| Option | Meaning |
|--------|---------|
| `--device ESP32_09` | Device ID to use (auto-registers if new) |
| `--profile healthy` | Normal readings (temp 28°C, water 60%) |
| `--profile warming` | Temp slowly rises → triggers warning |
| `--profile ammonia_spike` | Ammonia spikes → critical alert + SMS |
| `--interval 5000` | Post every 5s (default) |

#### 3. Watch it auto-register
- First POST → server creates row with `registered_via=auto`, badge **Auto**
- Check Devices page → new row appears with **Auto** badge

#### 4. (Optional) Promote to Manual registration
1. Open **Devices** page
2. Find the mock device (e.g., `ESP32_09`)
3. Click **pencil** → enter a friendly **Name** and **static IP** (`192.0.2.99` for TEST-NET)
4. Click **Save** → badge flips to **Manual**, IP locked

#### 5. Test scenarios without hardware
| Scenario | Command |
|----------|---------|
| Normal operation | `npm run mock -- --device ESP32_09 --profile healthy` |
| Warning alert | `npm run mock -- --device ESP32_09 --profile warming` |
| Critical + SMS | `npm run mock -- --device ESP32_09 --profile ammonia_spike` |
| Two tanks | `npm run mock -- --profile fleet` |
| Disconnect test | Ctrl+C mock → watch poller mark **Offline** after ~15s |

---

### Quick Comparison

| Step | Real ESP32 | Mock Device |
|------|------------|-------------|
| **Identity** | Flashed in firmware (`device_id` compile-time) | Passed via `--device` flag |
| **Auth** | `X-Device-Secret` header (shared or per-device) | Same, uses `DEVICE_SECRET` from `.env` |
| **IP** | Real LAN IP (health poller must reach it) | Any IP (health check will fail unless real) |
| **Auto-reg** | Happens on first sensor post | Same |
| **Manual reg** | Devices page → Add Device | Same |
| **IP lock** | Enter static IP in Dashboard → `ip_source=manual` | Same |
| **Alerts** | Real thresholds | Profile-driven (warming, ammonia_spike) |

---

### Common Gotchas

| Problem | Fix |
|---------|-----|
| **Duplicate ID error** | ID already exists (active, hidden, **or archived**). Check Archived tab. |
| **IP keeps reverting** | You didn't save, or board is `ip_source=auto`. Edit → enter IP → Save. |
| **Status = Unknown forever** | No IP configured. Edit row, add static LAN IP. |
| **Live Check = "Cannot reach server"** | Wrong IP, board offline, or server not on same VLAN. |
| **Mock shows Auto but no readings** | Mock script not running, or wrong `DEVICE_SECRET`. |

---

### For Your Capstone Demo Script

> **60-second live demo:**
> 1. "Here's the Devices page — two real tanks."
> 2. "Add Device → `DEMO_01`, `Demo Tank`, `192.0.2.50` → Register."
> 3. "Instantly appears with **Manual** badge. Now in every dropdown."
> 4. "Live Check → shows firmware, RSSI."
> 5. "Archive → gone from selectors, history retained."
> 6. "Try to re-add `DEMO_01` → rejected: *ID permanently retired*."

---

## How to verify the module is working

### 1. Quick UI sanity check (30 seconds)
1. Sign in as admin → open **Devices** page.
2. You should see your existing fleet (e.g., `ESP32_01`, `ESP32_02`) in the **Active** tab.
3. Click **Add Device** → form opens, no console errors.
4. Switch to **Archived** tab → should be empty (or show previously retired devices).

### 2. End-to-end registration test (2 minutes)
1. Click **Add Device**.
2. Enter a **new** Device ID (e.g., `TEST_TANK_01`), a **Name** (`Test Tank`), and a **dummy IP** (`192.0.2.99` — TEST-NET, guaranteed unreachable).
3. Click **Register**.
4. Verify:
   - Row appears in **Active** tab immediately.
   - **Manual** badge shows.
   - **Unknown** status (gray) — because the IP is unreachable.
5. Click the **pencil** icon → change Name to `Test Tank Renamed` → Save.
   - Name updates in the table instantly.
6. Click **Archive** → type the Device ID to confirm → Archive.
   - Row moves to **Archived** tab with timestamp and your username.
7. In **Archived** tab, click **Restore**.
   - Row returns to **Active**, `is_active = true`.

### 3. Duplicate-ID protection test (30 seconds)
1. Try to **Add Device** again with the same `TEST_TANK_01`.
2. You should get a **409 error** inline on the Device ID field:
   > "Device ID "TEST_TANK_01" is already registered and archived. Device IDs are permanently retired — choose a different ID for the new board."
3. Try a case variant (`test_tank_01`) — same 409 (case-insensitive uniqueness).

### 4. Manual IP lock test (if you have a real ESP32)
1. Register a device with a real static IP.
2. Let the board post sensor data (or use the mock script).
3. Edit the device → change IP to a different address → Save.
4. Post another sensor reading from the board.
4. Refresh Devices → IP **stays at your manual value** (badge = Manual).

### 5. API smoke test (curl / Postman)
```bash
# Get admin token (from your login session or DB)
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

### 6. Automated test suite (full regression)
```bash
# From repo root — runs all 4 test suites (115+ checks)
npm run test:all
```
Expected output:
```
=== ALL DEVICE POLLER TESTS PASSED === (19 checks)
=== ALL 91 DEVICE TESTS PASSED ===
=== ALL REGRESSION TESTS PASSED ===
```

### 7. Verify tank appears everywhere
After registering a device:
- **Dashboard** → tank shows in the selector
- **Sensors** page → tank in dropdown
- **Historical Data** → tank in dropdown
- **Settings → Thresholds** → per-tank override row appears
- **Settings → Recipients** → can assign SMS to that tank
- **Analytics / Reports** → device_id filter includes it

### 8. Verify archived device disappears from selectors
1. Archive the test device.
2. Go to **Dashboard / Sensors / Historical Data / Settings** — the tank should **not** appear in any dropdown.
3. `GET /sensor?device_id=TEST_TANK_01` still returns its historical readings.

---

**If any step fails:** check the Troubleshooting table above, or run `npm run test:all` to see which automated check catches it.