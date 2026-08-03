import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { localePath } from "../lib/wp";
import {
  getIllustration, generateIllustration, publishIllustration, deleteIllustration,
  type Illustration, type IllustrationRound, ApiError,
} from "../lib/api";
import { Button, Card, StatusNote, Pill, BackLink, LinkButton, cx } from "../components/ui";
import { SharePanel } from "../components/SharePanel";
import { KIND_LABEL, artStateLabel, WorkHeart } from "../components/studio";

function shareUrl(path: string): string {
  const p = localePath(path);
  return typeof window !== "undefined" ? window.location.origin + p : "https://artaquest.com" + p;
}
function fmtWhen(ts: number) { return ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : ""; }

const AXIS_LABEL: Record<string, string> = {
  fidelity: "Brief fidelity", composition: "Composition", craft: "Craft", colour: "Colour & light", purpose: "Purpose fit",
};

/** The public adversarial-improvement history — one card per round: the render, the critic's verbatim
 *  critique, the per-axis rubric scores, and the fix that followed. Open by default (ArtaScience-style
 *  transparency: the attempts ARE the story). */
function Improvements({ rounds }: { rounds: IllustrationRound[] }) {
  if (!rounds.length) return null;
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div>
        <h2 className="text-[18px] font-bold tracking-tight">How it was refined</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-3">
          Every illustration is adversarially improved: an AI critic inspects each render against the brief and directs the next fix.
          The whole loop is public — every attempt, image and critique, across {rounds.length} round{rounds.length > 1 ? "s" : ""}. <a className="font-semibold text-yin-light hover:underline" href={localePath("/artaillustration/")}>How the studio works →</a>
        </p>
      </div>
      <ol className="flex list-none flex-col gap-4">
        {rounds.map((r) => (
          <li key={r.round} className="flex flex-col gap-2 rounded-md border border-line/60 p-3 sm:flex-row sm:gap-4">
            {r.image && (
              <a href={r.image} target="_blank" rel="noreferrer" className="shrink-0" title="Open this round's full-size render">
                <img src={r.image} alt={`Round ${r.round} render`} loading="lazy" className="h-44 w-44 rounded object-cover" />
              </a>
            )}
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-bold text-ink">Round {r.round}</span>
                <Pill>{r.action}</Pill>
                {r.engine && <span className="text-ink-3">{r.engine}</span>}
                {r.critique
                  ? <span className={cx("ml-auto font-semibold", r.verdict === "done" ? "text-yang" : "text-ink-3")}>{r.score}/100 · {r.verdict === "done" ? "passed" : "improve"}</span>
                  : <span className="ml-auto font-semibold text-ink-3">critique pending…</span>}
              </div>
              {r.axes && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(r.axes).map(([k, v]) => (
                    <span key={k} className="rounded-full border border-line bg-space-2/60 px-2 py-0.5 text-[11.5px] text-ink-3">
                      {AXIS_LABEL[k] || k} <b className={cx(v >= 85 ? "text-yang" : "text-ink-2")}>{v}</b>
                    </span>
                  ))}
                </div>
              )}
              {r.critique && <p className="text-[13px] leading-relaxed text-ink-2">{r.critique}</p>}
              {r.prompt && <p className="text-[12px] text-ink-3"><span className="font-semibold uppercase tracking-wide">{r.action === "edit" ? "Fix applied" : "Prompt"}:</span> {r.prompt}</p>}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function OwnerStudio({ art, reload, onDeleted }: { art: Illustration; reload: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const cost = art.cost ?? 2;
  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setErr(""); setBusy(label);
    try { await fn(); if (label === "del") { onDeleted(); return; } reload(); } catch (e) { setErr(e instanceof ApiError ? e.message : "Something went wrong"); } finally { setBusy(""); }
  }, [reload, onDeleted]);
  const working = art.art_state === "queued" || art.art_state === "processing";
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[18px] font-bold tracking-tight">Your art studio</h2>
        <Pill>{artStateLabel(art.status, art.art_state)}</Pill>
      </div>
      {art.brief && <div><p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Your brief</p><p className="whitespace-pre-wrap rounded-md bg-space-2/60 p-3 text-[13px] text-ink-2">{art.brief}</p></div>}
      {err && <StatusNote error>{err}</StatusNote>}
      {working && <StatusNote>The studio is painting and refining your illustration round by round in the background — each round appears below as it lands. This page refreshes automatically (it waits for free GPU capacity, so it can take a while).</StatusNote>}
      {art.art_state === "failed" && <Button onClick={() => act("gen", () => generateIllustration(art.id))} disabled={!!busy}>{busy === "gen" ? "Retrying…" : "Try painting again"}</Button>}
      {!working && art.art_state !== "review" && art.status !== "published" && art.art_state !== "failed" && (
        <Button onClick={() => act("gen", () => generateIllustration(art.id))} disabled={!!busy}>{busy === "gen" ? "Starting…" : "Paint it"}</Button>
      )}
      {art.art_state === "review" && art.status !== "published" && (
        <div className="flex flex-col gap-2 rounded-md border border-yin/30 bg-yin/[0.04] p-4">
          <p className="text-[14px] font-semibold text-ink">Your illustration is ready above</p>
          <p className="text-[12.5px] text-ink-3">
            Publishing makes it public on Illustrations and your profile{art.kind === "cover" && art.book ? <> and sets it as the cover of <strong>“{art.book.title}”</strong></> : null}, and costs <strong>₳{cost}</strong>.
          </p>
          <div className="flex items-center gap-2">
            <Button onClick={() => act("pub", () => publishIllustration(art.id))} disabled={!!busy}>{busy === "pub" ? "Publishing…" : `Publish · ₳${cost}`}</Button>
            <Button variant="outline" onClick={() => act("gen", () => generateIllustration(art.id))} disabled={!!busy}>Repaint from scratch</Button>
          </div>
        </div>
      )}
      <div className="mt-1 border-t border-line pt-3">
        <LinkButton onClick={() => { if (window.confirm("Delete this illustration? This cannot be undone.")) act("del", () => deleteIllustration(art.id)); }} disabled={!!busy} className="text-rose-400">Delete this illustration</LinkButton>
      </div>
    </Card>
  );
}

