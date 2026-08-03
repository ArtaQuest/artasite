// My Library player — YouTube-Music-style consumption for the member's OWN files (operator,
// 2026-07-25): a persistent mini-player + full "Now playing" sheet, queue with shuffle/repeat,
// and the Media Session API so the lock screen / headphone buttons / car controls all work — put
// the phone in a pocket and the music keeps going. Videos play in a lightbox with PiP. All bytes
// come from the on-device library (IndexedDB); nothing streams from a server, so it works offline.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { type MediaItem, fileUrl, coverUrl, notePlayed, getProgress, setProgress, pinMedia } from "../lib/media-store";

export type Repeat = "off" | "all" | "one";

export type PlayerState = {
  queue: MediaItem[];
  index: number;
  playing: boolean;
  shuffle: boolean;
  repeat: Repeat;
  current: MediaItem | null;
  time: number;
  duration: number;
};

const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

export function usePlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<MediaItem[]>([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<Repeat>("off");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const orderRef = useRef<number[]>([]); // play order over queue indices (shuffled or linear)
  const posRef = useRef(0);              // position within orderRef
  const current = index >= 0 ? queue[index] ?? null : null;
  const curRef = useRef<MediaItem | null>(null);
  curRef.current = current;

  const audio = (): HTMLAudioElement => {
    if (!audioRef.current) {
      // A REAL element in the DOM: detached Audio() objects are treated inconsistently by iOS
      // (and are invisible to tooling). One element for the whole session — never per track.
      const a = document.createElement("audio");
      a.preload = "metadata";
      a.setAttribute("playsinline", "");
      a.className = "aq-pl-audio";
      a.hidden = true;
      document.body.appendChild(a);
      audioRef.current = a;
    }
    return audioRef.current;
  };

  // Media Session: lock-screen + headphone + car controls.
  const wireSession = useCallback(async (item: MediaItem) => {
    if (!("mediaSession" in navigator)) return;
    const art = await coverUrl(item.id, item.hasCover);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title,
      artist: item.artist || "My Library",
      album: item.album || "ArtaQuest",
      artwork: art ? [{ src: art, sizes: "512x512", type: "image/jpeg" }] : [],
    });
  }, []);

  const playAt = useCallback(async (q: MediaItem[], i: number, keepOrder = false) => {
    if (!q.length || i < 0 || i >= q.length) return;
    setQueue(q);
    setIndex(i);
    if (!keepOrder) {
      orderRef.current = q.map((_, k) => k);
      if (shuffle) {
        const rest = orderRef.current.filter((k) => k !== i);
        for (let j = rest.length - 1; j > 0; j--) { const r = Math.floor(Math.random() * (j + 1)); [rest[j], rest[r]] = [rest[r], rest[j]]; }
        orderRef.current = [i, ...rest];
        posRef.current = 0;
      } else {
        posRef.current = i;
      }
    }
    const a = audio();
    // Protect THIS track's blob URL (and the one queued after it) from the object-URL LRU before
    // asking for it. The LRU holds six; a member who opens six other items while a track plays in
    // the background would otherwise revoke the URL the audio element is still reading from. Safari
    // streams a blob lazily rather than snapshotting it, so a revoke mid-track ends playback there —
    // precisely the case this whole feature exists for (phone locked, music playing).
    pinMedia([q[i].id, q[(i + 1) % q.length]?.id].filter(Boolean) as string[]);
    a.src = await fileUrl(q[i].id);
    // Pick up where the member left off. Only mid-item positions count: at the very start there is
    // nothing to resume, and near the end the item is effectively finished. Both margins are
    // PROPORTIONAL — a flat 5 s tail margin meant anything shorter than 5 s could never resume at all
    // (a 3 s clip needed pos < -2), which is the sort of thing only a short file ever reveals.
    const prev = await getProgress(q[i].id).catch(() => undefined);
    const head = prev ? Math.min(2, prev.dur * 0.02) : 2;
    const tail = prev ? Math.min(5, prev.dur * 0.05) : 5;
    if (prev && !prev.done && prev.dur > 0 && prev.pos > head && prev.pos < prev.dur - tail) {
      const seekOnce = () => { try { a.currentTime = prev.pos; } catch { /* not seekable yet */ } a.removeEventListener("loadedmetadata", seekOnce); };
      if (a.readyState >= 1) seekOnce(); else a.addEventListener("loadedmetadata", seekOnce);
    }
    try { await a.play(); setPlaying(true); void notePlayed(q[i].id); } catch { setPlaying(false); }
    void wireSession(q[i]);
  }, [shuffle, wireSession]);

  const step = useCallback((dir: 1 | -1) => {
    if (!queue.length) return;
    const order = orderRef.current.length === queue.length ? orderRef.current : queue.map((_, k) => k);
    let p = order.indexOf(index);
    if (p < 0) p = posRef.current;
    let np = p + dir;
    if (np < 0) np = repeat === "all" ? order.length - 1 : 0;
    if (np >= order.length) {
      if (repeat !== "all") { setPlaying(false); audio().pause(); return; }
      np = 0;
    }
    posRef.current = np;
    void playAt(queue, order[np], true);
  }, [queue, index, repeat, playAt]);

  const toggle = useCallback(() => {
    const a = audio();
    if (a.paused) { void a.play().then(() => setPlaying(true)).catch(() => {}); }
    else { a.pause(); setPlaying(false); }
  }, []);
  const seek = useCallback((t: number) => { const a = audio(); a.currentTime = Math.max(0, Math.min(t, a.duration || t)); }, []);
  const stop = useCallback(() => { const a = audio(); a.pause(); a.removeAttribute("src"); a.load(); pinMedia([]); setPlaying(false); setIndex(-1); setQueue([]); setTime(0); setDuration(0); }, []);

  // Keep the LOCK SCREEN scrubber truthful. Throttled to ~1 Hz: setPositionState on every timeupdate
  // (~4/s) is wasted work on a phone in a pocket, and it throws if position ever exceeds duration
  // mid-seek, so it is guarded.
  const posAt = useRef(0);
  const saveAt = useRef(0);
  const pushPosition = useCallback((a: HTMLAudioElement) => {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    const now = Date.now();
    if (now - posAt.current < 900) return;
    posAt.current = now;
    const d = a.duration;
    if (!isFinite(d) || d <= 0) return;
    try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: a.playbackRate || 1, position: Math.min(a.currentTime, d) }); }
    catch { /* position raced past duration — the next tick fixes it */ }
  }, []);

  // element events + repeat-one + auto-advance
  useEffect(() => {
    const a = audio();
    const onTime = () => {
      setTime(a.currentTime);
      pushPosition(a);
      // Persist roughly every 5 s (not per timeupdate, ~4/s — that would hammer IDB and the battery).
      const now = Date.now();
      const cur = curRef.current;
      if (cur && now - saveAt.current > 5000 && a.currentTime > 0) { saveAt.current = now; void setProgress(cur.id, a.currentTime, a.duration); }
    };
    const onDur = () => { setDuration(a.duration || 0); pushPosition(a); };
    const onEnd = () => {
      const cur = curRef.current;
      if (cur) void setProgress(cur.id, a.duration || 0, a.duration || 0);   // mark finished
      if (repeat === "one") { a.currentTime = 0; void a.play(); } else step(1);
    };
    const onPlay = () => { setPlaying(true); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; };
    const onPause = () => {
      setPlaying(false);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
      const cur = curRef.current;                       // flush the exact spot on pause
      if (cur && a.currentTime > 0) void setProgress(cur.id, a.currentTime, a.duration);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("durationchange", onDur);
    a.addEventListener("ended", onEnd);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("durationchange", onDur);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, [repeat, step, pushPosition]);

  // Media Session handlers (headphone buttons / lock screen)
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => toggle());
    ms.setActionHandler("pause", () => toggle());
    ms.setActionHandler("previoustrack", () => step(-1));
    ms.setActionHandler("nexttrack", () => step(1));
    try { ms.setActionHandler("seekto", (d) => { if (d.seekTime != null) seek(d.seekTime); }); } catch { /* older engines */ }
    try {
      ms.setActionHandler("seekbackward", (d) => seek(audio().currentTime - (d.seekOffset || 10)));
      ms.setActionHandler("seekforward", (d) => seek(audio().currentTime + (d.seekOffset || 10)));
    } catch { /* optional */ }
    return () => {
      for (const k of ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"] as MediaSessionAction[]) {
        try { ms.setActionHandler(k, null); } catch { /* ignore */ }
      }
    };
  }, [toggle, step, seek]);

  useEffect(() => () => { const a = audioRef.current; if (a) { a.pause(); a.remove(); audioRef.current = null; } }, []);

  return {
    state: { queue, index, playing, shuffle, repeat, current, time, duration } as PlayerState,
    playAt, toggle, step, seek, stop,
    setShuffle: (v: boolean) => setShuffle(v),
    cycleRepeat: () => setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off")),
  };
}

