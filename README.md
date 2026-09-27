<img width="2048" height="2048" alt="CRAYvings" src="https://github.com/user-attachments/assets/57608e73-686f-4dfb-9b6a-3ceba1092add" />

# CRAYvings Monitoring System

An IoT-based smart monitoring system designed for aquaculture, specifically for **crayfish/crab pond or tank monitoring**. This project helps monitor important water conditions in real time using sensors connected to an **ESP32**, with data sent to a **web-based dashboard** for viewing and tracking.

---

## Project Overview

The **CRAYvings Monitoring System** is built to help monitor the water environment of aquaculture tanks or ponds. Since aquatic animals are highly sensitive to changes in water quality, this system provides a more efficient way to check conditions without relying only on manual observation.

The system uses sensors connected to an **ESP32 microcontroller** to collect environmental data. The readings are then sent through Wi-Fi to a backend/database and displayed on a monitoring dashboard.

This can help reduce risks caused by poor water conditions and improve overall monitoring efficiency.

---

## Objectives

- Monitor water-related parameters in real time
- Provide a centralized dashboard for viewing sensor data
- Help improve water quality management in aquaculture
- Reduce manual checking and improve consistency
- Support better decision-making for tank or pond maintenance
- Provide instant alerts (floating popups, sound, and SMS) when parameters go out of safe range
- Notify users immediately when the ESP32 device disconnects

---

## Features

### Core Features
- **Authentication & roles** - Login-based access control (owner/admin/user) with session tokens and 24-hour expiry; login is rate-limited (5 attempts / 15 min / IP)
- **Multi-tank star topology** - One ESP32 per tank (up to 6) pushing to a central server; the server health-polls each device's `GET /status`, and the dashboard scopes live/history/analytics to a selected tank with a tank-selector chip bar and farm overview grid
- **Real-time sensor monitoring** - Temperature, water level, and ammonia (3 parameters via ESP32)
- **Server-Sent Events (SSE) push** - Live readings stream to every open dashboard over `GET /sensor/stream` (no 1s polling); history refreshes every 30s and the fleet registry every 5s, both with exponential backoff on failure
- **ESP32-based data collection** - Wireless sensor data transmission with WiFiManager captive portal
- **Web dashboard** - Responsive React UI with icon-based navigation
- **Database storage** - PostgreSQL for historical data
- **Smart connection detection** - Connection status based on actual sensor data timestamp, not API poll time
- **Offline data display** - When ESP32 disconnects, pages show last known readings with yellow offline banner; historical data remains viewable from the database
- **Smart alerts** - Floating popup notifications with threshold-based alerts and cooldown
- **Alert acknowledgment** - Confirm or Allow each alert, tracked per alert row
- **SMS notifications** - Critical threshold alerts, hourly status updates, and device disconnect alerts via HTTPSMS (Android gateway)
- **SMS delivery tracking** - Per-message status (queued/delivered/failed), delivery poller, daily send cap, and SMS logs
- **SMS mute/sleep** - Pause SMS alerts for 1, 2, 4, 6, 8, 12, or 24 hours
- **Disconnect/reconnect alerts** - Floating popup, sound, and activity log when ESP32 goes offline or comes back online
- **Recipient management** - Manage SMS alert recipients with archive/restore/purge
- **User management** - Create users, reset passwords, and soft-delete/restore accounts; deletion is verified via email OTP
- **Custom alert sounds** - Audio alerts via Web Audio API
- **PDF export** - Export system logs to PDF (LogsPage) and weekly reports to PDF (Historical Data)
- **Analytics** - Period overviews, trends, daily breakdowns, and rule-based insights
- **Activity logging** - Track user interactions including device connect/disconnect events
- **Hardened ingestion** - Sensor-failure sentinels (temp -1/0, water/ammonia -1) are stored as NULL, per-device secrets are supported alongside the shared `DEVICE_SECRET`, ingestion is rate-limited (12/sec/device, burst headroom for the offline-buffer flush), and DB CHECK constraints keep bad rows out
- **Security headers** - `helmet` CSP and standard hardening headers on all API responses; `ALLOWED_ORIGINS` is required in production
- **WiFiManager** - ESP32 firmware uses captive portal for WiFi config (no hardcoded credentials)
- **Touchscreen UI** - 480x320 TFT with XPT2046 resistive touch (HSPI); on-screen left/right page arrows and triple-tap gestures
- **Non-blocking data send** - HTTP POST runs on a background FreeRTOS task, so a slow/unreachable backend never freezes the UI or touch input

