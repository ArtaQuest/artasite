/**
 * The Lab's Python runtime — Pyodide in a module Web Worker (lifted from the retired standalone
 * runner, 2026-07-16; the SPA's /lab page is now the one notebook editor).
 *
 * Loads the SELF-HOSTED dist at /wp-content/lite/static/pyodide/ (falls back to jsDelivr in local
 * dev), executes one cell at a time, streams stdout/stderr live, and emits nbformat-shaped outputs
 * (execute_result / display_data / error). Rich values come from _repr_html_ / _repr_latex_ /
 * _repr_png_ / … and open matplotlib figures are captured after every cell as TRANSPARENT WebP
 * themed by the live ArtaContrast tokens (an author's explicit colours always win).
 *
 * An IPython.display shim (HTML/Image/Markdown/Math/SVG/display/clear_output) feeds the same
 * emitter, so notebooks written against IPython render faithfully without the real wheel.
 */

export type NbOutputMsg = {
  output_type: string;
  name?: string;
  text?: string;
  data?: Record<string, string>;
  metadata?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
};

export type KernelHooks = {
  /** Progress line for the status pill (boot phases, package fetches, "Running…"). */
  onStatus: (text: string) => void;
  onReady: (pythonVersion: string) => void;
  onBootError: (error: string) => void;
  /** stdout/stderr line for a cell (append incrementally — never rebuild output DOM). */
  onStream: (cellId: string, name: "stdout" | "stderr", text: string) => void;
  /** A rich output (execute_result / display_data / error) for a cell. */
  onOutput: (cellId: string, output: NbOutputMsg) => void;
  onDone: (cellId: string, ok: boolean) => void;
};

const SELF_BASE = () => `${location.origin}/wp-content/lite/static/pyodide/`;
const CDN_BASE = "https://cdn.jsdelivr.net/pyodide/v314.0.1/full/";

/** The in-SPA runner (pages/Lab.tsx): opens the post's exact .ipynb on-device — no server, no
 *  account. (Supersedes api.ts liteRunUrl → the old standalone page, now a redirect to /lab.) */
export function labRunUrl(id: number, slug = "notebook"): string {
  const raw = `/wp-json/aq/v1/notebooks/${id}/file/${(slug || "notebook").slice(0, 60)}.ipynb`;
  return `/lab?src=${encodeURIComponent(raw)}`;
}

/** The published `.ipynb` at a REAL filename — Colab, JupyterLab and Kaggle all name an import from
 *  the URL, so `/file/<slug>.ipynb` beats the bare `/ipynb` route everywhere a human sees it. */
export function ipynbHref(id: number, slug: string): string {
  // The route's name segment is `[a-z0-9-]{1,80}\.ipynb` (Rest.php). A slug is sanitize_title()'d
  // server-side, which KEEPS underscores and percent-escapes non-Latin titles — so "eda_baseline"
  // or a Persian title built a URL the route cannot match, WordPress answered 404 rest_no_route,
  // and because the anchor carries `download` the browser silently saved that JSON error as the
  // member's .ipynb. Colab then opened beside a file that is not a notebook. Fold to the charset the
  // route accepts; the name is cosmetic (the id in the path is what resolves the work).
  const name = (slug || "notebook").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `/wp-json/aq/v1/notebooks/${id}/file/${name || "notebook"}.ipynb`;
}

/** Kaggle's Copy & Edit destination for a kernel page URL; '' when the work has no kernel. */
export function kaggleRunHref(url: string): string {
  const base = (url || "").replace(/\/+$/, "");
  return base === "" ? "" : `${base}/edit`;
}

/** The matplotlib theme, read from the LIVE ArtaContrast tokens on <html> — the SPA engine
 *  (lib/contrast applyContrast) owns them; the kernel only mirrors. */
