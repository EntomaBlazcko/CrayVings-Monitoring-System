#!/usr/bin/env node
/**
 * mock-device.js - simulate one or more ESP32 aquaculture sensor nodes.
 *
 * Posts readings to the same endpoint the real firmware uses (POST /sensor),
 * so the entire dashboard, alerting, SMS and PDF pipeline can be exercised
 * without physical hardware.
 *
 * USAGE
 *   node scripts/mock-device.js       # ESP32_03 Mock Device, healthy, 5s
 *   node scripts/mock-device.js --profile ammonia_spike
 *   node scripts/mock-device.js --device ESP32_02 --profile warming
 *   node scripts/mock-device.js --profile fleet          # two tanks in parallel
 *   node scripts/mock-device.js --cycles 20              # stop after 20 posts
 *   node scripts/mock-device.js --list-profiles
 *   node scripts/mock-device.js --list-devices           # query the live API
 *
 * Run `node scripts/mock-device.js --help` for the full flag list, or read
 * docs/MOCK_DEVICE.md.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PROFILES } from "./mock-device.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Load .env from the repo root (and .env.local if present) so DEVICE_SECRET and
// VITE_API_BASE resolve the same way the server resolves them.
dotenv.config({ path: path.join(ROOT, ".env.local") });
dotenv.config({ path: path.join(ROOT, ".env") });

const API_BASE = process.env.VITE_API_BASE || "http://localhost:3000";
const DEVICE_SECRET = process.env.DEVICE_SECRET || "";
const SENSOR_URL = `${API_BASE}/sensor`;
const DEFAULT_DEVICE = "ESP32_03 Mock Device";

const PARAM_KEYS = ["temperature", "water_level", "ammonia"];

// Wire sentinels understood by server.cjs readingOrNull().
const SENTINELS = { temperature: 0, water_level: -1, ammonia: -1 };

// ---------------------------------------------------------------------------
// Terminal colours (disabled when not a TTY or NO_COLOR is set)
// ---------------------------------------------------------------------------
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: useColour ? "\x1b[0m" : "",
  dim: useColour ? "\x1b[2m" : "",
  bold: useColour ? "\x1b[1m" : "",
  red: useColour ? "\x1b[31m" : "",
  green: useColour ? "\x1b[32m" : "",
  yellow: useColour ? "\x1b[33m" : "",
  blue: useColour ? "\x1b[34m" : "",
  cyan: useColour ? "\x1b[36m" : "",
  grey: useColour ? "\x1b[90m" : "",
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    devices: [],
    profileName: "healthy",
    interval: null,
    cycles: null,
    rampTo: null,
    logFile: null,
    api: API_BASE,
    secret: DEVICE_SECRET,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "-d": case "--device": out.devices.push(next()); break;
      case "-p": case "--profile": out.profileName = next(); break;
      case "-i": case "--interval": out.interval = Number(next()); break;
      case "-n": case "--cycles": out.cycles = Number(next()); break;
      case "--ramp-to": out.rampTo = Number(next()); break;
      case "--log": out.logFile = next(); break;
      case "--api": out.api = next(); break;
      case "--secret": out.secret = next(); break;
      case "-l": case "--list-profiles": out.listProfiles = true; break;
      case "--list-devices": out.listDevices = true; break;
      case "--show-config": out.showConfig = true; break;
      case "-h": case "--help": out.help = true; break;
      default:
        if (a.startsWith("-")) {
          console.error(`${c.red}Unknown option:${c.reset} ${a}`);
          process.exit(2);
        }
    }
  }
  return out;
}

function printHelp() {
  console.log(`
${c.bold}CRAYvings mock ESP32 device${c.reset}

  node scripts/mock-device.js [options]

${c.bold}Options${c.reset}
  -d, --device <id>     Device to simulate (repeatable). Default: ${DEFAULT_DEVICE}
  -p, --profile <name>  Scenario profile. Default: healthy
  -i, --interval <ms>   Override the profile's post interval
  -n, --cycles <n>      Stop after n posts per device (default: run forever)
      --ramp-to <value> Override the profile's ramp target (e.g. --ramp-to 40)
      --log <file>      Append every post to a JSONL file
      --api <url>       Override the API base (default: ${API_BASE})
      --secret <s>      Override X-Device-Secret
  -l, --list-profiles   Show available profiles and exit
      --list-devices    Show devices registered on the API and exit
      --show-config     Print the resolved config for the chosen profile
  -h, --help            This message

${c.bold}Profiles${c.reset}
${Object.entries(PROFILES)
  .map(([k, v]) => `  ${c.cyan}${k.padEnd(18)}${c.reset}${v.description || ""}`)
  .join("\n")}

${c.bold}Examples${c.reset}
  ${c.grey}# Prove the critical alarm persists past the 5s toast${c.reset}
  node scripts/mock-device.js --profile ammonia_spike

  ${c.grey}# Show a dead probe renders as "No signal", not a false warning${c.reset}
  node scripts/mock-device.js --profile failed_ammonia

  ${c.grey}# Two tanks, one healthy one warming${c.reset}
  node scripts/mock-device.js --profile fleet

${c.bold}Auth${c.reset}
  Uses DEVICE_SECRET from .env${DEVICE_SECRET ? ` (loaded, ${DEVICE_SECRET.length} chars)` : c.yellow + " (NOT SET - posts will 401 if the server requires it)" + c.reset}
`);
}

// ---------------------------------------------------------------------------
// Value engine
// ---------------------------------------------------------------------------

/**
 * Builds a stateful value generator for one device running one profile.
 * Each step() mutates and returns the current readings, applying (in order):
 * ramp -> drift -> noise -> bounds -> scripted sensor failure.
 */
