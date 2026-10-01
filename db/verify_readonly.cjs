require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

// Read-only. Full index + check-constraint dump so the DBML block in
// DATABASE_SCHEMA.md lists only what actually exists.
(async () => {
  const idx = await pool.query(
    `SELECT c.relname AS table_name, i.relname AS index_name,
            ix.indisunique, ix.indisprimary,
            pg_get_indexdef(ix.indexrelid) AS def,
            pg_get_expr(ix.indpred, ix.indrelid) AS predicate
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class c ON c.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
      ORDER BY c.relname, i.relname`
  );
  console.log("=== ALL INDEXES ===");
  for (const x of idx.rows) {
    const tags = [x.indisprimary ? "PK" : "", x.indisunique ? "UNIQUE" : ""]
      .filter(Boolean)
      .join("+");
    const part = x.predicate ? ` WHERE ${x.predicate}` : "";
    console.log(
      `${x.table_name.padEnd(28)} ${(tags || "idx").padEnd(8)} ${x.index_name}${part}`
    );
  }

  const checks = await pool.query(
    `SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'public' AND con.contype = 'c'
        AND con.conname NOT LIKE '%_not_null'
      ORDER BY rel.relname, con.conname`
  );
  console.log("\n=== CHECK CONSTRAINTS ===");
  if (checks.rows.length === 0) console.log("(none)");
  for (const c of checks.rows) {
    console.log(`${c.table_name.padEnd(28)} ${c.conname}: ${c.def}`);
  }

  await pool.end();
})().catch(async (e) => {
  console.error("failed:", e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
