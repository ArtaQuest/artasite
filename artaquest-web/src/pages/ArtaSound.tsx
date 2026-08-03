import { useEffect, useState, type ReactNode } from "react";
import { Card, PageHero, cx } from "../components/ui";
import { localePath } from "../lib/wp";
import { getMusicStudio, type MusicStudioStatus } from "../lib/api";
import { PROMPT_BLOCKS, STUDIO_MODEL, STUDIO_EFFORT, type PromptBlock } from "../data/artasound-prompt";

/*
  ArtaSound — the public transparency page for the AI music + audiobook studio, the sibling of
  /artascience. Radical transparency is the platform's ethos, so this page shows the studio's EXACT
  prompts (composer + adversarial critic) verbatim, the measured quality gates, the engine chain, and
  the live studio pulse. Every track page shows its own rounds — each attempt's recording, the
  measurements, and the critic's full report. Grounded entirely in the relay source
  (tools/ticket-agent/music-relay.mjs + audiocheck.py) and src/Music.php.
*/

const RELAY = "tools/ticket-agent/music-relay.mjs";

// ── Lifecycle, grounded in music-relay.mjs + Music.php. ─────────────────────────────────────────────
const LIFECYCLE: { n: string; title: string; body: string }[] = [
  { n: "1", title: "Brief", body: "A member describes the music they want — or pastes their own manuscript for an audiobook — and the project joins the public queue. Drafting is free; you pay only when you publish." },
  { n: "2", title: "Compose", body: "Claude writes an original song for the brief: a full lyric sheet, style tags for the vocal model, and a complete arrangement. On later rounds this becomes a targeted revision of its own work — keeping what the critic praised, rewriting what fell short." },
  { n: "3", title: "Render", body: "The composition is performed by open models, sung vocals first: ACE-Step on a free GPU Space, then the studio's own arrangement renderer, MusicGen, and a parametric composer as fallbacks. Every render is free; the queue works in small chunks so long jobs finish steadily." },
  { n: "4", title: "Measure & critique", body: "The recording is measured — duration, clipping, silence, dynamics, and a ten-slice energy arc that makes song structure visible — then an adversarial critic scores the take against the brief and the measurements, and files a public verdict." },
  { n: "5", title: "Rounds, then review", body: "A 'revise' sends the studio back to recompose against the critique — up to four rounds, each take judged against the best one before it. The strongest recording goes to the author to hear, and only the author publishes. Every round stays public: its recording, its measurements, its report." },
];

// ── What audiocheck.py measures (the critic's instruments). ─────────────────────────────────────────
const MEASURES: { name: string; what: string }[] = [
  { name: "Length & silence", what: "Rendered duration against the requested length, lead-in and trailing silence, the longest internal gap, and the overall silent fraction — dead air and truncated renders are caught mechanically." },
  { name: "Loudness & clipping", what: "RMS level, true peak and the percentage of clipped samples — a distorted or whisper-quiet master forces another round no matter how well the lyrics read." },
  { name: "Dynamics & width", what: "Dynamic range between the loud and quiet passages plus stereo width — a flat drone or a mono smear fails the bar." },
  { name: "The energy arc", what: "Loudness and brightness across ten equal slices of the piece. Structure must be visible here: a brief that promises a build needs a measurable rise into its choruses. This is how a critic that cannot listen still hears the shape of a song." },
];

