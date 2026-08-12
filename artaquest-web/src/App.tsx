import { Component, lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { ArtaBot } from "./components/ArtaBot";
import { ArtaTTS } from "./components/ArtaTTS";
import { OfflineBanner } from "./components/OfflineBanner";
import { I18nGate } from "./components/I18nGate";
import { IdentityGate } from "./components/IdentityGate";
import { isLoggedIn, localePath } from "./lib/wp";
import { dismissBootScreen } from "./lib/boot";
// Pages are lazy-loaded so the initial bundle ships only the shell + router + the current route's
// chunk, not all 17 pages up-front (the heavy ones — Lesson's YT player, Donate, Wallet — defer
// until visited). The persistent AppShell stays eager, so only the content area suspends on nav.
const Landing = lazy(() => import("./pages/Landing"));
const Fields = lazy(() => import("./pages/Fields"));
const Profile = lazy(() => import("./pages/Profile"));
const Account = lazy(() => import("./pages/Account"));
const Login = lazy(() => import("./pages/Login"));
const ArtaProfile = lazy(() => import("./pages/ArtaProfile"));
const Donate = lazy(() => import("./pages/Donate"));
const Participation = lazy(() => import("./pages/Participation"));

/** Redirect that CARRIES THE QUERY STRING. The retired /enroll and /cart slugs are still where
 *  Stripe returns a payer (Extra::course_checkout sets return_url = /enroll/?stripe=success&
 *  session=…), and a plain <Navigate to="/wallet"> dropped the search — so the browser leg of
 *  fulfilment silently never ran and every payment waited on the webhook alone. */
function KeepQuery({ to }: { to: string }) {
  const loc = useLocation();
  return <Navigate to={to + loc.search} replace />;
}
const About = lazy(() => import("./pages/About"));
const NewsDetection = lazy(() => import("./pages/NewsDetection"));
const FaqContact = lazy(() => import("./pages/FaqContact"));
const Developers = lazy(() => import("./pages/Developers")); // the API docs + token guide (author-email publish gate)
const Wallet = lazy(() => import("./pages/Wallet"));
const MyLibrary = lazy(() => import("./pages/MyLibrary"));
import { PlayerProvider } from "./components/player"; // the member's OWN device library (distinct from /library)
const Messages = lazy(() => import("./pages/Messages")); // ArtaChat — end-to-end encrypted DMs
const Meet = lazy(() => import("./pages/Meet")); // ArtaMeet — scheduled meetings on ArtaChat rooms
const Calendar = lazy(() => import("./pages/Calendar")); // ArtaCalendar — everything dated, in one place
const Book = lazy(() => import("./pages/Book")); // a member's booking page — take a slot from their week
const NotFound = lazy(() => import("./pages/NotFound"));
const ArtaRead = lazy(() => import("./pages/ArtaRead")); // read/translate/listen to ANY PDF, on-device
const Page = lazy(() => import("./pages/Page"));
const Grants = lazy(() => import("./pages/Grants"));
const Reserve = lazy(() => import("./pages/Reserve"));
const Finances = lazy(() => import("./pages/Finances"));
const Issues = lazy(() => import("./pages/Issues"));
const Careers = lazy(() => import("./pages/Careers"));
// The CEO posting (operator 2026-07-30) — its own URL so it can be linked and shared.
const CeoRole = lazy(() => import("./pages/CeoRole"));
const Fearometer = lazy(() => import("./pages/Fearometer"));
const Data = lazy(() => import("./pages/Data"));
const Pricing = lazy(() => import("./pages/Pricing"));
const OfflinePage = lazy(() => import("./pages/Offline"));
const ConsolePage = lazy(() => import("./pages/Studio")); // legacy operator console (ArtaAI/Members/Console tabs) at /console
// ── The Notebook Feed (2026-07-13) — the whole platform is these three surfaces now.
//    Every legacy content surface (courses, library, challenges, competitions, research, games,
//    shop, topics …) is retired; its route 301s into the matching feed shelf below.
const Feed = lazy(() => import("./pages/Feed"));
const ChallengesPage = lazy(() => import("./pages/ChallengesPage"));
const Rankings = lazy(() => import("./pages/Rankings"));
const NotebookPage = lazy(() => import("./pages/NotebookPage"));
// The JupyterBook page — every work read as a book through ArtaReader (operator 2026-07-29).
const NotebookBook = lazy(() => import("./pages/NotebookBook"));
const NotebookStudio = lazy(() => import("./pages/NotebookStudio"));
const Lab = lazy(() => import("./pages/Lab")); // run + edit any notebook on-device (Pyodide)
const Library = lazy(() => import("./pages/Library")); // every published file, attachable to any member's post

// Front page: the feed for members, the marketing landing for visitors.
function HomeOrLanding() {
  return isLoggedIn() ? <Feed /> : <Landing />;
}

// Anything without its own route falls here: any WP page rendered generically (AQ_PAGE_ID —
// careers, FAQ, about, legal…), else the feed.
function CatchAll() {
  if ((window as unknown as { AQ_IS_404?: boolean }).AQ_IS_404) return <NotFound />;
  const pageId = (window as unknown as { AQ_PAGE_ID?: number }).AQ_PAGE_ID;
  if (pageId) return <Page id={pageId} />;
  return <Feed />;
}

// React owns the ENTIRE front-end (user 2026-05-29). Real paths (BrowserRouter) so URLs
// stay crawlable; WordPress serves each route's "necessary SEO content" (server-rendered
// HTML + schema.org) inside the React mount as the crawler/no-JS layer, and React renders
// over it. WP must serve the app template for these paths (see includes/aq-app.php).

// The i18n plugin prefixes non-English URLs (/ar/, /es/, /zh/ …) and sets <html lang>.
// React Router must strip that prefix or no route matches on translated pages (the whole
// app would fall back to the server SEO stub). Derive the basename from the first path
// segment when it equals the server-set language — robust + can't false-match a real route.
// With the basename set, in-app <Link>s also stay within the visitor's language automatically.
function langBasename(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const seg = (window.location.pathname.split("/")[1] || "").toLowerCase();
  // Prefer the server-set language (AQ_I18N.current) over <html lang>: a browser "translate
  // this page" feature rewrites <html lang> (e.g. fr-FR → en, adding class="translated-ltr")
  // a beat after load. Trusting that mutated attribute would drop the basename and break
  // routing on translated pages, collapsing the SPA to the server SEO stub.
  const w = window as unknown as { AQ_I18N?: { current?: string } };
  const lang = (w.AQ_I18N?.current || document.documentElement.lang || "en").toLowerCase().split("-")[0];
  return seg && lang !== "en" && seg === lang ? "/" + seg : undefined;
}

// Per-route browser-tab title for client-side navigation. The server renders the correct
// <title> for the first paint + crawlers (see aq_app_seo_html); without this the SPA never
// updates document.title as the user navigates — leaving a stale tab title + the wrong thing
// announced to screen readers on route change (WCAG 2.4.2). Static routes are titled here;
// dynamic routes (course detail, profile, thread) set their own specific title (course/user
// name) from their data, and are intentionally skipped here so this never clobbers them.
// Titles for React-rendered routes only. WP-served pages (/reserve, /data, /careers…) set their
// own <title> server-side, so they don't belong here — keep this in sync with STATIC_ROUTES.
const ROUTE_TITLES: Record<string, string> = {
  "/about": "About", "/donate": "Donate",
  "/finances": "The Foundation’s books",
  "/wallet": "Your wallet", "/faq-contact": "FAQ & contact", "/user-account": "Your account",
  "/developers": "Developers",
  "/my-library": "My Library",
  "/ceo": "CEO",
  "/library": "Library",
  "/messages": "ArtaChat",
  "/meet": "ArtaMeet",
  "/calendar": "ArtaCalendar",
  // Every /book/<handle> too — this is the one URL in the product designed to be handed to a
  // stranger, and a tab reading "Page not found" is the first thing they would see.
  "/book": "Book a meeting",
  "/login": "Sign in", "/sponsors": "Sponsors",
  "/fearometer": "ArtaMod",
  "/works": "Home", "/challenges": "Challenges", "/rankings": "Rankings", "/studio": "Your Studio", "/console": "Operator console",
  // /topics is titled here because pages/Fields.tsx sets no title of its own; /lab is deliberately
  // absent — pages/Lab.tsx names the open notebook, and this would clobber it.
  "/topics": "Topics",
  "/surveys": "Surveys", "/datasets": "Datasets", "/models": "Models", "/articles": "Articles",
  "/2d-illustrations": "2D Illustrations", "/3d-illustrations": "3D Illustrations",
  "/2d-animations": "2D Animations", "/3d-animations": "3D Animations",
  "/2d-games": "2D Games", "/3d-games": "3D Games", "/music": "Music",
};
function RouteTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    const p = "/" + pathname.replace(/^\/+|\/+$/g, "");
    if (p === "/") { document.title = "ArtaQuest — post things that prove themselves"; return; }
    const t = ROUTE_TITLES[p];
    if (t) document.title = `${t} – ArtaQuest`;
  }, [pathname]);
  return null;
}

