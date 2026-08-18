import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  localePath, getLesson, postWatchProgress,
  type LessonData, type CurriculumItem,
} from "../lib/wp";
import { SectionBoardView } from "../components/discussion/SectionBoardView";
import { Avatar, cx } from "../components/ui";
import { nameClass } from "../lib/fmt";
import { getMediaBlobURL, getCaptionVTT, getTranscript, dropMedia } from "../lib/offline/store";
import { currentLang } from "../lib/i18n";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The YT IFrame API REPLACES its mount node with an <iframe>. Wrapping the mount in a memo
// that never re-renders keeps React's reconciler from touching (and destroying) that iframe.
const YTHost = memo(function YTHost() {
  return <div id="aq-yt" className="h-full w-full" />;
}, () => true);

const ytCompact = (n: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const relTime = (ts: number) => {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  const units: [string, number][] = [["y", 31536000], ["mo", 2592000], ["w", 604800], ["d", 86400], ["h", 3600], ["m", 60]];
  for (const [u, s] of units) { const v = Math.floor(secs / s); if (v >= 1) return `${v}${u} ago`; }
  return "just now";
};

/** YouTube-style video metadata below the player: upload date, and the channel. (View counts were
 *  retired with the YouTube monitor — a course now trends by the discussion it sparks, not views.) */
function VideoMeta({ d }: { d: LessonData }) {
  const { video, channel } = d;
  if (!channel && !video.upload_ts) return null;
  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
      {video.upload_ts ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]">
          <span className="text-ink-3">{relTime(video.upload_ts)}</span>
        </p>
      ) : null}
      {channel && (
        <div className="flex items-center gap-3">
          {/* Avatar (not a bare <img>): the cached channel meta can lack an avatar URL, and a bare
              <img src=""> renders a broken/blank square — fall back to the channel-initial disc. */}
          <Avatar src={channel.avatar} name={channel.name} className="h-10 w-10 text-[15px] ring-1 ring-line" />
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span className={cx("min-w-0 font-semibold text-ink", nameClass(channel.name, 15))}>{channel.name}</span>
              {channel.verified && (
                <svg viewBox="0 0 24 24" width="15" height="15" className="shrink-0 text-ink-3" aria-label="Verified">
                  <title>Verified</title>
                  <circle cx="12" cy="12" r="10" fill="currentColor" />
                  <path d="M8.5 12.3l2.3 2.3 4.7-4.9" fill="none" stroke="#0d0d0f" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
            <span className="text-[13px] text-ink-3">{ytCompact(channel.subs)} subscribers</span>
          </div>
          <a href={channel.url} target="_blank" rel="noopener noreferrer"
            className="ml-auto shrink-0 text-[13px] font-semibold text-ink-3 underline-offset-2 hover:text-yang hover:underline">on YouTube ↗</a>
        </div>
      )}
    </div>
  );
}

// Captions follow the site language so a learner reads the video in the language they read the site in.
function siteLang(): string {
  const w = window as unknown as { AQ_I18N?: { current?: string } };
  return (w.AQ_I18N?.current || document.documentElement.lang || "en").toLowerCase().split("-")[0];
}
const YT_CC_LANG: Record<string, string> = { zh: "zh-Hans" };
function captionLang(): string { const l = siteLang(); return YT_CC_LANG[l] || l; }

