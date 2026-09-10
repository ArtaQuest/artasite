import { useEffect, useRef, useState } from "react";
import { pickRecordingType, type EpisodeSpec } from "../../lib/episode-frame";
import { canStore, openRecording, type Writable } from "../../lib/episode-store";
import { sendIso, sendState, subscribeSend, writeSidecar, type SendState } from "../../lib/episode-upload";

/**
 * THE GUEST'S OWN TRACK. The picture of a guest in the host's master is bounded by what the link
 * carried — 720p at best, less on a bad afternoon. So while the host records, each guest's browser
 * also records its OWN camera and microphone, straight from the capture, at 720p and 4 Mbit/s, into
 * the browser's on-disk store; when the take ends it goes to the guest's shelf (they carry a grant
 * for exactly this while their episode is live) and is attached to the request as an isolated
 * track. The editor gets a clean, full-quality copy of every face whatever the link did.
 *
 * Only where it is safe: a laptop-class device with room on disk. A phone with two gigabytes free
 * is told nothing and records nothing — the master is the master; this is the extra.
 */

const ISO_VIDEO_BPS = 4_000_000;
const ISO_AUDIO_BPS = 128_000;
const NEED_BYTES = 3 * 1024 * 1024 * 1024; // three gigabytes free before a take starts

async function eligible(): Promise<{ ok: boolean; why: string }> {
  try {
    const coarse = window.matchMedia("(pointer: coarse)").matches && Math.min(window.innerWidth, window.innerHeight) < 700;
    if (coarse) return { ok: false, why: "a phone" };
    if (!(await canStore())) return { ok: false, why: "no on-disk store" };
    const est = await navigator.storage?.estimate?.();
    const free = est && est.quota && est.usage != null ? est.quota - est.usage : 0;
    if (free && free < NEED_BYTES) return { ok: false, why: "not enough room on disk" };
    return { ok: true, why: "" };
  } catch { return { ok: false, why: "storage unavailable" }; }
}

export function IsoRecorder({ local, on, meetId, me, spec, who: whoName }: {
  local: MediaStream | null; on: boolean; meetId: number; me: number;
  /** The episode this track belongs to, or null when it is an ordinary meeting. */
  spec: EpisodeSpec | null;
  /** The guest's own name, when there is no episode spec to read it from. */
  who?: string;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "saving" | "sent" | "skipped">("idle");
  const [why, setWhy] = useState("");
  const [send, setSend] = useState<SendState | undefined>(undefined);
  const rec = useRef<MediaRecorder | null>(null);
  const writable = useRef<Writable | null>(null);
  const writing = useRef<Promise<void>>(Promise.resolve());
  const name = useRef("");
  useEffect(() => subscribeSend(() => setSend(name.current ? sendState(name.current) : undefined)), []);

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      const e = await eligible();
      if (cancelled) return;
      if (!e.ok) { setPhase("skipped"); setWhy(e.why); return; }
      const type = pickRecordingType();
      if (!type || !local) { setPhase("skipped"); setWhy("this browser cannot record"); return; }
      const who = spec ? (spec.a.uid === me ? spec.a.name : spec.b.name) : (whoName || "guest");
      const clean = (s: string) => (s || "").normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "guest";
      const n = `ISO-${clean(who)}-${meetId}-${Date.now()}.${type.ext}`;
      const w = await openRecording(n);
      if (cancelled || !w) { setPhase("skipped"); setWhy("could not open a file"); return; }
      writable.current = w; name.current = n;
      await writeSidecar(n, { meet_id: meetId, request_id: 0, spec, at: Date.now(), iso: true, kind: spec ? "cast" : "meet" });
      const stream = new MediaStream(local.getTracks());
      let mr: MediaRecorder;
      try { mr = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: ISO_VIDEO_BPS, audioBitsPerSecond: ISO_AUDIO_BPS }); }
      catch { setPhase("skipped"); setWhy("the recorder refused"); return; }
      mr.ondataavailable = (ev) => { if (ev.data?.size) writing.current = writing.current.then(() => w.write(ev.data)).catch(() => undefined); };
      mr.onstop = () => {
        setPhase("saving");
        void (async () => {
          await writing.current;
          try { await w.close(); } catch { /* the store refused the close; the bytes so far are there */ }
          writable.current = null;
          setPhase("sent");
          sendIso(n, meetId, spec ? "cast" : "meet").catch(() => undefined);
        })();
      };
      mr.start(2000);
      rec.current = mr;
      setPhase("recording");
    };
    if (on && phase === "idle") void start();
    if (!on && rec.current && rec.current.state !== "inactive") rec.current.stop();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, local]);

  // Leaving the call ends the take: the file closes and goes off to the shelf on its own.
  useEffect(() => () => { if (rec.current && rec.current.state !== "inactive") rec.current.stop(); }, []);

  if (phase === "idle" || phase === "skipped") return null;
  return (
    <p className="border-t border-line px-3 py-1.5 text-[12px] leading-relaxed text-ink-3" role="status">
      {phase === "recording" && <>Your own camera is also being recorded on this computer at full quality, for the editor. It is sent after the take.</>}
      {phase === "saving" && <>Closing your camera recording…</>}
      {phase === "sent" && (send
        ? send.phase === "uploading" ? <>Sending your camera recording · <span data-ay-skip="1">{Math.round(send.frac * 100)}%</span> — keep this tab open</>
          : send.phase === "done" ? <>Your camera recording is with the editor.</>
          : send.phase === "error" ? <span className="text-yang">Your camera recording could not be sent — the ArtaCast page can send it again.</span>
          : <>Sending your camera recording…</>
        : <>Sending your camera recording…</>)}
      {why && <> ({why})</>}
    </p>
  );
}
