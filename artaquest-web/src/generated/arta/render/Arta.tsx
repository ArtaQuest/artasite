/* GENERATED — DO NOT EDIT HERE.
 * Vendored from artalife src/render/Arta.tsx @ d6ffa98.
 * Source of truth: https://github.com/ArtaQuest/artalife.git
 * Re-run: node tools/arta-sync.mjs
 */
/**
 * ARTA — the live renderer.
 *
 * Six SVG elements, one requestAnimationFrame loop, and NO React state in that
 * loop: the frame writes attributes straight onto refs. Re-rendering a
 * component tree 24 times a second to move a stick figure would be the single
 * most expensive thing on the landing page, and it is entirely avoidable.
 *
 * It stops completely when it should, which for a character that appears on
 * every page is not an optimisation but the difference between a companion and
 * a nuisance:
 *   • prefers-reduced-motion → one static pose, no rAF at all. Arta is still
 *     THERE and still expressive; it just does not move. Commands still land:
 *     the sim is fast-forwarded to the gesture's settled state and painted once,
 *     so a reduced-motion visitor sees the arrow arrive rather than an arrow
 *     frozen at the first instant of its fade-in, which is invisible.
 *   • scrolled out of view → the loop stops (IntersectionObserver).
 *   • tab hidden → the loop stops (visibilitychange).
 *   • visitor scrolling or typing → `busy`, and Arta settles (law 3).
 *
 * Arta is gold; anything Arta wields is blue (see ARTA.md §8). Today that is
 * only the arrow, but the token is the rule, not the exception.
 *
 * The command bus lives in ../lib/arta — it is not a component.
 */
import { useEffect, useRef } from "react";
import { Brain, RIG, SAFE, homeFloor, onArtaCommand, type Act, type Cmd, type Floor, type XY } from "../rig/arta";

/** World is 380 tall with the ground at 340 — enough headroom for the jump,
 *  whose raised hands reach about 330 above the sole. */
const WORLD_H = 380;
const GROUND = 340;
/** Arta's line weight in CSS px — one value for every device (see the <g>). */
export const ARTA_STROKE = 4.5;

export type ArtaProps = {
  /** Rendered height in CSS pixels. Arta occupies ~57% of it. */
  height?: number;
  /**
   * Companion mode: the stage IS the whole host box (use with a fixed,
   * full-viewport, pointer-events-none wrapper). The world then spans the
   * viewport, which is what lets Arta actually travel across a page rather than
   * fly out of a 380-unit band — a rope is pointless in a box.
   */
  fill?: boolean;
  /** Arta's own height in CSS px. Only meaningful with `fill`. */
  figure?: number;
  /** Where Arta starts, as a fraction of the stage width. */
  start?: number;
  /** How much of the stage Arta may wander across, as fractions of its width.
   *  Keeps it out of the headline when the stage is full-bleed behind text. */
  range?: [number, number];
  /** z-index while on the rope (climbing past a panel it would otherwise be behind). */
  ropeZ?: number;
  /** Draw the hairline Arta stands on. */
  ground?: boolean;
  className?: string;
  /*
   * There is deliberately no `label`. Arta is decorative unless it is doing a
   * job, and the label it used to carry — passed unconditionally at the mount —
   * described what it LOOKS like, on every route, for the whole session. A
   * screen-reader user met a stick figure at the end of every page and it led
   * nowhere. If a caller ever makes Arta carry information alone, fix that at
   * the caller; do not describe the decoration.
   */
};

