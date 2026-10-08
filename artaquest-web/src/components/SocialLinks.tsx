import { useState } from "react";
import { SOCIAL_ICONS } from "../lib/social-icons";
import { displayHandle, type Social } from "../lib/socials";
import { cx } from "./ui";

/** The mark for one network — the brand path from Simple Icons, or a globe for a personal site. */
export function SocialIcon({ k, size = 20, className }: { k: string; size?: number; className?: string }) {
  const d = SOCIAL_ICONS[k];
  if (!d) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden className={className}>
        <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
      </svg>
    );
  }
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden className={className}><path d={d} /></svg>;
}

/** Copy text, with the textarea fallback for a context where the async clipboard is refused. */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

/** How many marks a PHONE shows before "+N". Two rows of six at 360–414px; wider screens show all. */
const PHONE_FIRST = 11;

/**
 * Where else this member is — a grid of round brand marks under the bio (operator 2026-10-08,
 * reversing 2026-08-18's "remove all the social links": the profile is now meant to carry them).
 *
 * MARKS, NOT CHIPS. Thirty-odd pills each reading "@artafather" is a wall of the same word; a
 * grid of recognisable logos is scannable at a glance, and the name of the network plus the handle
 * travel in the accessible name and the hover title. Every cell is 44px — a full tap target — and
 * the grid uses fixed 44px TRACKS so the columns line up row to row instead of a ragged wrap.
 *
 * ON A PHONE the list folds after two rows behind a "+N" cell, so the header does not become six
 * rows of icons above the member's actual work; from `sm` up every mark shows.
 *
 * WeChat and a Discord username have no public page: their cell COPIES the ID and says so in the
 * live line under the grid. Links open in a new tab with rel="me nofollow ugc" — `me` is the
 * identity claim (it is what Mastodon's verification reads), nofollow ugc because a member wrote it.
 */
export function SocialLinks({ socials, name }: { socials: Social[]; name: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!socials.length) return null;
  const folds = socials.length > PHONE_FIRST + 1;

  const cell = "grid h-11 w-11 place-items-center rounded-full border border-line bg-space-1 text-ink-2 transition-colors hover:border-yang hover:text-yang focus-visible:border-yang focus-visible:text-yang focus-visible:outline-none";
  return (
    <div className="mt-4">
      <h2 className="sr-only">{`${name} elsewhere`}</h2>
      <ul className="grid list-none grid-cols-[repeat(auto-fill,2.75rem)] gap-2" aria-label="Social profiles">
        {socials.map((s, i) => {
          const shown = displayHandle(s);
          const label = `${s.label}: ${shown}`;
          const hideOnPhone = folds && !open && i >= PHONE_FIRST;
          return (
            <li key={s.key} className={hideOnPhone ? "hidden sm:block" : undefined}>
              {s.url ? (
                <a href={s.url} target="_blank" rel="me nofollow ugc noopener noreferrer" aria-label={label} title={label} className={cell}>
                  <SocialIcon k={s.key} />
                </a>
              ) : (
                <button type="button" aria-label={`${label} — copy`} title={`${label} — tap to copy`} className={cell}
                  onClick={async () => setNote((await copyText(s.handle)) ? `${s.label} ID copied: ${s.handle}` : `${s.label}: ${s.handle}`)}>
                  <SocialIcon k={s.key} />
                </button>
              )}
            </li>
          );
        })}
        {folds && !open && (
          <li className="sm:hidden">
            <button type="button" onClick={() => setOpen(true)} aria-label={`Show all ${socials.length} social profiles`}
              className={cx(cell, "text-[13px] font-bold tabular-nums")}>
              +{socials.length - PHONE_FIRST}
            </button>
          </li>
        )}
      </ul>
      {/* Reserved one line high (only when something CAN be copied) so a copy confirmation never
          shifts the page under the finger. */}
      {socials.some((s) => !s.url) && (
        <p role="status" aria-live="polite" className="mt-1.5 min-h-[1.25rem] text-[12.5px] text-ink-3 wrap-anywhere">{note}</p>
      )}
    </div>
  );
}
