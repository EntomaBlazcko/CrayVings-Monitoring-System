#!/usr/bin/env node
// =============================================================================
// tools/watch-connection.cjs - live ESP32 connectivity watcher
//
// Answers one question without touching the board: "is each ESP32 actually
// talking to the server right now?"
//
// This exists because the serial monitor is not a reliable witness. The
// firmware prints a full sensor dump every second, and at the 230400 baud the
// NODE sketch uses, that stream can outrun the USB-serial bridge and drop
// bytes - the output arrives garbled (missing letters, mangled payloads) even
// while the board is perfectly healthy. Judging a connection by that output
// leads to chasing a firmware bug that does not exist.
//
// Three independent signals are shown per device instead:
//
//   1. last_seen   - devices.last_seen is rewritten on EVERY POST, even when
//                    change-only delta logging suppresses the sensors row. It is
//                    the authoritative "is it connected" clock.
//   2. ip_address  - re-derived from the live peer on every POST, so a board
//                    that joined a different WiFi is dialled at its current
//                    address rather than a stale one.
//   3. GET /status - a live probe of the board itself. It travels the opposite
//                    direction from the POST path, which is what lets us tell
//                    "the board is not posting" apart from "the server cannot
//                    reach the board".
//
// IMPORTANT: an empty log or a static dashboard does NOT mean disconnected.
// With DELTA_LOGGING_ENABLED on and unchanged readings, the server writes no
// new row and logs nothing while the device keeps posting every second. Only
// the last_seen clock moves, which is why this tool reads the database.
//
// Usage:
//   node tools/watch-connection.cjs
//   node tools/watch-connection.cjs --once
//   WATCH_INTERVAL_MS=5000 node tools/watch-connection.cjs
// =============================================================================

require("dotenv").config({ quiet: true });
const { Pool } = require("pg");

const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS) || 2000;
const STALE_AFTER_MS = Number(process.env.WATCH_STALE_MS) || 15000;
const PROBE_TIMEOUT_MS = Number(process.env.WATCH_PROBE_TIMEOUT_MS) || 2000;
const ONCE = process.argv.includes("--once");

// ---------------------------------------------------------------- formatting
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const cyan = paint(36);
const bold = paint(1);
const dim = paint(2);

function humanAge(ms) {
  if (ms === null || ms === undefined) return "never";
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s ago`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m ${totalSec % 60}s ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
}

// IPv6 literals must be bracketed before they can be dropped into a URL.
function urlHost(ip) {
  return ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip;
}

// -------------------------------------------------------------- device probe
// Asks the board itself how it is doing. Resolves to a short human string so
// the caller never has to care whether it timed out, refused, or 404'd.
async function probeDevice(ip) {
  if (!ip) return { state: "skip", detail: "no IP recorded yet" };
  const url = `http://${urlHost(ip)}/status`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { state: "bad", detail: `HTTP ${res.status}` };
    const body = await res.json();
    const uptime = Number(body.uptime_ms);
    const uptimeText = Number.isFinite(uptime)
      ? humanAge(-uptime).replace(" ago", "")
      : "unknown";
    const rssi = Number.isFinite(Number(body.wifi_rssi))
      ? ` rssi=${body.wifi_rssi}dBm`
      : "";
    return {
      state: "ok",
      detail: `up ${uptimeText}${rssi} heap=${body.free_heap}`,
      reportedId: body.device_id,
    };
  } catch (err) {
    const msg = err.name === "TimeoutError" ? "timed out" : err.message;
    return { state: "bad", detail: msg };
  }
}

// ------------------------------------------------------------------- verdict
function verdictFor(lastSeen) {
  if (!lastSeen) {
    return { label: "NEVER SEEN", paint: yellow, code: "?" };
  }
  const age = Date.now() - new Date(lastSeen).getTime();
  if (age <= STALE_AFTER_MS) {
    return { label: "CONNECTED", paint: green, code: "+" };
  }
  return { label: "OFFLINE", paint: red, code: "-" };
}

// --------------------------------------------------------------------- render
async function render(pool) {
  const { rows } = await pool.query(
    `SELECT device_id, ip_address, last_seen, last_health_seen, is_active
       FROM devices
      ORDER BY device_id`
  );

  const probes = await Promise.all(rows.map((r) => probeDevice(r.ip_address)));

  const now = new Date();
  const lines = [];
  lines.push(
    bold("ESP32 connection watch") +
      dim(`  server=localhost:${process.env.PORT || 3000}  stale>${Math.round(STALE_AFTER_MS / 1000)}s`)
  );
  lines.push(dim(`  ${now.toISOString()}  every ${Math.round(INTERVAL_MS / 1000)}s`));
  lines.push("");

  if (rows.length === 0) {
    lines.push(yellow("  no devices registered yet"));
  }

  rows.forEach((row, i) => {
    const v = verdictFor(row.last_seen);
    const probe = probes[i];
    const seen = row.last_seen ? humanAge(Date.now() - new Date(row.last_seen).getTime()) : "never";
    const health = row.last_health_seen
      ? humanAge(Date.now() - new Date(row.last_health_seen).getTime())
      : "never";

    lines.push(
      `  ${v.paint(v.code)} ${bold(row.device_id)}${row.is_active ? "" : dim(" (inactive)")}` +
        `  ${v.paint(v.label)}`
    );
    lines.push(`      posting    ${seen}   ${dim("last_seen")}`);
    lines.push(`      poller     ${health}   ${dim("last_health_seen")}`);
    lines.push(`      ip         ${row.ip_address ? cyan(row.ip_address) : dim("none recorded")}`);

    if (probe.state === "ok") {
      let detail = green("reachable") + dim(`  ${probe.detail}`);
      if (probe.reportedId && probe.reportedId !== row.device_id) {
        detail = yellow(
          `reachable but reports device_id "${probe.reportedId}" - registry mismatch!`
        );
      }
      lines.push(`      /status    ${detail}`);
    } else if (probe.state === "skip") {
      lines.push(`      /status    ${dim(probe.detail)}`);
    } else {
      lines.push(`      /status    ${red("unreachable")} ${dim(probe.detail)}`);
    }
    lines.push("");
  });

  const online = rows.filter((r) => verdictFor(r.last_seen).label === "CONNECTED").length;
  lines.push(
    dim("  summary: ") +
      `${green(`${online} connected`)} / ${rows.length} registered`
  );
  lines.push(
    dim("  note: a quiet log and an unchanging dashboard are normal (delta logging).")
  );
  lines.push(
    dim("        But a local test POST (curl/Postman) also advances last_seen, so")
  );
  lines.push(
    dim("        do not POST as ESP32_01/ESP32_02 from this machine during a hardware test.")
  );

  if (useColor) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
  process.stdout.write(lines.join("\n") + "\n");
}

// ----------------------------------------------------------------------- main
async function main() {
  const pool = new Pool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
  });

  const shutdown = async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let failed = false;
  const tick = async () => {
    try {
      await render(pool);
      failed = false;
    } catch (err) {
      // Keep looping: a transient database blip should not kill a watch that
      // may be running unattended for the length of a debugging session.
      if (!failed) {
        process.stdout.write(`\n${red("database query failed:")} ${err.message}\n\n`);
      }
      failed = true;
    }
    if (!ONCE) setTimeout(tick, INTERVAL_MS);
  };

  await tick();
  if (!ONCE) {
    process.stdout.write(dim("  Ctrl+C to stop\n"));
  }
  await pool.end().catch(() => {});
}

main().catch((err) => {
  console.error("watch-connection failed:", err.message);
  process.exit(1);
});
