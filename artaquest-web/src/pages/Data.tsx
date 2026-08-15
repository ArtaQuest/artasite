import { useEffect, useState } from "react";
import { getDbTables, getDbRows, type DbTable, type DbRows } from "../lib/wp";
import { Button, Card, PageHero, SearchPill, StatusNote, cx } from "../components/ui";

const isRedacted = (v: unknown) => typeof v === "string" && v.startsWith("▒");

// Light, opt-in cell formatting: unix-epoch time columns → readable date; gold-weight
// columns → "mg". Everything else is shown verbatim. Returns null when nothing applies.
function prettyCell(col: string, v: string | number | null): string | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  const c = col.toLowerCase();
  if ((c === "ts" || c.endsWith("_ts") || c.endsWith("_at") || c === "created" || c === "updated") && Number.isFinite(n) && n > 1e8) {
    const d = new Date((n < 1e12 ? n * 1000 : n)); // seconds vs milliseconds
    if (!Number.isNaN(d.getTime())) return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if ((c === "reserve_mg" || c.endsWith("_mg")) && Number.isFinite(n)) return `${n.toLocaleString()} mg`;
  return null;
}

/* ─── Use cases — what the open data is for. Tinted gold (the Why) / blue (the How), alternating. ── */
const UC = {
  audit: <><path d="M12 3 4 6v5c0 4.5 3.2 7.3 8 9 4.8-1.7 8-4.5 8-9V6Z" /><path d="m8.5 11.5 2.5 2.5 4.5-4.5" /></>,
  money: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6 9.5v5M18 9.5v5" /></>,
  book: <><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2Z" /><path d="M8 7h8M8 11h6" /></>,
  chat: <path d="M21 11.5a8.4 8.4 0 0 1-9.4 8.3L3 21l1.2-3.6A8.4 8.4 0 1 1 21 11.5Z" />,
  users: <><circle cx="9" cy="8" r="3.2" /><path d="M2.8 19.2a6.2 6.2 0 0 1 12.4 0" /><path d="M16.2 5.1a3.2 3.2 0 0 1 0 6.2M21.2 19.2a6.2 6.2 0 0 0-3.4-5.5" /></>,
  code: <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12" />,
} as const;

const USE_CASES: { icon: keyof typeof UC; title: string; body: string }[] = [
  { icon: "audit", title: "Audit the economy", body: "Add up the Arta Coin ledger row by row and work out the gold backing behind every coin in circulation for yourself — the same ratio the Reserve page publishes." },
  { icon: "money", title: "Follow the money", body: "Trace donations, fund balances, and bursary grants — amounts, dates, and status — from the moment they arrive to where they are spent." },
  { icon: "book", title: "See what is published", body: "Browse every published work, the Kaggle notebook behind it, the checklist it cleared and the files it put in the Library." },
  { icon: "chat", title: "See which replies rise", body: "Read every reply members post and the hearts that rank them — the raw signal behind every challenge board." },
  { icon: "users", title: "Measure the community", body: "Discussion threads and replies, exactly as written — useful for discourse and sentiment research." },
  { icon: "code", title: "Build on it", body: "Pull any table from a single public REST endpoint — reproducible for papers, notebooks, and live dashboards." },
];

/* Copy `text`, returning whether it worked. Prefers the async Clipboard API; falls back to a
 * hidden-textarea execCommand for browsers / contexts where it is unavailable or the document
 * isn't focused (so the button still works without a secure context). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/* ─── Copy-to-clipboard button (used for the endpoint, code samples, and citation) ── */
function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1600); }
  };
  return (
    <button type="button" onClick={copy} aria-label={done ? "Copied" : label}
      className={cx("inline-flex h-7 items-center gap-1.5 rounded-pill px-2.5 text-[12px] font-medium transition-colors", done ? "text-yang" : "text-ink-2 hover:text-ink", className)}>
      {done ? (
        <><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5 12 5 5 9-11" /></svg>Copied</>
      ) : (
        <><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>{label}</>
      )}
    </button>
  );
}

/* ─── A labelled, copyable code sample. data-ay-skip so the i18n runtime never rewrites code. ── */
function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-field border border-line bg-space-1">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-space-2 px-3 py-1">
        <span className="text-[12px] font-medium text-ink-3">{title}</span>
        <CopyButton text={code} className="h-6 px-1.5 hover:bg-veil/5" />
      </div>
      {/* tabIndex+role make the horizontally-scrolling code sample keyboard-operable (WCAG 2.1.1). */}
      <pre data-ay-skip="1" tabIndex={0} role="region" aria-label={`${title} code sample, scrollable`} className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-ink-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-yin-light"><code>{code}</code></pre>
    </div>
  );
}

