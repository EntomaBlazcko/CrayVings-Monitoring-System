let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioContext;
}

function isSoundEnabled(): boolean {
  try {
    const enabled = localStorage.getItem("alertSoundEnabled");
    return enabled === null ? true : enabled === "true";
  } catch {
    return true;
  }
}

export function setSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem("alertSoundEnabled", enabled ? "true" : "false");
  } catch {
    // localStorage not available
  }
}

function playTone(frequency: number, duration: number, type: OscillatorType = "sine"): void {
  try {
    const ctx = getAudioContext();
    
    if (ctx.state === "suspended") {
      ctx.resume();
    }

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.frequency.value = frequency;
    oscillator.type = type;

    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration);
  } catch (e) {
    console.warn("Audio playback failed:", e);
  }
}

export function playWarningSound(): void {
  if (!isSoundEnabled()) return;
  playTone(440, 0.3, "sine");
}

export function playCriticalSound(): void {
  if (!isSoundEnabled()) return;
  playTone(880, 0.15, "square");
  setTimeout(() => playTone(880, 0.15, "square"), 200);
}

export function playLowAlertSound(): void {
  if (!isSoundEnabled()) return;
  playTone(300, 0.4, "sine");
}

export function playHighAlertSound(): void {
  if (!isSoundEnabled()) return;
  playTone(600, 0.4, "square");
}