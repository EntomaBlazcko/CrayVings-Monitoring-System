# Testing Guide

Everything needed to verify the CRAYvings monitoring system, in one file. There are
five tiers, and you only need the ones your current change touches:

| Part | What it proves | Hardware | Server | Postgres |
|---|---|---|---|---|
| **1. Static checks** | The tree compiles, lints, and has no stale references | no | no | no |
| **2. Mock simulator** | The whole data → alert → SMS → PDF pipeline | no | yes | yes |
| **3. Ten-device fleet** | Multi-tank surfaces, alerting, poller concurrency | no | yes | yes |
| **4. Star topology** | Migration 007, per-tank scoping, firmware, a real LAN | yes | yes | yes |
| **5. Automated suites** | The 7 `npm test` scripts, incl. `npm run test:all` | no | some | some |

Parts 1 and 2 are the fast loop. Part 4 needs a physical ESP32 and is the only
tier that can validate firmware.

---

## How to use this file

- Work top to bottom within the part you need. Parts 1–3 can be run any time;
  Part 4 is hardware-gated and its steps are individually deferred if you lack
  the hardware.
- Each step has a `[ ]` checkbox. Log actual output next to `=>`.
- Steps that write to the live database are marked `[ADMIN]`.
- All curl examples are Windows PowerShell 5.1 friendly (`curl.exe`). The commands
  are plain enough to translate to bash if you prefer.

### Prerequisites

Anything checked that you do **not** have yet just means that step is deferred —
the guide is written so software checks come first.

- [ ] Node.js 18+, PostgreSQL 15+, deps installed (`npm install`)
- [ ] `.env` present with `PG_*` set (see `.env.example`)
- [ ] For a hardened run: `DEVICE_SECRET` set in `.env`
- [ ] Arduino IDE with ESP32 core + ESPAsyncWebServer + AsyncTCP (Part 4 only)
- [ ] At least one ESP32 + DS18B20 + HC-SR04 + MQ-137 wired (Part 4 only)
- [ ] Router/AP, ideally configurable to `192.168.4.0/24` (Part 4 Phase F only)

### Authenticating your curl commands

> **Important.** `POST /auth/login` no longer returns a token in the response
> body — it sets an `HttpOnly` cookie and returns only the public profile. So
> `$r.token` is always empty. Log in once and reuse the cookie jar:

```powershell
$u="YOUR_OWNER_USERNAME"; $p="YOUR_PASSWORD"
$body = '{"username":"'+$u+'","password":"'+$p+'"}'
curl.exe -s -c cookies.txt -X POST http://localhost:3000/auth/login `
  -H "Content-Type: application/json" -d $body
