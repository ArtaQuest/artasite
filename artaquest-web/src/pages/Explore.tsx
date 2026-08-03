import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useCatalogueSearch } from "../lib/useCatalogueSearch";
import type { SearchCourse, SearchTopic, SearchGroupHit, SearchGrant, SearchDiscussion, SearchCause } from "../lib/api";
import { PageHero, Toolbar, Tabs, EmptyState, SkeletonGrid, ErrorNote, SearchIcon, SearchPill, OrbitRings } from "../components/ui";
import { ResultGrid, ResultCard, ResultSection, DomainGlyph, type Domain } from "../components/catalogue";

/** The five searchable domains, in the order they appear as tabs and "All" sections. */
const DOMAINS = [
  { key: "courses", label: "Courses", glyph: "course", page: "/courses" },
  { key: "topics", label: "Topics", glyph: "topic", page: "/topics" },
  { key: "groups", label: "Groups", glyph: "group", page: "/topics" },
  { key: "grants", label: "Sponsors", glyph: "grant", page: "/sponsors" },
  { key: "discussions", label: "Discussions", glyph: "discussion", page: "/discussions" },
  { key: "causes", label: "Causes", glyph: "cause", page: "/donate" },
] as const;
type DomainKey = (typeof DOMAINS)[number]["key"];

const gridVariant = (d: DomainKey): "grid" | "rail" | "list" =>
  d === "discussions" ? "list" : d === "courses" ? "rail" : "grid";

/** Map one domain's search rows → the normalised ResultCard. (Items are the per-domain union member.) */
function renderDomain(key: DomainKey, items: unknown[]): ReactNode[] {
  switch (key) {
    case "courses": return (items as SearchCourse[]).map((c) => (
      <ResultCard key={c.id} variant="course" title={c.title} image={c.image}
        lessons={c.lessons} duration={c.duration} commentsPerDay={c.comments_per_day} commentsTotal={c.comments_total} href={`/courses/${c.slug}`} />));
    case "topics": return (items as SearchTopic[]).map((t) => (
      <ResultCard key={t.key} variant="topic" name={t.name} image={t.image} status={t.status} empirical={t.empirical}
        blurb={t.blurb} count={t.count} category={t.category} href={`/topics?q=${encodeURIComponent(t.name)}`} />));
    case "groups": return (items as SearchGroupHit[]).map((g) => (
      <ResultCard key={g.key} variant="group" label={g.label} image={g.image} topic={g.topic} desc={g.desc}
        href={`/topics/${g.topicKey}/`} />));
    case "grants": return (items as SearchGrant[]).map((g) => (
      <ResultCard key={g.id} variant="grant" title={g.title} funder={g.funder} country={g.country}
        amount={g.amount_display} deadline={g.deadline} rolling={g.deadline_type === "rolling" || !g.deadline}
        fit={g.fit} href={`/grants?q=${encodeURIComponent(g.title)}`} />));
    case "discussions": return (items as SearchDiscussion[]).map((t) => (
      <ResultCard key={t.id} variant="discussion" title={t.title} author={t.author} at={t.at} srcLang={t.lang}
        votes={t.score} replies={t.comments} topic={t.topic} href={`/discussions/?forum=${t.topic || "general"}&thread=${t.id}`} />));
    case "causes": return (items as SearchCause[]).map((c) => (
      <ResultCard key={c.key} variant="cause" name={c.name} sub={c.sub} members={c.members} raised={c.raised}
        href={`/donate?cause=${encodeURIComponent(c.key)}`} />));
  }
}

