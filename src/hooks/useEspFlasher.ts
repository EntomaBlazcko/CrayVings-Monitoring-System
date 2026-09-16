// =============================================================================
// FILE: src/hooks/useEspFlasher.ts
// PURPOSE: React hook wrapping esptool-js (Web Serial API) for flashing ESP32
//          firmware directly from the browser.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ESPLoader, Transport } from "esptool-js";
import type { IEspLoaderTerminal } from "esptool-js";

// ========================
// FIRMWARE MANIFEST TYPES
// ========================
// Mirrors public/firmware/manifest.json (see docs/WEB_FLASHER_NOTES.txt).

export interface FirmwareFileEntry {
  path: string;
  offset: number;
}

export interface FirmwareBuild {
  name: string;
  description: string;
  files: FirmwareFileEntry[];
}

export interface FirmwareManifest {
  name: string;
  version: string;
  chipFamily: string;
  builds: FirmwareBuild[];
}

// ========================
// HOOK STATE TYPES
// ========================

export type FlashStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "flashing"
  | "done"
  | "error";

export interface ChipInfo {
  name: string;
  description: string;
  flashSize: string;
}

export interface FlashErrorInfo {
  title: string;
  message: string;
  tip: string;
  detail: string;
}

export interface UseEspFlasher {
  isSupported: boolean;
  status: FlashStatus;
  progress: number;
  logMessages: string[];
  error: FlashErrorInfo | null;
  chipInfo: ChipInfo | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  flash: (build: FirmwareBuild) => Promise<void>;
  abort: () => void;
}

// Splits raw terminal strings into clean log lines.
function appendLogLine(setter: React.Dispatch<React.SetStateAction<string[]>>, data: string) {
  const lines = data.split("\n").map((line) => line.trimEnd());
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      setter((prev) => [...prev, trimmed]);
    }
  }
}

// Maps raw Web Serial / esptool-js errors to formal, user-friendly guidance.
export function classifyFlashError(err: unknown): FlashErrorInfo {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.toLowerCase();

  // The browser's serial port picker was closed without a selection.
  if (
    /cancel|no port was selected|no device chosen|must be chosen|must be selected|not.*selected/.test(
      text
    )
  ) {
    return {
      title: "No device selected",
      message:
        "The connection was cancelled because no port was chosen in the browser dialog.",
      tip: "Plug the ESP32 into a data-capable USB port, click Connect Device again, and select the board's port in the dialog.",
      detail: raw,
    };
  }

  // The port is still held open from a previous connection attempt.
  if (/already open|is already connected|port.*open/.test(text)) {
    return {
      title: "Serial port still open",
      message:
        "The selected port is still open from an earlier connection, so it cannot be opened again.",
      tip: "Close any other browser tab using the flasher, reload this page, and try again. If it persists, close the browser completely and reconnect the board via USB.",
      detail: raw,
    };
  }

  // The operating system refused to open the serial port.
  if (
    /failed to open serial port|already in use|access.*denied|can't open port|cannot open port|cannot be opened|failed to execute 'open'/.test(
      text
    )
  ) {
    return {
      title: "Serial port unavailable",
      message:
        "The computer could not open the selected serial port. This usually means the port is already in use by another program, the USB-to-serial driver is missing, or the cable cannot carry data.",
      tip:
        "Close any other program using the port (Arduino IDE Serial Monitor, PuTTY, or another browser tab with this device connected), then retry. Use a data-capable USB cable and confirm the CH340 / CP2102 driver is installed in Device Manager.",
      detail: raw,
    };
  }

  // The bootloader did not respond to esptool-js (device not in download mode).
  if (
    /timed? ?out|timeout|failed to read|invalid head of packet|miswire|no response|unable to connect|failed to connect|could not connect|connection failed|connection timed/.test(
      text
    )
  ) {
    return {
      title: "No communication with the ESP32",
      message:
        "The device is present, but the ESP32 bootloader did not respond. The board is likely not in download mode.",
      tip: "Place the board in download mode: hold the BOOT button, press and release RST, then release BOOT. Try again and ensure the USB cable carries data and the serial driver is installed.",
      detail: raw,
    };
  }

  // Any other failure.
  return {
    title: "Unexpected error",
    message: "The flashing operation could not be completed.",
    tip: "Check the USB connection and reselect the device, then try again. If the problem persists, restart the browser and reconnect the board.",
    detail: raw,
  };
}

