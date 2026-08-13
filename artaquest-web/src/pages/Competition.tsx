import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Competitions,
  type CompetitionDetail,
  type CompetitionLeaderRow,
  type CompetitionResults,
  type CompetitionSolution,
  type CompetitionSubmitResult,
  type MyReview,
  type MySubmission } from "../lib/api";
import type { CompetitionChantResult } from "../lib/api";

/** Chant competitions: entries are twelve law sentences, machine-measured (total spoken seconds,
 *  lower wins). 'artaverify' is the legacy metric key kept as an alias on old rows. */
const isChantMetric = (m?: string) => m === "chant" || m === "artaverify";
/** Sky competitions (topic-500): predict a topic's interest from the 11 body phases; per-topic R²
 *  clamped[0,1] averaged ×100 = the 0-100 board. The Results tab plots each topic's fit + forecast and
 *  its fitted phase→sign + per-body frequencies. */
const isPhaseMetric = (m?: string) => m === "phase-r2";
/** Score formatting: chant = seconds (lower wins); phase = a 0-100 board score (2dp); plain R² = 5dp. */
const fmtScore = (x: number, phase?: boolean, naming?: boolean) =>
  naming ? `${x.toFixed(1)}s` : phase ? x.toFixed(2) : x.toFixed(5);
import { Button, Card, ErrorNote, Pill, Tabs, Textarea, type Tab } from "../components/ui";
import { currentUser, isLoggedIn, localePath, relAgo } from "../lib/wp";
import { WorkHeart } from "../components/studio";
import { CompResultsChart, FreqBars } from "../components/ResearchCharts";
import { seasonForPhase } from "../lib/seasons";
import { SeasonSigil } from "../components/seasons";
import Thread from "./Thread";

const TABS: Tab[] = [
  { key: "overview", label: "Overview" },
  { key: "data", label: "Data" },
  { key: "leaderboard", label: "Leaderboard" },
  { key: "results", label: "Results" }, // phase competitions only — hidden elsewhere
  { key: "discussion", label: "Discussion" },
  { key: "submit", label: "Submit" },
  { key: "rules", label: "Rules" },
];
const TAB_KEYS = new Set(TABS.map((t) => t.key));
// The analysis engine's 12 internal phase keys (historic identifiers, never rendered) in
// calendar order — each 30° sector of the year's cycle is one of the twelve seasons (lib/seasons.ts).
const PHASE_KEYS = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
// The 11 sidereal bodies in the dataset's column order (matches CompetitionResults.phase.freqs).
const SKY_BODY_NAMES = ["Sun", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto", "Chiron", "Node"];

const isOpen = (status?: string) => ["open", "active"].includes((status || "").toLowerCase());
const MEDALS = ["🥇", "🥈", "🥉"];
const PODIUM_PCT = [50, 30, 20]; // mirrors Competitions::PODIUM server-side

/** Parse the server's "YYYY-MM-DD HH:MM:SS" UTC strings → epoch ms (NaN when absent/invalid). */
const parseUtc = (s?: string) => (s ? new Date(s.replace(" ", "T") + "Z").getTime() : NaN);

/** Human-readable file sizes for the Data tab (B / KB / MB, one decimal). */
function fmtBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** A remaining span as a compact "27d 14h" / "14h 3m" / "3m". */
function fmtLeft(ms: number): string {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

/* Live deadline countdown for the header meta strip — ticks once a minute. Past the deadline an
   `open` competition reads "settling" (the prize is being decided on the private half). */
function Countdown({ deadline, status }: { deadline: string; status: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const open = isOpen(status);
  const target = parseUtc(deadline);
  if (!Number.isFinite(target)) return <span>{open ? "Open" : status || "Closed"}</span>;
  if (target <= now) return <span>{open ? "Settling" : status || "Closed"}</span>;
  return (
    <span>
      {open ? "Open" : status || "Closed"} · <span className="font-semibold tabular-nums text-ink-2">{fmtLeft(target - now)}</span> to deadline
    </span>
  );
}

/* Small labelled stat used across the Overview / Data panels. */
function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-card border border-line bg-space-2 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-2">{label}</div>
      <div className="mt-0.5 text-[16px] font-bold tabular-nums">{value}</div>
    </div>
  );
}

function DownloadRow({ label, url, hint, size }: { label: string; url?: string | null; hint?: string; size?: number }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-space-2 px-4 py-3">
      <span className="min-w-0 truncate font-mono text-[13px] text-ink-2">
        {label}
        {hint && <span className="ms-2 font-sans text-[12px] text-ink-3">{hint}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-3">
        {!!size && <span className="text-[12px] tabular-nums text-ink-3">{fmtBytes(size)}</span>}
        {url ? (
          <a href={url} download data-native className="text-[13px] font-semibold text-yin-light hover:underline">Download ↓</a>
        ) : (
          <span className="text-[12px] text-ink-3">unavailable</span>
        )}
      </span>
    </div>
  );
}

/* ── Overview ─────────────────────────────────────────────────────────────── */
const HOW_IT_WORKS = [
  { title: "Download the data", body: "Grab the training and test files from the Data tab — the features are open, the target is held out." },
  { title: "Submit predictions", body: "Paste or upload your predictions on the Submit tab — scored instantly against the public half of the holdout." },
  { title: "Verify your solution", body: "Submit your open code for adversarial review — only verified solutions win the prize." },
];
const HOW_IT_WORKS_NAMING = [
  { title: "Write your twelve laws", body: "Twelve sentences, twelve boxes on the Submit tab — “Rock blocks the gun”. That's the whole entry." },
  { title: "The machines chant them", body: "No judge. ArtaTranslate renders your laws in all 20 languages, then ArtaVoice speaks all 240 lines aloud — fully automated." },
  { title: "Shortest chant leads", body: "Your score is the total spoken time in seconds — lowest wins. Every translation and clip timing is public under Leaderboard → Solutions." },
];

function Overview({ c, onTab }: { c: CompetitionDetail; onTab: (k: string) => void }) {
  const createdTs = parseUtc(c.created);
  return (
    <div className="space-y-6">
      {c.blurb && (/<[a-z][^>]*>/i.test(c.blurb) ? (
        // Rich blurb (server-sanitized wp_kses_post HTML) — naming comps carry rules markup.
        <div
          className="space-y-3 text-[15px] leading-relaxed text-ink-2 [&_b]:font-semibold [&_b]:text-ink [&_i]:italic [&_p]:m-0 [&_span]:break-words"
          dangerouslySetInnerHTML={{ __html: c.blurb }}
        />
      ) : (
        <p className="text-[15px] leading-relaxed text-ink-2">{c.blurb}</p>
      ))}
      <section>
        <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">How it works</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {(isChantMetric(c.metric) ? HOW_IT_WORKS_NAMING : HOW_IT_WORKS).map((s, i) => (
            <div key={i} className="rounded-card border border-line bg-space-2 px-4 py-3">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-yang/15 text-[12px] font-bold tabular-nums text-yang">{i + 1}</span>
              <p className="mt-2 text-[13.5px] font-semibold text-ink">{s.title}</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{s.body}</p>
            </div>
          ))}
        </div>
      </section>
      {c.prize > 0 && (
        <section>
          <h2 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Prize</h2>
          <div className="grid grid-cols-3 gap-3">
            {PODIUM_PCT.map((pct, i) => (
              <div key={i} className="rounded-card border border-yang/30 bg-yang/5 px-4 py-3 text-center">
                <div className="text-[18px]">{MEDALS[i]}</div>
                <div className="mt-0.5 text-[16px] font-bold tabular-nums text-yang">₳{Math.round((c.prize * pct) / 100)}</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12.5px] text-ink-3">
            The ₳{c.prize} pool settles to the top three of the final leaderboard at the deadline.
            {isChantMetric(c.metric)
              ? " Fastest measured chants take the medals — lower time wins."
              : " A medal needs a score above 0 — you must beat “predict the mean”."}
          </p>
        </section>
      )}
      <section>
        <h2 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Evaluation</h2>
        <p className="text-[14px] leading-relaxed text-ink-2">{c.evaluation || `Submissions are scored by ${c.metric || "R²"}.`}</p>
      </section>
      <section>
        <h2 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Timeline</h2>
        <p className="text-[14px] leading-relaxed text-ink-2">
          {c.deadline
            ? <>This competition {isOpen(c.status) ? "is open" : `is ${c.status || "closed"}`} — deadline <span className="font-semibold">{c.deadline} UTC</span>.</>
            : <>This competition is {isOpen(c.status) ? "open" : c.status || "closed"} — there is no fixed deadline.</>}
        </p>
        {c.deadline && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
            At the deadline — the full moon — the leaderboard freezes and the final standings settle on the
            hidden <span className="font-semibold text-ink-2">private half</span> of the holdout
            {c.prize > 0 && <>; that&rsquo;s when the ₳<span className="tabular-nums">{c.prize}</span> pool pays out</>}.
            Your live score is measured on the public half only.
          </p>
        )}
      </section>
      <section>
        <h2 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Host</h2>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card border border-line bg-space-2 px-4 py-3">
          <div className="min-w-0 truncate text-[14px]">
            {c.owner_slug
              ? <a href={localePath(`/u/${c.owner_slug}`)} className="font-semibold text-ink hover:text-yin-light">{c.owner || "ArtaQuest"}</a>
              : <span className="font-semibold text-ink">{c.owner || "ArtaQuest"}</span>}
            {Number.isFinite(createdTs) && (
              <span className="ms-2 text-[12.5px] text-ink-3">hosted {relAgo(Math.floor(createdTs / 1000))}</span>
            )}
          </div>
          {c.thread_id > 0 && (
            <button type="button" onClick={() => onTab("discussion")}
              className="shrink-0 text-[13px] font-semibold text-yin-light hover:underline">
              Official discussion →
            </button>
          )}
        </div>
      </section>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Train rows" value={c.n_train.toLocaleString()} />
        <Stat label="Test rows" value={c.n_test.toLocaleString()} />
        <Stat label="Features" value={c.n_features} />
        <Stat label="Targets" value={c.n_targets} />
      </div>
    </div>
  );
}