// ── UI pieces ────────────────────────────────────────────────────────────────────────────────────

function Cover({ item, size = 44 }: { item: MediaItem; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { let ok = true; void coverUrl(item.id, item.hasCover).then((u) => { if (ok) setUrl(u); }); return () => { ok = false; }; }, [item.id, item.hasCover]);
  return url
    ? <img src={url} alt="" width={size} height={size} className="aq-pl-cover" loading="lazy" />
    : <span className="aq-pl-cover aq-pl-cover-ph" style={{ width: size, height: size }} aria-hidden>
        {item.kind === "music"
          ? <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="currentColor" aria-hidden><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z" /></svg>
          : <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>}
      </span>;
}

/** The persistent bottom mini-player + expandable Now-playing sheet. */
export function PlayerBar({ p }: { p: ReturnType<typeof usePlayer> }) {
  const { state } = p;
  const [big, setBig] = useState(false);
  const item = state.current;
  // Mark the document while the bar is up so other fixed furniture (the ArtaBot launcher, which is
  // also bottom-right at z-60) lifts clear of it — verified by hit-testing: it was swallowing the
  // Next-track click outright.
  useEffect(() => {
    if (!item) return;
    document.documentElement.setAttribute("data-aq-player", "1");
    return () => document.documentElement.removeAttribute("data-aq-player");
  }, [item]);
  if (!item) return null;
  const pct = state.duration ? (state.time / state.duration) * 100 : 0;

  const controls = (compact: boolean) => (
    <span className={compact ? "aq-pl-ctls" : "aq-pl-ctls aq-pl-ctls-big"}>
      <button type="button" className="aq-pl-btn" onClick={() => p.step(-1)} aria-label="Previous track" title="Previous">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M6 5h2v14H6zM20 5v14l-10-7z" /></svg>
      </button>
      <button type="button" className="aq-pl-btn aq-pl-play" onClick={p.toggle} aria-label={state.playing ? "Pause" : "Play"} title={state.playing ? "Pause" : "Play"}>
        {state.playing
          ? <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
          : <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>}
      </button>
      <button type="button" className="aq-pl-btn" onClick={() => p.step(1)} aria-label="Next track" title="Next">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M16 5h2v14h-2zM4 5v14l10-7z" /></svg>
      </button>
    </span>
  );

  return (
    <>
      {big && (
        <div className="aq-pl-sheet" role="dialog" aria-label="Now playing" onClick={() => setBig(false)}>
          <div className="aq-pl-sheet-card" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="aq-pl-btn aq-pl-close" onClick={() => setBig(false)} aria-label="Close now playing">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <div className="aq-pl-hero"><Cover item={item} size={228} /></div>
            <p className="aq-pl-title" data-ay-skip="1">{item.title}</p>
            <p className="aq-pl-sub" data-ay-skip="1">{item.artist || "My Library"}{item.album ? ` · ${item.album}` : ""}</p>
            <div className="aq-pl-seek">
              <span className="aq-pl-t">{fmtTime(state.time)}</span>
              <input type="range" min={0} max={Math.max(1, state.duration)} step={0.5} value={state.time}
                onChange={(e) => p.seek(Number(e.target.value))} aria-label="Seek" />
              <span className="aq-pl-t">{fmtTime(state.duration)}</span>
            </div>
            {controls(false)}
            <span className="aq-pl-modes">
              <button type="button" className={`aq-pl-btn aq-pl-mini${state.shuffle ? " aq-pl-on" : ""}`} onClick={() => p.setShuffle(!state.shuffle)} aria-pressed={state.shuffle} aria-label="Shuffle" title="Shuffle">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
              </button>
              <button type="button" className={`aq-pl-btn aq-pl-mini${state.repeat !== "off" ? " aq-pl-on" : ""}`} onClick={p.cycleRepeat} aria-label={`Repeat: ${state.repeat}`} title={`Repeat: ${state.repeat}`}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3" /></svg>
                {state.repeat === "one" && <span className="aq-pl-one">1</span>}
              </button>
            </span>
            <p className="aq-pl-queue-note">{state.queue.length > 1 ? `${state.index + 1} of ${state.queue.length} in queue` : "Playing from your library"}</p>
          </div>
        </div>
      )}
      <div className="aq-pl-bar" role="region" aria-label="Player">
        <span className="aq-pl-prog" aria-hidden><span style={{ width: `${pct}%` }} /></span>
        <button type="button" className="aq-pl-meta" onClick={() => setBig(true)} aria-label="Open now playing">
          <Cover item={item} />
          <span className="aq-pl-meta-txt" data-ay-skip="1">
            <span className="aq-pl-meta-title">{item.title}</span>
            <span className="aq-pl-meta-sub">{item.artist || fmtTime(state.duration)}</span>
          </span>
        </button>
        {controls(true)}
        <button type="button" className="aq-pl-btn aq-pl-mini aq-pl-x" onClick={p.stop} aria-label="Close player" title="Close">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </>
  );
}

