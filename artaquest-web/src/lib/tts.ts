// ArtaTTS — the on-device reader. Select any big text (or open the reader) and ArtaTTS reads it
// aloud PARAGRAPH BY PARAGRAPH while one soft gradient band lights the block being spoken and the
// page scrolls smoothly to keep it in view — on mobile and desktop, always in sync.
//
// ONE engine (operator, 2026-07-21: state-of-the-art on-device ONLY — the cloud tier, the tiny-model
// fallback and the OS speechSynthesis voices were all removed as below-bar):
//   · Kokoro-82M (kokoro-js) — reference-quality small neural TTS, English (US/GB). Runs on WebGPU
//     (fp32/fp16) or threaded/serial WASM (q8/q8f16); the quantization is chosen per DEVICE TIER so a
//     flagship desktop gets fp32 and an entry WebGPU phone gets q8/fp16 (NEVER fp32 on a mobile GPU —
//     it corrupts on some of them and overheats).
//
// A capability probe picks the precision per device; a one-time real-time-factor benchmark gates the
// playback speeds. Neural audio is generated at 1× and time-stretched at playback (preservesPitch),
// so one cached clip serves every speed.
// (RECORDED studio narrations are the OTHER Listen source — components/listen.tsx plays those.)

export const SPEEDS: readonly number[] = [0.75, 1, 1.25, 1.5, 1.75, 2];

export type TtsModelId = "kokoro";
export type TtsTier = "ultra-low" | "low" | "mid" | "high" | "flagship";

export type TtsVoice = {
  engine: "neural";
  /** "kokoro" (the 82M multilingual default) or "piper" — NATIVE per-language VITS voices where
   *  Kokoro has no trained voice (Farsi: the fa_IR Piper voices, trained on IRANIAN Persian —
   *  the earlier Hindi-style-vector hack read with a Dari accent and was replaced, operator 2026-07-22). */
  model?: TtsModelId | "piper";
  /** Kokoro: style-vector bin name. Piper: the voice id on rhasspy/piper-voices (e.g. fa_IR-amir-medium). */
  id: string;
  name: string;
  lang: string;   // BCP-47-ish display/matching language
  espeak: string; // espeak-ng voice for G2P; "en-us"/"en-gb" ride kokoro-js's native English path
  gender?: string;
};

/** A sentence: its plain text (fed to the speech engine) and a live Range (the region the band lights). */
export type Sentence = { text: string; range: Range };

export type Bench = { rtf: number; device: "webgpu" | "wasm"; dtype: string; model: TtsModelId };
export type NeuralProgress = { pct: number; status: string };

/** What the device can run — the default neural model + precision, plus the raw signals (so the UI can
 *  explain the choice and the runtime benchmark can demote). */
export type DeviceProfile = {
  tier: TtsTier;
  device: "webgpu" | "wasm";
  dtype: KokoroDtype;
  model: TtsModelId;
  webgpu: boolean;
  f16: boolean;
  mobile: boolean;
  reducedData: boolean;
  cores: number;
  deviceMemory?: number;
  threads: boolean;
};

type KokoroDtype = "fp32" | "fp16" | "q8" | "q8f16" | "q4f16";

// ---------------------------------------------------------------------------- model registry

export type TtsModel = {
  id: TtsModelId;
  label: string;
  repo: string;
  approxMB: (device: "webgpu" | "wasm", dtype: string) => number;
  note: string;
};

export const TTS_MODELS: Record<TtsModelId, TtsModel> = {
  kokoro: {
    id: "kokoro",
    label: "ArtaTTS Kokoro — natural neural voice",
    repo: "onnx-community/Kokoro-82M-v1.0-ONNX",
    approxMB: (_d, dtype) => ({ fp32: 326, fp16: 163, q8: 92, q8f16: 86, q4f16: 154 }[dtype] ?? 92),
    note: "Reference-quality 82M neural TTS · English",
  },
};

// ---------------------------------------------------------------------------- voices

