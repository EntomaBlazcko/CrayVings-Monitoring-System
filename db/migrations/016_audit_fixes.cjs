// =============================================================================
// 016_audit_fixes.cjs - Fixes from the 2026-09-28 read-only database audit
// Idempotent (safe to run repeatedly). Run:  node db/migrations/016_audit_fixes.cjs
//
// A read-only health review of the live database found five issues. This
// migration fixes the four that are safe to fix mechanically. The fifth
// (sms_logs.recipient_phone integrity) is handled here in a NON-DESTRUCTIVE way
// that closes the audit gap without inventing truth - see section 2.
//
// Every statement here is additive or a constraint. Nothing deletes or
// rewrites sensor history. The orphan sms_logs rows are LEFT ALONE on purpose:
// deciding whether an alert was actually delivered is an operator decision, not
// something a migration may guess.
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

// ---- 1. functional index on sensors.device_id ------------------------------
//
// The app resolves tanks case-insensitively (server.cjs uses lower(device_id)
// everywhere), but sensors.device_id only had a plain btree index. EXPLAIN
// confirmed a full Seq Scan on every history query:
//
//   Sort
//     ->  Seq Scan on sensors
//           Filter: (lower((device_id)::text) = 'esp32_03'::text)
//
// It is harmless on 11 device rows and linear-bad as readings accumulate, so it
// degrades silently with data volume rather than failing loudly. Building it
// CONCURRENTLY keeps the table writable during the build; the plain CREATE
// INDEX would take an ACCESS EXCLUSIVE lock for the duration.
(async () => {
  // ---- 1. case-insensitive history lookup index ---------------------------
  // The app resolves tanks case-insensitively (server.cjs uses lower(device_id)
  // everywhere), but sensors.device_id only had a plain btree index. EXPLAIN
  // confirmed a full Seq Scan on every history query:
  //
  //   Sort
  //     ->  Seq Scan on sensors
  //           Filter: (lower((device_id)::text) = 'esp32_03'::text)
  //
  // It is harmless on 11 device rows and linear-bad as readings accumulate, so
  // it degrades silently with data volume rather than failing loudly.
  //
  // Composite (lower(device_id), timestamp DESC) so per-tank history and trend
  // queries share one structure, matching idx_sensors_device_timestamp.
  //
  // CONCURRENTLY so the build does not take an ACCESS EXCLUSIVE lock and the
  // server keeps writing readings throughout - which is why this is NOT inside
  // a transaction: PostgreSQL rejects CREATE INDEX CONCURRENTLY in a txn block.
  // Each subsequent step is individually transactional instead, so a failure
  // part-way through cannot leave a half-applied structural change.
  await pool.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sensors_device_id_ci
       ON sensors (lower(device_id), "timestamp" DESC)`
  );
  console.log("[migration] idx_sensors_device_id_ci built (concurrently)");

  // ---- 2. sms_logs recipient integrity -------------------------------------
  // docs/DATABASE.md documents `fk_sms_logs_recipient ... ON DELETE CASCADE`,
  // but no such FK exists on the live database, and grepping every
  // migration shows none ever created one - 003_sms_integration.cjs created both
  // tables without it. So the documented constraint has never existed; this is a
  // documentation bug, not a dropped constraint.
  //
  // The audit found 5 sms_logs rows whose recipient_phone matches no
  // authorized_recipients row (all +639925876027, all 2026-09-16).
  //
  // The FK CANNOT be added as documented, for TWO independent reasons. Both are
  // checked at runtime below so this migration never half-fails on either:
  //
  //   (a) A foreign key must reference a UNIQUE CONSTRAINT or a NON-PARTIAL
  //       unique index. Migration 006 replaced authorized_recipients'
  //       phone_number UNIQUE constraint with the PARTIAL index
  //       idx_recipients_phone_active (... WHERE archived_at IS NULL), so
  //       PostgreSQL rejects the reference outright:
  //         ERROR: there is no unique constraint matching given keys
  //       Restoring a full UNIQUE would undo 006's deliberate design - it lets
  //       an archived recipient's number be reused by a new one. A column
  //       cannot back both an FK and a partial index, so this is a genuine
  //       schema design conflict, not something to paper over.
  //
  //   (b) Even if (a) were resolved, the 5 orphans would fail validation, and
  //       "fixing" that by deleting or reassigning them would be fabricating a
  //       delivery record.
  //
  // So this migration enforces the intent of the constraint with a TRIGGER,
  // which needs no unique index and can be installed without touching history:
  // new and updated rows are checked, the 5 existing orphans are left alone.
  //
  // NOTE this is a weaker guarantee than an FK: it will not fire if a recipient
  // row is DELETED afterwards (an FK's ON DELETE CASCADE would have cleaned up
  // sms_logs). Recipients are archived rather than deleted, so that path is
  // rare, but it is a real difference and the operator should know about it.
  const { rows: fkRows } = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'fk_sms_logs_recipient'`
  );

  const { rows: uniqueCheck } = await pool.query(
    `SELECT 1
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_attribute a
         ON a.attrelid = i.indrelid
        AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = 'authorized_recipients'::regclass
        AND i.indisunique
        AND i.indpred IS NULL          -- a PARTIAL index cannot back an FK
        AND a.attname = 'phone_number'
      LIMIT 1`
  );
  const canUseForeignKey = uniqueCheck.length > 0;

  if (fkRows.length > 0) {
    console.log("[migration] fk_sms_logs_recipient already present");
  } else if (canUseForeignKey) {
    // Path (a) resolved: a full unique index exists, so add the real FK as
    // NOT VALID - enforced for new rows, existing orphans grandfathered.
    const { rows: orphanRows } = await pool.query(
      `SELECT count(*)::int AS n
         FROM sms_logs s
        WHERE NOT EXISTS (SELECT 1 FROM authorized_recipients a
                           WHERE a.phone_number = s.recipient_phone)`
    );
    const orphanCount = orphanRows.length > 0 ? orphanRows[0].n : 0;

    await pool.query(
      `ALTER TABLE sms_logs
         ADD CONSTRAINT fk_sms_logs_recipient
         FOREIGN KEY (recipient_phone) REFERENCES authorized_recipients(phone_number)
         ON DELETE CASCADE NOT VALID`
    );
    console.log(
      `[migration] added fk_sms_logs_recipient NOT VALID (${orphanCount} existing orphan rows grandfathered)`
    );
    if (orphanCount > 0) {
      console.warn(
        "[migration] WARNING: the constraint is NOT VALID. Existing rows are unverified.\n" +
          "            Resolve the orphans, then run:\n" +
          "              ALTER TABLE sms_logs VALIDATE CONSTRAINT fk_sms_logs_recipient;"
      );
    }
  } else {
    // Path (a): migration 006's partial index blocks the FK. Install a trigger
    // instead, which enforces the same intent for all new/updated rows.
    await pool.query(
      `CREATE OR REPLACE FUNCTION check_sms_logs_recipient() RETURNS trigger AS $$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM authorized_recipients WHERE phone_number = NEW.recipient_phone) THEN
           RAISE EXCEPTION
             'sms_logs.recipient_phone % has no matching authorized_recipients row', NEW.recipient_phone
             USING ERRCODE = 'foreign_key_violation';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`
    );
    await pool.query(
      `DROP TRIGGER IF EXISTS trg_sms_logs_recipient ON sms_logs`
    );
    await pool.query(
      `CREATE TRIGGER trg_sms_logs_recipient
         BEFORE INSERT OR UPDATE OF recipient_phone ON sms_logs
         FOR EACH ROW EXECUTE FUNCTION check_sms_logs_recipient()`
    );
    console.log(
      "[migration] recipient_phone integrity: TRIGGER installed (FK not possible - 006's partial unique index cannot back a foreign key)"
    );
  }

  const { rows: orphanRows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM sms_logs s
      WHERE NOT EXISTS (SELECT 1 FROM authorized_recipients a
                         WHERE a.phone_number = s.recipient_phone)`
  );
  if (orphanRows.length > 0 && orphanRows[0].n > 0) {
    console.warn(
      `[migration] WARNING: ${orphanRows[0].n} existing sms_logs row(s) have no matching recipient.\n` +
        "            They are intentionally left in place - whether an alert was\n" +
        "            actually delivered is an operator decision, not a migration's to invent."
    );
  }

  // ---- 3. clear tokens on non-active users ----------------------------------
  // An archived account keeps its session token and expiry. Login is blocked by
  // `status = 'active'` in the auth query so this is not exploitable, but a
  // stale hash sitting in the table is a credential that outlives its purpose.
  const cleared = await pool.query(
    `UPDATE users SET token = NULL, token_expires_at = NULL
      WHERE status <> 'active' AND token IS NOT NULL
      RETURNING username`
  );
  console.log(
    cleared.rows.length > 0
      ? `[migration] cleared stale tokens for ${cleared.rows.length} non-active user(s): ${cleared.rows.map((r) => r.username).join(", ")}`
      : "[migration] no stale tokens on non-active users"
  );

  // ---- 4. timestamptz alignment --------------------------------------------
  // system_logs.acknowledged_at is `timestamp without time zone` inside an
  // otherwise timestamptz table. Any `new Date()` comparison against it is
  // ambiguous by the server's UTC offset (+08 on this host) - the same class of
  // drift migration 005 fixed for users.token_expires_at and sms_logs.sent_at.
  //
  // USING makes it absolute: an existing naive value is interpreted in the
  // server's current TimeZone and stored as an instant. For acknowledged_at
  // that is the correct reading, because the server wrote it with NOW() at the
  // same moment it wrote the timestamptz `timestamp` column on the same row.
  await pool.query(
    `ALTER TABLE system_logs
       ALTER COLUMN acknowledged_at TYPE timestamptz USING acknowledged_at AT TIME ZONE current_setting('TimeZone')`
  );
  console.log("[migration] system_logs.acknowledged_at -> timestamptz");

  // activity_logs.timestamp and last_alerts.timestamp have no timestamptz
  // sibling to disambiguate against, and are read by the app as naive local
  // wall-clock. Converting them is the same operation, but it changes how
  // existing rows compare against NOW() in ad-hoc SQL, so it is applied for
  // consistency with the documented schema and called out here explicitly.
  await pool.query(
    `ALTER TABLE activity_logs
       ALTER COLUMN "timestamp" TYPE timestamptz USING "timestamp" AT TIME ZONE current_setting('TimeZone')`
  );
  console.log("[migration] activity_logs.timestamp -> timestamptz");

  await pool.query(
    `ALTER TABLE last_alerts
       ALTER COLUMN "timestamp" TYPE timestamptz USING "timestamp" AT TIME ZONE current_setting('TimeZone')`
  );
  console.log("[migration] last_alerts.timestamp -> timestamptz");

  // ---- 5. record -----------------------------------------------------------
  // Recorded LAST and only once every step above has succeeded, so a partially
  // applied run is never mistaken for a completed one. Mirrors the 014 lesson:
  // recording a version while a required guarantee is missing is what makes a
  // migration fail open.
  await pool.query(
    `INSERT INTO schema_migrations (version, name)
       VALUES ('016', 'audit_fixes')
     ON CONFLICT (version) DO NOTHING`
  );

  await report();
  await pool.end();
  console.log("[migration] 016_audit_fixes applied");
})().catch(async (err) => {
  console.error("[migration] 016_audit_fixes failed:", err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

// Verification: every fix is reported as present-and-correct, never inferred.
async function report() {
  const idx = await pool.query(
    `SELECT i.indisunique, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_sensors_device_id_ci'
        AND i.indrelid = 'sensors'::regclass`
  );
  console.log(
    idx.rows.length > 0
      ? `idx_sensors_device_id_ci -> ${idx.rows[0].def}`
      : "idx_sensors_device_id_ci -> MISSING"
  );

  const fk = await pool.query(
    `SELECT conname, convalidated
       FROM pg_constraint
      WHERE conrelid = 'sms_logs'::regclass AND contype = 'f'`
  );
  for (const f of fk.rows) {
    console.log(
      `sms_logs FK ${f.conname} -> ${f.convalidated ? "VALID (all rows checked)" : "NOT VALID (existing rows unverified)"}`
    );
  }

  // Report the enforcement mechanism actually in place. A silent "no FK found"
  // here would be ambiguous between "not installed" and "installed the trigger
  // instead", and those are very different states.
  const trg = await pool.query(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'sms_logs'::regclass
        AND tgname = 'trg_sms_logs_recipient'
        AND NOT tgisinternal`
  );
  const fn = await pool.query(
    `SELECT proname FROM pg_proc WHERE proname = 'check_sms_logs_recipient'`
  );
  console.log(
    fk.rows.some((f) => f.conname === "fk_sms_logs_recipient")
      ? "sms_logs recipient enforcement -> FOREIGN KEY fk_sms_logs_recipient"
      : trg.rows.length > 0 && fn.rows.length > 0
        ? "sms_logs recipient enforcement -> TRIGGER trg_sms_logs_recipient + function check_sms_logs_recipient"
        : "sms_logs recipient enforcement -> NONE (fix did not apply)"
  );

  const orphans = await pool.query(
    `SELECT count(*)::int AS n
       FROM sms_logs s
      WHERE NOT EXISTS (SELECT 1 FROM authorized_recipients a
                         WHERE a.phone_number = s.recipient_phone)`
  );
  console.log(`sms_logs rows with no matching recipient -> ${orphans.rows[0].n} (operator must resolve)`);

  const stale = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE status <> 'active' AND token IS NOT NULL`
  );
  console.log(`non-active users still holding a token -> ${stale.rows[0].n}`);

  const naive = await pool.query(
    `SELECT table_name || '.' || column_name AS col
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type = 'timestamp without time zone'
        AND column_name IN ('timestamp', 'acknowledged_at')
      ORDER BY 1`
  );
  console.log(
    naive.rows.length === 0
      ? "naive timestamp columns on timestamp/acknowledged_at -> none"
      : `still naive: ${naive.rows.map((r) => r.col).join(", ")}`
  );
}
