require('dotenv').config();
const client = require('axios').default || require('axios');

(async () => {
  const url = process.env.API_BASE || 'http://localhost:3000';
  for (const path of ['/devices/latest', '/health']) {
    try {
      const r = await client.get(url + path, { timeout: 6000 });
      const now = Date.now();
      console.log('=== ' + path + ' (' + new Date(now).toISOString() + ') ===');
      const rows = Array.isArray(r.data) ? r.data : [r.data];
      for (const row of rows) {
        const recv = row.recv_at ? new Date(row.recv_at) : null;
        const age = recv ? Math.round((now - recv.getTime()) / 1000) : null;
        console.log(JSON.stringify({ ...row, _age_s: age }));
      }
    } catch (e) {
      console.log('=== ' + path + ' FAIL ===');
      console.log(e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 300) : e.message);
    }
  }
  process.exit(0);
})();
