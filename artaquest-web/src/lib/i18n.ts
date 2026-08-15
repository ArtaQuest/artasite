/**
 * Client-driven translation engine.
 *
 * The browser is the translation worker; WordPress is a content-addressed cache.
 * For any page in a non-English language the engine:
 *
 *   1. Collects every visible string in the rendered DOM (text nodes, a few
 *      attributes, the <title>).
 *   2. Applies whatever it already knows (in-memory + localStorage + the DB via
 *      /aq/v1/i18n/resolve) instantly.
 *   3. Translates the rest through Google — directly from the browser when CORS
 *      allows (so the work distributes across users), else via the thin server
 *      proxy /aq/v1/i18n/translate (which also persists).
 *   4. Saves the new translations back to the DB via /aq/v1/i18n/save, so the next
 *      visitor in this language gets them for free. (The translated SEO meta is applied
 *      to this page's DOM for the current viewer, but not persisted — nothing reads it
 *      server-side.)
 *
 * A full-screen translated loader (driven by `busy`) gates the first paint and
 * any first-visit route, so a half-translated page is never shown. Each unique
 * (string × language) is translated exactly once, ever — by its first visitor.
 */

export type LangMeta = { code: string; native: string; name: string; dir: "ltr" | "rtl" };
export type I18nConfig = {
  current: string;
  source: string;
  dir: "ltr" | "rtl";
  langs: LangMeta[];
  digits: string[] | null;
  boot: Record<string, string>;
  /** ArtaTranslate upgrade counter for the current language — when it moves, the
   *  localStorage cache is stale (better translations exist in the DB) and is dropped. */
  epoch?: number;
};

const REST = "/wp-json/aq/v1/i18n";
const NONCE = (typeof window !== "undefined" && (window as unknown as { AQ_WP_NONCE?: string }).AQ_WP_NONCE) || "";

// Google code overrides where the routable code differs from Google's.
const G_CODE: Record<string, string> = { zh: "zh-CN", "zh-tw": "zh-TW", he: "iw", jv: "jw" };
const gcode = (l: string) => G_CODE[l] || l;

// Tags whose text is never translated — same exclusion list the server uses.
const SKIP_TAGS: Record<string, 1> = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, TEXTAREA: 1, NOSCRIPT: 1, IFRAME: 1 };
const ATTRS = ["placeholder", "aria-label", "title", "alt"] as const;
const MAX_LEN = 5000; // skip very long nodes (matches the server cap).
const GATE_TIMEOUT_MS = 6000; // max time the first-paint loader can block the page.
// Match I18n::MT_OUTBOUND_MAX. Sending more per request than the server will forward only means the
// remainder returns untranslated; sizing to the budget converges in far fewer round trips.
const SERVER_MT_CHUNK = 8;
// How many times one pass chases strings the server deferred before leaving the rest to the next
// page view. Each round is cheap (earlier rounds' rows are now cache hits) and strictly bounded.
const MAX_DEFERRED_ROUNDS = 6;

// Current viewer language + whether it is the source language. Set when the
// engine is constructed; consulted by the shared DOM walkers.
let CURRENT = "";
let SOURCE = true;

export function i18nConfig(): I18nConfig | null {
  if (typeof window === "undefined") return null;
  const c = (window as unknown as { AQ_I18N?: I18nConfig }).AQ_I18N;
  return c && c.current ? c : null;
}

/** True when the current view is in a translated (non-source) language. */
export function i18nActive(): boolean {
  const c = i18nConfig();
  return !!c && c.current !== (c.source || "en");
}

// ── DOM walking ──────────────────────────────────────────────────────────────

/**
 * Is this ELEMENT itself excluded? `skip()` below walks from a node's PARENT, which is right for a
 * text node but wrong for an element whose own attributes we are about to read — an element
 * carrying data-ay-skip must exclude its own title/aria-label/placeholder/alt too.
 */
function skipEl(el: Element): boolean {
  if (SKIP_TAGS[el.tagName]) return true;
  if (el.getAttribute?.("data-ay-skip") === "1") return true;
  return skip(el);
}

