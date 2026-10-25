# FOR CAPSTONE CHECKING - Hostile Defense Audit

**Project:** IoT-Based Smart Aquaculture Monitoring System for Crayfish Production (CRAYvings Monitoring System)
**Audit type:** Three-examiner hostile defense simulation (embedded/IoT hardware, full-stack/security, aquaculture/research methodology)
**Evidence basis:** Repository code only. No sensor-calibration dataset, no hardware test log, and no wiring schematic image exist in the repository. Those are treated as "does not exist."

---

## 0. STATUS ADDENDUM (2026-10-18, updated 2026-10-25)

The audit below was written **before** migrations `000` and `022`–`025` were
applied to the live database. Each affected finding was re-verified against the
live catalog on 2026-10-18:

| Finding | Status | Evidence |
|---|---|---|
| **E1 / §2 item 4** — "8 of 14 tables not creatable from the repo" | **Resolved** | `db/migrations/000_baseline.cjs` is ledger-tracked (`000 baseline`), applied, and creates every table including `last_alerts`; `full_schema.sql` exported at repo root. The system has **16** tables — every "14 tables" count below is obsolete. |
| **E2** — `DEFAULT 0` vs `CHECK > 0` on sensors | **Resolved** | `022_sensor_defaults` applied; every `sensors` numeric column now has `column_default = NONE`; CHECKs unchanged and consistent. |
| **E4** — `last_alerts` composite key "only external" | **Resolved** | `db/migrations/000_baseline.cjs:178` creates `PRIMARY KEY (device_id, sensor_key)`; catalog shows `last_alerts_pkey`. |
| **E5** — ammonia precision `(5,2)` docs vs `(5,3)` code | **Resolved** | Live `sensors.ammonia` = `numeric(5,2)`; `server.cjs` binds `(5,2)`; docs and code agree. |
| **Fix plan #6** — "ship a bootstrap schema migration" | **Done** | `000_baseline.cjs` (idempotent, ledger-recorded). |
| **§8 Q7** — self-quiz answer "8-of-14" | **Answer changed** | Now: all 16 tables are creatable from `db/migrations/000_baseline.cjs`. Memorizing "8-of-14" would be wrong. |
| **B1** — shared `DEVICE_SECRET` lets a device post as any `device_id` | **Partially addressed** | Per-device `devices.device_secret` + rotation now exist (`test:secrets` 65/65); boards still on the shared secret are logged at `server.cjs:2887`, so the spoofing surface remains until each is rotated. |
| **D3** — README contradicts itself on ingest rate (12/sec vs 3/sec) | **Resolved** | Every README mention now says 12/sec/device; the server's `sensorIngestLimiter` is 12/sec keyed by `device_id`. |

Also resolved since the original 2026-10-18 addendum: **E3** (the four-table retention/purge schedule,
including the 30-day `sensors` purge, is now documented in `docs/DATABASE.md`), and
the account "deletion" flow described in the audit now **archives** the account
(restore/purge are separate endpoints) with the approval OTP mailed to the owner.
Every finding not listed above stands unchanged.

Two citation notes: `docs/system-audit-2026-10-05.md` (cited in §1, §4, §5)
**no longer exists in this repository** — treat those citations as dead; and the
"277 passing checks" figure is stale (suites as of 2026-10-18: devices 104/104,
secrets 65/65, sessions 60/60, regression all-pass). Paths written
`migrations/...` mean `db/migrations/...`.

---

## 1. VERDICT

**Score: 44/100 - this system would NOT survive a hostile defense today.**

