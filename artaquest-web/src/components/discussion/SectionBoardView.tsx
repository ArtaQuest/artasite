import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSectionThread, postSectionComment, voteSectionComment, getMoreReplies, isLoggedIn, localePath, type SectionThread, type SectionComment } from "../../lib/wp";
import { createVoteCaster } from "../../lib/votes";
import { sectionCommentToBoard } from "./adapters";
import { SECTION_CAPS, type BoardWriteState } from "./types";
import { CommentThread } from "./CommentThread";

/* The per-section competition board, reusable verbatim in BOTH the lesson player (with video +
   engagement chrome around it) and the standalone /discussions?section=<id> page. Owns the board's
   data + mutations and renders the shared <CommentThread>; the host learns of engagement via
   onEngagementChange (the lesson player drives StepChips off it). */

type Engagement = { commented: boolean; upvoted: boolean; engaged: boolean };

// Patch one comment (top-level or nested child) by id, immutably.
function patch(items: SectionComment[], id: number, fn: (c: SectionComment) => SectionComment): SectionComment[] {
  return items.map((c) =>
    c.id === id ? fn(c) : c.children ? { ...c, children: patch(c.children, id, fn) } : c
  );
}
function findComment(items: SectionComment[], id: number): SectionComment | null {
  for (const c of items) {
    if (c.id === id) return c;
    const hit = c.children?.find((k) => k.id === id);
    if (hit) return hit;
  }
  return null;
}

