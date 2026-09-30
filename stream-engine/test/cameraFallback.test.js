// The compositor must not relaunch a camera mode the device has already
// refused. dshow rejects an unsupported -video_size/-framerate outright
// ("Could not set video options" -> I/O error) and ffmpeg exits in under a
// second, so an identical retry can never succeed — which is what produced
// "relaunching in 10s (attempt 11)" with no picture on an AVMATRIX card while
// the same build opened a laptop webcam fine.
//
// Run: node stream-engine/test/cameraFallback.test.js
const assert = require('assert');
const { Compositor } = require('../nativePipeline');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
// A bare object carrying just the fields _classifyOpenFailure touches, so the
// test never has to spawn ffmpeg or open a device.
function fakeCompositor(forced) {
  const logs = [];
  const c = Object.create(Compositor.prototype);
  c._cameraModeLevel = 0;
  c.cameraMode = { width: 1280, height: 720, fps: 30 };
  c.lastError = null;
  c.log = (m) => logs.push(String(m));
  c.logs = logs;
  process.env.STREAM_ENGINE_CAMERA_MODE = forced || '';
  return c;
}
const REFUSED = 'Error opening input file video=AVMATRIX USB Capture Video.';

console.log('\ncamera mode fallback');

test('a forced mode the device refuses is dropped, and a re-probe is forced', () => {
  const c = fakeCompositor('1280x720@30');
  c.lastError = REFUSED;
  c._classifyOpenFailure(0);
  assert.strictEqual(c._cameraModeLevel, 1, 'must step off the forced mode');
  assert.strictEqual(c.cameraMode, null, 'must clear the cache so the next start re-probes');
  assert.ok(c.logs.join(' ').includes('REFUSED'), 'must say plainly that the mode was refused');
  assert.ok(c.logs.join(' ').includes('start-native.bat'), 'must tell the operator where the forced mode lives');
});

test('a second refusal drops all constraints rather than looping again', () => {
  const c = fakeCompositor('1280x720@30');
  c.lastError = REFUSED; c._classifyOpenFailure(0);
  c.lastError = 'Could not set video options'; c._classifyOpenFailure(0);
  assert.strictEqual(c._cameraModeLevel, 2);
  assert.strictEqual(c.cameraMode, false, 'false = open unconstrained');
});

test('a busy device is reported as busy, and modes are NOT stepped down', () => {
  const c = fakeCompositor('1280x720@30');
  c.lastError = 'Could not open video device: device or resource busy';
  c._classifyOpenFailure(0);
  assert.strictEqual(c._cameraModeLevel, 0, 'the mode was never the problem here');
  assert.ok(/already open in another program/i.test(c.logs.join(' ')));
});

test('a leg that ran a while and then died is a crash, not an open failure', () => {
  const c = fakeCompositor('1280x720@30');
  c.lastError = REFUSED;
  c._classifyOpenFailure(45000);           // 45s of good video, then died
  assert.strictEqual(c._cameraModeLevel, 0, 'must keep the working mode');
  assert.deepStrictEqual(c.logs, [], 'and must not tell the operator to change anything');
});

test('an unrelated error does not disturb the camera mode', () => {
  const c = fakeCompositor('1280x720@30');
  c.lastError = 'No space left on device';
  c._classifyOpenFailure(0);
  assert.strictEqual(c._cameraModeLevel, 0);
});

test('with no forced mode, the first refusal goes straight to unconstrained', () => {
  const c = fakeCompositor('');
  c.lastError = REFUSED;
  c._classifyOpenFailure(0);
  assert.strictEqual(c._cameraModeLevel, 2);
  assert.strictEqual(c.cameraMode, false);
});

delete process.env.STREAM_ENGINE_CAMERA_MODE;
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
