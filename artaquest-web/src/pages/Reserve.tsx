import { useEffect, useState, type ReactNode } from "react";
import { getReserve, getFoundationFinances, localePath, type Reserve, type FoundationFinances, type ReservePoint } from "../lib/wp";
import { Coins, formatFiat } from "../lib/currency";
import { Button, Card, OrbitRings, StatusNote } from "../components/ui";
import { CoinDisc } from "../components/CoinDisc";

// Per-coin fiat price, to the cent (buy/sell are small CAD figures, e.g. CA$0.13).
const perCoin = (n: number, cur: string) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n || 0); }
  catch { return `$${(n || 0).toFixed(4)} ${cur}`; }
};
const usdOz = (n: number) => `$${Math.round(n || 0).toLocaleString()}`;

/* Hand-rolled SVG line chart of the buy (gold) + sell (blue) price over time. No deps —
   a polyline per series, mapped into the viewBox. */
function PriceChart({ history, fiat }: { history: ReservePoint[]; fiat: string }) {
  if (!history || history.length < 2) {
    return <div className="grid h-[220px] place-items-center rounded-card border border-line bg-space-1 text-[13px] text-ink-3">Price history will appear as the reserve trades.</div>;
  }
  const W = 720, H = 220, padL = 48, padR = 14, padY = 16;
  const xs = history.map((p) => p.ts);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const vals = history.flatMap((p) => [p.buy, p.sell]);
  const minY = Math.min(...vals), maxY = Math.max(...vals);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const x = (t: number) => padL + ((t - minX) / spanX) * (W - padL - padR);
  const y = (v: number) => H - padY - ((v - minY) / spanY) * (H - 2 * padY);
  const line = (key: "buy" | "sell") => history.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const last = history[history.length - 1];
  const fmtDate = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Arta Coin price over time — buy currently ${perCoin(last.buy, fiat)}, sell ${perCoin(last.sell, fiat)}; period high ${perCoin(maxY, fiat)}, low ${perCoin(minY, fiat)}`}>
        {/* faint gridlines, each labelled with its price — a full quartile scale (with the high/low
            below) so the chart reads as real prices at every level, not just at the extremes. */}
        {[0.25, 0.5, 0.75].map((f) => {
          const gy = padY + f * (H - 2 * padY);
          return (
            <g key={f}>
              <line x1={padL} x2={W - padR} y1={gy} y2={gy} stroke="var(--color-line)" strokeWidth="1" />
              <text x={padL - 8} y={gy + 3} textAnchor="end" fill="var(--color-ink-3)" fontSize="10">{perCoin(minY + (1 - f) * spanY, fiat)}</text>
            </g>
          );
        })}
        {/* Y-axis price scale (period high/low) so the chart reads as real prices, not just shapes */}
        <text x={padL - 8} y={padY + 4} textAnchor="end" fill="var(--color-ink-3)" fontSize="10">{perCoin(maxY, fiat)}</text>
        <text x={padL - 8} y={H - padY + 3} textAnchor="end" fill="var(--color-ink-3)" fontSize="10">{perCoin(minY, fiat)}</text>
        <path d={line("buy")} fill="none" stroke="#E8B923" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={line("sell")} fill="none" stroke="#4A72FF" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last.ts)} cy={y(last.buy)} r="3.5" fill="#E8B923" />
        <circle cx={x(last.ts)} cy={y(last.sell)} r="3.5" fill="#4A72FF" />
      </svg>
      <div className="mt-2 flex items-center justify-between text-[12px] text-ink-3">
        <span>{fmtDate(minX)}</span>
        <span className="flex items-center gap-4">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-yang" /> Buy {perCoin(last.buy, fiat)}</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-yin-light" /> Sell {perCoin(last.sell, fiat)}</span>
        </span>
        <span>{fmtDate(maxX)}</span>
      </div>
    </div>
  );
}

function TickerCard({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone: "yang" | "yin" | "ink" }) {
  const color = tone === "yang" ? "text-yang" : tone === "yin" ? "text-yin-light" : "text-ink";
  return (
    <Card className="p-5">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">{label}</p>
      <p className={`mt-1.5 text-[26px] font-extrabold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[12px] text-ink-3">{sub}</p>}
    </Card>
  );
}

