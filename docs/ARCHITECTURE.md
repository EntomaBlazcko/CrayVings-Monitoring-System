# CRAYvings Aquaculture Monitoring System — Architecture

How the system is put together and why. This document merges the former
`HOW_IT_WORKS.md` and `BLOCK_DIAGRAM.md`; both were maintained separately and had
drifted apart on the same facts (poll intervals, rate limits, authentication).

The **diagram of record** is the editable draw.io source:
[`BLOCK_DIAGRAM.drawio`](BLOCK_DIAGRAM.drawio). The text diagram below is a
transcription of it so this document reads correctly on its own in a report or a
printed thesis.

| Document | Covers |
|---|---|
| **ARCHITECTURE.md** (this file) | Topology, stack, diagram, data flow, offline handling, resilience, alerting, SMS behaviour, API map, frontend architecture, hardware, running, env vars, debugging, performance, security |
| [DATABASE.md](DATABASE.md) | Every table, column, index, constraint, FK, the 001–016 migration table, and a DBML ERD |
| [DEVICES.md](DEVICES.md) | Registering, hiding, archiving and rotating the fleet; the design decisions behind it |
| [TESTING.md](TESTING.md) | Static checks, the mock simulator, and the 2-tank and 10-tank verification runbooks |
| [INTEGRATIONS.md](INTEGRATIONS.md) | SMS gateway setup and troubleshooting |
| [../README.md](../README.md) | Project overview, quick start, per-endpoint reference |

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
  for health/diagnostics only — it **never** writes `sensors` rows. On success it
  records `devices.last_health_seen`; after 3 consecutive failures it logs a
  warning (rate-limited by a backoff). It does **not** write an offline flag —
  offline state is derived from the heartbeat (see *Connection & Offline
  Handling*).
- **Tracks** the fleet registry (`device_id`, `ip_address`, `tank_name`,
  `tank_location`, `last_health_seen`) in the `devices` table (migration 007),
  with explicit Owner registration via `POST /devices` plus `registered_via` /
  `ip_source` provenance and `archived_at` soft-delete (migration 014).
- **Serves** the fleet to the frontend via `GET /devices` (with online flags) and
  `GET /devices/:id/status` (live on-demand query of one device).

The dashboard reads the fleet through a single global **"selected tank"**. The
1-second live poll and every history/analytics query are scoped to that tank via
the `device_id` query parameter; a 5-second fleet poll drives the tank selector
chips and the farm grid (with an on-demand "Live check" per device).

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
| Query layer | pg | 8.20 |
| Validation | Zod | 4.3 |
| HTTP Client | Axios | 1.15 |
| SMS Service | HTTPSMS API | — |

---

## Architecture Diagram

### How to open and edit the diagram

