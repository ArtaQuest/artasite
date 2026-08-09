import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  chatCall, chatEmailPrefs, chatGetKey, chatMembers, chatMessages, chatRelation, chatSend,
  chatSetTtl, chatTyping, chatUnsend, chatUploadBlob,
  type ChatBox, type ChatDirectory, type ChatKey, type ChatListItem, type ChatMessages,
  type ChatRelation, type ChatUserCard,
} from "../lib/api";
import { currentUser, isLoggedIn, localePath } from "../lib/wp";
import {
  applyRelation, bumpRequests, clearRing, getChatState, markSeen, setBox, subscribeChat,
  takeAutoAnswer, watchList,
} from "../lib/chat-store";
import { watchMath } from "../lib/math";
import MediaViewer from "../components/chat/MediaViewer";
import {
  decodePayload, deriveChatKey, encodePayload, importPeerPub,
  openAttachment, openMessage, safetyCode, sealAttachment, sealMessage,
  type ChatPayload, type Identity, type SealedAttachment,
} from "../lib/e2ee";
import { Avatar, Button, EmptyState, ErrorNote, Input, PageHero, StatusNote } from "../components/ui";
import { Pickers, type PickerResult } from "../components/chat/Pickers";
import { RoomThread } from "../components/chat/RoomThread";
import { RoomCall } from "../components/chat/RoomCall";
import { roomsCreate, roomsList, type Room } from "../lib/api";
import { CallPanel, CallPrivacyNote } from "../components/chat/CallPanel";
import { Call, callSupported, mediaErrorMessage, newCallSid, type CallState } from "../lib/webrtc";
import { QUICK_REACTIONS } from "../components/chat/emoji";
import { MessageBody } from "../components/chat/MessageBody";
import { insideFence } from "../components/chat/fence";
import { knownSticker, stickerLabel, stickerUrl } from "../components/chat/stickers";

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
/** While a call is being set up or is live, the thread polls much faster. The signalling channel IS
 *  this poll (lib/webrtc.ts), so at 4s an offer and its answer would take up to eight seconds to
 *  cross — a phone that takes eight seconds to start ringing reads as broken. */
const CALL_POLL_MS = 1200;
/** A conversation whose other side is AWAY and that has been silent this long backs off to
 *  IDLE_POLL_MS. Presence is the gate, not silence alone — see schedule(). */
const QUIET_AFTER_MS = 120000;
const IDLE_POLL_MS = 10000;
const GROUP_S = 300; // bubbles from the same sender within 5 min group together
const REACTIONS = QUICK_REACTIONS;
/** How long an unanswered offer keeps ringing before it is treated as missed. A sealed message
 *  never expires by itself, so without this every old call in the history would ring again. */
const CALL_LIVE_S = 60;
/** Remembers that this device has seen the "calls are direct, they'll see your IP" note. Device
 *  local: it is a UI preference, not something the public database needs a row for. */
const CALL_NOTE_KEY = "aq-call-note-seen";
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

/**
 * Current unix milliseconds, for the same reason and one more.
 *
 * `react-hooks/purity` rejects a bare `Date.now()` inside a function DECLARED in a component body,
 * and it is right to: the typing-beacon throttle below reads the clock from `onDraft`, which is
 * handed to a custom component as a prop — nothing at that call site proves the component only
 * invokes it from an event rather than while rendering. Reading the clock through a module-scoped
 * helper puts the impure call somewhere it demonstrably cannot run during a render.
 */
const nowMs = () => Date.now();

/**
 * Half-written messages, per conversation, for as long as the tab lives.
 *
 * Every messenger keeps these, and their absence was quietly costly here: the thread REMOUNTS on
 * every peer switch, and the dock and the full page can each open a different conversation, so
 * glancing at another chat — or answering the person who just messaged you — silently destroyed
 * whatever you were in the middle of writing, with no warning and no undo.
 *
 * Module-scoped rather than component state (the component is what unmounts) and deliberately NOT
 * persisted to disk: an unsent message is plaintext, and this app does not leave plaintext lying
 * around after the tab closes. A refresh loses it; switching chats does not.
 */