The software is the strong half and would score in the 70s on its own: the Express backend avoids SQL injection, hashes sessions/OTPs/passwords correctly, has a real SSE pipeline, bounded concurrency in the poller, a circuit breaker, and 277 passing automated checks (`FIX-LATER.md:20`). The **capstone is the other half, and it is not defended by any artifact in this repo.** There is zero measured sensor accuracy, the ammonia sensor physically measures the wrong phase of the analyte (NH3 gas in air, not dissolved ammonia in water - the firmware's own UI says so at `ESP32_main_code.ino:2189`), every water-level percentage rides on a self-declared placeholder constant (`ESP32_main_code.ino:92`), the thresholds have no cited source (`src/types/index.ts:96`), and 8 of the 14 tables cannot be created from anything in the repository. A panelist does not need to be hostile to fail this - they only need to ask "show me your validation data," and there is none.

---

## 2. TOP 5 DEFENSE-KILLERS (ranked)

1. **The ammonia measurement is the wrong analyte.** MQ-137 is a metal-oxide *gas* sensor; the firmware labels its own value `"NH3 gas concentration in air"` (`ESP32_main_code.ino:2189`) and every threshold is in gas-ppm, but the project claims to monitor ammonia in a crayfish tank and applies water-quality thresholds of 0.25-1.0 ppm (`src/types/index.ts:102-103`). Dissolved un-ionized ammonia is a *different* quantity and is strongly pH- and temperature-dependent. There is no reference-instrument calibration anywhere.
2. **No sensor accuracy evidence exists.** No comparison to a thermometer, ruler, ammonia test kit, or known solution; no sample size, error, or repeatability. The only "tests" are software-unit suites. `docs/system-audit-2026-10-05.md:116` admits the full stack is "Not verified."
3. **Every water-level percentage is computed from a placeholder.** `#define WATER_FULL_CM 8.0f // <<< PLACEHOLDER - MEASURE THIS` (`ESP32_main_code.ino:92`); the formula divides by `(empty_cm - full_cm)` (`docs/DATABASE.md:243`), so until that distance is measured all reported percentages - and therefore all low/high-water alerts - are wrong.
4. **The database cannot be provisioned from the repository.** 8 of 14 tables (`users`, `devices`, `sensors`, `sensor_settings`, `system_logs`, `last_alerts`, `activity_logs`, `system_state`) have **no `CREATE TABLE` anywhere**; there are no `.sql` files and `.gitignore` blocks them. A grader following `README.md:152-211` cannot stand the system up.
5. **Integrity holes a security examiner will find in five minutes:** the shared `DEVICE_SECRET` lets any device post readings as *any* `device_id` and auto-register arbitrary IDs (`server.cjs:1985-1986`, `2141-2178`); archived devices keep ingesting and can still trigger disconnect SMS (`server.cjs:1551-1553`); and per the project's own audit, live `.env.new` credentials and a personal-data DB dump were tracked on `master` (`FIX-LATER.md:62-63`).

---

## 3. FULL FINDINGS TABLE

Severity key: **C** = Critical, **M** = Major, **m** = Minor.

| ID | Area | Sev | Finding | Evidence | Fix | Defense proof |
|---|---|---|---|---|---|---|
| H1 | Hardware/Sensor | **C** | MQ-137 measures NH3 gas in air, not dissolved ammonia; claim unvalidated | `ESP32_main_code.ino:2189`, `:548-563`; thresholds `src/types/index.ts:102-103` | Reframe as "ammonia gas proxy / trend indicator," or calibrate against a reference in-water analyzer and compensate for pH/temp; at minimum add a lab-derived conversion + disclaimer | Show a paired dataset: MQ-137 vs a certified ammonia test kit, with R2 |
| H2 | Hardware/Sensor | **C** | MQ-137 R0 calibrated in ~5 s with no burn-in enforced (code warns "minutes") | `ESP32_main_code.ino:1514-1515`, `1525-1553`, `1600` | Enforce 24-48 h burn-in before calibration; log it | Reboot a cold board, show `-1.0` on `/status` until valid |
| H3 | Hardware/Sensor | **C** | HC-SR04 ECHO is 5 V; no level shifter in code, wiring unproven | `ESP32_main_code.ino:109-111`, `3134`; no schematic in repo | 1k/2k divider; include schematic | Scope/logic-analyzer capture of ECHO at 3.3 V |
| H4 | Hardware/Sensor | **C** | Water-level 100% reference is a placeholder | `ESP32_main_code.ino:92`; `docs/DATABASE.md:356` | Measure real `full_cm`; store via `PUT /calibration/water-level` | Ruler-vs-% table at 5 fill levels |
| H5 | Hardware/Sensor | **M** | Speed of sound not temperature-compensated (fixed 0.0343) | `ESP32_main_code.ino:1347` | Compensate with DS18B20 temp | Error table across 10-35 C |
| H6 | Hardware/Sensor | **M** | MQ-137 saturation clamps to a *real* 500 ppm instead of NULL | `ESP32_main_code.ino:1684-1693` | Emit `-1`/NULL on saturation | Induce saturation; show NULL not 500 |
| H7 | Hardware/Sensor | **M** | No NTP; device sends no timestamp; server assigns time | grep: no `configTime`/NTP in firmware | Acceptable - document it | Explain server-side stamping |
| H8 | Hardware/Sensor | **m** | DS18B20 resolution never explicitly set; read is one cycle (~1 s) stale | `ESP32_main_code.ino:1240-1241`, `3131` | Call `setResolution(12)`; accept or fix latency | Explain lag, or fix and re-measure |
| F1 | Firmware | **M** | No flash buffering - 600-entry RAM ring lost on reboot | `ESP32_main_code.ino:735`, `749-770` | Persist to NVS/LittleFS | Pull power mid-outage; show replay |
| F2 | Firmware | **M** | No OTA path | grep: zero OTA refs | Add ArduinoOTA or document | State plan honestly |
| F3 | Firmware | **M** | NODE spare firmware is divergent & buggy: uses tank-height model (36 cm) the ESP32 code removed, no out-of-range rejection, `waterLevel` init `0.0` | `NODE_main_code.ino:68`, `146`, `787-833` | Align or don't demo NODE | Don't put two firmwares in the demo |
| F4 | Firmware | **m** | Cross-task reads of shared globals unlocked (torn floats/Strings) | `ESP32_main_code.ino:2696-2716` vs loop writes | Snapshot under a mutex | Explain race window |
| B1 | Backend/Auth | **M** | Shared `DEVICE_SECRET` authenticates *any* `device_id`; arbitrary auto-registration | `server.cjs:1985-1986`, `2141-2178` | Require per-device secrets; bind body `device_id` to auth | Try to post as another tank; expect 401 |
| B2 | Backend/Auth | **M** | Archived/hidden devices still ingest and can trigger disconnect SMS; inconsistent with per-device path | `server.cjs:2162-2235`, `1551-1553` vs `2003-2004` | Query excludes `archived_at`/`is_active` in ingest & disconnect | Archive a board; confirm it stops alerting |
| B3 | Backend/Auth | **M** | `POST /auth/users` bypasses password policy and unvalidated role | `server.cjs:3567-3573` vs `304-319` | Route through `hashNewPassword`; validate role | Create user with `"a"` -> expect 400 |
| B4 | Backend/Auth | **M** | No dedicated rate limit on OTP endpoints; no requester != verifier rule | `server.cjs:3599`, `3686` | Add limiter; enforce separation | Brute-force test -> 429 |
| B5 | Backend/Auth | **m** | Session cookie compared via SQL string equality, not `timingSafeEqual` | `server.cjs:519-521`, `584` | Pre-hash makes it low-risk; document | Explain pre-hash rationale |
| S1 | Backend/SQL | (solid) | No SQL injection found; all values parameterized | `FIX-LATER.md:106`; verification of dynamic builders | - | Point to grep |
| S2 | Backend/SQL | **m** | `INTERVAL '${hours} hours'` spliced textually (integer-coerced) | `server.cjs:3209-3213` | Parameterize interval | Explain coercion |
| A1 | Backend/Alerts | **M** | No hysteresis; 120 s dedup only blocks identical consecutive status -> flap spam | `server.cjs:1595-1607`, `1842` | Add deadband | Boundary-sweep a value; show no storm |
| A2 | Backend/Alerts | **m** | `/logs/:id/ack` and `POST /activity-logs` only need any role | `server.cjs:4680`, `4742` | Scope ack to owner of alert or admin | Attempt cross-user ack |
| E1 | DB | **C** | 8/14 tables not creatable from repo; no `.sql` | `FIX-LATER.md:64`; no `CREATE TABLE` finds | Ship bootstrap schema/migration | Fresh-DB deploy during defense |
| E2 | DB | **M** | `DEFAULT 0` on sensor columns contradicts `CHECK > 0` | `docs/DATABASE.md:279`; `migrations/009_sensor_constraints.cjs:59` | Drop default or fix check | Insert omitted column -> error |
| E3 | DB | **M** | 30-day auto-purge of `sensors`; docs' retention section omits it | `server.cjs:1736`, `1760`; `docs/DATABASE.md:781-796` | Document; raise retention | Show "all time" = 30 days |
| E4 | DB | **M** | `last_alerts` composite key & several indexes only exist externally | `server.cjs:1832`; no migration DDL | Create in a migration | `\d last_alerts` |
| E5 | DB | **m** | Ammonia precision (5,2) docs vs `(5,3)` code | `docs/DATABASE.md:245` vs `server.cjs:1666` | Reconcile | `information_schema` |
| E6 | DB | **m** | Migrations 010/011 seed `schema_migrations` without running | `migrations/010_schema_migrations.cjs:32-51`, `011:57-63` | Clean up tracking | Explain fail-open |
| D1 | Docs | **M** | No stage-by-stage hardware test *record*; only a plan | `TESTING_GUIDE.md` (checklists, no results) | Execute & record expected/actual | Produce the filled sheet |
| D2 | Docs | **M** | Overclaims "real-time/accurate/smart"; `ARCHITECTURE.md:1162` gives an "Accuracy" column | `README.md:36-43`; `ARCHITECTURE.md:1162` | Replace with measured claims | Point to data |
| D3 | Docs | **m** | README contradicts itself on ingest rate (12/sec vs 3/sec) | `README.md:55,471` vs `127` | Fix to 12 | - |
| D4 | Docs | **m** | Tank-height contradiction: brief/docs say 36 cm; ESP32 firmware removed it | `docs/system-audit-2026-10-05.md:9`; `ESP32_main_code.ino:79-83` | Pick one model | Explain |
| W1 | Frontend | **M** | Threshold logic duplicated 3x (client, server, test) | `src/types/index.ts:291-323`; `server.cjs:1595-1607`; `src/types/threshold.test.cjs:4-42` | Single source of truth | Show drift test |
| W2 | Frontend | **M** | Charts use categorical axis; gaps invisible | `TrendCard.tsx:139-142`; `client.ts:150` | Use time-scale axis | Explain sampling gaps |
| W3 | Frontend | **m** | No React error boundary | `FIX-LATER.md:67` | Add boundary | - |
| W4 | Frontend | **m** | Calibration UI absent; `saveWaterLevelCalibration` has no caller | `client.ts:427-437` | Add admin UI | Show how calibration is set |
| W5 | Frontend | **m** | Client sentinel filter only guards temperature | `client.ts:165-167` | Apply min to all | Explain server NULLs first |
| G1 | Domain | **C** | Missing DO, pH, salinity/TDS, turbidity - DO is the #1 crayfish killer | none monitored; `README.md:61-66` | Add or justify scope | Cite limiting-factor logic |
| G2 | Domain | **M** | Thresholds uncited | `src/types/index.ts:96` | Add references | Cite for 20-31 C |
| G3 | Domain | **M** | Alert gives numbers + generic fixes, but no pH/temp context that makes ammonia toxic | `src/utils/alertGuidance.ts:90-117` | Add context/actionability | Walk an ammonia scenario |
| SEC1 | Git | **C** | Per project audit, `.env.new` + personal-data dump tracked on `master` | `FIX-LATER.md:62-63` | Rotate secrets, purge history | Show repo is private + rotated |

---

## 4. UNVERIFIED LIST

Treat each as a defense risk, not a pass.

- **Sensor accuracy of any kind** - no reference-instrument comparison, no sample size, no percent error, no repeatability. (Nothing in repo.)
- **MQ-137 ppm accuracy / whether the curve matches this module** - constants claimed "fitted from datasheet (widely published)" but no dataset or reference test (`ESP32_main_code.ino:548-563`).
- **Real water-level correctness** - `full_cm=8.0` is explicitly a placeholder (`ESP32_main_code.ino:92`).
- **Power/brownout behavior** - MQ-137 heater 5 V budget and rail capacity unmeasured.
- **Wi-Fi loss / server-down data-loss rate** - ring buffer is RAM-only and untested end-to-end.
- **HC-SR04 ripple/foam/condensation/humidity behavior** - no handling, no test.
- **Long-duration stability** - no hours/days soak test.
- **Failure-injection results** - `TESTING_GUIDE.md` phases D-H are a plan, not executed.
- **Latency end-to-end** - not measured.
- **Touchscreen showing data consistent with dashboard** - not verified (`docs/system-audit-2026-10-05.md:58`).
- **SMS/email live delivery** - code reviewed only (`FIX-LATER.md:127-128`).
- **Backup/restore plan** - none documented.
- **Device clock/timestamping** - none in firmware.
- **Whether the GitHub repo is public** - decides severity of SEC1 (`FIX-LATER.md:123`).
- **Wiring diagram** - no schematic/photo in the repo (only `docs/BLOCK_DIAGRAM.drawio`).
- **Data dictionary vs live schema** - docs already disagree with SQL (E5, D3, D4); an unverified data dictionary will mismatch.

---

## 5. WHAT'S ACTUALLY SOLID (verified, cited)

- **No SQL injection.** All values parameterized; dynamic WHERE/SET built from `$n`; `sortBy` whitelisted (`FIX-LATER.md:106`; `server.cjs:4718-4790`, `4775`).
- **Password hashing is modern.** PBKDF2-HMAC-SHA512, 600k iters, 16-byte salt, constant-time compare (`server.cjs:250-278`). (Bcrypt is *not* used despite being name-dropped historically.)
- **Sessions are HttpOnly cookies, token stored SHA-256-hashed, raw token never returned** (`server.cjs:364-375`, `429-439`, `3403-3406`); 24 h expiry enforced (`324`, `594-597`). No `crayvings_token` in JS (grep: 0).
- **OTP: CSPRNG, salted-hash, TTL, 5-attempt cap, one-shot, row-locked** (`server.cjs:648-657`, `3693-3741`).
- **Device secret compare is constant-time and fails closed if unset** (`server.cjs:1985`, `659-663`; boot warning `5397-5399`).
- **SSE with client cap, per-tank filter, keep-alive, reconnect with jitter** (`server.cjs:2433-2477`; `SensorProvider.tsx:289-363`).
- **Rate limiting present** (global 300/min, login 5 failed/15 min, ingest 12/s/device) (`server.cjs:138-177`).
- **CORS is an allowlist with a production guard, no credentials flag** (`server.cjs:80-108`).
- **DB pool + retry + graceful shutdown + unhandled-rejection handlers** (`server.cjs:46-76`, `5405-5457`).
- **Poller** has bounded concurrency, reentrancy guard, active-only filter, 34 passing checks (`docs/system-audit-2026-10-05.md:82`, `package.json:17`).
- **Frontend** is type-safe (no `any`), has offline/stale banners, `--` for nulls, role gating backed by server `requireAdmin` (`SensorProvider.tsx:113-123`; `App.tsx:117-126`; `src/utils/text.ts:37-40`).
- **Fix guidance is genuinely actionable** (aeration, water change, stop feeding) (`src/utils/alertGuidance.ts:36-117`).
- **Automated suite:** 8 suites / 277 checks pass per the project's own audit (`FIX-LATER.md:20`).

---

## 6. 30 HOSTILE PANEL QUESTIONS

### Examiner 1 - Embedded / IoT Hardware Engineer

1. **"Walk me through DS18B20 conversion timing. Why is every reading one cycle stale?"**
   *Strong:* knows `setWaitForConversion(false)` means you read the previous conversion; cites ~750 ms at 12-bit; states the 1 s loop masks it.
   *Destroyed:* "It's instant."
2. **"HC-SR04 ECHO is 5 V and the ESP32 is 3.3 V. Where is your level shifter?"**
   *Strong:* shows the 1k/2k divider and a scope trace.
   *Destroyed:* "It's been working so it's fine."
3. **"MQ-137 senses NH3 in air. Your claim is dissolved ammonia in a tank. Reconcile those."**
   *Strong:* admits it's a gas proxy, shows a paired calibration vs a test kit, discusses pH/temp dependence of NH3/NH4+.
   *Destroyed:* insists ppm maps directly to water ammonia.
4. **"How did you calibrate R0, and how long was the burn-in?"**
   *Strong:* 24-48 h burn-in, clean-air, sanity-bounded, persisted to NVS (`ESP32_main_code.ino:1516-1613`).
   *Destroyed:* "5 seconds in the room."
5. **"ESP32 ADC is nonlinear and you use `analogSetPinAttenuation(ADC_11db)`. What's your error at 0.25 ppm?"**
   *Strong:* states measured error vs reference, or acknowledges the limitation.
   *Destroyed:* "The library handles it."
6. **"What happens to the 600 buffered readings if the board reboots?"**
   *Strong:* admits RAM-only loss; states plan.
   *Destroyed:* claims no data loss.
7. **"Why sample at 1 Hz? What signal requires 1 Hz for a crayfish tank?"**
   *Strong:* justifies vs biological timescale or calls it configurable headroom.
   *Destroyed:* "Because it's real-time."
8. **"The config portal blocks 180 s and the watchdog is disabled during it. What happens to the message queue?"**
   *Strong:* cites `esp_task_wdt_delete`/portal timeout and buffer.
   *Destroyed:* unaware.
9. **"There's no OTA. How do you update six boards in a tank room?"**
   *Strong:* USB reflash procedure + config portal preserves NVS.
   *Destroyed:* "We didn't think about it."
10. **"Show me your power budget. MQ-137 heater current on a 5 V rail from a DevKit - brownout?"**
    *Strong:* measured current, rail margin, decoupling.
    *Destroyed:* "USB is enough."

### Examiner 2 - Full-stack / Security Engineer

11. **"Is the session token compared in constant time? Where is it indexed?"**
    *Strong:* SHA-256 pre-hash then SQL equality; index `idx_users_token_active` (`migrations/017_token_index.cjs:61`).
    *Destroyed:* "We use bcrypt/JWT."
12. **"A holder of `DEVICE_SECRET` can post as any `device_id`. Right?"**
    *Strong:* yes, admits shared-secret spoofing; points to per-device path.
    *Destroyed:* "Devices can't spoof."
13. **"Why does an archived device still write readings and send disconnect SMS?"**
    *Strong:* explains intentional history retention; admits disconnect SMS filter gap (`server.cjs:1551-1553`).
    *Destroyed:* "Archived means rejected."
14. **"Show me `POST /auth/users`. Does it enforce your password policy?"**
    *Strong:* finds the bypass; fixes it live.
    *Destroyed:* assumes it does.
15. **"Rate limiting on OTP endpoints? Can the requester verify their own deletion?"**
    *Strong:* none today; 5-attempt cap only; separation is by email delivery (`server.cjs:3620`), not code.
    *Destroyed:* "OTP is secure."
16. **"Any string interpolation into SQL?"**
    *Strong:* names the three code-controlled sites and why safe.
    *Destroyed:* says none, then is shown `3209`.
17. **"You rely on `SameSite=Lax` as CSRF defense. What if the API moves to another host?"**
    *Strong:* explains same-origin design and why `VITE_API_BASE` must stay relative (`AGENTS.md`).
    *Destroyed:* plans a cross-origin deployment.
18. **"Threshold logic exists in three files. Which is authoritative and how do you prevent drift?"**
    *Strong:* points to mirror test and the contract comment (`src/types/index.ts:286-289`).
    *Destroyed:* didn't know it's duplicated.
19. **"Your charts say 'all time' but you purge sensors at 30 days. Where is that documented?"**
    *Strong:* admits the doc omission and corrects it.
    *Destroyed:* claims full history.
20. **"A value oscillating on a threshold boundary - how many log rows per hour, and can it SMS-spam?"**
    *Strong:* explains 120 s dedup without hysteresis; SMS has 300 s cooldown so logs spam, SMS doesn't.
    *Destroyed:* says cooldown prevents all spam.

### Examiner 3 - Aquaculture / Research Methodology Expert

21. **"You monitor three parameters. Where is dissolved oxygen?"**
    *Strong:* states DO is the primary limiting factor; either scoped out explicitly with justification and future work.
    *Destroyed:* claims temp/level/ammonia is "complete."
22. **"Cite the source for 20-31 C."**
    *Strong:* provides species-specific literature.
    *Destroyed:* "We chose safe values."
23. **"0.25-1.0 ppm ammonia - is that NH3-N, TAN, or un-ionized NH3? At what pH/temperature?"**
    *Strong:* distinguishes the forms; notes toxicity is un-ionized and pH/temp dependent.
    *Destroyed:* conflates all ammonia.
24. **"A farmer gets an ammonia alert. What exactly should they do, and how does your system know their pH?"**
    *Strong:* guidance says water change/aeration/stop feeding; admits it can't assess toxicity fraction without pH.
    *Destroyed:* "They just add water."
25. **"What was your sample size and percent error against a reference?"**
    *Strong:* gives a table.
    *Destroyed:* gives none.
26. **"Your brief says 36 cm tank; the firmware says 23.5 cm empty and an 8 cm placeholder full. Which is real?"**
    *Strong:* explains the sensor-to-water model and that 36 cm was removed as vessel property.
    *Destroyed:* contradicts itself.
27. **"Water level as a percentage - percentage of what, and why does that matter biologically?"**
    *Strong:* defines it via measured span; ties to stocking/density/pump safety.
    *Destroyed:* "It's just how full it is."
28. **"Beyond showing numbers and thresholds, what decision does the system make?"**
    *Strong:* rule-based guidance and trend analytics, honestly labeled not AI.
    *Destroyed:* claims AI/ML prediction.
29. **"How long did it run continuously, and what happened when you killed the server?"**
    *Strong:* cites a soak test and reconnect behavior.
    *Destroyed:* never ran it.
30. **"Defend the words 'real-time,' 'accurate,' and 'smart' as used in your README."**
    *Strong:* real-time = ~1 s SSE; accurate = measured error; smart = deterministic rules, not AI.
    *Destroyed:* no definitions.

---

## 7. FIX PRIORITY PLAN

### Must fix before defense (~24-32 h, many parallel)

| # | Task | Hrs | Depends |
|---|---|---|---|
| 1 | Measure true `full_cm`; set via `PUT /calibration/water-level`; update all defaults | 1 | hardware |
| 2 | Reframe ammonia honestly (gas proxy vs dissolved) + add pH/temp caveat in UI/docs | 2 | - |
| 3 | Produce a real calibration dataset: DS18B20 vs thermometer; HC-SR04 vs ruler (5 points); ammonia vs test kit | 6-10 | hardware + reference instruments |
| 4 | Fill in `TESTING_GUIDE.md` Phases D-H with expected/actual; run mock D + board F | 4-6 | hardware |
| 5 | Confirm ECHO divider physically present; photograph it | 0.5 | hardware |
| 6 | Ship a bootstrap schema migration so a fresh DB works | 3 | - |
| 7 | Patch `POST /auth/users` password policy | 0.25 | - |
| 8 | Add `archived_at`/`is_active` guard to ingest + disconnect SMS | 1 | - |
| 9 | Bind `device_id` to per-device secret (or document shared-secret tradeoff) | 1 | - |
| 10 | Rotate `.env.new` secrets; verify repo private; purge history | 2 | owner |
| 11 | Add hysteresis/deadband to threshold eval | 1 | - |
| 12 | Fix self-contradictions (36 cm vs 23.5, 12 vs 3/sec, retention) | 1 | - |

### Should fix (~10-14 h)

- Dedicated OTP rate limiter + requester != verifier rule (2).
- Persist offline buffer to flash (4).
- Add calibration UI + wire `saveWaterLevelCalibration` (3).
- Single-source threshold logic + drift test (2).
- React error boundary (0.5).
- MQ-137 saturation -> NULL (0.5).
- Document 30-day purge / "all time" definition (0.5).

### Mention as future work

- Add DO/pH/turbidity sensors.
- OTA updates.
- Time-scale chart axis.
- Hash stored device secrets.
- Split `server.cjs`/`SettingsPage.tsx`.
- Live-demo fallback: pre-recorded video + mock device running on a laptop (`scripts/mock-device.js`) in case hardware fails.

---

## 8. SELF-QUIZ (answer without notes; grade strictly)

1. What exactly does the MQ-137 measure, in what units, and what is the physical analyte difference from what your thresholds assume?
2. Give the water-level formula and both constants. Which one is a placeholder?
3. Why is each DS18B20 reading one cycle stale, and how long is that cycle?
4. What values does the firmware send when temperature fails, and what does the DB store?
5. What is `full_cm` right now, and what happens to every alert if it is wrong?
6. How does a device authenticate to `POST /sensor`, and can it post as another tank?
7. How many tables can be created from your repository, and which ones cannot?
8. How long is sensor history kept, and where is that documented?
9. Where does threshold logic live, and how many copies exist?
10. Name three parameters you do not measure that matter for crayfish, and say which is most critical.

**Grading (strict):** You pass a question only if your answer matches the evidence exactly - a vague or overclaiming answer scores 0 even if partially right. Q1, Q2, Q5, Q7, Q8 are the ones that will sink the defense; if you cannot answer those from memory with the exact constants (`23.5`, `8.0`, 30 days, 8-of-14) you are not ready. Answer them and each is graded 0-10.

---

*If the actual firmware wiring and raw calibration/hardware test logs (currently absent) are provided, Sections B, C, and H can be re-audited against real artifacts instead of being marked UNVERIFIED.*
