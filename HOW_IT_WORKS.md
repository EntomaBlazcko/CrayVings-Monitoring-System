# CRAYvings Monitoring System - How It Works

## System Overview

The CRAYvings Monitoring System is an IoT-based aquaculture monitoring solution for crayfish production. It collects real-time water quality data from sensors and displays it through a responsive web dashboard. The system consists of three main layers: hardware (ESP32 + sensors), backend (Express + PostgreSQL), and frontend (React dashboard).

### Technology Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Frontend | React + TypeScript | React 19, TS 5.9 |
| Build Tool | Vite | 8.0 |
| Styling | Tailwind CSS | 4.2 |
| Charts | Recharts | 3.8 |
| Icons | lucide-react | 1.8 |
| PDF Export | jsPDF + autoTable | 4.2 + 5.0 |
| Routing | react-router-dom | 7.14 |
| Backend | Express.js | 5.2 |
| Database | PostgreSQL | 15+ |
| ORM | pg (connection pool) | 8.20 |
| Validation | Zod | 4.3 |
| HTTP Client | Axios | 1.15 |
| SMS Service | SkySMS API | - |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CRAYvings Monitoring System                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────┐     ┌──────────────┐     ┌─────────────┐     ┌────────┐   │
│  │  ESP32   │────▶│  Express API  │────▶│  PostgreSQL  │────▶│ React  │   │
│  │ Hardware │     │  Backend      │     │ Database    │     │ Dashboard│   │
│  └──────────┘     └──────────────┘     └─────────────┘     └────────┘   │
│       │                   │                   │                  │        │
│       │     ┌──────────────┘                   └──────────────┐   │        │
│       │     │  Alert Generation │     Data Polling (3s)    │   │        │
│       │     └────────────────────┘───────────────────────────┘   │        │
│       │                                                           │        │
│  Sensors:                                                         Pages:  │
│  - DS18B20 (Temperature)                                     - Home      │
│  - Ultrasonic (Water Level)                                  - Dashboard │
│  - Ammonia (simulated)                                       - Sensors   │
│                                                               - Alerts   │
│                                                               - Historical│
│                                                               - Settings  │
│                                                               - Logs      │
│                                                               - Activity  │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Feature List

### 1. Real-Time Water Quality Monitoring

The system continuously monitors water parameters collected by the ESP32:

| Parameter | Sensor | Range | Unit | Default Threshold |
|-----------|--------|-------|------|------------------|
| Temperature | DS18B20 | 0 to 50 | °C | 20 - 31°C |
| Water Level | Ultrasonic HC-SR04 | 0 to 100 | % | 10 - 100% |
| Ammonia | Simulated (MQ-137 when available) | 0 to 1.0 | mg/L | 0 - 1.0 mg/L |

**Features:**
- Continuous data collection from ESP32 every 1000ms
- Sensor validation before sending data (invalid readings sent as -1)
- Real-time display updates every 3 seconds via polling
- Visual indicators for sensor status (online/offline)
- Connection status detection based on actual sensor data timestamp (not poll time)

> **Note:** No physical ammonia sensor is connected yet. The ESP32 firmware
> (`readAmmonia()` in `esp32code/esp32code.ino`) returns a simulated reading so
> the full stack can be tested end-to-end. Swap in a real sensor read when the
> hardware is available.

### 2. Intelligent Alert System

The system includes **smart alert cooldown** to prevent alert spam:

- **Threshold detection** with severity classification
- **Critical status** when values exceed 15% outside threshold range
- **Warning status** when values are slightly outside range
- **Smart alerting**: Only alerts on status transitions (not continuous)
- **10-second cooldown** between repeated alerts for same parameter
- **Automatic reset** when values return to safe range

**Alert Severity Logic:**
```
value within threshold range:        GOOD (green)
value slightly outside threshold:    WARNING (orange)
value 15%+ outside threshold:        CRITICAL (red)
```

### 3. Device Connection Monitoring

The system actively monitors ESP32 connectivity:

- **Stale data detection**: Connection status uses sensor data timestamp, not API response time
- **15-second offline threshold**: If data is older than 15s, device is marked offline
- **Last known data display**: When disconnected, pages show cached readings with yellow offline banner
- **Auto-recovery**: When fresh data arrives, all pages automatically recover
- **Activity logging**: `device_disconnect` and `device_connect` events logged

### 4. Data-Driven Insights & Analytics

