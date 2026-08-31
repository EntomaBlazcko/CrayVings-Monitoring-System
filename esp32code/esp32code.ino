#include <Arduino.h>
#include <FS.h>
#include <TFT_eSPI.h>
#include <SPI.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>

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

#define RAW_X_MIN 200
#define RAW_X_MAX 3900

#define RAW_Y_MIN 200
#define RAW_Y_MAX 3900

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

// =============================================================================
// MQ-137
// =============================================================================

#define MQ137_PIN 34

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
// TIMING
// =============================================================================

unsigned long lastSensorRead = 0;
#define SENSOR_INTERVAL 1000

// =============================================================================
// TOUCH STATE
// =============================================================================

bool touching = false;
uint16_t touchStartX = 0;
uint16_t touchStartY = 0;
uint16_t lastTouchX = 0;
uint16_t lastTouchY = 0;
unsigned long lastSwipeTime = 0;
#define SWIPE_DISTANCE 70
#define SWIPE_COOLDOWN 500

// =============================================================================
// WIFI & BACKEND CONFIG
// =============================================================================

#define DEVICE_ID_DEFAULT "ESP32_01"
#define SERVER_IP_DEFAULT "192.168.100.20"
#define SERVER_PORT_DEFAULT "3000"
#define SEND_INTERVAL 5000

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
        distance = -1.0;
        waterLevel = 0.0;
        return;
    }

    distance = duration * 0.0343 / 2.0;
    float waterHeight = TANK_HEIGHT_CM - distance;

    if (waterHeight < 0)
    {
        waterHeight = 0;
    }

    if (waterHeight > TANK_HEIGHT_CM)
    {
        waterHeight = TANK_HEIGHT_CM;
    }

    waterLevel = (waterHeight / TANK_HEIGHT_CM) * 100.0;
    waterLevel = constrain(waterLevel, 0.0, 100.0);
}

// =============================================================================
// READ MQ-137
// =============================================================================

void readAmmonia()
{
    mq137Raw = analogRead(MQ137_PIN);
    mq137Voltage = mq137Raw * (3.3 / 4095.0);
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
    Serial.print(" | ADC Voltage: ");
    Serial.print(mq137Voltage, 3);
    Serial.println(" V");

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

void drawNavigation()
{
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_DARKGREY, TFT_WHITE);
    tft.drawString("Swipe LEFT or RIGHT", 240, 280, 2);
}

// =============================================================================
// OVERVIEW PAGE
// =============================================================================

void drawOverview()
{
    tft.fillScreen(TFT_WHITE);
    drawHeader("CRAYVINGS MONITOR");

    // -------------------------------------------------------------------------
    // TEMPERATURE BOX
    // -------------------------------------------------------------------------

    tft.drawRect(15, 70, 215, 75, TFT_RED);
    tft.setTextDatum(TL_DATUM);
    tft.setTextColor(TFT_RED, TFT_WHITE);
    tft.drawString("TEMPERATURE", 30, 80, 2);

    // -------------------------------------------------------------------------
    // WATER LEVEL BOX
    // -------------------------------------------------------------------------

    tft.drawRect(250, 70, 215, 75, TFT_BLUE);
    tft.setTextColor(TFT_BLUE, TFT_WHITE);
    tft.drawString("WATER LEVEL", 265, 80, 2);

    // -------------------------------------------------------------------------
    // AMMONIA BOX
    // -------------------------------------------------------------------------

    tft.drawRect(15, 160, 215, 75, TFT_ORANGE);
    tft.setTextColor(TFT_ORANGE, TFT_WHITE);
    tft.drawString("MQ-137", 30, 170, 2);

    // -------------------------------------------------------------------------
    // DISTANCE BOX
    // -------------------------------------------------------------------------
    // The distance VALUE is intentionally not displayed.
    // -------------------------------------------------------------------------

    tft.drawRect(250, 160, 215, 75, TFT_GREEN);
    tft.setTextColor(TFT_GREEN, TFT_WHITE);
    tft.drawString("WATER STATUS", 265, 170, 2);

    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    tft.setTextDatum(TL_DATUM);
    tft.drawString("HC-SR04", 265, 195, 2);

    // -------------------------------------------------------------------------
    // NAVIGATION
    // -------------------------------------------------------------------------

    drawNavigation();
    drawPageDots();
}