function skip(node: Node): boolean {
  let p = node.parentNode as HTMLElement | null;
  while (p && p.nodeType === 1) {
    if (SKIP_TAGS[p.tagName]) return true;
    if (p.getAttribute && p.getAttribute("data-ay-skip") === "1") return true;
    // User content already written in the viewer's language — leave it untouched
    // (this is what lets people in the same thread each read in their own tongue
    // without re-translating posts that are already in the reader's language).
    if (CURRENT && p.getAttribute && p.getAttribute("data-ay-src") === CURRENT) return true;
    // Never reach into typeset math — translating KaTeX spans corrupts the markup.
    if (p.classList && p.classList.contains("katex")) return true;
    p = p.parentNode as HTMLElement | null;
  }
  return false;
}

/** Content roots to translate. Non-source: the whole body. Source language: only
 *  the opt-in user-content regions (`[data-ay-tr]`) — foreign posts shown to an
 *  English reader — so the English chrome is never needlessly round-tripped. */
function passRoots(): Element[] {
  if (!SOURCE) return [document.body];
  return Array.from(document.querySelectorAll("[data-ay-tr]"));
}

/** Is this node inside an opt-in user-content region? */
function inContent(node: Node): boolean {
  let p: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
  while (p) {
    if (p.getAttribute && p.getAttribute("data-ay-tr") != null) return true;
    p = p.parentElement;
  }
  return false;
}

/** Collect every translatable trimmed string under a root (text + attributes). */
function collect(root: Node, out: Set<string>): void {
  if (root.nodeType === 1) {
    const el = root as HTMLElement;
    if (SKIP_TAGS[el.tagName] || el.getAttribute?.("data-ay-skip") === "1") return;
  }
  const doc = root.ownerDocument || document;
  // Text nodes.
  if (root.nodeType === 3) {
    addText(root as Text, out);
  } else if (root.nodeType === 1) {
    const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let n: Node | null;
    while ((n = w.nextNode())) {
      if (!skip(n)) addText(n as Text, out);
    }
    // Attribute values. These MUST honour data-ay-skip exactly like text nodes do — they did not,
    // which quietly made the marker a half-promise: a component could mark its wrapper and still
    // publish a member's name through a title=, aria-label= or alt= inside it. On private surfaces
    // (ArtaChat) that is a plaintext leak into the public translations table, not a cosmetic bug.
    addAttrs(root as HTMLElement, out);
    const els = (root as HTMLElement).querySelectorAll?.("[placeholder],[aria-label],[title],[alt]");
    els?.forEach((e) => { if (!skipEl(e)) addAttrs(e as HTMLElement, out); });
  }
}

function addText(node: Text, out: Set<string>): void {
  const raw = node.nodeValue;
  if (!raw || raw.length > MAX_LEN) return;
  const t = raw.trim();
  if (t && /\p{L}/u.test(t)) out.add(t);
}

function addAttrs(el: HTMLElement, out: Set<string>): void {
  if (!el.getAttribute) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v) {
      const t = v.trim();
      if (t && /\p{L}/u.test(t)) out.add(t);
    }
  }
}

/** Add the translatable part of the document <title> to the collect set. */
function addTitle(out: Set<string>): void {
  const t = document.title;
  if (!t) return;
  const m = t.match(/^(.+?)(\s+\S\s+ArtaQuest)$/);
  out.add(m ? m[1] : t.trim());
}

/**
 * Apply known translations across a root. Idempotent: a node already swapped to
 * the target language no longer matches an English key, so re-running is safe.
 */
function apply(root: Node, dict: Map<string, string>, loc: (s: string) => string): void {
  if (root.nodeType === 1) {
    const el = root as HTMLElement;
    if (SKIP_TAGS[el.tagName] || el.getAttribute?.("data-ay-skip") === "1") return;
  }
  const doc = root.ownerDocument || document;
  if (root.nodeType === 3) {
    swapText(root as Text, dict, loc);
    return;
  }
  if (root.nodeType !== 1) return;
  const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n: Node | null;
  while ((n = w.nextNode())) {
    if (!skip(n)) swapText(n as Text, dict, loc);
  }
  swapAttrs(root as HTMLElement, dict, loc);
  // Same skip rule as collect() — a marked subtree is neither read from nor written to.
  (root as HTMLElement).querySelectorAll?.("[placeholder],[aria-label],[title],[alt]")
    .forEach((e) => { if (!skipEl(e)) swapAttrs(e as HTMLElement, dict, loc); });
}