- **Historical data analysis** with time range filtering (1h, 6h, 24h, 1w, all time)
- **Trend charts** for Temperature, Water Level, and Ammonia using Recharts
- **Statistical summaries** on dashboard
- **Export capability** via PDF (LogsPage exports system logs, Historical Data exports weekly report)
- **Weekly report** - 7-day summary (min/avg/max per sensor), daily breakdown, and alert counts
- **Flexible history fetching** - Backend supports up to 1000 records (default: 300)
- **Available while device is offline** - History is read from the database, so it stays viewable when the ESP32 disconnects (an amber banner shows the last recorded data time; short ranges that would be empty are dimmed)
- **Failed-sensor sentinel filtering** - Readings the ESP32 marks as failed (-1, and 0 for temperature) are excluded from charts and statistics

### 5. Mobile-Responsive Dashboard

- Fully responsive React UI using Tailwind CSS
- Mobile-friendly navigation sidebar
- Adaptive grid layouts for all screen sizes
- Touch-friendly buttons and controls

### 6. Settings Management

- Configurable thresholds via Settings page
- Persistent storage in database
- Real-time validation with range checking
- Activity logging for all changes
- **SMS recipient management** - Add, edit, delete recipients
- **SMS mute/sleep** - Pause SMS alerts for 1/2/4/6/8/12/24 hours
- **Test SMS** - Verify SMS configuration
- **User management** - Create, delete, reset passwords

### 7. Activity Logging

- Track all user interactions
- Log navigation, button clicks, form submissions
- Log device connect/disconnect events
- Filterable and searchable activity history
- Pagination support

### 8. Custom Alert Sounds

- Synthetic audio tones (Web Audio API)
- Custom sound upload capability
- Sound enable/disable toggle
- Critical disconnect alerts play double-beep sound

### 9. SMS Alert System

- **SkySMS API integration** for sending SMS notifications
- **Threshold alerts** - Sent when sensor values exceed critical thresholds
- **Disconnect alerts** - Sent when ESP32 device goes offline
- **Mute/sleep feature** - Pause SMS for 1/2/4/6/8/12/24 hours
- **Recipient management** - Add, edit, delete authorized recipients
- **SMS cooldown** - Configurable cooldown period
- **SMS logging** - Track all sent messages with status
- **Test SMS** - Send test messages to verify configuration
- **Active/inactive toggle** - Enable/disable recipients without deletion

### 10. PDF Export

- Export system logs to PDF using jsPDF + jspdf-autotable
- Parameter filtering (Temperature, Water Level, Ammonia)
- Summary section with parameter counts
- Auto-table formatting with pagination support (correct page numbers on multi-page exports)
- Available in LogsPage
- **Weekly report export** - Historical Data page (1 Week range) exports the summary, daily table, and alert breakdown to PDF

---

## Data Flow

```
ESP32 ──POST──▶ /sensor ──Validate──▶ PostgreSQL ──Query──▶ Frontend
    │              │                  │  sensors           │    │
    │              │                  ▼                  │    │
    │              │           Check Thresholds        │    │
    │              │                  │                  │    │
    │              │                  ▼                  │    │
    │              └──────▶ system_logs ◀─────────────┘    │
    │                       (Alerts)                         │
    │                                                     ▼
    │                                              Real-time Display
    │                                              (every 3 seconds)
```

### 1. Data Collection (ESP32)

The ESP32 microcontroller reads sensor values at regular intervals:

- **Temperature**: DS18B20 waterproof sensor (OneWire protocol)
- **Water Level**: Ultrasonic HC-SR04 distance sensor with averaging (5 samples)
- **Ammonia**: Simulated in firmware until a physical sensor (e.g., MQ-137) is installed

### 2. Data Transmission

The ESP32 sends a POST request to the backend server via Wi-Fi:

```http
POST http://192.168.1.20:3000/sensor
Content-Type: application/json

{
  "device_id": "ESP32_01",
  "temperature": 25.5,
  "water_level": 80.0,
  "ammonia": 0.12
}
```

### 3. Backend Processing

The Express server (`server.cjs`) performs these operations:

1. **Validation**: Uses Zod schema to validate incoming data
2. **Storage**: Inserts readings into PostgreSQL `sensors` table
3. **Threshold Checking**: Compares values against configurable settings; readings below each sensor's `minValid` (temperature `0.0001`, water level `0`) are treated as failed sensors (`-1` from the ESP32) and skipped
4. **Alert Generation**: Creates alerts for out-of-range values
5. **Logging**: Records all alerts to `system_logs` table
6. **History API**: Accepts `limit` parameter (1-1000, default: 300) for flexible data retrieval

