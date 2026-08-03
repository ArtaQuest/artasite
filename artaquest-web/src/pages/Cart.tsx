import { useEffect, useState } from "react";
import { getCart, removeFromCart, clearCart, onCartChange, type CartItem } from "../lib/cart";
import { localePath, getDonateOptions } from "../lib/wp";
import { Coins, formatFiat } from "../lib/currency";
import { Button, Card } from "../components/ui";
import { WithRail, RailInline } from "../components/PageRail";

// The cart holds donations only (fiat) — courses enrol off-cart with Arta Coins (addDonation is
// the sole writer). Donations are charged in their display currency at checkout and minted into
// gold-backed coins for learners.

export default function Cart() {
  const [items, setItems] = useState<CartItem[]>([]);
  useEffect(() => { const sync = () => setItems(getCart()); sync(); return onCartChange(sync); }, []);
  // Coin mint rate, so the total can show the gold-backed coins the gift becomes (matches Donate).
  const [coinRate, setCoinRate] = useState(0);
  useEffect(() => { getDonateOptions().then((o) => setCoinRate(o?.coin_buy_price || 0)); }, []);

  const fiat = items.find((i) => i.kind === "donation")?.currency || "CAD";
  // Donations sum in fiat for the order total (courses enrol directly with coins, off-cart).
  const total = items.filter((i) => i.kind === "donation").reduce((s, i) => s + (i.price || 0), 0);
  const coins = coinRate > 0 ? Math.round(total / coinRate) : 0;

  const header = (
    <div className="flex items-end justify-between gap-3">
      <h1 className="text-[30px] font-bold tracking-tight">Your donation{items.length === 1 ? "" : "s"}{items.length > 1 && <span className="ml-2 text-[15px] font-medium text-ink-3">{items.length} gifts</span>}</h1>
      {items.length > 1 && <button type="button" onClick={() => clearCart()} className="min-h-[28px] text-[13px] font-semibold text-ink-3 transition-colors hover:text-rose-300">Clear all</button>}
    </div>
  );

  // Defined ONCE and rendered in two places — the sticky rail on desktop, inline below lg. Two
  // copies of the totals would drift the moment either changes.
  const summary = (
    <Card className="p-5">
      <dl>
        <div className="flex items-center justify-between text-[17px] font-bold"><dt>Total</dt><dd className="tabular-nums text-yang" data-ay-skip="1">{formatFiat(total, fiat)}</dd></div>
        {coins > 0 && <div className="mt-1 flex items-center justify-between text-[13px] text-ink-3"><dt>In gold-backed coins for learners</dt><dd className="tabular-nums" data-ay-skip="1">≈ <Coins n={coins} /></dd></div>}
        {coins > 0 && <div className="mt-1 flex items-center justify-between text-[13px] text-ink-3"><dt>Donor points you’ll earn</dt><dd className="tabular-nums" data-ay-skip="1">≈ {coins.toLocaleString()}</dd></div>}
      </dl>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-3">Bank transfers (Interac / FAST / IBAN) are fee‑free; card payment adds the processor’s fee{items.length > 1 ? ", charged once for the whole order — so checking out together costs less than paying for each separately" : ""}.</p>
      <Button href="/enroll/" size="xl" className="mt-4 w-full">Proceed to checkout</Button>
      <a href={localePath("/donate/")} className="mt-3 block text-center text-[13px] text-ink-3 hover:text-yang">Add another donation</a>
    </Card>
  );

  // Nothing to total yet — one narrow column, no rail.
  if (items.length === 0) {
    return (
      <div className="flex flex-col">
        {header}
        <Card className="mt-6 p-8 text-center">
          <p className="text-[15px] text-ink-2">You haven’t added any donations yet.</p>
          <Button href="/donate/" size="lg" className="mt-4">Make a donation</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <WithRail label="Order summary" rail={summary}>
        {header}
        <ul className="mt-6 flex list-none flex-col gap-3">
          {items.map((i) => (
            <li key={i.slug} className="flex items-center justify-between gap-4 rounded-card border border-line bg-space-2 p-4">
              <div className="min-w-0">
                <span className="block truncate text-[15px] font-semibold text-ink">{i.title}</span>
                <span className="text-[13px] text-ink-3">Your gift · minted into gold-backed Arta Coins for learners</span>
              </div>
              <div className="flex shrink-0 items-center gap-4">
                <span className="font-bold tabular-nums text-yang" data-ay-skip="1">{formatFiat(i.price, i.currency || "CAD")}</span>
                <button type="button" onClick={() => removeFromCart(i.slug)} aria-label={`Remove ${i.title}`}
                  className="grid h-11 w-11 place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/5 hover:text-rose-300">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
        {/* lg:hidden on the wrapper too, so the margin leaves no phantom gap under the list on desktop. */}
        <div className="mt-5 lg:hidden">
          <RailInline>{summary}</RailInline>
        </div>
      </WithRail>
    </div>
  );
}
