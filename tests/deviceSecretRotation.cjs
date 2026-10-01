// =============================================================================
// tests/deviceSecretRotation.cjs - audit B4: secret rotation + grace window
// =============================================================================
// Run:  npm run test:secrets
//
// A board can only receive a new secret through its WiFiManager config portal,
// so rotating a secret is inherently a physical task. Rotation therefore keeps
// the OUTGOING secret valid for a bounded grace window (default 24h, capped at
// 7d) and the caller can pass grace_hours: 0 to revoke immediately.
//
// The security properties that must not regress:
//   1. The new secret is returned exactly once and never by a read endpoint.
//   2. The old secret works INSIDE the grace window and is rejected after it.
//   3. Rotation is atomic - never a moment with both secret columns NULL.
//   4. Rotation refuses devices that have no per-device secret, or that are
//      archived (a retired ID has nothing to rotate).
//   5. A negative grace_hours is rejected and burns nothing.
//   6. Non-admins cannot rotate.
//
// Requires a running server (API_BASE, default http://localhost:3000) and
// DEVICE_SECRET set. Test devices are removed at the end.
// =============================================================================

require("dotenv").config();
const assert = require("assert");
const crypto = require("crypto");
const { Pool } = require("pg");

const API = process.env.API_BASE || "http://localhost:3000";
const DEVICE_SECRET = process.env.DEVICE_SECRET;
const PREFIX = "ZZSEC_";
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

let checks = 0;
let failures = 0;
let adminToken = null;
let userToken = null;
let adminName = null;