export function SectionBoardView({ lessonId, onEngagementChange, onTotalChange }: {
  lessonId: number;
  onEngagementChange?: (e: Engagement) => void;
  onTotalChange?: (total: number) => void;
}) {
  const [thread, setThread] = useState<SectionThread | null>(null);
  const [sort, setSort] = useState<"top" | "new">("top");
  const [voteErr, setVoteErr] = useState("");
  // The vote caster + pagers read the LATEST board through this ref (never a stale closure).
  const threadRef = useRef<SectionThread | null>(null);
  threadRef.current = thread;
  // Keyset cursor per parent for reply paging — the last SERVER-delivered child id. A locally
  // appended reply has the largest id, so "last child in the array" would skip every unloaded
  // reply between the server pages and it; only server pages may advance this.
  const repliesCursor = useRef(new Map<number, number>());
  const seedReplyCursors = (items: SectionComment[]) => {
    for (const c of items) {
      if (c.children?.length) repliesCursor.current.set(c.id, c.children[c.children.length - 1].id);
    }
  };

  const report = useCallback((t: SectionThread) => {
    onEngagementChange?.({ commented: t.mine_commented, upvoted: t.mine_upvoted, engaged: t.engaged });
    onTotalChange?.(t.total);
  }, [onEngagementChange, onTotalChange]);

  const load = useCallback(async (s: "top" | "new") => {
    const t = await getSectionThread(lessonId, { sort: s });
    repliesCursor.current.clear();
    seedReplyCursors(t.items);
    setThread(t); report(t);
  }, [lessonId, report]);

  useEffect(() => { void load(sort); }, [load, sort]);

  // OPTIMISTIC votes (lib/votes.ts): the arrows + count move the instant you tap, reconcile to the
  // server's authoritative score when it answers, and roll back with a note on failure. Requests
  // per comment are latest-wins, so rapid toggling settles on what you last asked for.
  const castVote = useMemo(() => createVoteCaster<number>({
    send: async (id, val) => {
      const r = await voteSectionComment(id, val);
      return { my_vote: r.my_vote, votes: r.votes };
    },
    read: (id) => {
      const c = threadRef.current ? findComment(threadRef.current.items, id) : null;
      return c ? { votes: c.votes, myVote: c.my_vote } : null;
    },
    write: (id, s) =>
      setThread((prev) => prev ? { ...prev, items: patch(prev.items, id, (c) => ({ ...c, votes: s.votes, my_vote: s.myVote as -1 | 0 | 1 })) } : prev),
    onSettle: (_id, s) => {
      // Casting an upvote completes the viewer's "upvote a peer" engagement step.
      if (s.myVote !== 1) return;
      setThread((prev) => {
        if (!prev || prev.mine_upvoted) return prev;
        const next = { ...prev, mine_upvoted: true, engaged: prev.mine_commented };
        report(next);
        return next;
      });
    },
    onError: (_id, e) => setVoteErr(e instanceof Error ? e.message : "Couldn't record your vote — please try again."),
  }), [report]);

  if (!thread) return <p className="rounded-card border border-line bg-space-1 px-4 py-6 text-center text-[14px] text-ink-3">Loading the discussion…</p>;

  const enrolled = thread.enrolled;
  const needsIdentity = (thread as unknown as { needs_identity?: boolean }).needs_identity === true;
  const writeState: BoardWriteState = enrolled
    ? (needsIdentity ? { kind: "needs-identity" } : { kind: "open" })
    : isLoggedIn()
      ? { kind: "needs-enrol", priceLabel: thread.price_display, courseUrl: localePath(thread.course_url) }
      : { kind: "needs-login", loginUrl: (typeof window !== "undefined" && (window as unknown as Record<string, string>).AQ_LOGIN_URL) || "/login/" };

  const comments = thread.items.map(sectionCommentToBoard);

  // Posting appends the server's OWN card in place (no full-board refetch — the old reload lost
  // scroll position + loaded pages). New roots go on top, Reddit-style. The one exception: a
  // fear-flagged comment triggers ArtaBot's consoling reply server-side, so refetch to show it.
  function applyPosted(card: SectionComment | null | undefined, parentId: number, flagged?: boolean) {
    if (!card || flagged) { void load(sort); return; }
    setThread((prev) => {
      if (!prev) return prev;
      const items = parentId
        ? patch(prev.items, parentId, (c) => ({ ...c, children: [...(c.children ?? []), card] }))
        : [card, ...prev.items];
      // engaged ≈ commented + upvoted (the server also applies the lone-commenter relaxation; the
      // next board fetch reconciles that edge). Engagement only ever turns on here, never off.
      const next = { ...prev, items, total: prev.total + 1, mine_commented: true, engaged: prev.engaged || prev.mine_upvoted };
      report(next);
      return next;
    });
  }
  // Timestamp anchor: the Lesson page mirrors the live playback position into window.AQ_PLAYER_AT,
  // so a reply posted mid-watch carries the moment it talks about (rendered as a ▶ m:ss chip).
  const playerAt = () => Math.max(0, Math.floor((window as unknown as { AQ_PLAYER_AT?: number }).AQ_PLAYER_AT ?? 0));
  async function postRoot(body: string) {
    const r = await postSectionComment(lessonId, body, 0, playerAt());
    applyPosted(r.card, 0, r.flagged);
  }
  async function reply(parentId: string, body: string) {
    const r = await postSectionComment(lessonId, body, Number(parentId), playerAt());
    applyPosted(r.card, Number(parentId), r.flagged);
  }
  // ArtaMod appeal: one per flagged own reply — a fresh adjudication with the member's reason attached.
  async function appeal(id: string) {
    const reason = window.prompt("Tell us in a sentence why this reply was misread — a fresh review will look at it once:");
    if (!reason || reason.trim().length < 10) return;
    try {
      const { appealFlag } = await import("../../lib/wp");
      const r = await appealFlag(Number(id), reason.trim());
      const fix = (c: SectionComment): SectionComment =>
        String(c.id) === id ? { ...c, appealed: true, flagged: r.granted ? false : c.flagged } : { ...c, children: c.children?.map(fix) };
      setThread((prev) => (prev ? { ...prev, items: prev.items.map(fix) } : prev));
      setVoteErr(r.granted ? "Appeal granted — the flag is removed and this reply's upvotes count again." : "Appeal reviewed — the flag stands. Nothing is deleted; the reply simply sits out the competition.");
    } catch {
      setVoteErr("Couldn't file the appeal — please try again in a moment.");
    }
  }
  function onVote(id: string, dir: 1 | -1) {
    if (!enrolled) { window.location.assign(writeState.kind === "needs-enrol" ? writeState.courseUrl : "/login/"); return; }
    setVoteErr("");
    castVote(Number(id), dir);
  }
  async function loadMore() {
    const cur = threadRef.current;
    if (!cur?.next) return;
    const more = await getSectionThread(lessonId, { sort, cursor: cur.next });
    seedReplyCursors(more.items);
    setThread((prev) => prev ? { ...prev, items: [...prev.items, ...more.items], next: more.next } : more);
  }
  async function loadMoreReplies(parentId: string) {
    const pid = Number(parentId);
    const more = await getMoreReplies(lessonId, pid, repliesCursor.current.get(pid) ?? 0);
    if (!more.items.length) return;
    repliesCursor.current.set(pid, more.items[more.items.length - 1].id);
    setThread((prev) => prev ? { ...prev, items: patch(prev.items, pid, (c) => ({
      ...c,
      // dedupe (a locally-appended reply can come back in a page) + keep conversation (id) order
      children: [...(c.children ?? []), ...more.items.filter((i) => !c.children?.some((k) => k.id === i.id))].sort((a, b) => a.id - b.id),
      more_replies: Math.max(0, (c.more_replies ?? 0) - more.items.length),
    })) } : prev);
  }

  return (
    <>
      {voteErr && <p role="alert" className="mb-2 rounded-card border border-yin/30 bg-yin/5 px-3 py-2 text-[13px] text-yin-light">{voteErr}</p>}
      <CommentThread
        comments={comments} capabilities={SECTION_CAPS} writeState={writeState} layout="pillar"
        sort={sort} onSortChange={setSort} total={thread.total}
        hasMore={!!thread.next} onLoadMore={loadMore}
        onPostRoot={postRoot} onReply={reply} onVote={onVote} onLoadMoreReplies={loadMoreReplies} onAppeal={appeal}
        emptyLabel="No replies yet — start the conversation."
      />
    </>
  );
}
