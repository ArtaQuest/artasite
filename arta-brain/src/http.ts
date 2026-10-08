export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** An HTTP failure that carries its status, so callers can tell "gone" from "try again". */
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** fetch with a hard timeout. */
export async function timed(f: Fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await f(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}
