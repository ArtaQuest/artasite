import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  chatEmailPrefs, chatGetKey, chatMembers, chatMessages, chatSend, chatSetTtl, chatTyping,
  chatUnsend, chatUploadBlob,
  type ChatDirectory, type ChatKey, type ChatListItem, type ChatMessages, type ChatUserCard,
} from "../lib/api";
import { currentUser, isLoggedIn, localePath } from "../lib/wp";
import { getChatState, markSeen, subscribeChat, watchList } from "../lib/chat-store";
import { watchMath } from "../lib/math";
import {
  decodePayload, deriveChatKey, encodePayload, importPeerPub,
  openAttachment, openMessage, safetyCode, sealAttachment, sealMessage,
  type ChatPayload, type Identity, type SealedAttachment,
} from "../lib/e2ee";
import { Avatar, Button, EmptyState, ErrorNote, Input, PageHero, StatusNote } from "../components/ui";

/**
 * Messages — end-to-end encrypted DMs. The best of every messenger, sealed on-device:
 * reactions, replies, edits, unsend, encrypted photos + videos + files + voice notes
 * (per-attachment keys), disappearing messages, typing/presence, read ticks, in-chat search,
 * safety codes. EVERY row
 * in the (fully public) database is an identical-looking AES-256-GCM ciphertext — a reaction
 * is indistinguishable from an essay. See lib/e2ee.ts for the construction.
 *
 * ⚠️ `data-ay-skip="1"` IS PART OF THE ENCRYPTION. For any non-English reader the i18n mesh walks
 * document.body, ships every string it finds to the translation service, and PERSISTS it in
 * aq_translations — a table the public /data explorer serves. Decrypted message text living in a
 * plain DOM node is therefore published in clear. Every element below that can hold decrypted
 * content or member identity carries the skip marker, and it is marked on WRAPPERS rather than
 * leaves so a new child element inside a bubble cannot silently start leaking. If you add anything
 * that renders a message, a preview, a quote or a filename, mark it too.
 */

const POLL_MS = 4000;
const GROUP_S = 300; // bubbles from the same sender within 5 min group together
const REACTIONS = ["❤️", "👍", "😂", "😮", "😢", "🔥"];
const EMOJI = [
  "😀", "😂", "🥲", "😍", "🤔", "😴", "🥳", "😭", "😅", "🙃", "😇", "🤯",
  "👍", "👎", "👏", "🙏", "💪", "🤝", "👀", "✨", "🔥", "❤️", "💙", "🌓",
];
const TTL_CHOICES = [
  { v: 0, label: "Keep forever" },
  { v: 3600, label: "1 hour" },
  { v: 86400, label: "24 hours" },
  { v: 604800, label: "1 week" },
];

type Item = {
  id: number; sender: number; at: number; payload: ChatPayload | null;
  pending?: boolean; failed?: boolean;
  /** Attachment reference of a failed send, kept so a retry re-uses the already-uploaded blob
   *  instead of sealing and uploading the bytes a second time. */
  blob?: string;
};

/** Current unix seconds. Module-scoped so the optimistic-bubble timestamp is read outside any
 *  render path — the value is only ever needed while handling a send. */
const nowSec = () => Math.floor(Date.now() / 1000);

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDay(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function ttlLabel(v: number): string {
  return TTL_CHOICES.find((t) => t.v === v)?.label ?? "Keep forever";
}


// ── tiny inline icons (currentColor, match the shell's stroke style) ─────────
function Ic({ d, size = 16 }: { d: React.ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
  );
}
const IC = {
  back: <path d="M15 5l-7 7 7 7" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  timer: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M9 2h6" /></>,
  shield: <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6Z" />,
  smile: <><circle cx="12" cy="12" r="9" /><path d="M8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></>,
  clip: <path d="M20.5 12.5 12.7 20.3a5.4 5.4 0 0 1-7.6-7.6l8.4-8.4a3.6 3.6 0 0 1 5.1 5.1l-8.4 8.4a1.8 1.8 0 0 1-2.6-2.6l7.8-7.7" />,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></>,
  mic: <><rect x="9.5" y="3" width="5" height="11" rx="2.5" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4" /></>,
  send: <path d="M4 12 20 4l-4 8 4 8Zm0 0h12" />,
  reply: <path d="M9 10 4 14l5 4v-3c6 0 9 1 11 4-1-6-4-9-11-9Z" transform="scale(1,-1) translate(0,-24)" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  down: <path d="M12 5v14m0 0 6-6m-6 6-6-6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  check1: <path d="M4.5 12.5l4 4L18 7" />,
  check2: <><path d="M3 12.5l4 4L16.5 7" /><path d="M10.5 15.5 12 17 21 7.5" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2.5" /></>,
};

/**
 * WhatsApp-style per-message status tick for one of MY bubbles:
 * clock = sealing/sending · ✓ = sent (on the server) · ✓✓ = delivered ({peer}'s device has been
 * active in Messages since) · ✓✓ in blue = read (their read watermark passed it).
 */
function Ticks({ pending, read, delivered }: { pending?: boolean; read: boolean; delivered: boolean }) {
  const label = pending ? "Sending" : read ? "Read" : delivered ? "Delivered" : "Sent";
  return (
    <span role="img" aria-label={label} title={label}
      className={`inline-flex shrink-0 ${read ? "text-yin-ink" : "text-ink-3"}`}>
      <Ic d={pending ? IC.clock : read || delivered ? IC.check2 : IC.check1} size={13} />
    </span>
  );
}

/** Auto-growing composer textarea (1→6 rows). */
function GrowingTextarea({ value, onChange, onKeyDown, onPaste, placeholder, disabled }: {
  value: string; onChange: (v: string) => void; onKeyDown: (e: React.KeyboardEvent) => void;
  onPaste?: (e: React.ClipboardEvent) => void; placeholder: string; disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 152) + "px";
  }, [value]);
  return (
    <textarea ref={ref} value={value} rows={1} maxLength={12000} placeholder={placeholder} disabled={disabled}
      aria-label="Encrypted message" dir="auto"
      onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste}
      className="max-h-[152px] min-h-[42px] flex-1 resize-none rounded-field border border-line bg-space-1 px-3.5 py-2.5 text-[14.5px] leading-snug text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-yin-light" />
  );
}

