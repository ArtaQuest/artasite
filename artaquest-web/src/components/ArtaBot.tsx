import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { ArtaBot as Api, ApiError, chatGetKey, chatMembers, type ArtabotMsg, type ChatMember, type ChatUserCard } from "../lib/api";
import { currentUser, isLoggedIn, localePath, renderRich } from "../lib/wp";
import { armAutoAnswer, clearRing, getChatState, markSeen, subscribeChat, watchList } from "../lib/chat-store";
import { useTypewriter } from "../lib/useTypewriter";
import { Avatar, Button, LogoMark, RichText } from "./ui";
import { IncomingCall } from "./chat/CallPanel";

/** The DM thread lives in the Messages chunk (it carries the whole E2EE stack). Lazy, so the dock
 *  costs nothing until a member actually opens a conversation. */
const DmThread = lazy(() => import("../pages/Messages").then((m) => ({ default: m.DmThread })));

/**
 * ArtaBot — the platform AI assistant, available on EVERY page via a floating launcher.
 *
 * A persistent chat: remembered per signed-in member across sessions; logged-out visitors get a
 * transient per-session conversation. FREE + unlimited for everyone — no coins, no token limit (an
 * hourly rate limit is the only guard, server-side). Gold/blue brand only.
 */

// Turn a failed turn into a line a member can act on. The server sends a friendly `message` for the
// expected cases; we surface it. If it went missing (a non-JSON edge, a proxy error), ApiError falls
// back to a raw "path → status" placeholder — never show that; map to plain copy instead.
function friendlyError(e: unknown): string {
  const status = e instanceof ApiError ? e.status : 0;
  const raw = e instanceof Error ? e.message : "";
  const isRawFallback = /→\s*\d+\s*$/.test(raw); // ApiError's "path → status" placeholder, not real copy
  if (raw && !isRawFallback) return raw;          // a real server message — trust it
  if (status === 429) return "ArtaBot is catching its breath — give it a moment and try again.";
  return "ArtaBot hit a snag. Please try again in a moment.";
}

// Image types ArtaBot (Claude) can read — mirror the server's allow-list so the file picker only
// offers compatible files and the error copy is accurate. Screenshots are PNG/JPEG on every platform.
const OK_IMAGE = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const IMG_ACCEPT = OK_IMAGE.join(",");
// We downscale every attachment in the browser before sending (see downscaleToDataUrl), so the SOURCE
// cap is generous — it only guards against decoding an absurd file. A full-screen Retina/4K screenshot
// is a multi-megabyte PNG; we shrink it rather than reject it, since that's exactly the "share a
// screenshot to ask a question" case this chat is for.
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_EDGE = 1600;     // cap the long edge — Anthropic's vision downsizes larger images anyway
const IMG_QUALITY = 0.85;  // JPEG quality after downscale — legible for text screenshots, small on the wire

// Pull the first image out of a clipboard- or drag-and-drop payload — both expose a DataTransfer.
// Prefer `.files` (covers drag-and-drop and most browsers' paste) and fall back to `.items` for the
// paste path in browsers that only surface the image there. Matches on any image/* so pickImage can
// own the exact allow-list + size check (and show its friendly error for an unsupported type).
function imageFileFromTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  const file = Array.from(dt.files).find((f) => f.type.startsWith("image/"));
  if (file) return file;
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

// Shrink a screenshot in the browser before it's sent: bound the long edge to MAX_EDGE and re-encode as
// JPEG, so a multi-megapixel screen grab becomes a small, legible image. This is what makes pasting a
// full-screen Retina/4K screenshot "just work" instead of tripping a size cap or bloating the request
// (the server still re-checks the decoded bytes). Transparent areas — e.g. a macOS window grab with
// rounded corners — are flattened onto white rather than black. Mirrors the identity flow's fileToImage
// (src/lib/verify.ts); kept local so this always-loaded component stays self-contained.
function downscaleToDataUrl(file: File, maxEdge: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : "";
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const ow = img.naturalWidth || img.width;
        const oh = img.naturalHeight || img.height;
        if (!ow || !oh) { reject(new Error("empty image")); return; }
        const scale = Math.min(1, maxEdge / Math.max(ow, oh));
        const w = Math.round(ow * scale), h = Math.round(oh * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("no canvas")); return; }
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

// ── Typewriter reveal ──────────────────────────────────────────────────────────
// A fresh reply types itself out word by word (shared useTypewriter — same cadence as the contribution
// thread, #76). While typing, the partial Markdown renders inside RichText WITHOUT srcLang — that sets
// data-ay-skip, so the i18n mesh never sees (or worse, caches translations of) half-sentences; when the
// reveal completes, the parent swaps in the normal translated RichText. A click/tap skips to the end.
function TypeOut({ body, onTick, onDone, streaming }: { body: string; onTick: () => void; onDone: () => void; streaming?: boolean }) {
  const { text, finish } = useTypewriter(body, onTick, onDone, streaming);
  return (
    <div onClick={streaming ? undefined : finish} className="cursor-text">
      <RichText html={renderRich(text)} />
      {/* A caret only while words are still arriving — "skip" is meaningless when there is no ending yet. */}
      {streaming ? <span className="aq-caret" aria-hidden="true" /> : null}
    </div>
  );
}

