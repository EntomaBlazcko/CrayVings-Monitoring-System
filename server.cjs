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
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// SMS gateway circuit breaker (services/smsService.cjs) - stops hammering the
// HTTPSMS gateway after repeated failures and exposes state via sms-health.
const { smsCircuitBreaker, sendSmsWithBreaker } = require("./services/smsService.cjs");
const { startDevicePoller } = require("./services/devicePoller.cjs");

// ========================
// EXPRESS APP SETUP
// ========================
const app = express();
const PORT = process.env.PORT || 3000;

// Where the built dashboard lives. Declared up here rather than next to the
// static handler because GET / (registered with the API, far above it) has to
// know whether a build exists in order to decide between the app and the API
// identification message.
const DIST_DIR = path.join(__dirname, "dist");
const INDEX_HTML = path.join(DIST_DIR, "index.html");

// ========================
// POSTGRESQL CONNECTION POOL
// ========================
// Pool config read from environment variables (.env). Sized for the dashboard
// (concurrent browsers polling history/devices) plus ingestion bursts.
const pool = new Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  max: 20,                      // max clients in the pool
  idleTimeoutMillis: 30000,     // free idle clients after 30s
  connectionTimeoutMillis: 5000 // fail fast if a client cannot be acquired
});

// Idle-client errors (network blips, DB restarts) must not crash the process.
pool.on("error", (err) => {
  console.error(`[${new Date().toISOString()}] Unexpected PostgreSQL pool error:`, err.message);
});

// Verify the database is reachable, retrying with exponential backoff so a
// slow-starting DB (container restart, network blip) does not kill the server.
async function waitForDatabase(attempts = 5, baseDelayMs = 2000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await pool.query("SELECT NOW()");
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[${new Date().toISOString()}] DB connection attempt ${attempt}/${attempts} failed (${err.message}); retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Production guard: the CORS allowlist must be explicit in production so the
// API is never accidentally exposed cross-origin.
if (process.env.NODE_ENV === "production" && !process.env.ALLOWED_ORIGINS) {
  console.error("ALLOWED_ORIGINS must be set in production (comma-separated frontend origins)");
  process.exit(1);
}

// CORS restricted to ALLOWED_ORIGINS allowlist; requests without an
// Origin header (ESP32, curl) are allowed.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header (ESP32, curl, the test harness) or an allowlisted
      // origin: let the request through and let CORS decide whether the
      // *browser* may read the response.
      //
      // A disallowed origin resolves to false rather than to an Error. Throwing
      // here used to land in the global error handler and answer 500, which
      // reads as a server fault and makes a rejected cross-origin request
      // indistinguishable from a crash. With false there are simply no CORS
      // headers, so the browser blocks the read, and the CSRF guard below owns
      // the actual refusal (403) for anything that tries to change state.
      callback(null, !origin || allowedOrigins.includes(origin));
    },
  })
);
// 10kb body limit prevents oversized-payload memory abuse (ESP32 payloads are tiny)
app.use(express.json({ limit: "10kb" }));

// Security headers (audit 2.5.5). CSP allows the dashboard's own origin plus
// every CORS-allowed frontend origin for XHR/SSE connections.
const helmet = require("helmet");
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", ...allowedOrigins],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

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
  windowMs: 15 * 60 * 1000,   // 15 minutes
  limit: 5,                   // 5 login attempts / 15 min / IP (brute-force guard)
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again later." },
  validate: { xForwardedForHeader: false },
});

// Per-device limiter for sensor ingestion (audit 2.2.5/2.5.2). The normal send
// rate is 1/second, but the offline-buffer flush posts up to 10 back-to-back
// plus the live reading, so the limit must leave burst headroom: 12/second
// still blocks a flooding device while letting a reconnect drain its backlog.
// Keyed by device_id; posts without a device_id share one bucket and fail
// validation anyway.
const sensorIngestLimiter = rateLimit({
  windowMs: 1000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.body && typeof req.body.device_id === "string" ? `device:${req.body.device_id}` : "device:unknown",
  message: { message: "Device ingestion rate limit exceeded" },
  validate: { xForwardedForHeader: false },
});

app.use(globalLimiter);

// =============================================================================
// /api PREFIX
// =============================================================================
// The frontend is built with API_BASE="/api" so that one compiled bundle works
// unchanged in both places: Vite proxies /api to this server in dev, and in
// production this server serves dist/ itself, so /api is already same-origin.
// Stripping the prefix here (rather than in the Vite proxy) keeps one
// authoritative copy of the routing table.
//
// Bare paths stay live on purpose - the ESP32 firmware posts to /sensor and
// every suite in tests/ calls the unprefixed routes.
app.use((req, res, next) => {
  if (req.url === "/api" || req.url.startsWith("/api/") || req.url.startsWith("/api?")) {
    req.url = req.url.slice(4) || "/";
    // Remember where it came from. Once the prefix is gone the SPA fallback
    // below can no longer tell a mistyped API call (/api/devcies) from a React
    // Router deep link, and answering the former with index.html would hand the
    // client an HTML bundle where it expects JSON.
    req.wasApiPrefixed = true;
  }
  next();
});

// =============================================================================
// CSRF GUARD
// =============================================================================
// SameSite=Lax is the primary defence: a cross-site POST cannot make the browser
// attach the session cookie at all, so the request arrives anonymous. This is
// the second, independent layer, and it exists because Lax has one documented
// blind spot - a sibling subdomain or a different port on the same registrable
// domain is "same-site" but cross-origin, and Lax will happily attach the
// cookie there.
//
// Origin is checked only on state-changing verbs, and only when the request
// actually carries one. No Origin header means the caller is not a browser:
// the ESP32s, curl and the test harness all look like that, and blocking them
// would break device ingestion to defend against an attack they cannot mount.
// A browser, by contrast, always attaches Origin to a cross-origin POST - that
// is precisely what makes it detectable.
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

app.use((req, res, next) => {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  if (!origin) return next();

  // Same-origin is the normal case and needs no allowlist entry: the browser
  // sends the Host the request actually reached.
  const host = req.headers.host;
  let sameOrigin = false;
  if (host) {
    try {
      sameOrigin = new URL(origin).host === host;
    } catch {
      sameOrigin = false;
    }
  }
  if (sameOrigin || allowedOrigins.includes(origin)) return next();

  return res.status(403).json({ message: `Cross-origin ${req.method} blocked` });
});

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

// Session tokens are stored HASHED (SHA-256) so a DB read (backup leak,
// pgAdmin access) can never impersonate a user. Clients keep the raw token;
// every comparison hashes the presented value first. Migration 013 hashed
// existing sessions in place, so live logins survive the switch.
function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

// =============================================================================
// SESSION COOKIE
// =============================================================================
// The raw token used to be handed to the browser in a JSON body and parked in
// localStorage, where any XSS on any page could read it out and replay it from
// anywhere. It now travels in an HttpOnly cookie, which JavaScript cannot touch
// at all - `document.cookie` does not expose it and there is no read primitive.
//
// SameSite=Lax (not None) is the load-bearing part. The dashboard and the API
// are same-origin now - Vite proxies /api in dev and Express serves dist/ in
// production - so Lax lets the browser attach the cookie to our own fetches
// while refusing to attach it to a cross-site POST. That refusal is the CSRF
// defence, enforced by the browser rather than by anything we have to remember
// to check. Lax still permits top-level GET navigation, which is why the
// deep-link GET routes keep working after a hard refresh.
//
// The one caveat Lax cannot cover is same-site-but-cross-origin (a sibling
// subdomain, or a different port on the same registrable domain), so the Origin
// check below is kept as a second, independent layer on state-changing verbs.
const SESSION_COOKIE = "crayvings_session";

// No TTL constant of its own on purpose: setSessionCookie takes the same
// tokenExpiresAt that is written to the users row, so the cookie and the token
// expire at one instant and cannot drift apart into a cookie that outlives the
// session behind it.
//
// Only meaningful when the dashboard is served over HTTPS. Left off by default
// because the dev server and a LAN demo run on http://localhost, where the
// Secure attribute would make the browser discard the cookie outright.
const COOKIE_SECURE = /^(1|true|yes)$/i.test(String(process.env.COOKIE_SECURE || ""));

// Minimal Cookie header parser. Deliberately not cookie-parser: the session
// cookie is the only one we read, and adding a dependency for one split() is
// not worth the supply-chain surface.
function readCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed percent-escape is not worth a 500; treat it as absent.
    }
  }
  return out;
}

function setSessionCookie(res, token, expiresAt) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (COOKIE_SECURE) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res) {
  // Max-Age=0 is the reliable delete: it does not depend on the browser
  // comparing Expires against a clock the two sides might disagree about.
  res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// =============================================================================
// ERROR RESPONSES
// =============================================================================
// Every 5xx used to answer with `{ message, error: err.message }`, which handed
// the client raw Postgres and Express internals: constraint names, column lists,
// and on /auth/login enough to fingerprint the authentication query itself. The
// detail belongs in the server log, where it is actionable, not in a JSON body
// that gets copied into a bug report.
//
// `message` stays exactly as specific as it was - it is written by us and says
// what the caller can do about it - so clients keep their existing handling.
function fail(res, status, message, err, req) {
  console.error(
    `[${new Date().toISOString()}] ${req ? `${req.method} ${req.originalUrl}` : "server"} -> ${status}: ${message}`,
    err
  );
  return res.status(status).json({ message });
}

// =============================================================================
// AUTHENTICATION MIDDLEWARE
// =============================================================================
// requireAdmin validates the session AND checks the admin role;
// requireAuth validates the session only. Both attach the user to req.
//
// A session can arrive two ways, in priority order:
//   1. the HttpOnly cookie  - the dashboard, and the only path a browser uses
//   2. Authorization: Bearer - ESP32s, curl, and every test suite
//
// The `?token=` query parameter that /sensor/stream used to accept is gone:
// EventSource is same-origin now, so the stream receives the cookie like every
// other request, and no token rides in a URL that access logs would record.
//
// Bearer is kept deliberately rather than deleted: it is what lets the firmware
// and the harness authenticate without pretending to be a browser. It needs no
// CSRF consideration of its own - a browser cannot attach an Authorization
// header cross-origin without CORS approval, and an attacker who already holds
// a stolen token gains nothing from forging a request that carries it.
//
// Returns viaCookie so the caller can clear a cookie that no longer matches
// anything; a Bearer caller has no cookie to clear.
function readSession(req) {
  const cookies = readCookies(req);
  if (cookies[SESSION_COOKIE]) {
    return { token: cookies[SESSION_COOKIE], viaCookie: true };
  }
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return { token: header.slice(7), viaCookie: false };
  }
  return { token: null, viaCookie: false };
}

// Validates session and admin role; attaches user to req.adminUser
function requireAdmin(req, res, next) {
  const { token, viaCookie } = readSession(req);
  if (!token) return res.status(401).json({ message: "Authentication required" });

  pool.query("SELECT * FROM users WHERE token = $1 AND status = 'active'", [hashToken(token)])
    .then(async result => {
      if (result.rows.length === 0) return res.status(403).json({ message: "Invalid token" });
      const user = result.rows[0];
      if (user.role !== "admin") return res.status(403).json({ message: "Admin access required" });
      if (user.token_expires_at && new Date(user.token_expires_at) <= new Date()) {
        await pool.query("UPDATE users SET token = NULL, token_expires_at = NULL WHERE id = $1", [user.id]);
        // Only meaningful for a browser session; a Bearer caller holds no cookie
        // to expire, so there is nothing to tell it.
        if (viaCookie) clearSessionCookie(res);
        return res.status(401).json({ message: "Session expired, please log in again" });
      }
      req.adminUser = user;
      next();
    })
    .catch(err => fail(res, 500, "Auth error", err, req));
}

