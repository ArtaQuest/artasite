import { useState, type ReactNode } from "react";
import { Card, PageHero, cx } from "../components/ui";
import { localePath } from "../lib/wp";
import { PROMPT_BLOCKS, REVIEWER_MODEL, REVIEWER_EFFORT, type PromptBlock } from "../data/artascience-prompt";

/*
  ArtaScience — the public transparency page for the fully-automated AI reviewer behind every ArtaQuest
  journal. Radical transparency is the platform's ethos (the whole database is public), so this page shows
  the reviewer's EXACT prompt — verbatim, broken into its natural blocks — and, for each block, why it is
  there and what it protects. Grounded entirely in the dumped prompt (src/data/artascience-prompt.ts)
  and the reviewer daemon (tools/ticket-agent/artascience-relay.mjs). Two accents only: gold + blue.
*/

const REVIEWER = "ArtaScience";
const RELAY = "tools/ticket-agent/artascience-relay.mjs";

// ── The seven weighted scoring axes (verbatim weights from the rubric in the prompt). ──────────────
const RUBRIC: { axis: string; weight: number; why: string }[] = [
  { axis: "Reproducibility & correctness", weight: 30, why: "Compiles, the code runs from a blank environment, and every claim, number and figure regenerates from the open data. The journal's core — work that does not reproduce cannot score highly or be accepted." },
  { axis: "Honesty & identification", weight: 15, why: "Claims match the evidence; in-sample or descriptive results are not dressed up as causal or predictive; competing explanations are confronted; limitations are candid; the data is described truthfully." },
  { axis: "Communication & clarity", weight: 15, why: "An informative title that matches the metadata, a plain-language abstract, clear structure and argument, precise prose, and the key takeaway surfaced where a reader will see it." },
  { axis: "Visualisation", weight: 12, why: "Publication-grade, code-generated figures: the right chart type, axes labelled with units, self-contained captions, and faithfully showing all the data the captions claim." },
  { axis: "Accessibility", weight: 8, why: "Figures readable in greyscale and for colour-vision deficiency (class encoded by line style and marker, not colour alone), a plain-language abstract, and SI units." },
  { axis: "References", weight: 10, why: "Every citation real and individually DOI-verified, correctly cited, with no orphans or undefined references." },
  { axis: "Significance & rigour", weight: 10, why: "The question matters, the method is sound, and uncertainty is quantified." },
];

// ── Lifecycle steps, grounded in artascience-relay.mjs + Science.php. ───────────────────────────────
const LIFECYCLE: { n: string; title: string; body: string }[] = [
  { n: "1", title: "Submit", body: "An author posts a LaTeX manuscript, open code and open data to the public queue. There is no human peer review." },
  { n: "2", title: "Claim", body: "While the reviewer machine is awake it long-polls for a queued submission and claims one. Exactly one review runs at a time." },
  { n: "3", title: "Sandboxed review", body: "The reviewer runs in a locked-down sandbox: it clones the code, fetches the data, runs the analysis end-to-end, and checks the results reproduce the claims." },
  { n: "4", title: "Verdict & rounds", body: "It writes a strict JSON verdict — reproduced (yes/no), a 0–100 score, the seven sub-scores, and a published report. A revise sends the paper back for another round; the six-round cap is a ceiling, not a target — most strong papers converge in two to four rounds, and the reviewer accepts as soon as the work reproduces and every axis is strong rather than holding it for cosmetic polish. Accept and reject are final, and the last round is terminal, so review always converges." },
  { n: "5", title: "On accept, publish", body: "The server (not the reviewer machine) mints the permanent DOI and builds the Colab notebook, awards the author points, and opens a public discussion thread. Publishing is idempotent and crash-safe: the DOI is minted exactly once and, being permanent, is never re-issued or revoked — even if the connection drops mid-publish." },
];

// ── Security model, grounded in sandboxProfile() + the stripped child env in the daemon. ────────────
const SECURITY: { title: string; body: string }[] = [
  { title: "The submission is untrusted data", body: "The reviewer treats the manuscript, README, code comments and data as content to review, never as instructions — a prompt-injection defence written into the SECURITY block of the prompt below." },
  { title: "A sandbox denies the platform", body: "Claude (and the submission code it runs) is wrapped in a macOS sandbox-exec profile that denies the ArtaQuest repo, the agent state, SSH/AWS/GPG keys, and every other credential store on the machine. The whole process tree is confined." },
  { title: "Secrets are stripped from its environment", body: "Every platform secret — the worker token, the archive token, anything matching TOKEN/SECRET/KEY/PASSWORD — is removed from the reviewer's environment, so the submitted code cannot read one even if it tries." },
  { title: "No API keys on the reviewer machine", body: "Publishing that needs secrets (the DOI, the Colab notebook) runs entirely on the server via its Vault, so no third-party API key ever lives on the machine that runs strangers' code. The network is allowed only so the reviewer can fetch the submission and resolve DOIs." },
];

