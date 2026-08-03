import { useEffect, useRef, useState } from "react";
import { currentTheme, applyTheme, calmStop, setCalmStop, CALM_STOPS, type Theme } from "../lib/theme";
import { Segmented, useViewportNudge } from "./ui";
import { currentLevel, setContrast, applyContrast, LEVELS } from "../lib/contrast";

/**
 * Display switcher (ticket: contrast-slider). Replaces the bare ThemeToggle in both shells.
 * A tap opens a small popover: dark/light theme + a 5-stop "Calm ↔ Crisp" text-contrast slider
 * (the perceptual comfort control, lib/contrast). Switching the theme re-derives the contrast
 * (the canvas moves), so the two stay in sync. Same outside-click/Escape popover idiom as LanguageSelector.
 */
const STOPS = ["Calm", "Soft", "Standard", "Crisp", "Max"]; // 5 levels; Standard (3) = optimal default

export function BackgroundSwitcher() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [level, setLevel] = useState(() => currentLevel());
  const [calm, setCalm] = useState(() => calmStop());
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Apply the saved contrast on first mount (defensive — main.tsx also applies pre-render).
  useEffect(() => { applyContrast(); }, []);

  // Move focus into the popover when it opens (its label is announced); return focus to the trigger
  // when it closes via the keyboard, so a keyboard user is never dropped at the top of the page.
  useEffect(() => { if (open) panelRef.current?.focus(); }, [open]);

  // Thin phones: the 260px panel end-aligns to a trigger sitting mid-row, so its far edge would
  // clip off-screen — nudge it back inside the viewport.
  useViewportNudge(panelRef, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  function pickTheme(t: Theme) {
    applyTheme(t);
    setTheme(t);
    applyContrast(level); // the canvas changed → re-tint the ink against it
  }
  function pickLevel(v: number) {
    setLevel(setContrast(v)); // persists + applies, returns the clamped level
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Display settings"
        title="Display settings"
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-field transition-colors hover:bg-veil/5 ${open ? "text-yang" : "text-ink-2 hover:text-ink"}`}
      >
        {/* Half-filled disc — the classic contrast glyph */}
        <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Display settings"
          tabIndex={-1}
          className="absolute end-0 top-full z-50 mt-1.5 w-[260px] rounded-card border border-line bg-space-1 p-3.5 shadow-2xl outline-none"
        >
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Theme</div>
          <Segmented
            label="Theme"
            value={theme}
            onChange={(v) => pickTheme(v as Theme)}
            options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]}
          />

          <div className="mt-3.5 mb-1.5 flex items-baseline justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Text contrast</span>
            <span className="text-[12px] font-medium text-ink-2">{STOPS[level - 1]}</span>
          </div>
          <input
            type="range"
            min={1}
            max={LEVELS}
            step={1}
            value={level}
            onChange={(e) => pickLevel(Number(e.target.value))}
            aria-label="Text contrast"
            aria-valuetext={STOPS[level - 1]}
            className="aq-contrast-range w-full"
          />
          <div className="mt-1 flex justify-between text-[10px] text-ink-2">
            <span>Calm</span>
            <span>Crisp</span>
          </div>

          {/* Live preview — paints in the just-applied --color-ink so the change is visible immediately. */}
          <div className="mt-3 rounded-field border border-line bg-space-2 px-3 py-2">
            <p className="m-0 text-[14px] text-ink">The quick brown fox</p>
            <p className="m-0 text-[12px] text-ink-2">jumps over the lazy dog</p>
          </div>

          {/* Motion calm — 5 stops mirroring the contrast slider. Thresholds are DERIVED from
              the percentiles of the platform's measured change-rate distribution (Standard flags
              half of all video content); a flagged video never autoplays — tap ▶ to play. */}
          <div className="mt-3.5 mb-1.5 flex items-baseline justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Motion calm</span>
            <span className="text-[12px] font-medium text-ink-2">{CALM_STOPS[calm - 1]}</span>
          </div>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={calm}
            onChange={(e) => setCalm(setCalmStop(Number(e.target.value)))}
            aria-label="Motion calm"
            aria-valuetext={CALM_STOPS[calm - 1]}
            className="aq-contrast-range w-full"
          />
          <div className="mt-1 flex justify-between text-[10px] text-ink-2">
            <span>Still</span>
            <span>All</span>
          </div>
          <p className="m-0 mt-1 text-[10px] leading-snug text-ink-2">
            Fast-changing videos above your stop are flagged and never autoplay. Standard flags half of
            all measured video content; every video's change rate is measured and public.
          </p>
        </div>
      )}
    </div>
  );
}