### Monitoring Parameters
| Parameter | Sensor | Safe Range (default thresholds) |
|-----------|--------|------------|
| Temperature | DS18B20 | 20 - 31°C |
| Water Level | Ultrasonic HC-SR04 | 10 - 100% |
| Ammonia | MQ-137 (NH3 gas) | 0.25 - 1.0 ppm |

### Dashboard Pages
- **Dashboard** - Tank selector, fleet grid (per-device "Live check"), overview, quick stats, connection status, system alerts
- **Analytics** - Period overview, trends, daily breakdowns, and insights (farm-wide or selected tank)
- **Sensors** - Individual sensor details with threshold info and connection status
- **Alerts** - Alert history with filtering (Alert/Change) and acknowledgment
- **Historical Data** - Selected-tank trend charts with time filtering (1h, 6h, 24h, 1 week, all time) and weekly report PDF export
- **Activity Logs** - User activity tracking including device connect/disconnect events
- **Sensor Logs** - System event logs with parameter filtering and PDF export
- **Settings** - Thresholds, SMS recipients and mute/sleep, SMS logs, user management (owner/admin)

Admins see all pages; regular users are restricted to the monitoring pages (Dashboard, Analytics, Sensors, Alerts, Historical Data, Sensor Logs).

---

## Technologies Used

### Hardware
- **ESP32 DevKit V1** with WiFiManager support
- **480x320 TFT + XPT2046 resistive touch** - on-device dashboard UI (touch on HSPI: CLK32, CS33, MOSI22, MISO19)
- **DS18B20** - Temperature sensor (GPIO13, OneWire)
- **HC-SR04** - Ultrasonic distance sensor (GPIO26 TRIG, GPIO27 ECHO)
- **MQ-137** - Ammonia sensor (GPIO34, analog; R0 calibrated in clean air on first boot, persisted to NVS)

### Software
| Component | Technology | Version |
|-----------|------------|---------|
| Frontend | React + TypeScript | React 19, TS 5.9 |
| Build Tool | Vite | 8.0 |
| Styling | Tailwind CSS | 4.2 |
| Charts | Recharts | 3.8 |
| Icons | lucide-react | 1.8 |
| PDF Export | jsPDF + autoTable | 4.2 + 5.0 |
| HTTP Client | Axios | 1.15 |
| Backend | Express.js | 5.2 |
| Security headers | helmet | 8.0 |
| Database | PostgreSQL | 15+ |
| Connection Pool | pg | 8.20 |
| Validation | Zod | 4.3 |
| SMS Service | HTTPSMS (Android gateway) | - |

---

## System Architecture

```
Tanks (ESP32 x6) ──POST /sensor (1s)──► Express API ──► PostgreSQL
        │                                   │        │
        └──GET /status ◄─ device poller (5s)│        └── SSE push ──► React Dashboard
                                              │                        (fleet + selected tank)
                                         SMS via HTTPSMS ←──── Alert System
```

One ESP32 per tank at `192.168.4.100-105`, central server at `192.168.4.10`
(LAN `192.168.4.0/24`). The poller only reads diagnostics — sensor rows come
exclusively from the device push. Every accepted reading is broadcast to all
connected dashboards over SSE, so the UI updates instantly without polling.

### Data Flow
1. **Sensors** read environmental data
2. **ESP32** collects and sends data via HTTP POST (rate-limited to 3/sec/device; failed-sensor sentinels stored as NULL)
3. **Express API** validates, stores in PostgreSQL, and pushes the reading to all SSE clients
4. **React Dashboard** receives live readings over SSE; chart history refreshes every 30s and the fleet registry every 5s (both back off exponentially on failure)
5. **Connection check** compares sensor data timestamp against current time
6. **Alerts** triggered when values exceed thresholds or ESP32 disconnects
7. **SMS** sent to active recipients through the HTTPSMS Android gateway (unless muted)

---

## Prerequisites