// Validates the token and attaches the user to req.adminUser (admin role required)
// Used by all admin-gated routes.
app._deleteUserHard = async (userId, actorUsername) => {
  // Soft-delete (archive) with audit: called only after email-OTP approval.
  // The row is kept so it can be restored later; status flips to 'archived'.
  const reqResult = await pool.query(
    `UPDATE users SET status = 'archived', deleted_at = NOW(), pending_deletion_at = NULL
      WHERE id = $1 RETURNING id, username`,
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
  const { token, viaCookie } = readSession(req);
  if (!token) return res.status(401).json({ message: "Authentication required" });

  pool.query("SELECT * FROM users WHERE token = $1 AND status = 'active'", [hashToken(token)])
    .then(async result => {
      if (result.rows.length === 0) {
        // A cookie that no longer matches any session must be actively cleared,
        // or the browser keeps replaying it on every request and every retry
        // ends in the same 403. Bearer callers have no cookie to clear.
        if (viaCookie) clearSessionCookie(res);
        return res.status(403).json({ message: "Invalid token" });
      }
      const user = result.rows[0];
      if (user.token_expires_at && new Date(user.token_expires_at) <= new Date()) {
        await pool.query("UPDATE users SET token = NULL, token_expires_at = NULL WHERE id = $1", [user.id]);
        clearSessionCookie(res);
        return res.status(401).json({ message: "Session expired, please log in again" });
      }
      req.user = user;
      next();
    })
    .catch(err => fail(res, 500, "Auth error", err, req));
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

// Single merged email for account deletion: carries the OTP code AND tells the
// account owner exactly who requested the deletion and which account is targeted,
// so no separate after-the-fact notification is needed. OTP_EMAIL determines the
// recipient; context (actor/target) is embedded from the request.
async function sendOtpEmail({ to, code, actorUsername, actorName, targetUsername, deletedByOwner }) {
  const actorLabel = actorName && actorName.trim()
    ? `${actorName.trim()} (${actorUsername})`
    : actorUsername;

  const namesText = deletedByOwner
    ? `Account to be deleted: ${targetUsername}`
    : `Admin account that requested the deletion: ${actorLabel}
Account to be deleted: ${targetUsername}

If you did not expect this request, we recommend reviewing recent account activity within the system.`;

  const namesHtmlRows = deletedByOwner
    ? `<tr style="background:#fef3ec;"><td style="padding:8px 12px;font-weight:bold;">Account to be deleted</td><td style="padding:8px 12px;">${escapeHtml(targetUsername)}</td></tr>`
    : `<tr style="background:#fef3ec;"><td style="padding:8px 12px;font-weight:bold;">Admin account that requested the deletion</td><td style="padding:8px 12px;">${escapeHtml(actorLabel)}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;">Account to be deleted</td><td style="padding:8px 12px;">${escapeHtml(targetUsername)}</td></tr>`;

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
    subject: "Account Deletion Verification — CRAYvings Monitoring System",
    text: `Dear Administrator,

You are receiving this message because a request was made to permanently delete a user account in the CRAYvings Monitoring System.

${namesText}

To complete this action, please enter the six-digit verification code below:

    ${code}

This code will expire in 10 minutes and is intended for the account owner only. For your security, do not share it with anyone. CRAYvings personnel will never ask you for this code.

If you did not initiate this request, no further action is required. If the request was unexpected, we recommend reviewing recent account activity within the system.

Thank you,

CRAYvings Monitoring System`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#374151;font-size:14px;line-height:1.6;">
  <div style="background:linear-gradient(90deg,#d94b1e,#ef6a2e);color:#ffffff;padding:18px 24px;font-size:18px;font-weight:bold;border-radius:8px 8px 0 0;">
    CRAYvings Monitoring System
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p>Dear Administrator,</p>
    <p>You are receiving this message because a request was made to <strong>permanently delete a user account</strong> in the CRAYvings Monitoring System.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      ${namesHtmlRows}
    </table>
    <p>To complete this action, please enter the six-digit verification code below:</p>
    <div style="background:#fef3ec;border:2px dashed #d94b1e;border-radius:8px;padding:16px;text-align:center;margin:20px 0;">
      <span style="font-family:'Courier New',monospace;font-size:32px;font-weight:bold;letter-spacing:8px;color:#d94b1e;">${code}</span>
    </div>
    <p style="color:#ef6a2e;font-weight:bold;">This code will expire in 10 minutes and is intended for the account owner only.</p>
    <p>For your security, do not share this code with anyone. CRAYvings personnel will never ask you for it.</p>
    ${deletedByOwner ? "" : "<p>If you did not expect this request, we recommend reviewing recent account activity within the system.</p>"}
    <p>If you did not initiate this request, no further action is required. If the request was unexpected, we recommend reviewing recent account activity within the system.</p>
    <p>Thank you,</p>
    <p style="font-weight:bold;">CRAYvings Monitoring System</p>
  </div>
</div>`,
  });
  return { delivered: true };
}

// =============================================================================
// PROTECTED OWNER ADMIN
// =============================================================================
// The owner is the single privileged account (bootstrapped on a fresh DB) and
// can never be deleted — neither directly nor as "the last admin" — so the
// system can't accidentally be locked out. Identified purely from env; no
// credential is hardcoded in source.
const OWNER_USERNAME = (process.env.ADMIN_USERNAME || "").trim();
const OWNER_EMAIL = (process.env.ADMIN_EMAIL || "").trim();

// True when the given user IS the owner account (matched on username or email).
function isOwnerUser(user) {
  return Boolean(
    (OWNER_USERNAME && user.username === OWNER_USERNAME) ||
    (OWNER_EMAIL && user.email === OWNER_EMAIL)
  );
}

// Returns an error message when a user must NOT be deleted (the owner, or the
// last remaining admin), otherwise null. `executor` lets the guard run inside a
// caller's transaction without leaking reads out of that transaction.
async function assertUserDeletable(userRow, executor = pool) {
  if (isOwnerUser(userRow)) {
    return "The owner account cannot be deleted.";
  }
  if (userRow.role === "admin") {
    const count = await executor.query(
      "SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'"
    );
    if (count.rows[0].n <= 1) return "Cannot delete the last admin account.";
  }
  return null;
}

// Escapes a value for safe embedding inside the HTML email template.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
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
// INPUT VALIDATION SCHEMAS (Zod)
// =============================================================================
// ESP32 marks failed sensors with -1 (and 0 for temperature), so lower bounds
// must accept those sentinel values.

// POST /sensor (ESP32 ingestion). Both firmwares convert the DS18B20's -127
// disconnect code to -1 before sending, so the WIRE sentinels are: temperature
// -1 or 0, water_level -1, ammonia -1. The schema accepts them (the heartbeat
// must keep flowing), and readingOrNull converts them to NULL before the DB
// write so failed sensors never pollute the time-series data (audit 2.2.2).
const sensorSchema = z.object({
  device_id: z.string().min(1).max(50),
  // Accepts -127 (raw DS18B20 code, in case a firmware variant sends it) and
  // the -1/0 wire sentinels; physical range is -10..50.
  temperature: z.coerce.number().min(-127).max(50),
  // -1 is the HC-SR04 failed-sensor sentinel.
  water_level: z.coerce.number().min(-1).max(100),
  // ammonia is a real NH3 gas reading in ppm (MQ-137). Upper bound covers
  // the full datasheet range (5-500 ppm); -1 is the failed-sensor sentinel.
  ammonia: z.coerce.number().min(-1).max(500).optional(),
  // Optional device-side capture time (ISO 8601, SNTP-synced on the ESP32).
  // Sanitized below: not in the future, not older than the offline buffer.
  read_at: z.string().max(40).optional(),
});

// Converts a raw sensor value to null when it is a failed-sensor sentinel.
// Temperature <= 0 is treated as a failure: the farm is tropical (water never
// freezes) and both the client chart filter (>= 0.0001) and the alert engine
// (minValid 0.0001) already treat it that way, so aggregates stay consistent.
function readingOrNull(key, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (key === "temperature") return value > 0 ? value : null;
  return value >= 0 ? value : null;
}

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

// POST /devices (Owner-issued registration from the Devices page).
//
// Registration is a MANUAL, offline-adjacent process: the team flashes each
// ESP32 by hand, so the board is only ever "known" to the server once an Owner
// types its identity here. There is no auto-provisioning and no web flasher.
//
// device_id must be unique SYSTEM-WIDE, including against archived rows: a
// device_id is permanently retired once used. Reusing one would make a
// replacement board silently inherit the dead board's entire `sensors` history
// through the FK. Enforced by the PK, by idx_devices_device_id_ci (case-
// insensitive), and by an explicit pre-check in the handler.
//
// The charset mirrors what the firmware compiles into the board (ESP32_main_code.ino
// uses ids like "ESP32_01"); it stays permissive enough for a MAC-style or
// dotted id but rejects whitespace and anything that would need escaping.

// True for a bare IPv4 literal. The health poller interpolates this value
// straight into a URL (http://<ip>/status), so it is validated as a real
// address rather than free text — that stops a rogue value from redirecting the
// poller somewhere unintended.
function isIpv4(value) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  return !!m && m.slice(1).every((octet) => Number(octet) >= 0 && Number(octet) <= 255);
}

// An empty form field means "not supplied", not "empty string".
const blankToUndefined = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const createDeviceSchema = z.object({
  device_id: z.string()
    .trim()
    .min(1, "Device ID is required")
    .max(50, "Device ID must be 50 characters or fewer")
    .regex(/^[A-Za-z0-9._-]+$/, "Device ID may contain only letters, numbers, dots, dashes and underscores"),
  // The form's single "Device Name" field. `tank_name` is the label every
  // surface already renders (tankOptionLabel on the client); `name` is the
  // column the schema documents as the friendly name but which no code path ever
  // wrote, so it is filled here too rather than staying permanently NULL.
  device_name: z.string()
    .trim()
    .min(1, "Device name is required")
    .max(100, "Device name must be 100 characters or fewer"),
  // Optional. Left as 'auto' when blank so the first ingest can learn the
  // address instead of us guessing.
  ip_address: z.preprocess(
    blankToUndefined,
    z.string().trim()
      .refine(isIpv4, "IP address must be a valid IPv4 address (e.g. 192.168.100.27)")
      .optional()
  ),
  tank_location: z.preprocess(
    blankToUndefined,
    z.string().trim()
      .max(100, "Location must be 100 characters or fewer")
      .optional()
  ),
});

// Converts a ZodError into a readable field-errors object
function zodFieldErrors(err) {
  const flat = err.flatten();
  return flat.fieldErrors || {};
}

// Coerces a report/analytics aggregate to a number, or to null when there is
// nothing to report. A failed sensor is stored as NULL, so a window with no
// valid readings aggregates to NULL - and Number(null) is 0, which would render
// a tank with a dead probe as a confidently healthy "0.0". The `|| 0` idiom
// that used to stand here did exactly that, in SQL and again in JS, so the fake
// zero had to be removed from both layers.
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalises the peer address of an inbound request into a bare address that
// can be handed to the device poller and put straight into a URL.
//
// Node reports an IPv4 peer on a dual-stack listener as the IPv4-mapped IPv6
// address "::ffff:192.168.100.27", which is useless as a URL host and does not
// match what an admin would type into the devices table. Link-local addresses
// can also carry a zone index ("fe80::1%eth0") that has no meaning off-host.
// Collapsing both means devices.ip_address always holds something the poller
// can actually dial.
//
// This is re-derived from the live socket on EVERY sensor POST rather than
// configured once, because a device that roams between WiFi networks - or an
// end user who re-points their own router - changes address without warning.
// Refreshing it per POST makes the registry self-healing instead of leaving a
// stale address that silently breaks fleet health checks.
function normalizeClientIp(req) {
  const raw = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || "";
  let ip = String(raw).trim();
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }
  const zone = ip.indexOf("%");
  if (zone !== -1) {
    ip = ip.slice(0, zone);
  }
  if (ip === "::1") {
    ip = "127.0.0.1";
  }
  // A loopback peer is never a real device on the farm - it is a local test
  // (curl, scripts/mock-device.js) talking to us from this same machine.
  // Recording it would point the health poller back at ourselves, so it would
  // dial http://127.0.0.1/status, get ECONNREFUSED or - worse - this server's
  // own /status, and raise a device_id mismatch warning for a device that is
  // perfectly healthy. Returning null lets the upsert's COALESCE keep whatever
  // real address the device last reported.
  if (ip === "127.0.0.1") {
    return null;
  }
  return ip.length > 0 ? ip : null;
}

// =============================================================================
// SMS ALERTS (HTTPSMS)
// =============================================================================
// Alerts and system-status updates are sent through https://httpsms.com — an
// Android phone running the HttpSms app acts as the SMS gateway. The gateway
// SIM's number is HTTPSMS_FROM (E.164, Philippine: +639XXXXXXXXXX). Recipients
// are the active authorized_recipients rows managed from Settings. Every send
// attempt (success or failure) is recorded in sms_logs for auditing.

const HTTPSMS_API_KEY = (process.env.HTTPSMS_API_KEY || "").trim();
const HTTPSMS_FROM = (process.env.HTTPSMS_FROM || "").trim();
const HTTPSMS_API_URL = "https://api.httpsms.com/v1/messages/send";
const HTTPSMS_MESSAGES_URL = "https://api.httpsms.com/v1/messages";

// Accepts a Philippine number written the local way (09XXXXXXXXX), the E.164 way
// (+639XXXXXXXXX), or with a missing leading plus (639XXXXXXXXX) — strips spaces,
// dashes, and parentheses — and returns the canonical +639XXXXXXXXX, or null when
// the number does not look like a valid PH mobile number.
function normalizePhNumber(input) {
  const n = String(input || "").trim().replace(/[\s\-()]/g, "");
  if (/^09\d{9}$/.test(n)) return `+63${n.slice(1)}`;   // 09XXXXXXXXX (11 digits)
  if (/^\+639\d{9}$/.test(n)) return n;                  // already E.164
  if (/^639\d{9}$/.test(n)) return `+${n}`;              // missing plus
  return null;
}

// Cooldown between repeated critical SMS per sensor (ms)
const SMS_COOLDOWN_MS = parseInt(process.env.SMS_COOLDOWN_MS) || 300000;
const HOURLY_SMS_ENABLED = process.env.HOURLY_SMS_ENABLED !== "false";
const HOURLY_SMS_INTERVAL_MS = parseInt(process.env.HOURLY_SMS_INTERVAL_MS) || 3600000;
const DEVICE_DISCONNECT_ENABLED = process.env.DEVICE_DISCONNECT_ENABLED !== "false";
const DISCONNECT_STALE_MS = parseInt(process.env.DISCONNECT_STALE_MS) || 30000;
// After a device recovers (reconnects after a disconnect), it must stay online
// at least this long before a NEW disconnect SMS becomes eligible again — keeps
// a briefly-flickering ESP32 from spamming the same alert over and over.
const DISCONNECT_REARM_MS = parseInt(process.env.DISCONNECT_REARM_MS) || 300000;

// Change-only (delta) sensor logging: a sensors row is inserted only when a
// parameter differs from the last stored reading beyond its per-sensor tolerance.
// Unchanged readings still refresh devices.last_seen (heartbeat) but write no row.
const DELTA_LOGGING_ENABLED = process.env.DELTA_LOGGING_ENABLED !== "false";
const DELTA_TOLERANCES = {
  temperature: Number.isFinite(parseFloat(process.env.TEMP_DELTA_TOLERANCE))
    ? parseFloat(process.env.TEMP_DELTA_TOLERANCE)
    : 0.1,
  water_level: Number.isFinite(parseFloat(process.env.WATER_LEVEL_DELTA_TOLERANCE))
    ? parseFloat(process.env.WATER_LEVEL_DELTA_TOLERANCE)
    : 1,
  ammonia: Number.isFinite(parseFloat(process.env.AMMONIA_DELTA_TOLERANCE))
    ? parseFloat(process.env.AMMONIA_DELTA_TOLERANCE)
    : 0.05,
};

// Daily SMS budget: counts every real send today (0 disables the cap). Once the
// budget is exhausted, producers log "capped" rows instead of sending, so the
// audit trail stays honest. Manual/test SMS bypass this cap by design.
const rawSmsCap = parseInt(process.env.SMS_DAILY_CAP, 10);
const SMS_DAILY_CAP = Number.isFinite(rawSmsCap) && rawSmsCap >= 0 ? rawSmsCap : 100;

// Delivery poller: reconciles "queued" sms_logs rows against the httpsms message
// list endpoint and marks them delivered/failed. Retries happen inside httpsms
// (send_attempt_count/max_send_attempts); we only observe the final outcome.
const SMS_DELIVERY_POLL_MS = parseInt(process.env.SMS_DELIVERY_POLL_MS, 10) || 45000;
// Only reconcile messages sent within this window — older sends are settled.
const SMS_POLL_WINDOW_MS = 6 * 60 * 60 * 1000;
// Purge sms_logs rows older than this many days (0 disables purging)
const SMS_RETENTION_DAYS = envDays("SMS_RETENTION_DAYS", 30);

// SMS mute state. Two layers, both persisted in the system_state table so a
// restart no longer silently unmutes:
//   - smsMuteUntil (global): suppresses every SMS producer fleet-wide.
//   - deviceSmsMuteUntil (per tank): suppresses that tank's critical-alert
//     and disconnect SMS only; the fleet digest still names the tank.
// Pruning helper returns the ISO string while still active, else null.
function pruneMuteUntil(value) {
  return value && new Date() < new Date(value) ? value : null;
}

let smsMuteUntil = null;                    // global mute (ISO string | null)
const deviceSmsMuteUntil = new Map();       // device_id -> ISO string | null

function isSmsMuted() {
  smsMuteUntil = pruneMuteUntil(smsMuteUntil);
  return Boolean(smsMuteUntil);
}

// True when SMS for this tank is suppressed by EITHER the global or the
// per-tank mute. deviceId null/undefined checks the global mute only.
function isSmsMutedFor(deviceId) {
  if (isSmsMuted()) return true;
  if (!deviceId) return false;
  const value = pruneMuteUntil(deviceSmsMuteUntil.get(deviceId));
  if (!value) deviceSmsMuteUntil.delete(deviceId);
  return Boolean(value);
}

// system_state persistence for mute state (best-effort; failures only log).
async function persistMuteState(key, value) {
  try {
    await pool.query(
      `INSERT INTO system_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value ?? ""]
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to persist mute state ${key}:`, err.message);
  }
}

// Per-sensor cooldown map (last critical SMS wall-clock ms) + disconnect dedup
const lastSmsSent = {};
const disconnectedDevices = new Set();
// Wall-clock ms when a device last recovered (fresh reading after a disconnect);
// used to debounce reconnect-flapping devices.
const deviceOnlineSince = new Map();

// Formal, farmer-friendly timestamp (Asia/Manila), e.g. "September 13, 2026 8:22 PM".
function formatSmsTimestamp(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return "unknown time";
  try {
    const dateParts = new Intl.DateTimeFormat("en-PH", {
      month: "long", day: "numeric", year: "numeric",
      timeZone: "Asia/Manila",
    }).formatToParts(d);
    const timeParts = new Intl.DateTimeFormat("en-PH", {
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone: "Asia/Manila",
    }).formatToParts(d);
    const pick = (parts, type) => parts.find((p) => p.type === type)?.value ?? "";
    return `${pick(dateParts, "month")} ${pick(dateParts, "day")}, ${pick(dateParts, "year")} ${pick(timeParts, "hour")}:${pick(timeParts, "minute")} ${pick(timeParts, "dayPeriod")}`;
  } catch {
    return d.toLocaleString("en-PH");
  }
}

// Same formal format current time.
function formatSmsTime() {
  return formatSmsTimestamp(new Date());
}

// Converts a raw seconds value into a human-readable duration ("45 minutes").
function formatSmsDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 seconds";
  const mins = Math.floor(seconds / 60);
  if (mins < 1) return `${seconds} seconds`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 1) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs} hour${hrs === 1 ? "" : "s"} and ${remMins} minute${remMins === 1 ? "" : "s"}` : `${hrs} hour${hrs === 1 ? "" : "s"}`;
}

function buildSmsMessage(type, body) {
  return `${type}\n${body}\nDate: ${formatSmsTime()}`;
}

// POST to httpsms; resolves with the provider's message id (async delivery).
// Routed through the circuit breaker so a dead/unreachable gateway fails fast
// instead of being hammered. The config check stays OUTSIDE the breaker so a
// missing key is reported immediately rather than tripping the breaker.
async function sendHttpsms({ to, content }) {
  if (!HTTPSMS_API_KEY || !HTTPSMS_FROM) {
    const err = new Error("HTTPSMS_API_KEY / HTTPSMS_FROM not configured");
    err.missingConfig = true;
    throw err;
  }
  const response = await sendSmsWithBreaker(
    () =>
      axios.post(
        HTTPSMS_API_URL,
        { from: HTTPSMS_FROM, to, content },
        { headers: { "x-api-key": HTTPSMS_API_KEY } }
      ),
    "HTTPSMS"
  );
  return response.data?.data?.id || null;
}

// Records one send attempt in sms_logs; never throws so a logging failure
// cannot break the SMS flow.
async function logSms(phone, message, status, error, smsId = null) {
  try {
    await pool.query(
      "INSERT INTO sms_logs (recipient_phone, message, status, error_message, sms_id) VALUES ($1, $2, $3, $4, $5)",
      [phone, message, status, error || null, smsId || null]
    );
  } catch (logErr) {
    console.error(`[${new Date().toISOString()}] Failed to log SMS:`, logErr.message);
  }
}

async function getActiveRecipients() {
  const result = await pool.query("SELECT phone_number, name FROM authorized_recipients WHERE is_active = true AND archived_at IS NULL");
  return result.rows;
}

// Fans out to every active recipient, logging each attempt. {sent,total}.
// Honors the daily SMS cap (SMS_DAILY_CAP, 0 = unlimited). Sends are logged as
// "queued" (accepted by httpsms); the delivery poller reconciles them later.
async function sendSmsToRecipients(content) {
  const recipients = await getActiveRecipients();
  if (recipients.length === 0) {
    console.warn(`[${new Date().toISOString()}] No active SMS recipients — SMS not sent`);
    return { sent: 0, total: 0 };
  }
  let sent = 0;
  let usedToday = 0;
  if (SMS_DAILY_CAP > 0) {
    const used = await pool.query(
      "SELECT COUNT(*)::int AS n FROM sms_logs WHERE sent_at >= date_trunc('day', NOW()) AND status <> 'capped'"
    );
    usedToday = used.rows[0].n;
  }
  for (const recipient of recipients) {
    if (SMS_DAILY_CAP > 0 && usedToday >= SMS_DAILY_CAP) {
      await logSms(recipient.phone_number, content, "capped", `Daily SMS cap (${SMS_DAILY_CAP}) reached`, null);
      continue;
    }
    try {
      const smsId = await sendHttpsms({ to: recipient.phone_number, content });
      await logSms(recipient.phone_number, content, "queued", null, smsId);
      sent += 1;
      usedToday += 1;
    } catch (err) {
      console.error(`[${new Date().toISOString()}] SMS failed to ${recipient.phone_number}:`, err.message);
      await logSms(recipient.phone_number, content, "failed", err.message);
    }
  }
  return { sent, total: recipients.length };
}

// GET /v1/messages for one contact (owner = gateway SIM, sorted newest first).
// Returns the httpsms message array, or [] when the call fails.
async function fetchHttpsmsMessages(contact) {
  try {
    const response = await axios.get(HTTPSMS_MESSAGES_URL, {
      params: { owner: HTTPSMS_FROM, contact, skip: 0, limit: 25 },
      headers: { "x-api-key": HTTPSMS_API_KEY },
    });
    return response.data?.data || [];
  } catch (err) {
    console.error(`[${new Date().toISOString()}] httpsms message lookup failed for ${contact}:`, err.message);
    return [];
  }
}

// Reconciles "queued" sms_logs rows against httpsms so each SMS reaches a real
// terminal state (delivered with delivered_at, or failed with failure_reason).
async function pollUndeliveredSms() {
  if (!HTTPSMS_API_KEY || !HTTPSMS_FROM) return;
  try {
    const result = await pool.query(
      `SELECT id, recipient_phone, sms_id FROM sms_logs
        WHERE status = 'queued' AND sms_id IS NOT NULL
          AND sent_at >= NOW() - ($1 || ' seconds')::interval
        ORDER BY id ASC LIMIT 50`,
      [Math.floor(SMS_POLL_WINDOW_MS / 1000)]
    );
    if (result.rows.length === 0) return;
    // Group by recipient so each contact is queried only once per tick.
    const rowsByPhone = new Map();
    for (const row of result.rows) {
      const list = rowsByPhone.get(row.recipient_phone) || [];
      list.push(row);
      rowsByPhone.set(row.recipient_phone, list);
    }
    for (const [phone, rows] of rowsByPhone) {
      const messages = await fetchHttpsmsMessages(phone);
      if (messages.length === 0) continue;
      const byId = new Map(messages.map((m) => [String(m.id), m]));
      for (const row of rows) {
        const msg = byId.get(String(row.sms_id));
        if (!msg) continue; // not yet queryable — stays queued
        try {
          if (msg.delivered_at) {
            await pool.query(
              "UPDATE sms_logs SET status = 'delivered', delivered_at = $1, failure_reason = NULL WHERE id = $2",
              [new Date(msg.delivered_at).toISOString(), row.id]
            );
          } else if (msg.failed_at || msg.status === "failed" || msg.failure_reason) {
            await pool.query(
              "UPDATE sms_logs SET status = 'failed', failure_reason = $1 WHERE id = $2",
              [msg.failure_reason || msg.status || "failed", row.id]
            );
          }
        } catch (updateErr) {
          console.error(`[${new Date().toISOString()}] Error updating sms_logs row ${row.id}:`, updateErr.message);
        }
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] SMS delivery poller error:`, err.message);
  }
}

// Periodic housekeeping: prunes stale in-memory cooldown/rearm state and purges
// old sms_logs rows beyond the retention window.
function runSmsMaintenance() {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const key of Object.keys(lastSmsSent)) {
    if (lastSmsSent[key] < cutoff) delete lastSmsSent[key];
  }
  for (const [deviceId, sinceOnline] of deviceOnlineSince) {
    if (sinceOnline < cutoff) deviceOnlineSince.delete(deviceId);
  }
  if (SMS_RETENTION_DAYS > 0) {
    pool
      .query("DELETE FROM sms_logs WHERE sent_at < NOW() - ($1 || ' days')::interval", [SMS_RETENTION_DAYS])
      .catch((err) => console.error(`[${new Date().toISOString()}] SMS retention cleanup error:`, err.message));
  }
}

// Latest sensor readings + per-sensor threshold status, or null when no active
// tanks. deviceId scopes the report to one tank (per-tank thresholds apply);
// without it the report is a fleet digest with one block per active tank —
// previously it reported only whichever tank happened to post most recently.
async function buildStatusSms(deviceId = null) {
  try {
    const devicesResult = deviceId
      ? await pool.query("SELECT device_id, tank_name FROM devices WHERE device_id = $1 AND is_active = true", [deviceId])
      : await pool.query("SELECT device_id, tank_name FROM devices WHERE is_active = true AND archived_at IS NULL ORDER BY device_id");
    if (devicesResult.rows.length === 0) return null;

    const statusLabel = (s) => (s === "good" ? "NORMAL" : s === "warning" ? "WARNING" : "CRITICAL");

    const lines = [
      "CRAYVINGS AQUACULTURE MONITORING",
      deviceId ? "TANK STATUS REPORT" : "FLEET STATUS REPORT",
      formatSmsTime(),
      "",
    ];

    let anyBreached = false;
    let anyReading = false;

    for (const device of devicesResult.rows) {
      const label = device.tank_name ? `${device.tank_name} (${device.device_id})` : device.device_id;
      const sensorResult = await pool.query(
        "SELECT * FROM sensors WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 1",
        [device.device_id]
      );
      if (sensorResult.rows.length === 0) {
        lines.push(`Tank: ${label}`, "No readings yet.", "");
        continue;
      }
      anyReading = true;
      const settings = await getThresholdsForDevice(device.device_id);
      const row = sensorResult.rows[0];
      const temp = row.temperature == null ? null : Number(row.temperature);
      const water = row.water_level == null ? null : Number(row.water_level);
      const ammonia = row.ammonia == null ? null : Number(row.ammonia);

      const tempStatus = temp !== null && temp >= 0.0001 ? getThresholdStatus(temp, settings.temp_min, settings.temp_max) : null;
      const waterStatus = water !== null && water >= 0 ? getThresholdStatus(water, settings.water_level_min, settings.water_level_max) : null;
      const ammoniaStatus = ammonia !== null && ammonia >= 0 ? getThresholdStatus(ammonia, settings.ammonia_min, settings.ammonia_max) : null;

      if ([tempStatus, waterStatus, ammoniaStatus].some((s) => s && s !== "good")) anyBreached = true;

      lines.push(`Tank: ${label}`);
      lines.push(`Temperature: ${temp !== null && temp >= 0.0001 ? `${temp}°C` : "Not available"} ${tempStatus ? `(${statusLabel(tempStatus)})` : ""}`);
      lines.push(`Water Level: ${water !== null && water >= 0 ? `${water}%` : "Not available"} ${waterStatus ? `(${statusLabel(waterStatus)})` : ""}`);
      lines.push(`Ammonia: ${ammonia !== null && ammonia >= 0 ? `${ammonia} ppm` : "Not available"} ${ammoniaStatus ? `(${statusLabel(ammoniaStatus)})` : ""}`);
      if (deviceId) {
        lines.push(
          "",
          "SAFE RANGES",
          `Temperature: ${settings.temp_min}°C - ${settings.temp_max}°C`,
          `Water Level: ${settings.water_level_min}% - ${settings.water_level_max}%`,
          `Ammonia: ${settings.ammonia_min} - ${settings.ammonia_max} ppm`
        );
      }
      lines.push("");
    }

    if (anyReading && anyBreached) {
      lines.push("STATUS: Attention required — one or more readings out of range.");
    } else if (anyReading) {
      lines.push("STATUS: All readings are within safe ranges.");
    }
    lines.push("CRAYvings Monitoring System");
    return lines.join("\n");
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error building status SMS:`, err.message);
    return null;
  }
}

// Scheduled hourly status update (skips when muted or no recent readings).
async function sendHourlyStatusUpdate() {
  if (isSmsMuted()) return { sent: 0, total: 0, muted: true };
  const content = await buildStatusSms();
  if (!content) return { sent: 0, total: 0 };
  return sendSmsToRecipients(content);
}

// Monitors devices.last_seen; notifies once per disconnect, re-arms on reconnect.
async function checkDeviceDisconnects() {
  if (!DEVICE_DISCONNECT_ENABLED || isSmsMuted()) return;
  try {
    const staleSeconds = Math.max(5, Math.floor(DISCONNECT_STALE_MS / 1000));
    const result = await pool.query(
      `SELECT device_id, last_seen FROM devices WHERE last_seen < NOW() - ($1 || ' seconds')::interval`,
      [staleSeconds]
    );
    for (const row of result.rows) {
      if (disconnectedDevices.has(row.device_id)) continue;
      // Skip devices whose recovery was too recent: a briefly-flapping ESP32
      // must stay online steadily for DISCONNECT_REARM_MS before a new
      // disconnect SMS is allowed, otherwise every blip re-fires the alert.
      const sinceOnline = deviceOnlineSince.get(row.device_id);
      if (sinceOnline !== undefined && Date.now() - sinceOnline < DISCONNECT_REARM_MS) continue;
      disconnectedDevices.add(row.device_id);
      const content = buildSmsMessage(
        "CRAYVINGS AQUACULTURE MONITORING — DEVICE ALERT",
        [
          `Device "${row.device_id}" is OFFLINE.`,
          `No sensor data received for approximately ${formatSmsDuration(staleSeconds)}.`,
          `Last reading was received at ${formatSmsTimestamp(row.last_seen)}.`,
          "",
          "Please check the device power and network connection.",
        ].join("\n")
      );
      // Per-tank mute: silence just this tank's disconnect SMS when muted.
      if (!isSmsMutedFor(row.device_id)) {
        await sendSmsToRecipients(content);
      }
      await pool.query(
        "INSERT INTO system_logs (action, parameter, old_value, new_value, device_id) VALUES ($1, $2, $3, $4, $5)",
        ["Device Disconnect", String(row.device_id), "last_seen stale", `> ${staleSeconds}s`, row.device_id]
      );
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking device disconnects:`, err.message);
  }
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

// Farm-wide default thresholds (used when no sensor_settings row exists).
const DEFAULT_THRESHOLDS = { temp_min: 20, temp_max: 31, water_level_min: 10, water_level_max: 100, ammonia_min: 0.25, ammonia_max: 1 };

// Effective thresholds for one tank: per-tank overrides
// (device_threshold_overrides, migration 012) win over the global
// sensor_settings singleton; NULL/missing override columns fall back to
// global. deviceId null/undefined resolves to the global row alone. Missing
// override table (migration 012 not applied) degrades to global quietly.
async function getThresholdsForDevice(deviceId) {
  const [settingsResult, overrideResult] = await Promise.all([
    pool.query("SELECT * FROM sensor_settings LIMIT 1"),
    deviceId
      ? pool.query("SELECT * FROM device_threshold_overrides WHERE device_id = $1", [deviceId]).catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] }),
  ]);
  const global = settingsResult.rows[0] || DEFAULT_THRESHOLDS;
  const override = overrideResult.rows[0] || {};
  return {
    temp_min: override.temp_min != null ? Number(override.temp_min) : Number(global.temp_min),
    temp_max: override.temp_max != null ? Number(override.temp_max) : Number(global.temp_max),
    water_level_min: override.water_level_min != null ? Number(override.water_level_min) : Number(global.water_level_min),
    water_level_max: override.water_level_max != null ? Number(override.water_level_max) : Number(global.water_level_max),
    ammonia_min: override.ammonia_min != null ? Number(override.ammonia_min) : Number(global.ammonia_min ?? DEFAULT_THRESHOLDS.ammonia_min),
    ammonia_max: override.ammonia_max != null ? Number(override.ammonia_max) : Number(global.ammonia_max ?? DEFAULT_THRESHOLDS.ammonia_max),
  };
}

// DEVICE_SECRET: ESP32 must send matching X-Device-Secret header for POST /sensor.
// This used to be optional outside production, which meant a deployment with
// neither DEVICE_SECRET nor NODE_ENV=production accepted data from anyone. The
// requirement is now unconditional so the server always fails closed. With no
// DEVICE_SECRET set the shared comparison can never match, so the only boards
// accepted are those carrying a per-device secret (migration 008).
const DEVICE_SECRET = process.env.DEVICE_SECRET;
const REQUIRE_DEVICE_SECRET = true;

// In-memory alert dedup state; last-alert per sensor, disconnect spam guard
let lastAlertedState = {};
// Server-side ammonia spike guard: last stored reading per device
let lastAmmoniaReading = {};
// Change-only logging baseline: last INSERTED reading per device (seeded from DB at boot)
let lastSensorReading = {};
const AMMONIA_SPIKE_THRESHOLD = 20; // ppm jump vs last stored value that gets flagged as a "Spike"
// Oldest device read_at the ingest accepts: the offline ring buffer holds 600
// readings (~10 min at 1 Hz); 15 min covers flush delays with slack.
const MAX_BACKLOG_AGE_MS = 15 * 60 * 1000;
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
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ`);

    // Per-device secret for ESP32 auth (migration 008). Migration 010 back-filled
    // schema_migrations with 001-010 without running them, so this column was
    // recorded as applied but never actually created - which made the per-device
    // branch of POST /sensor silently unreachable. Recreated here so the server
    // self-heals on boot like the 011/012 mirrors below.
    await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_secret VARCHAR(255)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_devices_device_secret ON devices(device_secret) WHERE device_secret IS NOT NULL`);

    // Alert acknowledgement (Confirm / Allow) tracked directly on each alert row
    await pool.query(`ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS ack_status VARCHAR(20)`);
    await pool.query(`ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP`);
    await pool.query(`ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS acknowledged_by VARCHAR(100)`);

    // Per-tank log attribution + override table (migrations 011/012 mirror
    // these so a server started without running migrations keeps alerting).
    await pool.query(`ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS device_id VARCHAR(50) REFERENCES devices(device_id) ON DELETE SET NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_device_ts ON system_logs (device_id, timestamp DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS device_threshold_overrides (
        device_id VARCHAR(50) PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
        temp_min DECIMAL(5,2),
        temp_max DECIMAL(5,2),
        water_level_min DECIMAL(5,2),
        water_level_max DECIMAL(5,2),
        ammonia_min DECIMAL(5,2),
        ammonia_max DECIMAL(5,2),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON system_logs (timestamp DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_action ON system_logs (action)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_ack_status ON system_logs (ack_status)`);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sensors_timestamp ON sensors (timestamp DESC)`);
    
    console.log(`[${new Date().toISOString()}] Database indexes verified/created`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating indexes:`, err.message);
  }
})();

// Reads a retention window from the environment: a non-negative whole number of
// days, or `fallback` when unset or unparseable. 0 disables that purge.
//
// Declared as a hoisted function so the SMS block above can use it too - this
// parse-and-validate dance was previously copy-pasted three times.
function envDays(name, fallback) {
  const raw = parseInt(process.env[name], 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

// Retention windows, all configurable and all disableable with 0.
//
// This deletes sensor readings irreversibly, and the sensors table is the only
// record of what the tanks actually did. It used to run against a hardcoded
// 30 days with no off-switch, so an operator who wanted the full history had no
// way to keep it short of editing server.cjs and redeploying. activity_logs is a
// user-audit trail rather than sensor data, so it defaults to a longer window.
//
// sensors grows fastest by far: the ESP32s post about once a second per tank,
// which is what actually makes a retention window necessary.
const SYSTEM_LOGS_RETENTION_DAYS = envDays("SYSTEM_LOGS_RETENTION_DAYS", 30);
const SENSOR_RETENTION_DAYS = envDays("SENSOR_RETENTION_DAYS", 30);
const ACTIVITY_LOGS_RETENTION_DAYS = envDays("ACTIVITY_LOGS_RETENTION_DAYS", 90);

async function cleanupOldData() {
  // All three intervals are bound as parameters rather than interpolated, so a
  // bad value can never reach the parser as SQL. The table name is the one
  // interpolated identifier here, and it is always a literal from the three call
  // sites below - never anything derived from a request or the environment.
  const purge = async (table, days, label) => {
    if (days <= 0) return;
    const result = await pool.query(
      `DELETE FROM ${table} WHERE timestamp < NOW() - ($1 || ' days')::interval RETURNING id`,
      [days]
    );
    if (result.rowCount > 0) {
      console.log(
        `[${new Date().toISOString()}] Cleaned up ${result.rowCount} ${label} rows older than ${days} days`
      );
    }
  };

  try {
    await purge("system_logs", SYSTEM_LOGS_RETENTION_DAYS, "system_logs");
    await purge("activity_logs", ACTIVITY_LOGS_RETENTION_DAYS, "activity_logs");
    await purge("sensors", SENSOR_RETENTION_DAYS, "sensor reading");
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error cleaning up logs:`, err.message);
  }
}

// Run cleanup on startup, then daily. The first run happens before anyone is
// looking at the console, and it deletes sensor readings for good, so the
// effective windows are announced up front rather than discovered by noticing
// that history has gone missing.
console.log(
  `[${new Date().toISOString()}] Retention: sensors ${SENSOR_RETENTION_DAYS || "off"}, ` +
  `system_logs ${SYSTEM_LOGS_RETENTION_DAYS || "off"}, activity_logs ${ACTIVITY_LOGS_RETENTION_DAYS || "off"} (days)`
);
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

// GET / - the dashboard itself when a build exists, API identification when not.
// This route is registered with the API, long before the static handler, so it
// shadows dist/ for "/". That makes it the one route that has to be build-aware
// in two places: leave it always-JSON and the production dashboard is
// unreachable at its own root URL.
app.get("/", (req, res) => {
  if (fs.existsSync(INDEX_HTML)) {
    return res.sendFile(INDEX_HTML);
  }
  res.json({ message: "CRAYvings Monitoring System API", status: "running" });
});

// ========================
// SENSOR DATA ENDPOINTS
// ========================

// Background threshold evaluation + alert state updates. Runs after every
// accepted reading (inserted or delta-skipped) so alerting behaves unchanged.
function scheduleAlertProcessing(device_id, ts, temperature, water_level, ammonia) {
  setImmediate(async () => {
    try {
      // Per-tank thresholds: overrides (migration 012) layered on the global
      // singleton, so each tank alerts against its own effective range.
      const settings = await getThresholdsForDevice(device_id);

      const sensorChecks = [
        { key: "Temperature", val: Number(temperature), min: Number(settings.temp_min), max: Number(settings.temp_max), minValid: 0.0001 },
        { key: "Water Level", val: Number(water_level), min: Number(settings.water_level_min), max: Number(settings.water_level_max), minValid: 0 },
        { key: "Ammonia", val: Number(ammonia), min: Number(settings.ammonia_min), max: Number(settings.ammonia_max), minValid: 0 },
      ];

      const nowTs = ts.getTime();

      for (const sensor of sensorChecks) {
        if (sensor.val < sensor.minValid) continue;
        const status = getThresholdStatus(sensor.val, sensor.min, sensor.max);
        const last = lastAlertedState[`${device_id}:${sensor.key}`] || {};
        const lastTs = last.timestamp ? new Date(last.timestamp).getTime() : 0;

        if (status === "good") {
          if (last.status && last.status !== "good") {
            await pool.query(
              `INSERT INTO last_alerts (device_id, sensor_key, status, value, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (device_id, sensor_key) DO UPDATE SET status = $3, value = $4, timestamp = $5`,
              [device_id, sensor.key, "good", sensor.val, ts.toISOString()]
            );
            lastAlertedState[`${device_id}:${sensor.key}`] = { status: "good", value: sensor.val, timestamp: ts.toISOString() };
            await pool.query(`INSERT INTO system_logs (action, parameter, old_value, new_value, device_id) VALUES ($1, $2, $3, $4, $5)`,
              ["Alert Resolved", sensor.key, last.status, "good", device_id]);
          }
          continue;
        }

        if (status === last.status && nowTs - lastTs < ALERT_COOLDOWN_MS) continue;

        const direction = sensor.val < sensor.min ? "Low" : "High";

        await pool.query(`INSERT INTO system_logs (action, parameter, old_value, new_value, device_id) VALUES ($1, $2, $3, $4, $5)`,
          ["Alert", sensor.key, direction, sensor.val, device_id]);

        if (status === "critical" && !isSmsMutedFor(device_id)) {
          const smsKey = `${device_id}:${sensor.key}`;
          if (nowTs - (lastSmsSent[smsKey] || 0) >= SMS_COOLDOWN_MS) {
            lastSmsSent[smsKey] = nowTs;
            const unit = sensor.key === "Temperature" ? "°C" : sensor.key === "Water Level" ? "%" : " ppm";
            const breachedLimit = sensor.val < sensor.min ? sensor.min : sensor.max;
            const smsContent = buildSmsMessage(
              "CRAYVINGS AQUACULTURE MONITORING — CRITICAL ALERT",
              [
                `CRITICAL: ${sensor.key} is critically ${direction === "Low" ? "LOW" : "HIGH"}.`,
                `Device: ${device_id}`,
                `Current Reading: ${sensor.val}${unit}`,
                `Safe Range: ${sensor.min}${unit} to ${sensor.max}${unit}`,
                `Breached Limit: ${breachedLimit}${unit}`,
                "",
                "Immediate action is recommended to protect your stock.",
              ].join("\n")
            );
            sendSmsToRecipients(smsContent).catch((smsErr) =>
              console.error(`[${new Date().toISOString()}] Critical SMS error:`, smsErr.message)
            );
          }
        }

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
}

// =============================================================================
// REAL-TIME PUSH (SSE) + IN-MEMORY LATEST READINGS
// =============================================================================
// Every accepted reading is pushed to all connected dashboards over
// Server-Sent Events, removing the need for 1s client polling. The same
// in-memory map backs GET /devices/latest (freshest reading per active tank).

// sseClients maps each open EventSource response -> that client's device
// filter (device_id the dashboard selected, or null = receive every tank).
// A Map (not a Set) so broadcastSensorUpdate can target frames per tank —
// with multiple ESP32s posting, each dashboard must only see its own tank.
const sseClients = new Map(); // res -> device_id filter (string | null)
const latestDeviceReadings = new Map(); // device_id -> { ...readings, recv_at }

// Ceiling on concurrent dashboard streams. Each client costs an open socket plus
// a 25s timer, so an unbounded map leaks with a slow fuse: a dashboard left open
// on a flaky Wi-Fi link never emits 'close', so the entry is only reclaimed when
// a write eventually fails. A farm is a handful of operators, so this is
// deliberately generous; going past it means something is wrong and is better
// refused loudly than absorbed.
const SSE_MAX_CLIENTS = 50;

// Drops one SSE client AND its keep-alive timer. Clearing the timer is the point:
// it is otherwise only cleared from the keep-alive catch or the request's close
// event, so a client pruned by the broadcast loop kept a timer alive writing to
// a dead socket every 25s, forever, and neither event was coming.
function dropSseClient(res) {
  sseClients.delete(res);
  if (res.sseKeepAlive) {
    clearInterval(res.sseKeepAlive);
    res.sseKeepAlive = null;
  }
}

// Forgets every in-memory trace of one device. Called when a device is archived
// (so a retired board stops feeding the live tile, the SSE stream and the delta
// baseline) and when one is restored (so a stale pre-archive reading cannot
// immediately re-trigger a disconnect alert).
//
// This only touches process memory — the `devices` row and every `sensors` row
// referencing it are left completely intact, which is the point of archiving.
// The Maps/objects are keyed by device_id and never pruned otherwise, so without
// this a long-lived server would accumulate one entry per device_id ever seen.
function evictDeviceFromMemory(deviceId) {
  latestDeviceReadings.delete(deviceId);
  disconnectedDevices.delete(deviceId);
  deviceOnlineSince.delete(deviceId);
  // These three are plain objects, not Maps.
  delete lastSensorReading[deviceId];
  delete lastAmmoniaReading[deviceId];
  // lastAlertedState is keyed `${deviceId}:${sensor}` - one entry per sensor per
  // tank - so `delete lastAlertedState[deviceId]` removed a key that never
  // existed and the alert dedup state survived. Re-registering a previously
  // deleted tank then inherited it, and a tank last seen in "critical" stayed
  // suppressed: the sensor had to recover to "good" before it could alert again.
  for (const key of Object.keys(lastAlertedState)) {
    if (key.startsWith(`${deviceId}:`)) delete lastAlertedState[key];
  }
}

function broadcastSensorUpdate(deviceId, readings, ts) {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify({ type: "sensor_update", data: { device_id: deviceId, ...readings, timestamp: ts.toISOString(), recv_at: ts.toISOString() } })}\n\n`;
  for (const [client, filter] of sseClients) {
    // Subscribed dashboards only receive their own tank's frames.
    if (filter && filter !== deviceId) continue;
    // A socket can be finished without throwing on write (half-open after a
    // network drop), so check the flags rather than trusting write() to throw.
    if (client.writableEnded || client.destroyed) {
      dropSseClient(client);
      continue;
    }
    try {
      client.write(payload);
    } catch {
      dropSseClient(client); // dead connection
    }
  }
}

// POST /sensor - ESP32 ingestion; stores reading and evaluates thresholds
app.post("/sensor", sensorIngestLimiter, async (req, res) => {
  try {
    // Device auth: prefer the per-device secret from the devices registry, fall
    // back to the shared DEVICE_SECRET so existing firmware keeps working.
    const presented = req.headers["x-device-secret"];
    if (REQUIRE_DEVICE_SECRET) {
      if (!presented) {
        console.warn(`[${new Date().toISOString()}] POST /sensor 401 from ${req.ip}: missing X-Device-Secret header (device_id: ${req.body?.device_id ?? "?"})`);
        return res.status(401).json({ message: "Device secret required" });
      }
      let authorized = presented === DEVICE_SECRET;
      if (!authorized) {
        // Per-device secret (migration 008). If the column/migration is
        // missing, fail gracefully to the shared-secret decision instead of
        // crashing the request with a 500.
        //
        // The previous secret is also accepted, but ONLY inside its grace
        // window (migration 015). Rotation has to keep the outgoing secret
        // briefly because a board can only learn a new one through its config
        // portal, which means somebody has to physically reach the tank. The
        // deadline is compared in SQL, so an expired secret stops working the
        // moment it lapses without depending on any cleanup job.
        try {
          const perDevice = await pool.query(
            `SELECT device_secret,
                    device_secret_prev
               FROM devices
              WHERE device_id = $1
                AND is_active = true
                AND archived_at IS NULL
                AND (
                      device_secret = $2
                   OR (device_secret_prev = $2
                       AND device_secret_prev_expires_at IS NOT NULL
                       AND device_secret_prev_expires_at > NOW())
                )`,
            [req.body?.device_id ?? "", presented]
          );
          if (perDevice.rows.length > 0) {
            const row = perDevice.rows[0];
            if (row.device_secret && presented === row.device_secret) {
              authorized = true;
            } else if (row.device_secret_prev && presented === row.device_secret_prev) {
              authorized = true;
              console.warn(
                `[${new Date().toISOString()}] POST /sensor: device ${req.body?.device_id} authenticated with its PREVIOUS secret ` +
                  `(grace window still open) - the board has not been reconfigured yet`
              );
            }
          }
        } catch (perDeviceErr) {
          console.warn(`[${new Date().toISOString()}] Per-device secret check skipped (migration 008 not applied?): ${perDeviceErr.message}`);
        }
      }
      if (!authorized) {
        console.warn(`[${new Date().toISOString()}] POST /sensor 401 from ${req.ip}: wrong X-Device-Secret (device_id: ${req.body?.device_id ?? "?"})`);
        return res.status(401).json({ message: "Invalid device secret" });
      }
    }
    const parsed = sensorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid sensor data", errors: zodFieldErrors(parsed.error) });
    }
    const { device_id, temperature, water_level, ammonia } = parsed.data;
    if (!device_id) return res.status(400).json({ message: "device_id is required" });

    // Sensor-failure sentinels become NULL so failed sensors never pollute the
    // time-series data (audit 2.2.2); the heartbeat itself still flows.
    const readings = {
      temperature: readingOrNull("temperature", temperature),
      water_level: readingOrNull("water_level", water_level),
      ammonia: readingOrNull("ammonia", ammonia),
    };

    // Ammonia spike tracking (accept-and-flag): compute the jump vs the last
    // STORED reading but NEVER reject. The old hard-400 made the ESP32 requeue
    // the reading and retry forever, so a genuine excursion never reached the
    // dashboard or alerts — exactly when it mattered. Large jumps are stored
    // normally AND flagged as a "Spike" system_logs row (visible on Alerts and
    // Sensor Logs) so noise stays distinguishable from real events.
    const ammoniaVal = readings.ammonia;
    const prevAmmonia = lastAmmoniaReading[device_id] ?? null;
    const ammoniaSpikeJump =
      ammoniaVal != null && prevAmmonia != null ? Math.abs(ammoniaVal - prevAmmonia) : 0;
    if (ammoniaSpikeJump > AMMONIA_SPIKE_THRESHOLD) {
      console.warn(`[${new Date().toISOString()}] Ammonia spike flagged from ${device_id}: ${ammoniaVal} ppm (last stored: ${prevAmmonia} ppm, jump: ${ammoniaSpikeJump.toFixed(1)} ppm)`);
    }

    // Optional device-side capture time (backlog truthfulness): the ESP32
    // stamps each reading via SNTP so an offline-backlog flush lands at the
    // TRUE reading time instead of a "now" burst. Sane = not in the future
    // and not older than the buffer could hold; anything else falls back to
    // server arrival time.
    let readAt = null;
    if (typeof parsed.data.read_at === "string" && parsed.data.read_at) {
      const parsedReadAt = new Date(parsed.data.read_at);
      if (!Number.isNaN(parsedReadAt.getTime())) {
        const ageMs = Date.now() - parsedReadAt.getTime();
        if (ageMs >= -5000 && ageMs <= MAX_BACKLOG_AGE_MS) {
          readAt = parsedReadAt;
        } else {
          console.warn(`[${new Date().toISOString()}] Out-of-bounds read_at from ${device_id} (${parsed.data.read_at}) - using server arrival time`);
        }
      }
    }

    // arrivalTs: when this POST hit the server — drives the heartbeat clock
    // (devices.last_seen, SSE, /devices/latest). rowTs: the reading's TRUE
    // capture time (device clock when sane, else arrival) — stored on the row.
    const arrivalTs = new Date();
    const rowTs = readAt ?? arrivalTs;

    // Auto-register the device so the sensors.device_id FK never fails. This is
    // a SAFETY NET, not the registration path: a board that was never added on
    // the Devices page still gets a row (tagged registered_via = 'auto' so the
    // Devices page can flag it as "auto-discovered, needs attention"), but an
    // Owner-registered row is never downgraded or overwritten here.
    //
    // ip_address is refreshed from the live peer on every POST so the registry
    // follows the device across WiFi changes — but ONLY when the address was
    // itself learned that way. If an Owner typed the address at registration
    // (ip_source = 'manual'), their value wins: the health poller dials
    // http://<ip>/status and needs a LAN-reachable address, whereas the observed
    // peer address is the router/NAT address whenever the API server is not on
    // the tanks' subnet. COALESCE keeps a previously good address if this
    // particular request has no usable source IP (loopback/local tooling).
    const clientIp = normalizeClientIp(req);
    // RETURNING xmax = 0 distinguishes a row this request CREATED from one it
    // merely refreshed, which is the only reliable way to tell a board "the
    // dashboard did not know you" - the classic firmware/registration mismatch
    // (F3). The firmware shouts this on its serial monitor, where the operator
    // is standing; without it the mismatch is only visible as an
    // "Auto-discovered" badge nobody is looking at.
    const upsert = await pool.query(
      `INSERT INTO devices (device_id, ip_address, last_seen, registered_via, ip_source)
       VALUES ($1, $2, $3, 'auto', 'auto')
       ON CONFLICT (device_id) DO UPDATE
          SET last_seen = $3,
              ip_address = CASE WHEN devices.ip_source = 'manual' THEN devices.ip_address
                                ELSE COALESCE($2, devices.ip_address) END
       RETURNING (xmax = 0) AS auto_registered`,
      [device_id, clientIp, arrivalTs]
    );
    const autoRegistered = upsert.rows[0]?.auto_registered === true;
    if (autoRegistered) {
      // Logged server-side too: this is the one ingest event an operator will
      // want in the server log as well, since the board may be on a bench with
      // no serial monitor attached.
      console.warn(`[${new Date().toISOString()}] Auto-registered unknown device_id '${device_id}' from its first POST /sensor. Claim it on the Devices page (or fix Device ID in its config portal) to name the tank.`);
    }
    // A fresh reading means the device is online again: re-arm its disconnect
    // alert and timestamp the recovery so reconnecting flaps don't re-alert.
    if (disconnectedDevices.delete(device_id)) {
      deviceOnlineSince.set(device_id, Date.now());
    }
    const baseline = lastSensorReading[device_id];
    const paramChanged = (key) => {
      // No baseline at all = first reading this server has ever seen for this
      // device, so it must be written.
      //
      // A baseline that EXISTS but holds null for this key is different: it is
      // a real stored value meaning "this sensor failed". Treating it as a
      // change made delta logging permanently inert for a device with dead
      // sensors - every POST re-triggered the write and the table filled with
      // null rows, one per request, forever. The isValid comparison below
      // already answers the null case correctly; it just has to be reached.
      if (!baseline) return true;
      const newVal = readings[key];
      const lastVal = baseline[key];
      const isValid = (val) => val != null;
      // A real transition between valid and failed (or back) IS a change, so
      // sensor recovery still gets logged.
      if (isValid(newVal) !== isValid(lastVal)) return true;
      if (!isValid(newVal)) return false;
      return Math.abs(newVal - lastVal) > DELTA_TOLERANCES[key];
    };
    const hasDelta = ["temperature", "water_level", "ammonia"].some(paramChanged);

    // Publish the freshest reading to the in-memory map (drives /devices/latest
    // and the SSE push) regardless of whether a row gets written.
    latestDeviceReadings.set(device_id, { ...readings, recv_at: arrivalTs.toISOString() });

    // Delta mode: an unchanged reading is still a heartbeat (devices.last_seen
    // already updated above) but writes no new sensors row.
    if (DELTA_LOGGING_ENABLED && !hasDelta) {
      console.log(`[${new Date().toISOString()}] Sensor heartbeat from ${device_id} (unchanged - no row written)`);
      res.status(200).json({ message: "No change, skipped", skipped: true, auto_registered: autoRegistered, data: { device_id, ...readings, timestamp: rowTs.toISOString() } });
      broadcastSensorUpdate(device_id, readings, arrivalTs);
      scheduleAlertProcessing(device_id, rowTs, temperature, water_level, ammonia);
      return;
    }

    const result = await pool.query(
      `INSERT INTO sensors (device_id, temperature, water_level, ammonia, timestamp) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [device_id, readings.temperature, readings.water_level, readings.ammonia, rowTs]
    );
    console.log(`[${new Date().toISOString()}] Sensor data saved from ${device_id}${readAt ? ` (read_at ${rowTs.toISOString()})` : ""}`);

    if (ammoniaVal != null) {
      if (ammoniaSpikeJump > AMMONIA_SPIKE_THRESHOLD) {
        // Accept-and-flag: the reading above is already stored; this row makes
        // the jump visible on the Alerts / Sensor Logs pages.
        pool.query(
          `INSERT INTO system_logs (action, parameter, old_value, new_value, device_id) VALUES ($1, $2, $3, $4, $5)`,
          ["Spike", "Ammonia", String(prevAmmonia ?? ""), String(ammoniaVal), device_id]
        ).catch((spikeLogErr) =>
          console.error(`[${new Date().toISOString()}] Failed to log ammonia spike flag:`, spikeLogErr.message)
        );
      }
      lastAmmoniaReading[device_id] = ammoniaVal;
    }
    lastSensorReading[device_id] = readings;

    // Respond immediately; timestamp returned as UTC ISO-8601 so the frontend
    // renders it in the farm timezone without silent timezone conversion.
    res.status(201).json({ message: "Saved", auto_registered: autoRegistered, data: { ...result.rows[0], timestamp: rowTs.toISOString() } });

    broadcastSensorUpdate(device_id, readings, arrivalTs);
    scheduleAlertProcessing(device_id, rowTs, temperature, water_level, ammonia);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error saving sensor:`, err.message);
    res.status(500).json({ message: "Error saving data" });
  }
});

// GET /sensor - sensor history, newest first; ?limit (default 300, max 1000),
// optional ?device_id to scope to one tank, optional ?from & ?to (ISO dates),
// optional ?before (ISO timestamp cursor: return rows strictly older than it —
// keyset pagination for efficient deep history paging, audit 2.3.3)
app.get("/sensor", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 300));
    const deviceId = req.query.device_id ? String(req.query.device_id) : null;
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const result = await pool.query(
      `SELECT * FROM sensors
        WHERE ($1::text IS NULL OR device_id = $1)
          AND ($2::timestamptz IS NULL OR timestamp >= $2)
          AND ($3::timestamptz IS NULL OR timestamp <= $3)
          AND ($4::timestamptz IS NULL OR timestamp < $4)
        ORDER BY timestamp DESC
        LIMIT $5`,
      [deviceId, from && !isNaN(from.getTime()) ? from : null,
       to && !isNaN(to.getTime()) ? to : null,
       before && !isNaN(before.getTime()) ? before : null, limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching sensors:`, err.message);
    res.status(500).json({ message: "Error fetching data" });
  }
});

// GET /sensor/latest - most recent reading (optionally ?device_id); 404 when none exist
app.get("/sensor/latest", requireAuth, async (req, res) => {
  try {
    const deviceId = req.query.device_id ? String(req.query.device_id) : null;
    const result = await pool.query(
      `SELECT s.*, d.last_seen AS recv_at
       FROM sensors s
       LEFT JOIN devices d ON d.device_id = s.device_id
       WHERE ($1::text IS NULL OR s.device_id = $1)
       ORDER BY s.timestamp DESC
       LIMIT 1`,
      [deviceId]
    );
    // 200 + { data, deviceExists } (audit 2.1.2): "no readings yet" is a normal
    // state, not an error, and 404 was ambiguous with "device not found".
    if (result.rows.length === 0) {
      let deviceExists = false;
      if (deviceId) {
        const deviceCheck = await pool.query("SELECT 1 FROM devices WHERE device_id = $1", [deviceId]);
        deviceExists = deviceCheck.rows.length > 0;
      }
      return res.json({ data: null, deviceExists });
    }
    const row = result.rows[0];
    const toNumber = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
    res.json({
      data: {
        device_id: row.device_id,
        recv_at: row.recv_at ? row.recv_at.toISOString() : null,
        temperature: toNumber(row.temperature),
        water_level: toNumber(row.water_level),
        ammonia: toNumber(row.ammonia),
        timestamp: row.timestamp ? row.timestamp.toISOString() : null,
      },
      deviceExists: true,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching latest:`, err.message);
    res.status(500).json({ message: "Error" });
  }
});

// =============================================================================
// REAL-TIME STREAM (SSE)
// =============================================================================
// GET /sensor/stream - Server-Sent Events feed of live readings. Auth uses the
// session token as a ?token= query parameter because EventSource cannot set
// Authorization headers. Broadcasts happen on every accepted POST /sensor.
app.get("/sensor/stream", requireAuth, (req, res) => {
  // Refuse before any SSE header is flushed: once the response has started we can
  // no longer change the status code, and the client would sit on a dead stream
  // retrying forever. 503 is also what the reconnect backoff handles cleanly.
  if (sseClients.size >= SSE_MAX_CLIENTS) {
    console.warn(`[${new Date().toISOString()}] SSE refused: ${sseClients.size} live clients already at the ${SSE_MAX_CLIENTS} cap`);
    return res.status(503).json({ message: "Too many live dashboard connections" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Per-client tank filter (?device_id=). When set, this client only receives
  // that tank's frames — both the connect burst and live broadcasts.
  const deviceFilter = req.query.device_id ? String(req.query.device_id) : null;

  // Send the current freshest reading immediately so a newly opened dashboard
  // has data before the next ESP32 POST arrives. Filtered clients get only
  // their own tank; unfiltered clients still get the whole fleet.
  if (latestDeviceReadings.size > 0) {
    for (const [deviceId, readings] of latestDeviceReadings) {
      if (deviceFilter && deviceId !== deviceFilter) continue;
      res.write(`data: ${JSON.stringify({ type: "sensor_update", data: { device_id: deviceId, ...readings, timestamp: readings.recv_at } })}\n\n`);
    }
  }
  res.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);

  sseClients.set(res, deviceFilter);
  const keepAlive = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch {
      dropSseClient(res);
    }
  }, 25000); // comment ping prevents proxy idle timeouts
  // Parked on the response so dropSseClient() can cancel it from the broadcast
  // loop, which is the only path that reaps clients whose close never fires.
  res.sseKeepAlive = keepAlive;

  req.on("close", () => {
    dropSseClient(res);
  });
});

// ========================
// DEVICE REGISTRY ENDPOINTS
// ========================

// Columns every device read/write returns. Kept in one place so the create,
// update, archive and restore paths can never drift from GET /devices.
//
// SECURITY: this list is what every read endpoint hands out, so it must never
// gain a secret column (device_secret, device_secret_prev). Rotation is surfaced
// as metadata only - when it happened, and whether a previous secret is still
// inside its grace window - which is enough for an operator to act on without
// exposing anything usable.
const DEVICE_COLUMNS = `device_id, name, tank_name, tank_location, ip_address,
       is_active, registered_via, ip_source, archived_at, archived_by,
       last_seen, last_health_seen, device_secret_rotated_at,
       device_secret_prev_expires_at`;

// POST /devices (Admin) - register a device from the Devices page.
//
// This is a REGISTRATION record, not a provisioning step: the ESP32 firmware is
// still flashed offline by hand. All this does is tell the server that a board
// with a given identity is expected, and attach the metadata the Owner supplied
// so the board can start pushing data under that identity.
//
// Uniqueness is enforced system-wide and case-insensitively. An archived device
// still occupies its device_id permanently (see 014_device_registration.cjs) so
// a replacement board can never inherit the old board's reading history.
app.post("/devices", requireAdmin, async (req, res) => {
  try {
    const parsed = createDeviceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid device data", errors: zodFieldErrors(parsed.error) });
    }
    const { device_id, device_name, ip_address, tank_location } = parsed.data;

    // Explicit pre-check so the Owner gets a precise, actionable message
    // (409 Conflict) instead of a generic DB error. The unique index and the
    // 23505 catch below are the race-condition backstop, since two Owners (or
    // two tabs) can pass this check simultaneously.
    const existing = await pool.query(
      "SELECT device_id, archived_at, registered_via, tank_name, ip_address, ip_source FROM devices WHERE lower(device_id) = lower($1)",
      [device_id]
    );
    if (existing.rows.length > 0) {
      const prior = existing.rows[0];
      // Allow claiming an auto-discovered device (registered_via='auto', not archived)
      if (prior.archived_at) {
        return res.status(409).json({
          message: `Device ID "${prior.device_id}" is already registered and archived. Device IDs are permanently retired — choose a different ID for the new board.`,
          errors: { device_id: ["This device ID is already in use (archived)"] },
        });
      }
      if (prior.registered_via === "manual") {
        return res.status(409).json({
          message: `Device ID "${prior.device_id}" is already registered. Device IDs must be unique system-wide.`,
          errors: { device_id: ["This device ID is already in use"] },
        });
      }
      // prior.registered_via === 'auto' and not archived: allow claiming
      const hasManualIp = typeof ip_address === "string" && ip_address.length > 0;
      const result = await pool.query(
        `UPDATE devices
            SET name = COALESCE($1, name),
                tank_name = COALESCE($1, tank_name),
                tank_location = COALESCE($2, tank_location),
                ip_address = COALESCE($3, ip_address),
                ip_source = CASE WHEN $5 THEN 'manual' ELSE ip_source END,
                registered_via = 'manual',
                is_active = true
          WHERE device_id = $4
          RETURNING ${DEVICE_COLUMNS}`,
        [
          typeof device_name === "string" ? device_name.trim() : null,
          typeof tank_location === "string" ? tank_location.trim() : null,
          typeof ip_address === "string" ? ip_address.trim() : null,
          prior.device_id,
          hasManualIp,
        ]
      );

      await pool.query(
        "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'DEVICE_CLAIMED', $2, 'devices')",
        [req.adminUser.username, `Claimed auto-discovered device ${prior.device_id} as ${device_name}${hasManualIp ? ` at ${ip_address}` : ""}`]
      ).catch(() => {});

      const row = result.rows[0];
      console.log(`[${new Date().toISOString()}] Device claimed by ${req.adminUser.username}: ${prior.device_id} (${device_name})${hasManualIp ? ` @ ${ip_address}` : ""}`);
      // A board that had to be claimed is usually one that is already reporting,
      // so compute online from last_seen rather than hardcoding false - the row
      // this response replaces in the UI would otherwise flash "Offline" until
      // the next reload.
      const staleSeconds = Math.max(5, Math.floor(DISCONNECT_STALE_MS / 1000));
      const onlineResult = await pool.query(
        `SELECT (last_seen > NOW() - ($2 || ' seconds')::interval) AS online
           FROM devices WHERE device_id = $1`,
        [row.device_id, staleSeconds]
      );
      return res.status(200).json({ ...row, online: !!onlineResult.rows[0]?.online });
    }


    // An Owner-typed address is authoritative: flag it 'manual' so the ingest
    // upsert stops overwriting it with whatever peer address it observes (which
    // is a NAT/router address whenever the API server is not on the tanks'
    // subnet, and useless to the health poller). With no address supplied, stay
    // 'auto' and let the first ingest learn it.
    const hasManualIp = typeof ip_address === "string" && ip_address.length > 0;

    const result = await pool.query(
      `INSERT INTO devices (device_id, name, tank_name, tank_location, ip_address, is_active, registered_via, ip_source)
       VALUES ($1, $2, $2, $3, $4, true, 'manual', $5)
       RETURNING ${DEVICE_COLUMNS}`,
      [device_id, device_name, tank_location ?? null, hasManualIp ? ip_address : null, hasManualIp ? "manual" : "auto"]
    );

    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'DEVICE_REGISTERED', $2, 'devices')",
      [req.adminUser.username, `Registered device ${device_id} (${device_name})${hasManualIp ? ` at ${ip_address}` : ""}`]
    ).catch(() => {});

    const row = result.rows[0];
    console.log(`[${new Date().toISOString()}] Device registered by ${req.adminUser.username}: ${device_id} (${device_name})${hasManualIp ? ` @ ${ip_address}` : ""}`);
    res.status(201).json({ ...row, online: false });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        message: "That device ID is already registered. Device IDs must be unique system-wide.",
        errors: { device_id: ["This device ID is already in use"] },
      });
    }
    console.error(`[${new Date().toISOString()}] Error registering device:`, err.message);
    res.status(500).json({ message: "Error registering device" });
  }
});

// GET /devices - fleet registry with online flag (scoped to the sensor-path
// heartbeat, matching the disconnect monitor's staleness window).
//
//   (default)              -> active, non-archived devices (the normal fleet)
//   ?include_hidden=1      -> + hidden tanks, for the restore panel
//   ?include_archived=1    -> everything, archived included (the Devices page
//                             archive view). Asking for the archive implies
//                             "show me all of it": archiving always forces
//                             is_active = false, so without the bypass an
//                             archived device could never be listed.
app.get("/devices", requireAuth, async (req, res) => {
  try {
    const staleSeconds = Math.max(5, Math.floor(DISCONNECT_STALE_MS / 1000));
    const includeHidden = req.query.include_hidden === "1" || req.query.include_hidden === "true";
    const includeArchived = req.query.include_archived === "1" || req.query.include_archived === "true";
    const result = await pool.query(
      `SELECT ${DEVICE_COLUMNS},
              (last_seen > NOW() - ($1 || ' seconds')::interval) AS online
         FROM devices
        WHERE ($3 OR archived_at IS NULL)
          AND ($2 OR $3 OR is_active = true)
        ORDER BY archived_at NULLS FIRST, device_id`,
      [staleSeconds, includeHidden, includeArchived]
    );
    res.json(result.rows.map((row) => ({ ...row, online: !!row.online })));
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching devices:`, err.message);
    res.status(500).json({ message: "Error fetching devices" });
  }
});

// PUT /devices/:id (Admin) - rename a tank (tank_name), set its location, and/or
// hide or show it (is_active). The hardware device_id itself never changes, and
// neither does any archived state — use the archive/restore endpoints below for
// that. Hiding is non-destructive: rows/sensors stay, /devices just stops
// listing the tank and the restore panel (include_hidden=1) brings it back.
//
// Admin-only: renaming or hiding a tank is a registry/config change, and this
// route previously accepted any authenticated user (including plain 'user'
// role accounts). device_config / device_hide are likewise owner decisions.
app.put("/devices/:deviceId", requireAdmin, async (req, res) => {
  try {
    const { tank_name, tank_location, ip_address, is_active } = req.body;
    if (tank_name !== undefined && tank_name !== null && typeof tank_name !== "string") {
      return res.status(400).json({ message: "tank_name must be a string" });
    }
    if (tank_location !== undefined && tank_location !== null && typeof tank_location !== "string") {
      return res.status(400).json({ message: "tank_location must be a string" });
    }
    if (ip_address !== undefined && ip_address !== null && typeof ip_address !== "string") {
      return res.status(400).json({ message: "ip_address must be a string" });
    }
    if (is_active !== undefined && is_active !== null && typeof is_active !== "boolean") {
      return res.status(400).json({ message: "is_active must be a boolean" });
    }
    if (tank_name === undefined && tank_location === undefined && ip_address === undefined && is_active === undefined) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    // When an admin explicitly sets an IP address, mark it as manual so the
    // ingest upsert stops overwriting it with the observed peer address.
    const hasManualIp = typeof ip_address === "string" && ip_address.trim().length > 0;

    const result = await pool.query(
      `UPDATE devices
          SET tank_name = COALESCE($1, tank_name),
              tank_location = COALESCE($2, tank_location),
              ip_address = COALESCE($3, ip_address),
              ip_source = CASE WHEN $6 THEN 'manual' ELSE ip_source END,
              is_active = COALESCE($4, is_active)
        WHERE device_id = $5
        RETURNING ${DEVICE_COLUMNS}`,
      [
        typeof tank_name === "string" ? tank_name.trim() : null,
        typeof tank_location === "string" ? tank_location.trim() : null,
        typeof ip_address === "string" ? ip_address.trim() : null,
        is_active !== undefined ? is_active : null,
        req.params.deviceId,
        hasManualIp,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Device not found" });

    const staleSeconds = Math.max(5, Math.floor(DISCONNECT_STALE_MS / 1000));
    const onlineResult = await pool.query(
      `SELECT (last_seen > NOW() - ($2 || ' seconds')::interval) AS online
         FROM devices WHERE device_id = $1`,
      [req.params.deviceId, staleSeconds]
    );
    const row = result.rows[0];
    const updated = { ...row, online: !!onlineResult.rows[0]?.online };

    // Audit trail: who renamed/hid/restored which tank.
    const action =
      is_active === false ? "hid tank" : is_active === true ? "restored tank" : "renamed tank";
    const detail = `${action} ${row.device_id}` +
      (tank_name !== undefined ? ` (name: ${row.tank_name ?? "unchanged"})` : "");
    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'TANK_UPDATED', $2, 'devices')",
      [req.adminUser.username, detail]
    ).catch(() => {});

    res.json(updated);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error updating device:`, err.message);
    res.status(500).json({ message: "Error updating device" });
  }
});

// -----------------------------------------------------------------------------
// POST /devices/:id/rotate-secret (Admin) - issue a new per-device secret.
//
// A board can only receive a new secret through its WiFiManager config portal,
// so rotating is inherently a physical task: somebody has to reach the tank.
// Rotating with no overlap at all would guarantee an outage, and for a board
// that is ALREADY unreachable - the usual reason to rotate after a suspected
// compromise - it would leave the device permanently unable to report until
// someone carries a laptop to the tank.
//
// So the outgoing secret is kept valid for a bounded grace window (default 24h,
// hard-capped at 7 days) and the caller can pass grace_hours: 0 to revoke the
// old secret immediately, which is what a compromise response actually wants.
//
// The new secret is returned ONCE in this response and is never echoed by any
// read endpoint (DEVICE_COLUMNS deliberately excludes every secret column). It
// is never written to the logs or the activity trail - only the fact of the
// rotation is recorded.
// -----------------------------------------------------------------------------
const SECRET_GRACE_DEFAULT_MS = 24 * 60 * 60 * 1000; // 24h
const SECRET_GRACE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7d

function generateDeviceSecret() {
  // 32 bytes -> 64 hex chars. crypto.randomBytes is a CSPRNG, so this is not
  // guessable the way a timestamp/uuid-derived value would be.
  return crypto.randomBytes(32).toString("hex");
}

app.post("/devices/:deviceId/rotate-secret", requireAdmin, async (req, res) => {
  try {
    const { deviceId } = req.params;

    // Validate BEFORE generating anything, so a bad request cannot burn a secret.
    let graceMs = SECRET_GRACE_DEFAULT_MS;
    if (req.body && req.body.grace_hours !== undefined) {
      const raw = Number(req.body.grace_hours);
      if (!Number.isFinite(raw) || raw < 0) {
        return res.status(400).json({ message: "grace_hours must be a number >= 0" });
      }
      graceMs = Math.min(raw * 60 * 60 * 1000, SECRET_GRACE_MAX_MS);
    }
    if (Number(process.env.DEVICE_SECRET_GRACE_MS) > 0) {
      const envGrace = Number(process.env.DEVICE_SECRET_GRACE_MS);
      if (Number.isFinite(envGrace) && envGrace >= 0 && envGrace <= SECRET_GRACE_MAX_MS) {
        graceMs = envGrace;
      }
    }

    const existing = await pool.query(
      `SELECT device_id, device_secret, archived_at
         FROM devices WHERE device_id = $1`,
      [deviceId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ message: "Device not found" });
    }
    if (existing.rows[0].archived_at) {
      // An archived ID is permanently retired, so there is nothing to rotate.
      return res.status(409).json({
        message: `Device "${deviceId}" is archived. Its ID is permanently retired, so there is no secret to rotate.`,
      });
    }

    // A device still authenticating with the shared DEVICE_SECRET cannot be
    // "rotated" - the secret it holds is fleet-wide, so replacing it per device
    // would be a lie. The caller has to say explicitly that it means "migrate
    // this board onto its own per-device secret", which is a different and
    // strictly better operation, not a rotation.
    const isFirstSecret = !existing.rows[0].device_secret;
    const migrateFromShared =
      req.body?.migrate_from_shared === true || req.body?.migrate_from_shared === "true";

    if (isFirstSecret && !migrateFromShared) {
      return res.status(409).json({
        message:
          `Device "${deviceId}" has no per-device secret yet - it authenticates with the shared DEVICE_SECRET. ` +
          `Re-send with migrate_from_shared: true to issue its first per-device secret.`,
        can_migrate_from_shared: true,
      });
    }

    const newSecret = generateDeviceSecret();

    // One statement so the swap is atomic: a reader can never observe a window
    // where BOTH columns are NULL (device locked out) or both set to the same
    // value. device_secret_prev_expires_at is NULL when graceMs is 0, which the
    // chk_devices_secret_prev_pair CHECK requires alongside a NULL prev secret.
    //
    // On a first-secret migration there is no previous PER-DEVICE secret to
    // park, so both prev columns stay NULL - the grace window is meaningless
    // here. The shared secret is untouched either way; retiring that is a
    // separate, fleet-wide decision (see devices still on the shared secret).
    const result = await pool.query(
      `UPDATE devices
          SET device_secret = $2,
              device_secret_prev = CASE WHEN $3::bigint > 0 AND $4::boolean IS FALSE THEN device_secret ELSE NULL END,
              device_secret_prev_expires_at = CASE WHEN $3::bigint > 0 AND $4::boolean IS FALSE THEN NOW() + ($3 || ' milliseconds')::interval ELSE NULL END,
              device_secret_rotated_at = NOW()
        WHERE device_id = $1
        RETURNING device_id, device_secret_rotated_at,
                  device_secret_prev_expires_at`,
      [deviceId, newSecret, graceMs, isFirstSecret]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Device not found" });
    }

    const rotated = result.rows[0];
    const graceHours = Math.round(graceMs / (60 * 60 * 1000) * 10) / 10;

    // How much of the fleet is still on the shared secret. Reported on a
    // migration so the operator can see this is one board of N, and knows the
    // shared secret is still a live risk until they are all moved off it.
    let stillOnShared = null;
    if (isFirstSecret) {
      const shared = await pool.query(
        `SELECT count(*)::int AS n
           FROM devices
          WHERE archived_at IS NULL AND is_active = true AND device_secret IS NULL`
      );
      stillOnShared = shared.rows[0].n;
    }

    // Record the rotation, never the value.
    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'DEVICE_SECRET_ROTATED', $2, 'devices')",
      [
        req.adminUser.username,
        isFirstSecret
          ? `Issued a first per-device secret for ${deviceId} (migrated off the shared secret; ${stillOnShared} active devices still use the shared secret)`
          : `Rotated the secret for ${deviceId} (previous secret ${graceMs > 0 ? `valid for another ${graceHours}h` : "revoked immediately"})`,
      ]
    ).catch(() => {});

    console.log(
      `[${new Date().toISOString()}] Secret ${isFirstSecret ? "issued" : "rotated"} by ${req.adminUser.username} for ${deviceId} ` +
        (isFirstSecret
          ? `(first per-device secret; ${stillOnShared} active devices still on the shared secret)`
          : `(previous ${graceMs > 0 ? `valid ${graceHours}h` : "revoked now"})`)
    );

    res.json({
      device_id: deviceId,
      // Shown once. The UI must make the operator copy it before navigating away.
      device_secret: newSecret,
      rotated_at: rotated.device_secret_rotated_at,
      previous_secret_expires_at: rotated.device_secret_prev_expires_at,
      previous_secret_grace_hours: graceHours,
      previous_secret_revoked: graceMs === 0,
      // True when this was the board's first per-device secret rather than a
      // rotation. The grace window is meaningless in that case.
      first_secret: isFirstSecret,
      devices_still_on_shared_secret: stillOnShared,
      message: isFirstSecret
        ? "Copy this secret now - it is not shown again. " +
          "This board previously authenticated with the shared DEVICE_SECRET, which is still accepted " +
          (stillOnShared === 1
            ? "for the 1 other active device on it, so keep that secret treated as compromised until it is migrated too."
            : `for ${stillOnShared} other active devices, so keep that secret treated as compromised until they are migrated too.`)
        : "Copy this secret now - it is not shown again. " +
          (graceMs > 0
            ? `The previous secret keeps working for ${graceHours}h so the board can be reconfigured without an outage.`
            : "The previous secret was revoked immediately; the board stops reporting until it is reconfigured."),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error rotating device secret:`, err.message);
    res.status(500).json({ message: "Error rotating device secret" });
  }
});

// POST /devices/:id/archive (Admin) - soft-delete a decommissioned device.
//
// NOTHING IS DELETED. The row stays forever, and so does every reading that
// references it: sensors, last_alerts, system_logs and device_threshold_overrides
// all point at devices(device_id) and none of them cascade on delete. That is
// the whole point — the Owner retires a board without destroying the history
// that explains what it saw.
//
// Archiving is distinct from hiding:
//   hide   (is_active = false)  -> reversible, "not shown right now"
//   archive (archived_at set)   -> terminal, "this board is retired"
// Archive forces is_active = false, so all the existing `WHERE is_active = true`
// guards immediately stop picking it up: the per-device ingestion secret
// (server.cjs:1365), /devices/latest, the SMS alert list, and the device health
// poller (services/devicePoller.cjs:32).
//
// A board that keeps pushing after being archived is NOT rejected. Its readings
// are still recorded (no data is ever thrown away) but it stays invisible to
// every active surface. Rejecting would make the ESP32 requeue and retry
// forever, which is the exact failure mode the ammonia-spike fix removed.
app.post("/devices/:deviceId/archive", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE devices
          SET archived_at = NOW(),
              archived_by = $1,
              is_active = false
        WHERE device_id = $2
        RETURNING ${DEVICE_COLUMNS}`,
      [req.adminUser.username, req.params.deviceId]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Device not found" });

    const row = result.rows[0];

    // Drop the in-memory per-device caches so a retired board cannot keep
    // feeding the live tile, the SSE stream or the delta baseline. The DB rows
    // and all historical readings are untouched.
    evictDeviceFromMemory(req.params.deviceId);

    const readings = await pool.query(
      "SELECT COUNT(*)::int AS n FROM sensors WHERE device_id = $1",
      [req.params.deviceId]
    );

    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'DEVICE_ARCHIVED', $2, 'devices')",
      [req.adminUser.username, `Archived device ${row.device_id} (${row.tank_name ?? "unnamed"}); ${readings.rows[0].n} historical readings retained`]
    ).catch(() => {});

    console.log(`[${new Date().toISOString()}] Device archived by ${req.adminUser.username}: ${row.device_id} (${readings.rows[0].n} readings retained)`);
    res.json({ ...row, online: false, retained_readings: readings.rows[0].n });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error archiving device:`, err.message);
    res.status(500).json({ message: "Error archiving device" });
  }
});

