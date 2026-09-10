import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FRAME_H, FRAME_W, clockLabel, drawMeetingFrame, meetingRecordingName, type Tile } from "../../lib/meeting-frame";
import { pickRecordingType, warmFonts } from "../../lib/episode-frame";
import { sendForFinishing, sendState, subscribeSend, writeSidecar, writeThumb, type SendState } from "../../lib/episode-upload";
import { meetRecorded } from "../../lib/api";
import { canStore, openRecording, recordingFile, type Writable } from "../../lib/episode-store";

/**
 * THE SAME RECORDING, FOR EVERY OTHER MEETING (operator, 2026-09-10: "every meeting must follow
 * the same recording product to artacast").
 *
 * ArtaMeet is end-to-end encrypted, so the only place a meeting can be recorded is a participant's
 * browser — this panel, shown to the HOST. It composites the call into a 1920×1080 grid
 * (lib/meeting-frame), mixes every voice, and hands the result to MediaRecorder at 30fps: H.264 and
 * AAC in MP4 where the browser writes it, VP9/Opus in WebM otherwise.
 *
 * From Stop onwards the road is the episode's, step for step: the file is written to the browser's
 * own on-disk store as it records (so a two-hour meeting is not held in memory and lost at the last
 * second), handed to the host's Downloads, sent to their ArtaCloud shelf, and finished on Kaggle by
 * the same script — voices cleaned, loudness set to −14 LUFS, picture untouched. The host is
 * emailed when it is ready.
 *
 * Everyone else in the room sees the red line for as long as it is on: the sealed `rec` payload
 * the call already carries. Nobody is recorded quietly.
 */

const FPS = 30;
const VIDEO_BPS = 8_000_000;
const AUDIO_BPS = 192_000;
const THUMB_W = 1280, THUMB_H = 720;

type Feed = { uid: number; stream: MediaStream | null; name: string };

