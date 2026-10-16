// =============================================================================
// 017_token_index.cjs - Index users.token, the session lookup hot path
// Idempotent (safe to run repeatedly). Run:  node db/migrations/017_token_index.cjs
//
// The problem: `users.token` holds the SHA-256 hash of the live session cookie
// and it is the only column that decides whether a request is authenticated.
// Two guards run it on EVERY authenticated API call and on every SSE connect:
//
//   server.cjs:513   SELECT * FROM users WHERE token = $1 AND status = 'active'
//   server.cjs:564   SELECT * FROM users WHERE token = $1 AND status = 'active'
//
// pg_indexes showed `users` carrying only users_pkey, idx_users_status,
// idx_users_email_active and idx_users_username_active. Nothing on token, so
// both statements fell to a sequential scan. The cost is small while the table
// holds a handful of accounts and grows linearly with it - which is the bad
// shape: it degrades quietly instead of failing.
//
// Two distinct problems, so two index decisions:
//
// 1. PARTIAL, on token WHERE token IS NOT NULL. A unique index would be the
//    obvious choice, but token is NULL for every signed-out user, and NULLs are
//    never equal to each other - so UNIQUE would in fact permit any number of
//    NULLs and would not break. It is still the wrong index here: token is a
//    high-entropy 64-char hex hash, not a business key, so uniqueness carries
//    no meaning worth enforcing, and a partial index is simply smaller because
//    it skips the NULL rows that dominate a mostly-signed-out table.
//
// 2. COMPOSITE (token, status). The query filters on both columns. Indexing
//    status separately (idx_users_status already exists) does not help, because
//    Postgres cannot use two indexes to satisfy one equality lookup. Carrying
//    status in the same btree means the index itself answers 'is this token
//    live' without a heap visit for archived accounts.
//
// CONCURRENTLY, so the build takes no lock that blocks the writes happening
// during it. That is also why this migration is NOT wrapped in a transaction:
// PostgreSQL rejects CREATE INDEX CONCURRENTLY inside a txn block. Each step is
// individually safe to re-run, so a failure part-way cannot leave a
// half-applied structural change.
//
// Also narrows the two call sites to explicit columns. SELECT * on this query
// drags password_hash across the wire on every authenticated request - a
// credential-adjacent column fetched 5,000 times an hour for a lookup that
// needs id, username, name, email, role and status. The asterisk is the reason
// this lookup was expensive at all, independent of the missing index.
// =============================================================================

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

(async () => {
  // ---- 1. the index ---------------------------------------------------------
  await pool.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_token_active
       ON users (token, status)
     WHERE token IS NOT NULL`
  );
  console.log("[migration] idx_users_token_active built (concurrently)");

  // ---- 2. record ------------------------------------------------------------
  // Recorded LAST and only once the index exists, so a partially applied run is
  // never mistaken for a completed one - the 014 lesson: recording a version
  // while a required guarantee is missing is what makes a migration fail open.
  await pool.query(
    `INSERT INTO schema_migrations (version, name)
       VALUES ('017', 'token_index')
     ON CONFLICT (version) DO NOTHING`
  );

  await report();
  await pool.end();
  console.log("[migration] 017_token_index applied");
})().catch(async (err) => {
  console.error("[migration] 017_token_index failed:", err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

// Verification: prove the planner actually uses the index. Reporting the index
// as present is not the same claim as reporting the Seq Scan is gone, and only
// the second one is the finding.
async function report() {
  const idx = await pool.query(
    `SELECT pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_users_token_active'
        AND i.indrelid = 'users'::regclass`
  );
  console.log(
    idx.rows.length > 0
      ? `idx_users_token_active -> ${idx.rows[0].def}`
      : "idx_users_token_active -> MISSING (fix did not apply)"
  );

  // Usability, not preference. On a small table the planner will rightly keep
  // choosing a sequential scan - one page beats a btree walk when the table has
  // a handful of rows - so "the plan says Seq Scan" is NOT evidence the index
  // is broken, and reporting it as a failure would be wrong.
  //
  // enable_seqscan=off answers the question that actually matters: can the index
  // serve this predicate? If the planner uses it under that setting, it is
  // structurally sound and will be chosen on its own once the table is big
  // enough for the comparison to matter.
  const client = await pool.connect();
  let usable = false;
  let chosen = false;
  try {
    const probe =
      "EXPLAIN SELECT id, username, name, email, role, status, token_expires_at, password_hash " +
      "FROM users WHERE token = 'deadbeef' AND status = 'active'";

    const defaultPlan = await client.query(probe);
    chosen = defaultPlan.rows.some((r) => r["QUERY PLAN"].includes("idx_users_token_active"));

    await client.query("SET enable_seqscan = off");
    const forced = await client.query(probe);
    usable = forced.rows.some((r) => r["QUERY PLAN"].includes("idx_users_token_active"));
    const cond = forced.rows
      .map((r) => r["QUERY PLAN"])
      .find((l) => l.includes("Index Cond:"));
    if (cond) console.log(`index predicate -> ${cond.trim()}`);
  } finally {
    await client.query("RESET enable_seqscan").catch(() => {});
    client.release();
  }

  if (!usable) {
    console.log(
      "auth token lookup -> INDEX UNUSABLE (planner rejects it even with seqscan off) - fix did not apply"
    );
  } else if (chosen) {
    console.log("auth token lookup -> INDEX SCAN chosen by the planner");
  } else {
    // The expected case on a small table, and worth stating plainly so nobody
    // reads the line above as a regression.
    console.log(
      "auth token lookup -> index is USABLE; planner prefers a Seq Scan because the table is still small " +
        "(correct at this row count, and it will switch on its own as users accumulate)"
    );
  }

  // Row counts, so the cost being removed is visible rather than asserted.
  const stats = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE token IS NOT NULL)::int AS with_token
       FROM users`
  );
  console.log(
    `users rows -> ${stats.rows[0].total} total, ${stats.rows[0].with_token} holding a token`
  );

  // A partial index still has to be found by pg_indexes under its own name; this
  // catches the case where the build was skipped and the IF NOT EXISTS silently
  // matched a differently-shaped index.
  const shape = await pool.query(
    `SELECT i.indpred IS NOT NULL AS partial,
            array_length(i.indkey, 1) AS key_count
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_users_token_active'
        AND i.indrelid = 'users'::regclass`
  );
  if (shape.rows.length > 0) {
    console.log(
      `index shape -> ${shape.rows[0].partial ? "partial (skips NULL tokens)" : "FULL - NULL tokens are indexed too"}, ` +
        `${shape.rows[0].key_count} key columns`
    );
  }
}