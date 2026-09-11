// =============================================================================
// FILE: server.cjs
// =============================================================================
// PURPOSE: Express.js backend for the CRAYvings Monitoring System.
// =============================================================================

// ========================
// DEPENDENCIES
// ========================

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { z } = require("zod");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
require("dotenv").config();

// ========================
// EXPRESS APP SETUP
// ========================
const app = express();
const PORT = process.env.PORT || 3000;

// ========================
// POSTGRESQL CONNECTION POOL
// ========================
// Pool config read from environment variables (.env)
const pool = new Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

// CORS restricted to ALLOWED_ORIGINS allowlist; requests without an
// Origin header (ESP32, curl) are allowed.
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
// 10kb body limit prevents oversized-payload memory abuse (ESP32 payloads are tiny)
app.use(express.json({ limit: "10kb" }));

// =============================================================================
// RATE LIMITING
// =============================================================================
// Per-IP limiter curbs brute force/scraping/DoS. The ESP32's fast polling path
// is exempted — it is separately guarded by DEVICE_SECRET.
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
  limit: 25,                  // 25 login attempts / 10 min / IP (was 10, too strict)
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again later." },
  validate: { xForwardedForHeader: false },
});

app.use(globalLimiter);

// =============================================================================
// PASSWORD HASHING UTILITIES
// =============================================================================
// New hashes: "iterations:salt:hash". Legacy "salt:hash" hashes are verified at
// the old 10000 iterations and re-hashed on next login, so raising the cost
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

