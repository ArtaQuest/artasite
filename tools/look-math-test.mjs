#!/usr/bin/env node
/**
 * Unit tests for artaquest-web/src/lib/look-math.ts — the arithmetic behind the call's Appearance
 * switches (exposure, skin, face finding, framing, the CPU governor). Pure TypeScript in the
 * erasable subset, run under node's own test runner: no test framework, no bundler, no browser.
 *
 *   node tools/look-math-test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Node ≥ 23 strips types natively, and look-math.ts is written in the erasable subset (the app's
// tsconfig enforces `erasableSyntaxOnly`), so the module is imported as it is — no bundler.
const M = await import("../artaquest-web/src/lib/look-math.ts");

const W = M.THUMB_W, H = M.THUMB_H;
const hist = (mean) => { const h = new Uint32Array(256); h[Math.round(mean * 255)] = 5184; return h; };

test("exposure: a lit room is left alone", () => {
  const e = M.exposureFor(hist(0.45));
  assert.equal(e.gain, 1); assert.equal(e.gamma, 1); assert.equal(e.dark, false);
});
test("exposure: a dark room is lifted, darker more, never past the ceilings", () => {
  const a = M.exposureFor(hist(0.25)), b = M.exposureFor(hist(0.12)), c = M.exposureFor(hist(0.03));
  assert.ok(a.dark && a.gain > 1 && a.gamma > 1);
  assert.ok(b.gain > a.gain && b.gamma > a.gamma, "darker lifts more");
  assert.ok(c.gain <= M.MAX_GAIN && c.gamma <= M.MAX_GAMMA);
  // A mean just under the threshold ramps in gently rather than jumping.
  const edge = M.exposureFor(hist(0.33));
  assert.ok(edge.gain > 1 && edge.gain < 1.1, `edge gain ${edge.gain}`);
});
test("exposure: the manual slider is monotone and off at zero", () => {
  assert.equal(M.exposureAt(0).gain, 1);
  assert.ok(M.exposureAt(0.5).gain < M.exposureAt(1).gain);
  assert.ok(M.exposureAt(1).gamma <= M.MAX_GAMMA);
});
test("knee: maps black to black, white to white, lifts the low end by the gain", () => {
  assert.equal(M.knee(0, 2.5), 0);
  assert.equal(M.knee(1, 2.5), 1);
  assert.ok(Math.abs(M.knee(0.01, 2.5) / 0.01 - 2.5) < 0.05);
  assert.ok(M.knee(0.5, 2.5) > 0.5 && M.knee(0.5, 2.5) < 1);
});

test("skin: the three skin tones are skin; sky, grass, paper and night are not", () => {
  assert.ok(M.isSkin(224, 172, 138), "light");
  assert.ok(M.isSkin(198, 134, 66), "medium");
  assert.ok(M.isSkin(110, 70, 45), "dark");
  assert.ok(!M.isSkin(30, 60, 200), "blue");
  assert.ok(!M.isSkin(40, 160, 60), "green");
  assert.ok(!M.isSkin(250, 250, 250), "white");
  assert.ok(!M.isSkin(10, 10, 10), "black");
});

/** A synthetic thumbnail: a skin ellipse (the face) over a bookshelf band of wood colour. */
function scene({ face = { cx: 48, cy: 22, rx: 7, ry: 9 }, shelf = true, stick = false } = {}) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c = [40, 60, 120];                                             // a blue wall
    if (shelf && y >= 4 && y < 8) c = [190, 130, 70];                  // a wooden shelf: skin-coloured chroma, a band
    if (stick && x >= 10 && x < 13 && y >= 10 && y < 50) c = [200, 140, 90]; // an arm-like stick
    if (face && ((x - face.cx) / face.rx) ** 2 + ((y - face.cy) / face.ry) ** 2 <= 1) c = [220, 170, 135];
    const p = (y * W + x) * 4; px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
  }
  return px;
}

