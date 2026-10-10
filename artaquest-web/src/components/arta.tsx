/**
 * @arta in the feed — everything that makes the public assistant read as itself.
 *
 * Arta is reached ONLY in public: a member tags @arta in a post, a reply or a comment and the answer
 * lands in that thread. So this file is the assistant's whole visual vocabulary on the timeline:
 *
 *   • ArtaAvatar / ArtaBadge — the thinking mascot (the companion's own figure, gold, with a blue
 *     thought) and a verified-style seal, so an automated account can never pass for a person.
 *   • MentionText — @handles linked, @arta drawn as a chip.
 *   • ArtaMarkdown — the small, SAFE markdown Arta writes in (paragraphs, lists, bold/italic, code,
 *     links). It never emits HTML: every piece is a React text node or an element we construct, and a
 *     link is only rendered for http(s) or a site-relative path.
 *   • ArtaFiles — what Arta attaches to a reply (generated images as a grid, other files as chips; a
 *     long answer's .md/.txt can be read in place).
 *   • useArtaWatch + ArtaStatusPill — "Arta is thinking…", "Queued #3", "Offline — will answer when
 *     back", from GET arta/watch/{id}, polled lightly with backoff and stopped once nothing is open.
 *   • MentionTextarea — a textarea with @-autocomplete (Arta first) and ⌘/Ctrl+Enter to send.
 *
 * i18n: sentences stay whole text nodes (the translation mesh translates text nodes one by one).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { searchMembers, ARTA_HANDLE, type LibraryItem, type MemberCard } from "../lib/api";
import { ARTA_AVATAR, MENTION_RE, looksLikeBug, mentionsArta, type ArtaPillState } from "../lib/arta";
import { Avatar, cx } from "./ui";

export function ArtaAvatar({ className, alt = "" }: { className?: string; alt?: string }) {
  return <img src={ARTA_AVATAR} alt={alt} width={40} height={40} decoding="async" draggable={false}
    className={cx("shrink-0 select-none rounded-full", className)} />;
}

/** Verified-style seal for Arta: the platform's gold with a dark tick, plus (from sm) a quiet
 *  "Assistant" chip — an automated account is always labelled as one. */
export function ArtaBadge({ size = 16, chip = true }: { size?: number; chip?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1" title="Arta — ArtaQuest's automated public assistant">
      <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label="Automated assistant" className="shrink-0">
        <path style={{ fill: "var(--color-yang)" }}
          d="M12 1.5l2.4 1.9 3 .2.9 2.9 2.3 1.9-1 2.9 1 2.9-2.3 1.9-.9 2.9-3 .2L12 22.5l-2.4-1.9-3-.2-.9-2.9L3.4 15.6l1-2.9-1-2.9 2.3-1.9.9-2.9 3-.2L12 1.5z" />
        <path d="M8.2 12.2l2.5 2.5 5.1-5.4" fill="none" stroke="#0d0d0f" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {chip ? (
        <span aria-hidden className="hidden rounded-pill border border-yang/35 bg-yang/[0.10] px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-yang-ink min-[400px]:inline">
          Assistant
        </span>
      ) : null}
    </span>
  );
}

// ── @mentions ────────────────────────────────────────────────────────────────
function Mention({ handle }: { handle: string }) {
  const arta = /^(arta|artabot)$/i.test(handle);
  const to = `/u/${arta ? ARTA_HANDLE : handle}`;
  if (arta) {
    return (
      <Link to={to} onClick={(e) => e.stopPropagation()} data-ay-skip="1" title="@arta"
        className="mx-px inline-flex items-baseline rounded-pill bg-yang/[0.14] px-1.5 font-semibold text-yang-ink no-underline ring-1 ring-inset ring-yang/25 transition-colors hover:bg-yang/25">
        Arta
      </Link>
    );
  }
  return <Link to={to} onClick={(e) => e.stopPropagation()} data-ay-skip="1" className="font-medium text-yin-ink hover:underline">@{handle}</Link>;
}

