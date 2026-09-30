// REMOTE FAILURE ≠ LOCAL MEDIA FAILURE.
//
// The program feed fans out to several consumers: the master recorder, the
// YouTube (RTMPS) publisher, and the preview. YouTube is the only one that
// depends on the internet, so the invariant is that its failure — dying,
// stalling, or backing up behind a collapsing uplink — must be INVISIBLE to
// the recorder.
//
// These tests drive the real RelayConsumer with fake child processes, so
// they exercise the actual distribution code rather than a description of
// it. What they cannot do is prove it on real video: this container has no
// ffmpeg build, no capture device and no GPU, so the end-to-end offline
// match test has to be run on the operator's PC (see STREAM-ENGINE-AUDIT.md).
//
// Run: node stream-engine/test/localIsolation.test.js
const assert = require('assert');
const { RelayConsumer } = require('../nativePipeline');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// A stand-in for a downstream ffmpeg: its stdin accepts writes and reports a
// backlog, exactly what RelayConsumer's back-pressure logic reads. `drain`
// models a process that is consuming; leaving it off models one that is not
// (a YouTube encoder whose socket has stopped going anywhere).
function fakeProc({ drain = true } = {}) {
  const chunks = [];
  const stdin = {
    writable: true, destroyed: false, writableLength: 0,
    cork() {}, uncork() {},
    write(buf) { chunks.push(buf); if (!drain) stdin.writableLength += buf.length; return true; },
    end() { stdin.writable = false; },
  };
  return { stdin, chunks, die() { stdin.writable = false; stdin.destroyed = true; } };
}
const HEADER = Buffer.from('HDR');
const unit = (n) => [Buffer.from(`unit${n}`)];

function makeConsumer(proc, who) {
  return new RelayConsumer(proc, who, { pauseBytes: 1000, resumeBytes: 500, log: () => {} });
}
// One program frame going out to everyone, the way the compositor's splitter
// does it (onUnit -> deliver to each consumer).
function fanOut(consumers, n) {
  for (const c of consumers) c.deliver(HEADER, unit(n), 8);
}

console.log('\nlocal isolation — the recorder must not feel a remote failure');

test('a YouTube consumer that DIES does not stop the recorder receiving frames', () => {
  const rec = fakeProc(), live = fakeProc();
  const consumers = [makeConsumer(rec, 'recorder'), makeConsumer(live, 'live')];
  fanOut(consumers, 1);
  live.die(); // internet gone, RTMPS ffmpeg exits
  for (let n = 2; n <= 50; n++) fanOut(consumers, n);
  assert.strictEqual(consumers[0].unitsWritten, 50, 'the recorder must have received every frame');
  assert.strictEqual(consumers[0].unitsSkipped, 0, 'and skipped none');
  assert.ok(rec.chunks.length > 50);
});

test('a YouTube consumer that BACKS UP is skipped, never allowed to throttle the source', () => {
  // A collapsing uplink fills the live encoder's stdin. The old danger was
  // pausing the shared source to wait for it — which would starve the
  // recorder and trip its stall watchdog, ending the segment. Instead the
  // slow consumer drops frames and everyone else is untouched.
  const rec = fakeProc();                    // consuming normally
  const live = fakeProc({ drain: false });   // nothing is draining it
  const consumers = [makeConsumer(rec, 'recorder'), makeConsumer(live, 'live')];
  for (let n = 1; n <= 300; n++) fanOut(consumers, n);
  assert.strictEqual(consumers[0].unitsWritten, 300, 'the recorder gets everything');
  assert.strictEqual(consumers[0].state, 'live');
  assert.ok(consumers[1].unitsSkipped > 0, 'the backed-up YouTube branch is the one that drops frames');
  assert.strictEqual(consumers[1].state, 'skipping');
});

test('the recorder keeps its own pace when it is the SLOW one — no cross-talk either way', () => {
  const rec = fakeProc({ drain: false });
  const live = fakeProc();
  const consumers = [makeConsumer(rec, 'recorder'), makeConsumer(live, 'live')];
  for (let n = 1; n <= 300; n++) fanOut(consumers, n);
  assert.strictEqual(consumers[1].unitsWritten, 300, 'a slow recorder must not cost the stream its frames');
});

test('a consumer detaching (Stop Stream) leaves the others mid-flow untouched', () => {
  const rec = fakeProc(), live = fakeProc();
  const recC = makeConsumer(rec, 'recorder'), liveC = makeConsumer(live, 'live');
  fanOut([recC, liveC], 1);
  liveC.end();                       // operator stops the stream; stdin closed on a unit boundary
  for (let n = 2; n <= 20; n++) fanOut([recC], n);
  assert.strictEqual(recC.unitsWritten, 20);
  assert.strictEqual(live.stdin.writable, false);
});

test('a consumer that was never writable is ignored rather than throwing', () => {
  const dead = fakeProc(); dead.die();
  const c = makeConsumer(dead, 'live');
  assert.doesNotThrow(() => c.deliver(HEADER, unit(1), 8));
  assert.strictEqual(c.unitsWritten, 0);
});

test('each consumer gets the stream header for itself, so one joining late cannot corrupt another', () => {
  const rec = fakeProc();
  const recC = makeConsumer(rec, 'recorder');
  fanOut([recC], 1);
  assert.strictEqual(rec.chunks[0], HEADER, 'a consumer starts with the header');
  const late = fakeProc();
  const lateC = makeConsumer(late, 'live');     // joins at frame 2
  fanOut([recC, lateC], 2);
  assert.strictEqual(late.chunks[0], HEADER, 'the late joiner gets its own header');
  assert.strictEqual(recC.unitsWritten, 2, 'and the recorder is not re-sent one');
  assert.strictEqual(rec.chunks.filter((c) => c === HEADER).length, 1);
});

test('a consumer with no header yet waits instead of writing a headless stream', () => {
  const live = fakeProc();
  const c = makeConsumer(live, 'live');
  c.deliver(null, unit(1), 8);  // leg has not produced its header yet
  assert.strictEqual(live.chunks.length, 0);
  assert.strictEqual(c.state, 'joining');
});

test('the placeholder overlay is REALLY transparent (it used to be 50% blue over the whole program)', () => {
  const zlib = require('zlib');
  const { TRANSPARENT_PNG } = require('../nativePipeline');
  let i = 8, rgba = null, hdr = null;
  while (i < TRANSPARENT_PNG.length) {
    const len = TRANSPARENT_PNG.readUInt32BE(i);
    const type = TRANSPARENT_PNG.toString('latin1', i + 4, i + 8);
    const data = TRANSPARENT_PNG.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') hdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], colorType: data[9] };
    if (type === 'IDAT') rgba = [...zlib.inflateSync(data)];
    i += 12 + len;
  }
  assert.deepStrictEqual(hdr, { w: 1, h: 1, depth: 8, colorType: 6 });
  assert.strictEqual(rgba[0], 0, 'filter type None');
  assert.deepStrictEqual(rgba.slice(1), [0, 0, 0, 0], `pixel is RGBA(${rgba.slice(1)}) — alpha must be 0`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
