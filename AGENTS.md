# AGENTS.md — CRAYvings Aquaculture Monitoring System

Guidance for AI coding agents (and new humans) working in this repository.

## 1. What this project is

An IoT monitoring dashboard for **aquaculture tanks/ponds** (crayfish/crab), built as a
capstone project. One **ESP32** per tank reads three parameters and pushes them over
Wi-Fi to a central Express + PostgreSQL backend, which validates and stores them and
pushes them to the dashboard over **SSE**.

- **Sensors**: temperature (DS18B20), water level (HC-SR04), ammonia (MQ-137)
- **Topology**: star — up to ~6 ESP32s per server, each with a `device_id`
- **Roles**: `owner` (single privileged account) > `admin` > `user`
- **Alerts**: floating popups, Web Audio sounds, and SMS via HTTPSMS (an Android phone
  acting as an SMS gateway)

Data flow, in one line:

```
ESP32 --POST /sensor (1s)--> Express API --> PostgreSQL
          ^                    |                  |
          |                    +-- device poller --+-- SSE push --> React dashboard
          +-- GET /status <----- GET /status (health only, 5s)
```

**Two concepts that are easy to get wrong — keep them separate:**

| Concept | Mechanism | Meaning |
|---|---|---|
| **Hide** | `devices.is_active = false` | reversible, "don't show this right now" |
| **Archive** | `devices.archived_at` set | terminal, "this board is retired" — keeps all history, never releases its ID |

**Failed sensors are stored as `NULL`, never `0` or a sentinel number.** The wire
sentinels are temperature `-1`/`0`, water level `-1`, ammonia `-1`; the server converts
all of them to `NULL` before writing. Render `--` and never treat `null` as `0`.

## 2. Tech stack

| Layer | Tech | Version |
|---|---|---|
| Frontend | React + TypeScript | React 19.2, TS 5.9 |
| Build | Vite | 8.0 |
| Styling | Tailwind CSS | 4.2 (v4 `@theme` tokens in `src/index.css`) |
| Charts | Recharts | 3.8 |
| Icons | lucide-react | 1.8 |
| PDF export | jsPDF + jspdf-autotable | 4.2 / 5.0 |
| HTTP client | Axios | 1.15 |
| Backend | Express.js (CommonJS `.cjs`) | 5.2 |
| Database | PostgreSQL + `pg` | 15+ / 8.20 |
| Validation | Zod (both sides) | 4.3 |
| Security | helmet, express-rate-limit | 8.3 / 8.7 |
| Logging | plain `console.*` (no logger library) | — |
| Email | nodemailer | 10.0 |
| Lint | ESLint 9 flat config + typescript-eslint + react-hooks | 9.39 |
| Firmware | Arduino ESP32 (ESPAsyncWebServer, WiFiManager) | — |

Runtime: **Node.js 18+** (this machine runs v24.14.0, npm 11.9.0). OpenCode 1.18.34.

Note the deliberate split: **frontend is ESM TypeScript, backend is CommonJS `.cjs`.**
`package.json` has `"type": "module"`, so every server-side file needs the `.cjs`
extension. Do not "modernise" the backend to ESM as drive-by work.

`jsonwebtoken`, `pino`, and `bcrypt` are installed but **never imported anywhere** —
sessions are custom `crypto`-generated tokens stored SHA-256-hashed in
`users.token`, logging is `console.*`, and OTP hashing uses
`crypto.createHash("sha256")` with a per-row salt. Don't assume they are in play
just because they appear in `package.json`.

### Sessions are an HttpOnly cookie, and that constrains the deployment

`POST /auth/login` sets `crayvings_session` (`HttpOnly`, `SameSite=Lax`) and no
longer returns a token in the body. Nothing in `src/` reads or writes a session
credential — only the user's public profile is cached in `localStorage`
(`crayvings_user`).

The `Lax` attribute is the CSRF defence, and it only works because the dashboard
and the API share an origin. That is why:

- `API_BASE` (`src/types/index.ts`) defaults to the **relative** `/api`
- `vite.config.ts` proxies `/api` to `localhost:3000` in dev
- `server.cjs` serves `dist/` itself in production and strips the `/api` prefix

Two consequences to respect:

- **Never set `VITE_API_BASE` to an absolute URL.** Doing so makes the browser
  cross-origin, and login then fails with no obvious cause. There is no value
  that fixes it: `SameSite=Lax` is hard-coded (so a different *site* never sends
  the cookie, TLS or not) and CORS is configured without credentials. To put the
  API on another host, serve both from one reverse proxy on a single origin —
  which is what `server.cjs` already does in production.
