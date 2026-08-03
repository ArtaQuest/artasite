// The ONLY place that knows the two legacy comment shapes. Everything downstream sees BoardComment.
import { renderRich, relAgo, type ThreadComment, type SectionComment } from "../../lib/wp";
import type { BoardComment } from "./types";

/** Public free-thread comment → board. Arrives flat (parent id); <CommentThread> rebuilds the tree.
 *  body_html is already rendered server-side; body_md present ⇒ editable. */
export function threadCommentToBoard(c: ThreadComment): BoardComment {
  return {
    id: c.id,
    parentId: c.parent && c.parent !== "0" ? c.parent : null,
    author: c.author,
    authorSlug: c.slug || undefined,
    avatar: c.avatar || undefined,
    country: c.country || undefined,
    bodyHtml: c.body_html,
    bodyMd: c.body_md,
    timeLabel: c.time,
    votes: c.votes,
    myVote: c.my_vote ?? 0,
    mine: !!c.mine,
    edited: c.edited,
    deleted: c.deleted,
    srcLang: c.lang,
    replyTotal: c.replies ?? 0, // unloaded replies = replyTotal − children present in the flat list
  };
}

/** Section (competition) comment → board. Raw body → markdown/LaTeX via renderRich (unifies rendering
 *  with the free boards); pre-nested one level via children[]; no body_md ⇒ not editable. */
export function sectionCommentToBoard(c: SectionComment): BoardComment {
  return {
    id: String(c.id),
    parentId: c.parent ? String(c.parent) : null,
    author: c.author,
    authorSlug: c.slug || undefined,
    avatar: c.avatar || undefined,
    country: c.country || undefined,
    bodyHtml: renderRich(c.body),
    timeLabel: relAgo(c.at),
    votes: c.votes,
    myVote: c.my_vote,
    mine: c.mine,
    childCount: c.more_replies,
    children: c.children?.map(sectionCommentToBoard),
    flagged: c.flagged,
    appealed: c.appealed,
    anchor: c.anchor,
    bot: c.bot,
    ytRef: c.ref || undefined,
  };
}
