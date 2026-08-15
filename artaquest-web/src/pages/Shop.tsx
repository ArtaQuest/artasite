import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { isLoggedIn, localePath } from "../lib/wp";
import { Shop as ShopApi, Economy, ApiError, type ShopProduct, type ShopQuote, type ShopOrder } from "../lib/api";
import {
  Button, Card, PageHero, EmptyState, StatusNote, SkeletonGrid, LoadMoreButton,
  SignInGate, Pill, Field, Input, Select, CheckField,
} from "../components/ui";
import { CoverArt } from "../components/studio";

/**
 * ArtaShop — hard copies shipped worldwide: printed books, games, illustration prints
 * and merch. Shipping is charged at our postal carrier's real international tariff —
 * weight grades + customs + optional insurance — converted live into gold-backed
 * ArtaCoins and passed through at cost. Paid entirely in ₳.
 * (Member-facing copy deliberately never names the carrier or its tariff internals —
 * operator surfaces and the fee engine in Shop.php keep the full detail.)
 */

// ISO 3166-1 alpha-2 — every destination PTT ships to (Türkiye handled as any other row).
const COUNTRIES = ("AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW").split(" ");

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames([document.documentElement.lang || "en"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

// ── the basket lives in localStorage so browsing never loses it ──────────────
type BasketLine = { id: number; qty: number };
const BASKET_KEY = "aq_shop_basket";
function readBasket(): BasketLine[] {
  try { return JSON.parse(localStorage.getItem(BASKET_KEY) || "[]"); } catch { return []; }
}
function writeBasket(b: BasketLine[]) {
  try { localStorage.setItem(BASKET_KEY, JSON.stringify(b)); } catch { /* storage blocked */ }
}
const basketSpec = (b: BasketLine[]) => b.map((l) => `${l.id}:${l.qty}`).join(",");

function ProductCard({ p, onAdd }: { p: ShopProduct; onAdd: (p: ShopProduct) => void }) {
  return (
    <Card className="flex h-full flex-col overflow-hidden p-0">
      <Link to={localePath(`/shop/${p.id}/`)} className="block aspect-square w-full overflow-hidden bg-space-2 no-underline">
        <CoverArt title={p.title} src={p.image} />
      </Link>
      <div className="flex grow flex-col gap-1.5 p-3">
        {!p.available && <span className="flex"><Pill className="text-red-400">Sold out</Pill></span>}
        <Link to={localePath(`/shop/${p.id}/`)} className="font-semibold tracking-tight text-ink no-underline hover:underline">{p.title}</Link>
        <div className="mt-auto flex items-center justify-between gap-2 pt-2">
          <span className="text-[15px] font-bold text-ink">₳{p.price_coins}</span>
          <Button size="sm" variant="outline" onClick={() => onAdd(p)} disabled={!p.available}>Add to basket</Button>
        </div>
      </div>
    </Card>
  );
}

const ORDER_STATUS: Record<string, string> = {
  paid: "Paid — being prepared", shipped: "Shipped", delivered: "Delivered", cancelled: "Cancelled & refunded",
};

function MyOrders({ refreshKey }: { refreshKey: number }) {
  const [orders, setOrders] = useState<ShopOrder[] | null>(null);
  useEffect(() => {
    let live = true;
    ShopApi.myOrders().then((r) => { if (live) setOrders(r.items); }).catch(() => { if (live) setOrders([]); });
    return () => { live = false; };
  }, [refreshKey]);
  if (!orders || orders.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[18px] font-bold tracking-tight">Your orders</h2>
      <ul className="grid list-none gap-3">
        {orders.map((o) => (
          <li key={o.id}>
            <Card className="flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-ink">Order #{o.id} · ₳{o.coins_total}</span>
                <Pill>{ORDER_STATUS[o.status] || o.status}</Pill>
              </div>
              <p className="text-[13px] text-ink-3">
                {o.items.map((i) => `${i.qty}× ${i.title}`).join(" · ")} → {countryName(o.country)}
                {" "}({o.service === "registered" ? "registered, tracked" : "unregistered mail"})
              </p>
              {o.tracking && (
                <p className="text-[13px] text-ink-3">
                  Tracking:{" "}
                  {o.track_url ? (
                    <a href={o.track_url} target="_blank" rel="noopener noreferrer" className="font-mono font-semibold text-yin-light hover:underline">{o.tracking} ↗</a>
                  ) : (
                    <span className="font-mono text-ink">{o.tracking}</span>
                  )}{" "}
                  <span className="text-ink-3">— follow it door-to-door</span>
                </p>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The basket + delivery form + the live PTT quote → place the order. */
function CheckoutPanel({ basket, products, setBasket, onOrdered }: {
  basket: BasketLine[];
  products: Map<number, ShopProduct>;
  setBasket: (b: BasketLine[]) => void;
  onOrdered: (o: ShopOrder) => void;
}) {
  const logged = isLoggedIn();
  const [country, setCountry] = useState("");
  const [insured, setInsured] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [postcode, setPostcode] = useState("");
  const [quote, setQuote] = useState<ShopQuote | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [coins, setCoins] = useState<number | null>(null);

  const lines = basket.filter((l) => products.has(l.id));
  const spec = basketSpec(lines);

  useEffect(() => {
    if (!logged) return;
    Economy.wallet().then((w) => setCoins(w.coins)).catch(() => setCoins(null));
  }, [logged]);

  // Live shipping quote — recomputed whenever the basket or the destination changes.
  useEffect(() => {
    if (!country || lines.length === 0) { setQuote(null); return; }
    let live = true;
    setErr("");
    ShopApi.quote(country, spec, insured)
      .then((q) => { if (live) setQuote(q); })
      .catch((e) => {
        if (!live) return;
        setQuote(null);
        setErr(e instanceof ApiError && e.status === 400
          ? "This can’t travel as one parcel — a very heavy order needs splitting (30 kg max; 20 kg to the UK, Kazakhstan and Uzbekistan)."
          : "Could not price shipping — please try again.");
      });
    return () => { live = false; };
  }, [country, spec, insured, lines.length]);

  if (lines.length === 0) return null;

  async function place() {
    setBusy(true); setErr("");
    try {
      const r = await ShopApi.order({ items: spec, country, name, address, city, postcode, insured });
      setBasket([]);
      onOrdered(r.order);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message || "The order could not be placed" : "The order could not be placed");
    } finally { setBusy(false); }
  }

  const total = quote ? quote.total_coins : null;
  const short = total != null && coins != null && coins < total;

  return (
    <Card className="flex flex-col gap-4 p-5" id="basket">
      <h2 className="text-[18px] font-bold tracking-tight">Your basket</h2>
      <ul className="grid list-none gap-2">
        {lines.map((l) => {
          const p = products.get(l.id)!;
          return (
            <li key={l.id} className="flex items-center justify-between gap-3 text-[14px]">
              <span className="min-w-0 truncate text-ink">{p.title}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="flex items-center rounded-pill border border-line">
                  <button type="button" aria-label="One fewer" className="px-2 py-0.5 text-ink-3 hover:text-ink"
                    onClick={() => setBasket(l.qty > 1 ? basket.map((b) => b.id === l.id ? { ...b, qty: b.qty - 1 } : b) : basket.filter((b) => b.id !== l.id))}>−</button>
                  <span className="min-w-6 text-center font-semibold text-ink">{l.qty}</span>
                  <button type="button" aria-label="One more" className="px-2 py-0.5 text-ink-3 hover:text-ink"
                    onClick={() => setBasket(basket.map((b) => b.id === l.id ? { ...b, qty: Math.min(99, b.qty + 1) } : b))}>+</button>
                </span>
                <span className="w-14 text-end font-semibold text-ink">₳{p.price_coins * l.qty}</span>
              </span>
            </li>
          );
        })}
      </ul>

      {!logged ? (
        <SignInGate title="Sign in to order"
          body="Orders are paid with the ArtaCoins in your wallet — sign in (free) and top up, then your hard copies ship to your door."
          href={localePath("/login/")} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Deliver to country" className="sm:col-span-2">
              <Select value={country} onChange={setCountry} label="Deliver to country"
                options={[{ value: "", label: "Choose a country…" },
                  ...COUNTRIES.map((c) => ({ value: c, label: countryName(c) })).sort((a, b) => a.label.localeCompare(b.label))]} />
            </Field>
            <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
            <Field label="City"><Input value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" /></Field>
            <Field label="Street address" className="sm:col-span-2">
              <Input value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" />
            </Field>
            <Field label="Postcode" optional><Input value={postcode} onChange={(e) => setPostcode(e.target.value)} autoComplete="postal-code" /></Field>
          </div>
          <CheckField checked={insured} onChange={setInsured}>
            Insure this shipment (covers loss or damage — a small fixed fee + 0.8% of the value)
          </CheckField>

          {err && <StatusNote error>{err}</StatusNote>}

          {quote && (
            <div className="rounded-lg border border-line bg-space-2/50 p-4 text-[14px]">
              <div className="flex justify-between"><span className="text-ink-3">Goods</span><span className="font-semibold text-ink">₳{quote.goods_coins}</span></div>
              <div className="mt-1 flex justify-between">
                <span className="text-ink-3">
                  Shipping to {countryName(quote.country)} — {(quote.weight_g / 1000).toFixed(1)} kg,{" "}
                  {quote.tracked ? "registered & tracked" : "unregistered (no tracking — registered mail isn’t available to this country)"}
                  {quote.insure_tl > 0 ? ", insured" : ""}
                </span>
                <span className="font-semibold text-ink">₳{quote.coins}</span>
              </div>
              <div className="mt-2 flex justify-between border-t border-line pt-2 text-[15px] font-bold text-ink">
                <span>Total</span><span>₳{quote.total_coins}</span>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
                Shipping is the exact fee our postal carrier charges us — postage, customs clearance
                {quote.insure_tl > 0 ? " and insurance" : ""} — converted to gold-backed coins at the live rate. We add nothing on top.
              </p>
            </div>
          )}

          {short && (
            <StatusNote error>
              Your wallet holds ₳{coins} and this order is ₳{total}. <a className="font-semibold underline" href={localePath("/wallet/")}>Top up your wallet</a> first.
            </StatusNote>
          )}
          <Button onClick={place} disabled={busy || !quote || !country || short || name.trim().length < 2 || address.trim().length < 8 || city.trim() === ""}>
            {busy ? "Placing order…" : total != null ? `Place order — ₳${total}` : "Place order"}
          </Button>
        </>
      )}
    </Card>
  );
}

/** /shop/<id> — one product, full width (also the SEO-resolved page). */
function ProductDetail({ id, onAdd }: { id: number; onAdd: (p: ShopProduct) => void }) {
  const [p, setP] = useState<ShopProduct | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    setP(null); setMissing(false);
    ShopApi.get(id).then((r) => { if (live) setP(r); }).catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [id]);
  useEffect(() => { if (p) document.title = `${p.title} – ArtaQuest Store`; }, [p]);
  if (missing) return <EmptyState title="This product is no longer in the Store" body={<Link className="font-semibold text-yin-light hover:underline" to={localePath("/shop/")}>Back to the Store <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></Link>} />;
  if (!p) return <SkeletonGrid count={2} />;
  const sourceHref = p.source_type === "document" ? `/read/${p.source_id}/` : p.source_type === "illustration" ? `/illustration/${p.source_id}/` : "";
  return (
    <Card className="grid gap-6 p-5 sm:grid-cols-2">
      <div className="overflow-hidden rounded-lg bg-space-2"><CoverArt title={p.title} src={p.image} /></div>
      <div className="flex flex-col gap-3">
        {p.sold > 0 && <span className="flex"><Pill>{p.sold} sold</Pill></span>}
        <h1 className="text-[24px] font-bold tracking-tight text-ink">{p.title}</h1>
        {p.summary && <p className="text-[14px] leading-relaxed text-ink-3">{p.summary}</p>}
        <p className="text-[13px] text-ink-3">
          Weight {(p.weight_g / 1000).toFixed(1)} kg · ships worldwide
          {p.ship_from_coins != null && <> · shipping from ₳{p.ship_from_coins}</>}
        </p>
        {sourceHref && (
          <p className="text-[13px] text-ink-3">
            This is the hard copy of a work published on ArtaQuest —{" "}
            <Link className="font-semibold text-yin-light hover:underline" to={localePath(sourceHref)}>see the digital original (free) <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></Link>
          </p>
        )}
        <div className="mt-auto flex items-center gap-4 pt-3">
          <span className="text-[22px] font-bold text-ink">₳{p.price_coins}</span>
          <Button onClick={() => onAdd(p)} disabled={!p.available}>{p.available ? "Add to basket" : "Sold out"}</Button>
        </div>
      </div>
    </Card>
  );
}

export default function Shop() {
  const { id } = useParams();
  const logged = isLoggedIn();
  const [items, setItems] = useState<ShopProduct[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState("");
  const [basket, setBasketState] = useState<BasketLine[]>(readBasket);
  const [known, setKnown] = useState<Map<number, ShopProduct>>(new Map());
  const [placed, setPlaced] = useState<ShopOrder | null>(null);

  const setBasket = (b: BasketLine[]) => { setBasketState(b); writeBasket(b); };
  const remember = (ps: ShopProduct[]) =>
    setKnown((cur) => { const m = new Map(cur); ps.forEach((p) => m.set(p.id, p)); return m; });

  useEffect(() => {
    let live = true;
    setItems(null); setErr("");
    ShopApi.list()
      .then((r) => { if (live) { setItems(r.items); setNext(r.next); remember(r.items); } })
      .catch(() => { if (live) setErr("Could not load the Store"); });
    return () => { live = false; };
  }, []);

  // Basket lines can reference products outside the current page/tab — fetch any unknown ones.
  useEffect(() => {
    basket.filter((l) => !known.has(l.id)).forEach((l) => {
      ShopApi.get(l.id).then((p) => remember([p])).catch(() => setBasket(basket.filter((b) => b.id !== l.id)));
    });
  }, [basket, known]);

  function addToBasket(p: ShopProduct) {
    remember([p]);
    const cur = basket.find((l) => l.id === p.id);
    setBasket(cur ? basket.map((l) => l.id === p.id ? { ...l, qty: Math.min(99, l.qty + 1) } : l) : [...basket, { id: p.id, qty: 1 }]);
    setPlaced(null);
    document.getElementById("basket")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function more() {
    if (next == null) return;
    setLoadingMore(true);
    try {
      const r = await ShopApi.list({ cursor: next });
      setItems((cur) => [...(cur ?? []), ...r.items]);
      setNext(r.next);
      remember(r.items);
    } finally { setLoadingMore(false); }
  }

  const basketCount = useMemo(() => basket.reduce((s, l) => s + l.qty, 0), [basket]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <PageHero
        eyebrow="The ArtaQuest Foundation"
        title="Store"
        lede="Hard copies of what the studios make — printed books, games, illustration prints and merch — shipped worldwide. Shipping is charged at our carrier's real postal tariff, converted to gold-backed ArtaCoins at the live rate, with nothing added on top."
      />
      {basketCount > 0 && (
        <div className="-mb-3 flex justify-end">
          <a href="#basket" className="rounded-pill border border-line px-4 py-2 text-[14px] font-semibold text-ink no-underline hover:border-yin-light">Basket ({basketCount})</a>
        </div>
      )}

      {id ? (
        <ProductDetail id={Number(id)} onAdd={addToBasket} />
      ) : (
        <>
          {err && <StatusNote error>{err}</StatusNote>}
          {items === null ? (
            <SkeletonGrid count={8} />
          ) : items.length === 0 ? (
            <EmptyState title="Nothing on this shelf yet" body="The first hard copies are being prepared — check back soon." />
          ) : (
            <>
              <ul className="grid list-none grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {items.map((p) => <li key={p.id}><ProductCard p={p} onAdd={addToBasket} /></li>)}
              </ul>
              {next != null && <LoadMoreButton onClick={more} loading={loadingMore} />}
            </>
          )}
        </>
      )}

      {placed && (
        <StatusNote>
          Order #{placed.id} placed — ₳{placed.coins_total} paid from your wallet, confirmation and invoice sent to your inbox.
          {placed.service === "registered" ? " The tracking number will appear under Your orders (and land in your inbox) the moment it ships." : " It will travel by unregistered mail."}
        </StatusNote>
      )}

      <CheckoutPanel basket={basket} products={known} setBasket={setBasket} onOrdered={setPlaced} />

      {logged && <MyOrders refreshKey={placed?.id ?? 0} />}

    </div>
  );
}
