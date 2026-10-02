# TESTING GUIDE - CRAYvings Aquaculture Monitoring System

**Written:** 2026-09-28
**Purpose:** one ordered, checkable procedure for proving the system works - from
"it compiles" through to "a real board on a real tank survives a power cut".

Work this file **top to bottom**. Phases A-C need nothing but this laptop and
prove most of the backend. Phases D-F need a board in hand. Phase G is the
end-to-end run and Phase H is the sign-off sheet.

**Rules for this document**

- Tick the box only when you have seen the evidence, not when you expect it.
- Log the actual output next to `=>` when a step fails. A failing step with a
  pasted log is worth ten that "looked fine".
- Do not skip Phase A. Every later phase assumes the server is up and the
  database is migrated; a red herring later is almost always this phase.
- Never run a test against a database you care about without reading Phase C.6
  (cleanup) - two suites write to the live `devices` table.

---

## Phase A - Environment and baseline

### A.1 Toolchain present

- [ ] `node --version` reports v20 or newer.
- [ ] `npm install` completes with no errors:

```bash
npm install
```

- [ ] Postgres is reachable. From PowerShell:

```bash
Test-NetConnection -ComputerName localhost -Port 5432
```

Expect `TcpTestSucceeded : True`.

### A.2 Configuration

- [ ] `.env` exists (copy `.env.example` if not) and these are set:

| Key | Meaning | Notes |
|-----|---------|-------|
| `PG_*` | database connection | must match a database that already has the schema |
| `PORT` | API port | default `3000` |
| `DEVICE_SECRET` | shared fleet secret | boards still using it authenticate with this |
| `DELTA_LOGGING_ENABLED` | change-only row writing | keep `true`; the heartbeat path is part of what we test |

### A.3 Migrations applied and idempotent

Migrations 010-015 must be recorded. Re-running is safe by design - every one of
them is idempotent, and 014 is the one that used to fail open.

```bash
node db/migrations/014_device_registration.cjs
node db/migrations/015_device_secret_rotation.cjs
```

- [ ] Each exits `0` and reports success. Migration 014 must specifically print
      that `idx_devices_device_id_ci` is **present and UNIQUE** (not merely
      "present").
- [ ] Run 014 a **second** time and confirm it is still clean. A migration that
      only works once is a defect, not a pass.
- [ ] Confirm the ledger has all 15 rows with real timestamps:

```bash
node -e "require('dotenv').config();const{Pool}=require('pg');const p=new Pool();p.query('SELECT version,name,applied_at FROM schema_migrations ORDER BY version').then(r=>{console.table(r.rows);return p.end()})"
```

Expect versions `001`-`015`, every `applied_at` populated.

### A.4 Server up

```bash
npm start
```

Leave it in its own terminal for the whole session. Every suite in Phase B talks
to it over HTTP.

- [ ] The terminal shows the listening port and no stack trace.
- [ ] From a second terminal:

```bash
curl.exe http://localhost:3000/health
```

Expect HTTP 200. **If the server is not up, every check in Phase B fails with
`status=-1` and it looks like a mass regression. It is not.** If a suite fails
en masse, check the server before you touch any code.

---

## Phase B - Automated suites

Run from the project root. Record the counts - they are the baseline.

| Command | Expected | Covers |
|---------|----------|--------|
| `npm test` | `pass 4 / fail 0` | threshold evaluation (sentinels, alert edges) |
| `npm run test:poller` | `34 checks` | health poller: batching, re-entrancy guard, timeout forwarding, failure counting |
| `npm run test:devices` | `104 checks` | registration, uniqueness, claiming, archiving, IP provenance, the `auto_registered` contract |
| `npm run test:migration` | `15 checks` | the case-insensitive unique index, 23505 rejection, blocked path, re-run path |
| `npm run test:secrets` | `65 checks` | per-device secret rotation, grace window, revocation, no secret leaks, wrong-length secret rejection |
| `npm run test:sessions` | `31 checks` | cookie session: issued, HttpOnly/SameSite, no token in body, cookie-only auth, logout revocation, re-login invalidation, CSRF, activity-log attribution |
| `npm run test:all` | all of the above except `test:sessions`, then `test:regression` | see B.7 for the expected final failure |

```bash
npm test
npm run test:poller
npm run test:devices
npm run test:migration
npm run test:secrets
```

`test:sessions` runs separately and is not in `test:all`:

```bash
npm run test:sessions
```

