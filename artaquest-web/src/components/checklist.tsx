/**
 * The reproducibility checklist, rendered.
 *
 * This IS the platform's scorecard now (operator order 2026-07-28) — there is no grade, no rank
 * and no opinion anywhere in it, only a list of facts read back from Kaggle's public API with the
 * exact evidence each one read. The same component renders it for the author, who is deciding
 * whether to publish, and for a reader, who is deciding whether to believe it. That is deliberate:
 * an author must never see a friendlier version of the truth than their readers do.
 *
 * Colour: the platform has two colours and no red. A blocking failure is BLUE (the yin side, used
 * for every failure state on the platform), a warning is GOLD, a pass is quiet ink. Nothing here
 * shouts — a checklist that reads as an accusation stops being read. Failure text uses the
 * ink-safe `yin-ink` rather than raw `yin`, which is ~2.6:1 on the dark canvas.
 *
 * i18n: `detail` and `fix` are composed PER AUTHOR — they carry filenames, dataset refs, byte
 * counts and HTTP codes — so they are skip-marked in full. Unmarked they would be unique strings
 * the content-hash mesh can never cache, translated into nonsense, and they would publish a
 * member's filenames into the PUBLIC translations table.
 */
import { useState } from "react";
import type { NbCheck, NbChecklist } from "../lib/api";
import { Button, Card, cx } from "./ui";

const GROUP_ORDER: Array<NbCheck["group"]> = ["open", "inputs", "run", "rigour"];

/** state + severity → the one visual language used everywhere a check appears. */
function tone(i: NbCheck) {
  if (i.state === "pass") return { mark: "✓", cls: "text-ink-3", ring: "border-line" };
  if (i.state === "skip") return { mark: "·", cls: "text-ink-3", ring: "border-line" };
  return i.severity === "block"
    ? { mark: "✕", cls: "text-yin-ink", ring: "border-yin" }
    : { mark: "!", cls: "text-yang", ring: "border-yang" };
}

function CheckRow({ i }: { i: NbCheck }) {
  const t = tone(i);
  const loud = i.state === "fail";
  return (
    <li className={cx("flex gap-3 border-s-2 py-2 ps-3", loud ? t.ring : "border-transparent")}>
      <span aria-hidden className={cx("mt-[2px] w-4 shrink-0 text-center text-[13px] font-bold", t.cls)}>{t.mark}</span>
      <div className="min-w-0 flex-1">
        <p className={cx("text-[14px] font-semibold leading-snug", i.state === "pass" ? "text-ink-2" : "text-ink")}>
          {i.title}
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3" data-ay-skip="1">{i.detail}</p>
        {i.fix !== "" && (
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2" data-ay-skip="1">{i.fix}</p>
        )}
        {i.evidence !== "" && (
          <p className="mt-1 truncate font-mono text-[11.5px] text-ink-3" title={i.evidence}>
            <span data-ay-skip="1">{i.evidence}</span>
          </p>
        )}
      </div>
    </li>
  );
}

/** The headline: what is wrong, in one line, or that nothing is. */
export function ChecklistSummary({ checks, className }: { checks: NbChecklist; className?: string }) {
  const { blocks, pending, warnings } = checks;
  const good = blocks === 0 && pending === 0;
  return (
    <div className={cx("flex flex-wrap items-center gap-2", className)}>
      <span
        className={cx(
          "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-semibold",
          good ? "bg-yang/15 text-yang-ink" : blocks > 0 ? "bg-yin/15 text-yin-ink" : "bg-space-3 text-ink-2",
        )}
      >
        {good ? "Every check passed" : blocks > 0 ? "Not ready to publish" : "A few steps left"}
      </span>
      {blocks > 0 && (
        <span className="text-[12.5px] text-ink-3">
          <span data-ay-skip="1">{blocks}</span> to fix
        </span>
      )}
      {pending > 0 && (
        <span className="text-[12.5px] text-ink-3">
          <span data-ay-skip="1">{pending}</span> waiting on you
        </span>
      )}
      {warnings > 0 && (
        <span className="text-[12.5px] text-ink-3">
          <span data-ay-skip="1">{warnings}</span> to be aware of
        </span>
      )}
    </div>
  );
}

/**
 * The full list.
 *
 * Passing checks collapse by default — twenty green ticks bury the one thing an author has to act
 * on — but they are one click away, because hiding evidence is exactly what this list exists not
 * to do.
 */
export function Checklist({ checks, className }: { checks: NbChecklist; className?: string }) {
  const [showPassed, setShowPassed] = useState(false);
  const groups = GROUP_ORDER.filter((g) => checks.items.some((i) => i.group === g));
  const passed = checks.items.filter((i) => i.state === "pass").length;

  return (
    <div className={className}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <ChecklistSummary checks={checks} />
        {passed > 0 && (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={showPassed}
            onClick={() => setShowPassed((v) => !v)}
          >
            {showPassed ? "Hide what passed" : "Show what passed"}
          </Button>
        )}
      </div>

      {groups.map((g) => {
        const all = checks.items.filter((i) => i.group === g);
        const shown = showPassed ? all : all.filter((i) => i.state !== "pass");
        if (!shown.length) return null;
        return (
          <Card key={g} className="mb-3 p-4">
            <h3 className="mb-1 text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">
              {checks.groups[g] || g}
            </h3>
            <ul className="divide-y divide-line/50">
              {shown.map((i) => <CheckRow key={i.id} i={i} />)}
            </ul>
          </Card>
        );
      })}

      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
        Every item is read back from Kaggle's public API, which answers without a login — so anyone
        can re-run these checks against your notebook and contradict us.
      </p>
    </div>
  );
}

/** The four facts, as chips — the compact form used on cards and work pages. */
export function KernelFacts({ facts, className }: { facts: NbChecklist["facts"]; className?: string }) {
  if (!facts) return null;
  const srcs = facts.sources;
  const allPublic = Array.isArray(srcs) && srcs.every((s) => s.public);
  const chips: Array<{ label: string; good: boolean }> = [];
  if (facts.slug) chips.push({ label: "Public notebook", good: true });
  if (typeof facts.internet === "boolean") {
    chips.push({ label: facts.internet ? "Internet was on" : "No internet", good: !facts.internet });
  }
  if (Array.isArray(srcs)) {
    chips.push({
      label: srcs.length === 0 ? "No external inputs" : allPublic ? "Public inputs" : "Private inputs",
      good: allPublic,
    });
  }
  if (typeof facts.gpu === "boolean" || typeof facts.tpu === "boolean") {
    chips.push({ label: facts.gpu ? "GPU" : facts.tpu ? "TPU" : "CPU only", good: !facts.gpu && !facts.tpu });
  }
  if (facts.run_done === true) chips.push({ label: "Run finished", good: true });
  if (!chips.length) return null;
  return (
    <ul className={cx("flex flex-wrap gap-1.5", className)}>
      {chips.map((c) => (
        <li
          key={c.label}
          className={cx(
            "rounded-full border px-2.5 py-1 text-[11.5px] font-semibold",
            c.good ? "border-yang/40 text-yang-ink" : "border-line text-ink-3",
          )}
        >
          {c.label}
        </li>
      ))}
    </ul>
  );
}
