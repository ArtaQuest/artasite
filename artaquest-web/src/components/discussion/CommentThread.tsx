import { type FormEvent, useMemo, useState } from "react";
import { Avatar, Button, RichText, VoteControl, cx } from "../ui";
import { Composer } from "../Composer";
import { VerifyApi } from "../../lib/verify";
import type { BoardCapabilities, BoardComment, BoardWriteState } from "./types";

/* Inline identity prompt: posting requires a real name + birthday (server gate). Collect it RIGHT
   HERE so an enrolled member never types a reply only to be rejected — then the board refetches and
   the composer appears. */
function IdentityPrompt() {
  const [name, setName] = useState("");
  const [bday, setBday] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save() {
    if (!name.trim() || !bday || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await VerifyApi.setIdentity(name.trim(), bday);
      if (r?.ok) window.location.reload();
      else setErr(r?.message || r?.error || "Couldn't save — check your details.");
    } catch { setErr("Couldn't save — please try again."); }
    finally { setBusy(false); }
  }
  const f = "h-10 w-full rounded-field border border-line bg-space-1 px-3 text-[14px] text-ink outline-none focus:border-yin-light";
  return (
    <div data-goal="needs-identity" className="rounded-card border border-yin/30 bg-yin/5 px-4 py-3.5">
      <p className="text-[14px] font-semibold text-ink">Add your name to post</p>
      <p className="mt-0.5 text-[13px] text-ink-2">Replies are public and signed with your real name and age. It takes a few seconds — and you keep your place here.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" maxLength={80} className={f} />
        <input value={bday} onChange={(e) => setBday(e.target.value)} type="date" aria-label="Date of birth" className={f} />
        <Button onClick={save} disabled={busy || !name.trim() || !bday} className="h-10 shrink-0 px-5 text-[14px] disabled:opacity-50">{busy ? "Saving…" : "Save & post"}</Button>
      </div>
      {err && <p className="mt-1.5 text-[12px] text-yin-light">{err}</p>}
    </div>
  );
}

/* ONE discussion renderer for BOTH the public free boards (threads) and the per-course competition
   boards (sections). Controlled: the parent owns the comments + every mutation; this component knows
   only BoardComment + BoardCapabilities + BoardWriteState — no "is this a section?" branching. */

const ReplyIcon = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v1" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/* Two-step delete confirm (lifted from the old Thread page; only mounted when canDeleteOwn). */
function OwnerControls({ onEdit, onDelete, busy }: { onEdit: () => void; onDelete: () => void; busy: boolean }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <span className="flex items-center gap-4">
      <button type="button" onClick={onEdit} className="transition-colors hover:text-yang">Edit</button>
      {confirm ? (
        <span className="flex items-center gap-2 text-rose-300">
          <span>Delete?</span>
          <button type="button" onClick={onDelete} disabled={busy} className="font-bold hover:underline disabled:opacity-50">Yes</button>
          <button type="button" onClick={() => setConfirm(false)} className="text-ink-3 hover:text-ink">No</button>
        </span>
      ) : (
        <button type="button" onClick={() => setConfirm(true)} className="transition-colors hover:text-rose-300">Delete</button>
      )}
    </span>
  );
}

/* Plain textarea composer for the non-rich (section) boards — Cmd/Ctrl+Enter submits. */
function InlineComposer({ submitLabel, placeholder, autoFocus, onSubmit, onCancel }: {
  submitLabel: string; placeholder: string; autoFocus?: boolean; onSubmit: (b: string) => Promise<void>; onCancel?: () => void;
}) {
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const b = val.trim();
    if (b.length < 3 || busy) return;
    setBusy(true);
    try { await onSubmit(b); setVal(""); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <textarea value={val} autoFocus={autoFocus} onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(); }}
        rows={3} placeholder={placeholder}
        className="w-full rounded-card border border-line bg-space-2 px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-yin-light" />
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy || val.trim().length < 3} className="h-9 px-4 text-[14px] disabled:opacity-50">{busy ? "Posting…" : submitLabel}</Button>
        {onCancel && <button type="button" onClick={onCancel} className="text-[13px] font-semibold text-ink-3 hover:text-ink">Cancel</button>}
      </div>
    </form>
  );
}