export default function Explore() {
  const [sp, setSp] = useSearchParams();
  const [input, setInput] = useState(sp.get("q") || "");
  const tab = (sp.get("tab") || "all") as "all" | DomainKey;
  const { data, loading, failed } = useCatalogueSearch(input);
  const needle = input.trim();

  useEffect(() => {
    document.title = needle ? `“${needle}” – ArtaQuest` : "Explore – ArtaQuest";
  }, [needle]);

  function patchParam(key: string, val: string) {
    const next = new URLSearchParams(sp);
    if (val) next.set(key, val); else next.delete(key);
    setSp(next, { replace: true });
  }

  const results = data?.results;
  const counts: Record<DomainKey, number> = {
    courses: results?.courses.items.length ?? 0,
    topics: results?.topics.items.length ?? 0,
    groups: results?.groups.items.length ?? 0,
    grants: results?.grants.items.length ?? 0,
    discussions: results?.discussions.items.length ?? 0,
    causes: results?.causes.items.length ?? 0,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const itemsFor = (k: DomainKey): unknown[] => (results ? results[k].items : []);
  const tabs = [{ key: "all", label: "All" }, ...DOMAINS.map((d) => ({ key: d.key, label: d.label }))];

  return (
    <div className="flex flex-col gap-7 pb-12">
      <PageHero
        eyebrow="Catalogue" glyph={<DomainGlyph domain="explore" />}
        title={<>Explore <span className="aq-grad">everything</span></>}
        lede="One search across courses, topics, grants, discussions and the causes you can fund — the whole of ArtaQuest in one place."
        aside={<OrbitRings className="h-[120px] w-[120px] text-ink/70" />}
      />

      <Toolbar
        sticky
        search={
          <SearchPill autoFocus value={input} onChange={(v) => { setInput(v); patchParam("q", v); }}
            placeholder="Search courses, topics, grants, discussions, causes…" className="h-12 w-full px-5" />
        }
        count={data && needle ? `${total} ${total === 1 ? "result" : "results"} for “${needle}”` : undefined}
      />

      {data && needle && (
        <Tabs tabs={tabs} active={tab} onChange={(k) => patchParam("tab", k === "all" ? "" : k)} label="Search domains" />
      )}

      {needle.length < 2 ? (
        <EmptyState
          icon={<DomainGlyph domain="explore" className="h-6 w-6" />}
          title="Search across everything"
          body="Find courses to learn from, frameworks to map yourself, grants to win, conversations to join, and causes to fund — all from one search."
        />
      ) : failed ? (
        <ErrorNote>Couldn't run that search — refresh to try again.</ErrorNote>
      ) : loading && !data ? (
        <SkeletonGrid count={8} />
      ) : data && total === 0 ? (
        <EmptyState
          icon={<SearchIcon size={24} />}
          title={`No results for “${needle}”`}
          body="Try a different word — a topic, a creator, a funder, or a course name."
        />
      ) : data && tab === "all" ? (
        <div className="flex flex-col gap-10">
          {DOMAINS.filter((d) => counts[d.key] > 0).map((d) => (
            <ResultSection
              key={d.key} glyph={<DomainGlyph domain={d.glyph as Domain} className="text-ink-3" />}
              title={d.label} count={counts[d.key]}
              seeAllHref={`${d.page}?q=${encodeURIComponent(needle)}`} seeAllLabel={`See all ${d.label.toLowerCase()}`}
            >
              <ResultGrid variant={gridVariant(d.key)}>{renderDomain(d.key, itemsFor(d.key).slice(0, 4))}</ResultGrid>
            </ResultSection>
          ))}
        </div>
      ) : data ? (
        (() => {
          const d = DOMAINS.find((x) => x.key === tab)!;
          if (counts[d.key] === 0) {
            return (
              <EmptyState icon={<DomainGlyph domain={d.glyph as Domain} className="h-6 w-6" />}
                title={`No ${d.label.toLowerCase()} for “${needle}”`}
                body={<a className="font-semibold text-yang" href={d.page}>Browse all {d.label.toLowerCase()} →</a>} />
            );
          }
          return (
            <div className="flex flex-col gap-5">
              <ResultGrid variant={gridVariant(d.key)}>{renderDomain(d.key, itemsFor(d.key))}</ResultGrid>
              <p className="text-center">
                <a href={`${d.page}?q=${encodeURIComponent(needle)}`} className="text-[14px] font-semibold text-ink-2 transition-colors hover:text-yang">
                  See all {d.label.toLowerCase()} for “{needle}” →
                </a>
              </p>
            </div>
          );
        })()
      ) : null}
    </div>
  );
}