/* ── Data explorer (client-side preview of the public train.csv) ──────────── */
type Explored = { header: string[]; rows: string[][]; summary: { col: string; min: number; max: number; mean: number }[]; total: number; partial: boolean };

// Only the first ~256 KB is fetched (a Range request) — enough for the head preview + a representative
// column summary — so a multi-MB train.csv never downloads in full just to show 12 rows. `keyCol` (id
// or trend) is dropped from the numeric summary (its min/mean/max are meaningless row identifiers).
function exploreCsv(text: string, keyCol: string, partial: boolean): Explored {
  // Competition CSVs are plain (no quoted commas) — a simple split parser is exact here.
  const lines = text.trim().split(/\r\n|\r|\n/);
  if (partial) lines.pop(); // the Range cut may leave a truncated final line — drop it
  const header = (lines.shift() || "").split(",").map((s) => s.trim());
  const rows = lines.map((l) => l.split(","));
  const skip = new Set([keyCol, "id", "trend", "phase", "shift", "date"]);
  const summary = header.map((col, i) => {
    if (skip.has(col)) return null;
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (const r of rows) {
      const t = (r[i] ?? "").trim();
      if (!t) continue;
      const v = Number(t);
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v; n++;
    }
    return n ? { col, min, max, mean: sum / n } : null;
  }).filter((s): s is NonNullable<typeof s> => s !== null);
  return { header, rows: rows.slice(0, 12), summary, total: rows.length, partial };
}

