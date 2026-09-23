import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initializeCustomSounds, ensureAudioContextReady } from "./utils/playAlertSound";

// Browsers block Web Audio until a user gesture; retry on the first
// click/keypress so alert sounds are armed once the user interacts.
initializeCustomSounds().catch(() => {});

const initAudio = async () => {
  try {
    await ensureAudioContextReady();
  } catch { /* autoplay blocked - retried on user input */ }
};

initAudio();
document.addEventListener("click", () => initAudio(), { once: true });
document.addEventListener("keydown", () => initAudio(), { once: true });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
