# Arta — animation style guide

The canonical reference for how the mascot moves. Everything enforceable here is
enforced in `artaquest-web/src/lib/arta.ts`; this document explains *why*, so the
numbers can be argued with rather than merely obeyed.

Arta is a stick figure with **no face**. That is a constraint, not an omission:
with no expression to lean on, everything must be said with posture and timing.
Most of this guide is therefore about weight and delay rather than shapes.

**One rig, two lives.** The mascot and the published film (work 9319,
`scene_gen.py`) share the same skeleton, the same joint convention and the same
proportions. If the two ever diverge we have two mascots, which is none.

---

## 1. Identity

| | |
|---|---|
| Character | Curious, truth-seeking, adventurous. Sagittarius — the archer |
| Signature | **Aiming.** Arta points at what matters, and an arrow flies from its hand |
| Colour | Gold `#E8B923`, in **both** themes (`--color-arta`) |
| Proportions | spine 70 · neck 24 · head r20 · thigh/shin 52 · upper/fore arm 34/32 · total 218 |
| Joint convention | Degrees. **0 is straight down**, positive rotates toward +x |

Personality is expressed as numbers, not adjectives (`TRAITS`): `curiosity`,
`restlessness`, `boldness`, `conviction`, `patience`. Change them and Arta reads
as a different character. That is the intended way to retune it.

---

## 2. The three laws

A character on every page is either a companion or an irritation, and the
difference is entirely in what it refuses to do.

1. **Never blocks.** No covering content, no dialogue, nothing to dismiss. Arta
   renders on a `pointer-events-none` layer so it *cannot* swallow a click.
2. **Reacts, never interrupts.** Arta answers what you do. It has no tips to
   volunteer and nothing to say that you did not just cause.
3. **Goes still when you work.** Typing, reading, scrolling → `busy`, and Arta
   settles. Presence and motion are different things.

---

## 3. Motion safety — the hard limit

**No drawn point may move more than `min(640 px/s · dt, 12 px)` in one frame.**

Two ceilings, because they bind at different frame rates and both matter:

- **`MAX_PX_PER_FRAME = 12`** guards against **strobing**. An un-blurred line
  that travels much more than about twice its own stroke width between frames
  stops reading as movement and becomes a sequence of separate positions. This
  binds when the frame rate is *low*.
- **`MAX_PX_PER_SEC = 640`** guards against being **too fast to follow**, which
  is the comfort and vestibular concern rather than the legibility one. This
  binds at 120 Hz, where a per-frame budget alone would silently permit twice
  the real-world speed.
- **`MAX_FLASH_HZ = 2`** — nothing may oscillate in opacity or visibility faster
  than this. WCAG 2.3.1 draws the seizure line at 3 Hz; the platform's calm rule
  is stricter, and a mascot has no business near either.

### How it is enforced

The blend factor for the whole figure is scaled back until the largest
single-point displacement fits the budget:

```
u      = 1 - e^(-k·dt)
next   = blend(pose, want, u)
moved  = max displacement over EVERY drawn point
if moved > budget:  u *= budget / moved;  next = blend(pose, want, u)
```

Scaling the whole blend — rather than clamping points individually — matters: the
figure has to stay a figure, so it slows as one body instead of having a fast
limb amputated from a slow torso. Because the measurement is over every drawn
point, it covers root motion, limb swing and turning at once, **and a gesture
added later cannot escape it**.

### The invariant is self-reporting

If the cap is ever exceeded, the component writes `data-overspeed` onto its host
element. That attribute must never appear. Measured under a worst-case stress
run (every gesture back to back, pointer whipped side to side to force repeated
turns, 595 frames): **peak 11.18 px/frame, flag never raised**.

### Turning is continuous, not a flip

Facing is implemented by negating every joint angle, so treating `face` as a
boolean moves a foot **~43 px in a single frame** — by a wide margin the largest
gradient in the system, and one no blend can soften because it is discrete.
`face` is therefore a continuous value in `[-1, 1]`. Easing it through zero gives
a real turn: the figure narrows to its own profile, passes edge-on, and opens out
the other way.

---

## 4. Cadence

