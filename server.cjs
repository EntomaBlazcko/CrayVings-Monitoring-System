// =============================================================================
// FILE: server.cjs
// =============================================================================
// PURPOSE: Express.js backend server for the CRAYvings Monitoring System.
//
// This file is the central backend API that:
//   1. Receives sensor data from the ESP32 microcontroller via HTTP POST
//   2. Stores all readings in a PostgreSQL database
//   3. Evaluates sensor values against configurable thresholds
//   4. Sends SMS alerts via SkySMS API when readings go out of range
//   5. Provides REST endpoints for the React frontend to query data
//   6. Manages user authentication with token-based sessions
//   7. Handles system logging, activity logging, and alert muting
//
// DATA FLOW:
//   ESP32 sensor -> POST /sensor -> PostgreSQL (sensors table)
//      -> Threshold evaluation -> SMS alerts (if configured)
//   Frontend -> GET /sensor/latest -> Real-time readings displayed
//   Frontend -> POST /auth/login -> Token returned -> Subsequent requests use Bearer token
//
// ARCHITECTURE:
//   - Single-file Express.js server (CommonJS module)
//   - PostgreSQL connection pool for concurrent query handling
//   - In-memory alert state tracking (lastAlertedState, smsMuteUntil)
//   - Parameterized SQL queries to prevent SQL injection
//   - PBKDF2 password hashing with random salt
//
// SECURITY NOTES:
//   - All SQL queries use parameterized placeholders ($1, $2, etc.)
//   - Passwords are never stored in plaintext (salt + PBKDF2-SHA512)
//   - Auth tokens are 64-character random hex strings
//   - Admin-only routes protected by requireAdmin middleware
//   - User routes protected by requireAuth middleware
//   - CORS enabled for frontend communication
//   - .env file contains database credentials and API keys (gitignored)
// =============================================================================

// ========================
// DEPENDENCIES
// ========================
// - express: HTTP server framework
// - cors: Enables Cross-Origin Resource Sharing for frontend communication
// - axios: HTTP client used to call the SkySMS API
// - pg (Pool): PostgreSQL connection pool for database queries
// - zod: Schema validation library
// - crypto: Node.js built-in module for password hashing and token generation
// - dotenv: Loads environment variables from .env file

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require("pg");
const { z } = require("zod");
const crypto = require("crypto");
require("dotenv").config();

// ========================
// EXPRESS APP SETUP
// ========================
const app = express();
const PORT = process.env.PORT || 3000;

// ========================
// POSTGRESQL CONNECTION POOL
// ========================
// The Pool manages multiple database connections for concurrent requests.
// Configuration is read from environment variables (.env file).
// The pool automatically handles connection reuse, queuing, and cleanup.
const pool = new Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

// Enable CORS so the Vite/React frontend (dev server) can call this API
app.use(cors());
// Parse incoming JSON request bodies
app.use(express.json());

// =============================================================================
// PASSWORD HASHING UTILITIES
// =============================================================================
// Uses PBKDF2 with SHA-512 and a random 16-byte salt for secure password storage.
// The stored format is: "salt:hash" (both as hex strings).
// This is a synchronous hashing approach suitable for this application scale.

/**
 * Hashes a plaintext password with a random salt.
 * @param {string} password - The plaintext password to hash
 * @returns {string} Combined salt and hash in "salt:hash" format
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verifies a plaintext password against a stored "salt:hash" string.
 * @param {string} password - The plaintext password to verify
 * @param {string} stored - The stored "salt:hash" string from the database
 * @returns {boolean} True if the password matches
 */
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return hash === verifyHash;
}

/**
 * Generates a random 64-character hex token for session authentication.
 * @returns {string} Random token string
 */
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// =============================================================================
// AUTHENTICATION MIDDLEWARE
// =============================================================================
// Two middleware functions protect routes based on role:
//   - requireAdmin: Validates token AND checks that user has "admin" role
//   - requireAuth:  Validates token only (any authenticated user)
//
// Both extract the Bearer token from the Authorization header,
// query the database to validate it, and attach the user object to req.
// If validation fails, they return 401 (no token) or 403 (invalid/insufficient role).

/**
 * Middleware that requires a valid admin token.
 * Checks the Authorization header for a Bearer token, validates it against
 * the users table, and ensures the user has the "admin" role.
 * Attaches the user object to req.adminUser on success.
 */
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ message: "Authentication required" });

  pool.query("SELECT * FROM users WHERE token = $1", [token])
    .then(result => {
      if (result.rows.length === 0) return res.status(403).json({ message: "Invalid token" });
      const user = result.rows[0];
      if (user.role !== "admin") return res.status(403).json({ message: "Admin access required" });
      req.adminUser = user;
      next();
    })
    .catch(err => res.status(500).json({ message: "Auth error", error: err.message }));
}

/**
 * Middleware that requires any valid authenticated user token.
 * Checks the Authorization header for a Bearer token and validates it
 * against the users table. Attaches the user object to req.user on success.
 */
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ message: "Authentication required" });

  pool.query("SELECT * FROM users WHERE token = $1", [token])
    .then(result => {
      if (result.rows.length === 0) return res.status(403).json({ message: "Invalid token" });
      req.user = result.rows[0];
      next();
    })
    .catch(err => res.status(500).json({ message: "Auth error", error: err.message }));
}

// =============================================================================
// HELPER: DETECT CHANGED FIELDS
// =============================================================================
// Compares current database row values with proposed updates.
// Only returns fields that have actually changed, to avoid unnecessary DB writes
// and prevent triggering "no change" audit log entries.

/**
 * Compares current database values with proposed updates and returns only changed fields.
 * Uses String() comparison to handle numeric/string type differences.
 * @param {object} current - Current row from the database
 * @param {object} updates - Proposed new values
 * @returns {object} Only the fields that have changed
 */
function getChangedFields(current, updates) {
  const changes = {};
  for (const key of Object.keys(updates)) {
    if (String(current[key] ?? "") !== String(updates[key] ?? "")) {
      changes[key] = updates[key];
    }
  }
  return changes;
}