- [ ] Each suite prints its `=== ALL ... PASSED ===` line and a zero `FAIL` count.
- [ ] `test:devices` reports **104** checks. If it reports 98, you are running an
      older copy of the suite - the six `auto_registered` checks are missing.
- [ ] `test:secrets` leaves no test users behind: it should print
      `PASS  no test users left  -> 0 rows`.
- [ ] `test:secrets` reports **65** checks. Section G covers the constant-time
      secret comparison: a 1-char, empty, or same-length wrong secret must give
      a 401, never a 500 (`timingSafeEqual` throws on a length mismatch, and a
      misconfigured board hitting a 500 drops its readings silently).
- [ ] `test:sessions` reports **31** checks and leaves no test user behind.

> `test:sessions` is the only suite that calls `POST /auth/login`, which the
> server rate-limits to 5 attempts per 15 minutes per IP; the suite uses 4. Run
> it once per window. A `429` means the budget is spent, not that sessions
> broke - it prints an explanatory message instead of failing the cookie checks.

### B.1 The `auto_registered` contract (new - test it deliberately)

This is the firmware/registration-mismatch signal. Prove both halves by hand:

```bash
curl.exe -X POST http://localhost:3000/sensor -H "Content-Type: application/json" -H "X-Device-Secret: YOUR_SECRET" -d "{\"device_id\":\"BENCH_NEW_BOARD\",\"temperature\":26,\"water_level\":50,\"ammonia\":0.1}"
```

- [ ] The response body contains `"auto_registered":true`. This is a board the
      dashboard had never seen; the server created the row and logged a warning.
- [ ] Post the **identical** body again (same temperature/level/ammonia):

```bash
curl.exe -X POST http://localhost:3000/sensor -H "Content-Type: application/json" -H "X-Device-Secret: YOUR_SECRET" -d "{\"device_id\":\"BENCH_NEW_BOARD\",\"temperature\":26,\"water_level\":50,\"ammonia\":0.1}"
```

- [ ] This time you get HTTP 200, `"skipped":true` and `"auto_registered":false`.
      That is the delta-logging heartbeat: the row was not written again, but
      `last_seen` was refreshed and the mismatch flag is correctly off.
- [ ] Change one value by more than its tolerance (`temperature` 30) and post
      again: expect HTTP 201 with `"auto_registered":false`.
- [ ] The server terminal logged, once:
      `Auto-registered unknown device_id 'BENCH_NEW_BOARD' from its first POST /sensor.`

> A 200 `skipped` response is only reachable when the payload carries ammonia. A
> temperature-only repeat is treated as "the ammonia channel changed" and writes
> a row. That is expected, not a bug.

### B.2 Re-verify the case-insensitive uniqueness guarantee

```bash
curl.exe -X POST http://localhost:3000/devices -H "Content-Type: application/json" -H "Authorization: Bearer ADMIN_TOKEN" -d "{\"device_id\":\"esp32_02\",\"device_name\":\"Case Variant\"}"
```

- [ ] Rejected with HTTP 409 - a lowercase variant of an existing ID is the
      same identity. Repeat with `ESP32_02` and confirm it is also 409.
- [ ] `npm run test:migration` proves the index is genuinely UNIQUE rather than
      merely present, and that a case variant insert fails with sqlstate 23505.

### B.3 Secrets never leak on a read path

- [ ] `GET /devices` (with an admin token) contains **no** `device_secret` and no
      `device_secret_prev` keys. It may contain `device_secret_rotated_at` and
      `device_secret_prev_expires_at` - metadata, not secrets.
- [ ] The same for `GET /devices/:id/status` and for the response body of
      `PUT /devices/:id`.
- [ ] The activity log records that a rotation happened, never the value.
- [ ] `npm run test:secrets` asserts all of the above; treat a manual green light
      with a red suite as the suite being right.

### B.4 Role gates

- [ ] Log in as a non-admin. Every Devices-page write returns 403: register,
      rename, hide, archive, restore, rotate-secret.
- [ ] A non-admin does not see "Devices" in the sidebar at all.
- [ ] `GET /devices` and `GET /sensor/stream` still work for a non-admin - the
      page is hidden, not the read access.

### B.5 Injection and input validation

- [ ] `POST /devices` with `device_id` = `ESP32'; DROP TABLE devices;--` is
      rejected and the `devices` table is still there afterwards.
