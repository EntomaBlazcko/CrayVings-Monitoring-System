//todo make sure the esp32 is running and connected to the code 
#include <Arduino.h>
#include <FS.h>
#include <TFT_eSPI.h>
#include <SPI.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ESPAsyncWebServer.h>
#include <AsyncTCP.h>
#include <math.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <esp_system.h>

// =============================================================================
// DISPLAY
// =============================================================================

TFT_eSPI tft = TFT_eSPI();

// =============================================================================
// TOUCH
// =============================================================================

#define TOUCH_CLK   32
#define TOUCH_CS    33
#define TOUCH_MOSI  22
#define TOUCH_MISO  19

SPIClass touchSPI(HSPI);

// XPT2046 commands
#define XPT2046_X   0xD0
#define XPT2046_Y   0x90
#define XPT2046_Z1  0xB1
#define XPT2046_Z2  0xC1

// =============================================================================
// TOUCH CALIBRATION
// =============================================================================

#define RAW_X_MIN 627
#define RAW_X_MAX 3589

#define RAW_Y_MIN 479
#define RAW_Y_MAX 3762

#define MIN_PRESSURE 40

// =============================================================================
// DS18B20
// =============================================================================

#define ONE_WIRE_BUS 13

OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

// =============================================================================
// HC-SR04 + WATER-LEVEL CALIBRATION
// =============================================================================
//
// The single source of truth for the water-level geometry is the TWO constants
// below. Every percentage the board computes or sends derives from them, and
// nothing else in this sketch hard-codes a water-level distance.
//
//   EMPTY_CM - distance from the sensor face DOWN to the water surface when the
//              tank is at its minimum level. A reading at or above this is 0%.
//              Specified as 23.5 cm.
//   FULL_CM  - distance from the sensor face DOWN to the water surface when the
//              tank is full. A reading at or below this is 100%.
//
//   level% = (EMPTY_CM - distance) / (EMPTY_CM - FULL_CM) * 100, clamped 0-100
//   Usable water depth = EMPTY_CM - FULL_CM. That span is the only thing the
//   percentage depends on.
//
// The tank's 36 cm wall height is a property of the VESSEL and is deliberately
// NOT part of this formula: the sensor is not mounted at the rim, so the
// rim-to-water distance is not the water depth. TANK_HEIGHT_CM and tankHeightCm
// were removed from the level calculation for exactly that reason.
//
// !! MEASURE FULL_CM ON THE REAL TANK BEFORE TRUSTING THE PERCENTAGE !!
// The value below is a PLACEHOLDER that only has to be in the right ballpark
// to keep the board reporting something sane. It is not calibrated. Put a ruler
// on the tank at maximum fill and record the sensor-to-surface distance, then
// edit this one line (or set it from the config portal / the dashboard's
// calibration endpoint, which needs no reflash at all).
#define WATER_EMPTY_CM 23.5f
#define WATER_FULL_CM  8.0f // <<< PLACEHOLDER - MEASURE THIS. Span = 15.5 cm.

// Pins: GPIO26 (TRIG) and GPIO27 (ECHO) are plain general-purpose I/O on the
// ESP32 DevKit V1 - not boot-strapping, not input-only. The input-only pins are
// GPIO34-39 (GPIO34 is already the MQ-137 ADC, correct for it), and GPIO6-11 are
// bound to the SPI flash. Verified against every pin claimed inside this sketch:
// GPIO13 = DS18B20, GPIO34 = MQ-137, GPIO19/22/32/33 = XPT2046 touch SPI,
// GPIO2 = safe-mode LED.
//
// NOT verified here: the TFT_eSPI display's own pins. They live in the
// Arduino library's User_Setup.h, which is installed on the machine that
// compiles the sketch and is not part of this repository, so this comment
// cannot claim which pins it claims. Check it once - if your build already
// works the display, 26/27 are free; the ILI9488 configs that people usually
// load for this board take 23/19/18/15 plus DC and RST, none of which is 26
// or 27.
//
// ECHO DRIVES 5V: a divider (1k series / 2k to GND -> 3.33V) MUST sit between
// the HC-SR04 ECHO pin and GPIO27. Without it the pin is over-driven and the
// board is a reboot away from being dead.
#define TRIG_PIN 26
#define ECHO_PIN 27

// Runtime calibration. Loaded from NVS (settable from the config portal without
// reflashing); falls back to the compiled-in constants above.
static float emptyDistanceCm = WATER_EMPTY_CM;
static float fullDistanceCm = WATER_FULL_CM;

// The HC-SR04 needs ~60ms between pings, so we deliberately do NOT sample
// back-to-back (that causes echo crosstalk / false readings). One ping per read
// (every 1s) instead, and the smoothing is a MEDIAN built across those reads.
#define DISTANCE_MEDIAN_WINDOW 5

// Deadband applied to the REPORTED percentage. Its job is to stop the board
// publishing a new number (and the server writing a new sensors row) for a
// change smaller than the server's own 1% delta tolerance. Set to 0 to report
// every single read.
#define WATER_LEVEL_DEADBAND_PCT 1.0f

// Consecutive invalid reads before the median window is flushed. A single
// dropped echo is routine on an HC-SR04 and must not reset the filter (that
// would make the level permanently laggy on a noisy link), but once the sensor
// is genuinely gone the stale samples must not survive it and be judged as
// fresh data after it comes back.
#define WATER_LEVEL_FAULT_FLUSH_READS 3

// Physical validity window for the HC-SR04. Anything outside is not a real
// reading (too close to resolve reliably, or beyond the module's usable range)
// and must never reach the filter, the median, or the formula.
#define DISTANCE_MIN_VALID_CM 2.0f
#define DISTANCE_MAX_VALID_CM 400.0f

// pulseIn() must have a timeout: with no echo it would otherwise block for the
// full 30ms on every read. A timeout returns 0, which is an INVALID reading and
// must never be turned into a percentage.
#define ECHO_TIMEOUT_US 30000UL

// Sliding window of valid distances, in arrival order, plus a scratch buffer for
// the median's sorted copy. Declared here, next to the calibration, so every
// function below can see them - the sketch relies on declaration-before-use
// because arduino-builder only auto-generates function prototypes.
float distanceWindow[DISTANCE_MEDIAN_WINDOW];
float distanceSorted[DISTANCE_MEDIAN_WINDOW];
int distanceWindowCount = 0;

float lastReportedLevel = -1.0f;
int consecutiveInvalidReads = 0;

// HC-SR04's two outputs, declared here with the code that produces them rather
// than in the generic SENSOR VALUES block below: every function in this section
// writes them, and they are the pair that must always agree with each other.
float distance = -1.0f;   // measured air gap, cm; -1 = failed
float waterLevel = -1.0f; // percentage 0-100; -1 = failed, never 0 or 100

// =============================================================================
// DISTANCE -> PERCENTAGE
// =============================================================================
//
// levelPercentFromDistance() is the ONLY place the percentage is computed, and
// levelDistanceFromPercent() is its exact inverse (used by the simulator so the
// virtual tank exercises the same arithmetic as the real one).
//
// Both refuse to work on an impossible calibration instead of dividing by zero
// or producing a sign-flipped span: EMPTY_CM must be strictly greater than
// FULL_CM, and FULL_CM must sit outside the sensor's 2 cm near-field dead zone.

float levelPercentFromDistance(float distanceCm)
{
    const float span = emptyDistanceCm - fullDistanceCm;
    const float pct = ((emptyDistanceCm - distanceCm) / span) * 100.0f;
    return constrain(pct, 0.0f, 100.0f);
}

float levelDistanceFromPercent(float percent)
{
    const float span = emptyDistanceCm - fullDistanceCm;
    return emptyDistanceCm - (percent / 100.0f) * span;
}

// median -> percentage -> deadband -> the two published globals.
//
// Shared by the real and simulated paths in readWaterLevel(). That sharing is the
// point: the simulator is only useful as a rehearsal if it runs the SAME
// filtering and the SAME deadband as the hardware, and duplicating this block
// once per path is exactly how the two would drift apart.
void publishWaterLevelFromMedian(float medianCm)
{
    distance = medianCm;
    const float level = levelPercentFromDistance(medianCm); // already clamped 0-100

    // Deadband: only publish a new percentage when it has actually moved by at
    // least WATER_LEVEL_DEADBAND_PCT. This keeps the reported value - and so the
    // server's 1% delta-logging - from churning on sub-percent noise. It is a
    // zero-order hold, not hysteresis, so there is no state that can latch.
    if (WATER_LEVEL_DEADBAND_PCT <= 0.0f ||
        lastReportedLevel < 0.0f ||
        fabsf(level - lastReportedLevel) >= WATER_LEVEL_DEADBAND_PCT)
    {
        lastReportedLevel = level;
    }

    waterLevel = lastReportedLevel;
}

// Guards against a mis-entered calibration (portal typo, NVS corruption) turning
// every reading into a divide-by-zero NaN or a nonsensical span. Called once per
// read: the cost is one comparison, the cost of NOT checking is a board that
// silently reports NaN% for the rest of the day.
bool waterCalibrationSane(void)
{
    if (!(emptyDistanceCm > fullDistanceCm))
    {
        Serial.printf("[HC-SR04] CALIBRATION INVALID: empty=%.2f cm must be > full=%.2f cm - water level unavailable\n",
                      emptyDistanceCm, fullDistanceCm);
        return false;
    }

    if (fullDistanceCm < DISTANCE_MIN_VALID_CM)
    {
        Serial.printf("[HC-SR04] CALIBRATION INVALID: full=%.2f cm is inside the %.0f cm near-field dead zone\n",
                      fullDistanceCm, DISTANCE_MIN_VALID_CM);
        return false;
    }

    return true;
}

// Median of the distances currently in the window. Works for ANY window size >=
// 1 (not just a full one), so the very first read after boot already produces a
// usable value instead of a 5-second "sensor error". The ACTION A/B state
// machine below is the thing that insists on a FULL window - see
// updateThresholdFromDistance().
//
// Sorting a copy leaves the arrival-order window intact.
float medianDistanceCm(void)
{
    if (distanceWindowCount < 1)
    {
        return -1.0f;
    }

    for (int i = 0; i < distanceWindowCount; i++)
    {
        distanceSorted[i] = distanceWindow[i];
    }

    // Insertion sort: 5 elements, and far cheaper in flash than pulling in
    // <algorithm> just for std::sort.
    for (int i = 1; i < distanceWindowCount; i++)
    {
        const float key = distanceSorted[i];
        int j = i - 1;
        while (j >= 0 && distanceSorted[j] > key)
        {
            distanceSorted[j + 1] = distanceSorted[j];
            j--;
        }
        distanceSorted[j + 1] = key;
    }

    return distanceSorted[distanceWindowCount / 2];
}

// Appends one valid reading to the sliding window and returns the new median
// (-1 only if the window is empty, which cannot happen here). Once full it is a
// true sliding window, so the median tracks slow drift as well as rejecting
// single outliers - one spurious long echo cannot move a median the way it can
// drag an EMA.
float pushDistanceSample(float sampleCm)
{
    if (distanceWindowCount < DISTANCE_MEDIAN_WINDOW)
    {
        distanceWindow[distanceWindowCount] = sampleCm;
        distanceWindowCount++;
    }
    else
    {
        for (int i = 0; i < DISTANCE_MEDIAN_WINDOW - 1; i++)
        {
            distanceWindow[i] = distanceWindow[i + 1];
        }
        distanceWindow[DISTANCE_MEDIAN_WINDOW - 1] = sampleCm;
    }

    return medianDistanceCm();
}

// Drops every buffered sample. Only called once the sensor has been invalid for
// WATER_LEVEL_FAULT_FLUSH_READS consecutive reads - see the note there.
void flushDistanceWindow(void)
{
    distanceWindowCount = 0;
}

// =============================================================================
// EMPTY-TANK THRESHOLD (ACTION A / ACTION B)
// =============================================================================
//
// This is the "is the tank dry?" switch, and it is NOT the same thing as the
// reported percentage. It fires when the measured distance is at or beyond the
// EMPTY reference - i.e. at or beyond emptyDistanceCm (23.5 cm), where the
// reported percentage is 0%. It used to carry its own hard-coded 23.5
// (THRESHOLD_CM); it now derives from the calibration, so there is exactly one
// place in this sketch where that number is written down.
//
// Why this is NOT a burst of five pings inside readWaterLevel(): the module
// needs ~60ms between pings, and readWaterLevel() already fires once per second.
// Five back-to-back pings would (a) violate that spacing, producing exactly the
// crosstalk it warns about, and (b) block the loop for up to ~150ms, which would
// stall the touchscreen and the watchdog.
//
// Instead the MEDIAN is built across five SUCCESSIVE 1 Hz reads. One new sample
// lands per second, so the spacing rule holds, nothing blocks, and after the
// first five seconds we get a true median.

// The old window-full-only medianDistanceCm() that lived here has been replaced
// by the any-window-size version up in the DISTANCE -> PERCENTAGE block, so
// there is exactly one median implementation and the reported percentage and
// the ACTION state machine cannot drift apart.

// Which side of the minimum water line the tank is on.
//
// Read the names against the GEOMETRY, not against the word "within": the sensor
// is mounted ABOVE the water looking down, so a LARGER distance means LESS water.
// That inversion is the whole reason this enum is spelled out in comments - the
// obvious reading of these two names is backwards.
//
//   THRESHOLD_BEYOND - measured distance at or beyond emptyDistanceCm (23.5 cm),
//                      i.e. at or past the 0% reference. Dry: the tank is at or
//                      below its minimum water line -> ACTION A.
//   THRESHOLD_WITHIN - measured distance below emptyDistanceCm, i.e. water is
//                      closer than the 0% reference. The tank is above its
//                      minimum water line -> ACTION B.
enum ThresholdState
{
    THRESHOLD_BEYOND, // distance >= empty reference -> dry  -> ACTION A
    THRESHOLD_WITHIN  // distance <  empty reference -> wet  -> ACTION B
};

// Boots as the dry state, and updateThresholdFromDistance() will not evaluate
// anything until the median window has filled. So this default means a tank that
// is genuinely dry produces NO action line at all, rather than firing a dry alert
// before the board has measured anything. A wet tank logs its actual state on the
// first full window, which is the useful direction for a startup banner.
static ThresholdState thresholdState = THRESHOLD_BEYOND;

// =============================================================================
// ACTION A / ACTION B
// =============================================================================
//
// These are deliberately STUBS. The threshold state machine below is complete and
// correct, but what physically happens on a transition is application-specific,
// and guessing at it would risk driving a pin the firmware already owns - GPIO2
// is already SAFE_LED_PIN (watchdog blink), so it must not be reused here.
//
// ACTION A  - the tank is AT OR BELOW its minimum water line: measured distance
//             at or beyond emptyDistanceCm (23.5 cm by default), reported
//             percentage at or near 0%. This is the dry-tank alert.
// ACTION B  - the tank is ABOVE its minimum water line: measured distance below
//             emptyDistanceCm, reported percentage above 0%.
//
// To wire up real hardware, put the actuator code in the two bodies below and
// call pinMode()/digitalWrite() from setup() or on first use. Until then both
// actions report on Serial only, so the logic is testable with no extra wiring.
void actionA(void)
{
    Serial.println("[ACTION A] Tank at/below minimum water line");
    // TODO: real ACTION A here (LED / relay / buzzer), on a free GPIO.
}

void actionB(void)
{
    Serial.println("[ACTION B] Tank above minimum water line");
    // TODO: real ACTION B here.
}