| Step | Action |
|---|---|
| 1 | Go to [app.diagrams.net](https://app.diagrams.net) (or the desktop draw.io app) |
| 2 | **File → Open From → Device**, then select `docs/BLOCK_DIAGRAM.drawio` |
| 3 | Edit shapes, labels and colours freely — the XML is regenerated on save |
| 4 | **File → Export as → PNG** (or PDF/SVG) for inclusion in the report |

The diagram is one page named `System Block Diagram`, sized 2600 × 1420 px.
Colour is applied per layer, so re-exporting at a different scale keeps the
grouping legible. If you need a version that fits a portrait page, use
**Format → Page Scale** rather than resizing the blocks.

### Diagram (text version)

```
  ┌──────────────────────────────────────────────┐
  │  WATER TANK  ×6   (tank01 … tank06)          │
  │  DS18B20 temp · HC-SR04 level · MQ-137 NH3   │
  └───────────────────────┬──────────────────────┘
                          │ sampled (FreeRTOS task)
  ┌───────────────────────▼──────────────────────┐
  │  ESP32 DevKit V1  ×6  (one per tank)         │
  │  · 600-entry drop-proof ring buffer          │
  │  · task watchdog + safe-mode boot            │
  │  · WiFiManager portal, TFT touch display     │
  │  · X-Device-Secret on every request          │
  └──┬───────────────────────────────────────▲───┘
     │ POST /sensor  1 Hz                  │ │
     │ (mock simulator also injects)       │ │ GET /status
     │                                    │ │ diagnostics
  ┌──▼─────────────────────────────────────┴───▼──────────────────────┐
  │  2. NETWORK — HTTP / JSON over LAN  192.168.4.0/24              │
  │     .1 router · .10 server · .100–.105 ESP32                     │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ 57 routes (56 REST + SSE)
  ┌───────────────────────────▼──────────────────────────────────────┐
  │  3. APPLICATION LAYER — Express 5 API (server.cjs)               │
  │                                                                  │
  │    [Ingestion & Validation] ─▶ [Device Authentication]           │
  │                │                        │                       │
  │                ▼                        ▼                       │
  │          [Persistence — Change-Only Delta Logging]               │
  │           │            │            │                           │
  │           ▼            ▼            ▼                           │
  │    [Alert Engine]  [SSE Fan-Out]  [Analytics & Reports]         │
  │           │                                                   │
  │           ▼                                                   │
  │    [Notification Dispatcher] ─▶ [smsService circuit breaker]    │
  │                                                                  │
  │    [Users, Roles & Access]        [Boot & State Recovery]       │
  │    [devicePoller health loop]     [Cross-cutting middleware]    │
  └──────┬─────────────────────────────────────┬─────────────────────┘
         │                                     │
         ▼                                     ▼
  ┌────────────────────────┐          ┌──────────────────────────┐
  │  4. DATA LAYER         │          │  5. PRESENTATION LAYER   │
  │     PostgreSQL 15      │          │     React 19 + TS + Vite │
  │                        │          │                          │
  │  Time-Series           │◀──reads─▶│  [AuthContext]          │
  │   sensors              │          │  [SensorProvider]        │
  │  Configuration         │          │    SSE + 5 s / 30 s poll │
  │   devices,             │          │  [10 Pages]              │
  │   sensor_settings,     │          │  [Recharts / jsPDF /     │
  │   device_threshold_    │          │   alert audio]           │
  │   overrides            │          │  [Static Asset Host]     │
  │  Identity & Audit      │          └──────────────────────────┘
  │   users, email_otps,   │
  │   user_deletion_reqs,  │          ┌──────────────────────────┐
  │   activity_logs        │          │  6. EXTERNAL SERVICES    │
  │  Alerting State        │          │                          │
  │   system_logs,         │          │  HTTPSMS Cloud API       │
  │   last_alerts          │◀────────▶│  Android SMS Gateway     │
  │  Messaging State       │          │  SMS Recipients          │
  │   authorized_recipients│          │  SMTP / Nodemailer       │
  │   sms_logs,            │          │  Administrator Inbox     │
  │   system_state         │          │  db/migrations (16)      │
  │  Schema Versioning     │          │  tests/ (6 suites)        │
  │   schema_migrations    │          └──────────────────────────┘
  │  Connection Mgmt       │
  │   pg.Pool (max 20)     │
  └────────────────────────┘
```

### Legend

| Colour / style | Meaning |
|---|---|
| Green | 1 · Sensor / field layer |
| Grey | 2 · Network layer |
| Blue | 3 · Application layer |
| Purple | 4 · Data layer |
| Orange | 5 · Presentation layer |
| Amber | 6 · External services |
| Dashed block border | Optional, test-only, or out-of-process component |
| Dashed edge | Control, management, or non-payload flow |

---

## Layer reference

### 1 · Sensor / Field layer

| Block | Detail |
|---|---|
| Water Tank ×6 | `tank01` … `tank06`, one ESP32 per tank |
| DS18B20 | Digital temperature, GPIO13, OneWire |
| HC-SR04 | Ultrasonic water level, GPIO26 TRIG / GPIO27 ECHO |
| MQ-137 | NH₃ gas / ammonia, GPIO34 analog, R0 calibrated in clean air on first boot |
| ESP32 DevKit V1 | `water_monitoring_system/ESP32_main_code/ESP32_main_code.ino` (tank 1) and `NODE_main_code/NODE_main_code.ino` (tank 2). Pushes every 1000 ms, 600-entry ring buffer flushed oldest-first, task watchdog + safe mode, WiFiManager portal, 480×320 TFT + XPT2046 touch |
| Mock ESP32 Simulator | `scripts/mock-device.js` — bench testing without hardware; dashed because it is not deployed |

### 2 · Network layer

Two flows run in opposite directions:

- **Upstream, push** — `POST /sensor` at 1 Hz per device, authenticated with the `X-Device-Secret` header, rate limited to 12 requests/second per device (burst headroom for the offline-buffer flush).
- **Downstream, poll** — `GET /status` on `ESPAsyncWebServer` port 80, returning `device_id`, `ip`, `uptime_ms`, `wifi_rssi`, `free_heap` and the current sensor values.

### 3 · Application layer (`server.cjs`)

| Block | Responsibility |
|---|---|
| Ingestion & Validation | Zod schema validation, sentinel→NULL conversion (temp −1/0, level −1, NH₃ −1), range check, ammonia-spike guard |
| Device Authentication | Shared `DEVICE_SECRET` fallback, per-device `device_secret`, plus `device_secret_prev` inside its rotation grace window; case-insensitive `device_id`; secrets never leave the database |
| Persistence — Delta Logging | Compares against the last stored reading per device. Changed → `INSERT`. Unchanged → updates `devices.last_seen` only and replies `{ skipped: true }`. Tolerances: temp ±0.1 °C, level ±1.0 %, NH₃ ±0.05 ppm |
| Threshold & Alert Engine | Global + per-tank overrides, severity classification (info / warning / critical), dedup via `last_alerts`, disconnect detection on a 30 s stale window (`DISCONNECT_STALE_MS`) with a rearm grace period (`DISCONNECT_REARM_MS`, 5 min) against flapping |
| Notification Dispatcher | Fan-out to active recipients, global and per-tank mute handling, daily cap and cooldown, per-message status in `sms_logs` |
| SSE Fan-Out | `GET /sensor/stream` broadcasts every accepted reading to all connected dashboards. Same-origin, so the stream authenticates with the session cookie like every other request; no token rides in a URL. 25 s keep-alive pings |
| Analytics & Reporting | SQL aggregation, weekly and arbitrary-range reports (hourly buckets ≤ 24 h, else daily), rule-based insight generation |
| Users, Roles & Access | PBKDF2-SHA512 at 600 000 iterations, 64-char session token stored as a SHA-256 hash with a 24 h expiry in an `HttpOnly` cookie, two roles (`admin`, `user`), OTP-verified archive / restore / purge |
| Boot & State Recovery | `startServer()` waits for the database with exponential backoff, bootstraps the owner account, then restores dedup state, mute state, ammonia baselines and in-memory latest readings |
| `devicePoller.cjs` | Health poll, max concurrency 10, 2 s timeout, updates `devices.last_health_seen` on success and warns after 3 consecutive failures; writes no sensor rows by design |
| `smsService.cjs` | Circuit breaker: CLOSED / OPEN / HALF_OPEN, 5 consecutive failures trip it, 60 s cooldown, then a single probe. The delivery-reconciliation poller runs outside the breaker |
| Cross-cutting middleware | helmet CSP, CORS allowlist, rate limiting (global 300 req/min/IP, login 5 **failed** attempts / 15 min, sensor ingest 12/s per device), Zod validation, JSON 404/error envelope |

### 4 · Data layer — PostgreSQL 15

16 tables (`sensor_calibration` arrived with 018;
`user_deletion_request_status_history` with 021). Accessed through a single
`pg.Pool` (max 20 connections, 30 s idle timeout, 5 s connect timeout). Grouped
by function:

| Group | Tables |
|---|---|
| Time-series | `sensors` — the hot table; NULL records a failed sensor; keyset pagination up to 1000 rows |
| Configuration & registry | `devices`, `sensor_settings`, `device_threshold_overrides`, `sensor_calibration` |
| Identity & audit | `users`, `email_otps`, `user_deletion_requests`, `user_deletion_request_status_history`, `activity_logs` |
| Alerting state | `system_logs`, `last_alerts` |
| Messaging state | `authorized_recipients`, `sms_logs`, `system_state` |
| Schema versioning | `schema_migrations` |

Full column-level detail is in [DATABASE.md](DATABASE.md).

### 5 · Presentation layer — React 19 + TypeScript (Vite)

| Block | Responsibility |
|---|---|
| `AuthContext` | Session state and role-aware menu. The credential is an `HttpOnly` cookie sent by the browser; nothing in `src/` reads or writes it. `localStorage` holds only the public profile under `crayvings_user` |
| `SensorProvider` | Owns the SSE subscription (exponential reconnect capped at 30 s, jittered) with exponential backoff, REST `/sensor/latest` fallback on mount, fleet registry and per-tank live values every 5 s, chart history every 30 s. Both polls back off on failure and pause while the tab is hidden |
| Pages | Auth (login), Dashboard, Sensors, Alerts, Analytics, Historical Data, Sensor Logs, Activity Logs, Devices, Settings (admin-only pages noted in the diagram) |
| Visualisation & export | Recharts, two-tier alerting (`useThresholdAlert` + `useFleetAlarms`), `CriticalAlarmBanner` / `FloatingAlert` overlays, alert audio, jsPDF + autoTable export |
| Static Asset Host | The Vite `dist/` build. In production `server.cjs` serves `dist/` itself and strips the `/api` prefix — see the deployment note below |

### 6 · External services

| Block | Detail |
|---|---|
| HTTPSMS Cloud API | `httpsms.com`. The send POST is breaker-guarded; the delivery-status GET is not, so queued messages still reconcile |
| Android SMS Gateway | A phone running the HttpSms app relays API requests onto the mobile network |
| SMS Recipients | Operators and farm staff, managed from Settings, stored in `authorized_recipients` |
| SMTP / Nodemailer | Account-deletion OTP codes only — not general alerting. Falls back to console output in development |
| Schema migrations | `db/migrations/` — 21 standalone scripts (001–021), run manually and tracked in `schema_migrations` |
| Test harness | `tests/` — 6 standalone suites, plus `tools/watch-connection.cjs` |

---

## Data flow summary

1. Each ESP32 samples its three sensors and `POST`s to `/sensor` once per second.
2. The server validates the payload, converts failure sentinels to `NULL`, and
   compares it against the last stored reading.
3. If the value changed, a row is inserted into `sensors`; otherwise only
   `devices.last_seen` is touched.
4. The accepted reading is broadcast to every connected dashboard over SSE.
5. The alert engine evaluates it against the effective thresholds, deduplicates,
   writes to `system_logs`, and — unless muted — dispatches an SMS.
6. Fleet health is tracked separately by polling each device's `GET /status`;
   no heartbeat inside the stale window marks the tank offline and fires a
   disconnect alert.
7. History and analytics are served from PostgreSQL on a 30 s cadence.

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

- **a) Subscription:** live readings arrive over SSE, with a REST
  `/sensor/latest` poll as the fallback path