- [ ] `device_id` containing a space, a slash or a `!` is rejected - this is the
      exact rule the firmware now enforces. The dashboard and the board share one
      contract: letters, numbers, `.`, `_`, `-`, max 50 characters.
- [ ] A device_id of exactly 50 characters is accepted; 51 is rejected.

### B.6 Cleanup after Phase B

- [ ] `BENCH_NEW_BOARD` is gone from the Devices page, and
      `npm run test:devices` reports `no test devices left`.

### B.7 The one expected failure

```bash
npm run test:all
```

- [ ] Everything passes **except** `test:regression`, which exits 2 with:

```
No sensor history for ESP32_01 - the per-tank scoping checks need it. Skipping.
```

This is pre-existing and unrelated. The regression suite needs real history for
`ESP32_01`, which the database does not have. It is not a regression; do not
"fix" it by editing the suite. It will run properly once a board has posted
`ESP32_01` data (Phase G).

---

## Phase C - Build and static gates

```bash
npm run build
npx eslint src server.cjs db/migrations tests
npm run check:encoding
```

- [ ] `build` ends `built in ...` with no TypeScript errors. (`tsc -b` runs first,
      so a type error fails here even though Vite would happily bundle.)
- [ ] `eslint` prints nothing.
- [ ] `check:encoding` reports no mojibake. If it flags a file you just edited,
      the editor saved it in the wrong encoding - fix it, do not ignore it.
- [ ] Re-run `npm run test:devices` after the build. A `dist` change must not
      affect API behaviour, and this proves it.

---

## Phase D - Backend behaviour without hardware (mock device)

The mock speaks the same protocol as a board, so this exercises ingest, SSE,
alerting, delta logging and the fleet views end to end.

### D.1 Single tank

**Terminal 2:**

```bash
npm run mock
```

- [ ] Readings appear on the dashboard within a few seconds and the tank shows
      "Safe".
- [ ] The server terminal logs one line per accepted POST.
- [ ] Stop with `Ctrl+C`; the dashboard degrades gracefully rather than freezing.

### D.2 The mismatch warning, mock side

```bash
npm run mock -- --device ESP32_UNREGISTERED_BOARD
```

- [ ] The device is auto-registered and badged "Auto-discovered" on the Devices
      page.
- [ ] Claiming it with **Add Device** using the same ID succeeds and does **not**
      create a second row - the existing row is adopted in place, keeping its
      readings and learned address.
- [ ] Claiming it a second time returns 409. A claimed device is a normal
      duplicate from then on.
- [ ] Clean up: archive the row afterwards so it does not pollute the fleet.

### D.3 Two tanks, per-tank scoping

```bash
npm run mock -- --profile fleet
```

