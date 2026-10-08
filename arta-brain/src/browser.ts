import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { Config } from "./config";
import { type Engine, EngineBusy, EngineDown } from "./engine";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  async ask(prompt: string, timeoutMs: number): Promise<string> {
    if (!this.cfg.sel.answer) throw new EngineDown("ARTA_SEL_ANSWER not set — run calibrate");
    const p = await this.open();
    const answers = p.locator(this.cfg.sel.answer);
    const before = await answers.count(); // 0: open() guarantees a fresh conversation
    const input = p.locator(this.cfg.sel.input).first();
    await input.click();
    await input.fill(prompt);
    if (this.cfg.sel.send) await p.locator(this.cfg.sel.send).first().click();
    else await input.press("Enter");

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
      if (text && text === last) stable++;
      else { stable = 0; last = text; }
      // Done when the text has stopped changing for 3 s (5 s if it does not look like the JSON we asked for).
      if (last && stable >= (last.includes("}") ? 3 : 5)) break;
    }
    if (!last) {
      await this.shot(p, "timeout");
      throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    // A limit notice comes back in place of an answer; a real answer is the JSON we asked for.
    if (!last.includes("{") && limit.test(last)) throw new EngineBusy(Date.now() + this.cfg.busyPauseSec * 1000, `chat limit: ${last.slice(0, 120)}`);
    return last;
  }

  /** Is the profile signed in and the page usable? Opens the page; sends nothing. */
  async check(): Promise<{ ok: boolean; reason: string }> {
    try { await this.open(); return { ok: true, reason: "chat input visible" }; }
    catch (e) { return { ok: false, reason: (e as Error).message }; }
  }

  /**
   * Find the answer selector: send one harmless prompt and report the elements whose text is exactly
   * the expected word, from the innermost outwards, so the operator can set ARTA_SEL_ANSWER.
   */
  async calibrate(timeoutMs = 90_000): Promise<string[]> {
    const p = await this.open();
    const input = p.locator(this.cfg.sel.input).first();
    await input.click();
    await input.fill("Reply with exactly one word and nothing else: pong");
    if (this.cfg.sel.send) await p.locator(this.cfg.sel.send).first().click();
    else await input.press("Enter");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(2000);
      const found = await p.evaluate(() => {
        const out: string[] = [];
        const describe = (el: Element) => {
          const tid = el.getAttribute("data-testid");
          if (tid) return `[data-testid="${tid}"]`;
          const cls = Array.from(el.classList).filter((c) => /^[a-zA-Z][\w-]{2,}$/.test(c)).slice(0, 3);
          return el.tagName.toLowerCase() + cls.map((c) => `.${c}`).join("");
        };
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          if ((el as HTMLElement).innerText?.trim().toLowerCase() !== "pong") continue;
          const chain: string[] = [];
          for (let e: Element | null = el; e && e !== document.body && chain.length < 6; e = e.parentElement) chain.push(describe(e));
          out.push(chain.join("  <  "));
        }
        return out;
      });
      if (found.length) { await this.shot(p, "calibrate"); return found; }
    }
    await this.shot(p, "calibrate-timeout");
    return [];
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