### 4. Frontend Display

The React dashboard:

1. **Polling**: Fetches data every 3 seconds
2. **Display**: Shows real-time readings in cards and charts
3. **Connection check**: Uses sensor data timestamp to determine online/offline
4. **Offline display**: Shows last known readings with yellow banner when ESP32 disconnected
5. **Alerts**: Warns users when parameters exceed thresholds
6. **Disconnect alerts**: Floating popup + sound + activity log when ESP32 offline
7. **SMS**: Sends SMS for critical alerts and device disconnects (unless muted)
8. **Audio**: Plays alert sounds for threshold violations and disconnects

---

## Connection & Offline Handling

### How Connection Status Works

The frontend polls `GET /sensor/latest` every 3 seconds. Unlike before, the connection status is determined by the **actual timestamp of the sensor data** stored in the database, not the time the API responded.

```
lastUpdate = new Date(latest.timestamp)  // Sensor's actual send time
gap = Date.now() - lastUpdate.getTime()
if gap > 15000 → OFFLINE
```

This means:
- If the ESP32 stops sending data, the dashboard correctly shows "offline" after 15 seconds
- If the backend is running but ESP32 is disconnected, stale data is detected
- When fresh data arrives, the system automatically recovers

### When ESP32 Disconnects

1. Sensor data in database becomes stale (older than 15 seconds)
2. Pages show last known readings with yellow "ESP32 is offline" banner
3. Cards show last cached values with reduced opacity
4. **FloatingAlert**: "ESP32 device disconnected — no data received" (red popup, top-right)
5. **Sound**: Critical alert sound (double beep) plays
6. **Activity log**: `device_disconnect` event recorded
7. **SMS**: Sent to all active recipients (unless muted)

### When ESP32 Reconnects

1. Fresh data arrives with current timestamp
2. `connectionStatus` = "online", pages automatically re-render with live readings
3. **FloatingAlert**: "ESP32 device reconnected — data restored" (amber popup)
4. **Activity log**: `device_connect` event recorded

### Offline Threshold Configuration

```typescript
const POLL_INTERVAL = 3000;          // Poll every 3 seconds
const OFFLINE_THRESHOLD = 15000;     // 15 seconds before offline
const MAX_CONSECUTIVE_FAILURES = 5;  // API failures before offline
```

### Historical Data While Offline

Historical data is served from the PostgreSQL database, not from the device, so it remains available when the ESP32 is offline:

- The **Historical Data** page fetches its own history directly from `GET /sensor` on every range change — it does not depend on the live polling connection state
- While offline, an amber banner shows "Device offline — showing recorded data up to {last recorded time}"
- Range buttons that would contain no readings during a long outage (e.g. 1h/6h/24h) are dimmed with an explanatory tooltip; 1 Week and All Time stay enabled
- A hard error is only shown if the server itself is unreachable (no DB access)

---

## Alert System

### How Alerts Work

1. Backend compares sensor values against configured thresholds
2. Frontend performs additional client-side threshold checking
3. Status is classified as GOOD, WARNING, or CRITICAL
4. Alerts are triggered only on status transitions
5. Cooldown prevents repeated alerts for same condition

### Threshold Configuration

Users can configure thresholds in **Settings**:

| Parameter | Default Min | Default Max | Unit |
|------------|--------------|-------------|------|
| Temperature | 20 | 31 | °C |
| Water Level | 10 | 100 | % |
| Ammonia | 0 | 1.0 | mg/L |

### Alert Severity

| Severity | Condition | Color | Behavior |
|----------|-----------|-------|----------|
| **Critical** | Value 15%+ outside range | Red | Immediate alert, repeated sound |
| **Warning** | Value outside range but < 15% | Orange | Alert on status change |
| **Info** | System changes, settings | Blue | Informational |
| **Good** | Value within safe range | Green | No alert |

---

## SMS Alert System

### SkySMS Integration

The system integrates with **SkySMS API** to send SMS notifications for:
- Critical threshold breaches
- ESP32 device disconnect events

**Configuration (.env):**
```bash
SKYSMS_API_KEY=your_skysms_api_key_here
SKYSMS_API_URL=https://skysms.skyio.site/api/v1
SMS_COOLDOWN_MS=120000
```

