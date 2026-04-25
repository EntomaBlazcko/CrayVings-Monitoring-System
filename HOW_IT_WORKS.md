# CRAYvings Monitoring System - How It Works

## System Overview

The CRAYvings Monitoring System is an IoT-based aquaculture monitoring solution for crayfish production. It collects real-time water quality data from sensors and displays it through a responsive web dashboard. The system consists of three main layers: hardware (ESP32 + sensors), backend (Express + PostgreSQL), and frontend (React dashboard).

### Technology Stack

| Component | Technology | Version |
|-----------|-------------|---------|
| Frontend | React + TypeScript | React 19, TS 5.9 |
| Build Tool | Vite | 8.0 |
| Styling | Tailwind CSS | 4.2 |
| Charts | Recharts | 3.8 |
| Backend | Express.js | 5.2 |
| Database | PostgreSQL | 15+ |
| ORM | pg (connection pool) | 8.20 |
| Validation | Zod | 4.3 |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CRAYvings Monitoring System                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────┐     ┌──────────────┐     ┌─────────────┐     ┌────────┐  │
│  │  ESP32   │────▶│  Express API  │────▶│ PostgreSQL  │────▶│ React  │  │
│  │ Hardware │     │  Backend      │     │ Database    │     │ Dashboard│  │
│  └──────────┘     └──────────────┘     └─────────────┘     └────────┘  │
│       │                   │                   │                  │         │
│       │     ┌──────────────┘                   └──────────────┐   │         │
│       │     │  Alert Generation │     Data Polling (3s)    │   │         │
│       │     └────────────────────┘───────────────────────────┘   │         │
│       │                                                           │         │
│  Sensors:                                                         Pages:   │
│  - DS18B20 (Temperature)                                     - Home     │
│  - Ultrasonic (Water Level)                                    - Dashboard│
│  - pH Probe                                                   - Sensors   │
│  - DO Sensor                                                 - Alerts    │
│  - Ammonia Sensor                                             - Historical │
│                                                               - Settings  │
│                                                               - Logs      │
│                                                               - Activity  │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Feature List

### 1. Real-Time Water Quality Monitoring

The system continuously monitors five critical water parameters:

| Parameter | Sensor | Range | Unit | Default Threshold |
|-----------|--------|-------|------|------------------|
| Temperature | DS18B20 | -10 to 50 | °C | 20 - 31°C |
| Water Level | Ultrasonic HC-SR04 | 0 to 100 | % | 10 - 100% |
| pH Level | pH Probe | 0 to 14 | - | 6.5 - 8.5 |
| Dissolved Oxygen | DO Sensor | 0 to 20 | mg/L | 5 - 10 mg/L |
| Ammonia | Ammonia Sensor | 0 to 10 | ppm | 0 - 0.5 ppm |

**Features:**
- Continuous data collection from ESP32 every 500ms (configurable)
- Real-time display updates every 3 seconds via polling
- Visual indicators for sensor status (online/offline)
- Timestamp tracking for all readings

### 2. Automated Alert System

The backend automatically generates alerts when sensor values exceed configured thresholds:

- **Real-time threshold checking** on each sensor reading
- **Severity classification**: Critical, Warning, Info
- **Automatic logging** to system_logs table
- **Visual alerts** in dashboard with color-coded cards

### 3. Data-Driven Insights & Analytics

- **Historical data analysis** with time range filtering (1h, 6h, 24h, all)
- **Trend charts** for all parameters using Recharts
- **Statistical summaries** on dashboard
- **Export capability** via API endpoints

### 4. Historical Data Analysis

- Store all sensor readings in PostgreSQL
- Query historical data with pagination
- Time-based filtering (1 hour, 6 hours, 24 hours, all time)
- Data visualization with line charts

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

### 7. Activity Logging

- Track all user interactions
- Log navigation, button clicks, form submissions
- Filterable and searchable activity history
- Pagination support

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
- **Water Level**: Ultrasonic HC-SR04 distance sensor
- **pH Level**: Analog pH probe with calibration
- **Dissolved Oxygen**: DO sensor (optional)
- **Ammonia**: Ammonia sensor (optional)

### 2. Data Transmission

The ESP32 sends a POST request to the backend server via Wi-Fi:

