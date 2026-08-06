#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <esp_task_wdt.h>

#define ONE_WIRE_BUS 4
#define TRIG_PIN 5
#define ECHO_PIN 18

char serverName[64] = "http://192.168.1.20:3000/sensor";

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

void setup() {
  Serial.begin(19200);

  esp_task_wdt_deinit();

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  sensors.begin();

  wm.setConfigPortalTimeout(180);
  wm.setConnectTimeout(15);
  wm.setDarkMode(true);
  wm.setTitle("CRAYVings ESP32");

  WiFiManagerParameter serverParam("server", "Server URL", serverName, 64);
  wm.addParameter(&serverParam);

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

  esp_task_wdt_config_t wdt_config = {
    .timeout_ms = 120000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  esp_task_wdt_init(&wdt_config);
  esp_task_wdt_add(NULL);
}

void loop() {
  esp_task_wdt_reset();

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
      wm.setConfigPortalTimeout(180);
      wm.autoConnect("CRAYVings-ESP32");
    }
  }

  bool tempOK  = isTemperatureValid(tempC);
  bool levelOK = isWaterLevelValid(waterLevel);
  bool ammoniaOK = isAmmoniaValid(ammoniaValue);

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

  delay(LOOP_DELAY_MS);
}
