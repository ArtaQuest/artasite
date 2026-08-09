import { useEffect, useRef, useState } from "react";
import { ShellAccount } from "../lib/api";

/**
 * A REAL terminal, in the browser, on the member's own machine.
 *
 * The machine it opens does not exist until this component asks for it and stops existing shortly
 * after the member leaves, which is the whole reason ArtaQuest can offer everyone a Linux account
 * without paying for a server that mostly sits idle. Everything here is therefore written around one
 * fact: the first few seconds are a machine starting up, and the member has to be told that rather
 * than shown a black rectangle.
 *
 * xterm.js is loaded ONLY when someone actually opens a terminal — a dynamic import, so its weight
 * never lands on anybody else's first paint.
 */
export default function Terminal({ onClose }: { onClose?: () => void }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"opening" | "live" | "ended">("opening");
  const [err, setErr] = useState("");
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let term: { write: (s: string | Uint8Array) => void; dispose: () => void } | null = null;
    let dead = false;
    const started = Date.now();
    const tick = setInterval(() => setSecs(Math.round((Date.now() - started) / 1000)), 1000);

    (async () => {
      try {
        const [{ Terminal: Xterm }, { FitAddon }, ticket] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          ShellAccount.open(),
          import("@xterm/xterm/css/xterm.css"),
        ]);
        if (dead || !host.current) return;

        const t = new Xterm({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
          // The brand's two colours, and nothing else invented: gold for what the machine says, the
          // page's own space tone behind it.
          theme: { background: "#06121E", foreground: "#E6EDF5", cursor: "#E8B923", selectionBackground: "#1746DC" },
          scrollback: 5000,
        });
        const fit = new FitAddon();
        t.loadAddon(fit);
        t.open(host.current);
        fit.fit();
        term = t as unknown as typeof term;

        ws = new WebSocket(ticket.url);
        ws.binaryType = "arraybuffer";
        const size = () => {
          fit.fit();
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "size", cols: t.cols, rows: t.rows }));
        };
        ws.onopen = () => { setState("live"); size(); };
        ws.onmessage = (e) => t.write(new Uint8Array(e.data as ArrayBuffer));
        ws.onerror = () => setErr("The connection to your machine failed.");
        ws.onclose = () => { setState("ended"); t.write("\r\n\x1b[38;5;179m— session ended —\x1b[0m\r\n"); };
        // Keystrokes go as BINARY and control as TEXT, which is what the other end expects: it must be
        // able to tell "the member pressed a key" from "the window changed size" without inspecting
        // bytes a member could type on purpose.
        t.onData((d) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d)); });
        window.addEventListener("resize", size);
        const ro = new ResizeObserver(size);
        if (host.current) ro.observe(host.current);
        return () => { window.removeEventListener("resize", size); ro.disconnect(); };
      } catch (e) {
        if (!dead) setErr(e instanceof Error && e.message ? e.message : "Your machine could not be started.");
      }
    })();

    return () => {
      dead = true;
      clearInterval(tick);
      try { if (ws) ws.close(); } catch { /* already gone */ }
      try { if (term) term.dispose(); } catch { /* */ }
    };
  }, []);

  return (
    <div className="mt-4 overflow-hidden rounded-card border border-line">
      <div className="flex items-center justify-between gap-3 bg-space-2 px-3 py-2">
        <span className="text-[12.5px] text-ink-2">
          {state === "opening" ? "Starting your machine…" : state === "live" ? "Your machine" : "Session ended"}
        </span>
        <span data-ay-skip="1" className="flex items-center gap-3 text-[12px] text-ink-3">
          <span className="tabular-nums">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</span>
          <button onClick={onClose} className="rounded px-2 py-0.5 text-ink-2 hover:text-ink">Close</button>
        </span>
      </div>
      {err && <p className="px-3 py-3 text-[13px] text-ink-3">{err}</p>}
      <div ref={host} className="h-[420px] w-full bg-[#06121E] px-2 py-2" />
    </div>
  );
}