# then add  -b cookies.txt  to every authenticated call below
```

Two other things worth knowing:

- Every endpoint in this guide except `POST /sensor` and `POST /auth/login` uses
  `requireAuth`. Commands marked `[ADMIN]` additionally need an owner/admin
  account.
- `POST /sensor` uses the **device** secret, not a user session: header
  `X-Device-Secret`. It is only required if `DEVICE_SECRET` is set in `.env`;
  otherwise any registered `device_id` may post.
- Repeated failed logins trip a rate limiter at **5 attempts per IP per 15 min**.
  If a login returns `429`, wait out the window — that is not a regression.

---

## Part 1 — Static checks (no DB, no server)

**Purpose:** prove the code compiles and still lints before anything runs.

### 1.1 Lint

```bash
npm run lint
```

`=>` no errors (exit 0, empty output)

### 1.2 Build

```bash
npm run build
```

`=>` "built in Xs" (`dist/` regenerates). This is `tsc -b && vite build`, so a
type error fails here rather than in the browser.

### 1.3 Encoding guard

```bash
npm run check:encoding
```

`=>` clean. Cheap, and it catches mojibake / smart-quote damage in text files
before it reaches a merge conflict.

### 1.4 No stale single-server IP in the application

The system moved from one hardcoded server to a star topology, so no application
code or config should still name the old server's LAN address:

```bash
rg "192\.168\.100\.152" server.cjs src services db scripts
```

`=>` no matches.

> Check the **full** address, not the `192.168.100` prefix. The prefix survives
> legitimately in IPv4 validation messages (`server.cjs:888`,
> `src/pages/DevicesPage.tsx:63`) and in `tests/devices.cjs`, where any private
> address is a valid fixture — grepping the bare prefix matches those and reports
> a failure that does not exist.

### 1.5 New source files exist

```bash
ls services\devicePoller.cjs
ls db\migrations\007_multi_device.cjs
ls src\components\TankSelector.tsx
ls src\components\FarmOverview.tsx
```

`=>` four files present. (The fleet overview component is `FarmOverview.tsx`;
it was once called `FleetGrid.tsx` and no longer exists under that name.)

---

## Part 2 — Mock simulator (no hardware)

The dashboard, alerting, SMS and PDF pipeline all get their data from one
endpoint: `POST /sensor`. `scripts/mock-device.js` speaks that same protocol, so
you can develop, demo and test the entire system with no physical ESP32 on the
desk.

This is a development and demonstration tool. It is **not** a substitute for
testing real firmware.

### 2.1 Quick start

**Terminal 1 — backend:**

```bash
npm run server
```

**Terminal 2 — frontend:**

```bash
npm run dev
```

**Terminal 3 — simulated tank:**

```bash
npm run mock
```

Leave the third window running. The dashboard fills with live readings and stays
on "Tank Safe". Press `Ctrl+C` in that window to stop.

The default device is `ESP32_03 Mock Device` — a third tank, alongside the real
`ESP32_01` and `ESP32_02` hardware. If your database has no such device, it is
created automatically on the first post (see *2.6 Device registration*).

### 2.2 The sensor contract

| | |
|---|---|
| **Endpoint** | `POST /sensor` |
| **Auth** | header `X-Device-Secret: <DEVICE_SECRET>` |
| **Body** | JSON |

```json
{
  "device_id":   "ESP32_01",              // required; auto-registers if unknown
  "temperature": 27.5,                    // > 0 valid
  "water_level": 78,                      // >= 0 valid
  "ammonia":     0.35,                    // >= 0 valid, optional
  "read_at":     "2026-09-26T08:00:00Z"   // optional device-side timestamp
}
```

Limits enforced by the server (`sensorSchema` in `server.cjs`):

| Field | Range |
|---|---|
| `temperature` | −127 .. 50 |
| `water_level` | −1 .. 100 |
| `ammonia` | −1 .. 500 |

### 2.3 Failed-sensor sentinels

A probe that fails does not report 0 — it reports a sentinel, and the server
stores `NULL` instead so failed sensors never pollute the time-series data:

| Field | Sentinels | Stored as | Cause |
|---|---|---|---|
| `temperature` | `-1`, `0` (anything `<= 0`) | `NULL` | DS18B20 fault code / no response. The farm is tropical, so the server treats every non-positive temperature as a failure (`readingOrNull`, `server.cjs:805-810`) |
| `water_level` | `-1` | `NULL` | HC-SR04 no echo |
| `ammonia` | `-1` | `NULL` | MQ-137 no signal |

The dashboard renders `NULL` as a grey **"No signal"** pill plus the explanation
"Sensor not reporting". That is deliberately **not** an amber "Warning": a dead
probe is a hardware fault, and showing it as a water-quality warning sends you
hunting for a problem that does not exist.

**Rate limit:** 12 posts per second per `device_id`. Do not go below ~100 ms.

### 2.4 Scenario profiles

List them at any time:

```bash
npm run mock:profiles
```

| Profile | Devices | What it does |
|---|---|---|
| `healthy` | 1 | Baseline. Gentle diurnal drift, stays in the safe range. Use this while working on anything else — it should never raise an alert |
| `warming` | 1 | Temperature ramps 25 °C → 34 °C over 14 cycles. Against the intended 20–31 °C range this produces a WARNING and then a CRITICAL. Shows the alarm, the persistent banner and the "How to fix" guidance |
| `ammonia_spike` | 1 | Ammonia ramps 0.32 → 4.2 ppm over 8 cycles. Ammonia is the fastest-acting toxin for crayfish, so this is the scenario that best demonstrates why the persistent critical banner exists: the alarm must outlive the 5-second floating toast |
| `low_water` | 1 | Water level falls 80% → 4%, breaching the 10% minimum |
| `failed_ammonia` | 1 | The ammonia probe dies at cycle 8 and sends `-1` from then on. Proves a dead sensor reads "No signal" rather than a false warning |
| `all_sensors_fail` | 1 | Every probe dies at cycle 5 — three "No signal" cards. Simulates a drained tank or an ESP32 powered off mid-read |
| `disconnect` | 1 | Posts 10 times, then goes silent on its own. After the 30-second heartbeat window the dashboard flips to the offline banner while still showing the last readings |
| `fleet` | 2 | `ESP32_01` healthy + `ESP32_02` warming, staggered 2.5 s apart. Exercises the fleet view, the per-tank alarm badge and the "N tanks affected" banner. Needs two registered devices |
| `fleet10` | 10 | Six healthy + warming + ammonia spike + dead probe + disconnect. The full software rehearsal of a ten-tank buildout — see **Part 3** |

### 2.5 Command line options

```bash
node scripts/mock-device.js [options]
```

| Option | Description |
|---|---|
| `-d, --device <id>` | Device to simulate. Repeatable. Default: `ESP32_03 Mock Device` |
| `-p, --profile <name>` | Scenario profile. Default: `healthy` |
| `-i, --interval <ms>` | Override the post interval. Wins over the profile's own cadence. Default: `5000` |
| `-n, --cycles <n>` | Stop after n posts per device. Default: run until `Ctrl+C` |
| `--ramp-to <value>` | Override the profile's ramp target, e.g. `--ramp-to 40` to push a temperature scenario further |
| `--log <file>` | Append every post to a JSONL file for replay or analysis. e.g. `--log logs/mock-run.jsonl` |
| `--api <url>` | Override the API base. Default: `http://localhost:3000` |
| `--secret <s>` | Override `X-Device-Secret` |
| `-l, --list-profiles` | Show profiles and exit |
| `--list-devices` | Show devices registered on the API and exit |
| `--show-config` | Print the resolved config for the chosen profile |
| `-h, --help` | Full help |

`npm run mock -- <options>` is equivalent to the node command above.

### 2.6 Device registration

The `device_id` must exist in the `devices` table before its **first** post,
because that is where the server resolves per-tank thresholds.

If it does not exist, the ingest upsert creates it automatically with
`registered_via='auto'`, and the Devices page shows an **Auto-discovered** badge
until an admin claims it. Registering up front avoids that extra step and is
what you want for a fleet (see **3.2**).

To see what is registered:

```bash
npm run mock -- --list-devices
```

The `devices` table has columns for `device_id`, `name`, `tank_name`,
`tank_location`, `is_active` and `device_secret`. Give each tank a friendly
`tank_name` and location so the dashboard's fleet views and the exported PDF
identify them properly.

**Auth:** the mock uses the shared `DEVICE_SECRET` from `.env`. A device may
instead have its own `device_secret`, in which case pass it with `--secret`.

### 2.7 Important: check your thresholds first

The scenarios are tuned to the **intended** safe range, which is defined in
`src/types/index.ts` (`DEFAULT_SETTINGS`):

| Parameter | Intended safe range |
|---|---|
| `temperature` | 20 – 31 °C |
| `water_level` | 10 – 100 % |
| `ammonia` | 0.25 – 1.0 ppm |

Severity is a function of *how far* outside the range a value is, not merely
whether it is outside it (`getThresholdStatus`, `src/types/index.ts:286`): past
the range is a **warning**, past the range by **15% of its width** is
**critical**. So the exact moments a default-configured run flips are:

| Scenario | Warning | Critical | Ramp completes |
|---|---|---|---|
| `warming` (25 → 34 °C, 14 cycles) | > 31 °C, from cycle 9 (31.4 °C) | ≥ 32.65 °C, from cycle 11 | cycle 14 (34 °C) |
| `ammonia_spike` (0.32 → 4.2 ppm, 8 cycles) | never — the window between 1.00 and 1.11 ppm is too narrow for a 5 s step to land in | ≥ 1.11 ppm, from cycle 3 (1.55 ppm) | cycle 8 (4.2 ppm) |

`ammonia_spike` therefore goes **straight from OK to CRITICAL**, with no amber
phase. That is expected, not a missed warning: ammonia is fast-acting enough
that a 5 s cadence overshoots the 0.11 ppm warning band entirely.

Ramp values use a smoothstep easing (`mock-device.js:174-176`), so the curve is
not linear — the table above is the real output, useful for telling "still
climbing" apart from "stuck".

