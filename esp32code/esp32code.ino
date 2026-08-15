// =============================================================================
// FILE: esp32code/esp32code.ino
// =============================================================================
// PURPOSE: ESP32 firmware for the CRAYvings aquaculture monitoring system.
//
//   - Reads DS18B20 temperature, HC-SR04 water level, and simulated ammonia
//   - Posts readings as JSON to the backend server every second
//   - WiFi configuration via WiFiManager captive portal
//   - 3.5" ILI9488 touchscreen (480x320) with:
//       * Overview page showing all three sensors at once
//       * Individual pages for temperature, water level, and ammonia
//       * Left/right swipe (or tap) to switch between the four pages
//
// DISPLAY PIN WARNING:
//   The TFT pins are configured in the TFT_eSPI library (User_Setup.h) and
//   MUST NOT collide with the sensor pins below. If your TFT uses GPIO4,
//   GPIO5, or GPIO18, move the sensors to free pins instead
//   (e.g. ONE_WIRE_BUS 15, TRIG_PIN 25, ECHO_PIN 26) and rewire accordingly.
// =============================================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <esp_task_wdt.h>
#include <TFT_eSPI.h>
#include <Preferences.h>

#define ONE_WIRE_BUS 4
#define TRIG_PIN 5
#define ECHO_PIN 18

char serverName[64] = "http://192.168.100.16:3000/sensor";

const float TANK_HEIGHT_CM = 36.0f;
const int ULTRASONIC_SAMPLES = 5;
const int SAMPLE_DELAY_MS = 50;
const int LOOP_DELAY_MS = 1000;
const int HTTP_TIMEOUT_MS = 5000;
const int WIFI_CONNECT_TIMEOUT_MS = 20000;

const float TEMP_VALID_MIN = 0.0f;
const float TEMP_VALID_MAX = 50.0f;
const float WATER_LEVEL_VALID_MIN = 0.0f;
const float WATER_LEVEL_VALID_MAX = 100.0f;
const float TEMP_SENSOR_ERROR = -127.0f;
const float DISTANCE_SENSOR_ERROR = -1.0f;

// ===== AMMONIA SENSOR (SIMULATION) =====
// NOTE: No physical ammonia sensor is connected yet. readAmmonia() returns a
// simulated reading so the whole stack can be tested end-to-end. Replace the
// body of readAmmonia() with a real sensor read (e.g., MQ-137 on an analog
// pin) once the hardware is available.
const float AMMONIA_VALID_MIN = 0.0f;
const float AMMONIA_VALID_MAX = 1.0f;      // mg/L
const float AMMONIA_SIM_BASE = 0.12f;      // healthy baseline level (mg/L)
const float AMMONIA_SIM_AMPLITUDE = 0.08f; // slow oscillation amplitude (mg/L)

const char* DEVICE_ID = "ESP32_01";

OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

WiFiManager wm;

// =============================================================================
// DISPLAY CONFIGURATION
// =============================================================================
// 3.5" ILI9488 (480x320) with resistive touch; pins are set in TFT_eSPI's
// User_Setup.h (including TOUCH_CS).

TFT_eSPI tft = TFT_eSPI();
Preferences gPrefs;

// Page ordering shown on screen
enum {
  PAGE_OVERVIEW = 0,  // all three sensors at once
  PAGE_TEMP     = 1,  // temperature
  PAGE_WATER    = 2,  // water level
  PAGE_AMMONIA  = 3,  // ammonia
  PAGE_COUNT    = 4
};

// Timing / interaction tuning
#define TOUCH_POLL_MS      40     // touch read rate
#define DISPLAY_REFRESH_MS 150    // display refresh rate
#define SWIPE_DIST_X       60     // horizontal px to register a swipe
#define TAP_DIST_X         25     // max px treated as a tap
#define TAP_DIST_Y         40
#define TOUCH_COOLDOWN_MS  250    // debounce after a page change