### Hardware
- ESP32 DevKit V1
- DS18B20 temperature sensor
- HC-SR04 water level sensor
- MQ-137 ammonia sensor
- (Optional) Android phone running the HttpSms app, as the SMS gateway

### Software
- Node.js 18+
- PostgreSQL 15+
- Arduino IDE (for ESP32)

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
PORT=3000
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=crayvings_monitoring_system_db
PG_USER=postgres
PG_PASSWORD=your_password
ALLOWED_ORIGINS=http://localhost:5173

# SMS via HTTPSMS (optional Android gateway; see docs/HTTPSMS_SETUP.md)
HTTPSMS_API_KEY=your_httpsms_api_key
HTTPSMS_FROM=+639XXXXXXXXXX

# First-time admin (see step 3)
ADMIN_INITIAL_PASSWORD=your_strong_password
```

The server auto-applies additive schema columns and indexes on startup. Structural migrations live in `db/migrations/` (run them with `node db/migrations/xxx.cjs` when upgrading).

### 3. Create Initial Admin

The owner/admin account is bootstrapped from `.env` (never hardcoded). On a fresh database:

```bash
npm run seed:admin
```

This creates the owner account using `ADMIN_USERNAME`/`ADMIN_EMAIL`/`ADMIN_INITIAL_PASSWORD`. Existing admin passwords are never overwritten.

### 4. Start Backend

```bash
npm run server
```

### 5. Start Frontend

```bash
npm run dev
```

Dashboard opens at http://localhost:5173

### 6. Connect ESP32

Flash each device with its matching sketch: `water_monitoring_system/ESP32_main_code/ESP32_main_code.ino` (tank 1, defaults to device ID `ESP32_01`) or `water_monitoring_system/NODE_main_code/NODE_main_code.ino` (spare / NodeMCU, defaults to device ID `ESP32_02`). On boot it first tries the saved network; if that fails it automatically opens the "Aquaculture-Setup" WiFi access point so you can configure credentials, backend server IP/port/device ID, device secret, tank height, and the device's static IP via the captive portal at http://192.168.4.1 (or serial command `W`, or triple-tap the top-left corner). The firmware's default backend address is `192.168.4.10:3000` (`SERVER_IP_DEFAULT` in the sketches) — set it to your backend machine's LAN IP if it differs. If you set `DEVICE_SECRET` in `.env`, enter the same value on the device so the backend accepts its readings. The firmware now requires the **ESPAsyncWebServer** and **AsyncTCP** libraries (it serves read-only `GET /status` on port 80 for fleet health checks). Apply the multi-tank DB migration once (`node db/migrations/007_multi_device.cjs`). Each sketch ships its own device ID default so the server always knows which tank is which — the ID shown in the config portal is what gets persisted to NVS and reported to the backend.

---

## Configuration

### Setting Thresholds
Navigate to **Settings** to configure minimum/maximum values for temperature, water level, and ammonia. Threshold changes are logged to activity logs.

### SMS Mute / Sleep
Two ways to pause SMS alerts:
1. **Floating alert popup** — Click the bell icon on disconnect alerts (1h/2h/4h/6h/8h/12h/24h)
2. **Settings page** — "SMS Alert Sleep / Mute" section with all durations and unmute button

While muted, disconnect alerts still show as popups and are logged, but SMS is not sent.

### SMS Notifications
- HTTPSMS integration (httpsms.com) using an Android phone as the SMS gateway
- Automated sends for critical threshold alerts, an hourly status update, and device-disconnect warnings
- Recipient management with archive/restore and a test-SMS feature in Settings
- Delivery tracking (queued/delivered/failed) with SMS logs and a daily send cap

### User Management
- Owner/admin accounts with full access; regular users see monitoring pages only
- Create accounts, reset passwords, and revoke access
- Account deletion requires a 6-digit OTP via email (emailed with SMTP, or printed to the console in dev)

---

## API Endpoints

### Auth & Users (admin-gated unless noted)
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/login` | POST | Log in, returns user + session token |
| `/auth/logout` | POST | Log out and invalidate token |
| `/auth/users` | GET | List active users |
| `/auth/users` | POST | Create a user |
| `/auth/users/archived` | GET | List soft-deleted users |
| `/auth/users/:id/deletion-request` | POST | Start deletion; emails OTP |
| `/auth/users/:id/deletion-verify` | POST | Verify OTP and soft-delete |
| `/auth/users/deletion-requests` | GET | List pending deletion requests |
| `/auth/users/:id/restore` | POST | Restore a soft-deleted user |
| `/auth/users/archived/:id` | DELETE | Permanently purge archived user |
| `/auth/users/:id/password` | PUT | Reset a user's password |