// A text node we have written. The characterData observer checks `_ayv` against
// the live value so it can distinguish OUR swap (skip — don't re-collect, which
// would feed a translated string back in as new work) from React resetting the
// node to fresh source text (re-process).
type Stamped = Text & { _ayv?: string };

function swapText(node: Text, dict: Map<string, string>, loc: (s: string) => string): void {
  const raw = node.nodeValue;
  if (!raw || raw.length > MAX_LEN) return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  const hit = dict.get(trimmed);
  if (hit) {
    const lead = raw.match(/^\s*/)?.[0] ?? "";
    const trail = raw.match(/\s*$/)?.[0] ?? "";
    const v = lead + loc(hit) + trail;
    node.nodeValue = v;
    (node as Stamped)._ayv = v;
    return;
  }
  // Standalone digit-only payload — localise numerals without a dict match.
  if (/[0-9]/.test(raw) && !/[A-Za-z]/.test(trimmed)) {
    const v = loc(raw);
    node.nodeValue = v;
    (node as Stamped)._ayv = v;
  }
}

function swapAttrs(el: HTMLElement, dict: Map<string, string>, loc: (s: string) => string): void {
  if (!el.getAttribute) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const hit = dict.get(v.trim());
    if (hit && hit !== v) el.setAttribute(a, loc(hit));
  }
}

// ── Network ──────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${REST}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(NONCE ? { "X-WP-Nonce": NONCE } : {}) },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return (await r.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

async function resolveDb(lang: string, strings: string[]): Promise<{ hits: Record<string, string>; missing: string[] }> {
  const j = await post("/resolve", { lang, strings });
  if (!j) return { hits: {}, missing: strings };
  return { hits: (j.hits as Record<string, string>) || {}, missing: (j.missing as string[]) || [] };
}

async function serverTranslate(
  lang: string,
  strings: string[],
): Promise<{ hits: Record<string, string>; deferred: string[] }> {
  // source=auto: the strings may be UI English OR user-generated content in any
  // language (global discussions). Google auto-detects either and translates to
  // the viewer's language.
  //
  // `deferred` names the strings the server ran out of outbound budget for and never sent to
  // Google (I18n::MT_OUTBOUND_MAX, 8 per request). They are NOT failures and must never be cached
  // as their own translation — the caller re-queues them. A network error is read as "everything
  // was deferred", which is the safe direction: retry rather than freeze as English.
  const j = await post("/translate", { lang, strings, source: "auto" });
  if (!j) return { hits: {}, deferred: strings.slice() };
  return {
    hits: (j.hits as Record<string, string>) || {},
    deferred: Array.isArray(j.deferred) ? (j.deferred as string[]) : [],
  };
}