Check what your database currently holds:

```bash
npm run mock -- --show-config
```

If `temp_max` has been edited to something like `49.9`, the `warming` scenario
will **not** trip an alert, because 34 °C is comfortably inside that limit. A
49.9 °C ceiling is not a safe operating limit for crayfish — water that hot kills
the stock within minutes — so treat that as a configuration bug and set it back
to 31 via Settings.

### 2.8 Recipes

**Prove the critical alarm persists (the headline behaviour)**

```bash
npm run mock -- --profile ammonia_spike --interval 2000
```

*Watch:* the red CRITICAL banner appears within ~3 cycles, names the tank and
value, and is still there a minute later. It only clears when ammonia recovers.

**Show a dead probe is not a water problem**

```bash
npm run mock -- --profile failed_ammonia --interval 1000
```

*Watch:* the dashboard shows a grey "No signal" pill on the ammonia card with
"Sensor not reporting — check wiring and that the ESP32 is online".

**Show the offline state**

```bash
npm run mock -- --profile disconnect
```

*Watch:* after the 10th post the device stops. Wait ~30 s and the dashboard
shows the amber offline banner plus "last known readings".

**Two tanks, one going wrong**

```bash
npm run mock -- --profile fleet --interval 2000
```

*Watch:* the sidebar Alerts badge counts the affected tanks, and the banner
reports how many tanks are in alarm.

**Run a short burst for a quick screenshot**

```bash
npm run mock -- --profile ammonia_spike --cycles 15 --interval 1500
```

Takes about 25 seconds.

**Capture everything to a file for later**

```bash
npm run mock -- --profile healthy --log logs/mock-run.jsonl
```

### 2.9 Notes and limits

- The mock uses the server's clock. `read_at` is deliberately omitted so the
  server timestamps each row, which keeps the time series clean.
- Values are rounded the way the real firmware rounds them: temperature to
  0.1 °C, water level to whole percent, ammonia to 0.01 ppm.
- The dashboard is a single-page app that holds no data of its own, so you can
  stop and start the mock freely. Readings already sent stay in the database and
  will appear in the charts and reports.
- Because historical data accumulates, a long mock run fills the history charts
  with simulated points. Use the Logs page if you need to isolate real hardware
  readings from simulated ones.
- Sending does **not** require the SSE stream to be healthy, so this is also the
  easiest way to reproduce the "backend unreachable" state.
- `scripts/mock-device.config.js` holds the profiles as plain data. Adding one
  needs a description, base readings and an interval; optionally `noise` (random
  walk), `drift` (slow trend), `bounds` (physical limits), `ramp` (a scripted
  move to a target), `fail` (a probe dying) or `stopAfterCycle` (a simulated
  disconnect).

---

## Part 3 — Ten-device fleet rehearsal (`fleet10`)

**No hardware required.** This is the software-only rehearsal of a ten-tank
buildout against a live dashboard: registry registration for a ten-device
fleet, the multi-tank alerting surfaces, the health-poller concurrency ceiling,
and offline detection. It does **not** validate firmware, WiFi, or the star
topology — for that see **Part 4** Phases E–F.

### 3.1 Before you start — three things that will otherwise confuse you

1. **Mock devices have no IP address, and that is correct.** Posts arrive from
   loopback, which `normalizeClientIp()` deliberately discards
   (`server.cjs:932`) so the health poller cannot be pointed back at the
   dashboard itself. So `devices.ip_address` stays `NULL`.
2. **Consequence: the health poller never touches these ten devices.**
   `getRegisteredDevices()` filters on `ip_address IS NOT NULL`
   (`services/devicePoller.cjs:43`). `last_health_seen` will therefore stay
   `NULL` and the per-device live check button will not work. This is expected.
   Do **not** "fix" it by typing a fake IP into the registrations — that just
   aims the poller at an address that answers nothing and makes all ten look
   unhealthy.
3. **Online/Offline still works**, because that flag is computed from
   `last_seen` (the `POST /sensor` heartbeat), not from the poller
   (`server.cjs:2285-2291`).

### 3.2 The fleet

`scripts/mock-device.config.js` → `PROFILES.fleet10`. One runner per device,
staggered **1.5 s** apart so the fleet is fully live after ~13.5 s and never
posts in lockstep.

| Device | Profile | What it proves |
|---|---|---|
| `ESP32_01` … `ESP32_06` | `healthy` | Baseline. Six tanks that must **never** raise an alert |
| `ESP32_07` | `warming` | Temp ramps 25 → 34 °C over 14 cycles. WARNING then CRITICAL vs a 31 °C max |
| `ESP32_08` | `ammonia_spike` | Ammonia ramps 0.32 → 4.2 ppm over 8 cycles. Critical toxin — **this one sends real SMS** |
| `ESP32_09` | `failed_ammonia` | Ammonia probe dies at cycle 8, sends `-1`. Must render grey **"No signal"**, not an amber warning |
| `ESP32_10` | `disconnect` | Posts 10 times then goes silent on its own → offline banner |

The mix is deliberately uneven. Ten identical healthy boards prove far less than
a fleet with one of each failure mode in it.

> **SMS warning.** `ESP32_07` and `ESP32_08` will both reach `critical` and both
> hit the SMS path. If real recipients are active in Settings, this will text
> real phone numbers. **Mute first:** Settings → SMS → **Mute SMS** (global), or
> mute the two tanks individually.

#### Register the ten first `[ADMIN]`

Register **before** starting the mock. If a board's first `POST /sensor` lands
before its row exists, the ingest upsert auto-creates it (`registered_via='auto'`)
and it shows an **Auto-discovered** badge until claimed.

```powershell
$Fleet = @(
  @{ id="ESP32_01"; name="Tank 01 - Bay 1";  loc="Pond A" }
  @{ id="ESP32_02"; name="Tank 02 - Bay 2";  loc="Pond A" }
  @{ id="ESP32_03"; name="Tank 03 - Bay 3";  loc="Pond A" }
  @{ id="ESP32_04"; name="Tank 04 - Bay 4";  loc="Pond A" }
  @{ id="ESP32_05"; name="Tank 05 - Bay 5";  loc="Pond B" }
  @{ id="ESP32_06"; name="Tank 06 - Bay 6";  loc="Pond B" }
  @{ id="ESP32_07"; name="Tank 07 - Bay 7";  loc="Pond B" }
  @{ id="ESP32_08"; name="Tank 08 - Bay 8";  loc="Pond B" }
  @{ id="ESP32_09"; name="Tank 09 - Bay 9";  loc="Pond C" }
  @{ id="ESP32_10"; name="Tank 10 - Bay 10"; loc="Pond C" }
)
foreach ($d in $Fleet) {
  $body = @{ device_id=$d.id; device_name=$d.name; tank_location=$d.loc } | ConvertTo-Json
  $code = (curl.exe -s -o NUL -w "%{http_code}" -X POST http://localhost:3000/devices `
    -c cookies.txt -b cookies.txt `
    -H "Content-Type: application/json" -d $body)
  Write-Host ("{0,-10} HTTP {1}" -f $d.id, $code)
}
```

