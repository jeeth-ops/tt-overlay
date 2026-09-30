// ONE master recording per match, whatever the internet did.
//
// The operator's report: "internet jaate hi master recording rukti hai aur
// 2 parts me ban rahi hai." A recorder restart genuinely HAS to open a new
// file (fragmented MP4 can't be appended to once its process is gone), so
// the fix is not to remove that safety — it is to record WHY every boundary
// happened, refuse to accept a boundary caused by anything remote, and hand
// the operator one joined master at the end.
//
// Run: node stream-engine/test/recordingSession.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../recordingSession');

let pass = 0, fail = 0;
function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recsession-'));
  try { fn(dir); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
}

console.log('\nrecordingSession — boundary causes');

test('a network reason is classified remote — the case that must never happen', () => {
  for (const r of [
    'Connection reset by peer',
    'rtmps://a.rtmp.youtube.com: Broken pipe',
    'getaddrinfo ENOTFOUND upload.youtube.com',
    'R2 upload failed',
    'main server unreachable — clip sync pending',
    'Network is unreachable',
  ]) assert.strictEqual(S.classifyBoundaryReason(r), 'remote', `"${r}" should be remote`);
});

test('a real local fault is classified local', () => {
  for (const r of [
    'operator stopped recording',
    'stalled — no new video encoded for 34s',
    'master.mp4 has not grown for 47s',
    'OpenEncodeSessionEx failed: out of memory (nvenc)',
    'Could not open dshow device',
    'No space left on device (ENOSPC)',
    'recorder ffmpeg exited unexpectedly (code=null, signal=SIGKILL)',
  ]) assert.strictEqual(S.classifyBoundaryReason(r), 'local', `"${r}" should be local`);
});

test('a local fault with a remote trigger stays LOCAL, so the real defect is not hidden', () => {
  // The leading hypothesis for the reported split: YouTube dies, its encoder
  // thrashes through NVENC sessions, and the RECORDER's encoder is the
  // collateral damage. Blaming "youtube" would hide that two encoders are
  // contending for one GPU resource — which is the actual bug to fix.
  assert.strictEqual(
    S.classifyBoundaryReason('nvenc session failed while the rtmps encoder was restarting'),
    'local');
});

test('an empty or missing reason is unknown, never silently "fine"', () => {
  assert.strictEqual(S.classifyBoundaryReason(''), 'unknown');
  assert.strictEqual(S.classifyBoundaryReason(null), 'unknown');
  assert.strictEqual(S.classifyBoundaryReason('   '), 'unknown');
});

console.log('\nrecordingSession — one session per match');

test('a match records one session with its parts in order', (dir) => {
  const s = S.createSession({ matchId: 'm1', settings: { fps: 25 }, now: 1000 });
  S.addSegment(s, { path: path.join(dir, 'master.mp4'), startedAt: 1000 });
  S.closeOpenSegment(s, { endedAt: 5000, reason: 'stalled — no new video encoded for 31s' });
  S.addSegment(s, { path: path.join(dir, 'master_part2.mp4'), startedAt: 6000 });
  S.stopSession(s, { endedAt: 9000 });
  assert.strictEqual(s.segments.length, 2);
  assert.strictEqual(s.status, 'stopped');
  assert.strictEqual(s.segments[1].reason, 'operator stopped recording');
  const b = S.boundaries(s);
  assert.strictEqual(b.length, 1, 'only the mid-match boundary counts, not the operator stop');
  assert.strictEqual(b[0].reasonKind, 'local');
  assert.strictEqual(S.hasRemoteCausedBoundary(s), false);
});

test('a boundary blamed on the internet is reported as the violation it is', (dir) => {
  const s = S.createSession({ matchId: 'm1', now: 1000 });
  S.addSegment(s, { path: path.join(dir, 'master.mp4') });
  S.closeOpenSegment(s, { reason: 'rtmps connection reset by peer' });
  S.addSegment(s, { path: path.join(dir, 'master_part2.mp4') });
  assert.strictEqual(S.hasRemoteCausedBoundary(s), true);
});

test('the session survives a restart and is ADOPTED, not counted as a new recording', (dir) => {
  const first = S.createSession({ matchId: 'm1', settings: { fps: 25 }, now: 1000 });
  S.addSegment(first, { path: path.join(dir, 'master.mp4'), startedAt: 1000 });
  assert.strictEqual(S.saveSession(dir, first), true);

  // Engine restarts mid-match and starts recording the same match again.
  const { session, adopted } = S.startOrAdoptSession(dir, { matchId: 'm1', settings: { fps: 25 } });
  assert.strictEqual(adopted, true, 'the same match must continue its session');
  assert.strictEqual(session.sessionId, first.sessionId);
  assert.strictEqual(session.adoptions, 1);
  assert.strictEqual(session.segments.length, 1, 'the part already on disk is still part of this recording');
});

