import { useEffect, useRef, useState } from "react";
import { cx } from "./ui";

/**
 * The emoji picker for the composers.
 *
 * It replaces a fixed strip of six glyphs (😀 🔬 📐 🎉 🤯 ❤️) that had two problems the operator
 * could see: the choices were arbitrary — a microscope and a set square next to a party popper —
 * and the strip had to be hidden below 400px because it could not share the row with the counter
 * and Post. One trigger costs one slot at every width, so nothing has to be dropped on a phone.
 *
 * Deliberately a hand-picked list rather than a full Unicode set: a feed post is a sentence, not a
 * chat, and a 3,600-emoji grid is a scroll to nowhere. Groups are the ones people actually reach
 * for here — feeling, hands, work, and the platform's own subjects.
 */
const GROUPS: { name: string; emoji: string[] }[] = [
  { name: "Feeling", emoji: ["😀", "😄", "🙂", "😉", "🤩", "🥳", "😌", "🤔", "😅", "😭", "😮", "🔥", "❤️", "💛", "✨", "🎉"] },
  { name: "Hands", emoji: ["👍", "👏", "🙌", "🙏", "💪", "🤝", "👀", "🫶"] },
  { name: "Work", emoji: ["📓", "📊", "📈", "🧪", "🔬", "🧠", "💡", "⚙️", "🛠️", "🧭", "📐", "🧵", "⏱️", "✅", "🚀", "🏁"] },
  { name: "World", emoji: ["🌍", "🌙", "⭐", "🎵", "🎨", "🎬", "📷", "🌱"] },
];

/** Tallest the panel can be, and the room it needs above the trigger before it must flip down. */
const PANEL_PX = 272;

export function EmojiPicker({ onPick, className }: { onPick: (e: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  // Opens UPWARD from a control that sits at the bottom of the composer — except when the composer
  // is near the top of the window (it is the first thing on the feed), where upward would run off
  // the screen. Measured at the moment of opening, so a scrolled page gets the right answer.
  const [up, setUp] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div ref={ref} className={cx("relative", className)}>
      <button
        type="button"
        onClick={(e) => {
          setUp(e.currentTarget.getBoundingClientRect().top > PANEL_PX + 16);
          setOpen((o) => !o);
        }}
        aria-haspopup="dialog" aria-expanded={open} aria-label="Emoji" title="Emoji"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-yin-ink transition-colors hover:bg-veil/[0.06]"
      >
        {/* An outline face, not an emoji glyph: the trigger sits beside the paperclip and the two
            must read as one family of controls, whatever the platform draws for 😀. */}
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
          <path d="M9 9.5h.01M15 9.5h.01" />
        </svg>
      </button>
      {open ? (
        <div role="dialog" aria-label="Emoji"
          className={cx("absolute z-30 max-h-[17rem] w-[17.5rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-card border border-line bg-space-2 p-2 shadow-card",
            up ? "bottom-full mb-2" : "top-full mt-2")}>
          {GROUPS.map((g) => (
            <div key={g.name} className="mb-1.5 last:mb-0">
              <p className="px-1 pb-1 text-[10px] uppercase tracking-wider text-ink-3">{g.name}</p>
              <div className="grid grid-cols-8 gap-0.5">
                {g.emoji.map((e) => (
                  <button key={e} type="button"
                    onClick={() => { onPick(e); setOpen(false); }}
                    aria-label={e} title={e}
                    className="grid h-8 w-8 place-items-center rounded-lg text-[18px] leading-none transition-colors hover:bg-veil/[0.10]"
                  >{e}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
