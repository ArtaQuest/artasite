import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, ErrorNote, Input, LogoMark } from "../components/ui";
import { currentUser, googleClientId, googleSignIn, isLoggedIn, requestLoginCode, verifyLoginCode } from "../lib/auth";
import { currentTheme, type Theme } from "../lib/theme";
import { arta } from "../generated/arta/rig/arta";

// Passwordless sign-in — the Claude model. Enter your email, get a one-time 6-digit
// code, you're in (the account is created on first use). Or "Continue with Google".
// There is no password field anywhere: nothing to remember, set, reset, or leak.

type GsiCredential = { credential: string };
type GsiId = {
  initialize(cfg: { client_id: string; callback: (r: GsiCredential) => void; ux_mode?: string }): void;
  renderButton(parent: HTMLElement, opts: Record<string, unknown>): void;
};
function gsi(): GsiId | null {
  return (window as unknown as { google?: { accounts?: { id?: GsiId } } }).google?.accounts?.id ?? null;
}

// The active UI language, so the Google button renders localized to match the page.
function uiLang(): string {
  const w = window as unknown as { AQ_I18N?: { current?: string } };
  return (w.AQ_I18N?.current || document.documentElement.lang || "en").toLowerCase().split("-")[0];
}

// Only navigate to a same-origin / leading-slash target (defence-in-depth; the server
// also validates its `redirect`). Blocks open redirects from a crafted ?redirect_to=.
function safeRedirect(raw: string): string {
  if (!raw) return "/";
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).origin === window.location.origin ? raw : "/";
  } catch {
    return "/";
  }
  // Single leading slash only — block `//host` and `/\host`, which browsers can coerce into a
  // protocol-relative jump to another origin (the server's safe_redirect() now enforces the same).
  return raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/";
}

// Load Google Identity Services once, lazily (only when a client ID is configured),
// localized to the page language.
let gsiPromise: Promise<void> | null = null;
function loadGsi(lang: string): Promise<void> {
  if (gsi()) return Promise.resolve();
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://accounts.google.com/gsi/client${lang && lang !== "en" ? `?hl=${encodeURIComponent(lang)}` : ""}`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    // Don't cache a transient failure (network blip / ad-blocker toggled): clear the promise and
    // drop the dead tag so a later mount can re-attempt loading Google Identity Services.
    s.onerror = () => { gsiPromise = null; s.remove(); reject(new Error("gsi")); };
    document.head.appendChild(s);
  });
  return gsiPromise;
}

