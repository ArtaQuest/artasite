import { useEffect, useState } from "react";
import { Button } from "./ui";
import { currentUser, isLoggedIn, localePath } from "../lib/wp";
import { BIRTHDAY_REQUIRED_EVENT } from "../lib/api";
import { VerifyApi } from "../lib/verify";
import { DobWheel } from "./DobWheel";
import CitySelect from "./CitySelect";
import { availableLangs } from "../lib/i18n";
import { postProfileUpdate, RELATIONSHIPS, LANGS_MAX } from "../lib/wp";
import { cityLabel } from "../lib/api";

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
/* Focus the first field on a pointer device only. On a phone autoFocus opens the keyboard
   immediately, covering the dialog before it has been read — and the member did not ask to type
   yet. matchMedia is read once at module load; this never changes within a session. */
const AUTOFOCUS = typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === true;

const field =
  "h-11 w-full rounded-field border border-line bg-space-1 px-3 text-[15px] text-ink outline-none transition-colors focus:border-yin-light";

/** An EXACT date of birth: a real calendar day, matching what AQ\Verify::valid_birthday accepts.
 *  A native date input can still hand us a partial or impossible value on some platforms, so the
 *  day is re-derived and compared rather than trusted. */
function exactDate(ymd: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d && ymd >= MIN_DOB && ymd <= MAX_DOB;
}

/**
 * The sign-up step. TWO fields: real full name, exact date of birth.
 *
 * **Nationality was removed (operator, 2026-07-30) — it is only needed for verification.** It was
 * being collected here, and worse, a legacy account that already had a name and a date of birth was
 * re-shown this whole dialog purely because it had no country. Asking every new member for
 * something only the blue check needs is a tax on joining; it lives on the Account page, next to
 * the ID upload that actually uses it.
 *
 * **No seasons framing here either (same instruction).** The previous copy explained the twelve
 * seasons and what the date of birth would be used to recommend. Whatever its merits elsewhere,
 * this is the moment someone is deciding whether to hand over their birthday, and the honest reason
 * is much shorter: on this platform the whole database is public, so a name and a date of birth are
 * public too, and every member states one.
 *
 * The RULE lives on the server (Rest::birthday_gate), which refuses every mutation from an account
 * with no exact date of birth — so it holds for API tokens, scripts and stale shells that never
 * learned to ask. Two independent triggers open this dialog:
 *   1. AQ_USER (injected by the theme) already says the account is incomplete — no round-trip, no
 *      flash of the app behind it;
 *   2. the backend refused a call with `birthday_required` — the authority itself, so a shell whose
 *      injected flags are stale or absent still cannot slip past.
 * Sign-out is always offered, so a member is never trapped.
 */
