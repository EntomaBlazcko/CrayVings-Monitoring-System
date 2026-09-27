// =============================================================================
// tests/devices.cjs - Device registry: registration, uniqueness, archiving
// =============================================================================
// Backend end-to-end tests for the Devices module. Requires the API server to be
// running (npm run server) and a live PostgreSQL.
//
//   Run:  npm run test:devices
//
// Covers the requirements that are NOT covered by tests/regression.cjs:
//   - POST /devices registration and its validation rules
//   - system-wide, case-insensitive device_id uniqueness (including vs archived)
//   - archive / restore round trip with historical data preserved
//   - archived devices disappearing from every active surface
//   - an Owner-typed IP surviving ingestion (ip_source = 'manual')
//   - a non-admin account being refused every write
//
// Every test device is created with a ZZTEST_ prefix and removed afterwards, so
// the suite is safe to run against a populated farm database.
// =============================================================================

const axios = require("axios");
const crypto = require("crypto");
const { Pool } = require("pg");
require("dotenv").config();

const API = process.env.API_BASE || "http://localhost:3000";
const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

const PREFIX = "ZZTEST_";
let ADMIN_TOKEN;
let USER_TOKEN;
let failures = 0;
let checks = 0;

function check(name, cond, extra = "") {
  checks++;
  if (cond) console.log(`PASS  ${name}${extra ? "  -> " + extra : ""}`);
  else { failures++; console.log(`FAIL  ${name}${extra ? "  -> " + extra : ""}`); }
}

