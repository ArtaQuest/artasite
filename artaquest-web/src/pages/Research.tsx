import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode, type ChangeEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, cx } from "../components/ui";
import { watchMath } from "../lib/math";
// The reading kit now lives in a shared module so the Journal reader and the ArtaPublishing book reader
// are literally the same components (ReadMode, ReadingToc, MarkdownLite, containWideTables, TocItem).
import { MarkdownLite, ReadingToc, ReadMode, containWideTables, type TocItem } from "../components/reader";
import Thread from "./Thread";
import { SharePanel } from "../components/SharePanel";
import { submitResearch, reviseSubmission, withdrawSubmission, uploadResearchFile, listSubmissions, getSubmission, getArtefact, reviewStatus, getJournals, isLoggedIn, currentUser, listResearchArtifacts, createResearchDataset, createResearchModel, type ResearchArtifact, type Submission, type ReviewRound, type ChartSpec, type ChartSeries, type Journal } from "../lib/api";

// The portal name (the publisher; the masthead the whole hub sits under).
const PORTAL = "ArtaQuest Journals";
const dataUri = (s: string) => "data:text/plain;charset=utf-8," + encodeURIComponent(s);

// ── Journal identity ────────────────────────────────────────────────────────────
// Distinct-but-coherent identities WITHIN the two-colour palette. Each journal leans on one of the two
// brand accents (gold-forward or blue-forward) and carries an emblem glyph — no third colour, ever.
// Keyed by slug; an unknown/new journal falls back to a neutral identity so the portal renders whatever
// the API returns. `lean` picks which accent dominates a journal's surfaces; the OTHER accent stays the
// shared hover colour (blue) per brand.
type Lean = "yang" | "yin";
type JournalSkin = { lean: Lean; glyph: ReactNode };
function JournalEmblem({ lean, className }: { lean: Lean; className?: string }) {
  // A small two-colour emblem: a ring (the brand "A through a ring" motif) with a cyclical/orbital mark.
  const ring = lean === "yang" ? "#E8B923" : "#2352E8";
  const dot = lean === "yang" ? "#2352E8" : "#E8B923";
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className} width="32" height="32">
      <circle cx="16" cy="16" r="11" fill="none" stroke={ring} strokeWidth="2.4" opacity="0.9" />
      <path d="M16 5 A11 11 0 0 1 27 16" fill="none" stroke={dot} strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="16" cy="5" r="2.6" fill={dot} />
    </svg>
  );
}
const SKINS: Record<string, JournalSkin> = {
  seasonality:          { lean: "yang", glyph: <JournalEmblem lean="yang" className="h-8 w-8" /> },
  "educational-accessibility": { lean: "yin",  glyph: <JournalEmblem lean="yin" className="h-8 w-8" /> },
};
// Deterministic fallback skin for any journal not in the table (so new journals get an identity, alternating).
function skinFor(slug: string): JournalSkin {
  if (SKINS[slug]) return SKINS[slug];
  let h = 0; for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  const lean: Lean = h % 2 === 0 ? "yang" : "yin";
  return { lean, glyph: <JournalEmblem lean={lean} className="h-8 w-8" /> };
}
// Per-lean Tailwind tokens (accent ring/fill for the journal's lead colour). Hover accent stays blue everywhere.
const leanTok = (lean: Lean) => lean === "yang"
  ? { text: "text-yang", border: "border-yang/45", soft: "bg-yang/[0.10]", chipBorder: "border-yang/50", chipBg: "bg-yang/[0.12]" }
  : { text: "text-yin-light", border: "border-yin/45", soft: "bg-yin/[0.10]", chipBorder: "border-yin/45", chipBg: "bg-yin/[0.12]" };

// A small journal badge shown on cards / readers / the queue so a reader always knows the journal.
function JournalBadge({ name, slug }: { name?: string; slug?: string }) {
  if (!name) return null;
  const t = leanTok(skinFor(slug || "").lean);
  return <span className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold", t.chipBorder, t.chipBg, t.text)}>{name}</span>;
}

function Cite({ text }: { text: string }) {
  return <p className="mt-1 select-all whitespace-pre-wrap rounded-field border border-line bg-space-1 p-3 font-mono text-[12px] leading-relaxed text-ink-2">{text}</p>;
}

// ── DOI short links (operator 2026-07-13): the archive provider never appears member-facing.
// The raw DOI string names its registrar, so surfaces show ONLY the ArtaQuest short link, which
// 301s to the resolver server-side (src/Doi.php).
const doiShort = (id: number | string) => `https://artaquest.com/d/p${id}`;

// ── Citation builder for a published (accepted) article ─────────────────────────
function citeFormats(s: Submission) {
  const JOURNAL = s.journal_name || "ArtaQuest Journals";
  const author = s.author?.name || "Anonymous";
  const year = s.created ? new Date(s.created * 1000).getUTCFullYear() : new Date().getUTCFullYear();
  const doiUrl = s.doi ? doiShort(s.id) : "";
  const last = (author.trim().split(/\s+/).pop() || "").toLowerCase().replace(/[^a-z]/g, "");
  const key = `${last || "anon"}${year}-${s.id}`; // suffix the id so two same-year/non-Latin authors never collide
  // BibTeX/RIS are plain-text formats: strip the braces/backslashes that would break a .bib entry, and
  // newlines that would break a RIS tag, so the downloaded file is always valid.
  const bib = (v: string) => v.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();
  const ris1 = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
  const apa = `${author} (${year}). ${s.title}. ${JOURNAL}.${doiUrl ? " " + doiUrl : ""}`;
  const bibtex = `@article{${key},\n  title   = {${bib(s.title)}},\n  author  = {${bib(author)}},\n  year    = {${year}},\n  journal = {${JOURNAL}},${s.doi ? `\n  url     = {${doiUrl}},` : ""}\n}`;
  const ris = `TY  - JOUR\nAU  - ${ris1(author)}\nTI  - ${ris1(s.title)}\nPY  - ${year}\nJO  - ${JOURNAL}${s.doi ? `\nUR  - ${doiUrl}` : ""}\nER  - `;
  return { apa, bibtex, ris };
}

function CiteTabs({ s }: { s: Submission }) {
  const f = citeFormats(s);
  const tabs: [keyof typeof f, string][] = [["apa", "APA"], ["bibtex", "BibTeX"], ["ris", "RIS"]];
  const [k, setK] = useState<keyof typeof f>("apa");
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div role="group" aria-label="Citation format" className="flex flex-wrap items-center gap-1.5">
        {tabs.map(([key, lbl]) => (
          <button key={key} aria-pressed={k === key} onClick={() => setK(key)} className={cx("rounded-pill px-2.5 py-1 text-[12px] font-semibold", k === key ? "bg-yang text-on-accent" : "bg-space-3 text-ink-2 hover:text-ink")}>{lbl}</button>
        ))}
        <button onClick={() => { navigator.clipboard?.writeText(f[k]).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(() => {}); }}
          className="ml-auto rounded-pill bg-space-3 px-2.5 py-1 text-[12px] font-semibold text-yin-light hover:text-ink">{copied ? "copied ✓" : "Copy"}</button>
      </div>
      <Cite text={f[k]} />
      <p className="mt-1 text-[12px] text-ink-3">Download: <a className="text-yin-light hover:underline" href={dataUri(f.bibtex)} download="citation.bib">.bib</a> · <a className="text-yin-light hover:underline" href={dataUri(f.ris)} download="citation.ris">.ris</a></p>
    </div>
  );
}

