import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { localePath } from "../lib/wp";
import {
  getTrack, generateTrack, publishTrack, deleteTrack, addTrackSource, removeTrackSource,
  type Track, type TrackReview, ApiError,
} from "../lib/api";
import { Button, Card, Field, StatusNote, Pill, BackLink, LinkButton, cx } from "../components/ui";
import { SharePanel } from "../components/SharePanel";
import { WorkHeart } from "../components/studio";

function shareUrl(path: string): string {
  const p = localePath(path);
  return typeof window !== "undefined" ? window.location.origin + p : "https://artaquest.com" + p;
}

function fmtWhen(ts: number) { return ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : ""; }

function Cover({ title, src, className }: { title: string; src?: string; className?: string }) {
  if (src) return <img src={src} alt="" className={cx("h-full w-full object-cover", className)} />;
  const initials = (title.match(/\b\w/g) || []).slice(0, 2).join("").toUpperCase() || "♪";
  return <div className={cx("flex h-full w-full items-center justify-center bg-gradient-to-br from-yang/25 to-yin/25", className)}><span className="text-4xl font-bold text-ink">{initials}</span></div>;
}

function fmtMetric(v: number | number[] | undefined): string {
  return typeof v === "number" ? String(v) : "";
}

/** The measurement chips the critic judged this take by (a subset worth a listener's glance). */
function MetricChips({ m }: { m: Record<string, number | number[]> }) {
  const chips: [string, string][] = [
    ["length", m.seconds != null ? `${fmtMetric(m.seconds)}s` : ""],
    ["clipping", m.clipping_pct != null ? `${fmtMetric(m.clipping_pct)}%` : ""],
    ["silence", m.silence_pct != null ? `${fmtMetric(m.silence_pct)}%` : ""],
    ["dynamics", m.dynamic_range_db != null ? `${fmtMetric(m.dynamic_range_db)} dB` : ""],
  ].filter(([, v]) => v !== "") as [string, string][];
  const curve = Array.isArray(m.rms_db_curve) ? (m.rms_db_curve as number[]) : null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {chips.map(([k, v]) => (
        <span key={k} className="rounded-full bg-space-2/80 px-2 py-0.5 text-[11px] text-ink-3">{k} <strong className="text-ink-2">{v}</strong></span>
      ))}
      {curve && curve.length === 10 && (
        <span className="flex h-5 items-end gap-[2px] rounded bg-space-2/80 px-1.5 py-0.5" title="Loudness arc — ten equal slices of the piece" aria-label="Loudness arc">
          {(() => { const mn = Math.min(...curve), mx = Math.max(...curve), sp = Math.max(1, mx - mn);
            return curve.map((d, i) => <i key={i} className="w-[3px] rounded-sm bg-yin/70" style={{ height: `${Math.round(20 + 80 * ((d - mn) / sp))}%` }} />); })()}
        </span>
      )}
    </div>
  );
}

/** The adversarial improvement rounds (the ArtaScience pattern) — every draft is critiqued, scored and
 *  recomposed until the critic approves or the rounds run out. Public on published work, with each
 *  round's own RECORDING playable, its measurements, and the critic's full report. */
