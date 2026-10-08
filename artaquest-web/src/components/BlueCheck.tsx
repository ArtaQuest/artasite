import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { createPortal } from "react-dom";
import { isLoggedIn, localePath } from "../lib/wp";

/**
 * THE BLUE CHECK — an X-style verified seal: a scalloped eight-lobed rosette in the theme's blue with a
 * white tick, drawn as one SVG so it is crisp at every size and in both themes.
 *
 * A member carries it when Verify::has_badge() is true on the server — they EARNED it (the ID +
 * selfie check, which also unlocks cash-out) or an operator GRANTED it (wp-admin / WP-CLI, badge
 * only). Every public payload ships that one flag as `verified`; nothing in the SPA decides it.
 *
 *   <BlueCheck />        — the inert mark beside a name in a list, card, byline or comment (it sits
 *                          inside links, so it must not be a control itself). Tooltip via <title>.
 *   <BlueCheckButton />  — the profile header's: a real button that opens a small explainer, on
 *                          hover for a mouse and on tap/Enter for everything else (X's pattern).
 */

/** Generated, not hand-drawn: r(θ) = R·(1 − a + a·cos 8θ), R 10.1, a 0.085, 96 samples. */
const ROSETTE = "M12 1.90L12.65 2.04L13.26 2.41L13.80 2.94L14.28 3.49L14.73 3.95L15.21 4.26L15.76 4.38L16.41 4.37L17.13 4.32L17.89 4.33L18.58 4.49L19.14 4.86L19.51 5.42L19.67 6.11L19.68 6.87L19.63 7.59L19.62 8.24L19.74 8.79L20.05 9.27L20.51 9.72L21.06 10.20L21.59 10.74L21.96 11.35L22.10 12L21.96 12.65L21.59 13.26L21.06 13.80L20.51 14.28L20.05 14.73L19.74 15.21L19.62 15.76L19.63 16.41L19.68 17.13L19.67 17.89L19.51 18.58L19.14 19.14L18.58 19.51L17.89 19.67L17.13 19.68L16.41 19.63L15.76 19.62L15.21 19.74L14.73 20.05L14.28 20.51L13.80 21.06L13.26 21.59L12.65 21.96L12 22.10L11.35 21.96L10.74 21.59L10.20 21.06L9.72 20.51L9.27 20.05L8.79 19.74L8.24 19.62L7.59 19.63L6.87 19.68L6.11 19.67L5.42 19.51L4.86 19.14L4.49 18.58L4.33 17.89L4.32 17.13L4.37 16.41L4.38 15.76L4.26 15.21L3.95 14.73L3.49 14.28L2.94 13.80L2.41 13.26L2.04 12.65L1.90 12L2.04 11.35L2.41 10.74L2.94 10.20L3.49 9.72L3.95 9.27L4.26 8.79L4.38 8.24L4.37 7.59L4.32 6.87L4.33 6.11L4.49 5.42L4.86 4.86L5.42 4.49L6.11 4.33L6.87 4.32L7.59 4.37L8.24 4.38L8.79 4.26L9.27 3.95L9.72 3.49L10.20 2.94L10.74 2.41L11.35 2.04Z";
/** THE THEME'S BLUE (operator 2026-10-08: "blue check should use the theme color"): the seal is
 *  filled with the --color-yin token (`fill-yin`), never a hex, so it follows the theme and every
 *  contrast step. Each value that token takes (#1746dc, and #0035f8…#415db7 under the contrast
 *  settings) keeps the white tick above 4.5:1. The tick stays literal white in both themes. */
const SEAL = "fill-yin";

export function BlueCheck({ size = 16, className = "", title = "Verified account" }: { size?: number; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`inline-block shrink-0 align-[-0.15em] ${className}`}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}>
      {title ? <title>{title}</title> : null}
      <path className={SEAL} d={ROSETTE} />
      <path d="M7.9 12.3l2.75 2.75 5.5-5.75" fill="none" stroke="#fff" strokeWidth="2.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const WHY: Record<string, string> = {
  id: "This member confirmed their name and date of birth against a government photo ID, matched to a selfie.",
  team: "ArtaQuest confirmed this account belongs to the person it represents.",
};

/** The profile header's badge: a button with an explainer popover. `via` is the profile payload's
 *  verified_via ('id' | 'team'); `own` swaps the call to action for the owner. */
export function BlueCheckButton({ size = 20, via = "", own = false, className = "" }: { size?: number; via?: string; own?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const hoverT = useRef<number | undefined>(undefined);
  const id = useId();

  const place = () => {
    const b = btn.current?.getBoundingClientRect();
    if (!b) return;
    const W = Math.min(300, window.innerWidth - 24);
    const left = Math.max(12, Math.min(b.left + b.width / 2 - W / 2, window.innerWidth - W - 12));
    setPos({ position: "fixed", top: b.bottom + 8, left, width: W, zIndex: 100 });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    const shut = () => setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
    };
  }, [open]);
  useEffect(() => () => window.clearTimeout(hoverT.current), []);

  // A mouse opens it on hover (after a beat, so passing over does nothing) and it stays while the
  // pointer is on the badge or the card; touch and keyboard use the click.
  const hoverIn = (e: RPointerEvent) => {
    if (e.pointerType !== "mouse") return;
    window.clearTimeout(hoverT.current);
    hoverT.current = window.setTimeout(() => setOpen(true), 250);
  };
  const hoverOut = (e: RPointerEvent) => {
    if (e.pointerType !== "mouse") return;
    window.clearTimeout(hoverT.current);
    hoverT.current = window.setTimeout(() => setOpen(false), 200);
  };

  return (
    <>
      <button ref={btn} type="button" aria-label="Verified account" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)} onPointerEnter={hoverIn} onPointerLeave={hoverOut}
        className={`-m-1 inline-grid shrink-0 place-items-center rounded-full p-1 transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-yin-light ${className}`}>
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="block">
          <path className={SEAL} d={ROSETTE} />
          <path d="M7.9 12.3l2.75 2.75 5.5-5.75" fill="none" stroke="#fff" strokeWidth="2.15" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div ref={panel} id={id} role="dialog" aria-label="Verified account" style={pos}
          onPointerEnter={(e) => { if (e.pointerType === "mouse") window.clearTimeout(hoverT.current); }} onPointerLeave={hoverOut}
          className="rounded-2xl border border-line bg-space-2 p-4 text-start shadow-[0_18px_44px_-12px_rgba(2,8,20,0.45)]">
          <p className="flex items-center gap-2 text-[15px] font-bold text-ink">
            <BlueCheck size={20} title="" /> Verified account
          </p>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
            {WHY[via] || "ArtaQuest has confirmed this account is who it says it is."}
          </p>
          {own ? (
            <a href={localePath("/user-account/?settings=1")} className="mt-3 inline-block text-[13.5px] font-semibold text-yin-ink hover:underline">
              Your identity settings <span aria-hidden className="inline-block rtl:-scale-x-100">→</span>
            </a>
          ) : isLoggedIn() ? (
            <a href={localePath("/user-account/?settings=1")} className="mt-3 inline-block text-[13.5px] font-semibold text-yin-ink hover:underline">
              Get verified <span aria-hidden className="inline-block rtl:-scale-x-100">→</span>
            </a>
          ) : null}
        </div>,
        document.body,
      )}
    </>
  );
}
