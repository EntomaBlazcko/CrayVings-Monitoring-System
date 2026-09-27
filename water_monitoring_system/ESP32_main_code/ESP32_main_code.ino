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
// HC-SR04
// =============================================================================

#define TRIG_PIN 26
#define ECHO_PIN 27

#define TANK_HEIGHT_CM 36.0

float tankHeightCm = TANK_HEIGHT_CM;

// HC-SR04 filtering: the module needs ~60ms between pings, so we do NOT sample
// back-to-back (that causes echo crosstalk / false readings). Instead we fire one
// ping per read (every 1s) and smooth across successive reads, with spike
// rejection and a display deadband so the shown value stays rock-solid.
#define DISTANCE_JUMP_CM 5.0
#define DISTANCE_EMA_ALPHA 0.3
#define WATER_LEVEL_DEADBAND 1.0

float filteredDistance = -1.0;
float lastShownLevel = -1.0;

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
float distance = -1.0;
float waterLevel = 0.0;
int mq137Raw = 0;
float mq137Voltage = 0.0;

// =============================================================================
// FAILURE HANDLING (Watchdog / Safe Mode)
// =============================================================================

#define SAFE_LED_PIN 2   // Onboard LED on most ESP32 dev boards; safe to toggle

bool safeModeActive = false;    // Set after a watchdog reset; cleared on recovery
bool safeModeRecovered = false; // Loop redraws the normal UI once set
float lastGoodTemperature = -127.0;  // Last-known-good snapshot for Safe Mode
float lastGoodWaterLevel = 0.0;
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

// Backend IP when no portal override has been saved. If serverIP is still this
// placeholder after the device connects to WiFi, autoDeriveServerIp() rewrites
// it to the WiFi subnet + SERVER_IP_HOST_OCTET (e.g. on 192.168.1.x it becomes
// 192.168.1.10). Change SERVER_IP_HOST_OCTET to your server's host octet, or
// enter the real IP in the config portal.
#define SERVER_IP_DEFAULT "192.168.4.10"
#define SERVER_IP_HOST_OCTET 20

#define SERVER_PORT_DEFAULT "3000"
#define SEND_INTERVAL 1000

char serverIP[50] = SERVER_IP_DEFAULT;
char serverPort[10] = SERVER_PORT_DEFAULT;
char deviceId[50] = DEVICE_ID_DEFAULT;
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
} BufferedReading;

BufferedReading sendBuf[SEND_BUFFER_CAP];
int sendBufWrite = 0;
int sendBufRead = 0;
int sendBufCount = 0;

bool sendBufPush(float temp, float level, float ammonia)
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
    sendBufWrite = (sendBufWrite + 1) % SEND_BUFFER_CAP;
    sendBufCount++;
    return true;
}