// Hashes a plaintext password with a fresh random salt at PBKDF2_ITERATIONS
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return `${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

// Verifies a plaintext password against a stored hash (new or legacy format)
function verifyPassword(password, stored) {
  const { iterations, salt, hash } = parseStoredHash(stored);
  const verifyHash = crypto.pbkdf2Sync(password, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  const expected = Buffer.from(hash, "hex");
  const actual = Buffer.from(verifyHash, "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// True if the stored hash is legacy-format or below current iteration count (should be re-hashed)
function needsRehash(stored) {
  const parts = stored.split(":");
  if (parts.length !== 3) return true;
  return parseInt(parts[0], 10) !== PBKDF2_ITERATIONS;
}

// Generates a random 64-character hex token for session authentication
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// =============================================================================
// AUTHENTICATION MIDDLEWARE
// =============================================================================
// requireAdmin validates the Bearer token AND checks the admin role;
// requireAuth validates the token only. Both attach the user to req.

// Validates token and admin role; attaches user to req.adminUser
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

// Validates the token and attaches the user to req.adminUser (admin role required)
// Used by all admin-gated routes.
app._deleteUserHard = async (userId, actorUsername) => {
  // Deferred hard-delete with audit: called only after email-OTP approval.
  // activity_logs.user_name was relaxed to SET NULL by migration 001, so the
  // audit rows survive even after the user row is removed.
  const reqResult = await pool.query(
    `DELETE FROM users WHERE id = $1 RETURNING id, username`,
    [userId]
  );
  if (reqResult.rows.length === 0) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  return reqResult.rows[0];
};
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
// EMAIL OTP — secure account deletion (2FA via SMTP)
// =============================================================================
// The existing admin-only DELETE /auth/users/:id is replaced by a three-phase
// flow that keeps a full audit trail and requires a human-in-the-loop:
//
//   1. REQUEST  — admin supplies their password + the target user id.
//                 A 6-digit OTP is generated, SMTP'd to the *admin's* email,
//                 and a `user_deletion_requests` row is created (status
//                 pending_otp) with a salted SHA-256 hash of the code.
//   2. VERIFY   — admin submits the OTP (max 5 attempts, 10 min expiry).
//                 Verified rows advance to status pending_approval; the code is
//                 marked used so replay is impossible.
//   3. APPROVE/EXECUTE — a *different* admin (second person) approves, which
//                 performs the hard delete. The timestamped auth+reason history
//                 lives in `status_history` + the activity-log audit trail.
//
// SMTP delivery is plug-and-play: set SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM
// in .env (see .env.example). When SMTP is not configured the server logs the
// OTP to the console ONLY in non-production (DEV_OTP_CONSOLE_FALLBACK=true) —
// that keeps the "no email server configured" demo usable without silently
// leaking codes to the response body.

let smtpTransporter = null;
if (process.env.SMTP_HOST) {
  smtpTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: (process.env.SMTP_SECURE || "").toUpperCase() === "TRUE",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  console.log(`[${new Date().toISOString()}] SMTP transport ready for ${process.env.SMTP_HOST}:${Number(process.env.SMTP_PORT) || 587}`);
} else {
  console.warn(`[${new Date().toISOString()}] SMTP_HOST not set — OTP codes will be logged to the console (dev only)`);
}

const OTP_DIGITS = 6;
const OTP_TTL_MS = 10 * 60 * 1000;   // 10 minutes
const OTP_MAX_ATTEMPTS = 5;           // attempts before the code is invalidated

// Random time-safe 6-digit code (crypto, not Math.random)
function generateOtpCode() {
  const raw = crypto.randomInt(0, 1000000).toString().padStart(OTP_DIGITS, "0");
  return raw;
}

// Salted SHA-256 hash of the OTP (code never stored in plaintext)
function hashOtpCode(code, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.createHash("sha256").update(`${salt}:${code}`).digest("hex");
  return { digest, salt };
}

// Constant-time comparison (timing-attack safe)
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function sendOtpEmail(to, code) {
  if (!smtpTransporter) {
    // No SMTP configured — dev fallback: log the code, DO NOT return it in JSON.
    const mode = process.env.NODE_ENV !== "production" && process.env.DEV_OTP_CONSOLE_FALLBACK !== "false";
    if (mode) {
      console.log(`[${new Date().toISOString()}] [DEV-OTP] to=${to} code=${code} (no mail provider configured; see .env.example for SMTP_*)`);
    }
    return { delivered: false, devFallback: mode };
  }
  await smtpTransporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: "Your account-deletion confirmation code",
    text: `Your CRAYvings confirmation code is: ${code}\nIt expires in 10 minutes. Do not share this code with anyone.\nIf you did not request this, ignore this email.`,
    html: `<p>Your CRAYvings account-deletion confirmation code is:</p><p style="font-size:24px;letter-spacing:6px;font-weight:bold">${code}</p><p>It expires in 10 minutes. Do not share it with anyone.<br/>If you did not request this, ignore this email.</p>`,
  });
  return { delivered: true };
}

// =============================================================================
// HELPER: DETECT CHANGED FIELDS
// =============================================================================
// Returns only fields that actually changed, to avoid unnecessary DB writes
// and "no change" audit log entries.

// Compares current vs updates; String() handles numeric/string type differences
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
// Only executes the UPDATE when at least one field changed, keeping audit logs clean.

// UPDATE wrapper with change detection; optionally touches updated_at
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
// ESP32 marks failed sensors with -1 (and 0 for temperature), so lower bounds
// must accept those sentinel values.

// POST /sensor (ESP32 ingestion); failed-sensor sentinels are filtered out later
const sensorSchema = z.object({
  device_id: z.string().min(1).max(50),
  temperature: z.coerce.number().min(-10).max(50),
  water_level: z.coerce.number().min(-1).max(100),
  // ammonia is now a real NH3 gas reading in ppm (MQ-137). Upper bound covers
  // the full datasheet range (5-500 ppm); -1 is the failed-sensor sentinel.
  ammonia: z.coerce.number().min(-1).max(500).optional(),
});

// POST /settings (threshold configuration); partial updates, each pair validated min < max
const settingsFieldSchema = z.object({
  temp_min: z.coerce.number().min(-10).max(50),
  temp_max: z.coerce.number().min(-10).max(50),
  water_level_min: z.coerce.number().min(0).max(100),
  water_level_max: z.coerce.number().min(0).max(100),
  ammonia_min: z.coerce.number().min(0).max(500),
  ammonia_max: z.coerce.number().min(0).max(500),
}).partial();

// Validates a settings payload; throws ZodError on field violations or
// Error(statusCode 400) for min >= max pairs
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

// Converts a ZodError into a readable field-errors object
function zodFieldErrors(err) {
  const flat = err.flatten();
  return flat.fieldErrors || {};
}

// =============================================================================
// THRESHOLD STATUS EVALUATION
// =============================================================================
// "good" within [min,max]; "warning" outside but within 15% of range size;
// "critical" outside AND >= 15% deviation. Temp example (20-31, range 11,
// margin 1.65): 22°C good, 19°C warning, 17°C critical.

// Classifies a reading against its min/max thresholds
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

// DEVICE_SECRET: ESP32 must send matching X-Device-Secret header for POST /sensor.
// When set, requests without it are rejected; when unset (local dev), ingestion
// is allowed but a warning is logged. Set DEVICE_SECRET in production.
const DEVICE_SECRET = process.env.DEVICE_SECRET;
let deviceSecretWarned = false;

// In-memory alert dedup state; last-alert per sensor, disconnect spam guard
let lastAlertedState = {};
// Server-side ammonia spike guard: last stored reading per device
let lastAmmoniaReading = {};
const AMMONIA_SPIKE_THRESHOLD = 20; // ppm — reject readings jumping more than this from last stored value
// Cooldown prevents system_logs alert spam for a repeated status (~2 minutes)
const ALERT_COOLDOWN_MS = 120000;

// =============================================================================
// DATABASE OPTIMIZATION & CLEANUP
// =============================================================================
// Indexes and migrations run on startup
(async () => {
  try {
    // Ammonia columns (added after pH was removed): real NH3 ppm reading (MQ-137),
    // default range 0-25 ppm (ACGIH 8h TWA)
    await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS ammonia DECIMAL(5,3) DEFAULT 0`);
    await pool.query(`ALTER TABLE sensor_settings ADD COLUMN IF NOT EXISTS ammonia_min DECIMAL(5,2) DEFAULT 0.25`);
    await pool.query(`ALTER TABLE sensor_settings ADD COLUMN IF NOT EXISTS ammonia_max DECIMAL(5,2) DEFAULT 1.00`);

    // Session token expiry (24-hour expiration)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON system_logs (timestamp DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_action ON system_logs (action)`);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sensors_timestamp ON sensors (timestamp DESC)`);
    
    console.log(`[${new Date().toISOString()}] Database indexes verified/created`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating indexes:`, err.message);
  }
})();

// Keep only last 30 days of logs and sensor readings (startup and daily)
const LOGS_RETENTION_DAYS = 30;
async function cleanupOldData() {
  try {
    const result = await pool.query(
      `DELETE FROM system_logs WHERE timestamp < NOW() - INTERVAL '${LOGS_RETENTION_DAYS} days' RETURNING id`
    );
    if (result.rowCount > 0) {
      console.log(`[${new Date().toISOString()}] Cleaned up ${result.rowCount} old system_logs entries`);
    }

    // ESP32 posts ~1 reading/sec, so the sensors table grows fast — prune old readings
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

// GET /health - server status and current time for monitoring
app.get("/health", (req, res) => {
  res.json({ status: "ok", serverTime: new Date().toISOString() });
});

// GET / - API identification message
app.get("/", (req, res) => {
  res.json({ message: "CRAYvings Monitoring System API", status: "running" });
});

// ========================
// SENSOR DATA ENDPOINTS
// ========================

// POST /sensor - ESP32 ingestion; stores reading and evaluates thresholds
app.post("/sensor", async (req, res) => {
  try {
    // Device auth: if DEVICE_SECRET is set, require a matching X-Device-Secret header
    if (DEVICE_SECRET) {
      const presented = req.headers["x-device-secret"];
      if (!presented || presented !== DEVICE_SECRET) {
        return res.status(401).json({ message: "Invalid device secret" });
      }
    } else if (process.env.NODE_ENV === "production") {
      // Fail closed: never accept unauthenticated sensor ingestion in production
      return res.status(503).json({ message: "Sensor ingestion is disabled: DEVICE_SECRET not configured" });
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

    // Ammonia spike guard: reject readings jumping too far from the last stored
    // value (USB-disconnect electrical noise causes wild spikes)
    const ammoniaVal = Number(ammonia ?? 0);
    if (ammoniaVal > 0 && lastAmmoniaReading[device_id] != null) {
      const jump = Math.abs(ammoniaVal - lastAmmoniaReading[device_id]);
      if (jump > AMMONIA_SPIKE_THRESHOLD) {
        console.warn(`[${new Date().toISOString()}] Ammonia spike rejected from ${device_id}: ${ammoniaVal} ppm (last: ${lastAmmoniaReading[device_id]} ppm, jump: ${jump.toFixed(1)} ppm)`);
        return res.status(400).json({ message: "Ammonia reading rejected: spike exceeds threshold", last_value: lastAmmoniaReading[device_id], rejected_value: ammoniaVal, jump: jump.toFixed(1) });
      }
    }

    const ts = new Date();
    // Auto-register the device so the sensors.device_id FK never fails
    await pool.query(
      `INSERT INTO devices (device_id, last_seen) VALUES ($1, $2) ON CONFLICT (device_id) DO UPDATE SET last_seen = $2`,
      [device_id, ts]
    );
    const result = await pool.query(
      `INSERT INTO sensors (device_id, temperature, water_level, ammonia, timestamp) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [device_id, Number(temperature ?? 0), Number(water_level ?? 0), Number(ammonia ?? 0), ts]
    );
    console.log(`[${new Date().toISOString()}] Sensor data saved from ${device_id}`);

    if (ammoniaVal > 0) {
      lastAmmoniaReading[device_id] = ammoniaVal;
    }

