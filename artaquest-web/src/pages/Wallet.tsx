import { type FormEvent, useEffect, useState } from "react";
import { uiLocale, getDashboard, getDonateOptions, getReserve, getWallet, buyCoins, sellCoins, getStripeVerify, getPayoutStatus, connectPayout, isLoggedIn, localePath, CHECKOUT_LIVE, type Dashboard, type DonateOptions, type Reserve, type WalletData, type BuyCoinsResult, type SellCoinsResult, type PayoutStatus } from "../lib/wp";
import { Coins, formatCoins, formatFiat, sanitizeDecimal } from "../lib/currency";
import { Button, Card, ErrorNote, Field, GatewayPicker, Input, OrbitRings, SignInGate } from "../components/ui";
import { CoinDisc } from "../components/CoinDisc";

// Human label for a coin-ledger reason code (Economy::credit_coins reasons).
const TXN_LABELS: Record<string, string> = {
  chprize: "Challenge prize · pool won", chfee: "Challenge entry fee", donation: "Donation to the member fund",
  buy: "Bought coins", sell: "Cashed out", refund: "Refund", grant: "Grant award", bursary: "Bursary grant",
};
const txnLabel = (r: string) => TXN_LABELS[r] || (r ? r.charAt(0).toUpperCase() + r.slice(1) : "Transaction");

// Per-coin price to the cent (small CAD figures, e.g. CA$0.13).
const perCoin = (n: number, cur: string) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n || 0); }
  catch { return `$${(n || 0).toFixed(4)} ${cur}`; }
};

// Payment-method-neutral copy keyed by gateway id (the stored descriptions are donation-flavoured).
const GATEWAY_DESC: Record<string, string> = {
  ay_interac: "Pay by Interac e-Transfer (Canada). We credit your coins within 1–2 business days.",
  ay_fast: "Pay by FAST transfer (Türkiye). We credit your coins within 1–2 business days.",
  ay_iban: "Pay by bank transfer (IBAN). We credit your coins within 1–2 business days.",
  ay_stripe: "Pay by credit or debit card. A small processing fee is added.",
};