/** Verbatim prompt text: monospace, whitespace preserved, HTML-escaped by React (it is a text node). */
function Verbatim({ text }: { text: string }) {
  return (
    <pre className="aq-no-print overflow-x-auto whitespace-pre-wrap break-words rounded-card border border-line bg-space-1 p-4 font-mono text-[12.5px] leading-relaxed text-ink-2">
      {text}
    </pre>
  );
}

/** One annotated block: the exact prompt text, then the plain-English "why it's here" beside/under it. */
function Block({ block, index }: { block: PromptBlock; index: number }) {
  const tag = block.group === "system" ? "System prompt" : "Task prompt";
  const tagCls = block.group === "system" ? "border-yin/40 bg-yin/[0.10] text-yin-light" : "border-yang/40 bg-yang/[0.10] text-yang";
  return (
    <section className="scroll-mt-24">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-space-3 text-[12px] font-bold text-ink-2">{index}</span>
        <h3 className="text-[17px] font-bold leading-snug text-ink">{block.section}</h3>
        <span className={cx("rounded-full border px-2 py-0.5 text-[11px] font-semibold", tagCls)}>{tag}</span>
      </div>
      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-6">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">Exact text</p>
          <Verbatim text={block.text} />
        </div>
        <div className="lg:pt-[1.6rem]">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">Why it's here</p>
          <div className="rounded-card border border-line bg-space-2 p-4 text-[14px] leading-relaxed text-ink-2">{block.why}</div>
        </div>
      </div>
    </section>
  );
}

