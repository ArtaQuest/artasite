import { useEffect, useRef, useState } from "react";
import { devicePrefs, listDevices, mediaErrorMessage, rememberDevices, type CallMode } from "../../lib/webrtc";
import { dress } from "../../lib/look";
import { Appearance } from "./Appearance";

/**
 * THE MIRROR BEFORE THE DOOR.
 *
 * Every call product worth the name shows you your own picture before anybody else sees it, with
 * the camera and microphone you are about to use named beside it. This is that: opened on request
 * (never on page load — a camera light that comes on because a page was visited is a breach of
 * trust), showing the picture, a level meter that proves the microphone hears you, and the device
 * pickers. The choice is stored per browser (lib/webrtc devicePrefs) and honoured by the call.
 *
 * Nothing here touches the call: the preview stream is stopped the moment the panel closes or the
 * page moves on, and the call opens its own with the same preferences.
 */
export function PreJoin({ mode }: { mode: CallMode }) {
  const [open, setOpen] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [err, setErr] = useState("");
  const [level, setLevel] = useState(0);
  const [list, setList] = useState<{ cams: MediaDeviceInfo[]; mics: MediaDeviceInfo[]; outs: MediaDeviceInfo[] } | null>(null);
  const [prefs, setPrefs] = useState(devicePrefs);
  const vid = useRef<HTMLVideoElement | null>(null);
  const wantVideo = mode !== "audio";

  // Open (and re-open on a device change) while the panel is up; stop everything when it closes.
  useEffect(() => {
    if (!open) return;
    let dead = false;
    let s: MediaStream | null = null;
    (async () => {
      setErr("");
      try {
        s = await navigator.mediaDevices.getUserMedia({
          audio: prefs.mic ? { deviceId: { ideal: prefs.mic } } : true,
          video: wantVideo ? (prefs.cam ? { width: { ideal: 640 }, height: { ideal: 360 }, deviceId: { ideal: prefs.cam } } : { width: { ideal: 640 }, height: { ideal: 360 } }) : false,
        });
      } catch (e) {
        if (!dead) setErr(mediaErrorMessage(e));
        return;
      }
      if (dead) { s.getTracks().forEach((t) => t.stop()); return; }
      // The mirror shows the DRESSED picture — the same lib/look pass the call will send — so the
      // appearance switches below can be judged here, before anybody else sees it. Stopping the
      // dressed track stops the camera behind it.
      const cam = s.getVideoTracks()[0];
      if (cam) { const d = dress(cam); if (d !== cam) { s.removeTrack(cam); s.addTrack(d); } }
      setStream(s);
      setList(await listDevices());
    })();
    return () => {
      dead = true;
      s?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
  }, [open, prefs.cam, prefs.mic, wantVideo]);

  useEffect(() => {
    const el = vid.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) el.play().catch(() => undefined);
  }, [stream]);

  // The level meter: the same Web Audio tap the call uses to find who is talking.
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) { setLevel(0); return; }
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext;
    try { ctx = new Ctor(); } catch { return; }
    void ctx.resume?.().catch(() => undefined);
    let an: AnalyserNode;
    try {
      const src = ctx.createMediaStreamSource(stream);
      an = ctx.createAnalyser(); an.fftSize = 256; src.connect(an);
    } catch { void ctx.close().catch(() => undefined); return; }
    const buf = new Uint8Array(an.fftSize);
    const iv = window.setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
    }, 100);
    return () => { window.clearInterval(iv); void ctx.close().catch(() => undefined); };
  }, [stream]);

  const pick = (k: "cam" | "mic" | "out", id: string) => {
    rememberDevices({ [k]: id });
    setPrefs(devicePrefs());
  };
  const sel = "mt-1 h-10 w-full rounded-field border border-line bg-space-1 px-2.5 text-[13px] text-ink";
  const canSink = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="mb-3 inline-flex h-10 items-center rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2 transition-colors hover:border-yin-light hover:text-ink">
        {wantVideo ? "Check my camera and microphone" : "Check my microphone"}
      </button>
    );
  }
  const camId = stream?.getVideoTracks()[0]?.getSettings?.().deviceId || prefs.cam || "";
  const micId = stream?.getAudioTracks()[0]?.getSettings?.().deviceId || prefs.mic || "";
  return (
    <div className="mb-3 rounded-card border border-line bg-veil/[0.04] p-3" aria-label="Camera and microphone check">
      {wantVideo && (
        <div className="relative aspect-video overflow-hidden rounded-card bg-black/70">
          <video ref={vid} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" aria-label="Your camera" />
          {!stream && !err && <p className="absolute inset-0 grid place-items-center text-[12px] text-white/85">Opening your camera…</p>}
        </div>
      )}
      {err && <p className="mt-2 text-[12.5px] text-yang">{err}</p>}
      {stream && (
        <div className="mt-2 flex items-center gap-2" aria-label="Microphone level">
          <span className="text-[12px] text-ink-3">Mic</span>
          <span className="h-2 flex-1 overflow-hidden rounded-pill bg-veil/15">
            <span className="block h-full rounded-pill bg-yang transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
          </span>
          <span className="text-[12px] text-ink-3">{level > 0.05 ? "hearing you" : "say something"}</span>
        </div>
      )}
      {list && (
        <div className="mt-2 grid gap-2 sm:grid-cols-3" data-ay-skip="1">
          {list.mics.length > 0 && (
            <label className="block text-[12px] text-ink-3">Microphone
              <select className={sel} value={micId} onChange={(e) => pick("mic", e.target.value)}>
                {list.mics.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
              </select>
            </label>
          )}
          {wantVideo && list.cams.length > 0 && (
            <label className="block text-[12px] text-ink-3">Camera
              <select className={sel} value={camId} onChange={(e) => pick("cam", e.target.value)}>
                {list.cams.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
              </select>
            </label>
          )}
          {canSink && list.outs.length > 0 && (
            <label className="block text-[12px] text-ink-3">Speaker
              <select className={sel} value={prefs.out || ""} onChange={(e) => pick("out", e.target.value)}>
                <option value="">Default</option>
                {list.outs.filter((d) => d.deviceId !== "default").map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      {wantVideo && stream && (
        <details className="mt-2 rounded-card border border-line px-3 py-1.5">
          <summary className="cursor-pointer text-[13px] font-semibold text-ink-2">Appearance</summary>
          <Appearance track={stream.getVideoTracks()[0]} />
        </details>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-[12px] leading-relaxed text-ink-3">Only you can see this. The camera closes when you press Done.</p>
        <button type="button" onClick={() => setOpen(false)}
          className="inline-flex h-10 shrink-0 items-center rounded-pill border border-line px-4 text-[13px] font-semibold text-ink-2 hover:border-yin-light hover:text-ink">Done</button>
      </div>
    </div>
  );
}
