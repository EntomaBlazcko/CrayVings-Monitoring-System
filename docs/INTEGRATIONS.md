# Integrations — SMS via HTTPSMS

How outbound SMS is wired up: critical alerts, hourly status reports, and
device-disconnect warnings, all delivered through **HTTPSMS** with an Android
phone acting as the SMS gateway.

| | |
|---|---|
| **Service** | [httpsms.com](https://httpsms.com) — free, open-source |
| **Gateway** | An Android phone with a PH SIM running the *HttpSms* app |
| **Transport** | HTTPS to `https://api.httpsms.com/v1/messages/send` |
| **Auth** | `x-api-key` header |
| **Client** | `server.cjs` (`sendHttpsms`, `sendHourlyStatusUpdate`, `checkDeviceDisconnects`) + `services/smsService.cjs` (circuit breaker) |
| **Storage** | `sms_logs` table, exposed through the SMS Alerts settings card |

> The API key is already configured in the project's `.env`. You still need to
> set up the gateway phone (Phase A), set `HTTPSMS_FROM` to its real number
> (Phase C), and add a recipient to test (Phase D).

---

## How a send actually happens

1. A producer (alert engine, hourly job, disconnect monitor, or a manual test)
   calls the send helper with a recipient list.
2. The **daily cap** is checked first. Over budget, the row is logged as
   `capped` and nothing is sent. Manual test SMS bypass this.
3. The **circuit breaker** is consulted. If the gateway has been failing, the
   send fails fast with a `circuitOpen` error instead of waiting on a dead
   network.
4. The request goes to `https://api.httpsms.com/v1/messages/send`. A success is
   logged as `queued` with the returned message id.
5. A background **delivery poller** re-checks queued rows against the messages
   list endpoint and settles them to `delivered` or `failed`.

The API base URLs are **hardcoded** in `server.cjs:969-970`. There is no
`HTTPSMS_BASE_URL` variable — pointing the system at a self-hosted HTTPSMS
instance would require a code change, not a config change.

### The circuit breaker

`services/smsService.cjs` wraps every send so one dead gateway cannot stall the
alert path:

| State | Behaviour |
|---|---|
| **CLOSED** | Normal. Sends go through. |
| **OPEN** | After **5 consecutive failures**, all sends fail fast for **60 s**. No network calls at all. |
| **HALF_OPEN** | After the cooldown, exactly **one** probe send is allowed through. Success → CLOSED. Failure → OPEN again with a fresh cooldown. |

Watch the console for `[SMS] circuit breaker OPEN ...` /
`HALF_OPEN - single probe send allowed` to diagnose a gateway that has dropped
off the network.

---

## Phase A — Gateway phone

1. Grab an Android phone with a Globe/Smart/TNT PH SIM and plenty of battery.
2. Install the **"HttpSms"** app on it (from <https://httpsms.com>). The phone
   becomes your SMS gateway.
3. Open the app, then log in / create your httpsms account.
4. Make sure the app shows **"Connected"**.
5. Keep the phone alive:
   `Settings > Apps > HttpSms > Battery > Unrestricted`
   (otherwise Android kills it in the background and nothing gets sent).
6. Write down this phone's SIM number — you need it in Phase C.

---

## Phase B — API key (httpsms.com)

1. On your computer, go to <https://httpsms.com/settings> and log in with the
   same account used on the phone.
2. Copy the API key shown there.

**Done:** the key is already in this project's `.env` as `HTTPSMS_API_KEY`. If
you ever regenerate the key on httpsms.com, update it in `.env` again.

---

## Phase C — Configure the server (`.env`)

1. Open the `.env` file in the project root. Never commit it.
2. `HTTPSMS_API_KEY` — already set to your key.
3. Change `HTTPSMS_FROM=+639XXXXXXXXXX` to the gateway SIM's real number in
   E.164 format (no spaces or dashes):

   ```env
   HTTPSMS_FROM=+639XXXXXXXXXX
   ```

   (country code `+63`, then a `9` mobile prefix, then 9 more digits — 13
   characters total, starting `+639`.)

4. Optional timing knobs. **The defaults are fine to start.**

   | Variable | Default | Meaning |
   |---|---|---|
   | `HOURLY_SMS_ENABLED` | `true` | Master switch for the scheduled status SMS. Set `false` to disable it entirely |
   | `SMS_COOLDOWN_MS` | `300000` | Milliseconds between repeated critical alerts **per sensor** (5 min). Lower to `60000` for faster testing |
   | `HOURLY_SMS_INTERVAL_MS` | `3600000` | How often the status SMS goes out (1 hour) |
   | `DEVICE_DISCONNECT_ENABLED` | `true` | Master switch for disconnect SMS. `false` disables the monitor |
   | `DISCONNECT_STALE_MS` | `30000` | Silence before a "device disconnected" warning. Also drives the `online` flag on `GET /devices`, so it is **not** purely an SMS setting — `1800000` (30 min) makes the dashboard keep showing a tank online long after it stopped posting |
   | `DISCONNECT_REARM_MS` | `300000` | Reconnect grace: after a device recovers it must stay online this long (5 min) before a NEW disconnect SMS is allowed. Raise this if your ESP32 keeps flickering offline/online |
   | `SMS_DAILY_CAP` | `100` | Daily SMS budget across all producers (`0` disables the cap). When reached, sends are logged as `capped` instead of going out. Manual/test SMS bypass it |
   | `SMS_DELIVERY_POLL_MS` | `45000` | How often queued SMS are checked against httpsms for delivered/failed |
   | `SMS_RETENTION_DAYS` | `30` | Purge SMS history older than N days (`0` disables purging) |

5. Restart the backend:

   ```bash
   npm run server
   ```

   The console will print one of:

   ```text
   [<timestamp>] httpsms SMS configured (gateway +639XXXXXXXXXX)
   [<timestamp>] SMS delivery poller scheduled (every 45s)
   [<timestamp>] Hourly SMS status update scheduled (every 60 min)
   [<timestamp>] Device-disconnect SMS monitor scheduled (stale after 30s, rearm after 300s)
   ```

   or, if the key or sender number is missing:

   ```text
   [<timestamp>] WARNING: HTTPSMS_API_KEY / HTTPSMS_FROM are not set - SMS alerts will not be sent. Add them to .env and restart.
   ```

   Note the sender number is echoed in that log line at startup — fine on your
   own machine, but be careful about pasting console output into a shared
   channel.

---

## Phase D — Add a recipient + send a test SMS

1. Open the dashboard and log in as an **admin**. Every SMS route is
   admin-gated (`POST /alert/status`, `POST /alert/mute`); only the read-only
   `GET /alert/mute-status` and `GET /alert/sms-health` accept any signed-in
   user.
2. Go to **Settings**.
3. Scroll to the **"SMS Alerts"** card.
4. Under **"Add Recipient"**:
   - type a name (e.g. Farm Manager)
   - type the phone number. **Easiest:** type it the normal Filipino way —
     `09XXXXXXXXX` (starts with `09`). `+639XXXXXXXXX` and `639XXXXXXXXX` also
     work. Spaces, dashes and parentheses are stripped, and whatever form you
     use it is stored as `+639XXXXXXXXX`. Anything else is rejected.
   - click **"Add Recipient"**
5. Click the send (paper-plane) icon next to that recipient — it sends a real
   test SMS.
6. Check that phone — the text should arrive within a minute or two.

---

## Phase E — Test the real features

### 1. Critical alert

`Settings > Alert Thresholds >` set a max **BELOW** the current reading (e.g.
lower `temp_max` than the actual temperature) > Save. An alert SMS arrives after
the cooldown window (default 5 minutes).

### 2. Hourly status

SMS Alerts card > **"Send Status SMS Now"** (`POST /alert/status`, admin-only) to
trigger it manually, or just wait the configured interval.

### 3. Device disconnect

Power off the ESP32 for longer than `DISCONNECT_STALE_MS` > a warning SMS is
sent. Plug it back in — the rearm grace period (`DISCONNECT_REARM_MS`) has to
elapse before another disconnect can alert.

### 4. Mute

SMS Alerts card > **"Mute SMS"** > choose how many hours > all SMS are
suppressed until it expires. **"Unmute SMS"** turns alerts back on. Muting is
recorded in the activity log as `SMS_MUTED`.

### 5. Delivery check (the proof it works)

SMS Alerts card > **"View SMS Logs"** — the last sends show status badges:
`queued` → `delivered` (green) when the phone got the text, `failed` (red) with
the reason, `capped` (gray) when the daily budget ran out, or pinched/stuck
queued "sent" rows from before delivery tracking existed. A banner goes amber if
recent failures spike.

`GET /alert/sms-health` returns the same picture as JSON over the last 24 hours:
`processed`, `failed`, `capped`, `stuck_queued` (queued for over an hour), the
most recent failure with its reason, and the circuit breaker's current state.

---

## Phase F — Troubleshooting

**401 errors in the server console**
: API key is wrong / expired, or belongs to a different httpsms account.

**Nothing received**
: - `.env` changed but server not restarted
: - the phone fell asleep (re-check battery settings)
: - the HttpSms app shows "Disconnected"
: - `HTTPSMS_FROM` does not match the gateway SIM number

**Console says `circuit breaker OPEN`**
: The gateway is unreachable and the breaker is deliberately not calling it for
: 60 s at a time. Fix the phone/network; it will probe again automatically.

**Sends show as "failed"**
: Check `Settings > SMS Alerts > "View SMS Logs"`, or the `sms_logs` table in
: PostgreSQL. The `failure_reason` column (and the server console) shows the
: exact reason.

**A row stays "queued" forever and never becomes delivered**
: The delivery poller marks `queued` → `delivered`/`failed` via the httpsms
: messages list. If it never settles, the gateway phone likely went offline
: mid-delivery — check the HttpSms app's "Connected" state. Rows queued for more
: than an hour are also counted as `stuck_queued` by the health endpoint.

**Nothing sent and the logs say `capped`**
: You hit `SMS_DAILY_CAP`. Wait for the daily window to roll over or raise the
: cap. Manual test SMS bypass it, so a test still goes out.

**Number rejected when adding a recipient**
: Must be a valid PH mobile: `09XXXXXXXXX` (11 digits, easiest) or
: `+639XXXXXXXXX`.

---

## Quick notes

- SMS delivery is async/queued by httpsms — not instant, so be patient. The SMS
  Logs view turns "queued" into a green "delivered" badge once the gateway
  confirms it.
- Keep the API key and the gateway phone private. Anyone logged in as admin can
  send a test SMS and view SMS logs.
- The account-archive approval OTP stays **email-only**, is always addressed to
  the owner, and is untouched by the SMS system.
- SMS recipient list, mute, per-recipient test, and SMS Logs (delivery history)
  are all managed from `Settings > SMS Alerts`.
- `sms_logs.recipient_phone` has **no foreign key** to `authorized_recipients` —
  deliberately, so a delivery record is never destroyed by cleaning up the
  recipient list. Migration 016 installs a trigger that instead *rejects*
  inserting a phone number that is not an active recipient. See
  [DATABASE.md](DATABASE.md#table-sms_logs) for the full reasoning.

## Doc corrections (2026-10)

| Claim | Reality |
|---|---|
| Boot line is `[OK]   httpsms SMS configured (gateway +639...)` | Actual format is `[<ISO timestamp>] httpsms SMS configured (gateway <number>)` (`server.cjs:4995`) |
| `DISCONNECT_STALE_MS` defaults to `1800000` (30 min) | Code default is `30000` (30 s) (`server.cjs:989`). A live `.env` may override it, but 30 min would also keep `GET /devices` reporting tanks online for 30 min after they stop posting |
| Env vars are only the seven in the table | Also `HOURLY_SMS_ENABLED` and `DEVICE_DISCONNECT_ENABLED`, both defaulting to on |
| `+639XXXXXXXXX` "works too; it gets stored as `+639...`" | Correct but incomplete — `639XXXXXXXXX` (no `+`) is also accepted and normalised (`normalizePhNumber`, `server.cjs:976-982`) |
| Circuit breaker not mentioned | 5 failures → OPEN for 60 s → single HALF_OPEN probe (`services/smsService.cjs:18-21`) |
| `GET /alert/sms-health` not mentioned | Exists, returns 24 h counts + breaker state; useful for diagnosing a stuck queue |