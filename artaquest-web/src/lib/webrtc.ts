/**
 * ArtaCall — 1:1 video calling with no server in the middle.
 *
 * WHY THIS AND NOT JITSI. Calls used to be an embedded meet.jit.si room, which meant the one part
 * of ArtaChat that was NOT end-to-end encrypted was the part where you can see someone's face: the
 * media went to a third party's bridge, and the panel had to say so. Self-hosting Jitsi instead
 * would only move that bridge to a server the Foundation pays for and patches — the media still
 * leaves the two people having the call.
 *
 * So there is no bridge. Two browsers connect DIRECTLY (WebRTC), media is encrypted by DTLS-SRTP
 * between them, and the keys are negotiated inside an SDP that travels as an ORDINARY SEALED CHAT
 * MESSAGE. The server carries the handshake as ciphertext exactly like it carries an essay, and it
 * cannot read the offer any more than it can read the conversation. Nobody — not us, not Jitsi, not
 * a host — is in a position to see or hear a call. That is the same claim the messages make, which
 * is the point: it was uncomfortable for the video to be the exception.
 *
 * THE TWO HONEST COSTS, both surfaced in the UI rather than buried here:
 *
 *  1. PEER-TO-PEER MEANS THE OTHER PERSON LEARNS YOUR IP ADDRESS. That is not a leak in the
 *     implementation, it is what "direct connection" means — packets need somewhere to go. A relay
 *     would hide it, and a relay is exactly the thing we removed. The call UI says so before the
 *     first call, because someone deciding whether to answer a stranger deserves to know.
 *  2. STUN. A browser cannot discover its own public address+port without asking something outside
 *     the network, so ICE needs a STUN server. It is a single stateless UDP round trip that reveals
 *     an IP — the same IP every website already sees — and carries no media, no identity and no
 *     conversation. Public STUN is used rather than a self-hosted one because self-hosting it means
 *     the server we just got rid of; several are listed so one being down is not a failed call.
 *
 * NON-TRICKLE ICE, deliberately. The signalling channel is a polled message thread, so every
 * signalling message costs a poll interval. Trickling candidates one at a time would be N round
 * trips at seconds each; waiting for gathering to finish bundles them all into the SDP, so a call
 * is exactly TWO messages — an offer and an answer — whatever the network looks like.
 *
 * THE THIRD COST, and the one this file spends most of its length on: WITHOUT A BRIDGE, EVERY
 * PARTICIPANT IS THEIR OWN UPLOAD SERVER. Five people in a mesh is four separate copies of your
 * camera leaving your phone, and a phone's uplink on a train is not four copies of anything. The
 * whole quality apparatus below — modes, encoder ceilings, Opus settings, the getStats ladder —
 * exists to keep ONE promise: the voice gets there. Everything else is negotiable and gets
 * negotiated away, early, in that order, and the member is told why in words.
 */

/** ICE servers. STUN only: there is no TURN, so a call behind symmetric NAT can fail to connect —
 *  the UI says that plainly rather than spinning forever. Adding a TURN relay later is a config
 *  change here and nothing else. */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: ["stun:stun.cloudflare.com:3478"] },
];

/** How long to wait for ICE gathering before sending anyway. Gathering "completes" only after every
 *  server has answered or timed out, and one unreachable STUN server should not hold a call. The
 *  candidates found so far are still in the SDP, so sending early degrades reach, never correctness. */
const GATHER_MS = 3000;

/**
 * ── WHAT THE CALL IS ALLOWED TO SEND ────────────────────────────────────────────────────────────
 *
 * A mesh call has no server in the middle, so every participant uploads their own camera to every
 * other participant separately: five people is four uplinks each. On a phone on a bad connection
 * that is the whole problem, and it has exactly one honest answer — SOUND IS THE CALL. A meeting
 * where the picture freezes is a meeting; a meeting where the audio breaks up is nothing at all.
 * So video is what gets sacrificed, always, and it is sacrificed early rather than after the link
 * has already started dropping the words.
 */
export type CallMode =
  | "auto"    // decide from the device and link, then keep deciding as it changes
  | "audio"   // voice only — no camera opened, nothing to upload but speech
  | "low"     // a small, slow picture that leaves room for the voice
  | "full";   // as good as the link will carry

/** A resolved mode: what is actually going out, once "auto" has made up its mind. */
type SendMode = Exclude<CallMode, "auto">;

/** What the link is actually doing, sampled from getStats — the basis for every automatic choice. */
export type LinkReport = {
  /** Round trip in milliseconds, 0 when not yet known. */
  rttMs: number;
  /** Outbound packet loss, percent. This is the number that decides whether video stays. */
  lossPct: number;
  /** The bandwidth estimate the browser will admit to, in kbit/s. 0 when unavailable. */
  kbps: number;
  /** What is being sent RIGHT NOW. Never "auto" — this is the resolved answer, not the preference. */
  sending: Exclude<CallMode, "auto">;
  /** False once video has been shed, whatever the member asked for. */
  videoOn: boolean;
  /** Why, in words a member can read. Empty when nothing needs saying. */
  reason: string;
};

export type CallState =
  | "idle"        // nothing happening
  | "calling"     // we made an offer, waiting for them
  | "ringing"     // an offer arrived, waiting for us
  | "connecting"  // both sides have exchanged SDP; ICE is doing its work
  | "live"        // media flowing
  | "ended"
  | "failed";     // ICE gave up — almost always symmetric NAT with no relay to fall back to

export type CallHandlers = {
  onState: (s: CallState) => void;
  /** The link, about every two seconds. What the UI tells the member with it is its business. */
  onLink?: (r: LinkReport) => void;
  onRemote: (stream: MediaStream | null) => void;
  onLocal: (stream: MediaStream | null) => void;
};

