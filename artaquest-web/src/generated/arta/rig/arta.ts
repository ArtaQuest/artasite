/* GENERATED — DO NOT EDIT HERE.
 * Vendored from artalife src/rig/arta.ts @ e37c551.
 * Source of truth: https://github.com/ArtaQuest/artalife.git
 * Re-run: node tools/arta-sync.mjs
 */
/**
 * ARTA — the rig and the brain. No React, no DOM, no timers: pure functions and
 * one small state machine, so the same character drives the landing page, a
 * sign-up flow, an empty state, and later a game loop.
 *
 * It is deliberately the SAME rig as work 9319 ("Undefined"), the published
 * scene: identical proportions, identical joint convention, identical cadence
 * rules. The film is Arta acting; this is Arta improvising. If the two ever
 * diverge we have two mascots, which is none.
 *
 * WHO ARTA IS
 *   A stick figure with no face. That is a constraint, not an omission — with no
 *   expression to lean on, everything has to be said with posture and timing,
 *   which is why this file is mostly about weight and delay rather than shapes.
 *   Sagittarius: curious, truth-seeking, adventurous. The archer, so the
 *   signature gesture is AIMING — Arta points at the thing that matters. That
 *   gives the mascot a job (it directs attention) instead of a decoration.
 *
 * THE THREE LAWS, which keep a companion from becoming Clippy
 *   1. Arta never blocks. It does not cover content, never opens a modal, never
 *      demands a dismissal.
 *   2. Arta reacts, it does not interrupt. It answers what you do; it does not
 *      start conversations.
 *   3. Arta goes still when you are working. Typing, reading, scrolling fast —
 *      it settles. Presence is not the same as motion.
 *
 * CADENCE — smooth, deliberately UNLIKE the film
 *   The published scene holds each drawing for two frames, which is the
 *   hand-drawn cadence. Here the brief is the opposite: as smooth as the display
 *   can manage. So the sim is integrated at the real frame interval and every
 *   frame is painted — 60 Hz on a normal panel, 120 on a ProMotion one, with no
 *   fixed internal rate to beat against the refresh and no held drawings.
 *
 *   Everything that moves is therefore expressed as a RATE PER SECOND and
 *   integrated with dt, never as a per-tick delta. Exponential smoothing
 *   (1 - e^(-k·dt)) is used for every ease because it is frame-rate independent:
 *   the same motion at 60 and at 144, and correct again after a stall.
 */

// ── geometry: identical to the published scene ──────────────────────────────
/**
 * The figure's proportions. Everything that can be DERIVED from them is, so a
 * different figure stays internally consistent without anyone re-doing the
 * arithmetic — and so the numbers cannot drift apart, which is the fault this
 * file has spent most of its life fixing in one form or another.
 *
 * `HIP` was 104, which is THIGH + SHIN — a straight leg. The standing pose has
 * a slight knee, so its soles are 103.6 below the hip, and the two numbers
 * disagreed by 0.4 for every pose placed against the ground. `footDrop(stand())`
 * is the only honest answer to "how high is the hip when standing", so it is
 * the definition now rather than a constant that happens to be near it.
 */
const LIMB = { SPINE: 70, NECK: 24, HEAD_R: 20, THIGH: 52, SHIN: 52, UARM: 34, LARM: 32 } as const;

/** The resting leg, [hip, knee]. Written ONCE: the default pose is built from
 *  it and the standing hip height is solved from it, so the stance and the
 *  height it implies cannot come apart. */
const STANCE: readonly [number, number] = [7, -8];

const legReach = (a1: number, a2: number) =>
  LIMB.THIGH * Math.cos((a1 * Math.PI) / 180) + LIMB.SHIN * Math.cos(((a1 + a2) * Math.PI) / 180);

export const RIG = {
  ...LIMB,
  /** hip height above the ground when standing — SOLVED from the stance */
  HIP: legReach(STANCE[0], STANCE[1]),
  /** crown to sole — derived, so it cannot disagree with the parts */
  get HEIGHT() { return this.HIP + LIMB.SPINE + LIMB.NECK + LIMB.HEAD_R; },
} as const;

export type XY = { x: number; y: number };

/**
 * Which way Arta faces, as a CONTINUOUS value in [-1, 1] rather than a pair of
 * states. Turning is implemented by negating every joint angle, so a boolean
 * flip moves a foot ~43 CSS px in a single frame — by a wide margin the largest
 * gradient in the whole system, and one no amount of blending can soften
 * because it is discrete. Easing the multiplier through zero instead gives a
 * real turn: the figure narrows to its own profile, passes through edge-on, and
 * opens out the other way, which is what a 2D character does when it turns.
 */
export type Face = number;

/**
 * Joint angles in degrees. 0 is straight down, positive rotates toward +x.
 * `face = -1` mirrors the whole figure by negating every angle — the only thing
 * a faceless character needs in order to turn round.
 */
export type Pose = {
  x: number;          // hip, world
  y: number;          // hip, world (ground - HIP when standing)
  lean: number;
  tilt: number;
  face: Face;
  la: [number, number];   // left arm  [shoulder, elbow]
  ra: [number, number];   // right arm
  ll: [number, number];   // left leg  [hip, knee]
  rl: [number, number];   // right leg
  sq: number;         // leg scale — a crouch shortens the stance
  bre: number;        // spine scale — the breath, which must NOT lift the feet
};

/**
 * SAFE MOTION — the hard ceiling on how fast anything may move.
 *
 * Two limits, because they bind at different frame rates and both matter:
 *
 *   MAX_PX_PER_FRAME guards against STROBING. An un-blurred line that travels
 *   much more than about twice its own stroke width between frames stops
 *   reading as movement and starts reading as a sequence of separate positions.
 *   This is the limit that binds when the frame rate is low.
 *
 *   MAX_PX_PER_SEC guards against being too fast to follow at all, which is the
 *   comfort and vestibular concern rather than the legibility one. This is the
 *   limit that binds at 120 Hz, where a per-frame budget alone would permit
 *   twice the real-world speed.
 *
 * The effective budget each frame is min(MAX_PX_PER_SEC · dt, MAX_PX_PER_FRAME),
 * measured in CSS pixels on the drawn point that moved furthest — so it covers
 * root motion, limb swing and turning together, and cannot be defeated by
 * adding a new gesture.
 */
export const SAFE = {
  MAX_PX_PER_FRAME: 12,
  MAX_PX_PER_SEC: 640,
  /** Nothing may oscillate in opacity or visibility faster than this. WCAG 2.3.1
   *  draws the seizure line at 3 Hz; the platform's calm rule is stricter, and
   *  a mascot has no reason to go near either. */
  MAX_FLASH_HZ: 2,
} as const;

const P = (o: Partial<Pose> = {}): Pose => ({
  x: 0, y: 0, lean: 0, tilt: 0, face: 1,
  la: [14, 15], ra: [-14, -15],
  ll: [STANCE[0], STANCE[1]], rl: [-STANCE[0], STANCE[1]], sq: 1, bre: 1, ...o,
});

const rad = (d: number) => (d * Math.PI) / 180;
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const ease = (u: number) => u * u * (3 - 2 * u);

/** Resting breath, in Hz. The one genuinely periodic thing Arta does. */
const BREATH = 0.42;

function limb(rx: number, ry: number, a1: number, a2: number, l1: number, l2: number) {
  const r1 = rad(a1);
  const jx = rx + l1 * Math.sin(r1), jy = ry + l1 * Math.cos(r1);
  const r2 = rad(a1 + a2);
  return { jx, jy, ex: jx + l2 * Math.sin(r2), ey: jy + l2 * Math.cos(r2) };
}

export type Skeleton = {
  torso: string; armL: string; legL: string; armR: string; legR: string;
  head: { cx: number; cy: number; r: number };
  /** where the pointing hand ended up, in world coords — the arrow starts here */
  hand: XY;
};

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();
const seg = (a: number, b: number, c: number, d: number, e?: number, f?: number) =>
  e === undefined ? `M${n1(a)} ${n1(b)}L${n1(c)} ${n1(d)}`
                  : `M${n1(a)} ${n1(b)}L${n1(c)} ${n1(d)}L${n1(e)} ${n1(f!)}`;

/** Resolve a pose into drawable geometry, in WORLD coordinates. */
export function skeleton(p: Pose): Skeleton {
  const f = p.face;
  const hx = p.x, hy = p.y;
  const ln = rad(p.lean * f);
  const nx = hx + RIG.SPINE * p.bre * Math.sin(ln);
  const ny = hy - RIG.SPINE * p.bre * Math.cos(ln) * p.sq;
  const hr = rad((p.lean + p.tilt) * f);
  const a0 = limb(nx, ny, p.la[0] * f, p.la[1] * f, RIG.UARM, RIG.LARM);
  const a1 = limb(nx, ny, p.ra[0] * f, p.ra[1] * f, RIG.UARM, RIG.LARM);
  const l0 = limb(hx, hy, p.ll[0] * f, p.ll[1] * f, RIG.THIGH * p.sq, RIG.SHIN * p.sq);
  const l1 = limb(hx, hy, p.rl[0] * f, p.rl[1] * f, RIG.THIGH * p.sq, RIG.SHIN * p.sq);
  return {
    torso: seg(hx, hy, nx, ny),
    armL: seg(nx, ny, a0.jx, a0.jy, a0.ex, a0.ey),
    legL: seg(hx, hy, l0.jx, l0.jy, l0.ex, l0.ey),
    armR: seg(nx, ny, a1.jx, a1.jy, a1.ex, a1.ey),
    legR: seg(hx, hy, l1.jx, l1.jy, l1.ex, l1.ey),
    head: { cx: nx + RIG.NECK * Math.sin(hr), cy: ny - RIG.NECK * Math.cos(hr), r: RIG.HEAD_R },
    hand: { x: a1.ex, y: a1.ey },
  };
}