### SMS Alert Flow

1. **Threshold breach** or **device disconnect** detected
2. **Recipient lookup** - Queries `authorized_recipients` for active recipients
3. **Mute check** - If SMS is muted, skip sending (but still log)
4. **Cooldown check** - Prevents SMS spam
5. **SMS sent** - Individual messages to each recipient
6. **Logging** - All SMS attempts logged to `sms_logs` table

### SMS Mute / Sleep

SMS alerts can be temporarily paused:

**From floating alert popup:**
- Click the bell icon on a disconnect alert
- Choose duration: 1h, 2h, 4h, 6h, 8h, 12h, or 24h
- Popup dismisses, alerts muted until expiration

**From Settings page:**
- "SMS Alert Sleep / Mute" section
- Duration buttons: 1h, 2h, 4h, 6h, 8h, 12h, 24h
- Shows current mute expiration if active
- "Unmute Alerts" button when muted

While muted:
- Floating popups still appear
- Activity logs still recorded
- SMS messages are NOT sent

### Device Disconnect SMS Message

```
CRAYVINGS DEVICE ALERT
ESP32 device disconnected
ESP32 device disconnected — no data for 15+ seconds
Failed polls: 5
Time: 05/04 10:30 AM
```

### Recipient Management

Manage SMS recipients through the **Settings** page:

| Action | Endpoint | Description |
|--------|----------|-------------|
| List | `GET /settings/recipients` | Get all recipients |
| Add | `POST /settings/recipients` | Add new phone number |
| Update | `PUT /settings/recipients/:id` | Toggle active status, edit name |
| Delete | `DELETE /settings/recipients/:id` | Remove recipient |
| Test | `POST /settings/recipients/test/:id` | Send test SMS |

---

## API Endpoints

### Complete API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server info |
| `/health` | GET | Health check |
| `/sensor` | POST | Submit sensor data |
| `/sensor` | GET | Get history (`limit`: 1-1000) |
| `/sensor/latest` | GET | Get latest reading |
| `/report/weekly` | GET | Weekly report (summary, daily breakdown, alert counts) |
| `/settings` | GET | Get thresholds |
| `/settings` | POST | Update thresholds |
| `/settings/recipients` | GET | Get all recipients |
| `/settings/recipients` | POST | Add new recipient |
| `/settings/recipients/:id` | PUT | Update recipient |
| `/settings/recipients/:id` | DELETE | Delete recipient |
| `/settings/recipients/test/:id` | POST | Send test SMS |
| `/alert/device-disconnect` | POST | Send disconnect SMS alert |
| `/alert/mute` | POST | Mute SMS (`{ hours: number }`) |
| `/alert/mute-status` | GET | Check mute status |
| `/system-logs` | GET | Get system logs (`page`, `limit`, `action`, `parameter`) |
| `/logs` | POST | Create log entry |
| `/activity-logs` | GET | Get activity logs (`page`, `limit`, `search`, `sortBy`, `actionType`) |
| `/activity-logs` | POST | Create activity log |

---

## Backend Functionality

### Data Validation & Sanitization

The backend uses **Zod** for schema validation:

```javascript
const sensorSchema = z.object({
  device_id: z.string().min(1).max(50),
  temperature: z.coerce.number().min(-10).max(50),
  water_level: z.coerce.number().min(0).max(100),
  ammonia: z.coerce.number().min(0).max(1).optional(),
  timestamp: z.string().datetime().optional(),
});
```

### Smart Save Logic (Change Detection)

Prevents unnecessary database writes:

```javascript
function normalizeComparableValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (isNumericLike(value)) return Number(value);
  if (typeof value === "string") return value.trim();
  if (isPlainObject(value) || Array.isArray(value)) return stableStringify(value);
  return value;
}
```

**Used for:**
- Settings updates (only changed fields)
- Sensor data (skips duplicates)
- Recipients (only updates changed fields)
- Password reset (checks if new equals current)

---

## Frontend Architecture

### Component Hierarchy

