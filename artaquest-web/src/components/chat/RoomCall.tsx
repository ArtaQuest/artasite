import { useEffect, useRef, useState } from "react";
import { roomsCall, roomsMessages, roomsSend, type Room } from "../../lib/api";
import {
  decodePayload, encodePayload, openRoomMessage, sealRoomMessage,
  type ChatPayload,
} from "../../lib/e2ee";
import {
  Call, callSupported, mediaErrorMessage, newCallSid, openCallMedia,
  type CallMode, type LinkReport,
} from "../../lib/webrtc";
import { WINDOW, elect, publishAnchor, score as linkScore, type Sample, type ScoreTable } from "../../lib/anchor";
import { Avatar } from "../ui";
import { CallModeChoice, LinkNote } from "./CallPanel";
import { callModePref, deviceSuggestedMode, rememberCallMode, useVideoLive } from "./callmode";
import { Whiteboard, type Ping, type Stroke } from "./Whiteboard";

/**
 * A group call — a MESH, with no server anywhere in it.
 *
 * Every participant holds one peer connection PER other participant, so the media still goes
 * directly between people exactly as a 1:1 call does (lib/webrtc). There is no bridge to relay it
 * and nobody in the middle, which is the whole reason group calling could be added at all without
 * standing up a server that would see everyone's camera.
 *
 * WHAT THAT COSTS, and why the cap is real: N people is N(N-1)/2 connections, and each person
 * uploads their camera N-1 separate times. Five is about where an ordinary home uplink stops
 * coping, which is why Rooms::MESH_MAX is five and not fifty. Going beyond needs an SFU — a server
 * that decrypts and re-sends the media — i.e. the thing this design exists to avoid.
 *
 * THE OTHER HALF OF THAT COST IS THE DECODER, and it is this component's problem rather than the
 * engine's. Uploading four cameras is what a bad uplink cannot do; DECODING four cameras is what a
 * phone cannot do — four H.264 streams, four <video> compositors and four sets of frames landing
 * every 40ms, on the same silicon that is also encoding your own. So the grid shows only as many
 * remote cameras as the device can honestly carry (`decodeBudget`), gives the picture to WHOEVER IS
 * TALKING, and says plainly that the rest are sound only. A tile with no live video never sits
 * behind a frozen frame pretending otherwise: it goes to an <audio> element, which decodes no video
 * at all, and shows an avatar.
 *
 * GLARE. Two peers who both offer at the same moment end up with two half-negotiated connections
 * and no call. The tie-break is arithmetic rather than timing: THE LOWER USER ID OFFERS, the higher
 * one waits and answers. No negotiation about who negotiates.
 *
 * SIGNALLING rides the room's own sealed messages, so a handshake is as private as the conversation
 * — and `to` addresses each offer at one participant, since in a mesh "an offer" is never for
 * everybody. It is also SLOW and expensive: every signalling message is a sealed row and a poll
 * interval. NOTHING a member touches here is allowed to need one. Quality is `setMode` (encoder
 * parameters); the camera going off is a track stopping inside a sender that stays; the camera
 * coming back is `replaceTrack` into the sendrecv video transceiver the engine negotiates up front
 * for exactly this reason — even for someone who joined with sound only.
 */

type Peer = { uid: number; call: Call; stream: MediaStream | null; state: string };

/** Re-opening a camera part-way through a call, when the shared stream has only a microphone in
 *  it. A modest starting request: the engine reshapes the track to the mode it is actually sending
 *  at (`shapeCapture`, driven from setMode below), so this only has to be sane, not exact. */
const CAM: MediaTrackConstraints = {
  width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 },
};

/** The three sending modes in order, for "which of these is the better one". */
const RUNG: Record<Exclude<CallMode, "auto">, number> = { audio: 0, low: 1, full: 2 };

/** Root-mean-square level above which a voice counts as talking, and how long a new voice has to
 *  hold the floor before it takes the big tile. A picture that swaps on every syllable is worse
 *  than one that does not move at all. */
/** Older than this and the roster is UNKNOWN rather than unchanged — three missed 4s polls. */
const ROSTER_STALE_MS = 12000;

const SPEAK_MIN = 0.045;
const SPEAK_HOLD_MS = 1200;

/**
 * How many remote cameras this device should DECODE at once.
 *
 * Deliberately pessimistic, and deliberately not clever: every input here is a fact the browser
 * hands over for free, and each one that is missing is treated as "no opinion" rather than as
 * permission. iOS reports no deviceMemory at all, so nothing may depend on it being there.
 */
function decodeBudget(peers: number, mode: CallMode, sending: Exclude<CallMode, "auto">, wide: boolean): number {
  if (peers <= 0) return 0;
  // They asked for a call, not a gallery. Sound only means sound only in both directions — which is
  // the whole reason it saves a phone's battery rather than just its uplink.
  if (mode === "audio") return 0;
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  const conn = nav.connection;
  if (conn?.saveData === true) return Math.min(1, peers);
  if (conn?.effectiveType === "2g" || conn?.effectiveType === "slow-2g") return Math.min(1, peers);
  // The engine has already refused to send our own camera. Decoding a gallery on the same link is
  // not the thing to spend the recovery on.
  if (sending === "audio") return Math.min(1, peers);
  const cores = nav.hardwareConcurrency || 0;
  const mem = nav.deviceMemory;
  const modest = (cores > 0 && cores <= 4) || (mem !== undefined && mem <= 4);
  let n = wide ? 4 : 2;
  if (sending === "low") n = Math.min(n, 2);
  if (modest) n = Math.min(n, wide ? 3 : 2);
  return Math.min(n, peers);
}

/**
 * WHO IS TALKING, read from the audio itself.
 *
 * There is no server to tell us, and `RTCRtpReceiver.getSynchronizationSources()` would mean
 * reaching inside the peer connection the engine owns. A Web Audio tap on the MediaStream is the
 * cheap, portable answer: one AnalyserNode per peer, sampled five times a second, connected to
 * NOTHING — the media element is what plays the sound, and connecting a tap to the destination
 * would play it a second time.
 *
 * It degrades to silence rather than to an error: an AudioContext that iOS refuses to resume simply
 * reports no levels, and the grid falls back to roster order.
 */