// Fires actionA()/actionB() only on an actual state change, so a steady reading
// does not spam the log. Called with the new state.
//
// The mapping below is the load-bearing part: BEYOND (distance at/beyond the
// empty reference = least water) must raise the DRY alert ACTION A, and WITHIN
// (water closer than the empty reference) must raise ACTION B. Getting these two
// the wrong way round reports "tank at/below minimum water line" on a full tank
// and "above minimum" on a dry one, which is worse than not reporting at all.
void applyThresholdAction(ThresholdState next)
{
    if (next == thresholdState)
    {
        return;
    }

    thresholdState = next;

    if (next == THRESHOLD_BEYOND)
    {
        actionA();
    }
    else
    {
        actionB();
    }
}

// Hysteresis band totalling ~0.5 cm around the empty reference. Measured
// distance has to cross the WHOLE band before the state flips, so a reading
// sitting exactly on the reference cannot oscillate ACTION A / ACTION B. Half
// the band sits on each side of emptyDistanceCm. These are runtime expressions
// rather than #defines because emptyDistanceCm is loaded from NVS at boot.
//
// Named for the state each edge PROVES, because the sensor-above-the-water
// geometry means the wet edge is the SMALLER distance:
//
//   WATER_WET_EDGE_CM  (23.25 by default) - distance has to fall to here (or
//                        below) before the tank is called wet. Below it there is
//                        demonstrably more water than the 0% reference.
//   WATER_DRY_EDGE_CM  (23.75 by default) - distance has to rise to here (or
//                        above) before the tank is called dry. Above it there is
//                        demonstrably less water than the 0% reference.
//
// A median anywhere in between holds whatever state it is already in, which is
// what stops the dry alert chattering on a surface sitting right at 23.5 cm.
#define THRESHOLD_HYSTERESIS_CM 0.5f
#define WATER_WET_EDGE_CM (emptyDistanceCm - (THRESHOLD_HYSTERESIS_CM / 2.0f))
#define WATER_DRY_EDGE_CM (emptyDistanceCm + (THRESHOLD_HYSTERESIS_CM / 2.0f))

// Re-evaluates the empty-tank threshold against the current median.
//
// The window push is NOT done here any more: pushDistanceSample() owns the
// window, because the reported percentage and this state machine must both
// judge the SAME filtered distance. Two filters on one physical quantity is how
// they drift apart.
//
// `fromSimulation` only changes the wording of the log line; the arithmetic is
// identical, so simulated and real readings exercise the same state machine.
//
// On a timeout or an out-of-range reading this must NOT be called at all, which
// is why the caller returns early - an invalid sample neither enters the window
// nor moves the state. That is what stops a dropped echo from clearing an active
// action.
void updateThresholdFromDistance(float medianCm, bool fromSimulation)
{
    if (medianCm < 0.0f)
    {
        return;
    }

    // The action only fires once the window has actually filled. The reported
    // percentage does not wait for that (see medianDistanceCm()), but an
    // ACTION must not be driven by a single unconfirmed sample.
    if (distanceWindowCount < DISTANCE_MEDIAN_WINDOW)
    {
        // Report progress once so a 5-second wait at boot is not mistaken for a
        // dead sensor.
        if (distanceWindowCount == 1)
        {
            Serial.printf("[HC-SR04] Priming median window %d/%d (empty reference %.1f cm)\n",
                          distanceWindowCount,
                          DISTANCE_MEDIAN_WINDOW,
                          emptyDistanceCm);
        }
        return;
    }

    // Hysteresis, not a bare comparison against emptyDistanceCm. From the dry
    // state the tank is only called WET once the median has fallen below the wet
    // edge; from the wet state it is only called DRY once the median has risen
    // above the dry edge. Between the edges the state is held, so a median parked
    // on the reference cannot oscillate.
    if (thresholdState == THRESHOLD_BEYOND)
    {
        if (medianCm <= WATER_WET_EDGE_CM)
        {
            applyThresholdAction(THRESHOLD_WITHIN);
        }
    }
    else
    {
        if (medianCm >= WATER_DRY_EDGE_CM)
        {
            applyThresholdAction(THRESHOLD_BEYOND);
        }
    }

    Serial.printf("[HC-SR04]%s median %.2f cm | empty ref %.2f cm | full ref %.2f cm | state %s\n",
                  fromSimulation ? " [SIM]" : "",
                  medianCm,
                  emptyDistanceCm,
                  fullDistanceCm,
                  thresholdState == THRESHOLD_BEYOND
                      ? "BEYOND ref = dry (ACTION A)"
                      : "WITHIN ref = wet (ACTION B)");
}

// Marks the HC-SR04 as failed for this read.
//
// A failed read must NOT become a percentage. It becomes -1, which is the wire
// sentinel the backend turns into NULL, and the dashboard renders as "--". It
// must never become 0% (an empty tank) or 100% (a full one): those are real
// values that mean something, and faking one of them hides a dry tank.
//
// The threshold state is deliberately left alone: a timeout means "do not know",
// not "the object moved away", so the action must not be cleared on missing
// data.
void invalidateWaterLevel(const char *why)
{
    distance = -1.0f;
    waterLevel = -1.0f;
    lastReportedLevel = -1.0f; // so the first good read after recovery is published

    consecutiveInvalidReads++;
    if (consecutiveInvalidReads == WATER_LEVEL_FAULT_FLUSH_READS)
    {
        flushDistanceWindow();
    }

    Serial.printf("[HC-SR04] Invalid reading (%s) | %d consecutive | holding state %s\n",
                  why,
                  consecutiveInvalidReads,
                  thresholdState == THRESHOLD_BEYOND
                      ? "BEYOND ref = dry (ACTION A)"
                      : "WITHIN ref = wet (ACTION B)");
}

// =============================================================================
// MQ-137 AMMONIA (NH3) GAS SENSOR
// =============================================================================
//
// Measures real ammonia gas concentration (ppm in AIR) from the module's analog
// output using the standard MQ-series chemiresistor model:
//
//   Vout = Vc * RL / (Rs + RL)            ->   Rs = RL * (Vc/Vout - 1)
//   ppm  = 10^((log10(Rs/R0) - b) / m)
//
// R0 is the sensor resistance in clean air. Rs and R0 both come from the same
// divider formula, so their RATIO is largely insensitive to the exact RL/Vc you
// assume -- but keep them close to reality (serial prints Rs; clean air should
// read tens of kOhm). Calibration curve (NH3) fitted from the MQ-137 datasheet
// (widely published): m = -0.263, b = 0.42, clean-air ratio Rs/R0 = 3.6.
//
// 3.3V ADC WARNING: GPIO34 is clamped at ~3.3V while the module AO is a 0-5V
// divider. With the most common module RL (1kOhm SMD) the whole 5-500ppm NH3
// range stays below 3.3V. If your module uses RL=47kOhm the output saturates at
// moderate ppm -- readings are then clamped and flagged on serial. Measure your
// RL (multimeter between module VCC and AOUT) and fix MQ137_RL_KOHM below.
#define MQ137_PIN 34

#define MQ137_RL_KOHM   10.0   // Load resistor on this module (kOhm). Marked "103" = 10k
#define MQ137_VC_VOLTS  5.0    // Sensor circuit supply (module VCC; usually 5V)

#define MQ137_CURVE_M   -0.263 // NH3 log-log slope:      log(Rs/R0) = m*log(ppm) + b
#define MQ137_CURVE_B   0.42   // NH3 log-log intercept b
#define MQ137_CLEAN_AIR_RATIO 3.6  // Rs/R0 expected in clean air (datasheet)
#define MQ137_PPM_MAX   500.0  // Datasheet NH3 range upper bound (5-500 ppm)
#define MQ137_SAT_VOLTS 3.24   // ADC saturation threshold (11dB attenuation ~3.3V)
#define MQ137_EMA_ALPHA 0.4    // Smoothing factor for the displayed ppm (0.4 = fast response)
#define MQ137_PPM_DEADBAND 0.1 // Don't repaint unless ppm changes by this much
#define MQ137_SPIKE_PPM_MAX 25.0 // Max ppm jump allowed before spike rejection kicks in
#define MQ137_ADC_SAMPLES 8   // Number of ADC samples to average per read

float mq137R0 = 0.0;        // Sensor resistance in clean air (kOhm), persisted in NVS
float mq137RsKohm = 0.0;    // Latest computed sensor resistance (kOhm, diagnostics)
float mq137Ratio = 0.0;     // Latest Rs/R0 (diagnostics)
float ammoniaPpm = -1.0;    // Computed NH3 concentration (ppm); -1 = sensor failed
float mq137PpmEma = -1.0;   // Smoothed ppm
float lastShownPpm = -1.0;  // Last ppm painted to the screen (deadbanded)
bool ammoniaReady = false;  // True once a valid reading has been produced
int mq137SpikeStreak = 0;   // Consecutive spike count for spike rejection

// Self-healing R0 retry. If the clean-air calibration never produced a usable R0
// (module not fitted at boot, unpowered, or the sensor drifted out of the sane
// window), the ammonia page used to sit on ERROR forever with no path back
// except a reflash. Instead, quietly re-probe on a long interval. Capped so a
// genuinely absent module costs a handful of serial lines over ~an hour rather
// than an endless retry loop, and skipped entirely in simulation.
#define MQ137_RECAL_RETRY_MS  240000UL
#define MQ137_RECAL_MAX_TRIES 12

unsigned long lastMq137RecalMs = 0;
int mq137RecalTries = 0;

// =============================================================================
// SENSOR VALUES
// =============================================================================

float temperature = -127.0;
// `distance` and `waterLevel` are declared up in the HC-SR04 calibration block,
// next to the code that owns them. They used to be initialised to -1.0 and 0.0
// here; 0.0 was wrong: with the calibrated formula a 0% level is a real,
// actionable value (an empty tank), so a fresh boot - or a tank with no sensor
// attached - would report a dry tank instead of a failed sensor.
int mq137Raw = 0;
float mq137Voltage = 0.0;

// =============================================================================
// FAILURE HANDLING (Watchdog / Safe Mode)
// =============================================================================

#define SAFE_LED_PIN 2   // Onboard LED on most ESP32 dev boards; safe to toggle

bool safeModeActive = false;    // Set after a watchdog reset; cleared on recovery
bool safeModeRecovered = false; // Loop redraws the normal UI once set
float lastGoodTemperature = -127.0;  // Last-known-good snapshot for Safe Mode
// -1 = "never had a good reading", matching the live sentinels, so Safe Mode
// cannot present a fabricated 0% as the last known good level.
float lastGoodWaterLevel = -1.0;
float lastGoodAmmonia = -1.0;
unsigned long lastGoodMillis = 0;
bool safeLedOn = false;
unsigned long lastSafeBlinkMs = 0;

// NVS wear budget for the Safe Mode snapshot. The old change-only check used a
// single 0.01 epsilon for all three values, which is 6x FINER than one LSB of
// the DS18B20 itself (0.0625 C) - so temperature alone tripped it on every
// single 1 Hz read, i.e. ~86k flash writes a day, and the 'safe' NVS page wears
// out in a couple of months. The snapshot is now both rate-limited and compared
// per-sensor with epsilons still finer than what the Safe Mode screen renders.
#define SAFE_SNAPSHOT_MIN_INTERVAL_MS 30000UL
#define SAFE_SNAPSHOT_EPS_TEMP    0.1f
#define SAFE_SNAPSHOT_EPS_LEVEL   0.5f
#define SAFE_SNAPSHOT_EPS_AMMONIA 0.05f

unsigned long lastSnapshotSaveMs = 0;

// WiFi reconnection backoff (1s, 2s, 4s, ... capped at 5 min).
unsigned long wifiBackoffMs = 1000;
unsigned long lastWifiAttemptMs = 0;
int wifiFailStreak = 0;

// =============================================================================
// PAGES
// =============================================================================

#define PAGE_OVERVIEW     0
#define PAGE_TEMPERATURE  1
#define PAGE_WATER_LEVEL  2
#define PAGE_AMMONIA      3

#define PAGE_COUNT 4

int currentPage = PAGE_OVERVIEW;

// =============================================================================
// DISPLAY CACHING (water level page)
// Tracks what is on screen so updates only repaint changed pixels
// =============================================================================

char lastLevelText[30] = "";
int lastBarWidth = -1;

// =============================================================================
// TIMING
// =============================================================================

unsigned long lastSensorRead = 0;
#define SENSOR_INTERVAL 1000

// =============================================================================
// TOUCH STATE
// =============================================================================

bool touching = false;
bool navButtonHighlighted = false; // True while an arrow button shows its pressed state
uint16_t lastTouchX = 0;
uint16_t lastTouchY = 0;
unsigned long lastPageChange = 0;
#define PAGE_CHANGE_COOLDOWN 500

// =============================================================================
// WIFI & BACKEND CONFIG
// =============================================================================

#define DEVICE_ID_DEFAULT "ESP32_01"

// Device ID contract - MUST stay in step with the dashboard's registration
// schema (server.cjs createDeviceSchema / DevicesPage deviceFormSchema):
//   /^[A-Za-z0-9._-]+$/ and at most 50 characters.
//
// Why this is enforced on the BOARD and not just in the web form: POST /sensor
// accepts any string up to 50 characters and auto-registers it. A board
// configured with an ID the dashboard cannot accept ("Tank 1!", a slash, a
// space) would report forever under an identity the Owner can never register,
// rename into place, or ever reuse - a junk row holding the tank's readings
// that can only be archived. Rejecting it here keeps the two sides in one
// contract, and the board says why instead of failing silently.
#define DEVICE_ID_MAX_LEN 50

// Backend IP when no portal override has been saved. If serverIP is still this
// placeholder after the device connects to WiFi, autoDeriveServerIp() rewrites
// it to the WiFi subnet + SERVER_IP_HOST_OCTET (e.g. on 192.168.1.x it becomes
// 192.168.1.10). Change SERVER_IP_HOST_OCTET to your server's host octet, or
// enter the real IP in the config portal.
#define SERVER_IP_DEFAULT "192.168.4.10"
#define SERVER_IP_HOST_OCTET 10

#define SERVER_PORT_DEFAULT "3000"
#define SEND_INTERVAL 1000

char serverIP[50] = SERVER_IP_DEFAULT;
char serverPort[10] = SERVER_PORT_DEFAULT;
char deviceId[DEVICE_ID_MAX_LEN + 1] = DEVICE_ID_DEFAULT;
char deviceSecret[100] = "";

// Optional static IP config (192.168.4.x star topology). When configured the
// values are persisted to NVS ("config" namespace) and applied with
// WiFi.config() before the connection attempt. Blank portal fields = DHCP.
IPAddress staticIp;
IPAddress staticGateway;
IPAddress staticSubnet;
bool staticIpConfigured = false;

unsigned long lastSendTime = 0;
bool wifiConnected = false;

// Background-send flags: the blocking HTTP POST runs on its own task so it
// can never stall the main loop (and therefore the touchscreen).
volatile bool sendPending = false;
volatile bool sendBusy = false;

// Flag to trigger WiFi configuration
bool wifiConfigRequested = false;

// Drop-proofing: past readings that fail to POST are held in a ring buffer
// and flushed oldest-first once the link / server is back (~10 min at 1 Hz).
#define SEND_BUFFER_CAP 600

typedef struct
{
    float temp;
    float level;
    float ammonia;
    // Raw HC-SR04 distance (cm) alongside the percentage. The distance is the
    // only value that can be re-calibrated after the fact: a wrong EMPTY_CM /
    // FULL_CM pair can be corrected server-side from the stored distance, whereas
    // a stored percentage has already lost the information needed to fix it.
    float distance;
} BufferedReading;

BufferedReading sendBuf[SEND_BUFFER_CAP];
int sendBufWrite = 0;
int sendBufRead = 0;
int sendBufCount = 0;