// Respond immediately; timestamp returned as UTC ISO-8601 so the frontend
    // renders it in the farm timezone without silent timezone conversion.
    res.status(201).json({ message: "Saved", data: { ...result.rows[0], timestamp: ts.toISOString() } });

    // Background: evaluate thresholds and update alert state
    setImmediate(async () => {
      try {
        const settingsResult = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
        const settings = settingsResult.rows[0] || { temp_min: 20, temp_max: 31, water_level_min: 10, water_level_max: 100, ammonia_min: 0.25, ammonia_max: 1 };

        const sensorChecks = [
          { key: "Temperature", val: Number(temperature), min: Number(settings.temp_min), max: Number(settings.temp_max), minValid: 0.0001 },
          { key: "Water Level", val: Number(water_level), min: Number(settings.water_level_min), max: Number(settings.water_level_max), minValid: 0 },
          { key: "Ammonia", val: Number(ammonia), min: Number(settings.ammonia_min), max: Number(settings.ammonia_max), minValid: 0 },
        ];

        const nowTs = ts.getTime();

        for (const sensor of sensorChecks) {
          // Skip invalid readings: ESP32 sends -1 on failure, and 0 for temperature
          // is also a failure (0°C is outside the firmware's valid range)
          if (sensor.val < sensor.minValid) continue;
          const status = getThresholdStatus(sensor.val, sensor.min, sensor.max);
          const last = lastAlertedState[`${device_id}:${sensor.key}`] || {};
          const lastTs = last.timestamp ? new Date(last.timestamp).getTime() : 0;

          // Reading returned to normal: resolve the alert
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

          // Cooldown prevents repeated alerts for a persistent status
          if (status === last.status && nowTs - lastTs < ALERT_COOLDOWN_MS) continue;

          const direction = sensor.val < sensor.min ? "Low" : "High";

          // Log the alert to system_logs
          await pool.query(`INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)`,
            ["Alert", sensor.key, direction, sensor.val]);

          // Update last_alerts (upsert) and in-memory dedup state
          await pool.query(
            `INSERT INTO last_alerts (device_id, sensor_key, status, value, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (device_id, sensor_key) DO UPDATE SET status = $3, value = $4, timestamp = $5`,
            [device_id, sensor.key, status, sensor.val, ts.toISOString()]
          );
          lastAlertedState[`${device_id}:${sensor.key}`] = { status, value: sensor.val, timestamp: ts.toISOString() };
        }
      } catch (bgErr) {
        console.error(`[${new Date().toISOString()}] Background alert processing error:`, bgErr.message);
      }
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error saving sensor:`, err.message);
    res.status(500).json({ message: "Error saving data", error: err.message });
  }
});

// GET /sensor - sensor history, newest first; ?limit (default 300, max 1000)
app.get("/sensor", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 300));
    const result = await pool.query("SELECT * FROM sensors ORDER BY timestamp DESC LIMIT $1", [limit]);
    res.json(result.rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching sensors:`, err.message);
    res.status(500).json({ message: "Error fetching data", error: err.message });
  }
});