/** WhatsApp-style voice recorder button: tap to record, tap to send, × to discard. */
function VoiceButton({ disabled, onDone }: { disabled?: boolean; onDone: (blob: Blob, mime: string, dur: number) => void }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [secs, setSecs] = useState(0);
  const chunks = useRef<BlobPart[]>([]);
  const keep = useRef(false);
  const started = useRef(0);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setSecs(Math.round((Date.now() - started.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [rec]);
  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      keep.current = false;
      started.current = Date.now();
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const dur = Math.max(1, Math.round((Date.now() - started.current) / 1000));
        if (keep.current && chunks.current.length) onDone(new Blob(chunks.current, { type: r.mimeType }), r.mimeType || "audio/webm", dur);
        setRec(null); setSecs(0);
      };
      r.start(250);
      setRec(r);
    } catch { /* mic refused — leave the button idle */ }
  }
  if (rec) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="flex items-center gap-1.5 rounded-pill border border-line px-2.5 py-1.5 text-[13px] text-ink" aria-live="polite">
          <span className="h-2 w-2 animate-pulse rounded-full bg-yang" aria-hidden />
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
        </span>
        <button type="button" aria-label="Discard recording" onClick={() => { keep.current = false; rec.stop(); }}
          className="grid h-9 w-9 place-items-center rounded-full text-ink-3 hover:bg-veil/[0.07] hover:text-ink"><Ic d={IC.x} /></button>
        <button type="button" aria-label="Send voice message" onClick={() => { keep.current = true; rec.stop(); }}
          className="grid h-9 w-9 place-items-center rounded-full bg-yang text-on-accent hover:opacity-90"><Ic d={IC.send} /></button>
      </span>
    );
  }
  return (
    <button type="button" aria-label="Record a voice message" disabled={disabled} onClick={start}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/[0.07] hover:text-ink disabled:opacity-40"><Ic d={IC.mic} size={18} /></button>
  );
}

