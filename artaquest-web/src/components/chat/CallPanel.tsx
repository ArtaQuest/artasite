import { useEffect, useMemo, useRef, useState } from "react";
import { currentUser } from "../../lib/wp";

/**
 * ArtaChat video calls — a Jitsi room, embedded.
 *
 * WHERE THE PRIVACY LINE IS, exactly, because it is not the same line as the messages:
 *
 *  • The ROOM NAME never reaches ArtaQuest. It is 160 bits generated in the caller's browser
 *    (lib/e2ee newCallRoom) and sent only inside the sealed invite message, so our own database —
 *    which is public — cannot be used to find, join or even name anybody's call. The ring beacon
 *    the server does hold says "somebody is calling you", and nothing else.
 *  • The CALL MEDIA is not ours and is not end-to-end encrypted by our construction. It is carried
 *    by meet.jit.si under their terms, hop-by-hop encrypted, with Jitsi's own optional E2EE
 *    available inside the call UI. The panel says so in plain words, every time, because a member
 *    who has just been told their messages are sealed will otherwise reasonably assume the video is
 *    too. Overclaiming that would be worse than not having calls.
 *
 * Deliberately an <iframe> and not Jitsi's external_api.js: the JS API would run a third party's
 * script inside our origin (and needs a script-src grant) to buy us a hangup event we can live
 * without. One frame-src origin, no third-party JS. See the CSP note in theme functions.php.
 *
 * The iframe's `allow` is the INNER of two gates — the outer is the site's Permissions-Policy
 * header, which must name meet.jit.si too. Miss either and the call joins with a dead camera and
 * no error message anybody can see.
 */

export function CallPanel({ room, host, peerName, onEnd }: {
  room: string; host: string; peerName: string; onEnd: () => void;
}) {
  const [full, setFull] = useState(false);
  const [joined, setJoined] = useState(false);
  const frame = useRef<HTMLIFrameElement | null>(null);

  // Display name is a convenience for the other participant, not identity — Jitsi is told what to
  // print above the tile and nothing else. No email, no member id, no avatar URL.
  const src = useMemo(() => {
    const me = currentUser();
    const cfg = [
      "config.prejoinPageEnabled=false",
      "config.disableDeepLinking=true",
      "config.startWithAudioMuted=false",
      "config.startWithVideoMuted=false",
      "interfaceConfig.MOBILE_APP_PROMO=false",
      "interfaceConfig.SHOW_JITSI_WATERMARK=false",
      "interfaceConfig.SHOW_CHROME_EXTENSION_BANNER=false",
      me?.name ? `userInfo.displayName="${encodeURIComponent(me.name)}"` : "",
    ].filter(Boolean);
    return `https://${host}/${encodeURIComponent(room)}#${cfg.join("&")}`;
  }, [room, host]);

  // Leaving the page mid-call should not leave a silent open microphone behind: dropping the
  // iframe is what actually stops the tracks, so unmount is the hangup.
  useEffect(() => () => { if (frame.current) frame.current.src = "about:blank"; }, []);

  return (
    <section
      className={full
        ? "fixed inset-0 z-[90] flex flex-col bg-space-1"
        : "flex flex-col overflow-hidden border-b border-line bg-space-1"}
      aria-label="Video call">
      <header className="flex items-center gap-2 px-3 py-2">
        <span className="flex h-2 w-2 shrink-0 animate-pulse rounded-full bg-yang" aria-hidden />
        {/* The peer's name is member-controlled text — it must stay off the i18n mesh like every
            other member string in this surface (see the Messages.tsx header). */}
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink" data-ay-skip="1">{peerName}</p>
        <button type="button" onClick={() => setFull((f) => !f)}
          className="rounded-pill border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink-2 hover:border-yin-light hover:text-ink">
          {full ? "Exit full screen" : "Full screen"}
        </button>
        <button type="button" onClick={onEnd}
          className="rounded-pill bg-yang px-3 py-1 text-[11.5px] font-bold text-on-accent hover:opacity-90">
          Leave
        </button>
      </header>
      <iframe
        ref={frame}
        title="Video call"
        src={src}
        onLoad={() => setJoined(true)}
        allow="camera; microphone; display-capture; autoplay; fullscreen; speaker-selection"
        className={full ? "min-h-0 w-full flex-1 border-0" : "h-[320px] w-full border-0"} />
      <p className="px-3 py-1.5 text-[11px] leading-relaxed text-ink-3">
        {joined ? "" : "Connecting… "}
        This call runs on {host}, not on ArtaQuest — the video is encrypted in transit but it is not sealed
        to your device the way your messages are. The room name is random and was sent only inside your
        encrypted conversation, so nobody can find it from our public database.
      </p>
    </section>
  );
}

/**
 * The incoming-call banner, shown wherever the member happens to be.
 *
 * The ring arrives on the badge poll, which carries WHO is calling but not the room — so "Answer"
 * cannot dial straight in. It opens the conversation, where the sealed invite (and therefore the
 * room) actually is. That indirection is not a limitation to work around; it is the reason the
 * server can be public.
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
