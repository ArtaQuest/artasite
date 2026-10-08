import { type Fetch, HttpError, timed } from "./http";

export type Issue = { number: number; url: string; title: string; body: string; state: string; created: string };

/**
 * The few GitHub calls bug filing needs, with a token scoped to Issues on one repository. Uses the
 * plain issues list (immediately consistent) rather than search (indexed with a delay), so a
 * retry seconds after filing still sees the issue it just made.
 */
export class GitHub {
  constructor(private token: string, private repo: string, private f: Fetch = fetch) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await timed(this.f, `https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "arta-brain",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    }, 20000);
    const text = await r.text();
    if (!r.ok) throw new HttpError(r.status, `GitHub ${path.split("?")[0]} → ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  /** The newest issues Arta filed (open and closed), newest first. */
  async recent(): Promise<Issue[]> {
    type Raw = { number: number; html_url: string; title: string; body: string | null; state: string; created_at: string; pull_request?: unknown };
    const rows = await this.call<Raw[]>(`/repos/${this.repo}/issues?labels=from-arta&state=all&sort=created&direction=desc&per_page=100`);
    return rows.filter((r) => !r.pull_request).map((r) => ({
      number: r.number, url: r.html_url, title: r.title, body: r.body || "", state: r.state, created: r.created_at,
    }));
  }

  async create(title: string, body: string, labels: string[]): Promise<Issue> {
    const r = await this.call<{ number: number; html_url: string; title: string; state: string; created_at: string }>(`/repos/${this.repo}/issues`, {
      method: "POST", body: JSON.stringify({ title, body, labels }),
    });
    return { number: r.number, url: r.html_url, title: r.title, body, state: r.state, created: r.created_at };
  }
}