// POST /devices/:id/restore (Admin) - bring an archived device back.
//
// Restoring is the ONLY way to reuse a retired board slot; the device_id itself
// is never released, so no other device can inherit this row's history.
app.post("/devices/:deviceId/restore", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE devices
          SET archived_at = NULL,
              archived_by = NULL,
              is_active = true
        WHERE device_id = $1
        RETURNING ${DEVICE_COLUMNS}`,
      [req.params.deviceId]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Device not found" });

    const row = result.rows[0];
    // last_seen may be stale from before the archive, which would otherwise flash
    // a disconnect alert on the first poll. The next ingest corrects it.
    evictDeviceFromMemory(req.params.deviceId);

    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'DEVICE_RESTORED', $2, 'devices')",
      [req.adminUser.username, `Restored device ${row.device_id} (${row.tank_name ?? "unnamed"})`]
    ).catch(() => {});

    console.log(`[${new Date().toISOString()}] Device restored by ${req.adminUser.username}: ${row.device_id}`);
    res.json(row);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error restoring device:`, err.message);
    res.status(500).json({ message: "Error restoring device" });
  }
});

// GET /devices/latest - freshest in-memory reading per active tank, in one
// lightweight call (in-memory read, no DB). Drives the Live Tank Bar.
app.get("/devices/latest", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT device_id FROM devices WHERE is_active = true AND archived_at IS NULL");
    const rows = [];
    for (const device of result.rows) {
      const latest = latestDeviceReadings.get(device.device_id);
      if (latest) {
        rows.push({ device_id: device.device_id, ...latest });
      }
    }
    res.json(rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching latest device readings:`, err.message);
    res.status(500).json({ message: "Error fetching latest readings" });
  }
});

// GET /devices/:id/status - live on-demand poll of one ESP32's GET /status.
// Diagnostic endpoint (not the data path); 3s timeout, 502/504 on failure.
app.get("/devices/:deviceId/status", requireAuth, async (req, res) => {
  try {
    const device = await pool.query(
      "SELECT device_id, ip_address FROM devices WHERE device_id = $1",
      [req.params.deviceId]
    );
    if (device.rows.length === 0) return res.status(404).json({ message: "Device not found" });
    const ip = device.rows[0].ip_address;
    if (!ip || ip === "") return res.status(400).json({ message: "Device has no IP address configured" });

    const response = await axios.get(`http://${ip}/status`, { timeout: 3000 });
    res.json(response.data);
  } catch (err) {
    if (err.code === "ECONNABORTED") {
      return res.status(504).json({ message: "Device timed out" });
    }
    fail(res, 502, "Device unreachable", err, req);
  }
});

