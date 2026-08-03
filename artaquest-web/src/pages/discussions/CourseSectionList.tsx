import { useEffect, useState } from "react";
import { getCourseSections, localePath, type CourseSections } from "../../lib/wp";
import { BackLink, PageHero, StatusNote } from "../../components/ui";
import { DomainGlyph } from "../../components/catalogue";

/* One course's section boards — each links to its standalone discussion board. */
export default function CourseSectionList({ courseId }: { courseId: number }) {
  const [c, setC] = useState<CourseSections | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { getCourseSections(courseId).then(setC).finally(() => setLoading(false)); }, [courseId]);

  if (loading) return <div className="mx-auto max-w-3xl px-gutter py-12"><StatusNote>Loading…</StatusNote></div>;
  if (!c) return <div className="mx-auto max-w-3xl px-gutter py-12"><StatusNote error>Course not found.</StatusNote></div>;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-gutter py-8">
      <BackLink href="/discussions?scope=courses">All course discussions</BackLink>
      <PageHero
        eyebrow="Discussions" glyph={<DomainGlyph domain="discussion" />}
        title={<span data-ay-skip="1">{c.title}</span>}
        lede="Each video has its own board — open to read, enrol to reply and vote."
      />
      {c.lessons.length === 0 ? (
        <StatusNote>This course has no videos yet.</StatusNote>
      ) : (
        <ul className="list-none divide-y divide-line/60 overflow-hidden rounded-card border border-line">
          {c.lessons.map((l, i) => (
            <li key={l.id}>
              <a href={localePath(`/discussions?section=${l.id}`)} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-veil/5">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line text-[13px] text-ink-3">{l.complete ? "✓" : i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[15px] text-ink-2" data-ay-skip="1">{l.title}</span>
                {l.comments > 0 && (
                  <span className="flex shrink-0 items-center gap-1 rounded-pill bg-yin/15 px-2 py-0.5 text-[12px] font-semibold text-yin-light" title={`${l.comments} comments`}>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M21 11.5a8.4 8.4 0 0 1-9.4 8.3L3 21l1.2-3.6A8.4 8.4 0 1 1 21 11.5Z" /></svg>
                    {l.comments}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
