export type SoundLevel = "off" | "medium" | "high";
const KEY = "ionic-formula-competition:sound-level";
let context: AudioContext | null = null;

export function savedSoundLevel(): SoundLevel {
  try { const value = localStorage.getItem(KEY); return value === "off" || value === "high" ? value : "medium"; }
  catch { return "medium"; }
}

export function saveSoundLevel(value: SoundLevel): void {
  try { localStorage.setItem(KEY, value); } catch { /* sound preference is optional */ }
}

export function primeAudio(level: SoundLevel): void {
  if (level === "off" || typeof window === "undefined") return;
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume().catch(() => {});
  } catch { /* audio is optional */ }
}

function note(audio: AudioContext, frequency: number, at: number, duration: number, volume: number, waveform: OscillatorType = "sine") {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = waveform;
  oscillator.frequency.setValueAtTime(frequency, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain); gain.connect(audio.destination);
  oscillator.start(at); oscillator.stop(at + duration + 0.01);
}

export function playCountdownTick(level: SoundLevel): void {
  if (level === "off") return;
  try {
    const audio = context;
    if (!audio || audio.state !== "running") return;
    note(audio, 880, audio.currentTime + 0.003, 0.11, level === "high" ? 0.07 : 0.038);
  } catch { /* countdown continues if sound is unavailable */ }
}

export function playAnswerSound(kind: "correct" | "incorrect", level: SoundLevel): void {
  if (level === "off") return;
  try {
    primeAudio(level);
    const audio = context;
    if (!audio || audio.state !== "running") return;
    const volume = level === "high" ? 0.085 : 0.045;
    const start = audio.currentTime + 0.003;
    if (kind === "correct") {
      note(audio, 523.25, start, 0.12, volume);
      note(audio, 659.25, start + 0.055, 0.14, volume * 0.88);
      note(audio, 783.99, start + 0.105, 0.19, volume * 0.78);
    } else {
      note(audio, 392, start, 0.15, volume * 0.8, "triangle");
      note(audio, 311.13, start + 0.1, 0.21, volume * 0.9, "triangle");
      note(audio, 233.08, start + 0.22, 0.3, volume * 0.62, "sine");
    }
  } catch { /* audio must never interrupt grading */ }
}