export function liveMplTheme(): { ink: string; ink2: string; line: string; dark: boolean } {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => (cs.getPropertyValue(name) || fb).trim() || fb;
  return {
    ink: v("--color-ink", "#f4f4f5"),
    ink2: v("--color-ink-2", "#a6a8b0"),
    line: v("--color-line", "#2a2a31"),
    dark: document.documentElement.getAttribute("data-theme") !== "light",
  };
}

const BOOT_PY = `
import sys, os, io, json, re, base64, builtins, traceback, warnings
os.environ["MPLBACKEND"] = "Agg"
warnings.filterwarnings("ignore", message=".*non-interactive.*cannot be shown.*")
import aq_bridge

_aq_g = {"__name__": "__main__", "__builtins__": builtins}

def _aq_emit(kind, payload):
    aq_bridge.emit(kind, json.dumps(payload))

def _aq_mime(obj):
    data = {}
    for name, mime, enc in (("_repr_html_", "text/html", None),
                            ("_repr_latex_", "text/latex", None),
                            ("_repr_markdown_", "text/markdown", None),
                            ("_repr_svg_", "image/svg+xml", None),
                            ("_repr_png_", "image/png", "b64")):
        try:
            fn = getattr(type(obj), name, None)
            if fn is None:
                continue
            v = fn(obj)
            if v is None:
                continue
            if enc == "b64" and isinstance(v, (bytes, bytearray)):
                v = base64.b64encode(bytes(v)).decode()
            if isinstance(v, str):
                data[mime] = v
        except Exception:
            pass
    try:
        data["text/plain"] = repr(obj)
    except Exception:
        data["text/plain"] = object.__repr__(obj)
    return data

def display(obj):
    _aq_emit("display_data", {"data": _aq_mime(obj)})
_aq_g["display"] = display

def _aq_no_input(prompt=""):
    raise RuntimeError("input() is not available here - assign your parameters in a cell instead")
builtins.input = _aq_no_input

def _aq_install_ipython_shim():
    import types
    def _read(path):
        with open(path, "rb") as fh:
            return fh.read()
    class _Rich:
        def __init__(self, data=None, url=None, filename=None, **kw):
            if data is None and filename:
                data = _read(filename)
            self.data = data
        def __repr__(self):
            return "<%s>" % type(self).__name__
    class HTML(_Rich):
        def _repr_html_(self): return self.data if isinstance(self.data, str) else bytes(self.data or b"").decode("utf-8", "replace")
    class Markdown(_Rich):
        def _repr_markdown_(self): return self.data if isinstance(self.data, str) else bytes(self.data or b"").decode("utf-8", "replace")
    class Latex(_Rich):
        def _repr_latex_(self): return self.data if isinstance(self.data, str) else None
    class Math(_Rich):
        def _repr_latex_(self): return "$$%s$$" % self.data if isinstance(self.data, str) else None
    class SVG(_Rich):
        def _repr_svg_(self): return self.data if isinstance(self.data, str) else bytes(self.data or b"").decode("utf-8", "replace")
    class Image(_Rich):
        def __init__(self, data=None, url=None, filename=None, format=None, **kw):
            if data is None and filename:
                data = _read(filename)
            elif isinstance(data, str) and os.path.exists(data):
                data = _read(data)
            self.data = data
        def _repr_png_(self):
            return bytes(self.data) if isinstance(self.data, (bytes, bytearray)) else None
    class JSON(_Rich):
        def _repr_html_(self):
            import html as _h
            return "<pre>%s</pre>" % _h.escape(json.dumps(self.data, indent=2, default=str))
    def clear_output(wait=False): pass
    def display_shim(*objs, **kw):
        for o in objs:
            display(o)
    disp = types.ModuleType("IPython.display")
    for k, v in dict(display=display_shim, clear_output=clear_output, HTML=HTML, Markdown=Markdown,
                     Latex=Latex, Math=Math, SVG=SVG, Image=Image, JSON=JSON).items():
        setattr(disp, k, v)
    core = types.ModuleType("IPython.core")
    core.display = disp
    mod = types.ModuleType("IPython")
    mod.display = disp
    mod.core = core
    mod.__version__ = "99.0.0"                   # matplotlib sniffs version_info when IPython is present
    mod.version_info = (99, 0, 0)
    mod.get_ipython = lambda: None
    sys.modules["IPython"] = mod
    sys.modules["IPython.display"] = disp
    sys.modules["IPython.core"] = core
    sys.modules["IPython.core.display"] = disp
_aq_install_ipython_shim()

# ArtaContrast-aware matplotlib defaults: transparent figure/axes, inks from the live tokens.
_aq_theme = {"ink": "#f4f4f5", "ink2": "#a6a8b0", "line": "#2a2a31", "dark": True}
_aq_mpl_themed = False

def _aq_apply_mpl():
    global _aq_mpl_themed
    if "matplotlib" not in sys.modules:
        return
    try:
        import matplotlib as mpl
        t = _aq_theme
        mpl.rcParams.update({
            "figure.facecolor": "none", "savefig.facecolor": "none", "axes.facecolor": "none",
            "figure.edgecolor": "none",
            "text.color": t["ink"], "axes.labelcolor": t["ink"], "axes.titlecolor": t["ink"],
            "axes.edgecolor": t["ink2"], "xtick.color": t["ink2"], "ytick.color": t["ink2"],
            "xtick.labelcolor": t["ink2"], "ytick.labelcolor": t["ink2"],
            "grid.color": t["line"], "legend.frameon": False,
        })
        _aq_mpl_themed = True
    except Exception:
        pass

def _aq_set_theme(js):
    global _aq_theme, _aq_mpl_themed
    try:
        _aq_theme = json.loads(js)
    except Exception:
        return
    _aq_mpl_themed = False
    _aq_apply_mpl()

def _aq_figs():
    if "matplotlib" not in sys.modules:
        return
    try:
        import matplotlib.pyplot as plt
        for num in plt.get_fignums():
            fig = plt.figure(num)
            for fmt, mime in (("webp", "image/webp"), ("png", "image/png")):
                try:
                    buf = io.BytesIO()
                    fig.savefig(buf, format=fmt, dpi=110, bbox_inches="tight", facecolor=fig.get_facecolor())
                    _aq_emit("display_data", {"data": {mime: base64.b64encode(buf.getvalue()).decode()}})
                    break
                except Exception:
                    continue
        plt.close("all")
    except Exception:
        pass

# ── IPython magics + shell escapes ────────────────────────────────────────────────────────────
# Pyodide runs REAL Python, so a line like '%matplotlib inline' is a SyntaxError — and that line is
# the FIRST cell of virtually every notebook on this platform, so the run died on cell 1 and the Lab
# looked broken rather than limited. Notebook cells are not Python files; they are IPython, and the
# few constructs that matter have honest translations here.
#
# The pattern is an ALLOW-LIST, never a bare '^ *%': a line can legitimately begin with '%' as the
# continuation of a modulo expression inside brackets, and eating that would corrupt working code.
_AQ_MAGIC = re.compile(
    r"^[ \t]*([%!]{1,2})(matplotlib|config|load_ext|reload_ext|autoreload|pip|conda|env|cd|ls|mkdir|rm|cp|mv|wget|curl|apt|apt-get|jupyter|python|pwd|cat|echo)\b(.*)$"
)

def _aq_prep(code):
    """Returns (python, pip_packages, skipped_lines). Blank lines replace magics so tracebacks keep
    their line numbers - a shifted line number in an error message is its own small betrayal."""
    out, pkgs, skipped = [], [], []
    for line in code.split("\n"):
        m = _AQ_MAGIC.match(line)
        if not m:
            out.append(line)
            continue
        name, rest = m.group(2).lower(), m.group(3)
        if name in ("pip", "conda"):
            parts = rest.split()
            if parts and parts[0] in ("install", "-q"):
                pkgs.extend(p for p in parts[1:] if not p.startswith("-"))
            out.append("")
            continue
        # matplotlib/config/load_ext/autoreload are no-ops here: figures are captured after every
        # cell by _aq_figs(), so 'inline' is already the behaviour.
        if name not in ("matplotlib", "config", "load_ext", "reload_ext", "autoreload"):
            skipped.append(line.strip())
        out.append("")
    return "\n".join(out), pkgs, skipped

async def _aq_run_cell(raw):
    from pyodide.code import eval_code_async
    code, _aq_pkgs, _aq_skipped = _aq_prep(raw)
    for _line in _aq_skipped:
        _aq_emit("stream", {"name": "stderr", "text": "skipped (no shell in the browser): " + _line + "\n"})
    if _aq_pkgs:
        try:
            import micropip
            _aq_emit("stream", {"name": "stdout", "text": "installing " + ", ".join(_aq_pkgs) + "…\n"})
            await micropip.install(_aq_pkgs)
        except BaseException as _e:
            _aq_emit("stream", {"name": "stderr", "text": "could not install " + ", ".join(_aq_pkgs) + ": " + str(_e) + "\n"})
    if not _aq_mpl_themed and ("matplotlib" in sys.modules or "matplotlib" in code):
        try:
            import matplotlib  # the wheel is already loaded by loadPackagesFromImports
        except Exception:
            pass
        _aq_apply_mpl()
    try:
        result = await eval_code_async(code, globals=_aq_g, filename="<cell>")
        _aq_figs()
        if result is not None:
            _aq_emit("execute_result", {"data": _aq_mime(result)})
        return json.dumps({"ok": True})
    except BaseException as e:
        _aq_figs()
        parts = traceback.format_exception(type(e), e, e.__traceback__)
        parts = [p for p in parts if "_pyodide/_base.py" not in p and "pyodide/code.py" not in p
                 and 'File "<exec>"' not in p]
        _aq_emit("error", {"ename": type(e).__name__, "evalue": str(e), "traceback": ["".join(parts).rstrip()]})
        return json.dumps({"ok": False})
`;

