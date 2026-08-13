/**
 * The Lab (2026-07-16) — the in-SPA notebook editor + runtime. The standalone
 * /wp-content/lite/run.html runner is retired to a redirect; THIS page is the one editor.
 *
 * ?src=<raw ipynb url> opens that notebook (published or draft — files serve without auth);
 * no src is a blank scratch pad. Python runs on the member's device via lib/pykernel (Pyodide
 * module worker, self-hosted dist); %%js cells run in sandboxed iframes with their console
 * captured. Everything else is the SPA's own machinery: MarkdownLite + KaTeX for text cells,
 * nbview's OutputView for outputs, ArtaContrast via the shell's BackgroundSwitcher (the kernel
 * re-themes matplotlib on every aq:contrast event), the ui kit, and the i18n mesh.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../components/ui";
import { MarkdownLite } from "../components/reader";
import { OutputView, type NbOutput } from "../components/nbview";
import { watchMath } from "../lib/math";
import { hlCell, JS_MAGIC } from "../lib/highlight";
import { PyKernel, type NbOutputMsg } from "../lib/pykernel";
import { WithRail, RailInline } from "../components/PageRail";
import { WorkRail } from "../components/WorkRail";
import { getNotebook, type NotebookFull } from "../lib/api";

type LabCell = {
  id: string;
  type: "code" | "markdown" | "raw";
  source: string;
  outputs: NbOutput[];
  execCount: number | null;
  elapsed: string;
  meta: Record<string, unknown>;
  editing: boolean;
};
type Phase = "boot" | "ready" | "busy" | "dead";

const uid = () => Math.random().toString(36).slice(2, 10);
const nowMs = () => performance.now(); // module-level: pump/onDone run from events, not render
const joinSrc = (s: unknown) => (Array.isArray(s) ? s.join("") : String(s ?? ""));
const CAP = 200000;

function newCell(type: LabCell["type"], source = "", outputs: NbOutput[] = [], execCount: number | null = null, id?: string, meta: Record<string, unknown> = {}): LabCell {
  return { id: id || uid(), type, source, outputs, execCount, elapsed: "", meta, editing: type === "code" || !source };
}

function parseNotebook(text: string, fallbackTitle: string): { cells: LabCell[]; meta: Record<string, unknown>; nbformat: number; minor: number } {
  let nb: { cells?: unknown[]; metadata?: Record<string, unknown>; nbformat?: number; nbformat_minor?: number };
  try { nb = JSON.parse(text) as typeof nb; } catch { nb = {}; }
  if (!nb || typeof nb !== "object") nb = {};
  const seen = new Set<string>();
  const cells = (Array.isArray(nb.cells) ? nb.cells : []).map((raw) => {
    const c = raw as { id?: string; cell_type?: string; source?: unknown; outputs?: NbOutput[]; execution_count?: number; metadata?: Record<string, unknown> };
    let id = typeof c.id === "string" && /^[\w-]{1,64}$/.test(c.id) ? c.id : uid();
    while (seen.has(id)) id = uid();
    seen.add(id);
    return newCell(
      c.cell_type === "code" ? "code" : c.cell_type === "raw" ? "raw" : "markdown",
      joinSrc(c.source),
      Array.isArray(c.outputs) ? c.outputs : [],
      typeof c.execution_count === "number" ? c.execution_count : null,
      id,
      c.metadata && typeof c.metadata === "object" ? c.metadata : {},
    );
  });
  if (!cells.length) {
    cells.push(
      newCell("markdown", `# ${fallbackTitle}\n\nWrite the story in text cells; prove it in code cells.`),
      newCell("code", ""),
    );
  }
  for (const c of cells) if (c.type !== "code" && c.source) c.editing = false;
  return { cells, meta: nb.metadata || {}, nbformat: nb.nbformat || 4, minor: Math.max(5, nb.nbformat_minor || 5) };
}

/** Content signature — substance only (type + source), so "did the member edit anything"
 *  ignores ids, outputs and serialisation accidents. */
function contentSig(nbJson: string): string {
  try {
    const nb = JSON.parse(nbJson) as { cells?: { cell_type?: string; source?: unknown }[] };
    return JSON.stringify((nb.cells || []).map((c) => [c.cell_type, joinSrc(c.source)]));
  } catch { return "?"; }
}

