# CRAYvings Monitoring System — How It Works

---

## System Overview

The CRAYvings Monitoring System is an IoT-based aquaculture monitoring solution
for crayfish production. It collects real-time water quality data from sensors
and displays it through a responsive web dashboard. The system consists of
three main layers: hardware (ESP32 + sensors), backend (Express + PostgreSQL),
and frontend (React dashboard).

### Multi-tank / star topology

One dedicated ESP32 per tank (up to six in the current fleet) reports to a single
central server on the same LAN, `192.168.4.0/24`:

| Address | Role |
|---|---|
| `192.168.4.10` | central server (backend + dashboard) |
| `192.168.4.1` | access point / router (gateway + DHCP) |
| `192.168.4.100` | ESP32 — Tank 1 (`device_id` `tank01`) |
| `192.168.4.101` | ESP32 — Tank 2 (`device_id` `tank02`) |
| … | … |
| `192.168.4.105` | ESP32 — Tank 6 (`device_id` `tank06`) |

**Each ESP32:**

- **Pushes** readings to `POST /sensor` every 1000 ms (the live data path; a
  firmware drop-proof ring buffer queues up to 600 readings when the
  server/network is down and flushes them oldest-first on recovery).
- **Exposes** a read-only `GET /status` endpoint (ESPAsyncWebServer on port 80)
  with diagnostics: `device_id`, `ip`, `uptime_ms`, `wifi_rssi`, `free_heap`, and
  the current sensor values.
- Sends the `X-Device-Secret` header when a `device_secret` is configured in the
  config portal.

**The central server:**

- **Persists** readings to PostgreSQL (change-only / delta logging keeps the
  table small).
- **Polls** each device's `GET /status` every ~5 s (`services/devicePoller.cjs`)
  for health/diagnostics only — it **never** writes `sensors` rows. The poller
  records `devices.last_health_seen` and marks the device offline after 3
  consecutive failures.
- **Tracks** the fleet registry (`device_id`, `ip_address`, `tank_name`,
  `tank_location`, `last_health_seen`) in the `devices` table (migration 007),
  with explicit Owner registration via `POST /devices` plus `registered_via` /
  `ip_source` provenance and `archived_at` soft-delete (migration 014).
- **Serves** the fleet to the frontend via `GET /devices` (with online flags) and
  `GET /devices/:id/status` (live on-demand query of one device).

The dashboard reads the fleet through a single global **"selected tank"**. The
1-second live poll and every history/analytics query are scoped to that tank via
the `device_id` query parameter; a 5-second fleet poll drives the tank selector
chips and the Fleet Status grid (with an on-demand "Live check" per device).

---

## Technology Stack

| Component | Technology | Version |
|---|---|---|
| Frontend | React + TS | React 19, TS 5.9 |
| Build Tool | Vite | 8.0 |
| Styling | Tailwind CSS | 4.2 |
| Charts | Recharts | 3.8 |
| Icons | lucide-react | 1.8 |
| PDF Export | jsPDF + autoTable | 4.2 + 5.0 |
| Backend | Express.js | 5.2 |
| Database | PostgreSQL | 15+ |
| ORM | pg | 8.20 |
| Validation | Zod | 4.3 |
| HTTP Client | Axios | 1.15 |
| SMS Service | SkySMS API | — |

---

## Architecture Diagram

```text
+-----------------------------------------------------------------------+
|                    CRAYvings Monitoring System                         |
+-----------------------------------------------------------------------+
|                                                                       |
|  +----------+     +--------------+     +-------------+     +--------+ |
|  | ESP32 x6 |     |  Express API |     |  PostgreSQL  |---->| React  | |
|  | (1/tank) |---->|  Backend     |-----|  Database    |     | Dash-  | |
|  |  push    |     |     +        |     +-------------+     | board  | |
|  +----------+     | Device Poller|     |  devices      |    +--------+ |
|      |  |  |      +--------------+     |  (registry +  |        |      |
|      |  |  |--GET /status (5s)-->|     |   health)     |        |      |
|      |  |  |        |                |  sensors (1Hz  |        |      |
|      |  |  |     +-------------------+  pushes, delta |        |      |
|      |  +-----+  | Alert / SMS     |  logged)        |        |      |
|      +--------+  | Generation      | last_alerts     |        |      |
|                 +-------------------+ system_logs    |        |      |
|                                                                       |
|  Each ESP32 (Tank 1..6) at 192.168.4.100..105:                        |
|  Sensors:                                                 Pages:      |
|  - DS18B20 (Temperature)            POST /sensor (1s)       Dashboard|
|  - Ultrasonic (water level %)       GET  /status (async)    Sensors  |
|  - Ammonia (MQ-137 NH3 ppm)         config portal (WiFiMgr)  Alerts   |
|                                                             Historical|
|                                                             Analytics |
|                                                             Settings  |
+-----------------------------------------------------------------------+
```

---

## Complete Feature List

### 1. Real-time water quality monitoring

The system continuously monitors water parameters collected by the ESP32:

| Parameter | Sensor | Range | Unit | Default Threshold |
|---|---|---|---|---|
| Temperature | DS18B20 | 0 to 50 | °C | 20 – 31 °C |
| Water Level | Ultrasonic HC-SR04 | 0 to 100 | % | 10 – 100 % |
| Ammonia | MQ-137 (NH3 gas) | 0 to 500 | ppm | 0 – 25 ppm |

Features:

- Continuous data collection from ESP32 every 1000 ms
- Sensor validation before sending data (invalid readings sent as −1)
- Real-time display updates every 1 second via polling
- Visual indicators for sensor status (online/offline)
- Connection status detection based on actual sensor data timestamp (not poll
  time)

> **Note:** Ammonia is measured as real NH3 gas concentration in ppm using the
> MQ-137 chemiresistor (`readAmmonia()` in the ESP32 sketches, e.g.
> `water_monitoring_system/ESP32_main_code/ESP32_main_code.ino`). The firmware
> computes Rs/R0 from the module's analog output and converts it to ppm with the
> datasheet NH3 curve. R0 is calibrated in clean air on first boot (and persisted
> to NVS); triple-tap the top-right corner of the display to recalibrate. Failed
> readings are sent as −1.