```http
POST http://192.168.1.20:3000/sensor
Content-Type: application/json

{
  "device_id": "ESP32_01",
  "temperature": 25.5,
  "water_level": 80.0,
  "ph": 7.2,
  "dissolved_oxygen": 8.5,
  "ammonia": 0.1,
  "timestamp": "2026-04-25T12:00:00.000Z"
}
```

### 3. Backend Processing

The Express server (`server.cjs`) performs these operations:

1. **Validation**: Uses Zod schema to validate incoming data
2. **Storage**: Inserts readings into PostgreSQL `sensors` table
3. **Threshold Checking**: Compares values against configurable settings
4. **Alert Generation**: Creates alerts for out-of-range values
5. **Logging**: Records all alerts to `system_logs` table

### 4. Frontend Display

The React dashboard:

1. **Polling**: Fetches data every 3 seconds
2. **Display**: Shows real-time readings in cards and charts
3. **Status**: Indicates connection status (online/offline)
4. **Alerts**: Warns users when parameters exceed thresholds

---

## Connection & Offline Handling

### Live Connection

- Frontend polls `/sensor/latest` every 3 seconds
- Connection status shown as **ONLINE** (green) or **OFFLINE** (red)
- Last update timestamp displayed

### Disconnect Detection

- If 5 consecutive polls fail, status changes to **OFFLINE**
- Error message displayed: "Unable to connect to device"
- Auto-retries continue even in offline state

### Reconnection

- When data resumes, status automatically returns to **ONLINE**
- All components re-render with fresh data
- Historical data preserved in database

---

## Alert System

### How Alerts Work

1. Backend compares sensor values against configured thresholds
2. If value exceeds min/max range, an alert is logged
3. Frontend displays alerts sorted by severity

### Threshold Configuration

Users can configure thresholds in **Settings**:

| Parameter | Default Min | Default Max | Unit |
|------------|--------------|-------------|------|
| Temperature | 20 | 31 | °C |
| pH Level | 6.5 | 8.5 | - |
| Dissolved Oxygen | 5 | 10 | mg/L |
| Water Level | 10 | 100 | % |
| Ammonia | 0 | 0.5 | ppm |

### Alert Severity

| Severity | Condition | Color |
|----------|-----------|-------|
| **Critical** | DO < 3 mg/L, Ammonia > 1 ppm, pH < 5 or > 9 | Red |
| **Warning** | Any value outside configured range | Orange |
| **Info** | System changes, settings updates | Blue |

---

## API Endpoints

### Complete API Reference

| Endpoint | Method | Description | Request Body | Response |
|----------|--------|-------------|--------------|----------|
| `/` | GET | Server info | - | `{message, routes: []}` |
| `/health` | GET | Health check | - | `{status, database, documents, serverTime}` |
| `/sensor` | POST | Submit sensor data | Sensor payload | `{message, data}` |
| `/sensor` | GET | Get history | - | `SensorEntry[]` |
| `/sensor/latest` | GET | Get latest | - | `SensorEntry` |
| `/settings` | GET | Get thresholds | - | `SensorSettings` |
| `/settings` | POST | Update thresholds | Partial Settings | `{message, data}` |
| `/system-logs` | GET | Get logs | `?page=&limit=` | `{data, total}` |
| `/logs` | POST | Create log | `{action, parameter, old_value, new_value}` | `{message, data}` |
| `/activity-logs` | GET | Get activity | `?page=&limit=&search=&sortBy=` | `{data, total, page, limit, totalPages}` |
| `/activity-logs` | POST | Create activity | `{action_type, description, module}` | `{message, data}` |

### Request/Response Examples

#### Health Check

```bash
GET /health
```

Response:
```json
{
  "status": "ok",
  "database": "connected",
  "documents": 156,
  "serverTime": "2026-04-25T12:00:00.000Z"
}
```

#### Submit Sensor Data

```bash
POST /sensor
Content-Type: application/json

{
  "device_id": "ESP32_01",
  "temperature": 25.5,
  "water_level": 80.0,
  "ph": 7.2,
  "dissolved_oxygen": 8.5,
  "ammonia": 0.1
}
```

Response:
```json
{
  "message": "Saved to database",
  "data": {
    "id": 157,
    "device_id": "ESP32_01",
    "temperature": 25.5,
    "water_level": 80.0,
    "ph": 7.2,
    "dissolved_oxygen": 8.5,
    "ammonia": 0.1,
    "timestamp": "2026-04-25T12:00:00.000Z"
  }
}
```

#### Get Latest Sensor