const drafts = new Map<number, string>();

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
  video: <><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="m16 10.5 5-3v9l-5-3Z" /></>,
  more: <><circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  pin: <path d="M15 3 21 9l-4 1-3.5 3.5L14 18l-2 2-4.5-4.5L3 20l4.5-4.5L3 11l2-2 4.5.5L13 6Z" />,
  mute: <><path d="M17 17H5l1.5-2.5V10a5.5 5.5 0 0 1 3-4.9M18 12v-2a5.5 5.5 0 0 0-5.5-5.5" /><path d="M3 3l18 18" /></>,
  bell: <path d="M17 17H7l1.5-2.5V10a3.5 3.5 0 0 1 7 0v4.5ZM10 20h4" />,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" /></>,
  block: <><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></>,
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
function Media({ att, url, onZoom }: { att: SealedAttachment; url: string | null; onZoom: (u: string, mime: string) => void }) {
  if (!url) return <p className="text-[13px] italic text-ink-3">Couldn’t open this attachment.</p>;
  if (att.mime.startsWith("image/")) {
    const ratio = att.w && att.h ? att.w / att.h : undefined;
    return (
      <button type="button" onClick={() => onZoom(url, att.mime)} className="relative block overflow-hidden rounded-card"
        aria-label={att.gif ? "View GIF full size" : "View image full size"}>
        {/* object-CONTAIN, not cover. A cropped photo is an annoyance; a cropped GIF is usually the
            joke cut in half, and a portrait screenshot arrives with its content sliced out. */}
        <img src={url} alt="" loading="lazy" style={ratio ? { aspectRatio: String(ratio) } : undefined}
          className="max-h-72 max-w-full object-contain" />
        {att.gif && (
          <span className="absolute bottom-1 start-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white">GIF</span>
        )}
      </button>
    );
  }
  if (att.mime.startsWith("video/")) {
    // Openable now, like a still. It played inline at 288px and that was the only size it had —
    // fine for a clip of someone talking, no use at all for a screen recording of a plot or a
    // terminal, which is most of what gets sent here.
    return (
      <span className="relative block">
        <video controls playsInline preload="metadata" src={url} aria-label="Video message"
          className="max-h-72 max-w-full rounded-card bg-black/40" />
        <button type="button" onClick={() => onZoom(url, att.mime)} aria-label="View video full size"
          title="View full size"
          className="absolute end-1.5 top-1.5 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80">
          <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 4H4v5M15 20h5v-5M4 15v5h5M20 9V4h-5" /></svg>
        </button>
      </span>
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


/**
 * The composer — and it owns the draft.
 *
 * THAT IS THE WHOLE POINT OF IT BEING A COMPONENT. `draft` used to live in DmThread, so every
 * keystroke re-rendered the entire message list: measured at 133ms median from keypress to paint on
 * a 50-message conversation, which is felt as lag on every single letter. Nothing above this
 * component needs to know what you have half-typed until you send it, so nothing above it re-renders
 * while you type.
 *
 * Remounted by `key` when edit mode starts or stops (see the call site), which is how the box gets
 * pre-filled with the message being edited and restored afterwards without the parent tracking it.
 */
function Composer({
  peerId, peerName, compact, editing, replyTo, replyPreview, busy, asked, willRequest, requestLeft,
  initialText, onSend, onCancel, onPick, onFile,
}: {
  peerId: number; peerName: string; compact: boolean;
  editing: boolean; replyTo: boolean; replyPreview: string; busy: boolean;
  asked: boolean; willRequest: boolean; requestLeft: number;
  initialText: string;
  onSend: (text: string) => void;
  onCancel: () => void;
  onPick: (r: PickerResult) => void;
  onFile: (f: File | Blob, mime: string, extra?: { dur?: number; voice?: boolean }) => void;
}) {
  const [draft, setDraft] = useState(initialText);
  const [panel, setPanel] = useState(false);
  const typedAt = useRef(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Put the cursor where the member is about to write.
  //
  // EDITING ALWAYS FOCUSES, AND ALWAYS AT THE END. This component remounts pre-filled when an edit
  // starts, which leaves the caret at position 0 — so typing PREPENDED to the message being edited
  // ("-EDITEDhello" instead of "hello-EDITED"). Editing is also a deliberate tap, so raising the
  // keyboard is wanted there even on a phone.
  //
  // Otherwise focus only on desktop: on a phone, focusing on open raises the keyboard over the
  // messages the member came to read.
  useEffect(() => {
    const ta = boxRef.current?.querySelector("textarea");
    if (!ta) return;
    if (editing) {
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
      return;
    }
    if (compact || window.matchMedia("(max-width: 767px)").matches) return;
    ta.focus();
    // Same rule for a restored draft — you continue it, you do not type into the middle of it.
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  }, [compact, peerId, editing]);

  function change(v: string) {
    setDraft(v);
    if (!editing) { if (v) drafts.set(peerId, v); else drafts.delete(peerId); }
    const now = nowMs();
    if (now - typedAt.current > 3000) { typedAt.current = now; chatTyping(peerId).catch(() => undefined); }
  }

  function send() {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
    drafts.delete(peerId);
  }

  return (
    <div ref={boxRef}>
      {(replyTo || editing) && (
        /* Quotes the message being replied to / edited — decrypted plaintext. */
        <div data-ay-skip="1" className="mb-2 flex items-center gap-2 rounded-field border-s-2 border-yin-light/70 bg-veil/[0.05] px-3 py-1.5">
          <p className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
            <span className="font-semibold text-ink-2">{editing ? "Editing your message" : `Replying to ${replyPreview ? peerName : peerName}`}</span>
            {!editing && replyPreview && <> — {replyPreview}</>}
          </p>
          <button type="button" aria-label="Cancel" onClick={onCancel}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-veil/[0.07] hover:text-ink"><Ic d={IC.x} size={13} /></button>
        </div>
      )}
      {panel && (
        <Pickers
          onClose={() => setPanel(false)}
          onPick={(r) => {
            // An emoji is text: it belongs in the draft, so it stays inside this component and the
            // message list never hears about it.
            if (r.kind === "emoji") { change(draft + r.char); return; }
            setPanel(false);
            onPick(r);
          }} />
      )}
      {asked ? (
        <p className="mb-2 px-1 text-[12px] text-ink-3">
          Message request — {requestLeft} of 3 messages left until they accept.
        </p>
      ) : willRequest ? (
        /* SAID BEFORE THE FIRST WORD, because that is when it changes what you write. `asked` can
           only be true once a message exists, so someone writing to a stranger used to learn their
           message was a request — capped at three, delivered only if the other side agrees — from a
           line that appeared afterwards. */
        <p className="mb-2 px-1 text-[12px] text-ink-3">
          <span data-ay-skip="1" className="font-semibold text-ink-2">{peerName}</span>{" "}
          <span>doesn’t follow you, so this starts as a message request: up to three messages, and they
          arrive once it’s accepted.</span>
        </p>
      ) : null}
      <div className="flex items-end gap-1.5">
        <button type="button" aria-label="Emoji, stickers and GIFs" title="Emoji, stickers, GIFs"
          aria-expanded={panel} onClick={() => setPanel((v) => !v)}
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors hover:bg-veil/[0.07] hover:text-ink ${
            panel ? "bg-veil/[0.10] text-ink" : "text-ink-3"}`}><Ic d={IC.smile} size={18} /></button>
        <label aria-label="Send an encrypted photo, video or file" title="Photo, video or file"
          className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/[0.07] hover:text-ink">
          <Ic d={IC.clip} size={18} />
          <input type="file" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f, f.type); e.target.value = ""; }} />
        </label>
        <GrowingTextarea value={draft} onChange={change}
          placeholder={editing ? "Edit your message…" : "Write an encrypted message…"}
          onKeyDown={(e) => {
            // ENTER SENDS — unless the draft is mid-code-fence, where it adds a line instead.
            // Writing a function into a box that fires on Enter is otherwise a fight, and
            // Shift+Enter is not something you should have to know to paste six lines of Python.
            if (e.key === "Enter" && !e.shiftKey && !insideFence(draft)) { e.preventDefault(); send(); }
            if (e.key === "Escape" && (replyTo || editing || panel)) {
              // Claim the key so the surrounding dock does not also close (which would throw away
              // the message being typed). An Escape with nothing to cancel bubbles on.
              e.preventDefault();
              if (panel) setPanel(false); else onCancel();
            }
          }}
          onPaste={(e) => {
            const f = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"))?.getAsFile();
            if (f) { e.preventDefault(); onFile(f, f.type); }
          }}
          disabled={busy && !draft} />
        {draft.trim() ? (
          <button type="button" aria-label={editing ? "Save edit" : "Send"} onClick={send} disabled={busy}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-yang text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"><Ic d={IC.send} size={18} /></button>
        ) : (
          <VoiceButton disabled={busy} onDone={(b, mime, dur) => onFile(b, mime, { dur, voice: true })} />
        )}
      </div>
    </div>
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
  const [replyTo, setReplyTo] = useState<Item | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [panel, setPanel] = useState<"" | "code" | "timer" | "search" | "menu">("");
  const [query, setQuery] = useState("");
  /** My side of this conversation, as the server sees it: is it an unanswered request (theirs or
   *  mine), has either of us blocked the other, is it muted/pinned/archived. Refreshed every poll,
   *  because the OTHER side can change it — accepting my request has to unlock my composer without
   *  a reload. */
  const [rel, setRel] = useState({
    pending: false, asked: false, will_request: false, request_left: 3, blocked: false, blocked_by: false,
    muted: false, pinned: false, archived: false,
  });
  // ── Calling ────────────────────────────────────────────────────────────────
  // The call itself lives in a ref (it owns hardware and a peer connection, and must not be
  // recreated by a re-render); everything the UI needs to draw is mirrored into state.
  const callRef = useRef<Call | null>(null);
  const [callState, setCallState] = useState<CallState>("idle");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [askNote, setAskNote] = useState(false); // showing the one-time "this is direct" note
  /** Signalling rows already applied, so a poll handing back the same sealed row twice — which it
   *  legitimately does — cannot re-apply an offer or answer to a live peer connection. */
  const seenRtc = useRef(new Set<number>());
  /** Mirrors "a call is happening" for the poll scheduler, which reads it outside React's render
   *  cycle — see schedule(). Ringing counts: the offer needs its answer to cross quickly too. */
  const callActive = useRef(false);
  /** When this conversation last carried anything, and whether the peer is present. Together they
   *  drive the poll cadence — see schedule(). Refs, so the scheduler reads them without a render. */
  const lastActivity = useRef(nowMs());
  const peerHere = useRef(false);
  const [acting, setActing] = useState(false); // a relation change is in flight
  /**
   * The two irreversible-ish buttons ask once before doing it.
   *
   * `Unsend` HARD-DELETES the row — from the public database, for both people, with no undo — and it
   * sat one stray click away from Edit on every bubble. `Block` sits in a seven-item menu and closes
   * the conversation. Neither is a thing to do by accident, and a second click is a much smaller
   * cost than either mistake.
   */
  /** Which bubble is showing its actions. On a touch surface there is no hover to reveal them, and
   *  the previous answer — show them on EVERY bubble, always — put a full reaction bar and an
   *  Unsend button under every single message in the dock. Tapping a bubble opens its actions;
   *  tapping it again, or anything else, closes them. */
  const [openActions, setOpenActions] = useState(0);
  const [confirmUnsend, setConfirmUnsend] = useState(0);
  const [confirmBlock, setConfirmBlock] = useState(false);
  // …and the unsend question times out. On a desktop the bubble's actions are hover-revealed, so a
  // half-asked "Delete?" would otherwise still be armed the next time the pointer passed over it,
  // minutes later, with the member no longer expecting it.
  useEffect(() => {
    if (!confirmUnsend) return;
    const t = setTimeout(() => setConfirmUnsend(0), 5000);
    return () => clearTimeout(t);
  }, [confirmUnsend]);
  // { url, mime } rather than a bare url: the viewer now opens video as well as stills, so it
  // has to be told which. Was `string | null` when only images could be enlarged.
  const [zoom, setZoom] = useState<{ url: string; mime: string } | null>(null);
  const [media, setMedia] = useState<Record<number, string | null>>({});
  const [atBottom, setAtBottom] = useState(true);
  const [missed, setMissed] = useState(0);

  const lastId = useRef(0);
  const keyCache = useRef(new Map<string, CryptoKey>());
  const objectUrls = useRef(new Set<string>());
  /** Attachment ids already fetched, so the decrypt effect never re-scans on its own output. */
  const asked = useRef(new Set<number>()); // decrypted attachment URLs awaiting revocation
  const scroller = useRef<HTMLDivElement | null>(null);
  // WATCH THE STREAM ONCE, AND DISCONNECT IT. This used to hang off an INLINE REF CALLBACK,
  // which React re-invokes on every render because the arrow is a new function each time — so
  // a busy conversation built one MutationObserver per render on the same node and threw away
  // every cleanup function watchMath returned. An effect runs it once per mount and hands the
  // disconnect back to React, which is the only arrangement where the teardown actually runs.
  useEffect(() => watchMath(scroller.current, "auto"), []);
  const rowRefs = useRef(new Map<number, HTMLElement>());
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
          if (!next) return prev;
          if (prev && prev.kid === next.kid) return prev; // same key — keep the identity, skip a render
          if (prev) keyCache.current.clear();             // they rotated: derived keys are now wrong
          return next;
        });
        // ONLY WHEN SOMETHING ACTUALLY CHANGED. These objects were rebuilt on every tick, and a new
        // object identity is a state change as far as React is concerned — so a conversation nobody
        // was touching re-rendered its entire message list every 4 seconds, for nothing. Measured on
        // a 50-message thread: 1.46s of scripting per 24 idle seconds, 859ms of it blocking.
        peerHere.current = page.peer_online || page.peer_typing;
        setLive((cur) => (cur.read === page.peer_read && cur.typing === page.peer_typing
          && cur.online === page.peer_online && cur.ttl === page.ttl
          ? cur
          : { read: page.peer_read, typing: page.peer_typing, online: page.peer_online, ttl: page.ttl }));
        // COMPARED FROM THE OBJECT ITSELF, not from a hand-written list of its fields. The
        // equality check named eight of them explicitly, and the ninth — added with this change —
        // was simply not in it: the poll built a correct object every tick and threw it away
        // because the fields it happened to check had not moved. A guard you must remember to
        // extend is a guard that silently stops guarding the newest thing.
        const nextRel = {
          pending: page.pending, asked: page.asked, will_request: page.will_request, request_left: page.request_left,
          blocked: page.blocked, blocked_by: page.blocked_by,
          muted: page.muted, pinned: page.pinned, archived: page.archived,
        };
        setRel((cur) => ((Object.keys(nextRel) as (keyof typeof nextRel)[]).every((k) => cur[k] === nextRel[k]) ? cur : nextRel));
        const plain = await decrypt(page);
        if (stop) return;
        if (plain.length) {
          lastActivity.current = nowMs();   // they said something — stay responsive
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
      // THE POLL IS THE SIGNALLING CHANNEL while a call is being set up (lib/webrtc.ts), so it runs
      // much faster then. Read from a ref rather than a dependency so speeding up does not tear
      // down and rebuild the whole polling effect mid-handshake.
      //
      // And a conversation nobody has spoken in for a while slows down. An open thread costs a
      // request every four seconds forever, on a platform built to read-scale — but a thread that
      // has been silent for two minutes does not need the same urgency as one mid-exchange, and any
      // message (either direction) snaps it straight back. The member never waits longer for a
      // reply to something they just said.
      // Backing off on silence ALONE would have cost up to ten seconds on the first message after
      // a lull, which is exactly the moment a chat must feel alive. Presence removes the tradeoff:
      // slow down only when the other person is not even here — nothing is about to arrive — and
      // stay at full speed whenever they are, however long the pause has been.
      const dormant = !peerHere.current && nowMs() - lastActivity.current > QUIET_AFTER_MS;
      timer = setTimeout(() => tick(false), callActive.current ? CALL_POLL_MS : dormant ? IDLE_POLL_MS : POLL_MS);
    }
    function onVis() {
      if (document.hidden) { clearTimeout(timer); timer = undefined; return; }
      if (!timer && !inFlight) void tick(false); // catch up on everything missed while away
    }
    const urls = objectUrls.current;
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls.clear();
    setItems([]); setMedia({}); setOlder(null); lastId.current = 0; keyCache.current.clear();
    // …and forget which attachments were fetched, or coming back to this conversation would show
    // empty bubbles: the media state is cleared above, so the guard must be cleared with it.
    asked.current.clear();
    setPeerKey(null); setCode(null); setPanel(""); setReplyTo(null); setEditing(null); setMissed(0);
    setDeliveredTo(0);
    // Switching conversation ENDS the call — and `close()` is what actually stops the camera and
    // microphone. Without this the hardware would stay live for a conversation nobody is looking at.
    callRef.current?.close();
    callRef.current = null;
    setCallState("idle"); setLocalStream(null); setRemoteStream(null); seenRtc.current.clear();
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
      // The call handshake is machinery, not conversation: applied by the signalling effect and
      // never drawn. Rendering an SDP offer as a bubble would be both unreadable and enormous.
      if (p.t === "rtc") { continue; }
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
    // ONE ROW PER CALL. Every call wrote two bubbles — "You started a call" then "Call ended" —
    // so a few calls filled the whole conversation with machinery. The end is folded into the start
    // (which is where the duration belongs), and only an orphan end — one whose start has scrolled
    // out of the loaded page — is drawn on its own.
    const callEnd = new Map<string, { at: number; why?: string }>();
    const callStartSids = new Set<string>();
    for (const m of render) {
      const p = m.payload;
      if (p?.t !== "call" || !p.sid) continue;
      if (p.act === "end") callEnd.set(p.sid, { at: m.at, why: p.why });
      else callStartSids.add(p.sid);
    }
    const textOf = new Map<number, string>();
    for (const m of render) {
      const p = m.payload;
      if (p && (p.t === "text" || p.t === "img" || p.t === "file") && (edits.get(m.id) ?? p.body)) textOf.set(m.id, edits.get(m.id) ?? p.body ?? "");
      if (p && p.t === "voice") textOf.set(m.id, "Voice message");
      if (p && p.t === "img" && !textOf.has(m.id)) textOf.set(m.id, p.att.gif ? "GIF" : "Photo");
      if (p && p.t === "stick") textOf.set(m.id, stickerLabel(p.id) + " sticker");
      if (p && p.t === "call") textOf.set(m.id, p.act === "start" ? "Video call" : "Call ended");
      if (p && p.t === "file" && !textOf.has(m.id)) textOf.set(m.id, p.att.name || "File");
    }
    const rows = render.filter((m) => {
      if (dels.has(m.id)) return false;
      const p = m.payload;
      return !(p?.t === "call" && p.act === "end" && p.sid && callStartSids.has(p.sid));
    });
    // ONE NOTICE PER RUN OF UNREADABLE MESSAGES, for the same reason calls fold above: a member
    // whose device key changed does not have "a problem with message 41" — they have a STRETCH of
    // history this browser cannot open, and repeating the same italic apology once per message
    // turned a whole conversation into a wall of it (operator screenshot, 2026-08-09). Collapsing
    // says the true thing once, with the size of it, and leaves room to explain what happened.
    // A LONE unreadable message stays inline: one line is a footnote, not a wall.
    const sealedHead = new Map<number, { n: number; from: number; to: number }>();
    const sealedSkip = new Set<number>();
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].payload !== null) continue;
      let j = i;
      while (j + 1 < rows.length && rows[j + 1].payload === null) j++;
      if (j > i) {
        sealedHead.set(rows[i].id, { n: j - i + 1, from: rows[i].at, to: rows[j].at });
        for (let k = i + 1; k <= j; k++) sealedSkip.add(rows[k].id);
      }
      i = j;
    }
    return { rows, edits, reacts, textOf, callEnd, sealedHead, sealedSkip };
  }, [items]);

  /**
   * The incoming offer worth ringing about: the newest `rtc:offer` from the other side whose call
   * has not since been ended, and which is young enough to still be somebody waiting on a screen.
   *
   * Read off the message stream because the stream IS the signalling channel — there is no call
   * server to ask. `ringTick` (below) is what makes it expire; memoising on the messages alone
   * meant an unanswered call rang forever on a quiet conversation.
   */
  /**
   * The newest offer that has not been cancelled — WITHOUT the freshness test, so this depends only
   * on the messages and re-computes only when they change.
   */
  const offerRaw = useMemo(() => {
    let found: { sid: string; sdp: string; at: number; id: number } | null = null;
    const dead = new Set<string>();
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i];
      const p = m.payload;
      if (!p) continue;
      if (p.t === "rtc" && p.kind === "bye") { dead.add(p.sid); continue; }
      if (p.t === "call" && p.act === "end" && p.sid) { dead.add(p.sid); continue; }
      if (p.t === "rtc" && p.kind === "offer" && m.sender !== me && p.sdp) {
        if (dead.has(p.sid)) return null;
        found = { sid: p.sid, sdp: p.sdp, at: m.at, id: m.id };
        break;
      }
    }
    return found;
  }, [items, me]);

  /**
   * A clock, purely so a ringing offer STOPS ringing on its own — a memo over the message list
   * never re-runs on a quiet conversation, so the phone would ring forever.
   *
   * It only ticks WHILE there is something to expire. Running it unconditionally re-rendered the
   * whole thread every five seconds for every member with a conversation open, forever, to check a
   * condition that is almost always false.
   */
  const [ringTick, setRingTick] = useState(0);
  useEffect(() => {
    if (!offerRaw) return;
    const t = setInterval(() => setRingTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [offerRaw]);

  const offer = useMemo(() => {
    void ringTick;
    if (!offerRaw) return null;
    return nowSec() - offerRaw.at > CALL_LIVE_S ? null : offerRaw; // nobody is still holding the phone
  }, [offerRaw, ringTick]);

  /**
   * The signalling loop.
   *
   * Every sealed `rtc` row that arrives is applied to the peer connection exactly once: their
   * ANSWER completes the call we started, their BYE ends it. Their OFFER is deliberately NOT
   * auto-answered — answering opens a camera, and that is always the member's own act (see
   * `answerCall`).
   */
  useEffect(() => {
    for (const m of items) {
      const p = m.payload;
      if (!p || p.t !== "rtc" || m.id <= 0 || seenRtc.current.has(m.id)) continue;
      seenRtc.current.add(m.id);
      if (m.sender === me) continue;                 // our own signalling, echoed back by the poll
      const call = callRef.current;
      if (!call || call.closed || call.sid !== p.sid) continue;
      if (p.kind === "answer" && p.sdp) {
        call.accept(p.sdp).catch(() => setCallState("failed"));
      } else if (p.kind === "bye") {
        hangUp(false); // they hung up — tear down, but don't send a second bye back
      }
    }
    // `hangUp` is stable enough for this purpose and re-creating the effect on every render would
    // re-scan the whole list; the guard above makes re-entry harmless either way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, me]);

  /**
   * The member pressed Answer on the ring banner somewhere else on the site, and this thread is the
   * first thing that can act on it — the offer only exists here. Runs the moment the offer arrives,
   * once, so "Answer" means answer instead of "open the conversation and press Answer again".
   */
  useEffect(() => {
    if (offer && callState === "idle" && takeAutoAnswer(peer.id)) void answerCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer, callState, peer.id]);

  /**
   * A call nobody answers has to give up.
   *
   * The callee's ring expires on its own (CALL_LIVE_S), but the CALLER had nothing watching: place
   * a call to someone who has closed their laptop and it sat on "Ringing…" indefinitely, holding
   * the camera open, with no way to tell that it was never going to be answered.
   */
  useEffect(() => {
    if (callState !== "calling") return;
    const t = setTimeout(() => hangUp(true, "missed"), CALL_LIVE_S * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callState]);

  // Keep the poll scheduler's view of "busy" in step with the UI's.
  useEffect(() => { callActive.current = callState !== "idle" || !!offer; }, [callState, offer]);

  /** Wire a fresh Call to this component's state. */
  function newCall(sid: string) {
    const c = new Call(sid, {
      onState: setCallState,
      onLocal: setLocalStream,
      onRemote: setRemoteStream,
    });
    callRef.current = c;
    setMicOn(true);
    setCamOn(true);
    return c;
  }

  // The options dropdown closes the way every dropdown does: click anywhere else, or press Escape.
  // Without this the only way out was pressing the same button again — so a member who opened it,
  // decided against it and clicked back into the conversation was left with a menu covering their
  // messages. Scoped to the dropdown; the inline panels (search/timer/safety code) are part of the
  // conversation and stay until dismissed on purpose.
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (panel !== "menu") return;
    const shut = () => { setPanel(""); setConfirmBlock(false); }; // never reopen mid-confirmation
    const away = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) shut(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); shut(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc, true); // capture: claim Escape before the dock closes
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [panel]);

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
      if (!p || (p.t !== "img" && p.t !== "voice" && p.t !== "file")) continue;
      // Guarded by a ref, not by `media`. Depending on the state this effect SETS meant it re-ran —
      // and re-scanned every row in the conversation — once for each attachment that resolved.
      if (asked.current.has(m.id)) continue;
      asked.current.add(m.id);
      setMedia((cur) => ({ ...cur, [m.id]: null }));
      openAttachment(p.att).then((u) => {
        if (u) objectUrls.current.add(u);
        setMedia((cur) => ({ ...cur, [m.id]: u }));
      });
    }
  }, [view.rows]);

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
  //
  // Four separate reasons the composer can be closed, and they are NOT the same message: no device
  // key to seal to · they blocked me · I blocked them · my request is used up. Collapsing them into
  // one "you can't send" would leave three of the four unexplainable and unfixable.
  const canSend = !!peerKey && !rel.blocked && !rel.blocked_by && !(rel.asked && rel.request_left <= 0);

  async function sealAndSend(payload: ChatPayload, blobName?: string): Promise<boolean> {
    if (!peerKey) return false;
    const akid = me === low ? myKey.kid : peerKey.kid;
    const bkid = me === low ? peerKey.kid : myKey.kid;
    const key = await convKey(akid, bkid, peerKey.pub);
    const sealed = await sealMessage(key, encodePayload(payload), low, high, me);
    const temp = tempSeq.current--;
    // `rtc` rows are the call handshake: no bubble, no optimistic echo, no notification.
    const isBubble = payload.t === "text" || payload.t === "img" || payload.t === "voice"
      || payload.t === "file" || payload.t === "stick" || payload.t === "call";
    if (isBubble) merge([{ id: temp, sender: me, at: nowSec(), payload, pending: true }]);
    try {
      // Only a real message rings the peer's bell and their inbox — a reaction, an edit or a
      // tombstone must not. The server can't distinguish them (identical ciphertext by design),
      // so the sender's client is the one that knows. A CALL is a bubble but still silent here:
      // chat/call already pushes "X is calling you", and a second notification five minutes later
      // saying they sent a message would be about a call that has long since stopped ringing.
      const r = await chatSend(peer.id, {
        ...sealed, akid, bkid, ...(blobName ? { blob: blobName } : {}),
        notify: isBubble && payload.t !== "call" ? 1 : 0,
      });
      lastId.current = Math.max(lastId.current, r.id);
      lastActivity.current = nowMs();   // we said something — expect a reply soon
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

  async function submit(text: string) {
    if (!text || busy || !canSend) return;
    setBusy(true);
    const payload: ChatPayload = editing
      ? { v: 2, t: "edit", ref: editing.id, body: text }
      : { v: 2, t: "text", body: text, ...(replyTo ? { ref: replyTo.id } : {}) };
    const ok = await sealAndSend(payload);
    if (ok) { setReplyTo(null); setEditing(null); }
    setBusy(false);
  }

  /** Seal + send any attachment: images (and GIFs) → img, recorded notes → voice, everything else
   *  (video/audio/documents) → file, rendered by its mime. Name/mime travel INSIDE the seal. */
  async function sendBytes(bytes: ArrayBuffer, mime: string, extra?: { dur?: number; voice?: boolean; gif?: boolean; name?: string }) {
    if (!canSend || busy) return;
    setNote(null);
    setBusy(true);
    try {
      if (bytes.byteLength > 5500000) {
        setNote("That file is too big — encrypted attachments are capped at 6 MB.");
        return;
      }
      let w: number | undefined, h: number | undefined;
      if (mime.startsWith("image/")) {
        // Layout hint only: without it the bubble has no aspect ratio until the decrypted bytes
        // arrive, and the whole thread jumps when they do.
        try {
          const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
          w = bmp.width; h = bmp.height; bmp.close();
        } catch { /* a format createImageBitmap won't decode — the bubble just sizes itself later */ }
      }
      const { sealed, k, iv } = await sealAttachment(bytes);
      const up = await chatUploadBlob(sealed);
      const gif = extra?.gif || mime === "image/gif";
      const att: SealedAttachment = {
        blob: up.blob, url: up.url, k, iv, mime, size: bytes.byteLength, w, h, dur: extra?.dur,
        ...(gif ? { gif: true } : {}),
      };
      const ref = replyTo ? { ref: replyTo.id } : {};
      const payload: ChatPayload = extra?.voice
        ? { v: 2, t: "voice", att, ...ref }
        : mime.startsWith("image/")
          ? { v: 2, t: "img", att, ...ref }
          : { v: 2, t: "file", att: { ...att, name: extra?.name }, ...ref };
      const ok = await sealAndSend(payload, up.blob);
      if (ok) setReplyTo(null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  /** The File/Blob front door onto sendBytes — the file input, paste, drop and the voice recorder. */
  async function sendFile(file: File | Blob, mime: string, extra?: { dur?: number; voice?: boolean }) {
    const name = file instanceof File && file.name ? file.name : undefined;
    await sendBytes(await file.arrayBuffer(), mime, { ...extra, name });
  }

  /** Everything the +/picker can produce, sent by the one route that fits it. */
  async function pick(r: Exclude<PickerResult, { kind: "emoji" }>) {
    // Emoji never arrive here: the Composer keeps them in its own draft (see its onPick).
    if (r.kind === "sticker") {
      // A sticker is an ID, not bytes: nothing is uploaded, and the row is the same size as a short
      // sentence. See components/chat/stickers.ts for why that is a privacy property, not a saving.
      await sealAndSend({ v: 2, t: "stick", id: r.id, ...(replyTo ? { ref: replyTo.id } : {}) });
      setReplyTo(null);
      return;
    }
    await sendBytes(r.bytes, r.mime, { gif: r.gif });
  }

  /**
   * PLACE A CALL. Open the camera, build an offer with its ICE candidates already in it, seal that
   * into the conversation, and ring.
   *
   * Order matters, and it is the reverse of what it was. The offer must be IN the thread before the
   * beacon fires: the beacon carries nothing but "somebody is calling", so a peer who answers finds
   * the handshake by opening the conversation — and an answer that arrives before the offer has
   * nothing to answer.
   *
   * The camera is opened BEFORE anything is sent, so a member who refuses the permission prompt has
   * not already rung somebody they cannot now talk to.
   */
  async function startCall() {
    if (!canSend || busy || callRef.current) return;
    if (!callSupported()) { setNote("This browser can’t make calls — try a current one over HTTPS."); return; }
    // The one-time note about what "direct" costs. Asked once per device, before the first call.
    try {
      if (!localStorage.getItem(CALL_NOTE_KEY)) { setAskNote(true); return; }
    } catch { /* private mode — just proceed */ }
    const sid = newCallSid();
    const call = newCall(sid);
    let sdp: string;
    try {
      sdp = await call.offer();
    } catch (e) {
      call.close(); callRef.current = null; setCallState("idle");
      setNote(mediaErrorMessage(e));
      return;
    }
    // Two sealed rows: the handshake (silent) and the visible "a call happened" bubble.
    const ok = await sealAndSend({ v: 2, t: "rtc", kind: "offer", sid, sdp });
    if (!ok) {
      call.close(); callRef.current = null; setCallState("idle");
      setNote("Couldn’t start the call — check your connection.");
      return;
    }
    void sealAndSend({ v: 2, t: "call", act: "start", sid });
    chatCall(peer.id, "ring").catch(() => undefined);
  }

  /** ANSWER: build the answer to their offer and seal it back. Opens the camera first, same reason. */
  async function answerCall() {
    if (!offer || callRef.current) return;
    clearRing();
    const call = newCall(offer.sid);
    let sdp: string;
    try {
      sdp = await call.answer(offer.sdp);
    } catch (e) {
      call.close(); callRef.current = null; setCallState("idle");
      setNote(mediaErrorMessage(e));
      return;
    }
    void sealAndSend({ v: 2, t: "rtc", kind: "answer", sid: offer.sid, sdp });
  }

  /**
   * HANG UP — the one exit for every way a call can end: leaving, declining, or the other side
   * going away.
   *
   * `tell` is false only when THEY hung up, so the two sides don't bounce a goodbye back and forth.
   * Closing the Call is what actually stops the camera and microphone (see Call.close), so it
   * happens unconditionally and first — a failed network call must never leave the hardware live.
   */
  function hangUp(tell = true, why?: "declined" | "missed" | "failed") {
    const call = callRef.current;
    const sid = call?.sid ?? offer?.sid;
    call?.close();
    callRef.current = null;
    setCallState("idle");
    setLocalStream(null);
    setRemoteStream(null);
    clearRing();
    if (tell) {
      chatCall(peer.id, "end").catch(() => undefined);
      if (sid) {
        void sealAndSend({ v: 2, t: "rtc", kind: "bye", sid });
        void sealAndSend({ v: 2, t: "call", act: "end", sid, ...(why ? { why } : {}) });
      }
    }
  }

  // Leaving the conversation, or the page, ends the call. Without this the peer connection and the
  // camera would outlive the screen that was showing them.
  useEffect(() => () => { callRef.current?.close(); callRef.current = null; }, []);

  /** Accept / decline / block / mute / pin / archive — optimistic, because these are buttons whose
   *  whole job is to change what is on screen. */
  async function relate(action: ChatRelation) {
    if (acting) return;
    setActing(true);
    try {
      const r = await chatRelation(peer.id, action);
      setRel((s) => ({ ...s, pending: r.pending, blocked: r.blocked, muted: r.muted, pinned: r.pinned, archived: r.archived }));
      // Accepting/declining a request empties one row from the list behind this thread.
      if (action === "accept" || action === "decline") bumpRequests(-1);
      applyRelation(peer.id, { pending: r.pending, blocked: r.blocked, muted: r.muted, pinned: r.pinned, archived: r.archived },
        action === "decline" || action === "block" || action === "archive");
      if (action === "decline" || action === "block") onBack();
    } catch {
      setNote("Couldn’t save that — try again.");
    }
    setActing(false);
  }

  async function toggleReact(m: Item, emoji: string) {
    await sealAndSend({ v: 2, t: "react", ref: m.id, emoji });
  }

  async function unsend(m: Item) {
    await sealAndSend({ v: 2, t: "del", ref: m.id }); // live tombstone for the peer's open screen
    try { await chatUnsend(m.id); } catch { /* row already carries the tombstone */ }
    setItems((cur) => cur.filter((x) => x.id !== m.id));
  }


  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) sendFile(f, f.type);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <section onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
      /* A HEIGHT CAP IS WHAT MAKES THE MESSAGE LIST SCROLL. Without one this container simply grew
         to fit every message — 4,800px for fifty of them — so the inner `overflow-y-auto` had
         nothing to scroll, the whole PAGE became the scroller, and the composer sat thousands of
         pixels below the fold. Stick-to-bottom silently did nothing too, because the element it
         scrolls was never scrollable. `dvh` rather than `vh` so a phone's retracting address bar
         does not leave the composer under the viewport edge. */
      /* EDGE TO EDGE ON A PHONE. The card treatment — gutter, rounded corners, border, shadow —
         cost 48px of a 393px screen, 12% of the width, to draw a frame around the only thing on
         screen. Every phone chat app is full-bleed for exactly this reason: the conversation IS
         the page there. The frame comes back at `md`, where the thread sits BESIDE the list and
         the border is what separates them. */
      className={`flex min-h-0 flex-col overflow-hidden bg-space-2 ${
        compact
          ? "flex-1"
          : "h-[calc(100dvh-7.75rem)] min-h-[380px] max-md:-mx-gutter md:h-auto md:min-h-0 md:w-full md:max-w-2xl md:flex-1 md:rounded-card md:border md:border-line md:shadow-card"}`}
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
        {/* NAME OVER STATUS, not beside it. Side by side, the name had `flex-1` — which is
            `flex-basis: 0%` — while the status line was sized by its content, so on a 393px phone
            the browser gave the status its 125px and squeezed the name to LITERALLY ZERO: you
            opened a conversation and could not see who it was with. Stacking makes the name the
            thing that gets the width, and it is what every chat app does with the same two facts. */}
        {!compact && (
          <>
            <span className="relative shrink-0">
              <Avatar src={peer.avatar} name={peer.name} className="h-9 w-9" />
              {live.online && <span className="absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full border-2 border-space-2 bg-yang" title="Active now" />}
            </span>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <a href={localePath(`/u/${peer.slug}/`)} data-ay-skip="1" className="truncate text-[15px] font-semibold text-ink hover:text-yin-light">{peer.name}</a>
              <span className="truncate text-[11.5px] text-ink-3" aria-live="polite">
                {live.typing ? "typing…" : live.online ? "Active now" : rel.muted ? "Muted" : "End-to-end encrypted"}
              </span>
            </span>
          </>
        )}
        {compact && (
          <p className="min-w-0 flex-1 truncate text-[12px] text-ink-3" aria-live="polite">
            {live.typing ? "typing…" : live.online ? "Active now" : rel.muted ? "Muted" : "End-to-end encrypted"}
          </p>
        )}
        {/* TWO controls, not five. Call is the one action worth its own button; everything else
            lives behind the menu, where it can carry a word instead of a glyph nobody can decode. */}
        <button type="button" aria-label="Start a video call" title="Video call" disabled={!canSend || callState !== "idle" || !!offer}
          onClick={() => void startCall()}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/[0.07] hover:text-ink disabled:opacity-30">
          <Ic d={IC.video} size={18} />
        </button>
        <div className="relative shrink-0" ref={menuRef}>
          <button type="button" aria-label="Conversation options" aria-expanded={panel === "menu"}
            onClick={() => setPanel((p) => (p === "menu" ? "" : "menu"))}
            className={`grid h-9 w-9 place-items-center rounded-full transition-colors hover:bg-veil/[0.07] ${panel === "menu" ? "text-ink" : "text-ink-3 hover:text-ink"}`}>
            <Ic d={IC.more} size={17} />
          </button>
          {panel === "menu" && confirmBlock && (
            /* Blocking closes the conversation and stops them writing. Worth one question. */
            <div className="absolute end-0 top-10 z-30 w-64 rounded-card border border-line bg-space-2 p-3 shadow-card">
              <p className="text-[12.5px] leading-relaxed text-ink-2">
                <span>Block</span>{" "}
                <span data-ay-skip="1" className="font-semibold text-ink">{peer.name}</span>
                <span>? They won’t be able to message or call you. Nothing here is deleted, and you can undo this from the Blocked list.</span>
              </p>
              <div className="mt-2.5 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmBlock(false)}
                  className="rounded-pill border border-line px-3 py-1 text-[12px] font-semibold text-ink-2 hover:text-ink">Cancel</button>
                <button type="button" disabled={acting}
                  onClick={() => { setConfirmBlock(false); setPanel(""); void relate("block"); }}
                  className="rounded-pill bg-yang px-3 py-1 text-[12px] font-bold text-on-accent hover:opacity-90 disabled:opacity-50">Block</button>
              </div>
            </div>
          )}
          {panel === "menu" && !confirmBlock && (
            <ul className="absolute end-0 top-10 z-30 w-56 overflow-hidden rounded-card border border-line bg-space-2 py-1 shadow-card"
              role="menu" aria-label="Conversation options">
              {([
                { k: "search", icon: IC.search, label: "Search this conversation", run: () => setPanel("search") },
                { k: "timer", icon: IC.timer, label: "Disappearing messages", run: () => setPanel("timer") },
                { k: "code", icon: IC.shield, label: "Safety code", run: () => setPanel("code") },
                { k: "pin", icon: IC.pin, label: rel.pinned ? "Unpin" : "Pin to top", run: () => { setPanel(""); void relate(rel.pinned ? "unpin" : "pin"); } },
                { k: "mute", icon: rel.muted ? IC.bell : IC.mute, label: rel.muted ? "Unmute" : "Mute notifications", run: () => { setPanel(""); void relate(rel.muted ? "unmute" : "mute"); } },
                { k: "arch", icon: IC.archive, label: rel.archived ? "Move to inbox" : "Archive", run: () => { setPanel(""); void relate(rel.archived ? "unarchive" : "archive"); } },
                // Unblocking is harmless and immediate; blocking asks first (see confirmBlock).
                { k: "block", icon: IC.block, label: rel.blocked ? "Unblock" : "Block this member",
                  run: () => { if (rel.blocked) { setPanel(""); void relate("unblock"); } else { setConfirmBlock(true); } } },
              ] as const).map((it) => (
                <li key={it.k} role="none">
                  <button type="button" role="menuitem" onClick={it.run} disabled={acting}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-start text-[13px] hover:bg-veil/[0.07] disabled:opacity-50 ${
                      it.k === "block" ? "text-yang" : "text-ink-2"
                    }`}>
                    <Ic d={it.icon} size={15} />{it.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>

      {/* The one-time note about what a direct connection costs, before the first call ever placed
          from this device. Answering does not show it: by then somebody is already waiting. */}
      {askNote && (
        <CallPrivacyNote peerName={peer.name}
          onCancel={() => setAskNote(false)}
          onAccept={() => {
            try { localStorage.setItem(CALL_NOTE_KEY, "1"); } catch { /* private mode */ }
            setAskNote(false);
            void startCall();
          }} />
      )}

      {/* A call in progress. Above the stream, so it can't be scrolled past. */}
      {callState !== "idle" && (
        <CallPanel
          state={callState} local={localStream} remote={remoteStream}
          peerName={peer.name} peerAvatar={peer.avatar}
          micOn={micOn} camOn={camOn}
          onMic={() => { const on = callRef.current?.toggleMic(); setMicOn(!!on); }}
          onCam={() => { const on = callRef.current?.toggleCam(); setCamOn(!!on); }}
          onHangup={() => hangUp(true)} />
      )}

      {/* Their offer, still ringing. Answering is always the member's own act — it opens a camera. */}
      {callState === "idle" && offer && (
        <div className="flex items-center gap-2.5 border-b border-line bg-yang/[0.07] px-3 py-2.5">
          <span className="flex h-2 w-2 shrink-0 animate-pulse rounded-full bg-yang" aria-hidden />
          <p className="min-w-0 flex-1 text-[13px] text-ink">
            <span data-ay-skip="1" className="font-semibold">{peer.name}</span>{" "}
            <span>is calling</span>
          </p>
          <button type="button" onClick={() => hangUp(true, "declined")}
            className="rounded-pill border border-line px-2.5 py-1 text-[12px] font-semibold text-ink-3 hover:text-ink">Decline</button>
          <button type="button" onClick={() => void answerCall()}
            className="rounded-pill bg-yang px-3 py-1 text-[12px] font-bold text-on-accent hover:opacity-90">Answer</button>
        </div>
      )}

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
      <div ref={scroller} onScroll={onScroll}
        onPointerDown={(e) => {
          // A tap on empty space dismisses an open action bar. Guarded on the target so the tap
          // that OPENS one (handled on the bubble) is not immediately undone by this.
          if (openActions && !(e.target as HTMLElement).closest("[data-actions],[data-bubble]")) setOpenActions(0);
        }} className={`relative flex-1 overflow-y-auto py-3 ${compact ? "px-3" : "px-3 md:px-4"}`}>
        {older !== null && (
          <div className="pb-2 text-center">
            <button type="button" className="rounded-pill border border-line px-3.5 py-1 text-[12px] font-semibold text-ink-2 hover:border-yin-light hover:text-ink"
              onClick={async () => {
                try {
                  const page = await chatMessages(peer.id, { cursor: older });
                  const rows = (await decrypt(page)).reverse();
                  // KEEP THE READER WHERE THEY ARE. Prepending content above the viewport moves
                  // everything down by exactly the height that was added, so without this the
                  // message you were reading jumps off the screen the instant the older ones load —
                  // and you have to scroll back to find your place every single time.
                  const el = scroller.current;
                  const before = el ? el.scrollHeight - el.scrollTop : 0;
                  setOlder(page.next);
                  merge(rows, true);
                  if (el) {
                    // After paint, restore the distance from the BOTTOM, which is the thing that
                    // did not change.
                    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - before; });
                  }
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
              // A run of messages this device cannot open is drawn ONCE, as a system note.
              if (view.sealedSkip.has(m.id)) return null;
              const sealedRun = view.sealedHead.get(m.id);
              if (sealedRun) {
                return (
                  <li key={m.id}>
                    {newDay && (
                      <p className="py-3 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-3">{fmtDay(m.at)}</p>
                    )}
                    <div className="my-2.5 rounded-card border border-line bg-veil/[0.04] px-3 py-2.5 text-center">
                      <p className="text-[12.5px] font-semibold text-ink-2">
                        <span data-ay-skip="1">{sealedRun.n}</span> messages can’t be opened on this device
                      </p>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
                        They were sealed to an encryption key this browser no longer has — clearing this site’s data,
                        or signing in from a different device, creates a new one. Nobody can recover them for you, and
                        that is the point: not us, and not anyone who takes the database. The other person still reads
                        their copy, and everything from here on is readable normally.
                      </p>
                    </div>
                  </li>
                );
              }
              const p = m.payload;
              const body = p && (p.t === "text" || p.t === "img" || p.t === "file") ? (view.edits.get(m.id) ?? p.body) : undefined;
              const reacts = view.reacts.get(m.id);
              // Any payload kind can be a reply. It used to be text-only, so replying to a photo
              // sent a bubble with no visible connection to the thing it answered.
              const replyRef = p && "ref" in p && p.t !== "react" && p.t !== "edit" && p.t !== "del" ? p.ref : undefined;
              // A sticker sits on the background like iMessage's — a bubble around a transparent
              // drawing reads as a broken image, not as a sticker.
              const bare = !!p && p.t === "stick";
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
                      <span data-actions="" className={`shrink-0 items-center gap-0.5 self-center transition-opacity ${
                        /* Touch has no hover, so these appear when the bubble is TAPPED — not on
                           every bubble at once, which is what "always show them" produced. */
                        compact
                          ? (openActions === m.id ? "flex" : "hidden")
                          : "hidden opacity-0 group-hover:opacity-100 md:flex"}`}>
                        {p.t === "text" && (
                          <button type="button" aria-label="Edit" onClick={() => { setEditing(m); setReplyTo(null); }}
                            className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-3 hover:bg-veil/[0.07] hover:text-ink">Edit</button>
                        )}
                        {/* Two-step: "Unsend" → "Delete?" → gone. See confirmUnsend. */}
                        {confirmUnsend === m.id ? (
                          <>
                            <button type="button" onClick={() => { setConfirmUnsend(0); unsend(m); }}
                              className="rounded px-1.5 py-0.5 text-[11px] font-bold text-yang hover:bg-veil/[0.07]">Delete?</button>
                            <button type="button" aria-label="Keep this message" onClick={() => setConfirmUnsend(0)}
                              className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-3 hover:text-ink">Keep</button>
                          </>
                        ) : (
                          <button type="button" aria-label="Unsend" onClick={() => setConfirmUnsend(m.id)}
                            className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-3 hover:bg-veil/[0.07] hover:text-ink">Unsend</button>
                        )}
                      </span>
                    )}
                    {/* data-ay-skip: everything below this point is decrypted plaintext — see the
                        file header. Marked on the wrapper so no future child can escape it. */}
                    <div data-ay-skip="1"
                      /* On touch, the bubble itself is what reveals its actions. Ignored when the
                         member is selecting text, so tapping to copy does not open a toolbar. */
                      data-bubble=""
                      onClick={compact && m.id > 0 && p ? () => {
                        if ((window.getSelection()?.toString() || "").length) return;
                        setOpenActions((cur) => (cur === m.id ? 0 : m.id));
                        setConfirmUnsend(0);
                      } : undefined}
                      className={`relative ${compact ? "max-w-[82%]" : "max-w-[76%] md:max-w-[65%]"} ${hit ? "rounded-card ring-2 ring-yang" : ""}`}>
                      {/* WhatsApp-style bubble: sent = blue-tinted, received = neutral; the last
                          bubble of a group squares its outer-bottom corner into a tail. */}
                      <div className={`text-[14.5px] leading-relaxed ${
                        bare ? "" : `rounded-card px-3 py-2 ${mine ? "bg-yin/20 text-ink" : "bg-veil/[0.07] text-ink"} ${
                          !groupWithNext ? (mine ? "rounded-ee-[6px]" : "rounded-es-[6px]") : ""}`
                      } ${m.pending ? "opacity-70" : ""} ${m.failed ? "opacity-60 ring-1 ring-yang" : ""}`}>
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
                            <Media att={p.att} url={media[m.id] ?? null} onZoom={(u, mime) => setZoom({ url: u, mime })} />
                            {(p.t === "img" || p.t === "file") && body && <div className="aq-msg mt-1.5"><MessageBody text={body} /></div>}
                          </>
                        ) : p.t === "stick" ? (
                          knownSticker(p.id)
                            ? <img src={stickerUrl(p.id)} alt={stickerLabel(p.id)} className="h-24 w-24 object-contain" />
                            /* A sticker id this build doesn't ship — a newer client, or one we
                               retired. Say what it was rather than showing a broken image. */
                            : <p className="italic text-ink-3">A sticker this version doesn’t have</p>
                        ) : p.t === "call" ? (
                          /* The readable record of a call. `why` is what makes the history honest
                             months later: "missed" and "declined" are different events, and a log
                             that renders both as "Call ended" is quietly wrong about what happened. */
                          <p className="flex items-center gap-1.5 text-[13.5px]">
                            <Ic d={IC.video} size={15} />
                            {(() => {
                              const end = p.sid ? view.callEnd.get(p.sid) : undefined;
                              const why = p.act === "end" ? p.why : end?.why;
                              if (why === "declined") return mine ? "You declined" : "Call declined";
                              if (why === "missed") return mine ? "No answer" : "Missed call";
                              if (why === "failed") return "Call couldn’t connect";
                              if (p.act === "end") return "Call ended";
                              const secs = end ? Math.max(0, end.at - m.at) : 0;
                              const len = secs >= 60
                                ? `${Math.floor(secs / 60)}m ${secs % 60}s`
                                : `${secs}s`;
                              return end
                                ? `${mine ? "Outgoing" : "Incoming"} call · ${len}`
                                : (mine ? "You started a call" : "Called you");
                            })()}
                          </p>
                        ) : (
                          /* `aq-msg` scopes the maths sizing; MessageBody handles code and leaves
                             the LaTeX delimiters for watchMath to typeset. */
                          <div className="aq-msg">{body ? <MessageBody text={body} /> : null}</div>
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
                        <div data-actions="" className={`z-10 items-center gap-0.5 rounded-pill border border-line bg-space-2 px-1.5 py-1 shadow-card ${
                          compact ? (openActions === m.id ? "flex" : "hidden") : "hidden group-hover:flex"} ${
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
        {/* THE REQUEST BAR. A conversation somebody opened with me is answered here, in the place a
            reply would go, because accepting is the same decision as replying — and because a bar
            that sits where the composer is cannot be missed the way a banner at the top can. */}
        {rel.pending ? (
          <div className="flex flex-wrap items-center gap-2 rounded-field border border-line bg-veil/[0.04] px-3 py-2.5">
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-2">
              <span data-ay-skip="1" className="font-semibold text-ink">{peer.name}</span>{" "}
              <span>would like to message you. Accept and this becomes an ordinary conversation; decline and they can’t write again.</span>
            </p>
            <button type="button" onClick={() => void relate("decline")} disabled={acting}
              className="rounded-pill border border-line px-3 py-1.5 text-[12.5px] font-semibold text-ink-2 hover:border-yang hover:text-ink disabled:opacity-50">Decline</button>
            <button type="button" onClick={() => void relate("accept")} disabled={acting}
              className="rounded-pill bg-yang px-4 py-1.5 text-[12.5px] font-bold text-on-accent hover:opacity-90 disabled:opacity-50">Accept</button>
          </div>
        ) : canSend ? (
          /* `key` is what pre-fills the box when an edit starts and restores the draft when it is
             cancelled — the composer owns its text, so remounting is how the parent hands it a
             different starting value without tracking the text itself. */
          <Composer
            key={editing ? `edit-${editing.id}` : `chat-${peer.id}`}
            peerId={peer.id} peerName={peer.name} compact={compact}
            editing={!!editing} replyTo={!!replyTo}
            replyPreview={replyTo ? (view.textOf.get(replyTo.id) || "message") : ""}
            busy={busy} asked={rel.asked} willRequest={rel.will_request} requestLeft={rel.request_left}
            initialText={editing ? (view.edits.get(editing.id) ?? (editing.payload && "body" in editing.payload ? editing.payload.body ?? "" : "")) : (drafts.get(peer.id) ?? "")}
            onSend={(text) => void submit(text)}
            onCancel={() => { setReplyTo(null); setEditing(null); }}
            onPick={(r) => { if (r.kind !== "emoji") void pick(r); }}
            onFile={(f, mime, extra) => void sendFile(f, mime, extra)} />
        ) : (
          /* Four different reasons the composer is closed, each said in its own words — and the one
             the member can undo comes with the button that undoes it. The name is skipped; the
             sentence beside it stays one whole translatable unit. */
          <div className="flex flex-wrap items-center gap-2 px-1 text-[13px] leading-relaxed text-ink-3">
            {rel.blocked ? (
              <>
                <p className="min-w-0 flex-1">
                  <span>You blocked</span>{" "}
                  <span data-ay-skip="1" className="font-semibold text-ink-2">{peer.name}</span>
                  <span>, so neither of you can write here.</span>
                </p>
                <button type="button" onClick={() => void relate("unblock")} disabled={acting}
                  className="rounded-pill border border-line px-3 py-1 text-[12.5px] font-semibold text-ink-2 hover:border-yin-light hover:text-ink disabled:opacity-50">Unblock</button>
              </>
            ) : rel.blocked_by ? (
              <p>
                <span data-ay-skip="1" className="font-semibold text-ink-2">{peer.name}</span>{" "}
                <span>isn’t accepting messages from you. Everything already here stays readable.</span>
              </p>
            ) : rel.asked ? (
              <p>
                <span>Your message request is waiting — you’ve used all three messages. </span>
                <span data-ay-skip="1" className="font-semibold text-ink-2">{peer.name}</span>{" "}
                <span>can accept it whenever they like, and then you can write again.</span>
              </p>
            ) : (
              <p>
                <span data-ay-skip="1" className="font-semibold text-ink-2">{peer.name}</span>{" "}
                <span>hasn’t opened ArtaChat yet, so there is no device key to seal anything to. Once they open it once, you can write.</span>
              </p>
            )}
          </div>
        )}
      </footer>

      {/* The full-screen viewer: wheel/pinch to zoom, drag to pan, double-tap to toggle. Replaces a
          fit-to-screen <img>, which could show you that a plot had axis labels but never let you
          read them. */}
      {zoom && <MediaViewer src={zoom.url} mime={zoom.mime} onClose={() => setZoom(null)} />}

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
  const [filter, setFilter] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [acting, setActing] = useState(0); // peer id whose accept/decline is in flight
  const fatal = store.fatal;
  /**
   * WHICH LIST the sidebar is showing. Four of the five are server-side boxes (inbox, requests,
   * archived, blocked) and the fifth is the member directory.
   *
   * ONE search field drives all of them, and it is also how a new conversation starts: typing a
   * handle that matches nobody in the current list still finds the member, so "message someone" is
   * no longer a separate input with its own button next to a search box that looked identical.
   */
  type Side = ChatBox | "people" | "rooms";
  const [side, setSide] = useState<Side>((sp.get("box") as Side) || "chats");
  // Only the conversation BOXES drive the store's list; "people" and "rooms" are their own sources.
  useEffect(() => { if (side !== "people" && side !== "rooms") setBox(side); }, [side]);
  // The box lives in the shared store (the poller owns it), which the always-mounted dock reads
  // too — so leaving this page on Requests would have left the dock listing requests under its own
  // "Messaging" heading. The page hands the store back the way it found it.
  useEffect(() => () => setBox("chats"), []);
  const [dir, setDir] = useState<ChatDirectory | null>(null);
  /** Rooms — group conversations, and the place a call lives. A room with ONE member is that
   *  member's own space, which is why "your room" is a room and not a separate concept. */
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [roomId, setRoomId] = useState<number>(() => Number(sp.get("room") || 0) || 0);
  const [makingRoom, setMakingRoom] = useState(false);
  // null until the server answers, so the toggle never flickers into the wrong position.
  const [emailOn, setEmailOn] = useState<boolean | null>(null);
  const chats = page?.items ?? null;
  const requests = store.requests;

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

  // The room list, on the same cadence and visibility rule as everything else here.
  useEffect(() => {
    if (!myKey || (side !== "rooms" && !roomId)) return;
    let stop = false;
    const load = () => roomsList().then((r) => { if (!stop) setRooms(r.items); }).catch(() => undefined);
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { stop = true; clearInterval(t); };
  }, [myKey, side, roomId]);

  /** Open (or create) this member's OWN room — somewhere to sit alone and invite people into. */
  async function openMyRoom() {
    if (makingRoom) return;
    setMakingRoom(true);
    try {
      const r = await roomsCreate({ personal: true });
      setRooms((cur) => (cur?.some((x) => x.id === r.room.id) ? cur : [r.room, ...(cur || [])]));
      setPeer(null);
      setRoomId(r.room.id);
      setSp((cur) => { cur.delete("with"); cur.set("room", String(r.room.id)); return cur; }, { replace: true });
    } catch { setNote("Couldn’t open your room."); }
    setMakingRoom(false);
  }

  /** Start a new group. */
  async function newRoom() {
    if (makingRoom) return;
    setMakingRoom(true);
    try {
      const r = await roomsCreate({ title: "" });
      setRooms((cur) => [r.room, ...(cur || [])]);
      setPeer(null);
      setRoomId(r.room.id);
      setSp((cur) => { cur.delete("with"); cur.set("room", String(r.room.id)); return cur; }, { replace: true });
    } catch { setNote("Couldn’t create the room."); }
    setMakingRoom(false);
  }

  function openRoom(id: number) {
    setPeer(null);
    setRoomId(id);
    setSp((cur) => { cur.delete("with"); cur.set("room", String(id)); return cur; }, { replace: true });
  }

  function closeRoom() {
    setRoomId(0);
    setSp((cur) => { cur.delete("room"); return cur; }, { replace: true });
  }

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

  // Takes the handle as an ARGUMENT. It used to read a `to` state, so "Notes to yourself" —
  // which set that state and then called this on a timeout — always ran against the value from
  // before the click and silently did nothing the first time.
  async function openNew(raw: string) {
    const slug = raw.trim().replace(/^@/, "");
    if (!slug) return;
    setNote(null);
    try {
      const k = await chatGetKey(slug);
      setPeer(k.user);
      setFilter("");
      setSp((cur) => { cur.set("with", k.user.slug); return cur; }, { replace: true });
      if (!k.key) setNote(`${k.user.name} hasn’t opened ArtaChat yet, so they can’t receive encrypted messages until they do.`);
    } catch {
      setNote("No member found with that username.");
    }
  }

  /** Accept or decline straight from the list, without opening the thread — which is how requests
   *  are actually triaged, and the reason declining does not require reading anything first. */
  async function answer(c: ChatListItem, action: Extract<ChatRelation, "accept" | "decline">) {
    if (acting) return;
    setActing(c.peer.id);
    try {
      await chatRelation(c.peer.id, action);
      bumpRequests(-1);
      applyRelation(c.peer.id, {}, true); // it leaves the requests list either way
      if (action === "accept") { setSide("chats"); setPeer(c.peer); }
    } catch {
      setNote("Couldn’t save that — try again.");
    }
    setActing(0);
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
        <PageHero eyebrow="Community" title="ArtaChat" lede="Private, end-to-end encrypted conversations between members." />
        <EmptyState title="Sign in to use ArtaChat" body="Your messages are sealed on your own device — sign in and this browser will create its encryption key."
          action={<Button href="/login/">Sign in</Button>} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-12">
      {/* ONE sentence. The old lede was four, and said three times over what this says once — on a
          page whose job is to get you into a conversation, not to teach cryptography. The detail
          still exists, moved to where it answers a question somebody is actually asking (the safety
          code panel, and the note under the list). */}
      {/* ON A PHONE, AN OPEN CONVERSATION TAKES THE SCREEN. Keeping the hero above it pushed the
          composer to 1036px in an 844px viewport — you landed in a chat and had to scroll past the
          page title to reach the box you came to type in. The hero is orientation for the LIST; once
          you are in a conversation it is just something in the way. Desktop keeps it: there is room. */}
      {/* The hero shares the row's measure. At full container width it began 75px to the start of
          the columns beneath it, so the page had two different left edges. */}
      <div className={`mx-auto w-full max-w-[1076px] ${peer ? "hidden md:block" : ""}`}>
        <PageHero eyebrow="Community" title="ArtaChat"
          lede="Private conversations, sealed on your own device — nobody else can read them, not even us." />
      </div>
      {fatal ? (
        <ErrorNote>{fatal}</ErrorNote>
      ) : !identity || !myKey ? (
        <StatusNote>Preparing this device’s encryption key…</StatusNote>
      ) : (
        /* THE ROW owns the height on desktop. Putting it on the thread alone did not work: `flex-1`
           sets `flex-basis: 0%`, which takes precedence over `height` on a flex item — so the cap
           was ignored, and desktop only looked right because `items-stretch` happened to inherit
           the sidebar's height. Sizing the container makes both panes deterministic. */
        /* THE FEED'S GEOMETRY, because ArtaChat is not a special page (operator 2026-08-09). Every
           other surface centres one main column inside `max-w-[1076px]` with a rail beside it; this
           one had a 288px list hard against the start edge and a 768px conversation sprawling to the
           far side — not a different opinion about layout, the site's layout not being applied. Same
           wrapper, same gap, same `max-w-2xl` centre column as pages/Feed.tsx. */
        <div className={`mx-auto flex w-full max-w-[1076px] flex-col justify-center gap-4 md:h-[calc(100dvh-18rem)] md:max-h-[860px] md:min-h-[420px] md:flex-row md:items-stretch lg:gap-7 ${
          /* An open conversation on a phone is full-bleed, so the page’s own py-7 shows up as a
             grey seam above the header and below the composer — 28px of nothing, twice, on the
             screen with the least room. Cancel it for the pane only; the LIST keeps its padding,
             because there it is ordinary page rhythm rather than a gap in a surface. */
          peer ? "max-md:-my-7" : ""}`}>
          {/* THE LIST IS THE RIGHT-HAND RAIL, exactly where the feed keeps its news column (operator
              2026-08-09). `order` rather than moving the markup: the conversation stays FIRST in the
              document, which is what a screen reader and a phone should meet first — on a phone this
              is one pane at a time anyway, and the rail is a rail only from `md` up.
              Hidden on phones while a thread is open (single-pane). */}
          <aside className={`w-full flex-col gap-3 md:order-2 md:flex md:w-[300px] md:shrink-0 md:min-h-0 md:overflow-y-auto lg:w-[330px] ${peer ? "hidden" : "flex"}`} aria-label="Conversations">
            {/* THREE tabs, not two lists and a form. Chats · Requests · People covers everything
                the sidebar is for, and the two rarely-wanted boxes (archived, blocked) hang off the
                end where they don't compete for attention with the inbox. */}
            <div className="flex overflow-hidden rounded-pill border border-line" role="tablist" aria-label="Sidebar">
              {([["chats", "Chats"], ["requests", "Requests"], ["rooms", "Rooms"], ["people", "People"]] as const).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={side === k}
                  onClick={() => setSide(k)}
                  /* FOUR tabs in a 288px column, one of them carrying a count badge. Equal widths
                     (`flex-1`, i.e. basis 0) gave every tab the same 76px and then CLIPPED the one
                     that needed more — first "People" fell off the end, then "Requests" lost its
                     badge inside its own cell. `grow basis-auto` starts each tab at its content
                     width and shares out only the LEFTOVER space, so nothing is ever cut and the
                     row still fills the column. */
                  className={`grow basis-auto px-2 py-1.5 text-[12.5px] font-semibold transition-colors ${
                    side === k ? "bg-veil/[0.10] text-ink" : "text-ink-3 hover:bg-veil/[0.05] hover:text-ink"
                  }`}>
                  {label}
                  {k === "rooms" && rooms && rooms.some((r) => r.unread > 0) && (
                    <span className="ms-1 h-1.5 w-1.5 rounded-full bg-yang align-middle" aria-label="unread" />
                  )}
                  {k === "requests" && requests > 0 && (
                    <span className="ms-1 rounded-pill bg-yang px-1 text-[10.5px] font-bold text-on-accent">{requests}</span>
                  )}
                  {k === "people" && dir && dir.online > 0 && (
                    <span className="ms-1.5 text-[11px] font-bold text-yang">{dir.online}</span>
                  )}
                </button>
              ))}
            </div>
            {/* ONE field. It filters what is on screen, and when nothing matches it offers to open a
                conversation with that handle — so "search" and "start a new chat" stopped being two
                identical-looking inputs stacked on top of each other. */}
            <Input value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder={side === "people" ? "Search members" : "Search or type a @username"}
              aria-label={side === "people" ? "Search members" : "Search conversations, or type a username to start one"}
              onKeyDown={(e) => { if (e.key === "Enter" && filter.trim()) void openNew(filter); }} />
            {currentUser()?.slug ? (
              <button type="button" onClick={() => void openNew(currentUser()!.slug!)}
                className="self-start text-[12px] text-yin-ink hover:underline">Notes to yourself →</button>
            ) : null}
            {note && <p className="text-[13px] text-ink-3">{note}</p>}

            {side === "rooms" ? (
              <>
                {/* YOUR OWN ROOM FIRST. It is the answer to "can I just hang out?" — a space that is
                    already yours, that you can sit in alone with the camera on, and that becomes a
                    group the moment you invite anybody. */}
                <button type="button" onClick={() => void openMyRoom()} disabled={makingRoom}
                  className="flex items-center gap-3 rounded-card border border-line bg-space-2 px-3 py-2.5 text-start shadow-card hover:border-yin-light disabled:opacity-50">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-yang/20 text-[17px]">🌓</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-ink">Your room</span>
                    <span className="block truncate text-[12px] text-ink-3">Sit here alone, or invite people in</span>
                  </span>
                </button>
                <nav className="flex flex-col overflow-hidden rounded-card border border-line bg-space-2 shadow-card" aria-label="Rooms">
                  {rooms === null ? (
                    <p className="px-4 py-6 text-center text-[13px] text-ink-3">Loading…</p>
                  ) : rooms.filter((r) => !r.personal).length === 0 ? (
                    <p className="px-4 py-6 text-center text-[13px] leading-relaxed text-ink-3">
                      No group rooms yet. A room is a conversation with more than two people in it — and a place to call.
                    </p>
                  ) : rooms.filter((r) => !r.personal).map((r) => (
                    <button key={r.id} type="button" onClick={() => openRoom(r.id)} data-ay-skip="1"
                      className={`flex items-center gap-3 border-b border-line px-3 py-2.5 text-start last:border-b-0 hover:bg-veil/[0.05] ${roomId === r.id ? "bg-veil/[0.08]" : ""}`}>
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-veil/[0.10] text-[13px] font-bold text-ink-2">
                        {r.count}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[14px] text-ink ${r.unread ? "font-bold" : "font-semibold"}`}>{r.title}</span>
                        <span className="block truncate text-[12px] text-ink-3">
                          {r.in_call.length ? `${r.in_call.length} in the call now` : r.members.map((m) => m.name).join(", ")}
                        </span>
                      </span>
                      {r.unread > 0 && !r.muted && (
                        <span className="rounded-pill bg-yang px-2 py-0.5 text-[11px] font-bold text-on-accent">{r.unread}</span>
                      )}
                    </button>
                  ))}
                </nav>
                <button type="button" onClick={() => void newRoom()} disabled={makingRoom}
                  className="self-start rounded-pill bg-yang px-4 py-1.5 text-[12.5px] font-bold text-on-accent hover:opacity-90 disabled:opacity-50">
                  {makingRoom ? "Opening…" : "New room"}
                </button>
                <p className="px-1 text-[11.5px] leading-relaxed text-ink-3">
                  Rooms are sealed with one key shared between their members. Up to {rooms?.[0]?.max_members ?? 12} people,
                  and up to {rooms?.[0]?.max_call ?? 5} on a call — calls go directly between everyone, so there is no
                  server to carry more.
                </p>
              </>
            ) : side === "people" ? (
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
                        title={m.has_key ? "Send an encrypted message" : "Hasn’t opened ArtaChat yet"}
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
            <nav className="flex flex-col overflow-hidden rounded-card border border-line bg-space-2 shadow-card"
              aria-label={side === "requests" ? "Message requests" : side === "archived" ? "Archived" : side === "blocked" ? "Blocked" : "Conversations"}>
              {chats === null ? (
                <p className="px-4 py-6 text-center text-[13px] text-ink-3">Loading…</p>
              ) : shown.length === 0 && filter.trim() ? (
                /* A SEARCH miss. Gated on there being a search — without that gate, an empty
                   Requests box with a conversation open fell through to here and told the member
                   their (nonexistent) query matched nothing. */
                <p className="px-4 py-6 text-center text-[13px] text-ink-3">
                  Nothing matches that. Press Enter to start a conversation with that username.
                </p>
              ) : chats.length === 0 ? (
                /* …and each box says what IT is empty of. Suppressed while a brand-new conversation
                   is open, since "no conversations yet" beside one you are looking at is a lie. */
                peer && side === "chats" ? null : (
                  <div className="px-4 py-7 text-center">
                    <p className="text-[13px] leading-relaxed text-ink-3">{
                      side === "requests" ? "No message requests waiting. Anyone you don’t follow reaches you here first, so you decide before they land in your inbox."
                      : side === "archived" ? "Nothing archived. Archiving a conversation tucks it out of the inbox without losing it."
                      : side === "blocked" ? "You haven’t blocked anyone."
                      : "No conversations yet."
                    }</p>
                    {/* An empty inbox should hand you the way out of it, not just describe itself. */}
                    {side === "chats" && (
                      <button type="button" onClick={() => setSide("people")}
                        className="mt-3 rounded-pill bg-yang px-4 py-1.5 text-[12.5px] font-bold text-on-accent transition-opacity hover:opacity-90">
                        Find someone to message
                      </button>
                    )}
                  </div>
                )
              ) : (
                shown.map((c) => (
                  <div key={c.id} className={`flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0 hover:bg-veil/[0.05] ${peer?.id === c.peer.id ? "bg-veil/[0.08]" : ""}`}>
                    <button type="button" onClick={() => openChat(c)} className="flex min-w-0 flex-1 items-center gap-3 text-start">
                      <span className="relative shrink-0">
                        <Avatar src={c.peer.avatar} name={c.peer.name} className="h-10 w-10" />
                        {c.online && <span className="absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full border-2 border-space-2 bg-yang" title="Active now" />}
                      </span>
                      {/* Member name + the decrypted preview — both must stay off the mesh. */}
                      <span data-ay-skip="1" className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={`min-w-0 flex-1 truncate text-[14px] text-ink ${c.unread && !c.muted ? "font-bold" : "font-semibold"}`}>{c.peer.name}</span>
                          {c.last_at > 0 && (
                            <span className={`shrink-0 text-[11px] ${c.unread && !c.muted ? "font-semibold text-yang" : "text-ink-3"}`}>
                              {fmtDay(c.last_at) === "Today" ? fmtTime(c.last_at) : fmtDay(c.last_at)}
                            </span>
                          )}
                        </span>
                        {/* The last message, decrypted on THIS device — the server only ever held the
                            ciphertext it hands every visitor of /data/. */}
                        {/* An unsent draft beats the last message as the useful thing to say about a
                            conversation — it is the reason you are coming back to it. Shown only for
                            chats that are NOT open, since the open one has the text right there. */}
                        <span className={`block truncate text-[12px] ${c.unread && !c.muted ? "text-ink-2" : "text-ink-3"}`} dir="auto">
                          {peer?.id !== c.peer.id && drafts.get(c.peer.id)
                            ? <><span className="font-semibold text-yang">Draft: </span>{drafts.get(c.peer.id)}</>
                            : c.asked ? "Request sent — waiting for them to accept"
                            : previews[c.id] ?? (c.last ? "Encrypted message" : "No messages yet")}
                        </span>
                      </span>
                    </button>
                    {/* Requests are answered from the row: opening a stranger's message before
                        deciding whether to hear from them is exactly the thing requests prevent. */}
                    {side === "requests" ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <button type="button" onClick={() => void answer(c, "decline")} disabled={acting === c.peer.id}
                          className="rounded-pill border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink-3 hover:border-yang hover:text-ink disabled:opacity-50">Decline</button>
                        <button type="button" onClick={() => void answer(c, "accept")} disabled={acting === c.peer.id}
                          className="rounded-pill bg-yang px-3 py-1 text-[11.5px] font-bold text-on-accent hover:opacity-90 disabled:opacity-50">Accept</button>
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1.5 self-center text-ink-3">
                        {c.pinned && <span title="Pinned" aria-label="Pinned"><Ic d={IC.pin} size={13} /></span>}
                        {c.muted && <span title="Muted" aria-label="Muted"><Ic d={IC.mute} size={13} /></span>}
                        {c.unread > 0 && !c.muted && <span className="rounded-pill bg-yang px-2 py-0.5 text-[11px] font-bold text-on-accent">{c.unread}</span>}
                        {c.unread > 0 && c.muted && <span className="h-2 w-2 rounded-full bg-ink-3" aria-label={`${c.unread} unread, muted`} />}
                      </span>
                    )}
                  </div>
                ))
              )}
            </nav>
            )}
            {/* The two boxes almost nobody wants, kept out of the tab strip and reachable in one
                tap. They toggle back to the inbox rather than needing a second control to leave. */}
            {side !== "people" && (
              <div className="flex gap-3 px-1 text-[12px]">
                {([["archived", "Archived"], ["blocked", "Blocked"]] as const).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setSide(side === k ? "chats" : k)}
                    className={side === k ? "font-semibold text-ink" : "text-ink-3 hover:text-ink"}>
                    {side === k ? "← Back to inbox" : label}
                  </button>
                ))}
              </div>
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
                {/* One line. The caveats are true and worth stating, but a six-line paragraph beside
                    a tickbox is read as noise — they live in the fold below instead. */}
                <span>Email me about messages I haven’t read</span>
              </label>
            )}
            {/* Folded away. It is important and it is TRUE, but it is a paragraph about key
                management sitting permanently under a list of friends — read once, then in the way
                forever. A summary line that opens is the same information without the weight. */}
            <details className="text-[12px] leading-relaxed text-ink-3">
              <summary className="cursor-pointer list-none text-yin-ink hover:underline">How this works ↓</summary>
              <p className="mt-1.5">
                <span className="font-semibold text-ink-2">Encryption.</span>{" "}
                <span>Messages are sealed on this device before they leave it, and only the people in the conversation can
                open them — the ArtaQuest database is public, and even with every row of it a message stays shut.</span>
              </p>
              <p className="mt-1.5">
                <span className="font-semibold text-ink-2">Your key.</span>{" "}
                <span>It belongs to this browser. Clear this site’s data or move device and a new one is made, so earlier
                messages stay sealed to the old key — nobody, including us, can bring them back. That is the honest cost
                of nobody holding a spare.</span>
              </p>
              <p className="mt-1.5">
                <span className="font-semibold text-ink-2">Emails.</span>{" "}
                <span>Only about messages still unread a few minutes later, at most one every half hour per conversation,
                and never the message itself — we can’t read it.</span>
              </p>
              <p className="mt-1.5">
                <span className="font-semibold text-ink-2">Requests.</span>{" "}
                <span>Someone you don’t follow reaches your Requests box first, and gets three messages to say who they are.
                Accept and it becomes an ordinary conversation; decline and they can’t write again.</span>
              </p>
            </details>
          </aside>
          {roomId && me ? (
            <RoomThread roomId={roomId} me={me} onLeave={closeRoom}
              renderCall={(room, key, meId, leaveCall) => (room.in_call.includes(meId)
                ? <RoomCall room={room} roomKey={key} me={meId} onLeft={leaveCall} />
                : null)} />
          ) : peer && me ? (
            <DmThread me={me} identity={identity} myKey={myKey} peer={peer}
              onBack={() => { setPeer(null); setSp((cur) => { cur.delete("with"); return cur; }, { replace: true }); }} />
          ) : peer ? (
            <StatusNote className="flex-1">Opening the conversation…</StatusNote>
          ) : (
            <EmptyState className="hidden flex-1 md:flex" title="Pick a conversation"
              body="Choose a conversation from the list, or start one with a member’s @username." />
          )}
        </div>
      )}
    </div>
  );
}