// Strip the language path prefix (/fa, /ar…) so navigate() — which re-adds the basename —
// targets the right route. Mirrors langBasename(): only strips a first segment that equals
// the server-set current language (never a real route).
function stripLang(pathname: string): string {
  const seg = (pathname.split("/")[1] || "").toLowerCase();
  const w = window as unknown as { AQ_I18N?: { current?: string } };
  const lang = (w.AQ_I18N?.current || document.documentElement.lang || "en").toLowerCase().split("-")[0];
  return seg && lang !== "en" && seg === lang ? "/" + pathname.split("/").slice(2).join("/") : pathname;
}

// Allow-list of React-routable paths (locale prefix already stripped). Anything NOT matched
// here — the WP-served lesson player /courses/<slug>/<id>, /my-account, /wishlist, /wp-*,
// WC order endpoints, externals — is intentionally excluded so it FULL-LOADS as before. An
// allow-list is fail-safe: an unrecognised internal link keeps today's behaviour, never breaks.
// MUST mirror the <Route> table below — every entry here has a real React page. /topics (the
// restored topic atlas, a real WP page carrying [aq_app]) and /lab (a private soft path the app
// template serves 200) are SPA-routed; the RETIRED slugs — /typology, /outreach, /explore,
// /typologies … — are intentionally EXCLUDED so a bookmarked/legacy link full-loads and the server
// 301s it to its replacement (the SPA also has a <Navigate> fallback).
// Other WP-served content pages (/reserve, /data, /careers, /issues, /pricing, /enroll, /cart)
// stay excluded so their links full-load and the server renders the right page.
const STATIC_ROUTES = new Set([
  "/", "/about", "/wallet", "/faq-contact", "/developers",
  "/my-library", "/library", "/ceo",
  "/user-account", "/login", "/donate", "/messages", "/meet", "/calendar", "/book",
  "/finances",
  "/sponsors", "/offline", "/studio", "/console", "/fearometer",
  "/works", "/challenges", "/rankings", "/topics", "/lab",
  "/surveys", "/datasets", "/models", "/articles",
  "/2d-illustrations", "/3d-illustrations", "/2d-animations", "/3d-animations", "/2d-games", "/3d-games",
  "/music",
  // legacy kind paths — SPA-routed so the <Navigate> redirects below can catch them
  "/playlists", "/books", "/animations", "/presentations", "/illustrations", "/papers", "/games",
]);
function isReactRoute(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (STATIC_ROUTES.has(p)) return true;
  if (/^\/u\/[^/]+$/.test(p)) return true;                    // profile
  // A feed notebook: id + optional slug, and either read as the page or as the JupyterBook
  // (/nb/12/book AND /nb/12/some-slug/book — the slug form was missing, so "Read the notebook as
  // a book" full-reloaded the whole SPA on every click).
  if (/^\/meet\/\d+$/.test(p)) return true;                 // one ArtaMeet meeting
  if (/^\/nb\/\d+(\/[^/]+)?(\/book)?$/.test(p)) return true;
  if (/^\/studio\/nb\/\d+(\/edit)?$/.test(p)) return true;       // the Studio editor for one notebook
  return false;
}

