import { useEffect, useMemo, useRef, useState } from "react";
import { chatFetchMedia } from "../../lib/api";
import {
  EMOJI_GROUPS, recentEmoji, rememberEmoji, searchEmoji, type Emoji,
} from "./emoji";
import { STICKERS, searchStickers, stickerUrl } from "./stickers";

/**
 * The composer's one attachment popover: Emoji · Stickers · GIF.
 *
 * ONE panel with three tabs, rather than three buttons that each open something. The composer used
 * to be a row of five icons (emoji, clip, mic, send, …) whose difference nobody could predict from
 * the glyph; now there is a single "add something" surface, and the only other buttons are the ones
 * whose meaning is unambiguous (attach a file, hold to record, send).
 *
 * ⚠️ Nothing rendered here is decrypted message content, so `data-ay-skip` is NOT needed on the
 * panel itself — emoji names and sticker labels are ours and translating them is correct. The
 * moment any of this starts showing message text, that changes (see the Messages.tsx header).
 */

type Tab = "emoji" | "stickers" | "gif";

export type PickerResult =
  | { kind: "emoji"; char: string }
  | { kind: "sticker"; id: string }
  | { kind: "media"; bytes: ArrayBuffer; mime: string; gif: boolean };

export function Pickers({ onPick, onClose }: { onPick: (r: PickerResult) => void; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("emoji");
  const root = useRef<HTMLDivElement | null>(null);

  // Escape closes the panel and nothing else — it must not bubble to the dock, which would take the
  // half-written message with it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); }
    }
    const el = root.current;
    el?.addEventListener("keydown", onKey);
    return () => el?.removeEventListener("keydown", onKey);
  }, [onClose]);

  const TABS: [Tab, string][] = [["emoji", "Emoji"], ["stickers", "Stickers"], ["gif", "GIF"]];
  return (
    <div ref={root} className="mb-2 overflow-hidden rounded-card border border-line bg-space-1 shadow-card">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5" role="tablist" aria-label="Add to your message">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`rounded-pill px-3 py-1 text-[12.5px] font-semibold transition-colors ${
              tab === k ? "bg-veil/[0.10] text-ink" : "text-ink-3 hover:text-ink"
            }`}>{label}</button>
        ))}
        <button type="button" onClick={onClose} aria-label="Close"
          className="ms-auto grid h-7 w-7 place-items-center rounded-full text-ink-3 hover:bg-veil/[0.07] hover:text-ink">✕</button>
      </div>
      {tab === "emoji" && <EmojiTab onPick={(c) => { rememberEmoji(c); onPick({ kind: "emoji", char: c }); }} />}
      {tab === "stickers" && <StickerTab onPick={(id) => onPick({ kind: "sticker", id })} />}
      {tab === "gif" && <GifTab onPick={(bytes, mime) => onPick({ kind: "media", bytes, mime, gif: mime === "image/gif" })} />}
    </div>
  );
}

// ── Emoji ────────────────────────────────────────────────────────────────────

function EmojiTab({ onPick }: { onPick: (c: string) => void }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState(EMOJI_GROUPS[0].key);
  const recents = useMemo(() => recentEmoji(), []);
  const hits = useMemo(() => searchEmoji(q), [q]);
  const shown: Emoji[] = q.trim()
    ? hits
    : (EMOJI_GROUPS.find((g) => g.key === group) ?? EMOJI_GROUPS[0]).items;

  return (
    <div className="flex flex-col">
      <div className="px-2 pt-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search emoji" aria-label="Search emoji"
          className="w-full rounded-field border border-line bg-space-2 px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-yin-light" />
      </div>
      {!q.trim() && recents.length > 0 && (
        <div className="px-2 pt-2">
          <p className="px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">Recent</p>
          <div className="flex flex-wrap">
            {recents.map((c) => <EmojiBtn key={"r" + c} c={c} onPick={onPick} />)}
          </div>
        </div>
      )}
      <div className="max-h-[210px] overflow-y-auto px-2 py-2">
        {shown.length === 0 ? (
          <p className="px-1 py-6 text-center text-[13px] text-ink-3">No emoji matches that.</p>
        ) : (
          <div className="flex flex-wrap">
            {shown.map((e) => <EmojiBtn key={e.c} c={e.c} onPick={onPick} />)}
          </div>
        )}
      </div>
      {!q.trim() && (
        <div className="flex items-center gap-0.5 overflow-x-auto border-t border-line px-2 py-1.5" role="tablist" aria-label="Emoji categories">
          {EMOJI_GROUPS.map((g) => (
            <button key={g.key} type="button" role="tab" aria-selected={group === g.key} title={g.label} aria-label={g.label}
              onClick={() => setGroup(g.key)}
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[17px] transition-colors ${
                group === g.key ? "bg-veil/[0.12]" : "hover:bg-veil/[0.06]"
              }`}>{g.icon}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function EmojiBtn({ c, onPick }: { c: string; onPick: (c: string) => void }) {
  return (
    <button type="button" onClick={() => onPick(c)} aria-label={c}
      className="grid h-9 w-9 place-items-center rounded text-[21px] leading-none transition-transform hover:scale-125 hover:bg-veil/[0.06]">
      {c}
    </button>
  );
}

