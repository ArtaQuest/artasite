// Listen — the reader's ONE voice control (ReadMode bar). Sources behind one picker:
//   · ArtaTTS (default, always there): use-artatts.ts reads the WHOLE document PARAGRAPH BY PARAGRAPH,
//     lighting the current block as a soft gradient band. ONE voice source (operator, 2026-07-21:
//     state-of-the-art on-device only): the Kokoro-82M neural voices — nothing the member reads
//     ever leaves the device.
//   · Recorded narrations (when the work has them): studio-made Edge neural recordings played from audio
//     with per-paragraph timings (the ArtaVoice read-along) — these still use the CSS Custom Highlight API
//     to follow the stored timings. Any member can record one in any language (costs ArtaCoins by length).
// One mental model everywhere: press Listen, the paragraph follow moves; prev/next steps paragraphs; while
// playing, clicking a paragraph jumps to it. Every colour is a theme token, so light/dark/contrast follow.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import EDGE_VOICES from "../data/edge-voices.json";
import { listNarrations, createNarration, isLoggedIn, ApiError, type Narration } from "../lib/api";
import { SPEEDS, NEURAL_VOICES, VOICE_GROUPS, sentencesFromRoot, voiceDownloadMB, type Sentence } from "../lib/tts";
import { useArtaTts, ttsVoiceKey } from "./use-artatts";
import { primeTtsEngines } from "../lib/tts-prime";

// ── recorded-narration alignment (MUST mirror Narrate::segments in PHP: one segment per leaf block) ──
const NARR_BLOCK_SEL = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption";
const NARR_RATE_KEY = "aq_read_rate";
const HL_API = typeof CSS !== "undefined" && "highlights" in CSS && typeof (globalThis as { Highlight?: unknown }).Highlight !== "undefined";
type EdgeVoice = { id: string; lang: string; gender: string; name: string };
const VOICES = EDGE_VOICES as EdgeVoice[];

let narrStyleInjected = false;
function injectNarrStyle() {
  if (narrStyleInjected || typeof document === "undefined") return;
  narrStyleInjected = true;
  const el = document.createElement("style");
  el.textContent = "::highlight(aq-narr){background-color:color-mix(in srgb,var(--color-yang) 34%,transparent);color:inherit}";
  document.head.appendChild(el);
}

const langName = (() => {
  let dn: Intl.DisplayNames | null = null, rn: Intl.DisplayNames | null = null;
  try { dn = new Intl.DisplayNames(["en"], { type: "language" }); rn = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* */ }
  return (code: string) => {
    const [l, r] = code.replace(/_/g, "-").split("-");
    try { const base = dn?.of(l) || l; const reg = r && r.length === 2 && rn?.of(r.toUpperCase()); return reg ? `${base} (${reg})` : base; } catch { return code; }
  };
})();

/** Paragraph Ranges over the article's leaf blocks, positionally aligned with the server's
 *  per-block narration segments (same block set, empties dropped, whitespace trimmed). */
function buildNarrRanges(root: HTMLElement): Range[] {
  const out: Range[] = [];
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(NARR_BLOCK_SEL))
    .filter((el) => !el.querySelector(NARR_BLOCK_SEL) && (el.textContent || "").trim().length > 0);
  for (const block of blocks) {
    const nodes: { node: Text; start: number; end: number }[] = [];
    let full = "";
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) { const tx = n.nodeValue || ""; nodes.push({ node: n as Text, start: full.length, end: full.length + tx.length }); full += tx; }
    if (!full.trim()) continue;
    const locate = (off: number) => {
      for (const nd of nodes) if (off >= nd.start && off <= nd.end) return { node: nd.node, off: off - nd.start };
      const lastN = nodes[nodes.length - 1];
      return lastN ? { node: lastN.node, off: lastN.node.length } : null;
    };
    let a = 0, b = full.length;
    while (a < b && /\s/.test(full[a])) a++;
    while (b > a && /\s/.test(full[b - 1])) b--;
    if (a >= b) continue;
    const A = locate(a), B = locate(b);
    if (!A || !B) continue;
    const r = document.createRange();
    try { r.setStart(A.node, A.off); r.setEnd(B.node, B.off); out.push(r); } catch { /* */ }
  }
  return out;
}

export type ListenHandle = { toggle: () => void; playing: boolean };

