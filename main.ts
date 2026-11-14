// food-picture-01 — "Golden Hour Ramen"
// A steaming bowl of ramen with a soft egg, chashu, chopsticks and warm
// golden light, drawn procedurally in code (own PNG encoder, Node stdlib
// only). Deterministic: fixed seed, no clock, no network, no model calls.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

const W = 1024;
const H = 1024;
const img = new Uint8Array(W * H * 4);

// ---------- deterministic PRNG (mulberry32, fixed seed) ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261114);

// ---------- tiny colour helpers ----------
type RGB = [number, number, number];
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function lerpC(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
function clamp255(v: number) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// ---------- framebuffer ----------
function blend(x: number, y: number, r: number, g: number, b: number, a: number) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || xi >= W || yi < 0 || yi >= H || a <= 0) return;
  const i = (yi * W + xi) * 4;
  const ia = 1 - a;
  img[i] = clamp255(r * a + img[i] * ia);
  img[i + 1] = clamp255(g * a + img[i + 1] * ia);
  img[i + 2] = clamp255(b * a + img[i + 2] * ia);
  img[i + 3] = 255;
}
function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1) {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
      blend(x, y, c[0], c[1], c[2], a);
    }
  }
}
// soft-edged filled circle
function disc(cx: number, cy: number, r: number, c: RGB, a = 1) {
  const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(W - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(H - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.min(1, Math.max(0, r + 0.5 - d));
      if (cov > 0) blend(x, y, c[0], c[1], c[2], a * cov);
    }
  }
}
// soft-edged filled ellipse
function ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1) {
  const x0 = Math.max(0, Math.floor(cx - rx - 1)), x1 = Math.min(W - 1, Math.ceil(cx + rx + 1));
  const y0 = Math.max(0, Math.floor(cy - ry - 1)), y1 = Math.min(H - 1, Math.ceil(cy + ry + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      const cov = Math.min(1, Math.max(0, (1 - d) * Math.min(rx, ry) + 0.5));
      if (cov > 0) blend(x, y, c[0], c[1], c[2], a * cov);
    }
  }
}
// smooth radial glow without banding (per-pixel falloff)
function softGlow(cx: number, cy: number, rx: number, ry: number, c: RGB, peak: number) {
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 1) continue;
      const f = (1 - d2) * (1 - d2);
      blend(x, y, c[0], c[1], c[2], peak * f);
    }
  }
}

function radialEllipse(cx: number, cy: number, rx: number, ry: number, cIn: RGB, cOut: RGB, steps = 28, a = 1) {
  for (let s = steps; s >= 1; s--) {
    const t = s / steps;
    ellipse(cx, cy, rx * t, ry * t, lerpC(cIn, cOut, 1 - t), a);
  }
}
// thick line with round caps, drawn as a chain of discs
function thickLine(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a = 1) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(2, Math.ceil(len / (w * 0.4)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    disc(lerp(x0, x1, t), lerp(y0, y1, t), w / 2, c, a);
  }
}
// wavy stroke: polyline through sine offsets
function wavy(x0: number, y0: number, x1: number, y1: number, amp: number, waves: number, phase: number, w: number, c: RGB, a = 1) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(8, Math.ceil(len / 6));
  let px = x0, py = y0;
  const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const off = Math.sin(t * waves * Math.PI * 2 + phase) * amp;
    const x = lerp(x0, x1, t) + nx * off;
    const y = lerp(y0, y1, t) + ny * off;
    thickLine(px, py, x, y, w, c, a);
    px = x; py = y;
  }
}
// value noise for texture (seeded hash, deterministic)
function hash2(ix: number, iy: number) {
  let h = (ix * 374761393 + iy * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967295);
}
function vnoise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

