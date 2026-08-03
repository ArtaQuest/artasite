/**
 * ASPECTS — a zodiac game whose outcomes are derived from CONTROL THEORY (phase-stability analysis).
 *
 * Each of the twelve signs is a PHASE on the wheel, θ_i = 2π·i/12 (0 = Aries … 11 = Pisces). When two
 * signs meet, their relationship is the STABILITY of the combined two-phase system, read off the phase
 * difference φ = θ_them − θ_you (their astrological *aspect*):
 *
 * Each meeting is READ OFF the STABILITY of the combined two-phase system, via two natural quantities of
 * φ: the trace τ = cos 2φ and determinant δ = 0.75 + cos 2φ of the phase Jacobian (proven three ways —
 * eigenvalues, ODE simulation, closed form — in rps12/control_complete.py). By the eigenvalue signature:
 *   • both real parts < 0 → the system settles  → WIN–WIN   (soft aspects: Sextile 60°, Trine 120°)
 *   • both real parts > 0 → the system diverges  → LOSE–LOSE (Conjunction 0°, Semisextile 30°, Quincunx 150°, Opposition 180°)
 *   • δ < 0 (a saddle)    → a CONTEST — true ONLY at the Square (90°); its winner is the forward/leading (ℓ = sin φ > 0) sign.
 * (At every aspect but the square the eigenvalues are a complex pair — a spiral — so the sign of the shared
 * real part τ/2 decides settle-vs-runaway; only the square has two real eigenvalues of opposite sign.)
 * The 12×12 grid splits into 48 WIN–WIN · 12 you-win · 12 you-lose · 72 LOSE–LOSE; symmetric; every sign equal.
 * Compatibility = "does our combination hold together?" — learning the wheel is learning which pairings
 * are stable, which are unstable, and which way the one contested aspect leans.
 */

export const N = 12;

export interface Sign {
  id: number; key: string; name: string; glyph: string;
  element: "Fire" | "Earth" | "Air" | "Water";
  modality: "Cardinal" | "Fixed" | "Mutable";
  polarity: "Active" | "Receptive";
}
const NAMES = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
const GLYPHS = ["♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"];
const ELEMENTS = ["Fire", "Earth", "Air", "Water"] as const;   // i % 4
const MODALITIES = ["Cardinal", "Fixed", "Mutable"] as const;  // i % 3
export const SIGNS: Sign[] = NAMES.map((name, i) => ({
  id: i, key: name.toLowerCase(), name, glyph: GLYPHS[i],
  element: ELEMENTS[i % 4], modality: MODALITIES[i % 3],
  polarity: i % 2 === 0 ? "Active" : "Receptive",
}));

// ── astrological aspect (the interface layer) ────────────────────────────────
export type AspectKey = "conjunction" | "semisextile" | "sextile" | "square" | "trine" | "quincunx" | "opposition";
export interface Aspect { key: AspectKey; name: string; angle: number; }
const ASPECT_BY_FOLD: Aspect[] = [
  { key: "conjunction", name: "Conjunction", angle: 0 },
  { key: "semisextile", name: "Semisextile", angle: 30 },
  { key: "sextile", name: "Sextile", angle: 60 },
  { key: "square", name: "Square", angle: 90 },
  { key: "trine", name: "Trine", angle: 120 },
  { key: "quincunx", name: "Quincunx", angle: 150 },
  { key: "opposition", name: "Opposition", angle: 180 },
];
const dir = (a: number, b: number): number => (((b - a) % N) + N) % N;   // directed offset 0..11
const fold = (d: number): number => Math.min(d, N - d);                  // 0..6
export const aspectOf = (a: number, b: number): Aspect => ASPECT_BY_FOLD[fold(dir(a, b))];

// ── control-theory outcome — TWO natural quantities of the phase difference φ (proven in
//    rps12/control_complete.py): the UNDIRECTED stability decides which aspect is a contest, and the
//    DIRECTED lead decides who wins it. ─────────────────────────────────────────
export type Outcome = "WW" | "WL" | "LW" | "LL";     // always from YOUR point of view

/** Stability determinant δ(φ) = 0.75 + cos 2φ of the two-phase Jacobian. δ<0 ⟺ a saddle ⟺ a CONTEST
 *  (true only at the Square, 90°); otherwise cos 2φ<0 → both stable (WW), cos 2φ>0 → both unstable (LL). */
export const stability = (a: number, b: number): number => 0.75 + Math.cos((4 * Math.PI * dir(a, b)) / N);
/** The directed lead ℓ(φ) = sin φ = Im(z̄_you·z_them). At a contest the phase-advanced (ℓ>0, forward,
 *  "applying") sign prevails; ℓ = 0 for the self-symmetric aspects (Conjunction, Opposition) — no winner. */
export const lead = (a: number, b: number): number => Math.sin((2 * Math.PI * dir(a, b)) / N);