/* The write slot: composer when open, sign-in card when logged-out, Enrol CTA when not enrolled. */
function WriteGate({ writeState, caps, submitLabel, placeholder, autoFocus, onSubmit, onCancel }: {
  writeState: BoardWriteState; caps: BoardCapabilities; submitLabel: string; placeholder: string;
  autoFocus?: boolean; onSubmit: (b: string) => Promise<void>; onCancel?: () => void;
}) {
  if (writeState.kind === "needs-login") {
    return <p className="rounded-card border border-line bg-space-1 px-4 py-3 text-[14px] text-ink-2"><a href={writeState.loginUrl} className="font-semibold text-yang hover:underline">Sign in</a> to join the discussion.</p>;
  }
  if (writeState.kind === "needs-identity") {
    return <IdentityPrompt />;
  }
  if (writeState.kind === "needs-enrol") {
    return (
      <div className="rounded-card border border-yin/30 bg-yin/5 px-4 py-3.5">
        <p className="text-[14px] text-ink-2">Watching is free; <span className="font-semibold text-ink">enrol to reply and vote</span> in this course's discussion.</p>
        <Button href={writeState.courseUrl} variant="primaryYin" className="mt-2.5 h-10 px-4 text-[14px]">Enrol to join · {writeState.priceLabel}</Button>
      </div>
    );
  }
  return caps.richInput
    ? <Composer submitLabel={submitLabel} autoFocus={autoFocus} minRows={3} placeholder={placeholder} onSubmit={onSubmit} onCancel={onCancel} />
    : <InlineComposer submitLabel={submitLabel} autoFocus={autoFocus} placeholder={placeholder} onSubmit={onSubmit} onCancel={onCancel} />;
}

