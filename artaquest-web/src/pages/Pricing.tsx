import { useEffect, useMemo, useState } from "react";
import { localePath, getCoinWorld, type CoinWorld, type CoinWorldCountry } from "../lib/wp";
import { atlasId } from "../lib/iso";
import { Card, OrbitRings, SearchPill, StatusNote } from "../components/ui";
import { CoinDisc } from "../components/CoinDisc";
import { GeoMap } from "../components/WorldMap";

// 1 Arta Coin is a fixed 1 mg of gold — worth the same everywhere. This page expresses that one
// global value in each country's local money. No PPP, no regional pricing: the same price for all.

// One coin's value, formatted in a country's currency (more decimals for sub-unit amounts).
const local = (n: number, cur: string) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: n < 10 ? 4 : 2 }).format(n); }
  catch { return `${n.toFixed(n < 10 ? 4 : 2)} ${cur}`; }
};

function WorldCoinMap({ countries }: { countries: CoinWorldCountry[] }) {
  const byId = useMemo(() => new Map(countries.map((c) => [atlasId({ code: c.code }), c])), [countries]);
  return (
    <>
      <GeoMap<CoinWorldCountry>
        byId={byId}
        ariaLabel="What 1 Arta Coin is worth around the world"
        fillFor={(d) => (d ? "rgba(232,185,35,0.42)" : "rgba(255,255,255,0.05)")}
        countryLabel={(d) => `${d.name}: buy ${local(d.buy, d.currency)}, sell ${local(d.sell, d.currency)}`}
        renderTooltip={(d) => (
          <>
            <p className="font-bold text-ink">{d.name}</p>
            <p className="text-ink-2">Buy 1 coin · <span className="font-semibold text-yang">{local(d.buy, d.currency)}</span></p>
            <p className="text-ink-3">Sell · {local(d.sell, d.currency)}</p>
          </>
        )}
      />
      <p className="mt-2 text-center text-[12px] text-ink-3">Every country pays the same gold value — hover the map, or find your local price in the table below.</p>
    </>
  );
}