export default function Reserve() {
  const [r, setR] = useState<Reserve | null>(null);
  const [fin, setFin] = useState<FoundationFinances | null>(null);
  // `failed` tracks a fetch error distinct from the initial loading state, so we don't hang on "Loading…".
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    getReserve().then((d) => { if (d) setR(d); else setFailed(true); }).catch(() => setFailed(true));
    getFoundationFinances().then(setFin).catch(() => { /* supplementary; the page renders without it */ });
  }, []);

  if (failed) return <StatusNote error className="py-16">Couldn't load — refresh to try again.</StatusNote>;
  if (!r) return <StatusNote className="py-16">Loading the reserve…</StatusNote>;
  const fiat = r.fiat || "CAD";
  // NEVER `|| 1` here. A backing ratio of 0 is a real, publishable answer, and the falsy-coalesce
  // that used to sit on this line turned it into a perfect 100% — so the one page whose entire job
  // is proof of reserve spent its life reporting the single most flattering number it could, beside
  // a "0 mg held" card that contradicted it. About.tsx already adjudicated the rule this restores:
  // say the RATIO is published, never say the coins are fully backed.
  const backedPct = Math.round((Number(r.backing_ratio) || 0) * 100);
  const reserveG = (r.reserve_mg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const updated = r.updated ? new Date(r.updated * 1000).toLocaleString() : "";

  return (
    <div className="flex flex-col gap-12 pb-12">
      {/* hero */}
      <section className="relative overflow-hidden rounded-card border border-line bg-space-2 px-6 py-14 sm:px-12 sm:py-16">
        <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-yang/10 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-28 -left-24 h-80 w-80 rounded-full bg-yin/15 blur-3xl" aria-hidden />
        <OrbitRings className="absolute -right-20 top-1/2 hidden h-[440px] w-[440px] -translate-y-1/2 text-ink lg:block" />
        <CoinDisc size={300} className="absolute right-2 top-1/2 hidden -translate-y-1/2 xl:block" />
        <CoinDisc size={200} className="absolute -right-6 top-1/2 hidden -translate-y-1/2 lg:block xl:hidden" />
        <div className="relative max-w-2xl">
          <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">{r.name} · {r.code}</p>
          <h1 className="mt-4 text-[clamp(2.1rem,5vw,3.3rem)] font-extrabold leading-[1.1]">
            A currency measured in <span className="aq-grad">real gold</span>
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-2">
            One <bdi dir="ltr" data-ay-skip="1">{r.symbol}</bdi> Arta Coin is meant to be one milligram of real gold. How much gold actually stands behind the coins in circulation is published below, live, whatever it says — and right now it does not say what we would like it to.
          </p>
          {/* The shortfall is stated in the HERO, not buried under a fold. The server already writes
              the plain-English explanation (Economy::reserve); render it verbatim rather than
              paraphrasing a number we would be tempted to round in our own favour. */}
          {!r.backed && r.shortfall_note && (
            <p className="mt-4 max-w-xl rounded-card border border-yang/40 bg-yang/10 px-4 py-3 text-[14px] leading-relaxed text-ink-2">
              {r.shortfall_note}
            </p>
          )}
          <p className="mt-3 text-[14px] text-ink-3"><bdi dir="ltr" data-ay-skip="1">{r.peg}</bdi></p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button href="/wallet/" size="xl">Buy or cash out coins</Button>
            <Button href="/donate/" variant="outline" size="xl" className="text-ink hover:text-yin-light">See the books</Button>
          </div>
        </div>
      </section>

      {/* live ticker */}
      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-[20px] font-bold tracking-tight">Live price</h2>
          {updated && <span className="text-[12px] text-ink-3">Updated <time dateTime={new Date(r.updated * 1000).toISOString()}>{updated}</time></span>}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <TickerCard label={`Buy price (${fiat}/${r.symbol})`} value={perCoin(r.buy, fiat)} sub="what you pay per coin" tone="yang" />
          <TickerCard label={`Sell price (${fiat}/${r.symbol})`} value={perCoin(r.sell, fiat)} sub="what you receive per coin" tone="yin" />
          <TickerCard label="Gold spot (USD/oz)" value={usdOz(r.gold_oz_usd || r.spot)} sub="the underlying metal" tone="ink" />
          <TickerCard label="Spread" value={`${Math.round((r.spread_total || (r.spread || 0) * 2) * 100)}%`} sub={`${Math.round((r.spread || 0) * 100)}% each way`} tone="ink" />
        </div>
        <Card className="mt-3 p-5">
          <p className="mb-3 text-[13px] font-semibold text-ink-2">Price over time</p>
          <PriceChart history={r.history} fiat={fiat} />
        </Card>
      </section>

      {/* 100% reserve proof */}
      <section>
        <h2 className="text-[20px] font-bold tracking-tight">Proof of reserve</h2>
        <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-ink-2">Every coin in circulation is meant to be matched, milligram for milligram, by gold in the vault. Here is the live ratio, whatever it says.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TickerCard label="Coins in circulation" value={<Coins n={r.supply} />} sub="total Arta Coins minted" tone="ink" />
          <TickerCard label="Gold reserve" value={`${reserveG} g`} sub={`${r.reserve_mg.toLocaleString()} mg held`} tone="yang" />
          <TickerCard label="Reserve value" value={formatFiat(r.reserve_value, fiat)} sub="at today’s spot" tone="yin" />
          <TickerCard label="Backing" value={`${backedPct}%`} sub={r.backed ? "fully backed" : `${r.shortfall_mg.toLocaleString()} mg not backed`} tone="yang" />
        </div>
        <Card className="mt-3 flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <p className="text-[15px] font-bold text-ink"><bdi dir="ltr" data-ay-skip="1">{r.peg}</bdi></p>
            {/* "redeemable any time" was a promise the cash-out rail does not keep: Economy::sell
                gates on cashout_enabled(), identity verification and a Stripe Connect payout account,
                and it can only ever pay out against gold that is actually held. */}
            <p className="mt-0.5 text-[13px] text-ink-3">
              {r.cashout
                ? "Coins can be cashed out at the sell price once you have verified your identity and set up a payout account."
                : "Cash-out is not open yet. Coins can be spent and held; redemption for money starts when the payout rail does."}
            </p>
          </div>
          <span className={`shrink-0 rounded-pill px-3.5 py-1.5 text-[13px] font-bold ${r.backed ? "bg-yin/15 text-yin-light" : "bg-yang/15 text-yang"}`}>
            {r.backed ? `${backedPct}% backed` : `${backedPct}% backed — a shortfall we owe`}
          </span>
        </Card>
      </section>

      {/* The member fund. Four separate figures on this row used to be wrong, all in the same
          direction — flattering. `fund_balance` and `donations_fiat` are CANADIAN DOLLARS (the fund
          ledger is fiat; no coin is minted from a gift), so they must go through formatFiat and never
          through <Coins/>, which stamps the gold-coin mark on them. `fund_issued` was hardcoded to 0
          in wp.ts and rendered as fact under the label "bursaries granted". And `donations_count` is
          the length of the last-25 `recent` window, spends included, so it counted spends as gifts
          and would have frozen at "25 gifts" forever. The two figures that are real are shown; the
          two that were invented are gone, and the books proper are one link away. */}
      {fin && (
        <section>
          <h2 className="text-[20px] font-bold tracking-tight">The member fund</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-ink-2">
            Gifts are held as money, earmarked to whoever the donor chose, and spent on challenge entry fees for those members. Nothing here is converted into coin.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TickerCard label="In the fund" value={formatFiat(fin.fund_balance, fin.fiat)} sub="donated money still on hand, every earmark" tone="yin" />
            <TickerCard label="Directed earmarks" value={fin.earmarks.length.toLocaleString()} sub="slices a donor has chosen and money is waiting for" tone="yang" />
          </div>
          <p className="mt-3 text-[13px] text-ink-3">
            Every entry and both of its sides are on <a href={localePath("/finances/")} className="font-semibold text-yang hover:underline">the Foundation’s books</a>.
          </p>
        </section>
      )}

      {/* explainer */}
      <section className="rounded-card border border-line bg-gradient-to-br from-space-2 to-space-3 px-6 py-12 sm:px-12">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-[clamp(1.4rem,3vw,1.9rem)] font-bold leading-snug">How it works</h2>
          <p className="mt-4 text-[16px] leading-relaxed text-ink-2">
            An Arta Coin is meant to be a claim on one milligram of real gold, and the ratio of gold held to coins issued is published above, live. It is not a promise that the ratio is 1 — it is a promise that you see the true number before we say anything about it, including when that number is against us.
          </p>
          {!r.backed && (
            <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
              It is against us today. <strong className="text-ink">{r.shortfall_mg.toLocaleString()} mg</strong> of the coin in circulation has no gold behind it, because those coins were issued to settle costs a director had already paid out of their own pocket — that money went to the supplier, so no gold was ever bought with it. The Foundation owes that gold. The entry is in the books, with the invoices attached.
            </p>
          )}
          <p className="mt-3 text-[15px] leading-relaxed text-ink-3">
            You win coins by taking a challenge pool: every entrant’s fee goes into the pool, and at the full moon the most-hearted entry takes the whole thing (an exact tie splits it evenly). You can also buy them with cash or cash them out at the published sell price. Prices move only with the price of gold — not with us.
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-ink-3">
            Don't take our word for it — <a href={localePath("/data/?table=wp_aq_coin_ledger")} className="font-semibold text-yang hover:underline">browse the raw ledgers</a> to inspect every coin movement and the full gold-rate history.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button href="/wallet/" size="lg">Open your wallet</Button>
            <Button href="/challenges/" variant="outline" size="lg" className="text-ink hover:text-yin-light">Win coins in a challenge</Button>
          </div>
        </div>
      </section>

      <MonthlyAudits />
    </div>
  );
}