export function useEspFlasher(): UseEspFlasher {
  const isSupported =
    typeof navigator !== "undefined" && "serial" in navigator;

  const [status, setStatus] = useState<FlashStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [logMessages, setLogMessages] = useState<string[]>([]);
  const [error, setError] = useState<FlashErrorInfo | null>(null);
  const [chipInfo, setChipInfo] = useState<ChipInfo | null>(null);

  const transportRef = useRef<Transport | null>(null);
  const loaderRef = useRef<ESPLoader | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Terminal implementation passed to ESPLoader so all esptool-js console
  // output (info/warning/error lines) flows into our UI log.
  const terminal = useMemo<IEspLoaderTerminal>(
    () => ({
      clean: () => setLogMessages([]),
      write: (data: string) => appendLogLine(setLogMessages, data),
      writeLine: (data: string) => appendLogLine(setLogMessages, data),
    }),
    []
  );

  const closeTransport = useCallback(async () => {
    const transport = transportRef.current;
    transportRef.current = null;
    loaderRef.current = null;
    if (transport) {
      try {
        await transport.disconnect();
      } catch {
        // Port already closed or otherwise unavailable - ignore.
      }
      // Make sure the underlying SerialPort really is released, otherwise a
      // later reconnect (or another tab) hits "The port is already open".
      const device = transport.device;
      if (device && (device.readable !== null || device.writable !== null)) {
        try {
          await device.close();
        } catch {
          // Already closed - fine.
        }
      }
    }
  }, []);

  // ========================
  // CONNECT
  // ========================
  const connect = useCallback(async () => {
    if (!isSupported) return;
    setStatus("connecting");
    setError(null);
    setLogMessages([]);
    try {
      // If this page already holds a connection (e.g. a flash left the port
      // open after hard_reset), release it before picking another device.
      if (transportRef.current) {
        appendLogLine(setLogMessages, "Closing previous connection...");
        await closeTransport();
      }

      const port = await navigator.serial.requestPort();

      // Release the port first if this browser session still holds it open
      // from a previous attempt, otherwise open() fails with "already open".
      if (port.readable !== null || port.writable !== null) {
        appendLogLine(
          setLogMessages,
          "Closing previous connection on this port..."
        );
        try {
          await port.close();
        } catch {
          // Falls through - the open retries below will surface a clear error.
        }
      }

      // close() releases the streams asynchronously, so a retry loop is needed
      // in case the browser still reports the port as open for a tick.
      let opened = false;
      for (let attempt = 0; attempt < 5 && !opened; attempt++) {
        try {
          await port.open({ baudRate: 115200 });
          opened = true;
        } catch (openErr) {
          const openText = openErr instanceof Error ? openErr.message : String(openErr);
          if (/already open/.test(openText) && attempt < 4) {
            appendLogLine(setLogMessages, `Port still releasing, retrying (${attempt + 1}/4)...`);
            await new Promise((resolve) => setTimeout(resolve, 200));
            continue;
          }
          throw openErr;
        }
      }

      const transport = new Transport(port, true);
      transportRef.current = transport;

      const loader = new ESPLoader({
        transport,
        baudrate: 115200,
        terminal,
      });
      loaderRef.current = loader;

      await loader.main();

      const name = loader.chip?.CHIP_NAME ?? "ESP32";
      let description = name;
      try {
        description = await loader.chip.getChipDescription(loader);
      } catch {
        // Description is best-effort; keep the chip name fallback.
      }
      const flashSize = await loader.detectFlashSize().catch(() => "unknown");

      setChipInfo({ name, description, flashSize });
      setStatus("connected");
    } catch (err) {
      const info = classifyFlashError(err);
      setError(info);
      appendLogLine(setLogMessages, `Error: ${info.detail}`);
      setStatus("idle");
      await closeTransport();
    }
  }, [isSupported, terminal, closeTransport]);

  // ========================
  // DISCONNECT
  // ========================
  const disconnect = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    await closeTransport();
    setChipInfo(null);
    setProgress(0);
    setStatus("idle");
  }, [closeTransport]);

  // ========================
  // FLASH
  // ========================
  const flash = useCallback(
    async (build: FirmwareBuild) => {
      const loader = loaderRef.current;
      if (!loader) return;

      const controller = new AbortController();
      abortRef.current = controller;

      setStatus("flashing");
      setError(null);
      setProgress(0);

      try {
        // Download each firmware binary and pair it with its flash offset.
        const fileArray: { data: Uint8Array; address: number }[] = [];
        for (const file of build.files) {
          if (controller.signal.aborted) {
            setStatus("idle");
            return;
          }
          appendLogLine(setLogMessages, `Downloading ${file.path}...`);
          const res = await fetch(file.path);
          if (!res.ok) {
            throw new Error(`Failed to download ${file.path} (HTTP ${res.status})`);
          }
          const data = new Uint8Array(await res.arrayBuffer());
          fileArray.push({ data, address: file.offset });
          appendLogLine(
            setLogMessages,
            `  ${(data.length / 1024).toFixed(1)} KB ready (0x${file.offset.toString(16)})`
          );
        }

        await loader.writeFlash({
          fileArray,
          flashMode: "keep",
          flashFreq: "keep",
          flashSize: "detect",
          eraseAll: true,
          compress: true,
          reportProgress: (fileIndex, written, total) => {
            const fileCount = Math.max(build.files.length, 1);
            const fileProgress = total > 0 ? written / total : 0;
            // Overall percent weights each file equally.
            const overall = ((fileIndex + fileProgress) / fileCount) * 100;
            setProgress(Math.min(100, Math.round(overall)));
          },
        });

        await loader.after("hard_reset");

        appendLogLine(setLogMessages, "Flash complete! Device is restarting.");
        setStatus("done");
        setProgress(100);
      } catch (err) {
        const info = classifyFlashError(err);
        setError(info);
        appendLogLine(setLogMessages, `Error: ${info.detail}`);
        setStatus("error");
        abortRef.current = null;
      }
    },
    []
  );

  // ========================
  // ABORT
  // ========================
  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Close any open serial port when the page unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      void closeTransport();
    };
  }, [closeTransport]);

  return {
    isSupported,
    status,
    progress,
    logMessages,
    error,
    chipInfo,
    connect,
    disconnect,
    flash,
    abort,
  };
}