/* Buy Arta Coins with fiat — mirrors the Checkout result/gateway UI. */
function BuyPanel({ opts, buyPrice, fiat, payments, reserveKnown, onRetry, onCredited }: { opts: DonateOptions | null; buyPrice: number; fiat: string; payments: boolean; reserveKnown: boolean; onRetry: () => void; onCredited: () => void }) {
  const [amount, setAmount] = useState("20");
  const [email, setEmail] = useState("");
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<BuyCoinsResult | null>(null);
  // Effective gateway = the user's pick, else the first available — derived, no effect needed.
  const gateway = picked || opts?.gateways[0]?.id || "";

  const cad = Math.max(0, parseFloat(amount) || 0);
  const estCoins = buyPrice > 0 ? Math.floor(cad / buyPrice) : 0;
  // WHAT STRIPE WILL ACTUALLY CHARGE. Economy::buy floors the coin count and then bills
  // `round($coins * $p['buy'], 2)` — never the typed amount — so the button used to quote a price
  // the checkout page then contradicted. Quote the server's own figure and nothing else.
  const charge = buyPrice > 0 ? Math.round(estCoins * buyPrice * 100) / 100 : cad;
  // THE FLOOR, SAID OUT LOUD. Economy::buy refuses anything under MIN_BUY_CAD, and a card network
  // will not accept a charge that small anyway (Stripe's CAD minimum is $0.50). Until now the button
  // simply went dead below it with nothing to explain why — a member who wanted a couple of coins
  // saw a disabled control and no reason. Say what the smallest purchase actually is, in coins,
  // because coins are what they came for.
  const MIN_BUY = 1;
  const minCoins = buyPrice > 0 ? Math.floor(MIN_BUY / buyPrice) : 0;
  const belowMin = cad > 0 && cad < MIN_BUY;
  // NO INBOUND RAIL vs. WE COULD NOT ASK. These are different facts and only one of them is about
  // the member.
  //
  // `payments` arrives as `reserve?.payments ?? false`, so a /reserve fetch that failed — an offline
  // moment, a blocked request, a cold edge — collapsed to the same `false` as a genuinely disabled
  // rail, and this panel then told the member "online payment isn't available in your country yet".
  // That is a false statement about where someone lives, produced by a network hiccup, on the one
  // screen where the answer decides whether they can pay at all. A member in a supported country
  // reads it, believes it, and leaves; nothing on the page invites them to try again.
  //
  // So the country line is reserved for a rail we actually KNOW is off, and an unanswered reserve
  // says only that, with a retry.
  const railsOff = reserveKnown && (!payments || (!!opts && opts.gateways.length === 0));
  const rateUnknown = !reserveKnown;

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      const r = await buyCoins(cad, gateway, email);
      if (r.redirect && r.url) { window.location.href = r.url; return; }
      setResult(r); onCredited();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "Could not start the purchase."); }
    finally { setBusy(false); }
  }

  if (result) {
    return (
      <Card role="status" className="p-6 text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-yang/15 text-yang">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
        <h3 className="mt-3 text-[18px] font-bold tracking-tight">Order #{result.order} — {result.instructions ? "almost there" : "coins credited"}</h3>
        <p className="mt-1.5 text-[14px] text-ink-2">
          {result.instructions
            ? <>Complete your {result.total_display || formatFiat(result.total, fiat)} payment via {result.gateway} to receive <Coins n={result.coins} />. We credit your wallet within 1–2 business days.</>
            : <>Payment received — <Coins n={result.coins} /> are now in your wallet.</>}
        </p>
        {result.instructions && <Card className="mt-4 whitespace-pre-line px-5 py-4 text-start text-[14px] leading-relaxed text-ink-2">{result.instructions}</Card>}
        <Button variant="outline" onClick={() => setResult(null)} className="mt-4 h-10 px-5 text-[14px]">Buy more</Button>
      </Card>
    );
  }

  return (
    <Card as="form" onSubmit={submit} className="flex flex-col gap-4 p-6">
      <div>
        <h3 className="text-[18px] font-bold tracking-tight">Buy coins</h3>
        <p className="mt-1 text-[13px] text-ink-3">Top up your wallet with Arta Coins. {buyPrice > 0 && <>Currently {perCoin(buyPrice, fiat)} per <bdi dir="ltr" data-ay-skip="1">₳</bdi>, smallest purchase {formatFiat(MIN_BUY, fiat)} (<Coins n={minCoins} />).</>}</p>
      </div>
      {rateUnknown ? (
        <div className="rounded-field border border-line bg-space-1 px-4 py-3">
          <p className="text-[14px] text-ink-2">We couldn’t load today’s coin price just now, so the form is waiting rather than guessing at it. Nothing is wrong with your account.</p>
          <Button variant="outline" onClick={onRetry} className="mt-3 h-9 px-4 text-[13px]">Try again</Button>
        </div>
      ) : railsOff ? (
        <p className="rounded-field border border-line bg-space-1 px-4 py-3 text-[14px] text-ink-2">Online payment isn’t available in your country yet. You can still win coins by taking a challenge pool — at the full moon the most-hearted entry takes the whole thing.</p>
      ) : (
        <>
          <Field label={`Amount (${fiat})`}>
            <Input value={amount} onChange={(e) => setAmount(sanitizeDecimal(e.target.value))} inputMode="decimal" className="bg-space-1 px-3.5" />
          </Field>
          {buyPrice > 0
            ? <p className="-mt-1 text-[13px] text-ink-3"><span className="font-semibold text-yang"><Coins n={estCoins} /></span> at today’s price, charged at {formatFiat(charge, fiat)}. Coins are whole, so we round down and only charge for the coins you receive.</p>
            : <p className="-mt-1 text-[13px] text-ink-3">Your coins are calculated at today’s gold price when the payment is confirmed.</p>}
          {belowMin && buyPrice > 0 && (
            <p role="status" className="-mt-1 text-[13px] leading-relaxed text-yang">
              The smallest card payment is {formatFiat(MIN_BUY, fiat)}, which is <Coins n={minCoins} /> at today’s price — a card network won’t process less. Enter {formatFiat(MIN_BUY, fiat)} or more.
            </p>
          )}
          <Field label={<>Email <span className="font-normal text-ink-3">— for your receipt (optional; we’ll use your account email)</span></>}>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" placeholder="you@example.com" className="bg-space-1 px-3.5" />
          </Field>
          <GatewayPicker gateways={opts?.gateways || []} value={gateway} onChange={setPicked} descriptions={GATEWAY_DESC} labelId="aq-buy-method-label" />
          {err && <ErrorNote>{err}</ErrorNote>}
          <Button type="submit" disabled={busy || cad < 1 || estCoins < 1} className="h-12 w-full text-[16px] disabled:opacity-50">{busy ? "Processing…" : <>Buy {estCoins > 0 ? <Coins n={estCoins} /> : "coins"} — {formatFiat(charge, fiat)}</>}</Button>
        </>
      )}
    </Card>
  );
}

