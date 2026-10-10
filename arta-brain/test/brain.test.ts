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
import { launchOptions } from "../src/browser";
import { loadConfig } from "../src/config";
import { existsSync } from "node:fs";
import { prepareAttachments } from "../src/attachments";
import { solidPng, sniffMime } from "../src/files";
import { outgoing } from "../src/worker";
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

test("daemon: a dry-run answer is remembered across a restart; the live run then answers it once", async () => {
  const file = `/tmp/arta-dry-${process.pid}.json`;
  require("node:fs").rmSync(file, { force: true });
  let now = 1_800_000_000_000;
  const lim = { minGapSec: 45, perHour: 30, perDay: 300 };
  const net = fakeNet({ pending: [mention({ id: 31 })] });
  const d1 = new Daemon(deps(net, { dryRun: true }), new Pacer(lim), () => now, file);
  await d1.tick();
  assert.equal(net.prompts.length, 1);
  now += 120_000; await d1.tick();
  assert.equal(net.prompts.length, 1, "not asked again by the same process");
  const d2 = new Daemon(deps(net, { dryRun: true }), new Pacer(lim), () => now, file); // the agent restarted
  now += 120_000; await d2.tick();
  assert.equal(net.prompts.length, 1, "not asked again after a restart");
  assert.equal(net.calls.filter((c) => c.url.endsWith("/arta/reply")).length, 0);
  const live = new Daemon(deps(net), new Pacer(lim), () => now, file); // ARTA_DRY_RUN=0
  now += 120_000; await live.tick();
  assert.equal(net.prompts.length, 2, "the live run answers it");
  assert.equal(net.calls.filter((c) => c.url.endsWith("/arta/reply")).length, 1);
  require("node:fs").rmSync(file, { force: true });
});

test("browser launch: Playwright Chromium on Linux; installed Chrome with the real Keychain on a Mac", () => {
  const linux = launchOptions(loadConfig({ HOME: "/h" }), true, "linux");
  assert.equal(linux.channel, undefined);
  assert.equal(linux.ignoreDefaultArgs, undefined);
  assert.deepEqual(linux.args, ["--disable-dev-shm-usage"]);
  const mac = launchOptions(loadConfig({ HOME: "/h", ARTA_BROWSER_CHANNEL: "chrome", ARTA_HEADLESS: "0" }), false, "darwin");
  assert.equal(mac.channel, "chrome");
  assert.equal(mac.headless, false);
  assert.deepEqual(mac.ignoreDefaultArgs, ["--use-mock-keychain"], "keeps the sign-in made in plain Chrome readable");
  assert.equal(loadConfig({ ARTA_SEL_NEW_CHAT: "#new" }).sel.newChat, "#new");
  assert.equal(loadConfig({ ARTA_PROFILE_DIR: "/x/chrome-profile" }).profileDir, "/x/chrome-profile");
});

const att = (over: Partial<import("../src/types").Attachment>) => ({ name: "plot.png", mime: "image/png", bytes: 0, url: "https://cdn.test/plot.png", from: "parent" as const, post_id: 4, skip: "" as const, ...over });