`=>` ten lines. Read the codes:

| Code | Meaning |
|---|---|
| `201` | New row created |
| `200` | **Claimed** an existing auto-discovered row. Expected if you have run other mocks before — this is success, not an error |
| `409` | Already `manual`, or the ID is **archived**. Archived IDs retire permanently; rename it in `fleet10` and re-run |

> Note: `ConvertTo-Json` is used rather than string concatenation so names
> containing quotes cannot produce invalid JSON. `Invoke-RestMethod` works too
> if you prefer it, but it hides the 200-vs-201 distinction.

Verify the registry:

```powershell
curl.exe -s -b cookies.txt http://localhost:3000/devices
```

`=>` ten rows, every one `registered_via: "manual"`, `is_active: true`
`=>` no `device_secret` or `device_secret_prev` key anywhere in the response

**Or do this by hand:** Devices → **Add Device**, ten times. ID + Name, IP left
blank. Slower, but it is the path a real Owner takes and worth exercising once.

### 3.3 Start the fleet

```bash
npm run mock -- --profile fleet10
```

`=>` ten interleaved lines, each prefixed with its device ID
`=>` every line ends `POST 201` (or `POST 200` on the very first post per device
if the row was auto-created) and a sub-second round-trip
`=>` `POST 401` instead → `DEVICE_SECRET` is set in `.env` and the mock did not
pick it up; check that `.env` is at the repo root

Leave it running for the next two subsections.

### 3.4 Per-tank behaviour

- [ ] **Six healthy tanks stay quiet.** Select `ESP32_01` → Dashboard reads
      **Tank Safe**, no banner, no SMS. Repeat for `ESP32_02`…`ESP32_06`.
      `=>` readings drift slightly and the history chart trends rather than flat-lines
- [ ] **`ESP32_07` warns then goes critical.** WARNING from ~cycle 9
      (31.4 °C, ≈45 s in), CRITICAL from ~cycle 11 (32.65 °C, ≈55 s in), ramp
      completes at cycle 14 (34 °C, ≈70 s in).
      `=>` the alert **persists** well past the 5-second floating toast
      `=>` the "How to fix" guidance names temperature
- [ ] **`ESP32_08` goes critical on ammonia.** CRITICAL from ~cycle 3 (1.55 ppm,
      ≈15 s in — ammonia crosses its critical margin long before the ramp
      finishes); ramp completes at cycle 8 (4.2 ppm, ≈40 s in).
      `=>` the multi-tank banner counts **2 tanks affected**, not 1
- [ ] **`ESP32_09` shows "No signal", not a warning.** ~40 s in.
      `=>` grey pill reading **No signal** / "Sensor not reporting"
      `=>` explicitly **not** amber, and **not** counted in the affected-tanks banner
- [ ] **`ESP32_10` goes offline.** It stops after 10 posts, ~63 s in
      (13.5 s stagger + 10 × 5 s).
      `=>` after the 30 s stale window, the tile shows **Offline — last data**
      `=>` its last three readings are still visible, dimmed
      `=>` the other nine are unaffected

> If the two alarm tanks never trip, check your thresholds before suspecting a
> bug — see **2.7**. The scenarios are tuned to the **intended** safe range (temp
> 20–31 °C, water 10–100 %, ammonia 0.25–1.0 ppm).

### 3.5 Multi-tank surfaces

- [ ] **Tank selector lists all ten** and switching between them keeps charts,
      thresholds and history scoped to the selected tank
- [ ] **Live Tank Bar** shows the freshest reading per tank without a DB hit
      (`GET /devices/latest`)
- [ ] **Historical Data** — pick `ESP32_08`, confirm the ammonia ramp is visible
      as a curve; confirm the chart does **not** mix in the other nine
- [ ] **PDF / report export** names the correct tank and location
- [ ] **Logs page** attributes rows per device, not globally
- [ ] **SMS** — if you muted in the pre-flight step, confirm the mute held. If
      you deliberately left it live, confirm exactly **2** messages went out
      (`ESP32_07`, `ESP32_08`) and not ten

### 3.6 Poller concurrency ceiling

`services/devicePoller.cjs` sets `MAX_CONCURRENCY = 10` and polls in
`ceil(n / 10)` batches. Ten devices is the first fleet size that fits in a
**single** batch — two more than the 8-device `fleet` profile needs, which is
precisely the point at which a fleet stops splitting.

- [ ] **Boot line.** In the server log:
      `[POLL] ESP32 status poller started (every 5s, up to 10 concurrent, timeout 2000ms)`
