// Default synthesized tone parameters, used as fallback when MP3 files are unavailable
const TONE_CONFIG = {
  warning: { frequency: 440, duration: 0.3, type: "sine" as OscillatorType },
  critical: { frequency: 880, duration: 0.15, type: "square" as OscillatorType, repeatDelay: 200 },
  low: { frequency: 300, duration: 0.4, type: "sine" as OscillatorType },
  high: { frequency: 600, duration: 0.4, type: "square" as OscillatorType },
  // Reconnect confirmation: brighter and longer than a warning so it reads as
  // "all good" rather than an alarm.
  success: { frequency: 660, duration: 0.5, type: "sine" as OscillatorType },
} as const;

// AUDIO PARAMETERS
const DEFAULT_VOLUME = 0.8;
const MIN_FREQ = 1;
const MAX_FREQ = 20000;
const MAX_DURATION = 10;

// SHARED STATE
// Singleton AudioContext and volume setting
let audioContext: AudioContext | null = null;
let volume: number = DEFAULT_VOLUME;

// Pre-loaded audio buffers indexed by sound key ("warning", "critical", etc.)
const audioBuffers: Record<string, AudioBuffer> = {};

// AUDIO CONTEXT MANAGEMENT

// Browsers suspend the AudioContext until a user interaction; resume it here
async function ensureAudioContext(): Promise<AudioContext> {
  if (!audioContext) {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      throw new Error("Web Audio API not supported");
    }
    audioContext = new AudioCtx();
  }
  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch {
      // Browser blocked audio - will work after user interaction
    }
  }
  return audioContext;
}

// Validates tone params to prevent audio errors
function validateParams(frequency: number, duration: number, type: OscillatorType): void {
  if (frequency < MIN_FREQ || frequency > MAX_FREQ) {
    throw new Error(`Invalid frequency`);
  }
  if (duration <= 0 || duration > MAX_DURATION) {
    throw new Error(`Invalid duration`);
  }
  const validTypes: OscillatorType[] = ["sine", "square", "sawtooth", "triangle"];
  if (!validTypes.includes(type)) {
    throw new Error(`Invalid type`);
  }
}

// SOUND ENABLE/DISABLE (localStorage)

function isSoundEnabled(): boolean {
  try {
    const enabled = localStorage.getItem("alertSoundEnabled");
    return enabled === null || enabled === "true";
  } catch {
    return true;
  }
}

export function getIsSoundEnabled(): boolean {
  return isSoundEnabled();
}

// Enables/disables sound; persisted to localStorage
export function setSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem("alertSoundEnabled", enabled ? "true" : "false");
  } catch {
    // localStorage unavailable (e.g., private browsing)
  }
}

// VOLUME CONTROL

export function getVolume(): number {
  return volume;
}

// Sets volume, clamped to 0-1; invalid values reset to default
export function setVolume(newVolume: number): void {
  if (typeof newVolume !== "number" || !Number.isFinite(newVolume)) {
    volume = DEFAULT_VOLUME;
    return;
  }
  volume = Math.max(0, Math.min(1, newVolume));
}

// SYNTHESIZED TONE PLAYBACK

// Plays a synth tone via oscillator + gain with exponential fade-out
async function playTone(frequency: number, duration: number, type: OscillatorType = "sine"): Promise<void> {
  validateParams(frequency, duration, type);

  const ctx = await ensureAudioContext();
  let oscillator: OscillatorNode | null = null;
  let gainNode: GainNode | null = null;
  
  try {
    oscillator = ctx.createOscillator();
    gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.frequency.value = frequency;
    oscillator.type = type;
    
    // Exponential fade-out avoids an abrupt click at the end
    gainNode.gain.setValueAtTime(volume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration);

    await new Promise(resolve => setTimeout(resolve, duration * 1000 + 50));
  } catch {
    // Audio error - fail silently, playback continues
  } finally {
    if (oscillator) { try { oscillator.disconnect(); } catch { /* ignore */ } }
    if (gainNode) { try { gainNode.disconnect(); } catch { /* ignore */ } }
  }
}

