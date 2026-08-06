# SMS Configuration How-To Guide

This guide explains how to customize all SMS features in the CRAYvings Monitoring System, including threshold alerts, device disconnect alerts, mute/sleep, and recipient management.

## Quick Reference

| What you want to change | Where to edit |
|------------------------|---------------|
| Warning SMS message | `server.cjs` → `SMS_CONFIG.messages.warning` |
| Critical SMS message | `server.cjs` → `SMS_CONFIG.messages.critical` |
| Device disconnect SMS | `server.cjs` → `sendDeviceDisconnectAlert()` route |
| Hourly update message | `server.cjs` → `SMS_CONFIG.messages.hourlyUpdate` |
| Sensor display names | `server.cjs` → `SMS_CONFIG.sensorNames` |
| Recipient phone numbers | Database: `authorized_recipients` table OR Settings page |
| Alert thresholds | Settings page OR database `sensor_settings` table |
| SMS mute/sleep | Settings page → "SMS Alert Sleep / Mute" section |
| Hourly update interval | `.env` file → `HOURLY_SMS_INTERVAL_MS` |
| Enable/disable hourly updates | `.env` file → `HOURLY_SMS_ENABLED` |
| SMS cooldown periods | `.env` file → `SMS_COOLDOWN_MS`, `WARNING_SMS_COOLDOWN_MS` |

---

## 1. SMS Alert Types

### Threshold Alert SMS

Sent when sensor values exceed configured thresholds:

- **Warning**: Value slightly outside safe range
- **Critical**: Value 15%+ outside safe range

Messages are customized via `SMS_CONFIG.messages` in `server.cjs` (see sections below).

### Device Disconnect SMS

Sent when the ESP32 device stops sending data for 15+ seconds:

```
CRAYVINGS DEVICE ALERT
ESP32 device disconnected
ESP32 device disconnected — no data for 15+ seconds
Failed polls: 5
Time: 05/04 10:30 AM
```

**Triggered by:** `DeviceConnectionMonitor` component detects `online → offline` transition

**Endpoint:** `POST /alert/device-disconnect` (called internally by backend)

**Muted by:** SMS mute/sleep feature (see section 9)

### Hourly Status Update SMS

Sent at regular intervals with current sensor readings and status summary.

---

## 2. How to Change SMS Message Content

### Warning Alert Message

Edit `SMS_CONFIG.messages.warning` in `server.cjs`:

```javascript
warning: "⚠️ {{SENSOR}} WARNING\n" +
         "Recipient: {{NAME}}\n" +
         "Reading: {{VALUE}}{{UNIT}}\n" +
         "Threshold: {{THRESHOLD}}{{UNIT}}\n" +
         "Time: {{TIME}}\n" +
         "Status: Warning - Please check soon",
```

**Available placeholders:**
- `{{SENSOR}}` - Sensor name (e.g., "TEMPERATURE", "WATER LEVEL")
- `{{NAME}}` - Recipient's name
- `{{VALUE}}` - Current sensor reading
- `{{UNIT}}` - Unit (°C, %)
- `{{THRESHOLD}}` - Threshold value that was crossed
- `{{TIME}}` - Timestamp in Philippines timezone

### Critical Alert Message

Edit `SMS_CONFIG.messages.critical` in `server.cjs`:

```javascript
critical: "🚨 {{SENSOR}} CRITICAL ALERT\n" +
          "Recipient: {{NAME}}\n" +
          "Reading: {{VALUE}}{{UNIT}}\n" +
          "Threshold: {{THRESHOLD}}{{UNIT}}\n" +
          "Time: {{TIME}}\n" +
          "Status: CRITICAL - Immediate action required!",
```

### Device Disconnect Message

Edit the message template in the `/alert/device-disconnect` route handler in `server.cjs`:

```javascript
const message = `CRAYVINGS DEVICE ALERT
ESP32 device disconnected
ESP32 device disconnected — no data for 15+ seconds
Failed polls: ${failedPollCount}
Time: ${formattedTime}`;
```

### Hourly Update Message

Edit `SMS_CONFIG.messages.hourlyUpdate` in `server.cjs`:

```javascript
hourlyUpdate: "📊 CRAYVINGS HOURLY UPDATE\n" +
              "Time: {{TIME}}\n" +
              "Temperature: {{TEMP}}°C ({{TEMP_STATUS}})\n" +
              "Water Level: {{WATER}}% ({{WATER_STATUS}})\n" +
              "{{SUMMARY}}"
```

**Additional placeholders for hourly update:**
- `{{TEMP}}`, `{{TEMP_STATUS}}` - Temperature reading and status
- `{{WATER}}`, `{{WATER_STATUS}}` - Water level reading and status
- `{{SUMMARY}}` - Summary text (e.g., "All systems normal ✅")