// ── the pose library ────────────────────────────────────────────────────────
// Every entry is a still. Motion comes from the brain blending between them, so
// a new gesture is one function here and one line in the state machine.

export const stand = (): Pose => P();

/**
 * Author a pose whose SOLES sit on the support line: `y` becomes the offset
 * from the support, the same convention `walk` already returns.
 *
 * Every `y:` in the library was a hand-tuned constant, and not one of them was
 * solved against the sole line — `peer` sat 5.2 units through the ledge,
 * `rest` 4.5, `shrug` 2.5, `think` 2.3, and `fall` floated 3.1 above it. Those
 * are small, but the sign matters far more than the size: a sole below the
 * support means `floorUnder` reads the ledge as being ABOVE the feet, discards
 * it, and drops Arta through the floor it is standing on.
 */
const grounded = (p: Pose): Pose => ({ ...p, y: RIG.HIP - footDrop(p) });

/**
 * How far the lower foot hangs below the hip in this pose.
 *
 * Placing the hip at `surface - footDrop(pose)` is the definition of standing
 * on something, and it holds for any pose — which is the point. Every act that
 * plants Arta should use it rather than carrying its own hand-tuned offset,
 * because a hand-tuned offset is only right for the pose it was tuned against.
 */
export function footDrop(p: Pose): number {
  const l = limb(0, 0, p.ll[0] * p.face, p.ll[1] * p.face, RIG.THIGH * p.sq, RIG.SHIN * p.sq);
  const r = limb(0, 0, p.rl[0] * p.face, p.rl[1] * p.face, RIG.THIGH * p.sq, RIG.SHIN * p.sq);
  return Math.max(l.ey, r.ey);
}

/**
 * Two-link IK. `tx`/`ty` are hip-relative (x right, y DOWN, matching the rig's
 * world). Returns the [thigh, shin] angle pair in the pose convention.
 *
 * There are two solutions; this one puts the knee forward of the hip→foot line,
 * which is the way a human knee bends and the way the rest of the library is
 * posed (`stand` is `[7, -8]`, a knee already leading slightly).
 */
function legIK(tx: number, ty: number): [number, number] {
  const d = Math.min(Math.hypot(tx, ty), RIG.THIGH + RIG.SHIN - 0.5);
  const knee = Math.acos(clamp(
    (RIG.THIGH * RIG.THIGH + RIG.SHIN * RIG.SHIN - d * d) / (2 * RIG.THIGH * RIG.SHIN), -1, 1));
  const lead = Math.acos(clamp(
    (d * d + RIG.THIGH * RIG.THIGH - RIG.SHIN * RIG.SHIN) / (2 * d * RIG.THIGH), -1, 1));
  return [(Math.atan2(tx, ty) + lead) * 180 / Math.PI, knee * 180 / Math.PI - 180];
}

/**
 * The gait. These four numbers are the whole walk, and the brain must advance
 * the phase at `CYCLE` px per cycle or the feet skate again — so it reads
 * `WALK.CYCLE` rather than carrying its own copy of the number.
 */
export const WALK = {
  /** px the root advances per full cycle (two steps) */
  CYCLE: 150,
  /** fraction of the cycle each foot is planted. Above 0.5 by design: the
   *  overlap is the double-support phase, and double support is the entire
   *  difference between a walk and a run. */
  STANCE: 0.54,
  /** hip→foot reach held CONSTANT through stance, so the hip rides a circular
   *  arc over the planted foot — the compass gait, and the reason the knee does
   *  not pop mid-stance. Short of the 104 straight-leg limit, because a locked
   *  knee reads as a stilt. */
  REACH: 103,
  /** swing-foot ground clearance */
  LIFT: 16,
  /**
   * Midstance leg shortening — the third determinant of gait, and the reason
   * the stride could grow without the bob growing with it.
   *
   * Hip bob here is DERIVED, not authored: the compass gait puts the hip on a
   * circular arc over the planted foot, so lengthening the stride raises the
   * arc. At CYCLE 110 the bob was 4.4 units, about 4% of leg length, which is
   * what a person does. At 150 the same geometry gives 8.3 — nearly a tenth of
   * the leg, a caricature bounce. Real knees flex through midstance and flatten
   * exactly that arc, which is what this term is.
   *
   * 3.5 costs about 18 degrees of extra knee flexion at midstance and brings
   * the bob back to 4.8. 5.5 would be 25 degrees and reads as a crouch-walk.
   */
  DIP: 3.5,
  /**
   * How fast the quickest drawn point moves, as a multiple of the root speed.
   * Measured off this gait, not guessed: the knee just after toe-off, at 3.6x,
   * rounded up for margin. Everything in the cycle scales linearly with the
   * root speed, so one number converts a frame's pixel budget into a walking
   * speed that FITS it.
   */
  PEAK_RATIO: 3.8,
} as const;

/** Where one foot is at leg-phase `p`: ground-space x relative to the root, and
 *  its height above the ground. Phase 0 is heel strike. */
function foot(p: number) {
  const run = WALK.STANCE * WALK.CYCLE;        // root travel while this foot is down
  if (p < WALK.STANCE) {
    // Planted. In the world the foot does not move at all, so relative to the
    // advancing root it slides straight back at exactly the root's speed. That
    // identity is the whole point: it is what makes the contact real.
    return { dx: run * (0.5 - p / WALK.STANCE), lift: 0 };
  }
  /*
   * The swing, shaped so the foot does not change velocity in a single frame.
   *
   * Straight-line-and-sine was the obvious version and it whipped the knee at
   * 810 px/s just after toe-off — over the 640 px/s ceiling, and the fastest
   * thing in the whole rig by a factor of 1.6. Two abrupt starts caused it: the
   * foot's horizontal velocity reversed instantly from -root to +246 px/s, and
   * `sin(pi*u)` has its steepest lift at exactly u = 0.
   *
   * So the lift is `sin^2`, flat at both ends, and the horizontal path is a
   * cubic Hermite whose end slopes MATCH the stance velocity: the foot is still
   * travelling backwards as it leaves the ground and again as it lands, which
   * is both what a real foot does and the only way the join is C1. The small
   * overshoot past the strike point that this produces is real gait too — the
   * swing foot reaches furthest forward just before it comes down.
   */
  const u = (p - WALK.STANCE) / (1 - WALK.STANCE);
  const m = -(1 - WALK.STANCE) / WALK.STANCE;         // stance slope, in swing-u terms
  const g = m * (2 * u ** 3 - 3 * u ** 2 + u) + (3 * u ** 2 - 2 * u ** 3);
  return { dx: run * (g - 0.5), lift: WALK.LIFT * Math.sin(Math.PI * u) ** 2 };
}

/**
 * A walk with the feet actually on the ground.
 *
 * The previous version swung both legs as sinusoids in antiphase and let the
 * root advance at a constant speed. Nothing tied those two together, and they
 * disagreed: through what should have been the left leg's stance, the foot slid
 * ~47 px forward and ~19 px back across the ground. Every foot was always
 * sliding, which is why the figure read as gliding rather than walking — the
 * single most common tell of an amateur walk cycle, and it had been there from
 * the start because joint angles are the easy thing to animate and contact is
 * the thing that matters.
 *
 * So the foot path is authored and the joints are SOLVED. Measured planted-foot
 * drift went from 40.9 px per stance to 0.00.
 */
export const walk = (ph: number): Pose => {
  const l = foot(ph % 1), r = foot((ph + 0.5) % 1);
  /*
   * How high the hip can ride: each foot says `h <= lift + sqrt(REACH^2 - dx^2)`,
   * and the lower answer wins.
   *
   * The lift term is what makes this continuous, and continuity is not a detail
   * here. The first version took the minimum over the feet that were currently
   * DOWN — a set that changes membership at every double-support boundary, so
   * `h` stepped 1.3 px at those four instants per cycle. Near full extension a
   * knee is worth about 6 degrees per pixel of reach, so that step threw the
   * knee 3.6 px sideways in a single frame: a visible pop, four times a cycle,
   * from a discontinuity introduced purely by the shape of the code.
   *
   * A raised foot relaxes its own constraint by exactly the height it is raised,
   * so no set membership is needed and nothing steps. The swing foot's lift
   * returns to zero as it lands, which is precisely when its constraint has to
   * start binding again.
   */
  const half = (WALK.STANCE * WALK.CYCLE) / 2;
  const cap = (f: { dx: number; lift: number }) =>
    f.lift + Math.sqrt(Math.max(1, WALK.REACH ** 2 - f.dx * f.dx))
    // flatten the compass arc through midstance, where the leg is most upright
    - WALK.DIP * Math.max(0, 1 - (f.dx / half) ** 2);
  const h = Math.min(cap(l), cap(r));
  // Arms oppose legs — the left arm swings with the RIGHT leg. Smooth rather
  // than tracking dx, which is piecewise linear and would read as mechanical.
  const s = 20 * Math.cos(2 * Math.PI * ph);
  return P({
    y: RIG.HIP - h, lean: 7,
    la: [-s, 14], ra: [s, 14],
    ll: legIK(l.dx, h - l.lift),
    rl: legIK(r.dx, h - r.lift),
  });
};