- [ ] **Excluded devices.**
      `curl.exe -s -b cookies.txt "http://localhost:3000/devices?include_archived=1"`
      `=>` all ten have `last_health_seen: null` — the poller excluded them for
      having no IP. This is correct, not a failure (see *3.1* #2)
- [ ] **Rate limits.** Ten simultaneous ingest streams do **not** trip the
      per-device rate limit (12 posts/sec per `device_id`); at 5 s intervals you
      are far under it
- [ ] **Actually exercising the batch path needs real IPs**, because the mock
      cannot reach `http://<ip>/status`. Run Part 4 Phase F with hardware
      instead — with more than 10 devices and real IPs you can see
      `ceil(n / 10)` batching for real

### 3.7 Console is clean

- [ ] Server log has no unhandled rejections, no `ECONNREFUSED` storm, no
      `Auto-registered unknown device_id` warnings (registering first should
      have prevented them)
- [ ] Browser console has no errors and no React key warnings across all ten
      tank switches
- [ ] Frontend poll of `GET /devices` and `GET /devices/latest` does not back
      off (both pause on a hidden tab and back off exponentially on failure —
      switching tabs repeatedly and returning should show a clean recovery, not
      a permanently degraded poll)

### 3.8 Teardown

`Ctrl+C` the mock. Nothing needs reverting for the run itself, but the ten rows
persist and will keep filling the history charts with simulated points.

- [ ] **Archive the ten** on Devices → archive icon. Archiving **retires the IDs
      permanently** — they can never be reused. Use this for a fleet you are done
      with; use the pencil (Active off) instead if you want to hide them and keep
      the IDs reservable
- [ ] **Delete the `sensors` rows** for the ten if the charts are now unusable.
      **This is destructive and not reversible** — back up first
- [ ] **Unmute SMS** if you muted it
- [ ] `GET /devices` shows no `registered_via='auto'` rows you did not intend

### 3.9 Known limits of this test

| Limit | Consequence |
|---|---|
| Mocks post from loopback → `ip_address` stays `NULL` | Health poller skips all ten. No `last_health_seen`, no live-check button, no poller batching |
| No real `GET /status` endpoint behind the ten | Device-level health failures are untestable with mocks |
| Firmware is not involved | Config-portal Device ID, WiFi backoff, watchdog, safe mode and NVS are all untested — see Part 4 Phase E |
| History accumulates | Repeated runs fill the charts with simulated points. Use the Logs page to separate real hardware from simulated |
| Mock uses the server clock | `read_at` is omitted deliberately so the server timestamps every row |

**Changing the fleet:** edit the `devices` array in `PROFILES.fleet10`. To use
different IDs, change them there *and* in the registration list in **3.2**
together — a mismatch is exactly what the "Auto-discovered" badge is telling you
about.

---

## Part 4 — Multi-tank / star topology (hardware)

**Scope:** firmware (ESP32), database migration 007, backend API + device
poller, and the frontend tank-selector / fleet-buildout for the six-tank star
topology (server `192.168.4.10`, tanks `192.168.4.100-105`).

Phase A below repeats Part 1 for the hardware run; Phase F is the end-to-end run
on the real `192.168.4.0/24` LAN.

### Phase A — Static checks

Already covered by **Part 1**. Run `npm run lint`, `npm run build` and
`npm run check:encoding` before flashing anything.

### Phase B — Database migration 007 (needs live PostgreSQL)

**Purpose:** prove migration applies cleanly, is idempotent, and leaves the right
columns/types/index.

#### B1. Run the migration (from the repo root, `.env` must be loadable)

```bash
node db/migrations/007_multi_device.cjs
```

`=>` `"devices columns ->"` listing includes

```text
ip_address  text
tank_name   character varying(100)
tank_location character varying(100)
last_health_seen  timestamp with time zone
```

`=>` `"composite index -> idx_sensors_device_timestamp"`
`=>` `"sensors.timestamp -> timestamp with time zone"`
`=>` `"system_logs.timestamp -> timestamp with time zone"`
`=>` `"[migration] 007_multi_device applied"`

#### B2. Idempotency — run the **same** command again

`=>` identical success output, no `ERROR: column ... already exists` etc.

#### B3. Optional psql spot-check

```sql
\d devices
```

`=>` columns above present; `created_at` / `last_seen` show `timestamp with time zone`

```sql
SELECT indexname FROM pg_indexes WHERE tablename='sensors'
  AND indexname='idx_sensors_device_timestamp';
```

`=>` 1 row

### Phase C — Backend API + device poller (server running)

**Purpose:** prove the new endpoints scope by tank, the registry loads, and the
poller behaves (start log, warn on dead device, never writes sensors).

#### C1. Start the backend

```bash
npm run server
```

`=>` boot logs end with `[POLL] ESP32 status poller started (every 5s, up to 10 concurrent, timeout 2000ms)`
`=>` `Server listening on port 3000`

#### C2. Get a session cookie

Log in as in *Authenticating your curl commands* at the top of this file. Then
`$H` becomes unnecessary — add `-b cookies.txt` to each call:

```powershell
curl.exe -s -b cookies.txt http://localhost:3000/devices
```

`=>` the response is JSON, so the cookie jar is valid. (There is no `$tok` to
copy: login returns no token in the body.)

#### C3. Fleet registry — empty DB

```powershell
curl.exe -s -b cookies.txt http://localhost:3000/devices
```

`=>` `[]`
`=>` (validation: endpoint responds, no 500)

#### C4. Ingest a fake tank (`X-Device-Secret` only if `DEVICE_SECRET` is in `.env`)

```powershell
curl.exe -s -X POST http://localhost:3000/sensor -H
  "Content-Type: application/json" -H "X-Device-Secret: <your secret>" -d
  '{"device_id":"tank-test","temperature":25.4,"water_level":72.0,"ammonia":0.35}'
```

`=>` `{"message":"Saved",...}` and the device row is auto-created

#### C5. Ingest an **unchanged** reading → delta skip (heartbeat still refreshed)

```powershell
curl.exe -s -X POST http://localhost:3000/sensor -H
  "Content-Type: application/json" -H "X-Device-Secret: <your secret>" -d
  '{"device_id":"tank-test","temperature":25.4,"water_level":72.0,"ammonia":0.35}'
```

`=>` `{"message":"No change, skipped","skipped":true,...}` and **no** new `sensors` row

#### C6. Ingest a second tank

```powershell
curl.exe -s -X POST http://localhost:3000/sensor -H
  "Content-Type: application/json" -H "X-Device-Secret: <your secret>" -d
  '{"device_id":"tank-test2","temperature":23.1,"water_level":40.0,"ammonia":0.62}'
```

`=>` `{"message":"Saved",...}`

#### C7. `/devices` now lists both tanks

```powershell
curl.exe -s -b cookies.txt http://localhost:3000/devices
```

`=>` two rows, each with `device_id`, `name`, `tank_name` (null), `tank_location`
(null), `ip_address` (null), `last_seen`, `last_health_seen` (null), `is_active`
(true), `online` (true because `last_seen` is fresh)

#### C8. Latest reading is per-tank

```powershell
curl.exe -s -b cookies.txt "http://localhost:3000/sensor/latest?device_id=tank-test"
```

`=>` row with `device_id` `tank-test`

```powershell
curl.exe -s -b cookies.txt "http://localhost:3000/sensor/latest?device_id=tank-test2"
```

`=>` row with `device_id` `tank-test2` (proves scoping, not farm-wide-first)

```powershell
curl.exe -s -b cookies.txt "http://localhost:3000/sensor/latest?device_id=tank-ghost"
```

`=>` `{"message":"No sensor data found"}` (404)

#### C9. History is per-tank

```powershell
curl.exe -s -b cookies.txt "http://localhost:3000/sensor?device_id=tank-test&limit=50"
```

`=>` **only** `tank-test` rows

```powershell
curl.exe -s -b cookies.txt "http://localhost:3000/sensor"
```

`=>` farm-wide rows for both tanks (no filter = all)

#### C10. `/devices/:id/status` — error ladder

**a) No IP configured**