test('a DIFFERENT match does not adopt the previous match\'s session', (dir) => {
  S.saveSession(dir, S.createSession({ matchId: 'm1', now: 1000 }));
  const { adopted } = S.startOrAdoptSession(dir, { matchId: 'm2' });
  assert.strictEqual(adopted, false);
});

test('a session already stopped is not adopted — that really is a new recording', (dir) => {
  const done = S.createSession({ matchId: 'm1', now: 1000 });
  S.stopSession(done, { endedAt: 2000 });
  S.saveSession(dir, done);
  const { adopted } = S.startOrAdoptSession(dir, { matchId: 'm1' });
  assert.strictEqual(adopted, false);
});

test('a corrupt or truncated session file never blocks a recording from starting', (dir) => {
  fs.writeFileSync(S.sessionFilePath(dir), '{"matchId":"m1","seg');
  assert.strictEqual(S.loadSession(dir), null);
  const { session, adopted } = S.startOrAdoptSession(dir, { matchId: 'm1' });
  assert.strictEqual(adopted, false);
  assert.ok(session.sessionId, 'a fresh session is still produced');
});

test('no session file at all is the normal first recording, not an error', (dir) => {
  assert.strictEqual(S.loadSession(dir), null);
});

test('saving is atomic — no .tmp is left behind', (dir) => {
  S.saveSession(dir, S.createSession({ matchId: 'm1', now: 1 }));
  assert.ok(fs.existsSync(S.sessionFilePath(dir)));
  assert.ok(!fs.existsSync(S.sessionFilePath(dir) + '.tmp'));
});

test('a save failure is reported, not swallowed', () => {
  let reported = null;
  const ok = S.saveSession('/definitely/not/a/real/dir', S.createSession({ matchId: 'm1' }), (e) => { reported = e; });
  assert.strictEqual(ok, false);
  assert.ok(reported, 'the caller must be told the durable record could not be written');
});

console.log('\nrecordingSession — joining the parts back into one master');

test('one part is nothing to join', (dir) => {
  const s = S.createSession({ matchId: 'm1' });
  S.addSegment(s, { path: path.join(dir, 'master.mp4') });
  assert.strictEqual(S.segmentsAreJoinable(s).ok, false);
});

test('two or more parts are joinable', (dir) => {
  const s = S.createSession({ matchId: 'm1' });
  S.addSegment(s, { path: path.join(dir, 'master.mp4') });
  S.addSegment(s, { path: path.join(dir, 'master_part2.mp4') });
  const j = S.segmentsAreJoinable(s);
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.count, 2);
});

test('the concat list quotes every part and escapes an apostrophe in a path', () => {
  const s = S.createSession({ matchId: 'm1' });
  S.addSegment(s, { path: 'C:\\Recordings\\match\\master.mp4' });
  S.addSegment(s, { path: "C:\\Jeeth's Matches\\master_part2.mp4" });
  const list = S.buildConcatList(s);
  assert.strictEqual(list.split('\n').filter(Boolean).length, 2);
  assert.ok(list.includes("file 'C:\\Recordings\\match\\master.mp4'"));
  assert.ok(list.includes("'\\''"), 'an apostrophe in an operator path must be escaped for the concat demuxer');
});

test('the join is lossless — stream copy, never a re-encode', () => {
  const args = S.buildConcatArgs({ listFile: 'list.txt', outFile: 'out.mp4' });
  assert.ok(args.join(' ').includes('-c copy'), 'a 7-hour re-encode is not acceptable');
  assert.ok(args.includes('concat') && args.includes('-safe') && args.includes('0'),
    'the concat DEMUXER with -safe 0 is what joins separate files by absolute path');
  assert.ok(!args.some((a) => /libx264|nvenc|-crf|-b:v/.test(String(a))), 'no encoder may appear in a lossless join');
  assert.strictEqual(args[args.length - 1], 'out.mp4');
});

test('the joined master is a new file — the parts are never overwritten or deleted', (dir) => {
  const s = S.createSession({ matchId: 'm1' });
  S.addSegment(s, { path: path.join(dir, 'master.mp4') });
  S.addSegment(s, { path: path.join(dir, 'master_part2.mp4') });
  const out = S.finalFilePath(dir);
  assert.ok(!s.segments.some((seg) => seg.path === out), 'the output must not collide with any part');
  assert.strictEqual(path.basename(out), 'master_complete.mp4');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
