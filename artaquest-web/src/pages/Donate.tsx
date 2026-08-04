import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getDonateOptions, getFoundationFinances, getTypologyTargets, getSponsorableTopics, isLoggedIn, localePath, CHECKOUT_LIVE, type DonateOptions, type FoundationFinances, type TypologyTargets, type TypologyTargetSystem, type SponsorableTopic } from "../lib/wp";
import { addDonation, cartCount, onCartChange } from "../lib/cart";
import { Coins, formatFiat, sanitizeDecimal } from "../lib/currency";
import { Button, Card, Chip, PageHero, StatusNote } from "../components/ui";
import { DomainGlyph } from "../components/catalogue";

const w = (typeof window !== "undefined" ? (window as unknown as Record<string, string>) : {}) || {};

/** The foundation's entire public financial picture — donations in (fiat), the gold-backed
 *  coin fund, and the recent coin ledger. 100% real data, public to everyone. */
function FoundationBooks({ fin }: { fin: FoundationFinances }) {
  const fmt = (s: number) => (s ? new Date(s * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—");
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-[20px] font-bold tracking-tight">The foundation’s books</h2>
        <span className="text-[13px] text-ink-3">Public · real, current values · every coin accounted for</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Donations received</p><p className="mt-1 text-[22px] font-extrabold tabular-nums text-yang">{formatFiat(fin.donations_fiat, fin.fiat)}</p><p className="text-[12px] text-ink-3">{fin.donations_count} gift{fin.donations_count === 1 ? "" : "s"}</p></Card>
        <Card className="p-4"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Fund on hand</p><p className="mt-1 text-[22px] font-extrabold tabular-nums text-yin-light"><Coins n={fin.fund_balance} /></p><p className="text-[12px] text-ink-3"><Coins n={fin.fund_issued} /> issued to learners</p></Card>
        <Card className="p-4"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Coins in circulation</p><p className="mt-1 text-[22px] font-extrabold tabular-nums text-ink"><Coins n={fin.coin_supply} /></p><p className="text-[12px] text-ink-3">{(fin.reserve_mg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} g of gold held</p></Card>
        <Card className="p-4"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Backing</p><p className="mt-1 text-[22px] font-extrabold tabular-nums text-yang">{Math.round((fin.backing_ratio || 1) * 100)}%</p><p className="text-[12px] text-ink-3">gold-backed</p></Card>
      </div>
      <Card className="overflow-hidden p-0">
        <p className="border-b border-line px-5 py-2.5 text-[13px] font-semibold text-ink-2">Recent coin movements</p>
        {fin.ledger.length === 0 ? (
          <p className="px-5 py-8 text-center text-[14px] text-ink-3">No movements yet — the books open at zero. Every coin issued and redeemed will appear here.</p>
        ) : (
          <ul className="divide-y divide-line">
            {fin.ledger.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-2.5">
                <div className="min-w-0">
                  <span className="block truncate text-[14px] text-ink">{r.reason || r.scope}</span>
                  <span className="text-[12px] text-ink-3">{fmt(r.date)} · {r.scope}</span>
                </div>
                <span className={`shrink-0 text-[14px] font-semibold tabular-nums ${r.direction === "out" ? "text-yin-light" : "text-yang-dark"}`}>{r.direction === "out" ? "−" : "+"}<Coins n={r.coins} /></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {fin.earmarks.length > 0 && (() => {
        const maxE = Math.max(...fin.earmarks.map((e) => e.dollars), 1);
        return (
          <Card className="overflow-hidden p-0">
            <p className="border-b border-line px-5 py-2.5 text-[13px] font-semibold text-ink-2">Where directed gifts went</p>
            <ul className="divide-y divide-line">
              {fin.earmarks.map((e) => (
                <li key={e.bucket} className="px-5 py-2.5">
                  <div className="flex items-center justify-between gap-4">
                    <span className="min-w-0 truncate text-[14px] text-ink">{e.label} <span className="text-[12px] text-ink-3">· {e.kind === "cty" ? "country" : e.kind === "grp" ? "group" : "type"}</span></span>
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

// General-purpose target picker: pick a typology SYSTEM (one of the frameworks members self-identify
// with on the Topics page), then one or more of its TYPES. Only types that real members have chosen
// appear — top 10 per system. Selecting nothing = the general learner fund.
function TargetPicker({ targets, activeSystem, setActiveSystem, selKeys, setSelKeys }: {
  targets: TypologyTargets | null;
  activeSystem: string;
  setActiveSystem: (k: string) => void;
  selKeys: Set<string>;
  setSelKeys: (s: Set<string>) => void;
}) {
  if (!targets) return <Card className="px-6 py-2"><StatusNote className="py-6">Loading communities…</StatusNote></Card>;
  const sys: TypologyTargetSystem | undefined = targets.systems.find((s) => s.key === activeSystem);

  if (targets.systems.length === 0) {
    return (
      <Card className="px-6 py-7 text-[14px] leading-relaxed text-ink-2">
        <p className="font-semibold text-ink">Your gift goes to the general member fund.</p>
        <p className="mt-1.5 text-ink-3">As members self-identify on the <a href={localePath("/topics/")} className="text-yang hover:underline">Topics page</a>, the communities they belong to — by gender, heritage, nationality, faith, neurodivergence, and more — will appear here so you can direct your gift to any of them.</p>
      </Card>
    );
  }

  const pickType = (key: string) => {
    const n = new Set(selKeys);
    if (n.has(key)) n.delete(key); else n.add(key);
    setSelKeys(n);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Framework chooser — a compact select (mirrors the topic-sponsor picker below) rather than a
          wall of chips; the readable system names (#151) make each option self-explanatory. */}
      <Card className="p-5">
        <label htmlFor="community-framework" className="text-[13px] font-semibold text-ink-2">Pick a framework — then choose the communities within it to support.</label>
        <select id="community-framework" value={activeSystem}
          onChange={(e) => { setActiveSystem(e.target.value); setSelKeys(new Set()); }}
          className="mt-2 h-11 w-full rounded-field border border-line bg-space-1 px-3 text-[15px] text-ink outline-none focus:border-yin-light">
          <option value="">General fund — wherever the need is greatest</option>
          {targets.systems.map((s) => (
            <option key={s.key} value={s.key}>{s.name}</option>
          ))}
        </select>
        {!sys && <p className="mt-3 text-[13px] leading-relaxed text-ink-3">Your gift goes to the <span className="font-semibold text-ink">general member fund</span> — directed wherever the need is greatest. Pick a framework to support a specific community.</p>}
      </Card>

      {sys && (
        <Card className="p-0">
          <p className="border-b border-line px-4 py-2.5 text-[13px] text-ink-2">Choose who in <span className="font-semibold text-ink">{sys.name}</span> to support — the {sys.types.length} most-represented, by members who self-identify.</p>
          <ul className="divide-y divide-line">
            {sys.types.map((t) => {
              const on = selKeys.has(t.key);
              return (
                <li key={t.key}>
                  <button type="button" role="checkbox" aria-checked={on} onClick={() => pickType(t.key)}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${on ? "bg-yang/[0.06]" : "hover:bg-veil/[0.02]"}`}>
                    <span aria-hidden className={`grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border ${on ? "border-yang bg-yang" : "border-ink-3"}`}>
                      {on && <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="var(--color-on-accent)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 10 17 19 6" /></svg>}
                    </span>
                    <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink">{t.label}</span>
                    <span className="shrink-0 text-[12px] text-ink-3">{t.count} member{t.count === 1 ? "" : "s"}{t.raised > 0 ? <> · <span className="text-yang-dark"><Coins n={t.raised} /></span> raised</> : null}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

// Sponsor a TOPIC's prize pool — pick one of the topics that has a live course (the only ones whose pool
// can receive a gift). The donation flows into that course's revenue and is distributed 80% to the top
// questers + the creator's tier share at each season (Funds::sponsor_topic).
function SponsorTopicPicker({ topics, sel, setSel }: { topics: SponsorableTopic[]; sel: string; setSel: (k: string) => void }) {
  if (topics.length === 0) {
    return (
      <Card className="px-6 py-7 text-[14px] leading-relaxed text-ink-2">
        <p className="font-semibold text-ink">No topics are sponsorable yet.</p>
        <p className="mt-1.5 text-ink-3">A topic becomes sponsorable once it has a live course. Explore them on the <a href={localePath("/topics/")} className="text-yang hover:underline">Topics page</a>.</p>
      </Card>
    );
  }
  const cur = topics.find((t) => t.key === sel);
  return (
    <Card className="p-5">
      <label htmlFor="sponsor-topic" className="text-[13px] font-semibold text-ink-2">Pick a topic to sponsor — your gift becomes gold-backed coins earmarked to that topic.</label>
      <select id="sponsor-topic" value={sel} onChange={(e) => setSel(e.target.value)}
        className="mt-2 h-11 w-full rounded-field border border-line bg-space-1 px-3 text-[15px] text-ink outline-none focus:border-yin-light">
        <option value="">Choose a topic…</option>
        {topics.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
      </select>
      {cur && <p className="mt-3 text-[13px] leading-relaxed text-ink-3">Sponsoring <span className="font-semibold text-ink">{cur.name}</span> — your gift becomes gold-backed coins earmarked to this topic, held in the public ledgers until the members working in it are funded.</p>}
    </Card>
  );
}

export default function Donate() {
  const [opts, setOpts] = useState<DonateOptions | null>(null);
  const [targets, setTargets] = useState<TypologyTargets | null>(null);
  const [activeSystem, setActiveSystem] = useState("");
  const [selKeys, setSelKeys] = useState<Set<string>>(new Set());
  const [giftMode, setGiftMode] = useState<"community" | "topic">("community");
  const [sponsorTopics, setSponsorTopics] = useState<SponsorableTopic[]>([]);
  const [sponsorKey, setSponsorKey] = useState("");
  const [preset, setPreset] = useState(30);
  const [custom, setCustom] = useState("");
  const [added, setAdded] = useState(false);
  const [count, setCount] = useState(0);
  const [fin, setFin] = useState<FoundationFinances | null>(null);
  const [finFailed, setFinFailed] = useState(false);

  const logged = isLoggedIn();
  const [sp] = useSearchParams();

  // The foundation's books are PUBLIC — fetched regardless of login state.
  useEffect(() => { getFoundationFinances().then((d) => (d ? setFin(d) : setFinFailed(true))); }, []);

  useEffect(() => {
    if (!logged) return;
    getDonateOptions().then(setOpts);
    getTypologyTargets().then(setTargets);
    getSponsorableTopics().then(setSponsorTopics);
    setCount(cartCount());
    return onCartChange(() => setCount(cartCount()));
  }, [logged]);

  // Preselect a community from a ?cause=<system>:<type> deep link (e.g. Explore's cause cards).
  useEffect(() => {
    const cause = sp.get("cause");
    if (!cause || !targets) return;
    const i = cause.indexOf(":");
    const sysKey = i >= 0 ? cause.slice(0, i) : cause;
    const typeKey = i >= 0 ? cause.slice(i + 1) : "";
    if (targets.systems.some((s) => s.key === sysKey)) {
      setActiveSystem(sysKey);
      if (typeKey) setSelKeys(new Set([typeKey]));
    }
  }, [sp, targets]);

  const books = fin ? <FoundationBooks fin={fin} /> : finFailed ? (
    <StatusNote error>Couldn’t load the foundation’s books right now. Please refresh to try again.</StatusNote>
  ) : null;

  const cur = opts?.currency || "CAD";
  const sym = opts?.symbol || "$";
  const amount = custom ? Math.max(0, parseFloat(custom) || 0) : preset;
  const coinRate = opts?.coin_buy_price || 0;
  const coins = coinRate > 0 ? Math.round(amount / coinRate) : 0;

  const sys = targets?.systems.find((s) => s.key === activeSystem);
  const directed = sys && selKeys.size > 0;
  const directedShorts = sys ? sys.types.filter((t) => selKeys.has(t.key)).map((t) => t.short) : [];
  const directedLabel = directed ? `${sys!.name}: ${directedShorts.join(", ")}` : "the general member fund";
  const sponsorName = sponsorTopics.find((t) => t.key === sponsorKey)?.name || "";
  const isTopic = giftMode === "topic" && sponsorKey !== "";

  function addToCartNow(thenCheckout: boolean) {
    if (amount < 1) return;
    if (isTopic) {
      addDonation(amount, cur, 0, { mode: "global", countries: [], groups: [], topics: [sponsorKey] }, `Sponsor ${sym}${amount} · ${sponsorName}`);
    } else {
      const groups = directed ? [...selKeys] : [];
      addDonation(amount, cur, 0, { mode: "global", countries: [], groups }, `Donation ${sym}${amount} · ${directed ? directedLabel : "learner fund"}`);
    }
    setAdded(true);
    if (thenCheckout) window.location.assign(localePath("/enroll/"));
  }

  if (!logged) {
    const login = w.AQ_LOGIN_URL || "/login/";
    return (
      <div className="flex flex-col gap-12 pb-12">
        <div className="mx-auto max-w-lg py-12 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-yang/15 text-yang">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" /></svg>
          </span>
          <h1 className="mt-4 text-[26px] font-bold tracking-tight">Sign in to donate</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-2">Your donation is converted to gold-backed Arta Coins and held for learners — so you’ll need to be signed in. It only takes a moment.</p>
          <div className="mt-6 flex justify-center gap-3">
            <Button href={login} size="xl">Sign in</Button>
            <Button variant="outline" href="/courses/" size="xl">Browse courses</Button>
          </div>
        </div>
        {books}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 pb-12">
      <PageHero
        eyebrow="Donations" glyph={<DomainGlyph domain="cause" />}
        title="Where your donation goes"
        lede={<>Your donation is minted into gold-backed Arta Coins and held in the member fund, issued when someone needs it. You also earn one donor point for every coin you give — a lifetime score that raises your rank in the <a href={localePath("/rankings/")} className="text-yang hover:underline">rankings</a>. Give to the general fund, or direct it to any community members belong to — chosen from the frameworks on the <a href={localePath("/topics/")} className="text-yang hover:underline">Topics page</a>.</>}
      />

      {/* Step 1 — who your gift supports: a community (bursaries) OR a topic's prize pool (sponsorship) */}
      <section>
        <h2 className="mb-1 text-[20px] font-bold tracking-tight">Choose who your gift supports</h2>
        <div className="mb-3 mt-2 flex flex-wrap gap-2">
          <Chip active={giftMode === "community"} onClick={() => setGiftMode("community")}>A community · bursaries</Chip>
          <Chip active={giftMode === "topic"} onClick={() => setGiftMode("topic")}>A topic · prize pool</Chip>
        </div>
        {giftMode === "community" ? (
          <>
            <p className="mb-3 text-[13.5px] text-ink-3">Only communities members actually identify with are shown — the top groups in each framework.</p>
            <TargetPicker targets={targets} activeSystem={activeSystem} setActiveSystem={setActiveSystem} selKeys={selKeys} setSelKeys={setSelKeys} />
          </>
        ) : (
          <>
            <p className="mb-3 text-[13.5px] text-ink-3">Sponsor a topic — your gift becomes gold-backed coins earmarked to that topic, and every one of them is traceable in the public ledgers.</p>
            <SponsorTopicPicker topics={sponsorTopics} sel={sponsorKey} setSel={setSponsorKey} />
          </>
        )}
      </section>

      {/* amount + add to cart */}
      <section className="mx-auto w-full max-w-lg">
        <Card className="p-6">
          <h2 className="text-[20px] font-bold tracking-tight">Your donation</h2>
          <p className="mt-1 text-[14px] text-ink-2">{isTopic ? <>Sponsoring <span className="font-semibold text-ink">{sponsorName}</span>’s prize pool.</> : <>Directing to <span className="font-semibold text-ink">{directedLabel}</span>.</>}</p>
          <div className="mt-5">
            <label className="text-[13px] font-semibold text-ink-2">Amount ({cur})</label>
            <div className="mt-2 flex flex-wrap gap-2">
              {(opts?.presets || [5, 15, 30, 60, 120]).map((p) => (
                <Chip key={p} active={!custom && preset === p} onClick={() => { setPreset(p); setCustom(""); }}
                  className="h-10 min-w-[64px] justify-center px-4 text-[15px] font-semibold">{sym}{p}</Chip>
              ))}
              <div className="flex h-10 items-center rounded-pill border border-line px-3 text-ink-2 focus-within:border-yin-light">
                <span className="text-[15px]">{sym}</span>
                <input value={custom} onChange={(e) => setCustom(sanitizeDecimal(e.target.value))} inputMode="decimal" placeholder="Other" aria-label={`Custom amount (${cur})`} className="h-full w-20 bg-transparent px-1 text-[15px] text-ink outline-none" />
              </div>
            </div>
          </div>
          {coins > 0 && (
            <p className="mt-3 text-[13px] text-ink-3">Your <span className="font-semibold text-ink">{sym}{amount}</span> mints ≈ <span className="font-semibold text-yang"><Coins n={coins} /></span> for learners — and earns you ≈ {coins.toLocaleString()} donor points.</p>
          )}
          {/* SR-only status: announce the coins/points estimate as the chosen amount changes (WCAG
              4.1.3) — the visible estimate above isn't a live region, so it's silent for SR users. */}
          <p className="sr-only" role="status" aria-live="polite">
            {coins > 0 ? `${sym}${amount} mints about ${coins.toLocaleString()} coins for learners and earns about ${coins.toLocaleString()} donor points.` : ""}
          </p>
          {added && (
            <p role="status" className="mt-4 rounded-card border border-yang/40 bg-yang/10 px-4 py-2.5 text-[14px] text-ink">
              Added to cart ✓ — <a href={localePath("/cart/")} className="font-semibold text-yang hover:underline">view cart ({count})</a>
            </p>
          )}
          {CHECKOUT_LIVE ? (
            <>
              <div className="mt-5 flex flex-col gap-2.5">
                <Button onClick={() => addToCartNow(true)} disabled={amount < 1} className="h-12 w-full text-[16px] disabled:opacity-50">Donate {sym}{amount || 0} now</Button>
                <Button variant="outline" onClick={() => addToCartNow(false)} disabled={amount < 1} className="h-11 w-full text-[14px] text-ink hover:text-yin-light disabled:opacity-50">Add to cart</Button>
              </div>
              <p className="mt-3 text-center text-[12px] text-ink-3">You’ll choose a payment method at checkout. Your gift is converted to gold-backed Arta Coins held for learners.</p>
            </>
          ) : (
            // Payment/checkout is retired (see CHECKOUT_LIVE) — the old buttons dead-ended on the
            // removed /enroll + /cart pages. Show an honest state instead; the public books stay below.
            <p className="mt-5 rounded-field border border-line bg-space-1 px-4 py-3 text-center text-[14px] leading-relaxed text-ink-2">Online donations are being rebuilt on the new platform. The foundation’s books below stay fully public in the meantime — thank you for standing with our learners.</p>
          )}
        </Card>
      </section>

      {books}
    </div>
  );
}
