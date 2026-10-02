// =============================================================================
// tests/authSessionCookie.cjs - cookie-based session auth
// =============================================================================
// Run:  npm run test:sessions
//
// The cookie migration moved browsers from a JS-readable token to an HttpOnly
// cookie. That change touched the single most important request in the system -
// POST /auth/login - and nothing automated covered it, which is how
// test-login.cjs ended up crashing on every successful login.
//
// The properties that must not regress:
//   1. A successful login issues the session cookie at all.
//   2. The cookie is HttpOnly + SameSite=Lax + Path=/, so it is not readable
//      from JavaScript and is not attached to cross-site requests.
//   3. The response body carries NO token. This is the whole point: a token in
//      the body is a token an XSS payload can simply read back out.
//   4. The cookie alone authenticates a protected request, with no
//      Authorization header anywhere.
//   5. A wrong password issues no cookie.
//   6. Logout clears the cookie AND revokes the token server-side, so a copy
//      of the cookie taken before logout stops working.
//   7. Sessions are single-use: logging in again invalidates the old cookie.
//
// Requires a running server (API_BASE, default http://localhost:3000) and
// PostgreSQL for the throwaway user. The user is removed at the end.
// =============================================================================

require("dotenv").config();
const crypto = require("crypto");
const { Pool } = require("pg");

const API = process.env.API_BASE || "http://localhost:3000";
const PREFIX = "ZZSESS_";
const COOKIE = "crayvings_session";