// Kokoro voices (static mirror of the model's voices dir, best-graded first, so the picker renders
// before the model downloads). Prefix letter 1 = language family, letter 2 = gender (f/m).
// MULTILINGUAL (operator, 2026-07-22): the SAME 82M model speaks the non-English voices — G2P runs
// through the full espeak-ng WASM build (below), whose IPA maps 1:1 into Kokoro's token vocabulary
// (verified: zero dropped tokens across all six languages). Farsi has no trained Kokoro voice, so it
// reuses the HINDI style vectors (nearest phoneme inventory) with espeak "fa" G2P — labelled beta.
const kokoroVoice = (id: string, lang: string, espeak: string, name?: string): TtsVoice => ({
  engine: "neural", model: "kokoro", id, lang, espeak,
  gender: id[1] === "f" ? "female" : "male",
  name: name || id.slice(3, 4).toUpperCase() + id.slice(4),
});
const KOKORO_VOICES: TtsVoice[] = [
  ...["af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah", "af_nova", "af_alloy", "af_jessica", "af_river", "af_sky",
    "am_michael", "am_fenrir", "am_puck", "am_adam", "am_echo", "am_eric", "am_liam", "am_onyx", "am_santa"].map((id) => kokoroVoice(id, "en-US", "en-us")),
  ...["bf_emma", "bf_isabella", "bf_alice", "bf_lily", "bm_george", "bm_fable", "bm_lewis", "bm_daniel"].map((id) => kokoroVoice(id, "en-GB", "en-gb")),
  ...["ef_dora", "em_alex", "em_santa"].map((id) => kokoroVoice(id, "es", "es")),
  kokoroVoice("ff_siwis", "fr", "fr"),
  ...["hf_alpha", "hf_beta", "hm_omega", "hm_psi"].map((id) => kokoroVoice(id, "hi", "hi")),
  ...["if_sara", "im_nicola"].map((id) => kokoroVoice(id, "it", "it")),
  ...["pf_dora", "pm_alex", "pm_santa"].map((id) => kokoroVoice(id, "pt-BR", "pt-br")),
  // Farsi — NATIVE Iranian-Persian Piper voices (fa_IR, trained on Iranian speech).
  { engine: "neural", model: "piper", id: "fa_IR-amir-medium", name: "Amir", lang: "fa", espeak: "fa", gender: "male" },
  { engine: "neural", model: "piper", id: "fa_IR-gyro-medium", name: "Kian", lang: "fa", espeak: "fa", gender: "male" },
];

export const NEURAL_VOICES: TtsVoice[] = KOKORO_VOICES;

/** The picker's language groups, in display order. */
export const VOICE_GROUPS: { lang: string; label: string }[] = [
  { lang: "en-US", label: "American" },
  { lang: "en-GB", label: "British" },
  { lang: "es", label: "Español" },
  { lang: "fr", label: "Français" },
  { lang: "hi", label: "हिन्दी · Hindi" },
  { lang: "it", label: "Italiano" },
  { lang: "pt-BR", label: "Português (Brasil)" },
  { lang: "fa", label: "فارسی · Persian" },
];
export const voicesForModel = (m: TtsModelId): TtsVoice[] => NEURAL_VOICES.filter((v) => v.model === m);
export const modelOfVoice = (v: TtsVoice): TtsModelId => (v.model === "piper" ? "kokoro" : (v.model ?? "kokoro"));

/** Approx one-time download (MB) for a neural voice on this device — shown so the choice is informed. */
export function voiceDownloadMB(v: TtsVoice, profile: DeviceProfile | null): number {
  if (v?.model === "piper") return 61;
  if (profile?.webgpu) return TTS_MODELS.kokoro.approxMB("webgpu", profile.tier === "flagship" ? "fp32" : (profile.f16 ? "fp16" : "q8"));
  return TTS_MODELS.kokoro.approxMB("wasm", "q8f16");
}

// ---------------------------------------------------------------------------- device capability probe

const PROBE_KEY = "aq_tts_profile1";