/* ── THE NUMBERS ───────────────────────────────────────────────────────────────────────────────
 *
 * All of the quality policy is here, in one block, so it can be argued with as a set rather than
 * hunted for as constants sprinkled through the class.
 */

/**
 * WHAT WE ASK THE CAMERA FOR. Not 720p — a 720p request in a five-way mesh asks a phone to encode
 * four copies of a picture no tile on anybody's screen is large enough to show, and to upload them
 * over a link that has one. 360p is the honest top end for a mesh; 180p is what survives a train.
 *
 * The frame rate is capped at capture rather than only at the encoder because an uncapped camera
 * hands the encoder 30fps of work whatever it does with them afterwards, and on a modest phone that
 * heat and battery is paid before a single packet leaves.
 *
 * `facingMode: { ideal: "user" }` and never `exact`: a call wants the front camera, but a laptop
 * with one camera that reports no facing mode must not have getUserMedia throw OverconstrainedError
 * at it. Ideal degrades quietly, which is the rule for every capability in this file.
 */
const CAPTURE: Record<"low" | "full", MediaTrackConstraints> = {
  low: {
    width: { ideal: 320 }, height: { ideal: 180 },
    frameRate: { ideal: 12, max: 15 },
    facingMode: { ideal: "user" },
  },
  full: {
    width: { ideal: 640 }, height: { ideal: 360 },
    frameRate: { ideal: 24, max: 30 },
    facingMode: { ideal: "user" },
  },
};

/** Microphone. Mono deliberately: stereo doubles the bitrate to carry a second copy of one person
 *  talking into one phone, and every Opus setting below assumes one channel. */
const MIC: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: { ideal: 1 },
};

/** TOTAL video uplink this device will spend, kbit/s, SHARED across every peer it is talking to.
 *  A mesh means the budget is per device, not per connection — four peers get a quarter each. */
const VIDEO_BUDGET: Record<"low" | "full", number> = { low: 240, full: 900 };

/** Below this a picture is not a picture, so rather than starve four streams we shrink them. */
const VIDEO_FLOOR_KBPS = 60;

/** Opus ceiling per mode, bits/s. Voice-first: even the smallest of these is a good voice call. */
const AUDIO_BPS: Record<SendMode, number> = { audio: 32000, low: 24000, full: 32000 };

/** Video rails written into the SDP (see `tuneSdp`). These are safety ceilings fixed at negotiation
 *  time, never the working limit — the working limit is `setParameters`, which adapts every 2s. */
const RAIL_UP: Record<SendMode, number> = { audio: 64, low: 250, full: 800 };    // what we may send
const RAIL_DOWN: Record<SendMode, number> = { audio: 128, low: 300, full: 800 }; // what they may send us

/** How often the link is sampled. Two seconds is long enough for a delta to mean something and
 *  short enough that a member does not sit through six seconds of broken words. */
const STATS_MS = 2000;

/** Sustained samples before a step. DOWN is fast — by the time loss is visible the words are
 *  already going. UP is slow, and gets slower each time recovery turns out to have been premature,
 *  because nothing is worse than a picture that returns for four seconds every half minute. */
const DOWN_SAMPLES = 2;      // ~4 s of genuinely bad before video goes
const STRAIN_SAMPLES = 3;    // ~6 s of strain before the picture shrinks
const RECOVER_SAMPLES = 8;   // ~16 s of good before anything comes back
const RECOVER_MAX = 60;      // ~2 min, the ceiling on that doubling

/** The ladder, as numbers, so "step down one" is arithmetic. */
const RUNG: Record<SendMode, number> = { audio: 0, low: 1, full: 2 };
const BY_RUNG: SendMode[] = ["audio", "low", "full"];

/** Packets a sample must carry before its loss rate means anything — see the DTX note below. */
const LOSS_FLOOR = 20;

/* ── THE LINK, JUDGED ─────────────────────────────────────────────────────────────────────────── */

/** 0 = fine, 1 = under strain, 2 = the voice itself is at risk.
 *
 *  WHY THESE NUMBERS. Opus in-band FEC covers roughly single-digit loss; past ~8% the redundancy is
 *  being lost too and words start disappearing, so 8% is where video stops being defensible. 400ms
 *  round trip is where people begin talking over each other and 700ms is where they give up and
 *  type instead. And a browser that will only admit to 150 kbit/s of headroom is telling us it does
 *  not have a video call in it — that is a whole estimate, not a blip, which is why the caller
 *  requires several consecutive samples before acting on any of this. */
function classify(rttMs: number, lossPct: number, kbps: number, wantKbps: number): 0 | 1 | 2 {
  // BANDWIDTH IS JUDGED AGAINST WHAT WE ARE ASKING FOR, never against a fixed number. The estimate
  // follows the ceiling we ourselves imposed, and that ceiling is the per-device video budget DIVIDED
  // BY THE NUMBER OF PEERS — so in a room of four, a perfectly healthy link reports a couple of
  // hundred kbit/s per connection and an absolute threshold reads it as starving. The ladder would
  // then shed video, lowering the ceiling again, and read that as worse still. A link is short when
  // it cannot carry what we asked of it; asking for little and getting little is not a fault.
  const short = wantKbps > 0 && kbps > 0 && kbps < wantKbps * 0.5;
  const tight = wantKbps > 0 && kbps > 0 && kbps < wantKbps * 0.8;
  // With no video on the wire there is nothing to compare against, so only an estimate too small to
  // carry SPEECH counts — and Opus at our ceiling needs about 32 kbit/s plus overhead.
  const voiceAtRisk = wantKbps === 0 && kbps > 0 && kbps < 50;
  if (lossPct >= 8 || rttMs >= 700 || short || voiceAtRisk) return 2;
  if (lossPct >= 3 || rttMs >= 400 || tight) return 1;
  return 0;
}

/** Read a getStats value that may be absent, null, or a string on some browser somewhere. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/* ── WHAT THIS DEVICE SHOULD START WITH ───────────────────────────────────────────────────────── */

