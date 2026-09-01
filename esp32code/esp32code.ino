#include <Arduino.h>
#include <FS.h>
#include <TFT_eSPI.h>
#include <SPI.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <math.h>
#include <Preferences.h>

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

#define MIN_PRESSURE 100

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

#define MQ137_RL_KOHM   1.0    // Load resistor on your module (kOhm). Default 1.0 (common SMD)
#define MQ137_VC_VOLTS  5.0    // Sensor circuit supply (module VCC; usually 5V)

#define MQ137_CURVE_M   -0.263 // NH3 log-log slope:      log(Rs/R0) = m*log(ppm) + b
#define MQ137_CURVE_B   0.42   // NH3 log-log intercept b
#define MQ137_CLEAN_AIR_RATIO 3.6  // Rs/R0 expected in clean air (datasheet)
#define MQ137_PPM_MAX   500.0  // Datasheet NH3 range upper bound (5-500 ppm)
#define MQ137_SAT_VOLTS 3.24   // ADC saturation threshold (11dB attenuation ~3.3V)
#define MQ137_EMA_ALPHA 0.2    // Smoothing factor for the displayed ppm
#define MQ137_PPM_DEADBAND 0.1 // Don't repaint unless ppm changes by this much

float mq137R0 = 0.0;        // Sensor resistance in clean air (kOhm), persisted in NVS
float mq137RsKohm = 0.0;    // Latest computed sensor resistance (kOhm, diagnostics)
float mq137Ratio = 0.0;     // Latest Rs/R0 (diagnostics)
float ammoniaPpm = -1.0;    // Computed NH3 concentration (ppm); -1 = sensor failed
float mq137PpmEma = -1.0;   // Smoothed ppm
float lastShownPpm = -1.0;  // Last ppm painted to the screen (deadbanded)
bool ammoniaReady = false;  // True once a valid reading has been produced

// =============================================================================
// SENSOR VALUES
// =============================================================================

float temperature = -127.0;
float distance = -1.0;
float waterLevel = 0.0;
int mq137Raw = 0;
float mq137Voltage = 0.0;

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
uint16_t lastTouchX = 0;
uint16_t lastTouchY = 0;
unsigned long lastPageChange = 0;
#define PAGE_CHANGE_COOLDOWN 500

// =============================================================================
// WIFI & BACKEND CONFIG
// =============================================================================

#define DEVICE_ID_DEFAULT "ESP32_01"
#define SERVER_IP_DEFAULT "192.168.1.16"
#define SERVER_PORT_DEFAULT "3000"
#define SEND_INTERVAL 1000

char serverIP[50] = SERVER_IP_DEFAULT;
char serverPort[10] = SERVER_PORT_DEFAULT;
char deviceId[50] = DEVICE_ID_DEFAULT;

unsigned long lastSendTime = 0;
bool wifiConnected = false;

