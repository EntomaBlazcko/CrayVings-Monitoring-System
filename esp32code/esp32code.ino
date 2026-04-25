#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>

#define ONE_WIRE_BUS 4
#define TRIG_PIN 5
#define ECHO_PIN 18
#define PH_PIN 34

// Wi-Fi credentials
const char* ssid = "BULACLAC-ASUS";
const char* password = "1557STzone2";
const char* serverName = "http://192.168.1.20:3000/sensor";

// Sensors
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

// Tank settings
const float tankHeightCm = 30.0;   // distance from ultrasonic sensor to tank bottom

// pH calibration
float calibration_value = 21.34 - 0.7;
int buffer_arr[10], temp;
float ph_act;

float readDistanceCM() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000); // 30ms timeout

  if (duration == 0) {
    return -1.0;
  }

  return duration * 0.0343 / 2.0;
}

float getAverageDistance(int samples = 5) {
  float total = 0.0;
  int validReadings = 0;

  for (int i = 0; i < samples; i++) {
    float distance = readDistanceCM();

    if (distance > 0) {
      total += distance;
      validReadings++;
    }

    delay(50);
  }

  if (validReadings == 0) {
    return -1.0;
  }

  return total / validReadings;
}

// FIXED pH CODE ONLY
float readPH() {
  for (int i = 0; i < 10; i++) {
    buffer_arr[i] = analogRead(PH_PIN);
    delay(30);
  }

  for (int i = 0; i < 9; i++) {
    for (int j = i + 1; j < 10; j++) {
      if (buffer_arr[i] > buffer_arr[j]) {
        temp = buffer_arr[i];
        buffer_arr[i] = buffer_arr[j];
        buffer_arr[j] = temp;
      }
    }
  }

  unsigned long int avgval = 0;
  for (int i = 2; i < 8; i++) {
    avgval += buffer_arr[i];
  }

  float volt = ((float)avgval / 6.0) * (3.3 / 4095.0);
  ph_act = -5.70 * volt + calibration_value;

  if (ph_act < 0.0) ph_act = 0.0;
  if (ph_act > 14.0) ph_act = 14.0;

  return ph_act;
}

void connectWiFi() {
  Serial.print("Connecting to Wi-Fi");
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
}

void setup() {
  Serial.begin(19200);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(PH_PIN, INPUT);

  sensors.begin();

  connectWiFi();
}

void loop() {
  // Read ultrasonic distance
  float distanceCm = getAverageDistance(5);

  // Convert distance to water level percent
  float waterLevel = -1.0;

  if (distanceCm > 0) {
    float levelCm = tankHeightCm - distanceCm;

    if (levelCm < 0) {
      levelCm = 0;
    }

    if (levelCm > tankHeightCm) {
      levelCm = tankHeightCm;
    }

    waterLevel = (levelCm / tankHeightCm) * 100.0;
  }

  // Read water temperature
  sensors.requestTemperatures();
  float tempC = sensors.getTempCByIndex(0);

  // Read pH
  float phValue = readPH();

  // Reconnect Wi-Fi if disconnected
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi disconnected. Reconnecting...");
    connectWiFi();
  }

  // Only send data if Wi-Fi is connected
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverName);
    http.addHeader("Content-Type", "application/json");

    // Build JSON payload
    String json = "{\"device_id\":\"ESP32_01\",";
    json += "\"temperature\":" + String(tempC, 2) + ",";
    json += "\"water_level\":" + String(waterLevel, 2) + ",";
    json += "\"ph\":" + String(phValue, 2) + "}";

    // Send POST request
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
    Serial.println("Wi-Fi not connected, cannot send data.");
  }

  // Print sensor readings locally
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

  delay(1000);
}