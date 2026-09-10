import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FRAME_H, FRAME_W, THUMB_H, THUMB_W, drawEpisodeFrame, drawThumbnail, episodeRows, loadPortraits, pickRecordingType, recordingName, warmFonts,
  type EpisodeSpec, type FrameInput,
} from "../../lib/episode-frame";
import { sendForFinishing, sendState, subscribeSend, writeSidecar, writeThumb, type SendState } from "../../lib/episode-upload";
import { chapterSequence, cursorsAt, firstName } from "../../lib/cast-frame";
import { castRecorded } from "../../lib/api";
import { canStore, deleteRecording, listRecordings, openRecording, recordingFile, type StoredRecording, type Writable } from "../../lib/episode-store";

/**
 * THE RECORDER — the host's device cuts the episode while it happens.
 *
 * ArtaMeet is end-to-end encrypted: no server ever holds a frame, so the only place an episode can
 * be recorded is a participant's browser. This panel, shown to the HOST of an ArtaCast recording,
 * composites the three feeds into the kit's 1920×1080 frame on a canvas (lib/episode-frame), mixes
 * the three voices, and hands the result to MediaRecorder at 30fps — H.264/AAC in MP4 where the
 * browser can write it, VP9/Opus in WebM otherwise. Both go straight onto YouTube.
 *
 * WRITTEN TO DISK AS IT RECORDS, AND SAVED TO THE HOST'S COMPUTER AT STOP. Ninety minutes at
 * 8 Mbit/s is over five gigabytes; holding that in memory until Stop is how a two-hour recording
 * is lost at the last second. Every second's chunk is appended to a file in the browser's own
 * on-disk store (lib/episode-store — no prompt, any modern browser, survives a crash); at Stop the
 * finished file is handed to the Downloads folder, and it stays listed under the recorder, with a
 * Download button, until the host deletes it. Where that store is unavailable the chunks are held
 * in memory and the panel says so before Record.
 *
 * The chapter cursors (the gold on each rail, the kit's "chapter change") are the host's to move
 * during the conversation: one button per spouse. Names (the lower-thirds) can be shown or hidden.
 * Nothing about the recording is a server feature — the room is told through a sealed `rec`
 * payload so everyone sees "Recording" for as long as it is on.
 */

const FPS = 30;
const VIDEO_BPS = 8_000_000;
const AUDIO_BPS = 192_000;

type Feed = { uid: number; stream: MediaStream | null };

function fmtBytes(n: number): string {
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}
function fmtClock(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:` : "") + `${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
}

/** Hand a file to the Downloads folder. Programmatic; the browser may still ask where, which is fine. */
function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
}

