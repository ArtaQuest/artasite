import { useEffect, useState } from "react";
import { getCourseCards, getCourseTopics, type CourseCard, type CourseTopic } from "../../lib/wp";
import { DrillDownFilter, EmptyState, PageHero, SkeletonGrid } from "../../components/ui";
import { DomainGlyph, ResultCard, ResultGrid } from "../../components/catalogue";

/* The "Courses" scope of the global discussions board: pick a course → its section boards. Browsable
   by the SAME subject houses as the /courses catalogue, through the shared drill-down filter, so the
   discussion surface filters identically to the rest of the site. */
export default function CourseBoards() {
  const [items, setItems] = useState<CourseCard[]>([]);
  const [topics, setTopics] = useState<CourseTopic[]>([]);  // subject houses (+ their subs) with ≥1 published course
  const [topic, setTopic] = useState("");                   // active house slug ("" = all)
  const [subtopic, setSubtopic] = useState("");             // active sub-subject within the house ("" = whole house)
  const [loading, setLoading] = useState(true);

  useEffect(() => { getCourseTopics().then(setTopics); }, []);
  // Re-fetch the boards whenever the house OR sub-subject filter changes (server-side facet, never OFFSET).
  useEffect(() => {
    setLoading(true);
    getCourseCards("", null, 48, undefined, topic || undefined, subtopic || undefined)
      .then((p) => setItems(p.items))
      .finally(() => setLoading(false));
  }, [topic, subtopic]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-7 px-gutter py-8">
      <PageHero
        eyebrow="Discussions" glyph={<DomainGlyph domain="discussion" />}
        title="Course discussions"
        lede="Every course's section boards — read any board, enrol to reply and join the competition."
      />
      {topics.length > 0 && (
        <DrillDownFilter
          ariaLabel="Filter course boards by subject"
          options={topics.map((t) => ({ key: t.slug, label: t.label, count: t.count, children: t.subs?.map((s) => ({ key: s.slug, label: s.label, count: s.count })) }))}
          group={topic} sub={subtopic} onSelect={(g, s) => { setTopic(g); setSubtopic(s); }}
        />
      )}
      {loading ? (
        <SkeletonGrid count={6} />
      ) : items.length === 0 ? (
        <EmptyState icon={<DomainGlyph domain="course" className="h-6 w-6" />} title={topic ? "No course boards in this subject yet" : "No courses yet"}
          body={topic ? "Try another subject, or clear the filter to see every course board." : "Course boards appear here as soon as the first course is published."} />
      ) : (
        <ResultGrid>
          {items.map((c) => (
            <ResultCard key={c.id} variant="course" title={c.title} image={c.image}
              lessons={c.lessons} href={`/discussions?course=${c.id}`} />
          ))}
        </ResultGrid>
      )}
    </div>
  );
}
