import { useEffect, useRef, useState } from "react";
import type { CallState } from "../../lib/webrtc";

/**
 * The call surface — two video elements and four buttons.
 *
 * There is no iframe and no third-party script here any more. Media arrives on a direct
 * peer-to-peer connection (see lib/webrtc.ts), so this component's whole job is to attach two
 * MediaStreams to two <video> elements and offer the controls.
 *
 * ⚠️ `data-ay-skip="1"` on anything carrying the peer's name, for the same reason as every other
 * member string in this surface: the i18n mesh publishes what it can reach into the PUBLIC
 * aq_translations table (see the Messages.tsx header).
 */

function Ic({ d, size = 18 }: { d: React.ReactNode; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>;
}
const MIC_ON = <><rect x="9.5" y="3" width="5" height="11" rx="2.5" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4" /></>;
const MIC_OFF = <><rect x="9.5" y="3" width="5" height="11" rx="2.5" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M3 3l18 18" /></>;
const CAM_ON = <><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="m16 10.5 5-3v9l-5-3Z" /></>;
const CAM_OFF = <><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="m16 10.5 5-3v9l-5-3ZM3 3l18 18" /></>;
const HANG = <path d="M3 10.5c5-4 13-4 18 0v3l-4 1-1-3a12 12 0 0 0-8 0l-1 3-4-1Z" />;
const EXPAND = <path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5" />;

/** Attach a MediaStream to a <video> without React fighting it — srcObject is not an attribute. */
function Video({ stream, muted, mirror, className, label }: {
  stream: MediaStream | null; muted?: boolean; mirror?: boolean; className?: string; label: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) el.play().catch(() => undefined); // autoplay can refuse; controls still work
  }, [stream]);
  return (
    <video ref={ref} autoPlay playsInline muted={muted} aria-label={label}
      className={`${className || ""} ${mirror ? "-scale-x-100" : ""} bg-black/60 object-cover`} />
  );
}

