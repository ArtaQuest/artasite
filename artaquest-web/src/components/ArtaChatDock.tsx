import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { chatGetKey, chatMembers, type ChatMember, type ChatUserCard } from "../lib/api";
import { uiLocale, currentUser, isLoggedIn, localePath } from "../lib/wp";
import { armAutoAnswer, clearRing, getChatState, markSeen, subscribeChat, watchList } from "../lib/chat-store";
import { nameClass } from "../lib/fmt";
import { Avatar, LogoMark } from "./ui";
import { ArtaAvatar } from "./arta";
import { IncomingCall } from "./chat/CallPanel";
import { ArtaPrivateChat } from "./ArtaPrivateChat";

/**
 * ArtaChat dock — the LinkedIn-style messaging drawer pinned to the bottom-right corner of every
 * page for signed-in members. Restored from ArtaBot.tsx (removed in 09c01af when the paid private
 * assistant was retired): the DM list, encrypted threads, unread badge and the ringing-call banner
 * come back unchanged; the private bot conversation does NOT — its row now opens the public
 * "@artabot" composer instead. The dock's lid is also Arta's home ledge (data-floor), which is what
 * brings the ArtaLife companion back to stand on it.
 */

/** The DM thread lives in the ArtaChat page chunk (it carries the whole E2EE stack). Lazy, so the dock
 *  costs nothing until a member actually opens a conversation. */
const DmThread = lazy(() => import("../pages/Messages").then((m) => ({ default: m.DmThread })));

// ── The dock: one messaging surface for every DM ─────────────────

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

