import { useEffect, useState } from "react";
import { Books, type Statements, type BookInvoice, type CraPackage, type BookAmount, type GifiRow } from "../lib/api";
import { Card } from "../components/ui";

/* Money on a financial statement always carries both decimal places, including on a round number —
   "CA$840" in a column of cents reads as a rounded figure rather than an exact one. formatFiat drops
   them on integers, which is right for a price and wrong here. */
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

function Row({ label, cents, gifi, cur, strong }: { label: string; cents: number; gifi?: string; cur: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 border-b border-line/60 py-2 last:border-0 ${strong ? "font-semibold text-ink" : "text-ink-2"}`}>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate">{label}</span>
        {gifi ? <span data-ay-skip="1" className="shrink-0 rounded bg-space-1 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-ink-3">GIFI {gifi}</span> : null}
      </span>
      <span data-ay-skip="1" className="shrink-0 tabular-nums">{acct(cents, cur)}</span>
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

export default function Finances() {
  const [st, setSt] = useState<Statements | null>(null);
  const [inv, setInv] = useState<BookInvoice[] | null>(null);
  const [cra, setCra] = useState<CraPackage | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"statements" | "invoices" | "cra">("statements");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [s, i, c] = await Promise.all([Books.statements(), Books.invoices(), Books.cra()]);
        if (!live) return;
        setSt(s); setInv(i.items); setCra(c);
      } catch {
        if (live) setErr("The books could not be loaded just now. Please try again shortly.");
      }
    })();
    return () => { live = false; };
  }, []);

  if (err) return <div className="mx-auto max-w-4xl px-4 py-16 text-[15px] text-ink-2">{err}</div>;
  if (!st) return <div className="mx-auto max-w-4xl px-4 py-16 text-[15px] text-ink-3">Opening the books…</div>;

  const cur = st.currency;
  const pos = st.statements.position;
  const ops = st.statements.operations;
  const failed = st.checks.filter((c) => !c.ok);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <header>
        <p className="text-[12.5px] font-semibold uppercase tracking-[0.14em] text-yang">Radical transparency</p>
        <h1 className="mt-2 text-[30px] font-semibold leading-tight text-ink sm:text-[36px]">The Foundation&rsquo;s books</h1>
        <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-ink-2">
          Every cent the Foundation has spent or received, kept as double entry and published whole — the statements,
          the invoice register with every supporting document, and the year-end return prepared straight from the same
          numbers. Nothing here is a summary you have to take on trust: each figure is the sum of ledger lines you can
          read yourself.
        </p>
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 text-[13.5px] sm:grid-cols-4">
          <div><dt className="text-ink-3">Entity</dt><dd data-ay-skip="1" className="mt-0.5 font-semibold text-ink-2">{st.entity.name}</dd></div>
          <div><dt className="text-ink-3">Business number</dt><dd data-ay-skip="1" className="mt-0.5 font-semibold text-ink-2">{st.entity.bn}</dd></div>
          <div><dt className="text-ink-3">Incorporated</dt><dd data-ay-skip="1" className="mt-0.5 font-semibold text-ink-2">{st.entity.incorporated}</dd></div>
          <div><dt className="text-ink-3">Fiscal period</dt><dd data-ay-skip="1" className="mt-0.5 font-semibold text-ink-2">{st.statements.fy.start} → {st.statements.fy.end}</dd></div>
        </dl>
      </header>

      {/* The single most important thing a reader of a public ledger wants to know is whether it
          adds up. So it goes first, and it says which check failed rather than only that one did. */}
      <div className={`mt-8 rounded-card border p-4 ${failed.length ? "border-yang/50 bg-yang/5" : "border-line bg-space-1"}`}>
        <p className="text-[14px] font-semibold text-ink">
          {failed.length ? `${failed.length} of ${st.checks.length} checks did not pass` : `All ${st.checks.length} checks pass`}
        </p>
        <ul className="mt-2 grid gap-1 text-[13px] text-ink-3 sm:grid-cols-2">
          {st.checks.map((c) => (
            <li key={c.check} className="flex items-baseline gap-2">
              <span className={c.ok ? "text-yin-light" : "text-yang"}>{c.ok ? "✓" : "✕"}</span>
              <span data-ay-skip="1">{c.check.replace(/_/g, " ")}</span>
            </li>
          ))}
        </ul>
        {failed.length ? <p className="mt-2 text-[13px] text-ink-2">{failed.map((f) => f.detail).join(" · ")}</p> : null}
      </div>

      <nav className="mt-8 flex gap-1 border-b border-line" role="tablist">
        {([["statements", "Statements"], ["invoices", "Invoices"], ["cra", "Year-end return"]] as const).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-[14px] font-medium transition-colors ${tab === k ? "border-yang text-ink" : "border-transparent text-ink-3 hover:text-yin-light"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "statements" && (
        <>
          <Section title="Statement of financial position" note={`What the Foundation owns and owes at ${st.statements.fy.end}.`}>
            <Card className="p-5">
              <h3 className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Assets</h3>
              <div className="mt-2">
                {pos.assets.filter((a) => a.cents !== 0).map((a: BookAmount) => <Row key={a.account} label={a.label} cents={a.cents} gifi={a.gifi} cur={cur} />)}
                {pos.assets.every((a) => a.cents === 0) ? <p className="py-2 text-[13.5px] text-ink-3">None. The Foundation holds no cash — its costs have been met personally by a director.</p> : null}
                <Row label="Total assets" cents={pos.total_assets} cur={cur} strong />
              </div>

              <h3 className="mt-6 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Liabilities</h3>
              <div className="mt-2">
                {pos.liabilities.filter((a) => a.cents !== 0).map((a) => <Row key={a.account} label={a.label} cents={a.cents} gifi={a.gifi} cur={cur} />)}
                <Row label="Total liabilities" cents={pos.total_liabilities} cur={cur} strong />
              </div>

              <div className="mt-6">
                <Row label="Accumulated surplus / (deficit)" cents={pos.net_assets} gifi="3600" cur={cur} strong />
              </div>
              <p className="mt-3 text-[12.5px] text-ink-3">
                {pos.balances
                  ? "Assets equal liabilities plus accumulated surplus, to the cent."
                  : "These figures do not balance — that is a defect, and it is shown rather than hidden."}
              </p>
            </Card>
          </Section>

          <Section title="Statement of operations" note={`Income and costs for ${st.statements.fy.label}.`}>
            <Card className="p-5">
              <h3 className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Revenue</h3>
              <div className="mt-2">
                {ops.revenue.filter((a) => a.cents !== 0).map((a) => <Row key={a.account} label={a.label} cents={a.cents} gifi={a.gifi} cur={cur} />)}
                {ops.revenue.every((a) => a.cents === 0) ? <p className="py-2 text-[13.5px] text-ink-3">No revenue this period.</p> : null}
                <Row label="Total revenue" cents={ops.total_revenue} gifi="8299" cur={cur} strong />
              </div>
              <h3 className="mt-6 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Expenses</h3>
              <div className="mt-2">
                {ops.expenses.filter((a) => a.cents !== 0).map((a) => <Row key={a.account} label={a.label} cents={a.cents} gifi={a.gifi} cur={cur} />)}
                <Row label="Total expenses" cents={ops.total_expenses} gifi="9368" cur={cur} strong />
              </div>
              <div className="mt-6">
                <Row label={ops.result < 0 ? "Deficit for the period" : "Surplus for the period"} cents={ops.result} gifi="9970" cur={cur} strong />
              </div>
            </Card>
          </Section>

          <Section title="The journal" note="Every entry, with both sides. This is the ledger itself, not a rendering of it.">
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
                        <span className={l.debit ? "text-ink-2" : "pl-6 text-ink-3"}>{l.label}</span>
                        <span data-ay-skip="1" className="shrink-0 tabular-nums text-ink-2">
                          {l.debit ? money(l.debit, cur) : <span className="text-ink-3">{money(l.credit, cur)}</span>}
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
        <Section
          title="Invoice register"
          note="Every cost, with the document behind it. Each file is published with the SHA-256 of its bytes, so you can check that what you downloaded is what we recorded."
        >
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
                  <div><dt className="text-ink-3">Service period</dt><dd data-ay-skip="1" className="mt-0.5 text-ink-2">{r.period.start} → {r.period.end}</dd></div>
                  <div><dt className="text-ink-3">Method</dt><dd data-ay-skip="1" className="mt-0.5 text-ink-2">{r.pay_method || "—"}</dd></div>
                </dl>
                {r.tax_note ? <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">{r.tax_note}</p> : null}
                {r.coin_basis ? (
                  <p className="mt-3 rounded-card border border-line bg-space-1 p-3 text-[12.5px] leading-relaxed text-ink-3">
                    Settled with <span data-ay-skip="1" className="font-semibold text-ink-2">{r.coins.toLocaleString()} ₳</span> at{" "}
                    <span data-ay-skip="1">{r.coin_basis.price_cad.toFixed(4)} {cur}</span> each — the coin price on{" "}
                    <span data-ay-skip="1">{r.coin_basis.rate_date}</span>, from gold at{" "}
                    <span data-ay-skip="1">${r.coin_basis.gold_oz_usd.toLocaleString()}/oz</span> and USD/CAD{" "}
                    <span data-ay-skip="1">{r.coin_basis.usdcad.toFixed(4)}</span>. <span data-ay-skip="1">{r.coin_basis.source}</span>
                  </p>
                ) : null}
                {r.note ? <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">{r.note}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.documents.map((d) => (
                    <a
                      key={d.id}
                      href={d.url}
                      className="group inline-flex items-baseline gap-2 rounded-card border border-line px-3 py-2 text-[12.5px] text-ink-2 transition-colors hover:border-yin-light hover:text-yin-light"
                    >
                      <span className="font-medium capitalize">{d.kind}</span>
                      <span data-ay-skip="1" className="text-ink-3 group-hover:text-yin-light">{bytes(d.bytes)}</span>
                      <span data-ay-skip="1" className="hidden font-mono text-[10px] text-ink-3 sm:inline">{d.sha256.slice(0, 12)}…</span>
                    </a>
                  ))}
                </div>
              </Card>
            ))}
            {inv && inv.length === 0 ? <p className="text-[14px] text-ink-3">No invoices recorded yet.</p> : null}
          </div>
        </Section>
      )}

      {tab === "cra" && cra && (
        <>
          <Section
            title="Year-end return"
            note="Prepared from the ledger above, automatically, as soon as a fiscal period closes. This prepares a return; it does not file one."
          >
            <Card className="p-5">
              <p className="text-[14px] font-semibold text-ink">T2 Corporation Income Tax Return — required</p>
              <p className="mt-1 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-2">{cra.t2.why}</p>
              <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-[13px] sm:grid-cols-3">
                <div><dt className="text-ink-3">Form</dt><dd data-ay-skip="1" className="mt-0.5 font-semibold text-ink-2">{cra.t2.form}</dd></div>
                <div><dt className="text-ink-3">Period</dt><dd data-ay-skip="1" className="mt-0.5 font-semibold text-ink-2">{cra.fy.label}</dd></div>
                <div><dt className="text-ink-3">Due</dt><dd data-ay-skip="1" className="mt-0.5 font-semibold text-ink-2">{cra.t2.due}</dd></div>
              </dl>
              <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">{cra.t2.form_why}</p>
              <ul className="mt-3 grid gap-1 text-[13px] text-ink-2">
                {cra.t2.schedules.map((s) => <li key={s} data-ay-skip="1">· {s}</li>)}
              </ul>
            </Card>

            <Card className="mt-3 p-5">
              <p className="text-[14px] font-semibold text-ink">
                T1044 NPO Information Return — {cra.t1044.required ? "required" : "not required for this period"}
              </p>
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
          </Section>

          <Section title="GIFI schedules" note="The financial statements in the coded form CRA requires with the T2. Every code is the official one from Guide RC4088.">
            <Card className="p-5">
              <h3 className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Schedule 100 — balance sheet</h3>
              <div className="mt-2">{cra.schedule_100.map((r: GifiRow, i) => <Row key={`${r.gifi}-${i}`} label={r.label} cents={r.cents} gifi={r.gifi} cur={cur} />)}</div>
              <h3 className="mt-6 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Schedule 125 — income statement</h3>
              <div className="mt-2">{cra.schedule_125.map((r, i) => <Row key={`${r.gifi}-${i}`} label={r.label} cents={r.cents} gifi={r.gifi} cur={cur} />)}</div>
            </Card>
          </Section>

          <Section title="Notes to the financial statements">
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
        {st.entity.receipts_note} The underlying tables are published row by row at{" "}
        <a href="/data/" className="text-yin-light hover:underline">/data</a>, and the invariants above can be
        re-run at any time against <span data-ay-skip="1">/wp-json/aq/v1/foundation/books/verify</span>.
      </p>
    </div>
  );
}
