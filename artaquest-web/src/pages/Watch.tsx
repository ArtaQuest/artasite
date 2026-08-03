import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { localePath } from "../lib/wp";
import {
  getAnimation, generateAnimation, publishAnimation, deleteAnimation, addAnimationSource, removeAnimationSource,
  type Animation, ApiError,
} from "../lib/api";
import { Button, Card, Field, StatusNote, Pill, BackLink, LinkButton } from "../components/ui";
import { SharePanel } from "../components/SharePanel";
import { WorkHeart } from "../components/studio";

function shareUrl(path: string): string {
  const p = localePath(path);
  return typeof window !== "undefined" ? window.location.origin + p : "https://artaquest.com" + p;
}

function fmtWhen(ts: number) { return ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : ""; }

function OwnerStudio({ anim, reload }: { anim: Animation; reload: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const cost = anim.cost ?? Math.max(1, Math.ceil(anim.seconds / 30)) * 2;
  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setErr(""); setBusy(label);
    try { await fn(); reload(); } catch (e) { setErr(e instanceof ApiError ? e.message : "Something went wrong"); } finally { setBusy(""); }
  }, [reload]);
  const working = anim.anim_state === "queued" || anim.anim_state === "processing";

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[18px] font-bold tracking-tight">Your animation studio</h2>
        <Pill>{anim.status === "published" ? "Published" : anim.anim_state === "review" ? "Ready to review" : working ? "Rendering…" : anim.anim_state === "failed" ? "Failed" : "Draft"}</Pill>
      </div>
      {anim.brief && <Field label="Your brief"><p className="whitespace-pre-wrap rounded-md bg-space-2/60 p-3 text-[13px] text-ink-2">{anim.brief}</p></Field>}
      <Field label="Reference images (private — never published)" optional>
        {anim.sources && anim.sources.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {anim.sources.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 rounded-md bg-space-2/60 px-3 py-1.5 text-[13px]">
                <span className="truncate text-ink-2">{s.title}</span>
                {anim.status !== "published" && <LinkButton onClick={() => act("rm" + s.id, () => removeAnimationSource(anim.id, s.id))} disabled={!!busy}>Remove</LinkButton>}
              </li>
            ))}
          </ul>
        ) : <p className="text-[12.5px] text-ink-3">No reference images attached.</p>}
        {anim.status !== "published" && (
          <div className="mt-2">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) act("add", () => addAnimationSource(anim.id, f)); if (fileRef.current) fileRef.current.value = ""; }} />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={!!busy}>{busy === "add" ? "Uploading…" : "Add reference image"}</Button>
          </div>
        )}
      </Field>
      {err && <StatusNote error>{err}</StatusNote>}
      {working && <StatusNote>The studio is scripting + rendering your animation. This page refreshes automatically — rendering can take several minutes.</StatusNote>}
      {anim.anim_state === "failed" && <Button onClick={() => act("gen", () => generateAnimation(anim.id))} disabled={!!busy}>{busy === "gen" ? "Retrying…" : "Try rendering again"}</Button>}
      {!working && anim.anim_state !== "review" && anim.status !== "published" && anim.anim_state !== "failed" && (
        <Button onClick={() => act("gen", () => generateAnimation(anim.id))} disabled={!!busy}>{busy === "gen" ? "Starting…" : "Render the animation"}</Button>
      )}
      {anim.anim_state === "review" && anim.status !== "published" && (
        <div className="flex flex-col gap-2 rounded-md border border-yin/30 bg-yin/[0.04] p-4">
          <p className="text-[14px] font-semibold text-ink">Your draft is ready to watch above</p>
          <p className="text-[12.5px] text-ink-3">Publishing makes it public on Animations and your profile, and costs <strong>₳{cost}</strong>.</p>
          <div className="flex items-center gap-2">
            <Button onClick={() => act("pub", () => publishAnimation(anim.id))} disabled={!!busy}>{busy === "pub" ? "Publishing…" : `Publish · ₳${cost}`}</Button>
            <Button variant="outline" onClick={() => act("gen", () => generateAnimation(anim.id))} disabled={!!busy}>Re-render</Button>
          </div>
        </div>
      )}
      <div className="mt-1 border-t border-line pt-3">
        <LinkButton onClick={() => { if (window.confirm("Delete this animation? This cannot be undone.")) act("del", () => deleteAnimation(anim.id)); }} disabled={!!busy} className="text-rose-400">Delete this animation</LinkButton>
      </div>
    </Card>
  );
}