function ImprovementRounds({ reviews }: { reviews: TrackReview[] }) {
  const [open, setOpen] = useState<number | null>(reviews.length ? reviews[reviews.length - 1].round : null);
  if (!reviews.length) return null;
  return (
    <section aria-label="Quality rounds" className="mt-2">
      <h2 className="mb-2 text-[15px] font-semibold uppercase tracking-[0.14em] text-ink-3">Improved over {reviews.length} {reviews.length === 1 ? "round" : "rounds"}</h2>
      <p className="mb-2 text-[12.5px] text-ink-3">
        Before the author heard this, an AI critic measured each take and pushed the studio to do better — the same
        open review loop <Link to={localePath("/artasound/")} className="font-medium text-yin-ink hover:underline">ArtaSound runs in public</Link>.
        Every round is here: the recording it produced, what was measured, and the critic's verdict.
      </p>
      <ul className="flex list-none flex-col gap-1.5">
        {reviews.map((r) => (
          <li key={r.round} className="rounded-md border border-line bg-space-1/40">
            <button type="button" onClick={() => setOpen(open === r.round ? null : r.round)} aria-expanded={open === r.round}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px]">
              <span className="font-medium text-ink">Round {r.round}{r.audio_url ? " · recording" : ""}</span>
              <span className="flex items-center gap-2">
                <Pill className={r.verdict === "approve" ? "text-yang" : ""}>{r.verdict === "approve" ? "Approved" : "Revise"}</Pill>
                <span className="text-ink-3">{r.score}/100</span>
                <span aria-hidden className="text-ink-3">{open === r.round ? "▴" : "▾"}</span>
              </span>
            </button>
            {open === r.round && (
              <div className="border-t border-line px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">
                {r.audio_url && (
                  <audio controls preload="none" src={r.audio_url} aria-label={`Round ${r.round} recording`} className="mb-2 w-full">
                    Your browser can't play this audio. <a href={r.audio_url}>Download the take</a>.
                  </audio>
                )}
                <p className="whitespace-pre-wrap">{r.report}</p>
                {r.scores && Object.keys(r.scores).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.entries(r.scores).map(([k, v]) => (
                      <span key={k} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-3">{k.replace(/_/g, " ")} <strong className="text-ink-2">{v}</strong></span>
                    ))}
                  </div>
                )}
                {r.metrics && <MetricChips m={r.metrics} />}
                {r.model && <p className="mt-2 text-[11.5px] text-ink-3">Critic: {r.model}</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function OwnerStudio({ track, reload }: { track: Track; reload: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const cost = track.cost ?? Math.max(1, Math.ceil(track.seconds / 30));
  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setErr(""); setBusy(label);
    try { await fn(); reload(); } catch (e) { setErr(e instanceof ApiError ? e.message : "Something went wrong"); } finally { setBusy(""); }
  }, [reload]);
  const working = track.track_state === "queued" || track.track_state === "processing";

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[18px] font-bold tracking-tight">Your {track.kind === "audiobook" ? "audiobook" : "music"} studio</h2>
        <Pill>{track.status === "published" ? "Published" : track.track_state === "review" ? "Ready to review" : working ? (track.kind === "audiobook" ? "Narrating…" : "Composing…") : track.track_state === "failed" ? "Failed" : "Draft"}</Pill>
      </div>
      {track.kind !== "audiobook" && track.brief && <Field label="Your brief"><p className="whitespace-pre-wrap rounded-md bg-space-2/60 p-3 text-[13px] text-ink-2">{track.brief}</p></Field>}
      {track.kind !== "audiobook" && <Field label="Inspiration (private — never published)" optional>
        {track.sources && track.sources.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {track.sources.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 rounded-md bg-space-2/60 px-3 py-1.5 text-[13px]">
                <span className="truncate text-ink-2">{s.title}</span>
                {track.status !== "published" && <LinkButton onClick={() => act("rm" + s.id, () => removeTrackSource(track.id, s.id))} disabled={!!busy}>Remove</LinkButton>}
              </li>
            ))}
          </ul>
        ) : <p className="text-[12.5px] text-ink-3">No inspiration files attached.</p>}
        {track.status !== "published" && (
          <div className="mt-2">
            <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) act("add", () => addTrackSource(track.id, f)); if (fileRef.current) fileRef.current.value = ""; }} />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={!!busy}>{busy === "add" ? "Uploading…" : "Add inspiration track"}</Button>
          </div>
        )}
      </Field>}
      {err && <StatusNote error>{err}</StatusNote>}
      {working && (
        <StatusNote>
          {track.kind === "audiobook"
            ? "The studio is narrating your audiobook, a batch of sentences at a time — long books take a while. "
            : "The studio is composing your track and improving it over several critique rounds. "}
          {track.progress ? <strong>{track.progress}. </strong> : null}
          This page refreshes automatically.
        </StatusNote>
      )}
      {track.track_state === "failed" && <Button onClick={() => act("gen", () => generateTrack(track.id))} disabled={!!busy}>{busy === "gen" ? "Retrying…" : "Try again"}</Button>}
      {!working && track.track_state !== "review" && track.status !== "published" && track.track_state !== "failed" && (
        <Button onClick={() => act("gen", () => generateTrack(track.id))} disabled={!!busy}>{busy === "gen" ? "Starting…" : track.kind === "audiobook" ? "Record the audiobook" : "Compose the track"}</Button>
      )}
      {track.track_state === "review" && track.status !== "published" && (
        <div className="flex flex-col gap-2 rounded-md border border-yin/30 bg-yin/[0.04] p-4">
          <p className="text-[14px] font-semibold text-ink">Your draft is ready to hear above</p>
          <p className="text-[12.5px] text-ink-3">Publishing makes it public on Music and your profile, and costs <strong>₳{cost}</strong>.</p>
          <div className="flex items-center gap-2">
            <Button onClick={() => act("pub", () => publishTrack(track.id))} disabled={!!busy}>{busy === "pub" ? "Publishing…" : `Publish · ₳${cost}`}</Button>
            <Button variant="outline" onClick={() => act("gen", () => generateTrack(track.id))} disabled={!!busy}>{track.kind === "audiobook" ? "Re-record" : "Recompose"}</Button>
          </div>
        </div>
      )}
      <div className="mt-1 border-t border-line pt-3">
        <LinkButton onClick={() => { if (window.confirm(`Delete this ${track.kind === "audiobook" ? "audiobook" : "track"}? This cannot be undone.`)) act("del", () => deleteTrack(track.id)); }} disabled={!!busy} className="text-rose-400">Delete this {track.kind === "audiobook" ? "audiobook" : "track"}</LinkButton>
      </div>
    </Card>
  );
}

