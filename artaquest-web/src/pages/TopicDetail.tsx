import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  SYSTEMS, findSystem, loadTypologies, typologiesReady, statusLabel, systemLearnUrl, emblemUrl, resolveImage,
  CATEGORIES, CATEGORY_GROUPS,
} from "../lib/typologies";
import type { TypologySystem, Citation } from "../lib/typologies";
import { useCourseExists } from "../lib/useCourseExists";
import { localePath } from "../lib/wp";
import { Avatar, Button, Card, LinkButton, EmptyState, SkeletonCard } from "../components/ui";
import { StatusBadge, DomainGlyph, AstroSignature } from "../components/catalogue";

// One reference, rendered identically to the Topics page (a DOI links over a URL; plain text else).
function Reference({ c }: { c: Citation }) {
  const href = c.doi ? `https://doi.org/${c.doi}` : c.url;
  const text = <>{c.authors} ({c.year}). {c.title}{c.venue ? <span className="italic">. {c.venue}</span> : null}</>;
  return (
    <li className="text-[13px] leading-snug text-ink-3">
      {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-yin-light transition-colors hover:text-yang">{text}</a> : <span>{text}</span>}
    </li>
  );
}

// A single group (option) or dimension pole, read-only — its profile picture beside name + description.
function GroupRow({ image, seed, label, sub, desc }: { image?: string; seed: string; label: string; sub?: string; desc: string }) {
  return (
    <li className="flex items-start gap-3 rounded-field border border-line px-3.5 py-2.5">
      <Avatar src={resolveImage(image) || emblemUrl(seed, label)} name={label} alt={label} className="h-9 w-9 text-sm" />
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold text-ink">{label}{sub ? <span className="ms-2 text-[12px] font-normal text-ink-3">{sub}</span> : null}</span>
        {desc && <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">{desc}</span>}
      </span>
    </li>
  );
}

export default function TopicDetail() {
  const { key = "" } = useParams();
  const navigate = useNavigate();
  const [ready, setReady] = useState(typologiesReady());

  useEffect(() => {
    if (ready) return;
    let on = true;
    loadTypologies().then(() => { if (on) setReady(true); });
    return () => { on = false; };
  }, [ready]);

  const sys: TypologySystem | undefined = ready ? findSystem(key) : undefined;

  // If this topic's key was renamed (#141), findSystem resolves the old key via the alias map; replace
  // the URL with the canonical key so the address bar, sharing and the canonical tag all stay correct.
  useEffect(() => { if (sys && sys.key !== key) navigate(localePath(`/typologies/${sys.key}/`), { replace: true }); }, [sys, key, navigate]);

  // Own the document title client-side (the server already set it for crawlers; this keeps it right
  // after client navigation). Mirrors CourseDetail.
  useEffect(() => { if (sys) document.title = `${sys.name} — ArtaQuest`; }, [sys]);

  // The topic's `course` URL is aspirational — only offer "Take the course" once a real course
  // exists at that slug; otherwise fall back to the instructor video / search (ticket #132).
  const courseExists = useCourseExists(sys?.course);

  if (!ready) {
    return <div className="flex flex-col gap-4 pb-16"><SkeletonCard media={false} /><SkeletonCard media={false} /></div>;
  }
  if (!sys) {
    return (
      <div className="pb-16">
        <EmptyState icon={<DomainGlyph domain="topic" className="h-6 w-6" />} title="Topic not found"
          body="That topic doesn’t exist (or its link has changed)." />
        <div className="mt-4"><Button href={localePath("/typologies/")}>Browse all topics</Button></div>
      </div>
    );
  }

  const cat = CATEGORIES.find((c) => c.key === sys.category);
  const group = cat ? CATEGORY_GROUPS.find((g) => g.key === cat.group) : undefined;
  const opts = sys.options ?? [];
  const dims = sys.dimensions ?? [];
  // Trust the curated course link only once confirmed to exist; otherwise behave exactly like a
  // system with no course (instructor video, then search) — the shape systemLearnUrl + label expect.
  const learn = courseExists ? sys : { ...sys, course: undefined };
  // Related topics in the same category (for browsing + internal linking), excluding this one.
  const related = SYSTEMS.filter((s) => s.category === sys.category && s.key !== sys.key).slice(0, 8);

  return (
    <div className="flex flex-col gap-6 pb-20">
      {/* Breadcrumb back to the hub + category. */}
      <nav className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3" aria-label="Breadcrumb">
        <a href={localePath("/typologies/")} className="hover:text-yang">Topics</a>
        {group && <><span aria-hidden>/</span><a href={localePath(`/typologies/?cat=${cat?.key}`)} className="hover:text-yang">{group.label}</a></>}
        {cat && <><span aria-hidden>/</span><span className="text-ink-2">{cat.label}</span></>}
      </nav>

      {/* Hero — the topic's profile picture, name, status, and blurb. */}
      <header className="flex items-start gap-4">
        <Avatar src={resolveImage(sys.image) || emblemUrl(sys.key, sys.name)} name={sys.name} alt={sys.name} className="h-16 w-16 shrink-0 text-2xl" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[24px] font-bold leading-tight tracking-tight text-ink">{sys.name}</h1>
            <StatusBadge label={statusLabel(sys.status)} empirical={sys.status === "empirical"} />
          </div>
          <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-ink-2">{sys.blurb}</p>
          <AstroSignature house={sys.house} sign={sys.sign} className="mt-2" />
          <p className="mt-2 text-[12px] leading-snug text-ink-3"><span className="font-semibold">{statusLabel(sys.status)}.</span> {sys.statusNote}{sys.source ? <span className="text-ink-3/80"> · {sys.source}</span> : null}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
            {sys.author?.slug && (
              <span>Curated by <a href={localePath(`/u/${sys.author.slug}`)} className="font-medium text-yin-light hover:text-yang">{sys.author.name}</a></span>
            )}
            {sys.sponsor?.name && (
              <span className="inline-flex items-center gap-1.5 rounded-pill border border-yang/40 bg-yang/[0.07] px-2.5 py-0.5 font-medium text-yang">
                {sys.sponsor.logo ? <img src={sys.sponsor.logo} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" /> : null}
                Sponsored by {sys.sponsor.url
                  ? <a href={sys.sponsor.url} target="_blank" rel="noopener noreferrer nofollow" className="underline-offset-2 hover:underline">{sys.sponsor.name}</a>
                  : sys.sponsor.name}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Actions: learn from an instructor + stand with this group on the hub. */}
      <div className="flex flex-wrap gap-3">
        <a href={systemLearnUrl(learn)} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-pill border border-yin/40 bg-yin/[0.06] px-4 py-2 text-[14px] font-semibold text-yin-light transition-colors hover:border-yang hover:text-yang">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
          {learn.course ? "Take the course" : learn.instructor ? `Watch ${learn.instructor} explain this` : "Learn this — watch an instructor"}
        </a>
        <Button href={localePath(`/typologies/?q=${encodeURIComponent(sys.key)}`)} className="h-10 px-5 text-[14px]">Stand with a group →</Button>
      </div>

      {/* Groups (single/multi) or dimensions (spectrum), each with its profile picture + description. */}
      {opts.length > 0 ? (
        <section>
          <h2 className="mb-2.5 text-[15px] font-bold tracking-tight text-ink">The {opts.length} groups</h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {opts.map((o) => <GroupRow key={o.key} image={o.image} seed={o.key} label={o.label} sub={o.short && o.short !== o.label ? o.short : undefined} desc={o.desc} />)}
          </ul>
        </section>
      ) : dims.length > 0 ? (
        <section>
          <h2 className="mb-2.5 text-[15px] font-bold tracking-tight text-ink">The {dims.length} dimensions</h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {dims.map((d) => <GroupRow key={d.key} image={d.image} seed={d.key} label={d.name} sub={`${d.low} – ${d.high}`} desc={d.desc} />)}
          </ul>
        </section>
      ) : null}

      {/* References — the real papers behind the framework (matches the Topics page). */}
      {sys.citations && sys.citations.length > 0 && (
        <section>
          <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-3">References</h2>
          <ul className="flex flex-col gap-1.5">{sys.citations.map((c, i) => <Reference key={i} c={c} />)}</ul>
        </section>
      )}

      {/* Related topics in the same category — browsing + internal links. */}
      {related.length > 0 && (
        <section>
          <h2 className="mb-2.5 text-[15px] font-bold tracking-tight text-ink">Related topics</h2>
          <div className="flex flex-wrap gap-2">
            {related.map((r) => (
              <a key={r.key} href={localePath(`/typologies/${r.key}/`)}
                className="inline-flex items-center gap-2 rounded-pill border border-line py-1 ps-1.5 pe-3 text-[13px] text-ink-2 transition-colors hover:border-yin-light/40 hover:text-ink">
                <Avatar src={resolveImage(r.image) || emblemUrl(r.key, r.name)} name={r.name} alt="" className="h-6 w-6 text-[11px]" />
                {r.name}
              </a>
            ))}
          </div>
        </section>
      )}

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <span className="text-[13.5px] text-ink-2">Explore every framework people use to understand who they are.</span>
        <LinkButton onClick={() => { window.location.href = localePath("/typologies/"); }} className="text-[13px] font-semibold">All topics →</LinkButton>
      </Card>
    </div>
  );
}
