const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

const pool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || "crayvings_monitoring_system_db",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "JAPAN1234",
});

app.get("/", (req, res) => {
  res.json({
    message: "Server running",
    routes: ["/", "/health", "/sensor", "/sensor/latest", "/logs", "/logs (POST)"],
  });
});

app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT COUNT(*) FROM sensors");
    res.json({
      status: "ok",
      database: "connected",
      documents: parseInt(result.rows[0].count),
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "Health check failed",
      error: err.message,
    });
  }
});

app.post("/sensor", async (req, res) => {
  try {
    const {
      device_id,
      temperature,
      water_level,
      ph,
      dissolved_oxygen,
      ammonia,
      timestamp,
    } = req.body;

    if (!device_id) {
      return res.status(400).json({
        message: "device_id is required",
      });
    }

    const lastResult = await pool.query(
      "SELECT * FROM sensors ORDER BY timestamp DESC LIMIT 1"
    );
    const lastData = lastResult.rows[0];

    const result = await pool.query(
      `INSERT INTO sensors (device_id, temperature, water_level, ph, dissolved_oxygen, ammonia, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        device_id,
        Number(temperature ?? 0),
        Number(water_level ?? 0),
        Number(ph ?? 0),
        Number(dissolved_oxygen ?? 0),
        Number(ammonia ?? 0),
        timestamp ? new Date(timestamp) : new Date(),
      ]
    );

    console.log(`[${new Date().toISOString()}] Sensor data saved:`, result.rows[0]);

    const settingsResult = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
    const settings = settingsResult.rows[0] || {
      temp_min: 20.0, temp_max: 31.0,
      ph_min: 6.5, ph_max: 8.5,
      do_min: 5.0, do_max: 10.0,
      water_level_min: 10.0, water_level_max: 100.0,
      ammonia_min: 0.0, ammonia_max: 0.5
    };

    const alerts = [];
    const tempVal = Number(temperature);
    const phVal = Number(ph);
    const doVal = Number(dissolved_oxygen);
    const wlVal = Number(water_level);
    const ammVal = Number(ammonia);

    if (tempVal < settings.temp_min || tempVal > settings.temp_max) {
      alerts.push({ parameter: "Temperature", old_value: tempVal < settings.temp_min ? "Low" : "High", new_value: tempVal });
    }
    if (phVal < settings.ph_min || phVal > settings.ph_max) {
      alerts.push({ parameter: "pH Level", old_value: phVal < settings.ph_min ? "Low" : "High", new_value: phVal });
    }
    if (doVal < settings.do_min || doVal > settings.do_max) {
      alerts.push({ parameter: "Dissolved Oxygen", old_value: doVal < settings.do_min ? "Low" : "High", new_value: doVal });
    }
    if (wlVal < settings.water_level_min || wlVal > settings.water_level_max) {
      alerts.push({ parameter: "Water Level", old_value: wlVal < settings.water_level_min ? "Low" : "High", new_value: wlVal });
    }
    if (ammVal < settings.ammonia_min || ammVal > settings.ammonia_max) {
      alerts.push({ parameter: "Ammonia", old_value: ammVal < settings.ammonia_min ? "Low" : "High", new_value: ammVal });
    }

    for (const alert of alerts) {
      await pool.query(
        `INSERT INTO system_logs (action, parameter, old_value, new_value) VALUES ($1, $2, $3, $4)`,
        ["Alert", alert.parameter, alert.old_value, alert.new_value]
      );
      console.log(`[${new Date().toISOString()}] Alert logged: ${alert.parameter} ${alert.old_value}`);
    }

    res.status(201).json({
      message: "Saved to database",
      data: result.rows[0],
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error saving sensor:`, err);
    res.status(500).json({
      message: "Error saving data",
      error: err.message,
    });
  }
});

app.get("/sensor", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM sensors ORDER BY timestamp DESC LIMIT 50"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching sensors:`, err);
    res.status(500).json({
      message: "Error fetching data",
      error: err.message,
    });
  }
});

app.get("/sensor/latest", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM sensors ORDER BY timestamp DESC LIMIT 1"
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "No sensor data found",
      });
    }

    console.log(`[${new Date().toISOString()}] Latest data sent:`, result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching latest sensor data:`, err);
    res.status(500).json({
      message: "Error fetching latest data",
      error: err.message,
    });
  }
});

app.post("/logs", async (req, res) => {
  try {
    const { action, parameter, old_value, new_value } = req.body;

    if (!action || !parameter) {
      return res.status(400).json({
        message: "action and parameter are required",
      });
    }

    const result = await pool.query(
      `INSERT INTO system_logs (action, parameter, old_value, new_value)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [action, parameter, String(old_value ?? ""), String(new_value ?? "")]
    );

    console.log(`[${new Date().toISOString()}] Log created:`, result.rows[0]);

    res.status(201).json({
      message: "Log created",
      data: result.rows[0],
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating log:`, err);
    res.status(500).json({
      message: "Error creating log",
      error: err.message,
    });
  }
});

app.get("/system-logs", async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] ✓ /system-logs endpoint hit`);
    const result = await pool.query(
      "SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT 100"
    );
    console.log(`[${new Date().toISOString()}] Logs found:`, result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching logs:`, err);
    res.status(500).json({
      message: "Error fetching logs",
      error: err.message,
    });
  }
});

app.get("/settings", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sensor_settings LIMIT 1");
    if (result.rows.length === 0) {
      const defaultSettings = {
        temp_min: 20.0,
        temp_max: 31.0,
        ph_min: 6.5,
        ph_max: 8.5,
        do_min: 5.0,
        do_max: 10.0,
        water_level_min: 10.0,
        water_level_max: 100.0,
        ammonia_min: 0.0,
        ammonia_max: 0.5,
      };
      return res.json(defaultSettings);
    }
    const dbSettings = result.rows[0];
    const defaults = {
      do_max: 10.0,
      ammonia_min: 0.0,
    };
    for (const key of Object.keys(defaults)) {
      if (dbSettings[key] == null || dbSettings[key] === undefined) {
        dbSettings[key] = defaults[key];
      }
    }
    res.json(dbSettings);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching settings:`, err);
    res.status(500).json({ message: "Error fetching settings" });
  }
});