---

## 3. How to Change Recipient Phone Numbers

### Option A: Using the Dashboard (Recommended)

1. Login as admin
2. Go to **Settings** → **SMS Recipients**
3. Click **Add Recipient** to add new numbers
4. Use the **Edit** button to change existing numbers
5. Use **Delete** to remove numbers
6. Use the **active toggle** to enable/disable without deleting

### Option B: Using Database (Advanced)

Connect to PostgreSQL and run:

```sql
-- Add new recipient
INSERT INTO authorized_recipients (phone_number, name, is_active)
VALUES ('+639123456789', 'John Doe', true);

-- Update existing recipient's phone number
UPDATE authorized_recipients
SET phone_number = '+639987654321'
WHERE id = 1;

-- Deactivate recipient (stops SMS but keeps history)
UPDATE authorized_recipients
SET is_active = false
WHERE id = 1;

-- View all recipients
SELECT * FROM authorized_recipients ORDER BY created_at DESC;
```

**Phone number format:** Must be `+639XXXXXXXX` (Philippines format)

---

## 4. How to Change Alert Names/Titles

Edit `SMS_CONFIG.sensorNames` in `server.cjs`:

```javascript
sensorNames: {
  "Temperature": "TEMPERATURE",
  "Water Level": "WATER LEVEL"
}
```

Change the values (right side) to customize what appears in SMS messages.

---

## 5. How to Adjust the Hourly Interval

### Option A: Using `.env` file (Recommended)

```bash
# Send hourly update every 2 hours (in milliseconds)
HOURLY_SMS_INTERVAL_MS=7200000

# Or every 30 minutes
HOURLY_SMS_INTERVAL_MS=1800000

# Or every 1 hour (default)
HOURLY_SMS_INTERVAL_MS=3600000
```

### Option B: Change the default in `server.cjs`

Edit `SMS_CONFIG.hourly.intervalMs`:

```javascript
hourly: {
  enabled: process.env.HOURLY_SMS_ENABLED !== 'false',
  intervalMs: process.env.HOURLY_SMS_INTERVAL_MS
    ? parseInt(process.env.HOURLY_SMS_INTERVAL_MS)
    : 60 * 60 * 1000  // Default: 1 hour
}
```

**Common intervals:**
- 30 minutes = 1800000
- 1 hour = 3600000
- 2 hours = 7200000
- 6 hours = 21600000

---

## 6. How to Turn Hourly Updates On/Off

### Using `.env` file

```bash
# Disable hourly updates
HOURLY_SMS_ENABLED=false

# Enable hourly updates (default)
HOURLY_SMS_ENABLED=true
```

Restart the server after changing.

---

## 7. How to Customize SMS Sender Name

Edit `SMS_CONFIG.from` in `server.cjs`:

```javascript
from: "CRAYVINGS"  // Change this to your preferred sender name (max 11 characters)
```

---

## 8. How to Change SMS Cooldown Periods

Add or edit in your `.env` file:

```bash
# Critical alert cooldown (default: 5 minutes = 300000)
SMS_COOLDOWN_MS=300000

# Warning alert cooldown (default: 1 hour = 3600000)
WARNING_SMS_COOLDOWN_MS=3600000
```

This prevents spam if a sensor stays in warning/critical state.

---

## 9. SMS Mute / Sleep Feature

### Overview

Pause SMS alert delivery for a specified duration while keeping all other alert features active (floating popups, activity logs, sounds still work normally).

### How to Mute SMS

#### From Floating Alert Popup

1. When a disconnect alert appears (red popup, top-right)
2. Click the **bell icon** 🔔 on the popup
3. Select a duration: **1h**, **2h**, **4h**, **6h**, **8h**, **12h**, or **24h**
4. Popup dismisses, SMS muted until expiration

#### From Settings Page

1. Go to **Settings** → **SMS Alert Sleep / Mute**
2. Click a duration button: **1h**, **2h**, **4h**, **6h**, **8h**, **12h**, **24h**
3. Current mute expiration shows if active
4. Click **Unmute Alerts** to re-enable immediately

### How Mute Works

**Backend:**
- In-memory timer: `smsMuteUntil = Date.now() + (hours * 60 * 60 * 1000)`
- Before sending SMS, checks: `Date.now() < smsMuteUntil`
- If muted: SMS skipped, but still logged to `sms_logs` with status `muted`
- Server restart clears mute state

**API Endpoints:**
```bash
# Mute SMS
POST /alert/mute
Body: { "hours": 4 }

# Check mute status
GET /alert/mute-status
Response: { "isMuted": true, "muteUntil": "2025-05-04T18:30:00Z" }
```