function SectionTitle({ children, kicker }: { children: ReactNode; kicker?: string }) {
  return (
    <div className="mb-4">
      {kicker && <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-3">{kicker}</p>}
      <h2 className="mt-1 text-[clamp(1.3rem,2.4vw,1.7rem)] font-extrabold leading-tight text-ink">{children}</h2>
    </div>
  );
}

export default function ArtaScience() {
  const [tab, setTab] = useState<"all" | "system" | "task">("all");
  const filtered = PROMPT_BLOCKS.filter((b) => tab === "all" || b.group === tab);
  const sysCount = PROMPT_BLOCKS.filter((b) => b.group === "system").length;
  const taskCount = PROMPT_BLOCKS.filter((b) => b.group === "task").length;
  const tabs: [typeof tab, string][] = [["all", `All ${PROMPT_BLOCKS.length}`], ["system", `System ${sysCount}`], ["task", `Task ${taskCount}`]];

  return (
    <div className="flex flex-col py-1">
      {/* ── 1. HEADER ── */}
      <a href={localePath("/research/")} className="text-[14px] font-semibold text-yin-light hover:underline">← ArtaQuest Journals</a>
      <div className="mt-4">
        <PageHero
          eyebrow={`${REVIEWER} · Transparency`}
          title="ArtaScience — the AI that reviews every paper"
          lede={`ArtaScience is the fully-automated reviewer behind every ArtaQuest journal. There is no human peer review. Instead of judging a manuscript by its description, ArtaScience actually runs the submitted code against the open data inside a locked-down sandbox and reproduces every claim before it decides — judging each submission against its own journal's scope. Reviews iterate over multiple rounds — revise, improve, accept — until the work meets the bar.`}
        />
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">Reviewer</p>
          <p className="mt-1 text-[15px] font-bold text-ink">{REVIEWER_MODEL}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">effort: <span className="font-semibold text-yin-light">{REVIEWER_EFFORT}</span>, with full tools</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">How it judges</p>
          <p className="mt-1 text-[14px] leading-snug text-ink-2">It compiles, clones, runs and reproduces — a verdict comes only from what it observes, never the abstract alone.</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">This page</p>
          <p className="mt-1 text-[14px] leading-snug text-ink-2">Shows the reviewer's <b className="text-ink">exact prompt</b>, block by block — the whole thing the reviewer is given.</p>
        </Card>
      </div>

      <p className="mt-5 rounded-card border border-yin/30 bg-yin/[0.06] p-4 text-[15px] leading-relaxed text-ink-2">
        The platform's ethos is <b className="text-ink">radical transparency</b> — the entire database is public. In that spirit, the
        full prompt below is exactly what the reviewer is given. Nothing is paraphrased or withheld: the verbatim system
        and task prompts are shown alongside a plain-English note on why each part is there.
      </p>

      {/* ── 2. HOW IT WORKS ── */}
      <div className="mt-12">
        <SectionTitle kicker="How it works">The lifecycle of a review</SectionTitle>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {LIFECYCLE.map((s) => (
            <li key={s.n} className="rounded-card border border-line bg-space-2 p-4">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-yang text-[12px] font-bold text-on-accent">{s.n}</div>
              <p className="mt-2 text-[14px] font-bold text-ink">{s.title}</p>
              <p className="mt-1 text-[12.5px] leading-snug text-ink-3">{s.body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-5">
          <h3 className="text-[14px] font-bold text-ink">The security model</h3>
          <p className="mt-1 text-[13.5px] leading-relaxed text-ink-3">The reviewer runs arbitrary, untrusted code from strangers, so it is isolated from the platform on every layer.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {SECURITY.map((x) => (
              <div key={x.title} className="rounded-card border border-line bg-space-2 p-4">
                <p className="text-[14px] font-bold text-yin-light">{x.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{x.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── 3. SCORING RUBRIC ── */}
      <div className="mt-12">
        <SectionTitle kicker="Scoring">The rubric is public</SectionTitle>
        <p className="text-[14px] leading-relaxed text-ink-2">
          Every score is the weighted average of seven axes, and every published review shows the per-axis breakdown so
          authors and the public see exactly how the number was derived.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {RUBRIC.map((r) => (
            <div key={r.axis} className="rounded-card border border-line bg-space-2 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[14.5px] font-bold text-ink">{r.axis}</p>
                <span className="shrink-0 rounded-full border border-yang/40 bg-yang/[0.10] px-2.5 py-0.5 text-[12px] font-bold text-yang">weight {r.weight}</span>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{r.why}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[12.5px] text-ink-3">The weights sum to 100. The overall score is their weighted average, with reproducibility carrying the most weight by design.</p>
      </div>

      {/* ── 4. THE EXACT PROMPT, ANNOTATED ── */}
      <div className="mt-12">
        <SectionTitle kicker="Verbatim">The exact prompt, annotated</SectionTitle>
        <p className="text-[14px] leading-relaxed text-ink-2">
          The reviewer is run as <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12.5px]">claude -p &lt;task&gt; --append-system-prompt &lt;system&gt; --effort max</code> inside the
          sandbox. Below is every block of both prompts, verbatim. Placeholder tokens like{" "}
          <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12.5px]">&lt;journal name&gt;</code>,{" "}
          <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12.5px]">&lt;the journal's scope&gt;</code>,{" "}
          <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12.5px]">&lt;workdir&gt;/verdict.json</code> and{" "}
          <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12.5px]">&lt;round&gt;</code> are where runtime values are interpolated per submission — shown here as placeholders. ArtaQuest hosts several
          journals (the Journal of Seasonality, Educational Accessibility, and more), and the journal name and scope are filled in for each paper so ArtaScience judges every submission against its own journal's remit.
        </p>

        <div role="group" aria-label="Filter prompt blocks" className="mt-4 flex flex-wrap gap-1.5">
          {tabs.map(([k, lbl]) => (
            <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}
              className={cx("rounded-pill px-3 py-1 text-[13px] font-semibold transition-colors", tab === k ? "bg-yang text-on-accent" : "bg-space-3 text-ink-2 hover:text-ink")}>
              {lbl}
            </button>
          ))}
        </div>

        <div className="mt-6 space-y-10">
          {filtered.map((b) => (
            <Block key={b.section} block={b} index={PROMPT_BLOCKS.indexOf(b) + 1} />
          ))}
        </div>
      </div>

      {/* ── 5. FOOTER NOTE ── */}
      <div className="mt-12 border-t border-line pt-6">
        <p className="text-[13px] leading-relaxed text-ink-3">
          This page mirrors the reviewer source <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12px]">{RELAY}</code>, regenerable
          with <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12px]">node artascience-relay.mjs dump-prompt</code>. Because the entire
          database is public, you can read every submission and every round of review yourself.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href={localePath("/research/?submissions=1")} className="rounded-field border border-line px-3.5 py-2 text-[13px] font-semibold text-ink hover:border-yin-light hover:text-ink">Browse the public review queue →</a>
          <a href={localePath("/data/")} className="rounded-field border border-line px-3.5 py-2 text-[13px] font-semibold text-ink hover:border-yin-light hover:text-ink">Open the Data explorer →</a>
          <a href={localePath("/research/")} className="rounded-field border border-line px-3.5 py-2 text-[13px] font-semibold text-ink hover:border-yin-light hover:text-ink">ArtaQuest Journals →</a>
        </div>
        <p className="mt-6 border-t border-line pt-4 text-[12px] text-ink-3">ArtaQuest Journals · automated AI review · open access (CC BY 4.0) · every article reproduced from its open data and code before publication</p>
      </div>
    </div>
  );
}