export default function Login() {
  const sp = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const redirect = safeRedirect(sp.get("redirect_to") || sp.get("redirect") || "/");
  const clientId = googleClientId();

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [expiresIn, setExpiresIn] = useState(600); // code validity window (seconds) — server-driven
  const [googleErr, setGoogleErr] = useState("");
  const [switching, setSwitching] = useState(false);
  const gbtn = useRef<HTMLDivElement>(null);
  const alreadyIn = isLoggedIn() && !switching;

  // The active theme, tracked live (ticket #51): the GSI button is a one-shot render,
  // not CSS-themed, so when the topbar toggle flips <html data-theme> mid-visit the
  // button must be re-rendered to match.
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(currentTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  // Resend countdown.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const onGoogle = useCallback(
    async (resp: GsiCredential) => {
      setBusy(true);
      setError("");
      try {
        const r = await googleSignIn(resp.credential, redirect);
        if (r.ok) {
          window.location.assign(safeRedirect(r.redirect || redirect));
          return;
        }
        setError(r.message || "Google sign-in failed. Please try again.");
      } catch {
        setError("Google sign-in failed. Please try again.");
      }
      setBusy(false);
    },
    [redirect],
  );

  // Render the official Google button on the email step (no-op without a client ID,
  // or while the "already signed in" card is showing).
  useEffect(() => {
    if (!clientId || step !== "email" || alreadyIn) return;
    let cancelled = false;
    loadGsi(uiLang())
      .then(() => {
        const id = gsi();
        if (cancelled || !id || !gbtn.current) return;
        id.initialize({ client_id: clientId, callback: onGoogle, ux_mode: "popup" });
        gbtn.current.innerHTML = "";
        // GSI requires a fixed pixel width (200–400). Clamp to the container so the button never
        // overflows a narrow viewport instead of hardcoding 360.
        const w = Math.max(200, Math.min(360, Math.round(gbtn.current.getBoundingClientRect().width) || 360));
        id.renderButton(gbtn.current, {
          // Match the active theme (#44): Google's dark button on the dark cosmos,
          // the outlined one on the light canvas.
          theme: theme === "light" ? "outline" : "filled_black",
          size: "large",
          shape: "pill",
          text: "continue_with",
          width: w,
          logo_alignment: "center",
        });
      })
      .catch(() => {
        if (!cancelled) setGoogleErr("Google sign-in is unavailable right now — use your email instead.");
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, step, alreadyIn, onGoogle, theme]);

  async function sendCode(e?: FormEvent, resend = false) {
    e?.preventDefault();
    const em = email.trim();
    if (!em) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await requestLoginCode(em);
      if (r.ok) {
        setStep("code");
        setCode("");
        setCooldown(r.cooldown || 45);
        setExpiresIn(r.expires_in || 600);
        if (resend) setNotice("A new code is on its way.");
      } else if (r.error === "captcha_failed") {
        // The bot gate refused us. A member cannot "try again" out of that — either their browser
        // could not reach Google or the key does not cover this domain — so point at the door that
        // does work rather than offering false comfort.
        setError("We could not verify this browser. Use Google below, or try again later.");
      } else {
        setError(r.message || "Could not send a code. Please try again.");
      }
    } catch {
      setError("Could not send a code. Please try again.");
    }
    setBusy(false);
  }

  async function verify(e?: FormEvent, codeArg?: string) {
    e?.preventDefault();
    const c = (codeArg ?? code).replace(/\D/g, "");
    if (c.length < 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await verifyLoginCode(email.trim(), c, redirect);
      if (r.ok) {
        window.location.assign(safeRedirect(r.redirect || redirect));
        return;
      }
      setError(r.message || "That code didn't work. Try again or request a new one.");
    } catch (err) {
      // The backend returns 4xx (so post() throws) for wrong/expired/locked codes — surface its
      // guidance (e.g. "Too many wrong codes. Request a new one.") instead of a generic message.
      const m = err instanceof Error ? err.message : "";
      setError(m && !m.includes("→") ? m : "That code didn't work. Try again or request a new one.");
    }
    setBusy(false);
  }

  /*
    Arta accompanies the sign-up without ever being in the way. It watches the
    flow rather than driving it, so it reacts to state that already exists
    instead of needing a hook in every handler:

      code sent  → it looks at where the code goes, the visitor's next problem
      error      → a shrug, which is the honest response to "that didn't work"
      signed in  → it cheers, once

    Everything is on a short delay. Reacting on the same frame as the UI reads as
    part of the UI; reacting a beat later reads as someone noticing.
    These sit ABOVE the `alreadyIn` early return on purpose. Placed below it they
    were called only on some renders, which is a rules-of-hooks violation: React
    throws "rendered fewer hooks than expected" the moment that branch flips,
    which it does the instant someone signs in.
  */
  const codeBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) { const t = window.setTimeout(() => arta.shrug(), 260); return () => window.clearTimeout(t); }
    if (step === "code") { const t = window.setTimeout(() => arta.pointAt(codeBox.current), 480); return () => window.clearTimeout(t); }
  }, [step, error]);
  useEffect(() => {
    if (!alreadyIn) return;
    const t = window.setTimeout(() => arta.cheer(), 300);
    return () => window.clearTimeout(t);
  }, [alreadyIn]);

  // Already signed in: don't show a pointless form — offer to continue, or switch account.
  if (alreadyIn) {
    const u = currentUser();
    return (
      <div className="mx-auto flex max-w-md flex-col items-center py-12">
        <LogoMark className="h-12 w-12" iconSize={26} />
        <h1 className="mt-4 text-[26px] font-bold tracking-tight">You're signed in</h1>
        {/* The member's NAME must not be baked into the rendered sentence: the i18n mesh collects whole
            text nodes and persists them into the PUBLIC aq_translations table, so "Signed in as Arash"
            became a translation row per member. Two nodes — the static half stays translatable, the
            name is skipped. */}
        <p className="mt-1 text-center text-[14px] text-ink-3">
          {u?.name ? <>Signed in as <span data-ay-skip="1">{u.name}</span></> : "You're already signed in to ArtaQuest."}
        </p>
        <div className="mt-7 flex w-full max-w-[360px] flex-col gap-3">
          <Button type="button" onClick={() => window.location.assign(redirect)} className="h-11 w-full text-[15px]">Continue</Button>
          <button type="button" onClick={() => { setSwitching(true); setStep("email"); }} className="text-center text-[13px] text-ink-3 hover:text-ink">Sign in as someone else</button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
    <div className="mx-auto flex max-w-md flex-col items-center pb-[150px] pt-12">
      <LogoMark className="h-12 w-12" iconSize={26} />
      <h1 className="mt-4 text-[26px] font-bold tracking-tight">Sign in to ArtaQuest</h1>
      <p className="mt-1.5 text-center text-[13.5px] text-ink-2">No password to invent, and nothing to remember afterwards.</p>

      <div ref={codeBox} className="mt-7 w-full max-w-[360px]">
        {error && <ErrorNote className="mb-4">{error}</ErrorNote>}

        {step === "email" ? (
          <>
            {clientId && (
              <>
                {/* [color-scheme:light] (ticket #51): the personalised "Continue as …" button is a
                    Google iframe whose document is light-scheme; on our color-scheme:dark page that
                    mismatch makes the browser paint the iframe's transparent canvas opaque white —
                    a white box around the dark pill. Declaring light here (it inherits to the
                    iframe element) keeps the canvas transparent in both themes. */}
                <div ref={gbtn} className="flex min-h-[44px] justify-center [color-scheme:light]" />
                {googleErr && <p role="status" className="mt-2 text-center text-[12px] text-ink-3">{googleErr}</p>}
                <div className="my-5 flex items-center gap-3 text-[12px] uppercase tracking-wide text-ink-3">
                  <span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" />
                </div>
              </>
            )}

            <form onSubmit={sendCode} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-[13px] text-ink-2">
                Email
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  required
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                />
              </label>
              <Button type="submit" disabled={busy} className="mt-1 h-11 w-full text-[15px]">
                {busy ? "Sending code…" : "Continue with email"}
              </Button>
            </form>

          </>
        ) : (
          <>
            {/* Instruction, not explanation (operator 2026-07-31). The tagline, the "no password
                needed" note and the spam-folder paragraph are gone — what stays is the address the
                code went to, which is the one thing a member has to check, and how long it lasts. */}
            <p id="aq-code-help" className="text-[14px] text-ink-2">
              Code sent to <strong className="text-ink" data-ay-skip="1">{email}</strong>
            </p>
            <p id="aq-code-hint" className="mt-1.5 text-[12.5px] text-ink-3">Valid for {Math.max(1, Math.round(expiresIn / 60))} minutes</p>
            {notice && <p role="status" className="mt-2 text-[13px] text-yang">{notice}</p>}
            <form onSubmit={verify} className="mt-4 flex flex-col gap-3">
              <Input
                value={code}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                  setCode(v);
                  // Auto-submit once the code is complete (typed or pasted) — no extra click.
                  if (v.length === 6 && !busy) void verify(undefined, v);
                }}
                autoFocus
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                aria-label="6-digit sign-in code"
                aria-describedby="aq-code-help aq-code-hint"
                placeholder="000000"
                className="text-center font-mono text-[26px] tracking-[0.5em]"
              />
              <Button type="submit" disabled={busy || code.replace(/\D/g, "").length < 6} className="mt-1 h-11 w-full text-[15px]">
                {busy ? "Signing in…" : "Verify & sign in"}
              </Button>
            </form>

            <div className="mt-5 flex items-center justify-center gap-3 text-[13px] text-ink-3">
              <button
                type="button"
                disabled={cooldown > 0 || busy}
                onClick={() => sendCode(undefined, true)}
                className="hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
              </button>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setError("");
                  setNotice("");
                  setCode("");
                }}
                className="hover:text-ink"
              >
                Use a different email
              </button>
            </div>
          </>
        )}
      </div>

      {/* Arta waits on the page's own baseline. `range` keeps it to the sides so it
          never wanders under the form, and pointer-events-none means it can never
          swallow a click meant for the code field. */}
    </div>
    </div>
  );
}
