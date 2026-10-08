import type { Config } from "./config";
import { type Fetch, HttpError, timed } from "./http";
import type { Kind, Mention } from "./types";

/**
 * The brain's side of the WordPress API (src/Arta.php). Every call is POST — the platform caches
 * anonymous GETs at the edge, and these must never be cached — and carries X-Arta-Token.
 */
export class WpClient {
  constructor(private cfg: Config, private f: Fetch = fetch) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await timed(this.f, `${this.cfg.wpBase}/wp-json/aq/v1/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Arta-Token": this.cfg.replyToken, "User-Agent": "arta-brain/1" },
      body: JSON.stringify(body ?? {}),
    }, 20000);
    const text = await r.text();
    if (!r.ok) throw new HttpError(r.status, `WordPress ${path} → ${r.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Exclusive claim. Null when someone else has it (409) or it is gone (404/410). */
  async claim(id: number): Promise<Mention | null> {
    try {
      const r = await this.post<{ ok: boolean; mention: Mention }>(`arta/mentions/${id}/claim`, {});
      return r.mention ?? null;
    } catch (e) {
      if (e instanceof HttpError && [404, 409, 410].includes(e.status)) return null;
      throw e;
    }
  }

  reply(mentionId: number, body: string, kind: Kind, issue?: { url: string; title: string }) {
    return this.post<{ ok: boolean; duplicate: boolean; url: string }>("arta/reply", {
      mention_id: mentionId, body, kind,
      ...(issue ? { issue_url: issue.url, issue_title: issue.title } : {}),
    });
  }

  status(id: number, status: "skipped" | "failed" | "queued", note: string) {
    return this.post<{ ok: boolean }>(`arta/mentions/${id}/status`, { status, note: note.slice(0, 180) });
  }

  /** The poll (and heartbeat). `pausedUntil` (unix s, 0 = running) lets the site say when Arta is back. */
  pending(limit = 10, pausedUntil = 0) {
    return this.post<{ items: Mention[] }>("arta/pending", { status: "queued", limit, paused_until: pausedUntil });
  }
}
