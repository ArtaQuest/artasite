import { useEffect, useState, type ReactNode } from "react";
import { Card, PageHero, cx } from "../components/ui";
import { localePath } from "../lib/wp";
import { translateStatus, type TranslateStatus, type TranslateRecent } from "../lib/api";

// Server extras not yet in the shared type (api.ts is mid-flight in a parallel session): the
// auto-improvement focus languages and the nightly GC stats.
type StatusFull = TranslateStatus & {
  langs?: { code: string; name: string }[];
  gc?: { at?: number; edited?: number; purged?: number; cold?: number };
};

/*
  ArtaTranslate — the public transparency page for the mesh's slow second pass. The i18n mesh gives
  every string an instant machine translation (the Google edge); ArtaTranslate then re-translates each
  one with a state-of-the-art open translation model and multiple rounds of adversarial review, and the
  upgraded translation replaces the edge one for every future visitor. Everything here is live from the
  public queue (GET /translate/status); every round is a public row in aq_tr_rounds. Gold + blue only.
*/

const LIFECYCLE: { n: string; title: string; body: string }[] = [
  { n: "1", title: "The edge", body: "The first visitor to any string in any language triggers an instant machine translation — the page is never blocked. That edge translation is cached once, ever. Each later visit counts as demand: content people keep reading is queued for upgrade; content nobody re-reads keeps its edge text and costs nothing." },
  { n: "2", title: "Draft", body: "A state-of-the-art open translation model (Google's TranslateGemma family on Hugging Face) re-translates the string from the English source — not from the machine output." },
  { n: "3", title: "Attack", body: "An adversarial editor hunts for flaws in every candidate — mistranslation, omissions, wrong register, broken numbers or names — and writes the best translation with a critique and an honest score." },
  { n: "4", title: "Repeat", body: "Further rounds re-examine the winner as a hostile examiner. Only a translation the critic can no longer fault is accepted; every round is stored publicly." },
  { n: "5", title: "Serve", body: "The upgraded translation replaces the edge one in place. The next visitor — and every read-along audiobook waiting on those sentences — simply gets the better text." },
];

const PRIORITIES: { k: string; title: string; body: string }[] = [
  { k: "p2", title: "Audiobook sentences", body: "A narration in another language reads upgraded sentences, never raw machine output — its book's sentences jump the whole queue." },
  { k: "demanded", title: "In-demand content", body: "Strings on pages people keep returning to — every repeat visit raises their place, so the most-read content in each language is improved first." },
  { k: "waiting", title: "Awaiting demand", body: "Translated once on the edge and cached. Upgraded only if visitors come back to them — and anything unused for six months (edited or deleted originals, changed copy) is swept out by the nightly cleaner, so updates never bloat the database." },
];

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">{label}</p>
      <p className="mt-1 text-[22px] font-extrabold leading-none text-ink">{value}</p>
      {hint && <p className="mt-1.5 text-[12.5px] leading-snug text-ink-3">{hint}</p>}
    </Card>
  );
}