type NetInfo = {
  saveData?: boolean;
  effectiveType?: string;
  downlink?: number;
  addEventListener?: (t: string, fn: () => void) => void;
  removeEventListener?: (t: string, fn: () => void) => void;
};

/** The Network Information API and its friends are not in every browser (Safari has none of them),
 *  so every read is optional and absence means "no opinion", never "bad". */
function netInfo(): NetInfo | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as unknown as { connection?: NetInfo }).connection;
}

/** A phone, as far as anything can tell. Coarse pointer + a short side is the honest test — user
 *  agent sniffing gets iPadOS wrong (it claims to be a Mac), so touch points settle that one. */
function isHandheld(): boolean {
  if (typeof navigator === "undefined") return false;
  const touch = (navigator.maxTouchPoints ?? 0) > 1;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const shortSide = typeof screen !== "undefined" ? Math.min(screen.width || 0, screen.height || 0) : 0;
  if (coarse && shortSide > 0 && shortSide <= 500) return true;   // phone-sized, finger-driven
  return touch && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "");
}

/** The highest mode this DEVICE should ever reach, however good the link turns out to be. A link
 *  can improve; two CPU cores cannot, and neither can a member who has asked for data saver. */
function deviceCeiling(): SendMode {
  const conn = netInfo();
  if (conn?.saveData === true) return "audio";   // the browser is telling us not to. Believe it
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 0;
  const cores = navigator?.hardwareConcurrency ?? 0;
  // Encoding four copies of a live picture on two cores costs the audio thread the CPU it needs.
  if ((mem > 0 && mem <= 2) || (cores > 0 && cores <= 2)) return "low";
  return "full";
}

/**
 * What to start with on THIS device and link — the mode a member would have picked if they had
 * known what a mesh costs. Getting this right is what stops most members ever touching a control.
 *
 * It is the STARTING rung, not a life sentence: a call in "auto" climbs from here when the link
 * proves itself (and never above `deviceCeiling`), and drops from here the moment it does not.
 */
export function suggestedMode(): CallMode {
  if (typeof navigator === "undefined") return "low";
  const conn = netInfo();
  const top = RUNG[deviceCeiling()];
  let start = 2;
  const et = conn?.effectiveType;
  if (conn?.saveData === true || et === "slow-2g" || et === "2g") start = 0;
  else if (et === "3g") start = 1;
  else if (typeof conn?.downlink === "number" && conn.downlink > 0 && conn.downlink < 1.5) start = 1;
  else if (isHandheld()) start = 1;   // a phone starts modest and earns its way up
  return BY_RUNG[Math.min(start, top)];
}

/**
 * Open the camera and microphone for a call at a given mode — the one place capture is decided.
 *
 * A mesh opens the camera ONCE and hands the same stream to every `Call`, so this belongs to
 * whoever owns the call UI rather than to a connection. Note that constraints are a REQUEST: what
 * came back is checked and, where a camera has ignored a polite `ideal`, insisted on with `max`.
 */
export async function openCallMedia(mode: CallMode = "auto"): Promise<MediaStream> {
  const m = mode === "auto" ? (suggestedMode() as SendMode) : mode;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: MIC,
    video: m === "audio" ? false : CAPTURE[m],
  });
  const track = stream.getVideoTracks()[0];
  if (track && m !== "audio") await shapeCapture(track, m);
  return stream;
}

/** Remember what a shared track was last shaped to, so retuning a five-way mesh does not hit the
 *  camera five times with the same request (each one is a real reconfiguration on some hardware). */
const SHAPED = new WeakMap<MediaStreamTrack, "low" | "full">();

/**
 * Make a capture track match a mode, and verify it did.
 *
 * `getUserMedia`/`applyConstraints` treat `ideal` as a preference, and plenty of Android cameras
 * answer a request for 320×180@12 with 1280×720@30 because that is the mode their sensor likes.
 * That is not a failure we can ignore — it is the phone we were trying to protect, encoding 720p
 * for four peers. So we read `getSettings()` back and, if it is wildly over, ask again with `max`,
 * which a camera may only satisfy or refuse.
 */
async function shapeCapture(track: MediaStreamTrack, mode: "low" | "full"): Promise<void> {
  if (SHAPED.get(track) === mode) return;
  SHAPED.set(track, mode);
  const want = CAPTURE[mode];
  const w = (want.width as { ideal: number }).ideal;
  const h = (want.height as { ideal: number }).ideal;
  const fps = (want.frameRate as { max: number }).max;
  try { await track.applyConstraints(want); } catch { /* fixed-format camera — the encoder still caps */ }
  let got: MediaTrackSettings = {};
  try { got = track.getSettings(); } catch { /* not implemented — nothing more we can check */ }
  if (num(got.width) > w * 1.5 || num(got.frameRate) > fps + 5) {
    try {
      await track.applyConstraints({ width: { max: w }, height: { max: h }, frameRate: { max: fps } });
    } catch { /* it cannot. The per-connection encoder ceiling is the backstop, and it is enough */ }
  }
}

/* ── THE VOICE ITSELF: SDP ────────────────────────────────────────────────────────────────────── */

const OPUS_RE = /^a=rtpmap:(\d+)\s+opus\/48000/i;

/** Opus parameters worth arguing about, per mode. DTX stops sending during silence (most of a
 *  meeting, per person); in-band FEC carries a redundant copy of the previous frame so a single
 *  lost packet is not a lost syllable; mono halves the bill for a second copy of one voice. On a
 *  good link these cost nothing measurable — which is why they are on for every mode, not just the
 *  bad ones. */
function opusParams(mode: SendMode): Record<string, string> {
  const p: Record<string, string> = {
    minptime: "10",
    useinbandfec: "1",
    usedtx: "1",
    stereo: "0",
    "sprop-stereo": "0",
    maxaveragebitrate: String(AUDIO_BPS[mode]),
  };
  // Superwideband is transparent for speech and cheaper to encode; full-band is kept for the mode
  // that is not trying to survive anything.
  if (mode !== "full") p.maxplaybackrate = "24000";
  return p;
}

