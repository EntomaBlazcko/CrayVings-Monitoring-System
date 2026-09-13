require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.PG_HOST, port: +process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD });
pool.query('SELECT id, username, role, email, left(created_at::text,19) AS created FROM users ORDER BY id')
  .then(r => { r.rows.forEach(x => console.log(`${x.id}\t${x.username}\t${x.role}\t${x.email}\t${x.created}`)); process.exit(0); })
  .catch(e => { console.error('ERR', e.message); process.exit(1); });