# embedded-c-c-expert
Description: Provides expert guidance for embedded C/C++ development, particularly for ESP32-based IoT systems like the CRAYvings Monitoring System

## When to invoke
- Writing or reviewing embedded C/C++ code (ESP32, Arduino, bare-metal)
- Optimizing for memory-constrained environments
- Working with real-time operating systems (FreeRTOS)
- Interfacing with hardware peripherals (sensors, actuators, communication modules)
- Debugging embedded systems issues
- Ensuring power efficiency in battery-operated devices
- Implementing communication protocols (WiFi, Bluetooth, MQTT, HTTP)
- Handling sensor data acquisition and processing

## Steps
### 1. Understand the Embedded Context
- Identify target hardware (ESP32 DevKit V1 in this project)
- Note memory constraints (RAM, flash storage)
- Determine real-time requirements and timing constraints
- Identify peripherals in use (GPIO, ADC, UART, SPI, I2C, timers)
- Review power requirements and sleep/wake cycles
- Check development environment (Arduino IDE, ESP-IDF, VS Code with PlatformIO)
- Identify communication protocols (WiFi, HTTP, MQTT, etc.)

### 2. Code Review Checklist for Embedded C/C++

#### Memory Management
- [ ] Static vs dynamic allocation preference (avoid malloc/free in critical paths)
- [ ] Stack size checking for tasks/interrupts
- [ ] Heap fragmentation monitoring (if using dynamic allocation)
- [ ] Proper use of const, PROGMEM for constant data
- [ ] Buffer overflow prevention (bounds checking, safe string functions)
- [ ] Memory pool usage for frequent allocations
- [ ] DSPic memory sections (.data, .bss, .rodata, .text)

#### Real-Time Considerations (FreeRTOS)
- [ ] Task prioritization appropriate for workload
- [ ] Proper use of mutexes, semaphores, queues for synchronization
- [ ] Avoiding busy-wait loops; use vTaskDelay() or timers
- [ ] Interrupt Service Routities (ISRs) kept short
- [ ] ISRs deferring work to tasks via queues/semaphores
- [ ] Task stack size monitoring (uxTaskGetStackHighWaterMark)
- [ ] Proper handling of shared resources (critical sections)
- [ ] Timer usage for periodic tasks instead of delays in tasks

#### Hardware Interaction
- [ ] Proper GPIO configuration (input/output, pull-up/down, drive strength)
- [ ] ADC configuration (resolution, sampling rate, averaging)
- [ ] Debouncing for mechanical inputs (buttons, switches)
- [ ] Proper sensor initialization and calibration routines
- [ ] Handling sensor failure states (return codes, sentinel values)
- [ ] Power management of peripherals when not in use
- [ ] Proper use of hardware timers for precise timing
- [ ] UART configuration (baud rate, parity, stop bits) for debugging/communication
- [ ] SPI/I2C bus speed and device addressing

#### Error Handling and Robustness
- [ ] Return value checking for all hardware/peripheral functions
- [ ] Watchdog timer usage and feeding
- [ ] Brown-out detection configuration
- [ ] Graceful degradation when peripherals fail
- [ ] Proper error logging (to serial, storage, or via LEDs)
- [ ] Recovery procedures from common failure modes
- [ ] Assertions for debugging (enabled in debug builds)
- [ ] Exception handling considerations (if using C++ exceptions)

#### Power Efficiency
- [ ] Use of.sleep modes appropriately (light sleep, deep sleep)
- [ ] Peripheral clock gating when not in use
- [ ] Efficient UART/USB usage (avoid constant polling)
- [ ] ADC sampling optimization (only sample when needed)
- [ ] WiFi/Ble power management (disconnect when idle)
- [ ] Sensor power cycling for battery-operated devices
- [ ] Proper use of RTC for wake-up timers
- [ ] CPU frequency scaling based on workload

#### C++ Specific Considerations (if using C++)
- [ ] Avoid RTTI and exceptions in memory-constrained systems (or account for overhead)
- [ ] Prefer static polymorphism (templates) over dynamic (virtual) when possible
- [ ] Minimize use of STL containers; consider embedded-specific alternatives
- [ ] Proper use of constexpr for compile-time computation
- [ ] RAII for resource management (but verify destructor timing)
- [ ] Function inlining considerations for performance vs size
- [ ] Namespace usage to avoid naming conflicts
- [ ] Proper header guards/#pragma once to prevent multiple inclusion

#### Build and Optimization
- [ ] Compiler optimization flags (-Os for size, -O2 for speed)
- [ ] Link-time optimization (LTO) consideration
- [ ] Unused code/function removal (-ffunction-sections, -fdata-sections)
- [ ] Proper use of inline assembly when necessary
- [ ] Size/performance profiling (objdump, size, nm)
- [ ] Linker script understanding for memory placement
- [ ] Bootloader considerations (if applicable)
- [ ] OTA update mechanism verification (if used)