// ── the highlighted code editor: a <pre> sizes the box, a transparent <textarea> sits on top ──
const ED_FONT = "whitespace-pre-wrap break-words p-3 font-mono text-[13px] leading-relaxed";
function CodeArea({ cell, onChange, onKeyDown, onFocus }: {
  cell: LabCell;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus: () => void;
}) {
  const isCode = cell.type === "code";
  return (
    <div className={`relative rounded-field border border-line ${isCode ? "bg-space-1" : "bg-space-2"} focus-within:border-yin-ink/60`}>
      <pre
        aria-hidden
        className={`hl m-0 min-h-[2.6em] w-full text-ink ${ED_FONT}`}
        data-ay-skip="1"
        dangerouslySetInnerHTML={{ __html: (isCode ? hlCell(cell.source) : cell.source.replace(/&/g, "&amp;").replace(/</g, "&lt;")) + "\n" }}
      />
      <textarea
        value={cell.source}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        spellCheck={!isCode}
        data-ay-skip="1"
        aria-label="Cell source"
        placeholder={isCode ? "# python — runs on your device (start with %%js for JavaScript)" : "Write text (markdown)…"}
        className={`absolute inset-0 h-full w-full resize-none overflow-hidden bg-transparent text-transparent caret-yang outline-none placeholder:text-ink-2 ${ED_FONT}`}
      />
    </div>
  );
}

