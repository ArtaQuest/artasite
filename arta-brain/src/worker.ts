import { prepareAttachments } from "./attachments";
import { fileBug, deriveBug } from "./bugs";
import type { Config } from "./config";
import { type Engine, type EngineAnswer, EngineBusy, EngineDown } from "./engine";
import type { Fetch } from "./http";
import type { GitHub } from "./github";
import { parseDecision, promptText } from "./prompt";
import { clip } from "./text";
import type { Mention, OutFile } from "./types";
import type { WpClient } from "./wp";

export type Deps = { cfg: Config; wp: WpClient; engine: Engine; gh: GitHub | null; log: (msg: string) => void; onPrompt?: () => void; fetch?: Fetch };
export type Outcome = "not-claimed" | "replied" | "bug-filed" | "bug-duplicate" | "bug-capped" | "dry-run";

const ISSUES_PAGE = "https://artaquest.com/issues/";

/** Reply text that leaves room for a link at the end, within the mention's character budget. */
function withLink(text: string, url: string, max: number): string {
  return `${clip(text, Math.max(20, max - url.length - 1))} ${url}`;
}

/**
 * Answer one mention, end to end. Safe to run twice for the same mention: the claim is exclusive on
 * WordPress and the reply is idempotent there.
 *
 * Failure handling:
 *   - the chat engine is busy (usage limit) or down (signed out): the claim is released straight
 *     back to the queue WITHOUT counting an attempt — the mention just waits for Arta to be back —
 *     and the error is re-thrown so the daemon pauses;
 *   - anything else: released for a retry, and marked failed on the last attempt.
 */
export async function handleMention(id: number, d: Deps, attempt = 1, maxAttempts = 3): Promise<Outcome> {
  const m: Mention | null = await d.wp.claim(id);
  if (!m) return "not-claimed";
  try {
    return await answer(m, d);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof EngineBusy || e instanceof EngineDown) {
      try { await d.wp.status(id, "queued", "waiting for Arta"); } catch { /* the claim times out on its own */ }
      throw e;
    }
    d.log(`mention ${id} attempt ${attempt} failed: ${msg}`);
    const last = attempt >= maxAttempts;
    try { await d.wp.status(id, last ? "failed" : "queued", `${last ? "gave up" : "retry"}: ${msg}`); } catch { /* the claim times out on its own */ }
    throw e;
  }
}

/**
 * The files that go out with the reply: never text — only images the chat generated, within the
 * count and size caps. The text is clipped to the post length. The site checks every file again.
 */
export function outgoing(said: string, max: number, produced: OutFile[], cfg: Config): { text: string; files: OutFile[] } {
  const files = produced.filter((f) => f.mime.startsWith("image/") && f.bytes.byteLength > 0 && f.bytes.byteLength <= cfg.outFileBytes);
  return { text: clip(said, max), files: files.slice(0, cfg.outFilesMax) };
}

async function answer(m: Mention, d: Deps): Promise<Outcome> {
  const max = m.max_chars || 280;
  const prep = await prepareAttachments(m, d.cfg, d.fetch ?? fetch);
  let got: EngineAnswer;
  try {
    if (prep.notAttached.length) d.log(`mention ${m.id}: ${prep.notAttached.length} file(s) not attached (${prep.notAttached.map((n) => n.why).join(", ")})`);
    d.onPrompt?.();
    const raw = await d.engine.ask(promptText(m, prep), d.cfg.answerTimeoutSec * 1000, prep.paths);
    got = typeof raw === "string" ? { text: raw, files: [] } : raw;
  } finally {
    await prep.cleanup();   // the downloaded copies never outlive the prompt
  }
  const dec = parseDecision(got.text);
  // The member's own "bug:" prefix always files a report (unless the request was declined).
  if (m.hint === "bug" && dec.kind !== "declined") dec.kind = "bug";
  const said = dec.reply.trim() || (dec.kind === "bug" ? "Thanks for reporting this — I've passed it to the team." : "");
  if (!said) throw new Error("empty answer");

  const out = dec.kind === "declined" ? { text: clip(said, max), files: [] as OutFile[] } : outgoing(said, max, got.files, d.cfg);

  if (d.cfg.dryRun) {
    const fl = out.files.map((f) => `${f.name} (${f.mime}, ${f.bytes.byteLength} B)`).join(", ");
    d.log(`dry-run mention ${m.id}: kind=${dec.kind}${got.mode ? ` mode=${got.mode}` : ""} reply=${JSON.stringify(out.text)}${fl ? ` files=[${fl}]` : ""}`);
    await d.wp.status(m.id, "queued", "dry run");
    return "dry-run";
  }

  if (dec.kind === "bug" && d.gh) {
    const bug = dec.bug && dec.bug.title ? dec.bug : deriveBug(m);
    const r = await fileBug(m, bug, d.gh, d.cfg);
    if (r.status === "capped") {
      await d.wp.reply(m.id, withLink(`${said} I can't file more reports today, so please add the details here:`, ISSUES_PAGE, max), "answer");
      return "bug-capped";
    }
    const lead = r.status === "duplicate" ? `${said} This is already being tracked:` : `${said} I've filed it:`;
    await d.wp.reply(m.id, withLink(lead, r.issue.url, max), "bug", { url: r.issue.url, title: r.issue.title });
    return r.status === "duplicate" ? "bug-duplicate" : "bug-filed";
  }

  const res = await d.wp.reply(m.id, out.text, dec.kind === "bug" ? "answer" : dec.kind, undefined, out.files);
  if (res?.dropped?.length) d.log(`mention ${m.id}: site dropped file(s): ${res.dropped.join(", ")}`);
  return "replied";
}
