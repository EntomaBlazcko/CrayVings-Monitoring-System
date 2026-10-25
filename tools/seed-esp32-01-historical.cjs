/**
 * seed-esp32-01-historical.cjs
 *
 * Backfills demo readings for ESP32_01 so the dashboard's history, charts and
 * report exports have something to show on a tank that has never really run.
 *
 * - Window: 2026-08-01T00:00:00Z .. 2026-08-31T23:59:59Z, one row every 5 min.
 * - Values: tropical-tank baselines with a daily swing + jitter, plus four
 *   injected spike windows (Aug 7/14/21/26) so the charts show excursions.
 *   Ammonia is the parameter that actually breaches: the baseline sits inside
 *   the 0.25-1.00 ppm safe band (the old 0.02 baseline was below the min, so
 *   every single reading read "Critical") while the spikes drive it to ~1.2,
 *   over the max. That keeps the threshold cards green between spikes and
 *   gives the Alert Summary genuine breaches - but only once
 *   tools/backfill-esp32-01-alerts.cjs has replayed them into system_logs,
 *   because this script writes `sensors` directly and never goes through
 *   POST /sensor, the only path that evaluates thresholds and logs alerts.
 * - Add-only: aborts if any row already exists in the window, so a re-run can
 *   never duplicate or overwrite data. Run against a staging/dev DB only.
 * - Retention guard: the backend's cleanupOldData() deletes sensors rows older
 *   than SENSOR_RETENTION_DAYS (default 30) on startup and daily, so seeding a
 *   backdated window while retention is on would be purged on the next restart.
 *   This aborts instead; set SENSOR_RETENTION_DAYS=0 in .env and restart first.
 *
 * Usage: node tools/seed-esp32-01-historical.cjs
 */
const { Pool } = require('pg');
require('dotenv').config();

// Mirrors envDays() in server.cjs so the guard agrees with the running backend.
const rawRetention = parseInt(process.env.SENSOR_RETENTION_DAYS, 10);
const retentionDays = Number.isFinite(rawRetention) && rawRetention >= 0 ? rawRetention : 30;
const SEED_START = new Date('2026-08-01T00:00:00.000Z');
if (retentionDays > 0) {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  if (SEED_START.getTime() < cutoffMs) {
    console.error(
      `[ABORT] SENSOR_RETENTION_DAYS=${retentionDays} is active, so the backend would delete\n` +
      `        these readings on its next startup/daily cleanup (everything older than\n` +
      `        ${new Date(cutoffMs).toISOString()}).\n` +
      '        Set SENSOR_RETENTION_DAYS=0 in .env, restart the backend, then re-run this script.'
    );
    process.exit(1);
  }
}

function clamp(v, min, max) {
  if (isNaN(v) || !isFinite(v)) return null;
  if (v < min) return min;
  if (v > max) return max;
  return Number(v.toFixed(2));
}

function addMin(d, m) { const x = new Date(d); x.setMinutes(x.getMinutes() + m); return x; }

async function main() {
  const pool = new Pool({
    host: process.env.PG_HOST || process.env.DB_HOST || 'localhost',
    port: Number(process.env.PG_PORT || process.env.DB_PORT || 5432),
    database: process.env.PG_DATABASE || process.env.DB_NAME,
    user: process.env.PG_USER || process.env.DB_USER,
    password: process.env.PG_PASSWORD || process.env.DB_PASSWORD,
  });
  const start = new Date(SEED_START);
  const end = new Date('2026-08-31T23:59:59.000Z');
  const dev = 'ESP32_01';
  try {
    const client = await pool.connect();
    try {
      const d = await client.query('SELECT device_id,is_active,archived_at FROM devices WHERE device_id=$1', [dev]);
      if (!d.rowCount) { console.error('[ERROR] device not found'); process.exit(1); }
      console.log('[INFO] dev:', d.rows[0]);
      const ov = await client.query('SELECT COUNT(*)::int c FROM sensors WHERE device_id=$1 AND timestamp>=$2 AND timestamp<=$3', [dev, start.toISOString(), end.toISOString()]);
      if (ov.rows[0].c > 0) { console.error('[ERROR] overlap:', ov.rows[0].c); process.exit(1); }
      const spikes = [
        {day:7,hStart:14,hEnd:16},{day:14,hStart:9,hEnd:11},{day:21,hStart:3,hEnd:5},{day:26,hStart:18,hEnd:21}
      ];
      const rows = [];
      let t = new Date(start);
      while (t <= end) {
        const hod = t.getUTCHours(), mod = hod*60+t.getUTCMinutes(), dom = t.getUTCDate();
        let temp = 26 + Math.sin(mod/(24*60)*2*Math.PI)*0.8 + (Math.random()-0.5)*0.4;
        let lvl = 23 + Math.sin(mod/(24*60)*2*Math.PI+Math.PI/2)*2 + (Math.random()-0.5)*2;
        let nh3 = 0.35 + Math.sin(mod/(24*60)*2*Math.PI)*0.04 + (Math.random()-0.5)*0.04;
        for (const s of spikes) {
          if (dom===s.day && hod>=s.hStart && hod<s.hEnd) {
            temp += 2+(Math.random()-0.5)*0.3; nh3 += 0.85+(Math.random()-0.5)*0.06; lvl -= 6.5+(Math.random()-0.5)*1.5;
          }
        }
        temp=clamp(temp,0.01,99.99); lvl=clamp(lvl,0,199.99); nh3=clamp(nh3,0,999.99);
        rows.push([dev, temp, lvl, nh3, t.toISOString()]);
        t = addMin(t,5);
      }
      console.log('[INFO] generating', rows.length);
      let ins=0; const cs=1000;
      for (let i=0;i<rows.length;i+=cs) {
        const ch=rows.slice(i,i+cs);
        const vals=[]; const ph=[];
        for (let j=0;j<ch.length;j++) {
          const r=ch[j]; const b=j*5;
          ph.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`); vals.push(r[0],r[1],r[2],r[3],r[4]);
        }
        await client.query(`INSERT INTO sensors(device_id,temperature,water_level,ammonia,timestamp) VALUES ${ph.join(',')}`, vals);
        ins+=ch.length;
      }
      console.log('[SUCCESS] inserted', ins);
    } finally { client.release(); }
  } catch (e) { console.error('[ERR]',e); process.exit(1); } finally { await pool.end(); }
}
main();