export default function Listen() {
  const { id } = useParams();
  const trackId = Number(id);
  const nav = useNavigate();
  const [track, setTrack] = useState<Track | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    getTrack(trackId).then((t) => { if ((t as unknown as { status?: string }).status === "removed") { nav(localePath("/music/")); return; } setTrack(t); })
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? "Track not found" : "Could not load this track"));
  }, [trackId, nav]);
  useEffect(() => { if (trackId) load(); }, [trackId, load]);
  useEffect(() => {
    if (!track || (track.track_state !== "queued" && track.track_state !== "processing")) return;
    const h = setInterval(load, 8000); return () => clearInterval(h);
  }, [track, load]);

  if (err) return <div className="mx-auto w-full max-w-3xl px-4 py-10"><BackLink href={localePath("/music/")}>Back to music</BackLink><StatusNote error className="mt-4">{err}</StatusNote></div>;
  if (!track) return <div role="status" aria-live="polite" className="mx-auto w-full max-w-3xl px-4 py-10 text-ink-3">Loading…</div>;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <BackLink href={localePath("/music/")}>Music</BackLink>
      <article className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="h-40 w-40 shrink-0 overflow-hidden rounded-card bg-space-2 shadow-lg"><Cover title={track.title} src={track.cover} /></div>
          <header className="flex flex-col gap-1.5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-3">ArtaSound · {track.kind === "audiobook" ? "Audiobook" : "Track"}</p>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h1 className="text-[28px] font-bold leading-tight tracking-tight text-ink">{track.title}</h1>
              {track.status === "published" && <WorkHeart kind={track.kind === "audiobook" ? "audiobook" : "music"} id={Number(track.id)} authorSlug={track.author?.slug} />}
            </div>
            {track.author && <p className="text-[14px] text-ink-3">by <Link to={localePath(`/u/${track.author.slug}/`)} className="font-medium text-ink hover:text-yin-ink">{track.author.name}</Link> · {track.length}{track.status === "published" ? <> · {fmtWhen(track.created)}</> : <> · draft preview</>}</p>}
          </header>
        </div>
        {track.summary && <p className="text-[15px] leading-relaxed text-ink-2">{track.summary}</p>}
        {track.audio_url
          ? <div className="flex flex-col gap-2">
              <audio controls preload="metadata" src={track.audio_url} aria-label={`Play “${track.title}”`} className="w-full">Your browser can't play this audio. <a href={track.audio_url}>Download</a>.</audio>
              <a href={track.audio_url} download className="self-start text-[12.5px] font-medium text-ink-3 hover:text-yin-ink">↓ Download MP3</a>
            </div>
          : <Card className="p-6 text-center text-ink-3">{track.is_owner ? "Compose the track in your studio below to hear it here." : "This track isn't available."}</Card>}
        {track.status === "published" && (
          <div><SharePanel title={track.title} url={shareUrl(`/listen/${track.id}/`)}
            message={`“${track.title}”${track.author ? ` by ${track.author.name}` : ""} — a track on ArtaQuest`} image={track.cover} /></div>
        )}
        {track.kind !== "audiobook" && track.lyrics && track.lyrics.trim() && (
          <section aria-label="Lyrics" className="mt-2">
            <h2 className="mb-2 text-[15px] font-semibold uppercase tracking-[0.14em] text-ink-3">Lyrics</h2>
            <div className="rounded-card border border-line bg-space-1/40 p-5">
              {track.lyrics.trim().split(/\n{2,}/).map((stanza, i) => (
                <p key={i} className={cx("whitespace-pre-line text-[15px] leading-[1.7] text-ink-2", i > 0 && "mt-4")}>
                  {stanza.split("\n").map((line, j) => {
                    const tag = /^\[.+\]$/.test(line.trim());
                    return <span key={j} className={cx("block", tag && "mt-1 text-[12.5px] font-semibold uppercase tracking-wide text-yin-ink")}>{line}</span>;
                  })}
                </p>
              ))}
            </div>
          </section>
        )}
        {track.kind === "audiobook" && track.manuscript && track.manuscript.trim() && (
          <section aria-label="The text" className="mt-2">
            <h2 className="mb-2 text-[15px] font-semibold uppercase tracking-[0.14em] text-ink-3">The text</h2>
            <div className="max-h-[28rem] overflow-y-auto rounded-card border border-line bg-space-1/40 p-5">
              {track.manuscript.trim().split(/\n{1,}/).map((para, i) => (
                <p key={i} className={cx("text-[15px] leading-[1.8] text-ink-2", i > 0 && "mt-3")}>{para}</p>
              ))}
            </div>
          </section>
        )}
        {track.reviews && track.reviews.length > 0 && <ImprovementRounds reviews={track.reviews} />}
      </article>
      {track.is_owner && <OwnerStudio track={track} reload={load} />}
    </div>
  );
}