export async function probeWebGPU(): Promise<{ ok: boolean; f16: boolean; big: boolean; discrete: boolean }> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter?: (o?: unknown) => Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu?.requestAdapter) return { ok: false, f16: false, big: false, discrete: false };
  try {
    const a: GpuAdapterLike | null = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!a || a.isFallbackAdapter) return { ok: false, f16: false, big: false, discrete: false }; // SwiftShader ⇒ no GPU
    const f16 = a.features?.has?.("shader-f16") === true;
    const L = a.limits || {};
    const big = (L.maxBufferSize || 0) > 268435456 && (L.maxStorageBufferBindingSize || 0) > 134217728;
    const vendor = (a.info?.vendor || "").toLowerCase();
    const discrete = /nvidia|amd|apple/.test(vendor);
    return { ok: true, f16, big, discrete };
  } catch { return { ok: false, f16: false, big: false, discrete: false }; }
}
type GpuAdapterLike = {
  isFallbackAdapter?: boolean;
  features?: { has?: (f: string) => boolean };
  limits?: { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
  info?: { vendor?: string };
};

/** Classify the device once → the default neural model + precision. Cached; the runtime RTF benchmark
 *  in loadNeural() is the safety net that demotes when this static guess is too optimistic. */
export async function probeTier(): Promise<DeviceProfile> {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean }; deviceMemory?: number };
  const mobile = nav.userAgentData?.mobile === true ||
    (matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 0);
  let reducedData = false;
  try { const q = matchMedia("(prefers-reduced-data: reduce)"); reducedData = q.media !== "not all" && q.matches; } catch { /* unsupported */ }
  const dm = nav.deviceMemory; // Chromium-only; undefined on FF/Safari — never hard-gate on it
  const cores = navigator.hardwareConcurrency || 2;
  const threads = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

  const g = await probeWebGPU();

  let tier: TtsTier;
  if (g.ok && g.big && g.discrete && (dm === undefined || dm >= 8) && cores >= 8 && !mobile) tier = "flagship";
  else if (g.ok && (dm !== undefined ? dm >= 8 : (!mobile && cores >= 8))) tier = "high";
  else if (g.ok && (dm !== undefined ? dm >= 4 : !mobile)) tier = "mid";
  else if (!g.ok && threads && cores >= 4 && (dm !== undefined ? dm >= 2 : !mobile)) tier = "low";
  else tier = "ultra-low";
  // Phones and data-saver run hot and RAM-pressured — one step down for sustained real-time.
  if ((mobile || reducedData) && tier !== "ultra-low") {
    tier = ({ flagship: "high", high: "mid", mid: "low", low: "ultra-low" } as const)[tier];
  }

  const map: Record<TtsTier, { device: "webgpu" | "wasm"; dtype: KokoroDtype; model: TtsModelId }> = {
    flagship: { device: "webgpu", dtype: "fp32", model: "kokoro" },
    high: { device: "webgpu", dtype: g.f16 ? "fp16" : "q8", model: "kokoro" },
    mid: { device: "webgpu", dtype: g.f16 ? "fp16" : "q8", model: "kokoro" }, // NEVER fp32 on a mobile GPU
    low: { device: "wasm", dtype: "q8f16", model: "kokoro" },
    "ultra-low": { device: "wasm", dtype: "q8", model: "kokoro" }, // slowest tier still gets the SOTA model (speeds gate playback)
  };
  const m = map[tier];
  const profile: DeviceProfile = {
    tier, device: m.device, dtype: m.dtype, model: m.model,
    webgpu: g.ok, f16: g.f16, mobile, reducedData, cores, deviceMemory: dm, threads,
  };
  try { localStorage.setItem(PROBE_KEY, JSON.stringify(profile)); } catch { /* */ }
  return profile;
}

/** The last probed profile (sync) if we have one cached — lets the UI render a sensible default label
 *  before the async probe resolves. */
export function cachedProfile(): DeviceProfile | null {
  try { return JSON.parse(localStorage.getItem(PROBE_KEY) || "null"); } catch { return null; }
}

// ---------------------------------------------------------------------------- paragraph segmentation

// Consecutive text pieces are grouped by nearest block ancestor so a heading never glues onto the
// paragraph after it. A block boundary between two same-key pieces also breaks the group (so a skipped
// block, or a wrapper not in the BLOCKS list, can't fuse two visually separate blocks).
const BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,th,dt,dd,pre,caption,summary,article,section,div";
type Piece = { node: Text; from: number; to: number; speak?: string; mathEl?: Element };
type Group = { key: Element | null; pieces: Piece[] };

// Never READ these even though they render: KaTeX's visual layer is aria-hidden (ancestor filter) but
// its MathML <annotation> carries raw LaTeX — spoken, that's noise. `sup` = citation/footnote markers
// ("[1]", "²⁴") — noise mid-sentence when listening. `.aq-no-tts` is the explicit page-level opt-out.
const SKIP_SEL = "script,style,noscript,textarea,select,[aria-hidden='true'],annotation,sup,.aq-no-tts";

// ------------------------------------------------------------------ equations → speech (KaTeX)