// GET /sensor/latest - most recent reading; 404 when none exist
app.get("/sensor/latest", requireAuth, async (req, res) => {
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

// GET /report/weekly - 7-day aggregated report (summary, daily breakdown, alert counts)
app.get("/report/weekly", requireAuth, async (req, res) => {
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

    // Merge per-day alert counts into the daily breakdown
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

// POST /auth/login - verify credentials and issue a session token (24h expiry)
app.post("/auth/login", loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "Username and password required" });

    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if (result.rows.length === 0) return res.status(401).json({ message: "Invalid credentials" });

    const user = result.rows[0];
    if (!verifyPassword(password, user.password_hash)) return res.status(401).json({ message: "Invalid credentials" });

    // New token per login (24h expiry); old tokens are invalidated
    const token = generateToken();
    const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
    const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    // Upgrade legacy/weak hashes to the current PBKDF2 count on successful login only
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

// POST /auth/logout - revoke the current session token
app.post("/auth/logout", requireAuth, async (req, res) => {
  try {
    await pool.query("UPDATE users SET token = NULL, token_expires_at = NULL WHERE id = $1", [req.user.id]);
    res.json({ message: "Logged out" });
  } catch (err) {
    res.status(500).json({ message: "Error logging out", error: err.message });
  }
});

// GET /auth/users (Admin only) - list all users, newest first
app.get("/auth/users", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, username, email, role, created_at FROM users ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: "Error fetching users", error: err.message });
  }
});

// POST /auth/users (Admin only) - create a user; 409 if username/email exists
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

// -----------------------------------------------------------------------------
// SECURE USER DELETION (EMAIL-OTP 2-STEP)
// -----------------------------------------------------------------------------
// The real account is never deleted without proof that a human admin both knows
// the requester's own password AND has access to the requester's email inbox.
//
//   STEP 1  POST /auth/users/:id/deletion-request   admin password + reason
//           -> generates a 6-digit OTP, emails it, stores a hashed copy in
//              user_deletion_requests (PENDING_OTP).
//   STEP 2  POST /auth/users/:id/deletion-verify    OTP code from the email
//           -> constant-time OTP check; on success the user row is deleted and
//              the request flips to COMPLETED with the full audit chain. Returns
//              the OTP handler result (email REDACTED if SMTP was not configured).

