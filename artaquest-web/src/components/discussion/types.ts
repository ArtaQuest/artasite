// Normalized discussion model — ONE shape the shared <CommentThread> renders, so the public free
// boards (threads) and the per-course competition boards (sections) look + behave identically.
// The two legacy shapes (ThreadComment / SectionComment) are mapped to this in adapters.ts ONLY.

export type BoardComment = {
  id: string;
  parentId: string | null;
  author: string;
  authorSlug?: string;      // section comments link the author to /u/<slug>; thread comments don't
  avatar?: string;
  country?: string;         // verified nationality (ISO alpha-2) → avatar flag; absent until verified
  bodyHtml: string;         // ALWAYS html — the section adapter runs renderRich() on the raw body
  bodyMd?: string;          // present only when editable (thread comments) — round-trips the Composer
  timeLabel: string;        // pre-formatted relative time
  votes: number;
  myVote: number;           // -1 | 0 | 1
  mine: boolean;
  edited?: boolean;
  deleted?: boolean;
  srcLang?: string;         // drives RichText i18n marking
  childCount?: number;      // section: replies still unloaded ("N more replies")
  replyTotal?: number;      // thread: TOTAL direct replies — unloaded = replyTotal − loaded children
  children?: BoardComment[]; // section pre-nests one level; thread arrives flat (tree rebuilt by id)
  flagged?: boolean;        // section: ArtaMod set this reply aside from the competition (hate/fear)
  appealed?: boolean;       // section: the one ArtaMod appeal was used
  anchor?: number;          // section: seconds into the video this reply references (0 = unanchored)
  bot?: boolean;            // section: ArtaBot's own consoling reply
  ytRef?: YtCommentRef;     // section: an ArtaBot seed referencing the video's top YouTube comment
};

/** A referenced YouTube top comment carried on an ArtaBot seed — the original commenter credited with
 *  their profile name + picture + live thumbs-up, framed as an example the learner may ignore. */
export type YtCommentRef = { author: string; avatar: string; likes: number; text: string; url: string };

// What a board ALLOWS — keeps <CommentThread> free of any "is this a section?" branching.
export type BoardCapabilities = {
  tree: "flat" | "nested";   // flat = thread (rebuild parent map, multi-level) · nested = section (one level + children[])
  canEditOwn: boolean;       // thread true · section false
  canDeleteOwn: boolean;     // thread true · section false
  richInput: boolean;        // true → shared <Composer> (md/LaTeX) · false → plain textarea
  showAuthorLink: boolean;   // links the author to their profile
  // No moderator capability on purpose (ticket #65): Edit/Delete belong to a comment's author
  // alone — operators included. Moderation is ArtaMod's set-aside flag, never editing others' words.
};

// Whether the viewer may write, and if not, why — drives the composer slot.
export type BoardWriteState =
  | { kind: "open" }
  | { kind: "needs-login"; loginUrl: string }
  | { kind: "needs-enrol"; priceLabel: string; courseUrl: string }
  // enrolled, but posting needs a name + birthday first — prompt for it INLINE so the
  // member never writes a reply only to be rejected by the server's identity gate.
  | { kind: "needs-identity" };

export const THREAD_CAPS: BoardCapabilities = {
  tree: "flat", canEditOwn: true, canDeleteOwn: true, richInput: true, showAuthorLink: true,
};
export const SECTION_CAPS: BoardCapabilities = {
  tree: "nested", canEditOwn: false, canDeleteOwn: false, richInput: false, showAuthorLink: true,
};