// Spoken forms for the common LaTeX vocabulary. "@arg" = speak the argument, "@skip" = swallow it.
const TEX_WORDS: Record<string, string> = {
  cdot: "times", times: "times", div: "divided by", pm: "plus or minus", mp: "minus or plus",
  le: "is less than or equal to", leq: "is less than or equal to", ge: "is greater than or equal to",
  geq: "is greater than or equal to", ne: "is not equal to", neq: "is not equal to",
  approx: "is approximately", sim: "is similar to", propto: "is proportional to", equiv: "is equivalent to",
  to: "goes to", rightarrow: "goes to", Rightarrow: "implies", leftarrow: "comes from", mapsto: "maps to",
  infty: "infinity", partial: "partial", nabla: "nabla", degree: "degrees", circ: "degrees",
  sum: "the sum of", prod: "the product of", int: "the integral of", oint: "the closed integral of",
  lim: "the limit of", min: "the minimum of", max: "the maximum of",
  sin: "sine", cos: "cosine", tan: "tangent", log: "log", ln: "natural log", exp: "the exponential of",
  cdots: "dots", dots: "dots", ldots: "dots", vdots: "dots",
  alpha: "alpha", beta: "beta", gamma: "gamma", delta: "delta", epsilon: "epsilon", varepsilon: "epsilon",
  zeta: "zeta", eta: "eta", theta: "theta", vartheta: "theta", iota: "iota", kappa: "kappa",
  lambda: "lambda", mu: "mu", nu: "nu", xi: "xi", pi: "pi", varpi: "pi", rho: "rho", sigma: "sigma",
  tau: "tau", upsilon: "upsilon", phi: "phi", varphi: "phi", chi: "chi", psi: "psi", omega: "omega",
  Gamma: "Gamma", Delta: "Delta", Theta: "Theta", Lambda: "Lambda", Xi: "Xi", Pi: "Pi", Sigma: "Sigma",
  Phi: "Phi", Psi: "Psi", Omega: "Omega", hbar: "h bar", ell: "l", Re: "the real part of", Im: "the imaginary part of",
  langle: "", rangle: "", left: "", right: "", quad: "", qquad: "", displaystyle: "", limits: "", nolimits: "",
  mathrm: "@arg", mathbf: "@arg", mathit: "@arg", mathcal: "@arg", mathbb: "@arg", mathsf: "@arg",
  boldsymbol: "@arg", vec: "@arg", hat: "@arg", bar: "@arg", tilde: "@arg", overline: "@arg",
  text: "@arg", textrm: "@arg", textit: "@arg", textbf: "@arg", operatorname: "@arg",
  label: "@skip", tag: "@skip", hspace: "@skip", vspace: "@skip", phantom: "@skip",
  ",": "", ";": "", ":": "", "!": "", " ": "", "\\": ", ",
};
const TEX_CHARS: Record<string, string> = {
  "=": "equals", "+": "plus", "-": "minus", "−": "minus", "<": "is less than", ">": "is greater than",
  "/": "over", "*": "times", "(": ",", ")": ",", "[": ",", "]": ",", ",": ",", "|": "", "&": "",
  "~": " ", "'": " prime", "%": " percent", "₳": "artacoins",
};

/** A LaTeX fragment → plain speakable English. Returns null when the maths is too exotic to speak
 *  honestly (the caller then says "equation" rather than reading noise — mis-spoken maths on a
 *  research platform is worse than silence). */
function texSpeech(src: string): { out: string; bad: number } {
  let i = 0, bad = 0;
  const parts: string[] = [];
  const atom = (): string => {
    while (i < src.length && src[i] === " ") i++;
    if (i >= src.length) return "";
    const c = src[i];
    if (c === "{") { // balanced group — spoken recursively
      let d = 1; const s0 = ++i;
      while (i < src.length && d > 0) { if (src[i] === "{") d++; else if (src[i] === "}") d--; i++; }
      const r = texSpeech(src.slice(s0, Math.max(s0, i - 1)));
      bad += r.bad; return r.out;
    }
    if (c === "\\") {
      let j = i + 1;
      if (j < src.length && /[a-zA-Z]/.test(src[j])) { while (j < src.length && /[a-zA-Z]/.test(src[j])) j++; }
      else j = Math.min(src.length, j + 1);
      const cmd = src.slice(i + 1, j); i = j;
      if (cmd === "frac") { const a = atom(); const b = atom(); return `${a} over ${b}`; }
      if (cmd === "sqrt") {
        if (src[i] === "[") { const e = src.indexOf("]", i); const idx = src.slice(i + 1, e < 0 ? i + 1 : e); i = (e < 0 ? i : e + 1); return `the ${texSpeech(idx).out} root of ${atom()}`; }
        return `the square root of ${atom()}`;
      }
      if (cmd in TEX_WORDS) {
        const w = TEX_WORDS[cmd];
        if (w === "@arg") return atom();
        if (w === "@skip") { atom(); return ""; }
        return w;
      }
      bad++; return cmd; // unknown macro: speak its name (\nabla-style fallback reads fine)
    }
    if (/[0-9]/.test(c)) { // a whole number (incl. decimals) is one spoken token: "3.14"
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const num = src.slice(i, j).replace(/\.$/, ""); i += num.length;
      return num;
    }
    i++;
    if (c in TEX_CHARS) return TEX_CHARS[c];
    if (c === "}") return ""; // stray close (unbalanced input) — ignore
    return c; // single letters are variables: "m", "c" …
  };
  while (i < src.length) {
    const before = i;
    let a = atom();
    // Big operators read their bounds as a range: \sum_{i=1}^{n} → "the sum from i equals 1 to n of".
    const big = /^the (sum|product|integral|closed integral|limit|minimum|maximum) of$/.test(a);
    let bigBound = false;
    while (i < src.length && (src[i] === "^" || src[i] === "_")) { // bind super/subscripts to their base
      const op = src[i]; i++;
      const b = atom();
      if (big) { a = `${bigBound ? a : a.replace(/ of$/, "")} ${op === "_" ? "from" : "to"} ${b}`; bigBound = true; }
      else if (op === "^") a = b === "2" ? `${a} squared` : b === "3" ? `${a} cubed` : `${a} to the power of ${b}`;
      else a = `${a} sub ${b}`;
    }
    if (bigBound) a += " of";
    if (a) parts.push(a);
    if (i === before) i++; // safety: always advance
  }
  return { out: parts.join(" ").replace(/\s+/g, " ").replace(/\s*,(\s*,)+/g, ",").replace(/^[\s,]+|[\s,]+$/g, ""), bad };
}

