import { useCallback, useEffect, useState } from "react";
import { HealthApi, type HealthCheck, type HealthReport } from "../lib/api";
import { Button, Card, StatusNote, cx } from "./ui";

/**
 * THE HEALTH PANEL — the operator's "is it healthy?" glance, in the Studio's Health tab.
 *
 * It renders AQ\Health (plugin: src/Health.php), which answers the boring question that has caused
 * the visible outages here: is the app the browser gets the app we built? A half-committed SPA
 * build, a route whose handler was renamed, a token allow-list entry pointing nowhere, a cron that
 * quietly stopped, a credential that went missing.
 *
 * Deliberately NOT a dashboard of graphs. Every row is a check with a verdict and the evidence it
 * read, so a red row tells you what to do next rather than that something, somewhere, is wrong.
 *
 * Two colours only: gold carries "look here", blue carries structure. Failure reads as gold-hot
 * rather than a third accent — this platform has exactly two accents and a status panel is not a
 * licence for a third.
 */

const RANK: Record<HealthCheck["status"], number> = { fail: 0, warn: 1, ok: 2 };

const DOT: Record<HealthCheck["status"], string> = {
  fail: "bg-yang",
  warn: "bg-yang/40",
  ok: "bg-yin/50",
};

const WORD: Record<HealthCheck["status"], string> = {
  fail: "Needs attention",
  warn: "Worth a look",
  ok: "Healthy",
};

function Row({ c }: { c: HealthCheck }) {
  const [open, setOpen] = useState(false);
  const hasEvidence = !!c.evidence.trim();
  return (
    <li className="border-t border-line first:border-t-0">
      <button
        type="button"
        onClick={() => hasEvidence && setOpen((v) => !v)}
        aria-expanded={hasEvidence ? open : undefined}
        disabled={!hasEvidence}
        className={cx(
          "flex w-full items-start gap-3 px-3 py-2.5 text-left",
          hasEvidence && "transition-colors hover:bg-veil/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yang/60",
        )}
      >
        <span className={cx("mt-[7px] h-2 w-2 shrink-0 rounded-full", DOT[c.status])} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-ink">{c.label}</span>
            <span className="font-mono text-[11px] text-ink-3">{c.id}</span>
          </span>
          <span className={cx("mt-0.5 block text-[13px] leading-snug", c.status === "ok" ? "text-ink-3" : "text-ink-2")}>{c.detail}</span>
          {hasEvidence && open && (
            <span className="mt-2 block whitespace-pre-wrap break-words rounded-card border border-line bg-veil/[0.03] p-2 font-mono text-[11.5px] leading-relaxed text-ink-3">
              {c.evidence}
            </span>
          )}
        </span>
        <span className="sr-only">{WORD[c.status]}</span>
        {hasEvidence && <span aria-hidden="true" className="mt-0.5 shrink-0 text-[11px] text-ink-3">{open ? "−" : "+"}</span>}
      </button>
    </li>
  );
}

export function HealthPanel() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      setReport(await HealthApi.get());
    } catch {
      // A health panel that goes blank when it cannot reach the backend has told you nothing —
      // and "cannot reach the backend" is itself the most important thing it could say.
      setErr("Couldn't reach the health check. That is itself a signal: the API is not answering, or this session is not an operator one.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const s = report?.summary;
  const groups = report ? (Object.keys(report.groups) as Array<keyof typeof report.groups>) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-ink">Health</h2>
          <p className="mt-0.5 text-[13px] text-ink-3">
            Is the app the browser gets the app we built? Every row reads a file, a route table or an option and reports what it found.
            The rendered half — mount, console errors, brand tokens, overflow — is <span className="font-mono text-[12px]">node tools/ui-health.mjs</span>
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={busy} tip="Re-run every check now">
          {busy ? "Checking…" : "Re-check"}
        </Button>
      </div>

      {err && <StatusNote error>{err}</StatusNote>}

      {s && (
        <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
          <span className="flex items-baseline gap-2">
            <span className={cx("h-2.5 w-2.5 rounded-full", DOT[s.status])} aria-hidden="true" />
            <span className="text-lg font-semibold text-ink">{WORD[s.status]}</span>
          </span>
          <span className="text-[13px] text-ink-2">
            <b className="tabular-nums text-ink">{s.ok}</b> healthy
            {s.warn > 0 && <> · <b className="tabular-nums text-ink">{s.warn}</b> worth a look</>}
            {s.fail > 0 && <> · <b className="tabular-nums text-yang">{s.fail}</b> needing attention</>}
            <span className="text-ink-3"> of {s.total} checks</span>
          </span>
          <span className="ml-auto text-[12px] text-ink-3">
            read {new Date(report.ts * 1000).toLocaleTimeString("en-GB")}
          </span>
        </Card>
      )}

      {!report && !err && <Card className="p-4 text-[13px] text-ink-3">Running the checks…</Card>}

      {report && groups.map((g) => {
        const checks = report.checks
          .filter((c) => c.group === g)
          .sort((a, b) => RANK[a.status] - RANK[b.status]);
        if (!checks.length) return null;
        const worst = checks[0].status;
        return (
          <Card key={String(g)} className="overflow-hidden">
            <div className="flex items-baseline gap-2 border-b border-line px-3 py-2">
              <span className={cx("h-2 w-2 rounded-full", DOT[worst])} aria-hidden="true" />
              <h3 className="font-semibold text-ink">{report.groups[g]}</h3>
              <span className="ml-auto font-mono text-[11px] text-ink-3">{String(g)}</span>
            </div>
            <ul className="list-none">
              {checks.map((c) => <Row key={c.id} c={c} />)}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

export default HealthPanel;
