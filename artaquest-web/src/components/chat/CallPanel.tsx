import { useEffect, useRef, useState } from "react";
import type { CallMode, CallState, LinkReport } from "../../lib/webrtc";
import { Avatar } from "../ui";
import { nameClass } from "../../lib/fmt";
import { CALL_MODES, callModePref, linkShortfall, useVideoLive } from "./callmode";

/**
 * The call surface — two video elements and four buttons.
 *
 * There is no iframe and no third-party script here any more. Media arrives on a direct
 * peer-to-peer connection (see lib/webrtc.ts), so this component's whole job is to attach two
 * MediaStreams to two <video> elements and offer the controls.
 *
 * It is also where the two SHARED CALL-QUALITY COMPONENTS live — the mode chooser and the one
 * honest line about a link that has stopped carrying video. They sit here because this is the leaf
 * of the three call surfaces: the room mesh and the meeting's join panel import from here, and
 * nothing here imports from either. The plain functions behind them are in ./callmode, because a
 * non-component export beside a component breaks fast refresh for the whole file.
 *
 * ⚠️ `data-ay-skip="1"` on anything carrying the peer's name, for the same reason as every other
 * member string in this surface: the i18n mesh publishes what it can reach into the PUBLIC
 * aq_translations table (see the Messages.tsx header). Live NUMBERS are marked for the same
 * reason — a round-trip time is machine output, and one row per millisecond value is not a
 * translation memory, it is noise leaking into a public table.
 */

/**
 * The chooser.
 *
 * `compact` is the in-call form (a row of pills beside the other controls); the full form is the
 * one shown before joining, where there is room to say what each choice actually costs.
 */