/** The spoken form of one rendered KaTeX equation (its `annotation` carries the source LaTeX). */
function mathSpeech(el: Element): string {
  const tex = el.querySelector("annotation")?.textContent?.trim();
  if (tex) {
    const r = texSpeech(tex);
    if (r.out && r.bad <= 4) return r.out;
  }
  return "equation";
}

/** Turn block-grouped text pieces into PARAGRAPH units (each with its Range + plain text) — one unit
 *  per leaf block (operator, 2026-07-21: sentence chopping mis-split real prose; the paragraph is the
 *  natural, always-correct boundary, and the band glides less often). Equation pieces contribute
 *  their SPOKEN form to the text (anchored zero-width in the DOM), and each unit's Range is widened
 *  to visually cover the rendered equations it contains, so the band lights them. */
function segmentGroups(groups: Group[]): Sentence[] {
  const out: Sentence[] = [];
  for (const g of groups) {
    let full = "";
    const spans: { node: Text; from: number; len: number; start: number; end: number; mathEl?: Element }[] = [];
    for (const pc of g.pieces) {
      const tx = pc.speak !== undefined ? pc.speak : pc.node.data.slice(pc.from, pc.to);
      spans.push({ node: pc.node, from: pc.from, len: pc.to - pc.from, start: full.length, end: full.length + tx.length, mathEl: pc.mathEl });
      full += tx;
    }
    if (!full.trim()) continue;
    const locate = (off: number) => {
      // Clamp into the anchor node: substituted (spoken-math) text is longer than its zero-width anchor.
      for (const s of spans) if (off >= s.start && off <= s.end) return { node: s.node, off: Math.min(s.node.length, s.from + Math.min(off - s.start, s.len)) };
      const l = spans[spans.length - 1];
      return { node: l.node, off: Math.min(l.node.length, l.from + l.len) };
    };
    let a = 0, b = full.length;
    while (a < b && /\s/.test(full[a])) a++;
    while (b > a && /\s/.test(full[b - 1])) b--;
    if (b - a < 2) continue;
    const A = locate(a), B = locate(b);
    const r = document.createRange();
    try { r.setStart(A.node, A.off); r.setEnd(B.node, B.off); } catch { continue; }
    // Widen the range over any rendered equations inside this paragraph (their MathML anchor is
    // visually zero-size — without this an equation-only block would give the band no box).
    for (const s of spans) {
      if (!s.mathEl || s.end <= a || s.start >= b) continue;
      try {
        const mr = document.createRange();
        mr.selectNode(s.mathEl);
        if (mr.compareBoundaryPoints(Range.START_TO_START, r) < 0) r.setStart(mr.startContainer, mr.startOffset);
        if (mr.compareBoundaryPoints(Range.END_TO_END, r) > 0) r.setEnd(mr.endContainer, mr.endOffset);
      } catch { /* detached math — the text anchor still stands */ }
    }
    // Collapse whitespace for SPEECH (newlines/indentation/math-padding read as awkward gaps);
    // the Range keeps the precise DOM span for the band.
    out.push({ text: full.slice(a, b).replace(/\s+/g, " ").trim(), range: r });
  }
  return out;
}

/** Is `el` a block-level element (rough, layout-based) — used to break groups across skipped blocks. */
function isBlockish(el: Element | null): boolean {
  if (!el) return false;
  if (el.matches(BLOCKS)) return true;
  try { return getComputedStyle(el).display?.includes("block") === true; } catch { return false; }
}

/** Collect text-node pieces under root that satisfy `accept`, grouped by block, breaking a group when a
 *  block boundary intervenes. Shared by the selection and whole-document entry points. */
function collectGroups(root: Element, accept: (t: Text) => { from: number; to: number } | null): Group[] {
  const groups: Group[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  let lastPieceEnd: Element | null = null; // deepest block of the previous accepted piece
  let lastMath: Element | null = null; // the `.katex` root already substituted (one spoken piece each)
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const p = t.parentElement;
    if (!p) continue;
    // A skipped subtree between two pieces breaks the group so blocks don't fuse across it.
    const skip = p.closest(SKIP_SEL);
    if (skip) { if (isBlockish(skip)) lastPieceEnd = null; continue; }
    const acc = accept(t);
    if (!acc) continue;
    const key = p.closest(BLOCKS);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key || lastPieceEnd === null) { g = { key, pieces: [] }; groups.push(g); }
    // A rendered equation reads as ONE spoken phrase ("E equals m c squared"), not a stream of MathML
    // glyphs. Its first text node anchors a zero-width piece carrying the spoken form; the rest of the
    // equation's nodes are consumed silently.
    const math = p.closest(".katex");
    if (math) {
      if (math !== lastMath) {
        lastMath = math;
        g.pieces.push({ node: t, from: acc.from, to: acc.from, speak: ` ${mathSpeech(math)} `, mathEl: math });
        lastPieceEnd = key;
      }
      continue;
    }
    lastMath = null;
    g.pieces.push({ node: t, from: acc.from, to: acc.to });
    lastPieceEnd = key;
  }
  return groups;
}

