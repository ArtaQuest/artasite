import { useEffect, useState } from "react";
import { Books, Economy, type Statements, type BookInvoice, type CraPackage, type BookAmount, type GifiRow } from "../lib/api";
import { getCreatorStatus } from "../lib/wp";
import { isLoggedIn } from "../lib/auth";
import { Button, Card, Field, Input, Select } from "../components/ui";

/* Mirrors Books::GST_RATE_PCT. Copy rather than a fetched value on purpose: it labels a control the
   operator reads BEFORE submitting, and the server is the one that actually computes and posts the
   tax, so a stale copy here can misdescribe a rate but can never produce a wrong entry. */
const GST_PCT = 5;

/* Money on a financial statement always carries both decimal places, including on a round number —
   "CA$840" in a column of cents reads as a rounded figure rather than an exact one. */
const money = (cents: number, cur = "CAD") => {
  const v = (cents || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
};
/* A negative figure on a statement is written in parentheses, not with a minus sign. */
const acct = (cents: number, cur = "CAD") => (cents < 0 ? `(${money(-cents, cur)})` : money(cents, cur));
const bytes = (n: number) => (n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/**
 * What each ledger account means, said without accounting words.
 *
 * A published ledger only an accountant can read is not transparency, it is compliance with extra
 * steps. Every line on this page carries its plain meaning next to its number.
 */
const PLAIN: Record<string, string> = {
  cash: "Money in a Foundation bank account.",
  prepaid: "Subscription time already paid for but not yet used up at the year end.",
  due_director: "Money the Foundation owes a director who paid its bills out of their own pocket.",
  coin_liability: "ArtaCoin the Foundation has issued and is obliged to honour. A debt, not income.",
  deferred: "Money received for a period that has not run yet.",
  gst_payable: "Sales tax the Foundation owes CRA directly on services bought from abroad.",
  donations: "Gifts received.",
  grants_in: "Grants and subsidies received.",
  activity_revenue: "Earned by supplying something — including ArtaCoin spent on platform services.",
  software: "Subscriptions the platform runs on, including any tax that cannot be reclaimed.",
  office: "Office costs.",
  professional_fees: "Accountants, lawyers, auditors.",
  bank_charges: "Bank and payment-processing fees.",
  grants_out: "Bursaries and grants the Foundation has paid out.",
};

function Row({ label, cents, gifi, cur, strong, plain }: { label: string; cents: number; gifi?: string; cur: string; strong?: boolean; plain?: string }) {
  return (
    <div className={`border-b border-line/60 py-2.5 last:border-0 ${strong ? "font-semibold text-ink" : "text-ink-2"}`}>
      <div className="flex items-baseline justify-between gap-4">
        <span className="flex min-w-0 items-baseline gap-2">
          {/* Wrap rather than truncate. At 360px a GIFI row rendered as "Net inc…" next to a code
              and a figure, and on the year-end tab that label is the only thing carrying the
              meaning — there is no second copy of it anywhere on the page to recover it from. */}
          <span className="min-w-0 break-words">{label}</span>
          {gifi ? <span data-ay-skip="1" className="shrink-0 rounded bg-space-1 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-ink-3">GIFI {gifi}</span> : null}
        </span>
        <span data-ay-skip="1" className="shrink-0 tabular-nums">{acct(cents, cur)}</span>
      </div>
      {plain ? <p className="mt-0.5 max-w-[60ch] text-[12px] font-normal leading-snug text-ink-3">{plain}</p> : null}
    </div>
  );
}

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="mt-10">
      <h2 className="text-[19px] font-semibold text-ink">{title}</h2>
      {note ? <p className="mt-1 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-3">{note}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** One of the three headline figures. */
function BigNumber({ label, value, tone, plain }: { label: string; value: string; tone: "neutral" | "yang" | "yin"; plain: string }) {
  const colour = tone === "yang" ? "text-yang" : tone === "yin" ? "text-yin-light" : "text-ink";
  return (
    <div className="rounded-card border border-line bg-space-1 p-4">
      <p className="text-[12px] font-medium uppercase tracking-[0.1em] text-ink-3">{label}</p>
      <p data-ay-skip="1" className={`mt-1 text-[26px] font-semibold tabular-nums ${colour}`}>{value}</p>
      <p className="mt-1 text-[12.5px] leading-snug text-ink-3">{plain}</p>
    </div>
  );
}

/**
 * Operator-only: record a cost and its evidence.
 *
 * The figures are TYPED rather than read out of the PDF. In a PDF a space is usually positioning
 * rather than a character, so a parser recovers the glyphs but not the adjacency that binds the
 * word "Total" to the number beside it — and a bookkeeping total that is right most of the time
 * manufactures errors nobody finds until the year end.
 */
function RecordCost({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [f, setF] = useState({
    vendor: "", number: "", description: "", paid: "", issued: "",
    period_start: "", period_end: "", currency: "CAD", total: "", tax: "",
    account: "software", pay_method: "", note: "", payer_uid: "", imported_service: "",
  });
  const [invoicePdf, setInvoicePdf] = useState<File | null>(null);
  const [receiptPdf, setReceiptPdf] = useState<File | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit() {
    if (f.imported_service !== "true" && f.imported_service !== "false") {
      setMsg("Say whether the supplier is non-resident — it decides whether GST is self-assessed on this cost.");
      return;
    }
    setBusy(true); setMsg("");
    try {
      const r = await Books.addInvoice(f as unknown as Record<string, string>, invoicePdf || undefined, receiptPdf || undefined);
      setMsg(`Recorded — CA$${(r.cad_cents / 100).toFixed(2)}, ${r.documents} document(s) attached.`);
      setF({ vendor: "", number: "", description: "", paid: "", issued: "", period_start: "", period_end: "", currency: "CAD", total: "", tax: "", account: "software", pay_method: "", note: "", payer_uid: "", imported_service: "" });
      setInvoicePdf(null); setReceiptPdf(null);
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That cost could not be recorded.");
    } finally { setBusy(false); }
  }

  if (!open) {
    return <div className="mt-8"><Button variant="outline" onClick={() => setOpen(true)}>Record a cost</Button></div>;
  }
  return (
    <Card className="mt-8 p-5">
      <p className="text-[15px] font-semibold text-ink">Record a cost</p>
      <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-ink-3">
        Type the figures from the invoice and attach it. A cost that will not post to the ledger is not
        recorded at all — the register and the books move together or neither moves.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Vendor" required><Input value={f.vendor} onChange={set("vendor")} placeholder="Anthropic, PBC" /></Field>
        <Field label="Invoice number" required><Input value={f.number} onChange={set("number")} placeholder="6LNWF16Y-0009" /></Field>
        <Field label="Description"><Input value={f.description} onChange={set("description")} placeholder="Claude Max plan - 20x" /></Field>
        <Field label="Expense account">
          <Select value={f.account} onChange={(v) => setF((p) => ({ ...p, account: v }))}
            options={[
              { value: "software", label: "Computer and software subscriptions" },
              { value: "office", label: "Office expenses" },
              { value: "professional_fees", label: "Professional fees" },
              { value: "bank_charges", label: "Bank and payment charges" },
              { value: "grants_out", label: "Bursaries and grants paid" },
            ]} />
        </Field>
        <Field label="Date paid" required hint="YYYY-MM-DD"><Input value={f.paid} onChange={set("paid")} placeholder="2026-09-11" /></Field>
        <Field label="Date issued" optional hint="Defaults to the payment date"><Input value={f.issued} onChange={set("issued")} placeholder="2026-09-11" /></Field>
        <Field label="Service period start" optional><Input value={f.period_start} onChange={set("period_start")} placeholder="2026-09-11" /></Field>
        <Field label="Service period end" optional hint="Used for the year-end accrual"><Input value={f.period_end} onChange={set("period_end")} placeholder="2026-10-11" /></Field>
        <Field label="Currency" hint="Anything but CAD converts at the Bank of Canada rate for the payment date">
          <Input value={f.currency} onChange={set("currency")} placeholder="CAD" />
        </Field>
        <Field label="Total" required hint="As billed, in the invoice's own currency"><Input value={f.total} onChange={set("total")} placeholder="280.00" /></Field>
        <Field label="Tax included in the total" optional><Input value={f.tax} onChange={set("tax")} placeholder="0.00" /></Field>
        {/* A tax POSITION, so it is asked rather than guessed. Inferring it from the currency is wrong
            both ways round — a non-resident can invoice in CAD, a Canadian supplier can invoice in USD.
            The server refuses the invoice until this is answered, because the Foundation is not a
            GST/HST registrant: a non-resident charging 0% does not settle the tax, it makes the
            Foundation liable to self-assess it, and /finances publishes that this is accrued. */}
        <Field label="Supplier is non-resident" required
          hint={`An imported service self-assesses ${GST_PCT}% GST, posted as its own entry. The supplier charging 0% does not settle it.`}>
          <Select value={f.imported_service} onChange={(v) => setF((p) => ({ ...p, imported_service: v }))}
            options={[
              { value: "", label: "Choose…" },
              { value: "false", label: "No — Canadian supplier" },
              { value: "true", label: "Yes — imported service, self-assess GST" },
            ]} />
        </Field>
        <Field label="Payment method" optional><Input value={f.pay_method} onChange={set("pay_method")} placeholder="Visa ending 2178" /></Field>
        <Field label="Paid personally by (user id)" optional hint="Leave empty if the Foundation paid it directly">
          <Input value={f.payer_uid} onChange={set("payer_uid")} placeholder="138324856" />
        </Field>
        <Field label="Note" optional><Input value={f.note} onChange={set("note")} /></Field>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Invoice PDF" optional>
          <input type="file" accept="application/pdf" onChange={(e) => setInvoicePdf(e.target.files?.[0] ?? null)}
            className="block w-full text-[13px] text-ink-2 file:me-3 file:rounded file:border file:border-line file:bg-space-1 file:px-3 file:py-1.5 file:text-[13px] file:text-ink-2" />
        </Field>
        <Field label="Receipt PDF" optional>
          <input type="file" accept="application/pdf" onChange={(e) => setReceiptPdf(e.target.files?.[0] ?? null)}
            className="block w-full text-[13px] text-ink-2 file:me-3 file:rounded file:border file:border-line file:bg-space-1 file:px-3 file:py-1.5 file:text-[13px] file:text-ink-2" />
        </Field>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Button onClick={submit} disabled={busy || !f.vendor || !f.number || !f.paid || !f.total}>{busy ? "Recording…" : "Record it"}</Button>
        <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
        {msg ? <span className="text-[13px] text-ink-2">{msg}</span> : null}
      </div>
    </Card>
  );
}


/**
 * Operator-only: the two things the ledger cannot know.
 *
 * The signing officer's name and position are facts about a person; a filing date is a fact about
 * the world. The package prints blanks for the first until they are set, and the second is what
 * fixes the year end and arms the T1044 ratchet — so both are recorded rather than remembered.
 */
function FilingSettings({ st, onSaved }: { st: Statements; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [f, setF] = useState({ signer_last: "", signer_first: "", signer_role: "Director", signer_phone: "" });
  const [fy, setFy] = useState(st.statements.fy.label);
  const [form, setForm] = useState("t2");
  const [on, setOn] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function save(fields: Record<string, string>) {
    setBusy(true); setMsg("");
    try { await Books.settings(fields); setMsg("Saved."); onSaved(); }
    catch (e) { setMsg(e instanceof Error ? e.message : "That could not be saved."); }
    finally { setBusy(false); }
  }

  return (
    <Card className="mt-3 p-5">
      <p className="text-[15px] font-semibold text-ink">Filing details</p>
      <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-ink-3">
        Only the operator sees this. Everything else on the page comes from the ledger; these two do not.
      </p>
      <h3 className="mt-4 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Signing officer</h3>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <Field label="Last name (line 950)"><Input value={f.signer_last} onChange={set("signer_last")} /></Field>
        <Field label="First name (line 951)"><Input value={f.signer_first} onChange={set("signer_first")} /></Field>
        <Field label="Position, office or rank (line 954)"><Input value={f.signer_role} onChange={set("signer_role")} /></Field>
        <Field label="Telephone (line 956)"><Input value={f.signer_phone} onChange={set("signer_phone")} /></Field>
      </div>
      <div className="mt-3">
        <Button onClick={() => save(f)} disabled={busy}>{busy ? "Saving…" : "Save signing officer"}</Button>
      </div>

      <h3 className="mt-6 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Record a return as filed</h3>
      <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-3">
        Recording a T2 fixes the fiscal year end permanently. Recording a T1044 arms a one-way ratchet:
        CRA then requires one for every subsequent period, whatever the revenue. Only record what has
        actually been filed.
      </p>
      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        <Field label="Period">
          <Select value={fy} onChange={setFy} options={st.fiscal.years.map((y) => ({ value: y.label, label: y.label }))} />
        </Field>
        <Field label="Form">
          <Select value={form} onChange={setForm} options={[{ value: "t2", label: "T2" }, { value: "t1044", label: "T1044" }]} />
        </Field>
        <Field label="Date filed" optional hint="Defaults to today"><Input value={on} onChange={(e) => setOn(e.target.value)} placeholder="2027-06-15" /></Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="outline" onClick={() => save({ filed_fy: fy, filed_form: form, filed_on: on })} disabled={busy}>
          Record {form.toUpperCase()} for {fy} as filed
        </Button>
        {msg ? <span className="text-[13px] text-ink-2">{msg}</span> : null}
      </div>
    </Card>
  );
}

type Reserve = Awaited<ReturnType<typeof Economy.reserve>>;

export default function Finances() {
  const [st, setSt] = useState<Statements | null>(null);
  const [inv, setInv] = useState<BookInvoice[] | null>(null);
  const [cra, setCra] = useState<CraPackage | null>(null);
  const [res, setRes] = useState<Reserve | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"overview" | "statements" | "invoices" | "cra">("overview");
  const [fy, setFy] = useState("");
  /* Operator-only affordances hang off a PER-USER route, never off the public payload: the books
     GETs are edge-cacheable, so a capability flag baked into one of them would be handed to
     whoever asked next. */
  const [operator, setOperator] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!isLoggedIn()) return;
    getCreatorStatus().then((s) => setOperator(Boolean(s?.operator))).catch(() => setOperator(false));
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [s, i, c] = await Promise.all([Books.statements(fy), Books.invoices(), Books.cra(fy)]);
        if (!live) return;
        setSt(s); setInv(i.items); setCra(c);
      } catch {
        if (live) setErr("The books could not be loaded just now. Please try again shortly.");
      }
      // The reserve is a separate concern; a failure there must not blank the books.
      Economy.reserve().then((r) => { if (live) setRes(r); }).catch(() => {});
    })();
    return () => { live = false; };
  }, [fy, reload]);

  if (err) return <div className="mx-auto max-w-4xl px-4 py-16 text-[15px] text-ink-2">{err}</div>;
  if (!st) return <div className="mx-auto max-w-4xl px-4 py-16 text-[15px] text-ink-3">Opening the books…</div>;

  const cur = st.currency;
  const pos = st.statements.position;
  const ops = st.statements.operations;
  const failed = st.checks.filter((c) => !c.ok);
  const owed = pos.liabilities.filter((l) => l.cents !== 0);
  const totalCosts = inv ? inv.reduce((n, r) => n + r.cad_cents, 0) : 0;
  /* Income since incorporation, reported by the server. NOT derivable from the balance sheet:
     net assets is cumulative revenue less cumulative costs, so one figure cannot be recovered
     without the other. Deciding "nothing has ever come in" from the selected period would make
     the sentence reappear in the first year donations happen to stop. */
  const everReceived = st.statements.cumulative.revenue;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <header>
        <p className="text-[12.5px] font-semibold uppercase tracking-[0.14em] text-yang">Radical transparency</p>
        <h1 className="mt-2 text-[30px] font-semibold leading-tight text-ink sm:text-[36px]">The Foundation&rsquo;s books</h1>
        <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-ink-2">
          Every cent the Foundation has received or spent, published in full and in plain words. You do not
          have to take any figure here on trust: each one is the sum of ledger entries you can read, and every
          cost has the supplier&rsquo;s own invoice attached to it.
        </p>
      </header>

      {/* Whether a public ledger adds up is the first thing a sceptic wants and the last thing a
          summary usually tells them, so it goes at the top — and names what failed, not just that
          something did. */}
      <div className={`mt-8 rounded-card border p-4 ${failed.length ? "border-yang/50 bg-yang/5" : "border-line bg-space-1"}`}>
        <p className="text-[14px] font-semibold text-ink">
          {failed.length
            ? `${failed.length} of ${st.checks.length} arithmetic checks did not pass`
            : `All ${st.checks.length} arithmetic checks pass`}
        </p>
        <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-3">
          Recomputed on the server from the raw ledger entries — never stored as a total that could drift.
          Every entry balances, the statements tie to the entries, and the invoice register ties to the costs.
          These figures are cached at the edge for up to five minutes, so a change you have just made may take
          that long to appear here.
        </p>
        {failed.length ? <p className="mt-2 text-[13px] text-ink-2">{failed.map((f) => `${f.check.replace(/_/g, " ")}: ${f.detail}`).join(" · ")}</p> : null}
      </div>

      <nav className="mt-8 flex flex-wrap gap-1 border-b border-line" role="tablist">
        {([["overview", "In plain words"], ["statements", "Statements"], ["invoices", "Costs & invoices"], ["cra", "Year-end return"]] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-[14px] font-medium transition-colors ${tab === k ? "border-yang text-ink" : "border-transparent text-ink-3 hover:text-yin-light"}`}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            <BigNumber label="What it owns" value={money(pos.total_assets, cur)} tone="neutral"
              plain={pos.total_assets === 0 ? "No bank balance, no property, nothing." : "Cash, and anything paid for in advance."} />
            <BigNumber label="What it owes" value={money(pos.total_liabilities, cur)} tone="yang"
              plain="Debts the Foundation has to settle one day." />
            <BigNumber label="The difference" value={acct(pos.net_assets, cur)} tone="yin"
              plain={pos.net_assets < 0 ? "It owes more than it holds. That gap is the deficit." : "What would be left over."} />
          </div>

          <Section title="What this means">
            <Card className="p-5">
              {/* The liability is cumulative since incorporation; revenue and costs are this period
                  only. Narrating them in one breath reads as cause and effect and stops being true
                  the moment a second period exists — so the period is named, and the "nothing has
                  ever come in" claim is decided by the CUMULATIVE position, not by one year. */}
              <p className="max-w-[72ch] text-[15px] leading-relaxed text-ink-2">
                The Foundation holds <strong className="text-ink">{money(pos.total_assets, cur)}</strong> and owes{" "}
                <strong className="text-ink">{money(pos.total_liabilities, cur)}</strong> in total, counting everything
                since it was incorporated. In <span data-ay-skip="1">{st.statements.fy.label}</span> alone it spent{" "}
                <strong className="text-ink">{money(ops.total_expenses, cur)}</strong> running the platform and received{" "}
                <strong className="text-ink">{money(ops.total_revenue, cur)}</strong> in income.
                {everReceived === 0
                  ? " No donation has ever been recorded — everything so far has been paid for personally by a director, who is owed it back."
                  : ""}
              </p>
              <ul className="mt-4 grid gap-3">
                {owed.map((l) => (
                  <li key={l.account} className="flex items-baseline justify-between gap-4 border-b border-line/60 pb-3 last:border-0 last:pb-0">
                    <span className="min-w-0">
                      <span className="text-[14px] font-medium text-ink-2">{l.label}</span>
                      <span className="mt-0.5 block max-w-[58ch] text-[12.5px] leading-snug text-ink-3">{PLAIN[l.account] || ""}</span>
                    </span>
                    <span data-ay-skip="1" className="shrink-0 tabular-nums text-[15px] font-semibold text-ink">{money(l.cents, cur)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </Section>

          {res ? (
            <Section title="The coins, and the gold behind them"
              note="ArtaCoin is meant to be one milligram of gold each. Where it is not, this page says so rather than rounding the claim up.">
              <Card className="p-5">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div><p className="text-[12px] uppercase tracking-wide text-ink-3">Coins issued</p><p data-ay-skip="1" className="mt-1 text-[20px] font-semibold text-ink">{res.issued_coins.toLocaleString()} ₳</p></div>
                  <div><p className="text-[12px] uppercase tracking-wide text-ink-3">Gold held</p><p data-ay-skip="1" className="mt-1 text-[20px] font-semibold text-ink">{res.backing_mg.toLocaleString()} mg</p></div>
                  <div><p className="text-[12px] uppercase tracking-wide text-ink-3">Backed</p><p className={`mt-1 text-[20px] font-semibold ${res.backed ? "text-yin-light" : "text-yang"}`}>{res.backed ? "Fully" : "Not fully"}</p></div>
                </div>
                {res.shortfall_note ? <p className="mt-4 max-w-[72ch] text-[13.5px] leading-relaxed text-ink-2">{res.shortfall_note}</p> : null}
              </Card>
            </Section>
          ) : null}

          {st.fiscal.obligations.length > 0 ? (
            <Section title="What has to be done, and by when"
              note="Not all of it is tax, and the one that matters most is not. Each carries what happens if it is missed.">
              <div className="grid gap-3">
                {st.fiscal.obligations.map((o) => {
                  const overdue = !o.done && o.days < 0;
                  const soon = !o.done && o.days >= 0 && o.days <= 30;
                  return (
                    <Card key={o.key} className={`p-5 ${overdue || soon ? "border-yang/50" : ""}`}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-[15px] font-semibold text-ink">{o.title}</span>
                        <span data-ay-skip="1" className={`text-[13px] font-semibold ${o.done ? "text-ink-3" : overdue || soon ? "text-yang" : "text-ink-2"}`}>
                          {o.done ? `done ${o.done}` : overdue ? `${Math.abs(o.days)} days overdue` : `in ${o.days} days`}
                        </span>
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1 text-[12.5px] sm:grid-cols-3">
                        <div><dt className="text-ink-3">Due</dt><dd data-ay-skip="1" className="mt-0.5 text-ink-2">{o.due}</dd></div>
                        <div><dt className="text-ink-3">To</dt><dd className="mt-0.5 text-ink-2">{o.authority}</dd></div>
                        {o.amount !== null ? <div><dt className="text-ink-3">Amount</dt><dd data-ay-skip="1" className="mt-0.5 text-ink-2">{money(o.amount, cur)}</dd></div> : null}
                      </dl>
                      <p className={`mt-2 text-[13px] font-medium ${overdue || soon ? "text-yang" : "text-ink-2"}`}>{o.consequence}</p>
                      <p className="mt-1 max-w-[72ch] text-[12.5px] leading-relaxed text-ink-3">{o.detail}</p>
                    </Card>
                  );
                })}
              </div>
            </Section>
          ) : null}

          <Section title="Can I check this myself?" note="Yes, and without asking us for anything.">
            <Card className="p-5">
              <ul className="grid gap-3 text-[13.5px] leading-relaxed text-ink-2">
                <li><strong className="text-ink">Open the invoices.</strong> Every cost has the supplier&rsquo;s own PDF attached, published with the SHA-256 of its bytes, so you can confirm the file you downloaded is the file we recorded.</li>
                <li><strong className="text-ink">Read the ledger.</strong> The Statements tab shows every entry with both of its sides. Nothing is entered as a total; each total is the sum of the entries above it.</li>
                <li><strong className="text-ink">Re-run the arithmetic.</strong> <span data-ay-skip="1" className="text-ink-3">/wp-json/aq/v1/foundation/books/verify</span> recomputes every check from the raw lines. Add a unique query string to bypass the cache and force a fresh computation.</li>
                <li><strong className="text-ink">Query the raw tables.</strong> The whole database is public at <a href="/data/" className="text-yin-light hover:underline">/data</a>, including the four tables behind this page.</li>
              </ul>
            </Card>
          </Section>
        </>
      )}

      {tab === "statements" && (
        <>
          <div className="mt-8 flex flex-wrap items-center gap-3 text-[13px] text-ink-3">
            <span>Fiscal period</span>
            {st.fiscal.years.length > 1 ? (
              <select value={st.statements.fy.label} onChange={(e) => setFy(e.target.value)} aria-label="Fiscal period"
                className="rounded border border-line bg-space-1 px-2 py-1 text-[13px] font-semibold text-ink-2">
                {st.fiscal.years.map((y) => <option key={y.label} value={y.label}>{y.label}</option>)}
              </select>
            ) : <span data-ay-skip="1" className="font-semibold text-ink-2">{st.statements.fy.label}</span>}
            {/* bdi keeps the two dates in written order — the bidi algorithm otherwise swaps them
                around the arrow in every RTL locale, so the period reads end-first. */}
            <bdi data-ay-skip="1">{st.statements.fy.start} → {st.statements.fy.end}</bdi>
            <span>· return due <bdi data-ay-skip="1">{st.fiscal.filing_due}</bdi></span>
          </div>
          {/* A year end is fixed by the first T2 filed, so until then it is a choice on the record
              rather than a settled fact. Saying which it is stops a reader assuming the stronger one. */}
          <p className="mt-2 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-3">
            The financial year ends <strong className="text-ink-2">31 December</strong>
            {st.fiscal.year_end_chosen ? <> — chosen on <bdi data-ay-skip="1">{st.fiscal.year_end_chosen}</bdi></> : null}.{" "}
            {st.fiscal.year_end_settled
              ? "It became permanent when the first corporate return was filed."
              : "It becomes permanent when the first corporate return is filed; until then it can still be changed."}
          </p>

          <Section title="What it owns and owes" note={`At ${st.statements.fy.end}.`}>
            <Card className="p-5">
              <h3 className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Assets</h3>
              <div className="mt-2">
                {pos.assets.filter((a) => a.cents !== 0).map((a: BookAmount) => <Row key={a.account} label={a.label} cents={a.cents} gifi={a.gifi} cur={cur} plain={PLAIN[a.account]} />)}
                {pos.assets.every((a) => a.cents === 0) ? <p className="py-2 text-[13.5px] text-ink-3">None. The Foundation holds no cash — its costs have been met personally by a director.</p> : null}
                <Row label="Total assets" cents={pos.total_assets} cur={cur} strong />
              </div>
              <h3 className="mt-6 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Liabilities</h3>
              <div className="mt-2">
                {owed.map((a) => <Row key={a.account} label={a.label} cents={a.cents} gifi={a.gifi} cur={cur} plain={PLAIN[a.account]} />)}
                <Row label="Total liabilities" cents={pos.total_liabilities} cur={cur} strong />
              </div>
              <div className="mt-6"><Row label="Accumulated surplus / (deficit)" cents={pos.net_assets} gifi="3600" cur={cur} strong /></div>
              <p className="mt-3 text-[12.5px] text-ink-3">
                {pos.balances ? "Assets equal liabilities plus accumulated surplus, to the cent." : "These figures do not balance — that is a defect, and it is shown rather than hidden."}
              </p>
            </Card>
          </Section>

          <Section title="What came in and went out" note={`For ${st.statements.fy.label}.`}>
            <Card className="p-5">
              <h3 className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Income</h3>
              <div className="mt-2">
                {ops.revenue.filter((a) => a.cents !== 0).map((a) => <Row key={a.account} label={a.label} cents={a.cents} gifi={a.gifi} cur={cur} plain={PLAIN[a.account]} />)}
                {ops.revenue.every((a) => a.cents === 0) ? <p className="py-2 text-[13.5px] text-ink-3">Nothing received this period.</p> : null}
                <Row label="Total income" cents={ops.total_revenue} gifi="8299" cur={cur} strong />
              </div>
              <h3 className="mt-6 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Costs</h3>
              <div className="mt-2">
                {ops.expenses.filter((a) => a.cents !== 0).map((a) => <Row key={a.account} label={a.label} cents={a.cents} gifi={a.gifi} cur={cur} plain={PLAIN[a.account]} />)}
                <Row label="Total costs" cents={ops.total_expenses} gifi="9368" cur={cur} strong />
              </div>
              <div className="mt-6"><Row label={ops.result < 0 ? "Deficit for the period" : "Surplus for the period"} cents={ops.result} gifi="9970" cur={cur} strong /></div>
            </Card>
          </Section>

          <Section title="Every entry" note="The ledger itself. Dr is what a figure was added to, Cr is where it came from, and the two always match.">
            <div className="grid gap-3">
              {st.entries.map((e) => (
                <Card key={e.id} className="p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[14px] font-semibold text-ink">{e.memo}</span>
                    <span data-ay-skip="1" className="text-[12px] text-ink-3">{e.date} · {e.ref}</span>
                  </div>
                  <div className="mt-2 grid gap-1">
                    {e.lines.map((l, i) => (
                      <div key={i} className="flex items-baseline justify-between gap-4 text-[13px]">
                        <span className={l.debit ? "text-ink-2" : "ps-6 text-ink-3"}>
                          <span className="me-2 inline-block w-5 text-[11px] font-semibold tracking-wide text-ink-3">{l.debit ? "Dr" : "Cr"}</span>
                          {l.label}
                        </span>
                        <span className={`shrink-0 tabular-nums ${l.debit ? "text-ink-2" : "text-ink-3"}`}>
                          <span className="sr-only">{l.debit ? "debit" : "credit"} </span>
                          <span data-ay-skip="1">{money(l.debit || l.credit, cur)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          </Section>
        </>
      )}

      {tab === "invoices" && (
        <Section title="Costs and their invoices"
          note={`${inv?.length ?? 0} cost(s), ${money(totalCosts, cur)} in total. Every one carries the supplier's own document, published with the SHA-256 of its bytes.`}>
          <div className="grid gap-3">
            {(inv || []).map((r) => (
              <Card key={r.id} className="p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[15px] font-semibold text-ink"><span data-ay-skip="1">{r.vendor}</span> — {r.description}</span>
                  <span data-ay-skip="1" className="tabular-nums text-[15px] font-semibold text-ink">{money(r.cad_cents, cur)}</span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 text-[12.5px] sm:grid-cols-4">
                  <div><dt className="text-ink-3">Invoice</dt><dd data-ay-skip="1" className="mt-0.5 text-ink-2">{r.number}</dd></div>
                  <div><dt className="text-ink-3">Paid</dt><dd data-ay-skip="1" className="mt-0.5 text-ink-2">{r.paid}</dd></div>
                  <div><dt className="text-ink-3">Covers</dt><dd className="mt-0.5 text-ink-2"><bdi data-ay-skip="1">{r.period.start} → {r.period.end}</bdi></dd></div>
                  <div><dt className="text-ink-3">Paid with</dt><dd data-ay-skip="1" className="mt-0.5 text-ink-2">{r.pay_method || "—"}</dd></div>
                  {r.currency !== cur ? (
                    <>
                      <div><dt className="text-ink-3">Billed</dt><dd data-ay-skip="1" className="mt-0.5 text-ink-2">{money(r.total_cents, r.currency)}</dd></div>
                      <div><dt className="text-ink-3">Rate used</dt><dd data-ay-skip="1" className="mt-0.5 text-ink-2">{r.fx.rate.toFixed(4)} on {r.fx.date}</dd></div>
                    </>
                  ) : null}
                  {r.tax_cents ? <div><dt className="text-ink-3">Tax on the invoice</dt><dd data-ay-skip="1" className="mt-0.5 text-ink-2">{money(r.tax_cents, r.currency)}</dd></div> : null}
                </dl>
                {r.tax_note ? <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">{r.tax_note}</p> : null}
                {r.coin_basis ? (
                  <p className="mt-3 rounded-card border border-line bg-space-1 p-3 text-[12.5px] leading-relaxed text-ink-3">
                    Repaid with <span data-ay-skip="1" className="font-semibold text-ink-2">{r.coins.toLocaleString()} ₳</span> at{" "}
                    <span data-ay-skip="1">{r.coin_basis.price_cad.toFixed(4)} {cur}</span> each — the coin price on the day this was paid, from gold at{" "}
                    <span data-ay-skip="1">${r.coin_basis.gold_oz_usd.toLocaleString()}/oz</span> and USD/CAD{" "}
                    <span data-ay-skip="1">{r.coin_basis.usdcad.toFixed(4)}</span>. <span data-ay-skip="1">{r.coin_basis.source}</span>
                  </p>
                ) : null}
                {r.note ? <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">{r.note}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.documents.map((d) => (
                    <a key={d.id} href={d.url}
                      className="group inline-flex items-baseline gap-2 rounded-card border border-line px-3 py-2 text-[12.5px] text-ink-2 transition-colors hover:border-yin-light hover:text-yin-light">
                      <span className="font-medium capitalize">{d.kind}</span>
                      <span data-ay-skip="1" className="text-ink-3 group-hover:text-yin-light">{bytes(d.bytes)}</span>
                      <span data-ay-skip="1" className="hidden font-mono text-[10px] text-ink-3 sm:inline">{d.sha256.slice(0, 12)}…</span>
                    </a>
                  ))}
                </div>
              </Card>
            ))}
            {inv && inv.length === 0 ? <p className="text-[14px] text-ink-3">No costs recorded yet.</p> : null}
          </div>
          {operator ? <RecordCost onSaved={() => setReload((n) => n + 1)} /> : null}
        </Section>
      )}

      {tab === "cra" && cra && (
        <>
          <Section title="Year-end return"
            note="Prepared from the ledger above, automatically, as soon as a fiscal period closes. This prepares a return; it does not file one.">
            <Card className="p-5">
              <p className="text-[14px] font-semibold text-ink">T2 Corporation Income Tax Return — required</p>
              <p className="mt-1 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-2">{cra.t2.why}</p>
              <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-[13px] sm:grid-cols-3">
                <div><dt className="text-ink-3">Form</dt><dd data-ay-skip="1" className="mt-0.5 font-semibold text-ink-2">{cra.t2.form}</dd></div>
                <div><dt className="text-ink-3">Period</dt><dd data-ay-skip="1" className="mt-0.5 font-semibold text-ink-2">{cra.fy.label}</dd></div>
                <div><dt className="text-ink-3">Due</dt><dd data-ay-skip="1" className="mt-0.5 font-semibold text-ink-2">{cra.t2.due}</dd></div>
              </dl>
              <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">{cra.t2.form_why}</p>
              <ul className="mt-3 grid gap-1 text-[13px] text-ink-2">{cra.t2.schedules.map((s) => <li key={s}>· {s}</li>)}</ul>
              <div className="mt-5 border-t border-line pt-4">
                <div className="flex flex-wrap gap-2">
                  <Button href={Books.packageUrl(cra.fy.label)}>Download the filing package (PDF)</Button>
                  {operator ? <Button variant="outline" href={Books.filingCopyUrl(cra.fy.label)}>Operator copy — to file</Button> : null}
                </div>
                <p className="mt-2 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-3">
                  Every figure below, plus the T2 Short line numbers to transcribe, the GIFI schedules, the
                  statements, the notes, the invoice register with each document&rsquo;s hash, and the GST
                  working. Generated from the ledger — nothing in it has been filed. The signing
                  officer&rsquo;s telephone number is masked on this public copy; the operator&rsquo;s copy
                  carries it in full and is the one to file.
                </p>
              </div>
            </Card>
            <Card className="mt-3 p-5">
              <p className="text-[14px] font-semibold text-ink">T1044 NPO Information Return — {cra.t1044.required ? "required" : "not required for this period"}</p>
              <ul className="mt-3 grid gap-2 text-[13px]">
                {cra.t1044.tests.map((t) => (
                  <li key={t.test} className="flex items-baseline gap-2">
                    <span className={t.met ? "text-yang" : "text-ink-3"}>{t.met ? "MET" : "—"}</span>
                    <span className="text-ink-2">{t.test}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-3">{cra.t1044.warning}</p>
            </Card>
            {Object.keys(st.fiscal.filings).length > 0 ? (
              <Card className="mt-3 p-5">
                <p className="text-[14px] font-semibold text-ink">Filed</p>
                <ul className="mt-2 grid gap-1 text-[13px] text-ink-2">
                  {Object.entries(st.fiscal.filings).map(([period, v]) => (
                    <li key={period} data-ay-skip="1">
                      {period}: {v.t2 ? `T2 filed ${v.t2}` : "T2 not recorded"}{v.t1044 ? ` · T1044 filed ${v.t1044}` : ""}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            {st.fiscal.archives.length > 0 ? (
              <Card className="mt-3 p-5">
                <p className="text-[14px] font-semibold text-ink">Frozen packages</p>
                <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-3">
                  Generated automatically when a period closed and stored unchanged since, each with the
                  SHA-256 of its bytes. These are the documents as they stood at filing time — the live
                  download above reflects the ledger as it is now.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {st.fiscal.archives.map((a) => (
                    <a key={a.id} href={a.url}
                      className="group inline-flex items-baseline gap-2 rounded-card border border-line px-3 py-2 text-[12.5px] text-ink-2 transition-colors hover:border-yin-light hover:text-yin-light">
                      <span data-ay-skip="1" className="font-medium">{a.name}</span>
                      <span data-ay-skip="1" className="text-ink-3 group-hover:text-yin-light">{bytes(a.bytes)}</span>
                      <span data-ay-skip="1" className="hidden font-mono text-[10px] text-ink-3 sm:inline">{a.sha256.slice(0, 12)}…</span>
                    </a>
                  ))}
                </div>
              </Card>
            ) : null}
            {operator ? <FilingSettings st={st} onSaved={() => setReload((n) => n + 1)} /> : null}
          </Section>

          <Section title="The same figures, in CRA's codes" note="What the return actually carries. Every code is the official one from Guide RC4088.">
            <Card className="p-5">
              <h3 className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Schedule 100 — balance sheet</h3>
              <div className="mt-2">{cra.schedule_100.map((r: GifiRow, i) => <Row key={`${r.gifi}-${i}`} label={r.label} cents={r.cents} gifi={r.gifi} cur={cur} />)}</div>
              <h3 className="mt-6 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Schedule 125 — income statement</h3>
              <div className="mt-2">{cra.schedule_125.map((r, i) => <Row key={`${r.gifi}-${i}`} label={r.label} cents={r.cents} gifi={r.gifi} cur={cur} />)}</div>
            </Card>
          </Section>

          <Section title="Notes to the accounts">
            <div className="grid gap-3">
              {cra.notes.map((n) => (
                <Card key={n.title} className="p-5">
                  <p className="text-[14px] font-semibold text-ink">{n.title}</p>
                  <p className="mt-1.5 max-w-[72ch] text-[13.5px] leading-relaxed text-ink-2">{n.body}</p>
                </Card>
              ))}
            </div>
          </Section>
        </>
      )}

      <p className="mt-12 max-w-[72ch] border-t border-line pt-6 text-[12.5px] leading-relaxed text-ink-3">
        <span data-ay-skip="1">{st.entity.name}</span> is a Canadian non-profit corporation, registered as{" "}
        <span data-ay-skip="1">BN {st.entity.bn}</span> and incorporated on <span data-ay-skip="1">{st.entity.incorporated}</span>.{" "}
        {st.entity.receipts_note}
      </p>
    </div>
  );
}
