// The ArtaTTS engine as a reusable hook — ONE paragraph-by-paragraph speech loop shared by the floating
// selection player (artatts-player.tsx) and the reader's embedded Listen (listen.tsx). It owns:
//   · the ONE voice source (operator, 2026-07-21: state-of-the-art on-device ONLY): Kokoro-82M neural
//     voices, precision-tiered per device by the capability probe (lib/tts.ts). The OS speechSynthesis
//     voices, the tiny-model fallback and the cloud tier were removed as below-bar;
//   · PARAGRAPH-BY-PARAGRAPH read-along (operator: sentence chopping mis-split prose; the paragraph is
//     the natural boundary). The CURRENT PARAGRAPH is lit as a single soft gold gradient band
//     (lib/tts-band.ts) that ONE CSS transition glides to the next block — no per-frame highlight work,
//     easy on the eye. Under reduced-motion / the strictest Motion-calm stop the band jumps instantly
//     (the platform motion-safety contract);
//   · smooth scroll-follow that keeps the current paragraph in view without fighting the reader;
//   · the tested-speed ladder, click-a-paragraph-to-jump, iOS gesture unlocking, and full teardown.
// Advancing is entirely EVENT-DRIVEN (audio 'ended') — no requestAnimationFrame.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SPEEDS, NEURAL_VOICES, loadNeural, synthesize, neuralSpeeds, probeTier, cachedProfile,
  type TtsVoice, type Bench, type Sentence, type DeviceProfile,
} from "../lib/tts";
import { makeScrollFollower, type ScrollFollower } from "../lib/tts-scroll";
import { SentenceBand } from "../lib/tts-band";
import { sharedAudio, primeTtsEngines } from "../lib/tts-prime";
import { translateLocal, nllbCode } from "../lib/tts-translate";
import { calmStop } from "../lib/theme";

const VOICE_KEY = "aq_tts_voice";
const RATE_KEY = "aq_tts_rate";
const CACHE_MAX = 6; // synthesized clips kept resident around the play head (rest revoked → no leak)
const BREATH_MS = 340; // a small settle-pause between paragraphs — calmer listening, and prefetch headroom

const reduceQuery = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
/** Calm mode = the platform's motion-safety contract (ArtaContrast): OS "reduce motion" OR the strictest
 *  Motion-calm stop ("Still"). In calm mode the paragraph band JUMPS instantly instead of gliding. */
export function ttsCalmMode(): boolean { return (reduceQuery?.matches ?? false) || calmStop() === 1; }

// English keys keep the historical `n:<id>` form (existing members' picks survive); other languages
// disambiguate with the espeak code — Farsi deliberately SHARES the Hindi style bins.
export const ttsVoiceKey = (v: TtsVoice) => (v.espeak.startsWith("en") ? `n:${v.id}` : `n:${v.id}:${v.espeak}`);

export type ArtaTtsSession = {
  idx: number;
  playing: boolean;
  note: string;
  /** The current paragraph's on-device translation (empty when reading in the document's language). */
  translation: string;
  pct: number | null;
  bench: Bench | null;
  profile: DeviceProfile | null;
  voice: TtsVoice | null;
  speeds: number[];
  rate: number;
  /** Prime the audio engine INSIDE a user gesture (call from the click that starts playback). */
  unlock: () => void;
  /** Set the paragraph list synchronously and start — the gesture-safe cold start (no setState round-trip). */
  playList: (list: Sentence[], i: number) => void;
  playAt: (i: number) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  changeRate: (r: number) => void;
  changeVoice: (key: string) => void;
};

