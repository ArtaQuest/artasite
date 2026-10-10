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
  assert.ok(b.body.length <= 280 && b.body.endsWith("…"), "the public reply is trimmed to the limit");
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

// ── voice, Ekşi lore, real photos (the Okan Tekman example) ─────────────────
import sharp from "sharp";
import { loreOf, photoOf } from "../src/prompt";
import { fetchPhoto } from "../src/photo";

const OKAN_Q = "@arta who is Okan Tekman and what people say about him? Show me a black and white picture of him too";
const WIKI = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Okan_Tekman.jpg";
const PAGE = "https://commons.wikimedia.org/wiki/File:Okan_Tekman.jpg";
const EKSI = "https://eksisozluk.com/okan-tekman--123";
const colour = () => sharp({ create: { width: 600, height: 600, channels: 3, background: { r: 200, g: 40, b: 90 } } }).png().toBuffer();
const okanAnswer = (over: Record<string, unknown> = {}) => JSON.stringify({
  kind: "answer",
  reply: "Okan Tekman: the guy Ekşi swears can debug production by staring at it 👀",
  image: { url: WIKI, page: PAGE, grayscale: true, credit: "Jane Doe, CC BY-SA 4.0" },
  lore: [{ claim: "debugs by staring", quote: "the man looks at the logs and the bug fixes itself", source: EKSI }],
  ...over,
});
function okanDeps(llm: string, photo: (() => Promise<Response>) | null, logs: string[] = []) {
  const net = fakeNet({ llm, mention: mention({ source: { ...mention().source, body: OKAN_Q } }) });
  const d = { ...deps(net), log: (s: string) => logs.push(s) };
  const f: typeof net.f = async (url, init) => (url.startsWith("https://upload.wikimedia.org/") && photo ? photo() : net.f(url, init));
  return { net, d: { ...d, fetch: f, wp: new WpClient(d.cfg, f) }, logs };
}
const replyOf = (net: ReturnType<typeof fakeNet>) => net.calls.find((c) => c.url.endsWith("/arta/reply"))!.body as { body: string; files?: { name: string; type: string; size: number }[] };

test("prompt: X-user voice, Ekşi lore with verbatim quotes, no allegations, real photos only", () => {
  const p = systemPrompt(280);
  assert.match(p, /X user/);
  assert.match(p, /eksisozluk\.com/);
  assert.match(p, /NEVER invent entries/);
  assert.match(p, /never repeat allegations/i);
  assert.match(p, /upload\.wikimedia\.org/);
  assert.doesNotMatch(p, /Be warm, direct and accurate/);
  assert.match(p, /ALWAYS reply in English/);
  assert.match(p, /English translation/);
  assert.doesNotMatch(p, /"details"|answer\.md|Markdown file/);
});

test("parseDecision: photo only from Wikimedia, lore only with quote + https source", () => {
  assert.equal(photoOf({ url: "https://i.imgur.com/x.jpg", page: PAGE })?.url, undefined);
  assert.equal(photoOf({ url: WIKI, page: "https://evil.example/x" }), undefined);
  assert.deepEqual(photoOf({ url: WIKI, page: PAGE, grayscale: true }), { url: WIKI, page: PAGE, grayscale: true, credit: "Wikimedia Commons" });
  assert.equal(loreOf([{ claim: "c", quote: "", source: EKSI }, { claim: "c", quote: "q", source: "javascript:x" }, { claim: "c", quote: "q", source: EKSI }]).length, 1);
  const dec = parseDecision(okanAnswer());
  assert.equal(dec.image?.grayscale, true);
  assert.equal(dec.lore?.length, 1);
});

test("Okan Tekman: English casual reply + grayscale JPEG attached first, credited, Ekşi linked, no answer.md", async () => {
  const png = await colour();
  const { net, d } = okanDeps(okanAnswer(), async () => new Response(png, { status: 200, headers: { "content-length": String(png.byteLength) } }));
  assert.equal(await handleMention(11, d), "replied");
  const r = replyOf(net);
  assert.equal(r.files?.length, 1);
  assert.equal(r.files![0].name, "photo-bw.jpg");
  assert.equal(r.files![0].type, "image/jpeg");
  assert.match(r.body, /📷 \[Jane Doe, CC BY-SA 4.0\]\(https:\/\/commons\.wikimedia\.org/);
  assert.match(r.body, /\[Ekşi Sözlük\]\(https:\/\/eksisozluk\.com/);
  assert.ok(r.body.length <= 280);
  assert.doesNotMatch(r.body, /born in/i);
  assert.ok(!r.files!.some((f) => /\.md$/.test(f.name)), "no .md attachment");
});

test("fetchPhoto: output really is grayscale and bounded", async () => {
  const big = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 10, g: 200, b: 30 } } }).jpeg().toBuffer();
  const out = await fetchPhoto({ url: WIKI, page: PAGE, grayscale: true, credit: "x" }, cfg(), async () => new Response(big, { status: 200 }));
  assert.ok(out);
  const meta = await sharp(Buffer.from(out!.bytes)).raw().toBuffer({ resolveWithObject: true });
  assert.ok(meta.info.width <= 1200 && meta.info.height <= 1200);
  const px = meta.data; const ch = meta.info.channels;
  assert.ok(ch === 1 || (px[0] === px[1] && px[1] === px[2]), "channels equal");
});

test("photo failures never fail the reply: 404, timeout-ish error, junk bytes, SVG, oversize", async () => {
  const cases: (() => Promise<Response>)[] = [
    async () => new Response("nope", { status: 404 }),
    async () => { throw new Error("aborted"); },
    async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { status: 200 }),
    async () => new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", { status: 200 }),
    async () => new Response(new Uint8Array(1), { status: 200, headers: { "content-length": String(20 * 1048576) } }),
  ];
  for (const c of cases) {
    const { net, d, logs } = okanDeps(okanAnswer(), c);
    assert.equal(await handleMention(11, d), "replied");
    const r = replyOf(net);
    assert.ok(!r.files?.length, "no file");
    assert.match(r.body, /Couldn't grab a usable photo/);
    assert.ok(logs.some((l) => /photo:/.test(l)));
  }
});

test("wrong host or ambiguous person: no image field → no photo, no failure note", async () => {
  const { net, d } = okanDeps(okanAnswer({ image: { url: "https://i.imgur.com/x.jpg", page: PAGE } }), null);
  assert.equal(await handleMention(11, d), "replied");
  const r = replyOf(net);
  assert.ok(!r.files?.length);
  assert.doesNotMatch(r.body, /photo/i);
});

test("Ekşi unreachable: honest reply passes through with no lore link", async () => {
  const { net, d } = okanDeps(JSON.stringify({ kind: "answer", reply: "Ekşi wouldn't load for me right now, so no legends this time." }), null);
  assert.equal(await handleMention(11, d), "replied");
  assert.equal(replyOf(net).body, "Ekşi wouldn't load for me right now, so no legends this time.");
});
