// "20 Mbps ka internet me bhi lag hoke live ho raha hai YouTube me."
//
// Not a bandwidth problem. The program feed (compositor) was hardcoded to
// 30fps while the operator could select 60 for the stream, and the live
// encoder was then told `-fps_mode cfr -r 60`. ffmpeg duplicates each frame
// to fill the grid, so YouTube receives 60fps of which half are duplicates:
// uneven cadence (which YouTube reports as "not receiving enough video"),
// juddery motion, and half the CBR bitrate spent re-sending frames the
// viewer already has. On any connection, at any speed.
//
// The rule: you cannot send more real frames than the program feed makes.
//
// Run: node stream-engine/test/programFps.test.js
const assert = require('assert');
const { effectiveOutputFps, buildLiveEncoderArgs, buildRecorderEncoderArgs } = require('../nativePipeline');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
// The value of -r in an argv array.
function outRate(args) {
  const i = args.lastIndexOf('-r');
  return i === -1 ? null : Number(args[i + 1]);
}
const live = (fps, relayFps) => buildLiveEncoderArgs({
  width: 1920, height: 1080, fps, bitrateKbps: 9000, keyframeIntervalSec: 2,
  destinationUrl: 'rtmps://x/y', relayWidth: 1920, relayHeight: 1080, relayFps,
});

console.log('\nprogram feed frame rate');

test('the reported bug: 60 requested from a 30fps feed sends 30, not duplicated 60', () => {
  assert.strictEqual(effectiveOutputFps(60, 30), 30);
  assert.strictEqual(outRate(live(60, 30)), 30);
});

test('a real 60fps feed does send 60 — the clamp is to reality, not a cap', () => {
  assert.strictEqual(effectiveOutputFps(60, 60), 60);
  assert.strictEqual(outRate(live(60, 60)), 60);
});

test('asking for LESS than the feed still decimates evenly (60 feed, 30 out)', () => {
  // Legitimate and cheap: keep every other frame. Only UPsampling duplicates.
  assert.strictEqual(effectiveOutputFps(30, 60), 30);
  assert.strictEqual(outRate(live(30, 60)), 30);
});

test('a 25fps card does not get padded up to 30', () => {
  assert.strictEqual(effectiveOutputFps(30, 25), 25);
  assert.strictEqual(outRate(live(30, 25)), 25);
});

test('an unknown feed rate leaves the request alone rather than guessing', () => {
  assert.strictEqual(effectiveOutputFps(60, null), 60);
  assert.strictEqual(effectiveOutputFps(60, 0), 60);
  assert.strictEqual(outRate(live(60, null)), 60);
});

test('the GOP follows the rate actually sent, so keyframes stay 2s apart', () => {
  // A 2s keyframe interval is what YouTube wants. If -r were clamped to 30
  // but -g still computed from 60, keyframes would land every 4 seconds and
  // viewers would wait that long to start or recover.
  const args = live(60, 30);
  const g = Number(args[args.indexOf('-g') + 1]);
  assert.strictEqual(g, 60, '30fps x 2s = 60 frames');
  assert.strictEqual(Number(args[args.indexOf('-keyint_min') + 1]), 60);
});

test('the recording is clamped the same way — no half-duplicate master file', () => {
  const args = buildRecorderEncoderArgs({ width: 1920, height: 1080, fps: 60, bitrateKbps: 20000, outFile: 'm.mp4', useNvenc: true, relayFps: 30 });
  assert.strictEqual(outRate(args), 30);
  assert.strictEqual(Number(args[args.indexOf('-g') + 1]), 60, 'recorder GOP is 2s at the real rate');
});

test('CBR and the no-latency flags are untouched by the clamp', () => {
  const args = live(60, 30);
  assert.ok(args.includes('cbr'));
  assert.strictEqual(Number(args[args.indexOf('-bf') + 1]), 0);
  assert.strictEqual(args[args.indexOf('-rc-lookahead') + 1], '0');
  assert.ok(args.includes('-fps_mode') && args[args.indexOf('-fps_mode') + 1] === 'cfr',
    'a steady cadence is still required — it just has to be a cadence the feed can fill');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