/** Plain text with every @handle linked; @arta as a chip that reads "Arta" (the text keeps "@arta"). */
export function MentionText({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const at = (m.index ?? 0) + m[1].length;
    if (m[2].length < 3) continue;
    if (at > last) out.push(text.slice(last, at));
    out.push(<Mention key={at} handle={m[2]} />);
    last = at + 1 + m[2].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

// ── safe markdown (Arta's replies) ───────────────────────────────────────────
function safeHref(u: string): string | null {
  const t = u.trim();
  if (/^https?:\/\/[^\s<>"']+$/i.test(t)) return t;
  if (/^\/(?!\/)[^\s<>"']*$/.test(t)) return t;
  return null;
}
// One pass over a line: `code` · **bold** · *italic* / _italic_ · [text](url) · bare URL · @mention.
const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]{1,200}\]\([^)\s]{1,500}\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|((?:^|(?<=[\s(]))[*_][^*_\n]+[*_](?=$|[\s).,;:!?]))/g;
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0, k = 0;
  const pushText = (s: string) => { if (s) out.push(<MentionText key={`${keyBase}t${k++}`} text={s} />); };
  for (const m of text.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    pushText(text.slice(last, i));
    const tok = m[0];
    const key = `${keyBase}i${k++}`;
    if (m[1]) out.push(<code key={key} className="rounded-md bg-veil/[0.08] px-1 py-px font-mono text-[0.9em] text-ink">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key} className="font-semibold text-ink">{tok.slice(2, -2)}</strong>);
    else if (m[3]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      const href = mm ? safeHref(mm[2]) : null;
      if (mm && href) out.push(<a key={key} href={href} target={href.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer nofollow ugc" onClick={(e) => e.stopPropagation()} className="rounded-sm font-medium text-yin-ink underline decoration-yin-ink/40 underline-offset-2 outline-none hover:decoration-yin-ink focus-visible:ring-2 focus-visible:ring-yin-ink">{mm[1]}</a>);
      else out.push(tok);
    } else if (m[4]) {
      const href = safeHref(tok);
      if (href) out.push(<a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow ugc" onClick={(e) => e.stopPropagation()} className="break-all font-medium text-yin-ink underline decoration-yin-ink/40 underline-offset-2 hover:decoration-yin-ink">{tok.replace(/^https?:\/\/(www\.)?/, "")}</a>);
      else out.push(tok);
    } else if (m[5]) out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = i + tok.length;
  }
  pushText(text.slice(last));
  return out;
}

/** Arta's markdown, rendered as React elements only — never as HTML. */
export function ArtaMarkdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => {
    const lines = (text || "").replace(/\r\n?/g, "\n").split("\n");
    type B = { t: "p" | "h" | "q"; lines: string[] } | { t: "ul" | "ol"; items: string[] } | { t: "code"; lang: string; body: string[] };
    const out: B[] = [];
    let cur: B | null = null;
    const flush = () => { if (cur) out.push(cur); cur = null; };
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(ln);
      if (fence) {
        flush();
        const body: string[] = [];
        for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
        out.push({ t: "code", lang: fence[1], body });
        continue;
      }
      if (!ln.trim()) { flush(); continue; }
      const ul = /^\s*[-*•]\s+(.*)$/.exec(ln);
      const ol = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(ln);
      const h = /^\s*#{1,6}\s+(.*)$/.exec(ln);
      const q = /^\s*>\s?(.*)$/.exec(ln);
      if (ul || ol) {
        const t = ul ? "ul" : "ol";
        if (!cur || cur.t !== t) { flush(); cur = { t, items: [] }; }
        (cur as { items: string[] }).items.push((ul || ol)![1]);
      } else if (h) { flush(); out.push({ t: "h", lines: [h[1]] }); }
      else if (q) {
        if (!cur || cur.t !== "q") { flush(); cur = { t: "q", lines: [] }; }
        (cur as { lines: string[] }).lines.push(q[1]);
      } else {
        if (!cur || cur.t !== "p") { flush(); cur = { t: "p", lines: [] }; }
        (cur as { lines: string[] }).lines.push(ln);
      }
    }
    flush();
    return out;
  }, [text]);
  const lines = (ls: string[], kb: string) => ls.flatMap((l, j) => (j ? [<br key={`${kb}br${j}`} />, ...inline(l, `${kb}l${j}`)] : inline(l, `${kb}l${j}`)));
  return (
    <div className={cx("aq-arta-md flex flex-col gap-1.5 text-[15px] leading-relaxed text-ink [overflow-wrap:anywhere]", className)}>
      {blocks.map((b, i) => {
        const kb = `b${i}`;
        if (b.t === "code") return (
          <pre key={kb} className="overflow-x-auto rounded-xl border border-line bg-space-1 px-3 py-2 text-[12.5px] leading-snug"><code className="font-mono text-ink-2">{b.body.join("\n")}</code></pre>
        );
        if (b.t === "ul" || b.t === "ol") {
          const L = b.t;
          return (
            <L key={kb} className={cx("flex flex-col gap-0.5 ps-5", L === "ul" ? "list-disc marker:text-yang-ink" : "list-decimal marker:font-semibold marker:text-ink-3")}>
              {b.items.map((it, j) => <li key={j} className="ps-0.5">{inline(it, `${kb}i${j}`)}</li>)}
            </L>
          );
        }
        if (b.t === "h") return <p key={kb} className="font-display text-[15px] font-bold text-ink">{lines(b.lines, kb)}</p>;
        if (b.t === "q") return <blockquote key={kb} className="border-s-2 border-yang/50 ps-3 text-ink-2">{lines(b.lines, kb)}</blockquote>;
        return <p key={kb}>{lines((b as { lines: string[] }).lines, kb)}</p>;
      })}
    </div>
  );
}

// ── files on Arta's replies ──────────────────────────────────────────────────
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-yin-ink focus-visible:ring-offset-2 focus-visible:ring-offset-space-1";

/** Arta's images (the photo it found), as a 1–4 grid in fixed aspect boxes — no layout shift. Arta
 *  never attaches text files; any older ones are not shown. */
export function ArtaFiles({ items }: { items: LibraryItem[] }) {
  const imgs = items.filter((i) => i.class === "image" || i.mime.startsWith("image/"));
  if (!imgs.length) return null;
  return (
    <ul className={cx("mt-2.5 grid gap-1.5 overflow-hidden rounded-2xl", imgs.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
      {imgs.map((it, i) => (
        <li key={it.id} className={cx("overflow-hidden border border-line bg-space-2", imgs.length === 1 ? "rounded-2xl" : "rounded-xl", imgs.length === 3 && i === 2 && "col-span-2")}>
          <a href={it.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`Open image ${it.name}`}
            className={cx("block w-full", imgs.length === 1 ? "aspect-[16/9]" : "aspect-square", FOCUS)}>
            <img src={it.url} alt={`Image attached by Arta: ${it.name}`} loading="lazy" decoding="async" className="h-full w-full object-cover" />
          </a>
        </li>
      ))}
    </ul>
  );
}

// ── live status of @arta mentions ────────────────────────────────────────────
/** A small status pill. `onShow` turns the "replied" state into a button that opens the thread. */
export function ArtaStatusPill({ state, onShow, className }: { state: ArtaPillState; onShow?: () => void; className?: string }) {
  if (!state) return null;
  if (state.kind === "replied") {
    if (!onShow) return null;
    return (
      <button type="button" onClick={(e) => { e.stopPropagation(); onShow(); }}
        className={cx("inline-flex min-h-8 items-center gap-1.5 rounded-pill border border-yang/40 bg-yang/[0.10] py-1 pe-3 ps-1 text-[12.5px] font-semibold text-yang-ink transition-colors hover:bg-yang/20", className)}>
        <ArtaAvatar className="h-5 w-5" />
        Arta replied · Show
      </button>
    );
  }
  const muted = state.kind === "limited" || state.kind === "missed" || state.kind === "offline";
  const text =
    state.kind === "thinking" ? "Arta is thinking…"
    : state.kind === "queued" ? (state.position <= 1 ? "Queued · up next" : `Queued · #${state.position}`)
    : state.kind === "offline" ? "Arta is offline — it will answer when it's back"
    : state.kind === "paused" ? "Arta is taking a short break — your question is saved"
    : state.kind === "limited" ? "Arta's limit is reached for now — mention it again a little later"
    : "Arta couldn't answer this one in time";
  return (
    <span role="status" aria-live="polite"
      title={state.kind === "queued" || state.kind === "offline" || state.kind === "paused" ? "The answer will appear in this thread — no need to ask again." : undefined}
      className={cx("inline-flex min-h-8 max-w-full items-center gap-2 rounded-pill border py-1 pe-3 ps-1 text-[12.5px] font-medium",
        muted ? "border-line bg-veil/[0.04] text-ink-3" : "border-yang/35 bg-yang/[0.08] text-ink-2", className)}>
      <span className="relative shrink-0">
        <ArtaAvatar className={cx("h-5 w-5", state.kind === "offline" && "opacity-60 grayscale")} />
        <span aria-hidden className={cx("absolute -bottom-px -end-px h-2 w-2 rounded-full ring-2 ring-space-1",
          state.kind === "thinking" || state.kind === "queued" ? "bg-yang" : state.kind === "paused" ? "bg-yin-light" : "bg-ink-3")} />
      </span>
      <span className="min-w-0 truncate">{text}</span>
      {state.kind === "thinking" ? <span aria-hidden className="aq-think-dots aq-think-dots--tiny"><i /><i /><i /></span> : null}
    </span>
  );
}

// ── @-autocomplete textarea ──────────────────────────────────────────────────
type Suggest = { slug: string; name: string; avatar: string; arta?: boolean };
const TOKEN_RE = /(^|[^A-Za-z0-9_@./+-])@([A-Za-z0-9-]{0,30})$/;

type TAProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onValue: (v: string) => void;
  /** ⌘/Ctrl+Enter. */
  onSubmit?: () => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Grow with the text up to this many px, then scroll. */
  maxGrow?: number;
  wrapClassName?: string;
};

/** A textarea with @-mention suggestions — @arta first — and ⌘/Ctrl+Enter to send. */
export function MentionTextarea({ value, onValue, onSubmit, textareaRef, maxGrow, wrapClassName, onKeyDown, ...rest }: TAProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef || own;
  const [q, setQ] = useState<string | null>(null);
  const [people, setPeople] = useState<Suggest[]>([]);
  const [cur, setCur] = useState(0);
  const lid = useId();

  const readToken = () => {
    const ta = ref.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? ta.value.length;
    const m = TOKEN_RE.exec(ta.value.slice(0, caret));
    setQ(m ? m[2] : null);
    setCur(0);
  };

  useEffect(() => {
    if (q === null || q.length < 2) { setPeople([]); return; }
    let live = true;
    const t = window.setTimeout(() => {
      searchMembers(q, 5).then((r) => {
        if (!live) return;
        setPeople((r.items || []).filter((m: MemberCard) => !/^(arta|artabot)$/i.test(m.slug)).map((m) => ({ slug: m.slug, name: m.name, avatar: m.avatar })));
      }).catch(() => { if (live) setPeople([]); });
    }, 180);
    return () => { live = false; window.clearTimeout(t); };
  }, [q]);

  const list: Suggest[] = useMemo(() => {
    if (q === null) return [];
    const arta = ARTA_HANDLE.startsWith(q.toLowerCase()) ? [{ slug: ARTA_HANDLE, name: "Arta", avatar: ARTA_AVATAR, arta: true }] : [];
    return [...arta, ...people].slice(0, 6);
  }, [q, people]);
  const open = list.length > 0;

  useEffect(() => {
    const ta = ref.current;
    if (!ta || !maxGrow) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(maxGrow, ta.scrollHeight)}px`;
  }, [value, maxGrow, ref]);

  const pick = (s: Suggest) => {
    const ta = ref.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? value.length;
    const head = value.slice(0, caret).replace(/@([A-Za-z0-9-]{0,30})$/, `@${s.slug} `);
    const next = head + value.slice(caret).replace(/^\S*/, (w) => (/^[A-Za-z0-9-]+$/.test(w) ? "" : w));
    onValue(next);
    setQ(null);
    requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = head.length; });
  };

  return (
    <div className={cx("relative", wrapClassName)}>
      <textarea
        {...rest}
        ref={ref}
        value={value}
        onChange={(e) => { onValue(e.currentTarget.value); requestAnimationFrame(readToken); }}
        onClick={readToken}
        onBlur={(e) => { window.setTimeout(() => setQ(null), 120); rest.onBlur?.(e); }}
        aria-autocomplete="list"
        aria-controls={open ? lid : undefined}
        aria-expanded={open}
        aria-activedescendant={open ? `${lid}-${cur}` : undefined}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === "ArrowDown") { e.preventDefault(); setCur((c) => (c + 1) % list.length); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setCur((c) => (c - 1 + list.length) % list.length); return; }
            if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") { e.preventDefault(); pick(list[cur]); return; }
            if (e.key === "Escape") { e.preventDefault(); setQ(null); return; }
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit(); return; }
          onKeyDown?.(e);
        }}
      />
      {open ? (
        <ul id={lid} role="listbox" aria-label="Mention someone"
          className="absolute start-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-space-2 py-1 shadow-pop">
          {list.map((s, i) => (
            <li key={s.slug} id={`${lid}-${i}`} role="option" aria-selected={i === cur}
              onMouseDown={(e) => { e.preventDefault(); pick(s); }} onMouseEnter={() => setCur(i)}
              className={cx("flex cursor-pointer items-center gap-2.5 px-3 py-2", i === cur ? "bg-veil/[0.07]" : "")}>
              {s.arta ? <ArtaAvatar className="h-8 w-8" /> : <Avatar src={s.avatar} name={s.name} className="h-8 w-8 text-[12px]" />}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-[13.5px] font-semibold text-ink">
                  <span className="truncate" data-ay-skip="1">{s.name}</span>
                  {s.arta ? <ArtaBadge size={14} chip={false} /> : null}
                </span>
                <span className="block truncate text-[12px] text-ink-3">
                  {s.arta ? "Public assistant · answers in the thread" : <bdi dir="ltr" data-ay-skip="1">@{s.slug}</bdi>}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The small line under a composer: what tagging Arta does, and the bug: shortcut. */
export function ArtaHint({ text, className }: { text: string; className?: string }) {
  const asks = mentionsArta(text);
  const bug = asks && looksLikeBug(text);
  return (
    <p className={cx("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-3", className)}>
      {bug ? (
        <span className="text-yang-ink">Arta will file this as a bug on GitHub and reply with the link.</span>
      ) : asks ? (
        <span>Arta replies in this thread, in public. Tip: start with <code className="rounded bg-veil/[0.08] px-1 font-mono text-[11.5px] text-ink-2">bug:</code> to report a bug.</span>
      ) : (
        <span>Tag <span className="font-semibold text-ink-2">@arta</span> to ask Arta in public.</span>
      )}
      <span aria-hidden className="hidden text-ink-3/80 sm:inline">· ⌘/Ctrl + Enter to send</span>
    </p>
  );
}