| Context | Cadence | Why |
|---|---|---|
| **The mascot** (this rig) | Smooth, every frame, display-native | Operator brief: as smooth as the panel can manage |
| **The film** (`scene_gen.py`) | On twos, `calcMode="discrete"` | Hand-drawn cadence; a held drawing reads as *drawn* |

These are deliberately different and both are correct for their medium. Do not
"fix" one to match the other.

Every rate in the mascot rig is expressed **per second** and integrated with
`dt`. All easing is `1 - e^(-k·dt)`, which is frame-rate independent: identical
motion at 60 and 144 Hz, and correct again after a dropped frame. A fixed
per-frame fraction is neither. Frames longer than 1/45 s are **sub-stepped**, so
a stall cannot fling Arta across the stage.

Easing constants: `k = 34` for a walk (the cycle *is* the animation, so tracking
is near-rigid), `k = 11` for a gesture (arrives softly).

---

## 5. Timing vocabulary

Real values from the shipped acts. Reuse them; a new gesture that invents its own
timing will feel like it belongs to a different character.

| Beat | Duration | Note |
|---|---|---|
| Anticipation before a launch | 0.18 s | A jump with no crouch reads as a shrug |
| Gesture settle-in | ~0.25 s | `k = 11` exponential, not a linear ramp |
| Wave | 1.7 s | Once, on arrival. **Never on a loop** |
| Aim held | 2.6 s (`conviction`) | Long enough to follow the arrow, short enough not to nag |
| Arrow flight | 0.5 s, fade at 1.1 s | |
| Turn | 0.30 s | A squash for weight; `face` eases through zero on its own |
| Idle → wander | 7 s (`restlessness`) | |
| Idle → sit down | 75 s (`patience`) | |
| Reaction delay after a UI event | 260–480 ms | Reacting on the same frame reads as *part of the UI*; a beat later reads as **noticing** |

---

## 6. Pose construction

- **Clearance.** The upper arm is 34 and the head sits 24 above the neck with
  r20. Any raised-arm pose must be checked against the skull — a wave at 152°
  draws the forearm straight through it. Out-and-then-up (shoulder ~118°, rocking
  in the elbow) clears by ~31.
- **Silhouette at mascot scale.** Arta renders ~100–135 px tall on a page, not
  ~35% of a 1600 px frame as in the film. The film's closed stance merges into a
  single stroke at that size and reads as a lollipop. The mascot's default stance
  is deliberately wider: arms ±14°, legs ±7°.
- **Staging.** Arta rests only on gap centres between page elements, never on top
  of one. Two silhouettes in the same place read as neither.
- **The breath lengthens the spine, never the legs.** Scaling the legs lifts the
  feet off the ground line.
- **A rest pose must still move.** A settled figure breathes, shifts weight and
  drifts its head, at an amplitude that falls to zero the moment it is genuinely
  moving.

---

## 7. The signature gesture

`arta.pointAt(el)` aims at a real DOM element and fires a short arrow.

**Do** use it to answer a question the visitor already has — the primary CTA, the
field that just became relevant, a check that is failing.

**Don't** use it to volunteer information, more than once per screen, or for
anything the visitor did not just cause. An archer who fires constantly is not
an archer.

The arrow is a **short shaft in flight**, not a line from hand to target. The
full-length version reads as a rope strung across the page and cuts through
whatever body copy lies between.

---

## 8. Colour and contrast

**Arta is gold. Arta's tools are blue.**

| | Token | Value | Role |
|---|---|---|---|
| The figure | `--color-arta` | `#E8B923` | Yang — the *why* |
| Anything it wields or makes | `--color-arta-tool` | `#4A72FF` | Yin — the *how* |

The figure is gold `#E8B923` in **both** themes — the mascot is one recognisable
character, and a character that changes colour with the canvas is two.

Tools are blue, which is the brand pair doing narrative work rather than
decorating: the gold figure acts, the blue instrument is what it acts *with*.
Today the only tool is the arrow; the token is the rule, not the exception, so a
bow, a pen or a lamp added later is blue without further discussion.

The tool blue is `--color-yin-light` rather than canonical `#1746DC` because a
tool must read on **both** canvases, and canonical yin measures only ~2.0:1 on
the dark cosmos — the exact mirror of gold's problem on white. `#4A72FF` is
~4.0:1 on the cosmos and ~4.6:1 on white, so one value serves both.