```bash
GET /sensor/latest
```

Response:
```json
{
  "id": 157,
  "device_id": "ESP32_01",
  "temperature": 25.5,
  "water_level": 80.0,
  "ph": 7.2,
  "dissolved_oxygen": 8.5,
  "ammonia": 0.1,
  "timestamp": "2026-04-25T12:00:00.000Z"
}
```

#### Get Settings

```bash
GET /settings
```

Response:
```json
{
  "id": 1,
  "temp_min": 20.0,
  "temp_max": 31.0,
  "ph_min": 6.5,
  "ph_max": 8.5,
  "do_min": 5.0,
  "do_max": 10.0,
  "water_level_min": 10.0,
  "water_level_max": 100.0,
  "ammonia_min": 0.0,
  "ammonia_max": 0.5
}
```

#### Update Settings

```bash
POST /settings
Content-Type: application/json

{
  "temp_min": 18.0,
  "temp_max": 32.0,
  "ph_min": 6.0,
  "ph_max": 9.0
}
```

Response:
```json
{
  "message": "Settings saved",
  "data": { ... }
}
```

#### Get System Logs

```bash
GET /system-logs?page=1&limit=20
```

Response:
```json
{
  "data": [
    {
      "id": 45,
      "action": "Alert",
      "parameter": "Temperature",
      "old_value": "High",
      "new_value": "32.5",
      "timestamp": "2026-04-25T11:45:00Z"
    }
  ],
  "total": 45
}
```

### Error Handling & Status Codes

| Status Code | Meaning | Description |
|------------|---------|-------------|
| 200 | OK | Request succeeded |
| 201 | Created | Resource created successfully |
| 400 | Bad Request | Invalid request body or validation error |
| 404 | Not Found | No data found |
| 500 | Server Error | Internal server error |

#### Validation Error Response

```json
{
  "message": "Validation error",
  "errors": {
    "temperature": ["Number must be greater than or equal to -10"],
    "ph": ["Required"]
  }
}
```

---

## Expanded Backend Functionality

### Data Validation & Sanitization

The backend uses **Zod** for schema validation:

```javascript
const sensorSchema = z.object({
  device_id: z.string().min(1).max(50),
  temperature: z.coerce.number().min(-10).max(50),
  water_level: z.coerce.number().min(0).max(100),
  ph: z.coerce.number().min(0).max(14),
  dissolved_oxygen: z.coerce.number().min(0).max(20).optional(),
  ammonia: z.coerce.number().min(0).max(10).optional(),
  timestamp: z.string().datetime().optional(),
});
```

**Validation features:**
- Type coercion (strings to numbers)
- Range constraints
- Optional fields for optional sensors
- Datetime parsing

### Database Operations

Connection pooling with `pg` library:

```javascript
const pool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || "crayvings_monitoring_system_db",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

### Middleware

#### CORS Configuration

```javascript
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:5174").split(",");
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || origin.startsWith("http://localhost:")) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));
```

#### Request Logging

All requests are logged with timestamps:

```javascript
console.log(`[${new Date().toISOString()}] Sensor data saved:`, data);
```

---

## Enhanced Frontend Functionality

### Component Hierarchy

```
App
├── SensorProvider (data context)
│   ├── useSensorDataPolling (3s interval)
│   ├── useSettingsManager
│   ├── useLogsManager (5s interval)
│   └── useActivityLogsManager
├── Router
│   ├── Header
│   ├── Sidebar
│   └── Pages
│       ├── HomePage
│       ├── DashboardPage
│       ├── SensorsPage
│       ├── AlertsPage
│       ├── HistoricalDataPage
│       ├── SettingsPage
│       ├── LogsPage
│       └── ActivityLogsPage
└── Components
    ├── StatCard
    ├── TrendCard
    └── ...
```

### State Management Approach

The application uses React Context with custom hooks:

1. **SensorDataContext**: Real-time sensor data
2. **SensorSettingsContext**: Threshold configuration
3. **LogsContext**: System logs with pagination
4. **ActivityLogsContext**: User activity tracking

### Real-Time Polling Mechanism

```typescript
const POLL_INTERVAL = 3000; // 3 seconds
const MAX_CONSECUTIVE_FAILURES = 5;

