import { useCallback, useEffect, useRef, useState } from "react";
import { artaDm, artaDmClear, artaDmSend, type ArtaDm, type ArtaDmItem } from "../lib/api";
import { ArtaAvatar } from "./arta";

/**
 * A member's PRIVATE 1:1 chat with Arta, inside the ArtaChat dock.
 *
 * Same brain, queue and per-member limits as tagging @arta in public — only where the answer lands
 * differs (here, visible to this member alone). It is NOT end-to-end encrypted, unlike member DMs:
 * Arta has to read a message to answer it. The panel says so, in plain words, above the composer.
 * Polls only while a question is waiting, and gently (5 s → 20 s), and stops when it is answered.
 */
export function ArtaPrivateChat() {
  const [items, setItems] = useState<ArtaDmItem[] | null>(null);
  const [state, setState] = useState<Omit<ArtaDm, "items"> | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await artaDm();
      setItems(d.items);
      setState({ pending: d.pending, online: d.online, enabled: d.enabled, paused_until: d.paused_until });
      setErr("");
      return d;
    } catch {
      setErr("Couldn’t load your chat with Arta — check your connection.");
      setItems((v) => v ?? []);
      return null;
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Poll while a question is waiting; back off; stop once it is answered.
  const waiting = !!state?.pending && state.pending.status !== "limited";
  useEffect(() => {
    if (!waiting) return;
    let delay = 5000, stop = false, t = 0;
    const tick = async () => {
      const d = await load();
      if (stop || !d || !d.pending || d.pending.status === "limited") return;
      delay = Math.min(20000, delay * 1.4);
      t = window.setTimeout(tick, delay);
    };
    t = window.setTimeout(tick, delay);
    return () => { stop = true; window.clearTimeout(t); };
  }, [waiting, load]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, waiting]);

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await artaDmSend(body);
      setText("");
      setItems((v) => [...(v ?? []), r.item]);
      await load();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Couldn’t send — try again.");
    } finally { setBusy(false); }
  }

  async function clear() {
    if (!window.confirm("Delete your whole private chat with Arta? This cannot be undone.")) return;
    try { await artaDmClear(); await load(); } catch { setErr("Couldn’t clear the chat."); }
  }

  const p = state?.pending;
  const status = !p ? null
    : p.status === "limited" ? "You’ve reached Arta’s limit for now — your message is saved; try again a little later."
    : !state?.online ? "Arta is offline — it will answer when it’s back."
    : p.status === "queued" && p.position > 1 ? `Arta will reply soon · #${p.position} in line`
    : "Arta is replying…";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ay-skip="1">
      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3" aria-live="polite">
        {items === null ? (
          <p className="py-6 text-center text-[13px] text-ink-3">Opening…</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
            <ArtaAvatar className="h-12 w-12" />
            <p className="text-[13.5px] font-semibold text-ink">Ask Arta anything, privately</p>
            <p className="text-[12px] leading-relaxed text-ink-3">Only you see this chat. To ask in public, tag @arta in a post.</p>
          </div>
        ) : items.map((m) => (
          <div key={m.id} className={`flex items-end gap-2 ${m.from_arta ? "" : "flex-row-reverse"}`}>
            {m.from_arta && <ArtaAvatar className="h-7 w-7 shrink-0" />}
            <p dir="auto" className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13.5px] leading-relaxed ${m.from_arta ? "bg-veil/[0.06] text-ink" : "bg-yin text-white"}`}>{m.body}</p>
          </div>
        ))}
        {status && (
          <div role="status" className="flex items-center gap-2 text-[12px] text-ink-3">
            <ArtaAvatar className="h-6 w-6 shrink-0" />
            <span>{status}</span>
            {p && p.status !== "limited" && state?.online && <span aria-hidden className="aq-think-dots aq-think-dots--tiny aq-think-dots--quiet"><i /><i /><i /></span>}
          </div>
        )}
      </div>
      {err && <p className="px-3 pb-1 text-[12px] text-ink-3">{err}</p>}
      <p className="px-3 pb-1 text-[11px] leading-snug text-ink-3">
        Private between you and Arta, but not end-to-end encrypted — Arta reads it to answer.
        {items && items.length > 0 && <> <button type="button" onClick={() => void clear()} className="underline hover:text-ink">Clear chat</button></>}
      </p>
      <form className="flex shrink-0 items-end gap-2 border-t border-line px-3 py-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} maxLength={2000}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
          placeholder="Message Arta" aria-label="Message Arta"
          className="max-h-32 min-h-9 min-w-0 flex-1 resize-none rounded-2xl bg-veil/[0.05] px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3" />
        <button type="submit" disabled={busy || !text.trim()}
          className="h-9 shrink-0 rounded-pill bg-yang px-4 text-[13px] font-bold text-on-accent transition-opacity disabled:opacity-40">Send</button>
      </form>
    </div>
  );
}
