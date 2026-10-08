import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fingerprint, issueBody } from "../src/bugs";
import { Daemon } from "../src/daemon";
import { EngineBusy, EngineDown } from "../src/engine";
import { GitHub } from "../src/github";
import { Pacer } from "../src/pacer";
import { parseDecision, promptText, systemPrompt } from "../src/prompt";
import { clip, redact, similarity } from "../src/text";
import { handleMention } from "../src/worker";
import { WpClient } from "../src/wp";
import { cfg, fakeNet, mention } from "./fakes";

const deps = (net: ReturnType<typeof fakeNet>, over = {}) => {
  const c = cfg(over);
  return { cfg: c, wp: new WpClient(c, net.f), engine: net.engine, gh: new GitHub(c.githubToken, c.githubRepo, net.f), log: () => {} };
};

test("system prompt: Arta's identity, no vendor or model names, injection rule", () => {
  const p = systemPrompt(280);
  assert.match(p, /You are Arta/);
  assert.match(p, /untrusted content/);
  assert.doesNotMatch(p, /\b(gpt|openai|llama|gemini|mistral|claude|anthropic|grok|xai)/i);
  const one = promptText(mention({ hint: "bug" }));
  assert.match(one, /explicitly marked this as a bug/);
  assert.ok(one.indexOf("You are Arta") < one.indexOf("<<<"), "instructions first, member text after, fenced");
});

test("parseDecision tolerates fences and garbage", () => {
  assert.deepEqual(parseDecision('```json\n{"kind":"declined","reply":"No."}\n```'), { kind: "declined", reply: "No." });
  assert.equal(parseDecision("just text").kind, "answer");
  assert.equal(parseDecision('{"kind":"weird","reply":"x"}').kind, "answer");
  assert.equal(parseDecision('{"kind":"bug","reply":"t","bug":{"title":"Feed blank"}}').bug?.title, "Feed blank");
});

test("text helpers: clip, redact, similarity", () => {
  assert.ok(clip("word ".repeat(100), 50).length <= 50);
  assert.equal(redact("mail ada@example.com or +1 (555) 010-9999"), "mail [email removed] or [number removed]");
  assert.ok(similarity("Wallet shows NaN coins", "wallet shows NaN coin balance") >= 0.5);
  assert.ok(similarity("Login loops forever", "Music player skips") < 0.2);
});

test("an answer: claim → chat engine → one public reply", async () => {
  const net = fakeNet({});
  assert.equal(await handleMention(11, deps(net)), "replied");
  const reply = net.calls.find((c) => c.url.endsWith("/arta/reply"));
  assert.deepEqual(reply?.body, { mention_id: 11, body: "A p-value is…", kind: "answer" });
  assert.equal(net.calls.filter((c) => c.url.startsWith("https://api.github.com")).length, 0, "no GitHub for an answer");
  assert.equal(net.prompts.length, 1);
  assert.match(net.prompts[0], /@arta what is a p-value\?/);
});

test("not claimable (another worker has it) → no model call, no reply", async () => {
  const net = fakeNet({ mention: null });
  assert.equal(await handleMention(11, deps(net)), "not-claimed");
  assert.equal(net.llmCount(), 0);
});

test("a bug: files one labelled issue with public data only, replies with the link", async () => {
  const m = mention({ hint: "bug", source: { ...mention().source, body: "@arta bug: the wallet shows NaN coins. email me ada@example.com" } });
  const net = fakeNet({ mention: m, llm: JSON.stringify({ kind: "bug", reply: "Thanks Ada!", bug: { title: "Wallet shows NaN coins", summary: "Balance renders as NaN", area: "Wallet" } }) });
  assert.equal(await handleMention(11, deps(net)), "bug-filed");
  const created = net.calls.find((c) => c.method === "POST" && c.url.includes("api.github.com"));
  const b = created?.body as { title: string; body: string; labels: string[] };
  assert.deepEqual(b.labels, ["bug", "from-arta"]);
  assert.match(b.title, /^\[Arta\] Wallet shows NaN coins/);
  assert.doesNotMatch(b.body, /ada@example\.com/, "no private data in the issue");
  assert.doesNotMatch(b.body, /@arta\b/, "no raw @mentions that would ping GitHub users");
  assert.match(b.body, /arta-mention:11 /);
  const reply = net.calls.find((c) => c.url.endsWith("/arta/reply"))?.body as { body: string; kind: string; issue_url: string };
  assert.equal(reply.kind, "bug");
  assert.equal(reply.issue_url, "https://github.com/ArtaQuest/artasite/issues/100");
  assert.ok(reply.body.endsWith("https://github.com/ArtaQuest/artasite/issues/100") && reply.body.length <= 280);
});

