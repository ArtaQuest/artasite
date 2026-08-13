import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  roomsCall, roomsInvite, roomsLeave, roomsMessages, roomsMute, roomsSend,
  type Room, type RoomCipherMsg,
} from "../../lib/api";
import { distributeRoomKey, forgetRoomKey, roomKey } from "../../lib/rooms";
import {
  decodePayload, encodePayload, openRoomMessage, sealRoomMessage,
  type ChatPayload,
} from "../../lib/e2ee";
import { Avatar, ErrorNote, Input } from "../ui";
import { watchMath } from "../../lib/math";
import { MessageBody } from "./MessageBody";
import { insideFence } from "./fence";

/**
 * A ROOM — a conversation with N people in it, and the place a call lives.
 *
 * The pair thread (pages/Messages DmThread) cannot serve this: it derives one key from exactly two
 * device keys, and three people have no "the other one". A room instead has ONE symmetric key
 * (lib/rooms), so this component's job is narrower than the DM's — fetch, open with that key, draw.
 *
 * A ROOM WITH ONE MEMBER IS NOT A DEGENERATE CASE. It is a member's own space: somewhere to open a
 * camera and sit, and then invite people into. Everything below therefore has to read sensibly at
 * count = 1, which is why the empty state invites rather than apologising.
 *
 * ⚠️ `data-ay-skip="1"` IS PART OF THE ENCRYPTION here exactly as in the DM thread: the i18n mesh
 * walks the DOM and PERSISTS what it finds into the public aq_translations table, so every element
 * that can hold decrypted text or a member's name carries the marker, on wrappers rather than
 * leaves.
 */

type Row = { id: number; sender: number; at: number; payload: ChatPayload | null; pending?: boolean };

const POLL_MS = 4000;
const CALL_POLL_MS = 1500;

function fmtTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Payload kinds that are call machinery rather than something a member said. */
// Machinery, not conversation. "link" joins this list for the reason the others are on it: a call
// publishes a link score into the room, and RoomThread loads the newest 50 rows and never pages
// back — so a minute into a four-way call every one of those 50 rows was a beacon, all filtered
// here, and the transcript beside the call rendered EMPTY. A message stream is for what people said.
const SIGNAL_ONLY = new Set(["rtc", "draw", "point", "hand", "timer", "link"]);

