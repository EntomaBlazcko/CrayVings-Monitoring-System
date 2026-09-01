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
const rateLimit = require("express-rate-limit");
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

// Enable CORS so the Vite/React frontend (dev server) can call this API.
// Origins are restricted to the allowlist in ALLOWED_ORIGINS (comma-separated).
// Requests without an Origin header (e.g. the ESP32's HTTP client, curl) are allowed.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
  })
);
// Parse incoming JSON request bodies. A small body-size limit prevents
// oversized-payload memory abuse (the ESP32 payloads are a few hundred bytes).
app.use(express.json({ limit: "10kb" }));

// =============================================================================
// RATE LIMITING
// =============================================================================
// A global per-IP limiter curbs endpoint abuse (brute force, scraping, DoS).
// The ESP32's fast 1s sensor polling is exempted — that path is separately
// guarded by DEVICE_SECRET, and any device can legitimately burst bursts.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute window
  limit: 300,                 // 300 requests / minute / IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req) => req.path === "/sensor" && req.method === "POST",
  validate: { xForwardedForHeader: false }, // only trust req.ip (no proxy deps)
});

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,   // 10 minutes
  limit: 10,                  // 10 login attempts / 10 min / IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again later." },
  validate: { xForwardedForHeader: false },
});

app.use(globalLimiter);

// =============================================================================
// PASSWORD HASHING UTILITIES
// =============================================================================
// Uses PBKDF2 with SHA-512 and a random 16-byte salt for secure password storage.
// The stored format for new hashes is: "iterations:salt:hash" (iterations int,
// the rest hex). Legacy hashes stored as "salt:hash" (no iteration prefix) are
// verified at the old 10000-iteration count and transparently re-hashed with the
// stronger PBKDF2_ITERATIONS on the next successful login, so raising the cost
// never locks existing users out.
const PBKDF2_ITERATIONS = 600000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = "sha512";

function parseStoredHash(stored) {
  const parts = stored.split(":");
  if (parts.length === 3) {
    return { iterations: parseInt(parts[0], 10), salt: parts[1], hash: parts[2] };
  }
  // Legacy "salt:hash" — verify against the old default iteration count.
  return { iterations: 10000, salt: parts[0], hash: parts[1] };
}

/**
 * Hashes a plaintext password with a fresh random salt at PBKDF2_ITERATIONS.
 * @param {string} password - The plaintext password to hash
 * @returns {string} Combined "iterations:salt:hash" string
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return `${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

/**
 * Verifies a plaintext password against a stored hash (new or legacy format).
 * @param {string} password - The plaintext password to verify
 * @param {string} stored - The stored hash string
 * @returns {boolean} True if the password matches
 */
