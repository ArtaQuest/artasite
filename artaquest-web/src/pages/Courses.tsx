import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { localePath, getCourseCards, getCourseTopics, type CourseCard, type CourseCursor, type CourseTopic } from "../lib/wp";
import { isLorem, loremCourses } from "../lib/lorem";
import { CoinMark } from "../lib/currency";
import { PageHero, Toolbar, SearchSort, EmptyState, ErrorNote, SkeletonGrid, LoadMoreButton, OrbitRings, DrillDownFilter } from "../components/ui";
import { ResultGrid, ResultCard, DomainGlyph } from "../components/catalogue";

export default function Courses({ embedded = false }: { embedded?: boolean } = {}) {
  const [sp, setSp] = useSearchParams();
  const [cards, setCards] = useState<CourseCard[] | null>(null);
  const [seasonEnds, setSeasonEnds] = useState(0); // global season close (unix s) — the pool chips countdown
  const [next, setNext] = useState<CourseCursor>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState(sp.get("q") || "");   // seeded from ?q= so Explore's course links prefilter
  const [topics, setTopics] = useState<CourseTopic[]>([]);  // subject facets (houses + their subs) for the filter bar
  const [topic, setTopic] = useState(sp.get("topic") || ""); // active house slug ("" = all); seeded from ?topic=
  const [subtopic, setSubtopic] = useState(sp.get("sub") || ""); // active sub-subject within the house ("" = whole house); seeded from ?sub=
  // Ranking: the catalogue is ordered by Trending (rolling discussion rate) — the default — or Newest.
  const [sortMode, setSortMode] = useState("trending");
  const sortParam = sortMode === "trending" ? "trending" : undefined;

  // The subject facets (one bounded request) — fetched once so the filter bar can render. Each house
  // keeps its stable, recognisable topic-category name straight from the backend (Psychology, Science,
  // Arts, Health, Business …), so a newcomer can browse resources by topic without knowing any specific
  // course name. (Until #153 this relabelled each chip with the live composed "{How} {What}" title the
  // /fields cards + home compass use; on a sparse catalogue that degraded into course-derived astrology
  // names like "Geminian Wimbledon" a newcomer couldn't associate with anything. The identity surfaces
  // keep their composed titles; discovery uses the plain category.) Skipped on the lorem/dev path (no
  // backend); a failure just leaves the bar hidden (getCourseTopics → []).
  useEffect(() => {
    if (isLorem()) return;
    let on = true;
    getCourseTopics().then((t) => { if (on) setTopics(t); });
    return () => { on = false; };
  }, []);

  // Server-side search (debounced) + subject facet so the catalogue scales past the first page; the
  // lorem/dev path stays a static list and is narrowed client-side below. With no search term the list
  // is ranked by the rolling discussion rate (sort="trending"); a search switches to relevance/newest. The
  // topic facet applies in both. Re-runs (and resets to page 1) whenever the query or topic changes.
  useEffect(() => {
    if (isLorem()) { setCards(loremCourses()); setNext(null); return; }
    const term = query.trim();
    let cancelled = false;
    const t = setTimeout(() => {
      getCourseCards(term, null, undefined, sortParam, topic || undefined, subtopic || undefined).then((r) => { if (!cancelled) { setCards(r.items); setNext(r.next); setSeasonEnds(r.seasonEnds ?? 0); setFailed(false); } }).catch(() => { if (!cancelled) setFailed(true); });
    }, term ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, topic, subtopic, sortParam]);

  function onQuery(v: string) {
    setQuery(v);
    const nextp = new URLSearchParams(sp);
    if (v) nextp.set("q", v); else nextp.delete("q");
    setSp(nextp, { replace: true });
  }

  // Pick a house + sub-subject (either "" for all / whole-house) — mirrored into ?topic=&sub= so the
  // full drill-down survives a reload / share. The shared filter always hands back the complete
  // (group, sub) pair: clicking a house clears the sub, clicking "All" clears both.
  function onSelect(group: string, sub: string) {
    setTopic(group); setSubtopic(sub);
    const nextp = new URLSearchParams(sp);
    if (group) nextp.set("topic", group); else nextp.delete("topic");
    if (sub) nextp.set("sub", sub); else nextp.delete("sub");
    setSp(nextp, { replace: true });
  }

  // "Load more" — fetch the next keyset page and APPEND it (the catalogue is built to read-scale to
  // millions of courses; we page with the backend cursor, never OFFSET, and never truncate silently).
  const loadMore = () => {
    if (next == null || loadingMore) return;
    const term = query.trim();
    setLoadingMore(true);
    getCourseCards(term, next, undefined, sortParam, topic || undefined, subtopic || undefined)
      .then((r) => { setCards((prev) => [...(prev ?? []), ...r.items]); setNext(r.next); })
      .catch(() => setFailed(true))
      .finally(() => setLoadingMore(false));
  };

  // The active scope for the count line: the chosen sub-subject if one is picked, otherwise the house.
  const activeTopic = topics.find((t) => t.slug === topic);
  const activeSub = activeTopic?.subs?.find((s) => s.slug === subtopic);
  const scope = activeSub ?? activeTopic;

  const q = query.trim().toLowerCase();
  // The live catalogue is already title-filtered server-side; this also covers the lorem/dev path
  // and gives instant narrowing while a new query's fetch is still in flight.
  const list = (cards ?? []).filter((c) => !q || c.title.toLowerCase().includes(q));

  // Result summary: a search shows the loaded count; a bare subject filter shows the facet's true
  // total (not just the first page); plain trending needs no count line.
  const countText = q
    ? `${list.length} ${list.length === 1 ? "course" : "courses"} for “${query.trim()}”${scope ? ` in ${scope.label}` : ""}`
    : scope
      ? `${scope.count} ${scope.count === 1 ? "course" : "courses"} in ${scope.label}`
      : undefined;

  return (
    /* The catalogue stacks vertically on every breakpoint (ResultGrid variant="grid" → one column on
       phones, a multi-column grid at sm+), so the page is tall throughout and takes the roomy pb-12 —
       matching the Topics and Grants catalogues. It was a single-row horizontal rail on phones until
       ticket #129, where the off-screen cards read as a catalogue chopped off the right edge; stacking
       them is what makes the browse surface fit a small screen. */
    <div className="flex flex-col gap-6 pb-12">
      {!embedded && (
        <PageHero
          eyebrow="Learn" glyph={<DomainGlyph domain="course" />}
          title="Courses"
          lede="Question-driven courses — each a competition for its sharpest questers."
          aside={<OrbitRings className="h-[116px] w-[116px] text-ink/70" />}
        />
      )}
      <p className="flex max-w-2xl items-start gap-1.5 text-[13px] leading-relaxed text-ink-3">
        <CoinMark size={15} className="mt-0.5 shrink-0" />
        <span>Watching is free. Competing costs 1 coin per video — the fee funds the prize pool top questers win. <a href={localePath("/sponsors/")} className="font-semibold text-ink underline-offset-2 hover:underline">Sponsors cover it if it’s a barrier.</a></span>
      </p>

      {/* Search + its own sort control in one shared unit (ticket #152). Ranking: Trending (rolling
          discussion rate) is the default; Newest is the only alternative. */}
      <Toolbar
        sticky
        search={
          <SearchSort
            placeholder="Search courses, creators…" value={query} onChange={onQuery} size="lg"
            sort={sortMode} onSort={setSortMode} sortAriaLabel="Sort courses by"
            sortOptions={[
              { value: "trending", label: "Trending" },
              { value: "newest", label: "Newest" },
            ]}
          />
        }
        count={cards ? countText : undefined}
      />

      {/* Subject filter — the shared two-level drill-down (ticket #89): a strip of house chips with
          course counts, and once a house is picked, a second strip of ITS sub-subjects (the house's
          children, only those with ≥1 course). Identical to the Topics hub and the course-discussion
          boards. Renders on every breakpoint as a phone snap-scroll → wrapping rows at sm+, so it
          can't push the page sideways. Hidden until the facets load (or on the lorem/dev path). */}
      {topics.length > 0 && (
        <DrillDownFilter
          ariaLabel="Filter courses by subject"
          options={topics.map((t) => ({ key: t.slug, label: t.label, count: t.count, children: t.subs?.map((s) => ({ key: s.slug, label: s.label, count: s.count })) }))}
          group={topic} sub={subtopic} onSelect={onSelect}
        />
      )}

      {failed ? (
        <ErrorNote>Couldn’t load courses — refresh to try again.</ErrorNote>
      ) : !cards ? (
        <SkeletonGrid count={8} />
      ) : list.length === 0 ? (
        <EmptyState icon={<DomainGlyph domain="course" className="h-6 w-6" />}
          title={q ? `No courses match “${query.trim()}”` : "No courses yet"}
          body={q ? "Try another topic or a creator's name." : "New courses are on the way — check back soon."} />
      ) : (
        <ResultGrid variant="grid">
          {list.map((c) => (
            <ResultCard key={c.url} variant="course" title={c.title} image={c.image}
              lessons={c.lessons} duration={c.duration_sec} commentsPerDay={c.comments_per_day} commentsTotal={c.comments_total}
              pool={c.pool} seasonEnds={seasonEnds} href={c.url} />
          ))}
        </ResultGrid>
      )}

      {next != null && list.length > 0 && <LoadMoreButton onClick={loadMore} loading={loadingMore} label="Load more courses" />}
    </div>
  );
}
