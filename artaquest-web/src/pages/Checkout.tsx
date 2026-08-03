import { type FormEvent, useEffect, useState } from "react";
import { localePath, getCourse, getDonateOptions, postCourseCheckout, getStripeVerify, type CourseDetail, type DonateOptions, type CheckoutResult } from "../lib/wp";
import { getCart, clearCart, type CartItem } from "../lib/cart";
import { Coins, formatFiat } from "../lib/currency";
import { BackLink, Button, Card, ErrorNote, Field, GatewayPicker, Input, StatusNote } from "../components/ui";
import { WithRail, RailInline } from "../components/PageRail";

// This page settles FIAT. In the Arta Coin model that means: (a) donations from the cart
// (converted to gold-backed coins for the foundation fund), and (b) the legacy "buy now" link
// for a paid course — which is now redirected to the course page, because courses are enrolled
// with coins, not fiat. Already-enrolled learners pass straight through to "continue learning".
const money = (n?: number, c?: string) => formatFiat(n || 0, c || "CAD");

// Payment-method-neutral descriptions keyed by gateway id (the stored donate-options copy is
// donation-flavoured; this keeps it correct for any fiat flow). Falls back to the raw desc.
const GATEWAY_DESC: Record<string, string> = {
  ay_interac: "Pay by Interac e-Transfer (Canada). We confirm receipt within 1–2 business days.",
  ay_fast: "Pay by FAST transfer (Türkiye). We confirm receipt within 1–2 business days.",
  ay_iban: "Pay by bank transfer (IBAN). We confirm receipt within 1–2 business days.",
  ay_stripe: "Pay by credit or debit card. A small processing fee is added.",
};

