/**
 * One published work.
 *
 * The page is the WORK, then the EVIDENCE. The artifacts play at the top; below them the
 * reproducibility checklist a stranger can re-run, the three ways to run it, the citation, the
 * published files, and the discussion.
 *
 * NO SOURCE CODE HERE (operator, 2026-07-30). This page used to render the entire notebook inline —
 * a contents rail plus every markdown and code cell — which pushed the checklist and the discussion
 * below a screenful of Python and put the author's working material where the reader's evidence
 * belongs. The source has two better homes, both linked from the reading column: the BOOK
 * (/nb/<id>/<slug>/book), where it reads as a document through ArtaReader, and the LAB (/lab), where
 * it is editable and runnable. The raw .ipynb is still one click away in the citation box.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  deleteComment, editComment, followUser, getNotebook, heartNotebook, nbComment, nbComments, normalizeNbKind, voteComment,
  type NbComment, type NotebookFull,
} from "../lib/api";
import { NB_KIND_META } from "../components/nbview";
import { LibraryMedia, SaveOffline, foldScene, playerBed, sceneSet } from "../components/library";
import { WithRail, RailInline } from "../components/PageRail";
import { WorkEdit, EditLink, DeleteWork } from "../components/WorkEdit";
import { WorkRail } from "../components/WorkRail";
import { fmtBytes } from "../lib/bytes";
import { labRunUrl } from "../lib/pykernel";
import { watchMath } from "../lib/math";
import { ConfirmDialog, Avatar, Button, Chip, EmptyState, HeartGlyph, SectionHeader, Textarea, cx } from "../components/ui";
import { Checklist } from "../components/checklist";
import { isLoggedIn } from "../lib/auth";
import { uiLocale, currentUser } from "../lib/wp";




/**
 * THE WORK ITSELF, PLAYABLE, AT THE TOP (operator 2026-07-28).
 *
 * A reader arrives to hear the track, see the illustration, play the game — not to read about
 * them. So the published files lead the page and are live where they sit: audio and video get real
 * controls, an image renders full width, an HTML deliverable is a sandboxed iframe you can use.
 * Everything below the fold is the evidence for what you just experienced, which is the right way
 * round for a platform whose whole claim is that the artifact is real.
 *
 * Nothing autoplays. The feed is calm by contract and a page that starts making noise breaks that.
 */