function useSpeakers(entries: { uid: number; stream: MediaStream | null }[], enabled: boolean) {
  const [speaking, setSpeaking] = useState<number[]>([]);
  const [speaker, setSpeaker] = useState(0);
  const key = entries.map((e) => `${e.uid}:${e.stream?.id || ""}`).join(",") + (enabled ? "|on" : "|off");
  const streams = useRef(entries);
  streams.current = entries;

  useEffect(() => {
    if (!enabled) { setSpeaking([]); setSpeaker(0); return; }
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext;
    try { ctx = new Ctor(); } catch { return; }
    void ctx.resume?.().catch(() => undefined); // iOS starts suspended; joining was the gesture

    const taps: { uid: number; src: MediaStreamAudioSourceNode; an: AnalyserNode }[] = [];
    for (const e of streams.current) {
      if (!e.stream || e.stream.getAudioTracks().length === 0) continue;
      try {
        const src = ctx.createMediaStreamSource(e.stream);
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        src.connect(an);
        taps.push({ uid: e.uid, src, an });
      } catch { /* a browser that will not tap this stream — one quiet tile, not a failure */ }
    }
    if (taps.length === 0) { void ctx.close().catch(() => undefined); return; }

    const buf = new Uint8Array(taps[0].an.fftSize);
    const level: Record<number, number> = {};
    let held = 0;
    let candidate = 0;
    let since = 0;

    const iv = window.setInterval(() => {
      let best = 0;
      let bestLevel = SPEAK_MIN;
      const loud: number[] = [];
      for (const t of taps) {
        t.an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const smoothed = (level[t.uid] || 0) * 0.6 + rms * 0.4;
        level[t.uid] = smoothed;
        if (smoothed > SPEAK_MIN) loud.push(t.uid);
        if (smoothed > bestLevel) { bestLevel = smoothed; best = t.uid; }
      }
      // Only a CHANGE is worth a render. A steady conversation would otherwise redraw the whole
      // call five times a second, video elements and all, to say nothing new.
      setSpeaking((cur) => (cur.join(",") === loud.join(",") ? cur : loud));
      const now = Date.now();
      if (best && best !== held) {
        if (candidate !== best) { candidate = best; since = now; }
        else if (now - since >= SPEAK_HOLD_MS) { held = best; candidate = 0; setSpeaker(best); }
      } else {
        candidate = 0;
      }
    }, 200);

    return () => {
      window.clearInterval(iv);
      for (const t of taps) { try { t.src.disconnect(); t.an.disconnect(); } catch { /* already gone */ } }
      void ctx.close().catch(() => undefined);
    };
    // `key` is the identity of the set of streams being listened to — the entries array itself is
    // rebuilt every render and would restart the analysers on every tick.
  }, [key, enabled]);

  return { speaking, speaker };
}