export default function Checkout() {
  const slug = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("course") || "" : "";
  const cartMode = !slug;
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [cart] = useState<CartItem[]>(() => (slug ? [] : getCart()));
  const [opts, setOpts] = useState<DonateOptions | null>(null);
  const [optsFailed, setOptsFailed] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [gateway, setGateway] = useState("");
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [resultIsGift, setResultIsGift] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (slug) getCourse(slug).then(setCourse);
    getDonateOptions().then((o) => { if (o) { setOpts(o); if (o.gateways[0]) setGateway(o.gateways[0].id); } else setOptsFailed(true); }).catch(() => setOptsFailed(true));
  }, [slug]);

  // Returning from Stripe Checkout: verify the session server-side, then show the result.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const st = sp.get("stripe");
    if (st === "success") {
      const session = sp.get("session") || "";
      if (session) {
        getStripeVerify(session).then((v) => {
          if (v?.paid) {
            clearCart();
            setResultIsGift(/donation/i.test(v.course || ""));
            setResult({ ok: true, order: v.order, total: v.total, currency: "CAD", total_display: formatFiat(v.total, "CAD"), course: v.course, gateway: "Card (Stripe)", instructions: "" });
          } else {
            setErr("We couldn't confirm your card payment. If you were charged, contact us with your order number.");
          }
        });
      }
    } else if (st === "cancel") {
      setErr("Card payment cancelled — your cart is intact. You can try again or pick another method.");
    }
  }, []);

  // The cart only ever holds donations now (courses enrol off-cart with coins). Treat a cart
  // checkout as a gift; keep the course branch only for the legacy single-course flow.
  const isGift = cartMode && cart.length > 0 && cart.every((i) => i.kind === "donation");
  const cur = (slug ? course?.currency : cart[0]?.currency) || opts?.currency || "CAD";
  const lines = slug ? (course ? [{ slug, title: course.title, price: course.price }] : []) : cart.map((i) => ({ slug: i.slug, title: i.title, price: i.price }));
  const total = lines.reduce((s, l) => s + (l.price || 0), 0);
  // Gold-backed coins a fiat gift mints (amount ÷ coin buy price) — shown on the gift summary.
  const giftCoins = opts?.coin_buy_price ? Math.round(total / opts.coin_buy_price) : 0;
  const bursaryUrl = course?.bursary_url || "/user-account/?acct=bursary";
  const noRails = !!opts && opts.gateways.length === 0;

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      // The cart only ever holds donations (courses enrol off-cart with coins), so a cart checkout
      // is purely a basket of gifts → the backend records each into the fund (Extra::course_checkout).
      const donations = cart.filter((i) => i.kind === "donation").map((i) => ({ amount: i.price, countries: i.meta?.countries || [], groups: i.meta?.groups || [], topics: i.meta?.topics || [] }));
      const body = slug ? { slug, email, name, gateway } : { donations, email, name, gateway };
      const r = await postCourseCheckout(body);
      if (r.redirect && r.url) { window.location.href = r.url; return; }
      if (r.already && r.url) { window.location.href = r.url; return; }
      if (cartMode) clearCart();
      setResultIsGift(isGift);
      setResult(r);
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "Could not start checkout."); }
    finally { setBusy(false); }
  }

  if (cartMode && cart.length === 0 && !result) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-yang/15 text-yang">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 6h15l-1.5 9h-12zM6 6 5 3H2" /><circle cx="9" cy="20" r="1" /><circle cx="18" cy="20" r="1" /></svg>
        </span>
        <h1 className="mt-4 text-[24px] font-bold tracking-tight">Your cart is empty</h1>
        <p className="mt-2 text-[15px] text-ink-2">Make a donation to support learners, or find a course to start.</p>
        <div className="mt-6 flex justify-center gap-3">
          <Button href="/donate/" className="h-11 px-6 text-[15px]">Make a donation</Button>
          <Button variant="outline" href="/courses/" className="h-11 px-6 text-[14px]">Browse courses</Button>
        </div>
      </div>
    );
  }

  if (result) {
    const amount = result.total_display || money(result.total, result.currency);
    return (
      <div role="status" className="mx-auto max-w-lg py-10 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-yang/15 text-yang">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
        <h1 className="mt-4 text-[26px] font-bold tracking-tight">Order #{result.order} — {result.instructions ? "almost there" : "thank you"}</h1>
        {result.instructions ? (
          <p className="mt-2 text-[15px] text-ink-2">Complete your {amount} payment via {result.gateway}. We confirm receipt within 1–2 business days{resultIsGift ? ", then convert it to gold-backed Arta Coins for the fund" : " and enrol you"}.</p>
        ) : resultIsGift ? (
          <p className="mt-2 text-[15px] text-ink-2">Payment received — thank you. Your {amount} gift is now held as gold-backed Arta Coins for learners, ready to be issued when a candidate needs it.</p>
        ) : (
          <p className="mt-2 text-[15px] text-ink-2">Payment received — your {amount} order is confirmed{result.course ? <> for <strong className="text-ink">{result.course}</strong></> : null} and you’re enrolled. Welcome aboard.</p>
        )}
        {result.instructions && <Card className="mt-5 whitespace-pre-line px-5 py-4 text-left text-[15px] leading-relaxed text-ink-2">{result.instructions}</Card>}
        <div className="mt-6 flex justify-center gap-3">
          {resultIsGift
            ? <Button variant="outline" href="/donate/" className="h-11 px-6 text-[14px]">See the books</Button>
            : <Button variant="outline" href="/courses/" className="h-11 px-6 text-[14px]">More courses</Button>}
          <Button href="/" className="h-11 px-6 text-[14px]">Home</Button>
        </div>
      </div>
    );
  }

  if (slug && !course) return <StatusNote className="py-16 text-[15px]">Loading…</StatusNote>;

  // Already enrolled: nothing to charge — one-click resume.
  if (slug && course && course.has_access) {
    return (
      <div className="mx-auto max-w-lg py-10 text-center">
        <BackLink href={`/courses/${slug}/`}>Back to course</BackLink>
        <span className="mx-auto mt-4 grid h-14 w-14 place-items-center rounded-full bg-yang/15 text-yang">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
        </span>
        <h1 className="mt-4 text-[26px] font-bold tracking-tight">You’re enrolled</h1>
        <p className="mx-auto mt-2 max-w-sm text-[15px] text-ink-2"><strong className="text-ink">{course.title}</strong> is already in your library — pick up where you left off.</p>
        <div className="mt-6 flex justify-center gap-3">
          <Button href={course.start_url || course.url} className="h-11 px-6 text-[15px]">Continue learning</Button>
          <Button variant="outline" href="/courses/" className="h-11 px-6 text-[14px]">More courses</Button>
        </div>
      </div>
    );
  }

  // Enrolment is an entry fee paid on the course page (it funds the prize pool the best questers win).
  // If the fee is a barrier, the Grants programme covers it for learners in a funded group.
  if (slug && course) {
    return (
      <div className="mx-auto max-w-lg py-10 text-center">
        <h1 className="text-[26px] font-bold tracking-tight">Enrol from the course page</h1>
        <p className="mx-auto mt-2 max-w-sm text-[15px] text-ink-2">Watching <strong className="text-ink">{course.title}</strong> is free. Joining its competition costs {course.price_display && !/free/i.test(course.price_display) ? <><strong className="text-ink">{course.price_display}</strong></> : "1 coin per video"} — that fee funds the seasonal prize pool, and the best-voted questers win it back and more. Can’t cover it? The Sponsors programme may fund it for your group.</p>
        <div className="mt-6 flex justify-center gap-3">
          <Button href={`/courses/${slug}/`} className="h-11 px-6 text-[15px]">Go to the course</Button>
          <Button variant="outline" href="/sponsors/" className="h-11 px-6 text-[14px]">Sponsors &amp; bursaries</Button>
        </div>
      </div>
    );
  }

  // What you are paying for, defined ONCE. On desktop it rides the rail beside the form (it is
  // context for the fields, not a step in them); below lg the rail leaves the flow and the SAME
  // element renders inline exactly where it used to sit. Two copies would drift.
  const summary = (
    <Card className="flex flex-col gap-2 p-4">
      {/* The COUNT is skipped, the noun is not. Skipping the whole heading kept a runtime number out
          of the i18n mesh (correct) but also froze "Donation" and "Course" out of ~133 languages. */}
      <h2 className="text-sm font-bold uppercase tracking-wider text-ink-3">
        {lines.length > 1 ? <><span data-ay-skip="1">{lines.length}</span> {isGift ? "donations" : "courses"}</> : (isGift ? "Donation" : "Course")}
      </h2>
      <ul className="flex flex-col gap-1.5">
        {lines.length === 0 ? <li className="text-[15px] text-ink-3">Loading…</li> : lines.map((l) => (
          <li key={l.slug} data-ay-skip="1" className="flex items-center justify-between gap-3 text-[15px]"><span className="min-w-0 truncate text-ink">{l.title}</span><span className="shrink-0 font-semibold tabular-nums text-yang">{money(l.price, cur)}</span></li>
        ))}
      </ul>
      {lines.length > 1 && <div className="flex items-center justify-between border-t border-line pt-2 text-[15px] font-bold"><span>Total</span><span data-ay-skip="1" className="tabular-nums text-yang">{money(total, cur)}</span></div>}
      {/* For a gift, show the gold-backed coins it mints — consistent with the Donate + Cart pages. */}
      {isGift && giftCoins > 0 && (
        <p className="border-t border-line pt-2 text-[13px] text-ink-3">Becomes ≈ <span data-ay-skip="1" className="font-semibold text-yang"><Coins n={giftCoins} /></span> held for learners.</p>
      )}
    </Card>
  );

  return (
    <WithRail label="Order summary" rail={summary}>
    <div className="mx-auto max-w-lg py-8">
      <BackLink href="/cart/">Back to cart</BackLink>
      <h1 className="mt-3 text-[30px] font-bold tracking-tight">{isGift ? "Complete your gift" : "Checkout"}</h1>
      <p className="mt-2 text-[15px] text-ink-2">{isGift
        ? "Your gift is converted to gold-backed Arta Coins and held for learners in the country and group you chose — issued when a candidate needs it."
        : "Secure checkout. Bank transfers are confirmed within 1–2 business days."}</p>

      {/* Below lg the rail is out of the flow, so the summary rides here — the margin lives INSIDE
          RailInline so it leaves no gap on desktop. */}
      <RailInline><div className="mt-5">{summary}</div></RailInline>

      {optsFailed ? (
        <Card className="mt-5 p-5 text-center"><p className="text-[14px] text-ink-2">We couldn’t load the payment options. Please refresh, or try again shortly.</p></Card>
      ) : noRails ? (
        <Card className="mt-5 p-5 text-center">
          <h2 className="text-[17px] font-bold">Online payment isn’t available where you are</h2>
          <p className="mt-2 text-[14px] text-ink-2">Card payments don’t operate in your country and we don’t have a local transfer for it yet. {isGift ? "Try again later, or " : "Apply for a bursary and we’ll waive the cost in full — usually within a day. "}{!isGift && <>Learning should never wait on money.</>}</p>
          {!isGift && <Button href={bursaryUrl} className="mt-4 h-11 px-6 text-[15px]">Apply for a bursary</Button>}
        </Card>
      ) : (
      <form onSubmit={submit} className="mt-5 flex flex-col gap-5">
        <Field label="Name" optional>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={<>Email <span className="font-normal text-ink-3">— for your receipt (optional; we’ll use your account email)</span></>}>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" placeholder="you@example.com" />
        </Field>
        <GatewayPicker gateways={opts?.gateways || []} value={gateway} onChange={setGateway} descriptions={GATEWAY_DESC} labelId="aq-pay-method-label" />
        {err && <ErrorNote>{err}</ErrorNote>}
        <Button type="submit" disabled={busy || lines.length === 0} className="h-12 w-full text-[16px] disabled:opacity-50">{busy ? "Processing…" : `${isGift ? "Donate" : "Pay"} — ${money(total, cur)}`}</Button>
        <p className="text-center text-[12px] text-ink-3">Bank transfers (Interac/FAST/IBAN) are fee-free; card payment adds the processor fee.{!isGift && <> Can’t pay? <a href={localePath(bursaryUrl)} className="text-yang hover:underline">Apply for a bursary</a>.</>}</p>
      </form>
      )}
    </div>
    </WithRail>
  );
}
