import { useEffect, useRef, useState, type MouseEventHandler } from "react";
import { createPortal } from "react-dom";
import { localePath, currentUser, getDashboard, type Dashboard } from "../lib/wp";
import { signOut } from "../lib/auth";
import { CoinMark } from "../lib/currency";
import { Avatar, FlagBadge, IconButton } from "./ui";
import { Notifications as NotifyApi, type Notification } from "../lib/api";

/** Compact relative time for notification rows ("just now", "3h", "2d", "5 Jun"). */
function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const w = (typeof window !== "undefined" ? (window as unknown as Record<string, string>) : {}) || {};

/* Line icons (currentColor). The page-link icons (grid/profile/work/trophy/gear/heart) left with
   the nav rows (ticket #40) — those destinations now live in the left sidebar. */
const I = {
  out: <><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5M15 12H3" strokeLinecap="round" strokeLinejoin="round" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" /></>,
} as const;

type IconKey = keyof typeof I;
function Ic({ d }: { d: IconKey }) {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{I[d]}</svg>;
}

function Row({ icon, label, href, onClick, danger }: { icon: IconKey; label: string; href: string; onClick?: MouseEventHandler<HTMLAnchorElement>; danger?: boolean }) {
  // group → the icon tracks the label's hover brightness (mirrors the sidebar nav).
  // min-h-11 keeps the whole row a ≥44px touch target.
  return (
    <a href={localePath(href)} onClick={onClick} className={`group flex min-h-11 items-center gap-4 px-5 text-[15px] transition-colors hover:bg-veil/5 ${danger ? "text-ink-2 hover:text-rose-300" : "text-ink-2 hover:text-ink"}`}>
      <span className={`text-ink-3 transition-colors ${danger ? "group-hover:text-rose-300" : "group-hover:text-ink-2"}`}><Ic d={icon} /></span>
      {label}
    </a>
  );
}

/** The logged-in account drawer (avatar in the topbar → slide-in sheet). The Topbar mounts it
 *  only while signed in; signed-out visitors get Sign in / Register in its place. */