// ── The thinking meter ─────────────────────────────────────────────────────────
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT. Claude Code streams `thinking_delta` events whose
// `thinking` field is an EMPTY STRING: the assembled block carries 0 characters of reasoning beside a
// ~1KB signature. The reasoning is signed and withheld, and no flag exposes it. So this shows the two
// things we genuinely have — Claude's own estimated reasoning-token count and elapsed time — and
// nothing else. Do NOT "enrich" it with invented reasoning: a plausible chain of thought the member
// cannot check is worse than an honest meter.
// data-ay-skip keeps the live numbers out of the i18n mesh (they'd be collected as translations).
function Thinking({ tokens, since }: { tokens: number; since: number }) {
  // The elapsed count is STATE advanced by the interval, not Date.now() read during render: a clock
  // read while rendering is impure (it changes on any incidental re-render), which the lint rule
  // rightly refuses. `since` is the fixed baseline the parent captured when the turn started.
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const tick = () => setSecs(Math.max(0, Math.round((Date.now() - since) / 1000)));
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [since]);
  return (
    <div data-ay-skip="1" className="flex items-center gap-2 text-sm opacity-70">
      <span className="aq-think-dots" aria-hidden="true"><i /><i /><i /></span>
      <span>Thinking{tokens > 0 ? ` · ~${tokens.toLocaleString()} tokens` : ""}{secs >= 2 ? ` · ${secs}s` : ""}</span>
    </div>
  );
}

/**
 * ArtaBot's conversation body — now one thread inside the unified chat dock, alongside DMs.
 *
 * Exported so the dock can mount it as a peer of DmThread. It owns everything about the AI
 * conversation and nothing about the shell. NOTE: the document-level paste listener below is
 * deliberately mounted with THIS component, not with the dock — that is what stops a screenshot
 * pasted into an end-to-end-encrypted DM from being captured and sent to Claude. Keep it here, and
 * keep this component unmounted whenever a DM thread is the visible one.
 */