### Sensors & Reports
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sensor` | POST | Submit sensor data (shared `DEVICE_SECRET` or per-device `devices.device_secret`; 3/sec/device rate limit; failure sentinels stored as NULL) |
| `/sensor/latest` | GET | Latest reading as `{ data, deviceExists }` — HTTP 200 even when no readings exist yet; `recv_at` = live device heartbeat; optional `device_id` filter |
| `/sensor` | GET | Get history (`limit`: 1-1000; optional `device_id` filter, per-tank; `?before=<ISO timestamp>` keyset cursor for paging older data) |
| `/sensor/stream` | GET | **SSE** live-reading stream (auth via `?token=` because EventSource cannot send headers; keep-alive pings every 25s) |
| `/devices` | GET | Fleet registry + online flags (name, tank_name, tank_location, ip_address, last_health_seen) |
| `/devices/latest` | GET | Freshest in-memory reading per active tank in one call (drives the Live Tank Bar; no DB hit) |
| `/devices/:deviceId/status` | GET | Live on-demand poll of one ESP32's `GET /status` (3s timeout) |
| `/report/weekly` | GET | Weekly report (summary, daily breakdown, alert counts) |
| `/report/range` | GET | Aggregated report for `?hours=N` (hourly buckets when ≤24h, daily otherwise; admin) |

### Settings & Recipients
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/settings` | GET/POST | Get/update thresholds |
| `/settings/reset` | POST | Reset thresholds to defaults |
| `/settings/recipients` | GET/POST | List/add SMS recipients |
| `/settings/recipients/:id` | PUT/DELETE | Update/delete recipient |
| `/settings/recipients/archived` | GET | List archived recipients |
| `/settings/recipients/:id/archive` | POST | Soft-delete recipient |
| `/settings/recipients/:id/restore` | POST | Restore archived recipient |
| `/settings/recipients/archived/:id` | DELETE | Permanently purge archived recipient |
| `/settings/recipients/test/:id` | POST | Send test SMS |

### Alerts & SMS
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/alert/status` | POST | Send current status SMS to all recipients |
| `/alert/mute` | POST | Mute SMS alerts (`{ hours }`) |
| `/alert/mute-status` | GET | Check mute status |
| `/alert/sms-health` | GET | SMS health (configured, today's count, cap) |
| `/sms-logs` | GET | SMS delivery logs (`page`, `pageSize`, `status` filters) |

### Logs
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/logs` | POST | Create system log entry |
| `/logs/:id/ack` | POST | Acknowledge an alert (`confirmed`/`allowed`) |
| `/system-logs` | GET | Get system logs (`page`, `limit`, `action`, `parameter` filters) |
| `/activity-logs` | GET/POST | Get/create activity logs |