function createEngine(profile, options = {}) {
  const base = { ...profile.base };
  const noise = profile.noise || {};
  const drift = profile.drift || {};
  const bounds = profile.bounds || {};
  const ramp = profile.ramp;
  const fail = profile.fail;

  const current = { ...base };
  let cycle = 0;

  return {
    get cycle() {
      return cycle;
    },
    step() {
      cycle += 1;

      for (const key of PARAM_KEYS) {
        if (base[key] === undefined) continue;

        // 1. Scripted ramp (e.g. ammonia climbing to a critical value).
        if (ramp && ramp.parameter === key) {
          const to = options.rampTo ?? ramp.to;
          const t = Math.min(1, cycle / Math.max(1, ramp.overCycles));
          const eased = t * t * (3 - 2 * t); // smoothstep, so it eases in/out
          current[key] = ramp.from + (to - ramp.from) * eased;
        } else if (drift[key]) {
          // 2. Slow systematic movement.
          current[key] += drift[key];
        }

        // 3. Per-cycle random walk, re-centred so it cannot wander away.
        const amp = noise[key] || 0;
        if (amp > 0) {
          current[key] += (Math.random() - 0.5) * 2 * amp;
        }

        // 4. Keep values physically plausible.
        const lim = bounds[key];
        if (lim) {
          current[key] = Math.min(Math.max(current[key], lim[0]), lim[1]);
        }
      }

      // 5. Scripted sensor failure -> wire sentinel (stored as NULL server-side).
      const failed =
        fail &&
        cycle >= (fail.fromCycle ?? 0) &&
        (fail.parameter === "all" || fail.parameter === key_of(fail.parameter));

      const payload = {
        device_id: options.deviceId,
        temperature: round(current.temperature, 1),
        water_level: round(current.water_level, 0),
        ammonia: round(current.ammonia, 2),
      };

      if (failed) {
        const sentinel = fail.sentinel ?? SENTINELS[fail.parameter] ?? -1;
        if (fail.parameter === "all") {
          payload.temperature = SENTINELS.temperature;
          payload.water_level = SENTINELS.water_level;
          payload.ammonia = SENTINELS.ammonia;
        } else {
          payload[fail.parameter] = sentinel;
        }
      }

      return payload;
    },
  };

  function key_of(p) {
    return p;
  }
}

function round(value, dp) {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------
function buildHeaders(secret) {
  const headers = { "Content-Type": "application/json" };
  // Only send the header when a secret exists: in dev the server may run
  // unauthenticated, and sending an empty secret would fail the equality check.
  if (secret) headers["X-Device-Secret"] = secret;
  return headers;
}

async function postReading(payload, secret, api) {
  const started = Date.now();
  try {
    const res = await fetch(`${api}/sensor`, {
      method: "POST",
      headers: buildHeaders(secret),
      body: JSON.stringify(payload),
    });
    const ms = Date.now() - started;
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 120);
    }
    return { ok: res.ok, status: res.status, body, ms };
  } catch (err) {
    return { ok: false, status: 0, body: err.message, ms: Date.now() - started };
  }
}

