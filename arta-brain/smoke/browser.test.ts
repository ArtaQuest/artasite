/**
 * Drives BrowserEngine against a local stand-in chat page (no network, no account) to prove the
 * mechanics: a NEW conversation per mention, the effort-mode picker (top mode chosen, an unavailable
 * one skipped, the choice verified), attachments uploaded and waited for, an answer that pauses to
 * "think" while its stop control shows, generated images collected, plus signed-out and usage-limit
 * detection and calibrate. Needs a Playwright Chromium:  npm run smoke
 * It cannot prove the real chat page's markup — that is what `calibrate` on the real page is for.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BrowserEngine } from "../src/browser";
import { loadConfig } from "../src/config";
import { EngineBusy, EngineDown, type EngineAnswer } from "../src/engine";
import { solidPng, sniffMime } from "../src/files";

// mode=restore: reopens your LAST conversation on load (localStorage) — the carry-over to defeat.
// noexpert=1: the account has no "Expert" mode. Every answer reports the conversation's earlier message
// count ("context"), the mode it was asked in and the files that were attached when it was sent.
const PAGE = `<!doctype html><html><body>
<script>
const q = new URLSearchParams(location.search);
const mode = q.get("mode") || "ok";
const restore = mode === "restore";
if (mode === "signedout") { document.body.innerHTML = '<a href="/login">Sign in</a>'; }
else {
  document.body.innerHTML = '<nav><button id="new">New chat</button></nav><main id="log"></main>'
    + '<form id="composer"><span id="chips"></span><textarea id="in"></textarea>'
    + '<input type="file" id="file" multiple accept="image/*,.pdf,.txt,.md,.csv,.json" style="display:none">'
    + '<button type="button" aria-label="Attach">+</button><button type="button" id="mode" aria-haspopup="menu">Fast</button></form>';
  const box = document.getElementById("in"), log = document.getElementById("log"), chips = document.getElementById("chips");
  const modeBtn = document.getElementById("mode"), form = document.getElementById("composer");
  const conv = restore ? JSON.parse(localStorage.getItem("conv") || "[]") : [];
  let files = [];
  const add = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; log.appendChild(d); return d; };
  for (const [qq, a] of conv) { add("user-msg", qq); add("bot-msg", a); }
  document.getElementById("new").addEventListener("click", () => { conv.length = 0; localStorage.removeItem("conv"); log.innerHTML = ""; });
  modeBtn.addEventListener("click", () => {
    if (document.getElementById("menu")) { document.getElementById("menu").remove(); return; }
    const m = document.createElement("div"); m.id = "menu"; m.setAttribute("role", "menu");
    const opts = [["Fast", ""], ["Auto", ""], ["Expert", "Thinks hard"], ["Heavy", "Upgrade to unlock"]].filter(([n]) => !(q.get("noexpert") && n === "Expert"));
    for (const [n, sub] of opts) {
      const it = document.createElement("div"); it.setAttribute("role", "menuitem"); it.innerText = n + (sub ? "\\n" + sub : "");
      if (n === "Heavy") it.setAttribute("aria-disabled", "true");
      it.addEventListener("click", () => { if (n !== "Heavy") modeBtn.textContent = n; m.remove(); });
      m.appendChild(it);
    }
    document.body.appendChild(m);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.getElementById("menu")?.remove(); });
  document.getElementById("file").addEventListener("change", (e) => {
    for (const f of e.target.files) {
      files.push({ name: f.name, size: f.size });
      const c = document.createElement("span"); c.textContent = f.name; chips.appendChild(c);
    }
    const bar = document.createElement("div"); bar.setAttribute("role", "progressbar"); form.appendChild(bar);
    setTimeout(() => bar.remove(), 900);
  });
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const qq = box.value; box.value = "";
    const context = log.querySelectorAll(".user-msg").length;
    add("user-msg", qq);
    const a = add("bot-msg", "");
    const full = mode === "limit" ? "You've reached your usage limit. Try again in 2 hours."
      : qq.includes("What color") ? "Red"
      : JSON.stringify({ kind: "answer", reply: "Overfitting is when a model memorises noise.", context, mode: modeBtn.textContent, files });
    const sent = files; files = []; chips.innerHTML = "";
    conv.push([qq, full]);
    if (restore) localStorage.setItem("conv", JSON.stringify(conv));
    const stop = document.createElement("button"); stop.type = "button"; stop.setAttribute("aria-label", "Stop response"); form.appendChild(stop);
    let i = 0, paused = false, t;
    // The color question "thinks" for 2.5 s before writing anything, as a top-effort mode does.
    setTimeout(() => { t = setInterval(tick, 120); }, qq.includes("What color") ? 2500 : 0);
    function tick() {
      // Half-way through, the answer "thinks" for 3 s without changing — only the stop control shows it is not done.
      if (!paused && i >= full.length / 2 && modeBtn.textContent === "Expert") { paused = true; clearInterval(t); setTimeout(go, 3000); return; }
      step();
    }
    function step() { i += 8; a.textContent = full.slice(0, i); if (i >= full.length) { clearInterval(t); finish(); } }
    function go() { const t2 = setInterval(() => { i += 8; a.textContent = full.slice(0, i); if (i >= full.length) { clearInterval(t2); finish(); } }, 120); }
    function finish() {
      if (qq.includes("draw")) {
        const cv = document.createElement("canvas"); cv.width = 128; cv.height = 128;
        const g = cv.getContext("2d"); g.fillStyle = "#1e90ff"; g.fillRect(0, 0, 128, 128);
        const img = document.createElement("img"); img.alt = "square"; img.src = cv.toDataURL("image/png"); a.appendChild(img);
        const icon = document.createElement("img"); icon.src = cv.toDataURL("image/png"); icon.width = 16; icon.height = 16; a.appendChild(icon);
      }
      stop.remove();
    }
  });
}
</script></body></html>`;

const asAnswer = (r: string | EngineAnswer): EngineAnswer => (typeof r === "string" ? { text: r, files: [] } : r);

test("BrowserEngine against a stand-in chat page", async () => {
  const srv = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(PAGE); }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
  const cfg = (url: string, newChat = "") => {
    const c = loadConfig({ HOME: "/tmp/arta-smoke", ARTA_STABLE_SEC: "2" });
    return { ...c, chatUrl: url, sel: { ...c.sel, answer: ".bot-msg", newChat } };
  };
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "arta-smoke-"));
  const png = join(dir, "1-plot.png"); writeFileSync(png, solidPng(8, 8, [0, 128, 0]));
  const md = join(dir, "2-notes.md"); writeFileSync(md, "# notes\n");
  try {
    const ok = new BrowserEngine(cfg(base), (s) => logs.push(s));
    // 1) Top mode: Heavy is an upgrade offer → skipped and remembered; Expert chosen and verified.
    //    Expert "thinks" mid-answer: the stop control keeps the engine waiting for the whole JSON.
    const a1 = asAnswer(await ok.ask("Hello @arta, what is overfitting?", 60_000, [png, md]));
    const j1 = JSON.parse(a1.text);
    assert.equal(j1.reply, "Overfitting is when a model memorises noise.");
    assert.equal(j1.mode, "Expert", "the top mode the account has is used");
    assert.equal(a1.mode, "Expert");
    assert.deepEqual(j1.files.map((f: { name: string }) => f.name), ["1-plot.png", "2-notes.md"], "both files were uploaded before sending");
    assert.equal(j1.context, 0);
    assert.ok(logs.some((l) => /Heavy is not offered/.test(l)), "the missing mode is logged once");
    assert.ok(logs.some((l) => /mode: Expert \(selected, verified on the picker\)/.test(l)));
    // 2) The next mention: a new conversation (context 0), the mode picked again (each chat starts on Fast),
    //    no files carried over, and a generated image comes back as a file (the 16px icon does not).
    const a2 = asAnswer(await ok.ask("@arta please draw a blue square", 60_000));
    const j2 = JSON.parse(a2.text);
    assert.equal(j2.context, 0, "each mention is asked in a new conversation");
    assert.equal(j2.mode, "Expert");
    assert.deepEqual(j2.files, [], "no attachment carries over");
    assert.equal(a2.files.length, 1, "one generated image collected, the icon ignored");
    assert.equal(sniffMime(a2.files[0].bytes), "image/png");
    assert.equal(logs.filter((l) => /Heavy is not offered/.test(l)).length, 1, "an unavailable mode is not retried");
    // 3) calibrate: top mode + tiny PNG + "What color is this square?"
    const cal = await ok.calibrate(60_000);
    assert.equal(cal.mode, "Expert");
    assert.equal(cal.answer, "Red");
    assert.equal(cal.answerSel[0]?.split("  <  ")[0], "div.bot-msg");
    assert.ok(cal.busySel.includes('button[aria-label="Stop response"]'), "the stop control is reported as the busy selector");
    await ok.close();

    // An account without Expert falls back to the next label (Thinking is absent too → Auto).
    const lower = new BrowserEngine(cfg(`${base}?noexpert=1`), (s) => logs.push(s));
    assert.equal(JSON.parse(asAnswer(await lower.ask("@arta hi", 60_000)).text).mode, "Auto");
    await lower.close();

    // An app that reopens the last conversation: "New chat" before every mention…
    const fresh = new BrowserEngine(cfg(`${base}?mode=restore`, "#new"));
    for (const q of ["@arta first member's question", "@arta second member's question", "@arta third"]) {
      assert.equal(JSON.parse(asAnswer(await fresh.ask(q, 60_000)).text).context, 0, `no carry-over into: ${q}`);
    }
    await fresh.close();
    // …and without a new-chat control it refuses to ask inside the earlier conversation at all.
    const stale = new BrowserEngine(cfg(`${base}?mode=restore`));
    await assert.rejects(stale.ask("@arta fourth", 30_000), (e) => e instanceof EngineDown && /earlier conversation/.test(e.reason));
    await stale.close();

    const limited = new BrowserEngine(cfg(`${base}?mode=limit`));
    await assert.rejects(limited.ask("hi", 30_000), (e) => e instanceof EngineBusy);
    await limited.close();

    const out2 = new BrowserEngine(cfg(`${base}?mode=signedout`));
    await assert.rejects(out2.ask("hi", 30_000), (e) => e instanceof EngineDown && /signed out/.test(e.reason));
    assert.equal((await out2.check()).ok, false);
    await out2.close();
  } finally {
    srv.close();
  }
});