// =============================================================================
// HELPER: UPDATE ONLY IF FIELDS ACTUALLY CHANGED
// =============================================================================
// Wraps a database UPDATE with change detection.
// Only executes the UPDATE query if at least one field has changed.
// Optionally updates the updated_at timestamp when changes are made.
// This prevents unnecessary database writes and keeps audit logs clean.

/**
 * Performs a database UPDATE only if fields have actually changed.
 * Avoids unnecessary writes and keeps audit trails meaningful.
 * @param {object} client - PostgreSQL client or pool instance
 * @param {object} params - Update parameters
 * @param {string} params.table - Database table name
 * @param {string} params.keyColumn - Primary key column name (e.g., "id")
 * @param {*} params.keyValue - Primary key value
 * @param {object} params.currentRow - Current row data from the database
 * @param {object} params.updates - Proposed new values
 * @param {boolean} params.touchUpdatedAt - Whether to set updated_at to NOW()
 * @returns {object} { changed: boolean, row: updated or current row }
 */
async function updateOnlyIfChanged(client, { table, keyColumn, keyValue, currentRow, updates, touchUpdatedAt }) {
  const changes = getChangedFields(currentRow, updates);
  if (Object.keys(changes).length === 0) {
    return { changed: false, row: currentRow };
  }
  if (touchUpdatedAt) changes.updated_at = new Date();
  const keys = Object.keys(changes);
  const values = Object.values(changes);
  const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const result = await client.query(
    `UPDATE ${table} SET ${setClauses} WHERE ${keyColumn} = $${keys.length + 1} RETURNING *`,
    [...values, keyValue]
  );
  return { changed: true, row: result.rows[0] };
}

// =============================================================================
// THRESHOLD STATUS EVALUATION
// =============================================================================
// Determines if a sensor reading is "good", "warning", or "critical"
// based on its min/max threshold range.
//
// Logic:
//   - "good":      Value is within [min, max] range
//   - "warning":   Value is outside range but within 15% of range size from boundary
//   - "critical":  Value is outside range AND deviation >= 15% of range size
//
// Example for temperature (min=20, max=31, range=11, margin=1.65):
//   - 22°C = good (within range)
//   - 19°C = warning (1° below min, less than 1.65° margin)
//   - 17°C = critical (3° below min, more than 1.65° margin)

/**
 * Evaluates a sensor value against its min/max thresholds.
 * Returns "good", "warning", or "critical" based on how far outside
 * the acceptable range the value is.
 * @param {number} value - Current sensor reading
 * @param {number} min - Minimum acceptable value
 * @param {number} max - Maximum acceptable value
 * @returns {"good"|"warning"|"critical"} Status classification
 */
function getThresholdStatus(value, min, max) {
  const rangeSize = max - min;
  const criticalMargin = rangeSize * 0.15;
  if (value < min) {
    const deviation = min - value;
    return deviation >= criticalMargin ? "critical" : "warning";
  }
  if (value > max) {
    const deviation = value - max;
    return deviation >= criticalMargin ? "critical" : "warning";
  }
  return "good";
}

// =============================================================================
// SMS NOTIFICATION SYSTEM (SkySMS Integration)
// =============================================================================
// This system sends SMS alerts when sensor readings exceed thresholds.
// It uses the SkySMS API (a Philippine SMS gateway) to deliver messages.
//
// Features:
//   - Warning and Critical alert templates with dynamic placeholders
//   - Hourly status update messages with all sensor readings
//   - Exponential backoff retry (up to 2 retries)
//   - SMS logging to database (sms_logs table) for audit trail
//   - Configurable cooldowns (default: 2 minutes for both warning and critical)
//   - Mute functionality to temporarily pause all SMS alerts
//   - Async background processing via setImmediate (non-blocking ESP32 response)
//   - Parallel SMS sending via Promise.allSettled (one failure doesn't block others)
//
// ENVIRONMENT VARIABLES:
//   SKYSMS_API_KEY         - API key for SkySMS service
//   SKYSMS_API_URL         - Base URL for SkySMS API (default: skysms.skyio.site)
//   HOURLY_SMS_ENABLED     - Enable/disable hourly updates (default: true)
//   HOURLY_SMS_INTERVAL_MS - Interval for hourly updates (default: 3600000ms = 1hr)
//   WARNING_SMS_COOLDOWN_MS - Cooldown between warning SMS (default: 120000ms = 2min)
//   SMS_COOLDOWN_MS         - Cooldown between critical SMS (default: 120000ms = 2min)
// =============================================================================

const SKYSMS_API_KEY = process.env.SKYSMS_API_KEY;
const SKYSMS_API_URL = process.env.SKYSMS_API_URL || "https://skysms.skyio.site/api/v1";

// SMS configuration object: templates, sensor name mappings, units, cooldowns
const SMS_CONFIG = {
  messages: {
    // Warning template: sent when a reading is slightly outside the safe range
    warning: "⚠️ {{SENSOR}} WARNING\nRecipient: {{NAME}}\nReading: {{VALUE}}{{UNIT}}\nThreshold: {{THRESHOLD}}{{UNIT}}\nTime: {{TIME}}\nStatus: Warning",
    // Critical template: sent when a reading is dangerously outside the safe range
    critical: "🚨 {{SENSOR}} CRITICAL ALERT\nRecipient: {{NAME}}\nReading: {{VALUE}}{{UNIT}}\nThreshold: {{THRESHOLD}}{{UNIT}}\nTime: {{TIME}}\nStatus: CRITICAL",
    // Hourly update template: periodic summary of all sensor statuses
    hourlyUpdate: "📊 CRAYVINGS HOURLY UPDATE\nTime: {{TIME}}\nTemperature: {{TEMP}}°C ({{TEMP_STATUS}})\npH Level: {{PH}} ({{PH_STATUS}})\nWater Level: {{WATER}}% ({{WATER_STATUS}})\n{{SUMMARY}}"
  },
  // Maps display names to SMS-friendly uppercase names
  sensorNames: { "Temperature": "TEMPERATURE", "pH Level": "PH LEVEL", "Water Level": "WATER LEVEL" },
  // Units for each sensor type in SMS messages
  units: { "Temperature": "°C", "pH Level": "pH", "Water Level": "%" },
  // Hourly SMS update settings
  hourly: {
    enabled: process.env.HOURLY_SMS_ENABLED !== "false",
    intervalMs: parseInt(process.env.HOURLY_SMS_INTERVAL_MS) || 3600000
  },
  // Cooldown periods to prevent alert spam (time between repeated alerts)
  cooldown: {
    warning: parseInt(process.env.WARNING_SMS_COOLDOWN_MS) || 120000,   // 2 minutes
    critical: parseInt(process.env.SMS_COOLDOWN_MS) || 120000            // 2 minutes
  },
  // Retry configuration for failed SMS sends (exponential backoff)
  retry: { maxRetries: 2, baseDelayMs: 2000 },
  from: "CRAYVINGS"  // Sender name displayed on the recipient's phone
};

