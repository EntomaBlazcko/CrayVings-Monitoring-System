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
- **Real-time sensor monitoring** - Temperature, water level, and ammonia (3 parameters via ESP32)
- **ESP32-based data collection** - Wireless sensor data transmission with WiFiManager captive portal
- **Web dashboard** - Responsive React UI with icon-based navigation
- **Database storage** - PostgreSQL for historical data
- **Smart connection detection** - Connection status based on actual sensor data timestamp, not API poll time
- **Offline data display** - When ESP32 disconnects, pages show last known readings with yellow offline banner; historical data remains viewable from the database
- **Smart alerts** - Floating popup notifications with threshold-based alerts and cooldown
- **SMS notifications** - Critical threshold alerts and device disconnect alerts via SkySMS API
- **SMS mute/sleep** - Pause SMS alerts for 1, 2, 4, 6, 8, 12, or 24 hours
- **Disconnect/reconnect alerts** - Floating popup, sound, and activity log when ESP32 goes offline or comes back online
- **Recipient management** - Manage SMS alert recipients
- **Custom alert sounds** - Audio alerts via Web Audio API
- **PDF export** - Export system logs to PDF (LogsPage) and weekly reports to PDF (Historical Data)
- **Activity logging** - Track user interactions including device connect/disconnect events
- **WiFiManager** - ESP32 firmware uses captive portal for WiFi config (no hardcoded credentials)

### Monitoring Parameters
| Parameter | Sensor | Safe Range |
|-----------|--------|------------|
| Temperature | DS18B20 | 20 - 31°C |
| Water Level | Ultrasonic HC-SR04 | 10 - 100% |
| Ammonia | MQ-137 (NH3 gas) | 0 - 25 ppm |

### Dashboard Pages
- **Home** - Overview, quick stats, connection status, system alerts
- **Dashboard** - Live readings, trend charts, tank status, sensor hub status
- **Sensors** - Individual sensor details with threshold info and connection status
- **Alerts** - Alert history with filtering (Alert/Change)
- **Historical Data** - Trend charts with time filtering (1h, 6h, 24h, 1 week, all time) and weekly report PDF export
- **Activity Logs** - User activity tracking including device connect/disconnect events
- **Logs** - System event logs with parameter filtering and PDF export
- **Settings** - Configure thresholds, manage SMS recipients, mute/sleep SMS alerts, user management

---

## Technologies Used

### Hardware
- **ESP32 DevKit V1** with WiFiManager support
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
| SMS Service | SkySMS API | - |

---

## System Architecture

```
Sensors → ESP32 → Wi-Fi → Express API → PostgreSQL → React Dashboard
                     │                              │
                     ▼                              ▼
                SMS via SkySMS ←───── Alert System (popup + sound + activity log)
```

### Data Flow
1. **Sensors** read environmental data
2. **ESP32** collects and sends data via HTTP POST
3. **Express API** validates and stores in PostgreSQL
4. **React Dashboard** polls for data every 1 second
5. **Connection check** compares sensor data timestamp against current time
6. **Alerts** triggered when values exceed thresholds or ESP32 disconnects
7. **SMS** sent to active recipients for critical events (unless muted)

---

## Prerequisites

### Hardware
- ESP32 DevKit V1
- DS18B20 temperature sensor
- HC-SR04 water level sensor

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

Create a `.env` file:

```bash
PORT=3000
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=crayvings_monitoring_system_db
PG_USER=postgres
PG_PASSWORD=your_password
ALLOWED_ORIGINS=http://localhost:5173
SKYSMS_API_KEY=your_skysms_api_key_here
SKYSMS_API_URL=https://skysms.skyio.site/api/v1
```

### 3. Start Backend

```bash
npm run server
```

### 4. Start Frontend

```bash
npm run dev
```

Dashboard opens at http://localhost:5173

### 5. Connect ESP32

Flash the ESP32 with `esp32code/esp32code.ino`. On first boot, connect to the "Aquaculture-Setup" WiFi access point to configure your WiFi credentials (and backend server IP/port/device ID) via the captive portal. The firmware's default backend address is `192.168.1.16:3000` (`SERVER_IP_DEFAULT` in `esp32code.ino`) — change it if your backend machine has a different LAN IP.