// =============================================================================
// UPDATE OVERVIEW VALUES
// =============================================================================
//
// IMPORTANT:
// Only the value areas are cleared.
// The entire screen is NOT redrawn.
// =============================================================================

void updateOverview()
{
    // -------------------------------------------------------------------------
    // TEMPERATURE VALUE
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // WATER LEVEL VALUE
    // -------------------------------------------------------------------------

    tft.fillRect(260, 102, 195, 35, TFT_WHITE);
    char levelText[30];
    snprintf(levelText, sizeof(levelText), "%.1f %%", waterLevel);
    tft.drawString(levelText, 265, 105, 4);

    // -------------------------------------------------------------------------
    // AMMONIA VALUE
    // -------------------------------------------------------------------------

    tft.fillRect(25, 192, 195, 35, TFT_WHITE);
    char ammoniaText[30];
    snprintf(ammoniaText, sizeof(ammoniaText), "%.3f V", mq137Voltage);
    tft.drawString(ammoniaText, 30, 195, 4);

    // -------------------------------------------------------------------------
    // WATER STATUS
    // -------------------------------------------------------------------------

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

// =============================================================================
// TEMPERATURE PAGE
// =============================================================================

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

// =============================================================================
// UPDATE TEMPERATURE PAGE
// =============================================================================

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

// =============================================================================
// WATER LEVEL PAGE
// =============================================================================

void drawWaterLevelPage()
{
    tft.fillScreen(TFT_WHITE);
    drawHeader("WATER LEVEL");

    // -------------------------------------------------------------------------
    // BAR OUTLINE
    // -------------------------------------------------------------------------

    tft.drawRect(70, 80, 340, 80, TFT_BLUE);

    // -------------------------------------------------------------------------
    // PERCENTAGE
    // -------------------------------------------------------------------------

    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_BLUE, TFT_WHITE);
    char levelText[30];
    snprintf(levelText, sizeof(levelText), "%.1f %%", waterLevel);
    tft.drawString(levelText, 240, 205, 6);

    // -------------------------------------------------------------------------
    // SENSOR LABEL
    // -------------------------------------------------------------------------

    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    tft.drawString("HC-SR04 WATER LEVEL", 240, 245, 2);

    drawNavigation();
    drawPageDots();
    updateWaterLevelPage();
}

// =============================================================================
// UPDATE WATER LEVEL
// =============================================================================

void updateWaterLevelPage()
{
    // -------------------------------------------------------------------------
    // CLEAR INSIDE OF BAR
    // -------------------------------------------------------------------------

    tft.fillRect(72, 82, 336, 76, TFT_WHITE);

    // -------------------------------------------------------------------------
    // WATER LEVEL BAR
    // -------------------------------------------------------------------------

    int fillWidth = (int)(336.0 * waterLevel / 100.0);
    fillWidth = constrain(fillWidth, 0, 336);

    if (fillWidth > 0)
    {
        tft.fillRect(72, 82, fillWidth, 76, TFT_BLUE);
    }

    // -------------------------------------------------------------------------
    // REDRAW BORDER
    // -------------------------------------------------------------------------

    tft.drawRect(70, 80, 340, 80, TFT_BLUE);

    // -------------------------------------------------------------------------
    // UPDATE PERCENTAGE
    // -------------------------------------------------------------------------

    tft.fillRect(90, 175, 300, 60, TFT_WHITE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_BLUE, TFT_WHITE);
    char levelText[30];
    snprintf(levelText, sizeof(levelText), "%.1f %%", waterLevel);
    tft.drawString(levelText, 240, 205, 6);
}

// =============================================================================
// AMMONIA PAGE
// =============================================================================