```powershell
curl.exe -s -b cookies.txt http://localhost:3000/devices/tank-test/status
```

`=>` `400 {"message":"Device has no IP address configured"}`

**b) Unreachable IP**

```sql
UPDATE devices SET ip_address='192.168.4.99' WHERE device_id='tank-test';
```

```powershell
curl.exe -s -b cookies.txt http://localhost:3000/devices/tank-test/status
```

`=>` `502 {"message":"Device unreachable",...}`

**c) Unknown device**

```powershell
curl.exe -s -b cookies.txt http://localhost:3000/devices/nope/status
```

`=>` `404 {"message":"Device not found"}`

A live 200 case is covered in Phase E once an ESP32 exists.

#### C11. Analytics overview is per-tank

```powershell
curl.exe -s -b cookies.txt "http://localhost:3000/analytics/overview?days=7&device_id=tank-test"
curl.exe -s -b cookies.txt "http://localhost:3000/analytics/overview?days=7&device_id=tank-test2"
```

`=>` the two payloads' averages/trends reflect only their own tank

#### C12. Poller warns on a dead device (no ESP32 needed — use the bogus IP from C10b)

- [ ] `=>` within ~15–30 s (3 consecutive 5 s polls) the server log shows:

  ```text
  [POLL] Device tank-test (192.168.4.99) unreachable for 3 consecutive polls: ...
  ```

- [ ] `=>` `last_health_seen` stays NULL; **no** `sensors` row is ever written by
      the poller (you prove this by counting rows before/after; the count does
      **not** move)

#### C13. Poller warning backoff

- [ ] `=>` after the first warn, no **new** warning for that device for at least
      30 s (backoff gate) even though polls keep failing every 5 s

#### C14. Poller recovers when reachable

- [ ] `=>` `UPDATE devices SET ip_address='<something on port 80 that answers>' ...`
      e.g. point it at an ESP32 (Phase E) or a dev machine serving the same JSON
      on port 80; within ~5 s `last_health_seen` advances and the failure counter
      resets.

#### C15. `device_id` echo cross-check (needs two reachable states or one real tank)

- [ ] `=>` point `tank-test`'s `ip_address` at a host whose `/status` reports a
      **different** `device_id`; server logs:

      ```text
      [POLL] IP <ip> reported device_id "<other>", expected "tank-test" - check registry
      ```

      and does **not** mark it healthy (`last_health_seen` not advanced)

### Phase D — Frontend UI (dev servers running)

**Purpose:** prove the tank selector, fleet overview, and per-tank scoping in the UI.

#### D1. Start frontend

```bash
npm run dev
```

`=>` <http://localhost:5173> ; log in with any account

#### D2. Dashboard — tank selector

- [ ] `=>` chip bar under the header showing `tank-test` / `tank-test2` (name
      falls back to `device_id`), a green online dot per chip, and "2/2 online"

#### D3. Dashboard — farm overview

- [ ] `=>` the farm overview section lists both tanks with online dots; each card
      has a "Live check" button

#### D4. Per-chip scoping

- [ ] `=>` click `tank-test`: charts + "currently viewing" chip show `tank-test`
      values (25.4 °C / 72.0% / 0.35 ppm)
- [ ] `=>` click `tank-test2`: they switch to 23.1 °C / 40.0% / 0.62 ppm

#### D5. Poll cadence check (DevTools → Network)

- [ ] `=>` a 1 s repeating `GET /sensor/latest?device_id=<selected>`
- [ ] `=>` a 5 s repeating `GET /devices` (fleet)
- [ ] `=>` a ~30 s repeating `GET /sensor?device_id=<selected>&limit=...`
- [ ] `=>` history/latest requests carry the selected `device_id` query param

#### D6. Selection persistence across pages

- [ ] `=>` select `tank-test2` on Dashboard, navigate to Historical Data and
      Analytics
- [ ] `=>` the selector still shows `tank-test2` selected (state lives in provider)

#### D7. Historical Data scoping

- [ ] `=>` with `tank-test2` selected, chart shows only `tank-test2` data
- [ ] `=>` select a never-written tank (a `devices` row with no `sensors`) → clean
      empty state message, no crash

#### D8. Analytics scoping

- [ ] `=>` overview numbers change when you switch tanks; Daily breakdown +
      Insights stay farm-wide (by design)

#### D9. Live check error ladder (no ESP32 yet)

- [ ] `=>` on `tank-test` (ip `192.168.4.99`) click Live check → card shows
      "Device unreachable" (502) state after the request resolves
- [ ] `=>` if a device has no ip set: "no IP" → error/empty state (400)

#### D10. Lint + build again after any UI tweaks

```bash
npm run lint; npm run build
```

`=>` clean

### Phase E — Firmware (Arduino IDE + flashed ESP32)

**Purpose:** prove the firmware changes compile, serve `GET /status`, honor the new
config fields, buffer against outages, and emit the `-1` sentinel.

#### E1. Compile

- [ ] `=>` Arduino IDE opens
      `water_monitoring_system/ESP32_main_code/ESP32_main_code.ino` (tank 1) or
      `water_monitoring_system/NODE_main_code/NODE_main_code.ino` (spare /
      NodeMCU), installs ESPAsyncWebServer + AsyncTCP (Library Manager), board
      ESP32 Dev Module, and compiles clean. Watch for
      `#include <ESPAsyncWebServer.h>` being satisfied.

#### E2. Flash one tank

- [ ] `=>` give `device_id` `tank01`, `server_ip` = dev machine LAN IP (or
      `192.168.4.10` in staging), `device_secret` = same as `.env`, and if wanted
      a static IP in `192.168.4.100-105` via the portal fields (`static_ip` /
      `static_gateway` / `static_subnet`)
- [ ] `=>` Serial (115200) shows WiFi connected IP +
      `[HTTP] Status server on port 80 (GET /status | /)`

#### E3. Portal offers the new config fields