test("a duplicate bug points at the open issue instead of filing again", async () => {
  const fp = fingerprint({ title: "Wallet shows NaN coins", summary: "", area: "Wallet" });
  const existing = { number: 7, html_url: "https://github.com/ArtaQuest/artasite/issues/7", title: "[Arta] Wallet shows NaN coins", body: `x <!-- arta-fp:${fp} arta-reporter:bob arta-mention:3 -->`, state: "open", created_at: "2026-10-01T00:00:00Z" };
  const net = fakeNet({ issues: [existing], llm: JSON.stringify({ kind: "bug", reply: "Thanks!", bug: { title: "Wallet shows NaN coins", summary: "", area: "Wallet" } }) });
  assert.equal(await handleMention(11, deps(net)), "bug-duplicate");
  assert.equal(net.calls.filter((c) => c.method === "POST" && c.url.includes("api.github.com")).length, 0);
  const reply = net.calls.find((c) => c.url.endsWith("/arta/reply"))?.body as { issue_url: string };
  assert.equal(reply.issue_url, existing.html_url);
});

test("a retry after filing reuses the issue for that mention (no second issue)", async () => {
  const llm = JSON.stringify({ kind: "bug", reply: "Thanks!", bug: { title: "Feed is blank", summary: "", area: "Feed" } });
  const net = fakeNet({ llm, replyStatus: 503 });
  await assert.rejects(handleMention(11, deps(net), 1, 5));
  assert.equal(net.issues.length, 1);
  const status = net.calls.find((c) => c.url.endsWith("/status"))?.body as { status: string };
  assert.equal(status.status, "queued", "claim released for the retry");
  const net2 = fakeNet({ llm, issues: net.issues });
  assert.equal(await handleMention(11, deps(net2)), "bug-filed");
  assert.equal(net2.issues.length, 1, "still one issue");
});

