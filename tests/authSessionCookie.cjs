// =============================================================================
// tests/authSessionCookie.cjs - cookie-based session auth
// =============================================================================
// Run:  npm run test:sessions
//
// Deliberately NOT part of test:all. It is the only suite that calls
// /auth/login, so a burst of genuinely failed logins in the browser can make the
// server refuse it, and test:all has to stay re-runnable at will regardless of
// what you were doing in the UI a minute ago. Correct logins are NOT counted
// against the brute-force budget, so the suite itself no longer trips the limit
// and can be run back to back.
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
//   8. Password changes are enforced server-side: policy, current-password
//      proof, 404 on an unknown target, session revocation, and an audit row.
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
// Set when the run stops early on a 429. A truncated run must never report
// success: skipping the cookie checks because the login budget was spent is the
// one outcome this suite must not dress up as a pass.
let truncated = false;

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

// Same PBKDF2 shape as hashPassword, used only to confirm a stored hash really
// matches a plaintext the test chose.
function verifyAgainst(stored, candidate) {
  if (typeof stored !== "string" || typeof candidate !== "string") return false;
  const parts = stored.split(":");
  const iterations = parts.length === 3 ? parseInt(parts[0], 10) : 10000;
  const salt = parts.length === 3 ? parts[1] : parts[0];
  const expected = parts.length === 3 ? parts[2] : parts[1];
  const actual = crypto.pbkdf2Sync(candidate, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return expected === actual;
}

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
  // draft-7 headers are enabled on the server, so the budget is visible. Used
  // only to explain a 429 - never to work around one.
  const remaining = res.headers.get("ratelimit-remaining");
  const reset = res.headers.get("ratelimit-reset");
  return {
    status: res.status,
    body,
    setCookie: sessionCookie(res),
    remaining: remaining === null ? null : Number(remaining),
    retryAfterSec: reset === null ? null : Math.max(0, Number(reset)),
  };
}