export default function Watch() {
  const { id } = useParams();
  const animId = Number(id);
  const nav = useNavigate();
  const [anim, setAnim] = useState<Animation | null>(null);
  const [err, setErr] = useState("");
  const [showScript, setShowScript] = useState(false);
  const load = useCallback(() => {
    getAnimation(animId).then((a) => { if ((a as unknown as { status?: string }).status === "removed") { nav(localePath("/animations/")); return; } setAnim(a); })
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? "Animation not found" : "Could not load this animation"));
  }, [animId, nav]);
  useEffect(() => { if (animId) load(); }, [animId, load]);
  useEffect(() => {
    if (!anim || (anim.anim_state !== "queued" && anim.anim_state !== "processing")) return;
    const h = setInterval(load, 10000); return () => clearInterval(h);
  }, [anim, load]);

  if (err) return <div className="mx-auto w-full max-w-3xl px-4 py-10"><BackLink href={localePath("/animations/")}>Back to animations</BackLink><StatusNote error className="mt-4">{err}</StatusNote></div>;
  if (!anim) return <div role="status" aria-live="polite" className="mx-auto w-full max-w-3xl px-4 py-10 text-ink-3">Loading…</div>;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <BackLink href={localePath("/animations/")}>Animations</BackLink>
      <article className="flex flex-col gap-4">
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-3">ArtaMotion · Animation</p>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-ink">{anim.title}</h1>
          {anim.status === "published" && <WorkHeart kind="animation" id={Number(anim.id)} authorSlug={anim.author?.slug} />}
        </div>
        {anim.author && <p className="text-[14px] text-ink-3">by <Link to={localePath(`/u/${anim.author.slug}/`)} className="font-medium text-ink hover:text-yin-ink">{anim.author.name}</Link> · {anim.length}{anim.status === "published" ? <> · {fmtWhen(anim.created)}</> : <> · draft preview</>}</p>}
        {anim.video_url
          ? <video controls preload="metadata" poster={anim.poster || undefined} src={anim.video_url} aria-label={`Play “${anim.title}”`} className="aspect-video w-full rounded-card bg-black">Your browser can't play this video. <a href={anim.video_url}>Download</a>.</video>
          : <Card className="p-6 text-center text-ink-3">{anim.is_owner ? "Render the animation in your studio below to watch it here." : "This animation isn't available."}</Card>}
        {anim.summary && <p className="text-[15px] leading-relaxed text-ink-2">{anim.summary}</p>}
        {anim.status === "published" && (
          <div><SharePanel title={anim.title} url={shareUrl(`/watch/${anim.id}/`)}
            message={`“${anim.title}”${anim.author ? ` by ${anim.author.name}` : ""} — an explainer on ArtaQuest`} image={anim.poster} /></div>
        )}
        {anim.script && (
          <div className="rounded-card border border-line">
            <button type="button" onClick={() => setShowScript((v) => !v)} className="flex w-full items-center justify-between px-4 py-2.5 text-[13px] font-semibold text-ink-2" aria-expanded={showScript}>
              <span>Manim script (how it was made)</span><span aria-hidden>{showScript ? "▾" : "▸"}</span>
            </button>
            {showScript && <pre className="max-h-[480px] overflow-auto border-t border-line bg-space-1 p-3 font-mono text-[12px] leading-relaxed text-ink-2"><code>{anim.script}</code></pre>}
          </div>
        )}
      </article>
      {anim.is_owner && <OwnerStudio anim={anim} reload={load} />}
    </div>
  );
}