// CUSTOM SOUND (MP3) PLAYBACK

// Plays a pre-loaded audio buffer (MP3) via AudioBufferSourceNode
async function playCustomSound(audioBuffer: AudioBuffer): Promise<void> {
  const ctx = await ensureAudioContext();
  let source: AudioBufferSourceNode | null = null;
  let gainNode: GainNode | null = null;
  
  try {
    source = ctx.createBufferSource();
    gainNode = ctx.createGain();
  
    source.buffer = audioBuffer;
    source.connect(gainNode);
    gainNode.connect(ctx.destination);
    gainNode.gain.value = volume;

    source.start(0);
    await new Promise(resolve => { 
      if (source) { source.onended = resolve; }
    });
  } catch {
    // Audio error - fail silently
  } finally {
    if (source) { try { source.disconnect(); } catch { /* ignore */ } }
    if (gainNode) { try { gainNode.disconnect(); } catch { /* ignore */ } }
  }
}

// Decodes raw audio data into an AudioBuffer
async function decodeAudioData(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = await ensureAudioContext();
  return ctx.decodeAudioData(arrayBuffer);
}

// SOUND LOADING FUNCTIONS

// Fetches and decodes an audio file from a URL, storing it by key
export async function setCustomSound(key: string, url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await decodeAudioData(arrayBuffer);
  audioBuffers[key] = audioBuffer;
}

// Decodes and stores an audio file from a Blob
export async function setCustomSoundFromBlob(key: string, blob: Blob): Promise<void> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await decodeAudioData(arrayBuffer);
  audioBuffers[key] = audioBuffer;
}

export function clearCustomSound(key: string): void {
  delete audioBuffers[key];
}

export function hasCustomSound(key: string): boolean {
  return key in audioBuffers;
}

// DEFAULT SOUND FILE URLS
// MP3 paths in public/sounds/
const SOUND_URLS = {
  warning: "/sounds/warning.mp3",
  critical: "/sounds/critical.mp3",
  low: "/sounds/low.mp3",
  high: "/sounds/high.mp3",
  // Filename keeps the original "SUCESS" spelling; don't "fix" it without
  // renaming the asset itself or preload silently falls through to the tone.
  success: "/sounds/SUCESS.mp3",
} as const;

// Pre-loads all default sound files; failures fall back to synth tones
export async function initializeCustomSounds(): Promise<void> {
  const loadPromises = Object.entries(SOUND_URLS).map(async ([key, url]) => {
    try {
      await setCustomSound(key, url);
    } catch {
      // Use synth tone instead if file fails to load
    }
  });
  await Promise.allSettled(loadPromises);
}

// Ensures AudioContext is ready for playback (called from main.tsx)
export async function ensureAudioContextReady(): Promise<void> {
  await ensureAudioContext();
}

// Picks a pre-loaded custom sound (MP3) or falls back to a synthesized tone
async function getActiveSound(key: string): Promise<{ type: "custom" | "synth"; play: () => Promise<void> }> {
  if (audioBuffers[key]) {
    return {
      type: "custom",
      play: () => playCustomSound(audioBuffers[key]),
    };
  }

  const toneConfig = getToneConfigForKey(key);
  return {
    type: "synth",
    play: () => playTone(toneConfig.frequency, toneConfig.duration, toneConfig.type),
  };
}

// Tone config for a sound key; unknown keys fall back to a default 440Hz sine
function getToneConfigForKey(key: string): { frequency: number; duration: number; type: OscillatorType } {
  switch (key) {
    case "warning": return TONE_CONFIG.warning;
    case "critical": return { frequency: TONE_CONFIG.critical.frequency, duration: TONE_CONFIG.critical.duration, type: TONE_CONFIG.critical.type };
    case "low": return TONE_CONFIG.low;
    case "high": return TONE_CONFIG.high;
    case "success": return TONE_CONFIG.success;
    default: return { frequency: 440, duration: 0.3, type: "sine" };
  }
}