// Flag to trigger WiFi configuration
bool wifiConfigRequested = false;

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

    if (
        z1 > MIN_PRESSURE &&
        z1 < 4000 &&
        z2 > MIN_PRESSURE &&
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
        waterLevel = 0.0;
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

    float waterHeight = TANK_HEIGHT_CM - distance;

    if (waterHeight < 0)
    {
        waterHeight = 0;
    }

    if (waterHeight > TANK_HEIGHT_CM)
    {
        waterHeight = TANK_HEIGHT_CM;
    }

    float level = (waterHeight / TANK_HEIGHT_CM) * 100.0;
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

    for (int i = 0; i < samples; i++)
    {
        mq137Raw = analogRead(MQ137_PIN);
        mq137Voltage = analogReadMilliVolts(MQ137_PIN) / 1000.0f;

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

    if (good == 0)
    {
        Serial.println("[MQ-137] Calibration failed: no valid readings!");
        tft.fillScreen(TFT_WHITE);
        tft.setTextDatum(MC_DATUM);
        tft.setTextColor(TFT_BLACK, TFT_WHITE);
        tft.drawString("CALIBRATION FAILED", 240, 100, 4);
        tft.drawString("Check MQ-137 wiring/power", 240, 150, 2);
        delay(2000);
        return;
    }

    float rsAvg = sum / good;
    mq137R0 = rsAvg / MQ137_CLEAN_AIR_RATIO;
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
    mq137Raw = analogRead(MQ137_PIN);
    mq137Voltage = analogReadMilliVolts(MQ137_PIN) / 1000.0f;

    // ~0V output: module unpowered/disconnected -> mark the sensor as failed
    if (mq137Raw < 8)
    {
        ammoniaReady = false;
        ammoniaPpm = -1.0f;
        return;
    }

    float rs = mq137RsFromVoltage();
    if (rs <= 0.0f)
    {
        ammoniaReady = false;
        ammoniaPpm = -1.0f;
        return;
    }

    mq137RsKohm = rs;

    if (mq137R0 <= 0.0f)
    {
        // No calibration data yet -> can't compute a ratio, flag the error.
        ammoniaReady = false;
        ammoniaPpm = -1.0f;
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
}

// =============================================================================
// HEADER
// =============================================================================

void drawHeader(const char *title)
{
    tft.fillRect(0, 0, 480, 55, TFT_BLUE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_WHITE, TFT_BLUE);
    tft.drawString(title, 240, 27, 4);

    if (wifiConnected)
    {
        tft.fillCircle(465, 27, 5, TFT_GREEN);
    }
    else
    {
        tft.fillCircle(465, 27, 5, TFT_RED);
    }
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

    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    tft.setTextDatum(TL_DATUM);
    tft.drawString("HC-SR04", 265, 195, 2);

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
    snprintf(levelText, sizeof(levelText), "%.1f %%", waterLevel);
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

    if (waterLevel < 20.0)
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
    snprintf(levelText, sizeof(levelText), "%.1f %%", waterLevel);
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
    snprintf(levelText, sizeof(levelText), "%.1f %%", waterLevel);

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
    tft.drawString(rawText, 240, 195, 3);

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
    tft.drawString("NH3 gas concentration in air", 240, 275, 2);
    tft.drawString("Triple-tap top-right: recalibrate", 240, 295, 2);
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
    tft.drawString(rawText, 240, 195, 3);
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

    drawNavigation();
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

    drawNavigation();
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

    drawNavigation();

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

    tft.fillScreen(TFT_WHITE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    tft.drawString("WiFi Setup", 240, 80, 4);
    tft.drawString("Connect to AP:", 240, 130, 2);
    tft.drawString("Aquaculture-Setup", 240, 160, 4);
    tft.drawString("to configure WiFi", 240, 200, 2);
    tft.drawString("Timeout: 3 minutes", 240, 240, 2);

    WiFi.mode(WIFI_AP_STA);
    WiFiManager wm;

    WiFiManagerParameter serverIPParam(
        "server_ip",
        "Backend Server IP (e.g. 192.168.1.100)",
        SERVER_IP_DEFAULT,
        50
    );

    WiFiManagerParameter serverPortParam(
        "server_port",
        "Backend Server Port",
        SERVER_PORT_DEFAULT,
        6
    );

    WiFiManagerParameter deviceIdParam(
        "device_id",
        "Device ID (e.g. ESP32_01)",
        DEVICE_ID_DEFAULT,
        50
    );

    wm.addParameter(&serverIPParam);
    wm.addParameter(&serverPortParam);
    wm.addParameter(&deviceIdParam);

    wm.setConfigPortalTimeout(180);
    wm.setConnectTimeout(10);

    bool wifiResult = wm.autoConnect("Aquaculture-Setup");

    if (wifiResult)
    {
        wifiConnected = true;
        Serial.println("[WIFI] Connected!");
        Serial.print("[WIFI] IP: ");
        Serial.println(WiFi.localIP());

        strncpy(serverIP, serverIPParam.getValue(), sizeof(serverIP) - 1);
        strncpy(serverPort, serverPortParam.getValue(), sizeof(serverPort) - 1);
        strncpy(deviceId, deviceIdParam.getValue(), sizeof(deviceId) - 1);

        serverIP[sizeof(serverIP) - 1] = '\0';
        serverPort[sizeof(serverPort) - 1] = '\0';
        deviceId[sizeof(deviceId) - 1] = '\0';

        Serial.print("[WIFI] Backend: ");
        Serial.print(serverIP);
        Serial.print(":");
        Serial.println(serverPort);
        Serial.print("[WIFI] Device ID: ");
        Serial.println(deviceId);

        tft.fillScreen(TFT_WHITE);
        tft.setTextDatum(MC_DATUM);
        tft.setTextColor(TFT_BLACK, TFT_WHITE);
        tft.drawString("WiFi Connected!", 240, 100, 4);
        tft.drawString("IP: " + String(WiFi.localIP().toString()), 240, 150, 2);
        delay(2000);
    }
    else
    {
        wifiConnected = false;
        Serial.println("[WIFI] Timeout or failed. Running offline.");

        tft.fillScreen(TFT_WHITE);
        tft.setTextDatum(MC_DATUM);
        tft.setTextColor(TFT_BLACK, TFT_WHITE);
        tft.drawString("WiFi Setup Failed", 240, 100, 4);
        tft.drawString("Running in offline mode", 240, 150, 2);
        delay(2000);
    }

    wifiConfigRequested = false;
    tft.fillScreen(TFT_WHITE);
    drawCurrentPage();
}

void sendSensorData()
{
    if (WiFi.status() != WL_CONNECTED)
    {
        wifiConnected = false;
        return;
    }

    wifiConnected = true;

    HTTPClient http;
    String url = "http://";
    url += serverIP;
    url += ":";
    url += serverPort;
    url += "/sensor";

    http.begin(url);
    http.setConnectTimeout(1000);
    http.setTimeout(1000);
    http.addHeader("Content-Type", "application/json");

    float tempToSend = (temperature == -127.0) ? -1.0 : temperature;
    float ammoniaToSend = ammoniaReady ? ammoniaPpm : -1.0;

    String payload = "{";
    payload += "\"device_id\":\"" + String(deviceId) + "\",";
    payload += "\"temperature\":" + String(tempToSend, 2) + ",";
    payload += "\"water_level\":" + String(waterLevel, 1) + ",";
    payload += "\"ammonia\":" + String(ammoniaToSend, 3);
    payload += "}";

    Serial.print("[HTTP] POST ");
    Serial.println(url);
    Serial.print("[HTTP] Payload: ");
    Serial.println(payload);

    int httpResponseCode = http.POST(payload);

    if (httpResponseCode > 0)
    {
        Serial.print("[HTTP] Response code: ");
        Serial.println(httpResponseCode);
    }
    else
    {
        Serial.print("[HTTP] Error: ");
        Serial.println(http.errorToString(httpResponseCode));

        wifiConnected = false;
    }

    http.end();
}

void setup()
{
    Serial.begin(115200);
    delay(1000);

    Serial.println();
    Serial.println("================================================");
    Serial.println("IoT-Based Smart Aquaculture Monitoring System");
    Serial.println("for Crayfish Production");
    Serial.println("================================================");

    sensors.begin();
    sensors.setWaitForConversion(false);
    Serial.println("[OK] DS18B20 -> GPIO13");

    pinMode(TRIG_PIN, OUTPUT);
    pinMode(ECHO_PIN, INPUT);
    digitalWrite(TRIG_PIN, LOW);
    Serial.println("[OK] HC-SR04 -> GPIO26 / GPIO27");

    pinMode(MQ137_PIN, INPUT);
    analogReadResolution(12);
    // No analogSetPinAttenuation() call here on purpose: ALL ESP32 Arduino cores
    // default ADC pins to 11dB attenuation (~3.1V max), and the attenuation
    // enum names (ADC_ATTENDB_11 / ADC_ATTEN_DB_11 / ADC_11db) differ across
    // core versions, which caused a compile error on older cores.
    Serial.println("[OK] MQ-137 -> GPIO34 (default 11dB attenuation, 3.3V ADC)");

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

    Serial.println("[WIFI] Attempting to connect to saved network...");
    tft.fillScreen(TFT_WHITE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    tft.drawString("WiFi Setup", 240, 80, 4);
    tft.drawString("Connecting to saved network...", 240, 130, 2);
    tft.drawString("Tap top-left corner 3x to config", 240, 200, 2);

    WiFi.mode(WIFI_STA);

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
        delay(100);
    }

    if (connected)
    {
        wifiConnected = true;
        Serial.println("[WIFI] Connected to saved network!");
        Serial.print("[WIFI] IP: ");
        Serial.println(WiFi.localIP());
        tft.fillScreen(TFT_WHITE);
        tft.setTextDatum(MC_DATUM);
        tft.setTextColor(TFT_BLACK, TFT_WHITE);
        tft.drawString("WiFi Connected!", 240, 100, 4);
        tft.drawString("IP: " + String(WiFi.localIP().toString()), 240, 150, 2);
        delay(1500);
    }
    else
    {
        Serial.println("[WIFI] No saved network or connection failed.");
        Serial.println("[WIFI] Starting configuration portal...");

        startWifiConfigPortal();
    }

    readAllSensors();

    // Load a previously calibrated MQ-137 R0, or run the clean-air calibration
    // on first boot (needs the display up, since it shows progress on screen).
    if (!loadMq137R0())
    {
        Serial.println("[MQ-137] No saved R0 - starting clean-air calibration...");
        calibrateMq137R0();
    }
    else
    {
        Serial.printf("[MQ-137] Loaded R0 = %.2f kOhm from NVS\n", mq137R0);
    }

    currentPage = PAGE_OVERVIEW;
    drawCurrentPage();

    Serial.println();
    Serial.println("[SYSTEM] READY");
    Serial.println("[SYSTEM] Tap RIGHT arrow = Next Page");
    Serial.println("[SYSTEM] Tap LEFT arrow  = Previous Page");
    Serial.println("[SYSTEM] Tap top-left corner 3x = WiFi Config");
    Serial.println("[SYSTEM] Tap top-right corner 3x = MQ-137 Recalibrate");
    Serial.println();
}

void loop()
{
    unsigned long now = millis();

    if (now - lastSensorRead >= SENSOR_INTERVAL)
    {
        lastSensorRead = now;
        readAllSensors();

        updateCurrentPage();
    }

    handleTouch();

    if (now - lastSendTime >= SEND_INTERVAL)
    {
        lastSendTime = now;
        sendSensorData();
    }

    if (wifiConfigRequested)
    {
        startWifiConfigPortal();
    }

    delay(2);
}