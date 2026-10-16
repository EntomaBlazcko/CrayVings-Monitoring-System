/**
 * Scenario profiles for scripts/mock-device.js
 *
 * A profile describes how a simulated ESP32 behaves over time: its baseline
 * readings, how much sensor noise to add, how the values drift, and any
 * scripted events (spikes, sensor failures, disconnects).
 *
 * Readings are shaped to the SENSOR CONTRACT in server.cjs:
 *   - temperature : > 0 is a valid reading;  0  is the DS18B20 failure sentinel
 *   - water_level : >= 0 is a valid reading; -1  is the HC-SR04 failure sentinel
 *   - ammonia     : >= 0 is a valid reading; -1  is the MQ-137 failure sentinel
 * Values below/at those sentinels are stored as NULL by the server, which the
 * dashboard renders as a grey "No signal" pill rather than a false warning.
 *
 * NOTE ON THRESHOLDS: the "ramp" targets below assume the INTENDED safe range
 * (temp 20-31 C, from DEFAULT_SETTINGS in src/types/index.ts). If your live
 * settings row has been edited (e.g. temp_max 49.90), a temperature scenario
 * will not trip the alert. Check with: npm run mock -- --show-config
 */

export const PROFILES = {
  /**
   * Baseline: tank is healthy and gently cycling. Ammonia stays well under the
   * 1.0 ppm limit, so the dashboard should sit on "Tank Safe" indefinitely.
   * This is the profile to leave running while working on something else.
   */
  healthy: {
    description: "Healthy tank, gentle diurnal drift. Stays in the safe range.",
    base: { temperature: 27.5, water_level: 78, ammonia: 0.35 },
    // Random walk amplitude (peak-to-peak/2) per cycle, mimicking ADC noise.
    noise: { temperature: 0.25, water_level: 1.2, ammonia: 0.03 },
    // Systematic movement per cycle, so charts trend instead of flat-lining.
    drift: { temperature: 0.02, water_level: -0.05, ammonia: 0.001 },
    // Clamp so a long run cannot wander somewhere physically impossible.
    bounds: {
      temperature: [21, 30.5],
      water_level: [55, 95],
      ammonia: [0.05, 0.9],
    },
    interval: 5000,
  },

  /**
   * Temperature climbs to 34 C and holds. Against the intended 20-31 C range
   * this produces a WARNING then a CRITICAL (31 + 15% of 11 = 32.65 C).
   * Use it to show the alarm path, the persistent banner, and the Fix guidance.
   */
  warming: {
    description: "Temperature ramps to 34C -> warning then critical vs a 31C max.",
    base: { temperature: 25, water_level: 76, ammonia: 0.34 },
    noise: { temperature: 0.2, water_level: 1.2, ammonia: 0.03 },
    ramp: { parameter: "temperature", from: 25, to: 34, overCycles: 14 },
    bounds: {
      temperature: [20, 34.5],
      water_level: [55, 95],
      ammonia: [0.05, 0.9],
    },
    interval: 5000,
  },

  /**
   * Ammonia climbs past the 1.0 ppm limit into a hard critical (4.2 ppm).
   * Ammonia is the fastest-acting toxin for crayfish, so this is the scenario
   * that most clearly demonstrates why the persistent banner exists: the alert
   * must survive far longer than the 5-second floating toast.
   */
  ammonia_spike: {
    description: "Ammonia ramps to 4.2 ppm -> critical. Proves the alarm persists.",
    base: { temperature: 26, water_level: 80, ammonia: 0.32 },
    noise: { temperature: 0.2, water_level: 1.2, ammonia: 0.02 },
    ramp: { parameter: "ammonia", from: 0.32, to: 4.2, overCycles: 8 },
    bounds: {
      temperature: [22, 30],
      water_level: [60, 95],
      ammonia: [0.05, 4.5],
    },
    interval: 5000,
  },

  /**
   * Water level falls to 4%, below the 10% minimum -> warning then critical.
   */
  low_water: {
    description: "Water level falls to 4% -> breach of the 10% minimum.",
    base: { temperature: 27, water_level: 80, ammonia: 0.3 },
    noise: { temperature: 0.2, water_level: 1.2, ammonia: 0.03 },
    ramp: { parameter: "water_level", from: 80, to: 4, overCycles: 16 },
    bounds: {
      temperature: [22, 30],
      water_level: [2, 95],
      ammonia: [0.05, 0.9],
    },
    interval: 5000,
  },

  /**
   * The ammonia probe dies on cycle 8 and sends the -1 sentinel from then on.
   * The dashboard must show a grey "No signal" pill and an explanation, NOT an
   * amber "Warning" - a dead sensor is a hardware fault, not a water problem.
   */
  failed_ammonia: {
    description: "Ammonia probe fails at cycle 8 -> 'No signal', not a false warning.",
    base: { temperature: 27, water_level: 78, ammonia: 0.3 },
    noise: { temperature: 0.2, water_level: 1.2, ammonia: 0.03 },
    drift: { water_level: -0.05 },
    fail: { parameter: "ammonia", fromCycle: 8, sentinel: -1 },
    bounds: {
      temperature: [22, 30],
      water_level: [55, 95],
      ammonia: [0.05, 0.9],
    },
    interval: 5000,
  },

  /**
   * All three probes die at once (tank drained / ESP32 powered off mid-read).
   */
  all_sensors_fail: {
    description: "Every probe fails at cycle 5 -> three 'No signal' cards.",
    base: { temperature: 27, water_level: 78, ammonia: 0.3 },
    noise: { temperature: 0.2, water_level: 1.2, ammonia: 0.03 },
    fail: { parameter: "all", fromCycle: 5, sentinel: -1 },
    bounds: {
      temperature: [22, 30],
      water_level: [55, 95],
      ammonia: [0.05, 0.9],
    },
    interval: 5000,
  },

  /**
   * Posts normally, then goes silent after `stopAfterCycle` posts. The device
   * stays registered, so after the 30s heartbeat window the dashboard should
   * flip to the offline banner while still showing the last known readings.
   */
  disconnect: {
    description: "Posts 10 times then goes silent -> dashboard shows offline.",
    base: { temperature: 27.5, water_level: 76, ammonia: 0.32 },
    noise: { temperature: 0.25, water_level: 1.2, ammonia: 0.03 },
    drift: { temperature: 0.02, water_level: -0.05, ammonia: 0.001 },
    stopAfterCycle: 10,
    bounds: {
      temperature: [21, 30.5],
      water_level: [55, 95],
      ammonia: [0.05, 0.9],
    },
    interval: 5000,
  },

  /**
   * Two tanks posting in parallel on different profiles, so the fleet view,
   * the per-tank alarm badge, and the "N tanks affected" banner are exercised.
   * Requires two registered devices (see: node scripts/mock-device.js --list-devices).
   */
  fleet: {
    description: "ESP32_01 healthy + ESP32_02 warming, staggered.",
    devices: [
      { device_id: "ESP32_01", profile: "healthy", staggerMs: 0 },
      { device_id: "ESP32_02", profile: "warming", staggerMs: 2500 },
    ],
    interval: 5000,
  },

  /**
   * Ten tanks at once, one runner per device, staggered 1.5s apart so the whole
   * fleet is live after ~13.5s and they never post in lockstep. The mix is
   * deliberately uneven, because a fleet of ten identical healthy boards proves
   * far less than a fleet with one of each failure mode in it:
   *
   *   ESP32_01..06  healthy        - baseline, the tank selector and history
   *   ESP32_07      warming        - WARNING then CRITICAL on temperature
   *   ESP32_08      ammonia_spike  - critical toxin, fastest-acting alarm
   *   ESP32_09      failed_ammonia - "No signal" pill, must NOT read as a warning
   *   ESP32_10      disconnect     - goes silent after 10 posts -> offline banner
   *
   * This is what exercises the multi-tank surfaces: the "N tanks affected"
   * banner, the per-tank alarm badge, the Live Tank Bar, and the health
   * poller reaching its MAX_CONCURRENCY=10 ceiling (services/devicePoller.cjs:23)
   * in a single batch rather than two.
   *
   * Register all ten IDs on the Devices page FIRST if you want "Registered"
   * badges and real tank names; otherwise the first POST /sensor from each board
   * auto-creates the row and they show as "Auto-discovered" until claimed.
   */
  fleet10: {
    description: "Seven tanks: 3 healthy + warming + ammonia spike + dead probe + disconnect.",
    devices: [
      { device_id: "ESP32_04", profile: "healthy", staggerMs: 0 },
      { device_id: "ESP32_05", profile: "healthy", staggerMs: 1500 },
      { device_id: "ESP32_06", profile: "healthy", staggerMs: 3000 },
      { device_id: "ESP32_07", profile: "warming", staggerMs: 4500 },
      { device_id: "ESP32_08", profile: "ammonia_spike", staggerMs: 6000 },
      { device_id: "ESP32_09", profile: "failed_ammonia", staggerMs: 7500 },
      { device_id: "ESP32_10", profile: "disconnect", staggerMs: 9000 },
    ],
    interval: 5000,
  },
};

export default PROFILES;