type Sect = { kind: string; start: number; end: number };

function sectionsOf(lines: string[]): Sect[] {
  const out: Sect[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("m=")) continue;
    if (out.length) out[out.length - 1].end = i;
    out.push({ kind: lines[i].slice(2).split(/\s/)[0], start: i, end: lines.length });
  }
  return out;
}

/** Merge parameters into (or create) the Opus `a=fmtp` line of one media section. */
function setOpusFmtp(lines: string[], s: Sect, params: Record<string, string>): void {
  let pt = "";
  let rtpmapAt = -1;
  for (let i = s.start; i < s.end; i++) {
    const m = OPUS_RE.exec(lines[i]);
    if (m) { pt = m[1]; rtpmapAt = i; break; }
  }
  if (!pt) return;                       // no Opus in this offer — nothing here we understand
  const head = `a=fmtp:${pt} `;
  let at = -1;
  for (let i = s.start; i < s.end; i++) if (lines[i].startsWith(head)) { at = i; break; }
  const merged: Record<string, string> = {};
  if (at >= 0) {
    for (const kv of lines[at].slice(head.length).split(";")) {
      const eq = kv.indexOf("=");
      const k = (eq < 0 ? kv : kv.slice(0, eq)).trim();
      if (k) merged[k] = eq < 0 ? "" : kv.slice(eq + 1).trim();
    }
  }
  Object.assign(merged, params);          // ours wins; everything else the peer asked for survives
  const line = head + Object.entries(merged).map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join(";");
  if (at >= 0) lines[at] = line;
  else lines.splice(rtpmapAt + 1, 0, line);
}

/** Set `b=AS` (kbit/s) on one media section, in its RFC 4566 position: after `i=`/`c=`, before `a=`. */
function setBandwidth(lines: string[], s: Sect, kbps: number): void {
  for (let i = s.start + 1; i < s.end; i++) {
    if (lines[i].startsWith("b=AS:")) { lines[i] = `b=AS:${kbps}`; return; }
  }
  let at = s.start + 1;
  while (at < s.end && /^[ic]=/.test(lines[at])) at++;
  lines.splice(at, 0, `b=AS:${kbps}`);
}

/**
 * Rewrite an SDP so the voice survives — the one lever that works on every browser, including the
 * ones whose encoder API we cannot use.
 *
 * WHICH DIRECTION IT SHAPES, because this is routinely got backwards: `a=fmtp` and `b=AS` in a
 * description are a RECEIVER'S declaration. Parameters in OUR OWN local description tell the peer
 * how to encode what it sends US (`dir: "in"`); the same parameters written into THEIR description
 * before we apply it tell OUR encoder how to send to them (`dir: "out"`). Both sides of this app
 * run this code, so either one alone would do the job — doing both means a call is protected even
 * against a peer running an older bundle.
 *
 * Anything unrecognised passes through untouched. A call that connects with default Opus is
 * infinitely better than a call whose SDP we broke, so every step here is skippable and the whole
 * function is wrapped: if the shape surprises us, we hand back exactly what we were given.
 */
function tuneSdp(sdp: string | undefined, mode: SendMode, dir: "in" | "out", rail: SendMode): string | undefined {
  if (typeof sdp !== "string" || !sdp.includes("m=")) return sdp;
  try {
    const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
    const lines = sdp.split(/\r\n|\n|\r/);
    const sects = sectionsOf(lines);
    // Backwards, because inserting a line into an early section would shift every index after it.
    for (let i = sects.length - 1; i >= 0; i--) {
      const s = sects[i];
      if (s.kind === "audio") setOpusFmtp(lines, s, opusParams(mode));
      else if (s.kind === "video") setBandwidth(lines, s, dir === "in" ? RAIL_DOWN[rail] : RAIL_UP[rail]);
    }
    return lines.join(eol);
  } catch {
    return sdp;   // an SDP we do not recognise is not ours to edit
  }
}

/**
 * One call. Created when a call starts (either direction), destroyed when it ends — never reused,
 * because a half-torn-down RTCPeerConnection that gets a second offer is a class of bug not worth
 * having.
 */
export class Call {
  readonly sid: string;
  private pc: RTCPeerConnection | null = null;
  private local: MediaStream | null = null;
  /** False when the stream was handed in from outside (a mesh shares ONE camera across every peer
   *  connection). Closing must then not stop tracks this call does not own, or leaving one peer
   *  would blank everybody's video. */
  private ownsMedia = true;
  private remote: MediaStream | null = null;
  private h: CallHandlers;
  private done = false;

  /**
   * EVERY LIVE CALL ON THIS DEVICE, because the thing being rationed is one uplink and one camera,
   * not one connection. A five-way mesh is five `Call` objects sharing a single phone: the video
   * budget is divided between them (so a third participant joining halves everybody's ceiling
   * without anybody being told to), and the camera is shaped once, for the most demanding of them.
   */
  private static live = new Set<Call>();

  /** The member's PREFERENCE. May be "auto", in which case the link decides within a device ceiling. */
  private pref: CallMode;
  /** What is actually going out. Never "auto". */
  private send: SendMode;
  /** The top of the ladder while in "auto" — a device fact, re-read when the network changes. */
  private autoTop: SendMode = "full";

  private audioSender: RTCRtpSender | null = null;
  private videoSender: RTCRtpSender | null = null;
  /** What we WOULD send if video were on. Held across a shed so recovery costs no renegotiation. */
  private videoTrack: MediaStreamTrack | null = null;