---

## Configuration

### Setting Thresholds
Navigate to **Settings** to configure temperature and water level min/max values.

### SMS Mute / Sleep
Two ways to pause SMS alerts:
1. **Floating alert popup** — Click the bell icon on disconnect alerts (1h/2h/4h/6h/8h/12h/24h)
2. **Settings page** — "SMS Alert Sleep / Mute" section with all durations and unmute button

While muted, disconnect alerts still show as popups and are logged, but SMS is not sent.

### SMS Notifications
- SkySMS integration for critical alerts and device disconnect alerts
- Recipient management in Settings page
- Test SMS feature to verify configuration

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server health check |
| `/sensor` | POST | Submit sensor data |
| `/sensor/latest` | GET | Get latest reading |
| `/sensor` | GET | Get history (`limit`: 1-1000) |
| `/report/weekly` | GET | Weekly report (summary, daily breakdown, alert counts) |
| `/settings` | GET/POST | Get/update thresholds |
| `/settings/recipients` | GET/POST | List/add SMS recipients |
| `/settings/recipients/:id` | PUT/DELETE | Update/delete recipient |
| `/settings/recipients/test/:id` | POST | Send test SMS |
| `/alert/device-disconnect` | POST | Send disconnect alert SMS |
| `/alert/mute` | POST | Mute SMS alerts (`{ hours }`) |
| `/alert/mute-status` | GET | Check mute status |
| `/system-logs` | GET | Get system logs (`page`, `limit`, `action`, `parameter` filters) |
| `/activity-logs` | GET/POST | Get/create activity logs |

---

## Project Structure

```
src/
├── api/client.ts              # API client functions
├── components/
│   ├── FloatingAlert.tsx      # Popup alerts with mute options
│   └── DeviceConnectionMonitor.tsx  # ESP32 connect/disconnect monitoring
├── contexts/
│   ├── SensorContext.tsx
│   └── SensorProvider.tsx     # Data polling + stale detection
├── hooks/
│   ├── useSensors.ts
│   ├── useThresholdAlert.ts
│   └── useFloatingAlerts.ts
├── pages/
│   ├── HomePage.tsx           # Shows last data with offline banner when ESP32 offline
│   ├── DashboardPage.tsx
│   ├── SensorsPage.tsx
│   ├── AlertsPage.tsx
│   ├── HistoricalDataPage.tsx
│   ├── SettingsPage.tsx       # Thresholds + recipients + SMS mute + users
│   ├── LogsPage.tsx
│   └── ActivityLogsPage.tsx
├── types/index.ts
├── utils/playAlertSound.ts
├── App.tsx
├── main.tsx
└── index.css
server.cjs                     # Express backend
esp32code/esp32code.ino        # ESP32 firmware (WiFiManager)
```

---

## Connection & Offline Handling

### How Connection Status Works
- Frontend polls `GET /sensor/latest` every 1 second
- `lastUpdate` uses the **actual sensor data timestamp** (not poll time)
- If sensor data is older than 15 seconds → status = **offline**
- After 5 consecutive failed API requests → status = **offline**

### When ESP32 Disconnects
1. Sensor data becomes stale (older than 15s)
2. Pages show last known readings with yellow offline banner and "ESP32 is offline" message
3. Floating popup: "ESP32 device disconnected — no data received"
4. Critical alert sound plays
5. Activity log: `device_disconnect`
6. SMS sent to active recipients (unless muted)

### When ESP32 Reconnects
1. Fresh data arrives → status = **online**, pages show live readings
2. Floating popup: "ESP32 device reconnected — data restored"
3. Activity log: `device_connect`

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Backend won't start | Check PostgreSQL connection |
| No data showing | Verify ESP32 is connected to same WiFi network |
| CORS error | Add frontend port to ALLOWED_ORIGINS |
| "Device offline" | Check ESP32 WiFi connection (use WiFiManager portal) |
| SMS not sending | Verify SKYSMS_API_KEY in .env |
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

For detailed documentation see HOW_IT_WORKS.md. For SMS configuration see SMS_HOWTO.md.