### Analytics
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/analytics/overview` | GET | Period stats, trends, alerts, uptime |
| `/analytics/daily` | GET | Daily averages per day |
| `/analytics/insights` | GET | Rule-based insights for the period |

---

## Project Structure

```
src/
├── api/client.ts              # API client functions
├── components/
│   ├── AnalyticsSection.tsx   # Analytics summary cards + insights
│   ├── TankSelector.tsx       # Tank chip bar (online dots, X/Y online)
│   ├── FarmOverview.tsx       # Dashboard fleet grid + on-demand "Live check"
│   ├── deviceActions.tsx      # Per-tank rename / hide / live-check controls
│   ├── DeviceConnectionMonitor.tsx  # ESP32 connect/disconnect monitoring
│   ├── FixLegend.tsx          # Alert guidance legend
│   ├── FloatingAlert.tsx      # Popup alerts with mute options
│   ├── Header.tsx             # Top bar with user info + logout
│   ├── Loading.tsx            # Loading/error cards
│   ├── StatCard.tsx           # Shared KPI stat card (single implementation)
│   └── TrendCard.tsx          # Mini trend chart card
├── config/
│   ├── routes.ts              # Centralized route/menu definitions (role-aware)
│   └── sensorDisplay.ts       # Centralized sensor display config (icon/color/status classes)
├── contexts/
│   ├── AuthContext.tsx        # Auth provider + session state
│   ├── SensorContext.tsx
│   ├── SensorProvider.tsx     # SSE live data + history/devices polling with backoff
│   └── useAuth.ts             # useAuth hook
├── hooks/
│   ├── useDevicesLatest.ts    # Shared 5s poll of /devices/latest + thresholds
│   ├── useSSE.ts              # Reusable SSE connection hook (token auth, reconnect)
│   ├── useFloatingAlerts.ts
│   ├── useSensors.ts
│   └── useThresholdAlert.ts
├── pages/
│   ├── ActivityLogsPage.tsx
│   ├── AlertsPage.tsx
│   ├── AnalyticsPage.tsx
│   ├── AuthPage.tsx           # Login
│   ├── DashboardPage.tsx
│   ├── HistoricalDataPage.tsx
│   ├── LogsPage.tsx           # Sensor/system logs
│   ├── SensorsPage.tsx
│   └── SettingsPage.tsx       # Thresholds + recipients + SMS mute + users
├── types/index.ts
├── utils/alertGuidance.ts
├── utils/playAlertSound.ts
├── utils/time.ts
├── App.tsx                    # Routing, sidebar, role-based menus
├── main.tsx
└── index.css                  # Tailwind v4 @theme design tokens (brand colors, elevation)
server.cjs                     # Express backend (auth, sensors, SSE, logs, SMS, analytics)
services/                      # smsService.cjs (circuit breaker), devicePoller.cjs (health checks)
seed-admin.cjs                 # Bootstrap the initial owner/admin account
water_monitoring_system/ESP32_main_code/ESP32_main_code.ino  # ESP32 tank-1 firmware (WiFiManager), device ID ESP32_01
water_monitoring_system/NODE_main_code/NODE_main_code.ino    # NodeMCU spare firmware (WiFiManager), device ID ESP32_02
db/migrations/                 # Structural SQL migrations (run manually, tracked in schema_migrations)
```

Migrations of note: `007_multi_device.cjs` (star topology), `008_device_secrets.cjs`
(opt-in per-device secrets), `009_sensor_constraints.cjs` (NULLs stored
sentinels, adds CHECK constraints + a partial index), and
`010_schema_migrations.cjs` (version-tracking table seeded with 001-010).

---

## Connection & Offline Handling

### How Connection Status Works
- Live readings for the selected tank arrive over **SSE** (`GET /sensor/stream`); the client reconnects automatically with exponential backoff (up to 10 attempts) and falls back to a REST `GET /sensor/latest` fetch on mount
- `lastUpdate` uses the `recv_at` **heartbeat** (device receive time, refreshed even when delta logging skips a row)
- If no heartbeat is received within 30 seconds → status = **offline** (a health check also runs every 10s)
- A separate poll every 5 seconds refreshes the fleet registry (`GET /devices`) and the per-tank live values (`GET /devices/latest`); chart history refreshes every 30 seconds. Both polls back off exponentially on repeated failures and pause while the tab is hidden
- Device readings are per-tank; selecting a different tank re-scopes latest/history/analytics, while the farm grid shows every device's online state

### Change-Only (Delta) Logging
- `POST /sensor` writes a new row only when a parameter differs from the last stored reading beyond its per-sensor tolerance (defaults: temp ±0.1°C, water level ±1.0%, ammonia ±0.05 ppm)
- **Sensor-failure sentinels are stored as NULL**: both firmwares convert the DS18B20's -127 disconnect code to -1 before sending, so the wire sentinels are temperature -1/0, water level -1 (HC-SR04 failure), and ammonia -1 (MQ-137 failure). The server converts all of them to NULL before the row is written, so failed sensors never pollute charts, analytics, or alerts. Older sentinel rows were migrated to NULL by `db/migrations/009_sensor_constraints.cjs`, and CHECK constraints now keep them out
- Unchanged readings refresh `devices.last_seen` as a heartbeat and respond `200 { skipped: true }` with no new row
- Keeps the `sensors` table small; alerts, SMS, and online/offline detection (frontend + analytics) stay accurate via the heartbeat
- Tune with `DELTA_LOGGING_ENABLED`, `TEMP_DELTA_TOLERANCE`, `WATER_LEVEL_DELTA_TOLERANCE`, `AMMONIA_DELTA_TOLERANCE` in `.env`
- On restart the last stored reading per device is re-seeded from PostgreSQL (NULLs preserved), so unchanged POSTs after boot are still skipped

### When ESP32 Disconnects
1. Sensor data becomes stale (older than 15s)
2. Pages show last known readings with yellow offline banner and "ESP32 is offline" message
3. Floating popup: "ESP32 device disconnected — no data received"
4. Critical alert sound plays
5. Activity log: `device_disconnect`
6. SMS sent to active recipients (unless muted, and subject to a rearm grace period to prevent flapping)

### When ESP32 Reconnects
1. Fresh data arrives → status = **online**, pages show live readings
2. Floating popup: "ESP32 device reconnected — data restored"
3. Activity log: `device_connect`

---

## Failure Handling & Resilience

The system deliberately handles failures at every layer instead of crashing, so
a capstone demo can fail a component and show automatic recovery.

### 1. Firmware Watchdog + Safe Mode (ESP32)
- A 30-second **task watchdog** (`esp_task_wdt`) is armed in `setup()`; if the main
  loop ever stalls (e.g. a fatal `while(1);`) the chip resets itself.
- On a watchdog reset the boot detects it via `esp_reset_reason()` and enters
  **Safe Mode**: the display shows `SAFE MODE` with the **last known-good sensor
  values** (persisted to NVS by `saveLastKnownValues()`), and the onboard LED
  blinks on a `millis()` cadence (never a blocking delay, so the watchdog stays fed).
- While in Safe Mode the device keeps reading sensors and retrying the uplink
  with WiFi **exponential backoff** (1s → 2s → 4s → … capped at 5 min). The first
  successful sensor POST clears Safe Mode automatically and restores the normal UI.
- Why: a hung sensor loop must not mean a bricked device at the farm.

### 2. SMS Circuit Breaker (backend)
- Every HTTPSMS send is routed through a **circuit breaker** (`services/smsService.cjs`)
  with states **CLOSED → OPEN → HALF_OPEN**:
  - CLOSED: sends normally; after **5 consecutive failures** the circuit trips OPEN.
  - OPEN: sends fail fast (`SMS circuit breaker OPEN` in the logs) — no more
    hammering a dead gateway or risking provider/API bans.
  - HALF_OPEN: after a **60s cooldown** a single probe is allowed; success returns
    to CLOSED, failure re-opens it with a fresh cooldown.
- Only the send (POST) path is guarded; delivery reconciliation (GET poller) runs
  outside the breaker so queued SMS still settle after recovery.
- Live state is exposed in `GET /alert/sms-health` (`circuitBreaker` field) and
  shown in the Settings page SMS panel.
- Why: gateway/API outages are the norm in SMS integrations; hammering makes them
  worse and burns daily-text caps.

### 3. Backend Resilience (server.cjs)
- **DB retry with backoff**: at startup the server waits for PostgreSQL with
  exponential backoff (5 attempts, 2s → 4s → 8s → …) so a slow-starting database
  no longer kills the boot sequence. Idle-client pool errors are logged, not fatal.
- **Connection pool sizing**: `max: 20` clients, 30s idle timeout, 5s acquire
  timeout — sized for concurrent dashboards plus ingestion bursts.
- **Graceful shutdown**: `SIGINT`/`SIGTERM`/`SIGUSR2` (Ctrl+C, containers/PM2,
  nodemon) close SSE clients, drain HTTP connections, and end the pool before
  exiting, with a 10s force-exit safety net.
- **Centralized error handling**: unknown paths return JSON 404s; a final
  error middleware logs every unhandled failure and never leaks internal error
  messages to production clients.
- **Security hardening**: `helmet` CSP/security headers; CORS allowlist required
  in production (`ALLOWED_ORIGINS`); login limited to 5 attempts/15 min/IP;
  sensor ingestion limited to 3/sec/device with per-device or shared secrets.
- Why: a farm dashboard must survive DB restarts and deploys without losing
  readings, and must not expose internals when things do go wrong.

### How to observe handling during a demo
- **Watchdog**: brick `loop()` with `while(1);` → serial prints `[WDT] Task watchdog
  armed`, chip reboots ~30s later → `[WDT] Boot after watchdog reset → Safe Mode`,
  screen shows SAFE MODE + last values, LED blinks → first POST resumes normal UI.
- **WiFi backoff**: disconnect the router → serial shows `Reconnect attempt 1 (next
  backoff 1s)`, `attempt 2 (2s)`, `attempt 4s...` → reconnect clears the streak.
- **Circuit breaker**: block `api.httpsms.com` (hosts file) → trigger ≥3 alerts →
  server logs `SMS circuit breaker OPEN after 5 consecutive failures` →
  `GET /alert/sms-health` returns `"circuitBreaker":"OPEN"` → unblock → cooldown →
  HALF_OPEN probe succeeds → back to CLOSED.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Backend won't start | Check PostgreSQL connection (server retries 5x with backoff, then exits with the error) |
| No data showing | Verify ESP32 is connected to same WiFi network |
| CORS error | Add frontend port to ALLOWED_ORIGINS (required in production) |
| "Device offline" | Check ESP32 WiFi connection (use WiFiManager portal) |
| Live values stop updating | SSE connection dropped — the client auto-reconnects with backoff; check the server is reachable and the session token is still valid |
| "Too many login attempts" | Login rate limit (5/15 min/IP) — wait or restart the server in dev |
| Sensor POST returns 401 | `DEVICE_SECRET` mismatch — send it in the `X-Device-Secret` header, or set `devices.device_secret` for the device |
| Sensor POST returns 400 | Reading rejected by validation (bad range or ammonia spike guard) — sentinels are fine, out-of-bounds values are not |
| SMS not sending | Verify HTTPSMS_API_KEY / HTTPSMS_FROM in .env; see docs/HTTPSMS_SETUP.md |
| Can't log in | First-time setup requires `npm run seed:admin` (ADMIN_INITIAL_PASSWORD) |
| AudioContext warning | Click anywhere on the page to unlock audio |

### Debug Commands
```bash
curl http://localhost:3000/health