/**
 * The signature. `deg` is the ABSOLUTE aim angle: 0 down, 90 toward +x.
 *
 * The elbow bends only when it has to. Perpendicular distance from the head's
 * centre to an arm leaving the neck is 24·sin(θ), which DECREASES as the arm
 * rises — so a straight arm aimed near vertical is drawn through the skull, and
 * no shoulder angle above ~116° clears a r20 head sitting 24 above the neck.
 * (This never showed on desktop, where the target is always off to one side. On
 * a phone the call to action sits directly above Arta and the arm went straight
 * through its head.)
 *
 * So: hold the shoulder outside the head's disc and put the remainder in the
 * elbow. The FOREARM still aims at exactly `deg`, and the forearm is the part
 * that reads as pointing.
 */
const SHOULDER_MAX = 116;
export const point = (deg: number, f: Face): Pose => {
  const shoulder = clamp(deg, -SHOULDER_MAX, SHOULDER_MAX);
  return P({
    lean: 4, tilt: -6,
    la: [18, 14],
    ra: [shoulder * f, (deg - shoulder) * f],
    ll: [10, -8], rl: [-12, -8],
  });
};

/**
 * The shoulder is held OUT at 118° rather than up at 152°, and the rocking is
 * all in the elbow. The upper arm is 34 long and the head sits 24 above the
 * neck with a radius of 20, so a raised-straight-up wave draws the forearm
 * straight through the skull. Out-and-then-up clears it by ~31.
 */
export const wave = (ph: number): Pose => P({
  lean: -3, tilt: -4,
  la: [16, 12],
  ra: [118, 46 + 20 * Math.sin(2 * Math.PI * ph)],
  ll: [6, -6], rl: [-8, -6],
});

export const cheer = (): Pose => P({
  y: -85, tilt: -6,
  la: [146, 10], ra: [-146, -10], ll: [26, -46], rl: [-24, -44],
});

/**
 * The absorb, and the anticipation before a jump.
 *
 * `y` and the knee bend have to AGREE. A crouch lowers the hip by exactly as
 * much as it shortens the legs, or the feet go somewhere the body is not: at
 * y 26 with the old [26, -62] knee the legs only shortened by 15, so the feet
 * finished 11 px UNDER the surface. `floorUnder` then read that ledge as being
 * above the feet, discarded it, found nothing else, and Arta fell through the
 * floor it had just landed on — every rope trip, for as long as this existed.
 */
export const crouch = (): Pose => grounded(P({
  lean: 14, tilt: 6,
  la: [-34, 8], ra: [-40, 6], ll: [26, -80], rl: [-22, -58],
}));

/** Weight on one leg, a hand up near the head. Thinking, without a face to do it with. */
export const think = (): Pose => grounded(P({
  y: 4, lean: -6, tilt: 8,
  la: [22, 16], ra: [-132, -52], ll: [14, -10], rl: [-20, -30],
}));

/** Leaning in to read something — the truth-seeker's default posture. */
export const peer = (): Pose => grounded(P({
  y: 10, lean: 30, tilt: 10,
  la: [40, 60], ra: [48, 56], ll: [24, -30], rl: [-22, -28],
}));

export const shrug = (): Pose => grounded(P({
  y: 3, tilt: 4,
  la: [64, -78], ra: [-66, 76], ll: [8, -8], rl: [-10, -8],
}));

/** Sitting. Arta rests when nothing has happened for a long time. */
/**
 * Winding up to throw the line. `k` runs 0 (cocked) to 1 (released), so the
 * whole action is one pose function rather than three.
 */
export const throwRope = (k: number): Pose => P({
  y: 4 - 6 * k, lean: -18 + 34 * k, tilt: -10 + 14 * k,
  la: [24 - 10 * k, 14],
  ra: [-150 + 250 * k, -20 + 20 * k],
  ll: [-14 + 30 * k, -12], rl: [18 - 30 * k, -16],
});

/**
 * Hanging from the line, mid-travel. `sway` in [-1, 1] is the pendulum phase —
 * the legs trail behind the direction of travel, which is what sells weight on
 * a rope; a figure hanging perfectly straight reads as pasted on.
 */
export const hang = (sway: number): Pose => P({
  lean: -6 * sway, tilt: -4 * sway,
  la: [168, 6], ra: [172, -6],
  ll: [26 * sway - 8, -34], rl: [26 * sway + 10, -22],
});

export const rest = (): Pose => grounded(P({
  y: 46, lean: -8, tilt: 4,
  la: [56, 66], ra: [-52, -70], ll: [74, -96], rl: [66, -104],
}));

/**
 * Every drawn joint, world coords, flat — what the speed limit is measured on.
 *
 * Straight forward kinematics into a reusable array: no path strings, no regex,
 * no allocation. The first version of this built the five `d` strings and then
 * parsed the numbers back out of them with a regex, every frame, twice — which
 * is a strange thing to do in the one function that exists to keep the hot path
 * honest.
 */
const JOINTS = 22;
function joints(p: Pose, out: number[]): number[] {
  const f = p.face, hx = p.x, hy = p.y;
  const ln = rad(p.lean * f);
  const nx = hx + RIG.SPINE * p.bre * Math.sin(ln);
  const ny = hy - RIG.SPINE * p.bre * Math.cos(ln) * p.sq;
  const hr = rad((p.lean + p.tilt) * f);
  let i = 0;
  const put = (x: number, y: number) => { out[i++] = x; out[i++] = y; };
  put(hx, hy);
  put(nx, ny);
  put(nx + RIG.NECK * Math.sin(hr), ny - RIG.NECK * Math.cos(hr));
  for (const a of [p.la, p.ra]) {
    const l = limb(nx, ny, a[0] * f, a[1] * f, RIG.UARM, RIG.LARM);
    put(l.jx, l.jy); put(l.ex, l.ey);
  }
  for (const a of [p.ll, p.rl]) {
    const l = limb(hx, hy, a[0] * f, a[1] * f, RIG.THIGH * p.sq, RIG.SHIN * p.sq);
    put(l.jx, l.jy); put(l.ex, l.ey);
  }
  return out;
}

/** Largest single-joint displacement between two joint sets, in world units. */
function spread(a: number[], b: number[]): number {
  let worst = 0;
  for (let i = 0; i < JOINTS; i += 2) {
    const dx = b[i] - a[i], dy = b[i + 1] - a[i + 1];
    const d = dx * dx + dy * dy;
    if (d > worst) worst = d;      // compare squared; one sqrt at the end
  }
  return Math.sqrt(worst);
}

/**
 * OVERLAP — the parts of a body do not all arrive at the same time.
 *
 * Every joint used to ease at one rate, which is why a gesture landed like a
 * hand of cards being laid down flat: correct, and lifeless. A shoulder leads,
 * the elbow trails it, and the head arrives last, and that ordering is most of
 * what separates animation from interpolation.
 *
 * These are RATE MULTIPLIERS, not delays. If the body eases at `u = 1 - e^(-k·dt)`
 * then `1 - (1-u)^f` is exactly the ease at rate `f·k` — so a channel at 0.6
 * follows with a time constant 1/0.6 longer, and it stays frame-rate independent
 * and still collapses to 1 when dt is huge. A delay line would need history and
 * would break the moment a frame was dropped.
 *
 * The legs are deliberately NOT dragged. Their angles are solved by IK to keep a
 * foot planted (see `walk`), and a leg that lags its solution is a foot that
 * slides — the exact fault that rewrite existed to remove.
 */
const FOLLOW = {
  /** the head. Follows the torso with visible weight, which is also why a head
   *  cannot chase pointer noise: this lag is a low-pass filter with a body. */
  tilt: 0.7,
  /** shoulder leads, forearm trails: the whip at the end of a wave */
  shoulder: 0.85,
  elbow: 0.55,
} as const;

function blend(a: Pose, b: Pose, u: number): Pose {
  // 1 - (1-u)^f is the same ease at f times the rate. Cheap, and exact.
  const t = 1 - Math.pow(1 - u, FOLLOW.tilt);
  const s = 1 - Math.pow(1 - u, FOLLOW.shoulder);
  const e = 1 - Math.pow(1 - u, FOLLOW.elbow);
  return {
    x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u),
    lean: lerp(a.lean, b.lean, u), tilt: lerp(a.tilt, b.tilt, t),
    sq: lerp(a.sq, b.sq, u), bre: lerp(a.bre, b.bre, u),
    face: lerp(a.face, b.face, u),
    la: [lerp(a.la[0], b.la[0], s), lerp(a.la[1], b.la[1], e)],
    ra: [lerp(a.ra[0], b.ra[0], s), lerp(a.ra[1], b.ra[1], e)],
    ll: [lerp(a.ll[0], b.ll[0], u), lerp(a.ll[1], b.ll[1], u)],
    rl: [lerp(a.rl[0], b.rl[0], u), lerp(a.rl[1], b.rl[1], u)],
  };
}

// ── personality ─────────────────────────────────────────────────────────────
/**
 * Sagittarius, expressed as numbers rather than adjectives. Each one is a trait
 * you can actually feel; change it and Arta reads as a different character.
 */