export default function Pricing() {
  const [w, setW] = useState<CoinWorld | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => { getCoinWorld().then((d) => { if (d) setW(d); else setFailed(true); }).catch(() => setFailed(true)); }, []);

  if (failed) return <StatusNote error className="py-16">Couldn't load — refresh to try again.</StatusNote>;
  if (!w) return <StatusNote className="py-16">Loading…</StatusNote>;
  const rows = w.countries.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) || c.currency.toLowerCase().includes(q.toLowerCase()));
  const totalSpread = Math.round(w.spread * 2 * 100);
  // The visitor's own country (server-detected) — surfaced as a callout + highlighted in the
  // table so a learner sees their local price without hunting for it.
  const mine = w.you ? w.countries.find((c) => c.code === w.you) : undefined;

  return (
    <div className="flex flex-col gap-12 pb-12">
      <section className="relative overflow-hidden rounded-card border border-line bg-space-2 px-6 py-14 sm:px-12 sm:py-16">
        <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-yang/10 blur-3xl" aria-hidden />
        <OrbitRings className="absolute -right-20 top-1/2 hidden h-[420px] w-[420px] -translate-y-1/2 text-ink lg:block" />
        <CoinDisc size={260} className="absolute right-4 top-1/2 hidden -translate-y-1/2 lg:block" />
        <div className="relative max-w-2xl">
          <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">Pricing</p>
          <h1 className="mt-4 text-[clamp(2rem,5vw,3.1rem)] font-extrabold leading-[1.1]">The same price <span className="aq-grad">everywhere</span></h1>
          <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-ink-2">One Arta Coin is one milligram of real gold, so it is worth exactly the same to a member in Lagos, Manila, or Toronto — no purchasing-power adjustment, no regional mark-up. A challenge’s entry fee is the same number of coins for everyone who enters it; here is what a single coin is worth in money you recognise.</p>
          {/* What coins are actually FOR, since the courses-and-enrolment economy they used to buy was
              purged 2026-07-13. Reading, submitting and publishing cost nothing; the entry fee is the
              only place a member spends coins, and every one of them goes into the pool. */}
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-2">Reading is free, and so is submitting a notebook, running the reproducibility checklist and publishing the work. Coins change hands in one place: a member founds a challenge — a kind, a topic, a full-moon deadline and an entry fee — every entrant pays that fee into the pool, and at the deadline the most-hearted entry takes the whole pool.</p>
          <p className="mt-3 text-[14px] text-ink-3"><bdi dir="ltr" data-ay-skip="1">{w.peg}</bdi></p>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-5"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Buy 1 coin ({w.base_fiat})</p><p className="mt-1.5 text-[24px] font-extrabold text-yang tabular-nums">{local(w.buy_base, w.base_fiat)}</p></Card>
        <Card className="p-5"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Sell 1 coin ({w.base_fiat})</p><p className="mt-1.5 text-[24px] font-extrabold text-yin-light tabular-nums">{local(w.sell_base, w.base_fiat)}</p></Card>
        {/* A missing or zero spot price renders as "$0", which on a money page reads as a real
            quote — gold at nothing. There is no honest way to show a price we do not have, so we
            say we do not have it. Guard the VALUE, not just `undefined`: the field is typed number
            and arrives as 0 whenever the rate could not be resolved. */}
        <Card className="p-5"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Gold spot (USD/oz)</p><p className="mt-1.5 text-[24px] font-extrabold text-ink tabular-nums">{w.gold_oz_usd > 0 ? `$${Math.round(w.gold_oz_usd).toLocaleString()}` : <span className="text-[16px] font-semibold text-ink-3">Unavailable</span>}</p></Card>
        <Card className="p-5"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Spread</p><p className="mt-1.5 text-[24px] font-extrabold text-ink tabular-nums">{totalSpread}%</p><p className="text-[12px] text-ink-3">{Math.round(w.spread * 100)}% each way</p></Card>
      </section>

      <section>
        <h2 className="mb-3 text-[20px] font-bold tracking-tight">1 <bdi dir="ltr" data-ay-skip="1">{w.symbol}</bdi> around the world</h2>
        <Card className="p-5"><WorldCoinMap countries={w.countries} /></Card>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[20px] font-bold tracking-tight">What one coin costs, by country</h2>
          <SearchPill value={q} onChange={setQ} placeholder="Search country or currency…" className="w-56 px-3" />
        </div>
        {mine && !q && (
          <Card className="mb-3 flex items-center justify-between gap-3 border-yang/40 bg-yang/5 p-4">
            <div><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Where you are</p><p className="mt-0.5 text-[16px] font-bold text-ink">{mine.name}</p></div>
            <div className="text-right"><p className="text-[20px] font-extrabold tabular-nums text-yang">{local(mine.buy, mine.currency)}</p><p className="text-[12px] text-ink-3">buy 1 coin · sell {local(mine.sell, mine.currency)}</p></div>
          </Card>
        )}
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-3"><th scope="col" className="px-4 py-3 font-semibold">Country</th><th scope="col" className="px-4 py-3 font-semibold">Currency</th><th scope="col" className="px-4 py-3 text-right font-semibold">Buy 1 coin</th><th scope="col" className="px-4 py-3 text-right font-semibold">Sell 1 coin</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.code} className={`border-b border-line/60 last:border-0 ${c.code === w.you ? "bg-yang/5" : ""}`}>
                  <td className="px-4 py-2.5 text-ink">{c.name}{c.code === w.you && <span className="ml-2 rounded-pill bg-yang/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-yang">You</span>}</td>
                  <td className="px-4 py-2.5 text-ink-3">{c.currency}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-yang">{local(c.buy, c.currency)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink-2">{local(c.sell, c.currency)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-ink-3">No match.</td></tr>}
            </tbody>
          </table>
        </Card>
        <p className="mt-3 text-[13px] text-ink-3">Rates follow the live gold price and refresh continuously. Buy and sell differ by the {totalSpread}% spread that funds custody and operations. <a href={localePath("/reserve/")} className="text-yang hover:underline">See the full reserve →</a></p>
      </section>
    </div>
  );
}