export default function IllustrationPage() {
  const { id } = useParams();
  const artId = Number(id);
  const nav = useNavigate();
  const [art, setArt] = useState<Illustration | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    getIllustration(artId).then(setArt)
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? "Illustration not found" : "Could not load this illustration"));
  }, [artId]);
  useEffect(() => { if (artId) load(); }, [artId, load]);
  useEffect(() => {
    if (!art || (art.art_state !== "queued" && art.art_state !== "processing")) return;
    const h = setInterval(load, 10000); return () => clearInterval(h);
  }, [art, load]);

  if (err) return <div className="mx-auto w-full max-w-3xl px-4 py-10"><BackLink href={localePath("/illustrations/")}>Back to illustrations</BackLink><StatusNote error className="mt-4">{err}</StatusNote></div>;
  if (!art) return <div role="status" aria-live="polite" className="mx-auto w-full max-w-3xl px-4 py-10 text-ink-3">Loading…</div>;

  const rounds = art.improvements || [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <BackLink href={localePath("/illustrations/")}>Illustrations</BackLink>
      <article className="flex flex-col gap-4">
        <header className="flex flex-col gap-1.5">
          <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-3">ArtaIllustration · {KIND_LABEL[art.kind] || "Artwork"}</p>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-[28px] font-bold leading-tight tracking-tight text-ink">{art.title}</h1>
            {art.status === "published" && <WorkHeart kind="illustration" id={Number(art.id)} authorSlug={art.author?.slug} />}
          </div>
          <p className="text-[14px] text-ink-3">
            {art.author && <>by <Link to={localePath(`/u/${art.author.slug}/`)} className="font-medium text-ink hover:text-yin-ink">{art.author.name}</Link></>}
            {art.book && <> · for <Link to={localePath(`/read/${art.book.id}/`)} className="font-medium text-ink hover:text-yin-ink">“{art.book.title}”</Link></>}
            {art.status === "published" ? <> · {fmtWhen(art.created)}</> : <> · draft preview</>}
          </p>
        </header>
        {art.summary && <p className="text-[15px] leading-relaxed text-ink-2">{art.summary}</p>}
        {art.image
          ? <img src={art.image} alt={art.summary || art.title} className="w-full rounded-card bg-space-2" />
          : <Card className="flex aspect-square items-center justify-center p-6 text-center text-ink-3">{art.is_owner ? "Paint it in your studio below to see it here." : "This illustration isn't available."}</Card>}
        {rounds.length > 0 && (
          <p className="text-[12px] text-ink-3">
            Painted with <span className="font-medium text-ink-3">{art.engine || "open models"}</span> on free community GPUs · refined over {art.rounds || rounds.length} adversarial round{(art.rounds || rounds.length) > 1 ? "s" : ""} · final score {art.score}/100
          </p>
        )}
        {art.status === "published" && (
          <div><SharePanel title={art.title} url={shareUrl(`/illustration/${art.id}/`)} message={`“${art.title}”${art.author ? ` by ${art.author.name}` : ""} — an illustration on ArtaQuest`} image={art.image} /></div>
        )}
      </article>
      <Improvements rounds={rounds} />
      {art.is_owner && <OwnerStudio art={art} reload={load} onDeleted={() => nav(localePath("/illustrations/"))} />}
    </div>
  );
}