void drawAmmoniaPage()
{
    tft.fillScreen(TFT_WHITE);
    drawHeader("MQ-137 AMMONIA");
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_ORANGE, TFT_WHITE);

    char voltageText[30];
    snprintf(voltageText, sizeof(voltageText), "%.3f V", mq137Voltage);
    tft.drawString(voltageText, 240, 125, 7);

    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    char rawText[30];
    snprintf(rawText, sizeof(rawText), "RAW ADC: %d", mq137Raw);
    tft.drawString(rawText, 240, 200, 3);

    tft.drawString("MQ-137 AOUT", 240, 235, 2);
    tft.setTextColor(TFT_DARKGREY, TFT_WHITE);
    tft.drawString("Voltage test only", 240, 280, 2);
    drawPageDots();
}

// =============================================================================
// UPDATE AMMONIA PAGE
// =============================================================================

void updateAmmoniaPage()
{
    // -------------------------------------------------------------------------
    // VOLTAGE
    // -------------------------------------------------------------------------

    tft.fillRect(70, 85, 340, 80, TFT_WHITE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_ORANGE, TFT_WHITE);
    char voltageText[30];
    snprintf(voltageText, sizeof(voltageText), "%.3f V", mq137Voltage);
    tft.drawString(voltageText, 240, 125, 7);

    // -------------------------------------------------------------------------
    // RAW ADC
    // -------------------------------------------------------------------------

    tft.fillRect(120, 180, 240, 35, TFT_WHITE);
    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    char rawText[30];
    snprintf(rawText, sizeof(rawText), "RAW ADC: %d", mq137Raw);
    tft.drawString(rawText, 240, 200, 3);
}

// =============================================================================
// DRAW CURRENT PAGE
// =============================================================================
//
// Called ONLY when changing pages.
// =============================================================================

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

// =============================================================================
// UPDATE CURRENT PAGE
// =============================================================================
//
// This does NOT call fillScreen().
// This is the important anti-blinking section.
// =============================================================================

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
}

// =============================================================================
// NEXT PAGE
// =============================================================================

void nextPage()
{
    currentPage++;
    if (currentPage >= PAGE_COUNT)
    {
        currentPage = PAGE_OVERVIEW;
    }
    drawCurrentPage();
    lastSwipeTime = millis();
}

// =============================================================================
// PREVIOUS PAGE
// =============================================================================

void previousPage()
{
    currentPage--;
    if (currentPage < 0)
    {
        currentPage = PAGE_COUNT - 1;
    }
    drawCurrentPage();
    lastSwipeTime = millis();
}

// =============================================================================
// TOUCH / SWIPE
// =============================================================================