function pickCaptionTrack(player: any, target: string): boolean {
  let list: any[];
  try { list = player.getOption?.("captions", "tracklist") || []; } catch { list = []; }
  if (!list.length) return false;
  const base = (c: string) => (c || "").toLowerCase().split("-")[0];
  const native = list.find((t) => base(t.languageCode) === base(target));
  if (native) { try { player.setOption?.("captions", "track", { languageCode: native.languageCode }); } catch { /* noop */ } return true; }
  const source = list.find((t) => t.is_translateable && base(t.languageCode) === "en") || list.find((t) => t.is_translateable) || list[0];
  if (!source) return false;
  const track = base(source.languageCode) === base(target)
    ? { languageCode: source.languageCode }
    : { languageCode: source.languageCode, translationLanguage: { languageCode: target } };
  try { player.setOption?.("captions", "track", track); } catch { /* noop */ }
  return true;
}
function applyCaptions(player: any, on: boolean, stillOn: () => boolean = () => on): void {
  if (!player) return;
  try {
    if (!on) { player.setOption?.("captions", "track", {}); player.unloadModule?.("captions"); return; }
    player.loadModule?.("captions");
    const target = captionLang();
    let tries = 0;
    const tick = () => { if (!stillOn()) return; if (pickCaptionTrack(player, target)) return; if (tries++ < 25) window.setTimeout(tick, 250); };
    tick();
  } catch { /* captions module unavailable */ }
}
const RATES = [0.75, 1, 1.25, 1.5] as const;
function readPref(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function writePref(key: string, val: string): void { try { localStorage.setItem(key, val); } catch { /* blocked */ } }

let ytReady: Promise<void> | null = null;
function loadYT(): Promise<void> {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    const w = window as any;
    if (w.YT && w.YT.Player) return resolve();
    w.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return ytReady;
}

const Check = ({ cls = "" }: { cls?: string }) => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" className={cls} aria-hidden><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>;

// ── Curriculum sidebar (every video freely playable, any order) ─────────────
function SectionIcon({ l }: { l: CurriculumItem }) {
  // Complete = watched + commented + upvoted (gold check). Watched-only = ring. Else number.
  if (l.complete) return <span className="text-yang"><Check /></span>;
  if (l.done) return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" className="text-yin-light" role="img" aria-label="Watched — join the discussion"><circle cx="12" cy="12" r="8" /></svg>;
  return <span className="text-[13px] text-ink-3">{l.n}</span>;
}

function Curriculum({ items, courseUrl }: { items: CurriculumItem[]; courseUrl: string }) {
  return (
    <aside className="min-w-0" aria-label="Course videos">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Videos</h2>
        <a href={localePath(courseUrl + "?tab=rankings")} className="text-[12px] font-semibold text-yang hover:underline">Rankings <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a>
      </div>
      <ol className="mt-2 max-h-[72vh] list-none overflow-y-auto pe-1">
        {items.map((l) => {
          const inner = (
            <span className="flex min-w-0 items-center gap-2">
              <span className="grid h-5 w-5 shrink-0 place-items-center">{<SectionIcon l={l} />}</span>
              <span className="truncate">{l.title}</span>
            </span>
          );
          return (
            <li key={l.id}>
              <a href={localePath(l.url)} aria-current={l.current ? "true" : undefined} className={`flex items-center gap-2 rounded-card px-3 py-2 text-[14px] ${l.current ? "bg-yin/15 font-semibold text-yang" : "text-ink-2 hover:bg-veil/5"}`}>{inner}</a>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

// ── Engagement steps for this section: watch · reply · upvote ─────────────
function StepChips({ watched, commented, upvoted }: { watched: boolean; commented: boolean; upvoted: boolean }) {
  const steps = [
    { on: watched, label: "Watch" },
    { on: commented, label: "Reply" },
    { on: upvoted, label: "Upvote a peer" },
  ];
  const doneCount = steps.filter((s) => s.on).length;
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label={`Section progress: ${doneCount} of 3 steps done`}>
      {steps.map((s, i) => (
        <li key={s.label} className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[12px] font-semibold ${s.on ? "border-yang/50 bg-yang/15 text-yang" : "border-line text-ink-3"}`}>
          <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full ${s.on ? "bg-yang text-on-accent" : "bg-veil/10 text-ink-3"}`} aria-hidden>
            {s.on ? <Check /> : i + 1}
          </span>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

// ── Offline player ───────────────────────────────────────────────────────────
// A downloaded section plays from a local blob with a native <video> (so it works with no network),
// with its downloaded caption track and seeking to the segment start. Replaces the YouTube focus-mode
// player only when a media blob has been saved for this lesson (otherwise the YT path is used).
type OfflineMedia = { url: string; mime: string; vtt?: string; vttLang: string };
function OfflineVideo({ media, start, onDead }: { media: OfflineMedia; start: number; onDead: () => void }) {
  const vidRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = vidRef.current;
    if (!v || !start) return;
    const seek = () => { try { if (v.currentTime < start) v.currentTime = start; } catch { /* noop */ } };
    v.addEventListener("loadedmetadata", seek, { once: true });
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [start]);
  // Self-heal: a stored copy can be unreadable even though its row exists (Safari can silently lose
  // an IDB Blob's bytes across sessions) — without this the player sits at 0:00 forever. Detect a
  // decode/source error OR metadata never arriving (a local blob loads in well under 10s) and hand
  // back to the parent, which drops the dead copy and falls back to streaming.
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return;
    let settled = false;
    const dead = () => { if (!settled) { settled = true; onDead(); } };
    const fine = () => { settled = true; };
    const src = v.querySelector("source");
    v.addEventListener("error", dead);
    src?.addEventListener("error", dead);
    v.addEventListener("loadedmetadata", fine, { once: true });
    const timer = window.setTimeout(() => { if (v.readyState === 0) dead(); }, 10000);
    return () => { clearTimeout(timer); v.removeEventListener("error", dead); src?.removeEventListener("error", dead); v.removeEventListener("loadedmetadata", fine); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.url]);
  return (
    <video ref={vidRef} controls playsInline className="h-full w-full bg-black" preload="metadata">
      <source src={media.url} type={media.mime} />
      {media.vtt && <track default kind="subtitles" srcLang={media.vttLang} label={media.vttLang.toUpperCase()} src={media.vtt} />}
    </video>
  );
}

export default function Lesson({ id }: { id: number | string }) {
  const [d, setD] = useState<LessonData | null>(null);
  const [tried, setTried] = useState(false);
  const [ytFailed, setYtFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [cc, setCc] = useState<boolean>(() => readPref("aq_cc") !== "0");
  const [rate, setRate] = useState<number>(() => { const n = Number(readPref("aq_rate")); return (RATES as readonly number[]).includes(n) ? n : 1; });

  // Section completion steps. The board (replies/votes) lives in <SectionBoardView>; the lesson only
  // tracks the three steps for StepChips + the curriculum tick. `watched` is Lesson-owned; `commented`
  // / `upvoted` are seeded from the lesson payload, then kept live by the board via onEngagementChange.
  const [watched, setWatched] = useState(false);
  const [commented, setCommented] = useState(false);
  const [upvoted, setUpvoted] = useState(false);
  const [curriculum, setCurriculum] = useState<CurriculumItem[]>([]);
  // Offline: a saved video blob (+ caption + transcript) for this section, if it was downloaded.
  const [offlineMedia, setOfflineMedia] = useState<OfflineMedia | null>(null);
  // The saved copy turned out to be unreadable and was dropped (self-heal) — the lesson streams
  // instead, and a small note tells the member to re-download it for offline use.
  const [deadCopy, setDeadCopy] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const offlineRef = useRef(false);

  const playerRef = useRef<any>(null);
  const dRef = useRef<LessonData | null>(null);
  const endedRef = useRef(false);
  const lastPingRef = useRef(0);
  const ccRef = useRef(cc);
  const rateRef = useRef(rate);

  // Load the section; seed the watch/comment/upvote steps. The board fetches its own replies.
  useEffect(() => {
    if (!id) return;
    setTried(false); setReady(false); setWatched(false); setCommented(false); setUpvoted(false);
    setOfflineMedia(null); setDeadCopy(false); setTranscript(""); offlineRef.current = false;
    const lid = Number(id);
    // Prefer a downloaded copy so the section plays + reads with no network (and instantly online).
    if (lid) {
      getMediaBlobURL(lid).then(async (m) => {
        if (!m) return;
        const lang = currentLang().split("-")[0];
        const vtt = (await getCaptionVTT(lid, lang)) || (lang !== "en" ? await getCaptionVTT(lid, "en") : undefined);
        offlineRef.current = true;
        setOfflineMedia({ url: m.url, mime: m.mime, vtt: vtt ? URL.createObjectURL(new Blob([vtt], { type: "text/vtt" })) : undefined, vttLang: lang });
      }).catch(() => { /* no offline copy */ });
      getTranscript(lid).then((t) => { if (t) setTranscript(t); }).catch(() => { /* none */ });
    }
    getLesson(id).then((r) => {
      setD(r); dRef.current = r; setTried(true);
      if (r) { setWatched(!!r.watched); setCommented(!!r.commented); setUpvoted(!!r.upvoted); setCurriculum(r.curriculum); }
    }).catch(() => setTried(true));
  }, [id]);
  // Free the offline blob object URLs (the saved video + its caption track) when the section changes
  // or the player unmounts. Without this, every navigation to a downloaded section leaks its object
  // URLs, and the browser keeps the underlying (often hundreds-of-MB) video Blob alive — on a phone
  // that walks through several saved videos this exhausts memory and the OS kills the tab (ticket #4:
  // mobile offline). Keyed on offlineMedia so each cleanup revokes exactly the URLs it captured.
  useEffect(() => {
    if (!offlineMedia) return;
    const { url, vtt } = offlineMedia;
    return () => { URL.revokeObjectURL(url); if (vtt) URL.revokeObjectURL(vtt); };
  }, [offlineMedia]);
  useEffect(() => { if (d?.title) document.title = `${d.title} – ArtaQuest`; }, [d?.title]);

  // Boot the YouTube player once per section (keyed on lesson id so re-renders never rebuild it).
  useEffect(() => {
    const data = dRef.current;
    if (!data || !data.video.id) return;
    if (offlineMedia) return; // a downloaded copy plays via <OfflineVideo>; skip the YouTube player
    let interval = 0; let cancelled = false;
    setYtFailed(false); endedRef.current = false;
    loadYT().then(() => {
      if (cancelled) return;
      const w = window as any;
      playerRef.current = new w.YT.Player("aq-yt", {
        videoId: data.video.id,
        playerVars: { start: data.video.start, rel: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1, fs: 1, controls: 1, disablekb: 0, cc_load_policy: ccRef.current ? 1 : 0, cc_lang_pref: captionLang(), hl: siteLang() },
        events: {
          onReady: () => {
            setReady(true);
            const p = playerRef.current;
            applyCaptions(p, ccRef.current, () => ccRef.current);
            try { p?.setPlaybackRate?.(rateRef.current); } catch { /* noop */ }
            interval = window.setInterval(() => {
              const dd = dRef.current;
              if (!p || !dd || !p.getCurrentTime) return;
              if (endedRef.current) return;
              const t = p.getCurrentTime();
              // Mirror the live playback position for the discussion composer — a reply posted
              // mid-watch carries the moment it talks about (timestamp-anchored replies).
              (window as unknown as { AQ_PLAYER_AT?: number }).AQ_PLAYER_AT = Math.max(0, Math.floor(t));
              const atEnd = !!dd.seg_end && t >= dd.seg_end;
              // This lesson is a slice (seg_start..seg_end) of a longer video — pause at the segment end
              // so it lands on the discussion board instead of bleeding into the next segment.
              if (atEnd) { try { p.pauseVideo(); } catch { /* noop */ } }
              // Heartbeat our real playback position every ~5s (incl. while parked at the segment end,
              // nudging until the server has credited enough). The server credits watched-time no faster
              // than real elapsed time, so it — not us — decides when the section is done.
              if (Date.now() - lastPingRef.current > 5000) { watchPing(t, atEnd); }
            }, 700);
          },
          onStateChange: (e: any) => {
            if (e.data === 0 && !endedRef.current) { // 0 = ended → final heartbeat
              const p2 = playerRef.current; const dd = dRef.current;
              watchPing(dd?.seg_end || (p2?.getCurrentTime?.() ?? 0), true);
            }
          },
        },
      });
    }).catch(() => { if (!cancelled) setYtFailed(true); });
    return () => { cancelled = true; if (interval) clearInterval(interval); try { playerRef.current?.destroy?.(); } catch { /* noop */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.id, d?.video.id, offlineMedia]);

  // Heartbeat the real playback position; the server credits watched-time (capped to wall-clock) and
  // tells us when the section is genuinely watched. Only then do we flip the UI to ✓ + unlock the next.
  function watchPing(absTime: number, atEnd: boolean) {
    const dd = dRef.current; if (!dd || endedRef.current) return;
    // eslint-disable-next-line react-hooks/purity -- only called from the boot effect (interval/onStateChange), never during render
    lastPingRef.current = Date.now();
    const at = Math.max(0, Math.floor(absTime - (dd.seg_start || 0)));
    postWatchProgress(Number(dd.id), at).then((r) => {
      if (r.done && !endedRef.current) { endedRef.current = true; markWatched(); }
    }).catch(() => { /* noop */ });
    void atEnd;
  }

  // UI-only: the server has already confirmed the section is watched (done). Flip its ✓.
  function markWatched() {
    const lid = dRef.current?.id; if (!lid) return;
    setWatched(true);
    setCurriculum((cur) => {
      const i = cur.findIndex((l) => l.id === lid);
      if (i < 0) return cur;
      const next = cur.map((l) => ({ ...l }));
      next[i].done = true;
      return next;
    });
  }


  function toggleCaptions() { const n = !ccRef.current; ccRef.current = n; setCc(n); writePref("aq_cc", n ? "1" : "0"); applyCaptions(playerRef.current, n, () => ccRef.current); }
  function changeRate(r: number) { rateRef.current = r; setRate(r); writePref("aq_rate", String(r)); try { playerRef.current?.setPlaybackRate?.(r); } catch { /* noop */ } }

  // Flip the curriculum tick when the server says this section is fully engaged.
  function markComplete(lid: number) {
    setCurriculum((cur) => cur.map((l) => (l.id === lid ? { ...l, complete: true } : l)));
  }

  // The board reports engagement (commented / upvoted / engaged) as the learner posts + upvotes; we
  // mirror it into StepChips and, once engaged, tick the section in the curriculum. Stable identity
  // ([] deps, reads dRef) so it never re-triggers the board's own load effect.
  const onEngagement = useCallback((e: { commented: boolean; upvoted: boolean; engaged: boolean }) => {
    setCommented(e.commented);
    setUpvoted(e.upvoted);
    const lid = dRef.current?.id;
    if (e.engaged && lid) markComplete(Number(lid));
  }, []);

  if (!id) return (
    <div className="py-16 text-center">
      <p className="text-[15px] text-ink-2">No video selected.</p>
      <a href={localePath("/courses/")} className="mt-3 inline-block text-[14px] font-semibold text-yang hover:underline">Browse courses <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a>
    </div>
  );
  if (!d) return <p className="py-16 text-center text-ink-3">{tried ? <>Video not found. <a href={localePath("/courses/")} className="text-yang hover:underline">Browse courses <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a></> : "Loading…"}</p>;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        <a href={localePath(d.course.url)} className="text-[13px] font-semibold uppercase tracking-wide text-ink-3 hover:text-yang">← {d.course.title}</a>
        <h1 className="mt-2 text-[22px] font-bold tracking-tight">{d.title}</h1>

        {offlineMedia && (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-pill bg-yin/15 px-3 py-1 text-[12px] font-semibold text-yin-light">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3v12" strokeLinecap="round" /><path d="M7 11l5 4 5-4" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 21h14" strokeLinecap="round" /></svg>
            Playing your downloaded copy — works offline
          </p>
        )}
        {deadCopy && (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-pill bg-yang/15 px-3 py-1 text-[12px] font-semibold text-yang">
            Your saved copy of this video couldn't be read, so it was removed — {navigator.onLine !== false ? "streaming it instead. Re-download it on the " : "connect once and re-download it on the "}
            <a href={localePath("/offline/")} className="underline">Offline downloads</a> page.
          </p>
        )}
        <div className="relative mt-4 aspect-video overflow-hidden rounded-card bg-black [&:fullscreen]:rounded-none">
          {offlineMedia ? (
            <OfflineVideo media={offlineMedia} start={d.seg_start} onDead={() => {
              // Drop the dead copy and fall back to streaming (the YT boot effect re-runs when
              // offlineMedia clears). Offline, the note above explains what happened instead.
              setDeadCopy(true); setOfflineMedia(null); offlineRef.current = false;
              const lid = Number(id); if (lid) dropMedia(lid).catch(() => { /* best-effort */ });
            }} />
          ) : (
          <>
          <YTHost />
          {ytFailed && (
            <div role="alert" className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-space-1/95 px-6 text-center">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.7" className="text-ink-3" aria-hidden><rect x="2" y="5" width="20" height="14" rx="3" /><path d="m10 9 5 3-5 3z" strokeLinejoin="round" /><path d="m3 3 18 18" strokeLinecap="round" /></svg>
              <p className="text-[15px] font-semibold text-ink">The video player couldn't load</p>
              <p className="max-w-xs text-[13px] leading-relaxed text-ink-3">An ad-blocker or network filter may be blocking YouTube. Refresh to retry, or watch it on YouTube.</p>
              <div className="mt-1 flex flex-wrap items-center justify-center gap-2.5">
                <button type="button" onClick={() => window.location.reload()} className="inline-flex h-9 items-center rounded-pill bg-yang px-4 text-[14px] font-bold text-on-accent transition-colors hover:bg-yin hover:text-white">Refresh</button>
                <a href={`https://www.youtube.com/watch?v=${d.video.id}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center rounded-pill border border-line px-4 text-[14px] font-semibold text-ink-2 transition-colors hover:text-yang">Watch on YouTube ↗</a>
              </div>
            </div>
          )}
          </>
          )}
        </div>
        {d.video.id && ready && !offlineMedia && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={toggleCaptions} aria-pressed={cc}
              className={`inline-flex h-9 items-center gap-2 rounded-pill border px-3 text-[13px] font-semibold transition-colors ${cc ? "border-yang bg-yang/15 text-yang" : "border-line text-ink-2 hover:border-ink-3 hover:text-ink"}`}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M3 5h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm4.5 5.2c.6 0 1 .2 1.4.6l1-1A3 3 0 0 0 7.5 9 3 3 0 1 0 9.9 14l-1-1c-.4.4-.8.6-1.4.6a1.6 1.6 0 1 1 0-3.4zm7 0c.6 0 1 .2 1.4.6l1-1A3 3 0 0 0 14.5 9a3 3 0 1 0 2.4 5l-1-1c-.4.4-.8.6-1.4.6a1.6 1.6 0 1 1 0-3.4z" /></svg>
              <span>Captions</span>
              <span className="rounded bg-veil/10 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide">{siteLang()}</span>
            </button>
            <div role="group" aria-label="Playback speed" className="inline-flex h-9 items-center gap-1 rounded-pill border border-line ps-1 pe-1">
              <span className="px-2 text-[12px] font-semibold text-ink-3" aria-hidden>Speed</span>
              {RATES.map((r) => (
                <button key={r} type="button" aria-pressed={rate === r} aria-label={`${r} times speed`} onClick={() => changeRate(r)}
                  className={`h-7 rounded-pill px-2.5 text-[12.5px] font-semibold transition-colors ${rate === r ? "bg-yang text-on-accent" : "text-ink-2 hover:bg-veil/5 hover:text-ink"}`}>{r}×</button>
              ))}
            </div>
          </div>
        )}
        <VideoMeta d={d} />
        {transcript && (
          <details className="mt-4 rounded-card border border-line bg-space-2/50">
            <summary className="cursor-pointer px-4 py-3 text-[14px] font-semibold text-ink-2">Transcript</summary>
            <div className="max-h-[420px] overflow-y-auto whitespace-pre-wrap px-4 pb-4 text-[14px] leading-relaxed text-ink-2">{transcript}</div>
          </details>
        )}

        {/* ── Section discussion board — the SAME <SectionBoardView> the global board mounts ── */}
        <section aria-labelledby="aq-disc-h" className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="aq-disc-h" className="text-[17px] font-bold tracking-tight">Video discussion</h2>
            <StepChips watched={watched} commented={commented} upvoted={upvoted} />
          </div>
          {watched && commented && upvoted ? (
            <p role="status" className="mt-2 inline-flex items-center gap-2 rounded-pill bg-yang/15 px-3 py-1 text-[13px] font-semibold text-yang">
              <Check /> Video complete — nice. The most-upvoted replies climb the{" "}
              <a href={localePath(d.course.url + "?tab=rankings")} className="underline-offset-2 hover:underline">rankings</a>.
            </p>
          ) : (
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-3">
              No right or wrong answers — share what this video made you think. To complete it, post a reply
              and upvote at least one other. The most-upvoted replies climb the <a href={localePath(d.course.url + "?tab=rankings")} className="font-semibold text-yang hover:underline">course rankings</a> — only the upvotes matter.
            </p>
          )}
          <div className="mt-4">
            <SectionBoardView lessonId={Number(d.id)} onEngagementChange={onEngagement} />
          </div>
        </section>
      </div>
      <Curriculum items={curriculum} courseUrl={d.course.url} />
    </div>
  );
}