bool sendBufPush(float temp, float level, float ammonia, float distance)
{
    if (sendBufCount >= SEND_BUFFER_CAP)
    {
        // Full ring: drop the oldest so the freshest readings survive.
        sendBufRead = (sendBufRead + 1) % SEND_BUFFER_CAP;
        sendBufCount--;
    }

    sendBuf[sendBufWrite].temp = temp;
    sendBuf[sendBufWrite].level = level;
    sendBuf[sendBufWrite].ammonia = ammonia;
    sendBuf[sendBufWrite].distance = distance;
    sendBufWrite = (sendBufWrite + 1) % SEND_BUFFER_CAP;
    sendBufCount++;
    return true;
}

// Reads the oldest buffered reading out of the ring.
//
// The three out-params are plain floats rather than a BufferedReading& on
// purpose. arduino-builder auto-generates prototypes for functions used before
// they are defined, and its generator mis-parses any signature mentioning a
// type declared later in the sketch: it emits "bool sendBufPop" (splitting at
// the "("), which the compiler then rejects with "'BufferedReading' was not
// declared in this scope" and "'sendBufPop' cannot be used as a function".
// Keeping user-defined types out of every signature sidesteps the generator
// entirely. sendBuf[] stays a BufferedReading[] - a global array type never
// reaches a prototype.
bool sendBufPop(float &tempOut, float &levelOut, float &ammoniaOut, float &distanceOut)
{
    if (sendBufCount == 0)
    {
        return false;
    }

    tempOut = sendBuf[sendBufRead].temp;
    levelOut = sendBuf[sendBufRead].level;
    ammoniaOut = sendBuf[sendBufRead].ammonia;
    distanceOut = sendBuf[sendBufRead].distance;

    sendBufRead = (sendBufRead + 1) % SEND_BUFFER_CAP;
    sendBufCount--;
    return true;
}

// =============================================================================
// NVS SYSTEM CONFIG (persisted so portal values survive reboots)
// =============================================================================

void loadStaticIpConfig()
{
    Preferences prefs;
    prefs.begin("config", true);
    if (prefs.getBool("static_cfg", false))
    {
        staticIp = IPAddress(prefs.getUInt("static_ip", 0));
        staticGateway = IPAddress(prefs.getUInt("static_gw", 0));
        staticSubnet = IPAddress(prefs.getUInt("static_mask", 0));
        staticIpConfigured = true;
    }
    prefs.end();
}

void saveStaticIpConfig(bool enabled, IPAddress ip, IPAddress gw, IPAddress mask)
{
    Preferences prefs;
    prefs.begin("config", false);
    prefs.putBool("static_cfg", enabled);
    if (enabled)
    {
        prefs.putUInt("static_ip", (uint32_t)ip);
        prefs.putUInt("static_gw", (uint32_t)gw);
        prefs.putUInt("static_mask", (uint32_t)mask);
    }
    prefs.end();
}

void applyStaticIpConfig()
{
    if (staticIpConfigured)
    {
        WiFi.config(staticIp, staticGateway, staticSubnet);
        Serial.print("[WIFI] Static IP configured: ");
        Serial.println(staticIp.toString());
    }
}

// The dashboard accepts only [A-Za-z0-9._-] in a device_id (see
// DEVICE_ID_MAX_LEN above). Deliberately hand-rolled rather than isalnum()/
// isxdigit(), whose behaviour depends on the C locale, and deliberately
// ASCII-only so a non-ASCII byte can never slip through on one toolchain and
// not another.
bool deviceIdCharAllowed(char c)
{
    unsigned char u = (unsigned char)c;
    return (u >= 'A' && u <= 'Z') ||
           (u >= 'a' && u <= 'z') ||
           (u >= '0' && u <= '9') ||
           c == '.' || c == '_' || c == '-';
}

// Returns true when `candidate` was accepted. A rejected candidate leaves
// `deviceId` untouched and prints the reason, so the operator sees on the serial
// monitor exactly why their entry did not stick.
//
// The previous version strncpy'd first and validated the empty case afterwards.
// That silently truncated anything past the buffer - a 50-character ID, which
// the dashboard accepts, became a different 49-character identity here - and it
// accepted spaces, punctuation and any other character the dashboard would then
// refuse at registration time.
bool applyDeviceIdCandidate(String candidate, const char* fallback)
{
    candidate.trim();

    if (candidate.length() == 0)
    {
        // Clearing the field must never post an empty device_id: that would
        // auto-register a junk device on the server. Fall back to whatever the
        // caller says this board was using, defaulting to the compiled-in one.
        const char *keep = (fallback && fallback[0] != '\0') ? fallback : DEVICE_ID_DEFAULT;
        strncpy(deviceId, keep, sizeof(deviceId) - 1);
        deviceId[sizeof(deviceId) - 1] = '\0';
        Serial.printf("[CONFIG] Device ID was blank; keeping '%s'\n", deviceId);
        return false;
    }

    if (candidate.length() > DEVICE_ID_MAX_LEN)
    {
        Serial.printf("[CONFIG] REJECTED device ID '%s': %u characters, the dashboard allows at most %d.\n",
                      candidate.c_str(), (unsigned)candidate.length(), DEVICE_ID_MAX_LEN);
        Serial.println("[CONFIG] Keeping the previous device ID. Shorten it, or change it on the dashboard's Devices page.");
        return false;
    }

    for (unsigned i = 0; i < candidate.length(); i++)
    {
        if (!deviceIdCharAllowed(candidate[i]))
        {
            Serial.printf("[CONFIG] REJECTED device ID '%s': '%c' is not allowed at position %u.\n",
                          candidate.c_str(), candidate[i], i + 1);
            Serial.println("[CONFIG] Use only letters, numbers, dots, dashes and underscores (e.g. ESP32_01).");
            Serial.printf("[CONFIG] Keeping the previous device ID ('%s').\n", deviceId);
            return false;
        }
    }

    strncpy(deviceId, candidate.c_str(), sizeof(deviceId) - 1);
    deviceId[sizeof(deviceId) - 1] = '\0';

    Serial.printf("[CONFIG] Device ID set to '%s'\n", deviceId);
    return true;
}

void loadSystemConfig()
{
    Preferences prefs;
    prefs.begin("config", true);

    String val = prefs.getString("server_ip", SERVER_IP_DEFAULT);
    strncpy(serverIP, val.c_str(), sizeof(serverIP) - 1);
    serverIP[sizeof(serverIP) - 1] = '\0';

    val = prefs.getString("server_port", SERVER_PORT_DEFAULT);
    strncpy(serverPort, val.c_str(), sizeof(serverPort) - 1);
    serverPort[sizeof(serverPort) - 1] = '\0';

    // Device ID can now be set via config portal; fall back to compiled-in default.
    val = prefs.getString("device_id", DEVICE_ID_DEFAULT);
    applyDeviceIdCandidate(val, DEVICE_ID_DEFAULT);

    val = prefs.getString("device_secret", "");
    strncpy(deviceSecret, val.c_str(), sizeof(deviceSecret) - 1);
    deviceSecret[sizeof(deviceSecret) - 1] = '\0';

    // Water-level calibration. Falls back to the compiled-in constants, so a
    // board that has never opened the config portal still reports on a sane
    // scale. A stored value that fails waterCalibrationSane() (typo in the
    // portal, corrupted NVS) is discarded rather than trusted - a board stuck
    // reporting NaN% is worse than one reporting the default span.
    emptyDistanceCm = prefs.getFloat("empty_cm", WATER_EMPTY_CM);
    fullDistanceCm = prefs.getFloat("full_cm", WATER_FULL_CM);
    if (emptyDistanceCm <= 0.0f || fullDistanceCm <= 0.0f ||
        emptyDistanceCm <= fullDistanceCm)
    {
        Serial.printf("[CONFIG] Stored water calibration (empty=%.2f full=%.2f) is unusable - reverting to defaults (%.1f / %.1f)\n",
                      emptyDistanceCm, fullDistanceCm, WATER_EMPTY_CM, WATER_FULL_CM);
        emptyDistanceCm = WATER_EMPTY_CM;
        fullDistanceCm = WATER_FULL_CM;
    }

    prefs.end();
    loadStaticIpConfig();

    Serial.printf("[CONFIG] server=%s:%s device_id=%s water_empty=%.2fcm water_full=%.2fcm static_ip=%s\n",
                  serverIP, serverPort, deviceId, emptyDistanceCm, fullDistanceCm,
                  staticIpConfigured ? "yes" : "no");
}

void saveSystemConfig()
{
    Preferences prefs;
    prefs.begin("config", false);
    prefs.putString("server_ip", serverIP);
    prefs.putString("server_port", serverPort);
    prefs.putString("device_id", deviceId);
    prefs.putString("device_secret", deviceSecret);
    prefs.putFloat("empty_cm", emptyDistanceCm);
    prefs.putFloat("full_cm", fullDistanceCm);
    prefs.end();
}

// If the backend IP has never been set through the config portal (serverIP is
// still the SERVER_IP_DEFAULT placeholder), derive it from the network the ESP32
// actually connected to: same subnet as the device's WiFi IP, host octet
// SERVER_IP_HOST_OCTET. This makes the firmware "just work" on any LAN where the
// server sits at <wifi-subnet>.10 (192.168.4.10, 192.168.1.10, 10.0.0.10, ...).
// A portal-saved explicit IP always wins because serverIP no longer equals the
// placeholder.
// The backend address is published by the config portal and by autoDeriveServerIp()
// (both on the Arduino loop task) and read by sendSensorData() (its own task, which
// the scheduler may place on the other core). Unlocked, that send task could observe
// a half-updated pair - new IP with old port, or a string still mid-strncpy - and
// POST every reading to a garbage URL. All cross-task access therefore goes through
// these two helpers, so each side always sees a consistent snapshot.
portMUX_TYPE serverAddrMux = portMUX_INITIALIZER_UNLOCKED;

void publishServerAddress(const char *ip, const char *port)
{
    portENTER_CRITICAL(&serverAddrMux);
    strncpy(serverIP, ip, sizeof(serverIP) - 1);
    serverIP[sizeof(serverIP) - 1] = '\0';
    strncpy(serverPort, port, sizeof(serverPort) - 1);
    serverPort[sizeof(serverPort) - 1] = '\0';
    portEXIT_CRITICAL(&serverAddrMux);
}

void copyServerAddress(char *ipOut, size_t ipLen, char *portOut, size_t portLen)
{
    portENTER_CRITICAL(&serverAddrMux);
    strncpy(ipOut, serverIP, ipLen - 1);
    ipOut[ipLen - 1] = '\0';
    strncpy(portOut, serverPort, portLen - 1);
    portOut[portLen - 1] = '\0';
    portEXIT_CRITICAL(&serverAddrMux);
}

void autoDeriveServerIp()
{
    char derived[sizeof(serverIP)] = SERVER_IP_DEFAULT;
    bool published = false;

    IPAddress local = WiFi.localIP();
    if (local != IPAddress(0, 0, 0, 0))
    {
        snprintf(derived, sizeof(derived), "%d.%d.%d.%d",
                 local[0], local[1], local[2], SERVER_IP_HOST_OCTET);
    }

    // Re-check the placeholder *inside* the lock: a portal value saved a moment
    // ago always wins, otherwise this would overwrite the explicit IP.
    portENTER_CRITICAL(&serverAddrMux);
    if (strcmp(serverIP, SERVER_IP_DEFAULT) == 0 && derived[0] != '\0')
    {
        strncpy(serverIP, derived, sizeof(serverIP) - 1);
        serverIP[sizeof(serverIP) - 1] = '\0';
        published = true;
    }
    portEXIT_CRITICAL(&serverAddrMux);

    if (published)
    {
        Serial.printf("[WIFI] Backend IP auto-derived from WiFi: %s\n", derived);
    }
}

// =============================================================================
// VIRTUAL TANK / HEADLESS MODE
// Runtime flags (persisted in NVS "config" namespace), toggled with Serial
// Monitor commands:
//   S = simulate (virtual tank): report synthetic readings instead of reading
//                                the real sensors. Use on a bare board with no
//                                DS18B20/HC-SR04/MQ-137 attached.
//   H = headless: skip TFT + touch init and all screen drawing. Use on a bare
//                 dev kit with no display, so a floating touch panel can never
//                 register phantom taps or launch the config portal.
// Both flags default OFF (real sensors + full UI) so an ordinary flash of the
// real tank stays identical.
// =============================================================================

bool simulateDevice = false; // true = virtual tank (no sensors attached)
bool headlessMode = false;   // true = no TFT / touch attached (skip display UI)

// Synthetic reading state for the virtual tank. The random-walk step sizes are
// chosen to exceed the server's delta-logging tolerances (0.1C / 1% / 0.05ppm)
// so the dashboard charts keep collecting live rows, while the values stay
// inside safe thresholds so no false alerts fire.
float simTemp = 27.0;
float simLevel = 75.0;
float simAmmonia = 0.5;

void loadDeviceModes()
{
    Preferences prefs;
    prefs.begin("config", true);
    simulateDevice = prefs.getBool("simulate", false);
    headlessMode = prefs.getBool("headless", false);
    prefs.end();

    Serial.printf("[MODE] simulate=%s headless=%s\n",
                  simulateDevice ? "ON (virtual tank)" : "OFF (real sensors)",
                  headlessMode ? "ON (no display)" : "OFF");
}

void saveDeviceModes()
{
    Preferences prefs;
    prefs.begin("config", false);
    prefs.putBool("simulate", simulateDevice);
    prefs.putBool("headless", headlessMode);
    prefs.end();
}

// =============================================================================
// DISPLAY
// =============================================================================

#define SCREEN_W 480
#define SCREEN_H 320

// =============================================================================
// TOUCH RAW READING
// =============================================================================

uint16_t readTouchRaw(uint8_t command)
{
    uint16_t value;

    digitalWrite(TOUCH_CS, LOW);

    touchSPI.beginTransaction(
        SPISettings(
            2000000,
            MSBFIRST,
            SPI_MODE0
        )
    );

    touchSPI.transfer(command);
    value = touchSPI.transfer16(0x0000);
    touchSPI.endTransaction();
    digitalWrite(TOUCH_CS, HIGH);
    value >>= 3;
    return value;
}

// Sample a touch axis repeatedly and return the average (reduces noise)
uint16_t readTouchSample(uint8_t command, int samples)
{
    // Discard the first read after a channel change: the XPT2046 first sample
    // can still contain the previous channel's data.
    readTouchRaw(command);

    uint32_t total = 0;
    for (int i = 0; i < samples; i++)
    {
        total += readTouchRaw(command);
    }
    return (uint16_t)(total / samples);
}

// =============================================================================
// TOUCH PRESSURE
// =============================================================================

bool isTouchPressed()
{
    uint16_t z1;
    uint16_t z2;

    digitalWrite(TOUCH_CS, LOW);
    touchSPI.beginTransaction(
        SPISettings(
            2000000,
            MSBFIRST,
            SPI_MODE0
        )
    );

    touchSPI.transfer(XPT2046_Z1);
    z1 = touchSPI.transfer16(0x0000);
    z1 >>= 3;

    touchSPI.transfer(XPT2046_Z2);
    z2 = touchSPI.transfer16(0x0000);
    z2 >>= 3;

    touchSPI.endTransaction();
    digitalWrite(TOUCH_CS, HIGH);

    // Lower-bound check is only applied to Z1 (the primary pressure axis).
    // Some panels report a low/near-zero Z2 while pressed, so requiring
    // Z2 > MIN_PRESSURE wrongly rejected valid touches.
    if (
        z1 > MIN_PRESSURE &&
        z1 < 4000 &&
        z2 > 0 &&
        z2 < 4000
    )
    {
        return true;
    }

    return false;
}

// =============================================================================
// GET TOUCH POSITION
// =============================================================================

