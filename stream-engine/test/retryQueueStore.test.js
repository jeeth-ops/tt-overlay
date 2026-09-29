// Proves the offline clip queue survives exactly the situations it exists
// for: several clips queued during an outage, retry timers armed, and the
// engine restarted while still offline.
//
// Run: node stream-engine/test/retryQueueStore.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../retryQueueStore');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-'));
const FILE = path.join(tmp, 'retry-queue.local.json');
let pass = 0, fail = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const entry = (n) => ({
    clipId: `m1_FOUR_${n}`, matchId: 'm1', eventType: 'FOUR', timestamp: 1700000000000 + n,
    ballMeta: { over: n, ball: 1, batsman: 'R Sharma' }, filePath: `/clips/${n}.mp4`,
    mainServerUrl: 'https://example.invalid', attempts: n, enqueuedAt: 1700000000000,
});

console.log('\nretry queue store');

test('a live retry timer is what used to break persistence — JSON.stringify still throws on it', () => {
    const e = entry(1);
    e.timer = setTimeout(() => {}, 60000);
    assert.throws(() => JSON.stringify([e]), /circular/i,
        'the original bug depended on this throwing; if Node changed, revisit retryQueueStore.js');
    clearTimeout(e.timer);
});

test('serialising is total: entries WITH live timers are written, not dropped', () => {
    const q = [entry(1), entry(2), entry(3)];
    q.forEach((e) => { e.timer = setTimeout(() => {}, 60000); });
    const json = store.serializeRetryQueue(q);   // must not throw
    q.forEach((e) => clearTimeout(e.timer));
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.length, 3, 'all three entries must be serialised');
    assert.ok(!('timer' in parsed[0]), 'the runtime timer handle must never be written to disk');
    assert.strictEqual(parsed[0].clipId, 'm1_FOUR_1');
});

test('THE REGRESSION: 3 clips queued offline, timers armed, all 3 survive a save', () => {
    const q = [];
    // Mirrors forwardClip(): push, persist, then arm the retry timer.
    for (let i = 1; i <= 3; i++) {
        const e = entry(i);
        q.push(e);
        assert.ok(store.saveRetryQueue(FILE, q, () => {}), `save must succeed after clip ${i}`);
        e.timer = setTimeout(() => {}, 60000);
    }
    q.forEach((e) => clearTimeout(e.timer));
    const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.strictEqual(onDisk.length, 3,
        `all 3 offline clips must be on disk — got ${onDisk.length} (the old code wrote only the 1st)`);
});

test('restart while still offline: every queued clip is loaded back with its work intact', () => {
    const loaded = store.loadRetryQueue(FILE);
    assert.strictEqual(loaded.length, 3);
    assert.deepStrictEqual(loaded.map((e) => e.clipId), ['m1_FOUR_1', 'm1_FOUR_2', 'm1_FOUR_3']);
    assert.strictEqual(loaded[2].filePath, '/clips/3.mp4', 'the file to upload must survive');
    assert.strictEqual(loaded[2].mainServerUrl, 'https://example.invalid', 'the destination must survive');
    assert.strictEqual(loaded[1].attempts, 2, 'the attempt count must survive');
    assert.deepStrictEqual(loaded[0].ballMeta, { over: 1, ball: 1, batsman: 'R Sharma' },
        'ball metadata must survive — it is what names and files the clip');
});

test('a missing queue file is a first run, not a crash', () => {
    assert.deepStrictEqual(store.loadRetryQueue(path.join(tmp, 'nope.json')), []);
});

test('a truncated queue file degrades to empty instead of throwing at startup', () => {
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, '[{"clipId":"m1_FOUR_1","filePa');
    assert.deepStrictEqual(store.loadRetryQueue(bad), []);
});

test('the write is atomic — a reader never sees a half-written queue', () => {
    const q = [entry(1), entry(2)];
    store.saveRetryQueue(FILE, q, () => {});
    assert.ok(!fs.existsSync(`${FILE}.tmp`), 'the temp file must not be left behind');
    assert.strictEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).length, 2);
});

test('an unwritable path reports the failure instead of swallowing it', () => {
    let reported = null;
    const ok = store.saveRetryQueue(path.join(tmp, 'no-such-dir', 'q.json'), [entry(1)], (e) => { reported = e; });
    assert.strictEqual(ok, false, 'a failed save must return false');
    assert.ok(reported, 'a failed save must report — silently losing this file is the bug this replaced');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