// ── Stickers ─────────────────────────────────────────────────────────────────

function StickerTab({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => searchStickers(q), [q]);
  return (
    <div className="flex flex-col">
      <div className="px-2 pt-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search stickers" aria-label="Search stickers"
          className="w-full rounded-field border border-line bg-space-2 px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-yin-light" />
      </div>
      {/* FOUR columns at every width, deliberately. A `sm:`/`md:` breakpoint resolves against the
          WINDOW, not this container — and this panel also mounts inside the 400px chat dock, where
          a desktop viewport would have given it six columns in a phone-width column. */}
      <div className="grid max-h-[230px] grid-cols-4 gap-1 overflow-y-auto p-2">
        {shown.length === 0 ? (
          <p className="col-span-full py-6 text-center text-[13px] text-ink-3">No sticker matches that.</p>
        ) : shown.map((s) => (
          <button key={s.id} type="button" onClick={() => onPick(s.id)} title={s.label}
            className="grid aspect-square place-items-center rounded-card p-1 transition-colors hover:bg-veil/[0.08]">
            <img src={stickerUrl(s.id)} alt={s.label} loading="lazy" className="h-full w-full object-contain" />
          </button>
        ))}
      </div>
      <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-3">
        {STICKERS.length} stickers, drawn for ArtaQuest and served from here — no sticker service is contacted.
      </p>
    </div>
  );
}

// ── GIF ──────────────────────────────────────────────────────────────────────

/**
 * GIFs, without a GIF service.
 *
 * There is no Giphy/Tenor search here and that is a decision, not a gap: a search box on somebody
 * else's API means every keystroke, and every GIF a member browses, is a request to a third party
 * from a member's browser — on a platform whose whole pitch is that it does not do that. So the two
 * honest routes are supported instead: a file from this device, or a link, which the BACKEND
 * fetches (SSRF-fenced, see Chat::fetch_url) so the source host learns nothing about the member and
 * the recipient's browser never touches it at all. Either way the bytes end up sealed in our own
 * blob store, indistinguishable from any other attachment.
 */
function GifTab({ onPick }: { onPick: (bytes: ArrayBuffer, mime: string) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function fromUrl() {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true); setErr(null);
    try {
      const { bytes, mime } = await chatFetchMedia(u);
      onPick(bytes, mime);
      setUrl("");
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Couldn’t fetch that link.");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-2.5 p-3">
      <label className="flex cursor-pointer items-center justify-center gap-2 rounded-field border border-dashed border-line px-3 py-4 text-[13px] font-semibold text-ink-2 transition-colors hover:border-yin-light hover:text-ink">
        Choose a GIF from this device
        <input type="file" accept="image/gif,image/webp,image/png,image/jpeg,video/mp4" className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onPick(await f.arrayBuffer(), f.type || "image/gif");
          }} />
      </label>
      <div className="flex items-center gap-1.5">
        <span className="h-px flex-1 bg-line" aria-hidden />
        <span className="text-[11px] uppercase tracking-[0.12em] text-ink-3">or paste a link</span>
        <span className="h-px flex-1 bg-line" aria-hidden />
      </div>
      <div className="flex gap-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/something.gif"
          aria-label="GIF link" inputMode="url" dir="ltr"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void fromUrl(); } }}
          className="min-w-0 flex-1 rounded-field border border-line bg-space-2 px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-yin-light" />
        <button type="button" onClick={() => void fromUrl()} disabled={busy || !url.trim()}
          className="shrink-0 rounded-pill bg-yang px-3.5 py-1.5 text-[12.5px] font-bold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-40">
          {busy ? "Fetching…" : "Add"}
        </button>
      </div>
      {err && <p className="text-[12px] text-yang">{err}</p>}
      <p className="text-[11px] leading-relaxed text-ink-3">
        We download the link here, then your device seals it before it is stored — so the site you took it from
        never sees who you are, and the person you send it to never loads anything from them.
      </p>
    </div>
  );
}