export function RoomCall({ room, roomKey, me, onLeft }: {
  room: Room;
  roomKey: CryptoKey | null;
  me: number;
  onLeft: () => void;
}) {
  const [peers, setPeers] = useState<Record<number, Peer>>({});
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [pings, setPings] = useState<Ping[]>([]);
  const camTrack = useRef<MediaStreamTrack | null>(null);
  /**
   * THE STAGE. A teaching session is not a strip of video beside a chat — it is one thing you are
   * all looking at, with faces around it. `focus` expands the call to the whole screen; `view`
   * decides what the middle is. Everything else (the tools) is a sealed payload, which is what
   * keeps the set open-ended: another tool is one more variant and one more button.
   */
  const [focus, setFocus] = useState(false);
  const [view, setView] = useState<"grid" | "board" | "screen">("grid");
  const [hands, setHands] = useState<Record<number, boolean>>({});
  const [timerEnds, setTimerEnds] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /**
   * WHAT WE SEND, and what the link says about it.
   *
   * `mode` is the member's PREFERENCE and may be "auto"; it comes in from the choice they made
   * before joining (CallPanel.callModePref, written by the meeting's join panel) so that someone
   * who picked sound only on a train is not asked again at the door. `links` is the engine's own
   * account of each connection — one report per peer, because in a mesh a bad link is a bad link
   * to ONE person, not to the room.
   */
  const [mode, setMode] = useState<CallMode>(callModePref);
  const [suggested] = useState(deviceSuggestedMode);
  const modeRef = useRef(mode);
  const [links, setLinks] = useState<Record<number, LinkReport>>({});
  /** What every participant says about their own link, including us. The table an election reads. */
  /** What every participant says about their own link. A REF, not state: nothing on screen shows
   *  it, so a score arriving from a fifth peer has no business re-rendering the call. */
  const scores = useRef<ScoreTable>({});
  /** Our own recent samples, which is what we publish a score from. */
  const samples = useRef<Sample[]>([]);
  /** Who carries the shared work, and how long a challenger has been ahead — see lib/anchor.ts. */
  /** The incumbent. A ref, so re-electing does not tear down and rebuild the beat it runs on. */
  const anchorRef = useRef(0);
  const held = useRef(0);
  // Is a picture actually leaving this device? Every peer connection agrees on this, so any of
  // them can answer; with no connections yet, nothing has been shed.
  const sendingVideo = Object.values(links).every((l) => l.videoOn !== false);
  const [pins, setPins] = useState<number[]>([]);
  const [quality, setQuality] = useState(false);
  const [more, setMore] = useState(false);
  const calls = useRef(new Map<number, Call>());
  const seen = useRef(new Set<number>());
  const media = useRef<MediaStream | null>(null);
  const lastSig = useRef(0);
  const sid = useRef(newCallSid());
  /** The session id each peer is CURRENTLY offering under. A different one from the same person
   *  means they threw their side away and built a new one — a reload fast enough that the roster
   *  never noticed — and the connection we are holding for them is dead. */
  const remoteSid = useRef(new Map<number, string>());

  /** Two columns of tiles or four — read once and on resize, never per render. */
  const [wide, setWide] = useState(() => {
    try { return window.matchMedia("(min-width: 640px)").matches; } catch { return true; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia("(min-width: 640px)"); } catch { return; }
    const on = () => setWide(mq.matches);
    on();
    // Safari only grew addEventListener on MediaQueryList in 14 — the deprecated form is the
    // fallback, not the other way round.
    if (mq.addEventListener) { mq.addEventListener("change", on); return () => mq.removeEventListener("change", on); }
    mq.addListener(on);
    return () => mq.removeListener(on);
  }, []);

  // The roster from OUR OWN refresh takes precedence over the parent's slower poll.
  const [roster, setRoster] = useState<number[]>(room.in_call);
  /** When the roster last actually ANSWERED — not when we last asked. See the prune loop. */
  const rosterOkAt = useRef(Date.now());
  /** What we were sending before the tab hid, so returning restores the member's pick. */
  const hiddenFrom = useRef<CallMode | null>(null);
  useEffect(() => { setRoster((cur) => (cur.join() === room.in_call.join() ? cur : room.in_call)); }, [room.in_call]);
  const others = roster.filter((u) => u !== me);


  /**
   * PUBLISH WHAT OUR LINK IS DOING, AND WORK OUT WHO SHOULD CARRY THE SHARED WORK.
   *
   * Every participant sends its own score into the room and every participant reads the same table,
   * so the election needs no proposal, no vote and no coordinator that could itself be the thing
   * that fails. The rule lives in lib/anchor.ts, which is pure precisely so it can be tested: steady
   * beats fast, an unproven link is not a candidate, a quiet one stops being one, and a challenger
   * has to be clearly better for several rounds running before anything moves.
   */
  useEffect(() => {
    if (!roomKey || !me) return;
    let stop = false;
    const beat = window.setInterval(() => {
      if (stop) return;
      const mine = linkScore(samples.current);
      scores.current[me] = { score: mine, at: Date.now() };
      if (mine > 0) void signal({ v: 2, t: "link", score: mine });
      const r = elect(scores.current, anchorRef.current, held.current, Date.now());
      held.current = r.held;
      anchorRef.current = r.anchor;
      // Published for the meeting page's distribution loop — see lib/anchor.ts.
      publishAnchor(room.id, r.anchor);
      // TWENTY SECONDS, NOT FIVE. The election deliberately moves slowly — a challenger must lead
      // for three rounds — so sampling four times as often buys no faster a decision, and every beat
      // is a sealed write competing for the same per-minute room budget as whiteboard strokes and
      // the call handshake itself.
    }, 20000);
    return () => { stop = true; window.clearInterval(beat); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey, me, room.id]);

  /* NOTHING IS SHOWN ABOUT THE ANCHOR, deliberately. Who carries the shared work is not a fact a
     member needs on screen — it changes on its own, it means nothing they can act on, and a line
     naming somebody invites the reading that the others are somehow lesser. It is published to
     lib/anchor.ts, where the code that does the work reads it, and that is the whole of its job. */

  /** Seal one signalling payload into the room, addressed at one participant. */
  async function signal(p: ChatPayload) {
    if (!roomKey) return;
    const sealed = await sealRoomMessage(roomKey, encodePayload(p), room.id, me);
    // notify 0: a handshake must never ring anybody's bell.
    await roomsSend(room.id, { ...sealed, notify: 0 }).catch(() => undefined);
  }

  /**
   * Open the camera and microphone ONCE and share them across every peer connection.
   *
   * Capture belongs to the engine (`openCallMedia`) even though the stream belongs to us: it knows
   * what each mode is worth asking a camera for, and it insists where a phone has answered a polite
   * request for 320×180 with 720p. In sound-only mode the camera is never opened at all — that is
   * the difference between a promise and a setting, and it is why the hardware light stays off.
   */
  async function localMedia(): Promise<MediaStream | null> {
    if (media.current) return media.current;
    try {
      const s = await openCallMedia(modeRef.current);
      media.current = s;
      setLocal(s);
      setCamOn(s.getVideoTracks().length > 0);
      return s;
    } catch (e) {
      setErr(mediaErrorMessage(e));
      return null;
    }
  }

  /**
   * SCREEN SHARING — replace the outgoing video track, do not renegotiate.
   *
   * `replaceTrack` swaps what each existing sender is transmitting without a new offer/answer, so
   * sharing starts instantly and does not risk a fresh handshake failing mid-call. The camera track
   * is kept so stopping the share can put it straight back; the browser's own "stop sharing" button
   * fires `onended`, which must be honoured or the call would keep claiming to share a dead track.
   */
  /** Whether this browser can share a screen at all — false on every iPhone. */
  const canShare = typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getDisplayMedia === "function";

  async function toggleShare() {
    if (sharing) { await stopShare(); return; }
    try {
      const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screen = disp.getVideoTracks()[0];
      if (!screen) return;
      camTrack.current = media.current?.getVideoTracks()[0] ?? null;
      for (const c of calls.current.values()) c.replaceVideo(screen);
      // Show the shared screen in our own tile too, so we can see what everyone else is seeing.
      if (media.current) {
        media.current.getVideoTracks().forEach((t) => media.current?.removeTrack(t));
        media.current.addTrack(screen);
        setLocal(new MediaStream(media.current.getTracks()));
      }
      screen.onended = () => { void stopShare(); };
      setSharing(true);
    } catch (e) {
      // ONLY A DISMISSAL IS NOT AN ERROR. Everything used to be swallowed here, so a browser that
      // cannot share at all — every iPhone — gave a button that did nothing, forever, with no
      // explanation, and a genuine failure looked exactly the same as a change of mind. A swallowed
      // error hiding a real refusal is a wound this codebase already carries once.
      if ((e as { name?: string })?.name !== "NotAllowedError") setErr(mediaErrorMessage(e));
    }
  }

  async function stopShare() {
    const cam = camTrack.current;
    for (const c of calls.current.values()) if (cam) c.replaceVideo(cam);
    if (media.current) {
      media.current.getVideoTracks().forEach((t) => { if (t !== cam) { t.stop(); media.current?.removeTrack(t); } });
      if (cam) media.current.addTrack(cam);
      setLocal(new MediaStream(media.current.getTracks()));
    }
    setSharing(false);
  }

  /** A connection to one participant, created once. */
  function peerFor(uid: number): Call {
    const have = calls.current.get(uid);
    if (have && !have.closed) return have;
    // The mode goes in at CONSTRUCTION rather than through setMode afterwards: setMode is a
    // member's deliberate act and resets the automatic ladder, which is not what a new connection
    // to a fifth participant means.
    const c = new Call(sid.current + ":" + uid, {
      onState: (st) => setPeers((cur) => (cur[uid] ? { ...cur, [uid]: { ...cur[uid], state: st } } : cur)),
      onRemote: (stream) => setPeers((cur) => (cur[uid] ? { ...cur, [uid]: { ...cur[uid], stream } } : cur)),
      onLocal: () => {},
      onLink: (r) => {
        setLinks((cur) => (same(cur[uid], r) ? cur : { ...cur, [uid]: r }));
        // Our own outgoing link, sampled from whichever connection reported. In a mesh these are
        // separate paths, so the WORST of them is the honest description of what we can promise —
        // an anchor has to reach everybody, not just its best-connected neighbour.
        samples.current = [...samples.current.slice(-(WINDOW - 1)),
          { kbps: r.kbps, lossPct: r.lossPct, rttMs: r.rttMs, shed: r.videoOn === false }];
      },
    }, modeRef.current);
    calls.current.set(uid, c);
    setPeers((cur) => ({ ...cur, [uid]: { uid, call: c, stream: null, state: "connecting" } }));
    return c;
  }

  /** Hand a call the member's preference. Wrapped because a browser without the encoding API is
   *  supposed to lose the ceiling, not the call. */
  function tellCall(c: Call, m: CallMode) {
    try { c.setMode(m); } catch { /* no encoding control here — the call still runs */ }
  }

  /**
   * Change what we send, mid-call — and NOTHING here costs a handshake.
   *
   * That is the whole design: signalling is a sealed message and a poll interval, so a quality
   * control that renegotiated would take seconds to obey and could fail. `setMode` is encoder
   * parameters; turning the camera off is stopping a track its sender keeps; turning it back on is
   * `replaceTrack` into the sendrecv video transceiver the engine negotiates up front for exactly
   * this. Even a member who joined with sound only has that sender waiting.
   */
  /**
   * A HIDDEN TAB SENDS NO PICTURE.
   *
   * Holding a phone's screen awake through a call is only defensible if we stop encoding N−1 copies
   * of a camera nobody is looking at. Dropping to the audio rung costs no renegotiation — the
   * quality ladder already swaps the track for null — and coming back restores the member's OWN
   * stored choice, never the device suggestion, or somebody who picked full video would be quietly
   * demoted every time they checked a notification.
   */
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        if (modeRef.current !== "audio") { hiddenFrom.current = modeRef.current; applyMode("audio"); }
      } else if (hiddenFrom.current) {
        const back = hiddenFrom.current;
        hiddenFrom.current = null;
        applyMode(back);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyMode(next: CallMode) {
    if (next === modeRef.current) { setQuality(false); return; }
    modeRef.current = next;
    setMode(next);
    rememberCallMode(next);
    for (const c of calls.current.values()) tellCall(c, next);
    const hasCam = !!media.current?.getVideoTracks().length;
    if (next !== "audio" && !hasCam) void addCamera();
    else if (next === "audio" && hasCam) dropCamera();
  }

  /** Sound only: stop the camera track outright. A stopped track leaves its sender in place, so the
   *  uplink is genuinely idle AND the hardware light is genuinely off. */
  function dropCamera() {
    if (sharing) void stopShare();
    const s = media.current;
    if (!s) return;
    s.getVideoTracks().forEach((t) => { t.stop(); s.removeTrack(t); });
    camTrack.current = null;
    setLocal(new MediaStream(s.getTracks()));
    setCamOn(false);
  }

  /** The camera again, into senders that already exist — no offer, no answer, no waiting. The
   *  track is added to the stream every Call already holds, and the second setMode is what makes
   *  the engine shape the fresh track to the mode it is sending at. */
  async function addCamera() {
    const s = media.current;
    if (!s) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: false, video: CAM });
      const track = fresh.getVideoTracks()[0];
      if (!track) return;
      s.getVideoTracks().forEach((t) => { t.stop(); s.removeTrack(t); });
      s.addTrack(track);
      for (const c of calls.current.values()) { c.replaceVideo(track); tellCall(c, modeRef.current); }
      setLocal(new MediaStream(s.getTracks()));
      setCamOn(true);
    } catch (e) {
      setErr(mediaErrorMessage(e));
    }
  }

  // Join the roster, and keep it warm — the beacon expires, so it must be refreshed.
  /**
   * KEEP THE SCREEN AWAKE, AND TAKE THE LOCK BACK.
   *
   * A phone that locks mid-call suspends its timers, drops the roster poll and the presence beacon
   * with it, and returns to peers that have expired it and a roster it could not read. The lock is
   * the cheapest half of that fix. The browser RELEASES it whenever the page hides, so it must be
   * re-requested on the way back — requested once, it is a lock held only until the first
   * notification. Absent on older iOS Safari, where it must degrade in silence rather than announce
   * a capability nobody asked about.
   */
  useEffect(() => {
    type Sentinel = { release: () => Promise<void> };
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Sentinel> } };
    if (!nav.wakeLock) return;
    let held: Sentinel | null = null;
    let dead = false;
    const take = () => {
      if (dead || document.visibilityState !== "visible") return;
      nav.wakeLock?.request("screen").then((sn) => { if (dead) void sn.release(); else held = sn; }).catch(() => undefined);
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      dead = true;
      document.removeEventListener("visibilitychange", take);
      void held?.release().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!callSupported()) { setErr("This browser can’t make calls."); return; }
    void localMedia();
    void roomsCall(room.id, "join").then((r) => { rosterOkAt.current = Date.now(); setRoster(r.in_call); }).catch(() => undefined);
    // Every 4s, not 12: this both refreshes the beacon AND returns the roster, which is what tells
    // us there is somebody new to offer a connection to. At 12s a third person joining a call took
    // long enough to look broken.
    const t = setInterval(() => { void roomsCall(room.id, "join").then((r) => { rosterOkAt.current = Date.now(); setRoster(r.in_call); }).catch(() => undefined); }, 4000);
    // Captured here rather than read in the cleanup: by teardown the ref may point somewhere else,
    // and closing the WRONG map would leave a camera running.
    const open = calls.current;
    const mine = media;
    return () => {
      clearInterval(t);
      void roomsCall(room.id, "leave");
      // Closing every connection is what actually releases the camera and microphone.
      open.forEach((c) => c.close());
      open.clear();
      mine.current?.getTracks().forEach((t2) => t2.stop());
      mine.current = null;
    };
  }, [room.id]);

  // OFFER to everyone below me in uid order; WAIT for everyone above. That is the whole glare rule.
  useEffect(() => {
    if (!roomKey) return;
    for (const uid of others) {
      if (me > uid) continue;                      // they will offer to me
      if (calls.current.has(uid)) continue;
      void (async () => {
        const s = await localMedia();
        if (!s) return;
        const c = peerFor(uid);
        try {
          const sdp = await c.offer(true, s);
          await signal({ v: 2, t: "rtc", kind: "offer", sid: c.sid, sdp, to: uid });
        } catch (e) { setErr(mediaErrorMessage(e)); }
      })();
    }
    // SOMEBODY LEFT — or we simply could not ask. Both roster reads swallow their failure, so a
    // phone that locks its screen for thirty seconds comes back with a roster that is not merely
    // stale but IDENTICAL, and this loop would tear down every peer on the strength of an answer
    // nobody gave. A gate that cannot read its signal must abstain rather than assume the cheerful
    // case: holding a dead connection a few seconds longer costs a tile, dropping a live one costs
    // the call.
    const rosterFresh = Date.now() - rosterOkAt.current < ROSTER_STALE_MS;
    for (const [uid, c] of rosterFresh ? calls.current : []) {
      if (!others.includes(uid)) {
        c.close();
        calls.current.delete(uid);
        remoteSid.current.delete(uid);
        setPeers((cur) => { const n = { ...cur }; delete n[uid]; return n; });
        setLinks((cur) => { const n = { ...cur }; delete n[uid]; return n; });
        setPins((cur) => (cur.includes(uid) ? cur.filter((u) => u !== uid) : cur));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [others.join(","), roomKey]);

  // Read the room's signalling — the same rows the thread reads, opened with the same key.
  useEffect(() => {
    if (!roomKey) return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const page = await roomsMessages(room.id, lastSig.current ? { after: lastSig.current } : {});
        if (stop) return;
        const items = lastSig.current ? page.items : [...page.items].reverse();
        for (const m of items) {
          lastSig.current = Math.max(lastSig.current, m.id);
          if (m.sender === me || seen.current.has(m.id)) continue;
          seen.current.add(m.id);
          const plain = await openRoomMessage(roomKey, m.iv, m.ct, room.id, m.sender);
          if (plain === null) continue;
          const p = decodePayload(plain);
          if (p.t === "draw") {
            // The board is shared state, so a stroke from anybody applies to everybody.
            if (p.clear) setStrokes([]);
            else if (p.undo) setStrokes((cur) => {
              // Undo removes the SENDER'S own last stroke, never somebody else's work.
              const i = [...cur].reverse().findIndex((st) => st.by === m.sender);
              return i < 0 ? cur : cur.filter((_, j) => j !== cur.length - 1 - i);
            });
            else if (p.stroke) setStrokes((cur) => [...cur, { ...(p.stroke as Stroke), by: m.sender }]);
            continue;
          }
          if (p.t === "point") { setPings((cur) => [...cur.slice(-6), { x: p.x, y: p.y, at: Date.now(), by: m.sender }]); continue; }
          if (p.t === "hand") { setHands((cur) => ({ ...cur, [m.sender]: p.up })); continue; }
          if (p.t === "timer") { setTimerEnds(p.ends); continue; }
          if (p.t === "link") { scores.current[m.sender] = { score: p.score, at: Date.now() }; continue; }
          if (p.t !== "rtc" || p.to !== me) continue;   // in a mesh, an offer is for ONE person
          if (p.kind === "offer" && p.sdp) {
            // A DIFFERENT session id from the same person means the connection we hold for them is
            // already dead — they reloaded, fast enough that the roster never noticed. Answering on
            // it would be a second offer into a settled peer connection, which is fatal; drop it.
            const known = remoteSid.current.get(m.sender);
            if (known && known !== p.sid) {
              calls.current.get(m.sender)?.close();
              calls.current.delete(m.sender);
              setPeers((cur) => { const n = { ...cur }; delete n[m.sender]; return n; });
              setLinks((cur) => { const n = { ...cur }; delete n[m.sender]; return n; });
            }
            remoteSid.current.set(m.sender, p.sid);
            const s = await localMedia();
            if (!s) continue;
            const c = peerFor(m.sender);
            const answer = await c.answer(p.sdp, true, s).catch(() => null);
            if (answer) await signal({ v: 2, t: "rtc", kind: "answer", sid: p.sid, sdp: answer, to: m.sender });
          } else if (p.kind === "answer" && p.sdp) {
            await calls.current.get(m.sender)?.accept(p.sdp).catch(() => undefined);
          } else if (p.kind === "bye") {
            calls.current.get(m.sender)?.close();
            calls.current.delete(m.sender);
            remoteSid.current.delete(m.sender);
            setPeers((cur) => { const n = { ...cur }; delete n[m.sender]; return n; });
            setLinks((cur) => { const n = { ...cur }; delete n[m.sender]; return n; });
          }
        }
      } catch { /* transient */ }
    }, 1500);
    return () => { stop = true; clearInterval(t); };
    // peerFor and signal are rebuilt every render. Listing them would tear down and re-subscribe
    // the signalling poll on every state change — which drops offers mid-handshake, and is the one
    // thing this loop must never do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, roomKey, me]);

  // The countdown ticks only while there IS one — no idle interval on a call that has no timer.
  useEffect(() => {
    if (!timerEnds) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [timerEnds]);
  const left = timerEnds ? Math.max(0, Math.round((timerEnds - now) / 1000)) : 0;
  const myHand = !!hands[me];

  const tiles = Object.values(peers);

  /* ── What the link is doing, in one answer for a surface that has up to four of them ──────────
     The worst connection is the one worth reporting: a member whose picture has gone to ONE person
     wants to know that, and a headline that averages it away is the same silence as no headline. */
  const reports = Object.values(links);
  const worst = reports.reduce<LinkReport | null>((a, r) => {
    if (!a) return r;
    if (a.videoOn !== r.videoOn) return a.videoOn ? r : a;
    return r.lossPct > a.lossPct ? r : a;
  }, null);
  const shed = reports.filter((r) => !r.videoOn).length;
  /* For the DECODER the question is different: not "is one link bad" but "is this device coping at
     all". One struggling connection is that connection's problem, and blanking the whole gallery
     over it would punish everybody for one person's train tunnel. So this one takes the BEST. */
  const coping: Exclude<CallMode, "auto"> = reports.length
    ? reports.reduce<Exclude<CallMode, "auto">>((b, r) => (RUNG[r.sending] > RUNG[b] ? r.sending : b), "audio")
    : (mode === "auto" ? "full" : mode);

  /* ── Who gets decoded ────────────────────────────────────────────────────────────────────────
     A pinned tile is a member's own instruction and always wins; after that the floor goes to
     whoever is talking, and then to roster order so the set is stable rather than shuffling. */
  const budget = decodeBudget(tiles.length, mode, coping, wide);
  const { speaking, speaker } = useSpeakers(
    tiles.map((p) => ({ uid: p.uid, stream: p.stream })),
    tiles.length >= 2 || (tiles.length === 1 && budget === 0),
  );
  const shown = new Set<number>();
  const cap = Math.min(Math.max(budget, pins.length), tiles.length);
  for (const uid of [...pins, ...(speaker ? [speaker] : []), ...tiles.map((p) => p.uid)]) {
    if (shown.size >= cap) break;
    if (peers[uid]) shown.add(uid);
  }
  const hidden = tiles.length - shown.size;
  // The open/close control only appears once the budget is actually deciding something. On a laptop
  // with three people it never is, and a call is not improved by a button per face.
  const constrained = hidden > 0 || pins.length > 0;

  function togglePin(uid: number) {
    setPins((cur) => (cur.includes(uid) ? cur.filter((u) => u !== uid) : [...cur, uid].slice(-3)));
  }

  const nameOf = (uid: number) => room.members.find((m2) => m2.id === uid);
  const btn = "inline-flex h-10 shrink-0 items-center rounded-pill px-3 text-[12.5px] font-semibold";

  /** The faces. On the focus stage they line the edge; in the strip they ARE the stage. */
  const faces = (
    <>
      <Tile stream={local} label="You" muted mirror name="You" hand={myHand}
        video={!!local?.getVideoTracks().length} note="Sound only" />
      {tiles.map((p) => {
        const who = nameOf(p.uid);
        return <Tile key={p.uid} stream={p.stream} label={who?.name || "Member"} name={who?.name}
          avatar={who?.avatar} state={p.state} hand={!!hands[p.uid]}
          video={shown.has(p.uid)} pinned={pins.includes(p.uid)}
          speaking={speaking.includes(p.uid)}
          big={p.uid === speaker && tiles.length >= 2 && view !== "screen"}
          /* OUR budget, said as ours. "Sound only" under someone whose camera is on reads as a
             statement about THEM — it is this device choosing not to decode a fourth picture. */
          note="Not shown here"
          onToggle={constrained ? () => togglePin(p.uid) : undefined} />;
      })}
    </>
  );

  const boardEl = (
    <Whiteboard
      strokes={strokes} pings={pings} tall={focus}
      canUndo={strokes.some((st) => st.by === me)}
      onStroke={(st) => { setStrokes((cur) => [...cur, { ...st, by: me }]); void signal({ v: 2, t: "draw", stroke: st }); }}
      onClear={() => { setStrokes([]); void signal({ v: 2, t: "draw", clear: true }); }}
      onUndo={() => {
        setStrokes((cur) => {
          const i = [...cur].reverse().findIndex((st) => st.by === me);
          return i < 0 ? cur : cur.filter((_, j) => j !== cur.length - 1 - i);
        });
        void signal({ v: 2, t: "draw", undo: true });
      }}
      onPoint={(x, y) => { setPings((cur) => [...cur.slice(-6), { x, y, at: Date.now(), by: me }]); void signal({ v: 2, t: "point", x, y }); }} />
  );

  // A phone gets two columns, never three: a 393px screen divided three ways is a 128px face.
  const total = tiles.length + 1;
  /** Who the measurement chose, said out loud — a call that quietly appoints somebody is a call
   *  nobody can reason about when it goes wrong. */
  const gridCols = view === "screen" || total <= 1 ? "grid-cols-1"
    : total === 2 ? "grid-cols-1 sm:grid-cols-2"
    : total <= 4 ? "grid-cols-2"
    : "grid-cols-2 sm:grid-cols-3";

  const hasCam = !!local?.getVideoTracks().length;

  const controls = (
    <div className="flex flex-col gap-2 border-t border-line px-3 py-2">
      {/* ITS OWN LINE, not a flex sibling of the controls. With `flex-1 truncate` this sentence
          competed with seven shrink-0 buttons for a 672px column and always lost — it rendered as
          "You're the ..." even on a 1440px desktop, which is a status line that has stopped telling
          anyone anything. */}
      <p className="text-[12px] leading-relaxed text-ink-3">
        {tiles.length === 0
          ? "You’re the only one here — invite someone, or just sit for a while."
          : <>Direct between all <span data-ay-skip="1">{total}</span> of you — no server in between</>}
      </p>
      {/* SAID OUT LOUD. A call that quietly appoints somebody is a call nobody can reason about when
          it goes wrong — and this one is chosen by measurement, so the measurement is worth showing. */}

      {/* The truth about the link, in one sentence and never a dialog. */}
      <LinkNote link={worst} mode={mode} />
      {shed > 0 && shed < reports.length && (
        <p className="text-[12px] leading-relaxed text-ink-3">
          Your camera is paused towards <span data-ay-skip="1">{shed}</span> of{" "}
          <span data-ay-skip="1">{reports.length}</span> — everyone else still sees you
        </p>
      )}
      {hidden > 0 && (
        <p className="text-[12px] leading-relaxed text-ink-3">
          Showing <span data-ay-skip="1">{shown.size}</span> of{" "}
          <span data-ay-skip="1">{tiles.length}</span> cameras. Everyone is still heard — showing fewer at
          once is what keeps this device up with the sound, and you can open any of them
        </p>
      )}

      {quality && (
        <div className="rounded-card border border-line bg-veil/[0.04] p-2.5">
          <CallModeChoice value={mode} onChange={applyMode} compact suggested={suggested} />
          <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
            Sound is the call. Everything here trades picture for it, and none of it interrupts anything —
            the change is on the wire before you have let go of the button
          </p>
        </div>
      )}

      {/* SECONDARY: the teaching tools. On a phone they are one press away rather than three rows
          of buttons over a call that is meant to be the thing on screen. */}
      <div className={`${more ? "flex" : "hidden"} flex-wrap items-center gap-2 sm:flex`}>
        <button type="button"
          onClick={() => {
            const ends = timerEnds ? null : Date.now() + 5 * 60 * 1000;
            setTimerEnds(ends);
            void signal({ v: 2, t: "timer", ends });
          }}
          title="A five-minute countdown everybody sees — for an exercise, or a break"
          className={`${btn} ${timerEnds ? "bg-yang text-on-accent" : "border border-line text-ink-2"}`}>
          {timerEnds ? "Stop timer" : "Timer"}
        </button>
        <button type="button"
          onClick={() => { setHands((cur) => ({ ...cur, [me]: !myHand })); void signal({ v: 2, t: "hand", up: !myHand }); }}
          className={`${btn} ${myHand ? "bg-yang text-on-accent" : "border border-line text-ink-2"}`}>
          {myHand ? "Lower hand" : "Raise hand"}
        </button>
        {/* A CONTROL THAT CANNOT WORK SHOULD SAY SO. getDisplayMedia does not exist on iOS, so this
            was an inert button on the platform most of these calls happen on. Disabled with its
            reason is honest; disabled and silent is just a broken button with better manners. */}
        <button type="button" disabled={!canShare}
          title={canShare ? undefined : "Your browser can’t share a screen — the whiteboard works here"}
          onClick={() => { void toggleShare(); if (!sharing) setView("screen"); }}
          className={`${btn} ${sharing ? "bg-yang text-on-accent" : "border border-line text-ink-2"} disabled:opacity-40`}>
          {sharing ? "Stop sharing" : canShare ? "Share screen" : "Share screen (not here)"}
        </button>
        <button type="button" onClick={() => setFocus((f) => !f)}
          className={`${btn} border border-line text-ink-2`}>{focus ? "Exit focus" : "Focus"}</button>
      </div>

      {/* PRIMARY: reachable with one thumb, 40px tall, and Leave where a thumb already is. It
          WRAPS: five pills and a countdown do not fit across 393px, and a control bar that
          overflows is a control bar with a Leave button nobody can reach. */}
      <div className="flex flex-wrap items-center gap-2">
        {timerEnds && (
          <span className={`${btn} ${left <= 10 ? "bg-yang text-on-accent" : "border border-line text-ink"}`}
            aria-live="polite" data-ay-skip="1">
            {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
          </span>
        )}
        <button type="button" onClick={() => { setMicOn((v) => { media.current?.getAudioTracks().forEach((t) => (t.enabled = !v)); return !v; }); }}
          className={`${btn} ${micOn ? "border border-line text-ink-2" : "bg-yang text-on-accent"}`}>
          {micOn ? "Mute" : "Unmute"}
        </button>
        {/* The camera button is the PRIVACY lever and stays instant: disabling a track needs no
            handshake. Bandwidth is the quality control's job, one button along. With no camera open
            at all this is the way back to one. */}
        <button type="button"
          onClick={() => {
            if (!hasCam) {
              // No camera open at all — sound only, a device the engine judged too small for a
              // picture, or a camera that refused to open. Asking for one is the same act either
              // way, and it is instant: the sender is already there.
              if (mode === "audio") applyMode("auto"); else void addCamera();
              return;
            }
            setCamOn((v) => { media.current?.getVideoTracks().forEach((t) => (t.enabled = !v)); return !v; });
          }}
          className={`${btn} ${hasCam && camOn ? "border border-line text-ink-2" : "bg-yang text-on-accent"}`}>
          {!hasCam ? "Camera on" : camOn ? "Camera off" : "Camera on"}
        </button>
        <button type="button" onClick={() => setQuality((q) => !q)} aria-expanded={quality}
          className={`${btn} ${quality ? "bg-yang text-on-accent" : "border border-line text-ink-2"}`}>
          Quality
        </button>
        <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more}
          className={`${btn} border border-line text-ink-2 sm:hidden`}>
          {more ? "Less" : "More"}
        </button>
        <button type="button" onClick={() => { void signal({ v: 2, t: "rtc", kind: "bye", sid: sid.current }); onLeft(); }}
          className={`${btn} ms-auto bg-yang px-4 text-on-accent`}>Leave</button>
      </div>
    </div>
  );

  return (
    <section
      className={focus
        ? "fixed inset-0 z-[95] flex flex-col bg-space-2"
        : "flex flex-col border-b border-line bg-space-1"}
      aria-label="Room call">

      {/* WHAT EVERYONE IS LOOKING AT. One stage with a switch, rather than a video strip that a
          whiteboard appears underneath — in a lesson the board or the shared screen IS the session,
          and the faces belong around it. */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-line px-2 py-1.5" role="tablist" aria-label="Stage">
        {([["grid", "People"], ["board", "Whiteboard"], ["screen", "Shared screen"]] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
            className={`${btn} ${view === k ? "bg-veil/[0.12] text-ink" : "text-ink-3 hover:text-ink"}`}>
            {label}
            {/* "live" ONLY WHEN IT IS. While video is shed the engine remembers a screen share
                instead of sending it — correctly, a share is a picture and the link cannot carry
                one — so a badge saying live would be telling the sharer that people can see work
                nobody is receiving. */}
            {k === "screen" && sharing && (
              sendingVideo
                ? <span className="ms-1 text-[10px] text-yang">live</span>
                : <span className="ms-1 text-[10px] text-ink-3">paused</span>
            )}
          </button>
        ))}
        {Object.entries(hands).some(([, up]) => up) && (
          <span className="ms-auto truncate text-[11.5px] text-yang" data-ay-skip="1">
            ✋ {Object.entries(hands).filter(([, up]) => up).map(([u]) => nameOf(Number(u))?.name || "Someone").join(", ")}
          </span>
        )}
      </div>

      {view === "board" && (
        <div className={`flex min-h-0 ${focus ? "flex-1" : ""} flex-col`}>{boardEl}</div>
      )}
      {/* HIDDEN, NEVER UNMOUNTED. Every peer's audio and video element lives inside a Tile, and
          unmounting one stops what it is playing — so switching to the whiteboard used to silence
          the entire call. On a product whose whole promise here is that the SOUND survives, the
          board was the one control that guaranteed it did not. `display:none` keeps media playing;
          only the picture goes away, which is all that was ever wanted. */}
      <div className={`grid grid-flow-row-dense gap-1 p-1 ${
        view === "board" ? "hidden" : focus ? "min-h-0 flex-1 content-center" : ""} ${gridCols}`}>
        {faces}
      </div>

      {/* On the focus stage the faces stay visible under the board — a lesson where you cannot see
          anybody's reaction is a screencast, not a session. NOT under the shared screen: that stage
          already renders the same faces above, and a second copy of every tile is a second decode
          of every stream, on the device least able to afford one. */}
      {focus && view === "board" && (
        <div className="grid grid-flow-row-dense shrink-0 grid-cols-3 gap-1 border-t border-line p-1 sm:grid-cols-6">{faces}</div>
      )}

      {err && <p className="px-3 py-1.5 text-[12px] text-yang">{err}</p>}
      {controls}
    </section>
  );
}

/** Two link reports say the same thing when nothing a member could act on has changed. Rounding
 *  hard is the point: a re-render every two seconds per peer, to move a number by 3ms, is a cost
 *  paid by exactly the phone this whole file is about. */
function same(a: LinkReport | undefined, b: LinkReport): boolean {
  return !!a && a.sending === b.sending && a.videoOn === b.videoOn && a.reason === b.reason
    && Math.round(a.rttMs / 20) === Math.round(b.rttMs / 20)
    && Math.round(a.lossPct) === Math.round(b.lossPct)
    && Math.round(a.kbps / 50) === Math.round(b.kbps / 50);
}

/**
 * One face.
 *
 * `video` is not "do they have a camera" — it is "may this device spend a decoder on them". When it
 * is false the stream goes to an <audio> element, which presents no video and therefore decodes
 * none, and the tile says so. The one thing it must never do is show a still frame under a name and
 * let it be read as a live picture.
 */
function Tile({ stream, label, muted, mirror, name, avatar, state, hand, video, note, pinned, speaking, big, onToggle }: {
  stream: MediaStream | null; label: string; muted?: boolean; mirror?: boolean;
  name?: string; avatar?: string; state?: string; hand?: boolean;
  video?: boolean; note?: string; pinned?: boolean; speaking?: boolean; big?: boolean;
  onToggle?: () => void;
}) {
  const vid = useRef<HTMLVideoElement | null>(null);
  const aud = useRef<HTMLAudioElement | null>(null);
  const live = useVideoLive(video ? stream : null);
  useEffect(() => {
    const el: HTMLMediaElement | null = video ? vid.current : aud.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) el.play().catch(() => undefined);
  }, [stream, video]);
  return (
    <div className={`relative aspect-video overflow-hidden rounded-card bg-black/70 ${
      big ? "col-span-2 sm:col-span-1" : ""} ${speaking ? "ring-2 ring-yang" : ""}`}>
      {video ? (
        <video ref={vid} autoPlay playsInline muted={muted} aria-label={label}
          className={`h-full w-full object-cover ${mirror ? "-scale-x-100" : ""}`} />
      ) : (
        <audio ref={aud} autoPlay muted={muted} aria-label={label} />
      )}
      {(!stream || !video || !live) && (
        <div className="absolute inset-0 grid place-items-center px-2" data-ay-skip="1">
          <div className="text-center">
            <Avatar src={avatar} name={name} className="mx-auto h-10 w-10" />
            {/* A FIXED light ink, not a canvas token. This sits on the tile's own bg-black/70,
               which is black in BOTH themes — but ink-3 is solved against the page canvas, so
               in light theme it is a mid grey on a mid grey: 2.24:1 at the default contrast,
               and 1.74:1 at the highest — raising the contrast setting made it vanish faster.
               This is the one line that says WHY you cannot see someone. The name chip two
               lines below already solved it the right way, with text-white on bg-black/60. */}
            <p className="mt-1 text-[11px] leading-tight text-white/85">
              {!stream ? (state === "failed" ? "Couldn’t connect" : "Connecting…") : !video ? note : "Camera off"}
            </p>
          </div>
        </div>
      )}
      <span className="absolute bottom-1 start-1 rounded bg-black/60 px-1.5 py-0.5 text-[10.5px] text-white" data-ay-skip="1">{name || label}</span>
      {/* Opening a tile is the member overruling the budget, and it has to be reachable with a
          thumb — 40px, in the corner nothing else uses. */}
      {onToggle && stream && (
        <button type="button" onClick={onToggle}
          className="absolute bottom-0 end-0 inline-flex h-10 items-center rounded-card px-2.5 text-[11px] font-semibold text-white/90 hover:text-white">
          {video ? (pinned ? "Close" : "Keep open") : "Show"}
        </button>
      )}
      {hand && <span className="absolute top-1 end-1 rounded-full bg-yang px-1.5 py-0.5 text-[11px]" title="Hand raised">✋</span>}
    </div>
  );
}