// /auth/login is brute-force limited (5 per 15 min per IP). Hitting that is
// correct server behaviour, not a broken cookie, and the difference matters:
// reported as a cookie failure it looks like a regression in the session code
// and sends you hunting in the wrong file. Bail out loudly instead.
async function refuseIfRateLimited(result) {
  if (result.status !== 429) return false;
  truncated = true;
  const mins = result.retryAfterSec === null ? 15 : Math.ceil(result.retryAfterSec / 60);
  console.error(
    `\n/auth/login returned 429: the server's brute-force guard allows a few\n` +
    `attempts per 15 minutes per IP, and this suite needs 4 of them. That is a\n` +
    `rate limit, not a cookie failure. Wait ~${mins} min (or restart the server)\n` +
    `and re-run. Not failing the session checks against an exhausted budget.`
  );
  return true;
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
  if (await refuseIfRateLimited(good)) {
    await cleanup(username);
    return;
  }
  check("login with valid credentials -> 200", good.status === 200, `status=${good.status} body=${JSON.stringify(good.body).slice(0, 120)}`);
  check("login sets the session cookie", Boolean(good.setCookie), good.setCookie ? "present" : "NO Set-Cookie");
  if (good.remaining !== null) {
    console.log(`      (login budget: ${good.remaining} attempt(s) left in the current window)`);
  }

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
  if (await refuseIfRateLimited(bad)) {
    await cleanup(username);
    return;
  }
  check("login with a wrong password -> 401", bad.status === 401, `status=${bad.status}`);
  check("failed login sets no cookie", !bad.setCookie, bad.setCookie ? "cookie issued on failure" : "none");

  // An unknown username is the same 401 branch as a wrong password (both fail
  // before any session is created), so it is not worth a second rate-limited
  // attempt to prove again.

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
  if (await refuseIfRateLimited(first)) {
    await cleanup(username);
    return;
  }
  const second = await login(username, password);
  if (await refuseIfRateLimited(second)) {
    await cleanup(username);
    return;
  }
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

  // --- I. Cookie sessions are attributed to the right person -------------------
  // POST /activity-logs used to re-read the Authorization header to work out who
  // was acting, falling back to the "admin" account. A browser session carries no
  // such header, so every logged action from the dashboard was filed under
  // admin - the audit trail attributed the whole farm to one account.
  //
  // The token is minted into the DB directly rather than via /auth/login, so
  // this costs none of the rate-limited login budget.
  console.log("\n--- I. Cookie sessions are attributed to the right person ---");
  const actorName = `${PREFIX}actor`;
  const PROBE = `${PREFIX}attribution probe`;
  const actorToken = crypto.randomBytes(32).toString("hex");
  await pool.query("DELETE FROM users WHERE username = $1", [actorName]);
  await pool.query(
    "INSERT INTO users (name, username, email, password_hash, role, token, token_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    ["Cookie Actor", actorName, `${PREFIX}actor@example.invalid`, hashPassword(password), "user", sha256(actorToken), new Date(Date.now() + 3600000)]
  );

  const logged = await fetch(`${API}/activity-logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${COOKIE}=${actorToken}` },
    body: JSON.stringify({ action_type: "navigation", description: PROBE, module: "test" }),
  });
  check("cookie-authenticated POST /activity-logs -> 201", logged.status === 201, `status=${logged.status}`);

  const who = await pool.query(
    "SELECT user_name FROM activity_logs WHERE description = $1 ORDER BY id DESC LIMIT 1",
    [PROBE]
  );
  const userName = who.rows[0]?.user_name;
  check(
    "the activity log names the cookie's owner, not admin",
    userName === actorName,
    `recorded as "${userName}", expected "${actorName}"`
  );
  await pool.query("DELETE FROM activity_logs WHERE description = $1", [PROBE]).catch(() => {});
  await pool.query("DELETE FROM users WHERE username = $1", [actorName]).catch(() => {});

  // --- J. A dead session is cleared, on admin routes too ----------------------
  // requireAuth and requireAdmin are sibling guards and must behave alike: a
  // cookie that matches no session gets actively cleared. HttpOnly means the
  // browser cannot do this itself, so if the server does not, a revoked session
  // is replayed on every admin request forever.
  console.log("\n--- J. A dead cookie is cleared from admin routes too ---");
  // GET /auth/users, not GET /devices: reads are requireAuth so users can see
  // tanks, and only mutations are admin-gated. Using /devices here would have
  // exercised requireAuth twice and quietly proved nothing about requireAdmin.
  const deadAdmin = await fetch(`${API}/auth/users`, { headers: { Cookie: `${COOKIE}=deadbeefdeadbeef` } });
  check("admin route with an unknown cookie -> 403", deadAdmin.status === 403, `status=${deadAdmin.status}`);
  const adminClear = deadAdmin.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`) && c.includes("Max-Age=0"));
  check("the admin route clears the dead cookie", Boolean(adminClear), adminClear || "no clearing Set-Cookie");

  // A forged cookie on a non-admin route already did this; assert both guards
  // agree so they cannot drift apart again.
  const deadUser = await fetch(`${API}/settings/effective`, { headers: { Cookie: `${COOKIE}=deadbeefdeadbeef` } });
  const userClear = deadUser.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`) && c.includes("Max-Age=0"));
  check("both guards clear a dead cookie", Boolean(userClear) && Boolean(adminClear));

  // A VALID session belonging to a non-admin must survive: they are simply not
  // an admin, and clearing the cookie would log a legitimate user out.
  const plainUserName = `${PREFIX}plain`;
  const plainToken = crypto.randomBytes(32).toString("hex");
  await pool.query("DELETE FROM users WHERE username = $1", [plainUserName]);
  await pool.query(
    "INSERT INTO users (name, username, email, password_hash, role, token, token_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    ["Plain User", plainUserName, `${PREFIX}plain@example.invalid`, hashPassword(password), "user", sha256(plainToken), new Date(Date.now() + 3600000)]
  );
  const asPlain = await fetch(`${API}/auth/users`, { headers: { Cookie: `${COOKIE}=${plainToken}` } });
  check("a valid non-admin hitting an admin route -> 403", asPlain.status === 403, `status=${asPlain.status}`);
  const notCleared = asPlain.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`) && c.includes("Max-Age=0"));
  check("that non-admin keeps their session", !notCleared, notCleared ? "cookie was wrongly cleared" : "cookie left intact");
  await pool.query("DELETE FROM users WHERE username = $1", [plainUserName]).catch(() => {});

  // --- K. Correct logins are not throttled ------------------------------------
  // The brute-force guard used to count successful attempts too, so six correct
  // logins in a row locked you out of a dashboard you had the right credentials
  // for. A brute-force attack is made of wrong guesses, so successes add
  // nothing an attacker could use and should cost nothing.
  //
  // Before the fix the sixth of these returned 429. It does not burn the failure
  // budget either, which is why this suite is now safe to run repeatedly.
  console.log("\n--- K. Correct logins are not throttled ---");
  let allSucceeded = true;
  let sawThrottle = null;
  for (let i = 1; i <= 6; i++) {
    const attempt = await login(username, password);
    if (attempt.status === 429) { allSucceeded = false; sawThrottle = i; break; }
    if (attempt.status !== 200) { allSucceeded = false; sawThrottle = `status ${attempt.status} on attempt ${i}`; break; }
  }
  check(
    "6 consecutive correct logins are all accepted",
    allSucceeded,
    sawThrottle ? `blocked at attempt ${sawThrottle}` : "all 6 returned 200"
  );

  // --- L. Password changes ----------------------------------------------------
  // An owner lockout left one gap and five
  // defects in the password write path, and none of it was covered:
  //   1. No self-service change at all - nobody could rotate their own password.
  //   2. The strength rules existed only in the browser, so `{"newPassword":"a"}`
  //      was accepted and stored.
  //   3. An unknown id reported "Password updated" and changed nothing.
  //   4. A password change left the session alive, so a stolen cookie outlived
  //      the rotation meant to lock the thief out.
  //   5. Nothing was written to activity_logs.
  // A live session is minted straight into the DB for these, so they cost none
  // of the rate-limited login budget.
  console.log("\n--- L. Password changes ---");

  const newPassword = `${PREFIX}rotated-Passw0rd`;
  const sessionToken = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "UPDATE users SET token = $1, token_expires_at = $2 WHERE username = $3",
    [sha256(sessionToken), new Date(Date.now() + 3600000), username]
  );
  const ownCookie = { Cookie: `${COOKIE}=${sessionToken}` };

  const changeOwn = (body, headers = ownCookie) =>
    fetch(`${API}/auth/me/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const unauth = await changeOwn({ currentPassword: password, newPassword }, {});
  check("PUT /auth/me/password with no session -> 401", unauth.status === 401, `status=${unauth.status}`);

  const weak = await changeOwn({ currentPassword: password, newPassword: "a" });
  check(
    "a weak new password is rejected by the SERVER -> 400",
    weak.status === 400,
    `status=${weak.status} ${JSON.stringify(weak.body || {}).slice(0, 120)}`
  );
  const stillOld = await pool.query("SELECT password_hash FROM users WHERE username = $1", [username]);
  check(
    "the rejected attempt did not change the stored hash",
    verifyAgainst(stillOld.rows[0]?.password_hash, password),
    "the original password still verifies"
  );

  const wrongCurrent = await changeOwn({ currentPassword: `${PREFIX}wrong-current`, newPassword });
  check("wrong current password -> 403", wrongCurrent.status === 403, `status=${wrongCurrent.status}`);

  const noCurrent = await changeOwn({ newPassword });
  check("missing current password -> 400", noCurrent.status === 400, `status=${noCurrent.status}`);

  const sameAsCurrent = await changeOwn({ currentPassword: password, newPassword: password });
  check("reusing the current password -> 400", sameAsCurrent.status === 400, `status=${sameAsCurrent.status}`);

  const changed = await changeOwn({ currentPassword: password, newPassword });
  check("valid change -> 200", changed.status === 200, `status=${changed.status} ${JSON.stringify(changed.body || {}).slice(0, 120)}`);

  // The replacement cookie: the caller stays signed in, and because the token
  // column holds a single value, writing it kills every session that came before.
  const rotatedCookie = sessionCookie(changed);
  check("a replacement session cookie is issued", Boolean(rotatedCookie), rotatedCookie || "no Set-Cookie");
  const stillWorks = await fetch(`${API}/settings/effective`, { headers: { Cookie: `${COOKIE}=${cookieValue(rotatedCookie)}` } });
  check("the new cookie authenticates", stillWorks.status === 200, `status=${stillWorks.status}`);
  const oldDead = await fetch(`${API}/settings/effective`, { headers: ownCookie });
  check("the pre-change cookie no longer authenticates", oldDead.status !== 200, `status=${oldDead.status}`);

  const audit = await pool.query(
    "SELECT user_name, action_type FROM activity_logs WHERE user_name = $1 AND action_type = 'PASSWORD_CHANGED' ORDER BY id DESC LIMIT 1",
    [username]
  );
  check(
    "the change is written to activity_logs",
    audit.rows[0]?.action_type === "PASSWORD_CHANGED" && audit.rows[0]?.user_name === username,
    `${audit.rows[0]?.action_type} by ${audit.rows[0]?.user_name}`
  );

  const oldPassword = await login(username, password);
  // The newest live cookie for this account. Logging in again rotates the token,
  // so this must be re-read after every login or the admin calls below are made
  // with a cookie the server has already retired (they answer 403).
  let liveCookie = cookieValue(rotatedCookie);
  if (!await refuseIfRateLimited(oldPassword)) {
    check("the OLD password no longer logs in -> 401", oldPassword.status === 401, `status=${oldPassword.status}`);
    const newCreds = await login(username, newPassword);
    if (!await refuseIfRateLimited(newCreds)) {
      check("the NEW password logs in -> 200", newCreds.status === 200, `status=${newCreds.status}`);
      if (newCreds.setCookie) liveCookie = cookieValue(newCreds.setCookie);
    }
  }

  // --- M. Admin reset of ANOTHER account ---------------------------------------
  console.log("\n--- M. Admin password reset ---");
  const targetName = `${PREFIX}target`;
  const targetPassword = `${PREFIX}target-original-1`;
  const targetToken = crypto.randomBytes(32).toString("hex");
  await pool.query("DELETE FROM users WHERE username = $1", [targetName]);
  await pool.query(
    "INSERT INTO users (name, username, email, password_hash, role, token, token_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    ["Reset Target", targetName, `${PREFIX}target@example.invalid`, hashPassword(targetPassword), "user", sha256(targetToken), new Date(Date.now() + 3600000)]
  );
  const targetRow = await pool.query("SELECT id FROM users WHERE username = $1", [targetName]);
  const targetId = targetRow.rows[0].id;

  const adminCookie = { Cookie: `${COOKIE}=${liveCookie}` };
  const resetAs = (id, body) =>
    fetch(`${API}/auth/users/${id}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...adminCookie },
      body: JSON.stringify(body),
    });

  check(
    "resetting an unknown id -> 404 instead of a silent success",
    (await resetAs(987654, { newPassword })).status === 404
  );

  const resetWeak = await resetAs(targetId, { newPassword: "a" });
  check("admin reset honours the same strength policy -> 400", resetWeak.status === 400, `status=${resetWeak.status}`);

  const selfNoProof = await resetAs(
    (await pool.query("SELECT id FROM users WHERE username = $1", [username])).rows[0].id,
    { newPassword: `${PREFIX}another-Passw0rd` }
  );
  check(
    "an admin resetting their OWN password must prove the current one -> 400",
    selfNoProof.status === 400,
    `status=${selfNoProof.status}`
  );

  const targetResetPassword = `${PREFIX}target-rotated-2`;
  const reset = await resetAs(targetId, { newPassword: targetResetPassword });
  check("admin reset of another account -> 200", reset.status === 200, `status=${reset.status}`);

  const afterReset = await pool.query("SELECT token, password_hash FROM users WHERE username = $1", [targetName]);
  check("the reset target's session is revoked", afterReset.rows[0]?.token === null, afterReset.rows[0]?.token === null ? "null" : "still set");
  const targetCookieDead = await fetch(`${API}/settings/effective`, { headers: { Cookie: `${COOKIE}=${targetToken}` } });
  check("the target's captured cookie no longer authenticates", targetCookieDead.status !== 200, `status=${targetCookieDead.status}`);
  check("the new password verifies against the stored hash", verifyAgainst(afterReset.rows[0]?.password_hash, targetResetPassword));

  const resetAudit = await pool.query(
    "SELECT user_name, action_type FROM activity_logs WHERE description LIKE $1 ORDER BY id DESC LIMIT 1",
    [`Reset password for user account "${targetName}"%`]
  );
  check(
    "the admin reset is audited against the acting admin",
    resetAudit.rows[0]?.action_type === "PASSWORD_RESET" && resetAudit.rows[0]?.user_name === username,
    `${resetAudit.rows[0]?.action_type} by ${resetAudit.rows[0]?.user_name}`
  );

  await cleanup(username);
}

async function cleanup(username) {
  console.log("\n--- N. Cleanup ---");
  await pool.query("DELETE FROM users WHERE username LIKE $1", [`${PREFIX}%`]).catch(() => {});
  await pool.query("DELETE FROM activity_logs WHERE description LIKE $1", [`${PREFIX}%`]).catch(() => {});
  // The password-change audit rows do not start with the prefix (they read like
  // real entries), so they are matched on the throwaway username instead -
  // scoped tightly enough that a genuine PASSWORD_CHANGED row on a real account
  // is never touched.
  await pool.query(
    "DELETE FROM activity_logs WHERE action_type IN ('PASSWORD_CHANGED', 'PASSWORD_RESET') AND (user_name LIKE $1 OR description LIKE $2)",
    [`${PREFIX}%`, `%${PREFIX}%`]
  ).catch(() => {});
  const leftover = await pool.query("SELECT count(*)::int AS n FROM users WHERE username LIKE $1", [`${PREFIX}%`]);
  check("no test users left", leftover.rows[0].n === 0, `${leftover.rows[0].n} rows`);
  const leftoverLogs = await pool.query(
    "SELECT count(*)::int AS n FROM activity_logs WHERE user_name LIKE $1",
    [`${PREFIX}%`]
  );
  check("no test activity rows left", leftoverLogs.rows[0].n === 0, `${leftoverLogs.rows[0].n} rows`);
  if (truncated) {
    console.log(
      `\n=== SESSION COOKIE TESTS INCOMPLETE === (${checks} checks ran; stopped early on the login rate limit)`
    );
    await pool.end();
    process.exit(1);
  }
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