export function CallPanel({
  state, local, remote, peerName, micOn, camOn, onMic, onCam, onHangup,
}: {
  state: CallState;
  local: MediaStream | null;
  remote: MediaStream | null;
  peerName: string;
  micOn: boolean;
  camOn: boolean;
  onMic: () => void;
  onCam: () => void;
  onHangup: () => void;
}) {
  const [full, setFull] = useState(false);

  // Escape leaves full screen before it does anything else — claimed here so it does not also close
  // the surrounding dock and drop the member out of a live call.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); setFull(false); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [full]);

  const status =
    state === "calling" ? "Ringing…"
    : state === "connecting" ? "Connecting…"
    : state === "live" ? "Connected — direct, peer to peer"
    : state === "failed" ? "Couldn’t connect"
    : "";

  return (
    <section
      className={full
        ? "fixed inset-0 z-[90] flex flex-col bg-space-1"
        : "flex flex-col overflow-hidden border-b border-line bg-space-1"}
      aria-label="Call">
      <div className={`relative ${full ? "min-h-0 flex-1" : "h-[300px]"} w-full overflow-hidden bg-black/70`}>
        <Video stream={remote} label="The other person" className="h-full w-full" />
        {/* Nothing to show yet — say which stage it is at rather than a black rectangle. */}
        {!remote && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <div>
              <p className="text-[15px] font-semibold text-ink" data-ay-skip="1">{peerName}</p>
              <p className="mt-1 text-[13px] text-ink-3">{status || "Starting…"}</p>
              {state === "failed" && (
                <p className="mx-auto mt-3 max-w-xs text-[12px] leading-relaxed text-ink-3">
                  A direct connection couldn’t be made — this usually means one of you is on a network that
                  blocks peer-to-peer traffic. Messages are unaffected.
                </p>
              )}
            </div>
          </div>
        )}
        {/* Your own camera, small and mirrored — mirrored because everyone expects to see themselves
            the way a mirror shows them, and muted because hearing yourself is unbearable. */}
        {local && (
          <div className="absolute bottom-3 end-3 h-[84px] w-[112px] overflow-hidden rounded-card border border-line shadow-card">
            <Video stream={local} muted mirror label="Your camera" className="h-full w-full" />
            {!camOn && (
              <div className="absolute inset-0 grid place-items-center bg-space-2/90 text-[10.5px] font-semibold text-ink-3">
                Camera off
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-[12px] text-ink-3" aria-live="polite">
          {state === "live" ? "Encrypted end-to-end · direct, no server in between" : status}
        </p>
        <button type="button" onClick={onMic} aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
          aria-pressed={!micOn} title={micOn ? "Mute" : "Unmute"}
          className={`grid h-9 w-9 place-items-center rounded-full transition-colors ${
            micOn ? "text-ink-2 hover:bg-veil/[0.07] hover:text-ink" : "bg-yang text-on-accent"}`}>
          <Ic d={micOn ? MIC_ON : MIC_OFF} />
        </button>
        <button type="button" onClick={onCam} aria-label={camOn ? "Turn camera off" : "Turn camera on"}
          aria-pressed={!camOn} title={camOn ? "Camera off" : "Camera on"}
          className={`grid h-9 w-9 place-items-center rounded-full transition-colors ${
            camOn ? "text-ink-2 hover:bg-veil/[0.07] hover:text-ink" : "bg-yang text-on-accent"}`}>
          <Ic d={camOn ? CAM_ON : CAM_OFF} />
        </button>
        <button type="button" onClick={() => setFull((f) => !f)} aria-label={full ? "Exit full screen" : "Full screen"}
          className="grid h-9 w-9 place-items-center rounded-full text-ink-2 transition-colors hover:bg-veil/[0.07] hover:text-ink">
          <Ic d={EXPAND} />
        </button>
        <button type="button" onClick={onHangup} aria-label="End call"
          className="grid h-9 w-11 place-items-center rounded-pill bg-yang text-on-accent transition-opacity hover:opacity-90">
          <Ic d={HANG} size={20} />
        </button>
      </div>
    </section>
  );
}

/**
 * The incoming-call banner, shown wherever the member happens to be.
 *
 * The server's ring beacon carries WHO is calling but nothing else — the offer itself is a sealed
 * message in the conversation. So "Answer" opens the thread, where the handshake is; that
 * indirection is not a limitation to route around, it is the reason a public database can hold
 * the fact of a call without holding the means to join one.
 */
export function IncomingCall({ name, avatar, onAnswer, onDismiss }: {
  name: string; avatar?: string; onAnswer: () => void; onDismiss: () => void;
}) {
  return (
    <div role="alert"
      className="pointer-events-auto flex items-center gap-3 rounded-card border border-yang/60 bg-space-2 px-3 py-2.5 shadow-card">
      <span className="relative shrink-0">
        {avatar
          ? <img src={avatar} alt="" className="h-10 w-10 rounded-full object-cover" />
          : <span className="grid h-10 w-10 place-items-center rounded-full bg-veil/[0.10] text-[15px] font-bold text-ink-2" data-ay-skip="1">{name.slice(0, 1)}</span>}
        <span className="absolute -inset-1 animate-ping rounded-full border border-yang/50" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-ink" data-ay-skip="1">{name}</span>
        <span className="block text-[11.5px] text-ink-3">is calling you</span>
      </span>
      <button type="button" onClick={onDismiss}
        className="rounded-pill border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink-3 hover:text-ink">Ignore</button>
      <button type="button" onClick={onAnswer}
        className="rounded-pill bg-yang px-3 py-1 text-[11.5px] font-bold text-on-accent hover:opacity-90">Answer</button>
    </div>
  );
}

/**
 * Said once, before a member's first call, and never again.
 *
 * A direct connection means the other person's device learns your IP address — that is what
 * "direct" is, not a defect in the implementation. A relay would hide it, and the relay is exactly
 * what was removed to stop a third party seeing the video. Both halves of that trade belong in
 * front of the person choosing, not in a source comment.
 */
export function CallPrivacyNote({ onAccept, onCancel, peerName }: {
  onAccept: () => void; onCancel: () => void; peerName: string;
}) {
  return (
    <div className="border-b border-line bg-veil/[0.04] px-4 py-3">
      <p className="text-[13px] font-semibold text-ink">Calls connect your two devices directly</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
        Nothing passes through ArtaQuest or anyone else, so nobody can see or hear a call — the same promise your
        messages carry. The cost of going direct is that{" "}
        <span data-ay-skip="1" className="font-semibold">{peerName}</span>
        <span>’s device will see your IP address, as yours will see theirs. Only call people you’re willing to share that with.</span>
      </p>
      <div className="mt-2.5 flex gap-2">
        <button type="button" onClick={onCancel}
          className="rounded-pill border border-line px-3 py-1 text-[12px] font-semibold text-ink-2 hover:text-ink">Not now</button>
        <button type="button" onClick={onAccept}
          className="rounded-pill bg-yang px-3.5 py-1 text-[12px] font-bold text-on-accent hover:opacity-90">Got it — call</button>
      </div>
    </div>
  );
}
