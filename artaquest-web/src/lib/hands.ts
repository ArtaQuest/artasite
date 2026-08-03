/**
 * ArtaHand — the parametric RPS hand, ported verbatim from the design artifact
 * ("The Wheel of Arta", artifact 519484ec). ONE hand, five continuous digits:
 * fc = [thumb, index, middle, ring, pinky], each 0 (curled) … 1 (raised) — so any
 * pose morphs into any other. The hand is drawn SIDEWAYS, exactly as two players
 * face each other in a real match: fingers point right toward the rival, thumb on top.
 *
 * `handInner(fc)` returns the SVG inner markup (paths + creases) for a pose; render it
 * inside `<svg viewBox="0 -10 62 52">` with the shared gradient/shadow defs
 * (components/Hand.tsx exports <HandDefs/> and the animated engine).
 */

export const TOOL_KEYS = [
  "gun", "plow", "scissors", "cup", "bolt", "wheat",
  "wedge", "hook", "arrow", "rock", "saw", "net",
] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];

export const TOOL_NAME: Record<ToolKey, string> = {
  gun: "Gun", plow: "Plow", scissors: "Scissors", cup: "Cup", bolt: "Bolt", wheat: "Wheat",
  wedge: "Wedge", hook: "Hook", arrow: "Arrow", rock: "Rock", saw: "Saw", net: "Net",
};

/** Finger chart per tool — which digits are raised. */
export const TOOL_FC: Record<ToolKey, number[]> = {
  gun: [1, 1, 1, 0, 0],      // thumb cocked, two fingers forward
  plow: [0, 1, 1, 1, 1],     // four flat fingers — the share biting the field
  scissors: [0, 1, 1, 0, 0], // the twin blades
  cup: [0, 0, 1, 1, 1],      // three low fingers hold the water
  bolt: [1, 1, 1, 1, 1],     // all five flung wide
  wheat: [1, 1, 0, 0, 0],    // thumb and finger pinch one ear
  wedge: [0, 0, 0, 0, 1],    // the little finger slides into the seam
  hook: [0, 0, 0, 1, 1],     // the two low fingers — the barb
  arrow: [0, 1, 0, 0, 0],    // one straight finger
  rock: [0, 0, 0, 0, 0],     // the closed fist IS the rock
  saw: [0, 1, 1, 1, 0],      // three teeth in a row
  net: [1, 0, 0, 0, 1],      // thumb and pinky spread the corners
};

export const FIST: number[] = [0, 0, 0, 0, 0];

/** The Twelve Laws — tool k beats the tool three steps ahead ((k+3) mod 12).
 *  Who beats YOU: the tool three steps behind — LAWS[(k+9)%12] names your bane. */
export const LAWS: string[] = [
  "Gun cracks the Cup",
  "Plow grounds the Bolt",
  "Scissors shear the Wheat",
  "Cup rusts the Wedge",
  "Bolt melts the Hook",
  "Wheat swallows the Arrow",
  "Wedge splits the Rock",
  "Hook jams the Saw",
  "Arrow threads the Net",
  "Rock smashes the Gun",
  "Saw cuts the Plow",
  "Net binds the Scissors",
];