/**
 * Replaces {{PLACEHOLDER}} tokens in a message template with actual values.
 * @param {string} template - Message template with {{KEY}} placeholders
 * @param {object} data - Key-value pairs to substitute
 * @returns {string} Final message with all placeholders replaced
 */
function buildMessage(template, data) {
  let message = template;
  for (const [key, value] of Object.entries(data)) {
    message = message.replace(new RegExp(`{{${key}}}`, "g"), String(value));
  }
  return message;
}

/**
 * Converts a threshold status string to a human-readable text with emoji.
 * @param {string} status - "good", "warning", or "critical"
 * @returns {string} Display text (e.g., "✅ Good", "⚠️ Warning", "🚨 Critical")
 */
function getStatusText(status) {
  switch (status) {
    case "good": return "✅ Good";
    case "warning": return "⚠️ Warning";
    case "critical": return "🚨 Critical";
    default: return "Unknown";
  }
}

/**
 * Sends a single SMS via the SkySMS API with retry logic.
 * Uses exponential backoff: retries after 2s, 4s, 8s delays.
 * Logs the result (sent/failed) to the sms_logs database table.
 * @param {string} phoneNumber - Recipient phone number (e.g., +639XXXXXXXXX)
 * @param {string} message - The SMS message body
 * @returns {boolean} True if SMS was sent successfully
 */
async function sendSingleSMS(phoneNumber, message) {
  const { maxRetries, baseDelayMs } = SMS_CONFIG.retry;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (!SKYSMS_API_KEY || !SKYSMS_API_URL) {
        console.error("SkySMS configuration missing in .env");
        await logSMS(phoneNumber, message, "failed", "Missing SkySMS config", null);
        return false;
      }
      const response = await axios.post(
        `${SKYSMS_API_URL}/sms/send`,
        { phone_number: phoneNumber, message, from: SMS_CONFIG.from },
        { headers: { "X-API-Key": SKYSMS_API_KEY, "Content-Type": "application/json" }, timeout: 10000 }
      );
      console.log(`✅ SMS sent to ${phoneNumber} (attempt ${attempt + 1})`);
      await logSMS(phoneNumber, message, "sent", null, response.data?.id);
      return true;
    } catch (error) {
      const errorMessage = error.response?.data?.message || error.message;
      console.error(`❌ Failed to send SMS to ${phoneNumber} (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
      if (attempt === maxRetries) {
        await logSMS(phoneNumber, message, "failed", errorMessage, null);
        return false;
      }
      // Exponential backoff: wait 2s, then 4s, then 8s between retries
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(2, attempt)));
    }
  }
  return false;
}

/**
 * Logs an SMS send attempt to the sms_logs table for audit trail.
 * Records phone number, message content, status (sent/failed), error message, and timestamp.
 * Failures to log are caught silently to prevent cascading errors.
 */
async function logSMS(phone, message, status, error, smsId = null) {
  try {
    await pool.query(
      `INSERT INTO sms_logs (recipient_phone, message, status, error_message, sms_id, sent_at) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [phone, message, status, error || null, smsId || null]
    );
  } catch (logErr) {
    console.error("Failed to log SMS:", logErr.message);
  }
}

// In-memory state tracking for alert deduplication and SMS muting
// lastAlertedState: Tracks the last alert status per sensor to avoid repeated alerts
// smsMuteUntil: ISO timestamp until which all SMS alerts are suppressed
let lastAlertedState = {};
let smsMuteUntil = null;

// =============================================================================
// API ROUTES
// =============================================================================

// ========================
// Health Check & Root
// ========================
// GET /health   - Returns server status and current time (used for monitoring)
// GET /         - Returns API identification message

/**
 * GET /health
 * Simple health check endpoint. Returns server status and current timestamp.
 * Used by monitoring tools and the frontend to verify the server is running.
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok", serverTime: new Date().toISOString() });
});

/**
 * GET /
 * Root endpoint. Returns API identification message.
 */
app.get("/", (req, res) => {
  res.json({ message: "CRAYvings Monitoring System API", status: "running" });
});

// ========================
// SENSOR DATA ENDPOINTS
// ========================

/**
 * POST /sensor
 * PRIMARY DATA INGESTION ENDPOINT - Called by the ESP32 device.
 *
 * Receives sensor readings (temperature, water_level, pH) from the ESP32,
 * stores them in the PostgreSQL sensors table, then responds immediately.
 * Threshold evaluation and SMS alerts run asynchronously in the background.
 *
 * Request body:
 *   - device_id (required): Identifier for the ESP32 device
 *   - temperature: Water temperature in Celsius (-1 if sensor failed)
 *   - water_level: Water level percentage (-1 if sensor failed)
 *   - ph: pH level of the water (-1 if sensor failed)
 *
 * Alert logic (runs in background via setImmediate):
 *   1. Fetches current threshold settings from sensor_settings table
 *   2. For each sensor (temp, pH, water_level), skips negative values (-1 = sensor failed)
 *   3. If value outside range, determines warning vs critical based on 15% deviation
 *   4. Checks cooldown period (2 minutes for both warning and critical)
 *   5. Checks if SMS alerts are muted (smsMuteUntil)
 *   6. Fetches active SMS recipients from authorized_recipients table
 *   7. Sends SMS to all recipients in parallel via Promise.allSettled
 *   8. Records alert in system_logs and last_alerts tables
 */