// ---------- PNG encoder (zlib deflate, filter 0) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}
function encodePNG(): Buffer {
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4, d = y * (1 + W * 3) + 1 + x * 3;
      raw[d] = img[s]; raw[d + 1] = img[s + 1]; raw[d + 2] = img[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ================= THE PICTURE =================
// 1. Background: dark warm room, vertical gradient
for (let y = 0; y < H; y++) {
  const t = y / H;
  const c = lerpC([26, 14, 7], [58, 32, 15], t);
  fillRect(0, y, W, y + 1, c);
}
// 2. Warm golden glow, upper left (the light source) — smooth, no banding
softGlow(330, 260, 620, 470, [255, 176, 84], 0.34);
softGlow(300, 220, 380, 280, [255, 200, 120], 0.22);
// 3. Wooden table: bottom half, warm dark planks
for (let y = 700; y < H; y++) {
  const t = (y - 700) / (H - 700);
  fillRect(0, y, W, y + 1, lerpC([74, 44, 20], [46, 25, 11], t));
}
// plank seams with a gentle wave
for (const py of [782, 872, 956]) {
  for (let x = 0; x < W; x += 4) {
    const yy = py + Math.sin(x * 0.008) * 2;
    thickLine(x, yy, x + 4, yy, 2.5, [30, 16, 7], 0.55);
  }
}
// wood grain speckle (seeded)
for (let i = 0; i < 2600; i++) {
  const x = rand() * W, y = 700 + rand() * (H - 700);
  const v = vnoise(x * 0.05, y * 0.05);
  blend(x, y, v > 0.5 ? 120 : 40, v > 0.5 ? 72 : 22, v > 0.5 ? 34 : 10, 0.10 + v * 0.08);
}

// 4. Soft shadow under the bowl
ellipse(512, 872, 330, 52, [8, 4, 2], 0.55);
ellipse(512, 866, 300, 44, [12, 6, 3], 0.45);

// 5. Bowl body — deep lacquer red with a warm rim
radialEllipse(512, 660, 372, 196, [146, 32, 24], [74, 14, 10], 30);
ellipse(512, 828, 210, 30, [40, 8, 6], 0.28); // soft shading at the bowl's base
// glossy highlight on the bowl's left curve
for (let i = 0; i < 26; i++) {
  const t = i / 25;
  const x = 512 - 330 + t * 150;
  const y = 700 + Math.sin(t * Math.PI) * 90;
  disc(x, y, 26 - t * 12, [255, 120, 70], 0.05);
}
// thin gold band under the rim
ellipse(512, 612, 352, 128, [212, 142, 52], 0.55);
ellipse(512, 610, 344, 122, [146, 32, 24], 1);

// 6. Broth — golden, rich, glossy
radialEllipse(512, 606, 336, 116, [238, 164, 62], [168, 92, 22], 30);
// darker broth edge ring (subtle)
for (let s = 30; s >= 24; s--) {
  const t = s / 30;
  ellipse(512, 606, 336 * t, 116 * t, [168, 92, 22], 0.05);
}
// broth sheen: bright arc top-left
for (let i = 0; i < 40; i++) {
  const t = i / 39;
  const ang = Math.PI * (1.05 + t * 0.5);
  disc(512 + Math.cos(ang) * 250, 606 + Math.sin(ang) * 82, 30 - t * 10, [255, 214, 130], 0.06);
}
// chilli-oil swirls
for (let i = 0; i < 9; i++) {
  const x = 300 + rand() * 420, y = 560 + rand() * 90;
  disc(x, y, 12 + rand() * 22, [196, 52, 12], 0.16);
  disc(x + 6, y + 3, 6 + rand() * 10, [232, 90, 26], 0.20);
}

// 7. Noodles — wavy golden strands, clipped to the broth ellipse
const noodleCols: RGB[] = [[246, 196, 83], [232, 169, 60], [214, 143, 43], [250, 214, 110]];
for (let n = 0; n < 46; n++) {
  const yBase = 540 + rand() * 130;
  const x0 = 210 + rand() * 60, x1 = 760 + rand() * 50;
  const amp = 6 + rand() * 10, waves = 2 + rand() * 3, phase = rand() * Math.PI * 2;
  const col = noodleCols[Math.floor(rand() * noodleCols.length)];
  // draw in short segments so we can clip to the broth ellipse
  const len = x1 - x0, segs = 60;
  let px = x0, py = yBase;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const x = x0 + t * len;
    const y = yBase + Math.sin(t * waves * Math.PI * 2 + phase) * amp;
    const ex = (x - 512) / 330, ey = (y - 606) / 112;
    if (ex * ex + ey * ey < 0.96) thickLine(px, py, x, y, 7.5, col, 0.95);
    px = x; py = y;
  }
}
// noodle highlight strands (a few bright ones on top)
for (let n = 0; n < 10; n++) {
  const yBase = 545 + rand() * 120;
  wavy(260 + rand() * 40, yBase, 720 + rand() * 40, yBase + (rand() - 0.5) * 20,
    8 + rand() * 8, 2.5 + rand() * 2, rand() * 6, 4, [255, 226, 140], 0.8);
}

// 8. Nori sheet standing at the back — shorter, wider, slightly tilted
for (let i = 0; i < 16; i++) {
  const t = i / 15;
  const x = 612 + t * 58;
  thickLine(x, 508 - t * 10, x + 5, 598, 8, [24, 44, 22], 0.95);
}
thickLine(614, 506, 618, 596, 3, [52, 84, 44], 0.7); // nori edge sheen
ellipse(640, 545, 30, 52, [36, 62, 32], 0.22); // nori sheen

// 9. Chashu slices — pink, rolled, glossy
function chashu(cx: number, cy: number, r: number) {
  radialEllipse(cx, cy, r, r * 0.92, [226, 150, 122], [168, 88, 66], 18);
  // fat ring
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    disc(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.57, 7, [244, 214, 186], 0.85);
  }
  // inner spiral
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 3.4;
    const rr = r * 0.12 + (i / 60) * r * 0.34;
    disc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.92, 4.5, [190, 110, 84], 0.7);
  }
  // gloss dot
  disc(cx - r * 0.3, cy - r * 0.35, r * 0.16, [255, 228, 205], 0.5);
}
chashu(668, 640, 62);
chashu(724, 588, 50);