function check(name, cond, extra = "") {
  checks++;
  if (cond) console.log(`PASS  ${name}${extra ? "  -> " + extra : ""}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${extra ? "  -> " + extra : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token = adminToken, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: method.toUpperCase(),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

// POST /sensor with a specific X-Device-Secret; the ingest path is the only
// consumer of device secrets, so it is the only honest way to test acceptance.
async function ingest(deviceId, secret) {
  const res = await fetch(`${API}/sensor`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Secret": secret,
    },
    body: JSON.stringify({ device_id: deviceId, temperature: 27.5, ph: 7.2, water_level: 30 }),
  });
  return { status: res.status, body: await res.text() };
}

async function login(username, password) {
  const r = await api("post", "/auth/login", { token: null, body: { username, password } });
  return r;
}

async function setSecret(deviceId, secret) {
  await pool.query(
    `UPDATE devices SET device_secret = $2, device_secret_prev = NULL,
            device_secret_prev_expires_at = NULL, device_secret_rotated_at = NULL
      WHERE device_id = $1`,
    [deviceId, secret]
  );
}

async function main() {
  console.log("=== Device secret rotation (B4) ===\n");

  if (!DEVICE_SECRET) {
    console.log("SKIP  DEVICE_SECRET not set - cannot test device authentication");
    process.exit(0);
  }

  // --- A. Authenticate -------------------------------------------------------
  // Mints a session token directly against the users table, the same approach
  // tests/devices.cjs uses. Rotation is admin-gated, so the test needs a real
  // admin session, but it deliberately does not depend on anyone's password.
  console.log("--- A. Admin session ---");
  const account = await pool.query(
    `SELECT username FROM users WHERE role = 'admin' AND status = 'active' ORDER BY username LIMIT 1`
  );
  if (account.rows.length === 0) {
    console.log("SKIP  no active admin account found");
    await pool.end();
    process.exit(0);
  }
  adminName = account.rows[0].username;
  adminToken = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "UPDATE users SET token = $1, token_expires_at = NOW() + interval '2 hours' WHERE username = $2",
    [sha256(adminToken), adminName]
  );
  check("admin session minted", Boolean(adminToken), adminName);
  console.log(`Running as admin account: ${adminName}`);

  // A plain 'user' role account, to prove rotation is admin-gated.
  const plainUser = `${PREFIX}user`;
  userToken = crypto.randomBytes(32).toString("hex");
  await pool.query("DELETE FROM users WHERE username = $1", [plainUser]);
  await pool.query(
    `INSERT INTO users (name, username, email, password_hash, role, token, token_expires_at, status)
     VALUES ('Secret Test User', $1, $2, 'not-a-real-hash', 'user', $3, NOW() + interval '2 hours', 'active')`,
    [plainUser, `${PREFIX}user@example.invalid`, sha256(userToken)]
  );
  check("non-admin session minted", Boolean(userToken));

  const { deviceSecret: rotatable } = { deviceSecret: `sec_${PREFIX}original_1111111111` };

  // A device that already owns a per-device secret, for the rotation tests.
  const rotId = `${PREFIX}ROT`;
  await api("post", "/devices", {
    body: { device_id: rotId, device_name: "Rotation Test Tank" },
  });
  await setSecret(rotId, rotatable);

  // A device with NO per-device secret - must refuse rotation.
  const noSecretId = `${PREFIX}NOSEC`;
  await api("post", "/devices", { body: { device_id: noSecretId, device_name: "No Secret Tank" } });
  await pool.query("UPDATE devices SET device_secret = NULL WHERE device_id = $1", [noSecretId]);

  // --- B. Rotation refuses ineligible devices -------------------------------
  console.log("\n--- B. Rotation preconditions ---");

  let r = await api("post", `/devices/${noSecretId}/rotate-secret`, { body: { grace_hours: 1 } });
  check("rotate a device with no per-device secret -> 409", r.status === 409, `status=${r.status}`);
  check(
    "the 409 explains the device uses the shared secret",
    /shared DEVICE_SECRET/i.test(r.body?.message || ""),
    r.body?.message
  );
  check(
    "the 409 advertises the migration instead of a dead end",
    r.body?.can_migrate_from_shared === true
  );

  r = await api("post", `/devices/${PREFIX}MISSING/rotate-secret`, { body: {} });
  check("rotate an unknown device -> 404", r.status === 404, `status=${r.status}`);

  r = await api("post", `/devices/${rotId}/rotate-secret`, { body: { grace_hours: -5 } });
  check("negative grace_hours -> 400", r.status === 400, `status=${r.status}`);

  // A rejected request must not have consumed the old secret.
  const stillWorks = await ingest(rotId, rotatable);
  check("a rejected rotate left the existing secret working", stillWorks.status < 400, `status=${stillWorks.status}`);

  // Archived devices have permanently retired IDs - nothing to rotate.
  const archId = `${PREFIX}ARCH`;
  await api("post", "/devices", { body: { device_id: archId, device_name: "Archived Tank" } });
  await setSecret(archId, `sec_${PREFIX}arch`);
  await api("post", `/devices/${archId}/archive`);
  r = await api("post", `/devices/${archId}/rotate-secret`, { body: { grace_hours: 1 } });
  check("rotate an archived device -> 409", r.status === 409, `status=${r.status}`);
  await api("post", `/devices/${archId}/restore`);

  // --- C. Rotation with a grace window --------------------------------------
  console.log("\n--- C. Rotation with grace window ---");

  r = await api("post", `/devices/${rotId}/rotate-secret`, { body: { grace_hours: 1 } });
  check("rotate -> 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

  const newSecret = r.body?.device_secret;
  check("response carries a new device_secret", typeof newSecret === "string" && newSecret.length > 0);
  check("the new secret is NOT the old one", newSecret !== rotatable);
  check("the new secret looks like 64 hex chars (32 CSPRNG bytes)", /^[0-9a-f]{64}$/.test(newSecret || ""), `len=${(newSecret || "").length}`);
  check("rotated_at is reported", Boolean(r.body?.rotated_at));
  check("previous secret is NOT revoked", r.body?.previous_secret_revoked === false);
  check("grace window is reported in hours", r.body?.previous_secret_grace_hours === 1, String(r.body?.previous_secret_grace_hours));
  check("the previous secret's deadline is reported", Boolean(r.body?.previous_secret_expires_at));

  // The DB must hold the new secret, with the old one parked and dated.
  const row = await pool.query(
    `SELECT device_secret, device_secret_prev, device_secret_prev_expires_at, device_secret_rotated_at
       FROM devices WHERE device_id = $1`,
    [rotId]
  );
  check("DB holds the new secret", row.rows[0]?.device_secret === newSecret);
  check("DB parks the previous secret", row.rows[0]?.device_secret_prev === rotatable);
  check("DB dates the previous secret", Boolean(row.rows[0]?.device_secret_prev_expires_at));
  check("DB stamps the rotation time", Boolean(row.rows[0]?.device_secret_rotated_at));

  // Both secrets must authenticate inside the window.
  const withNew = await ingest(rotId, newSecret);
  check("NEW secret authenticates", withNew.status < 400, `status=${withNew.status}`);
  const withOld = await ingest(rotId, rotatable);
  check("PREVIOUS secret still authenticates inside the grace window", withOld.status < 400, `status=${withOld.status}`);

  const withGarbage = await ingest(rotId, "totally-wrong-secret");
  check("an unrelated secret is still rejected", withGarbage.status === 401, `status=${withGarbage.status}`);

  // --- D. The window actually expires ---------------------------------------
  console.log("\n--- D. Grace window expiry ---");
  // Force the deadline into the past rather than sleeping for an hour.
  await pool.query(
    `UPDATE devices SET device_secret_prev_expires_at = NOW() - INTERVAL '1 second'
      WHERE device_id = $1`,
    [rotId]
  );
  const afterExpiry = await ingest(rotId, rotatable);
  check("PREVIOUS secret is rejected once the window closes", afterExpiry.status === 401, `status=${afterExpiry.status}`);
  const newStillWorks = await ingest(rotId, newSecret);
  check("NEW secret still authenticates after the window closes", newStillWorks.status < 400, `status=${newStillWorks.status}`);

  // --- E. Immediate revocation ----------------------------------------------
  console.log("\n--- E. grace_hours: 0 revokes immediately ---");

  r = await api("post", `/devices/${rotId}/rotate-secret`, { body: { grace_hours: 0 } });
  check("rotate with grace_hours 0 -> 200", r.status === 200, `status=${r.status}`);
  check("previous_secret_revoked is true", r.body?.previous_secret_revoked === true);
  check("no deadline is returned for a revoked secret", r.body?.previous_secret_expires_at === null);

  const secondNew = r.body?.device_secret;
  check("a second, different secret was issued", secondNew && secondNew !== newSecret);
  check("the second secret is 64 hex chars", /^[0-9a-f]{64}$/.test(secondNew || ""));

  // The secret from step C must be dead immediately, with no grace.
  const deadNow = await ingest(rotId, newSecret);
  check("the superseded secret is rejected IMMEDIATELY at grace 0", deadNow.status === 401, `status=${deadNow.status}`);
  const liveNow = await ingest(rotId, secondNew);
  check("the newest secret authenticates", liveNow.status < 400, `status=${liveNow.status}`);

  // Immediate revocation must not leave a half-cleared pair behind.
  const pairRow = await pool.query(
    `SELECT device_secret_prev, device_secret_prev_expires_at FROM devices WHERE device_id = $1`,
    [rotId]
  );
  check("immediate revoke leaves no previous secret", pairRow.rows[0]?.device_secret_prev === null);
  check("immediate revoke leaves no deadline", pairRow.rows[0]?.device_secret_prev_expires_at === null);

  // --- F. Migration off the shared secret ------------------------------------
  console.log("\n--- F. First-secret migration (shared -> per-device) ---");

  // A device that is still on the shared DEVICE_SECRET has nothing to rotate.
  // Issuing its first per-device secret must be explicit, must not pretend a
  // previous secret was replaced, and must report how much of the fleet is
  // still exposed.
  r = await api("post", `/devices/${noSecretId}/rotate-secret`, {
    body: { migrate_from_shared: true },
  });
  check("migrate_from_shared -> 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
  check("the response says this was a FIRST secret", r.body?.first_secret === true);
  check("the response reports remaining shared-secret devices", typeof r.body?.devices_still_on_shared_secret === "number", String(r.body?.devices_still_on_shared_secret));
  check("a first secret is issued", /^[0-9a-f]{64}$/.test(r.body?.device_secret || ""));

  // No previous per-device secret existed, so nothing may be parked or dated.
  const migRow = await pool.query(
    `SELECT device_secret, device_secret_prev, device_secret_prev_expires_at
       FROM devices WHERE device_id = $1`,
    [noSecretId]
  );
  check("migration stores the new secret", migRow.rows[0]?.device_secret === r.body?.device_secret);
  check("migration parks NO previous secret", migRow.rows[0]?.device_secret_prev === null);
  check("migration sets NO grace deadline", migRow.rows[0]?.device_secret_prev_expires_at === null);

  // The new per-device secret authenticates...
  const migWorks = await ingest(noSecretId, r.body.device_secret);
  check("the issued per-device secret authenticates", migWorks.status < 400, `status=${migWorks.status}`);

  // ...and the shared secret still works too - which is the honest caveat, and
  // the reason devices_still_on_shared_secret matters. A device that is NOT
  // registered must still be able to auto-register with the shared secret.
  const sharedWorks = await ingest(`${PREFIX}NEWAUTODEVICE`, DEVICE_SECRET);
  check("the shared secret still auto-registers new boards", sharedWorks.status < 400, `status=${sharedWorks.status}`);
  await pool.query("DELETE FROM sensors WHERE device_id = $1", [`${PREFIX}NEWAUTODEVICE`]);
  await pool.query("DELETE FROM devices WHERE device_id = $1", [`${PREFIX}NEWAUTODEVICE`]);

  // Now that the device owns a secret, a plain rotation works again.
  r = await api("post", `/devices/${noSecretId}/rotate-secret`, { body: { grace_hours: 2 } });
  check("a migrated device can be rotated normally afterwards", r.status === 200, `status=${r.status}`);
  check("the second call is a rotation, not a first secret", r.body?.first_secret === false);
  check("the rotation parks a previous secret", Boolean(r.body?.previous_secret_expires_at));

  // --- G. The secret is never readable --------------------------------------
  console.log("\n--- G. Secrets never leak through read endpoints ---");


  const list = await api("get", "/devices");
  const listText = JSON.stringify(list.body);
  check("GET /devices does not include device_secret", !/"device_secret"\s*:/.test(listText));
  check("GET /devices does not include device_secret_prev", !/"device_secret_prev"\s*:/.test(listText));
  check("GET /devices does not leak the secret VALUE", !listText.includes(secondNew));

  // There is no GET /devices/:id route (only /devices/:id/status, which is the
  // live board read), so the list endpoint is the read surface to assert on.
  const listText2 = JSON.stringify(list.body);
  check("device reads expose rotation METADATA", listText2.includes("device_secret_rotated_at"));
  check("device reads expose the grace deadline", listText2.includes("device_secret_prev_expires_at"));

  // /status must stay a board-health read, never a secret read.
  const st = await api("get", `/devices/${rotId}/status`);
  const stText = JSON.stringify(st.body);
  check("/devices/:id/status does not leak the secret VALUE", !stText.includes(secondNew));
  check("/devices/:id/status does not include device_secret", !/"device_secret"\s*:/.test(stText));

  // An update echo must not leak it either.
  const upd = await api("put", `/devices/${rotId}`, { body: { tank_name: "Rotated Tank" } });
  check("PUT /devices/:id does not leak the secret VALUE", !JSON.stringify(upd.body).includes(secondNew));

  // --- H. Rotation is admin-only --------------------------------------------
  console.log("\n--- H. Permissions ---");
  r = await api("post", `/devices/${rotId}/rotate-secret`, { token: userToken, body: { grace_hours: 1 } });
  check("non-admin rotate -> 403", r.status === 403, `status=${r.status}`);
  r = await api("post", `/devices/${rotId}/rotate-secret`, { token: null, body: {} });
  check("unauthenticated rotate -> 401", r.status === 401, `status=${r.status}`);

  // A refused call must not have rotated anything.
  const afterDenied = await pool.query(
    "SELECT device_secret FROM devices WHERE device_id = $1",
    [rotId]
  );
  check("a denied rotate did not change the stored secret", afterDenied.rows[0]?.device_secret === secondNew);

  // --- Cleanup ---------------------------------------------------------------
  console.log("\n--- I. Cleanup ---");
  for (const id of [rotId, noSecretId, archId]) {
    await pool.query("DELETE FROM sensors WHERE device_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM devices WHERE device_id = $1", [id]).catch(() => {});
  }
  await pool.query("DELETE FROM users WHERE username = $1", [plainUser]).catch(() => {});
  const leftover = await pool.query("SELECT count(*)::int AS n FROM devices WHERE device_id LIKE $1", [`${PREFIX}%`]);
  check("no test devices left", leftover.rows[0].n === 0, `${leftover.rows[0].n} rows`);
  const leftoverUsers = await pool.query("SELECT count(*)::int AS n FROM users WHERE username = $1", [plainUser]);
  check("no test users left", leftoverUsers.rows[0].n === 0, `${leftoverUsers.rows[0].n} rows`);

  console.log(
    `\n${failures === 0 ? "=== ALL SECRET ROTATION TESTS PASSED ===" : `=== ${failures} FAILED ===`} (${checks} checks)`
  );
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("secret rotation test crashed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
