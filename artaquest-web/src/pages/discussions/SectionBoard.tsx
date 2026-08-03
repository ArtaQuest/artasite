import { SectionBoardView } from "../../components/discussion/SectionBoardView";
import { BackLink, PageHero } from "../../components/ui";
import { DomainGlyph } from "../../components/catalogue";

/* Standalone section discussion board (reachable from the global board) — the SAME board the lesson
   player embeds, minus the video/engagement chrome. Read by everyone; enrol to reply + vote. */
export default function SectionBoard({ lessonId }: { lessonId: number }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-gutter py-8">
      <BackLink href="/discussions?scope=courses">All course discussions</BackLink>
      <PageHero
        eyebrow="Discussions" glyph={<DomainGlyph domain="discussion" />}
        title="Section discussion"
        lede="Watch the section in the course to engage; everyone can read here."
      />
      <SectionBoardView lessonId={lessonId} />
    </div>
  );
}