bool getTouchPosition(
    uint16_t &screenX,
    uint16_t &screenY
)
{
    if (!isTouchPressed())
    {
        return false;
    }

    uint16_t rawX = readTouchSample(XPT2046_X, 4);
    uint16_t rawY = readTouchSample(XPT2046_Y, 4);

    // Rotation 1:
    //
    // RAW Y -> SCREEN X
    // RAW X -> SCREEN Y
    //
    // Reversed according to your working calibration.

    screenX = map(
        rawY,
        RAW_Y_MIN,
        RAW_Y_MAX,
        tft.width() - 1,
        0
    );

    screenY = map(
        rawX,
        RAW_X_MIN,
        RAW_X_MAX,
        tft.height() - 1,
        0
    );

    screenX = constrain(
        screenX,
        0,
        tft.width() - 1
    );

    screenY = constrain(
        screenY,
        0,
        tft.height() - 1
    );

    return true;
}

// =============================================================================
// READ TEMPERATURE
// =============================================================================

void readTemperature()
{
    if (simulateDevice)
    {
        // Virtual tank: random walk around ~27C within the 20-31C safe band.
        simTemp += ((int)esp_random() % 211 - 105) / 100.0f; // ~ +/-1.05C
        simTemp = constrain(simTemp, 20.0f, 31.0f);
        temperature = simTemp;
        return;
    }

    sensors.requestTemperatures();
    float value = sensors.getTempCByIndex(0);

    if (
        value != DEVICE_DISCONNECTED_C &&
        value >= -10.0 &&
        value <= 50.0
    )
    {
        temperature = value;
    }
    else
    {
        temperature = -127.0;
    }
}

// =============================================================================
// READ WATER LEVEL
// =============================================================================
//
// One ping per 1 Hz call, ONE filter, ONE formula:
//
//   ping -> float cm -> validity window -> median of the last 5 -> distanceCm
//        -> levelPercentFromDistance() -> waterLevel
//
// The percentage and the empty-tank threshold both consume the SAME median. The
// old code fed the percentage from an EMA + spike-rejection chain and the
// threshold from a separate median, so the number on the dashboard and the
// number the ACTION state machine judged could disagree.
//
// The EMA is gone: a median of 5 already rejects a single spurious echo (which
// an EMA lets through by dragging toward it) and, unlike the EMA it also does
// not lag a genuine level change by a time constant on top of the window.
//
// Every failure path calls invalidateWaterLevel(), which sets the sentinels to
// -1. A failed sensor must never be reported as 0% or 100% - both of those are
// real, actionable values.

void readWaterLevel()
{
    if (simulateDevice)
    {
        // Virtual tank: random walk around ~75% within the 0-100% band.
        simLevel += ((int)esp_random() % 31 - 15) / 10.0f; // ~ +/-1.5%
        simLevel = constrain(simLevel, 0.0f, 100.0f);

        // Drive the threshold from the simulated level too, so the state machine
        // and ACTION A/B can be exercised with no sensor attached. The inverse
        // mapping is levelDistanceFromPercent(), i.e. exactly the formula the
        // real path runs, so simulation and hardware agree by construction.
        //
        // The sample MUST go through pushDistanceSample(): updateThresholdFromDistance()
        // deliberately refuses to assert an action until the median window is
        // full, so feeding it a raw distance here would leave distanceWindowCount
        // at 0 forever and ACTION A/B would never fire in the simulator at all.
        const float simMedianCm = pushDistanceSample(levelDistanceFromPercent(simLevel));
        if (simMedianCm < 0.0f)
        {
            return;
        }
        consecutiveInvalidReads = 0;

        publishWaterLevelFromMedian(simMedianCm);
        updateThresholdFromDistance(simMedianCm, true);
        return;
    }

    // A calibration that cannot produce a percentage makes every read invalid,
    // but saying so once per second would flood the log. Checked here and cached.
    static bool calibrationWarned = false;
    if (!waterCalibrationSane())
    {
        invalidateWaterLevel("calibration invalid");
        if (!calibrationWarned)
        {
            Serial.printf("[HC-SR04] Set WATER_EMPTY_CM / WATER_FULL_CM in firmware, or empty_cm / full_cm in the config portal.\n");
            calibrationWarned = true;
        }
        return;
    }
    calibrationWarned = false;

    // --- 1. Trigger pulse: LOW 2us -> HIGH 10us -> LOW (HC-SR04 datasheet) ----
    // Not delay(): delayMicroseconds() is busy-wait but sub-millisecond, so it
    // costs nothing measurable and the pulse width is actually honoured (the
    // millis()-based scheduling below is what keeps the OTHER work non-blocking).
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);

    // --- 2. Echo, bounded. unsigned long matches pulseIn()'s return type -----
    // A timeout returns 0. That means "no echo", NOT "zero distance" and NOT
    // "empty tank" - it is the single most important distinction in this
    // function, so it is checked first and reported as a failure.
    const unsigned long duration = pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);
    if (duration == 0)
    {
        invalidateWaterLevel("timeout / no echo");
        return;
    }

    // --- 3. Distance in float centimetres (0.0343 cm/us, halved for the
    // round trip). Integer math here would lose the sub-cm resolution that
    // 0.1% of a 15.5 cm span depends on.
    const float rawDistanceCm = (duration * 0.0343f) / 2.0f;

    // --- 4. Physical validity window, BEFORE any filtering. Below 2 cm the
    // module cannot resolve; above 400 cm the echo is lost or the target is
    // out of spec. Either way it is not a measurement.
    if (rawDistanceCm < DISTANCE_MIN_VALID_CM || rawDistanceCm > DISTANCE_MAX_VALID_CM)
    {
        Serial.printf("[HC-SR04] Rejected %.1f cm (outside %.0f-%.0f cm)\n",
                      rawDistanceCm,
                      DISTANCE_MIN_VALID_CM,
                      DISTANCE_MAX_VALID_CM);
        invalidateWaterLevel("out of range");
        return;
    }

    // --- 5. Median of the last DISTANCE_MEDIAN_WINDOW valid samples ---------
    // Works from the first sample onwards, so there is no multi-second dead
    // window at boot where the board claims the sensor has failed.
    const float medianCm = pushDistanceSample(rawDistanceCm);
    if (medianCm < 0.0f)
    {
        return;
    }
    consecutiveInvalidReads = 0;

    // --- 6 & 7. Publish the level, then judge the empty-tank threshold --------
    // Both consume the SAME median, and publishWaterLevelFromMedian() applies the
    // deadband, so the reported percentage and the ACTION state machine can never
    // be looking at different numbers.
    publishWaterLevelFromMedian(medianCm);
    updateThresholdFromDistance(medianCm, false);
}

// =============================================================================
// MQ-137: R0 CALIBRATION (in clean air)
// =============================================================================

void saveMq137R0()
{
    Preferences prefs;
    prefs.begin("mq137", false);
    prefs.putFloat("r0_kohm", mq137R0);
    // Mark the one-time reset as done ONLY now that a real R0 exists. This used
    // to be set up front by refreshMq137R0Once(), which meant a calibration that
    // failed (module unpowered, or R0 outside the sane window) burned the single
    // attempt and every later boot skipped straight to loadMq137R0() with no R0
    // to load - leaving the ammonia page stuck on ERROR with no way out.
    prefs.putBool("r0_refreshed", true);
    prefs.end();
    Serial.printf("[MQ-137] Saved R0 = %.2f kOhm to NVS\n", mq137R0);
}

bool loadMq137R0()
{
    Preferences prefs;
    prefs.begin("mq137", true);
    mq137R0 = prefs.getFloat("r0_kohm", 0.0);
    prefs.end();
    return mq137R0 > 5.0 && mq137R0 < 200.0;
}

// Persists the last-known-good sensor snapshot to NVS so Safe Mode can show
// the last real values after a watchdog reset. Call only when a value has
// actually changed (see readAllSensors) to keep NVS flash writes minimal.
void saveLastKnownValues()
{
    Preferences prefs;
    prefs.begin("safe", false);
    prefs.putFloat("temp", lastGoodTemperature);
    prefs.putFloat("water", lastGoodWaterLevel);
    prefs.putFloat("ammonia", lastGoodAmmonia);
    prefs.end();
}

void loadLastKnownValues()
{
    Preferences prefs;
    prefs.begin("safe", true);
    lastGoodTemperature = prefs.getFloat("temp", -127.0);
    lastGoodWaterLevel = prefs.getFloat("water", -1.0);
    lastGoodAmmonia = prefs.getFloat("ammonia", -1.0);
    prefs.end();
}

// One-time R0 reset: on the first boot after this change the stored R0 is
// deleted (and a flag set) so the fresh clean-air calibration always runs.
// This prevents a stale/wrong R0 saved under the old RL assumption from being
// loaded. Runs exactly once, then never again unless the flag key is removed.
bool refreshMq137R0Once()
{
    Preferences prefs;
    prefs.begin("mq137", true);
    const bool done = prefs.getBool("r0_refreshed", false);
    prefs.end();

    if (done)
    {
        return false;
    }

    // Discard any R0 stored under the old RL assumption. Note we do NOT write
    // "r0_refreshed" here - saveMq137R0() does that, so this one-shot reset
    // stays pending until a calibration has actually succeeded and a failed
    // attempt is simply retried on the next boot.
    prefs.begin("mq137", false);
    prefs.remove("r0_kohm");
    prefs.end();

    Serial.println("[MQ-137] One-time R0 refresh: clearing stored R0 for fresh calibration");
    return true;
}

// Instantaneous sensor resistance (kOhm) from the current analog voltage,
// using the module's assumed Vc / RL. Returns -1 on invalid readings.
float mq137RsFromVoltage()
{
    if (mq137Voltage < 0.005f)
    {
        return -1.0f;
    }
    return MQ137_RL_KOHM * (MQ137_VC_VOLTS / mq137Voltage - 1.0f);
}

// Silent R0 probe used ONLY by the automatic retry in loop(). It samples the
// module a few times with short gaps and derives R0 from the average - no screen
// takeover, no ~7s stall - so the touchscreen keeps responding while it runs.
// Returns true (and persists) only when a sane R0 is derived.
bool probeMq137R0Quietly()
{
    const int samples = 5;
    float sum = 0.0f;
    int good = 0;

    for (int i = 0; i < samples; i++)
    {
        mq137Raw = analogRead(MQ137_PIN);
        mq137Voltage = analogReadMilliVolts(MQ137_PIN) / 1000.0f;

        const float rs = mq137RsFromVoltage();
        if (rs > 0.0f)
        {
            sum += rs;
            good++;
        }

        vTaskDelay(20 / portTICK_PERIOD_MS);
    }

    if (good == 0)
    {
        return false;
    }

    const float r0Candidate = (sum / good) / MQ137_CLEAN_AIR_RATIO;

    if (r0Candidate < 5.0f || r0Candidate > 200.0f)
    {
        return false;
    }

    mq137R0 = r0Candidate;
    saveMq137R0();
    return true;
}

// Average several readings in clean air and derive R0 = Rs_clean / 3.6, then
// persist to NVS so a reboot doesn't throw the calibration away. The MQ-137
// needs minutes to thermally stabilize after power-up, so readings taken too
// early will drift -- let the device run a while before calibrating.
void calibrateMq137R0()
{
    tft.fillScreen(TFT_WHITE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_ORANGE, TFT_WHITE);
    tft.drawString("MQ-137 CALIBRATION", 240, 80, 4);
    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    tft.drawString("Keep sensor in clean air...", 240, 130, 2);

    const int samples = 10;
    float sum = 0.0;
    int good = 0;
    float maxVout = 0.0f;

    for (int i = 0; i < samples; i++)
    {
        mq137Raw = analogRead(MQ137_PIN);
        mq137Voltage = analogReadMilliVolts(MQ137_PIN) / 1000.0f;
        if (mq137Voltage > maxVout)
        {
            maxVout = mq137Voltage;
        }

        Serial.printf("[MQ-137] Sample %2d: raw=%d  Vout=%.3f V\n",
                      i + 1, mq137Raw, mq137Voltage);

        char buf[40];
        snprintf(buf, sizeof(buf), "Sample %d/%d: %.3f V", i + 1, samples, mq137Voltage);
        tft.drawString(buf, 240, 170, 2);

        float rs = mq137RsFromVoltage();
        if (rs > 0.0)
        {
            sum += rs;
            good++;
        }

        delay(500);
    }

    if (maxVout >= 3.0f)
    {
        // The module output is reaching/past the 3.3V ADC ceiling even in
        // clean air, so it can never read correctly. Hardware causes: module
        // not sharing a GND with the ESP32, supply not really 5V, RL not 10k,
        // or AOUT needing a 2:1 resistor divider.
        Serial.printf("[MQ-137] WARNING: Vout %.3f V near ADC ceiling during calibration!\n", maxVout);
        Serial.printf("[MQ-137] Check shared GND (module GND -> ESP32 GND), 5V supply, RL=10k.\n");
    }

    if (good == 0)
    {
        Serial.println("[MQ-137] Calibration failed: no valid readings!");
        Serial.printf("[MQ-137] Raw ADC = %d (0 => module unpowered or no shared GND).\n", mq137Raw);
        tft.fillScreen(TFT_WHITE);
        tft.setTextDatum(MC_DATUM);
        tft.setTextColor(TFT_BLACK, TFT_WHITE);
        tft.drawString("CALIBRATION FAILED", 240, 100, 4);
        tft.drawString("Check MQ-137 wiring/power", 240, 150, 2);
        delay(2000);
        return;
    }

    float rsAvg = sum / good;
    float r0Candidate = rsAvg / MQ137_CLEAN_AIR_RATIO;

    // Only accept a physically sensible R0 (the same window loadMq137R0() uses).
    // This prevents a garbage R0 from being baked into NVS and then silently
    // broken data being reported until the next recalibration.
    if (r0Candidate < 5.0f || r0Candidate > 200.0f)
    {
        Serial.printf("[MQ-137] Calibration REJECTED: R0 = %.2f kOhm outside valid 5-200 kOhm window.\n", r0Candidate);
        Serial.printf("[MQ-137] Raw ADC = %d | Vout = %.3f V | Rs = %.2f kOhm\n",
                      mq137Raw, mq137Voltage, rsAvg);
        tft.fillScreen(TFT_WHITE);
        tft.setTextDatum(MC_DATUM);
        tft.setTextColor(TFT_BLACK, TFT_WHITE);
        tft.drawString("CALIBRATION FAILED", 240, 100, 4);
        tft.drawString("Check module supply/GND/wiring", 240, 150, 2);
        delay(2000);
        return;
    }

    mq137R0 = r0Candidate;
    saveMq137R0();

    Serial.printf("[MQ-137] Clean-air Rs avg = %.2f kOhm -> R0 = %.2f kOhm\n", rsAvg, mq137R0);

    tft.fillScreen(TFT_WHITE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_ORANGE, TFT_WHITE);
    tft.drawString("CALIBRATION DONE", 240, 100, 4);
    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    char calText[40];
    snprintf(calText, sizeof(calText), "R0 = %.2f kOhm", mq137R0);
    tft.drawString(calText, 240, 150, 2);
    delay(1500);
}

// =============================================================================
// READ MQ-137 (REAL AMMONIA GAS, ppm)
// =============================================================================

