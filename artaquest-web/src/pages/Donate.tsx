import { useEffect, useMemo, useState } from "react";
import {
  getDonateOptions, getFoundationFinances, getStripeVerify, postCourseCheckout, isLoggedIn,
  localePath, currentUser, uiLocale, type DonateOptions, type FoundationFinances,
} from "../lib/wp";
import { creditOptions, creditReach, myCredits, sampleCert, widenCredit, type CreditOptions, type CreditReach, type CreditGift } from "../lib/api";
import { Coins, formatFiat, sanitizeDecimal } from "../lib/currency";
import { Button, Card, Chip, PageHero, StatusNote, cx } from "../components/ui";
import { DomainGlyph } from "../components/catalogue";
import { ParticipationDoc } from "../components/participation";

const w = (typeof window !== "undefined" ? (window as unknown as Record<string, string>) : {}) || {};

/**
 * DONATE (rebuilt 2026-08-03 around ArtaCredits).
 *
 * A donation is now ONE decision made three times: who your gift reaches, how much, and what name
 * goes on their certificate. It buys challenge entry fees — the only thing on ArtaQuest that costs a
 * member money — for a slice of the membership the donor chooses by nationality, gender and age.
 *
 * Two things this page must not do, both learned the hard way:
 *   · It must not publish who is where. The database is public, so a per-country member count next
 *     to a money bucket is both a disclosure and a targeting oracle. The reach line is asked for one
 *     slice at a time, for the donor's own pick, and floors to "fewer than 5".
 *   · It must not overclaim. A credit buys ONE entry. It is not a prize, not a vote, not standing,
 *     and it never reaches a member who has not agreed to accept it, in the moment, by name.
 */

/** The foundation's entire public financial picture — what the fund holds (fiat), the gold-backed
 *  coin reserve, and the recent fund movements. 100% real data, public to everyone.
 *
 *  Every figure here is read STRICTLY as the API returns it, which is not what the old labels said:
 *  `foundation/finances` sums the per-bucket COUNTERS, so `total_cents` is the money still on hand
 *  (a spend appends a negative row and lowers it), not a lifetime "donations received"; `recent` is
 *  the last 25 ledger rows in DOLLARS, spends included, so a row is not always a gift and never a
 *  coin; and `fund_issued` is not carried at all (wp.ts fills 0). Labels below match all three. */