void handleTouch()
{
    uint16_t x = lastTouchX;
    uint16_t y = lastTouchY;
    bool pressed = getTouchPosition(x, y);

    // -------------------------------------------------------------------------
    // FINGER IS DOWN
    // -------------------------------------------------------------------------

    if (pressed)
    {
        lastTouchX = x;
        lastTouchY = y;

        if (!touching)
        {
            touching = true;
            touchStartX = x;
            touchStartY = y;
            Serial.print("[TOUCH START] X=");
            Serial.print(x);
            Serial.print(" Y=");
            Serial.println(y);
        }
        return;
    }

    // -------------------------------------------------------------------------
    // NO TOUCH
    // -------------------------------------------------------------------------

    if (!touching)
    {
        return;
    }

    // -------------------------------------------------------------------------
    // FINGER RELEASED
    // -------------------------------------------------------------------------

    touching = false;
    uint16_t endX = lastTouchX;
    uint16_t endY = lastTouchY;
    int dx = (int)endX - (int)touchStartX;
    int dy = (int)endY - (int)touchStartY;

    Serial.print("[SWIPE] DX=");
    Serial.print(dx);
    Serial.print(" DY=");
    Serial.println(dy);

    // -------------------------------------------------------------------------
    // COOLDOWN
    // -------------------------------------------------------------------------

    if (millis() - lastSwipeTime < SWIPE_COOLDOWN)
    {
        return;
    }

    // -------------------------------------------------------------------------
    // HORIZONTAL SWIPE ONLY
    // -------------------------------------------------------------------------

    if (abs(dx) >= SWIPE_DISTANCE && abs(dx) > abs(dy))
    {
        // ---------------------------------------------------------------------
        // SWIPE LEFT
        // ---------------------------------------------------------------------

        if (dx < 0)
        {
            Serial.println("[SWIPE] LEFT -> NEXT PAGE");
            nextPage();
        }
        // ---------------------------------------------------------------------
        // SWIPE RIGHT
        // ---------------------------------------------------------------------

        else
        {
            Serial.println("[SWIPE] RIGHT -> PREVIOUS PAGE");
            previousPage();
        }
    }
    // -------------------------------------------------------------------------
    // SPECIAL GESTURE: Tap top corner 3 times quickly to enter WiFi config
    // -------------------------------------------------------------------------
    else if (abs(dx) < 30 && abs(dy) < 30)  // Tap (not swipe)
    {
        static uint8_t tapCount = 0;
        static unsigned long lastTapTime = 0;
        unsigned long now = millis();

        // Reset tap counter if too much time has passed
        if (now - lastTapTime > 1000)
        {
            tapCount = 0;
        }

        // Check if tap is in top-left corner (configuration trigger zone)
        if (x < 60 && y < 60)
        {
            tapCount++;
            lastTapTime = now;
            Serial.printf("[CONFIG] Tap %d/3 detected\n", tapCount);

            if (tapCount >= 3)
            {
                Serial.println("[CONFIG] Triple tap detected! Starting WiFi configuration...");
                wifiConfigRequested = true;
                tapCount = 0;  // Reset after triggering
            }
        }
        else
        {
            tapCount = 0;  // Reset if tap is not in the zone
        }
    }
}

// =============================================================================
// START WIFI CONFIGURATION PORTAL
// =============================================================================

void startWifiConfigPortal()
{
    Serial.println("[WIFI] Starting configuration portal...");

    // Show configuration message on screen
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

    // Create parameters for configuration
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

    wm.setConfigPortalTimeout(180);  // 3 minutes timeout
    wm.setConnectTimeout(10);

    bool wifiResult = wm.autoConnect("Aquaculture-Setup");

    if (wifiResult)
    {
        wifiConnected = true;
        Serial.println("[WIFI] Connected!");
        Serial.print("[WIFI] IP: ");
        Serial.println(WiFi.localIP());

        // Save the configured values
        strncpy(serverIP, serverIPParam.getValue(), sizeof(serverIP) - 1);
        strncpy(serverPort, serverPortParam.getValue(), sizeof(serverPort) - 1);
        strncpy(deviceId, deviceIdParam.getValue(), sizeof(deviceId) - 1);

        // Ensure null termination
        serverIP[sizeof(serverIP) - 1] = '\0';
        serverPort[sizeof(serverPort) - 1] = '\0';
        deviceId[sizeof(deviceId) - 1] = '\0';

        Serial.print("[WIFI] Backend: ");
        Serial.print(serverIP);
        Serial.print(":");
        Serial.println(serverPort);
        Serial.print("[WIFI] Device ID: ");
        Serial.println(deviceId);

        // Update the display to show connected status
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
    drawCurrentPage();  // Redraw the current page after configuration
}

// =============================================================================
// SEND SENSOR DATA TO BACKEND
// =============================================================================

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
    http.addHeader("Content-Type", "application/json");

    float tempToSend = (temperature == -127.0) ? -1.0 : temperature;
    float ammoniaValue = (mq137Voltage / 3.3);

    String payload = "{";
    payload += "\"device_id\":\"" + String(deviceId) + "\",";
    payload += "\"temperature\":" + String(tempToSend, 2) + ",";
    payload += "\"water_level\":" + String(waterLevel, 1) + ",";
    payload += "\"ammonia\":" + String(ammoniaValue, 4);
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

        // Mark as disconnected so we can retry
        wifiConnected = false;
    }

    http.end();
}

// =============================================================================
// SETUP
// =============================================================================