// ========================
// WEEKLY REPORT ENDPOINT
// ========================

// GET /report/weekly - 7-day aggregated report (summary, daily breakdown, alert counts).
// Optional ?device_id scopes every query to one tank so the report (and the
// PDF export built from it) matches the selected tank's on-screen charts.
app.get("/report/weekly", requireAuth, async (req, res) => {
  try {
    const deviceId = req.query.device_id ? String(req.query.device_id) : null;
    let summaryResult;
    try {
      summaryResult = await pool.query(`
        SELECT
          (AVG(temperature) FILTER (WHERE temperature > 0))::float AS temp_avg,
          (MIN(temperature) FILTER (WHERE temperature > 0))::float AS temp_min,
          (MAX(temperature) FILTER (WHERE temperature > 0))::float AS temp_max,
          (AVG(water_level) FILTER (WHERE water_level >= 0))::float AS water_avg,
          (MIN(water_level) FILTER (WHERE water_level >= 0))::float AS water_min,
          (MAX(water_level) FILTER (WHERE water_level >= 0))::float AS water_max,
          (AVG(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_avg,
          (MIN(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_min,
          (MAX(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_max,
          COUNT(*) AS total_readings
        FROM sensors
        WHERE timestamp >= NOW() - INTERVAL '7 days'
          AND ($1::text IS NULL OR device_id = $1)
      `, [deviceId]);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Weekly summary query failed:`, err.message);
      // The query failed, so there is no aggregate to report. Handing back zeros
    // prints a whole week of "0.0 °C" in the PDF as if it had been measured;
    // nulls render as "--", and total_readings 0 makes the emptiness obvious.
    summaryResult = { rows: [{ temp_avg: null, temp_min: null, temp_max: null, water_avg: null, water_min: null, water_max: null, ammonia_avg: null, ammonia_min: null, ammonia_max: null, total_readings: 0 }] };
    }

    let dailyResult;
    try {
      dailyResult = await pool.query(`
        SELECT
          DATE(timestamp) AS date,
          (AVG(temperature) FILTER (WHERE temperature > 0))::float AS temp_avg,
          (MIN(temperature) FILTER (WHERE temperature > 0))::float AS temp_min,
          (MAX(temperature) FILTER (WHERE temperature > 0))::float AS temp_max,
          (AVG(water_level) FILTER (WHERE water_level >= 0))::float AS water_avg,
          (MIN(water_level) FILTER (WHERE water_level >= 0))::float AS water_min,
          (MAX(water_level) FILTER (WHERE water_level >= 0))::float AS water_max,
          (AVG(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_avg,
          (MIN(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_min,
          (MAX(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_max,
          COUNT(*) AS readings
        FROM sensors
        WHERE timestamp >= NOW() - INTERVAL '7 days'
          AND ($1::text IS NULL OR device_id = $1)
        GROUP BY DATE(timestamp)
        ORDER BY date
      `, [deviceId]);
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
          AND ($1::text IS NULL OR device_id = $1)
        GROUP BY DATE(timestamp)
      `, [deviceId]);
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
          AND ($1::text IS NULL OR device_id = $1)
        GROUP BY parameter
      `, [deviceId]);
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
          AND ($1::text IS NULL OR device_id = $1)
        GROUP BY action
      `, [deviceId]);
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
        temp_avg: numOrNull(day.temp_avg),
        temp_min: numOrNull(day.temp_min),
        temp_max: numOrNull(day.temp_max),
        water_avg: numOrNull(day.water_avg),
        water_min: numOrNull(day.water_min),
        water_max: numOrNull(day.water_max),
        ammonia_avg: numOrNull(day.ammonia_avg),
        ammonia_min: numOrNull(day.ammonia_min),
        ammonia_max: numOrNull(day.ammonia_max),
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
        temp_avg: numOrNull(summary.temp_avg),
        temp_min: numOrNull(summary.temp_min),
        temp_max: numOrNull(summary.temp_max),
        water_avg: numOrNull(summary.water_avg),
        water_min: numOrNull(summary.water_min),
        water_max: numOrNull(summary.water_max),
        ammonia_avg: numOrNull(summary.ammonia_avg),
        ammonia_min: numOrNull(summary.ammonia_min),
        ammonia_max: numOrNull(summary.ammonia_max),
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
    res.status(500).json({ message: "Error fetching weekly report" });
  }
});

// ========================
// RANGE REPORT ENDPOINT
// ========================

// GET /report/range - aggregated report for a custom window.
// ?hours=N (positive int) -> last N hours (hourly buckets when N <= 24);
// omitted/0 -> all time (daily buckets). Optional ?device_id scopes the
// aggregation (and the alert counts) to one tank. Exact DB aggregates,
// admin gated.
app.get("/report/range", requireAdmin, async (req, res) => {
  try {
    const parsedHours = parseInt(req.query.hours);
    const hasHours = Number.isFinite(parsedHours) && parsedHours > 0;
    const hours = hasHours ? parsedHours : null;
    const deviceId = req.query.device_id ? String(req.query.device_id) : null;
    const bucket = hasHours && hours <= 24 ? "hour" : "day";
    const timeFilter = hasHours ? `timestamp >= NOW() - INTERVAL '${hours} hours'` : "TRUE";
    const logTimeFilter = hasHours
      ? ` AND timestamp >= NOW() - INTERVAL '${hours} hours'`
      : "";
    const deviceFilter = `($1::text IS NULL OR device_id = $1)`;

    const bucketExpr =
      bucket === "hour"
        ? `to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD"T"HH24:00')`
        : `to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')`;

    let summaryResult;
    try {
      summaryResult = await pool.query(`
        SELECT
          (AVG(temperature) FILTER (WHERE temperature > 0))::float AS temp_avg,
          (MIN(temperature) FILTER (WHERE temperature > 0))::float AS temp_min,
          (MAX(temperature) FILTER (WHERE temperature > 0))::float AS temp_max,
          (AVG(water_level) FILTER (WHERE water_level >= 0))::float AS water_avg,
          (MIN(water_level) FILTER (WHERE water_level >= 0))::float AS water_min,
          (MAX(water_level) FILTER (WHERE water_level >= 0))::float AS water_max,
          (AVG(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_avg,
          (MIN(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_min,
          (MAX(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_max,
          COUNT(*) AS total_readings
        FROM sensors
        WHERE ${deviceFilter} AND ${timeFilter}
      `, [deviceId]);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Range summary query failed:`, err.message);
      // The query failed, so there is no aggregate to report. Handing back zeros
    // prints a whole week of "0.0 °C" in the PDF as if it had been measured;
    // nulls render as "--", and total_readings 0 makes the emptiness obvious.
    summaryResult = { rows: [{ temp_avg: null, temp_min: null, temp_max: null, water_avg: null, water_min: null, water_max: null, ammonia_avg: null, ammonia_min: null, ammonia_max: null, total_readings: 0 }] };
    }

    let bucketsResult;
    try {
      bucketsResult = await pool.query(`
        SELECT
          ${bucketExpr} AS label,
          (AVG(temperature) FILTER (WHERE temperature > 0))::float AS temp_avg,
          (MIN(temperature) FILTER (WHERE temperature > 0))::float AS temp_min,
          (MAX(temperature) FILTER (WHERE temperature > 0))::float AS temp_max,
          (AVG(water_level) FILTER (WHERE water_level >= 0))::float AS water_avg,
          (MIN(water_level) FILTER (WHERE water_level >= 0))::float AS water_min,
          (MAX(water_level) FILTER (WHERE water_level >= 0))::float AS water_max,
          (AVG(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_avg,
          (MIN(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_min,
          (MAX(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_max,
          COUNT(*) AS readings
        FROM sensors
        WHERE ${deviceFilter} AND ${timeFilter}
        GROUP BY label
        ORDER BY label DESC
        LIMIT 1000
      `, [deviceId]);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Range buckets query failed:`, err.message);
      bucketsResult = { rows: [] };
    }

    // Per-bucket alert counts from system_logs (matches bucket label format).
    let bucketAlertsMap = {};
    try {
      const bucketAlertsResult = await pool.query(`
        SELECT ${bucketExpr} AS label, COUNT(*) AS count
        FROM system_logs
        WHERE action = 'Alert' AND ${deviceFilter}${logTimeFilter}
        GROUP BY label
      `, [deviceId]);
      bucketAlertsResult.rows.forEach(row => {
        bucketAlertsMap[row.label] = parseInt(row.count) || 0;
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Range bucket alerts query failed:`, err.message);
      bucketAlertsMap = {};
    }

    let byParameter = {};
    try {
      const alertsByParamResult = await pool.query(`
        SELECT parameter, COUNT(*) AS count
        FROM system_logs
        WHERE action = 'Alert' AND ${deviceFilter}${logTimeFilter}
        GROUP BY parameter
      `, [deviceId]);
      alertsByParamResult.rows.forEach(row => { byParameter[row.parameter] = parseInt(row.count) || 0; });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Range alerts by param query failed:`, err.message);
      byParameter = {};
    }

    let byAction = {};
    try {
      const logActionsResult = await pool.query(`
        SELECT action, COUNT(*)::int AS count
        FROM system_logs
        WHERE ${deviceFilter}${logTimeFilter}
        GROUP BY action
      `, [deviceId]);
      logActionsResult.rows.forEach(row => { byAction[row.action] = row.count; });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Range log actions query failed:`, err.message);
      byAction = {};
    }

    const now = new Date();
    let startIso = hasHours ? new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString() : null;
    if (!startIso) {
      try {
        const earliest = await pool.query("SELECT MIN(timestamp) AS first_ts FROM sensors WHERE ($1::text IS NULL OR device_id = $1)", [deviceId]);
        const firstTs = earliest.rows[0] && earliest.rows[0].first_ts;
        startIso = firstTs ? new Date(firstTs).toISOString() : now.toISOString();
      } catch {
        startIso = now.toISOString();
      }
    }

    // Cap to the most recent 1000 buckets ascending (ORDER BY label DESC above).
    const daily = (bucketsResult.rows || [])
      .slice()
      .reverse()
      .map((row) => ({
        date: row.label,
        temp_avg: numOrNull(row.temp_avg),
        temp_min: numOrNull(row.temp_min),
        temp_max: numOrNull(row.temp_max),
        water_avg: numOrNull(row.water_avg),
        water_min: numOrNull(row.water_min),
        water_max: numOrNull(row.water_max),
        ammonia_avg: numOrNull(row.ammonia_avg),
        ammonia_min: numOrNull(row.ammonia_min),
        ammonia_max: numOrNull(row.ammonia_max),
        readings: parseInt(row.readings) || 0,
        alerts: bucketAlertsMap[row.label] || 0,
      }));

    const summary = summaryResult.rows[0] || {};
    const totalAlerts = Object.values(byParameter).reduce((sum, c) => sum + c, 0);

    res.json({
      period: { start: startIso, end: now.toISOString() },
      bucket,
      summary: {
        temp_avg: numOrNull(summary.temp_avg),
        temp_min: numOrNull(summary.temp_min),
        temp_max: numOrNull(summary.temp_max),
        water_avg: numOrNull(summary.water_avg),
        water_min: numOrNull(summary.water_min),
        water_max: numOrNull(summary.water_max),
        ammonia_avg: numOrNull(summary.ammonia_avg),
        ammonia_min: numOrNull(summary.ammonia_min),
        ammonia_max: numOrNull(summary.ammonia_max),
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
    console.error(`[${new Date().toISOString()}] Error fetching range report:`, err.message);
    res.status(500).json({ message: "Error fetching range report" });
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

    const result = await pool.query("SELECT * FROM users WHERE username = $1 AND status = 'active'", [username]);
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
        [hashToken(token), tokenExpiresAt, upgradedHash, user.id]
      );
    } else {
      await pool.query("UPDATE users SET token = $1, token_expires_at = $2 WHERE id = $3", [hashToken(token), tokenExpiresAt, user.id]);
    }

    // The cookie MUST be attached before the response is sent. res.json()
    // writes the head and flushes it, so anything appended afterwards lands in
    // the error path with ERR_HTTP_HEADERS_SENT - the login "succeeds" from the
    // client's point of view and silently comes back without a session.
    setSessionCookie(res, token, tokenExpiresAt);
    res.json({
      message: "Login successful",
      user: { id: user.id, username: user.username, email: user.email, role: user.role, name: user.name, owner: isOwnerUser(user), protected: isOwnerUser(user) },
      // The token is deliberately NOT in the body any more. Returning it here
      // would put a replayable credential back into JavaScript's reach, which
      // is the whole thing the cookie exists to prevent.
      tokenExpiresAt: tokenExpiresAt.toISOString(),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Login error:`, err.message);
    res.status(500).json({ message: "Login failed" });
  }
});

// POST /auth/logout - revoke the current session token
app.post("/auth/logout", requireAuth, async (req, res) => {
  try {
    await pool.query("UPDATE users SET token = NULL, token_expires_at = NULL WHERE id = $1", [req.user.id]);
    clearSessionCookie(res);
    res.json({ message: "Logged out" });
  } catch (err) {
    return fail(res, 500, "Error logging out", err, req);
  }
});

// GET /auth/users (Admin only) - list all users, newest first, with a
// `protected` flag so the UI can disable deletion for the owner + last admin
// exactly the same way the server enforces it.
app.get("/auth/users", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, username, email, role, created_at, status FROM users WHERE status <> 'archived' ORDER BY created_at DESC");
    const adminCount = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'");
    const nAdmins = adminCount.rows[0].n;
    const rows = result.rows.map((u) => ({
      ...u,
      owner: isOwnerUser(u),
      protected: isOwnerUser(u) || (u.role === "admin" && nAdmins <= 1),
    }));
    res.json(rows);
  } catch (err) {
    fail(res, 500, "Error fetching users", err, req);
  }
});

// =============================================================================
// ARCHIVED USER ACCOUNTS (soft-delete + restore)
// =============================================================================
// Deletion is now a soft archive: the row stays in `users` with
// status='archived' + deleted_at=NOW() so the audit trail (activity_logs,
// user_deletion_requests) keeps pointing at a real account and the account can
// be restored. Archived accounts cannot log in (auth filters status='active').

// GET /auth/users/archived (Admin only) - list restorable archived accounts
app.get("/auth/users/archived", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, username, email, role, created_at, status, deleted_at
         FROM users WHERE status = 'archived'
        ORDER BY deleted_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    fail(res, 500, "Error fetching archived users", err, req);
  }
});

// POST /auth/users/:id/restore (Admin only) - bring an archived account back
app.post("/auth/users/:id/restore", requireAdmin, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const found = await client.query(
      "SELECT id, username, email, role FROM users WHERE id = $1 AND status = 'archived' FOR UPDATE",
      [req.params.id]
    );
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No archived user with this id" });
    }
    const archived = found.rows[0];

    // The owner can never be archived by the guards, but double-check anyway.
    if (isOwnerUser(archived)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "The owner account cannot be restored (it was never archived)." });
    }

    // Restoring conflicts with a LIVE account sharing the username or email.
    const conflict = await client.query(
      `SELECT username, email FROM users
        WHERE id <> $1 AND status IS DISTINCT FROM 'archived'
          AND (username = $2 OR email = $3)
        LIMIT 1`,
      [archived.id, archived.username, archived.email]
    );
    if (conflict.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message:
          "Cannot restore: the username or email is already taken by an active account.",
        conflict: conflict.rows[0],
      });
    }

    const restored = await client.query(
      `UPDATE users SET status = 'active', deleted_at = NULL
        WHERE id = $1 RETURNING id, name, username, email, role, created_at`,
      [archived.id]
    );

    await client.query(
      `INSERT INTO activity_logs (user_name, action_type, description, module)
       VALUES ($1, 'USER_RESTORED', $2, 'settings')`,
      [req.adminUser.username, `Restored user account "${archived.username}" from archive`]
    );

    await client.query("COMMIT");
    res.json({ message: "User restored", data: restored.rows[0] });
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    console.error(`[${new Date().toISOString()}] Error restoring user:`, err.message);
    res.status(500).json({ message: "Error restoring user" });
  } finally {
    if (client) client.release();
  }
});