/** Split a live user selection into paragraph units, in reading order. */
export function sentencesFromRange(sel: Range): Sentence[] {
  const rootNode = sel.commonAncestorContainer;
  const rootEl = rootNode.nodeType === Node.ELEMENT_NODE ? (rootNode as Element) : rootNode.parentElement;
  if (!rootEl) return [];
  const groups = collectGroups(rootEl, (t) => {
    if (!sel.intersectsNode(t)) return null;
    let from = 0, to = t.length;
    if (t === sel.startContainer) from = Math.max(from, sel.startOffset);
    if (t === sel.endContainer) to = Math.min(to, sel.endOffset);
    return to > from ? { from, to } : null;
  });
  return segmentGroups(groups);
}

/** Split a WHOLE content root (an article/book body) into paragraph units, in order. */
export function sentencesFromRoot(root: HTMLElement): Sentence[] {
  const groups = collectGroups(root, (t) => (t.length ? { from: 0, to: t.length } : null));
  return segmentGroups(groups);
}

// ---------------------------------------------------------------------------- neural engines

/** Uniform neural engine interface — a model that turns text into a mono waveform. */
export type NeuralEngine = {
  generate: (text: string, voice: TtsVoice) => Promise<{ audio: Float32Array; sampleRate: number; toBlob: () => Blob }>;
};

// ---- multilingual G2P: the FULL espeak-ng WASM build (all languages, incl. Farsi) ----------------
// Staged at the app root by scripts/copy-espeak.mjs (~24 MB data, fetched ONCE and only when a
// non-English voice is first used; cache-first under the SW afterwards). convert_to_phonemes with a
// mode arg emits IPA with "_" phoneme separators — stripped, it is exactly the string Kokoro's
// tokenizer was trained on (verified: zero dropped tokens across es/fr/hi/it/pt-BR/fa).
type EspeakModule = { HEAPU8: Uint8Array; eSpeakNGWorker: new () => { set_voice: (v: string) => number; convert_to_phonemes: (t: string, mode: number) => { ptr: number } } };
let espeakP: Promise<(text: string, lang: string) => string> | null = null;
function espeakIpa(onProgress?: (p: NeuralProgress) => void): Promise<(text: string, lang: string) => string> {
  if (!espeakP) {
    espeakP = (async () => {
      onProgress?.({ pct: 0, status: "Downloading the language pack — ~24 MB, once…" });
      const base = import.meta.env.BASE_URL || "/";
      const mod = await import(/* @vite-ignore */ `${base}espeak-ng.js`);
      const m: EspeakModule = await mod.default({ locateFile: (f: string) => base + f });
      const w = new m.eSpeakNGWorker();
      let cur = "";
      const dec = new TextDecoder();
      return (text: string, lang: string) => {
        if (cur !== lang) { w.set_voice(lang); cur = lang; }
        const r = w.convert_to_phonemes(text, 1);
        const bytes: number[] = [];
        for (let i = r.ptr; m.HEAPU8[i]; i++) bytes.push(m.HEAPU8[i]);
        return dec.decode(new Uint8Array(bytes)).replace(/_+/g, "").replace(/ *\|+ */g, ", ").replace(/\s+/g, " ").trim();
      };
    })().catch((e) => { espeakP = null; throw e; });
  }
  return espeakP;
}