export function BotChat() {
  const [msgs, setMsgs] = useState<ArtabotMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [image, setImage] = useState<string | null>(null); // attached screenshot (data URL), sent with the next turn
  const [preparing, setPreparing] = useState(false); // downscaling an attachment in the browser
  const [dragOver, setDragOver] = useState(false); // an image is being dragged over the chat
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [animId, setAnimId] = useState<number | null>(null); // the one reply currently typing itself out
  // The turn being written RIGHT NOW, streamed from the relay. Null when nothing is in flight.
  const [live, setLive] = useState<{ text: string; think: number; phase: string; since: number } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickSeq = useRef(0); // bumps per attachment so a slow downscale can't overwrite a newer pick

  useEffect(() => {
    // Everyone — including logged-out visitors — gets a conversation, free and unlimited.
    Api.history()
      .then((h) => { setMsgs(h.items); })
      .catch(() => { /* empty start */ })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  // Follow the typewriter: each revealed word nudges the list to the bottom — but only while the
  // member is already there, so scrolling up to re-read an earlier message is never fought.
  const listRef = useRef<HTMLDivElement>(null);
  const followTyping = () => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  };

  /** Follow the in-flight answer. One long-poll at a time: the server holds each request open (~20s)
   *  and answers the moment there is a new slice, so this is ~1 request/s while an answer is being
   *  written and ZERO when the chat is idle — the reason this is a long-poll and not a 300ms timer.
   *  Returns a `finished` promise plus a `stop` for unmount/error, so no loop outlives its turn. */
  function followLive() {
    let stopped = false;
    let seen = 0;
    let resolveDone: () => void = () => {};
    const finished = new Promise<void>((res) => { resolveDone = res; });
    (async () => {
      // A generous ceiling, not a latency budget: an xhigh turn legitimately runs for minutes. It
      // exists only so a lost answer can never leave the reader polling forever.
      const giveUpAt = Date.now() + 20 * 60 * 1000;
      while (!stopped && Date.now() < giveUpAt) {
        try {
          const s = await Api.live(seen);
          if (stopped) break;
          if (s.seq > seen) {
            seen = s.seq;
            // `text` is the whole answer so far — adopt it, never append, so a repeated or dropped
            // response cannot duplicate or lose what the member is reading.
            setLive((p) => ({ text: s.text, think: s.think, phase: s.phase || "thinking", since: p?.since ?? Date.now() }));
          }
          if (s.done) break;
        } catch {
          if (stopped) break;
          // A dropped poll (sleep, tab throttle, flaky mobile) is not fatal — pause briefly and
          // resume from the same seq. The transcript is still the source of truth either way.
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      resolveDone();
    })();
    return { finished, stop() { stopped = true; resolveDone(); } };
  }

  async function send() {
    const text = draft.trim();
    if ((!text && !image) || busy || preparing) return; // wait for an attachment still downscaling
    const img = image;
    setDraft(""); setImage(null); setErr("");
    setMsgs((m) => [...m, { id: -Date.now(), role: "user", body: text, at: Date.now() / 1000, image: img ?? undefined }]);
    setBusy(true);
    setLive({ text: "", think: 0, phase: "thinking", since: Date.now() });
    // The live reader starts BEFORE the answer is asked for. The buffer is keyed on the session, so
    // there is nothing to wait for — and starting here means the thinking meter is already ticking
    // while the request is still in flight.
    const stream = followLive();
    try {
      const r = await Api.ask(text, img ?? undefined);
      if ("reply" in r && r.reply) {
        // Synchronous answer (the relay finished inside the request). Nothing to stream.
        stream.stop();
        setLive(null);
        setMsgs((m) => [...m, r.reply as ArtabotMsg]);
        if (r.reply.body) setAnimId(r.reply.id); // type the fresh reply out (history never animates)
        return;
      }
      // Streamed turn: `ask` returned as soon as the job was queued and the answer is arriving on the
      // live channel. Wait for it to land, then adopt the authoritative transcript row.
      // THIS is the branch that used to crash: the old code read `r.reply.body` unconditionally, and a
      // pending response has no `reply` at all, so every turn slower than 50s took the chat down.
      await stream.finished;
      const h = await Api.history().catch(() => null);
      if (h) setMsgs(h.items);
      setLive(null);
    } catch (e) {
      stream.stop();
      setLive(null);
      setErr(friendlyError(e));
    } finally { setBusy(false); }
  }

  // Attach a screenshot to the next turn: validate it, downscale it in the browser (so even a big
  // full-screen grab goes through), and keep the small JPEG data URL the API sends inline to ArtaBot.
  // It's shown to Claude for that one turn and never stored, so private screenshots stay out of the
  // public database. Async because the downscale decodes the image; a per-pick token means a slow
  // decode can't overwrite a newer attachment, and it never rejects (errors surface as a friendly note).
  async function pickImage(file: File | null) {
    if (!file) return;
    if (!OK_IMAGE.includes(file.type)) { setErr("Please choose a PNG, JPEG, WebP or GIF image"); return; }
    if (file.size > MAX_SOURCE_BYTES) { setErr("That image is too large — 25 MB max"); return; }
    const seq = ++pickSeq.current;
    setErr(""); setPreparing(true);
    try {
      const dataUrl = await downscaleToDataUrl(file, MAX_EDGE, IMG_QUALITY);
      if (pickSeq.current === seq) setImage(dataUrl);
    } catch {
      if (pickSeq.current === seq) setErr("Couldn't read that image");
    } finally {
      if (pickSeq.current === seq) setPreparing(false);
    }
  }

  // Capture a pasted screenshot (Cmd/Ctrl+V) anywhere in the open chat — not only when the text box is
  // already focused. Right after the launcher is tapped focus is still on that button, so a textarea-only
  // paste handler silently drops the image and paste seems to "do nothing". A document-level listener
  // (live only while the chat is mounted, and acting solely on image clipboard data so plain-text paste is
  // untouched) mirrors the contribution form so paste Just Works. Drag-and-drop + the file picker unchanged.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Someone nearer the paste already claimed it — in practice the DM composer, whose own
      // handler calls preventDefault (pages/Messages.tsx onPaste). Without this check a screenshot
      // pasted into an END-TO-END-ENCRYPTED conversation would ALSO be captured here and sent to
      // Claude: this listener is on `document`, so it sees every paste on the page, and the two
      // surfaces can now be open at once (dock on ArtaBot, /messages behind it).
      if (e.defaultPrevented) return;
      const file = imageFileFromTransfer(e.clipboardData);
      if (file) { e.preventDefault(); pickImage(file); }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
     
  }, []);

  // Drag-and-drop a screenshot anywhere onto the chat. Fall back to the first dropped file so a
  // non-image drop still gets pickImage's friendly "choose a PNG/JPEG…" message instead of nothing.
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = imageFileFromTransfer(e.dataTransfer) ?? e.dataTransfer.files[0] ?? null;
    if (file) pickImage(file);
  }

  // Only light up the drop zone for an actual file drag (ignore selected-text / link drags).
  const dragHasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  async function clear() {
    if (!confirm("Forget this conversation? ArtaBot won't remember it.")) return;
    await Api.clear().catch(() => {});
    setMsgs([]);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => { if (dragHasFiles(e)) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
      onDrop={onDrop}>
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 m-2 grid place-items-center rounded-2xl border-2 border-dashed border-yin-light bg-space-1/85 backdrop-blur-sm">
          <span className="flex items-center gap-2 text-[14px] font-semibold text-yin-light">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" />
            </svg>
            Drop image to attach
          </span>
        </div>
      )}
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {loaded && msgs.length === 0 && (
          <div className="rounded-card border border-line bg-space-2 p-4 text-[14px] leading-relaxed text-ink-2">
            <p className="font-semibold text-ink">Hi, I'm ArtaBot 👋</p>
            <p className="mt-1">Ask me anything about ArtaQuest — courses, points, coins, or how the question-first model works. Spot a bug or have an idea? Just tell me and I'll file it for you — you can attach, paste or drop in a screenshot too.</p>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start gap-2"}>
            {m.role === "assistant" && <LogoMark className="mt-0.5 h-6 w-6 shrink-0" />}
            <div className={`max-w-[80%] rounded-card px-3.5 py-2.5 text-[14px] leading-relaxed ${
              m.role === "user" ? "whitespace-pre-wrap bg-yin/15 text-ink" : "border border-line bg-space-2 text-ink-2"}`}>
              {m.image && <img src={m.image} alt="Shared screenshot" className={`max-h-52 max-w-full rounded-lg border border-line object-contain ${m.body ? "mb-2" : ""}`} />}
              {/* ArtaBot replies in Markdown (bold, lists, fenced code, headings…) — render it the same way
                  discussion comments are (renderRich → RichText), so it no longer shows as raw characters.
                  srcLang="en" keeps the reply translatable by the i18n mesh for non-English readers (the bare
                  text node was already translated; data-ay-skip would have silently dropped that). The
                  member's own messages stay verbatim plain text (whitespace-pre-wrap above). */}
              {m.body && (m.role === "assistant"
                ? (m.id === animId
                    ? <TypeOut body={m.body} onTick={followTyping} onDone={() => setAnimId(null)} />
                    : <RichText html={renderRich(m.body)} srcLang="en" />)
                : m.body)}
              {m.ticket && m.id !== animId && (
                <a href={`/issues/?ticket=${m.ticket.id}`}
                  className="mt-2 inline-flex items-center gap-1 rounded-pill border border-yang/30 bg-yang/10 px-2.5 py-1 text-[12px] font-semibold text-yang transition-colors hover:bg-yang/20">
                  View contribution #{m.ticket.id} →
                </a>
              )}
            </div>
          </div>
        ))}
        {/* THE LIVE TURN. While an answer is being written it renders here as its own bubble, growing
            word by word, and is replaced by the real transcript row the moment the turn completes.
            data-ay-skip keeps half-written sentences out of the i18n mesh — the finished reply,
            rendered above with srcLang="en", translates as usual. */}
        {live && (
          <div className="flex justify-start gap-2">
            <LogoMark className="mt-0.5 h-6 w-6 shrink-0" />
            <div data-ay-skip="1" className="max-w-[80%] rounded-card border border-line bg-space-2 px-3.5 py-2.5 text-[14px] leading-relaxed text-ink-2">
              {live.text
                ? <TypeOut body={live.text} onTick={followTyping} onDone={() => {}} streaming />
                : <Thinking tokens={live.think} since={live.since} />}
            </div>
          </div>
        )}
        {/* Only when there is no live channel to show — otherwise the stream IS the progress. */}
        {busy && !live && <div className="flex items-center gap-2 text-[13px] text-ink-3"><LogoMark className="h-6 w-6 animate-pulse" />ArtaBot is thinking…</div>}
        {err && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-card border border-yin/40 bg-yin/10 px-3 py-2 text-[13px] text-yin-light">
            <span>{err}</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-line p-3">
        {msgs.length > 0 && (
          <div className="mb-2 flex justify-end text-[11px] text-ink-2">
            <button onClick={clear} className="hover:text-yin-light">Clear</button>
          </div>
        )}
        {image ? (
          <div className="relative mb-2 w-fit">
            <img src={image} alt="Attached screenshot" className="max-h-24 rounded-lg border border-line object-contain" />
            <button type="button" onClick={() => setImage(null)} aria-label="Remove screenshot"
              className="absolute -end-2 -top-2 grid h-5 w-5 place-items-center rounded-full border border-line bg-space-1 text-[13px] leading-none text-ink-2 transition-colors hover:text-ink">×</button>
          </div>
        ) : preparing ? (
          <div className="mb-2 flex w-fit items-center gap-2 rounded-lg border border-line bg-space-2 px-3 py-2 text-[12px] text-ink-3">
            <LogoMark className="h-4 w-4 animate-pulse" /> Preparing screenshot…
          </div>
        ) : null}
        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex items-end gap-2">
          <input ref={fileRef} type="file" accept={IMG_ACCEPT} className="hidden"
            onChange={(e) => { pickImage(e.target.files?.[0] ?? null); e.target.value = ""; }} />
          <button type="button" onClick={() => fileRef.current?.click()} aria-label="Attach a screenshot"
            className="grid h-[44px] w-11 shrink-0 place-items-center rounded-card border border-line bg-space-2 text-ink-3 transition-colors hover:border-yin-light hover:text-ink">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" />
            </svg>
          </button>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={1}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask ArtaBot…"
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-card border border-line bg-space-2 px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-yin-light" />
          <Button type="submit" disabled={(!draft.trim() && !image) || busy || preparing} size="md" className="shrink-0 disabled:opacity-40">Send</Button>
        </form>
      </div>
    </div>
  );
}

