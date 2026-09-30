// WHY `fps=` WAS REPLACED BY `framestep` — deterministic, with the real filter.
//
// Each source frame carries its own number in the picture; after the rate
// filter we read back WHICH source frame fills each program slot. Timestamp
// jitter is injected with ffmpeg's seeded random(0), so every run is the same.
//
// Needs ffmpeg with lavfi (skipped otherwise):
//   FFMPEG_PATH=/path/to/ffmpeg node test/decimationCadence.test.js
const assert = require('assert');
const { spawnSync } = require('child_process');
const FFMPEG = process.env.FFMPEG_PATH
  || ['../bin/ffmpeg.exe', '../ffmpeg.exe', '../bin/ffmpeg'].map((p) => require('path').join(__dirname, p)).find((p) => require('fs').existsSync(p))
  || 'ffmpeg';
if (spawnSync(FFMPEG, ['-hide_banner', '-version']).status !== 0) {
  console.log(`decimationCadence: no ffmpeg at "${FFMPEG}" — skipped (set FFMPEG_PATH)`);
  process.exit(0);
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// src fps, program fps, ±jitter ms, camera filter → histogram of source steps
function steps(src, prog, jitterMs, chain) {
  const gen = `color=black:s=64x36:r=${src}:d=20,format=gray,geq=lum='mod(N\\,200)',settb=1/1000000,setpts='(N/${src}+(random(0)-0.5)*${jitterMs}/1000)/TB'`;
  const a = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'error', '-f', 'lavfi', '-i', gen, '-filter_complex', `[0:v]${chain}[o]`, '-map', '[o]', '-fps_mode', 'cfr', '-r', String(prog), '-c:v', 'rawvideo', '-f', 'nut', '-'], { maxBuffer: 256 << 20 });
  const b = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'info', '-f', 'nut', '-i', '-', '-vf', 'showinfo', '-f', 'null', '-'], { input: a.stdout, encoding: 'utf8', maxBuffer: 256 << 20 });
  const idx = [...b.stderr.matchAll(/mean:\[(\d+)/g)].map((m) => Number(m[1]));
  const h = {};
  for (let i = 1; i < idx.length; i++) { let d = idx[i] - idx[i - 1]; if (d < 0) d += 200; h[d] = (h[d] || 0) + 1; }
  return h;
}
const share = (h, k) => (h[k] || 0) / Object.values(h).reduce((a, b) => a + b, 0);
const fmt = (h) => Object.entries(h).map(([k, v]) => `${k}×${v}`).join(' ');

console.log('\nthe control: a webcam never decimates');
test('30 → 30 with ±2 ms jitter: every source frame, in order', () => {
  const h = steps(30, 30, 4, 'fps=30'); assert.strictEqual(share(h, 1), 1, fmt(h));
});

console.log('\nthe AVMATRIX: 60 fps card, 30p program');
for (const j of [0, 4]) {
  test(`OLD fps=30, ±${j / 2} ms: the neighbouring frame is shown for a large share of slots`, () => {
    const h = steps(60, 30, j, 'fps=30'); assert.ok(share(h, 2) < 0.8, `expected judder, got ${fmt(h)}`);
  });
  test(`NEW framestep=2, ±${j / 2} ms: exactly every other frame`, () => {
    const h = steps(60, 30, j, 'framestep=2'); assert.strictEqual(share(h, 2), 1, fmt(h));
  });
}

console.log('\n50 → 25');
test('OLD fps=25 judders, NEW framestep=2 is exact', () => {
  const o = steps(50, 25, 4, 'fps=25'), n = steps(50, 25, 4, 'framestep=2');
  assert.ok(share(o, 2) < 0.8, fmt(o)); assert.strictEqual(share(n, 2), 1, fmt(n));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