app.post("/sensor", async (req, res) => {
  try {
    const { device_id, temperature, water_level, ph } = req.body;
    if (!device_id) return res.status(400).json({ message: "device_id is required" });

    // Store sensor reading in the database
    const ts = new Date();
    const result = await pool.query(
      `INSERT INTO sensors (device_id, temperature, water_level, ph, timestamp) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [device_id, Number(temperature ?? 0), Number(water_level ?? 0), Number(ph ?? 0), ts]
    );
    console.log(`[${new Date().toISOString()}] Sensor data saved from ${device_id}`);

    // Respond immediately to ESP32 — process alerts in the background
    res.status(201).json({ message: "Saved", data: result.rows[0] });

    // Background: evaluate thresholds and send SMS alerts asynchronously
    setImmediate(async () => {
      try {
        const settingsResult = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
        const settings = settingsResult.rows[0] || { temp_min: 20, temp_max: 31, ph_min: 6.5, ph_max: 8.5, water_level_min: 10, water_level_max: 100 };

        const sensorChecks = [
          { key: "Temperature", val: Number(temperature), min: Number(settings.temp_min), max: Number(settings.temp_max) },
          { key: "pH Level", val: Number(ph), min: Number(settings.ph_min), max: Number(settings.ph_max) },
          { key: "Water Level", val: Number(water_level), min: Number(settings.water_level_min), max: Number(settings.water_level_max) },
        ];

        const nowTs = ts.getTime();
        const hourlyEnabled = SMS_CONFIG.hourly.enabled;
        if (hourlyEnabled && !global.lastHourlyUpdateTs) global.lastHourlyUpdateTs = nowTs;

        // Evaluate each sensor against its thresholds
        for (const sensor of sensorChecks) {
          // Skip invalid sensor readings (-1 means sensor failed on ESP32)
          if (sensor.val < 0) continue;
          const status = getThresholdStatus(sensor.val, sensor.min, sensor.max);
          const last = lastAlertedState[sensor.key] || {};
          const lastTs = last.timestamp ? new Date(last.timestamp).getTime() : 0;

          // If reading is back to normal, update state and skip alerting
          if (status === "good") {
            if (last.status && last.status !== "good") {
              await pool.query(
                `INSERT INTO last_alerts (sensor_key, status, value, timestamp) VALUES ($1, $2, $3, $4) ON CONFLICT (sensor_key) DO UPDATE SET status = $2, value = $3, timestamp = $4`,
                [sensor.key, "good", sensor.val, ts.toISOString()]
              );
              lastAlertedState[sensor.key] = { status: "good", value: sensor.val, timestamp: ts.toISOString() };
            }
            continue;
          }

          // Check cooldown period to prevent alert spam
          const interval = status === "critical" ? SMS_CONFIG.cooldown.critical : SMS_CONFIG.cooldown.warning;
          if (status === last.status && nowTs - lastTs < interval) continue;

          // Determine if the value is above or below threshold
          const direction = sensor.val < sensor.min ? "Low" : "High";

          // Log the alert to system_logs
          await pool.query(`INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)`,
            ["Alert", sensor.key, direction, sensor.val]);

          // Update last_alerts table (upsert: insert or update on conflict)
          await pool.query(
            `INSERT INTO last_alerts (sensor_key, status, value, timestamp) VALUES ($1, $2, $3, $4) ON CONFLICT (sensor_key) DO UPDATE SET status = $2, value = $3, timestamp = $4`,
            [sensor.key, status, sensor.val, ts.toISOString()]
          );
          lastAlertedState[sensor.key] = { status, value: sensor.val, timestamp: ts.toISOString() };

          // Check if SMS alerts are currently muted
          if (smsMuteUntil && new Date() < new Date(smsMuteUntil)) {
            console.log(`[${new Date().toISOString()}] SMS alerts muted until ${smsMuteUntil}, skipping SMS for ${sensor.key} ${status}`);
            continue;
          }

          // Fetch recipients and send SMS in parallel
          const recipients = await pool.query("SELECT phone_number, name FROM authorized_recipients WHERE is_active = true");
          if (recipients.rows.length > 0) {
            const isCritical = status === "critical";
            const template = isCritical ? SMS_CONFIG.messages.critical : SMS_CONFIG.messages.warning;
            const timestamp = ts.toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true });
            // Send all recipient SMS in parallel instead of one-by-one
            const smsPromises = recipients.rows.map(async (r) => {
              const message = buildMessage(template, {
                SENSOR: SMS_CONFIG.sensorNames[sensor.key] || sensor.key,
                NAME: r.name || "User", VALUE: sensor.val, UNIT: SMS_CONFIG.units[sensor.key] || "",
                THRESHOLD: direction === "Low" ? sensor.min : sensor.max, TIME: timestamp
              });
              return sendSingleSMS(r.phone_number, message);
            });
            await Promise.allSettled(smsPromises);
          }
        }

        // Check and send hourly SMS updates
        if (hourlyEnabled && nowTs - global.lastHourlyUpdateTs >= SMS_CONFIG.hourly.intervalMs) {
          global.lastHourlyUpdateTs = nowTs;

          // Check if SMS alerts are currently muted
          if (smsMuteUntil && new Date() < new Date(smsMuteUntil)) {
            console.log(`[${new Date().toISOString()}] SMS alerts muted until ${smsMuteUntil}, skipping hourly update`);
          } else {
            const hourlyRecipients = await pool.query("SELECT phone_number, name FROM authorized_recipients WHERE is_active = true");
            if (hourlyRecipients.rows.length > 0) {
              const tempStatus = getStatusText(getThresholdStatus(Number(temperature), Number(settings.temp_min), Number(settings.temp_max)));
              const phStatus = getStatusText(getThresholdStatus(Number(ph), Number(settings.ph_min), Number(settings.ph_max)));
              const waterStatus = getStatusText(getThresholdStatus(Number(water_level), Number(settings.water_level_min), Number(settings.water_level_max)));
              const hourlyTimestamp = ts.toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true });
              const summary = (tempStatus === "✅ Good" && phStatus === "✅ Good" && waterStatus === "✅ Good") ? "All systems normal" : "Some parameters need attention";
              const hourlyMessage = buildMessage(SMS_CONFIG.messages.hourlyUpdate, {
                TIME: hourlyTimestamp, TEMP: temperature ?? "N/A", TEMP_STATUS: tempStatus,
                PH: ph ?? "N/A", PH_STATUS: phStatus, WATER: water_level ?? "N/A", WATER_STATUS: waterStatus, SUMMARY: summary
              });
              const hourlyPromises = hourlyRecipients.rows.map(async (r) => sendSingleSMS(r.phone_number, hourlyMessage));
              await Promise.allSettled(hourlyPromises);
            }
          }
        }
      } catch (bgErr) {
        console.error(`[${new Date().toISOString()}] Background SMS processing error:`, bgErr.message);
      }
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error saving sensor:`, err.message);
    res.status(500).json({ message: "Error saving data", error: err.message });
  }
});