export default function Arta({
  height = 220, start = 0.5, range = [0.08, 0.92], ground = true, className,
  fill = false, figure = 132, ropeZ,
}: ArtaProps) {
  // Destructured to stable primitives: a `[a, b]` literal prop is a new array
  // every render, so using it directly in the dependency array would re-run the
  // whole effect — tearing down and rebuilding the loop — on every parent render.
  const [rangeLo, rangeHi] = range;

  const host = useRef<HTMLDivElement | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const torso = useRef<SVGPathElement | null>(null);
  const armL = useRef<SVGPathElement | null>(null);
  const legL = useRef<SVGPathElement | null>(null);
  const armR = useRef<SVGPathElement | null>(null);
  const legR = useRef<SVGPathElement | null>(null);
  const head = useRef<SVGCircleElement | null>(null);
  const arrow = useRef<SVGPathElement | null>(null);
  const rope = useRef<SVGPathElement | null>(null);

  useEffect(() => {
    const el = host.current, root = svg.current;
    if (!el || !root) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    // In companion mode the scale is set by how tall ARTA should be, and the
    // world grows to whatever the host box is. In band mode the world is a fixed
    // 380 tall and the scale is set by the band's height.
    /*
     * How TALL Arta is drawn, and it is not one number.
     *
     * 128 px reads as a companion beside desktop content and as a third of the
     * screen on a 390-wide phone — the same figure, and far too much of it. So
     * the height tapers with the viewport: full size from 640 px up, 68% of it
     * on a phone, interpolated between so a tablet is not either extreme.
     *
     * Recomputed in `setBox`, which already runs on resize, because a rotation
     * crosses the breakpoint and a figure that only sized itself once would
     * stay wrong until the next navigation. `scale` is therefore a `let` that
     * every frame reads, not a constant captured at mount.
     */
    const figureFor = (w: number) => {
      const u = Math.max(0, Math.min(1, (w - 390) / (640 - 390)));
      return figure * (0.68 + 0.32 * u);
    };
    let scale = fill ? RIG.HEIGHT / figureFor(el.clientWidth) : WORLD_H / height;
    let vw = Math.max(240, el.clientWidth * scale);
    let wh = fill ? Math.max(320, el.clientHeight * scale) : WORLD_H;
    let gnd = fill ? wh - 52 : GROUND;
    const brain = new Brain(vw * start, gnd);

    /*
     * ── the floors ──────────────────────────────────────────────────────────
     *
     * A ledge is the TOP edge of a card, not the bottom.
     *
     * This had it inverted, and the result is the whole bug the operator caught:
     * standing on a card's BOTTOM border puts the figure inside the card above
     * it, so Arta's body covered the trending list's text while its feet met a
     * line hidden behind the message dock. Feet on a lid, body in the clear —
     * that is what standing on something looks like.
     *
     * `data-floor="bottom"` opts an element back into its lower edge for the
     * cases where that really is the surface.
     *
     * Read at 4 Hz, never per frame: these are layout reads and the page does
     * not reflow sixty times a second.
     */
    let floors: Floor[] = [];
    let floorsAt = 0;
    /** Put Arta on its home ledge the first time the page offers one, instead
     *  of letting it start on the invisible stage floor and walk in. The first
     *  thing a visitor sees should already be correct. */
    let placed = false;
    /** false while the page offers no ledge, in which case Arta is not drawn. */
    let shown = true;
    const readFloors = (): Floor[] => {
      if (!fill) return [];
      const r = root.getBoundingClientRect();
      if (!r.width || !r.height) return [];
      const sx = vw / r.width, sy = wh / r.height;
      const out: Floor[] = [];
      for (const c of document.querySelectorAll("[data-floor]")) {
        const b = c.getBoundingClientRect();
        if (b.width < 90) continue;                       // too narrow, or hidden
        // A ledge must not MOVE when the page scrolls. Arta is a fixed layer,
        // so an ordinary card's edge slides vertically past its soles — a
        // surface that appears underfoot and is gone a moment later. Whatever
        // tolerance you allow, a standing figure ends up bouncing its way down
        // the page; the audit caught it as ten act changes in five seconds.
        // Only something pinned to the viewport is somewhere to stand.
        const pos = getComputedStyle(c).position;
        if (pos !== "fixed" && pos !== "sticky") continue;
        const edge = c.getAttribute("data-floor") === "bottom" ? b.bottom : b.top;
        if (edge < r.top + 40 || edge > r.bottom - 40) continue;   // off stage
        /*
         * Split the ledge around anything standing ON it.
         *
         * The phone's tab bar carries a raised centre button that pokes 7 px
         * above the bar's own top edge, and the bar paints above the companion
         * layer — so Arta strolled straight through x 171..219 with its ankles,
         * and the contact point, hidden behind it. Feet on a VISIBLE border is
         * the rule; a border you cannot see Arta meeting does not satisfy it.
         *
         * So a child that protrudes through the surface is an obstacle, and the
         * ledge becomes the clear runs either side of it. Segments too narrow
         * to stand on are dropped by the same 120-unit test everything else
         * uses, which is also what stops a fussy layout producing confetti.
         */
        const blockers = [...c.querySelectorAll("*")]
          .map((e) => e.getBoundingClientRect())
          .filter((q) => q.width > 16 && q.top < edge - 2)
          .sort((q1, q2) => q1.left - q2.left);
        const home = c.hasAttribute("data-floor-home");
        let cut = b.left;
        const push = (from: number, to: number) => {
          if (to - from < 70) return;                     // too narrow to stand on
          out.push({ x1: (from - r.left) * sx, x2: (to - r.left) * sx,
                     y: (edge - r.top) * sy, home });
        };
        for (const q of blockers) { push(cut, q.left - 4); cut = Math.max(cut, q.right + 4); }
        push(cut, b.right);
      }
      return out;
    };

    let look: XY | null = null;      // smoothed
    let rawLook: XY | null = null;   // as reported
    let busyUntil = 0;
    let lastCheck = 0;
    let raf = 0;
    let prev = 0;
    /** Smoothed frame interval. rAF timestamps jitter by a millisecond or two
     *  and the odd frame is dropped; feeding that raw dt into the sim makes a
     *  walking figure visibly stutter (a 33 ms frame moves it twice as far as
     *  its neighbours). A short low-pass keeps motion even, while a real change
     *  of refresh rate (60 → 120 Hz, battery saver) is followed within ~10
     *  frames. Long gaps (tab switch, GC pause) are clamped, not fast-forwarded. */
    let dtS = 1 / 60;
    /** While a ledge is MOVING (the dock drawer sliding, a keyboard resizing the
     *  viewport) floors are read every frame instead of at 4 Hz, so Arta's feet
     *  ride the lid instead of lagging it by up to 250 ms and then snapping. */
    let floorsHotUntil = 0;
    const floorSig = (fl: Floor[]) => fl.map((f) => `${f.x1.toFixed(0)},${f.x2.toFixed(0)},${f.y.toFixed(0)}`).join("|");
    let lastSig = "";
    let lastHome: Floor | null = null;
    let frozenY: number | null = null;
    let settled = 0;

    const setBox = () => {
      if (fill) scale = RIG.HEIGHT / figureFor(el.clientWidth);
      vw = Math.max(240, el.clientWidth * scale);
      wh = fill ? Math.max(320, el.clientHeight * scale) : WORLD_H;
      gnd = fill ? wh - 52 : GROUND;
      root.setAttribute("viewBox", `0 0 ${vw.toFixed(0)} ${wh.toFixed(0)}`);
      const g = root.querySelector("line");
      if (g) { g.setAttribute("y1", gnd.toFixed(0)); g.setAttribute("y2", gnd.toFixed(0)); }
    };
    setBox();

    /** Screen point → Arta's world. Everything external arrives through here. */
    const toWorld = (cx: number, cy: number): XY => {
      const r = root.getBoundingClientRect();
      if (!r.width || !r.height) return { x: 0, y: 0 };
      return { x: ((cx - r.left) / r.width) * vw, y: ((cy - r.top) / r.height) * wh };
    };

    let shownAct = "";
    /** Last value written per attribute slot, so an unchanged one is skipped. */
    const written: string[] = [];
    const set = (n: Element | null, attr: string, v: string, slot: number) => {
      if (!n || written[slot] === v) return;
      written[slot] = v;
      n.setAttribute(attr, v);
    };
    const paint = (f: ReturnType<Brain["step"]>) => {
      const s = f.sk;
      // The current act, on the DOM. Costs one attribute write per state change
      // and makes the whole state machine observable from the outside — which is
      // the only reason the reduced-motion arrow bug was findable at all.
      if (f.act !== shownAct) {
        shownAct = f.act; el.setAttribute("data-act", f.act);
        // On the rope, Arta is in front of whatever it is climbing past (the
        // host says how far forward with `ropeZ`); back in its layer after.
        if (ropeZ !== undefined) el.style.zIndex = f.act === "throw" || f.act === "fly" ? String(ropeZ) : "";
      }
      // Self-reporting invariant: this attribute must never appear. It is the
      // cheapest possible way to notice a future gesture outrunning the limit.
      if (f.peakPx > SAFE.MAX_PX_PER_FRAME + 0.5) el.setAttribute("data-overspeed", f.peakPx.toFixed(1));
      /*
       * Write only what CHANGED.
       *
       * Paths are emitted rounded to 0.1 px, so a frame whose string equals the
       * last one is a DOM write that does nothing — and during idle most of
       * them are exactly that. Measured over 30 s of a settled Arta: both legs
       * unchanged on 100% of frames (a standing figure does not move its feet),
       * torso and head on 47%. Roughly half of every attribute write this
       * companion made, on every page, for the whole session, was setting a
       * value to itself.
       *
       * An SVG attribute write is not free — it invalidates the element even
       * when the value is identical — whereas a string compare against a cached
       * primitive costs nothing worth measuring. This is the cheapest
       * optimisation in the file and it is invisible in behaviour, which is why
       * `attrs/s` in the audit is a real efficiency number and not decoration.
       */
      set(torso.current, "d", s.torso, 0);
      set(armL.current, "d", s.armL, 1);
      set(legL.current, "d", s.legL, 2);
      set(armR.current, "d", s.armR, 3);
      set(legR.current, "d", s.legR, 4);
      set(head.current, "cx", s.head.cx.toFixed(1), 5);
      set(head.current, "cy", s.head.cy.toFixed(1), 6);
      // ── the rope ──────────────────────────────────────────────────────────
      // Drawn with a sag rather than as a straight segment: a line under a
      // hanging figure is a catenary, and a taut chord reads as a wire.
      const rp = rope.current;
      if (rp) {
        if (!f.rope) set(rp, "opacity", "0", 7);
        else {
          const { from, to } = f.rope;
          const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
          const span = Math.hypot(to.x - from.x, to.y - from.y);
          const sag = f.airborne ? Math.min(26, span * 0.05) : Math.min(46, span * 0.09);
          set(rp, "d",
            `M${from.x.toFixed(1)} ${from.y.toFixed(1)}Q${mx.toFixed(1)} ${(my + sag).toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`, 8);
          set(rp, "opacity", "0.85", 7);
        }
      }
      const a = arrow.current;
      if (!a) return;
      if (!f.arrow) { set(a, "opacity", "0", 9); return; }
      const { from, to, age } = f.arrow;
      // Sagittarius fires an ARROW — a short shaft that travels from the hand to
      // the target and fades. The first version drew the whole hand-to-target
      // line, which reads as a rope strung across the page and cuts through the
      // body copy on its way. A short thing in flight says "that one, over
      // there" without connecting two points with a wire.
      const dx = to.x - from.x, dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      // Fly only as far as the stage. A target below the fold has a world y well
      // outside the viewBox — measured at y 2024 in an 813-tall stage — so the
      // arrow was drawn correctly and entirely off-canvas: the act reported
      // `point`, the opacity read 0.8, and the viewer saw nothing at all. The
      // gesture communicates a DIRECTION, and clamping the flight to the edge
      // leaves the direction untouched. Infinity is the honest answer for a ray
      // parallel to an edge pair, and `len` bounds it in any case.
      const exit = (o: number, d: number, lo: number, hi: number) =>
        d > 1e-6 ? (hi - o) / d : d < -1e-6 ? (lo - o) / d : Infinity;
      const M = 14;                                              // stage inset
      const reach = Math.max(46, Math.min(len, exit(from.x, ux, M, vw - M), exit(from.y, uy, M, wh - M)));
      const shaft = Math.min(58, reach * 0.4);
      const u = Math.min(1, age / 0.5);
      const t0 = 22 + Math.max(0, reach - shaft - 22) * (u * (2 - u));   // ease-out flight
      const ax = from.x + ux * t0, ay = from.y + uy * t0;
      const bx = ax + ux * shaft, by = ay + uy * shaft;
      const px = -uy, py = ux;                                   // barb direction
      const fade = Math.min(1, age / 0.12) * (1 - Math.max(0, Math.min(1, (age - 1.1) / 0.6)));
      set(a, "d",
        `M${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}` +
        `M${(bx - ux * 13 + px * 8).toFixed(1)} ${(by - uy * 13 + py * 8).toFixed(1)}` +
        `L${bx.toFixed(1)} ${by.toFixed(1)}` +
        `L${(bx - ux * 13 - px * 8).toFixed(1)} ${(by - uy * 13 - py * 8).toFixed(1)}`, 10);
      set(a, "opacity", (0.8 * fade).toFixed(2), 9);
    };

    // ── reduced motion: one pose, no loop, still directable ─────────────────
    // Fast-forward 0.6s of simulation so a commanded gesture is shown at rest.
    // Painting at t=0 would show the arrow at the very start of its fade-in,
    // which is opacity 0 — the gesture would silently never appear.
    /*
     * Reduced motion still has to FOLLOW its home.
     *
     * `still()` used to place Arta once, on the home it found first, and never
     * again — there is no loop to notice anything after that. So when the
     * message dock opened, its lid moved up 560 px and Arta stayed where the
     * lid had been: behind the open panel, invisible for as long as the panel
     * was open. With motion on, Arta ropes up to the new edge; with motion off
     * it simply vanished, which is the "absence is the lazy answer" this
     * setting must never get. A moved home now gets one repaint at the new
     * edge: a single static pose, zero animation frames.
     */
    const homeSig = (fl: Floor[]) => {
      const h = homeFloor(fl);
      return h ? `${Math.round(h.x1)}:${Math.round(h.x2)}:${Math.round(h.y)}` : "";
    };
    let stillHome = "";
    const still = () => {
      const fl = readFloors();
      const home = homeFloor(fl);
      const sig = homeSig(fl);
      if (home && (!placed || (stillHome && sig !== stillHome))) {
        placed = true; brain.placeAt({ x: (home.x1 + home.x2) / 2, y: home.y - RIG.HIP }, gnd);
      }
      stillHome = sig;
      const inp = { look: null, busy: true, ground: gnd, scale, floors: fl,
                    minX: vw * rangeLo, maxX: Math.max(vw * rangeLo + 60, vw * rangeHi) };
      let f = brain.step(0, inp);
      for (let i = 0; i < 6; i++) f = brain.step(0.1, inp);
      paint(f);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const raw = prev ? (now - prev) / 1000 : 0;
      prev = now;
      if (raw > 0) {
        const c = Math.min(Math.max(raw, 1 / 240), 1 / 20);
        dtS += (c - dtS) * (Math.abs(c - dtS) > 0.012 ? 0.5 : 0.18);
      }
      const dt = raw > 0 ? dtS : 0;
      // Low-pass the pointer before the head chases it, HARD.
      //
      // A shake is direction reversals, not distance, so the speed limit in the
      // rig cannot catch this one. Measured with a jittering pointer, a 62 ms
      // filter let the head reverse 8.6 times a second — more often than the
      // stimulus itself, which is amplification, not tracking. A real hand
      // tremors and a real mouse sensor is noisy, so anything fast enough to
      // follow a genuine glance is also fast enough to follow the noise.
      //
      // 250 ms instead. The head then reads as following with weight, which is
      // what a look actually is; the dead zone above stops sensor noise from
      // entering at all.
      if (!rawLook) look = null;
      else if (!look) look = { ...rawLook };
      else {
        const g = 1 - Math.exp(-4 * dt);
        look = { x: look.x + (rawLook.x - look.x) * g, y: look.y + (rawLook.y - look.y) * g };
      }
      if (now - floorsAt > 250 || now < floorsHotUntil) {
        floors = readFloors(); floorsAt = now;
        /*
         * A MOVING home ledge (a drawer sliding open or shut) is followed as
         * ONE move, not frame by frame: while it travels, Arta keeps standing
         * on where it was (so it neither falls nor is dragged through the
         * animation), and once it has settled the rig is told the whole move —
         * a small one is ridden, a big one is climbed or rappelled on the rope.
         */
        const homeNow = placed ? homeFloor(floors) : null;
        if (homeNow && lastHome) {
          const moved = Math.abs(homeNow.y - lastHome.y) > 0.5;
          if (moved && frozenY === null) { frozenY = lastHome.y; settled = 0; }
          else if (frozenY !== null) {
            settled = moved ? 0 : settled + 1;
            if (settled >= 2) { brain.ride(frozenY, homeNow.y, homeNow); frozenY = null; }
          }
        }
        lastHome = homeNow;
        if (frozenY !== null) floors = floors.map((f) => (f.home ? { ...f, y: frozenY as number } : f));
        const sig = floorSig(floors);
        if (sig !== lastSig) { if (lastSig) floorsHotUntil = now + 600; lastSig = sig; }
        if (!placed) {
          const home = homeFloor(floors);
          if (home) { placed = true; brain.placeAt({ x: (home.x1 + home.x2) / 2, y: home.y - RIG.HIP }, gnd); }
        }
        /*
         * No ledge on this page means nowhere to stand, and a figure standing on
         * nothing is the one thing the rule forbids. So Arta is not drawn — it is
         * not shrunk, or moved out of the way, or stood on an invisible line: the
         * page simply does not have a companion.
         *
         * A logged-out visitor is the live case. The message dock and the phone
         * tab bar are both members-only, so the landing page has no fixed surface
         * at all, and Arta was standing over the middle of a card explaining what
         * the site checks. Better absent than levitating.
         */
        const grounded = floors.length > 0;
        if (grounded !== shown) {
          shown = grounded;
          // Fade rather than pop: opacity is compositor-only, and visibility
          // follows only once the fade-out has finished (see transitionend).
          el.style.transition = "opacity 260ms cubic-bezier(0.22, 1, 0.36, 1)";
          if (grounded) el.style.visibility = "";
          el.style.opacity = grounded ? "1" : "0";
          el.setAttribute("data-arta-grounded", grounded ? "1" : "0");
        }
      }
      const f = brain.step(dt, {
        look, busy: now < busyUntil, ground: gnd, scale, floors,
        minX: vw * rangeLo, maxX: Math.max(vw * rangeLo + 60, vw * rangeHi),
      });
      paint(f);   // every frame: the brief is smoothness, not the drawn cadence
    };

    const onFadeEnd = () => { if (!shown) el.style.visibility = "hidden"; };
    el.addEventListener("transitionend", onFadeEnd);
    // Isolate the layer: the companion repaints its own SVG every frame, and
    // containment keeps that from invalidating layout or paint of the page.
    el.style.contain = "layout paint style";

    const startLoop = () => {
      if (raf || reduce?.matches) return;
      prev = 0;
      dtS = 1 / 60;
      raf = requestAnimationFrame(frame);
    };
    const stopLoop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

    // A resize moves every fixed ledge at once (rotation, keyboard, URL bar).
    const onResize = () => { floorsHotUntil = performance.now() + 600; };
    window.addEventListener("resize", onResize, { passive: true });
    // ── inputs ──────────────────────────────────────────────────────────────
    // Dead zone: below this the pointer has not really moved, it has wobbled.
    // Stated in CSS px so it means the same thing at every stage size.
    const dead = () => 4 * scale;   // reads the CURRENT scale, which resize can change
    const onMove = (e: PointerEvent) => {
      /*
       * A finger is not a look.
       *
       * On a touch device a pointer exists ONLY while something is pressed, so
       * head-tracking — the behaviour the rig calls the single biggest
       * contributor to seeming alive — was, on the majority device, driven
       * exclusively by the drag and scroll that law 3 says must silence Arta.
       * `onScroll` only damps the look to 35%; it does not end it. And while
       * `look` is non-null the idle glance is suppressed outright, so a phone
       * visitor got the stare and none of the character.
       *
       * A tap and a scroll are the same class of event, so a touch gets the
       * same 450 ms of quiet that a scroll does. A pen keeps tracking, because
       * a stylus hovers and hovering really is a cursor.
       */
      if (e.pointerType === "touch") { busyUntil = performance.now() + 450; return; }
      const p = toWorld(e.clientX, e.clientY);
      if (!rawLook || Math.hypot(p.x - rawLook.x, p.y - rawLook.y) > dead()) rawLook = p;
    };
    const onLeave = () => { rawLook = null; look = null; };
    const onScroll = () => { busyUntil = performance.now() + 450; sync(); };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) busyUntil = performance.now() + 1200;
    };

    const onCmd = (c: Cmd) => {
      // With no loop running there is no gesture in flight to protect, and an
      // act can never time out — so a queued command would never be dequeued.
      const apply = reduce?.matches
        ? (a: Act, o?: { at?: XY; x?: number }) => brain.force(a, o)
        : (a: Act, o?: { at?: XY; x?: number }) => brain.command(a, o);
      if (c.el) {
        const r = c.el.getBoundingClientRect();
        const p = toWorld(r.left + r.width / 2, r.top + r.height / 2);
        if (c.act === "walk") apply("walk", { x: p.x });
        // "throw" as a COMMAND means "travel there" — the planner decides
        // whether that is a walk or a rope.
        else if (c.act === "throw") {
          // Clamp into the stage. A target below the fold has a world y outside
          // the viewport, and an unclamped goal sends Arta rappelling into the
          // void at speed — correct physics, useless behaviour.
          const cl = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
          const goal = {
            x: cl(p.x, vw * rangeLo, Math.max(vw * rangeLo + 60, vw * rangeHi)),
            y: cl(p.y, 120, gnd),
          };
          if (reduce?.matches) brain.placeAt(goal, gnd);
          else brain.travelTo(goal);
        }
        else apply(c.act, { at: p });
      } else {
        apply(c.act);
      }
      if (reduce?.matches) still();
    };

    /*
      Whether the loop should be running is RECOMPUTED from the element's real
      rect, never remembered. A cached `visible` flag was the previous design and
      it was a one-way door: any observer callback that reported a partial entry
      list latched it to false, and Arta stayed dead for the rest of the visit
      even while plainly on screen. Recomputing is self-healing — a wrong answer
      lasts one check instead of forever.

      The rect read is throttled to 4/second; it is a layout read and scroll
      fires far more often than that, while a quarter second of extra loop is
      invisible.
    */
    const shouldRun = () => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.bottom > -80 && r.top < window.innerHeight + 80;
    };
    const sync = (force = false) => {
      const t = performance.now();
      if (!force && t - lastCheck < 250) return;
      lastCheck = t;
      if (!document.hidden && !reduce?.matches && shouldRun()) startLoop(); else stopLoop();
    };
    // Recovery must not be purely event-driven. A burst of scroll events can
    // stop the loop, have the remainder of the burst swallowed by the throttle
    // above, and then no further event ever arrives to start it again — Arta
    // frozen for the rest of the visit. A slow heartbeat closes that hole for
    // the cost of one rect read twice a second, and it is the ONLY thing that
    // recovers a state nothing else will observe.
    // Reduced motion: repaint once if the home ledge has moved since the last
    // still pose. Cheap enough for the heartbeat, and also run right after a
    // click (two frames later, once layout has settled) because a click is how
    // a drawer opens — waiting up to half a second for the beat leaves Arta
    // behind the panel long enough to be seen missing.
    const restill = () => { if (reduce?.matches && homeSig(readFloors()) !== stillHome) still(); };
    const onClick = () => {
      if (!reduce?.matches) return;
      requestAnimationFrame(() => requestAnimationFrame(restill));
    };
    const beat = window.setInterval(() => { sync(true); restill(); }, 500);
    const io = new IntersectionObserver(() => sync(true), { rootMargin: "80px" });
    const onVis = () => sync(true);
    const ro = new ResizeObserver(() => { setBox(); sync(true); });

    io.observe(el);
    ro.observe(el);
    const unsubscribe = onArtaCommand(onCmd);
    window.addEventListener("pointermove", onMove, { passive: true });
    // pointerup and pointercancel too: a lifted stylus, a cancelled gesture and
    // a native scroll takeover must all clear the look through one path rather
    // than relying on pointerleave firing for a non-hover pointer.
    window.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointerup", onLeave);
    window.addEventListener("pointercancel", onLeave);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey, { passive: true });
    window.addEventListener("click", onClick, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVis);
    const onReduce = () => { if (reduce?.matches) { stopLoop(); still(); } else sync(true); };
    reduce?.addEventListener?.("change", onReduce);

    if (reduce?.matches) still(); else sync(true);

    return () => {
      stopLoop();
      el.removeEventListener("transitionend", onFadeEnd);
      window.clearInterval(beat);
      io.disconnect(); ro.disconnect();
      unsubscribe();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointerup", onLeave);
      window.removeEventListener("pointercancel", onLeave);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("visibilitychange", onVis);
      reduce?.removeEventListener?.("change", onReduce);
    };
  }, [height, start, rangeLo, rangeHi, fill, figure, ropeZ]);

  return (
    <div ref={host} className={className} style={fill ? undefined : { height }} data-arta>
      <svg
        ref={svg}
        className="block h-full w-full overflow-visible"
        viewBox={`0 0 600 ${WORLD_H}`}
        preserveAspectRatio="xMidYMax meet"
        role="presentation"
        aria-hidden="true"
      >
        {ground && (
          <line
            x1="0" y1={GROUND} x2="4000" y2={GROUND}
            className="stroke-line" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
          />
        )}
        {/* The line. Blue, because it is a tool (ARTA.md §8). */}
        <path
          ref={rope} data-arta-rope opacity="0" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" vectorEffect="non-scaling-stroke" className="text-arta-tool"
        />
        <path
          ref={arrow} data-arta-arrow opacity="0"
          fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          vectorEffect="non-scaling-stroke" className="text-arta-tool"
        />
        <g
          /* BODY WEIGHT: 4.5 CSS px on every device. non-scaling-stroke makes
             it a CSS-pixel width, so it is the same at DPR 1, 2 and 3, at any
             browser zoom and whatever the figure's height — a phone's smaller
             figure is no longer drawn in a desktop-weight line (7 px read as
             heavy, worst on the tab bar). Upright, lighter, still legible. */
          fill="none" stroke="currentColor" strokeWidth={ARTA_STROKE}
          strokeLinecap="round" strokeLinejoin="round"
          vectorEffect="non-scaling-stroke" className="text-arta"
        >
          <path ref={torso} vectorEffect="non-scaling-stroke" />
          <path ref={armL} vectorEffect="non-scaling-stroke" />
          <path ref={legL} vectorEffect="non-scaling-stroke" />
          <path ref={armR} vectorEffect="non-scaling-stroke" />
          <path ref={legR} vectorEffect="non-scaling-stroke" />
          <circle ref={head} r={RIG.HEAD_R} vectorEffect="non-scaling-stroke" />
        </g>
      </svg>
    </div>
  );
}