test("attachments IN: downloaded to a temp dir, caps and reasons, https only, cleaned up", async () => {
  const png = solidPng(4, 4, [255, 0, 0]);
  const big = new Uint8Array(2 * 1024 * 1024 + 10);
  const net = fakeNet({ files: { "https://cdn.test/plot.png": png, "https://cdn.test/big.png": big, "https://cdn.test/liar.png": big } });
  const m = mention({ attachments: [
    att({ bytes: png.byteLength }),
    att({ name: "model.zip", mime: "application/zip", url: "https://cdn.test/model.zip", bytes: 10, skip: "type" }),
    att({ name: "big.png", url: "https://cdn.test/big.png", bytes: big.byteLength }),
    att({ name: "liar.png", url: "https://cdn.test/liar.png", bytes: 100 }),             // claims 100 B, sends 2 MB
    att({ name: "local.png", url: "http://10.0.0.4/x.png", bytes: 10 }),
    att({ name: "gone.png", url: "https://cdn.test/gone.png", bytes: 10 }),
  ] });
  const p = await prepareAttachments(m, cfg({ attachBytes: 1024 * 1024 }), net.f);
  assert.equal(p.paths.length, 1);
  assert.ok(existsSync(p.paths[0]) && p.paths[0].endsWith("1-plot.png"));
  const why = Object.fromEntries(p.notAttached.map((n) => [n.a.name, n.why]));
  assert.deepEqual(why, { "model.zip": "type not supported", "big.png": "too large", "liar.png": "too large", "local.png": "not reachable", "gone.png": "could not be downloaded (404)" });
  await p.cleanup();
  assert.ok(!existsSync(p.paths[0]), "temp files are deleted");
  const many = await prepareAttachments(mention({ attachments: [1, 2, 3].map((i) => att({ name: `p${i}.png`, bytes: png.byteLength })) }), cfg({ attachMax: 2 }), net.f);
  assert.equal(many.paths.length, 2);
  assert.equal(many.notAttached[0].why, "too many files");
  await many.cleanup();
});

test("prompt lists the attached files and the ones that could not be attached", () => {
  const a = att({ bytes: 120_000 });
  const t = promptText(mention(), { attached: [a], notAttached: [{ a: att({ name: "model.zip", mime: "application/zip", bytes: 5_000_000 }), why: "type not supported" }] });
  assert.match(t, /Files attached to this message[^\n]*\n1\. plot\.png \(image\/png, 117 KB\) — on an earlier post in the thread/);
  assert.match(t, /could NOT be attached[^\n]*\n- model\.zip \(application\/zip, 4\.8 MB\) — type not supported/);
  assert.doesNotMatch(t, /"details"/);
  assert.equal((parseDecision('{"kind":"answer","reply":"short","details":"# Long"}') as Record<string, unknown>).details, undefined, "details is ignored");
});

