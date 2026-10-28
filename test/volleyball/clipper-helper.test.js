/* 🎬 Volleyball point clips through the REAL Clipper Helper — the same
   local app the Cricket Panel uses (clipper-helper/server.js, run from a
   temp copy) — cutting from a vMix-like recording that is still being
   written:

     REAL website (server.js, in-memory MongoDB, stand-in R2)
       ⇄ a switchable "internet" (a proxy that can drop every connection)
       ⇄ REAL Clipper Helper ⇄ a growing fragmented MP4 written live by
         ffmpeg (what vMix writes while it records)

   Every frame of the recording carries its own time in its brightness
   (left third: second, middle: minute, right: the fraction of a second),
   so the first and last frame of a clip say exactly which moment of the
   recording it holds. Proven here:
     • no recording yet → the helper says so (nothing is "ready")
     • a point 15 s+ into the recording → 18 s: the 15 s of the rally
       before the press and 3 s after it — the moment of the press is in it
     • a point a few seconds after vMix started → only what exists, marked
       as a short lead-in — never padded
     • three quick points → three jobs, three clips, each its own window
     • the same point sent again → the same job (never a second clip)
     • the clip reaches the website under its point, plays back, and
       follows the scorer's attribution: the kill's player (by id), a team
       point, still pending; it is filed locally under the player too
     • no internet → cut and filed anyway, uploaded ONCE when it is back
     • the helper restarted mid-queue → the job carries on, nothing is
       re-cut or re-uploaded
     • a second match → its own jobs and folders; the first match's keep
       theirs
     • the recording stopped → a later point says so honestly
     • a cricket press is still a cricket clip (15 s / 3 s, /api/clips/ingest)

     NODE_PATH=$(npm root -g) node test/volleyball/clipper-helper.test.js
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFileSync, spawnSync } = require('child_process');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
const head = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
if (spawnSync(FFMPEG, ['-version']).status !== 0) { console.log('clipper-helper: no ffmpeg — skipped'); process.exit(0); }

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
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// The recording's own time at one frame of a file: 6×2 Y samples
// (read as yuv420p — gray would rescale TV range), one column pair per third.
function timeAt(file, which) {
  const args = which === 'first'
    ? ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=6:2:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']
    : ['-v', 'error', '-sseof', '-0.25', '-i', file, '-frames:v', '1', '-vf', 'scale=6:2:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'];
  const y = execFileSync(FFMPEG, args).subarray(0, 12);
  const col = (a) => (y[a] + y[a + 1] + y[a + 6] + y[a + 7]) / 4;
  const sec = Math.round((col(0) - 16) / 3), min = Math.round((col(2) - 16) / 3), frac = Math.max(0, Math.min(0.999, (col(4) - 16) / 200));
  return min * 60 + sec + frac;
}
function duration(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file]);
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(r.stderr));
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-clipper-'));
  const recDir = path.join(tmp, 'vMix Recordings');
  fs.mkdirSync(recDir, { recursive: true });
  const U = { uid: 'u-work', email: 'workallsportslive@gmail.com', email_verified: true };
  const { port } = await bootServer({ idTokens: { tok: U }, users: { 'u-work': U.email } });
  const api = (m, u, o) => call(port, m, u, Object.assign({ token: 'tok' }, o || {}));

  // ---- the "internet" between the helper and the website ----
  const netState = { offline: false, hits: [] };
  const proxyPort = await freePort();
  const proxy = http.createServer((req, res) => {
    netState.hits.push({ method: req.method, url: req.url, at: Date.now(), offline: netState.offline });
    if (netState.offline) { req.socket.destroy(); return; }
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { try { res.destroy(); } catch (e) { /* gone */ } });
    req.pipe(up);
  }).listen(proxyPort, '127.0.0.1');
  const ingests = (clipId, prefix) => netState.hits.filter((h) => !h.offline && h.method === 'POST' && h.url.startsWith(prefix || '/api/volleyball/clips/ingest') && h.url.includes(`clipId=${encodeURIComponent(clipId)}`)).length;

  // ---- the match ----
  const mk = (n) => Array.from({ length: 9 }, (_, i) => ({ name: `${n} Player${i + 1}`, number: String(i + 1), libero: i === 8 }));
  const tA = (await api('POST', '/api/volleyball/teams', { json: { name: 'Pune Panthers', shortName: 'PUN', players: mk('Pune') } })).json.team;
  const tB = (await api('POST', '/api/volleyball/teams', { json: { name: 'Goa Waves', shortName: 'GOA', players: mk('Goa') } })).json.team;
  const T = (await api('POST', '/api/volleyball/tournaments', { json: { name: 'Clipper Cup', teamIds: [tA.teamId, tB.teamId] } })).json.tournament;
  const newMatch = async () => {
    const M = (await api('POST', `/api/volleyball/tournaments/${T.tournamentId}/matches`, { json: { teamA: tA.teamId, teamB: tB.teamId } })).json.match;
    const full = (await api('GET', `/api/volleyball/matches/${M.matchId}`)).json.match;
    const lease = (await api('POST', `/api/volleyball/matches/${M.matchId}/lease`, { json: { deviceId: 'pc' } })).json.leaseToken;
    let n = 0;
    const ev = (e) => api('POST', `/api/volleyball/matches/${M.matchId}/events`, { json: { event: Object.assign({ eventId: `${M.matchId.slice(-4)}e${++n}`, at: Date.now() }, e) }, headers: { 'x-vb-lease': lease } }).then((r) => r.json);
    await ev({ type: 'TOSS', winner: 'A', choice: 'serve', leftSide: 'A' });
    await ev({ type: 'LINEUP', team: 'A', positions: tA.players.slice(0, 6).map((p) => p.playerId) });
    await ev({ type: 'LINEUP', team: 'B', positions: tB.players.slice(0, 6).map((p) => p.playerId) });
    await ev({ type: 'SET_START' });
    return { M: Object.assign(M, { clipToken: full.clipToken }), ev };
  };
  const m1 = await newMatch();
  const MID = m1.M.matchId;

  // ---- the helper, from a temp copy (its config / queue files stay out of the repo) ----
  const hDir = path.join(tmp, 'ClipperHelper');
  fs.mkdirSync(hDir);
  for (const f of ['server.js', 'fmp4.js', 'clipOrganizer.js', 'volleyballOrganizer.js', 'package.json']) fs.copyFileSync(path.join(REPO, 'clipper-helper', f), path.join(hDir, f));
  const hPort = await freePort();
  // the one-time setup of a PC: where vMix records (the folder); the website link is handed over by the panel
  fs.writeFileSync(path.join(hDir, 'config.json'), JSON.stringify({ port: hPort, vmixRecordingFile: recDir, clipsFolder: '', mainServerUrl: '', preRollSeconds: 15, postRollSeconds: 3 }));
  let hLog = '';
  let helper = null;
  const startHelper = () => {
    helper = spawn(process.execPath, [path.join(hDir, 'server.js')], { env: Object.assign({}, process.env, { NODE_PATH: path.join(REPO, 'node_modules'), CLIPPER_NO_BROWSER: '1', FFMPEG_PATH: FFMPEG }), stdio: ['ignore', 'pipe', 'pipe'] });
    helper.stdout.on('data', (d) => { hLog += d; }); helper.stderr.on('data', (d) => { hLog += d; });
  };
  const H = (m, u, o) => call(hPort, m, u, o);
  const helperUp = async () => { for (let i = 0; i < 100; i++) { await sleep(100); try { if ((await H('GET', '/status')).status === 200) return true; } catch (e) { /* booting */ } } return false; };
  startHelper();
  let recorder = null, early = null;
  const madeMatches = [MID];
  try {
    head('1 · NO RECORDING YET');
    ok('the helper runs', await helperUp());
    await sleep(5500);   // one recording check (every 5 s)
    let st = (await H('GET', '/status')).json;
    ok('it says there is no recording (so nothing can be READY)', !st.currentRecordingFile && /No recording file found/.test(st.recordingError || ''), st.recordingError);
    ok('it knows volleyball points (v5.3+), with the 15 s + 3 s window', st.volleyball === true && st.volleyballClipTiming && st.volleyballClipTiming.beforeSeconds === 15 && st.volleyballClipTiming.afterSeconds === 3, st.volleyballClipTiming);

    // what the panel sends for a point (volleyball-clipper.js → point())
    let pointNo = 0, sa = 0, sb = 0, uid = 0;
    const pointOf = async (mm, team, extra) => {
      const eventId = `pt${mm.M.matchId.slice(-4)}u${++uid}`;
      ++pointNo;
      const t0 = Date.now();
      const r = await mm.ev(Object.assign({ eventId, type: 'RALLY', winner: team, outcome: 'GENERAL', at: t0 }, extra || {}));
      if (team === 'A') sa++; else sb++;
      const body = { sport: 'volleyball', matchId: mm.M.matchId, clipId: `${mm.M.matchId}_${eventId}`, timestamp: t0, sessionId: 'clp-test',
        point: { eventId, set: 1, pointNo, team, teamId: team === 'A' ? tA.teamId : tB.teamId, teamName: team === 'A' ? 'Pune Panthers' : 'Goa Waves', teamShort: team === 'A' ? 'PUN' : 'GOA',
          teamNames: { A: 'Pune Panthers', B: 'Goa Waves' }, score: { A: sa, B: sb }, outcome: 'GENERAL', attribution: null, players: [], vbClipToken: mm.M.clipToken, at: t0 },
        matchLabel: 'Pune Panthers v Goa Waves', tournamentId: T.tournamentId, tournamentName: 'Clipper Cup' };
      const c = (await H('POST', '/clip', { json: body })).json;
      return { eventId, clipId: body.clipId, t0, body, accept: c, scored: r };
    };
    const job = async (clipId) => ((await H('GET', `/clip-jobs/${clipId}`)).json || {}).job || null;
    const waitJob = async (clipId, states, ms) => { const until = Date.now() + (ms || 40000); let j = null; while (Date.now() < until) { j = await job(clipId); if (j && states.includes(j.syncStatus)) return j; await sleep(400); } return j; };
    const siteClip = async (eventId, mid) => ((await api('GET', `/api/volleyball/matches/${mid || MID}/clips?eventId=${eventId}`)).json.clips || [])[0] || null;

    head('2 · vMIX STARTS RECORDING — found by itself, set up for this match');
    // a fragmented MP4 written in real time (1-second fragments), like vMix's MP4 recording
    const recFile = path.join(recDir, 'capture.mp4');
    const W0 = Date.now();
    recorder = spawn(FFMPEG, ['-v', 'error', '-re', '-f', 'lavfi', '-i', "color=black:s=384x192:r=25,format=yuv420p,geq=lum='if(lt(X,128),16+3*mod(floor(T),60),if(lt(X,256),16+3*floor(T/60),16+200*(T-floor(T))))':cb=128:cr=128",
      '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-keyint_min', '25', '-c:a', 'aac',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1', '-f', 'mp4', recFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    let recErr = ''; recorder.stderr.on('data', (d) => { recErr += d; });
    // the operator presses Start Clipper as vMix starts recording, and the first point comes 6 s later
    await H('POST', '/recording-start', { json: { startedAt: Date.now(), matchId: MID, mainServerUrl: `http://127.0.0.1:${proxyPort}`, sport: 'volleyball', matchLabel: 'Pune Panthers v Goa Waves', tournamentId: T.tournamentId, tournamentName: 'Clipper Cup' } });
    await sleep(Math.max(0, W0 + 6000 - Date.now()));
    early = await pointOf(m1, 'A');
    for (let i = 0; i < 40; i++) { await sleep(500); st = (await H('GET', '/status')).json; if (st.recordingGrowing && st.recordingSeconds) break; }
    ok('the file vMix is writing is found in the recording folder — no path typed', st.currentRecordingFile === recFile && st.recordingGrowing === true, { file: st.currentRecordingFile, growing: st.recordingGrowing, err: st.recordingError || recErr });
    const rs = (await H('POST', '/recording-start', { json: { startedAt: Date.now(), matchId: MID, mainServerUrl: `http://127.0.0.1:${proxyPort}`, sport: 'volleyball', matchLabel: 'Pune Panthers v Goa Waves', tournamentId: T.tournamentId, tournamentName: 'Clipper Cup' } })).json;
    st = (await H('GET', '/status')).json;
    ok('the panel hands over the match and the website — the helper is set up for THIS match', rs.success && st.matchId === MID && st.sport === 'volleyball' && st.mainServerUrl === `http://127.0.0.1:${proxyPort}`, { rs, matchId: st.matchId, sport: st.sport });
    ok('…its folders exist before the first point', fs.existsSync(path.join(recDir, 'Clips', 'Clipper-Cup', `Pune-Panthers-v-Goa-Waves_${MID}`, 'Players')));
    ok('one recording only — nothing ambiguous', !st.recordingAmbiguous, st.recordingAmbiguous);

    head('3 · A POINT A FEW SECONDS AFTER vMIX STARTED — only what exists');
    ok('the press was accepted at once, and the point was already on the scoreboard', early.accept.success && early.scored.success && early.scored.summary.points.A === 1, { accept: early.accept, scored: early.scored && early.scored.summary && early.scored.summary.points });
    let j = await waitJob(early.clipId, ['SYNC_COMPLETE', 'CUT_FAILED'], 45000);
    const lead = (early.t0 - W0) / 1000;
    ok('the clip has the ~6 s that exist before the press (+3 s after) — not padded to 18 s', j && j.clipSeconds != null && near(j.clipSeconds, lead + 3, 1.2) && j.window.partialPreRoll === true && near(j.window.actualPreRollSec, lead, 1.2), j && { clipSeconds: j.clipSeconds, window: j.window, lead });
    ok('…and it starts at the very start of the recording', j && j.localPath && near(timeAt(j.localPath, 'first'), 0, 1.0), j && j.localPath && timeAt(j.localPath, 'first'));
    let sc = await siteClip(early.eventId);
    ok('…on the website it is marked a short lead-in', sc && sc.actual.partialPreRoll === true, sc && sc.actual);

    head('4 · A NORMAL POINT — the rally before the press, and its end');
    await sleep(Math.max(0, W0 + 24000 - Date.now()));
    const p = await pointOf(m1, 'B');
    j = await waitJob(p.clipId, ['WAITING'], 2000);
    ok('it waits for the 3 s after the point to be recorded first', j && j.syncStatus === 'WAITING', j && j.syncStatus);
    j = await waitJob(p.clipId, ['SYNC_COMPLETE', 'CUT_FAILED'], 45000);
    const exp0 = (p.t0 - 15000 - W0) / 1000, exp1 = (p.t0 + 3000 - W0) / 1000;
    const f0 = j && j.localPath ? timeAt(j.localPath, 'first') : null, f1 = j && j.localPath ? timeAt(j.localPath, 'last') : null;
    ok('18 s long', j && near(j.clipSeconds, 18, 0.6) && near(duration(j.localPath), 18, 0.6), j && j.clipSeconds);
    ok('it starts 15 s before the press (recording time, ±1 s)', near(f0, exp0, 1.0), { first: f0, expected: exp0 });
    ok('it ends 3 s after the press (±1 s) — the moment of the point is inside it', near(f1, exp1, 1.0) && f0 < (p.t0 - W0) / 1000 && f1 > (p.t0 - W0) / 1000, { last: f1, expected: exp1 });
    ok('filed by set and point beside the master recording', j && /[\\/]Set-1[\\/]S1-P002_1-1_GOA\.mp4$/.test(j.localPath), j && j.localPath);
    ok('the recording it came from is remembered with the part used', j && j.sourceRecording === 'capture.mp4', j && j.sourceRecording);
    sc = await siteClip(p.eventId);
    ok('the website has it, linked to its point, playable', sc && ['COMPLETE', 'SERVER_ONLY'].includes(sc.status) && sc.eventId === p.eventId && sc.watchUrl && sc.engine === 'clipper-helper', sc && { status: sc.status, engine: sc.engine });
    ok('…with the moment and the recording it was cut from (a file name, never a local path)', sc && sc.source && sc.source.recording === 'capture.mp4' && sc.windowStart === p.t0 - 15000 && !/[\\/]/.test(sc.source.recording), sc && sc.source);
    ok('…nobody has said who earned it yet: pending, no player', sc && sc.attribution.pending === true && sc.players.length === 0, sc && sc.attribution);
    const r2 = [...bucket.keys()].find((k) => k.includes(p.clipId));
    ok('…uploaded to R2 under its set and point', !!r2 && /^volleyball\/[^/]+\/[^/]+\/set-1\/point-2-/.test(r2), r2);
    const vid = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: sc.watchUrl.replace(/^https?:\/\/[^/]+/, '') }, (res) => { res.resume(); resolve(res.statusCode); }));
    ok('…and its playback link answers', [200, 302].includes(vid), vid);

    head('5 · WHO EARNED IT — the clip follows the point');
    const killer = tB.players[2];
    let r = await m1.ev({ eventId: 'attr1', type: 'CORRECT', target: p.eventId, patch: { outcome: 'ATTACK_KILL', players: { attacker: killer.playerId } }, reason: 'Point attribution', attribution: true });
    ok('the attribution is saved (a logged correction)', r.success, r);
    sc = await siteClip(p.eventId);
    ok('the clip is linked to the player by id — with the name and number to show', sc && sc.attribution.type === 'kill' && sc.attribution.playerId === killer.playerId && sc.players.some((x) => x.playerId === killer.playerId && x.name === killer.name && x.number === '3'), sc && { a: sc.attribution, players: sc.players });
    const byPlayer = (await api('GET', `/api/volleyball/matches/${MID}/clips?playerId=${killer.playerId}`)).json.clips.map((x) => x.eventId);
    ok('…and appears in that player’s clips', byPlayer.includes(p.eventId), byPlayer);
    const meta = (await H('POST', '/clip-meta', { json: { clipId: p.clipId, sport: 'volleyball', point: { attribution: 'kill', players: [{ playerId: killer.playerId, name: killer.name, number: '3', team: 'B', role: 'attacker' }], outcome: 'ATTACK_KILL', voided: false } } })).json;
    j = await job(p.clipId);
    ok('on this PC the same file is renamed for the kill — never cut again', meta.success && /S1-P002_1-1_GOA_Kill_3-Goa-Player3\.mp4$/.test(j.localPath) && fs.existsSync(j.localPath) && j.cutAttempts === 1, j && { path: j.localPath, cuts: j.cutAttempts });
    const link = j.links && j.links[0] && j.links[0].path;
    ok('…and linked into the player’s folder (the same bytes)', link && /Players[\\/]Goa-Waves[\\/]3-Goa-Player3[\\/]Set-1[\\/]/.test(link) && fs.statSync(link).ino === fs.statSync(j.localPath).ino, link);
    const card = link && JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(link)), 'player.json'), 'utf8'));
    ok('…whose card keeps the real player id', card && card.playerId === killer.playerId, card);
    ok('the upload was not repeated for the attribution', ingests(p.clipId) === 1, ingests(p.clipId));

    head('6 · THREE QUICK POINTS — three jobs, three clips, each its own moment');
    const q = [];
    for (let i = 0; i < 3; i++) { q.push(await pointOf(m1, i % 2 ? 'B' : 'A')); await sleep(1500); }
    const dup = (await H('POST', '/clip', { json: q[0].body })).json;
    ok('the same point sent again is the same job (never a second clip)', dup.success && dup.duplicate === true, dup);
    const qj = [];
    for (const x of q) qj.push(await waitJob(x.clipId, ['SYNC_COMPLETE', 'CUT_FAILED'], 50000));
    ok('all three were cut and uploaded', qj.every((x) => x && x.syncStatus === 'SYNC_COMPLETE'), qj.map((x) => x && x.syncStatus));
    ok('three different files', new Set(qj.map((x) => x.localPath)).size === 3);
    ok('each starts 15 s before its own press (±1 s)', q.every((x, i) => near(timeAt(qj[i].localPath, 'first'), (x.t0 - 15000 - W0) / 1000, 1.0)), q.map((x, i) => [timeAt(qj[i].localPath, 'first'), (x.t0 - 15000 - W0) / 1000]));
    ok('…and the website has one clip per point, each under its own point', (await Promise.all(q.map((x) => siteClip(x.eventId)))).every((c, i) => c && c.eventId === q[i].eventId) && q.every((x) => ingests(x.clipId) === 1), q.map((x) => ingests(x.clipId)));
    // a team point (decided, no name) and one left to assign
    await m1.ev({ eventId: 'attr2', type: 'CORRECT', target: q[1].eventId, patch: { outcome: 'GENERAL', players: null }, reason: 'Point attribution', attribution: true });
    const tp = await siteClip(q[1].eventId), pend = await siteClip(q[2].eventId);
    ok('a team point: decided, no player — still a clip of the match', tp && tp.attribution.type === 'team' && !tp.attribution.pending && tp.players.length === 0, tp && tp.attribution);
    ok('a point nobody assigned: kept, pending, assignable later', pend && pend.attribution.pending === true && ['COMPLETE', 'SERVER_ONLY'].includes(pend.status), pend && pend.attribution);

    head('7 · UNDO A POINT — the clip is kept and marked');
    r = await m1.ev({ eventId: 'undo1', type: 'UNDO' });
    ok('Undo takes back the LAST POINT, not an attribution', r.success && r.summary.points.A + r.summary.points.B === 4, r && r.summary && r.summary.points);
    sc = await siteClip(q[2].eventId);
    ok('its clip is still there, marked as a point that no longer counts', sc && sc.eventVoided === true && ['COMPLETE', 'SERVER_ONLY'].includes(sc.status), sc && { voided: sc.eventVoided, status: sc.status });
    await H('POST', '/clip-meta', { json: { clipId: q[2].clipId, sport: 'volleyball', point: { attribution: null, players: [], voided: true } } });
    ok('…and the helper knows (its file stays where it is)', (await job(q[2].clipId)).point.voided === true && fs.existsSync((await job(q[2].clipId)).localPath));
    sa = 2; sb = 2; pointNo = 4;   // the undone point no longer counts

    head('8 · NO INTERNET — cut and filed anyway, uploaded once when it is back');
    netState.offline = true;
    const off = await pointOf(m1, 'A');
    j = await waitJob(off.clipId, ['OFFLINE_PENDING'], 50000);
    ok('the clip is cut and saved on this PC, waiting for the internet', j && j.syncStatus === 'OFFLINE_PENDING' && fs.existsSync(j.localPath), j && j.syncStatus);
    st = (await H('GET', '/status')).json;
    ok('the helper reports being offline (cutting goes on)', st.online === false, st.online);
    netState.offline = false;
    await H('POST', '/sync-now', { json: {} });
    j = await waitJob(off.clipId, ['SYNC_COMPLETE'], 40000);
    ok('back online: uploaded by itself', j && j.syncStatus === 'SYNC_COMPLETE', j && j.syncStatus);
    ok('…exactly once', ingests(off.clipId) === 1, ingests(off.clipId));

    head('9 · THE HELPER RESTARTED MID-QUEUE — nothing lost, nothing twice');
    const rp = await pointOf(m1, 'B');
    helper.kill('SIGTERM');
    await new Promise((res) => helper.once('exit', res));
    startHelper();
    ok('it comes back', await helperUp());
    j = await waitJob(rp.clipId, ['SYNC_COMPLETE', 'CUT_FAILED'], 50000);
    ok('the point pressed before the restart is cut afterwards, from its own moment', j && j.syncStatus === 'SYNC_COMPLETE' && near(timeAt(j.localPath, 'first'), (rp.t0 - 15000 - W0) / 1000, 1.0), j && j.syncStatus);
    await sleep(3000);
    ok('clips finished before the restart are not uploaded again', ingests(p.clipId) === 1 && ingests(off.clipId) === 1, [ingests(p.clipId), ingests(off.clipId)]);

    head('10 · THE NEXT MATCH — its own jobs and folders');
    const m2 = await newMatch();
    madeMatches.push(m2.M.matchId);
    await H('POST', '/recording-start', { json: { startedAt: Date.now(), matchId: m2.M.matchId, mainServerUrl: `http://127.0.0.1:${proxyPort}`, sport: 'volleyball', matchLabel: 'Pune Panthers v Goa Waves', tournamentId: T.tournamentId, tournamentName: 'Clipper Cup' } });
    sa = 0; sb = 0;
    const n2 = await pointOf(m2, 'A');
    j = await waitJob(n2.clipId, ['SYNC_COMPLETE', 'CUT_FAILED'], 45000);
    ok('the new match’s point is its own job, in its own folder', j && j.matchId === m2.M.matchId && j.localPath.includes(m2.M.matchId) && !j.localPath.includes(MID), j && j.localPath);
    ok('…and on the website it belongs to that match', !!(await siteClip(n2.eventId, m2.M.matchId)) && !(await siteClip(n2.eventId, MID)));
    const old = await job(p.clipId);
    ok('the first match’s clips keep their match, player and file', old.matchId === MID && old.point.players[0].playerId === killer.playerId && fs.existsSync(old.localPath));

    head('11 · A CRICKET PRESS IS STILL A CRICKET CLIP');
    const ct0 = Date.now();
    const cr = (await H('POST', '/clip', { json: { eventType: 'FOUR', timestamp: ct0, matchId: 'CRICKET1', ballMeta: { innings: 1, over: 3, ballInOver: 2, striker: 'Rohit Sharma', bowler: 'Jasprit Bumrah' } } })).json;
    j = await waitJob(cr.clipId, ['LOCAL_SAVED', 'SENDING', 'SENT', 'SYNC_RETRY', 'OFFLINE_PENDING', 'SYNC_COMPLETE', 'CUT_FAILED'], 40000);
    ok('cut with cricket’s own window (15 s + 3 s) into the cricket folders', j && j.sport === 'cricket' && near(j.clipSeconds, 18, 0.6) && /[\\/]Highlights[\\/]4[\\/]03\.2_FOUR_Rohit-Sharma_vs_Jasprit-Bumrah\.mp4$/.test(j.localPath), j && { sport: j.sport, path: j.localPath, s: j.clipSeconds, st: j.syncStatus, err: j.error });
    await sleep(2500);
    ok('…and sent to the cricket ingest, not the volleyball one', ingests(cr.clipId, '/api/clips/ingest') >= 1 && ingests(cr.clipId) === 0, [ingests(cr.clipId, '/api/clips/ingest'), ingests(cr.clipId)]);

    head('12 · vMIX STOPPED RECORDING — said honestly');
    recorder.kill('SIGINT');
    await new Promise((res) => recorder.once('exit', res));
    recorder = null;
    await sleep(22000);   // the helper's rule: no growth for 15 s (checked every 5 s)
    st = (await H('GET', '/status')).json;
    ok('the helper sees the recording is no longer being written', st.recordingGrowing === false, st.recordingGrowing);
    const late = await pointOf(m2, 'B');
    ok('a point now is accepted but flagged: no recording running', late.accept.success && late.accept.recordingActive === false, late.accept);
    j = await waitJob(late.clipId, ['CUT_FAILED'], 40000);
    ok('…and it says the footage does not exist — no clip is invented', j && j.syncStatus === 'CUT_FAILED' && /not recording|no footage|before the start/i.test(j.error || ''), j && j.error);
    const rt = (await H('POST', '/clip-retry', { json: { clipId: late.clipId } })).json;
    ok('Retry tries the same job again (no second job)', rt.success && (await H('GET', '/clip-jobs?matchId=' + m2.M.matchId)).json.jobs.filter((x) => x.clipId === late.clipId).length === 1, rt);
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e.stack || e));
  } finally {
    if (recorder) try { recorder.kill('SIGKILL'); } catch (e) { /* gone */ }
    if (helper) try { helper.kill('SIGKILL'); } catch (e) { /* gone */ }
    proxy.close();
    if (fail) console.log('\n--- helper log (last 4000 chars) ---\n' + hLog.slice(-4000));
    // what this test stored on the website's disk, and the fake recording
    for (const id of madeMatches) fs.rmSync(path.join(REPO, 'clips', 'volleyball', id), { recursive: true, force: true });
    fs.rmSync(path.join(REPO, 'clips', 'CRICKET1'), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})();