void readAmmonia()
{
    if (simulateDevice)
    {
        // Virtual tank: random walk around ~0.5 ppm (floor 0.2), safe range.
        simAmmonia += ((int)esp_random() % 21 - 10) / 100.0f; // ~ +/-0.1 ppm
        if (simAmmonia < 0.2f)
        {
            simAmmonia = 0.2f;
        }
        simAmmonia = constrain(simAmmonia, 0.0f, 25.0f);
        ammoniaPpm = simAmmonia;
        ammoniaReady = true;
        lastShownPpm = simAmmonia;
        return;
    }

    // Multi-sample ADC averaging to reduce electrical noise
    uint32_t adcSum = 0;
    uint32_t mvSum = 0;
    for (int i = 0; i < MQ137_ADC_SAMPLES; i++)
    {
        adcSum += analogRead(MQ137_PIN);
        mvSum += analogReadMilliVolts(MQ137_PIN);
    }
    mq137Raw = adcSum / MQ137_ADC_SAMPLES;
    mq137Voltage = (mvSum / MQ137_ADC_SAMPLES) / 1000.0f;

    // ~0V output: module unpowered/disconnected -> mark the sensor as failed
    if (mq137Raw < 8)
    {
        ammoniaReady = false;
        ammoniaPpm = -1.0f;
        mq137SpikeStreak = 0;
        return;
    }

    float rs = mq137RsFromVoltage();
    if (rs <= 0.0f)
    {
        ammoniaReady = false;
        ammoniaPpm = -1.0f;
        mq137SpikeStreak = 0;
        return;
    }

    mq137RsKohm = rs;

    if (mq137R0 <= 0.0f)
    {
        // No calibration data yet -> can't compute a ratio, flag the error.
        ammoniaReady = false;
        ammoniaPpm = -1.0f;
        mq137SpikeStreak = 0;
        return;
    }

    mq137Ratio = rs / mq137R0;

    float ppm = 0.0f;
    if (mq137Ratio > 0.00001f)
    {
        ppm = powf(10.0f, (log10f(mq137Ratio) - MQ137_CURVE_B) / MQ137_CURVE_M);
    }

    if (mq137Voltage >= MQ137_SAT_VOLTS)
    {
        // ADC at/near full scale: the true concentration is higher than we can
        // resolve. Clamp and keep reporting (so web alerts still fire).
        ppm = MQ137_PPM_MAX;
        Serial.printf("[MQ-137] ADC SATURATION (%.3f V) - reading clamped to %.0f ppm\n",
                      mq137Voltage, MQ137_PPM_MAX);
    }

    ppm = constrain(ppm, 0.0f, MQ137_PPM_MAX);

    // Spike rejection: if the new reading jumps more than MQ137_SPIKE_PPM_MAX
    // from the current EMA, require it to repeat before accepting.
    if (mq137PpmEma >= 0.0f && fabsf(ppm - mq137PpmEma) > MQ137_SPIKE_PPM_MAX)
    {
        mq137SpikeStreak++;
        if (mq137SpikeStreak < 2)
        {
            // First spike: reject, keep previous value
            Serial.printf("[MQ-137] Spike rejected: raw %.1f ppm vs EMA %.1f ppm (streak %d)\n",
                          ppm, mq137PpmEma, mq137SpikeStreak);
            return;
        }
        // Spike repeated: accept it (likely a real change)
        Serial.printf("[MQ-137] Spike accepted after %d repeats: %.1f ppm\n",
                      mq137SpikeStreak, ppm);
        mq137SpikeStreak = 0;
    }
    else
    {
        mq137SpikeStreak = 0;
    }

    // EMA smoothing to tame MQ-series drift/noise
    if (mq137PpmEma < 0.0f)
    {
        mq137PpmEma = ppm;
    }
    else
    {
        mq137PpmEma += (ppm - mq137PpmEma) * MQ137_EMA_ALPHA;
    }

    ammoniaPpm = mq137PpmEma;
    ammoniaReady = true;

    // Deadband: screen only repaints when ppm really moved.
    if (lastShownPpm < 0.0f || fabsf(ammoniaPpm - lastShownPpm) >= MQ137_PPM_DEADBAND)
    {
        lastShownPpm = ammoniaPpm;
    }
    ammoniaPpm = lastShownPpm;
}

// =============================================================================
// READ ALL SENSORS
// =============================================================================

void readAllSensors()
{
    readTemperature();
    readWaterLevel();
    readAmmonia();

    Serial.println();
    Serial.println("========================================");

    Serial.print("Water Temperature: ");
    if (temperature == -127.0)
    {
        Serial.println("ERROR");
    }
    else
    {
        Serial.print(temperature, 2);
        Serial.println(" C");
    }

    // Water level: distance AND percentage, as required for calibration. A
    // failed sensor prints ERROR, never "-1.0 %" - the operator reading the
    // serial monitor must not have to know that -1 is a sentinel.
    Serial.print("Water Level: ");
    if (waterLevel < 0.0f)
    {
        Serial.print("ERROR");
        Serial.print(" | Distance: ERROR");
    }
    else
    {
        Serial.print(waterLevel, 1);
        Serial.print(" %");
        Serial.print(" | Distance: ");
        Serial.print(distance, 2);
        Serial.print(" cm");
    }
    Serial.println();

    Serial.print("MQ-137 Raw ADC: ");
    Serial.print(mq137Raw);
    Serial.print(" | Vout: ");
    Serial.print(mq137Voltage, 3);
    Serial.print(" V | Rs: ");

    if (mq137RsKohm > 0.0)
    {
        Serial.print(mq137RsKohm, 2);
        Serial.print(" kOhm | R0: ");
        Serial.print(mq137R0, 2);
        Serial.print(" kOhm | NH3: ");

        if (ammoniaReady)
        {
            Serial.print(ammoniaPpm, 2);
            Serial.println(" ppm");
        }
        else
        {
            Serial.println("ERROR");
        }
    }
    else
    {
        Serial.println("N/A");
    }

    Serial.println("========================================");

    // Keep the last-good snapshot for Safe Mode recovery after a watchdog reset.
    // Only persist a value that moved by more than its own epsilon, and never
    // more than once per SAFE_SNAPSHOT_MIN_INTERVAL_MS (see the wear note
    // above). lastSnapshotSaveMs == 0 forces the very first snapshot through
    // even when boot lands inside the interval, so NVS is always seeded.
    const float prevTemp = lastGoodTemperature;
    const float prevLevel = lastGoodWaterLevel;
    const float prevAmmonia = lastGoodAmmonia;

    if (temperature != -127.0) lastGoodTemperature = temperature;
    if (waterLevel >= 0.0)     lastGoodWaterLevel = waterLevel;
    if (ammoniaReady)          lastGoodAmmonia = ammoniaPpm;
    lastGoodMillis = millis();

    const bool snapshotChanged =
        fabsf(lastGoodTemperature - prevTemp) > SAFE_SNAPSHOT_EPS_TEMP ||
        fabsf(lastGoodWaterLevel - prevLevel) > SAFE_SNAPSHOT_EPS_LEVEL ||
        fabsf(lastGoodAmmonia - prevAmmonia) > SAFE_SNAPSHOT_EPS_AMMONIA;

    const unsigned long snapshotNowMs = millis();
    const bool intervalElapsed =
        lastSnapshotSaveMs == 0 ||
        (snapshotNowMs - lastSnapshotSaveMs) >= SAFE_SNAPSHOT_MIN_INTERVAL_MS;

    if (snapshotChanged && intervalElapsed)
    {
        saveLastKnownValues();
        lastSnapshotSaveMs = snapshotNowMs;
    }
}

// =============================================================================
// HEADER
// =============================================================================

// Tracks the colour the header dot currently shows, so updateWifiDot() only
// repaints when the link state actually flips.
bool lastWifiDot = false;

void drawHeader(const char *title)
{
    tft.fillRect(0, 0, 480, 55, TFT_BLUE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_WHITE, TFT_BLUE);
    tft.drawString(title, 240, 27, 4);

    lastWifiDot = wifiConnected;
    tft.fillCircle(465, 27, 5, wifiConnected ? TFT_GREEN : TFT_RED);
}

// The dot is painted by drawHeader() only, so without this it would keep
// showing the colour from the last page redraw - a green dot on a device that
// dropped off the network. Repaint just the 11px dot on change (no flash churn).
void updateWifiDot()
{
    if (wifiConnected == lastWifiDot)
    {
        return;
    }

    lastWifiDot = wifiConnected;
    tft.fillCircle(465, 27, 5, wifiConnected ? TFT_GREEN : TFT_RED);
}

// =============================================================================
// PAGE INDICATORS
// =============================================================================

void drawPageDots()
{
    int dotY = 305;
    for (int i = 0; i < PAGE_COUNT; i++)
    {
        int x = 180 + (i * 40);
        if (i == currentPage)
        {
            tft.fillCircle(x, dotY, 6, TFT_BLUE);
        }
        else
        {
            tft.fillCircle(x, dotY, 5, TFT_LIGHTGREY);
        }
    }
}

// =============================================================================
// NAVIGATION
// =============================================================================

void drawArrowButton(bool isLeft, bool pressed)
{
    int x0 = isLeft ? 20 : 422;
    int y0 = 248;
    int w = 38;
    int h = 52;

    uint16_t fill = pressed ? TFT_YELLOW : TFT_BLUE;
    uint16_t arrow = pressed ? TFT_NAVY : TFT_WHITE;

    tft.fillRoundRect(x0, y0, w, h, 12, fill);

    if (isLeft)
    {
        tft.fillTriangle(x0 + 10, y0 + h / 2, x0 + w - 6, y0 + 12, x0 + w - 6, y0 + h - 12, arrow);
    }
    else
    {
        tft.fillTriangle(x0 + w - 10, y0 + h / 2, x0 + 6, y0 + 12, x0 + 6, y0 + h - 12, arrow);
    }
}

void drawNavigation(bool pressed = false)
{
    drawArrowButton(true, pressed);
    drawArrowButton(false, pressed);
}

// =============================================================================
// OVERVIEW PAGE
// =============================================================================

void drawOverview()
{
    tft.fillScreen(TFT_WHITE);
    drawHeader("CRAYVINGS MONITOR");

    tft.drawRect(15, 70, 215, 75, TFT_RED);
    tft.setTextDatum(TL_DATUM);
    tft.setTextColor(TFT_RED, TFT_WHITE);
    tft.drawString("TEMPERATURE", 30, 80, 2);

    tft.drawRect(250, 70, 215, 75, TFT_BLUE);
    tft.setTextColor(TFT_BLUE, TFT_WHITE);
    tft.drawString("WATER LEVEL", 265, 80, 2);

    tft.drawRect(15, 160, 215, 75, TFT_ORANGE);
    tft.setTextColor(TFT_ORANGE, TFT_WHITE);
    tft.drawString("MQ-137", 30, 170, 2);

    tft.drawRect(250, 160, 215, 75, TFT_GREEN);
    tft.setTextColor(TFT_GREEN, TFT_WHITE);
    tft.drawString("WATER STATUS", 265, 170, 2);

    drawNavigation();
    drawPageDots();
}

void updateOverview()
{
    tft.fillRect(25, 102, 195, 35, TFT_WHITE);
    tft.setTextDatum(TL_DATUM);
    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    char tempText[30];

    if (temperature == -127.0)
    {
        strcpy(tempText, "ERROR");
    }
    else
    {
        snprintf(tempText, sizeof(tempText), "%.1f C", temperature);
    }

    tft.drawString(tempText, 30, 105, 4);

    tft.fillRect(260, 102, 195, 35, TFT_WHITE);
    char levelText[30];

    if (waterLevel < 0.0)
    {
        strcpy(levelText, "ERROR");
    }
    else
    {
        snprintf(levelText, sizeof(levelText), "%.1f %%", waterLevel);
    }

    tft.drawString(levelText, 265, 105, 4);

    tft.fillRect(25, 192, 195, 35, TFT_WHITE);
    char ammoniaText[30];

    if (ammoniaReady)
    {
        snprintf(ammoniaText, sizeof(ammoniaText), "%.1f ppm", ammoniaPpm);
    }
    else
    {
        strcpy(ammoniaText, "ERROR");
    }

    tft.drawString(ammoniaText, 30, 195, 4);

    tft.fillRect(260, 192, 195, 35, TFT_WHITE);
    const char *status;

    if (waterLevel < 0.0)
    {
        status = "ERROR";
    }
    else if (waterLevel < 20.0)
    {
        status = "LOW";
    }
    else if (waterLevel < 80.0)
    {
        status = "NORMAL";
    }
    else
    {
        status = "HIGH";
    }

    tft.setTextDatum(TL_DATUM);
    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    tft.drawString(status, 265, 195, 4);
}

void drawTemperaturePage()
{
    tft.fillScreen(TFT_WHITE);
    drawHeader("WATER TEMPERATURE");
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_RED, TFT_WHITE);

    if (temperature == -127.0)
    {
        tft.drawString("SENSOR ERROR", 240, 140, 4);
    }
    else
    {
        char text[30];
        snprintf(text, sizeof(text), "%.2f C", temperature);
        tft.drawString(text, 240, 140, 7);
    }

    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    tft.drawString("DS18B20", 240, 210, 2);
    drawNavigation();
    drawPageDots();
}

void updateTemperaturePage()
{
    tft.fillRect(60, 95, 360, 90, TFT_WHITE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_RED, TFT_WHITE);

    if (temperature == -127.0)
    {
        tft.drawString("SENSOR ERROR", 240, 140, 4);
    }
    else
    {
        char text[30];
        snprintf(text, sizeof(text), "%.2f C", temperature);
        tft.drawString(text, 240, 140, 7);
    }
}

void drawWaterLevelPage()
{
    tft.fillScreen(TFT_WHITE);
    drawHeader("WATER LEVEL");

    lastLevelText[0] = '\0';
    lastBarWidth = -1;

    tft.drawRect(70, 80, 340, 80, TFT_BLUE);

    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_BLUE, TFT_WHITE);
    char levelText[30];

    if (waterLevel < 0.0)
    {
        strcpy(levelText, "ERROR");
    }
    else
    {
        snprintf(levelText, sizeof(levelText), "%.1f %%", waterLevel);
    }

    tft.drawString(levelText, 240, 205, 6);

    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    tft.drawString("HC-SR04 WATER LEVEL", 240, 245, 2);

    drawNavigation();
    drawPageDots();
    updateWaterLevelPage();
}

void updateWaterLevelPage()
{
    char levelText[30];

    if (waterLevel < 0.0)
    {
        strcpy(levelText, "ERROR");
    }
    else
    {
        snprintf(levelText, sizeof(levelText), "%.1f %%", waterLevel);
    }

    if (strcmp(lastLevelText, levelText) != 0)
    {
        strcpy(lastLevelText, levelText);
        tft.fillRect(90, 175, 300, 60, TFT_WHITE);
        tft.setTextDatum(MC_DATUM);
        tft.setTextColor(TFT_BLUE, TFT_WHITE);
        tft.drawString(levelText, 240, 205, 6);
    }

    int fillWidth = (int)(336.0 * waterLevel / 100.0);
    fillWidth = constrain(fillWidth, 0, 336);

    if (lastBarWidth < 0)
    {
        tft.fillRect(72, 82, 336, 76, TFT_WHITE);

        if (fillWidth > 0)
        {
            tft.fillRect(72, 82, fillWidth, 76, TFT_BLUE);
        }
    }
    else if (fillWidth > lastBarWidth)
    {
        tft.fillRect(72 + lastBarWidth, 82, fillWidth - lastBarWidth, 76, TFT_BLUE);
    }
    else if (fillWidth < lastBarWidth)
    {
        tft.fillRect(72 + fillWidth, 82, lastBarWidth - fillWidth, 76, TFT_WHITE);
    }

    lastBarWidth = fillWidth;
}

void drawAmmoniaPage()
{
    tft.fillScreen(TFT_WHITE);
    drawHeader("MQ-137 AMMONIA");

    char ppmText[30];

    if (ammoniaReady)
    {
        snprintf(ppmText, sizeof(ppmText), "%.1f ppm", ammoniaPpm);
    }
    else
    {
        strcpy(ppmText, "-- ppm");
    }

    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(ppmText[0] == '-' ? TFT_RED : TFT_ORANGE, TFT_WHITE);
    tft.drawString(ppmText, 240, 120, 7);

    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    char rawText[30];
    snprintf(rawText, sizeof(rawText), "RAW ADC: %d | %.3f V", mq137Raw, mq137Voltage);
    tft.drawString(rawText, 240, 190, 3);

    char r0Text[30];

    if (mq137R0 > 0.0f)
    {
        snprintf(r0Text, sizeof(r0Text), "R0: %.1f kOhm", mq137R0);
    }
    else
    {
        strcpy(r0Text, "R0: -- kOhm");
    }

    tft.drawString(r0Text, 240, 235, 2);

    tft.setTextColor(TFT_DARKGREY, TFT_WHITE);
    tft.drawString("NH3 gas concentration in air", 240, 256, 2);
    tft.drawString("Triple-tap top-right: recalibrate", 240, 276, 2);
    drawNavigation();
    drawPageDots();
}

