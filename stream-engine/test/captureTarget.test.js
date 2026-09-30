// WHAT IS ACTUALLY REQUESTED FROM THE AVMATRIX DEVICE.
//
// Adding dropdown options proves nothing. These tests drive the real
// pickCaptureMode against real `ffmpeg -f dshow -list_options` text and pin
// the two bugs that survived the UI work:
//
//  BUG A  The camera mode was chosen with
//           pickCameraMode(out, this.width, this.height, this.fps)
//         — targeting the PROGRAM resolution, with a sort preferring
//         area <= target. So selecting a 720x480 program made the engine ask
//         the AVMATRIX card for a ~720x480-or-smaller mode: the HDMI source
//         is 1920x1080 and the engine threw that away AT THE DEVICE, in the
//         card's firmware, before any filter could do a controlled downscale.
//
//  BUG B  `this.fps` is the PROGRAM rate, which for 50i is 50. But 50i is
//         50 FIELDS = 25 interlaced FRAMES and dshow counts frames, so the
//         device was asked for a mode it does not have.
//
// Run: node stream-engine/test/captureTarget.test.js
const assert = require('assert');
const { pickCaptureMode, parseDshowVideoModes } = require('../nativePipeline');
const { resolveOutput, modesFor, isAllowedCombination, captureMatch } = require('../captureModes');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// Real shape of what an AVMATRIX USB Capture card reports: one large size,
// a wide fps RANGE (it passes the HDMI signal through), plus small legacy
// modes the driver also advertises.
const AVMATRIX = `
[dshow @ 0000] DirectShow video device options (from video devices)
[dshow @ 0000]  Pin "Capture" (alternative pin name "0")
[dshow @ 0000]   vcodec=mjpeg  min s=1920x1080 fps=5 max s=1920x1080 fps=60
[dshow @ 0000]   pixel_format=yuyv422  min s=1920x1080 fps=5 max s=1920x1080 fps=30
[dshow @ 0000]   pixel_format=yuyv422  min s=1280x720 fps=5 max s=1280x720 fps=60
[dshow @ 0000]   pixel_format=yuyv422  min s=720x480 fps=5 max s=720x480 fps=60
[dshow @ 0000]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=60
`;

console.log('\nwhat the device is asked for');

test('the AVMATRIX report parses to the modes it really offers', () => {
  const modes = parseDshowVideoModes(AVMATRIX);
  assert.ok(modes.length >= 4, `parsed only ${modes.length}`);
  assert.ok(modes.some((m) => m.width === 1920 && m.height === 1080));
  assert.ok(modes.some((m) => m.width === 720 && m.height === 480));
});

test('BUG A — a 720×480 program must NOT ask the card for 720×480', () => {
  // The operator's explicit instruction. No ceiling is passed, so the card
  // keeps its native format and the compositor scales down under our control.
  const mode = pickCaptureMode(AVMATRIX, { fps: 25 });
  assert.strictEqual(mode.width, 1920, `asked the card for ${mode.width}x${mode.height} — the HDMI source is 1920x1080`);
  assert.strictEqual(mode.height, 1080);
});

test('a 1080p program also captures 1920×1080 — the native format either way', () => {
  const mode = pickCaptureMode(AVMATRIX, { fps: 25 });
  assert.strictEqual(mode.width, 1920);
});

test('BUG B — 50i asks the device for 25 frames, not 50', () => {
  const out = resolveOutput('1080p', '50i');
  assert.strictEqual(out.captureFps, 25, 'dshow counts FRAMES; 50i is 25 interlaced frames');
  assert.strictEqual(out.programFps, 50, 'each field becomes a frame downstream');
  // And that capture rate is the one a mode must be able to carry.
  const mode = pickCaptureMode(AVMATRIX, { fps: out.captureFps });
  assert.ok(mode.minFps <= 25 && mode.maxFps >= 25, 'the chosen mode must actually carry 25');
});

test('50p asks for a mode that can really carry 50', () => {
  const out = resolveOutput('1080p', '50p');
  assert.strictEqual(out.captureFps, 50);
  const mode = pickCaptureMode(AVMATRIX, { fps: 50 });
  assert.ok(mode.maxFps >= 50, `picked a mode capped at ${mode.maxFps} for a 50fps request`);
});

