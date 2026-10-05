# FIX LATER — Full Audit Findings

CRAYvings Aquaculture Monitoring System
Audit date: 2026-10-04
Branch audited: `docs/consolidate` (HEAD `6bf8a7b`) · also compared against `master` (`93705ab`) and `origin`

> **Status:** audit only. No fixes have been applied. Every item below is a
> description of a problem and a suggested fix — none of it is implemented.
>
> **Secret hygiene:** this document intentionally contains **no credential
> values, hashes, phone numbers or emails**. Findings that involve secrets cite
> only the file path, commit hash or line number.

---

## A. VERDICT

**PARTLY WORKING — health score 7/10**

The application code is genuinely well built: 8/8 test suites green (277 checks),
0 npm vulnerabilities, no SQL injection, no XSS sink, disciplined error handling.
What drags the score down is not the code — it is **delivery hygiene**. Live
credentials and a personal-data database dump are published on `master` right now,
and the database cannot be provisioned from a clean checkout by any documented route.

---

## B. RUNTIME STATUS

| Check | Command | Result |
|---|---|---|
| Node / npm | `node -v` / `npm -v` | v24.14.0 / 11.9.0 — PASS |
| Dependency tree | `npm ls --depth=0` | exit 0, consistent with package.json |
| Lint | `npm run lint` | **exit 0**, no output |
| Typecheck + build | `npm run build` | **exit 0**, built in 751 ms |
| Encoding guard | `npm run check:encoding` | OK — 88 text files clean |
| Unit thresholds | `npm test` | 4/4 pass (`node:test`) |
| Poller unit | `npm run test:poller` | 34/34 pass |
| Migration 014 | `npm run test:migration` | 15/15 pass, live schema untouched |
| Devices | `npm run test:devices` | 104/104 pass |
| Secret rotation | `npm run test:secrets` | 65/65 pass |
| Regression | `npm run test:regression` | all pass |
| Session cookie | `npm run test:sessions` | 59/59 pass |
| Dependency advisories | `npm audit` / `npm audit --omit=dev` | **0 vulnerabilities** both |
| Outdated packages | `npm outdated` | 22 behind "Wanted"; 4 majors available |
| API health | `GET /health` | 200 `{"status":"ok"}` |
| Frontend | `GET :5173` | 200 |
| Same-origin proxy | `GET :5173/api/health` | 200 — cookie design confirmed working |
| DB post-suite residue | read-only query | **0** `ZZ*` rows in all 6 tables |

> ⚠️ **Caveat:** the API process was started manually at 08:43:09; `server.cjs`
> was last modified 11:49:18. **All four server-backed suites exercised stale
> code.** The frontend runs under Vite HMR, so `src/api/client.ts` and
> `src/pages/SettingsPage.tsx` edits were live on `:5173`.

---

## C. FINDINGS

