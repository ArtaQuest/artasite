import { useEffect } from "react";
import { Button } from "../components/ui";
import { SearchBox } from "../components/SearchBox";

// Branded React 404 — served for any unknown route (WP sends the 404 status + the app template).
export default function NotFound() {
  // Unknown URLs aren't a known route, so RouteTitle leaves the tab title stale — set one here. Use
  // "404" (universal — no translation needed) so the tab title is correct on EVERY locale, not just
  // English: the i18n title-localiser can't reach a JS-set title string that never renders as text,
  // and it matches the page's own "404" hero.
  useEffect(() => { document.title = "404 – ArtaQuest"; }, []);
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center py-20 text-center">
      <p className="aq-grad text-[clamp(3.5rem,12vw,6rem)] font-extrabold leading-none">404</p>
      <h1 className="mt-2 text-[24px] font-bold tracking-tight">This page drifted out of orbit</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-2">The page you're looking for doesn't exist or has moved. Search for what you need, or get back to something real.</p>
      {/* Search is the most useful recovery action on a dead end — reuse the topbar search. */}
      {/* Auto-focus search on this dedicated recovery page so the visitor can type a query
          immediately (opt-in prop — the topbar SearchBox must NOT steal focus on every page). */}
      <div className="mt-6 flex w-full justify-center"><SearchBox autoFocus /></div>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Button href="/" size="lg">Go home</Button>
        <Button variant="outline" size="lg" href="/courses/" className="text-ink hover:text-yin-light">Browse courses</Button>
      </div>
    </div>
  );
}
