import { useEffect, useState } from "react";
import { Button } from "./ui";
import { currentUser, isLoggedIn } from "../lib/wp";
import { BIRTHDAY_REQUIRED_EVENT } from "../lib/api";
import { VerifyApi } from "../lib/verify";
import { DobWheel } from "./DobWheel";

/* Date of birth must be a real date the server accepts (AQ\Verify: 13–120 years old). Bound the
   picker to that range so the native control opens near a plausible year; the server is the final
   word. Built from LOCAL calendar parts — toISOString() is UTC, so east of Greenwich it shifted the
   bound by a day and could refuse a member who had just turned 13. */
function isoYearsAgo(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const MIN_DOB = isoYearsAgo(120);
const MAX_DOB = isoYearsAgo(13);

/** An EXACT date of birth: a real calendar day, matching what AQ\Verify::valid_birthday accepts.
 *  A native control can still hand us a partial or impossible value on some platforms, so the
 *  day is re-derived and compared rather than trusted. */
function exactDate(ymd: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d && ymd >= MIN_DOB && ymd <= MAX_DOB;
}

/**
 * The sign-up step. ONE field: the exact date of birth (operator 2026-10-08: "I want the nationality
 * removed and the sign up is done smoothly and efficiently with just date of birth").
 *
 * WHAT LEFT, AND WHY IT IS SAFE TO LEAVE.
 *   - NATIONALITY is gone from the platform (see AQ\Verify's class doc). Not asked, not stored, not
 *     shown; values stated earlier stay in the database for ArtaCredits and are not displayed.
 *   - THE FULL NAME is no longer asked here. A member is already called something the moment the
 *     account exists — Google's name for a Google sign-in, their chosen display name otherwise — and
 *     that is what their posts are signed with. The full LEGAL name is only needed for the blue check,
 *     so it is asked where the blue check is (Account → Identity), by the people who want one.
 *   - THE OPTIONAL EXTRAS (city, relationship, languages) folded behind a link here until today. A
 *     link at the door still reads as "there is more to do"; they live in Settings, one tap from the
 *     profile, for whoever wants to say more.
 *
 * MOBILE FIRST. Below `sm` the step is a bottom sheet — the control and the button sit where the
 * thumb already is — and the three wheels are native selects, so a phone opens its own full-height
 * picker and no on-screen keyboard ever covers the button. From `sm` up it is a centred card. The
 * hint line under the date is reserved even when empty, so the error appearing never moves the
 * button out from under a finger.
 *
 * The RULE lives on the server (Rest::birthday_gate), which refuses every mutation from an account
 * with no exact date of birth — so it holds for API tokens, scripts and stale shells that never
 * learned to ask. Two independent triggers open this step:
 *   1. AQ_USER (injected by the theme) already says the account is incomplete — no round-trip, no
 *      flash of the app behind it;
 *   2. the backend refused a call with `birthday_required` — the authority itself, so a shell whose
 *      injected flags are stale or absent still cannot slip past.
 * Sign-out is always offered, so a member is never trapped.
 */
export function IdentityGate() {
  const u = currentUser();
  const [bday, setBday] = useState(u?.birthday || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [refused, setRefused] = useState(false); // the server said birthday_required

  // The backend is the authority: any refusal opens the step, whatever the shell believed.
  useEffect(() => {
    const open = () => setRefused(true);
    window.addEventListener(BIRTHDAY_REQUIRED_EVENT, open);
    return () => window.removeEventListener(BIRTHDAY_REQUIRED_EVENT, open);
  }, []);

  // Open for a signed-in member whose date of birth is missing or not exact. `has_identity === false`
  // stays fail-open on an undefined flag: a stale shell must never lock anyone out, because the
  // server-side refusal above closes that gap properly.
  const need = u && (u.has_identity === false || (u.birthday !== undefined && !exactDate(u.birthday)));
  const open = isLoggedIn() && !!(need || refused);
  if (!open) return null;

  const dobOk = exactDate(bday);
  const wrong = bday !== "" && !dobOk; // all three wheels set, and the date is out of range
  const ready = dobOk && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setErr("");
    try {
      // The date ALONE: an empty name leaves whatever name the account has untouched (AQ\Verify).
      const r = await VerifyApi.setIdentity("", bday);
      // STAY WHERE THEY WERE. A full navigation is still wanted — it refetches AQ_USER, so the gate
      // clears rather than lingering on stale flags — but to THIS page, not the front page: someone
      // halfway through booking a time met this step and must land back on their work. `replace` so
      // the step leaves nothing in the back button; the query string (an invitation link) rides along.
      if (r?.ok) window.location.replace(window.location.pathname + window.location.search);
      else setErr(r?.message || r?.error || "Couldn't save — check the date.");
    } catch {
      setErr("Couldn't save — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const logout = (window as unknown as { AQ_LOGOUT_URL?: string }).AQ_LOGOUT_URL || "/";
  const who = (u?.full_name || u?.name || "").trim();
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="aq-gate-title" aria-describedby="aq-gate-sub"
      className="fixed inset-0 z-[120] flex items-end justify-center overflow-y-auto overscroll-contain bg-space-0/92 backdrop-blur-sm sm:items-center sm:p-5">
      {/* A real <form>: Enter submits from any wheel. */}
      <form onSubmit={submit} noValidate
        className="w-full rounded-t-[1.5rem] border border-b-0 border-line bg-space-1 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl sm:max-w-[26rem] sm:rounded-card sm:border-b sm:p-7">
        {/* The sheet's grab bar — the shape a phone user reads as "this is a sheet", decorative only. */}
        <div aria-hidden className="mx-auto mb-4 h-1 w-10 rounded-full bg-veil/20 sm:hidden" />
        <h2 id="aq-gate-title" className="text-[22px] font-bold leading-tight tracking-tight text-ink sm:text-[24px]">When were you born?</h2>
        <p id="aq-gate-sub" className="mt-1.5 text-[14px] leading-snug text-ink-3">
          The last step. Your date of birth is shown on your profile.
        </p>

        <fieldset className="mt-5">
          <legend className="mb-1.5 block text-[13px] font-medium text-ink-2">Date of birth</legend>
          {/* Three wheels, not a date input. A native date picker opens on the CURRENT month, so
              someone born in 1994 starts ~380 taps away; day/month/year is one flick each. */}
          <DobWheel
            large
            value={bday}
            onChange={(v) => { setBday(v); setErr(""); }}
            minYear={Number(MIN_DOB.slice(0, 4))}
            maxYear={Number(MAX_DOB.slice(0, 4))}
            describedBy="aq-gate-dob-hint"
            invalid={wrong}
          />
          {/* ONE line, always present, so nothing moves: the age rule as a quiet hint, the same rule
              in rose once a chosen date is out of range, or the server's own words when a save fails.
              role="alert" only while it carries a problem, so a reader announces the problem alone. */}
          <p id="aq-gate-dob-hint" role={wrong || err ? "alert" : undefined}
            className={`mt-1.5 min-h-[1.25rem] text-[12.5px] ${wrong || err ? "text-rose-300" : "text-ink-3"}`}>
            {err || (wrong ? "You must be at least 13 to join." : "You need to be 13 or older.")}
          </p>
        </fieldset>

        <Button type="submit" size="xl" disabled={!ready} aria-disabled={!ready}
          className="mt-2 w-full text-[16px] disabled:opacity-50 disabled:hover:translate-y-0">
          {busy ? "Saving…" : "Continue"}
        </Button>

        <p className="mt-2 text-center text-[12.5px] text-ink-3">
          {who ? <>Signed in as <span className="font-semibold text-ink-2" data-ay-skip="1">{who}</span> · </> : null}
          {/* inline-block + py gives a ~40px tap target without moving the baseline */}
          <a href={logout} data-native className="inline-block py-2.5 text-ink-2 underline underline-offset-2 hover:text-yang">Not you? Sign out</a>
        </p>
      </form>
    </div>
  );
}