/* Cash out Arta Coins for fiat. */
function SellPanel({ balance, sellPrice, fiat, cashout, onSold }: { balance: number; sellPrice: number; fiat: string; cashout: boolean; onSold: (b: number) => void }) {
  const [coins, setCoins] = useState("");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<SellCoinsResult | null>(null);
  const [payout, setPayout] = useState<PayoutStatus | null>(null);

  // Load cash-out readiness (connected account? payouts enabled?) once the rail is live and there's a
  // balance to redeem — so we show the right state (set up payouts vs. ready to withdraw).
  useEffect(() => {
    if (cashout && balance > 0) getPayoutStatus().then(setPayout);
  }, [cashout, balance]);

  const n = Math.max(0, Math.floor(parseFloat(coins) || 0));
  const estPayout = sellPrice > 0 ? n * sellPrice : 0;
  const needsOnboarding = payout != null && !payout.payouts_enabled;

  async function startOnboarding() {
    setErr(""); setConnecting(true);
    try {
      const r = await connectPayout();
      if (r.ok && r.url) { window.location.href = r.url; return; }
      setErr(r.message || "Could not start payout setup. Please try again.");
    } catch { setErr("Could not start payout setup. Please try again."); }
    finally { setConnecting(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      const r = await sellCoins(n);
      if (!r.ok) {
        if (r.error === "needs_onboarding") { setPayout((p) => p ? { ...p, payouts_enabled: false } : p); await startOnboarding(); return; }
        setErr(r.message || "Could not cash out.");
        return;
      }
      setResult(r); onSold(r.balance);
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "Could not cash out."); }
    finally { setBusy(false); }
  }

  // Cash-out is disabled until a real fiat payout rail exists (reserve.cashout). Show a calm, honest
  // "coming soon" rather than a form the backend would reject. (This used to add "coins stay fully
  // gold-backed"; they do not — /reserve publishes the live ratio and it is currently 0.)
  if (!cashout) {
    return (
      <Card className="flex flex-col gap-4 p-6">
        <div>
          <h3 className="text-[18px] font-bold tracking-tight">Cash out</h3>
          <p className="mt-1 text-[13px] text-ink-3">Redeem coins for cash at the published sell price.</p>
        </div>
        <p className="rounded-field border border-line bg-space-1 px-4 py-3 text-[14px] text-ink-2">Cash-out is coming soon — spend or hold your coins now, and you’ll be able to redeem for cash the moment it launches. How much gold currently stands behind the coin is published live on <a href="/reserve/" className="font-semibold text-yang hover:underline">the reserve page</a>.</p>
      </Card>
    );
  }

  // Nothing to sell yet — point the member at the only way to mint coins, rather than a dead form.
  if (balance <= 0) {
    return (
      <Card className="flex flex-col gap-4 p-6">
        <div>
          <h3 className="text-[18px] font-bold tracking-tight">Cash out</h3>
          <p className="mt-1 text-[13px] text-ink-3">Redeem coins for cash at the published sell price.</p>
        </div>
        <p className="rounded-field border border-line bg-space-1 px-4 py-3 text-[14px] text-ink-2">You have no
        coins yet. You win gold-backed coins by taking a challenge pool: enter with work you have
        published, and if yours is the most-hearted entry at the full moon the whole pool is minted into
        your wallet.</p>         <Button href="/challenges/" variant="outline" className="h-11 w-full
        text-[15px]">Win coins in a challenge</Button>
      </Card>
    );
  }

  return (
    <Card as="form" onSubmit={submit} className="flex flex-col gap-4 p-6">
      <div>
        <h3 className="text-[18px] font-bold tracking-tight">Cash out</h3>
        <p className="mt-1 text-[13px] text-ink-3">Redeem coins for cash at the published sell price{sellPrice > 0 && <> ({perCoin(sellPrice, fiat)} per <bdi dir="ltr" data-ay-skip="1">₳</bdi>)</>}. This price already includes the 5%-per-side spread.</p>
      </div>
      <Field label="Coins to cash out">
        <div className="flex items-center gap-2">
          <Input value={coins} onChange={(e) => setCoins(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" placeholder="0" className="min-w-0 flex-1 bg-space-1 px-3.5" />
          <Button variant="outline" size="md" onClick={() => setCoins(String(balance))} className="shrink-0 px-3 text-[13px]">Max</Button>
        </div>
      </Field>
      <p className="-mt-1 text-[13px] text-ink-3">{sellPrice > 0 && <>≈ <span className="font-semibold text-yin-light">{formatFiat(estPayout, fiat)}</span> · </>}balance after: <Coins n={Math.max(0, balance - n)} /></p>
      {needsOnboarding && (
        <p className="rounded-field border border-line bg-space-1 px-4 py-3 text-[13px] text-ink-2">First cash-out? You’ll set up a secure payout account with Stripe (a one-time, 2-minute step) so we can send money straight to your bank.</p>
      )}
      {err && <ErrorNote>{err}</ErrorNote>}
      {result && <p role="status" className="rounded-card border border-yang/40 bg-yang/10 px-4 py-2.5 text-[14px] text-ink">{result.message || <>Cashed out <Coins n={result.coins} /> for {formatFiat(result.payout, result.currency || fiat)}.</>}</p>}
      {needsOnboarding ? (
        <Button type="button" variant="primaryYin" onClick={startOnboarding} disabled={connecting} className="h-12 w-full text-[16px] disabled:opacity-50">{connecting ? "Opening secure setup…" : "Set up payouts to cash out"}</Button>
      ) : (
        <Button type="submit" variant="primaryYin" disabled={busy || n < 1 || n > balance} className="h-12 w-full text-[16px] disabled:opacity-50">{busy ? "Processing…" : n > 0 ? <>Cash out {formatFiat(estPayout, fiat)}</> : "Cash out"}</Button>
      )}
      {n > balance && <p className="-mt-1 text-[12px] text-rose-300">You only have {formatCoins(balance)}.</p>}
    </Card>
  );
}

export default function Wallet() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [opts, setOpts] = useState<DonateOptions | null>(null);
  const [reserve, setReserve] = useState<Reserve | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [wallet, setWallet] = useState<WalletData | null>(null);
  // `failed` tracks a reserve fetch error distinct from loading, so prices/cash-out don't hang on "Loading…".
  const [failed, setFailed] = useState(false);

  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const logged = isLoggedIn();
  const refreshWallet = () => getWallet().then((wd) => { if (wd) { setWallet(wd); setBalance(wd.coins); } });
  // Named so the Buy panel's "Try again" can re-run exactly what the mount ran. Clearing `failed`
  // first matters: without it a retry that succeeds leaves the page still showing the failure copy.
  const loadReserve = () => {
    setFailed(false);
    return getReserve().then((d) => { if (d) setReserve(d); else setFailed(true); }).catch(() => setFailed(true));
  };
  useEffect(() => {
    if (!logged) return;
    getDashboard().then((d) => { setDash(d); if (d) setBalance(d.coins); });
    getDonateOptions().then(setOpts);
    loadReserve();
    refreshWallet();
  }, [logged]);

  // Returning from Stripe Checkout — a coin top-up OR a donation, since /donate now returns the giver
  // here too. Verify the session, then refresh the wallet so any minted coins show. Fulfilment is
  // idempotent server-side (and also covered by the webhook), so a refresh never double-credits.
  // Strip the query afterwards so a reload doesn't re-show the banner.
  useEffect(() => {
    if (!logged) return;
    const sp = new URLSearchParams(window.location.search);
    const po = sp.get("payout");
    if (po) {
      // Returning from Stripe Express onboarding. "done" = finished (payouts may now be enabled);
      // "refresh" = the link expired before finishing. Either way, refresh the wallet + clear the query.
      setNotice(po === "done"
        ? { ok: true, text: "Payout setup complete — you can cash out below." }
        : { ok: false, text: "Payout setup wasn’t finished. Start again whenever you’re ready." });
      refreshWallet();
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    const st = sp.get("stripe");
    if (!st) return;
    if (st === "success") {
      const session = sp.get("session") || "";
      if (session) getStripeVerify(session).then((v) => {
        if (v?.paid) {
          refreshWallet();
          // `course` is the server's name for what was bought (Extra::stripe_verify): 'Your gift' for a
          // donation, 'Arta Coins' for a top-up. A donation mints NO coins, so the single top-up message
          // told every donor their gift had landed in a wallet it never touched — thank them instead.
          // The COINS claim is the one that can be false, so only the exact 'Arta Coins' literal earns
          // it; an unrecognised kind (or a future rename on the server) falls back to a plain receipt
          // rather than promising coins that were never minted.
          setNotice({ ok: true, text: v.course === "Arta Coins"
            ? "Payment received — your coins are in your wallet."
            : v.course === "Your gift"
              ? "Thank you — your gift has been received. Every donation is on the public ledger."
              : "Payment received — thank you." });
        }
        else setNotice({ ok: false, text: "We couldn't confirm your card payment yet. If you were charged, it'll appear shortly." });
      });
    } else if (st === "cancel") {
      setNotice({ ok: false, text: "Card payment cancelled — nothing was charged." });
    }
    window.history.replaceState({}, "", window.location.pathname);
  }, [logged]);  

  if (!logged) {
    return <SignInGate title="Your wallet" body="Sign in to buy, hold, and cash out Arta Coins." />;
  }
  // A reserve/FX-feed failure must NOT hide the wallet: the balance + ledger come from the coin
  // ledger and don't need live prices. We degrade gracefully (drop the fiat estimate, show a note)
  // instead of blocking the whole page — losing sight of your own balance over a price-feed hiccup
  // is the worst failure here. `failed` now only suppresses the fiat conversion below.
  const fiat = reserve?.fiat || "CAD";
  const bal = balance ?? dash?.coins ?? 0;

  return (
    <div className="flex flex-col gap-8 pb-12">
      {/* balance header */}
      <section className="relative overflow-hidden rounded-card border border-line bg-space-2 px-6 py-9 shadow-card sm:px-9">
        <OrbitRings className="absolute -right-10 top-1/2 hidden h-72 w-72 -translate-y-1/2 text-ink sm:block lg:right-12" />
        <div className="relative flex items-center justify-between gap-6">
          <div>
            <p className="text-[13px] font-semibold uppercase tracking-[0.18em] text-ink-3">Your wallet</p>
            <div className="mt-2 text-[clamp(2.4rem,6vw,3.2rem)] font-extrabold leading-none text-yang tabular-nums">{balance == null && !dash ? "—" : <Coins n={bal} />}</div>
            <p className="mt-2 text-[14px] text-ink-2">Arta Coins · <a href="/reserve/" className="hover:text-yin-light hover:underline">{reserve ? `${Math.round((Number(reserve.backing_ratio) || 0) * 100)}% gold-backed` : "gold-backed"}</a>.{reserve ? <> Cash-out value ≈ <span className="font-semibold text-ink">{formatFiat(bal * reserve.sell, fiat)}</span>.</> : failed ? <> Live cash-out value is temporarily unavailable.</> : null}</p>
            <a href={localePath("/reserve/")} className="mt-3 inline-block text-[14px] font-semibold text-yang hover:underline">See the reserve <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></a>
          </div>
          <CoinDisc size={132} className="hidden shrink-0 sm:block" />
        </div>
      </section>

      {notice && (
        <p role="status" className={`rounded-card border px-4 py-3 text-[14px] ${notice.ok ? "border-yang/40 bg-yang/10 text-ink" : "border-line bg-space-1 text-ink-2"}`}>{notice.text}</p>
      )}

      {CHECKOUT_LIVE ? (
        // #buy is the scroll target for "Top up your wallet" CTAs (e.g. ArtaBot) so landing here goes
        // straight to the Buy-coins form; scroll-mt clears the 60px sticky topbar.
        <div id="buy" className="grid scroll-mt-24 gap-5 lg:grid-cols-2">
          <BuyPanel opts={opts} buyPrice={reserve?.buy ?? 0} fiat={fiat} payments={reserve?.payments ?? false} reserveKnown={!!reserve} onRetry={loadReserve} onCredited={refreshWallet} />
          <SellPanel balance={bal} sellPrice={reserve?.sell ?? 0} fiat={fiat} cashout={reserve?.cashout ?? false} onSold={() => refreshWallet()} />
        </div>
      ) : (
        // Buy/cash-out is retired (see CHECKOUT_LIVE) — the BuyPanel filled then failed on submit
        // (buyCoins is a RETIRED stub). Honest state instead; balance + live gold value stay above.
        <Card className="flex flex-col items-start gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[18px] font-bold tracking-tight">Buying and cashing out are being rebuilt</h2>
            <p className="mt-1 max-w-xl text-[14px] leading-relaxed text-ink-2">Topping up with cash and cashing out
            for cash are coming back on the new platform. Meanwhile you win gold-backed coins by taking
            a challenge pool — the most-hearted entry at the full moon takes the whole thing.</p>
            </div>           <Button href="/challenges/" className="shrink-0">Win coins in a
            challenge</Button>
        </Card>
      )}

      {wallet && wallet.ledger.length > 0 && (
        <Card as="section" className="p-5 sm:p-6">
          <h2 className="text-[16px] font-bold tracking-tight">Recent activity</h2>
          <ul className="mt-3 divide-y divide-line">
            {wallet.ledger.slice(0, 12).map((t, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-[14px] text-ink-2">{txnLabel(t.reason)}</span>
                  {t.at > 0 && <span className="block text-[12px] text-ink-3">{new Date(t.at * 1000).toLocaleDateString(uiLocale(), { month: "short", day: "numeric", year: "numeric" })}</span>}
                </span>
                <span className={`shrink-0 text-[15px] font-semibold tabular-nums ${t.delta >= 0 ? "text-yang" : "text-ink-3"}`}>{t.delta >= 0 ? "+" : "−"}<Coins n={Math.abs(t.delta)} /></span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="text-center text-[12px] text-ink-3">Prices track the price of gold, not us. You win coins by taking a challenge pool, and earn points by publishing, replying, donating, volunteering, or winning grants — see the <a href={localePath("/rankings/")} className="text-yang hover:underline">rankings</a> or <a href={localePath("/data/?table=wp_aq_coin_ledger")} className="text-yang hover:underline">browse the ledgers</a>.</p>
    </div>
  );
}