function formatPayload(p) {
  return `T=${String(p.temperature).padStart(5)}C  H2O=${String(p.water_level).padStart(3)}%  NH3=${String(p.ammonia).padStart(5)}ppm`;
}

function statusColour(res) {
  if (res.status === 0) return c.red;
  if (res.status >= 200 && res.status < 300) return c.green;
  if (res.status === 401 || res.status === 403) return c.yellow;
  return c.red;
}

// ---------------------------------------------------------------------------
// Device runner
// ---------------------------------------------------------------------------
function runDevice({ deviceId, profile, profileName, interval, cycles, secret, api, logStream, label }) {
  const engine = createEngine(profile, { deviceId, rampTo: rampOverride });
  const tag = label ? `${c.bold}${label}${c.reset} ${c.grey}[${deviceId}]${c.reset}` : `${c.bold}${deviceId}${c.reset}`;
  let cycle = 0;
  let stopped = false;

  return new Promise((resolve) => {
    const tick = async () => {
      if (stopped) return;
      cycle += 1;

      const payload = engine.step();
      const res = await postReading(payload, secret, api);

      const col = statusColour(res);
      const okMark = res.ok ? `${c.green}POST 201${c.reset}` : `${col}POST ${res.status}${c.reset}`;
      const detail = res.ok ? "" : ` ${c.red}${JSON.stringify(res.body)}${c.reset}`;
      // Round-trip time is printed because the gap between posts is
      // interval + this value: when the cadence stretches to 10s/15s, a ~5s
      // latency here points at the server and a ~0ms one points at this
      // process. Without it the two are indistinguishable.
      const rt = res.ms >= 1000 ? `${c.yellow}${(res.ms / 1000).toFixed(1)}s${c.reset}` : `${c.grey}${res.ms}ms${c.reset}`;
      console.log(
        `${c.grey}${new Date().toISOString().slice(11, 19)}${c.reset} ${tag} ` +
        `cyc ${String(cycle).padStart(3)}  ${formatPayload(payload)}  ${okMark} ${rt}${detail}`
      );

      if (logStream) {
        logStream.write(
          JSON.stringify({ ts: new Date().toISOString(), device_id: deviceId, profile: profileName, cycle, payload, response: { status: res.status, ms: res.ms, body: res.body } }) + "\n"
        );
      }

      if (profile.stopAfterCycle && cycle >= profile.stopAfterCycle) {
        console.log(`${tag} ${c.yellow}simulated disconnect - going silent after ${cycle} posts${c.reset}`);
        stopped = true;
        return resolve();
      }

      if (cycles && cycle >= cycles) {
        stopped = true;
        return resolve();
      }

      setTimeout(tick, interval);
    };

    tick();
  });
}