export const TRAITS = {
  /** curious — how hard the head tracks whatever the visitor is doing (0..1) */
  curiosity: 0.85,
  /** adventurous — seconds of stillness before Arta wanders off on its own */
  restlessness: 7,
  /** bold — gesture amplitude; a timid mascot at 0.6 reads as apologetic */
  boldness: 1.0,
  /** truth-seeking — how long it holds a point once it has aimed at something */
  conviction: 2.6,
  /** how long before it sits down and rests (seconds) */
  patience: 75,
} as const;

// ── the brain ───────────────────────────────────────────────────────────────
export type Act =
  | "idle" | "walk" | "wave" | "point" | "cheer" | "think" | "peer"
  | "shrug" | "rest" | "turn"
  // rope travel: the archer's arrow carries the line, so the grapple is the
  // signature gesture doing work rather than a second mechanic bolted on
  | "throw" | "fly" | "land" | "fall";

export type Input = {
  /** pointer in Arta's world coords, or null when the pointer is elsewhere */
  look: XY | null;
  /** true while the visitor is scrolling or typing — law 3, Arta settles */
  busy: boolean;
  /** ground line and the horizontal bounds Arta may walk within */
  ground: number;
  minX: number;
  maxX: number;
  /** world units per CSS pixel — the safe-motion limits are stated in CSS px,
   *  because that is the space the eye actually sees */
  scale: number;
  /**
   * The floors Arta may stand on: the bottom frame of every card currently on
   * screen, in world coords. Arta is never unsupported — it stands on a real
   * edge of the page or it is falling to one, and nothing else.
   */
  floors: Floor[];
};

/** A horizontal ledge: the bottom frame of a card, from x1 to x2 at y. */
export type Floor = {
  x1: number; x2: number; y: number;
  /** Arta's home. Where it starts, and where it goes when it has nothing else
   *  to do. Exactly one surface should carry this. */
  home?: boolean;
};

/**
 * The floor Arta would land on from (x, feetY): the HIGHEST ledge that spans x
 * and is at or below the feet. Falls back to the stage ground, so there is
 * always an answer — a character with nowhere to stand is the bug this exists
 * to prevent.
 */
/**
 * Snap a desired x onto a real ledge. Arta may only come to REST where a card
 * actually is: the stage floor in floorUnder() is a fallback so the maths always
 * has an answer, not a licence to stand on nothing. Without this Arta idles on
 * the invisible stage bottom wherever the page happens to have no card, which
 * is exactly the hovering this whole system exists to prevent.
 */
export function nearestStand(floors: Floor[], x: number): number | null {
  let best: number | null = null, bestD = Infinity;
  for (const f of floors) {
    if (f.x2 - f.x1 < 120) continue;                 // too narrow to stand on
    const cx = Math.min(Math.max(x, f.x1 + 60), f.x2 - 60);
    const d = Math.abs(cx - x);
    if (d < bestD) { bestD = d; best = cx; }
  }
  return best;
}

/**
 * The nearest place Arta could actually STAND, as a point rather than an x.
 *
 * `nearestStand` answers only "which ledge is closest horizontally", which is
 * the wrong question whenever the answer is overhead: Arta walked to the spot
 * beneath the card, arrived no higher than it started, still failed the
 * on-a-card test, and set off again. With every ledge above it, that is a loop
 * — and it is why Arta sat on the stage floor with a 24 px gap to the nearest
 * real surface for as long as the page was open.
 *
 * Cost is 2D and asymmetric, because climbing is not strolling: a ledge
 * overhead is charged 1.8x its height, one below is nearly free (that is a
 * fall, and gravity is already paid for). Anything higher than the rope can
 * reach is not a candidate at all.
 */
const CLIMB_COST = 1.8;
const CLIMB_MAX = 420;
export function nearestPerch(
  floors: Floor[], x: number, feetY: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null, bestC = Infinity;
  for (const f of floors) {
    if (f.x2 - f.x1 < 120) continue;                 // too narrow to stand on
    const up = feetY - f.y;                          // >0 when the ledge is above
    if (up > CLIMB_MAX) continue;                    // out of the rope's reach
    const cx = Math.min(Math.max(x, f.x1 + 60), f.x2 - 60);
    const c = Math.abs(cx - x) + (up > 0 ? CLIMB_COST * up : 0.15 * -up);
    if (c < bestC) { bestC = c; best = { x: cx, y: f.y }; }
  }
  return best;
}

/**
 * The surface under Arta's feet.
 *
 * `rise` is how far ABOVE the feet a ledge may still count — a step up. It is 0
 * for a body in free fall, which can only ever land downward, and about a third
 * of a leg while walking, because that is what stepping onto something is.
 *
 * Without it a walk could never gain height at all, and small rises are exactly
 * the common case: the message dock's lid sits 33 units above the stage floor,
 * and Arta walked to the right x, stayed at the wrong y, and stood in the air
 * beside the thing it was supposed to be standing on. Throwing a grappling line
 * to climb nineteen screen pixels is not the alternative.
 */
export function floorUnder(
  floors: Floor[], x: number, feetY: number, ground: number, rise = 6,
): number {
  let best = ground;
  for (const f of floors) {
    if (x < f.x1 - 8 || x > f.x2 + 8) continue;
    if (f.y < feetY - rise) continue;       // too far above to step onto
    if (f.y < best) best = f.y;             // nearer than the current candidate
  }
  return best;
}

/** Arta's home ledge, if the page offers one. */
export function homeFloor(floors: Floor[]): Floor | null {
  for (const f of floors) if (f.home) return f;
  return null;
}

/** How high Arta can step while walking, in world units — about a third of a leg. */
export const STEP_UP = 34;

export type Frame = {
  sk: Skeleton;
  act: Act;
  /** set while pointing: the arrow flies from Arta's hand to here */
  arrow: { from: XY; to: XY; age: number } | null;
  /** set while throwing or travelling: the line, hand to anchor */
  rope: { from: XY; to: XY } | null;
  /** true while airborne — the caller may want to hide the ground shadow */
  airborne: boolean;
  /** true when this tick produced a NEW drawing */
  drew: boolean;
  /** the largest distance any drawn point moved this frame, in CSS px. Must
   *  never exceed SAFE.MAX_PX_PER_FRAME; surfaced so it can be asserted. */
  peakPx: number;
};

/** Longest interval integrated in one go; anything larger is sub-stepped so a
 *  stall cannot fling Arta across the stage in a single frame. */
const MAX_STEP = 1 / 45;

export class Brain {
  private pose: Pose;
  private act: Act = "idle";
  private t = 0;             // seconds inside the current act
  private clock = 0;         // seconds since construction
  private lastDraw: Skeleton;
  private idleFor = 0;
  private phase = 0;         // walk cycle phase, accumulated over distance
  private targetX: number | null = null;
  private aim: XY | null = null;
  private aimAt = 0;
  private queue: Array<{ act: Act; at?: XY; x?: number }> = [];
  private glanceFrom = -99;
  private glanceDur = 1.4;
  private lookAt: XY | null = null;
  private lookStill = 0;
  private quietFor = 0;
  private glanceDir = 1;
  private nextGlance = 4;
  private nextWander: number = TRAITS.restlessness;
  /**
   * The INTENDED facing, always exactly 1 or -1. `pose.face` is the continuous
   * value easing toward it.
   *
   * These have to be separate. Comparing a desired side against `pose.face`
   * — a float mid-ease that is essentially never exactly ±1 — made the turn
   * re-trigger before it could finish, and the base pose carried the default
   * face of 1, so idle dragged Arta back to facing right every frame. Between
   * them Arta was pinned in the `turn` act forever, pulsing its squash at
   * 1.2 Hz. That was the shake.
   */
  private facing: Face = 1;
  private seed = 0x2f6e2b1;
  private peakPx = 0;
  /** authoritative ground position while walking; null when not walking */
  private rootX: number | null = null;
  private vy = 0;                     // vertical speed while falling, world units/s
  private impact = 0;                 // speed at touchdown — how hard to absorb
  private fellFrom: number | null = null; // hip height where this fall began
  private fallY = 0;                  // integrated height while falling
  private anchor: XY | null = null;   // where the line is hooked
  private flyFrom: XY = { x: 0, y: 0 };
  private flyDur = 1;
  private jNow: number[] = new Array(JOINTS).fill(0);
  private jNext: number[] = new Array(JOINTS).fill(0);
  /** joints at the start of the painted frame, for the per-frame ceiling */
  private jFrame: number[] = new Array(JOINTS).fill(0);

