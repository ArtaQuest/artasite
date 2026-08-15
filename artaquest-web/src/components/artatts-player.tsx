// ArtaTTS player — the floating reader bar for a captured selection. Speaks it PARAGRAPH BY PARAGRAPH
// while a soft gold gradient band glides from one block to the next and the page scrolls smoothly to
// keep it in view. Lazy-loaded by ArtaTTS.tsx (nothing heavy in the main bundle); the speech loop lives
// in use-artatts.ts. ONE voice source (operator, 2026-07-21: state-of-the-art on-device only): the
// Kokoro-82M neural voices, precision-tiered per device — no OS voices, no tiny fallback, no cloud.
import { useEffect, useMemo, useRef } from "react";
import { SPEEDS, NEURAL_VOICES, VOICE_GROUPS, sentencesFromRange, neuralSpeeds, voiceDownloadMB } from "../lib/tts";
import { useArtaTts, ttsVoiceKey } from "./use-artatts";

export default function ArtaTTSPlayer({ range, onClose }: { range: Range; onClose: () => void }) {
  const sentences = useMemo(() => sentencesFromRange(range), [range]);

  const s = useArtaTts({ sentences, autoStart: true, onDead: onClose });
  const { idx, playing, note, pct, bench, profile, voice, speeds, rate } = s;

  const playRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { playRef.current?.focus(); }, []); // move focus into the newly-opened reader
  // Clear the member's original selection once the reader takes over: the paragraph ranges are already
  // cloned from it, and the site's gold ::selection would otherwise wash the whole passage and compete
  // with the clean paragraph band.
  useEffect(() => { try { window.getSelection()?.removeAllRanges(); } catch { /* */ } }, []);

  // Latest-value refs for the keyboard handler (stable listener, fresh state).
  const sRef = useRef(s); sRef.current = s;
  const idxRef = useRef(idx); idxRef.current = idx;
  const playingRef = useRef(playing); playingRef.current = playing;

  // Keyboard: Space = play/pause, ←/→ = previous/next paragraph (never while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element | null)?.closest?.("input,select,textarea,[contenteditable]")) return;
      if (e.key === " ") { e.preventDefault(); if (playingRef.current) sRef.current.pause(); else sRef.current.resume(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); sRef.current.playAt(Math.min(sentences.length - 1, idxRef.current + 1)); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); sRef.current.playAt(Math.max(0, idxRef.current - 1)); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sentences.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groups = useMemo(() => VOICE_GROUPS.map((g) => ({ ...g, voices: NEURAL_VOICES.filter((v) => v.lang === g.lang) })).filter((g) => g.voices.length), []);
  const downloadMB = voiceDownloadMB(NEURAL_VOICES[0], profile);

  if (!sentences.length) return null;

  const maxSpeed = speeds[speeds.length - 1];
  // Voice provenance — a member always knows WHAT is speaking and WHERE it runs (transparency).
  const provenance = voice ? `On-device AI · ${voice.name}` : "";
  const benchChip = bench
    ? (neuralSpeeds(bench.rtf).length > 1 ? ` · up to ${maxSpeed}×` : " · slower than real time here")
    : "";

  return (
    <div className="aq-tts-ui fixed inset-x-2 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-50 select-none [touch-action:manipulation] md:bottom-4" role="region" aria-label="ArtaTTS reader">
      <div className="mx-auto flex max-w-2xl flex-col gap-1.5 rounded-2xl border border-line bg-space-1/95 p-2.5 text-ink shadow-[0_12px_32px_rgba(0,0,0,.45)] backdrop-blur">
        {/* On-device translation of the paragraph being spoken (reading in another language). */}
        {s.translation && <p className="aq-tr-text" dir="auto" aria-live="polite">{s.translation}</p>}
        {/* Progress spine — where the reading sits within the passage (one gentle width change per paragraph). */}
        <div className="h-0.5 overflow-hidden rounded-full bg-space-2" aria-hidden>
          <div className="h-full rounded-full bg-yang transition-[width] duration-300" style={{ width: `${Math.round(((idx + 1) / sentences.length) * 100)}%` }} />
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => s.playAt(Math.max(0, idx - 1))} aria-label="Previous paragraph" title="Previous paragraph" aria-keyshortcuts="ArrowLeft"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-line hover:border-yin md:h-8 md:w-8">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M6 6h2v12H6zM20 6v12l-10-6z" /></svg>
          </button>
          <button ref={playRef} type="button" onClick={playing ? s.pause : s.resume} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"} aria-keyshortcuts="Space"
            className="flex h-12 w-12 items-center justify-center rounded-full border border-line hover:border-yin md:h-9 md:w-9">
            {playing
              ? <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
              : <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>}
          </button>
          <button type="button" onClick={() => s.playAt(Math.min(sentences.length - 1, idx + 1))} aria-label="Next paragraph" title="Next paragraph" aria-keyshortcuts="ArrowRight"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-line hover:border-yin md:h-8 md:w-8">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M16 6h2v12h-2zM4 6v12l10-6z" /></svg>
          </button>
          <span className="text-[12px] tabular-nums text-ink-3" aria-hidden>{idx + 1}/{sentences.length}</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3" aria-live="polite">
            {note || (provenance && `${provenance}${benchChip}`)}
          </span>
          <button type="button" onClick={onClose} aria-label="Close reader" title="Close (Esc)"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-line hover:border-yin md:h-8 md:w-8">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        {/* Model downloader — a real bar while the one-time voice-model download runs (the note above
            carries the words; this carries the number). */}
        {pct !== null && (
          <div className="flex items-center gap-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Voice model download">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-space-2">
              <div className="h-full rounded-full bg-yang transition-[width] duration-300" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-9 text-end text-[11px] tabular-nums text-ink-3" aria-hidden>{pct}%</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <select value={voice ? ttsVoiceKey(voice) : ""} onChange={(e) => s.changeVoice(e.target.value)} aria-label="Voice and accent" title="Voice and accent"
            className="min-w-0 flex-1 rounded-lg border border-line bg-space-2 px-2 py-1 text-[12.5px] text-ink">
            {groups.map((g) => (
              <optgroup key={g.lang} label={`${g.label} — on-device AI, free (~${downloadMB} MB once)`}>
                {g.voices.map((v) => <option key={ttsVoiceKey(v)} value={ttsVoiceKey(v)}>{v.name} ({v.gender})</option>)}
              </optgroup>
            ))}
          </select>
          <select value={String(rate)} onChange={(e) => s.changeRate(Number(e.target.value))} aria-label="Speed" title="Speed (tested against this device)"
            className="rounded-lg border border-line bg-space-2 px-2 py-1 text-[12.5px] text-ink">
            {SPEEDS.map((sp) => <option key={sp} value={String(sp)} disabled={!speeds.includes(sp)}>{sp}×{speeds.includes(sp) ? "" : " — too fast here"}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}