- [ ] Two devices post on different profiles.
- [ ] Switching tanks on the dashboard changes the live tiles, the chart and the
      analytics - and the switch takes effect **immediately**, without a page
      reload. (The SSE connection is torn down and reopened on the new tank; if
      a stale tank's numbers ever bleed through, that is a real bug - report it.)
- [ ] A tank whose readings are out of range raises an alert on the fleet banner
      and the per-tank badge, and the two never disagree.

### D.4 Threshold and alerting behaviour

```bash
npm run mock -- --profile ammonia_spike
npm run mock -- --profile failed_ammonia
npm run mock -- --list-profiles
```

- [ ] A critical reading raises a visible alert **and persists past the toast**
      - it is not a 5s flicker.
- [ ] A dead probe renders as "No signal" rather than a false warning. A failed
      sensor is stored as NULL, never as a number.
- [ ] Nothing is written for a reading identical to the last one, but the
      dashboard still shows a live timestamp (heartbeat semantics, see B.1).

### D.5 Live-stream resilience

- [ ] With the dashboard open, stop and restart the server. The dashboard
      reconnects on its own and recovers without a manual reload.
- [ ] Background the tab for a minute, then return. Readings resume.
- [ ] Switch tanks while the stream is disconnected; the reconnect must use the
      **new** tank's filter.

---

## Phase E - Dashboard UI walkthrough

Log in as admin. Tick each row.

### E.1 Registration and validation

- [ ] Add Device rejects a bad `device_id` inline, with a message naming the
      rule - before the server is even involved.
- [ ] Add Device accepts a valid one and the tank appears, Online.

### E.2 Editing a tank

- [ ] The pencil button opens the inline editor.
- [ ] `Device Name` is required; leaving it blank is refused with a field error.
- [ ] The device ID is not editable and is labelled as permanent.
- [ ] **Leave the IP blank when you do not mean to set it.** A blank field is
      omitted from the request on purpose: sending `""` would store an empty
      address while still marking it `ip_source='manual'`, and since the ingest
      upsert refuses to overwrite a manual address, the board could never learn
      its real IP again and the health poller would skip the device forever.
- [ ] Known limitation, by design: an IP cannot be cleared back to "learned"
      from the UI.

### E.3 Manual IP protection (the thing that bites people)

- [ ] Set an IP on a device that is posting from a real LAN address.
- [ ] Reload. The IP you typed is still there - the board's own POSTs did not
      overwrite it (`ip_source='manual'`).
- [ ] Now compare with a device whose IP was *learned* (`ip_source='auto'`): that
      one follows the board across a DHCP change. Both behaviours are correct and
      they are deliberately different.

### E.4 Archiving - the new warning

- [ ] Click **Archive** on a row. The inline confirmation shows a red
      **"ID permanently retired"** label, and the button's hover text says the ID
      can never be registered again.
- [ ] Confirm. The tank leaves every active view (dashboard, tank selector,
      analytics, live grid) and its readings are all still in the database.
- [ ] Try to register a new device with the archived ID: **409**. Try the
      lowercase variant: also 409. This is permanent by design.
- [ ] **Restore** brings the same row back with all its history and no
      duplicate. A restored device does not re-fire a disconnect alert for its
      pre-archive `last_seen`.

### E.5 Device secret rotation

- [ ] **Secret** on a row offers a grace window. Default 24h; 0 revokes
      immediately.
- [ ] The new secret is shown **once**, is selectable and copyable, and the panel
      says plainly that it cannot be retrieved again.
- [ ] The outgoing secret keeps working until the deadline, then fails with 401.
      Immediately after a rotation the device is never momentarily locked out -
      the swap is a single atomic UPDATE.
- [ ] A device still on the shared `DEVICE_SECRET` cannot be rotated; the 409 is
      reframed as a migration offer. Using it issues that device's **first**
      per-device secret and reports how many devices are still on the shared one.
- [ ] **Accepted risk:** the shared `DEVICE_SECRET` still authenticates the whole
      fleet. Rotating a per-device secret does not revoke it. This was a
      deliberate decision, not an oversight - see Phase G.3 for the cutover.

### E.6 Non-admin view

- [ ] Log in as a plain user: no Devices entry in the sidebar, no Settings
      write controls, and every direct API write returns 403.

---

## Phase F - Hardware bench tests (need a board)

All of the firmware below is **code-complete but unverified** - there is no C++
toolchain and no board in the dev environment, so these were written by reading
only. Flash and run them. Each has a serial-log signature that proves it.

> Open the serial monitor at **115200** first. Every step below keys off what the
> board prints.

### F.1 First boot and config portal

- [ ] Triple-tap the **top-left** corner, or send `W` over serial.
- [ ] The board opens AP `Aquaculture-Setup`; join it and open
      `http://192.168.4.1`.
- [ ] The portal loads. (The status server releases port 80 for the portal; if
      the page does not load, that release is the first thing to suspect.)
- [ ] Enter WiFi details and save. The board reboots and connects.

### F.2 Server IP (F2 - the `.10` octet fix)

- [ ] With no server IP entered, the board auto-derives it from the WiFi subnet
      plus host octet `.10`. Confirm the serial line
      `[CONFIG] server=...` and that readings arrive.
- [ ] **Confirm the server really is at `<subnet>.10`.** This was an assumption
      when it was changed from `.20`; the config AP `192.168.4.1` is unrelated and
      proves nothing about it.
- [ ] Entering an explicit server IP overrides the derived one.

### F.3 Device ID (F1 - NVS-backed, F3 - now validated)

In the config portal, the Device ID field must read
`Device ID (letters, numbers, . _ - only; max 50)`.

| # | Enter | Expected serial output | Expected effective ID |
|---|-------|------------------------|----------------------|
| 1 | `TANK_A` | `[CONFIG] Device ID set to 'TANK_A'` | `TANK_A` |
| 2 | `TANK_B` | `[CONFIG] Device ID set to 'TANK_B'` | `TANK_B` |
| 3 | reboot | `[CONFIG] server=... device_id=TANK_B ...` | `TANK_B` (survives via NVS) |
| 4 | *(empty)* | `[CONFIG] Device ID was blank; keeping 'TANK_B'` | `TANK_B` - **never an empty post** |
| 5 | `Tank 1!` | `REJECTED ... '!' is not allowed at position 6` + `Keeping the previous device ID` | unchanged |
| 6 | `TANK C` (space) | `REJECTED ... ' ' is not allowed at position 5` | unchanged |
| 7 | 51 characters | `REJECTED ... 51 characters, the dashboard allows at most 50` | unchanged |
| 8 | exactly 50 characters | `Device ID set to '...'` - **not** truncated | full 50 chars |

- [ ] Steps 5-7 are the F3 fix. Before it, the board silently truncated at 49 and
      accepted any character, which produced device rows the dashboard could
      never register or reuse.
- [ ] In every rejected case the board keeps reporting under its **previous** ID.
      Data never stops because of a typo in the portal.
- [ ] Register `TANK_B` on the Devices page, then confirm the mismatch warning
      does **not** appear. Rename the board to something unregistered and confirm
      it appears **once** (not on every POST):

```
[HTTP] WARNING: the dashboard did not know this device - it
[HTTP] auto-registered us as an 'Auto-discovered' tank. ...
```

### F.4 MQ-137 ammonia calibration

- [ ] On a first boot with no stored R0, the board runs clean-air calibration and
      shows `Sample n/10` progress. Keep the sensor in clean air.
- [ ] After success: `[MQ-137] Loaded R0 = ... from NVS` on the next boot. **A
      firmware update does not force re-calibration** - that happens once ever,
      and only if a calibration actually succeeded.
- [ ] With the sensor deliberately fouled, calibration is **rejected** (outside
      the 5-200 kOhm window) and ammonia reads as ERROR rather than reporting a
      confident wrong number. That is the intended failure mode.
- [ ] Triple-tap the **top-right** corner to recalibrate on demand; the ~5s
      progress screen is expected and the 30s watchdog is nowhere near at risk.

### F.5 Status endpoint and health poller

- [ ] From any machine on the LAN: `curl http://<board-ip>/status` returns JSON
      with the board's own `device_id`.
- [ ] The dashboard shows the tank Online, and `last_health_seen` advances.
- [ ] Power the board off. Within a few cycles the dashboard shows Offline. It
      must **not** spam SMS more than once per cooldown window, and the restart
      must not raise a second alert.
- [ ] Power it back on. It returns Online with no manual reload.

### F.6 Config portal and the health poller together (F4 - open question)

- [ ] Start a config portal session and leave it open for two minutes. Watch the
      server terminal: the health poller logs unreachable warnings for the board
      while the portal holds port 80.
- [ ] This is **known and currently accepted**: the warning is log noise only. It
      is not a false "Offline" badge, and it cannot send SMS. Decide whether that
      is acceptable for your farm, or whether the status server should move to
      port 81 (which would also need the poller, `/devices/:id/status`, the docs
      and the tests updated).
- [ ] Close the portal and confirm the status server comes back on port 80 and
      the poller recovers. If the board never answers `/status` again after a
      portal visit, that is a new and serious bug - report it.

### F.7 Per-device secret cutover (needs physical access, by nature)

- [ ] Rotate a device's secret from the Devices page with a 24h grace window.
- [ ] Paste the new secret into the board's config portal, save, and reboot.
- [ ] Confirm readings resume and the board authenticates with the **new**
      secret. Then confirm the old one stops working once the window closes.
- [ ] Do this for **every** device before treating the shared secret as retired.

---

## Phase G - End-to-end, all tanks

- [ ] Every real board is registered on the Devices page with the ID it actually
      reports, `registered_via='manual'`, and a correct `ip_address` /
      `ip_source='manual'`.
- [ ] No board is still flagged "Auto-discovered".
- [ ] The fleet view lists every tank with a sensible name and location.
- [ ] Two or more tanks are posting; switching between them scopes every page
      correctly and the fleet banner reflects the whole farm.
- [ ] `GET /devices` shows no `registered_via='auto'` rows you did not intend.

### G.3 Migrating off the shared secret (only when you decide to)

Until this is done, the shared `DEVICE_SECRET` is fleet-wide exposure: it still
authenticates any board, and rotating a per-device secret does not revoke it.

1. For each active device: **Secret** -> migrate from shared. Note the reported
   `devices_still_on_shared_secret` count as it falls.
2. When the count reaches 0, the fleet is on per-device secrets.
3. Only then add the switch that stops accepting the shared secret. Doing this
   earlier locks out boards that are not provisioned yet.

---

## Phase H - Failure and edge testing

Do these deliberately; they are the cases that are never found by accident.

| # | Scenario | Expected |
|---|----------|----------|
| H.1 | Kill the server mid-session | Dashboard reconnects by itself; no manual reload; no stuck skeletons |
| H.2 | Power-cut the board | Readings resume after reboot; no duplicate `sensors` rows for one reading; calibrated R0 survives |
| H.3 | Board Wi-Fi drops for 2 min | Readings buffer and flush oldest-first on reconnect; no gap in the chart beyond the outage |
| H.4 | Board on a hotspot, then back | `ip_source='auto'` follows the new address; `ip_source='manual'` does not |
| H.5 | Unplug the board's probe | Reading shows "No signal"/NULL; **no** false threshold alert |
| H.6 | 12 boards posting at once | No stacked poll cycles in the server log; the poller logs skipped ticks rather than doubling load |
| H.7 | A slow board (>2s `/status`) | One warning at the threshold, then rate-limited; cycles never overlap |
| H.8 | Empty `ESP32_01` history | `test:regression` skips with its documented message; it is not a crash |
| H.9 | Two browsers, different tanks | Each browser sees only its own tank; no cross-talk |
| H.10 | Restart the DB | Server reconnects; migrations report already-applied; no data loss |

---

## Phase I - Sign-off

Everything below must be ticked before the system is called verified.

**Automated**
- [ ] `npm test` 4/4 · `test:poller` 34/34 · `test:devices` 104/104 ·
      `test:migration` 15/15 · `test:secrets` 60/60
- [ ] `npm run build` clean · `eslint` clean · `check:encoding` clean
- [ ] `test:regression` either passes, or skips with the documented
      `No sensor history` message

**Backend**
- [ ] `auto_registered` behaves on created / refreshed / heartbeat / registered
- [ ] Case-insensitive device IDs rejected with 409
- [ ] Secrets absent from every read path; rotation + grace + revocation work
- [ ] Role gates hold for non-admins; injection attempts rejected

**UI**
- [ ] Add / Edit / Claim / Archive (with the permanent-ID warning) / Restore
- [ ] Manual vs learned IP behave differently, and deliberately so
- [ ] Tank switching re-scopes live, chart and analytics with no reload

**Hardware**
- [ ] Config portal loads and saves
- [ ] Server IP auto-derives to the real server
- [ ] Device ID: set, persists, blank falls back, bad charset/length rejected
- [ ] `/status` answers and drives Online/Offline
- [ ] Ammonia calibrates once and survives reboot

**Known, accepted**
- [ ] Shared `DEVICE_SECRET` still accepted fleet-wide (Phase G.3)
- [ ] F4 portal-window poller log noise (F.6)
- [ ] `online` does not require a recent health check - a fresh sensor POST
      masks a failing health poll. Deliberate product behaviour; revisit if you
      want a board that posts data but is unreachable to show as Offline.

**Tested by:** ____________________  **Date:** ____________
**Hardware used:** ____________________________________

---

## Where to look when something fails

| Symptom | Look at |
|---------|---------|
| Board not appearing on the dashboard | `docs/DEVICES_MODULE_HOWTO.md`, then the Devices page "Auto-discovered" badge |
| Whole test suite red with `status=-1` | The server is not running. Check A.4 before reading any code. |
| 401 from a board | Device secret mismatch - the firmware's `X-Device-Secret` vs the server's |
| Device shows Offline but is posting | The health poller and the Online badge use different clocks; see the sign-off note |
| Board reboots when the portal opens | Watchdog budget - `esp_task_wdt` is re-armed around the portal deliberately |
| Reading is blank or "No signal" | Failed-sensor sentinels are stored as NULL on purpose; check wiring before suspecting the server |
| Data is stale but the dashboard is open | SSE reconnect path (D.5) |

## Related documents

- `docs/HOW_IT_WORKS.md` - system design and data flow
- `docs/DEVICES_MODULE_HOWTO.md` - device registration, archiving, rotation
- `docs/DATABASE_SCHEMA.md` - tables, columns, indexes
- `docs/MOCK_DEVICE.md` - simulating a board without hardware
- `docs/TESTING_MULTI_TANK.md` - the original star-topology test run
- `docs/HTTPSMS_SETUP.md` - SMS gateway

---

*Created: 2026-09-28 · Replaces the previous audit and resume notes*