/** Public, read-only database explorer — every table browsable; secrets + contact details are
 *  redacted server-side (shown as ▒). Fetches the table list once, then one page of rows on demand.
 *  Around the explorer: what the data is for (use cases) and how to query + cite it for research. */
export default function Data() {
  const [tables, setTables] = useState<DbTable[] | null>(null);
  const [note, setNote] = useState("");
  const [sel, setSel] = useState("");
  const [data, setData] = useState<DbRows | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [q, setQ] = useState("");

  useEffect(() => {
    getDbTables().then((d) => {
      setTables(d.tables);
      setNote(d.note);
      // Honour a ?table=<name> deep-link (e.g. the Reserve/Wallet "browse the ledgers" links) when it
      // names a real table; otherwise lead with the money record — the Arta Coin ledger — falling back
      // to a populated _posts table, then anything non-empty. Every fallback must be a table that HAS
      // rows: landing a first-time visitor on an empty grid says the database is empty, which is the
      // opposite of what this page exists to show. (The gold-rate history used to sit second here; it
      // has never had a writer, so it always opened on "This table is empty".)
      const want = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("table") : null;
      const fromUrl = want ? d.tables.find((t) => t.name === want) : null;
      const pref = fromUrl || d.tables.find((t) => t.name === "wp_aq_coin_ledger" && t.rows > 0) || d.tables.find((t) => t.name.endsWith("_posts") && t.rows > 0) || d.tables.find((t) => t.rows > 0) || d.tables[0];
      if (pref) setSel(pref.name);
    }).catch(() => setTables([]));
  }, []);
  useEffect(() => { setPage(1); }, [sel]);
  useEffect(() => { if (sel) { setData(null); setFailed(false); getDbRows(sel, page).then((d) => { if (d) setData(d); else setFailed(true); }).catch(() => setFailed(true)); } }, [sel, page, reload]);

  // Canonical public base for the endpoint + citation. On a local dev preview fall back to the
  // production host so the copy-paste examples and the citation read correctly for researchers.
  const liveOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const isLocal = /localhost|127\.0\.0\.1|\.local\b/i.test(liveOrigin);
  const base = !liveOrigin || isLocal ? "https://artaquest.com" : liveOrigin;
  const endpoint = `${base}/wp-json/aq/v1/db`;
  const now = new Date();
  const accessDate = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const citation = `ArtaQuest Foundation. (${now.getFullYear()}). ArtaQuest open data [Data set]. Retrieved ${accessDate}, from ${base}/data/`;

  const shown = !tables ? [] : q ? tables.filter((t) => (t.label + " " + t.name).toLowerCase().includes(q.toLowerCase())) : tables;
  const selDesc = tables?.find((t) => t.name === sel)?.desc || "";

  return (
    <div className="flex flex-col gap-12 pb-16">
      {/* ─── Header ─── */}
      <header className="max-w-3xl">
        <PageHero
          eyebrow="Transparency"
          title="Open data"
          lede="ArtaQuest runs in the open. Every course, donation, forum post, and every coin minted or moved
            lives in one public database — and this page lets you read all of it, table by table. Nothing here
            is a summary or a snapshot; it is the live data the site itself runs on."
        />
        <DatasetsLine />
        {note && (
          <div className="mt-5 flex gap-3 rounded-card border border-line bg-space-2 px-4 py-3">
            <span className="mt-0.5 shrink-0 text-yang" aria-hidden>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
            </span>
            <p className="text-[13.5px] leading-relaxed text-ink-2"><span className="font-semibold text-ink">What is hidden — </span>{note}</p>
          </div>
        )}
      </header>

      {/* ─── Use cases ─── */}
      <section aria-labelledby="data-uses">
        <h2 id="data-uses" className="text-[20px] font-bold tracking-tight">What you can do with it</h2>
        <p className="mt-1.5 text-[14px] text-ink-2">A few of the questions this data can answer. Read it on the page below, or pull it through the API.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map((u, i) => {
            const tint = i % 2 === 0 ? "bg-yang/10 text-yang" : "bg-yin/15 text-yin-light";
            return (
              <Card key={u.title} className="flex gap-3.5 p-4">
                <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-field", tint)} aria-hidden>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{UC[u.icon]}</svg>
                </span>
                <div className="min-w-0">
                  <h3 className="text-[15px] font-bold tracking-tight text-ink">{u.title}</h3>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-ink-2">{u.body}</p>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      {/* ─── Explorer ─── */}
      <section aria-labelledby="data-explore">
        <h2 id="data-explore" className="text-[20px] font-bold tracking-tight">Explore the data</h2>
        <p className="mt-1.5 text-[14px] text-ink-2">Pick a table to browse its rows. The notable tables are listed first; the rest follow alphabetically.</p>

        {!tables ? (
          <StatusNote className="py-16">Loading…</StatusNote>
        ) : (
          <div className="mt-5 grid gap-6 lg:grid-cols-[256px_1fr]">
            {/* table list */}
            <aside className="min-w-0">
              <SearchPill value={q} onChange={setQ} placeholder="Find a table…" className="mb-2 h-9 w-full px-3" />
              <ul className="max-h-[72vh] list-none space-y-0.5 overflow-y-auto pe-1">
                {shown.map((t) => (
                  <li key={t.name}>
                    <button type="button" onClick={() => setSel(t.name)} title={t.desc}
                      className={`flex w-full items-center justify-between gap-2 rounded-field px-3 py-2 text-start text-[13.5px] transition-colors ${sel === t.name ? "bg-yin/15 font-semibold text-yang" : "text-ink-2 hover:bg-veil/5"}`}>
                      <span className="truncate">{t.label}</span>
                      <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{t.rows.toLocaleString()}</span>
                    </button>
                  </li>
                ))}
                {shown.length === 0 && <li className="px-3 py-2 text-[13px] text-ink-3">No table matches “{q}”.</li>}
              </ul>
            </aside>

            {/* data grid */}
            <section className="min-w-0">
              {failed ? (
                <Card className="px-6 py-10 text-center text-[14px] text-ink-3">
                  <p>Could not load this table. Please try again.</p>
                  <Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)} className="mt-3">Retry</Button>
                </Card>
              ) : !data ? (
                <StatusNote>Loading…</StatusNote>
              ) : (
                <>
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <h3 className="text-[18px] font-bold tracking-tight">
                      {data.label} <span className="ms-1 font-mono text-[12px] font-normal text-ink-3" data-ay-skip="1">{data.table}</span>
                    </h3>
                    <span className="text-[13px] text-ink-3">{data.total.toLocaleString()} {data.total === 1 ? "row" : "rows"} · {data.per}/page</span>
                  </div>
                  {selDesc && <p className="mb-3 text-[13.5px] leading-relaxed text-ink-2">{selDesc}</p>}
                  {data.rows.length === 0 ? (
                    <Card className="px-6 py-10 text-center text-[14px] text-ink-3">This table is empty.</Card>
                  ) : (
                    <Card className="overflow-hidden p-0">
                      {/* tabIndex + role/label make the horizontally-scrolling grid keyboard-operable
                          (WCAG 2.1.1) — without it, keyboard users can't reach off-screen columns. */}
                      <div className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-yin-light" tabIndex={0} role="region" aria-label={`${data.label} table, scrollable`}>
                        <table className="w-full border-collapse text-[12.5px]" data-ay-skip="1">
                          <caption className="sr-only">{data.label} — {data.total.toLocaleString()} rows</caption>
                          <thead>
                            <tr className="border-b border-line bg-space-2 text-start">
                              {data.columns.map((c) => (
                                <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 font-semibold text-ink-2">{c}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {data.rows.map((r, i) => (
                              <tr key={i} className="border-b border-line/50 hover:bg-veil/[0.03]">
                                {data.columns.map((c) => {
                                  const v = r[c];
                                  const red = isRedacted(v);
                                  const pretty = red ? null : prettyCell(c, v);
                                  return (
                                    <td key={c} title={red ? "Hidden for privacy / security" : String(v ?? "")}
                                      className={`max-w-[340px] truncate px-3 py-2 align-top ${red ? "italic text-ink-3" : "font-mono text-ink-2"}`}>
                                      {v == null ? <span className="text-ink-3/40">null</span> : pretty ?? String(v)}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Card>
                  )}
                  {data.pages > 1 && (
                    <div className="mt-3 flex items-center justify-center gap-3 text-[13px]">
                      <Button variant="outline" size="sm" disabled={data.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><span aria-hidden className="inline-block rtl:-scale-x-100">←</span> Prev</Button>
                      <span className="text-ink-3">Page {data.page} of {data.pages}</span>
                      <Button variant="outline" size="sm" disabled={data.page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></Button>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </section>

      {/* ─── Using the data in research ─── */}
      <section aria-labelledby="data-research">
        <h2 id="data-research" className="text-[20px] font-bold tracking-tight">Using this data in research</h2>
        <p className="mt-1.5 max-w-3xl text-[14px] leading-relaxed text-ink-2">
          The same records you see above are served by one public, read-only REST endpoint — no key, no sign-in.
          You are welcome to use it for research, journalism, and analysis. If you publish anything based on it,
          please cite it as below.
        </p>

        {/* grid-cols-1 (not the implicit `auto` track) so the single mobile column is minmax(0,1fr) —
            capped at the viewport, never widened to fit the cards' content. Each card also gets min-w-0
            so it can shrink below its code blocks' intrinsic width (the long curl/JS lines scroll inside
            their own overflow-x-auto <pre> instead of forcing the card — and the page — sideways). Mirrors
            the explorer grid above (its aside/section carry min-w-0 for the same reason). Fixes #16. */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* Query the API */}
          <Card className="flex min-w-0 flex-col gap-4 p-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[15px] font-bold tracking-tight">Query the API</h3>
              <CopyButton text={endpoint} label="Copy URL" className="border border-line px-2.5 hover:border-ink-3" />
            </div>
            <p data-ay-skip="1" className="break-all rounded-field border border-line bg-space-1 px-3.5 py-2.5 font-mono text-[12.5px] text-ink">
              <span className="text-yang">GET</span> {endpoint}
            </p>
            <dl className="space-y-2 text-[13.5px]">
              <div className="flex gap-3">
                <dt className="w-12 shrink-0 font-mono text-yang">table</dt>
                <dd className="text-ink-2">Exact table name (e.g. <span className="font-mono text-ink" data-ay-skip="1">wp_aq_coin_ledger</span>). Omit to get the catalogue of every table with its row count.</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-12 shrink-0 font-mono text-yang">page</dt>
                {/* 25 mirrors Extra::DB_PER, the size the endpoint actually serves — and the size
                    the explorer above prints live beside its row count. Two numbers for one fact is
                    how this line came to advertise 50 while the page showed 25 three sections up. */}
                <dd className="text-ink-2">Page number. Rows come 25 at a time; the response also returns <span className="font-mono text-ink" data-ay-skip="1">total</span> and <span className="font-mono text-ink" data-ay-skip="1">pages</span>.</dd>
              </div>
            </dl>
            <CodeBlock title="curl" code={`# List every table\ncurl "${endpoint}"\n\n# Read the Arta Coin ledger, first page\ncurl "${endpoint}?table=wp_aq_coin_ledger&page=1"`} />
            <CodeBlock title="JavaScript" code={`const res = await fetch(\n  "${endpoint}?table=wp_aq_coin_ledger&page=1"\n);\nconst { rows, total, pages } = await res.json();`} />
          </Card>

          {/* Cite it */}
          <Card className="flex min-w-0 flex-col gap-4 p-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[15px] font-bold tracking-tight">Cite it</h3>
              <CopyButton text={citation} label="Copy citation" className="border border-line px-2.5 hover:border-ink-3" />
            </div>
            <p className="text-[13.5px] leading-relaxed text-ink-2">Suggested citation (adapt to your style guide). The access date is today, {accessDate}:</p>
            <blockquote data-ay-skip="1" className="break-words rounded-field border-s-2 border-yang bg-yang/[0.06] px-4 py-3 text-[13.5px] leading-relaxed text-ink">
              ArtaQuest Foundation. ({now.getFullYear()}). <em>ArtaQuest open data</em> [Data set]. Retrieved {accessDate}, from {base}/data/
            </blockquote>
            <div className="mt-auto space-y-2 border-t border-line/60 pt-4 text-[13px] leading-relaxed text-ink-3">
              <p><span className="font-semibold text-ink-2">Licence — </span>free to use for research, journalism, and analysis. Please credit the ArtaQuest Foundation and link back to this page.</p>
              <p><span className="font-semibold text-ink-2">As provided — </span>the data is supplied as-is, with the redactions noted above. It includes members' registered email addresses and other personal data, published by design. It is not personal advice.</p>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}

/* Open datasets — nightly NDJSON.gz snapshots of every public table (GET /datasets), packaged for
   researchers and anyone who wants the whole database in one file. */
function DatasetsLine() {
  const [items, setItems] = useState<{ name: string; bytes: number; url: string; date: string }[]>([]);
  useEffect(() => {
    fetch("/wp-json/aq/v1/datasets").then((r) => r.json()).then((d) => setItems((d.items ?? []).slice(0, 3))).catch(() => {});
  }, []);
  if (!items.length) return null;
  const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
  return (
    <p className="mt-4 text-[13.5px] leading-relaxed text-ink-3">
      <span className="font-semibold text-ink">Download the whole database — </span>
      nightly snapshots, one JSON line per row:{" "}
      {items.map((d, i) => (
        <span key={d.name}>{i > 0 && " · "}<a href={d.url} className="text-yang hover:underline" download>{d.date}</a> ({mb(d.bytes)})</span>
      ))}
    </p>
  );
}