- Bare paths (`/sensor`, `/auth/login`) must keep working. The ESP32 firmware and
  every suite in `tests/` call them unprefixed and authenticate with
  `Authorization: Bearer`, which is deliberately still supported — a browser
  cannot forge a Bearer request, so CSRF-checking it would only break devices.

Express 5 runs path-to-regexp v8: a bare `"*"` route pattern **throws at
startup**. The SPA fallback uses a pathless `app.use` for this reason.

## 3. Commands

```bash
npm install                 # deps
cp .env.example .env        # Windows: Copy-Item .env.example .env
npm run seed:admin          # first-time owner account, from .env vars

npm run server              # backend  -> http://localhost:3000
npm run dev                 # frontend -> http://localhost:5173 (proxies /api to :3000)

npm run build               # tsc -b && vite build  -> dist/
npm run lint                # eslint . (TS/TSX + CommonJS .cjs + node scripts)
npm test                    # threshold logic (no server needed)
npm run check:encoding      # UTF-8/encoding guard on text files
```

Full test suite:

```bash
npm run test:all            # lint -> encoding -> build -> unit -> DB suites
```

`test:all` starts with the static checks on purpose: lint and the encoding
guard are cheap, so a type error or an undeclared variable fails in seconds
instead of after a Postgres-backed suite has already touched the database.

Individually:

| Command | Needs a running API server? | Needs Postgres? |
|---|---|---|
| `npm test` | no | no |
| `npm run test:poller` | no | no |
| `npm run test:migration` | no | **yes** (uses a temp schema) |
| `npm run test:regression` | **yes** | yes |
| `npm run test:devices` | **yes** | yes |
| `npm run test:secrets` | **yes** | yes |
| `npm run test:sessions` | **yes** | yes |

The three that need a server fail with `status=-1` / `ECONNREFUSED` if it isn't up.
That is an environment problem, **not** a regression — don't chase it as a code bug.

`test:sessions` is **deliberately not in `test:all`.** It is the only suite that
calls `POST /auth/login`. Correct logins are not counted against the server's
brute-force budget, so the suite no longer trips the limiter and can be run back
to back — but a burst of genuinely failed logins in the browser will still make
the server refuse it, and `test:all` has to stay green regardless of what you
were doing in the UI a minute ago. A `429` from it means failed attempts have
exhausted the window, not that the session code regressed.

Other utilities:

```bash
npm run mock                # simulate an ESP32 (8 scenario profiles)
npm run mock:profiles       # list the mock profiles
node db/migrations/0NN_*.cjs   # run one structural migration
curl http://localhost:3000/health
```

## 4. Folder structure

```
server.cjs                  # Express backend (~4500 lines): auth, sensors, SSE,
                            #   logs, SMS, analytics, settings. The main API.
services/
  devicePoller.cjs          # star-topology health poller (GET /status, 5s)
  smsService.cjs            # HTTPSMS client + CLOSED/OPEN/HALF_OPEN circuit breaker
src/
  main.tsx                  # entry: mounts <App/>, arms alert audio
  App.tsx                   # routing, sidebar, role-based menus
  api/client.ts             # ALL API calls live here (axios instance + interceptors)
  types/index.ts            # single source of truth for types, constants,
                            #   threshold logic, API_BASE
  components/               # presentational, PascalCase.tsx
  pages/                    # one file per route, PageName.tsx
  hooks/                    # useXxx.ts
  contexts/                 # AuthContext, SensorContext/SensorProvider
  utils/                    # time, text, tokens, alertGuidance, pdfBrand, sounds
db/migrations/              # NNN_name.cjs, idempotent, run manually
  └── tracked in schema_migrations(version, name)
tests/                      # *.cjs suites (see section 3)
docs/                       # schema, how-it-works, setup and testing guides
scripts/mock-device.js      # ESP32 simulator
water_monitoring_system/
  ESP32_main_code/          # tank-1 firmware, device_id ESP32_01
  NODE_main_code/           # NodeMCU spare firmware, device_id ESP32_02
public/                     # static assets, alert sounds
tools/                      # restart-server.ps1, watch-connection.cjs
```

Conventions worth knowing:

- **All HTTP calls go in `src/api/client.ts`.** Pages import from there; they do not
  call `axios` directly (the rare exception is `isAxiosError` type guards).
- **All shared types go in `src/types/index.ts`** — not in the component that uses them.
- `src/config/routes.ts` and `src/hooks/useSSE.ts` are mentioned in the README but
  **no longer exist**. The README's Project Structure section is partly stale.
- Adding a page means: `src/pages/XPage.tsx` + a route/menu entry. Check whether
  `VALID_MENU_KEYS` in `src/types/index.ts` also needs updating — it drives the
  localStorage-persisted menu and has a type guard (`isValidMenuKey`).

## 5. Code style

**General:** 2-space indent, double quotes, semicolons, no tabs.

