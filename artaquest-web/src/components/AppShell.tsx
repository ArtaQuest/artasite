import { type ReactNode, Fragment, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import Arta from "../generated/arta/render/Arta";
import { LanguageSelector } from "./LanguageSelector";
import { BackgroundSwitcher } from "./BackgroundSwitcher";
import { Footer } from "./Footer";
import { SearchBox } from "./SearchBox";
import { UserMenu } from "./UserMenu";
import { currentUser, isLoggedIn, localePath } from "../lib/wp";
import { getChatState, subscribeChat } from "../lib/chat-store";
import { cartCount, onCartChange } from "../lib/cart";
import { CHECKOUT_LIVE } from "../lib/wp";
import { Button, IconButton, Logo, LogoMark } from "./ui";

const w = (typeof window !== "undefined" ? (window as unknown as Record<string, string>) : {}) || {};

// PHONE ONLY: lock the page scroll while an overlay menu covers it. Without this the content behind
// the menu stays scrollable, so it bleeds/scrolls through behind the overlay and steals the
// touch-drag from the menu's own scrolling (so the menu "won't scroll") — the two drawer bugs in
// ticket #12.
// On desktop the menus sit beside/over content that should keep scrolling, so the lock must never
// apply there — gate on the same md (768px) breakpoint as the drawers and re-sync if the viewport
// crosses it while a menu is open. Mirrors UserMenu's account drawer.
function useMobileScrollLock(active: boolean) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const desktop = window.matchMedia("(min-width: 768px)");
    const sync = () => { document.body.style.overflow = active && !desktop.matches ? "hidden" : ""; };
    sync();
    desktop.addEventListener("change", sync);
    return () => { desktop.removeEventListener("change", sync); document.body.style.overflow = ""; };
  }, [active]);
}

/* Inline icon set (currentColor stroke). */
const I = {
  home: <path d="M3 11.5 12 4l9 7.5M5 10v10h14V10" />,
  book: <><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2Z" /><path d="M8 7h8M8 11h8" /></>,
  trophy: <><path d="M8 4h8v4a4 4 0 0 1-8 0Z" /><path d="M4 5h4v3a2 2 0 0 1-4 0Z" /><path d="M20 5h-4v3a2 2 0 0 0 4 0Z" /><path d="M9 14h6l-1 6h-4Z" /></>,
  chat: <path d="M21 11.5a8.4 8.4 0 0 1-9.4 8.3L3 21l1.2-3.6A8.4 8.4 0 1 1 21 11.5Z" />,
  briefcase: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></>,
  heart: <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3" /><path d="M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11.5v4.5" /><path d="M12 8h.01" /></>,
  bug: <><path d="M12 7a3 3 0 0 0-3 3v3a3 3 0 0 0 6 0v-3a3 3 0 0 0-3-3z" /><path d="M9.5 7.5 8 6M14.5 7.5 16 6M6 11H4M18 11h2M6 15H4M18 15h2M12 16v4" /></>,
  coins: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" /><path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" /></>,
  wallet: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><path d="M16 14h2" /></>,
  database: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14h18M9 4v16" /></>,
  megaphone: <><path d="M4 10v4a1 1 0 0 0 1 1h3l8 4V5L8 9H5a1 1 0 0 0-1 1Z" /><path d="M18.5 9a3 3 0 0 1 0 6" /></>,
  fingerprint: <><path d="M12 11v2a9 9 0 0 1-2 5.5" /><path d="M8.5 5.5A6 6 0 0 1 18 10v3" /><path d="M6 13v-3a6 6 0 0 1 .8-3" /><path d="M9 11a3 3 0 0 1 6 0v2a12 12 0 0 1-1 5" /><path d="M12 13v1a15 15 0 0 1-1.2 6" /></>,
  download: <><path d="M12 3v12" /><path d="M7 11l5 4 5-4" /><path d="M5 21h14" /></>,
  profile: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.5 19a5.5 5.5 0 0 1 11 0" /></>,
  gear: <><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  calendar: <><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9.5h18M8 3v3M16 3v3" /><circle cx="8.5" cy="13.5" r=".6" fill="currentColor" /><circle cx="12" cy="13.5" r=".6" fill="currentColor" /><circle cx="15.5" cy="13.5" r=".6" fill="currentColor" /></>,
  sparkle: <path d="M12 3C12.7 9 15 11.3 21 12 15 12.7 12.7 15 12 21 11.3 15 9 12.7 3 12 9 11.3 11.3 9 12 3Z" />,
  bag: <><path d="M6 8h12l-1 12H7Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></>,
  medal: <><circle cx="12" cy="15" r="6" /><path d="M12 12v.01M8.5 9.5 6 3M15.5 9.5 18 3M10 3l2 4 2-4" /></>,
  mail: <><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="m3.5 7 8.5 6 8.5-6" /></>,
} as const;

