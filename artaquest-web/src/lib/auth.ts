/**
 * Self-contained passwordless-auth client for the sign-in page.
 *
 * Talks to the backend /auth/* routes directly (own fetch; deliberately NO nonce — see postAuth) so
 * it has NO dependency on modules that other work may be refactoring — the login page keeps working
 * regardless.
 *
 * NO CAPTCHA, by decision (operator, 2026-07-31): "we are bot friendly. just ensure rate limiting is
 * implemented." Abuse is bounded on the server, where it can actually be counted — per-address and
 * per-IP limits on requesting a code, and a hard cap on how many sign-in emails an address can be
 * sent per hour. A client-side humanity test never bounded any of that; it only made the first
 * interaction slower and, on a filtered network, impossible.
 */

const BASE = "/wp-json/aq/v1";
const NONCE =
  (typeof window !== "undefined" && (window as unknown as { AQ_WP_NONCE?: string }).AQ_WP_NONCE) || "";

export type AuthResult = {
  ok?: boolean; error?: string; message?: string;
  redirect?: string; expires_in?: number; cooldown?: number;
  /** HTTP status of the reply; 0 when the request never completed. A 429 from WP.com's EDGE arrives
   *  as an HTML page, so there is no `message` to show and every failure would otherwise look
   *  identical — and get the same "try again", which is false comfort when retrying cannot help. */
  status?: number;
};

/**
 * NO X-WP-NONCE HERE, deliberately — it can only ever turn a success into a failure.
 *
 * All three sign-in routes are declared 'public' (Rest::ROUTES), so the nonce buys nothing. But WP
 * core's rest_cookie_check_errors refuses a request whose nonce is PRESENT AND INVALID before
 * dispatch, for any route, while a request with NO nonce is simply treated as logged-out and runs
 * normally. NONCE is a module-level const read once from the shell's baked window.AQ_WP_NONCE and
 * never refreshed, and /login/ is served from WP.com's edge cache — so the value is shared between
 * visitors and ages with the cache entry, not with the person. Past a tick (nonce_life is 86400, so
 * 12-24h) every sign-in became 403 "Cookie check failed", shown raw, with resend reusing the same
 * dead nonce; only a hard reload recovered. Any long-lived tab could reach that state, since
 * client-side routing to /login/ never re-reads the shell.
 *
 * Reproduced on prod 2026-07-31: the same POST answers 403 rest_cookie_invalid_nonce with a bogus
 * nonce header and 400 bad_email without it.
 *
 * signOut() below keeps its nonce — /auth/logout is a real authenticated mutation, and it already
 * refetches a fresh nonce and retries when the first one is stale.
 */
async function postAuth(path: string, body: Record<string, unknown>): Promise<AuthResult> {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Bounded, like every signOut() call below. A hung request surfaces the catch's "Network
      // error. Please try again." instead of freezing the button on "Sending code…".
      signal: AbortSignal.timeout(15000),
    });
    const j = (await r.json().catch(() => ({}))) as AuthResult;
    if (!r.ok) return { ok: false, status: r.status, error: j.error, message: j.message };
    return { ...j, status: r.status };
  } catch {
    return { ok: false, status: 0, message: "Network error. Please try again." };
  }
}

// ── Passwordless sign-in ────────────────────────────────────────────────────────────────────────
export function requestLoginCode(email: string): Promise<AuthResult> {
  // Nothing runs before this call any more. It used to await a Google reCAPTCHA token first — the
  // one unbounded await in the sign-in path, and on a network where www.google.com is blackholed
  // rather than refused it never settled, so the button sat on "Sending code…" for ever. The
  // operator's call (2026-07-31) settles it: this platform is bot-friendly and ships a Developer
  // API, so proving humanity was the wrong question. Abuse is bounded server-side by rate limits.
  return postAuth("/auth/request-code", { email });
}
export function verifyLoginCode(email: string, code: string, redirect = "/"): Promise<AuthResult> {
  return postAuth("/auth/verify-code", { email, code, redirect });
}
export function googleSignIn(credential: string, redirect = "/"): Promise<AuthResult> {
  return postAuth("/auth/google", { credential, redirect });
}

// ── Sign out (ticket #42 — immediate, no WP confirmation interstitial) ────────────────────────────
/** The visitor's locale-prefixed homepage ("/" for English) — where sign-out lands. */
function homePath(): string {
  if (typeof window === "undefined") return "/";
  const lang = ((window as unknown as { AQ_I18N?: { current?: string } }).AQ_I18N?.current || "en").toLowerCase().split("-")[0];
  return !lang || lang === "en" ? "/" : `/${lang}/`;
}
/** The classic nonce-carrying WP logout URL — the last-resort fallback only. */
function logoutUrl(): string {
  if (typeof window === "undefined") return "/wp-login.php?action=logout";
  return (window as unknown as { AQ_LOGOUT_URL?: string }).AQ_LOGOUT_URL || "/wp-login.php?action=logout";
}

/**
 * Sign this device out NOW and land on the homepage. Primary path is POST /auth/logout
 * (wp_logout() server-side — session token destroyed, cookies cleared), which authenticates
 * with the live session cookie + REST nonce instead of the `log-out` nonce baked into the
 * shell HTML — that baked nonce goes stale (the PWA service worker caches the shell, and
 * nonces only live 12–24h), which is what made wp-login.php?action=logout stop at the
 * "Do you really want to log out?" confirmation page (ticket #42). If the page's REST nonce
 * is itself stale, fetch a fresh one (core's admin-ajax `rest-nonce` — the same refresh
 * wp-auth-check uses) and retry once. Only when the API is truly unreachable fall back to
 * navigating the classic logout URL — worst case WP asks to confirm, never a dead end.
 * Every request is time-bounded so a hung network can't strand the click.
 */
export async function signOut(): Promise<void> {
  const logout = (nonce: string) =>
    fetch(`${BASE}/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(nonce ? { "X-WP-Nonce": nonce } : {}) },
      body: "{}",
      signal: AbortSignal.timeout(8000),
    });
  try {
    let r = await logout(NONCE);
    if (!r.ok) {
      const fresh = await fetch("/wp-admin/admin-ajax.php?action=rest-nonce", {
        credentials: "include",
        signal: AbortSignal.timeout(8000),
      });
      const nonce = (await fresh.text()).trim();
      if (!fresh.ok || !/^[a-f0-9]{10}$/i.test(nonce)) throw new Error("nonce");
      r = await logout(nonce);
      // With a definitely-fresh nonce, 401/403 means this device holds no live session
      // (signed out in another tab / expired) — already the desired end state: go home.
      if (!r.ok && r.status !== 401 && r.status !== 403) throw new Error(String(r.status));
    }
    window.location.assign(homePath());
  } catch {
    window.location.assign(logoutUrl());
  }
}

// ── First-paint identity helpers (server-injected window globals) ─────────────────────────────────
export function googleClientId(): string {
  if (typeof window === "undefined") return "";
  return (window as unknown as { AQ_GOOGLE_CLIENT_ID?: string }).AQ_GOOGLE_CLIENT_ID || "";
}
export function currentUser(): { name: string; avatar: string; slug?: string; country?: string } | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { AQ_USER?: { name: string; avatar: string; slug?: string; country?: string } }).AQ_USER ?? null;
}
export function isLoggedIn(): boolean {
  if (typeof window === "undefined") return false;
  const v = (window as unknown as { AQ_LOGGED_IN?: boolean }).AQ_LOGGED_IN;
  return v === undefined ? true : !!v;
}
