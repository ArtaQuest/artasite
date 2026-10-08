/** The mention payload WordPress sends (Arta::payload). Only public data. */
export type Author = { handle: string; name: string; is_arta?: boolean } | null;
export type ContextItem = { author: Author; body: string; title?: string };
/** A public file on the mentioning post or a post above it (Arta::attachments_for_posts). */
export type Attachment = {
  name: string; mime: string; bytes: number; url: string;
  from: "mention" | "parent"; post_id: number;
  skip: "" | "type" | "size" | "count";   // why the site lists it without handing it over
};
export type Mention = {
  id: number;
  hint: string;              // 'bug' when the member wrote an explicit bug: prefix
  created: number;
  max_chars: number;
  source: { type: "post" | "comment"; id: number; url: string; body: string; author: NonNullable<Author> };
  context: ContextItem[];
  attachments?: Attachment[];
};
export type Kind = "answer" | "bug" | "declined";
export type BugFields = { title: string; summary: string; steps?: string; expected?: string; actual?: string; area?: string };
export type Decision = { kind: Kind; reply: string; details?: string; bug?: BugFields };
/** A file going OUT with Arta's reply (a generated image, the full text of a long answer). */
export type OutFile = { name: string; mime: string; bytes: Uint8Array };