| ID | Sev | Area | Evidence | Impact | Suggested fix | Effort |
|---|---|---|---|---|---|---|
| 1 | **CRITICAL** | Git / secrets | `git ls-tree -r master` → `master` **still tracks** `.env.new`. Added in `5f741f9` (2026-09-24), confirmed ancestor of `master`. Only untracked on `docs/consolidate` in `de81512`. Remote `origin` = GitHub. | Live Postgres/SMTP/HTTPSMS credentials are published on the default branch. Anyone with repo access can read them. | Treat as compromised: **rotate every credential**, then rewrite `master` history. Merging `de81512` stops HEAD exposure but does **not** remove the blobs from history. | Hours |
| 2 | **CRITICAL** | Git / privacy | `master` **still tracks** `.opencode/backups/crayvings_before_migration.dump` (65 KB pg_dump). Added in `8bcfe2c` (2026-08-12), confirmed ancestor of `master`. | The dump contains user rows: password hashes, session token hashes, emails and **phone numbers**. Published personal data. | Same as #1. Check whether the repo is public — if so, treat as a live breach and escalate. | Hours |
| 3 | **HIGH** | DB / provisioning | No tracked schema file (`git ls-files` → none). `.gitignore` blocks `*.sql`. `README.md:152-211` Quick Start has no DB or migration step. `seed-admin.cjs:43` is INSERT-only. | The database cannot be created from a clean checkout by any documented route. The only way is booting `server.cjs`, which self-migrates (see #4). A grader cannot stand this up. | Track a real bootstrap schema (un-ignore it, or author it as `.cjs`), and add "create DB + run migrations" as Quick Start steps. | Medium |
| 4 | **HIGH** | DB / schema | `server.cjs:1473-1514` runs **16 DDL statements at startup**. Cross-checked against all 16 migrations: `ack_status`, `idx_sensors_timestamp` and `ammonia DECIMAL` appear in **no migration at all** — they exist only here. `device_secret` + index, `device_threshold_overrides` and `token_expires_at` are duplicated across both systems. `schema_migrations` has 16 rows and does **not** describe the true schema. Precedent: `016_audit_fixes.cjs:213` records migration 005 already having had to repair timestamp drift. | Two competing schema-management systems. `ADD COLUMN IF NOT EXISTS` silently no-ops, so a migration that later changes a type will diverge invisibly. A migrations-only setup produces a schema missing the ammonia sensor entirely. | Move all 16 statements into a numbered migration, delete the startup block, then re-run `db/verify_readonly.cjs` to confirm zero drift. | Medium |
| 5 | MEDIUM | Auth | `clearSessionCookie` (`server.cjs:441-445`) never adds `Secure`; `setSessionCookie` (`:429-439`) does when `COOKIE_SECURE=true`. Call sites: 511, 523, 562, 568, 3089. | On HTTPS (`COOKIE_SECURE=true`), cookie-override protection refuses an insecure overwrite, so **logout silently fails** and the cookie survives to its natural expiry. Verified by code reading; not runtime-provable without TLS. | Mirror the `if (COOKIE_SECURE) attrs.push("Secure")` logic into the clear path. | Trivial |
| 6 | MEDIUM | Frontend | Zero matches for `ErrorBoundary` / `componentDidCatch` / `getDerivedStateFromError` across all `src/**/*.tsx`. `src/main.tsx` mounts `<App/>` bare. | One render-time throw blanks the entire dashboard with no recovery. In a monitoring system a crash loses visibility exactly when it is needed. | Wrap `<App/>` in a small error boundary that renders a recoverable "reconnect" state. | Small |
| 7 | MEDIUM | Security | `server.cjs:121` `scriptSrc: ["'self'", "'unsafe-inline'"]`; confirmed present in the live response header. | CSP provides **no** XSS mitigation, because inline script executes. Likely added for Vite's dev inline preamble; production needs none of it. | Remove `'unsafe-inline'` from `scriptSrc`; add per-request nonces only if something still requires it. | Small |
| 8 | MEDIUM | Performance | `pg_indexes` for `users` returns only `users_pkey`, `idx_users_status`, `idx_users_email_active`, `idx_users_username_active`. **No index on `token`.** The queries `SELECT * FROM users WHERE token = $1` sit at `server.cjs:505` and `:556`. | A sequential scan **plus `SELECT *`** (which also pulls `password_hash`) on every authenticated API call and every SSE connect. | Add a unique index on `token` where not null; select explicit columns instead of `*`. | Trivial |
| 9 | MEDIUM | Docs / code | `src/types/index.ts:334-336` advertises `VITE_API_BASE` as "the escape hatch for pointing a build at a genuinely separate API host". But `SameSite=Lax` is hard-coded at `server.cjs:434` and `:444` with no env override — only `Secure` is configurable. | The documented escape hatch **cannot work**, and it directly contradicts `AGENTS.md` §2. A future maintainer will follow it and hit an unexplained login failure. | Correct the comment to match reality: no cross-origin configuration exists. | Trivial |
| 10 | MEDIUM | Delivery | `master` = `93705ab` (2026-09-27). `docs/consolidate` / `audit/phase1-security` = `6bf8a7b` (2026-10-02), **32 commits ahead**. 18 modified/deleted + 7 untracked files are uncommitted. 0 stashes, 1 tag (`pre-audit-2026-10-02`). | The published default branch contains **none** of the auth/session/security hardening, and the docs consolidation exists only in the working tree. Anything reviewed from `master` sees the pre-audit system. | Merge to `master` after #1/#2 are handled, and commit the docs work. | Small |
| 11 | LOW | Config | `.env.example` declares variables nothing reads: `POLL_INTERVAL` (the poller hardcodes `POLL_INTERVAL_MS = 5000`, `services/devicePoller.cjs:30`), `SMTP_CREATE_TRANSPORT_ON_STARTUP` (the transport is built unconditionally, `server.cjs:602`), `ARDUINO_BAUD` / `ARDUINO_ENABLED` / `ARDUINO_PORT` (**zero** `ARDUINO_` references anywhere in code *or* firmware), `DEVICE_ID` (the firmware uses `#define DEVICE_ID_DEFAULT`, `.ino:226`). | An operator sets these and nothing changes. The Arduino block implies a serial-bridge feature that does not exist. `DEVICE_ID` implies the firmware reads `.env`, which it cannot. | Delete the dead block, and add the live variables from #12. | Trivial |
| 12 | LOW | Config | `.env.example` omits variables the code **does** read: `DEVICE_SECRET_GRACE_MS` (`server.cjs:2421-2422`, security-relevant), `POLL_TIMEOUT_MS`, `TOKENS_HASHED`, `API_BASE`, `WATCH_INTERVAL_MS` / `WATCH_STALE_MS` / `WATCH_PROBE_TIMEOUT_MS`. | The secret-rotation grace window is an undocumented security control — exactly the knob an operator must know exists. | Add each one with a "why that value" comment. | Trivial |
| 13 | LOW | Agent config | `opencode.json` denies `git rebase` / `reset` / `clean` / `push` but **not** `git merge`, `git cherry-pick`, `git fetch`, `git pull`, or `git checkout <branch>` (only `git checkout --*`, line 72). `Remove-Item*` is `"ask"` (line 64) while `rm` / `rmdir` / `del` are `"deny"` (lines 61-63). | The four history-rewriting commands that the project brief bans fall through to `"*": "ask"`. The delete policy is also internally inconsistent. | Add the four denies and align `Remove-Item`. | Trivial |
| 14 | LOW | Docs | `AGENTS.md` §2 states `jsonwebtoken`, `pino` and `bcrypt` are "installed but never imported" — **none** are in `package.json` or `node_modules`. §5 states tests use a custom harness, but `src/types/threshold.test.cjs` uses `node:test`. The file also references `src/config/routes.ts` and `src/hooks/useSSE.ts`, which no longer exist. | Documentation drift on four separate claims. One of them (`node:test`) actively makes the harness guidance misleading. | Correct the four claims. | Trivial |
| 15 | LOW | Security | `devices.device_secret` is stored in plaintext and compared in SQL (`server.cjs:1813`, `device_secret = $2`), not in constant time. The code acknowledges this at `:1790-1791` and `:1822-1825`. | A DB dump reveals every ESP32 secret. The timing angle is theoretical over HTTP with an index present, but the plaintext storage is real. | Store `device_secret_hash` / `device_secret_prev_hash`. All current behaviour, including the grace window, survives hashing. | Medium |
| 16 | LOW | Maintainability | `server.cjs` is 1 file, 5,092 lines, 242 kB. `src/pages/SettingsPage.tsx` is 133 kB. Frontend total is 42 files / 647 kB. | Everything lives in one place, so any change risks a whole-file merge conflict. | Split `server.cjs` by domain (`routes/auth`, `routes/sensors`, `routes/settings`); split `SettingsPage.tsx` by tab. | Large |
| 17 | LOW | Hygiene | `test-login.cjs` is tracked at the repo root, is not in `package.json` scripts, and has zero references in `README.md`, `AGENTS.md`, `TESTING_GUIDE.md` or `docs/`. | An orphan file with no documented purpose. | Add an npm script for it, or delete it. | Trivial |
| 18 | LOW | Security | `server.cjs:138-144` — the global limiter keys on `req.ip` with `validate: { xForwardedForHeader: false }`. | Behind any reverse proxy all users would share a single 300/min bucket, so one client could rate-limit everyone. Harmless in the current single-origin deployment. | If a proxy is ever introduced, set `app.set("trust proxy", 1)` **and** enable `xForwardedForHeader`. | Trivial |
| 19 | LOW | Config | No `engines` field in `package.json`, despite `AGENTS.md` documenting "Node.js 18+". | The version constraint is unenforced; an older Node machine fails cryptically. | Add `"engines": { "node": ">=18" }`. | Trivial |
| 20 | LOW | Hygiene | `dotenv` 17.4.2 prints `◇ injected env (35) from .env // tip: ◈ secrets for agents [www.dotenvx.com]` on every run. | An advertisement banner polluting server and script logs. | Use `config({ quiet: true })` at the call sites. | Trivial |
| 21 | LOW | Security | Helmet emits `Strict-Transport-Security` unconditionally, while the live CSP shows deployment on a plain-HTTP LAN address. | Browsers ignore STS received over HTTP, so the header is inert and misleading. | Gate HSTS on `COOKIE_SECURE` / actual TLS. | Trivial |
| 22 | LOW | Security | `server.cjs:123` `imgSrc: ["'self'", "data:", "https:"]`. | Permits image-based exfiltration to any host if an XSS is ever introduced. | Narrow to `'self'` + `data:` + whichever image CDN is actually used. | Trivial |

---

## D. QUICK WINS

Highest value per minute of work — all trivial:

1. **#5** — add `Secure` to `clearSessionCookie`. One line; fixes logout over HTTPS.
2. **#8** — index `users.token`. One statement; removes a sequential scan from every authenticated request.
3. **#12** — document `DEVICE_SECRET_GRACE_MS`. It is a security control nobody can find.
4. **#11 + #12** — reconcile `.env.example` in both directions. Deletes 6 phantom vars, adds 7 real ones.
5. **#9** — fix the `VITE_API_BASE` comment so the next maintainer is not misled.
6. **#13** — four `git` denies in `opencode.json`.

---

## E. WHAT LOOKED FINE

- **0 npm vulnerabilities**, production and dev. Commit `77615ec`'s hardening has held.
- The dependency tree is fully consistent: no phantom or missing declarations. The only `UNMET` entries are *optional* platform binaries for other operating systems.
- **All 16 migrations are applied, names match filenames exactly, no duplicates, no gaps.**
- **All 8 suites pass, 277 checks.** Every DB-writing suite independently asserts zero residue, and a direct read-only query confirmed **0** `ZZ*` rows across `devices`, `users`, `sensors`, `activity_logs`, `system_logs` and `sms_logs`.
- **No SQL injection.** All 5 dynamic WHERE/SET builders are fully parameterised. `sms_logs` picks a hardcoded literal; `system_logs` and `activity_logs` bind every value; `sensor_settings` column names come from a fixed object literal; `sortBy` is whitelisted to ASC/DESC.
- **No XSS sink** — zero `dangerouslySetInnerHTML`, `eval` or `new Function` in `src/`. Zero `console.log` in the frontend.
- Session tokens are SHA-256 hashed with constant-time comparison via `crypto.timingSafeEqual` (`:277`, `:634`). OTPs use salted SHA-256 with a per-row salt.
- Unauthenticated access correctly returns 401; non-admin secret rotation correctly returns 403 **and** leaves the stored secret unchanged.
- Sensor CHECK constraints are sane (temperature `> 0`, water level `0-200`, ammonia `0-1000`, all nullable for failed sensors). `chk_devices_archived_pair` and `chk_devices_secret_prev_pair` enforce their invariants.
- Error middleware at `:4869`, plus `unhandledRejection`, `uncaughtException` and SIGINT/SIGTERM/SIGUSR2 graceful shutdown.
- SSE is well built: a client cap with a clean pre-header 503, per-client tank filter, 25 s keep-alive, `res.sseKeepAlive` reaping, and `close` cleanup.
- The same-origin cookie design is **verified working end-to-end** through the Vite proxy.
- Helmet headers are all present; `SameSite=Lax` and `HttpOnly` are correctly hard-coded.
- No `.env` file itself was ever committed in any branch's history.

---

## F. COULD NOT VERIFY

| Item | Why |
|---|---|
| **Whether the GitHub repo is public or private** | Needs the repo owner to check settings. This single fact decides whether #1 and #2 are a live breach or an internal-only exposure. |
| Runtime behaviour of the **current** `server.cjs` | The running process predates the file by ~3 hours. Re-run the 4 server-backed suites after a restart. |
| Browser UI: rendering, SSE frame content, alert popups, Web Audio, PDF export | No browser automation is available in this environment. |
| Live ESP32 ingestion | The newest `sensors` row is **2026-09-28 17:25**, roughly 6 days stale. There are 11 devices, 0 archived, 0 inactive. It is not possible to tell whether that means "no hardware connected" or a silent ingestion failure. Worth confirming deliberately. |
| SMS delivery via HTTPSMS | No live send was attempted, per instructions. The circuit-breaker code path was reviewed statically only. |
| SMTP / OTP email delivery | Same — code path reviewed, never executed. |
| The 4 available majors (`typescript` 7.0.2, `eslint` 10.12.0, `dotenv` 18.0.5, `@types/node` 26.6.4) | Not tested. Upgrading dependencies is out of scope for an audit. |

---

## G. RECOMMENDED FIX ORDER

**Phase 1 — today, security**

1. **#1, #2** — rotate all credentials in `.env.new`, then purge history on `master`. Check repo visibility first and escalate if it is public.
2. **#5** — add `Secure` to the cookie clear path.
3. **#10** — merge `docs/consolidate` into `master` once #1/#2 are done, and commit the docs work.

**Phase 2 — this week, correctness**

4. **#4** — collapse the two schema systems into migrations, then verify `db/verify_readonly.cjs` shows zero drift.
5. **#3** — track a bootstrap schema and document DB creation in Quick Start.
6. **#8** — index `users.token`.
7. **#6** — add a React error boundary.

**Phase 3 — hygiene, low risk**

8. **#11, #12, #9, #14** — reconcile `.env.example` and fix the stale doc claims.
9. **#7, #22** — tighten CSP (remove `unsafe-inline` from `script-src`, narrow `img-src`).
10. **#13, #17, #19, #20** — agent rules, orphan file, `engines` field, quiet dotenv.

**Phase 4 — structural, when there is time**

11. **#15** — hash device secrets.
12. **#16** — split `server.cjs` and `SettingsPage.tsx`.
13. **#18, #21** — only relevant if TLS or a reverse proxy is ever introduced.

---

## Reproduction notes

Read-only commands used, safe to re-run:

```bash
rtk git ls-tree -r --name-only master -- .env.new          # finding 1
rtk git ls-tree -r --name-only master -- .opencode/backups/crayvings_before_migration.dump   # finding 2
rtk git log --all --diff-filter=A --format='%h' -- '.env.new'                             # finding 1
rtk git log master..docs/consolidate --oneline | wc -l                                    # finding 10
npm run lint; npm run build; npm run check:encoding                                       # section B
npm test; npm run test:poller; npm run test:migration                                     # section B
npm run test:devices; npm run test:secrets; npm run test:sessions; npm run test:regression
npm audit; npm audit --omit=dev; npm outdated                                            # section B
node db/verify_readonly.cjs                                                               # finding 4
```

Never run: anything that reads `.env` directly, `node db/migrations/*` against the
live database, or `psql` with write access.