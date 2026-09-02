import { type ReactNode, Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import Arta from "../generated/arta/render/Arta";
import { LanguageSelector } from "./LanguageSelector";
import { BackgroundSwitcher } from "./BackgroundSwitcher";
import { Footer } from "./Footer";
import { SearchSheet, ShellRail } from "./RightRail";
import { SearchBox } from "./SearchBox";
import { openSearch, useWide } from "../lib/rail";
import { nameClass, nameSize } from "../lib/fmt";
import { UserMenu } from "./UserMenu";
import { currentUser, isLoggedIn, localePath } from "../lib/wp";
import { signOut } from "../lib/auth";
import { getChatState, subscribeChat } from "../lib/chat-store";
import { cartCount, onCartChange } from "../lib/cart";
import { CHECKOUT_LIVE } from "../lib/wp";
import { Avatar, Button, IconButton, Logo, LogoMark } from "./ui";

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
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.5-4.5" /></>,
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
  // Unread count for the ArtaChat tab. On a phone the floating dock launcher is hidden (ticket
  // #156 — the centre slot is ArtaBot), so without this the badge a member sees on desktop simply
  // does not exist on the device they mostly read on. Hooks run before the visitor early-return
  // below, because they must be called in the same order on every render.
  const [unread, setUnread] = useState(0);
  useEffect(() => subscribeChat(() => setUnread(getChatState().unread)), []);
  // "Where am I" — the bar rendered every tab in the same grey, so on a phone (where this bar IS
  // the navigation) nothing said which surface was open. X marks the active tab in full-strength
  // ink; the same first-segment match the sidebar uses decides it.
  const { pathname } = useLocation();
  const here = "/" + (pathname.split("/")[1] || "");

  if (!isLoggedIn()) return null;
  const me = currentUser();
  const T = [
    { href: "/", d: "home" as IconKey, label: "Home" },
    { href: "/studio/", d: "book" as IconKey, label: "Studio" },
    { href: "/messages/", d: "chat" as IconKey, label: "ArtaChat" },
    { href: me?.slug ? `/u/${me.slug}/` : "/user-account/", d: "profile" as IconKey, label: "Profile" },
  ];
  const tab = (t: (typeof T)[number]) => {
    // Home covers /works and every kind shelf too — they are the same timeline under a filter, so
    // the tab that took the member there must stay lit while they are on it.
    const seg = "/" + (t.href.split("/").filter(Boolean)[0] || "");
    const on = seg === "/" ? here === "/" || here === "/works" || FEED_SHELVES.has(here) : seg === here;
    return (
    <a key={t.href} href={localePath(t.href)}
      aria-label={t.href === "/messages/" && unread > 0 ? `${t.label} — ${unread} unread` : t.label}
      aria-current={on ? "page" : undefined}
      className={`relative grid min-h-12 flex-1 place-items-center transition-colors hover:text-ink ${on ? "text-ink" : "text-ink-2"}`}>
      <Icon d={t.d} />
      {/* The active dot — one glyph per tab is X's bar; a label under each would not fit five
          slots on a 360px phone, and a coloured icon would spend the brand on furniture. */}
      {on ? <span aria-hidden className="absolute bottom-1 h-1 w-1 rounded-full bg-yang" /> : null}
      {t.href === "/messages/" && unread > 0 && (
        <span aria-hidden className="absolute end-[22%] top-1.5 grid min-w-[17px] place-items-center rounded-pill border-2 border-space-1 bg-yang px-1 text-[10px] font-bold leading-[13px] text-on-accent">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </a>
    );
  };
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

// The routes that mount <Feed> (App.tsx's route table) — i.e. the ones that render their own right
// rail. Keep in sync with it: a shelf missing here shows the header's search field beside the
// rail's, which is the one thing the move to the right was meant to stop.
const FEED_SHELVES = new Set([
  "/works", "/surveys", "/datasets", "/models", "/articles",
  "/2d-illustrations", "/3d-illustrations", "/2d-animations", "/3d-animations",
  "/2d-games", "/3d-games", "/music",
]);

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
  { label: "ArtaChat", href: "/messages/", icon: "mail", external: true, auth: true },
  { label: "Calendar", href: "/calendar/", icon: "calendar", external: true, auth: true },
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
  // The Foundation's published books had a route, a page title and a working page, and no link
  // anywhere in the product — the only mention was the FAQ naming "/finances" as plain text a
  // reader had to retype. It sits with Reserve and Data because those three are the same
  // promise: everything we hold, everything we owe, everything we know, in public.
  { label: "Finances", href: "/finances/", icon: "coins", external: true },
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

function CreateMenu({ onNavigate }: { onNavigate: () => void }) {
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
        className="mb-1 mt-3 flex h-11 shrink-0 items-center justify-center overflow-hidden rounded-pill bg-yang font-bold text-on-accent shadow-sm transition-opacity hover:opacity-90 mx-2 w-[calc(100%-1rem)] md:mx-[14px] md:w-10 md:self-start xl:mx-2 xl:w-[calc(100%-1rem)] xl:self-auto"
      >
        {/* JUST THE WORD, CENTRED, AS WIDE AS THE ACCOUNT ROW (operator 2026-08-18, with X's Post
             button beside its account row: "centered and same length as the profile bar"): the same
             mx-2 as the AccountRow below, so the two pills share their edges; 44px tall (smaller than
             the 48px slab it replaced); no + beside the label. Collapsed, the + is the whole button. */}
        {/* Both children render; the viewport picks one — the word in the drawer and the labelled
            sidebar, the + on the icon rail — so there is no JS state to fall out of step with. */}
        <span className="whitespace-nowrap text-[15px] md:hidden xl:inline">Create</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden className="hidden shrink-0 md:block xl:hidden"><path d="M12 5v14M5 12h14" /></svg>
      </a>
    );
  }

  return (
    // X's Post button spans the rail's label column when it is open, so the wrapper must stretch
    // with it — and go back to `self-start` when the rail is a 68px icon strip, where a full-width
    // button would be a 68px slab.
    <div ref={wrapRef} className="relative shrink-0 mx-2 md:mx-[14px] md:self-start xl:mx-2 xl:self-auto">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Create"
        title="Create"
        className={`mb-1 mt-3 flex h-11 shrink-0 items-center justify-center overflow-hidden rounded-pill bg-yang font-bold text-on-accent shadow-sm transition-opacity hover:opacity-90 w-full md:w-10 xl:w-full ${open ? "opacity-90" : ""}`}
      >
        {/* JUST THE WORD, CENTRED, AS WIDE AS THE ACCOUNT ROW (operator 2026-08-18): see the signed-out
             twin above; the wrapper carries the mx-2 that lines it up with the row below. */}
        <span className="whitespace-nowrap text-[15px] md:hidden xl:inline">Create</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden className="hidden shrink-0 md:block xl:hidden"><path d="M12 5v14M5 12h14" /></svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Create"
          /* Upward: the button now sits at the FOOT of the rail, so a downward panel would open
             past the bottom of the window. */
          className="absolute bottom-full start-0 z-50 mb-1 w-[16.5rem] overflow-hidden rounded-card border border-line bg-space-2 shadow-card"
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
                <span className="block text-[12px] leading-snug text-ink-2">{c.hint}</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * THE ACCOUNT ROW AT THE FOOT OF THE RAIL — X's, including the ⋯ (operator 2026-08-18, screenshot:
 * the Post button over "Arash Ashrafnejad / @artafather" with a ⋯ at its end).
 *
 * The row already carried the face, the name and the handle; the ⋯ is what it was missing, and on X
 * it is how you leave. Ours opens upward (the row is the last thing in the rail) with the three
 * things that belong to the person rather than to the page: their profile, their settings, and sign
 * out. Notifications stay in the header's avatar menu — that badge belongs where it can be seen from
 * every scroll position, and duplicating it here would give one drawer two doors.
 *
 * The row is a LINK and the ⋯ is a BUTTON inside it, so a click on the dots must not also navigate:
 * stopPropagation + preventDefault on the trigger, which is why the dots are not simply an <a>.
 */
function AccountRow({ me, labelShow, onNavigate }: {
  me: { name: string; slug?: string; avatar: string };
  labelShow: string;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const href = localePath(me.slug ? `/u/${me.slug}/` : "/user-account/");
  const item = "flex w-full items-center gap-2.5 px-4 py-2.5 text-start text-[14px] font-semibold text-ink transition-colors hover:bg-veil/[0.06]";
  return (
    <div ref={wrap} className="relative">
      {open && (
        <div role="menu" aria-label="Account"
          className="absolute bottom-full start-2 z-50 mb-1 w-[15rem] overflow-hidden rounded-card border border-line bg-space-2 py-1 shadow-card">
          <a role="menuitem" href={href} onClick={() => { setOpen(false); onNavigate(); }} className={item}>Your profile</a>
          <a role="menuitem" href={localePath("/user-account/?settings=1")} onClick={() => { setOpen(false); onNavigate(); }} className={item}>Settings</a>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); void signOut(); }}
            className={`${item} text-rose-300 hover:text-rose-200`}>
            Sign out <bdi dir="ltr" data-ay-skip="1" className="text-ink-3">@{me.slug}</bdi>
          </button>
        </div>
      )}
      <a href={href} onClick={onNavigate} aria-label={`${me.name} — your profile`}
        className="mx-2 mb-3 mt-1 flex min-h-14 shrink-0 items-center rounded-pill py-1 transition-colors hover:bg-veil/[0.06]">
        <span className="grid w-[52px] shrink-0 place-items-center">
          <Avatar src={me.avatar} name={me.name} className="h-9 w-9 text-[13px] text-ink ring-1 ring-yin-light/50" />
        </span>
        {/* A NAME IS NEVER SHORTENED — nameClass wraps and steps the type down (lib/fmt). */}
        <span className={`min-w-0 flex-1 pe-1 transition-opacity duration-200 ${labelShow}`}>
          <span className={`block font-bold text-ink ${nameClass(me.name)}`}>{me.name}</span>
          <span className={`block break-all leading-tight text-ink-2 ${nameSize(me.slug || "", 13)}`} data-ay-skip="1">@{me.slug}</span>
        </span>
        <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label="Account options"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
          className={`me-2 grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/10 hover:text-ink ${labelShow}`}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
          </svg>
        </button>
      </a>
    </div>
  );
}

