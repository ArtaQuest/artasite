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

const PAGE = `<!doctype html><html><body>
<script>
const mode = new URLSearchParams(location.search).get("mode") || "ok";
if (mode === "signedout") { document.body.innerHTML = '<a href="/login">Sign in</a>'; }
else {
  document.body.innerHTML = '<main id="log"></main><textarea id="in"></textarea>';
  const box = document.getElementById("in");
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const q = box.value; box.value = "";
    const u = document.createElement("div"); u.className = "user-msg"; u.textContent = q; log.appendChild(u);
    const a = document.createElement("div"); a.className = "bot-msg"; log.appendChild(a);
    const full = mode === "limit" ? "You've reached your usage limit. Try again in 2 hours."
      : q.includes("pong") ? "pong"
      : JSON.stringify({ kind: "answer", reply: "Overfitting is when a model memorises noise." });
    let i = 0;
    const t = setInterval(() => { i += 8; a.textContent = full.slice(0, i); if (i >= full.length) clearInterval(t); }, 150);
  });
}
</script></body></html>`;

test("BrowserEngine against a stand-in chat page", async () => {
  const srv = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(PAGE); }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
  const cfg = (url: string) => ({ ...loadConfig({ HOME: "/tmp/arta-smoke" }), chatUrl: url, sel: { ...loadConfig({}).sel, answer: ".bot-msg" } });
  try {
    const ok = new BrowserEngine(cfg(base));
    const out = await ok.ask("Hello @arta, what is overfitting?", 30_000);
    assert.equal(JSON.parse(out).reply, "Overfitting is when a model memorises noise.");
    const second = await ok.ask("And again?", 30_000);
    assert.match(second, /memorises noise/, "a fresh conversation each time still reads the new answer");
    assert.deepEqual((await ok.calibrate(30_000))[0]?.split("  <  ")[0], "div.bot-msg");
    await ok.close();

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
