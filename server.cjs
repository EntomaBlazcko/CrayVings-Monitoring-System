const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(express.json());

// Explicit CORS for all origins
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// Mongoose Schema & Model
const SensorSchema = new mongoose.Schema({
  device_id: String,
  temperature: Number,
  water_level: Number,
  ph: Number,
  dissolved_oxygen: Number,
  ammonia: Number,
  timestamp: { type: Date, default: Date.now }
});
const Sensor = mongoose.model("Sensor", SensorSchema);

// MongoDB Connection
mongoose.connect("mongodb://127.0.0.1:27017/aquaculture")
  .then(() => console.log(`[${new Date().toISOString()}] DB connected`))
  .catch(err => console.error(`[${new Date().toISOString()}] DB connection error:`, err));

// Connection event listeners
mongoose.connection.on("disconnected", () =>
  console.warn(`[${new Date().toISOString()}] DB disconnected`)
);
mongoose.connection.on("reconnected", () =>
  console.log(`[${new Date().toISOString()}] DB reconnected`)
);
mongoose.connection.on("error", err =>
  console.error(`[${new Date().toISOString()}] DB error:`, err)
);

// Test DB connection
mongoose.connection.once("open", async () => {
  const count = await Sensor.countDocuments();
  console.log(`[${new Date().toISOString()}] Sensors documents count:`, count);
});

// Routes
app.get("/", (req, res) => res.send("Server running"));

app.post("/sensor", async (req, res) => {
  try {
    const data = new Sensor(req.body);
    await data.save();
    res.status(201).send("Saved to database");
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error saving sensor:`, err);
    res.status(500).send("Error saving data");
  }
});

app.get("/sensor", async (req, res) => {
  try {
    const data = await Sensor.find().sort({ timestamp: -1 }).limit(50);
    res.json(data);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching sensors:`, err);
    res.status(500).send("Error fetching data");
  }
});

// Latest sensor data route with logging
app.get("/sensor/latest", async (req, res) => {
  try {
    const latestData = await Sensor.findOne().sort({ timestamp: -1 });
    console.log(`[${new Date().toISOString()}] Latest data sent:`, latestData);
    res.json(latestData);
  } catch (err) {
    console.error("Error fetching latest sensor data:", err);
    res.status(500).send("Error fetching latest data");
  }
});

// Start server on all network interfaces
const PORT = 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`[${new Date().toISOString()}] Server started on port ${PORT}`)
);