type IconKey = keyof typeof I;

function Icon({ d }: { d: IconKey }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {I[d]}
    </svg>
  );
}

// Home is the SPA dashboard (client route). Everything else is a WordPress-rendered
// page (SEO/LLM-readable) the sidebar links to directly — root-relative so the URLs
// are correct in production where WP serves both the SPA and these pages same-origin.
// ONE FLAT LIST, Kaggle's shape (operator, 2026-07-30). No "Home" row — the wordmark directly above
// already links to "/" and the feed has its own row, so the rail was opening with two doors to the
// same place. And no section headings: "You", "Community", "Foundation" and "More" each cost a line
// of chrome to name a grouping nobody had asked about. A single hairline (`divider`) before the
// secondary block does the separating, exactly as the reference does it.
// The sidebar renders a faint group label before each cluster's first item. `auth` rows
// are the member's own pages (moved out of the account drawer in ticket #40, which is
// now notifications-only); they render only while signed in — the signed-out sidebar
// filters them away. The viewer's slug is server-injected (window.AQ_USER), so it is
// static for the page's life — safe to resolve once at module scope.
const ME_SLUG = currentUser()?.slug;
/** Gen-Z mobile: an app-style bottom tab bar for signed-in members (phones only). Five thumb
 *  slots; the raised centre one is ArtaBot (ticket #156 — members wanted the A button in the
 *  hero position, not floating over the bar's right end where it covered the Profile tab; the
 *  floating launcher retires on signed-in phones — see ArtaBot.tsx). Rankings left the bar for
 *  the sidebar. The slot beside Home is the Studio — book icon + "Studio" label, exactly the
 *  sidebar's row for the same /studio/ destination (ticket #159: after the #156 shuffle it kept
 *  Create's old sparkle, which — grey and beside the newly centred A — read as a leftover glyph,
 *  and doubled as the sidebar's Feed icon; members reported it as cruft to remove. Don't bring
 *  the sparkle back). Visitors get no bottom bar — the topbar's Sign in / Register covers
 *  joining (the fixed join banner was removed 2026-07-16). */