// Progressive enhancement: the shell + pages keep real <a href> links (good for SEO, no-JS,
// open-in-new-tab, and crawlability), and this intercepts plain left-clicks on internal,
// React-routable links to navigate client-side instead of full-reloading the SPA on every
// click. Modified clicks (cmd/ctrl/shift/alt, middle/right), target=_blank, download, and
// non-React destinations all fall through to the browser. Also handles SPA scroll + focus
// reset on client route changes (WCAG 2.4.x focus management).
function ClientNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download") || a.dataset.native != null) return;
      let url: URL;
      try { url = new URL(a.href, window.location.href); } catch { return; }
      if (url.origin !== window.location.origin) return;          // external
      // Same-page hash anchor (#section) → let the browser scroll to it natively; react-router's
      // navigate() changes the URL hash WITHOUT scrolling, which silently breaks in-page anchors.
      if (url.hash && url.pathname === window.location.pathname) return;
      const path = stripLang(url.pathname);
      if (!isReactRoute(path)) return;                            // lesson player / WC / wp-* → full load
      // Stash the page being left so client-nav-aware pages (e.g. Issues' "where" prefill) know where
      // the user came from — SPA navigation doesn't update document.referrer.
      try { sessionStorage.setItem("aq_from", window.location.pathname + window.location.search); } catch { /* storage blocked */ }
      e.preventDefault();
      navigate(path + url.search + url.hash);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [navigate]);
  // Skip the first render (server SEO + initial mount own the scroll/focus); only client
  // route changes reset scroll to top and move focus to the page heading for screen readers.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    // Reset to the top of the new route. On mobile the nav sits in a drawer that locks page scroll with
    // body `overflow:hidden`; that lock is released by AppShell's SIBLING effect, which (ClientNav being
    // the earlier sibling) flushes AFTER this one — so a single synchronous scrollTo here fires while the
    // lock is still engaged, where iOS silently ignores it. The pre-menu offset then persists when the
    // lock lifts a frame later, stranding the member on the PREVIOUS page's footer instead of the new
    // page's top (ticket #15). Fix: reset now (instant on desktop, no flicker) AND re-assert on the next
    // frame, once the lock is released and the page re-laid-out, so the reset is independent of effect
    // ordering. All a no-op on desktop and whenever the page is already at the top.
    const toTop = () => { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; };
    toTop();
    requestAnimationFrame(toTop);
    const h = document.querySelector("#aq-app-root h1") as HTMLElement | null;
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }, [pathname]);
  return null;
}

