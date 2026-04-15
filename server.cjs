const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
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

const SensorSchema = new mongoose.Schema({
  device_id: { type: String, required: true },
  temperature: { type: Number, default: 0 },
  water_level: { type: Number, default: 0 },
  ph: { type: Number, default: 0 },
  dissolved_oxygen: { type: Number, default: 0 },
  ammonia: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now },
});

const Sensor = mongoose.model("Sensor", SensorSchema);

mongoose
  .connect("mongodb://127.0.0.1:27017/aquaculture")
  .then(() => console.log(`[${new Date().toISOString()}] DB connected`))
  .catch((err) =>
    console.error(`[${new Date().toISOString()}] DB connection error:`, err)
  );

mongoose.connection.on("disconnected", () =>
  console.warn(`[${new Date().toISOString()}] DB disconnected`)
);

mongoose.connection.on("reconnected", () =>
  console.log(`[${new Date().toISOString()}] DB reconnected`)
);

mongoose.connection.on("error", (err) =>
  console.error(`[${new Date().toISOString()}] DB error:`, err)
);

mongoose.connection.once("open", async () => {
  try {
    const count = await Sensor.countDocuments();
    console.log(`[${new Date().toISOString()}] Sensor documents count:`, count);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Count error:`, err);
  }
});

app.get("/", (req, res) => {
  res.send("Server running");
});

app.get("/health", async (req, res) => {
  try {
    const count = await Sensor.countDocuments();
    res.json({
      status: "ok",
      database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      documents: count,
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

    const data = new Sensor({
      device_id,
      temperature: Number(temperature ?? 0),
      water_level: Number(water_level ?? 0),
      ph: Number(ph ?? 0),
      dissolved_oxygen: Number(dissolved_oxygen ?? 0),
      ammonia: Number(ammonia ?? 0),
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    });

    await data.save();

    console.log(`[${new Date().toISOString()}] Sensor data saved:`, data);

    res.status(201).json({
      message: "Saved to database",
      data,
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
    const data = await Sensor.find().sort({ timestamp: -1 }).limit(50);

    res.json(data);
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
    const latestData = await Sensor.findOne().sort({ timestamp: -1 });

    if (!latestData) {
      return res.status(404).json({
        message: "No sensor data found",
      });
    }

    console.log(`[${new Date().toISOString()}] Latest data sent:`, latestData);

    res.json(latestData);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching latest sensor data:`, err);
    res.status(500).json({
      message: "Error fetching latest data",
      error: err.message,
    });
  }
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`[${new Date().toISOString()}] Server started on port ${PORT}`)
);

// ============================================
// Arduino Serial Communication (Auto-Save)
// ============================================
// Requires: npm install serialport
// Configure in .env: ARDUINO_PORT=/dev/ttyUSB0 or COM3
// Arduino format: temperature,water_level,ph,dissolved_oxygen,ammonia

const ARDUINO_ENABLED = process.env.ARDUINO_ENABLED === "true";
const ARDUINO_PORT = process.env.ARDUINO_PORT || "COM3";
const ARDUINO_BAUD = parseInt(process.env.ARDUINO_BAUD || "9600");
const DEVICE_ID = process.env.DEVICE_ID || "ARDUINO_001";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5000");

let serialPort = null;

async function saveSensorData(data) {
  try {
    const sensorData = new Sensor({
      device_id: data.device_id || DEVICE_ID,
      temperature: Number(data.temperature ?? 0),
      water_level: Number(data.water_level ?? 0),
      ph: Number(data.ph ?? 0),
      dissolved_oxygen: Number(data.dissolved_oxygen ?? 0),
      ammonia: Number(data.ammonia ?? 0),
      timestamp: new Date(),
    });

    await sensorData.save();
    console.log(`[${new Date().toISOString()}] Arduino data saved:`, sensorData);
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error saving Arduino data:`, err.message);
    return false;
  }
}

async function initArduino() {
  if (!ARDUINO_ENABLED) {
    console.log(`[${new Date().toISOString()}] Arduino auto-read disabled (set ARDUINO_ENABLED=true to enable)`);
    return;
  }

  try {
    const { SerialPort } = require("serialport");
    const { ReadlineParser } = require("@serialport/parser-readline");

    serialPort = new SerialPort({
      path: ARDUINO_PORT,
      baudRate: ARDUINO_BAUD,
    });

    const parser = serialPort.pipe(new ReadlineParser({ delimiter: "\n" }));

    serialPort.on("open", () => {
      console.log(`[${new Date().toISOString()}] Serial port ${ARDUINO_PORT} opened`);
    });

    serialPort.on("error", (err) => {
      console.error(`[${new Date().toISOString()}] Serial port error:`, err.message);
    });

    parser.on("data", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Expected format: temperature,water_level,ph,dissolved_oxygen,ammonia
      // Example: 25.5,10.2,7.0,8.5,0.1
      const parts = trimmed.split(",").map((p) => parseFloat(p.trim()));

      if (parts.length === 5 && parts.every((v) => !isNaN(v))) {
        const [temperature, water_level, ph, dissolved_oxygen, ammonia] = parts;
        await saveSensorData({ temperature, water_level, ph, dissolved_oxygen, ammonia });
      } else {
        console.warn(`[${new Date().toISOString()}] Invalid Arduino data format: "${trimmed}"`);
      }
    });

    serialPort.on("close", () => {
      console.log(`[${new Date().toISOString()}] Serial port closed`);
      if (ARDUINO_ENABLED) {
        console.log(`[${new Date().toISOString()}] Reconnecting in 5 seconds...`);
        setTimeout(initArduino, 5000);
      }
    });

  } catch (err) {
    if (err.code === "MODULE_NOT_FOUND") {
      console.error(`[${new Date().toISOString()}] serialport package not found. Run: npm install serialport @serialport/parser-readline`);
    } else {
      console.error(`[${new Date().toISOString()}] Failed to init Arduino:`, err.message);
    }
  }
}

// Start Arduino reader after DB is ready
mongoose.connection.once("open", () => {
  initArduino();
});