type View = { k: "list" } | { k: "arta" } | { k: "dm"; peer: ChatUserCard };

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
/* The drawer bar's two affordances: compose (jump to the full ArtaChat page) and the chevron that
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
  return new Date(ts * 1000).toLocaleDateString(uiLocale(), { month: "short", day: "numeric" });
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
      if (!k.key) setNote(`${k.user.name} hasn’t opened Chat yet, so they can’t receive one until they do.`);
    } catch { setNote("Couldn’t open that conversation."); }
  }

  // The header used to live here. It is now the drawer's PINNED BAR, hoisted into <ArtaChatDock> so it
  // stays on screen while the body is collapsed (LinkedIn's messaging drawer — operator, 2026-07-30).
  return (
    <>
      {view.k === "arta" && <ArtaPrivateChat />}

      {view.k === "dm" && (
        <Suspense fallback={<p className="p-6 text-center text-[13px] text-ink-3">Opening…</p>}>
          {me ? (
            <DmThread compact me={me} identity={chat.identity!} myKey={chat.myKey!} peer={view.peer}
              onBack={() => setView({ k: "list" })} />
          ) : chat.recovery === "restore" ? (
            /* Same state, reached by answering a call or opening a conversation: say the same
               true thing rather than a progress line that never progresses. */
            <div className="p-6 text-center">
              <p className="text-[13px] leading-relaxed text-ink-2">
                Your messages are sealed to a key this browser doesn’t have yet.
              </p>
              <a href={localePath("/messages/")}
                className="mt-3 inline-flex h-9 items-center rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent transition-colors hover:bg-yin hover:text-white">
                Restore this device
              </a>
            </div>
          ) : (
            <p className="p-6 text-center text-[13px] text-ink-2">Preparing this device’s key…</p>
          )}
        </Suspense>
      )}

      {view.k === "list" && (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <span className="text-ink-3" aria-hidden><Ico d={SEARCH} size={15} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages or members"
              aria-label="Search messages or members"
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-2" />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Arta is pinned first: the one conversation every member always has — a PRIVATE 1:1
                chat (the answer is only theirs). Tagging @artabot in a post is still the public route. */}
            <button type="button" onClick={() => setView({ k: "arta" })}
              className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-start transition-colors hover:bg-veil/[0.05]">
              <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full border border-yang/40 bg-space-1 p-0.5">
                <ArtaAvatar className="h-full w-full" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-ink">Arta</span>
                <span className="block truncate text-[12px] text-ink-3">Ask anything — a private chat, only you see it</span>
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
            ) : chat.recovery === "restore" ? (
/* NOT "preparing". bootChat() finds an escrow blob with no local identity, sets
    recovery:"restore" and returns WITHOUT minting a key — so `ready` never becomes true and
    nothing is being prepared or ever will be. The full page has branched on this since the
    lockout audit (Messages.tsx); the dock kept showing a progress line for a key that was
    never coming, on the one surface that is always on screen. The restore itself needs the
    recovery code and a panel, which belong on the page — so this says what is true and
    points there. */
              <div className="px-4 py-6 text-center">
                <p className="text-[13px] leading-relaxed text-ink-2">
                  Your messages are sealed to a key this browser doesn’t have yet.
                </p>
                <a href={localePath("/messages/")}
                  className="mt-3 inline-flex h-9 items-center rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent transition-colors hover:bg-yin hover:text-white">
                  Restore this device
                </a>
              </div>
            ) : !chat.ready ? (
              <p className="px-4 py-6 text-center text-[13px] text-ink-2">Preparing this device’s key…</p>
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
                    <span className={`min-w-0 flex-1 text-ink ${c.unread ? "font-bold" : "font-semibold"} ${nameClass(c.peer.name, 14)}`}>{c.peer.name}</span>
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
                    title={m.has_key ? "Send an encrypted message" : "Hasn’t opened Chat yet"}
                    className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-start transition-colors hover:bg-veil/[0.05]">
                    <span className="relative shrink-0">
                      <Avatar src={m.avatar} name={m.name} country={m.country} className="h-10 w-10" />
                      {m.online && <span aria-hidden className="absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full border-2 border-space-2 bg-yang" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block font-semibold text-ink ${nameClass(m.name, 14)}`}>{m.name}</span>
                      <span className="block break-words text-[12px] text-ink-3">
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

export function ArtaChatDock() {
  const [open, setOpen] = useState(false);
  // The ArtaChat page is the dock's own content at full size — see hideDock below.
  const onChatPage = /^\/(?:[a-z]{2}(?:-[a-z]+)?\/)?messages\/?$/i.test(useLocation().pathname);
  // Which conversation the dock is showing (lifted so a ringing call can open its thread directly).
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

  // Signed-in phones carry AppShell's fixed tab bar on the bottom edge; the drawer sits above it
  // (aq-bot-above-tabs in index.css) and, collapsed, shrinks to a compact pill in the corner so it
  // never covers the tab bar's Profile slot (ticket #156).
  const inTabBar = isLoggedIn();
  // The ArtaChat tab in the phone tab bar may ask the dock to open in place.
  useEffect(() => {
    const toggle = () => setOpen((o) => { if (!o) setDockView({ k: "list" }); return !o; });
    window.addEventListener("aq:artachat", toggle);
    return () => window.removeEventListener("aq:artachat", toggle);
  }, []);
  // Tell the phone tab bar whether the dock is open (it yields Arta's home to the open lid).
  useEffect(() => { window.dispatchEvent(new CustomEvent("aq:dock-open", { detail: open })); }, [open]);
  // Arta's home ledge: the dock lid on desktop, the tab bar on phones (only one is "home").
  const [wide, setWide] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
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
  // NOT ON ARTACHAT ITSELF. The dock is a shortcut to the page you are already looking at, and it
  // was landing ON TOP of that page's composer — a 400px panel over the last 300px of the input,
  // burying the mic button. It stays MOUNTED (this is the same invisible/pointer-events-none path
  // the keyboard uses, not an unmount), so an incoming call still rings and the unread count still
  // ticks; the page has its own, larger, version of every control it offers.
  // A RINGING CALL OUTRANKS EVERY REASON TO HIDE. The drawer hides itself on ArtaChat, while a
  // keyboard is up and when scrolled away — all sensible, and all of them were also hiding the
  // one thing a member must be able to answer. Mounted is not the same as visible: the wrapper
  // goes `invisible`, which paints nothing and takes Answer out of the tab order too.
  const hideDock = !ring && (onChatPage || (!open && ((fieldFocused && (vvSupported ? kbShrunk : true)) || scrolledAway)));

  const inThread = dockView.k !== "list";
  const title = dockView.k === "dm" ? dockView.peer.name : dockView.k === "arta" ? "Arta" : "ArtaChat";
  const toggle = () => setOpen((o) => !o);
  const me = currentUser();

  /* A DRAWER, not a popup (operator, 2026-07-30: "like LinkedIn, opens up and down like a drawer
     that says messaging"). The bar is ALWAYS on screen, welded to the bottom edge; only the body
     slides. That is the whole point of the pattern — the collapsed state still says "Chat" and
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
      className={`aq-bot-panel fixed z-[60] w-[min(400px,calc(100vw-2.5rem))] transition-opacity duration-150 ${inTabBar ? "aq-bot-above-tabs " : ""}${!open ? "aq-dock-compact " : ""}${hideDock ? "pointer-events-none invisible opacity-0" : "opacity-100"}`}
      aria-hidden={hideDock}
      /* Arta lives here (operator, 2026-08-02). This drawer's LID is its ledge:
         the panel is welded to the bottom edge with clear page above it, which
         makes it the one surface on any route where a figure can stand with its
         feet on a visible border and its body over nothing. Marked while hidden
         too would be wrong — a ledge nobody can see is not a ledge — so the
         attribute follows the dock's own visibility. */
      {...(hideDock ? {} : wide || open ? { "data-floor": "top", "data-floor-home": "" } : { "data-floor": "top" })}
    >
      {/* AN INBOUND CALL, wherever the member is on the site. It rides the badge poll (30s, and
          Chat::RING_S is longer so no ring can fall between two polls), and "Answer" OPENS THE
          CONVERSATION rather than dialling: the beacon deliberately carries no room name — that
          exists only inside the sealed invite, which is what makes a public database safe here. */}
      {/* AN INBOUND CALL, wherever the member is on the site. It rides the badge poll (30s, and
          Chat::RING_S is longer so no ring can fall between two polls), and "Answer" OPENS THE
          CONVERSATION rather than dialling: the beacon deliberately carries no room name — that
          exists only inside the sealed invite, which is what makes a public database safe here.

          IN FLOW, ABOVE THE DOCK CARD — not a fixed sibling. I moved it out to escape hideDock and
          it then had to clear the dock's own height by hand: at bottom+0.5rem it painted straight
          over the collapsed bar (its title, unread badge and expand control), over the composer when
          open, over the media player, and over Arta's ledge, and it flipped to the wrong edge in RTL.
          The panel is bottom-anchored with auto height, so flow already puts this above the card for
          free and keeps it on the same edge. The real bug was never the position — it was that
          hideDock hid the ring too, which `ring &&` below now prevents. */}
      {ring && (
        <div className="mb-2">
          <IncomingCall name={ring.from.name} avatar={ring.from.avatar}
            onDismiss={() => clearRing()}
            onAnswer={() => {
              armAutoAnswer(ring.from.id);
              clearRing();
              setOpen(true);
              setDockView({ k: "dm", peer: ring.from });
            }} />
        </div>
      )}
      <div className="aq-dock-card flex flex-col overflow-hidden rounded-t-2xl border border-b-0 border-line bg-space-1 shadow-2xl shadow-black/50">
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
            className="min-w-0 flex-1 text-start"
          >
            {/* A member's name is member-authored: skipped so the i18n mesh can't publish it into
                the public aq_translations. The static titles are left translatable. */}
            <span className={`block font-bold text-ink ${nameClass(title, 15)}`}
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
            <a href={localePath("/messages/")} aria-label="Open Chat"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-veil/[0.07] hover:text-ink"><Ico d={COMPOSE} size={17} /></a>
          )}
          {/* WHO AM I TALKING TO? In the dock there was no way to find out beyond the name: the left
              slot is the Back arrow (not an avatar, unlike the list view), and the name itself is the
              collapse toggle, so neither could carry the link the full-page thread has had all along.
              Somebody deciding how to answer a stranger — or just placing a half-remembered name —
              had to leave the conversation to look. This is the same act as the list view's "Open
              Chat" button in the same slot: one glyph, one destination, only where it applies. */}
          {inThread && dockView.k === "dm" && dockView.peer.slug && (
            <a href={localePath(`/u/${encodeURIComponent(dockView.peer.slug)}/`)}
              aria-label={`See ${dockView.peer.name}'s profile`} title="See their profile"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full transition-opacity hover:opacity-80">
              {/* Their FACE, not a generic person glyph. The dock's left slot is the Back arrow, so
                  this is the only picture of the other person anywhere in the collapsed dock — and
                  an anonymous outline in the one spot reserved for "who am I talking to" answered
                  the question with a shrug. The full-page thread header has shown the real avatar
                  all along; this makes the dock agree with it. Avatar falls back to the initial on
                  its own, so a missing or ORB-blocked image never leaves an empty circle. */}
              <Avatar src={dockView.peer.avatar} name={dockView.peer.name}
                className="h-7 w-7 text-[13px] ring-1 ring-line" />
            </a>
          )}
          <button type="button" onClick={toggle} aria-expanded={open} aria-controls="aq-dock-body"
            aria-label={open ? "Collapse Chat" : "Expand Chat"}
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