// ── The engine chain, grounded in renderTake() — SOTA first, free always. ───────────────────────────
const ENGINES: { name: string; role: string }[] = [
  { name: "ACE-Step", role: "Real sung vocals — a state-of-the-art open lyrics-to-song model, run on a free community GPU Space. The studio holds out for it through quota waits before considering anything else." },
  { name: "artascore", role: "The studio's own renderer: it performs Claude's full arrangement (chords, lead melody, bass, drums) locally for free — so a real, original tune always exists even with no GPU available." },
  { name: "MusicGen", role: "A neural instrumental model, used when a piece suits it and the stack is available; supports melody-conditioning from a member's private inspiration audio." },
  { name: "artacompose", role: "A parametric composer — the universal fallback that never fails, so no member's project can strand." },
  { name: "Edge neural voices", role: "For audiobooks: ~322 free neural voices across ~142 languages narrate the member's own manuscript sentence by sentence, with exact per-sentence timings." },
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
  const tag = block.group === "composer" ? "Composer prompt" : "Critic prompt";
  const tagCls = block.group === "composer" ? "border-yang/40 bg-yang/[0.10] text-yang" : "border-yin/40 bg-yin/[0.10] text-yin-light";
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

/** The live studio pulse — GET /music/studio (Music::studio_status). */
function StudioPulse() {
  const [s, setS] = useState<MusicStudioStatus | null>(null);
  useEffect(() => { let live = true; getMusicStudio().then((r) => { if (live) setS(r); }).catch(() => {}); return () => { live = false; }; }, []);
  if (!s) return null;
  const stats: [string, string][] = [
    ["Studio", s.online ? "online now" : "waking"],
    ["In the queue", String(s.queued + s.processing)],
    ["Awaiting their author", String(s.in_review)],
    ["Published", `${s.published}${s.audiobooks ? ` (${s.audiobooks} audiobooks)` : ""}`],
    ["Critique rounds, 24h", String(s.rounds_24h)],
    ["Critique rounds, all time", String(s.rounds_total)],
  ];
  return (
    <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {stats.map(([k, v]) => (
        <Card key={k} className="p-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">{k}</p>
          <p className={cx("mt-1 text-[15px] font-bold", k === "Studio" && s.online ? "text-yang" : "text-ink")}>{v}</p>
        </Card>
      ))}
    </div>
  );
}

export default function ArtaSound() {
  const [tab, setTab] = useState<"all" | "composer" | "critic">("all");
  const filtered = PROMPT_BLOCKS.filter((b) => tab === "all" || b.group === tab);
  const nComposer = PROMPT_BLOCKS.filter((b) => b.group === "composer").length;
  const nCritic = PROMPT_BLOCKS.filter((b) => b.group === "critic").length;
  const tabs: [typeof tab, string][] = [["all", `All ${PROMPT_BLOCKS.length}`], ["composer", `Composer ${nComposer}`], ["critic", `Critic ${nCritic}`]];

  return (
    <div className="flex flex-col py-1">
      {/* ── 1. HEADER ── */}
      <a href={localePath("/music/")} className="text-[14px] font-semibold text-yin-light hover:underline">← Music</a>
      <div className="mt-4">
        <PageHero
          eyebrow="ArtaSound · Transparency"
          title="ArtaSound — how the studio composes, and the critic that pushes back"
          lede="ArtaSound is the AI studio behind every track and audiobook on ArtaQuest. Nothing reaches its author on the first try by default: an adversarial critic measures each recording, scores it against the brief, and sends the studio back to revise — up to four rounds, each take judged against the best one before it. Every round is public on the track page: the recording it produced, what was measured, and the critic's full report."
        />
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">Composer & critic</p>
          <p className="mt-1 text-[15px] font-bold text-ink">{STUDIO_MODEL}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">effort: <span className="font-semibold text-yin-light">{STUDIO_EFFORT}</span> · sung vocals by open models on free GPUs</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">How it judges</p>
          <p className="mt-1 text-[14px] leading-snug text-ink-2">The critic cannot listen — so every recording is <b className="text-ink">measured</b>, and structure is read off a ten-slice energy arc. Verdicts come from the brief, the composition and the numbers.</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">This page</p>
          <p className="mt-1 text-[14px] leading-snug text-ink-2">Shows the studio's <b className="text-ink">exact prompts</b> — composer and critic — plus the measured gates and the live queue.</p>
        </Card>
      </div>

      <StudioPulse />

      <p className="mt-5 rounded-card border border-yin/30 bg-yin/[0.06] p-4 text-[15px] leading-relaxed text-ink-2">
        The platform's ethos is <b className="text-ink">radical transparency</b> — the entire database is public. In that spirit,
        every round of every project is published with its own playable recording, its measurements and the critic's verbatim
        report, and the full prompts below are exactly what the studio is given. Nothing is paraphrased or withheld.
      </p>

      {/* ── 2. HOW IT WORKS ── */}
      <div className="mt-12">
        <SectionTitle kicker="How it works">The lifecycle of a track</SectionTitle>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {LIFECYCLE.map((s) => (
            <li key={s.n} className="rounded-card border border-line bg-space-2 p-4">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-yang text-[12px] font-bold text-on-accent">{s.n}</div>
              <p className="mt-2 text-[14px] font-bold text-ink">{s.title}</p>
              <p className="mt-1 text-[12.5px] leading-snug text-ink-3">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>

      {/* ── 3. THE MEASURED GATES ── */}
      <div className="mt-12">
        <SectionTitle kicker="Measured, not vibes">What every recording is measured on</SectionTitle>
        <p className="text-[14px] leading-relaxed text-ink-2">
          Each take runs through an open measurement tool before the critic sees it. Hard defects — a truncated render,
          clipping, dead air, a flat drone — force a revision mechanically, no matter how well the composition reads.
          The same numbers are published with every round.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {MEASURES.map((m) => (
            <div key={m.name} className="rounded-card border border-line bg-space-2 p-4">
              <p className="text-[14.5px] font-bold text-ink">{m.name}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{m.what}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── 4. THE ENGINES ── */}
      <div className="mt-12">
        <SectionTitle kicker="Free, state of the art">The performers</SectionTitle>
        <p className="text-[14px] leading-relaxed text-ink-2">
          Composition and critique run on the operator's Claude subscription; the audio itself is performed by open
          models on free hardware, best first — so the studio costs members nothing to use, and drafting is always free.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ENGINES.map((e) => (
            <div key={e.name} className="rounded-card border border-line bg-space-2 p-4">
              <p className="text-[14px] font-bold text-yin-light">{e.name}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{e.role}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── 5. THE EXACT PROMPTS, ANNOTATED ── */}
      <div className="mt-12">
        <SectionTitle kicker="Verbatim">The exact prompts, annotated</SectionTitle>
        <p className="text-[14px] leading-relaxed text-ink-2">
          Both stages run as <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12.5px]">claude -p &lt;task&gt; --append-system-prompt &lt;system&gt;</code>.
          Below is every block of both prompts, verbatim. Placeholder tokens like{" "}
          <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12.5px]">&lt;title&gt;</code>,{" "}
          <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12.5px]">&lt;the member's brief&gt;</code> and{" "}
          <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12.5px]">&lt;round&gt;</code> are where runtime values are
          interpolated per project.
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

      {/* ── 6. FOOTER NOTE ── */}
      <div className="mt-12 border-t border-line pt-6">
        <p className="text-[13px] leading-relaxed text-ink-3">
          This page mirrors the studio source <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12px]">{RELAY}</code>. Because the
          entire database is public, you can read every project and every round of critique yourself — and on any published
          track, play each round's recording next to its verdict.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href={localePath("/music/")} className="rounded-field border border-line px-3.5 py-2 text-[13px] font-semibold text-ink hover:border-yin-light hover:text-ink">Browse the music →</a>
          <a href={localePath("/data/")} className="rounded-field border border-line px-3.5 py-2 text-[13px] font-semibold text-ink hover:border-yin-light hover:text-ink">Open the Data explorer →</a>
          <a href={localePath("/research/artascience/")} className="rounded-field border border-line px-3.5 py-2 text-[13px] font-semibold text-ink hover:border-yin-light hover:text-ink">ArtaScience — the same loop on research →</a>
        </div>
        <p className="mt-6 border-t border-line pt-4 text-[12px] text-ink-3">ArtaSound · original music and audiobooks by members · every draft critiqued in the open before its author hears it</p>
      </div>
    </div>
  );
}