### While Muted

- ✅ Floating popups still appear
- ✅ Activity logs still recorded
- ✅ Alert sounds still play
- ❌ SMS messages are NOT sent (logged as "muted")

### Mute Durations Reference

| Duration | Milliseconds | Use Case |
|----------|-------------|----------|
| 1 hour | 3600000 | Quick maintenance |
| 2 hours | 7200000 | Short system work |
| 4 hours | 14400000 | Half-day work |
| 6 hours | 21600000 | Extended maintenance |
| 8 hours | 28800000 | Work shift |
| 12 hours | 43200000 | Overnight |
| 24 hours | 86400000 | Full day |

---

## 10. Testing SMS Configuration

### Send Test SMS

1. Go to **Settings** → **SMS Recipients**
2. Click the **Test** button next to any recipient
3. A test message is sent immediately
4. Check the recipient's phone for delivery

### API Endpoint

```bash
POST /settings/recipients/test/:id
```

### Test Message Content

```
CRAYVINGS TEST MESSAGE
This is a test SMS from the CRAYvings Monitoring System.
If you received this, SMS configuration is working correctly.
Time: 05/04 10:30 AM
```

---

## 11. SMS Alert Flow

```
Sensor Threshold Breach OR Device Disconnect
           │
           ▼
    Check Mute Status
           │
    ┌──────┴──────┐
    │             │
  Muted        Not Muted
    │             │
    ▼             ▼
  Log only    Check Cooldown
    │             │
    │       ┌─────┴─────┐
    │       │           │
    │   In Cooldown   Ready
    │       │           │
    │       ▼           ▼
    │    Log only   Query Active Recipients
    │       │           │
    │       │           ▼
    │       │     Send SMS (SkySMS API)
    │       │           │
    │       │           ▼
    │       │     Log to sms_logs
    └───────┴───────────┘
```

---

## 12. SMS Log Table

All SMS attempts (sent, failed, muted) are logged to `sms_logs`:

```sql
CREATE TABLE sms_logs (
  id SERIAL PRIMARY KEY,
  recipient_phone VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL,  -- 'sent', 'failed', 'muted'
  error_message TEXT,
  sms_id VARCHAR(100),           -- SkySMS message ID
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### View Recent SMS Logs

```sql
-- Last 20 SMS attempts
SELECT * FROM sms_logs ORDER BY sent_at DESC LIMIT 20;

-- Failed messages only
SELECT * FROM sms_logs WHERE status = 'failed' ORDER BY sent_at DESC;

-- Muted messages
SELECT * FROM sms_logs WHERE status = 'muted' ORDER BY sent_at DESC;

-- SMS count by status today
SELECT status, COUNT(*) FROM sms_logs
WHERE sent_at >= CURRENT_DATE
GROUP BY status;
```

---

## Troubleshooting

### SMS not sending?

1. Check SkySMS API key is set in `.env`:
   ```bash
   SKYSMS_API_KEY=your_actual_key_here
   ```

2. Check for active recipients:
   ```sql
   SELECT * FROM authorized_recipients WHERE is_active = true;
   ```

3. Check SMS logs:
   ```sql
   SELECT * FROM sms_logs ORDER BY sent_at DESC LIMIT 10;
   ```

4. Check if SMS is muted:
   ```bash
   curl http://localhost:3000/alert/mute-status
   ```

5. Send a test SMS from Settings page to verify configuration

### Want different messages for each sensor?

Currently, one template is used for all sensors of the same severity. To customize per sensor, modify the SMS sending code in the `for (const sensor of sensorChecks)` loop in `server.cjs`.

### Device disconnect SMS not sending?

1. Verify `POST /alert/device-disconnect` endpoint exists in `server.cjs`
2. Check that `DeviceConnectionMonitor` is mounted inside `FloatingAlertProvider` in `App.tsx`
3. Verify active recipients exist in `authorized_recipients` table
4. Check SMS mute status (may be silenced)

---

## Example Custom Configuration

Here's an example of a fully customized `.env`:

```bash
# Server
PORT=3000

# Database
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=crayvings_monitoring_system_db
PG_USER=postgres
PG_PASSWORD=your_password

# SkySMS
SKYSMS_API_KEY=your_skysms_api_key_here
SKYSMS_API_URL=https://skysms.skyio.site/api/v1

# SMS Cooldowns
SMS_COOLDOWN_MS=300000        # 5 min cooldown for critical
WARNING_SMS_COOLDOWN_MS=3600000 # 1 hour cooldown for warning

# Hourly Updates
HOURLY_SMS_ENABLED=true
HOURLY_SMS_INTERVAL_MS=3600000  # Every 1 hour
```