// ── The dock: one messaging surface for ArtaBot and every DM ─────────────────

/** Subscribe to the shared chat session. One store for the dock and the /messages page, so both
 *  mounted still means one identity, one poller, one preview cache. */
function useChat(showingList: boolean) {
  const [, bump] = useState(0);
  useEffect(() => subscribeChat(() => bump((n) => n + 1)), []);
  // Only a surface actually RENDERING the list may poll it — reading the list marks the member
  // "in a chat" server-side, which suppresses their own bell and away-email (see chat-store).
  useEffect(() => (showingList ? watchList() : undefined), [showingList]);
  return getChatState();
}

type View = { k: "list" } | { k: "bot" } | { k: "dm"; peer: ChatUserCard };

/** One shared empty array, so "no conversations yet" is a STABLE reference. A fresh `[]` per render
 *  would invalidate every useMemo below on every render — the exact opposite of memoising. */
const NO_CHATS: NonNullable<ReturnType<typeof getChatState>["page"]>["items"] = [];

const Ico = ({ d, size = 17, className }: { d: React.ReactNode; size?: number; className?: string }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden
    className={className ? `transition-transform duration-200 ${className}` : undefined}>{d}</svg>
);
const BACK = <path d="M15 5l-7 7 7 7" />;
const SEARCH = <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>;
/* The drawer bar's two affordances: compose (jump to the full Messages page) and the chevron that
   rolls the drawer up and down — pointing UP when collapsed (rotate-180), DOWN when open. */
const COMPOSE = <><path d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17v3z" /><path d="M13.5 6.5l4 4" /></>;
const CHEVRON = <path d="M6 9.5l6 6 6-6" />;

