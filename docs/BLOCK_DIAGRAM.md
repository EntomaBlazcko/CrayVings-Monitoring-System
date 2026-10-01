# CRAYvings Aquaculture Monitoring System — Block Diagram

This document accompanies the editable draw.io source at
[`BLOCK_DIAGRAM.drawio`](BLOCK_DIAGRAM.drawio). The `.drawio` file is the
diagram of record; the text version below is provided so this document reads
correctly on its own in a report or printed thesis.

## How to open and edit the diagram

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

---

## Diagram (text version)

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
                              │ 61 REST handlers + SSE
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
  │   devices,             │          │  [9 Pages]               │
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
  │   system_state         │          │  db/migrations (17)      │
  │  Schema Versioning     │          │  tests/ (5 suites)        │
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
| Threshold & Alert Engine | Global + per-tank overrides, severity classification (info / warning / critical), dedup via `last_alerts`, disconnect detection on a 30 s stale window with a rearm grace period against flapping |
| Notification Dispatcher | Fan-out to active recipients, global and per-tank mute handling, daily cap and cooldown, per-message status in `sms_logs` |
| SSE Fan-Out | `GET /sensor/stream` broadcasts every accepted reading to all connected dashboards; token passed as a query parameter because `EventSource` cannot set headers; 25 s keep-alive pings |
| Analytics & Reporting | SQL aggregation, weekly and arbitrary-range reports (hourly buckets ≤ 24 h, else daily), rule-based insight generation |
| Users, Roles & Access | PBKDF2-SHA512 at 600 000 iterations, 64-char session token stored as a SHA-256 hash with a 24 h expiry, two roles (`admin`, `user`), OTP-verified archive / restore / purge |
| Boot & State Recovery | `startServer()` waits for the database with exponential backoff, bootstraps the owner account, then restores dedup state, mute state, ammonia baselines and in-memory latest readings |
| `devicePoller.cjs` | Health poll, max concurrency 10, 2 s timeout, updates `devices.last_health_seen`; writes no sensor rows by design |
| `smsService.cjs` | Circuit breaker: CLOSED / OPEN / HALF_OPEN, 5 consecutive failures trip it, 60 s cooldown, then a single probe. The delivery-reconciliation poller runs outside the breaker |
| Cross-cutting middleware | helmet CSP, CORS allowlist, rate limiting (global 300 req/min/IP, login 5 per 15 min), Zod validation, JSON 404/error envelope |

### 4 · Data layer — PostgreSQL 15

14 tables, accessed through a single `pg.Pool` (max 20 connections, 30 s idle
timeout, 5 s connect timeout). Grouped by function:

| Group | Tables |
|---|---|
| Time-series | `sensors` — the hot table; NULL records a failed sensor; keyset pagination up to 1000 rows |
| Configuration & registry | `devices`, `sensor_settings`, `device_threshold_overrides` |
| Identity & audit | `users`, `email_otps`, `user_deletion_requests`, `activity_logs` |
| Alerting state | `system_logs`, `last_alerts` |
| Messaging state | `authorized_recipients`, `sms_logs`, `system_state` |
| Schema versioning | `schema_migrations` |

### 5 · Presentation layer — React 19 + TypeScript (Vite)

| Block | Responsibility |
|---|---|
| `AuthContext` | Session state, role-aware sidebar and menu, bearer token in `localStorage` injected by an Axios interceptor |
| `SensorProvider` | SSE subscription with exponential reconnect capped at 30 s, REST `/sensor/latest` fallback on mount, fleet registry and per-tank live values every 5 s, chart history every 30 s. Both polls back off on failure and pause while the tab is hidden |
| Pages | Dashboard, Sensors, Alerts, Analytics, Historical Data, Sensor Logs, Activity Logs, Devices, Settings (admin-only pages noted in the diagram) |
| Visualisation & export | Recharts, two-tier alerting (`useThresholdAlert` + `useFleetAlarms`), `CriticalAlarmBanner` / `FloatingAlert` overlays, alert audio, jsPDF + autoTable export |
| Static Asset Host | The Vite `dist/` build, delivered by a separate static host or reverse proxy — see the deployment note below |

### 6 · External services

| Block | Detail |
|---|---|
| HTTPSMS Cloud API | `httpsms.com`. The send POST is breaker-guarded; the delivery-status GET is not, so queued messages still reconcile |
| Android SMS Gateway | A phone running the HttpSms app relays API requests onto the mobile network |
| SMS Recipients | Operators and farm staff, managed from Settings, stored in `authorized_recipients` |
| SMTP / Nodemailer | Account-deletion OTP codes only — not general alerting. Falls back to console output in development |
| Schema migrations | `db/migrations/` — 17 standalone scripts, run manually and tracked in `schema_migrations` |
| Test harness | `tests/` — 5 standalone suites, plus `tools/watch-connection.cjs` |

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

## Key architectural notes

These are also embedded on the diagram itself, so the two stay consistent.

- **Telemetry is push-only.** The server never writes a sensor row on a
  device's behalf, so a stale reading cannot masquerade as a health check. This
  is why the poller is drawn as a separate dashed path rather than folded into
  ingestion.
- **Deployment note.** `server.cjs` defines no `express.static` or `sendFile`
  route, so it serves the API only. The committed `dist/` build is served by an
  external static host or reverse proxy, which is why the diagram shows a
  separate Static Asset Host block inside the presentation layer rather than
  implying the Express server serves the frontend.
- **Base schema is not in version control.** Migrations `001`–`017` assume
  pre-existing tables and there is no automatic runner, so a fresh database
  cannot be built from this repository alone. `server.cjs` additionally applies
  its own additive columns and indexes at startup.
- **Not depicted, by design.** The system uses no MQTT broker, no WebSocket
  transport, no cloud service beyond HTTPSMS and SMTP, and no machine-learning
  model. Analytics are SQL aggregation plus rule-based insight generation.

## Related documentation

| Document | Covers |
|---|---|
| [HOW_IT_WORKS.md](HOW_IT_WORKS.md) | Deep technical reference: alert logic, full API list, component hierarchy, per-table SQL, env vars |
| [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) | Every column, constraint, index and foreign key, plus a DBML ERD |
| [HTTPSMS_SETUP.md](HTTPSMS_SETUP.md) | SMS gateway configuration, recipients, delivery tracking |
| [MOCK_DEVICE.md](MOCK_DEVICE.md) | Using the simulator without hardware |
| [TESTING_MULTI_TANK.md](TESTING_MULTI_TANK.md) | End-to-end multi-tank verification |
| [../README.md](../README.md) | Project overview, quick start, endpoint reference |