export const Listen = forwardRef<ListenHandle, {
  bodyRef: React.RefObject<HTMLElement | null>;
  /** Narratable work (recorded-narration source + the record flow) — e.g. {type:'book', id}. */
  target?: { type: string; id: number };
  /** Content language (BCP-47) — default voice pick; a voice in ANOTHER language turns on the
   *  on-device translator (translate → show → speak). */
  lang?: string;
}>(function Listen({ bodyRef, target, lang }, handleRef) {
  const docLang = (lang || document.documentElement.lang || navigator.language || "en").toLowerCase();
  // ── source: "tts" (ArtaTTS, default) or a recorded narration id ──
  const [source, setSource] = useState<string>("tts");
  const [narrations, setNarrations] = useState<Narration[]>([]);
  const done = useMemo(() => narrations.filter((n) => n.state === "done" && n.audio_url), [narrations]);
  const pending = useMemo(() => narrations.filter((n) => n.state === "queued" || n.state === "processing"), [narrations]);
  const narr = useMemo(() => (source.startsWith("narr:") ? done.find((n) => n.id === Number(source.slice(5))) || null : null), [source, done]);

  const load = useCallback(async () => {
    if (!target) return;
    try { setNarrations((await listNarrations(target.type, target.id)).items); } catch { /* */ }
  }, [target]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!pending.length) return; const h = setInterval(load, 15000); return () => clearInterval(h); }, [pending.length, load]);

  // ── ArtaTTS path: whole-document paragraphs, built lazily and rebuilt if the DOM re-typesets ──
  const [ttsSents, setTtsSents] = useState<Sentence[]>([]);
  const buildTts = useCallback((): Sentence[] => {
    const root = bodyRef.current;
    const s = root ? sentencesFromRoot(root) : [];
    setTtsSents(s);
    return s;
  }, [bodyRef]);
  // The reader's own scroll container (the ReadMode overlay is overflow:auto with its own scroll) — the
  // paragraph-follow scrolls THAT, not the window. Resolve it from the body once it's mounted.
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let el = bodyRef.current?.parentElement || null;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") { setScroller(el); return; }
      el = el.parentElement;
    }
  }, [bodyRef, ttsSents.length]);
  const rebuildsRef = useRef(0);
  const lastRebuildRef = useRef(0);
  const tts = useArtaTts({
    sentences: ttsSents,
    lang: docLang,
    clickRoot: bodyRef.current,
    clickWhilePlayingOnly: true,
    scrollContainer: scroller,
    onDead: (i) => { // the body re-rendered under us (math typeset / translation) — rebuild + resume at i
      // Storm guard scoped to a SHORT WINDOW: a genuine tight recursion (onDead→playAt→onDead) happens
      // within one frame, so only rapid rebuilds count. Legitimate, well-spaced re-typesets across a
      // long multilingual/math session reset the budget and always recover (a lifetime counter would
      // permanently kill recovery after 8 rebuilds).
      const now = performance.now();
      if (now - lastRebuildRef.current > 3000) rebuildsRef.current = 0;
      lastRebuildRef.current = now;
      if (++rebuildsRef.current > 8) return;
      const s = buildTts();
      // playList sets the engine's sentence list SYNCHRONOUSLY, so this can't re-read the dead ranges
      // and recurse (unlike a plain playAt, which would read the not-yet-committed list).
      if (s.length) tts.playList(s, Math.min(i, s.length - 1));
    },
  });

  // ── recorded-narration path (audio + per-sentence timings) ──
  const [narrPlaying, setNarrPlaying] = useState(false);
  const [narrRate, setNarrRate] = useState<number>(() => { try { const r = Number(localStorage.getItem(NARR_RATE_KEY)); return r >= 0.5 && r <= 2.5 ? r : 1; } catch { return 1; } });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const narrRangesRef = useRef<Range[]>([]);
  const narrHlRef = useRef<Highlight | null>(null);
  const narrCurRef = useRef(-1);
  useEffect(() => { injectNarrStyle(); }, []);
  useEffect(() => { try { localStorage.setItem(NARR_RATE_KEY, String(narrRate)); } catch { /* */ } if (audioRef.current) audioRef.current.playbackRate = narrRate; }, [narrRate]);

  const narrClear = useCallback(() => {
    narrCurRef.current = -1;
    if (HL_API && narrHlRef.current) narrHlRef.current.clear();
    if (!HL_API) { try { window.getSelection()?.removeAllRanges(); } catch { /* */ } }
  }, []);
  const narrRanges = useCallback(() => {
    if (!narrRangesRef.current.length && bodyRef.current) narrRangesRef.current = buildNarrRanges(bodyRef.current);
    return narrRangesRef.current;
  }, [bodyRef]);
  const narrHighlight = useCallback((i: number) => {
    const r = narrRanges()[i];
    if (!r || !r.startContainer.isConnected) { narrRangesRef.current = []; return; }
    if (HL_API) {
      if (!narrHlRef.current) { narrHlRef.current = new Highlight(); (CSS as unknown as { highlights: Map<string, Highlight> }).highlights.set("aq-narr", narrHlRef.current); }
      narrHlRef.current.clear(); narrHlRef.current.add(r);
    } else {
      const sel = window.getSelection();
      try { sel?.removeAllRanges(); sel?.addRange(r); } catch { /* */ }
    }
    const block = (r.startContainer.parentElement)?.closest(NARR_BLOCK_SEL) as HTMLElement | null;
    try { (block || r.startContainer.parentElement)?.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* */ }
  }, [narrRanges]);
  const onNarrTime = useCallback(() => {
    const a = audioRef.current;
    if (!a || !narr?.segments) return;
    const t = a.currentTime;
    let idx = -1;
    for (const sg of narr.segments) { if (t >= sg.start && t < sg.start + sg.dur) { idx = sg.i; break; } if (t >= sg.start) idx = sg.i; }
    if (idx >= 0 && idx !== narrCurRef.current) { narrCurRef.current = idx; narrHighlight(idx); }
  }, [narr, narrHighlight]);
  const narrPlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || !narr) return;
    narrRanges();
    a.playbackRate = narrRate;
    a.play().then(() => setNarrPlaying(true)).catch(() => { /* */ });
  }, [narr, narrRanges, narrRate]);
  const narrPause = useCallback(() => { audioRef.current?.pause(); setNarrPlaying(false); }, []);
  const narrStep = useCallback((dir: 1 | -1) => {
    const a = audioRef.current;
    if (!a || !narr?.segments) return;
    const cur = narrCurRef.current; // distinguish "unstarted" (-1) from segment 0
    const target = cur < 0 ? 0 : Math.max(0, Math.min(narr.segments.length - 1, cur + dir));
    const seg = narr.segments.find((sg) => sg.i === target);
    if (seg) { a.currentTime = seg.start; narrHighlight(seg.i); narrCurRef.current = seg.i; }
  }, [narr, narrHighlight]);
  // While playing, a click on a sentence seeks to it (paused clicks are just clicks — same rule as TTS).
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !narr?.segments) return;
    const onClick = (e: MouseEvent) => {
      const a = audioRef.current;
      if (!a || a.paused) return;
      if ((e.target as Element | null)?.closest?.("a,button,input,select,textarea,.aq-tts-ui,.aq-read-bar")) return;
      const rs = narrRanges();
      let hit = -1;
      for (let i = 0; i < rs.length; i++) { for (const rc of rs[i].getClientRects()) { if (e.clientX >= rc.left && e.clientX <= rc.right && e.clientY >= rc.top && e.clientY <= rc.bottom) { hit = i; break; } } if (hit >= 0) break; }
      if (hit < 0) return;
      const seg = narr.segments!.find((sg) => sg.i === hit);
      if (seg) a.currentTime = seg.start;
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [bodyRef, narr, narrRanges]);
  // Reset the narration follow when the source changes; full stop when leaving the narration source.
  useEffect(() => { narrRangesRef.current = []; narrClear(); }, [narr?.id, narrClear]);
  useEffect(() => () => { try { audioRef.current?.pause(); } catch { /* */ } narrClear(); }, [narrClear]);

  // ── one surface: switching source silences the other path ──
  const isTts = source === "tts";
  const playing = isTts ? tts.playing : narrPlaying;
  const changeSource = useCallback((v: string) => {
    if (v.startsWith("v:")) { // an ArtaTTS voice pick — also switches the source to tts
      tts.changeVoice(v.slice(2));
      narrPause(); narrClear();
      setSource("tts");
      return;
    }
    if (v === source) return;
    tts.stop(); narrPause(); narrClear();
    setSource(v);
  }, [source, tts, narrPause, narrClear]);

  const play = useCallback(() => {
    if (isTts) {
      if (!ttsSents.length || !ttsSents[0].range.startContainer.isConnected) {
        const s = buildTts();
        if (!s.length) return;
        // Set the list + start SYNCHRONOUSLY (still inside the tap) — gesture-safe on iOS, and never
        // reads a not-yet-committed list.
        tts.playList(s, 0);
        return;
      }
      tts.resume();
    } else narrPlay();
  }, [isTts, ttsSents, buildTts, tts, narrPlay]);
  const pause = useCallback(() => { if (isTts) tts.pause(); else narrPause(); }, [isTts, tts, narrPause]);
  const toggle = useCallback(() => {
    if (playing) { pause(); return; }
    primeTtsEngines(); // unlock audio + speechSynthesis inside this tap (iOS)
    play();
  }, [playing, pause, play]);
  useImperativeHandle(handleRef, () => ({ toggle, playing }), [toggle, playing]);

  const step = useCallback((dir: 1 | -1) => {
    if (isTts) { if (ttsSents.length) tts.playAt(Math.max(0, Math.min(ttsSents.length - 1, tts.idx + dir))); }
    else narrStep(dir);
  }, [isTts, ttsSents, tts, narrStep]);

  const rate = isTts ? tts.rate : narrRate;
  const changeRate = useCallback((r: number) => { if (isTts) tts.changeRate(r); else setNarrRate(r); }, [isTts, tts]);

  // ── the record-a-narration panel (any member, any language; costs ₳ by length) ──
  const [panel, setPanel] = useState(false);
  const [recLang, setRecLang] = useState("en-US");
  const [recVoice, setRecVoice] = useState("en-US-AndrewMultilingualNeural");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const wordCount = useMemo(() => (bodyRef.current?.textContent || "").trim().split(/\s+/).filter(Boolean).length, [bodyRef, panel]);
  const estCost = Math.max(1, Math.ceil(wordCount / 2000));
  const recLangs = useMemo(() => {
    const set = new Map<string, string>();
    for (const v of VOICES) if (!set.has(v.lang)) set.set(v.lang, langName(v.lang));
    return [...set.entries()].sort((a, b) => (Number(b[0].startsWith("en")) - Number(a[0].startsWith("en"))) || a[1].localeCompare(b[1]));
  }, []);
  const recVoices = useMemo(() => VOICES.filter((v) => v.lang === recLang), [recLang]);
  useEffect(() => { if (recVoices.length && !recVoices.some((v) => v.id === recVoice)) setRecVoice(recVoices[0].id); }, [recVoices, recVoice]);
  const record = useCallback(async () => {
    if (!target) return;
    setBusy(true); setMsg("");
    try {
      const n = await createNarration({ target_type: target.type, target_id: target.id, voice: recVoice });
      setNarrations((cur) => cur.some((x) => x.id === n.id) ? cur : [...cur, n]);
      setPanel(false);
      setMsg(n.state === "done" ? "" : "Narrating in the background — it appears under Recorded narrations when ready.");
      load();
    } catch (e) { setMsg(e instanceof ApiError ? e.message : "Could not start the narration"); }
    finally { setBusy(false); }
  }, [target, recVoice, load]);

  // ── voice/source picker options ──
  const voiceGroups = useMemo(() => VOICE_GROUPS.map((g) => ({ ...g, voices: NEURAL_VOICES.filter((v) => v.lang === g.lang) })).filter((g) => g.voices.length), []);
  const narrLabel = (n: Narration) => {
    const v = VOICES.find((x) => x.id === n.voice);
    return v ? `${v.name} · ${langName(v.lang)}` : n.voice;
  };
  const pickerValue = isTts ? (tts.voice ? `v:${ttsVoiceKey(tts.voice)}` : "") : source;

  const status = isTts ? tts.note : msg;
  const counter = isTts && ttsSents.length ? `${tts.idx + 1}/${ttsSents.length}` : "";

  return (
    <span className="aq-read-seg aq-listen" role="group" aria-label="Listen to this document" style={{ position: "relative" }}>
      <audio ref={audioRef} onTimeUpdate={onNarrTime} onEnded={() => { setNarrPlaying(false); narrClear(); }}
        onPause={() => setNarrPlaying(false)} onPlay={() => setNarrPlaying(true)} src={narr?.audio_url || undefined} preload="none" />
      <button type="button" onClick={toggle} className="aq-read-ctl" aria-pressed={playing}
        aria-label={playing ? "Pause listening" : "Listen to this document"} title={playing ? "Pause (L)" : "Listen — read aloud on this device (L)"}>
        {playing
          ? <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
          : <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.6 5.4a9 9 0 0 1 0 13.2" /></svg>}
        <span className="aq-read-label">{playing ? "Pause" : "Listen"}</span>
      </button>
      <span className="aq-listen-steps" role="group" aria-label="Skip paragraphs">
        <button type="button" onClick={() => step(-1)} className="aq-read-ctl" aria-label="Previous paragraph" title="Previous paragraph">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden><path d="M6 6h2v12H6zM20 6v12l-10-6z" /></svg>
        </button>
        <button type="button" onClick={() => step(1)} className="aq-read-ctl" aria-label="Next paragraph" title="Next paragraph">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden><path d="M16 6h2v12h-2zM4 6v12l10-6z" /></svg>
        </button>
      </span>
      <select value={pickerValue} onChange={(e) => changeSource(e.target.value)} aria-label="Voice" title="Voice — on-device AI, or a recorded narration">
        {done.length > 0 && (
          <optgroup label="Recorded narrations">
            {done.map((n) => <option key={n.id} value={`narr:${n.id}`}>{narrLabel(n)}</option>)}
          </optgroup>
        )}
        {voiceGroups.map((g) => (
          <optgroup key={g.lang} label={`${g.label} — on-device AI, free (~${voiceDownloadMB(g.voices[0], tts.profile)} MB once)`}>
            {g.voices.map((v) => <option key={ttsVoiceKey(v)} value={`v:${ttsVoiceKey(v)}`}>{v.name} ({v.gender})</option>)}
          </optgroup>
        ))}
      </select>
      <select value={String(rate)} onChange={(e) => changeRate(Number(e.target.value))} aria-label="Listening speed" title="Speed">
        {SPEEDS.map((sp) => (
          <option key={sp} value={String(sp)} disabled={isTts && !tts.speeds.includes(sp)}>
            {sp}×{isTts && !tts.speeds.includes(sp) ? " — too fast here" : ""}
          </option>
        ))}
      </select>
      {target && (
        <button type="button" onClick={() => setPanel((v) => !v)} className="aq-read-ctl" aria-expanded={panel}
          aria-label="Record a narration" title="Record a narration (any language)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
        </button>
      )}
      {(status || counter || pct(tts.pct)) && (
        <span className="aq-listen-status" aria-live="polite">
          {counter && <span className="tabular-nums" aria-hidden>{counter}</span>}
          {status && <span>{status}</span>}
          {tts.pct !== null && (
            <>
              <span className="aq-listen-pct" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={tts.pct} aria-label="Voice model download"><span style={{ width: `${tts.pct}%` }} /></span>
              <span className="tabular-nums" aria-hidden>{tts.pct}%</span>
            </>
          )}
        </span>
      )}
      {isTts && tts.translation && (
        <div className="aq-tr-panel" dir="auto" aria-live="polite" aria-label="Translation being read">{tts.translation}</div>
      )}
      {panel && (
        <div className="aq-narr-panel" role="dialog" aria-label="Record a narration">
          <p className="aq-narr-panel-title">Record a narration — any language</p>
          <label className="aq-narr-panel-label">Language</label>
          <select value={recLang} onChange={(e) => setRecLang(e.target.value)} aria-label="Language">
            {recLangs.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
          <label className="aq-narr-panel-label">Voice</label>
          <select value={recVoice} onChange={(e) => setRecVoice(e.target.value)} aria-label="Voice">
            {recVoices.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.gender})</option>)}
          </select>
          {!isLoggedIn() ? (
            <p className="aq-narr-panel-note">Sign in to record a narration.</p>
          ) : (
            <button type="button" onClick={record} disabled={busy} className="aq-read-ctl" style={{ justifyContent: "center", fontWeight: 700 }}>
              {busy ? "Starting…" : `Record · ₳${estCost}`}
            </button>
          )}
          {msg && <p className="aq-narr-panel-note">{msg}</p>}
          {pending.length > 0 && <p className="aq-narr-panel-note">Narrating… a new narration appears here when ready.</p>}
        </div>
      )}
    </span>
  );
});

// tiny helper so the status row renders when only the download bar is active
function pct(p: number | null): boolean { return p !== null; }
