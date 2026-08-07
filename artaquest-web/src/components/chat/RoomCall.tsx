import { useEffect, useRef, useState } from "react";
import { roomsCall, roomsMessages, roomsSend, type Room } from "../../lib/api";
import {
  decodePayload, encodePayload, openRoomMessage, sealRoomMessage,
  type ChatPayload,
} from "../../lib/e2ee";
import { Call, callSupported, mediaErrorMessage, newCallSid } from "../../lib/webrtc";
import { Avatar } from "../ui";
import { Whiteboard, type Stroke } from "./Whiteboard";

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
 * GLARE. Two peers who both offer at the same moment end up with two half-negotiated connections
 * and no call. The tie-break is arithmetic rather than timing: THE LOWER USER ID OFFERS, the higher
 * one waits and answers. No negotiation about who negotiates.
 *
 * SIGNALLING rides the room's own sealed messages, so a handshake is as private as the conversation
 * — and `to` addresses each offer at one participant, since in a mesh "an offer" is never for
 * everybody.
 */

type Peer = { uid: number; call: Call; stream: MediaStream | null; state: string };

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
  const [board, setBoard] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const camTrack = useRef<MediaStreamTrack | null>(null);
  const calls = useRef(new Map<number, Call>());
  const seen = useRef(new Set<number>());
  const media = useRef<MediaStream | null>(null);
  const lastSig = useRef(0);
  const sid = useRef(newCallSid());

  // The roster from OUR OWN refresh takes precedence over the parent's slower poll.
  const [roster, setRoster] = useState<number[]>(room.in_call);
  useEffect(() => { setRoster((cur) => (cur.join() === room.in_call.join() ? cur : room.in_call)); }, [room.in_call]);
  const others = roster.filter((u) => u !== me);

  /** Seal one signalling payload into the room, addressed at one participant. */
  async function signal(p: ChatPayload) {
    if (!roomKey) return;
    const sealed = await sealRoomMessage(roomKey, encodePayload(p), room.id, me);
    // notify 0: a handshake must never ring anybody's bell.
    await roomsSend(room.id, { ...sealed, notify: 0 }).catch(() => undefined);
  }

  /** Open the camera once and share it across every peer connection. */
  async function localMedia(): Promise<MediaStream | null> {
    if (media.current) return media.current;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: { ideal: 640 }, height: { ideal: 360 } },
      });
      media.current = s;
      setLocal(s);
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
    } catch { /* the picker was dismissed — not an error */ }
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
    const c = new Call(sid.current + ":" + uid, {
      onState: (st) => setPeers((cur) => (cur[uid] ? { ...cur, [uid]: { ...cur[uid], state: st } } : cur)),
      onRemote: (stream) => setPeers((cur) => (cur[uid] ? { ...cur, [uid]: { ...cur[uid], stream } } : cur)),
      onLocal: () => {},
    });
    calls.current.set(uid, c);
    setPeers((cur) => ({ ...cur, [uid]: { uid, call: c, stream: null, state: "connecting" } }));
    return c;
  }

  // Join the roster, and keep it warm — the beacon expires, so it must be refreshed.
  useEffect(() => {
    if (!callSupported()) { setErr("This browser can’t make calls."); return; }
    void localMedia();
    void roomsCall(room.id, "join").then((r) => setRoster(r.in_call)).catch(() => undefined);
    // Every 4s, not 12: this both refreshes the beacon AND returns the roster, which is what tells
    // us there is somebody new to offer a connection to. At 12s a third person joining a call took
    // long enough to look broken.
    const t = setInterval(() => { void roomsCall(room.id, "join").then((r) => setRoster(r.in_call)).catch(() => undefined); }, 4000);
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
    // Somebody left: drop their connection rather than holding a dead one open.
    for (const [uid, c] of calls.current) {
      if (!others.includes(uid)) { c.close(); calls.current.delete(uid); setPeers((cur) => { const n = { ...cur }; delete n[uid]; return n; }); }
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
            else if (p.stroke) setStrokes((cur) => [...cur, p.stroke as Stroke]);
            continue;
          }
          if (p.t !== "rtc" || p.to !== me) continue;   // in a mesh, an offer is for ONE person
          if (p.kind === "offer" && p.sdp) {
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
            setPeers((cur) => { const n = { ...cur }; delete n[m.sender]; return n; });
          }
        }
      } catch { /* transient */ }
    }, 1500);
    return () => { stop = true; clearInterval(t); };
  }, [room.id, roomKey, me]);

  const tiles = Object.values(peers);
  const cols = tiles.length <= 1 ? 1 : tiles.length <= 3 ? 2 : 3;

  return (
    <section className="border-b border-line bg-space-1" aria-label="Room call">
      <div className={`grid gap-1 p-1 ${cols === 1 ? "grid-cols-1" : cols === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
        <Tile stream={local} label="You" muted mirror name="You" />
        {tiles.map((p) => {
          const who = room.members.find((m) => m.id === p.uid);
          return <Tile key={p.uid} stream={p.stream} label={who?.name || "Member"} name={who?.name} avatar={who?.avatar} state={p.state} />;
        })}
      </div>
      {board && (
        <Whiteboard strokes={strokes}
          onStroke={(st) => { setStrokes((cur) => [...cur, st]); void signal({ v: 2, t: "draw", stroke: st }); }}
          onClear={() => { setStrokes([]); void signal({ v: 2, t: "draw", clear: true }); }} />
      )}
      {err && <p className="px-3 py-1.5 text-[12px] text-yang">{err}</p>}
      <div className="flex items-center gap-2 px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
          {tiles.length === 0
            ? "You’re the only one here — invite someone, or just sit for a while."
            : `Direct between all ${tiles.length + 1} of you — no server in between`}
        </p>
        <button type="button" onClick={() => { setMicOn((v) => { media.current?.getAudioTracks().forEach((t) => (t.enabled = !v)); return !v; }); }}
          className={`rounded-pill px-3 py-1 text-[12px] font-semibold ${micOn ? "border border-line text-ink-2" : "bg-yang text-on-accent"}`}>
          {micOn ? "Mute" : "Unmute"}
        </button>
        <button type="button" onClick={() => { setCamOn((v) => { media.current?.getVideoTracks().forEach((t) => (t.enabled = !v)); return !v; }); }}
          className={`rounded-pill px-3 py-1 text-[12px] font-semibold ${camOn ? "border border-line text-ink-2" : "bg-yang text-on-accent"}`}>
          {camOn ? "Camera off" : "Camera on"}
        </button>
        <button type="button" onClick={() => void toggleShare()}
          className={`rounded-pill px-3 py-1 text-[12px] font-semibold ${sharing ? "bg-yang text-on-accent" : "border border-line text-ink-2"}`}>
          {sharing ? "Stop sharing" : "Share screen"}
        </button>
        <button type="button" onClick={() => setBoard((v) => !v)}
          className={`rounded-pill px-3 py-1 text-[12px] font-semibold ${board ? "bg-yang text-on-accent" : "border border-line text-ink-2"}`}>
          Whiteboard
        </button>
        <button type="button" onClick={() => { void signal({ v: 2, t: "rtc", kind: "bye", sid: sid.current }); onLeft(); }}
          className="rounded-pill bg-yang px-3 py-1 text-[12px] font-bold text-on-accent">Leave</button>
      </div>
    </section>
  );
}

function Tile({ stream, label, muted, mirror, name, avatar, state }: {
  stream: MediaStream | null; label: string; muted?: boolean; mirror?: boolean;
  name?: string; avatar?: string; state?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) el.play().catch(() => undefined);
  }, [stream]);
  return (
    <div className="relative aspect-video overflow-hidden rounded-card bg-black/70">
      <video ref={ref} autoPlay playsInline muted={muted} aria-label={label}
        className={`h-full w-full object-cover ${mirror ? "-scale-x-100" : ""}`} />
      {!stream && (
        <div className="absolute inset-0 grid place-items-center" data-ay-skip="1">
          <div className="text-center">
            <Avatar src={avatar} name={name} className="mx-auto h-10 w-10" />
            <p className="mt-1 text-[11px] text-ink-3">{state === "failed" ? "Couldn’t connect" : "Connecting…"}</p>
          </div>
        </div>
      )}
      <span className="absolute bottom-1 start-1 rounded bg-black/60 px-1.5 py-0.5 text-[10.5px] text-white" data-ay-skip="1">{name || label}</span>
    </div>
  );
}
