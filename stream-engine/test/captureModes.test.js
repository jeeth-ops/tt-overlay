// vMix-style capture format: 1920×1080 / 1280×720 / 854×480 / 720×480 and
// 25p / 50p / 50i — validated against what the device really offers, and
// never silently changed.
//
// What this replaces: fps was clamped with `[30, 60].includes(n) ? n : 30`
// in three places, so asking for 25 got 30 and nobody was told. A PAL camera
// through an AVMATRIX card runs at 25 or 50; those were not merely missing,
// they were silently rewritten.
//
// Run: node stream-engine/test/captureModes.test.js
const assert = require('assert');
const M = require('../captureModes');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

console.log('\ncapture modes — the formats the operator asked for');

test('all four output resolutions exist, 1920×1080 first and 720×480 last', () => {
  const keys = Object.keys(M.OUTPUT_RESOLUTIONS);
  assert.deepStrictEqual(keys, ['1080p', '720p', '480p', '480sd']);
  assert.deepStrictEqual(M.OUTPUT_RESOLUTIONS['1080p'], { width: 1920, height: 1080, label: '1920×1080', aspect: '16:9' });
  assert.deepStrictEqual(M.OUTPUT_RESOLUTIONS['480sd'], { width: 720, height: 480, label: '720×480', aspect: '4:3' });
});

test('25p, 50p and 50i all exist as real modes', () => {
  for (const k of ['25p', '50p', '50i']) assert.ok(M.VIDEO_MODES[k], `${k} missing`);
  assert.strictEqual(M.VIDEO_MODES['25p'].programFps, 25);
  assert.strictEqual(M.VIDEO_MODES['50p'].programFps, 50);
});

test('25p is 25 end to end — never quietly turned into 30', () => {
  const r = M.resolveOutput('1080p', '25p');
  assert.strictEqual(r.captureFps, 25);
  assert.strictEqual(r.programFps, 25);
  assert.strictEqual(r.width, 1920);
});

test('50i asks the device for 25 interlaced FRAMES and outputs 50p', () => {
  // 50i is 50 fields = 25 frames/sec. dshow counts frames, so 25 is what the
  // device is asked for; the fields then become 50 progressive frames.
  const r = M.resolveOutput('1080p', '50i');
  assert.strictEqual(r.captureFps, 25, 'the device is asked for 25 frames/sec');
  assert.strictEqual(r.programFps, 50, 'each field becomes a frame — that is the point of 50i');
  assert.strictEqual(r.interlacedSource, true);
});

test('the 720×480 @ 25p case the operator named', () => {
  const r = M.resolveOutput('480sd', '25p');
  assert.strictEqual(r.width, 720);
  assert.strictEqual(r.height, 480);
  assert.strictEqual(r.programFps, 25);
  assert.ok(r.bitrateKbps > 0, '25p must have a real bitrate, not undefined');
});

test('every resolution/mode pair has a defined bitrate — the old table had only 30 and 60', () => {
  for (const res of Object.keys(M.OUTPUT_RESOLUTIONS)) {
    for (const mode of Object.keys(M.VIDEO_MODES)) {
      const r = M.resolveOutput(res, mode);
      assert.ok(Number.isFinite(r.bitrateKbps) && r.bitrateKbps > 0, `${res}/${mode} -> ${r.bitrateKbps}`);
    }
  }
});

test('an unknown resolution or mode falls back visibly to a valid one, not to undefined', () => {
  const r = M.resolveOutput('9000p', 'weird');
  assert.strictEqual(r.resolution, '1080p');
  assert.strictEqual(r.mode, '25p');
});

console.log('\ncapability validation — no silent fallback');

// What an AVMATRIX USB card typically reports: one size, a wide fps RANGE.
const avmatrix = [{ width: 1920, height: 1080, minFps: 5, maxFps: 60, compressed: false }];
// What a fixed-mode webcam reports.
const webcam = [
  { width: 1280, height: 720, minFps: 30, maxFps: 30, compressed: false },
  { width: 640, height: 480, minFps: 30, maxFps: 30, compressed: false },
];

test('a fixed mode the device really has is accepted with exact confidence', () => {
  const v = M.validateCaptureMode(webcam, { captureFps: 30, captureWidth: 1280, captureHeight: 720 });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.confidence, 'exact');
});