export function CallModeChoice({ value, onChange, compact, suggested }: {
  value: CallMode;
  onChange: (m: CallMode) => void;
  compact?: boolean;
  /** Marked as suggested, so the default is visible as a recommendation rather than as a mystery. */
  suggested?: CallMode;
}) {
  if (compact) {
    return (
      <div role="radiogroup" aria-label="Call quality" className="flex flex-wrap gap-1.5">
        {CALL_MODES.map((m) => (
          <button key={m.value} type="button" role="radio" aria-checked={value === m.value}
            title={m.blurb} onClick={() => onChange(m.value)}
            className={`inline-flex h-10 items-center rounded-pill border px-3 text-[12.5px] font-semibold transition-colors ${
              value === m.value ? "border-yin bg-yin/15 text-yang" : "border-line text-ink-2 hover:border-yin-light hover:text-ink"}`}>
            {m.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label="How to join" className="flex flex-col gap-1.5">
      {CALL_MODES.map((m) => (
        <button key={m.value} type="button" role="radio" aria-checked={value === m.value}
          onClick={() => onChange(m.value)}
          className={`flex min-h-[44px] w-full items-start gap-2.5 rounded-card border px-3 py-2 text-start transition-colors ${
            value === m.value ? "border-yin bg-yin/10" : "border-line hover:border-yin-light"}`}>
          <span aria-hidden className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
            value === m.value ? "border-yang bg-yang" : "border-line"}`} />
          <span className="min-w-0">
            <span className="block text-[13.5px] font-semibold text-ink">
              {m.label}
              {suggested === m.value && (
                <span className="ms-1.5 align-middle text-[11px] font-semibold text-ink-3">suggested here</span>
              )}
            </span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-3">{m.blurb}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The honest line, with the numbers folded away behind it.
 *
 * Never a dialog and never an alarm: it is one sentence in the run of the controls, and the detail
 * is one press away for whoever wants it. The engine's own `reason` goes in the detail rather than
 * the headline — it is written for a member but it is not translated, and it can carry numbers.
 */
export function LinkNote({ link, mode, className }: {
  link: LinkReport | null | undefined; mode: CallMode; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const head = link ? linkShortfall(link, mode) : "";
  if (!link || !head) return null;
  return (
    <div className={`flex flex-col gap-1 ${className || ""}`}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-relaxed text-ink-2">
        <span aria-live="polite">{head}</span>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="shrink-0 font-semibold text-ink-3 underline underline-offset-2 hover:text-ink">
          {open ? "Hide the detail" : "Why"}
        </button>
      </p>
      {open && (
        <div className="rounded-card border border-line bg-veil/[0.04] px-2.5 py-2">
          {link.reason && <p className="text-[12px] leading-relaxed text-ink-2" data-ay-skip="1">{link.reason}</p>}
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
            <span data-ay-skip="1">{Math.round(link.rttMs)}</span> ms there and back
            {" · "}<span data-ay-skip="1">{link.lossPct.toFixed(1)}</span>% of packets lost
            {link.kbps > 0 && <>{" · "}<span data-ay-skip="1">{Math.round(link.kbps)}</span> kbit/s</>}
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
            There is no server in a call, so this is your own link to the device at the other end — nothing
            here can route around it
          </p>
        </div>
      )}
    </div>
  );
}

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
  state, local, remote, peerName, peerAvatar, micOn, camOn, onMic, onCam, onHangup,
  link, mode, onMode,
}: {
  state: CallState;
  local: MediaStream | null;
  remote: MediaStream | null;
  peerName: string;
  peerAvatar?: string;
  micOn: boolean;
  camOn: boolean;
  onMic: () => void;
  onCam: () => void;
  onHangup: () => void;
  /** The last report from Call's onLink. Optional: without it the panel simply says nothing about
   *  the link, which is what it did before there was anything to say. */
  link?: LinkReport | null;
  /** The member's standing preference, and the way to change it mid-call. Both optional together:
   *  the quality control only appears when the caller can actually act on it (Call.setMode). */
  mode?: CallMode;
  onMode?: (m: CallMode) => void;
}) {
  const [full, setFull] = useState(false);
  const [quality, setQuality] = useState(false);
  // What is arriving, as opposed to what was negotiated. A frozen last frame under a name is the
  // dishonest version of this, and it is what a black rectangle already looked like.
  const remoteVideo = useVideoLive(remote);
  // A caller that reports the link without managing the preference still gets an honest line: the
  // shortfall is measured against what this device would have asked for anyway.
  const [prefMode] = useState(callModePref);
  const effMode = mode ?? prefMode;
  const showQuality = !!onMode;

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
      <div className={`relative ${full ? "min-h-0 flex-1" : "h-[46vh] max-h-[300px] min-h-[220px] sm:h-[300px]"} w-full overflow-hidden bg-black/70`}>
        <Video stream={remote} label="The other person" className="h-full w-full" />
        {/* Nothing to show yet, or sound arriving with no picture behind it — either way, say which
            it is rather than leaving a black rectangle to be read as a broken call. */}
        {(!remote || !remoteVideo) && (
          <div className="absolute inset-0 grid place-items-center bg-black/70 px-6 text-center">
            <div>
              <span className="mx-auto mb-3 block w-fit" data-ay-skip="1">
                <Avatar src={peerAvatar} name={peerName} className="h-16 w-16" />
              </span>
              <p className="text-[15px] font-semibold text-ink" data-ay-skip="1">{peerName}</p>
              <p className="mt-1 text-[13px] text-ink-3">
                {!remote ? (status || "Starting…") : state === "live" ? "Sound only from their side" : (status || "Starting…")}
              </p>
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
        {local && local.getVideoTracks().length > 0 && (
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

      {/* The controls, and above them the only two things worth saying in words: what this call is,
          and — when it happens — why the picture went away. Both stay out of the way of the buttons
          rather than competing with them for a phone's width. */}
      <div className="flex flex-col gap-1.5 px-3 py-2">
        <p className="text-[12px] leading-relaxed text-ink-3" aria-live="polite">
          {state === "live" ? "Encrypted end-to-end · direct, no server in between" : status}
        </p>
        <LinkNote link={link} mode={effMode} />
        {showQuality && quality && (
          <div className="rounded-card border border-line bg-veil/[0.04] p-2.5">
            <CallModeChoice value={effMode} onChange={(m) => onMode?.(m)} compact />
            <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
              Sound is what a call is. Everything above trades picture for it, and none of it interrupts the call
            </p>
          </div>
        )}
        <div className="flex items-center gap-2">
          {/* 44px on a phone, because the alternative is a member trying to mute themselves twice.
              Desktop keeps the tighter 36px row it already had. */}
          <button type="button" onClick={onMic} aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
            aria-pressed={!micOn} title={micOn ? "Mute" : "Unmute"}
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors sm:h-9 sm:w-9 ${
              micOn ? "text-ink-2 hover:bg-veil/[0.07] hover:text-ink" : "bg-yang text-on-accent"}`}>
            <Ic d={micOn ? MIC_ON : MIC_OFF} />
          </button>
          <button type="button" onClick={onCam} aria-label={camOn ? "Turn camera off" : "Turn camera on"}
            aria-pressed={!camOn} title={camOn ? "Camera off" : "Camera on"}
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors sm:h-9 sm:w-9 ${
              camOn ? "text-ink-2 hover:bg-veil/[0.07] hover:text-ink" : "bg-yang text-on-accent"}`}>
            <Ic d={camOn ? CAM_ON : CAM_OFF} />
          </button>
          {showQuality && (
            <button type="button" onClick={() => setQuality((q) => !q)} aria-expanded={quality}
              className={`inline-flex h-11 shrink-0 items-center rounded-pill border px-3 text-[12.5px] font-semibold transition-colors sm:h-9 ${
                quality ? "border-yin bg-yin/15 text-yang" : "border-line text-ink-2 hover:border-yin-light hover:text-ink"}`}>
              Quality
            </button>
          )}
          <button type="button" onClick={() => setFull((f) => !f)} aria-label={full ? "Exit full screen" : "Full screen"}
            className="ms-auto grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-veil/[0.07] hover:text-ink sm:h-9 sm:w-9">
            <Ic d={EXPAND} />
          </button>
          <button type="button" onClick={onHangup} aria-label="End call"
            className="grid h-11 w-14 shrink-0 place-items-center rounded-pill bg-yang text-on-accent transition-opacity hover:opacity-90 sm:h-9 sm:w-11">
            <Ic d={HANG} size={20} />
          </button>
        </div>
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
      <span className="relative shrink-0" data-ay-skip="1">
        {/* The shared Avatar, not a bare <img>: it falls back to the member's initial when the URL
            is missing or fails to load, which a raw tag renders as a broken-image icon — reported
            from real use as "the profile picture of the person calling isn't showing". */}
        <Avatar src={avatar} name={name} className="h-10 w-10" />
        <span className="absolute -inset-1 animate-ping rounded-full border border-yang/50" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block font-semibold text-ink ${nameClass(name, 13)}`} data-ay-skip="1">{name}</span>
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
