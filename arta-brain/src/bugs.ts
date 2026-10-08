import { createHash } from "node:crypto";
import type { Config } from "./config";
import type { GitHub, Issue } from "./github";
import { redact, similarity, stripLead } from "./text";
import type { BugFields, Mention } from "./types";

export type FileResult =
  | { status: "filed"; issue: Issue }
  | { status: "duplicate"; issue: Issue }
  | { status: "capped"; scope: "user" | "global" };

/** Same bug, same fingerprint: the normalised title and area. */
export function fingerprint(b: BugFields): string {
  const norm = (s?: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(`${norm(b.title)}|${norm(b.area)}`).digest("hex").slice(0, 16);
}

/** A bug description when the model gave none (an explicit "bug:" the model did not classify). */
export function deriveBug(m: Mention): BugFields {
  const text = stripLead(m.source.body).replace(/\s+/g, " ");
  return { title: text.slice(0, 80) || "Bug reported to @arta", summary: text, area: "" };
}

/** GitHub @mentions in quoted member text would ping unrelated GitHub users — break them. */
const quiet = (s: string) => redact(s).replace(/@(?=[A-Za-z0-9])/g, "@\u200b");

export function issueBody(m: Mention, b: BugFields, fp: string): string {
  const sec = (h: string, v?: string) => (v && v.trim() ? `### ${h}\n${quiet(v.trim())}\n\n` : "");
  return [
    `Reported in public by ArtaQuest member \`${m.source.author.handle}\` via Arta.`,
    "",
    `**Where:** ${m.source.url}`,
    b.area ? `**Area:** ${quiet(b.area)}` : "",
    "",
    sec("Summary", b.summary) + sec("Steps to reproduce", b.steps) + sec("Expected", b.expected) + sec("Actual", b.actual),
    "<details><summary>Original public message</summary>",
    "",
    quiet(m.source.body).split("\n").map((l) => `> ${l}`).join("\n"),
    "",
    "</details>",
    "",
    `<!-- arta-fp:${fp} arta-reporter:${m.source.author.handle} arta-mention:${m.id} -->`,
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/**
 * File one bug — or point at the issue that already tracks it. Order matters: an issue already
 * filed for THIS mention (a retry) wins; then a fingerprint or title match among Arta's recent
 * issues; then the daily caps; only then a new issue.
 */
export async function fileBug(m: Mention, b: BugFields, gh: GitHub, cfg: Config, now = new Date()): Promise<FileResult> {
  const fp = fingerprint(b);
  const recent = await gh.recent();
  const mine = recent.find((i) => i.body.includes(`arta-mention:${m.id} `) || i.body.includes(`arta-mention:${m.id} -->`));
  if (mine) return { status: "filed", issue: mine };
  // Only OPEN issues absorb a new report: a bug that comes back after its issue was closed is news.
  const same = recent.find((i) => i.state === "open" && i.body.includes(`arta-fp:${fp}`))
    ?? recent.find((i) => i.state === "open" && similarity(i.title.replace(/^\[Arta\]\s*/, ""), b.title) >= 0.6);
  if (same) return { status: "duplicate", issue: same };

  const day = now.toISOString().slice(0, 10);
  const today = recent.filter((i) => i.created.slice(0, 10) === day);
  if (today.filter((i) => i.body.includes(`arta-reporter:${m.source.author.handle} `)).length >= cfg.bugsPerUserPerDay) return { status: "capped", scope: "user" };
  if (today.length >= cfg.bugsPerDay) return { status: "capped", scope: "global" };

  const title = `[Arta] ${quiet(b.title).slice(0, 110)}`;
  const issue = await gh.create(title, issueBody(m, b, fp), ["bug", "from-arta"]);
  return { status: "filed", issue };
}
