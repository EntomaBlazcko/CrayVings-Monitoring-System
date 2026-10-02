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
    // Not even a prefix: a partial token in a terminal, a CI log or a pasted
    // screenshot is still a credential fragment.
    console.log(`  Token: received (${response.data.token.length} chars, not printed)`);
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