### 2. Intelligent alert system

The system includes smart alert cooldown to prevent alert spam:

- Threshold detection with severity classification
- Critical status when values exceed 15% outside threshold range
- Warning status when values are slightly outside range
- Smart alerting: only alerts on status transitions (not continuous)
- 10-second cooldown between repeated alerts for same parameter
- Automatic reset when values return to safe range

**Alert severity logic**

| Condition | Status | Color |
|---|---|---|
| value within threshold range | GOOD | green |
| value slightly outside threshold | WARNING | orange |
| value 15%+ outside threshold | CRITICAL | red |

### 3. Device connection monitoring

The system actively monitors ESP32 connectivity:

- **Stale data detection:** connection status uses sensor data timestamp, not API
  response time
- **15-second offline threshold:** if data is older than 15 s, device is marked
  offline
- **Last known data display:** when disconnected, pages show cached readings with
  yellow offline banner
- **Auto-recovery:** when fresh data arrives, all pages automatically recover
- **Activity logging:** `device_disconnect` and `device_connect` events logged

### 4. Data-driven insights & analytics

- Historical data analysis with time range filtering (1h, 6h, 24h, 1w, all time)
- Trend charts for Temperature, Water Level, and Ammonia using Recharts
- Statistical summaries on dashboard
- Export capability via PDF (LogsPage exports system logs, Historical Data
  exports weekly report)
- Weekly report: 7-day summary (min/avg/max per sensor), daily breakdown, and
  alert counts
- Flexible history fetching: backend supports up to 1000 records (default: 300)
- **Available while device is offline:** history is read from the database, so it
  stays viewable when the ESP32 disconnects (an amber banner shows the last
  recorded data time; short ranges that would be empty are dimmed)
- **Failed-sensor sentinel filtering:** readings the ESP32 marks as failed (−1,
  and 0 for temperature) are excluded from charts and statistics

### 5. Mobile-responsive dashboard

- Fully responsive React UI using Tailwind CSS
- Mobile-friendly navigation sidebar
- Adaptive grid layouts for all screen sizes
- Touch-friendly buttons and controls

### 6. Settings management

- Configurable thresholds via Settings page
- Persistent storage in database
- Real-time validation with range checking
- Activity logging for all changes
- SMS recipient management: add, edit, delete recipients
- SMS mute/sleep: pause SMS alerts for 1/2/4/6/8/12/24 hours
- Test SMS: verify SMS configuration
- User management: create, delete, reset passwords

### 7. Activity logging

- Track all user interactions
- Log navigation, button clicks, form submissions
- Log device connect/disconnect events
- Filterable and searchable activity history
- Pagination support

### 8. Custom alert sounds

- Synthetic audio tones (Web Audio API)
- Custom sound upload capability
- Sound enable/disable toggle
- Critical disconnect alerts play double-beep sound

### 9. SMS alert system

- SkySMS API integration for sending SMS notifications
- Threshold alerts: sent when sensor values exceed critical thresholds
- Disconnect alerts: sent when ESP32 device goes offline
- Mute/sleep feature: pause SMS for 1/2/4/6/8/12/24 hours
- Recipient management: add, edit, delete authorized recipients
- SMS cooldown: configurable cooldown period
- SMS logging: track all sent messages with status
- Test SMS: send test messages to verify configuration
- Active/inactive toggle: enable/disable recipients without deletion

### 10. PDF export

- Export system logs to PDF using jsPDF + jspdf-autotable
- Parameter filtering (Temperature, Water Level, Ammonia)
- Summary section with parameter counts
- Auto-table formatting with pagination support (correct page numbers on
  multi-page exports)
- Available in LogsPage
- Weekly report export: Historical Data page (1 Week range) exports the summary,
  daily table, and alert breakdown to PDF

---

## Data Flow

```text
ESP32 --POST--> /sensor --Validate--> PostgreSQL --Query--> Frontend
    |              |                  |  sensors           |    |
    |              |                  v                  |    |
    |              |           Check Thresholds        |    |
    |              |                  |                  |    |
    |              |                  v                  |    |
    |              +---------> system_logs <-------------+    |
    |                       (Alerts)                         |
    |                                                     v
    |                                              Real-time Display
    |                                              (every 1 second)
```

### 1. Data collection (ESP32)

The ESP32 microcontroller reads sensor values at regular intervals:

- **Temperature:** DS18B20 waterproof sensor (OneWire protocol)
- **Water Level:** Ultrasonic HC-SR04 distance sensor with averaging (5 samples)
- **Ammonia:** MQ-137 chemiresistor measuring real NH3 gas concentration (ppm)

### 2. Data transmission

Each ESP32 pushes a POST request to the backend server via Wi-Fi:

```http
POST http://192.168.4.10:3000/sensor
Content-Type: application/json
X-Device-Secret: your_shared_secret
```

(the secret is sent when `device_secret` is configured on the device; required
only if `DEVICE_SECRET` is set on the server)

```json
{
  "device_id": "tank01",
  "temperature": 25.5,
  "water_level": 80.0,
  "ammonia": 4.5
}
```

Unlimited success payloads that add no new values are skipped server-side by
delta logging, so the device pushes at 1 Hz but the database only grows when
something changes.

Each ESP32 **also** runs an HTTP server (port 80) answering `GET /status` with
JSON diagnostics (`{ device_id, ip, uptime_ms, wifi_rssi, free_heap,
temperature, water_level, ammonia }`). The backend `devicePoller` queries it
every ~5 s to build fleet health — read-only, never stored as sensor rows.

**Static IP:** the firmware applies a static IP from NVS (WiFi config portal
fields `static_ip` / `static_gateway` / `static_subnet`) right after connecting
to the network, so each tank consistently sits at `192.168.4.100..105`. If the
router instead uses DHCP address reservations, configure those à la carte —
whichever approach is chosen should put every device on the `192.168.4.0/24`
subnet where the central server listens.