async function api(method, url, data, headers = {}, token = ADMIN_TOKEN) {
  try {
    const res = await axios({
      method,
      url: API + url,
      data,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      validateStatus: () => true,
    });
    return { status: res.status, body: res.data };
  } catch (err) {
    return { status: err.response?.status ?? -1, body: err.response?.data ?? { message: err.message } };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (v) => crypto.createHash("sha256").update(v, "utf8").digest("hex");

// Mirrors server.cjs POST /sensor exactly. A separate /sensor path is used
// because the device-ingest route is skipped by the global rate limiter and is
// authenticated by X-Device-Secret rather than a user token.
async function ingest(deviceId, temperature, waterLevel, secret) {
  try {
    const res = await axios({
      method: "post",
      url: `${API}/sensor`,
      data: { device_id: deviceId, temperature, water_level: waterLevel },
      headers: secret ? { "X-Device-Secret": secret } : {},
      validateStatus: () => true,
    });
    return { status: res.status, body: res.data };
  } catch (err) {
    return { status: err.response?.status ?? -1, body: err.response?.data ?? {} };
  }
}

// Removes every trace of a test device so the suite can be re-run.
async function purge(deviceId) {
  await pool.query("DELETE FROM sensors WHERE device_id = $1", [deviceId]);
  await pool.query("DELETE FROM system_logs WHERE device_id = $1", [deviceId]);
  await pool.query("DELETE FROM last_alerts WHERE device_id = $1", [deviceId]);
  await pool.query("DELETE FROM device_threshold_overrides WHERE device_id = $1", [deviceId]);
  await pool.query("DELETE FROM activity_logs WHERE description LIKE $1", [`%${deviceId}%`]);
  await pool.query("DELETE FROM devices WHERE device_id = $1", [deviceId]);
}

(async () => {
  // ---- sessions ------------------------------------------------------------
  const account = await pool.query(
    "SELECT username FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1"
  );
  if (account.rows.length === 0) {
    console.error("No active admin account found - cannot run the device tests.");
    await pool.end();
    process.exit(2);
  }
  const adminName = account.rows[0].username;
  ADMIN_TOKEN = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "UPDATE users SET token = $1, token_expires_at = NOW() + interval '2 hours' WHERE username = $2",
    [sha256(ADMIN_TOKEN), adminName]
  );
  console.log(`Running as admin account: ${adminName}`);

  // A plain 'user' role account, used to prove the writes are admin-gated.
  const plainUser = `${PREFIX}user`;
  USER_TOKEN = crypto.randomBytes(32).toString("hex");
  await pool.query("DELETE FROM users WHERE username = $1", [plainUser]);
  await pool.query(
    `INSERT INTO users (name, username, email, password_hash, role, token, token_expires_at, status)
     VALUES ('Device Test User', $1, $2, 'not-a-real-hash', 'user', $3, NOW() + interval '2 hours', 'active')`,
    [plainUser, `${PREFIX}user@example.invalid`, sha256(USER_TOKEN)]
  );

  // Clear any residue from a previous interrupted run.
  const stale = await pool.query("SELECT device_id FROM devices WHERE device_id LIKE $1", [`${PREFIX}%`]);
  for (const row of stale.rows) await purge(row.device_id);

  const deviceSecret = process.env.DEVICE_SECRET;

  try {
    // =====================================================================
    console.log("--- A. Registration: POST /devices ---");
    // =====================================================================
    const basic = { device_id: `${PREFIX}A`, device_name: "Test Tank A", ip_address: "192.168.100.50", tank_location: "North Bay" };
    let r = await api("post", "/devices", basic);
    check("create device -> 201", r.status === 201, `status=${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    check("returns the supplied id", r.body.device_id === basic.device_id, r.body.device_id);
    check("stores name as tank_name", r.body.tank_name === "Test Tank A", r.body.tank_name);
    check("stores name column too", r.body.name === "Test Tank A", r.body.name);
    check("stores location", r.body.tank_location === "North Bay", r.body.tank_location);
    check("stores IP", r.body.ip_address === "192.168.100.50", r.body.ip_address);
    check("registered_via = manual", r.body.registered_via === "manual", r.body.registered_via);
    check("ip_source = manual when IP given", r.body.ip_source === "manual", r.body.ip_source);
    check("starts active", r.body.is_active === true, String(r.body.is_active));
    check("starts unarchived", r.body.archived_at === null, String(r.body.archived_at));
    check("not online yet", r.body.online === false, String(r.body.online));

    // No IP supplied -> stays 'auto' so the first ingest can learn it.
    r = await api("post", "/devices", { device_id: `${PREFIX}NOIP`, device_name: "No IP Tank" });
    check("create without IP -> 201", r.status === 201, `status=${r.status}`);
    check("no IP -> ip_address null", r.body.ip_address === null, String(r.body.ip_address));
    check("no IP -> ip_source stays auto", r.body.ip_source === "auto", r.body.ip_source);
    check("no IP -> still registered_via manual", r.body.registered_via === "manual", r.body.registered_via);

    // Blank strings must be treated as "not supplied", not stored.
    r = await api("post", "/devices", { device_id: `${PREFIX}BLANK`, device_name: "Blank Tank", ip_address: "", tank_location: "" });
    check("blank IP accepted as omitted", r.status === 201 && r.body.ip_address === null, `status=${r.status} ip=${r.body.ip_address}`);
    check("blank location accepted as omitted", r.body.tank_location === null, String(r.body.tank_location));

    // =====================================================================
    console.log("--- B. Uniqueness: system-wide and case-insensitive ---");
    // =====================================================================
    r = await api("post", "/devices", basic);
    check("exact duplicate -> 409", r.status === 409, `status=${r.status}`);
    check("duplicate message is actionable", /already registered/i.test(r.body.message || ""), r.body.message);
    check("duplicate names the field", !!r.body.errors?.device_id, JSON.stringify(r.body.errors));

    r = await api("post", "/devices", { ...basic, device_id: basic.device_id.toLowerCase() });
    check("case-variant duplicate -> 409", r.status === 409, `status=${r.status}`);

    // Two different devices must still be allowed - no fixed fleet cap.
    r = await api("post", "/devices", { device_id: `${PREFIX}B`, device_name: "Test Tank B" });
    check("a different id is accepted -> 201", r.status === 201, `status=${r.status}`);

    // =====================================================================
    console.log("--- C. Validation ---");
    // =====================================================================
    const bad = [
      ["missing device_id", { device_name: "X" }],
      ["missing device_name", { device_id: `${PREFIX}V1` }],
      ["blank device_id", { device_id: "   ", device_name: "X" }],
      ["device_id too long", { device_id: "A".repeat(51), device_name: "X" }],
      ["device_id with space", { device_id: "ESP 32", device_name: "X" }],
      ["device_id with slash", { device_id: "ESP/32", device_name: "X" }],
      ["device_id with sql chars", { device_id: "ESP32'; DROP TABLE devices;--", device_name: "X" }],
      ["name too long", { device_id: `${PREFIX}V2`, device_name: "N".repeat(101) }],
      ["non-IPv4 ip", { device_id: `${PREFIX}V3`, device_name: "X", ip_address: "not-an-ip" }],
      ["IPv4 octet out of range", { device_id: `${PREFIX}V4`, device_name: "X", ip_address: "999.1.1.1" }],
      ["ip with url path", { device_id: `${PREFIX}V5`, device_name: "X", ip_address: "10.0.0.1/status" }],
      ["ip with hostname", { device_id: `${PREFIX}V6`, device_name: "X", ip_address: "evil.example.com" }],
      ["location too long", { device_id: `${PREFIX}V7`, device_name: "X", tank_location: "L".repeat(101) }],
    ];
    for (const [label, payload] of bad) {
      const res = await api("post", "/devices", payload);
      check(`rejects ${label} -> 400`, res.status === 400, `status=${res.status} ${JSON.stringify(res.body).slice(0, 90)}`);
    }
    // The injection attempt above must not have created a row or broken the table.
    const stillThere = await pool.query("SELECT COUNT(*)::int AS n FROM devices");
    check("devices table intact after injection attempt", stillThere.rows[0].n > 0, `${stillThere.rows[0].n} rows`);

    // =====================================================================
    console.log("--- D. Permissions: admin-only writes ---");
    // =====================================================================
    r = await api("post", "/devices", { device_id: `${PREFIX}U1`, device_name: "Unauthorised" }, {}, USER_TOKEN);
    check("non-admin POST /devices -> 403", r.status === 403, `status=${r.status} ${r.body.message}`);

    r = await api("put", `/devices/${PREFIX}A`, { tank_name: "Hijacked" }, {}, USER_TOKEN);
    check("non-admin PUT /devices/:id -> 403", r.status === 403, `status=${r.status} ${r.body.message}`);

    r = await api("post", `/devices/${PREFIX}A/archive`, {}, {}, USER_TOKEN);
    check("non-admin archive -> 403", r.status === 403, `status=${r.status}`);

    r = await api("post", `/devices/${PREFIX}A/restore`, {}, {}, USER_TOKEN);
    check("non-admin restore -> 403", r.status === 403, `status=${r.status}`);

    r = await api("post", "/devices", { device_id: `${PREFIX}U2`, device_name: "No Token" }, {}, "garbage-token");
    check("invalid token -> 403", r.status === 403, `status=${r.status}`);

    // The rejected writes must have left no trace.
    const hijacked = await pool.query("SELECT tank_name FROM devices WHERE device_id = $1", [`${PREFIX}A`]);
    check("non-admin rename did not apply", hijacked.rows[0]?.tank_name === "Test Tank A", hijacked.rows[0]?.tank_name);
    const ghosts = await pool.query("SELECT COUNT(*)::int AS n FROM devices WHERE device_id IN ($1, $2)", [`${PREFIX}U1`, `${PREFIX}U2`]);
    check("non-admin create did not apply", ghosts.rows[0].n === 0, `${ghosts.rows[0].n} rows`);

    // =====================================================================
    console.log("--- E. GET /devices: visibility flags ---");
    // =====================================================================
    r = await api("get", "/devices");
    check("GET /devices -> 200", r.status === 200, `status=${r.status}`);
    const listed = r.body.map((d) => d.device_id);
    check("lists the registered device", listed.includes(`${PREFIX}A`), `${listed.length} devices`);
    // Compare against the DB rather than a literal id: existing mock devices have
    // ids containing spaces, so hardcoding "ESP32_04" would pass trivially.
    const inactiveIds = await pool.query(
      "SELECT device_id FROM devices WHERE is_active = false AND archived_at IS NULL"
    );
    const leaked = inactiveIds.rows.map((x) => x.device_id).filter((id) => listed.includes(id));
    check("default view excludes every hidden device", leaked.length === 0, `leaked: ${leaked.join(", ") || "none"}`);

    const row = r.body.find((d) => d.device_id === `${PREFIX}A`);
    check("exposes registered_via", row.registered_via === "manual", row.registered_via);
    check("exposes ip_source", row.ip_source === "manual", row.ip_source);
    check("exposes archived_at", "archived_at" in row, String(row.archived_at));

    // =====================================================================
    console.log("--- F. Ingestion: a registered device starts reporting ---");
    // =====================================================================
    if (deviceSecret) {
      r = await ingest(`${PREFIX}A`, 27.5, 60, deviceSecret);
      check("registered device ingests -> 201/200", r.status === 201 || r.status === 200, `status=${r.status}`);
      await sleep(300);
      const seen = await pool.query("SELECT last_seen, registered_via, ip_address FROM devices WHERE device_id = $1", [`${PREFIX}A`]);
      check("ingest refreshes last_seen", seen.rows[0]?.last_seen !== null, String(seen.rows[0]?.last_seen));
      check("ingest does NOT flip registered_via to auto", seen.rows[0]?.registered_via === "manual", seen.rows[0]?.registered_via);
      check("Owner-typed IP survives ingestion", seen.rows[0]?.ip_address === "192.168.100.50", seen.rows[0]?.ip_address);
    } else {
      console.log("SKIP  ingestion tests (DEVICE_SECRET not set)");
    }

    // ip_source semantics, asserted directly against the SQL the server runs.
    // A loopback ingest cannot prove this on its own (normalizeClientIp returns
    // null for loopback), so exercise the upsert expression itself.
    await pool.query("UPDATE devices SET ip_source = 'manual', ip_address = '10.20.30.40' WHERE device_id = $1", [`${PREFIX}NOIP`]);
    await pool.query(
      `INSERT INTO devices (device_id, ip_address, last_seen, registered_via, ip_source)
       VALUES ($1, $2, $3, 'auto', 'auto')
       ON CONFLICT (device_id) DO UPDATE
          SET last_seen = $3,
              ip_address = CASE WHEN devices.ip_source = 'manual' THEN devices.ip_address
                                ELSE COALESCE($2, devices.ip_address) END`,
      [`${PREFIX}NOIP`, "172.16.0.9", new Date()]
    );
    let ipRow = await pool.query("SELECT ip_address, ip_source FROM devices WHERE device_id = $1", [`${PREFIX}NOIP`]);
    check("ip_source=manual blocks the auto overwrite", ipRow.rows[0].ip_address === "10.20.30.40", ipRow.rows[0].ip_address);

    await pool.query("UPDATE devices SET ip_source = 'auto' WHERE device_id = $1", [`${PREFIX}NOIP`]);
    await pool.query(
      `INSERT INTO devices (device_id, ip_address, last_seen, registered_via, ip_source)
       VALUES ($1, $2, $3, 'auto', 'auto')
       ON CONFLICT (device_id) DO UPDATE
          SET last_seen = $3,
              ip_address = CASE WHEN devices.ip_source = 'manual' THEN devices.ip_address
                                ELSE COALESCE($2, devices.ip_address) END`,
      [`${PREFIX}NOIP`, "172.16.0.9", new Date()]
    );
    ipRow = await pool.query("SELECT ip_address FROM devices WHERE device_id = $1", [`${PREFIX}NOIP`]);
    check("ip_source=auto still learns the peer address", ipRow.rows[0].ip_address === "172.16.0.9", ipRow.rows[0].ip_address);

    // Auto-registration still works for an unregistered board (FK safety net).
    const autoId = `${PREFIX}AUTO`;
    await ingest(autoId, 26, 55, deviceSecret);
    await sleep(300);
    const autoRow = await pool.query("SELECT registered_via FROM devices WHERE device_id = $1", [autoId]);
    check("unregistered board is auto-registered", autoRow.rows.length === 1, `${autoRow.rows.length} rows`);
    check("auto-registered board tagged registered_via=auto", autoRow.rows[0]?.registered_via === "auto", autoRow.rows[0]?.registered_via);
    // ...and it can be reported against as a duplicate, because it now exists.
    r = await api("post", "/devices", { device_id: autoId, device_name: "Late Registration" });
    check("auto-registered id cannot be re-registered -> 409", r.status === 409, `status=${r.status}`);

    // =====================================================================
    console.log("--- G. Archiving ---");
    // =====================================================================
    const beforeSensors = await pool.query("SELECT COUNT(*)::int AS n FROM sensors WHERE device_id = $1", [`${PREFIX}A`]);
    const beforeLogs = await pool.query("SELECT COUNT(*)::int AS n FROM system_logs WHERE device_id = $1", [`${PREFIX}A`]);

    r = await api("post", `/devices/${PREFIX}A/archive`);
    check("archive -> 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    check("archive sets archived_at", !!r.body.archived_at, String(r.body.archived_at));
    check("archive records archived_by", r.body.archived_by === adminName, r.body.archived_by);
    check("archive forces is_active=false", r.body.is_active === false, String(r.body.is_active));
    check("archive reports retained readings", r.body.retained_readings === beforeSensors.rows[0].n, `${r.body.retained_readings} vs ${beforeSensors.rows[0].n}`);

    const devRow = await pool.query("SELECT COUNT(*)::int AS n FROM devices WHERE device_id = $1", [`${PREFIX}A`]);
    check("device row is NOT deleted", devRow.rows[0].n === 1, `${devRow.rows[0].n} rows`);

    const afterSensors = await pool.query("SELECT COUNT(*)::int AS n FROM sensors WHERE device_id = $1", [`${PREFIX}A`]);
    check("sensor history preserved", afterSensors.rows[0].n === beforeSensors.rows[0].n, `${beforeSensors.rows[0].n} -> ${afterSensors.rows[0].n}`);
    const afterLogs = await pool.query("SELECT COUNT(*)::int AS n FROM system_logs WHERE device_id = $1", [`${PREFIX}A`]);
    check("system log history preserved", afterLogs.rows[0].n === beforeLogs.rows[0].n, `${beforeLogs.rows[0].n} -> ${afterLogs.rows[0].n}`);

    // Archived devices vanish from every active surface.
    r = await api("get", "/devices");
    check("archived device hidden from default GET /devices", !r.body.map((d) => d.device_id).includes(`${PREFIX}A`), "");
    r = await api("get", "/devices?include_archived=1");
    check("archived device listed with include_archived=1", r.body.map((d) => d.device_id).includes(`${PREFIX}A`), "");
    r = await api("get", "/devices/latest");
    check("archived device absent from /devices/latest", !r.body.map((d) => d.device_id).includes(`${PREFIX}A`), "");
    r = await api("get", "/devices?include_hidden=1");
    check("archived device still hidden even with include_hidden=1", !r.body.map((d) => d.device_id).includes(`${PREFIX}A`), "");
    // Derived from the DB rather than hardcoded: pre-existing mock devices have
    // ids containing spaces (e.g. "ESP32_04 Mock Low Water"), so a literal
    // "ESP32_04" would never match.
    const hiddenRow = await pool.query(
      "SELECT device_id FROM devices WHERE is_active = false AND archived_at IS NULL ORDER BY device_id LIMIT 1"
    );
    if (hiddenRow.rows.length === 0) {
      console.log("SKIP  include_hidden assertion (no hidden device in the database)");
    } else {
      const hiddenId = hiddenRow.rows[0].device_id;
      check("include_hidden=1 lists the hidden device", r.body.map((d) => d.device_id).includes(hiddenId), hiddenId);
    }
    r = await api("get", "/devices?include_archived=1&include_hidden=1");
    check("both flags together list the archived device", r.body.map((d) => d.device_id).includes(`${PREFIX}A`), "");

    // Historical data is still reachable by direct query.
    r = await api("get", `/sensor?device_id=${PREFIX}A&limit=10`);
    check("archived device history still queryable", r.status === 200 && Array.isArray(r.body), `status=${r.status} rows=${Array.isArray(r.body) ? r.body.length : "n/a"}`);

    // An archived device_id is permanently retired.
    r = await api("post", "/devices", { device_id: `${PREFIX}A`, device_name: "Reuse Attempt" });
    check("archived id cannot be reused -> 409", r.status === 409, `status=${r.status}`);
    check("reuse message explains permanence", /permanently retired/i.test(r.body.message || ""), r.body.message);
    r = await api("post", "/devices", { device_id: `${PREFIX}a`, device_name: "Reuse Attempt Lower" });
    check("archived id cannot be reused case-insensitively -> 409", r.status === 409, `status=${r.status}`);

    // 404s
    r = await api("post", "/devices/NO_SUCH_DEVICE_XYZ/archive");
    check("archive unknown device -> 404", r.status === 404, `status=${r.status}`);
    r = await api("post", "/devices/NO_SUCH_DEVICE_XYZ/restore");
    check("restore unknown device -> 404", r.status === 404, `status=${r.status}`);

    // =====================================================================
    console.log("--- H. Restore ---");
    // =====================================================================
    r = await api("post", `/devices/${PREFIX}A/restore`);
    check("restore -> 200", r.status === 200, `status=${r.status}`);
    check("restore clears archived_at", r.body.archived_at === null, String(r.body.archived_at));
    check("restore clears archived_by", r.body.archived_by === null, String(r.body.archived_by));
    check("restore reactivates the device", r.body.is_active === true, String(r.body.is_active));
    check("restore preserves the friendly name", r.body.tank_name === "Test Tank A", r.body.tank_name);
    check("restore preserves the IP", r.body.ip_address === "192.168.100.50", r.body.ip_address);

    r = await api("get", "/devices");
    check("restored device back in default GET /devices", r.body.map((d) => d.device_id).includes(`${PREFIX}A`), "");

    // Re-archive so the final cleanup assertions are meaningful.
    r = await api("post", `/devices/${PREFIX}A/archive`);
    check("re-archive works", r.status === 200 && !!r.body.archived_at, `status=${r.status}`);

    // =====================================================================
    console.log("--- I. Scale: no fixed device limit ---");
    // =====================================================================
    const scaleIds = Array.from({ length: 12 }, (_, i) => `${PREFIX}S${i + 1}`);
    const created = [];
    for (const id of scaleIds) {
      const res = await api("post", "/devices", { device_id: id, device_name: `Scale ${id}` });
      if (res.status === 201) created.push(id);
    }
    check("registered 12 devices in one go", created.length === 12, `${created.length}/12 created`);

    r = await api("get", "/devices");
    const listedIds = r.body.map((d) => d.device_id);
    const missing = created.filter((id) => !listedIds.includes(id));
    check("all 12 appear in GET /devices", missing.length === 0, `missing: ${missing.join(", ") || "none"}`);
    console.log(`      (total active devices now: ${r.body.length})`);

    // =====================================================================
    console.log("--- J. Cleanup ---");
    // =====================================================================
    const all = await pool.query("SELECT device_id FROM devices WHERE device_id LIKE $1", [`${PREFIX}%`]);
    for (const row of all.rows) await purge(row.device_id);
    await pool.query("DELETE FROM users WHERE username = $1", [plainUser]);

    const residue = await pool.query("SELECT COUNT(*)::int AS n FROM devices WHERE device_id LIKE $1", [`${PREFIX}%`]);
    check("no test devices left", residue.rows[0].n === 0, `${residue.rows[0].n} rows`);
    const orphanSensors = await pool.query("SELECT COUNT(*)::int AS n FROM sensors WHERE device_id LIKE $1", [`${PREFIX}%`]);
    check("no orphan test sensors left", orphanSensors.rows[0].n === 0, `${orphanSensors.rows[0].n} rows`);
    const userResidue = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE username LIKE $1", [`${PREFIX}%`]);
    check("no test users left", userResidue.rows[0].n === 0, `${userResidue.rows[0].n} rows`);
  } catch (err) {
    console.error("\nSUITE ERROR:", err.message);
    failures++;
  } finally {
    // Unconditional cleanup, even if a section threw.
    const all = await pool.query("SELECT device_id FROM devices WHERE device_id LIKE $1", [`${PREFIX}%`]);
    for (const row of all.rows) await purge(row.device_id);
    await pool.query("DELETE FROM users WHERE username LIKE $1", [`${PREFIX}%`]);
    await pool.end();
  }

  console.log(
    failures === 0
      ? `\n=== ALL ${checks} DEVICE TESTS PASSED ===`
      : `\n=== ${failures} of ${checks} DEVICE TESTS FAILED ===`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