/** Video lightbox — plays a library video with native controls + Picture-in-Picture. */
export function VideoLightbox({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const vref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => { let ok = true; void fileUrl(item.id).then((u) => { if (ok) { setUrl(u); void notePlayed(item.id); } }); return () => { ok = false; }; }, [item.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="aq-vl" role="dialog" aria-label="Video player" onClick={onClose}>
      <div className="aq-vl-card" onClick={(e) => e.stopPropagation()}>
        <div className="aq-vl-head">
          <span className="aq-vl-title" data-ay-skip="1">{item.title}</span>
          <span className="aq-vl-tools">
            <button type="button" className="aq-pl-btn aq-pl-mini" aria-label="Picture in picture" title="Picture in picture"
              onClick={() => { const v = vref.current as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }; void v?.requestPictureInPicture?.().catch(() => {}); }}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden><rect x="2" y="4" width="20" height="14" rx="2" /><rect x="12" y="11" width="8" height="5" rx="1" fill="currentColor" /></svg>
            </button>
            <button type="button" className="aq-pl-btn aq-pl-mini" onClick={onClose} aria-label="Close video">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </span>
        </div>
        {url ? <video ref={vref} src={url} controls autoPlay playsInline className="aq-vl-video" /> : <div className="aq-vl-loading"><span className="aq-book-spinner" /></div>}
      </div>
    </div>
  );
}

// ── one player for the whole app ─────────────────────────────────────────────────────────────────
//
// The player used to live inside the My Library page, so ROUTE CHANGES UNMOUNTED IT and the music
// stopped — useless for the actual use case (put the phone in a pocket and go for a run). Mounted
// once in AppShell instead, it keeps playing across navigation, and the audio element (in the DOM,
// with Media Session wired) keeps going when the screen locks.

const PlayerCtx = createContext<ReturnType<typeof usePlayer> | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const p = usePlayer();
  return (
    <PlayerCtx.Provider value={p}>
      {children}
      <PlayerBar p={p} />
    </PlayerCtx.Provider>
  );
}

/** The shared player. Returns null outside the provider, so a page can degrade rather than crash. */
export function usePlayerCtx() { return useContext(PlayerCtx); }