function fmtSize(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Decrypted-attachment media (image → lightbox; video → inline player; voice/audio → player;
 *  anything else → a download chip). Object URLs cached upstream. */
function Media({ att, url, onZoom }: { att: SealedAttachment; url: string | null; onZoom: (u: string) => void }) {
  if (!url) return <p className="text-[13px] italic text-ink-3">Couldn’t open this attachment.</p>;
  if (att.mime.startsWith("image/")) {
    const ratio = att.w && att.h ? att.w / att.h : undefined;
    return (
      <button type="button" onClick={() => onZoom(url)} className="block overflow-hidden rounded-card" aria-label="View image full size">
        <img src={url} alt="" loading="lazy" style={ratio ? { aspectRatio: String(ratio) } : undefined}
          className="max-h-72 max-w-full object-cover" />
      </button>
    );
  }
  if (att.mime.startsWith("video/")) {
    return (
      <video controls playsInline preload="metadata" src={url} aria-label="Video message"
        className="max-h-72 max-w-full rounded-card bg-black/40" />
    );
  }
  if (att.mime.startsWith("audio/")) {
    return (
      <span className="flex flex-col gap-1">
        {att.name ? <span className="max-w-[240px] truncate text-[12px] text-ink-2">{att.name}</span> : null}
        <span className="flex items-center gap-2">
          <audio controls src={url} preload="metadata" className="h-10 max-w-[240px]" />
          {att.dur ? <span className="text-[11px] text-ink-3">{Math.floor(att.dur / 60)}:{String(att.dur % 60).padStart(2, "0")}</span> : null}
        </span>
      </span>
    );
  }
  return (
    <a href={url} download={att.name || "attachment"}
      className="flex max-w-[260px] items-center gap-2.5 rounded-field border border-line bg-space-1 px-3 py-2 transition-colors hover:border-yin-light">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-veil/[0.07] text-ink-2"><Ic d={IC.file} size={17} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-ink">{att.name || "File"}</span>
        <span className="block text-[11px] text-ink-3">{fmtSize(att.size)}</span>
      </span>
      <span className="shrink-0 text-ink-3" aria-hidden><Ic d={IC.down} size={15} /></span>
    </a>
  );
}

/** One conversation — list of sealed rows fully materialised on-device. */
/**
 * One conversation, fully materialised on-device.
 *
 * `compact` = mounted inside the 400px chat dock rather than the full page. Every `md:` class here
 * resolves against the WINDOW, not this container, so on a 1440px desktop the dock would otherwise
 * get desktop metrics inside a phone-width column — 65%-wide bubbles at 260px, hover-only actions
 * with no hover target, and a reaction bar positioned above the bubble where the dock's
 * `overflow-hidden` clips it away. Compact mode picks the narrow branch explicitly.
 */
export function DmThread({ me, identity, myKey, peer, onBack, compact = false }: {
  me: number; identity: Identity; myKey: ChatKey; peer: ChatUserCard; onBack: () => void; compact?: boolean;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [peerKey, setPeerKey] = useState<ChatKey | null>(null);
  const [live, setLive] = useState({ read: 0, typing: false, online: false, ttl: 0 });
  // Delivered watermark: the newest id known to have reached the peer's device — their Messages
  // app was live (presence beacon) at a poll, so its 4–15s polls have carried everything up to
  // here. Read (the server watermark) always implies delivered; this covers the ✓✓-grey gap.
  const [deliveredTo, setDeliveredTo] = useState(0);
  const [older, setOlder] = useState<number | null>(null); // cursor for "show earlier"
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<Item | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [panel, setPanel] = useState<"" | "code" | "timer" | "search" | "emoji">("");
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState<string | null>(null);
  const [media, setMedia] = useState<Record<number, string | null>>({});
  const [atBottom, setAtBottom] = useState(true);
  const [missed, setMissed] = useState(0);

  const lastId = useRef(0);
  const keyCache = useRef(new Map<string, CryptoKey>());
  const objectUrls = useRef(new Set<string>()); // decrypted attachment URLs awaiting revocation
  const scroller = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLElement>());
  const typedAt = useRef(0);
  const tempSeq = useRef(-1);

  const low = Math.min(me, peer.id);
  const high = Math.max(me, peer.id);

  const convKey = useCallback(async (akid: number, bkid: number, peerPubB64: string) => {
    const ck = `${akid}:${bkid}`;
    let key = keyCache.current.get(ck);
    if (!key) {
      key = await deriveChatKey(identity.priv, await importPeerPub(peerPubB64), low, high, akid, bkid);
      keyCache.current.set(ck, key);
    }
    return key;
  }, [identity, low, high]);

  const decrypt = useCallback(async (page: ChatMessages): Promise<Item[]> => {
    const out: Item[] = [];
    for (const m of page.items) {
      const myKid = page.me === page.low_uid ? m.akid : m.bkid;
      const peerKid = page.me === page.low_uid ? m.bkid : m.akid;
      const peerPubB64 = page.keys[peerKid]?.pub;
      let payload: ChatPayload | null = null;
      if (myKid === myKey.kid && peerPubB64) {
        const key = await convKey(m.akid, m.bkid, peerPubB64);
        const plain = await openMessage(key, m.iv, m.ct, low, high, m.sender);
        if (plain !== null) payload = decodePayload(plain);
      }
      out.push({ id: m.id, sender: m.sender, at: m.at, payload });
    }
    return out;
  }, [convKey, myKey.kid, low, high]);

  // Merge a batch (poll or history), drop optimistic temp rows their ack replaced, keep order by id.
  const merge = useCallback((batch: Item[], prepend = false) => {
    setItems((cur) => {
      const seen = new Set(cur.map((m) => m.id));
      const fresh = batch.filter((m) => !seen.has(m.id));
      if (!fresh.length) return cur;
      return prepend ? [...fresh, ...cur] : [...cur, ...fresh];
    });
  }, []);

  // Initial load + live polling. The loop PAUSES while the tab is hidden (a backgrounded chat
  // polled every 4s forever — pure battery and request burn for a screen nobody is looking at) and
  // catches up with an immediate tick the moment the member comes back.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    async function tick(first: boolean) {
      if (inFlight) return; // a wake-up must never race the poll already awaiting a response
      inFlight = true;
      timer = undefined;
      try {
        // `after=0` is dropped by the client, so a chat that was EMPTY on open keeps asking for the
        // DESC history page — whose rows arrive newest-first. Track which shape came back rather
        // than assuming only the first tick is descending, or the first messages of a brand-new
        // conversation render upside down.
        const desc = first || lastId.current === 0;
        const page = await chatMessages(peer.id, first ? {} : { after: lastId.current });
        if (stop) return;
        if (first) setOlder(page.next);
        // The peer's ACTIVE key, re-read on EVERY tick. Reading it once meant that after they
        // cleared their browser or moved device, we kept sealing to the retired key — messages the
        // recipient could never open, with no error on either side. A changed kid also invalidates
        // the derived conversation keys, so the cache is dropped with it.
        setPeerKey((prev) => {
          const next = page.peer_key;
          if (prev && next && prev.kid !== next.kid) keyCache.current.clear();
          return next ?? prev;
        });
        setLive({ read: page.peer_read, typing: page.peer_typing, online: page.peer_online, ttl: page.ttl });
        const plain = await decrypt(page);
        if (stop) return;
        if (plain.length) {
          const ordered = desc ? [...plain].reverse() : plain;
          lastId.current = Math.max(lastId.current, ...ordered.map((m) => m.id));
          merge(ordered);
        }
        if (page.peer_online) setDeliveredTo((d) => Math.max(d, lastId.current));
        setFailed(false);
      } catch {
        if (!stop) setFailed(true);
      }
      inFlight = false;
      schedule();
    }
    function schedule() {
      if (stop || timer || document.hidden) return;
      timer = setTimeout(() => tick(false), POLL_MS);
    }
    function onVis() {
      if (document.hidden) { clearTimeout(timer); timer = undefined; return; }
      if (!timer && !inFlight) void tick(false); // catch up on everything missed while away
    }
    const urls = objectUrls.current;
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls.clear();
    setItems([]); setMedia({}); setOlder(null); lastId.current = 0; keyCache.current.clear();
    setPeerKey(null); setCode(null); setPanel(""); setReplyTo(null); setEditing(null); setMissed(0);
    setDeliveredTo(0);
    document.addEventListener("visibilitychange", onVis);
    tick(true);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
    };
  }, [peer.id, decrypt, merge]);

  // Safety code for the current key pair.
  useEffect(() => {
    if (!peerKey) return;
    const pubs = me === low ? [identity.pubB64, peerKey.pub] : [peerKey.pub, identity.pubB64];
    safetyCode(pubs[0], pubs[1]).then(setCode).catch(() => setCode(null));
  }, [peerKey, identity.pubB64, me, low]);

  // ── Materialise the sealed stream: edits win, deletes hide, reactions aggregate by parity. ──
  const view = useMemo(() => {
    const senderOf = new Map<number, number>();
    for (const m of items) senderOf.set(m.id, m.sender);
    const edits = new Map<number, string>();
    const dels = new Set<number>();
    const reacts = new Map<number, Map<string, Set<number>>>(); // ref → emoji → senders with ODD count
    const parity = new Map<string, number>();
    const render: Item[] = [];
    for (const m of items) {
      const p = m.payload;
      if (!p) { render.push(m); continue; }
      if (p.t === "edit") { if (senderOf.get(p.ref) === m.sender) edits.set(p.ref, p.body); continue; }
      if (p.t === "del") { if (senderOf.get(p.ref) === m.sender) dels.add(p.ref); continue; }
      if (p.t === "react") {
        const k = `${p.ref}|${p.emoji}|${m.sender}`;
        parity.set(k, (parity.get(k) || 0) + 1);
        continue;
      }
      render.push(m);
    }
    for (const [k, n] of parity) {
      if (n % 2 === 0) continue;
      const [ref, emoji, sender] = k.split("|");
      const r = Number(ref);
      if (!reacts.has(r)) reacts.set(r, new Map());
      const byEmoji = reacts.get(r)!;
      if (!byEmoji.has(emoji)) byEmoji.set(emoji, new Set());
      byEmoji.get(emoji)!.add(Number(sender));
    }
    const textOf = new Map<number, string>();
    for (const m of render) {
      const p = m.payload;
      if (p && (p.t === "text" || p.t === "img" || p.t === "file") && (edits.get(m.id) ?? p.body)) textOf.set(m.id, edits.get(m.id) ?? p.body ?? "");
      if (p && p.t === "voice") textOf.set(m.id, "Voice message");
      if (p && p.t === "file" && !textOf.has(m.id)) textOf.set(m.id, p.att.name || "File");
    }
    return { rows: render.filter((m) => !dels.has(m.id)), edits, reacts, textOf };
  }, [items]);

  // In-chat search over the DECRYPTED texts (never leaves the device).
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return view.rows.filter((m) => (view.textOf.get(m.id) || "").toLowerCase().includes(q)).map((m) => m.id);
  }, [query, view]);
  const [matchIdx, setMatchIdx] = useState(0);
  useEffect(() => { setMatchIdx(0); }, [query]);
  useEffect(() => {
    const id = matches[matchIdx];
    if (id) rowRefs.current.get(id)?.scrollIntoView({ block: "center" });
  }, [matches, matchIdx]);

  // Decrypt attachments lazily as their bubbles appear. Every object URL minted here is recorded so
  // it can be revoked: an object URL pins its decrypted blob in memory until the document is
  // discarded, so a long session of photo-heavy chats used to hold every image it had ever shown —
  // plaintext, in memory, forever. Revoked on peer switch and on unmount (below).
  useEffect(() => {
    for (const m of view.rows) {
      const p = m.payload;
      if (p && (p.t === "img" || p.t === "voice" || p.t === "file") && media[m.id] === undefined) {
        setMedia((cur) => ({ ...cur, [m.id]: null }));
        openAttachment(p.att).then((u) => {
          if (u) objectUrls.current.add(u);
          setMedia((cur) => ({ ...cur, [m.id]: u }));
        });
      }
    }
  }, [view.rows, media]);

  // Stick to the bottom while the member is there; count missed messages otherwise.
  const rowCount = view.rows.length;
  const prevCount = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
      setMissed(0);
    } else if (rowCount > prevCount.current) {
      setMissed((n) => n + (rowCount - prevCount.current));
    }
    prevCount.current = rowCount;
  }, [rowCount, atBottom]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(near);
    if (near) setMissed(0);
  }

  // ── Sending (everything goes through one sealed pipe) ──────────────────────
  const canSend = !!peerKey;

  async function sealAndSend(payload: ChatPayload, blobName?: string): Promise<boolean> {
    if (!peerKey) return false;
    const akid = me === low ? myKey.kid : peerKey.kid;
    const bkid = me === low ? peerKey.kid : myKey.kid;
    const key = await convKey(akid, bkid, peerKey.pub);
    const sealed = await sealMessage(key, encodePayload(payload), low, high, me);
    const temp = tempSeq.current--;
    const isBubble = payload.t === "text" || payload.t === "img" || payload.t === "voice" || payload.t === "file";
    if (isBubble) merge([{ id: temp, sender: me, at: nowSec(), payload, pending: true }]);
    try {
      // Only a real message rings the peer's bell and their inbox — a reaction, an edit or a
      // tombstone must not. The server can't distinguish them (identical ciphertext by design),
      // so the sender's client is the one that knows.
      const r = await chatSend(peer.id, {
        ...sealed, akid, bkid, ...(blobName ? { blob: blobName } : {}), notify: isBubble ? 1 : 0,
      });
      lastId.current = Math.max(lastId.current, r.id);
      if (isBubble) {
        // If a poll raced the ack and already delivered the real row, drop the optimistic twin
        // instead of renaming it onto the same id (a duplicate bubble with a duplicate key).
        setItems((cur) => cur.some((m) => m.id === r.id)
          ? cur.filter((m) => m.id !== temp)
          : cur.map((m) => (m.id === temp ? { ...m, id: r.id, at: r.at, pending: false } : m)));
      } else {
        merge([{ id: r.id, sender: me, at: r.at, payload }]); // reactions/edits/tombstones apply instantly
      }
      if (payload.t === "img" || payload.t === "voice" || payload.t === "file") setMedia((cur) => {
        // Re-key the decrypted object URL from the optimistic temp id onto the real row id.
        const u = cur[temp];
        const rest = Object.fromEntries(Object.entries(cur).filter(([k]) => Number(k) !== temp));
        return u !== undefined ? { ...rest, [r.id]: u } : rest;
      });
      return true;
    } catch {
      // Keep the payload (and any uploaded blob) on the stranded bubble so "Retry" can re-send it
      // without re-sealing or re-uploading. Without this the bubble sat there dimmed forever and the
      // only "recovery" was the banner claiming a retry that never happened for the send path.
      if (isBubble) setItems((cur) => cur.map((m) => (m.id === temp ? { ...m, pending: false, failed: true, blob: blobName } : m)));
      setFailed(true);
      return false;
    }
  }

  /** Re-send a bubble that failed: drop the stranded copy, then seal and send it again. */
  async function retry(m: Item) {
    if (!m.payload || busy) return;
    setItems((cur) => cur.filter((x) => x.id !== m.id));
    setBusy(true);
    await sealAndSend(m.payload, m.blob);
    setBusy(false);
  }

  async function submit() {
    const text = draft.trim();
    if (!text || busy || !canSend) return;
    setBusy(true);
    const payload: ChatPayload = editing
      ? { v: 2, t: "edit", ref: editing.id, body: text }
      : { v: 2, t: "text", body: text, ...(replyTo ? { ref: replyTo.id } : {}) };
    const ok = await sealAndSend(payload);
    if (ok) { setDraft(""); setReplyTo(null); setEditing(null); }
    setBusy(false);
  }

  /** Seal + send any attachment: images → img, recorded notes → voice, everything else
   *  (video/audio/documents) → file, rendered by its mime. Name/mime travel INSIDE the seal. */
  async function sendFile(file: File | Blob, mime: string, extra?: { dur?: number; voice?: boolean }) {
    if (!canSend || busy) return;
    setNote(null);
    setBusy(true);
    try {
      let w: number | undefined, h: number | undefined;
      if (mime.startsWith("image/")) {
        try { const bmp = await createImageBitmap(file); w = bmp.width; h = bmp.height; bmp.close(); } catch { /* layout hint only */ }
      }
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength > 5500000) {
        setNote("That file is too big — encrypted attachments are capped at 6 MB.");
        setBusy(false);
        return;
      }
      const name = file instanceof File && file.name ? file.name : undefined;
      const { sealed, k, iv } = await sealAttachment(bytes);
      const up = await chatUploadBlob(sealed);
      const att: SealedAttachment = { blob: up.blob, url: up.url, k, iv, mime, size: bytes.byteLength, w, h, dur: extra?.dur };
      const payload: ChatPayload = extra?.voice
        ? { v: 2, t: "voice", att }
        : mime.startsWith("image/")
          ? { v: 2, t: "img", att }
          : { v: 2, t: "file", att: { ...att, name } };
      await sealAndSend(payload, up.blob);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function toggleReact(m: Item, emoji: string) {
    await sealAndSend({ v: 2, t: "react", ref: m.id, emoji });
  }

  async function unsend(m: Item) {
    await sealAndSend({ v: 2, t: "del", ref: m.id }); // live tombstone for the peer's open screen
    try { await chatUnsend(m.id); } catch { /* row already carries the tombstone */ }
    setItems((cur) => cur.filter((x) => x.id !== m.id));
  }

  function onDraft(v: string) {
    setDraft(v);
    const now = Date.now();
    if (now - typedAt.current > 3000) { typedAt.current = now; chatTyping(peer.id).catch(() => undefined); }
  }

  function onPaste(e: React.ClipboardEvent) {
    const f = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"))?.getAsFile();
    if (f) { e.preventDefault(); sendFile(f, f.type); }
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) sendFile(f, f.type);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <section onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
      className={`flex min-h-0 flex-1 flex-col overflow-hidden bg-space-2 ${compact ? "" : "min-h-[480px] rounded-card border border-line shadow-card"}`}
      /* aria-label carries no member name: the i18n mesh collects ATTRIBUTES too, and every
         string it collects is persisted into the public aq_translations table. The name is
         announced by the header link below, which is data-ay-skip'd. */
      aria-label="Conversation">

      {/* header */}
      <header className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back to conversations"
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-veil/[0.07] ${compact ? "hidden" : "md:hidden"}`}><Ic d={IC.back} size={18} /></button>
        {/* In the dock the surrounding panel already shows the avatar, the name and a back arrow —
            repeating them here stacked two headers with two identical Back buttons. Only the
            per-conversation TOOLS (search / timer / safety code) belong to the thread there, plus
            the live status line, which the dock header has no room for. */}
        {!compact && (
          <>
            <span className="relative shrink-0">
              <Avatar src={peer.avatar} name={peer.name} className="h-9 w-9" />
              {live.online && <span className="absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full border-2 border-space-2 bg-yang" title="Active now" />}
            </span>
            <a href={localePath(`/u/${peer.slug}/`)} data-ay-skip="1" className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink hover:text-yin-light">{peer.name}</a>
          </>
        )}
        <p className={`truncate text-[12px] text-ink-3 ${compact ? "min-w-0 flex-1" : ""}`} aria-live="polite">
          {live.typing ? "typing…" : live.online ? "Active now" : "End-to-end encrypted"}
        </p>
        {[
          { k: "search" as const, icon: IC.search, label: "Search this conversation" },
          { k: "timer" as const, icon: IC.timer, label: "Disappearing messages" },
          { k: "code" as const, icon: IC.shield, label: "Safety code" },
        ].map((b) => (
          <button key={b.k} type="button" aria-label={b.label} aria-expanded={panel === b.k}
            onClick={() => setPanel((p) => (p === b.k ? "" : b.k))}
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors hover:bg-veil/[0.07] ${panel === b.k ? "text-ink" : "text-ink-3 hover:text-ink"}`}>
            <Ic d={b.icon} size={17} />
          </button>
        ))}
      </header>

      {/* header panels */}
      {panel === "code" && code && (
        <div data-ay-skip="1" className="border-b border-line px-4 py-3 text-[12px] leading-relaxed text-ink-2">
          <p>Compare these 60 digits with {peer.name} over a call or in person — matching codes prove nobody sits between your devices:</p>
          <p className="mt-1 select-all font-mono text-[13px] tracking-wide text-ink">{code}</p>
        </div>
      )}
      {panel === "timer" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <span className="text-[12px] text-ink-3">Messages disappear after</span>
          {TTL_CHOICES.map((t) => (
            <button key={t.v} type="button"
              onClick={() => { chatSetTtl(peer.id, t.v).then(() => setLive((l) => ({ ...l, ttl: t.v }))).catch(() => undefined); setPanel(""); }}
              className={`rounded-pill border px-3 py-1 text-[12px] font-semibold transition-colors ${
                live.ttl === t.v ? "border-yang text-ink" : "border-line text-ink-2 hover:border-yin-light hover:text-ink"
              }`}>{t.label}</button>
          ))}
          <span className="w-full text-[11px] text-ink-3">Expiry hard-deletes the sealed rows and attachments from the public database for both of you.</span>
        </div>
      )}
      {panel === "search" && (
        /* The query is typed over decrypted text and never leaves the device. */
        <div data-ay-skip="1" className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search decrypted messages (stays on this device)" autoFocus aria-label="Search this conversation" />
          {query.trim() && (
            <span className="flex shrink-0 items-center gap-1 text-[12px] text-ink-3">
              {matches.length ? `${matchIdx + 1}/${matches.length}` : "0"}
              <button type="button" aria-label="Previous match" disabled={!matches.length} onClick={() => setMatchIdx((i) => (i - 1 + matches.length) % matches.length)} className="rounded px-1.5 py-0.5 hover:bg-veil/[0.07] disabled:opacity-40">↑</button>
              <button type="button" aria-label="Next match" disabled={!matches.length} onClick={() => setMatchIdx((i) => (i + 1) % matches.length)} className="rounded px-1.5 py-0.5 hover:bg-veil/[0.07] disabled:opacity-40">↓</button>
            </span>
          )}
        </div>
      )}

      {/* stream */}
      <div ref={(el) => { scroller.current = el; if (el) watchMath(el, "auto"); }} onScroll={onScroll} className={`relative flex-1 overflow-y-auto py-3 ${compact ? "px-3" : "px-3 md:px-4"}`}>
        {older !== null && (
          <div className="pb-2 text-center">
            <button type="button" className="rounded-pill border border-line px-3.5 py-1 text-[12px] font-semibold text-ink-2 hover:border-yin-light hover:text-ink"
              onClick={async () => {
                try {
                  const page = await chatMessages(peer.id, { cursor: older });
                  setOlder(page.next);
                  merge((await decrypt(page)).reverse(), true);
                } catch { setFailed(true); }
              }}>Show earlier messages</button>
          </div>
        )}
        {live.ttl > 0 && (
          <p className="pb-2 text-center text-[11px] text-ink-3">⏱ Messages disappear after {ttlLabel(live.ttl).toLowerCase()}</p>
        )}
        {view.rows.length === 0 ? (
          <p className="py-12 text-center text-[14px] text-ink-3">No messages yet — everything you send is sealed on this device before it leaves.</p>
        ) : (
          <ol className="flex flex-col">
            {view.rows.map((m, i) => {
              const prev = view.rows[i - 1];
              const next = view.rows[i + 1];
              const mine = m.sender === me;
              const newDay = !prev || fmtDay(prev.at) !== fmtDay(m.at);
              const groupWithPrev = !newDay && prev && prev.sender === m.sender && m.at - prev.at < GROUP_S;
              const groupWithNext = next && next.sender === m.sender && next.at - m.at < GROUP_S && fmtDay(next.at) === fmtDay(m.at);
              const p = m.payload;
              const body = p && (p.t === "text" || p.t === "img" || p.t === "file") ? (view.edits.get(m.id) ?? p.body) : undefined;
              const reacts = view.reacts.get(m.id);
              const replyRef = p && p.t === "text" && p.ref ? p.ref : undefined;
              const hit = query.trim() && matches[matchIdx] === m.id;
              const read = m.id > 0 && m.id <= live.read;
              const delivered = read || (m.id > 0 && m.id <= deliveredTo);
              return (
                <li key={m.id} ref={(el) => { if (el) rowRefs.current.set(m.id, el); else rowRefs.current.delete(m.id); }}>
                  {newDay && (
                    <p className="py-3 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-3">{fmtDay(m.at)}</p>
                  )}
                  <div className={`group flex items-end gap-2 ${mine ? "justify-end" : "justify-start"} ${groupWithPrev ? "mt-0.5" : "mt-2.5"}`}>
                    {/* peer avatar on the last bubble of their group (iMessage) */}
                    {!mine && (
                      <span className="w-7 shrink-0">
                        {!groupWithNext && <Avatar src={peer.avatar} name={peer.name} className="h-7 w-7" />}
                      </span>
                    )}
                    {/* hover actions */}
                    {mine && m.id > 0 && p && (
                      <span className={`shrink-0 items-center gap-0.5 self-center transition-opacity ${
                        /* No hover on the dock's touch surface, so these are always shown there
                           rather than hidden behind a gesture that never happens. */
                        compact ? "flex" : "hidden opacity-0 group-hover:opacity-100 md:flex"}`}>
                        {p.t === "text" && (
                          <button type="button" aria-label="Edit" onClick={() => { setEditing(m); setReplyTo(null); setDraft(body || ""); }}
                            className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-3 hover:bg-veil/[0.07] hover:text-ink">Edit</button>
                        )}
                        <button type="button" aria-label="Unsend" onClick={() => unsend(m)}
                          className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-3 hover:bg-veil/[0.07] hover:text-ink">Unsend</button>
                      </span>
                    )}
                    {/* data-ay-skip: everything below this point is decrypted plaintext — see the
                        file header. Marked on the wrapper so no future child can escape it. */}
                    <div data-ay-skip="1" className={`relative ${compact ? "max-w-[82%]" : "max-w-[76%] md:max-w-[65%]"} ${hit ? "rounded-card ring-2 ring-yang" : ""}`}>
                      {/* WhatsApp-style bubble: sent = blue-tinted, received = neutral; the last
                          bubble of a group squares its outer-bottom corner into a tail. */}
                      <div className={`rounded-card px-3 py-2 text-[14.5px] leading-relaxed ${
                        mine ? "bg-yin/20 text-ink" : "bg-veil/[0.07] text-ink"
                      } ${!groupWithNext ? (mine ? "rounded-ee-[6px]" : "rounded-es-[6px]") : ""} ${
                        m.pending ? "opacity-70" : ""} ${m.failed ? "opacity-60 ring-1 ring-yang" : ""}`}>
                        {replyRef && (
                          <button type="button" onClick={() => rowRefs.current.get(replyRef)?.scrollIntoView({ block: "center" })}
                            className="mb-1.5 block w-full truncate rounded border-s-2 border-yin-light/70 bg-veil/[0.06] px-2 py-1 text-start text-[12px] text-ink-3">
                            {view.textOf.get(replyRef) || "Earlier message"}
                          </button>
                        )}
                        {p === null ? (
                          <p className="italic text-ink-3">Sealed to a previous device key — this device cannot open it.</p>
                        ) : p.t === "img" || p.t === "voice" || p.t === "file" ? (
                          <>
                            <Media att={p.att} url={media[m.id] ?? null} onZoom={setZoom} />
                            {(p.t === "img" || p.t === "file") && body && <p className="mt-1.5 whitespace-pre-wrap break-words" dir="auto">{body}</p>}
                          </>
                        ) : (
                          <p className="whitespace-pre-wrap break-words" dir="auto">{body}</p>
                        )}
                        {/* per-message meta (WhatsApp-style, inside every bubble): time · edited ·
                            failed, plus the sent/delivered/read tick on each of my messages */}
                        <p className={`mt-0.5 flex items-center gap-1 text-[10.5px] text-ink-3 ${mine ? "justify-end" : ""}`}>
                          <span>{fmtTime(m.at)}</span>
                          {view.edits.has(m.id) && <span>· edited</span>}
                          {m.failed && (
                            <>
                              <span className="font-semibold">· not sent</span>
                              <button type="button" onClick={() => retry(m)} disabled={busy}
                                className="rounded px-1 font-semibold text-yang underline-offset-2 hover:underline disabled:opacity-50">Retry</button>
                              <button type="button" onClick={() => setItems((cur) => cur.filter((x) => x.id !== m.id))}
                                className="rounded px-1 hover:text-ink">Discard</button>
                            </>
                          )}
                          {mine && !m.failed && <Ticks pending={m.pending} read={read} delivered={delivered} />}
                        </p>
                      </div>
                      {/* reaction chips */}
                      {reacts && reacts.size > 0 && (
                        <div className={`-mt-1 flex flex-wrap gap-1 ${mine ? "justify-end pe-1" : "ps-1"}`}>
                          {[...reacts.entries()].map(([emoji, who]) => (
                            <button key={emoji} type="button" onClick={() => toggleReact(m, emoji)}
                              aria-label={`${emoji} ${who.size}`}
                              className={`rounded-pill border px-1.5 py-0.5 text-[12px] shadow-card transition-colors ${
                                who.has(me) ? "border-yang bg-space-2" : "border-line bg-space-2 hover:border-yin-light"
                              }`}>{emoji}{who.size > 1 ? ` ${who.size}` : ""}</button>
                          ))}
                        </div>
                      )}
                      {/* hover reaction + reply bar */}
                      {m.id > 0 && p && (
                        <div className={`z-10 items-center gap-0.5 rounded-pill border border-line bg-space-2 px-1.5 py-1 shadow-card ${compact ? "flex" : "hidden group-hover:flex"} ${
                          /* In the dock the panel root is overflow-hidden, so a bar floated ABOVE the
                             bubble is clipped away entirely — under it, in normal flow, it survives. */
                          compact ? "mt-1 flex-wrap" : "absolute -top-8"} ${mine ? "end-0" : "start-0"}`}>
                          {REACTIONS.map((e) => (
                            <button key={e} type="button" aria-label={`React ${e}`} onClick={() => toggleReact(m, e)}
                              className="rounded-full px-1 text-[15px] transition-transform hover:scale-125">{e}</button>
                          ))}
                          <button type="button" aria-label="Reply" onClick={() => { setReplyTo(m); setEditing(null); }}
                            className="ms-0.5 rounded px-1.5 text-[11px] font-semibold text-ink-3 hover:text-ink">Reply</button>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
            {live.typing && (
              <li className="mt-2.5 flex items-end gap-2">
                <span className="w-7 shrink-0"><Avatar src={peer.avatar} name={peer.name} className="h-7 w-7" /></span>
                <span className="rounded-card bg-veil/[0.07] px-3.5 py-2.5" aria-label="Typing">
                  <span className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-3" style={{ animationDelay: `${i * 150}ms` }} />
                    ))}
                  </span>
                </span>
              </li>
            )}
          </ol>
        )}
        {!atBottom && (
          <button type="button" aria-label="Jump to latest"
            onClick={() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; setAtBottom(true); setMissed(0); }}
            className="sticky bottom-2 start-full z-10 -translate-x-2 rounded-pill border border-line bg-space-2 px-3 py-1.5 text-[12px] font-semibold text-ink shadow-card hover:border-yin-light rtl:translate-x-2">
            ↓{missed > 0 ? ` ${missed} new` : ""}
          </button>
        )}
      </div>

      {/* composer */}
      <footer className={`border-t border-line ${compact ? "p-2.5" : "p-2.5 md:p-3"}`}>
        {failed && <ErrorNote className="mb-2">Couldn’t reach the server — retrying.</ErrorNote>}
        {note && <ErrorNote className="mb-2">{note}</ErrorNote>}
        {(replyTo || editing) && (
          /* Quotes the message being replied to / edited — decrypted plaintext. */
          <div data-ay-skip="1" className="mb-2 flex items-center gap-2 rounded-field border-s-2 border-yin-light/70 bg-veil/[0.05] px-3 py-1.5">
            <p className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
              <span className="font-semibold text-ink-2">{editing ? "Editing your message" : `Replying to ${replyTo!.sender === me ? "yourself" : peer.name}`}</span>
              {!editing && <> — {view.textOf.get(replyTo!.id) || "message"}</>}
            </p>
            <button type="button" aria-label="Cancel" onClick={() => { setReplyTo(null); setEditing(null); if (editing) setDraft(""); }}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-veil/[0.07] hover:text-ink"><Ic d={IC.x} size={13} /></button>
          </div>
        )}
        {panel === "emoji" && (
          <div className="mb-2 flex flex-wrap gap-1 rounded-field border border-line bg-space-1 p-2">
            {EMOJI.map((e) => (
              <button key={e} type="button" aria-label={`Insert ${e}`} onClick={() => setDraft((d) => d + e)}
                className="rounded p-1 text-[18px] transition-transform hover:scale-110">{e}</button>
            ))}
          </div>
        )}
        {canSend ? (
          <div className="flex items-end gap-1.5">
            <button type="button" aria-label="Emoji" aria-expanded={panel === "emoji"} onClick={() => setPanel((s) => (s === "emoji" ? "" : "emoji"))}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/[0.07] hover:text-ink"><Ic d={IC.smile} size={18} /></button>
            <label aria-label="Send an encrypted photo, video or file" title="Photo, video or file"
              className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/[0.07] hover:text-ink">
              <Ic d={IC.clip} size={18} />
              <input type="file" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) sendFile(f, f.type); e.target.value = ""; }} />
            </label>
            <GrowingTextarea value={draft} onChange={onDraft} placeholder={editing ? "Edit your message…" : "Write an encrypted message…"}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
                if (e.key === "Escape" && (replyTo || editing)) {
                  // Claim the key so the surrounding dock does not also close (which would
                  // throw away the message being typed). An Escape with nothing to cancel
                  // bubbles on, and closing is then the right thing.
                  e.preventDefault();
                  setReplyTo(null); setEditing(null);
                } }}
              onPaste={onPaste} disabled={busy && !draft} />
            {draft.trim() ? (
              <button type="button" aria-label={editing ? "Save edit" : "Send"} onClick={submit} disabled={busy}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-yang text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"><Ic d={IC.send} size={18} /></button>
            ) : (
              <VoiceButton disabled={busy} onDone={(b, mime, dur) => sendFile(b, mime, { dur, voice: true })} />
            )}
          </div>
        ) : (
          // The name is skipped; the sentence beside it stays one whole translatable unit.
          <p className="px-1 text-[13px] text-ink-3">
            <span data-ay-skip="1" className="font-semibold text-ink-2">{peer.name}</span>{" "}
            <span>hasn’t opened Messages yet, so there is no device key to seal anything to. Once they open it once, you can write.</span>
          </p>
        )}
      </footer>

      {/* lightbox */}
      {zoom && (
        <div role="dialog" aria-label="Image" className="fixed inset-0 z-[80] grid place-items-center bg-black/80 p-4"
          onClick={() => setZoom(null)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setZoom(null); } }} tabIndex={-1}>
          <img src={zoom} alt="" className="max-h-[92vh] max-w-[94vw] rounded-card object-contain" />
          <button type="button" aria-label="Close" onClick={() => setZoom(null)}
            className="absolute end-4 top-4 grid h-10 w-10 place-items-center rounded-full bg-space-2 text-ink shadow-card"><Ic d={IC.x} size={18} /></button>
        </div>
      )}
    </section>
  );
}

