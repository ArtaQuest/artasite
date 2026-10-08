/** The mention payload WordPress sends (Arta::payload). Only public data. */
export type Author = { handle: string; name: string; is_arta?: boolean } | null;
export type ContextItem = { author: Author; body: string; title?: string };
export type Mention = {
  id: number;
  hint: string;              // 'bug' when the member wrote an explicit bug: prefix
  created: number;
  max_chars: number;
  source: { type: "post" | "comment"; id: number; url: string; body: string; author: NonNullable<Author> };
  context: ContextItem[];
};
export type Kind = "answer" | "bug" | "declined";
export type BugFields = { title: string; summary: string; steps?: string; expected?: string; actual?: string; area?: string };
export type Decision = { kind: Kind; reply: string; bug?: BugFields };