useEffect(() => {
  fetchData();
  intervalRef.current = setInterval(fetchData, POLL_INTERVAL);
  return () => clearInterval(intervalRef.current);
}, []);
```

### Chart Visualization

Using **Recharts** for data visualization:

- Line charts for trend analysis
- Real-time data updates
- Time-based filtering
- Responsive design

### Alert Configuration

The Settings page allows:
- Min/max threshold configuration
- Real-time validation
- Range checking (min < max)
- Activity logging

---

## IoT/Hardware Integration

### ESP32 Communication Protocol

The ESP32 communicates via HTTP POST requests:

```
Protocol: HTTP/1.1
Method: POST
Content-Type: application/json
URL: http://<server>:3000/sensor
Baud Rate: 19200
```

### Data Transmission Format

```json
{
  "device_id": "ESP32_01",
  "temperature": 25.50,
  "water_level": 75.00,
  "ph": 7.20,
  "dissolved_oxygen": 8.50,
  "ammonia": 0.10,
  "timestamp": "2026-04-25T12:00:00Z"
}
```

### Network Requirements

- WiFi network (2.4GHz recommended for ESP32)
- Server on same local network
- Port 3000 accessible
- Static IP recommended for server

### Sensor Types & Measurement Ranges

| Sensor | Type | Range | Accuracy | Pin |
|--------|------|-------|----------|-----|
| DS18B20 | Digital | -55°C to 125°C | ±0.5°C | GPIO4 |
| HC-SR04 | Ultrasonic | 2cm - 400cm | ±3mm | GPIO5, GPIO18 |
| pH Probe | Analog | 0 - 14 | ±0.1 | GPIO34 |
| DO Sensor | Analog | 0 - 20 mg/L | ±0.2 mg/L | (optional) |
| Ammonia | Analog | 0 - 10 ppm | ±0.1 ppm | (optional) |

### ESP32 Firmware Features

- **WiFi connectivity** with auto-reconnect
- **Sensor averaging** (5 samples for stability)
- **JSON payload construction**
- **Error handling** for failed requests
- **Serial debugging** at 19200 baud

---

## Project Structure

```
src/
├── api/
│   └── client.ts           # Centralized API client with AbortController
├── components/
│   ├── Header.tsx          # Top navigation bar
│   ├── Sidebar.tsx         # Side menu navigation
│   ├── StatCard.tsx        # Metric display card
│   └── TrendCard.tsx       # Line chart component
├── contexts/
│   ├── SensorContext.tsx   # Context interfaces
│   └── SensorProvider.tsx  # Data fetching hooks (polling)
├── hooks/
│   └── useSensors.ts       # Consolidated data access hook
├── pages/
│   ├── HomePage.tsx        # Landing page with status overview
│   ├── DashboardPage.tsx   # Main monitoring view
│   ├── SensorsPage.tsx     # Individual sensor details
│   ├── AlertsPage.tsx      # Alert history
│   ├── HistoricalDataPage.tsx  # Trend charts
│   ├── SettingsPage.tsx    # Threshold configuration
│   ├── LogsPage.tsx        # System log viewer
│   └── ActivityLogsPage.tsx  # User activity tracking
├── types/
│   └── index.ts            # TypeScript types and helpers
├── App.tsx                 # Main app with routing
├── main.tsx                # Entry point
└── index.css              # Tailwind styles
server.cjs                  # Express backend server
esp32code/
└── esp32code.ino         # ESP32 firmware
```

---

## Running the Application

### 1. Backend

```bash
node server.cjs
```

Expected output:
```
[2026-04-25T12:00:00.000Z] Server started on port 3000
[2026-04-25T12:00:00.000Z] PostgreSQL connected and table ready
```

### 2. Frontend

```bash
npm run dev
```

Dashboard available at http://localhost:5173 (or 5174 if port in use)

### 3. ESP32

Configure the ESP32 with your server IP in `esp32code.ino`:

```cpp
const char* serverName = "http://192.168.1.20:3000/sensor";
```

Upload using Arduino IDE and monitor at 19200 baud.

---

## Environment Variables

### Backend (.env)

```bash
# Server Configuration
PORT=3000

# PostgreSQL Configuration
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=crayvings_monitoring_system_db
PG_USER=postgres
PG_PASSWORD=your_password

