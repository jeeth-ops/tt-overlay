// "One real second of camera time must remain one real second in the preview,
// master recording, clips and YouTube stream."
//
// The bug this instrument exists for: dshow's -framerate is a REQUEST. Ask an
// AVMATRIX card for 50fps while it really delivers 25 and ffmpeg still stamps
// what arrives at 50 — media time then advances 0.5s per real second, so a
// real 60-second over becomes a 30-second file that plays at double speed.
// Nothing in the chain noticed that before, so these tests pin the detector:
// a wrong rate must be CAUGHT, and a normally-wobbling encoder must NOT be
// flagged.
//
// Run: node stream-engine/test/timebaseMonitor.test.js
const assert = require('assert');
const { createRateTracker, noteRateSample, rateHealth } = require('../timebaseMonitor');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// Feed the tracker as ffmpeg's -progress would: one sample per real tick,
// with media time advancing at `ratio` x wall time.
function feed(rate, { ratio, seconds, startMs = 1_000_000, stepMs = 500 }) {
  let media = 0;
  for (let t = 0; t <= seconds * 1000; t += stepMs) {
    media = (t / 1000) * ratio;
    if (media > 0) noteRateSample(rate, startMs + t, media);
  }
  return startMs + seconds * 1000;
}

console.log('\ntimebaseMonitor');

test('a correct 1:1 timeline reads ok', () => {
  const r = createRateTracker('Recording');
  feed(r, { ratio: 1, seconds: 30 });
  const h = rateHealth(r, 50);
  assert.strictEqual(h.verdict, 'ok', `expected ok, got ${h.verdict} (ratio ${h.ratio})`);
  assert.strictEqual(h.actualFps, 50);
});

test('the reported bug — 25fps stamped as 50 — reads FAST, not ok', () => {
  const r = createRateTracker('Recording');
  feed(r, { ratio: 0.5, seconds: 30 });
  const h = rateHealth(r, 50);
  assert.strictEqual(h.verdict, 'fast');
  assert.strictEqual(h.ratio, 0.5);
  // The whole point of the measurement: it names the real source rate.
  assert.strictEqual(h.actualFps, 25, `should report the camera's real 25fps, got ${h.actualFps}`);
});

test('60 real seconds producing a 30-second file is exactly ratio 0.5', () => {
  const r = createRateTracker('Recording');
  feed(r, { ratio: 0.5, seconds: 60 });
  assert.strictEqual(rateHealth(r, 25).ratio, 0.5);
});

test('more frames than requested reads SLOW', () => {
  const r = createRateTracker('Live stream');
  feed(r, { ratio: 2, seconds: 30 });
  const h = rateHealth(r, 25);
  assert.strictEqual(h.verdict, 'slow');
  assert.strictEqual(h.actualFps, 50);
});

test('ordinary encoder wobble (2% behind) is NOT flagged', () => {
  const r = createRateTracker('Recording');
  feed(r, { ratio: 0.98, seconds: 30 });
  assert.strictEqual(rateHealth(r, 50).verdict, 'ok');
});

test('no verdict before there is enough span to judge', () => {
  const r = createRateTracker('Recording');
  feed(r, { ratio: 0.5, seconds: 3 });   // startup — too short to accuse anything
  const h = rateHealth(r, 50);
  assert.strictEqual(h.verdict, 'measuring');
  assert.strictEqual(h.ratio, null);
  assert.strictEqual(h.requestedFps, 50, 'the requested rate is known even before the actual one is');
});

test('the window slides, so a rate that goes wrong later is caught', () => {
  const r = createRateTracker('Recording');
  let at = feed(r, { ratio: 1, seconds: 40 });
  assert.strictEqual(rateHealth(r, 50).verdict, 'ok');
  // Source switches mode mid-match and starts delivering half the rate.
  let media = 40;
  for (let t = 500; t <= 40000; t += 500) { media += 0.25; noteRateSample(r, at + t, media); }
  assert.strictEqual(rateHealth(r, 50).verdict, 'fast', 'a mid-match rate change must not stay hidden behind 40s of good history');
});

test('a stall leaves something to compare against instead of resetting', () => {
  const r = createRateTracker('Recording');
  const at = feed(r, { ratio: 1, seconds: 20 });
  // ffmpeg writes nothing for two minutes, then one late report.
  noteRateSample(r, at + 120000, 20.5);
  const h = rateHealth(r, 50);
  assert.notStrictEqual(h.ratio, null, 'the stall should still be measurable');
  assert.strictEqual(h.verdict, 'fast', '0.5s of media in ~2 minutes of wall time is not "ok"');
});

test('a fresh tracker after a restart carries no history from the old timeline', () => {
  const r = createRateTracker('Recording');
  feed(r, { ratio: 0.5, seconds: 30 });
  assert.strictEqual(rateHealth(r, 50).verdict, 'fast');
  const fresh = createRateTracker('Recording');
  assert.strictEqual(rateHealth(fresh, 50).verdict, 'measuring');
});

test('rateHealth is pure — reading it twice does not change the verdict', () => {
  const r = createRateTracker('Recording');
  feed(r, { ratio: 0.5, seconds: 30 });
  assert.deepStrictEqual(rateHealth(r, 50), rateHealth(r, 50));
});

test('it survives a missing tracker and a zero rate rather than throwing', () => {
  noteRateSample(null, 1, 1);
  noteRateSample(createRateTracker(), 1, 0);
  const h = rateHealth(null, null);
  assert.strictEqual(h.verdict, 'measuring');
  assert.strictEqual(h.actualFps, null);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