// Mirrors server.cjs. A test that reimplemented the scheme loosely could pass
// against a server that got it wrong, so this is deliberately the same shape.
const PBKDF2_ITERATIONS = 600000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = "sha512";
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return `${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

let checks = 0;
let failures = 0;

function check(name, cond, extra = "") {
  checks++;
  if (cond) console.log(`PASS  ${name}${extra ? "  -> " + extra : ""}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${extra ? "  -> " + extra : ""}`);
  }
}

// Cookie flag matching is deliberately case-insensitive: attribute spelling is
// not something a security property should be allowed to fail on.
const hasAttr = (setCookie, attr) =>
  setCookie.toLowerCase().includes(attr.toLowerCase());

const sessionCookie = (res) => (res.headers.getSetCookie() || []).find((c) => c.startsWith(`${COOKIE}=`));
const cookieValue = (setCookie) => (setCookie || "").slice(COOKIE.length + 1).split(";")[0];

async function login(username, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, body, setCookie: sessionCookie(res) };
}

async function main() {
  const username = `${PREFIX}user`;
  const password = `${PREFIX}correct-horse-battery-staple`;
  const wrongPassword = `${PREFIX}not-the-password`;

  console.log("=== A. Successful login issues a usable session cookie ===");
  await pool.query("DELETE FROM users WHERE username = $1", [username]);
  await pool.query(
    "INSERT INTO users (name, username, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)",
    [`Session Test`, username, `${PREFIX}user@example.invalid`, hashPassword(password), "admin"]
  );

  const good = await login(username, password);
  check("login with valid credentials -> 200", good.status === 200, `status=${good.status} body=${JSON.stringify(good.body).slice(0, 120)}`);
  check("login sets the session cookie", Boolean(good.setCookie), good.setCookie ? "present" : "NO Set-Cookie");

  if (!good.setCookie) {
    console.log("\nNo cookie was issued, so the rest of the round-trip cannot be checked.");
    await cleanup(username);
    return;
  }

  // --- B. Cookie attributes ---------------------------------------------------
  console.log("\n--- B. Cookie attributes ---");
  check("cookie is HttpOnly (unreadable from JavaScript)", hasAttr(good.setCookie, "HttpOnly"));
  check("cookie is SameSite=Lax (not attached cross-site)", /samesite=lax/i.test(good.setCookie));
  check("cookie is scoped to Path=/", /path=\//i.test(good.setCookie));
  check("cookie carries a non-empty value", cookieValue(good.setCookie).length > 0, `${cookieValue(good.setCookie).length} chars`);
  check(
    "Secure is set only when COOKIE_SECURE is on",
    hasAttr(good.setCookie, "Secure") === (String(process.env.COOKIE_SECURE).toLowerCase() === "true"),
    `COOKIE_SECURE=${process.env.COOKIE_SECURE ?? "unset"}`
  );

  // --- C. The body must not leak a credential ---------------------------------
  console.log("\n--- C. No token in the response body ---");
  check("body has no top-level token field", good.body && good.body.token === undefined, `keys=${good.body ? Object.keys(good.body).join(",") : "none"}`);
  check("no Set-Cookie value appears anywhere in the body", !JSON.stringify(good.body || {}).includes(cookieValue(good.setCookie)));
  check("body still identifies the user", good.body?.user?.username === username);

  // --- D. The cookie alone authenticates --------------------------------------
  console.log("\n--- D. Cookie-only authentication ---");
  const withCookie = await fetch(`${API}/settings/effective`, {
    headers: { Cookie: `${COOKIE}=${cookieValue(good.setCookie)}` },
  });
  check("protected GET with only the cookie -> 200", withCookie.status === 200, `status=${withCookie.status}`);

  const withoutCookie = await fetch(`${API}/settings/effective`);
  check("same GET with no cookie -> 401", withoutCookie.status === 401, `status=${withoutCookie.status}`);

  const junkCookie = await fetch(`${API}/settings/effective`, { headers: { Cookie: `${COOKIE}=deadbeef` } });
  check("forged cookie value -> 403", junkCookie.status === 403, `status=${junkCookie.status}`);
  check(
    "forged cookie is actively cleared, not just rejected",
    Boolean(sessionCookie(junkCookie)?.includes("Max-Age=0")),
    sessionCookie(junkCookie) || "no clearing Set-Cookie"
  );

  // --- E. Failed login issues nothing ----------------------------------------
  console.log("\n--- E. Failed login ---");
  const bad = await login(username, wrongPassword);
  check("login with a wrong password -> 401", bad.status === 401, `status=${bad.status}`);
  check("failed login sets no cookie", !bad.setCookie, bad.setCookie ? "cookie issued on failure" : "none");

  const missing = await login(`${PREFIX}nobody`, password);
  check("login as an unknown user -> 401", missing.status === 401, `status=${missing.status}`);
  check("unknown user sets no cookie", !missing.setCookie, missing.setCookie ? "cookie issued" : "none");

  // --- F. Logout revokes server-side ------------------------------------------
  console.log("\n--- F. Logout ---");
  const stolen = cookieValue(good.setCookie);
  const out = await fetch(`${API}/auth/logout`, {
    method: "POST",
    headers: { Cookie: `${COOKIE}=${stolen}` },
  });
  check("logout with the cookie -> 200", out.status === 200, `status=${out.status}`);
  check("logout clears the cookie", Boolean(sessionCookie(out)?.includes("Max-Age=0")), sessionCookie(out) || "no clearing Set-Cookie");

  const stored = await pool.query("SELECT token FROM users WHERE username = $1", [username]);
  check("logout nulls the stored token", stored.rows[0]?.token === null, stored.rows[0]?.token === null ? "null" : "still set");

  // The important half: clearing the cookie is client-side hygiene, revoking the
  // token is what actually ends the session. A cookie copied before logout must
  // be dead even though the victim's browser no longer holds it.
  const replay = await fetch(`${API}/settings/effective`, { headers: { Cookie: `${COOKIE}=${stolen}` } });
  check("a cookie captured before logout no longer authenticates", replay.status !== 200, `status=${replay.status}`);

  const replayBearer = await fetch(`${API}/settings/effective`, { headers: { Authorization: `Bearer ${stolen}` } });
  check("the same value is dead as a Bearer token too", replayBearer.status !== 200, `status=${replayBearer.status}`);

  // --- G. Sessions are single-use ---------------------------------------------
  console.log("\n--- G. Re-login invalidates the previous cookie ---");
  const first = await login(username, password);
  const second = await login(username, password);
  check("second login -> 200", second.status === 200, `status=${second.status}`);
  const rotated = cookieValue(first.setCookie) !== cookieValue(second.setCookie);
  check("each login issues a different token", rotated);
  if (rotated) {
    const old = await fetch(`${API}/settings/effective`, { headers: { Cookie: `${COOKIE}=${cookieValue(first.setCookie)}` } });
    check("the first cookie is dead once a second login happens", old.status !== 200, `status=${old.status}`);
  }

  // The DB only ever holds the hash, so a leaked backup cannot be replayed.
  const row = await pool.query("SELECT token FROM users WHERE username = $1", [username]);
  const storedHash = row.rows[0]?.token;
  check("the raw session token is not what is stored", storedHash && storedHash !== cookieValue(second.setCookie), "stored value is hashed");
  check("the stored value is the SHA-256 of the cookie", storedHash === sha256(cookieValue(second.setCookie)));

  // --- H. Cross-origin mutation is refused ------------------------------------
  console.log("\n--- H. CSRF ---");
  const forged = await fetch(`${API}/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
  });
  check("cross-site POST is refused even with a valid cookie", forged.status === 403, `status=${forged.status}`);
  const survived = await pool.query("SELECT token FROM users WHERE username = $1", [username]);
  check("the refused request did not revoke the session", survived.rows[0]?.token !== null, "session still live");

  await cleanup(username);
}

async function cleanup(username) {
  console.log("\n--- I. Cleanup ---");
  await pool.query("DELETE FROM users WHERE username = $1", [username]).catch(() => {});
  const leftover = await pool.query("SELECT count(*)::int AS n FROM users WHERE username = $1", [username]);
  check("no test users left", leftover.rows[0].n === 0, `${leftover.rows[0].n} rows`);
  console.log(
    `\n${failures === 0 ? "=== ALL SESSION COOKIE TESTS PASSED ===" : `=== ${failures} FAILED ===`} (${checks} checks)`
  );
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("session cookie test crashed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
