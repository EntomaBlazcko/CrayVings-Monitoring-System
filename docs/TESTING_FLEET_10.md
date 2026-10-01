# Testing Guide — 10-Device Fleet (`fleet10`)

**Scope:** the `fleet10` mock profile — ten simulated tanks posting to
`POST /sensor` in parallel against a live dashboard. Covers registry
registration for a ten-device fleet, the multi-tank alerting surfaces, the
health-poller concurrency ceiling, and offline detection.

**No hardware required.** This is the software-only rehearsal of a ten-tank
buildout. It does **not** validate firmware, WiFi, or the star topology — for
that see [TESTING_MULTI_TANK.md](./TESTING_MULTI_TANK.md) Phases E–F.

---

## How to use this file

- Work top to bottom. Phases A–C are setup; D–F are the actual assertions.
- Each step has a `[ ]` checkbox. Log actual output next to `=>`.
- Steps that write to the live database are marked `[ADMIN]` and are reversible
  (Phase H).

## Prerequisites

- [ ] Node.js 18+, PostgreSQL 15+, deps installed (`npm install`)
- [ ] `.env` present with `PG_*` set
- [ ] API server running on port 3000 (`npm run server`) — **a human starts this**
- [ ] Frontend running (`npm run dev`)
- [ ] An **admin** account, for `POST /devices`

## Before you start — three things that will otherwise confuse you

1. **Mock devices have no IP address, and that is correct.** Posts arrive from
   loopback, which `normalizeClientIp()` deliberately discards
   (`server.cjs:666`) so the health poller cannot be pointed back at the
   dashboard itself. So `devices.ip_address` stays `NULL`.
2. **Consequence: the health poller never touches these ten devices.**
   `getRegisteredDevices()` filters on `ip_address IS NOT NULL`
   (`services/devicePoller.cjs:43`). `last_health_seen` will therefore stay
   `NULL` and the per-device live check button will not work. This is expected.
   Do **not** "fix" it by typing a fake IP into the registrations — that just
   aims the poller at an address that answers nothing and marks all ten Offline.
3. **Online/Offline still works**, because that flag is computed from
   `last_seen` (the `POST /sensor` heartbeat), not from the poller
   (`server.cjs:1847`).

---

## The fleet

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

---

## Phase A — Static checks (no DB, no server)

- [ ] **A1.** `npm run lint` → no errors (exit 0)
- [ ] **A2.** `npm run build` → `built in Xs`
- [ ] **A3.** The profile is registered and lists ten devices:
      `npm run mock:profiles`
      `=>` `fleet10` appears with `devices: ESP32_01=healthy, … ESP32_10=disconnect`

---

## Phase B — Register the ten devices `[ADMIN]`

Register **before** starting the mock. If a board's first `POST /sensor` lands
before its row exists, the ingest upsert auto-creates it
(`registered_via='auto'`) and it shows an **Auto-discovered** badge until claimed.

### B1. Get a token

```powershell
$u="YOUR_OWNER_USERNAME"; $p="YOUR_PASSWORD"
$r = curl.exe -s -X POST http://localhost:3000/auth/login -H `
  "Content-Type: application/json" `
  -d ('{"username":"'+$u+'","password":"'+$p+'"}') | ConvertFrom-Json
$tok = $r.token
$H = @("Authorization: Bearer $tok")
```

`=>` `$tok` non-empty

### B2. Register the fleet

Runs entirely against the real API, so the rows are identical to hand-typed
ones — `registered_via='manual'` plus an `activity_logs` entry each.

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
    -H "Content-Type: application/json" -H $H -d $body)
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

### B3. Verify the registry

```powershell
curl.exe -s -H $H http://localhost:3000/devices
```

`=>` ten rows, every one `registered_via: "manual"`, `is_active: true`
`=>` no `device_secret` or `device_secret_prev` key anywhere in the response

**Or do B2 by hand:** Devices → **Add Device**, ten times. ID + Name, IP left
blank. Slower, but it is the path a real Owner takes and worth exercising once.

---

## Phase C — Start the fleet

```powershell
npm run mock -- --profile fleet10
```

`=>` ten interleaved lines, each prefixed with its device ID
`=>` every line ends `POST 201` (or `POST 200` on the very first post per device
if the row was auto-created) and a sub-second round-trip
`=>` `POST 401` instead → `DEVICE_SECRET` is set in `.env` and the mock did not
pick it up; check that `.env` is at the repo root

Leave it running for Phases D–E.

---

## Phase D — Per-tank behaviour

- [ ] **D1. Six healthy tanks stay quiet.** Select `ESP32_01` → Dashboard reads
      **Tank Safe**, no banner, no SMS. Repeat for `ESP32_02`…`ESP32_06`.
      `=>` readings drift slightly and the history chart trends rather than flat-lines
- [ ] **D2. `ESP32_07` warns then goes critical.** ~70 s in (14 cycles × 5 s).
      `=>` amber WARNING, then CRITICAL at 32.65 °C
      `=>` the alert **persists** well past the 5-second floating toast
      `=>` the "How to fix" guidance names temperature
- [ ] **D3. `ESP32_08` goes critical on ammonia.** ~40 s in (8 cycles × 5 s).
      `=>` CRITICAL, ammonia 4.2 ppm
      `=>` the multi-tank banner counts **2 tanks affected**, not 1
- [ ] **D4. `ESP32_09` shows "No signal", not a warning.** ~40 s in.
      `=>` grey pill reading **No signal** / "Sensor not reporting"
      `=>` explicitly **not** amber, and **not** counted in the affected-tanks banner