// ---- Piper VITS voices (native per-language; Farsi fa_IR) via onnxruntime-web -------------------
// Fetched once from rhasspy/piper-voices (CSP already allows the HF hosts) and kept in the Cache API.
// espeak IPA chars map straight onto the voice's phoneme_id_map (piper's own G2P IS espeak).
type PiperSession = { ids: (ipa: string) => number[]; run: (ids: number[]) => Promise<Float32Array>; sampleRate: number };
const piperCache = new Map<string, Promise<PiperSession>>();
async function cachedFetch(url: string, cacheName: string): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try { cache = await caches.open(cacheName); const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); } catch { /* */ }
  // Big files on weak links drop mid-fetch — retry twice with a short breath before giving up.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url.split("/").pop()}: HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      try { await cache?.put(url, new Response(buf)); } catch { /* */ }
      return buf;
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1200 * (attempt + 1))); }
  }
  throw lastErr;
}
function loadPiper(voiceId: string, onProgress?: (p: NeuralProgress) => void): Promise<PiperSession> {
  let p = piperCache.get(voiceId);
  if (!p) {
    p = (async () => {
      onProgress?.({ pct: 0, status: "Downloading the voice — ~61 MB, once…" });
      const [langFull] = voiceId.split("-");
      // Mirrored into the Kaggle dataset artafather/aq-tts-piper (operator 2026-08-02, the HF purge)
      // under the SAME lang/locale/voice/quality path the upstream repo uses, so this builder is
      // unchanged apart from its root. These are the Farsi voices, which have no Kokoro equivalent —
      // if this URL is wrong, فارسی read-aloud has nothing to fall back to.
      const { kaggleFile } = await import("./model-host"); // this file keeps every import dynamic
      const base = kaggleFile("aq-tts-piper", `${langFull.split("_")[0]}/${langFull}/${voiceId.split("-")[1]}/${voiceId.split("-")[2]}/${voiceId}`);
      const ort = await import("onnxruntime-web");
      ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/";
      const [cfgBuf, modelBuf] = await Promise.all([
        cachedFetch(`${base}.onnx.json`, "piper-voices"),
        cachedFetch(`${base}.onnx`, "piper-voices"),
      ]);
      const cfg = JSON.parse(new TextDecoder().decode(cfgBuf)) as { audio: { sample_rate: number }; phoneme_id_map: Record<string, number[]> };
      const sess = await ort.InferenceSession.create(modelBuf, { executionProviders: ["wasm"] });
      const map = cfg.phoneme_id_map;
      return {
        sampleRate: cfg.audio.sample_rate,
        ids: (ipa: string) => {
          const out = [map["^"]?.[0] ?? 1];
          for (const ch of ipa) if (map[ch]) out.push(0, map[ch][0]);
          out.push(0, map["$"]?.[0] ?? 2);
          return out;
        },
        run: async (ids: number[]) => {
          const feeds = {
            input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
            input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
            scales: new ort.Tensor("float32", Float32Array.from([0.667, 1.0, 0.8]), [3]),
          };
          const res = await sess.run(feeds);
          return res[sess.outputNames[0]].data as Float32Array;
        },
      };
    })().catch((e) => { piperCache.delete(voiceId); throw e; });
    piperCache.set(voiceId, p);
  }
  return p;
}

