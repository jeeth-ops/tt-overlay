// Per-job clip windows and per-sport routes (clipWindow.js), and the retry
// queue keeping a clip's sport across a restart (retryQueueStore.js).
//
// Run: node stream-engine/test/clipWindow.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../clipWindow');
const store = require('../retryQueueStore');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

console.log('\nclip window + route');

test('cricket (nothing asked for): T0-15 s → T0+5 s, /api/clips/ingest — as before', () => {
  const w = W.buildWindow(100000, {});
  assert.deepStrictEqual([w.preRollSec, w.postRollSec, w.startWall, w.endWall], [15, 5, 85000, 105000]);
  assert.strictEqual(W.routeFor(undefined).ingestPath, '/api/clips/ingest');
  assert.strictEqual(W.routeFor('cricket').statusPath, '/api/clips/status/');
});

test('volleyball: T0-7 s → T0+3 s = 10 s, /api/volleyball/clips/ingest', () => {
  const w = W.buildWindow(100000, { preRollSec: 7, postRollSec: 3 });
  assert.deepStrictEqual([w.startWall, w.endWall, (w.endWall - w.startWall) / 1000], [93000, 103000, 10]);
  assert.strictEqual(W.routeFor('volleyball').ingestPath, '/api/volleyball/clips/ingest');
  assert.strictEqual(W.routeFor('volleyball').statusPath, '/api/volleyball/clips/status/');
});

test('the window is frozen (another press can never move it)', () => {
  const w = W.buildWindow(1, { preRollSec: 7, postRollSec: 3 });
  assert.ok(Object.isFrozen(w));
  assert.throws(() => { 'use strict'; w.endWall = 0; });
});

test('bounded: a request cannot ask for a 10-minute clip; nonsense falls back to cricket', () => {
  const w = W.buildWindow(0, { preRollSec: 600, postRollSec: 900 });
  assert.deepStrictEqual([w.preRollSec, w.postRollSec], [30, 15]);
  const z = W.buildWindow(0, { preRollSec: 'x', postRollSec: -4 });
  assert.deepStrictEqual([z.preRollSec, z.postRollSec], [15, 1]);
});

test('an unknown sport can never point the upload anywhere else', () => {
  assert.strictEqual(W.routeFor('../../admin').ingestPath, '/api/clips/ingest');
});

test('pre-roll actually available: the whole 7 s, or what the recording holds', () => {
  const w = W.buildWindow(100000, { preRollSec: 7, postRollSec: 3 });
  assert.strictEqual(W.actualPreRoll(w, 23.4), 7);       // window starts 23.4 s into the file
  assert.strictEqual(W.actualPreRoll(w, -3), 4);         // the recording began 4 s before the press
  assert.strictEqual(W.actualPreRoll(w, -9), 0);         // began after the press
});

test('what the website is told about a cut', () => {
  const job = { sport: 'volleyball', window: W.buildWindow(100000, { preRollSec: 7, postRollSec: 3 }), actualPreRollSec: 4, partialPreRoll: true, clipDurationSec: 7 };
  const m = W.clipMetaFor(job);
  assert.deepStrictEqual([m.sport, m.preRollSec, m.postRollSec, m.actualPreRollSec, m.partialPreRoll, m.durationSec, m.windowStart, m.windowEnd], ['volleyball', 7, 3, 4, true, 7, 93000, 103000]);
});

test('capture pages: cricket keeps its exact URLs; a volleyball match shows the volleyball overlay', () => {
  const vid = 'abc/=', label = 'Cam Link 4K';
  const old = `/live-output.html?room=${encodeURIComponent('m 1')}&video=${encodeURIComponent(vid)}&videoLabel=${encodeURIComponent(label)}`;
  assert.strictEqual(W.capturePagesFor(undefined, 'm 1', { videoDeviceId: vid, videoLabel: label }).liveOutput, old);
  assert.strictEqual(W.capturePagesFor('cricket', 'm1').overlay, '/cricket-overlay?room=m1');
  const v = W.capturePagesFor('volleyball', 'vbm1', { videoLabel: label, overlayKey: 'a1b2c3d4e5' });
  assert.strictEqual(v.overlay, '/volleyball-overlay?match=vbm1&key=a1b2c3d4e5');
  assert.strictEqual(v.liveOutput, `/volleyball-live-output?match=vbm1&video=&videoLabel=${encodeURIComponent(label)}&key=a1b2c3d4e5`);
  assert.strictEqual(W.capturePagesFor('volleyball', 'vbm1', { overlayKey: '"><script>' }).overlay, '/volleyball-overlay?match=vbm1', 'a key that is not hex is left out');
});

test('the retry queue keeps a volleyball clip’s sport and cut details across a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rq-')), 'q.json');
  const entry = { clipId: 'm_1', matchId: 'm', eventType: 'VBPOINT', timestamp: 1, ballMeta: { eventId: 'e1' }, filePath: '/x.mp4', mainServerUrl: 'http://h', attempts: 2,
    sport: 'volleyball', clipMeta: { preRollSec: 7, postRollSec: 3 }, timer: setTimeout(() => {}, 1) };
  clearTimeout(entry.timer);
  assert.ok(store.saveRetryQueue(file, [entry, { clipId: 'c_1', matchId: 'c', filePath: '/y.mp4', mainServerUrl: 'http://h' }]));
  const back = store.loadRetryQueue(file);
  assert.deepStrictEqual([back[0].sport, back[0].clipMeta.preRollSec, back[0].timer], ['volleyball', 7, undefined]);
  assert.strictEqual(back[1].sport, undefined, 'a cricket entry stays exactly as it was');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
