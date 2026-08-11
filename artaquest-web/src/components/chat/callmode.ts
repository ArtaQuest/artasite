import { useEffect, useState } from "react";
import { suggestedMode, type CallMode, type LinkReport } from "../../lib/webrtc";

/**
 * What the member chose about a call, and how it is said.
 *
 * The three call surfaces — the 1:1 panel, the room mesh and the meeting's join panel — all need
 * the same four words and the same stored preference, and none of them may own it: a helper
 * exported beside a component breaks fast refresh for the whole file. So the plain functions live
 * here and the components that use them live in CallPanel.
 *
 * ONE preference, remembered per DEVICE rather than per call. Someone who joins a meeting from a
 * train and picks sound only is telling us about their morning, not about that meeting — asking
 * again at the next one is the chore. lib/webrtc's suggestedMode() supplies the first answer, so a
 * member who never thinks about any of this is never asked.
 */

const MODE_KEY = "aq_call_mode";

export const CALL_MODES: { value: CallMode; label: string; blurb: string }[] = [
  { value: "auto", label: "Match my connection", blurb: "Starts with video and drops it if the link can’t carry it" },
  { value: "audio", label: "Sound only", blurb: "The camera never opens — the lightest thing a phone can do" },
  { value: "low", label: "Small picture", blurb: "A small, slow picture that leaves room for the voice" },
  { value: "full", label: "Best picture", blurb: "As good as the connection will carry" },
];

function isMode(v: unknown): v is CallMode {
  return v === "auto" || v === "audio" || v === "low" || v === "full";
}

/** What this device SUGGESTS. It reads the network information API, and a browser without one must
 *  read as "no opinion" rather than as a thrown error. */
export function deviceSuggestedMode(): CallMode {
  try { return suggestedMode(); } catch { return "auto"; }
}

/** The member's standing choice: what they last picked on this device, or what the device suggests
 *  if they have never picked. Never throws — private mode makes localStorage itself throw. */
export function callModePref(): CallMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (isMode(v)) return v;
  } catch { /* private mode: fall through to the suggestion */ }
  return deviceSuggestedMode();
}

export function rememberCallMode(m: CallMode): void {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* private mode — the choice still applies to this call */ }
}

const RANK: Record<Exclude<CallMode, "auto">, number> = { audio: 0, low: 1, full: 2 };

/**
 * The one line, or nothing at all.
 *
 * Only a SHORTFALL is worth saying. A member who chose sound only already knows there is no
 * picture, and telling them again is noise; what needs saying is the case where the picture went
 * away ON ITS OWN, because that is the thing that reads as a broken app when it happens in silence.
 */
export function linkShortfall(l: LinkReport, mode: CallMode): string {
  // ASKING FOR SOUND ONLY AND GETTING IT IS NOT A SHORTFALL. This told every member who had
  // deliberately chosen sound only that their connection could not carry a picture — for the whole
  // call, about a picture they had turned off themselves. Blaming the network for the member's own
  // choice is the sort of untruth that teaches people to distrust the rest of the interface.
  const asked = mode === "auto" ? "full" : mode;
  if (asked === "audio") return "";
  if (RANK[l.sending] >= RANK[asked] && l.videoOn) return "";
  if (!l.videoOn || l.sending === "audio") return "Sound only for now — your connection can’t carry the picture as well";
  return "A smaller picture for now, so the voice keeps getting through";
}

/**
 * Is a picture ACTUALLY arriving on this stream?
 *
 * A tile must never claim a live camera it is not showing. `mute` and `unmute` fire on a RECEIVED
 * track when RTP stops and starts, which is exactly how a peer shedding video to protect its sound
 * reaches this side — with no message of our own and no renegotiation. Nothing fires when a track
 * is added programmatically (MediaStream.addTrack raises no event) or when the far end merely
 * disables its track, so a slow poll backs the events up rather than replacing them.
 */
export function useVideoLive(stream: MediaStream | null): boolean {
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!stream) { setLive(false); return; }
    let stopped = false;
    const read = () => {
      if (stopped) return;
      const t = stream.getVideoTracks()[0];
      setLive(!!t && t.readyState === "live" && !t.muted && t.enabled);
    };
    read();
    const track = stream.getVideoTracks()[0];
    track?.addEventListener("mute", read);
    track?.addEventListener("unmute", read);
    track?.addEventListener("ended", read);
    const iv = window.setInterval(read, 1500);
    return () => {
      stopped = true;
      window.clearInterval(iv);
      track?.removeEventListener("mute", read);
      track?.removeEventListener("unmute", read);
      track?.removeEventListener("ended", read);
    };
  }, [stream]);
  return live;
}