function relTime(ts: number): string {
  if (!ts) return "";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 604800) return `${Math.floor(d / 86400)}d`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function DockBody({ view, setView }: {
  view: View; setView: (v: View) => void;
}) {
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<ChatMember[] | null>(null);
  const [note, setNote] = useState("");
  const chat = useChat(view.k === "list");
  const chats = chat.page?.items ?? NO_CHATS;
  // The caller's own uid comes free with the list. Reading it from a throwaway chatMessages() call
  // (as the full page used to) would ALSO advance the read watermark — merely selecting a
  // conversation marked its newest messages read before a word of them was on screen.
  const me = chat.page?.me ?? 0;

  // Searching the directory only when there is something to search for — the list itself is
  // filtered locally, so a short query never costs a request.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setPeople(null); return; }
    let stop = false;
    const t = setTimeout(() => {
      chatMembers({ q: term }).then((d) => { if (!stop) setPeople(d.items); }).catch(() => undefined);
    }, 250);
    return () => { stop = true; clearTimeout(t); };
  }, [q]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return chats;
    return chats.filter((c) => c.peer.name.toLowerCase().includes(term) || c.peer.slug.toLowerCase().includes(term));
  }, [chats, q]);

  // Members matching the search who aren't already in the list above, so one search shows both
  // "your conversations" and "everyone else" without ever repeating a row.
  const newPeople = useMemo(() => {
    if (!people) return [];
    const known = new Set(chats.map((c) => c.peer.id));
    return people.filter((m) => !known.has(m.id));
  }, [people, chats]);

  async function openBySlug(slug: string) {
    setNote("");
    try {
      const k = await chatGetKey(slug);
      setView({ k: "dm", peer: k.user });
      if (!k.key) setNote(`${k.user.name} hasn’t opened Messages yet, so they can’t receive one until they do.`);
    } catch { setNote("Couldn’t open that conversation."); }
  }

  // The header used to live here. It is now the drawer's PINNED BAR, hoisted into <ArtaBot> so it
  // stays on screen while the body is collapsed (LinkedIn's messaging drawer — operator, 2026-07-30).
  return (
    <>
      {/* Kept mounted (hidden) while the list is showing, so stepping back does not destroy a
          half-typed question or an attached screenshot. Unmounted for a DM, which is what keeps
          ArtaBot's document-level paste listener away from an encrypted conversation. */}
      {view.k !== "dm" && (
        <div className={view.k === "bot" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <BotChat />
        </div>
      )}

      {view.k === "dm" && (
        <Suspense fallback={<p className="p-6 text-center text-[13px] text-ink-3">Opening…</p>}>
          {me ? (
            <DmThread compact me={me} identity={chat.identity!} myKey={chat.myKey!} peer={view.peer}
              onBack={() => setView({ k: "list" })} />
          ) : (
            <p className="p-6 text-center text-[13px] text-ink-3">Preparing this device’s key…</p>
          )}
        </Suspense>
      )}

      {view.k === "list" && (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <span className="text-ink-3" aria-hidden><Ico d={SEARCH} size={15} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages or members"
              aria-label="Search messages or members"
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-3" />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* ArtaBot is pinned first: it is the one conversation every member always has. */}
            <button type="button" onClick={() => setView({ k: "bot" })}
              className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-start transition-colors hover:bg-veil/[0.05]">
              <LogoMark className="h-10 w-10 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-ink">ArtaBot</span>
                <span className="block truncate text-[12px] text-ink-3">Ask anything — free, always</span>
              </span>
            </button>

            {/* Waiting message requests. One line, not a tab: the dock is 400px of a page somebody
                is doing something else on, so it points at the full inbox rather than growing a
                second list nobody asked to see. */}
            {chat.requests > 0 && (
              <a href={localePath("/messages/?box=requests")}
                className="flex w-full items-center gap-3 border-b border-line bg-yang/[0.06] px-3 py-2.5 text-start transition-colors hover:bg-yang/[0.10]">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-yang text-[14px] font-bold text-on-accent">{chat.requests}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-ink">
                    {chat.requests === 1 ? "1 message request" : `${chat.requests} message requests`}
                  </span>
                  <span className="block truncate text-[12px] text-ink-3">From members you don’t follow — accept or decline</span>
                </span>
              </a>
            )}

            {chat.fatal ? (
              <p className="px-4 py-6 text-center text-[13px] text-ink-3">{chat.fatal}</p>
            ) : chat.listError ? (
              <p className="px-4 py-6 text-center text-[13px] text-ink-3">Couldn’t load your conversations — check your connection.</p>
            ) : !chat.ready ? (
              <p className="px-4 py-6 text-center text-[13px] text-ink-3">Preparing this device’s key…</p>
            ) : shown.length === 0 && newPeople.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-ink-3">
                {q.trim() ? "Nobody matches that search." : "No conversations yet — search for a member above."}
              </p>
            ) : null}

            {shown.map((c) => (
              <button key={c.id} type="button" data-ay-skip="1"
                onClick={() => { markSeen(c.id); setView({ k: "dm", peer: c.peer }); }}
                title={c.unread > 0 ? "Unread messages" : "Open conversation"}
                className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-start transition-colors hover:bg-veil/[0.05]">
                <span className="relative shrink-0">
                  <Avatar src={c.peer.avatar} name={c.peer.name} className="h-10 w-10" />
                  {c.online && <span aria-hidden className="absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full border-2 border-space-2 bg-yang" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`min-w-0 flex-1 truncate text-[14px] text-ink ${c.unread ? "font-bold" : "font-semibold"}`}>{c.peer.name}</span>
                    <span className={`shrink-0 text-[11px] ${c.unread ? "font-semibold text-yang-ink" : "text-ink-3"}`}>{relTime(c.last_at)}</span>
                  </span>
                  <span className={`block truncate text-[12px] ${c.unread ? "text-ink-2" : "text-ink-3"}`} dir="auto">
                    {chat.previews[c.id] ?? (c.last ? "Encrypted message" : "No messages yet")}
                  </span>
                </span>
                {c.unread > 0 && <span className="shrink-0 rounded-pill bg-yang px-2 py-0.5 text-[11px] font-bold text-on-accent">{c.unread}</span>}
              </button>
            ))}

            {newPeople.length > 0 && (
              <>
                <p className="px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-ink-3">Members</p>
                {newPeople.map((m) => (
                  <button key={m.id} type="button" data-ay-skip="1" onClick={() => void openBySlug(m.slug)}
                    title={m.has_key ? "Send an encrypted message" : "Hasn’t opened Messages yet"}
                    className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-start transition-colors hover:bg-veil/[0.05]">
                    <span className="relative shrink-0">
                      <Avatar src={m.avatar} name={m.name} country={m.country} className="h-10 w-10" />
                      {m.online && <span aria-hidden className="absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full border-2 border-space-2 bg-yang" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold text-ink">{m.name}</span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {m.online ? "Active now" : m.has_key ? `@${m.slug}` : "Not set up for messages yet"}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}
            {note && <p className="px-3 py-2 text-[12px] text-ink-3" data-ay-skip="1">{note}</p>}
          </div>
        </>
      )}
    </>
  );
}

export function ArtaBot() {
  const [open, setOpen] = useState(false);
  // Which conversation the dock is showing. Lifted here so the phone tab bar's ArtaBot button can
  // open ArtaBot directly (ticket #156) rather than dropping the member on the list.
  const [dockView, setDockView] = useState<View>({ k: "list" });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Unread badge on the launcher. Subscribing at badge level costs one cheap count a minute and
  // never touches presence, so it cannot suppress the member's own notifications.
  const [, bumpBadge] = useState(0);
  useEffect(() => subscribeChat(() => bumpBadge((n) => n + 1)), []);
  const badge = getChatState();
  const unread = badge.unread;
  // The same poll carries an inbound call, so the ring reaches the member on any page — the dock is
  // the only chat surface that is always mounted, which makes it the right place for it.
  const ring = badge.ring;

  // Escape closes the dock and returns focus to the launcher — neither existed before.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape is a stack, not a global close. Inside the panel it first cancels a reply, closes
      // the lightbox, or dismisses the search — each of those consumers calls preventDefault. Only
      // an UNCLAIMED Escape closes the dock, so the gesture never destroys a half-typed message.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Signed-in phones reach ArtaBot from the bottom tab bar's raised centre button instead of the
  // floating launcher (ticket #156 — members wanted the A button in the bar's centre slot, and the
  // launcher used to sit ON the bar's right end, covering the Profile tab). The tab fires this
  // event to toggle the chat; the launcher below hides itself there (`max-md:hidden`). Login state
  // is server-injected (window.AQ_USER), static for the page's life — safe to read once.
  const inTabBar = isLoggedIn();
  useEffect(() => {
    const toggle = (e: Event) => {
      // The centre button carries ArtaBot's own mark, so it opens ArtaBot rather than the
      // conversation list. A CustomEvent may name a different view; a bare Event keeps the
      // original toggle contract AppShell already relies on.
      const want = (e as CustomEvent<{ tab?: "bot" | "list" }>).detail?.tab ?? "bot";
      setOpen((o) => {
        if (!o) setDockView({ k: want === "list" ? "list" : "bot" });
        return !o;
      });
    };
    window.addEventListener("aq:artabot", toggle);
    return () => window.removeEventListener("aq:artabot", toggle);
  }, []);

  // On a phone the soft keyboard shrinks the viewport, which floats this position:fixed launcher up
  // off the bottom edge and onto page content — ticket #5 caught it covering the "How it works" text
  // on the contributions page. So while a page field is focused (keyboard up), keep the launcher
  // hidden; it fades back the moment the keyboard is dismissed. Gated to coarse-pointer (touch)
  // devices so a desktop user clicking into an input never loses the launcher, and we ignore focus
  // INSIDE ArtaBot's own panel so typing a chat message can't hide its close button.
  const [fieldFocused, setFieldFocused] = useState(false);
  // …but focus alone is NOT the truth on Android: dismissing the keyboard with the system Back
  // button keeps the field FOCUSED — focusout never fires, fieldFocused sticks true, and the
  // launcher stays hidden for the rest of the visit. /offline/'s course search box made that the
  // page where "ArtaBot widget is missing" (ticket #12, round 2 — the select/checkbox fix wasn't
  // enough). The visual viewport reports the keyboard directly, either way it's dismissed: hide
  // only while the viewport is genuinely shrunk. Scale-corrected so pinch-zoom (which also shrinks
  // vv.height) never reads as a keyboard; the threshold clears a collapsing URL bar (~56px) but
  // catches the smallest soft keyboard (~200px+).
  const [kbShrunk, setKbShrunk] = useState(false);
  const vvSupported = typeof window !== "undefined" && !!window.visualViewport;
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => setKbShrunk(window.innerHeight - vv.height * vv.scale > 140);
    sync();
    vv.addEventListener("resize", sync);
    return () => vv.removeEventListener("resize", sync);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    // Only a field that raises the SOFT KEYBOARD should hide the launcher — that keyboard is what
    // shrinks the viewport and floats this fixed launcher onto content (ticket #5). A <select>,
    // checkbox/radio or button opens a native picker or nothing and never shrinks the viewport, so
    // hiding for those just makes ArtaBot vanish on form-heavy pages — e.g. /offline/'s language
    // selects + course checkboxes left the launcher hidden the whole visit (ticket #12, "ArtaBot
    // widget is missing"). So match text-entry inputs, <textarea> and contenteditable only.
    const KEYBOARD_INPUT = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
    const isField = (el: EventTarget | null): boolean => {
      const n = el as HTMLElement | null;
      if (!n || typeof n.closest !== "function") return false;
      if (n.closest(".aq-bot-panel")) return false; // typing inside ArtaBot must not hide its own chrome
      if (n.isContentEditable || n.tagName === "TEXTAREA") return true;
      if (n.tagName === "INPUT") return KEYBOARD_INPUT.has(((n as HTMLInputElement).type || "text").toLowerCase());
      return false; // <select>, checkbox, button, etc. raise no keyboard → never hide the launcher
    };
    const onIn = (e: FocusEvent) => { if (isField(e.target)) setFieldFocused(true); };
    // relatedTarget is the element gaining focus — staying within fields (e.g. Title → Details)
    // keeps the launcher hidden without a flicker between the two.
    const onOut = (e: FocusEvent) => { if (!isField(e.relatedTarget)) setFieldFocused(false); };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => { document.removeEventListener("focusin", onIn); document.removeEventListener("focusout", onOut); };
  }, []);

  // PHONE ONLY: hide the launcher once the reader scrolls into a page's content, restoring it only
  // near the top. On a narrow viewport this fixed launcher floats over the content column — on the
  // discussion boards the right-aligned vote pills scroll straight through the corner it occupies,
  // so the glassy circle sits on a reply's vote pill (two overlapping pill shapes) and swallows the
  // taps meant for its downvote arrow. That was ticket #32, first fixed by hiding the launcher only
  // WHILE scrolling down and bringing it back on any scroll up ("nudge up = back"). But a reader
  // nudges up to bring a reply into comfortable view BEFORE voting — which popped the launcher right
  // back over that reply's vote pill and ate the downvote tap again (ticket #56). So once a real
  // scroll takes the reader past the top, the launcher STAYS hidden until they come back near the
  // top — clear of the vote pills for the whole read-and-vote pass. Desktop never overlaps the
  // centred content column, so it is untouched; the 8px hysteresis ignores rubber-banding jitter.
  //
  // …but only a scroll the USER performs may hide it. The browser also moves scrollY by itself —
  // scroll restoration on reload/back, and scroll ANCHORING while the i18n mesh streams Farsi/
  // Arabic/… swaps into the page (every batch reflows; text above the viewport grows, the browser
  // bumps scrollY down to hold the reading position). Those jumps fire the same scroll events, so
  // on translated locales the launcher silently vanished on a page the member never scrolled —
  // "ArtaBot widget hidden on FA" (ticket #49); English never translates, so only non-source
  // locales bled. The English page's only programmatic move is the route-change reset to the top,
  // which lands ≤120 and must keep RESTORING the launcher. So: a scroll within 400ms of real input
  // (touch / wheel — what coarse-pointer scrolling produces) decides by position; an input-less
  // scroll may only ever RESTORE the launcher, never hide it.
  const [scrolledAway, setScrolledAway] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    let last = window.scrollY, raf = 0, input = 0;
    const onInput = () => { input = Date.now(); };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY;
        if (Math.abs(y - last) > 8) {
          // User scroll: hidden the moment we're past the top zone, and it STAYS hidden on the way
          // back up too — only a return near the top restores it (see comment: a nudge up to read a
          // reply must not pop the launcher back over that reply's vote pill — ticket #56).
          if (Date.now() - input < 400) setScrolledAway(y > 120);
          else if (y <= 120) setScrolledAway(false); // programmatic return to top (route change) still restores it
          last = y;
        }
      });
    };
    window.addEventListener("touchstart", onInput, { passive: true });
    window.addEventListener("touchmove", onInput, { passive: true });
    window.addEventListener("wheel", onInput, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onInput);
      window.removeEventListener("touchmove", onInput);
      window.removeEventListener("wheel", onInput);
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Never hide while ArtaBot's panel is open — its close button + chat input must stay reachable.
  // The keyboard hide needs BOTH signals where the browser can give them: a keyboard-raising field
  // is focused AND the viewport is actually shrunk (so a stuck focus can never strand the launcher
  // hidden, and a shrink with no field focused — split-screen, foldables — never hides it either).
  // Browsers without visualViewport fall back to focus alone, the pre-existing behaviour.
  const hideDock = !open && ((fieldFocused && (vvSupported ? kbShrunk : true)) || scrolledAway);

  const inThread = dockView.k !== "list";
  const title = dockView.k === "bot" ? "ArtaBot" : dockView.k === "dm" ? dockView.peer.name : "Messaging";
  const toggle = () => setOpen((o) => !o);
  const me = currentUser();

  /* A DRAWER, not a popup (operator, 2026-07-30: "like LinkedIn, opens up and down like a drawer
     that says messaging"). The bar is ALWAYS on screen, welded to the bottom edge; only the body
     slides. That is the whole point of the pattern — the collapsed state still says "Messaging" and
     carries the unread count, so the member never has to remember where messages live. The old
     floating circle mounted and unmounted the entire panel, which is a popup wearing a chat's
     clothes: nothing persisted, and the label existed only once you had already opened it.

     .aq-bot-panel is NOT a legacy name to tidy up: index.css pins this drawer with the shared
     --aq-safe-bottom var (ticket #4's Android standalone 0-inset lie), and the keyboard/scroll
     focus guard above self-excludes on `closest(".aq-bot-panel")` so typing in here cannot fade
     out the control that closes it. Renaming the class breaks both, silently. */
  return (
    <div
      /* aq-bot-above-tabs: signed-in phones carry AppShell's fixed bottom tab bar, and the drawer is
         welded to the bottom edge — so without this it opens ON TOP of that bar, covering the nav.
         Only JS knows the bar is there (it renders for signed-in members only), so the clearance is
         a class rather than a media query alone; index.css lifts it by --aq-bottom-bar and takes the
         same amount off the body's height. */
      className={`aq-bot-panel fixed z-[60] w-[min(400px,calc(100vw-2.5rem))] transition-opacity duration-150 ${inTabBar ? "aq-bot-above-tabs " : ""}${inTabBar && !open ? "max-md:hidden " : ""}${hideDock ? "pointer-events-none invisible opacity-0" : "opacity-100"}`}
      aria-hidden={hideDock}
      /* Arta lives here (operator, 2026-08-02). This drawer's LID is its ledge:
         the panel is welded to the bottom edge with clear page above it, which
         makes it the one surface on any route where a figure can stand with its
         feet on a visible border and its body over nothing. Marked while hidden
         too would be wrong — a ledge nobody can see is not a ledge — so the
         attribute follows the dock's own visibility. */
      {...(hideDock ? {} : { "data-floor": "top", "data-floor-home": "" })}
    >
      {/* AN INBOUND CALL, wherever the member is on the site. It rides the badge poll (30s, and
          Chat::RING_S is longer so no ring can fall between two polls), and "Answer" OPENS THE
          CONVERSATION rather than dialling: the beacon deliberately carries no room name — that
          exists only inside the sealed invite, which is what makes a public database safe here. */}
      {ring && (
        <div className="mb-2">
          <IncomingCall name={ring.from.name} avatar={ring.from.avatar}
            onDismiss={() => clearRing()}
            /* Arm the intent BEFORE opening: the thread is what holds the offer, and it answers
               the moment it sees one (see takeAutoAnswer). Otherwise "Answer" only navigated, and
               the member arrived at a second Answer button having already answered. */
            onAnswer={() => {
              armAutoAnswer(ring.from.id);
              clearRing();
              setOpen(true);
              setDockView({ k: "dm", peer: ring.from });
            }} />
        </div>
      )}
      <div className="flex flex-col overflow-hidden rounded-t-2xl border border-b-0 border-line bg-space-1 shadow-2xl shadow-black/50">
        {/* The pinned bar. Hoisted out of DockBody so it survives collapse; its title still tracks
            the view, so opening a conversation renames the bar exactly as LinkedIn's does. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-space-2 px-3 py-2">
          {inThread ? (
            <button type="button" onClick={() => setDockView({ k: "list" })} aria-label="Back to conversations"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-veil/[0.07] hover:text-ink"><Ico d={BACK} size={18} /></button>
          ) : me ? (
            <Avatar name={me.name} src={me.avatar} className="h-8 w-8 shrink-0" />
          ) : (
            <LogoMark className="h-7 w-7 shrink-0" />
          )}
          <button
            type="button"
            ref={triggerRef}
            onClick={toggle}
            aria-expanded={open}
            aria-controls="aq-dock-body"
            aria-describedby={!open && unread > 0 ? "aq-dock-unread" : undefined}
            className="min-w-0 flex-1 truncate text-start"
          >
            {/* A member's name is member-authored: skipped so the i18n mesh can't publish it into
                the public aq_translations. The static titles are left translatable. */}
            <span className="block truncate text-[15px] font-bold leading-tight text-ink"
              {...(dockView.k === "dm" ? { "data-ay-skip": "1" } : {})}>{title}</span>
            {!inThread && unread > 0 && (
              /* The count lives in its OWN text node, skipped: the i18n mesh collects rendered
                 strings, so baking a live number into a translatable line wrote a row per value. */
              <span className="block text-[11px] leading-tight text-yang" data-ay-skip="1">{unread} unread</span>
            )}
          </button>
          {!inThread && unread > 0 && (
            <>
              <span aria-hidden className="grid min-w-[20px] shrink-0 place-items-center rounded-pill bg-yang px-1 text-[11px] font-bold leading-[16px] text-on-accent">
                {unread > 99 ? "99+" : unread}
              </span>
              <span id="aq-dock-unread" data-ay-skip="1" className="sr-only">{unread} unread</span>
            </>
          )}
          {!inThread && (
            <a href={localePath("/messages/")} aria-label="Open the full Messages page"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-veil/[0.07] hover:text-ink"><Ico d={COMPOSE} size={17} /></a>
          )}
          <button type="button" onClick={toggle} aria-expanded={open} aria-controls="aq-dock-body"
            aria-label={open ? "Collapse messaging" : "Expand messaging"}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-veil/[0.07] hover:text-ink">
            <Ico d={CHEVRON} size={18} className={open ? "" : "rotate-180"} />
          </button>
        </div>

        {/* The sliding body. `visibility: hidden` at height 0 (index.css) is load-bearing: a plain
            0-height overflow-hidden box still hands every control inside it to the Tab key, so a
            collapsed drawer would silently swallow keyboard focus mid-page.

            DockBody is MOUNTED ONLY WHILE OPEN, and that is not an optimisation. Two of its
            effects are gated on being rendered, not on being visible:
              1. useChat(view.k === "list") starts watchList(), and reading the list marks the
                 member "in a chat" SERVER-SIDE, which suppresses their own bell and away-email.
                 A permanently-mounted collapsed drawer would therefore silence every
                 notification they have, on every page, forever.
              2. BotChat installs a DOCUMENT-level paste listener so a screenshot can be pasted
                 into the chat. Mounted while collapsed, that listener would quietly capture a
                 paste the member aimed at any field on the page.
            Keeping the mount tied to `open` preserves exactly the old popup's semantics; only the
            BAR is new. The cost is that a half-typed ArtaBot question does not survive a collapse
            — same as before this change, when closing unmounted the whole panel. */}
        <div id="aq-dock-body" className="aq-bot-body flex flex-col" data-collapsed={open ? undefined : "1"}>
          {open && <DockBody view={dockView} setView={setDockView} />}
        </div>
      </div>
    </div>
  );
}