function AssetStage({ nb }: { nb: NotebookFull }) {
  const files = nb.files || [];
  if (!files.length) return null;
  // A SCENE work publishes ONE picture as three files — the animated vector, its raster twin and
  // the still poster. It leads the stage as the scene (which is what the fallback chain and the
  // reduced-motion swap are built from), and its twins stay OUT of the grid below: they are the
  // same picture in another format, not another deliverable. Nothing is hidden by that — every
  // file stays listed, sized and downloadable in the Published files panel.
  const scene = sceneSet(files);
  const hero = scene ? scene.scene : files[0];
  // A SONG has the same twin problem as a scene: its player already shows the cover-loop video as
  // the picture, so listing that loop again in the grid printed the same forge shot twice under a
  // hero that was playing it. Folded on the SAME predicate the player renders from (playerBed), so
  // the two can never drift; the file stays listed and downloadable in Published files.
  const bed = hero.class === "audio" ? playerBed(files) : undefined;
  const rest = foldScene(files).filter((f) => f.id !== hero.id && f.id !== bed?.id);
  const heroBox =
    hero.class === "audio" ? "" :
    hero.class === "video" ? "aspect-video" :
    hero.class === "image" ? "" : "aspect-video";

  return (
    <section aria-label="The published work" className="flex flex-col gap-3">
      <div className={cx("overflow-hidden rounded-card border border-line bg-space-2", heroBox)}>
        <LibraryMedia item={hero} files={files} className={hero.class === "audio" ? "p-4" : "h-full w-full"} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
        <span data-ay-skip="1">{hero.label}</span>
        <span data-ay-skip="1">{fmtBytes(hero.bytes)}</span>
        <a href={hero.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-block py-1 text-yin-ink hover:underline">
          Open the file
        </a>
        <SaveOffline item={hero} />
        {files.length > 1 && (
          <span>
            <span data-ay-skip="1">{files.length}</span> published files
          </span>
        )}
      </div>
      {rest.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {rest.map((f) => (
            <li key={f.id} className="flex flex-col gap-1.5">
              <div className="overflow-hidden rounded-card border border-line bg-space-2">
                <LibraryMedia item={f} className={f.class === "audio" ? "p-3" : "h-full w-full"}
                  still={f.class !== "audio" && f.class !== "image"} />
              </div>
              <a href={f.url} target="_blank" rel="noopener noreferrer nofollow" className="block truncate py-1 text-[12px] text-ink-3 hover:text-yin-ink" title={f.name}>
                <span data-ay-skip="1">{f.label}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


/**
 * WHO WROTE IT (operator decision 2026-07-28).
 *
 * Any member may submit any public Kaggle notebook, so the ArtaQuest member on a work is its
 * SUBMITTER and the Kaggle author is its creator. Where they differ, the page says so plainly —
 * silent re-attribution would be the single most dishonest thing this platform could do, and the
 * permanent DOI records the Kaggle author as the creator for the same reason.
 */
function Credit({ nb }: { nb: NotebookFull }) {
  const kg = nb.kaggle;
  if (!kg?.owner) return null;
  // Fall back to the Kaggle HANDLE when the metadata carried no display name: a work with sparse
  // Kaggle metadata must not silently read as the submitter's own.
  const who = (kg.author || "").trim() || kg.owner;
  const same = who.toLowerCase() === nb.author.name.trim().toLowerCase();
  if (same) return null;
  return (
    <p className="rounded-card border border-yin/40 bg-yin/5 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
      <span className="font-semibold text-ink">Written by</span>{" "}
      <a href={`https://www.kaggle.com/${kg.owner}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-yin-ink hover:underline">
        <span data-ay-skip="1">{who}</span>
      </a>{" "}
      on Kaggle. Brought to ArtaQuest by{" "}
      <span className="font-semibold text-ink"><span data-ay-skip="1">{nb.author.name}</span></span>. The citation credits the notebook's author.
    </p>
  );
}

/**
 * THE RECEIPT — the reproducibility checklist, in public (operator order 2026-07-28).
 *
 * This replaced the measured scorecard and the blind review record. It is not a grade: it is the
 * list of facts we read back from Kaggle's public API, with the exact evidence for each one. The
 * author saw this list before they published; a reader sees the same list, unchanged.
 */
function Receipt({ nb }: { nb: NotebookFull }) {
  if (!nb.checks) return null;
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title="How this was checked" />
      {nb.kernel?.url ? (
        <p className="text-[13px] leading-relaxed text-ink-3">
          Read from{" "}
          <a href={nb.kernel.url} target="_blank" rel="noopener noreferrer" className="text-yin-ink hover:underline">
            <span data-ay-skip="1">{nb.kernel.owner}/{nb.kernel.slug}</span>
          </a>
          {" on Kaggle, which answers without a login — so you can re-run every check below yourself."}
        </p>
      ) : null}
      <Checklist checks={nb.checks} />
    </section>
  );
}

function FollowButton({ nb }: { nb: NotebookFull }) {
  const [on, setOn] = useState(nb.following);
  useEffect(() => setOn(nb.following), [nb.following]);
  const me = isLoggedIn();
  if (!me || nb.following === undefined) return null;
  return (
    <button
      type="button"
      onClick={() => { setOn(!on); followUser(nb.author.id, !on).catch(() => setOn(on)); }}
      aria-pressed={on}
      className={cx("inline-flex items-center rounded-pill px-3.5 py-1 text-sm font-semibold transition-colors",
        on ? "border border-line text-ink-2 hover:border-yin-ink" : "bg-yang text-on-accent hover:opacity-90")}
    >
      {on ? "Following" : "Follow"}
    </button>
  );
}

function timeAgo(ts: number) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function CommentRow({ c, nbId, mine, onReply, onDeleted, depth }: { c: NbComment; nbId: number; mine: Set<number>; onReply: (c: NbComment) => void; onDeleted: () => void; depth: number }) {
  const [hearted, setHearted] = useState(mine.has(c.id));
  const [votes, setVotes] = useState(c.votes);
  const [body, setBody] = useState(c.body);
  const [editing, setEditing] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const [draft, setDraft] = useState(c.body);
  // Save and Delete had no .catch: a rejected write (stale nonce, ArtaMod refusal, offline) did
  // nothing visible, so the member pressed the same button again and again against the same wall.
  const [writeErr, setWriteErr] = useState("");
  const own = !!currentUser()?.slug && currentUser()!.slug === c.author.slug;
  const heart = () => {
    if (!isLoggedIn()) { window.location.href = "/login/"; return; }
    const v = hearted ? 0 : 1;
    setHearted(!hearted); setVotes((n) => n + (v ? 1 : -1));
    voteComment(c.id, v as 0 | 1).catch(() => { setHearted(hearted); setVotes(c.votes); });
  };
  return (
    <div className={cx("flex gap-2.5", depth > 0 && "ms-9")}>
      <Link to={`/u/${c.author.slug}`} className="shrink-0 self-start">
        <Avatar name={c.author.name} src={c.author.avatar} className="h-8 w-8 text-[11px]" />
      </Link>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-[13px]">
          <Link to={`/u/${c.author.slug}`} className="font-bold text-ink hover:underline">{c.author.name}</Link>
          <span className="text-ink-3">{timeAgo(c.created)}</span>
        </p>
        {editing ? (
          <div className="mt-1">
            <textarea value={draft} onChange={(e) => setDraft(e.currentTarget.value)} rows={2} maxLength={340}
              className="w-full resize-none rounded-xl border border-line bg-space-1 p-2 text-[14px] text-ink outline-none focus:border-yin-ink" />
            <div className="mt-1 flex gap-3 text-[12px]">
              <button type="button" className="ml-auto text-ink-3 hover:text-ink" onClick={() => { setEditing(false); setDraft(body); }}>Cancel</button>
              <button type="button" className="text-yang-ink font-bold" disabled={draft.trim().length < 2 || draft.length > 280}
                onClick={() => {
                  setWriteErr("");
                  editComment(nbId, c.id, draft.trim())
                    .then((r) => { setBody(r.body); setEditing(false); })
                    .catch((e) => setWriteErr(e instanceof Error && e.message ? e.message : "Couldn't save your edit."));
                }}>Save</button>
            </div>
            {writeErr ? <p role="status" className="mt-1 text-[12px] text-yang">{writeErr}</p> : null}
          </div>
        ) : (
          <p className={cx("mt-0.5 whitespace-pre-wrap text-[14px] leading-relaxed", c.flagged ? "text-ink-3 italic" : "text-ink-2")}>{body}</p>
        )}
        <div className="mt-1 flex items-center gap-4 text-[12px] text-ink-3">
          <button type="button" onClick={heart} aria-pressed={hearted} className={cx("inline-flex items-center gap-1 transition-colors", hearted ? "text-yang" : "hover:text-yang")}>
            <HeartGlyph size={12} filled={hearted} /> {votes > 0 ? votes : ""}
          </button>
          {depth === 0 ? <button type="button" onClick={() => onReply(c)} className="hover:text-ink-2">Reply</button> : null}
          {own ? (
            <>
              <button type="button" onClick={() => setEditing(true)} className="hover:text-ink-2">Edit</button>
              <button type="button" className="hover:text-yang-ink" onClick={() => setAskDelete(true)}>Delete</button>
              <ConfirmDialog
                open={askDelete}
                danger
                title="Delete this reply?"
                confirmLabel="Delete"
                onCancel={() => setAskDelete(false)}
                onConfirm={() => {
                  setAskDelete(false);
                  setWriteErr("");
                  deleteComment(nbId, c.id)
                    .then(onDeleted)
                    .catch((e) => setWriteErr(e instanceof Error && e.message ? e.message : "Couldn't delete that reply."));
                }}
                body={<p>Your reply and any replies beneath it are removed.</p>}
              />
            </>
          ) : null}
        </div>
        {writeErr && !editing ? <p role="status" className="mt-1 text-[12px] text-yang">{writeErr}</p> : null}
      </div>
    </div>
  );
}

export function PostThread({ id, count }: { id: number; count: number }) {
  const [items, setItems] = useState<NbComment[] | null>(null);
  const [mine, setMine] = useState<Set<number>>(new Set());
  const [next, setNext] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<NbComment | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  const load = useCallback((cursor?: number) => nbComments(id, cursor).then((r) => {
    setItems((prev) => (cursor && prev ? [...prev, ...r.items] : r.items));
    setNext(r.next);
    setMine((m) => new Set([...m, ...r.mine]));
  }).catch(() => setItems([])), [id]);
  useEffect(() => { load(); }, [load]);

  const threadBox = useRef<HTMLElement>(null);
  useEffect(() => watchMath(threadBox.current, "auto"), [items]);  // $…$ maths in every reply
  const EMOJI = ["👍", "❤️", "🎉", "🤯", "🔬", "📐", "😂", "🤔"];
  const addEmoji = (e: string) => { setBody((b) => b + e); box.current?.focus(); };
  const send = () => {
    const text = body.trim();
    if (text.length < 2 || busy) return;
    setBusy(true);
    nbComment(id, text, replyTo?.id)
      .then(() => { setBody(""); setReplyTo(null); return load(); })
      .finally(() => setBusy(false));
  };

  return (
    <section id="comments" ref={threadBox} className="flex flex-col gap-4">
      <SectionHeader title={`Comments${count ? ` (${count})` : ""}`} />
      {isLoggedIn() ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-space-2 p-3">
          {replyTo ? (
            <p className="flex items-center gap-2 text-[12px] text-ink-3">
              Replying to <span className="font-semibold text-ink-2">{replyTo.author.name}</span>
              <button type="button" onClick={() => setReplyTo(null)} className="text-yin-ink hover:underline">cancel</button>
            </p>
          ) : null}
          <Textarea ref={box} value={body} onChange={(e) => setBody(e.currentTarget.value)} rows={2} maxLength={340}
            placeholder={replyTo ? "Write your reply…" : "What did this post make you think?"} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="flex gap-1" role="toolbar" aria-label="Insert emoji">
              {EMOJI.map((e) => (
                <button key={e} type="button" onClick={() => addEmoji(e)} aria-label={`Insert ${e}`} style={{ minHeight: 24 }}
                  className="rounded-md px-1 text-[15px] transition-transform hover:scale-125">{e}</button>
              ))}
            </span>
            <p className="hidden text-[11px] text-ink-3 sm:block">$x^2$ for maths · ArtaMod filters only hate and fear</p>
            <span aria-live="polite" className={"ml-auto text-[11px] tabular-nums " + (280 - body.length < 0 ? "font-bold text-yang" : 280 - body.length <= 20 ? "text-yang-ink" : "text-ink-3")}>{280 - body.length}</span>
            <Button size="sm" onClick={send} disabled={busy || body.trim().length < 2 || body.length > 280}>{busy ? "Posting…" : "Reply"}</Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-ink-3"><a href="/login/" className="text-yin-ink hover:underline">Sign in</a> to join the conversation.</p>
      )}
      {items === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-veil/[0.06]" aria-hidden />
      ) : items.length ? (
        <div className="flex flex-col gap-5">
          {items.map((c) => (
            <div key={c.id} className="flex flex-col gap-3">
              <CommentRow c={c} nbId={id} mine={mine} depth={0} onReply={(rc) => { setReplyTo(rc); box.current?.focus(); }} onDeleted={() => load()} />
              {(c.replies || []).map((rep) => <CommentRow key={rep.id} c={rep} nbId={id} mine={mine} depth={1} onReply={() => {}} onDeleted={() => load()} />)}
            </div>
          ))}
          {next != null ? <Button variant="outline" size="sm" className="self-center" onClick={() => load(next)}>More replies</Button> : null}
        </div>
      ) : (
        <p className="text-sm text-ink-3">No replies yet — say the first thing.</p>
      )}
    </section>
  );
}

export default function NotebookPage() {
  const { id } = useParams();
  const [nb, setNb] = useState<NotebookFull | null>(null);
  // Edit happens HERE now, not via the Studio listing (operator 2026-07-31). Ownership is the same
  // test the comment rows already use: the signed-in member's slug against the work's author.
  const [editing, setEditing] = useState(false);
  const [missing, setMissing] = useState(false);
  const [hearts, setHearts] = useState(0);
  const [mine, setMine] = useState(false);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    setNb(null); setMissing(false);
    // A source-only draft has no outputs to lead with, so its code starts unfolded;
    // resetting here also stops one notebook's unfold leaking into the next (the /nb
    // route keeps this element mounted across in-SPA navigations).
    setMine(false);
    getNotebook(Number(id))
      .then((n) => { setNb(n); setHearts(n.hearts); })
      .catch(() => setMissing(true));
  }, [id]);

  const meta = nb ? NB_KIND_META[normalizeNbKind(nb.kind)] : null;

  if (missing) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-16">
        <EmptyState title="No such work" body="It may be a draft (drafts live only in their author's Studio) or it was removed." action={<Button href="/works/">Browse the feed</Button>} />
      </main>
    );
  }
  if (!nb) return <main className="min-h-screen" aria-busy="true" />;

  // Ownership: the same test the comment rows use. Admins also pass server-side (Notebook::can_edit),
  // but the affordance is shown to the author — an admin edits from the Console, not by surprise.
  const own = !!currentUser()?.slug && currentUser()!.slug === nb.author.slug;

  const kgWho = ((nb.kaggle?.author || "").trim() || nb.kaggle?.owner || "").toLowerCase();
  const credited = kgWho !== "" && kgWho !== nb.author.name.trim().toLowerCase();

  const toggleHeart = () => {
    if (!isLoggedIn()) { window.location.href = "/login/"; return; }
    const v = mine ? 0 : 1;
    setMine(!mine); setHearts((h) => h + (v ? 1 : -1));
    heartNotebook(nb.id, v as 0 | 1).then((r) => setHearts(r.hearts)).catch(() => { setMine(mine); setHearts(nb.hearts); });
  };

  return (
    /* NO <main> and NO max-width here. AppShell already wraps every page in
       <main><div className="mx-auto max-w-content px-gutter py-7">, so this used to nest a second
       <main> landmark inside the first and apply gutters twice — which is why the work page's
       column never lined up with any other page's. */
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-ink-3">
          <Link to={meta?.path || "/works"} className="hover:text-ink">{meta?.plural || "Works"}</Link>
          <span aria-hidden>·</span>
          {nb.status === "draft" ? <Chip className="border-yang/50 text-yang-ink">draft — only you can see this</Chip> : null}
          {nb.status === "pending" ? <Chip className="border-yang/50 text-yang-ink">waiting for your email confirmation — only you can see this</Chip> : null}
        </div>
        {editing ? (
          <WorkEdit
            nb={nb}
            onCancel={() => setEditing(false)}
            /* The server answers with the whole updated work, so the page re-renders from the
               RECORD — including a status that may have just moved back to draft. */
            onSaved={(next) => { setNb(next); setEditing(false); }}
          />
        ) : normalizeNbKind(nb.kind) === "article" ? (
          <>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-yang-ink">ArtaQuest Journal</p>
            <h1 className="max-w-3xl font-serif text-3xl font-bold leading-tight text-ink sm:text-4xl">{nb.title}</h1>
            {nb.abstract ? (
              <p className="max-w-3xl border-s-2 border-yang/50 ps-4 text-[15px] leading-relaxed text-ink-2"><span className="font-semibold text-ink">Abstract.</span> {nb.abstract}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <EditLink own={own} onClick={() => setEditing(true)} />
              <DeleteWork own={own} id={nb.id} doi={nb.doi_link} />
            </div>
            <p className="text-[12px] text-ink-3">
              <span data-ay-skip="1">{nb.kaggle?.author || nb.author.name}</span> · published <span data-ay-skip="1">{new Date((nb.published_at || nb.created) * 1000).toLocaleDateString(uiLocale(), { year: "numeric", month: "long", day: "numeric" })}</span>
              {nb.doi_link ? <> · <a href={nb.doi_link} className="inline-block py-1 text-yin-ink hover:underline">{nb.doi_link.replace(/^https?:\/\//, "")}</a></> : null}
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold leading-tight text-ink sm:text-3xl">{nb.title}</h1>
            {nb.abstract ? <p className="max-w-3xl text-sm leading-relaxed text-ink-2">{nb.abstract}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <EditLink own={own} onClick={() => setEditing(true)} />
              <DeleteWork own={own} id={nb.id} doi={nb.doi_link} />
            </div>
          </>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Link to={`/u/${nb.author.slug}`} className="inline-flex items-center gap-2 text-sm text-ink-2 hover:text-ink">
            <Avatar name={nb.author.name} src={nb.author.avatar} className="h-6 w-6 text-[10px]" />
            {nb.author.name}
          </Link>
          {credited ? <span className="text-[12px] text-ink-3">submitted this</span> : null}
          <button
            type="button" onClick={toggleHeart}
            className={cx("inline-flex items-center gap-1.5 rounded-pill border px-3 py-1 text-sm transition-colors",
              mine ? "border-yin bg-yin/15 text-yang" : "border-line text-ink-2 hover:border-yin-ink")}
            aria-pressed={mine}
          >
            <HeartGlyph size={14} filled={mine} /> {hearts}
          </button>
          <FollowButton nb={nb} />
          <button
            type="button"
            onClick={() => {
              const url = `https://artaquest.com/nb/${nb.id}/${nb.slug}/`;
              if (navigator.share) { navigator.share({ title: nb.title, url }).catch(() => {}); }
              else { navigator.clipboard?.writeText(url); setShared(true); setTimeout(() => setShared(false), 1600); }
            }}
            className="inline-flex items-center gap-1.5 rounded-pill border border-line px-3 py-1 text-sm text-ink-2 transition-colors hover:border-yin-ink"
          >
            {shared ? "Link copied" : "Share"}
          </button>
        </div>
        <Credit nb={nb} />
      </header>


      {/* JupyterBook layout: contents rail · the document · the apparatus. The reading column is
          capped at a real measure (72ch) because a notebook is read, not scanned. */}
      {/* THREE children, so every breakpoint must declare three columns or the extra child gets
          auto-placed. It did: between 1024 and 1279px the two-column rule put the notebook in the
          300px sidebar slot and the whole work became unreadable on an ordinary laptop window.
          The contents rail is now `hidden xl:block` — out of the FLOW, not merely invisible — so
          `lg` sees exactly the two children it declares. */}
      {/*
        NO SOURCE ON THIS PAGE (operator, 2026-07-30). The work page used to render the whole
        notebook inline — a contents rail, every markdown cell, and every code cell behind a
        disclosure. A reader arrives to meet the WORK: the artifacts above, and the evidence that
        they are reproducible. Source code in the middle of that is the author's material, not the
        reader's, and it pushed the checklist and the discussion below a screenful of Python.

        It has two better homes, both one click away and both linked from here: the book, where the
        notebook reads as a document through ArtaReader, and the Lab, where it is editable and
        runnable. Neither is a demotion — the page is shorter and the code is now somewhere it can
        actually be used.
      */}
      {/* THE HERO AND THE DISCUSSION LIVE INSIDE THIS COLUMN, and that is what makes the rail
          stick. `position: sticky` travels only within its CONTAINING BLOCK: when WithRail wrapped
          just the checklist, the flex row was exactly as tall as the rail (measured on prod: row
          854px, rail 854px, travel 0) while the page was 2200px — so the cards scrolled away the
          moment the reader passed that slice. Capping the rail's height was necessary and not
          sufficient; the column it sits beside has to be the tall one. */}
      <WithRail rail={<WorkRail nb={nb} />}>
        <AssetStage nb={nb} />
        <article className="mt-6 min-w-0">
          {/* The evidence is what the reading column is FOR now: the checklist a stranger can
              re-run, not the author's Python. */}
          <Receipt nb={nb} />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" href={`/nb/${nb.id}/${nb.slug}/book`}>Read the notebook as a book</Button>
            <Button size="sm" variant="ghost" href={labRunUrl(nb.id, nb.slug)}>Open it in the Lab</Button>
          </div>
        </article>

        {/* Below lg the rail is out of the flow, so the same cards ride here — BEFORE the
            discussion. A phone must not lose "how do I run this" and "how do I cite this", and it
            must not have to scroll past every comment to find them. */}
        <div className="mt-6"><RailInline><WorkRail nb={nb} /></RailInline></div>

        <PostThread id={nb.id} count={nb.comments} />
      </WithRail>

    </div>
  );
}


