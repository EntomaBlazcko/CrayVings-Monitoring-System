// =============================================================================
// FILE: esp32code.ino
// =============================================================================
// PURPOSE: ESP32 firmware for the CRAYvings Aquaculture Monitoring System.
//
// This firmware:
//   1. Reads temperature (DS18B20 via OneWire)
//   2. Measures water level (HC-SR04 ultrasonic sensor)
//   3. Reads pH level (analog pH sensor with median filtering)
//   4. Sends sensor data to the backend server via HTTP POST
//   5. Auto-reconnects to WiFi if connection drops
//
// DATA FLOW:
//   Sensors -> Validation -> HTTP POST to server -> PostgreSQL storage
//
// INVALID SENSOR HANDLING:
//   - Invalid/failed sensors are sent as -1 (not 0) to distinguish from valid readings
//   - Server skips negative values during threshold evaluation and SMS alerts
//   - Temperature: -1 when sensor disconnected (DS18B20 returns -127)
//   - Water level: -1 when ultrasonic sensor gets no echo
//   - pH: -1 when reading is outside 0-14 range
//
// HARDWARE:
//   - ESP32 development board
//   - DS18B20 temperature sensor (OneWire, pin 4)
//   - HC-SR04 ultrasonic sensor (Trig: pin 5, Echo: pin 18)
//   - Analog pH sensor (pin 34)
//
// WATCHDOG:
//   - 120-second hardware watchdog timer to prevent system hangs
//   - Reset in main loop and during WiFi connection
// =============================================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <esp_task_wdt.h>

#define ONE_WIRE_BUS 4
#define TRIG_PIN 5
#define ECHO_PIN 18
#define PH_PIN 34

// ====================== WIFI NETWORKS ======================
// Add all your networks here — ESP32 will auto-connect to whichever is available
WiFiMulti wifiMulti;

const char* serverName = "http://10.91.241.9:3000/sensor";

const float TANK_HEIGHT_CM = 36.0f;
const int ULTRASONIC_SAMPLES = 5;
const int SAMPLE_DELAY_MS = 50;
const int LOOP_DELAY_MS = 1000;
const int HTTP_TIMEOUT_MS = 5000;
const int WIFI_CONNECT_TIMEOUT_MS = 20000;

const float PH_CALIBRATION_OFFSET = 19.77f;
const float VOLTAGE_REFERENCE = 3.3f;
const int ADC_RESOLUTION = 4095;
const float ADC_TO_VOLT = (VOLTAGE_REFERENCE / ADC_RESOLUTION);
const float PH_PHASE_SHIFT = -5.70f;

const float TEMP_VALID_MIN = 0.0f;
const float TEMP_VALID_MAX = 50.0f;
const float WATER_LEVEL_VALID_MIN = 0.0f;
const float WATER_LEVEL_VALID_MAX = 100.0f;
const float PH_VALID_MIN = 0.0f;
const float PH_VALID_MAX = 14.0f;
const float TEMP_SENSOR_ERROR = -127.0f;
const float DISTANCE_SENSOR_ERROR = -1.0f;

const char* DEVICE_ID = "ESP32_01";

OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

int buffer_arr[10];
float ph_act;

// ====================== VALIDATION ======================
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

bool isPHValid(float ph) {
  if (ph < PH_VALID_MIN || ph > PH_VALID_MAX) {
    Serial.print("Warning: pH out of range: ");
    Serial.println(ph);
    return false;
  }
  return true;
}

// ====================== ULTRASONIC ======================
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

// ====================== pH SENSOR ======================
float readPH() {
  for (int i = 0; i < 10; i++) {
    buffer_arr[i] = analogRead(PH_PIN);
    delay(30);
  }

  // Insertion sort
  for (int i = 1; i < 10; i++) {
    int key = buffer_arr[i];
    int j = i - 1;
    while (j >= 0 && buffer_arr[j] > key) {
      buffer_arr[j + 1] = buffer_arr[j];
      j--;
    }
    buffer_arr[j + 1] = key;
  }

  unsigned long avgval = 0;
  for (int i = 2; i < 8; i++) {
    avgval += buffer_arr[i];
  }

  float volt = ((float)avgval / 6.0f) * ADC_TO_VOLT;
  ph_act = PH_PHASE_SHIFT * volt + PH_CALIBRATION_OFFSET;

  if (ph_act < PH_VALID_MIN) ph_act = PH_VALID_MIN;
  if (ph_act > PH_VALID_MAX) ph_act = PH_VALID_MAX;

  return ph_act;
}

// ====================== WIFI CONNECT ======================
bool connectWiFi() {
  Serial.print("Connecting to best available WiFi");

  unsigned long startTime = millis();

  while (wifiMulti.run() != WL_CONNECTED) {
    esp_task_wdt_reset();

    if (millis() - startTime >= WIFI_CONNECT_TIMEOUT_MS) {
      Serial.println("\nWiFi connection timed out! Will retry next loop.");
      return false;
    }

    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWiFi Connected!");
  Serial.print("Connected to: ");
  Serial.println(WiFi.SSID());
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
  return true;
}

// ====================== SETUP ======================
void setup() {
  Serial.begin(19200);

  esp_task_wdt_deinit();

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(PH_PIN, INPUT);
  sensors.begin();

  wifiMulti.addAP("Mwa", "dikoalam");

  esp_task_wdt_config_t wdt_config = {
    .timeout_ms = 120000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  esp_task_wdt_init(&wdt_config);
  esp_task_wdt_add(NULL);

  connectWiFi();
}

// ====================== MAIN LOOP ======================
void loop() {
  esp_task_wdt_reset();

  // Read sensors
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

  float phValue = readPH();

  // Auto-reconnect to best available network if WiFi drops
  if (wifiMulti.run() != WL_CONNECTED) {
    Serial.println("WiFi lost → reconnecting to best available network...");
    connectWiFi();
  }

  // Validate sensors
  bool tempOK  = isTemperatureValid(tempC);
  bool levelOK = isWaterLevelValid(waterLevel);
  bool phOK    = isPHValid(phValue);

  // Send data if WiFi is connected, regardless of individual sensor validation
  // Invalid sensors are sent as -1 so server can distinguish "sensor failed" from actual readings
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.begin(serverName);
    http.addHeader("Content-Type", "application/json");

    // Prepare values: use -1 for invalid sensors so server can skip them
    float sendTemp = (tempOK) ? tempC : -1.0f;
    float sendLevel = (levelOK) ? waterLevel : -1.0f;
    float sendPH = (phOK) ? phValue : -1.0f;

    char json[128];
    snprintf(json, sizeof(json),
             "{\"device_id\":\"%s\",\"temperature\":%.2f,\"water_level\":%.2f,\"ph\":%.2f}",
             DEVICE_ID, sendTemp, sendLevel, sendPH);

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

  // Print readings
  Serial.print("Distance: ");
  Serial.print(distanceCm, 2);
  Serial.print(" cm | Water Level: ");
  Serial.print(waterLevel, 2);
  Serial.print(" % | Water Temp: ");
  Serial.print(tempC, 2);
  Serial.print(" C | pH: ");
  Serial.print(phValue, 2);
  Serial.println();
  Serial.println("------------------------");

  delay(LOOP_DELAY_MS);
}