function FoundationBooks({ fin }: { fin: FoundationFinances }) {
  const fmt = (s: number) => (s ? new Date(s * 1000).toLocaleDateString(uiLocale(), { month: "short", day: "numeric" }) : "—");
  // ArtaCredits held: the crd_ earmarks, which are a SUBSET of the fund total beside them. Matched on
  // the bucket prefix (Funds::finances emits kind 'crd'), because the FundEarmark type in wp.ts still
  // narrows `kind` to grp|cty|typ and the prefix is the same fact without the cast.
  const creditsHeld = fin.earmarks.filter((e) => e.bucket.startsWith("crd_")).reduce((s, e) => s + e.dollars, 0);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-[20px] font-bold tracking-tight">The foundation’s books</h2>
        <span className="text-[13px] text-ink-3">Public · real, current values · every gift and every spend accounted for</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">In the fund</p><p className="mt-1 text-[22px] font-extrabold tabular-nums text-yang">{formatFiat(fin.donations_fiat, fin.fiat)}</p><p className="text-[12px] text-ink-3">donated money still on hand, every bucket</p></Card>
        <Card className="p-4"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">ArtaCredits held</p><p className="mt-1 text-[22px] font-extrabold tabular-nums text-yin-light">{formatFiat(creditsHeld, fin.fiat)}</p><p className="text-[12px] text-ink-3">of the above, waiting for the slices donors chose</p></Card>
        <Card className="p-4"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Coins in circulation</p><p className="mt-1 text-[22px] font-extrabold tabular-nums text-ink"><Coins n={fin.coin_supply} /></p><p className="text-[12px] text-ink-3">{(fin.reserve_mg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} g of gold held</p></Card>
        {/* `|| 1` here printed "100% gold-backed" for a ratio of 0 — directly beside the "0.0 g of
            gold held" card above it. Coerce, then default to 0: a missing figure must never render
            as a perfect one. See Reserve.tsx for the same fix on the proof-of-reserve page. */}
        <Card className="p-4"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Backing</p><p className="mt-1 text-[22px] font-extrabold tabular-nums text-yang">{Math.round((Number(fin.backing_ratio) || 0) * 100)}%</p><p className="text-[12px] text-ink-3">of the coin is gold-backed</p></Card>
      </div>
      <Card className="overflow-hidden p-0">
        <p className="border-b border-line px-5 py-2.5 text-[13px] font-semibold text-ink-2">Recent fund movements</p>
        {fin.ledger.length === 0 ? (
          <p className="px-5 py-8 text-center text-[14px] text-ink-3">No movements yet — the books open at zero. Every gift received and every credit spent will appear here.</p>
        ) : (
          <ul className="divide-y divide-line">
            {fin.ledger.map((r) => {
              // These are aq_fund_ledger rows: FIAT, and negative when money left the fund (a credit
              // redeemed, a bursary paid, a gift released to another slice). Direction is read from
              // the amount's own sign — the mapper in wp.ts stamps every row "in" — and the value is
              // rendered as money, not as coins: nothing on this ledger is denominated in ₳.
              const out = r.coins < 0;
              return (
                <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-2.5">
                  <div className="min-w-0">
                    <span className="block truncate text-[14px] text-ink">{r.reason || r.scope}</span>
                    <span className="text-[12px] text-ink-3">{fmt(r.date)} · {r.scope}</span>
                  </div>
                  <span className={`shrink-0 text-[14px] font-semibold tabular-nums ${out ? "text-yin-light" : "text-yang-dark"}`}>{out ? "−" : "+"}{formatFiat(Math.abs(r.coins), fin.fiat)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {fin.earmarks.length > 0 && (() => {
        const maxE = Math.max(...fin.earmarks.map((e) => e.dollars), 1);
        return (
          <Card className="overflow-hidden p-0">
            <p className="border-b border-line px-5 py-2.5 text-[13px] font-semibold text-ink-2">What each directed gift still holds</p>
            <ul className="divide-y divide-line">
              {fin.earmarks.map((e) => (
                <li key={e.bucket} className="px-5 py-2.5">
                  {/* An earmark's figure is its COUNTER — the balance left in it, not the total ever
                      given to it. `crd_` is an ArtaCredits slice; `typ_` is a sponsored topic, which
                      the chip used to call "type". */}
                  <div className="flex items-center justify-between gap-4">
                    <span className="min-w-0 truncate text-[14px] text-ink">{e.label} <span className="text-[12px] text-ink-3">· {e.bucket.startsWith("crd_") ? "credits" : e.kind === "cty" ? "country" : e.kind === "grp" ? "group" : "topic"}</span></span>
                    <span className="shrink-0 text-[14px] font-semibold tabular-nums text-yang">{formatFiat(e.dollars, fin.fiat)}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-pill bg-veil/5"><div className="h-full rounded-pill bg-yang" style={{ width: `${Math.max(4, Math.round((e.dollars / maxE) * 100))}%` }} /></div>
                </li>
              ))}
            </ul>
          </Card>
        );
      })()}
    </section>
  );
}

/** One numbered step. The whole page is three of these, so the flow reads as finite. */
function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-yang/50 text-[12px] font-bold text-yang">{n}</span>
        <div className="min-w-0">
          <h2 className="text-[19px] font-bold tracking-tight">{title}</h2>
          {hint && <p className="mt-1 text-[13.5px] leading-relaxed text-ink-3">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

/** A labelled <select> in the house field style. */
function Picker({ id, label, value, onChange, children }: {
  id: string; label: string; value: string; onChange: (v: string) => void; children: React.ReactNode;
}) {
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
      {label}
      <select id={id} value={value} onChange={(e) => onChange(e.currentTarget.value)}
        className="h-11 w-full rounded-field border border-line bg-space-1 px-3 text-[15px] font-normal text-ink outline-none focus:border-yin-light">
        {children}
      </select>
    </label>
  );
}

export default function Donate() {
  const [opts, setOpts] = useState<DonateOptions | null>(null);
  const [copts, setCopts] = useState<CreditOptions | null>(null);
  const [fin, setFin] = useState<FoundationFinances | null>(null);
  const [finFailed, setFinFailed] = useState(false);
  const [gifts, setGifts] = useState<CreditGift[]>([]);

  // step 1 — who
  const [gender, setGender] = useState("");
  const [band, setBand] = useState("");
  const [reach, setReach] = useState<CreditReach | null>(null);
  // step 2 — how much
  const [preset, setPreset] = useState(30);
  const [custom, setCustom] = useState("");
  // step 3 — the name on the certificate
  const me = currentUser();
  const [donorName, setDonorName] = useState("");
  const [anon, setAnon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [widening, setWidening] = useState(0);
  const [err, setErr] = useState("");
  const [thanks, setThanks] = useState("");

  const logged = isLoggedIn();

  /**
   * THE INTENT SURVIVES THE SIGN-IN.
   *
   * /donate is public, linked from the nav, from /reserve and from the FAQ, so most first-time
   * visitors arrive signed out — and the wall below used to replace the whole flow with a bare
   * "Sign in to give" whose link carried no redirect_to. Login.tsx has honoured a return-to since it
   * was written; /donate simply never passed one. So a donor who had chosen a slice, an amount and a
   * name was authenticated and then dropped on the feed, with every one of those choices discarded
   * and no way back but to find the page again and start over.
   *
   * Both halves are fixed here: the link carries where to come back to, and the choices are parked
   * in sessionStorage first (this tab only, cleared on read — it is a handoff, not a record).
   */
  const STASH = "aq.donate.intent";
  function stashIntent() {
    try {
      sessionStorage.setItem(STASH, JSON.stringify({ gender, band, preset, custom, donorName, anon }));
    } catch { /* private mode / quota — the sign-in still works, it just forgets */ }
  }
  useEffect(() => {
    if (!logged) return;
    let raw: string | null;
    try { raw = sessionStorage.getItem(STASH); sessionStorage.removeItem(STASH); } catch { return; }
    if (!raw) return;
    try {
      const v = JSON.parse(raw) as Partial<{ gender: string; band: string; preset: number; custom: string; donorName: string; anon: boolean }>;
      if (typeof v.gender === "string") setGender(v.gender);
      if (typeof v.band === "string") setBand(v.band);
      if (typeof v.preset === "number") setPreset(v.preset);
      if (typeof v.custom === "string") setCustom(v.custom);
      // The name is restored only if they typed one — otherwise the account's own name, set below,
      // is the better answer and must not be overwritten with a stale blank.
      if (typeof v.donorName === "string" && v.donorName.trim()) setDonorName(v.donorName);
      if (typeof v.anon === "boolean") setAnon(v.anon);
    } catch { /* corrupt stash — start clean rather than half-restored */ }
  }, [logged]);

  const loginHref = `${w.AQ_LOGIN_URL || "/login/"}?redirect_to=${encodeURIComponent(
    typeof window === "undefined" ? "/donate/" : window.location.pathname + window.location.search
  )}`;

  // The foundation's books are PUBLIC — fetched regardless of login state.
  useEffect(() => { getFoundationFinances().then((d) => (d ? setFin(d) : setFinFailed(true))); }, []);
  useEffect(() => { creditOptions().then(setCopts).catch(() => setCopts(null)); }, []);
  // Presets and the coin price come from the PUBLIC /reserve (getDonateOptions calls nothing else),
  // and credits/options is public too — so a signed-out visitor can be shown the real amounts and the
  // real reach instead of a wall. Only the donor's own gift history needs an account.
  useEffect(() => { getDonateOptions().then(setOpts); }, []);
  useEffect(() => {
    if (!logged) return;
    myCredits().then((r) => setGifts(r.items)).catch(() => {});
    // A FALLBACK, NOT AN ASSIGNMENT. This effect and the rehydrate above share the [logged]
    // dependency and both run in the same flush; React applies the setState calls in call order, so
    // an unconditional write here landed LAST and discarded the name restored from the stash — the
    // one choice the sign-in round trip most needed to keep, and already deleted from sessionStorage
    // by then. It can also be actively wrong: AQ_USER.name is display_name || user_login, so it may
    // be a handle, and when AQ_USER is absent it is empty — which would blank a name the donor typed
    // and print "A friend of ArtaQuest" on the certificate instead.
    // full_name FIRST. `name` is display_name ?: user_login, and user_login here is the local part
    // of the member's email — so seeding the certificate plate from it would print a piece of the
    // donor's address on a document meant to be printed and shared.
    setDonorName((prev) => (prev.trim() ? prev : (me?.full_name || me?.name || "").trim()));
  }, [logged]); // eslint-disable-line react-hooks/exhaustive-deps

  // Returning from Stripe: confirm the payment and thank the donor HERE, where they gave.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const st = sp.get("stripe");
    if (!st) return;
    if (st === "success") {
      const session = sp.get("session") || "";
      if (session) getStripeVerify(session).then((v) => {
        setThanks(v?.paid
          ? "Thank you — your gift is recorded in the books below, and its credits are waiting for the members you chose."
          : "We couldn’t confirm the payment yet. If you were charged it will appear in the books shortly.");
        myCredits().then((r) => setGifts(r.items)).catch(() => {});
      });
    } else if (st === "cancel") {
      setThanks("Nothing was charged.");
    }
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  // Reach for the CURRENT pick only — one slice at a time, never a published map.
  useEffect(() => {
    let live = true;
    creditReach("", gender, band).then((r) => { if (live) setReach(r); }, () => { if (live) setReach(null); });
    return () => { live = false; };
  }, [gender, band]);

  const cur = opts?.currency || "CAD";
  const sym = opts?.symbol || "$";
  const amount = custom ? Math.max(0, parseFloat(custom) || 0) : preset;
  // SELL — what a redeemed credit actually costs the fund (Credits::cents_for) and what the server
  // freezes onto the gift. The page used to quote `buy`, so the donor's figure was computed on the
  // other side of the spread from the one they were charged at.
  const coinRate = opts?.coin_sell_price || opts?.coin_buy_price || 0;
  const feeCap = copts?.fee_cap || 5;
  // THE NUMBER THE SERVER WILL GRANT — the only number this page may quote. It mirrors, exactly, the
  // ArtaCredits branch of Extra::course_checkout (~line 3153), which FREEZES the promise onto the
  // gift at checkout and never re-derives it afterwards:
  //     unit = max(1, round(coin sell price × 100))          // one coin, in cents
  //     cap  = the fee cap, clamped server-side to Credits::FEE_CAP
  //     n    = max(1, intdiv(round(amount × 100), unit × cap))
  // Both halves matter. Dividing by the price of one COIN rather than by the capped price of one
  // ENTRY counts coins and calls them entries — up to feeCap times what the gift can ever buy (a $30
  // gift was quoted 173 while the server granted 35) — and doing the sum in dollars instead of whole
  // cents drifts a further entry off the frozen figure. A gift's entries are a GUARANTEE priced at
  // the cap, so this is one number and never a range: the server grants exactly this many.
  const unitCents = Math.max(1, Math.round(coinRate * 100));
  const entries = coinRate > 0 && amount >= 1
    ? Math.max(1, Math.floor(Math.round(amount * 100) / (unitCents * Math.max(1, feeCap))))
    : 0;

  const sliceWords = reach?.words || "any member of ArtaQuest";
  const printedName = anon ? "" : donorName.trim();
  const specimen = useMemo(() => sampleCert(printedName, sliceWords), [printedName, sliceWords]);

  const books = fin ? <FoundationBooks fin={fin} /> : finFailed ? (
    <StatusNote error>Couldn’t load the foundation’s books right now. Please refresh to try again.</StatusNote>
  ) : null;

  function give() {
    if (busy || amount < 1) return;
    // Park the choices before leaving for Stripe. It costs nothing and it covers every way this can
    // fail — an expired nonce, a network drop, a Stripe error, or simply the donor deciding to come
    // back later — so "reload and your choices are kept" is a promise the page can actually keep.
    stashIntent();
    setBusy(true); setErr("");
    postCourseCheckout({
      // No `country`: Credits::bucket pins that axis to ANY, so sending one only ever misled.
      donations: [{ amount, credit: { gender, band, fee_cap: copts?.fee_cap, name: anon ? "" : donorName.trim() } }],
      // No email: the donations branch of Extra::course_checkout never reads it, and currentUser()
      // does not carry one — referencing it was a type error the root `tsc --noEmit` could not see
      // (this project is solution-style, so only `tsc -b` actually checks the sources).
      email: "", name: me?.name || "", gateway: "card",
    })
      .then((r) => { if (r.url) window.location.assign(r.url); else setErr("Payment couldn’t be started. Please try again shortly."); })
      .catch((e) => setErr(e instanceof Error ? e.message : "Payment couldn’t be started."))
      .finally(() => setBusy(false));
  }

  const heroLede = (
    <>Every member can read, publish and be cited for free. The one thing that costs money is <strong className="text-ink">entering a challenge</strong> — and that is what your gift pays for. Choose who it reaches, and your name goes on their Certificate of Participation.</>
  );

  /* THERE IS NO LONGER A WALL IN FRONT OF THE FLOW.
     A signed-out visitor used to get a "Sign in to give" card INSTEAD of the page — so the one thing
     they came to do was invisible until they had an account, and everything they might have chosen
     was lost on the way there. An account is genuinely required (the gift is traced to the entry it
     paid for, and the certificate needs a name), but that is a fact about the LAST step, not a reason
     to hide the first three. They now choose slice, amount and name exactly as a member does; the
     final button signs them in, carrying both the return address and the choices. */
  return (
    <div className="flex flex-col gap-10 pb-12">
      <PageHero eyebrow="Donations" glyph={<DomainGlyph domain="cause" />} title="Pay someone’s way into a challenge" lede={heroLede} />

      {thanks && (
        <p role="status" className="rounded-card border border-yang/40 bg-yang/10 px-5 py-3 text-[14.5px] leading-relaxed text-ink">{thanks}</p>
      )}

      {/* The form is a single centred column and the certificate runs FULL WIDTH beneath it. It was
          briefly a sticky right-hand rail, which squeezed a landscape document into ~440px: the
          record wrapped mid-phrase, the two footer plates collided, and the tall empty rail left the
          Arta mascot standing over the certificate with no border under its feet. */}
      <div className="flex flex-col gap-10">
        {/* ── the three decisions ── */}
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-9">
          <Step n={1} title="Who your gift reaches"
            hint="Leave any answer as “Anyone”. Members are matched only on what they have chosen to say about themselves — nothing is ever inferred.">
            {/* NATIONALITY IS NOT OFFERED. It stopped being a matching facet on 2026-08-11 —
                Credits::buckets_for_user pins the country axis to ANY, so no member can be matched by
                one. The picker outlived that change: a donor who chose Iran had their gift minted into
                crd_ir_w_25 while only crd_x_w_25 can ever be matched, and the reach meter answered for
                the country-agnostic slice, so they were shown a real audience for a bucket their money
                would never enter. Offering a choice that cannot be honoured is worse than offering
                none. */}
            <Card className="grid gap-4 p-5 sm:grid-cols-2">
              <Picker id="cr-gender" label="Gender" value={gender} onChange={setGender}>
                <option value="">Anyone</option>
                {(copts?.genders || []).map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </Picker>
              <Picker id="cr-band" label="Age group" value={band} onChange={setBand}>
                <option value="">Any age</option>
                {(copts?.bands || []).map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
              </Picker>
            </Card>
            {/* Honest about reach, including zero — a donor is entitled to know their gift would wait. */}
            {/* The zero-reach case is the one line on this page that changes what a donor should do,
                so it is full-strength ink rather than the muted hint tone the rest of the step uses —
                at the default contrast level ink-3 lands around 3.3:1, under the 4.5:1 floor. */}
            <p role="status" aria-live="polite" className={cx("text-[13.5px] leading-relaxed", reach && reach.members === 0 ? "font-medium text-ink" : "text-ink-2")}>
              {!reach ? "Counting who this reaches…" : reach.members === 0 ? (
                <>No member matches this yet. Your gift would be held in the open books, under your chosen slice, until someone does — it is never spent on anyone else.</>
              ) : (
                <>Reaches <strong className="text-ink">{reach.exact ? reach.members : `fewer than ${reach.floor}`}</strong> {reach.members === 1 ? "member" : "members"} — <span className="text-ink-2">{reach.words}</span>. We never publish a count below {reach.floor}, so a narrow choice can’t identify anyone.</>
              )}
            </p>
          </Step>

          <Step n={2} title="How much" hint={`An entry fee is set by whoever founded the challenge — ₳1 by default — and a credit covers one entry of up to ₳${feeCap}. One coin is ${sym}${coinRate ? coinRate.toFixed(2) : "—"} at today’s gold rate, and your gift is fixed at that rate the moment you give.`}>
            <Card className="p-5">
              <div className="flex flex-wrap gap-2">
                {(opts?.presets || [5, 15, 30, 60, 120]).map((p) => (
                  <Chip key={p} active={!custom && preset === p} onClick={() => { setPreset(p); setCustom(""); }}
                    className="h-10 min-w-[64px] justify-center px-4 text-[15px] font-semibold">{sym}{p}</Chip>
                ))}
                <div className="flex h-10 items-center rounded-pill border border-line px-3 text-ink-2 focus-within:border-yin-light">
                  <span className="text-[15px]">{sym}</span>
                  <input value={custom} onChange={(e) => setCustom(sanitizeDecimal(e.target.value))} inputMode="decimal" placeholder="Other" aria-label={`Custom amount (${cur})`} className="h-full w-20 bg-transparent px-1 text-[15px] text-ink outline-none" />
                </div>
              </div>
              {entries > 0 && (
                <>
                  <p className="mt-4 text-[14px] text-ink-2">
                    <span className="font-semibold text-ink">{sym}{amount}</span> covers{" "}
                    <span className="font-extrabold text-yang">{entries}</span>{" "}
                    {entries === 1 ? "entry" : "entries"}, counted at the ₳{feeCap} a credit covers at most, so the gift is never short
                    {copts ? <> · at most {copts.moon_cap} per member per moon</> : null}
                  </p>
                  {/* Said plainly because the count is frozen at the cap when you give: a run of ₳1
                      entries does not stretch it further, and the difference stays in the fund. */}
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">
                    That count is fixed the moment you give. Cheaper entries don’t stretch it further — whatever they cost, the rest of your gift stays in the fund under the slice you chose, and is never spent on anyone else.
                  </p>
                </>
              )}
              <p className="sr-only" role="status" aria-live="polite">
                {entries > 0 ? `${sym}${amount} covers ${entries} challenge ${entries === 1 ? "entry" : "entries"}, counted at the ₳${feeCap} a credit covers at most.` : ""}
              </p>
            </Card>
          </Step>

          {/* What actually runs on this field is Credits::clean_donor_name — a character-class strip,
              not moderation. This hint used to say "ArtaMod checks it"; ArtaMod scores discussion
              comments, and the one Fearometer call in that function only fires if a verdict already
              exists (it is produced asynchronously, so at checkout it is null). Describe the strip. */}
          <Step n={3} title="The name on their certificate" hint="This prints on the Certificate of Participation of every member your gift helps, so we keep it to the shape of a name: letters in any script, spaces, and the apostrophes, hyphens and initials names contain. Anything else — links, handles, slogans — is removed, and a field left with no letters in it simply prints as anonymous.">
            <Card className="flex flex-col gap-3 p-5">
              <input value={donorName} onChange={(e) => setDonorName(e.target.value.slice(0, 80))} disabled={anon}
                placeholder="Your name, as it should appear" aria-label="Your name as it should appear on the certificate"
                className="h-11 w-full rounded-field border border-line bg-space-1 px-3 text-[15px] text-ink outline-none focus:border-yin-light disabled:opacity-50" />
              <label className="flex items-center gap-2.5 text-[14px] text-ink-2">
                <input type="checkbox" checked={anon} onChange={(e) => setAnon(e.currentTarget.checked)} className="h-4 w-4 accent-yang" />
                Give without my name — the certificate will read “A friend of ArtaQuest”
              </label>
              {/* The books below aggregate a slice's earmark across every donor to it — the row that
                  names YOUR account is the gift row in the open database, so say that, not "beside
                  your account in the books". */}
              <p className="text-[12.5px] leading-relaxed text-ink-3">
                The gift itself is public either way: its amount, the slice you chose and your account are one row anyone can read in the open database, and the money shows up in the slice’s total in the books below. Anonymity is about the printed certificate, not the ledger.
              </p>
            </Card>
          </Step>

        </div>

        {/* ── the certificate, live: the donor sees their own name on the real document before
              they give, which is the whole reason the name field sits directly above it ── */}
        <section className="flex flex-col gap-3">
          <div className="mx-auto w-full max-w-2xl">
            <h2 className="text-[19px] font-bold tracking-tight">What they receive</h2>
            <p className="mt-1 text-[13.5px] leading-relaxed text-ink-3">
              Every entrant holds this certificate whether or not anyone paid their way — your plate is added to a document they had already earned, never the reason it exists.
            </p>
          </div>
          <ParticipationDoc cert={specimen} sample />
        </section>

        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2.5">
          {err && <StatusNote error className="py-2 text-start">{err}</StatusNote>}
          {logged ? (
            <Button onClick={give} disabled={busy || amount < 1} className="h-12 w-full text-[16px] disabled:opacity-50">
              {busy ? "Starting…" : `Give ${sym}${amount || 0}`}
            </Button>
          ) : (
            <Button onClick={() => { stashIntent(); window.location.assign(loginHref); }} disabled={amount < 1}
              className="h-12 w-full text-[16px] disabled:opacity-50">
              {`Sign in to give ${sym}${amount || 0}`}
            </Button>
          )}
          <p className="text-center text-[12px] text-ink-3">
            {logged
              ? "You’ll choose how to pay on the next screen. Nothing is charged until you do."
              : "Your choices are kept — you’ll come straight back here, then choose how to pay. Nothing is charged until you do."}
          </p>
          {!logged && (
            <p className="text-center text-[12px] leading-relaxed text-ink-3">
              An account is needed because the gift is traced from your payment to the exact entry it paid for, and because the certificate needs a name to print.
            </p>
          )}
        </div>
      </div>

      {/* ── what a credit is, and is not ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[20px] font-bold tracking-tight">What an ArtaCredit is</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="p-5 text-[14px] leading-relaxed text-ink-2">
            <p className="font-semibold text-ink">It buys one entry</p>
            <p className="mt-1.5">A credit pays a member’s challenge entry fee and nothing else. It is not a prize, not a vote, not standing, and it can’t be cashed out — the money goes straight into the challenge’s pool, which the community’s hearts award at the full moon.</p>
          </Card>
          <Card className="p-5 text-[14px] leading-relaxed text-ink-2">
            <p className="font-semibold text-ink">Nobody is sponsored without saying yes</p>
            <p className="mt-1.5">When a member is short the fee and your gift matches them, we show them your name and who the gift was for, and they choose. Refusing costs them nothing, and we never record anywhere that a member would like to be helped.</p>
          </Card>
          <Card className="p-5 text-[14px] leading-relaxed text-ink-2">
            <p className="font-semibold text-ink">It can’t be farmed</p>
            <p className="mt-1.5">A credit never pays the fee of the member who founded the challenge, and it only ever joins a challenge that already holds other members’ entries — so a gift can’t seed a field for a friend to walk away with. It is never offered to an automated token, and an answer about yourself has to have stood for a month before it can attract a gift.</p>
          </Card>
          <Card className="p-5 text-[14px] leading-relaxed text-ink-2">
            <p className="font-semibold text-ink">It is all in the open</p>
            <p className="mt-1.5">Your gift, the slice you chose and every entry it paid for are rows anyone can read in the <a href={localePath("/data/")} className="text-yang hover:underline">Data explorer</a>. Accepting a credit records that publicly, and the member is told so before they accept.</p>
          </Card>
        </div>
      </section>

      {gifts.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[20px] font-bold tracking-tight">Your gifts</h2>
          <Card className="overflow-hidden p-0">
            <ul className="divide-y divide-line">
              {gifts.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[14.5px] text-ink">For {g.words}</p>
                    <p className="text-[12.5px] text-ink-2">
                      {new Date(g.date * 1000).toLocaleDateString(uiLocale(), { year: "numeric", month: "short", day: "numeric" })}
                      {g.name ? <> · printed as <span data-ay-skip="1">{g.name}</span></> : <> · anonymous</>}
                      {g.widened ? <> · released to any member</> : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <p className="text-[14px] font-semibold tabular-nums text-yang">
                      {g.used} of {g.entries} {g.entries === 1 ? "entry" : "entries"} used
                    </p>
                    {/* A gift aimed at a slice nobody matches would otherwise sit in the books for
                        ever. This is the only way its money can move — and only its own donor, and
                        only outward to "any member", never at some other group of people. */}
                    {g.can_widen && g.used === 0 && (
                      <Button variant="outline" className="h-8 px-3 text-[12.5px]" disabled={widening === g.id}
                        onClick={() => {
                          setWidening(g.id);
                          widenCredit(g.id)
                            .then((r) => { setThanks(r.message); return myCredits().then((x) => setGifts(x.items)); })
                            .catch((e) => setErr(e instanceof Error ? e.message : "Couldn’t release that gift."))
                            .finally(() => setWidening(0));
                        }}>
                        {widening === g.id ? "Releasing…" : "Open to any member"}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {books}
    </div>
  );
}