// PUBLIC SOUND PLAYBACK FUNCTIONS

export async function playWarningSound(): Promise<void> {
  if (!isSoundEnabled()) return;
  try {
    await ensureAudioContextReady();
  } catch {
    // Best effort: a locked context still gets one play() attempt below.
  }
  const sound = await getActiveSound("warning");
  try {
    if (import.meta?.env?.DEV) {
      console.debug(`[alert-sound] playing warning (type=${sound.type})`);
    }
  } catch {
    // DEV logging must never break playback.
  }
  await sound.play();
}

// Synth critical tone plays twice with a short delay for urgency
export async function playCriticalSound(): Promise<void> {
  if (!isSoundEnabled()) return;
  // Ensure audio context is ready (in case user hasn't interacted yet)
  try {
    await ensureAudioContextReady();
  } catch {
    // Ignore; will try to play anyway
  }
  const sound = await getActiveSound("critical");
  try {
    if (import.meta?.env?.DEV) {
      console.debug(`[alert-sound] playing critical (type=${sound.type})`);
    }
  } catch {
    // DEV logging must never break playback.
  }
  await sound.play();
  // Always do a short follow-up beep for critical urgency (both MP3 and synth)
  const { repeatDelay } = TONE_CONFIG.critical;
  await new Promise(resolve => setTimeout(resolve, repeatDelay));
  await sound.play();
}

export async function playLowAlertSound(): Promise<void> {
  if (!isSoundEnabled()) return;
  try {
    await ensureAudioContextReady();
  } catch {
    // Best effort: a locked context still gets one play() attempt below.
  }
  const sound = await getActiveSound("low");
  try {
    if (import.meta?.env?.DEV) {
      console.debug(`[alert-sound] playing low (type=${sound.type})`);
    }
  } catch {
    // DEV logging must never break playback.
  }
  await sound.play();
}

export async function playHighAlertSound(): Promise<void> {
  if (!isSoundEnabled()) return;
  try {
    await ensureAudioContextReady();
  } catch {
    // Best effort: a locked context still gets one play() attempt below.
  }
  const sound = await getActiveSound("high");
  await sound.play();
}

// Device reconnect confirmation. Fired by DeviceConnectionMonitor when a tank
// transitions offline -> online, so the operator gets positive feedback that
// the hardware is back without watching the fleet list.
export async function playSuccessSound(): Promise<void> {
  if (!isSoundEnabled()) return;
  try {
    await ensureAudioContextReady();
  } catch {
    // Best effort: a locked context still gets one play() attempt below.
  }
  const sound = await getActiveSound("success");
  try {
    if (import.meta?.env?.DEV) {
      console.debug(`[alert-sound] playing success (type=${sound.type})`);
    }
  } catch {
    // DEV logging must never break playback.
  }
  await sound.play();
}

// DEV-only test helpers
export async function testCriticalSound(): Promise<void> {
  try {
    await ensureAudioContextReady();
  } catch {
    // playCriticalSound makes its own attempt; a locked context is not fatal.
  }
  await playCriticalSound();
}

if (import.meta && import.meta.env && import.meta.env.DEV) {
  try {
    (window as unknown as { __testCriticalSound?: () => Promise<void> }).__testCriticalSound = testCriticalSound;
    (window as unknown as { __playCriticalSound?: () => Promise<void> }).__playCriticalSound = playCriticalSound;
    (window as unknown as { __playWarningSound?: () => Promise<void> }).__playWarningSound = playWarningSound;
    (window as unknown as { __playSuccessSound?: () => Promise<void> }).__playSuccessSound = playSuccessSound;
  } catch {
    // Exposing dev helpers is optional; never break module load over it.
  }
}