### 3. Backend processing

The Express server (`server.cjs`) performs these operations:

- **a) Validation:** uses Zod schema to validate incoming data
- **b) Storage:** inserts readings into the PostgreSQL `sensors` table — but only
  when change-only (delta) logging sees a value move beyond tolerance; unchanged
  readings refresh `devices.last_seen` as a heartbeat only
- **c) Threshold checking:** compares values against configurable settings;
  readings below each sensor's `minValid` (temperature `0.0001`, water level `0`)
  are treated as failed sensors (−1 from the ESP32) and skipped
- **d) Alert generation:** creates alerts for out-of-range values
- **e) Logging:** records all alerts to the `system_logs` table
- **f) History API:** accepts a `limit` parameter (1-1000, default: 300) for
  flexible data retrieval

### 4. Frontend display

The React dashboard:

- **a) Polling:** fetches data every 1 second
- **b) Display:** shows real-time readings in cards and charts
- **c) Connection check:** uses sensor data timestamp to determine online/offline
- **d) Offline display:** shows last known readings with yellow banner when ESP32
  disconnected
- **e) Alerts:** warns users when parameters exceed thresholds
- **f) Disconnect alerts:** floating popup + sound + activity log when ESP32
  offline
- **g) SMS:** sends SMS for critical alerts and device disconnects (unless muted)
- **h) Audio:** plays alert sounds for threshold violations and disconnects

---

## Connection & Offline Handling

### How connection status works

