import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { Config } from "./config";
import { type Engine, type EngineAnswer, EngineBusy, EngineDown } from "./engine";
import { safeName, sniffMime, solidPng } from "./files";
import type { OutFile } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mode names a picker button may show, besides ARTA_MODE_LABELS (so the button is found in any mode). */
const KNOWN_MODES = ["Fast", "Auto", "Expert", "Heavy", "Thinking", "Think"];
/** An option offered for sale rather than for use. */
const UPSELL = /upgrade|subscribe|unlock|get (super|premium|heavy)|requires? /i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const firstLine = (s: string) => s.trim().split("\n")[0].trim();
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** aria-labels / titles of the visible buttons — what changes while an answer is being written. */
async function controlLabels(p: Page): Promise<string[]> {
  return p.$$eval("button", (bs) => bs.filter((b) => (b as HTMLElement).offsetParent !== null)
    .map((b) => b.getAttribute("aria-label") || b.getAttribute("title") || "").filter(Boolean)
    .map((l) => `button[aria-label="${l}"]`)).catch(() => [] as string[]);
}

/**
 * How the browser is started. On Linux: Playwright's own Chromium. On the operator's Mac
 * (ARTA_BROWSER_CHANNEL=chrome): the installed Google Chrome on a DEDICATED profile directory — never the
 * operator's everyday profile. That profile is signed in with plain Chrome (deploy/macos/arta-brain.sh
 * login), which encrypts its cookies with the login Keychain; Playwright normally swaps in a mock
 * keychain on macOS, which would make that sign-in unreadable, so on macOS with a real Chrome we keep the
 * real Keychain. Nothing here hides automation.
 */
export function launchOptions(cfg: Config, headless: boolean, platform: NodeJS.Platform = process.platform) {
  const opts: {
    headless: boolean; viewport: { width: number; height: number }; locale: string; args: string[];
    channel?: string; ignoreDefaultArgs?: string[];
  } = {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    args: platform === "linux" ? ["--disable-dev-shm-usage"] : [],
  };
  if (cfg.browserChannel) {
    opts.channel = cfg.browserChannel;
    if (platform === "darwin") opts.ignoreDefaultArgs = ["--use-mock-keychain"];
  }
  return opts;
}

/**
 * The operator's chat subscription, driven in a real browser profile that the operator signed into
 * by hand (deploy/install.sh login, or deploy/macos/arta-brain.sh login). One prompt at a time, and a NEW
 * tab with a NEW conversation for every mention, so no member's text can leak into another's answer.
 *
 * What this is NOT: there is no fingerprint spoofing, no stealth plugin, no CAPTCHA solving and no
 * randomised "human" behaviour. It is an ordinary browser at a slow, fixed pace (see Pacer); if the
 * service asks for a check or a sign-in, the engine reports EngineDown and a human deals with it.
 *
 * The page's markup is not under our control, so the selectors are settings (ARTA_SEL_*), found with
 * `node dist/src/main.js calibrate` after the first sign-in.
 */
export class BrowserEngine implements Engine {
  private ctx: BrowserContext | null = null;

  constructor(private cfg: Config, private log: (s: string) => void = () => {}) {}

