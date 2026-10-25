# CRAYvings Monitoring System — Stress Test Procedure

**Document type:** Executable QA / performance test procedure
**System under test (SUT):** CRAYvings aquaculture monitoring system
(ESP32 → Wi-Fi → Node.js/Express `server.cjs` → PostgreSQL → React + TypeScript + Tailwind dashboard)
**Audience:** Student tester with **no prior performance-testing experience** — follow sections 1 → 11 in order.
**Test level:** System-side (Part A), Web-side (Part B), and Combined.
**Revision:** 1.0

> **Read this box before doing anything.**
> 1. This procedure is **only** for a throwaway test database and a local/dev server. **Never run it against a production or valued database.**
> 2. **SMS must be disabled** for every test. See §2.6 and §11. Unplug the HTTPSMS gateway phone as a physical backstop so no real text can leave the SIM.
> 3. Tests are ordered **light → heavy and must be run in order.** The baseline (SYS-01 / WEB-01) must pass before you escalate anything.
> 4. Every command is copy-paste. Replace `{PLACEHOLDERS}` (listed in §2.2) with your own values first.
> 5. If a single-machine setup is all you have, the load generator and the SUT compete for CPU/RAM. Record the specs and interpret results with that caveat (§9).

---

## Table of Contents

1. [Objectives and Pass/Fail Criteria](#1-objectives-and-passfail-criteria)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Data Preparation](#3-test-data-preparation)
4. [Part A: System Stress Tests](#4-part-a-system-stress-tests)
5. [Part B: Web Stress Tests](#5-part-b-web-stress-tests)
6. [Combined Test (Part A and Part B running simultaneously)](#6-combined-test-part-a-and-part-b-running-simultaneously)
7. [Monitoring and Metrics to Record](#7-monitoring-and-metrics-to-record)
8. [Results Recording Template](#8-results-recording-template)
9. [Analysis and Interpretation Guide](#9-analysis-and-interpretation-guide)
10. [Cleanup and Rollback](#10-cleanup-and-rollback)
11. [Risks and Safety Notes](#11-risks-and-safety-notes)

---

## 1. Objectives and Pass/Fail Criteria

### 1.1 Objectives

| # | Objective | Why it matters |
|---|-----------|----------------|
| O1 | Prove the ingest path (`POST /sensor`) stays correct and fast as the number of simulated ESP32s and their post rate grow. | A dropped or delayed reading is a lost record of a real tank's water quality. |
| O2 | Prove authenticated read endpoints (`GET /sensor`, `/sensor/latest`, `/devices/latest`, `/analytics/*`, `/report/range`) stay responsive under concurrent dashboard users. | The dashboard becomes useless if history/graph queries stall. |
| O3 | Characterise PostgreSQL under heavy inserts and large-range history queries. | Finds the write rate and table size at which the DB degrades. |
| O4 | Prove recovery after Wi-Fi drop, device reconnect, and full server downtime — **with zero data loss** for acknowledged (`2xx`) posts. | Real deployments lose power and Wi-Fi. |
| O5 | Prove SMS/alert flooding is *contained* (cooldown, daily cap, circuit breaker) and that no real SMS is sent in test. | Runaway SMS costs money and spams the operator. |
| O6 | Prove a single ESP32 can run for hours without a heap leak or watchdog reset. | A board that resets silently stops reporting. |
| O7 | Characterise the dashboard's real-time view, large history rendering, login throttling, and error states when the backend is slow/down. | Users hit all of these in normal operation. |
| O8 | Produce a recorded result set that a third party can re-run and compare. | Reproducibility is the point of a stress test. |

### 1.2 Global pass/fail thresholds

These are the **targets**. Record the *measured* value for every test in §8 and compare it here.

| ID | Metric | Symbol / definition | Pass threshold | Fail threshold |
|----|--------|---------------------|----------------|----------------|
| G1 | Ingest success rate | `2xx / total` on `POST /sensor` (excluding intentional 401/429 flood tests) | ≥ 99.0 % | < 99.0 % |
| G2 | Ingest latency p95 | 95th percentile request duration, ingest | ≤ 500 ms | > 500 ms |
| G3 | Read latency p95 | 95th percentile request duration, authenticated reads | ≤ 1500 ms | > 1500 ms |
| G4 | Error rate (reads) | `(4xx_server + 5xx) / total` on read endpoints | ≤ 1.0 % | > 1.0 % |
| G5 | Data loss | Acknowledged (`201 Saved`) ingest posts missing from `sensors` | 0 rows | ≥ 1 row |
| G6 | API CPU | `server.cjs` process CPU during steady state | ≤ 80 % of one core sustained | > 80 % sustained |
| G7 | API RAM | `server.cjs` RSS growth over a 30-min steady state | < 50 MB growth | ≥ 50 MB growth |
| G8 | PostgreSQL connections | `pg_stat_activity` active count | ≤ pool `max` (20) | connection errors / > 20 |
| G9 | DB insert throughput | rows/sec sustained at largest stage | ≥ 200 rows/s | < 200 rows/s |
| G10 | Watchdog resets | ESP32 reset/reason lines in serial log during endurance run | 0 unexpected resets | ≥ 1 unexpected reset |
| G11 | Heap leak (ESP32) | free-heap delta end-minus-start over endurance run | ≥ 0 (stable) | negative drift ≥ 10 KB/h |
| G12 | Dashboard Lighthouse | Performance score, mobile preset, cold | ≥ 80 | < 80 |
| G13 | Dashboard TTI | Time to Interactive, cold, desktop | ≤ 3.5 s | > 3.5 s |
| G14 | SSE fan-out | concurrent `/sensor/stream` clients served without dropped events | ≥ 20 clients, event loss 0 % | client disconnects / loss > 0 % |
| G15 | SMS containment | real SMS sent during tests | exactly 0 | ≥ 1 |
| G16 | Recovery time | time from server restart to first successful ingest after downtime | ≤ 60 s | > 60 s |

### 1.3 Definition of "done" for the whole run

The run is **GREEN** only if G1–G16 all pass. Any FAIL must be recorded with evidence (log excerpt, k6 summary, screenshot, SQL output) in §8 and summarised in §9.

---

## 2. Test Environment and Prerequisites

### 2.1 Reference environment (fill in your own)

| Item | Value | Notes |
|------|-------|-------|
| Load generator CPU | `{CPU e.g. Ryzen 5 5600, 6c/12t}` | If same machine as SUT, note it. |
| Load generator RAM | `{RAM e.g. 16 GB}` | |
| SUT machine | `{same / separate}` | Separate is strongly preferred. |
| OS | `{Windows 11 23H2}` | Commands below are PowerShell-first. |
| Node.js | `24.14.0` (repo runs v24.14.0, npm 11.9.0) | `node --version` |
| PostgreSQL | `18.3` | |
| Browser | Chrome/Edge latest | Required for Lighthouse + dashboard. |
| Network | localhost (loopback) | State clearly: loopback has **no Wi-Fi latency**. |

> Record whether the load generator is on the same host as the SUT and whether you used loopback. These two facts change how §9 interprets every latency number.

### 2.2 Placeholders to replace

| Placeholder | Meaning | Example |
|-------------|---------|---------|
| `{BASE_URL}` | API origin, no `/api` prefix for scripts/tests | `http://localhost:3000` |
| `{WEB_URL}` | Dashboard origin (dev server) | `http://localhost:5173` |
| `{DEVICE_SECRET}` | Shared device secret used by `X-Device-Secret` | value of `DEVICE_SECRET` |
| `{DB_NAME}` | **Test** database name | `crayvings_stress_test` |
| `{PGUSER}` / `{PGPASSWORD}` | Postgres superuser creds | `postgres` / `****` |
| `{ADMIN_USER}` / `{ADMIN_PASSWORD}` | Owner account for admin endpoints | `owner` / `****` |
| `{API_TOKEN}` | A session value usable as `Authorization: Bearer` | see §2.5 |
| `{COM_PORT}` | ESP32 serial port | `COM3` |

Convenience exports for the session (PowerShell):

```powershell
$env:BASE_URL      = "http://localhost:3000"
$env:WEB_URL       = "http://localhost:5173"
$env:DEVICE_SECRET = "{DEVICE_SECRET}"
$env:DB_NAME       = "crayvings_stress_test"
$env:PGUSER        = "postgres"
$env:PGPASSWORD    = "{PGPASSWORD}"
$env:ADMIN_USER    = "{ADMIN_USER}"
$env:ADMIN_PASSWORD= "{ADMIN_PASSWORD}"
```

### 2.3 Tool installation

Install **all** of these before starting. Pick one package manager; examples use `winget`/`choco` on Windows and `brew`/`apt` on macOS/Linux.

**k6** (primary load tool):

```powershell
# Windows
winget install k6 --source winget
# or: choco install k6
# macOS: brew install k6
# Linux: sudo apt-get install k6   (see k6 docs for the repo key)
k6 version
```

**autocannon** and **Artillery** (secondary load tools + quick spot checks):

```powershell
npm install -g autocannon artillery
autocannon --version
artillery --version
```

**pgbench** (ships with PostgreSQL — add `psql`/`pgbench` to PATH):

```powershell
# Windows: add e.g. C:\Program Files\PostgreSQL\18\bin to PATH, then:
pgbench --version
psql --version
```

**Lighthouse** (dashboard performance):

```powershell
npm install -g lighthouse
lighthouse --version
```

**Playwright** (optional, for repeatable browser concurrency — used by WEB-02):

```powershell
npm install -g playwright
npx playwright install chromium
```

**Resource monitor:**

- Windows: **Task Manager** (Ctrl+Shift+Esc → Performance tab) or **Process Explorer**.
- macOS/Linux: `htop` (`brew install htop` / `sudo apt-get install htop`) or `nmon`.

**ESP32 Serial Monitor:** Arduino IDE (Tools → Serial Monitor, baud **115200**) **or** PlatformIO Monitor **or** a CLI capture tool:

```powershell
pip install pyserial
python -m serial.tools.miniterm {COM_PORT} 115200
```

**jq** (JSON parsing in shell examples): `winget install jqlang.jq` or `choco install jq`.

### 2.4 Repository setup

```powershell
# From the repo root
npm install
Copy-Item .env.example .env   # only if .env does not exist yet; keep the real .env intact
```

> **Do not commit, paste, or log any real `.env` value.** The stress procedure overrides SMS and logging via shell environment variables (below) so you never edit the real `.env`.

Confirm static checks pass before load (the SUT must be healthy first):

```powershell
npm run build
npm run lint
npm test
```

### 2.5 Starting the server in TEST mode (SMS disabled, exact-count logging)

Open a **dedicated terminal** for the SUT and set the environment **before** starting Node. `dotenv` does not override variables already present in the shell, so these win over `.env`:

```powershell
# --- TEST-MODE SAFETY FLAGS (must be set before starting the server) ---
$env:NODE_ENV                 = "development"
$env:PORT                     = "3000"

# 1. Do not delete history during the run (larger tables are the point).
$env:SENSOR_RETENTION_DAYS         = "0"
$env:SYSTEM_LOGS_RETENTION_DAYS    = "0"
$env:ACTIVITY_LOGS_RETENTION_DAYS  = "0"
$env:SMS_RETENTION_DAYS            = "0"

# 2. Exact row counts for data-loss tests: every post writes a row.
$env:DELTA_LOGGING_ENABLED    = "false"

# 3. DISABLE ALL SMS. Empty key makes sendHttpsms() throw *before* any network call.
$env:HTTPSMS_API_KEY          = ""
$env:HTTPSMS_FROM             = ""
$env:HOURLY_SMS_ENABLED       = "false"
$env:DEVICE_DISCONNECT_ENABLED= "false"
$env:SMS_DAILY_CAP            = "0"          # 0 = cap disabled; we assert containment separately

# 4. Point at the TEST database (never the real one).
$env:PG_HOST     = "localhost"
$env:PG_PORT     = "5432"
$env:PG_DATABASE = "crayvings_stress_test"
$env:PG_USER     = "postgres"
$env:PG_PASSWORD = "{PGPASSWORD}"

# Start the SUT (leave this terminal running)
node server.cjs
```

Verify on startup that:
- the log shows retention as **off** (`Retention: sensors off, ...`),
- no "SMS ... configured" success line appears,
- the process listens on `http://localhost:3000`.

Sanity check (new terminal):

```powershell
curl.exe -s {BASE_URL}/health
```

Expected: `200` and a JSON body containing a status/`ok` field.

**To obtain a session value usable as `{API_TOKEN}`** — `POST /auth/login` sets the `crayvings_session` **HttpOnly cookie** and deliberately does **not** return the token in the body. The cookie's value is the raw session token, which is also accepted as `Authorization: Bearer`:

```powershell
# Log in and print the cookie value (this is your {API_TOKEN})
$resp = Invoke-WebRequest -Method Post -Uri "$env:BASE_URL/auth/login" `
  -ContentType "application/json" `
  -Body (@{ username=$env:ADMIN_USER; password=$env:ADMIN_PASSWORD } | ConvertTo-Json)
$cookie = $resp.Headers["Set-Cookie"]
if ($cookie -match "crayvings_session=([^;]+)") { $env:API_TOKEN = $Matches[1]; "API_TOKEN=$($Matches[1])" }
```

Verify it works:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -H "Authorization: Bearer $env:API_TOKEN" {BASE_URL}/settings/effective
```

Expected: `200`.

### 2.6 Hard SMS safety backstop (do this, don't skip it)

Even with `HTTPSMS_API_KEY=""`:

1. **Unplug / power off the Android phone running the HttpSms gateway** for the entire run. No gateway, no SMS, no cost.
2. Confirm the setting on the live DB before tests:

```powershell
psql -U {PGUSER} -d {DB_NAME} -c "SELECT COUNT(*) AS sent_last_24h FROM sms_logs WHERE created_at > now() - interval '24 hours' AND status <> 'failed';"
```

Record this number. It must not increase during the run. If it does, **stop immediately** and re-check §2.5.

### 2.7 Create the throwaway test database

```powershell
psql -U {PGUSER} -c "DROP DATABASE IF EXISTS crayvings_stress_test;"
psql -U {PGUSER} -c "CREATE DATABASE crayvings_stress_test;"

# Run the structural migrations in order against the test DB
Get-ChildItem db\migrations\*.cjs | Sort-Object Name | ForEach-Object {
  $env:PG_DATABASE = "crayvings_stress_test"
  node $_.FullName
}
```

Seed the owner account (uses `ADMIN_*` vars):

```powershell
$env:PG_DATABASE = "crayvings_stress_test"
npm run seed:admin
```

### 2.8 Recommended terminal layout

| Terminal | Purpose |
|----------|---------|
| T1 | SUT: `node server.cjs` (TEST-mode env) |
| T2 | Dashboard dev server: `npm run dev` |
| T3 | Load generator (k6 / Node scripts) |
| T4 | `psql` for DB inspection |
| T5 | Resource monitor (Task Manager / `htop`) |

---

## 3. Test Data Preparation

Do all of this once, then snapshot the starting state so every test starts from a known baseline.

### 3.1 Seed simulated devices

Create the fleet of device rows the SST will post as. `POST /sensor` auto-registers unknown devices, but pre-creating them keeps the run deterministic and lets you use per-device names.

```sql
-- db/seed_stress_devices.sql  (run with: psql -U {PGUSER} -d {DB_NAME} -f db/seed_stress_devices.sql)
INSERT INTO devices (device_id, name, tank_name, tank_location, ip_address, is_active, registered_via, ip_source)
SELECT
  'ESP32_' || lpad(g::text, 2, '0'),
  'Stress Tank ' || g,
  'Tank ' || g,
  'Stress Lab',
  '127.0.0.1',
  true,
  'manual',
  'manual'
FROM generate_series(1, 64) AS g
ON CONFLICT (device_id) DO NOTHING;
```

```powershell
psql -U {PGUSER} -d {DB_NAME} -f db\seed_stress_devices.sql
```

### 3.2 Seed large history (for large-range query tests)

Backfill ~7 days of readings for a handful of devices so WEB-03 / SYS-05 have data:

```sql
-- db/seed_stress_history.sql
-- 7 days, 1 reading/minute, 8 devices => ~80,640 rows. Adjust device count for more.
INSERT INTO sensors (device_id, temperature, water_level, water_distance_cm, ammonia, timestamp)
SELECT
  'ESP32_' || lpad((1 + (s.n % 8))::text, 2, '0'),
  round((26 + 2 * random())::numeric, 1),
  round((70 + 20 * random())::numeric, 0),
  round((5 + 15 * random())::numeric, 1),
  round((0.05 + 0.9 * random())::numeric, 2),
  now() - (s.n || ' minutes')::interval
FROM generate_series(0, 10080) AS s(n);
```

```powershell
psql -U {PGUSER} -d {DB_NAME} -f db\seed_stress_history.sql
psql -U {PGUSER} -d {DB_NAME} -c "SELECT count(*) AS rows, min(timestamp), max(timestamp) FROM sensors;"
```

For a **10× bigger** DB (heavier SYS-05), add a second pass:

```sql
INSERT INTO sensors (device_id, temperature, water_level, water_distance_cm, ammonia, timestamp)
SELECT 'ESP32_01', 27, 80, 10, 0.4, now() - (s.n || ' seconds')::interval
FROM generate_series(0, 864000) AS s(n);   -- ~864k rows / 10 days
```

### 3.3 Seed dashboard test users (for concurrent-login tests)

A session is **single-per-user**: logging in again invalidates the previous token (`server.cjs` login handler). Therefore many concurrent users **must each have their own account.** Create them via the admin API:

`scripts/make-test-users.cjs`:

```javascript
// scripts/make-test-users.cjs
// Usage: node scripts/make-test-users.cjs 20
// Creates loadtest_1..loadtest_N (role "user") using the admin session.
const BASE = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const N = Number(process.argv[2] || 20);
const PASSWORD = "LoadTest#1234";

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const m = /crayvings_session=([^;]+)/.exec(setCookie);
  if (!res.ok || !m) throw new Error(`admin login failed: ${res.status} ${await res.text()}`);
  return m[1];
}

async function main() {
  if (!ADMIN_USER || !ADMIN_PASSWORD) throw new Error("set ADMIN_USER / ADMIN_PASSWORD");
  const token = await login();
  let created = 0, skipped = 0;
  for (let i = 1; i <= N; i++) {
    const body = JSON.stringify({
      name: `Load Test ${i}`,
      username: `loadtest_${i}`,
      email: `loadtest_${i}@example.test`,
      password: PASSWORD,
      role: "user",
    });
    const res = await fetch(`${BASE}/auth/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
    });
    if (res.ok) created++;
    else { skipped++; console.log(`loadtest_${i}: ${res.status} ${(await res.text()).slice(0,120)}`); }
  }
  console.log(`created=${created} skipped=${skipped} password=${PASSWORD}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

```powershell
node scripts\make-test-users.cjs 20
```

### 3.4 Snapshot the starting state (record this in §8, Table 8.0)

```powershell
psql -U {PGUSER} -d {DB_NAME} -c "SELECT count(*) AS sensors_rows FROM sensors;"
psql -U {PGUSER} -d {DB_NAME} -c "SELECT count(*) AS devices_rows FROM devices;"
psql -U {PGUSER} -d {DB_NAME} -c "SELECT count(*) AS users_rows FROM users;"
psql -U {PGUSER} -d {DB_NAME} -c "SELECT pg_size_pretty(pg_total_relation_size('sensors')) AS sensors_size;"
```

### 3.5 Simulating devices — the two mechanisms

**(a) Project simulator** `scripts/mock-device.js` — posts to the real ingest endpoint at a set interval, with realistic noise, ramp, and simulated sensor failure profiles. Supports many devices in one process and writes a JSONL log for data-loss accounting:

```powershell
# One device, healthy, every 1s, 300 posts, log every post
node scripts\mock-device.js --device ESP32_01 --interval 1000 --cycles 300 --log tests\results\mock_esp32_01.jsonl
```

Fleet launcher `tools/fleet.ps1` (many devices, one process):

```powershell
# tools/fleet.ps1
param(
  [int]$Count = 6,
  [int]$Interval = 1000,
  [string]$Log = "tests/results/fleet.jsonl",
  [string]$Profile = "healthy"
)
$devices = 1..$Count | ForEach-Object { "ESP32_{0:D2}" -f $_ }
$args = @("scripts/mock-device.js", "--profile", $Profile, "--interval", "$Interval", "--log", $Log)
foreach ($d in $devices) { $args += @("--device", $d) }
Write-Host "Launching $Count devices @ ${Interval}ms -> $Log"
node @args
```

```powershell
# 6 devices at 1 post/sec each = 6 posts/sec
tools\fleet.ps1 -Count 6 -Interval 1000 -Log tests\results\SYS-02.jsonl
```

**(b) k6** — used where exact arrival rate and machine-readable percentile metrics matter (SYS-01, SYS-03, SYS-04, WEB-04). Scripts are given inline in each test.

### 3.6 Data-loss accounting helper

`tools/count-jsonl.cjs` — counts how many posts in a JSONL log were **accepted** (2xx). Compare to the DB row count added.

```javascript
// tools/count-jsonl.cjs
// Usage: node tools/count-jsonl.cjs tests/results/SYS-02.jsonl
const fs = require("node:fs");
const file = process.argv[2];
if (!file) { console.error("usage: node tools/count-jsonl.cjs <file.jsonl>"); process.exit(2); }
let total = 0, ok = 0, byStatus = {};
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  total++;
  const s = r.response?.status ?? -1;
  byStatus[s] = (byStatus[s] || 0) + 1;
  if (s >= 200 && s < 300) ok++;
}
console.log(JSON.stringify({ file, total, accepted_2xx: ok, byStatus }, null, 2));
```

### 3.7 Driver: count DB rows added between two times

```sql
-- Count rows written into a window; run after a test
SELECT count(*) AS rows_written
FROM sensors
WHERE timestamp >= '${START_ISO}'::timestamptz
  AND timestamp <= '${END_ISO}'::timestamptz;
```

Capture `{START_ISO}`/`{END_ISO}` in PowerShell with `(Get-Date).ToUniversalTime().ToString("o")`.

---

## 4. Part A: System Stress Tests

Order is deliberately light → heavy. **Do not skip SYS-01.** Every test states its load profile explicitly: ramp-up → steady state → ramp-down.

### SYS-01 — Baseline ingest (single device, nominal rate)

- **ID / Title:** SYS-01 — Baseline ingest: 1 device @ 1 post/s for 5 min
- **Purpose:** Establish the "healthy" reference for ingest latency, CPU/RAM, and DB write rate with **no** concurrency. Every later result is compared to this.
- **Preconditions:** server running in TEST mode (§2.5); test DB seeded; `{DEVICE_SECRET}` set; `mock` device row exists. No other load.
- **Load profile:** ramp 0→1 request/s over 15 s, steady 1 req/s for 5 min, ramp-down is the stop.
- **Steps:**

  1. Record the start time.
     ```powershell
     $START = (Get-Date).ToUniversalTime().ToString("o"); $START
     ```
  2. Start the resource monitor (Task Manager → Details → `node.exe`, note CPU % and Memory (private working set)).
  3. Run k6 baseline ingest.
     ```javascript
     // tests/k6/ingest-baseline.js
     import http from "k6/http";
     import { check } from "k6";
     import { Counter, Trend } from "k6/metrics";

     const BASE = __ENV.BASE_URL || "http://localhost:3000";
     const SECRET = __ENV.DEVICE_SECRET || "change_me_shared_secret";
     const accepted = new Counter("sensor_accepted");
     const rejected = new Counter("sensor_rejected");

     export const options = {
       discardResponseBodies: true,
       scenarios: {
         baseline: {
           executor: "ramping-arrival-rate",
           startRate: 0,
           timeUnit: "1s",
           stages: [
             { target: 1, duration: "15s" },  // ramp-up
             { target: 1, duration: "5m" },   // steady state
           ],
           preAllocatedVUs: 5,
           maxVUs: 20,
         },
       },
       thresholds: {
         http_req_failed: ["rate<0.01"],
         "http_req_duration{expected_response:true}": ["p(95)<500"],
       },
     };

     export default function () {
       const payload = JSON.stringify({
         device_id: "ESP32_01",
         temperature: 26.5 + Math.random(),
         water_level: 78 + Math.random() * 4,
         ammonia: 0.2 + Math.random() * 0.2,
       });
       const res = http.post(`${BASE}/sensor`, payload, {
         headers: { "Content-Type": "application/json", "X-Device-Secret": SECRET },
         tags: { endpoint: "sensor" },
       });
       check(res, { "2xx": (r) => r.status >= 200 && r.status < 300 });
       if (res.status >= 200 && res.status < 300) accepted.add(1); else rejected.add(1);
     }
     ```
     ```powershell
     k6 run -e BASE_URL=$env:BASE_URL -e DEVICE_SECRET=$env:DEVICE_SECRET tests\k6\ingest-baseline.js
     ```
  4. Record the end time and count DB rows written:
     ```powershell
     $END = (Get-Date).ToUniversalTime().ToString("o"); $END
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT count(*) FROM sensors WHERE timestamp >= '$START' AND timestamp <= '$END';"
     ```
  5. Capture a small DB sample to prove values are stored (not NULL/0):
     ```powershell
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT device_id, temperature, water_level, ammonia, timestamp FROM sensors ORDER BY timestamp DESC LIMIT 5;"
     ```
- **Expected result:** ~300 accepted posts, ~300 new rows, p95 well under 100 ms on loopback, server CPU low (<10 %).
- **Metrics to capture:** `http_req_duration` p95/p99, `http_req_failed` rate, `sensor_accepted`, server CPU %/RSS, rows written, `pg_stat_activity` count.
- **Pass/Fail rule:** G1, G2, G5 pass; rows written equals accepted count ±0.
- **Result:** [ ] Pass  [ ] Fail

### SYS-02 — Nominal fleet (6 devices @ 1 post/s)

- **ID / Title:** SYS-02 — Nominal star-topology fleet: 6 devices @ 1 post/s for 10 min
- **Purpose:** Validate the documented topology (up to ~6 ESP32/server) at the real production cadence.
- **Preconditions:** SYS-01 passed; no other load.
- **Load profile:** ramp 0→6 req/s over 30 s, steady 6 req/s for 10 min, ramp-down (stop).
- **Steps:**
  1. `$START = (Get-Date).ToUniversalTime().ToString("o")`
  2. Launch the fleet with logging:
     ```powershell
     tools\fleet.ps1 -Count 6 -Interval 1000 -Log tests\results\SYS-02.jsonl
     ```
     Let it run ~10 min, then Ctrl+C.
  3. `$END = (Get-Date).ToUniversalTime().ToString("o")`
  4. Count accepted posts vs DB rows:
     ```powershell
     node tools\count-jsonl.cjs tests\results\SYS-02.jsonl
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT count(*) FROM sensors WHERE timestamp >= '$START' AND timestamp <= '$END';"
     ```
  5. Verify all 6 devices updated recently:
     ```powershell
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT device_id, last_seen FROM devices WHERE device_id LIKE 'ESP32_0%' ORDER BY device_id;"
     ```
- **Expected result:** ~3,600 accepted posts and ~3,600 rows; near-zero failures; no device starved.
- **Metrics to capture:** accepted vs rows, server CPU/RAM, DB writes/sec.
- **Pass/Fail rule:** G1, G2, G5 pass; no device is missing a recent `last_seen`.
- **Result:** [ ] Pass  [ ] Fail

### SYS-03 — Ingest staircase (find the breakdown point)

- **ID / Title:** SYS-03 — Ingest step-stress: 6 → 12 → 24 → 48 → 96 req/s
- **Purpose:** Push ingest until p95 breaches G2 or errors appear; find the sustainable ceiling and the first failing stage.
- **Preconditions:** SYS-01/02 passed. Note: the server has a **per-device ingest limiter of 12 req/s** (`sensorIngestLimiter`, keyed by `device_id`) and a **global IP limiter of 300 req/min for non-`/sensor` routes** — `/sensor` is exempt from the global one. Spread requests across many `device_id`s so you are testing the server, not tripping the per-device guard.
- **Load profile (stages):** 30 s ramp + 3 min steady **per stage**, in this order:
  | Stage | Target rate | Devices used |
  |-------|-------------|--------------|
  | 1 | 6 req/s | 6 |
  | 2 | 12 req/s | 12 |
  | 3 | 24 req/s | 24 |
  | 4 | 48 req/s | 48 |
  | 5 | 96 req/s | 64 (allowed; repeats cycle) |
- **Steps:**
  1. Ensure the test DB has ≥64 device rows (§3.1).
  2. Run the staircase script, which reads `RATE` and `DEVICE_COUNT` from the environment:
     ```javascript
     // tests/k6/ingest-staircase.js
     import http from "k6/http";
     import { check } from "k6";
     import { Counter } from "k6/metrics";

     const BASE = __ENV.BASE_URL || "http://localhost:3000";
     const SECRET = __ENV.DEVICE_SECRET || "change_me_shared_secret";
     const RATE = Number(__ENV.RATE || 6);
     const DEVICE_COUNT = Number(__ENV.DEVICE_COUNT || 6);
     const DURATION = __ENV.DURATION || "3m";
     const accepted = new Counter("sensor_accepted");
     const rejected = new Counter("sensor_rejected");

     export const options = {
       discardResponseBodies: true,
       scenarios: {
         stair: {
           executor: "ramping-arrival-rate",
           startRate: 0,
           timeUnit: "1s",
           stages: [
             { target: RATE, duration: "30s" },
             { target: RATE, duration: DURATION },
           ],
           preAllocatedVUs: Math.max(20, RATE),
           maxVUs: Math.max(100, RATE * 4),
         },
       },
       thresholds: {
         http_req_failed: ["rate<0.01"],
         "http_req_duration{expected_response:true}": ["p(95)<500"],
       },
     };

     export default function () {
       const n = (__ITER % DEVICE_COUNT) + 1;
       const device_id = "ESP32_" + String(n).padStart(2, "0");
       const payload = JSON.stringify({
         device_id,
         temperature: 26 + Math.random() * 3,
         water_level: 70 + Math.random() * 25,
         ammonia: 0.05 + Math.random() * 0.9,
       });
       const res = http.post(`${BASE}/sensor`, payload, {
         headers: { "Content-Type": "application/json", "X-Device-Secret": SECRET },
       });
       check(res, { "2xx": (r) => r.status >= 200 && r.status < 300 });
       if (res.status >= 200 && res.status < 300) accepted.add(1); else rejected.add(1);
     }
     ```
  3. Run each stage; note start/end and DB row deltas after each:
     ```powershell
     foreach ($stage in @(@{r=6;d=6}, @{r=12;d=12}, @{r=24;d=24}, @{r=48;d=48}, @{r=96;d=64})) {
       $s = (Get-Date).ToUniversalTime().ToString("o")
       Write-Host "=== STAGE rate=$($stage.r) devices=$($stage.d) ==="
       k6 run -e BASE_URL=$env:BASE_URL -e DEVICE_SECRET=$env:DEVICE_SECRET `
              -e RATE=$($stage.r) -e DEVICE_COUNT=$($stage.d) `
              "tests\k6\ingest-staircase.js"
       $e = (Get-Date).ToUniversalTime().ToString("o")
       psql -U {PGUSER} -d {DB_NAME} -c "SELECT count(*) AS rows_written FROM sensors WHERE timestamp >= '$s' AND timestamp <= '$e';"
     }
     ```
  4. Watch server CPU/RAM and Psql `pg_stat_activity` throughout.
- **Expected result:** passes cleanly through at least 48 req/s; may degrade or fail at 96 req/s. **Finding the first failing stage is a successful outcome** — record it.
- **Metrics to capture:** per-stage p95/p99, error rate, rows written, CPU/RAM peak, DB active connections.
- **Pass/Fail rule:** Record the highest stage meeting G1+G2+G5. Mark Pass if the ceiling is ≥48 req/s (well above the 6-device production load); Fail if it is below 48 req/s or if data loss (G5) occurs at any passing stage.
- **Result:** [ ] Pass  [ ] Fail

### SYS-04 — Authenticated read load (history + analytics + latest)

- **ID / Title:** SYS-04 — Concurrent authenticated reads: 50 users, 10 min
- **Purpose:** Exercise the endpoints the dashboard hammers (`/devices/latest`, `/sensor/latest`, `/sensor`, `/analytics/overview`, `/analytics/daily`, `/report/range`) under many sessions.
- **Preconditions:** SYS-01 passed; ≥20 `loadtest_*` users created (§3.3); DB has history (§3.2); `{API_TOKEN}` works. Note the global limiter is **300 req/min/IP** for these routes — with 50 VUs generating hundreds of req/min from one IP you **will** hit `429`. To test the server (not the limiter), either (a) lower the rate so total stays under 300/min, or (b) start the SUT with the global limiter relaxed for the test. Prefer (a) for a clean signal and record the choice.
- **Load profile:** ramp 0→50 VUs over 1 min, steady 50 VUs for 8 min, ramp-down over 1 min.
- **Steps:**
  1. `scripts/k6/read-load.js` — each VU logs in as its **own** user (because re-login invalidates the previous session) and then loops reads:
     ```javascript
     // tests/k6/read-load.js
     import http from "k6/http";
     import { check, sleep } from "k6";
     import { Trend } from "k6/metrics";

     const BASE = __ENV.BASE_URL || "http://localhost:3000";
     const PASSWORD = "LoadTest#1234";
     const USERS = Number(__ENV.USERS || 20);
     const history = new Trend("history_query_ms", true);

     export const options = {
       scenarios: {
         reads: {
           executor: "ramping-vus",
           startVUs: 0,
           stages: [
             { target: 50, duration: "1m" },
             { target: 50, duration: "8m" },
             { target: 0, duration: "1m" },
           ],
         },
       },
       thresholds: {
         http_req_failed: ["rate<0.01"],
         http_req_duration: ["p(95)<1500"],
       },
     };

     export function setup() {
       // Log every user in once so each VU has a distinct, valid Bearer token.
       const tokens = [];
       for (let i = 1; i <= USERS; i++) {
         const res = http.post(`${BASE}/auth/login`,
           JSON.stringify({ username: `loadtest_${i}`, password: PASSWORD }),
           { headers: { "Content-Type": "application/json" } });
         const c = res.cookies["crayvings_session"];
         tokens.push(c && c.length ? c[0].value : null);
       }
       return { tokens };
     }

     export default function (data) {
       const token = data.tokens[(__VU - 1) % data.tokens.length];
       if (!token) { sleep(1); return; }
       const auth = { headers: { Authorization: `Bearer ${token}` } };

       check(http.get(`${BASE}/devices/latest`, auth), { "latest 2xx": (r) => r.status === 200 });
       check(http.get(`${BASE}/sensor/latest?device_id=ESP32_01`, auth), { "sensor/latest 2xx": (r) => r.status === 200 || r.status === 404 });

       const hres = http.get(`${BASE}/sensor?device_id=ESP32_01&limit=500`, auth,
         { tags: { endpoint: "history" } });
       history.add(hres.timings.duration);
       check(hres, { "history 2xx": (r) => r.status === 200 });

       check(http.get(`${BASE}/analytics/overview`, auth), { "overview 2xx": (r) => r.status === 200 });
       check(http.get(`${BASE}/analytics/daily`, auth), { "daily 2xx": (r) => r.status === 200 });

       sleep(Math.random() * 2 + 1); // 1–3s think time, like a human
     }
     ```
  2. Run:
     ```powershell
     k6 run -e BASE_URL=$env:BASE_URL -e USERS=20 tests\k6\read-load.js
     ```
  3. If you see `429` (rate-limited) rather than `500`, you are measuring the limiter, not the DB. Re-run with fewer VUs or a slower loop and note it.
  4. Sample active connections mid-run:
     ```powershell
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT state, count(*) FROM pg_stat_activity WHERE datname='crayvings_stress_test' GROUP BY state;"
     ```
- **Expected result:** read p95 ≤ 1.5 s, error rate ≤ 1 % (ignoring intentional 429s, which must be reported separately), no DB connection exhaustion.
- **Metrics to capture:** `http_req_duration` p95/p99 overall and per endpoint, `history_query_ms` p95, error breakdown by status, DB active/idle connections.
- **Pass/Fail rule:** G3 and G4 pass and G8 holds (no connection-limit errors). 429s are reported but do not themselves fail the test if the limiter behaviour is the cause.
- **Result:** [ ] Pass  [ ] Fail

### SYS-05 — PostgreSQL heavy insert + large history query

- **ID / Title:** SYS-05 — Direct DB stress: pgbench inserts while the API serves a full-range history query
- **Purpose:** Isolate the database: max insert throughput, index behaviour on `sensors(timestamp DESC)`, and whether a large range query starves writes.
- **Preconditions:** test DB seeded (§3.2, including the 10× pass); `pgbench` on PATH; **run this on the test DB only**.
- **Load profile:** ramp to 10 clients / 4 jobs over 15 s, steady 60 s, stop.
- **Steps:**
  1. Ensure device rows exist for pgbench clients (FK safety):
     ```sql
     INSERT INTO devices (device_id, name, is_active, registered_via, ip_source)
     SELECT 'pgbench_' || g, 'pgbench ' || g, true, 'manual', 'manual'
     FROM generate_series(1, 20) g
     ON CONFLICT (device_id) DO NOTHING;
     ```
  2. Create the pgbench script:
     ```sql
     -- db/pgbench_sensors.sql
     INSERT INTO sensors (device_id, temperature, water_level, water_distance_cm, ammonia, timestamp)
     VALUES ('pgbench_' || :client_id, 27.5, 80, 20, 0.5, now());
     ```
  3. Run pgbench at increasing client counts:
     ```powershell
     foreach ($c in 1, 4, 10, 20) {
       Write-Host "=== pgbench clients=$c ==="
       pgbench -U {PGUSER} -h localhost -d {DB_NAME} -n -c $c -j 4 -T 60 -f db\pgbench_sensors.sql
     }
     ```
     Record `tps` (transactions per second = rows/sec) for each.
  4. While the highest-client pgbench run is active, in another terminal run the large history query and measure it:
     ```powershell
     psql -U {PGUSER} -d {DB_NAME} -c "\timing on" `
       -c "SELECT date_trunc('hour', timestamp) AS bucket, avg(temperature), avg(water_level), avg(ammonia), count(*) FROM sensors WHERE device_id='ESP32_01' AND timestamp >= now() - interval '10 days' GROUP BY 1 ORDER BY 1;"
     ```
  5. Inspect the plan for the range query:
     ```powershell
     psql -U {PGUSER} -d {DB_NAME} -c "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM sensors WHERE device_id='ESP32_01' AND timestamp >= now() - interval '10 days' ORDER BY timestamp DESC LIMIT 5000;"
     ```
     Look for: `Index Scan using idx_sensors_timestamp` vs a `Seq Scan`, and `actual time`.
  6. Measure API-level large-range query too:
     ```powershell
     # requires admin token
     curl.exe -s -o NUL -w "report/range: %{http_code} %{time_total}s`n" `
       -H "Authorization: Bearer $env:API_TOKEN" `
       "{BASE_URL}/report/range?from=$(Get-Date).AddDays(-10).ToString('yyyy-MM-dd')&to=$(Get-Date).ToString('yyyy-MM-dd')"
     ```
- **Expected result:** insert throughput increases then plateaus; the large range query stays under a few seconds; plan uses the timestamp index; API range query ≤ 5 s on the test dataset.
- **Metrics to capture:** pgbench tps per client count, history query wall time, `EXPLAIN ANALYZE` plan + actual time, buffer reads, table size (`pg_total_relation_size`).
- **Pass/Fail rule:** G9 passes (≥200 rows/s) and the 10-day aggregate query returns in ≤ 5 s. Fail if throughput < 200 rows/s or the query takes > 5 s / does a full Seq Scan on a large table.
- **Result:** [ ] Pass  [ ] Fail

### SYS-06 — Wi-Fi drop and reconnect (device offline buffering)

- **ID / Title:** SYS-06 — Device drops offline, reconnects, flushes buffered readings
- **Purpose:** Prove a device that loses Wi-Fi will not lose readings and that the reconnect burst is not rejected by the per-device limiter (the limiter allows 12/s precisely for this).
- **Preconditions:** SYS-02 or SYS-03 running/passed; a simulated device that stops posting mid-run.
- **Load profile:** steady 6 req/s, then one device goes silent for 60 s, then returns with a 10-reading backlog burst, then steady again.
- **Steps:**
  1. Start a fleet of 6 for 2 min:
     ```powershell
     tools\fleet.ps1 -Count 6 -Interval 1000 -Log tests\results\SYS-06.jsonl
     ```
  2. Simulate the drop for one device (Ctrl+C the fleet and restart only ESP32_04 with a `failed_all`/silent profile, then resume). Using the project's simulator, a profile that stops after N cycles emulates a disconnect:
     ```powershell
     # ESP32_04 posts 20 times then goes silent (simulated Wi-Fi loss)
     node scripts\mock-device.js --device ESP32_04 --interval 1000 --cycles 20
     ```
  3. Wait 60 s (device is offline; the server's disconnect detection is exercisable if you re-enable `DEVICE_DISCONNECT_ENABLED` for this single test, but SMS stays off).
  4. Reconnect and flush a backlog — post 10 readings back-to-back (mimics the firmware's offline buffer) then resume 1/s:
     ```powershell
     # Burst-backlog probe: 10 rapid posts, then resume normal cadence
     for ($i=0; $i -lt 10; $i++) {
       curl.exe -s -o NUL -w "backlog $i: %{http_code}`n" -X POST {BASE_URL}/sensor `
         -H "Content-Type: application/json" -H "X-Device-Secret: $env:DEVICE_SECRET" `
         -d '{"device_id":"ESP32_04","temperature":27.1,"water_level":80,"ammonia":0.3}'
     }
     node scripts\mock-device.js --device ESP32_04 --interval 1000 --cycles 60
     ```
     Note: the 10 rapid posts share one `device_id` bucket — the limiter allows 12/s, so **all 10 must return 201**, not 429.
  5. Verify continuity for the device:
     ```powershell
     node tools\count-jsonl.cjs tests\results\SYS-06.jsonl
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT count(*), min(timestamp), max(timestamp) FROM sensors WHERE device_id='ESP32_04';"
     ```
- **Expected result:** every backlog post returns `201`; no gap beyond the offline interval in the device's normal cadence; server logs show a reconnect/heartbeat, no crash.
- **Metrics to capture:** backlog success count, any `429`/`5xx`, device `last_seen` before/after, rows for `ESP32_04` across the window.
- **Pass/Fail rule:** G5 pass for ESP32_04 (no accepted post lost); the 10-post burst yields 10×`201`; server stays up.
- **Result:** [ ] Pass  [ ] Fail

### SYS-07 — Server downtime and recovery

- **ID / Title:** SYS-07 — Kill the API under load, restart, verify graceful recovery and no acknowledged-post loss
- **Purpose:** Prove the system survives a full backend restart during live ingest.
- **Preconditions:** SYS-02 passed; you can restart the T1 server terminal; load generator keeps running (it will get connection-refused, which is the point).
- **Load profile:** steady 6 req/s; server down for 45 s; ramp back to 6 req/s.
- **Steps:**
  1. Start the fleet logging to a fresh file:
     ```powershell
     tools\fleet.ps1 -Count 6 -Interval 1000 -Log tests\results\SYS-07.jsonl
     ```
  2. Let it run 60 s, then in T1 press **Ctrl+C** to stop the server (`SIGINT`). Time the kill: `$DOWN = (Get-Date).ToUniversalTime().ToString("o")`.
  3. Observe the load generator: it should log connection errors (`status:0`) or 5xx, **not** crash.
  4. After 45 s, restart T1 with the same TEST-mode env and `node server.cjs`. Time the restart: `$UP = (Get-Date).ToUniversalTime().ToString("o")`.
  5. Watch for the first successful post after restart; that gap is the recovery time.
  6. Let it run 60 s more, then Ctrl+C the fleet.
  7. Account for every post:
     ```powershell
     node tools\count-jsonl.cjs tests\results\SYS-07.jsonl
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT count(*) FROM sensors WHERE timestamp >= '$DOWN' AND timestamp <= '$UP';"
     ```
- **Expected result:** during downtime, posts fail with connection-refused (expected, `status:0`) — these are **not** acknowledged and therefore not "lost"; after restart, posting resumes within 60 s; server starts cleanly with no DB errors.
- **Metrics to capture:** downtime duration, time-to-first-201 after restart (recovery time), count of failed-during-downtime posts, `http_req_failed` once restarted, any startup errors.
- **Pass/Fail rule:** G16 pass (recovery ≤ 60 s) and G5 pass **for acknowledged posts only** (every `201` has a DB row). Posts that received no `2xx` during downtime are excluded from data loss but must be counted and reported.
- **Result:** [ ] Pass  [ ] Fail

### SYS-08 — SMS / alert flooding containment

- **ID / Title:** SYS-08 — Repeated threshold breaches; verify cooldown, daily cap, and circuit breaker (SMS mocked OFF)
- **Purpose:** Prove alerting is *contained* when thresholds are breached over and over, and that **no real SMS** is sent while SMS is disabled.
- **Preconditions:** SMS disabled (§2.5, gateway phone unplugged). A device + global thresholds configured such that a value can breach (e.g. ammonia above `ammonia_max`). Admin token for inspection.
- **Load profile:** 1 device @ 1 post/s for 3 min with **every** reading breaching a threshold (e.g. ammonia = 5.0 vs max 1.0).
- **Steps:**
  1. Confirm SMS is off in the running server: `HTTPSMS_API_KEY` empty means `sendHttpsms` throws "not configured" before any HTTP call. Verify no real SMS:
     ```powershell
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT status, count(*) FROM sms_logs GROUP BY status;"
     ```
  2. Note the current count (should only be test/old rows).
  3. Fire constant breaches:
     ```powershell
     for ($i=0; $i -lt 180; $i++) {
       curl.exe -s -o NUL -X POST {BASE_URL}/sensor `
         -H "Content-Type: application/json" -H "X-Device-Secret: $env:DEVICE_SECRET" `
         -d '{"device_id":"ESP32_01","temperature":27.0,"water_level":80,"ammonia":5.0}'
       Start-Sleep -Milliseconds 1000
     }
     ```
  4. Inspect logs/containers after the run:
     ```powershell
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT action, parameter, count(*) FROM system_logs WHERE device_id='ESP32_01' AND timestamp > now() - interval '5 minutes' GROUP BY action, parameter ORDER BY 3 DESC;"
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT status, count(*), min(created_at), max(created_at) FROM sms_logs WHERE created_at > now() - interval '5 minutes' GROUP BY status;"
     ```
  5. Check the circuit breaker and mute endpoints:
     ```powershell
     curl.exe -s -H "Authorization: Bearer $env:API_TOKEN" {BASE_URL}/alert/sms-health
     ```
  6. Re-enable a normal reading (ammonia 0.3) and confirm alert state clears on the dashboard/logs.
- **Expected result:** alert **records** are produced, but SMS sends are throttled by the cooldown (default 5 min) and the daily cap, and/or the circuit breaker opens; **no new real SMS** is delivered. Alerting does not overwhelm the DB.
- **Metrics to capture:** number of breach readings, number of alert rows created, number of SMS attempts vs sends, breaker state transitions, server CPU during alert processing.
- **Pass/Fail rule:** G15 pass (0 real SMS sent) and containment holds (SMS attempts bounded by cooldown/cap; no 5xx storm; core ingest unaffected). Fail if any real SMS leaves the gateway.
- **Result:** [ ] Pass  [ ] Fail

### SYS-09 — Single ESP32 endurance run (heap leak + watchdog)

- **ID / Title:** SYS-09 — 8-hour endurance: one physical ESP32, watch heap and reset reasons
- **Purpose:** Detect memory leaks / watchdog resets that only appear over hours.
- **Preconditions:** a real ESP32 DevKit V1 with the tank firmware flashed and configured (device_id `ESP32_01`, `{DEVICE_SECRET}`), connected via USB, serial terminal available. Alternatively run the software half against `scripts/mock-device.js` for 8 h to check the **server** side, while the physical board check runs in parallel.
- **Load profile:** constant — 1 post/s from the board for 8 h (extend to 24 h if time allows), plus normal server load off.
- **Steps:**
  1. Capture serial output to a file (leave it running):
     ```powershell
     python -m serial.tools.miniterm {COM_PORT} 115200 | Tee-Object -FilePath tests\results\SYS-09-serial.log
     ```
     If the firmware prints `ESP.getFreeHeap()` periodically, that line is your leak signal. If it does not, read free heap by resetting and comparing the boot heap to the heap after N hours via the monitor.
  2. In parallel, run the server and confirm the board's posts land:
     ```powershell
     node scripts\mock-device.js --list-devices --api {BASE_URL}
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT count(*), max(timestamp) FROM sensors WHERE device_id='ESP32_01';"
     ```
  3. Record hourly: free heap (from serial), server row count for the board, board CPU/temperature if available, and any reset line.
  4. After the run, parse the log for resets and heap values:
     ```powershell
     # Reset / watchdog reasons
     Select-String -Path tests\results\SYS-09-serial.log -Pattern "rst:|watchdog|Guru Meditation|Brownout|abort\(\)|panic" 
     # Heap samples (adapt the regex to your firmware's print statement)
     Select-String -Path tests\results\SYS-09-serial.log -Pattern "Free.?Heap|free_heap|heap=" 
     ```
  5. Compare first-hour vs last-hour free heap.
- **Expected result:** no unexpected reset lines; free heap stays flat (no downward drift); the board keeps posting for the whole run (last `timestamp` is recent).
- **Metrics to capture:** reset count by reason, free-heap start/mid/end, longest posting gap, total rows from the board.
- **Pass/Fail rule:** G10 pass (0 unexpected resets) and G11 pass (< 10 KB/h heap drift). Fail if any unexpected reset or clear leak.
- **Result:** [ ] Pass  [ ] Fail

### SYS-10 — SSE fan-out (real-time push) under load

- **ID / Title:** SYS-10 — 20+ concurrent real-time SSE subscribers with live ingest
- **Purpose:** Prove the real-time view's server push (`GET /sensor/stream`) scales and drops no events.
- **Preconditions:** SYS-02 or SYS-03 running; `{API_TOKEN}` valid; note `/sensor/stream` currently requires auth (Bearer or session cookie).
- **Load profile:** ramp to 20 SSE clients over 30 s, steady 5 min while ingest runs at 6 req/s, ramp-down.
- **Steps:**
  1. `tests/sse-load.mjs` — opens N concurrent SSE connections and counts received events:
     ```javascript
     // tests/sse-load.mjs
     // Usage: node tests/sse-load.mjs {BASE_URL} {API_TOKEN} 20 300
     const [base, token, nStr, secStr] = process.argv.slice(2);
     const BASE = base || "http://localhost:3000";
     const TOKEN = token;
     const N = Number(nStr || 20);
     const SECONDS = Number(secStr || 300);
     if (!TOKEN) { console.error("need API_TOKEN"); process.exit(2); }

     let events = 0, errors = 0, connected = 0;
     const controllers = [];

     async function openOne(i) {
       const ctrl = new AbortController();
       controllers.push(ctrl);
       try {
         const res = await fetch(`${BASE}/sensor/stream`, {
           headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
           signal: ctrl.signal,
         });
         if (!res.ok) { errors++; return; }
         connected++;
         const reader = res.body.getReader();
         const dec = new TextDecoder();
         while (true) {
           const { value, done } = await reader.read();
           if (done) break;
           const text = dec.decode(value, { stream: true });
           events += (text.match(/\ndata:|^data:/gm) || []).length;
         }
       } catch { errors++; }
     }

     const started = Date.now();
     const jobs = Array.from({ length: N }, (_, i) => {
       // stagger the ramp so the server is not hit by 20 handshakes at once
       return new Promise((r) => setTimeout(() => openOne(i).finally(r), i * 1500));
     });
     const timer = setInterval(() => {
       const s = Math.round((Date.now() - started) / 1000);
       console.log(`t=${s}s connected=${connected} events=${events} errors=${errors}`);
     }, 5000);

     setTimeout(() => {
       clearInterval(timer);
       controllers.forEach((c) => c.abort());
       console.log(JSON.stringify({ N, connected, events, errors,
         elapsed_s: Math.round((Date.now() - started) / 1000) }, null, 2));
       setTimeout(() => process.exit(0), 500);
     }, SECONDS * 1000);

     Promise.all(jobs).catch(() => {});
     ```
  2. With ingest running (SYS-02 fleet), open the SSE clients:
     ```powershell
     node tests\sse-load.mjs {BASE_URL} $env:API_TOKEN 20 300
     ```
  3. Cross-check event counts against rows written in the same window:
     ```powershell
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT count(*) FROM sensors WHERE timestamp > now() - interval '5 minutes';"
     ```
  4. Watch server CPU and memory for spike/leak as clients connect/disconnect repeatedly.
- **Expected result:** all clients connect; events are delivered continuously; event count is in the right order of magnitude for the ingest rate; no client is dropped before the timeout; server memory returns to baseline after clients disconnect.
- **Metrics to capture:** connected clients, events received, errors, server RSS before/during/after, CPU.
- **Pass/Fail rule:** G14 pass (≥20 concurrent clients, 0 % event loss on the aggregate; no server crash). Fail if clients are dropped or events stop while ingest continues.
- **Result:** [ ] Pass  [ ] Fail

---

## 5. Part B: Web Stress Tests

Run against the dashboard dev server (`npm run dev` → `{WEB_URL}`) unless stated. Keep the SUT healthy between tests.

### WEB-01 — Dashboard baseline (Lighthouse)

- **ID / Title:** WEB-01 — Baseline Lighthouse audit (cold load)
- **Purpose:** Establish the dashboard's baseline performance before any concurrent load; required reference for WEB-02/05.
- **Preconditions:** dashboard running; backend up; logged-out state (incognito); no other load.
- **Load profile:** single cold page load (mobile and desktop presets).
- **Steps:**
  1. Stop any other browsers to reduce noise.
  2. Run Lighthouse against the login page (and again, if possible, against the authenticated dashboard):
     ```powershell
     lighthouse {WEB_URL} --preset=desktop --output=json --output html `
       --output-path=tests\results\WEB-01-desktop --chrome-flags="--headless=new"
     lighthouse {WEB_URL} --output=json --output html `
       --output-path=tests\results\WEB-01-mobile --chrome-flags="--headless=new"
     ```
  3. Open the HTML reports and record Performance, FCP, LCP, TBT, CLS, TTI, Speed Index.
- **Expected result:** desktop Performance ≥ 80 and TTI ≤ 3.5 s on a dev build. (A production build via `npm run build && npm run preview` will score higher; note which you measured.)
- **Metrics to capture:** Performance score, FCP, LCP, TBT, CLS, TTI, Speed Index, total transfer size, main-thread work.
- **Pass/Fail rule:** G12 pass (Lighthouse Performance ≥ 80, mobile) and G13 pass (TTI ≤ 3.5 s, desktop). Record dev vs preview build.
- **Result:** [ ] Pass  [ ] Fail

### WEB-02 — Many concurrent dashboard users (real-time view)

- **ID / Title:** WEB-02 — 20 concurrent dashboard sessions with live updates
- **Purpose:** Confirm the dashboard and backend stay responsive with many users on the real-time view at once (this is WEB-01's baseline plus the browser's own cost).
- **Preconditions:** WEB-01 passed; ≥20 `loadtest_*` users; ingest running (SYS-02 fleet) so charts actually update.
- **Load profile:** ramp 0→20 browser contexts over 2 min, steady 20 for 5 min, ramp-down.
- **Steps:**
  1. `tests/web-concurrent.mjs` (Playwright) — each context logs in as its own user and holds the dashboard open while recording `performance` timings and console errors:
     ```javascript
     // tests/web-concurrent.mjs
     // Usage: node tests/web-concurrent.mjs {WEB_URL} 20 300
     import { chromium } from "playwright";
     const [web, nStr, secStr] = process.argv.slice(2);
     const WEB = web || "http://localhost:5173";
     const N = Number(nStr || 20);
     const SECONDS = Number(secStr || 300);
     const PASSWORD = "LoadTest#1234";

     const browser = await chromium.launch({ headless: true });
     const contexts = [];
     let errors = 0;

     async function runUser(i) {
       const ctx = await browser.newContext();
       contexts.push(ctx);
       const page = await ctx.newPage();
       page.on("console", (m) => { if (m.type() === "error") errors++; });
       page.on("pageerror", () => { errors++; });
       await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
       // Adapt selectors to the actual login form
       await page.fill('input[name="username"], #username', `loadtest_${i}`);
       await page.fill('input[name="password"], #password', PASSWORD);
       await page.click('button[type="submit"]');
       await page.waitForLoadState("networkidle").catch(() => {});
       // Stay on the dashboard for the duration
       await page.waitForTimeout(SECONDS * 1000);
       const t = await page.evaluate(() => {
         const nav = performance.getEntriesByType("navigation")[0];
         const paint = performance.getEntriesByName("first-contentful-paint")[0];
         return { domContentLoaded: nav?.domContentLoadedEventEnd, fcp: paint?.startTime };
       });
       console.log(`user ${i}: fcp=${Math.round(t.fcp || 0)}ms dcl=${Math.round(t.domContentLoaded || 0)}ms`);
     }

     const jobs = Array.from({ length: N }, (_, i) =>
       new Promise((r) => setTimeout(() => runUser(i + 1).finally(r), i * 3000))
     );
     await Promise.allSettled(jobs);
     console.log(JSON.stringify({ users: N, consoleErrors: errors }, null, 2));
     await browser.close();
     ```
  2. Run it with the ingest fleet active:
     ```powershell
     node tests\web-concurrent.mjs {WEB_URL} 20 300
     ```
  3. Monitor server CPU, DB connections, and SSE client count (SYS-10) during the run.
  4. Stop the fleet afterwards.
- **Expected result:** all sessions log in and render; charts update; console errors near zero; server CPU/RAM stay within G6/G7.
- **Metrics to capture:** FCP/DCL per user, console errors, login failures, server CPU/RAM peak, DB active connections, SSE clients.
- **Pass/Fail rule:** ≥90 % of sessions load and stay connected; console errors ≤ 5 total run-wide; G6/G7/G8 pass. Fail on widespread login failure or server overload.
- **Result:** [ ] Pass  [ ] Fail

### WEB-03 — Historical Data page: large ranges + exports

- **ID / Title:** WEB-03 — Large date-range history and PDF/CSV export
- **Purpose:** The Historical Data page is the heaviest client-side feature; prove it renders and exports a large range without freezing the tab.
- **Preconditions:** DB has a large history (§3.2); WEB-02 passed; one logged-in browser.
- **Load profile:** single user; repeated queries over progressively larger ranges; one export at the largest range.
- **Steps:**
  1. Log in and open the **Historical Data** page.
  2. In DevTools → Performance, start a recording.
  3. Select a **7-day** range, load it, note time-to-chart and whether the tab stays interactive (scroll/click while rendering).
  4. Select a **30-day** range (or the largest the UI allows), load it, note the same.
  5. Trigger the **PDF export** (jsPDF + autotable) and a **CSV export** if available; measure export duration and resulting file size.
  6. Stop the recording; read Long Tasks (>50 ms), Total Blocking Time, and scripting time.
  7. Cross-check the API side under a large range (server timing):
     ```powershell
     curl.exe -s -o NUL -w "history large range: %{http_code} %{time_total}s size=%{size_download}`n" `
       -H "Authorization: Bearer $env:API_TOKEN" `
       "{BASE_URL}/sensor?device_id=ESP32_01&limit=20000"
     ```
- **Expected result:** 7-day range renders within a few seconds; 30-day range may be slower but the tab must remain responsive (no crash, no "Page Unresponsive"); export completes (even if slow) and produces a valid file.
- **Metrics to capture:** time-to-chart per range, Long Task count and max duration, total export time, export file size, API `time_total` and payload size.
- **Pass/Fail rule:** 7-day range renders ≤ 5 s; 30-day range does **not** hang the tab (no unresponsive dialog) and completes ≤ 30 s; export succeeds. Fail on tab hang/crash or export failure.
- **Result:** [ ] Pass  [ ] Fail

### WEB-04 — Login / OTP under rapid attempts

- **ID / Title:** WEB-04 — Login and OTP throttling under rapid attempts
- **Purpose:** Confirm the brute-force guard behaves (locks out after 5 failed attempts) while **correct** logins are not penalised, and that the OTP/email flow is not trivially abusable.
- **Preconditions:** SUT running; a known valid account and a deliberate wrong password.
- **Load profile:** staged — (a) 5 wrong attempts, (b) 5 more, (c) 1 correct attempt, (d) OTP request burst.
- **Steps:**
  1. Fire failed logins and capture status codes:
     ```powershell
     ../../tests/k6/login-attempts.js
     ```
     Script:
     ```javascript
     // tests/k6/login-attempts.js
     import http from "k6/http";
     import { check } from "k6";

     const BASE = __ENV.BASE_URL || "http://localhost:3000";
     export const options = { vus: 1, iterations: 10, thresholds: {} };

     export default function () {
       const wrong = http.post(`${BASE}/auth/login`,
         JSON.stringify({ username: "loadtest_1", password: "definitely-wrong" }),
         { headers: { "Content-Type": "application/json" }, tags: { case: "wrong" } });
       check(wrong, { "401 or 429": (r) => r.status === 401 || r.status === 429 });
       console.log(`wrong -> ${wrong.status}`);
     }
     ```
     ```powershell
     k6 run -e BASE_URL=$env:BASE_URL tests\k6\login-attempts.js
     ```
  2. Immediately attempt a **correct** login (correct logins are not counted by the limiter):
     ```powershell
     curl.exe -s -o NUL -w "correct after failures: %{http_code}`n" -X POST {BASE_URL}/auth/login `
       -H "Content-Type: application/json" `
       -d '{"username":"loadtest_1","password":"LoadTest#1234"}'
     ```
     Expected: `200` (skipSuccessfulRequests means failed attempts only count).
  3. Request an **archive-approval** OTP repeatedly against an **active,
     non-owner test account** (replace the `1` below; the endpoint returns `400`
     for the owner or an already-archived target). Admin only; the code is
     emailed to the **owner**, so **email must be disabled** — with no
     `SMTP_HOST`, the server logs the code to console instead:
     ```powershell
     $body = @{ password = $env:ADMIN_PASSWORD; reason = "WEB-04 stress test" } |
       ConvertTo-Json -Compress
     for ($i=0; $i -lt 10; $i++) {
       curl.exe -s -o NUL -w "otp req $i: %{http_code}`n" -X POST `
         "{BASE_URL}/auth/users/1/deletion-request" `
         -H "Authorization: Bearer $env:API_TOKEN" -H "Content-Type: application/json" `
         --data-raw $body
     }
     ```
     A request without the admin password returns `400` before any OTP exists.
     Confirm codes arrive in the **server console**, not as real emails.
  4. After the run, check that the limiter window behaved:
     ```powershell
     # Examine server logs for rate-limit / 429 markers
     Select-String -Path tests\results\*.log -Pattern "429|Too many login" -ErrorAction SilentlyContinue
     ```
- **Expected result:** failed attempts return `401` up to the limit, then `429`; the subsequent correct login still returns `200`; OTP requests do not send real email in test mode; no server error.
- **Metrics to capture:** status code per attempt, first `429` at which attempt, correct-login status after failures, OTP responses.
- **Pass/Fail rule:** limiter returns `429` by the 6th failed attempt; a valid credential is accepted even after failures; **0** real emails/SMS. Fail if valid login is blocked by failed-attempt budget, or if OTP emails actually send.
- **Result:** [ ] Pass  [ ] Fail

### WEB-05 — Browser performance with large datasets

- **ID / Title:** WEB-05 — Rendering a large dataset without jank
- **Purpose:** Measure the client cost of rendering many chart points and table rows (Memory, Long Tasks, frame stability).
- **Preconditions:** DB has the 10× history (§3.2); WEB-01/03 complete.
- **Load profile:** single user; progressively larger datasets (1k → 10k → 100k points); one Lighthouse run in the loaded state.
- **Steps:**
  1. Open the dashboard's chart page and load the 1-day range; open DevTools → Performance + Memory.
  2. Record a timeline while interacting (hover, zoom, change range). Note Long Tasks and FPS.
  3. Repeat for 7-day and 30-day ranges.
  4. Take a heap snapshot after each load; look for detached DOM nodes / growing `JSArrayBuffer`/chart buffers.
  5. Run Lighthouse while the large dataset is on screen (authenticated session via `--chrome-flags` with a user-data-dir where you are logged in):
     ```powershell
     lighthouse {WEB_URL} --preset=desktop --output=json `
       --output-path=tests\results\WEB-05-loaded --chrome-flags="--headless=new"
     ```
  6. Record memory before/after navigating away from the chart page (React should release chart data).
- **Expected result:** the app remains interactive; Long Tasks are bounded (no multi-second main-thread block) at realistic ranges; memory does not grow without bound across range changes.
- **Metrics to capture:** Long Task count/max, FPS during interaction, JS heap size per range, Lighthouse Performance on the loaded page, detached-node count.
- **Pass/Fail rule:** no unresponsive tab; Lighthouse Performance on the loaded page ≥ 60 (relaxed vs baseline); JS heap stabilises after navigation (no monotonic growth across 3 range loads). Fail on tab hang or unbounded heap growth.
- **Result:** [ ] Pass  [ ] Fail

### WEB-06 — Backend slow / down: dashboard error states

- **ID / Title:** WEB-06 — Dashboard behaviour when the API is slow or down
- **Purpose:** Confirm the UI degrades gracefully (clear error/empty states, retry, no white screen) when the backend is unavailable or slow.
- **Preconditions:** a logged-in browser already on the dashboard; ability to stop the SUT and to throttle the network.
- **Load profile:** (a) API down for 60 s, (b) API restored, (c) API artificially slowed to ~3 s per request.
- **Steps:**
  1. With the dashboard open, stop the SUT (Ctrl+C in T1). Watch every page: Dashboard, Real-time, History, Settings, Logs.
     - Expected: a visible error/empty state or toast, **not** a blank/white screen. Browser console shows handled request failures, not uncaught exceptions.
  2. Restart the SUT; confirm the dashboard recovers on its own or via a retry/refresh (no need to clear cookies/re-login unless the session truly expired).
  3. Simulate latency in DevTools: Network → Throttling → **Custom** profile (e.g. 1500 ms latency, 400 kbps) or use a proxy. Re-load the dashboard and each page; confirm loading indicators appear and the UI does not appear frozen or fire duplicate/storming requests.
  4. Verify SSE reconnection: with the dashboard on the real-time page, stop and restart the SUT and confirm the stream reconnects (events resume) without a full page reload.
  5. Record any console errors and their frequency.
- **Expected result:** graceful error states and loading indicators on every page; automatic retry/reconnect; no white screen; no request storm (many retries per second).
- **Metrics to capture:** error-state presence per page (Y/N), time-to-recover after restart, number of console errors, number of repeated requests per action under throttling, whether SSE reconnected.
- **Pass/Fail rule:** every checked page shows a usable error/loading state; recovery after restart ≤ 60 s without clearing the session; SSE reconnects. Fail on white screen, uncaught exception storm, or no recovery.
- **Result:** [ ] Pass  [ ] Fail

---

## 6. Combined Test (Part A and Part B running simultaneously)

### COMBO-01 — Full-system stress: ingest + dashboard at the same time

- **ID / Title:** COMBO-01 — 48 req/s ingest + 20 dashboard users + 20 SSE subscribers + large history query
- **Purpose:** The realistic worst case: the database, the API, and the browser workload all compete at once. This is where contention and connection-pool exhaustion show up.
- **Preconditions:** SYS-03 ceiling ≥ 48 req/s established; WEB-01–06 complete; SMS off; test DB seeded with the large history; all terminals ready.
- **Load profile:** a single 15-minute run: ramp ingest 0→48 req/s (2 min), simultaneously ramp 20 browser users (3 min) and 20 SSE clients (1 min); at minute 8 fire one 30-day history query and one PDF export; hold everything to minute 14; ramp down.
- **Steps:**
  1. Start the SUT and the dashboard; confirm healthy.
  2. Launch ingest at 48 req/s:
     ```powershell
     Start-Job { k6 run -e BASE_URL=$env:BASE_URL -e DEVICE_SECRET=$env:DEVICE_SECRET -e RATE=48 -e DEVICE_COUNT=48 -e DURATION=13m tests\k6\ingest-staircase.js } | Out-Null
     ```
     (Or run in T3 and keep the terminal visible.)
  3. Launch 20 browser users in T4:
     ```powershell
     node tests\web-concurrent.mjs {WEB_URL} 20 780
     ```
  4. Launch 20 SSE clients in T5:
     ```powershell
     node tests\sse-load.mjs {BASE_URL} $env:API_TOKEN 20 720
     ```
  5. At ~minute 8, in a new terminal, run the large history query and record its latency:
     ```powershell
     curl.exe -s -o NUL -w "combo history: %{http_code} %{time_total}s`n" `
       -H "Authorization: Bearer $env:API_TOKEN" `
       "{BASE_URL}/sensor?device_id=ESP32_01&limit=20000"
     ```
  6. Monitor continuously: server CPU/RAM, `pg_stat_activity` (active + waiting), k6 p95, dashboard responsiveness.
     ```powershell
     psql -U {PGUSER} -d {DB_NAME} -c "SELECT state, wait_event_type, count(*) FROM pg_stat_activity WHERE datname='crayvings_stress_test' GROUP BY 1,2 ORDER BY 3 DESC;"
     ```
  7. After the run, reconcile ingest data loss:
     ```powershell
     # k6 writes no per-post log; instead compare k6 max-VUs/desired rate against rows/sec,
     # or run ingest via the fleet with --log for exact accounting:
     tools\fleet.ps1 -Count 48 -Interval 1000 -Log tests\results\COMBO-01.jsonl
     node tools\count-jsonl.cjs tests\results\COMBO-01.jsonl
     ```
- **Expected result:** the system stays up; ingest p95 may rise but G2 still holds or is reported as the first breach; reads stay usable; the dashboard does not crash; DB pool does not exhaust. Contention is visible as higher latency, not as errors/loss.
- **Metrics to capture:** ingest p95/p99 + error rate, read p95, DB active/waiting connections, server CPU/RAM peak, dashboard console errors, SSE event delivery, large-query latency, rows written vs accepted.
- **Pass/Fail rule:** G1–G5 and G8 pass concurrently. It is acceptable for latencies to rise; it is **not** acceptable for errors or data loss to appear. Fail on any 5xx storm, DB connection exhaustion, data loss, or dashboard crash.
- **Result:** [ ] Pass  [ ] Fail

---

## 7. Monitoring and Metrics to Record

### 7.1 What to watch, where, and how

| Layer | Metric | How to capture |
|-------|--------|----------------|
| API | p50/p95/p99, RPS, error rate per endpoint | k6 summary output (`http_req_duration`, `http_req_failed`); note per-endpoint tags |
| API | CPU %, RSS (private working set) | Task Manager (Details → `node.exe`) or `htop`; sample at steady state and peak |
| API | Connection-pool saturation | `pg_stat_activity`; also watch server logs for pool timeouts |
| API | Event-loop lag (optional) | `node --trace-gc` or a clinic.js/`0x` profile on a **copy** of the server |
| DB | Active/idle/waiting connections | `SELECT state, wait_event_type, count(*) FROM pg_stat_activity ...` |
| DB | Insert throughput (tps) | pgbench `tps`; rows/sec from `sensors` counts |
| DB | Table/index size | `pg_total_relation_size('sensors')`, `pg_size_pretty(...)` |
| DB | Query plans | `EXPLAIN (ANALYZE, BUFFERS)` on the large-range query |
| DB | Slow queries | `log_min_duration_statement` (optional) or `pg_stat_statements` if installed |
| Ingest | Accepted vs stored | `tools/count-jsonl.cjs` vs `SELECT count(*)` in the window |
| Device | Posts/sec, gaps | mock JSONL log; server logs |
| Device | Heap, resets | serial log (SYS-09) |
| Real-time | SSE clients, events | `tests/sse-load.mjs` periodic output |
| Alerts | Alert rows, SMS attempts/sends, breaker state | `system_logs`, `sms_logs`, `GET /alert/sms-health` |
| Web | Lighthouse scores, TTI, LCP, CLS | Lighthouse HTML/JSON reports |
| Web | Console errors, FCP, Long Tasks, heap | Playwright script output; DevTools Performance/Memory |
| Web | Recovery after downtime | WEB-06 timings |

### 7.2 Sampling cadence

- **Baseline tests (SYS-01/02):** sample CPU/RAM every 30 s.
- **Ramp tests (SYS-03, COMBO-01):** sample every 15 s and at every stage transition.
- **Endurance (SYS-09):** sample hourly.

A simple sampler you can run alongside any test:

```powershell
# tools/sample.ps1 — prints node RSS (MB) + CPU% + pg activity every 15s
if (-not $env:DB_NAME) { $env:DB_NAME = "crayvings_stress_test" }
while ($true) {
  $p = Get-Process node -ErrorAction SilentlyContinue | Sort-Object WS -Descending | Select-Object -First 1
  if ($p) {
    $rss = [math]::Round($p.WorkingSet64/1MB,1)
    $cpu = [math]::Round($p.CPU,1)
    $t = (Get-Date).ToString("HH:mm:ss")
    Write-Host "$t node pid=$($p.Id) rss=${rss}MB cpuSec=$cpu"
  } else { Write-Host "no node process" }
  Start-Sleep -Seconds 15
}
```

```powershell
tools\sample.ps1
```

---

## 8. Results Recording Template

Copy these tables into a results file (e.g. `tests/results/RESULTS-{YYYY-MM-DD}.md`) and fill them in **as you go**.

### Table 8.0 — Environment and starting snapshot

| Field | Value |
|-------|-------|
| Date / time | |
| Tester | |
| SUT host CPU / RAM | |
| Load-gen host CPU / RAM | |
| Same machine? | Yes / No |
| Node version | |
| PostgreSQL version | |
| Build measured (dev / `vite preview`) | |
| SMS disabled confirmed (§2.6) | Yes / No |
| `sms_logs` non-failed count before run | |
| `sensors` rows before run | |
| `devices` rows before run | |
| `sensors` table size before run | |

### Table 8.1 — Threshold results (fill measured value)

| ID | Metric | Threshold | Measured | Pass? |
|----|--------|-----------|----------|-------|
| G1 | Ingest success rate | ≥ 99.0 % | | [ ] |
| G2 | Ingest p95 | ≤ 500 ms | | [ ] |
| G3 | Read p95 | ≤ 1500 ms | | [ ] |
| G4 | Read error rate | ≤ 1.0 % | | [ ] |
| G5 | Data loss | 0 rows | | [ ] |
| G6 | API CPU peak | ≤ 80 % | | [ ] |
| G7 | API RSS growth (30 min) | < 50 MB | | [ ] |
| G8 | DB connections | ≤ 20 | | [ ] |
| G9 | DB insert throughput | ≥ 200 rows/s | | [ ] |
| G10 | Watchdog resets | 0 | | [ ] |
| G11 | ESP32 heap drift | ≥ 0 / < 10 KB/h | | [ ] |
| G12 | Lighthouse mobile | ≥ 80 | | [ ] |
| G13 | TTI desktop | ≤ 3.5 s | | [ ] |
| G14 | SSE fan-out | ≥ 20 clients, 0 % loss | | [ ] |
| G15 | Real SMS sent | 0 | | [ ] |
| G16 | Recovery time | ≤ 60 s | | [ ] |

### Table 8.2 — Per-test summary

| Test ID | Title | Load profile | Key metric | Result | Evidence file |
|---------|-------|--------------|------------|--------|---------------|
| SYS-01 | Baseline ingest | 1 dev @ 1/s, 5 min | p95 | | `tests/results/SYS-01/` |
| SYS-02 | Nominal fleet | 6 dev @ 1/s, 10 min | rows / errors | | |
| SYS-03 | Ingest staircase | 6→96 req/s | max sustained rate | | |
| SYS-04 | Read load | 50 VUs, 10 min | p95 reads | | |
| SYS-05 | DB stress | pgbench 1→20 clients | tps, query time | | |
| SYS-06 | Wi-Fi drop/reconnect | 60 s offline + burst | backlog 201s | | |
| SYS-07 | Server downtime | 45 s down | recovery time | | |
| SYS-08 | SMS/alert flood | 180 breaches | SMS sent | | |
| SYS-09 | ESP32 endurance | 8 h @ 1/s | resets, heap | | |
| SYS-10 | SSE fan-out | 20 clients, 5 min | events/errors | | |
| WEB-01 | Lighthouse baseline | 1 cold load | score/TTI | | |
| WEB-02 | Concurrent users | 20 users, 5 min | console errors | | |
| WEB-03 | History + export | 7/30-day range | time-to-chart | | |
| WEB-04 | Login/OTP throttle | 10 attempts | first 429 | | |
| WEB-05 | Large dataset render | 1k→100k points | Long Tasks, heap | | |
| WEB-06 | Slow/down API | down 60 s | recovery | | |
| COMBO-01 | Full system | all at once | G1–G5, G8 | | |

### Table 8.3 — Per-stage ingest detail (SYS-03 / COMBO-01)

| Stage | Target req/s | Devices | Achieved req/s | p95 (ms) | p99 (ms) | Error % | Rows written | CPU % peak | RSS peak (MB) |
|-------|--------------|---------|----------------|----------|----------|---------|--------------|------------|----------------|
| 1 | 6 | 6 | | | | | | | |
| 2 | 12 | 12 | | | | | | | |
| 3 | 24 | 24 | | | | | | | |
| 4 | 48 | 48 | | | | | | | |
| 5 | 96 | 64 | | | | | | | |

### Table 8.4 — Data-loss reconciliation

| Test | Accepted (2xx) | DB rows added | Difference | Loss? |
|------|----------------|---------------|------------|-------|
| SYS-01 | | | | [ ] |
| SYS-02 | | | | [ ] |
| SYS-06 | | | | [ ] |
| SYS-07 | | | | [ ] |
| COMBO-01 | | | | [ ] |

### Table 8.5 — Database detail

| Test | pgbench tps (per client count) | Large-query time | Plan (Index/Seq scan) | sensors size after |
|------|-------------------------------|------------------|------------------------|--------------------|
| SYS-05 | 1: __ 4: __ 10: __ 20: __ | | | |
| COMBO-01 | | | | |

### Table 8.6 — Web detail

| Test | Performance score | TTI | LCP | CLS | Console errors | Notes |
|------|-------------------|-----|-----|-----|----------------|-------|
| WEB-01 (mobile) | | | | | | |
| WEB-01 (desktop) | | | | | | |
| WEB-02 | | | | | | |
| WEB-03 (7d / 30d) | | | | | | |
| WEB-05 (loaded) | | | | | | |
| WEB-06 | | | | | | |

### Table 8.7 — Failure log (one block per failure)

```
Test ID:            <e.g. SYS-03 stage 5>
Observed:           <what happened>
Expected:           <what should have happened>
Evidence:           <file / log excerpt / screenshot path>
Suspected cause:    <hypothesis>
Reproduced?         Yes / No, N times
```

---

## 9. Analysis and Interpretation Guide

### 9.1 Reading the numbers

- **Percentiles, not averages.** p95/p99 expose the tail users actually feel. An average of 80 ms with a p99 of 4 s is a bad result.
- **Latency shape over time.** If p95 rises linearly with elapsed time (not load), suspect a leak or missing index; if it rises with load and plateaus, you have found capacity.
- **Errors vs latency.** A ramp where latency climbs and then errors appear is the classic knee. The load just before errors is your realistic capacity.
- **Rows written vs accepted.** Any shortfall = data loss (G5). Check for `429` from the per-device limiter (a limiter hit is *not* data loss — the post was rejected before storage and must be reported separately).
- **CPU/RAM.** Sustained CPU near 100 % of a core, or RSS that only ever grows across a run, is a scaling/leak signal — cross-check SYS-09 and a long SYS-04.

### 9.2 Common findings and what they mean

| Symptom | Likely cause | Next step |
|---------|--------------|-----------|
| p95 spikes at a specific stage then recovers | Garbage collection / peak churn | Re-run; check `--trace-gc`; validate RAM growth (G7) |
| `429` at low load | Per-device ingest limiter (12/s/device) or global 300/min/IP limiter | Spread across device_ids / VUs; confirm it is the limiter, not a fault |
| `500` on reads under load | DB connection-pool exhaustion (pool `max` = 20) or a slow query | Check `pg_stat_activity`; check `EXPLAIN`; consider indexing |
| p95 climbs only after history grows | Missing/stale index on `sensors(timestamp)` | Verify `idx_sensors_timestamp` exists; run `EXPLAIN ANALYZE` |
| Dashboard janky only with 30-day data | Too many chart points rendered client-side | Confirm with Long Tasks; not a server issue |
| Data loss after downtime | Posts during downtime received no `2xx` (expected) vs lost `201`s (bug) | Separate `status:0` counts from `201` counts |
| SSE clients dropped | Server closed stream, proxy timeout, or auth expiry | Check server logs; verify heartbeat interval |
| SMS actually sent | `HTTPSMS_API_KEY`/`FROM` not actually empty | Stop, unplug gateway, re-check §2.5/§2.6 |

### 9.3 Interpreting the SYS-03 / COMBO-01 curve

- **Pass through 48 req/s:** the system covers production (6 devices @ 1/s = 6 req/s) with ~8× headroom.
- **Breach at 24 req/s:** investigate DB writer and pool sizing before deployment.
- **Breach only at 96 req/s:** acceptable for this capstone scale; document the ceiling.

### 9.4 What "GREEN" requires

All of G1–G16 pass, **or** every failing threshold has an entry in Table 8.7 with a documented, accepted rationale (e.g. "single-machine load generator shared with SUT inflates CPU; re-run on separate host recommended"). An unexplained failure is never acceptable.

### 9.5 Report skeleton

```
1. Environment (Table 8.0)
2. Threshold scorecard (Table 8.1) — GREEN / RED
3. Per-test results (Table 8.2)
4. Capacity findings (max sustainable ingest rate, DB insert ceiling)
5. Data-loss reconciliation (Table 8.4)
6. Web performance (Table 8.6)
7. Failures and evidence (Table 8.7)
8. Recommendations (indexing, pool size, rate-limit tuning, dashboard down-sampling)
```

---

## 10. Cleanup and Rollback

Run these after the test session, **always on the throwaway test DB**.

### 10.1 Stop all load actors

| Terminal | Action |
|----------|--------|
| T1 | Ctrl+C the SUT (`node server.cjs`) |
| T2 | Ctrl+C the dashboard (`npm run dev`) |
| T3–T5 | Ctrl+C any k6 / node / fleet process |
| Any background jobs | `Get-Job | Stop-Job; Get-Job | Remove-Job` |

Kill leftover Node load processes if any survive:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*node*" } | Select-Object Id, StartTime, WorkingSet64
# Review the list, then stop only the load processes you started:
# Stop-Process -Id <ID>
```

Stop the resource sampler job/window if still running.

### 10.2 Remove test rows from the test DB

```sql
-- db/cleanup_stress.sql  (test DB only!)
DELETE FROM sensors WHERE device_id LIKE 'ESP32_%' OR device_id LIKE 'pgbench_%';
DELETE FROM devices WHERE device_id LIKE 'ESP32_%' OR device_id LIKE 'pgbench_%';
DELETE FROM system_logs WHERE device_id LIKE 'ESP32_%';
DELETE FROM sms_logs WHERE created_at > now() - interval '24 hours';
DELETE FROM users WHERE username LIKE 'loadtest_%';
```

```powershell
psql -U {PGUSER} -d {DB_NAME} -f db\cleanup_stress.sql
```

> Check `TESTING_GUIDE.md` Phase C.6 before running any cleanup that writes to a **live** `devices` table. `test:devices` and `test:secrets` write to the live table — keep test suites pointed at the throwaway DB.

### 10.3 Drop the throwaway database (recommended)

```powershell
# Terminate connections first, then drop
psql -U {PGUSER} -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='crayvings_stress_test';"
psql -U {PGUSER} -c "DROP DATABASE IF EXISTS crayvings_stress_test;"
```

### 10.4 Restore the real environment

1. **Reset the shell environment** in every terminal — especially:
   ```powershell
   Remove-Item Env:HTTPSMS_API_KEY, Env:HTTPSMS_FROM, Env:DELTA_LOGGING_ENABLED, `
     Env:PG_DATABASE, Env:SENSOR_RETENTION_DAYS, Env:SYSTEM_LOGS_RETENTION_DAYS, `
     Env:ACTIVITY_LOGS_RETENTION_DAYS, Env:DEBUG -ErrorAction SilentlyContinue
   ```
   (On Windows, just closing all test terminals also clears these.)
2. **Re-enable the SMS gateway** only if it is genuinely time to resume real alerting — and only after confirming the test did not leave a flood queued.
3. **Do not** leave `DELTA_LOGGING_ENABLED=false` in any persistent config; it was a shell-only override.
4. Confirm the production `.env` was never edited:
   ```powershell
   git status --short
   ```
   ` .env` must not appear as modified.
5. Keep `tests/results/` for your report; it is safe to archive.

### 10.5 Rollback of any accidental changes

- If you edited `.env` (you should not have), restore it: `git checkout -- .env` (only if it is tracked and unmodified in git; otherwise restore from your own backup).
- If a migration was run against the wrong DB, **stop** and restore from a backup — do not attempt to "fix" schema by hand.
- If real SMS was sent (should be impossible), note the count and cost in Table 8.7 and disable the gateway immediately.

---

## 11. Risks and Safety Notes

### 11.1 Absolute rules

1. **Never run any of this against production or a valued database.** All destructive steps (§10.2/10.3) assume a throwaway DB.
2. **Never send real SMS.** Keep `HTTPSMS_API_KEY`/`HTTPSMS_FROM` empty and **physically disconnect the HTTPSMS gateway phone**. Confirm `sms_logs` non-failed count does not increase during the run. SMS costs real money and can spam a real operator.
3. **Never send real email.** Leave `SMTP_HOST` unset in the test shell (or point it at a local mail trap); use `DEV_OTP_CONSOLE_FALLBACK` so OTP codes print to the console.
4. **Never edit or commit `.env`, `.env.new`, or any secret.** Use shell overrides only.
5. **Never delete `node_modules/` or regenerate `package-lock.json`.**
6. **Never run a structural migration without confirming the target DB** with the owner.
7. **Never `git push`, force-push, reset --hard, clean, or rebase** as part of testing.

### 11.2 Load-testing risks and mitigations

| Risk | Mitigation |
|------|------------|
| Load generator starves the SUT on a shared machine | Prefer a second host; if not possible, record it and interpret with the caveat |
| Loopback hides Wi-Fi latency | State clearly that this tests the server, not the radio; a separate SYS test (real ESP32) covers radio |
| Hitting the per-IP global limiter (300/min) and misreading `429` as failure | Throttle to stay under it, or temporarily raise it in a **test-only** server start and record that you did |
| Per-device ingest limiter (12/s) trips on a burst test | Spread across device_ids; the 12/s guard exists for offline-buffer flushes |
| DB disk fills during long/high-rate runs | Watch disk space; cap run duration; `SENSOR_RETENTION_DAYS=0` means nothing is purged during the test |
| Test data left in a shared DB | Always clean up (§10) and drop the throwaway DB |
| Re-login invalidates other sessions | One account per concurrent user (§3.3) |
| `DELTA_LOGGING_ENABLED=false` produces huge tables | Intended for exact counts; keep runs short and the DB throwaway |
| Endurance run keeps a real board posting to a real DB | Point the board at the test API, or use the simulator for the server side |
| Watchdog/heap issues damage test hardware | Use a spare board; monitor temperature; never run endurance unattended overnight on a shared PC |

### 11.3 Data-protection notes

- The `sensors` table is the only record of a tank's history. In the test DB that is disposable; in production it is not.
- `devices` uses two distinct concepts — **hide** (`is_active=false`, reversible) and **archive** (`archived_at` set, terminal). Tests must not archive real devices.
- Failed sensors store **`NULL`**, never `0` or a sentinel. When validating results, treat `null` as "no signal" — do not count it as a zero reading.
- Any snapshot/backfill or extra history seeded for the test must be clearly labelled (`ESP32_*`, `pgbench_*`, `ZZTEST_*`) so it is easy to remove.

### 11.4 Stop conditions (abort immediately if any occur)

1. Any real SMS is delivered.
2. The API or DB returns persistent `5xx` at baseline rates (SYS-01/SYS-02), suggesting a real defect rather than load.
3. Data loss (`G5` fail) at a stage that previously passed.
4. Database disk usage approaches the machine's free-space limit.
5. The SUT machine overheats or the load generator cannot keep its own process alive.
6. You realise the test is pointed at the wrong database.

When aborting: stop all actors, run §10 cleanup, and document the abort in Table 8.7.

---

*End of procedure.*