// DELETE /auth/users/archived/:id (Admin only) - permanently purge an archived
// user. Cascade-deletes user_deletion_requests; activity_logs.user_name is SET NULL.
app.delete("/auth/users/archived/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM users WHERE id = $1 AND status = 'archived' RETURNING username",
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Archived user not found" });
    await pool.query(
      `INSERT INTO activity_logs (user_name, action_type, description, module)
       VALUES ($1, 'USER_PURGED', $2, 'settings')`,
      [req.adminUser.username, `Permanently purged archived user "${result.rows[0].username}"`]
    );
    res.json({ message: "User permanently deleted", username: result.rows[0].username });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error purging archived user:`, err.message);
    res.status(500).json({ message: "Error purging archived user" });
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
    return fail(res, 500, "Error creating user", err, req);
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
      "SELECT id, username, email, role FROM users WHERE id = $1 AND status = 'active'",
      [req.params.id]
    );
    if (targetResult.rows.length === 0) return res.status(404).json({ message: "Target user not found" });
    const target = targetResult.rows[0];

    // The owner and the last remaining admin can never be deleted — reject the
    // request here (before any OTP is generated) so protected accounts don't
    // even reach the mailbox step.
    const guardError = await assertUserDeletable(target);
    if (guardError) return res.status(400).json({ message: guardError });

    // OTP recipient: OTP_EMAIL overrides the target user's own address so the
    // confirmation code always lands in the owner's inbox (the mailbox the farm
    // admin actually checks), falling back to the target account's email.
    const otpRecipient = (process.env.OTP_EMAIL || "").trim() || target.email;
    if (!otpRecipient) {
      return res.status(400).json({ message: "No OTP recipient email configured and the target user has no email address." });
    }

    const passwordOk = verifyPassword(password, req.adminUser.password_hash);
    if (!passwordOk) return res.status(403).json({ message: "Incorrect password" });

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

    let emailResult;
    try {
      emailResult = await sendOtpEmail({
        to: otpRecipient,
        code,
        actorUsername: req.adminUser.username,
        actorName: req.adminUser.name || req.adminUser.username,
        targetUsername: target.username,
        deletedByOwner: isOwnerUser(req.adminUser),
      });
    } catch (emailErr) {
      // SMTP down / auth failure: the OTP never left the server, so remove the
      // just-created request row — no phantom PENDING_OTP may linger.
      await pool.query("DELETE FROM user_deletion_requests WHERE id = $1", [created.rows[0].id]);
      throw emailErr;
    }

    res.status(201).json({
      message: emailResult.delivered
        ? `Confirmation code sent to ${otpRecipient}`
        : "Confirmation code generated (dev mode — SMTP not configured). Check server console.",
      request_id: created.rows[0].id,
      otp_sent: emailResult.delivered,
      email_to: otpRecipient,
      dev_fallback: emailResult.devFallback || false,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error requesting user deletion:`, err.message);
    res.status(500).json({ message: "Error requesting user deletion" });
  }
});

