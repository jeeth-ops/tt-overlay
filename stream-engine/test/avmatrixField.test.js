// THE OPERATOR'S ACTUAL DEVICE, from the field console.
//
//   [compositor] camera offers 18 mode(s): 1920x1080@60 raw, 640x360@60 raw,
//     640x480@60 raw, 720x480@60 raw, ... 1440x900@60 raw, 1680x1050@60 raw
//   [compositor] camera mode auto-detected: 1440x900@60.0002 (raw)
//   [compositor] ⚠ the camera is opening BELOW the program resolution (1440x900 < 1920x1080)
//   [compositor] [in#0/dshow] real-time buffer [AVMATRIX USB Capture Video]
//     too full (81% of size: 64000000)! frame dropped!  (+112 similar in 60s)
//
// Every mode on this card is FIXED at 60.0002 fps. That broke selection in a
// way that produced the stutter the operator reported:
//
//   carriesRate required  wanted >= floor(minFps)  ->  30 >= 60  ->  false
//   ...for all 18 modes, so nothing was a candidate and selection fell
//   through to "largest mode within the 150 MB/s raw cap" = 1440x900
//   (148.3 MB/s; 1920x1080@60 is 237.3 MB/s and was excluded)
//   -> CPU upscale 1440x900 -> 1920x1080 at 60fps (no GPU scale on this box)
//   -> compositor falls behind -> dshow input buffer overflows -> dropped frames
//
// Run: node stream-engine/test/avmatrixField.test.js
const assert = require('assert');
const { pickCaptureMode, cadenceCheck, buildCompositorArgs } = require('../nativePipeline');
const { validateCaptureMode } = require('../captureModes');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// Reconstructed from the console line, at the real 60.0002 fixed rate.
const SIZES = [
  [1920,1080],[640,360],[640,480],[720,480],[720,576],[768,600],[800,600],
  [856,480],[960,540],[1024,576],[1024,768],[1280,720],[1280,800],[1280,960],
  [1280,1024],[1366,768],[1440,900],[1680,1050],
];
const AVMATRIX = SIZES.map(([w,h]) =>
  `[dshow @ 0]   pixel_format=yuyv422  min s=${w}x${h} fps=60.0002 max s=${w}x${h} fps=60.0002`
).join('\n');

console.log('\nthe operator\'s AVMATRIX card (all modes fixed at 60 fps)');

test('a 60fps-only device IS a candidate for a 30p program — it decimates', () => {
  // The bug: this used to match nothing at all.
  const mode = pickCaptureMode(AVMATRIX, { fps: 30, programWidth: 1920, programHeight: 1080 });
  assert.ok(mode, 'no mode chosen at all — this is the original failure');
  assert.strictEqual(mode.width, 1920, `chose ${mode.width}x${mode.height}`);
  assert.strictEqual(mode.height, 1080);
});

test('it no longer picks 1440×900 for a 1920×1080 program', () => {
  const mode = pickCaptureMode(AVMATRIX, { fps: 30, programWidth: 1920, programHeight: 1080 });
  assert.notStrictEqual(mode.width, 1440, 'this was the choice that forced a CPU upscale');
});

test('an exact match means NO scale filter at all — the expensive step disappears', () => {
  const args = buildCompositorArgs({
    cameraDeviceName: 'AVMATRIX USB Capture Video', audioDeviceName: 'mic',
    width: 1920, height: 1080, fps: 30,
    overlayInputUrl: 'tcp://127.0.0.1:1', cameraVideoSize: '1920x1080', cameraFramerate: 60,
  });
  const cam = args[args.indexOf('-filter_complex') + 1].split(';').find((p) => p.startsWith('[camraw]'));
  assert.ok(!/scale=/.test(cam), `camera branch still scales: ${cam}`);
});

test('the rate filter runs BEFORE the scale, so discarded frames are never scaled', () => {
  const args = buildCompositorArgs({
    cameraDeviceName: 'cam', audioDeviceName: 'mic',
    width: 1920, height: 1080, fps: 30,
    overlayInputUrl: 'tcp://127.0.0.1:1', cameraVideoSize: '1440x900', cameraFramerate: 60,
  });
  const cam = args[args.indexOf('-filter_complex') + 1].split(';').find((p) => p.startsWith('[camraw]'));
  assert.ok(cam.includes('scale='), 'this case does need a scale');
  assert.ok(cam.indexOf('framestep=2') >= 0 && cam.indexOf('framestep=2') < cam.indexOf('scale='),
    `scaling 60fps and throwing half away is what overflowed the input buffer: ${cam}`);
});