function save(lang: string, pairs: { s: string; t: string }[]): void {
  // Fire-and-forget — the next visitor benefits; this one already has the result.
  // (Only the translation pairs are persisted server-side; the SEO bundle is applied to the
  // DOM for this viewer but not stored — there is no server-side reader for it.)
  void post("/save", { lang, pairs });
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Limited-concurrency map for direct-from-browser Google calls.
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Engine ───────────────────────────────────────────────────────────────────

type Listener = (busy: boolean) => void;

class Engine {
  private cfg: I18nConfig;
  private loc: (s: string) => string;
  private mem = new Map<string, string>();
  private inflight = new Set<string>();
  private listeners = new Set<Listener>();
  private busy = true; // start gated for the first paint.
  private revealed = false; // becomes true once the first-paint gate has lifted.
  // Browsers cannot reach translate.googleapis.com directly (no CORS headers), so
  // the direct-from-browser path essentially always fails — and the failing fetch
  // adds seconds of latency before falling back. Default to the server proxy (which
  // IS Google, just same-origin) and skip the doomed direct attempt. The direct
  // code path is kept for environments where a CORS-friendly endpoint exists.
  private directBlocked = true;
  /** Strings the server had no outbound budget for this pass — re-queued, never cached as English. */
  private deferred: string[] = [];
  private deferredRounds = 0;
  private dirty: { s: string; t: string }[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private passTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  constructor(cfg: I18nConfig) {
    this.cfg = cfg;
    CURRENT = cfg.current;
    SOURCE = cfg.current === (cfg.source || "en");
    // English (source): no full-screen gate — only foreign user content is
    // translated, in place. Non-source: gate the first paint.
    this.busy = !SOURCE;
    const d = cfg.digits;
    this.loc = d && d.length === 10 ? (s: string) => s.replace(/[0-9]/g, (n) => d[+n]) : (s: string) => s;
  }

  /** Apply known translations across the active content roots. */
  private applyAll(): void {
    for (const r of passRoots()) apply(r, this.mem, this.loc);
    this.applyTitle();
  }

  /** Merge a downloaded translation pack into the live engine and re-apply it immediately,
   *  so an offline-downloaded language renders fully without any network. */
  seed(dict: Record<string, string>): void {
    for (const k in dict) if (dict[k] && dict[k] !== k) this.mem.set(k, dict[k]);
    this.applyAll();
    this.scheduleFlush();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.busy);
    return () => this.listeners.delete(fn);
  }

  private setBusy(b: boolean): void {
    // The loader is a FIRST-PAINT gate only. Once revealed, never show it again —
    // all further translation (route changes, late async content, the remainder of
    // a timed-out first pass) streams in place, so the user is never blocked.
    if (this.revealed) b = false;
    if (this.busy === b) return;
    this.busy = b;
    this.listeners.forEach((l) => l(b));
  }

  /** Boot: load caches, set direction, run the gated first pass, start observing. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    document.documentElement.setAttribute("dir", this.cfg.dir);
    document.documentElement.setAttribute("lang", this.cfg.current);

    // Seed from the inline boot dict (loader copy) + localStorage cache.
    for (const k in this.cfg.boot) if (this.cfg.boot[k] && this.cfg.boot[k] !== k) this.mem.set(k, this.cfg.boot[k]);
    this.loadCache();

    // Attach the observer BEFORE the first pass. The first pass can take seconds
    // (translating the shell), and async content — a discussion thread's fetch
    // resolving and mounting mid-pass — would otherwise land in the DOM unobserved
    // and never get translated. The observer + pass dedupe via mem/inflight.
    this.observe();
    // Gate the first paint, but NEVER longer than GATE_TIMEOUT_MS. Translate
    // whatever resolves within the budget, then reveal — the remainder keeps
    // translating in the background and streams into place. A page-language with a
    // slow/huge first translation never traps the visitor behind the loader.
    // .catch on the PASS, not on the race. Promise.race settles on whichever promise settles first
    // INCLUDING A REJECTION — so a first pass that throws (a 5xx from the translate endpoint, a
    // dropped connection, anything) rejected the race, skipped both lines below, and left a
    // non-English visitor behind the loader with no timeout able to save them: the timeout only wins
    // a race against a HANG, never against a throw. start() is called as `void eng.start()`, so the
    // rejection went nowhere and said nothing. Swallowing it here is right — an untranslated page is
    // a far better outcome than a covered one, and the observer keeps translating in the background.
    await Promise.race([
      this.pass(true).catch(() => {}),
      new Promise((r) => setTimeout(r, GATE_TIMEOUT_MS)),
    ]);
    this.revealed = true;
    this.setBusy(false);
    if (!SOURCE) void this.saveSeo();
  }

  /** Re-translate after a client-side route change; gate if the page is new here. */
  async route(): Promise<void> {
    // Same reasoning as start(): the caller does `void eng.route()`, so a throw here is an unhandled
    // rejection nobody sees. pass(false) clears busy in its own finally, so the page is not trapped —
    // but the failure should not take the SEO save down with it either.
    await this.pass(false).catch(() => {});
    if (!SOURCE) void this.saveSeo();
  }

  // One translation pass over the active content roots.
  private async pass(initial: boolean): Promise<void> {
    const roots = passRoots();
    if (roots.length === 0) return; // source language with no foreign content on screen.

    const strings = new Set<string>();
    for (const r of roots) collect(r, strings);
    addTitle(strings);

    const unknown: string[] = [];
    strings.forEach((s) => {
      if (!this.mem.has(s) && !this.inflight.has(s)) unknown.push(s);
    });

    // Apply everything we already know, right now.
    this.applyAll();

    if (unknown.length === 0) return;

    unknown.forEach((s) => this.inflight.add(s));
    if (!initial) this.setBusy(true);
    try {
      // Stream each batch into the page as it lands.
      const got = await this.translate(unknown, (partial) => this.absorb(partial));
      // Seed identity ONLY for strings the server actually put to Google and Google declined — that
      // is a real answer and must not be retried in a loop. A string the server DEFERRED for budget
      // was never asked about, so caching it as its own translation is simply wrong: it pinned
      // roughly four strings in five permanently in English (mem is written straight to localStorage
      // by scheduleFlush, and pass() filters on mem.has, so nothing ever revisited it).
      const wasDeferred = new Set(this.deferred);
      for (const s of unknown) if (!got[s] && !wasDeferred.has(s) && !this.mem.has(s)) this.mem.set(s, s);
      // Re-queue what was deferred: the rows this pass created are cache HITS next time (hits are
      // unbudgeted), so a few rounds converge instead of stalling. Bounded by round count.
      if (this.deferred.length && this.deferredRounds < MAX_DEFERRED_ROUNDS) {
        this.deferredRounds++;
        const again = this.deferred.slice();
        this.deferred = [];
        setTimeout(() => void this.retryDeferred(again), 400 * this.deferredRounds);
      }
      this.applyAll();
      this.scheduleFlush();
    } finally {
      unknown.forEach((s) => this.inflight.delete(s));
      if (!initial && this.inflight.size === 0) this.setBusy(false);
    }
  }

  /**
   * Chase the strings the server deferred for outbound budget.
   *
   * Cheap by construction: everything earlier rounds created is now a cache HIT, and hits are
   * unbudgeted, so each round moves the frontier forward by another MT_OUTBOUND_MAX per request
   * instead of stalling. Silent — it never touches `busy`, so a member sees strings arrive in place
   * rather than a loader reappearing after first paint.
   */
  private async retryDeferred(list: string[]): Promise<void> {
    const todo = list.filter((s) => !this.mem.has(s) && !this.inflight.has(s));
    if (!todo.length) return;
    todo.forEach((s) => this.inflight.add(s));
    try {
      await this.translate(todo, (partial) => this.absorb(partial));
      this.applyAll();
      this.scheduleFlush();
      if (this.deferred.length && this.deferredRounds < MAX_DEFERRED_ROUNDS) {
        this.deferredRounds++;
        const again = this.deferred.slice();
        this.deferred = [];
        setTimeout(() => void this.retryDeferred(again), 400 * this.deferredRounds);
      }
    } finally {
      todo.forEach((s) => this.inflight.delete(s));
    }
  }

  /** Merge a freshly-translated batch into memory, persist queue, and apply it. */
  private absorb(partial: Record<string, string>): void {
    let any = false;
    for (const s in partial) {
      if (partial[s] && partial[s] !== s) {
        this.mem.set(s, partial[s]);
        this.dirty.push({ s, t: partial[s] });
        any = true;
      }
    }
    if (any) {
      this.applyAll();
      this.scheduleFlush(); // persist as we go, so the cache survives even if a later chunk stalls.
    }
  }

  /**
   * Resolve from DB, then Google (direct → server proxy) for the remainder.
   * Chunked, and `onBatch` is invoked as each chunk lands so the caller can swap
   * translations into the page progressively — content STREAMS in rather than
   * waiting for the whole list (matters when the first-paint gate times out and
   * the rest keeps filling in behind the revealed page).
   */
  private async translate(list: string[], onBatch?: (partial: Record<string, string>) => void): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const missing: string[] = [];

    // 1. DB resolve — read-only, large chunks.
    for (const chunk of chunked(list, 500)) {
      const { hits, missing: miss } = await resolveDb(this.cfg.current, chunk);
      Object.assign(out, hits);
      missing.push(...miss);
      if (onBatch && Object.keys(hits).length) onBatch(hits);
    }
    if (missing.length === 0) return out;

    // 2. Direct from the browser (distributes the work), unless known-blocked.
    let stillMissing = missing;
    if (!this.directBlocked) {
      const direct = await this.googleDirect(missing);
      stillMissing = [];
      for (const s of missing) {
        if (direct[s]) out[s] = direct[s];
        else stillMissing.push(s);
      }
      if (onBatch && Object.keys(direct).length) onBatch(direct);
    }

    // 3. Server proxy (persists server-side too) — chunked to the cap and run a
    // few chunks concurrently so a fresh page fills fast (each chunk also streams
    // into the page via onBatch as it lands).
    // Chunk to the server's own per-request outbound budget rather than 40: a 40-string chunk had
    // at most 8 of them translated, and the other 32 came back untouched and were cached as English.
    const deferred: string[] = [];
    await mapLimit(chunked(stillMissing, SERVER_MT_CHUNK), 3, async (chunk) => {
      const srv = await serverTranslate(this.cfg.current, chunk);
      Object.assign(out, srv.hits);
      if (srv.deferred.length) deferred.push(...srv.deferred);
      if (onBatch && Object.keys(srv.hits).length) onBatch(srv.hits);
    });
    this.deferred = deferred;
    return out;
  }

  private async googleDirect(list: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const tl = gcode(this.cfg.current);
    const results = await mapLimit(list, 6, async (text) => {
      if (this.directBlocked) return null;
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const data = (await r.json()) as unknown;
        if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
        let s = "";
        for (const seg of data[0] as unknown[]) {
          if (Array.isArray(seg) && typeof seg[0] === "string") s += seg[0];
        }
        return s ? { text, out: s } : null;
      } catch {
        // CORS / network → browser can't reach Google directly. Stop trying this
        // session; the server proxy carries every translation from here.
        this.directBlocked = true;
        return null;
      }
    });
    for (const r of results) {
      if (r && r.out && r.out !== r.text) out[r.text] = r.out;
    }
    return out;
  }

  // Persist the SEO bundle (translated title/description/og) + any direct-Google
  // pairs the server hasn't already stored.
  private async saveSeo(): Promise<void> {
    const get = (sel: string) => (document.querySelector(sel) as HTMLMetaElement | null)?.getAttribute("content") || "";
    const rawDesc = get('meta[name="description"]');
    const rawOgT = get('meta[property="og:title"]');
    const rawOgD = get('meta[property="og:description"]');

    const need = [rawDesc, rawOgT, rawOgD].filter((s) => s && !this.mem.has(s));
    if (need.length) {
      const got = await this.translate([...new Set(need)]);
      for (const s in got) {
        this.mem.set(s, got[s]);
        this.dirty.push({ s, t: got[s] });
      }
    }
    const tr = (s: string) => (s ? this.mem.get(s) || s : "");
    const title = document.title;
    const seo: Record<string, string> = {
      title,
      description: tr(rawDesc),
      og_title: tr(rawOgT) || title,
      og_description: tr(rawOgD) || tr(rawDesc),
    };
    // Reflect translated meta into the live DOM (for in-page social share / a11y).
    const setMeta = (sel: string, v: string) => {
      const el = document.querySelector(sel);
      if (el && v) el.setAttribute("content", v);
    };
    setMeta('meta[name="description"]', seo.description);
    setMeta('meta[property="og:title"]', seo.og_title);
    setMeta('meta[property="og:description"]', seo.og_description);

    const pairs = this.dirty.splice(0, this.dirty.length);
    save(this.cfg.current, pairs);
  }

  // ── <title> ────────────────────────────────────────────────────────────────
  private applyTitle(): void {
    const t = document.title;
    const m = t.match(/^(.+?)(\s+\S\s+ArtaQuest)$/);
    if (m) {
      const hit = this.mem.get(m[1]);
      if (hit && hit !== m[1]) document.title = this.loc(hit) + m[2];
    } else {
      const hit = this.mem.get(t.trim());
      if (hit && hit !== t.trim()) document.title = this.loc(hit);
    }
  }

  // In source mode only user-content regions are processed; non-source walks all.
  private processAdded(node: Node, pending: Set<string>): void {
    if (!SOURCE) {
      apply(node, this.mem, this.loc);
      collect(node, pending);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const roots: Element[] = el.matches && el.matches("[data-ay-tr]") ? [el] : [];
    if (el.querySelectorAll) el.querySelectorAll("[data-ay-tr]").forEach((r) => roots.push(r));
    for (const r of roots) {
      apply(r, this.mem, this.loc);
      collect(r, pending);
    }
  }

  // ── Observer (incremental, after the gate opens) ─────────────────────────────
  private observe(): void {
    const pending = new Set<string>();
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData" && m.target.nodeType === 3) {
          const tn = m.target as Stamped;
          if (tn._ayv === tn.nodeValue) continue;   // our own swap — don't re-collect (avoids a feedback loop).
          if (SOURCE && !inContent(tn)) continue;   // English chrome — leave it.
          if (!skip(tn)) {
            swapText(tn, this.mem, this.loc);
            // Only collect if still untranslated source (swapText didn't stamp it).
            if (tn._ayv !== tn.nodeValue) collect(tn, pending);
          }
        } else if (m.type === "attributes" && m.target.nodeType === 1) {
          if (SOURCE && !inContent(m.target)) continue;
          swapAttrs(m.target as HTMLElement, this.mem, this.loc);
        } else {
          m.addedNodes.forEach((node) => this.processAdded(node, pending));
        }
      }
      // Drop anything we already know/are fetching; batch the genuinely new.
      pending.forEach((s) => {
        if (this.mem.has(s) || this.inflight.has(s)) pending.delete(s);
      });
      if (pending.size) this.schedulePass(pending);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });

    // <title> is outside <body> — observe it separately. Routes/threads set the
    // title AFTER load (e.g. the thread title); swap it if known, and collect it
    // for translation when it isn't yet (so a freshly-set title still localises).
    const titleEl = document.querySelector("title");
    if (titleEl) {
      new MutationObserver(() => {
        this.applyTitle();
        // In source mode only translate the title on content pages (a foreign
        // thread title) — never the English UI titles of ordinary pages.
        if (SOURCE && passRoots().length === 0) return;
        const t = document.title;
        const m = t.match(/^(.+?)(\s+\S\s+ArtaQuest)$/);
        const section = m ? m[1] : t.trim();
        if (section && !this.mem.has(section) && !this.inflight.has(section)) {
          this.schedulePass(new Set([section]));
        }
      }).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  }

  private schedulePass(pending: Set<string>): void {
    if (this.passTimer) clearTimeout(this.passTimer);
    this.passTimer = setTimeout(async () => {
      const batch = [...pending].filter((s) => !this.mem.has(s) && !this.inflight.has(s));
      pending.clear();
      if (!batch.length) return;
      batch.forEach((s) => this.inflight.add(s));
      this.setBusy(true);
      try {
        const got = await this.translate(batch, (partial) => this.absorb(partial));
        for (const s of batch) if (!got[s] && !this.mem.has(s)) this.mem.set(s, s);
        this.applyAll();
        this.scheduleFlush();
        if (!SOURCE) void this.saveSeo();
      } finally {
        batch.forEach((s) => this.inflight.delete(s));
        if (this.inflight.size === 0) this.setBusy(false);
      }
    }, 60);
  }

  // ── localStorage cache ───────────────────────────────────────────────────────
  private cacheKey(): string {
    return `aq_i18n_${this.cfg.current}`;
  }
  private loadCache(): void {
    try {
      // ArtaTranslate epoch check: the server bumps `epoch` when it upgrades this language's
      // translations (Google edge → adversarially-reviewed). A stale local cache would keep showing
      // the old edge text forever, so drop it and refill from the DB — one cheap batched resolve.
      // Never drop while OFFLINE (no network to refill from), and never drop a DOWNLOADED langpack
      // (the localStorage dict is the pack's only full copy — it refreshes by re-download instead).
      const ek = `${this.cacheKey()}_epoch`;
      const want = String(this.cfg.epoch ?? 0);
      if (
        localStorage.getItem(ek) !== want &&
        navigator.onLine !== false &&
        localStorage.getItem(`${this.cacheKey()}_pack`) !== "1"
      ) {
        localStorage.removeItem(this.cacheKey());
        localStorage.setItem(ek, want);
        return;
      }
      const raw = localStorage.getItem(this.cacheKey());
      if (!raw) return;
      const o = JSON.parse(raw) as Record<string, string>;
      for (const k in o) if (o[k] && o[k] !== k) this.mem.set(k, o[k]);
    } catch {
      /* storage blocked / quota — in-memory cache still works. */
    }
  }
  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      try {
        const o: Record<string, string> = {};
        let n = 0;
        for (const [k, v] of this.mem) {
          o[k] = v;
          if (++n >= 20000) break; // cap to stay well under the localStorage quota (raised to hold offline packs).
        }
        localStorage.setItem(this.cacheKey(), JSON.stringify(o));
      } catch {
        /* quota exceeded — keep serving from memory. */
      }
    }, 800);
  }
}