// ---------------------------------------------------------------------------
// Info commands
// ---------------------------------------------------------------------------
async function listDevices(api, secret) {
  try {
    const res = await fetch(`${api}/devices`, { headers: buildHeaders(secret) });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`${c.red}GET /devices -> ${res.status}${c.reset} (the list endpoint needs a user JWT, not a device secret)`);
      return;
    }
    const rows = Array.isArray(body) ? body : body?.devices || [];
    if (rows.length === 0) {
      console.log("  no devices registered");
      return;
    }
    console.log(`\n  ${c.bold}Registered devices${c.reset} (${rows.length})`);
    for (const d of rows) {
      console.log(
        `    ${String(d.device_id).padEnd(14)} active=${d.is_active}  online=${d.online}  ` +
        `tank=${d.tank_name || "-"}  secret=${d.device_secret ? "per-device" : "shared"}`
      );
    }
    console.log("");
  } catch (err) {
    console.error(`${c.red}Could not reach ${api}: ${err.message}${c.reset}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let rampOverride = null;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  rampOverride = args.rampTo;

  if (args.help) return printHelp();

  if (args.listProfiles) {
    console.log(`\n  ${c.bold}Available profiles${c.reset}\n`);
    for (const [name, p] of Object.entries(PROFILES)) {
      console.log(`  ${c.cyan}${name}${c.reset}`);
      console.log(`    ${c.grey}${p.description || "(no description)"}${c.reset}`);
      if (p.devices) {
        console.log(`    devices: ${p.devices.map((d) => `${d.device_id}=${d.profile}`).join(", ")}`);
      } else {
        console.log(`    base: ${PARAM_KEYS.map((k) => `${k}=${p.base?.[k]}`).join("  ")}`);
      }
      if (p.ramp) console.log(`    ramp: ${p.ramp.parameter} -> ${p.ramp.to} over ${p.ramp.overCycles} cycles`);
      if (p.fail) console.log(`    fail: ${p.fail.parameter} from cycle ${p.fail.fromCycle}`);
      if (p.stopAfterCycle) console.log(`    stops after cycle ${p.stopAfterCycle}`);
      console.log(`    interval: ${p.interval}ms\n`);
    }
    return;
  }

  if (args.listDevices) return listDevices(args.api, args.secret);

  const profileName = args.profileName;
  const profile = PROFILES[profileName];
  if (!profile) {
    console.error(`${c.red}Unknown profile "${profileName}".${c.reset} Try --list-profiles.`);
    process.exit(2);
  }

  if (args.showConfig) {
    console.log(JSON.stringify({ api: args.api, profile: profileName, config: profile }, null, 2));
    return;
  }

  // Open the optional JSONL log.
  let logStream = null;
  if (args.logFile) {
    const resolved = path.isAbsolute(args.logFile) ? args.logFile : path.join(ROOT, args.logFile);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    logStream = fs.createWriteStream(resolved, { flags: "a" });
    console.log(`${c.grey}logging posts to ${resolved}${c.reset}`);
  }

  if (!args.secret) {
    console.log(
      `${c.yellow}warning${c.reset} DEVICE_SECRET is not set in .env - posting without X-Device-Secret.\n` +
      `         If the server was started with DEVICE_SECRET it will reply 401.\n`
    );
  }

  const interval = args.interval || profile.interval || 5000;
  const cycles = args.cycles || null;

  console.log(
    `\n${c.bold}CRAYvings mock device${c.reset}  ${c.grey}-> ${c.reset}${c.cyan}${args.api}/sensor${c.reset}\n` +
    `  profile   ${c.cyan}${profileName}${c.reset}${profile.description ? c.grey + "  (" + profile.description + ")" + c.reset : ""}\n` +
    `  interval  ${interval}ms      cycles: ${cycles ?? c.grey + "until Ctrl+C" + c.reset}\n` +
    (args.rampTo != null ? `  ramp-to   ${c.yellow}${args.rampTo}${c.reset} (overrides profile)\n` : "") +
    (logStream ? `  log       ${c.grey}${path.basename(args.logFile)}${c.reset}\n` : "") +
    `  ${c.grey}Ctrl+C to stop${c.reset}\n`
  );

  // Build the list of device jobs to run.
  let jobs;
  if (profile.devices) {
    jobs = profile.devices.map((d) => ({ deviceId: d.device_id, profileName: d.profile, staggerMs: d.staggerMs || 0 }));
  } else {
    const ids = args.devices.length ? args.devices : [DEFAULT_DEVICE];
    jobs = ids.map((id) => ({ deviceId: id, profileName, staggerMs: 0 }));
  }

  // Staggered start so the fleet does not post in lockstep.
  await Promise.all(
    jobs.map(async (job) => {
      const jobProfile = PROFILES[job.profileName] || profile;
      if (job.staggerMs) {
        await new Promise((r) => setTimeout(r, job.staggerMs));
      }
      return runDevice({
        deviceId: job.deviceId,
        profile: jobProfile,
        profileName: job.profileName,
        // An explicit --interval must win over the profile's own cadence,
        // otherwise the flag is silently ignored.
        interval: args.interval || jobProfile.interval || interval,
        cycles,
        secret: args.secret,
        api: args.api,
        logStream,
      });
    })
  );

  if (logStream) {
    await new Promise((r) => logStream.end(r));
  }
  console.log(`\n${c.grey}mock device stopped${c.reset}`);
}

// ---------------------------------------------------------------------------
// Graceful shutdown so in-flight posts are not abandoned mid-write.
// ---------------------------------------------------------------------------
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log(`\n${c.yellow}received ${sig} - stopping${c.reset}`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`${c.red}mock-device failed:${c.reset} ${err.stack || err.message}`);
  process.exit(1);
});