export function RoomThread({
  roomId, me: meProp, onLeave, compact = false, managed = false, renderCall,
}: {
  roomId: number;
  /** A hint only — see `me` below. */
  me: number;
  onLeave: () => void;
  compact?: boolean;
  /** True when something ELSE owns this room's membership — ArtaMeet, whose guest list is the only
   *  door into a meeting. Hides the room-management controls, because there they are not merely
   *  redundant but destructive: "Leave room" forgets the room key and locks the member out of a
   *  meeting they were invited to, with no way back in, and "Invite someone" walks straight past the
   *  guest list, the host-only invite rule and the seat cap. */
  managed?: boolean;
  /** The call surface, supplied by the page so this component owns no WebRTC. `me` is handed OUT
   *  rather than read by the page: the page's own copy comes from the chat store's conversation
   *  list, which on the Rooms tab may never have loaded — it was 0, so the call never rendered. */
  renderCall?: (room: Room, key: CryptoKey | null, me: number, leaveCall: () => void) => React.ReactNode;
}) {
  /**
   * WHO I AM, from the room API rather than the prop.
   *
   * The page derives its `me` from the chat store's conversation list, which on the Rooms tab may
   * not have loaded at all — so it was 0, `members[0].id === me` was never true, and a brand-new
   * room never minted its key. Every room response carries `me`, and that is always right.
   */
  const [me, setMe] = useState(meProp);
  const [room, setRoom] = useState<Room | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [noKey, setNoKey] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [panel, setPanel] = useState<"" | "people" | "invite">("");
  const [invite, setInvite] = useState("");
  const lastId = useRef(0);
  /**
   * THE CURRENT ROOM'S KEY, in a ref rather than read from the poll closure.
   *
   * `key` state is captured when the effect is created, and `setKey(null)` inside the effect body
   * runs AFTER that capture — so switching rooms left the PREVIOUS room's key in the closure. The
   * new room then looked like it already had one: it never minted its own, and would have gone on
   * to try opening its messages with a key belonging to a different room.
   */
  const keyRef = useRef<CryptoKey | null>(null);
  /** Whether a call is up, for the POLL SCHEDULER, which reads it outside React's render cycle.
   *  Read from the closure it was always the value at effect creation — false — so the fast
   *  signalling cadence never actually engaged and a three-way handshake crawled at 4s a hop. */
  const inCallRef = useRef(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  // WATCH THE STREAM ONCE, AND DISCONNECT IT. This used to hang off an INLINE REF CALLBACK,
  // which React re-invokes on every render because the arrow is a new function each time — so
  // a busy conversation built one MutationObserver per render on the same node and threw away
  // every cleanup function watchMath returned. An effect runs it once per mount and hands the
  // disconnect back to React, which is the only arrangement where the teardown actually runs.
  useEffect(() => watchMath(scroller.current, "auto"), []);
  const inCall = !!room?.in_call.includes(me);

  const open = useCallback(async (items: RoomCipherMsg[], k: CryptoKey): Promise<Row[]> => {
    const out: Row[] = [];
    for (const m of items) {
      const plain = await openRoomMessage(k, m.iv, m.ct, roomId, m.sender);
      out.push({ id: m.id, sender: m.sender, at: m.at, payload: plain === null ? null : decodePayload(plain) });
    }
    return out;
  }, [roomId]);

  // Load + poll. Faster while a call is up, for the same reason the DM does it: the handshake
  // travels as room messages, so the poll IS the signalling channel.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    async function tick(first: boolean) {
      if (inFlight) return;
      inFlight = true;
      timer = undefined;
      try {
        const page = await roomsMessages(roomId, first ? {} : { after: lastId.current });
        if (stop) return;
        setRoom(page.room);
        if (page.me) setMe(page.me);
        let k = keyRef.current;
        if (!k && page.me) {
          k = await roomKey(page.room, page.me);
          if (stop) return;
          keyRef.current = k;
          setKey(k);
          setNoKey(!k);
          // Any member holding the key completes an invite — see distributeRoomKey.
          if (k) void distributeRoomKey(page.room, page.me);
        }
        if (k && page.items.length) {
          const ordered = first ? [...page.items].reverse() : page.items;
          lastId.current = Math.max(lastId.current, ...ordered.map((m) => m.id));
          const opened = await open(ordered, k);
          if (stop) return;
          setRows((cur) => {
            const seen = new Set(cur.map((r) => r.id));
            const fresh = opened.filter((r) => !seen.has(r.id));
            return fresh.length ? [...cur.filter((r) => r.id > 0), ...fresh] : cur;
          });
        }
        setNote(null);
      } catch {
        if (!stop) setNote("Couldn’t reach the room — retrying.");
      }
      inFlight = false;
      if (!stop && !timer && !document.hidden) {
        timer = setTimeout(() => tick(false), inCallRef.current ? CALL_POLL_MS : POLL_MS);
      }
    }
    setRows([]); setKey(null); setNoKey(false); lastId.current = 0;
    keyRef.current = null;   // a different room has a different key — never carry one across
    tick(true);
    const onVis = () => { if (!document.hidden && !timer && !inFlight) void tick(false); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
    // `key`/`inCall` are read through the closure deliberately: re-creating this effect on either
    // would restart the poll (and the load) mid-conversation.
     
  }, [roomId, me, open]);

  useEffect(() => { inCallRef.current = inCall; }, [inCall]);

  // Stick to the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const nameOf = useMemo(() => {
    const m = new Map<number, { name: string; avatar: string }>();
    for (const p of room?.members || []) m.set(p.id, { name: p.name, avatar: p.avatar });
    return m;
  }, [room]);

  async function send() {
    const text = draft.trim();
    if (!text || busy || !key || !room) return;
    setBusy(true);
    try {
      const payload: ChatPayload = { v: 2, t: "text", body: text };
      const sealed = await sealRoomMessage(key, encodePayload(payload), roomId, me);
      const r = await roomsSend(roomId, { ...sealed, notify: 1 });
      lastId.current = Math.max(lastId.current, r.id);
      setRows((cur) => [...cur, { id: r.id, sender: me, at: r.at, payload }]);
      setDraft("");
    } catch {
      setNote("That didn’t send — try again.");
    }
    setBusy(false);
  }

  async function addMember() {
    const handle = invite.trim().replace(/^@/, "");
    if (!handle || !room) return;
    setBusy(true);
    try {
      const r = await roomsInvite(roomId, handle);
      setRoom(r.room);
      setInvite("");
      setPanel("people");
      // Hand them the key immediately — they are in the room but cannot read it until somebody does.
      if (key) void distributeRoomKey(r.room, me);
    } catch (e) {
      setNote(e instanceof Error && e.message ? e.message : "Couldn’t add that member.");
    }
    setBusy(false);
  }

  /** Leave the call. The call surface unmounts when the roster no longer names me, and ITS cleanup
   *  is what stops the camera — so this has to update the roster, not just hide something. */
  async function leaveCall() {
    const r = await roomsCall(roomId, "leave").catch(() => null);
    setRoom((cur) => (cur ? { ...cur, in_call: r?.in_call ?? cur.in_call.filter((u) => u !== me) } : cur));
  }

  async function toggleCall() {
    if (!room) return;
    try {
      const r = await roomsCall(roomId, inCall ? "leave" : "join");
      setRoom((cur) => (cur ? { ...cur, in_call: r.in_call } : cur));
    } catch (e) {
      setNote(e instanceof Error && e.message ? e.message : "Couldn’t join the call.");
    }
  }

  if (!room) {
    return <div className="grid flex-1 place-items-center p-8 text-[13px] text-ink-3">Opening the room…</div>;
  }

  const alone = room.count === 1;
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden bg-space-2 ${
      compact ? "flex-1" : "h-[calc(100dvh-10.5rem)] min-h-[380px] md:h-auto md:min-h-0 md:flex-1 rounded-card border border-line shadow-card"}`}
      aria-label="Room">

      <header className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
        <button type="button" onClick={onLeave} aria-label="Back"
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-veil/[0.07] ${compact ? "hidden" : "md:hidden"}`}>‹</button>
        <span className="min-w-0 flex-1" data-ay-skip="1">
          <span className="block truncate text-[15px] font-semibold text-ink">{room.title}</span>
          <span className="block truncate text-[11.5px] text-ink-3">
            {room.count} {room.count === 1 ? "member" : "members"}
            {room.in_call.length > 0 ? ` · ${room.in_call.length} in the call` : ""}
          </span>
        </span>
        <button type="button" onClick={() => void toggleCall()}
          className={`rounded-pill px-3 py-1.5 text-[12px] font-bold transition-opacity hover:opacity-90 ${
            inCall ? "border border-line text-ink-2" : "bg-yang text-on-accent"}`}>
          {inCall ? "Leave call" : room.in_call.length ? "Join call" : "Start a call"}
        </button>
        <button type="button" aria-label="People in this room" aria-expanded={panel === "people"}
          onClick={() => setPanel((p) => (p === "people" ? "" : "people"))}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-veil/[0.07] hover:text-ink">⋯</button>
      </header>

      {panel === "people" && (
        <div className="border-b border-line px-3 py-2.5" data-ay-skip="1">
          <ul className="flex flex-wrap gap-2">
            {room.members.map((p) => (
              <li key={p.id} className="flex items-center gap-1.5 rounded-pill border border-line px-2 py-1">
                <Avatar src={p.avatar} name={p.name} className="h-5 w-5" />
                <span className="text-[12px] text-ink-2">{p.name}</span>
                {p.role === "owner" && <span className="text-[10px] uppercase tracking-wide text-ink-3">owner</span>}
              </li>
            ))}
          </ul>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {!managed && (
              <button type="button" onClick={() => setPanel("invite")}
                className="rounded-pill bg-yang px-3 py-1 text-[12px] font-bold text-on-accent hover:opacity-90">Invite someone</button>
            )}
            <button type="button" onClick={() => void roomsMute(roomId, !room.muted).then(() => setRoom({ ...room, muted: !room.muted }))}
              className="rounded-pill border border-line px-3 py-1 text-[12px] font-semibold text-ink-2 hover:text-ink">
              {room.muted ? "Unmute" : "Mute"}
            </button>
            {!managed && (
              <button type="button"
                onClick={() => void roomsLeave(roomId).then(() => { forgetRoomKey(roomId); onLeave(); })}
                className="rounded-pill border border-line px-3 py-1 text-[12px] font-semibold text-yang hover:opacity-90">Leave room</button>
            )}
          </div>
        </div>
      )}

      {panel === "invite" && (
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="@username"
            aria-label="Invite a member by username"
            onKeyDown={(e) => { if (e.key === "Enter") void addMember(); }} />
          <button type="button" onClick={() => void addMember()} disabled={busy || !invite.trim()}
            className="shrink-0 rounded-pill bg-yang px-3.5 py-1.5 text-[12.5px] font-bold text-on-accent disabled:opacity-40">Add</button>
        </div>
      )}

      {renderCall?.(room, key, me, leaveCall)}

      {/* watchMath typesets LaTeX as it arrives and re-typesets if React re-renders over it — the
          same watcher the DM thread uses, so there is one maths implementation, not two. */}
      <div ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {noKey && !alone ? (
          <p className="py-10 text-center text-[13px] leading-relaxed text-ink-3">
            You’re in this room, but nobody has handed your device the key yet. It arrives the moment another
            member opens the room — nothing here can be read until then, including by us.
          </p>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-[13px] leading-relaxed text-ink-3">
            {alone
              ? "This room is yours. Sit here with the camera on, or invite someone in — it works the same with one person or five."
              : "Nothing said yet. Everything sent here is sealed with the room’s own key before it leaves your device."}
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5" data-ay-skip="1">
            {rows.map((r, i) => {
              // MACHINERY IS NOT CONVERSATION. Every WebRTC offer, whiteboard stroke, raised hand and
              // timer travels as an ordinary sealed room message, and this list drew each one as an
              // empty "…" bubble — so a call filled its own transcript with hundreds of them.
              // pages/Messages.tsx has always skipped these in DMs; rooms simply never did.
              if (r.payload && SIGNAL_ONLY.has(r.payload.t)) return null;
              const mine = r.sender === me;
              const who = nameOf.get(r.sender);
              const grouped = i > 0 && rows[i - 1].sender === r.sender && r.at - rows[i - 1].at < 300;
              const body = r.payload && r.payload.t === "text" ? r.payload.body : null;
              return (
                <li key={r.id} className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
                  {!mine && (
                    <span className="w-7 shrink-0">
                      {!grouped && <Avatar src={who?.avatar} name={who?.name} className="h-7 w-7" />}
                    </span>
                  )}
                  <span className={`max-w-[76%] rounded-card px-3 py-2 text-[14.5px] leading-relaxed ${
                    mine ? "bg-yin/20 text-ink" : "bg-veil/[0.07] text-ink"} ${r.pending ? "opacity-70" : ""}`}>
                    {!mine && !grouped && (
                      <span className="mb-0.5 block text-[11.5px] font-semibold text-ink-3">{who?.name || "Member"}</span>
                    )}
                    {r.payload === null
                      ? <span className="italic text-ink-3">Sealed with a key this device doesn’t have.</span>
                      : <span className="aq-msg block">{body ? <MessageBody text={body} /> : "…"}</span>}
                    <span className="mt-0.5 block text-end text-[10.5px] text-ink-3">{fmtTime(r.at)}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <footer className="border-t border-line p-2.5">
        {note && <ErrorNote className="mb-2">{note}</ErrorNote>}
        {key ? (
          <div className="flex items-end gap-1.5">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={1} maxLength={4000}
              placeholder={alone ? "Leave yourself a note…" : "Message the room…"}
              aria-label="Room message" dir="auto"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !insideFence(draft)) { e.preventDefault(); void send(); } }}
              className="max-h-[120px] min-h-[42px] flex-1 resize-none rounded-field border border-line bg-space-1 px-3.5 py-2.5 text-[14.5px] leading-snug text-ink outline-none placeholder:text-ink-2 focus:border-yin-light" />
            <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()} aria-label="Send"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-yang text-on-accent disabled:opacity-40">→</button>
          </div>
        ) : (
          <p className="px-1 text-[12.5px] text-ink-3">
            {alone ? "Setting up this room’s key…" : "Waiting for another member to hand your device the room key."}
          </p>
        )}
      </footer>
    </section>
  );
}