- [ ] `=>` triple-tap top-left corner (or serial `W`) to open the
      Aquaculture-Setup portal at <http://192.168.4.1>; confirm fields:
      `device_secret`, `tank_height_cm`, `static_ip`, `static_gateway`,
      `static_subnet` (`device_id`, `server_ip`, `server_port` also present)

#### E4. `/status` serves the health JSON (from any LAN PC)

```powershell
curl.exe -s http://<esp-ip>/status
```

`=>`

```json
{"device_id":"tank01","ip":"<esp-ip>","uptime_ms":<n>,
 "wifi_rssi":<n>,"free_heap":<n>,"temperature":<n>,"water_level":<n>,
 "ammonia":<n>}
```

- [ ] `=>` `curl.exe -s http://<esp-ip>/` returns the same payload (root alias)

#### E5. Live endpoint through the server

```sql
UPDATE devices SET ip_address='<esp-ip>', tank_name='Tank 1',
  tank_location='Tank Room A' WHERE device_id='tank01';
```

- [ ] `=>` `curl.exe -s -b cookies.txt http://localhost:3000/devices/tank01/status` → 200 +
      the device JSON from E4
- [ ] `=>` `GET /devices` now shows `tank01` with `tank_name`/`tank_location`
      filled, `online` true, and `last_health_seen` advancing every ~5 s

#### E6. Live check for `tank01`

- [ ] `=>` dashboard farm-overview card for `tank01` → Live check → shows uptime,
      RSSI, free heap, and current temperature/water_level/ammonia

#### E7. Offline detection

- [ ] `=>` power off the ESP32; server logs show
      `[POLL] Device tank01 (<esp-ip>) unreachable for 3 consecutive polls` after
      ~15–30 s; `devices.last_health_seen` stops advancing
- [ ] `=>` the dashboard tank chip/tile goes **offline 30 s after the last
      `POST /sensor`** (the heartbeat rule) — which is independent of the
      poller; `last_health_seen` stopping does not itself flip the status chip
- [ ] `=>` power back on; within ~5 s the heartbeat resumes and the status
      returns to online

#### E8. `device_id` echo guard

- [ ] `=>` point another registry device (e.g. `tank-test`) at `tank01`'s IP
- [ ] `=>` poller logs:

      ```text
      [POLL] IP <esp-ip> reported device_id "tank01", expected "tank-test" - check registry
      ```

#### E9. Outage buffer flush

- [ ] `=>` stop the backend; keep the ESP32 running for ~60 s (it queues by default)
- [ ] `=>` restart the backend
- [ ] `=>` (psql) `SELECT count(*) FROM sensors WHERE device_id='tank01';` → count
      **jumps** by ~60 (queued readings flushed oldest-first, capped at
      `SEND_BUFFER_CAP` 600); once caught up, delta skip resumes and the count
      stops moving for constant water
- [ ] Mind the rate limit: a 600-row flush is ~50 s of posts at 12/s. It stays
      under the cap, but do not shorten the buffer or raise `SEND_BUFFER_CAP`
      without re-checking 12 posts/sec per `device_id`.

#### E10. Water-level sentinel

- [ ] `=>` cover/rotate the HC-SR04 so it returns garbage/beyond range
- [ ] `=>` `curl.exe -s http://<esp-ip>/status` → `"water_level":-1.0`
- [ ] `=>` TFT screen shows ERROR for the level value (not a bogus number)
- [ ] `=>` the dashboard renders that reading as grey **"No signal"**, and the
      stored `sensors.water_level` is `NULL`, not `-1` or `0`

#### E11. Ammonia warm-up behavior (visual check only)

- [ ] `=>` MQ-137 reports `-1.0` on `/status` until R0 calibration completes, then
      a real ppm (matches existing behavior)

### Phase F — End-to-end star topology (staging LAN 192.168.4.0/24)

**Purpose:** the full six-tank scenario on its own subnet. Run only when the
router supports the subnet (NVS static IP or DHCP reservations).

#### F1. Prepare the network

- [ ] `=>` router/AP LAN set to `192.168.4.0/24`, gateway `192.168.4.1`, DHCP pool
      avoiding 100-105; server IP reserved to `192.168.4.10` (or set static)
- [ ] `=>` backend `.env` + server bound on `192.168.4.10:3000` (or `0.0.0.0`)

#### F2. Flash the fleet

- [ ] `=>` each of 6 boards: `device_id` `tank01`..`tank06`, static IP
      `192.168.4.100-105`, `server_ip` `192.168.4.10`, matching `device_secret`,
      `tank_name` + `tank_location` set in `devices` via psql for each tank

#### F3. Registry + fleet view

- [ ] `=>` `GET /devices` lists all 6 with correct names/locations/IPs; each
      `online` = true; dashboard "6/6 online" and the farm overview shows all green

#### F4. Per-tank delta write test

- [ ] `=>` leave water still for a minute
- [ ] `=>` (psql) `SELECT count(*) FROM sensors WHERE device_id='tank01';` →
      snapshot, wait 60 s, snapshot again
- [ ] `=>` second count ~ equal to first (only heartbeat refreshes; few/none rows)
- [ ] `=>` wave a hand near the HC-SR04 → one row appears for `tank01` only

#### F5. Fleet offline behaviour

- [ ] `=>` unplug `tank03` → its heartbeat stops, so the dashboard chip/card goes
      offline after the 30 s stale window; the poller logs
      `unreachable for 3 consecutive polls` after ~15–30 s and
      `last_health_seen` stops. Others stay online.
- [ ] `=>` replug `tank03` → recovers, all online again

#### F6. Home / history / analytics scoping

- [ ] `=>` on a laptop on the same LAN open <http://192.168.4.10:5173> and switch
      tanks through Dashboard, Historical Data, Analytics
- [ ] `=>` values/history/overview follow the selected tank

#### F7. One server-outage recovery

- [ ] `=>` stop backend 60 s while all tanks run; restart
- [ ] `=>` each tank's queued rows flush (oldest-first); all 6 come back online
      within ~5–15 s; `sensors` row counts stop growing after catch-up

#### F8. Optional disconnect SMS

- [ ] `=>` with SMS unmuted + recipients configured, unplug one tank
- [ ] `=>` a disconnect SMS arrives (subject to the rearm grace period)

### Troubleshooting quick table