export default function Messages() {
  const [sp, setSp] = useSearchParams();
  // ONE shared session with the chat dock (lib/chat-store): the same device identity, the same
  // conversation-list poller and the same decrypted-preview cache. Before this, having the dock in
  // the shell and this page mounted meant two of each — and two concurrent identity bootstraps,
  // which silently rotated the device key and stranded ciphertext forever.
  const [, bumpChat] = useState(0);
  useEffect(() => subscribeChat(() => bumpChat((n) => n + 1)), []);
  useEffect(() => watchList(), []); // this page always shows the list
  const store = getChatState();
  const identity = store.identity;
  const myKey = store.myKey;
  const page = store.page;
  const previews = store.previews;
  const me = page?.me ?? 0;
  const [peer, setPeer] = useState<ChatUserCard | null>(null);
  const [to, setTo] = useState("");
  const [filter, setFilter] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const fatal = store.fatal;
  // The member directory — everyone on ArtaQuest, online first.
  const [side, setSide] = useState<"chats" | "people">("chats");
  const [dir, setDir] = useState<ChatDirectory | null>(null);
  // null until the server answers, so the toggle never flickers into the wrong position.
  const [emailOn, setEmailOn] = useState<boolean | null>(null);
  const chats = page?.items ?? null;




  // The directory. Refreshed on the same cadence and the same visibility rule as the conversation
  // list, because "who is online" is only useful while it's true — and only while someone is
  // looking. The search box is shared with the conversation filter, so one field drives both tabs.
  useEffect(() => {
    if (!myKey || side !== "people") return;
    let stop = false;
    const q = filter.trim();
    const load = () => chatMembers(q ? { q } : undefined).then((d) => { if (!stop) setDir(d); }).catch(() => undefined);
    const t0 = setTimeout(load, q ? 250 : 0); // debounce typing
    // Presence is only worth refreshing while someone is looking at it — the tick is a no-op on a
    // hidden tab, and coming back re-reads immediately.
    const t = setInterval(() => { if (!document.hidden) void load(); }, 20000);
    const onVis = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { stop = true; clearTimeout(t0); clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [myKey, side, filter]);

  // Read the away-email preference once, after the device key exists (so it rides the same
  // signed-in state as everything else here). A failure leaves the toggle hidden rather than
  // guessing — better no switch than one that lies about what the server will do.
  useEffect(() => {
    if (!myKey) return;
    let stop = false;
    chatEmailPrefs().then((r) => { if (!stop) setEmailOn(!!r.email_on); }).catch(() => undefined);
    return () => { stop = true; };
  }, [myKey]);

  // Filter the list by member name — the sidebar search every messenger has.
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q || !chats) return chats ?? [];
    return chats.filter((c) => c.peer.name.toLowerCase().includes(q) || c.peer.slug.toLowerCase().includes(q));
  }, [chats, filter]);

  // Takes the handle as an ARGUMENT. It used to read the `to` state, so "Notes to yourself" —
  // which sets that state and then calls this on a timeout — always ran against the value from
  // before the click and silently did nothing the first time.
  async function openNew(raw: string = to) {
    const slug = raw.trim().replace(/^@/, "");
    if (!slug) return;
    setNote(null);
    try {
      const k = await chatGetKey(slug);
      setPeer(k.user);
      setTo("");
      setSp((cur) => { cur.set("with", k.user.slug); return cur; }, { replace: true });
      if (!k.key) setNote(`${k.user.name} hasn’t opened Messages yet, so they can’t receive encrypted messages until they do.`);
    } catch {
      setNote("No member found with that username.");
    }
  }

  // ?with=<slug> is the deep-link entry point (the profile "Message" button lands here). It used
  // to ride along inside the page's own bootstrap; the session is shared now, so it stands alone.
  const deepLink = sp.get("with");
  useEffect(() => {
    if (!deepLink || !isLoggedIn()) return;
    let stop = false;
    chatGetKey(deepLink).then((k) => { if (!stop) setPeer(k.user); }).catch(() => undefined);
    return () => { stop = true; };
  }, [deepLink]);

  function openChat(c: ChatListItem) {
    setPeer(c.peer);
    setSp((cur) => { cur.set("with", c.peer.slug); return cur; }, { replace: true });
    markSeen(c.id); // zero the badge immediately rather than waiting for the next poll to agree
  }

  if (!isLoggedIn()) {
    return (
      <div className="flex flex-col gap-6 pb-12">
        <PageHero eyebrow="Community" title="Messages" lede="Private, end-to-end encrypted conversations between members." />
        <EmptyState title="Sign in to use Messages" body="Your messages are sealed on your own device — sign in and this browser will create its encryption key."
          action={<Button href="/login/">Sign in</Button>} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-12">
      <PageHero eyebrow="Community" title="Messages"
        lede="End-to-end encrypted. Your device holds the only key that can read your conversations — the ArtaQuest database is fully public, and even with every row of it, a message cannot be opened without your device. Reactions, replies, photos, videos, files and voice notes are all identical sealed rows." />
      {fatal ? (
        <ErrorNote>{fatal}</ErrorNote>
      ) : !identity || !myKey ? (
        <StatusNote>Preparing this device’s encryption key…</StatusNote>
      ) : (
        <div className="flex flex-col gap-4 md:flex-row md:items-stretch">
          {/* conversation list — hidden on phones while a thread is open (single-pane) */}
          <aside className={`w-full flex-col gap-3 md:flex md:w-72 md:shrink-0 ${peer ? "hidden" : "flex"}`} aria-label="Conversations">
            {/* Two panes over one sidebar: the conversations you have, and everyone you could
                start one with. "People" is the answer to "who is even here?" — which used to
                require knowing a member's exact @handle before you could type a word to them. */}
            <div className="flex overflow-hidden rounded-pill border border-line" role="tablist" aria-label="Sidebar">
              {([["chats", "Chats"], ["people", "People"]] as const).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={side === k}
                  onClick={() => setSide(k)}
                  className={`flex-1 px-3 py-1.5 text-[13px] font-semibold transition-colors ${
                    side === k ? "bg-veil/[0.10] text-ink" : "text-ink-3 hover:bg-veil/[0.05] hover:text-ink"
                  }`}>
                  {label}
                  {k === "people" && dir && dir.online > 0 && (
                    <span className="ms-1.5 text-[11px] font-bold text-yang">{dir.online}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="@username"
                aria-label="Start a conversation with a member" onKeyDown={(e) => { if (e.key === "Enter") void openNew(); }} />
              <Button onClick={() => void openNew()} size="sm" variant="outline">New</Button>
            </div>
            {currentUser()?.slug ? (
              <button type="button" onClick={() => void openNew(currentUser()!.slug!)}
                className="self-start text-[12px] text-yin-ink hover:underline">Notes to yourself →</button>
            ) : null}
            {note && <p className="text-[13px] text-ink-3">{note}</p>}
            {/* One search field drives both panes: your conversations, or every member. */}
            {(side === "people" || (chats && chats.length > 5)) && (
              <Input value={filter} onChange={(e) => setFilter(e.target.value)}
                placeholder={side === "people" ? "Search members" : "Search conversations"}
                aria-label={side === "people" ? "Search members" : "Search your conversations"} />
            )}

            {side === "people" ? (
              <>
                <nav className="flex flex-col overflow-hidden rounded-card border border-line bg-space-2 shadow-card" aria-label="Members">
                  {dir === null ? (
                    <p className="px-4 py-6 text-center text-[13px] text-ink-3">Loading…</p>
                  ) : dir.items.length === 0 ? (
                    <p className="px-4 py-6 text-center text-[13px] text-ink-3">
                      {filter.trim() ? "Nobody matches that search." : "No other members yet."}
                    </p>
                  ) : (
                    dir.items.map((m) => (
                      /* data-ay-skip on the BUTTON, not the inner span: the mesh collects
                         ATTRIBUTES as well as text, so a title built from a member's name would
                         otherwise publish the whole membership into the public translations table. */
                      <button key={m.id} type="button" onClick={() => void openNew(m.slug)} data-ay-skip="1"
                        title={m.has_key ? "Send an encrypted message" : "Hasn’t opened Messages yet"}
                        className={`flex items-center gap-3 border-b border-line px-3 py-2.5 text-start last:border-b-0 hover:bg-veil/[0.05] ${peer?.id === m.id ? "bg-veil/[0.08]" : ""}`}>
                        <span className="relative shrink-0">
                          <Avatar src={m.avatar} name={m.name} country={m.country} className="h-10 w-10" />
                          {/* Purely decorative here — the line beneath the name already reads
                              "Active now", so announcing the dot too would just repeat it. */}
                          {m.online && <span aria-hidden className="absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full border-2 border-space-2 bg-yang" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] font-semibold text-ink">{m.name}</span>
                          <span className="block truncate text-[12px] text-ink-3">
                            {m.online ? "Active now" : m.has_key ? `@${m.slug}` : "Not set up for messages yet"}
                          </span>
                        </span>
                      </button>
                    ))
                  )}
                </nav>
                {dir && (
                  <p className="text-[12px] text-ink-3">
                    {dir.online} of {dir.listed} {dir.listed === 1 ? "member" : "members"} online
                    {dir.capped ? ` · showing ${dir.listed} of ${dir.total} — search to find anyone else` : ""}
                  </p>
                )}
              </>
            ) : (
            <nav className="flex flex-col overflow-hidden rounded-card border border-line bg-space-2 shadow-card">
              {chats === null ? (
                <p className="px-4 py-6 text-center text-[13px] text-ink-3">Loading…</p>
              ) : chats.length === 0 && !peer ? (
                <p className="px-4 py-6 text-center text-[13px] text-ink-3">No conversations yet — find a member above.</p>
              ) : shown.length === 0 ? (
                <p className="px-4 py-6 text-center text-[13px] text-ink-3">No conversation matches that search.</p>
              ) : (
                shown.map((c) => (
                  <button key={c.id} type="button" onClick={() => openChat(c)}
                    className={`flex items-center gap-3 border-b border-line px-3 py-2.5 text-start last:border-b-0 hover:bg-veil/[0.05] ${peer?.id === c.peer.id ? "bg-veil/[0.08]" : ""}`}>
                    <span className="relative shrink-0">
                      <Avatar src={c.peer.avatar} name={c.peer.name} className="h-10 w-10" />
                      {c.online && <span className="absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full border-2 border-space-2 bg-yang" title="Active now" />}
                    </span>
                    {/* Member name + the decrypted preview — both must stay off the mesh. */}
                    <span data-ay-skip="1" className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className={`min-w-0 flex-1 truncate text-[14px] text-ink ${c.unread ? "font-bold" : "font-semibold"}`}>{c.peer.name}</span>
                        {c.last_at > 0 && (
                          <span className={`shrink-0 text-[11px] ${c.unread ? "font-semibold text-yang" : "text-ink-3"}`}>
                            {fmtDay(c.last_at) === "Today" ? fmtTime(c.last_at) : fmtDay(c.last_at)}
                          </span>
                        )}
                      </span>
                      {/* The last message, decrypted on THIS device — the server only ever held the
                          ciphertext it hands every visitor of /data/. */}
                      <span className={`block truncate text-[12px] ${c.unread ? "text-ink-2" : "text-ink-3"}`} dir="auto">
                        {previews[c.id] ?? (c.last ? "Encrypted message" : "No messages yet")}
                      </span>
                    </span>
                    {c.unread > 0 && <span className="self-center rounded-pill bg-yang px-2 py-0.5 text-[11px] font-bold text-on-accent">{c.unread}</span>}
                  </button>
                ))
              )}
            </nav>
            )}
            {/* Email me when a message lands while I'm away. On by default — an unread message
                nobody is told about is a broken inbox — and off with one tap. */}
            {emailOn !== null && (
              <label className="flex cursor-pointer items-start gap-2 text-[12px] leading-relaxed text-ink-3">
                <input type="checkbox" checked={emailOn} className="mt-0.5 accent-yang"
                  onChange={(e) => {
                    const on = e.target.checked;
                    setEmailOn(on);
                    chatEmailPrefs(on).catch(() => setEmailOn(!on)); // revert if the server disagrees
                  }} />
                <span>Email me when a message arrives while I'm away — at most once every 30 minutes per conversation, and never the message itself (we can't read it).</span>
              </label>
            )}
            <p className="text-[12px] leading-relaxed text-ink-3">
              Keys are bound to this browser. If you clear this site’s data or move devices, a new key is created and
              earlier messages stay sealed to the old one — nobody, including ArtaQuest, can recover them.
            </p>
          </aside>
          {peer && me ? (
            <DmThread me={me} identity={identity} myKey={myKey} peer={peer}
              onBack={() => { setPeer(null); setSp((cur) => { cur.delete("with"); return cur; }, { replace: true }); }} />
          ) : peer ? (
            <StatusNote className="flex-1">Opening the conversation…</StatusNote>
          ) : (
            <EmptyState className="hidden flex-1 md:flex" title="Pick a conversation"
              body="Choose a conversation on the left, or start one with a member’s @username." />
          )}
        </div>
      )}
    </div>
  );
}
