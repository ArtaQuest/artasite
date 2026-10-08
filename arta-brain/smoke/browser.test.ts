/**
 * Drives BrowserEngine against a local stand-in chat page (no network, no account) to prove the
 * mechanics: type → submit → wait for a streamed answer to settle → read it; plus signed-out and
 * usage-limit detection and calibrate. Needs a Playwright Chromium:  npm run smoke
 * It cannot prove the real chat page's markup — that is what `calibrate` on the VM is for.
 */
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { BrowserEngine } from "../src/browser";
import { loadConfig } from "../src/config";
import { EngineBusy, EngineDown } from "../src/engine";

// mode=restore behaves like a chat app that reopens your LAST conversation on load (kept in
// localStorage) and has a "New chat" button. Every answer reports how many earlier messages were in
// the conversation it was asked in ("context") — the carry-over a member must never get.
const PAGE = `<!doctype html><html><body>
<script>
const mode = new URLSearchParams(location.search).get("mode") || "ok";
const restore = mode === "restore";
if (mode === "signedout") { document.body.innerHTML = '<a href="/login">Sign in</a>'; }
else {
  document.body.innerHTML = '<button id="new">New chat</button><main id="log"></main><textarea id="in"></textarea>';
  const box = document.getElementById("in");
  const log = document.getElementById("log");
  const conv = restore ? JSON.parse(localStorage.getItem("conv") || "[]") : [];
  const add = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; log.appendChild(d); return d; };
  for (const [q, a] of conv) { add("user-msg", q); add("bot-msg", a); }
  document.getElementById("new").addEventListener("click", () => { conv.length = 0; localStorage.removeItem("conv"); log.innerHTML = ""; });
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const q = box.value; box.value = "";
    const context = log.querySelectorAll(".user-msg").length;
    add("user-msg", q);
    const a = add("bot-msg", "");
    const full = mode === "limit" ? "You've reached your usage limit. Try again in 2 hours."
      : q.includes("pong") ? "pong"
      : JSON.stringify({ kind: "answer", reply: "Overfitting is when a model memorises noise.", context });
    conv.push([q, full]);
    if (restore) localStorage.setItem("conv", JSON.stringify(conv));
    let i = 0;
    const t = setInterval(() => { i += 8; a.textContent = full.slice(0, i); if (i >= full.length) clearInterval(t); }, 150);
  });
}
</script></body></html>`;

test("BrowserEngine against a stand-in chat page", async () => {
  const srv = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(PAGE); }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
  const cfg = (url: string, newChat = "") => ({ ...loadConfig({ HOME: "/tmp/arta-smoke" }), chatUrl: url, sel: { ...loadConfig({}).sel, answer: ".bot-msg", newChat } });
  try {
    const ok = new BrowserEngine(cfg(base));
    const out = await ok.ask("Hello @arta, what is overfitting?", 30_000);
    assert.equal(JSON.parse(out).reply, "Overfitting is when a model memorises noise.");
    assert.equal(JSON.parse(out).context, 0);
    const second = await ok.ask("And again?", 30_000);
    assert.equal(JSON.parse(second).context, 0, "each mention is asked in a new conversation");
    assert.deepEqual((await ok.calibrate(30_000))[0]?.split("  <  ")[0], "div.bot-msg");
    await ok.close();

    // An app that reopens the last conversation: the engine must press "New chat" before every mention…
    const fresh = new BrowserEngine(cfg(`${base}?mode=restore`, "#new"));
    for (const q of ["@arta first member's question", "@arta second member's question", "@arta third"]) {
      assert.equal(JSON.parse(await fresh.ask(q, 30_000)).context, 0, `no carry-over into: ${q}`);
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