function fmtBytes(n: number): string {
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${Math.round(n / 1e6)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

export function MeetingRecorder({ meetId, title, local, me, myName, peers, onRecState }: {
  meetId: number;
  title: string;
  local: MediaStream | null;
  me: number;
  myName: string;
  peers: Feed[];
  onRecState: (on: boolean) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const videos = useRef<Map<number, HTMLVideoElement>>(new Map());
  const [rec, setRec] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [err, setErr] = useState("");
  const [names, setNames] = useState(true);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<{ name: string; bytes: number; seconds: number; label: string; url: string } | null>(null);
  const [send, setSend] = useState<SendState | undefined>(undefined);
  const [diskOk, setDiskOk] = useState<boolean | null>(null);
  const sendName = useRef("");
  const recorder = useRef<MediaRecorder | null>(null);
  const writable = useRef<Writable | null>(null);
  const writing = useRef<Promise<void>>(Promise.resolve());
  const chunks = useRef<Blob[]>([]);
  const memoryFile = useRef<File | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const audioDest = useRef<MediaStreamAudioDestinationNode | null>(null);
  const mixed = useRef<Set<string>>(new Set());
  const startedAt = useRef(0);
  const state = useRef({ names: true, seconds: 0 });
  const type = useMemo(() => pickRecordingType(), []);

  useEffect(() => subscribeSend(() => setSend(sendName.current ? sendState(sendName.current) : undefined)), []);
  useEffect(() => { canStore().then(setDiskOk).catch(() => setDiskOk(false)); }, []);
  useEffect(() => { state.current = { names, seconds }; }, [names, seconds]);

  /** The host first, then everyone else in the order the room lists them. */
  const roster = useMemo<Feed[]>(() => [{ uid: me, stream: local, name: myName }, ...peers], [me, local, myName, peers]);

  /** A hidden, playing <video> per stream, so drawImage has frames to read. */
  const videoFor = useCallback((uid: number, s: MediaStream | null): HTMLVideoElement | null => {
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
  }, []);

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
      const tiles: Tile[] = roster.map((f) => ({ uid: f.uid, name: f.name, video: videoFor(f.uid, f.stream) }));
      drawMeetingFrame(ctx, tiles, { title, seconds: state.current.seconds, names: state.current.names });
    };
    const t = window.setInterval(tick, 1000 / FPS);
    tick();
    return () => { stop = true; window.clearInterval(t); };
  }, [roster, videoFor, open, title]);

  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => setSeconds(Math.round((Date.now() - startedAt.current) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [rec]);

  // Leaving the call while recording: stop cleanly so the file is closed, never torn.
  useEffect(() => () => {
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    for (const v of videos.current.values()) { v.pause(); v.srcObject = null; }
    videos.current.clear();
  }, []);

  /** Add every voice not yet in the mix — someone who joins mid-take is heard from their first word. */
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
    const name = meetingRecordingName(title, type.ext);
    writable.current = await openRecording(name);
    if (writable.current) {
      void writeSidecar(name, { meet_id: meetId, request_id: 0, spec: null, at: Date.now(), kind: "meet" });
    }
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
        // THE THUMBNAIL, taken from the frame itself — the room as it looked, at 1280×720.
        try {
          const tc = document.createElement("canvas"); tc.width = THUMB_W; tc.height = THUMB_H;
          const tctx = tc.getContext("2d");
          if (tctx && canvas.current) {
            tctx.drawImage(canvas.current, 0, 0, THUMB_W, THUMB_H);
            const blob = await new Promise<Blob | null>((r) => tc.toBlob(r, "image/png"));
            if (blob) await writeThumb(name, blob);
          }
        } catch { /* no thumbnail — the run still finishes */ }
        let url = "";
        if (writable.current) {
          await writing.current;
          try { await writable.current.close(); } catch { setErr("The file could not be closed cleanly."); }
          writable.current = null;
          const f = await recordingFile(name);
          if (f) url = URL.createObjectURL(f);
          sendName.current = name;
          window.setTimeout(() => { sendForFinishing(name, meetId, null, "meet").catch(() => undefined); }, 1500);
        } else {
          const blob = new Blob(chunks.current, { type: type.mime });
          memoryFile.current = new File([blob], name, { type: type.mime });
          url = URL.createObjectURL(blob);
          chunks.current = [];
          sendName.current = name;
          sendForFinishing(name, meetId, memoryFile.current, "meet").catch(() => undefined);
        }
        setDone({ name, bytes: total, seconds: secs, label: type.label, url });
        // STRAIGHT INTO DOWNLOADS: the host pressed Stop; the file should be on their computer.
        if (url) download(url, name);
        meetRecorded(meetId, { seconds: secs, bytes: total, format: type.label }).catch(() => undefined);
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
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
  }

  const btn = "inline-flex h-10 shrink-0 items-center rounded-pill px-3 text-[12.5px] font-semibold";
  return (
    <section className="border-t border-line" aria-label="Meeting recorder">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <p className="min-w-0 flex-1 text-[12.5px] text-ink-2">
          {rec
            ? <><span className="me-1.5 inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-red-500 align-middle" aria-hidden /><b className="text-ink">Recording</b> · <span data-ay-skip="1">{clockLabel(seconds)}</span> · <span data-ay-skip="1">{fmtBytes(bytes)}</span></>
            : done
            ? <>Saved to your Downloads · <span data-ay-skip="1">{fmtBytes(done.bytes)}</span></>
            : <>Record this meeting — 1920×1080, cleaned and levelled for YouTube afterwards.</>}
        </p>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${btn} border border-line text-ink-2`}>{open ? "Hide" : "Record"}</button>
      </div>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {/* This canvas IS the recording: what the host sees here is the file. */}
          <canvas ref={canvas} width={FRAME_W} height={FRAME_H} className="w-full rounded-card bg-black" aria-label="The meeting frame as it is being recorded" />
          <div className="flex flex-wrap items-center gap-2">
            {!rec ? (
              <button type="button" onClick={() => void start()} className={`${btn} bg-yang px-4 text-on-accent`} disabled={!type}>Record</button>
            ) : (
              <button type="button" onClick={stop} className={`${btn} bg-red-600 px-4 text-white`}>Stop &amp; save</button>
            )}
            <button type="button" onClick={() => setNames((v) => !v)} className={`${btn} ${names ? "bg-yang text-on-accent" : "border border-line text-ink-2"}`}>{names ? "Names on" : "Names off"}</button>
          </div>
          <p className="text-[12px] leading-relaxed text-ink-3">
            {type
              ? <>{type.label} · {diskOk === false ? "held in memory on this browser — keep the tab open" : "written to this computer as you record, and saved to your Downloads at Stop"}. Everyone in the call is told while it runs.</>
              : <>This browser cannot record video — Chrome or Edge on a laptop can.</>}
          </p>
          {done && (
            <p className="text-[12px] text-ink-2" role="status">
              {send?.phase === "uploading" ? <>Sending for finishing · <span data-ay-skip="1">{Math.round(send.frac * 100)}%</span> — keep this tab open</>
                : send?.phase === "done" ? <>Being cleaned and levelled on Kaggle. You will be emailed; the meeting page carries the download.</>
                : send?.phase === "error" ? <span className="text-yang">Couldn’t send it: {send.note}</span>
                : <>Preparing to send…</>}
            </p>
          )}
          {err && <p className="text-[12px] text-yang" role="alert">{err}</p>}
        </div>
      )}
    </section>
  );
}