**Recorded honestly:** gold measures **~1.8:1 on the white light canvas**, below
the 3:1 WCAG floor for a non-text graphic, so on light Arta reads as a soft mark
rather than a crisp one. Arta is never the sole carrier of information, so this
is not a blocking failure — but do not add a state that only Arta's colour
communicates. If it ever needs fixing without giving up gold, the lever is a
luminance-only deepening on light (hue stays gold), which is exactly what
`--ico-gold` exists to do for the topic icons.

Never a third accent. Blue is the antagonist's colour in the film, not Arta's.

---

## 9. Accessibility

- **`prefers-reduced-motion`** → one static pose and **zero animation frames ever
  scheduled**. Arta is still there and can still point; the sim is fast-forwarded
  0.6 s so a commanded gesture is shown at rest. Absence is the lazy answer to
  that setting, and painting at t=0 shows the arrow at opacity 0 — invisible.
- Arta is `aria-hidden` unless it is doing a job, in which case it takes a
  `label` describing what it is doing, not what it looks like.
- Arta never carries information alone. Everything it points at is also reachable
  and readable without it.

---

## 10. Performance budget

Measured, not asserted:

| Condition | Frames | Attribute writes |
|---|---|---|
| On screen, calm | 60/s | 362/s |
| Scrolled out of view | **0** | **0** |
| Tab hidden | **0** | **0** |
| `prefers-reduced-motion` | **0** | **0** |

**No React state in the animation loop** — the frame writes attributes onto refs.
Re-rendering a component tree 60 times a second to move a stick figure would be
the most expensive thing on the page and is entirely avoidable.

Whether the loop should run is **recomputed from the element's real rect**, never
remembered. A cached visibility flag is a one-way door: one bad reading and Arta
is dead for the rest of the visit.

---

## 11. Adding a gesture

1. Add a pose function to the library in `arta.ts`. Check clearance (§6).
2. Add the act to the `Act` union and one `case` in the state machine, with a
   timeout. Every act must end by itself.
3. Add one line to the `arta` bus in `Arta.tsx`.
4. Add it to the stage on `/arta` so it is inspectable.
5. Run the stress harness and confirm `data-overspeed` never appears.

An act **must not** be able to start from a non-settled pose without a
transition, and **must not** rely on being interrupted to end.

---

## 12. Verification

Nothing here is believed without measurement. Run:

```
node tools/arta-audit.mjs [url]      # needs the dev Chrome on :9222
```

It exits with the number of failed checks, so CI can gate on it. Thirteen checks
across five groups; current baseline, all passing:

| Check | Measured |
|---|---|
| Runs on screen | 60 rAF/s, 360 attr/s |
| Stops off screen / tab hidden | 0 / 0 |
| Settles into an act | `idle`, 0 changes in 5 s |
| Head oscillation at rest | 0.4 Hz — the breath, and nothing else |
| Head reversals: still / sweeping / realistic hand | 0.5 / 0.8 / 0.5 per second |
| Peak per-frame movement | 12.4 px sampled, `data-overspeed` never raised |
| Reduced motion | 0 frames, 5/5 limbs drawn, arrow at 0.8 |

Run it against **production** too, not just the dev server — the clamp
convergence bug above passed every local run and failed on the first prod run.

**A shake is direction reversals, not amplitude.** The speed limit in §3 cannot
catch one — a head can reverse eight times a second while never exceeding a
fraction of the per-frame budget. Measure reversals, and measure them under a
*realistic* hand (slow drift plus a few px of tremor), not a mouse being shaken
on purpose. Following a deliberate 2.6 Hz input is correct behaviour; the audit
reports that case without asserting on it.

**A failing test is sometimes the test's fault.** Four false failures in this
build: `svg path` matched the deliberately-empty arrow; the off-screen test
scrolled the window while the SPA scrolls an inner container; a per-frame delta
was sampled twice inside one discrete step; and a rect was read before a
smooth-scroll had finished. Check the probe before believing the failure — but
check it *quickly*, because three real bugs hid behind exactly that excuse.

Two thresholds in the audit are deliberately looser than the law they guard, and
both say why in the source: the sampled peak-px bound (a separate rAF can see
two sim frames as one) and the head reversal limit (the breath, weight shift and
tilt drift are three independent oscillations that legitimately sum to ~2/s).

---