- **b) Display:** shows real-time readings in cards and charts
- **c) Connection check:** uses the `recv_at` heartbeat to determine
  online/offline
- **d) Offline display:** shows last known readings with a banner when the ESP32
  is disconnected
- **e) Alerts:** warns users when parameters exceed thresholds
- **f) Disconnect alerts:** floating popup + sound + activity log when the ESP32
  is offline
- **g) SMS:** sends SMS for critical alerts and device disconnects (unless muted)
- **h) Audio:** plays alert sounds for threshold violations and disconnects

---

## Key architectural notes

These are also embedded on the diagram itself, so the two stay consistent.

- **Telemetry is push-only.** The server never writes a sensor row on a
  device's behalf, so a stale reading cannot masquerade as a health check. This
  is why the poller is drawn as a separate dashed path rather than folded into
  ingestion.
- **Deployment note.** In production `server.cjs` serves the committed `dist/`
  build itself and strips the `/api` prefix, so the dashboard and the API share
  one origin. That single origin is what makes the `SameSite=Lax` session cookie
  work; putting the API on a different host would break login with no obvious
  cause. In development Vite proxies `/api` to `localhost:3000` instead.
- **Base schema is not in version control.** Migrations `001`–`016` assume
  pre-existing tables and there is no automatic runner, so a fresh database
  cannot be built from this repository alone. `server.cjs` additionally applies
  its own additive columns and indexes at startup.