test('60 → 30 decimates by COUNT (framestep), never with the fps filter\'s knife-edge grid', () => {
  const args = buildCompositorArgs({
    cameraDeviceName: 'cam', audioDeviceName: 'mic',
    width: 1920, height: 1080, fps: 30,
    overlayInputUrl: 'tcp://127.0.0.1:1', cameraVideoSize: '1920x1080', cameraFramerate: 60.0002,
  });
  const cam = args[args.indexOf('-filter_complex') + 1].split(';').find((p) => p.startsWith('[camraw]'));
  assert.ok(/framestep=2/.test(cam), cam);
  assert.ok(!/fps=/.test(cam), `fps= picks the wrong frame of each pair ~39% of the time: ${cam}`);
});

test('"50i" selected on this 60-fps card does NOT bob progressive frames', () => {
  const args = buildCompositorArgs({
    cameraDeviceName: 'cam', audioDeviceName: 'mic',
    width: 1920, height: 1080, fps: 50, interlacedSource: true,
    overlayInputUrl: 'tcp://127.0.0.1:1', cameraVideoSize: '1920x1080', cameraFramerate: 60.0002,
  });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.ok(!/yadif|bwdif/.test(fc), `60 progressive frames/s are not 25 interlaced ones: ${fc}`);
});

test('a 720×480 program prefers a BIGGER mode and downscales, never the tiny exact one', () => {
  // The card does offer 720x480 natively, but downscaling 1080p ourselves is
  // better than letting the card's firmware do it — and the operator said so.
  const mode = pickCaptureMode(AVMATRIX, { fps: 25, programWidth: 720, programHeight: 480 });
  assert.ok(mode.width >= 720 && mode.height >= 480);
  assert.notStrictEqual(mode.width, 640, 'must never pick a mode smaller than the program');
});

console.log('\ncadence — which rates this card can actually give smoothly');

test('60 → 30 is even, so 30p is smooth on this card', () => {
  const c = cadenceCheck(60.0002, 30);
  assert.strictEqual(c.even, true);
  assert.strictEqual(Math.round(c.ratio), 2);
});

test('60 → 25 is NOT even — 25p on this card judders, and that is arithmetic', () => {
  const c = cadenceCheck(60.0002, 25);
  assert.strictEqual(c.even, false, '60/25 = 2.4; there is no even way to drop 35 of every 60 frames');
});

test('60 → 50 is NOT even either', () => {
  assert.strictEqual(cadenceCheck(60.0002, 50).even, false);
});

test('60 → 60 is a straight pass-through', () => {
  const c = cadenceCheck(60.0002, 60);
  assert.strictEqual(c.even, true);
});

test('asking for more frames than the source makes is never "even"', () => {
  assert.strictEqual(cadenceCheck(30, 60).even, false);
});

console.log('\nwhat the panel tells the operator about this card');

const offered = SIZES.map(([w,h]) => ({ width:w, height:h, minFps:60.0002, maxFps:60.0002, compressed:false }));

test('30p is now reported as SUPPORTED by decimation, not falsely refused', () => {
  const v = validateCaptureMode(offered, { captureFps: 30 });
  assert.strictEqual(v.ok, true, 'a 60fps card can obviously produce 30p');
  assert.strictEqual(v.confidence, 'decimated');
  assert.ok(/2:1/.test(v.detail));
});

test('25p is refused with the REAL reason — uneven cadence — and the smooth rates', () => {
  const v = validateCaptureMode(offered, { captureFps: 25 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.confidence, 'uneven');
  assert.ok(/judder/.test(v.detail), 'the operator must be told why, not just "not available"');
  assert.ok(/30/.test(v.detail), 'and which rates ARE smooth on this card');
});

test('50p is refused for the same real reason, not a bogus "does not offer 50 fps"', () => {
  const v = validateCaptureMode(offered, { captureFps: 50 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.confidence, 'uneven');
  assert.ok(/60 fps/.test(v.detail));
});

test('60p passes as an exact fixed mode', () => {
  const v = validateCaptureMode(offered, { captureFps: 60 });
  assert.strictEqual(v.ok, true);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