// RGB565 palette (mirrors the web dashboard's accent colors)
#define COL_BG       0x0000
#define COL_HEADER   0x10A2
#define COL_PANEL    0x0841
#define COL_ACCENT   0xFD20   // orange
#define COL_TEMP     0xFD20   // orange
#define COL_WATER    0x295F   // blue
#define COL_AMMONIA  0x07E0   // green
#define COL_OK       0x07E0
#define COL_BAD      0xF800
#define COL_TEXT     0xFFFF
#define COL_MUTED    0x7BEF
#define COL_DOT_IDLE 0x3186

// Latest readings cached for the display
float gTemp = NAN;
float gLevel = NAN;
float gAmmonia = NAN;
bool  gTempOK = false;
bool  gLevelOK = false;
bool  gAmmoniaOK = false;

// Display redraw tracking
int  gPage = PAGE_OVERVIEW;
int  gDrawnPage = -1;
float gLastTemp = NAN;
float gLastLevel = NAN;
float gLastAmmonia = NAN;
bool  gLastTempOK = false;
bool  gLastLevelOK = false;
bool  gLastAmmoniaOK = false;
bool  gWifiWasConnected = false;

// Touch / swipe state
bool  gWasTouching = false;
int16_t gPressX = 0, gPressY = 0;
int16_t gCurX = 0, gCurY = 0;
unsigned long gTouchCooldownUntil = 0;

// Loop scheduling
unsigned long gLastTouchPoll = 0;
unsigned long gLastDisplayRefresh = 0;
unsigned long gLastSensorRead = 0;

// =============================================================================
// SENSOR VALIDATION
// =============================================================================
bool isTemperatureValid(float temp) {
  if (temp <= TEMP_SENSOR_ERROR) {
    Serial.println("Warning: Temperature sensor disconnected or not found!");
    return false;
  }
  if (temp < TEMP_VALID_MIN || temp > TEMP_VALID_MAX) {
    Serial.print("Warning: Temperature out of range: ");
    Serial.println(temp);
    return false;
  }
  return true;
}

bool isWaterLevelValid(float level) {
  if (level < 0) {
    Serial.println("Warning: Ultrasonic sensor failed, no valid echo received!");
    return false;
  }
  if (level < WATER_LEVEL_VALID_MIN || level > WATER_LEVEL_VALID_MAX) {
    Serial.print("Warning: Water level out of range: ");
    Serial.println(level);
    return false;
  }
  return true;
}

bool isAmmoniaValid(float value) {
  if (value < AMMONIA_VALID_MIN || value > AMMONIA_VALID_MAX) {
    Serial.print("Warning: Ammonia out of range: ");
    Serial.println(value);
    return false;
  }
  return true;
}

// SIMULATED ammonia reading in mg/L. Oscillates slowly around a healthy
// baseline so charts show a realistic trend. See the note above readAmmonia().
float readAmmonia() {
  unsigned long t = millis();
  float wave = sin(2.0f * PI * (t / 60000.0f)) + 0.5f * sin(2.0f * PI * (t / 14400000.0f));
  float value = AMMONIA_SIM_BASE + AMMONIA_SIM_AMPLITUDE * wave;

  if (value < AMMONIA_VALID_MIN) value = AMMONIA_VALID_MIN;
  if (value > AMMONIA_VALID_MAX) value = AMMONIA_VALID_MAX;
  return value;
}

float readDistanceCM() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  if (duration == 0) return DISTANCE_SENSOR_ERROR;

  return (duration * 0.0343f) / 2.0f;
}

float getAverageDistance(int samples) {
  float total = 0.0f;
  int validReadings = 0;

  for (int i = 0; i < samples; i++) {
    float distance = readDistanceCM();
    if (distance > 0) {
      total += distance;
      validReadings++;
    }
    delay(SAMPLE_DELAY_MS);
  }

  return (validReadings == 0) ? DISTANCE_SENSOR_ERROR : total / validReadings;
}

// =============================================================================
// TOUCH CALIBRATION (persisted in NVS so it runs only once)
// =============================================================================
bool loadCalibration(uint16_t* calData) {
  gPrefs.begin("display", true);   // read-only
  size_t n = gPrefs.getBytes("cal", calData, 5 * sizeof(uint16_t));
  gPrefs.end();
  return n == 5 * sizeof(uint16_t);
}