## 12b. Planned — rope travel, and Arta everywhere

Operator direction 2026-07-31, **designed but NOT yet built**. Recorded here so
the reasoning survives.

Arta becomes a single page-level companion rather than three per-page stages: one
fixed layer, present on every route. The app-shell question this raises against
the Kaggle-carbon-copy directive is settled in Arta's favour by that same
direction.

**Rope is the travel tool, and it unifies with the signature.** Sagittarius fires
an arrow; the arrow carries the line. So the grapple is not a second mechanic
bolted on, it is the gesture Arta already has, doing work. The rope is blue — it
is a tool (§8), so this follows from the existing rule rather than needing a new
one.

**Rope solves what walking cannot.** Scrolling is vertical and a walker only
travels horizontally, so a walk-only companion can never actually follow the
reader. A line thrown to an anchor gives Arta the vertical axis.

**Travel is planned, not lerped.** Arta picks a goal (the landmark the reader is
currently on), chooses walk for a short horizontal hop or rope for anything far
or vertical, and then takes the time it takes. It must never teleport, and it
must never keep up perfectly — arriving late is the character. If the reader
jumps a long way, Arta is legitimately left behind and has to make its way there.

Constraints it must still satisfy: the §3 speed ceiling applies to a swing exactly
as to a step, the three laws still hold, and a fixed layer must clear the mobile
bottom navigation.

---

## 13. Anti-patterns

Every one of these was actually done here, found by looking, and fixed.

- **A raised arm through the skull.** Wave at 152° from the shoulder.
- **The arrow as a rope.** Drawing hand→target as one line across the page.
- **A lollipop.** Reusing the film's closed stance at mascot scale.
- **`-z-10` on the mascot.** Rendered perfectly, underneath the page background,
  and never once seen.
- **A latched visibility flag.** Loop stopped on a scroll and never restarted.
- **A jammed command queue.** Under reduced motion nothing advances time, so an
  act never reaches its own timeout, `settled` stays false, and every later
  command sits in the queue forever. Reduced motion must **force**, not queue.
- **A gesture painted at t=0.** Its fade-in opacity is 0, so it never appears.
- **Standing on a glyph.** Two silhouettes in one place read as neither.
- **A frozen hold.** A settled pose with no breath is a still image, and the
  clearest tell of cheap animation there is.
- **Correcting a non-linear constraint with one linear step.** The speed clamp
  scaled the blend factor by `budget / moved` once, which assumes displacement is
  linear in that factor. The pose blends linearly but the skeleton resolves
  through sin/cos, so a single correction can still land above the ceiling — and
  it did, at 12.6 px against a 12 px limit, on **production**, where the frame
  timing differs from the dev machine's. Iterate to convergence. A limit that is
  only approximately enforced is a limit that is merely described.
- **A top-level SPA route whose slug is a PREFIX of an existing page.** `/arta`
  301'd to `/artaillustration/` in production and the profile page was
  unreachable, while working perfectly on the dev server. SPA routes here are
  served through WordPress's 404 path, and WP's `redirect_guess_404_permalink`
  fires first, guessing the nearest page. Routes like `games` and `library`
  avoid it by having a real published WP page of the same slug; `/arta` now has
  one too (page 7782296). Check a new top-level route **on production**, not
  only locally — the dev server has no WordPress in front of it.
- **Believing a mid-flight read of a deploy.** A chunk 404ing right after a push
  is usually the sync still applying: WP.com writes `<name>.partial.<hash>` and
  renames. Check for `.partial.` files before concluding anything is missing.
  (And `ls dir/*.js | wc -l` returns 0 when the glob exceeds the argument limit —
  the prod assets directory holds ~39,000 files, because assets accumulate across
  deploys and are never pruned.)
- **Comparing an intent against its own easing value.** The turn trigger tested
  the desired side against `pose.face`, a float mid-ease that is essentially
  never exactly ±1, while the base pose carried the library default of `face: 1`
  and dragged Arta back to facing right every frame. Between them Arta was
  pinned in the `turn` act forever, pulsing its squash at 1.2 Hz — a permanent
  visible shake. **Intent and interpolation must be separate fields**: `facing`
  is exactly ±1 and is what decisions compare against; `pose.face` is the
  continuous value easing toward it and is only ever drawn.
