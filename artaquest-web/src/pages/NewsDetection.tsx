/**
 * ArtaNews — one detection.
 *
 * The backend has served `GET news/{slug}` since 2026-08-02 and `News::feed` emits a `url` for every
 * row, but nothing rendered it: twenty published permalinks answered 404 because the page half was
 * never built. This is that half.
 *
 * WHAT THIS PAGE IS ALLOWED TO SAY. Instruments detect; humans only contextualise. So the page shows
 * the measurements exactly as the detector reported them, names the product they were read from,
 * gives the retrieval time, and stops. It does not interpret, rank, or imply a cause. The one piece
 * of editorial framing — the summary — comes from the backend, which composes it from the same
 * measured fields.
 *
 * `measures` values arrive ALREADY FORMATTED WITH UNITS, because the units differ per detector.
 * Nothing here re-derives a displayed number from `severity`: severity is a ranking input, and
 * treating it as a display value once published "M6.0 earthquake" for a M2.6 quarry blast.
 *
 * `unknown` is rendered as prominently as the measurements. A detection that did not establish
 * something should say so on the page, not omit it and let the reader assume it was established.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Card, ErrorNote, OrbitRings, PageHero } from "../components/ui";
import { newsDetection, type NewsDetection as Detection } from "../lib/api";
import { localePath } from "../lib/wp";

function whenUTC(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }) + " UTC";
}

export default function NewsDetectionPage() {
  const { slug = "" } = useParams();
  const [d, setD] = useState<Detection | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setD(null); setFailed(false);
    newsDetection(slug).then((r) => { if (live) setD(r); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [slug]);

  useEffect(() => {
    if (d) document.title = `${d.title} – ArtaNews – ArtaQuest`;
  }, [d]);

  if (failed) {
    return (
      <div className="mx-auto max-w-3xl py-16">
        <ErrorNote>
          That detection is not on record. It may have been superseded by a later reading, or the
          link may be mistyped.
        </ErrorNote>
        <p className="mt-4 text-[14px]">
          <a className="text-yin-light hover:underline" href={localePath("/")}>Back to the feed</a>
        </p>
      </div>
    );
  }
  if (!d) return <div className="grid place-items-center py-24"><OrbitRings className="h-10 w-10" /></div>;

  const measures = Object.entries(d.measures || {});
  const place = d.place_label || d.place || d.country;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHero eyebrow="ArtaNews · a measurement, not a story" title={d.title} lede={d.summary} />

      {/* What, when and where, before any number — the instrument itself is named under
          provenance, where its product URL and retrieval time sit with it. */}
      <Card className="p-5">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <div>
            {/* `detector` is the SIGNAL TYPE ("Internet connectivity loss"), not the instrument —
                the instrument is source.name, shown under provenance below. Labelling this
                "Detected by" read as though a phenomenon had detected itself. */}
            <dt className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Signal</dt>
            <dd className="mt-0.5 text-[15px]">{d.detector}</dd>
          </div>
          <div>
            <dt className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Observed</dt>
            <dd className="mt-0.5 text-[15px]">{whenUTC(d.observed)}</dd>
          </div>
          {place ? (
            <div>
              <dt className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Where</dt>
              <dd className="mt-0.5 text-[15px]">{place}</dd>
            </div>
          ) : null}
          {Number.isFinite(d.lat) && Number.isFinite(d.lon) ? (
            <div>
              <dt className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Coordinates</dt>
              <dd className="mt-0.5 font-mono text-[14px]">{d.lat.toFixed(3)}, {d.lon.toFixed(3)}</dd>
            </div>
          ) : null}
        </dl>
      </Card>

      {/* The measurements, exactly as reported. Units are already in the value. */}
      {measures.length > 0 ? (
        <section>
          <h2 className="mb-3 text-[18px] font-semibold">What was measured</h2>
          <Card className="divide-y divide-line/60 p-0">
            {measures.map(([label, value]) => (
              <div key={label} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
                <span className="text-[14px] text-ink-2">{label}</span>
                <span className="text-[15px] font-semibold">{value}</span>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {/* The measured extent, when the detector produced one. The markup IS the visualisation, so a
          crawler reads the coordinates and timestamps as text rather than meeting an opaque image.
          It is backend-generated from the frozen pixel record — never member input — so
          dangerouslySetInnerHTML has a single, controlled source. */}
      {d.svg ? (
        <section>
          <h2 className="mb-3 text-[18px] font-semibold">Measured extent</h2>
          <Card className="overflow-x-auto p-4">
            <div className="min-w-[320px]" dangerouslySetInnerHTML={{ __html: d.svg }} />
          </Card>
        </section>
      ) : null}

      {/* What the instrument did NOT establish, said plainly rather than left out. */}
      {d.unknown ? (
        <section>
          <h2 className="mb-3 text-[18px] font-semibold">What this does not tell us</h2>
          <Card className="p-5">
            <p className="text-[15px] leading-relaxed text-ink-2">{d.unknown}</p>
          </Card>
        </section>
      ) : null}

      {/* Provenance last, and complete: anyone can re-read the same product at the same URL. */}
      <section>
        <h2 className="mb-3 text-[18px] font-semibold">Where this came from</h2>
        <Card className="p-5">
          <p className="text-[15px]">{d.source?.name}</p>
          {d.source?.url ? (
            <p className="mt-2 break-all text-[13px]">
              <a className="text-yin-light hover:underline" href={d.source.url} rel="noreferrer nofollow" target="_blank">
                {d.source.url}
              </a>
            </p>
          ) : null}
          {d.source?.retrieved ? (
            <p className="mt-2 text-[13px] text-ink-3">Retrieved {whenUTC(d.source.retrieved)}</p>
          ) : null}
          {d.confidence ? (
            <p className="mt-3 text-[13px] text-ink-3">
              Confidence as reported by the detector: {d.confidence}
            </p>
          ) : null}
        </Card>
      </section>
    </div>
  );
}