  private timer: number | null = null;
  /** False until the encoder plan has actually been accepted. Safari hands back a sender with no
   *  encodings until negotiation has settled, so the first attempt can silently do nothing — the
   *  sampler keeps retrying until one lands rather than leaving a call uncapped forever. */
  private applied = false;
  private prev: { at: number; bytes: number; sent: number; lost: number } | null = null;
  private bad = 0;      // consecutive samples where the voice is at risk
  private hurt = 0;     // consecutive samples of strain or worse
  private good = 0;     // consecutive samples with nothing wrong
  private recoverAt = RECOVER_SAMPLES;
  private climbed = false;   // we have restored something at least once: recovery gets sceptical
  /** The last numbers we saw, so a report can be emitted on a decision that did not come from a
   *  sample (a member changing mode, the browser changing network) without inventing a link. */
  private lastRtt = 0;
  private lastLoss = 0;
  private lastKbps = 0;

  constructor(sid: string, h: CallHandlers, mode: CallMode = "auto") {
    this.sid = sid;
    this.h = h;
    this.pref = mode;
    this.autoTop = deviceCeiling();
    this.send = mode === "auto" ? (suggestedMode() as SendMode) : mode;
  }

  /** True once this call has been closed — callers use it to ignore late signalling. */
  get closed() { return this.done; }

  /** The member's preference — "auto" until they say otherwise. */
  get mode(): CallMode { return this.pref; }

  /** What is on the wire right now. Never "auto": this is the resolved answer. */
  get sending(): SendMode { return this.send; }

  /**
   * Change a LIVE call without renegotiating.
   *
   * Everything this touches — encoder parameters, whether the video sender carries a track, what
   * the camera is asked for — is changeable on an established connection. No offer, no answer, no
   * poll interval: the sealed-message signalling channel is far too slow to put a quality control
   * on, so nothing here is allowed to need it.
   *
   * A deliberate choice also RESETS the automatic ladder: whatever the link had talked us down to,
   * the member's new ask is honoured immediately and has to be argued out of again from scratch.
   *
   * One thing it cannot conjure: a call that started as voice has no camera. Open one and hand it
   * to `replaceVideo` — the video m-line was negotiated up front precisely so that costs nothing.
   */
  setMode(m: CallMode): void {
    if (this.done) return;
    this.pref = m;
    this.autoTop = deviceCeiling();
    this.bad = this.hurt = this.good = 0;
    this.recoverAt = RECOVER_SAMPLES;
    this.climbed = false;
    this.send = m === "auto" ? (suggestedMode() as SendMode) : m;
    void this.applySend();
    Call.retune();
    this.emit(this.lastRtt, this.lastLoss, this.lastKbps);
  }

  /** The highest rung this call may currently reach. */
  private ceiling(): SendMode {
    return this.pref === "auto" ? this.autoTop : this.pref;
  }