function verifyPassword(password, stored) {
  const { iterations, salt, hash } = parseStoredHash(stored);
  const verifyHash = crypto.pbkdf2Sync(password, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  const expected = Buffer.from(hash, "hex");
  const actual = Buffer.from(verifyHash, "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Returns true if a stored hash uses the legacy format or an iteration count
 * lower than the current PBKDF2_ITERATIONS (i.e. it should be re-hashed).
 * @param {string} stored - The stored hash string
 * @returns {boolean} True if the hash needs upgrading
 */
function needsRehash(stored) {
  const parts = stored.split(":");
  if (parts.length !== 3) return true;
  return parseInt(parts[0], 10) !== PBKDF2_ITERATIONS;
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
    .then(async result => {
      if (result.rows.length === 0) return res.status(403).json({ message: "Invalid token" });
      const user = result.rows[0];
      if (user.role !== "admin") return res.status(403).json({ message: "Admin access required" });
      if (user.token_expires_at && new Date(user.token_expires_at) <= new Date()) {
        await pool.query("UPDATE users SET token = NULL, token_expires_at = NULL WHERE id = $1", [user.id]);
        return res.status(401).json({ message: "Session expired, please log in again" });
      }
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
    .then(async result => {
      if (result.rows.length === 0) return res.status(403).json({ message: "Invalid token" });
      const user = result.rows[0];
      if (user.token_expires_at && new Date(user.token_expires_at) <= new Date()) {
        await pool.query("UPDATE users SET token = NULL, token_expires_at = NULL WHERE id = $1", [user.id]);
        return res.status(401).json({ message: "Session expired, please log in again" });
      }
      req.user = user;
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
// INPUT VALIDATION SCHEMAS (Zod)
// =============================================================================
// Server-side validation for incoming request bodies. The ESP32 sends -1 (and
// 0 for temperature) to mark a failed sensor, so the sensor schema's lower
// bounds must accept those sentinel values.

/**
 * Schema for POST /sensor (ESP32 ingestion).
 * Failed-sensor sentinels (-1, 0 for temperature) are allowed and filtered
 * out later during threshold evaluation.
 */
const sensorSchema = z.object({
  device_id: z.string().min(1).max(50),
  temperature: z.coerce.number().min(-10).max(50),
  water_level: z.coerce.number().min(-1).max(100),
  // ammonia is now a real NH3 gas reading in ppm (MQ-137). Upper bound covers
  // the full datasheet range (5-500 ppm); -1 is the failed-sensor sentinel.
  ammonia: z.coerce.number().min(-1).max(500).optional(),
});

/**
 * Schema for POST /settings (threshold configuration).
 * Accepts partial updates; each pair is validated so min < max.
 */
const settingsFieldSchema = z.object({
  temp_min: z.coerce.number().min(-10).max(50),
  temp_max: z.coerce.number().min(-10).max(50),
  water_level_min: z.coerce.number().min(0).max(100),
  water_level_max: z.coerce.number().min(0).max(100),
  ammonia_min: z.coerce.number().min(0).max(500),
  ammonia_max: z.coerce.number().min(0).max(500),
}).partial();

/**
 * Validates a settings payload and returns parsed values.
 * Throws a ZodError for field/range violations or an Error with
 * statusCode 400 for min >= max pairs.
 */
function parseSettingsInput(body) {
  const parsed = settingsFieldSchema.parse(body);
  const pairChecks = [
    { label: "Temperature", min: parsed.temp_min, max: parsed.temp_max },
    { label: "Water Level", min: parsed.water_level_min, max: parsed.water_level_max },
    { label: "Ammonia", min: parsed.ammonia_min, max: parsed.ammonia_max },
  ];
  for (const pair of pairChecks) {
    if (pair.min !== undefined && pair.max !== undefined && pair.min >= pair.max) {
      const err = new Error(`${pair.label} min must be less than max`);
      err.statusCode = 400;
      throw err;
    }
  }
  return parsed;
}

/** Converts a ZodError into a readable field-errors object. */
function zodFieldErrors(err) {
  const flat = err.flatten();
  return flat.fieldErrors || {};
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
// Optional shared secret that the ESP32 must present (X-Device-Secret header)
// when ingesting sensor data. When set, POST /sensor rejects requests without a
// matching secret. When unset (local dev), ingestion is allowed but a warning is
// logged. Set DEVICE_SECRET in production to prevent forged readings.
const DEVICE_SECRET = process.env.DEVICE_SECRET;
let deviceSecretWarned = false;

// SMS configuration object: templates, sensor name mappings, units, cooldowns
const SMS_CONFIG = {
  messages: {
    // Warning template: sent when a reading is slightly outside the safe range
    warning: "⚠️ {{SENSOR}} WARNING\nRecipient: {{NAME}}\nReading: {{VALUE}}{{UNIT}}\nThreshold: {{THRESHOLD}}{{UNIT}}\nTime: {{TIME}}\nStatus: Warning",
    // Critical template: sent when a reading is dangerously outside the safe range
    critical: "🚨 {{SENSOR}} CRITICAL ALERT\nRecipient: {{NAME}}\nReading: {{VALUE}}{{UNIT}}\nThreshold: {{THRESHOLD}}{{UNIT}}\nTime: {{TIME}}\nStatus: CRITICAL",
    // Hourly update template: periodic summary of all sensor statuses
    hourlyUpdate: "📊 CRAYVINGS HOURLY UPDATE\nTime: {{TIME}}\nTemperature: {{TEMP}}°C ({{TEMP_STATUS}})\nWater Level: {{WATER}}% ({{WATER_STATUS}})\nAmmonia: {{AMMONIA}} ppm ({{AMMONIA_STATUS}})\n{{SUMMARY}}"
  },
  // Maps display names to SMS-friendly uppercase names
  sensorNames: { "Temperature": "TEMPERATURE", "Water Level": "WATER LEVEL", "Ammonia": "AMMONIA" },
  // Units for each sensor type in SMS messages
  units: { "Temperature": "°C", "Water Level": "%", "Ammonia": " ppm" },
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
      const statusCode = error.response?.status;
      console.error(`❌ Failed to send SMS to ${phoneNumber} (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
      
      // Don't retry on 403 (invalid key/no credits) or 400 (bad request)
      if (statusCode === 403 || statusCode === 400) {
        console.error(`❌ SMS failed with status ${statusCode} - not retrying (check API key/credits)`);
        await logSMS(phoneNumber, message, "failed", `Status ${statusCode}: ${errorMessage}`, null);
        return false;
      }
      
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
// Tracks the last device-disconnect SMS to prevent spam when the connection flaps
let lastDisconnectSmsTs = 0;

// Hourly SMS timestamp - loaded from DB on startup, persisted on each send
let lastHourlyUpdateTs = null;

// Initialize hourly update timestamp from database on server start
(async () => {
  try {
    // Create system_state table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_state (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT
      )
    `);
    const result = await pool.query("SELECT value FROM system_state WHERE key = 'last_hourly_update_ts'");
    if (result.rows.length > 0 && result.rows[0].value) {
      lastHourlyUpdateTs = new Date(result.rows[0].value).getTime();
      console.log(`[${new Date().toISOString()}] Loaded lastHourlyUpdateTs from DB: ${new Date(lastHourlyUpdateTs).toISOString()}`);
    }

    // Restore SMS mute state from the database (survives server restarts)
    const muteResult = await pool.query("SELECT value FROM system_state WHERE key = 'sms_mute_until'");
    if (muteResult.rows.length > 0 && muteResult.rows[0].value) {
      const storedMute = new Date(muteResult.rows[0].value);
      if (storedMute > new Date()) {
        smsMuteUntil = storedMute.toISOString();
        console.log(`[${new Date().toISOString()}] Restored SMS mute until ${smsMuteUntil}`);
      } else {
        await pool.query("DELETE FROM system_state WHERE key = 'sms_mute_until'");
        console.log(`[${new Date().toISOString()}] Cleared expired SMS mute from DB`);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error initializing system_state:`, err.message);
  }
})();

// =============================================================================
// DATABASE OPTIMIZATION & CLEANUP
// =============================================================================
// Create indexes on large tables for better query performance
(async () => {
  try {
    // Migrations: ensure ammonia columns exist (added after pH was removed).
    // Ammonia is a real NH3 gas reading in ppm (MQ-137): default threshold range
    // is 0-25 ppm (ACGIH 8h TWA for ammonia).
    await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS ammonia DECIMAL(5,3) DEFAULT 0`);
    await pool.query(`ALTER TABLE sensor_settings ADD COLUMN IF NOT EXISTS ammonia_min DECIMAL(5,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE sensor_settings ADD COLUMN IF NOT EXISTS ammonia_max DECIMAL(5,2) DEFAULT 25.00`);
    // Rebase pre-existing threshold rows that still carry the old 0-1.0 value
    // default so they match the new ppm scale. Custom values (not 1.0) are left
    // untouched.
    await pool.query(`UPDATE sensor_settings SET ammonia_max = 25.00 WHERE ammonia_max = 1.00`);

    // Migrations: session token expiry (24-hour expiration).
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP`);

    // Indexes for system_logs (faster pagination and counting)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON system_logs (timestamp DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_action ON system_logs (action)`);
    
    // Indexes for sms_logs (faster auditing)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sms_logs_sent_at ON sms_logs (sent_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sms_logs_status ON sms_logs (status)`);
    
    // Indexes for sensors (faster latest/history queries)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sensors_timestamp ON sensors (timestamp DESC)`);
    
    console.log(`[${new Date().toISOString()}] Database indexes verified/created`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating indexes:`, err.message);
  }
})();

// Auto-cleanup: keep only last 30 days of logs and sensor readings (run on startup and daily)
const LOGS_RETENTION_DAYS = 30;
async function cleanupOldData() {
  try {
    const result = await pool.query(
      `DELETE FROM system_logs WHERE timestamp < NOW() - INTERVAL '${LOGS_RETENTION_DAYS} days' RETURNING id`
    );
    if (result.rowCount > 0) {
      console.log(`[${new Date().toISOString()}] Cleaned up ${result.rowCount} old system_logs entries`);
    }
    
    const smsResult = await pool.query(
      `DELETE FROM sms_logs WHERE sent_at < NOW() - INTERVAL '${LOGS_RETENTION_DAYS} days' RETURNING id`
    );
    if (smsResult.rowCount > 0) {
      console.log(`[${new Date().toISOString()}] Cleaned up ${smsResult.rowCount} old sms_logs entries`);
    }

    // The ESP32 posts ~1 reading/second, so the sensors table grows fast.
    // Prune readings older than the retention window to keep queries fast.
    const sensorResult = await pool.query(
      `DELETE FROM sensors WHERE timestamp < NOW() - INTERVAL '${LOGS_RETENTION_DAYS} days' RETURNING id`
    );
    if (sensorResult.rowCount > 0) {
      console.log(`[${new Date().toISOString()}] Cleaned up ${sensorResult.rowCount} old sensor readings`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error cleaning up logs:`, err.message);
  }
}

// Run cleanup on startup, then daily
cleanupOldData();
setInterval(cleanupOldData, 24 * 60 * 60 * 1000);

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
 * Receives sensor readings (temperature, water_level) from the ESP32,
 * stores them in the PostgreSQL sensors table, then responds immediately.
 * Threshold evaluation and SMS alerts run asynchronously in the background.
 *
 * Request body:
 *   - device_id (required): Identifier for the ESP32 device
 *   - temperature: Water temperature in Celsius (-1 if sensor failed)
 *   - water_level: Water level percentage (-1 if sensor failed)
 *   - ammonia: Ammonia gas concentration in ppm (-1 if sensor failed)
 *
 * Alert logic (runs in background via setImmediate):
 *   1. Fetches current threshold settings from sensor_settings table
 *   2. For each sensor (temp, water_level, ammonia), skips negative values (-1 = sensor failed)
 *   3. If value outside range, determines warning vs critical based on 15% deviation
 *   4. Checks cooldown period (2 minutes for both warning and critical)
 *   5. Checks if SMS alerts are muted (smsMuteUntil)
 *   6. Fetches active SMS recipients from authorized_recipients table
 *   7. Sends SMS to all recipients in parallel via Promise.allSettled
 *   8. Records alert in system_logs and last_alerts tables
 */
app.post("/sensor", async (req, res) => {
  try {
    // Device authentication: if DEVICE_SECRET is configured, require a matching
    // X-Device-Secret header so only the real ESP32 can ingest readings.
    if (DEVICE_SECRET) {
      const presented = req.headers["x-device-secret"];
      if (!presented || presented !== DEVICE_SECRET) {
        return res.status(401).json({ message: "Invalid device secret" });
      }
    } else if (!deviceSecretWarned) {
      deviceSecretWarned = true;
      console.warn(`[${new Date().toISOString()}] DEVICE_SECRET not set - sensor ingestion is unauthenticated. Set DEVICE_SECRET in production.`);
    }
    const parsed = sensorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid sensor data", errors: zodFieldErrors(parsed.error) });
    }
    const { device_id, temperature, water_level, ammonia } = parsed.data;
    if (!device_id) return res.status(400).json({ message: "device_id is required" });

    // Store sensor reading in the database
    const ts = new Date();
    const result = await pool.query(
      `INSERT INTO sensors (device_id, temperature, water_level, ammonia, timestamp) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [device_id, Number(temperature ?? 0), Number(water_level ?? 0), Number(ammonia ?? 0), ts]
    );
    console.log(`[${new Date().toISOString()}] Sensor data saved from ${device_id}`);

    // Respond immediately to ESP32 — process alerts in the background
    res.status(201).json({ message: "Saved", data: result.rows[0] });

    // Background: evaluate thresholds and send SMS alerts asynchronously
    setImmediate(async () => {
      try {
        const settingsResult = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
const settings = settingsResult.rows[0] || { temp_min: 20, temp_max: 31, water_level_min: 10, water_level_max: 100, ammonia_min: 0, ammonia_max: 25 };

        const sensorChecks = [
          { key: "Temperature", val: Number(temperature), min: Number(settings.temp_min), max: Number(settings.temp_max), minValid: 0.0001 },
          { key: "Water Level", val: Number(water_level), min: Number(settings.water_level_min), max: Number(settings.water_level_max), minValid: 0 },
          { key: "Ammonia", val: Number(ammonia), min: Number(settings.ammonia_min), max: Number(settings.ammonia_max), minValid: 0 },
        ];

        const nowTs = ts.getTime();
        const hourlyEnabled = SMS_CONFIG.hourly.enabled;
        if (hourlyEnabled && !lastHourlyUpdateTs) lastHourlyUpdateTs = nowTs;

        // Evaluate each sensor against its thresholds
        for (const sensor of sensorChecks) {
          // Skip invalid sensor readings: the ESP32 sends -1 when a sensor fails,
          // and 0 for temperature must also be treated as a failure (a 0°C reading
          // is outside the valid range the firmware reports).
          if (sensor.val < sensor.minValid) continue;
          const status = getThresholdStatus(sensor.val, sensor.min, sensor.max);
          const last = lastAlertedState[`${device_id}:${sensor.key}`] || {};
          const lastTs = last.timestamp ? new Date(last.timestamp).getTime() : 0;

          // If reading is back to normal, update state, log resolution, and skip alerting
          if (status === "good") {
            if (last.status && last.status !== "good") {
              await pool.query(
                `INSERT INTO last_alerts (device_id, sensor_key, status, value, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (device_id, sensor_key) DO UPDATE SET status = $3, value = $4, timestamp = $5`,
                [device_id, sensor.key, "good", sensor.val, ts.toISOString()]
              );
              lastAlertedState[`${device_id}:${sensor.key}`] = { status: "good", value: sensor.val, timestamp: ts.toISOString() };
              // Log "Alert Resolved" to system_logs
              await pool.query(`INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)`,
                ["Alert Resolved", sensor.key, last.status, "good"]);
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
            `INSERT INTO last_alerts (device_id, sensor_key, status, value, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (device_id, sensor_key) DO UPDATE SET status = $3, value = $4, timestamp = $5`,
            [device_id, sensor.key, status, sensor.val, ts.toISOString()]
          );
          lastAlertedState[`${device_id}:${sensor.key}`] = { status, value: sensor.val, timestamp: ts.toISOString() };

          // Check if SMS alerts are currently muted
          if (smsMuteUntil && new Date() < new Date(smsMuteUntil)) {
            console.log(`[${new Date().toISOString()}] SMS alerts muted until ${smsMuteUntil}, skipping SMS for ${sensor.key} ${status}`);
            // Log muted SMS to sms_logs for audit trail
            const recipients = await pool.query("SELECT phone_number FROM authorized_recipients WHERE is_active = true");
            const isCritical = status === "critical";
            const template = isCritical ? SMS_CONFIG.messages.critical : SMS_CONFIG.messages.warning;
            const timestamp = ts.toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true });
            const direction = sensor.val < sensor.min ? "Low" : "High";
            for (const r of recipients.rows) {
              const message = buildMessage(template, {
                SENSOR: SMS_CONFIG.sensorNames[sensor.key] || sensor.key,
                NAME: r.name || "User", VALUE: sensor.val, UNIT: SMS_CONFIG.units[sensor.key] || "",
                THRESHOLD: direction === "Low" ? sensor.min : sensor.max, TIME: timestamp
              });
              await logSMS(r.phone_number, message, "muted", `SMS muted until ${smsMuteUntil}`, null);
            }
            // Log to system_logs
            await pool.query(`INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)`,
              ["Alert Muted", sensor.key, status, `Muted until ${smsMuteUntil}`]);
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
        if (hourlyEnabled && nowTs - lastHourlyUpdateTs >= SMS_CONFIG.hourly.intervalMs) {
          lastHourlyUpdateTs = nowTs;
          // Persist to DB
          await pool.query(`INSERT INTO system_state (key, value) VALUES ('last_hourly_update_ts', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
            [new Date(nowTs).toISOString()]);

          // Check if SMS alerts are currently muted
          if (smsMuteUntil && new Date() < new Date(smsMuteUntil)) {
            console.log(`[${new Date().toISOString()}] SMS alerts muted until ${smsMuteUntil}, skipping hourly update`);
            // Log muted hourly SMS to sms_logs
            const hourlyRecipients = await pool.query("SELECT phone_number, name FROM authorized_recipients WHERE is_active = true");
            if (hourlyRecipients.rows.length > 0) {
              const hourlyMessage = buildMessage(SMS_CONFIG.messages.hourlyUpdate, {
                TIME: ts.toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true }),
                TEMP: temperature ?? "N/A", TEMP_STATUS: "N/A",
                WATER: water_level ?? "N/A", WATER_STATUS: "N/A",
                AMMONIA: ammonia ?? "N/A", AMMONIA_STATUS: "N/A", SUMMARY: "SMS muted"
              });
              for (const r of hourlyRecipients.rows) {
                await logSMS(r.phone_number, hourlyMessage, "muted", `SMS muted until ${smsMuteUntil}`, null);
              }
              await pool.query(`INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)`,
                ["Hourly Update Muted", "SMS", "hourly", `Muted until ${smsMuteUntil}`]);
            }
          } else {
            const hourlyRecipients = await pool.query("SELECT phone_number, name FROM authorized_recipients WHERE is_active = true");
            if (hourlyRecipients.rows.length > 0) {
              const tempVal = Number(temperature);
              const waterVal = Number(water_level);
              const ammoniaVal = Number(ammonia);
              const tempOK = Number.isFinite(tempVal) && tempVal > 0;
              const waterOK = Number.isFinite(waterVal) && waterVal >= 0;
              const ammoniaOK = Number.isFinite(ammoniaVal) && ammoniaVal >= 0;
              const tempStatus = tempOK ? getStatusText(getThresholdStatus(tempVal, Number(settings.temp_min), Number(settings.temp_max))) : "N/A (sensor offline)";
              const waterStatus = waterOK ? getStatusText(getThresholdStatus(waterVal, Number(settings.water_level_min), Number(settings.water_level_max))) : "N/A (sensor offline)";
              const ammoniaStatus = ammoniaOK ? getStatusText(getThresholdStatus(ammoniaVal, Number(settings.ammonia_min), Number(settings.ammonia_max))) : "N/A (sensor offline)";
              const hourlyTimestamp = ts.toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true });
              const summary = (tempStatus === "✅ Good" && waterStatus === "✅ Good" && ammoniaStatus === "✅ Good") ? "All systems normal" : "Some parameters need attention";
              const hourlyMessage = buildMessage(SMS_CONFIG.messages.hourlyUpdate, {
                TIME: hourlyTimestamp, TEMP: tempOK ? temperature : "N/A", TEMP_STATUS: tempStatus,
                WATER: waterOK ? water_level : "N/A", WATER_STATUS: waterStatus,
                AMMONIA: ammoniaOK ? ammonia : "N/A", AMMONIA_STATUS: ammoniaStatus, SUMMARY: summary
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
// WEEKLY REPORT ENDPOINT
// ========================

/**
 * GET /report/weekly
 * Returns aggregated sensor data for the past 7 days for the weekly report.
 * Returns:
 *   - period: { start, end } ISO timestamps
 *   - summary: { temp_avg, temp_min, temp_max, water_avg, water_min, water_max, ammonia_avg, ammonia_min, ammonia_max, total_readings }
 *   - daily: array of per-day breakdown objects
 *   - alerts: { total, by_parameter, by_action }
 */
app.get("/report/weekly", async (req, res) => {
  try {
    let summaryResult;
    try {
      summaryResult = await pool.query(`
        SELECT
          COALESCE(AVG(temperature) FILTER (WHERE temperature > 0), 0)::float AS temp_avg,
          COALESCE(MIN(temperature) FILTER (WHERE temperature > 0), 0)::float AS temp_min,
          COALESCE(MAX(temperature) FILTER (WHERE temperature > 0), 0)::float AS temp_max,
          COALESCE(AVG(water_level) FILTER (WHERE water_level >= 0), 0)::float AS water_avg,
          COALESCE(MIN(water_level) FILTER (WHERE water_level >= 0), 0)::float AS water_min,
          COALESCE(MAX(water_level) FILTER (WHERE water_level >= 0), 0)::float AS water_max,
          COALESCE(AVG(ammonia) FILTER (WHERE ammonia >= 0), 0)::float AS ammonia_avg,
          COALESCE(MIN(ammonia) FILTER (WHERE ammonia >= 0), 0)::float AS ammonia_min,
          COALESCE(MAX(ammonia) FILTER (WHERE ammonia >= 0), 0)::float AS ammonia_max,
          COUNT(*) AS total_readings
        FROM sensors
        WHERE timestamp >= NOW() - INTERVAL '7 days'
      `);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Weekly summary query failed:`, err.message);
      summaryResult = { rows: [{ temp_avg: 0, temp_min: 0, temp_max: 0, water_avg: 0, water_min: 0, water_max: 0, ammonia_avg: 0, ammonia_min: 0, ammonia_max: 0, total_readings: 0 }] };
    }

    let dailyResult;
    try {
      dailyResult = await pool.query(`
        SELECT
          DATE(timestamp) AS date,
          COALESCE(AVG(temperature) FILTER (WHERE temperature > 0), 0)::float AS temp_avg,
          COALESCE(MIN(temperature) FILTER (WHERE temperature > 0), 0)::float AS temp_min,
          COALESCE(MAX(temperature) FILTER (WHERE temperature > 0), 0)::float AS temp_max,
          COALESCE(AVG(water_level) FILTER (WHERE water_level >= 0), 0)::float AS water_avg,
          COALESCE(MIN(water_level) FILTER (WHERE water_level >= 0), 0)::float AS water_min,
          COALESCE(MAX(water_level) FILTER (WHERE water_level >= 0), 0)::float AS water_max,
          COALESCE(AVG(ammonia) FILTER (WHERE ammonia >= 0), 0)::float AS ammonia_avg,
          COALESCE(MIN(ammonia) FILTER (WHERE ammonia >= 0), 0)::float AS ammonia_min,
          COALESCE(MAX(ammonia) FILTER (WHERE ammonia >= 0), 0)::float AS ammonia_max,
          COUNT(*) AS readings
        FROM sensors
        WHERE timestamp >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(timestamp)
        ORDER BY date
      `);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Weekly daily query failed:`, err.message);
      dailyResult = { rows: [] };
    }

    let dailyAlertsMap = {};
    try {
      const dailyAlertsResult = await pool.query(`
        SELECT DATE(timestamp) AS date, COUNT(*) AS count
        FROM system_logs
        WHERE timestamp >= NOW() - INTERVAL '7 days' AND action = 'Alert'
        GROUP BY DATE(timestamp)
      `);
      dailyAlertsResult.rows.forEach(row => {
        const d = typeof row.date === 'string' ? row.date.split('T')[0] : String(row.date);
        dailyAlertsMap[d] = parseInt(row.count) || 0;
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Weekly daily alerts query failed:`, err.message);
      dailyAlertsMap = {};
    }

    let byParameter = {};
    try {
      const alertsByParamResult = await pool.query(`
        SELECT parameter, COUNT(*) AS count
        FROM system_logs
        WHERE timestamp >= NOW() - INTERVAL '7 days' AND action = 'Alert'
        GROUP BY parameter
      `);
      alertsByParamResult.rows.forEach(row => { byParameter[row.parameter] = parseInt(row.count) || 0; });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Weekly alerts by param query failed:`, err.message);
      byParameter = {};
    }

    let byAction = {};
    try {
      const logActionsResult = await pool.query(`
        SELECT action, COUNT(*)::int AS count
        FROM system_logs
        WHERE timestamp >= NOW() - INTERVAL '7 days'
        GROUP BY action
      `);
      logActionsResult.rows.forEach(row => { byAction[row.action] = row.count; });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Weekly log actions query failed:`, err.message);
      byAction = {};
    }

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const summary = summaryResult.rows[0] || {};

    // Build daily array with alert counts merged
    const daily = (dailyResult.rows || []).map(day => {
      const dateStr = typeof day.date === 'string' ? day.date.split('T')[0] : String(day.date);
      return {
        date: dateStr,
        temp_avg: Number(day.temp_avg) || 0,
        temp_min: Number(day.temp_min) || 0,
        temp_max: Number(day.temp_max) || 0,
        water_avg: Number(day.water_avg) || 0,
        water_min: Number(day.water_min) || 0,
        water_max: Number(day.water_max) || 0,
        ammonia_avg: Number(day.ammonia_avg) || 0,
        ammonia_min: Number(day.ammonia_min) || 0,
        ammonia_max: Number(day.ammonia_max) || 0,
        readings: parseInt(day.readings) || 0,
        alerts: dailyAlertsMap[dateStr] || 0,
      };
    });

    // Total alerts
    const totalAlerts = Object.values(byParameter).reduce((sum, c) => sum + c, 0);

    res.json({
      period: {
        start: weekAgo.toISOString(),
        end: now.toISOString(),
      },
      summary: {
        temp_avg: Number(summary.temp_avg) || 0,
        temp_min: Number(summary.temp_min) || 0,
        temp_max: Number(summary.temp_max) || 0,
        water_avg: Number(summary.water_avg) || 0,
        water_min: Number(summary.water_min) || 0,
        water_max: Number(summary.water_max) || 0,
        ammonia_avg: Number(summary.ammonia_avg) || 0,
        ammonia_min: Number(summary.ammonia_min) || 0,
        ammonia_max: Number(summary.ammonia_max) || 0,
        total_readings: parseInt(summary.total_readings) || 0,
      },
      daily,
      alerts: {
        total: totalAlerts,
        by_parameter: byParameter,
        by_action: byAction,
      },
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching weekly report:`, err.message);
    res.status(500).json({ message: "Error fetching weekly report", error: err.message });
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
app.post("/auth/login", loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "Username and password required" });

    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if (result.rows.length === 0) return res.status(401).json({ message: "Invalid credentials" });

    const user = result.rows[0];
    if (!verifyPassword(password, user.password_hash)) return res.status(401).json({ message: "Invalid credentials" });

    // Generate a new session token (24-hour expiry) and store it in the database
    const token = generateToken();
    const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
    const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    // Transparently upgrade legacy / weaker password hashes to the current
    // PBKDF2 iteration count on a successful login (never on a failed one).
    if (needsRehash(user.password_hash)) {
      const upgradedHash = hashPassword(password);
      await pool.query(
        "UPDATE users SET token = $1, token_expires_at = $2, password_hash = $3 WHERE id = $4",
        [token, tokenExpiresAt, upgradedHash, user.id]
      );
    } else {
      await pool.query("UPDATE users SET token = $1, token_expires_at = $2 WHERE id = $3", [token, tokenExpiresAt, user.id]);
    }

    res.json({
      message: "Login successful",
      user: { id: user.id, username: user.username, email: user.email, role: user.role, name: user.name },
      token,
      tokenExpiresAt: tokenExpiresAt.toISOString(),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Login error:`, err.message);
    res.status(500).json({ message: "Login failed", error: err.message });
  }
});

/**
 * POST /auth/logout (Authenticated)
 * Revokes the current session token so it can no longer be used.
 * Called by the frontend when the user logs out.
 */
app.post("/auth/logout", requireAuth, async (req, res) => {
  try {
    await pool.query("UPDATE users SET token = NULL, token_expires_at = NULL WHERE id = $1", [req.user.id]);
    res.json({ message: "Logged out" });
  } catch (err) {
    res.status(500).json({ message: "Error logging out", error: err.message });
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
      return res.json({ temp_min: 20, temp_max: 31, water_level_min: 10, water_level_max: 100, ammonia_min: 0, ammonia_max: 25 });
    }
    const row = result.rows[0];
    res.json({
      id: Number(row.id),
      temp_min: Number(row.temp_min),
      temp_max: Number(row.temp_max),
      water_level_min: Number(row.water_level_min),
      water_level_max: Number(row.water_level_max),
      ammonia_min: Number(row.ammonia_min ?? 0),
      ammonia_max: Number(row.ammonia_max ?? 25),
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
    let parsed;
    try {
      parsed = parseSettingsInput(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid settings", errors: zodFieldErrors(err) });
      }
      if (err.statusCode === 400) return res.status(400).json({ message: err.message });
      throw err;
    }
    const { temp_min, temp_max, water_level_min, water_level_max, ammonia_min, ammonia_max } = parsed;
    const existing = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
    let savedSettings;
    if (existing.rows.length > 0) {
      const changes = getChangedFields(existing.rows[0], { temp_min, temp_max, water_level_min, water_level_max, ammonia_min, ammonia_max });
      if (Object.keys(changes).length === 0) return res.json({ message: "No change", changed: false, data: existing.rows[0] });
      const keys = Object.keys(changes);
      const values = Object.values(changes);
      const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
      const result = await pool.query(`UPDATE sensor_settings SET ${setClauses}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`, [...values, existing.rows[0].id]);
      savedSettings = result.rows[0];
    } else {
      const result = await pool.query(
        `INSERT INTO sensor_settings (temp_min, temp_max, water_level_min, water_level_max, ammonia_min, ammonia_max) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [temp_min, temp_max, water_level_min, water_level_max, ammonia_min, ammonia_max]
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
    const defaults = { temp_min: 20, temp_max: 31, water_level_min: 10, water_level_max: 100, ammonia_min: 0, ammonia_max: 25 };
    const existing = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
    let savedSettings;
    if (existing.rows.length > 0) {
      const result = await pool.query(
        `UPDATE sensor_settings SET temp_min=$1, temp_max=$2, water_level_min=$3, water_level_max=$4, ammonia_min=$5, ammonia_max=$6, updated_at=NOW() WHERE id=$7 RETURNING *`,
        [defaults.temp_min, defaults.temp_max, defaults.water_level_min, defaults.water_level_max, defaults.ammonia_min, defaults.ammonia_max, existing.rows[0].id]
      );
      savedSettings = result.rows[0];
    } else {
      const result = await pool.query(
        `INSERT INTO sensor_settings (temp_min, temp_max, water_level_min, water_level_max, ammonia_min, ammonia_max) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [defaults.temp_min, defaults.temp_max, defaults.water_level_min, defaults.water_level_max, defaults.ammonia_min, defaults.ammonia_max]
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
    const settings = settingsResult.rows[0] || { temp_min: 20, temp_max: 31, water_level_min: 10, water_level_max: 100, ammonia_min: 0, ammonia_max: 25 };
    const sensorResult = await pool.query("SELECT * FROM sensors ORDER BY timestamp DESC LIMIT 1");
    const sensor = sensorResult.rows[0] || null;

    const temp = sensor?.temperature ?? "N/A";
    const water = sensor?.water_level ?? "N/A";
    const ammonia = sensor?.ammonia ?? "N/A";
    const tempVal = Number(sensor?.temperature);
    const waterVal = Number(sensor?.water_level);
    const ammoniaVal = Number(sensor?.ammonia);
    const tempOK = sensor && Number.isFinite(tempVal) && tempVal > 0;
    const waterOK = sensor && Number.isFinite(waterVal) && waterVal >= 0;
    const ammoniaOK = sensor && Number.isFinite(ammoniaVal) && ammoniaVal >= 0;
    const tempStatus = tempOK ? getStatusText(getThresholdStatus(tempVal, Number(settings.temp_min), Number(settings.temp_max))) : "N/A (sensor offline)";
    const waterStatus = waterOK ? getStatusText(getThresholdStatus(waterVal, Number(settings.water_level_min), Number(settings.water_level_max))) : "N/A (sensor offline)";
    const ammoniaStatus = ammoniaOK ? getStatusText(getThresholdStatus(ammoniaVal, Number(settings.ammonia_min), Number(settings.ammonia_max))) : "N/A (sensor offline)";
    const timestamp = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true });
    const summary = (tempStatus === "✅ Good" && waterStatus === "✅ Good" && ammoniaStatus === "✅ Good") ? "All systems normal" : "Some parameters need attention";
    const testMessage = `📊 CRAYVINGS LIVE READINGS (TEST)\nTime: ${timestamp}\nTemperature: ${tempOK ? temp : "N/A"}°C (${tempStatus})\nWater Level: ${waterOK ? water : "N/A"}% (${waterStatus})\nAmmonia: ${ammoniaOK ? ammonia : "N/A"} ppm (${ammoniaStatus})\n${summary}\n(This is a test message)`;

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
 * Returns paginated system log entries with per-action counts.
 * Query parameters: page (default: 1), limit (default: 20, max: 100),
 *   action (optional: filter by action, e.g. "Alert"), parameter (optional: filter by parameter)
 * Returns: { data: [], total: number, page: number, limit: number, counts: { action: count } }
 */
app.get("/system-logs", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const action = req.query.action || "";
    const parameter = req.query.parameter || "";

    // Build dynamic WHERE clause for action/parameter filters
    let where = [];
    let params = [];
    let paramCount = 1;
    if (action) { where.push(`action = $${paramCount}`); params.push(String(action)); paramCount++; }
    if (parameter) { where.push(`parameter = $${paramCount}`); params.push(String(parameter)); paramCount++; }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT * FROM system_logs ${whereClause} ORDER BY timestamp DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      [...params, limit, offset]
    );
    const countResult = await pool.query(`SELECT COUNT(*) FROM system_logs ${whereClause}`, params);
    const countsResult = await pool.query("SELECT action, COUNT(*)::int AS count FROM system_logs GROUP BY action");
    const counts = {};
    countsResult.rows.forEach(row => { counts[row.action] = row.count; });
    res.json({ data: result.rows, total: parseInt(countResult.rows[0].count), page, limit, counts });
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
app.post('/alert/device-disconnect', requireAuth, async (req, res) => {
  try {
    const { event_type, description, consecutive_failures } = req.body;
    const recipients = await pool.query('SELECT phone_number, name FROM authorized_recipients WHERE is_active = true');
    if (recipients.rows.length === 0) return res.status(200).json({ message: 'No active recipients', sent: 0 });

    // Check if SMS alerts are currently muted
    if (smsMuteUntil && new Date() < new Date(smsMuteUntil)) {
      console.log('[' + new Date().toISOString() + '] SMS alerts muted until ' + smsMuteUntil + ', skipping disconnect alert');
      await pool.query('INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)', ['Device Disconnect Muted', 'ESP32', String(consecutive_failures || 0), 'Muted until ' + smsMuteUntil]);
      // Log muted SMS to sms_logs for audit trail
      const muteTimestamp = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
      const muteMessage = 'CRAYVINGS DEVICE ALERT\nESP32 device disconnected\n' + (description || 'No data received for 15+ seconds') + '\nFailed polls: ' + (consecutive_failures || 0) + '\nTime: ' + muteTimestamp;
      for (const r of recipients.rows) {
        await logSMS(r.phone_number, muteMessage, 'muted', 'SMS muted until ' + smsMuteUntil, null);
      }
      return res.json({ message: 'SMS alerts muted', sent: 0, total: recipients.rows.length, muted: true, muteExpires: smsMuteUntil });
    }

    const timestamp = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
    const message = 'CRAYVINGS DEVICE ALERT\nESP32 device disconnected\n' + (description || 'No data received for 15+ seconds') + '\nFailed polls: ' + (consecutive_failures || 0) + '\nTime: ' + timestamp;

    // Cooldown prevents SMS spam when the connection flaps on/off rapidly
    const now = Date.now();
    const cooldownMs = SMS_CONFIG.cooldown.critical;
    if (now - lastDisconnectSmsTs < cooldownMs) {
      await pool.query('INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)', ['Device Disconnect (cooldown)', 'ESP32', String(consecutive_failures || 0), 'SMS suppressed by cooldown']);
      return res.json({ message: 'Disconnect alert suppressed (cooldown)', sent: 0, total: recipients.rows.length, cooldown: true });
    }
    lastDisconnectSmsTs = now;

    // Send all SMS in parallel instead of sequentially
    const smsPromises = recipients.rows.map(async (r) => sendSingleSMS(r.phone_number, message));
    const results = await Promise.allSettled(smsPromises);
    const sent = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

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
app.post('/alert/mute', requireAdmin, async (req, res) => {
  try {
    const { hours } = req.body;
    if (!hours || typeof hours !== 'number' || hours <= 0) {
      smsMuteUntil = null;
      await pool.query("DELETE FROM system_state WHERE key = 'sms_mute_until'");
      console.log('[' + new Date().toISOString() + '] SMS alerts unmuted');
      return res.json({ message: 'SMS alerts unmuted', muted: false, muteExpires: null });
    }

    smsMuteUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    // Persist the mute so it survives server restarts
    await pool.query(`INSERT INTO system_state (key, value) VALUES ('sms_mute_until', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [smsMuteUntil]);
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
    // Clear expired mute state (memory + database)
    if (smsMuteUntil && new Date() >= new Date(smsMuteUntil)) {
      smsMuteUntil = null;
      await pool.query("DELETE FROM system_state WHERE key = 'sms_mute_until'");
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
    const { action_type, description, module } = req.body;
    if (!action_type) return res.status(400).json({ message: "action_type required" });

    // Derive the acting user from the session token (accurate audit trail).
    // Falls back to the built-in "admin" account when no valid token is present
    // (must match a real users.username so the FK constraint is satisfied).
    const token = req.headers.authorization?.replace("Bearer ", "");
    let userName = "admin";
    if (token) {
      const tokenResult = await pool.query("SELECT username FROM users WHERE token = $1", [token]);
      if (tokenResult.rows.length > 0) {
        userName = tokenResult.rows[0].username;
      }
    }

    const result = await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, $2, $3, $4) RETURNING *",
      [userName, action_type, description || "", module || ""]
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
//      (requires ADMIN_INITIAL_PASSWORD env var for first-time setup)
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

      // Create default admin account if it doesn't exist.
      // ADMIN_INITIAL_PASSWORD is REQUIRED for first-time setup so a known
      // default credential is never used in production. The plaintext password
      // is never logged.
      const adminExists = await client.query("SELECT id FROM users WHERE username = $1", ["admin"]);
      if (adminExists.rows.length === 0) {
        const initialAdminPassword = process.env.ADMIN_INITIAL_PASSWORD;
        if (!initialAdminPassword) {
          const msg = `[${new Date().toISOString()}] No admin account exists and ADMIN_INITIAL_PASSWORD is not set. Set ADMIN_INITIAL_PASSWORD in .env to create the initial admin, then restart.`;
          console.error(msg);
          process.exit(1);
        }
        const adminPassword = hashPassword(initialAdminPassword);
        await client.query(
          `INSERT INTO users (name, username, email, password_hash, role) VALUES ('Administrator', 'admin', 'admin@crayvings.com', $1, 'admin')`,
          [adminPassword]
        );
        console.log(`[${new Date().toISOString()}] Default admin account created. Change its password after first login.`);
      } else {
        console.log(`[${new Date().toISOString()}] Admin account exists`);
      }

      // Restore alert state from database (persists across server restarts)
      const lastAlertsResult = await client.query("SELECT * FROM last_alerts");
      lastAlertedState = {};
      for (const row of lastAlertsResult.rows) {
        lastAlertedState[`${row.device_id}:${row.sensor_key}`] = { status: row.status, value: parseFloat(row.value), timestamp: row.timestamp?.toISOString() };
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