let engine: Engine | null = null;

/** Create (once) and return the engine. Runs for EVERY language: non-source pages
 *  translate the whole UI; the source language still runs to translate foreign
 *  user-content (global discussions) into the reader's language. Null only when no
 *  i18n config is present at all. */
export function getEngine(): Engine | null {
  const cfg = i18nConfig();
  if (!cfg) return null;
  if (!engine) engine = new Engine(cfg);
  return engine;
}

/** Is the current view in the source (English) language? */
export function isSourceLang(): boolean {
  const c = i18nConfig();
  return !c || c.current === (c.source || "en");
}

/** Loader copy in the active language (from the inline boot dict), with fallback. */
export function bootText(en: string): string {
  const c = i18nConfig();
  return (c && c.boot && c.boot[en]) || en;
}

/** Every supported language (the full Google set, ~133), for the language selector. */
export function availableLangs(): LangMeta[] {
  return i18nConfig()?.langs ?? [{ code: "en", native: "English", name: "English", dir: "ltr" }];
}

/** The active language code. */
export function currentLang(): string {
  return i18nConfig()?.current || "en";
}

/** Merge an offline-downloaded translation pack for `lang` into the per-language localStorage cache
 *  (read on boot) and, if it's the active language, the live engine — so a downloaded language
 *  renders fully offline. Called by the Download Center (lib/offline/store.ts). */
export function seedTranslations(lang: string, dict: Record<string, string>, epoch?: number): void {
  try {
    const key = `aq_i18n_${lang}`;
    const raw = localStorage.getItem(key);
    const o: Record<string, string> = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    for (const k in dict) if (dict[k] && dict[k] !== k) o[k] = dict[k];
    localStorage.setItem(key, JSON.stringify(o));
    // Stamp the ArtaTranslate epoch (from the langpack response, or the boot config when this is the
    // active language) so the fresh pack isn't discarded as "stale" by the next load's epoch check.
    const cfg = i18nConfig();
    const e = epoch ?? (cfg && cfg.current === lang ? cfg.epoch ?? 0 : undefined);
    if (e !== undefined) localStorage.setItem(`${key}_epoch`, String(e));
  } catch { /* quota / storage blocked — the IndexedDB pack still records the download */ }
  const cfg = i18nConfig();
  if (engine && cfg && cfg.current === lang) engine.seed(dict);
}

export type { Engine };