/**
 * Catches a failed route load so a missing piece NEVER blanks the whole app — the #1 cause of the
 * "most pages stay black offline" report. Each page is a separate lazy-loaded chunk; offline, a chunk
 * the device hasn't cached yet rejects its dynamic import, React re-throws it during render, and with
 * no boundary the ENTIRE tree (nav included) unmounts to a black screen. This boundary sits INSIDE
 * AppShell, so the header/nav stay on screen and the user can move elsewhere, and it shows a plain,
 * recoverable message instead of nothing. `key`ed on the path so navigating away clears the error.
 * Reload re-fetches the chunk (online) or serves it from cache once the offline precache has finished.
 */
class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; offline: boolean }> {
  state = { failed: false, offline: typeof navigator !== "undefined" && !navigator.onLine };
  static getDerivedStateFromError() {
    return { failed: true, offline: typeof navigator !== "undefined" && !navigator.onLine };
  }
  // A route chunk that fails to load is caught HERE (above <Suspense>), so <BootGate> never mounts to
  // lift the boot screen. Drop it now so this recoverable message is shown immediately, not after the
  // 10s safety timer in main.tsx. Idempotent.
  componentDidCatch() { dismissBootScreen(); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto max-w-md px-6 py-20 text-center">
        <p className="text-[17px] font-semibold text-ink">This page isn’t available offline yet</p>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-3">
          {this.state.offline
            ? "You’re offline and this page hasn’t finished downloading. Open it once with a connection (or tap Download app for offline on the Offline page) and it’ll work with no internet after that."
            : "Something interrupted loading this page. Reloading usually fixes it."}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <button type="button" onClick={() => window.location.reload()}
            className="rounded-pill bg-yang px-5 py-2 text-[14px] font-semibold text-on-accent hover:opacity-90">Reload</button>
          <a href={localePath("/offline/")} className="rounded-pill border border-line px-5 py-2 text-[14px] font-semibold text-ink hover:border-yin-light">Offline downloads</a>
        </div>
      </div>
    );
  }
}

// Reset the boundary when the route changes, so a chunk error on one page doesn't stick to the next.
function RouteBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <RouteErrorBoundary key={pathname}>{children}</RouteErrorBoundary>;
}