test("a mention with a picture: the file reaches the engine, then the temp copy is gone", async () => {
  const png = solidPng(4, 4, [0, 0, 255]);
  const m = mention({ attachments: [att({ bytes: png.byteLength })] });
  const net = fakeNet({ mention: m, files: { "https://cdn.test/plot.png": png } });
  const out = await handleMention(11, { cfg: cfg(), wp: new WpClient(cfg(), net.f), engine: net.engine, gh: null, log: () => {}, fetch: net.f });
  assert.equal(out, "replied");
  assert.equal(net.attached[0].length, 1);
  assert.equal(net.attached[0][0].bytes, png.byteLength);
  assert.ok(!existsSync(net.attached[0][0].path), "deleted after the prompt");
  assert.match(net.prompts[0], /1\. plot\.png \(image\/png/);
});

test("files OUT: a long answer is trimmed, never attached as text; images ride along (multipart)", async () => {
  const long = "word ".repeat(120).trim();
  const img = solidPng(128, 128, [30, 144, 255]);
  const net = fakeNet({ llm: { text: JSON.stringify({ kind: "answer", reply: long }), files: [{ name: "square-1.png", mime: "image/png", bytes: img }] } });
  const out = await handleMention(11, { cfg: cfg(), wp: new WpClient(cfg(), net.f), engine: net.engine, gh: null, log: () => {} });
  assert.equal(out, "replied");
  const r = net.calls.find((c) => c.url.endsWith("/arta/reply"))!;
  const b = r.body as { body: string; files: { field: string; name: string; type: string; size: number; text: string }[]; mention_id: string };
  assert.ok(b.body.length <= 280 && !b.body.includes("…"), "the public reply is fitted to the limit, never with an ellipsis");
  assert.equal(b.mention_id, "11");
  assert.deepEqual(b.files.map((f) => [f.field, f.name, f.type]), [["files[]", "square-1.png", "image/png"]]);
  assert.equal(r.headers["x-arta-token"], "t".repeat(40));
});

test("outgoing(): no text files ever, only images, caps hold, text clipped", () => {
  const c = cfg({ outFilesMax: 2, outFileBytes: 1000 });
  assert.deepEqual(outgoing("short", 280, [], c), { text: "short", files: [] });
  const big = { name: "huge.png", mime: "image/png", bytes: new Uint8Array(5000) };
  const ok = { name: "ok.png", mime: "image/png", bytes: new Uint8Array(10) };
  const md = { name: "x.md", mime: "text/markdown", bytes: new Uint8Array(10) };
  const pdf = { name: "x.pdf", mime: "application/pdf", bytes: new Uint8Array(10) };
  assert.deepEqual(outgoing("short", 280, [md, pdf, big, ok, ok, ok], c).files.map((f) => f.name), ["ok.png", "ok.png"]);
  assert.ok(outgoing("word ".repeat(200), 280, [], c).text.length <= 280);
});

test("dry run with files posts nothing and logs what would be attached", async () => {
  const logs: string[] = [];
  const net = fakeNet({ llm: { text: JSON.stringify({ kind: "answer", reply: "Here.", details: "full" }), files: [{ name: "g-1.png", mime: "image/png", bytes: solidPng(8, 8, [1, 2, 3]) }], mode: "Expert" } });
  const out = await handleMention(11, { cfg: cfg({ dryRun: true }), wp: new WpClient(cfg(), net.f), engine: net.engine, gh: null, log: (s) => logs.push(s) });
  assert.equal(out, "dry-run");
  assert.equal(net.calls.filter((c) => c.url.endsWith("/arta/reply")).length, 0);
  assert.match(logs.join("\n"), /mode=Expert reply="Here\." files=\[g-1\.png \(image\/png, \d+ B\)\]/);
});

test("config: top-effort defaults, sniffing, and the generated PNG", () => {
  const c = loadConfig({});
  assert.deepEqual(c.modeLabels, ["Heavy", "Expert", "Thinking", "Auto"]);
  assert.equal(c.answerTimeoutSec, 600);
  assert.deepEqual(loadConfig({ ARTA_MODE_LABELS: "Expert, Auto" }).modeLabels, ["Expert", "Auto"]);
  assert.match("You've reached your Heavy usage limit", new RegExp(c.sel.limitText, "i"));
  assert.equal(sniffMime(solidPng(2, 2, [1, 2, 3])), "image/png");
  assert.equal(sniffMime(new TextEncoder().encode("<svg/>")), "");
});

// ── voice and quoted Ekşi entries (the Okan Tekman example) ─────────────────
import { imagePrompt, stripImageClaims } from "../src/prompt";
import { stripUrls } from "../src/worker";

const EKSI = "https://eksisozluk.com/entry/123456";
const Q = (quote: string, id: number | string) => ({ quote, source: typeof id === "number" ? `https://eksisozluk.com/entry/${id}` : id });

test("prompt: English X-user voice, one witty line, no quotes or links, no allegations", () => {
  const p = systemPrompt(280);
  assert.match(p, /X user/);
  assert.match(p, /ALWAYS reply in English/);
  assert.match(p, /ONE short, witty, original line/);
  assert.match(p, /no quotations, no quotation marks, no links or URLs/);
  assert.doesNotMatch(p, /"lore"|eksisozluk\.com\/entry/);
  assert.match(p, /never repeat allegations/i);
  assert.match(p, /never draw or generate a likeness/);
  assert.match(p, /real photo of them on an official or reputable page/);
  assert.doesNotMatch(p, /legend on Ekşi|as LORE|Cite Ekşi|Ekşi Sözlük has/);
  assert.doesNotMatch(p, /"details"|answer\.md/i);
});

test("parseDecision: lore ignored; image is a text description only, never a URL or object", () => {
  assert.equal((parseDecision(JSON.stringify({ kind: "answer", reply: "hi", lore: [{ quote: "q", source: EKSI }] })) as Record<string, unknown>).lore, undefined);
  assert.equal(parseDecision(JSON.stringify({ kind: "answer", reply: "hi", image: { url: "https://x/y.jpg" } })).image, undefined);
  assert.equal(parseDecision(JSON.stringify({ kind: "answer", reply: "hi", image: "see https://x/y.jpg" })).image, undefined);
  assert.equal(parseDecision(JSON.stringify({ kind: "declined", reply: "no", image: "a cat" })).image, undefined);
  assert.equal(parseDecision(JSON.stringify({ kind: "answer", reply: "hi", image: "  a  b&w chalkboard  " })).image, "a b&w chalkboard");
  assert.match(imagePrompt("a b&w chalkboard."), /^Generate an image now: a b&w chalkboard\. .*not a photorealistic/);
});

test("image claims are cut from the lead-in, the rest stays", () => {
  assert.equal(stripImageClaims("Bilkent's calculus emperor. Black-and-white stylized take attached."), "Bilkent's calculus emperor.");
  assert.equal(stripImageClaims("Campus folklore. Here's a black-and-white stylized illustration of him."), "Campus folklore.");
  assert.equal(stripImageClaims("Legend. Picture below 👇"), "Legend.");
  assert.equal(stripImageClaims("He treats Maple like an oracle."), "He treats Maple like an oracle.");
});

test("Okan Tekman: one short English line, no quotes or links, image attached, no .md", async () => {
  const img = solidPng(512, 512, [128, 128, 128]);
  const lore = [Q("he looks at the logs and the bug fixes itself", 123456), Q("asks one question in the meeting, leaves with the whole roadmap", 654321)];
  const net = fakeNet({ llm: { text: JSON.stringify({ kind: "answer", reply: "Okan Tekman, in the wild 👀", lore }), files: [{ name: "generated-1.png", mime: "image/png", bytes: img }] } });
  assert.equal(await handleMention(11, { cfg: cfg(), wp: new WpClient(cfg(), net.f), engine: net.engine, gh: null, log: () => {} }), "replied");
  const b = net.calls.find((c) => c.url.endsWith("/arta/reply"))!.body as { body: string; files: { name: string; type: string }[] };
  assert.equal(b.body, "Okan Tekman, in the wild 👀", "one line: no quotes, no links");
  assert.ok(b.body.length <= 280);
  assert.doesNotMatch(b.body, /lore|Ekşi'de|on Ekşi/i);
  assert.deepEqual(b.files.map((f) => [f.name, f.type]), [["generated-1.png", "image/png"]]);
});

test("picture asked: second turn requested; no image produced → the reply never claims one", async () => {
  const lore = [Q("comes to class in a t-shirt while it snows", 11594413)];
  const net = fakeNet({ llm: JSON.stringify({ kind: "answer", reply: "Bilkent's calculus legend. Black-and-white stylized take attached.", lore, image: "black-and-white pen sketch of a professor at a chalkboard in the snow" }) });
  assert.equal(await handleMention(12, { cfg: cfg(), wp: new WpClient(cfg(), net.f), engine: net.engine, gh: null, log: () => {} }), "replied");
  assert.equal(net.followUps.length, 1);
  assert.match(net.followUps[0], /^Generate an image now: black-and-white pen sketch/);
  const b = net.calls.find((c) => c.url.endsWith("/arta/reply"))!.body as { body: string };
  assert.equal(b.body, "Bilkent's calculus legend.");
});

test("picture produced: the claim may stay and the image goes out; no picture asked → no second turn", async () => {
  const img = solidPng(512, 512, [0, 0, 0]);
  const net = fakeNet({ llm: { text: JSON.stringify({ kind: "answer", reply: "Legend. Sketch attached.", image: "a chalkboard" }), files: [{ name: "generated-1.jpg", mime: "image/png", bytes: img }] } });
  await handleMention(13, { cfg: cfg(), wp: new WpClient(cfg(), net.f), engine: net.engine, gh: null, log: () => {} });
  const b = net.calls.find((c) => c.url.endsWith("/arta/reply"))!.body as { body: string; files: unknown[] };
  assert.equal(b.body, "Legend. Sketch attached.");
  assert.equal(b.files.length, 1);
  const plain = fakeNet({ llm: JSON.stringify({ kind: "answer", reply: "A p-value is…" }) });
  await handleMention(14, { cfg: cfg(), wp: new WpClient(cfg(), plain.f), engine: plain.engine, gh: null, log: () => {} });
  assert.equal(plain.followUps.length, 0);
});

import { photoOf } from "../src/prompt";
import sharpLib from "sharp";

const PAGE = "https://www.example.edu/people/okan-tekman";
const photoFetch = (bytes: Uint8Array | null) => (async (url: string) => {
  if (url === "https://upload.example.org/okan.jpg" && bytes) return new Response(bytes, { headers: { "content-type": "image/png" } });
  return new Response("nope", { status: 404 });
}) as typeof fetch;

test("photoOf: both https and public, gray only when true", () => {
  assert.deepEqual(photoOf({ url: "https://upload.example.org/okan.jpg", page: PAGE, gray: true }), { url: "https://upload.example.org/okan.jpg", page: PAGE, gray: true });
  assert.equal(photoOf({ url: "http://x.org/a.jpg", page: PAGE }), null);
  assert.equal(photoOf({ url: "https://10.0.0.1/a.jpg", page: PAGE }), null);
  assert.equal(photoOf({ url: "https://x.org/a.jpg" }), null);
  assert.equal(photoOf("https://x.org/a.jpg"), null);
  const d = parseDecision(JSON.stringify({ kind: "answer", reply: "hi", photo: { url: "https://upload.example.org/okan.jpg", page: PAGE }, image: "a likeness" }));
  assert.ok(d.photo && !d.image, "a real photo suppresses image generation");
});

test("real person: real photo attached as grayscale photo.jpg, its page sent as the file source (not in the text), no image turn", async () => {
  const png = solidPng(600, 600, [200, 30, 30]);
  const long = "x".repeat(120);
  const lore = [Q("short legend", 1), Q(long, 2), Q(long, 3)];
  const net = fakeNet({ llm: JSON.stringify({ kind: "answer", reply: "Bilkent's calculus legend.", lore, photo: { url: "https://upload.example.org/okan.jpg", page: PAGE, gray: true }, image: "x" }) });
  await handleMention(15, { cfg: cfg(), wp: new WpClient(cfg(), net.f), engine: net.engine, gh: null, log: () => {}, fetch: photoFetch(png) });
  assert.equal(net.followUps.length, 0);
  const b = net.calls.find((c) => c.url.endsWith("/arta/reply"))!.body as { body: string; sources: string; files: { name: string; type: string }[] };
  assert.ok(!b.body.includes(PAGE) && b.body.length <= 280, b.body);
  assert.deepEqual(JSON.parse(b.sources), { "photo.jpg": PAGE });
  assert.equal(b.body, "Bilkent's calculus legend.");
  assert.deepEqual(b.files.map((f) => [f.name, f.type]), [["photo.jpg", "image/jpeg"]]);
});

test("real person photo fails: no file, no page link, no claim", async () => {
  const net = fakeNet({ llm: JSON.stringify({ kind: "answer", reply: "Calculus legend. Here's a photo of him.", photo: { url: "https://upload.example.org/okan.jpg", page: PAGE } }) });
  await handleMention(16, { cfg: cfg(), wp: new WpClient(cfg(), net.f), engine: net.engine, gh: null, log: () => {}, fetch: photoFetch(null) });
  const b = net.calls.find((c) => c.url.endsWith("/arta/reply"))!.body as { body: string; files: unknown[] };
  assert.equal(b.body, "Calculus legend.");
  assert.equal((b.files ?? []).length, 0);
});

test("fetchPhoto: grayscale really is gray; non-images refused", async () => {
  const { fetchPhoto } = await import("../src/photo");
  const f = await fetchPhoto({ url: "https://upload.example.org/okan.jpg", page: PAGE, gray: true }, 5_000_000, photoFetch(solidPng(300, 300, [200, 30, 30])));
  const st = await sharpLib(Buffer.from(f!.bytes)).stats();
  assert.ok(st.channels.length === 1 || Math.abs(st.channels[0].mean - st.channels[2].mean) < 2);
  assert.equal(await fetchPhoto({ url: "https://upload.example.org/okan.jpg", page: PAGE, gray: false }, 5_000_000, photoFetch(new TextEncoder().encode("<html>"))), null);
});

import { clearFacultyCache, facultyPhoto, nameTokens, sameName } from "../src/faculty";
import { readFileSync } from "node:fs";
import { join as pjoin } from "node:path";

const FAC = readFileSync(pjoin(__dirname, "../../test/fixtures/bilkent-math-faculty.js"), "utf8");
const facFetch = (counter = { n: 0 }, img: Uint8Array | null = null) => (async (url: string) => {
  if (url === "https://math.bilkent.edu.tr/assets/data/faculty.js") { counter.n++; return new Response(FAC); }
  if (img && url === "https://math.bilkent.edu.tr/personnel_photos/tekman-2.jpg") return new Response(img);
  return new Response("no", { status: 404 });
}) as typeof fetch;

test("names: Turkish letters, case, titles and middle names; surname must match", () => {
  assert.deepEqual(nameTokens("Prof. Dr. İnci PEKGÜLEÇ"), ["inci", "pekgulec"]);
  assert.ok(sameName("Mehmet Okan Tekman", "Okan Tekman"));
  assert.ok(sameName("okan tekman", "OKAN TEKMAN"));
  assert.ok(sameName("Inci Pekgulec Apaydin", "İnci Pekgüleç Apaydın"));
  assert.ok(!sameName("Okan Tekin", "Okan Tekman"));
  assert.ok(!sameName("Tekman", "Okan Tekman"));
  assert.ok(!sameName("Ayşe Tekman", "Okan Tekman"));
});

test("faculty photo: unique match at Bilkent → official photo + faculty page; cached; ambiguous/none/other site → null", async () => {
  clearFacultyCache();
  const c = { n: 0 };
  const p = await facultyPhoto({ name: "Mehmet Okan Tekman", affiliation: "Bilkent University" }, true, facFetch(c));
  assert.deepEqual(p, { url: "https://math.bilkent.edu.tr/personnel_photos/tekman-2.jpg", page: "https://math.bilkent.edu.tr/faculty.html", gray: true });
  assert.equal(await facultyPhoto({ name: "Ali Kaya", affiliation: "Bilkent" }, false, facFetch(c)), null, "two Ali Kayas");
  assert.equal(await facultyPhoto({ name: "Ayşe Tekman", affiliation: "Bilkent" }, false, facFetch(c)), null, "no photo");
  assert.equal(await facultyPhoto({ name: "Okan Tekman", affiliation: "Boğaziçi University" }, false, facFetch(c)), null);
  assert.equal(c.n, 1, "faculty data fetched once");
});

test("Okan: no photo from the model → faculty photo attached in B&W with the faculty page link", async () => {
  clearFacultyCache();
  const net = fakeNet({ llm: JSON.stringify({ kind: "answer", reply: "Bilkent's calculus legend.", lore: [Q("t-shirt in the snow", 11594413)], person: { name: "Okan Tekman", affiliation: "Bilkent University" }, gray: true }) });
  await handleMention(17, { cfg: cfg(), wp: new WpClient(cfg(), net.f), engine: net.engine, gh: null, log: () => {}, fetch: facFetch({ n: 0 }, solidPng(400, 400, [200, 30, 30])) });
  assert.equal(net.followUps.length, 0, "no generated likeness");
  const b = net.calls.find((c) => c.url.endsWith("/arta/reply"))!.body as { body: string; sources: string; files: { name: string; type: string }[] };
  assert.equal(b.body, "Bilkent's calculus legend.");
  assert.deepEqual(JSON.parse(b.sources), { "photo.jpg": "https://math.bilkent.edu.tr/faculty.html" });
  assert.deepEqual(b.files.map((f) => [f.name, f.type]), [["photo.jpg", "image/jpeg"]]);
});

import { fitText } from "../src/text";
test("fitText: whole sentences, then a closed clause, never an ellipsis", () => {
  const cv = "Okan Tekman is Bilkent's senior math lecturer (Minnesota PhD '92) and a longtime calculus institution with a reputation that never ends.";
  assert.equal(fitText("A. B is longer here. C", 12), "A.");
  assert.equal(fitText(cv, 80), "Okan Tekman is Bilkent's senior math lecturer.");
  assert.equal(fitText("short", 280), "short");
  for (const n of [20, 50, 100]) assert.ok(!fitText(cv, n).includes("…") && [...fitText(cv, n)].length <= n);
});

test("live Okan shape: long CV lead never truncated with …; photo attached", async () => {
  clearFacultyCache();
  const cv = "Okan Tekman is Bilkent's senior math lecturer (Minnesota PhD '92) and a longtime calculus institution with a reputation that refuses to quit for decades.";
  const net = fakeNet({ llm: JSON.stringify({ kind: "answer", reply: cv, lore: [Q("Countless legends circulate about him, eats 3 students in one sitting, finished METU math and electronics in 3 years with 4.00", 2066444)], person: { name: "Okan Tekman", affiliation: "Bilkent" } }) });
  await handleMention(18, { cfg: cfg(), wp: new WpClient(cfg(), net.f), engine: net.engine, gh: null, log: () => {}, fetch: facFetch({ n: 0 }, solidPng(400, 400, [9, 9, 9])) });
  const b = net.calls.find((c) => c.url.endsWith("/arta/reply"))!.body as { body: string; files: unknown[] };
  assert.ok(!b.body.includes("…") && [...b.body].length <= 280, b.body);
  assert.ok(!b.body.includes("math.bilkent.edu.tr"), "the photo source is not in the text");
  assert.equal(b.files.length, 1, "photo for a person question even without an image request");
});

test("prompt: opener examples are generic and marked style-only", () => {
  const p = systemPrompt(280);
  assert.doesNotMatch(p, /Okan|Tekman|blizzard|professor|lecturer|calculus/i);
  assert.match(p, /never reuse their wording/);
  assert.ok((p.match(/Openers that work[^\n]*/)?.[0].split(" / ").length ?? 0) >= 3, "several varied examples");
});

test("stripUrls: the reply text never carries links or quotation marks", () => {
  assert.equal(stripUrls("Legend. https://eksisozluk.com/entry/1 www.x.com “quoted” ok"), "Legend. quoted ok");
});

test("private chat: the prompt says private, never public, and forbids publishing", () => {
  const p = promptText(mention({ private: true, source: { type: "dm", id: 7, url: "https://artaquest.com/messages/", body: "hi", author: { handle: "ada", name: "Ada" } } }));
  assert.match(p, /PRIVATE 1:1 chat/);
  assert.match(p, /never file anything publicly/);
  assert.doesNotMatch(p, /Members reach you only in public/);
  assert.doesNotMatch(p, /Everything you write is public/);
  assert.match(p, /the member's PRIVATE chat with you/);
});