function Sidebar({ active, expanded, onNavigate }: { active: string; expanded: boolean; onNavigate: () => void }) {
  // Labels by VIEWPORT, not by state: visible in the phone drawer (it is the full panel),
  // hidden on the md icon rail, visible again from xl where the sidebar has its label column.
  const labelShow = "opacity-100 md:opacity-0 xl:opacity-100";
  // ONE sidebar for both shells (Kaggle shows signed-out visitors the same rail): the
  // member-only (`auth`) rows simply drop out when nobody is signed in.
  const items = isLoggedIn() ? NAV : NAV.filter((n) => !n.auth);
  // The account row at the foot needs the viewer; server-injected, so it is static for the page.
  const me = isLoggedIn() ? currentUser() : null;
  return (
    <aside
      // Two behaviours, like X:
      //   • Phone (max-md): NO rail. The panel is full width and lives off-canvas, sliding in
      //     (translateX) over a scrim when the drawer opens.
      //   • Desktop (md+): a PERMANENT fixture with no state — the icon rail, and from xl the
      //     same element wider with the label column revealed. The viewport decides; nothing
      //     toggles (operator 2026-09-01: "no ham menu in desktop").
      // overflow-hidden clips the labels while the element is at rail width.
      className={`fixed bottom-0 top-topbar start-0 z-40 flex w-sidebar flex-col overflow-hidden border-e border-line bg-space-1 transition-[width,transform,inset-inline-start] duration-[240ms] ease-out md:w-rail md:start-[var(--nav-void)] md:translate-x-0 xl:w-sidebar ${
        expanded
          ? "max-md:translate-x-0 max-md:shadow-[0_0_8px_rgba(0,0,0,0.28)]"
          : "max-md:ltr:-translate-x-full max-md:rtl:translate-x-full"
      }`}
    >
      {/* Inner is pinned to the full expanded width so nothing reflows as the aside clips it. */}
      <div className="flex h-full w-sidebar shrink-0 flex-col">
        {/* No lockup and no toggle here any more: both live in the full-width bar above, where
            Reddit keeps them, and stacking a second wordmark directly under the first is exactly
            what the hoist was meant to stop. No hairline of its own either: the gold→blue line under
            the top bar now runs the full window width, rail included, so a second short one here
            would double it (operator 2026-08-18). */}



        {/* nav — scrolls on its own; the hidden scrollbar keeps the rail clean. Each icon box
            is exactly w-rail wide, so the glyph is centred in the collapsed rail and the label
            (which starts past the rail edge) is clipped until the aside widens. */}
        <nav className="mt-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain pb-4 max-md:gap-0 max-md:pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((n, idx) => {
            const navSeg = "/" + (n.href.split("/").filter(Boolean)[0] || "");
            // Profile (/user-account/) and Settings (/user-account/?settings=1) share a first
            // segment, so both used to light up on the account page — two "you are here" in one
            // list. The query decides: a row that names one is current only when the address
            // carries it, and its plain sibling only when the address does not.
            const wantsQuery = n.href.includes("?") ? n.href.split("?")[1].split("=")[0] : "";
            const search = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
            const hasSettings = !!search?.has("settings");
            const on = navSeg === active && (wantsQuery ? hasSettings : !(navSeg === "/user-account" && hasSettings));
            // Active item: a NEUTRAL selected state — no brand colour, at the member's request (ticket
            // #149). Earlier passes coloured the active pill gold: as TEXT it deepened to a muddy amber on
            // the light canvas (text-yang → --color-yang-ink #8a6300, unfixable without failing WCAG), and
            // even the follow-up solid-gold FILL still read as "coloured" to the member. Selection now
            // reads purely through a faint NEUTRAL wash (bg-veil — the same hover tint, a touch stronger)
            // plus a semibold, full-strength-ink label + icon: a clear "you are here" on both themes, no hue.
            // Pill-shaped rows with a soft hover fill — X's nav geometry (the icon column keeps its
            // 52px axis, so nothing moves as the rail widens; only the row's corner radius and its
            // height change). A little taller than the old 44px row: these are the app's primary
            // destinations and they were the smallest touch targets on the page.
            // LIKE X (operator 2026-08-18): the current page is told by WEIGHT alone — a bold,
            // full-ink label and icon — with no fill behind it; the fill is hover only. The neutral
            // wash of ticket #149 sat on TWO rows at once whenever Profile and Settings shared a
            // path, and read as boxes in a list that X draws as plain rows. Type at 17px, a step up
            // from 15.5: these are the app's primary destinations, and X sets its at 20 on a wider
            // rail. Row height unchanged.
            const cls = `group relative mx-2 flex h-12 shrink-0 items-center rounded-pill text-[17px] transition-colors max-md:h-11 ${
              on ? "font-bold text-ink" : "text-ink-2 hover:bg-veil/[0.05] hover:text-ink"
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
        {/* CREATE — BELOW THE NAV (operator 2026-08-16: "the Create button should be in the bottom
            like X"). X puts Post under its nav list, not above it, and the reason shows on a short
            window: pinned to the top, the primary action sits furthest from the thumb and from the
            member's own row. Here it lands with the account row at the end of the rail, where the
            hand already is, and the nav reads as one uninterrupted list.

            It keeps everything the 2026-07-28 pass decided: the platform's ONE primary action, three
            honest front doors behind a menu (submit a run notebook, write one in the Lab, found a
            challenge) rather than a button that pretends publishing is the only thing to start, and
            a signed-out visitor sent to sign in rather than into a menu that would bounce them. */}
        <CreateMenu onNavigate={onNavigate} />

        {/* THE ACCOUNT ROW (operator 2026-08-16: "make the left bar like X"). X ends its left rail
            with the signed-in member — face, name, handle — and so do we. It is a link to the
            member's own profile; the account MENU stays in the header, where the notifications
            badge lives, so this row cannot become a second, competing door to the same drawer. */}
        {me ? <AccountRow me={me} labelShow={labelShow} onNavigate={onNavigate} /> : null}
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

/**
 * REDDIT'S HEADER — the search field is back, and it is CENTRED (operator 2026-08-16, superseding
 * the X-shaped header of earlier the same day; the right column keeps everything else).
 *
 * Reddit's bar is three zones, not a row that packs to one side: brand at the start, ONE wide
 * rounded field centred in the bar whatever the controls on either side weigh, and the member's
 * controls at the end. That centring is the whole point of the shape, so it is done with three
 * flex zones of equal weight (`flex-1` on both sides, the field `mx-auto` in the middle) rather
 * than a spacer — a spacer centres the field between its NEIGHBOURS, which drifts as the language
 * pill changes width from one locale to the next.
 *
 * The field is md+ only. On a 390px phone the row already carries the menu, the lockup, the theme
 * toggle, the language pill and the avatar; a field squeezed in beside them would be ~130px of
 * input. The phone keeps the magnifier, which opens the full-screen sheet (RightRail.tsx).
 */
/**
 * The header follows the CONTENT FRAME (operator 2026-08-16: "make the size and position of the
 * search bar match the content frame … right-align the top corner button with the top corner of the
 * right [column] to keep a constant and uniform gap from the sides").
 *
 * The frame moves — it is centred in whatever the rail leaves, and the rail is 256px or 68px — so no
 * fixed offset can align to it. The header MEASURES it instead: a ResizeObserver on #aq-content-col
 * and #aq-frame gives the column's left/width and the frame's right edge, and the field and the
 * row's end padding are set from those numbers, so they track the rail's 240ms width animation
 * frame by frame and any width the frame ends up at. Below lg there is no right column and the row
 * is too short for this to make sense; the field stays centred in the flow there.
 */
function useContentFrame(enabled: boolean) {
  const [f, setF] = useState<{ left: number; width: number; right: number } | null>(null);
  useLayoutEffect(() => {
    if (!enabled) { setF(null); return; }
    const frame = document.getElementById("aq-frame");
    if (!frame) return;
    const measure = () => {
      const col = document.getElementById("aq-content-col") || frame;
      const fr = frame.getBoundingClientRect();
      const cs = getComputedStyle(frame);
      const cr = col.getBoundingClientRect();
      const inner = col === frame
        ? { left: fr.left + parseFloat(cs.paddingLeft), right: fr.right - parseFloat(cs.paddingRight) }
        : { left: cr.left, right: cr.right };
      setF({ left: inner.left, width: inner.right - inner.left, right: fr.right - parseFloat(cs.paddingRight) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(frame);
    const col = document.getElementById("aq-content-col");
    if (col) ro.observe(col);
    window.addEventListener("resize", measure);
    // A ResizeObserver fires on a SIZE change and never on a pure move — and at 1440 the frame is
    // already at max-w-content, so collapsing the rail slides it 94px without resizing it. Follow the
    // wrapper's padding transition frame by frame instead: rAF from transitionstart to transitionend,
    // then one final measure for the settled position.
    let raf = 0;
    const tick = () => { measure(); raf = requestAnimationFrame(tick); };
    const onStart = (e: TransitionEvent) => { if (e.propertyName.startsWith("padding") && !raf) raf = requestAnimationFrame(tick); };
    const onEnd = (e: TransitionEvent) => { if (e.propertyName.startsWith("padding")) { cancelAnimationFrame(raf); raf = 0; measure(); } };
    document.addEventListener("transitionstart", onStart);
    document.addEventListener("transitionend", onEnd);
    document.addEventListener("transitioncancel", onEnd);
    return () => {
      ro.disconnect(); window.removeEventListener("resize", measure); cancelAnimationFrame(raf);
      document.removeEventListener("transitionstart", onStart); document.removeEventListener("transitionend", onEnd); document.removeEventListener("transitioncancel", onEnd);
    };
  }, [enabled]);
  return f;
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const wide = useWide();
  const frame = useContentFrame(wide);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  // The field must never run under the lockup on the left or the controls on the right — with the
  // rail collapsed at 1024px the content column starts under the wordmark. Clamp to the gap between
  // the two zones, keeping the frame's edges wherever they already fit.
  const fieldStyle = (() => {
    if (!wide || !frame) return undefined;
    // The CONTROLS, not the zones: both zones are flex-1 and meet at the middle of the row, so
    // clamping to their boxes squeezed the field to its 160px floor. The last child of the left zone
    // is the lockup; the first VISIBLE child of the right zone is its innermost control.
    const kids = (el: HTMLElement | null) => el ? ([...el.children] as HTMLElement[]).filter((k) => k.offsetParent !== null && k.getBoundingClientRect().width > 0) : [];
    const lk = kids(leftRef.current); const rk = kids(rightRef.current);
    // GAP 8, not 16. The clamp exists to stop the field running UNDER the lockup or the controls;
    // it is not a layout margin. At 1440 the controls begin 14.9px after the content column ends, so
    // a 16px demand shaved 1.08px off a field that would otherwise match the column exactly — the
    // clamp biting when there was nothing to prevent. At 8 it only engages where the column really
    // would collide (a collapsed rail at 1024, where it starts under the wordmark).
    const GAP = 8;
    const minLeft = (lk.length ? lk[lk.length - 1].getBoundingClientRect().right : 0) + GAP;
    const maxRight = (rk.length ? rk[0].getBoundingClientRect().left : window.innerWidth) - GAP;
    const left = Math.max(frame.left, minLeft);
    const right = Math.min(frame.left + frame.width, maxRight);
    return { left, width: Math.max(160, right - left) };
  })();
  // The row's END padding puts the last control's edge on the right column's edge — the same gap
  // from the window's side as the column keeps. Physical, so it is right in RTL too.
  const endPad = (() => {
    if (!wide || !frame) return undefined;
    const rtl = document.documentElement.dir === "rtl";
    return { paddingInlineEnd: Math.max(16, rtl ? frame.left : window.innerWidth - frame.right) };
  })();
  // Phone gaps tighten to gap-1.5 — with the compact language pill + the phone-size lockup the
  // whole row (menu · lockup · search · toggle · language · avatar/Register) fits a 360px viewport
  // with slack, instead of shoving the theme toggle against its neighbours and clipping the
  // trailing control off-screen (ticket #47). Measured again after the magnifier joined it: the
  // row ends at 378px of a 390px viewport.
  const login = w.AQ_LOGIN_URL || "/login/";
  // Are we ALREADY on the auth page? Then the two CTAs below point at the page you are reading, and
  // a sign-in page whose loudest control is a Sign in button is a page arguing with itself. Compared
  // on the path so a locale prefix (/fa/login/) and a trailing slash both match.
  const { pathname: aqPath } = useLocation();
  const onAuthPage = /(^|\/)(login|sign-in|signin)\/?$/.test(aqPath.replace(/\/+$/, "/"));
  return (
    <header className="sticky top-0 z-50 bg-space-1/80 backdrop-blur-md">
      {/* THE BRAND HAIRLINE under the bar — gold at the start, blue at the end, the full width of the
          window (operator 2026-08-18: "I want it to be a gradient of gold to blue"). It replaced a
          plain grey border the same day, and the rail's own short blue→gold hairline retired with it:
          one line, the platform's two colours meeting, spanning rail and page alike. Mirrored in RTL
          so gold still sits at the reading start. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-yang to-yin rtl:bg-gradient-to-l" />
      <div className="relative flex h-topbar items-center gap-1.5 px-3 md:gap-3 md:px-4" style={endPad}>
        {/* THREE ZONES, and the outer two carry equal weight — that is what puts the field on
            the bar's own centre line. Centring it between its NEIGHBOURS instead leaves it
            short by whatever the controls weigh, and drifts with the language pill's width
            from one locale to the next (measured: 12px off at 1440 before this). */}
        <div ref={leftRef} className="flex min-w-0 flex-1 items-center gap-1.5 md:gap-3">
          {/* The DRAWER's toggle — phones only (operator 2026-09-01, with X's desktop nav beside
              it: "no ham menu in desktop"). On md+ the nav is a permanent fixture of the layout —
              an icon rail that becomes the labelled sidebar at xl, responsively, with nothing to
              toggle — so a hamburger there would be a control for a state that no longer exists. */}
          <IconButton label="Toggle menu" onClick={onMenu} className="h-9 w-9 shrink-0 md:hidden">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </IconButton>
          {/* The one lockup, at the window's start edge, where Reddit puts its own. */}
          <a href={localePath("/")} aria-label="ArtaQuest — home" className="shrink-0"><Logo size="text-xl" /></a>
        </div>
        {/* THE SEARCH FIELD. At lg+ it is positioned OVER THE CONTENT COLUMN — same left edge, same
            width — from the measured frame (see useContentFrame); between md and lg it is centred in
            the flow, Reddit-style, capped at ~690px. One instance either way. */}
        <div className={wide ? "absolute top-0 flex h-full items-center" : "hidden w-full max-w-[690px] shrink md:block"} style={fieldStyle}>
          <SearchBox compact />
        </div>
        {/* Phone: the magnifier opens the full-screen sheet — see the docblock. */}
        <IconButton label="Search" onClick={openSearch} className="h-9 w-9 shrink-0 md:hidden">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.5-4.5" strokeLinecap="round" /></svg>
        </IconButton>
        <div ref={rightRef} className="flex min-w-0 flex-1 items-center justify-end gap-1.5 md:gap-3">
        <CartButton />
          {/* ArtaBot's button moved INTO the search field's end corner (SearchBox.tsx) — one door,
              where the operator asked for it, instead of a second icon in this row. */}
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
            // On the auth page itself: no CTAs. Both of these lead here, so on /login/ they are two
            // competing buttons to the current page, sitting above a form that already asks for the
            // one thing they would ask for. Everywhere else they stay exactly as they were.
            onAuthPage ? null : (
            <>
              <a href={localePath(login)} className="hidden h-9 items-center whitespace-nowrap px-2 text-[14px] font-semibold text-ink-2 transition-colors hover:text-ink md:flex">Sign in</a>
              <Button href={login} className="h-9 shrink-0 px-3 text-[14px] md:px-4">Register</Button>
            </>
            )
          )}
        </div>
      </div>
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
  // ArtaChat is an APP PANE, not a document: it sizes itself to the viewport so the composer
  // stays put while the messages scroll under it. A marketing footer below that is 295px of
  // page nobody can see without scrolling PAST a pane that is already the height of the screen
  // — and its existence is what made the whole page scroll instead of just the conversation.
  const onAppPane = active === "/messages" || active === "/meet";
  // Every route that mounts <Feed> — which brings its own right rail, and with it the pinned search
  // at the top of that rail (X's shape). The header's own field must not render beside it at lg, or
  // the page carries two search boxes a hand's width apart. "/" counts in BOTH states: a member gets
  // the feed there, and a signed-out visitor gets the landing page, which embeds the same feed.
  // ONE right column, rendered here, on every page that has room for it. Pages no longer bring
  // their own — they drop cards into this one through <RailPortal> — so there is no state in which
  // a page can leave the reader with no column and no search (the bug on /calendar: it claimed the
  // column and then, signed out, rendered nothing at all). App panes are the only exception:
  // ArtaChat and Meet size themselves to the viewport and carry their own list beside the thread.
  const shellRail = !onAppPane;
  // Arta needs a ledge. The two that exist — the messaging dock and the bottom tab bar — are BOTH
  // members-only, so a signed-out visitor has none and the figure stands on nothing.
  const signedIn = isLoggedIn();
  // `expanded` is THE PHONE DRAWER, nothing else (operator 2026-09-01: "no ham menu in desktop").
  // Desktop's nav has no state at all any more: it is an icon rail from md and the labelled
  // sidebar from xl, decided by the viewport the way X decides it, so the only thing left to
  // open or close is the phone's overlay drawer — which rests closed.
  const isDesktop = () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
  const [expanded, setExpanded] = useState(false);
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
    // `--nav-w` — the nav's width as a LENGTH, read by the fixed nav's offset and the wrapper's
    // padding — is set responsively in .aq-shell (index.css): rail from md, sidebar from xl.
    // There is no collapse state to carry any more; the viewport decides, exactly as on X.
    <div className="aq-shell min-h-screen bg-space-1 text-ink">
      {/* SKIP TO THE CONTENT (WCAG 2.4.1). Before this, a keyboard or screen-reader visitor crossed
          the bar and every row of the rail — twenty-odd links — to reach the page, on every single
          navigation. Visible only when focused, which is the point: it is furniture for the people
          who need it and invisible to everyone else. */}
      <a href="#aq-main"
        className="sr-only z-[60] rounded-pill bg-yang px-4 py-2 text-[14px] font-semibold text-on-accent focus:not-sr-only focus:fixed focus:start-3 focus:top-3">
        Skip to content
      </a>
      {/* THE BAR SPANS THE WINDOW, and the rail starts under it (operator 2026-08-16, "it must be
          centred like this" + a Reddit bar). This is the only geometry in which the search field is
          on the window's centre line: while the bar began after the rail, a field centred in it sat
          128px right of the window centre with the rail open and 34px with it collapsed — centred
          on the bar, never on the screen, and it MOVED when the rail did. */}
      <Topbar onMenu={() => setExpanded((v) => !v)} />
      {/* One integrated sidebar: static icon rail that widens in place when expanded. */}
      <Sidebar active={active} expanded={expanded} onNavigate={collapse} />
      {/* Scrim — only while expanded, and only on phones (Kaggle leaves desktop un-dimmed
          since the widened panel just overlays beside the content). Fades to match the
          240ms width animation; tap anywhere to collapse. */}
      <div
        className={`fixed inset-0 top-topbar z-30 bg-black/50 transition-opacity duration-[240ms] ease-out md:hidden ${expanded ? "touch-none opacity-100" : "pointer-events-none opacity-0"}`}
        aria-hidden
        onClick={collapse}
      />
      {/* Desktop: the nav is a permanent fixture and the padding follows --nav-w responsively
          (rail from md, sidebar from xl) — the same variable the nav's own width tracks, so the
          two can never reflow out of step. Phone: full width; the drawer slides over. */}
      <div className="transition-[padding] duration-[240ms] ease-out md:ps-[calc(var(--nav-void)+var(--nav-w))] md:pe-[max(0px,calc(var(--nav-void)-var(--spacing-gutter)))]">
        {/* overflow-x-clip: a hard, deterministic horizontal containment so no page's content can
            bleed past the viewport — what made the page overflow out beneath the open mobile nav
            drawer (ticket #16). It does NOT rely on the body→viewport overflow propagation (flaky on
            Android, and clobbered while the drawer's scroll-lock sets body{overflow:hidden}), and
            `clip` (unlike `hidden`) creates no scroll container, so the sticky Topbar — a sibling of
            <main> — and any in-page sticky/fixed still resolve to the viewport. */}
        <main id="aq-main" tabIndex={-1} className="overflow-x-clip focus:outline-none">
          {/* min-w-0 on the content is load-bearing: without it a wide child (a table, a chart, a
              code block) sets the flex base and pushes the column off-screen instead of scrolling
              inside its own box — the same rule PageRail documents. */}
          {/* `aq-frame` / `aq-content-col`: the header measures these to put the search field over
              the content column and its controls on the right column's edge (Topbar). */}
          <div id="aq-frame" className={`mx-auto max-w-content px-gutter py-7 ${shellRail ? "flex gap-6" : ""}`}>
            {shellRail ? <div id="aq-content-col" className="min-w-0 flex-1">{children}</div> : children}
            {shellRail ? <ShellRail /> : null}
          </div>
        </main>
        {/* The feed used to be excluded here on the grounds that it is a stream, not a document,
            and that a footer under an endless column of posts is furniture nobody scrolled for.
            That held while the timeline was endless. It is not yet: with a handful of posts the
            column ends well above the fold and the page simply STOPS — a wide band of empty canvas
            with the dock floating in it, which reads as a page that failed to finish loading rather
            than as a deliberate absence (operator, 2026-08-13).

            App PANES stay excluded, and for a different reason that still stands: ArtaChat and Meet
            size themselves to the viewport so the composer stays put while messages scroll under it.
            A footer below that is a screen's worth of page nobody can reach without scrolling past a
            pane already as tall as the window — and its existence is what made the whole page scroll
            instead of just the conversation. That is layout mechanics, not editorial. */}
        {/* THE FOOTER IS NOW THE RAIL'S FOOT ON A WIDE SCREEN (operator 2026-08-16). Below lg there
            is no right column, so the full-width footer still runs there — the legal links are not
            optional furniture. App panes keep neither, as before. */}
        {onAppPane ? null : <div className="lg:hidden"><Footer /></div>}
      <BottomTabs />
      {/* One search sheet for the whole app — the phone's search surface. */}
      <SearchSheet />
      {/*
        THE SPACE ARTA OCCUPIES, RESERVED BY THE PAGE.

        Arta stands on the TOP edge of a fixed dock, so its body fills the ~128px directly above that
        edge. Whatever the document ends with sits in that band once you scroll to the end — measured
        on a short window, that was the footer's legal row, with a leg through "Privacy" and "Terms".
        Covered links are the part that actually matters; the rest is only untidy.

        The footer already reserves bottom clearance for the DOCK itself (see Footer.tsx, sized by
        measurement). This is the same idea for the figure standing ON the dock, and it is deliberately
        NOT more padding inside the footer: the feed has no footer at all and its last card met exactly
        the same leg. A spacer after the page content covers both.

        It exists only when Arta does. `signedIn` is the same condition the mount below uses to decide
        whether a real ledge exists — both floors in this app are members-only — so a signed-out
        visitor, who has no companion, is not given a band of empty space to scroll past.
      */}
      {signedIn ? <div aria-hidden className="h-32" /> : null}
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
