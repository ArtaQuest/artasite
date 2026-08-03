/**
 * RPS-12 — a balanced, zero-sum twelve-sign rock-paper-scissors (the RPS-3 model, scaled to 12).
 *
 * Twelve signs on a wheel (indices 0..11). Rotationally symmetric: a sign BEATS the opponent iff the
 * forward offset d = (them − you) mod 12 is in {@link BEATS}. Exactly one winner per round (zero-sum),
 * with the classic Win / Lose / Tie result.
 *
 * Why the opposite ties: for an EVEN N you cannot have a tie-free balance (each sign would need to beat
 * 5½). The minimal-tie, maximally-decisive balance is `BEATS = {1,2,3,4,5}` — every sign **beats the
 * next 5, loses to the previous 5, and ties its polar opposite (+6) and itself**. Verified perfectly
 * balanced: each sign 5-beats / 5-loses / 2-ties; grid W 60 · L 60 · T 24; rotationally symmetric;
 * non-transitive; uniform play is the Nash equilibrium (see rps12/zerosum_verify.mjs).
 *
 * Performance: the beat relation and match scores are precomputed once at load into flat typed-array
 * tables (built from {@link BEATS}, so they can't drift — {@link verifyTables}). Every query is an
 * O(1), branchless, allocation-free read; the bot's inner loop touches only integer arrays.
 *
 * Sign identities (names, glyph, hand gesture) are DATA — see {@link Sign} — so the twelve real signs
 * plug in without touching the engine. The earlier non-zero-sum 2-D variant is preserved in
 * rps12/rps12_2d.ts.
 */

export const N = 12;

/** Forward offsets you beat. `{1,2,3,4,5}` = beat the next five (the RPS-3 cycle, scaled to 12).
 *  Single source of truth — change it (and re-run zerosum_verify.mjs) to retune. */
export const BEATS: readonly number[] = [1, 2, 3, 4, 5];

/** A match result, from YOUR point of view. */
export type Result = "W" | "L" | "T";

/** One of the twelve signs. Identity fields are placeholders until the real list is supplied. */
export interface Sign {
  id: number;          // 0..11, its position on the wheel
  key: string;         // stable slug, e.g. "aries" — used for i18n + assets
  name: string;        // display name (English source; the i18n mesh localises it)
  glyph?: string;      // optional vector/emoji marker
  gesture?: string;    // key of the hand-pose to render
}

// ── precomputed tables (built once from the canonical relation) ──────────────────────────────────
const _beatByOffset = /* @__PURE__ */ (() => {
  const t = new Uint8Array(N);                 // t[d] = 1 if you beat an opponent d ahead
  for (const d of BEATS) { const dd = ((d % N) + N) % N; if (dd !== 0) t[dd] = 1; }
  return t;
})();
const _beat = new Uint8Array(N * N);           // _beat[a*N+b] = beats(a,b)  (0 on the diagonal)
const _score = new Int8Array(N * N);           // beats(a,b) − beats(b,a)  ∈ {−1,0,1}  (+1 W · −1 L · 0 T)
for (let a = 0; a < N; a++) {
  for (let b = 0; b < N; b++) _beat[a * N + b] = a === b ? 0 : _beatByOffset[(b - a + N) % N];
}
for (let a = 0; a < N; a++) {
  for (let b = 0; b < N; b++) _score[a * N + b] = _beat[a * N + b] - _beat[b * N + a];
}
const _relByOffset: readonly ("win" | "lose" | "tie")[] = /* @__PURE__ */ (() => {
  const r: ("win" | "lose" | "tie")[] = [];
  for (let d = 0; d < N; d++) r.push(_beatByOffset[d] ? "win" : _beatByOffset[(N - d) % N] ? "lose" : "tie");
  return r;
})();

// ── public queries (all O(1) table reads) ────────────────────────────────────────────────────────
/** Forward offset from a to b on the wheel (0..N-1). */
export const offset = (a: number, b: number): number => (((b - a) % N) + N) % N;

/** Does sign `a` beat sign `b`? (false for a === b) */
export const beats = (a: number, b: number): boolean => _beat[a * N + b] === 1;

/** Signed score from your perspective: +1 win · −1 loss · 0 tie. The fast path for tight loops. */
export const score = (you: number, them: number): number => _score[you * N + them];

/** The match result from your perspective. */
export const result = (you: number, them: number): Result => {
  const s = _score[you * N + them];
  return s > 0 ? "W" : s < 0 ? "L" : "T";
};

/** Human-readable label for a result. */
export const RESULT_LABEL: Record<Result, string> = { W: "You win", L: "You lose", T: "Standoff" };

/** How a given forward offset resolves (for the wheel legend / teaching). */
export const relationAt = (d: number): "win" | "lose" | "tie" => _relByOffset[(((d % N) + N) % N)];

/** The full 12×12 result matrix (rows = your sign, cols = theirs) — for visualisation/tests. */
export function matrix(): Result[][] {
  const m: Result[][] = [];
  for (let a = 0; a < N; a++) {
    const row: Result[] = [];
    for (let b = 0; b < N; b++) { const s = _score[a * N + b]; row.push(s > 0 ? "W" : s < 0 ? "L" : "T"); }
    m.push(row);
  }
  return m;
}

/** Dev/test hook: rebuild from the offset formula and assert the fast tables match — proof the
 *  precomputation never drifts from the proven relation. Returns true if identical. */
export function verifyTables(): boolean {
  const S = new Set(BEATS.map(d => (((d % N) + N) % N)));
  for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
    const beat = a !== b && S.has((b - a + N) % N);
    if ((_beat[a * N + b] === 1) !== beat) return false;
    const lose = a !== b && S.has((a - b + N) % N);
    if (_score[a * N + b] !== ((beat ? 1 : 0) - (lose ? 1 : 0))) return false;
  }
  return true;
}

// ── the bot (solo v1) ─────────────────────────────────────────────────────────
export type Skill = "chill" | "sharp";
export interface Round { you: number; bot: number; }

const _pred = new Float64Array(N); // reusable scratch — JS is single-threaded and botMove is never re-entrant

/**
 * Choose the bot's throw. "chill" is uniform random. "sharp" predicts your next sign from your
 * history (one pass: overall frequency + a first-order transition weighting from your last throw),
 * then best-responds via the precomputed score table (maximise expected score). It never sees your
 * current throw (moves are simultaneous), so it only exploits your revealed tendencies.
 */
export function botMove(history: readonly Round[], skill: Skill = "sharp"): number {
  const n = history.length;
  if (skill === "chill" || n < 3) return (Math.random() * N) | 0;

  _pred.fill(1); // Laplace prior; argmax is scale-invariant so no normalisation needed
  const last = history[n - 1].you;
  for (let i = 0; i < n; i++) {
    const y = history[i].you;
    _pred[y] += 1;                                          // frequency
    if (i > 0 && history[i - 1].you === last) _pred[y] += 2; // what you throw after `last`
  }

  let best = 0, bestScore = -Infinity;
  for (let A = 0; A < N; A++) {
    const base = A * N;
    let s = 0;
    for (let B = 0; B < N; B++) s += _pred[B] * _score[base + B];
    if (s > bestScore) { bestScore = s; best = A; }
  }
  return best;
}

/** Placeholder signs (real names/glyphs/gestures supplied later). */
export const PLACEHOLDER_SIGNS: Sign[] = [...Array(N)].map((_, i) => ({
  id: i,
  key: `sign-${i + 1}`,
  name: `Sign ${i + 1}`,
}));