**TypeScript/TSX**
- `import type { X }` for type-only imports (`verbatimModuleSyntax` is on).
- Prefer `type X = { ... }`; a few older `interface`s remain.
- Components: `PascalCase.tsx`, arrow or `function` components, props typed inline.
- Hooks: `useThing.ts` exporting `useThing()`.
- Pages: `PascalCase` + `Page` suffix.
- Strict mode is on: `strict`, `noUnusedLocals`, `noUnusedParameters`. An unused
  import **fails the build**.

**Backend `.cjs`**
- CommonJS `require`. Banner comments, e.g. `services/devicePoller.cjs:1-15`.
- Tunables as `SCREAMING_SNAKE_CASE` constants at the top of the file, each with a
  comment explaining *why that value*.
- Logs are prefixed and timestamped, e.g. `[migration] 016_audit_fixes applied`.

**Comments — the house style is "why", not "what".** This codebase is unusually
well-commented, and the comments explain rationale and trade-offs:

```js
// Why a grace window at all: a board can only learn a new secret through its
// WiFiManager config portal, i.e. somebody has to physically reach the tank.
```

Match that. Don't strip existing comments, and don't add comments restating the code.

**Tests**
- Custom harness, not a test framework. `check(name, condition, extra)` prints
  `PASS`/`FAIL`; sections are bannered `--- A. Something ---`; suites exit non-zero
  on failure.
- Test rows are prefixed `ZZTEST_` and removed afterwards, so a suite is safe against
  a populated farm database.
- **Read `TESTING_GUIDE.md` Phase C.6 before running any suite that writes to the live
  `devices` table.** `test:devices` and `test:secrets` both write.

**SQL / migrations**
- Uppercase keywords, snake_case identifiers, aligned columns.
- Migrations are `NNN_snake_case_name.cjs`, **idempotent**, safe to re-run, and each
  opens with a long header explaining the problem being solved. They record themselves
  in `schema_migrations(version, name)` and never delete data.
- Nothing in `db/migrations/` is a "real" migration except the `NNN_*.cjs` files.
  `db/verify_readonly.cjs` is a read-only schema inspector and deliberately lives
  **outside** that folder: a non-migration named `NNN_*` would collide on
  `schema_migrations(version, name)` with the real migration of the same number.

## 6. Never do these

**Secrets**
- **Never read, edit, create, or commit `.env`.** It holds real Postgres and SMTP
  credentials. Use `.env.example` as the template. `.env.new` is also real.
- Never commit secrets, tokens, API keys, or device secrets — in any file, including
  docs and scratch notes. (`.gitignore` already excludes every `.env*` except
  `.env.example`; keep it that way.)
- Never paste a live `.env` value into a committed file, a test, or a log.

**Dependencies**
- **Never delete `node_modules/`.** Never delete or regenerate `package-lock.json`
  without being asked — it pins the working build.
- Don't add a dependency to work around a problem you could solve in-repo. The stack
  above is deliberate and already covers the needs.
- Run `npm install` only when asked.

**Database**
- Never run a structural migration against a database you haven't confirmed with the
  user. `db/migrations/*.cjs` change live schema.
- Never point tests at a production or valued database.
- Don't hand-edit tables to "fix" data; use a migration.

**Verification**
- Never mark a test as passing without having seen the output.
- Run `npm run build` and `npm run lint` after changing `src/` or `server.cjs`.
  Build is `tsc -b && vite build`, so a type error fails the build, not just the editor.
- Never start or restart the dev/backend server to "check something works" — use
  `npm run build`, `npm run lint`, and the non-server test suites instead.

**Git**
- Never `git push`, `git reset --hard`, `git clean`, `git rebase`, or force-push.
- Never amend or rewrite existing commits.
- Only commit when explicitly asked. Never commit `.env`, `node_modules/`, or `dist/`.

**Project files**
- `opencode.json` holds this project's agent permission rules. Treat edits to it as a
  security change and confirm first — several destructive commands are deliberately
  `deny` there.
- Don't edit firmware (`water_monitoring_system/*.ino`) without being asked; it can
  only be validated against real hardware.
- Keep `README.md` and `docs/` accurate when you change behaviour — but note the
  README's Project Structure and Support tables are already partly stale, so verify
  a file exists before linking to it.

## 7. Useful references

- `README.md` — features, full API endpoint tables, architecture, troubleshooting
- `TESTING_GUIDE.md` — the ordered verification procedure (phases A–H)
- `docs/DATABASE_SCHEMA.md` — every table, column, index, FK
- `docs/HOW_IT_WORKS.md` — detailed architecture and alert/SMS logic
- `docs/DEVICES_MODULE_HOWTO.md` — device registration/archiving
- `docs/MOCK_DEVICE.md` — simulating an ESP32