test('a mode that cannot carry the rate is not chosen when one that can exists', () => {
  // 1080p here tops out at 30; 720p reaches 60. A 50fps request must land on
  // a mode that can actually carry it rather than the largest size.
  const capped = `
[dshow @ 0]   pixel_format=yuyv422  min s=1920x1080 fps=5 max s=1920x1080 fps=30
[dshow @ 0]   pixel_format=yuyv422  min s=1280x720 fps=5 max s=1280x720 fps=60
`;
  const mode = pickCaptureMode(capped, { fps: 50 });
  assert.strictEqual(mode.width, 1280, 'size must not win over being able to deliver the rate');
  assert.ok(mode.maxFps >= 50);
});

test('an EXACT match with the program size wins — it needs no scale filter at all', () => {
  // The program size is a preference, not a ceiling (that earlier semantics
  // was wrong: it made "largest mode under the ceiling" the goal, which on a
  // real card chose a SMALLER mode than the program and forced a CPU upscale).
  // The cheapest possible graph is the one with no scale in it.
  const mode = pickCaptureMode(AVMATRIX, { fps: 25, programWidth: 1280, programHeight: 720 });
  assert.strictEqual(mode.width, 1280, `expected the exact 1280x720 mode, got ${mode.width}x${mode.height}`);
  assert.strictEqual(mode.height, 720);
});

test('with no exact mode, a BIGGER one is chosen and downscaled — never a smaller one upscaled', () => {
  const noExact = `
[dshow @ 0]   pixel_format=yuyv422  min s=1920x1080 fps=5 max s=1920x1080 fps=60
[dshow @ 0]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=60
`;
  const mode = pickCaptureMode(noExact, { fps: 25, programWidth: 1280, programHeight: 720 });
  assert.strictEqual(mode.width, 1920, 'an upscale from 640x480 would be soft and pointless');
});

test('a device that reports nothing yields no constraint rather than a guess', () => {
  assert.strictEqual(pickCaptureMode('no modes here', { fps: 25 }), null);
});

console.log('\nthe four production profiles');

test('720×480 offers ONLY 25p — 50p/50i are not shown or accepted there', () => {
  assert.deepStrictEqual(modesFor('480sd'), ['25p']);
  assert.strictEqual(isAllowedCombination('480sd', '50p'), false);
  assert.strictEqual(isAllowedCombination('480sd', '50i'), false);
  assert.strictEqual(isAllowedCombination('480sd', '25p'), true);
});

test('1920×1080 offers 25p, 50p and 50i', () => {
  for (const m of ['25p', '50p', '50i']) assert.strictEqual(isAllowedCombination('1080p', m), true, m);
});

test('all four required profiles resolve to the right real numbers', () => {
  const cases = [
    ['1080p', '25p', 1920, 1080, 25, 25, false],
    ['1080p', '50p', 1920, 1080, 50, 50, false],
    ['1080p', '50i', 1920, 1080, 25, 50, true],
    ['480sd', '25p', 720,  480,  25, 25, false],
  ];
  for (const [res, mode, w, h, capFps, progFps, inter] of cases) {
    const o = resolveOutput(res, mode);
    assert.strictEqual(o.width, w, `${res}/${mode} width`);
    assert.strictEqual(o.height, h, `${res}/${mode} height`);
    assert.strictEqual(o.captureFps, capFps, `${res}/${mode} capture fps`);
    assert.strictEqual(o.programFps, progFps, `${res}/${mode} program fps`);
    assert.strictEqual(o.interlacedSource, inter, `${res}/${mode} interlaced`);
  }
});

test('an unsupported combination does not silently become another resolution', () => {
  const o = resolveOutput('480sd', '50p');   // not offered
  assert.strictEqual(o.resolution, '480sd', 'the resolution the operator chose is kept');
  assert.strictEqual(o.mode, '25p', 'and the mode falls back to the one that IS offered');
});

console.log('\nrequested vs actual');

test('a matching rate reads MATCHED', () => {
  assert.strictEqual(captureMatch(50, 50).status, 'matched');
  assert.strictEqual(captureMatch(25, 24.9).status, 'matched', 'small wobble is not a fault');
});

test('the AVMATRIX case — asked 50, getting 25 — reads MISMATCH with both numbers', () => {
  const m = captureMatch(50, 25);
  assert.strictEqual(m.status, 'mismatch');
  assert.strictEqual(m.requestedFps, 50);
  assert.strictEqual(m.actualFps, 25);
});

test('no measurement yet is "measuring", never a silent MATCHED', () => {
  assert.strictEqual(captureMatch(50, null).status, 'measuring');
  assert.strictEqual(captureMatch(null, null).status, 'unknown');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