void saveCalibration(const uint16_t* calData) {
  gPrefs.begin("display", false);
  gPrefs.putBytes("cal", calData, 5 * sizeof(uint16_t));
  gPrefs.end();
}

void initDisplay() {
  tft.init();
  tft.setRotation(1);   // landscape: 480x320
  tft.fillScreen(COL_BG);

  uint16_t calData[5];
  if (loadCalibration(calData)) {
    tft.setTouch(calData);
  } else {
    // First boot: run the interactive 5-point calibration, then store it.
    tft.setTextColor(TFT_WHITE, TFT_BLACK);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("Touch calibration", tft.width() / 2, tft.height() / 2 - 20, 4);
    tft.drawString("Follow the crosses", tft.width() / 2, tft.height() / 2 + 10, 2);
    tft.calibrateTouch(calData, TFT_WHITE, TFT_BLACK, 15);
    tft.setTouch(calData);
    saveCalibration(calData);
  }

  redrawFull();
}

// =============================================================================
// SCREEN RENDERING
// =============================================================================
void showCenterMessage(const char* line1, const char* line2) {
  tft.fillScreen(COL_BG);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(COL_TEXT, TFT_BLACK);
  tft.drawString(line1, tft.width() / 2, tft.height() / 2 - 15, 2);
  tft.setTextColor(COL_ACCENT, TFT_BLACK);
  tft.drawString(line2, tft.width() / 2, tft.height() / 2 + 15, 2);
}

void drawChrome() {
  tft.fillRect(0, 0, tft.width(), 28, COL_HEADER);

  // Title
  tft.setTextDatum(TL_DATUM);
  tft.setTextColor(COL_TEXT, COL_HEADER);
  tft.drawString("CRAYvings Monitor", 10, 6, 2);

  // Local IP when connected
  if (WiFi.status() == WL_CONNECTED) {
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(COL_MUTED, COL_HEADER);
    tft.drawString(WiFi.localIP().toString(), tft.width() / 2, 6, 1);
  }

  // WiFi status
  bool online = (WiFi.status() == WL_CONNECTED);
  tft.setTextDatum(TR_DATUM);
  tft.setTextColor(online ? COL_OK : COL_BAD, COL_HEADER);
  tft.drawString(online ? "WiFi: OK" : "WiFi: ---", tft.width() - 10, 6, 2);

  // Page indicator dots
  int cx = tft.width() / 2;
  int dotY = tft.height() - 12;
  for (int i = 0; i < PAGE_COUNT; i++) {
    int x = cx + (int)((i - (PAGE_COUNT - 1) / 2.0f) * 28);
    tft.fillCircle(x, dotY, 5, (i == gPage) ? COL_ACCENT : COL_DOT_IDLE);
  }
}

void clearContent() {
  tft.fillRect(0, 30, tft.width(), tft.height() - 30 - 24, COL_BG);
}

// Draws a big value with a small unit label next to it. When degCircle is true
// the unit is drawn as a small degree circle + "C" (TFT_eSPI's built-in fonts
// have no degree glyph). bg must match whatever the value sits on so the text
// eraser doesn't paint a contrasting box behind the glyphs.
void drawValueBlock(int cx, int cy, const String& value, const char* unit,
                    uint16_t color, uint8_t valFont, bool degCircle, int degR,
                    uint16_t bg) {
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(color, bg);
  tft.drawString(value, cx, cy, valFont);

  int half = tft.textWidth(value, valFont) / 2;
  int ux = cx + half + 10;
  int uy = cy - tft.fontHeight(valFont) / 2;
  tft.setTextDatum(ML_DATUM);
  tft.setTextColor(COL_ACCENT, bg);
  if (degCircle) {
    tft.fillCircle(ux, uy + 6, degR, COL_ACCENT);
    tft.drawString("C", ux + degR + 4, uy, 2);
  } else {
    tft.drawString(unit, ux, uy, 2);
  }
}