/**
 * GET /sensor
 * Returns sensor history (most recent readings first).
 * Query parameter: limit (default: 300, max: 1000, min: 1)
 * Used by the frontend to display historical trend charts.
 */
app.get("/sensor", async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 300));
    const result = await pool.query("SELECT * FROM sensors ORDER BY timestamp DESC LIMIT $1", [limit]);
    res.json(result.rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching sensors:`, err.message);
    res.status(500).json({ message: "Error fetching data", error: err.message });
  }
});

/**
 * GET /sensor/latest
 * Returns the most recent sensor reading.
 * Used by the frontend for real-time dashboard display.
 * Returns 404 if no data exists in the database.
 */
app.get("/sensor/latest", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sensors ORDER BY timestamp DESC LIMIT 1");
    if (result.rows.length === 0) return res.status(404).json({ message: "No sensor data found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching latest:`, err.message);
    res.status(500).json({ message: "Error", error: err.message });
  }
});

// ========================
// AUTHENTICATION ENDPOINTS
// ========================

/**
 * POST /auth/login
 * Authenticates a user with username and password.
 * On success, generates a new session token, stores it in the database,
 * and returns the user info + token to the client.
 * The client stores the token in localStorage for subsequent API requests.
 */
app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "Username and password required" });

    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if (result.rows.length === 0) return res.status(401).json({ message: "Invalid credentials" });

    const user = result.rows[0];
    if (!verifyPassword(password, user.password_hash)) return res.status(401).json({ message: "Invalid credentials" });

    // Generate a new session token and store it in the database
    const token = generateToken();
    await pool.query("UPDATE users SET token = $1 WHERE id = $2", [token, user.id]);

    res.json({
      message: "Login successful",
      user: { id: user.id, username: user.username, email: user.email, role: user.role, name: user.name },
      token
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Login error:`, err.message);
    res.status(500).json({ message: "Login failed", error: err.message });
  }
});

/**
 * GET /auth/users (Admin only)
 * Returns all users with their details (excluding password hashes and tokens).
 * Ordered by creation date (newest first).
 */
app.get("/auth/users", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, username, email, role, created_at FROM users ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: "Error fetching users", error: err.message });
  }
});

/**
 * POST /auth/users (Admin only)
 * Creates a new user account with hashed password.
 * Validates that all required fields are provided.
 * Returns 409 (Conflict) if username or email already exists (unique constraint).
 */
app.post("/auth/users", requireAdmin, async (req, res) => {
  try {
    const { name, username, email, password, role } = req.body;
    if (!name || !username || !email || !password) return res.status(400).json({ message: "All fields required" });

    const passwordHash = hashPassword(password);
    const result = await pool.query(
      `INSERT INTO users (name, username, email, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, username, email, role, created_at`,
      [name, username, email, passwordHash, role || "user"]
    );
    res.status(201).json({ message: "User created", data: result.rows[0] });
  } catch (err) {
    // PostgreSQL error code 23505 = unique constraint violation
    if (err.code === "23505") return res.status(409).json({ message: "Username or email already exists" });
    res.status(500).json({ message: "Error creating user", error: err.message });
  }
});

/**
 * DELETE /auth/users/:id (Admin only)
 * Deletes a user account by ID.
 * Returns 404 if the user doesn't exist.
 */
app.delete("/auth/users/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING username", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: "User not found" });
    res.json({ message: "User deleted" });
  } catch (err) {
    res.status(500).json({ message: "Error deleting user", error: err.message });
  }
});

/**
 * PUT /auth/users/:id/password (Admin only)
 * Resets a user's password.
 * The new password is hashed before storage.
 */
app.put("/auth/users/:id/password", requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ message: "New password required" });
    const passwordHash = hashPassword(newPassword);
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, req.params.id]);
    res.json({ message: "Password updated" });
  } catch (err) {
    res.status(500).json({ message: "Error updating password", error: err.message });
  }
});

// ========================
// SETTINGS ENDPOINTS
// ========================

/**
 * GET /settings
 * Returns the current sensor threshold settings.
 * If no settings exist in the database, returns default values.
 * This endpoint does NOT require authentication (public read access).
 */
app.get("/settings", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
    if (result.rows.length === 0) {
      return res.json({ temp_min: 20, temp_max: 31, ph_min: 6.5, ph_max: 8.5, water_level_min: 10, water_level_max: 100 });
    }
    // Convert PostgreSQL NUMERIC strings to JavaScript numbers for frontend compatibility
    const row = result.rows[0];
    res.json({
      id: Number(row.id),
      temp_min: Number(row.temp_min),
      temp_max: Number(row.temp_max),
      ph_min: Number(row.ph_min),
      ph_max: Number(row.ph_max),
      water_level_min: Number(row.water_level_min),
      water_level_max: Number(row.water_level_max),
      updated_at: row.updated_at,
    });
  } catch (err) {
    res.status(500).json({ message: "Error fetching settings", error: err.message });
  }
});

/**
 * POST /settings (Admin only)
 * Updates sensor threshold settings.
 * Detects if values have actually changed before writing to the database.
 * Creates a new row if no settings exist, otherwise updates the existing row.
 */
app.post("/settings", requireAdmin, async (req, res) => {
  try {
    const { temp_min, temp_max, ph_min, ph_max, water_level_min, water_level_max } = req.body;
    const existing = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
    let savedSettings;
    if (existing.rows.length > 0) {
      // Only update if values have actually changed
      const changes = getChangedFields(existing.rows[0], { temp_min, temp_max, ph_min, ph_max, water_level_min, water_level_max });
      if (Object.keys(changes).length === 0) return res.json({ message: "No change", changed: false, data: existing.rows[0] });
      const keys = Object.keys(changes);
      const values = Object.values(changes);
      const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
      const result = await pool.query(`UPDATE sensor_settings SET ${setClauses}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`, [...values, existing.rows[0].id]);
      savedSettings = result.rows[0];
    } else {
      const result = await pool.query(
        `INSERT INTO sensor_settings (temp_min, temp_max, ph_min, ph_max, water_level_min, water_level_max) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [temp_min, temp_max, ph_min, ph_max, water_level_min, water_level_max]
      );
      savedSettings = result.rows[0];
    }
    res.json({ message: "Settings saved", changed: true, data: savedSettings });
  } catch (err) {
    res.status(500).json({ message: "Error saving settings", error: err.message });
  }
});