app.post("/settings", async (req, res) => {
  try {
    const {
      temp_min,
      temp_max,
      ph_min,
      ph_max,
      do_min,
      do_max,
      water_level_min,
      water_level_max,
      ammonia_min,
      ammonia_max,
    } = req.body;

    const existing = await pool.query("SELECT id FROM sensor_settings LIMIT 1");
    
    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(
        `UPDATE sensor_settings SET 
          temp_min = $1, temp_max = $2, ph_min = $3, ph_max = $4,
          do_min = $5, do_max = $6, water_level_min = $7, water_level_max = $8,
          ammonia_min = $9, ammonia_max = $10
        WHERE id = $11 RETURNING *`,
        [temp_min, temp_max, ph_min, ph_max, do_min, do_max, water_level_min, water_level_max, ammonia_min, ammonia_max, existing.rows[0].id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO sensor_settings (temp_min, temp_max, ph_min, ph_max, do_min, do_max, water_level_min, water_level_max, ammonia_min, ammonia_max)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [temp_min, temp_max, ph_min, ph_max, do_min, do_max, water_level_min, water_level_max, ammonia_min, ammonia_max]
      );
    }

    console.log(`[${new Date().toISOString()}] Settings saved:`, result.rows[0]);
    res.json({ message: "Settings saved", data: result.rows[0] });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error saving settings:`, err);
    res.status(500).json({ message: "Error saving settings" });
  }
});

async function startServer() {
  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS sensors (
          id SERIAL PRIMARY KEY,
          device_id VARCHAR(50) NOT NULL,
          temperature DECIMAL(5,2) DEFAULT 0,
          water_level DECIMAL(5,2) DEFAULT 0,
          ph DECIMAL(5,2) DEFAULT 0,
          dissolved_oxygen DECIMAL(5,2) DEFAULT 0,
          ammonia DECIMAL(5,2) DEFAULT 0,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS system_logs (
          id SERIAL PRIMARY KEY,
          action VARCHAR(100) NOT NULL,
          parameter VARCHAR(100) NOT NULL,
          old_value VARCHAR(50),
          new_value VARCHAR(50),
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS sensor_settings (
          id SERIAL PRIMARY KEY,
          temp_min DECIMAL(5,2) DEFAULT 20.0,
          temp_max DECIMAL(5,2) DEFAULT 31.0,
          ph_min DECIMAL(5,2) DEFAULT 6.5,
          ph_max DECIMAL(5,2) DEFAULT 8.5,
          do_min DECIMAL(5,2) DEFAULT 5.0,
          do_max DECIMAL(5,2) DEFAULT 10.0,
          water_level_min DECIMAL(5,2) DEFAULT 10.0,
          water_level_max DECIMAL(5,2) DEFAULT 100.0,
          ammonia_min DECIMAL(5,2) DEFAULT 0.0,
          ammonia_max DECIMAL(5,2) DEFAULT 0.5,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      await client.query(`
        ALTER TABLE sensor_settings ADD COLUMN IF NOT EXISTS do_max DECIMAL(5,2) DEFAULT 10.0
      `);
      
      await client.query(`
        ALTER TABLE sensor_settings ADD COLUMN IF NOT EXISTS ammonia_min DECIMAL(5,2) DEFAULT 0.0
      `);
      
      const logsCount = await client.query("SELECT COUNT(*) FROM system_logs");
      console.log(`[${new Date().toISOString()}] Logs table ready (${logsCount.rows[0].count} records)`);
      
      const result = await client.query("SELECT COUNT(*) FROM sensors");
      console.log(`[${new Date().toISOString()}] Sensor records count: ${result.rows[0].count}`);
      console.log(`[${new Date().toISOString()}] PostgreSQL connected and table ready`);
    } finally {
      client.release();
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[${new Date().toISOString()}] Server started on port ${PORT}`);
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Server startup error:`, err.message);
    process.exit(1);
  }
}

startServer();

process.on("unhandledRejection", (reason) => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection:`, reason);
});

process.on("uncaughtException", (err) => {
  console.error(`[${new Date().toISOString()}] Uncaught exception:`, err.message);
  process.exit(1);
});