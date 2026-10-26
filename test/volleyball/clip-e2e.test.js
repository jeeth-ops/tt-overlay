/* 🎬 Volleyball point clips, end to end, for real:

     REAL website (server.js, in-memory MongoDB, stand-in R2)
       ⇄ REAL Stream Engine process (stream-engine/server.js, from a temp
         copy) cutting from a 60-second "master recording" with real ffmpeg.

   The master's brightness encodes its own second (luma = 16 + 3·second),
   so the first and last frame of a cut clip say exactly which part of the
   recording it holds. Proven here:
     • a point press T0 → the job waits for the 3-second post-roll, then
       cuts T0-7s … T0+3s (10 s) — the action BEFORE the press is in it;
     • two presses 1.2 s apart → two independent jobs, two 10-second clips;
     • a press 4 s after the recording began → a 7-second clip, reported as
       4 s of pre-roll (never passed off as a full 10-second clip);
     • the clip reaches the website, is stored under volleyball/…/set-1/
       point-N-…, linked to its point event, filed locally by set/point;
     • a request without `sport` is still a cricket clip: 15 s / 5 s,
       /api/clips/ingest — unchanged.
   The camera itself (dshow capture on Windows) is the one part a Linux
   container cannot exercise.

     NODE_PATH=$(npm root -g) node test/volleyball/clip-e2e.test.js
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync, spawnSync } = require('child_process');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, expected: b }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
if (spawnSync(FFMPEG, ['-version']).status !== 0) { console.log('clip-e2e: no ffmpeg — skipped'); process.exit(0); }

// ---- stand-in R2 ----
const bucket = new Map();
class Cmd { constructor(i) { this.input = i; } }
class PutObjectCommand extends Cmd {}
class DeleteObjectCommand extends Cmd {}
class GetObjectCommand extends Cmd {}
class S3Client { async send(c) { if (c instanceof PutObjectCommand) bucket.set(c.input.Key, Buffer.from(c.input.Body)); return {}; } }
const s3Path = require.resolve('@aws-sdk/client-s3');
require.cache[s3Path] = { id: s3Path, filename: s3Path, loaded: true, exports: { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } };
Object.assign(process.env, { R2_ACCOUNT_ID: 't', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET_NAME: 'clips', R2_PUBLIC_URL: 'https://clips.example.test' });

const { bootServer } = require('../server-boot.js');
const REPO = path.join(__dirname, '..', '..');

function call(port, method, url, { json, token, headers } = {}) {
  return new Promise((resolve, reject) => {
    const body = json ? Buffer.from(JSON.stringify(json)) : null;
    const h = Object.assign({}, body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}, token ? { Authorization: 'Bearer ' + token } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
// The mean of the raw Y plane of one frame (the first, or the last) of a
// clip → the master second it came from. Read as yuv420p, NOT gray: a
// conversion to gray rescales TV range (Y−16)·255/219 and would misread it.
function secondAt(file, which) {
  const args = which === 'first'
    ? ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=16:8', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']
    : ['-v', 'error', '-sseof', '-0.2', '-i', file, '-frames:v', '1', '-vf', 'scale=16:8', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'];
  const y = execFileSync(FFMPEG, args).subarray(0, 16 * 8);
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  return Math.round((mean - 16) / 3);
}
function duration(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file]);
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(r.stderr));
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-clip-e2e-'));
  // the master recording: 60 s, 25 fps, brightness = its own second
  const master = path.join(tmp, 'master.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=black:s=320x180:r=25:d=60,format=yuv420p,geq=lum='16+3*floor(T)':cb=128:cr=128",
    '-f', 'lavfi', '-i', 'sine=f=440:d=60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-shortest', master]);

  const U = { uid: 'u-work', email: 'workallsportslive@gmail.com', email_verified: true };
  const { port } = await bootServer({ idTokens: { tok: U }, users: { 'u-work': U.email } });
  const api = (m, u, o) => call(port, m, u, Object.assign({ token: 'tok' }, o || {}));
  const mk = (n) => Array.from({ length: 8 }, (_, i) => ({ name: `${n} ${i + 1}`, number: String(i + 1), libero: i === 7 }));
  const tA = (await api('POST', '/api/volleyball/teams', { json: { name: 'Pune Panthers', players: mk('Pune') } })).json.team;
  const tB = (await api('POST', '/api/volleyball/teams', { json: { name: 'Goa Waves', players: mk('Goa') } })).json.team;
  const T = (await api('POST', '/api/volleyball/tournaments', { json: { name: 'Clip Cup', teamIds: [tA.teamId, tB.teamId] } })).json.tournament;
  const M = (await api('POST', `/api/volleyball/tournaments/${T.tournamentId}/matches`, { json: { teamA: tA.teamId, teamB: tB.teamId } })).json.match;
  const lease = (await api('POST', `/api/volleyball/matches/${M.matchId}/lease`, { json: { deviceId: 'pc' } })).json.leaseToken;
  let n = 0;
  const ev = (e) => api('POST', `/api/volleyball/matches/${M.matchId}/events`, { json: { event: Object.assign({ eventId: 'e' + (++n), at: Date.now() }, e) }, headers: { 'x-vb-lease': lease } });
  await ev({ type: 'TOSS', winner: 'A', choice: 'serve', leftSide: 'A' });
  await ev({ type: 'LINEUP', team: 'A', positions: tA.players.slice(0, 6).map((p) => p.playerId) });
  await ev({ type: 'LINEUP', team: 'B', positions: tB.players.slice(0, 6).map((p) => p.playerId) });
  await ev({ type: 'SET_START' });

  // the Stream Engine, from a temp copy (its job / queue files stay out of the repo)
  fs.cpSync(path.join(REPO, 'stream-engine'), path.join(tmp, 'stream-engine'), { recursive: true, filter: (s) => !/\.local\.json$|StreamEngineData|[\\/]buffer$/.test(s) });
  const sePort = 5300 + Math.floor(Math.random() * 600);
  const masterStart = Date.now() - 30000;
  const se = spawn(process.execPath, [path.join(tmp, 'stream-engine', 'server.js')], {
    env: Object.assign({}, process.env, { NODE_PATH: path.join(REPO, 'node_modules'), STREAM_ENGINE_PORT: String(sePort), STREAM_ENGINE_DATA_ROOT: path.join(tmp, 'data'), FFMPEG_PATH: FFMPEG,
      STREAM_ENGINE_TEST_MASTER: `${master}|${masterStart}|60|${M.matchId}` }), stdio: ['ignore', 'pipe', 'pipe'] });
  let seLog = '';
  se.stdout.on('data', (d) => { seLog += d; }); se.stderr.on('data', (d) => { seLog += d; });
  const seCall = (m, u, o) => call(sePort, m, u, o);
  for (let i = 0; i < 100; i++) { await sleep(100); try { if ((await seCall('GET', '/health')).status === 200) break; } catch (e) { /* booting */ } }
  try {
    const rs = await seCall('POST', '/recording-start', { json: { matchId: M.matchId, mainServerUrl: `http://127.0.0.1:${port}`, audioDeviceName: 'test' } });
    ok('the Stream Engine registers the match for clips', rs.json && rs.json.success === true, rs.json);

    // what the panel does on "+1": the point to the website, the clip request to the local engine
    const press = async (team, pointNo, scoreA, scoreB, t0) => {
      const eventId = 'pt-' + (++n);
      const r = await ev({ eventId, type: 'RALLY', winner: team, outcome: 'ATTACK_KILL', players: { attacker: (team === 'A' ? tA : tB).players[3].playerId }, at: t0 });
      const clipId = `${M.matchId}_${eventId}`;
      const c = await seCall('POST', '/clip', { json: { matchId: M.matchId, eventType: 'VBPOINT', timestamp: t0, clipId, sport: 'volleyball', preRollSec: 7, postRollSec: 3,
        ballMeta: { sport: 'volleyball', vbClipToken: M.clipToken, eventId, tournamentId: T.tournamentId, set: 1, pointNo, team, teamName: team === 'A' ? 'Pune Panthers' : 'Goa Waves', score: { A: scoreA, B: scoreB } } } });
      return { eventId, clipId, accept: c.json, scored: r.json };
    };
    const T0 = Date.now();
    const p1 = await press('A', 1, 1, 0, T0);
    eq('the press is accepted at once, waiting for its post-roll', [p1.accept.status, p1.accept.window.preRollSec, p1.accept.window.postRollSec, p1.accept.window.finalizeAt], ['WAITING_FOR_POSTROLL', 7, 3, T0 + 3000]);
    ok('…and the point is already on the scoreboard (the clip never delays scoring)', p1.scored.success && p1.scored.summary.points.A === 1);
    await sleep(1200);
    const T1 = Date.now();
    const p2 = await press('A', 2, 2, 0, T1);
    // when does the cut start?
    let cutAt = null;
    for (let i = 0; i < 100 && !cutAt; i++) {
      const j = (await seCall('GET', `/clip-jobs/${p1.clipId}`)).json;
      if (j && j.job && j.job.status !== 'WAITING_FOR_POSTROLL') cutAt = Date.now();
      else await sleep(50);
    }
    ok('the clip is finalised only after the 3-second post-roll', cutAt >= T0 + 3000, { waitedMs: cutAt - T0 });
    const statusOf = async (clipId) => (await call(port, 'GET', `/api/volleyball/clips/status/${clipId}`)).json;
    for (const p of [p1, p2]) {
      for (let i = 0; i < 300; i++) { const s = await statusOf(p.clipId); if (s && s.status === 'COMPLETE') break; await sleep(100); }
    }
    const clips = (await api('GET', `/api/volleyball/matches/${M.matchId}/clips`)).json.clips;
    const c1 = clips.find((c) => c.clipId === p1.clipId), c2 = clips.find((c) => c.clipId === p2.clipId);
    ok('both clips reached the website and uploaded', c1 && c2 && c1.status === 'COMPLETE' && c2.status === 'COMPLETE', clips.map((c) => [c.clipId, c.status]));
    const key1 = [...bucket.keys()].find((k) => k.endsWith(p1.clipId + '.mp4'));
    eq('stored under volleyball/<tournament>/<match>/set-1/point-1-…', key1, `volleyball/${T.tournamentId}/${M.matchId}/set-1/point-1-${p1.clipId}.mp4`);
    const f1 = path.join(tmp, 'c1.mp4'), f2 = path.join(tmp, 'c2.mp4');
    fs.writeFileSync(f1, bucket.get(key1));
    fs.writeFileSync(f2, bucket.get([...bucket.keys()].find((k) => k.endsWith(p2.clipId + '.mp4'))));
    const d1 = duration(f1), d2 = duration(f2);
    ok('clip 1 is ~10 seconds', Math.abs(d1 - 10) < 0.6, d1);
    ok('clip 2 is ~10 seconds', Math.abs(d2 - 10) < 0.6, d2);
    const off1 = (T0 - masterStart) / 1000, off2 = (T1 - masterStart) / 1000;
    const s1 = [secondAt(f1, 'first'), secondAt(f1, 'last')], s2 = [secondAt(f2, 'first'), secondAt(f2, 'last')];
    ok(`clip 1 holds T0-7 s … T0+3 s of the recording (seconds ${Math.floor(off1 - 7)}…${Math.floor(off1 + 3 - 0.04)})`, Math.abs(s1[0] - Math.floor(off1 - 7)) <= 1 && Math.abs(s1[1] - Math.floor(off1 + 3 - 0.04)) <= 1, { first: s1[0], last: s1[1], press: off1 });
    ok('clip 2 holds its OWN window (independent job)', Math.abs(s2[0] - Math.floor(off2 - 7)) <= 1 && Math.abs(s2[1] - Math.floor(off2 + 3 - 0.04)) <= 1, { first: s2[0], last: s2[1], press: off2 });
    eq('the website knows each clip’s point and score at the press', [c1.set, c1.pointNo, c1.scoreAtTrigger, c2.pointNo], [1, 1, { A: 1, B: 0, set: 1 }, 2]);
    eq('…and the window it was cut with', [c1.requested, c1.actual.partialPreRoll, c1.actual.preRollSec], [{ preRollSec: 7, postRollSec: 3 }, false, 7]);
    const attackerClips = (await api('GET', `/api/volleyball/matches/${M.matchId}/clips?playerId=${tA.players[3].playerId}`)).json.clips.map((c) => c.clipId);
    eq('the attacker’s video icon opens these two point clips', attackerClips.sort(), [p1.clipId, p2.clipId].sort());
    const localDir = path.join(tmp, 'data', 'StreamEngineData', 'Recordings', M.matchId, 'Volleyball', 'Set-1');
    const local = fs.existsSync(localDir) ? fs.readdirSync(localDir) : [];
    ok('the operator keeps a local copy, filed by set and point (with its metadata)', local.some((f) => /^Point-001_Pune-Panthers_1-0_.*\.mp4$/.test(f)) && local.some((f) => /^Point-001_.*\.json$/.test(f)), local);
    const sidecar = local.find((f) => /^Point-001_.*\.json$/.test(f));
    ok('…and the local metadata never holds the clip token', sidecar && !fs.readFileSync(path.join(localDir, sidecar), 'utf8').includes(M.clipToken));

    // a press only 4 s into the recording: the pre-roll cannot be 7 s
    const early = masterStart + 4000;
    const p3 = await press('B', 3, 2, 1, early);
    for (let i = 0; i < 300; i++) { const s = await statusOf(p3.clipId); if (s && s.status === 'COMPLETE') break; await sleep(100); }
    const c3 = (await api('GET', `/api/volleyball/matches/${M.matchId}/clips`)).json.clips.find((c) => c.clipId === p3.clipId);
    ok('missing pre-roll is reported, never passed off as a full clip', c3 && c3.actual.partialPreRoll === true && Math.abs(c3.actual.preRollSec - 4) < 0.6 && Math.abs(c3.actual.durationSec - 7) < 0.7, c3 && c3.actual);
    const j3 = (await seCall('GET', `/clip-jobs/${p3.clipId}`)).json.job;
    ok('…on the operator’s PC too', j3.partialPreRoll === true && Math.abs(j3.actualPreRollSec - 4) < 0.6, { partial: j3.partialPreRoll, pre: j3.actualPreRollSec });

    // cricket: no sport → its own window and endpoint, as before
    const ck = await seCall('POST', '/clip', { json: { matchId: M.matchId, eventType: 'FOUR', timestamp: Date.now(), ballMeta: { over: 1, ballInOver: 2 } } });
    const ckJob = (await seCall('GET', `/clip-jobs/${ck.json.clipId}`)).json.job;
    eq('a request without `sport` is a cricket clip: 15 s / 5 s, /api/clips/ingest', [ck.json.window.preRollSec, ck.json.window.postRollSec, ckJob.sport], [15, 5, 'cricket']);
  } finally {
    se.kill('SIGTERM');
    await sleep(300);
  }
  if (fail) console.log('\n--- stream engine log (tail) ---\n' + seLog.split('\n').slice(-40).join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