export function EpisodeRecorder({ spec, local, peers, me, meetId, onRecState }: {
  spec: EpisodeSpec;
  local: MediaStream | null;
  peers: Feed[];
  me: number;
  meetId: number;
  onRecState: (on: boolean) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const videos = useRef<Map<number, HTMLVideoElement>>(new Map());
  const [rec, setRec] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ name: string; bytes: number; seconds: number; label: string; url: string } | null>(null);
  const [names, setNames] = useState(true);
  /** The chapter the story is on: him, then her, then him… see lib/cast-frame chapterSequence. */
  const [chapter, setChapter] = useState(0);
  const [open, setOpen] = useState(true);
  const state = useRef({ names: true, cursorA: 0, cursorB: -1, active: "a" as "a" | "b" | null });
  /** Where the gold IS on each rail, sliding towards the chapter the host chose — the slider is
   *  animated in the draw loop, so a press moves the record smoothly rather than in a jump. */
  const slide = useRef({ a: 0, b: 0, at: 0 });
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  /** The finished file when the browser held it in memory (no store) — what the send reads then. */
  const memoryFile = useRef<File | null>(null);
  const writable = useRef<Writable | null>(null);
  const [stored, setStored] = useState<StoredRecording[]>([]);
  const [send, setSend] = useState<SendState | undefined>(undefined);
  const sendName = useRef("");
  useEffect(() => subscribeSend(() => setSend(sendName.current ? sendState(sendName.current) : undefined)), []);
  const [diskOk, setDiskOk] = useState<boolean | null>(null);
  const refreshStored = useCallback(() => { listRecordings().then(setStored).catch(() => undefined); }, []);
  useEffect(() => { canStore().then(setDiskOk).catch(() => setDiskOk(false)); refreshStored(); }, [refreshStored]);
  const writing = useRef<Promise<void>>(Promise.resolve());
  const audioCtx = useRef<AudioContext | null>(null);
  const audioDest = useRef<MediaStreamAudioDestinationNode | null>(null);
  /** Audio tracks already feeding the mix, by track id — a stream object may be rebuilt around the
   *  same microphone track (a screen share does that), and the same voice must not be mixed twice. */
  const mixed = useRef<Set<string>>(new Set());
  const startedAt = useRef(0);
  const rows = useMemo(() => episodeRows(spec), [spec]);
  const type = useMemo(() => pickRecordingType(), []);

  const seq = useMemo(() => chapterSequence(rows.a.length, rows.b.length), [rows]);
  const at = useMemo(() => cursorsAt(seq, chapter), [seq, chapter]);
  useEffect(() => { state.current = { names, cursorA: at.a, cursorB: at.b, active: at.active }; }, [names, at]);
  const nextBoth = useCallback(() => setChapter((c) => Math.min(seq.length - 1, c + 1)), [seq]);
  const backBoth = useCallback(() => setChapter((c) => Math.max(0, c - 1)), []);
  /** The chapter in words: whose turn, which year, what happened. */
  const chapterLine = (() => {
    const ch = seq[chapter];
    if (!ch) return "";
    const row = (ch.rail === "a" ? rows.a : rows.b)[ch.row];
    const who = firstName(ch.rail === "a" ? spec.a.name : spec.b.name) || (ch.rail === "a" ? "Left" : "Right");
    return row ? `${who} · ${row.y} ${row.l}` : who;
  })();
  // Arrow keys drive the chapters while the panel is open and nothing is being typed.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowRight") { nextBoth(); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { backBoth(); e.preventDefault(); }
      else if (e.key.toLowerCase() === "n") { setNames((v) => !v); e.preventDefault(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, nextBoth, backBoth]);

  /** Who is in which window. The requester is the left window, the partner the right, the host
   *  below — by member id, never by arrival order. */
  const feedFor = useCallback((uid: number): MediaStream | null => {
    if (uid === me) return local;
    return peers.find((p) => p.uid === uid)?.stream || null;
  }, [me, local, peers]);

  /** A hidden, playing <video> per stream, so drawImage has frames to read. A stream that changes
   *  identity (a reload on the other side) gets a fresh element. */
  const videoFor = useCallback((uid: number): HTMLVideoElement | null => {
    const s = feedFor(uid);
    if (!s || !s.getVideoTracks().length) return null;
    let v = videos.current.get(uid);
    if (!v || v.srcObject !== s) {
      v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.autoplay = true;
      v.srcObject = s;
      v.play().catch(() => undefined);
      videos.current.set(uid, v);
    }
    return v;
  }, [feedFor]);

  /** WHOSE PICTURE HAS NOT ARRIVED. A window recorded before its guest's video reached this
   *  device is a dark window on the record — the host is told before pressing Record, in words,
   *  and may still record (a guest whose camera is off is a choice, not a fault). */
  const [noPicture, setNoPicture] = useState<string[]>([]);
  const lastMissing = useRef<{ key: string; n: number }>({ key: "", n: 0 });
  useEffect(() => {
    const read = () => {
      const out: string[] = [];
      for (const side of [spec.a, spec.b]) {
        // Judged by FRAMES, not by the track's flags: a received track flickers "muted" for a
        // moment as packets pause, and that moment was reported as a missing picture.
        const v = videoFor(side.uid);
        if (!v || v.videoWidth === 0 || v.readyState < 2) out.push(side.name || "a guest");
      }
      // Said only once it has held for SIX SECONDS: a feed that just arrived takes a few seconds
      // to show its first frame here, and a line that flashes for every newcomer teaches the host
      // to ignore it. A picture that goes away mid-call is reported after the same pause.
      const key = out.join("|");
      const l = lastMissing.current;
      lastMissing.current = key === l.key ? { key, n: l.n + 1 } : { key, n: 1 };
      const settled = key && lastMissing.current.n >= 4 ? out : [];
      setNoPicture((cur) => (cur.join("|") === settled.join("|") ? cur : settled));
    };
    read();
    const iv = window.setInterval(read, 1500);
    return () => window.clearInterval(iv);
  }, [videoFor, spec]);

  // The draw loop runs while the panel is open, recording or not: the small live picture is how
  // the host frames the shot before pressing Record.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !open) return;
    const ctx = c.getContext("2d", { alpha: false });
    if (!ctx) return;
    let stop = false;
    void warmFonts();
    const tick = () => {
      if (stop) return;
      // Ease each rail towards its chapter: about 400 ms from press to rest, frame-rate independent.
      const now = performance.now();
      const dt = slide.current.at ? Math.min(0.1, (now - slide.current.at) / 1000) : 0;
      slide.current.at = now;
      const k = 1 - Math.exp(-dt * 9);
      slide.current.a += (state.current.cursorA - slide.current.a) * k;
      slide.current.b += (state.current.cursorB - slide.current.b) * k;
      if (Math.abs(slide.current.a - state.current.cursorA) < 0.004) slide.current.a = state.current.cursorA;
      if (Math.abs(slide.current.b - state.current.cursorB) < 0.004) slide.current.b = state.current.cursorB;
      const input: FrameInput = {
        a: videoFor(spec.a.uid), b: videoFor(spec.b.uid), host: videoFor(spec.host_id),
        cursorA: slide.current.a, cursorB: slide.current.b, active: state.current.active, names: state.current.names,
      };
      drawEpisodeFrame(ctx, spec, rows, input);
    };
    const t = window.setInterval(tick, 1000 / FPS);
    tick();
    return () => { stop = true; window.clearInterval(t); };
  }, [spec, rows, videoFor, open]);

  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => setSeconds(Math.round((Date.now() - startedAt.current) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [rec]);

  // Leaving the call while recording: stop cleanly so the file is closed, never torn — and let go
  // of the hidden video elements, which would otherwise keep decoding three streams for nobody.
  useEffect(() => () => {
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    for (const v of videos.current.values()) { v.pause(); v.srcObject = null; }
    videos.current.clear();
  }, []);

  /** Add every voice not yet in the mix. Sources are the raw MediaStreams — never a media element,
   *  which a Web Audio tap would mute. Called at Start and again whenever the room changes, so a
   *  partner who arrives after Record is pressed is heard from their first word. */
  const feedMix = useCallback(() => {
    const ctx = audioCtx.current, dest = audioDest.current;
    if (!ctx || !dest) return;
    for (const s of [local, ...peers.map((p) => p.stream)]) {
      if (!s) continue;
      for (const t of s.getAudioTracks()) {
        if (mixed.current.has(t.id)) continue;
        try { ctx.createMediaStreamSource(new MediaStream([t])).connect(dest); mixed.current.add(t.id); } catch { /* no live audio on it */ }
      }
    }
  }, [local, peers]);
  useEffect(() => { if (rec) feedMix(); }, [rec, feedMix]);

  function mixAudio(): MediaStreamTrack | null {
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    audioCtx.current = ctx;
    audioDest.current = ctx.createMediaStreamDestination();
    mixed.current = new Set();
    feedMix();
    return audioDest.current.stream.getAudioTracks()[0] || null;
  }

  async function start() {
    setErr(""); setDone(null);
    const c = canvas.current;
    if (!c || !type) { setErr("This browser cannot record video. Chrome or Edge on a laptop can."); return; }
    const name = recordingName(spec, type.ext);
    // A file in the browser's own store, no prompt. Null means memory — the panel already said so.
    writable.current = await openRecording(name);
    // Which meeting this file belongs to, beside it — so the show page can send it later without asking.
    if (writable.current) void writeSidecar(name, { meet_id: meetId, request_id: 0, spec, at: Date.now() });
    await warmFonts();
    const stream = c.captureStream(FPS);
    const audio = mixAudio();
    if (audio) stream.addTrack(audio);
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: AUDIO_BPS });
    } catch (e) {
      setErr(`Couldn’t start the recorder: ${(e as Error)?.message || "unknown error"}`);
      return;
    }
    chunks.current = [];
    let total = 0;
    mr.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      total += ev.data.size;
      setBytes(total);
      if (writable.current) {
        const w = writable.current;
        writing.current = writing.current.then(() => w.write(ev.data)).catch(() => { setErr("Writing to the file failed — the disk may be full."); });
      } else {
        chunks.current.push(ev.data);
      }
    };
    mr.onerror = () => setErr("The recorder stopped with an error.");
    mr.onstop = () => {
      const secs = Math.round((Date.now() - startedAt.current) / 1000);
      const finish = async () => {
        let url = "";
        if (writable.current) {
          await writing.current;
          try { await writable.current.close(); } catch { setErr("The file could not be closed cleanly."); }
          writable.current = null;
          const f = await recordingFile(name);
          if (f) url = URL.createObjectURL(f);
          refreshStored();
          sendName.current = name;
          // deferred a tick so the thumbnail below is written before the send reads it
          window.setTimeout(() => { sendForFinishing(name, meetId).catch(() => undefined); }, 1500);
        } else {
          const blob = new Blob(chunks.current, { type: type.mime });
          memoryFile.current = new File([blob], name, { type: type.mime });
          url = URL.createObjectURL(blob);
          chunks.current = [];
        }
        setDone({ name, bytes: total, seconds: secs, label: type.label, url });
        // STRAIGHT INTO DOWNLOADS. The host pressed Stop; the file should be on their computer
        // without another decision. The button below is the way back if the browser held it.
        if (url) download(url, name);
        castRecorded(meetId, { seconds: secs, bytes: total, format: type.label }).catch(() => undefined);
        // THE THUMBNAIL, drawn now from the same facts, kept beside the recording.
        try {
          const [pa, pb] = await loadPortraits(spec);
          const tc = document.createElement("canvas"); tc.width = THUMB_W; tc.height = THUMB_H;
          const tctx = tc.getContext("2d");
          if (tctx) {
            drawThumbnail(tctx, spec, pa, pb);
            const blob = await new Promise<Blob | null>((r) => tc.toBlob(r, "image/png"));
            if (blob) await writeThumb(name, blob);
          }
        } catch { /* no thumbnail — the run still finishes */ }
        // AND OFF TO BE FINISHED — no button. The file goes to the host's shelf and Kaggle takes it
        // from there; the show page shows progress and the result, and the host is emailed.
        if (writable.current === null && url) {
          sendName.current = name;
          sendForFinishing(name, meetId, memoryFile.current).catch(() => undefined);
        }
      };
      void finish();
      audioCtx.current?.close().catch(() => undefined);
      audioCtx.current = null;
      audioDest.current = null;
      mixed.current = new Set();
      setRec(false);
      onRecState(false);
    };
    startedAt.current = Date.now();
    setBytes(0); setSeconds(0);
    mr.start(1000);
    recorder.current = mr;
    setRec(true);
    onRecState(true);
  }

  function stop() {
    const mr = recorder.current;
    if (mr && mr.state !== "inactive") mr.stop();
  }

  const btn = "inline-flex h-10 shrink-0 items-center rounded-pill px-3 text-[12.5px] font-semibold";
  const missing = [spec.a.uid, spec.b.uid].filter((u) => !feedFor(u)?.getVideoTracks().length).length;

  return (
    <section className="border-t border-line bg-space-2/60" aria-label="Episode recorder">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={`h-2.5 w-2.5 rounded-full ${rec ? "bg-red-500 animate-pulse" : "bg-ink-3"}`} aria-hidden />
        <p className="min-w-0 flex-1 text-[13px] font-semibold text-ink">
          {rec ? <>Recording · <span data-ay-skip="1">{fmtClock(seconds)}</span> · <span data-ay-skip="1">{fmtBytes(bytes)}</span></> : "ArtaCast episode recorder"}
        </p>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${btn} border border-line text-ink-2`}>{open ? "Hide" : "Show"}</button>
      </div>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {/* The live cut, small. This canvas IS the recording: what the host sees here is the file. */}
          <canvas ref={canvas} width={FRAME_W} height={FRAME_H} className="w-full rounded-card bg-black" aria-label="The episode frame as it is being recorded" />
          <div className="flex flex-wrap items-center gap-2">
            {!rec ? (
              <button type="button" onClick={() => void start()} className={`${btn} bg-yang px-4 text-on-accent`} disabled={!type}>{noPicture.length ? "Record anyway" : "Record"}</button>
            ) : (
              <button type="button" onClick={stop} className={`${btn} bg-red-600 px-4 text-white`}>Stop &amp; save</button>
            )}
            <button type="button" onClick={() => setNames((v) => !v)} className={`${btn} ${names ? "bg-yang text-on-accent" : "border border-line text-ink-2"}`}>{names ? "Names on" : "Names off"}</button>
            {/* THE HOST DRIVES THE STORY. One press moves both timelines to the next chapter — the
                gold slides down each rail as the conversation reaches that year — and the arrow keys
                do the same while the call has the keyboard. Each spouse can also be moved alone. */}
            <button type="button" onClick={backBoth} disabled={chapter <= 0}
              className={`${btn} border border-line text-ink-2 disabled:opacity-40`} title="←" aria-label="Back a chapter">←</button>
            <button type="button" onClick={nextBoth} disabled={chapter >= seq.length - 1}
              className={`${btn} bg-yin/15 text-ink disabled:opacity-40`} title="→">Next chapter</button>
            <span className="text-[12.5px] text-ink-2" aria-live="polite">
              <span data-ay-skip="1">{chapter + 1}/{seq.length}</span> · <span data-ay-skip="1">{chapterLine}</span>
            </span>
          </div>
          {!rec && noPicture.length > 0 && (
            <p className="text-[12.5px] leading-relaxed text-yang" role="status">
              No picture yet from <span data-ay-skip="1">{noPicture.join(" and ")}</span> — their window would record dark. Wait for it, ask them to turn their camera on, or record anyway.
            </p>
          )}
          <p className="text-[12px] leading-relaxed text-ink-3">
            {type
              ? <>1920×1080 at 30 fps, {type.label}, 8 Mbit/s — upload it to YouTube as it is. {diskOk !== false
                  ? "It is written to this computer as you go, and saved to your Downloads when you press Stop."
                  : "This browser holds the recording in memory until Stop — keep it under an hour, or use Chrome, Edge or Safari on a laptop."}
                  {missing > 0 && <> · <span className="text-yang">{missing === 2 ? "Neither guest’s camera is in yet." : "One guest’s camera is not in yet."}</span></>}</>
              : "This browser cannot record video. Use Chrome or Edge on a laptop."}
          </p>
          {err && <p className="text-[12.5px] text-yang" role="alert">{err}</p>}
          {done && (
            <div className="rounded-card border border-yang/40 bg-yang/[0.06] p-3 text-[13px] text-ink">
              <p className="font-semibold">Saved: <span data-ay-skip="1">{done.name}</span></p>
              <p className="mt-1 text-ink-2"><span data-ay-skip="1">{fmtClock(done.seconds)}</span> · <span data-ay-skip="1">{fmtBytes(done.bytes)}</span> · {done.label}</p>
              {done.url && <a href={done.url} download={done.name} className="mt-2 inline-flex h-10 items-center rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent">Download again</a>}
              <p className="mt-2 text-[12px] text-ink-3">It went to your Downloads. The clean, normalised release file is made for you next — see below.</p>
              {send && (
                <p className="mt-2 text-[12.5px] text-ink" role="status">
                  {send.phase === "uploading" && <>Sending to your shelf for finishing · <span data-ay-skip="1">{Math.round(send.frac * 100)}%</span> — keep this tab open</>}
                  {send.phase === "thumb" && "Sending the thumbnail…"}
                  {send.phase === "starting" && "Starting the finishing run on Kaggle…"}
                  {send.phase === "done" && <>Finishing on Kaggle: the voices are cleaned and the loudness set for YouTube. You will be emailed, and your show page carries the download.</>}
                  {send.phase === "error" && <span className="text-yang">Couldn’t send it: {send.note} — your show page can send it again.</span>}
                </p>
              )}
            </div>
          )}
          {stored.length > 0 && (
            <div className="rounded-card border border-line p-3 text-[12.5px]">
              <p className="font-semibold text-ink">Recordings kept on this computer</p>
              <ul className="mt-1 flex flex-col gap-1">
                {stored.map((s) => (
                  <li key={s.name} className="flex flex-wrap items-center gap-2 text-ink-2">
                    <span className="min-w-0 flex-1 break-all" data-ay-skip="1">{s.name} · {fmtBytes(s.bytes)}</span>
                    <button type="button" className="underline" onClick={() => { recordingFile(s.name).then((f) => { if (f) download(URL.createObjectURL(f), s.name); }); }}>Download</button>
                    <button type="button" className="underline" onClick={() => { deleteRecording(s.name).then(refreshStored); }}>Delete</button>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-ink-3">An interrupted recording is listed here too — a crash keeps everything up to that second.</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
