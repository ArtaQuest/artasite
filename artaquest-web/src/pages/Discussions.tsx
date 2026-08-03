import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getDiscussions, isLoggedIn, localePath, postDiscThread, type DiscussionsData } from "../lib/wp";
import { isLorem, loremDiscussions } from "../lib/lorem";
import { Button, Chip, DrillDownFilter, Input, SearchSort, PageHero, Toolbar, EmptyState, ErrorNote, LoadMoreButton, StatusNote } from "../components/ui";
import { ResultGrid, ResultCard, DomainGlyph } from "../components/catalogue";
import { Composer } from "../components/Composer";

const SORTS = [
  { value: "hot", label: "Trending" },
  { value: "votes", label: "Votes" },
  { value: "comments", label: "Comments" },
];

export default function Discussions() {
  const [sp, setSp] = useSearchParams();
  const forum = sp.get("forum") || "general";
  const [data, setData] = useState<DiscussionsData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (isLorem()) { setData(loremDiscussions()); return; } setFailed(false); getDiscussions(forum).then(setData).catch(() => setFailed(true)); }, [forum]);

  const [q, setQ] = useState(sp.get("q") || "");
  const [sort, setSort] = useState("hot");
  const [composeOpen, setComposeOpen] = useState(false);
  const [topicTitle, setTopicTitle] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  function onQuery(v: string) {
    setQ(v);
    const next = new URLSearchParams(sp);
    if (v) next.set("q", v); else next.delete("q");
    setSp(next, { replace: true });
  }
  // "Load more topics" — append the next keyset page of this forum (no OFFSET, no silent truncation).
  function loadMore() {
    if (!data?.next || loadingMore) return;
    setLoadingMore(true);
    getDiscussions(forum, data.next)
      .then((more) => setData((prev) => (prev ? { ...prev, threads: [...prev.threads, ...more.threads], next: more.next } : more)))
      .catch(() => setFailed(true))
      .finally(() => setLoadingMore(false));
  }
  // The body uses the shared <Composer> (Write/Preview + Markdown/LaTeX) — the same composer thread
  // replies use. It owns body/posting/error state; we just supply the title-aware POST + navigate.
  async function postTopic(body: string) {
    const t = topicTitle.trim();
    if (!t) throw new Error("Please add a topic title first.");
    const r = await postDiscThread(forum, t, body);
    window.location.href = localePath(`/discussions/?forum=${encodeURIComponent(forum)}&thread=${encodeURIComponent(r.slug)}`);
  }

  const threads = data?.threads ?? [];
  const needle = q.trim().toLowerCase();
  const matched = needle ? threads.filter((t) => t.title.toLowerCase().includes(needle) || t.author.toLowerCase().includes(needle) || (t.excerpt || "").toLowerCase().includes(needle)) : threads;
  // "hot" keeps the server order (already hotness-ranked); the others re-sort by the available counts.
  const ordered = sort === "votes" ? [...matched].sort((a, b) => b.votes - a.votes) : sort === "comments" ? [...matched].sort((a, b) => b.replies - a.replies) : matched;
  const pinned = ordered.filter((t) => t.pinned);
  const rest = ordered.filter((t) => !t.pinned);
  const title = data?.forum?.title ?? "Discussions";
  const desc = data?.forum?.desc ?? "Quest for the truth — the topics and skills that matter most.";

  return (
    <div className="flex flex-col gap-6 pb-12">
      {/* Forum switcher — rendered through the shared filter (nav/link mode) so it reads identically to
          the catalogue's subject filter. Forums are a single axis (no subtopics), and "Course boards →"
          rides along as a trailing link to the course-discussion picker. */}
      {data && data.forums.length > 0 && (
        <DrillDownFilter
          ariaLabel="Forums"
          options={data.forums.filter((f) => f.slug !== "courses").map((f) => ({ key: f.slug, label: f.title }))}
          group={forum} showAll={false}
          href={(slug) => `/discussions/?forum=${slug}`}
          trailing={<Chip href="/discussions/?scope=courses">Course boards →</Chip>}
        />
      )}

      <PageHero eyebrow="Community" glyph={<DomainGlyph domain="discussion" />} title={title} lede={desc} />

      {composeOpen && isLoggedIn() && (
        <div className="flex flex-col gap-3 rounded-card border border-line bg-space-2 p-4 shadow-card">
          <Input value={topicTitle} onChange={(e) => setTopicTitle(e.target.value)} placeholder="Topic title" maxLength={160} aria-label="Topic title" autoFocus />
          <Composer placeholder="What do you want to discuss? Be clear and specific. Markdown &amp; LaTeX supported." submitLabel="Post topic" minRows={4} maxLength={30000} onSubmit={postTopic} onCancel={() => setComposeOpen(false)} />
        </div>
      )}

      <Toolbar
        sticky
        search={
          <SearchSort placeholder="Search discussions" value={q} onChange={onQuery}
            sort={sort} onSort={setSort} sortOptions={SORTS} sortAriaLabel="Sort topics" />
        }
        trailing={
          isLoggedIn()
            ? <Button onClick={() => setComposeOpen((o) => !o)} aria-expanded={composeOpen} size="sm">+ New topic</Button>
            : <Button href="/login/" size="sm">+ New topic</Button>
        }
        count={data && needle ? `${matched.length} of ${threads.length} topics for “${q.trim()}”` : undefined}
      />

      {failed ? (
        <ErrorNote>Couldn’t load discussions — refresh to try again.</ErrorNote>
      ) : !data ? (
        <StatusNote>Loading…</StatusNote>
      ) : matched.length === 0 ? (
        <EmptyState icon={<DomainGlyph domain="discussion" className="h-6 w-6" />}
          title={needle ? `No topics match “${q.trim()}”` : "No topics yet"}
          body={needle ? "Try a different word, or start a topic of your own." : "Be the first to start a conversation."} />
      ) : (
        <>
          {pinned.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.16em] text-ink-3">Pinned topics</h2>
              <ResultGrid variant="list">
                {pinned.map((t) => <ResultCard key={t.slug} variant="discussion" title={t.title} author={t.author} at={t.last_at} srcLang={t.lang} votes={t.votes} replies={t.replies} pinned topic={forum} href={t.url} />)}
              </ResultGrid>
            </section>
          )}
          {pinned.length > 0 && rest.length > 0 && <h2 className="text-[12px] font-semibold uppercase tracking-[0.16em] text-ink-3">All other topics</h2>}
          <ResultGrid variant="list">
            {rest.map((t) => <ResultCard key={t.slug} variant="discussion" title={t.title} author={t.author} at={t.last_at} srcLang={t.lang} votes={t.votes} replies={t.replies} topic={forum} href={t.url} />)}
          </ResultGrid>
          {data.next != null && !needle && <LoadMoreButton onClick={loadMore} loading={loadingMore} label="Load more topics" />}
        </>
      )}
    </div>
  );
}