The frontend polls `GET /sensor/latest` every 1 second, scoped to the currently
selected tank (`&device_id=...`). The connection status is determined by the
`recv_at` heartbeat (the receive time of the latest POST, always newer than the
data's stored timestamp). With change-only (delta) logging enabled, unchanged
readings are skipped so the data timestamp would otherwise go stale — `recv_at`
is bumped on every single POST.

```js
lastUpdate = new Date(latest.recv_at || latest.timestamp)
gap = Date.now() - lastUpdate.getTime()
if (gap > 15000) then OFFLINE
```

This means:

- If the ESP32 stops sending data, the dashboard correctly shows "offline" after
  15 seconds
- If the backend is running but ESP32 is disconnected, stale data is detected
- When fresh data arrives, the system automatically recovers
- Slow requests from a superseded poll are dropped by a request-id guard (not
  aborted), so a slow or failed network still advances the failure counter — the
  status can never freeze at "online" during an outage

### Change-only (delta) sensor logging

The `sensors` table stores all parameters in a single row per reading. To keep
the database small, `POST /sensor` only inserts a new row when at least one
parameter differs from the last stored reading beyond its per-sensor tolerance.

```env
DELTA_LOGGING_ENABLED=true            # default on; set "false" to disable
TEMP_DELTA_TOLERANCE=0.1              # °C
WATER_LEVEL_DELTA_TOLERANCE=1.0       # %
AMMONIA_DELTA_TOLERANCE=0.05          # ppm
```

**Flow inside `POST /sensor`:**

1. Device secret check + schema validation
2. Ammonia spike guard (rejects jumps > 20 ppm from the last stored value)
3. `devices.last_seen` always updated (heartbeat) — **never** skipped
4. Delta check vs. `lastSensorReading[device_id]`, an in-memory baseline seeded
   from PostgreSQL at boot (`SELECT DISTINCT ON (device_id) ... ORDER BY
   device_id, timestamp DESC`):
   - a parameter is invalid when `temperature <= 0` or `water_level < 0` or
     `ammonia < 0` (ESP32 failure sentinel = −1)
   - "changed" = validity flipped **or** `|new - last| > tolerance`
5. All unchanged → respond `200 { skipped: true }`, no row written; any changed →
   `INSERT` new row + refresh the in-memory baseline
6. The background alert engine runs on **every** accepted POST (skipped or not),
   so critical-threshold re-alerts after SMS cooldown behave exactly as before

**Downstream notes**

- `GET /sensor/latest` returns `recv_at = devices.last_seen` alongside the row
- `/analytics/overview` and `/analytics/insights` derive `device_offline` from
  `devices.last_seen` (heartbeat), and `gap_events` now counts logged
  "Device Disconnect" episodes instead of inter-sensor-row gaps
- History, weekly/range reports, and daily averages aggregate whatever rows exist
  — with delta logging the "readings" counts reflect value changes

### When ESP32 disconnects

1. Sensor data in database becomes stale (older than 15 seconds)
2. Pages show last known readings with yellow "ESP32 is offline" banner
3. Cards show last cached values with reduced opacity
4. `FloatingAlert`: "ESP32 device disconnected — no data received" (red popup,
   top-right)
5. Sound: critical alert sound (double beep) plays
6. Activity log: `device_disconnect` event recorded
7. SMS: sent to all active recipients (unless muted)

### When ESP32 reconnects

1. Fresh data arrives with current timestamp
2. `connectionStatus = "online"`, pages automatically re-render with live readings
3. `FloatingAlert`: "ESP32 device reconnected — data restored" (amber popup)
4. Activity log: `device_connect` event recorded

### Offline threshold configuration

```js
POLL_INTERVAL = 1000             // Poll every 1 second (matches ESP32 send rate)
OFFLINE_THRESHOLD = 15000        // 15 seconds before offline
MAX_CONSECUTIVE_FAILURES = 5     // API failures before offline
```

### Historical data while offline

Historical data is served from the PostgreSQL database, not from the device, so it
remains available when the ESP32 is offline:

- The Historical Data page fetches its own history directly from `GET /sensor` on
  every range change — it does not depend on the live polling connection state
- While offline, an amber banner shows "Device offline — showing recorded data up
  to {last recorded time}"
- Range buttons that would contain no readings during a long outage (e.g.
  1h/6h/24h) are dimmed with an explanatory tooltip; 1 Week and All Time stay
  enabled
- A hard error is only shown if the server itself is unreachable (no DB access)

---

## Failure Handling & Resilience

The system is designed to survive component failures with automatic recovery so
that a single fault (hung firmware, dead SMS gateway, broken Wi-Fi) never leaves
the farm unmonitored or the device bricked. Three mechanisms cover three
different failure domains: firmware hang (hardware), network loss (device), and
SMS provider outage (backend/cloud).

### 1) Firmware watchdog + Safe Mode

*(`ESP32_main_code` / `NODE_main_code` sketches)*

**Watchdog arming**

- `setup()` calls `esp_task_wdt_init(30, true)` and `esp_task_wdt_add(NULL)`,
  which subscribes the Arduino main loop task to the task watchdog with a
  30-second timeout and panic-on-timeout. If `loop()` ever stalls (e.g. an
  accidental `while(1);`), the panic handler resets the chip after ~30 s instead
  of leaving the device hung forever.
- `loop()` feeds the watchdog on every tick with `esp_task_wdt_reset()` followed
  by a `vTaskDelay(1)`. Safe Mode's LED blink is `millis()`-based precisely so
  the watchdog is never starved by a blocking delay.
- **Exception:** the WiFi configuration portal intentionally blocks the loop task
  for up to 3 minutes (`setConfigPortalTimeout(180)`). Because that would trip
  the 30 s watchdog, `startWifiConfigPortal()` suspends this task's WDT
  subscription (`esp_task_wdt_delete`) around `wm.startConfigPortal()` and
  re-arms it (`esp_task_wdt_add`) when the portal returns.

**Safe Mode start (auto-detected on boot)**

- On startup, `esp_reset_reason()` is checked. `ESP_RST_TASK_WDT` /
  `ESP_RST_WDT` mean the previous run was killed by the watchdog, so the device
  boots into Safe Mode instead of pretending nothing happened.
- `enterSafeMode()` loads the last known-good sensor snapshot (temperature, water
  level, ammonia) that `readAllSensors()` persisted to NVS on every read cycle
  (`saveLastKnownValues`/`loadLastKnownValues`, Preferences namespace `"safe"`),
  draws a red SAFE MODE screen with those values, and blinks the onboard LED
  (GPIO2) at 500 ms.
- In Safe Mode the device keeps reading sensors (refreshing the NVS snapshot) and
  keeps trying to send, but skips the config portal on boot failure and skips
  normal page repaints so the SAFE MODE screen stays visible.

**Safe Mode exit (automatic recovery)**

- `sendSensorTask` keeps polling `SEND_INTERVAL`. The moment the first sensor
  POST succeeds (HTTP response ≥ 200), `safeModeActive` is cleared and the main
  loop is told to redraw the normal UI (`PAGE_OVERVIEW`). The device fully
  resumes normal operation with no human intervention.

**WiFi reconnection with exponential backoff**

- When `WiFi.status() != WL_CONNECTED`, `sendSensorData()` no longer silently
  returns: it issues `WiFi.reconnect()` at increasing intervals (1 s, 2 s, 4 s, …
  capped at 5 minutes) and prints `[WIFI] Reconnect attempt N (next backoff Xs)`.
- The first successful send resets the streak and backoff to 1 s. This bounds how
  hard the device pushes a dead/unreachable AP and is the same mechanism that lets
  Safe Mode wait out an outage.

**Observe during demo**

1. Brick `loop()` with a `while(1);` → ~30 s later the chip reboots; serial shows
   `[WDT] Boot after watchdog reset -> Safe Mode`; the screen shows SAFE MODE with
   the last known values and the LED blinks.
2. With Wi-Fi back on, the first POST succeeds →
   `[SAFE MODE] Recovery complete, back to normal operation` and the normal UI
   returns.

### 2) SMS circuit breaker

*(`services/smsService.cjs` + `server.cjs`)*

**Why**

If the HTTPSMS gateway (or the Android phone running it) becomes unreachable,
every alert SMS fails. Naively retrying forever hammers the provider, risks an API
ban, and drains the daily SMS cap with `failed` rows. The circuit breaker stops
the hammering after a threshold and resumes automatically after a cooldown.

**States**

| State | Behaviour |
|---|---|
| `CLOSED` | normal operation; sends go straight to `sendHttpsms()` |
| `OPEN` | every send throws immediately ("SMS circuit breaker OPEN") until the cooldown elapses |
| `HALF_OPEN` | after the cooldown, one probe send is allowed; success → `CLOSED`, failure → `OPEN` again with a fresh cooldown |

**Where it hooks in**

- `sendHttpsms()` (`server.cjs`) wraps its axios POST with
  `sendSmsWithBreaker(...)`. The breaker counts consecutive failures (threshold
  5) and exposes `snapshot()` for `/alert/sms-health`.
- The `HTTPSMS_API_KEY` / `HTTPSMS_FROM` config check runs **before** the breaker,
  so a misconfiguration is reported immediately and never travels the breaker.
- The delivery poller (`fetchHttpsmsMessages` / `pollUndeliveredSms`) is **not**
  wrapped: reconciliation needs the `GET /v1/messages` read path to keep working
  during an outage so queued SMS still settle after recovery.

**Observable output**

- Server log on every transition:

  ```text
  SMS circuit breaker OPEN after 5 consecutive failures (cooldown 60000ms)
  SMS circuit breaker HALF_OPEN - single probe send allowed
  SMS circuit breaker HALF_OPEN -> CLOSED after successful send
  ```

- `GET /alert/sms-health` adds:

  ```js
  circuitBreaker: { state, consecutiveFailures, failureThreshold,
                    cooldownMs, cooldownUntil, lastError }
  ```

- The dashboard Settings page SMS panel shows a red banner while the circuit is
  `OPEN` or `HALF_OPEN`.

---

## Alert System

### How alerts work

1. Backend compares sensor values against configured thresholds
2. Frontend performs additional client-side threshold checking
3. Status is classified as GOOD, WARNING, or CRITICAL
4. Alerts are triggered only on status transitions
5. Cooldown prevents repeated alerts for same condition

### Threshold configuration

Users can configure thresholds in Settings:

| Parameter | Default Min | Default Max | Unit |
|---|---|---|---|
| Temperature | 20 | 31 | °C |
| Water Level | 10 | 100 | % |
| Ammonia | 0 | 25 | ppm |

### Alert severity

| Severity | Condition | Color | Behavior |
|---|---|---|---|
| Critical | Value 15%+ outside range | Red | Immediate alert, repeated sound |
| Warning | Value outside range but < 15% | Orange | Alert on status change |
| Info | System changes, settings | Blue | Informational |
| Good | Value within safe range | Green | No alert |

---

## SMS Alert System

### SkySMS integration

The system integrates with SkySMS API to send SMS notifications for:

- Critical threshold breaches
- ESP32 device disconnect events

Configuration (`.env`):

```env
SKYSMS_API_KEY=your_skysms_api_key_here
SKYSMS_API_URL=https://skysms.skyio.site/api/v1
SMS_COOLDOWN_MS=120000
```

### SMS alert flow

1. Threshold breach or device disconnect detected
2. **Recipient lookup:** queries `authorized_recipients` for active recipients
3. **Mute check:** if SMS is muted, skip sending (but still log)
4. **Cooldown check:** prevents SMS spam
5. **SMS sent:** individual messages to each recipient
6. **Logging:** all SMS attempts logged to `sms_logs` table

### SMS mute / sleep

SMS alerts can be temporarily paused (admin role required — the `/alert/mute`
endpoint is admin-only):

**From the floating alert popup:**

- Click the bell icon on a disconnect alert
- Choose duration: 1h, 2h, 4h, 6h, 8h, 12h, or 24h
- Popup dismisses, alerts muted until expiration

**From the Settings page:**

- "SMS Alert Sleep / Mute" section
- Duration buttons: 1h, 2h, 4h, 6h, 8h, 12h, 24h
- Shows current mute expiration if active
- "Unmute Alerts" button when muted

**While muted:**

- Floating popups still appear
- Activity logs still recorded
- SMS messages are **not** sent
- Mute state is persisted in the database and survives server restarts

### Device disconnect SMS message

```text
CRAYVINGS DEVICE ALERT
ESP32 device disconnected
ESP32 device disconnected -- no data for 15+ seconds
Failed polls: 5
Time: 05/04 10:30 AM
```

### Recipient management

Manage SMS recipients through the Settings page:

| Action | Endpoint | Description |
|---|---|---|
| List | `GET /settings/recipients` | Get all recipients |
| Add | `POST /settings/recipients` | Add new phone number |
| Update | `PUT /settings/recipients/:id` | Toggle active status, edit name |
| Delete | `DELETE /settings/recipients/:id` | Remove recipient |
| Test | `POST /settings/recipients/test/:id` | Send test SMS |

---

## API Endpoints

### Complete API reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Server info |
| `/health` | GET | Health check |
| `/auth/login` | POST | Log in (rate-limited: 10 attempts / 10 min / IP) |
| `/auth/logout` | POST | Log out (revokes session token) |
| `/auth/users` | GET | List users (admin) |
| `/auth/users` | POST | Create user (admin) |
| `/auth/users/:id` | DELETE | Delete user (admin) |
| `/auth/users/:id/password` | PUT | Reset user password (admin) |
| `/sensor` | POST | Submit sensor data (requires `X-Device-Secret` when `DEVICE_SECRET` is set) |
| `/sensor` | GET | Get history (limit: 1-1000) with optional `device_id` filter (per-tank) |
| `/sensor/latest` | GET | Get latest reading (incl. `recv_at` heartbeat) with optional `device_id` filter (per-tank) |
| `/devices` | GET | Fleet registry + online flags (`device_id`, `name`, `tank_name`, `tank_location`, `ip_address`, `last_health_seen`, `is_active`, `registered_via`, `ip_source`, `archived_at`). `?include_hidden=1` adds hidden devices, `?include_archived=1` adds archived ones |
| `/devices` | POST | **Register a device (admin)** — `{ device_id, device_name, ip_address? }`; `409` if the ID is taken, case-insensitively, even when archived |
| `/devices/:deviceId` | PUT | Update device (admin) — rename / set IP / show / hide |
| `/devices/:deviceId/archive` | POST | **Archive a device (admin)** — soft-delete; retires the ID permanently, keeps all history |
| `/devices/:deviceId/restore` | POST | **Restore an archived device (admin)** — clears `archived_at`/`archived_by`, sets `is_active = true` |
| `/devices/:deviceId/status` | GET | Live poll of one ESP32's `GET /status` (3 s timeout; 502/504) |
| `/report/weekly` | GET | Weekly report (summary, daily breakdown, alert counts) |
| `/settings` | GET | Get thresholds |
| `/settings` | POST | Update thresholds |
| `/settings/recipients` | GET | Get all recipients |
| `/settings/recipients` | POST | Add new recipient |
| `/settings/recipients/:id` | PUT | Update recipient |
| `/settings/recipients/:id` | DELETE | Delete recipient |
| `/settings/recipients/test/:id` | POST | Send test SMS |
| `/alert/device-disconnect` | POST | Send disconnect SMS alert (authenticated) |
| `/alert/mute` | POST | Mute SMS (`{ hours: number }`) — admin only |
| `/alert/mute-status` | GET | Check mute status |
| `/system-logs` | GET | Get system logs (`page`, `limit`, `action`, `parameter`) |
| `/logs` | POST | Create log entry |
| `/activity-logs` | GET | Get activity logs (`page`, `limit`, `search`, `sortBy`, `actionType`) |
| `/activity-logs` | POST | Create activity log |

---

## Backend Functionality

### Data validation & sanitization

The backend uses Zod for schema validation:

```ts
const sensorSchema = z.object({
  device_id: z.string().min(1).max(50),
  temperature: z.coerce.number().min(-10).max(50),
  water_level: z.coerce.number().min(0).max(100),
  ammonia: z.coerce.number().min(-1).max(500).optional(),
  timestamp: z.string().datetime().optional(),
});
```

### Smart save logic (change detection)

Prevents unnecessary database writes:

```js
function normalizeComparableValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (isNumericLike(value)) return Number(value);
  if (typeof value === "string") return value.trim();
  if (isPlainObject(value) || Array.isArray(value))
    return stableStringify(value);
  return value;
}
```

Used for:

- Settings updates (only changed fields)
- Sensor data (skips duplicates)
- Recipients (only updates changed fields)
- Password reset (checks if new equals current)

---

## Frontend Architecture

### Component hierarchy

```text
App
+-- SensorProvider
|   +-- useSensorDataPolling (1s latest for selected tank,
|   |                         30s history, 5s fleet poll)
|   +-- useSettingsManager
|   +-- useLogsManager (5s interval)
|   +-- useActivityLogsManager
+-- FloatingAlertProvider
+-- DeviceConnectionMonitor    <-- Monitors ESP32 connect/disconnect
+-- FloatingAlertContainer     <-- Displays popup alerts
+-- Header
+-- Sidebar
+-- Pages
    +-- HomePage
    +-- DashboardPage        <-- TankSelector + FleetGrid
    +-- SensorsPage
    +-- AlertsPage
    +-- HistoricalDataPage   <-- TankSelector
    +-- SettingsPage
    +-- LogsPage
    +-- ActivityLogsPage
+-- Components
    +-- TankSelector         Tank chips w/ online dots (all pages)
    +-- FleetGrid            2-3 col fleet cards + per-device
                            on-demand "Live check" (Dashboard only)
```

### State management

React Context with custom hooks:

1. **SensorDataContext:** real-time sensor data, history, connection status,
   fleet registry (devices + online flags), and `selectedDeviceId` / setter. The
   selected tank is lifted to the provider so it persists across pages.
2. **SensorSettingsContext:** threshold configuration
3. **LogsContext:** system logs with pagination
4. **ActivityLogsContext:** user activity tracking
5. **FloatingAlertContext:** toast notifications

### Connection detection mechanism

```js
const sensorTime = new Date(latest.timestamp);  // Actual sensor send time
const gap = Date.now() - sensorTime.getTime();
const isStale = gap > OFFLINE_THRESHOLD;        // 15 seconds

setState({
  error: isStale ? "ESP32 device is offline..." : null,
  connectionStatus: isStale ? "offline" : "online",
  lastUpdate: sensorTime,
});
```

### Alert cooldown logic

```js
const ALERT_COOLDOWN_MS = 10000; // 10 seconds
```

- Only alerts on status transitions
- Resets alert flag when value returns to good range
- Cooldown prevents alert spam

---

## IoT / Hardware Integration

### ESP32 communication protocol

| | |
|---|---|
| **Protocol** | HTTP/1.1 |
| **Method** | POST |
| **Content-Type** | `application/json` |
| **Device auth** | `X-Device-Secret` header (when a device secret is configured) |
| **URL** | `http://192.168.4.10:3000/sensor` (default `SERVER_IP_DEFAULT`) |
| **Send interval** | 1000 ms (same as sensor read interval) |
| **Send location** | background FreeRTOS task (never blocks the touch/UI loop) |
| **Serial monitor** | 115200 baud (diagnostics only) |
| **WiFi** | WiFiManager captive portal (auto-opens when the saved network fails) |

The firmware posts `device_id`, `temperature`, `water_level`, and `ammonia` in
the JSON body. It also sends the `X-Device-Secret` header (configured in the WiFi
config portal as `device_secret`) whenever one is set, so `DEVICE_SECRET` can be
enabled on the server. If the server enforces a secret and the device has none
configured, the POST is rejected with 401.

### Network requirements

- LAN subnet `192.168.4.0/24` (the ESP32 SoftAP default range); the access
  point/router acts as gateway `192.168.4.1`
- Central server at `192.168.4.10` (static IP); all ESP32s at `192.168.4.100-105`
- WiFi network (2.4 GHz recommended for ESP32)
- WiFiManager captive portal for easy credential configuration
- Port 3000 accessible (`POST /sensor`); port 80 on each ESP32 for the server's
  `GET /status` health poll
- Devices use NVS-configured static IPs by default (WiFi config portal fields
  `static_ip` / `static_gateway` / `static_subnet`); DHCP address reservations are
  an alternative so long as the subnet stays `192.168.4.0/24`
- The HTTP POST runs on a background FreeRTOS task (`sendSensorTask` in the ESP32
  sketches) with a 1-second connect timeout and 1-second response timeout. The
  main loop only sets a `sendPending`/`sendBusy` flag every `SEND_INTERVAL`
  (1000 ms), so even when the backend IP is wrong/unreachable the POST stalls the
  background task only — the screen and touch keep running at full
  responsiveness. Keep `SERVER_IP_DEFAULT` (or the portal's `server_ip`) pointed
  at the real backend machine (default: `192.168.4.10`).

**ESP32 libraries required in Arduino IDE:**

- ESPAsyncWebServer (serves `GET /status` on port 80)
- AsyncTCP (its underlying TCP library)

### Sensor types & measurement ranges

| Sensor | Type | Range | Accuracy | Pin |
|---|---|---|---|---|
| DS18B20 | Digital | 0 °C to 50 °C | ±0.5 °C | GPIO13 |
| HC-SR04 | Ultrasonic | 0 – 100 % | ±3 mm | GPIO26 (TRIG), GPIO27 (ECHO) |
| Ammonia | MQ-137 (NH3) | 0 – 500 ppm | 0.1 ppm | GPIO34 |
| XPT2046 | Touch | 480 × 320 | — | HSPI: CLK32, CS33, MOSI22, MISO19 |

### Touchscreen interface (display & touch)

The device runs its own on-screen dashboard on a 480×320 TFT via TFT_eSPI, with a
XPT2046 resistive touch panel on the HSPI bus:

- **Boot screens:** "WiFi Setup / Connecting to saved network..." while
  connecting, then "WiFi Connected! IP:..." on success
- **Page navigation:** on-screen left/right arrow buttons at the bottom (tap the
  screen, release, then the region is matched); page cooldown
  `PAGE_CHANGE_COOLDOWN` (500 ms) prevents accidental double-taps
- **Triple-tap top-left corner:** opens the WiFi configuration portal
  (Aquaculture-Setup AP, <http://192.168.4.1>)
- **Triple-tap top-right corner:** re-runs the MQ-137 clean-air R0 calibration
- **Touch mapping:** raw XPT2046 coordinates are scaled to screen pixels with
  hardcoded map constants (`RAW_X_MIN/MAX`, `RAW_Y_MIN/MAX` in the sketches)
- **Press detection:** pressure threshold `MIN_PRESSURE` (default 40) with a
  Z1/Z2 validity range guard (readings outside ~0-4000 are ignored)

### ESP32 sensor validation

- **Temperature:** valid range 0–50 °C, error detection (−127 °C = sensor error);
  failed readings sent as −1
- **Water Level:** valid range 0–100 %, ultrasonic echo validation, 5-sample
  averaging; failed readings sent as −1
- **Ammonia:** valid range 0–500 ppm (NH3 gas), MQ-137 chemiresistor with
  clean-air R0 calibration (persisted in NVS); failed readings sent as −1
- The backend skips these sentinel values during threshold evaluation so a failed
  sensor never triggers a false alert, and the dashboard excludes them from
  historical charts/stats

---

## Project Structure

```text
src/
+-- api/
|   +-- client.ts                 Axios API client with all functions
+-- assets/
|   +-- crayvings.png
+-- components/
|   +-- Header.tsx
|   +-- Sidebar.tsx
|   +-- StatCard.tsx
|   +-- TrendCard.tsx
|   +-- FloatingAlert.tsx         Popup alerts with mute options
|   +-- DeviceConnectionMonitor.tsx  ESP32 connect/disconnect monitoring
+-- contexts/
|   +-- SensorContext.tsx          Context interfaces
|   +-- SensorProvider.tsx         Data polling + stale detection
+-- hooks/
|   +-- useSensors.ts             Consolidated data access
|   +-- useThresholdAlert.ts      Alert threshold monitoring
|   +-- useFloatingAlerts.ts      Alert context
+-- pages/
|   +-- HomePage.tsx              Shows last data when ESP32 offline
|   +-- DashboardPage.tsx
|   +-- SensorsPage.tsx
|   +-- AlertsPage.tsx
|   +-- HistoricalDataPage.tsx
|   +-- SettingsPage.tsx          Thresholds + recipients + SMS mute + users
|   +-- LogsPage.tsx
|   +-- ActivityLogsPage.tsx
+-- types/
|   +-- index.ts
+-- utils/
|   +-- playAlertSound.ts
+-- App.tsx
+-- main.tsx
+-- index.css
server.cjs                         Express backend
water_monitoring_system/
+-- ESP32_main_code/ESP32_main_code.ino   ESP32 tank-1 firmware (WiFiManager), device ID ESP32_01
+-- NODE_main_code/NODE_main_code.ino     NodeMCU spare firmware (WiFiManager), device ID ESP32_02
```

---

## Running the Application

### 1. Backend

```bash
node server.cjs
```

### 2. Frontend

```bash
npm run dev
```

Dashboard available at <http://localhost:5173>

### 3. ESP32

Flash each device with its matching sketch: `ESP32_main_code.ino` (default device
ID `ESP32_01`) for the main tank, or `NODE_main_code.ino` (default device ID
`ESP32_02`) for the spare / NodeMCU board. On boot it first tries the saved
network; if that fails it automatically opens the "Aquaculture-Setup" WiFi access
point so you can configure your network (and backend server IP, port, device ID,
device secret, tank height, and static IP) via the captive portal at
<http://192.168.4.1>. The firmware default backend address is
`192.168.4.10:3000` (`SERVER_IP_DEFAULT` in the sketches); set it to your backend
machine's LAN IP if it differs. Each sketch ships its own `device_id` default, so
re-flashing or a wiped NVS still reports the right tank; keep the portal's
`device_id` field distinct per board otherwise. Requires the ESPAsyncWebServer +
AsyncTCP libraries installed in Arduino IDE.

---

## Environment Variables

### Backend (`.env`)

```env
PORT=3000
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=crayvings_monitoring_system_db
PG_USER=postgres
PG_PASSWORD=your_password
ALLOWED_ORIGINS=http://localhost:5173
SKYSMS_API_KEY=your_skysms_api_key_here
SKYSMS_API_URL=https://skysms.skyio.site/api/v1
SMS_COOLDOWN_MS=120000
WARNING_SMS_COOLDOWN_MS=120000
HOURLY_SMS_ENABLED=true
HOURLY_SMS_INTERVAL_MS=3600000

# Security
ADMIN_INITIAL_PASSWORD=change_me_strong_password   # REQUIRED on first-time setup (no default credential)
DEVICE_SECRET=your_shared_secret                    # ESP32 must send this in the X-Device-Secret header
```

### Frontend

```env
VITE_API_BASE=http://localhost:3000
```

---

## Database Schema (SQL)

### Sensors table

```sql
CREATE TABLE sensors (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(50) NOT NULL,
  temperature DECIMAL(5,2) DEFAULT 0,
  water_level DECIMAL(5,2) DEFAULT 0,
  ammonia DECIMAL(5,3) DEFAULT 0,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sensors_timestamp ON sensors(timestamp DESC);
CREATE INDEX idx_sensors_device_id ON sensors(device_id);
```

### System logs table

```sql
CREATE TABLE system_logs (
  id SERIAL PRIMARY KEY,
  action VARCHAR(100) NOT NULL,
  parameter VARCHAR(100) NOT NULL,
  old_value VARCHAR(50),
  new_value VARCHAR(50),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_system_logs_timestamp ON system_logs(timestamp DESC);
```

### Sensor settings table

```sql
CREATE TABLE sensor_settings (
  id SERIAL PRIMARY KEY,
  temp_min DECIMAL(5,2) DEFAULT 20.0,
  temp_max DECIMAL(5,2) DEFAULT 31.0,
  water_level_min DECIMAL(5,2) DEFAULT 10.0,
  water_level_max DECIMAL(5,2) DEFAULT 100.0,
  ammonia_min DECIMAL(5,2) DEFAULT 0.25,
  ammonia_max DECIMAL(5,2) DEFAULT 1.00,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Activity logs table

```sql
CREATE TABLE activity_logs (
  id SERIAL PRIMARY KEY,
  user_name VARCHAR(100) DEFAULT 'Admin',
  action_type VARCHAR(50) NOT NULL,
  description TEXT,
  module VARCHAR(100),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_activity_logs_timestamp ON activity_logs(timestamp DESC);
CREATE INDEX idx_activity_logs_action_type ON activity_logs(action_type);
```

### Authorized recipients table

```sql
CREATE TABLE authorized_recipients (
  id SERIAL PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### SMS logs table

```sql
CREATE TABLE sms_logs (
  id SERIAL PRIMARY KEY,
  recipient_phone VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL,
  error_message TEXT,
  sms_id VARCHAR(100),
  sent_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

---

## Debugging Guide

### Quick status check (PowerShell)

```powershell
Get-NetTCPConnection -LocalPort 3000    # Backend
Get-NetTCPConnection -LocalPort 5432    # PostgreSQL
Get-NetTCPConnection -LocalPort 5173    # Frontend
```

### Testing the backend API

```bash
curl http://localhost:3000/health
curl http://localhost:3000/sensor/latest
curl -X POST http://localhost:3000/sensor \
  -H "Content-Type: application/json" \
  -H "X-Device-Secret: your_shared_secret" \
  -d '{"device_id":"TEST","temperature":25.0,"water_level":75.0,"ammonia":0.12}'

# Test mute (admin token required; the /alert/mute endpoint is admin-only)
curl -X POST http://localhost:3000/alert/mute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-token>" \
  -d '{"hours": 4}'

# Check mute status
curl http://localhost:3000/alert/mute-status
```

### Common issues & solutions

| Issue | Cause | Solution |
|---|---|---|
| "Connection refused" | Server not running | Start `node server.cjs` |
| "Invalid URL" | Empty API URL | Set `VITE_API_BASE` |
| CORS error | Wrong port | Add port to `ALLOWED_ORIGINS` |
| Data not showing | Wrong IP | Check server config in frontend |
| "Device offline" | ESP32 not connected | Check WiFi, restart ESP32 (use WiFiManager portal) |
| Alert spam | Frequent threshold breaches | Adjust threshold settings |
| AudioContext warning | Browser security | Click anywhere on page to unlock audio |
| SMS not sending | Missing API key | Set `SKYSMS_API_KEY` in `.env` |

---

## Performance Metrics

| Metric | Value |
|---|---|
| Polling interval (selected tank) | 1 second |
| Fleet poll interval | 5 seconds |
| Device poller interval | 5 seconds (`GET /status` health checks) |
| Device poller concurrency | Up to 10 devices at once (2 s request timeout); scales down for smaller fleets |
| Device offline threshold | 3 consecutive failures / ~15 s |
| Logs polling interval | 5 seconds |
| History polling interval | 30 seconds |
| Request timeout | 10 seconds |
| Connection pool | 20 max connections |
| Page size | 20 items default |
| Alert cooldown | 10 seconds |
| SMS cooldown (critical) | 2 minutes |
| SMS cooldown (warning) | 2 minutes |
| Offline threshold | 15 seconds |
| Rate limit (global) | 300 req/min/IP (device `/sensor` POST exempt) |
| Rate limit (login) | 10 attempts / 10 min / IP |
| JSON body limit | 10 KB |
| Mute durations | 1, 2, 4, 6, 8, 12, 24 hours |

---

## Security Considerations

### Current implementation

- CORS origin validation (enforced allowlist via `ALLOWED_ORIGINS`)
- Input validation with Zod (settings and sensor data)
- SQL parameterized queries (`pg`)
- Auth tokens with 24-hour expiration and server-side logout (token revoked)
- Timing-safe password comparison (PBKDF2-SHA512, 600,000 iterations; legacy
  `salt:hash` hashes are transparently re-hashed on the next successful login)
- No known default credential — first-time setup requires
  `ADMIN_INITIAL_PASSWORD`; the plaintext password is never logged or shown in
  the UI
- Device authentication: `POST /sensor` requires an `X-Device-Secret` header
  matching `DEVICE_SECRET` (when set); `POST /alert/device-disconnect` requires a
  valid login
- Rate limiting: global per-IP limiter (300 req/min, `/sensor` POST exempt) and a
  login limiter (10 attempts / 10 min / IP)
- JSON body-size limit: `express.json({ limit: "10kb" })`
- Admin-only actions: muting SMS alerts requires the admin role
- SMS cooldown and mute state persisted in the database
- Old sensor readings pruned after 30 days

### Production recommendations

1. Use HTTPS behind a reverse proxy
2. Enable database encryption
3. **Still open (audit, deferred):** public read-only GET endpoints are not yet
   authenticated (token still held in localStorage) — scheduled as a separate
   refactor

---

## Future Enhancement Possibilities

1. **Mobile App** — native iOS/Android apps
2. **Push Notifications** — Firebase or similar
3. **Per-Tank Fleet Optimizations** — the six-tank star topology is in place; next
   steps could include per-tank alert thresholds, tank grouping, and fleet-wide
   color-coded farm maps
4. **Data Analysis** — ML-based predictions
5. **WebSocket** — real-time updates instead of polling
6. **Multi-user** — role-based access
7. **Export API** — public API for integrations
8. **Email Alerts** — SMTP-based notifications
9. **Dashboard Widgets** — customizable home page

---

*End of how it works.*
