# Mock Device Guide — Simulating the ESP32 Without Hardware

## Purpose

The dashboard, alerting, SMS and PDF pipeline all get their data from one
endpoint: `POST /sensor`. `scripts/mock-device.js` speaks that same protocol, so
you can develop, demo and test the entire system with no physical ESP32 on the
desk.

This is a development and demonstration tool. It is **not** a substitute for
testing real firmware.

---

## 1. Quick Start

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

The default device is `ESP32_03 Mock Device` — the third tank, alongside the real
`ESP32_01` and `ESP32_02` hardware. If your database has no such device, see
[section 6](#6-device-registration).

---

## 2. The Sensor Contract

| | |
|---|---|
| **Endpoint** | `POST /sensor` |
| **Auth** | header `X-Device-Secret: <DEVICE_SECRET>` |
| **Body** | JSON |

```json
{
  "device_id":   "ESP32_01",              // required, must match a registered device
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

### Failed-sensor sentinels

A probe that fails does not report 0 — it reports a sentinel, and the server
stores `NULL` instead so failed sensors never pollute the time-series data:

| Field | Sentinel | Stored as | Cause |
|---|---|---|---|
| `temperature` | `0` | `NULL` | DS18B20 fault code |
| `water_level` | `-1` | `NULL` | HC-SR04 no echo |
| `ammonia` | `-1` | `NULL` | MQ-137 no signal |

The dashboard renders `NULL` as a grey **"No signal"** pill plus the explanation
"Sensor not reporting". That is deliberately **not** an amber "Warning": a dead
probe is a hardware fault, and showing it as a water-quality warning sends you
hunting for a problem that does not exist.

**Rate limit:** 12 posts per second per `device_id`. Do not go below ~100 ms.

---

## 3. Scenario Profiles

List them at any time:

```bash
npm run mock:profiles
```

| Profile | What it does |
|---|---|
| `healthy` | Baseline. Gentle diurnal drift, stays in the safe range. Use this while working on anything else — it should never raise an alert |
| `warming` | Temperature ramps 25 °C → 34 °C over 14 cycles. Against the intended 20–31 °C range this produces a WARNING and then a CRITICAL. Shows the alarm, the persistent banner and the "How to fix" guidance |
| `ammonia_spike` | Ammonia ramps 0.32 → 4.2 ppm over 8 cycles. Ammonia is the fastest-acting toxin for crayfish, so this is the scenario that best demonstrates why the persistent critical banner exists: the alarm must outlive the 5-second floating toast |
| `low_water` | Water level falls 80% → 4%, breaching the 10% minimum |
| `failed_ammonia` | The ammonia probe dies at cycle 8 and sends `-1` from then on. Proves a dead sensor reads "No signal" rather than a false warning |
| `all_sensors_fail` | Every probe dies at cycle 5 — three "No signal" cards. Simulates a drained tank or an ESP32 powered off mid-read |
| `disconnect` | Posts 10 times, then goes silent on its own. After the 30-second heartbeat window the dashboard should flip to the offline banner while still showing the last readings |
| `fleet` | Two tanks in parallel: `ESP32_01` healthy, `ESP32_02` warming, staggered 2.5 s apart. Exercises the fleet view, the per-tank alarm badge and the "N tanks affected" banner. Needs two registered devices |

---

## 4. Command Line Options

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
| `--log <file>` | Append every post to a JSONL file for replay or analysis. e.g. `--log logs/mock-2026-09-26.jsonl` |
| `--api <url>` | Override the API base. Default: `http://localhost:3000` |
| `--secret <s>` | Override `X-Device-Secret` |
| `-l, --list-profiles` | Show profiles and exit |
| `--list-devices` | Show devices registered on the API and exit |
| `--show-config` | Print the resolved config for the chosen profile |
| `-h, --help` | Full help |

`npm run mock -- <options>` is equivalent to the node command above.

---

## 5. Recipes

### Prove the critical alarm persists (the headline behaviour)

```bash
npm run mock -- --profile ammonia_spike --interval 2000
```

**Watch:** the red CRITICAL banner appears, names the tank and value, and is still
there a minute later. It only clears when ammonia recovers.

### Show a dead probe is not a water problem

```bash
npm run mock -- --profile failed_ammonia --interval 1000
```

**Watch:** the Sensors page shows a grey "No signal" pill on the ammonia card
with "Sensor not reporting — check wiring and that the ESP32 is online".

### Show the offline state

```bash
npm run mock -- --profile disconnect
```

**Watch:** after the 10th post the device stops. Wait ~30 s and the dashboard
shows the amber offline banner plus "last known readings".

### Two tanks, one going wrong

```bash
npm run mock -- --profile fleet --interval 2000
```

**Watch:** the sidebar Alerts badge counts the affected tanks, and the banner
reports how many tanks are in alarm.

### Run a short burst for a quick screenshot

```bash
npm run mock -- --profile ammonia_spike --cycles 15 --interval 1500
```

Takes about 25 seconds.

### Capture everything to a file for later

```bash
npm run mock -- --profile healthy --log logs/mock-run.jsonl
```

---

## 6. Device Registration

The `device_id` must already exist in the `devices` table, otherwise the server
has no thresholds to evaluate it against.

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

---

## 7. Important: Check Your Thresholds First

The scenarios are tuned to the **intended** safe range, which is defined in
`src/types/index.ts` (`DEFAULT_SETTINGS`):

| Parameter | Intended safe range |
|---|---|
| `temperature` | 20 – 31 °C |
| `water_level` | 10 – 100 % |
| `ammonia` | 0.25 – 1.0 ppm |

Check what your database currently holds:

```bash
npm run mock -- --show-config
```

or query the settings row directly:

```bash
node --input-type=module -e "import 'dotenv/config'; import pg from 'pg'; const p=new pg.Pool({host:process.env.PG_HOST,port:+process.env.PG_PORT||5432,database:process.env.PG_DATABASE,user:process.env.PG_USER,password:process.env.PG_PASSWORD}); const r=await p.query('SELECT temp_min,temp_max,ammonia_min,ammonia_max FROM sensor_settings LIMIT 1'); console.log(r.rows[0]); await p.end();"
```

If `temp_max` has been edited to something like `49.9`, the `warming` scenario
will **not** trip an alert, because 34 °C is comfortably inside that limit. A
49.9 °C ceiling is not a safe operating limit for crayfish — water that hot kills
the stock within minutes — so treat that as a configuration bug and set it back to
31 via Settings.

Ammonia and water-level scenarios are unaffected: their defaults are still in
place.

---

## 8. Notes and Limits

- The mock uses the server's clock. `read_at` is deliberately omitted so the
  server timestamps each row, which keeps the time series clean.
- Values are rounded the way the real firmware rounds them: temperature to
  0.1 °C, water level to whole percent, ammonia to 0.01 ppm.
- The dashboard is a single-page app that holds no data of its own, so you can
  stop and start the mock freely. Readings already sent stay in the database and
  will appear in the charts and reports.
- Because historical data accumulates, a long mock run fills the history charts
  with simulated points. Use the Sensor Logs page if you need to isolate real
  hardware readings from simulated ones.
- Sending does **not** require the SSE stream to be healthy, so this is also the
  easiest way to reproduce the "backend unreachable" state.

---

## 9. Files

| File | Purpose |
|---|---|
| `scripts/mock-device.js` | The CLI. Argument parsing, value engine, HTTP posting, logging, shutdown |
| `scripts/mock-device.config.js` | The scenario profiles. Edit this to add your own — it is plain data, no code needed |
| `package.json` | `"mock"` and `"mock:profiles"` scripts |

**Adding a profile:** append an entry to `PROFILES` in `mock-device.config.js`. At
a minimum give it a description, base readings and an interval. Optionally add
`noise` (random walk), `drift` (slow trend), `bounds` (physical limits), `ramp` (a
scripted move to a target), `fail` (a probe dying) or `stopAfterCycle` (a
simulated disconnect).
