import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type PaceLimits = { minGapSec: number; perHour: number; perDay: number };
type State = { stamps: number[]; pausedUntil: number; reason: string };

/**
 * A plain, conservative rate governor for the chat subscription: one prompt at a time, at least
 * `minGapSec` apart, at most `perHour` / `perDay` in rolling windows, plus an explicit pause (the
 * service reported a limit, or the page is signed out). State survives restarts, so a crash loop can
 * never reset the caps. Everything that would exceed them simply waits in the site's queue.
 */
export class Pacer {
  private s: State = { stamps: [], pausedUntil: 0, reason: "" };

  constructor(private lim: PaceLimits, private file = "") {
    if (file) {
      try {
        const j = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
        this.s = { stamps: Array.isArray(j.stamps) ? j.stamps.filter((n) => typeof n === "number") : [], pausedUntil: Number(j.pausedUntil) || 0, reason: String(j.reason || "") };
      } catch { /* first run */ }
    }
  }

  /** ms to wait before the next prompt may start (0 = now). */
  waitMs(now: number): number {
    this.s.stamps = this.s.stamps.filter((t) => t > now - 86_400_000);
    const st = this.s.stamps;
    const waits = [0, this.s.pausedUntil - now];
    if (st.length) waits.push(st[st.length - 1] + this.lim.minGapSec * 1000 - now);
    const hour = st.filter((t) => t > now - 3_600_000);
    if (hour.length >= this.lim.perHour) waits.push(hour[hour.length - this.lim.perHour] + 3_600_000 - now);
    if (st.length >= this.lim.perDay) waits.push(st[st.length - this.lim.perDay] + 86_400_000 - now);
    return Math.max(...waits);
  }

  /** Record a prompt being sent now. */
  take(now: number) { this.s.stamps.push(now); this.save(); }

  pause(until: number, reason: string) {
    if (until > this.s.pausedUntil) { this.s.pausedUntil = until; this.s.reason = reason; this.save(); }
  }

  clearPause() { if (this.s.pausedUntil) { this.s.pausedUntil = 0; this.s.reason = ""; this.save(); } }

  get pausedUntil() { return this.s.pausedUntil; }
  get reason() { return this.s.reason; }
  usage(now: number) {
    return { lastHour: this.s.stamps.filter((t) => t > now - 3_600_000).length, lastDay: this.s.stamps.filter((t) => t > now - 86_400_000).length };
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.s));
    renameSync(tmp, this.file);
  }
}