/**
 * POST /settings/reset (Admin only)
 * Resets all sensor thresholds to factory default values.
 */
app.post("/settings/reset", requireAdmin, async (req, res) => {
  try {
    const defaults = { temp_min: 20, temp_max: 31, ph_min: 6.5, ph_max: 8.5, water_level_min: 10, water_level_max: 100 };
    const existing = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
    let savedSettings;
    if (existing.rows.length > 0) {
      const result = await pool.query(
        `UPDATE sensor_settings SET temp_min=$1, temp_max=$2, ph_min=$3, ph_max=$4, water_level_min=$5, water_level_max=$6, updated_at=NOW() WHERE id=$7 RETURNING *`,
        [defaults.temp_min, defaults.temp_max, defaults.ph_min, defaults.ph_max, defaults.water_level_min, defaults.water_level_max, existing.rows[0].id]
      );
      savedSettings = result.rows[0];
    } else {
      const result = await pool.query(
        `INSERT INTO sensor_settings (temp_min, temp_max, ph_min, ph_max, water_level_min, water_level_max) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [defaults.temp_min, defaults.temp_max, defaults.ph_min, defaults.ph_max, defaults.water_level_min, defaults.water_level_max]
      );
      savedSettings = result.rows[0];
    }
    res.json({ message: "Settings reset to defaults", data: savedSettings });
  } catch (err) {
    res.status(500).json({ message: "Error resetting settings", error: err.message });
  }
});

// ========================
// SMS RECIPIENT MANAGEMENT ENDPOINTS
// ========================

/**
 * GET /settings/recipients (Admin only)
 * Returns all authorized SMS recipients with their status.
 */
app.get("/settings/recipients", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, phone_number, name, is_active, created_at FROM authorized_recipients ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch recipients" });
  }
});

/**
 * POST /settings/recipients (Admin only)
 * Adds a new SMS recipient.
 * Validates phone number format: must be +639XXXXXXXXX (Philippine format).
 * Returns 409 if the phone number already exists.
 */
app.post("/settings/recipients", requireAdmin, async (req, res) => {
  try {
    const { phone_number, name } = req.body;
    // Validate Philippine phone number format
    if (!/^\+639\d{9}$/.test(phone_number)) return res.status(400).json({ error: "Invalid format: +639XXXXXXXXX" });
    const existing = await pool.query("SELECT * FROM authorized_recipients WHERE phone_number = $1", [phone_number]);
    if (existing.rows.length > 0) return res.status(409).json({ error: "Phone number already exists" });
    const result = await pool.query("INSERT INTO authorized_recipients (phone_number, name) VALUES ($1, $2) RETURNING *", [phone_number, name || "Recipient"]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Failed to add recipient" });
  }
});

/**
 * PUT /settings/recipients/:id (Admin only)
 * Updates a recipient's name or active status.
 * Uses updateOnlyIfChanged to avoid unnecessary database writes.
 */
app.put("/settings/recipients/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await pool.query("SELECT * FROM authorized_recipients WHERE id = $1", [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "Not found" });
    const updates = { name: req.body.name, is_active: req.body.is_active };
    const result = await updateOnlyIfChanged(pool, { table: "authorized_recipients", keyColumn: "id", keyValue: id, currentRow: existing.rows[0], updates: Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined)), touchUpdatedAt: true });
    res.json(result.changed ? { success: true, data: result.row } : { success: true, message: "No change", data: existing.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Failed to update recipient" });
  }
});

/**
 * DELETE /settings/recipients/:id (Admin only)
 * Removes an SMS recipient from the system.
 */
app.delete("/settings/recipients/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM authorized_recipients WHERE id = $1 RETURNING id", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete recipient" });
  }
});

/**
 * POST /settings/recipients/test/:id (Admin only)
 * Sends a test SMS to a recipient with current live sensor readings.
 * Used to verify that a phone number is correct and SMS delivery is working.
 * Includes all three sensor values with their current threshold status.
 */
app.post("/settings/recipients/test/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT phone_number, name FROM authorized_recipients WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    const { phone_number, name } = result.rows[0];

    // Fetch current settings and latest sensor reading to build the test message
    const settingsResult = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
    const settings = settingsResult.rows[0] || { temp_min: 20, temp_max: 31, ph_min: 6.5, ph_max: 8.5, water_level_min: 10, water_level_max: 100 };
    const sensorResult = await pool.query("SELECT * FROM sensors ORDER BY timestamp DESC LIMIT 1");
    const sensor = sensorResult.rows[0] || null;

    const temp = sensor?.temperature ?? "N/A";
    const ph = sensor?.ph ?? "N/A";
    const water = sensor?.water_level ?? "N/A";
    const tempStatus = sensor ? getStatusText(getThresholdStatus(Number(sensor.temperature), Number(settings.temp_min), Number(settings.temp_max))) : "N/A";
    const phStatus = sensor ? getStatusText(getThresholdStatus(Number(sensor.ph), Number(settings.ph_min), Number(settings.ph_max))) : "N/A";
    const waterStatus = sensor ? getStatusText(getThresholdStatus(Number(sensor.water_level), Number(settings.water_level_min), Number(settings.water_level_max))) : "N/A";
    const timestamp = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true });
    const summary = (tempStatus === "✅ Good" && phStatus === "✅ Good" && waterStatus === "✅ Good") ? "All systems normal" : "Some parameters need attention";
    const testMessage = `📊 CRAYVINGS LIVE READINGS (TEST)\nTime: ${timestamp}\nTemperature: ${temp}°C (${tempStatus})\npH Level: ${ph} (${phStatus})\nWater Level: ${water}% (${waterStatus})\n${summary}\n(This is a test message)`;

    await sendSingleSMS(phone_number, testMessage);
    res.json({ success: true, message: "Test SMS sent" });
  } catch (err) {
    res.status(500).json({ error: "Failed to send test SMS" });
  }
});

// ========================
// SYSTEM LOGS ENDPOINTS
// ========================

/**
 * POST /logs
 * Creates a new system log entry.
 * Used internally to record sensor alerts, setting changes, and system events.
 * Requires action and parameter; old_value and new_value are optional.
 */
app.post("/logs", async (req, res) => {
  try {
    const { action, parameter, old_value, new_value } = req.body;
    if (!action || !parameter) return res.status(400).json({ message: "action and parameter required" });
    const result = await pool.query(
      "INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4) RETURNING *",
      [action, parameter, String(old_value ?? ""), String(new_value ?? "")]
    );
    res.status(201).json({ message: "Logged", data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Error logging", error: err.message });
  }
});

/**
 * GET /system-logs
 * Returns paginated system log entries.
 * Query parameters: page (default: 1), limit (default: 20, max: 100)
 * Returns: { data: [], total: number, page: number, limit: number }
 */
app.get("/system-logs", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const result = await pool.query("SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT $1 OFFSET $2", [limit, offset]);
    const countResult = await pool.query("SELECT COUNT(*) FROM system_logs");
    res.json({ data: result.rows, total: parseInt(countResult.rows[0].count), page, limit });
  } catch (err) {
    res.status(500).json({ message: "Error fetching logs", error: err.message });
  }
});

// ========================
// ALERT MANAGEMENT ENDPOINTS
// ========================

/**
 * POST /alert/device-disconnect
 * Called when the ESP32 device goes offline.
 * Sends SMS alerts to all active recipients about the disconnection.
 * Respects the SMS mute setting (smsMuteUntil).
 * Logs the event to system_logs.
 */
app.post('/alert/device-disconnect', async (req, res) => {
  try {
    const { event_type, description, consecutive_failures } = req.body;
    const recipients = await pool.query('SELECT phone_number, name FROM authorized_recipients WHERE is_active = true');
    if (recipients.rows.length === 0) return res.status(200).json({ message: 'No active recipients', sent: 0 });

    // Check if SMS alerts are currently muted
    if (smsMuteUntil && new Date() < new Date(smsMuteUntil)) {
      console.log('[' + new Date().toISOString() + '] SMS alerts muted until ' + smsMuteUntil + ', skipping disconnect alert');
      await pool.query('INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)', ['Device Disconnect Muted', 'ESP32', String(consecutive_failures || 0), 'Muted until ' + smsMuteUntil]);
      return res.json({ message: 'SMS alerts muted', sent: 0, total: recipients.rows.length, muted: true, muteExpires: smsMuteUntil });
    }

    const timestamp = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
    const message = 'CRAYVINGS DEVICE ALERT\nESP32 device disconnected\n' + (description || 'No data received for 15+ seconds') + '\nFailed polls: ' + (consecutive_failures || 0) + '\nTime: ' + timestamp;

    let sent = 0;
    for (const r of recipients.rows) {
      const success = await sendSingleSMS(r.phone_number, message);
      if (success) sent++;
    }

    await pool.query('INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)', ['Device Disconnect', 'ESP32', String(consecutive_failures || 0), description || '']);
    res.json({ message: 'Disconnect alerts sent', sent, total: recipients.rows.length });
  } catch (err) {
    console.error('[' + new Date().toISOString() + '] Error sending disconnect alert:', err.message);
    res.status(500).json({ message: 'Error sending disconnect alert', error: err.message });
  }
});

/**
 * POST /alert/mute
 * Mutes or unmutes SMS alerts for a specified number of hours.
 * Setting hours to null, 0, or negative unmutes alerts immediately.
 * The mute state is stored in memory (smsMuteUntil variable).
 * NOTE: Mute state is lost on server restart (not persisted to database).
 */
app.post('/alert/mute', async (req, res) => {
  try {
    const { hours } = req.body;
    if (!hours || typeof hours !== 'number' || hours <= 0) {
      smsMuteUntil = null;
      console.log('[' + new Date().toISOString() + '] SMS alerts unmuted');
      return res.json({ message: 'SMS alerts unmuted', muted: false, muteExpires: null });
    }

    smsMuteUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    console.log('[' + new Date().toISOString() + '] SMS alerts muted for ' + hours + ' hours until ' + smsMuteUntil);

    await pool.query('INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)', ['SMS Muted', 'Alerts', String(hours) + 'h', 'Until ' + smsMuteUntil]);
    res.json({ message: 'SMS alerts muted for ' + hours + ' hours', muted: true, muteExpires: smsMuteUntil });
  } catch (err) {
    console.error('[' + new Date().toISOString() + '] Error setting mute:', err.message);
    res.status(500).json({ message: 'Error setting mute', error: err.message });
  }
});

/**
 * GET /alert/mute-status
 * Returns whether SMS alerts are currently muted and when the mute expires.
 * Automatically clears expired mute states.
 */
app.get('/alert/mute-status', async (req, res) => {
  try {
    if (smsMuteUntil && new Date() < new Date(smsMuteUntil)) {
      return res.json({ muted: true, muteExpires: smsMuteUntil });
    }
    // Clear expired mute state
    if (smsMuteUntil && new Date() >= new Date(smsMuteUntil)) {
      smsMuteUntil = null;
    }
    res.json({ muted: false, muteExpires: null });
  } catch (err) {
    res.status(500).json({ message: 'Error checking mute status', error: err.message });
  }
});

// ========================
// ACTIVITY LOGS ENDPOINTS
// ========================

/**
 * POST /activity-logs
 * Records a user activity event (navigation, settings change, login, etc.).
 * Used for audit trail and activity monitoring.
 * Requires action_type; other fields are optional.
 */
app.post("/activity-logs", async (req, res) => {
  try {
    const { user_name, action_type, description, module } = req.body;
    if (!action_type) return res.status(400).json({ message: "action_type required" });
    const result = await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, $2, $3, $4) RETURNING *",
      [user_name || "Admin", action_type, description || "", module || ""]
    );
    res.status(201).json({ message: "Logged", data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Error logging activity", error: err.message });
  }
});

/**
 * GET /activity-logs
 * Returns paginated, searchable, filterable activity logs.
 * Query parameters:
 *   - page: Page number (default: 1)
 *   - search: Search in description or user_name (case-insensitive ILIKE)
 *   - sortBy: "newest" or "oldest" (default: "newest")
 *   - actionType: Filter by specific action type
 * Returns: { data: [], total, page, limit, totalPages }
 */
app.get("/activity-logs", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || "";
    const sortBy = req.query.sortBy === "oldest" ? "ASC" : "DESC";
    const actionType = req.query.actionType || "";

    // Build dynamic WHERE clause for search and filter
    let where = [];
    let params = [];
    let paramCount = 1;
    if (search) { where.push(`(description ILIKE $${paramCount} OR user_name ILIKE $${paramCount})`); params.push(`%${search}%`); paramCount++; }
    if (actionType) { where.push(`action_type = $${paramCount}`); params.push(actionType); paramCount++; }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT * FROM activity_logs ${whereClause} ORDER BY timestamp ${sortBy} LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      [...params, limit, offset]
    );
    const countResult = await pool.query(`SELECT COUNT(*) FROM activity_logs ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);
    res.json({ data: result.rows, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: "Error fetching activity logs", error: err.message });
  }
});

// =============================================================================
// SERVER STARTUP
// =============================================================================
// This function runs when the server starts and performs initialization:
//   1. Tests the PostgreSQL connection
//   2. Creates a default admin account if one doesn't exist
//      (username: "admin", password: "Admin@123")
//   3. Loads the last alert states from the database to restore
//      alert deduplication state after server restart
//   4. Checks if SkySMS API key is configured
//   5. Starts the Express HTTP server on the configured port
//   6. Sets up global error handlers for uncaught exceptions and rejections

/**
 * Initializes the server: connects to PostgreSQL, creates default admin if needed,
 * restores alert state from database, and starts the HTTP listener.
 */
async function startServer() {
  try {
    const client = await pool.connect();
    try {
      console.log(`[${new Date().toISOString()}] PostgreSQL connected`);

      // Create default admin account if it doesn't exist
      const adminExists = await client.query("SELECT id, password_hash FROM users WHERE username = $1", ["admin"]);
      if (adminExists.rows.length === 0) {
        const adminPassword = hashPassword("Admin@123");
        await client.query(
          `INSERT INTO users (name, username, email, password_hash, role) VALUES ('Administrator', 'admin', 'admin@crayvings.com', $1, 'admin')`,
          [adminPassword]
        );
        console.log(`[${new Date().toISOString()}] Default admin account created (admin / Admin@123)`);
      } else {
        const storedHash = adminExists.rows[0].password_hash;
        if (verifyPassword("Admin@123", storedHash)) {
          console.log(`[${new Date().toISOString()}] Admin account verified`);
        } else {
          console.log(`[${new Date().toISOString()}] Admin account exists with custom password`);
        }
      }

      // Restore alert state from database (persists across server restarts)
      const lastAlertsResult = await client.query("SELECT * FROM last_alerts");
      lastAlertedState = {};
      for (const row of lastAlertsResult.rows) {
        lastAlertedState[row.sensor_key] = { status: row.status, value: parseFloat(row.value), timestamp: row.timestamp?.toISOString() };
      }
      console.log(`[${new Date().toISOString()}] Loaded ${lastAlertsResult.rows.length} alert states from DB`);

      // Verify SMS configuration
      if (!process.env.SKYSMS_API_KEY) {
        console.warn(`[${new Date().toISOString()}] WARNING: SKYSMS_API_KEY not set. SMS alerts will fail.`);
      } else {
        console.log(`[${new Date().toISOString()}] SkySMS configured`);
      }
    } finally {
      client.release();
    }

    // Start listening for HTTP requests on all network interfaces
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[${new Date().toISOString()}] Server running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Server startup error:`, err.message);
    process.exit(1);
  }
}

// Start the server
startServer();

// =============================================================================
// GLOBAL ERROR HANDLERS
// =============================================================================
// These handlers catch errors that escape try/catch blocks to prevent
// the server from crashing silently.

/**
 * Catches unhandled Promise rejections and logs them.
 * This prevents the server from crashing on async errors that weren't caught.
 */
process.on("unhandledRejection", (reason) => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection:`, reason);
});

/**
 * Catches uncaught synchronous exceptions.
 * Logs the error and exits the process to allow process managers
 * (like PM2 or systemd) to restart the server cleanly.
 */
process.on("uncaughtException", (err) => {
  console.error(`[${new Date().toISOString()}] Uncaught exception:`, err.message);
  process.exit(1);
});