// POST /auth/users/:id/deletion-verify (Admin only)
// Verifies the emailed OTP (constant-time) and soft-deletes (archives) the user
// + audit chain. The account row is kept with status='archived' so it can be
// restored via POST /auth/users/:id/restore.
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

    // Re-verify the target is deletable even with a valid OTP in hand — guards
    // against a stale/malicious request created before the account became the
    // owner or the last admin. Rolled back cleanly so no attempt is consumed.
    const targetUser = await client.query(
      "SELECT id, username, email, role FROM users WHERE id = $1 AND status = 'active'",
      [req.params.id]
    );
    if (targetUser.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found" });
    }
    const guardError = await assertUserDeletable(targetUser.rows[0], client);
    if (guardError) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: guardError });
    }

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
      return res.status(403).json({
        message: attempts >= OTP_MAX_ATTEMPTS ? "Too many incorrect codes — request invalidated" : `Incorrect code (${attempts}/${OTP_MAX_ATTEMPTS})`,
        remaining_attempts: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
      });
    }

    const userDel = await client.query(
      `UPDATE users SET status = 'archived', deleted_at = NOW(), pending_deletion_at = NULL
        WHERE id = $1 RETURNING username`,
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
       VALUES ($1, 'USER_ARCHIVED', $2, 'settings')`,
      [actor, `Archived user account "${userDel.rows[0].username}" via OTP verification (restorable)`]
    );

    await client.query("COMMIT");

    res.json({ message: "User archived (restorable)", username: userDel.rows[0].username });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[${new Date().toISOString()}] Error verifying deletion OTP:`, err.message);
    res.status(500).json({ message: "Error verifying deletion OTP" });
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
    fail(res, 500, "Error fetching deletion requests", err, req);
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
    fail(res, 500, "Error updating password", err, req);
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
    fail(res, 500, "Error fetching settings", err, req);
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
      // Record each threshold change in system_logs so the Alerts/Logs pages show
      // a "Change" entry for every setting that actually changed.
      const changeParamLabels = {
        temp_min: "Temperature",
        temp_max: "Temperature",
        water_level_min: "Water Level",
        water_level_max: "Water Level",
        ammonia_min: "Ammonia",
        ammonia_max: "Ammonia",
      };
      for (const [field, newValue] of Object.entries(changes)) {
        const paramLabel = changeParamLabels[field] || field;
        await pool.query(
          `INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)`,
          ["Change", paramLabel, String(existing.rows[0][field] ?? ""), String(newValue)]
        );
      }
    } else {
      const result = await pool.query(
        `INSERT INTO sensor_settings (temp_min, temp_max, water_level_min, water_level_max, ammonia_min, ammonia_max) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [temp_min, temp_max, water_level_min, water_level_max, ammonia_min, ammonia_max]
      );
      savedSettings = result.rows[0];
    }
    res.json({ message: "Settings saved", changed: true, data: savedSettings });
  } catch (err) {
    fail(res, 500, "Error saving settings", err, req);
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
    fail(res, 500, "Error resetting settings", err, req);
  }
});

// ========================
// PER-TANK THRESHOLD OVERRIDES (migration 012)
// ========================
// Global sensor_settings stays the farm default; device_threshold_overrides
// layers per-tank values on top (NULL column = inherit global).

const THRESHOLD_FIELDS = ["temp_min", "temp_max", "water_level_min", "water_level_max", "ammonia_min", "ammonia_max"];

// Layered thresholds: override row (nullable columns) over the global row.
function layerThresholds(globalRow, overrideRow) {
  const global = globalRow || DEFAULT_THRESHOLDS;
  const override = overrideRow || {};
  const out = {};
  for (const field of THRESHOLD_FIELDS) {
    out[field] = override[field] != null ? Number(override[field]) : Number(global[field] ?? DEFAULT_THRESHOLDS[field] ?? 0);
  }
  return out;
}

// GET /settings/effective - global row + one entry per tank that HAS an
// override. The frontend evaluates threshold status per tank from this map;
// tanks not listed inherit the global row.
app.get("/settings/effective", requireAuth, async (req, res) => {
  try {
    const [globalResult, overridesResult] = await Promise.all([
      pool.query("SELECT * FROM sensor_settings LIMIT 1"),
      pool.query("SELECT * FROM device_threshold_overrides ORDER BY device_id").catch(() => ({ rows: [] })),
    ]);
    const global = layerThresholds(globalResult.rows[0], null);
    const devices = {};
    for (const row of overridesResult.rows) {
      devices[row.device_id] = layerThresholds(globalResult.rows[0], row);
    }
    res.json({ global, devices });
  } catch (err) {
    fail(res, 500, "Error fetching effective thresholds", err, req);
  }
});

// GET /settings/device/:deviceId (Admin) - the tank's effective thresholds,
// which fields are overridden, and the raw override row.
app.get("/settings/device/:deviceId", requireAdmin, async (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const device = await pool.query("SELECT device_id, tank_name, tank_location FROM devices WHERE device_id = $1", [deviceId]);
    if (device.rows.length === 0) return res.status(404).json({ message: "Device not found" });
    const [globalResult, overrideResult] = await Promise.all([
      pool.query("SELECT * FROM sensor_settings LIMIT 1"),
      pool.query("SELECT * FROM device_threshold_overrides WHERE device_id = $1", [deviceId]).catch(() => ({ rows: [] })),
    ]);
    const override = overrideResult.rows[0] || null;
    const effective = layerThresholds(globalResult.rows[0], override);
    const overridden = {};
    for (const field of THRESHOLD_FIELDS) overridden[field] = Boolean(override && override[field] != null);
    res.json({
      device_id: deviceId,
      tank_name: device.rows[0].tank_name,
      tank_location: device.rows[0].tank_location,
      global: layerThresholds(globalResult.rows[0], null),
      effective,
      overridden,
      override,
    });
  } catch (err) {
    fail(res, 500, "Error fetching device thresholds", err, req);
  }
});

// PUT /settings/device/:deviceId (Admin) - upsert a PARTIAL override; only the
// provided fields change. Effective pairs are validated against the global
// layer so min < max always holds for the tank. Every changed field logs a
// system_logs "Change" row attributed to this tank.
app.put("/settings/device/:deviceId", requireAdmin, async (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const device = await pool.query("SELECT device_id, tank_name FROM devices WHERE device_id = $1", [deviceId]);
    if (device.rows.length === 0) return res.status(404).json({ message: "Device not found" });

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
    if (Object.keys(parsed).length === 0) return res.status(400).json({ message: "No threshold fields provided" });

    const [globalResult, existingResult] = await Promise.all([
      pool.query("SELECT * FROM sensor_settings LIMIT 1"),
      pool.query("SELECT * FROM device_threshold_overrides WHERE device_id = $1", [deviceId]).catch(() => ({ rows: [] })),
    ]);
    const existing = existingResult.rows[0] || null;

    // Merge the patch onto the current override, then validate the EFFECTIVE
    // pairs (override value where set, else the global value).
    const merged = { ...existing, ...parsed };
    const effectiveBefore = layerThresholds(globalResult.rows[0], existing);
    const effectiveAfter = layerThresholds(globalResult.rows[0], merged);
    const pairChecks = [
      { label: "Temperature", min: effectiveAfter.temp_min, max: effectiveAfter.temp_max },
      { label: "Water Level", min: effectiveAfter.water_level_min, max: effectiveAfter.water_level_max },
      { label: "Ammonia", min: effectiveAfter.ammonia_min, max: effectiveAfter.ammonia_max },
    ];
    for (const pair of pairChecks) {
      if (pair.min >= pair.max) {
        return res.status(400).json({ message: `${pair.label} effective min must be less than max (override or global)` });
      }
    }

    const overrideValues = {};
    for (const field of THRESHOLD_FIELDS) overrideValues[field] = merged[field] != null ? merged[field] : null;
    const result = await pool.query(
      `INSERT INTO device_threshold_overrides
         (device_id, temp_min, temp_max, water_level_min, water_level_max, ammonia_min, ammonia_max, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (device_id) DO UPDATE SET
         temp_min = EXCLUDED.temp_min, temp_max = EXCLUDED.temp_max,
         water_level_min = EXCLUDED.water_level_min, water_level_max = EXCLUDED.water_level_max,
         ammonia_min = EXCLUDED.ammonia_min, ammonia_max = EXCLUDED.ammonia_max,
         updated_at = NOW()
       RETURNING *`,
      [deviceId, ...THRESHOLD_FIELDS.map((f) => overrideValues[f])]
    );

    const changeParamLabels = {
      temp_min: "Temperature",
      temp_max: "Temperature",
      water_level_min: "Water Level",
      water_level_max: "Water Level",
      ammonia_min: "Ammonia",
      ammonia_max: "Ammonia",
    };
    // Iterating `parsed` means only the fields the caller actually sent are
    // logged. The values recorded are the effective before/after, not the raw
    // input, so a threshold that resolved through the global default is logged
    // as the number that is really in force.
    for (const field of Object.keys(parsed)) {
      const paramLabel = changeParamLabels[field] || field;
      await pool.query(
        `INSERT INTO system_logs (action, parameter, old_value, new_value, device_id) VALUES ($1, $2, $3, $4, $5)`,
        ["Change", paramLabel, String(effectiveBefore[field] ?? ""), String(effectiveAfter[field] ?? ""), deviceId]
      );
    }

    res.json({
      message: `Thresholds saved for tank ${device.rows[0].tank_name || deviceId}`,
      device_id: deviceId,
      override: result.rows[0],
      effective: effectiveAfter,
    });
  } catch (err) {
    fail(res, 500, "Error saving device thresholds", err, req);
  }
});

// DELETE /settings/device/:deviceId (Admin) - clear the tank's overrides so it
// inherits the global thresholds again.
app.delete("/settings/device/:deviceId", requireAdmin, async (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const result = await pool.query("DELETE FROM device_threshold_overrides WHERE device_id = $1 RETURNING *", [deviceId]);
    if (result.rows.length === 0) return res.status(404).json({ message: "No overrides set for this tank" });
    await pool.query(
      `INSERT INTO system_logs (action, parameter, old_value, new_value, device_id) VALUES ($1, $2, $3, $4, $5)`,
      ["Change", "Thresholds", "custom", "global", deviceId]
    );
    const globalResult = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
    res.json({
      message: "Overrides cleared — tank now uses global thresholds",
      device_id: deviceId,
      effective: layerThresholds(globalResult.rows[0], null),
    });
  } catch (err) {
    fail(res, 500, "Error clearing device thresholds", err, req);
  }
});

// ========================
// SMS RECIPIENT ENDPOINTS
// ========================

// GET /settings/recipients (Admin) - list SMS recipients
app.get("/settings/recipients", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, phone_number, name, is_active, created_at FROM authorized_recipients WHERE archived_at IS NULL ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching SMS recipients:`, err.message);
    res.status(500).json({ message: "Error fetching SMS recipients" });
  }
});

