// =============================================================================
// FILE: src/main.tsx
// =============================================================================
// App entry point: initializes Web Audio and renders root component.
// =============================================================================

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initializeCustomSounds, ensureAudioContextReady } from "./utils/playAlertSound";

// ========================
// AUDIO INITIALIZATION
// ========================
initializeCustomSounds().catch(() => {});

const initAudio = async () => {
  try {
    await ensureAudioContextReady();
  } catch { /* autoplay blocked - retried on user input */ }
};

initAudio();
document.addEventListener("click", () => initAudio(), { once: true });
document.addEventListener("keydown", () => initAudio(), { once: true });

// ========================
// REACT RENDERING
// ========================
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