/** How each ASPECT resolves — the one knob for the whole game. Self-symmetric aspects (Conjunction 0°,
 *  Opposition 180°) have no forward/backward, so they can ONLY be a tie: "WW" (both win) or "LL" (both
 *  lose). Only the directional aspects can be "competitive" (the forward/leading side wins).
 *  Current setting is PROVEN by the control-theory stability model in rps12/control_square.py (trace
 *  τ=cos2φ, det δ=0.75+cos2φ; outcome = eigenvalue signature): the flowing aspects (Sextile, Trine) have
 *  both eigenvalues negative → WIN-WIN; Conjunction, Semisextile, Quincunx and Opposition have both
 *  positive → LOSE-LOSE; and SQUARE (90°) is the UNIQUE saddle (δ<0 ⟺ cos2φ<−0.75, true only at 90°
 *  among the twelve aspects) → the sole competitive aspect, the only place two players actually contend. */
export type AspectResolution = "WW" | "LL" | "competitive";
//  by folded offset:  Conj  Semisxt  Sextile  Square       Trine  Quincunx  Opp
export const ASPECT_RESOLUTION: AspectResolution[] = ["LL", "LL", "WW", "competitive", "WW", "LL", "LL"];

const _code = new Uint8Array(N * N);   // 0 LL · 1 LW · 2 WL · 3 WW
for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
  const d = dir(a, b);
  const r = ASPECT_RESOLUTION[fold(d)];
  _code[a * N + b] = r === "WW" ? 3 : r === "LL" ? 0 : (d >= 1 && d <= 5) ? 2 /*forward → you win*/ : 1 /*backward → you lose*/;
}
const CODES: readonly Outcome[] = ["LL", "LW", "WL", "WW"];

/** Joint outcome (your bit, their bit) from your perspective. */
export const outcome = (you: number, them: number): Outcome => CODES[_code[you * N + them]];
/** [your win-bit, their win-bit]. */
export function bits(you: number, them: number): [0 | 1, 0 | 1] {
  const c = _code[you * N + them];
  return [((c >> 1) & 1) as 0 | 1, (c & 1) as 0 | 1];
}
/** True if this pairing is stable (a win-win / conjunction). */
export const isStable = (a: number, b: number): boolean => _code[a * N + b] === 3;
/** The full 12×12 outcome matrix. */
export const outcomeMatrix = (): Outcome[][] =>
  [...Array(N)].map((_, a) => [...Array(N)].map((__, b) => CODES[_code[a * N + b]]));

export const OUTCOME_LABEL: Record<Outcome, string> = {
  WW: "Harmony — both rise (sextile / trine)",
  WL: "You lead the square — you prevail",
  LW: "They lead the square — they prevail",
  LL: "Clash — both fall (conjunction / opposition / quincunx)",
};

/** Points to YOU. WIN-WINs pay both, graded so a TRINE is the top prize (sextile +2 · trine +3) — the
 *  incentive that teaches players their trines. LOSE-LOSEs cost both (−2), including the semisextile. The
 *  square is the one contest: the leader +2, the other −2. */
//  d = 0    1    2    3    4    5    6    7    8    9   10   11
//    conj sxt  sex+ sqr+ TRI+ qnx  opp  qnx  TRI- sqr- sex- sxt
const REWARD_BY_DIR = [-2, -2, 2, 2, 3, -2, -2, -2, 3, -2, 2, -2];
const _reward = new Int8Array(N * N);
for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) _reward[a * N + b] = REWARD_BY_DIR[dir(a, b)];
export const reward = (you: number, them: number): number => _reward[you * N + them];

/** Dev/test: outcome table matches ASPECT_RESOLUTION, the game is symmetric, and reward is consistent. */
export function verifyTables(): boolean {
  const mirror = (o: Outcome): Outcome => o === "WL" ? "LW" : o === "LW" ? "WL" : o;
  for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
    const d = dir(a, b);
    const r = ASPECT_RESOLUTION[fold(d)];
    const want: Outcome = r === "WW" ? "WW" : r === "LL" ? "LL" : (d >= 1 && d <= 5 ? "WL" : "LW");
    if (outcome(a, b) !== want) return false;
    if (outcome(b, a) !== mirror(outcome(a, b))) return false;              // symmetric game
    if (reward(a, b) + (want === "WL" || want === "LW" ? reward(b, a) : 0) !== (want === "WL" || want === "LW" ? 0 : reward(a, b))) return false; // squares are zero-sum
  }
  return true;
}

// ── the partner / opponent (solo v1) ──────────────────────────────────────────
export type Skill = "chill" | "sharp";
export interface Round { you: number; other: number; }
const _pred = new Float64Array(N);
const _score = new Int8Array(N * N);   // 2·yourWin − theirWin, for best-response
for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
  const [y, t] = [((_code[a * N + b] >> 1) & 1), (_code[a * N + b] & 1)];
  _score[a * N + b] = 2 * y - t;
}
/** The other player's throw. "chill" random; "sharp" predicts your next sign and best-responds. */
export function otherMove(history: readonly Round[], skill: Skill = "sharp"): number {
  const n = history.length;
  if (skill === "chill" || n < 2) return (Math.random() * N) | 0;
  _pred.fill(1);
  const last = history[n - 1].you;
  for (let i = 0; i < n; i++) { const y = history[i].you; _pred[y] += 1; if (i > 0 && history[i - 1].you === last) _pred[y] += 2; }
  let best = 0, bestScore = -Infinity;
  for (let A = 0; A < N; A++) { let s = 0; const base = A * N; for (let B = 0; B < N; B++) s += _pred[B] * _score[base + B]; if (s > bestScore) { bestScore = s; best = A; } }
  return best;
}