// POST /auth/users/:id/deletion-request (Admin only)
// Validates the admin's own password, creates a user_deletion_request, emails OTP.
app.post("/auth/users/:id/deletion-request", requireAdmin, async (req, res) => {
  try {
    const { password, reason } = req.body;
    if (!password) return res.status(400).json({ message: "Current password required" });

    const targetResult = await pool.query(
      "SELECT id, username, email FROM users WHERE id = $1 AND status = 'active'",
      [req.params.id]
    );
    if (targetResult.rows.length === 0) return res.status(404).json({ message: "Target user not found" });
    const target = targetResult.rows[0];
    if (!target.email) return res.status(400).json({ message: "Target user has no email address; cannot send an OTP." });

    const passwordOk = verifyPassword(password, req.adminUser.password_hash);
    if (!passwordOk) return res.status(401).json({ message: "Incorrect password" });

    const code = generateOtpCode();
    const { digest, salt } = hashOtpCode(code);

    const created = await pool.query(
      `INSERT INTO user_deletion_requests
        (user_id, user_username, requester_username, requester_email, status, reason,
         otp_hash, otp_salt, otp_expires_at, status_history)
       VALUES ($1, $2, $3::text, $4, 'PENDING_OTP', $5, $6, $7, $8,
         jsonb_build_array(jsonb_build_object('from','PENDING_OTP','to','PENDING_OTP','by',$3::text,'at',now())))
       RETURNING id`,
      [
        target.id,
        target.username,
        req.adminUser.username,
        req.adminUser.email || req.adminUser.username,
        reason || "Account deletion requested by admin",
        digest,
        salt,
        new Date(Date.now() + OTP_TTL_MS),
      ]
    );

    const emailResult = await sendOtpEmail(target.email, code.raw ?? code);

    await pool.query(
      `UPDATE user_deletion_requests SET status = $2 WHERE id = $1`,
      [created.rows[0].id, emailResult.delivered ? "PENDING_OTP" : "PENDING_OTP"]
    );

    res.status(201).json({
      message: emailResult.delivered
        ? "Confirmation code sent to the user's email"
        : "Confirmation code generated (dev mode — SMTP not configured). Check server console.",
      request_id: created.rows[0].id,
      otp_sent: emailResult.delivered,
      dev_fallback: emailResult.devFallback || false,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error requesting user deletion:`, err.message);
    res.status(500).json({ message: "Error requesting user deletion", error: err.message });
  }
});

// POST /auth/users/:id/deletion-verify (Admin only)
// Verifies the emailed OTP (constant-time) and hard-deletes the user + audit chain.
app.post("/auth/users/:id/deletion-verify", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { request_id, code } = req.body;
    if (!request_id || !code) return res.status(400).json({ message: "request_id and code are required" });

    await client.query("BEGIN");
    const reqResult = await client.query(
      `SELECT * FROM user_deletion_requests
        WHERE id = $1 AND user_id = $2 AND status = 'PENDING_OTP'
        FOR UPDATE`,
      [request_id, req.params.id]
    );
    if (reqResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No pending deletion request for this user" });
    }
    const row = reqResult.rows[0];

    const now = Date.now();
    if (row.otp_attempts >= OTP_MAX_ATTEMPTS || (row.otp_expires_at && new Date(row.otp_expires_at).getTime() < now)) {
      await client.query(`UPDATE user_deletion_requests SET status = 'EXPIRED' WHERE id = $1`, [row.id]);
      await client.query("COMMIT");
      return res.status(410).json({ message: "Confirmation code expired or exceeded max attempts" });
    }

    const digest = require("crypto").createHash("sha256").update(`${row.otp_salt}:${code}`).digest("hex");
    if (!safeEqual(digest, row.otp_hash)) {
      await client.query(
        `UPDATE user_deletion_requests SET otp_attempts = otp_attempts + 1 WHERE id = $1 RETURNING otp_attempts`,
        [row.id]
      );
      await client.query("COMMIT");
      const attempts = row.otp_attempts + 1;
      return res.status(401).json({
        message: attempts >= OTP_MAX_ATTEMPTS ? "Too many incorrect codes — request invalidated" : `Incorrect code (${attempts}/${OTP_MAX_ATTEMPTS})`,
        remaining_attempts: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
      });
    }

    const userDel = await client.query(
      "DELETE FROM users WHERE id = $1 RETURNING username",
      [req.params.id]
    );
    if (userDel.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found" });
    }

    const actor = req.adminUser.username;
    await client.query(
      `UPDATE user_deletion_requests
          SET status = 'COMPLETED', otp_verified_at = NOW(), otp_verified_by = $2::text,
              executed_by = $2::text, executed_at = NOW(),
              status_history = status_history || jsonb_build_array(
                jsonb_build_object('from','PENDING_OTP','to','COMPLETED','by',$2::text,'at',now())
              )
        WHERE id = $1`,
      [row.id, actor]
    );
    await client.query(
      `INSERT INTO activity_logs (user_name, action_type, description, module)
       VALUES ($1, 'USER_DELETED', $2, 'settings')`,
      [actor, `Deleted user account "${userDel.rows[0].username}" via OTP verification`]
    );

    await client.query("COMMIT");
    res.json({ message: "User deleted", username: userDel.rows[0].username });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[${new Date().toISOString()}] Error verifying deletion OTP:`, err.message);
    res.status(500).json({ message: "Error verifying deletion OTP", error: err.message });
  } finally {
    client.release();
  }
});

// GET /auth/users/deletion-requests (Admin only) - list pending deletion requests
app.get("/auth/users/deletion-requests", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_id, user_username, requester_username, status, reason,
              requested_at, otp_verified_at, executed_at
         FROM user_deletion_requests
        ORDER BY requested_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: "Error fetching deletion requests", error: err.message });
  }
});

// PUT /auth/users/:id/password (Admin only) - reset a user's password
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

