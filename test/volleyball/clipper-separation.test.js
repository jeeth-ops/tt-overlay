/* 🏏🏐 The CRICKET Clipper and the VOLLEYBALL Clipper are two separate
   programs that never touch each other — and each one's STOP really stops
   it. Both REAL programs run side by side from their own folders (as an
   operator installs them), reading the same growing vMix-like recording,
   uploading to the REAL website:

     clipper-helper/              → ClipperHelper.exe      :5005  asl-clipper://
     volleyball-clipper-helper/   → VolleyballClipper.exe  :5007  asl-vb-clipper://

   Windows is emulated exactly as the launcher files say it behaves: the
   registry maps each link to ITS folder's launcher script (whichever
   folder its install BAT last ran in), and the script starts that program
   or ends it by its own image name (taskkill /F /T /IM …). Proven here:

     A · nothing shared: different files, ports, links, settings, queues,
         clips folders; the Cricket Clipper is the last working version
         (no volleyball code); each launcher touches only its own program;
         the volleyball build refuses to run inside a cricket folder
     B · both running at once: a cricket press → its 18 s clip in Clips/,
         a volleyball point → its 10 s clip (7 s + 3 s) in VolleyballClips/,
         each to its own website ingest
     C · THE FAILURE THAT WAS SEEN, reproduced: the asl-clipper:// link
         pointing at a launcher script in another (volleyball) folder that
         is gone → Stop never reaches the Cricket Clipper, it keeps running;
         installing the VOLLEYBALL launcher cannot do that any more; running
         the cricket install BAT in the cricket folder again → Stop works
     D · cricket STOP / START × 3 — really stopped (process gone, port
         closed, no ffmpeg of it left), really started, one copy only — and
         the Volleyball Clipper untouched throughout (same process, still
         cutting)
     E · volleyball STOP / START × 3 (its own /quit, and its launcher's
         stop) — the Cricket Clipper untouched throughout; only the website
         it is set up for may stop it
     F · the REAL Cricket Panel's ▶ Start / ⏹ Stop buttons (cricket-panel.html
         in jsdom) driving the real Cricket Clipper × 3, the Volleyball
         Clipper untouched — one launch per click, never a duplicate

   Not covered here (no Windows in this environment): the registry itself,
   wscript.exe, taskkill.exe and the built .exe files — see the report.

     NODE_PATH=$(npm root -g) node test/volleyball/clipper-separation.test.js

   CRICKET_CLIPPER_BIN / VB_CLIPPER_BIN=<a binary from that folder's
   `npm run build`> run the same checks against the packaged programs.
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
if (spawnSync(FFMPEG, ['-version']).status !== 0) { console.log('clipper-separation: no ffmpeg — skipped'); process.exit(0); }

const { bootServer } = require('../server-boot.js');
const REPO = path.join(__dirname, '..', '..');
const CR = path.join(REPO, 'clipper-helper');
const VB = path.join(REPO, 'volleyball-clipper-helper');

function call(port, method, url, { json, headers } = {}) {
  return new Promise((resolve, reject) => {
    const body = json ? Buffer.from(JSON.stringify(json)) : null;
    const h = Object.assign({}, body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const portOpen = (port) => new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
function timeAt(file, which) {
  const args = which === 'first'
    ? ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=6:2:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']
    : ['-v', 'error', '-sseof', '-0.25', '-i', file, '-frames:v', '1', '-vf', 'scale=6:2:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'];
  const y = execFileSync(FFMPEG, args).subarray(0, 12);
  const col = (a) => (y[a] + y[a + 1] + y[a + 6] + y[a + 7]) / 4;
  const sec = Math.round((col(0) - 16) / 3), min = Math.round((col(2) - 16) / 3), frac = Math.max(0, Math.min(0.999, (col(4) - 16) / 200));
  return min * 60 + sec + frac;
}
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
const read = (f) => fs.readFileSync(f, 'utf8');
// ffmpeg processes whose command line mentions a folder (a program's own cuts)
const ffmpegIn = (dir) => { const r = spawnSync('pgrep', ['-f', `ffmpeg.*${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`]); return String(r.stdout || '').trim().split('\n').filter(Boolean).length; };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-sep-'));
  const recDir = path.join(tmp, 'vMix Recordings');
  fs.mkdirSync(recDir, { recursive: true });
  const U = { uid: 'u-work', email: 'workallsportslive@gmail.com', email_verified: true };
  const { port } = await bootServer({ idTokens: { tok: U }, users: { 'u-work': U.email } });
  const api = (m, u, o) => call(port, m, u, Object.assign({ headers: { Authorization: 'Bearer tok' } }, o || {}));
  // every upload either program makes goes through here (so it is seen)
  const hits = [];
  const proxyPort = await freePort();
  const proxy = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { try { res.destroy(); } catch (e) { /* gone */ } });
    req.pipe(up);
  }).listen(proxyPort, '127.0.0.1');
  const SITE = `http://127.0.0.1:${proxyPort}`;
  const uploads = (prefix, clipId) => hits.filter((h) => h.method === 'POST' && h.url.startsWith(prefix) && (!clipId || h.url.includes(`clipId=${encodeURIComponent(clipId)}`))).length;

  // the volleyball match the points belong to
  const mk = (n) => Array.from({ length: 9 }, (_, i) => ({ name: `${n} Player${i + 1}`, number: String(i + 1), libero: i === 8 }));
  const tA = (await api('POST', '/api/volleyball/teams', { json: { name: 'Pune Panthers', shortName: 'PUN', players: mk('Pune') } })).json.team;
  const tB = (await api('POST', '/api/volleyball/teams', { json: { name: 'Goa Waves', shortName: 'GOA', players: mk('Goa') } })).json.team;
  const T = (await api('POST', '/api/volleyball/tournaments', { json: { name: 'Separation Cup', teamIds: [tA.teamId, tB.teamId] } })).json.tournament;
  const M = (await api('POST', `/api/volleyball/tournaments/${T.tournamentId}/matches`, { json: { teamA: tA.teamId, teamB: tB.teamId } })).json.match;
  const MID = M.matchId;
  const clipToken = (await api('GET', `/api/volleyball/matches/${MID}`)).json.match.clipToken;
  const lease = (await api('POST', `/api/volleyball/matches/${MID}/lease`, { json: { deviceId: 'pc' } })).json.leaseToken;
  let evn = 0;
  const ev = (e) => api('POST', `/api/volleyball/matches/${MID}/events`, { json: { event: Object.assign({ eventId: `sep${++evn}`, at: Date.now() }, e) }, headers: { Authorization: 'Bearer tok', 'x-vb-lease': lease } }).then((r) => r.json);
  await ev({ type: 'TOSS', winner: 'A', choice: 'serve', leftSide: 'A' });
  await ev({ type: 'LINEUP', team: 'A', positions: tA.players.slice(0, 6).map((p) => p.playerId) });
  await ev({ type: 'LINEUP', team: 'B', positions: tB.players.slice(0, 6).map((p) => p.playerId) });
  await ev({ type: 'SET_START' });
  const CRICKET_MATCH = 'SEPCRK1';

  // ---- the two programs, each in its OWN folder (how they are installed) ----
  const cDir = path.join(tmp, 'Cricket Clipper');
  const vDir = path.join(tmp, 'Volleyball Clipper');
  fs.mkdirSync(cDir); fs.mkdirSync(vDir);
  for (const f of fs.readdirSync(CR)) fs.copyFileSync(path.join(CR, f), path.join(cDir, f));
  for (const f of fs.readdirSync(VB)) fs.copyFileSync(path.join(VB, f), path.join(vDir, f));
  const cPort = await freePort(), vPort = await freePort();
  fs.writeFileSync(path.join(cDir, 'config.json'), JSON.stringify({ port: cPort, vmixRecordingFile: recDir, clipsFolder: '', mainServerUrl: SITE, preRollSeconds: 15, postRollSeconds: 3 }));
  fs.writeFileSync(path.join(vDir, 'volleyball-clipper-config.json'), JSON.stringify({ port: vPort, vmixRecordingFile: recDir, clipsFolder: '', mainServerUrl: '' }));

  // 🪟 Windows, emulated from the launcher files. One running copy per image
  // name at most (the launchers' IsRunning check); taskkill /F /T /IM ends
  // that image and the ffmpeg it started — nothing else.
  const IMAGES = {
    'ClipperHelper.exe': { dir: cDir, entry: 'server.js', port: cPort },
    'VolleyballClipper.exe': { dir: vDir, entry: 'volleyball-clipper-server.js', port: vPort },
  };
  const BIN = { 'ClipperHelper.exe': process.env.CRICKET_CLIPPER_BIN, 'VolleyballClipper.exe': process.env.VB_CLIPPER_BIN };
  for (const [image, im] of Object.entries(IMAGES)) if (BIN[image]) { fs.copyFileSync(BIN[image], path.join(im.dir, image)); fs.chmodSync(path.join(im.dir, image), 0o755); }
  const procs = {};
  const spawns = { 'ClipperHelper.exe': 0, 'VolleyballClipper.exe': 0 };
  const logs = { 'ClipperHelper.exe': '', 'VolleyballClipper.exe': '' };
  const running = (image) => !!procs[image] && procs[image].exitCode === null && procs[image].signalCode === null;
  function startImage(image) {
    if (running(image)) return false;
    const im = IMAGES[image];
    const p = spawn(BIN[image] ? path.join(im.dir, image) : process.execPath, BIN[image] ? [] : [path.join(im.dir, im.entry)], { cwd: im.dir, detached: true, env: Object.assign({}, process.env, { NODE_PATH: path.join(REPO, 'node_modules'), CLIPPER_NO_BROWSER: '1', FFMPEG_PATH: FFMPEG }), stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => { logs[image] += d; }); p.stderr.on('data', (d) => { logs[image] += d; });
    p.exited = new Promise((r) => p.once('exit', r));
    procs[image] = p;
    spawns[image]++;
    return true;
  }
  function taskkill(image) {
    const p = procs[image];
    if (!running(image)) return;
    try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { try { p.kill('SIGKILL'); } catch (e2) { /* gone */ } }
  }
  // HKCU\Software\Classes\<scheme>\shell\open\command → that folder's launcher script
  const REGISTRY = {};
  const launched = [], launchErrors = [];
  // what install-clipper-launcher.bat / install-volleyball-clipper-launcher.bat write
  function runInstallBat(dir, bat) {
    const src = read(path.join(dir, bat));
    // the BAT's own guards, in order, as written
    if (/if exist "%~dp0ClipperHelper\.exe" goto cricketfolder/.test(src) && fs.existsSync(path.join(dir, 'ClipperHelper.exe'))) return { refused: 'cricket folder' };
    if (/if exist "%~dp0clipper-launch\.vbs" goto cricketfolder/.test(src) && fs.existsSync(path.join(dir, 'clipper-launch.vbs'))) return { refused: 'cricket folder' };
    const m = /HKCU\\Software\\Classes\\([a-z-]+)\\shell\\open\\command" \/ve \/d "\\"%SystemRoot%\\System32\\wscript\.exe\\" \\"%~dp0([A-Za-z.-]+\.vbs)\\"/.exec(src);
    REGISTRY[m[1]] = path.join(dir, m[2]);
    return { scheme: m[1], vbs: REGISTRY[m[1]] };
  }
  // Windows hands the link to the registered script: what that script does
  async function openLink(href) {
    launched.push(href);
    const scheme = href.split(':')[0];
    const vbs = REGISTRY[scheme];
    if (!vbs || !fs.existsSync(vbs)) { launchErrors.push(`Can not find script file "${vbs}"`); return; }
    const src = read(vbs);
    const image = /\\(ClipperHelper|VolleyballClipper)\.exe"/.exec(src)[1] + '.exe';
    if (/stop/i.test(href)) {
      // the volleyball launcher first asks the program to close itself
      if (/\/quit"/.test(src)) {
        try { await call(IMAGES[image].port, 'POST', '/quit', { json: {} }); } catch (e) { /* not answering */ }
        for (let i = 0; i < 10 && running(image); i++) await sleep(300);
      }
      if (new RegExp(`taskkill /F /T /IM ${image.replace('.', '\\.')}`).test(src)) taskkill(image);
    } else startImage(image);
  }
  const statusOf = async (image) => { try { const r = await call(IMAGES[image].port, 'GET', '/status'); return r.status === 200 ? r.json : null; } catch (e) { return null; } };
  const upOf = async (image, ms) => { const end = Date.now() + (ms || 15000); while (Date.now() < end) { const s = await statusOf(image); if (s) return s; await sleep(150); } return null; };
  const downOf = async (image, ms) => { const end = Date.now() + (ms || 15000); while (Date.now() < end) { if (!running(image) && !(await portOpen(IMAGES[image].port))) return true; await sleep(150); } return false; };
  const job = async (image, clipId) => { try { return ((await call(IMAGES[image].port, 'GET', `/clip-jobs/${clipId}`)).json || {}).job || null; } catch (e) { return null; } };
  const waitJob = async (image, clipId, states, ms) => { const end = Date.now() + (ms || 45000); let j = null; while (Date.now() < end) { j = await job(image, clipId); if (j && states.includes(j.syncStatus)) return j; await sleep(400); } return j; };
  const DONE = ['LOCAL_SAVED', 'SENDING', 'SENT', 'SYNC_RETRY', 'OFFLINE_PENDING', 'WEBSITE_UPDATE', 'WEBSITE_RETRY', 'SYNC_COMPLETE', 'CUT_FAILED'];
  // a finished clip, as it was when it was first saved: a re-cut would change its file or its save time
  const finished = { 'ClipperHelper.exe': new Map(), 'VolleyballClipper.exe': new Map() };
  const remember = (image, j) => { if (j && j.localPath) finished[image].set(j.clipId, { localPath: j.localPath, updatedAt: j.updatedAt, savedSeconds: j.clipSeconds }); };
  async function neverRecut(image) {
    const bad = [];
    for (const [id, was] of finished[image]) {
      const j = await job(image, id);
      if (!j || !j.localPath || !fs.existsSync(j.localPath) || ['WAITING', 'CUTTING', 'CUT_RETRY'].includes(j.syncStatus) || j.clipSeconds !== was.savedSeconds) bad.push({ id, st: j && j.syncStatus, p: j && j.localPath });
    }
    return bad;
  }

  let crN = 0, vbN = 0, sa = 0, sb = 0;
  const cricketPress = async () => {
    const t0 = Date.now();
    const r = (await call(cPort, 'POST', '/clip', { json: { eventType: 'FOUR', timestamp: t0, matchId: CRICKET_MATCH, ballMeta: { innings: 1, over: 3, ballInOver: ++crN, striker: 'Rohit Sharma', bowler: 'Jasprit Bumrah' } } })).json;
    return { t0, clipId: r && r.clipId, accept: r };
  };
  const volleyballPoint = async () => {
    const eventId = `sp${++vbN}u${Date.now() % 100000}`;
    const t0 = Date.now();
    await ev({ eventId, type: 'RALLY', winner: 'A', outcome: 'GENERAL', at: t0 });
    sa++;
    const body = { sport: 'volleyball', matchId: MID, clipId: `${MID}_${eventId}`, timestamp: t0, sessionId: 'clp-sep',
      point: { eventId, set: 1, pointNo: sa + sb, team: 'A', teamId: tA.teamId, teamName: 'Pune Panthers', teamShort: 'PUN', teamNames: { A: 'Pune Panthers', B: 'Goa Waves' }, score: { A: sa, B: sb }, outcome: 'GENERAL', attribution: null, players: [], vbClipToken: clipToken, at: t0 },
      matchLabel: 'Pune Panthers v Goa Waves', tournamentId: T.tournamentId, tournamentName: 'Separation Cup' };
    const r = (await call(vPort, 'POST', '/clip', { json: body })).json;
    return { t0, clipId: body.clipId, accept: r };
  };

  let recorder = null;
  try {
    head('A · TWO PROGRAMS, NOTHING SHARED');
    const crFiles = fs.readdirSync(CR), vbFiles = fs.readdirSync(VB);
    const shared = crFiles.filter((f) => vbFiles.includes(f));
    ok('no file of the Volleyball Clipper has a Cricket Clipper file’s name except package.json (its build refuses a cricket folder)', shared.join() === 'package.json', shared);
    const crSrv = read(path.join(CR, 'server.js')), vbSrv = read(path.join(VB, 'volleyball-clipper-server.js'));
    ok('the Cricket Clipper is the last working version: v5.2, no volleyball code at all', /HELPER_VERSION = '5\.2'/.test(crSrv) && !/volleyball/i.test(crSrv) && !fs.existsSync(path.join(CR, 'volleyballOrganizer.js')));
    const gitSame = spawnSync('git', ['diff', '--quiet', 'fdfa426', '--', 'clipper-helper/server.js', 'clipper-helper/package.json', 'clipper-helper/fmp4.js', 'clipper-helper/clipOrganizer.js', 'clipper-helper/clipper-launch.vbs', 'clipper-helper/install-clipper-launcher.bat', 'clipper-helper/uninstall-clipper-launcher.bat', 'clipper-helper/CLIPPER-LAUNCHER-README.txt', 'clipper-launcher.zip', 'cricket-panel.html'], { cwd: REPO });
    ok('…byte for byte the files from before the volleyball work (git), and the Cricket Panel / its launcher zip unchanged', gitSame.status === 0 || gitSame.error, gitSame.status);
    const localRequires = (src) => [...src.matchAll(/require\('(\.[^']+)'\)/g)].map((m) => m[1]).sort();
    ok('the Volleyball Clipper loads only its own files (no cricket module)', localRequires(vbSrv).join() === './vb-fmp4,./vb-organizer' && !localRequires(read(path.join(VB, 'vb-organizer.js'))).length && !localRequires(read(path.join(VB, 'vb-fmp4.js'))).length, localRequires(vbSrv));
    ok('its own port, settings, queue, clips folder and log — none of cricket’s', /port: 5007/.test(vbSrv) && /'volleyball-clipper-config\.json'/.test(vbSrv) && /'volleyball-clip-jobs\.json'/.test(vbSrv) && /'VolleyballClips'/.test(vbSrv) && /volleyball-clipper-log\.txt/.test(read(path.join(VB, 'volleyball-clipper-launch.vbs')))
      && /port: 5005/.test(crSrv) && /'config\.json'/.test(crSrv) && /'clip-jobs\.json'/.test(crSrv));
    const crBat = read(path.join(CR, 'install-clipper-launcher.bat')), vbBat = read(path.join(VB, 'install-volleyball-clipper-launcher.bat'));
    const crVbs = read(path.join(CR, 'clipper-launch.vbs')), vbVbs = read(path.join(VB, 'volleyball-clipper-launch.vbs'));
    const regKeys = (bat) => [...new Set([...bat.matchAll(/HKCU\\Software\\Classes\\([a-z-]+)/g)].map((m) => m[1]))];
    ok('the cricket install BAT registers only asl-clipper://; the volleyball one only asl-vb-clipper://', regKeys(crBat).join() === 'asl-clipper' && regKeys(vbBat).join() === 'asl-vb-clipper' && regKeys(read(path.join(VB, 'uninstall-volleyball-clipper-launcher.bat'))).join() === 'asl-vb-clipper', [regKeys(crBat), regKeys(vbBat)]);
    ok('…and the volleyball BAT refuses a cricket folder before it writes anything', vbBat.indexOf('goto cricketfolder') > -1 && vbBat.indexOf('goto cricketfolder') < vbBat.indexOf('reg add'));
    const kills = (src) => [...src.matchAll(/taskkill[^"\n]*\/IM ([A-Za-z]+\.exe)/g)].map((m) => m[1]);
    ok('each Stop ends only its own program (taskkill by its own image name)', kills(crVbs).join() === 'ClipperHelper.exe' && kills(vbVbs).join() === 'VolleyballClipper.exe' && kills(read(path.join(VB, 'uninstall-volleyball-clipper-launcher.bat'))).join() === 'VolleyballClipper.exe' && !/ClipperHelper\.exe'/.test(vbVbs), [kills(crVbs), kills(vbVbs)]);
    ok('the scripts are Windows text (CRLF, ASCII) like the cricket ones', ['volleyball-clipper-launch.vbs', 'install-volleyball-clipper-launcher.bat', 'uninstall-volleyball-clipper-launcher.bat'].every((f) => { const b = fs.readFileSync(path.join(VB, f)); return b.every((c) => c < 128) && !/[^\r]\n/.test(b.toString('latin1')); }));
    const zipList = String(spawnSync('unzip', ['-Z1', path.join(REPO, 'volleyball-clipper-launcher.zip')]).stdout || '').trim().split('\n').sort();
    ok('the website’s Volleyball Clipper Launcher download holds exactly its launcher files', zipList.join() === ['VOLLEYBALL-CLIPPER-README.txt', 'install-volleyball-clipper-launcher.bat', 'uninstall-volleyball-clipper-launcher.bat', 'volleyball-clipper-launch.vbs'].sort().join(), zipList);
    const zipSame = zipList.every((f) => { const r = spawnSync('unzip', ['-p', path.join(REPO, 'volleyball-clipper-launcher.zip'), f]); return Buffer.compare(r.stdout, fs.readFileSync(path.join(VB, f))) === 0; });
    ok('…byte for byte', zipSame);
    const client = read(path.join(REPO, 'volleyball-clipper.js'));
    ok('the volleyball pages talk to localhost:5007 and asl-vb-clipper:// only — never cricket’s', /'http:\/\/localhost:5007'/.test(client) && /'asl-vb-clipper:\/\/'/.test(client) && !/'http:\/\/localhost:5005'|'asl-clipper:\/\/'|href="\/clipper-launcher\.zip"/.test(client));
    ok('…and the Cricket Panel never mentions the Volleyball Clipper', !/VolleyballClipper|asl-vb-clipper|localhost:5007/.test(read(path.join(REPO, 'cricket-panel.html'))));
    const g1 = path.join(tmp, 'guard-cricket'); fs.mkdirSync(g1); fs.writeFileSync(path.join(g1, 'ClipperHelper.exe'), ''); fs.writeFileSync(path.join(g1, 'server.js'), '');
    const g2 = path.join(tmp, 'guard-own'); fs.mkdirSync(g2);
    const guard = (cwd) => spawnSync(process.execPath, [path.join(VB, 'vb-build-guard.js')], { cwd, encoding: 'utf8' });
    const gr1 = guard(g1), gr2 = guard(g2);
    ok('the volleyball `npm run build` refuses to run in a cricket folder (nothing built), and runs in its own', /"build": "node vb-build-guard\.js && pkg volleyball-clipper-server\.js .*--output VolleyballClipper\.exe"/.test(read(path.join(VB, 'package.json'))) && gr1.status === 1 && /CRICKET Clipper/.test(gr1.stderr) && gr2.status === 0, { a: gr1.status, b: gr2.status });
    ok('…and the cricket build still makes ClipperHelper.exe from server.js', /"build": "pkg server\.js --targets node18-win-x64 --output ClipperHelper\.exe"/.test(read(path.join(CR, 'package.json'))));

    head('B · BOTH RUNNING AT ONCE — each cuts its own sport, from the same recording');
    const inst1 = runInstallBat(cDir, 'install-clipper-launcher.bat'), inst2 = runInstallBat(vDir, 'install-volleyball-clipper-launcher.bat');
    ok('both launchers installed, each pointing at its own folder', inst1.scheme === 'asl-clipper' && inst1.vbs === path.join(cDir, 'clipper-launch.vbs') && inst2.scheme === 'asl-vb-clipper' && inst2.vbs === path.join(vDir, 'volleyball-clipper-launch.vbs'), [inst1, inst2]);
    const recFile = path.join(recDir, 'capture.mp4');
    const W0 = Date.now();
    recorder = spawn(FFMPEG, ['-v', 'error', '-re', '-f', 'lavfi', '-i', "color=black:s=384x192:r=25,format=yuv420p,geq=lum='if(lt(X,128),16+3*mod(floor(T),60),if(lt(X,256),16+3*floor(T/60),16+200*(T-floor(T))))':cb=128:cr=128",
      '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-keyint_min', '25', '-c:a', 'aac',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1', '-f', 'mp4', recFile], { stdio: ['ignore', 'ignore', 'ignore'] });
    await openLink('asl-clipper://start');
    await openLink('asl-vb-clipper://start');
    const cs0 = await upOf('ClipperHelper.exe'), vs0 = await upOf('VolleyballClipper.exe');
    ok('the Cricket Clipper answers on its port as itself (the v5.2 status: no volleyball, no app tag)', cs0 && cs0.running && cs0.version === 5 && cs0.app === undefined && cs0.volleyball === undefined, cs0 && { v: cs0.version, app: cs0.app });
    ok('the Volleyball Clipper answers on ITS port as itself', vs0 && vs0.app === 'volleyball-clipper' && vs0.volleyballClipTiming.durationSeconds === 10, vs0 && vs0.app);
    await call(cPort, 'POST', '/recording-start', { json: { startedAt: Date.now(), matchId: CRICKET_MATCH, mainServerUrl: SITE } });
    await call(vPort, 'POST', '/recording-start', { json: { startedAt: Date.now(), matchId: MID, mainServerUrl: SITE, sport: 'volleyball', matchLabel: 'Pune Panthers v Goa Waves', tournamentId: T.tournamentId, tournamentName: 'Separation Cup' } });
    await sleep(Math.max(0, W0 + 17500 - Date.now()));   // a full 15 s lead-in exists for cricket
    const c1 = await cricketPress(), v1 = await volleyballPoint();
    const cj1 = await waitJob('ClipperHelper.exe', c1.clipId, DONE, 50000), vj1 = await waitJob('VolleyballClipper.exe', v1.clipId, DONE, 50000);
    remember('ClipperHelper.exe', cj1); remember('VolleyballClipper.exe', vj1);
    ok('a cricket press: cricket’s 18 s (15 s before + 3 s after) into the cricket Highlights folder', cj1 && near(cj1.clipSeconds, 18, 0.6) && /[\\/]Clips[\\/].*[\\/]Highlights[\\/]4[\\/]/.test(cj1.localPath) && near(timeAt(cj1.localPath, 'first'), (c1.t0 - 15000 - W0) / 1000, 1.0), cj1 && { s: cj1.clipSeconds, p: cj1.localPath, st: cj1.syncStatus, e: cj1.error });
    ok('a volleyball point: 10 s (7 s before + 3 s after) into VolleyballClips', vj1 && near(vj1.clipSeconds, 10, 0.6) && /[\\/]VolleyballClips[\\/].*[\\/]Set-1[\\/]/.test(vj1.localPath) && near(timeAt(vj1.localPath, 'first'), (v1.t0 - 7000 - W0) / 1000, 1.0) && near(timeAt(vj1.localPath, 'last'), (v1.t0 + 3000 - W0) / 1000, 1.0), vj1 && { s: vj1.clipSeconds, p: vj1.localPath, st: vj1.syncStatus, e: vj1.error });
    await sleep(3000);
    ok('each upload went to its own sport’s website ingest', uploads('/api/clips/ingest', c1.clipId) >= 1 && uploads('/api/volleyball/clips/ingest', c1.clipId) === 0 && uploads('/api/volleyball/clips/ingest', v1.clipId) >= 1 && uploads('/api/clips/ingest', v1.clipId) === 0,
      [uploads('/api/clips/ingest', c1.clipId), uploads('/api/volleyball/clips/ingest', v1.clipId)]);
    ok('neither program holds the other’s job, settings or queue file', !(await job('VolleyballClipper.exe', c1.clipId)) && !(await job('ClipperHelper.exe', v1.clipId))
      && fs.existsSync(path.join(cDir, 'clip-jobs.json')) && !fs.existsSync(path.join(cDir, 'volleyball-clip-jobs.json')) && fs.existsSync(path.join(vDir, 'volleyball-clip-jobs.json')) && !fs.existsSync(path.join(vDir, 'clip-jobs.json')) && !fs.existsSync(path.join(vDir, 'config.json')));

    head('C · THE FAILURE THAT WAS SEEN — reproduced, and why it cannot happen again');
    // what happened on the laptop: the (old, shared) launcher BAT run from a
    // volleyball download folder pointed asl-clipper:// there; that folder's
    // script is gone → "Can not find script file …\clipper-launch.vbs"
    const gone = path.join(tmp, 'Downloads', 'Volleyball files', 'Clipper helper to cut clips volleyball', 'clipper-launch.vbs');
    REGISTRY['asl-clipper'] = gone;
    const pidBefore = procs['ClipperHelper.exe'].pid;
    await openLink('asl-clipper://stop');
    await sleep(2000);
    ok('Stop with the link pointing at a missing script: Windows cannot run it, and the Cricket Clipper keeps running (what was seen)', launchErrors.length === 1 && /Can not find script file/.test(launchErrors[0]) && running('ClipperHelper.exe') && procs['ClipperHelper.exe'].pid === pidBefore && !!(await statusOf('ClipperHelper.exe')), launchErrors);
    const instV = runInstallBat(vDir, 'install-volleyball-clipper-launcher.bat');
    ok('installing the VOLLEYBALL launcher now never touches the cricket link', instV.scheme === 'asl-vb-clipper' && REGISTRY['asl-clipper'] === gone);
    const instIntoCricket = (() => { const mixed = path.join(tmp, 'mixed'); fs.mkdirSync(mixed); for (const f of fs.readdirSync(CR)) fs.copyFileSync(path.join(CR, f), path.join(mixed, f)); fs.writeFileSync(path.join(mixed, 'ClipperHelper.exe'), ''); for (const f of fs.readdirSync(VB)) if (!fs.existsSync(path.join(mixed, f))) fs.copyFileSync(path.join(VB, f), path.join(mixed, f)); return runInstallBat(mixed, 'install-volleyball-clipper-launcher.bat'); })();
    ok('…and even run inside a cricket folder (files mixed up), it refuses and changes nothing', instIntoCricket.refused === 'cricket folder' && REGISTRY['asl-vb-clipper'] === path.join(vDir, 'volleyball-clipper-launch.vbs'), instIntoCricket);
    const fix = runInstallBat(cDir, 'install-clipper-launcher.bat');
    ok('the fix on the laptop: run install-clipper-launcher.bat in the CRICKET folder again → the link points home', fix.scheme === 'asl-clipper' && REGISTRY['asl-clipper'] === path.join(cDir, 'clipper-launch.vbs'));
    await openLink('asl-clipper://stop');
    ok('…and Stop stops the Cricket Clipper again', await downOf('ClipperHelper.exe'), { running: running('ClipperHelper.exe') });

    head('D · CRICKET STOP / START × 3 — the Volleyball Clipper untouched');
    const vPid = procs['VolleyballClipper.exe'].pid;
    for (let i = 1; i <= 3; i++) {
      const n0 = spawns['ClipperHelper.exe'];
      await openLink('asl-clipper://start');
      await openLink('asl-clipper://start');   // pressed twice: the launcher's "already running" check
      const s = await upOf('ClipperHelper.exe');
      ok(`cycle ${i}: started — one copy only, answering`, !!s && spawns['ClipperHelper.exe'] - n0 === 1, { s: !!s, spawned: spawns['ClipperHelper.exe'] - n0 });
      const cp = await cricketPress();
      const cj = await waitJob('ClipperHelper.exe', cp.clipId, DONE, 50000);
      const recut = await neverRecut('ClipperHelper.exe');
      ok(`cycle ${i}: a cricket press is cut (18 s); every earlier clip still the one file it was — never cut again`, cj && near(cj.clipSeconds, 18, 0.6) && !recut.length, { s: cj && cj.clipSeconds, st: cj && cj.syncStatus, e: cj && cj.error, recut });
      remember('ClipperHelper.exe', cj);
      await openLink('asl-clipper://stop');
      ok(`cycle ${i}: STOP really stops it — process gone, port closed, no ffmpeg of it left`, await downOf('ClipperHelper.exe') && ffmpegIn(cDir) === 0 && ffmpegIn(path.join(recDir, 'Clips')) === 0);
      const vs = await statusOf('VolleyballClipper.exe');
      ok(`cycle ${i}: the Volleyball Clipper is untouched (same process, answering)`, vs && vs.pid === vPid && running('VolleyballClipper.exe'), vs && vs.pid);
    }
    const vMid = await volleyballPoint();
    const vjMid = await waitJob('VolleyballClipper.exe', vMid.clipId, DONE, 50000);
    remember('VolleyballClipper.exe', vjMid);
    ok('with the Cricket Clipper stopped, a volleyball point is still cut (10 s)', vjMid && near(vjMid.clipSeconds, 10, 0.6), vjMid && { s: vjMid.clipSeconds, e: vjMid.error });

    head('E · VOLLEYBALL STOP / START × 3 — the Cricket Clipper untouched');
    await openLink('asl-clipper://start');
    const cs1 = await upOf('ClipperHelper.exe');
    const cPid = procs['ClipperHelper.exe'].pid;
    ok('the Cricket Clipper running again', !!cs1);
    const foreign = await call(vPort, 'POST', '/quit', { json: {}, headers: { Origin: 'https://not-the-site.example' } });
    ok('another website cannot stop the Volleyball Clipper', foreign.status === 403 && running('VolleyballClipper.exe'), foreign.status);
    for (let i = 1; i <= 3; i++) {
      // the panel's "Quit the Volleyball Clipper" (from the website it is set up for), or its launcher's stop
      if (i === 2) await openLink('asl-vb-clipper://stop');
      else { const q = await call(vPort, 'POST', '/quit', { json: {}, headers: { Origin: SITE } }); ok(`cycle ${i}: the panel's quit is accepted`, q.status === 200 && q.json.stopping === true, q.status); }
      ok(`cycle ${i}: STOP really stops it — process gone, port closed, no ffmpeg of it left`, await downOf('VolleyballClipper.exe') && ffmpegIn(vDir) === 0 && ffmpegIn(path.join(recDir, 'VolleyballClips')) === 0);
      const cs = await statusOf('ClipperHelper.exe');
      ok(`cycle ${i}: the Cricket Clipper is untouched (same process, answering)`, cs && running('ClipperHelper.exe') && procs['ClipperHelper.exe'].pid === cPid);
      const cp = await cricketPress();
      const cj = await waitJob('ClipperHelper.exe', cp.clipId, DONE, 50000);
      ok(`cycle ${i}: …and still cuts cricket (18 s)`, cj && near(cj.clipSeconds, 18, 0.6), cj && { s: cj.clipSeconds, e: cj.error });
      await openLink('asl-vb-clipper://start');
      const vs = await upOf('VolleyballClipper.exe');
      const vrecut = await neverRecut('VolleyballClipper.exe');
      ok(`cycle ${i}: started again — answering, its queue intact (every earlier clip the same file, never cut again)`, vs && vs.app === 'volleyball-clipper' && !vrecut.length, vrecut);
      const vp = await volleyballPoint();
      const vj = await waitJob('VolleyballClipper.exe', vp.clipId, DONE, 50000);
      ok(`cycle ${i}: a volleyball point is cut (10 s)`, vj && near(vj.clipSeconds, 10, 0.6), vj && { s: vj.clipSeconds, e: vj.error });
      remember('VolleyballClipper.exe', vj);
    }
    ok('the Volleyball Clipper’s own log shows each stop cleaning up its timers, its ffmpeg and its port', (logs['VolleyballClipper.exe'].match(/Volleyball Clipper stopped/g) || []).length >= 2);

    head('F · THE REAL CRICKET PANEL’S ▶ Start / ⏹ Stop — × 3, the Volleyball Clipper untouched');
    let JSDOM = null, VirtualConsole = null;
    try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (e) { /* not installed */ }
    if (!JSDOM) ok('jsdom is installed (npm install --no-save jsdom) for the panel section', false);
    else {
      let html = read(path.join(REPO, 'cricket-panel.html')).replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
      const vc = new VirtualConsole(); const perr = [];
      vc.on('jsdomError', (e) => perr.push(e.message));
      const clicks = { start: 0, stop: 0 };
      const dom = new JSDOM(html, {
        runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://allsportslive.example/cricket-panel?room=SEPCR', virtualConsole: vc,
        beforeParse(w) {
          w.io = () => ({ on() {}, emit() {}, connected: false, disconnect() {}, io: { on() {} } });
          // the panel's own fetches: its Clipper (localhost:5005) is the REAL Cricket Clipper here
          w.fetch = (url, o2) => {
            url = String(url);
            if (/^http:\/\/localhost:5005\//.test(url)) return fetch(url.replace('http://localhost:5005', `http://127.0.0.1:${cPort}`), { method: (o2 && o2.method) || 'GET', headers: o2 && o2.headers, body: o2 && o2.body, signal: AbortSignal.timeout(4000) });
            return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
          };
          w.alert = () => {}; w.confirm = () => true;
          w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
          Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
          w.HTMLMediaElement.prototype.play = () => Promise.resolve(); w.HTMLMediaElement.prototype.pause = () => {};
          w.HTMLCanvasElement.prototype.getContext = () => null;
          w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
          w.scrollTo = () => {};
          const click = w.HTMLAnchorElement.prototype.click;
          // the asl-clipper:// link → Windows → the registered launcher script
          w.HTMLAnchorElement.prototype.click = function () { if (/^asl-/.test(this.href)) { if (/start/.test(this.href)) clicks.start++; else clicks.stop++; openLink(this.href); } else return click.call(this); };
          w.open = (url, name) => ({ url, name, closed: false, location: { href: url || 'about:blank' }, document: { write() {} }, close() { this.closed = true; } });
        }
      });
      const w = dom.window;
      const $ = (s) => w.document.querySelector(s);
      const txt = (s) => ($(s) ? $(s).textContent : '');
      const press = (s) => $(s).dispatchEvent(new w.Event('click', { bubbles: true }));
      const until = async (fn, ms) => { const end = Date.now() + (ms || 20000); while (Date.now() < end) { if (fn()) return true; await sleep(200); } return false; };
      ok('the panel sees the running Cricket Clipper', await until(() => /Clipper running/.test(txt('#clipper-start-btn')), 15000), txt('#clipper-start-btn'));
      for (let i = 1; i <= 3; i++) {
        const before = { ...clicks };
        press('#clipper-stop-btn');
        const stopped = await until(() => /Clipper stopped/.test(txt('#clipper-launch-msg')), 25000);
        ok(`panel cycle ${i}: ⏹ Stop — the Cricket Clipper really stops, the panel says so`, stopped && await downOf('ClipperHelper.exe', 5000) && !$('#clipper-start-btn').disabled && $('#clipper-stop-btn').disabled, { msg: txt('#clipper-launch-msg'), running: running('ClipperHelper.exe') });
        ok(`panel cycle ${i}: …through exactly one asl-clipper://stop`, clicks.stop - before.stop === 1 && clicks.start === before.start, clicks);
        const vs = await statusOf('VolleyballClipper.exe');
        ok(`panel cycle ${i}: …the Volleyball Clipper untouched`, vs && running('VolleyballClipper.exe'), vs && vs.pid);
        press('#clipper-start-btn');
        const started = await until(() => /Clipper is running/.test(txt('#clipper-launch-msg')) && /Clipper running/.test(txt('#clipper-start-btn')), 45000);
        ok(`panel cycle ${i}: ▶ Start — it starts again and the panel shows it running`, started && running('ClipperHelper.exe') && !!(await statusOf('ClipperHelper.exe')), { msg: txt('#clipper-launch-msg'), btn: txt('#clipper-start-btn') });
        ok(`panel cycle ${i}: …through exactly one asl-clipper://start`, clicks.start - before.start === 1, clicks);
      }
      const cp = await cricketPress();
      const cj = await waitJob('ClipperHelper.exe', cp.clipId, DONE, 50000);
      ok('after three panel cycles the Cricket Clipper still cuts its 18 s clips', cj && near(cj.clipSeconds, 18, 0.6), cj && { s: cj.clipSeconds, e: cj.error });
      ok('no panel script error', perr.length === 0, perr.slice(0, 3));
      w.close();
    }
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e.stack || e));
  } finally {
    if (recorder) try { recorder.kill('SIGKILL'); } catch (e) { /* gone */ }
    for (const im of Object.keys(procs)) taskkill(im);
    proxy.close();
    if (fail) for (const im of Object.keys(logs)) console.log(`\n--- ${im} log (last 12000 chars) ---\n` + logs[im].slice(-12000));
    fs.rmSync(path.join(REPO, 'clips', 'volleyball', MID), { recursive: true, force: true });
    fs.rmSync(path.join(REPO, 'clips', CRICKET_MATCH), { recursive: true, force: true });
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})();
