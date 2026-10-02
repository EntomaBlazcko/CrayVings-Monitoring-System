const axios = require("axios");
require("dotenv").config();

const API_BASE = process.env.API_BASE || "http://localhost:3000";

// Credentials come from the environment only. This used to fall back to a
// hardcoded admin/Admin@123 pair, which is precisely the account shape the rest
// of the project refuses to ship: seed:admin has no default password and the
// first boot refuses to create an owner without ADMIN_INITIAL_PASSWORD. A
// committed fallback reintroduces the one account that should never exist, so a
// missing variable now fails loudly instead.
const USERNAME = process.env.TEST_USERNAME;
const PASSWORD = process.env.TEST_PASSWORD;

async function testLogin() {
  if (!USERNAME || !PASSWORD) {
    console.error("TEST_USERNAME and TEST_PASSWORD must be set (see .env.example).");
    console.error("Refusing to run with a hardcoded fallback credential.");
    process.exit(1);
  }

  console.log("Testing login endpoint...");
  console.log(`API: ${API_BASE}/auth/login`);
  console.log(`Username: ${USERNAME}\n`);

  try {
    const response = await axios.post(`${API_BASE}/auth/login`, {
      username: USERNAME,
      password: PASSWORD,
    });

    console.log("✅ Login successful!\n");
    console.log("Response:");
    console.log(`  Message: ${response.data.message}`);

    // The session is an HttpOnly cookie, so this asserts on how it was set
    // rather than printing any part of it - a cookie fragment in a terminal, a
    // CI log or a pasted screenshot is still a live credential.
    const cookies = response.headers["set-cookie"] || [];
    const session = cookies.find((c) => c.startsWith("crayvings_session="));
    if (session) {
      const value = session.slice("crayvings_session=".length).split(";")[0];
      const flags = session.split(";").slice(1).map((s) => s.trim());
      console.log(`  Session cookie: set (${value.length} chars, not printed)`);
      console.log(`  Cookie flags: ${flags.join("; ")}`);
    } else {
      console.log("  Session cookie: MISSING - the browser would not be logged in");
    }
    // The point of the cookie: nothing in the body for JavaScript to read or
    // store. If a token reappears here, the XSS-exposure fix has regressed.
    console.log(`  Body carries a token: ${"token" in response.data ? "YES (regression!)" : "no"}`);

    console.log(`  User: ${response.data.user.name} (${response.data.user.role})`);
    console.log(`  Username: ${response.data.user.username}`);
    console.log(`  Email: ${response.data.user.email}`);
  } catch (err) {
    console.log("❌ Login failed!\n");
    if (err.response) {
      console.log(`Status: ${err.response.status}`);
      console.log(`Error: ${JSON.stringify(err.response.data)}`);
    } else if (err.code === "ECONNREFUSED") {
      console.log("Error: Cannot connect to server. Make sure server is running on port 3000.");
    } else {
      console.log(`Error: ${err.message}`);
    }
  }
}

testLogin();