- **Not depicted, by design.** The system uses no MQTT broker, no WebSocket
  transport, no cloud service beyond HTTPSMS and SMTP, and no machine-learning
  model. Analytics are SQL aggregation plus rule-based insight generation.

---

## Feature list

### 1. Real-time water quality monitoring

The system continuously monitors water parameters collected by the ESP32:

| Parameter | Sensor | Range | Unit | Default Threshold |
|---|---|---|---|---|
| Temperature | DS18B20 | 0 to 50 | °C | 20 – 31 °C |
| Water Level | Ultrasonic HC-SR04 | 0 to 100 | % | 10 – 100 % |
| Ammonia | MQ-137 (NH3 gas) | 0 to 500 | ppm | 0.25 – 1.00 ppm |

Features:

- Continuous data collection from ESP32 every 1000 ms
- Sensor validation before sending data (invalid readings sent as −1)
- Real-time display updates every 1 second
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

### 3. Device connection monitoring

The system actively monitors ESP32 connectivity:

- **Stale data detection:** connection status uses the receive-time heartbeat,
  not API response time
- **30-second offline threshold:** if no heartbeat for 30 s
  (`HEARTBEAT_STALE_MS`), the device is marked offline
- **Last known data display:** when disconnected, pages show cached readings with
  an offline banner
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

- HTTPSMS API integration for sending SMS notifications
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

## Connection & Offline Handling

### How connection status works

The dashboard derives connection status from the `recv_at` heartbeat — the
receive time of the latest POST, always newer than the data's stored timestamp.
With change-only (delta) logging enabled, unchanged readings are skipped so the
data timestamp would otherwise go stale — `recv_at` is bumped on every single
POST.

```js
lastUpdate = new Date(latest.recv_at || latest.timestamp)
gap = Date.now() - lastUpdate.getTime()
if (gap > HEARTBEAT_STALE_MS) then OFFLINE   // 30 s
```

This means:

- If the ESP32 stops sending data, the dashboard correctly shows "offline" after
  30 seconds
- If the backend is running but the ESP32 is disconnected, stale data is detected
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
  `devices.last_seen` (heartbeat), and `gap_events` counts logged
  "Device Disconnect" episodes instead of inter-sensor-row gaps
- History, weekly/range reports, and daily averages aggregate whatever rows exist
  — with delta logging the "readings" counts reflect value changes

### When ESP32 disconnects

1. No heartbeat in the database for 30 seconds
2. Pages show last known readings with an "ESP32 is offline" banner
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
// client-side, src/contexts/SensorProvider.tsx
HEARTBEAT_STALE_MS = 30000            // 30 s without a heartbeat -> offline

// server-side, GET /devices derives its `online` flag from the same rule:
DISCONNECT_STALE_MS = 30000           // 30 s, env-tunable, also drives SMS

// server-side SMS disconnect detection:
DISCONNECT_REARM_MS = 300000          // 5 min steady-online before a new alert

// health poller, services/devicePoller.cjs
FAILURE_THRESHOLD = 3                 // consecutive failures before it warns
MAX_CONCURRENCY = 10                  // devices polled in parallel per batch
```

### Historical data while offline

Historical data is served from the PostgreSQL database, not from the device, so it
remains available when the ESP32 is offline:

- The Historical Data page fetches its own history directly from `GET /sensor` on
  every range change — it does not depend on the live connection state
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
the farm unmonitored or the device bricked. Two mechanisms cover two different
failure domains: firmware hang (hardware) and SMS provider outage
(backend/cloud).

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
| Ammonia | 0.25 | 1.00 | ppm |

### Alert severity

| Severity | Condition | Color | Behavior |
|---|---|---|---|
| Critical | Value 15%+ outside range | Red | Immediate alert, repeated sound |
| Warning | Value outside range but < 15% | Orange | Alert on status change |
| Info | System changes, settings | Blue | Informational |
| Good | Value within safe range | Green | No alert |

---

## SMS Alert System

> Setup and troubleshooting live in [INTEGRATIONS.md](INTEGRATIONS.md). This
> section covers runtime *behaviour*.

### HTTPSMS integration

The system integrates with the HTTPSMS API to send SMS notifications for:

- Critical threshold breaches
- ESP32 device disconnect events

Configuration (`.env` — see [INTEGRATIONS.md](INTEGRATIONS.md) for the full
walkthrough):

```env
HTTPSMS_API_KEY=your_httpsms_api_key
HTTPSMS_FROM=+63XXXXXXXXXX
SMS_COOLDOWN_MS=300000
```

The API base URL is not an environment variable: it is fixed in
`server.cjs` (`https://api.httpsms.com/v1/messages/send`, plus
`.../messages` for delivery polling).

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
ESP32 device disconnected -- no data for 30+ seconds
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
| Archive | `POST /settings/recipients/:id/archive` | Retire a number, keep its history |
| Restore | `POST /settings/recipients/:id/restore` | Bring an archived number back |
| List archived | `GET /settings/recipients/archived` | Archived numbers |
| Delete archived | `DELETE /settings/recipients/archived/:id` | Purge an archived number |
| Test | `POST /settings/recipients/test/:id` | Send test SMS |

