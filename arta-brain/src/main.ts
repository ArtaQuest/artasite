#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { BrowserEngine } from "./browser";
import { loadConfig, missing } from "./config";
import { Daemon } from "./daemon";
import { GitHub } from "./github";
import { Pacer } from "./pacer";
import { WpClient } from "./wp";

/**
 *   node dist/src/main.js run         the daemon (systemd runs this)
 *   node dist/src/main.js check       settings (names only), site reachability, sign-in state; sends no prompt
 *   node dist/src/main.js calibrate   one harmless prompt; prints selector candidates for ARTA_SEL_ANSWER
 *   node dist/src/main.js login       headed browser on $DISPLAY for the operator's one-time sign-in
 */
const cfg = loadConfig();
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const gaps = missing(cfg);
  if (gaps.length) log(`warning — missing settings: ${gaps.join(", ")} (mentions will wait until they are set)`);
  mkdirSync(cfg.stateDir, { recursive: true });
  const engine = new BrowserEngine(cfg, log);
  const pacer = new Pacer({ minGapSec: cfg.minGapSec, perHour: cfg.perHour, perDay: cfg.perDay }, join(cfg.stateDir, "pacer.json"));
  const daemon = new Daemon({ cfg, wp: new WpClient(cfg), engine, gh: cfg.githubToken ? new GitHub(cfg.githubToken, cfg.githubRepo) : null, log }, pacer);
  let stop = false;
  const quit = () => { stop = true; };
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
  log(`Arta brain up — ${cfg.wpBase}; pace ≥${cfg.minGapSec}s apart, ≤${cfg.perHour}/h, ≤${cfg.perDay}/day${cfg.dryRun ? " (DRY RUN)" : ""}`);
  while (!stop) {
    const ms = await daemon.tick().catch((e) => { log(`tick error: ${(e as Error).message}`); return 30_000; });
    writeFileSync(join(cfg.stateDir, "beat"), String(Math.floor(Date.now() / 1000)));
    for (let t = 0; t < ms && !stop; t += 1000) await sleep(Math.min(1000, ms - t));
  }
  await engine.close();
  log("Arta brain stopped");
}

async function check() {
  const gaps = missing(cfg);
  console.log(gaps.length ? `✗ missing settings: ${gaps.join(", ")}` : "✓ settings present");
  const pacer = new Pacer({ minGapSec: cfg.minGapSec, perHour: cfg.perHour, perDay: cfg.perDay }, join(cfg.stateDir, "pacer.json"));
  const u = pacer.usage(Date.now());
  console.log(`  pace: ${u.lastHour}/${cfg.perHour} this hour, ${u.lastDay}/${cfg.perDay} today${pacer.pausedUntil > Date.now() ? `; paused until ${new Date(pacer.pausedUntil).toISOString()} (${pacer.reason})` : ""}`);
  try {
    const r = await new WpClient(cfg).pending(1, 0);
    console.log(`✓ site reachable with the token; ${r.items.length ? "work is waiting" : "queue empty"}`);
  } catch (e) { console.log(`✗ site: ${(e as Error).message}`); }
  const engine = new BrowserEngine(cfg, (s) => console.log(`  ${s}`));
  const c = await engine.check();
  console.log(c.ok ? `✓ chat page: ${c.reason}` : `✗ chat page: ${c.reason}`);
  await engine.close();
  process.exitCode = gaps.length || !c.ok ? 1 : 0;
}

async function calibrate() {
  const engine = new BrowserEngine(cfg, (s) => console.log(`  ${s}`));
  const found = await engine.calibrate();
  await engine.close();
  if (!found.length) { console.log("✗ no element with the expected answer appeared — see the screenshot in the state dir"); process.exitCode = 1; return; }
  console.log("Elements holding the answer (innermost first, then its parents). Pick the most specific stable one for ARTA_SEL_ANSWER:");
  for (const f of found) console.log(`  ${f}`);
}

async function login() {
  if (process.platform === "linux" && !process.env.DISPLAY) { console.log("✗ DISPLAY is not set — run this through deploy/install.sh login"); process.exitCode = 1; return; }
  const engine = new BrowserEngine({ ...cfg, headless: false }, log);
  await engine.openForLogin();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Sign in in the browser window (via the VNC tunnel), open the chat page and send one message. Then press Enter here… ");
  rl.close();
  await engine.close();
  console.log("✓ profile saved");
}

const mode = process.argv[2] || "run";
const modes: Record<string, () => Promise<void>> = { run, check, calibrate, login };
if (!modes[mode]) { console.log("usage: main.js run|check|calibrate|login"); process.exit(2); }
modes[mode]().catch((e) => { console.error(e); process.exit(1); });
