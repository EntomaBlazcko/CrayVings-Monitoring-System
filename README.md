<img width="2048" height="2048" alt="CRAYVINGS" src="https://github.com/user-attachments/assets/57608e73-686f-4dfb-9b6a-3ceba1092add" />

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
- **Authentication & roles** - Login-based access control (owner/admin/user) with session tokens and 24-hour expiry
- **Multi-tank star topology** - One ESP32 per tank (up to 6) pushing to a central server; the server health-polls each device's `GET /status`, and the dashboard scopes live/history/analytics to a selected tank with a tank-selector chip bar and fleet grid
- **Real-time sensor monitoring** - Temperature, water level, and ammonia (3 parameters via ESP32)
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
| Database | PostgreSQL | 15+ |
| Connection Pool | pg | 8.20 |
| Validation | Zod | 4.3 |
| SMS Service | HTTPSMS (Android gateway) | - |

---

## System Architecture

```
Tanks (ESP32 x6) ──POST /sensor (1s)──► Express API ──► PostgreSQL
       │                                   │
       └──GET /status ◄─ device poller (5s)└── React Dashboard (fleet + selected tank)
                                             │
                                        SMS via HTTPSMS ←──── Alert System
```

One ESP32 per tank at `192.168.4.100-105`, central server at `192.168.4.10`
(LAN `192.168.4.0/24`). The poller only reads diagnostics — sensor rows come
exclusively from the device push.

### Data Flow
1. **Sensors** read environmental data
2. **ESP32** collects and sends data via HTTP POST
3. **Express API** validates and stores in PostgreSQL
4. **React Dashboard** polls for data every 1 second
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

# SMS via HTTPSMS (optional Android gateway; see docs/HTTPSMS_SETUP.txt)
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

Flash the ESP32 with `water_monitoring_system/water_monitoring_system.ino`. On boot it first tries the saved network; if that fails it automatically opens the "Aquaculture-Setup" WiFi access point so you can configure credentials, backend server IP/port/device ID, device secret, tank height, and the device's static IP via the captive portal at http://192.168.4.1 (or serial command `W`, or triple-tap the top-left corner). The firmware's default backend address is `192.168.4.10:3000` (`SERVER_IP_DEFAULT` in `water_monitoring_system.ino`) — set it to your backend machine's LAN IP if it differs. If you set `DEVICE_SECRET` in `.env`, enter the same value on the device so the backend accepts its readings. The firmware now requires the **ESPAsyncWebServer** and **AsyncTCP** libraries (it serves read-only `GET /status` on port 80 for fleet health checks). Apply the multi-tank DB migration once (`node db/migrations/007_multi_device.cjs`) and give each device its own `device_id` (e.g. `tank01`).

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
| `/sensor` | POST | Submit sensor data (device secret required when `DEVICE_SECRET` is set) |
| `/sensor/latest` | GET | Get latest reading (`recv_at` = live device heartbeat; optional `device_id` filter) |
| `/sensor` | GET | Get history (`limit`: 1-1000; optional `device_id` filter, per-tank) |
| `/devices` | GET | Fleet registry + online flags (name, tank_name, tank_location, ip_address, last_health_seen) |
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
- Components/
  │   ├── AnalyticsSection.tsx   # Analytics summary cards + insights
  │   ├── TankSelector.tsx       # Tank chip bar (online dots, X/Y online)
  │   ├── FleetGrid.tsx          # Fleet cards + on-demand "Live check"
  │   ├── DeviceConnectionMonitor.tsx  # ESP32 connect/disconnect monitoring
  │   ├── FixLegend.tsx          # Alert guidance legend
│   ├── FloatingAlert.tsx      # Popup alerts with mute options
│   ├── Header.tsx             # Top bar with user info + logout
│   ├── Loading.tsx            # Loading/error cards
│   ├── StatCard.tsx           # KPI stat card
│   └── TrendCard.tsx          # Mini trend chart card
├── contexts/
│   ├── AuthContext.tsx        # Auth provider + session state
│   ├── SensorContext.tsx
│   ├── SensorProvider.tsx     # Data polling + stale detection
│   └── useAuth.ts             # useAuth hook
├── hooks/
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
└── index.css
server.cjs                     # Express backend (auth, sensors, logs, SMS, analytics)
seed-admin.cjs                 # Bootstrap the initial owner/admin account
water_monitoring_system/water_monitoring_system.ino        # ESP32 firmware (WiFiManager)
db/migrations/                 # Structural SQL migrations (run manually)
```

---

## Connection & Offline Handling

### How Connection Status Works
- Frontend polls `GET /sensor/latest` every 1 second **for the selected tank**; a separate poll every 5 seconds refreshes the fleet registry (`GET /devices`), and the backend rides on it to mark each device online/offline
- `lastUpdate` uses the `recv_at` **heartbeat** (device receive time, refreshed even when delta logging skips a row)
- If no heartbeat is received within 15 seconds → status = **offline**
- After 5 consecutive failed API requests → status = **offline**
- Device readings are per-tank; selecting a different tank re-scopes latest/history/analytics, while the fleet grid shows every device's online state

### Change-Only (Delta) Logging
- `POST /sensor` writes a new row only when a parameter differs from the last stored reading beyond its per-sensor tolerance (defaults: temp ±0.1°C, water level ±1.0%, ammonia ±0.05 ppm)
- Unchanged readings refresh `devices.last_seen` as a heartbeat and respond `200 { skipped: true }` with no new row
- Keeps the `sensors` table small; alerts, SMS, and online/offline detection (frontend + analytics) stay accurate via the heartbeat
- Tune with `DELTA_LOGGING_ENABLED`, `TEMP_DELTA_TOLERANCE`, `WATER_LEVEL_DELTA_TOLERANCE`, `AMMONIA_DELTA_TOLERANCE` in `.env`
- On restart the last stored reading per device is re-seeded from PostgreSQL, so unchanged POSTs after boot are still skipped

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
| Backend won't start | Check PostgreSQL connection |
| No data showing | Verify ESP32 is connected to same WiFi network |
| CORS error | Add frontend port to ALLOWED_ORIGINS |
| "Device offline" | Check ESP32 WiFi connection (use WiFiManager portal) |
| SMS not sending | Verify HTTPSMS_API_KEY / HTTPSMS_FROM in .env; see docs/HTTPSMS_SETUP.txt |
| Can't log in | First-time setup requires `npm run seed:admin` (ADMIN_INITIAL_PASSWORD) |
| AudioContext warning | Click anywhere on the page to unlock audio |

### Debug Commands
```bash
curl http://localhost:3000/health
curl http://localhost:3000/sensor/latest
curl -X POST http://localhost:3000/sensor -H "Content-Type: application/json" -d '{"device_id":"TEST","temperature":25,"water_level":75,"ammonia":4.5}'
curl -X POST http://localhost:3000/alert/mute -H "Content-Type: application/json" -d '{"hours": 4}'
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

For detailed documentation see docs/HOW_IT_WORKS.txt. For the database schema see docs/DATABASE_SCHEMA.txt. For SMS configuration see docs/HTTPSMS_SETUP.txt. For the free/$0 production deployment guide see docs/DEPLOYMENT.txt.