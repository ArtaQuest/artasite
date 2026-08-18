import { useEffect, useMemo, useRef, useState } from "react";
import {
  localePath, deleteDiscComment, deleteDiscThread, getThread, getThreadReplies, isLoggedIn,
  postDiscComment, postDiscVote, updateDiscComment, updateDiscThread, type ThreadData, type ThreadComment,
} from "../lib/wp";
import { createVoteCaster } from "../lib/votes";
import { isLorem, loremThread } from "../lib/lorem";
import { Avatar, Input, RichText, StatusNote, VotePill, cx } from "../components/ui";
import { nameClass } from "../lib/fmt";
import { Composer } from "../components/Composer";
import { CommentThread } from "../components/discussion/CommentThread";
import { threadCommentToBoard } from "../components/discussion/adapters";
import { THREAD_CAPS, type BoardWriteState } from "../components/discussion/types";

/* ── tiny inline icons (OP owner controls) ───────────────────────────────── */
const EditIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const TrashIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/** Owner-only Edit · Delete for the original post (inline two-step confirm for delete).
 *  Comment-level owner controls live inside <CommentThread>; this is only the thread head. */
function OwnerControls({ onEdit, onDelete, busy }: { onEdit: () => void; onDelete: () => void; busy?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="text-ink-3">Delete?</span>
        <button type="button" onClick={onDelete} disabled={busy} className="text-rose-300 transition-colors hover:text-rose-200 disabled:opacity-40">{busy ? "Deleting…" : "Yes"}</button>
        <button type="button" onClick={() => setConfirming(false)} className="text-ink-3 transition-colors hover:text-ink">No</button>
      </span>
    );
  }
  return (
    <>
      <button type="button" onClick={onEdit} className="flex min-h-[28px] items-center gap-1.5 transition-colors hover:text-yang"><EditIcon /> Edit</button>
      <button type="button" onClick={() => setConfirming(true)} className="flex min-h-[28px] items-center gap-1.5 transition-colors hover:text-rose-300"><TrashIcon /> Delete</button>
    </>
  );
}