void drawOverviewRow(int idx, const String& label, const String& value,
                     const char* unit, uint16_t color, bool deg, bool valid) {
  int y0 = 34 + idx * 88;
  tft.fillRect(6, y0, tft.width() - 12, 82, COL_PANEL);
  tft.fillRect(12, y0 + 12, 6, 58, color);   // accent bar

  tft.setTextDatum(TL_DATUM);
  tft.setTextColor(COL_MUTED, COL_PANEL);
  tft.drawString(label, 28, y0 + 10, 2);

  drawValueBlock(tft.width() / 2 + 20, y0 + 44, valid ? value : "--",
                 unit, valid ? color : COL_BAD, 4, deg, 3, COL_PANEL);

  tft.setTextDatum(TR_DATUM);
  tft.setTextColor(valid ? COL_OK : COL_BAD, COL_PANEL);
  tft.drawString(valid ? "OK" : "FAIL", tft.width() - 16, y0 + 10, 2);
}

void drawOverview() {
  drawOverviewRow(0, "TEMPERATURE", String(gTemp, 1), "C", COL_TEMP, true, gTempOK);
  drawOverviewRow(1, "WATER LEVEL", String(gLevel, 1), "%", COL_WATER, false, gLevelOK);
  drawOverviewRow(2, "AMMONIA", String(gAmmonia, 2), "mg/L", COL_AMMONIA, false, gAmmoniaOK);
}

void drawTempPage() {
  drawValueBlock(tft.width() / 2 - 10, 150,
                 gTempOK ? String(gTemp, 1) : "--", "C",
                 gTempOK ? COL_TEMP : COL_BAD, 6, true, 5, TFT_BLACK);

  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(gTempOK ? COL_OK : COL_BAD, TFT_BLACK);
  tft.drawString(gTempOK ? "SENSOR OK" : "SENSOR DISCONNECTED",
                 tft.width() / 2, 235, 2);
}

void drawWaterPage() {
  drawValueBlock(tft.width() / 2 - 10, 130,
                 gLevelOK ? String(gLevel, 1) : "--", "%",
                 gLevelOK ? COL_WATER : COL_BAD, 6, false, 0, TFT_BLACK);

  float pct = gLevelOK ? constrain(gLevel, 0.0f, 100.0f) : 0.0f;
  int bx = 40, by = 215, bw = tft.width() - 80, bh = 26;
  tft.drawRect(bx, by, bw, bh, COL_MUTED);
  tft.fillRect(bx, by, (int)(bw * pct / 100.0f), bh, COL_WATER);

  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(gLevelOK ? COL_OK : COL_BAD, TFT_BLACK);
  tft.drawString(gLevelOK ? "SENSOR OK" : "SENSOR FAILED",
                 tft.width() / 2, 260, 2);
}

void drawAmmoniaPage() {
  drawValueBlock(tft.width() / 2 - 10, 150,
                 gAmmoniaOK ? String(gAmmonia, 2) : "--", "mg/L",
                 gAmmoniaOK ? COL_AMMONIA : COL_BAD, 6, false, 0, TFT_BLACK);

  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(gAmmoniaOK ? COL_OK : COL_BAD, TFT_BLACK);
  tft.drawString(gAmmoniaOK ? "SENSOR OK" : "SENSOR FAILED",
                 tft.width() / 2, 235, 2);
}

void drawCurrentPageContent() {
  clearContent();
  switch (gPage) {
    case PAGE_TEMP:    drawTempPage(); break;
    case PAGE_WATER:   drawWaterPage(); break;
    case PAGE_AMMONIA: drawAmmoniaPage(); break;
    case PAGE_OVERVIEW:
    default:           drawOverview(); break;
  }
}

void redrawFull() {
  tft.fillScreen(COL_BG);
  drawChrome();
  drawCurrentPageContent();
  gDrawnPage = gPage;
}