bool sendBufPop(BufferedReading &out)
{
    if (sendBufCount == 0)
    {
        return false;
    }

    out = sendBuf[sendBufRead];
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

    // Device ID is pinned to the compiled-in DEVICE_ID_DEFAULT (ESP32_01);
    // never editable via the config portal, so a board can't register under a
    // random name. Friendly tank names are set on the dashboard instead.
    val = prefs.getString("device_secret", "");
    strncpy(deviceSecret, val.c_str(), sizeof(deviceSecret) - 1);
    deviceSecret[sizeof(deviceSecret) - 1] = '\0';

    tankHeightCm = prefs.getFloat("tank_height", TANK_HEIGHT_CM);

    prefs.end();
    loadStaticIpConfig();

    Serial.printf("[CONFIG] server=%s:%s device_id=%s tank_height=%.1f static_ip=%s\n",
                  serverIP, serverPort, deviceId, tankHeightCm,
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
    prefs.putFloat("tank_height", tankHeightCm);
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

void readWaterLevel()
{
    if (simulateDevice)
    {
        // Virtual tank: random walk around ~75% within the 10-100% band.
        simLevel += ((int)esp_random() % 31 - 15) / 10.0f; // ~ +/-1.5%
        simLevel = constrain(simLevel, 10.0f, 100.0f);
        waterLevel = simLevel;
        return;
    }

    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);

    long duration = pulseIn(ECHO_PIN, HIGH, 30000);

    if (duration == 0)
    {
        filteredDistance = -1.0;
        distance = -1.0;
        waterLevel = -1.0;
        return;
    }

    float rawDistance = duration * 0.0343 / 2.0;
    static int spikeStreak = 0;

    if (filteredDistance < 0.0)
    {
        filteredDistance = rawDistance;
    }
    else if (fabsf(rawDistance - filteredDistance) <= DISTANCE_JUMP_CM)
    {
        // Normal reading: ease the filtered distance toward it (smooths jitter).
        spikeStreak = 0;
        filteredDistance += (rawDistance - filteredDistance) * DISTANCE_EMA_ALPHA;
    }
    else
    {
        // Big jump: likely a spurious echo. Only accept if it repeats next read.
        spikeStreak++;
        if (spikeStreak >= 2)
        {
            filteredDistance = rawDistance;
            spikeStreak = 0;
        }
    }

    distance = filteredDistance;

    float waterHeight = tankHeightCm - distance;

    if (waterHeight < 0)
    {
        waterHeight = 0;
    }

    if (waterHeight > tankHeightCm)
    {
        waterHeight = tankHeightCm;
    }

    float level = (waterHeight / tankHeightCm) * 100.0;
    level = constrain(level, 0.0, 100.0);

    // Deadband: keep showing the last level until a real change of at least
    // WATER_LEVEL_DEADBAND% happens, so the screen never jitters over noise.
    if (lastShownLevel < 0.0 || fabsf(level - lastShownLevel) >= WATER_LEVEL_DEADBAND)
    {
        lastShownLevel = level;
    }

    waterLevel = lastShownLevel;
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
    lastGoodWaterLevel = prefs.getFloat("water", 0.0);
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

    Serial.print("Water Level: ");
    Serial.print(waterLevel, 1);
    Serial.println(" %");

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
        "Backend Server IP (e.g. 192.168.1.100)",
        serverIP,
        50
    );

    WiFiManagerParameter serverPortParam(
        "server_port",
        "Backend Server Port",
        serverPort,
        6
    );

    char tankHeightText[10];
    snprintf(tankHeightText, sizeof(tankHeightText), "%.1f", tankHeightCm);

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

    WiFiManagerParameter tankHeightParam(
        "tank_height_cm",
        "Tank Height (cm)",
        tankHeightText,
        9
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
    wm.addParameter(&deviceSecretParam);
    wm.addParameter(&tankHeightParam);
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

        tankHeightCm = atof(tankHeightParam.getValue());
        if (tankHeightCm < 5.0 || tankHeightCm > 200.0)
        {
            tankHeightCm = TANK_HEIGHT_CM;
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
    json += "\"water_level\":" + String(waterLevel, 1) + ",";
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
int postReading(const String &url, float tempToSend, float levelToSend, float ammoniaToSend)
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

    String payload = "{";
    payload += "\"device_id\":\"" + String(deviceId) + "\",";
    payload += "\"temperature\":" + String(tempToSend, 2) + ",";
    payload += "\"water_level\":" + String(levelToSend, 1) + ",";
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
    http.end();
    return code;
}

void sendSensorData()
{
    float tempToSend = (temperature == -127.0) ? -1.0 : temperature;
    float levelToSend = waterLevel;
    float ammoniaToSend = ammoniaReady ? ammoniaPpm : -1.0;

    if (WiFi.status() != WL_CONNECTED)
    {
        wifiConnected = false;

        // Buffer the reading so a WiFi outage never loses samples; the buffer
        // is flushed oldest-first once the link and server are reachable.
        sendBufPush(tempToSend, levelToSend, ammoniaToSend);

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
            BufferedReading r;
            if (!sendBufPop(r))
            {
                break;
            }

            int code = postReading(baseUrl, r.temp, r.level, r.ammonia);
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

    int httpResponseCode = postReading(baseUrl, tempToSend, levelToSend, ammoniaToSend);

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
        sendBufPush(tempToSend, levelToSend, ammoniaToSend);
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