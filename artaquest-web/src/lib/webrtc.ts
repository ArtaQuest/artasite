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
  onRemote: (stream: MediaStream | null) => void;
  onLocal: (stream: MediaStream | null) => void;
};

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

  constructor(sid: string, h: CallHandlers) {
    this.sid = sid;
    this.h = h;
  }

  /** True once this call has been closed — callers use it to ignore late signalling. */
  get closed() { return this.done; }

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
    return pc;
  }

  /** Camera + microphone. Separated so a permission refusal is reported as itself, not as a
   *  mysterious failure to connect. */
  private async media(video: boolean): Promise<MediaStream> {
    if (this.local) return this.local;
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
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

  /** CALLER: build the offer, candidates and all. The returned SDP is what gets sealed and sent. */
  async offer(video = true, shared?: MediaStream): Promise<string> {
    const pc = this.setup();
    const s = shared ? this.adopt(shared) : await this.media(video);
    s.getTracks().forEach((t) => pc.addTrack(t, s));
    await pc.setLocalDescription(await pc.createOffer());
    await this.gathered(pc);
    this.h.onState("calling");
    return JSON.stringify(pc.localDescription);
  }

  /** CALLEE: take their offer and produce an answer. */
  async answer(offerSdp: string, video = true, shared?: MediaStream): Promise<string> {
    const pc = this.setup();
    await pc.setRemoteDescription(JSON.parse(offerSdp) as RTCSessionDescriptionInit);
    const s = shared ? this.adopt(shared) : await this.media(video);
    s.getTracks().forEach((t) => pc.addTrack(t, s));
    await pc.setLocalDescription(await pc.createAnswer());
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
    await this.pc.setRemoteDescription(JSON.parse(answerSdp) as RTCSessionDescriptionInit);
    this.h.onState("connecting");
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
   */
  replaceVideo(track: MediaStreamTrack): void {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === "video");
    sender?.replaceTrack(track).catch(() => undefined);
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
    if (this.ownsMedia) this.local?.getTracks().forEach((t) => t.stop());
    this.remote?.getTracks().forEach((t) => t.stop());
    try { this.pc?.close(); } catch { /* already gone */ }
    this.pc = null;
    this.local = null;
    this.remote = null;
    this.h.onLocal(null);
    this.h.onRemote(null);
    this.h.onState("ended");
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