  /** Deterministic noise. Math.random would make Arta unreproducible, and the
   *  first thing you want when a behaviour looks wrong is to see it again. */
  private rnd(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  private drifts = [0, 1, 2].map(() => ({ v: 0, to: 0, left: 0 }));

  /**
   * A slow wander in [-1, 1]: pick a target, ease toward it, pick another.
   *
   * This replaced a sine, and the reason is worth keeping. Idle weight shift
   * WAS three sines, and three sines always come back: spacing them by the
   * golden ratio — the most irrational number there is, so the latest possible
   * near-repeat — still left the head 99% self-similar after 50 seconds,
   * because the Fibonacci convergents of phi are exactly where a near-repeat
   * lands. A sum of periodic things is periodic, or near enough that a person
   * watching will see the seam.
   *
   * Shifting your weight is not oscillation anyway. It is deciding to stand
   * differently, holding that, and later deciding again. Re-targeting on a
   * random interval also reverses direction LESS often than a sine does, which
   * the shake metric likes.
   *
   * Re-target timing is driven by accumulated seconds, not by frames, so the
   * same schedule and the same draws come out at any frame rate: still
   * reproducible, which is the whole reason the PRNG is seeded.
   */
  private drift(i: number, dt: number, every: number): number {
    const d = this.drifts[i];
    d.left -= dt;
    if (d.left <= 0) {
      d.to = this.rnd() * 2 - 1;
      d.left = every * (0.6 + 0.8 * this.rnd());
    }
    d.v += (d.to - d.v) * (1 - Math.exp(-1.1 * dt));
    return d.v;
  }

  constructor(x: number, ground: number) {
    this.pose = P({ x, y: ground - RIG.HIP });
    this.lastDraw = skeleton(this.pose);
  }

  /**
   * THE PLANNER. Given somewhere to be, decide how to get there.
   *
   * A walk only moves along the ground, so it can never answer a scroll — which
   * is vertical. A thrown line can, and the archer already throws things, so the
   * grapple is the existing gesture doing work rather than a new mechanic.
   *
   * Short and level → walk. Far or vertical → rope. Either way Arta takes the
   * time it takes: it must never teleport, and it must never keep up perfectly.
   * Arriving late is the character, not a shortfall.
   */
  travelTo(goal: XY) {
    if (this.act === "throw" || this.act === "fly" || this.act === "land") return;
    const dx = goal.x - this.pose.x, dy = goal.y - this.pose.y;
    // A goal well above cannot be walked to, whatever the horizontal distance:
    // a walk keeps whatever support is beneath it. Anything higher than one
    // step needs the line.
    if (-dy <= STEP_UP && Math.abs(dy) < 70 && Math.abs(dx) < 420) {
      if (Math.abs(dx) > 40) this.command("walk", { x: goal.x });
      return;
    }
    // Hook the line ABOVE the destination, so the arrival is a descent onto it
    // rather than a slide into it — but the hook has to be somewhere that
    // exists. World y starts at 0 at the top of the stage, and a goal high on
    // the page put the anchor at y = -14: Arta flew off the top of its own
    // viewBox to reach a card near the header. Take whatever headroom there is.
    this.anchor = { x: goal.x, y: Math.max(goal.y - 150, Math.min(goal.y - 30, 30)) };
    this.facing = dx >= 0 ? 1 : -1;
    this.enter("throw");
  }

  /**
   * Be there, now. The reduced-motion answer to travel: with no loop running,
   * time only advances when something is commanded, so a flight of up to 3.2s
   * would strand Arta hanging on a rope forever. Someone who asked for no
   * motion wants the destination, not the journey.
   */
  placeAt(goal: XY, ground: number) {
    this.queue.length = 0;
    this.anchor = null;
    this.act = "idle";
    this.t = 0;
    this.pose = { ...this.pose, x: goal.x, y: Math.min(goal.y, ground - RIG.HIP) };
  }

  /** Ask Arta to do something. Queued, never interrupting mid-gesture. */
  command(act: Act, opts: { at?: XY; x?: number } = {}) {
    if (this.queue.length > 3) this.queue.shift();
    this.queue.push({ act, ...opts });
  }

  get current(): Act { return this.act; }

  /**
   * Apply an act immediately, bypassing the queue and the do-not-interrupt rule.
   *
   * For the reduced-motion path only. There, time advances ONLY when something
   * is commanded, so an act can never reach its own timeout — a wave stays the
   * current act forever, `settled` stays false, and every later command sits in
   * the queue and is never seen again. There is also no gesture in flight to
   * protect when nothing is animating, so queueing buys nothing.
   */
  force(act: Act, opts: { at?: XY; x?: number } = {}) {
    this.queue.length = 0;
    this.enter(act, opts);
  }

  private enter(act: Act, opts: { at?: XY; x?: number } = {}) {
    // The integrated walk root belongs to one walk. Carrying it into the next
    // one would start that walk from wherever the last one was aiming.
    if (act !== "walk") this.rootX = null;
    if (act !== "fall") this.fellFrom = null;
    this.act = act;
    this.t = 0;
    if (opts.at) { this.aim = opts.at; this.aimAt = this.clock; }
    if (opts.x !== undefined) this.targetX = opts.x;
  }

  /** Advance the simulation. dt in SECONDS. Returns the frame to draw.
   *  Integrated at the caller's real frame interval — no fixed internal rate, so
   *  nothing beats against the display refresh. */
  step(dt: number, input: Input): Frame {
    let left = Math.min(Math.max(dt, 0), 0.25);   // a backgrounded tab must not fast-forward
    if (left <= 0) left = MAX_STEP;               // first frame, and the still() path
    /*
     * The per-frame ceiling belongs to the WHOLE step, not to each sub-step.
     *
     * MAX_PX_PER_FRAME exists to stop strobing between two frames the viewer
     * actually sees. The clamp used to be applied inside tick(), so a 30 Hz
     * frame — which sub-steps twice — was handed the budget twice and could
     * paint 21 px of movement while claiming to honour a 12 px limit. Measured
     * at 13.2 px with 34 frames over budget; invisible at 60 and 144 Hz, where
     * one frame is one sub-step, which is why it survived every earlier run.
     *
     * So the allowance is computed once per painted frame and divided among the
     * sub-steps by duration. Displacements across sub-steps can only partly
     * cancel, never more than sum, so bounding the parts bounds the whole.
     */
    const span = left;
    const allow = Math.min(SAFE.MAX_PX_PER_SEC * span, SAFE.MAX_PX_PER_FRAME) * input.scale;
    joints(this.pose, this.jFrame);
    let drew = false;
    while (left > 1e-6) {
      const h = Math.min(left, MAX_STEP);
      left -= h;
      this.tick(h, input, allow * (h / span));
      drew = true;
    }
    if (drew) {
      this.lastDraw = skeleton(this.pose);
      // What the viewer saw, which is the number the invariant is about.
      this.peakPx = spread(this.jFrame, joints(this.pose, this.jNext)) / input.scale;
    }
    return {
      sk: this.lastDraw,
      act: this.act,
      // Only once it has CAUGHT. Including `throw` drew the line taut to a
      // point in empty air for the whole 0.42 s wind-up — tied before it was
      // thrown.
      rope: this.anchor && this.act === "fly"
        ? { from: this.lastDraw.hand, to: this.anchor } : null,
      airborne: this.act === "fly",
      arrow: this.act === "point" && this.aim
        ? { from: this.lastDraw.hand, to: this.aim, age: this.clock - this.aimAt }
        : null,
      drew,
      peakPx: this.peakPx,
    };
  }

  private tick(dt: number, input: Input, budget: number): void {
    this.clock += dt;
    this.t += dt;
    const settled = this.act === "idle" || this.act === "rest";

    // ── law 3: while the visitor works, Arta stops having ideas ─────────────
    if (input.busy && settled) this.idleFor = 0;
    else if (settled) this.idleFor += dt;
    else this.idleFor = 0;

    // ── take the next command, but only from a settled pose. Interrupting a
    //    gesture halfway is what makes a mascot look glitchy rather than alive.
    if (this.queue.length && (settled || this.t > 2.2)) {
      const q = this.queue.shift()!;
      this.enter(q.act, q);
    }

    // ── what does Arta want to be doing? ────────────────────────────────────
    let want: Pose;
    // Gravity is not optional. The support under Arta is whatever ledge is
    // beneath its feet right now — a card's bottom frame, or the stage floor.
    const feet = this.pose.y + RIG.HIP;
    /*
     * Walking steps UP onto a low ledge; falling cannot, and a figure standing
     * still generally should not either, or Arta would levitate onto anything
     * that scrolled past just above its head.
     *
     * Home is the exception, and it has to be. Home is page-fixed rather than
     * something drifting by, and Arta is often already at the right x — the
     * phone's tab bar spans the whole width — so the walk that was supposed to
     * carry it up had nowhere to go, exited on its first frame, and left Arta
     * standing eighteen pixels under the bar it lives on, for good.
     */
    const homeF = homeFloor(input.floors);
    /*
     * When Arta has a home, home is the ONLY ledge.
     *
     * Home is page-fixed; a card is not. The page scrolls, so card ledges slide
     * vertically past a companion that does not — and every one of them is a
     * surface appearing under the soles and vanishing again a moment later.
     * Whatever tolerance you allow, a standing figure ends up bouncing its way
     * down the page: the audit caught it as nine act changes in five seconds,
     * and narrowing the tolerance only made it two.
     *
     * So a page that names a home gets a companion that lives there, feet on
     * that border, full stop. A page that names none keeps the old behaviour
     * and stands on whatever cards it has. The cost is that an explicit
     * `travelTo` elsewhere no longer has anything to stand on when it arrives;
     * that is the right trade while "always on a border" is the rule, and the
     * honest fix for it is per-element ledges that scroll WITH their element,
     * which the Floor model cannot express today.
     */
    const support = homeF
      ? floorUnder([homeF], this.pose.x, feet, input.ground, STEP_UP)
      : floorUnder(input.floors, this.pose.x, feet, input.ground,
                   this.act === "walk" ? STEP_UP : 6);
    const base = P({ x: this.pose.x, y: support - RIG.HIP });

    // Unsupported and not on a line? Then Arta is falling, and says so.
    const onLine = this.act === "fly" || this.act === "throw";
    if (!onLine && this.act !== "fall" && support - feet > 26) {
      this.vy = 0;
      this.enter("fall");
    }

    /*
     * Is anyone there? Measured once, above the switch, because two different
     * behaviours need it.
     *
     * `lookStill` gates the glance: a hand resting on a mouse is not a hand
     * using one. `quietFor` is how long the VISITOR has done nothing, which is
     * what `TRAITS.patience` was always meant to mean. It used to be read off
     * `idleFor` — time since Arta last had an idea — and Arta has an idea every
     * 7 seconds, so 75 seconds of it could not occur and `rest()`, a fully
     * authored pose, has never once been drawn on this site. Sitting down is a
     * response to an empty room, not to one's own stillness.
     */
    const lookShift = input.look && this.lookAt
      ? Math.hypot(input.look.x - this.lookAt.x, input.look.y - this.lookAt.y) : 999;
    this.lookStill = lookShift > 24 ? 0 : this.lookStill + dt;
    if (input.look) this.lookAt = { x: input.look.x, y: input.look.y };
    const active = input.busy || (input.look !== null && lookShift > 24);
    this.quietFor = active ? 0 : this.quietFor + dt;

    switch (this.act) {
      case "walk": {
        /*
         * The root position is INTEGRATED, and the target handed to the ease is
         * absolute. It used to be `want.x = this.pose.x + stepD` — a target
         * redefined relative to wherever the body currently was, every frame.
         * Against an exponential ease that is not a lag, it is a speed
         * DIVISION: the body only ever covers `u` of each step, so Arta walked
         * at 90 px/s instead of 210 at 60 Hz, and at 44 px/s at 144 Hz — a
         * frame-rate-dependent speed inside a rig whose entire doctrine is
         * frame-rate independence.
         *
         * It also broke the feet. The phase advanced by the INTENDED step while
         * the body moved a fraction of it, so the legs cycled 2.3x faster than
         * the ground went by: 26 px of skate per stance, in steady state,
         * on top of whatever the gait itself did. Both faults are the same
         * mistake, and an absolute target is the fix for both — a first-order
         * ease tracking a ramp has a constant position lag and zero velocity
         * error, so the body keeps up and the constant offset moves the feet
         * and the root together, which is no skate at all.
         */
        const tx = clamp(this.targetX ?? this.pose.x, input.minX, input.maxX);
        if (this.rootX === null) this.rootX = this.pose.x;
        const d = tx - this.rootX;
        const dir: Face = d >= 0 ? 1 : -1;
        if (Math.abs(d) < 4 && Math.abs(tx - this.pose.x) < 6) {
          this.rootX = null; this.enter("idle"); want = base; break;
        }
        /*
         * Choose a speed the budget can actually afford, instead of walking at
         * a fixed 210 px/s and letting the clamp throttle it.
         *
         * Those are not the same thing. The clamp slows the POSE while the gait
         * phase keeps its own time, so a throttled walk is a walk whose legs
         * cycle faster than its body travels — which is skating, and it is what
         * the 30 Hz case measured: 28 px of drift per stance with the clamp
         * firing on 7 frames. Fitting the speed to the frame keeps the contract
         * between phase and ground intact, and a slower walk on a slow display
         * is the correct answer anyway, because the anti-strobe ceiling is a
         * fact about perception rather than a budget to be spent.
         */
        /*
         * 210 px/s over a 110 px cycle was 1.91 cycles a second — 229 steps a
         * minute, against about 110 for a person, with a stride barely one leg
         * length instead of one and a half. It was a walk cycle played at a
         * sprint's tempo, which is the classic wrong-frame-rate read. 165 over
         * a 150 px cycle is 132 steps a minute and a 1.44 leg-length stride.
         *
         * And it BRAKES. Arriving went from full speed to nothing in a single
         * frame, absorbed only by the ease. Slowing over the last ~90 units
         * shortens the strides while the beat holds — which is what slowing
         * down actually looks like — and it is free, because the phase is
         * already driven by ground covered rather than by time.
         */
        const brake = clamp(Math.abs(d) / 90, 0.3, 1);
        const speed = Math.min(165 * TRAITS.boldness * brake, budget / dt / WALK.PEAK_RATIO);
        const stepD = Math.min(Math.abs(d), speed * dt) * Math.sign(d);
        this.rootX += stepD;
        // The phase is driven by the ground actually covered, so a stride is a
        // stride no matter what the frame rate or the ease are doing.
        this.phase = (this.phase + Math.abs(stepD) / WALK.CYCLE) % 1;
        want = walk(this.phase);
        want.x = this.rootX;
        // The SUPPORT, not the stage floor. `base.y` was resolved from
        // `floorUnder` fifty lines above and `walk` returns `RIG.HIP - h`
        // precisely so the two compose. Targeting `input.ground` instead put
        // the hip a card's whole height too low on the first walking frame,
        // the feet then dropped below the ledge, `floorUnder` discarded it as
        // being above them, and the act became `fall` — so Arta could never
        // walk on a card at all. Identical behaviour when there are no cards,
        // because then the support IS the ground.
        want.y = base.y + want.y;
        this.facing = dir;
        break;
      }
      case "wave": {
        want = wave((this.t / 0.55) % 1);
        want.x = base.x; want.y = base.y;
        if (this.t > 1.7) this.enter("idle");
        break;
      }
      case "point": {
        const a = this.aim ?? { x: this.pose.x + 100, y: base.y };
        const nx = this.pose.x, ny = base.y - RIG.SPINE;
        const f: Face = a.x >= nx ? 1 : -1;
        const deg = (Math.atan2(a.x - nx, a.y - ny) * 180) / Math.PI;
        want = point(deg, f);
        want.x = base.x; want.y = base.y; this.facing = f;
        if (this.t > TRAITS.conviction) this.enter("idle");
        break;
      }
      case "cheer": {
        // crouch, launch, land — anticipation and recovery, or it reads as a shrug
        const u = this.t / 1.35;
        /*
         * Blend RELATIVE against RELATIVE. `base` is absolute — `support -
         * RIG.HIP` — while every library pose carries an offset, so blending
         * the two and then adding `base.y` again asked for twice the support
         * height: on the shipped mount that is a hip target 800 CSS px below
         * the floor, for the 0.24 s anticipation and again for the recovery.
         * Only the speed clamp was containing it, and a clamp is a rate rather
         * than a veto, so Arta visibly sank and climbed back. This fires on
         * every successful sign-in.
         */
        want = u < 0.18 ? blend(P(), crouch(), ease(u / 0.18))
             : u < 0.86 ? blend(crouch(), cheer(), Math.sin(Math.PI * ((u - 0.18) / 0.68)))
             : blend(crouch(), P(), ease((u - 0.86) / 0.14));
        want.x = base.x; want.y = base.y + want.y;
        if (this.t > 1.35) this.enter("idle");
        break;
      }
      case "think":
      case "peer":
      case "shrug": {
        const src = this.act === "think" ? think() : this.act === "peer" ? peer() : shrug();
        want = { ...src, x: base.x, y: base.y + src.y };
        if (this.t > (this.act === "shrug" ? 1.6 : 3.2)) this.enter("idle");
        break;
      }
      case "rest": {
        const r = rest();
        want = { ...r, x: base.x, y: base.y + r.y };
        // Woken by a CHANGE, not by a presence. `input.look` is non-null for
        // the whole of any desktop visit, so waking on it meant standing up on
        // the very next frame after sitting down.
        if (active || this.queue.length) this.enter("idle");
        break;
      }
      case "throw": {
        // wind up, release. The line is drawn from the hand by the renderer.
        want = throwRope(clamp(this.t / 0.42, 0, 1));
        want.x = this.pose.x; want.y = base.y;
        if (this.t >= 0.42) {
          this.flyFrom = { x: this.pose.x, y: this.pose.y };
          const a = this.anchor ?? { x: this.pose.x, y: base.y };
          const d = Math.hypot(a.x - this.flyFrom.x, a.y - this.flyFrom.y);
          // Deliberately unhurried: ~340 px/s, floor 0.55s so a short hop still
          // reads as a swing, ceiling 3.2s so a long one is not a commute.
          this.flyDur = clamp(d / 340, 0.55, 3.2);
          this.enter("fly");
        }
        break;
      }
      case "fly": {
        const a = this.anchor ?? { x: this.pose.x, y: base.y };
        const u = clamp(this.t / this.flyDur, 0, 1);
        // Ease out of the launch and into the arrival, and sag through the
        // middle: a rope is a pendulum, not a zip-line between two pins.
        const e = ease(u);
        const sag = Math.sin(Math.PI * u) * Math.min(90, this.flyDur * 40);
        want = hang(Math.cos(Math.PI * u) * 0.8);
        want.x = lerp(this.flyFrom.x, a.x, e);
        want.y = lerp(this.flyFrom.y, a.y, e) + sag;
        // Land only if the destination is near the ground. If it is high up,
        // Arta stays on the line — hanging beside the thing you are reading is
        // the whole reason a mascot owns a rope.
        // Arriving on a line is a controlled descent, not a drop: absorb lightly.
        /*
         * Always `fall`. This used to branch to `perch` whenever the goal was
         * high — the common case — and `perch` was the one state in the system
         * that is none of the three permitted ones: not on a ledge, not falling
         * to one, and not on the rope either, because the rope is only drawn
         * during `throw` and `fly`. It put the HIP on the hook, which left the
         * drawn grip 135 units above it holding nothing, 150 above whatever
         * Arta had travelled to see, and nothing in the tick ever ended it. On
         * /arta, pressing Travel left a gold figure floating indefinitely.
         *
         * Handing the last stretch to gravity means a rope trip terminates
         * through exactly the same contact code as a step off a lip. One
         * implementation, not two.
         */
        if (u >= 1) this.enter("fall");
        break;
      }
      case "land": {
        /*
         * Absorb the arrival, from WHEREVER Arta actually is.
         *
         * Two defects found by reading this against the acts that reach it. It
         * blended from `hang(0)`, but `fall` also lands here and a figure that
         * walked off a ledge was never hanging — it snapped into a hang for one
         * frame first. And it steered x toward a stored goal, which only a rope
         * trip ever set: after a plain fall that goal was whatever an earlier
         * traversal had left behind, so touchdown yanked Arta sideways across
         * the page. Both vanish once landing simply means "absorb, here" — and
         * with nothing left reading it, the stored goal is gone too.
         */
        /*
         * How hard you land is how hard you absorb. A fixed crouch for every
         * arrival tells the viewer that a step off a kerb and a drop from the
         * top of the page cost the same, which is the fastest way to make a
         * figure look weightless — weight is only ever communicated by what it
         * costs to stop.
         *
         * Depth and duration both scale with the touchdown speed. `footDrop`
         * then places the hip from whatever knees that produced, which is the
         * whole reason it exists: a variable crouch has no fixed offset to
         * hand-tune.
         */
        const hard = clamp(this.impact / 260, 0.28, 1);   // 260 px is a fall worth a full absorb
        const u = clamp(this.t / (0.26 + 0.26 * hard), 0, 1);
        const fy = floorUnder(input.floors, this.pose.x, this.pose.y + RIG.HIP, input.ground);
        // Down fast, HOLD, then up slowly. The hold is not decoration: the pose
        // chases this target through an ease, and a target that has already
        // started rising is one the body never catches — every drop absorbed an
        // identical 8 px whatever it had fallen, which is the weightlessness
        // this was written to remove. Compression is quick and recovery is
        // slow, which is also the shape of a real landing.
        const c = u < 0.2 ? 1 : 1 - ease((u - 0.2) / 0.8);
        want = blend(P(), blend(P(), crouch(), hard), c);
        want.x = this.pose.x;
        // Wherever the absorb has the knees, the feet are on the surface.
        want.y = fy - footDrop(want);
        if (u >= 1) { this.anchor = null; this.enter("idle"); }
        break;
      }
      case "fall": {
        /*
         * Gravity, with a terminal speed the frame-to-frame ceiling can absorb.
         *
         * The support is looked up from where the feet are at the START of this
         * step, not where they will be at the end. Asking about the end is a
         * point test against a moving body, and `floorUnder` discards any ledge
         * already above the feet — so a ledge crossed WITHIN one step is
         * discarded as though Arta were already past it, and Arta falls
         * straight through. Measured: feet at 488 one frame, 507 the next, and
         * a card at 500 that never existed. Testing from the start of the step
         * makes it a swept test, and `Math.min` puts the feet exactly on it.
         */
        /*
         * The height is integrated, and terminal speed is whatever the frame can
         * actually paint.
         *
         * Both matter, and for the same reason. `ny = pose.y + vy*dt` measures
         * from a body the clamp is holding back, so the target crept down while
         * vy went on accumulating: every drop, including a 30 px one, arrived at
         * the 900 terminal speed, and the "impact" the landing scaled itself by
         * was a fact about a number rather than about Arta. Capping the fall at
         * a speed the ceiling permits means the body keeps up and vy is once
         * again the speed of the thing you can see.
         */
        /*
         * Height is INTEGRATED, like the walk's root, and for the same reason:
         * `pose.y + vy*dt` is a target defined relative to a body the ease is
         * holding back, so the body only ever covers a fraction of each step.
         * A 400 px drop took 5.3 seconds — gravity that floats.
         *
         * The integrator has to be paired with a tracking rate high enough that
         * the body stays with it. When it was not, the fall's own numbers
         * reached the floor some 80 px before Arta did and the landing began in
         * mid-air, whereupon gravity saw an unsupported figure and started the
         * fall again. Terminal speed is capped at what the frame can paint, and
         * `k` for a fall is 60, so the residual lag is v/k — about 7 px, well
         * inside the 26 px that counts as unsupported.
         */
        if (this.fellFrom === null) { this.fellFrom = this.pose.y; this.fallY = this.pose.y; }
        this.vy = Math.min(this.vy + 2200 * dt, (budget / dt) * 0.7, 900);
        this.fallY += this.vy * dt;
        const ny = this.fallY;
        const land = floorUnder(input.floors, this.pose.x, feet, input.ground) - RIG.HIP;
        want = P({ x: this.pose.x, y: Math.min(ny, land), lean: -6, tilt: -8,
                   la: [128, 18], ra: [-124, -16], ll: [18, -26], rl: [-16, -30] });
        if (ny >= land) {
          // How FAR it fell, not how fast. Speed saturates within a few frames
          // — every drop from 30 px to 400 arrived at the same number — and it
          // is measured on a body the clamp is holding back, so it describes
          // the simulation rather than the thing anyone can see. Distance does
          // not saturate and is exactly what the viewer watched happen.
          this.impact = this.fallY - this.fellFrom;
          this.vy = 0; this.fellFrom = null;
          this.enter("land");
        }
        break;
      }
      case "turn": {
        // Just the squash. The facing itself is already set, and `face` eases
        // continuously through zero on its own — the act exists to give the
        // turn a little weight, not to drive it.
        // Squash the SPINE, not the legs. ARTA.md forbids scaling `sq` here by
      // name: it scales THIGH and SHIN, so a 6% squash lifted both feet 6.2
      // world units clear of the ledge for the whole turn — a figure that
      // hops slightly every time it changes direction.
      want = { ...base, bre: 1 - 0.06 * Math.sin(Math.PI * clamp(this.t / 0.3, 0, 1)) };
        if (this.t >= 0.3) this.enter("idle");
        break;
      }
      default: {
        want = base;
        /*
         * Curious: Arta looks around on its own. Two faults kept this from ever
         * being seen.
         *
         * It was gated on `!input.look`, and `look` is non-null from the first
         * pointermove until the pointer leaves the window — so on any ordinary
         * desktop visit the glance NEVER fired, and idle was breath plus mouse
         * tracking and nothing else. Gate on the pointer being STILL instead:
         * a hand resting on a mouse is not a hand using one.
         *
         * And the envelope was dead air. `(glanceUntil - clock) / 1.1` starts
         * above 1 whenever the duration is randomised past 1.1 s, and the clamp
         * pins it there, so `sin(pi)` is zero for the whole excess — a 1.9 s
         * glance was 0.8 s of nothing followed by the same 1.1 s move. Driving
         * the envelope from elapsed time over the actual duration spends the
         * randomness on the glance rather than on a pause.
         */
        if (this.idleFor > this.nextGlance && !input.busy && (!input.look || this.lookStill > 3)) {
          this.nextGlance = this.idleFor + 5 + 4 * this.rnd();
          this.glanceFrom = this.clock;
          this.glanceDur = 1.1 + 0.8 * this.rnd();
          this.glanceDir = this.rnd() < 0.5 ? -1 : 1;
        }
        const gu = (this.clock - this.glanceFrom) / this.glanceDur;
        if (gu >= 0 && gu <= 1) {
          // Smaller when there IS something to look away from.
          want.tilt += (input.look ? 10 : 14) * this.glanceDir
                     * Math.sin(Math.PI * gu) * TRAITS.curiosity;
        }
        /*
         * Adventurous: stillness eventually turns into going somewhere. But
         * "somewhere" has to be somewhere Arta can BE.
         *
         * This used to pick a random x across the whole stage and walk to the
         * horizontally nearest ledge — height ignored. Standing on a card, that
         * means walking off the end of it. Arta then fell, climbed back up,
         * wandered off the edge again, and spent 25 of every 60 seconds in the
         * air; it was on a real surface 4% of the time. Walking off a ledge is
         * not exploring, it is falling.
         *
         * So: stroll along the ledge you are on, and now and then rope across
         * to a different one. Both stay on a floor, which is the rule.
         */
        /*
         * `idleFor` used to be zeroed here unconditionally — before the tests
         * below decided whether to walk at all — so it was bounded by
         * restlessness plus a frame, `TRAITS.patience` (75 s) could never be
         * reached, and `rest()`, a fully authored pose, has never once been
         * drawn on this site. A separate deadline absorbs the failed attempts
         * and leaves `idleFor` monotonic; only a walk that actually starts
         * resets it. Zeroing it inside the tests instead would re-roll the PRNG
         * every frame past the threshold, which would cost sixty draws a second
         * and the reproducibility the generator exists for.
         */
        if (this.idleFor > this.nextWander && !input.busy) {
          this.nextWander = this.idleFor + TRAITS.restlessness;
          const feetNow = this.pose.y + RIG.HIP;
          const here = input.floors.find(
            (f) => this.pose.x >= f.x1 - 8 && this.pose.x <= f.x2 + 8 && Math.abs(f.y - feetNow) < 12);
          /*
           * With a home, Arta does not go wandering off it.
           *
           * It used to pick another ledge a third of the time, and the trip
           * crosses the page on the invisible stage floor — so for several
           * seconds the figure stands on nothing in the middle of the content,
           * which is the one thing it must never do. Strolling along the ledge
           * it lives on keeps its feet on a visible border at every instant.
           * Anywhere else is still reachable, but only when something asks:
           * `arta.travelTo(el)` is a deliberate act, a daydream is not.
           */
          const others = homeFloor(input.floors)
            ? [] : input.floors.filter((f) => f !== here && f.x2 - f.x1 >= 120);
          if (here && others.length && this.rnd() < 0.35) {
            const f = others[Math.floor(this.rnd() * others.length)];
            const x = f.x1 + 60 + (f.x2 - f.x1 - 120) * this.rnd();
            this.idleFor = 0; this.nextWander = TRAITS.restlessness;
            this.travelTo({ x, y: f.y - RIG.HIP });
          } else if (here) {
            const lo = here.x1 + 60, hi = here.x2 - 60;
            const to = lo + Math.max(0, hi - lo) * this.rnd();
            if (Math.abs(to - this.pose.x) > 60) {
              this.idleFor = 0; this.nextWander = TRAITS.restlessness;
              this.enter("walk", { x: to });
            }
          } else {
            // Standing on nothing: go HOME, not to whatever happens to be
            // nearest horizontally. A wander that starts from mid-air is how
            // Arta ended up 600 px from any border in the middle of a page.
            const home = homeFloor(input.floors);
            const to = home ? (home.x1 + home.x2) / 2
                            : nearestStand(input.floors, this.pose.x) ?? this.pose.x;
            this.idleFor = 0; this.nextWander = TRAITS.restlessness;
            if (home && feetNow - home.y > STEP_UP) this.travelTo({ x: to, y: home.y - RIG.HIP });
            else if (Math.abs(to - this.pose.x) > 24) this.enter("walk", { x: to });
          }
        }
        // Standing on the fallback floor is not standing on anything. If there
        // is a real ledge to be on, go and be on it — and "go" has to include
        // UPWARD, or a page whose cards are all overhead leaves Arta walking to
        // a spot underneath one, arriving no higher, failing this same test and
        // setting off again. That loop is why Arta sat on the stage floor with
        // a measured 24 px gap to the nearest real surface.
        if (input.floors.length && this.idleFor > 1.2) {
          const feetNow = this.pose.y + RIG.HIP;
          const onCard = input.floors.some(
            (f) => this.pose.x >= f.x1 && this.pose.x <= f.x2 && Math.abs(f.y - feetNow) < 30);
          const home = homeFloor(input.floors);
          const onHome = !!home && this.pose.x >= home.x1 && this.pose.x <= home.x2
                       && Math.abs(home.y - feetNow) < 12;
          // Home wins whenever Arta is not already on it. Everything else is a
          // place to visit; this is where it lives.
          const spot = onHome ? null
            : home ? { x: clamp(this.pose.x, home.x1 + 60, home.x2 - 60), y: home.y }
            : onCard ? null : nearestPerch(input.floors, this.pose.x, feetNow);
          if (spot) {
            const up = feetNow - spot.y;
            this.idleFor = 0;
            // One step is walked onto; anything higher is roped to.
            if (up > STEP_UP) { this.travelTo({ x: spot.x, y: spot.y - RIG.HIP }); break; }
            if (Math.abs(spot.x - this.pose.x) > 24 || up > 6) { this.enter("walk", { x: spot.x }); break; }
          }
        }
        // and eventually it sits down
        if (this.quietFor > TRAITS.patience) this.enter("rest");
        break;
      }
    }

    // Whatever the act decided, the target facing is the one Arta intends. The
    // pose library's default of 1 must never leak through as a command to turn
    // right, which is precisely what it was doing.
    want.face = this.facing;

    // ── overlays, applied to whatever the act decided ───────────────────────
    const moving = this.act === "walk" || this.act === "cheer"
                || this.act === "fly" || this.act === "throw" || this.act === "land";

    // look at the pointer: head first, a little torso. This one behaviour does
    // more for "alive" than every gesture in the library put together.
    if (input.look && !moving) {
      const nx = this.pose.x, ny = this.pose.y - RIG.SPINE;
      const dx = input.look.x - nx, dy = input.look.y - ny;
      const a = (Math.atan2(dx, -dy) * 180) / Math.PI;      // 0 = straight up
      const k = TRAITS.curiosity * (input.busy ? 0.35 : 1);
      want.tilt += clamp(a * 0.22, -26, 26) * k * want.face;
      want.lean += clamp(a * 0.05, -6, 6) * k * want.face;
      // face the pointer, but only from a settled pose (law: flip on a hold)
      const side: Face = dx >= 0 ? 1 : -1;
      if (this.act === "idle" && side !== this.facing && Math.abs(dx) > 40) {
        this.facing = side;
        this.enter("turn");
      }
    }

    /*
     * Breath and weight shift — and, above all, an idle that does not LOOP.
     *
     * These four oscillators used to run at 0.42, 0.21, 0.32 and 0.13 Hz: the
     * first three are exact harmonics of one base (1, 1/2, 0.77), so the body
     * returned to precisely the same state every few seconds. A short exact
     * loop is the difference between a figure that is idling and a figure that
     * is playing an idle, and half a minute of watching is enough to see it.
     *
     * Spacing the rates by the golden ratio makes the sum QUASI-PERIODIC: no
     * two components share a rational ratio, so they never phase-lock and the
     * combination never repeats, while each one individually stays a plain
     * sine that cannot surprise the speed ceiling. Breath depth also drifts on
     * a 27 s cycle, far below anything the calm rules count as an oscillation,
     * because a body that breathes to a metronome is a body being animated.
     */
    const calm = moving ? 0 : 1;
    if (calm > 0) {
      // The breath stays a sine, because breathing really is periodic — but its
      // depth drifts on a 27 s cycle, far under anything the calm rules count
      // as an oscillation, because a body that breathes to a metronome is a
      // body being animated.
      const depth = 1 + 0.25 * Math.sin(2 * Math.PI * 0.037 * this.clock);
      want.bre *= 1 + 0.026 * calm * depth * Math.sin(2 * Math.PI * BREATH * this.clock);
      // Everything else wanders. See `drift`.
      want.lean += 1.6 * calm * this.drift(0, dt, 5.5);
      want.tilt += 2.2 * calm * this.drift(1, dt, 4.0);
      const sway = 1.8 * calm * this.drift(2, dt, 6.5);
      want.la = [want.la[0] + sway, want.la[1]];
      want.ra = [want.ra[0] - sway, want.ra[1]];
    }

    // ── ease toward it, frame-rate independently ────────────────────────────
    // 1 - e^(-k·dt) is the same motion at 60 Hz and at 144, and recovers
    // correctly from a dropped frame; a fixed per-frame fraction does neither.
    // A walk tracks its cycle almost rigidly (the cycle IS the animation); a
    // gesture arrives softly.
    // A landing has to arrive before it recovers, so it tracks harder than a
    // gesture; a walk tracks its own cycle almost rigidly.
    const k = this.act === "walk" || this.act === "fall" ? 60
            : this.act === "land" ? 26 : 11;
    let u = 1 - Math.exp(-k * dt);
    let next = blend(this.pose, want, u);

    // ── the speed limit ─────────────────────────────────────────────────────
    // Scale the whole blend back rather than clamping points individually: the
    // figure has to stay a figure, so it slows down as one body instead of
    // having a fast limb amputated from a slow torso. Because the measurement
    // is over every drawn point, this covers root motion, limb swing and
    // turning at once, and a gesture added later cannot escape it.
    joints(this.pose, this.jNow);
    let moved = spread(this.jNow, joints(next, this.jNext));
    // ITERATE. `u *= budget / moved` assumes displacement is linear in the blend
    // factor, and it is not — the pose blends linearly but the skeleton resolves
    // through sin/cos, so one correction step can still overshoot. It did: the
    // rig raised its own overspeed flag at 12.6 px against a 12 px ceiling on
    // production, where the frame timing differs from the dev machine's. Each
    // pass overshoots less, so three converge comfortably, and the last one is
    // hard-capped so the invariant holds even in a pathological case.
    for (let i = 0; i < 3 && moved > budget && moved > 1e-6; i++) {
      u *= budget / moved;
      next = blend(this.pose, want, u);
      moved = spread(this.jNow, joints(next, this.jNext));
    }
    if (moved > budget && moved > 1e-6) {
      u *= (budget / moved) * 0.9;
      next = blend(this.pose, want, u);
      moved = spread(this.jNow, joints(next, this.jNext));
    }
    this.pose = next;
  }
}

// ── the command bus ─────────────────────────────────────────────────────────
/**
 * Any component can direct Arta without prop-drilling or context:
 *     import { arta } from "artalife/rig/arta";
 *     arta.pointAt(buttonEl);   arta.cheer();   arta.peer();
 *
 * It lives here rather than beside the renderer because it is not a component;
 * exporting a non-component from a component module also disables fast refresh
 * for that module.
 */
export type Cmd = { act: Act; at?: XY; x?: number; el?: Element | null };

const listeners = new Set<(c: Cmd) => void>();
export function onArtaCommand(fn: (c: Cmd) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const send = (c: Cmd) => listeners.forEach((f) => f(c));

export const arta = {
  /** The signature gesture: aim at a real element on the page. */
  pointAt: (el: Element | null) => send({ act: "point", el }),
  /** Go there. The planner picks walking or the rope; see Brain.travelTo. */
  travelTo: (el: Element | null) => send({ act: "throw", el }),
  walkTo: (el: Element | null) => send({ act: "walk", el }),
  wave: () => send({ act: "wave" }),
  cheer: () => send({ act: "cheer" }),
  think: () => send({ act: "think" }),
  peer: () => send({ act: "peer" }),
  shrug: () => send({ act: "shrug" }),
  idle: () => send({ act: "idle" }),
};