export default function Lab() {
  const [params] = useSearchParams();
  const SRC = params.get("src") || "";
  // The allowlist that DECIDES whether a notebook loads. It still named only artaquest.ORG, which
  // stopped being the site on 2026-07-27 — so an absolute link to a notebook on the live domain was
  // refused as "not an ArtaQuest notebook". Relative /wp-json links masked it. .org stays allowed
  // because it 301s and old links exist; the current origin is allowed whatever it is, so the next
  // domain move cannot reintroduce this.
  const SRC_OK = !SRC
    || /^\/wp-json\//.test(SRC)
    || /^https:\/\/(www\.)?artaquest\.(com|org)\//.test(SRC)
    || SRC.startsWith(`${location.origin}/`);
  const LS_KEY = "aq-nb-edits:" + (SRC || "scratch");
  /** The work this notebook came from, when it came from one — the round trip has to be labelled
   *  at BOTH ends: this runtime is a scratchpad, not the Kaggle run that counts. */
  const NB_ID = SRC.match(/\/notebooks\/(\d+)\/file\//)?.[1] || "";

  const [cells, setCells] = useState<LabCell[]>([]);
  const [phase, setPhase] = useState<Phase>("boot");
  const [pillText, setPillText] = useState("Loading the runtime…");
  const [running, setRunning] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [name, setName] = useState(SRC ? decodeURIComponent((SRC.split("/").pop() || "").split("?")[0] || "") || "notebook.ipynb" : "scratch.ipynb");
  const [note, setNote] = useState<{ text: string; actions?: { label: string; run: () => void }[] } | null>(null);
  const [activeToc, setActiveToc] = useState("");
  const [dropping, setDropping] = useState(false);

  const nbMeta = useRef<{ meta: Record<string, unknown>; nbformat: number; minor: number }>({ meta: {}, nbformat: 4, minor: 5 });
  const kernel = useRef<PyKernel | null>(null);
  const cellsRef = useRef<LabCell[]>([]);
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef<string | null>(null);
  const phaseRef = useRef<Phase>("boot");
  // Mirror render state into refs AFTER commit (render-time ref writes bail the React Compiler);
  // every reader is an event handler or worker callback, which always run post-commit.
  useEffect(() => { cellsRef.current = cells; });
  useEffect(() => { phaseRef.current = phase; });
  const runStart = useRef(0);
  const execCounter = useRef(0);
  const jsRuns = useRef(new Map<number, string>());
  const jsToken = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  const patchCell = ((id: string, fn: (c: LabCell) => LabCell) => {
    setCells((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));
  });

  // ── serialise + autosave ──
  const serialize = (() => {
    const m = nbMeta.current;
    return JSON.stringify({
      nbformat: m.nbformat, nbformat_minor: m.minor, metadata: m.meta,
      cells: cellsRef.current.map((c) => c.type === "code"
        ? { id: c.id, cell_type: "code", metadata: c.meta, execution_count: c.execCount, source: c.source, outputs: c.outputs }
        : { id: c.id, cell_type: c.type, metadata: c.meta, source: c.source }),
    }, null, 1);
  });
  const saveTimer = useRef<number | undefined>(undefined);
  const saveLocal = (() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const wrap = (nb: string) => JSON.stringify({ ts: Date.now(), nb });
      try {
        const full = serialize();
        if (full.length > 3800000) throw new Error("too big"); // ~localStorage quota — keep edits alive
        localStorage.setItem(LS_KEY, wrap(full));
      } catch {
        try {
          const slim = JSON.parse(serialize()) as { cells?: { outputs?: unknown[] }[] };
          for (const c of slim.cells || []) if (c.outputs) c.outputs = [];
          localStorage.setItem(LS_KEY, wrap(JSON.stringify(slim, null, 1)));
        } catch { /* storage blocked entirely */ }
      }
    }, 700);
  });

  // ── the run queue ──
  const pump = (() => {
    if (runningRef.current || phaseRef.current !== "ready" || !queueRef.current.length) return;
    const id = queueRef.current.shift()!;
    setQueue([...queueRef.current]);
    const c = cellsRef.current.find((x) => x.id === id);
    if (!c) { pump(); return; }
    runningRef.current = id;
    setRunning(id);
    runStart.current = nowMs();
    phaseRef.current = "busy";
    setPhase("busy");
    setPillText("Running…" + (queueRef.current.length ? ` — ${queueRef.current.length} queued` : ""));
    kernel.current?.run(id, c.source);
  });

  const runJsCell = ((c: LabCell) => {
    const token = ++jsToken.current;
    jsRuns.current.set(token, c.id);
    const code = c.source.replace(JS_MAGIC, "").replace(/<\/script/gi, "<\\/script");
    const harness =
      `<script>(function(){var q=function(n,t){try{parent.postMessage({__aqjs:${token},kind:"stream",name:n,text:t+"\\n"},"*")}catch(e){}};` +
      '["log","info","debug"].forEach(function(k){console[k]=function(){q("stdout",Array.prototype.map.call(arguments,String).join(" "))}});' +
      '["warn","error"].forEach(function(k){console[k]=function(){q("stderr",Array.prototype.map.call(arguments,String).join(" "))}});' +
      'window.onerror=function(m,s,l){q("stderr",String(m)+(l?" (line "+l+")":""))};' +
      'window.addEventListener("unhandledrejection",function(ev){q("stderr","Unhandled rejection: "+String(ev.reason))});})();</scr' + "ipt>" +
      "<body><script>\n" + code + "\n</scr" + "ipt>";
    patchCell(c.id, (x) => ({ ...x, outputs: [{ output_type: "display_data", data: { "text/html": harness }, metadata: {} }], execCount: null, elapsed: "" }));
    saveLocal();
  });

  const runCell = ((c: LabCell) => {
    if (c.type !== "code") { patchCell(c.id, (x) => ({ ...x, editing: false })); return; }
    if (JS_MAGIC.test(c.source)) { runJsCell(c); return; }
    if (phaseRef.current === "dead") { setNote({ text: "The runtime failed to load — check your connection, then press Restart" }); return; }
    if (queueRef.current.includes(c.id) || runningRef.current === c.id) return;
    patchCell(c.id, (x) => ({ ...x, outputs: [], elapsed: "" }));
    queueRef.current.push(c.id);
    setQueue([...queueRef.current]);
    pump();
  });

  const cancelAll = (() => {
    queueRef.current = [];
    setQueue([]);
    runningRef.current = null;
    setRunning(null);
  });

  const bootKernel = (() => {
    execCounter.current = 0;
    phaseRef.current = "boot";
    setPhase("boot");
    setPillText("Loading the runtime…");
    const k = new PyKernel({
      onStatus: (t) => setPillText(t),
      onReady: (v) => { phaseRef.current = "ready"; setPhase("ready"); setPillText(`Ready — Python ${v}`); pump(); },
      onBootError: (err) => {
        phaseRef.current = "dead"; setPhase("dead"); setPillText("Runtime failed");
        setNote({ text: `The Python runtime could not load (${err}) — press Restart to retry` });
        cancelAll();
      },
      onStream: (id, nm, text) => {
        patchCell(id, (c) => {
          const outs = c.outputs.slice();
          const last = outs[outs.length - 1];
          if (last && last.output_type === "stream" && last.name === nm) {
            if (joinSrc(last.text).length < CAP) outs[outs.length - 1] = { ...last, text: joinSrc(last.text) + text };
          } else outs.push({ output_type: "stream", name: nm, text });
          return { ...c, outputs: outs };
        });
      },
      onOutput: (id, o: NbOutputMsg) => patchCell(id, (c) => ({ ...c, outputs: [...c.outputs, o as NbOutput] })),
      onDone: (id, ok) => {
        execCounter.current += 1;
        const n = execCounter.current;
        patchCell(id, (c) => {
          const outs = c.outputs.slice();
          for (let i = outs.length - 1; i >= 0; i--) if (outs[i].output_type === "execute_result") { outs[i] = { ...outs[i], execution_count: n }; break; }
          return { ...c, execCount: n, elapsed: ((nowMs() - runStart.current) / 1000).toFixed(1) + "s", outputs: outs };
        });
        runningRef.current = null;
        setRunning(null);
        phaseRef.current = "ready";
        setPhase("ready");
        setPillText("Ready");
        if (!ok && queueRef.current.length) { queueRef.current = []; setQueue([]); } // an error stops a pending Run all
        saveLocal();
        pump();
      },
    });
    kernel.current?.terminate();
    kernel.current = k;
    void k.boot();
  });

  const restart = ((interrupted?: boolean) => {
    if (interrupted && runningRef.current) {
      const msg = "Interrupted — the runtime was stopped and restarted; variables were cleared";
      patchCell(runningRef.current, (c) => ({ ...c, outputs: [...c.outputs, { output_type: "error", ename: "KeyboardInterrupt", evalue: msg, traceback: [msg] }] }));
    }
    cancelAll();
    setCells((cs) => cs.map((c) => ({ ...c, execCount: null })));
    bootKernel();
  });

  // ── load ──
  useEffect(() => {
    document.title = `ArtaQuest Lab — ${name}`;
    // The retired standalone runner (/wp-content/lite/run.html) registered its own service worker
    // under that sub-scope; clear out only THAT one. Unregistering every registration on the origin
    // — which is what this did — also killed the site's own root worker (main.tsx registers it at
    // scope "/"), so a single visit to /lab left the next cold launch with no connection facing a
    // blank page instead of the app the member had downloaded.
    navigator.serviceWorker?.getRegistrations()
      .then((rs) => rs.forEach((r) => {
        if (r.scope.startsWith(`${location.origin}/wp-content/lite/`)) void r.unregister();
      }))
      .catch(() => {});
    (async () => {
      let fetched: string | null = null;
      let fetchErr = "";
      if (SRC && SRC_OK) {
        setPillText("Fetching the notebook…");
        try {
          const r = await fetch(SRC, { credentials: "include" });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          fetched = await r.text();
        } catch (e) { fetchErr = e instanceof Error ? e.message : String(e); }
      } else if (SRC && !SRC_OK) fetchErr = "that address is not an ArtaQuest notebook";

      let local: { ts: number; nb: string } | null = null;
      try { local = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { /* ignore */ }

      const adopt = (text: string) => {
        const p = parseNotebook(text, name.replace(/\.ipynb$/, "").replace(/-/g, " "));
        nbMeta.current = { meta: p.meta, nbformat: p.nbformat, minor: p.minor };
        setCells(p.cells);
      };
      if (fetched != null) {
        adopt(fetched);
        if (local?.nb && contentSig(local.nb) !== contentSig(fetched)) {
          const saved = local;
          setNote({
            text: `You have local edits to this notebook from ${new Date(saved.ts).toLocaleString()}`,
            actions: [
              { label: "Restore my edits", run: () => { adopt(saved.nb); setNote(null); } },
              { label: "Discard them", run: () => { try { localStorage.removeItem(LS_KEY); } catch { /* blocked */ } setNote(null); } },
            ],
          });
        }
      } else if (local?.nb) {
        adopt(local.nb);
        if (fetchErr) setNote({ text: `Could not fetch the notebook (${fetchErr}) — showing your last local copy` });
      } else {
        adopt("{}");
        if (fetchErr) setNote({ text: `Could not fetch the notebook (${fetchErr}) — starting a blank scratch pad instead` });
      }
      bootKernel();
    })();
    return () => kernel.current?.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one boot per src
  }, [SRC]);

  // %%js console lines arrive from the sandboxed iframes
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { __aqjs?: number; kind?: string; name?: string; text?: string };
      if (!d || typeof d !== "object" || !d.__aqjs || d.kind !== "stream") return;
      const cellId = jsRuns.current.get(d.__aqjs);
      if (!cellId) return;
      const nm = d.name === "stderr" ? "stderr" : "stdout";
      const text = String(d.text || "").slice(0, 10000);
      patchCell(cellId, (c) => {
        const outs = c.outputs.slice();
        const last = outs[outs.length - 1];
        if (last && last.output_type === "stream" && last.name === nm) {
          if (joinSrc(last.text).length < CAP) outs[outs.length - 1] = { ...last, text: joinSrc(last.text) + text };
        } else outs.push({ output_type: "stream", name: nm, text });
        return { ...c, outputs: outs };
      });
      saveLocal();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [saveLocal]);

  // KaTeX over text cells + latex outputs; re-theme matplotlib on every ArtaContrast change
  useEffect(() => watchMath(box.current, "auto"), [cells]);
  useEffect(() => {
    const sync = () => kernel.current?.syncTheme();
    window.addEventListener("aq:contrast", sync);
    return () => window.removeEventListener("aq:contrast", sync);
  }, []);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => { if (runningRef.current || queueRef.current.length) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);

  // ── cell operations ──
  const structurally = ((fn: (cs: LabCell[]) => LabCell[]) => {
    jsRuns.current.clear(); // React will move iframe nodes → their scripts replay; drop the tokens
    setCells(fn);
    saveLocal();
  });
  const insertAt = ((i: number, type: LabCell["type"]) => {
    structurally((cs) => [...cs.slice(0, i), newCell(type), ...cs.slice(i)]);
  });

  const download = (() => {
    const blob = new Blob([serialize()], { type: "application/x-ipynb+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  const openFile = ((f: File | undefined | null) => {
    if (!f) return;
    f.text().then((t) => {
      try { JSON.parse(t); } catch { setNote({ text: "That file is not a valid notebook" }); return; }
      const p = parseNotebook(t, f.name.replace(/\.ipynb$/i, ""));
      nbMeta.current = { meta: p.meta, nbformat: p.nbformat, minor: p.minor };
      const nm = /\.ipynb$/i.test(f.name) ? f.name : `${f.name || "notebook"}.ipynb`;
      setName(nm);
      document.title = `ArtaQuest Lab — ${nm}`;
      setCells(p.cells);
      saveLocal();
    }).catch(() => setNote({ text: "Could not read that file" }));
  });

  useEffect(() => {
    const over = (e: DragEvent) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); setDropping(true); } };
    const leave = () => setDropping(false);
    const drop = (e: DragEvent) => { setDropping(false); const f = e.dataTransfer?.files?.[0]; if (f) { e.preventDefault(); openFile(f); } };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  }, [openFile]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); download(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [download]);

  // keyboard inside a cell: run combos, Tab indent, edge navigation
  const onCellKey = ((c: LabCell, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const idx = cellsRef.current.findIndex((x) => x.id === c.id);
    if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) {
      e.preventDefault();
      runCell(cellsRef.current[idx]);
      if (e.altKey) { insertAt(idx + 1, "code"); return; }
      if (e.shiftKey) {
        if (idx + 1 >= cellsRef.current.length) insertAt(idx + 1, "code");
        else patchCell(cellsRef.current[idx + 1].id, (x) => ({ ...x, editing: true }));
      }
      return;
    }
    if (e.key === "Escape" && c.type !== "code") { patchCell(c.id, (x) => ({ ...x, editing: false })); ta.blur(); return; }
    if (e.key === "Tab" && c.type === "code") {
      e.preventDefault();
      const s = ta.selectionStart, epos = ta.selectionEnd, v = ta.value;
      if (e.shiftKey) {
        const ls = v.lastIndexOf("\n", s - 1) + 1;
        const rm = v.slice(ls).match(/^ {1,4}/);
        if (rm) ta.setRangeText("", ls, ls + rm[0].length);
      } else if (s === epos) ta.setRangeText("    ", s, s, "end");
      else {
        const ls = v.lastIndexOf("\n", s - 1) + 1;
        ta.setRangeText(v.slice(ls, epos).replace(/^/gm, "    "), ls, epos, "select");
      }
      patchCell(c.id, (x) => ({ ...x, source: ta.value }));
      saveLocal();
    }
  });

  // ── the section tracker ──
  const toc = useMemo(() => {
    const items: { cellId: string; level: number; text: string }[] = [];
    for (const c of cells) {
      if (c.type !== "markdown") continue;
      for (const m of c.source.matchAll(/^(#{1,3})\s+(.+)$/gm)) {
        items.push({ cellId: c.id, level: m[1].length, text: m[2].replace(/[#*_`~]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim() });
      }
    }
    return items;
  }, [cells]);
  useEffect(() => {
    const track = () => {
      let active = toc[0]?.cellId || "";
      for (const t of toc) {
        const el = document.querySelector<HTMLElement>(`[data-cell="${t.cellId}"]`);
        if (el && el.getBoundingClientRect().top <= 130) active = t.cellId;
      }
      setActiveToc(active);
    };
    track();
    let tick: number | undefined;
    const onScroll = () => { window.clearTimeout(tick); tick = window.setTimeout(track, 90); };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); window.clearTimeout(tick); };
  }, [toc]);

  useEffect(() => {
    const w = window as unknown as { aqlab?: { serialize: () => string; open: (t: string) => void } };
    w.aqlab = {
      serialize,
      open: (t: string) => {
        const p = parseNotebook(t, "notebook");
        nbMeta.current = { meta: p.meta, nbformat: p.nbformat, minor: p.minor };
        setCells(p.cells);
      },
    };
    return () => { delete w.aqlab; };
  });

  const pillDot = phase === "ready" ? "bg-yang" : phase === "dead" ? "bg-red-400" : "bg-yin-ink animate-pulse";
  const kindOf = (c: LabCell) => (c.type === "code" ? (JS_MAGIC.test(c.source) ? "js" : "code") : c.type);

  return (
    /* No <main> and no max-width: AppShell already wraps every page in
       <main><div className="mx-auto max-w-content px-gutter py-7">. This opened a second landmark
       inside the first and a second gutter, and max-w-7xl (1280px) was in any case clipped by the
       shell's 1120px — so the editor's column never matched the work page's. */
    <div className="w-full" ref={box}>
      {dropping ? (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center border-2 border-dashed border-yang bg-space-1/80 text-ink">Drop the .ipynb to open it</div>
      ) : null}

      {/* toolbar */}
      <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 border-b border-line bg-space-1/90 py-2 backdrop-blur">
        <span className="max-w-[30ch] overflow-hidden text-ellipsis whitespace-nowrap rounded-pill border border-line px-2.5 py-0.5 text-xs text-ink-2" id="fname">{name}</span>
        {NB_ID ? (
          <>
            <a className="text-xs text-yin-ink hover:underline" href={`/nb/${NB_ID}/`}>View the post ↗</a>
            <a className="text-xs text-yin-ink hover:underline" href={`/studio/nb/${NB_ID}/edit`}>Open in the Studio ↗</a>
          </>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => { for (const c of cellsRef.current) { if (c.type === "code") { if (c.source.trim()) runCell(c); } else if (c.editing) patchCell(c.id, (x) => ({ ...x, editing: false })); } }} disabled={phase !== "ready" && phase !== "busy"} id="runall">Run all</Button>
          <Button size="sm" variant="outline" onClick={() => { if (runningRef.current) restart(true); else cancelAll(); }} disabled={!running && !queue.length} id="stop">Stop</Button>
          <Button size="sm" variant="outline" onClick={() => restart(false)} disabled={phase === "boot"} id="restart" tip="Restart the Python runtime — variables are cleared">Restart</Button>
          <Button size="sm" variant="outline" onClick={download} id="dl" tip="Download as .ipynb (⌘S)">Download</Button>
          <label className="inline-flex cursor-pointer items-center rounded-pill border border-line px-3 py-1 text-sm text-ink-2 transition-colors hover:border-yin-ink">
            Open
            <input id="openf" type="file" accept=".ipynb,application/x-ipynb+json,application/json" className="hidden"
              onChange={(e) => { openFile(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
          </label>
          <span className="inline-flex max-w-[44ch] items-center gap-2 overflow-hidden whitespace-nowrap rounded-pill border border-line px-2.5 py-1 text-xs text-ink-3" id="pill" data-state={phase}>
            <span className={`h-2 w-2 flex-none rounded-full ${pillDot}`} />
            <span className="overflow-hidden text-ellipsis" id="pilltext">{pillText}</span>
          </span>
        </span>
      </div>

      {note ? (
        <div className="banner mb-3 flex flex-wrap items-center gap-2 rounded-card border border-line border-l-2 border-l-yang bg-space-2 px-3 py-2 text-sm text-ink-2" role="status">
          <span>{note.text}</span>
          {(note.actions || []).map((a) => (
            <Button key={a.label} size="sm" variant="outline" onClick={a.run}>{a.label}</Button>
          ))}
          <button type="button" className="ml-auto text-xs text-ink-3 hover:text-ink" onClick={() => setNote(null)}>Dismiss</button>
        </div>
      ) : null}

      {/* THE ROUND TRIP, labelled. This runtime is Pyodide on the member's own device — it is a
          scratchpad, not a submission: nothing here is published and nothing here is checked. Work
          is authored and run on Kaggle now, so an author must never mistake this tab for the run
          that counts, nor wonder how to get their edits out of it. */}
      {NB_ID ? (
        <p className="mb-3 rounded-card border border-line bg-space-2 px-3 py-2 text-xs leading-relaxed text-ink-3">
          A scratchpad, running on your own device. Only a handful of packages are available here, so
          a cell importing anything heavier will fail — the run that counts is the one on Kaggle.
          Nothing you do here touches a published work, and nothing here is checked or published.
          Press <span className="font-semibold text-ink-2">Download</span> to take the notebook with you.
        </p>
      ) : null}

      <WithRail
        label="This notebook"
        rail={
          <>
            {/* Sections used to be a LEFT column of its own. Inside AppShell's 1120px that made
                three tracks and left the code column ~500px wide; on the right it costs nothing the
                rail was not already spending, and the editor gains the width back. */}
            {toc.length ? (
              <nav aria-label="Sections" className="max-h-[40vh] overflow-y-auto rounded-card border border-line bg-space-2 p-3" id="toc">
                <h2 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ink-3">Sections</h2>
                <div id="toclist">
              {toc.map((t, i) => (
                <a
                  key={i}
                  href="#"
                  className={`block overflow-hidden text-ellipsis whitespace-nowrap border-l-2 py-0.5 text-xs no-underline ${t.level === 2 ? "pl-5" : t.level === 3 ? "pl-8" : "pl-2"} ${activeToc === t.cellId ? "active border-yang text-yang-ink" : "border-line text-ink-3 hover:border-yin-ink hover:text-ink"}`}
                  onClick={(e) => { e.preventDefault(); document.querySelector(`[data-cell="${t.cellId}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                >{t.text}</a>
                  ))}
                </div>
              </nav>
            ) : null}
            <LabRail src={SRC} />
          </>
        }
      >
        {/* cells */}
        <div className="min-w-0 pb-[35vh]">
          <Adder onAdd={(type) => insertAt(0, type)} />
          {cells.map((c, i) => (
            <div key={c.id}>
              <section className={`cell group flex gap-2 rounded-card p-1 ${running === c.id ? "running" : ""} ${queue.includes(c.id) ? "queued" : ""}`} data-cell={c.id} data-type={c.type}>
                <div className="flex w-12 flex-none flex-col items-end gap-1 pt-2 sm:w-14">
                  <button
                    type="button"
                    onClick={() => runCell(c)}
                    aria-label="Run cell"
                    title="Run this cell (Shift+Enter)"
                    className={`play grid h-6 w-6 place-items-center rounded-full border text-[10px] ${running === c.id ? "animate-pulse border-yang text-yang-ink" : queue.includes(c.id) ? "border-yang text-yang-ink" : "border-line text-ink-3 hover:border-yin-ink hover:text-ink"}`}
                  >▶</button>
                  {c.type === "code" ? (
                    <span className="xc font-mono text-[11px] text-ink-3">
                      [{running === c.id ? "*" : queue.includes(c.id) ? "·" : c.execCount ?? " "}]{c.elapsed && running !== c.id ? <span className="t opacity-80"> {c.elapsed}</span> : null}
                    </span>
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="tools flex h-5 items-center gap-1 text-[11px] text-ink-3 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <button type="button" className="type rounded-pill border border-line px-2 text-[9.5px] uppercase tracking-wider hover:border-yin-ink" title="Switch between code and text"
                      onClick={() => { jsRuns.current.clear(); patchCell(c.id, (x) => ({ ...x, type: x.type === "code" ? "markdown" : "code", outputs: [], execCount: null, elapsed: "", editing: true })); saveLocal(); }}>{kindOf(c)}</button>
                    <button type="button" className="up rounded border border-line px-1.5 hover:border-yin-ink" aria-label="Move cell up" onClick={() => { if (i > 0) structurally((cs) => { const cp = [...cs]; [cp[i - 1], cp[i]] = [cp[i], cp[i - 1]]; return cp; }); }}>↑</button>
                    <button type="button" className="dn rounded border border-line px-1.5 hover:border-yin-ink" aria-label="Move cell down" onClick={() => { if (i < cells.length - 1) structurally((cs) => { const cp = [...cs]; [cp[i], cp[i + 1]] = [cp[i + 1], cp[i]]; return cp; }); }}>↓</button>
                    <button type="button" className="cpy rounded border border-line px-1.5 hover:border-yin-ink" title="Copy the cell source" onClick={(e) => { const b = e.currentTarget; navigator.clipboard?.writeText(c.source).then(() => { b.textContent = "copied"; setTimeout(() => { b.textContent = "copy"; }, 900); }).catch(() => {}); }}>copy</button>
                    <button type="button" className="dup rounded border border-line px-1.5 hover:border-yin-ink" aria-label="Duplicate cell" onClick={() => structurally((cs) => [...cs.slice(0, i + 1), newCell(c.type, c.source), ...cs.slice(i + 1)])}>⧉</button>
                    <button type="button" className="clr rounded border border-line px-1.5 hover:border-yin-ink" onClick={() => { patchCell(c.id, (x) => ({ ...x, outputs: [], elapsed: "" })); saveLocal(); }}>clear</button>
                    <button type="button" className="del ml-auto rounded border border-line px-1.5 hover:border-yin-ink" aria-label="Delete cell" onClick={() => structurally((cs) => (cs.length > 1 ? cs.filter((x) => x.id !== c.id) : cs.map((x) => (x.id === c.id ? { ...x, source: "", outputs: [], elapsed: "" } : x))))}>✕</button>
                  </div>
                  {c.type !== "code" && !c.editing ? (
                    <div className="mdv max-w-none cursor-text text-[0.95rem] leading-relaxed text-ink [&_h1]:mt-1 [&_h1]:text-2xl [&_h2]:mt-1 [&_h2]:text-xl [&_h3]:text-lg" onDoubleClick={() => patchCell(c.id, (x) => ({ ...x, editing: true }))}>
                      {c.type === "raw" ? <pre className="whitespace-pre-wrap text-xs text-ink-2">{c.source}</pre> : c.source ? <MarkdownLite text={c.source} /> : <span className="text-xs text-ink-3">Empty text cell — double-click to write</span>}
                    </div>
                  ) : (
                    <CodeArea
                      cell={c}
                      onChange={(v) => { patchCell(c.id, (x) => ({ ...x, source: v })); saveLocal(); }}
                      onKeyDown={(e) => onCellKey(c, e)}
                      onFocus={() => { /* rendered → editing handled by dblclick */ }}
                    />
                  )}
                  <div className="outs flex flex-col gap-1.5 empty:hidden">
                    {c.outputs.map((o, j) => <OutputView key={j} o={o} live />)}
                  </div>
                </div>
              </section>
              <Adder onAdd={(type) => insertAt(i + 1, type)} always={i === cells.length - 1} />
            </div>
          ))}
        </div>
      </WithRail>

      {/* Below lg the rail leaves the flow, so the run/cite cards ride here instead. */}
      <RailInline><LabRail src={SRC} /></RailInline>

      <p className="border-t border-line pt-2 text-center text-[11px] text-ink-3">
        ⇧↵ run cell · ⌥↵ run + insert below · ⌘↵ run in place · ⇥ indent · everything runs on your device — nothing is uploaded
      </p>
    </div>
  );
}

function Adder({ onAdd, always }: { onAdd: (type: LabCell["type"]) => void; always?: boolean }) {
  return (
    <div className={`adder flex items-center justify-center gap-1.5 transition-opacity ${always ? "always h-8 opacity-100" : "h-3 opacity-0 hover:h-7 hover:opacity-100"}`}>
      <span className="flex-1 border-t border-dashed border-line" />
      <button type="button" className="rounded-pill border border-line bg-space-1 px-2 text-[11px] text-ink-3 hover:border-yin-ink hover:text-ink" onClick={() => onAdd("code")}>＋ Code</button>
      <button type="button" className="rounded-pill border border-line bg-space-1 px-2 text-[11px] text-ink-3 hover:border-yin-ink hover:text-ink" onClick={() => onAdd("markdown")}>＋ Text</button>
      <span className="flex-1 border-t border-dashed border-line" />
    </div>
  );
}

/**
 * The Lab's run/cite cards — the SAME <WorkRail> the work page shows.
 *
 * Operator, 2026-07-31: the side cards must be there in the code editor too. The Lab is reached as
 * /lab?src=/wp-json/aq/v1/notebooks/<id>/file/<slug>.ipynb, so the work is recoverable from the src
 * param; a blank scratch pad has no id and simply renders nothing rather than an empty shell.
 * Failure is silent on purpose — a card that cannot load must never take the editor down with it.
 */
function LabRail({ src }: { src: string }) {
  const [nb, setNb] = useState<NotebookFull | null>(null);
  const id = Number(/\/notebooks\/(\d+)\//.exec(src)?.[1] || 0);
  useEffect(() => {
    if (!id) { setNb(null); return; }
    let alive = true;
    getNotebook(id).then((r) => { if (alive) setNb(r); }).catch(() => { if (alive) setNb(null); });
    return () => { alive = false; };
  }, [id]);
  if (!nb) return null;
  return <WorkRail nb={nb} />;
}