---

## API Map

`server.cjs` defines **57 route handlers**: 56 JSON REST endpoints plus the SSE
stream at `GET /sensor/stream`. The full per-endpoint reference — parameters,
response shapes, status codes — is the
[README](../README.md#api-endpoints). What follows is the map by domain, which is
what the architecture actually cares about.

### Health & server info

| Endpoint | Method | Notes |
|---|---|---|
| `/` | GET | Server info |
| `/health` | GET | Health check |
| `/sensor/stream` | GET | SSE live readings (cookie auth, same-origin) |

### Authentication & users

| Endpoint | Method | Notes |
|---|---|---|
| `/auth/login` | POST | Sets the `crayvings_session` cookie; rate-limited on failures |
| `/auth/logout` | POST | Revokes the session |
| `/auth/me/password` | PUT | Self-service change; requires the current password |
| `/auth/users` | GET | List users (admin) |
| `/auth/users` | POST | Create user (admin) |
| `/auth/users/:id` | DELETE | Delete user (admin) |
| `/auth/users/:id/password` | PUT | Admin reset; `currentPassword` required when self-targeting |
| `/auth/users/archived` | GET | Archived users (admin) |
| `/auth/users/archived/:id` | DELETE | Purge an archived user (admin) |
| `/auth/users/:id/deletion-request` | POST | Request self-deletion (OTP) |
| `/auth/users/:id/deletion-verify` | POST | Confirm with the OTP |
| `/auth/users/:id/restore` | POST | Cancel a pending deletion (admin) |
| `/auth/users/deletion-requests` | GET | Pending deletion requests (admin) |

### Sensor data

| Endpoint | Method | Notes |
|---|---|---|
| `/sensor` | POST | Ingest; `X-Device-Secret` when `DEVICE_SECRET` is set |
| `/sensor` | GET | History, `limit` 1-1000, optional `device_id` |
| `/sensor/latest` | GET | Latest reading incl. the `recv_at` heartbeat |

### Devices

| Endpoint | Method | Notes |
|---|---|---|
| `/devices` | GET | Registry + online flags; `?include_hidden=1`, `?include_archived=1` |
| `/devices` | POST | Register a device (admin); `409` if the ID is taken — case-insensitively, even when archived |
| `/devices/latest` | GET | Latest reading for every device |
| `/devices/:deviceId` | PUT | Rename / set IP / show / hide (admin) |
| `/devices/:deviceId/archive` | POST | Retire the device (admin); ID is never reusable |
| `/devices/:deviceId/restore` | POST | Restore an archived device (admin) |
| `/devices/:deviceId/status` | GET | Live on-demand poll of one board's `GET /status` |
| `/devices/:deviceId/rotate-secret` | POST | Rotate the per-device secret (admin), with a grace window |

### Settings & thresholds

| Endpoint | Method | Notes |
|---|---|---|
| `/settings` | GET | Global thresholds |
| `/settings` | POST | Update global thresholds |
| `/settings/effective` | GET | Effective thresholds for a tank (global + per-device override) |
| `/settings/device/:deviceId` | GET | Per-device threshold override |
| `/settings/device/:deviceId` | PUT | Set per-device threshold override |
| `/settings/device/:deviceId` | DELETE | Clear per-device threshold override |
| `/settings/reset` | POST | Restore default thresholds |

### SMS & recipients

| Endpoint | Method | Notes |
|---|---|---|
| `/settings/recipients` | GET / POST | List / add |
| `/settings/recipients/:id` | PUT / DELETE | Update / delete |
| `/settings/recipients/:id/archive` | POST | Archive a number |
| `/settings/recipients/:id/restore` | POST | Restore an archived number |
| `/settings/recipients/archived` | GET | Archived numbers |
| `/settings/recipients/archived/:id` | DELETE | Purge an archived number |
| `/settings/recipients/test/:id` | POST | Send a test SMS |
| `/sms-logs` | GET | Delivery history |
| `/alert/device-disconnect` | POST | Send a disconnect SMS (authenticated) |
| `/alert/mute` | POST | Mute SMS — admin only |
| `/alert/mute-status` | GET | Current mute state |
| `/alert/status` | POST | Send an hourly status SMS to recipients — admin only |
| `/alert/sms-health` | GET | Circuit-breaker snapshot |

### Analytics & reports

| Endpoint | Method | Notes |
|---|---|---|
| `/analytics/overview` | GET | Per-tank summary |
| `/analytics/daily` | GET | Daily aggregation |
| `/analytics/insights` | GET | Rule-based insights |
| `/report/weekly` | GET | Weekly report |
| `/report/range` | GET | Arbitrary-range report |

### Logs

| Endpoint | Method | Notes |
|---|---|---|
| `/system-logs` | GET | Paginated, filterable |
| `/logs` | POST | Create a log entry |
| `/logs/:id/ack` | POST | Acknowledge a log |
| `/activity-logs` | GET | Paginated, searchable |
| `/activity-logs` | POST | Create an activity log |

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
|   +-- useSensorDataPolling (live SSE + 1s latest for selected tank,
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
    +-- AuthPage               Login
    +-- DashboardPage        <-- TankSelector + FarmOverview
    +-- SensorsPage
    +-- AlertsPage
    +-- AnalyticsPage
    +-- HistoricalDataPage   <-- TankSelector
    +-- LogsPage
    +-- ActivityLogsPage
    +-- DevicesPage
    +-- SettingsPage
+-- Components
    +-- TankSelector         Tank chips w/ online dots (all pages)
    +-- FarmOverview         2-3 col fleet cards + per-device
                             on-demand "Live check" (Dashboard only)
    +-- CriticalAlarmBanner  Full-width critical strip
    +-- StatCard / TrendCard
    +-- Loading, FixLegend, deviceActions
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
6. **AuthContext:** the session's public profile and role

### Connection detection mechanism

```js
const sensorTime = new Date(latest.recv_at || latest.timestamp); // receive time
const gap = Date.now() - sensorTime.getTime();
const isStale = gap > HEARTBEAT_STALE_MS;        // 30 seconds

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
|   +-- client.ts                 Axios API client — ALL HTTP calls live here
+-- assets/
|   +-- crayvings.png, hero.png
+-- components/
|   +-- AnalyticsSection.tsx      Dashboard analytics block
|   +-- CriticalAlarmBanner.tsx   Full-width critical strip
|   +-- DeviceConnectionMonitor.tsx  ESP32 connect/disconnect monitoring
|   +-- FarmOverview.tsx          Fleet grid + on-demand "Live check"
|   +-- FixLegend.tsx             Dashboard legend
|   +-- FloatingAlert.tsx         Popup alerts with mute options
|   +-- Header.tsx, Loading.tsx
|   +-- StatCard.tsx, TankSelector.tsx, TrendCard.tsx
|   +-- deviceActions.tsx         Shared device action UI
+-- contexts/
|   +-- AuthContext.tsx, useAuth.ts
|   +-- SensorContext.tsx         Context interfaces
|   +-- SensorProvider.tsx        SSE + polling + stale detection
+-- hooks/
|   +-- useSensors.ts             Consolidated data access
|   +-- useThresholdAlert.ts      Alert threshold monitoring
|   +-- useFleetAlarms.ts         Fleet-wide alarm state
|   +-- useFloatingAlerts.ts      Alert context
|   +-- useHiddenDevices.ts       Hidden-tank panel
+-- pages/                        10 pages, one per route
+-- types/
|   +-- index.ts                  Types, constants, threshold logic, API_BASE
|   +-- threshold.test.cjs        Unit tests for threshold logic
+-- utils/
|   +-- alertGuidance.ts, paramIcons.tsx, pdfBrand.ts
|   +-- playAlertSound.ts, text.ts, time.ts, tokens.ts
+-- App.tsx, main.tsx, index.css
server.cjs                         Express backend
services/
+-- devicePoller.cjs              Star-topology health poller
+-- smsService.cjs                HTTPSMS client + circuit breaker
db/migrations/                    001–016, idempotent, tracked in schema_migrations
tests/                            6 standalone suites
water_monitoring_system/
+-- ESP32_main_code/ESP32_main_code.ino   ESP32 tank-1 firmware (WiFiManager), device ID ESP32_01
+-- NODE_main_code/NODE_main_code.ino     NodeMCU spare firmware (WiFiManager), device ID ESP32_02
```

---

## Running the Application

### 1. Backend

```bash
npm run server        # node server.cjs
```

### 2. Frontend

```bash
npm run dev           # Vite on :5173, proxying /api to :3000
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

`.env.example` is the canonical, complete list — copy it and fill in values. Never
commit the result. The variables below are the ones whose effect is not obvious
from the name.

### Frontend

| Variable | Notes |
|---|---|
| `VITE_API_BASE` | **Leave unset or set to the relative `/api`.** Do **not** set an absolute URL: the session cookie is `HttpOnly; SameSite=Lax`, so it is only sent when the dashboard and the API share an origin. An absolute value makes login fail with no obvious cause, and no CORS setting fixes it. |

### Backend — behaviour worth knowing

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ALLOWED_ORIGINS` | — | Comma-separated CORS allowlist |
| `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_INITIAL_PASSWORD` | — | Owner seeding on a fresh database. `ADMIN_INITIAL_PASSWORD` is a **live plaintext credential** while it sits in `.env`; replace or remove it once the account exists |
| `DEVICE_SECRET` | — | Shared ingestion secret. When set, `POST /sensor` requires the `X-Device-Secret` header |
| `DEVICE_SECRET_GRACE_MS` | — | Window during which a rotated per-device secret is still accepted. A **security control**: `0` locks out any board not yet re-provisioned, non-zero keeps a stolen pre-rotation secret valid until the window closes. Unset falls back to the caller's default (24h, capped at 7 days by `grace_hours`) |
| `COOKIE_SECURE` | off | Set `true` when serving over HTTPS |
| `OTP_EMAIL` / `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` / `SMTP_FROM` | — | Account-deletion OTP email only |
| `DEV_OTP_CONSOLE_FALLBACK` | — | Print OTPs to the console instead of sending mail. Only in non-production; with no `SMTP_HOST` the server always falls back and warns at startup |
| `DELTA_LOGGING_ENABLED` | `true` | Change-only sensor logging |
| `TEMP_DELTA_TOLERANCE` / `WATER_LEVEL_DELTA_TOLERANCE` / `AMMONIA_DELTA_TOLERANCE` | `0.1` / `1.0` / `0.05` | Per-sensor change thresholds |
| `POLL_TIMEOUT_MS` | `2000` | Per-request timeout in the device poller. The poll *cycle* (`POLL_INTERVAL_MS = 5000`) is hard-coded in `services/devicePoller.cjs` and is not configurable |
| `DEVICE_DISCONNECT_ENABLED` | `true` | Disconnect SMS alerts |
| `DISCONNECT_STALE_MS` | `30000` | Silence before a disconnect alert |
| `DISCONNECT_REARM_MS` | `300000` | Steady-online period before a new disconnect may fire |
| `HTTPSMS_API_KEY` / `HTTPSMS_FROM` | — | SMS gateway credentials; `HTTPSMS_FROM` is the SIM's number in E.164 |
| `SMS_COOLDOWN_MS` | `300000` | Critical-alert SMS cooldown |
| `WARNING_SMS_COOLDOWN_MS` | `120000` | Warning-alert SMS cooldown |
| `SMS_DAILY_CAP` | `0` | Daily SMS ceiling; `0` = unlimited |
| `SMS_DELIVERY_POLL_MS` | — | Delivery-status reconciliation cadence |
| `HOURLY_SMS_ENABLED` / `HOURLY_SMS_INTERVAL_MS` | — | Hourly status SMS |

### Not read by the server

Declared in `.env.example` but consumed only by tooling. Setting them in `.env`
affects nothing the server does — they are documented there so the values are
discoverable, and `NO_COLOR` is honoured by convention rather than by this
project.

| Variable | Read by | Purpose |
|---|---|---|
| `API_BASE` | `test-login.cjs`, all suites in `tests/` | Base URL for bare, unprefixed routes. Default `http://localhost:3000` |
| `TEST_USERNAME` / `TEST_PASSWORD` | `test-login.cjs` | Credentials for the login smoke check. No fallback by design — an unset value exits 1 |
| `WATCH_INTERVAL_MS` / `WATCH_STALE_MS` / `WATCH_PROBE_TIMEOUT_MS` | `tools/watch-connection.cjs` | Connection-diagnostic cadence. Defaults 2000 / 15000 / 2000 |
| `NO_COLOR` | `tools/watch-connection.cjs`, `scripts/mock-device.js` | Disable ANSI colour |
| `TOKENS_HASHED` | `tests/regression.cjs` | Set `0` **only** to assert the pre-hash token format. Leave unset normally |

Deliberately absent: `ARDUINO_ENABLED` / `ARDUINO_PORT` / `ARDUINO_BAUD` and
`DEVICE_ID` were removed. There is no serial bridge in this codebase (zero
`ARDUINO_` references anywhere in code or firmware), and the firmware reads its
device id from `#define DEVICE_ID_DEFAULT` — it cannot read `.env`. Their
presence implied a feature that does not exist.

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

# Test mute (admin session required; the /alert/mute endpoint is admin-only)
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
| "Connection refused" | Server not running | Start `npm run server` |
| Login fails, no error shown | `VITE_API_BASE` set to an absolute URL | Unset it, or set it to `/api` |
| CORS error | Wrong port | Add the port to `ALLOWED_ORIGINS` |
| Data not showing | Wrong server IP in firmware | Reconfigure through the WiFiManager portal |
| "Device offline" | ESP32 not connected | Check WiFi, restart the ESP32 (the portal opens automatically) |
| Alert spam | Frequent threshold breaches | Adjust threshold settings |
| AudioContext warning | Browser security | Click anywhere on the page to unlock audio |
| SMS not sending | Missing API key or unconfigured `HTTPSMS_FROM` | See [INTEGRATIONS.md](INTEGRATIONS.md) |

---

## Performance Metrics

| Metric | Value |
|---|---|
| Sensor send interval (ESP32) | 1 second |
| History polling interval | 30 seconds |
| Fleet poll interval | 5 seconds |
| Device poller interval | 5 seconds (`GET /status` health checks) |
| Device poller concurrency | Up to 10 devices at once (2 s request timeout); scales down for smaller fleets |
| Device poller failures | 3 consecutive polls before a warning is logged |
| Dashboard offline threshold | 30 s without a heartbeat |
| Logs polling interval | 5 seconds |
| Request timeout | 10 seconds |
| Connection pool | 20 max connections |
| Page size | 20 items default (10 for logs) |
| Alert cooldown | 10 seconds |
| SMS cooldown (critical) | 5 minutes |
| SMS cooldown (warning) | 2 minutes |
| Rate limit (global) | 300 req/min/IP (device `/sensor` POST exempt) |
| Rate limit (sensor ingest) | 12 req/s per `device_id` |
| Rate limit (login) | 5 **failed** attempts / 15 min / IP |
| JSON body limit | 10 KB |
| Mute durations | 1, 2, 4, 6, 8, 12, 24 hours |

---

## Security Considerations

### Current implementation

- CORS origin validation (enforced allowlist via `ALLOWED_ORIGINS`)
- Input validation with Zod (settings and sensor data)
- SQL parameterized queries (`pg`)
- Sessions are an `HttpOnly`, `SameSite=Lax` cookie; the token is stored SHA-256
  hashed server-side with a 24-hour expiry, and logout revokes it. Nothing in
  `src/` can read the credential — `localStorage` holds only the public profile
  under `crayvings_user`
- Timing-safe password comparison (PBKDF2-SHA512, 600,000 iterations; legacy
  `salt:hash` hashes are transparently re-hashed on the next successful login)
- No known default credential — first-time setup requires
  `ADMIN_INITIAL_PASSWORD`; the plaintext password is never logged or shown in
  the UI
- Device authentication: `POST /sensor` requires an `X-Device-Secret` header
  matching `DEVICE_SECRET` or the per-device secret (compared with
  `timingSafeEqual`-style `safeEqual`), inside its rotation grace window;
  `POST /alert/device-disconnect` requires a valid session
- Rate limiting: global per-IP limiter (300 req/min, `/sensor` POST exempt), a
  per-device ingest limiter (12/s), and a login limiter that counts only
  **failed** attempts (5 / 15 min / IP)
- JSON body-size limit: `express.json({ limit: "10kb" })`
- 5xx responses return a written `message` only — raw Postgres and Express
  internals stay in the server log
- Admin-only actions: muting SMS alerts, and every device mutation
  (register / update / archive / restore / rotate-secret)
- SMS cooldown and mute state persisted in the database
- Old sensor readings pruned after 30 days

### Production recommendations

1. Use HTTPS behind a reverse proxy — and set `COOKIE_SECURE=true` when you do.
   The session cookie is issued without `Secure` by default so it works over
   plain HTTP in development; behind TLS you want it on.
2. Serve the dashboard and the API from a single origin (which `server.cjs` does
   in production) so the `SameSite=Lax` cookie keeps working.
3. Enable database encryption.
4. Replace `ADMIN_INITIAL_PASSWORD` in `.env` once the owner account exists.
   Seeding only reads it when no admin-role user exists (see `seed-admin.cjs`),
   so afterwards it is dead config that only holds a live secret — blank it.
5. **Done:** the deferred audit refactor is complete. Read endpoints are
   authenticated, and the session credential is no longer held in
   `localStorage` — it is an `HttpOnly` cookie, so it is unreachable from
   JavaScript. `Authorization: Bearer` remains for the ESP32s and the test
   harness, which cannot hold a cookie; a browser cannot forge a Bearer request,
   so CSRF-checking it would only break devices.

---

## Future Enhancement Possibilities

1. **Mobile App** — native iOS/Android apps
2. **Push Notifications** — Firebase or similar
3. **Per-Tank Fleet Optimizations** — the star topology is in place and
   per-device threshold overrides ship today; next steps could include tank
   grouping and fleet-wide color-coded farm maps
4. **Data Analysis** — ML-based predictions
5. **WebSocket** — real-time updates instead of SSE + polling
6. **Multi-user** — role-based access beyond `owner` / `admin` / `user`
7. **Export API** — public API for integrations
8. **Email Alerts** — SMTP-based notifications beyond deletion OTPs
9. **Dashboard Widgets** — customizable home page

---

## Doc corrections (2026-10)

Recorded during the merge of `HOW_IT_WORKS.md` and `BLOCK_DIAGRAM.md`, when the
two disagreed and the code was checked. Each of these was wrong in a document
before this merge.

| Claim | Was | Now | Verified against |
|---|---|---|---|
| Offline threshold | 15 s | **30 s** (`HEARTBEAT_STALE_MS`) | `src/contexts/SensorProvider.tsx:55` |
| Login rate limit | 10 attempts / 10 min | **5 failed attempts / 15 min** | `server.cjs:147-160` |
| SMS env vars | `SKYSMS_API_KEY`, `SKYSMS_API_URL` | **`HTTPSMS_API_KEY`, `HTTPSMS_FROM`**; the URL is hardcoded | `server.cjs:967-970` |
| `VITE_API_BASE` | `http://localhost:3000` | **relative `/api`**, or unset | AGENTS.md §2 |
| Frontend authentication | bearer token in `localStorage` | **`HttpOnly` cookie**; only the profile is cached | `src/contexts/AuthContext.tsx:26` |
| SSE authentication | `?token=` query parameter | **cookie**, same-origin | `server.cjs:476`, `src/contexts/SensorProvider.tsx:295` |
| SSE client | `src/hooks/useSSE.ts` | **inside `SensorProvider.tsx`** | `src/contexts/SensorProvider.tsx:273-299` |
| Fleet grid component | `FleetGrid` | **`FarmOverview`** | `src/pages/DashboardPage.tsx:13` |
| Handler count | 61 | **57** (56 REST + 1 SSE) | `server.cjs` |
| Migrations | 17 (001–017) | **16 (001–016)** | `db/migrations/` |
| Test suites | 5 | **6** | `tests/` |
| Pages | 9 | **10** (Auth included) | `src/pages/` |
| Deployment | `dist/` served by an external host | **`server.cjs` serves `dist/` and strips `/api`** | `server.cjs` |
| Ammonia default threshold | 0 – 25 ppm | **0.25 – 1.00 ppm** | `server.cjs:1417` |
| The per-table SQL block | 6 tables inline | **removed** — [DATABASE.md](DATABASE.md) covers all 14 | — |

---

*End of architecture.*