/* Monthly reserve trail — one row per month, issued coins vs milligrams held. The open (current)
   month tracks the live reserve; closed months are frozen. Deliberately NOT called "append-only":
   it is a bounded option holding the last 60 months, and the append-only ledgers are the coin and
   fund tables in /data/. The raw rows are also in the public DB. */
function MonthlyAudits() {
  const [items, setItems] = useState<{ month: string; issued_coins: number; backing_mg: number; ratio: number; open?: boolean }[]>([]);
  useEffect(() => {
    fetch("/wp-json/aq/v1/reserve/audits").then((r) => r.json()).then((d) => setItems(d.items ?? [])).catch(() => {});
  }, []);
  if (!items.length) return null;
  return (
    <section className="max-w-2xl">
      <h2 className="text-[20px] font-bold tracking-tight">Monthly audits</h2>
      <p className="mt-1 text-[13.5px] text-ink-3">One row per month, recorded automatically. The current month tracks the live reserve above; a month is frozen once it ends, and a frozen row is never rewritten.</p>
      <table className="mt-4 w-full text-[14px]">
        <thead><tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-3">
          <th className="py-2 text-start font-semibold">Month</th><th className="py-2 text-end font-semibold">Coins issued</th><th className="py-2 text-end font-semibold">Gold held (mg)</th><th className="py-2 text-end font-semibold">Backed</th>
        </tr></thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.month} className="border-b border-line/50">
              <td className="py-2">{a.month}{a.open ? <span className="ms-2 text-[12px] font-semibold text-yang">live</span> : null}</td>
              <td className="py-2 text-end tabular-nums">{a.issued_coins.toLocaleString("en")}</td>
              <td className="py-2 text-end tabular-nums">{a.backing_mg.toLocaleString("en")}</td>
              <td className="py-2 text-end tabular-nums">{Math.round(a.ratio * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