#### Debugging and Testing
- [ ] Proper use of serial debugging (baud rate, buffering)
- [ ] JTAG/SWD debugging setup and usage
- [ ] Logic analyzer usage for timing/critical sections
- [ ] Oscilloscope for signal integrity checks
- [ ] Unit testing strategies (Unity, Ceedling for C; Google Test adapted for embedded)
- [ ] Hardware-in-the-loop testing setup
- [ ] Memory leak detection (if using dynamic allocation)
- [ ] Stack overflow detection mechanisms
- [ ] Watchdog-triggered reset debugging
- [ ] Core dump analysis (if supported)
- [ ] Proper use of #define DEBUG for conditional compilation

#### ESP32 Specific Considerations
- [ ] WiFi connection handling (reconnection logic, timeout)
- [ ] WiFi power management (WIFI_PS_NONE, MIN_MODEM, MAX_MODEM)
- [ ] FreeRTOS SMP considerations (dual-core usage)
- [ ] Proper use of ESP-IDF drivers vs Arduino wrappers
- [ ] NVS (Non-Volatile Storage) usage for configuration
- [ ] Deep sleep wake-up sources configuration
- [ ] Touch pad usage considerations
- [ ] Hall sensor and temperature sensor readings
- [ ] SPIFFS/LittleFS usage for file storage
- [ ] OTA update partition handling
- [ ] MAC address handling and uniqueness
- [ ] Bluetooth Classic vs BLE usage guidelines
- [ ] ESP-NOW for peer-to-peer communication
- [ ] ADC calibration and voltage attenuation settings
- [ ] Touch sensor debouncing and filtering
- [ ] LEDC (PWM) configuration for motor/LED control
- [ ] RMT (Remote Control) peripheral usage for IR/WS2812
- [ ] I2S usage for audio applications
- [ ] CAN bus configuration if applicable
- [ ] Ethernet MAC usage (if using Ethernet-enabled ESP32 variant)
- [ ] Proper use of esp_timer vs FreeRTOS timers
- [ ] CPU startup and initialization sequence understanding
- [ ] Brown-out detector configuration
- [ ] Watchdog timers (MWDT, TGWDT, RWDT) usage

### 3. Evaluate Specific Implementation Areas

#### Sensor Data Acquisition
- Sampling rate appropriateness for phenomenon being measured
- Anti-aliasing considerations (hardware/software filtering)
- Sensor warm-up/stabilization time handling
- Calibration data storage and application
- Outlier detection and filtering in noisy environments
- Timestamping accuracy for sensor readings
- Handling of sensor communication timeouts/errors

#### Communication Stack
- WiFi connection retry logic with exponential backoff
- HTTP client timeout and retry configuration
- MQTT keep-alive and reconnection handling
- Proper use of TLS/SSL for secure connections (certificate validation)
- Payload size optimization (JSON vs protobuf/CBOR)
- Buffer sizing for network operations
- Handling of partial network packets
- DNS resolution caching considerations

#### Storage and Logging
- Flash wear leveling considerations (NVS vs SPIFFS vs FATFS)
- Log rotation and size limits for persistent storage
- Proper error handling for storage full conditions
- Circular buffer implementation for recent logs
- Timestamp persistence across reboots (RTC or NTP)
- Log compression strategies for transmission
- Backup/restore strategies for configuration data

#### Concurrency and Shared Resources
- Proper protection of shared hardware peripherals
- Sensor data sharing between tasks (queues, notifications)
- Shared buffer management (ring buffers with proper synchronization)
- Access to shared configuration parameters
- File system access synchronization
- WiFi/Bluetooth shared resource considerations
- Inter-core communication patterns (if using both cores)

### 4. Formulate Specific Recommendations
- Identify specific lines/files with embedded-specific issues
- Quantify impact (memory usage, timing, power consumption)
- Provide alternative implementations with trade-off analysis
- Reference ESP-IDF documentation or Arduino core specifics
- Suggest specific debugging techniques for observed issues
- Recommend measurement approaches for validation
- Consider both debug and release build implications

### 5. Document Findings with Embedded-Specific Context
- Reference specific peripherals and their configurations
- Include timing diagrams or timing calculations when relevant
- Show memory usage calculations (stack, heap, static)
- Provide power consumption estimates where applicable
- Include register-level details when necessary for clarity
- Reference specific ESP32 technical reference manual sections
- Provide oscilloscope/logic analyzer setup suggestions for validation
- Include build size impact assessments