- [ ] **D5. `ESP32_10` goes offline.** It stops after 10 posts, ~63 s in
      (13.5 s stagger + 10 × 5 s).
      `=>` after `DISCONNECT_STALE_MS`, the tile shows **Offline — last data**
      `=>` its last three readings are still visible, dimmed
      `=>` the other nine are unaffected

> If D2/D3 never trip, check your thresholds before suspecting a bug. The
> scenarios are tuned to the **intended** safe range (temp 20–31 °C, water
> 10–100 %, ammonia 0.25–1.0 ppm). An edited `temp_max` of e.g. `49.9` means
> 34 °C is comfortably legal and nothing will ever warn — and 49.9 °C kills
> crayfish in minutes, so treat that as a config bug. See
> [MOCK_DEVICE.md §7](./MOCK_DEVICE.md#7-important-check-your-thresholds-first).

---

## Phase E — Multi-tank surfaces

- [ ] **E1. Tank selector lists all ten** and switching between them keeps
      charts, thresholds and history scoped to the selected tank
- [ ] **E2. Live Tank Bar** shows the freshest reading per tank without a DB hit
      (`GET /devices/latest`)
- [ ] **E3. Historical Data** — pick `ESP32_08`, confirm the ammonia ramp is
      visible as a curve; confirm the chart does **not** mix in the other nine
- [ ] **E4. PDF / report export** names the correct tank and location
- [ ] **E5. Logs page** attributes rows per device, not globally
- [ ] **E6. SMS** — if you muted in the pre-flight step, confirm the mute held.
      If you deliberately left it live, confirm exactly **2** messages went out
      (`ESP32_07`, `ESP32_08`) and not ten

---

## Phase F — Poller concurrency ceiling

`services/devicePoller.cjs` sets `MAX_CONCURRENCY = 10` and polls in
`ceil(n / 10)` batches. Ten devices is the first fleet size that fits in a
**single** batch — two fewer than the current `fleet` profile needs is precisely
the point at which a fleet stops splitting.

- [ ] **F1.** In the server log, the boot line reads
      `[POLL] ESP32 status poller started (every 5s, up to 10 concurrent, timeout 2000ms)`
- [ ] **F2.** `curl.exe -s -H $H "http://localhost:3000/devices?include_archived=1"`
      `=>` all ten have `last_health_seen: null` — the poller excluded them for
      having no IP. This is correct, not a failure (see *Before you start* #2)
- [ ] **F3.** Ten simultaneous ingest streams do **not** trip the per-device rate
      limit (12 posts/sec per `device_id`); at 5 s intervals you are far under it
- [ ] **F4.** To actually exercise the poller's batch path you need real IPs.
      Run Phase E/F of [TESTING_MULTI_TANK.md](./TESTING_MULTI_TANK.md) with
      hardware instead — the mock cannot reach `http://<ip>/status`

---

## Phase G — Console is clean

- [ ] **G1.** Server log has no unhandled rejections, no `ECONNREFUSED` storm, no
      `Auto-registered unknown device_id` warnings (Phase B should have prevented them)
- [ ] **G2.** Browser console has no errors and no React key warnings across all
      ten tank switches
- [ ] **G3.** Frontend poll of `GET /devices` and `GET /devices/latest` does not
      back off (both pause on a hidden tab and back off exponentially on failure —
      switching tabs repeatedly and returning should show a clean recovery, not a
      permanently degraded poll)

---

## Phase H — Teardown

`Ctrl+C` the mock. Nothing needs reverting for the run itself, but the ten rows
persist and will keep filling the history charts with simulated points.

- [ ] **H1.** Archive the ten on Devices → archive icon. Archiving **retires the
      IDs permanently** — they can never be reused. Use this for a fleet you are
      done with; use the pencil (Active off) instead if you want to hide them and
      keep the IDs reservable
- [ ] **H2.** Delete the `sensors` rows for the ten if the charts are now
      unusable. **This is destructive and not reversible** — back up first
- [ ] **H3.** Unmute SMS if you muted it
- [ ] **H4.** `GET /devices` shows no `registered_via='auto'` rows you did not intend

---

## Known limits of this test

| Limit | Consequence |
|---|---|
| Mocks post from loopback → `ip_address` stays `NULL` | Health poller skips all ten. No `last_health_seen`, no live-check button, no poller batching |
| No real `GET /status` endpoint behind the ten | Device-level health failures are untestable with mocks |
| Firmware is not involved | Config-portal Device ID, WiFi backoff, watchdog, safe mode and NVS are all untested — see the `fleet10` firmware changes separately |
| History accumulates | Repeated runs fill the charts with simulated points. Use the Logs page to separate real hardware from simulated |
| Mock uses the server clock | `read_at` is omitted deliberately so the server timestamps every row |

---

## Files

| File | Purpose |
|---|---|
| `scripts/mock-device.config.js` | The `fleet10` profile — plain data, no code |
| `scripts/mock-device.js` | The CLI. One runner per device; `staggerMs` spaces the starts |
| `services/devicePoller.cjs` | `MAX_CONCURRENCY`, the `ip_address IS NOT NULL` filter |
| `server.cjs` | `POST /devices` (201/200/409), `POST /sensor` upsert, `normalizeClientIp` |
| `src/pages/DevicesPage.tsx` | Add Device form, provenance badges, `OnlineDot` |

**Changing the fleet:** edit the `devices` array in `PROFILES.fleet10`. To use
different IDs, change them there *and* in the Phase B list together — a mismatch
is exactly what the "Auto-discovered" badge is telling you about.