// 10. Soft egg — two halves, creamy orange yolk
function eggHalf(cx: number, cy: number, s: number) {
  radialEllipse(cx, cy, 62 * s, 50 * s, [252, 240, 214], [228, 204, 168], 14);
  radialEllipse(cx, cy, 34 * s, 30 * s, [255, 176, 60], [226, 118, 16], 16);
  disc(cx - 10 * s, cy - 10 * s, 9 * s, [255, 214, 130], 0.75); // yolk gloss
  disc(cx + 12 * s, cy + 8 * s, 5 * s, [240, 140, 30], 0.5);
}
eggHalf(392, 592, 1.0);
eggHalf(330, 648, 0.82);

// 11. Green onions — little rings scattered on the broth
for (let i = 0; i < 26; i++) {
  const x = 260 + rand() * 500, y = 545 + rand() * 120;
  const ex = (x - 512) / 330, ey = (y - 606) / 112;
  if (ex * ex + ey * ey > 0.9) continue;
  const r = 5 + rand() * 3.5;
  disc(x, y, r, [88, 178, 72], 0.95);
  disc(x, y, r * 0.45, [36, 96, 38], 0.95);
  disc(x - r * 0.3, y - r * 0.3, r * 0.25, [165, 225, 135], 0.8);
}

// 12. Sesame seeds
for (let i = 0; i < 46; i++) {
  const x = 260 + rand() * 500, y = 545 + rand() * 120;
  const ex = (x - 512) / 330, ey = (y - 606) / 112;
  if (ex * ex + ey * ey > 0.9) continue;
  disc(x, y, 2.6, [250, 232, 196], 0.9);
}

// 13. Chopsticks — warm wood, resting across the rim
thickLine(636, 452, 952, 330, 15, [146, 96, 48], 1);
thickLine(636, 452, 952, 330, 15, [120, 74, 34], 0.25);
thickLine(648, 490, 960, 368, 15, [168, 112, 58], 1);
thickLine(648, 490, 960, 368, 15, [120, 74, 34], 0.25);
// chopstick tips (darker, tapered look)
disc(952, 330, 7, [96, 58, 26], 0.9);
disc(960, 368, 7, [96, 58, 26], 0.9);
// soft shadow of chopsticks on the broth
thickLine(656, 506, 946, 384, 10, [90, 48, 12], 0.15);

// 14. Steam — soft white wisps rising from the bowl
function steamColumn(cx: number, baseY: number, topY: number, drift: number, phase: number) {
  const steps = 52;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const y = lerp(baseY, topY, t);
    const x = cx + Math.sin(t * Math.PI * 2.4 + phase) * (5 + t * drift) + t * drift * 0.6;
    const r = 20 + t * 42;
    const a = 0.055 * (1 - t * 0.6) * (0.8 + 0.2 * Math.sin(t * 7 + phase));
    disc(x, y, r, [255, 246, 232], Math.max(0.015, a));
  }
}
steamColumn(420, 520, 230, 34, 0.4);
steamColumn(512, 500, 190, 44, 2.1);
steamColumn(606, 520, 250, 30, 4.0);

// 15. Final warm light: soft highlight on the rim + vignette
for (let i = 0; i < 30; i++) {
  const t = i / 29;
  const ang = Math.PI * (1.15 + t * 0.35);
  disc(512 + Math.cos(ang) * 348, 606 + Math.sin(ang) * 118, 22, [255, 190, 110], 0.05);
}
// vignette: darken edges
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0.72) {
      const f = Math.min(0.42, (d - 0.72) * 1.1);
      const i = (y * W + x) * 4;
      img[i] = clamp255(img[i] * (1 - f));
      img[i + 1] = clamp255(img[i + 1] * (1 - f));
      img[i + 2] = clamp255(img[i + 2] * (1 - f));
    }
  }
}

// ---------- write output ----------
const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "entry.png");
writeFileSync(outPath, encodePNG());
console.log("wrote", outPath);