test("daily caps: per member, then global", async () => {
  const today = new Date().toISOString();
  const mk = (n: number, who: string) => ({ number: n, html_url: `https://github.com/ArtaQuest/artasite/issues/${n}`, title: `[Arta] thing ${n} ${who}`, body: `<!-- arta-fp:${n} arta-reporter:${who} arta-mention:${n} -->`, state: "closed", created_at: today });
  const llm = (t: string) => JSON.stringify({ kind: "bug", reply: "Thanks!", bug: { title: t, summary: "", area: "" } });
  const user = fakeNet({ issues: [mk(1, "ada"), mk(2, "ada")], llm: llm("Brand new problem one") });
  assert.equal(await handleMention(11, deps(user)), "bug-capped");
  const r = user.calls.find((c) => c.url.endsWith("/arta/reply"))?.body as { kind: string; body: string };
  assert.equal(r.kind, "answer");
  assert.match(r.body, /artaquest\.com\/issues\//);
  const global = fakeNet({ issues: [mk(1, "bob"), mk(2, "cy"), mk(3, "dee")], llm: llm("Brand new problem two") });
  assert.equal(await handleMention(11, deps(global)), "bug-capped");
});

test("an engine error: claim released for a retry; the last attempt marks it failed", async () => {
  const net = fakeNet({ llm: () => new Error("busy") });
  await assert.rejects(handleMention(11, deps(net), 2, 5));
  assert.equal((net.calls.find((c) => c.url.endsWith("/status"))?.body as { status: string }).status, "queued");
  const net2 = fakeNet({ llm: () => new Error("busy") });
  await assert.rejects(handleMention(11, deps(net2), 5, 5));
  assert.equal((net2.calls.find((c) => c.url.endsWith("/status"))?.body as { status: string }).status, "failed");
});

test("a declined request is replied to as declined and never filed", async () => {
  const net = fakeNet({ mention: mention({ hint: "bug" }), llm: JSON.stringify({ kind: "declined", reply: "I can't help with that." }) });
  assert.equal(await handleMention(11, deps(net)), "replied");
  assert.equal((net.calls.find((c) => c.url.endsWith("/arta/reply"))?.body as { kind: string }).kind, "declined");
  assert.equal(net.issues.length, 0);
});

test("dry run composes but writes nothing", async () => {
  const net = fakeNet({});
  assert.equal(await handleMention(11, deps(net, { dryRun: true })), "dry-run");
  assert.equal(net.calls.filter((c) => c.url.endsWith("/arta/reply")).length, 0);
});

test("issue body is public-only and carries the fingerprint", () => {
  const b = issueBody(mention(), { title: "T", summary: "call +44 20 7946 0958", area: "Feed" }, "abc");
  assert.match(b, /arta-fp:abc arta-reporter:ada arta-mention:11/);
  assert.doesNotMatch(b, /7946/);
});

test("busy or signed-out engine: the mention goes back to the queue, no attempt spent, nothing paid", async () => {
  for (const err of [new EngineBusy(Date.now() + 1000), new EngineDown("signed out")]) {
    const net = fakeNet({ llm: () => err });
    await assert.rejects(handleMention(11, deps(net), 3, 3));
    const st = net.calls.find((c) => c.url.endsWith("/status"))?.body as { status: string; note: string };
    assert.equal(st.status, "queued", "never 'failed' just because Arta is away");
    assert.equal(st.note, "waiting for Arta");
    assert.equal(net.calls.filter((c) => c.url.endsWith("/arta/reply")).length, 0, "no canned reply that would use up the one reply slot");
  }
});

test("pacer: min gap, hourly and daily caps, pause; survives a restart", () => {
  const file = `/tmp/arta-pacer-${process.pid}.json`;
  const lim = { minGapSec: 45, perHour: 3, perDay: 5 };
  const p = new Pacer(lim, file);
  const t0 = 1_800_000_000_000;
  assert.equal(p.waitMs(t0), 0);
  p.take(t0);
  assert.equal(p.waitMs(t0 + 1000), 44_000, "min gap");
  p.take(t0 + 45_000); p.take(t0 + 90_000);
  assert.equal(p.waitMs(t0 + 135_000), 3_600_000 - 135_000, "hourly cap: waits for the oldest to age out");
  p.take(t0 + 3_600_001); p.take(t0 + 3_650_000);
  assert.ok(p.waitMs(t0 + 3_700_000) >= 86_400_000 - 3_700_000, "daily cap");
  const again = new Pacer(lim, file);
  assert.deepEqual(again.usage(t0 + 3_700_000), { lastHour: 2, lastDay: 5 }, "state persisted");
  require("node:fs").rmSync(file, { force: true });
  const q = new Pacer(lim);
  q.pause(t0 + 600_000, "down");
  assert.equal(q.waitMs(t0), 600_000);
  q.clearPause();
  assert.equal(q.waitMs(t0), 0);
});

test("daemon: answers one mention per tick at the pacer's pace, heartbeats while waiting", async () => {
  let now = 1_800_000_000_000;
  const net = fakeNet({ pending: [mention({ id: 21 }), mention({ id: 22 })] });
  const pacer = new Pacer({ minGapSec: 45, perHour: 30, perDay: 300 });
  const d = new Daemon(deps(net), pacer, () => now);
  assert.equal(await d.tick(), 10_000);
  assert.equal(net.prompts.length, 1, "one mention per tick");
  now += 10_000;
  const wait = await d.tick();
  assert.equal(wait, 35_000, "waits out the min gap");
  assert.equal(net.prompts.length, 1, "no second prompt inside the gap");
  const polls = net.calls.filter((c) => c.url.endsWith("/arta/pending"));
  assert.equal(polls.length, 2, "but still polls (the heartbeat)");
  assert.equal((polls[1].body as { paused_until: number }).paused_until, 0);
});

test("daemon: a usage limit pauses Arta and tells the site when it is back", async () => {
  let now = 1_800_000_000_000;
  const until = now + 3_600_000;
  const net = fakeNet({ pending: [mention({ id: 21 })], llm: () => new EngineBusy(until) });
  const pacer = new Pacer({ minGapSec: 45, perHour: 30, perDay: 300 });
  const d = new Daemon(deps(net), pacer, () => now);
  await d.tick();
  assert.equal(pacer.pausedUntil, until);
  now += 60_000;
  assert.equal(await d.tick(), 60_000, "keeps polling once a minute while paused");
  const last = net.calls.filter((c) => c.url.endsWith("/arta/pending")).pop()?.body as { paused_until: number };
  assert.equal(last.paused_until, Math.ceil(until / 1000));
  assert.equal(net.prompts.length, 1, "no prompt while paused");
});

test("daemon: a mention that keeps failing is given up after 3 attempts, then skipped", async () => {
  let now = 1_800_000_000_000;
  const net = fakeNet({ pending: [mention({ id: 21 })], llm: () => new Error("page changed") });
  const d = new Daemon(deps(net), new Pacer({ minGapSec: 45, perHour: 30, perDay: 300 }), () => now);
  for (let i = 0; i < 5; i++) { await d.tick(); now += 60_000; }
  assert.equal(net.prompts.length, 3);
  const statuses = net.calls.filter((c) => c.url.endsWith("/status")).map((c) => (c.body as { status: string }).status);
  assert.deepEqual(statuses, ["queued", "queued", "failed"]);
});