/** SVG inner markup for a pose (continuous fc) — verbatim artifact geometry. */
export function handInner(f: number[]): string {
  const n = (v: number) => (Math.round(v * 100) / 100).toString();
  const lp = (a: number, b: number, t: number) => a + (b - a) * t;
  // rows top->bottom: index, middle, ring, pinky
  const Y = [13, 19.2, 25.4, 31.2], RH = [2.9, 3.05, 2.8, 2.35], LEANY = [-1.6, -0.4, 0.7, 1.7], LEN = [19, 21.5, 20, 15.5];
  const KX = 34, CURL = 4.6, DEEPV = 6.5, TOP = 10, BOT = 35.3, WX = 10;
  const ti = [f[1], f[2], f[3], f[4]];
  const hh: number[] = [], ch: number[] = [], tx: number[] = [], cy: number[] = [];
  for (let k = 0; k < 4; k++) {
    const t = ti[k];
    cy[k] = Y[k] + LEANY[k] * t;
    hh[k] = lp(RH[k] * 0.98, RH[k] * 0.8, t);
    tx[k] = KX + lp(CURL, LEN[k], t);
    ch[k] = hh[k] * 1.1;
  }
  let d = "M" + n(KX - 2) + " " + n(TOP + 0.2);
  for (let k = 0; k < 4; k++) {
    d += " L" + n(tx[k]) + " " + n(cy[k] - hh[k])
      + " C" + n(tx[k] + ch[k]) + " " + n(cy[k] - hh[k]) + " " + n(tx[k] + ch[k]) + " " + n(cy[k] + hh[k]) + " " + n(tx[k]) + " " + n(cy[k] + hh[k]);
    if (k < 3) {
      const vt = Math.min(ti[k], ti[k + 1]);
      const vx = KX + lp(2.4, DEEPV, Math.max(0, vt));
      const jt = Y[k] + RH[k] - 0.1, jb = Y[k + 1] - RH[k + 1] + 0.1;
      d += " L" + n(vx) + " " + n(jt) + " Q" + n(vx - 2.2) + " " + n((jt + jb) / 2) + " " + n(vx) + " " + n(jb);
    } else {
      d += " L" + n(KX - 2) + " " + n(BOT);
    }
  }
  d += " Q" + n(KX - 13) + " " + n(BOT + 0.7) + " " + n(WX + 5.5) + " " + n(BOT - 0.5)
    + " Q" + n(WX + 0.4) + " " + n(BOT - 1.2) + " " + n(WX) + " " + n(29.6)
    + " Q" + n(WX - 1.8) + " " + n(22.6) + " " + n(WX) + " " + n(15.8)
    + " Q" + n(WX + 0.5) + " " + n(TOP + 0.4) + " " + n(WX + 5.5) + " " + n(TOP + 0.2)
    + " Q" + n(KX - 13) + " " + n(TOP - 0.8) + " " + n(KX - 2) + " " + n(TOP + 0.2) + " Z";
  let out = '<path d="' + d + '"/>';

  // thumb: swings from lying along the top edge (fist) to pointing up. The base sits WELL BACK
  // toward the wrist (a real thumb roots at the thenar, not mid-palm) and rolls slightly further
  // back as it raises; raised it leans a touch past vertical, with a thick thenar base tapering up.
  const s = f[0];
  const RX2 = lp(19, 16.8, s), RY2 = lp(10.2, 12.2, s);
  const ang = (lp(-22, 100, s) * Math.PI) / 180, TLEN = lp(9.8, 15.5, s), BW = lp(3.0, 4.2, s), TW = lp(2.2, 2.6, s);
  const dx = Math.cos(ang), dy = -Math.sin(ang), px = -dy, py = dx;
  const tpt = (t2: number, sg: number, bow?: number) => {
    const cxx = RX2 + dx * TLEN * t2, cyy = RY2 + dy * TLEN * t2, w = lp(BW, TW, t2) + (bow || 0);
    return n(cxx + px * sg * w) + " " + n(cyy + py * sg * w);
  };
  const tpx = RX2 + dx * TLEN, tpy = RY2 + dy * TLEN;
  out += '<path d="M' + tpt(0, 1)
    + " Q" + tpt(0.5, 1) + " " + tpt(0.92, 1)
    + " Q" + n(tpx + px * TW + dx * TW * 1.2) + " " + n(tpy + py * TW + dy * TW * 1.2) + " " + n(tpx + dx * TW * 1.15) + " " + n(tpy + dy * TW * 1.15)
    + " Q" + n(tpx - px * TW + dx * TW * 1.2) + " " + n(tpy - py * TW + dy * TW * 1.2) + " " + tpt(0.92, -1)
    + " Q" + tpt(0.5, -1, 0.7) + " " + tpt(0, -1) + ' Z"/>';

  // curl creases between folded rows
  for (let k = 0; k < 3; k++) {
    const op = 0.15 * (1 - Math.max(ti[k], ti[k + 1]));
    if (op > 0.015) {
      const cyy2 = (Y[k] + Y[k + 1]) / 2;
      out += '<path fill="#000" opacity="' + op.toFixed(3) + '" d="M' + n(KX + 2.6) + " " + n(cyy2 - 0.4)
        + " Q" + n(KX + 3.3) + " " + n(cyy2) + " " + n(KX + 2.6) + " " + n(cyy2 + 0.4)
        + " L" + n(KX - 6.2) + " " + n(cyy2 + 0.28)
        + " Q" + n(KX - 7) + " " + n(cyy2) + " " + n(KX - 6.2) + " " + n(cyy2 - 0.28) + ' Z"/>';
    }
  }
  // thumb crease when folded (thumb lying across the fist)
  const top2 = 0.11 * (1 - s);
  if (top2 > 0.015) {
    out += '<path fill="#000" opacity="' + top2.toFixed(3) + '" d="M' + n(RX2 - 1.5) + " " + n(RY2 + 2.6)
      + " Q" + n(RX2 + 4) + " " + n(RY2 + 4.2) + " " + n(RX2 + 8.5) + " " + n(RY2 + 3.4)
      + " Q" + n(RX2 + 4) + " " + n(RY2 + 5) + " " + n(RX2 - 1.4) + " " + n(RY2 + 3.4) + ' Z"/>';
  }
  return '<g transform="rotate(-6 30 22)">' + out + "</g>";
}
