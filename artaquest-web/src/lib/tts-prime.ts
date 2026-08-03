// Tiny gesture-unlock helpers, split out so the always-mounted ArtaTTS launcher can import them
// WITHOUT pulling the full engine (use-artatts + the model registry) into the main bundle — that heavy
// code loads lazily with the reader/player.
//
// A single shared <audio> element for neural playback (only one TTS session plays at a time). Reusing
// ONE element lets us UNLOCK it inside a user gesture (iOS autoplay policy) and have every later
// programmatic play() work — priming a per-instance element created after the tap would not.
let _sharedAudio: HTMLAudioElement | null = null;
export function sharedAudio(): HTMLAudioElement {
  if (!_sharedAudio && typeof Audio !== "undefined") _sharedAudio = new Audio();
  return _sharedAudio as HTMLAudioElement;
}

let _primed = false;
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
/** Unlock the audio engine INSIDE a user gesture (call from the click that starts playback). iOS
 *  blocks audio until first triggered from a gesture; this pays that cost up front. */
export function primeTtsEngines() {
  if (_primed) return;
  _primed = true;
  try { const a = sharedAudio(); a.src = SILENT_WAV; const p = a.play(); if (p) p.then(() => { a.pause(); a.currentTime = 0; }).catch(() => { /* */ }); } catch { /* */ }
}
