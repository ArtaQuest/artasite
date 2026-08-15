import { useEffect, useState } from "react";
import { uiLocale, getPage, localePath, type WpPage } from "../lib/wp";
import { StatusNote } from "../components/ui";

// WP REST returns entity-ENCODED title.rendered ("Terms &#038; Conditions"); the <h1> + tab title
// render it as React TEXT, which would show the raw entity. Decode for display only (the single-h1
// dedup below keeps comparing the raw title to the still-encoded content). DOM-safe: textarea
// .innerHTML doesn't execute scripts and the value is then rendered as escaped text.
function decodeEntities(s: string): string {
  if (typeof document === "undefined" || !s.includes("&")) return s;
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}

// Generic content page (careers, FAQ, about, legal, bursaries…) — renders any WP page's
// content as React. Known routes have their own components; everything else lands here.
export default function Page({ id }: { id: number | string }) {
  const [p, setP] = useState<WpPage | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (id) getPage(id).then((r) => (r ? setP(r) : setMissing(true))).catch(() => setMissing(true));
    else setMissing(true);
  }, [id]);
  // Generic pages (legal, bursaries, certificate…) aren't React routes, so RouteTitle doesn't cover
  // them — set the tab title from the loaded page. One fix covers every page that lands here.
  useEffect(() => { if (p?.title) document.title = `${decodeEntities(p.title)} – ArtaQuest`; }, [p?.title]);

  // Generic content page failed to load (bad id / fetch error). Give it real semantics (role=alert,
  // a heading) and a recovery path home, instead of a bare dead-end string.
  if (missing) return (
    <div role="alert" className="mx-auto max-w-md py-20 text-center">
      <h1 className="text-[22px] font-bold tracking-tight">Page not found</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-3">This page couldn’t be loaded. <a href={localePath("/")} className="font-semibold text-yang hover:underline">Go home</a> or try again.</p>
    </div>
  );
  if (!p) return <StatusNote className="py-20">Loading…</StatusNote>;
  // The page title is the sole <h1> (rendered below). WP page content often opens with a heading
  // that just repeats the title — strip that leading duplicate, and demote any other content <h1>
  // to <h2>, so the page has exactly one <h1> (a11y/SEO). Conservative: only strips a leading
  // heading whose plain text equals the title.
  const titleNorm = p.title.trim().toLowerCase();
  const html = p.content
    .replace(/^\s*<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>\s*/i, (m, inner) =>
      inner.replace(/<[^>]+>/g, "").trim().toLowerCase() === titleNorm ? "" : m)
    .replace(/<(\/?)h1(\b)/gi, "<$1h2$2")
    // Internal links in WP page content are raw HTML (dangerouslySetInnerHTML) — localePath them so
    // cross-links (e.g. Terms → Code of Conduct) stay in the visitor's locale instead of dropping to en.
    // Matches relative (/…) AND full same-origin URLs (WP editors often paste absolute links);
    // localePath leaves external/cross-origin URLs untouched, so it's safe to run over all of them.
    .replace(/href="(https?:\/\/[^"]*|\/[^"]*)"/g, (_m, href) => `href="${localePath(href)}"`)
    // WP core adds loading="lazy" to content images but never decoding="async"; this HTML bypasses
    // React's <img>s, so without it any content image (legal diagrams, the reserve chart) decodes on
    // the main thread. Add the hint where absent — off-main-thread decode, never delays load.
    .replace(/<img\b(?![^>]*\sdecoding=)/gi, '<img decoding="async"');
  // Machine-readable last-updated date — a <time> element (a11y + SEO), not a bare string.
  const updated = p.updated ? new Date(p.updated * 1000) : null;
  return (
    <article className="mx-auto max-w-3xl py-4">
      <h1 className="text-[clamp(1.75rem,3vw,2.25rem)] font-bold leading-tight tracking-tight">{decodeEntities(p.title)}</h1>
      {updated ? (
        <p className="mt-2 text-[13px] text-ink-3">Last updated <time dateTime={updated.toISOString()}>{updated.toLocaleDateString(uiLocale(), { year: "numeric", month: "long", day: "numeric" })}</time></p>
      ) : null}
      <div className="aq-prose mt-6 text-[16px] leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
