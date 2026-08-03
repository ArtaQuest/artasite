import { type KeyboardEvent as ReactKeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { previewMarkdown } from "../lib/wp";
import { Button, Card, RichText, Textarea, cx } from "./ui";

/* Markdown + LaTeX toolbar — wraps/inserts syntax in the bound textarea. NOTE (2026-06-04 cutover):
   the lean backend stores bodies as wp_kses_post'd raw text and no longer renders markdown/LaTeX
   (aq_md_to_html was removed), so this syntax currently displays literally — tracked as an open_flag
   (restore rich rendering, or simplify this composer to plain text). Selection is preserved. */
function MdToolbar({ taRef, value, onChange }: { taRef: RefObject<HTMLTextAreaElement | null>; value: string; onChange: (v: string) => void }) {
  const apply = (transform: (sel: string) => { text: string; selStart: number; selEnd: number }) => {
    const ta = taRef.current;
    const start = ta ? ta.selectionStart : value.length;
    const end = ta ? ta.selectionEnd : value.length;
    const { text, selStart, selEnd } = transform(value.slice(start, end));
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => { if (ta) { ta.focus(); ta.selectionStart = start + selStart; ta.selectionEnd = start + selEnd; } });
  };
  const wrap = (b: string, a: string, ph: string) => apply((sel) => { const s = sel || ph; return { text: b + s + a, selStart: b.length, selEnd: b.length + s.length }; });
  const line = (prefix: string, ph: string) => apply((sel) => { const s = sel || ph; return { text: prefix + s, selStart: prefix.length, selEnd: prefix.length + s.length }; });
  const tools: { k: string; label: string; title: string; cls?: string; on: () => void }[] = [
    { k: "b", label: "B", title: "Bold", cls: "font-bold", on: () => wrap("**", "**", "bold") },
    { k: "i", label: "I", title: "Italic", cls: "italic", on: () => wrap("*", "*", "italic") },
    { k: "code", label: "</>", title: "Code", cls: "font-mono text-[11px]", on: () => wrap("`", "`", "code") },
    { k: "math", label: "∑", title: "Math (LaTeX) — e.g. $E=mc^2$", cls: "text-[15px]", on: () => wrap("$", "$", "x^2") },
    { k: "link", label: "Link", title: "Link", on: () => wrap("[", "](https://)", "text") },
    { k: "quote", label: "❝", title: "Quote", on: () => line("> ", "quote") },
    { k: "list", label: "•", title: "List", on: () => line("- ", "item") },
  ];
  return (
    <>
      {tools.map((t) => (
        <button key={t.k} type="button" title={t.title} aria-label={t.title} onMouseDown={(e) => e.preventDefault()} onClick={t.on}
          className={cx("grid h-7 min-w-[28px] place-items-center rounded px-1.5 text-[13px] font-semibold text-ink-3 transition-colors hover:bg-veil/10 hover:text-ink", t.cls)}>{t.label}</button>
      ))}
    </>
  );
}

/* Reusable markdown+LaTeX composer with Write/Preview tabs. `onSubmit` does the actual POST
   (new topic, comment, reply, or edit); on success the field clears and onCancel (if any) fires. */
export function Composer({ initialValue = "", placeholder, submitLabel, minRows = 3, maxLength = 10000, autoFocus, onSubmit, onCancel }: {
  initialValue?: string; placeholder: string; submitLabel: string; minRows?: number; maxLength?: number; autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>; onCancel?: () => void;
}) {
  const [text, setText] = useState(initialValue);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Live preview: render through the server (exact parity with the posted result), debounced.
  // All state updates happen inside the (async) timeout callback, never synchronously in the
  // effect body — so a keystroke doesn't trigger a cascading render just to set a flag.
  useEffect(() => {
    if (mode !== "preview") return;
    const body = text.trim();
    let live = true;
    const id = setTimeout(() => {
      if (!body) { setPreviewHtml(""); setPreviewing(false); return; }
      setPreviewing(true);
      previewMarkdown(body)
        .then((h) => { if (live) setPreviewHtml(h); })
        .catch(() => { if (live) setPreviewHtml(""); })
        .finally(() => { if (live) setPreviewing(false); });
    }, body ? 300 : 0);
    return () => { live = false; clearTimeout(id); };
  }, [mode, text]);

  async function submit() {
    const body = text.trim();
    if (!body || posting) return;
    setPosting(true); setErr("");
    try { await onSubmit(body); setText(""); setMode("write"); onCancel?.(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not post."); }
    finally { setPosting(false); }
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); }
    if (e.key === "Escape" && onCancel) { e.preventDefault(); onCancel(); }
  };
  const near = text.length > maxLength * 0.8;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <div className="mr-1 inline-flex rounded-pill bg-veil/5 p-0.5">
          {(["write", "preview"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={cx("min-h-[24px] rounded-pill px-2.5 text-[12px] font-semibold capitalize transition-colors", mode === m ? "bg-yin text-white" : "text-ink-3 hover:text-ink")}>{m}</button>
          ))}
        </div>
        {mode === "write" && <MdToolbar taRef={taRef} value={text} onChange={setText} />}
        <span className="ml-auto pr-1 text-[11px] text-ink-2">Markdown &amp; LaTeX</span>
      </div>
      {mode === "write" ? (
        <Textarea ref={taRef} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} rows={minRows} maxLength={maxLength} autoFocus={autoFocus}
          placeholder={placeholder} className="w-full resize-y rounded-none border-0 bg-transparent" />
      ) : (
        <div className="min-h-[88px] px-4 py-3">
          {previewing && !previewHtml ? <p className="text-[13px] text-ink-3">Rendering…</p>
            : previewHtml ? <RichText html={previewHtml} className="text-[15px]" />
            : <p className="text-[13px] text-ink-3">Nothing to preview yet.</p>}
        </div>
      )}
      <div className="flex items-center justify-end gap-3 border-t border-line px-3 py-2">
        {err && <span role="alert" className="mr-auto text-[13px] text-rose-300">{err}</span>}
        {near && <span className={cx("text-[12px] tabular-nums", text.length >= maxLength ? "text-rose-300" : "text-ink-3")}>{text.length}/{maxLength}</span>}
        {onCancel && <Button variant="ghost" onClick={onCancel} className="h-8 px-3 text-[13px]">Cancel</Button>}
        <Button onClick={submit} disabled={!text.trim() || posting} className="h-8 px-4 text-[13px] disabled:opacity-40">{posting ? "Saving…" : submitLabel}</Button>
      </div>
    </Card>
  );
}