void setup()
{
    Serial.begin(115200);
    delay(1000);

    Serial.println();
    Serial.println("================================================");
    Serial.println("IoT-Based Smart Aquaculture Monitoring System");
    Serial.println("for Crayfish Production");
    Serial.println("================================================");

    // =========================================================================
    // DS18B20
    // =========================================================================

    sensors.begin();
    Serial.println("[OK] DS18B20 -> GPIO13");

    // =========================================================================
    // HC-SR04
    // =========================================================================

    pinMode(TRIG_PIN, OUTPUT);
    pinMode(ECHO_PIN, INPUT);
    digitalWrite(TRIG_PIN, LOW);
    Serial.println("[OK] HC-SR04 -> GPIO26 / GPIO27");

    // =========================================================================
    // MQ-137
    // =========================================================================

    pinMode(MQ137_PIN, INPUT);
    analogReadResolution(12);
    Serial.println("[OK] MQ-137 -> GPIO34");

    // =========================================================================
    // TOUCH
    // =========================================================================

    pinMode(TOUCH_CS, OUTPUT);
    digitalWrite(TOUCH_CS, HIGH);
    touchSPI.begin(TOUCH_CLK, TOUCH_MISO, TOUCH_MOSI, TOUCH_CS);
    Serial.println("[OK] XPT2046 Touch initialized");

    // =========================================================================
    // ILI9488
    // =========================================================================

    tft.init();
    tft.setRotation(1);
    tft.fillScreen(TFT_WHITE);
    Serial.print("[DISPLAY] Width = ");
    Serial.println(tft.width());
    Serial.print("[DISPLAY] Height = ");
    Serial.println(tft.height());

    // =========================================================================
    // WIFI - Initial Connection Attempt
    // =========================================================================

    Serial.println("[WIFI] Attempting to connect to saved network...");
    tft.fillScreen(TFT_WHITE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_BLACK, TFT_WHITE);
    tft.drawString("WiFi Setup", 240, 80, 4);
    tft.drawString("Connecting to saved network...", 240, 130, 2);
    tft.drawString("Tap top-left corner 3x to config", 240, 200, 2);

    WiFi.mode(WIFI_STA);  // Start in station mode only

    // Try to connect to saved network first
    WiFi.begin();

    unsigned long startAttemptTime = millis();
    bool connected = false;

    // Wait for connection with timeout
    while (millis() - startAttemptTime < 15000)  // 15 second timeout
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

        // Start configuration portal since we couldn't connect
        startWifiConfigPortal();
    }

    // =========================================================================
    // INITIAL SENSOR READING
    // =========================================================================

    readAllSensors();

    // =========================================================================
    // INITIAL SCREEN
    // =========================================================================

    currentPage = PAGE_OVERVIEW;
    drawCurrentPage();

    Serial.println();
    Serial.println("[SYSTEM] READY");
    Serial.println("[SYSTEM] Swipe LEFT  = Next Page");
    Serial.println("[SYSTEM] Swipe RIGHT = Previous Page");
    Serial.println("[SYSTEM] Tap top-left corner 3x = WiFi Config");
    Serial.println();
}

// =============================================================================
// LOOP
// =============================================================================

void loop()
{
    unsigned long now = millis();

    // =========================================================================
    // SENSOR READING
    // =========================================================================

    if (now - lastSensorRead >= SENSOR_INTERVAL)
    {
        lastSensorRead = now;
        readAllSensors();

        // IMPORTANT:
        // Update values only.
        // Do NOT redraw the complete screen.
        updateCurrentPage();
    }

    // =========================================================================
    // SEND DATA TO BACKEND
    // =========================================================================

    if (now - lastSendTime >= SEND_INTERVAL)
    {
        lastSendTime = now;
        sendSensorData();
    }

    // =========================================================================
    // HANDLE WIFI CONFIGURATION REQUEST
    // =========================================================================

    if (wifiConfigRequested)
    {
        startWifiConfigPortal();
    }

    // =========================================================================
    // TOUCH
    // =========================================================================

    handleTouch();

    // Small delay prevents excessive touch polling
    // while keeping the interface responsive.
    delay(20);
}