# Authenticated endpoints need the session token from POST /auth/login:
TOKEN="paste-token-here"
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/sensor/latest
# → { "data": { ...readings... }, "deviceExists": true }   (200 even with no data yet)

# Ingest a test reading (add -H "X-Device-Secret: $DEVICE_SECRET" when set):
curl -X POST http://localhost:3000/sensor -H "Content-Type: application/json" \
  -d '{"device_id":"TEST","temperature":25,"water_level":75,"ammonia":0.4}'

# Watch the live SSE stream:
curl -N "http://localhost:3000/sensor/stream?token=$TOKEN"

curl -X POST http://localhost:3000/alert/mute -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"hours": 4}'
```

---

## Building for Production

```bash
npm run build
```

Output in `dist/` folder.

---

## License

ISC

---

## Support

### Documentation (all in [docs/](docs/))

| Doc | What it covers |
|---|---|
| [HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) | Detailed documentation: architecture, data flow, alert/SMS logic, hardware integration, performance, security |
| [DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) | Every table, column, index, FK, plus a copy-paste DBML diagram for dbdiagram.io |
| [HTTPSMS_SETUP.md](docs/HTTPSMS_SETUP.md) | SMS configuration: gateway phone, `.env` keys, recipients, delivery tracking, troubleshooting |
| [MOCK_DEVICE.md](docs/MOCK_DEVICE.md) | Simulate an ESP32 with `npm run mock` — 8 scenario profiles, CLI options, recipes |
| [TESTING_MULTI_TANK.md](docs/TESTING_MULTI_TANK.md) | Step-by-step verification of the multi-tank star topology (phases A–F) |
| [LAST_NIGHT_SESSION.md](docs/LAST_NIGHT_SESSION.md) | Session log: what changed, what was verified, what is still deferred |
| [full-audit-27092026.md](docs/full-audit-27092026.md) | Full system audit — 4 critical, 9 moderate, 9 minor findings + suggested order of work |