function DataExplorer({ url, keyCol }: { url: string; keyCol: string }) {
  const [d, setD] = useState<Explored | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    setD(null); setErr(false);
    fetch(url, { headers: { Range: "bytes=0-262143" }, signal: ac.signal })
      .then((r) => (r.ok || r.status === 206 ? r.text() : Promise.reject()))
      .then((t) => setD(exploreCsv(t, keyCol, t.length >= 262143)))
      .catch((e) => { if (e?.name !== "AbortError") setErr(true); });
    return () => ac.abort();
  }, [url, keyCol]);
  if (err) return <p className="text-[13px] text-ink-3">Couldn&rsquo;t preview the data — download it above.</p>;
  if (!d) return <p className="text-[13px] text-ink-3">Loading preview…</p>;
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-card border border-line">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-line bg-space-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-2">
              {d.header.map((h) => <th key={h} className="px-2.5 py-2 font-semibold">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={i} className="border-b border-line/40">
                {r.map((v, j) => <td key={j} className="px-2.5 py-1.5 tabular-nums text-ink-2">{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-ink-3">First {d.rows.length} rows{d.partial ? " (previewing the start of the file)" : ` of ${d.total.toLocaleString()}`}.</p>
      <div className="overflow-x-auto rounded-card border border-line">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-line bg-space-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-2">
              <th className="px-2.5 py-2 font-semibold">column</th>
              <th className="px-2.5 py-2 text-right font-semibold">min</th>
              <th className="px-2.5 py-2 text-right font-semibold">mean</th>
              <th className="px-2.5 py-2 text-right font-semibold">max</th>
            </tr>
          </thead>
          <tbody>
            {d.summary.map((s) => (
              <tr key={s.col} className="border-b border-line/40">
                <td className="px-2.5 py-1.5 font-mono text-ink-2">{s.col}</td>
                <td className="px-2.5 py-1.5 text-right tabular-nums text-ink-2">{s.min}</td>
                <td className="px-2.5 py-1.5 text-right tabular-nums text-ink-2">{s.mean.toFixed(2)}</td>
                <td className="px-2.5 py-1.5 text-right tabular-nums text-ink-2">{s.max}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Data ─────────────────────────────────────────────────────────────────── */
function DataPanel({ c }: { c: CompetitionDetail }) {
  const skyRows = c.key_col === "trend|sky";
  const phaseRows = c.key_col.startsWith("phase|") || c.key_col.startsWith("shift|");
  const topicRows = c.key_col === "trend|id";
  const idKeyed = c.key_col === "id";
  const trainIsZip = !!c.data?.train && c.data.train.endsWith(".zip");
  return (
    <div className="space-y-6">
      <p className="text-[14px] leading-relaxed text-ink-2">
        {skyRows ? (
          <>A <b>null-hypothesis test</b>. Every month is served <b>de-timed</b>: at <b>72 sky rotations</b>
          (the {c.n_features || 11} sidereal phases carry (phase&nbsp;+&nbsp;k)&nbsp;mod&nbsp;360), <em>shuffled</em>,
          with <b>no id and no phase column</b>. One train CSV per topic (the {c.n_features || 11} phases + target);
          <span className="font-mono"> test.csv</span> is <span className="font-mono">trend</span> + the phases.
          A month&rsquo;s 72 copies share one target, so the best model is <b>phase-agnostic</b> (the null model) —
          predict each topic&rsquo;s 12 future months. Scored by plain R² after folding each row to its rotation-
          invariant sky fingerprint; a phase-dependent model can only lose.</>
        ) : phaseRows ? (
          <>Every month is served at <b>72 sky rotations</b>. One train CSV per topic; each row is
          (<span className="font-mono">phase</span> k, the {c.n_features || 11} sidereal phases rotated by
          (phase&nbsp;&minus;&nbsp;k), target). In <span className="font-mono">test.csv</span> each of a topic&rsquo;s
          12 holdout months appears once per rotation (keyed <span className="font-mono">trend,phase,id</span>) —
          predict the target for every row. Per topic, R² across the 72 phases → a tuning curve whose peak is its
          season; the topic&rsquo;s best-phase R² (clamped 0–1) sets its score.</>
        ) : topicRows ? (
          <>One CSV per topic. Each file&rsquo;s rows are that topic&rsquo;s months, <em>shuffled</em>: the{" "}
          {c.n_features || 11} features are the ecliptic phases (0–360°, integers) of the celestial bodies at
          that hidden month; the target is the topic&rsquo;s worldwide search interest (0–100) that month.
          Fit per topic, then predict the target for every held-out row in{" "}
          <span className="font-mono">test.csv</span> (keyed <span className="font-mono">trend,id</span>).</>
        ) : idKeyed ? (
          <>Each row is one hidden moment in time. The {c.n_features || 11} features are the ecliptic phases
          (0–360°, integers) of the celestial bodies at that moment; the target is a worldwide search-interest
          value (0–100). Rows are shuffled and keyed by an opaque <span className="font-mono">id</span> —
          fit the phases → the target on <span className="font-mono">train.csv</span>, then predict every row
          of <span className="font-mono">test.csv</span>.</>
        ) : (
          <>Each row is one month. The {c.n_features || 11} features are the sky positions of the celestial
          bodies (ecliptic longitudes) at that month; the target is the world&rsquo;s search trend for the topic
          that month. Fit the features → the trend on the training years, then predict the trend for every month
          in the test set.</>
        )}
      </p>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Features" value={c.n_features || 11} />
        <Stat label="Targets" value={c.n_targets} />
        <Stat label="Total rows" value={(c.n_train + c.n_test).toLocaleString()} />
      </div>
      {!!c.columns?.length && (
        <section>
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Column dictionary</h2>
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line bg-space-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-2">
                  <th className="px-3 py-2 font-semibold">Column</th>
                  <th className="px-3 py-2 font-semibold">Type</th>
                  <th className="px-3 py-2 font-semibold">Description</th>
                </tr>
              </thead>
              <tbody>
                {c.columns.map((col) => (
                  <tr key={col.name} className="border-b border-line/40 last:border-0 align-top">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-ink">{col.name}</td>
                    <td className="px-3 py-2">
                      <span className="rounded-pill bg-veil/10 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-2">{col.type}</span>
                    </td>
                    <td className="min-w-[220px] px-3 py-2 leading-relaxed text-ink-2">{col.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section>
        <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Files</h2>
        <div className="space-y-2">
          <DownloadRow label={trainIsZip ? "train.zip" : "train.csv"}
            hint={trainIsZip ? "one CSV per topic — features + target" : "features + target"} url={c.data?.train} size={c.sizes?.train} />
          <DownloadRow label="test.csv" hint="features only" url={c.data?.test} size={c.sizes?.test} />
          <DownloadRow label="sample_submission.csv" hint="the submission shape" url={c.data?.sample_submission} size={c.sizes?.sample_submission} />
          {c.data?.notebook && <DownloadRow label="starter.ipynb" hint="Jupyter starter — loads the data, fits a baseline, writes a submission" url={c.data.notebook} size={c.sizes?.notebook} />}
        </div>
        <p className="mt-2 text-[12.5px] text-ink-3">
          <span className="font-mono">train.csv</span> carries the target column; <span className="font-mono">test.csv</span>{" "}
          has the features only. Submit one predicted value per test row, in the shape of{" "}
          <span className="font-mono">sample_submission.csv</span>. Open data, CC BY 4.0.
        </p>
      </section>
      {(trainIsZip ? c.data?.test : c.data?.train) && (
        <section>
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">
            Explore {trainIsZip ? "test.csv" : "train.csv"}
          </h2>
          <DataExplorer url={(trainIsZip ? c.data!.test : c.data!.train)!} keyCol={c.key_col || "id"} />
        </section>
      )}
    </div>
  );
}

/* ── Leaderboard ──────────────────────────────────────────────────────────── */
function Leaderboard({ slug, prize, naming, phase }: { slug: string; prize: number; naming?: boolean; phase?: boolean }) {
  // Chant scores are total spoken SECONDS (lower wins); phase scores are a 0-100 board; holdout R² is 5dp.
  const fmt = (x: number) => fmtScore(x, phase, naming);
  const [rows, setRows] = useState<CompetitionLeaderRow[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    Competitions.leaderboard(slug).then((d) => setRows(d.items || [])).catch(() => setErr(true));
  }, [slug]);

  if (err) return <p className="text-[14px] text-ink-3">Couldn&rsquo;t load the leaderboard.</p>;
  if (rows === null) return <p className="text-[14px] text-ink-3">Loading…</p>;
  if (rows.length === 0) return <p className="text-[14px] text-ink-3">No submissions yet — be the first on the board.</p>;

  const meSlug = currentUser()?.slug || "";
  const totalSubs = rows.reduce((n, r) => n + r.n_subs, 0);

  // Medal positions follow the SETTLE rule, not raw rank: a medal counts only a non-bot row that scores
  // above 0 AND has a VERIFIED solution (the adversarial review confirmed the score) — bots and
  // unverified entrants keep their board rank but their prize slot passes down. medalOf maps a uid →
  // 0/1/2 (gold/silver/bronze), so the board shows exactly who the coins settle to at the deadline.
  const medalOf = new Map<number, number>();
  if (prize > 0) {
    let m = 0;
    for (const r of rows) {
      if (r.bot || !r.verified || r.score <= 0 || m >= MEDALS.length) continue;
      medalOf.set(r.uid, m);
      m++;
    }
  }

  return (
    <div className="overflow-x-auto">
      <p className="mb-3 text-[12.5px] text-ink-3">
        <span className="font-semibold tabular-nums text-ink-2">{rows.length}</span> team{rows.length === 1 ? "" : "s"} ·{" "}
        <span className="font-semibold tabular-nums text-ink-2">{totalSubs}</span> submission{totalSubs === 1 ? "" : "s"} ·{" "}
        {naming ? "fastest chant" : "leader"} <span className="font-semibold tabular-nums text-ink-2">{fmt(rows[0].score)}{phase && <span className="text-ink-3">/100</span>}</span>
        {naming && <> · lower is better — total spoken time across all 20 languages</>}
        {phase && <> · score is 0–100 (100 = every topic fit perfectly, 0 = predict-the-mean)</>}
      </p>
      <table className="w-full border-collapse text-[14px]">
        <caption className="sr-only">Leaderboard — best score per member, medals mark where the prize settles</caption>
        <thead>
          <tr className="border-b border-line text-left text-[12px] font-semibold uppercase tracking-wide text-ink-3">
            <th scope="col" className="py-2 pe-3 font-semibold">#</th>
            <th scope="col" className="py-2 pe-3 font-semibold">Team</th>
            <th scope="col" className="py-2 pe-3 text-right font-semibold">Score</th>
            <th scope="col" className="py-2 pe-3 text-right font-semibold">Code</th>
            <th scope="col" className="py-2 pe-3 text-right font-semibold">Entries</th>
            <th scope="col" className="py-2 text-right font-semibold">Last</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.uid} className={"border-b border-line/60" + (meSlug && r.slug === meSlug ? " bg-veil/5" : "")}>
              <td className="py-2.5 pe-3 tabular-nums text-ink-3">
                {medalOf.has(r.uid)
                  ? <span role="img"
                      aria-label={`${["Gold", "Silver", "Bronze"][medalOf.get(r.uid)!]} — ₳${Math.round((prize * PODIUM_PCT[medalOf.get(r.uid)!]) / 100)} at the deadline`}
                      title={`₳${Math.round((prize * PODIUM_PCT[medalOf.get(r.uid)!]) / 100)} at the deadline`}>{MEDALS[medalOf.get(r.uid)!]}</span>
                  : r.rank}
              </td>
              <td className="py-2.5 pe-3">
                <a href={localePath(`/u/${r.slug}`)} className="font-semibold text-ink hover:text-yin-light">{r.name}</a>
                {r.verified && <span title="Solution verified by adversarial review — prize-eligible" className="ms-2 rounded-pill bg-yin/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-yin-light">✓ verified</span>}
                {r.bot && <span className="ms-2 rounded-pill bg-veil/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-2">bot</span>}
              </td>
              <td className="py-2.5 pe-3 text-right font-semibold tabular-nums">{fmt(r.score)}</td>
              <td className="py-2.5 pe-3 text-right">{r.code_url ? <a href={r.code_url} target="_blank" rel="noopener noreferrer" className="text-[12.5px] font-semibold text-yin-light hover:underline">code ↗</a> : <span className="text-ink-3">—</span>}</td>
              <td className="py-2.5 pe-3 text-right tabular-nums text-ink-2">{r.n_subs}</td>
              <td className="py-2.5 text-right text-ink-3">{r.last ? relAgo(r.last) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {prize > 0 && (
        <p className="mt-3 text-[12.5px] text-ink-3">
          Medals show where the ₳ pool settles at the deadline ({PODIUM_PCT.join("/")}). Scores at or below 0 take no medal.
        </p>
      )}
    </div>
  );
}

/* ── Results (phase competitions): the leader's predictions vs the raw series ── */
function ResultsPanel({ slug }: { slug: string }) {
  const [res, setRes] = useState<CompetitionResults | null>(null);
  const [err, setErr] = useState(false);
  const [trend, setTrend] = useState("");
  useEffect(() => {
    setRes(null); setErr(false);
    Competitions.results(slug, trend || undefined).then(setRes).catch(() => setErr(true));
  }, [slug, trend]);

  if (err) return <p className="text-[14px] text-ink-3">Couldn&rsquo;t load the results.</p>;
  if (res === null) return <p className="text-[14px] text-ink-3">Loading…</p>;

  // THIS topic's fitted read-out: its per-body frequencies f_i (body order sun..node), for the bars.
  const freqItems = res.phase && Array.isArray(res.phase.freqs)
    ? res.phase.freqs.map((f, i) => ({ body: SKY_BODY_NAMES[i] || `body ${i + 1}`, freq: f }))
    : [];
  const signDist = res.sign_dist || {};

  return (
    <div className="space-y-5">
      {res.winner ? (
        <Card className="p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[14px]">
            <span className="text-ink-3">Current leader</span>
            <a href={localePath(`/u/${res.winner.slug}`)} className="font-bold text-ink hover:text-yin-light">{res.winner.name}</a>
            <span className="font-semibold tabular-nums">score {res.winner.score.toFixed(2)}<span className="text-ink-3">/100</span></span>
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
            The charts below plot, one topic at a time, the sinc-GD baseline&rsquo;s fit over the clean months and
            the leader&rsquo;s predictions for the 12 future months, plus this topic&rsquo;s fitted <b>phase → sign</b> and
            its <b>per-body frequencies</b> — the read-out of the one fixed model the board is built on.
            {!res.closed && <> Test dots show the <b>public</b> topic-half only — the private half stays hidden until settlement.</>}
          </p>
        </Card>
      ) : (
        <p className="text-[14px] text-ink-3">No submissions yet — the plots appear once the board has a leader.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="aq-res-topic" className="text-[13px] font-semibold text-ink-2">Topic</label>
        <select id="aq-res-topic" value={res.trend} onChange={(e: ChangeEvent<HTMLSelectElement>) => setTrend(e.target.value)}
          className="rounded-card border border-line bg-space-2 px-3 py-1.5 text-[13px] text-ink">
          {res.topics.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <span className="text-[12px] text-ink-3">{res.topics.length} anonymised topics</span>
      </div>

      <Card className="p-4 sm:p-5">
        <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Monthly interest vs the sky model &middot; {res.trend}</h2>
        <CompResultsChart months={res.months} actual={res.actual} fit={res.fit} pred={res.pred} testFrom={res.test_from}
          label={`Raw monthly search interest for ${res.trend} versus the sinc-GD baseline's fit and the leader's future-month predictions`} />
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
          <b style={{ color: "var(--color-yin-ink)" }}>Blue dots</b> — the raw monthly interest.{" "}
          <b className="text-ink-2">Grey</b> — the sinc-GD baseline&rsquo;s fit over the clean months.{" "}
          <b style={{ color: "var(--ico-gold)" }}>Gold</b> — the leader&rsquo;s predictions for the 12 future months.
          The shaded band is the future holdout.
        </p>
      </Card>

      {res.phase && (freqItems.length > 0 || res.phase.sign) && (
        <Card className="p-4 sm:p-5">
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">The fitted model for {res.trend} — phase → season &amp; per-body frequencies</h2>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-2">
            Its fitted <b>global phase</b> is <b className="tabular-nums">{res.phase.peak}°</b> of the year's cycle —
            placing it in the season of <b style={{ color: "var(--ico-gold)" }}>{seasonForPhase(res.phase.sign)?.keeper || res.phase.sign}</b>
            {res.phase.r2 != null && <> (baseline <b>future-holdout</b> R² <b className="tabular-nums">{Math.round(res.phase.r2 * 100)}%</b> — negative means the fixed model can&rsquo;t yet forecast this topic&rsquo;s future, the headroom the board rewards)</>}.
          </p>
          {freqItems.length > 0 && (
            <>
              <FreqBars items={freqItems} label={`The fitted frequency f of each body's sinc term for ${res.trend}`} />
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
                Each body adds a <b>sinc</b> peak around the global phase; its <b>frequency</b> <i>f</i> sets how sharp that
                peak is. The <b style={{ color: "var(--ico-gold)" }}>Sun</b> carries the yearly season, the slow outer bodies
                the long trend. One phase, a frequency and a weight per body — the whole fixed model; the competition is to
                fit it better.
              </p>
            </>
          )}
        </Card>
      )}

      {Object.keys(signDist).length > 0 && (
        <Card className="p-4 sm:p-5">
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">The 500 topics across the cycle — a real distribution of fitted seasons</h2>
          <div className="space-y-1">
            {PHASE_KEYS.map((sg) => {
              const n = signDist[sg] || 0;
              const max = Math.max(1, ...Object.values(signDist));
              const s = seasonForPhase(sg)!;
              return (
                <div key={sg} className="flex items-center gap-2 text-[12.5px]">
                  <span className="w-28 shrink-0 text-ink-2"><SeasonSigil season={s} className="me-1 font-semibold" />{s.keeper}</span>
                  <span className="h-3 rounded-sm bg-yin/60" style={{ width: `${(n / max) * 100}%` }} aria-hidden />
                  <span className="tabular-nums text-ink-3">{n}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
            Where the 500 topics&rsquo; fitted global phases land across the twelve seasons of the cycle. Winter-heavy
            (new-year, holidays, tax season) but every season is populated — each topic&rsquo;s phase is fit
            independently, not collapsed to one.
          </p>
        </Card>
      )}
    </div>
  );
}

/* ── Review state pill (shared by Solutions + Your submissions) ─────────────── */
const REVIEW_PILL: Record<string, string> = {
  submitted: "queued", reviewing: "reviewing", flagged: "flagged", "revisions-requested": "revisions",
};
function ReviewStatePill({ review, verified, chant }: { review: string; verified: boolean; chant?: boolean }) {
  if (verified || review === "verified")
    return chant
      ? <span title="Measured by the automated chant pipeline" className="rounded-pill bg-yin/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-yin-light">✓ measured</span>
      : <span title="Solution verified by adversarial review — prize-eligible" className="rounded-pill bg-yin/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-yin-light">✓ verified</span>;
  if (chant && review === "reviewing")
    return <span className="rounded-pill bg-veil/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-2">measuring</span>;
  if (!review || review === "none") return null;
  return (
    <span className={"rounded-pill px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
      (review === "flagged" ? "bg-rose-500/10 text-rose-300" : "bg-veil/10 text-ink-2")}>
      {REVIEW_PILL[review] || review}
    </span>
  );
}

/* ── Solutions (public review write-ups, shown under the leaderboard) ───────── */
const CHANT_LANG_NAMES: Record<string, string> = {
  zh: "Chinese", hi: "Hindi", en: "English", ar: "Arabic", es: "Spanish", jv: "Javanese", pt: "Portuguese",
  ha: "Hausa", pa: "Punjabi", bn: "Bengali", ru: "Russian", fa: "Persian", ja: "Japanese", vi: "Vietnamese",
  de: "German", tr: "Turkish", fr: "French", ko: "Korean", zu: "Zulu", it: "Italian",
};

/** The published per-language recordings of a measured chant entry — play it in every tongue. */
function ChantPlayers({ audio, who }: { audio: Record<string, string>; who: string }) {
  const langs = Object.keys(CHANT_LANG_NAMES).filter((l) => audio[l]);
  if (!langs.length) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[12.5px] font-semibold text-ink-3 hover:text-ink-2">
        ▶ Play the chant — {langs.length} language{langs.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {langs.map((l) => (
          <div key={l} className="flex items-center gap-2 rounded-card border border-line/60 px-2.5 py-1.5">
            <span className="w-[86px] shrink-0 text-[12px] font-semibold text-ink-2">{CHANT_LANG_NAMES[l]}</span>
            {/* preload=none: 20 players per entry — nothing downloads until pressed */}
            <audio controls preload="none" src={audio[l]} className="h-8 w-full min-w-0"
              aria-label={`${who}'s twelve laws chanted in ${CHANT_LANG_NAMES[l]}`} />
          </div>
        ))}
      </div>
    </details>
  );
}

function Solutions({ slug, naming, phase }: { slug: string; naming?: boolean; phase?: boolean }) {
  const [items, setItems] = useState<CompetitionSolution[] | null>(null);
  const [err, setErr] = useState(false);
  const fmt = (x: number) => (naming ? (x > 0 ? `${x.toFixed(1)}s` : "measuring…") : phase ? x.toFixed(2) : x.toFixed(5));
  useEffect(() => {
    setItems(null); setErr(false);
    Competitions.solutions(slug).then((d) => setItems(d.items || [])).catch(() => setErr(true));
  }, [slug]);
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Solutions</h2>
      {err ? (
        <p className="text-[13px] text-ink-3">Couldn&rsquo;t load the solutions.</p>
      ) : items === null ? (
        <p className="text-[13px] text-ink-3">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-ink-3">No solutions submitted for review yet.</p>
      ) : (
        <div className="space-y-2">
          {items.map((s) => {
            const rounds = s.rounds || [];
            return (
              <div key={s.submission_id} className="rounded-card border border-line bg-space-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
                  <a href={localePath(`/u/${s.slug}`)} className="min-w-0 truncate font-semibold text-ink hover:text-yin-light">{s.name}</a>
                  <span className="tabular-nums text-ink-2">{fmt(s.score)}</span>
                  <ReviewStatePill review={s.review} verified={s.verified} chant={naming} />
                  {s.code_url && (
                    <a href={s.code_url} target="_blank" rel="noopener noreferrer"
                      className="text-[12.5px] font-semibold text-yin-light hover:underline">open code ↗</a>
                  )}
                </div>
                {naming && s.audio && <ChantPlayers audio={s.audio} who={s.name} />}
                {(s.method || rounds.length > 0) && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[12.5px] font-semibold text-ink-3 hover:text-ink-2">Method &amp; review rounds</summary>
                    {s.method && <p className="mt-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink-2">{s.method}</p>}
                    {rounds.map((r) => (
                      <div key={r.round} className="mt-2 rounded-card border border-line/60 px-3 py-2">
                        <p className="text-[12px] text-ink-3">
                          round <span className="tabular-nums">{r.round}</span> · <span className="font-semibold text-ink-2">{r.verdict}</span>
                          {r.verified && <span className="text-yin-light"> ✓</span>}
                          {" · "}<span className="tabular-nums">{fmt(r.score)}</span>
                          {r.model && <> · {r.model}{r.effort ? <>/{r.effort}</> : null}</>}
                          {r.runtime_s > 0 && <> · <span className="tabular-nums">{r.runtime_s}</span>s</>}
                          {r.created ? <> · {relAgo(r.created)}</> : null}
                        </p>
                        {r.report && <p className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-3">{r.report}</p>}
                      </div>
                    ))}
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ── Solution review (the adversarial verification that gates the prize) ────── */
const REVIEW_LABEL: Record<string, string> = {
  submitted: "Queued for review", reviewing: "Under review", verified: "Verified — prize-eligible",
  flagged: "Flagged in review", "revisions-requested": "Revisions requested",
};
function VerifyPanel({ slug, prize, my, phase }: { slug: string; prize: number; my: MyReview; phase?: boolean }) {
  const [code, setCode] = useState("");
  const [method, setMethod] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [state, setState] = useState<string>(my?.review || "none");
  const inQueue = state === "submitted" || state === "reviewing";
  const canSubmit = !!my && !inQueue && state !== "verified" && (my.round < my.max_rounds);

  async function requestReview() {
    if (!/^https?:\/\//i.test(code.trim())) { setErr("Enter a public URL to your open code (the reviewer runs it)."); return; }
    if (method.trim().length < 40) { setErr("Describe your method (at least 40 characters)."); return; }
    setBusy(true); setErr("");
    try {
      const r = await Competitions.verify(slug, { code_url: code.trim(), method: method.trim() });
      setState(r.review);
    } catch (e) { setErr((e as Error).message || "Couldn't submit for review."); }
    finally { setBusy(false); }
  }

  return (
    <Card className="p-5">
      <p className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-3">Win the prize — verify your solution</p>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-3">
        The public leaderboard is open to everyone, but the {prize > 0 ? <>₳{prize} </> : null}prize settles only to
        <span className="font-semibold text-ink-2"> verified</span> solutions. Submit your open code + a short method write-up:
        ArtaCompete (the same adversarial AI reviewer as the Journal of Seasonality) clones it, re-runs it against the public
        data, confirms your score reproduces, and checks for holdout leakage — then marks you prize-eligible.
      </p>
      {my && (
        <p className="mt-2 text-[13px]">
          Status: <span className={state === "verified" ? "font-semibold text-yin-light" : state === "flagged" ? "font-semibold text-rose-300" : "font-semibold text-ink-2"}>{REVIEW_LABEL[state] || "Not yet submitted"}</span>
          {my.round > 0 && <span className="text-ink-3"> · round {my.round}/{my.max_rounds}</span>}
          {my.submission_id > 0 && <span className="text-ink-3"> · on your best submission ({phase ? `score ${my.score.toFixed(2)}/100` : `R² ${my.score.toFixed(5)}`})</span>}
        </p>
      )}
      {my?.last_report && (state === "revisions-requested" || state === "flagged" || state === "verified") && (
        <details className="mt-2 rounded-card border border-line bg-space-2 px-3 py-2">
          <summary className="cursor-pointer text-[12.5px] font-semibold text-ink-2">Reviewer report</summary>
          <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-3">{my.last_report}</p>
        </details>
      )}
      {canSubmit && (
        <div className="mt-3 space-y-2">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="https://github.com/you/solution (public code URL)"
            className="block w-full rounded-card border border-line bg-space-2 px-3 py-2 text-[13px] text-ink-2" />
          <Textarea rows={4} value={method} onChange={(e) => setMethod(e.target.value)}
            placeholder="Describe your method: features, model, validation — enough for the reviewer to check the code matches."
            className="w-full text-[13px]" />
          {err && <ErrorNote>{err}</ErrorNote>}
          <Button onClick={requestReview} disabled={busy}>{busy ? "Submitting…" : my && my.round > 0 ? "Resubmit for review" : "Submit solution for review"}</Button>
        </div>
      )}
      {!my && <p className="mt-2 text-[13px] text-ink-3">Make a scored submission first, then submit your solution here for review.</p>}
      {state === "verified" && <p className="mt-2 text-[13px] text-yin-light">Your solution is verified — you&rsquo;re in the running for the prize.</p>}
    </Card>
  );
}

/* ── Your submissions (the signed-in member's scored entries, newest first) ─── */
function MySubmissions({ slug, refresh, naming, phase }: { slug: string; refresh: number; naming?: boolean; phase?: boolean }) {
  const [items, setItems] = useState<MySubmission[] | null>(null);
  const fmt = (x: number) => (naming ? (x > 0 ? `${x.toFixed(1)}s` : "measuring…") : phase ? x.toFixed(2) : x.toFixed(5));
  useEffect(() => {
    Competitions.mySubmissions(slug).then((d) => setItems(d.items || [])).catch(() => setItems([]));
  }, [slug, refresh]);
  return (
    <section>
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Your submissions</h2>
      {items === null ? (
        <p className="text-[13px] text-ink-3">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-ink-3">No scored submissions yet — your entries will appear here.</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full border-collapse text-[13px]">
            <caption className="sr-only">Your submissions, newest first — the starred row is your best and the one the leaderboard counts</caption>
            <thead>
              <tr className="border-b border-line bg-space-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-2">
                <th scope="col" className="px-3 py-2 font-semibold">#</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Score</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Code</th>
                <th scope="col" className="px-3 py-2 font-semibold">Note</th>
                <th scope="col" className="px-3 py-2 font-semibold">Review</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s, i) => (
                <tr key={s.id} className="border-b border-line/40 last:border-0">
                  <td className="px-3 py-2 tabular-nums text-ink-3">{i + 1}</td>
                  <td className={"whitespace-nowrap px-3 py-2 text-right tabular-nums " + (s.best ? "font-bold text-yang" : "text-ink-2")}>
                    {s.best && <span title="Your best submission — the one that counts" role="img" aria-label="best">★ </span>}
                    {fmt(s.score)}
                  </td>
                  <td className="px-3 py-2 text-right">{s.code_url ? <a href={s.code_url} target="_blank" rel="noopener noreferrer" className="text-[12.5px] font-semibold text-yin-light hover:underline">code ↗</a> : <span className="text-ink-3">—</span>}</td>
                  <td className="max-w-[200px] truncate px-3 py-2 text-ink-3" title={s.note || undefined}>{s.note || "—"}</td>
                  <td className="px-3 py-2"><ReviewStatePill review={s.review} verified={s.verified} chant={naming} /></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-ink-3">{s.created ? relAgo(s.created) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ── Submit: chant competitions (twelve law sentences — nothing else) ───────── */
const LAW_HINTS = [
  "Gun rips the bag", "Shovel digs the gold", "Scissor cuts the blanket", "Bag swallows the wedge",
  "Gold buys the mirror", "Blanket smothers the fire", "Wedge splits the rock", "Mirror doubles the key",
  "Fire boils the water", "Rock blocks the gun", "Key locks the shovel", "Water rusts the scissor",
];

function ChantSubmit({ slug, onSubmitted }: { slug: string; onSubmitted: () => void }) {
  const [laws, setLaws] = useState<string[]>(() => Array(12).fill(""));
  const [tried, setTried] = useState(false); // inline errors stay quiet until the first submit attempt
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<CompetitionChantResult | null>(null);

  const setLaw = (j: number, v: string) => setLaws((p) => { const n = [...p]; n[j] = v; return n; });
  const lawErr = (j: number): string => {
    const v = laws[j].trim();
    if (!v) return "Required.";
    if (!/\S\s+\S/.test(v)) return "A law is a sentence — at least two words.";
    return "";
  };
  const lawsDone = laws.filter((l) => l.trim()).length;
  const allValid = laws.every((_, j) => !lawErr(j));

  async function submit() {
    setTried(true); setErr("");
    const bad = laws.findIndex((_, j) => !!lawErr(j));
    if (bad >= 0) {
      setErr("Fix the highlighted laws — twelve sentences, each at least two words.");
      document.getElementById(`aq-law-${bad}`)?.focus();
      return;
    }
    setBusy(true); setDone(null);
    try {
      const r = await Competitions.submitChant(slug, laws.map((l) => l.trim()));
      setDone(r);
      onSubmitted();
    } catch (e) {
      setErr((e as Error).message || "Submission failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const inputCls = (bad: boolean) =>
    "mt-1 block w-full rounded-card border bg-space-2 px-3 py-2 text-[14px] text-ink placeholder:text-ink-2 focus:outline-none focus:ring-2 focus:ring-yin-light/60 " +
    (bad ? "border-rose-400/60" : "border-line");

  return (
    <div className="space-y-5">
      <p className="text-[14px] leading-relaxed text-ink-2">
        Write your <b className="text-ink">twelve laws</b> — one sentence per box. That&rsquo;s the whole entry.
        No judge: the machines take over the moment you submit. <b className="text-ink">ArtaTranslate</b> renders
        your twelve chants in all 20 languages, <b className="text-ink">ArtaVoice</b> speaks all 240 lines aloud,
        and your score is the <b className="text-ink">total spoken time</b> — the shortest chant leads the board.
        Every translation and every clip timing is published in Solutions.
      </p>

      <section aria-labelledby="aq-laws-h">
        <h3 id="aq-laws-h" className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">The twelve laws</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {laws.map((l, j) => {
            const e = tried ? lawErr(j) : "";
            return (
              <div key={j}>
                <label htmlFor={`aq-law-${j}`} className="text-[12px] font-semibold text-ink-2">
                  <span className="tabular-nums text-ink-3">{j + 1}.</span> Law {j + 1}
                </label>
                <input id={`aq-law-${j}`} value={l} onChange={(ev) => setLaw(j, ev.target.value)}
                  maxLength={90} autoComplete="off" placeholder={`e.g. ${LAW_HINTS[j]}`}
                  aria-invalid={e ? true : undefined} aria-describedby={e ? `aq-law-err-${j}` : undefined}
                  className={inputCls(!!e)} />
                {e && <p id={`aq-law-err-${j}`} className="mt-1 text-[12px] text-rose-300">{e}</p>}
              </div>
            );
          })}
        </div>
      </section>

      <p className="text-[12.5px] tabular-nums text-ink-3" aria-live="polite">
        {lawsDone}/12 laws{allValid ? " — ready to enter" : ""}
      </p>
      {err && <div role="alert"><ErrorNote>{err}</ErrorNote></div>}
      {done && (
        <Card className="p-5">
          <p className="text-[13px] font-semibold uppercase tracking-[0.12em] text-yang">Entry received — measuring</p>
          <ol className="mt-2 space-y-1 text-[12.5px] leading-relaxed text-ink-2">
            {done.laws.map((l, i) => (
              <li key={i}><span className="tabular-nums text-ink-3">{i + 1}.</span> {l}</li>
            ))}
          </ol>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-3">{done.message}</p>
        </Card>
      )}
      <Button onClick={submit} disabled={busy} aria-busy={busy}>{busy ? "Entering…" : "Enter the match"}</Button>
    </div>
  );
}

/* ── Submit ───────────────────────────────────────────────────────────────── */
function SubmitPanel({ slug, keyCol, prize, entryFee = 0, my, naming, phase }: { slug: string; keyCol: string; prize: number; entryFee?: number; my: MyReview; naming?: boolean; phase?: boolean }) {
  const [text, setText] = useState("");
  const [codeUrl, setCodeUrl] = useState(""); // public reproducible-code link, required on every submission
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<CompetitionSubmitResult | null>(null);
  const [refresh, setRefresh] = useState(0); // bumped on a successful submission → re-fetches "Your submissions"
  const idKeyed = keyCol === "id";

  if (!isLoggedIn()) {
    const login = (typeof window !== "undefined" && (window as unknown as Record<string, string>).AQ_LOGIN_URL) || "/login/";
    const redirect = typeof window !== "undefined" ? window.location.pathname + window.location.search : "";
    return (
      <Card className="p-8 text-center">
        <p className="text-[15px] font-semibold text-ink">Sign in to submit</p>
        <p className="mt-1.5 text-[13px] text-ink-3">You need an account to enter this competition — it&rsquo;s free.</p>
        <Button href={`${login}?redirect_to=${encodeURIComponent(redirect)}`} className="mt-4">Sign in</Button>
      </Card>
    );
  }

  // Chant competitions get the twelve-box form; the holdout-specific machinery below (file upload,
  // CSV/JSON parsing, code verification) never applies to them — measurement is fully automated.
  if (naming) {
    return (
      <div className="space-y-4">
        <ChantSubmit slug={slug} onSubmitted={() => setRefresh((n) => n + 1)} />
        <MySubmissions slug={slug} refresh={refresh} naming phase={phase} />
      </div>
    );
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ""));
    reader.readAsText(f);
  }

  async function submit() {
    const raw = text.trim();
    if (!raw) { setErr("Paste your predictions (CSV or JSON) or choose a file first."); return; }
    if (!/^https?:\/\//i.test(codeUrl.trim())) { setErr("Add a public link to your reproducible code (a Colab notebook, gist or repo) — every submission ships open code."); return; }
    setBusy(true); setErr(""); setResult(null);
    // Accept JSON ({"<key>": value, …}) OR a raw CSV string — the backend parses either.
    let payload: Record<string, number> | string = raw;
    if (raw[0] === "{") {
      try { payload = JSON.parse(raw) as Record<string, number>; }
      catch { setErr("That looks like JSON but couldn't be parsed. Check the format, or paste a CSV instead."); setBusy(false); return; }
    }
    try {
      const r = await Competitions.submit(slug, payload, codeUrl.trim());
      setResult(r);
      setRefresh((n) => n + 1); // the new row appears in "Your submissions" below
    } catch (e) {
      setErr((e as Error).message || "Submission failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[14px] leading-relaxed text-ink-2">
        {keyCol === "trend|sky" ? (
          <>Paste your predictions as a CSV matching <span className="font-mono">sample_submission.csv</span> —
          <span className="font-mono"> trend</span> + the 11 body phases + your predicted{" "}
          <span className="font-mono">target</span> per row — or upload the file. You&rsquo;re scored instantly
          (plain R², folded to each row&rsquo;s rotation-invariant sky fingerprint) and your best submission counts.</>
        ) : (
          <>Paste your predictions as a CSV (matching <span className="font-mono">sample_submission.csv</span>) or as
          a JSON object mapping each <span className="font-mono">{keyCol}</span> key to its predicted value — or
          upload the file. You&rsquo;re scored instantly and your best submission counts.</>
        )}
      </p>
      {entryFee > 0 && (
        <p className="text-[13px] leading-relaxed text-ink-3">
          Each submission costs <span className="font-semibold tabular-nums text-yang">₳{entryFee}</span> — the fee
          joins this dataset&rsquo;s prize pool (80% of the entry revenue pays back to the podium on top of the fixed prize).
        </p>
      )}
      <div>
        <label htmlFor="aq-code-url" className="mb-1 block text-[12px] font-semibold text-ink-2">Reproducible code (Colab/repo) — required on every submission</label>
        <input id="aq-code-url" type="url" value={codeUrl} onChange={(e) => setCodeUrl(e.target.value)}
          placeholder="https://colab.research.google.com/… (public, reproducible code — required)"
          className="block w-full rounded-card border border-line bg-space-2 px-3 py-2 text-[13px] text-ink-2" />
      </div>
      <div>
        <label htmlFor="aq-pred-file" className="sr-only">Upload a predictions file (CSV or JSON)</label>
        <input id="aq-pred-file" type="file" accept=".csv,.json,text/csv,application/json" onChange={onFile}
          className="block w-full text-[13px] text-ink-2 file:mr-3 file:rounded-pill file:border-0 file:bg-veil/10 file:px-4 file:py-2 file:text-[13px] file:font-semibold file:text-ink-2 hover:file:bg-veil/20" />
      </div>
      <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} aria-label="Predictions (CSV or JSON)"
        placeholder={keyCol === "trend|sky" ? `trend,sun,mercury,venus,mars,jupiter,saturn,uranus,neptune,pluto,chiron,node,target\ntopic-001,12,45,301,…,63\ntopic-001,17,52,308,…,58\n…`
          : keyCol.startsWith("phase|") || keyCol.startsWith("shift|") ? `trend,phase,id,target\ntopic-001,0,7,63\ntopic-001,5,7,58\n…`
          : keyCol === "trend|id" ? `trend,id,target\ntopic-001,42,63\ntopic-001,57,58\n…`
          : idKeyed ? `id,target\n1,63\n2,58\n…` : `trend|date,value\ntrend|2024-01-01,63.2\ntrend|2024-02-01,58.9\n…`}
        className="w-full font-mono text-[13px]" />
      {err && <div role="alert"><ErrorNote>{err}</ErrorNote></div>}
      {result && (
        <Card className="p-5">
          <p className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-3">Your submission</p>
          <div className="mt-2 grid grid-cols-3 gap-3">
            <Stat label={phase ? "Score /100" : "Score"} value={phase ? result.score.toFixed(2) : result.score.toFixed(5)} />
            <Stat label="Rank" value={`#${result.rank}`} />
            <Stat label={phase ? "Your best /100" : "Your best"} value={phase ? result.best.toFixed(2) : result.best.toFixed(5)} />
          </div>
        </Card>
      )}
      <Button onClick={submit} disabled={busy} aria-busy={busy}>{busy ? "Scoring…" : "Submit predictions"}</Button>
      <MySubmissions slug={slug} refresh={refresh} phase={phase} />
      <VerifyPanel slug={slug} prize={prize} my={my} phase={phase} />
    </div>
  );
}

/* ── Rules ────────────────────────────────────────────────────────────────────
   Rule titles/bodies keep every runtime value (prize, deadline, holdout) in its OWN JSX text
   node rather than baked into a template literal — so the surrounding sentence is one stable,
   cache-hitting translation string per competition, not a fresh dictionary key each time. */
function Rules({ c }: { c: CompetitionDetail }) {
  const naming = isChantMetric(c.metric);
  const prizeRule = c.prize > 0 ? [{
    title: <>₳<span className="tabular-nums">{c.prize}</span> prize pool — {PODIUM_PCT.join("/")}</>,
    body: <>At the deadline (<span className="tabular-nums">{c.deadline}</span> UTC) the pool settles to the top three on the
      best-per-member leaderboard: {PODIUM_PCT.map((p, i) => <span key={i}>{i > 0 ? ", " : ""}{MEDALS[i]} ₳{Math.round((c.prize * p) / 100)}</span>)}.
      A medal requires a score above 0{naming ? "" : " (beat the predict-the-mean baseline)"}. Bot accounts appear on the
      leaderboard but are walled off from the coin economy — a bot&rsquo;s slot passes to the next member.</>,
  }] : [];
  const deadlineRule = c.deadline ? [{
    title: "Deadline" as ReactNode,
    body: <>Submissions close at <span className="tabular-nums">{c.deadline}</span> UTC. After that the leaderboard is frozen and
      the competition settles. Your best submission is the one that counts — submit as often as you like before then.</>,
  }] : [];
  const oneAccount = { title: "One account per person" as ReactNode, body: "Compete under a single ArtaQuest account. Multiple accounts to game the leaderboard are not allowed." as ReactNode };

  const rules: { title: ReactNode; body: ReactNode }[] = naming ? [
    {
      title: <>Your entry — twelve laws, nothing else</>,
      body: <>Twelve sentences in twelve boxes, one law each (&ldquo;Rock blocks the gun&rdquo;). Each law needs at
        least two words and at most 90 characters. Submit as often as you like — your fastest measured entry is the
        one that counts.</>,
    },
    {
      title: <>The metric — total spoken time, fully automated</>,
      body: <>No judge, no scores out of ten. The moment you enter, <b>ArtaTranslate</b> renders your twelve chants
        into the 20 mesh languages and <b>ArtaVoice</b> speaks all 240 lines aloud. Your score is the
        <b> total length of that audio in seconds</b> — and the <b>lowest time leads the board</b>. Short words,
        tight laws, quick chants win.</>,
    },
    {
      title: <>Same voices for everyone</>,
      body: <>Every entry is spoken by the same fixed voice per language at the same rate, so the clock is fair:
        the only thing that changes the time is what <b>you</b> wrote.</>,
    },
    {
      title: <>Everything is public</>,
      body: <>The full measurement lands under Leaderboard → Solutions: all 20 translations of your twelve laws and
        the spoken length of every line, language by language. The pipeline is stamped on every round.</>,
    },
    ...prizeRule,
    ...deadlineRule,
    oneAccount,
    {
      title: "The champion ships",
      body: <>The laws leading the board when the competition settles become the live wheel of the ArtaRPS game.</>,
    },
  ] : [
    {
      title: "One fixed model — the fit is the game",
      body: <>Every entry is scored against one reference baseline —{" "}
        <span className="font-mono">y = Σ w<sub>i</sub>·sinc(f<sub>i</sub>·(x<sub>i</sub> − p)) + b</span> — with <b>non-negative</b> weights
        and frequencies and a single <b>circular global phase</b> <span className="font-mono">p</span> (which lands in one of the
        twelve seasons of the year's cycle), fit by gradient descent from 12 season-centre starts. The model class is <b>fixed</b>, so the competition is to <b>improve the
        learning algorithm</b> that fits it — not to invent a new model.</>,
    },
    {
      title: "The split — 80/20, a future holdout",
      body: <>Fit on the <b>first 80%</b> of each target&rsquo;s clean months; your score is <b>R²</b> on the <b>last 20%</b> — a{" "}
        <b>future holdout</b> — clamped to [0,&nbsp;1] per target, then averaged across targets and ×100. A model that only tracks the
        past can&rsquo;t buy the future.</>,
    },
    ...prizeRule,
    ...deadlineRule,
    oneAccount,
    { title: "Public and private leaderboard", body: <>Your live score is measured on a public half of the holdout; the prize
      settles on a hidden private half you never score against — so a model tuned only to the public score can&rsquo;t buy the prize.</> },
    { title: "Verified solutions only win", body: <>The public board is open to everyone, but the prize settles only to solutions
      that pass an adversarial review: submit your open code + method on the Submit tab and ArtaCompete re-runs it against the public
      data, confirms your score reproduces, and checks for holdout leakage. An unverified entrant keeps their board rank but their
      medal passes to the next verified member.</> },
    { title: "Hidden holdout", body: <>The test target is held out and never released ({c.holdout || "a hidden split"}). You are
      scored on data you cannot see, so a model that only memorises the training rows won&rsquo;t win.</> },
    { title: "No answer-hunting", body: "The holdout lives only in guarded server-side storage. Attempting to extract it (probing, scraping, or abusing the scorer) disqualifies the account. Probing the public data for leakage — e.g. reverse-engineering timestamps — is legitimate modelling and fair game." },
    { title: "Every entry ships open reproducible code", body: "Each submission carries a public, reproducible code link — a Colab notebook, gist or repo — shown on the Leaderboard and Solutions tabs. The competition is fully transparent: anyone can re-run any entry. ArtaCompete re-runs top solutions to confirm the score reproduces before the prize settles." },
    { title: "Open data (CC BY 4.0)", body: "The datasets are openly licensed under CC BY 4.0 — free to use, share, and build on with attribution." },
  ];
  return (
    <ol className="space-y-4">
      {rules.map((r, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-yang/15 text-[12px] font-bold text-yang tabular-nums">{i + 1}</span>
          <div>
            <p className="text-[15px] font-semibold text-ink">{r.title}</p>
            <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink-3">{r.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* The /competition?slug=<slug> detail — Kaggle-style tabbed workspace over one hosted dataset. The
   active tab lives in ?tab= so it's linkable + survives a reload. */
export default function CompetitionPage() {
  const [params, setParams] = useSearchParams();
  const slug = params.get("slug") || "";
  const tab = useMemo(() => {
    const t = params.get("tab") || "overview";
    return TAB_KEYS.has(t) ? t : "overview";
  }, [params]);
  const setTab = (k: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", k);
    setParams(next, { replace: true });
  };

  const [c, setC] = useState<CompetitionDetail | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!slug) return;
    setC(null); setErr(false);
    Competitions.get(slug).then(setC).catch(() => setErr(true));
  }, [slug]);

  useEffect(() => {
    // Re-assert on tab change too — the embedded Thread (Discussion tab) sets its own document.title,
    // so without this the title stays stuck on the thread's name after switching back.
    if (c?.title) document.title = `${c.title} – Competitions – ArtaQuest`;
  }, [c?.title, tab]);

  if (!slug) return <div className="mx-auto max-w-3xl px-4 py-10 text-[14px] text-ink-3">No competition selected.</div>;
  if (err) return <div className="mx-auto max-w-3xl px-4 py-10 text-[14px] text-ink-3">Couldn&rsquo;t load this competition.</div>;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <a href={localePath("/competitions/")} className="mb-5 inline-flex text-[13px] text-ink-3 hover:text-yin-light">← Competitions</a>
      <header className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{c ? c.title : slug}</h1>
          {/* The dataset is a WORK in the challenge frame: hearts here rank the season's Dataset
              Challenge, alongside this arena's own metric leaderboard. */}
          {!!c?.id && <WorkHeart kind="dataset" id={c.id} authorSlug={c.owner_slug || undefined} />}
        </div>
        {c && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-3">
            <span>
              by{" "}
              {c.owner_slug
                ? <a href={localePath(`/u/${c.owner_slug}`)} className="font-semibold text-ink-2 hover:text-yin-light">{c.owner || "ArtaQuest"}</a>
                : <span className="font-semibold text-ink-2">{c.owner || "ArtaQuest"}</span>}
            </span>
            {c.metric && <Pill>{c.metric}</Pill>}
            {c.prize > 0 && <span className="inline-flex items-center rounded-pill bg-yang/15 px-2 py-0.5 text-[11px] font-bold text-yang">₳{c.prize} prize</span>}
            <Countdown deadline={c.deadline} status={c.status} />
          </div>
        )}
      </header>

      <Tabs
        tabs={TABS.filter((t) =>
          c && isChantMetric(c.metric) ? t.key !== "data" && t.key !== "results"
          : c && !isPhaseMetric(c.metric) ? t.key !== "results"
          : true)}
        active={tab} onChange={setTab} className="mb-6" label="Competition sections" />

      {!c ? (
        <p className="text-[14px] text-ink-3">Loading…</p>
      ) : (
        <div id={`aqpanel-${tab}`} role="tabpanel" aria-labelledby={`aqtab-${tab}`}>
          {tab === "overview" && <Overview c={c} onTab={setTab} />}
          {tab === "data" && <DataPanel c={c} />}
          {tab === "leaderboard" && (
            <>
              <Leaderboard slug={slug} prize={c.prize} naming={isChantMetric(c.metric)} phase={isPhaseMetric(c.metric)} />
              <Solutions slug={slug} naming={isChantMetric(c.metric)} phase={isPhaseMetric(c.metric)} />
            </>
          )}
          {tab === "results" && (
            isPhaseMetric(c.metric)
              ? <ResultsPanel slug={slug} />
              : <p className="text-[14px] text-ink-3">This competition has no results plots.</p>
          )}
          {tab === "discussion" && (
            c.thread_id
              ? <Thread forum="competitions" slug={String(c.thread_id)} />
              : <p className="text-[14px] text-ink-3">This competition has no discussion thread yet.</p>
          )}
          {tab === "submit" && <SubmitPanel slug={slug} keyCol={c.key_col || "trend|date"} prize={c.prize} entryFee={c.entry_fee ?? 0} my={c.my_review} naming={isChantMetric(c.metric)} phase={isPhaseMetric(c.metric)} />}
          {tab === "rules" && <Rules c={c} />}
        </div>
      )}
    </div>
  );
}