void updateAmmoniaPage()
{
    tft.fillRect(60, 80, 360, 90, TFT_WHITE);
    tft.setTextDatum(MC_DATUM);

    char ppmText[30];

    if (ammoniaReady)
    {
        snprintf(ppmText, sizeof(ppmText), "%.1f ppm", ammoniaPpm);
    }
    else
    {
        strcpy(ppmText, "-- ppm");
    }

    tft.setTextColor(ppmText[0] == '-' ? TFT_RED : TFT_ORANGE, TFT_WHITE);
    tft.drawString(ppmText, 240, 120, 7);

    tft.fillRect(100, 175, 280, 40, TFT_WHITE);
    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    char rawText[30];
    snprintf(rawText, sizeof(rawText), "RAW ADC: %d | %.3f V", mq137Raw, mq137Voltage);
    tft.drawString(rawText, 240, 190, 3);
}

void drawCurrentPage()
{
    switch (currentPage)
    {
        case PAGE_OVERVIEW:
            drawOverview();
            updateOverview();
            break;

        case PAGE_TEMPERATURE:
            drawTemperaturePage();
            break;

        case PAGE_WATER_LEVEL:
            drawWaterLevelPage();
            break;

        case PAGE_AMMONIA:
            drawAmmoniaPage();
            break;
    }
}

void updateCurrentPage()
{
    switch (currentPage)
    {
        case PAGE_OVERVIEW:
            updateOverview();
            break;

        case PAGE_TEMPERATURE:
            updateTemperaturePage();
            break;

        case PAGE_WATER_LEVEL:
            updateWaterLevelPage();
            break;

        case PAGE_AMMONIA:
            updateAmmoniaPage();
            break;
    }

    // The header dot is the only header element that can go stale between page
    // redraws, so refresh it here. Deliberately no drawNavigation(): none of the
    // update*() erase rectangles reach the arrow buttons (they all end at
    // y=235, the buttons start at y=248), so repainting them once a second
    // would only cost SPI traffic.
    updateWifiDot();
}

void nextPage()
{
    currentPage++;
    if (currentPage >= PAGE_COUNT)
    {
        currentPage = PAGE_OVERVIEW;
    }
    drawCurrentPage();
    lastPageChange = millis();
}

void previousPage()
{
    currentPage--;
    if (currentPage < 0)
    {
        currentPage = PAGE_COUNT - 1;
    }
    drawCurrentPage();
    lastPageChange = millis();
}

void handleTouch()
{
    uint16_t x = lastTouchX;
    uint16_t y = lastTouchY;
    bool pressed = getTouchPosition(x, y);

    if (pressed)
    {
        lastTouchX = x;
        lastTouchY = y;

        if (!touching)
        {
            touching = true;
            Serial.print("[TOUCH START] X=");
            Serial.print(x);
            Serial.print(" Y=");
            Serial.println(y);

            if (
                (x < 80 && y > 240 && y < 305) ||
                (x > 400 && y > 240 && y < 305)
            )
            {
                drawNavigation(true);
                navButtonHighlighted = true;
            }
        }
        return;
    }

    if (!touching)
    {
        return;
    }

    touching = false;
    uint16_t endX = lastTouchX;
    uint16_t endY = lastTouchY;

    Serial.print("[TOUCH END] X=");
    Serial.print(endX);
    Serial.print(" Y=");
    Serial.println(endY);

    // Only undo the highlight if this touch actually pressed an arrow. A tap
    // anywhere else never redrew the buttons, so repainting both arrows here was
    // pure SPI traffic on every single tap on the panel.
    if (navButtonHighlighted)
    {
        navButtonHighlighted = false;
        drawNavigation();
    }

    if (millis() - lastPageChange < PAGE_CHANGE_COOLDOWN)
    {
        return;
    }

    // Left arrow button region (bottom-left)
    if (endX < 80 && endY > 240 && endY < 305)
    {
        Serial.println("[NAV] LEFT ARROW -> PREVIOUS PAGE");
        previousPage();
        return;
    }

    // Right arrow button region (bottom-right)
    if (endX > 400 && endY > 240 && endY < 305)
    {
        Serial.println("[NAV] RIGHT ARROW -> NEXT PAGE");
        nextPage();
        return;
    }

    // Triple tap on top-left corner for WiFi config
    if (endX < 60 && endY < 60)
    {
        static uint8_t tapCount = 0;
        static unsigned long lastTapTime = 0;
        unsigned long now = millis();

        if (now - lastTapTime > 1000)
        {
            tapCount = 0;
        }

        tapCount++;
        lastTapTime = now;
        Serial.printf("[CONFIG] Tap %d/3 detected\n", tapCount);

        if (tapCount >= 3)
        {
            Serial.println("[CONFIG] Triple tap detected! Starting WiFi configuration...");
            wifiConfigRequested = true;
            tapCount = 0;
        }
    }

    // Triple tap on top-right corner to recalibrate the MQ-137 (clean air)
    if (endX > 420 && endY < 60)
    {
        static uint8_t calTapCount = 0;
        static unsigned long lastCalTapTime = 0;
        unsigned long now = millis();

        if (now - lastCalTapTime > 1000)
        {
            calTapCount = 0;
        }

        calTapCount++;
        lastCalTapTime = now;
        Serial.printf("[MQ-137] Calibration tap %d/3 detected\n", calTapCount);

        if (calTapCount >= 3)
        {
            Serial.println("[MQ-137] Triple tap detected! Recalibrating R0 in clean air...");
            calibrateMq137R0();
            calTapCount = 0;
            tft.fillScreen(TFT_WHITE);
            drawCurrentPage();
        }
    }
}

void startWifiConfigPortal()
{
    Serial.println("[WIFI] Starting configuration portal...");
    Serial.println("[WIFI] 1) On your phone or any device, open Wi-Fi settings.");
    Serial.println("[WIFI] 2) Connect to the access point: Aquaculture-Setup");
    Serial.println("[WIFI] 3) Open a browser and visit http://192.168.4.1 to configure.");
    Serial.println("[WIFI] If no page loads, reconnect to the AP and try again.");

    if (!headlessMode)
    {
        tft.fillScreen(TFT_WHITE);
        tft.setTextDatum(TL_DATUM);
        tft.setTextColor(TFT_BLACK, TFT_WHITE);
        tft.drawString("WiFi Setup Mode", 20, 30, 4);
        tft.setTextColor(TFT_DARKGREY, TFT_WHITE);
        tft.drawString("1. Open Wi-Fi settings", 20, 82, 2);
        tft.drawString("   on your phone/device", 20, 104, 2);
        tft.setTextColor(TFT_ORANGE, TFT_WHITE);
        tft.drawString("2. Connect to the access point:", 20, 142, 2);
        tft.setTextColor(TFT_BLUE, TFT_WHITE);
        tft.drawString("   Aquaculture-Setup", 20, 166, 3);
        tft.setTextColor(TFT_DARKGREY, TFT_WHITE);
        tft.drawString("3. Open a browser and visit:", 20, 212, 2);
        tft.setTextColor(TFT_BLUE, TFT_WHITE);
    tft.drawString("   http://192.168.4.1", 20, 236, 3);
        tft.setTextColor(TFT_RED, TFT_WHITE);
        tft.drawString("Timeout: 3 minutes", 20, 292, 2);
    }

    WiFi.mode(WIFI_AP_STA);
    WiFiManager wm;

    // Pre-fill the backend fields with what the device is ACTUALLY using, not
    // the compiled-in placeholder. Opening the portal used to reset both fields
    // to SERVER_IP_DEFAULT / SERVER_PORT_DEFAULT, so hitting Save without
    // retyping them silently pinned the stale 192.168.4.10 over an IP that
    // autoDeriveServerIp() had just worked out from the real subnet.
    WiFiManagerParameter serverIPParam(
        "server_ip",
        "Dashboard Server IP (where THIS board sends data, e.g. 192.168.1.100) — NOT this board's IP",
        serverIP,
        50
    );

    WiFiManagerParameter serverPortParam(
        "server_port",
        "Backend Server Port",
        serverPort,
        6
    );

    WiFiManagerParameter deviceIdParam(
        "device_id",
        "Device ID (letters, numbers, . _ - only; max 50)",
        deviceId,
        DEVICE_ID_MAX_LEN
    );

    // Two calibration fields, not one "tank height". The percentage is a
    // projection between two measured distances, so both ends have to be
    // configurable - and they are configurable from here (no reflash), which is
    // what makes recalibrating a moved or re-mounted sensor practical.
    char emptyDistText[12];
    snprintf(emptyDistText, sizeof(emptyDistText), "%.2f", emptyDistanceCm);
    char fullDistText[12];
    snprintf(fullDistText, sizeof(fullDistText), "%.2f", fullDistanceCm);

    char staticIpText[20] = "";
    char staticGwText[20] = "";
    char staticMaskText[20] = "";
    if (staticIpConfigured)
    {
        strcpy(staticIpText, staticIp.toString().c_str());
        strcpy(staticGwText, staticGateway.toString().c_str());
        strcpy(staticMaskText, staticSubnet.toString().c_str());
    }

    WiFiManagerParameter deviceSecretParam(
        "device_secret",
        "Device Secret (X-Device-Secret header)",
        deviceSecret,
        100
    );

    // Label wording matters here: these are sensor-to-water-surface distances
    // (an "air gap"), not the tank's wall height. That distinction is exactly
    // what the old single "Tank Height (cm)" field got wrong.
    WiFiManagerParameter emptyDistParam(
        "empty_distance_cm",
        "Empty water level: sensor-to-surface distance at minimum fill, cm (23.5)",
        emptyDistText,
        11
    );

    WiFiManagerParameter fullDistParam(
        "full_distance_cm",
        "Full water level: sensor-to-surface distance at maximum fill, cm (must be < empty)",
        fullDistText,
        11
    );

    WiFiManagerParameter staticIpParam(
        "static_ip",
        "Static IP (blank = DHCP)",
        staticIpText,
        16
    );

    WiFiManagerParameter staticGwParam(
        "static_gateway",
        "Gateway (blank = DHCP)",
        staticGwText,
        16
    );

    WiFiManagerParameter staticMaskParam(
        "static_subnet",
        "Subnet mask (blank = DHCP)",
        staticMaskText,
        16
    );

    wm.addParameter(&serverIPParam);
    wm.addParameter(&serverPortParam);
    wm.addParameter(&deviceIdParam);
    wm.addParameter(&deviceSecretParam);
    wm.addParameter(&emptyDistParam);
    wm.addParameter(&fullDistParam);
    wm.addParameter(&staticIpParam);
    wm.addParameter(&staticGwParam);
    wm.addParameter(&staticMaskParam);

    wm.setConfigPortalTimeout(180);
    wm.setConnectTimeout(10);

    // startConfigPortal forces the access point to open even if the ESP32
    // already has a saved network (autoConnect would skip the portal when
    // already connected, so the on-screen "connect your phone" steps wouldn't
    // work). The phone/device joins the "Aquaculture-Setup" AP, then opens
    // http://192.168.4.1 to enter the Wi-Fi and backend details.
    //
    // NOTE: the portal blocks this task for up to ConfigPortalTimeout (180s),
    // which would trip the 30s task watchdog armed in setup() and reset the
    // chip every 30s in an endless loop. Suspend this task's WDT subscription
    // while the portal runs, and re-arm it once the portal returns.
    // Release port 80 before the portal opens so the captive setup page loads
    // on the phone (AP without portal = the symptom we are fixing).
    stopStatusServer();

    esp_task_wdt_delete(NULL);
    bool wifiResult = wm.startConfigPortal("Aquaculture-Setup");
    esp_task_wdt_add(NULL);
    Serial.println("[WDT] Task watchdog re-armed after config portal");
    startStatusServer();

    if (wifiResult)
    {
        wifiConnected = true;
        Serial.println("[WIFI] Connected!");
        Serial.print("[WIFI] IP: ");
        Serial.println(WiFi.localIP());

        publishServerAddress(serverIPParam.getValue(), serverPortParam.getValue());

        // If the portal field still holds the placeholder IP, fall back to the
        // auto-derived <wifi-subnet>.10 address instead of the stale default.
        autoDeriveServerIp();

        strncpy(deviceSecret, deviceSecretParam.getValue(), sizeof(deviceSecret) - 1);
        deviceSecret[sizeof(deviceSecret) - 1] = '\0';

        // A blank field must not wipe the ID this board already reports under,
        // so fall back to the value loaded from NVS rather than the compiled default.
        String previousDeviceId = deviceId;
        applyDeviceIdCandidate(deviceIdParam.getValue(), previousDeviceId.c_str());

        // Calibration is validated as a PAIR, not field by field. Individually
        // plausible numbers that make a negative span (full > empty) would divide
        // by a negative and report an inverted percentage, so an unusable
        // entry falls back to the firmware defaults with a message rather than
        // being half-applied.
        const float newEmpty = atof(emptyDistParam.getValue());
        const float newFull = atof(fullDistParam.getValue());
        if (newEmpty > newFull && newFull >= DISTANCE_MIN_VALID_CM && newEmpty <= DISTANCE_MAX_VALID_CM)
        {
            emptyDistanceCm = newEmpty;
            fullDistanceCm = newFull;
            Serial.printf("[CONFIG] Water calibration set: empty=%.2f cm, full=%.2f cm (usable depth %.2f cm)\n",
                          emptyDistanceCm, fullDistanceCm, emptyDistanceCm - fullDistanceCm);
        }
        else
        {
            Serial.printf("[CONFIG] REJECTED water calibration (empty=%.2f cm, full=%.2f cm): empty must be > full, and full must be >= %.0f cm. Keeping %.2f / %.2f.\n",
                          newEmpty, newFull, DISTANCE_MIN_VALID_CM, emptyDistanceCm, fullDistanceCm);
        }

        const bool hasStaticFields =
            strlen(staticIpParam.getValue()) > 0 &&
            strlen(staticGwParam.getValue()) > 0 &&
            strlen(staticMaskParam.getValue()) > 0;

        if (hasStaticFields)
        {
            IPAddress ip, gw, mask;
            if (ip.fromString(staticIpParam.getValue()) &&
                gw.fromString(staticGwParam.getValue()) &&
                mask.fromString(staticMaskParam.getValue()))
            {
                saveStaticIpConfig(true, ip, gw, mask);
                staticIpConfigured = true;
                staticIp = ip;
                staticGateway = gw;
                staticSubnet = mask;
                WiFi.config(ip, gw, mask);
                Serial.print("[WIFI] Static IP set: ");
                Serial.println(WiFi.localIP());
            }
        }
        else if (staticIpConfigured)
        {
            saveStaticIpConfig(false, IPAddress(), IPAddress(), IPAddress());
            staticIpConfigured = false;
            Serial.println("[WIFI] Static IP cleared (DHCP)");
        }

        saveSystemConfig();

        Serial.print("[WIFI] Backend: ");
        Serial.print(serverIP);
        Serial.print(":");
        Serial.println(serverPort);
        Serial.print("[WIFI] Device ID: ");
        Serial.println(deviceId);

        if (!headlessMode)
        {
            tft.fillScreen(TFT_WHITE);
            tft.setTextDatum(MC_DATUM);
            tft.setTextColor(TFT_BLACK, TFT_WHITE);
            tft.drawString("WiFi Connected!", 240, 100, 4);
            tft.drawString("IP: " + String(WiFi.localIP().toString()), 240, 150, 2);
            delay(2000);
        }
    }
    else
    {
        wifiConnected = false;
        Serial.println("[WIFI] Timeout or failed. Running offline.");

        if (!headlessMode)
        {
            tft.fillScreen(TFT_WHITE);
            tft.setTextDatum(MC_DATUM);
            tft.setTextColor(TFT_BLACK, TFT_WHITE);
            tft.drawString("WiFi Setup Failed", 240, 100, 4);
            tft.drawString("Running in offline mode", 240, 150, 2);
            delay(2000);
        }
    }

    wifiConfigRequested = false;
    if (!headlessMode)
    {
        tft.fillScreen(TFT_WHITE);
        drawCurrentPage();
    }
}