export default function Thread({ forum, slug }: { forum: string; slug: string }) {
  const [d, setD] = useState<ThreadData | null>(null);
  const [missing, setMissing] = useState(false);
  const [sort, setSort] = useState<"top" | "new">("top");
  const [editingThread, setEditingThread] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [deletingThread, setDeletingThread] = useState(false);
  const [voteErr, setVoteErr] = useState("");
  // The vote caster + reply pagers read the LATEST state through this ref (never a stale closure).
  const dRef = useRef<ThreadData | null>(null);
  dRef.current = d;
  // Keyset cursor per parent for reply paging — the last SERVER-delivered child id. A locally
  // posted reply has the largest id, so "last child in the tree" would skip every unloaded reply
  // between the server pages and it; only server pages may advance this.
  const repliesCursor = useRef(new Map<string, number>());
  const seedReplyCursors = (comments: ThreadComment[]) => {
    for (const c of comments) {
      if (c.parent) repliesCursor.current.set(c.parent, Math.max(repliesCursor.current.get(c.parent) ?? 0, Number(c.id) || 0));
    }
  };

  // Server-driven sort: switching Top/New refetches page 1 in that order (the old client-side
  // re-sort only shuffled whatever happened to be loaded). The current list stays up meanwhile.
  useEffect(() => {
    if (isLorem()) { setD(loremThread()); return; }
    if (!slug) return;
    getThread(forum, slug, { sort }).then((r) => {
      if (!r) { setMissing(true); return; }
      repliesCursor.current.clear();
      seedReplyCursors(r.comments);
      setD(r);
    }).catch(() => setMissing(true));
  }, [forum, slug, sort]);
  // Tab title = the thread title (dynamic route; matches CourseDetail/Profile/Lesson). The title is
  // user content, so the i18n title-localiser leaves it as-is (no dict hit on a one-off title).
  useEffect(() => { if (d?.title) document.title = `${d.title} – ArtaQuest`; }, [d?.title]);

  // Server order is the render order (roots paginated by sort, replies inline under their parent).
  const boardComments = useMemo(() => (d?.comments || []).map(threadCommentToBoard), [d]);

  // New roots go on TOP (Reddit-style: you see your fresh comment immediately); replies append
  // under their parent and bump its reply total so "show more" math stays honest.
  const addComment = (c: ThreadComment) =>
    setD((prev) => {
      if (!prev) return prev;
      const comments = c.parent
        ? [...prev.comments.map((x) => (x.id === c.parent ? { ...x, replies: (x.replies ?? 0) + 1 } : x)), c]
        : [c, ...prev.comments];
      return { ...prev, comments, total: (prev.total ?? prev.comments.length) + 1 };
    });
  const editComment = (id: string, html: string) =>
    setD((prev) => (prev ? { ...prev, comments: prev.comments.map((c) => (c.id === id ? { ...c, body_html: html, edited: true } : c)) } : prev));
  const removeComment = (id: string, soft: boolean) =>
    setD((prev) => {
      if (!prev) return prev;
      if (soft) {
        // Soft delete (the comment has replies): the placeholder keeps the subtree readable.
        return { ...prev, comments: prev.comments.map((c) => (c.id === id ? { ...c, deleted: true, mine: false, body_html: "", author: "[deleted]" } : c)) };
      }
      const gone = prev.comments.find((c) => c.id === id);
      const comments = prev.comments
        .filter((c) => c.id !== id)
        .map((c) => (gone?.parent && c.id === gone.parent ? { ...c, replies: Math.max(0, (c.replies ?? 0) - 1) } : c));
      return { ...prev, comments, total: Math.max(0, (prev.total ?? 1) - 1) };
    });

  // OPTIMISTIC votes (lib/votes.ts): arrows + count move on tap, reconcile to the server's
  // authoritative score, roll back with a note on failure. Per-comment requests are latest-wins,
  // so rapid toggling settles faithfully. The thread head's VotePill runs the same caster.
  const castVote = useMemo(() => createVoteCaster<string>({
    send: (id, val) => postDiscVote(id, val, "comment"),
    read: (id) => {
      const c = dRef.current?.comments.find((x) => x.id === id);
      return c ? { votes: c.votes, myVote: c.my_vote ?? 0 } : null;
    },
    write: (id, s) =>
      setD((p) => (p ? { ...p, comments: p.comments.map((c) => (c.id === id ? { ...c, votes: s.votes, my_vote: s.myVote } : c)) } : p)),
    onError: () => setVoteErr("Couldn't record your vote — please try again."),
  }), []);
  function voteComment(id: string, dir: 1 | -1) {
    if (!isLoggedIn()) { window.location.assign(localePath("/login/")); return; }
    setVoteErr("");
    castVote(id, dir);
  }

  async function loadMore() {
    const cur = dRef.current;
    if (!cur?.next) return;
    const more = await getThread(forum, slug, { sort, cursor: cur.next });
    if (!more) return;
    seedReplyCursors(more.comments);
    setD((p) => (p ? {
      ...p,
      comments: [...p.comments, ...more.comments.filter((c) => !p.comments.some((x) => x.id === c.id))],
      next: more.next,
    } : p));
  }
  async function loadMoreReplies(parentId: string) {
    const more = await getThreadReplies(slug, parentId, repliesCursor.current.get(parentId) ?? 0);
    if (!more.items.length) return;
    seedReplyCursors(more.items);
    setD((p) => (p ? {
      ...p,
      comments: [...p.comments, ...more.items.filter((c) => !p.comments.some((x) => x.id === c.id))],
    } : p));
  }

  async function doDeleteThread() {
    if (!d) return;
    setDeletingThread(true);
    try { const r = await deleteDiscThread(d.id); window.location.href = r.redirect; }
    catch { setDeletingThread(false); }
  }

  if (missing) return <StatusNote className="py-16">Thread not found.</StatusNote>;
  if (!d) return <StatusNote className="py-16">Loading…</StatusNote>;

  // Forum slugs are hyphenated (e.g. "site-feedback"); show them as readable Title Case words
  // ("Site Feedback") so the breadcrumb + byline match the forum's real name, not lowercase.
  const prettyForum = forum.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const writeState: BoardWriteState = isLoggedIn() ? { kind: "open" } : { kind: "needs-login", loginUrl: localePath("/login/") };

  return (
    <div className="max-w-5xl">
      <a href={localePath(`/discussions/?forum=${forum}`)} className="inline-flex min-h-[28px] items-center text-[13px] font-semibold uppercase tracking-wide text-ink-3 hover:text-yang">← {prettyForum}</a>
      <article className="mt-3 border-b border-line pb-5">
        {editingThread ? (
          <div className="flex flex-col gap-3">
            <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={160} aria-label="Topic title" className="text-[18px] font-semibold" />
            <Composer initialValue={d.body_md || ""} submitLabel="Save" minRows={4} maxLength={30000} placeholder="Edit your topic…"
              onSubmit={async (b) => {
                const title = editTitle.trim();
                if (!title) throw new Error("A title is required.");
                const r = await updateDiscThread(d.id, title, b);
                setD((p) => (p ? { ...p, title: r.title, body_html: r.body_html, edited: true } : p));
                setEditingThread(false);
              }}
              onCancel={() => setEditingThread(false)} />
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-ink-3">
                  <Avatar name={d.author} className="h-6 w-6 text-[11px] font-normal" />
                  <span className={cx("min-w-0", nameClass(d.author, 12))}><span data-ay-skip="1">{d.author}</span>{d.time && ` · ${d.time}`}{d.edited && " · edited"} in {prettyForum}</span>
                </div>
                <h1 data-ay-tr="1" data-ay-src={d.lang || "en"} className="mt-2 text-[26px] font-bold leading-tight tracking-tight">{d.title}</h1>
              </div>
              <div className="shrink-0"><VotePill votes={d.votes} myVote={d.my_vote} target={d.id} mine={d.mine} /></div>
            </div>
            <RichText html={d.body_html} srcLang={d.lang} className="mt-3 text-[16px] leading-relaxed" />
            {d.mine && (
              <div className="mt-3 flex items-center gap-4 text-[13px] font-semibold text-ink-3">
                <OwnerControls onEdit={() => { setEditTitle(d.title); setEditingThread(true); }} onDelete={doDeleteThread} busy={deletingThread} />
              </div>
            )}
          </>
        )}
      </article>

      {/* The SAME <CommentThread> that drives the per-course section boards — one renderer everywhere. */}
      <section className="mt-6">
        {voteErr && <p role="alert" className="mb-2 rounded-card border border-yin/30 bg-yin/5 px-3 py-2 text-[13px] text-yin-light">{voteErr}</p>}
        <CommentThread
          comments={boardComments} capabilities={THREAD_CAPS} writeState={writeState} layout="pill"
          sort={sort} onSortChange={setSort} total={d.total ?? d.comments.length}
          hasMore={!!d.next} onLoadMore={loadMore}
          onPostRoot={async (b) => { addComment(await postDiscComment(slug, b)); }}
          onReply={async (parentId, b) => { addComment(await postDiscComment(slug, b, parentId)); }}
          onEdit={async (id, b) => { const r = await updateDiscComment(id, b); editComment(id, r.body_html); }}
          onDelete={async (id) => { const r = await deleteDiscComment(id); removeComment(id, !!r.soft); }}
          onVote={voteComment} onLoadMoreReplies={loadMoreReplies}
          emptyLabel="No comments yet — start the conversation."
        />
      </section>
    </div>
  );
}