// POST /settings/recipients (Admin) - add a recipient (PH format, e.g. 09XXXXXXXXX
// or +639XXXXXXXXX — stored normalized as +639XXXXXXXXX)
app.post("/settings/recipients", requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const normalizedPhone = normalizePhNumber(req.body?.phone_number);
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Phone number must be a valid PH mobile: 09XXXXXXXXX or +639XXXXXXXXX" });
    }
    const result = await pool.query(
      "INSERT INTO authorized_recipients (name, phone_number) VALUES ($1, $2) RETURNING id, phone_number, name, is_active, created_at",
      [name, normalizedPhone]
    );
    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'SMS_RECIPIENT_ADDED', $2, 'settings')",
      [req.adminUser.username, `Added SMS recipient ${normalizedPhone}`]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ message: "Phone number already exists" });
    console.error(`[${new Date().toISOString()}] Error adding SMS recipient:`, err.message);
    res.status(500).json({ message: "Error adding SMS recipient" });
  }
});

// PUT /settings/recipients/:id (Admin) - rename and/or toggle recipient on/off
app.put("/settings/recipients/:id", requireAdmin, async (req, res) => {
  try {
    const { name, is_active } = req.body;
    if (name !== undefined && name !== null && typeof name !== "string") {
      return res.status(400).json({ message: "name must be a string" });
    }
    if (is_active !== undefined && is_active !== null && typeof is_active !== "boolean") {
      return res.status(400).json({ message: "is_active must be a boolean" });
    }
    const result = await pool.query(
      `UPDATE authorized_recipients
          SET name = COALESCE($1, name),
              is_active = COALESCE($2, is_active),
              updated_at = NOW()
        WHERE id = $3 AND archived_at IS NULL
        RETURNING id, phone_number, name, is_active, created_at`,
      [name !== undefined ? name.trim() : null, is_active !== undefined ? is_active : null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Recipient not found" });
    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'SMS_RECIPIENT_UPDATED', $2, 'settings')",
      [req.adminUser.username, `Updated SMS recipient ${result.rows[0].phone_number}`]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error updating SMS recipient:`, err.message);
    res.status(500).json({ message: "Error updating SMS recipient" });
  }
});

// DELETE /settings/recipients/:id (Admin) - archive a recipient (soft-delete,
// reversible via POST /settings/recipients/:id/restore)
app.delete("/settings/recipients/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE authorized_recipients SET archived_at = NOW()
        WHERE id = $1 AND archived_at IS NULL
        RETURNING phone_number`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Recipient not found" });
    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'SMS_RECIPIENT_ARCHIVED', $2, 'settings')",
      [req.adminUser.username, `Archived SMS recipient ${result.rows[0].phone_number} (restorable)`]
    );
    res.json({ message: "SMS recipient archived (restorable)", phone_number: result.rows[0].phone_number });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error archiving SMS recipient:`, err.message);
    res.status(500).json({ message: "Error archiving SMS recipient" });
  }
});

// =============================================================================
// ARCHIVED SMS RECIPIENTS (soft-delete + restore + purge)
// =============================================================================

// GET /settings/recipients/archived (Admin) - list archived recipients
app.get("/settings/recipients/archived", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, phone_number, name, is_active, created_at, archived_at
         FROM authorized_recipients WHERE archived_at IS NOT NULL
        ORDER BY archived_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching archived SMS recipients:`, err.message);
    res.status(500).json({ message: "Error fetching archived SMS recipients" });
  }
});

// POST /settings/recipients/:id/archive (Admin) - explicit archive
app.post("/settings/recipients/:id/archive", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE authorized_recipients SET archived_at = NOW()
        WHERE id = $1 AND archived_at IS NULL
        RETURNING phone_number`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Recipient not found" });
    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'SMS_RECIPIENT_ARCHIVED', $2, 'settings')",
      [req.adminUser.username, `Archived SMS recipient ${result.rows[0].phone_number} (restorable)`]
    );
    res.json({ message: "SMS recipient archived (restorable)", phone_number: result.rows[0].phone_number });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error archiving SMS recipient:`, err.message);
    res.status(500).json({ message: "Error archiving SMS recipient" });
  }
});

// POST /settings/recipients/:id/restore (Admin) - bring an archived recipient back
app.post("/settings/recipients/:id/restore", requireAdmin, async (req, res) => {
  try {
    const found = await pool.query(
      "SELECT id, phone_number FROM authorized_recipients WHERE id = $1 AND archived_at IS NOT NULL",
      [req.params.id]
    );
    if (found.rows.length === 0) return res.status(404).json({ message: "No archived recipient with this id" });

    // A live recipient may already occupy the phone number.
    const conflict = await pool.query(
      "SELECT id FROM authorized_recipients WHERE phone_number = $1 AND archived_at IS NULL",
      [found.rows[0].phone_number]
    );
    if (conflict.rows.length > 0) {
      return res.status(409).json({
        message: "Cannot restore: an active recipient already uses this phone number.",
      });
    }

    const result = await pool.query(
      `UPDATE authorized_recipients SET archived_at = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING id, phone_number, name, is_active, created_at`,
      [req.params.id]
    );
    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'SMS_RECIPIENT_RESTORED', $2, 'settings')",
      [req.adminUser.username, `Restored SMS recipient ${result.rows[0].phone_number} from archive`]
    );
    res.json({ message: "SMS recipient restored", data: result.rows[0] });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error restoring SMS recipient:`, err.message);
    res.status(500).json({ message: "Error restoring SMS recipient" });
  }
});

// DELETE /settings/recipients/archived/:id (Admin) - permanent purge of an
// archived recipient (the only irreversible operation; archived users are never
// purged by the API).
app.delete("/settings/recipients/archived/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM authorized_recipients WHERE id = $1 AND archived_at IS NOT NULL RETURNING phone_number",
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Archived recipient not found" });
    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'SMS_RECIPIENT_PURGED', $2, 'settings')",
      [req.adminUser.username, `Permanently purged SMS recipient ${result.rows[0].phone_number}`]
    );
    res.json({ message: "SMS recipient permanently deleted", phone_number: result.rows[0].phone_number });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error purging SMS recipient:`, err.message);
    res.status(500).json({ message: "Error purging SMS recipient" });
  }
});

// POST /settings/recipients/test/:id (Admin) - send a test SMS to ONE recipient
app.post("/settings/recipients/test/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, phone_number, name FROM authorized_recipients WHERE id = $1 AND archived_at IS NULL", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: "Recipient not found" });
    const recipient = result.rows[0];
    const content = [
      "CRAYVINGS AQUACULTURE MONITORING — TEST MESSAGE",
      `Date: ${formatSmsTime()}`,
      "",
      "This is a test SMS from the CRAYvings Monitoring System.",
      `If you received this message, the contact ${recipient.name || recipient.phone_number} is configured correctly.`,
      "",
      "No action is required.",
    ].join("\n");
    try {
      const smsId = await sendHttpsms({ to: recipient.phone_number, content });
      await logSms(recipient.phone_number, content, "queued", null, smsId);
      return res.json({ success: true, message: "Test SMS sent", recipient: recipient.name || recipient.phone_number });
    } catch (err) {
      await logSms(recipient.phone_number, content, "failed", err.message);
      return fail(res, 500, "Failed to send test SMS", err, req);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error sending test SMS:`, err.message);
    res.status(500).json({ message: "Error sending test SMS" });
  }
});

// POST /alert/status (Admin) - send the status update SMS immediately (manual
// trigger). ?device_id= scopes the report to one tank; without it the report is
// a fleet digest with one block per active tank.
app.post("/alert/status", requireAdmin, async (req, res) => {
  try {
    const deviceId = req.query.device_id ? String(req.query.device_id) : (req.body?.device_id ? String(req.body.device_id) : null);
    if (isSmsMutedFor(deviceId)) return res.status(429).json({ message: "SMS alerts are muted" });
    const content = await buildStatusSms(deviceId);
    if (!content) return res.status(409).json({ message: "No sensor data available yet" });
    const { sent, total } = await sendSmsToRecipients(content);
    res.json({ sent, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error sending status SMS:`, err.message);
    res.status(500).json({ message: "Error sending status SMS" });
  }
});

// POST /alert/mute (Admin) - suppress SMS for N hours (0 = unmute).
// ?device_id= (or body device_id) mutes ONE tank; omitted -> global mute.
// Both layers persist in system_state, so a restart no longer clears them.
//
// SMS mute exists for "that sensor is broken, stop texting me", so it is capped
// the same way the secret-rotation grace window is (7 days). Without a ceiling a
// single request could silence every alert indefinitely, and an operator who
// forgets they muted it gets a farm that looks healthy because nothing is being
// reported. Capping also makes the worst case recoverable on its own.
const SMS_MUTE_MAX_HOURS = 7 * 24;

const muteRequestSchema = z.object({
  // Absent/blank means "unmute", which is what the old parseInt(..) || 0 did.
  // That is why this is a preprocess and not a .catch(0): a catch would also
  // swallow an out-of-range value and quietly unmute instead of rejecting it.
  hours: z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? 0 : v),
    z.coerce.number().int().min(0).max(SMS_MUTE_MAX_HOURS)
  ),
  device_id: z.string().min(1).max(50).optional(),
});

app.post("/alert/mute", requireAdmin, async (req, res) => {
  try {
    const parsed = muteRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        message: `Invalid mute request: hours must be a whole number between 0 and ${SMS_MUTE_MAX_HOURS}`,
        errors: zodFieldErrors(parsed.error),
      });
    }
    const hours = parsed.data.hours;
    const deviceId = parsed.data.device_id ?? (req.query.device_id ? String(req.query.device_id) : null);

    if (deviceId) {
      const device = await pool.query("SELECT device_id, tank_name FROM devices WHERE device_id = $1", [deviceId]);
      if (device.rows.length === 0) return res.status(404).json({ message: "Device not found" });
      const label = device.rows[0].tank_name || deviceId;
      if (hours <= 0) {
        deviceSmsMuteUntil.delete(deviceId);
        await persistMuteState(`sms_mute:${deviceId}`, null);
        return res.json({ muted: false, muteExpires: null, device_id: deviceId, message: `SMS alerts unmuted for tank ${label}` });
      }
      const muteExpires = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      deviceSmsMuteUntil.set(deviceId, muteExpires);
      await persistMuteState(`sms_mute:${deviceId}`, muteExpires);
      await pool.query(
        "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'SMS_MUTED', $2, 'settings')",
        [req.adminUser.username, `Tank ${label} (${deviceId}) SMS muted for ${hours}h until ${muteExpires}`]
      ).catch(() => {});
      return res.json({ muted: true, muteExpires, device_id: deviceId, message: `SMS alerts muted for tank ${label} (${hours} hours)` });
    }

    if (hours <= 0) {
      smsMuteUntil = null;
      await persistMuteState("sms_mute_global", null);
      return res.json({ muted: false, muteExpires: null, message: "SMS alerts unmuted" });
    }
    smsMuteUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    await persistMuteState("sms_mute_global", smsMuteUntil);
    await pool.query(
      "INSERT INTO activity_logs (user_name, action_type, description, module) VALUES ($1, 'SMS_MUTED', $2, 'settings')",
      [req.adminUser.username, `SMS muted globally for ${hours}h until ${smsMuteUntil}`]
    );
    res.json({ muted: true, muteExpires: smsMuteUntil, message: `SMS alerts muted for ${hours} hours` });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error setting SMS mute:`, err.message);
    res.status(500).json({ message: "Error setting SMS mute" });
  }
});

// GET /alert/mute-status - current mute state (any signed-in user). Returns
// the global mute plus every per-tank mute so the UI can render both layers.
app.get("/alert/mute-status", requireAuth, async (req, res) => {
  try {
    smsMuteUntil = pruneMuteUntil(smsMuteUntil);
    const globalMuted = Boolean(smsMuteUntil);

    const devices = [];
    try {
      const result = await pool.query("SELECT device_id, tank_name FROM devices WHERE is_active = true AND archived_at IS NULL ORDER BY device_id");
      for (const row of result.rows) {
        const expires = pruneMuteUntil(deviceSmsMuteUntil.get(row.device_id));
        if (!expires) deviceSmsMuteUntil.delete(row.device_id);
        devices.push({ device_id: row.device_id, tank_name: row.tank_name, muted: Boolean(expires), muteExpires: expires || null });
      }
    } catch {
      // devices table unavailable -> report the global layer only
    }

    res.json({
      muted: globalMuted,
      muteExpires: globalMuted ? smsMuteUntil : null,
      devices,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching SMS mute status:`, err.message);
    res.status(500).json({ message: "Error fetching SMS mute status" });
  }
});

// GET /alert/sms-health - SMS delivery health snapshot (any signed-in user)
app.get("/alert/sms-health", requireAuth, async (req, res) => {
  try {
    const counts = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE status IN ('queued', 'delivered')) AS processed,
             COUNT(*) FILTER (WHERE status = 'failed')               AS failed,
             COUNT(*) FILTER (WHERE status = 'capped')               AS capped,
             COUNT(*) FILTER (WHERE status = 'queued' AND sent_at < NOW() - INTERVAL '1 hour') AS stuck_queued
      FROM sms_logs
      WHERE sent_at >= NOW() - INTERVAL '24 hours'
    `);
    const latestFailed = await pool.query(`
      SELECT id, recipient_phone, message, error_message, failure_reason, sent_at
      FROM sms_logs WHERE status = 'failed' ORDER BY id DESC LIMIT 1
    `);
    const sentToday = await pool.query(`
      SELECT COUNT(*)::int AS n FROM sms_logs
      WHERE sent_at >= date_trunc('day', NOW()) AND status <> 'capped'
    `);
    res.json({
      configured: Boolean(HTTPSMS_API_KEY && HTTPSMS_FROM),
      from: HTTPSMS_FROM || null,
      smsToday: sentToday.rows[0].n,
      smsCap: SMS_DAILY_CAP,
      circuitBreaker: smsCircuitBreaker.snapshot(),
      last24h: {
        processed: Number(counts.rows[0].processed),
        failed: Number(counts.rows[0].failed),
        capped: Number(counts.rows[0].capped),
        stuckQueued: Number(counts.rows[0].stuck_queued),
      },
      degraded: Number(counts.rows[0].failed) > 0 || Number(counts.rows[0].stuck_queued) > 0,
      latestFailure: latestFailed.rows[0] || null,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching SMS health:`, err.message);
    res.status(500).json({ message: "Error fetching SMS health" });
  }
});

// GET /sms-logs (Admin) - paginated SMS history; ?page, ?pageSize, ?status
app.get("/sms-logs", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const status = String(req.query.status || "").trim();
    const where = status ? "WHERE status = $1" : "";
    const params = status ? [status] : [];
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM sms_logs ${where}`, params);
    const result = await pool.query(
      `SELECT id, recipient_phone, message, status, error_message, failure_reason, sms_id, sent_at, delivered_at
         FROM sms_logs
         ${where}
         ORDER BY id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({ rows: result.rows, total: total.rows[0].n, page, pageSize });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching SMS logs:`, err.message);
    res.status(500).json({ message: "Error fetching SMS logs" });
  }
});

// ========================
// SYSTEM LOGS ENDPOINTS
// ========================

// POST /logs - create a system log entry (action + parameter required).
// Admin only: arbitrary log rows appear directly on the Alerts/Sensor Logs
// pages, so a standard user must not be able to inject entries.
// Optional device_id attributes the entry to one tank (must exist; verified
// so a typo'd id doesn't break the FK).
app.post("/logs", requireAdmin, async (req, res) => {
  try {
    const { action, parameter, old_value, new_value, device_id } = req.body;
    if (!action || !parameter) return res.status(400).json({ message: "action and parameter required" });
    let loggedDeviceId = null;
    if (device_id !== undefined && device_id !== null && String(device_id) !== "") {
      const deviceCheck = await pool.query("SELECT 1 FROM devices WHERE device_id = $1", [String(device_id)]);
      if (deviceCheck.rows.length === 0) return res.status(400).json({ message: "Unknown device_id" });
      loggedDeviceId = String(device_id);
    }
    const result = await pool.query(
      "INSERT INTO system_logs (action, parameter, old_value, new_value, device_id) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [action, parameter, String(old_value ?? ""), String(new_value ?? ""), loggedDeviceId]
    );
    res.status(201).json({ message: "Logged", data: result.rows[0] });
  } catch (err) {
    fail(res, 500, "Error logging", err, req);
  }
});

// POST /logs/:id/ack - mark an alert log as Confirmed (done) or Allowed (approved).
// Stored directly on the alert row so each alert keeps its own acknowledgement.
app.post("/logs/:id/ack", requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (status !== "confirmed" && status !== "allowed") {
      return res.status(400).json({ message: "status must be 'confirmed' or 'allowed'" });
    }
    const actor = req.user?.username || req.user?.name || "admin";
    const result = await pool.query(
      `UPDATE system_logs
         SET ack_status = $1, acknowledged_at = NOW(), acknowledged_by = $2
       WHERE id = $3
       RETURNING *`,
      [status, actor, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Log entry not found" });
    res.json({ message: "Alert acknowledged", data: result.rows[0] });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error acknowledging alert:`, err.message);
    res.status(500).json({ message: "Error acknowledging alert" });
  }
});

// GET /system-logs - paginated logs with per-action counts, optional filters.
// ?device_id= scopes to one tank (action counts follow the filter so the
// filter chips stay consistent with the visible rows); omitted = all tanks.
app.get("/system-logs", requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const action = req.query.action || "";
    const parameter = req.query.parameter || "";
    const deviceId = req.query.device_id ? String(req.query.device_id) : "";

    // Build dynamic WHERE clause for action/parameter/device filters
    let where = [];
    let params = [];
    let paramCount = 1;
    if (action) { where.push(`action = $${paramCount}`); params.push(String(action)); paramCount++; }
    if (parameter) { where.push(`parameter = $${paramCount}`); params.push(String(parameter)); paramCount++; }
    if (deviceId) { where.push(`device_id = $${paramCount}`); params.push(deviceId); paramCount++; }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT * FROM system_logs ${whereClause} ORDER BY timestamp DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      [...params, limit, offset]
    );
    const countResult = await pool.query(`SELECT COUNT(*) FROM system_logs ${whereClause}`, params);
    const countsResult = await pool.query(`SELECT action, COUNT(*)::int AS count FROM system_logs ${whereClause} GROUP BY action`, params);
    const counts = {};
    countsResult.rows.forEach(row => { counts[row.action] = row.count; });
    res.json({ data: result.rows, total: parseInt(countResult.rows[0].count), page, limit, counts });
  } catch (err) {
    fail(res, 500, "Error fetching logs", err, req);
  }
});

// ========================
// ACTIVITY LOGS ENDPOINTS
// ========================

