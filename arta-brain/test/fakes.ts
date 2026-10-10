import { loadConfig, type Config } from "../src/config";
import type { Engine, EngineAnswer } from "../src/engine";
import type { Fetch } from "../src/http";
import type { Mention } from "../src/types";

export const cfg = (over: Partial<Config> = {}): Config => ({
  ...loadConfig({ HOME: "/tmp/arta-brain-test" }),
  wpBase: "https://wp.test", replyToken: "t".repeat(40), chatUrl: "https://chat.test/",
  githubToken: "gh", githubRepo: "ArtaQuest/artasite", bugsPerUserPerDay: 2, bugsPerDay: 3, dryRun: false,
  pollSec: 10, idlePollSec: 30, minGapSec: 45, perHour: 30, perDay: 300, answerTimeoutSec: 60, downPauseSec: 600, busyPauseSec: 3600, ...over,
});

export const mention = (over: Partial<Mention> = {}): Mention => ({
  id: 11, hint: "", created: 1, max_chars: 280,
  source: { type: "post", id: 5, url: "https://artaquest.com/works/?post=5", body: "@arta what is a p-value?", author: { handle: "ada", name: "Ada" } },
  context: [], ...over,
});

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

type Answer = string | Error | EngineAnswer;

/** A fake network (WordPress + GitHub, recording every call) and a fake chat engine. */
export function fakeNet(opts: { llm?: Answer | ((n: number) => Answer); mention?: Mention | null; issues?: unknown[]; claimStatus?: number; replyStatus?: number; pending?: Mention[]; files?: Record<string, Uint8Array> }) {
  const calls: Call[] = [];
  const issues: Record<string, unknown>[] = (opts.issues as Record<string, unknown>[]) ?? [];
  let llmN = 0;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  const f: Fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) || {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown;
    if (init.body instanceof FormData) {
      const o: Record<string, unknown> = { files: [] as { name: string; type: string; size: number; text: string }[] };
      const entries: [string, FormDataEntryValue][] = [];
      init.body.forEach((v, k) => entries.push([k, v]));
      for (const [k, v] of entries) {
        if (typeof v === "string") o[k] = v;
        else (o.files as unknown[]).push({ field: k, name: (v as File).name, type: v.type, size: v.size, text: await v.text() });
      }
      body = o;
    } else body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers, body });
    if (url.startsWith("https://wp.test/wp-json/aq/v1/")) {
      const p = url.slice("https://wp.test/wp-json/aq/v1/".length);
      if (headers["x-arta-token"] !== "t".repeat(40)) return json(401, { code: "forbidden" });
      if (/^arta\/mentions\/\d+\/claim$/.test(p)) {
        if (opts.claimStatus) return json(opts.claimStatus, { code: "x" });
        return opts.mention === null ? json(409, { code: "not_claimable" }) : json(200, { ok: true, mention: opts.mention ?? mention() });
      }
      if (/^arta\/mentions\/\d+\/status$/.test(p)) return json(200, { ok: true });
      if (p === "arta/reply") return opts.replyStatus ? json(opts.replyStatus, { code: "x" }) : json(200, { ok: true, duplicate: false, url: "https://artaquest.com/works/?post=99" });
      if (p === "arta/pending") return json(200, { items: opts.pending ?? [mention({ id: 21 }), mention({ id: 22 })] });
      return json(404, {});
    }
    if (url.startsWith("https://cdn.test/")) {
      const f = opts.files?.[url];
      if (f === undefined) return new Response("nope", { status: 404 });
      return new Response(f, { status: 200, headers: f.byteLength > 0 ? { "content-length": String(f.byteLength) } : {} });
    }
    if (url.startsWith("https://api.github.com/repos/ArtaQuest/artasite/issues")) {
      if (headers.authorization !== "Bearer gh") return json(401, {});
      if (method === "POST") {
        const n = 100 + issues.length;
        const row = { number: n, html_url: `https://github.com/ArtaQuest/artasite/issues/${n}`, title: (body as { title: string }).title, body: (body as { body: string }).body, state: "open", created_at: new Date().toISOString(), labels: (body as { labels: string[] }).labels };
        issues.unshift(row);
        return json(201, row);
      }
      return json(200, issues);
    }
    return json(404, {});
  };
  const prompts: string[] = [];
  const followUps: string[] = [];
  const attached: { path: string; bytes: number; exists: boolean }[][] = [];
  const engine: Engine = {
    async ask(prompt: string, _t: number, files: string[] = [], followUp?: (t: string) => string | null) {
      llmN++;
      prompts.push(prompt);
      const { statSync } = await import("node:fs");
      attached.push(files.map((path) => ({ path, bytes: statSync(path).size, exists: true })));
      const out = typeof opts.llm === "function" ? opts.llm(llmN) : (opts.llm ?? JSON.stringify({ kind: "answer", reply: "A p-value is…" }));
      if (out instanceof Error) throw out;
      const next = followUp?.(typeof out === "string" ? out : out.text);
      if (next) followUps.push(next);
      return out;
    },
    async close() {},
  };
  return { f, calls, issues, engine, prompts, followUps, attached, llmCount: () => llmN };
}