type NodeProps = {
  c: BoardComment;
  caps: BoardCapabilities;
  writeOpen: boolean;
  childrenOf: (id: string) => BoardComment[];   // flat mode: from the rebuilt map; nested: c.children
  onReply: (parentId: string, body: string) => Promise<void>;
  onEdit?: (id: string, body: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onVote: (id: string, dir: 1 | -1) => void;
  onLoadMoreReplies?: (parentId: string) => Promise<void>;
  onAppeal?: (id: string) => void;              // section: one ArtaMod appeal per flagged own reply
  layout: "pill" | "pillar";
  busyVoteId: string | null;
  depth: number;
};

function CommentNode(p: NodeProps) {
  const { c, caps } = p;
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [loadingKids, setLoadingKids] = useState(false);
  const kids = p.childrenOf(c.id);
  // Hovering any vote arrow reveals who up/down-voted this reply (ticket #90) — keyed by the same
  // comment id the vote posts to (both section + public comments are aq_votes target_type 'comment').
  const vid = parseInt(c.id.replace(/\D/g, ""), 10) || 0;
  const voteTarget = vid ? ({ kind: "comment", id: vid } as const) : undefined;
  const showWrite = p.writeOpen && !c.deleted;
  // Replies still unloaded: nested boards ship the remainder (childCount, decremented as pages
  // land); flat boards ship the TOTAL (replyTotal) and we subtract what's already in the tree.
  const moreKids = caps.tree === "nested" ? (c.childCount ?? 0) : Math.max(0, (c.replyTotal ?? 0) - kids.length);
  // Owner controls: TRUE AUTHORSHIP ONLY (ticket #65 — Edit/Delete had leaked onto every comment;
  // they belong to the comment's author alone, with no moderator exception).
  const canManage = c.mine && (caps.canEditOwn || caps.canDeleteOwn);

  return (
    <li className="min-w-0">
      <div className="flex items-start gap-2.5 py-2">
        {caps.tree === "nested" && !c.mine && (
          <span className="shrink-0 pt-0.5"><VoteControl votes={c.votes} myVote={c.myVote} busy={p.busyVoteId === c.id} onVote={(d) => p.onVote(c.id, d)} layout={p.layout} votersTarget={voteTarget} /></span>
        )}
        {caps.tree === "nested" && c.mine && (
          <span className="shrink-0 pt-0.5"><VoteControl votes={c.votes} myVote={c.myVote} mine onVote={() => {}} layout={p.layout} votersTarget={voteTarget} /></span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-ink-3">
              <Avatar src={c.avatar} name={c.author} country={c.country} className="h-6 w-6 text-[11px]" />
              {caps.showAuthorLink && c.authorSlug
                ? <a href={`/u/${c.authorSlug}/`} data-ay-skip="1" className="font-semibold text-ink-2 hover:text-yang">{c.author}</a>
                : <span data-ay-skip="1" className={cx("font-semibold", c.deleted ? "italic text-ink-3" : "text-ink-2")}>{c.author}</span>}
              {c.timeLabel && !c.deleted && <><span aria-hidden>·</span><span>{c.timeLabel}</span></>}
              {c.edited && !c.deleted && <span className="text-ink-3">· edited</span>}
              {c.bot && <span className="rounded-pill bg-yin/15 px-2 py-0.5 text-[11px] font-semibold text-yin-light">ArtaBot</span>}
              {!!c.anchor && c.anchor > 0 && (
                <span title="This reply references a moment in the video" className="rounded-pill bg-yang/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-yang">
                  ▶ {Math.floor(c.anchor / 60)}:{String(c.anchor % 60).padStart(2, "0")}
                </span>
              )}
              {c.flagged && <span title="ArtaMod set this reply aside from the competition — its upvotes don’t count. Nothing is deleted." className="rounded-pill border border-line px-2 py-0.5 text-[11px] font-medium text-ink-2">Set aside · ArtaMod</span>}
              {c.flagged && c.mine && !c.appealed && p.onAppeal && (
                <button type="button" onClick={() => p.onAppeal?.(c.id)}
                  className="rounded-pill border border-yang/40 px-2 py-0.5 text-[11px] font-semibold text-yang hover:bg-yang/10">
                  Appeal
                </button>
              )}
            </p>
            {caps.tree === "flat" && !c.deleted && (
              <span className="shrink-0"><VoteControl votes={c.votes} myVote={c.myVote} mine={c.mine} busy={p.busyVoteId === c.id} onVote={(d) => p.onVote(c.id, d)} layout={p.layout} votersTarget={voteTarget} /></span>
            )}
          </div>

          {c.deleted ? (
            <p className="mt-1 text-[14px] italic text-ink-3">This comment was deleted.</p>
          ) : editing && p.onEdit ? (
            <div className="mt-2">
              <Composer initialValue={c.bodyMd || ""} submitLabel="Save" autoFocus minRows={3} placeholder="Edit your comment…"
                onSubmit={async (b) => { await p.onEdit!(c.id, b); setEditing(false); }} onCancel={() => setEditing(false)} />
            </div>
          ) : (
            <RichText html={c.bodyHtml} srcLang={c.srcLang} className={cx("mt-1 text-[15px]", c.flagged && "opacity-60")} />
          )}

          {/* A seed referencing the video's top YouTube comment — the original commenter credited
              with their profile name + picture + live thumbs-up; tap through to the comment on YouTube. */}
          {!c.deleted && !editing && c.ytRef && (
            <a href={c.ytRef.url} target="_blank" rel="noopener noreferrer" data-ay-skip="1"
              className="mt-2 block rounded-card border border-line bg-veil/[0.03] p-3 transition-colors hover:border-yin-light/40">
              <div className="flex items-center gap-2">
                <Avatar src={c.ytRef.avatar} name={c.ytRef.author} className="h-7 w-7 text-[11px]" />
                <span className="min-w-0 truncate text-[13px] font-semibold text-ink-2">{c.ytRef.author}</span>
                <span className="ms-auto inline-flex shrink-0 items-center gap-1 text-[12px] tabular-nums text-ink-3" title="thumbs-up on YouTube">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden><path d="M2 10h3v11H2zM22 11c0-1.1-.9-2-2-2h-5.3l.8-3.9c0-.2.1-.4.1-.6 0-.4-.2-.8-.4-1L14 2 7.6 8.4c-.4.4-.6.9-.6 1.4V19c0 1.1.9 2 2 2h7.5c.8 0 1.5-.5 1.8-1.2l2.5-5.9c.1-.2.1-.4.1-.7v-2.2z" /></svg>
                  {c.ytRef.likes.toLocaleString("en")}
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-line text-[14px] leading-snug text-ink-2">{c.ytRef.text}</p>
              <span className="mt-1.5 block text-[11px] text-ink-2">Top comment on YouTube · tap to view</span>
            </a>
          )}

          {!c.deleted && !editing && (showWrite || canManage) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-4 text-[13px] font-semibold text-ink-3">
              {showWrite && (
                <button type="button" onClick={() => setReplying((r) => !r)} aria-expanded={replying} className="flex min-h-[28px] items-center gap-1.5 transition-colors hover:text-yang">
                  <ReplyIcon /> Reply
                </button>
              )}
              {canManage && p.onEdit && p.onDelete && (
                <OwnerControls onEdit={() => setEditing(true)} busy={delBusy}
                  onDelete={async () => { setDelBusy(true); try { await p.onDelete!(c.id); } finally { setDelBusy(false); } }} />
              )}
            </div>
          )}

          {replying && (
            <div className="mt-2">
              <WriteGate writeState={{ kind: "open" }} caps={caps} submitLabel="Reply" autoFocus placeholder={`Reply to ${c.author}…`}
                onSubmit={async (b) => { await p.onReply(c.id, b); setReplying(false); }} onCancel={() => setReplying(false)} />
            </div>
          )}

          {kids.length > 0 && (
            <ul className="mt-1 list-none border-s border-line/60 ps-3">
              {kids.map((k) => <CommentNode key={k.id} {...p} c={k} depth={p.depth + 1} />)}
            </ul>
          )}
          {moreKids > 0 && p.onLoadMoreReplies && (
            <button type="button" disabled={loadingKids}
              onClick={async () => { setLoadingKids(true); try { await p.onLoadMoreReplies!(c.id); } finally { setLoadingKids(false); } }}
              className="mt-1 ps-3 text-[12px] font-semibold text-yin-light hover:underline disabled:opacity-50">
              {loadingKids ? "Loading…" : `Show ${moreKids} more ${moreKids === 1 ? "reply" : "replies"}`}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function CommentThread({
  comments, capabilities, writeState, layout = "pillar", sort, onSortChange, total,
  hasMore, onLoadMore, onPostRoot, onReply, onEdit, onDelete, onVote, onLoadMoreReplies, onAppeal,
  busyVoteId = null, emptyLabel = "No comments yet. Be the first.",
}: {
  comments: BoardComment[]; capabilities: BoardCapabilities; writeState: BoardWriteState;
  layout?: "pill" | "pillar"; sort: "top" | "new"; onSortChange: (s: "top" | "new") => void; total: number;
  hasMore: boolean; onLoadMore: () => Promise<void>;
  onPostRoot: (body: string) => Promise<void>; onReply: (parentId: string, body: string) => Promise<void>;
  onEdit?: (id: string, body: string) => Promise<void>; onDelete?: (id: string) => Promise<void>;
  onVote: (id: string, dir: 1 | -1) => void; onLoadMoreReplies?: (parentId: string) => Promise<void>;
  onAppeal?: (id: string) => void;
  busyVoteId?: string | null; emptyLabel?: string;
}) {
  const [loadingMore, setLoadingMore] = useState(false);

  // Flat boards (threads) arrive as a flat list → rebuild a parent→children map for multi-level render.
  // Nested boards (sections) carry children[] inline → roots are parentId === null, kids come from `children`.
  // Roots keep SERVER order (the sort); children render in conversation (id) order regardless of the
  // order pages + locally-posted replies were appended to the flat list.
  const { roots, childMap } = useMemo(() => {
    if (capabilities.tree === "nested") return { roots: comments.filter((c) => !c.parentId), childMap: {} as Record<string, BoardComment[]> };
    const map: Record<string, BoardComment[]> = {};
    const top: BoardComment[] = [];
    for (const c of comments) {
      if (c.parentId) (map[c.parentId] ||= []).push(c);
      else top.push(c);
    }
    const num = (id: string) => Number(id.replace(/\D/g, "")) || 0;
    for (const k of Object.keys(map)) map[k].sort((a, b) => num(a.id) - num(b.id));
    return { roots: top, childMap: map };
  }, [comments, capabilities.tree]);

  const childrenOf = (id: string): BoardComment[] =>
    capabilities.tree === "nested" ? (comments.find((c) => c.id === id)?.children ?? []) : (childMap[id] ?? []);

  return (
    <div>
      <WriteGate writeState={writeState} caps={capabilities} submitLabel="Post" placeholder="Share your thoughts…" onSubmit={onPostRoot} />

      <div className="mt-5 flex items-center justify-between">
        <p className="text-[13px] font-semibold text-ink-3">{total} {total === 1 ? "comment" : "comments"}</p>
        <div className="flex items-center gap-1 text-[13px] font-semibold">
          {(["top", "new"] as const).map((s) => (
            <button key={s} type="button" onClick={() => onSortChange(s)}
              className={cx("rounded-pill px-2.5 py-1 transition-colors", sort === s ? "bg-yin/15 text-yin-light" : "text-ink-3 hover:text-ink")}>
              {s === "top" ? "Top" : "New"}
            </button>
          ))}
        </div>
      </div>

      {roots.length === 0 ? (
        <p className="mt-4 rounded-card border border-line bg-space-1 px-4 py-6 text-center text-[14px] text-ink-3">{emptyLabel}</p>
      ) : (
        <ul className="mt-2 list-none divide-y divide-line/50">
          {roots.map((c) => (
            <CommentNode key={c.id} c={c} caps={capabilities} writeOpen={writeState.kind === "open"}
              childrenOf={childrenOf} onReply={onReply} onEdit={onEdit} onDelete={onDelete} onVote={onVote}
              onLoadMoreReplies={onLoadMoreReplies} onAppeal={onAppeal} layout={layout} busyVoteId={busyVoteId} depth={0} />
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="mt-4 text-center">
          <Button variant="outline" disabled={loadingMore}
            onClick={async () => { setLoadingMore(true); try { await onLoadMore(); } finally { setLoadingMore(false); } }}
            className="h-10 px-5 text-[14px]">{loadingMore ? "Loading…" : "Load more"}</Button>
        </div>
      )}
    </div>
  );
}