// GET /settings - current thresholds, or defaults if none saved (public read)
app.get("/settings", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
    if (result.rows.length === 0) {
      return res.json({ temp_min: 20, temp_max: 31, water_level_min: 10, water_level_max: 100, ammonia_min: 0.25, ammonia_max: 1 });
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

// POST /settings (Admin only) - update thresholds; writes only changed fields,
// creating a row if none exists yet
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

// POST /settings/reset (Admin only) - reset thresholds to factory defaults
app.post("/settings/reset", requireAdmin, async (req, res) => {
  try {
    const defaults = { temp_min: 20, temp_max: 31, water_level_min: 10, water_level_max: 100, ammonia_min: 0.25, ammonia_max: 1 };
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
// SYSTEM LOGS ENDPOINTS
// ========================

// POST /logs - create a system log entry (action + parameter required)
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

// GET /system-logs - paginated logs with per-action counts, optional filters
app.get("/system-logs", requireAuth, async (req, res) => {
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
// ACTIVITY LOGS ENDPOINTS
// ========================

// POST /activity-logs - record a user activity event for the audit trail
app.post("/activity-logs", async (req, res) => {
  try {
    const { action_type, description, module } = req.body;
    if (!action_type) return res.status(400).json({ message: "action_type required" });

    // Derive acting user from session token; fall back to the "admin" account
    // when no valid token is present (must match a real username for the FK)
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

// GET /activity-logs - paginated, searchable, filterable activity logs (admin only)
app.get("/activity-logs", requireAdmin, async (req, res) => {
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
// ANALYTICS ENDPOINTS
// =============================================================================
// Server-computed aggregates + a lightweight rule engine that turns raw sensor
// stats into actionable suggestions. All endpoints require an authenticated
// session; sensor POST ingestion stays public for the ESP32.
// =============================================================================

const ANALYTICS_MAX_DAYS = 90;
const GAP_THRESHOLD_SECONDS = 120;   // inter-reading gap treated as a device dropout
const OFFLINE_LIMIT_MS = 5 * 60 * 1000; // device considered offline after this long without data

// Normalizes a pg DATE value (JS Date at local midnight or ISO string) to YYYY-MM-DD.
function dateToDayString(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Clamps ?days to a sane analytics window (default 7, max 90).
function analyticsDays(req) {
  const raw = parseInt(req.query.days, 10);
  if (!Number.isFinite(raw)) return 7;
  return Math.min(ANALYTICS_MAX_DAYS, Math.max(1, raw));
}

// Aggregated min/avg/max over a sensor window; invalid sentinels filtered out.
async function queryPeriodStats(startTs) {
  const result = await pool.query(
    `SELECT
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
     WHERE timestamp >= $1`,
    [startTs]
  );
  const r = result.rows[0] || {};
  return {
    temperature: { avg: Number(r.temp_avg) || 0, min: Number(r.temp_min) || 0, max: Number(r.temp_max) || 0 },
    water_level: { avg: Number(r.water_avg) || 0, min: Number(r.water_min) || 0, max: Number(r.water_max) || 0 },
    ammonia: { avg: Number(r.ammonia_avg) || 0, min: Number(r.ammonia_min) || 0, max: Number(r.ammonia_max) || 0 },
    total_readings: parseInt(r.total_readings, 10) || 0,
  };
}

// Alert stats (total/resolved/by_parameter/by_action) within a window.
async function queryAlertStats(startTs) {
  const [all, alerts] = await Promise.all([
    pool.query(
      "SELECT action, COUNT(*)::int AS count FROM system_logs WHERE timestamp >= $1 GROUP BY action",
      [startTs]
    ),
    pool.query(
      "SELECT parameter, COUNT(*)::int AS count FROM system_logs WHERE timestamp >= $1 AND action = 'Alert' GROUP BY parameter",
      [startTs]
    ),
  ]);

  const byAction = {};
  let total = 0;
  let resolved = 0;
  all.rows.forEach((row) => {
    byAction[row.action] = row.count;
    if (row.action === "Alert") total += row.count;
    if (row.action === "Alert Resolved") resolved += row.count;
  });

  const byParameter = {};
  alerts.rows.forEach((row) => { byParameter[row.parameter] = row.count; });

  return { total, resolved, by_parameter: byParameter, by_action: byAction };
}

// Counts inter-reading gaps longer than GAP_THRESHOLD_SECONDS (device dropouts).
async function queryGapEvents(startTs) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS gaps FROM (
       SELECT timestamp,
              LAG(timestamp) OVER (ORDER BY timestamp) AS prev_ts
       FROM sensors
       WHERE timestamp >= $1
     ) t
     WHERE prev_ts IS NOT NULL
       AND EXTRACT(EPOCH FROM (timestamp - prev_ts)) > $2`,
    [startTs, GAP_THRESHOLD_SECONDS]
  );
  return parseInt(result.rows[0]?.gaps, 10) || 0;
}

// Trend helper: compares two window averages and derives direction + % change.
function buildTrend(current, previous) {
  const changePct = previous > 0 ? ((current - previous) / previous) * 100 : 0;
  let direction = "stable";
  if (changePct >= 1) direction = "up";
  else if (changePct <= -1) direction = "down";
  return { current_avg: current, previous_avg: previous, change_pct: Math.round(changePct * 100) / 100, direction };
}

// GET /analytics/overview?days= - summary, trends, alerts, uptime for a window
app.get("/analytics/overview", requireAuth, async (req, res) => {
  try {
    const days = analyticsDays(req);
    const currentStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const prevStart = new Date(currentStart.getTime() - days * 24 * 60 * 60 * 1000);

    const [currentStats, prevStats, alerts, readings, gapEvents, latest] = await Promise.all([
      queryPeriodStats(currentStart),
      queryPeriodStats(prevStart),
      queryAlertStats(currentStart),
      pool.query("SELECT COUNT(*)::int AS c FROM sensors WHERE timestamp >= $1", [currentStart]),
      queryGapEvents(currentStart),
      pool.query("SELECT timestamp FROM sensors ORDER BY timestamp DESC LIMIT 1"),
    ]);

    const lastReading = latest.rows[0]?.timestamp ? new Date(latest.rows[0].timestamp) : null;
    const deviceOffline = !lastReading || (Date.now() - lastReading.getTime()) > OFFLINE_LIMIT_MS;

    res.json({
      period: { start: currentStart.toISOString(), end: new Date().toISOString() },
      days,
      summary: currentStats,
      trends: {
        temperature: buildTrend(currentStats.temperature.avg, prevStats.temperature.avg),
        water_level: buildTrend(currentStats.water_level.avg, prevStats.water_level.avg),
        ammonia: buildTrend(currentStats.ammonia.avg, prevStats.ammonia.avg),
      },
      alerts,
      uptime: {
        device_offline: deviceOffline,
        last_reading: lastReading ? lastReading.toISOString() : null,
        readings: parseInt(readings.rows[0]?.c, 10) || 0,
        gap_events: gapEvents,
      },
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching analytics overview:`, err.message);
    res.status(500).json({ message: "Error fetching analytics overview", error: err.message });
  }
});

// GET /analytics/daily?days= - per-day averages for charting (max 90)
app.get("/analytics/daily", requireAuth, async (req, res) => {
  try {
    const days = analyticsDays(req);
    const startTs = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [sensorResult, alertResult] = await Promise.all([
      pool.query(
        `SELECT
           DATE(timestamp) AS date,
           COALESCE(AVG(temperature) FILTER (WHERE temperature > 0), 0)::float AS temp_avg,
           COALESCE(AVG(water_level) FILTER (WHERE water_level >= 0), 0)::float AS water_avg,
           COALESCE(AVG(ammonia) FILTER (WHERE ammonia >= 0), 0)::float AS ammonia_avg,
           COUNT(*)::int AS readings
         FROM sensors
         WHERE timestamp >= $1
         GROUP BY DATE(timestamp)
         ORDER BY date`,
        [startTs]
      ),
      pool.query(
        `SELECT DATE(timestamp) AS date, COUNT(*)::int AS count
         FROM system_logs
         WHERE timestamp >= $1 AND action = 'Alert'
         GROUP BY DATE(timestamp)`,
        [startTs]
      ),
    ]);

    const alertMap = {};
    alertResult.rows.forEach((row) => {
      alertMap[dateToDayString(row.date)] = row.count;
    });

    const daily = sensorResult.rows.map((row) => ({
      date: dateToDayString(row.date),
      temp_avg: Number(row.temp_avg) || 0,
      water_avg: Number(row.water_avg) || 0,
      ammonia_avg: Number(row.ammonia_avg) || 0,
      readings: parseInt(row.readings, 10) || 0,
      alerts: alertMap[dateToDayString(row.date)] || 0,
    }));

    res.json({
      period: { start: startTs.toISOString(), end: new Date().toISOString() },
      days,
      daily,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching analytics daily:`, err.message);
    res.status(500).json({ message: "Error fetching analytics daily", error: err.message });
  }
});

// Rule engine: turns an analytics overview + thresholds into suggestions.
// Each insight has a level (info/warning/critical), an area, a title, a message
// and an optional actionable hint. Mirrors getThresholdStatus() semantics.
function generateInsights(overview, thresholds) {
  const insights = [];
  const { summary, trends, alerts, uptime } = overview;
  const t = thresholds;

  const push = (level, area, title, message, action) => insights.push({ level, area, title, message, action });

  // ---- Device health ----
  if (uptime.device_offline) {
    push(
      "critical", "device",
      "Device offline",
      uptime.last_reading
        ? `No data received since ${new Date(uptime.last_reading).toLocaleString()}.`
        : "No sensor readings have been recorded yet.",
      "Check ESP32 power, Wi-Fi, and USB connections."
    );
  } else if (uptime.gap_events > 0) {
    const perDay = Math.round((uptime.gap_events / overview.days) * 10) / 10;
    push(
      perDay > 2 ? "warning" : "info", "device",
      "Data gaps detected",
      `${uptime.gap_events} dropout(s) in the last ${overview.days} days (${perDay}/day).`,
      "Verify the ESP32 stays powered and within Wi-Fi range."
    );
  }

  // ---- Temperature ----
  const temp = summary.temperature;
  if (temp.avg > 0) {
    if (temp.avg > t.temp_max) {
      push("critical", "temperature", "Temperature too high",
        `Average ${temp.avg.toFixed(1)}°C exceeds the ${t.temp_max}°C maximum.`,
        "Increase aeration/cooling and monitor for stress."
      );
    } else if (temp.avg < t.temp_min) {
      push("warning", "temperature", "Temperature below target",
        `Average ${temp.avg.toFixed(1)}°C is below the ${t.temp_min}°C minimum.`,
        "Check the heater and insulate the tank."
      );
    } else if (trends.temperature.direction === "up") {
      push("info", "temperature", "Temperature trending up",
        `Rising ${trends.temperature.change_pct}% toward the ${t.temp_max}°C limit.`,
        "Watch for overheating; consider additional aeration."
      );
    }
  }

  // ---- Water level ----
  const water = summary.water_level;
  if (trends.water_level.direction === "down") {
    push("warning", "water_level", "Water level dropping",
      `Average fell ${Math.abs(trends.water_level.change_pct)}% over the period.`,
      "Likely evaporation — top up the tank."
    );
  }
  if (water.avg > 0 && water.avg < t.water_level_min) {
    push("critical", "water_level", "Water level too low",
      `Average ${water.avg.toFixed(0)}% is below the ${t.water_level_min}% minimum.`,
      "Refill to restore the safe operating range."
    );
  }

  // ---- Ammonia ----
  const ammonia = summary.ammonia;
  if (ammonia.avg > 0) {
    if (ammonia.avg >= t.ammonia_max) {
      push("critical", "ammonia", "Ammonia at or above maximum",
        `Average ${ammonia.avg.toFixed(2)} ppm hits the ${t.ammonia_max} ppm limit.`,
        "Perform a partial water change and check biofiltration."
      );
    } else if (ammonia.avg >= t.ammonia_max * 0.75) {
      push("warning", "ammonia", "Ammonia rising risk",
        `Average ${ammonia.avg.toFixed(2)} ppm is close to the ${t.ammonia_max} ppm limit.`,
        "Plan a water change soon and verify filter media."
      );
    } else if (trends.ammonia.direction === "up") {
      push("info", "ammonia", "Ammonia trending up",
        `Ammonia rose ${trends.ammonia.change_pct}% over the period.`,
        "Monitor closely; a build-up may follow overfeeding."
      );
    }
  }

  // ---- Alerts ----
  if (alerts.total > 0 && alerts.resolved === 0) {
    push("warning", "system", "Active alerts unresolved",
      `${alerts.total} alert(s) fired and none resolved within the period.`,
      "Review the Alerts page and confirm the tank has recovered."
    );
  }
  if (alerts.by_parameter?.Ammonia) {
    push("warning", "ammonia", "Frequent ammonia alerts",
      `${alerts.by_parameter.Ammonia} ammonia alert(s) in the last ${overview.days} days.`,
      "Check feeding load and biofilter health."
    );
  }

  return insights;
}

// GET /analytics/insights?days= - rule-engine suggestions for the period
app.get("/analytics/insights", requireAuth, async (req, res) => {
  try {
    const days = analyticsDays(req);
    const currentStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [currentStats, prevStats, alerts, readings, gapEvents, latest, settingsResult] = await Promise.all([
      queryPeriodStats(currentStart),
      queryPeriodStats(new Date(currentStart.getTime() - days * 24 * 60 * 60 * 1000)),
      queryAlertStats(currentStart),
      pool.query("SELECT COUNT(*)::int AS c FROM sensors WHERE timestamp >= $1", [currentStart]),
      queryGapEvents(currentStart),
      pool.query("SELECT timestamp FROM sensors ORDER BY timestamp DESC LIMIT 1"),
      pool.query("SELECT * FROM sensor_settings LIMIT 1"),
    ]);

    const settings = settingsResult.rows[0] || { temp_min: 20, temp_max: 31, water_level_min: 10, water_level_max: 100, ammonia_min: 0.25, ammonia_max: 1 };

    const lastReading = latest.rows[0]?.timestamp ? new Date(latest.rows[0].timestamp) : null;
    const overview = {
      days,
      summary: currentStats,
      trends: {
        temperature: buildTrend(currentStats.temperature.avg, prevStats.temperature.avg),
        water_level: buildTrend(currentStats.water_level.avg, prevStats.water_level.avg),
        ammonia: buildTrend(currentStats.ammonia.avg, prevStats.ammonia.avg),
      },
      alerts,
      uptime: {
        device_offline: !lastReading || (Date.now() - lastReading.getTime()) > OFFLINE_LIMIT_MS,
        last_reading: lastReading ? lastReading.toISOString() : null,
        readings: parseInt(readings.rows[0]?.c, 10) || 0,
        gap_events: gapEvents,
      },
    };

    res.json({
      period: { start: currentStart.toISOString(), end: new Date().toISOString() },
      days,
      insights: generateInsights(overview, {
        temp_min: Number(settings.temp_min),
        temp_max: Number(settings.temp_max),
        water_level_min: Number(settings.water_level_min),
        water_level_max: Number(settings.water_level_max),
        ammonia_min: Number(settings.ammonia_min ?? 0),
        ammonia_max: Number(settings.ammonia_max ?? 25),
      }),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching analytics insights:`, err.message);
    res.status(500).json({ message: "Error fetching analytics insights", error: err.message });
  }
});

// =============================================================================
// SERVER STARTUP
// =============================================================================
// Connects to PostgreSQL, ensures an admin account, restores alert state from
// the DB, and starts the HTTP listener.

// Runs initialization and starts the HTTP listener
async function startServer() {
  try {
    const client = await pool.connect();
    try {
      console.log(`[${new Date().toISOString()}] PostgreSQL connected`);

      // Create default admin if none exists; ADMIN_INITIAL_PASSWORD is REQUIRED
      // so a known default credential is never shipped. The plaintext is never logged.
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

      // Restore alert dedup state from DB (survives server restarts)
      const lastAlertsResult = await client.query("SELECT * FROM last_alerts");
      lastAlertedState = {};
      for (const row of lastAlertsResult.rows) {
        lastAlertedState[`${row.device_id}:${row.sensor_key}`] = { status: row.status, value: parseFloat(row.value), timestamp: row.timestamp?.toISOString() };
      }
      console.log(`[${new Date().toISOString()}] Loaded ${lastAlertsResult.rows.length} alert states from DB`);

      // Seed ammonia spike guard with the latest reading per device
      const lastAmmoniaResult = await client.query(
        "SELECT DISTINCT ON (device_id) device_id, ammonia FROM sensors WHERE ammonia > 0 ORDER BY device_id, timestamp DESC"
      );
      lastAmmoniaReading = {};
      for (const row of lastAmmoniaResult.rows) {
        lastAmmoniaReading[row.device_id] = Number(row.ammonia);
      }
      console.log(`[${new Date().toISOString()}] Loaded ammonia baseline for ${lastAmmoniaResult.rows.length} device(s) from DB`);
    } finally {
      client.release();
    }

    // Listen for HTTP requests on all network interfaces
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[${new Date().toISOString()}] Server running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Server startup error:`, err.message);
    process.exit(1);
  }
}

startServer();

// =============================================================================
// GLOBAL ERROR HANDLERS
// =============================================================================
// Catch errors that escape try/catch so the server never crashes silently.

// Log unhandled promise rejections to avoid crashing on uncaught async errors
process.on("unhandledRejection", (reason) => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection:`, reason);
});

// Log uncaught exceptions and exit so PM2/systemd can restart cleanly
process.on("uncaughtException", (err) => {
  console.error(`[${new Date().toISOString()}] Uncaught exception:`, err.message);
  process.exit(1);
});