/** Live views/downloads from the article's permanent archive record. Silent on any error. */
function MetricsBadge({ doi }: { doi: string }) {
  const [s, setS] = useState<{ views: number; downloads: number } | null>(null);
  useEffect(() => {
    const id = doi.match(/zenodo\.(\d+)/)?.[1];
    if (!id) return;
    let ok = true;
    fetch(`https://zenodo.org/api/records/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (ok && d?.stats) setS({ views: Math.round(d.stats.views ?? d.stats.unique_views ?? 0), downloads: Math.round(d.stats.downloads ?? d.stats.unique_downloads ?? 0) }); })
      .catch(() => {});
    return () => { ok = false; };
  }, [doi]);
  if (!s) return null;
  return <span className="text-ink-3" title="Views and downloads on the permanent archive">· {s.views.toLocaleString()} views · {s.downloads.toLocaleString()} downloads</span>;
}

// ── Automated AI review pipeline (src/Science.php) ──────────────────────────────
type StatusMeta = { label: string; tone: string; dot: string; step: number };
const STATUS: Record<string, StatusMeta> = {
  submitted:             { label: "Queued",              tone: "border-line text-ink-2",                     dot: "bg-ink-3",     step: 1 },
  reviewing:             { label: "Under AI review",      tone: "border-yin/40 bg-yin/[0.10] text-yin-light", dot: "bg-yin-light", step: 2 },
  "revisions-requested": { label: "Revisions requested",  tone: "border-yang/40 bg-yang/[0.10] text-yang",    dot: "bg-yang",      step: 2 },
  accepted:              { label: "Published",            tone: "border-yang/50 bg-yang/[0.14] text-yang",    dot: "bg-yang",      step: 4 },
  rejected:              { label: "Not accepted",         tone: "border-rose-400/40 bg-rose-400/[0.08] text-rose-300", dot: "bg-rose-400/80", step: 0 },
  withdrawn:             { label: "Withdrawn",            tone: "border-line text-ink-3",                     dot: "bg-ink-3",     step: 0 },
};
const VERDICT_TONE: Record<string, string> = { accept: "text-yang", reject: "text-ink-3", revise: "text-yin-light" };
const smeta = (s: string): StatusMeta => STATUS[s] || { label: s, tone: "border-line text-ink-2", dot: "bg-ink-3", step: 0 };

function StatusPill({ status }: { status: string }) {
  const m = smeta(status);
  return <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[12px] font-semibold", m.tone)}><span className={cx("h-1.5 w-1.5 rounded-full", m.dot)} />{m.label}</span>;
}

/** Lifecycle stepper: Submitted → AI review → Accepted → DOI. Terminal states (rejected/withdrawn) shown muted. */
function StatusTimeline({ status, doi }: { status: string; doi?: string }) {
  const terminal = status === "rejected" || status === "withdrawn";
  const step = smeta(status).step;
  const steps = [
    { n: 1, label: "Submitted" },
    { n: 2, label: status === "revisions-requested" ? "Revisions" : "AI review" },
    { n: 3, label: "Accepted" },
    { n: 4, label: doi ? "DOI issued" : "Published" },
  ];
  return (
    <div className="mt-4 flex items-center gap-1">
      {steps.map((s, i) => {
        const done = !terminal && step >= s.n;
        const here = !terminal && step === s.n && step < 4;
        return (
          <div key={s.n} className="flex flex-1 items-center gap-1">
            <div className="flex flex-col items-center gap-1">
              <span className={cx("flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold",
                done ? "bg-yang text-on-accent" : here ? "border-2 border-yin-light text-yin-light" : "border border-line text-ink-2")}>
                {done && s.n < 4 ? "✓" : s.n}
              </span>
              <span className={cx("text-[10px] font-semibold", done || here ? "text-ink" : "text-ink-2")}>{s.label}</span>
            </div>
            {i < steps.length - 1 && <span className={cx("mb-4 h-0.5 flex-1 rounded", !terminal && step > s.n ? "bg-yang" : "bg-line")} />}
          </div>
        );
      })}
      {terminal && <span className="ml-2 mb-4 text-[11px] font-semibold text-ink-2">· {smeta(status).label}</span>}
    </div>
  );
}

/** Labeled artefact links (manuscript / code / data) as chips. */
function ArtefactChips({ s }: { s: Submission }) {
  const chip = (label: string, href?: string) => href ? (
    <a key={label} href={href} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-field border border-line bg-space-2 px-3 py-1.5 text-[12.5px] font-semibold text-ink-2 hover:border-yin-light hover:text-ink">
      <span className="text-ink-3">{label}</span> ↗
    </a>
  ) : null;
  return <div className="mt-4 flex flex-wrap gap-2">{chip("Manuscript", s.paper_url)}{chip("Code", s.code_url)}{chip("Data", s.data_url)}</div>;
}

function ReviewStatusBanner({ journal }: { journal?: string }) {
  const [s, setS] = useState<{ online: boolean; queued: number; published: number } | null>(null);
  useEffect(() => { let ok = true; reviewStatus(journal).then((d) => ok && setS(d)).catch(() => {}); return () => { ok = false; }; }, [journal]);
  if (!s) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-card border border-line bg-space-2 px-3.5 py-2 text-[13px] text-ink-2">
      <span className="inline-flex items-center gap-1.5 font-semibold"><span className={cx("h-2 w-2 rounded-full", s.online ? "bg-yang" : "bg-ink-3")} />Reviewer {s.online ? "online" : "offline"}</span>
      <span className="text-ink-3">{s.queued} in the queue</span>
      <span className="text-ink-3">{s.published} published</span>
    </div>
  );
}


// ── Inline notebook preview (GitHub-style render of the reproduction .ipynb) ────────────────────
type NbCell = { cell_type?: string; source?: string | string[]; outputs?: NbOutput[] };
type NbOutput = { output_type?: string; text?: string | string[]; name?: string; ename?: string; evalue?: string; data?: Record<string, unknown> };
const nbText = (s?: string | string[]) => (Array.isArray(s) ? s.join("") : (s || ""));

/** Render a code cell's outputs: stdout/stderr streams, text/plain results, and inline PNG figures.
 *  HTML/error/rich outputs are shown as plain text (never injected) — no dangerouslySetInnerHTML. */
function NotebookOutputs({ outputs }: { outputs?: NbOutput[] }) {
  if (!outputs?.length) return null;
  const pre = "overflow-x-auto whitespace-pre-wrap break-words px-4 py-2 font-mono text-[12px] leading-relaxed text-ink-2";
  return (
    <div className="border-t border-line/50 bg-space-1/60">
      {outputs.map((o, i) => {
        if (o.output_type === "stream") return <pre key={i} className={pre}>{nbText(o.text)}</pre>;
        if (o.output_type === "error") return <pre key={i} className={cx(pre, "text-rose-300")}>{`${o.ename || "Error"}: ${o.evalue || ""}`}</pre>;
        const data = (o.output_type === "execute_result" || o.output_type === "display_data") ? o.data : undefined;
        if (data) {
          const png = data["image/png"];
          if (typeof png === "string") return <img key={i} src={`data:image/png;base64,${png.replace(/\s/g, "")}`} alt="figure" className="mx-auto my-2 max-w-full rounded" />;
          const txt = data["text/plain"];
          if (txt != null) return <pre key={i} className={pre}>{nbText(txt as string | string[])}</pre>;
        }
        return null;
      })}
    </div>
  );
}

/** GitHub-style inline preview of the published reproduction notebook (markdown narrative + code + outputs).
 *  Collapsed, it renders only the first few cells (keeps the DOM small for big notebooks); expanding shows
 *  all. The toggle appears whenever there's more to show, so a short-but-tall notebook is never silently cut. */
const NB_PREVIEW_CELLS = 6;
function NotebookPreview({ json }: { json: string }) {
  const cells = useMemo<NbCell[] | null>(() => {
    try { const o = JSON.parse(json); return Array.isArray(o?.cells) ? (o.cells as NbCell[]) : null; } catch { return null; }
  }, [json]);
  const [open, setOpen] = useState(false);
  if (!cells || !cells.length) return null;
  const clamped = cells.length > NB_PREVIEW_CELLS;
  const shown = open || !clamped ? cells : cells.slice(0, NB_PREVIEW_CELLS);
  return (
    <div>
      <div className="overflow-hidden rounded-card border border-line bg-space-2">
        {shown.map((c, i) => c.cell_type === "markdown" ? (
          <div key={i} className="border-b border-line/50 px-4 py-3 text-[14px] last:border-0">
            <MarkdownLite text={nbText(c.source)} />
          </div>
        ) : c.cell_type === "code" ? (
          <div key={i} className="border-b border-line/50 last:border-0">
            <div className="flex gap-2 bg-space-1/40">
              <span className="select-none py-2 pl-3 pr-1 font-mono text-[11px] text-yin-light/70">In</span>
              <pre className="flex-1 overflow-x-auto py-2 pr-3 font-mono text-[12px] leading-relaxed text-ink"><code>{nbText(c.source)}</code></pre>
            </div>
            <NotebookOutputs outputs={c.outputs} />
          </div>
        ) : null)}
      </div>
      {clamped && (
        <button onClick={() => setOpen((v) => !v)} className="mt-2 text-[13px] font-semibold text-yin-light hover:underline">
          {open ? "Show less" : `Show the full notebook (${cells.length} cells)`}
        </button>
      )}
    </div>
  );
}

// ── Artefact viewers: show the ACTUAL manuscript (PDF), data (CSV table), and code (notebook) inline ──
const fileExt = (u?: string) => (u || "").split(/[?#]/)[0].split(".").pop()?.toLowerCase() || "";

/** Embed the compiled manuscript PDF (same-origin → renders in an <iframe>), with open/download fallbacks. */
function PdfViewer({ url }: { url: string }) {
  return (
    <div>
      <iframe src={`${url}#view=FitH`} title="Manuscript (PDF)" className="h-[640px] w-full rounded-card border border-line bg-space-1" loading="lazy" />
      <p className="mt-1 text-[12px] text-ink-3"><a className="text-yin-light hover:underline" href={url} target="_blank" rel="noopener noreferrer">Open the PDF in a new tab</a> · <a className="text-yin-light hover:underline" href={url} download>download</a></p>
    </div>
  );
}

/** Minimal RFC-4180-ish CSV parser (handles quotes + escaped quotes), capped to `maxRows` for the preview. */
function parseCsv(text: string, maxRows: number): string[][] {
  const rows: string[][] = []; let field = "", row: string[] = [], inQ = false;
  for (let i = 0; i < text.length && rows.length <= maxRows; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

/** Render an accepted article's open DATA as a scrollable table (CSV/TSV), fetched via the same-origin
 *  proxy so host CORS never blocks it. Falls back to a download link for binary/oversized/non-CSV data. */
function CsvTable({ id, url }: { id: number; url: string }) {
  const MAXR = 200;
  const [state, setState] = useState<{ rows?: string[][]; total?: number; err?: boolean; truncated?: boolean } | null>(null);
  useEffect(() => {
    let ok = true;
    getArtefact(id, "data").then((d) => {
      if (!ok) return;
      const sep = d.content_type.includes("tab") || fileExt(url) === "tsv" ? "\t" : ",";
      const rows = parseCsv(sep === "\t" ? d.text.replace(/\t/g, ",") : d.text, MAXR + 1);
      setState({ rows: rows.slice(0, MAXR + 1), total: rows.length, truncated: d.truncated || rows.length > MAXR + 1 });
    }).catch(() => ok && setState({ err: true }));
    return () => { ok = false; };
  }, [id, url]);
  if (!state) return <div className="h-24 animate-pulse rounded-card bg-veil/[0.05]" role="status" aria-busy="true" />;
  if (state.err || !state.rows?.length) return <p className="text-[13px] text-ink-3"><a className="font-semibold text-yin-light hover:underline" href={url} target="_blank" rel="noopener noreferrer">Download the data ↗</a> (can't preview this file inline)</p>;
  const [head, ...body] = state.rows;
  return (
    <div>
      <div className="max-h-[420px] overflow-auto rounded-card border border-line">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 bg-space-3 text-ink-2">
            <tr>{head.map((h, i) => <th key={i} className="border-b border-line px-2.5 py-1.5 text-left font-semibold whitespace-nowrap">{h}</th>)}</tr>
          </thead>
          <tbody className="font-mono text-ink-2">
            {body.slice(0, MAXR).map((r, ri) => (
              <tr key={ri} className="odd:bg-veil/[0.02]">{head.map((_, ci) => <td key={ci} className="border-b border-line/50 px-2.5 py-1 whitespace-nowrap">{r[ci] ?? ""}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[12px] text-ink-3">{Math.max(0, (state.total ?? 1) - 1).toLocaleString()} rows × {head.length} columns{state.truncated ? ` · showing the first ${MAXR}` : ""} · <a className="text-yin-light hover:underline" href={url} target="_blank" rel="noopener noreferrer">download the full CSV</a></p>
    </div>
  );
}

/** Render an accepted article's open CODE inline when it's a single notebook/script the proxy can fetch;
 *  otherwise (a repo or zip) just link it — the runnable code is the reproduction notebook below. */
function CodeViewer({ id, url }: { id: number; url: string }) {
  const ext = fileExt(url);
  const inlineable = ext === "ipynb" || ext === "py" || ext === "txt" || ext === "md" || ext === "r";
  const [data, setData] = useState<{ text?: string; err?: boolean } | null>(null);
  useEffect(() => {
    if (!inlineable) return;
    let ok = true;
    getArtefact(id, "code").then((d) => ok && setData({ text: d.text })).catch(() => ok && setData({ err: true }));
    return () => { ok = false; };
  }, [id, url, inlineable]);
  if (!inlineable) return <p className="text-[13px] text-ink-3"><a className="font-semibold text-yin-light hover:underline" href={url} target="_blank" rel="noopener noreferrer">Open the code ↗</a> — the runnable reproduction is the notebook below</p>;
  if (!data) return <div className="h-24 animate-pulse rounded-card bg-veil/[0.05]" role="status" aria-busy="true" />;
  if (data.err || !data.text) return <p className="text-[13px] text-ink-3"><a className="font-semibold text-yin-light hover:underline" href={url} target="_blank" rel="noopener noreferrer">Open the code ↗</a></p>;
  if (ext === "ipynb") return <NotebookPreview json={data.text} />;
  return <pre className="max-h-[480px] overflow-auto rounded-card border border-line bg-space-1 p-3 font-mono text-[12px] leading-relaxed text-ink-2"><code>{data.text}</code></pre>;
}

/** Human label for the reviewer model id (e.g. "claude-fable-5" → "Claude Fable 5",
 *  "claude-opus-4-8" → "Claude Opus 4.8" — single- and two-number model families). */
function modelLabel(m?: string) {
  if (!m) return "";
  const x = m.match(/(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/i);
  if (x) return `Claude ${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? `.${x[3]}` : ""}`;
  return m.replace(/^claude-/, "");
}
/** The seven scoring axes, in WEIGHT order (reproducibility first) — keys match the reviewer's
 *  `scores` object; the weights are the public rubric documented on /artascience. */
const RUBRIC_AXES: { key: string; label: string; weight: number }[] = [
  { key: "reproducibility", label: "Reproducibility", weight: 30 },
  { key: "honesty", label: "Honesty", weight: 15 },
  { key: "communication", label: "Communication", weight: 15 },
  { key: "visualisation", label: "Visualisation", weight: 12 },
  { key: "accessibility", label: "Accessibility", weight: 8 },
  { key: "references", label: "References", weight: 10 },
  { key: "significance", label: "Significance", weight: 10 },
];

/** Compact, transparent per-axis rubric breakdown shown under a review round's score. Each axis is a
 *  labelled mini bar (0–100, gold→blue fill on a track) with its number and weight. Renders nothing
 *  when `scores` is null/absent (older reviews predate persistence). */
function RubricBreakdown({ scores }: { scores?: Record<string, number> | null }) {
  if (!scores) return null;
  const rows = RUBRIC_AXES.filter((a) => typeof scores[a.key] === "number");
  if (!rows.length) return null;
  return (
    <div className="mt-3 rounded-card border border-line bg-space-1 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-2">Rubric breakdown</span>
        <a href="/artascience" className="text-[11px] font-semibold text-yin-light hover:underline">How scoring works →</a>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-2">Seven weighted axes (each 0–100); the score above is their weighted average.</p>
      <dl className="mt-2.5 space-y-1.5">
        {rows.map((a) => {
          const v = Math.max(0, Math.min(100, Math.round(scores[a.key])));
          return (
            <div key={a.key} className="flex items-center gap-2.5">
              <dt className="flex w-[42%] shrink-0 items-baseline gap-1.5 sm:w-[34%]">
                <span className="truncate text-[12px] font-medium text-ink-2">{a.label}</span>
                <span className="shrink-0 text-[10.5px] font-semibold text-ink-2">{a.weight}%</span>
              </dt>
              <dd className="flex flex-1 items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-veil/[0.10]" role="img" aria-label={`${a.label}: ${v} out of 100, weight ${a.weight} percent`}>
                  <div className="h-full rounded-full" style={{ width: `${v}%`, background: "linear-gradient(90deg, var(--color-yang) 0%, var(--color-yin-light) 100%)" }} />
                </div>
                <span className="w-7 shrink-0 text-right text-[12px] font-semibold tabular-nums text-ink">{v}</span>
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** One round of AI review — the journal's signature transparency. The header line (verdict, score,
 *  reproduced, date) is always visible; the full report + rubric expand/collapse so a multi-round
 *  history reads as a timeline, not a wall of text. `defaultOpen` lets callers open the decisive round. */
function ReviewRoundCard({ r, defaultOpen = true }: { r: ReviewRound; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const runtime = r.runtime_s ? (r.runtime_s >= 60 ? `${Math.round(r.runtime_s / 60)}m` : `${r.runtime_s}s`) : "";
  const when = r.created ? new Date(r.created * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
  return (
    <div className="overflow-hidden rounded-card border border-line bg-space-2">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left text-[13px] transition hover:bg-veil/[0.03]">
        <span className="font-bold text-ink">Round {r.round}</span>
        <span className={cx("font-semibold", VERDICT_TONE[r.verdict])}>{r.verdict === "accept" ? "Accept" : r.verdict === "reject" ? "Reject" : "Revise"}</span>
        <span className="text-ink-3">· reproduced: <b className={r.reproduced ? "text-yang" : "text-ink-2"}>{r.reproduced ? "yes" : "no"}</b></span>
        <span className="text-ink-3">· score {r.score}/100</span>
        {when && <span className="hidden text-ink-3 sm:inline">· {when}</span>}
        <span className="ml-auto text-[16px] leading-none text-ink-3" aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="border-t border-line/60 px-4 pb-4">
          <p className="mt-3 text-[11.5px] text-ink-2">Reviewed by {modelLabel(r.model) || "an AI reviewer"}{r.effort ? ` · ${r.effort} effort` : ""}{runtime ? ` · ran ${runtime}` : ""}{when ? ` · ${when}` : ""}</p>
          <RubricBreakdown scores={r.scores} />
          <div className="mt-2"><MarkdownLite text={r.report} /></div>
        </div>
      )}
    </div>
  );
}

function SubmitView({ onClose, reviseId, onDone, journals, journalSlug, backLabel }: { onClose: () => void; reviseId?: number; onDone: (id: number) => void; journals: Journal[]; journalSlug?: string; backLabel: string }) {
  const revising = !!reviseId;
  const [title, setTitle] = useState("");
  const [abstract, setAbstract] = useState("");
  const [paper, setPaper] = useState("");
  const [datasetId, setDatasetId] = useState(0);
  const [modelId, setModelId] = useState(0);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The journal the work is submitted to: locked when the flow was opened from a journal home, otherwise
  // a picker (defaulting to the first journal). On a revision the journal is fixed by the existing record.
  const [journal, setJournal] = useState(journalSlug || journals[0]?.slug || "");
  // On a revision, the round being addressed: the latest review report is shown beside the form so the
  // author can answer it point by point without flipping back to the article page.
  const [latest, setLatest] = useState<ReviewRound | null>(null);
  const authed = isLoggedIn();
  useEffect(() => {
    if (!reviseId) return;
    let ok = true;
    getSubmission(reviseId).then((s) => { if (!ok) return; setTitle(s.title); setAbstract(s.abstract || ""); setPaper(s.paper_url || ""); setDatasetId(s.dataset_id || 0); setModelId(s.model_id || 0); if (s.journal) setJournal(s.journal); setLatest(s.reviews?.length ? s.reviews[s.reviews.length - 1] : null); }).catch(() => {});
    return () => { ok = false; };
  }, [reviseId]);
  const chosen = journals.find((j) => j.slug === journal);
  const targetName = chosen?.name || "the journal";
  const field = "w-full rounded-field border border-line bg-space-2 px-3.5 py-2 text-[14px] text-ink placeholder:text-ink-2 focus:border-yin-light focus:outline-none";
  async function go() {
    setErr(""); setBusy(true);
    try {
      const res = revising
        ? await reviseSubmission(reviseId!, { abstract, paper_url: paper, dataset_id: datasetId, model_id: modelId })
        : await submitResearch({ journal, title, abstract, paper_url: paper, dataset_id: datasetId, model_id: modelId, consent });
      onDone(res.id);
    } catch (e) { setErr(e instanceof Error ? e.message : "Submission failed"); } finally { setBusy(false); }
  }
  const isUrl = (u: string) => /^https?:\/\/[^\s]{4,}$/i.test(u.trim());
  const valid = abstract.trim().length >= 40 && isUrl(paper) && datasetId > 0 && modelId > 0 && (revising || (title.trim().length >= 8 && consent && !!journal));
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:py-10">
      <button onClick={onClose} className="text-[14px] font-semibold text-yin-light hover:underline">← {backLabel}</button>
      <h1 className="mt-4 text-[clamp(1.7rem,4vw,2.3rem)] font-extrabold leading-tight">{revising ? "Submit a revision" : journalSlug ? `Submit to ${targetName}` : "Submit a manuscript"}</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">Every manuscript is built on two registered prerequisites: an open <b className="text-ink">dataset</b> and a <b className="text-ink">model</b> (your code bundle carrying the standard reproduction contract). Review is fully automated: the platform <b className="text-ink">pre-runs your model on your dataset</b>, then ArtaScience compiles your manuscript, checks the run against your claims, and gives you a verdict and a detailed report.</p>
      <p className="mt-2 text-[13px] text-ink-3">Write your manuscript with our class — <a className="font-semibold text-yin-light hover:underline" href="https://artaquest.com/papers/artaquest-latex-template.zip">download the LaTeX template (.zip)</a> · <a className="font-semibold text-yin-light hover:underline" href="https://artaquest.com/papers/style-guide.html" target="_blank" rel="noopener noreferrer">style guide &amp; checklist</a>. For each artefact, paste a public URL <i>or</i> upload the file.</p>
      {!authed ? (
        <p className="mt-6 rounded-card border border-line bg-space-2 p-4 text-[15px] text-ink-2">Please <a className="font-semibold text-yin-light hover:underline" href={((typeof window !== "undefined" && (window as unknown as Record<string, string>).AQ_LOGIN_URL) || "/login/") + (typeof window !== "undefined" ? `?redirect_to=${encodeURIComponent(window.location.pathname + window.location.search)}` : "")}>sign in</a> to submit your manuscript.</p>
      ) : (
        <div className="mt-6 space-y-4">
          {!revising && (
            journalSlug ? (
              <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">Submitting to <JournalBadge name={targetName} slug={journal} /></p>
            ) : (
              <div>
                <p className="mb-1.5 text-[13px] font-semibold text-ink-2">Choose a journal</p>
                <div role="radiogroup" aria-label="Choose a journal" className="grid gap-2 sm:grid-cols-2">
                  {journals.map((j) => {
                    const on = j.slug === journal;
                    const t = leanTok(skinFor(j.slug).lean);
                    return (
                      <button key={j.slug} type="button" role="radio" aria-checked={on} onClick={() => setJournal(j.slug)}
                        className={cx("flex items-start gap-2.5 rounded-card border p-3 text-left transition", on ? cx(t.chipBorder, t.soft) : "border-line bg-space-2 hover:border-yin-light")}>
                        <span className="mt-0.5 shrink-0">{skinFor(j.slug).glyph}</span>
                        <span className="min-w-0">
                          <span className={cx("block text-[14px] font-bold", on ? t.text : "text-ink")}>{j.name}</span>
                          <span className="mt-0.5 block text-[12px] leading-snug text-ink-3">{j.tagline}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )
          )}
          {revising && journal && <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">Revising for <JournalBadge name={chosen?.name || journal} slug={journal} /></p>}
          {revising && latest && (
            <div>
              <p className="mb-1.5 text-[13px] font-semibold text-ink-2">What the reviewer asked for <span className="font-normal text-ink-3">— expand to reread the report you're addressing</span></p>
              <ReviewRoundCard r={latest} defaultOpen={false} />
            </div>
          )}
          {!revising && (
            <Lbl text="Title" ok={title.trim().length >= 8}>
              <input className={cx(field, "mt-1")} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A clear, specific title" /></Lbl>
          )}
          <Lbl text="Abstract & claims" ok={abstract.trim().length >= 40}>
            <textarea className={cx(field, "mt-1 min-h-[140px]")} value={abstract} onChange={(e) => setAbstract(e.target.value)} placeholder="What you did, what you found, and the key numbers/figures the reviewer should be able to reproduce." /></Lbl>
          <p className="pt-1 text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-3">Step 1 — the two prerequisites (create once, reuse across submissions)</p>
          <ArtifactPicker kind="dataset" selected={datasetId} onSelect={setDatasetId}
            hint="the open data your paper is built on — registered first, validated by the platform"
            accept=".csv,.tsv,.json,.jsonl,.parquet,.xlsx,.zip,.gz,.h5,.nc" placeholder="https://…/data.csv" />
          <ArtifactPicker kind="model" selected={modelId} onSelect={setModelId}
            hint="your code bundle (zip) carrying the standard reproduction contract"
            accept=".zip" placeholder="https://…/model.zip" />
          <p className="pt-1 text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-3">Step 2 — the manuscript</p>
          <ArtefactField label="Manuscript" hint="a zipped LaTeX project (our class recommended)" accept=".zip,.tar,.tgz,.gz,.tex" value={paper} setValue={setPaper} placeholder="https://…/paper.zip" />
          {!revising && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-card border border-line bg-space-2 p-3.5 text-[13px] leading-relaxed text-ink-2">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-yang" />
              <span><b className="text-ink">Publication agreement.</b> I am an author of this work, it is original and mine to publish, and all co-authors consent. I agree it will be reviewed by an automated AI that downloads and runs my code on my data, and that if accepted it will be published open access under <b className="text-ink">CC BY 4.0</b> with a permanent DOI. The submission and every round of review are public; corrections or retraction may follow if problems are found.</span>
            </label>
          )}
          {err && <p className="rounded-field border border-rose-400/40 bg-rose-400/[0.08] px-3 py-2 text-[13px] text-rose-300">{err}</p>}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button onClick={go} disabled={busy || !valid} className="rounded-field bg-yang px-4 py-2 text-[14px] font-bold text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
              {busy ? "Submitting…" : revising ? "Submit revision" : "Submit for AI review"}</button>
            {!valid && <span className="text-[12px] text-ink-3">Title, abstract, a registered dataset + model, the manuscript{revising ? "" : ", and the agreement"} are required.</span>}
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-3"><b className="text-ink-2">What happens next:</b> your submission enters the public queue; the reviewer compiles your manuscript, runs your code on your data, and posts a verdict + report. If it asks for revisions, address them and resubmit — every round is public.</p>
        </div>
      )}
    </div>
  );
}

/** A labelled field with a live validity tick. */
function Lbl({ text, hint, ok, children }: { text: string; hint?: string; ok: boolean; children: ReactNode }) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
        {text}{hint && <span className="font-normal text-ink-3">— {hint}</span>}
        {ok && <span className="ml-auto text-[12px] font-bold text-yang">✓</span>}
      </span>
      {children}
    </label>
  );
}

/** An artefact input: a public URL, OR upload a file (which is stored and its URL filled in). */
function ArtefactField({ label, hint, accept, value, setValue, placeholder }: { label: string; hint: string; accept: string; value: string; setValue: (v: string) => void; placeholder: string }) {
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState("");
  const [uerr, setUerr] = useState("");
  const field = "w-full rounded-field border border-line bg-space-2 px-3.5 py-2 text-[14px] text-ink placeholder:text-ink-2 focus:border-yin-light focus:outline-none";
  const ok = /^https?:\/\/[^\s]{4,}$/i.test(value.trim());
  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    setUerr(""); setUploading(true); setUploaded("");
    try { const r = await uploadResearchFile(f); setValue(r.url); setUploaded(r.name); }
    catch (er) { setUerr(er instanceof Error ? er.message : "Upload failed"); }
    finally { setUploading(false); e.target.value = ""; }
  }
  return (
    <div>
      <Lbl text={label} hint={hint} ok={ok}>
        <input className={cx(field, "mt-1")} value={value} onChange={(e) => { setValue(e.target.value); setUploaded(""); }} placeholder={placeholder} inputMode="url" />
      </Lbl>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
        <span>or</span>
        <label className={cx("cursor-pointer font-semibold text-yin-light hover:underline", uploading && "pointer-events-none opacity-60")}>
          {uploading ? "uploading…" : "upload a file"}
          <input type="file" accept={accept} className="hidden" disabled={uploading} onChange={onFile} />
        </label>
        {uploaded && <span className="text-yang">✓ uploaded {uploaded}</span>}
        {uerr && <span className="text-rose-400">{uerr}</span>}
      </div>
    </div>
  );
}

/** A submission PREREQUISITE picker: choose one of your registered dataset/model artifacts, or create
 *  one inline (URL or upload → server-side validation). A manuscript cannot be submitted without both. */
function ArtifactPicker({ kind, selected, onSelect, hint, accept, placeholder }: { kind: "dataset" | "model"; selected: number; onSelect: (id: number) => void; hint: string; accept: string; placeholder: string }) {
  const me = currentUser();
  const [mine, setMine] = useState<ResearchArtifact[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [nTitle, setNTitle] = useState("");
  const [nUrl, setNUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const field = "w-full rounded-field border border-line bg-space-2 px-3.5 py-2 text-[14px] text-ink placeholder:text-ink-2 focus:border-yin-light focus:outline-none";
  useEffect(() => {
    let ok = true;
    if (!me?.id) { setMine([]); return; }
    listResearchArtifacts({ kind, author_id: me.id }).then((d) => { if (ok) { setMine(d.items); if (!d.items.length) setCreating(true); } }).catch(() => ok && setMine([]));
    return () => { ok = false; };
  }, [kind, me?.id]);
  async function create() {
    setErr(""); setBusy(true);
    try {
      const a = kind === "dataset"
        ? await createResearchDataset({ title: nTitle, url: nUrl })
        : await createResearchModel({ title: nTitle, url: nUrl });
      setMine((m) => [a, ...(m || [])]);
      onSelect(a.id); setCreating(false); setNTitle(""); setNUrl("");
    } catch (e) { setErr(e instanceof Error ? e.message : "Validation failed"); } finally { setBusy(false); }
  }
  const label = kind === "dataset" ? "Dataset" : "Model";
  return (
    <div className="rounded-card border border-line bg-space-2 p-3.5">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
        {label} <span className="font-normal text-ink-3">— {hint}</span>
        {selected > 0 && <span className="ml-auto text-[12px] font-bold text-yang">✓</span>}
      </p>
      {kind === "model" && (
        <p className="mt-1 text-[12px] leading-relaxed text-ink-3">The zip must carry the <b className="text-ink-2">standard reproduction contract</b>: <code>reproduce.py</code> (or <code>run.sh</code>) taking the dataset path as its argument and writing <code>results.json</code> + figures, a <code>requirements.txt</code>, and your declared key numbers in <code>expected.json</code>. The platform validates the bundle now and <b className="text-ink-2">pre-runs it</b> for every review round.</p>
      )}
      {mine === null ? <p className="mt-2 text-[13px] text-ink-3">Loading your {kind}s…</p> : (
        <div className="mt-2 space-y-1.5">
          {mine.map((a) => (
            <label key={a.id} className={cx("flex cursor-pointer items-start gap-2 rounded-field border p-2.5 text-[13px]", selected === a.id ? "border-yang/60 bg-yang/[0.06]" : "border-line hover:border-yin-light")}>
              <input type="radio" name={`artifact-${kind}`} checked={selected === a.id} onChange={() => onSelect(a.id)} className="mt-0.5 h-3.5 w-3.5 accent-yang" />
              <span className="min-w-0">
                <span className="block font-semibold text-ink">{a.title}</span>
                <span className="block truncate text-[12px] text-ink-3">
                  {kind === "dataset"
                    ? `${a.meta?.format || "data"}${a.meta?.columns?.length ? ` · ${a.meta.columns.length} columns` : ""}`
                    : `${a.meta?.entrypoint || "bundle"}${a.meta?.expected ? ` · ${Object.keys(a.meta.expected).length} declared numbers` : ""}`}
                </span>
              </span>
            </label>
          ))}
          {!creating ? (
            <button type="button" onClick={() => setCreating(true)} className="text-[13px] font-semibold text-yin-light hover:underline">+ New {kind}</button>
          ) : (
            <div className="space-y-2 rounded-field border border-dashed border-line p-2.5">
              <input className={field} value={nTitle} onChange={(e) => setNTitle(e.target.value)} placeholder={`${label} name (≥4 characters)`} />
              <ArtefactField label={`${label} file`} hint={kind === "dataset" ? "public URL or upload" : "a zip — public URL or upload"} accept={accept} value={nUrl} setValue={setNUrl} placeholder={placeholder} />
              {err && <p className="rounded-field border border-rose-400/40 bg-rose-400/[0.08] px-3 py-2 text-[13px] text-rose-300">{err}</p>}
              <button type="button" onClick={create} disabled={busy || nTitle.trim().length < 4 || !/^https?:\/\/[^\s]{4,}$/i.test(nUrl.trim())}
                className="rounded-field bg-yin px-3 py-1.5 text-[13px] font-bold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
                {busy ? "Validating…" : `Register ${kind}`}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const QUEUE_FILTERS: { key: string; label: string; match: (s: Submission) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "review", label: "In review", match: (s) => s.status === "submitted" || s.status === "reviewing" },
  { key: "revisions", label: "In revision", match: (s) => s.status === "revisions-requested" },
  { key: "published", label: "Published", match: (s) => s.status === "accepted" },
  { key: "closed", label: "Concluded", match: (s) => s.status === "rejected" || s.status === "withdrawn" },
];
function SubmissionsView({ open, onClose, onNew, journalSlug, backLabel }: { open: (id: number) => void; onClose: () => void; onNew: () => void; journalSlug?: string; backLabel: string }) {
  const [items, setItems] = useState<Submission[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("all");
  useEffect(() => { let ok = true; listSubmissions(journalSlug ? { journal: journalSlug } : undefined).then((d) => ok && setItems(d.items)).catch(() => { if (ok) { setFailed(true); setItems([]); } }); return () => { ok = false; }; }, [journalSlug]);
  const f = QUEUE_FILTERS.find((x) => x.key === filter)!;
  const shown = items?.filter(f.match) ?? null;
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <button onClick={onClose} className="text-[14px] font-semibold text-yin-light hover:underline">← {backLabel}</button>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[clamp(1.7rem,4vw,2.3rem)] font-extrabold leading-tight">Review queue</h1>
        <button onClick={onNew} className="rounded-field bg-yang px-3.5 py-2 text-[14px] font-bold text-on-accent hover:opacity-90">Submit a manuscript</button>
      </div>
      <p className="mt-2 text-[15px] text-ink-2">Every submission, and every round of AI feedback, is public{journalSlug ? "" : " across all ArtaQuest Journals"}.</p>
      <div className="mt-3"><ReviewStatusBanner journal={journalSlug || undefined} /></div>
      <div role="group" aria-label="Filter submissions" className="mt-4 flex flex-wrap gap-1.5">
        {QUEUE_FILTERS.map((x) => {
          const n = items?.filter(x.match).length;
          return <button key={x.key} aria-pressed={filter === x.key} onClick={() => setFilter(x.key)} className={cx("rounded-pill px-3 py-1 text-[13px] font-semibold", filter === x.key ? "bg-yang text-on-accent" : "bg-space-3 text-ink-2 hover:text-ink")}>{x.label}{n != null ? ` ${n}` : ""}</button>;
        })}
      </div>
      <div className="mt-4 space-y-3">
        {items === null && <div className="space-y-3" role="status" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-card bg-veil/[0.05]" />)}</div>}
        {failed && <p className="rounded-card border border-rose-400/40 bg-rose-400/[0.08] p-6 text-center text-[14px] text-rose-300">Couldn't load the queue. Please refresh.</p>}
        {!failed && shown !== null && !shown.length && <p className="rounded-card border border-line bg-space-2 p-6 text-center text-[14px] text-ink-3">{filter === "all" ? "No submissions yet — be the first." : "Nothing here yet."}</p>}
        {shown?.map((s) => (
          <Card key={s.id} as="button" className="block w-full p-4 text-left transition hover:border-line/80 hover:bg-veil/[0.04]" onClick={() => open(s.id)}>
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-[16px] font-bold leading-snug text-ink">{s.title}</h2>
              <StatusPill status={s.status} />
            </div>
            {!journalSlug && s.journal_name && <div className="mt-1.5"><JournalBadge name={s.journal_name} slug={s.journal} /></div>}
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-ink-3">
              <span>{s.author?.name || "—"}</span>
              <span>round {s.round}</span>
              {s.score ? <span>score {s.score}/100</span> : null}
              {s.reproduced ? <span className="text-yang">reproduced ✓</span> : null}
              {s.doi ? <span className="font-medium text-yin-light">DOI ✓</span> : null}
              {s.updated ? <span>updated {new Date(s.updated * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}</span> : null}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** Accepted, AI-reviewed submissions — a journal's published articles (or, unscoped, the latest across
 *  the whole portal). When `journalSlug` is omitted the cards show a journal badge so the source is clear. */
function PublishedList({ open, journalSlug, heading = "Published articles" }: { open: (id: number) => void; journalSlug?: string; heading?: string }) {
  const [items, setItems] = useState<Submission[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { let ok = true; listSubmissions({ status: "accepted", ...(journalSlug ? { journal: journalSlug } : {}) }).then((d) => ok && setItems(d.items)).catch(() => { if (ok) { setFailed(true); setItems([]); } }); return () => { ok = false; }; }, [journalSlug]);
  return (
    <section className="mt-9">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">{heading}</h2>
      {items === null ? (
        <div className="mt-3 space-y-3" role="status" aria-busy="true">{[0, 1].map((i) => <div key={i} className="h-24 animate-pulse rounded-card bg-veil/[0.05]" />)}</div>
      ) : failed ? (
        <Card className="mt-3 p-8 text-center"><p className="text-[14px] text-rose-300">Couldn't load the published articles. Please refresh.</p></Card>
      ) : !items.length ? (
        <Card className="mt-3 p-8 text-center">
          <p className="text-[15px] font-semibold text-ink">No articles published yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-[13.5px] leading-relaxed text-ink-3">This is a brand-new journal. The first reproducible study to pass automated AI review will appear here — with its open data, code, and a permanent DOI.</p>
        </Card>
      ) : (
        <div className="mt-3 space-y-3">
          {items.map((s) => (
            <Card key={s.id} as="button" className="block w-full p-5 text-left transition hover:border-line/80 hover:bg-veil/[0.04]" onClick={() => open(s.id)}>
              <div className="flex gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {!journalSlug && <JournalBadge name={s.journal_name} slug={s.journal} />}
                    <p className="text-[11.5px] font-semibold uppercase tracking-[0.16em] text-ink-2">{journalSlug ? (s.journal_name || "") : ""}{journalSlug && s.created ? " · " : ""}{s.created ? new Date(s.created * 1000).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : ""}</p>
                  </div>
                  <h3 className="mt-1 text-[20px] font-bold leading-snug text-ink">{s.title}</h3>
                  <p className="mt-1.5 text-[13px] text-ink-2">{s.author?.name || "—"}</p>
                  {s.abstract && <p className="mt-2 line-clamp-3 text-[14px] leading-relaxed text-ink-2">{s.abstract}</p>}
                  <p className="mt-2.5 flex flex-wrap items-center gap-x-2.5 text-[11.5px] text-ink-2">
                    <span className="text-yang">reproduced ✓</span>
                    {s.score ? <span>score {s.score}/100</span> : null}
                    {s.doi ? <span className="font-medium text-yin-light">DOI ✓</span> : null}
                    {(s.kaggle_url || s.colab_url) ? <span className="font-medium text-yin-light">▶ runnable on Kaggle</span> : null}
                    <span>CC BY 4.0</span>
                  </p>
                  <p className="mt-3 text-[13px] font-semibold text-yin-light">Read the article →</p>
                </div>
                {s.thumb_url && (
                  <img src={s.thumb_url} alt="" loading="lazy"
                    className="hidden w-24 shrink-0 self-start rounded-md border border-line bg-white object-cover object-top sm:block sm:w-28"
                    style={{ aspectRatio: "17/22" }}
                    onError={(e) => { e.currentTarget.style.display = "none"; }} />
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

/** Queue transparency on the hub / a journal home: the submissions currently moving through review
 *  (queued, under AI review, or in revision) as compact rows — the pipeline is visible without leaving
 *  the page. Renders nothing when the queue is empty (the status banner already says "0 in the queue"). */
function InReviewList({ open, onQueue, journalSlug }: { open: (id: number) => void; onQueue: () => void; journalSlug?: string }) {
  const [items, setItems] = useState<Submission[] | null>(null);
  useEffect(() => {
    let ok = true;
    listSubmissions(journalSlug ? { journal: journalSlug } : undefined)
      .then((d) => ok && setItems(d.items.filter((s) => s.status === "submitted" || s.status === "reviewing" || s.status === "revisions-requested")))
      .catch(() => ok && setItems([]));
    return () => { ok = false; };
  }, [journalSlug]);
  if (!items?.length) return null;
  return (
    <section className="mt-9">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">In review now</h2>
        <button onClick={onQueue} className="text-[12.5px] font-semibold text-yin-light hover:underline">Full queue →</button>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-3">Every submission — and every round of AI feedback — is public from the moment it enters the queue</p>
      <div className="mt-3 space-y-2">
        {items.map((s) => (
          <Card key={s.id} as="button" className="block w-full p-3.5 text-left transition hover:border-line/80 hover:bg-veil/[0.04]" onClick={() => open(s.id)}>
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-ink">{s.title}</span>
              <StatusPill status={s.status} />
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-ink-3">
              {!journalSlug && s.journal_name ? <JournalBadge name={s.journal_name} slug={s.journal} /> : null}
              <span>{s.author?.name || "—"}</span>
              <span>round {s.round}</span>
            </p>
          </Card>
        ))}
      </div>
    </section>
  );
}

// ── Interactive result charts (data-only specs from the reviewer → safe SVG with hover) ─────────────
// A two-colour-derived, colour-blind-safe palette: the brand blue + gold, then tints/greys. Class is
// NEVER carried by colour alone — series also differ by dash pattern and marker SHAPE, so a figure
// reads correctly in greyscale (WCAG 1.4.1).
const CHART_COLORS = ["#2352E8", "#E8B923", "#4A72FF", "#f0cd57", "#8ec5ff", "#c0922a", "#a6a8b0"];
// Marker shapes, one per series index — the non-colour channel that distinguishes classes.
type MarkerShape = "circle" | "square" | "triangle" | "diamond";
const MARKERS: MarkerShape[] = ["circle", "square", "triangle", "diamond", "circle", "square", "triangle"];
/** A filled or open marker of the given shape, centred at (cx,cy). `open` draws an outline only (the
 *  non-emphasis encoding in dot plots), so class is distinguishable by fill AND shape, not colour alone. */
function Marker({ shape, cx: mx, cy: my, r, color, open, strokeW = 1.4 }: { shape: MarkerShape; cx: number; cy: number; r: number; color: string; open?: boolean; strokeW?: number }) {
  const fill = open ? "none" : color;
  const common = { fill, stroke: color, strokeWidth: open ? strokeW : strokeW * 0.7 } as const;
  if (shape === "square") return <rect x={mx - r} y={my - r} width={r * 2} height={r * 2} rx={1} {...common} />;
  if (shape === "triangle") { const p = `${mx},${my - r * 1.15} ${mx - r * 1.05},${my + r * 0.85} ${mx + r * 1.05},${my + r * 0.85}`; return <polygon points={p} {...common} />; }
  if (shape === "diamond") { const p = `${mx},${my - r * 1.25} ${mx + r * 1.1},${my} ${mx},${my + r * 1.25} ${mx - r * 1.1},${my}`; return <polygon points={p} {...common} />; }
  return <circle cx={mx} cy={my} r={r} {...common} />;
}
const axisTitle = (label?: string, unit?: string) => (label ? (unit ? `${label} (${unit})` : label) : "");

// Anti-collision for reference-line labels: given the anchor positions of every rule label on one axis,
// return the stagger LEVEL (0,1,2…) for the rule at index `k` — bumped to the next level whenever it sits
// within `gap` px of an already-placed label, so two close labels render on different offset rows instead
// of overprinting into mush.
function staggerLevel(positions: number[], k: number, gap: number): number {
  const placed: { pos: number; lvl: number }[] = [];
  for (let i = 0; i <= k; i++) {
    let lvl = 0;
    // raise the level until this row is clear of every earlier label sharing that level
    // eslint-disable-next-line no-loop-func
    while (placed.some((p) => p.lvl === lvl && Math.abs(p.pos - positions[i]) < gap)) lvl++;
    placed.push({ pos: positions[i], lvl });
  }
  return placed[k].lvl;
}

// Some reviewer specs already begin the `title` with "Figure N." (or "Fig. N:"); the reader prepends its
// own "Figure N." label, which doubled the number ("Figure 2. Figure 2. …"). Strip any such leading label
// from the title so the composed caption shows the number exactly once.
const stripFigPrefix = (t?: string) => (t || "").replace(/^\s*(?:figure|fig\.?)\s*\d+\s*[.:—-]\s*/i, "").trim();

// The reviewer numbers tables "Table 1", "Table 2"… and cross-links each mention as `<a href="#tab-1">`, but
// the server sanitiser's table allow-list carries NO `id` (AQ\Science::clean_body_html strips every attribute
// off <table>), so the targets those links point at never existed — tapping "Table 1" hit `getElementById`
// → null and silently did nothing (#144). Equations (<figure id="eq-N">), references (<li id="ref-N">),
// headings and the React-rendered figures (#fig-N) all keep their ids and already work; only tables were
// orphaned. Re-attach the anchor the links expect by giving the Nth body <table> `id="tab-N"` — document
// order is the table number (the journal convention, matching the "#tab-1, #tab-2…" links) — and never
// overwrite a table that already carries an id. This repairs every article (already-published and future)
// without depending on the reviewer or the sanitiser emitting the id.
const withTableAnchors = (html: string) => {
  let n = 0;
  return html.replace(/<table\b[^>]*>/gi, (tag) => {
    n += 1;
    return /\bid=/i.test(tag) ? tag : tag.replace(/^<table/i, `<table id="tab-${n}"`);
  });
};

// Axis-tick / value formatting. Normalise -0 → 0 so a zero tick never renders as "-0.00"; pick a sensible
// precision (integers stay integers, large numbers get thousands separators, otherwise 2 dp with trailing
// zeros trimmed so "0.50" reads "0.5" and "0.00" reads "0").
const fmtNum = (v: number) => {
  if (!Number.isFinite(v)) return "";
  if (Object.is(v, -0) || v === 0) return "0";
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" || s === "" ? "0" : s;
};
const seriesName = (s: ChartSeries, si: number) => s.name || `Series ${si + 1}`;
const dashFor = (s: ChartSeries) => (s.dash ? "6 4" : undefined);

/** The figure frame — caption ("Figure N. Title" / "Figure Nb." for a panel), optional fuller caption
 *  line, the SVG, and a legend whose swatch reflects each series' colour AND its dash/marker (so class
 *  is legible in greyscale). `anchor` controls whether this frame carries the #fig-N id — for a
 *  multi-panel figure only the FIRST panel anchors (the group scrolls into view as one figure). */
function ChartFrame({ spec, fig, panel, anchor = true, children, legend }: { spec: ChartSpec; fig?: number; panel?: string; anchor?: boolean; children: ReactNode; legend: ReactNode }) {
  const title = stripFigPrefix(spec.title);
  return (
    <figure id={fig && anchor ? `fig-${fig}` : undefined} className="my-2 scroll-mt-24">
      {(fig || title) && (
        <figcaption className="mb-1.5 text-[14.5px] font-semibold leading-snug text-ink">
          {fig ? <span className="text-yang">Figure {fig}{panel || ""}.</span> : null}{fig && title ? " " : ""}{title}
        </figcaption>
      )}
      <div className="overflow-hidden rounded-card border border-line bg-space-2 shadow-card">{children}</div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">{legend}</div>
      {spec.caption && <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{spec.caption}</p>}
    </figure>
  );
}

/** Group chart specs into manuscript FIGURES: specs sharing a `figure` number are that figure's panels
 *  (drawn in order, lettered a, b, …). Specs without `figure` number sequentially — pre-panel articles
 *  render exactly as before. Each group renders under ONE #fig-N anchor, so the body's cross-links land
 *  on the whole figure. */
function figureGroups(charts: ChartSpec[]): { fig: number; items: { spec: ChartSpec; panel?: string }[] }[] {
  // Only renderable specs group (≥1 finite value) — a dead spec must not swallow a figure's #fig-N
  // anchor or advertise a quick-jump entry that scrolls nowhere.
  const renderable = charts.filter((c) => (Array.isArray(c.series) ? c.series : []).some((s) => Array.isArray(s.values) && s.values.some((v) => Number.isFinite(v))));
  // Two-pass numbering: undeclared specs count from PAST the highest declared figure, so an
  // auto-number can never collide with (and wrongly join) a later declared figure. Coerce — legacy
  // JSON may carry `figure` as a string.
  const declaredOf = (c: ChartSpec) => { const n = Number(c.figure); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
  let next = 1 + renderable.reduce((m, c) => Math.max(m, declaredOf(c)), 0);
  const groups: { fig: number; items: { spec: ChartSpec; panel?: string }[] }[] = [];
  for (const c of renderable) {
    const figNo = declaredOf(c) || next++;
    let g = groups.find((x) => x.fig === figNo);
    if (!g) { g = { fig: figNo, items: [] }; groups.push(g); }
    g.items.push({ spec: c, panel: c.panel ? String(c.panel).slice(0, 1).toLowerCase() : undefined });
  }
  // Letter unlabelled panels of multi-panel figures, skipping letters a panel already declared —
  // never emit two "Figure Nc." captions.
  for (const g of groups) {
    if (g.items.length <= 1) continue;
    const taken = new Set(g.items.map((it) => it.panel).filter(Boolean));
    let code = 97;
    for (const it of g.items) {
      if (it.panel) continue;
      while (taken.has(String.fromCharCode(code))) code++;
      it.panel = String.fromCharCode(code);
      taken.add(it.panel);
    }
  }
  return groups.sort((a, b) => a.fig - b.fig);
}

/** A legend swatch that encodes the series' style: its line (dashed when `dash`), its marker SHAPE, and
 *  whether the marker is filled (`emphasis`/signature) or open — i.e. the same non-colour channels the
 *  plot uses, so the legend is colour-blind-safe and matches the marks. */
function LegendSwatch({ s, si, dotsMode, barMode }: { s: ChartSeries; si: number; dotsMode?: boolean; barMode?: boolean }) {
  const color = CHART_COLORS[si % CHART_COLORS.length];
  const shape = MARKERS[si % MARKERS.length];
  const open = dotsMode ? !s.emphasis : false;
  // Bar charts get a filled rectangle swatch (a line+marker swatch misrepresented bars as lines).
  if (barMode) return (
    <svg width={16} height={12} viewBox="0 0 16 12" aria-hidden className="shrink-0">
      <rect x={2} y={2} width={12} height={9} rx={1.5} fill={color} opacity={s.emphasis ? 1 : 0.82} />
    </svg>
  );
  return (
    <svg width={26} height={12} viewBox="0 0 26 12" aria-hidden className="shrink-0">
      {!dotsMode && <line x1={2} y1={6} x2={24} y2={6} stroke={color} strokeWidth={s.emphasis ? 2.6 : 1.8} strokeDasharray={dashFor(s)} strokeLinecap="round" />}
      <Marker shape={shape} cx={13} cy={6} r={dotsMode ? 4 : 3.2} color={color} open={open} />
    </svg>
  );
}

/** A 1-D dot/strip plot for a small distribution (`type:"dots"`): x is the value axis; each series is a
 *  row of dots. `emphasis` rows are filled markers, others are open/different-shape (class by SHAPE, not
 *  colour alone). Optional per-point `labels` are shown above each dot. */
function DotStrip({ spec, fig, panel, anchor }: { spec: ChartSpec; fig?: number; panel?: string; anchor?: boolean }) {
  const [hover, setHover] = useState<{ si: number; i: number } | null>(null);
  const series = (Array.isArray(spec.series) ? spec.series : []).filter((s) => Array.isArray(s.values) && s.values.length);
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  if (!series.length || !all.length) return null;
  const W = 700, ML = 24, MR = 24, MT = 40, MB = 44;
  const rowH = 56, rows = series.length; // taller rows leave headroom for staggered per-point labels
  const H = MT + rows * rowH + MB;
  const iw = W - ML - MR;
  let min = Math.min(...all), max = Math.max(...all);
  if (spec.rules) for (const r of spec.rules) if (r.axis === "x" && Number.isFinite(r.value)) { min = Math.min(min, r.value); max = Math.max(max, r.value); }
  if (max === min) max = min + 1;
  const pad = (max - min) * 0.06; min -= pad; max += pad;
  const xPos = (v: number) => ML + ((v - min) / (max - min)) * iw;
  const rowY = (si: number) => MT + si * rowH + rowH / 2;
  const ticks = 6;
  const xticks = Array.from({ length: ticks + 1 }, (_, k) => min + (k / ticks) * (max - min));
  return (
    <ChartFrame spec={spec} fig={fig} panel={panel} anchor={anchor}
      legend={series.map((s, si) => (
        <span key={si} className="inline-flex items-center gap-1.5 text-ink-2"><LegendSwatch s={s} si={si} dotsMode />{seriesName(s, si)}</span>
      ))}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" style={{ touchAction: "pan-y pinch-zoom" }} role="img" aria-label={stripFigPrefix(spec.title) || "Distribution plot"}
        onMouseLeave={() => setHover(null)} onPointerCancel={() => setHover(null)}>
        {/* x grid + ticks */}
        {xticks.map((v, k) => (
          <g key={k}>
            <line x1={xPos(v)} x2={xPos(v)} y1={MT - 6} y2={MT + rows * rowH} stroke="currentColor" className="text-line" strokeWidth={1} opacity={0.3} />
            <text x={xPos(v)} y={MT + rows * rowH + 16} textAnchor="middle" className="fill-ink-2 text-[10px]">{fmtNum(v)}</text>
          </g>
        ))}
        {axisTitle(spec.x_label, spec.x_unit) && <text x={ML + iw / 2} y={H - 6} textAnchor="middle" className="fill-ink-2 text-[11px]">{axisTitle(spec.x_label, spec.x_unit)}</text>}
        {/* reference rules (vertical on the value axis) — labels staggered + edge-anchored so two close
            rules (e.g. a signature median and an all-series median) never overprint into mush */}
        {(() => {
          const xr = spec.rules?.filter((r) => r.axis === "x" && Number.isFinite(r.value)) || [];
          return xr.map((r, k) => {
            const lx = xPos(r.value);
            const lvl = staggerLevel(xr.map((q) => xPos(q.value)), k, 96);
            const anchor = lx > ML + iw * 0.72 ? "end" : lx < ML + iw * 0.28 ? "start" : "middle";
            const dx = anchor === "end" ? -4 : anchor === "start" ? 4 : 0;
            return (
              <g key={`rule-${k}`} pointerEvents="none">
                <line x1={lx} x2={lx} y1={MT - 6 - lvl * 13} y2={MT + rows * rowH} stroke="currentColor" className="text-yang" strokeWidth={1.4} strokeDasharray="5 4" opacity={0.85} />
                {r.label && <text x={lx + dx} y={MT - 10 - lvl * 13} textAnchor={anchor} className="fill-yang text-[10px] font-semibold">{r.label}</text>}
              </g>
            );
          });
        })()}
        {/* rows of dots */}
        {series.map((s, si) => {
          const color = CHART_COLORS[si % CHART_COLORS.length];
          const shape = MARKERS[si % MARKERS.length];
          const open = !s.emphasis;
          const y = rowY(si);
          // Per-point labels (e.g. instance counts) collided into mush when dots clustered. Stagger any
          // labelled point UP onto a clear level (capped) so close labels never overprint each other.
          const labelled = s.values.map((v, i) => ({ v, i })).filter((p) => Number.isFinite(p.v) && s.labels?.[p.i] != null);
          const lblX = labelled.map((p) => xPos(p.v));
          const lvlByI: Record<number, number> = {};
          labelled.forEach((p, k) => { lvlByI[p.i] = Math.min(2, staggerLevel(lblX, k, 22)); });
          return (
            <g key={si}>
              <text x={ML} y={y - 19} className="fill-ink-2 text-[10px]">{seriesName(s, si)}</text>
              {s.values.map((v, i) => {
                if (!Number.isFinite(v)) return null;
                const isH = hover?.si === si && hover?.i === i;
                const lbl = s.labels?.[i];
                const lvl = lvlByI[i] ?? 0;
                return (
                  <g key={i} onMouseEnter={() => setHover({ si, i })} onPointerDown={() => setHover({ si, i })}>
                    {lbl != null && lvl > 0 && <line x1={xPos(v)} x2={xPos(v)} y1={y - 7} y2={y - 10 - lvl * 11} stroke="currentColor" className="text-line" strokeWidth={0.75} opacity={0.5} />}
                    <Marker shape={shape} cx={xPos(v)} cy={y} r={isH ? 6 : 4.4} color={color} open={open} strokeW={1.6} />
                    {lbl != null && <text x={xPos(v)} y={y - 11 - lvl * 11} textAnchor="middle" className="fill-ink-2 text-[9px]">{String(lbl)}</text>}
                  </g>
                );
              })}
            </g>
          );
        })}
        {/* hover tooltip */}
        {hover && Number.isFinite(series[hover.si]?.values[hover.i]) && (() => {
          const v = series[hover.si].values[hover.i];
          const lbl = series[hover.si].labels?.[hover.i];
          const tx = xPos(v), ty = rowY(hover.si);
          const tw = 132, th = lbl != null ? 34 : 22;
          const bx = Math.min(W - MR - tw, Math.max(ML, tx - tw / 2));
          return (
            <g pointerEvents="none">
              <rect x={bx} y={ty - th - 8} width={tw} height={th} rx={6} className="fill-space-1 stroke-line" strokeWidth={1} opacity={0.97} />
              <text x={bx + 9} y={ty - th + 6} className="fill-ink text-[11px] font-semibold">{fmtNum(v)}{spec.x_unit ? ` ${spec.x_unit}` : ""}</text>
              {lbl != null && <text x={bx + 9} y={ty - th + 20} className="fill-ink-2 text-[10px]">{String(lbl)}</text>}
            </g>
          );
        })()}
      </svg>
    </ChartFrame>
  );
}

/** An interactive XY chart from a validated data spec (line/area/bar/scatter): crisp axes + ticks with
 *  units, subtle gridlines, dashed reference `rules`, per-series emphasis (thicker line + filled markers)
 *  and dash, and a hover crosshair with a value tooltip. Pure SVG — no external libs, no scripts. */
function ResultChart({ spec, fig, panel, anchor }: { spec: ChartSpec; fig?: number; panel?: string; anchor?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const type = spec.type || "line";
  if (type === "dots") return <DotStrip spec={spec} fig={fig} panel={panel} anchor={anchor} />;
  const W = 700, H = 320, ML = 56, MR = 18, MT = 16, MB = 48;
  const iw = W - ML - MR, ih = H - MT - MB;
  const xs = Array.isArray(spec.x) ? spec.x : [];
  const series = (Array.isArray(spec.series) ? spec.series : []).filter((s) => Array.isArray(s.values) && s.values.length);
  const n = Math.max(xs.length, ...series.map((s) => s.values.length), 1);
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  if (!series.length || !all.length) return null;
  let min = Math.min(...all), max = Math.max(...all);
  if (type === "bar" || type === "area") min = Math.min(min, 0);
  // include any IQR bands (lo/hi) in the y-range so the ribbon is never clipped
  for (const s of series) {
    if (Array.isArray(s.lo)) for (const v of s.lo) if (Number.isFinite(v)) min = Math.min(min, v);
    if (Array.isArray(s.hi)) for (const v of s.hi) if (Number.isFinite(v)) max = Math.max(max, v);
  }
  // include horizontal rules in the y-range so an annotation line is always on-screen
  if (spec.rules) for (const r of spec.rules) if (r.axis === "y" && Number.isFinite(r.value)) { min = Math.min(min, r.value); max = Math.max(max, r.value); }
  if (max === min) max = min + 1;
  // Pad the TOP so the tallest mark isn't flush with the frame. Bars/areas must grow from a TRUE zero
  // baseline — never pad the axis below zero (a floating sub-zero baseline is what made the bars look
  // broken, e.g. an axis starting at -4.73). Other chart types pad both ends.
  const pad = (max - min) * 0.06; max += pad;
  if ((type === "bar" || type === "area") && min >= 0) min = 0; else min -= pad;
  // Bar charts place each category in an equal-width BAND (centred), not at the line-chart edge positions
  // i/(n-1) — which for 2 categories slammed them against the far left/right of the frame.
  const band = iw / n;
  const xPos = (i: number) => type === "bar" ? ML + (i + 0.5) * band : (n <= 1 ? ML + iw / 2 : ML + (i / (n - 1)) * iw);
  const yPos = (v: number) => MT + ih - ((v - min) / (max - min)) * ih;
  const xLabel = (i: number) => { const v = xs[i]; return v == null ? String(i) : (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v)); };
  const ticks = 5;
  const yticks = Array.from({ length: ticks + 1 }, (_, k) => min + (k / ticks) * (max - min));
  const fmt = fmtNum;
  // x labels: show at most ~12 to avoid crowding
  const step = Math.max(1, Math.ceil(n / 12));
  // Pointer events cover mouse AND touch: on a phone, a tap (pointerdown) pins the readout and a
  // horizontal drag scrubs it — while `touch-action: pan-y` on the svg leaves vertical swipes to the
  // page, so a chart never traps scrolling.
  const onMove = (e: ReactPointerEvent<SVGSVGElement> | ReactMouseEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    // Bars sit at BAND CENTRES (xPos uses (i+0.5)·band) — mapping the pointer with the line-chart
    // edge formula highlighted the wrong bar for up to half a band; pick the band the pointer is IN.
    const i = type === "bar" ? Math.floor((px - ML) / band) : Math.round(((px - ML) / iw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  // Touch fires pointerleave right after pointerup — clearing there would erase the just-pinned tap
  // readout. Only a MOUSE leaving the chart clears it (touch clears via pointercancel/next tap).
  const onLeave = (e: ReactPointerEvent<SVGSVGElement>) => { if (e.pointerType === "mouse") setHover(null); };
  const xTitle = axisTitle(spec.x_label, spec.x_unit);
  const yTitle = axisTitle(spec.y_label, spec.y_unit);
  const gid = (si: number) => `aqgrad-${fig ?? 0}-${si}`;
  return (
    <ChartFrame spec={spec} fig={fig} panel={panel} anchor={anchor}
      legend={<>
        {series.map((s, si) => {
          const filler = !s.emphasis && !s.lo && si >= 4 && series.length > 6;
          return (
            <span key={si} className={cx("inline-flex items-center gap-1.5", filler ? "text-ink-3 opacity-70" : "text-ink-2")}>
              <LegendSwatch s={s} si={si} barMode={type === "bar"} />{seriesName(s, si)}{s.lo && s.hi ? <span className="text-ink-3"> + IQR band</span> : null}{hover !== null && Number.isFinite(s.values[hover]) ? <b className="text-ink"> {fmt(s.values[hover])}</b> : null}
            </span>
          );
        })}
        {hover !== null && <span className="text-ink-3">at {xLabel(hover)}</span>}
      </>}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" style={{ touchAction: "pan-y pinch-zoom" }} role="img" aria-label={stripFigPrefix(spec.title) || "Result chart"}
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={onLeave} onPointerCancel={() => setHover(null)}>
        <defs>
          {series.map((_, si) => (
            <linearGradient key={si} id={gid(si)} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS[si % CHART_COLORS.length]} stopOpacity={0.34} />
              <stop offset="100%" stopColor={CHART_COLORS[si % CHART_COLORS.length]} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        {/* IQR / uncertainty bands (lo→hi) — a translucent ribbon drawn BEHIND the lines */}
        {series.map((s, si) => {
          if (!Array.isArray(s.lo) || !Array.isArray(s.hi)) return null;
          const color = CHART_COLORS[si % CHART_COLORS.length];
          const top: string[] = [], bot: string[] = [];
          for (let i = 0; i < n; i++) {
            const lo = s.lo[i], hi = s.hi[i];
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
            top.push(`${xPos(i)},${yPos(hi)}`);
            bot.push(`${xPos(i)},${yPos(lo)}`);
          }
          if (top.length < 2) return null;
          return <polygon key={`band-${si}`} points={`${top.join(" ")} ${bot.reverse().join(" ")}`} fill={color} opacity={0.16} stroke="none" pointerEvents="none" />;
        })}
        {/* y grid + ticks */}
        {yticks.map((v, k) => (
          <g key={k}>
            <line x1={ML} x2={W - MR} y1={yPos(v)} y2={yPos(v)} stroke="currentColor" className="text-line" strokeWidth={1} opacity={k === 0 ? 0.8 : 0.3} />
            <text x={ML - 8} y={yPos(v) + 3} textAnchor="end" className="fill-ink-2 text-[10px]">{fmt(v)}</text>
          </g>
        ))}
        {/* x labels + axis baseline */}
        <line x1={ML} x2={W - MR} y1={MT + ih} y2={MT + ih} stroke="currentColor" className="text-line" strokeWidth={1} opacity={0.8} />
        {Array.from({ length: n }).map((_, i) => i % step === 0 ? <g key={i}><line x1={xPos(i)} x2={xPos(i)} y1={MT + ih} y2={MT + ih + 4} stroke="currentColor" className="text-line" strokeWidth={1} opacity={0.6} /><text x={xPos(i)} y={H - MB + 16} textAnchor="middle" className="fill-ink-2 text-[10px]">{xLabel(i)}</text></g> : null)}
        {xTitle && <text x={ML + iw / 2} y={H - 6} textAnchor="middle" className="fill-ink-2 text-[11px]">{xTitle}</text>}
        {yTitle && <text x={14} y={MT + ih / 2} textAnchor="middle" transform={`rotate(-90 14 ${MT + ih / 2})`} className="fill-ink-2 text-[11px]">{yTitle}</text>}
        {/* reference rules (horizontal at a y value) — labels staggered when two sit close vertically */}
        {(() => {
          const ys = spec.rules?.filter((r) => r.axis === "y" && Number.isFinite(r.value)) || [];
          return ys.map((r, k) => {
            const lvl = staggerLevel(ys.map((q) => yPos(q.value)), k, 14);
            return (
              <g key={`rule-${k}`} pointerEvents="none">
                <line x1={ML} x2={W - MR} y1={yPos(r.value)} y2={yPos(r.value)} stroke="currentColor" className="text-yang" strokeWidth={1.4} strokeDasharray="5 4" opacity={0.85} />
                {r.label && <text x={W - MR - 4} y={yPos(r.value) - 4 - lvl * 12} textAnchor="end" className="fill-yang text-[10px] font-semibold">{r.label}</text>}
              </g>
            );
          });
        })()}
        {/* reference rules (vertical at an x index) — labels staggered + edge-anchored so they never overprint */}
        {(() => {
          const xsr = spec.rules?.filter((r) => r.axis === "x" && Number.isFinite(r.value) && r.value >= 0 && r.value < n) || [];
          return xsr.map((r, k) => {
            const lvl = staggerLevel(xsr.map((q) => xPos(q.value)), k, 90);
            const lx = xPos(r.value);
            const anchor = lx > ML + iw * 0.7 ? "end" : lx < ML + iw * 0.3 ? "start" : "middle";
            const dx = anchor === "end" ? -4 : anchor === "start" ? 4 : 0;
            return (
              <g key={`rulex-${k}`} pointerEvents="none">
                <line x1={lx} x2={lx} y1={MT} y2={MT + ih} stroke="currentColor" className="text-yang" strokeWidth={1.4} strokeDasharray="5 4" opacity={0.85} />
                {r.label && <text x={lx + dx} y={MT + 11 + lvl * 13} textAnchor={anchor} className="fill-yang text-[10px] font-semibold">{r.label}</text>}
              </g>
            );
          });
        })()}
        {/* hover column highlight */}
        {hover !== null && type !== "bar" && <line x1={xPos(hover)} x2={xPos(hover)} y1={MT} y2={MT + ih} stroke="currentColor" className="text-yin-light" strokeWidth={1} opacity={0.45} strokeDasharray="3 3" />}
        {/* series. With many series (an honest "median + band + a few exemplars" figure can still arrive
            with leftover alphabetical lines), the un-named filler lines are drawn thin + faint so the
            emphasised median/exemplars dominate — without dropping any series the spec sent. */}
        {series.map((s, si) => {
          const color = CHART_COLORS[si % CHART_COLORS.length];
          const shape = MARKERS[si % MARKERS.length];
          if (type === "bar") {
            // Cap the bar width so a few categories don't yield enormous bars; group the series side by side
            // centred on the band centre (xPos(i)), with a small gap between bars in a group.
            const bw = Math.min(46, Math.max(2, (band * 0.72) / series.length));
            const groupW = bw * series.length;
            const y0 = yPos(Math.max(min, 0)); // the zero (or axis-floor) baseline bars grow from
            return <g key={si}>{s.values.map((v, i) => Number.isFinite(v) ? <rect key={i} x={xPos(i) - groupW / 2 + si * bw + bw * 0.08} y={yPos(Math.max(v, 0))} width={bw * 0.84} height={Math.max(0.5, Math.abs(yPos(v) - y0))} rx={Math.min(2.5, bw / 4)} fill={color} opacity={hover === null || hover === i ? 1 : 0.45} /> : null)}</g>;
          }
          const filler = !s.emphasis && !s.lo && si >= 4 && series.length > 6;
          const pts = s.values.map((v, i) => Number.isFinite(v) ? `${xPos(i)},${yPos(v)}` : null).filter(Boolean).join(" ");
          const lw = s.emphasis ? 3 : filler ? 1.2 : 2.2;
          const lineOp = filler ? (hover !== null ? 0.5 : 0.32) : 1;
          return (
            <g key={si}>
              {type === "area" && <polygon points={`${ML},${yPos(min)} ${pts} ${ML + iw},${yPos(min)}`} fill={`url(#${gid(si)})`} />}
              {type !== "scatter" && <polyline points={pts} fill="none" stroke={color} strokeWidth={lw} strokeDasharray={dashFor(s)} strokeLinejoin="round" strokeLinecap="round" opacity={lineOp} />}
              {(type === "scatter" || s.emphasis || (n <= 60 && !filler)) && s.values.map((v, i) => Number.isFinite(v) ? <Marker key={i} shape={shape} cx={xPos(i)} cy={yPos(v)} r={hover === i ? 4.6 : (s.emphasis ? 3.2 : 2.4)} color={color} open={!s.emphasis && type !== "scatter"} strokeW={1.4} /> : null)}
              {hover !== null && type !== "scatter" && Number.isFinite(s.values[hover]) && <Marker shape={shape} cx={xPos(hover)} cy={yPos(s.values[hover])} r={4.6} color={color} strokeW={1.5} />}
            </g>
          );
        })}
        {/* floating tooltip card */}
        {hover !== null && (() => {
          const rows = series.map((s, si) => ({ c: CHART_COLORS[si % CHART_COLORS.length], name: seriesName(s, si), v: s.values[hover] })).filter((r) => Number.isFinite(r.v));
          if (!rows.length) return null;
          const tw = 158, th = 20 + rows.length * 15, tx = xPos(hover);
          const bx = Math.min(W - MR - tw, Math.max(ML, tx > ML + iw * 0.55 ? tx - tw - 10 : tx + 10));
          return (
            <g pointerEvents="none">
              <rect x={bx} y={MT + 4} width={tw} height={th} rx={6} className="fill-space-1 stroke-line" strokeWidth={1} opacity={0.97} />
              <text x={bx + 9} y={MT + 19} className="fill-ink-2 text-[10px]">{spec.x_label ? `${spec.x_label}: ` : ""}{xLabel(hover)}{spec.x_unit ? ` ${spec.x_unit}` : ""}</text>
              {rows.map((r, i) => (
                <g key={i}>
                  <rect x={bx + 9} y={MT + 27 + i * 15} width={9} height={9} rx={2} fill={r.c} />
                  <text x={bx + 23} y={MT + 35 + i * 15} className="fill-ink-2 text-[11px]">{r.name.slice(0, 15)}</text>
                  <text x={bx + tw - 9} y={MT + 35 + i * 15} textAnchor="end" className="fill-ink text-[11px] font-semibold">{fmt(r.v)}</text>
                </g>
              ))}
            </g>
          );
        })()}
      </svg>
    </ChartFrame>
  );
}

/** A lazy collapsible — children mount only when expanded, so an embedded viewer (PDF/CSV/code) loads on
 *  demand rather than on page render. Keeps the article page clean (the full text is the primary read). */
function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-card border border-line bg-space-2">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-[13.5px] font-semibold text-ink-2 hover:text-ink">
        <span>{label}</span>
        <span className="text-[16px] leading-none text-ink-3">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="border-t border-line p-3">{children}</div>}
    </div>
  );
}

/** Top reading-progress bar driven by document scroll (a small Nature-reader touch). */
function useReadingProgress() {
  const [p, setP] = useState(0);
  useEffect(() => {
    const on = () => { const h = document.documentElement; const max = h.scrollHeight - h.clientHeight; setP(max > 0 ? Math.min(100, Math.max(0, (h.scrollTop / max) * 100)) : 0); };
    on(); window.addEventListener("scroll", on, { passive: true }); window.addEventListener("resize", on);
    return () => { window.removeEventListener("scroll", on); window.removeEventListener("resize", on); };
  }, []);
  return p;
}





/**
 * The enlarged view of a figure. It declares role="dialog" aria-modal="true", so it has to behave like
 * one: Escape closes it, focus moves into it and stays there, and focus goes back where it came from on
 * close. Without that the overlay covered the article while Tab walked invisibly through the text
 * underneath it — a keyboard or screen-reader user could open the lightbox and have no way out but a
 * page reload, on a control that announces itself as modal.
 *
 * There is exactly one focusable element in here, so the trap is simply: keep it focused.
 */
function FigureLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "Tab") { e.preventDefault(); closeRef.current?.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      returnTo?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={onClose}
      role="dialog" aria-modal="true" aria-label="Figure, enlarged">
      <img src={src} alt="Figure, enlarged" className="max-h-[92vh] max-w-[92vw] rounded-card" />
      <button ref={closeRef} onClick={onClose} aria-label="Close the figure"
        className="absolute right-5 top-5 rounded-full bg-space-2 px-3 py-1 text-[14px] font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yang/60">✕</button>
    </div>
  );
}

/** Full-text, Nature-style reader for a PUBLISHED article: progress bar, masthead with badges + action
 *  bar, a sticky table of contents, the sanitised full-text body (server-rendered HTML from the reviewer)
 *  with figure lightbox + working reference cross-links, then the end matter (artefacts, reproduction, AI
 *  review, citation, discussion). The body HTML is sanitised server-side (AQ\Science::clean_body_html, a
 *  strict wp_kses allowlist) so it is safe to render. */
function ArticleReader({ s, onClose, backLabel }: { s: Submission; onClose: () => void; backLabel: string }) {
  const JOURNAL = s.journal_name || "ArtaQuest Journals";
  const progress = useReadingProgress();
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const readBtnRef = useRef<HTMLButtonElement | null>(null);
  const restoreReadFocus = useCallback(() => readBtnRef.current?.focus(), []);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Give in-body tables the `id="tab-N"` their cross-reference links point at (see withTableAnchors) so
  // "Table 1" scrolls to its table; figures/equations/references/headings already carry their ids.
  const body = useMemo(() => withTableAnchors(s.body_html || ""), [s.body_html]);
  // Typeset the LaTeX in the article body once it is in the DOM — and KEEP it typeset. KaTeX walks the
  // rendered HTML's text nodes after dangerouslySetInnerHTML paints; `watchMath` also re-typesets if the
  // body reverts to raw `\(..\)` source (a re-render re-injecting the HTML, or the i18n engine swapping a
  // math-bearing text node while reading in another language), which previously left the maths as raw
  // source until a full refresh and again after scrolling (#143). It only touches the `\(..\)`/`\[..\]`
  // delimiters, never the <a href="#…">/<img> elements the onBodyClick handlers below act on. Re-keying
  // on `s.id`+`body` re-runs it when navigating between articles.
  useEffect(() => {
    containWideTables(bodyRef.current);       // wrap wide tables so they scroll within the column, not past the viewport
    return watchMath(bodyRef.current, "auto"); // typeset + keep math typeset (returns the observer cleanup)
  }, [s.id, body]);
  const charts = useMemo<ChartSpec[]>(() => { try { const a = JSON.parse(s.charts || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } }, [s.charts]);
  const toc = useMemo(() => {
    const out: { level: number; id: string; text: string }[] = [];
    const re = /<(h2|h3)\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) out.push({ level: m[1].toLowerCase() === "h3" ? 3 : 2, id: m[2], text: m[3].replace(/<[^>]+>/g, "").trim() });
    return out;
  }, [body]);
  // Journal-grade dating: received = submission, published = the acceptance (the record's last update).
  const fmtDay = (t?: number) => t ? new Date(t * 1000).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "";
  const received = fmtDay(s.created), published = fmtDay(s.updated) || fmtDay(s.created);
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}/research/?submission=${s.id}` : "";
  const shareMessage = `New on ${JOURNAL}: “${s.title}” — open access, AI-reviewed, and fully reproducible (open data + code). Read it:`;
  const jump = (e: ReactMouseEvent, id: string) => { e.preventDefault(); const el = document.getElementById(id); if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); history.replaceState(null, "", `#${id}`); } };
  // In-body clicks: an internal cross-reference (a citation [1] → #ref-1, or "Figure 1" → #fig-1) smooth-
  // scrolls to its target and briefly highlights it; a figure image opens the lightbox.
  const onBodyClick = (e: ReactMouseEvent) => {
    const t = e.target as HTMLElement;
    const a = t.closest?.("a") as HTMLAnchorElement | null;
    const href = a?.getAttribute("href") || "";
    if (href.startsWith("#")) {
      e.preventDefault();
      const el = document.getElementById(href.slice(1));
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        history.replaceState(null, "", href);
        el.style.transition = "background-color .5s"; el.style.backgroundColor = "rgba(232,185,35,0.18)";
        setTimeout(() => { el.style.backgroundColor = ""; }, 1500);
      }
      return;
    }
    if (t.tagName === "IMG") { const src = (t as HTMLImageElement).src; if (src) setLightbox(src); }
  };
  // Read-mode optimised (lit-backed): body + lists + cells + quotes use PRIMARY ink (the Lc 75-90 reading
  // plateau, not the muted secondary), body leading 1.6 (was 1.78 — too loose hurts line-tracking; matches
  // the abstract + the published measurement, APCA paper DOI 10.5281/zenodo.21046102), prose
  // links use the accessible yin-ink (the lightened brand blue) not yin-light (Lc ~32 on dark), tables 14px.
  const prose = "[&_h2]:mt-10 [&_h2]:scroll-mt-24 [&_h2]:text-[22px] [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-ink [&_h3]:mt-7 [&_h3]:scroll-mt-24 [&_h3]:text-[18px] [&_h3]:font-bold [&_h3]:text-ink [&_p]:mt-4 [&_p]:text-[16px] [&_p]:leading-[1.6] [&_p]:text-ink [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:text-ink [&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:text-ink [&_li]:mt-1.5 [&_li]:leading-relaxed [&_a]:text-yin-ink [&_a]:font-medium hover:[&_a]:underline [&_figure]:my-7 [&_figure]:text-center [&_img]:mx-auto [&_img]:max-w-full [&_img]:rounded-card [&_img]:border [&_img]:border-line [&_img]:cursor-zoom-in [&_figcaption]:mt-2 [&_figcaption]:text-[13px] [&_figcaption]:leading-relaxed [&_figcaption]:text-ink-2 [&_table]:my-5 [&_table]:scroll-mt-24 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[14px] [&_th]:border [&_th]:border-line [&_th]:bg-space-2 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_td]:border [&_td]:border-line [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:text-ink [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-yin/40 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-ink [&_sup]:text-[11px] [&_sup_a]:font-semibold [&_sup_a]:text-yin-ink [&_code]:rounded [&_code]:bg-space-1 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_section]:mt-2 [&_section]:scroll-mt-24";
  // The shared-TOC item set for the inline reader: Abstract + the body's h2/h3 + the end-matter sections.
  const readerToc = useMemo<TocItem[]>(() => {
    const out: TocItem[] = [{ id: "abstract", label: "Abstract", level: 2 }];
    for (const t of toc) out.push({ id: t.id, label: t.text, level: t.level });
    if (charts.length > 0) out.push({ id: "figures", label: "Figures", level: 2 });
    out.push({ id: "availability", label: "Data & code", level: 2 });
    out.push({ id: "reproduce", label: "Reproduce", level: 2 });
    out.push({ id: "review", label: "AI review", level: 2 });
    out.push({ id: "cite", label: "How to cite", level: 2 });
    out.push({ id: "discussion", label: "Discussion", level: 2 });
    return out;
  }, [toc, charts.length]);
  return (
    <>
      <div className="fixed left-0 top-0 z-40 h-[3px] bg-yang transition-[width] duration-150" style={{ width: `${progress}%` }} aria-hidden />
      <div className="flex flex-col py-1">
        <button onClick={onClose} className="text-[14px] font-semibold text-yin-light hover:underline">← {backLabel}</button>
        <header className="mt-4 border-b border-line pb-6">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-3">
            <span>{JOURNAL} · Article</span>
            {s.reproduced && <span className="text-yang">· Reproduced ✓</span>}
          </p>
          {s.template_ok === false && (
            <p className="mt-3 rounded-card border border-yang/30 bg-yang/[0.06] px-3 py-2 text-[12.5px] text-ink-2">⚠ This manuscript was not written with the journal template. Authors: please use the <a className="font-semibold text-yin-light hover:underline" href="https://artaquest.com/papers/artaquest-latex-template.zip">{JOURNAL} LaTeX template</a> for consistent formatting and metadata.</p>
          )}
          <h1 className="mt-3 text-[clamp(1.8rem,4.2vw,2.6rem)] font-extrabold leading-[1.15]">{s.title}</h1>
          <p className="mt-3 text-[15px] text-ink">
            {s.author?.slug ? <a className="font-bold hover:text-yin-light hover:underline" href={`/u/${s.author.slug}`}>{s.author.name}</a> : <b>{s.author?.name || "—"}</b>}
            <span className="text-ink-3"> · ArtaQuest Foundation</span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3">
            {received && received !== published && <span>Received {received} ·</span>}
            {published && <span>Published {published}</span>}
            <span>· Open access · CC BY 4.0 · AI-reviewed</span>
            {s.doi && <span>· <a className="font-medium text-yin-light hover:underline" href={doiShort(s.id)} target="_blank" rel="noopener noreferrer">DOI ↗</a> <MetricsBadge doi={s.doi} /></span>}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button ref={readBtnRef} type="button" onClick={() => setReading(true)} aria-haspopup="dialog"
              title="Open a distraction-free, full-screen reading view"
              className="inline-flex items-center gap-1.5 rounded-field border border-yang/50 bg-yang/[0.12] px-3 py-1.5 text-[13px] font-semibold text-yang transition-colors hover:border-yin-light hover:bg-yin/[0.12] hover:text-yin-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yin-light">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 5h7a3 3 0 0 1 3 3v11a2.5 2.5 0 0 0-2.5-2.5H2zM22 5h-7a3 3 0 0 0-3 3v11a2.5 2.5 0 0 1 2.5-2.5H22z" /></svg>
              Read
            </button>
            {(s.pdf_url || fileExt(s.paper_url) === "pdf") && <a href={s.pdf_url || s.paper_url} target="_blank" rel="noopener noreferrer" className="rounded-field border border-line px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-veil/[0.04]">PDF</a>}
            <a href="#cite" onClick={(e) => jump(e, "cite")} className="rounded-field border border-line px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-veil/[0.04]">Cite</a>
            <SharePanel title={s.title} url={shareUrl} message={shareMessage} dialogLabel="Share this article" />
            {/* The Open-on-Kaggle badge lives once, in the Reproduce section below — not in the masthead. */}
          </div>
        </header>

        <div className="mt-6 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10 xl:grid-cols-[224px_minmax(0,1fr)_236px] xl:gap-12">
          <aside className="hidden lg:block">
            <ReadingToc className="sticky top-6 max-h-[calc(100vh-3rem)]" items={readerToc} />
          </aside>

          <article className="min-w-0">
            <section id="abstract" className="scroll-mt-24">
              <div className="rounded-card border border-line bg-space-2 p-4">
                <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">Abstract</h2>
                <div className="mt-1.5 [&_p]:text-[16px] [&_p]:leading-[1.6] [&_p]:text-ink"><MarkdownLite text={s.abstract || ""} /></div>
              </div>
            </section>

            {/* The reviewer-rendered full text (sanitised server-side). Figure clicks open a lightbox;
                LaTeX (\(..\) inline, \[..\] display) is typeset by KaTeX after mount (see effect above). */}
            <div ref={bodyRef} className={cx("mt-2 aq-article-body", prose)} onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: body }} />

            {charts.length > 0 && (
              <section id="figures" className="mt-10 scroll-mt-24 border-t border-line pt-6">
                <h2 className="text-[16px] font-bold">Figures</h2>
                <p className="mt-1 text-[13px] text-ink-3">Generated from the reproduced data and drawn in the journal's interactive style — hover for values.</p>
                <div className="mt-4 space-y-7">{figureGroups(charts).map((g) => (
                  <div key={g.fig} id={`fig-${g.fig}`} className="scroll-mt-24 space-y-4">
                    {g.items.map((it, k) => <ResultChart key={k} spec={it.spec} fig={g.fig} panel={it.panel} anchor={false} />)}
                  </div>
                ))}</div>
              </section>
            )}

            <section id="availability" className="mt-10 scroll-mt-24 border-t border-line pt-6">
              <h2 className="text-[16px] font-bold">Data &amp; code availability</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-3">The manuscript, open data, and open code are public and downloadable — ArtaScience ran the code on the data and confirmed the results reproduce. Expand any artefact to view it inline.</p>
              <ArtefactChips s={s} />
              <div className="mt-4 space-y-2.5">
                {(s.pdf_url || fileExt(s.paper_url) === "pdf") && <Disclosure label="Typeset manuscript (PDF)"><PdfViewer url={s.pdf_url || s.paper_url!} /></Disclosure>}
                {s.data_url && ["csv", "tsv"].includes(fileExt(s.data_url)) && <Disclosure label="Data table"><CsvTable id={s.id} url={s.data_url} /></Disclosure>}
                {s.code_url && <Disclosure label="Source code"><CodeViewer id={s.id} url={s.code_url} /></Disclosure>}
              </div>
            </section>

            {(s.kaggle_url || s.colab_url || s.notebook) && (
              <section id="reproduce" className="mt-10 scroll-mt-24 border-t border-line pt-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-[16px] font-bold">Reproduce in one click</h2>
                  {(s.kaggle_url || s.colab_url) && <a href={s.kaggle_url || s.colab_url} target="_blank" rel="noopener noreferrer" title="Open the reproduction notebook on Kaggle" className="inline-flex h-[26px] items-center gap-1.5 rounded-field border border-yin-light/40 bg-yin/10 px-2.5 text-[12px] font-semibold text-yin-light no-underline transition-colors hover:bg-yin/20 hover:text-ink"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>Open on Kaggle</a>}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-3">Open the notebook in Colab and choose <b className="text-ink-2">Runtime → Run all</b>: it fetches the open code and data and regenerates the results.{s.notebook && <> Or <a className="font-semibold text-yin-light hover:underline" href={"data:application/x-ipynb+json;charset=utf-8," + encodeURIComponent(s.notebook)} download={`reproduce-${s.id}.ipynb`}>download the notebook (.ipynb)</a>.</>}</p>
                {s.notebook && <div className="mt-3"><NotebookPreview json={s.notebook} /></div>}
              </section>
            )}

            <section id="review" className="mt-10 scroll-mt-24 border-t border-line pt-6">
              <h2 className="text-[16px] font-bold">AI review {s.reviews?.length ? `· ${s.reviews.length} round${s.reviews.length > 1 ? "s" : ""}` : ""}</h2>
              <p className="mt-1 text-[13px] text-ink-3">Reviewed by ArtaScience, which ran this code on its open data. <a href="/research/artascience" className="font-semibold text-yin-light hover:underline">See the exact review prompt →</a></p>
              {/* Earlier rounds collapse to their verdict line; the decisive (latest) round opens in full. */}
              <div className="mt-2 space-y-3">{s.reviews?.map((r, i, a) => <ReviewRoundCard key={r.round} r={r} defaultOpen={i === a.length - 1} />)}</div>
            </section>

            {s.doi && (
              <section id="cite" className="mt-10 scroll-mt-24 border-t border-line pt-6">
                <h2 className="text-[16px] font-bold">How to cite</h2>
                <div className="mt-2"><CiteTabs s={s} /></div>
              </section>
            )}

            <section id="discussion" className="mt-10 scroll-mt-24 border-t border-line pt-6">
              {s.thread_id ? <Thread forum="research" slug={String(s.thread_id)} /> : <p className="text-[13px] text-ink-3">Discussion opens with the published article.</p>}
            </section>
            <Foot name={JOURNAL} />
          </article>

          {/* Right rail (xl+) — fills the space beside the reading column with genuinely useful chrome:
              an at-a-glance summary and a figure quick-jump, so the page reads balanced, never empty. */}
          <aside className="hidden xl:block">
            <div className="sticky top-6 space-y-5">
              <div className="rounded-card border border-line bg-space-2 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">At a glance</p>
                <dl className="mt-2.5 space-y-2 text-[12.5px]">
                  <div className="flex items-center justify-between gap-2"><dt className="text-ink-3">Access</dt><dd className="font-semibold text-yang">Open · CC BY 4.0</dd></div>
                  <div className="flex items-center justify-between gap-2"><dt className="text-ink-3">Review</dt><dd className="font-semibold text-yin-light">AI · {s.reviews?.length || 1} round{(s.reviews?.length || 1) > 1 ? "s" : ""}</dd></div>
                  {s.reproduced && <div className="flex items-center justify-between gap-2"><dt className="text-ink-3">Reproduced</dt><dd className="font-semibold text-yang">yes ✓</dd></div>}
                  {s.score ? <div className="flex items-center justify-between gap-2"><dt className="text-ink-3">Score</dt><dd className="font-semibold text-ink">{s.score}/100</dd></div> : null}
                  {published && <div className="flex items-center justify-between gap-2"><dt className="text-ink-3">Published</dt><dd className="font-semibold text-ink">{published}</dd></div>}
                  {s.doi && <div className="border-t border-line pt-2"><dt className="text-ink-3">DOI</dt><dd className="mt-0.5 break-all"><a className="font-medium text-yin-light hover:underline" href={doiShort(s.id)} target="_blank" rel="noopener noreferrer">{doiShort(s.id).replace("https://", "")}</a></dd></div>}
                </dl>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {(s.pdf_url || fileExt(s.paper_url) === "pdf") && <a href={s.pdf_url || s.paper_url} target="_blank" rel="noopener noreferrer" className="rounded-field border border-line px-2.5 py-1 text-[12px] font-semibold text-ink hover:bg-veil/[0.04]">PDF</a>}
                  <a href="#cite" onClick={(e) => jump(e, "cite")} className="rounded-field border border-line px-2.5 py-1 text-[12px] font-semibold text-ink hover:bg-veil/[0.04]">Cite</a>
                </div>
              </div>

              {charts.length > 0 && (
                <div className="rounded-card border border-line bg-space-2 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">Figures</p>
                  <ol className="mt-2 space-y-1.5">
                    {figureGroups(charts).map((g) => (
                      <li key={g.fig}>
                        <a href={`#fig-${g.fig}`} onClick={(e) => jump(e, `fig-${g.fig}`)} className="block text-[12.5px] leading-snug text-ink-3 hover:text-yin-light">
                          <span className="font-semibold text-yang">Fig {g.fig}{g.items.length > 1 ? ` (${g.items[0].panel}–${g.items[g.items.length - 1].panel})` : ""}.</span> {stripFigPrefix(g.items[0].spec.title) || "Figure"}
                        </a>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
      {lightbox && <FigureLightbox src={lightbox} onClose={() => setLightbox(null)} />}
      {reading && (
        <ReadMode
          s={s}
          body={body}
          hasFigures={charts.length > 0}
          figures={charts.length > 0 ? figureGroups(charts).map((g) => (
            <div key={g.fig} id={`fig-${g.fig}`} className="aq-read-fig scroll-mt-24">
              {g.items.map((it, k) => <ResultChart key={k} spec={it.spec} fig={g.fig} panel={it.panel} anchor={false} />)}
            </div>
          )) : undefined}
          onClose={() => setReading(false)}
          returnFocus={restoreReadFocus}
        />
      )}
    </>
  );
}

/** The article page — a published (accepted) article reads like a journal article; in-review
 *  submissions show the live lifecycle, AI feedback, and author actions. */
function SubmissionDetail({ id, onClose, onRevise, backLabel }: { id: number; onClose: () => void; onRevise: (s: Submission) => void; backLabel: string }) {
  const [s, setS] = useState<Submission | null>(null);
  const [missing, setMissing] = useState(false);
  const [actErr, setActErr] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { let ok = true; getSubmission(id).then((d) => ok && setS(d)).catch(() => ok && setMissing(true)); return () => { ok = false; }; }, [id]);
  if (missing) return <div className="mx-auto max-w-3xl px-4 py-10"><button onClick={onClose} className="text-[14px] font-semibold text-yin-light hover:underline">← {backLabel}</button><p className="mt-6 text-ink-3">Article not found.</p></div>;
  if (!s) return <div className="mx-auto max-w-3xl px-4 py-10" role="status" aria-busy="true"><div className="h-7 w-2/3 animate-pulse rounded bg-veil/[0.06]" /><div className="mt-4 h-16 animate-pulse rounded-card bg-veil/[0.05]" /></div>;
  const JOURNAL = s.journal_name || "ArtaQuest Journals";
  // Author-only actions: compare the article's author id to the signed-in user's id (the backend also
  // enforces this; this just avoids showing dead buttons to non-authors).
  const cu = currentUser();
  const mine = !!cu && s.author?.id != null && cu.id === s.author.id;
  const published = s.status === "accepted";
  // A published article with full-text HTML gets the Nature-style reader (TOC, body, figures, end matter).
  if (published && s.body_html) return <ArticleReader s={s} onClose={onClose} backLabel={backLabel} />;
  const date = s.created ? new Date(s.created * 1000).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "";
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}/research/?submission=${s.id}` : "";
  const share = async () => {
    try {
      if (navigator.share) { await navigator.share({ title: s.title, url: shareUrl }); }
      else { await navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    } catch { /* user cancelled / no permission */ }
  };
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <button onClick={onClose} className="text-[14px] font-semibold text-yin-light hover:underline">← {backLabel}</button>

      <header className="mt-4">
        <div className="flex items-start justify-between gap-3">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-3"><span>{JOURNAL}{published ? " · Article" : ""}</span></p>
          <StatusPill status={s.status} />
        </div>
        <h1 className="mt-2 text-[clamp(1.7rem,4vw,2.4rem)] font-extrabold leading-tight">{s.title}</h1>
        <p className="mt-2 text-[14px] text-ink">
          {s.author?.slug
            ? <a className="font-bold hover:text-yin-light hover:underline" href={`/u/${s.author.slug}`}>{s.author.name}</a>
            : <b>{s.author?.name || "—"}</b>}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-ink-3">
          {date && <span>{date}</span>}
          {!published && <span>· round {s.round}{s.score ? ` · score ${s.score}/100` : ""}</span>}
          {published && s.doi && <span>· <a className="font-medium text-yin-light hover:underline" href={doiShort(s.id)} target="_blank" rel="noopener noreferrer">DOI ↗</a> <MetricsBadge doi={s.doi} /></span>}
          <button onClick={share} className="text-yin-light hover:underline" title="Copy a link to this article">· {copied ? "link copied ✓" : "share"}</button>
        </p>
      </header>

      {!published && <StatusTimeline status={s.status} doi={s.doi || undefined} />}

      {published && s.doi && (
        <div className="mt-5 rounded-card border border-yang/40 bg-yang/[0.07] p-4">
          <p className="text-[14px] text-ink-2"><b className="text-ink">Published, open access.</b> Accepted by automated AI review — the reviewer ran the code on the open data and confirmed the results reproduce — and assigned a permanent DOI. Licensed <b className="text-ink">CC BY 4.0</b>.</p>
          <p className="mt-1.5 text-[13px]">
            <a className="font-semibold text-yin-light hover:underline" href={doiShort(s.id)} target="_blank" rel="noopener noreferrer">{doiShort(s.id).replace("https://", "")}</a>
          </p>
        </div>
      )}

      {s.abstract && (
        <section className="mt-5">
          <div className="rounded-card border border-line bg-space-2 p-4 text-[15px] leading-relaxed text-ink-2">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">Abstract</h2>
            <div className="mt-1.5 [&_p]:text-[15px]"><MarkdownLite text={s.abstract} /></div>
          </div>
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-[16px] font-bold">Manuscript, data &amp; code</h2>
        <ArtefactChips s={s} />
        <div className="mt-4 space-y-2.5">
          {(s.pdf_url || fileExt(s.paper_url) === "pdf") && <Disclosure label="Manuscript (PDF)"><PdfViewer url={s.pdf_url || s.paper_url!} /></Disclosure>}
          {s.data_url && ["csv", "tsv"].includes(fileExt(s.data_url)) && <Disclosure label="Data table"><CsvTable id={s.id} url={s.data_url} /></Disclosure>}
          {s.code_url && <Disclosure label="Source code"><CodeViewer id={s.id} url={s.code_url} /></Disclosure>}
        </div>
      </section>

      {published && (s.colab_url || s.notebook) && (
        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[16px] font-bold">Reproduce in one click</h2>
            {(s.kaggle_url || s.colab_url) && (
              <a href={s.kaggle_url || s.colab_url} target="_blank" rel="noopener noreferrer" title="Open the reproduction notebook on Kaggle — runs on Kaggle's machines, no setup" className="inline-flex h-[26px] items-center gap-1.5 rounded-field border border-yin-light/40 bg-yin/10 px-2.5 text-[12px] font-semibold text-yin-light no-underline transition-colors hover:bg-yin/20 hover:text-ink">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>Open in Colab
              </a>
            )}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-3">ArtaScience reviewed this article by running it. Open the notebook in Colab and choose <b className="text-ink-2">Runtime → Run all</b>: it fetches the open code and data and regenerates the results — nothing to install.{s.notebook && <> Or <a className="font-semibold text-yin-light hover:underline" href={"data:application/x-ipynb+json;charset=utf-8," + encodeURIComponent(s.notebook)} download={`reproduce-${s.id}.ipynb`}>download the notebook (.ipynb)</a> to run it locally.</>}</p>
          {s.notebook && <div className="mt-3"><NotebookPreview json={s.notebook} /></div>}
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-[16px] font-bold">AI review {s.reviews?.length ? `· ${s.reviews.length} round${s.reviews.length > 1 ? "s" : ""}` : ""}</h2>
        <div className="mt-2 space-y-3">
          {!s.reviews?.length && (
            <div className="flex items-center gap-2 rounded-card border border-line bg-space-2 p-4 text-[14px] text-ink-2">
              {s.status === "reviewing"
                ? <><span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yin-light" /> ArtaScience is reviewing now — compiling the manuscript, running the code, checking reproducibility.</>
                : <><span className="inline-block h-2 w-2 rounded-full bg-ink-3" /> Queued — the reviewer will pick this up shortly.</>}
            </div>
          )}
          {s.reviews?.map((r, i, a) => <ReviewRoundCard key={r.round} r={r} defaultOpen={i === a.length - 1} />)}
        </div>
      </section>

      {published && s.doi && (
        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-[16px] font-bold">How to cite</h2>
          <div className="mt-2"><CiteTabs s={s} /></div>
        </section>
      )}

      {mine && s.status !== "accepted" && s.status !== "withdrawn" && (
        <div className="mt-6 border-t border-line pt-5">
          <div className="flex flex-wrap gap-3">
            {(s.status === "revisions-requested" || s.status === "rejected") && (
              <button onClick={() => onRevise(s)} className="rounded-field bg-yang px-4 py-2 text-[14px] font-bold text-on-accent hover:opacity-90">Submit a revision</button>
            )}
            <button
              onClick={async () => { setActErr(""); if (confirm("Withdraw this submission? This cannot be undone.")) { try { await withdrawSubmission(s.id); setS({ ...s, status: "withdrawn" }); } catch (e) { setActErr(e instanceof Error ? e.message : "Could not withdraw — please try again"); } } }}
              className="rounded-field border border-line px-4 py-2 text-[14px] font-semibold text-ink-2 hover:bg-veil/[0.04]">Withdraw</button>
          </div>
          {actErr && <p className="mt-2 text-[13px] text-rose-300">{actErr}</p>}
        </div>
      )}

      {s.thread_id ? (
        <section className="mt-10 border-t border-line pt-6">
          <Thread forum="research" slug={String(s.thread_id)} />
        </section>
      ) : (
        <section className="mt-10 border-t border-line pt-6">
          <h2 className="text-[18px] font-bold">Discussion</h2>
          <p className="mt-1 text-[13px] text-ink-3">A public discussion opens here once the article is published.</p>
        </section>
      )}

      <Foot name={JOURNAL} />
    </div>
  );
}

function Foot({ name = PORTAL }: { name?: string }) {
  return <p className="mt-10 border-t border-line pt-4 text-[12px] text-ink-3">{name} · open access (CC BY 4.0) · every article reviewed by AI and reproduced from its open data and code.</p>;
}

// ── The shared review model, explained once (reused by the hub + every journal's About) ─────────────
function ReviewModelExplainer() {
  return (
    <p className="text-[15px] leading-relaxed text-ink-2">Every ArtaQuest journal runs a <b className="text-ink">fully automated, end-to-end AI review process</b>. There is no human peer review. The reviewer — ArtaScience, Claude running at maximum effort with tools — clones your code, fetches your data, <b className="text-ink">runs the analysis itself</b>, and checks whether the results reproduce your claims. It returns a reproduced (yes/no) verdict, a score, and a detailed report, and either accepts, requests revisions, or rejects. Revisions loop: address the report, resubmit, and a fresh round is reviewed — for as many rounds as it takes. Only work that <i>reproduces</i> is accepted. Every submission and every round of feedback is public. In the spirit of radical transparency, the reviewer's <a className="font-semibold text-yin-light hover:underline" href="/artascience">exact prompt is published and annotated line by line — see how ArtaScience works →</a></p>
  );
}

// ── The three-step pipeline strip (shared by hub + journal home) ────────────────────────────────────
function PipelineStrip() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {([["1", "Register, then submit", "Register your open dataset + your model (the standard reproduction contract), then submit your LaTeX manuscript on them"], ["2", "Reviewed by running it", "The platform pre-runs your model on your dataset; the AI compiles your manuscript and confirms your results reproduce"], ["3", "Published", "Reproduced work earns a permanent DOI"]] as const).map(([n, t, d]) => (
        <div key={n} className="rounded-card border border-line bg-space-2 p-3.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-yang text-[12px] font-bold text-on-accent">{n}</div>
          <p className="mt-2 text-[14px] font-bold text-ink">{t}</p>
          <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{d}</p>
        </div>
      ))}
    </div>
  );
}

// ── A journal card on the portal hub ────────────────────────────────────────────────────────────────
function JournalCard({ j, onOpen, onSubmit }: { j: Journal; onOpen: () => void; onSubmit: () => void }) {
  const skin = skinFor(j.slug);
  const t = leanTok(skin.lean);
  return (
    <Card className={cx("flex flex-col p-5 transition hover:border-line/80")}>
      <div className="flex items-start gap-3">
        <span className="shrink-0">{skin.glyph}</span>
        <div className="min-w-0">
          <button onClick={onOpen} className="block text-left text-[19px] font-bold leading-snug text-ink hover:text-yin-light hover:underline">{j.name}</button>
          <p className={cx("mt-0.5 text-[13.5px] font-semibold", t.text)}>{j.tagline}</p>
        </div>
      </div>
      <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">{j.scope}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
        <span><b className="text-ink">{j.published}</b> published</span>
        <span><b className="text-ink">{j.in_review}</b> in review</span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 pt-1">
        <button onClick={onOpen} className="rounded-field border border-line px-3.5 py-1.5 text-[13px] font-semibold text-ink hover:bg-veil/[0.04]">Enter the journal →</button>
        <button onClick={onSubmit} className={cx("rounded-field px-3.5 py-1.5 text-[13px] font-bold", skin.lean === "yang" ? "bg-yang text-on-accent hover:opacity-90" : "border border-yin/50 bg-yin/[0.12] text-yin-light hover:bg-yin/[0.18]")}>Submit</button>
      </div>
    </Card>
  );
}

// ════ THE HUB — a small publisher's portal ════
function Hub({ journals, set }: { journals: Journal[]; set: (patch: Record<string, string | null>) => void }) {
  const total = journals.reduce((a, j) => a + j.published, 0);
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:py-10">
      {/* Masthead */}
      <header className="relative overflow-hidden rounded-card border border-line bg-gradient-to-br from-space-2 to-space-1 p-6 sm:p-9">
        <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.2em] text-ink-3">
          <JournalEmblem lean="yang" className="h-5 w-5" /> ArtaQuest Foundation
        </p>
        <h1 className="mt-2 text-[clamp(2rem,4.6vw,3rem)] font-extrabold leading-[1.05] tracking-tight">{PORTAL}</h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-relaxed text-ink">A growing family of open-access journals of short, reproducible studies. Every paper ships its open data and code and is reviewed by an AI that <b className="text-ink">re-runs the analysis and reproduces the result</b> before it is published — with a permanent DOI.</p>
        <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-ink-2"><b className="text-ink">No human peer review.</b> Open access (CC BY 4.0), no fees to read or publish. <a className="font-semibold text-yin-light hover:underline" href="/artascience">How papers are reviewed →</a></p>
        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <button onClick={() => set({ submit: "1" })} className="rounded-field bg-yang px-3.5 py-2 text-[14px] font-bold text-on-accent hover:opacity-90" title="Pick a journal, then submit — a registered dataset + model required">Submit a manuscript</button>
          <button onClick={() => set({ submissions: "1" })} className="rounded-field border border-line px-3.5 py-2 text-[14px] font-semibold text-ink hover:bg-veil/[0.04]">All submissions</button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
          <span><b className="text-ink">{journals.length}</b> journal{journals.length === 1 ? "" : "s"}</span>
          <span><b className="text-ink">{total}</b> article{total === 1 ? "" : "s"} published</span>
          <span className="text-yin-light">more journals coming</span>
        </div>
      </header>

      {/* The one shared reviewer's live heartbeat — is ArtaScience awake, and how deep is the queue */}
      <div className="mt-4"><ReviewStatusBanner /></div>

      {/* The shared model */}
      <section className="mt-7">
        <PipelineStrip />
      </section>

      {/* Journal grid */}
      <section className="mt-9">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">The journals</h2>
          <p className="text-[12.5px] text-ink-3">Each scoped to a question; one shared, automated reviewer</p>
        </div>
        {!journals.length ? (
          <Card className="mt-3 p-8 text-center"><p className="text-[14px] text-ink-3">No journals are open yet. Check back soon.</p></Card>
        ) : (
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            {journals.map((j) => (
              <JournalCard key={j.slug} j={j}
                onOpen={() => set({ journal: j.slug })}
                onSubmit={() => set({ journal: j.slug, submit: "1" })} />
            ))}
          </div>
        )}
      </section>

      {/* Latest across all journals */}
      <PublishedList open={(sid) => set({ submission: String(sid) })} heading="Latest across all journals" />

      {/* Queue transparency — what's moving through review right now, portal-wide */}
      <InReviewList open={(sid) => set({ submission: String(sid) })} onQueue={() => set({ submissions: "1" })} />

      <Foot name={PORTAL} />
    </div>
  );
}

// ════ A SINGLE JOURNAL'S HOME ════
function JournalHome({ j, set }: { j: Journal; set: (patch: Record<string, string | null>) => void }) {
  const skin = skinFor(j.slug);
  const t = leanTok(skin.lean);
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <button onClick={() => set({ journal: null })} className="text-[14px] font-semibold text-yin-light hover:underline">← {PORTAL}</button>
      {/* Journal masthead with its own emblem + accent lean */}
      <header className={cx("relative mt-4 overflow-hidden rounded-card border p-6 sm:p-7", t.border, t.soft)}>
        <p className="flex items-center gap-2.5">
          <span className="shrink-0">{skin.glyph}</span>
          <span className="text-[12px] font-semibold uppercase tracking-[0.2em] text-ink-3">{PORTAL}</span>
        </p>
        <h1 className="mt-2 text-[clamp(1.85rem,4vw,2.6rem)] font-extrabold leading-[1.08] tracking-tight">{j.name}</h1>
        <p className={cx("mt-2 text-[16px] font-semibold", t.text)}>{j.tagline}</p>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-2">{j.scope[0].toUpperCase() + j.scope.slice(1)}. Every study ships its open data and code, and is reviewed by an AI that re-runs the analysis and confirms it reproduces before it is published.</p>
      </header>
      <p className="mt-3 text-[13px] text-ink-3">ArtaQuest Foundation · open access (CC BY 4.0) · <button onClick={() => set({ about: "1" })} className="font-semibold text-yin-light hover:underline">About &amp; author guidelines</button></p>
      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <button onClick={() => set({ submit: "1" })} className="rounded-field bg-yang px-3.5 py-2 text-[14px] font-bold text-on-accent hover:opacity-90" title="Open data + code required; reviewed entirely by AI">Submit to {j.name}</button>
        <button onClick={() => set({ submissions: "1" })} className="rounded-field border border-line px-3.5 py-2 text-[14px] font-semibold text-ink hover:bg-veil/[0.04]">Review queue</button>
      </div>
      <div className="mt-3"><ReviewStatusBanner journal={j.slug} /></div>
      <p className="mt-4 text-[14px] leading-relaxed text-ink-2"><b className="text-ink">No human peer review.</b> Every submission is read, run, and checked by an AI that reproduces your results from your own code and data — round after round — and only reproduced work is published, each with a permanent DOI. <button onClick={() => set({ about: "1" })} className="font-semibold text-yin-light hover:underline">How it works →</button></p>
      <div className="mt-6"><PipelineStrip /></div>
      <PublishedList open={(sid) => set({ submission: String(sid) })} journalSlug={j.slug} />
      <InReviewList open={(sid) => set({ submission: String(sid) })} onQueue={() => set({ submissions: "1" })} journalSlug={j.slug} />
      <Foot name={j.name} />
    </div>
  );
}

// ════ ABOUT / AUTHOR GUIDELINES (journal-aware) ════
function AboutPanel({ journal, set }: { journal: Journal | null; set: (patch: Record<string, string | null>) => void }) {
  const H = ({ children }: { children: ReactNode }) => <h2 className="mt-7 text-[18px] font-bold">{children}</h2>;
  const name = journal?.name || PORTAL;
  const backLabel = journal?.name || PORTAL;
  const scopeSentence = journal
    ? `${journal.scope[0].toUpperCase() + journal.scope.slice(1)}.`
    : "Each journal is scoped to its own question, but all share one model: empirical, reproducible, honestly-caveated studies whose every result must reproduce from its open data and code.";
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <button onClick={() => set({ about: null })} className="text-[14px] font-semibold text-yin-light hover:underline">← {backLabel}</button>
      <h1 className="mt-4 text-[clamp(1.9rem,4vw,2.6rem)] font-extrabold leading-tight">About {name}</h1>
      <p className="mt-3 text-[16px] leading-relaxed text-ink-2">{journal
        ? <>{name} is an open-access journal in the {PORTAL} family. {scopeSentence} Every article ships with its open data and code, a one-click reproduction, citations, and an open discussion.</>
        : <>{PORTAL} is a family of open-access journals of short, reproducible studies. Every article ships with its open data and code, a one-click reproduction, citations, and an open discussion.</>}</p>
      <p className="mt-3 rounded-card border border-yin/30 bg-yin/[0.06] p-4 text-[15px] leading-relaxed text-ink-2">A journal with <b className="text-ink">no human peer review</b>. Every submission is reviewed by an AI that runs your code on your open data and confirms your results reproduce — the reproducibility check that ordinary review only assumes. Submit, get rounds of concrete feedback, and once it reproduces it is published with a permanent DOI.</p>
      <H>Aims &amp; scope</H>
      <p className="text-[15px] leading-relaxed text-ink-2">{scopeSentence} We value transparent methods and falsifiable claims, and every result must reproduce from its open data and code.</p>
      <H>Open access &amp; licence</H>
      <p className="text-[15px] leading-relaxed text-ink-2">All articles are open access under <b className="text-ink">CC BY 4.0</b> — reuse freely with attribution. There are no fees to read or publish.</p>
      <H>Automated AI review — no human peer review</H>
      <ReviewModelExplainer />
      <H>Author guidelines</H>
      <ul className="mt-1 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-ink-2">
        <li><b className="text-ink">Manuscript in LaTeX.</b> Submit it as a <b className="text-ink">zipped LaTeX project</b> that compiles to a PDF. Our class <span className="font-mono text-[13px]">artaquest.cls</span> is recommended: <a className="font-semibold text-yin-light hover:underline" href="https://artaquest.com/papers/artaquest-latex-template.zip">download the template</a> · <a className="font-semibold text-yin-light hover:underline" href="https://artaquest.com/papers/style-guide.html" target="_blank" rel="noopener noreferrer">style guide</a>.</li>
        <li><b className="text-ink">Open data + open code are mandatory.</b> A submission is reviewed only if both are public and runnable — provide a code URL (a git repo is ideal) and a data URL the code can read, or upload each file.</li>
        <li><b className="text-ink">Make it run end-to-end.</b> A self-contained script or notebook that regenerates every figure from the open data (a one-click Colab is ideal). Pin dependencies; document how to run it.</li>
        <li><b className="text-ink">Claims must reproduce.</b> The numbers and figures in your abstract must follow from running your code on your data.</li>
        <li><b className="text-ink">Authorship.</b> List all authors with affiliations and ORCID; co-authors must consent. We follow the CRediT contribution taxonomy.</li>
        <li><b className="text-ink">Declarations &amp; honesty.</b> State competing interests, funding, and data availability; distinguish description from prediction, and correlation from causation. British spelling; no trailing periods on headings.</li>
      </ul>
      <H>Ethics &amp; corrections</H>
      <p className="text-[15px] leading-relaxed text-ink-2">We issue corrections, errata, and retractions with public notices when warranted. Plagiarism and undisclosed conflicts are grounds for rejection or retraction.</p>
      <H>Indexing &amp; citability</H>
      <p className="text-[15px] leading-relaxed text-ink-2">Every published article is assigned a permanent <b className="text-ink">DOI</b> (registered with DataCite) and preserved in a CERN-backed long-term archive, so the version of record persists independently of this site. Citations export as BibTeX, RIS, and APA.</p>
      <H>Submit</H>
      <p className="text-[15px] leading-relaxed text-ink-2">Submissions are open. <button onClick={() => set({ about: null, submit: "1" })} className="font-semibold text-yin-light hover:underline">Submit a manuscript</button> with its open data and code, or browse the <button onClick={() => set({ about: null, submissions: "1" })} className="font-semibold text-yin-light hover:underline">public review queue</button> to see every submission and its AI feedback.</p>
      <Foot name={name} />
    </div>
  );
}

export default function Research() {
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === null) p.delete(k); else p.set(k, v); }
    setParams(p, { replace: false }); window.scrollTo({ top: 0 });
  };

  // The portal's journals (data — the hub renders whatever the API returns). Loaded once; while loading,
  // surfaces that don't strictly need it (a deep-linked article, the all-journals queue) still work.
  const [journals, setJournals] = useState<Journal[] | null>(null);
  useEffect(() => { let ok = true; getJournals().then((d) => ok && setJournals(d.journals || [])).catch(() => ok && setJournals([])); return () => { ok = false; }; }, []);

  const journalSlug = params.get("journal") || "";
  const journal = journals?.find((j) => j.slug === journalSlug) || null;
  // Back label + the scope a sub-view returns to: the journal's name when scoped, else the portal.
  const homeLabel = journal ? journal.name : PORTAL;

  // ════ ABOUT / AUTHOR GUIDELINES (journal-aware) ════
  if (params.get("about")) {
    return <AboutPanel journal={journal} set={set} />;
  }

  // ════ SUBMIT / REVISE / ONE ARTICLE / QUEUE ════
  // A malformed deep link (?submission=abc / 0 / negative) parses to NaN/0 — treat it as no id (fall
  // through to the home) rather than firing a NaN request.
  const idParam = (k: string) => { const n = Number(params.get(k)); return Number.isInteger(n) && n > 0 ? n : 0; };
  if (params.get("submit")) {
    // Scoped to the current journal if one is selected; otherwise the author picks one in the form.
    return <SubmitView journals={journals || []} journalSlug={journal?.slug} backLabel={homeLabel}
      onClose={() => set({ submit: null })} onDone={(id) => set({ submit: null, submission: String(id) })} />;
  }
  if (idParam("revise")) {
    return <SubmitView reviseId={idParam("revise")} journals={journals || []} backLabel={homeLabel}
      onClose={() => set({ revise: null })} onDone={(id) => set({ revise: null, submission: String(id) })} />;
  }
  if (idParam("submission")) {
    return <SubmissionDetail id={idParam("submission")} backLabel={journal ? journal.name : PORTAL}
      onClose={() => set({ submission: null })} onRevise={(s) => set({ submission: null, revise: String(s.id) })} />;
  }
  if (params.get("submissions")) {
    return <SubmissionsView journalSlug={journal?.slug} backLabel={homeLabel}
      open={(id) => set({ submissions: null, submission: String(id) })}
      onClose={() => set({ submissions: null })} onNew={() => set({ submissions: null, submit: "1" })} />;
  }

  // ════ HUB (no journal) vs JOURNAL HOME (?journal=slug) ════
  if (journals === null) {
    // Brief skeleton while the journal list loads (deep links above already returned without it).
    return <div className="mx-auto max-w-5xl px-4 py-10" role="status" aria-busy="true"><div className="h-40 animate-pulse rounded-card bg-veil/[0.05]" /><div className="mt-4 grid gap-4 md:grid-cols-2">{[0, 1].map((i) => <div key={i} className="h-44 animate-pulse rounded-card bg-veil/[0.05]" />)}</div></div>;
  }
  if (journal) return <JournalHome j={journal} set={set} />;
  return <Hub journals={journals} set={set} />;
}