export function UserMenu() {
  const [open, setOpen] = useState(false);

  /* MARK THE DOCUMENT WHILE THE DRAWER IS UP, the same way the player bar marks it with
     data-aq-player. The ArtaChat dock is fixed to the bottom edge at z-60 and does not belong on top
     of — or behind the scrim of — a modal account menu. Raising the drawer above it fixed the
     overlap; this stops the dock showing through the dim as well. Cleaned up on close AND on
     unmount, or a drawer that unmounts while open would leave the dock hidden for good. */
  useEffect(() => {
    const el = document.documentElement;
    if (open) { el.setAttribute("data-aq-modal", "1"); } else { el.removeAttribute("data-aq-modal"); }
    return () => el.removeAttribute("data-aq-modal");
  }, [open]);
  const [d, setD] = useState<Dashboard | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Notification centre — unread count drives the dot on the trigger; the list loads with the
  // dashboard and refreshes each time the drawer opens (cheap, user-scoped GET).
  const [notes, setNotes] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const loadNotes = () => NotifyApi.list().then((n) => { setNotes(n.items); setUnread(n.unread); }).catch(() => {});

  useEffect(() => { getDashboard().then(setD); loadNotes(); }, []);
  useEffect(() => { if (open) loadNotes(); }, [open]);

  const markAll = async () => {
    if (!unread) return;
    setNotes((ns) => ns.map((n) => ({ ...n, read: true }))); setUnread(0); // optimistic
    try { await NotifyApi.markRead(); } catch { loadNotes(); }
  };
  const openNote = (n: Notification) => {
    if (!n.read) { setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, read: true } : x))); setUnread((u) => Math.max(0, u - 1)); NotifyApi.markRead(n.id).catch(() => {}); }
  };

  // While open, the drawer behaves as a modal dialog: move focus in, trap Tab, lock
  // body scroll, close on Escape, and restore focus to the trigger on close. The effect
  // is a no-op when closed (early return), so it never steals focus on first paint.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const trigger = triggerRef.current; // stable (rendered unconditionally) — restore focus here on close
    const focusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])'))
        .filter((el) => el.offsetParent !== null);
    focusables()[0]?.focus(); // first interactive element in the drawer
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1], active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) { e.preventDefault(); last.focus(); }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      trigger?.focus();
    };
  }, [open]);

  // Seed identity from the server-injected window.AQ_USER so the avatar + name are
  // correct on first paint, before the dashboard round-trip resolves (no letter flash).
  const me = currentUser();
  const name = d?.user.name || me?.name || "Account";
  const avatar = d?.user.avatar || me?.avatar;
  const slug = d?.user.slug || me?.slug;
  const country = d?.user.country || me?.country; // verified nationality → avatar flag
  const initial = (name[0] || "A").toUpperCase();
  // The avatar URL can 404 — a member with no uploaded photo and no gravatar (the backend asks
  // gravatar for d=404 so the empty-ring placeholder never renders); fall back to the initial. (#113)
  const [avatarFailed, setAvatarFailed] = useState(false);

  // header user cell — links to the public profile when we know the slug, else inert.
  const headerBox = "flex min-w-0 flex-1 items-center gap-3 rounded-card border border-line px-3 py-2";
  const headerInner = (
    <>
      <Avatar src={avatar} name={name} country={country} className="h-8 w-8 text-[13px] text-ink ring-1 ring-yin-light/50" />
      <span className="truncate text-[17px] font-bold text-ink">{name}</span>
    </>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open account menu"
        aria-haspopup="dialog"
        aria-controls="aq-account-drawer"
        aria-expanded={open}
        className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-yin/20 text-sm font-bold text-ink ring-2 ring-yin-light/60 transition-shadow hover:ring-yin-light"
      >
        {avatar && !avatarFailed ? <img src={avatar} alt="" onError={() => setAvatarFailed(true)} className="h-full w-full rounded-full object-cover" /> : initial}
        <FlagBadge country={country} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-yang px-1 text-[10px] font-bold leading-none text-on-accent ring-2 ring-space-1" aria-hidden>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {/* The drawer + backdrop are portalled to <body>: the Topbar has backdrop-blur, which
          makes it the containing block for position:fixed children — without the portal the
          drawer would clamp to the 60px header height and the page would bleed through it. */}
      {typeof document !== "undefined" && createPortal(
        <>
      {/* backdrop */}
      <div
        className={`fixed inset-0 z-[80] bg-black/50 transition-opacity duration-200 ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        aria-hidden
        onClick={() => setOpen(false)}
      />

      {/* Account drawer — slides in from the inline-end edge (right in LTR, left in RTL),
          matching the avatar button's side in the topbar. translate has no logical form, so
          the off-screen hide is a direction-aware pair. border-s separates it from the dimmed
          page (shadow is invisible on the near-black canvas). `inert` when closed pulls the
          off-canvas content out of the tab order + accessibility tree. */}
      <aside
        ref={panelRef}
        id="aq-account-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Account menu"
        inert={!open}
        // Any in-drawer navigation collapses the sheet. Every link here (the profile + wallet cards,
        // Sign out, and notification rows that have a destination URL) is an anchor, and
        // most are client-side React routes that ClientNav (App.tsx) navigates WITHOUT a full reload —
        // so the drawer + its trigger stay mounted and, with no explicit close, the sheet would sit open
        // on top of the page it just navigated to ("tapping a nav menu item navigates but the menu stays
        // open", ticket #17). Delegated on the panel so it covers every current + future link; gated on
        // closest("a") so the non-navigating controls (close button, "Mark all read") never trip it.
        onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}
        className={`fixed inset-y-0 end-0 z-[80] flex w-[320px] max-w-[88vw] flex-col border-s border-line bg-space-1 shadow-2xl transition-transform duration-200 ${open ? "translate-x-0" : "ltr:translate-x-full rtl:-translate-x-full"}`}
      >
        {/* header: avatar + name + close */}
        <div className="flex items-center gap-3 px-4 py-3.5">
          {slug
            ? <a href={localePath(`/u/${slug}/`)} className={`group ${headerBox} transition-colors hover:border-yin-light/40`}>{headerInner}</a>
            : <div className={headerBox}>{headerInner}</div>}
          <IconButton label="Close account menu" onClick={() => setOpen(false)} className="h-10 w-10 shrink-0">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
          </IconButton>
        </div>

        {/* wallet coins (the brand Arta Coin mark links to the wallet) + tier strip — the bar
            visualises progress to the next tier, which is driven by lifetime POINTS, not coins. */}
        {d && (
          <a
            href={localePath("/wallet/")}
            aria-label={`Open wallet — ${d.coins.toLocaleString()} coins. ${d.tier.label || "Quester"} tier${d.tier.next ? `, ${d.tier.pct}% to ${d.tier.next}` : ", top tier"}`}
            className="mx-4 mb-1 block rounded-card border border-line bg-space-2 px-4 py-3 transition-colors hover:border-yin-light/40"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[14px] font-semibold text-yang">
                <CoinMark size={18} />
                {d.coins.toLocaleString()} coins
              </span>
              <span className="shrink-0 text-[12px] font-semibold text-ink-2">{d.tier.label || "Quester"}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 text-[11.5px] text-ink-2">
              <span>{d.points.toLocaleString()} points</span>
              <span className="shrink-0">{d.tier.next ? `${d.tier.pct}% to ${d.tier.next}` : "Top tier"}</span>
            </div>
            {d.tier.next && (
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-pill bg-veil/10" aria-hidden>
                <div className="h-full rounded-pill bg-gradient-to-r from-yang to-yang-light" style={{ width: `${Math.max(0, Math.min(100, d.tier.pct))}%` }} />
              </div>
            )}
          </a>
        )}

        {/* Notification centre — the bell + the member's recent activity (profile updates, new
            followers, reply upvotes, …); rows render generically from title/body, so any new
            notification type works without changes here. Scrolls within the drawer; empty state
            mirrors the familiar pattern. It owns ALL the drawer's remaining height (flex-1):
            ticket #40 moved the page links (Home/Profile/Courses/Rankings/Settings/Donations)
            to the left sidebar, so this drawer is personal-only — notifications + Sign out. */}
        <div className="flex min-h-0 flex-1 flex-col border-t border-line/60">
          <div className="flex items-center justify-between px-5 pb-1 pt-3">
            <span className="flex items-center gap-2.5 text-[14px] font-bold text-ink">
              <span className="text-ink-3"><Ic d="bell" /></span>
              Notifications
              {unread > 0 && <span className="rounded-full bg-yang/15 px-1.5 py-0.5 text-[11px] font-bold leading-none text-yang">{unread}</span>}
            </span>
            {notes.some((n) => !n.read) && (
              <button type="button" onClick={markAll} className="text-[12px] font-semibold text-ink-2 transition-colors hover:text-yang">Mark all read</button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {notes.length === 0 ? (
              <p className="px-3 py-4 text-[13px] italic text-ink-3">No notifications to display</p>
            ) : (
              notes.map((n) => {
                const cls = `flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-veil/5 ${n.read ? "" : "bg-yin/5"}`;
                const inner = (
                  <>
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? "bg-transparent" : "bg-yang"}`} aria-hidden />
                    {/* A notification is composed SERVER-SIDE out of other people's words — a member's
                        display name, a meeting's title, a course a peer commented on. Unmarked, the
                        i18n mesh walks document.body, sends every one of those strings to a
                        translation service and PERSISTS the result in the public aq_translations
                        table: a private-ish meeting title republished onto a second public surface,
                        via a third party, because somebody happened to view their own bell in
                        French. The wrapper carries the marker, so the whole composed line is
                        excluded. THE COST, stated plainly: most notifications are pure platform English
                        with no member content at all ("New sign-in to your account", "Your book is ready
                        to review"), and this makes every one of them permanently untranslatable. That is
                        the wrong trade for those rows and the right one for the rest, because the server
                        composes them all into one string and the client cannot tell them apart. Privacy
                        wins the tie. Giving back both needs Notify::push to carry a template and its
                        values separately, so only the values are skipped. */}
                    <span className="min-w-0 flex-1" data-ay-skip="1">
                      <span className="block text-[13.5px] font-semibold leading-snug text-ink">{n.title}</span>
                      {n.body && <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{n.body}</span>}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-2" data-ay-skip="1">{ago(n.at)}</span>
                  </>
                );
                return n.url ? (
                  <a key={n.id} href={localePath(n.url)} onClick={() => openNote(n)} className={cls}>
                    {inner}
                  </a>
                ) : (
                  <button key={n.id} type="button" onClick={() => openNote(n)} className={cls}>
                    {inner}
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="border-t border-line/60 py-1">
          {/* Immediate sign-out via the API (ticket #42): the href's baked-in `log-out` nonce can be
              stale (SW-cached shell / >12h-old tab), where navigating it stops at WP's "Do you really
              want to log out?" page. signOut() logs out via POST /auth/logout + redirects home; the
              href stays as the no-JS / new-tab fallback. */}
          <Row icon="out" label="Sign out" href={w.AQ_LOGOUT_URL || "/wp-login.php?action=logout"} onClick={(e) => { e.preventDefault(); void signOut(); }} danger />
        </div>
      </aside>
        </>,
        document.body,
      )}
    </>
  );
}