// =============================================================================
// STATUS HTTP SERVER (star topology: central server polls us over LAN)
// =============================================================================

AsyncWebServer statusServer(80);
bool statusServerRunning = false;

String buildStatusJson()
{
    String json = "{";
    json += "\"device_id\":\"" + String(deviceId) + "\",";
    json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
    json += "\"uptime_ms\":" + String(millis()) + ",";
    json += "\"wifi_rssi\":" + String(WiFi.RSSI()) + ",";
    json += "\"free_heap\":" + String(ESP.getFreeHeap()) + ",";
    json += "\"temperature\":" + String((temperature == -127.0) ? -1.0 : temperature, 2) + ",";
    // -1 on a failed sensor, matching the POST /sensor wire sentinels. The raw
    // distance and the calibration this board is running are published alongside
    // it so the server (and the health poller) can tell "empty tank" apart from
    // "board calibrated for a different tank".
    json += "\"water_level\":" + String(waterLevel, 1) + ",";
    json += "\"water_distance_cm\":" + String(distance, 2) + ",";
    json += "\"water_empty_cm\":" + String(emptyDistanceCm, 2) + ",";
    json += "\"water_full_cm\":" + String(fullDistanceCm, 2) + ",";
    json += "\"ammonia\":" + String(ammoniaReady ? ammoniaPpm : -1.0, 3);
    json += "}";
    return json;
}

void startStatusServer()
{
    if (statusServerRunning)
    {
        return;
    }

    // Register the routes exactly once. stopStatusServer() calls end(), and
    // re-running these on() calls every time the portal opened (once per
    // top-left triple tap) piled up duplicate handlers for the same paths in
    // AsyncWebServer's internal list - it grows for the life of the process.
    static bool routesRegistered = false;
    if (!routesRegistered)
    {
        statusServer.on("/status", HTTP_GET, [](AsyncWebServerRequest *request)
        {
            request->send(200, "application/json", buildStatusJson());
        });

        statusServer.on("/", HTTP_GET, [](AsyncWebServerRequest *request)
        {
            request->send(200, "application/json", buildStatusJson());
        });

        routesRegistered = true;
    }

    statusServer.begin();
    statusServerRunning = true;
    Serial.println("[HTTP] Status server on port 80 (GET /status | /)");
}

// The WiFiManager captive portal needs port 80 too (it serves the config page).
// Release the port while the portal runs, or the phone joins the AP but the
// setup page never loads.
void stopStatusServer()
{
    if (!statusServerRunning)
    {
        return;
    }

    statusServer.end();
    statusServerRunning = false;
    Serial.println("[HTTP] Status server stopped (portal needs port 80)");
}

// One POST attempt for a single reading; returns the HTTP response code
// (>0 success, otherwise a negative/timeout indicator).
//
// Sends BOTH water_level (percent) and water_distance_cm (raw air-gap distance).
// The percent alone is not enough: it is a lossy projection of the distance, so
// once it is stored the calibration cannot be re-derived. Sending both lets the
// server re-calibrate EMPTY_CM / FULL_CM from history without reflashing the
// board, and lets it cross-check our arithmetic (see the server's
// WATER_LEVEL_MISMATCH_PCT flag).
int postReading(const String &url, float tempToSend, float levelToSend, float ammoniaToSend, float distanceToSend)
{
    HTTPClient http;
    http.begin(url);
    http.setConnectTimeout(1000);
    http.setTimeout(1000);
    http.addHeader("Content-Type", "application/json");
    if (strlen(deviceSecret) > 0)
    {
        http.addHeader("X-Device-Secret", deviceSecret);
    }

    // -1 is the failed-sensor sentinel on BOTH water fields, and the server
    // turns it into SQL NULL. It is never 0: a real empty tank is 0%, so 0 is a
    // value the server must store, not discard.
    String payload = "{";
    payload += "\"device_id\":\"" + String(deviceId) + "\",";
    payload += "\"temperature\":" + String(tempToSend, 2) + ",";
    payload += "\"water_level\":" + String(levelToSend, 1) + ",";
    payload += "\"water_distance_cm\":" + String(distanceToSend, 2) + ",";
    payload += "\"ammonia\":" + String(ammoniaToSend, 3);
    payload += "}";

    Serial.print("[HTTP] POST ");
    Serial.println(url);
    Serial.print("[HTTP] Payload: ");
    Serial.println(payload);

    int code = http.POST(payload);
    if (code > 0 && (code < 200 || code >= 300))
    {
        // Rejected by the server (4xx/3xx): print WHY so the serial monitor
        // shows the actual error message, not just the bare code.
        String body = http.getString();
        Serial.printf("[HTTP] Rejected (HTTP %d): ", code);
        Serial.println(body.substring(0, 160));
        if (code == 401)
        {
            Serial.println("[HTTP] 401 = device secret problem. Open the config portal (triple-tap the");
            Serial.println("[HTTP] top-left corner, or send 'W' over serial) and set 'Device Secret' to");
            Serial.println("[HTTP] the same value as DEVICE_SECRET in the server's .env, then save.");
        }
    }
    else if (code > 0)
    {
        // Accepted. The server tells us when it had to CREATE our registry row
        // (auto_registered) rather than match one that already existed - i.e.
        // this board's ID is not registered on the dashboard. That is the exact
        // firmware/registration mismatch this warning exists to surface, and the
        // board's serial monitor is where the Owner will actually see it.
        String body = http.getString();
        if (body.indexOf("\"auto_registered\":true") >= 0)
        {
            static bool warned = false;
            if (!warned)
            {
                warned = true;
                Serial.println("[HTTP] WARNING: the dashboard did not know this device - it");
                Serial.println("[HTTP] auto-registered us as an 'Auto-discovered' tank. Data IS");
                Serial.println("[HTTP] being saved, but the readings cannot be tied to a tank you");
                Serial.println("[HTTP] named. Open the dashboard's Devices page and click 'Add");
                Serial.println("[HTTP] Device' with this exact ID to claim it, or change 'Device ID'");
                Serial.println("[HTTP] in the config portal to the ID you registered.");
                Serial.printf("[HTTP] Our current device ID: '%s'\n", deviceId);
            }
        }
        // The server clamps water_level to 0-100 and echoes back anything it had
        // to correct. Printing it means a calibration problem surfaces on the
        // bench instead of only as a subtly wrong chart.
        if (body.indexOf("\"water_level_clamped\"") >= 0)
        {
            Serial.println("[HTTP] Server corrected water_level (was outside 0-100). Check EMPTY_CM / FULL_CM calibration.");
        }
        if (body.indexOf("\"water_level_mismatch\"") >= 0)
        {
            Serial.println("[HTTP] Server's water_level differs from ours - its stored calibration for this");
            Serial.println("[HTTP] tank disagrees with this board's. Empty/Full cm are set per-tank on the");
            Serial.println("[HTTP] dashboard, or in this board's config portal.");
        }
    }
    http.end();
    return code;
}

void sendSensorData()
{
    float tempToSend = (temperature == -127.0) ? -1.0 : temperature;
    float levelToSend = waterLevel;
    float ammoniaToSend = ammoniaReady ? ammoniaPpm : -1.0;
    // Raw distance rides along so the backend can re-derive the percentage from
    // a corrected calibration without ever reflashing this board.
    float distanceToSend = distance;

    if (WiFi.status() != WL_CONNECTED)
    {
        wifiConnected = false;

        // Buffer the reading so a WiFi outage never loses samples; the buffer
        // is flushed oldest-first once the link and server are reachable.
        sendBufPush(tempToSend, levelToSend, ammoniaToSend, distanceToSend);

        // Exponential-backoff reconnection: 1s, 2s, 4s, ... capped at 5 min.
        // Avoids hammering the AP while coverage/power is down and gives the
        // watchdog/safe-mode recovery time to hold before the next try.
        unsigned long nowMs = millis();
        if (nowMs - lastWifiAttemptMs >= wifiBackoffMs)
        {
            lastWifiAttemptMs = nowMs;
            wifiFailStreak++;
            WiFi.reconnect();
            Serial.printf("[WIFI] Reconnect attempt %d (next backoff %.0fs)\n",
                          wifiFailStreak, wifiBackoffMs / 1000.0);
            wifiBackoffMs = (wifiBackoffMs < 300000UL) ? wifiBackoffMs * 2 : 300000UL;
        }
        return;
    }

    wifiConnected = true;
    autoDeriveServerIp();
    if (wifiFailStreak > 0)
    {
        Serial.printf("[WIFI] Reconnected - fail streak %d cleared, backoff reset\n", wifiFailStreak);
        wifiFailStreak = 0;
        wifiBackoffMs = 1000;
    }

    // Snapshot the backend address under the lock: the config portal runs on the
    // loop task and can rewrite serverIP/serverPort while this task is mid-POST.
    char backendIp[sizeof(serverIP)];
    char backendPort[sizeof(serverPort)];
    copyServerAddress(backendIp, sizeof(backendIp), backendPort, sizeof(backendPort));

    String baseUrl = "http://";
    baseUrl += backendIp;
    baseUrl += ":";
    baseUrl += backendPort;
    baseUrl += "/sensor";

    // Flush any buffered readings, bounded per call so a long backlog never
    // delays live data for many seconds.
    if (sendBufCount > 0)
    {
        int flushed = 0;
        while (sendBufCount > 0 && flushed < 10)
        {
            // Plain floats, not a BufferedReading local: see the note on
            // sendBufPop() about arduino-builder's prototype generator.
            float bufferedTemp;
            float bufferedLevel;
            float bufferedAmmonia;
            float bufferedDistance;
            if (!sendBufPop(bufferedTemp, bufferedLevel, bufferedAmmonia, bufferedDistance))
            {
                break;
            }

            int code = postReading(baseUrl, bufferedTemp, bufferedLevel, bufferedAmmonia, bufferedDistance);
            if (code >= 200 && code < 300)
            {
                flushed++;
            }
            else
            {
                // Not accepted (rejected or transport error): put it back at
                // the head for the next flush attempt. Never count a rejected
                // reading as delivered - a 4xx would silently drop it.
                sendBufRead = (sendBufRead - 1 + SEND_BUFFER_CAP) % SEND_BUFFER_CAP;
                sendBufCount++;
                break;
            }
            // Feed the send-task watchdog (subscribed in sendSensorTask): a
            // long backlog flush (up to 10 posts x ~2s) must never approach
            // the 30s budget. This task is also subscribed to the TWDT itself,
            // so it must reset or the chip reboots mid-flush.
            esp_task_wdt_reset();
            vTaskDelay(25 / portTICK_PERIOD_MS);
        }

        if (flushed > 0)
        {
            Serial.printf("[SEND] Flushed %d buffered reading(s), %d remaining\n", flushed, sendBufCount);
        }
    }

    int httpResponseCode = postReading(baseUrl, tempToSend, levelToSend, ammoniaToSend, distanceToSend);

    if (httpResponseCode >= 200 && httpResponseCode < 300)
    {
        Serial.print("[HTTP] Response code: ");
        Serial.println(httpResponseCode);

        // First successful uplink while in Safe Mode completes the recovery:
        // the loop redraws the normal UI the next tick.
        if (safeModeActive)
        {
            safeModeActive = false;
            safeModeRecovered = true;
            Serial.println("[SAFE MODE] Sensor POST OK - recovery complete, back to normal operation");
        }
    }
    else
    {
        Serial.print("[HTTP] Error: ");
        Serial.println(String(httpResponseCode));

        // The WiFi link is fine here - we got far enough to get a response
        // code, so the backend rejected the reading or the POST timed out.
        // Leave wifiConnected alone: clearing it here made the header dot blink
        // red and /status report "offline" on a perfectly healthy link. The
        // re-queue below is the actual retry mechanism.
        sendBufPush(tempToSend, levelToSend, ammoniaToSend, distanceToSend);
    }
}

// Runs the slow HTTP POST off the main loop. Polls for pending sends so the
// main loop only ever sets a BOOL flag - a slow/unreachable backend can no
// longer freeze touch input for up to a second or two.
void sendSensorTask(void *pvParameters)
{
    esp_task_wdt_add(NULL);
    while (true)
    {
        if (sendPending && !sendBusy)
        {
            sendBusy = true;
            sendPending = false;
            sendSensorData();
            sendBusy = false;
        }
        esp_task_wdt_reset();
        vTaskDelay(50 / portTICK_PERIOD_MS);
    }
}

// =============================================================================
// SAFE MODE - recovery path after a watchdog reset.
// Draws the last-known-good values from NVS, blinks the onboard LED on a
// millis() cadence (never a blocking delay, so the watchdog stays fed), and
// lets normal loop + sendSensorData retry until the first uplink succeeds.
// =============================================================================

void enterSafeMode()
{
    safeModeActive = true;
    loadLastKnownValues();

    pinMode(SAFE_LED_PIN, OUTPUT);
    digitalWrite(SAFE_LED_PIN, LOW);

    Serial.println("================================================");
    Serial.println("[SAFE MODE] Recovering from watchdog reset");
    Serial.printf("[SAFE MODE] Last known: temp %.2f C, water %.1f %%, NH3 %.3f ppm\n",
                  lastGoodTemperature, lastGoodWaterLevel, lastGoodAmmonia);
    Serial.println("================================================");

    if (headlessMode)
    {
        Serial.println("[SAFE MODE] Headless mode - screen drawing skipped");
        return;
    }

    tft.fillScreen(TFT_WHITE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_RED, TFT_WHITE);
    tft.drawString("SAFE MODE", 240, 55, 4);
    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    tft.drawString("Recovering from watchdog reset...", 240, 105, 2);

    char line[40];
    snprintf(line, sizeof(line), "Temp: %.2f C", (lastGoodTemperature == -127.0) ? -1.0 : lastGoodTemperature);
    tft.drawString(line, 240, 145, 2);
    snprintf(line, sizeof(line), "Water: %.1f %%", lastGoodWaterLevel);
    tft.drawString(line, 240, 170, 2);
    snprintf(line, sizeof(line), "NH3: %.3f ppm", lastGoodAmmonia);
    tft.drawString(line, 240, 195, 2);
    tft.setTextColor(TFT_ORANGE, TFT_WHITE);
    tft.drawString("Waiting for uplink to auto-resume...", 240, 240, 2);
}