// Lifts the server boot screen the instant real route content is on the canvas. It sits INSIDE the
// same <Suspense> as <Routes>, so it suspends with them and mounts only once the matched route's lazy
// chunk has loaded and painted — so the branded loader covers the whole chunk-load gap and the visitor
// never sees the bare "Loading…" line flash and the page reflow in beneath it. (This is the VISUAL
// half; the CLS *score* is fixed by the min-h-screen Suspense fallback below keeping that reflow's
// footer below the fold — layout shift is scored by geometry, not occlusion, so hiding it behind the
// loader alone wouldn't help.) Idempotent via lib/boot, so a later client-nav remount is a no-op.
function BootGate() {
  useEffect(() => { dismissBootScreen(); }, []);
  return null;
}

export default function App() {
  return (
    <BrowserRouter basename={langBasename()}>
      <RouteTitle />
      <ClientNav />
      <I18nGate>
      <IdentityGate />
      <AppShell>
        {/* One player for the whole app: mounted ABOVE <Routes>, so navigating between pages never
            unmounts it and the music keeps playing (phone in a pocket, screen locked). */}
        <PlayerProvider>
        <RouteBoundary>
        <Suspense fallback={
          /* Reserve ~a viewport of height while the route's lazy chunk loads, so the footer stays
             BELOW the fold during loading. When the real (taller) page commits, the footer moves
             further off-screen instead of being shoved down from inside the viewport — which is what
             scored as the large layout shift (CLS) when the fallback was one short line and the footer
             sat near the top. Covered visually by the boot screen via <BootGate>. */
          <div role="status" className="grid min-h-screen place-items-center py-20 text-center text-ink-3">Loading…</div>
        }>
        <BootGate />
        <Routes>
          <Route path="/" element={<HomeOrLanding />} />
          {/* /app/ was the old dashboard URL — the dashboard is now home (/). Redirect any
              lingering /app link to the front page (a server-side 301 also lives in aq-app.php). */}
          <Route path="/app" element={<Navigate to="/" replace />} />
          <Route path="/app/*" element={<Navigate to="/" replace />} />
          {/* ── The Notebook Feed (2026-07-13): eleven kinds, one substrate. ── */}
          <Route path="/works" element={<Feed />} />
          <Route path="/works/" element={<Feed />} />
          <Route path="/surveys" element={<Feed initialKind="survey" />} />
          <Route path="/surveys/" element={<Feed initialKind="survey" />} />
          <Route path="/datasets" element={<Feed initialKind="dataset" />} />
          <Route path="/datasets/" element={<Feed initialKind="dataset" />} />
          <Route path="/models" element={<Feed initialKind="model" />} />
          <Route path="/models/" element={<Feed initialKind="model" />} />
          {/* ArtaNews detection pages. News::feed has emitted /news/<slug>/ since 2026-08-02
              and GET news/{slug} serves the row, but no route rendered it — every published
              permalink was a 404. Both spellings, because the emitted url carries a trailing
              slash and React Router does not treat the two as one. */}
          {/* Bare /news has no index of its own — the detections live in the feed's rail, which
              is where every link to them comes from. The WP page exists only so the top-level
              slug is real and prod cannot guess-redirect the family away. */}
          <Route path="/news" element={<Navigate to="/" replace />} />
          <Route path="/news/" element={<Navigate to="/" replace />} />
          <Route path="/news/:slug" element={<NewsDetection />} />
          <Route path="/news/:slug/" element={<NewsDetection />} />
          <Route path="/articles" element={<Feed initialKind="article" />} />
          <Route path="/articles/" element={<Feed initialKind="article" />} />
          <Route path="/2d-illustrations" element={<Feed initialKind="illustration2d" />} />
          <Route path="/2d-illustrations/" element={<Feed initialKind="illustration2d" />} />
          <Route path="/3d-illustrations" element={<Feed initialKind="illustration3d" />} />
          <Route path="/3d-illustrations/" element={<Feed initialKind="illustration3d" />} />
          <Route path="/2d-animations" element={<Feed initialKind="animation2d" />} />
          <Route path="/2d-animations/" element={<Feed initialKind="animation2d" />} />
          <Route path="/3d-animations" element={<Feed initialKind="animation3d" />} />
          <Route path="/3d-animations/" element={<Feed initialKind="animation3d" />} />
          <Route path="/2d-games" element={<Feed initialKind="game2d" />} />
          <Route path="/2d-games/" element={<Feed initialKind="game2d" />} />
          <Route path="/3d-games" element={<Feed initialKind="game3d" />} />
          <Route path="/3d-games/" element={<Feed initialKind="game3d" />} />
          {/* Music is a real hub again (operator 2026-07-26) — the /articles 301 it wore while it
              was folded into Article is gone; a live shelf must never redirect. */}
          <Route path="/music" element={<Feed initialKind="music" />} />
          <Route path="/music/" element={<Feed initialKind="music" />} />
          {/* legacy kind paths (pre-2026-07-22 taxonomy) — permanent homes moved */}
          <Route path="/papers" element={<Navigate to="/articles/" replace />} />
          <Route path="/papers/" element={<Navigate to="/articles/" replace />} />
          <Route path="/illustrations" element={<Navigate to="/2d-illustrations/" replace />} />
          <Route path="/illustrations/" element={<Navigate to="/2d-illustrations/" replace />} />
          <Route path="/animations" element={<Navigate to="/2d-animations/" replace />} />
          <Route path="/animations/" element={<Navigate to="/2d-animations/" replace />} />
          <Route path="/games" element={<Navigate to="/2d-games/" replace />} />
          <Route path="/games/" element={<Navigate to="/2d-games/" replace />} />
          <Route path="/playlists" element={<Navigate to="/articles/" replace />} />
          <Route path="/playlists/" element={<Navigate to="/articles/" replace />} />
          <Route path="/books" element={<Navigate to="/articles/" replace />} />
          <Route path="/books/" element={<Navigate to="/articles/" replace />} />
          <Route path="/presentations" element={<Navigate to="/articles/" replace />} />
          <Route path="/presentations/" element={<Navigate to="/articles/" replace />} />
          {/* The book routes come FIRST: /nb/12/book would otherwise match /nb/:id/:slug and
              open the work page with slug="book". */}
          <Route path="/nb/:id/book" element={<NotebookBook />} />
          <Route path="/nb/:id/book/" element={<NotebookBook />} />
          <Route path="/nb/:id/:slug/book" element={<NotebookBook />} />
          <Route path="/nb/:id/:slug/book/" element={<NotebookBook />} />
          <Route path="/nb/:id" element={<NotebookPage />} />
          <Route path="/nb/:id/" element={<NotebookPage />} />
          <Route path="/nb/:id/:slug" element={<NotebookPage />} />
          <Route path="/nb/:id/:slug/" element={<NotebookPage />} />
          <Route path="/lab" element={<Lab />} />
          <Route path="/lab/" element={<Lab />} />
          <Route path="/studio" element={<NotebookStudio />} />
          <Route path="/studio/" element={<NotebookStudio />} />
          <Route path="/studio/nb/:id" element={<NotebookStudio />} />
          <Route path="/studio/nb/:id/" element={<NotebookStudio />} />
          <Route path="/studio/nb/:id/edit" element={<NotebookStudio />} />
          <Route path="/studio/nb/:id/edit/" element={<NotebookStudio />} />
          <Route path="/console" element={<ConsolePage />} />
          <Route path="/console/" element={<ConsolePage />} />
          {/* The standalone forum is retired (2026-07-14): every post carries its OWN discussion
              board — comments live under the work they discuss, like any social platform. */}
          <Route path="/discussions" element={<Navigate to="/works" replace />} />
          <Route path="/discussions/*" element={<Navigate to="/works" replace />} />
          {/* ── Retired surfaces (2026-07-13 feed reset) — every legacy content URL lands on
              the closest feed shelf so old links keep meaning something. ── */}
          <Route path="/courses" element={<Navigate to="/playlists" replace />} />
          <Route path="/courses/*" element={<Navigate to="/playlists" replace />} />
          <Route path="/rankings" element={<Rankings />} />
          <Route path="/rankings/" element={<Rankings />} />
          <Route path="/about" element={<About />} />
          <Route path="/about/" element={<About />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/wallet/" element={<Wallet />} />
          <Route path="/book" element={<Book />} />
          <Route path="/book/" element={<Book />} />
          <Route path="/book/:handle" element={<Book />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/calendar/" element={<Calendar />} />
          <Route path="/meet" element={<Meet />} />
          <Route path="/meet/" element={<Meet />} />
          <Route path="/meet/:id" element={<Meet />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/messages/" element={<Messages />} />
          <Route path="/faq-contact" element={<FaqContact />} />
          <Route path="/faq-contact/" element={<FaqContact />} />
          <Route path="/my-library" element={<MyLibrary />} />
          <Route path="/my-library/" element={<MyLibrary />} />
          <Route path="/developers" element={<Developers />} />
          <Route path="/developers/" element={<Developers />} />
          <Route path="/u/:slug" element={<Profile />} />
          <Route path="/u/:slug/" element={<Profile />} />
          <Route path="/user-account" element={<Account />} />
          <Route path="/user-account/" element={<Account />} />
          {/* The mascot has a profile like any other member — /arta is the character bible. */}
          <Route path="/arta" element={<ArtaProfile />} />
          <Route path="/arta/" element={<ArtaProfile />} />
          <Route path="/login" element={<Login />} />
          <Route path="/login/" element={<Login />} />
          <Route path="/video" element={<Navigate to="/playlists" replace />} />
          <Route path="/video/" element={<Navigate to="/playlists" replace />} />
          <Route path="/lesson" element={<Navigate to="/playlists" replace />} />
          <Route path="/lesson/" element={<Navigate to="/playlists" replace />} />
          <Route path="/donate" element={<Donate />} />
          <Route path="/donate/" element={<Donate />} />
          <Route path="/explore" element={<Navigate to="/works" replace />} />
          <Route path="/explore/" element={<Navigate to="/works" replace />} />
          <Route path="/typologies" element={<Navigate to="/works" replace />} />
          <Route path="/typologies/*" element={<Navigate to="/works" replace />} />
          {/* /topics RESTORED (operator 2026-07-15/16): the seasonal topic atlas — the anchored
              AstroAttention classification, the season cycle, and per-topic square-wave charts. */}
          <Route path="/topics" element={<Fields />} />
          <Route path="/topics/*" element={<Fields />} />
          <Route path="/why" element={<Navigate to="/works" replace />} />
          <Route path="/why/*" element={<Navigate to="/works" replace />} />
          <Route path="/professions" element={<Navigate to="/works" replace />} />
          <Route path="/skills" element={<Navigate to="/works" replace />} />
          <Route path="/fields" element={<Navigate to="/works" replace />} />
          <Route path="/cycles" element={<Navigate to="/works" replace />} />
          <Route path="/astro" element={<Navigate to="/works" replace />} />
          <Route path="/competitions" element={<Navigate to="/datasets" replace />} />
          <Route path="/competitions/*" element={<Navigate to="/datasets" replace />} />
          <Route path="/competition" element={<Navigate to="/datasets" replace />} />
          <Route path="/competition/" element={<Navigate to="/datasets" replace />} />
          <Route path="/research" element={<Navigate to="/papers" replace />} />
          <Route path="/research/*" element={<Navigate to="/papers" replace />} />
          <Route path="/artascience" element={<Navigate to="/papers" replace />} />
          <Route path="/artascience/" element={<Navigate to="/papers" replace />} />
          <Route path="/artasound" element={<Navigate to="/works" replace />} />
          <Route path="/artasound/" element={<Navigate to="/works" replace />} />
          <Route path="/artatranslate" element={<Navigate to="/works" replace />} />
          <Route path="/artatranslate/" element={<Navigate to="/works" replace />} />
          <Route path="/artaillustration" element={<Navigate to="/illustrations" replace />} />
          <Route path="/artaillustration/" element={<Navigate to="/illustrations" replace />} />
          <Route path="/challenges" element={<ChallengesPage />} />
          <Route path="/challenges/" element={<ChallengesPage />} />
          <Route path="/challenges/*" element={<Navigate to="/challenges" replace />} />
          <Route path="/library" element={<Library />} />
          <Route path="/library/" element={<Library />} />
          <Route path="/artaread" element={<ArtaRead />} />
          <Route path="/artaread/" element={<ArtaRead />} />
          <Route path="/read/:id" element={<Navigate to="/books" replace />} />
          <Route path="/read/:id/" element={<Navigate to="/books" replace />} />
          <Route path="/listen/:id" element={<Navigate to="/works" replace />} />
          <Route path="/listen/:id/" element={<Navigate to="/works" replace />} />
          <Route path="/watch/:id" element={<Navigate to="/animations" replace />} />
          <Route path="/watch/:id/" element={<Navigate to="/animations" replace />} />
          <Route path="/films" element={<Navigate to="/animations" replace />} />
          <Route path="/films/" element={<Navigate to="/animations" replace />} />
          <Route path="/film/:id" element={<Navigate to="/animations" replace />} />
          <Route path="/film/:id/" element={<Navigate to="/animations" replace />} />
          <Route path="/illustration/:id" element={<Navigate to="/illustrations" replace />} />
          <Route path="/illustration/:id/" element={<Navigate to="/illustrations" replace />} />
          <Route path="/arena" element={<Navigate to="/games" replace />} />
          <Route path="/arena/" element={<Navigate to="/games" replace />} />
          <Route path="/game/:slug" element={<Navigate to="/games" replace />} />
          <Route path="/game/:slug/" element={<Navigate to="/games" replace />} />
          <Route path="/shop" element={<Navigate to="/works" replace />} />
          <Route path="/shop/*" element={<Navigate to="/works" replace />} />
          <Route path="/sponsors" element={<Grants />} />
          <Route path="/sponsors/" element={<Grants />} />
          {/* Renamed surfaces — client redirects mirror the server 301s (Typology→Topics, Outreach→Grants→Sponsors). */}
          <Route path="/typology" element={<Navigate to="/topics" replace />} />
          <Route path="/typology/" element={<Navigate to="/topics" replace />} />
          <Route path="/grants" element={<Navigate to="/sponsors" replace />} />
          <Route path="/grants/" element={<Navigate to="/sponsors" replace />} />
          <Route path="/outreach" element={<Navigate to="/sponsors" replace />} />
          <Route path="/outreach/" element={<Navigate to="/sponsors" replace />} />
          <Route path="/reserve" element={<Reserve />} />
          <Route path="/reserve/" element={<Reserve />} />
          <Route path="/finances" element={<Finances />} />
          <Route path="/finances/" element={<Finances />} />
          <Route path="/issues" element={<Issues />} />
          <Route path="/issues/" element={<Issues />} />
          {/* /ceo is the canonical URL: a real top-level WP page, so it is a 200 to a crawler and
              short enough to paste into a message. /careers/ceo stays as a guessable alias, but it
              is a soft 404 to search engines — WordPress has no page at that depth. */}
          <Route path="/ceo" element={<CeoRole />} />
          <Route path="/ceo/" element={<CeoRole />} />
          <Route path="/careers/ceo" element={<CeoRole />} />
          <Route path="/careers/ceo/" element={<CeoRole />} />
          <Route path="/careers" element={<Careers />} />
          <Route path="/careers/" element={<Careers />} />
          <Route path="/fearometer" element={<Fearometer />} />
          <Route path="/fearometer/" element={<Fearometer />} />
          <Route path="/data" element={<Data />} />
          <Route path="/data/" element={<Data />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/pricing/" element={<Pricing />} />
          <Route path="/enroll" element={<KeepQuery to="/wallet" />} />
          <Route path="/enroll/" element={<KeepQuery to="/wallet" />} />
          <Route path="/cart" element={<KeepQuery to="/wallet" />} />
          <Route path="/cart/" element={<KeepQuery to="/wallet" />} />
          {/* The Certificate of Participation — every challenge entrant holds one. Both slugs are
              long-standing WP pages already served by the SPA, so neither is a new production route
              (a new slug that PREFIXES an existing WP page 301s on prod only). */}
          <Route path="/certificate" element={<Participation />} />
          <Route path="/certificate/" element={<Participation />} />
          <Route path="/verify" element={<Participation />} />
          <Route path="/verify/" element={<Participation />} />
          <Route path="/offline" element={<OfflinePage />} />
          <Route path="/offline/" element={<OfflinePage />} />
          <Route path="/recommendations" element={<Navigate to="/" replace />} />
          <Route path="/recommendations/" element={<Navigate to="/" replace />} />
          <Route path="/almanac" element={<Navigate to="/" replace />} />
          <Route path="/almanac/" element={<Navigate to="/" replace />} />
          <Route path="*" element={<CatchAll />} />
        </Routes>
        </Suspense>
        </RouteBoundary>
        </PlayerProvider>
      </AppShell>
      {/* ArtaBot is for REGISTERED members only (operator 2026-07-25) — so the launcher never appears
          for a signed-out visitor, which is what keeps it off the landing page. The landing page
          advertises it instead (see Landing), as a reason to sign up. The backend enforces the same
          rule independently: the artabot routes are 'user'-auth, so hiding the UI is not the guard. */}
      {isLoggedIn() && <ArtaBot />}
      <ArtaTTS />
      <OfflineBanner />
      </I18nGate>
    </BrowserRouter>
  );
}