const WORKER_JS = String.raw`
"use strict";
var pyodide = null, currentCell = null, pageTheme = null;
var BOOT_PY = __BOOT_PY__;
function post(m) { self.postMessage(m); }
function pushTheme() {
  if (!pyodide || !pageTheme) return;
  var f = pyodide.globals.get("_aq_set_theme");
  try { f(JSON.stringify(pageTheme)); } finally { if (f && f.destroy) f.destroy(); }
}
self.onmessage = function (e) {
  var m = e.data;
  if (m.t === "boot") { pageTheme = m.theme || null; boot(m.base); }
  else if (m.t === "run") run(m.id, m.code);
  else if (m.t === "theme") { pageTheme = m.theme || null; try { pushTheme(); } catch (err) { /* not booted yet */ } }
};
async function boot(base) {
  try {
    post({ t: "status", text: "Fetching the Python runtime…" });
    var mod = await import(base + "pyodide.mjs");   // pyodide 314+ ships ESM only for workers
    pyodide = await mod.loadPyodide({ indexURL: base });
    pyodide.setStdout({ batched: function (s) { post({ t: "stream", id: currentCell, name: "stdout", text: s + "\n" }); } });
    pyodide.setStderr({ batched: function (s) { post({ t: "stream", id: currentCell, name: "stderr", text: s + "\n" }); } });
    pyodide.registerJsModule("aq_bridge", {
      emit: function (kind, payload) { post({ t: "rich", id: currentCell, kind: kind, payload: payload }); }
    });
    post({ t: "status", text: "Preparing the sandbox…" });
    await pyodide.runPythonAsync(BOOT_PY);
    try { pyodide.loadedPackages.ipython = "aq-shim"; } catch (e) { /* skip fetching the real wheel */ }
    try { pushTheme(); } catch (e) { /* theme is cosmetic — never block boot */ }
    var v = pyodide.runPython("import sys; sys.version.split()[0]");
    post({ t: "ready", python: v });
  } catch (err) {
    post({ t: "boot-err", error: String(err && err.message || err).slice(0, 400) });
  }
}
async function run(id, code) {
  currentCell = id;
  try {
    try {
      await pyodide.loadPackagesFromImports(code, {
        messageCallback: function (s) { post({ t: "pkg", text: s }); }
      });
    } catch (e) { /* unknown imports raise a real traceback at run time */ }
    // micropip is NOT in the base runtime, so 'import micropip' fails unless the wheel is fetched
    // first. Only pay for it when the cell actually asks to install something.
    if (/^[ \t]*[%!]{1,2}(pip|conda)\b/m.test(code)) {
      try {
        post({ t: "pkg", text: "Fetching the installer…" });
        await pyodide.loadPackage("micropip");
      } catch (e) { /* reported from Python as "could not install" */ }
    }
    post({ t: "pkg", text: "Running…" });
    var runner = pyodide.globals.get("_aq_run_cell");
    var resJson;
    try { resJson = await runner(code); } finally { if (runner && runner.destroy) runner.destroy(); }
    var res = JSON.parse(resJson);
    post({ t: "done", id: id, ok: !!res.ok });
  } catch (err) {
    post({ t: "rich", id: id, kind: "error", payload: JSON.stringify({ ename: "RuntimeError", evalue: String(err && err.message || err).slice(0, 600), traceback: [] }) });
    post({ t: "done", id: id, ok: false });
  } finally {
    currentCell = null;
  }
}
`;

