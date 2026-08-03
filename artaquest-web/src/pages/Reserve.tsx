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
  const backedPct = Math.round((r.backing_ratio || 1) * 100);
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
            A currency backed by <span className="aq-grad">real gold</span>
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-2">
            Every <bdi dir="ltr" data-ay-skip="1">{r.symbol}</bdi> Arta Coin is backed 1-for-1 by a milligram of real gold held in reserve. We mint coins only when gold enters our vault and burn them only when it leaves. Everyone can cash out at the same time.
          </p>
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
        <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-ink-2">Coins in circulation are matched, milligram for milligram, by gold in the vault. The reserve is public and current.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TickerCard label="Coins in circulation" value={<Coins n={r.supply} />} sub="total Arta Coins minted" tone="ink" />
          <TickerCard label="Gold reserve" value={`${reserveG} g`} sub={`${r.reserve_mg.toLocaleString()} mg held`} tone="yang" />
          <TickerCard label="Reserve value" value={formatFiat(r.reserve_value, fiat)} sub="at today’s spot" tone="yin" />
          <TickerCard label="Backing" value={`${backedPct}%`} sub={r.fully_backed ? "100% backed" : "backing ratio"} tone="yang" />
        </div>
        <Card className="mt-3 flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <p className="text-[15px] font-bold text-ink"><bdi dir="ltr" data-ay-skip="1">{r.peg}</bdi></p>
            <p className="mt-0.5 text-[13px] text-ink-3">Each coin is redeemable for its milligram of gold, at the sell price, any time.</p>
          </div>
          <span className={`shrink-0 rounded-pill px-3.5 py-1.5 text-[13px] font-bold ${r.fully_backed ? "bg-yang/15 text-yang" : "bg-yin/15 text-yin-light"}`}>
            {r.fully_backed ? "100% backed" : `${backedPct}% backed`}
          </span>
        </Card>
      </section>

      {/* the foundation's coin fund (optional, from finances) */}
      {fin && (
        <section>
          <h2 className="text-[20px] font-bold tracking-tight">The learner fund</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-ink-2">Donations are converted to gold-backed Arta Coins and held for learners, issued when a candidate needs them.</p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <TickerCard label="Fund on hand" value={<Coins n={fin.fund_balance} />} sub="held for learners" tone="yin" />
            <TickerCard label="Issued to learners" value={<Coins n={fin.fund_issued} />} sub="bursaries granted" tone="yang" />
            <TickerCard label="Donations received" value={formatFiat(fin.donations_fiat, fin.fiat)} sub={`${fin.donations_count} gift${fin.donations_count === 1 ? "" : "s"}`} tone="ink" />
          </div>
        </section>
      )}

      {/* explainer */}
      <section className="rounded-card border border-line bg-gradient-to-br from-space-2 to-space-3 px-6 py-12 sm:px-12">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-[clamp(1.4rem,3vw,1.9rem)] font-bold leading-snug">How it works</h2>
          <p className="mt-4 text-[16px] leading-relaxed text-ink-2">
            Every Arta Coin is backed 1-for-1 by a milligram of real gold. We mint coins only when gold enters our vault and burn them only when it leaves. Because the reserve always matches the supply, everyone can cash out at the same time — there is no fractional reserve and no promise we cannot keep.
          </p>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-3">
            You earn coins by posting the most-upvoted replies in a course — each course shares 80% of its revenue with its top questers, the main way coins flow into your wallet. You can also buy them with cash or cash them out at the published sell price. Prices move only with the price of gold — not with us.
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-ink-3">
            Don't take our word for it — <a href={localePath("/data/?table=wp_aq_coin_ledger")} className="font-semibold text-yang hover:underline">browse the raw ledgers</a> to inspect every coin movement and the full gold-rate history.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button href="/wallet/" size="lg">Open your wallet</Button>
            <Button href="/courses/" variant="outline" size="lg" className="text-ink hover:text-yin-light">Win coins by learning</Button>
          </div>
        </div>
      </section>

      <MonthlyAudits />
    </div>
  );
}

/* Monthly full-reserve audits — an append-only trail snapshotted on the first watchdog tick of each
   month (issued coins vs milligrams held). The raw rows are also in the public DB. */
function MonthlyAudits() {
  const [items, setItems] = useState<{ month: string; issued_coins: number; backing_mg: number; ratio: number }[]>([]);
  useEffect(() => {
    fetch("/wp-json/aq/v1/reserve/audits").then((r) => r.json()).then((d) => setItems(d.items ?? [])).catch(() => {});
  }, []);
  if (!items.length) return null;
  return (
    <section className="max-w-2xl">
      <h2 className="text-[20px] font-bold tracking-tight">Monthly audits</h2>
      <p className="mt-1 text-[13.5px] text-ink-3">Snapshotted automatically on the first day of each month — an append-only public record of the full reserve.</p>
      <table className="mt-4 w-full text-[14px]">
        <thead><tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-3">
          <th className="py-2 text-start font-semibold">Month</th><th className="py-2 text-end font-semibold">Coins issued</th><th className="py-2 text-end font-semibold">Gold held (mg)</th><th className="py-2 text-end font-semibold">Backed</th>
        </tr></thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.month} className="border-b border-line/50">
              <td className="py-2">{a.month}</td>
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