/** One recent upgrade: source → final, with the expandable round-by-round adversarial record. */
function Recent({ r }: { r: TranslateRecent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-card border border-line bg-space-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-yin/40 bg-yin/[0.10] px-2 py-0.5 text-[11px] font-semibold uppercase text-yin-light">{r.lang}</span>
        <span className="rounded-full border border-yang/40 bg-yang/[0.10] px-2 py-0.5 text-[11px] font-semibold text-yang">quality {r.quality}</span>
        <span className="text-[11px] text-ink-2">{r.rounds.length} rounds</span>
      </div>
      {/* data-ay-skip: these are EXHIBITS of accepted translations — the mesh must never re-translate
          them in place (it would persist junk pairs and replace the very text this page showcases). */}
      <p data-ay-skip="1" className="mt-2 text-[13px] leading-relaxed text-ink-3">{r.source}</p>
      <p data-ay-skip="1" className="mt-1 text-[14.5px] font-semibold leading-relaxed text-ink" dir="auto">{r.final}</p>
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className="mt-2 text-[12.5px] font-semibold text-yin-light hover:underline">
        {open ? "Hide the rounds" : "See every round"}
      </button>
      {open && (
        <ol className="mt-3 space-y-2 border-t border-line pt-3">
          {r.rounds.map((x) => (
            <li key={x.round} className="text-[13px] leading-relaxed">
              <p className="font-mono text-[11.5px] uppercase tracking-wide text-ink-2">
                r{x.round} · {x.engine}{x.score ? ` · score ${x.score}` : ""}
              </p>
              <p data-ay-skip="1" className="mt-0.5 text-ink-2" dir="auto">{x.candidate}</p>
              {x.critique && <p data-ay-skip="1" className="mt-0.5 text-[12.5px] italic text-ink-3">“{x.critique}”</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function ArtaTranslate({ embedded = false }: { embedded?: boolean } = {}) {
  const [status, setStatus] = useState<StatusFull | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    translateStatus().then((s) => setStatus(s as StatusFull)).catch(() => setErr(true));
  }, []);

  const totals = status?.totals;
  const done = totals ? totals.arta : 0;
  const pending = totals ? totals.auto : 0;
  // The queue is demand-aware: only in-demand strings (+ narration sentences) are ever reviewed, so
  // "in the queue" and progress are measured against the content in demand, not the whole cache.
  const claimable = status?.queue ? (status.queue.p2 ?? 0) + (status.queue.demanded ?? 0) : null;
  const denom = claimable != null ? done + claimable : done + pending;
  const pct = denom > 0 ? Math.round((done / denom) * 100) : 0;

  return (
    <div className={embedded ? "flex flex-col" : "flex flex-col py-1"}>
      {embedded ? (
        <p className="max-w-[80ch] text-[14px] leading-relaxed text-ink-3">
          Every ArtaQuest work is published in ~133 languages through a shared translation mesh. The first
          reader of any string gets an instant machine translation; ArtaTranslate is the slow second pass —
          a state-of-the-art open model re-drafts it and an adversarial editor attacks the result over
          multiple rounds until the upgraded translation replaces the machine one for everyone. Nothing is
          hidden: the live queue, every round and every critique are below.
        </p>
      ) : (
        <PageHero
          eyebrow="ArtaTranslate · Transparency"
          title="ArtaTranslate — every translation, adversarially improved"
          lede="ArtaQuest speaks ~133 languages through a shared translation mesh: the first visitor to any string gets an instant machine translation, cached once for everyone. ArtaTranslate is the slow second pass — a state-of-the-art open translation model re-drafts each cached string, an adversarial editor attacks the result over multiple rounds, and the winning translation quietly replaces the machine one for every future visitor. Nothing is hidden: the queue, every round and every critique are public."
        />
      )}

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Upgraded" value={status ? done.toLocaleString() : "—"} hint="Strings now serving an adversarially-reviewed translation" />
        <Stat label="In demand" value={status ? (claimable ?? pending).toLocaleString() : "—"} hint="Strings people keep reading, awaiting their upgrade — most-read first, slowly on purpose" />
        <Stat label="Progress" value={status ? `${pct}%` : "—"} hint="Of the content in demand" />
        <Stat label="Engine" value={<span className="text-[14px] font-bold leading-snug">{status?.engine || "TranslateGemma draft → adversarial rounds"}</span>} hint="SOTA open model draft, then hostile review rounds until faultless" />
      </div>

      {err && (
        <p className="mt-4 rounded-card border border-line bg-space-2 p-4 text-[14px] text-ink-3">The live queue is briefly unavailable — the pipeline description below still applies.</p>
      )}

      {/* How it works */}
      <div className="mt-12">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-3">How it works</p>
        <h2 className="mt-1 text-[clamp(1.3rem,2.4vw,1.7rem)] font-extrabold leading-tight text-ink">From instant edge to faultless translation</h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {LIFECYCLE.map((s) => (
            <li key={s.n} className="rounded-card border border-line bg-space-2 p-4">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-yang text-[12px] font-bold text-on-accent">{s.n}</div>
              <p className="mt-2 text-[14px] font-bold text-ink">{s.title}</p>
              <p className="mt-1 text-[12.5px] leading-snug text-ink-3">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>

      {/* The queue, by priority */}
      <div className="mt-12">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-3">The queue</p>
        <h2 className="mt-1 text-[clamp(1.3rem,2.4vw,1.7rem)] font-extrabold leading-tight text-ink">Slow by design, in the right order</h2>
        <p className="mt-2 max-w-[72ch] text-[14px] leading-relaxed text-ink-2">
          Upgrades run as a steady drip — one small batch at a time, one language at a time — so the
          platform never trades reliability for speed. What moves first is what a person is waiting on.
          Automatic upgrades focus on the world's most-spoken languages; audiobook narrations are
          upgraded in <b className="text-ink">any</b> language, because a member asked for them by name.
        </p>
        {!!status?.langs?.length && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
            Focus languages: {status.langs.map((l) => l.name).join(" · ")}
          </p>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {PRIORITIES.map((p) => (
            <div key={p.k} className="rounded-card border border-line bg-space-2 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[14.5px] font-bold text-ink">{p.title}</p>
                <span className="shrink-0 rounded-full border border-yin/40 bg-yin/[0.10] px-2.5 py-0.5 text-[12px] font-bold text-yin-light">
                  {status?.queue?.[p.k] != null ? status.queue[p.k].toLocaleString() : "—"}
                </span>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{p.body}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Audiobooks */}
      <div className="mt-12 rounded-card border border-yin/30 bg-yin/[0.06] p-5">
        <h2 className="text-[17px] font-bold text-ink">Translated audiobooks</h2>
        <p className="mt-1.5 max-w-[80ch] text-[14px] leading-relaxed text-ink-2">
          When a member commissions an <a href={localePath("/library/")} className="font-semibold text-yin-light hover:underline">ArtaVoice</a> narration
          in another language, the book's every sentence goes through this same pipeline first — at the
          head of the queue — and the voice reads the adversarially-reviewed translation, never raw
          machine output. The reader's sentence highlighting follows the same upgraded text, so what you
          hear and what you see agree.
        </p>
      </div>

      {/* Recent upgrades */}
      <div className="mt-12">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-3">Live record</p>
        <h2 className="mt-1 text-[clamp(1.3rem,2.4vw,1.7rem)] font-extrabold leading-tight text-ink">The latest upgrades, round by round</h2>
        <p className="mt-2 max-w-[72ch] text-[14px] leading-relaxed text-ink-2">
          Each card shows the English source, the accepted translation, and — expanded — every candidate,
          every critique and every score on the way there. The full history of every string lives in the
          public <a href={localePath("/data/")} className="font-semibold text-yin-light hover:underline">Data explorer</a>.
        </p>
        <div className={cx("mt-4 grid gap-3", status?.recent?.length ? "lg:grid-cols-2" : "")}>
          {status === null && !err && <p className="text-[14px] text-ink-3">Loading the live queue…</p>}
          {status && !status.recent?.length && (
            <p className="rounded-card border border-line bg-space-2 p-4 text-[14px] text-ink-3">
              No upgrades recorded yet — the queue is just getting started. Check back soon.
            </p>
          )}
          {status?.recent?.map((r) => <Recent key={`${r.hash}-${r.lang}`} r={r} />)}
        </div>
      </div>

      {/* Footer */}
      <div className="mt-12 border-t border-line pt-6">
        <p className="text-[13px] leading-relaxed text-ink-3">
          The pipeline is <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12px]">src/Translate.php</code> +{" "}
          <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12px]">tools/ticket-agent/translate-relay.mjs</code>; the
          rounds live in the public <code className="rounded bg-space-1 px-1 py-0.5 font-mono text-[12px]">aq_tr_rounds</code> table.
          Because the entire database is public, you can audit every translation and every critique yourself.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href={localePath("/data/")} className="rounded-field border border-line px-3.5 py-2 text-[13px] font-semibold text-ink hover:border-yin-light hover:text-ink">Open the Data explorer →</a>
          <a href={localePath("/library/")} className="rounded-field border border-line px-3.5 py-2 text-[13px] font-semibold text-ink hover:border-yin-light hover:text-ink">Hear a read-along →</a>
        </div>
      </div>
    </div>
  );
}
