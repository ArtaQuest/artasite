import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { localePath } from "../lib/wp";
import { getFilm, generateFilm, publishFilm, deleteFilm, type Film, ApiError } from "../lib/api";
import { Button, Card, StatusNote, Pill, BackLink, LinkButton } from "../components/ui";
import { SharePanel } from "../components/SharePanel";
import ReviewRecord from "../components/ReviewRecord";
import { WorkHeart } from "../components/studio";

function shareUrl(path: string): string {
  const p = localePath(path);
  return typeof window !== "undefined" ? window.location.origin + p : "https://artaquest.com" + p;
}
function fmtWhen(ts: number) { return ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : ""; }

function OwnerStudio({ film, reload }: { film: Film; reload: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const cost = film.cost ?? Math.max(1, Math.ceil(film.seconds / 5)) * 2;
  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setErr(""); setBusy(label);
    try { await fn(); reload(); } catch (e) { setErr(e instanceof ApiError ? e.message : "Something went wrong"); } finally { setBusy(""); }
  }, [reload]);
  const working = film.film_state === "queued" || film.film_state === "processing";
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[18px] font-bold tracking-tight">Your film studio</h2>
        <Pill>{film.status === "published" ? "Published" : film.film_state === "review" ? "Ready to review" : working ? "Filming…" : film.film_state === "failed" ? "Failed" : "Draft"}</Pill>
      </div>
      {film.brief && <div><p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Your brief</p><p className="whitespace-pre-wrap rounded-md bg-space-2/60 p-3 text-[13px] text-ink-2">{film.brief}</p></div>}
      {err && <StatusNote error>{err}</StatusNote>}
      {working && <StatusNote>The studio is filming your video scene by scene in the background. This page refreshes automatically — it can take a while (and waits for free GPU capacity).</StatusNote>}
      {film.film_state === "failed" && <Button onClick={() => act("gen", () => generateFilm(film.id))} disabled={!!busy}>{busy === "gen" ? "Retrying…" : "Try filming again"}</Button>}
      {!working && film.film_state !== "review" && film.status !== "published" && film.film_state !== "failed" && (
        <Button onClick={() => act("gen", () => generateFilm(film.id))} disabled={!!busy}>{busy === "gen" ? "Starting…" : "Film it"}</Button>
      )}
      {film.film_state === "review" && film.status !== "published" && (
        <div className="flex flex-col gap-2 rounded-md border border-yin/30 bg-yin/[0.04] p-4">
          <p className="text-[14px] font-semibold text-ink">Your draft is ready to watch above</p>
          <p className="text-[12.5px] text-ink-3">Publishing makes it public on Films and your profile, and costs <strong>₳{cost}</strong>.</p>
          <div className="flex items-center gap-2">
            <Button onClick={() => act("pub", () => publishFilm(film.id))} disabled={!!busy}>{busy === "pub" ? "Publishing…" : `Publish · ₳${cost}`}</Button>
            <Button variant="outline" onClick={() => act("gen", () => generateFilm(film.id))} disabled={!!busy}>Re-film</Button>
          </div>
        </div>
      )}
      <div className="mt-1 border-t border-line pt-3">
        <LinkButton onClick={() => { if (window.confirm("Delete this film? This cannot be undone.")) act("del", () => deleteFilm(film.id)); }} disabled={!!busy} className="text-rose-400">Delete this film</LinkButton>
      </div>
    </Card>
  );
}

export default function FilmPage() {
  const { id } = useParams();
  const filmId = Number(id);
  const nav = useNavigate();
  const [film, setFilm] = useState<Film | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    getFilm(filmId).then((f) => { if ((f as unknown as { status?: string }).status === "removed") { nav(localePath("/films/")); return; } setFilm(f); })
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? "Film not found" : "Could not load this film"));
  }, [filmId, nav]);
  useEffect(() => { if (filmId) load(); }, [filmId, load]);
  useEffect(() => {
    if (!film || (film.film_state !== "queued" && film.film_state !== "processing")) return;
    const h = setInterval(load, 10000); return () => clearInterval(h);
  }, [film, load]);

  if (err) return <div className="mx-auto w-full max-w-3xl px-4 py-10"><BackLink href={localePath("/films/")}>Back to films</BackLink><StatusNote error className="mt-4">{err}</StatusNote></div>;
  if (!film) return <div role="status" aria-live="polite" className="mx-auto w-full max-w-3xl px-4 py-10 text-ink-3">Loading…</div>;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <BackLink href={localePath("/films/")}>Films</BackLink>
      <article className="flex flex-col gap-4">
        <header className="flex flex-col gap-1.5">
          <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-3">ArtaFilm · Film</p>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-[28px] font-bold leading-tight tracking-tight text-ink">{film.title}</h1>
            {film.status === "published" && <WorkHeart kind="film" id={Number(film.id)} authorSlug={film.author?.slug} />}
          </div>
          {film.author && <p className="text-[14px] text-ink-3">by <Link to={localePath(`/u/${film.author.slug}/`)} className="font-medium text-ink hover:text-yin-ink">{film.author.name}</Link> · {film.length}{film.status === "published" ? <> · {fmtWhen(film.created)}</> : <> · draft preview</>}</p>}
        </header>
        {film.summary && <p className="text-[15px] leading-relaxed text-ink-2">{film.summary}</p>}
        {film.video_url
          ? <video controls preload="metadata" poster={film.poster || undefined} src={film.video_url} aria-label={`Play “${film.title}”`} className="aspect-video w-full rounded-card bg-black">Your browser can't play this video. <a href={film.video_url}>Download</a>.</video>
          : <Card className="aspect-video flex items-center justify-center p-6 text-center text-ink-3">{film.is_owner ? "Film it in your studio below to watch it here." : "This film isn't available."}</Card>}
        {film.status === "published" && (
          <div><SharePanel title={film.title} url={shareUrl(`/film/${film.id}/`)} message={`“${film.title}”${film.author ? ` by ${film.author.name}` : ""} — a film on ArtaQuest`} image={film.poster} /></div>
        )}
      </article>
      {film.is_owner && <OwnerStudio film={film} reload={load} />}
      {!!film.reviews?.length && <ReviewRecord reviews={film.reviews} kind="film" />}
    </div>
  );
}
