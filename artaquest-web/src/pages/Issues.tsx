import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { isLoggedIn, Tickets, KINDS, type Ticket, type TicketMsg, type TicketKind } from "../lib/api";
import { useTypewriter } from "../lib/useTypewriter";
import { BackLink, Button, Card, EmptyState, ErrorNote, Field, Input, LoadMoreButton, LogoMark, PageHero, Segmented, StatusNote, Textarea } from "../components/ui";

// Contributions: open a ticket (bug / feature / content / suggestion), ArtaBot triages it in a
// back-and-forth, an autonomous agent may ship a fix, and YOU close it — earning 1 point on the
// kind's own leaderboard board (Sentinel / Visionary / Curator / Sage). Severity is gone; the model
// works it out in conversation. The board itself is PUBLIC — everyone sees every contribution, just
// like the discussion boards — but only the author can reply to or resolve their own ticket.

function fmtTime(unix: number) {
  const d = new Date(unix * 1000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " · " + time;
}

const OPEN_STATES = ["open", "triaging", "queued", "in_progress", "shipped"];
const statusTone = (s: string) =>
  s === "resolved" ? "bg-yang/15 text-yang"
  : s === "shipped" ? "bg-yin/15 text-yin-light"
  : ["queued", "in_progress"].includes(s) ? "bg-yin/10 text-yin-light"
  : "bg-space-2 text-ink-3";
const roleOf = (k: string) => KINDS.find((x) => x.key === k)?.role || "Sage";

function StatusPill({ status }: { status: string }) {
  return <span className={`shrink-0 rounded-pill px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${statusTone(status)}`}>{status.replace("_", " ")}</span>;
}

const ClipIcon = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.19 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/** /issues/?ticket=N is the canonical link to ONE contribution — it's what the notification bell
 *  (Notify::push in Tickets.php), ArtaBot's chat links ([#N]) and the "your contribution is live"
 *  email all point at. Read it so those links open the thread instead of the generic board (#39). */
function ticketFromUrl(): number | null {
  if (typeof window === "undefined") return null;
  const id = Number(new URLSearchParams(window.location.search).get("ticket"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Mirror the open contribution into the address bar. replaceState (never pushState, never the
 *  router): the view swap is in-place React state by design — see open()/back() — so this keeps
 *  refresh + share + back-button semantics without waking ClientNav's route-change scroll reset.
 *  react-router stores {usr,key,idx} in history.state; pass it through untouched. */
function syncTicketUrl(id: number | null) {
  if (typeof window === "undefined") return;
  const u = new URL(window.location.href);
  if (id == null) u.searchParams.delete("ticket");
  else u.searchParams.set("ticket", String(id));
  window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
}

/** A screenshot pasted/attached in the reply box (#48) rides on the message as meta.image. */
function msgShot(m: TicketMsg): string {
  const v = m.meta?.image;
  return typeof v === "string" ? v : "";
}

/** Mid-progress agent chatter — the "picked this up" announcement and the "Still on it/this…"
 *  nudges tools/ticket-agent/index.mjs posts while it works. The status pill already says
 *  in progress, so the thread keeps only the meaningful beats: opened, key decisions, shipped
 *  (#76). Hidden at render (matched on each line's fixed opening) rather than at the source,
 *  so threads that already carry these lines are streamlined too. */
const PROGRESS_NOISE = [/^🔧/, /^Still on (it|this) — /];
const isProgressNoise = (m: TicketMsg) => m.role === "agent" && PROGRESS_NOISE.some((re) => re.test(m.body));

function Shot({ url, below }: { url: string; below: boolean }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={`block overflow-hidden rounded-md ${below ? "mt-2" : ""}`}>
      <img src={url} alt="Attached screenshot" loading="lazy" decoding="async" className="max-h-[280px] w-full bg-space-2 object-contain" />
    </a>
  );
}

/** ArtaBot's freshly-arrived thread lines type themselves in — the same word-by-word reveal as the
 *  floating ArtaBot chat (#76). Plain text (matching the rest of the thread, not Markdown); a tap
 *  skips to the end. `data-ay-skip` keeps the half-typed text out of the i18n mesh while it reveals —
 *  the parent swaps to the normal, translatable text node once `onDone` fires. */
function TypingText({ body, onDone }: { body: string; onDone: () => void }) {
  const { text, finish } = useTypewriter(body, undefined, onDone);
  return <span data-ay-skip="1" onClick={finish} className="cursor-text">{text}</span>;
}

function Bubble({ m, animate = false, onTypingDone }: { m: TicketMsg; animate?: boolean; onTypingDone?: () => void }) {
  const shot = msgShot(m);
  // An image-only reply stores a placeholder body server-side — the picture says it, don't repeat it.
  const body = shot && m.body === "[shared a screenshot]" ? "" : m.body;
  if (m.role === "user") {
    return (
      <div className="flex flex-col items-end gap-0.5">
        {/* break-words: members paste URLs / error strings — pre-wrap alone won't break an unbroken
            token, and it would paint past the bubble and off-screen on phones (#18). */}
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-card bg-yin/15 px-3.5 py-2.5 text-[14px] leading-relaxed text-ink">{body}{shot && <Shot url={shot} below={!!body} />}</div>
        <span className="me-0.5 text-[11px] text-ink-2">{fmtTime(m.at)}</span>
      </div>
    );
  }
  if (m.role === "system") {
    return <p className="text-center text-[12px] text-ink-3">{m.body} · <span className="opacity-60">{fmtTime(m.at)}</span></p>;
  }
  // The developer agent and ArtaBot are ONE member-facing persona: both label as ArtaBot (#76);
  // the ⚙ avatar still quietly marks the developer's build/ship updates.
  const agent = m.role === "agent";
  return (
    <div className="flex justify-start gap-2">
      {agent ? <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-yin/15 text-[12px]">⚙</span> : <LogoMark className="mt-0.5 h-6 w-6 shrink-0" />}
      <div className="min-w-0 max-w-[85%] whitespace-pre-wrap break-words rounded-card border border-line bg-space-2 px-3.5 py-2.5 text-[14px] leading-relaxed text-ink-2">
        <span className="mb-0.5 flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wide text-ink-2">
          <span>ArtaBot</span>
          <span className="font-normal normal-case tracking-normal">{fmtTime(m.at)}</span>
        </span>
        {animate && body
          ? <TypingText body={body} onDone={onTypingDone ?? (() => {})} />
          : body}
        {shot && <Shot url={shot} below={!!body} />}
      </div>
    </div>
  );
}

export default function Issues() {
  const loggedIn = isLoggedIn();
  // The board is PUBLIC: logged-in members can narrow to just their own, but everyone — including
  // signed-out visitors — sees "all" by default, mirroring the open discussion boards.
  const [tab, setTab] = useState<"all" | "mine">("all");
  const [list, setList] = useState<Ticket[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [listErr, setListErr] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<number | null>(() => ticketFromUrl()); // deep link lands straight on the thread
  const [detail, setDetail] = useState<{ ticket: Ticket; messages: TicketMsg[] } | null>(null);
  const [detailErr, setDetailErr] = useState(false);

  // new-contribution form (signed-in members only)
  const [kind, setKind] = useState<TicketKind>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [where, setWhere] = useState(() => {
    if (typeof document === "undefined") return "";
    try { const u = new URL(document.referrer); if (u.origin === window.location.origin && !u.pathname.startsWith("/issues")) return u.pathname + u.search; } catch { /* */ }
    return "";
  });
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState("");
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  // Screenshot — the centrepiece of every contribution (paste / drag / pick a file).
  const [shotUrl, setShotUrl] = useState("");
  const [shotPreview, setShotPreview] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reply attachment (#48) — paste, drop, or pick a screenshot in the reply box on an open thread.
  // Uploaded immediately (same tickets/upload endpoint as the compose form); the stored URL is sent
  // with the message and rides on it as meta.image.
  const [replyShot, setReplyShot] = useState("");       // local data-URL preview
  const [replyShotUrl, setReplyShotUrl] = useState(""); // uploaded URL, ready to send
  const [replyUploading, setReplyUploading] = useState(false);
  const [replyErr, setReplyErr] = useState("");
  const replyFileRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setErr("That's not an image — attach a screenshot (PNG/JPEG/WebP/GIF)"); return; }
    if (file.size > 6 * 1024 * 1024) { setErr("Keep the screenshot under 6 MB"); return; }
    setErr("");
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file);
    });
    setShotPreview(dataUrl); setUploading(true);
    try { const r = await Tickets.uploadScreenshot(dataUrl); setShotUrl(r.url); }
    catch (e) { setErr(e instanceof Error ? e.message : "Upload failed"); setShotPreview(""); }
    finally { setUploading(false); }
  }, []);

  // Paste a screenshot anywhere on the page (the usual way people share one) — only while a
  // signed-in member is composing on the list (there's no form to fill otherwise).
  useEffect(() => {
    if (openId != null || !loggedIn) return;
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
      if (item) { handleFile(item.getAsFile()); }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [openId, loggedIn, handleFile]);

  // Same for the reply box (#48): read, preview, upload — gated to the reply form's own conditions.
  const handleReplyFile = useCallback(async (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setReplyErr("That's not an image — attach a screenshot (PNG/JPEG/WebP/GIF)"); return; }
    if (file.size > 6 * 1024 * 1024) { setReplyErr("Keep the screenshot under 6 MB"); return; }
    setReplyErr("");
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file);
    });
    setReplyShot(dataUrl); setReplyShotUrl(""); setReplyUploading(true);
    try { const r = await Tickets.uploadScreenshot(dataUrl); setReplyShotUrl(r.url); }
    catch (e) { setReplyErr(e instanceof Error ? e.message : "Upload failed"); setReplyShot(""); }
    finally { setReplyUploading(false); }
  }, []);
  const clearReplyShot = useCallback(() => { setReplyShot(""); setReplyShotUrl(""); setReplyErr(""); }, []);

  // Paste a screenshot anywhere on an open thread you own — exactly where the reply form shows.
  useEffect(() => {
    if (openId == null || !detail?.ticket.mine || !OPEN_STATES.includes(detail.ticket.status)) return;
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
      if (item) { handleReplyFile(item.getAsFile()); }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [openId, detail, handleReplyFile]);

  // The list is public for everyone. Signed-in members can flip to just their own contributions;
  // signed-out visitors always see the full board.
  const scope = loggedIn && tab === "mine" ? "mine" : "all";
  const loadList = useCallback(() => {
    setListErr(false);
    Tickets.list(scope).then((r) => { setList(r.items); setNext(r.next); }).catch(() => setListErr(true));
  }, [scope]);
  useEffect(() => { loadList(); }, [loadList]);

  // "Load more" — append the next keyset page (no OFFSET, no silent truncation).
  function loadMore() {
    if (next == null || loadingMore) return;
    setLoadingMore(true);
    Tickets.list(scope, { cursor: next })
      .then((r) => { setList((prev) => [...prev, ...r.items]); setNext(r.next); })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }

  // ── Typewriter (#76): ArtaBot's freshly-arrived lines type themselves in. ───────────────────
  // `seenIds` is every message id already on screen; `primed` guards the FIRST load of a ticket so a
  // deep link / refresh renders history instantly (never replays it as typing). `animIds` is the set
  // currently mid-reveal — a Bubble drops out of it via `endTyping` when its animation finishes.
  const [animIds, setAnimIds] = useState<Set<number>>(() => new Set());
  const seenIds = useRef<Set<number>>(new Set());
  const primed = useRef(false);
  const endTyping = useCallback((id: number) => {
    setAnimIds((s) => { if (!s.has(id)) return s; const next = new Set(s); next.delete(id); return next; });
  }, []);
  const resetTyping = useCallback(() => { seenIds.current = new Set(); primed.current = false; setAnimIds(new Set()); }, []);

  const loadDetail = useCallback((id: number) => {
    Tickets.get(id)
      .then((d) => {
        const items = d.messages.items;
        // After the first load, any ArtaBot line we haven't shown before types itself in — so the live
        // 5s poll reveals ArtaBot's triage (`assistant`) replies and the developer's `agent` "opened /
        // key decision / shipped" beats as composed messages, not popped-in blocks. The member's own
        // messages and system notices never animate; suppressed progress chatter (isProgressNoise) is
        // skipped here too, so a hidden line can't leave a reveal stuck open.
        if (primed.current) {
          const fresh = items.filter((m) =>
            (m.role === "agent" || m.role === "assistant")
            && m.body && !isProgressNoise(m)
            && !(msgShot(m) && m.body === "[shared a screenshot]")
            && !seenIds.current.has(m.id));
          if (fresh.length) setAnimIds((s) => { const next = new Set(s); for (const m of fresh) next.add(m.id); return next; });
        }
        for (const m of items) seenIds.current.add(m.id);
        primed.current = true;
        setDetail({ ticket: d.ticket, messages: items });
        setDetailErr(false);
      })
      // The error only surfaces while nothing is loaded yet (a bad/stale ?ticket= link) — once the
      // thread is on screen, `detail` stays truthy and a transient poll failure changes nothing.
      .catch(() => setDetailErr(true));
  }, []);

  // Deep link (#39): openId is seeded from ?ticket= in useState above; fetch its thread once on
  // mount. In-page opens fetch via open(), so this runs only for arrivals from a notification,
  // an ArtaBot chat link, an email, or a refresh/share of an open thread.
  useEffect(() => { if (openId != null) loadDetail(openId); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening a contribution swaps the list for the detail view IN PLACE — it's React state, not a route
  // change, so the URL never moves and the app's route-change scroll-reset (App.tsx ClientNav) never
  // fires. Left alone, the page keeps its scroll offset: on mobile the board sits far below the compose
  // form, so tapping an item there strands you on the footer of the (shorter) detail view instead of its
  // top, forcing a scroll back up (ticket #15). Remember the board position, jump the detail to the top
  // when it opens, and restore the board when you go back. The address bar still tracks the open
  // thread (syncTicketUrl — shallow replaceState, invisible to the router) so the URL stays
  // shareable and a refresh keeps your place.
  const listScrollY = useRef(0);
  function open(id: number) { listScrollY.current = window.scrollY; setOpenId(id); setDetail(null); setDetailErr(false); setReply(""); clearReplyShot(); resetTyping(); loadDetail(id); syncTicketUrl(id); }
  function back() { setOpenId(null); setDetail(null); setDetailErr(false); setReply(""); clearReplyShot(); resetTyping(); loadList(); syncTicketUrl(null); }
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; } // initial mount owns its own scroll
    if (openId != null) { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; }
    else window.scrollTo(0, listScrollY.current);
  }, [openId]);

  // Poll an open, not-yet-closed ticket so ArtaBot/agent replies appear live (read-only — fine for
  // any viewer following someone else's contribution).
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (openId == null || !detail) return;
    if (!OPEN_STATES.includes(detail.ticket.status)) return;
    pollRef.current = window.setInterval(() => {
      if (document.hidden) return;
      loadDetail(openId);
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [openId, detail, loadDetail]);

  // A screenshot helps a visual report (bug / content) enormously but is NEVER required — on phones
  // taking or attaching one is often impossible (Android even blocks captures in incognito), and a
  // required field here was blocking members from reporting at all. Encouraged, not gated.
  const shotHelps = kind === "bug" || kind === "content";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim().length <= 3 || body.trim().length <= 10 || posting) return;
    setPosting(true); setErr("");
    try {
      const r = await Tickets.create({ kind, title: title.trim(), body: body.trim(), screenshot: shotUrl, where: where.trim() || undefined });
      setTitle(""); setBody(""); setWhere(""); setShotUrl(""); setShotPreview("");
      loadList();
      open(r.id); // jump into the thread to see ArtaBot's triage
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not submit — please try again");
    } finally { setPosting(false); }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = reply.trim();
    const image = replyShotUrl;
    if ((!text && !image) || sending || replyUploading || openId == null) return;
    setReply(""); clearReplyShot(); setSending(true);
    setDetail((d) => d ? { ...d, messages: [...d.messages, { id: -Date.now(), role: "user", body: text, meta: image ? { image } : null, at: Date.now() / 1000 }] } : d);
    try { await Tickets.message(openId, text, image || undefined); } catch { /* */ } finally { setSending(false); loadDetail(openId); }
  }

  async function resolve() {
    if (openId == null) return;
    await Tickets.resolve(openId).catch(() => {});
    loadDetail(openId); loadList();
  }
  async function reopen() {
    if (openId == null) return;
    await Tickets.reopen(openId).catch(() => {});
    loadDetail(openId); loadList();
  }

  // ── detail (chat thread) — readable by anyone; only the author can reply / resolve ──────────
  if (openId != null) {
    const t = detail?.ticket;
    const closed = t ? !OPEN_STATES.includes(t.status) : false;
    const owner = !!t?.mine;
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-5 pb-12">
        <BackLink onClick={back}>All contributions</BackLink>
        {t && (
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-2">
                <span className="rounded-pill bg-yang/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-yang">{roleOf(t.kind)}</span>
                <StatusPill status={t.status} />
              </div>
              <h1 className="break-words text-[20px] font-bold leading-snug">{t.title}</h1>
              <p className="mt-1 text-[12px] text-ink-3">Opened by {owner ? "you" : t.author}</p>
              {t.pr_url && <a href={t.pr_url} target="_blank" rel="noopener noreferrer" className="text-[13px] text-yin-light hover:underline">View the change <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a>}
            </div>
          </header>
        )}

        {/* The original chat message that triggered a chat-filed contribution (#121), shown with the
            screenshot (#120) so a developer sees the full context behind the report — ArtaBot files a
            tidied-up title/body, this is the member's own words. break-words/pre-wrap for the same reason
            as the chat bubbles: members paste URLs and error strings (#18). */}
        {t?.chat_prompt && (
          <figure className="rounded-card border border-line bg-space-2 p-4">
            <figcaption className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-2">Original message</figcaption>
            <blockquote className="whitespace-pre-wrap break-words border-s-2 border-yin/50 ps-3 text-[14px] leading-relaxed text-ink-2">{t.chat_prompt}</blockquote>
          </figure>
        )}

        {t?.screenshot && (
          <a href={t.screenshot} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-card border border-line">
            <img src={t.screenshot} alt="Screenshot of the issue" loading="lazy" decoding="async" className="max-h-[440px] w-full bg-space-2 object-contain" />
          </a>
        )}

        <div className="flex flex-col gap-3">
          {detail ? detail.messages.filter((m) => !isProgressNoise(m)).map((m) => <Bubble key={m.id} m={m} animate={animIds.has(m.id)} onTypingDone={() => endTyping(m.id)} />)
            : detailErr
              ? <ErrorNote>Couldn’t load this contribution — the link may be stale, or your connection dropped. Use “All contributions” above to get back to the board.</ErrorNote>
              : <StatusNote className="py-8">Loading…</StatusNote>}
        </div>

        {t && owner && !closed && (
          <form onSubmit={send}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); handleReplyFile(e.dataTransfer.files?.[0]); }}
            className="sticky bottom-3 flex flex-col gap-2 rounded-card border border-line bg-space-1/90 p-2 backdrop-blur">
            {replyErr && <p className="px-1 text-[12px] text-rose-300">{replyErr}</p>}
            {replyShot && (
              <div className="relative w-fit max-w-full">
                <img src={replyShot} alt="Screenshot to attach" className="max-h-28 rounded-md border border-line object-contain" />
                {replyUploading && <span className="absolute inset-0 grid place-items-center rounded-md bg-space-1/70 text-[12px] text-ink-2">Uploading…</span>}
                <button type="button" onClick={clearReplyShot} aria-label="Remove the screenshot"
                  className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full border border-line bg-space-2 text-[11px] leading-none text-ink-2 hover:text-ink">✕</button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <button type="button" onClick={() => replyFileRef.current?.click()} aria-label="Attach a screenshot" title="Attach a screenshot"
                className="grid h-[44px] w-9 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:text-ink">
                <ClipIcon />
              </button>
              <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={1}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e as unknown as FormEvent); } }}
                placeholder="Reply to ArtaBot…" className="max-h-32 min-h-[44px] min-w-0 flex-1 resize-none" />
              <Button type="submit" disabled={(!reply.trim() && !replyShotUrl) || sending || replyUploading} size="md" className="shrink-0 disabled:opacity-40">Send</Button>
            </div>
            <input ref={replyFileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { handleReplyFile(e.target.files?.[0]); e.target.value = ""; }} />
          </form>
        )}

        {t && owner ? (
          <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-space-2 p-4">
            {t.status === "resolved"
              ? <><p className="text-[14px] text-yang">Resolved — thank you for contributing</p><Button variant="subtle" size="md" onClick={reopen}>Reopen</Button></>
              : <><p className="text-[14px] text-ink-2">Happy with the outcome? You're the only one who can close this.</p><Button size="md" onClick={resolve}>Mark resolved</Button></>}
          </div>
        ) : t && (
          <p className="rounded-card border border-line bg-space-2 p-4 text-center text-[13px] text-ink-3">
            You're viewing this contribution in the open. Only its author can reply or resolve it.
          </p>
        )}
      </div>
    );
  }

  // ── list (public board) + new-contribution form ───────────────────────────
  return (
    <div className="flex flex-col gap-10 pb-12">
      <PageHero
        eyebrow="Contributions"
        title="Help shape ArtaQuest"
        lede="Report a bug, request a feature, suggest an improvement, or share an idea. ArtaBot triages it with you and the best contributions ship automatically — and every contribution is public, just like the discussion boards."
      />

      {/* grid-cols-1 (not the implicit `auto` track) so the single mobile column is minmax(0,1fr) —
          capped at the viewport, never widened to fit the content. Both columns also get min-w-0 so
          they can shrink below their children's intrinsic width (a pasted screenshot preview, a long
          unbroken string) instead of pushing the form fields + board off-screen — the same global
          mobile-overflow class as #16 (see Data.tsx). Fixes #18. */}
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:items-start">
        {/* Left: compose (signed-in members) or a sign-in prompt, plus how it works. */}
        <div className="flex min-w-0 flex-col gap-6">
          {loggedIn ? (
            <form onSubmit={submit} className="flex flex-col gap-5">
              {/* Screenshot — the centrepiece. Paste, drag, or pick a file. */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-semibold text-ink-2">Screenshot <span className="font-normal text-ink-3">{shotHelps ? "(optional — but helps a lot)" : "(optional)"}</span></span>
                <div
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]); }}
                  role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileRef.current?.click(); }}
                  className={`relative grid min-h-[180px] cursor-pointer place-items-center overflow-hidden rounded-card border-2 border-dashed transition-colors ${shotPreview ? "border-yang/50 bg-space-2" : "border-line bg-space-2 hover:border-yin-light"}`}
                >
                  {shotPreview ? (
                    <>
                      <img src={shotPreview} alt="Screenshot preview" className="max-h-[280px] w-full object-contain" />
                      {uploading && <span className="absolute inset-0 grid place-items-center bg-space-1/70 text-[13px] text-ink-2">Uploading…</span>}
                      {!uploading && shotUrl && <span className="absolute right-2 top-2 rounded-pill bg-yang/20 px-2 py-0.5 text-[11px] font-bold text-yang">attached ✓</span>}
                      <button type="button" onClick={(e) => { e.stopPropagation(); setShotUrl(""); setShotPreview(""); }}
                        className="absolute right-2 bottom-2 rounded-pill bg-space-1/80 px-2 py-1 text-[11px] text-ink-2 hover:text-ink">Replace</button>
                    </>
                  ) : (
                    <div className="px-6 py-8 text-center">
                      <p className="text-[15px] font-semibold text-ink">Drop a screenshot, paste it, or click to upload</p>
                      <p className="mt-1 text-[12px] text-ink-3">PNG / JPEG / WebP / GIF · up to 6 MB · ArtaBot reads it to triage your issue</p>
                    </div>
                  )}
                </div>
                <input ref={fileRef} type="file" accept="image/*" className="hidden"
                  onChange={(e) => handleFile(e.target.files?.[0])} />
              </div>

              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-[13px] font-semibold text-ink-2">What kind of contribution?</legend>
                <div className="grid grid-cols-2 gap-2">
                  {KINDS.map((k) => {
                    const on = kind === k.key;
                    return (
                      <button key={k.key} type="button" onClick={() => setKind(k.key)} aria-pressed={on}
                        className={`rounded-card border px-3 py-2.5 text-start transition-colors ${on ? "border-yang/60 bg-yang/10" : "border-line bg-space-2 hover:border-ink-3/40"}`}>
                        <span className={`block text-[14px] font-bold ${on ? "text-yang" : "text-ink"}`}>{k.label}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-ink-2">{k.hint}</span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <Field label="Title">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required placeholder="One clear sentence" className="w-full" />
              </Field>

              <Field label="Where?" optional>
                {/* /courses/ was the example here until the courses economy was purged 2026-07-13 —
                    a placeholder that teaches the reporter a dead path. /works/ is the live feed. */}
                <Input value={where} onChange={(e) => setWhere(e.target.value)} maxLength={300} placeholder="/works/… or a full URL" className="w-full" />
              </Field>

              <Field label="Details">
                <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={6000} required
                  placeholder="What's happening, what you'd expect, steps to reproduce, or the idea in full. ArtaBot will ask if it needs more." className="w-full resize-y" />
              </Field>

              {err && <ErrorNote>{err}</ErrorNote>}
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={title.trim().length <= 3 || body.trim().length <= 10 || uploading || posting} className="disabled:opacity-40">{posting ? "Submitting…" : "Start a contribution"}</Button>
                <span className="text-[13px] text-ink-3">{uploading ? "Uploading screenshot…" : "ArtaBot replies straight away"}</span>
              </div>
            </form>
          ) : (
            <Card className="flex flex-col items-start gap-3 p-6">
              <h2 className="text-[18px] font-bold">Sign in to contribute</h2>
              {/* The sentence that used to end this paragraph — "tell ArtaBot (bottom-right) and it
                  will file the issue for you, signed in or not" — was false for the only people who
                  ever read it. ArtaBot is mounted as `{isLoggedIn() && <ArtaBot />}`, so there is no
                  launcher bottom-right for a signed-out reader, and POST artabot is auth 'user' and
                  refuses anyway. The anonymous path it described was real once (Assistant::ask_anon)
                  and still compiles, but nothing has called it since ArtaBot became a reason to sign
                  up rather than a public service — the code was disconnected and the promise was
                  left standing. Do not restore the sentence without restoring a caller. */}
              <p className="text-[14px] leading-relaxed text-ink-2">Anyone can browse every contribution. Sign in to open one of your own — an account links it to you, lets ArtaBot follow up, and is how you hear back.</p>
              <Button href="/login/?redirect_to=/issues/" size="md">Sign in</Button>
            </Card>
          )}

          <Card className="p-5">
            <h2 className="text-[15px] font-bold">How it works</h2>
            <ol className="mt-3 flex list-none flex-col gap-3 text-[13px] leading-relaxed text-ink-2">
              <li className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-yin/15 text-[12px] font-bold text-yin-light">1</span>You open a contribution and chat it through with ArtaBot — out in the open for everyone to follow.</li>
              <li className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-yin/15 text-[12px] font-bold text-yin-light">2</span>When it's concrete, an agent picks it up and ships the change.</li>
              <li className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-yang/15 text-[12px] font-bold text-yang">3</span>You verify and mark it resolved — earning a point on your board (Sentinel · Visionary · Curator · Sage).</li>
            </ol>
          </Card>
        </div>

        {/* Right: the public board — every contribution, visible to everyone. */}
        <section className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[15px] font-bold">{loggedIn && tab === "mine" ? "Your contributions" : "All contributions"}</h2>
            {loggedIn && (
              <Segmented label="Filter contributions" value={tab} onChange={(v) => setTab(v as "all" | "mine")}
                options={[{ value: "all", label: "All" }, { value: "mine", label: "Mine" }]} />
            )}
          </div>

          {listErr ? (
            <ErrorNote>Couldn’t load contributions — refresh to try again.</ErrorNote>
          ) : list.length === 0 ? (
            <EmptyState
              title={tab === "mine" ? "You haven’t opened any contributions yet" : "No contributions yet"}
              body={tab === "mine" ? "Start one on the left and it’ll appear here." : "Be the first to open one — it’ll show up here for everyone to see."} />
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {list.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => open(t.id)} className="group flex w-full items-start justify-between gap-2 rounded-card border border-line bg-space-2 px-3.5 py-3 text-start hover:border-ink-3/40">
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-semibold text-ink group-hover:text-yang">{t.title}</span>
                        <span className="mt-0.5 block text-[11px] text-ink-2">{roleOf(t.kind)} · {t.mine ? "you" : t.author} · {t.msg_count} msg</span>
                      </span>
                      <StatusPill status={t.status} />
                    </button>
                  </li>
                ))}
              </ul>
              {next != null && <LoadMoreButton onClick={loadMore} loading={loadingMore} label="Load more contributions" />}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