// The model hard-caps one generation at ~510 phoneme tokens — kokoro-js TRUNCATES silently past it,
// which read only the first half of long paragraphs. Chunk the paragraph at sentence-ish boundaries
// and stitch the waveforms into ONE clip (with a small breath between chunks).
const SYNTH_MAX = 300;
const CHUNK_GAP_S = 0.12;
function synthChunks(text: string): string[] {
  const out: string[] = [];
  // Bidi isolate marks (added around restored numbers for DISPLAY) must never reach a G2P engine.
  let rest = text.replace(/[\u2066-\u2069]/g, "").trim();
  while (rest.length > SYNTH_MAX) {
    const win = rest.slice(0, SYNTH_MAX);
    let cut = Math.max(win.lastIndexOf(". "), win.lastIndexOf("! "), win.lastIndexOf("? "),
      win.lastIndexOf("۔"), win.lastIndexOf("।"), win.lastIndexOf("; "), win.lastIndexOf(", "));
    if (cut < SYNTH_MAX * 0.33) cut = win.lastIndexOf(" ");
    if (cut < 1) cut = SYNTH_MAX - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

function pcmToWav(audio: Float32Array, sampleRate: number): Blob {
  const n = audio.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, audio[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([buf], { type: "audio/wav" });
}

// Kokoro via kokoro-js. Its types pin `voice` to a literal union; we accept any string id. The
// tokenizer + generate_from_ids are public — the multilingual path phonemizes with espeak-ng and
// drives them directly (generate_from_ids fetches ANY voice bin, no en-only validation).
type KokoroRaw = { audio: Float32Array; sampling_rate: number };
type KokoroLike = {
  generate: (text: string, opts: { voice: string; speed?: number }) => Promise<KokoroRaw>;
  tokenizer: (text: string) => { input_ids: { dims: number[] } };
  generate_from_ids: (ids: { dims: number[] }, opts: { voice: string; speed?: number }) => Promise<KokoroRaw>;
};

async function loadKokoro(dtype: KokoroDtype, device: "webgpu" | "wasm", onProgress?: (p: NeuralProgress) => void): Promise<NeuralEngine> {
  const mb = TTS_MODELS.kokoro.approxMB(device, dtype);
  const label = `Downloading the voice model — ~${mb} MB, once…`;
  onProgress?.({ pct: 0, status: label });
  const { KokoroTTS } = await import("kokoro-js");
  const tts = (await KokoroTTS.from_pretrained(TTS_MODELS.kokoro.repo, {
    dtype: dtype as "fp32" | "fp16" | "q8" | "q4f16",
    device,
    progress_callback: (p: unknown) => {
      const q = p as { status?: string; progress?: number; file?: string };
      if (q.status === "progress" && typeof q.progress === "number" && /onnx/.test(q.file || ""))
        onProgress?.({ pct: Math.round(q.progress), status: label });
    },
  })) as unknown as KokoroLike;
  return {
    generate: async (text, voice) => {
      const english = voice.espeak === "en-us" || voice.espeak === "en-gb";
      const ipa = english ? null : await espeakIpa(onProgress);
      const parts: Float32Array[] = [];
      let sr = 24000;
      for (const chunk of synthChunks(text)) {
        const r = english
          ? await tts.generate(chunk, { voice: voice.id })
          : await tts.generate_from_ids(tts.tokenizer(ipa!(chunk, voice.espeak)).input_ids, { voice: voice.id });
        parts.push(r.audio); sr = r.sampling_rate;
      }
      return stitch(parts, sr);
    },
  };
}

/** Stitch chunk waveforms into ONE clip with a small breath between them (they join at sentence bounds). */
function stitch(parts: Float32Array[], sr: number): { audio: Float32Array; sampleRate: number; toBlob: () => Blob } {
  const gap = Math.round(CHUNK_GAP_S * sr);
  const total = parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1);
  const audio = new Float32Array(total);
  let o = 0;
  for (let i = 0; i < parts.length; i++) { if (i) o += gap; audio.set(parts[i], o); o += parts[i].length; }
  return { audio, sampleRate: sr, toBlob: () => pcmToWav(audio, sr) };
}

/** THE synthesis entry: routes to the voice's engine, loading ONLY what that voice needs (a Piper
 *  voice never pulls the Kokoro model, and vice versa). Returns one stitched paragraph clip. */
export async function synthesize(
  text: string, voice: TtsVoice, profile: DeviceProfile, onProgress?: (p: NeuralProgress) => void,
): Promise<{ audio: Float32Array; sampleRate: number; toBlob: () => Blob }> {
  if (voice.model === "piper") {
    const [piper, ipa] = await Promise.all([loadPiper(voice.id, onProgress), espeakIpa(onProgress)]);
    const parts: Float32Array[] = [];
    for (const chunk of synthChunks(text)) parts.push(await piper.run(piper.ids(ipa(chunk, voice.espeak) + ".")));
    return stitch(parts, piper.sampleRate);
  }
  const { engine } = await loadNeural(modelOfVoice(voice), profile.dtype, profile.device, onProgress);
  return engine.generate(text, voice);
}

const BENCH_PREFIX = "aq_tts_bench2:";
const engineCache = new Map<string, Promise<{ engine: NeuralEngine; bench: Bench }>>();

/** Load the model (idempotent per dtype+device) and benchmark THIS device's real-time factor
 *  (cached). Benching always uses a fixed ENGLISH voice — RTF is language-independent, and this
 *  never forces the espeak language pack just to measure speed. */
export function loadNeural(
  model: TtsModelId, dtype: KokoroDtype, device: "webgpu" | "wasm",
  onProgress?: (p: NeuralProgress) => void,
): Promise<{ engine: NeuralEngine; bench: Bench }> {
  const key = `${model}:${dtype}:${device}`;
  let p = engineCache.get(key);
  if (!p) {
    p = (async () => {
      const engine = await loadKokoro(dtype, device, onProgress);
      let bench: Bench | null = null;
      try { const c = JSON.parse(localStorage.getItem(BENCH_PREFIX + key) || "null"); if (c && c.rtf > 0) bench = c; } catch { /* */ }
      if (!bench) {
        onProgress?.({ pct: 100, status: "Testing your device's speed…" });
        const benchVoice = NEURAL_VOICES[0];
        await engine.generate("Warming up.", benchVoice); // pay JIT/shader compile here
        const t0 = performance.now();
        const probe = await engine.generate("The quick brown fox jumps over the lazy dog beside the quiet river bank.", benchVoice);
        const dur = probe.audio.length / probe.sampleRate;
        bench = { rtf: (performance.now() - t0) / 1000 / Math.max(dur, 0.1), device, dtype, model };
        try { localStorage.setItem(BENCH_PREFIX + key, JSON.stringify(bench)); } catch { /* */ }
      }
      return { engine, bench };
    })().catch((e) => { engineCache.delete(key); throw e; });
    engineCache.set(key, p);
  }
  return p;
}

/** Speeds this device can sustain for the neural engine: while paragraph i plays (d ÷ rate s) the next
 *  (≈ same d) must finish synthesizing (rtf × d). Keep a margin for fixed overhead and length variance:
 *  s · rtf ≤ 0.75. Pre-synth of i+1 during i (in the hook) covers the rest. With no fallback engine,
 *  the slowest speed always stays offered — a slow device buffers between paragraphs, it never mutes. */
export function neuralSpeeds(rtf: number): number[] {
  const ok = SPEEDS.filter((s) => s * rtf <= 0.75);
  return ok.length ? ok : [SPEEDS[0]];
}