function BottomTabs() {
  // Unread count for the Messages tab. On a phone the floating dock launcher is hidden (ticket
  // #156 — the centre slot is ArtaBot), so without this the badge a member sees on desktop simply
  // does not exist on the device they mostly read on. Hooks run before the visitor early-return
  // below, because they must be called in the same order on every render.
  const [unread, setUnread] = useState(0);
  useEffect(() => subscribeChat(() => setUnread(getChatState().unread)), []);

  if (!isLoggedIn()) return null;
  const me = currentUser();
  const T = [
    { href: "/", d: "home" as IconKey, label: "Home" },
    { href: "/studio/", d: "book" as IconKey, label: "Studio" },
    { href: "/messages/", d: "chat" as IconKey, label: "Messages" },
    { href: me?.slug ? `/u/${me.slug}/` : "/user-account/", d: "profile" as IconKey, label: "Profile" },
  ];
  const tab = (t: (typeof T)[number]) => (
    <a key={t.href} href={localePath(t.href)}
      aria-label={t.href === "/messages/" && unread > 0 ? `${t.label} — ${unread} unread` : t.label}
      className="relative grid min-h-12 flex-1 place-items-center text-ink-3 transition-colors hover:text-ink">
      <Icon d={t.d} />
      {t.href === "/messages/" && unread > 0 && (
        <span aria-hidden className="absolute end-[22%] top-1.5 grid min-w-[17px] place-items-center rounded-pill border-2 border-space-1 bg-yang px-1 text-[10px] font-bold leading-[13px] text-on-accent">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </a>
  );
  return (
    /* Arta's home on a phone. The message dock is hidden at this size, so this
       bar is the only surface always on screen with clear page above it — and
       without one, Arta stands on the invisible stage floor over the footer
       with its legs behind this very bar. Both are marked; only ever one is
       rendered, because each is hidden at the other's breakpoint. */
    <nav aria-label="Quick navigation" data-floor="top" data-floor-home
      className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-line bg-space-1/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      {T.slice(0, 2).map(tab)}
      {/* ArtaBot in the centre slot — the same glassy gold/blue circle as the floating launcher,
          so "the A button" keeps its identity. The event toggles the chat panel (ArtaBot.tsx
          listens; fire-and-forget across trees, same pattern as "aq-cart"). */}
      <button type="button" onClick={() => window.dispatchEvent(new Event("aq:artabot"))} aria-label="ArtaBot"
        className="-mt-4 grid h-12 w-12 shrink-0 place-items-center self-center rounded-full border border-yang/30 bg-gradient-to-br from-yang/25 to-yin/25 shadow-lg shadow-black/40 backdrop-blur transition-transform active:scale-95">
        <LogoMark className="h-7 w-7" />
      </button>
      {T.slice(2).map(tab)}
    </nav>
  );
}

const NAV: { label: string; href: string; icon: IconKey; divider?: boolean; external?: boolean; auth?: boolean }[] = [
  { label: "Profile", href: ME_SLUG ? `/u/${ME_SLUG}/` : "/user-account/", icon: "profile", external: true, auth: true },
  // The universal Studio — every submission on the platform is authored here as one reproducible
  // notebook, whatever its kind (2026-07-13 feed reset).
  { label: "Studio", href: "/studio/", icon: "book", external: true, auth: true },
  // The member's OWN device shelf — media saved out of the Library, held in IndexedDB and playable
  // with no network at all (the point of "Save offline"). It had no nav entry, so downloaded music
  // was unreachable except by typing the URL: the feature existed and could not be found.
  { label: "My Library", href: "/my-library/", icon: "download", external: true, auth: true },
  { label: "Settings", href: "/user-account/?settings=1", icon: "gear", external: true, auth: true },
  // Feed group (2026-07-13, was "Create"): ONE catalogue of ten kinds, each entry a
  // reproducible Kaggle notebook that cleared the checklist. The kind shelves live as chips on
  // /works/ itself, so the nav stays one row per surface, not ten.
  { label: "Feed", href: "/works/", icon: "sparkle", external: true },
  // THE LIBRARY (operator 2026-07-28) — every published file, attachable by any member to their own
  // post. It shipped reachable only by typing the URL, which made the whole point of the reset
  // invisible: a shared shelf nobody can find is not a shared shelf.
  { label: "Library", href: "/library/", icon: "book", external: true },
  // ArtaChat — end-to-end encrypted DMs; keys live on the member's device, the DB holds ciphertext.
  { label: "Messages", href: "/messages/", icon: "mail", external: true, auth: true },
  { label: "Rankings", href: "/rankings/", icon: "trophy", external: true },
  // UNLISTED, not retired (operator 2026-08-03): /topics/ and /issues/ still resolve and still
  // render. They are reached from where they are actually needed — the seasons and cycles surfaces
  // link to Topics, Account and ArtaMod link to Contributions for reporting — they are simply off
  // the menu. Do not "restore" these rows; removing the ROUTES is a different decision, not this one.
  { label: "Donations", href: "/donate/", icon: "heart", external: true },
  { label: "Sponsors", href: "/sponsors/", icon: "megaphone", external: true },
  { label: "Reserve", href: "/reserve/", icon: "coins", external: true },
  { label: "Wallet", href: "/wallet/", icon: "wallet", external: true },
  { label: "Data", href: "/data/", icon: "database", external: true },
  { label: "Careers", href: "/careers/", icon: "briefcase", external: true, divider: true },
  { label: "Offline", href: "/offline/", icon: "download", external: true },
  { label: "About", href: "/about/", icon: "info", external: true },
  { label: "FAQ & Contact", href: "/faq-contact/", icon: "help", external: true },
];

// Integrated sidebar — Kaggle-exact. The CONDENSED icon rail is the static resting state;
// expanding does NOT slide a separate panel over it, it WIDENS this same element in place
// (w-rail → w-sidebar) so the icons never move and only the label column is revealed. The
// inner content is pinned to the full width (w-sidebar) and the aside clips it via
// overflow-hidden, so the labels are simply uncovered as the width animates — the icons
// stay put. 240ms on Kaggle's decelerate curve (cubic-bezier(0,0,0.2,1) === ease-out).
//
// Each row's icon sits in a w-rail box, so the icon is centred in the rail exactly where it
// rests when collapsed; the label begins right after that box (at the rail edge) and is
// clipped until expansion. No per-viewport translate trickery — one element, one width.

/**
 * CREATE — Kaggle's shape (operator 2026-07-30: "smaller and with submenu and + sign").
 *
 * It was a big solid-gold pill that jumped straight to /studio. Two things were wrong with that:
 * it shouted louder than anything else in the rail, and it pretended publishing is the only thing
 * a member can start. There are three front doors — submit a notebook that already ran on Kaggle,
 * write one here in the Lab, or found a challenge — and a menu is how you say that without adding
 * three more permanent rows to the nav.
 *
 * Subtle pill, accent only on the +, exactly like the reference: the button is a doorway, not a
 * billboard. Signed-out visitors still go straight to sign-in rather than opening a menu whose
 * every item would bounce them there anyway.
 */
const CREATE_ITEMS: { href: string; label: string; hint: string; d: IconKey }[] = [
  { href: "/studio/", label: "Notebook", hint: "Paste a Kaggle notebook that has run", d: "book" },
  { href: "/lab", label: "In the Lab", hint: "Write and run one here, in your browser", d: "sparkle" },
  { href: "/challenges/", label: "Challenge", hint: "Kind, topic, full-moon deadline, entry fee", d: "trophy" },
];

function CreateMenu({ expanded, onNavigate }: { expanded: boolean; onNavigate: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // Signed out: one honest hop to sign-in. Every menu item would land there regardless.
  if (!isLoggedIn()) {
    return (
      <a
        href={localePath("/login/")}
        onClick={onNavigate}
        aria-label="Create — sign in to publish"
        title="Sign in to publish"
        className={`mb-1 mt-3 flex h-10 shrink-0 items-center self-start overflow-hidden rounded-pill border border-line bg-space-3 font-semibold text-ink transition-colors hover:border-yang/50 hover:bg-space-2 ${expanded ? "mx-2 w-auto" : "mx-[14px] w-10 justify-center"}`}
      >
        {/* Expanded, the + must stay on the SAME 34px axis as every nav glyph below it, or it
             visibly jumps sideways as the rail widens. mx-2 (8) + w-[52px] centre = 34px. */}
        <span className={`grid shrink-0 place-items-center ${expanded ? "w-[52px]" : "w-10"}`}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden className="text-yang"><path d="M12 5v14M5 12h14" /></svg>
        </span>
        {/* NOT RENDERED when collapsed, rather than hidden. Measured on prod: with the label present
              at opacity-0 the + sat at x=-6 — off the left of the window — because a 40px button
              cannot hold a 40px icon box plus a label and its pe-4. `max-w-0` was not enough either;
              the text still contributed width and left the glyph outside its own button. Removing it
              from the tree puts the + dead-centre (x=25..43 in a 14..54 button). */}
        {expanded ? <span className="whitespace-nowrap pe-4 text-[14px] transition-opacity duration-200">Create</span> : null}
      </a>
    );
  }

  return (
    // `self-start` on a flex-column child is what stops the pill spanning the whole rail;
    // the wrapper needs it too, or the wrapper stretches and the button fills the wrapper.
    <div ref={wrapRef} className="relative self-start">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Create"
        title="Create"
        className={`mb-1 mt-3 flex h-10 shrink-0 items-center self-start overflow-hidden rounded-pill border font-semibold text-ink transition-colors ${open ? "border-yang/60 bg-space-2" : "border-line bg-space-3 hover:border-yang/50 hover:bg-space-2"} ${expanded ? "mx-2 w-auto" : "mx-[14px] w-10 justify-center"}`}
      >
        {/* Expanded, the + must stay on the SAME 34px axis as every nav glyph below it, or it
             visibly jumps sideways as the rail widens. mx-2 (8) + w-[52px] centre = 34px. */}
        <span className={`grid shrink-0 place-items-center ${expanded ? "w-[52px]" : "w-10"}`}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden className="text-yang"><path d="M12 5v14M5 12h14" /></svg>
        </span>
        {/* NOT RENDERED when collapsed, rather than hidden. Measured on prod: with the label present
              at opacity-0 the + sat at x=-6 — off the left of the window — because a 40px button
              cannot hold a 40px icon box plus a label and its pe-4. `max-w-0` was not enough either;
              the text still contributed width and left the glyph outside its own button. Removing it
              from the tree puts the + dead-centre (x=25..43 in a 14..54 button). */}
        {expanded ? <span className="whitespace-nowrap pe-4 text-[14px] transition-opacity duration-200">Create</span> : null}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Create"
          className="absolute start-2 z-50 mt-1 w-[16.5rem] overflow-hidden rounded-card border border-line bg-space-2 shadow-card"
        >
          {CREATE_ITEMS.map((c) => (
            <a
              key={c.href}
              role="menuitem"
              href={localePath(c.href)}
              onClick={() => { setOpen(false); onNavigate(); }}
              className="flex items-start gap-3 px-3.5 py-3 transition-colors hover:bg-veil/10 focus-visible:bg-veil/10"
            >
              <span className="mt-0.5 shrink-0 text-ink-3"><Icon d={c.d} /></span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ink">{c.label}</span>
                <span className="block text-[12px] leading-snug text-ink-3">{c.hint}</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Sidebar({ active, expanded, onNavigate, onToggle }: { active: string; expanded: boolean; onNavigate: () => void; onToggle: () => void }) {
  // Labels are visible only when expanded; in the condensed rail they fade fully out so the
  // rail shows icons alone (the icon column keeps its layout slot either way).
  const labelShow = expanded ? "opacity-100" : "opacity-0";
  // ONE sidebar for both shells (Kaggle shows signed-out visitors the same rail): the
  // member-only (`auth`) rows simply drop out when nobody is signed in.
  const items = isLoggedIn() ? NAV : NAV.filter((n) => !n.auth);
  return (
    <aside
      // Two behaviours, exactly like Kaggle:
      //   • Phone (max-md): NO rail. The panel is full width and lives off-canvas, sliding in
      //     (translateX) over a scrim when expanded — a classic drawer.
      //   • Desktop (md+): the condensed icon rail is the resting state; expanding WIDENS this
      //     same element in place (w-rail → w-sidebar, translateX always 0) so the icons never
      //     move and only the label column is revealed.
      // One element drives both: mobile animates transform, desktop animates width. 240ms on
      // Kaggle's decelerate curve (ease-out). overflow-hidden clips the labels in the rail.
      className={`fixed inset-y-0 start-0 z-50 flex w-sidebar flex-col overflow-hidden border-e border-line bg-space-1 transition-[width,transform] duration-[240ms] ease-out md:translate-x-0 ${
        expanded
          ? "max-md:translate-x-0 max-md:shadow-[0_0_8px_rgba(0,0,0,0.28)] md:w-sidebar"
          : "max-md:ltr:-translate-x-full max-md:rtl:translate-x-full md:w-rail"
      }`}
    >
      {/* Inner is pinned to the full expanded width so nothing reflows as the aside clips it. */}
      <div className="flex h-full w-sidebar shrink-0 flex-col">
        {/* top: hamburger (toggle) centred in the rail, then the lockup in the label column */}
        <div className="flex h-topbar shrink-0 items-center">
          <button onClick={onToggle} aria-label={expanded ? "Collapse menu" : "Expand menu"}
            className="grid h-11 w-rail shrink-0 place-items-center text-ink-2 transition-colors hover:text-ink">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          {/* Every label/text fades out in the condensed rail so ONLY icons show — the few px of
              clip overlap never leak a stray glyph. It fades back in as the panel widens. */}
          <a href={localePath("/")} aria-label="ArtaQuest — home" className={`shrink-0 transition-opacity duration-200 ${labelShow}`}><Logo /></a>
        </div>
        {/* duality hairline: blue (How) → gold (Why) */}
        <div className="mx-3 h-px bg-gradient-to-r rtl:bg-gradient-to-l from-yin-light/55 via-veil/12 to-yang/55" aria-hidden />

        {/* THE CREATE BUTTON (operator 2026-07-28) — Kaggle's shape, and the platform's one primary
            action. It was pulled in 2026-06-23 because it pointed at /discussions/ and nobody could
            tell what it would create; that objection is answered rather than overruled, because the
            reset gave publishing exactly ONE front door — paste a Kaggle notebook link in the
            Studio. Geometry follows the rail: the icon box is w-rail so the + never moves when the
            sidebar widens, and only the label column is revealed, exactly like every nav row below.
            Signed-out visitors are sent to sign in — the destination is theirs either way, and a
            dead-ending CTA is worse than an honest one. */}
        <CreateMenu expanded={expanded} onNavigate={onNavigate} />

        {/* nav — scrolls on its own; the hidden scrollbar keeps the rail clean. Each icon box
            is exactly w-rail wide, so the glyph is centred in the collapsed rail and the label
            (which starts past the rail edge) is clipped until the aside widens. */}
        <nav className="mt-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain pb-4 max-md:gap-0 max-md:pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((n, idx) => {
            const navSeg = "/" + (n.href.split("/").filter(Boolean)[0] || "");
            const on = navSeg === active;
            // Active item: a NEUTRAL selected state — no brand colour, at the member's request (ticket
            // #149). Earlier passes coloured the active pill gold: as TEXT it deepened to a muddy amber on
            // the light canvas (text-yang → --color-yang-ink #8a6300, unfixable without failing WCAG), and
            // even the follow-up solid-gold FILL still read as "coloured" to the member. Selection now
            // reads purely through a faint NEUTRAL wash (bg-veil — the same hover tint, a touch stronger)
            // plus a semibold, full-strength-ink label + icon: a clear "you are here" on both themes, no hue.
            const cls = `group relative mx-2 flex h-11 shrink-0 items-center rounded-field text-[15px] transition-colors max-md:h-10 ${
              on ? "bg-veil/[0.08] font-semibold text-ink" : "text-ink-2 hover:bg-veil/[0.04] hover:text-ink"
            }`;
            const inner = (<>
              <span className={`grid w-[52px] shrink-0 place-items-center ${on ? "text-ink" : "text-ink-3 group-hover:text-ink-2"}`}><Icon d={n.icon} /></span>
              <span className={`whitespace-nowrap pe-3 transition-opacity duration-200 ${labelShow}`}>{n.label}</span>
            </>);
            // A faint section label before each group's first item (fades out with the rail labels).
            // Kaggle's rail has NO section headings (operator, 2026-07-30) — one flat list, with a
            // single hairline before the secondary block. A rule separates without naming, which is
            // the whole point: "Community" and "Foundation" were labels for groupings the member
            // never asked about, and they cost a line of chrome each.
            const showDivider = n.divider === true && idx > 0;
            const link = n.external ? (
              <a href={localePath(n.href)} onClick={onNavigate} aria-label={n.label} className={cls}>{inner}</a>
            ) : (
              <Link to={n.href} onClick={onNavigate} aria-label={n.label} aria-current={on ? "page" : undefined} className={cls}>{inner}</Link>
            );
            return (
              <Fragment key={n.href}>
                {showDivider && <span className="mx-4 my-2 h-px shrink-0 bg-line" aria-hidden />}
                {link}
              </Fragment>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}

// Cart icon — appears in the topbar (next to the avatar) only when the localStorage cart is
// non-empty; live-updates via the cart change event. Gold count badge per brand.
// Hidden while CHECKOUT_LIVE is off: the cart/checkout flow is retired (nothing populates the
// cart now, and /cart/ is a removed static stub), so a stale localStorage count would dead-end.
function CartButton() {
  const [n, setN] = useState(0);
  useEffect(() => { setN(cartCount()); return onCartChange(() => setN(cartCount())); }, []);
  if (!CHECKOUT_LIVE || n <= 0) return null;
  return (
    <a href={localePath("/cart/")} aria-label={`Cart — ${n} item${n === 1 ? "" : "s"}`}
      className="relative grid h-9 w-9 shrink-0 place-items-center rounded-field text-ink-2 transition-colors hover:text-yang">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" />
        <path d="M2.5 3h2.3l2.1 11.7a1.6 1.6 0 0 0 1.6 1.3h8.2a1.6 1.6 0 0 0 1.6-1.3L20.5 7H6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="absolute -end-0.5 -top-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-yang px-1 text-[11px] font-bold leading-none text-on-accent tabular-nums">{n}</span>
    </a>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  // Phone gaps tighten to gap-1.5 — with the compact language pill + the phone-size lockup the
  // whole row (menu · lockup · toggle · language · avatar/Register) fits a 360px viewport with
  // slack, instead of shoving the theme toggle against its neighbours and clipping the trailing
  // control off-screen (ticket #47).
  const login = w.AQ_LOGIN_URL || "/login/";
  return (
    <header className="sticky top-0 z-30 flex h-topbar items-center gap-1.5 border-b border-line/70 bg-space-1/80 px-3 backdrop-blur-md md:gap-3 md:px-4 md:ps-12 md:pe-14">
      {/* Phone has no rail, so the menu trigger lives here. Desktop's trigger is in the rail. */}
      <IconButton label="Open menu" onClick={onMenu} className="h-9 w-9 shrink-0 md:hidden">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M3 6h18M3 12h18M3 18h18" /></svg>
      </IconButton>
      {/* mobile: brand lockup beside the menu button (phone-size — this instance is phone-only) */}
      <a href={localePath("/")} aria-label="ArtaQuest — home" className="shrink-0 md:hidden"><Logo size="text-xl" /></a>
      <div className="flex-1 md:hidden" aria-hidden />
      {/* desktop: full search bar */}
      {/* CAPPED, not flex-1. Measured at 1440px: the search field rendered 670px wide — WIDER than
          the 576px feed column beside it — so the loudest element on the page was a utility, and the
          content it searches looked secondary to it. A search field only needs room for a query, not
          every pixel the header can spare. */}
      <div className="hidden w-full max-w-[520px] md:block"><SearchBox /></div>
      {/* Pushes everything after it to the right edge. The search field is deliberately CAPPED
          rather than flex-1 (see above), so without a spacer the whole row packs to the left and
          leaves a wide gap after Register — the controls read as floating in the middle of the bar
          instead of anchored to its edge. The phone spacer above does the same job where the search
          field is not rendered. */}
      <div className="hidden flex-1 md:block" aria-hidden />
      <CartButton />
      {/* Language selector lives in the topbar so it is visible on EVERY surface —
          mobile, desktop, and when the sidebar is collapsed (the sidebar foot, where
          it used to live, is off-canvas on mobile and hidden when collapsed). */}
      <BackgroundSwitcher />
      <LanguageSelector compact />
      {/* Signed in → the account drawer; signed out → the auth CTAs (both go to the same
          email-code/Google flow — "Sign in" is the returning-member label, phone shows only
          the Register pill to keep the compact row inside a 360px viewport). */}
      {isLoggedIn() ? (
        <UserMenu />
      ) : (
        <>
          <a href={localePath(login)} className="hidden h-9 items-center whitespace-nowrap px-2 text-[14px] font-semibold text-ink-2 transition-colors hover:text-ink md:flex">Sign in</a>
          <Button href={login} className="h-9 shrink-0 px-3 text-[14px] md:px-4">Register</Button>
        </>
      )}
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const active = "/" + (pathname.split("/")[1] || "");
  // The feed surfaces: an endless stream, not a document with an end. "/" is the feed only for a
  // MEMBER — a signed-out visitor gets the landing page there, and a marketing page is exactly where
  // About, Privacy and Terms belong. Dropping the footer from both would have taken the legal links
  // off the one page most likely to be a stranger's first.
  const onFeed = (active === "/" && isLoggedIn()) || active === "/works";
  // Arta needs a ledge. The two that exist — the messaging dock and the bottom tab bar — are BOTH
  // members-only, so a signed-out visitor has none and the figure stands on nothing.
  const signedIn = isLoggedIn();
  // One state drives both viewports. Desktop has the room, so the menu rests EXPANDED
  // (labels showing); phones have none, so the drawer rests closed and only opens on tap.
  // `md` is Tailwind's 768px breakpoint — keep this matchMedia query in sync with it.
  const isDesktop = () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
  const [expanded, setExpanded] = useState(isDesktop);
  // Navigating closes the drawer on phones (it overlays the page); on desktop the panel
  // sits beside the content, so a nav click leaves it open — what the extra space affords.
  const collapse = () => { if (!isDesktop()) setExpanded(false); };

  // Cross-language navigation safety net. Most in-page links + CTAs are plain anchors that
  // full-reload to WordPress-served routes; the i18n router only prefixes URLs it is handed,
  // so on a translated page an un-prefixed href would drop the visitor back to English.
  // Intercept plain left-clicks on internal anchors and re-point them through localePath.
  // No-op on English and on already-prefixed links (so it never fights the explicit nav hrefs
  // or React Router), and ignores new-tab / modified / download / external clicks.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const raw = a.getAttribute("href");
      if (!raw) return;
      const loc = localePath(raw);
      if (loc !== raw) { e.preventDefault(); window.location.assign(loc); }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // PHONE ONLY: lock the page scroll while the drawer overlays it (ticket #12 — see the hook; on
  // desktop the sidebar is the RESTING layout, expanded by default with the page scrolling beside
  // it, so the lock applies on phones alone).
  useMobileScrollLock(expanded);

  // ONE shell for everyone (Kaggle gives signed-out visitors the same rail + hamburger; the old
  // separate logged-out TopNav had no menu at all on desktop). The Sidebar drops the member-only
  // rows and the Topbar swaps the account drawer for Sign in / Register when nobody is signed in.
  return (
    <div className="min-h-screen bg-space-1 text-ink">
      {/* One integrated sidebar: static icon rail that widens in place when expanded. */}
      <Sidebar active={active} expanded={expanded} onNavigate={collapse} onToggle={() => setExpanded((v) => !v)} />
      {/* Scrim — only while expanded, and only on phones (Kaggle leaves desktop un-dimmed
          since the widened panel just overlays beside the content). Fades to match the
          240ms width animation; tap anywhere to collapse. */}
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-[240ms] ease-out md:hidden ${expanded ? "touch-none opacity-100" : "pointer-events-none opacity-0"}`}
        aria-hidden
        onClick={collapse}
      />
      {/* Desktop: the rail is ALWAYS shown and the expanded panel EXTENDS it — the content
          reflows in lock-step (md:ps-rail → md:ps-sidebar) so the labels are never painted
          over the page; menu and content stay complementary, side by side. Padding animates
          on the same 240ms ease-out as the panel width. Phone: full width; drawer slides over. */}
      <div className={`transition-[padding] duration-[240ms] ease-out ${expanded ? "md:ps-sidebar" : "md:ps-rail"}`}>
        <Topbar onMenu={() => setExpanded(true)} />
        {/* overflow-x-clip: a hard, deterministic horizontal containment so no page's content can
            bleed past the viewport — what made the page overflow out beneath the open mobile nav
            drawer (ticket #16). It does NOT rely on the body→viewport overflow propagation (flaky on
            Android, and clobbered while the drawer's scroll-lock sets body{overflow:hidden}), and
            `clip` (unlike `hidden`) creates no scroll container, so the sticky Topbar — a sibling of
            <main> — and any in-page sticky/fixed still resolve to the viewport. */}
        <main className="overflow-x-clip">
          <div className="mx-auto max-w-content px-gutter py-7">{children}</div>
        </main>
        {/* The feed is a stream, not a document. A marketing footer under an endless column of
            posts is furniture nobody scrolled for, and it lands directly beneath the right rail
            where it reads as part of it. Every link in it also lives in the left rail. */}
        {onFeed ? null : <Footer />}
      <BottomTabs />
      </div>
      {/* ONE Arta for the whole app: a fixed, click-through layer, so it stands
          on the real cards of the page and can travel between them. z-30 sits
          under the mobile nav (z-40) and every dialog. */}
      {/* `ground` draws the stage line. OFF when a real ledge exists — Arta prefers the messaging
          dock, its documented home — and ON when none does. Both existing floors (the dock in
          ArtaBot.tsx and the bottom tab bar above) render only for members, so a signed-out visitor
          had nothing underfoot at all. Feet on a visible edge either way, which is the rule. */}
      <Arta fill figure={128} start={0.72} ground={!signedIn}
        className="pointer-events-none fixed inset-0 z-30" />
    </div>
  );
}
