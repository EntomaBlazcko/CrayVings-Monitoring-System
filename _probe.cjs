require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.PG_HOST, port: +process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD });

(async () => {
  try {
    const devices = await pool.query('SELECT device_id, tank_name, ip_address, is_active, last_seen FROM devices ORDER BY device_id');
    console.log('=== DEVICES ===');
    for (const d of devices.rows) console.log(JSON.stringify(d));

    const fix = await pool.query(
      `SELECT device_id, temperature, water_level, ammonia, timestamp
         FROM sensors
        WHERE (device_id, timestamp) IN (
          SELECT device_id, MAX(timestamp) FROM sensors GROUP BY device_id
        )
        ORDER BY device_id`
    );
    console.log('=== FRESHEST ROW PER DEVICE ===');
    for (const r of fix.rows) console.log(JSON.stringify(r));

    const cnt = await pool.query('SELECT COUNT(*) FROM sensors');
    console.log('total sensor rows:', cnt.rows[0].count);

    pool.end();
  } catch (e) {
    console.error('ERR', e.message);
    pool.end();
  }
})();