export class PyKernel {
  private worker: Worker | null = null;
  private hooks: KernelHooks;

  constructor(hooks: KernelHooks) {
    this.hooks = hooks;
  }

  /** Boot (or reboot) the runtime. Terminates any previous worker — variables are cleared. */
  async boot(): Promise<void> {
    this.worker?.terminate();
    let base = CDN_BASE;
    try {
      const r = await fetch(SELF_BASE() + "pyodide.mjs", { method: "HEAD" });
      if (r.ok) base = SELF_BASE();
    } catch {
      /* local dev — the self-hosted dist only exists on prod */
    }
    const src = WORKER_JS.replace("__BOOT_PY__", JSON.stringify(BOOT_PY));
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" });
    this.worker = w;
    w.onerror = () => { if (w === this.worker) this.hooks.onBootError("worker crashed"); };
    w.onmessage = (e) => {
      if (w !== this.worker) return; // a stale worker that was replaced
      const m = e.data as { t: string; id?: string; text?: string; name?: string; kind?: string; payload?: string; ok?: boolean; python?: string; error?: string };
      if (m.t === "status" || m.t === "pkg") this.hooks.onStatus(m.text || "");
      else if (m.t === "ready") this.hooks.onReady(m.python || "");
      else if (m.t === "boot-err") this.hooks.onBootError(m.error || "unknown");
      else if (m.t === "stream" && m.id) this.hooks.onStream(m.id, m.name === "stderr" ? "stderr" : "stdout", m.text || "");
      else if (m.t === "rich" && m.id) {
        try {
          const p = JSON.parse(m.payload || "{}") as NbOutputMsg & { data?: Record<string, string> };
          this.hooks.onOutput(m.id, m.kind === "error"
            ? { output_type: "error", ename: p.ename, evalue: p.evalue, traceback: p.traceback }
            : { output_type: m.kind || "display_data", data: p.data, metadata: {} });
        } catch {
          /* malformed payload — drop */
        }
      } else if (m.t === "done" && m.id) this.hooks.onDone(m.id, !!m.ok);
    };
    w.postMessage({ t: "boot", base, theme: liveMplTheme() });
  }

  run(cellId: string, code: string): void {
    this.worker?.postMessage({ t: "run", id: cellId, code });
  }

  /** Re-theme matplotlib defaults from the live ArtaContrast tokens (call on aq:contrast). */
  syncTheme(): void {
    this.worker?.postMessage({ t: "theme", theme: liveMplTheme() });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