export function useArtaTts(opts: {
  sentences: Sentence[];
  /** The DOCUMENT's language (BCP-47) — picks the default voice, and when the member chooses a
   *  voice in another language the reader translates each paragraph on-device before speaking it. */
  lang?: string;
  /** Element whose paragraph clicks jump playback (null/undefined = document; false-y = none). */
  clickRoot?: HTMLElement | null;
  /** Only jump on clicks while playing (the reader: a paused body click is just a click). */
  clickWhilePlayingOnly?: boolean;
  /** The scroll container to follow within (ReadMode overlay); defaults to the window. */
  scrollContainer?: HTMLElement | null;
  autoStart?: boolean;
  onEnd?: () => void;
  /** The page re-rendered under us and the ranges died — caller decides (rebuild / close). Receives the
   *  index that was playing (synchronously correct, unlike an effect-lagged ref). */
  onDead?: (i: number) => void;
}): ArtaTtsSession {
  const { sentences, lang, clickRoot, autoStart, onEnd, onDead, clickWhilePlayingOnly, scrollContainer } = opts;
  const docLang = (lang || (typeof document !== "undefined" && document.documentElement.lang) || "en").toLowerCase();

  const [profile, setProfile] = useState<DeviceProfile | null>(() => cachedProfile());
  const [voiceKey, setVoiceKey] = useState<string>(() => { try { return localStorage.getItem(VOICE_KEY) || ""; } catch { return ""; } });
  const [rate, setRate] = useState<number>(() => { try { const r = Number(localStorage.getItem(RATE_KEY)); return SPEEDS.includes(r) ? r : 1; } catch { return 1; } });
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [note, setNote] = useState("");
  const [translation, setTranslation] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [bench, setBench] = useState<Bench | null>(null);
  const [calmVer, setCalmVer] = useState(0); // bumped on aq:calm / reduce-motion change → band + follower rebuild

  const seqRef = useRef(0);
  const idxRef = useRef(0);
  const rateRef = useRef(rate);
  const playingRef = useRef(false);
  const intendRef = useRef(false); // "the member wants to be listening" — survives a voice error, so switching to a working voice resumes; cleared only by an explicit pause/stop/end
  const voiceRef = useRef<TtsVoice | null>(null);
  const profileRef = useRef<DeviceProfile | null>(profile);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cacheRef = useRef(new Map<string, Promise<{ url: string; spoken: string }>>());
  const trCacheRef = useRef(new Map<string, Promise<string>>());
  const urlRef = useRef(new Map<string, string>()); // resolved key → blob URL (for revoke)
  const orderRef = useRef<string[]>([]); // LRU access order
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const genRef = useRef(0); // paragraph-list generation — bumped when identity changes → cache invalidates
  const bandRef = useRef<SentenceBand | null>(null);
  const followRef = useRef<ScrollFollower | null>(null);
  const paintRef = useRef<((s: Sentence) => boolean) | null>(null);
  const startedRef = useRef(false);
  const unlockedRef = useRef(false);

  const sentencesRef = useRef(sentences);
  // Mirror the list DURING render (not in an effect): playList/onDead must read the live list in the same
  // tick, before any deferred effect could refresh it (else stale ranges → recursion — audit).
  if (sentencesRef.current !== sentences) {
    sentencesRef.current = sentences;
    genRef.current++;
    for (const u of urlRef.current.values()) URL.revokeObjectURL(u);
    urlRef.current.clear(); cacheRef.current.clear(); orderRef.current = [];
    trCacheRef.current.clear();
  }
  useEffect(() => { rateRef.current = rate; }, [rate]);

  // Resolve the capability profile once. Guard against post-unmount setState.
  useEffect(() => {
    let alive = true;
    (profile ? Promise.resolve(profile) : probeTier()).then((p) => { if (alive) { setProfile(p); profileRef.current = p; } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { profileRef.current = profile; }, [profile]);

  // The paragraph band + scroll follower for this surface (rebuilt if the container OR the calm setting
  // changes — calm mode jumps/scrolls instantly rather than animating).
  useEffect(() => {
    bandRef.current = new SentenceBand(scrollContainer || window);
    followRef.current = makeScrollFollower(scrollContainer || window, ttsCalmMode());
    return () => { bandRef.current?.destroy(); bandRef.current = null; followRef.current?.destroy(); followRef.current = null; };
  }, [scrollContainer, calmVer]);

  // Honour the platform motion contract LIVE (reduce-motion + Motion-calm stop): rebuild the band/follower
  // so the transition switches between smooth and instant.
  useEffect(() => {
    const reeval = () => setCalmVer((v) => v + 1);
    window.addEventListener("aq:calm", reeval);
    reduceQuery?.addEventListener?.("change", reeval);
    return () => { window.removeEventListener("aq:calm", reeval); reduceQuery?.removeEventListener?.("change", reeval); };
  }, []);

  // Resolve the active voice: the persisted pick if it still exists, else a voice for the CONTENT's
  // language, else the English default.
  const voice = useMemo<TtsVoice | null>(() => {
    const persisted = NEURAL_VOICES.find((v) => ttsVoiceKey(v) === voiceKey);
    if (persisted) return persisted;
    const base = docLang.split("-")[0];
    return NEURAL_VOICES.find((v) => v.lang.toLowerCase().split("-")[0] === base) || NEURAL_VOICES[0] || null;
  }, [voiceKey, docLang]);
  useEffect(() => { voiceRef.current = voice; }, [voice]);

  // Reading in another language = on-device NLLB translation per paragraph, then that voice speaks it.
  const translating = useCallback((v: TtsVoice | null): boolean => {
    if (!v) return false;
    const src = docLang.split("-")[0], tgt = v.lang.toLowerCase().split("-")[0];
    return src !== tgt && !!nllbCode(src) && !!nllbCode(tgt);
  }, [docLang]);

  // Speeds are gated by the measured real-time factor (full ladder until the first benchmark lands).
  const speeds = useMemo(() => (bench ? neuralSpeeds(bench.rtf) : [...SPEEDS]), [bench]);
  useEffect(() => {
    if (!speeds.includes(rateRef.current)) {
      const r = [...speeds].reverse().find((s) => s < rateRef.current) ?? speeds[speeds.length - 1];
      rateRef.current = r; setRate(r);
      if (audioRef.current) audioRef.current.playbackRate = r;
    }
  }, [speeds]);

  // ---- highlight (paragraph band) + scroll -------------------------------------------------------
  const clearBand = useCallback(() => { bandRef.current?.hide(); }, []);

  /** Light `sent` (the whole paragraph) and scroll it into view. Returns false if its range died under a
   *  re-render so the caller can rebuild. Death signature: a DOM swap detaches the boundary nodes and the
   *  range migrates up to a still-connected ancestor COLLAPSED — so dead = disconnected OR collapsed.
   *  (A live paragraph is never zero-width; equation-widened ranges legitimately start at Elements.) */
  const light = useCallback((sent: Sentence): boolean => {
    if (!sent.range.startContainer.isConnected || sent.range.collapsed) return false;
    bandRef.current?.show(sent.range, !ttsCalmMode()); // smooth glide, or instant under the calm contract
    followRef.current?.follow(sent.range);
    return true;
  }, []);
  useEffect(() => { paintRef.current = light; }, [light]);

  const applyBench = useCallback((b: Bench) => setBench((cur) => (cur && cur.model === b.model && cur.dtype === b.dtype && cur.device === b.device) ? cur : b), []);
  // The percentage renders as a real progress BAR on both surfaces (pct state); the note carries only
  // the words, so the number is never said twice.
  const onNeuralProgress = useCallback((p: { pct: number; status: string }) => {
    setPct(p.pct < 100 ? p.pct : null);
    setNote(p.status);
  }, []);

  // ---- synthesis cache (LRU + revoke — no leak) --------------------------------------------------
  const touch = useCallback((key: string) => {
    const o = orderRef.current;
    const at = o.indexOf(key); if (at >= 0) o.splice(at, 1);
    o.push(key);
    while (o.length > CACHE_MAX) {
      const ev = o.shift()!;
      if (ev === key) continue;
      const u = urlRef.current.get(ev);
      if (u) { URL.revokeObjectURL(u); urlRef.current.delete(ev); }
      cacheRef.current.delete(ev);
    }
  }, []);

  // Per-paragraph on-device translations (promise-cached by generation + target language, so the
  // read-ahead pipeline translates each paragraph exactly once).
  const textFor = useCallback((i: number, v: TtsVoice): Promise<string> => {
    const list = sentencesRef.current;
    if (!translating(v)) return Promise.resolve(list[i].text);
    const tgt = v.lang.toLowerCase().split("-")[0];
    const key = `${genRef.current}:${tgt}:${i}`;
    let pr = trCacheRef.current.get(key);
    if (!pr) {
      pr = translateLocal(list[i].text, docLang, tgt, onNeuralProgress);
      trCacheRef.current.set(key, pr);
      pr.catch(() => { trCacheRef.current.delete(key); });
    }
    return pr;
  }, [translating, docLang, onNeuralProgress]);

  /** Synthesize paragraph i on-device (translating first when reading in another language) → a clip URL. */
  const entryFor = useCallback((i: number): Promise<{ url: string; spoken: string }> => {
    const v = voiceRef.current, p = profileRef.current, list = sentencesRef.current;
    if (!v || !p || i >= list.length) return Promise.reject(new Error("n/a"));
    // Farsi shares Hindi style bins — the espeak code keeps their cache entries distinct.
    const key = `${genRef.current}:${v.id}:${v.espeak}:${i}`;
    let pr = cacheRef.current.get(key);
    if (!pr) {
      const myGen = genRef.current;
      const synth = async () => {
        const spoken = await textFor(i, v);
        const raw = await synthesize(spoken, v, p, onNeuralProgress);
        const url = URL.createObjectURL(raw.toBlob());
        // Evicted (LRU) or invalidated (gen bumped) while pending → revoke now instead of leaking.
        if (myGen === genRef.current && cacheRef.current.get(key) === pr) urlRef.current.set(key, url);
        else URL.revokeObjectURL(url);
        return { url, spoken };
      };
      // Serialize CPU/GPU synth through chainRef — one paragraph generates at a time.
      pr = chainRef.current.then(synth);
      chainRef.current = pr.then(() => undefined, () => undefined);
      cacheRef.current.set(key, pr);
      pr.catch(() => { cacheRef.current.delete(key); });
    }
    touch(key);
    return pr;
  }, [onNeuralProgress, touch, textFor]);

  // ---- the play loop (event-driven advance; no rAF) ----------------------------------------------
  const finish = useCallback(() => {
    seqRef.current++;
    setPlaying(false); playingRef.current = false; intendRef.current = false;
    clearBand(); setTranslation("");
    onEnd?.();
  }, [clearBand, onEnd]);

  const playAt = useCallback(async (i: number) => {
    const v = voiceRef.current, list = sentencesRef.current;
    if (!v) return;
    if (i >= list.length) { finish(); return; }
    const seq = ++seqRef.current;
    idxRef.current = i; setIdx(i);
    setPlaying(true); playingRef.current = true; intendRef.current = true;
    const sent = list[i];
    if (!light(sent)) { // ranges died under us (re-typeset) — let the caller rebuild + resume
      seqRef.current++; setPlaying(false); playingRef.current = false; onDead?.(i); return;
    }
    // Synth (serialized+cached; translated first in another-language mode), play, advance on 'ended'.
    try {
      if (!cacheRef.current.has(`${genRef.current}:${v.id}:${v.espeak}:${i}`)) setNote(translating(v) ? "Translating…" : "Preparing…");
      const p = profileRef.current;
      // Bench (speed-ladder) rides the Kokoro engine only — Piper voices are small and fast, and
      // must never force the Kokoro download.
      if (p && v.model !== "piper") { const { bench: b } = await loadNeural("kokoro", p.dtype, p.device, onNeuralProgress); applyBench(b); }
      if (seqRef.current !== seq) return;
      const e = await entryFor(i);
      if (seqRef.current !== seq) return;
      // The translation panel shows WHAT is being spoken while the band lights the source paragraph.
      setTranslation(translating(v) ? e.spoken : "");
      // Read-ahead: while THIS block plays, the next TWO synthesize (the chain serializes them), so
      // even a device whose synth runs near real time stays gapless between paragraphs.
      if (i + 1 < list.length) entryFor(i + 1).catch(() => { /* prefetch */ });
      if (i + 2 < list.length) entryFor(i + 2).catch(() => { /* prefetch */ });
      setNote(""); setPct(null);
      const a = sharedAudio();
      audioRef.current = a;
      a.onended = () => { if (seqRef.current === seq) window.setTimeout(() => { if (seqRef.current === seq) playAt(i + 1); }, BREATH_MS); };
      a.onpause = () => { if (seqRef.current === seq && !a.ended && playingRef.current) { setPlaying(false); playingRef.current = false; } };
      a.onerror = () => { if (seqRef.current === seq) { setNote("Audio playback failed — press play to retry"); setPlaying(false); playingRef.current = false; } };
      a.src = e.url;
      a.playbackRate = rateRef.current;
      try { (a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true; } catch { /* */ }
      await a.play();
    } catch (err) {
      if (seqRef.current !== seq) return;
      setPct(null);
      const msg = err instanceof Error ? err.message : "";
      setNote(msg === "no-profile" ? "Probing your device…"
        : /insufficient-memory/.test(msg) ? "This device doesn't have enough memory to translate — pick a voice in the document's language"
        : /HTTP|fetch|network|Failed to/i.test(msg) ? "The voice download was interrupted — press play to retry (it resumes from the cache)"
        : /translation pair/.test(msg) ? "Translation between these languages isn't available yet"
        : "The voice could not start — press play to try again");
      setPlaying(false); playingRef.current = false;
    }
  }, [finish, light, entryFor, applyBench, onNeuralProgress, onDead]);

  const playList = useCallback((list: Sentence[], i: number) => {
    // A rebuilt list (onDead recovery / cold start) can carry DIFFERENT paragraph text (a live translation
    // swap) — the cached clips keyed by genRef:voice:index would be stale. Invalidate them here (the
    // render-time mirror can't see this synchronous ref assignment).
    if (sentencesRef.current !== list) {
      genRef.current++;
      for (const u of urlRef.current.values()) URL.revokeObjectURL(u);
      urlRef.current.clear(); cacheRef.current.clear(); orderRef.current = [];
    trCacheRef.current.clear();
    }
    sentencesRef.current = list;
    playAt(i);
  }, [playAt]);

  const pause = useCallback(() => {
    seqRef.current++;
    setPlaying(false); playingRef.current = false; intendRef.current = false;
    chainRef.current = Promise.resolve(); // a dead/slow synth must never block the next play
    audioRef.current?.pause();
  }, []);

  const resume = useCallback(() => {
    const a = audioRef.current, list = sentencesRef.current;
    const i = idxRef.current;
    if (a && a.src && a.paused && !a.ended && a.currentTime > 0 && list[i]) {
      const seq = ++seqRef.current;
      a.onended = () => { if (seqRef.current === seq) playAt(i + 1); };
      a.onpause = () => { if (seqRef.current === seq && !a.ended && playingRef.current) { setPlaying(false); playingRef.current = false; } };
      setPlaying(true); playingRef.current = true; intendRef.current = true;
      a.playbackRate = rateRef.current;
      light(list[i]);
      a.play().catch(() => { if (seqRef.current === seq) playAt(i); });
    } else playAt(i);
  }, [playAt, light]);

  const stop = useCallback(() => { pause(); clearBand(); setTranslation(""); }, [pause, clearBand]);

  const changeRate = useCallback((r: number) => {
    rateRef.current = r; setRate(r);
    try { localStorage.setItem(RATE_KEY, String(r)); } catch { /* */ }
    if (audioRef.current) audioRef.current.playbackRate = r;
  }, []);

  const changeVoice = useCallback((key: string) => {
    const v = NEURAL_VOICES.find((x) => ttsVoiceKey(x) === key);
    if (!v) return;
    const wasActive = intendRef.current; // captured BEFORE pause() clears it — survives a prior voice error
    pause();
    for (const u of urlRef.current.values()) URL.revokeObjectURL(u); // old voice's clips are useless now
    urlRef.current.clear(); cacheRef.current.clear(); orderRef.current = [];
    trCacheRef.current.clear();
    voiceRef.current = v;
    setVoiceKey(key); setNote(""); setTranslation("");
    try { localStorage.setItem(VOICE_KEY, key); } catch { /* */ }
    if (wasActive) playAt(idxRef.current); // switching to a working voice after an error resumes listening
  }, [pause, playAt]);

  const unlock = useCallback(() => { if (unlockedRef.current) return; unlockedRef.current = true; primeTtsEngines(); }, []);

  // Auto-start once the voice resolved — the member tapped Listen, so listening begins.
  useEffect(() => {
    if (autoStart && !startedRef.current && voice && sentences.length) { startedRef.current = true; playAt(0); }
  }, [autoStart, voice, sentences, playAt]);

  // Click a paragraph within clickRoot → jump there (links/buttons keep their own behaviour).
  useEffect(() => {
    const root: EventTarget | null = clickRoot === undefined ? document : clickRoot;
    if (!root) return;
    const onClick = (e: Event) => {
      const me = e as MouseEvent;
      const t = me.target as Element | null;
      if (t?.closest?.("a,button,input,select,textarea,.aq-tts-ui,.aq-read-bar")) return;
      if (clickWhilePlayingOnly && !playingRef.current) return;
      const list = sentencesRef.current;
      for (let i = 0; i < list.length; i++) {
        for (const rc of list[i].range.getClientRects()) {
          if (me.clientX >= rc.left && me.clientX <= rc.right && me.clientY >= rc.top && me.clientY <= rc.bottom) { playAt(i); return; }
        }
      }
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [clickRoot, clickWhilePlayingOnly, playAt]);

  // Full teardown on unmount: silence the audio, drop blob URLs, remove the band.
  useEffect(() => () => {
    seqRef.current++;
    const a = audioRef.current;
    if (a) { a.pause(); a.removeAttribute("src"); }
    for (const u of urlRef.current.values()) URL.revokeObjectURL(u);
    urlRef.current.clear(); cacheRef.current.clear(); orderRef.current = [];
    trCacheRef.current.clear();
  }, []);

  return { idx, playing, note, translation, pct, bench, profile, voice, speeds, rate, unlock, playList, playAt, pause, resume, stop, changeRate, changeVoice };
}