test('a rate the device does NOT offer is REFUSED, and the refusal lists what it does offer', () => {
  const v = M.validateCaptureMode(webcam, { captureFps: 50, captureWidth: 1280, captureHeight: 720 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.confidence, 'none');
  assert.ok(/does not offer 50 fps/.test(v.detail));
  assert.ok(/1280×720 @ 30fps/.test(v.detail), 'the operator must be told what IS available');
});

test('a size the device does not have is refused too', () => {
  const v = M.validateCaptureMode(webcam, { captureFps: 30, captureWidth: 1920, captureHeight: 1080 });
  assert.strictEqual(v.ok, false);
  assert.ok(/does not offer 1920×1080/.test(v.detail));
});

test('an advertised RANGE is accepted but flagged as a weaker promise — the AVMATRIX trap', () => {
  // This is the exact behaviour that produced wrong-speed recordings: the
  // card accepts any rate in 5–60 and then passes through whatever the
  // camera sends. Accepting it silently is what must not happen.
  const v = M.validateCaptureMode(avmatrix, { captureFps: 50, captureWidth: 1920, captureHeight: 1080 });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.confidence, 'range', 'a range match must not be reported as good as an exact one');
  assert.ok(/pass through/.test(v.detail));
  assert.ok(/req\/actual/.test(v.detail), 'it must point at the measurement that settles it');
});

test('a device that reports nothing is opened unconstrained and says so — not refused', () => {
  const v = M.validateCaptureMode([], { captureFps: 25 });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.confidence, 'unknown');
  assert.ok(/measured once it runs/.test(v.detail));
});

console.log('\ncapture vs output separation');

test('720×480 output does NOT force the camera to 720×480', () => {
  // The operator's explicit instruction. The card keeps its own best mode
  // and the compositor scales once, with a filter we control.
  const chain = M.cameraFilterChain({
    interlacedSource: false, sourceWidth: 1920, sourceHeight: 1080,
    outWidth: 720, outHeight: 480, programFps: 25,
  });
  assert.ok(chain.includes('scale=720:480'), 'the scale happens in the compositor');
  assert.ok(chain.includes('fps=25'));
});

test('no scale filter at all when the source already matches the output', () => {
  const chain = M.cameraFilterChain({
    interlacedSource: false, sourceWidth: 1920, sourceHeight: 1080,
    outWidth: 1920, outHeight: 1080, programFps: 25,
  });
  assert.ok(!chain.includes('scale='), 'resampling a frame to the size it already is, is pure waste');
});

test('50i deinterlaces BEFORE scaling — the other order destroys the fields', () => {
  const chain = M.cameraFilterChain({
    interlacedSource: true, sourceWidth: 1920, sourceHeight: 1080,
    outWidth: 720, outHeight: 480, programFps: 50,
  });
  assert.ok(chain.indexOf('yadif') < chain.indexOf('scale='),
    'scaling first blends the two fields together and they can never be separated again');
  assert.ok(chain.includes('mode=send_field'), 'one frame per field — that is what makes 50i worth shooting');
  assert.ok(chain.includes('parity=-1'), 'field order comes from the stream, never hardcoded');
});

test('a progressive source is never deinterlaced', () => {
  const chain = M.cameraFilterChain({
    interlacedSource: false, sourceWidth: 1920, sourceHeight: 1080,
    outWidth: 1280, outHeight: 720, programFps: 50,
  });
  assert.ok(!chain.includes('yadif'));
});

test('the chain always ends at a fixed rate and a known pixel format', () => {
  const chain = M.cameraFilterChain({ interlacedSource: true, sourceWidth: 1920, sourceHeight: 1080, outWidth: 1920, outHeight: 1080, programFps: 50 });
  assert.ok(chain.includes('setsar=1'));
  assert.ok(chain.endsWith('fps=50,format=yuv420p'));
});

test('the active-format display names every stage, so a mismatch is visible', () => {
  const s = M.activeFormatSummary({
    source: { width: 1920, height: 1080, fps: 25, interlaced: true },
    program: { width: 720, height: 480, fps: 50 },
    recording: { width: 720, height: 480, fps: 50 },
    youtube: { width: 720, height: 480, fps: 50 },
  });
  assert.strictEqual(s.source, '1920×1080 @ 25i');
  assert.strictEqual(s.program, '720×480 @ 50p');
  assert.strictEqual(M.activeFormatSummary({}).source, null);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