  private async context(headless = this.cfg.headless): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    const { chromium } = await import("playwright");
    mkdirSync(this.cfg.profileDir, { recursive: true });
    this.ctx = await chromium.launchPersistentContext(this.cfg.profileDir, launchOptions(this.cfg, headless));
    this.ctx.on("close", () => { this.ctx = null; });
    return this.ctx;
  }

  /** A NEW tab every time: nothing a previous mention left in the page (scroll, drafts, app state) survives. */
  private async page(headless?: boolean): Promise<Page> {
    const ctx = await this.context(headless);
    const fresh = await ctx.newPage();
    for (const old of ctx.pages()) if (old !== fresh) await old.close().catch(() => {});
    fresh.setDefaultTimeout(20_000);
    return fresh;
  }

  /**
   * Open a NEW conversation and make sure we can type into it. Every mention gets its own conversation so
   * nothing one member wrote can reach another member's answer: a new tab on the chat page, then — if the
   * app restored an earlier conversation (any answer already on screen) — the "new chat" control
   * (ARTA_SEL_NEW_CHAT). If the page still shows an earlier answer, we refuse to send (EngineDown) rather
   * than ask inside someone else's context.
   */
  private async open(): Promise<Page> {
    if (!/^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(this.cfg.chatUrl)) throw new EngineDown("ARTA_CHAT_URL not set");
    const p = await this.page();
    try {
      await p.goto(this.cfg.chatUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (e) {
      throw new EngineDown(`could not open the chat page: ${(e as Error).message.split("\n")[0]}`);
    }
    const input = p.locator(this.cfg.sel.input).first();
    try {
      await input.waitFor({ state: "visible", timeout: 20_000 });
    } catch {
      const out = await p.locator(this.cfg.sel.signedOut).first().isVisible().catch(() => false);
      await this.shot(p, out ? "signed-out" : "no-input");
      throw new EngineDown(out ? "signed out — sign in again (login)" : "chat input not found — re-run calibrate");
    }
    await this.ensureFresh(p);
    return p;
  }

  /** No earlier answer may be on screen when we send. Uses the new-chat control once if needed. */
  private async ensureFresh(p: Page): Promise<void> {
    if (!this.cfg.sel.answer) return; // calibrate/check before ARTA_SEL_ANSWER exists: nothing is sent to a member
    const answers = p.locator(this.cfg.sel.answer);
    await sleep(800); // let an app that restores the last conversation finish rendering it
    if ((await answers.count()) === 0) return;
    if (this.cfg.sel.newChat) {
      await p.locator(this.cfg.sel.newChat).first().click({ timeout: 10_000 }).catch(() => {});
      await p.locator(this.cfg.sel.input).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
      await sleep(800);
      if ((await answers.count()) === 0) return;
    }
    await this.shot(p, "not-fresh");
    throw new EngineDown("the chat page opened an earlier conversation — set ARTA_SEL_NEW_CHAT to its new-chat control");
  }

  // ── Effort mode ────────────────────────────────────────────────────────────────────────────────

  /** Modes this account does not offer (or that would not take), learned once per process. */
  private modeMissing = new Set<string>();
  private lastModeNote = "";
  private noteMode(s: string) { if (s !== this.lastModeNote) { this.lastModeNote = s; this.log(s); } }

  /** The picker's button: ARTA_SEL_MODE, or the button whose whole label is a known mode name. */
  private modeTrigger(p: Page) {
    if (this.cfg.sel.mode) return p.locator(this.cfg.sel.mode).first();
    const names = [...new Set([...this.cfg.modeLabels, ...KNOWN_MODES])].map(esc).join("|");
    return p.locator("button").filter({ hasText: new RegExp(`^\\s*(${names})\\s*$`, "i") }).last();
  }

  /**
   * Put the fresh conversation in the highest-effort mode this account offers (ARTA_MODE_LABELS, in
   * order). Ordinary clicks on the page's own picker; the choice is VERIFIED by reading the picker's
   * label back. A mode the account lacks (absent, disabled, an upgrade offer, or a click that does not
   * take) is remembered and the next one tried — never an error, never a retry loop. Returns the mode
   * the conversation is in ("" when the page has no picker).
   */
  async selectMode(p: Page): Promise<string> {
    if (!this.cfg.modeLabels.length) return "";
    const trigger = this.modeTrigger(p);
    if (!(await trigger.isVisible().catch(() => false))) { this.noteMode("mode: no picker found — the page's default mode answers"); return ""; }
    const label = async () => firstLine(await trigger.innerText().catch(() => ""));
    const here = p.url();
    for (const want of this.cfg.modeLabels) {
      if (this.modeMissing.has(want)) continue;
      if (same(await label(), want)) { this.noteMode(`mode: ${want} (verified on the picker)`); return want; }
      await trigger.click();
      const items = p.locator(this.cfg.sel.modeItem);
      await items.first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
      let pick = null as null | ReturnType<typeof items.nth>;
      for (let i = 0, n = await items.count(); i < n; i++) {
        const it = items.nth(i);
        if (!(await it.isVisible().catch(() => false))) continue;
        const text = (await it.innerText().catch(() => "")).trim();
        if (!same(firstLine(text), want) && !firstLine(text).toLowerCase().startsWith(`${want.toLowerCase()} `)) continue;
        const off = (await it.getAttribute("aria-disabled")) === "true" || (await it.getAttribute("data-disabled")) !== null || UPSELL.test(text);
        if (!off) pick = it;
        break;
      }
      if (!pick) {
        await p.keyboard.press("Escape").catch(() => {});
        this.modeMissing.add(want);
        this.log(`mode: ${want} is not offered to this account — trying the next`);
        continue;
      }
      await pick.click();
      await sleep(700);
      if (p.url() !== here) { // an upgrade page, not a mode: go back to the conversation
        this.modeMissing.add(want);
        this.log(`mode: ${want} opened another page — not available here; trying the next`);
        await p.goto(here, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
        await p.locator(this.cfg.sel.input).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
        continue;
      }
      if (same(await label(), want)) { this.noteMode(`mode: ${want} (selected, verified on the picker)`); return want; }
      await p.keyboard.press("Escape").catch(() => {});
      this.modeMissing.add(want);
      this.log(`mode: ${want} did not take (the picker still says "${await label()}") — trying the next`);
    }
    const now = await label();
    this.noteMode(`mode: none of ${this.cfg.modeLabels.join(", ")} available — answering in ${now || "the default mode"}`);
    return now;
  }

  // ── Attachments ────────────────────────────────────────────────────────────────────────────────

  /** Upload local files through the page's own attach control and wait until every upload is done. */
  private async attach(p: Page, files: string[]) {
    if (!files.length) return;
    let input = p.locator(this.cfg.sel.file).first();
    if (!(await input.count()) && this.cfg.sel.attach) {
      await p.locator(this.cfg.sel.attach).first().click().catch(() => {});
      await sleep(500);
      input = p.locator(this.cfg.sel.file).first();
    }
    if (!(await input.count())) throw new Error("attach control not found — set ARTA_SEL_FILE / ARTA_SEL_ATTACH");
    const multiple = await input.evaluate((e) => (e as HTMLInputElement).multiple).catch(() => false);
    if (multiple) await input.setInputFiles(files);
    else for (const f of files) { await p.locator(this.cfg.sel.file).first().setInputFiles(f); await sleep(400); }
    // Done = the upload indicator has been absent for two looks in a row, and every file name shows.
    const names = files.map((f) => basename(f).replace(/^\d+-/, ""));
    const deadline = Date.now() + 120_000;
    let clear = 0;
    await sleep(800);
    while (Date.now() < deadline) {
      const busy = await p.locator(this.cfg.sel.uploading).filter({ visible: true }).count().catch(() => 0);
      const body = await p.locator("body").innerText().catch(() => "");
      const shown = names.every((n) => body.includes(n) || body.includes(n.replace(/\.[^.]+$/, "")));
      const imgs = await p.locator('img[src^="blob:"], img[src^="data:"]').count().catch(() => 0);
      clear = !busy && (shown || imgs >= files.length) ? clear + 1 : 0;
      if (clear >= 2) return;
      await sleep(700);
    }
    await this.shot(p, "upload-timeout");
    throw new Error(`attachments did not finish uploading (${files.length})`);
  }

  // ── One prompt ─────────────────────────────────────────────────────────────────────────────────

  private async send(p: Page, prompt: string) {
    const input = p.locator(this.cfg.sel.input).first();
    await input.click();
    await input.fill(prompt);
    if (this.cfg.sel.send) await p.locator(this.cfg.sel.send).first().click();
    else await input.press("Enter");
  }

  /** Wait for the newest answer to finish: text unchanged for ARTA_STABLE_SEC and no stop control. */
  private async waitAnswer(p: Page, before: number, timeoutMs: number): Promise<string> {
    const answers = p.locator(this.cfg.sel.answer);
    const limit = new RegExp(this.cfg.sel.limitText, "i");
    const deadline = Date.now() + timeoutMs;
    let last = "";
    let stable = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      const alert = (await p.locator('[role="alert"]').allInnerTexts().catch(() => [] as string[])).join(" ");
      if (alert && limit.test(alert)) throw new EngineBusy(Date.now() + this.cfg.busyPauseSec * 1000, `chat limit: ${alert.slice(0, 120)}`);
      const n = await answers.count();
      if (n <= before) continue;
      const text = (await answers.nth(n - 1).innerText().catch(() => "")).trim();
      const writing = await p.locator(this.cfg.sel.busy).filter({ visible: true }).count().catch(() => 0);
      if (text && text === last && !writing) stable++;
      else { stable = 0; last = text; }
      if (last && stable >= this.cfg.stableSec) break;
    }
    if (!last) {
      await this.shot(p, "timeout");
      throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    if (!last.includes("{") && limit.test(last)) throw new EngineBusy(Date.now() + this.cfg.busyPauseSec * 1000, `chat limit: ${last.slice(0, 120)}`);
    return last;
  }

  /**
   * Files the answer produced: its images (generated pictures, not icons) and its download links,
   * fetched through the signed-in page itself. Only the types the site accepts, within the caps.
   */
  private async produced(p: Page, before: number): Promise<OutFile[]> {
    if (!this.cfg.outFilesMax) return [];
    const answers = p.locator(this.cfg.sel.answer);
    const n = await answers.count();
    if (n <= before) return [];
    const found = await answers.nth(n - 1).evaluate((el) => {
      const out: { url: string; name: string }[] = [];
      for (const img of Array.from(el.querySelectorAll("img"))) {
        if (img.naturalWidth >= 96 && img.naturalHeight >= 96) out.push({ url: img.currentSrc || img.src, name: img.alt || "image" });
      }
      for (const a of Array.from(el.querySelectorAll("a[download], a[href^='blob:']"))) {
        out.push({ url: (a as HTMLAnchorElement).href, name: a.getAttribute("download") || (a.textContent || "file").trim() });
      }
      return out;
    }).catch(() => [] as { url: string; name: string }[]);
    const files: OutFile[] = [];
    const seen = new Set<string>();
    for (const f of found) {
      if (files.length >= this.cfg.outFilesMax || seen.has(f.url)) continue;
      seen.add(f.url);
      try {
        let bytes: Uint8Array | null = null;
        if (/^https:\/\//.test(f.url)) {
          const r = await p.context().request.get(f.url, { timeout: 60_000 });
          const b = r.ok() ? await r.body() : null;
          bytes = b && b.byteLength <= this.cfg.outFileBytes ? new Uint8Array(b) : null;
        } else if (/^(blob|data):/.test(f.url)) {
          const b64 = await p.evaluate(async ([u, cap]) => {
            const r = await fetch(u as string);
            const buf = new Uint8Array(await r.arrayBuffer());
            if (buf.byteLength > (cap as number)) return "";
            let s = ""; for (const x of buf) s += String.fromCharCode(x);
            return btoa(s);
          }, [f.url, this.cfg.outFileBytes] as const);
          bytes = b64 ? new Uint8Array(Buffer.from(b64, "base64")) : null;
        }
        if (!bytes) continue;
        const mime = sniffMime(bytes);
        if (!mime) { this.log(`answer file skipped (not an image or PDF): ${f.name.slice(0, 40)}`); continue; }
        files.push({ name: safeName(`${f.name || "image"}-${files.length + 1}`, mime), mime, bytes });
      } catch (e) { this.log(`answer file not fetched: ${(e as Error).message.split("\n")[0]}`); }
    }
    return files;
  }

  async ask(prompt: string, timeoutMs: number, files: string[] = []): Promise<EngineAnswer> {
    if (!this.cfg.sel.answer) throw new EngineDown("ARTA_SEL_ANSWER not set — run calibrate");
    const p = await this.open();
    const mode = await this.selectMode(p);
    await this.attach(p, files);
    const before = await p.locator(this.cfg.sel.answer).count(); // 0: open() guarantees a fresh conversation
    await this.send(p, prompt);
    const text = await this.waitAnswer(p, before, timeoutMs);
    return { text, files: await this.produced(p, before), mode };
  }

  /** Is the profile signed in and the page usable? Opens the page; sends nothing. */
  async check(): Promise<{ ok: boolean; reason: string }> {
    try { await this.open(); return { ok: true, reason: "chat input visible" }; }
    catch (e) { return { ok: false, reason: (e as Error).message }; }
  }

  /**
   * One harmless live probe that exercises the whole path: a fresh conversation, the top-effort mode,
   * a tiny generated PNG attached, and "What color is this square?". Reports the mode (and how it was
   * verified), the answer, and selector candidates: the elements holding the answer word (for
   * ARTA_SEL_ANSWER) and the controls visible only while the answer was being written (ARTA_SEL_BUSY).
   */
  async calibrate(timeoutMs = 600_000): Promise<{ mode: string; modeLog: string[]; answer: string; answerSel: string[]; busySel: string[]; fileInput: string }> {
    const modeLog: string[] = [];
    const log0 = this.log;
    this.log = (s: string) => { modeLog.push(s); log0(s); };
    try {
      const p = await this.open();
      const mode = await this.selectMode(p);
      mkdirSync(this.cfg.stateDir, { recursive: true });
      const png = join(this.cfg.stateDir, "calibrate-square.png");
      writeFileSync(png, solidPng(64, 64, [220, 20, 20]));
      const fileInput = await p.locator(this.cfg.sel.file).first().evaluate((e) => {
        const i = e as HTMLInputElement; return `input[type=file] multiple=${i.multiple} accept=${i.accept || "*"}`;
      }).catch(() => "none found");
      await this.attach(p, [png]);
      const idle = await controlLabels(p);
      await this.send(p, "What color is this square? Reply with exactly one word.");
      const busySeen = new Set<string>();
      const deadline = Date.now() + timeoutMs;
      let found: string[] = []; let answer = ""; let stable = 0;
      while (Date.now() < deadline) {
        await sleep(1500);
        for (const l of await controlLabels(p)) if (!idle.includes(l)) busySeen.add(l);
        const hit = await p.evaluate(() => {
          const out: string[] = []; let word = "";
          const describe = (el: Element) => {
            const tid = el.getAttribute("data-testid");
            if (tid) return `[data-testid="${tid}"]`;
            const cls = Array.from(el.classList).filter((c) => /^[a-zA-Z][\w-]{2,}$/.test(c)).slice(0, 3);
            return el.tagName.toLowerCase() + cls.map((c) => `.${c}`).join("");
          };
          for (const el of Array.from(document.querySelectorAll("body *"))) {
            const t = ((el as HTMLElement).innerText || "").trim();
            if (!/^[A-Za-z]{3,8}\.?$/.test(t) || !/^(red|crimson|scarlet)\.?$/i.test(t)) continue;
            word = t;
            const chain: string[] = [];
            for (let e: Element | null = el; e && e !== document.body && chain.length < 6; e = e.parentElement) chain.push(describe(e));
            out.push(chain.join("  <  "));
          }
          return { out, word };
        });
        if (hit.out.length) {
          found = hit.out; answer = hit.word;
          const writing = this.cfg.sel.busy ? await p.locator(this.cfg.sel.busy).filter({ visible: true }).count().catch(() => 0) : 0;
          if (!writing && ++stable >= 2) break;
        }
      }
      if (!found.length) {
        const n = await p.locator(this.cfg.sel.answer || "body").count().catch(() => 0);
        answer = n ? (await p.locator(this.cfg.sel.answer || "body").nth(n - 1).innerText().catch(() => "")).trim().slice(0, 200) : "";
      }
      await this.shot(p, found.length ? "calibrate" : "calibrate-timeout");
      return { mode, modeLog, answer, answerSel: found, busySel: [...busySeen], fileInput };
    } finally {
      this.log = log0;
    }
  }

  /** Headed session for the operator's one-time sign-in (on Linux, DISPLAY must point at the VNC display). */
  async openForLogin(): Promise<void> {
    const p = await this.page(false);
    if (this.cfg.chatUrl) await p.goto(this.cfg.chatUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  private async shot(p: Page, name: string) {
    try {
      mkdirSync(this.cfg.stateDir, { recursive: true });
      const file = join(this.cfg.stateDir, `${name}.png`);
      await p.screenshot({ path: file });
      this.log(`screenshot: ${file}`);
    } catch { /* best effort */ }
  }

  async close() {
    const c = this.ctx; this.ctx = null;
    await c?.close().catch(() => {});
  }
}