```
App
├── SensorProvider
│   ├── useSensorDataPolling (3s interval)
│   ├── useSettingsManager
│   ├── useLogsManager (5s interval)
│   └── useActivityLogsManager
├── FloatingAlertProvider
├── DeviceConnectionMonitor  ← Monitors ESP32 connect/disconnect
├── FloatingAlertContainer   ← Displays popup alerts
├── Header
├── Sidebar
└── Pages
    ├── HomePage
    ├── DashboardPage
    ├── SensorsPage
    ├── AlertsPage
    ├── HistoricalDataPage
    ├── SettingsPage
    ├── LogsPage
    └── ActivityLogsPage
```

### State Management

React Context with custom hooks:

1. **SensorDataContext**: Real-time sensor data, history, connection status
2. **SensorSettingsContext**: Threshold configuration
3. **LogsContext**: System logs with pagination
4. **ActivityLogsContext**: User activity tracking
5. **FloatingAlertContext**: Toast notifications

### Connection Detection Mechanism

```typescript
const sensorTime = new Date(latest.timestamp);  // Actual sensor send time
const gap = Date.now() - sensorTime.getTime();
const isStale = gap > OFFLINE_THRESHOLD;        // 15 seconds

setState({
  error: isStale ? "ESP32 device is offline..." : null,
  connectionStatus: isStale ? "offline" : "online",
  lastUpdate: sensorTime,
});
```

### Alert Cooldown Logic

```typescript
const ALERT_COOLDOWN_MS = 10000; // 10 seconds

// Only alerts on status transitions
// Resets alert flag when value returns to good range
// Cooldown prevents alert spam
```

---

## IoT/Hardware Integration

### ESP32 Communication Protocol

```
Protocol: HTTP/1.1
Method: POST
Content-Type: application/json
URL: http://<server>:3000/sensor
Baud Rate: 19200
WiFi: WiFiManager captive portal (configurable on first boot)
```

### Network Requirements

- WiFi network (2.4GHz recommended for ESP32)
- WiFiManager captive portal for easy credential configuration
- Server on same local network
- Port 3000 accessible
- Static IP recommended for server
- Auto-reconnect on WiFi drop: on disconnect the firmware retries STA connection for 20 seconds, then falls back to a 180-second WiFiManager portal before retrying

### Sensor Types & Measurement Ranges

| Sensor | Type | Range | Accuracy | Pin |
|--------|------|-------|----------|-----|
| DS18B20 | Digital | 0°C to 50°C | ±0.5°C | GPIO4 |
| HC-SR04 | Ultrasonic | 0 - 100% | ±3mm | GPIO5, GPIO18 |
| Ammonia | Simulated | 0 - 1.0 mg/L | - | (none yet) |

### ESP32 Sensor Validation

- **Temperature**: Valid range 0-50°C, error detection (-127°C = sensor error); failed readings sent as `-1`
- **Water Level**: Valid range 0-100%, ultrasonic echo validation, 5-sample averaging; failed readings sent as `-1`
- **Ammonia**: Valid range 0-1.0 mg/L, simulated in firmware until a real sensor is connected; failed readings sent as `-1`
- The backend skips these sentinel values during threshold evaluation so a failed sensor never triggers a false alert, and the dashboard excludes them from historical charts/stats

---

## Project Structure

```
src/
├── api/
│   └── client.ts           # Axios API client with all functions
├── assets/
│   └── crayvings.png
├── components/
│   ├── Header.tsx
│   ├── Sidebar.tsx
│   ├── StatCard.tsx
│   ├── TrendCard.tsx
│   ├── FloatingAlert.tsx        # Popup alerts with mute options
│   └── DeviceConnectionMonitor.tsx  # ESP32 connect/disconnect monitoring
├── contexts/
│   ├── SensorContext.tsx        # Context interfaces
│   └── SensorProvider.tsx       # Data polling + stale detection
├── hooks/
│   ├── useSensors.ts            # Consolidated data access
│   ├── useThresholdAlert.ts     # Alert threshold monitoring
│   └── useFloatingAlerts.ts     # Alert context
├── pages/
│   ├── HomePage.tsx             # Shows last data when ESP32 offline
│   ├── DashboardPage.tsx
│   ├── SensorsPage.tsx
│   ├── AlertsPage.tsx
│   ├── HistoricalDataPage.tsx
│   ├── SettingsPage.tsx         # Thresholds + recipients + SMS mute + users
│   ├── LogsPage.tsx
│   └── ActivityLogsPage.tsx
├── types/
│   └── index.ts
├── utils/
│   └── playAlertSound.ts
├── App.tsx
├── main.tsx
└── index.css
server.cjs                       # Express backend
esp32code/
└── esp32code.ino                # ESP32 firmware (WiFiManager)
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

Dashboard available at http://localhost:5173

### 3. ESP32

Flash the ESP32 with `esp32code/esp32code.ino`. On first boot, connect to the "CRAYvings-Config" WiFi access point and configure your network via the captive portal.

---

## Environment Variables

### Backend (.env)

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
SMS_COOLDOWN_MS=120000
WARNING_SMS_COOLDOWN_MS=120000
HOURLY_SMS_ENABLED=true
HOURLY_SMS_INTERVAL_MS=3600000
```