// =============================================================================
// DISPLAY UPDATE (value-diff based, keeps the screen responsive)
// =============================================================================
bool valuesChanged() {
  if (gTempOK != gLastTempOK || gLevelOK != gLastLevelOK) return true;
  if (isnan(gTemp) != isnan(gLastTemp)) return true;
  if (isnan(gLevel) != isnan(gLastLevel)) return true;
  if (isnan(gAmmonia) != isnan(gLastAmmonia)) return true;
  if (gTempOK && fabsf(gTemp - gLastTemp) > 0.05f) return true;
  if (gLevelOK && fabsf(gLevel - gLastLevel) > 0.05f) return true;
  if (gAmmoniaOK && fabsf(gAmmonia - gLastAmmonia) > 0.005f) return true;
  return false;
}

void updateDisplay() {
  bool wifiNow = (WiFi.status() == WL_CONNECTED);
  bool wifiChanged = (wifiNow != gWifiWasConnected);
  gWifiWasConnected = wifiNow;

  if (gPage != gDrawnPage) {
    redrawFull();
  } else {
    if (valuesChanged()) drawCurrentPageContent();
    if (wifiChanged) drawChrome();
  }

  gLastTemp = gTemp;
  gLastLevel = gLevel;
  gLastAmmonia = gAmmonia;
  gLastTempOK = gTempOK;
  gLastLevelOK = gLevelOK;
  gLastAmmoniaOK = gAmmoniaOK;
}

// =============================================================================
// TOUCH / SWIPE HANDLING
// =============================================================================
void nextPage() {
  gPage = (gPage + 1) % PAGE_COUNT;
  gTouchCooldownUntil = millis() + TOUCH_COOLDOWN_MS;
}

void prevPage() {
  gPage = (gPage + PAGE_COUNT - 1) % PAGE_COUNT;
  gTouchCooldownUntil = millis() + TOUCH_COOLDOWN_MS;
}

void pollTouch() {
  if ((long)(millis() - gTouchCooldownUntil) < 0) return;

  int16_t x = 0, y = 0;
  if (tft.getTouch(&x, &y)) {
    gCurX = x;
    gCurY = y;
    if (!gWasTouching) {
      gPressX = x;
      gPressY = y;
    }
    gWasTouching = true;
  } else if (gWasTouching) {
    int dx = (int)gCurX - (int)gPressX;
    int dy = (int)gCurY - (int)gPressY;
    if (dx <= -SWIPE_DIST_X) {
      nextPage();
    } else if (dx >= SWIPE_DIST_X) {
      prevPage();
    } else if (abs(dx) <= TAP_DIST_X && abs(dy) <= TAP_DIST_Y) {
      nextPage();   // a simple tap also advances
    }
    gWasTouching = false;
  }
}

