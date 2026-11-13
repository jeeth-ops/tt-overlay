/* 🎬 Tennis point clips through the REAL Tennis Clipper — tennis's own
   local program (tennis-clipper-helper/tennis-clipper-server.js →
   TennisClipper.exe, run from a temp copy; NOT the Cricket Clipper, NOT
   the Volleyball Clipper) — cutting from a vMix-like recording that is
   still being written:

     REAL website (server.js, in-memory MongoDB, stand-in R2)
       ⇄ a switchable "internet" (a proxy that can drop every connection)
       ⇄ REAL Tennis Clipper ⇄ a growing fragmented MP4 written live by
         ffmpeg (what vMix writes while it records)

   Every frame of the recording carries its own time in its brightness
   (left third: second, middle: minute, right: the fraction of a second),
   so the first and last frame of a clip say exactly which moment of the
   recording it holds. Proven here:
     • no recording yet → the clipper says so; it says who it is (tennis,
       port of its own, 7 s + 3 s); its own settings file
     • a second copy started while it runs closes by itself
     • a point a few seconds after vMix started → only what exists, marked
       as a short lead-in — never padded
     • a normal point → 10 s: 7 s before the press, 3 s after (the cut waits
       for them) — filed by set, game and point; on the website under its
       point, made by the Tennis Clipper, in R2 by set/game/point
     • the match's own window (the website's clip settings, handed over at
       Start) → that many seconds, not this PC's default
     • an ace → filed as an ace and linked into the server's folder; the
       scorer re-classifies it → the same file renamed, never cut or
       uploaded again; the website follows the point
     • a double fault → the receiver's highlight, never the server's
     • three quick points → three jobs, three clips; the same point sent
       again → the same job
     • a clip pressed by hand (the phone remote's "clip that") → its own
       window, filed under the set's Moments, on the website with its kind
       and its player; a bad hand clip id is refused
     • no internet → cut and filed anyway, uploaded ONCE when it is back
     • restarted mid-queue → carries on, nothing re-cut or re-uploaded
     • a cricket or volleyball press or session is refused
     • the recording stopped → a later point says so honestly; Retry is the
       same job

     NODE_PATH=$(npm root -g) node test/tennis/clipper-helper.test.js

   TN_CLIPPER_BIN=<a TennisClipper binary from `npm run build`> runs the
   same checks against the packaged program instead of its source.
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
const E = require('../../tennis-engine.js');
const Stats = require('../../tennis-stats.js');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-clipper-'));
  const recDir = path.join(tmp, 'vMix Recordings');
  fs.mkdirSync(recDir, { recursive: true });
  const U = { uid: 'u-work', email: 'workallsportslive@gmail.com', email_verified: true };
  const { port } = await bootServer({ idTokens: { tok: U }, users: { 'u-work': U.email } });
  const api = (m, u, o) => call(port, m, u, Object.assign({ token: 'tok' }, o || {}));

  // ---- the "internet" between the clipper and the website ----
  const netState = { offline: false, hits: [] };
  const proxyPort = await freePort();
  const proxy = http.createServer((req, res) => {
    netState.hits.push({ method: req.method, url: req.url, at: Date.now(), offline: netState.offline, meta: req.headers['x-point-meta'] || null });
    if (netState.offline) { req.socket.destroy(); return; }
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { try { res.destroy(); } catch (e) { /* gone */ } });
    req.pipe(up);
  }).listen(proxyPort, '127.0.0.1');
  const ingests = (clipId, prefix) => netState.hits.filter((h) => !h.offline && h.method === 'POST' && h.url.startsWith(prefix || '/api/tennis/clips/ingest') && h.url.includes(`clipId=${encodeURIComponent(clipId)}`)).length;

  // ---- the match ----
  const mkP = async (name) => (await api('POST', '/api/tennis/players', { json: { name, force: true } })).json.player;
  const PA = await mkP('Carlos Alcaraz'), PB = await mkP('Jannik Sinner');
  const T = (await api('POST', '/api/tennis/tournaments', { json: { name: 'Clipper Open', surface: 'hard', visibility: 'public' } })).json.tournament;
  const setupOf = (m) => E.normalizeSetup({ format: m.format, rules: m.rules, sides: { A: { name: m.sides.A.name, players: m.sides.A.players.map((p) => ({ playerId: p.playerId, name: p.name })) }, B: { name: m.sides.B.name, players: m.sides.B.players.map((p) => ({ playerId: p.playerId, name: p.name })) } } });
  const newMatch = async () => {
    const M = (await api('POST', `/api/tennis/tournaments/${T.tournamentId}/matches`, { json: { format: 'singles', sideA: { playerIds: [PA.playerId] }, sideB: { playerIds: [PB.playerId] }, rules: { bestOf: 3 } } })).json.match;
    const full = (await api('GET', `/api/tennis/matches/${M.matchId}`)).json.match;
    const lease = (await api('POST', `/api/tennis/matches/${M.matchId}/lease`, { json: { deviceId: 'pc' } })).json.leaseToken;
    let n = 0;
    const ev = (e) => api('POST', `/api/tennis/matches/${M.matchId}/events`, { json: { event: Object.assign({ eventId: `${M.matchId.slice(-4)}e${++n}`, at: Date.now() }, e) }, headers: { 'x-tn-lease': lease } }).then((r) => r.json);
    await ev({ type: 'TOSS', winner: 'A', choice: 'serve', firstServe: 'A', left: 'A' });
    await ev({ type: 'START', server: PA.playerId, left: 'A' });
    return { M: Object.assign(M, { clipToken: full.clipToken }), full, setup: setupOf(full), ev };
  };
  const m1 = await newMatch();
  const MID = m1.M.matchId;

  // ---- the Tennis Clipper, from a temp copy (its settings / queue files stay out of the repo) ----
  const hDir = path.join(tmp, 'TennisClipper');
  fs.mkdirSync(hDir);
  const BIN = process.env.TN_CLIPPER_BIN ? path.join(hDir, 'TennisClipper.exe') : null;
  if (BIN) { fs.copyFileSync(process.env.TN_CLIPPER_BIN, BIN); fs.chmodSync(BIN, 0o755); }
  else for (const f of ['tennis-clipper-server.js', 'tn-fmp4.js', 'tn-organizer.js', 'package.json']) fs.copyFileSync(path.join(REPO, 'tennis-clipper-helper', f), path.join(hDir, f));
  const hPort = await freePort();
  // the one-time setup of a PC: where vMix records (the folder); the website link is handed over by the panel (default window: 7 s + 3 s)
  fs.writeFileSync(path.join(hDir, 'tennis-clipper-config.json'), JSON.stringify({ port: hPort, vmixRecordingFile: recDir, clipsFolder: '', mainServerUrl: '' }));
  let hLog = '';
  let helper = null;
  const spawnHelper = () => spawn(BIN || process.execPath, BIN ? [] : [path.join(hDir, 'tennis-clipper-server.js')], { env: Object.assign({}, process.env, { NODE_PATH: path.join(REPO, 'node_modules'), CLIPPER_NO_BROWSER: '1', FFMPEG_PATH: FFMPEG }), stdio: ['ignore', 'pipe', 'pipe'] });
  const startHelper = () => {
    helper = spawnHelper();
    helper.stdout.on('data', (d) => { hLog += d; }); helper.stderr.on('data', (d) => { hLog += d; });
  };
  const H = (m, u, o) => call(hPort, m, u, o);
  const helperUp = async () => { for (let i = 0; i < 100; i++) { await sleep(100); try { if ((await H('GET', '/status')).status === 200) return true; } catch (e) { /* booting */ } } return false; };
  const session = (mm, extra) => H('POST', '/recording-start', { json: Object.assign({ startedAt: Date.now(), matchId: mm.M.matchId, mainServerUrl: `http://127.0.0.1:${proxyPort}`, sport: 'tennis', matchLabel: 'Carlos Alcaraz v Jannik Sinner', tournamentId: T.tournamentId, tournamentName: 'Clipper Open' }, extra || {}) });
  startHelper();
  let recorder = null, early = null;
  const madeMatches = [MID];
  try {
    head('1 · NO RECORDING YET — and who it is');
    ok('the Tennis Clipper runs', await helperUp());
    await sleep(5500);   // one recording check (every 5 s)
    let st = (await H('GET', '/status')).json;
    ok('it says there is no recording (so nothing can be READY)', !st.currentRecordingFile && /No recording file found/.test(st.recordingError || ''), st.recordingError);
    ok('it says who it is — the Tennis Clipper (not cricket’s, not volleyball’s), with the 7 s + 3 s = 10 s default', st.app === 'tennis-clipper' && st.exe === 'TennisClipper.exe' && st.tennis === true && st.sport === 'tennis' && !st.volleyball && st.tennisClipTiming && st.tennisClipTiming.beforeSeconds === 7 && st.tennisClipTiming.afterSeconds === 3 && st.tennisClipTiming.durationSeconds === 10, { app: st.app, t: st.tennisClipTiming });
    ok('…its own settings file — no cricket config.json, no volleyball-clipper-config.json', fs.existsSync(path.join(hDir, 'tennis-clipper-config.json')) && !fs.existsSync(path.join(hDir, 'config.json')) && !fs.existsSync(path.join(hDir, 'volleyball-clipper-config.json')));
    const jobsFile = path.join(hDir, 'tennis-clip-jobs.json');
    const jobsWas = fs.existsSync(jobsFile) ? fs.statSync(jobsFile).mtimeMs : null;
    const second = spawnHelper();
    let secondLog = '';
    second.stdout.on('data', (d) => { secondLog += d; }); second.stderr.on('data', (d) => { secondLog += d; });
    const secondCode = await Promise.race([new Promise((r) => second.once('exit', r)), sleep(15000).then(() => 'still running')]);
    if (secondCode === 'still running') second.kill('SIGKILL');
    const st2 = (await H('GET', '/status')).json;
    ok('a second copy started while it runs closes by itself (port in use); the running one carries on, its queue file untouched', secondCode === 1 && /already in use/.test(secondLog) && st2 && st2.pid === st.pid && (fs.existsSync(jobsFile) ? fs.statSync(jobsFile).mtimeMs : null) === jobsWas, { secondCode, log: secondLog.slice(-300) });

    // what the panel sends for a point (tennis-clipper.js → pointMeta())
    let uid = 0;
    const pointOf = async (mm, winner, extra, opts) => {
      opts = opts || {};
      const eventId = `pt${mm.M.matchId.slice(-4)}u${++uid}`;
      const t0 = Date.now();
      const r = await mm.ev(Object.assign({ eventId, type: 'POINT', winner, at: t0 }, extra || {}));
      const entry = r.entry || {};
      const b = entry.before || {}, af = entry.after || {};
      const players = Stats.pointParticipants(mm.setup, entry).map((p) => ({ playerId: p.playerId, side: p.side, role: p.role, name: mm.setup.byId[p.playerId].player.name }));
      const body = { sport: 'tennis', matchId: mm.M.matchId, clipId: `${mm.M.matchId}_${eventId}`, timestamp: t0, sessionId: 'clp-test',
        point: { eventId, set: b.set, game: b.game, pointNo: entry.pointNo, side: entry.side, sideName: mm.full.sides[entry.side].name, sides: { A: mm.full.sides.A.name, B: mm.full.sides.B.name },
          score: { games: af.games, points: af.points, sets: af.setsWon, tiebreak: !!af.tiebreak }, kind: Stats.clipKindOf(entry), pointKind: entry.kind || null,
          players, tnClipToken: mm.M.clipToken, at: t0, tournamentName: 'Clipper Open', preRollSec: opts.pre, postRollSec: opts.post },
        matchLabel: 'Carlos Alcaraz v Jannik Sinner', tournamentId: T.tournamentId, tournamentName: 'Clipper Open' };
      const c = (await H('POST', '/clip', { json: body })).json;
      return { eventId, clipId: body.clipId, t0, body, accept: c, scored: r, entry };
    };
    const job = async (clipId) => ((await H('GET', `/clip-jobs/${encodeURIComponent(clipId)}`)).json || {}).job || null;
    const waitJob = async (clipId, states, ms) => { const until = Date.now() + (ms || 40000); let j = null; while (Date.now() < until) { j = await job(clipId); if (j && states.includes(j.syncStatus)) return j; await sleep(400); } return j; };
    const siteClips = async (mid) => (await api('GET', `/api/tennis/matches/${mid || MID}/clips`)).json.clips || [];
    const siteClip = async (eventId, mid) => ((await api('GET', `/api/tennis/matches/${mid || MID}/clips?eventId=${eventId}`)).json.clips || [])[0] || null;

    head('2 · vMIX STARTS RECORDING — found by itself, set up for this match');
    const recFile = path.join(recDir, 'capture.mp4');
    const W0 = Date.now();
    recorder = spawn(FFMPEG, ['-v', 'error', '-re', '-f', 'lavfi', '-i', "color=black:s=384x192:r=25,format=yuv420p,geq=lum='if(lt(X,128),16+3*mod(floor(T),60),if(lt(X,256),16+3*floor(T/60),16+200*(T-floor(T))))':cb=128:cr=128",
      '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-keyint_min', '25', '-c:a', 'aac',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1', '-f', 'mp4', recFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    let recErr = ''; recorder.stderr.on('data', (d) => { recErr += d; });
    await session(m1);
    await sleep(Math.max(0, W0 + 4000 - Date.now()));
    early = await pointOf(m1, 'A');
    for (let i = 0; i < 40; i++) { await sleep(500); st = (await H('GET', '/status')).json; if (st.recordingGrowing && st.recordingSeconds) break; }
    ok('the file vMix is writing is found in the recording folder — no path typed', st.currentRecordingFile === recFile && st.recordingGrowing === true, { file: st.currentRecordingFile, err: st.recordingError || recErr });
    const rs = (await session(m1)).json;
    st = (await H('GET', '/status')).json;
    ok('the panel hands over the match and the website — set up for THIS match', rs.success && rs.sport === 'tennis' && st.matchId === MID && st.mainServerUrl === `http://127.0.0.1:${proxyPort}`, { rs, matchId: st.matchId });
    ok('…its folders exist before the first point — in its OWN clips folder (TennisClips, never Clips or VolleyballClips)', fs.existsSync(path.join(recDir, 'TennisClips', 'Clipper-Open', `Carlos-Alcaraz-v-Jannik-Sinner_${MID}`, 'Players')) && !fs.existsSync(path.join(recDir, 'Clips')) && !fs.existsSync(path.join(recDir, 'VolleyballClips')));

    head('3 · A POINT A FEW SECONDS AFTER vMIX STARTED — only what exists');
    ok('the press was accepted at once, and the point was already on the scoreboard', early.accept.success && early.scored.success && early.scored.summary.display.A === '15', { accept: early.accept, display: early.scored.summary && early.scored.summary.display });
    let j = await waitJob(early.clipId, ['SYNC_COMPLETE', 'CUT_FAILED'], 45000);
    const lead = (early.t0 - W0) / 1000;
    ok('the clip has the ~4 s that exist before the press (+3 s after) — not padded to 10 s', j && j.clipSeconds != null && near(j.clipSeconds, lead + 3, 1.2) && j.window.partialPreRoll === true && near(j.window.actualPreRollSec, lead, 1.2), j && { clipSeconds: j.clipSeconds, window: j.window, lead });
    ok('…and it starts at the very start of the recording', j && j.localPath && near(timeAt(j.localPath, 'first'), 0, 1.0), j && j.localPath && timeAt(j.localPath, 'first'));
    let sc = await siteClip(early.eventId);
    ok('…on the website it is marked a short lead-in', sc && sc.actual.partialPreRoll === true, sc && sc.actual);

    head('4 · AN ACE — the point before the press and its end, filed by set, game and point');
    await sleep(Math.max(0, W0 + 24000 - Date.now()));
    const ace = await pointOf(m1, 'A', { kind: 'ACE', serve: 1 });
    j = await waitJob(ace.clipId, ['WAITING'], 2000);
    ok('it waits for the 3 s after the point to be recorded first', j && j.syncStatus === 'WAITING', j && j.syncStatus);
    j = await waitJob(ace.clipId, ['SYNC_COMPLETE', 'CUT_FAILED'], 45000);
    const exp0 = (ace.t0 - 7000 - W0) / 1000, exp1 = (ace.t0 + 3000 - W0) / 1000;
    const f0 = j && j.localPath ? timeAt(j.localPath, 'first') : null, f1 = j && j.localPath ? timeAt(j.localPath, 'last') : null;
    ok('10 s long', j && near(j.clipSeconds, 10, 0.6) && near(duration(j.localPath), 10, 0.6), j && j.clipSeconds);
    ok('it starts 7 s before the press (recording time, ±1 s)', near(f0, exp0, 1.0), { first: f0, expected: exp0 });
    ok('it ends 3 s after the press (±1 s) — the moment of the point is inside it', near(f1, exp1, 1.0) && f0 < (ace.t0 - W0) / 1000 && f1 > (ace.t0 - W0) / 1000, { last: f1, expected: exp1 });
    ok('filed by set, game and point — the score after it, who won it, an ace', j && /[\\/]TennisClips[\\/].*[\\/]Set-1[\\/]Game-01[\\/]S1-G01-P002_0-0_30-0_Alcaraz_Ace\.mp4$/.test(j.localPath), j && j.localPath);
    const aceLink = j && j.links && j.links[0];
    ok('…and linked (the same bytes) into the server’s own folder, once', j && j.links.length === 1 && aceLink && /Players[\\/]Carlos-Alcaraz[\\/]Carlos-Alcaraz[\\/]Set-1[\\/]/.test(aceLink.path) && fs.statSync(aceLink.path).ino === fs.statSync(j.localPath).ino, j && j.links);
    const card = aceLink && JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(aceLink.path)), 'player.json'), 'utf8'));
    ok('…whose card keeps the real player id', card && card.playerId === PA.playerId, card);
    ok('the recording it came from is remembered with the part used', j && j.sourceRecording === 'capture.mp4', j && j.sourceRecording);
    sc = await siteClip(ace.eventId);
    ok('the website has it, linked to its point, an ace, playable, made by the Tennis Clipper', sc && ['COMPLETE', 'SERVER_ONLY'].includes(sc.status) && sc.eventId === ace.eventId && sc.kind === 'ACE' && sc.watchUrl && sc.engine === 'tennis-clipper', sc && { status: sc.status, kind: sc.kind, engine: sc.engine });
    ok('…with the set, game and point, the server’s name on it, and the recording it was cut from (a file name, never a local path)', sc && sc.set === 1 && sc.game === 1 && sc.pointNo === 2 && sc.players.some((p) => p.playerId === PA.playerId && p.role === 'ace') && sc.source && sc.source.recording === 'capture.mp4' && !/[\\/]/.test(sc.source.recording), sc && { set: sc.set, game: sc.game, pointNo: sc.pointNo, players: sc.players, source: sc.source });
    const r2 = [...bucket.keys()].find((k) => k.includes(ace.clipId));
    ok('…uploaded to R2 under its set, game and point', !!r2 && new RegExp(`^tennis/${T.tournamentId}/${MID}/set-1/game-1/point-2-`).test(r2), r2);
    const sentMeta = JSON.parse((netState.hits.find((h) => h.url.includes(`clipId=${encodeURIComponent(ace.clipId)}`) && h.meta) || {}).meta || '{}');
    ok('…its one header says tennis, carries the match’s clip token, no local path', sentMeta.sport === 'tennis' && sentMeta.engine === 'tennis-clipper' && sentMeta.tnClipToken === m1.M.clipToken && !JSON.stringify(sentMeta).includes(recDir), Object.keys(sentMeta));
    const vid = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: sc.watchUrl.replace(/^https?:\/\/[^/]+/, '') }, (res) => { res.resume(); resolve(res.statusCode); }));
    ok('…and its playback link answers', [200, 302].includes(vid), vid);

    head('5 · THE SCORER RE-CLASSIFIES IT — the same clip follows the point');
    let r = await m1.ev({ eventId: 'corr1', type: 'CORRECT', target: ace.eventId, patch: { kind: 'WINNER', player: null }, reason: 'classified' });
    ok('the correction is saved', r.success, r);
    sc = await siteClip(ace.eventId);
    ok('on the website the clip is now a winner, still the server’s (it follows the point)', sc && sc.kind === 'WINNER' && sc.players.some((p) => p.playerId === PA.playerId), sc && { kind: sc.kind, players: sc.players });
    const upd = (await H('POST', '/clip-meta', { json: { clipId: ace.clipId, sport: 'tennis', point: { kind: 'WINNER', players: [{ playerId: PA.playerId, side: 'A', role: 'won', name: 'Carlos Alcaraz' }], voided: false } } })).json;
    j = await job(ace.clipId);
    ok('on this PC the same file is renamed for the winner — never cut again', upd.success && /S1-G01-P002_0-0_30-0_Alcaraz_Winner\.mp4$/.test(j.localPath) && fs.existsSync(j.localPath) && j.cutAttempts === 1, j && { path: j.localPath, cuts: j.cutAttempts });
    ok('…its link moved with it (the same bytes), the old name gone', j.links.length === 1 && fs.statSync(j.links[0].path).ino === fs.statSync(j.localPath).ino && !fs.existsSync(aceLink.path), j.links);
    const again = (await H('POST', '/clip', { json: ace.body })).json;
    j = await job(ace.clipId);
    ok('the old press re-sent (an outbox) does not undo the correction', again.duplicate === true && j.point.kind === 'WINNER', j && j.point.kind);
    ok('the upload was not repeated for the correction', ingests(ace.clipId) === 1, ingests(ace.clipId));

    head('6 · A DOUBLE FAULT — the receiver’s point, never the server’s highlight');
    await m1.ev({ type: 'FAULT' });
    const df = await pointOf(m1, 'B', { kind: 'DOUBLE_FAULT', serve: 2 });
    j = await waitJob(df.clipId, ['SYNC_COMPLETE', 'CUT_FAILED'], 45000);
    ok('a double fault: filed as one, under the receiver who won it — not in the server’s folder', j && /_Sinner_Double-Fault\.mp4$/.test(j.localPath) && j.links.length === 1 && j.links[0].playerId === PB.playerId, j && { path: j.localPath, links: j.links });

    head('7 · THE MATCH’S OWN WINDOW — handed over at Start, it wins');
    await session(m1, { preRollSec: 5, postRollSec: 2 });
    st = (await H('GET', '/status')).json;
    ok('the session says the match’s window (5 s + 2 s), the PC default stays 7 + 3', st.sessionClipTiming && st.sessionClipTiming.beforeSeconds === 5 && st.sessionClipTiming.afterSeconds === 2 && st.tennisClipTiming.beforeSeconds === 7, { s: st.sessionClipTiming, d: st.tennisClipTiming });
    const w = await pointOf(m1, 'A', null, { pre: 5, post: 2 });
    j = await waitJob(w.clipId, ['SYNC_COMPLETE', 'CUT_FAILED'], 45000);
    ok('7 s long — 5 s before the press, 2 s after (not 10)', j && near(j.clipSeconds, 7, 0.6) && j.window.preRollSec === 5 && j.window.postRollSec === 2 && near(timeAt(j.localPath, 'first'), (w.t0 - 5000 - W0) / 1000, 1.0), j && { s: j.clipSeconds, w: j.window });
    sc = await siteClip(w.eventId);
    ok('…and the website was told the window it was cut with', sc && sc.requested.preRollSec === 5 && sc.requested.postRollSec === 2, sc && sc.requested);
    await session(m1, { preRollSec: 7, postRollSec: 3 });

    head('8 · THREE QUICK POINTS — three jobs, three clips, each its own moment');
    const q = [];
    for (let i = 0; i < 3; i++) { q.push(await pointOf(m1, i % 2 ? 'B' : 'A')); await sleep(1500); }
    const dup = (await H('POST', '/clip', { json: q[0].body })).json;
    ok('the same point sent again is the same job (never a second clip)', dup.success && dup.duplicate === true, dup);
    const qj = [];
    for (const x of q) qj.push(await waitJob(x.clipId, ['SYNC_COMPLETE', 'CUT_FAILED'], 50000));
    ok('all three were cut and uploaded', qj.every((x) => x && x.syncStatus === 'SYNC_COMPLETE'), qj.map((x) => x && x.syncStatus));
    ok('three different files', new Set(qj.map((x) => x.localPath)).size === 3);
    ok('each starts 7 s before its own press (±1 s)', q.every((x, i) => near(timeAt(qj[i].localPath, 'first'), (x.t0 - 7000 - W0) / 1000, 1.0)), q.map((x, i) => [timeAt(qj[i].localPath, 'first'), (x.t0 - 7000 - W0) / 1000]));
    ok('…and the website has one clip per point, each under its own point', (await Promise.all(q.map((x) => siteClip(x.eventId)))).every((c, i) => c && c.eventId === q[i].eventId) && q.every((x) => ingests(x.clipId) === 1), q.map((x) => ingests(x.clipId)));

    head('9 · A CLIP PRESSED BY HAND — the phone remote’s "clip that"');
    const handId = `${MID}_clip-hand${Date.now().toString(36)}`;
    const ht0 = Date.now();
    // the remote asks the website; the device clipping on the vMix PC relays it to its Tennis Clipper (tennis-clipper.js → relayManual)
    const reg = await api('POST', `/api/tennis/matches/${MID}/clips`, { json: { clipId: handId, kind: 'CELEBRATION', playerId: PB.playerId, status: 'REQUESTED', localStatus: 'WAITING_FOR_POSTROLL', t0: ht0, preRollSec: 7, postRollSec: 3, engine: 'tennis-clipper' } });
    const hc = (await H('POST', '/clip', { json: { sport: 'tennis', matchId: MID, clipId: handId, timestamp: ht0, sessionId: 'clp-test', point: { eventId: null, kind: 'CELEBRATION', set: 1, game: 2, pointNo: null, side: 'B', sideName: 'Jannik Sinner', sides: { A: 'Carlos Alcaraz', B: 'Jannik Sinner' }, players: [{ playerId: PB.playerId, side: 'B', role: 'chosen', name: 'Jannik Sinner' }], playerId: PB.playerId, tnClipToken: m1.M.clipToken, at: ht0, preRollSec: 7, postRollSec: 3 }, matchLabel: 'Carlos Alcaraz v Jannik Sinner', tournamentId: T.tournamentId, tournamentName: 'Clipper Open' } })).json;
    ok('the website registers it and the Tennis Clipper takes it (no point needed)', reg.status === 200 && hc.success && !hc.duplicate, { reg: reg.json, hc });
    j = await waitJob(handId, ['SYNC_COMPLETE', 'CUT_FAILED'], 45000);
    ok('cut from its own moment (7 s before the press), 10 s', j && near(j.clipSeconds, 10, 0.6) && near(timeAt(j.localPath, 'first'), (ht0 - 7000 - W0) / 1000, 1.0), j && j.clipSeconds);
    ok('filed under the set’s Moments, by its kind and the player chosen — in that player’s folder', j && /[\\/]Set-1[\\/]Moments[\\/]S1-G02_Celebration_Jannik-Sinner_hand/.test(j.localPath) && j.links.length === 1 && j.links[0].playerId === PB.playerId, j && { path: j.localPath, links: j.links });
    const hsc = (await siteClips()).find((x) => x.clipId === handId);
    ok('on the website: a celebration of that player, uploaded, playable', hsc && hsc.kind === 'CELEBRATION' && hsc.players.some((p) => p.playerId === PB.playerId) && ['COMPLETE', 'SERVER_ONLY'].includes(hsc.status) && hsc.watchUrl, hsc && { kind: hsc.kind, status: hsc.status, players: hsc.players });
    const badHand = await H('POST', '/clip', { json: { sport: 'tennis', matchId: MID, clipId: `${MID}_whatever`, timestamp: Date.now(), point: { kind: 'MANUAL' } } });
    const otherMatch = await H('POST', '/clip', { json: { sport: 'tennis', matchId: MID, clipId: `OTHER_clip-abcd1234`, timestamp: Date.now(), point: { kind: 'MANUAL' } } });
    ok('a hand clip id that is not <match>_clip-<id> (or of another match) is refused', badHand.status === 400 && otherMatch.status === 400, [badHand.status, otherMatch.status]);

    head('10 · NO INTERNET — cut and filed anyway, uploaded once when it is back');
    netState.offline = true;
    const off = await pointOf(m1, 'A');
    j = await waitJob(off.clipId, ['OFFLINE_PENDING'], 50000);
    ok('the clip is cut and saved on this PC, waiting for the internet', j && j.syncStatus === 'OFFLINE_PENDING' && fs.existsSync(j.localPath), j && j.syncStatus);
    st = (await H('GET', '/status')).json;
    ok('it reports being offline (cutting goes on)', st.online === false, st.online);
    netState.offline = false;
    await H('POST', '/sync-now', { json: {} });
    j = await waitJob(off.clipId, ['SYNC_COMPLETE'], 40000);
    ok('back online: uploaded by itself', j && j.syncStatus === 'SYNC_COMPLETE', j && j.syncStatus);
    ok('…exactly once', ingests(off.clipId) === 1, ingests(off.clipId));

    head('11 · RESTARTED MID-QUEUE — nothing lost, nothing twice');
    const rp = await pointOf(m1, 'B');
    helper.kill('SIGTERM');
    await new Promise((res) => helper.once('exit', res));
    startHelper();
    ok('it comes back', await helperUp());
    j = await waitJob(rp.clipId, ['SYNC_COMPLETE', 'CUT_FAILED'], 50000);
    ok('the point pressed before the restart is cut afterwards, from its own moment', j && j.syncStatus === 'SYNC_COMPLETE' && near(timeAt(j.localPath, 'first'), (rp.t0 - 7000 - W0) / 1000, 1.0), j && j.syncStatus);
    await sleep(3000);
    ok('clips finished before the restart are not uploaded again', ingests(ace.clipId) === 1 && ingests(off.clipId) === 1 && ingests(handId) === 1, [ingests(ace.clipId), ingests(off.clipId), ingests(handId)]);

    head('12 · THE TENNIS CLIPPER NEVER CUTS ANOTHER SPORT');
    const before12 = (await H('GET', '/clip-jobs?limit=100')).json.jobs.length;
    const cr = await H('POST', '/clip', { json: { eventType: 'FOUR', timestamp: Date.now(), matchId: 'CRICKET1', ballMeta: { innings: 1, over: 3, ballInOver: 2, striker: 'Rohit Sharma' } } });
    const vb = await H('POST', '/clip', { json: { sport: 'volleyball', matchId: 'VB1', timestamp: Date.now(), point: { eventId: 'vbpoint1', set: 1, team: 'A' } } });
    ok('a cricket press and a volleyball press are refused, with the reason (their own Clippers cut those)', cr.status === 400 && vb.status === 400 && /Cricket Clipper/.test(cr.json.error) && /Volleyball Clipper/.test(vb.json.error), [cr.json, vb.json]);
    const crs = await H('POST', '/recording-start', { json: { startedAt: Date.now(), matchId: 'CRICKET1', sport: 'cricket' } });
    const vbs = await H('POST', '/recording-start', { json: { startedAt: Date.now(), matchId: 'VB1', sport: 'volleyball' } });
    const nos = await H('POST', '/recording-start', { json: { startedAt: Date.now(), matchId: 'X1' } });
    ok('…so is a cricket, a volleyball or an unnamed session', crs.status === 400 && vbs.status === 400 && nos.status === 400, [crs.status, vbs.status, nos.status]);
    ok('…no job was made; nothing went to another sport’s ingest; the tennis match is still the one set up', (await H('GET', '/clip-jobs?limit=100')).json.jobs.length === before12 && !netState.hits.some((h) => h.url.startsWith('/api/clips/ingest') || h.url.startsWith('/api/volleyball/')) && (await H('GET', '/status')).json.matchId === MID);

    head('13 · vMIX STOPPED RECORDING — said honestly');
    recorder.kill('SIGINT');
    await new Promise((res) => recorder.once('exit', res));
    recorder = null;
    await sleep(22000);   // the rule: no growth for 15 s (checked every 5 s)
    st = (await H('GET', '/status')).json;
    ok('it sees the recording is no longer being written', st.recordingGrowing === false, st.recordingGrowing);
    const late = await pointOf(m1, 'A');
    ok('a point now is accepted but flagged: no recording running', late.accept.success && late.accept.recordingActive === false, late.accept);
    j = await waitJob(late.clipId, ['CUT_FAILED'], 40000);
    ok('…and it says the footage does not exist — no clip is invented', j && j.syncStatus === 'CUT_FAILED' && /not recording|no footage|before the start/i.test(j.error || ''), j && j.error);
    const rt = (await H('POST', '/clip-retry', { json: { clipId: late.clipId } })).json;
    ok('Retry tries the same job again (no second job)', rt.success && (await H('GET', '/clip-jobs?matchId=' + MID + '&limit=100')).json.jobs.filter((x) => x.clipId === late.clipId).length === 1, rt);
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e.stack || e));
  } finally {
    if (recorder) try { recorder.kill('SIGKILL'); } catch (e) { /* gone */ }
    if (helper) try { helper.kill('SIGKILL'); } catch (e) { /* gone */ }
    proxy.close();
    if (fail) console.log('\n--- clipper log (last 5000 chars) ---\n' + hLog.slice(-5000));
    // what this test stored on the website's disk, and the fake recording
    for (const id of madeMatches) fs.rmSync(path.join(REPO, 'clips', 'tennis', id), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})();