### Frontend

```bash
VITE_API_BASE=http://localhost:3000
```

---

## Database Schema

### Sensors Table

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

### System Logs Table

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

### Sensor Settings Table

```sql
CREATE TABLE sensor_settings (
  id SERIAL PRIMARY KEY,
  temp_min DECIMAL(5,2) DEFAULT 20.0,
  temp_max DECIMAL(5,2) DEFAULT 31.0,
  water_level_min DECIMAL(5,2) DEFAULT 10.0,
  water_level_max DECIMAL(5,2) DEFAULT 100.0,
  ammonia_min DECIMAL(5,2) DEFAULT 0.0,
  ammonia_max DECIMAL(5,2) DEFAULT 1.0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Activity Logs Table

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

### Authorized Recipients Table

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

### SMS Logs Table

```sql
CREATE TABLE sms_logs (
  id SERIAL PRIMARY KEY,
  recipient_phone VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL,
  error_message TEXT,
  sms_id VARCHAR(100),
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Debugging Guide

### Quick Status Check

```powershell
Get-NetTCPConnection -LocalPort 3000   # Backend
Get-NetTCPConnection -LocalPort 5432   # PostgreSQL
Get-NetTCPConnection -LocalPort 5173   # Frontend
```

### Testing the Backend API

```bash
curl http://localhost:3000/health
curl http://localhost:3000/sensor/latest
curl -X POST http://localhost:3000/sensor \
  -H "Content-Type: application/json" \
  -d '{"device_id":"TEST","temperature":25.0,"water_level":75.0,"ammonia":0.12}'

# Test mute
curl -X POST http://localhost:3000/alert/mute \
  -H "Content-Type: application/json" \
  -d '{"hours": 4}'

# Check mute status
curl http://localhost:3000/alert/mute-status
```

### Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|---------|
| "Connection refused" | Server not running | Start `node server.cjs` |
| "Invalid URL" | Empty API URL | Set `VITE_API_BASE` |
| CORS error | Wrong port | Add port to `ALLOWED_ORIGINS` |
| Data not showing | Wrong IP | Check server config in frontend |
| "Device offline" | ESP32 not connected | Check WiFi, restart ESP32 (use WiFiManager portal) |
| Alert spam | Frequent threshold breaches | Adjust threshold settings |
| AudioContext warning | Browser security | Click anywhere on page to unlock audio |
| SMS not sending | Missing API key | Set `SKYSMS_API_KEY` in .env |

---

## Performance Metrics

| Metric | Value |
|--------|-------|
| Polling interval | 3 seconds |
| Logs polling interval | 5 seconds |
| Request timeout | 10 seconds |
| Connection pool | 20 max connections |
| Page size | 20 items default |
| Alert cooldown | 10 seconds |
| SMS cooldown (critical) | 2 minutes |
| SMS cooldown (warning) | 2 minutes |
| Offline threshold | 15 seconds |
| Mute durations | 1, 2, 4, 6, 8, 12, 24 hours |

---

## Security Considerations

### Current Implementation

- CORS origin validation
- Input validation with Zod
- SQL parameterized queries (pg)
- Auth tokens with 24-hour expiration

### Production Recommendations

1. Add authentication to all endpoints
2. Use HTTPS
3. Implement rate limiting
4. Add API keys/session tokens
5. Enable database encryption

---

## Future Enhancement Possibilities

1. **Mobile App** - Native iOS/Android apps
2. **Push Notifications** - Firebase or similar
3. **Multi-Pond Support** - Multiple tank monitoring
4. **Data Analysis** - ML-based predictions
5. **WebSocket** - Real-time updates instead of polling
6. **Multi-user** - Role-based access
7. **Export API** - Public API for integrations
8. **Email Alerts** - SMTP-based notifications
9. **Dashboard Widgets** - Customizable home page