// =============================================================================
// SENSOR READING + SERVER UPLOAD (runs on the LOOP_DELAY_MS schedule)
// =============================================================================
void takeSensorReading() {
  float distanceCm = getAverageDistance(ULTRASONIC_SAMPLES);
  float waterLevel = DISTANCE_SENSOR_ERROR;

  if (distanceCm > 0) {
    float levelCm = TANK_HEIGHT_CM - distanceCm;
    if (levelCm < 0) levelCm = 0;
    if (levelCm > TANK_HEIGHT_CM) levelCm = TANK_HEIGHT_CM;
    waterLevel = (levelCm / TANK_HEIGHT_CM) * 100.0f;
  }

  sensors.requestTemperatures();
  float tempC = sensors.getTempCByIndex(0);

  float ammoniaValue = readAmmonia();

  // Cache latest readings + validity for the touchscreen display
  gTempOK = isTemperatureValid(tempC);
  gLevelOK = isWaterLevelValid(waterLevel);
  gAmmoniaOK = isAmmoniaValid(ammoniaValue);
  gTemp = gTempOK ? tempC : NAN;
  gLevel = gLevelOK ? waterLevel : NAN;
  gAmmonia = gAmmoniaOK ? ammoniaValue : NAN;

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost, reconnecting...");
    WiFi.mode(WIFI_STA);
    WiFi.begin();
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
      delay(500);
      Serial.print(".");
    }
    if (WiFi.status() != WL_CONNECTED) {
      // Fall back to the config portal for reconfiguration, but time it out
      // so the loop keeps monitoring sensors instead of blocking forever.
      showCenterMessage("WiFi setup", "Connect to CRAYVings-ESP32");
      wm.setConfigPortalTimeout(180);
      wm.autoConnect("CRAYVings-ESP32");
      redrawFull();
    }
  }

  bool tempOK = gTempOK;
  bool levelOK = gLevelOK;
  bool ammoniaOK = gAmmoniaOK;

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.begin(serverName);
    http.addHeader("Content-Type", "application/json");

    float sendTemp = (tempOK) ? tempC : -1.0f;
    float sendLevel = (levelOK) ? waterLevel : -1.0f;
    float sendAmmonia = (ammoniaOK) ? ammoniaValue : -1.0f;

    char json[128];
    snprintf(json, sizeof(json),
             "{\"device_id\":\"%s\",\"temperature\":%.2f,\"water_level\":%.2f,\"ammonia\":%.3f}",
             DEVICE_ID, sendTemp, sendLevel, sendAmmonia);

    int code = http.POST(json);

    if (code > 0) {
      if (code == 200 || code == 201) {
        Serial.println("Data successfully saved to database!");
      } else {
        Serial.print("Server responded with code: ");
        Serial.println(code);
      }
    } else {
      Serial.print("POST failed, error: ");
      Serial.println(http.errorToString(code));
    }

    http.end();
  } else {
    Serial.println("WiFi not connected, cannot send data.");
  }

  Serial.print("Distance: ");
  Serial.print(distanceCm, 2);
  Serial.print(" cm | Water Level: ");
  Serial.print(waterLevel, 2);
  Serial.print(" % | Water Temp: ");
  Serial.print(tempC, 2);
  Serial.print(" C | Ammonia: ");
  Serial.print(ammoniaValue, 3);
  Serial.println(" mg/L");
  Serial.println("------------------------");
}

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  Serial.begin(19200);

  esp_task_wdt_deinit();

  // --- Touchscreen (initializes and calibrates once) ---
  initDisplay();

  // --- Sensors ---
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  sensors.begin();

  // --- WiFi ---
  wm.setConfigPortalTimeout(180);
  wm.setConnectTimeout(15);
  wm.setDarkMode(true);
  wm.setTitle("CRAYVings ESP32");

  WiFiManagerParameter serverParam("server", "Server URL", serverName, 64);
  wm.addParameter(&serverParam);

  showCenterMessage("WiFi setup", "Connect to CRAYVings-ESP32");
  bool connected = wm.autoConnect("CRAYVings-ESP32");

  if (!connected) {
    Serial.println("WiFi connection failed! Rebooting...");
    ESP.restart();
  }

  strlcpy(serverName, serverParam.getValue(), sizeof(serverName));
  Serial.println("Connected to: " + WiFi.SSID());
  Serial.print("Server: ");
  Serial.println(serverName);
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());

  gWifiWasConnected = (WiFi.status() == WL_CONNECTED);
  redrawFull();

  esp_task_wdt_config_t wdt_config = {
    .timeout_ms = 120000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  esp_task_wdt_init(&wdt_config);
  esp_task_wdt_add(NULL);
}

// =============================================================================
// MAIN LOOP (non-blocking millis() scheduler)
// =============================================================================
void loop() {
  esp_task_wdt_reset();
  unsigned long now = millis();

  if (now - gLastTouchPoll >= TOUCH_POLL_MS) {
    gLastTouchPoll = now;
    pollTouch();
  }

  if (now - gLastDisplayRefresh >= DISPLAY_REFRESH_MS) {
    gLastDisplayRefresh = now;
    updateDisplay();
  }

  if (now - gLastSensorRead >= LOOP_DELAY_MS) {
    gLastSensorRead = now;
    takeSensorReading();
  }

  // Let the scheduler keep a steady pace without hogging the CPU.
  delay(5);
}