# ESP32 Configuration
ARDUINO_ENABLED=true
ARDUINO_PORT=COM3
ARDUINO_BAUD=19200
DEVICE_ID=ARDUINO_001
POLL_INTERVAL=5000
```

### Frontend

```bash
# Optional - defaults to http://localhost:3000
VITE_API_URL=http://localhost:3000
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
  ph DECIMAL(5,2) DEFAULT 0,
  dissolved_oxygen DECIMAL(5,2) DEFAULT 0,
  ammonia DECIMAL(5,2) DEFAULT 0,
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
  ph_min DECIMAL(5,2) DEFAULT 6.5,
  ph_max DECIMAL(5,2) DEFAULT 8.5,
  do_min DECIMAL(5,2) DEFAULT 5.0,
  do_max DECIMAL(5,2) DEFAULT 10.0,
  water_level_min DECIMAL(5,2) DEFAULT 10.0,
  water_level_max DECIMAL(5,2) DEFAULT 100.0,
  ammonia_min DECIMAL(5,2) DEFAULT 0.0,
  ammonia_max DECIMAL(5,2) DEFAULT 0.5,
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

---

## Debugging Guide

This section helps you diagnose and fix connection issues between ESP32, backend, and frontend.

### Quick Status Check

```powershell
# Check if backend is running (port 3000)
Get-NetTCPConnection -LocalPort 3000

# Check if PostgreSQL is running
Get-NetTCPConnection -LocalPort 5432

# Check frontend ports (5173 or 5174)
Get-NetTCPConnection -LocalPort 5173,5174
```

### Testing the Backend API

```bash
# Health check
curl http://localhost:3000/health

# Get latest sensor
curl http://localhost:3000/sensor/latest

# Manually send test data
curl -X POST http://localhost:3000/sensor \
  -H "Content-Type: application/json" \
  -d '{"device_id":"TEST","temperature":25.0,"water_level":75.0,"ph":7.0}'
```

### Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|---------|
| "Connection refused" | Server not running | Start `node server.cjs` |
| "Invalid URL" | Empty API URL | Set `API_BASE` in types/index.ts |
| CORS error | Wrong port | Add port to ALLOWED_ORIGINS |
| Data not showing | CORS or wrong IP | Check server config |

---

## Performance Metrics & Scalability

### Current Performance

- **Polling interval**: 3 seconds
- **Request timeout**: 10 seconds
- **Connection pool**: 20 max connections
- **Idle timeout**: 30 seconds
- **Page size**: 20 items default, 100 max

### Scalability Considerations

- Database indexing on timestamp columns
- Connection pooling for multiple clients
- Pagination for large datasets
- Client-side data caching

---

## Security Considerations

### Current Implementation

- CORS origin validation
- Input validation with Zod
- SQL parameterized queries (pg)
- No sensitive data in frontend

### Recommendations for Production

1. Add authentication
2. Use HTTPS
3. Implement rate limiting
4. Add API keys/session tokens
5. Enable database encryption
6. Regular security audits

---

## Data Retention

### Current Policy

- All sensor data stored indefinitely
- No automatic cleanup
- Manual deletion via SQL

### Recommendations

- Implement archival for old data
- Set retention policy (e.g., 1 year)
- Regular database maintenance

---

## Future Enhancement Possibilities

1. **Mobile App** - Native iOS/Android apps
2. **Push Notifications** - Firebase or similar
3. **Multi-Pond Support** - Multiple tank monitoring
4. **Export Features** - CSV/PDF export
5. **Data Analysis** - ML-based predictions
6. **API v2** - RESTful redesign
7. **WebSocket** - Real-time updates
8. **Multi-user** - Role-based access

---

## API Rate Limits & Best Practices

### Current Limits

- No rate limiting implemented
- Unrestricted polling

### Recommended Practices

1. **Poll responsibly** - 3s interval is reasonable
2. **Use AbortController** - Cancel stale requests
3. **Handle errors gracefully** - Show user-friendly messages
4. **Validate inputs** - Check data before sending
5. **Monitor performance** - Track response times

---

## Troubleshooting Checklist

Run through this checklist in order:

1. [ ] Backend running? (`node server.cjs` shows no errors)
2. [ ] Frontend running? (`npm run dev` shows local URL)
3. [ ] Database has data? (`SELECT COUNT(*) FROM sensors`)
4. [ ] Browser console shows correct API URL?
5. [ ] Network tab shows successful requests?
6. [ ] No CORS errors in console?

### Restart All Services

```bash
# 1. Stop all servers (Ctrl+C)

# 2. Start backend
node server.cjs

# 3. Start frontend
npm run dev

# 4. Refresh browser
```