export function IdentityGate() {
  const u = currentUser();
  const [name, setName] = useState(u?.name || "");
  const [bday, setBday] = useState(u?.birthday || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The picked city and its coordinates. `pob` is only ever set by CHOOSING from the gazetteer, so
  // a half-typed "Teh" cannot be submitted as a place.
  const [pob, setPob] = useState("");
  const [geo, setGeo] = useState<{ lat: number; lon: number; tz: string } | null>(null);
  // Asked for here so a member states them ONCE, at the only moment they are already filling a form.
  // Optional — mandatory identity is name + date of birth + place of birth, and padding a sign-up
  // gate with four more required fields is how you lose the person on the other side of it.
  const [rel, setRel] = useState("");
  const [lives, setLives] = useState("");
  const [langs, setLangs] = useState<string[]>([]);
  const [refused, setRefused] = useState(false); // the server said birthday_required

  // The backend is the authority: any refusal opens the step, whatever the shell believed.
  useEffect(() => {
    const open = () => setRefused(true);
    window.addEventListener(BIRTHDAY_REQUIRED_EVENT, open);
    return () => window.removeEventListener(BIRTHDAY_REQUIRED_EVENT, open);
  }, []);

  // Open for a signed-in member with no identity, or whose date of birth is missing or not exact.
  // NOT for a missing nationality any more — that is the blue check's business, not joining's.
  // `has_identity === false` stays fail-open on an undefined flag: a stale shell must never lock
  // anyone out, because the server-side refusal above closes that gap properly.
  const need = u && (u.has_identity === false || (u.birthday !== undefined && !exactDate(u.birthday)));
  if (!isLoggedIn() || (!need && !refused)) return null;

  const nameOk = name.trim().length >= 2;
  const dobOk = exactDate(bday);
  // Place of birth is mandatory server-side (Verify::has_identity), so the button must not promise
  // otherwise — a member who cannot see WHY Continue is dead just meets a 400 after tapping it.
  const ready = nameOk && dobOk && pob !== "" && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setErr("");
    try {
      // Nationality intentionally blank — the server only writes it when non-empty.
      const r = await VerifyApi.setIdentity(name.trim(), bday, "", pob, geo ?? undefined);
      // The optional half rides on the profile endpoint, and only when there is something to say.
      // Deliberately AFTER identity and deliberately not awaited into the failure path: a member who
      // filled the gate must get through it even if this second call is refused.
      if (r?.ok && (rel || lives || langs.length)) {
        try { await postProfileUpdate(name.trim(), "", undefined, undefined, rel, lives, langs); } catch { /* their profile, not their gate */ }
      }
      // A full navigation refetches AQ_USER, so the gate clears rather than lingering on stale flags.
      if (r?.ok) window.location.assign(localePath("/"));
      else setErr(r?.message || r?.error || "Couldn't save — check your details.");
    } catch {
      setErr("Couldn't save — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const logout = (window as unknown as { AQ_LOGOUT_URL?: string }).AQ_LOGOUT_URL || "/";
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="aq-gate-title"
      /* MOBILE: `position: fixed; inset: 0` is the LAYOUT viewport, and iOS does not shrink that for
         the on-screen keyboard — so with the keyboard up, the bottom of this dialog sits behind it.
         The scroll container therefore carries a deep bottom pad on small screens: the member can
         always scroll Continue into view instead of it being trapped under the keys. The pad also
         clears the home indicator via safe-area-inset. */
      className="fixed inset-0 z-[120] grid place-items-center overflow-y-auto overscroll-contain bg-space-0/92 p-4 pb-[max(6rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:p-5 sm:pb-5">
      {/* A real <form>: Enter submits from either field. It was a div with a button, so the keyboard
          path — type name, tab, type date, Enter — did nothing at all. */}
      <form onSubmit={submit} className="my-auto w-full max-w-md rounded-card border border-line bg-space-1 p-5 shadow-2xl sm:p-7">
        {/* MINIMAL COPY (operator, 2026-07-31: "minimize front facing texts, no need to explain
            ourself"). Three paragraphs used to sit here — why the database is public, what an exact
            date means, what changing it later costs the blue check. Someone at a two-field form
            wants to fill it in, not read policy; all of it lives on /about and the Account page.
            What is left is a heading, two labels and the ONE line that appears when a date is
            actually wrong — feedback, not explanation. */}
        <h2 id="aq-gate-title" className="text-[22px] font-bold leading-tight text-ink">Tell us who you are</h2>
        {/* The gate got longer, so it now says which part is compulsory — otherwise a member reads
            seven fields and assumes all seven are. Three are. */}
        <p className="mt-1 text-[13px] text-ink-3">Name, date of birth and place of birth are required. The rest you can fill in now or later.</p>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-2">Full name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your full name"
              maxLength={80} autoComplete="name" autoFocus={AUTOFOCUS} className={field} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-2">Date of birth</span>
            {/* Three wheels, not a date input. A native date picker opens on the CURRENT month, so
                someone born in 1994 starts ~380 taps away; day/month/year is one flick each. */}
            <DobWheel
              value={bday}
              onChange={setBday}
              minYear={Number(MIN_DOB.slice(0, 4))}
              maxYear={Number(MAX_DOB.slice(0, 4))}
              describedBy={bday !== "" && !dobOk ? "aq-gate-dob-hint" : undefined}
              invalid={bday !== "" && !dobOk}
            />
            {/* role="alert" is what makes this reach a screen reader. The span appears only when a
                date is wrong, so it is inserted into the page rather than updated in place — a
                plain span would be described by nothing and announced by nobody. */}
            {bday !== "" && !dobOk && (
              <span id="aq-gate-dob-hint" role="alert" className="mt-1 block text-[12px] text-yin-ink">You must be at least 13</span>
            )}
          </label>
          <div className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-2">Place of birth</span>
            {/* A picker, not a text box: 34,078 cities, and the row carries the coordinates. */}
            <CitySelect
              value={pob}
              onPick={(c) => { setPob(cityLabel(c)); setGeo({ lat: c.lat, lon: c.lon, tz: c.tz }); }}
              onClear={() => { setPob(""); setGeo(null); }}
              required
            />
          </div>

          {/* THE REST OF THE PROFILE, asked once. Every one of these is optional and says so, and the
              button does not wait on them. They are here because a member who states them now never
              has to find the settings page to do it — which is where all three sat unfilled. */}
          <div className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-2">Where you live <span className="font-normal text-ink-3">(optional)</span></span>
            <CitySelect value={lives} suggestFromTimezone
              onPick={(c) => setLives(cityLabel(c))} onClear={() => setLives("")}
              placeholder="Start typing your city…" />
          </div>
          <div className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-2">Relationship <span className="font-normal text-ink-3">(optional)</span></span>
            <select value={rel} onChange={(e) => setRel(e.target.value)} aria-label="Relationship status" className={field}>
              <option value="">Prefer not to say</option>
              {RELATIONSHIPS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>
          <div className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-2">Languages you speak <span className="font-normal text-ink-3">(optional)</span></span>
            {langs.length > 0 && (
              <ul className="mb-1.5 flex list-none flex-wrap gap-1.5">
                {langs.map((code) => {
                  const l = availableLangs().find((x) => x.code === code);
                  return (
                    <li key={code}>
                      <button type="button" onClick={() => setLangs((cur) => cur.filter((c) => c !== code))}
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-yin bg-yin/15 px-3 text-[13px] text-ink">
                        <bdi dir={l?.dir || "ltr"} data-ay-skip="1">{l?.native || code}</bdi>
                        <span aria-hidden className="text-ink-3">×</span>
                        <span className="sr-only">Remove</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <select value="" aria-label="Add a language" className={field}
              onChange={(e) => { const c = e.target.value; if (c && !langs.includes(c) && langs.length < LANGS_MAX) setLangs((cur) => [...cur, c]); }}>
              <option value="">{langs.length >= LANGS_MAX ? `That is ${LANGS_MAX}` : "Add a language…"}</option>
              {availableLangs().filter((l) => !langs.includes(l.code)).map((l) => (
                <option key={l.code} value={l.code}>{l.native} — {l.name}</option>
              ))}
            </select>
          </div>
        </div>

        {err && <p role="alert" className="mt-3 text-[13px] text-yin-ink">{err}</p>}

        <Button type="submit" disabled={!ready} className="mt-5 h-11 w-full text-[15px] disabled:opacity-50">
          {busy ? "Saving…" : "Continue"}
        </Button>

        <p className="mt-3 text-center text-[12.5px] text-ink-3">
          Not you?{" "}
          {/* inline-block + py gives a ~40px tap target without moving the baseline */}
          <a href={logout} data-native className="inline-block py-2.5 text-ink-2 underline underline-offset-2 hover:text-yang">Sign out</a>
        </p>
      </form>
    </div>
  );
}
