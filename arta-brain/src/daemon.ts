import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EngineBusy, EngineDown } from "./engine";
import type { Pacer } from "./pacer";
import type { Mention } from "./types";
import { type Deps, handleMention } from "./worker";

export const MAX_ATTEMPTS = 3;

/**
 * The loop that is Arta: poll the site's queue, answer at most one mention per tick, at the pace
 * the Pacer allows. Everything the subscription cannot take right now stays queued on the site —
 * no paid fallback exists. The poll doubles as the heartbeat the site shows (`arta/status`), so the
 * daemon keeps polling (at least once a minute) even while paused.
 */
export class Daemon {
  private attempts = new Map<number, number>();
  private skip = new Set<number>();
  private dry = new Set<number>();

  /**
   * `dryFile` (dry-run only): mentions already answered in dry run are written there, so a restart does
   * not prompt the chat again for the same mention — the site keeps them queued for the live run.
   */
  constructor(private d: Deps, private pacer: Pacer, private now: () => number = Date.now, private dryFile = "") {
    if (dryFile && d.cfg.dryRun) {
      try {
        const j = JSON.parse(readFileSync(dryFile, "utf8")) as { ids?: unknown };
        for (const id of Array.isArray(j.ids) ? j.ids : []) if (Number.isInteger(id)) this.dry.add(id as number);
      } catch { /* none yet */ }
    }
  }

  private rememberDry(id: number) {
    this.dry.add(id);
    if (!this.dryFile) return;
    try {
      mkdirSync(dirname(this.dryFile), { recursive: true });
      const tmp = `${this.dryFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ids: [...this.dry].slice(-1000) }));
      renameSync(tmp, this.dryFile);
    } catch (e) { this.d.log(`could not save dry-run memory: ${(e as Error).message}`); }
  }

  /** One poll and at most one mention. Resolves to the ms to sleep before the next tick. */
  async tick(): Promise<number> {
    const cfg = this.d.cfg;
    const now = this.now();
    const wait = this.pacer.waitMs(now);
    const pausedUntil = this.pacer.pausedUntil > now ? Math.ceil(this.pacer.pausedUntil / 1000) : 0;
    let items: Mention[];
    try {
      items = (await this.d.wp.pending(10, pausedUntil)).items || [];
    } catch (e) {
      this.d.log(`poll failed: ${(e as Error).message}`);
      return 30_000;
    }
    items = items.filter((m) => !this.skip.has(m.id) && !(cfg.dryRun && this.dry.has(m.id)));
    if (!items.length) return cfg.idlePollSec * 1000;
    if (wait > 0) return Math.min(wait, 60_000);

    const m = items[0];
    const attempt = (this.attempts.get(m.id) ?? 0) + 1;
    try {
      const out = await handleMention(m.id, { ...this.d, onPrompt: () => this.pacer.take(this.now()) }, attempt, MAX_ATTEMPTS);
      this.attempts.delete(m.id);
      if (out === "dry-run") this.rememberDry(m.id);
      if (this.pacer.pausedUntil) this.pacer.clearPause();
      this.d.log(`mention ${m.id}: ${out}`);
    } catch (e) {
      if (e instanceof EngineBusy) {
        this.pacer.pause(e.until, "chat usage limit");
        this.d.log(`paused until ${new Date(e.until).toISOString()}: ${e.message}`);
      } else if (e instanceof EngineDown) {
        this.pacer.pause(this.now() + cfg.downPauseSec * 1000, `down: ${e.reason}`);
        this.d.log(`ENGINE DOWN — ${e.reason}. Mentions wait in the queue; retrying in ${cfg.downPauseSec} s.`);
      } else {
        this.attempts.set(m.id, attempt);
        if (attempt >= MAX_ATTEMPTS) { this.skip.add(m.id); this.attempts.delete(m.id); }
      }
    }
    return cfg.pollSec * 1000;
  }
}