| Symptom | What to check |
|---|---|
| Migration error "column X exists" | B2 expectations: idempotent; if ERROR appears on **second** run it is a bug |
| `/devices` shows empty until first POST | Devices are created on first sensor contact (C4) or seeded via psql |
| `POST /sensor` returns 401 | `DEVICE_SECRET` set in `.env` but header missing/wrong — add `X-Device-Secret` |
| `$tok` is empty after login | Expected — login returns no token in the body. Use the cookie jar (`-c` / `-b cookies.txt`) |
| Login returns 429 | 5 failed attempts per IP per 15 min. Wait out the window |
| `/devices/:id/status` 400 | `ip_address` NULL in `devices` table |
| `/devices/:id/status` 502/504 | Device powered off / NAT / domain issue; device must be reachable on port 80 |
| No `[POLL]` start line | `server.cjs` older build; poller only starts after the server is listening |
| Poller warnings every 5s forever | Recovery gate (C14) not possible until something serves `/status` on port 80 |
| Tank chip shows offline on dashboard | Stale window is `HEARTBEAT_STALE_MS` = **30 s** (`src/contexts/SensorProvider.tsx:55`), hard-coded — not env-tunable. If it is offline long after 30 s, the device genuinely stopped posting |
| Device is Online but has no health data | Normal for mocks and IP-less devices: `online` comes from `last_seen`, `last_health_seen` from the poller |
| History won't filter per tank | Frontend built before Phase D? Rebuild |
| Firmware won't compile | ESPAsyncWebServer + AsyncTCP not installed (E1) |

---

## Part 5 — Automated suites

Custom harness, not a test framework: each suite prints `PASS`/`FAIL` per check
and exits non-zero on failure. Rows it writes are prefixed `ZZTEST_` and removed
afterwards.

| Command | Needs a running API server? | Needs Postgres? | Covers |
|---|---|---|---|
| `npm test` | no | no | Threshold / severity logic (pure functions) |
| `npm run test:poller` | no | no | Device poller batching, backoff, `device_id` echo guard (34 checks) |
| `npm run test:migration` | no | **yes** | Migrations against a temp schema |
| `npm run test:regression` | **yes** | yes | End-to-end ingest → alert → history |
| `npm run test:devices` | **yes** | yes | Device registry, RBAC, secrets, archive/restore (104 checks) |
| `npm run test:secrets` | **yes** | yes | Device-secret auth paths |
| `npm run test:sessions` | **yes** | yes | Login, cookie session, revocation (59 checks) |

### The one command that runs most of them

```bash
npm run test:all
```

Nine steps in order: **lint → encoding → build → unit → poller → devices →
migration → secrets → regression.** The static checks come first on purpose —
lint and the encoding guard are cheap, so a type error fails in seconds instead
of after a Postgres-backed suite has already touched the database.

`test:sessions` is **deliberately not in `test:all`** — it is the only suite that
calls `POST /auth/login`, and `test:all` has to stay green regardless of what you
were doing in the UI a minute ago. Run it separately when you touched auth:

```bash
npm run test:sessions
```

Correct logins are not counted against the server's brute-force budget, so the
suite no longer trips the limiter and can be run back to back. But a burst of
genuinely failed logins in the browser will still make the server refuse it, and
a `429` from this suite means the window is exhausted — not that session code
regressed.

### Writing to the live database

> **Read `TESTING_GUIDE.md` Phase C.6 before running any suite that writes to the
> live `devices` table.** `test:devices` and `test:secrets` both write. Never point
> these at a production or valued database.

The three server-backed suites fail with `status=-1` / `ECONNREFUSED` if the API
is not up. That is an environment problem, **not** a regression.

---

## Doc corrections (2026-10)

Statements in the previous guides that were wrong when merged in, and what is
actually true:

| Claim | Reality |
|---|---|
| `$tok = $r.token` after `POST /auth/login` | Login returns no token in the body — it sets an `HttpOnly` cookie. Use a cookie jar (`-c` / `-b`) |
| `rg "192\.168\.100"` should return nothing | The prefix survives legitimately in IPv4 validation text and test fixtures. Grep the full old address `192.168.100.152` |
| `ls src\components\FleetGrid.tsx` | Component is `src/components/FarmOverview.tsx`; `FleetGrid` no longer exists |
| Dashboard offline window is `DISCONNECT_STALE_MS` (~15 s) | Dashboard uses `HEARTBEAT_STALE_MS = 30000`, hard-coded (`SensorProvider.tsx:55`). `DISCONNECT_STALE_MS` is the *server's* 30 s SMS/online window |
| `ESP32_07` goes CRITICAL at 32.65 °C, ~70 s in | 32.65 °C is the critical threshold, first crossed at ~cycle 11 (≈55 s); ~70 s is when the ramp *completes*. WARNING starts at ~cycle 9 |
| `ESP32_08` goes critical ~40 s in | Ammonia crosses its critical margin at ~cycle 3 (1.55 ppm, ≈15 s); cycle 8 / 40 s is when the ramp completes |
| The `device_id` "must already exist" or nothing works | The ingest upsert auto-creates unknown devices (`registered_via='auto'`); registering first just avoids the Auto-discovered badge |
| `fleet10` needs 8 devices for a single poller batch | `MAX_CONCURRENCY = 10`, so 10 is the first size that fits one batch (the 2-device `fleet` profile never split either) |
| Profile table lists 8 profiles | There are 9 — `fleet10` was missing from the list |
| `server.cjs:666`, `server.cjs:1847` | `normalizeClientIp` is at `server.cjs:932`; the `online`-from-`last_seen` query is at `server.cjs:2285-2291` |
| Section A of the multi-tank guide | Duplicate of the lint/build steps; folded into Part 1 |

## Files

| File | Purpose |
|---|---|
| `scripts/mock-device.js` | The CLI. Argument parsing, value engine, HTTP posting, logging, shutdown |
| `scripts/mock-device.config.js` | The scenario profiles. Edit this to add your own — plain data, no code |
| `services/devicePoller.cjs` | `MAX_CONCURRENCY`, `FAILURE_THRESHOLD`, the `ip_address IS NOT NULL` filter |
| `db/migrations/007_multi_device.cjs` | The multi-tank migration this part verifies |
| `src/pages/DevicesPage.tsx` | Add Device form, provenance badges, `OnlineDot` |
| `tests/*.cjs` | The automated suites listed in Part 5 |
| `TESTING_GUIDE.md` (repo root) | The ordered A–H manual verification procedure |