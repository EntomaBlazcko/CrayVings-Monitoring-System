// Backend end-to-end regression suite. Requires the API server to be running
// (npm run server) and drives it through the real auth + ingestion paths:
// per-tank scoping, threshold overrides, and fleet alert attribution.
//
// Session handling: session tokens are stored as sha256 hashes (migration 013),
// so by default this mints a session the same way login does. Set
// TOKENS_HASHED=0 only to test a pre-hash database.
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

const TOKENS_HASHED = process.env.TOKENS_HASHED !== "0";
let TOKEN;
let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`PASS  ${name}${extra ? "  -> " + extra : ""}`);
  else { failures++; console.log(`FAIL  ${name}${extra ? "  -> " + extra : ""}`); }
}
async function api(method, url, data, headers = {}) {
  try {
    const res = await axios({
      method, url: API + url, data,
      headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
      validateStatus: () => true,
    });
    return { status: res.status, body: res.data };
  } catch (err) {
    return { status: err.response?.status ?? -1, body: err.response?.data ?? { message: err.message } };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Mint a session for any active admin (pre-hash era reads the plaintext token
  // from the DB; post-hash era stores sha256(raw) exactly as login does).
  const account = await pool.query(
    "SELECT username, token FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1"
  );
  if (account.rows.length === 0) {
    console.error("No active admin account found - cannot run the regression suite.");
    await pool.end();
    process.exit(2);
  }
  const username = account.rows[0].username;
  console.log(`Running as admin account: ${username}`);

  // Sections A and B assert against a seeded tank, so fail loudly with a clear
  // reason rather than a confusing cascade of scoping failures.
  const seedTank = await pool.query(
    "SELECT COUNT(*)::int AS n FROM sensors WHERE device_id = 'ESP32_01'"
  );
  if (seedTank.rows[0].n === 0) {
    console.error("No sensor history for ESP32_01 - the per-tank scoping checks need it. Skipping.");
    await pool.end();
    process.exit(2);
  }

  if (TOKENS_HASHED) {
    TOKEN = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(TOKEN, "utf8").digest("hex");
    await pool.query(
      "UPDATE users SET token = $1, token_expires_at = NOW() + interval '2 hours' WHERE username = $2",
      [hash, username]
    );
  } else {
    TOKEN = account.rows[0].token;
  }

  console.log("--- A. Per-tank scoping: sensors / logs / reports / analytics ---");
  let r = await api("get", "/sensor/latest?device_id=ESP32_01");
  check("GET /sensor/latest?device_id=ESP32_01", r.status === 200 && r.body.data?.device_id === "ESP32_01", `temp=${r.body.data?.temperature}`);
  r = await api("get", "/sensor?limit=50&device_id=ESP32_01");
  check("GET /sensor?device_id=ESP32_01 scoped", r.status === 200 && r.body.every((row) => row.device_id === "ESP32_01"), `${r.body.length} rows`);
  r = await api("get", "/system-logs?limit=100&device_id=ESP32_01");
  check("GET /system-logs?device_id=ESP32_01", r.status === 200 && r.body.data.every((row) => row.device_id === "ESP32_01"), `${r.body.total} rows`);
  const wS = await api("get", "/report/weekly?device_id=ESP32_01");
  const wA = await api("get", "/report/weekly");
  check("GET /report/weekly?device_id scoped", wS.status === 200 && wS.body.summary.total_readings <= wA.body.summary.total_readings, `${wS.body.summary.total_readings} vs ${wA.body.summary.total_readings}`);
  const rS = await api("get", "/report/range?hours=24&device_id=ESP32_01");
  check("GET /report/range?device_id scoped", rS.status === 200);
  const dS = await api("get", "/analytics/daily?days=7&device_id=ESP32_01");
  const dA = await api("get", "/analytics/daily?days=7");
  const sumRead = (d) => d.body.daily.reduce((a, b) => a + b.readings, 0);
  check("GET /analytics/daily?device_id scoped", dS.status === 200 && sumRead(dS) <= sumRead(dA), `${sumRead(dS)} vs ${sumRead(dA)}`);
  const ins = await api("get", "/analytics/insights?days=7&device_id=ESP32_01");
  check("GET /analytics/insights?device_id", ins.status === 200 && Array.isArray(ins.body.insights), `${ins.body.insights.length} insights`);
  const ovS = await api("get", "/analytics/overview?days=7&device_id=ESP32_01");
  const ovA = await api("get", "/analytics/overview?days=7");
  check("GET /analytics/overview fully scoped", ovS.status === 200 && ovS.body.alerts.total <= ovA.body.alerts.total, `alerts ${ovS.body.alerts.total} vs ${ovA.body.alerts.total}`);

  console.log("--- B. Threshold overrides ---");
  r = await api("get", "/settings/effective");
  const effectiveBefore = JSON.stringify(r.body.devices);
  check("GET /settings/effective baseline", r.status === 200 && typeof r.body.global.temp_min === "number", `devices map: ${Object.keys(r.body.devices).length}`);
  r = await api("put", "/settings/device/ESP32_01", { temp_min: 22, temp_max: 29 });
  check("PUT override {temp 22-29}", r.status === 200 && Number(r.body.override.temp_min) === 22);
  r = await api("get", "/settings/effective");
  check("  effective map updated", r.body.devices.ESP32_01 && r.body.devices.ESP32_01.temp_min === 22);
  r = await api("put", "/settings/device/ESP32_01", { temp_min: 40 });
  check("PUT invalid effective pair -> 400", r.status === 400);
  r = await api("delete", "/settings/device/ESP32_01");
  check("DELETE override -> back to global", r.status === 200);
  r = await api("get", "/settings/effective");
  check("  effective map back to baseline", JSON.stringify(r.body.devices) === effectiveBefore);

  console.log("--- C. Fleet pipeline: attribution + per-tank mute ---");
  const SECRET = process.env.DEVICE_SECRET;
  const post = (body) => api("post", "/sensor", body, { "x-device-secret": SECRET });
  r = await post({ device_id: "TEST_TANK", temperature: 26, water_level: 51, ammonia: 0.6 });
  check("POST /sensor TEST_TANK auto-register", r.status === 201 || r.status === 200, `status=${r.status}`);
  r = await api("post", "/alert/mute", { hours: 2, device_id: "TEST_TANK" });
  check("Per-tank mute set", r.status === 200 && r.body.muted === true);
  const persisted = await pool.query("SELECT value FROM system_state WHERE key = 'sms_mute:TEST_TANK'");
  check("  mute persisted in system_state", persisted.rows.length === 1 && Boolean(persisted.rows[0].value));
  r = await api("post", "/alert/status?device_id=TEST_TANK");
  check("  /alert/status on muted tank -> 429 (no SMS)", r.status === 429);
  r = await api("put", "/settings/device/TEST_TANK", { temp_min: 10, temp_max: 15 });
  check("Override drives alerting", r.status === 200);
  await post({ device_id: "TEST_TANK", temperature: 25, water_level: 50, ammonia: 0.5 });
  await sleep(800);
  const alertRow = await pool.query("SELECT * FROM system_logs WHERE device_id='TEST_TANK' AND action='Alert' ORDER BY id DESC LIMIT 1");
  check("Alert row attributed to TEST_TANK", alertRow.rows.length === 1 && alertRow.rows[0].device_id === "TEST_TANK");
  const smsRows = await pool.query("SELECT COUNT(*)::int AS n FROM sms_logs WHERE sent_at >= NOW() - INTERVAL '2 minutes' AND message LIKE '%TEST_TANK%'");
  check("NO SMS for muted tank", smsRows.rows[0].n === 0);
  await api("delete", "/settings/device/TEST_TANK");
  await post({ device_id: "TEST_TANK", temperature: 25, water_level: 50, ammonia: 0.5 });
  await sleep(800);
  const resolvedRow = await pool.query("SELECT * FROM system_logs WHERE device_id='TEST_TANK' AND action='Alert Resolved' ORDER BY id DESC LIMIT 1");
  check("Alert Resolved row attributed", resolvedRow.rows.length === 1 && resolvedRow.rows[0].device_id === "TEST_TANK");
  r = await api("post", "/alert/mute", { hours: 0, device_id: "TEST_TANK" });
  check("Per-tank unmute", r.status === 200 && r.body.muted === false);
  r = await api("get", "/alert/mute-status");
  check("Mute-status per-tank array", r.status === 200 && Array.isArray(r.body.devices), `${r.body.devices.length} tanks`);

  console.log("--- D. Cleanup ---");
  await pool.query("DELETE FROM sensors WHERE device_id='TEST_TANK'");
  await pool.query("DELETE FROM last_alerts WHERE device_id='TEST_TANK'");
  await pool.query("DELETE FROM device_threshold_overrides WHERE device_id='TEST_TANK'");
  await pool.query("DELETE FROM system_logs WHERE device_id='TEST_TANK'");
  await pool.query("DELETE FROM system_logs WHERE device_id IN ('ESP32_01') AND action IN ('Change','Spike')");
  await pool.query("DELETE FROM system_state WHERE key='sms_mute:TEST_TANK'");
  await pool.query("DELETE FROM devices WHERE device_id='TEST_TANK'");
  const residue = await pool.query("SELECT (SELECT COUNT(*)::int FROM system_logs WHERE device_id='TEST_TANK') AS logs, (SELECT COUNT(*)::int FROM devices WHERE device_id='TEST_TANK') AS dev, (SELECT COUNT(*)::int FROM device_threshold_overrides) AS ov");
  check("No residue", residue.rows[0].logs === 0 && residue.rows[0].dev === 0 && residue.rows[0].ov === 0);

  console.log(failures === 0 ? "\n=== ALL REGRESSION TESTS PASSED ===" : `\n=== ${failures} TEST(S) FAILED ===`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error("SCRIPT ERROR:", err.message); process.exit(2); });