  private setup() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    // ONE remote stream, filled as tracks arrive. Building it here rather than trusting
    // `event.streams[0]` means a peer that negotiates audio and video as separate streams still
    // renders as one <video>.
    this.remote = new MediaStream();
    pc.ontrack = (e) => {
      this.remote?.addTrack(e.track);
      this.h.onRemote(this.remote);
    };
    pc.onconnectionstatechange = () => {
      if (this.done) return;
      switch (pc.connectionState) {
        case "connected": this.h.onState("live"); break;
        // `failed` is terminal and, with no TURN, usually means symmetric NAT on one side.
        case "failed": this.h.onState("failed"); break;
        case "disconnected": break; // transient — ICE may recover on its own; don't kill the call
        case "closed": this.h.onState("ended"); break;
      }
    };
    this.pc = pc;
    Call.live.add(this);
    netInfo()?.addEventListener?.("change", this.onNetChange);
    this.startSampling();
    return pc;
  }

  /**
   * The browser has noticed the network changed (wifi lost, data saver switched on).
   *
   * Only ever acted on DOWNWARDS. A browser saying "you are on 2g now" is worth believing at once;
   * a browser saying "you are on 4g now" has said that from a lift before, so climbing back stays
   * the stats ladder's job, on its own slow evidence.
   */
  private onNetChange = () => {
    if (this.done || this.pref !== "auto") return;
    this.autoTop = deviceCeiling();
    const want = Math.min(RUNG[this.ceiling()], RUNG[suggestedMode() as SendMode]);
    if (want < RUNG[this.send]) {
      this.send = BY_RUNG[want];
      this.bad = this.hurt = this.good = 0;
      void this.applySend();
      Call.retune();
      this.emit(this.lastRtt, this.lastLoss, this.lastKbps);
    }
  };

  /** Camera + microphone. Separated so a permission refusal is reported as itself, not as a
   *  mysterious failure to connect. */
  private async media(video: boolean): Promise<MediaStream> {
    if (this.local) return this.local;
    const s = await openCallMedia(video && this.send !== "audio" ? this.send : "audio");
    this.local = s;
    this.h.onLocal(s);
    return s;
  }

  /** Use a stream somebody else opened — a mesh call opens the camera ONCE and shares it. */
  private adopt(s: MediaStream): MediaStream {
    this.local = s;
    this.ownsMedia = false;
    return s;
  }

  /**
   * Put our tracks on the connection, and make sure there is a video m-line either way.
   *
   * A voice call that can never become a video call without a fresh offer/answer would be a quality
   * control the signalling channel is too slow to serve, so even with no camera we negotiate a
   * sendrecv video transceiver. Turning video on later is then one `replaceTrack` — instant, and
   * incapable of failing the way a handshake can.
   */
  private attach(pc: RTCPeerConnection, s: MediaStream): void {
    for (const t of s.getTracks()) {
      const sender = pc.addTrack(t, s);
      if (t.kind === "audio") this.audioSender = sender;
      else { this.videoSender = sender; this.videoTrack = t; }
    }
    if (!this.videoSender) {
      // Answering side: setRemoteDescription has already made a transceiver for their video.
      const theirs = pc.getTransceivers().find((t) => t.receiver?.track?.kind === "video");
      if (theirs) {
        try { theirs.direction = "sendrecv"; } catch { /* direction fixed — no upgrade path, fine */ }
        this.videoSender = theirs.sender;
      } else if (typeof pc.addTransceiver === "function") {
        try { this.videoSender = pc.addTransceiver("video", { direction: "sendrecv" }).sender; }
        catch { /* no transceiver API here: this call is voice for its lifetime */ }
      }
    }
  }

  /**
   * Apply the sending policy to THIS connection — the per-connection half of the job (the camera is
   * the shared half, see `retune`). Everything here is `setParameters` and `replaceTrack`, so it is
   * free of renegotiation and safe to call on a live call as often as we like.
   */
  private async applySend(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.done) return;
    const mode = this.send;
    let landed = true;

    // AUDIO OUTRANKS VIDEO ON THE WIRE. This is the whole ask, in two properties: the browser's own
    // bandwidth allocator prefers the high-priority stream when the pipe is full, and the DSCP mark
    // asks the network to do the same. `priority` is the older name for the same field and is still
    // what some builds read, so both are set.
    if (this.audioSender) {
      try {
        const p = this.audioSender.getParameters();
        if (p.encodings && p.encodings.length) {
          for (const e of p.encodings) {
            e.active = true;
            e.networkPriority = "high";
            e.priority = "high";
            e.maxBitrate = AUDIO_BPS[mode];
          }
          await this.audioSender.setParameters(p);
        } else landed = false;
      } catch { landed = false; /* Safari can refuse encodings; the SDP ceiling still applies */ }
    }

    if (this.videoSender) {
      const want = mode === "audio" ? null : this.videoTrack;
      const have = this.videoSender.track;
      // SHEDDING VIDEO IS `replaceTrack(null)`, NOT stopping the track: the track is the shared
      // camera every other peer connection is also sending, and the audio track is never touched.
      // Nothing renegotiates, and the picture returns the moment the link earns it.
      if (want !== have) {
        try { await this.videoSender.replaceTrack(want); } catch { /* stale sender; the next pass retries */ }
      }
      if (mode !== "audio") {
        const plan = Call.videoPlan(mode);
        try {
          const p = this.videoSender.getParameters();
          if (p.encodings && p.encodings.length) {
            for (const e of p.encodings) {
              e.active = true;
              e.maxBitrate = plan.bps;
              e.maxFramerate = plan.fps;
              e.scaleResolutionDownBy = plan.scale;
              e.networkPriority = "low";
              e.priority = "low";
            }
            // A FROZEN FACE IS WORSE THAN A SOFT ONE. maintain-framerate spends the shortfall on
            // resolution and keeps the motion, so a struggling call looks blurred rather than dead.
            p.degradationPreference = "maintain-framerate";
            await this.videoSender.setParameters(p);
          } else landed = false;
        } catch { landed = false; /* older Safari: the SDP rail is the ceiling there, and it holds */ }
      }
    }
    this.applied = landed;
  }

  /** The video budget, divided by however many peers this device is uploading to right now. */
  private static videoPlan(mode: "low" | "full"): { bps: number; fps: number; scale: number } {
    const peers = Math.max(1, Call.live.size);
    const kbps = Math.max(VIDEO_FLOOR_KBPS, Math.round(VIDEO_BUDGET[mode] / peers));
    // 360p at 90 kbit/s is a smear of blocks. Halve the pixels and spend the bits on what is left.
    const scale = mode === "full" && kbps < 150 ? 2 : 1;
    return { bps: kbps * 1000, fps: mode === "full" ? 24 : 12, scale };
  }

  /**
   * Shape the SHARED camera for the most demanding live call, and re-apply every connection's
   * encoder plan.
   *
   * The split matters: `adopt()` means one camera track is feeding every peer connection, so
   * capture is a decision for the whole device (the loosest live requirement wins — a connection
   * that wants less scales down its own copy, but no connection can get back pixels the camera was
   * never asked for). Encoder parameters are per connection and stay per connection.
   *
   * It deliberately never touches `track.enabled`: that is the member's camera button, and a
   * quality engine that quietly switched a camera back on would be a bug worth apologising for.
   */
  private static retune(): void {
    const tracks = new Set<MediaStreamTrack>();
    let want: "low" | "full" | null = null;
    for (const c of Call.live) {
      const t = c.local?.getVideoTracks()[0];
      if (t) tracks.add(t);
      if (c.send === "full") want = "full";
      else if (c.send === "low" && want !== "full") want = "low";
    }
    // Every live call is voice-only: leave the camera exactly as whoever opened it left it. Closing
    // it is the call UI's decision, not ours — we do not own it and it may be feeding a preview.
    if (!want) return;
    for (const t of tracks) void shapeCapture(t, want);
  }

  /** A peer joined or left: the uplink is divided differently now, for everybody. */
  private static rebalance(): void {
    Call.retune();
    for (const c of Call.live) void c.applySend();
  }

  /** Resolve once ICE has gathered everything it is going to, or GATHER_MS passes. */
  private gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", check); resolve(); };
      const check = () => { if (pc.iceGatheringState === "complete") finish(); };
      const timer = setTimeout(finish, GATHER_MS);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  /**
   * Which mode the SDP RAILS are written for — deliberately not the mode we are sending at.
   *
   * An SDP bandwidth line cannot be revised without a renegotiation, and renegotiation here costs a
   * poll interval on a sealed message thread. So the rail is cut for the BEST this call could ever
   * become: writing the voice-mode rail into a call that later climbs back to a picture would cap
   * that picture at 64 kbit/s for the rest of the call, with nothing in the live encoder plan able
   * to explain why. Never below "low" for the same reason. The live limit is `setParameters`.
   */
  private railMode(): SendMode {
    return BY_RUNG[Math.max(RUNG[this.send], RUNG[this.ceiling()], RUNG.low)];
  }

  /** Apply our own description, tuned — falling back to the untouched one if this browser refuses
   *  the edit. A munged SDP is an optimisation; connecting is not. */
  private async setLocal(pc: RTCPeerConnection, d: RTCSessionDescriptionInit): Promise<void> {
    const tuned = tuneSdp(d.sdp, this.send, "in", this.railMode());
    if (tuned && tuned !== d.sdp) {
      try { await pc.setLocalDescription({ type: d.type, sdp: tuned }); return; }
      catch { /* strict browser: use what it gave us */ }
    }
    await pc.setLocalDescription(d);
  }

  /** Same, for their description — which is what tells OUR encoder to use FEC, DTX and mono. */
  private async setRemote(pc: RTCPeerConnection, d: RTCSessionDescriptionInit): Promise<void> {
    const tuned = tuneSdp(d.sdp, this.send, "out", this.railMode());
    if (tuned && tuned !== d.sdp) {
      try { await pc.setRemoteDescription({ type: d.type, sdp: tuned }); return; }
      catch { /* strict browser: use what they sent */ }
    }
    await pc.setRemoteDescription(d);
  }

  /** CALLER: build the offer, candidates and all. The returned SDP is what gets sealed and sent. */
  async offer(video = true, shared?: MediaStream): Promise<string> {
    // A caller who asks for a voice call is stating a PREFERENCE, not reporting a symptom — so it
    // becomes the mode, and the recovery ladder can never quietly turn their camera on later.
    if (!video) this.pref = this.send = "audio";
    const pc = this.setup();
    const s = shared ? this.adopt(shared) : await this.media(video);
    this.attach(pc, s);
    await this.setLocal(pc, await pc.createOffer());
    Call.rebalance();
    await this.gathered(pc);
    this.h.onState("calling");
    return JSON.stringify(pc.localDescription);
  }

  /** CALLEE: take their offer and produce an answer. */
  async answer(offerSdp: string, video = true, shared?: MediaStream): Promise<string> {
    if (!video) this.pref = this.send = "audio";   // as in offer(): their ask, not our diagnosis
    const pc = this.setup();
    await this.setRemote(pc, JSON.parse(offerSdp) as RTCSessionDescriptionInit);
    const s = shared ? this.adopt(shared) : await this.media(video);
    this.attach(pc, s);
    await this.setLocal(pc, await pc.createAnswer());
    Call.rebalance();
    await this.gathered(pc);
    this.h.onState("connecting");
    return JSON.stringify(pc.localDescription);
  }

  /** CALLER: apply their answer. After this ICE connects the two directly. */
  async accept(answerSdp: string): Promise<void> {
    if (!this.pc || this.done) return;
    // Late or duplicate answers are ignored rather than throwing: the thread poll can legitimately
    // hand us the same sealed row twice, and setRemoteDescription in the wrong state is fatal.
    if (this.pc.signalingState !== "have-local-offer") return;
    await this.setRemote(this.pc, JSON.parse(answerSdp) as RTCSessionDescriptionInit);
    // The encoder plan only becomes settable once the sender has negotiated parameters.
    void this.applySend();
    this.h.onState("connecting");
  }

  /* ── ADAPTING ─────────────────────────────────────────────────────────────────────────────── */

  private startSampling(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => { void this.sample(); }, STATS_MS) as unknown as number;
  }

  /**
   * Read the link and, if it has been genuinely bad for long enough, step down the ladder.
   *
   * Loss is measured from `remote-inbound-rtp` — the receiver's own report of what failed to
   * arrive, which is the only honest source for it — and as a DELTA over the interval, because the
   * cumulative counter would keep punishing a call for a lift it went through ten minutes ago.
   */
  private async sample(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.done) return;
    let stats: RTCStatsReport;
    try { stats = await pc.getStats(); } catch { return; }
    if (this.done) return;

    let rtt = 0, avail = 0, bytes = 0, sent = 0, lost = 0;
    stats.forEach((raw) => {
      const r = raw as unknown as Record<string, unknown>;
      const type = String(r.type);
      if (type === "outbound-rtp") {
        bytes += num(r.bytesSent);
        sent += num(r.packetsSent);
      } else if (type === "remote-inbound-rtp") {
        lost += num(r.packetsLost);
        rtt = Math.max(rtt, num(r.roundTripTime) * 1000);
      } else if (type === "candidate-pair" && (r.nominated === true || r.state === "succeeded")) {
        avail = Math.max(avail, num(r.availableOutgoingBitrate) / 1000);
        if (rtt === 0) rtt = num(r.currentRoundTripTime) * 1000;
      }
    });

    const at = Date.now();
    const prev = this.prev;
    this.prev = { at, bytes, sent, lost };
    if (!prev) return;                                   // one sample is a number, not a trend
    const secs = Math.max(0.5, (at - prev.at) / 1000);
    const dSent = Math.max(0, sent - prev.sent);
    // packetsLost is allowed to go DOWN (a late packet arrives), and a negative loss rate is not a
    // thing — clamp rather than report a link as impossibly good.
    const dLost = Math.max(0, lost - prev.lost);
    const measured = ((bytes - prev.bytes) * 8) / 1000 / secs;
    // DTX MAKES A SILENT SPEAKER LOOK LIKE A BROKEN LINK. This same file turns Opus discontinuous
    // transmission on, so a member who is listening rather than talking sends almost nothing — and
    // two stray losses out of five packets is 40%, which would shed everyone's video because
    // somebody stopped speaking. Below a floor of packets the sample says nothing and is reported
    // as nothing.
    const seen = dSent + dLost;
    const lossPct = seen >= LOSS_FLOOR ? (dLost / seen) * 100 : 0;
    const kbps = avail > 0 ? avail : measured;

    this.lastRtt = rtt; this.lastLoss = lossPct; this.lastKbps = kbps;
    if (!this.applied) void this.applySend();   // the plan never landed — keep offering it

    // THE BANDWIDTH NUMBER IS ONLY EVIDENCE WHILE THERE IS VIDEO ON THE WIRE. A browser's estimate
    // follows what it is actually sending, so a voice-only call sits at ~40 kbit/s of "available"
    // bandwidth on a perfect fibre link. Judging that would condemn every call that shed its video
    // to stay voice-only forever, which is exactly the bug that makes automatic quality hated.
    // Loss and round trip stay meaningful with no video, so recovery is decided on those.
    const carrying = this.send !== "audio" && !!this.videoSender?.track;
    const wantKbps = carrying && this.send !== "audio" ? Call.videoPlan(this.send).bps / 1000 : 0;
    const level = classify(rtt, lossPct, carrying ? kbps : 0, wantKbps);
    this.bad = level >= 2 ? this.bad + 1 : 0;
    this.hurt = level >= 1 ? this.hurt + 1 : 0;
    this.good = level === 0 ? this.good + 1 : 0;

    const top = RUNG[this.ceiling()];
    const now = RUNG[this.send];
    let target = now;
    if (this.bad >= DOWN_SAMPLES) target = 0;                              // the words are at risk
    else if (this.hurt >= STRAIN_SAMPLES && now > 1) target = 1;           // shrink before shedding
    else if (this.good >= this.recoverAt && now < top) target = now + 1;   // earn it back, slowly
    if (target > top) target = top;

    if (target !== now) {
      if (target < now && this.climbed) {
        // We put this back once and the link took it away again: assume the next recovery is also
        // premature, and make it prove itself for twice as long. This is the anti-flap.
        this.recoverAt = Math.min(this.recoverAt * 2, RECOVER_MAX);
      }
      if (target > now) this.climbed = true;
      this.send = BY_RUNG[target];
      this.bad = this.hurt = this.good = 0;
      await this.applySend();
      Call.retune();
    }
    this.emit(rtt, lossPct, kbps);
  }

  /** Why the picture is not what the member asked for, in words they can read. Empty when there is
   *  nothing to explain — including when they chose voice themselves. */
  private reason(): string {
    const want = RUNG[this.ceiling()];
    const have = RUNG[this.send];
    if (have >= want) return "";
    if (have === 0) return "Video is off while your connection is weak — the sound comes first";
    return "Your connection is under strain, so the picture is smaller — the sound is unaffected";
  }

  private emit(rtt: number, lossPct: number, kbps: number): void {
    if (this.done || !this.h.onLink) return;
    this.h.onLink({
      rttMs: Math.round(rtt),
      lossPct: Math.round(lossPct * 10) / 10,
      kbps: Math.round(kbps),
      sending: this.send,
      videoOn: !!this.videoSender?.track,
      reason: this.reason(),
    });
  }

  /** Mute/unmute the microphone. Returns the new enabled state. */
  toggleMic(): boolean {
    const t = this.local?.getAudioTracks()[0];
    if (!t) return false;
    t.enabled = !t.enabled;
    return t.enabled;
  }

  /**
   * Swap the outgoing video track — screen sharing, without renegotiating.
   *
   * `RTCRtpSender.replaceTrack` changes what is being sent on an ESTABLISHED connection with no new
   * offer/answer, so a share starts instantly and cannot fail the way a fresh handshake can. The
   * receiving side sees the picture change and nothing else.
   *
   * While video is shed the new track is REMEMBERED rather than sent: the link is not able to carry
   * a picture, and a screen share is a picture. It goes out by itself the moment video returns.
   */
  replaceVideo(track: MediaStreamTrack): void {
    this.videoTrack = track;
    if (this.send === "audio") return;
    this.videoSender?.replaceTrack(track).catch(() => undefined);
  }

  /** Camera on/off. Returns the new enabled state. */
  toggleCam(): boolean {
    const t = this.local?.getVideoTracks()[0];
    if (!t) return false;
    t.enabled = !t.enabled;
    return t.enabled;
  }

  /**
   * Tear everything down.
   *
   * STOPPING THE TRACKS IS THE LOAD-BEARING PART. Closing the peer connection alone leaves the
   * camera and microphone open — the hardware light stays on after a call the member believes they
   * have left, which is the single worst thing a calling feature can do.
   */
  close(): void {
    if (this.done) return;
    this.done = true;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    netInfo()?.removeEventListener?.("change", this.onNetChange);
    Call.live.delete(this);
    if (this.ownsMedia) this.local?.getTracks().forEach((t) => t.stop());
    this.remote?.getTracks().forEach((t) => t.stop());
    try { this.pc?.close(); } catch { /* already gone */ }
    this.pc = null;
    this.local = null;
    this.remote = null;
    this.audioSender = null;
    this.videoSender = null;
    this.videoTrack = null;
    this.h.onLocal(null);
    this.h.onRemote(null);
    this.h.onState("ended");
    // One fewer uplink to divide the budget between: everybody still talking gets their share back.
    Call.rebalance();
  }
}

/** A call session id: distinguishes this call from an earlier one in the same conversation, so
 *  signalling left over from a call that already ended is ignored instead of half-reviving it. */
export function newCallSid(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** True when this browser can place a call at all — WebRTC plus a camera/mic API, over HTTPS. */
export function callSupported(): boolean {
  return typeof RTCPeerConnection !== "undefined"
    && typeof navigator !== "undefined"
    && !!navigator.mediaDevices?.getUserMedia;
}

/** Why getUserMedia refused, in words a member can act on. */
export function mediaErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name || "";
  if (name === "NotAllowedError") return "Your browser blocked the camera and microphone. Allow them for artaquest.com and try again.";
  if (name === "NotFoundError") return "No camera or microphone found on this device.";
  if (name === "NotReadableError") return "Your camera or microphone is already in use by another app.";
  return "Couldn’t start your camera and microphone.";
}
