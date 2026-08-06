# CHANGES.md - CRAYvings Monitoring System

## Change Log

### 2026-05-05 - Comprehensive Bug Fixes and Improvements

#### ESP32 Firmware (`esp32code/esp32code.ino`)
- **Added comprehensive file header** documenting purpose, data flow, hardware, and watchdog configuration
- **Changed invalid sensor handling**: Invalid sensors now sent as `-1` instead of `0` to distinguish "sensor failed" from valid readings (e.g., water level of 0%)
- **Always POST on WiFi connection**: Data is sent regardless of individual sensor validation status; invalid sensors are sent as `-1`
- **Server URL updated**: `serverName` set to `http://10.91.241.9:3000/sensor`

#### Backend Server (`server.cjs`)
- **Updated file header** to reflect current architecture and data flow
- **Added async SMS processing**: Sensor threshold evaluation and SMS alerts now run in background via `setImmediate()`, eliminating HTTP response delays for ESP32 device
- **Parallel SMS sending**: Recipients now receive SMS via `Promise.allSettled()` - one failure doesn't block others
- **Updated SMS cooldown defaults**: Changed from 1hr (warning) / 5min (critical) to 2 minutes for both
- **Added SMS mute checks**: Both sensor alerts and hourly updates now check `smsMuteUntil` before sending
- **Updated POST /sensor endpoint comment**: Reflects async processing, `-1` sentinel handling, 2-minute cooldowns, and parallel SMS
- **Updated SMS system header**: Documents async processing, parallel sending, and new cooldown defaults
- **Fixed numeric type casting**: Settings API now returns proper JavaScript numbers instead of PostgreSQL strings (prevents frontend string/number mismatch)
- **Invalid sensor handling**: `sensor.val < 0` now skipped during threshold evaluation (no false alerts for failed sensors)

#### Environment Configuration (`.env`)
- **Fixed `VITE_API_BASE`**: Changed from `192.168.1.100:3000` to `10.91.241.9:3000` (matches actual server IP)
- **Updated `SMS_COOLDOWN_MS`**: Changed from `300000` (5 min) to `120000` (2 min)
- **Updated `WARNING_SMS_COOLDOWN_MS`**: Changed from `3600000` (1 hr) to `120000` (2 min)

#### API Client (`src/api/client.ts`)
- **Added numeric parsing in `fetchSettings`**: All numeric fields explicitly cast to `Number()` to prevent string/number mismatch in UI

#### Activity Logs Page (`src/pages/ActivityLogsPage.tsx`)
- **Updated filter dropdown**: Added `device_connect` and `device_disconnect` action types
- **Removed `login` from filter dropdown**: No longer displayed as filterable action type
- **Updated file header**: Reflects current filter options and removes login reference

#### Device Connection Monitor (`src/components/DeviceConnectionMonitor.tsx`)
- **Fixed reconnection detection**: Added dual-path transition check (`offline→online` AND `consecutiveFailures dropping to 0`) to prevent missed `device_connect` logs due to React state timing
- **Updated file header**: Clarifies dual-path detection logic

#### Alerts Page (`src/pages/AlertsPage.tsx`)
- **File header verified**: Comments accurately reflect current functionality

#### SensorProvider (`src/contexts/SensorProvider.tsx`)
- **File header verified**: Comments accurately reflect current polling architecture

## Key Architectural Decisions

1. **`-1` as sentinel value**: Invalid ESP32 sensors send `-1` instead of `0` to distinguish sensor failure from legitimate zero readings (e.g., empty tank = 0% water level)
2. **Async SMS processing**: Moved to `setImmediate()` background task to eliminate ESP32 HTTP response delays
3. **Numeric type normalization**: All PostgreSQL `NUMERIC` columns explicitly cast to JavaScript `Number` at API boundary
4. **Dual-path reconnection detection**: Prevents missed `device_connect` logs due to React state timing issues

## Server Configuration
- **Server IP**: `10.91.241.9:3000`
- **SMS cooldowns**: 2 minutes (both warning and critical)
- **Sensor polling interval**: 3 seconds
- **Connection timeout**: 15 seconds without data = offline

## Notes
- SMS mute state (`smsMuteUntil`) is in-memory; lost on server restart
- SkySMS API queues messages (`status: pending`), causing inherent delivery delays
- PostgreSQL `NUMERIC` columns return as strings; must be explicitly cast to `Number` in API responses
- Hardware watchdog timer: 120 seconds (ESP32 firmware)

### 2026-07-30 - pH Removal + Cleanup

#### pH Threshold Removal
- **Removed pH threshold evaluation** from entire stack: types, API client, pages, hooks, and server
- **Removed pH from `SensorSettings`** type, `DEFAULT_SETTINGS`, `getSettingsThresholds()`
- **Removed pH from `getSettingsThresholds`** - only returns temperature and water_level
- **Removed pH from all pages**: HomePage, DashboardPage, SensorsPage, HistoricalDataPage, LogsPage
- **Removed pH from SMS templates**: hourly update, test SMS, sensor names, units
- **Removed pH from `parseAlertSeverity`** function
- **Removed pH from `SENSOR_KEY_TO_DISPLAY` and `DISPLAY_TO_SENSOR_KEY`** mappings
- **Grid layouts adjusted**: 3-column grids changed to 2-column for all affected pages
- **pH data still stored** in database sensors table (column kept for existing data)

#### Offline Display Enhancement
- **Pages show last known data** with yellow offline banner instead of "Error" state when ESP32 disconnects
- **HomePage, DashboardPage, SensorsPage**: Added `isOfflineWithData` state, overlay colors, cached value display
- **All sensor cards** show reduced opacity during offline state

#### ESP32 Firmware
- **Replaced WiFiMulti with WiFiManager**: ESP32 firmware now uses captive portal for WiFi configuration
- **No hardcoded credentials**: Connect to "CRAYvings-Config" AP on first boot

#### Cleanup
- **Removed unused `Sidebar.tsx`** component (sidebar is defined inline in App.tsx)
- **Removed unused `App.css`** file (not imported anywhere)
- **Removed unused `AlertEntry`** type from types/index.ts