// POST /activity-logs - record a user activity event for the audit trail
app.post("/activity-logs", requireAuth, async (req, res) => {
  try {
    const { action_type, description, module } = req.body;
    if (!action_type) return res.status(400).json({ message: "action_type required" });

    // Derive acting user from session token; fall back to the "admin" account
    // when no valid token is present (must match a real username for the FK)
    const token = req.headers.authorization?.replace("Bearer ", "");
    let userName = "admin";
    if (token) {
      const tokenResult = await pool.query("SELECT username FROM users WHERE token = $1", [hashToken(token)]);
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
    fail(res, 500, "Error logging activity", err, req);
  }
});

// GET /activity-logs - paginated, searchable, filterable activity logs (admin only)
app.get("/activity-logs", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
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
    fail(res, 500, "Error fetching activity logs", err, req);
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
// Optional deviceId scopes the aggregation to one tank.
async function queryPeriodStats(startTs, deviceId = null) {
  const result = await pool.query(
    `SELECT
       (AVG(temperature) FILTER (WHERE temperature > 0))::float AS temp_avg,
       (MIN(temperature) FILTER (WHERE temperature > 0))::float AS temp_min,
       (MAX(temperature) FILTER (WHERE temperature > 0))::float AS temp_max,
       (AVG(water_level) FILTER (WHERE water_level >= 0))::float AS water_avg,
       (MIN(water_level) FILTER (WHERE water_level >= 0))::float AS water_min,
       (MAX(water_level) FILTER (WHERE water_level >= 0))::float AS water_max,
       (AVG(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_avg,
       (MIN(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_min,
       (MAX(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_max,
       COUNT(*) AS total_readings
     FROM sensors
     WHERE timestamp >= $1
       AND ($2::text IS NULL OR device_id = $2)`,
    [startTs, deviceId]
  );
  const r = result.rows[0] || {};
  return {
    temperature: { avg: numOrNull(r.temp_avg), min: numOrNull(r.temp_min), max: numOrNull(r.temp_max) },
    water_level: { avg: numOrNull(r.water_avg), min: numOrNull(r.water_min), max: numOrNull(r.water_max) },
    ammonia: { avg: numOrNull(r.ammonia_avg), min: numOrNull(r.ammonia_min), max: numOrNull(r.ammonia_max) },
    total_readings: parseInt(r.total_readings, 10) || 0,
  };
}

// Alert stats (total/resolved/by_parameter/by_action) within a window.
// Optional deviceId scopes to one tank (NULL rows = global events, included
// only in the unscoped view).
async function queryAlertStats(startTs, deviceId = null) {
  const [all, alerts] = await Promise.all([
    pool.query(
      "SELECT action, COUNT(*)::int AS count FROM system_logs WHERE timestamp >= $1 AND ($2::text IS NULL OR device_id = $2) GROUP BY action",
      [startTs, deviceId]
    ),
    pool.query(
      "SELECT parameter, COUNT(*)::int AS count FROM system_logs WHERE timestamp >= $1 AND action = 'Alert' AND ($2::text IS NULL OR device_id = $2) GROUP BY parameter",
      [startTs, deviceId]
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

// Counts device-disconnect episodes logged by the disconnect monitor within a
// window. In delta mode the sensors table no longer has one row per reading, so
// dropouts are measured from devices.last_seen / system_logs instead of gaps.
// Optional deviceId scopes the count to one tank.
async function queryGapEvents(startTs, deviceId = null) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS gaps FROM system_logs
     WHERE action = 'Device Disconnect' AND timestamp >= $1 AND ($2::text IS NULL OR device_id = $2)`,
    [startTs, deviceId]
  );
  return parseInt(result.rows[0]?.gaps, 10) || 0;
}

// Trend helper: compares two window averages and derives direction + % change.
function buildTrend(current, previous) {
  // A window with no valid readings has no average at all, so there is nothing
  // to compare against. Report "stable" instead of a percentage derived from a
  // fake zero - dividing by a null previous average would be NaN, and the old
  // `previous > 0 ? ... : 0` guard quietly turned a dead sensor into "no change".
  if (current === null || previous === null || !(previous > 0)) {
    return { current_avg: current, previous_avg: previous, change_pct: 0, direction: "stable" };
  }
  const changePct = ((current - previous) / previous) * 100;
  let direction = "stable";
  if (changePct >= 1) direction = "up";
  else if (changePct <= -1) direction = "down";
  return { current_avg: current, previous_avg: previous, change_pct: Math.round(changePct * 100) / 100, direction };
}

// GET /analytics/overview?days= - summary, trends, alerts, uptime for a window
app.get("/analytics/overview", requireAuth, async (req, res) => {
  try {
    const days = analyticsDays(req);
    const deviceId = req.query.device_id ? String(req.query.device_id) : null;
    const currentStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const prevStart = new Date(currentStart.getTime() - days * 24 * 60 * 60 * 1000);

    const [currentStats, prevStats, alerts, readings, gapEvents, latest, deviceHeartbeat] = await Promise.all([
      queryPeriodStats(currentStart, deviceId),
      queryPeriodStats(prevStart, deviceId),
      queryAlertStats(currentStart, deviceId),
      pool.query("SELECT COUNT(*)::int AS c FROM sensors WHERE timestamp >= $1 AND ($2::text IS NULL OR device_id = $2)", [currentStart, deviceId]),
      queryGapEvents(currentStart, deviceId),
      pool.query("SELECT timestamp FROM sensors WHERE ($1::text IS NULL OR device_id = $1) ORDER BY timestamp DESC LIMIT 1", [deviceId]),
      pool.query("SELECT MAX(last_seen) AS last_seen FROM devices WHERE ($1::text IS NULL OR device_id = $1)", [deviceId]),
    ]);

    const lastReading = latest.rows[0]?.timestamp ? new Date(latest.rows[0].timestamp) : null;
    const deviceSeen = deviceHeartbeat.rows[0]?.last_seen ? new Date(deviceHeartbeat.rows[0].last_seen) : null;
    const deviceOffline = !deviceSeen || (Date.now() - deviceSeen.getTime()) > OFFLINE_LIMIT_MS;

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
    res.status(500).json({ message: "Error fetching analytics overview" });
  }
});

// GET /analytics/daily?days= - per-day averages for charting (max 90).
// Optional ?device_id scopes the aggregation (and the alert counts) to one tank.
app.get("/analytics/daily", requireAuth, async (req, res) => {
  try {
    const days = analyticsDays(req);
    const deviceId = req.query.device_id ? String(req.query.device_id) : null;
    const startTs = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [sensorResult, alertResult] = await Promise.all([
      pool.query(
        `SELECT
           DATE(timestamp) AS date,
           (AVG(temperature) FILTER (WHERE temperature > 0))::float AS temp_avg,
           (AVG(water_level) FILTER (WHERE water_level >= 0))::float AS water_avg,
           (AVG(ammonia) FILTER (WHERE ammonia >= 0))::float AS ammonia_avg,
           COUNT(*)::int AS readings
         FROM sensors
         WHERE timestamp >= $1 AND ($2::text IS NULL OR device_id = $2)
         GROUP BY DATE(timestamp)
         ORDER BY date`,
        [startTs, deviceId]
      ),
      pool.query(
        `SELECT DATE(timestamp) AS date, COUNT(*)::int AS count
         FROM system_logs
         WHERE timestamp >= $1 AND action = 'Alert' AND ($2::text IS NULL OR device_id = $2)
         GROUP BY DATE(timestamp)`,
        [startTs, deviceId]
      ),
    ]);

    const alertMap = {};
    alertResult.rows.forEach((row) => {
      alertMap[dateToDayString(row.date)] = row.count;
    });

    const daily = sensorResult.rows.map((row) => ({
      date: dateToDayString(row.date),
      temp_avg: numOrNull(row.temp_avg),
      water_avg: numOrNull(row.water_avg),
      ammonia_avg: numOrNull(row.ammonia_avg),
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
    res.status(500).json({ message: "Error fetching analytics daily" });
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
  // The `!== null` is explicit on purpose. A window with no valid readings has
  // avg === null, and `null > 0` happens to be false, so the toFixed() calls
  // below are unreachable today - but only by that coincidence. Spelling it out
  // keeps a later edit to the outer condition from turning a dead sensor into a
  // TypeError on /analytics/insights.
  const temp = summary.temperature;
  if (temp.avg !== null && temp.avg > 0) {
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
  if (water.avg !== null && water.avg > 0 && water.avg < t.water_level_min) {
    push("critical", "water_level", "Water level too low",
      `Average ${water.avg.toFixed(0)}% is below the ${t.water_level_min}% minimum.`,
      "Refill to restore the safe operating range."
    );
  }

  // ---- Ammonia ----
  const ammonia = summary.ammonia;
  if (ammonia.avg !== null && ammonia.avg > 0) {
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

// GET /analytics/insights?days= - rule-engine suggestions for the period.
// Optional ?device_id scopes every query AND resolves that tank's effective
// thresholds (per-tank overrides, migration 012).
app.get("/analytics/insights", requireAuth, async (req, res) => {
  try {
    const days = analyticsDays(req);
    const deviceId = req.query.device_id ? String(req.query.device_id) : null;
    const currentStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [currentStats, prevStats, alerts, readings, gapEvents, latest, deviceHeartbeat, settings] = await Promise.all([
      queryPeriodStats(currentStart, deviceId),
      queryPeriodStats(new Date(currentStart.getTime() - days * 24 * 60 * 60 * 1000), deviceId),
      queryAlertStats(currentStart, deviceId),
      pool.query("SELECT COUNT(*)::int AS c FROM sensors WHERE timestamp >= $1 AND ($2::text IS NULL OR device_id = $2)", [currentStart, deviceId]),
      queryGapEvents(currentStart, deviceId),
      pool.query("SELECT timestamp FROM sensors WHERE ($1::text IS NULL OR device_id = $1) ORDER BY timestamp DESC LIMIT 1", [deviceId]),
      pool.query("SELECT MAX(last_seen) AS last_seen FROM devices WHERE ($1::text IS NULL OR device_id = $1)", [deviceId]),
      getThresholdsForDevice(deviceId),
    ]);

    const lastReading = latest.rows[0]?.timestamp ? new Date(latest.rows[0].timestamp) : null;
    const deviceSeen = deviceHeartbeat.rows[0]?.last_seen ? new Date(deviceHeartbeat.rows[0].last_seen) : null;
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
        device_offline: !deviceSeen || (Date.now() - deviceSeen.getTime()) > OFFLINE_LIMIT_MS,
        last_reading: lastReading ? lastReading.toISOString() : null,
        readings: parseInt(readings.rows[0]?.c, 10) || 0,
        gap_events: gapEvents,
      },
    };

    res.json({
      period: { start: currentStart.toISOString(), end: new Date().toISOString() },
      days,
      insights: generateInsights(overview, {
        temp_min: settings.temp_min,
        temp_max: settings.temp_max,
        water_level_min: settings.water_level_min,
        water_level_max: settings.water_level_max,
        ammonia_min: settings.ammonia_min,
        ammonia_max: settings.ammonia_max,
      }),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching analytics insights:`, err.message);
    res.status(500).json({ message: "Error fetching analytics insights" });
  }
});

// =============================================================================
// FALLBACK ROUTE + CENTRALIZED ERROR HANDLER
// =============================================================================
// JSON 404 for unknown paths (Express's default is an HTML error page), and a
// final error middleware that logs the failure and never leaks stack traces or
// internal messages to production clients (audit 2.4.1).

// =============================================================================
// STATIC DASHBOARD (production)
// =============================================================================
// Serving dist/ from this process is what makes the session cookie possible: it
// puts the dashboard and the API on one origin, so SameSite=Lax is enough to
// stop CSRF and no HTTPS requirement comes with it. Previously nothing served
// dist/ at all, so `npm run build` produced a folder only a human could open.
//
// Guarded on existence rather than assumed: in development the dashboard is
// served by Vite and dist/ may be absent or stale, and a missing index.html
// must not take the API down with it.
if (fs.existsSync(INDEX_HTML)) {
  app.use(express.static(DIST_DIR, { index: false }));

  // SPA fallback. /devices, /analytics and friends are real navigation paths
  // that exist only in the React Router, so a hard refresh or a shared link has
  // to be answered with index.html and let the client route it.
  //
  // app.use rather than app.get("*"): Express 5 runs path-to-regexp v8, which
  // rejects a bare "*" as a route pattern, and a pathless middleware sidesteps
  // the pattern syntax entirely.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // API calls and asset requests must still 404 as JSON rather than being
    // handed an HTML document. A path with a file extension is an asset.
    if (req.wasApiPrefixed) return next();
    if (path.extname(req.path)) return next();
    return res.sendFile(INDEX_HTML, (err) => {
      if (err) next(err);
    });
  });

  console.log(`[${new Date().toISOString()}] Serving built dashboard from ${DIST_DIR}`);
} else {
  console.log(
    `[${new Date().toISOString()}] No dist/index.html found - serving the API only. ` +
    `Run "npm run build" to serve the dashboard from this process, or use "npm run dev".`
  );
}

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// The 4-arity signature is what makes Express treat this as the error handler;
// `next` must stay in the signature even though it is unused.
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled route error (${req.method} ${req.originalUrl}):`, err.message);
  res.status(err.statusCode || 500).json({
    message: err.statusCode ? err.message : "Internal server error",
    ...(process.env.NODE_ENV !== "production" && { error: err.message }),
  });
});

// =============================================================================
// SERVER STARTUP
// =============================================================================
// Connects to PostgreSQL, ensures an admin account, restores alert state from
// the DB, and starts the HTTP listener.

// Runs initialization and starts the HTTP listener
async function startServer() {
  try {
    // Wait for the database with retry/backoff before doing anything else so a
    // slow-starting DB does not kill the server on the first attempt.
    await waitForDatabase();
    const client = await pool.connect();
    try {
      console.log(`[${new Date().toISOString()}] PostgreSQL connected`);

      // Bootstrap the owner admin if NO admin-role user exists yet. Identity
      // comes entirely from env (ADMIN_USERNAME / ADMIN_EMAIL / OTP_EMAIL /
      // SMTP_USER) — there is no hardcoded default account. ADMIN_INITIAL_PASSWORD
      // is REQUIRED so a known default credential is never shipped with a fresh
      // database; the plaintext is never logged.
      const adminCount = await client.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");
      if (adminCount.rows[0].n === 0) {
        const initialAdminPassword = process.env.ADMIN_INITIAL_PASSWORD;
        if (!initialAdminPassword) {
          const msg = `[${new Date().toISOString()}] No admin account exists and ADMIN_INITIAL_PASSWORD is not set. Set ADMIN_INITIAL_PASSWORD in .env to create the initial admin, then restart.`;
          console.error(msg);
          process.exit(1);
        }
        const adminPassword = hashPassword(initialAdminPassword);
        const adminUsername = (process.env.ADMIN_USERNAME || "owner").trim();
        const adminEmail = (process.env.ADMIN_EMAIL || process.env.SMTP_USER || "").trim();
        const adminName = process.env.ADMIN_NAME || "Owner";
        await client.query(
          `INSERT INTO users (name, username, email, password_hash, role) VALUES ($1, $2, $3, $4, 'admin')`,
          [adminName, adminUsername, adminEmail, adminPassword]
        );
        console.log(`[${new Date().toISOString()}] Owner admin account "${adminUsername}" created. Change its password after first login.`);
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

      // Restore SMS mute state (global + per-tank) from system_state so a
      // restart no longer silently unmutes (the old mute was memory-only).
      // Expired entries are pruned instead of loaded.
      try {
        smsMuteUntil = pruneMuteUntil(await client.query("SELECT value FROM system_state WHERE key = 'sms_mute_global'").then((r) => r.rows[0]?.value ?? null).catch(() => null));
        const muteRows = await client.query("SELECT key, value FROM system_state WHERE key LIKE 'sms_mute:%'");
        deviceSmsMuteUntil.clear();
        for (const row of muteRows.rows) {
          const deviceId = row.key.slice("sms_mute:".length);
          const value = pruneMuteUntil(row.value);
          if (value) {
            deviceSmsMuteUntil.set(deviceId, value);
          } else {
            await client.query("DELETE FROM system_state WHERE key = $1", [row.key]);
          }
        }
        const tankMutes = deviceSmsMuteUntil.size;
        console.log(`[${new Date().toISOString()}] SMS mute state restored (global: ${smsMuteUntil ? "muted" : "off"}, per-tank: ${tankMutes})`);
      } catch (muteErr) {
        console.warn(`[${new Date().toISOString()}] Could not restore SMS mute state:`, muteErr.message);
      }

      // Seed ammonia spike guard with the latest reading per device
      const lastAmmoniaResult = await client.query(
        "SELECT DISTINCT ON (device_id) device_id, ammonia FROM sensors WHERE ammonia > 0 ORDER BY device_id, timestamp DESC"
      );
      lastAmmoniaReading = {};
      for (const row of lastAmmoniaResult.rows) {
        lastAmmoniaReading[row.device_id] = Number(row.ammonia);
      }
      console.log(`[${new Date().toISOString()}] Loaded ammonia baseline for ${lastAmmoniaResult.rows.length} device(s) from DB`);

      // Seed change-only logging baseline with the latest stored reading per device.
      // NULL columns (sensor failures) stay null so the delta comparison treats
      // them as invalid readings rather than coercing them to 0.
      const lastSensorResult = await client.query(
        "SELECT DISTINCT ON (device_id) device_id, temperature, water_level, ammonia FROM sensors ORDER BY device_id, timestamp DESC"
      );
      lastSensorReading = {};
      for (const row of lastSensorResult.rows) {
        lastSensorReading[row.device_id] = {
          temperature: row.temperature == null ? null : Number(row.temperature),
          water_level: row.water_level == null ? null : Number(row.water_level),
          ammonia: row.ammonia == null ? null : Number(row.ammonia),
        };
      }
      console.log(`[${new Date().toISOString()}] Loaded delta-logging baseline for ${lastSensorResult.rows.length} device(s) from DB`);

      // Seed the in-memory latest readings (backing /devices/latest + SSE)
      // with the most recent row per device so a dashboard opened right after
      // a server restart still sees data before the next ESP32 POST.
      const latestSeed = await client.query(
        `SELECT DISTINCT ON (s.device_id) s.device_id, s.temperature, s.water_level, s.ammonia, d.last_seen
           FROM sensors s JOIN devices d ON d.device_id = s.device_id
          ORDER BY s.device_id, s.timestamp DESC`
      );
      for (const row of latestSeed.rows) {
        latestDeviceReadings.set(row.device_id, {
          temperature: row.temperature == null ? null : Number(row.temperature),
          water_level: row.water_level == null ? null : Number(row.water_level),
          ammonia: row.ammonia == null ? null : Number(row.ammonia),
          recv_at: (row.last_seen ?? row.timestamp)?.toISOString?.() ?? null,
        });
      }
      console.log(`[${new Date().toISOString()}] Seeded latest readings for ${latestSeed.rows.length} device(s)`);

      // SMS alerts: report config state and start the scheduled producers.
      if (HTTPSMS_API_KEY && HTTPSMS_FROM) {
        console.log(`[${new Date().toISOString()}] httpsms SMS configured (gateway ${HTTPSMS_FROM})`);
        setInterval(() => pollUndeliveredSms().catch(() => {}), SMS_DELIVERY_POLL_MS);
        console.log(`[${new Date().toISOString()}] SMS delivery poller scheduled (every ${Math.round(SMS_DELIVERY_POLL_MS / 1000)}s)`);
        runSmsMaintenance();
      } else {
        console.warn(`[${new Date().toISOString()}] WARNING: HTTPSMS_API_KEY / HTTPSMS_FROM are not set — SMS alerts will not be sent. Add them to .env and restart.`);
      }
      if (HOURLY_SMS_ENABLED) {
        setInterval(() => sendHourlyStatusUpdate().catch(() => {}), HOURLY_SMS_INTERVAL_MS);
        console.log(`[${new Date().toISOString()}] Hourly SMS status update scheduled (every ${Math.round(HOURLY_SMS_INTERVAL_MS / 60000)} min)`);
      }
      if (DEVICE_DISCONNECT_ENABLED) {
        // Pre-seed already-stale devices so the first poll does NOT fire a
        // disconnect SMS for downtime that happened before this server booted.
        const bootStaleSeconds = Math.max(5, Math.floor(DISCONNECT_STALE_MS / 1000));
        const bootStale = await client.query(
          "SELECT device_id FROM devices WHERE last_seen < NOW() - ($1 || ' seconds')::interval",
          [bootStaleSeconds]
        );
        for (const row of bootStale.rows) disconnectedDevices.add(row.device_id);
        if (bootStale.rows.length > 0) {
          console.log(`[${new Date().toISOString()}] Pre-seeded ${bootStale.rows.length} disconnected device(s) at boot — no SMS will fire for them`);
        }
        setInterval(checkDeviceDisconnects, DISCONNECT_STALE_MS);
        console.log(`[${new Date().toISOString()}] Device-disconnect SMS monitor scheduled (stale after ${bootStaleSeconds}s, rearm after ${Math.round(DISCONNECT_REARM_MS / 1000)}s)`);
      }
    } finally {
      client.release();
    }

    // Listen for HTTP requests on all network interfaces
    const server = app.listen(PORT, "::", () => {
      console.log(`[${new Date().toISOString()}] Server running on port ${PORT} (dual-stack)`);
      // Sensor ingestion now always requires X-Device-Secret, so an unset
      // DEVICE_SECRET is not a dev convenience any more - it silently narrows
      // the fleet to boards that have their own per-device secret. Say so once,
      // loudly, at boot rather than letting boards 401 with no explanation.
      if (!DEVICE_SECRET) {
        console.warn(`[${new Date().toISOString()}] DEVICE_SECRET is not set: the shared-secret path is disabled and only devices with a per-device secret can post to /sensor.`);
      }
    });

    // Star topology: poll the registered ESP32 /status endpoints for health.
    startDevicePoller(pool);

    // Graceful shutdown (audit 2.8.3): drain connections, close SSE clients,
    // end the DB pool, then exit. Covers Ctrl+C (SIGINT), containers/PM2
    // (SIGTERM) and nodemon restarts (SIGUSR2).
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[${new Date().toISOString()}] ${signal} received — shutting down gracefully...`);
      for (const client of [...sseClients.keys()]) {
        try { client.end(); } catch { /* already closed */ }
        // dropSseClient rather than sseClients.clear() so the keep-alive timers
        // die with the sockets; a clear() would orphan every one of them until
        // process.exit(), which hides the pattern from anyone reading this.
        dropSseClient(client);
      }
      server.close(async () => {
        try {
          await pool.end();
          console.log(`[${new Date().toISOString()}] Shutdown complete`);
        } catch (err) {
          console.error(`[${new Date().toISOString()}] Error closing pool:`, err.message);
        }
        process.exit(0);
      });
      // Safety net: force-exit if connections refuse to drain
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGUSR2", () => shutdown("SIGUSR2"));
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