void setup()
{
    Serial.begin(115200);
    delay(1000);

    // Load persisted device config (server IP/port, device id, secret, tank
    // height, static IP) so a reboot keeps the portal settings.
    loadSystemConfig();

    // Load the runtime simulate/headless flags (Serial commands S / H).
    loadDeviceModes();
    randomSeed(esp_random());

    // Application watchdog: reset the chip if the main loop ever stalls for
    // 30s (e.g. a fatal while(1) loop). On reset, esp_reset_reason() is checked
    // below so the device can recover through Safe Mode instead of bricking.
    // This core exposes the IDF 5.x API: init takes an esp_task_wdt_config_t.
    esp_task_wdt_config_t wdtCfg = {
        .timeout_ms = 30000,
        .idle_core_mask = (1 << portNUM_PROCESSORS) - 1, // idle tasks on every core
        .trigger_panic = true,
    };
    esp_err_t wdtErr = esp_task_wdt_init(&wdtCfg);
    if (wdtErr == ESP_ERR_INVALID_STATE)
    {
        // Already initialized (typically by the core at startup) - just retune
        // the running TWDT instead of erroring out.
        wdtErr = esp_task_wdt_reconfigure(&wdtCfg);
    }
    if (wdtErr != ESP_OK)
    {
        Serial.printf("[WDT] init/reconfigure failed (%d) - watchdog unavailable\n", (int)wdtErr);
    }
    else
    {
        esp_task_wdt_add(NULL); // subscribe the Arduino loop task
        Serial.println("[WDT] Task watchdog armed (30s timeout)");
    }

    // Detect a watchdog-triggered reset and recover into Safe Mode.
    const esp_reset_reason_t resetReason = esp_reset_reason();
    if (resetReason == ESP_RST_TASK_WDT || resetReason == ESP_RST_WDT)
    {
        Serial.printf("[WDT] Boot after watchdog reset (reason=%d) -> Safe Mode\n", (int)resetReason);
        safeModeActive = true;
    }

    Serial.println();
    Serial.println("================================================");
    Serial.println("IoT-Based Smart Aquaculture Monitoring System");
    Serial.println("for Crayfish Production");
    Serial.println("================================================");

    // Prime the DS18B20 with one real (blocking) conversion. With
    // setWaitForConversion(false) the library issues STARTCONVO and returns
    // immediately, and getTempCByIndex() then reads the scratchpad while the
    // 12-bit conversion is still in flight. A DS18B20 powers up with its
    // scratchpad at the 85 C default, so that first read returned 85 C, failed
    // the <= 50 C sanity window and painted a false "SENSOR ERROR" for a full
    // second on boot. One blocking conversion here makes the very first frame
    // show the real temperature, and boot already spends 15s on WiFi.
    // The device count is logged too: 0 means the sensor is not being seen, and
    // every reading will legitimately be SENSOR ERROR. (DallasTemperature 4.x:
    // begin() returns void, the count comes from getDeviceCount().)
    sensors.begin();
    const uint8_t ds18b20Count = sensors.getDeviceCount();
    Serial.print("[OK] DS18B20 -> GPIO13 (");
    Serial.print(ds18b20Count);
    Serial.println(ds18b20Count == 1 ? " sensor found)" : " sensors found)");

    if (ds18b20Count == 0)
    {
        Serial.println("[WARN] No DS18B20 detected - temperature readings will show SENSOR ERROR");
    }

    sensors.setWaitForConversion(true);
    sensors.requestTemperatures();
    delay(750);
    sensors.setWaitForConversion(false);

    pinMode(TRIG_PIN, OUTPUT);
    pinMode(ECHO_PIN, INPUT);
    digitalWrite(TRIG_PIN, LOW);
    Serial.println("[OK] HC-SR04 -> GPIO26 / GPIO27");

    pinMode(MQ137_PIN, INPUT);
    analogReadResolution(12);
    // Explicitly apply the widest input range (~0-3.3V) to GPIO34. Most cores
    // default to full range, but some setups keep a pin on a lower attenuation,
    // which clips the module's analog output and produces wrong readings.
    //
    // The enum value in the Arduino ESP32 core has always been spelled ADC_11db
    // (see esp32-hal-adc.h). The old guard tested
    //   #if  defined(ADC_ATTEN_11db)
    //   #elif defined(ADC_ATTENDB_11)
    // Neither name exists, and both are enum VALUES rather than macros, so
    // defined() could never be true - the call never ran and the "[OK] 11dB
    // attenuation explicitly set" line below was a lie. Now called unconditionally.
    analogSetPinAttenuation(MQ137_PIN, ADC_11db);
    Serial.println("[OK] MQ-137 -> GPIO34 (widest ADC attenuation explicitly set)");

    if (headlessMode)
    {
        Serial.println("[DISPLAY] Headless mode - TFT/touch init skipped");
    }
    else
    {
        pinMode(TOUCH_CS, OUTPUT);
        digitalWrite(TOUCH_CS, HIGH);
        touchSPI.begin(TOUCH_CLK, TOUCH_MISO, TOUCH_MOSI, TOUCH_CS);
        Serial.println("[OK] XPT2046 Touch initialized");

        tft.init();
        tft.setRotation(1);
        tft.fillScreen(TFT_WHITE);
        Serial.print("[DISPLAY] Width = ");
        Serial.println(tft.width());
        Serial.print("[DISPLAY] Height = ");
        Serial.println(tft.height());
    }

    // WiFi: attempt the saved network for 15s, restoring the past working
    // version's visible boot screens. A "Connecting to saved network..." screen
    // is drawn while trying, then "WiFi Connected!" with the IP on success, or
    // the config portal (AP: Aquaculture-Setup) automatically opens on failure
    // so the phone/device can connect and enter the Wi-Fi + backend details.
    Serial.println("[WIFI] Attempting to connect to saved network...");
    if (!headlessMode)
    {
        tft.fillScreen(TFT_WHITE);
        tft.setTextDatum(MC_DATUM);
        tft.setTextColor(TFT_BLACK, TFT_WHITE);
        tft.drawString("WiFi Setup", 240, 80, 4);
        tft.drawString("Connecting to saved network...", 240, 130, 2);
        tft.drawString("Tap top-left corner 3x to config", 240, 200, 2);
    }

    WiFi.mode(WIFI_STA);

    // Apply the persisted static IP (192.168.4.x) BEFORE connecting; calling
    // WiFi.config() after WiFi.begin() can silently ignore the static address.
    applyStaticIpConfig();

    WiFi.begin();

    unsigned long startAttemptTime = millis();
    bool connected = false;

    while (millis() - startAttemptTime < 15000)
    {
        if (WiFi.status() == WL_CONNECTED)
        {
            connected = true;
            break;
        }
        // Keep the loop-task watchdog fed: this wait runs before reconnection
        // handling in sendSensorData() takes over in the background task.
        esp_task_wdt_reset();
        delay(100);
    }

    if (connected)
    {
        wifiConnected = true;
        autoDeriveServerIp();
        Serial.println("[WIFI] Connected to saved network!");
        Serial.print("[WIFI] IP: ");
        Serial.println(WiFi.localIP());

        if (!headlessMode)
        {
            tft.fillScreen(TFT_WHITE);
            tft.setTextDatum(MC_DATUM);
            tft.setTextColor(TFT_BLACK, TFT_WHITE);
            tft.drawString("WiFi Connected!", 240, 100, 4);
            tft.drawString("IP: " + String(WiFi.localIP().toString()), 240, 150, 2);
            delay(1500);
        }
    }
    else
    {
        wifiConnected = false;
        Serial.println("[WIFI] No saved network or connection failed.");
        if (safeModeActive)
        {
            Serial.println("[WIFI] Safe Mode: skipping config portal, will retry on backoff.");
        }
        else
        {
            Serial.println("[WIFI] Starting configuration portal (AP: Aquaculture-Setup)...");
            startWifiConfigPortal();
        }
    }

    // Expose GET /status (and /) so the central server can read this device.
    startStatusServer();

    // Load a previously calibrated MQ-137 R0, or run the clean-air calibration
    // on first boot (needs the display up, since it shows progress on screen).
    // refreshMq137R0Once() forces one fresh calibration the first boot after a
    // firmware update, so an R0 stored under the old RL value is thrown away
    // instead of being loaded silently.
    if (simulateDevice)
    {
        // Virtual tank: no MQ-137 module attached, so there is nothing to
        // calibrate (a floating pin would produce a garbage/failed R0).
        Serial.println("[MQ-137] Simulation mode - skipping R0 calibration");
    }
    else if (refreshMq137R0Once() || !loadMq137R0())
    {
        Serial.println("[MQ-137] No valid R0 - starting clean-air calibration...");
        calibrateMq137R0();
    }
    else
    {
        Serial.printf("[MQ-137] Loaded R0 = %.2f kOhm from NVS\n", mq137R0);
    }

    // One full initial sensor read so the UI shows live values right away.
    // Runs after R0 calibration so the first ammonia sample is not a -1 blip.
    readAllSensors();

    currentPage = PAGE_OVERVIEW;
    if (!headlessMode)
    {
        drawCurrentPage();
    }

    if (safeModeActive)
    {
        enterSafeMode();
    }

    // Send sensor data on a background task so the blocking HTTP POST (which
    // can stall for ~1-2s on a slow/unreachable server) never freezes touch
    // or the display.
    xTaskCreate(sendSensorTask, "sendSensor", 8192, NULL, 1, NULL);

    Serial.println();
    Serial.println("[SYSTEM] READY");
    Serial.println("[SYSTEM] Tap RIGHT arrow = Next Page");
    Serial.println("[SYSTEM] Tap LEFT arrow  = Previous Page");
    Serial.println("[SYSTEM] Tap top-left corner 3x = WiFi Config");
    Serial.println("[SYSTEM] Tap top-right corner 3x = MQ-137 Recalibrate");
    Serial.println("[SERIAL] Commands: 'C' = MQ-137 calibrate, 'T' = touch raw test, 'R' = read sensors, 'W' = WiFi portal, 'S' = toggle simulate, 'H' = toggle headless");
    Serial.println();
}

// Streams raw XPT2046 values for 5s so touch state can be diagnosed on the
// Serial Monitor even when the screen does nothing. Press and move on the
// panel during the window.
void touchRawDump()
{
    Serial.println("[TOUCH] Raw dump for 5s - press the screen");
    Serial.println("[TOUCH]    Z1    Z2  rawX  rawY");
    unsigned long end = millis() + 5000;
    unsigned long count = 0;
    while (millis() < end)
    {
        uint16_t z1 = readTouchRaw(XPT2046_Z1);
        uint16_t z2 = readTouchRaw(XPT2046_Z2);
        uint16_t rx = readTouchRaw(XPT2046_X);
        uint16_t ry = readTouchRaw(XPT2046_Y);
        Serial.printf("[TOUCH]  %4u  %4u  %4u  %4u\n", z1, z2, rx, ry);
        count++;
        delay(50);
    }
    Serial.printf("[TOUCH] Dump finished. %lu frames.\n", count);
}

// Simple serial command interface, independent of the (possibly broken) touch:
//   C = run MQ-137 clean-air calibration
//   T = 5s raw XPT2046 dump (touch diagnostics)
//   R = force one full sensor read + serial print
//   W = open the WiFi configuration portal
void checkSerialCommands()
{
    if (Serial.available() <= 0)
    {
        return;
    }

    char cmd = Serial.read();
    while (Serial.available())
    {
        Serial.read();
    }

    switch (cmd)
    {
        case 'c':
        case 'C':
            if (headlessMode || simulateDevice)
            {
                Serial.println("[CMD] MQ-137 calibration is not available in headless/simulation mode.");
            }
            else
            {
                Serial.println("[CMD] MQ-137 calibration requested (clean air required)...");
                calibrateMq137R0();
                tft.fillScreen(TFT_WHITE);
                drawCurrentPage();
            }
            break;

        case 't':
        case 'T':
            if (headlessMode)
            {
                Serial.println("[CMD] Touch raw test is not available in headless mode.");
            }
            else
            {
                touchRawDump();
            }
            break;

        case 'r':
        case 'R':
            readAllSensors();
            break;

        case 'w':
        case 'W':
            Serial.println("[CMD] Opening WiFi configuration portal...");
            Serial.println("[CMD] On your phone or any device:");
            Serial.println("[CMD]   1) Open Wi-Fi settings");
            Serial.println("[CMD]   2) Connect to AP: Aquaculture-Setup");
            Serial.println("[CMD]   3) Open browser to http://192.168.4.1 to configure");
            startWifiConfigPortal();
            break;

        case 's':
        case 'S':
            simulateDevice = !simulateDevice;
            saveDeviceModes();
            Serial.printf("[CMD] Simulation mode %s (virtual tank)\n",
                          simulateDevice ? "ON" : "OFF");
            readAllSensors();
            break;

        case 'h':
        case 'H':
            headlessMode = !headlessMode;
            saveDeviceModes();
            Serial.printf("[CMD] Headless mode %s (takes effect on next boot)\n",
                          headlessMode ? "ON" : "OFF");
            break;

        default:
            Serial.println("[CMD] Unknown. Commands: C=calibrate MQ-137, T=touch raw test, R=read sensors, W=WiFi portal, S=toggle simulate, H=toggle headless");
            break;
    }
}

void loop()
{
    unsigned long now = millis();

    // Touch is serviced FIRST on every tick so a tap never waits behind
    // sensor reads, screen redraws, or Wi-Fi sends. Skipped in headless mode
    // (no touch panel attached - a floating CS pin can register phantom taps)
    // and while Safe Mode is up: a tap there used to navigate to a normal page
    // and paint over the SAFE MODE recovery screen, hiding the last-known-good
    // values. Safe Mode always leaves on its own, via the first good uplink.
    if (!headlessMode && !safeModeActive)
    {
        handleTouch();
    }

    // Safe Mode recovery: blink the LED (millis-based, never blocks), keep
    // reading sensors for NVS, and redraw the normal UI once the first POST
    // succeeded.
    if (safeModeActive)
    {
        if (now - lastSafeBlinkMs >= 500)
        {
            lastSafeBlinkMs = now;
            safeLedOn = !safeLedOn;
            digitalWrite(SAFE_LED_PIN, safeLedOn ? HIGH : LOW);
        }
    }
    else if (safeModeRecovered)
    {
        safeModeRecovered = false;
        Serial.println("[SAFE MODE] Normal UI restored");
        if (!headlessMode)
        {
            tft.fillScreen(TFT_WHITE);
            currentPage = PAGE_OVERVIEW;
            drawCurrentPage();
        }
    }

    if (now - lastSensorRead >= SENSOR_INTERVAL)
    {
        lastSensorRead = now;
        readAllSensors();

        if (!safeModeActive && !headlessMode)
        {
            updateCurrentPage();
        }
    }

    // Self-healing MQ-137: no usable R0 yet means every ammonia read is an
    // error. Re-probe quietly (no screen takeover, ~100ms) on a long interval
    // so plugging the module in later revives the page on its own. Once mq137R0
    // is set this whole block is skipped forever, so the retry budget can only
    // ever be spent while the sensor is genuinely unusable.
    if (!simulateDevice && mq137R0 <= 0.0f && mq137RecalTries < MQ137_RECAL_MAX_TRIES &&
        now - lastMq137RecalMs >= MQ137_RECAL_RETRY_MS)
    {
        lastMq137RecalMs = now;
        mq137RecalTries++;

        if (probeMq137R0Quietly())
        {
            Serial.printf("[MQ-137] Auto-recovered R0 = %.2f kOhm (attempt %d) - ammonia readings live\n",
                          mq137R0, mq137RecalTries);
        }
        else
        {
            Serial.printf("[MQ-137] Still no usable R0 (attempt %d/%d, raw=%d) - ammonia reads stay ERROR\n",
                          mq137RecalTries, MQ137_RECAL_MAX_TRIES, mq137Raw);
        }
    }

    checkSerialCommands();

    // Slow POST is handled by the background task - main loop only sets a flag.
    if (now - lastSendTime >= SEND_INTERVAL)
    {
        lastSendTime = now;
        sendPending = true;
    }

    if (wifiConfigRequested)
    {
        startWifiConfigPortal();
    }

    // Feed the task watchdog and yield. vTaskDelay replaces delay() because it
    // lets lower-priority tasks run and is the standard loop pacing for the
    // ESP32 Arduino core.
    esp_task_wdt_reset();
    vTaskDelay(1 / portTICK_PERIOD_MS);
}