test("face: the ellipse is found, the shelf band and the stick are not", () => {
  const box = M.faceFromMask(M.skinMask(scene({ stick: true }), W, H), W, H, null);
  assert.ok(box, "a face");
  const cx = (box.x + box.w / 2) * W, cy = (box.y + box.h / 2) * H;
  assert.ok(Math.abs(cx - 48) < 2 && Math.abs(cy - 22) < 3, `centre ${cx},${cy}`);
  assert.ok(box.w * W >= 12 && box.w * W <= 16, `width ${box.w * W}`);
});
test("face: no face → null, a shelf alone → null", () => {
  assert.equal(M.faceFromMask(M.skinMask(scene({ face: null, shelf: true }), W, H), W, H, null), null);
  assert.equal(M.faceFromMask(new Uint8Array(W * H), W, H, null), null);
});
test("face: a face joined to a neck is trimmed to the head", () => {
  const px = scene({ face: { cx: 48, cy: 22, rx: 7, ry: 9 } });
  for (let y = 30; y < 54; y++) for (let x = 43; x < 54; x++) { const p = (y * W + x) * 4; px[p] = 220; px[p + 1] = 170; px[p + 2] = 135; }
  const box = M.faceFromMask(M.skinMask(px, W, H), W, H, null);
  assert.ok(box && box.h * H <= 15 * 1.35 + 1, `trimmed height ${box && box.h * H}`);
});
test("face: wooden shelf bands that touch the face do not swallow it", () => {
  const px = scene({ face: { cx: 48, cy: 22, rx: 7, ry: 9 }, shelf: false });
  for (const yb of [14, 26]) for (let y = yb; y < yb + 2; y++) for (let x = 0; x < W; x++) { const p = (y * W + x) * 4; px[p] = 190; px[p + 1] = 130; px[p + 2] = 70; }
  const box = M.faceFromMask(M.skinMask(px, W, H), W, H, null);
  assert.ok(box, "found through the bands");
  const cx = (box.x + box.w / 2) * W, cy = (box.y + box.h / 2) * H;
  assert.ok(Math.abs(cx - 48) < 2 && Math.abs(cy - 22) < 3, `centre ${cx},${cy}`);
  assert.ok(box.w * W <= 17, `not the whole row: width ${box.w * W}`);
});
test("face: a skin-coloured shirt under the face yields the head, not the torso", () => {
  const px = scene({ face: { cx: 48, cy: 20, rx: 7, ry: 9 }, shelf: false });
  for (let y = 30; y < 54; y++) for (let x = 20; x < 76; x++) { const p = (y * W + x) * 4; px[p] = 201; px[p + 1] = 184; px[p + 2] = 176; }
  for (let y = 28; y < 31; y++) for (let x = 45; x < 52; x++) { const p = (y * W + x) * 4; px[p] = 220; px[p + 1] = 170; px[p + 2] = 135; } // neck
  const box = M.faceFromMask(M.skinMask(px, W, H), W, H, null);
  assert.ok(box, "found");
  assert.ok(box.w * W <= 17 && box.h * H <= 22, `head only: ${box.w * W}×${box.h * H}`);
  assert.ok(Math.abs((box.x + box.w / 2) * W - 48) < 2);
});
test("face: a bare shoulder line that widens along a curve still ends the head at the chin", () => {
  // The bench scene: a face ellipse, a neck, and a wide skin-toned shirt ellipse whose top starts
  // INSIDE the face rows, so the width profile has no sudden jump at all.
  const px = scene({ face: null, shelf: false });
  const cx = 74, cy = 22, rx = 7.5, ry = 7.5;
  const put = (x, y) => { const p = (y * W + x) * 4; px[p] = 220; px[p + 1] = 170; px[p + 2] = 135; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (((x - cx) / (rx * 3.2)) ** 2 + ((y - (cy + ry * 2.4)) / (ry * 1.6)) ** 2 <= 1) put(x, y); // shirt
    if (x >= cx - rx * 0.45 && x <= cx + rx * 0.45 && y >= cy + ry * 0.7 && y <= cy + ry * 1.5) put(x, y); // neck
    if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) put(x, y);                                        // face
  }
  const box = M.faceFromMask(M.skinMask(px, W, H), W, H, null);
  assert.ok(box, "found");
  assert.ok(box.w * W <= 17 && box.h * H <= 17, );
  assert.ok(Math.abs((box.x + box.w / 2) * W - cx) < 2, "centred on the face");
});
test("face: a room lit only by the screen (a fifth of daylight) still yields the face once lifted", () => {
  const px = scene({ stick: true });
  for (let i = 0; i < px.length; i += 4) { px[i] = Math.round(px[i] * 0.22); px[i + 1] = Math.round(px[i + 1] * 0.22); px[i + 2] = Math.round(px[i + 2] * 0.22); }
  const mean = M.histMean(M.lumaHist(px, W * H));
  assert.ok(mean < 0.15, `dark: ${mean}`);
  const flat = M.faceFromMask(M.skinMask(px, W, H), W, H, null);
  const lifted = M.faceFromMask(M.skinMask(px, W, H, M.thumbGain(mean)), W, H, null);
  assert.ok(lifted, "found once lifted" + (flat ? " (and even unlifted)" : ""));
  const cx = (lifted.x + lifted.w / 2) * W, cy = (lifted.y + lifted.h / 2) * H;
  assert.ok(Math.abs(cx - 48) < 2 && Math.abs(cy - 22) < 3, `centre ${cx},${cy}`);
});
test("motion: nothing passes until warm; a still shelf never passes; a moving face does", () => {
  const m = new M.Motion(W, H);
  const still = new Uint8Array(W * H).fill(90);
  const faceBox = { x: 0.45, y: 0.25, w: 0.15, h: 0.3 }, shelfBox = { x: 0.05, y: 0.05, w: 0.3, h: 0.15 };
  for (let t = 0; t < 4; t++) m.observe(still);
  assert.equal(m.gate(faceBox), false, "cold");
  for (let t = 0; t < 12; t++) m.observe(still);
  assert.ok(m.warm); assert.equal(m.gate(faceBox), false, "a still picture passes nothing");
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let t = 0; t < 20; t++) {
    const f = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 90 + (rnd() - 0.5) * 4;
      if (x / W >= faceBox.x && x / W < faceBox.x + faceBox.w && y / H >= faceBox.y && y / H < faceBox.y + faceBox.h) v += (t % 2 ? 8 : -8);
      f[y * W + x] = v;
    }
    m.observe(f);
  }
  assert.ok(m.gate(faceBox), `face moves: ${m.energy(faceBox).toFixed(2)}`);
  assert.equal(m.gate(shelfBox), false, `shelf still: ${m.energy(shelfBox).toFixed(2)}`);
  for (let t = 0; t < 32; t++) m.observe(still);
  assert.ok(m.gate(faceBox), "held through a pause");
  for (let t = 0; t < 60; t++) m.observe(still);
  assert.equal(m.gate(faceBox), false, "gone after a long stillness");
});
test("face: with a gate, a skin-coloured square of furniture in the middle loses to the face beside it", () => {
  const px = scene({ face: { cx: 24, cy: 22, rx: 7, ry: 9 }, shelf: false });
  for (let y = 14; y < 30; y++) for (let x = 40; x < 56; x++) { const p = (y * W + x) * 4; px[p] = 190; px[p + 1] = 130; px[p + 2] = 70; }
  const mask = M.skinMask(px, W, H);
  const ungated = M.faceFromMask(mask, W, H, null);
  assert.ok(ungated && Math.abs((ungated.x + ungated.w / 2) * W - 48) < 3, "without the gate the furniture wins (it is bigger and central)");
  const gated = M.faceFromMask(mask, W, H, null, (b) => (b.x + b.w / 2) * W < 40);
  assert.ok(gated && Math.abs((gated.x + gated.w / 2) * W - 24) < 2, "with it, the face");
});
test("framer: the heuristic path zooms less", () => {
  const face = { x: 0.45, y: 0.3, w: 0.06, h: 0.08 };
  assert.ok(M.frameFor(face, 16 / 9, 16 / 9, 1.7).h > M.frameFor(face, 16 / 9, 16 / 9, 2).h);
  const fr = new M.Framer(16 / 9, 16 / 9, 1.7); fr.observe(face, 0); fr.observe(face, 700);
  assert.ok(fr.goal.h >= 1 / 1.7 - 1e-9);
});
test("pico: the shipped cascade unpacks, rejects flat grey, and finds nothing where there is nothing", async () => {
  const P = await import("../artaquest-web/src/lib/pico.ts");
  const { readFileSync } = await import("node:fs");
  const bytes = new Uint8Array(readFileSync(new URL("../artaquest-web/public/look/facefinder", import.meta.url)));
  const dv = new DataView(bytes.buffer);
  assert.equal(dv.getInt32(8, true), 6, "tree depth"); assert.equal(dv.getInt32(12, true), 468, "trees");
  const classify = P.unpackCascade(bytes);
  const flat = new Uint8Array(320 * 180).fill(128);
  assert.equal(classify(90, 160, 60, flat, 320), -1, "flat grey is not a face");
  const dets = P.runCascade(flat, 180, 320, classify, { minsize: 28, maxsize: 180, shiftfactor: 0.12, scalefactor: 1.1 });
  assert.equal(dets.length, 0);
  // Clustering: three overlapping hits become one with the summed score; a distant one stays apart.
  const cl = P.clusterDetections([{ r: 50, c: 50, s: 40, q: 30 }, { r: 52, c: 51, s: 40, q: 25 }, { r: 49, c: 50, s: 44, q: 20 }, { r: 150, c: 250, s: 40, q: 10 }]);
  assert.equal(cl.length, 2); assert.ok(Math.abs(cl[0].q - 75) < 1e-9);
  const face = P.bestFace(cl, 320, 180, 60);
  assert.ok(face && Math.abs(face.x * 320 - (cl[0].c - cl[0].s / 2)) < 1e-9 && face.q === cl[0].q);
  assert.equal(P.bestFace(cl, 320, 180, 80), null, "below the score floor");
});
test("opening: thin lines vanish, a block survives", () => {
  const m = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) m[10 * W + x] = 1;                          // a 1-cell line
  for (let y = 20; y < 32; y++) for (let x = 40; x < 52; x++) m[y * W + x] = 1; // a 12×12 block
  const o = M.opened(m, W, H);
  let line = 0, block = 0; for (let x = 0; x < W; x++) line += o[10 * W + x]; for (let y = 20; y < 32; y++) for (let x = 40; x < 52; x++) block += o[y * W + x];
  assert.equal(line, 0); assert.equal(block, 144);
});
test("histogram: the mean of a synthetic scene is what the pixels say", () => {
  const px = scene();
  let sum = 0; for (let i = 0; i < W * H * 4; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  const m = M.histMean(M.lumaHist(px, W * H));
  assert.ok(Math.abs(m - sum / (W * H) / 255) < 0.01);
});

test("frame: the crop stays inside the picture, keeps the output shape, never zooms past 2×", () => {
  for (const f of [{ x: 0.9, y: 0.05, w: 0.1, h: 0.14 }, { x: 0, y: 0.8, w: 0.05, h: 0.07 }, { x: 0.4, y: 0.3, w: 0.2, h: 0.28 }]) {
    const c = M.frameFor(f, 16 / 9, 16 / 9);
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001, JSON.stringify(c));
    assert.ok(Math.abs(c.w / c.h - 1) < 1e-9, "same aspect as source when shapes match");
    assert.ok(c.h >= 1 / M.MAX_ZOOM - 1e-9, `zoom cap ${c.h}`);
  }
  // A 16:9 source shown 4:3: the crop is narrower than it is tall, in normalised units.
  const c = M.frameFor({ x: 0.4, y: 0.3, w: 0.2, h: 0.28 }, 16 / 9, 4 / 3);
  assert.ok(Math.abs((c.w * 16 / 9) / c.h - 4 / 3) < 1e-9);
});
test("framer: a small fidget never moves the picture; a real move glides after it settles", () => {
  const fr = new M.Framer(16 / 9, 16 / 9);
  const face = { x: 0.6, y: 0.25, w: 0.12, h: 0.16 };
  fr.observe(face, 0);
  assert.deepEqual(fr.goal, M.fullFrame(16 / 9, 16 / 9), "pending, not yet the target");
  fr.observe(face, 700);
  const goal = fr.goal;
  assert.notDeepEqual(goal, M.fullFrame(16 / 9, 16 / 9), "settled → target");
  // Fidget: 3% of the crop.
  fr.observe({ ...face, x: face.x + goal.w * 0.03 }, 1000); fr.observe({ ...face, x: face.x + goal.w * 0.03 }, 1700);
  assert.deepEqual(fr.goal, goal, "dead zone");
  // Glide: after two seconds of stepping, within 1% of the target.
  let c; for (let t = 0; t < 2000; t += 33) c = fr.step(33);
  assert.ok(Math.abs(c.x - goal.x) < 0.01 && Math.abs(c.w - goal.w) < 0.01, `glided ${JSON.stringify(c)}`);
  // A monotone approach: no overshoot.
  const fr2 = new M.Framer(16 / 9, 16 / 9); fr2.observe(face, 0); fr2.observe(face, 700);
  let prev = fr2.crop.x, dir = Math.sign(fr2.goal.x - prev);
  for (let t = 0; t < 3000; t += 33) { const x = fr2.step(33).x; assert.ok(Math.sign(x - prev) === dir || x === prev, "no overshoot"); prev = x; }
});
test("framer: losing the face for four seconds returns to the wide shot", () => {
  const fr = new M.Framer(16 / 9, 16 / 9);
  const face = { x: 0.6, y: 0.25, w: 0.12, h: 0.16 };
  fr.observe(face, 0); fr.observe(face, 700);
  fr.observe(null, 2000); assert.notDeepEqual(fr.goal, M.fullFrame(16 / 9, 16 / 9), "holds briefly");
  fr.observe(null, 5000); assert.deepEqual(fr.goal, M.fullFrame(16 / 9, 16 / 9), "then goes wide");
});

test("governor: over budget steps down within two seconds, one rung at a time; well under climbs back slowly", () => {
  const g = new M.Governor(2);
  for (let i = 0; i < 40; i++) g.record(15, 33);     // 45% of the interval, 1.3 s
  assert.equal(g.level, 2, "not yet — two seconds over first");
  for (let i = 0; i < 30; i++) g.record(15, 33);     // 2.3 s
  assert.equal(g.level, 1, "one rung after two seconds over");
  for (let i = 0; i < 70; i++) g.record(15, 33);
  assert.equal(g.level, 0, "then passthrough, another two seconds later");
  for (let i = 0; i < 300; i++) g.record(1, 33);     // 3%, ten seconds
  assert.equal(g.level, 0, "not yet — up is slow");
  for (let i = 0; i < 400; i++) g.record(1, 33);
  assert.equal(g.level, 1, "one rung back after twenty seconds");
  for (let i = 0; i < 700; i++) g.record(8, 33);     // 24%: the middle band holds
  assert.equal(g.level, 1, "a cost between the bands changes nothing");
});
