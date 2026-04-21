# Crayvings Monitoring System - How It Works

## Overview

The Crayvings Monitoring System is an IoT-based aquaculture monitoring solution that collects real-time water quality data from sensors and displays it through a web-based dashboard.

## System Architecture

```
Sensors → ESP32 → Wi-Fi → Backend Server → PostgreSQL Database → React Dashboard
```

### Hardware Layer
- **ESP32 DevKit V1**: Collects data from sensors and sends via Wi-Fi
- **Sensors**: Temperature (DS18B20), Water Level, pH, Dissolved Oxygen, Ammonia

### Backend Layer
- **Express.js Server** (`server.cjs`): REST API running on port 3000
- **PostgreSQL Database**: Stores sensor readings

### Frontend Layer
- **React + TypeScript**: Web dashboard built with Vite
- **TailwindCSS**: Styling
- **Recharts**: Data visualization
- **React Router**: Navigation

---

## How Data Flows

### 1. Data Collection (ESP32)
The ESP32 microcontroller reads sensor values:
- Temperature (°C)
- Water Level (%)
- pH Level
- Dissolved Oxygen (mg/L)
- Ammonia (mg/L)

### 2. Data Transmission
ESP32 sends POST request to the backend:
```
POST http://<server-ip>:3000/sensor
{
  "device_id": "ESP32_001",
  "temperature": 25.5,
  "water_level": 80.0,
  "ph": 7.2,
  "dissolved_oxygen": 8.5,
  "ammonia": 0.1,
  "timestamp": "2026-04-21T12:00:00Z"
}
```

### 3. Backend Processing (`server.cjs`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/health` | GET | Database status |
| `/sensor` | POST | Save new sensor reading |
| `/sensor` | GET | Get last 50 readings |
| `/sensor/latest` | GET | Get most recent reading |

### 4. Frontend Display

The React app:
1. Fetches latest sensor data on load
2. Polls every 3 seconds for updates
3. Displays data in various views based on navigation

---

## Project Structure

```
├── src/
│   ├── components/
│   │   ├── Header.tsx       # Top navigation bar
│   │   ├── Sidebar.tsx      # Menu navigation
│   │   ├── StatCard.tsx     # Individual metric card
│   │   └── TrendCard.tsx   # Chart component
│   ├── pages/
│   │   ├── HomePage.tsx        # Landing page
│   │   ├── DashboardPage.tsx  # Main monitoring view
│   │   ├── SensorsPage.tsx    # Sensor details
│   │   ├── AlertsPage.tsx     # Alerts configuration
│   │   ├── HistoricalDataPage.tsx  # Historical charts
│   │   └── SettingsPage.tsx   # App settings
│   ├── types/
│   │   └── index.ts        # TypeScript interfaces
│   ├── utils/              # Utility functions
│   ├── assets/             # Static assets
│   ├── App.tsx             # Main app component
│   ├── main.tsx            # Entry point
│   └── index.css           # Global styles
├── server.cjs              # Express backend
├── package.json            # Dependencies
└── vite.config.ts          # Vite configuration
```

---

## Running the Application

### Backend
```bash
node server.cjs
```
Server runs on port 3000 (configurable via PORT env var).

### Frontend
```bash
npm run dev
```
Opens on http://localhost:5173 (default Vite port).

---

## Configuration

### Environment Variables (.env)
```
VITE_API_URL=http://192.168.1.20:3000
PORT=3000
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=crayvings_monitoring_system_db
PG_USER=postgres
PG_PASSWORD=your_password
```

### API URL
The frontend fetches from `http://192.168.1.20:3000` by default. Change this in `src/types/index.ts` or via `VITE_API_URL` environment variable.

---

## Database Schema

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
)
```

---

## Key Features

- **Real-time Updates**: Auto-refreshes every 3 seconds
- **Multiple Views**: Dashboard, Sensors, Alerts, Historical Data, Settings
- **Data Visualization**: Charts for temperature, pH, dissolved oxygen, ammonia trends
- **Error Handling**: Displays connection errors when server unavailable
- **Responsive Design**: Works on desktop and mobile

---

## Dependencies

### Frontend
- react, react-dom
- react-router, react-router-dom
- axios (HTTP client)
- recharts (charts)
- lucide-react (icons)
- tailwindcss

### Backend
- express
- cors
- pg (PostgreSQL client)
- dotenv

---

## Troubleshooting

1. **No data showing**: Check server is running and database is connected
2. **Connection refused**: Verify firewall allows port 3000
3. **CORS errors**: Backend uses `origin: "*"` to allow all origins
4. **ESP32 not connecting**: Ensure it's on the same network as the server
