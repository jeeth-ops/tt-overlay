/* 🎬 The volleyball panel's Clipper, as an operator uses it, in Chromium —
   the scoring panel on the vMix PC itself, the REAL Clipper Helper (a temp
   copy of clipper-helper/) next to it, cutting from a recording that is
   still being written, the REAL website behind both:

     • ▶ Start Clipper in the panel → READY only when everything is really
       there (nothing typed: no recording path, no panel link)
     • a point counts the moment it is pressed; its clip job exists at once;
       the next point never waits for a video
     • "Who earned this point?" opens with the point, never as a dialog,
       never over the point buttons; one tap names the kill — the clip is
       that player's (by id) on the website and in the player's folder
     • Team point / later: kept, assignable from the Clipper sheet
     • three quick points → three clips; the same point delivered twice →
       one job
     • after a substitution the question shows the six on court AT that
       point (an earlier point still shows its own six)
     • Undo takes back the score, not an attribution
     • vMix stops recording → WARNING, and a point then says "could not be
       cut" — never a made-up clip
     • Stop clipping → STOPPED, no new jobs; a reload resumes by itself

     NODE_PATH=$(npm root -g) node test/volleyball/clipper-ui.test.js
   Screenshots: test/out/volleyball/clipper-ui-*.png
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const OUT = path.join(__dirname, '..', 'out', 'volleyball');
fs.mkdirSync(OUT, { recursive: true });
const REPO = path.join(__dirname, '..', '..');
let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, expected: b });
const head = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { bootServer } = require('../server-boot.js');
const U = { uid: 'u-work', email: 'workallsportslive@gmail.com', email_verified: true };
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
const FAKE_FIREBASE = `(function(){
  if (window.firebase) return;
  var u = window.__fakeUser || null;
  var cur = u ? { email: u.email, uid: u.uid, getIdToken: function(){ return Promise.resolve(u.token); } } : null;
  var authObj = { currentUser: cur, onAuthStateChanged: function(cb){ setTimeout(function(){ cb(cur); }, 0); return function(){}; }, onIdTokenChanged: function(cb){ setTimeout(function(){ cb(cur); }, 0); return function(){}; },
    signInWithPopup: function(){ return Promise.reject({}); }, signInWithRedirect: function(){ return Promise.resolve(); }, getRedirectResult: function(){ return Promise.resolve({ user: null }); }, signOut: function(){ return Promise.resolve(); } };
  var auth = function(){ return authObj; }; auth.GoogleAuthProvider = function(){ this.setCustomParameters = function(){}; this.addScope = function(){}; };
  window.firebase = { apps: [], initializeApp: function(){ window.firebase.apps.push({}); return {}; }, auth: auth };
})();`;

(async () => {
  if (spawnSync(FFMPEG, ['-version']).status !== 0) { console.log('clipper-ui: no ffmpeg — skipped'); process.exit(0); }
  const { port } = await bootServer({ idTokens: { 'tok-work': U }, users: { 'u-work': U.email } });
  const base = `http://127.0.0.1:${port}`;
  const api = (m, u, o) => call(port, m, u, Object.assign({ token: 'tok-work' }, o || {}));
  const browser = await chromium.launch();
  const errors = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-clip-ui-'));
  let helper = null, recorder = null, hLog = '';
  const madeMatches = [];
  try {
    const mk = (n, s) => Array.from({ length: 9 }, (_, i) => ({ name: `${n} ${['Arjun', 'Bala', 'Chetan', 'Dev', 'Eshan', 'Farhan', 'Gopal', 'Hari', 'Imran'][i]}`, number: String(i + 1), role: ['S', 'OH', 'OH', 'MB', 'MB', 'OPP', 'DS', 'U', 'L'][i], libero: i === 8 }));
    const tA = (await api('POST', '/api/volleyball/teams', { json: { name: 'Pune Panthers', shortName: 'PUN', players: mk('P', 'PUN') } })).json.team;
    const tB = (await api('POST', '/api/volleyball/teams', { json: { name: 'Goa Waves', shortName: 'GOA', players: mk('G', 'GOA') } })).json.team;
    const T = (await api('POST', '/api/volleyball/tournaments', { json: { name: 'Operator Cup', teamIds: [tA.teamId, tB.teamId] } })).json.tournament;
    const M = (await api('POST', `/api/volleyball/tournaments/${T.tournamentId}/matches`, { json: { teamA: tA.teamId, teamB: tB.teamId } })).json.match;
    const MID = M.matchId;
    madeMatches.push(MID);
    const six = (t) => (t === 'A' ? tA : tB).players.filter((p) => !p.libero).slice(0, 6).map((p) => p.playerId);

    // vMix records into its folder: a growing fragmented MP4
    const recDir = path.join(tmp, 'vMix');
    fs.mkdirSync(recDir);
    recorder = spawn(FFMPEG, ['-v', 'error', '-re', '-f', 'lavfi', '-i', "color=black:s=384x192:r=25,format=yuv420p,geq=lum='16+3*mod(floor(T),60)':cb=128:cr=128",
      '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-keyint_min', '25', '-c:a', 'aac',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1', '-f', 'mp4', path.join(recDir, 'match.mp4')], { stdio: 'ignore' });
    // the Clipper Helper (set up once on this PC: the recording folder)
    const hDir = path.join(tmp, 'ClipperHelper');
    fs.mkdirSync(hDir);
    for (const f of ['server.js', 'fmp4.js', 'clipOrganizer.js', 'volleyballOrganizer.js', 'package.json']) fs.copyFileSync(path.join(REPO, 'clipper-helper', f), path.join(hDir, f));
    const hPort = await freePort();
    fs.writeFileSync(path.join(hDir, 'config.json'), JSON.stringify({ port: hPort, vmixRecordingFile: recDir, mainServerUrl: '' }));
    helper = spawn(process.execPath, [path.join(hDir, 'server.js')], { env: Object.assign({}, process.env, { NODE_PATH: path.join(REPO, 'node_modules'), CLIPPER_NO_BROWSER: '1', FFMPEG_PATH: FFMPEG }), stdio: ['ignore', 'pipe', 'pipe'] });
    helper.stdout.on('data', (d) => { hLog += d; }); helper.stderr.on('data', (d) => { hLog += d; });
    const H = (m, u, o) => call(hPort, m, u, o);
    for (let i = 0; i < 100; i++) { await sleep(100); try { if ((await H('GET', '/status')).status === 200) break; } catch (e) { /* booting */ } }

    async function openPanel(viewport) {
      const ctx = await browser.newContext({ viewport: viewport || { width: 1366, height: 768 } });
      const page = await ctx.newPage();
      await page.addInitScript((user) => { window.__fakeUser = user; }, { email: U.email, uid: U.uid, token: 'tok-work' });
      await page.route('https://www.gstatic.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_FIREBASE }));
      await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
      await page.route('http://localhost:5005/**', (r) => r.continue({ url: r.request().url().replace('localhost:5005', '127.0.0.1:' + hPort) }));
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${base}/volleyball-panel?match=${MID}`);
      return { ctx, page };
    }
    let { ctx, page } = await openPanel();
    // toss, line-ups and set 1 — the panel's normal flow
    await page.waitForSelector('#tossBtn:not([disabled])', { timeout: 15000 });
    await page.click('#tossBtn');
    await page.click('.sheet [data-w="A"]'); await page.click('.sheet [data-c="serve"]'); await page.click('.sheet [data-l="A"]');
    await page.click('.sheet #ok');
    for (const t of ['A', 'B']) {
      for (const id of six(t)) await page.click(`[data-bp="${t}|${id}"]`);
      await page.click(`[data-save="${t}"]`);
      await page.waitForSelector(`[data-save="${t}"]`);
      await sleep(300);
    }
    await page.waitForSelector('#startBtn:not([disabled])', { timeout: 8000 });
    await page.click('#startBtn');
    await page.waitForSelector('.live [data-point="A"]', { timeout: 8000 });
    const jobs = async () => ((await H('GET', `/clip-jobs?limit=100&matchId=${MID}`)).json.jobs || []);
    const clipOf = async (eventId) => ((await api('GET', `/api/volleyball/matches/${MID}/clips?eventId=${eventId}`)).json.clips || [])[0] || null;
    const lastRally = async () => { const tl = (await api('GET', `/api/volleyball/matches/${MID}?timeline=1`)).json.timeline.filter((e) => e.type === 'RALLY'); return tl[tl.length - 1]; };
    const model = () => page.evaluate(() => { const m = window.__vbPanel.CL.model(); return { state: m.state, text: m.text, checks: m.checks.map((c) => c.ok), counts: m.counts }; });

    head('START CLIPPER IN THE PANEL');
    ok('before: the chip says STOPPED (points are not clipped)', /STOPPED/.test(await page.textContent('#clpChip')));
    await page.click('#clpChip');
    await page.waitForSelector('.sheet #clpStart');
    await page.click('.sheet #clpStart');
    const ready = await page.waitForFunction(() => { const m = window.__vbPanel.CL.model(); return m.state === 'READY'; }, null, { timeout: 30000 }).then(() => true, () => false);
    ok('READY — the Clipper app, this match, the vMix recording and the website were all found; nothing was typed', ready, await model());
    await page.screenshot({ path: path.join(OUT, 'clipper-ui-sheet.png') });
    await page.click('.sheet [data-close], .scrim', { position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Escape');
    await page.waitForSelector('.scrim', { state: 'detached', timeout: 3000 }).catch(() => {});
    ok('the chip says READY', /READY/.test(await page.textContent('#clpChip')), await page.textContent('#clpChip'));
    const srv = (await api('GET', `/api/volleyball/matches/${MID}/clipper`)).json.clipper;
    ok('the website knows this panel is clipping the match', srv && srv.live && /Windows|Linux|Mac|device/.test(srv.label), srv);
    // give the recording 16 s so the first clip has its full lead-in
    await sleep(9000);

    head('A POINT — counted at once, its clip on the way, the question asked');
    const t1 = Date.now();
    await page.click('[data-point="A"]');
    const counted = await page.evaluate(() => document.querySelector('.bigscore[data-team="A"]').textContent);
    eq('the score changes the moment the button is pressed', counted, '1');
    await page.waitForSelector('#ask:not([hidden])', { timeout: 3000 });
    ok('"Who earned this point?" opens with it — not a dialog, nothing to dismiss before scoring on', await page.locator('.scrim').count() === 0 && /Who earned this point/.test(await page.textContent('#ask')));
    const btn = await page.locator('[data-point="A"]').boundingBox(), btnB = await page.locator('[data-point="B"]').boundingBox(), ask = await page.locator('#ask').boundingBox();
    ok('…and it never covers the point buttons', btn.y + btn.height <= ask.y && btnB.y + btnB.height <= ask.y, { btn, btnB, ask });
    const j1 = await (async () => { for (let i = 0; i < 20; i++) { const l = await jobs(); if (l.length) return l; await sleep(150); } return []; })();
    ok('the clip job exists right away (one job, waiting for the 3 s after the point)', j1.length === 1 && j1[0].syncStatus === 'WAITING' && j1[0].sport === 'volleyball', j1.map((x) => x.syncStatus));
    await sleep(650);
    await page.click('[data-point="B"]');
    const both = await page.evaluate(() => [...document.querySelectorAll('.bigscore')].map((b) => b.textContent).join('-'));
    eq('the next point does not wait for the first clip to be made', both, '1-1');
    ok('…the question moved to the newest point; the first is kept to assign later', /GOA/.test(await page.textContent('#ask .ask-h')) && /more to assign/.test(await page.textContent('#ask')));
    await page.screenshot({ path: path.join(OUT, 'clipper-ui-ask.png') });

    head('ONE TAP NAMES THE KILL — the clip is that player’s');
    const p1 = await lastRally();   // GOA's point
    const killer = six('B')[3];
    await page.click(`#ask [data-ap="${killer}"]`);
    await page.waitForSelector('#ask', { state: 'hidden', timeout: 3000 }).catch(() => {});
    let c;
    for (let i = 0; i < 80; i++) { c = await clipOf(p1.eventId); if (c && c.attribution && c.attribution.type === 'kill' && ['COMPLETE', 'SERVER_ONLY'].includes(c.status)) break; await sleep(500); }
    ok('the website clip: uploaded, linked to the kill’s player by id, with the name and number', c && ['COMPLETE', 'SERVER_ONLY'].includes(c.status) && c.attribution.playerId === killer && c.players.some((x) => x.playerId === killer && x.number === '4'), c && { st: c.status, a: c.attribution, p: c.players });
    const pc = (await api('GET', `/api/volleyball/matches/${MID}/clips?playerId=${killer}`)).json.clips.map((x) => x.eventId);
    ok('…it is in that player’s clips', pc.includes(p1.eventId), pc);
    let hj;
    for (let i = 0; i < 30; i++) { hj = (await H('GET', `/clip-jobs/${MID}_${p1.eventId}`)).json.job; if (hj && /_Kill_4-/.test(hj.localPath || '')) break; await sleep(300); }
    ok('…and on this PC it is filed under the player (same file, one cut)', hj && /_Kill_4-G-Dev\.mp4$/.test(hj.localPath) && hj.links.some((l) => l.playerId === killer) && hj.cutAttempts === 1, hj && { p: hj.localPath, cuts: hj.cutAttempts });
    const s1 = (await api('GET', `/api/volleyball/matches/${MID}/stats`)).json.stats;
    const ks = s1 && s1.players && (s1.players[killer] || (Array.isArray(s1.players) ? s1.players.find((x) => x.playerId === killer) : null));
    ok('…and the kill counts in the player’s statistics (the point itself is not counted twice)', ks && (ks.kills === 1 || (ks.attack && ks.attack.kills === 1)) && (await lastRally()).after.score.A + (await lastRally()).after.score.B === 2, ks);

    head('TEAM POINT, AND ONE LEFT FOR LATER');
    await sleep(700);
    await page.click('[data-point="A"]');
    await page.waitForSelector('#ask:not([hidden])');
    await page.click('#ask [data-at="team"]');
    await sleep(500);
    const tp = await lastRally();
    for (let i = 0; i < 20; i++) { c = await clipOf(tp.eventId); if (c && c.attribution && c.attribution.type === 'team') break; await sleep(400); }
    ok('Team point: decided, no player — the clip is still the match’s', c && c.attribution.type === 'team' && c.players.length === 0, c && c.attribution);
    await sleep(700);
    await page.click('[data-point="A"]');
    await page.waitForSelector('#ask:not([hidden])');
    await page.click('#ask [data-ax]');   // later
    const later = await lastRally();
    ok('× = later: the point is counted, its clip is made, it waits to be assigned', (await page.textContent('#clpChip')).includes('to assign'), await page.textContent('#clpChip'));

    head('THREE QUICK POINTS, AND THE SAME POINT DELIVERED TWICE');
    for (let i = 0; i < 3; i++) { await sleep(650); await page.click(`[data-point="${i % 2 ? 'B' : 'A'}"]`); }
    const rallies = (await api('GET', `/api/volleyball/matches/${MID}?timeline=1`)).json.timeline.filter((e) => e.type === 'RALLY');
    let jl = [];
    for (let i = 0; i < 40; i++) { jl = await jobs(); if (jl.length >= rallies.length) break; await sleep(300); }
    eq('one clip job per point — nothing lost in the rush', [jl.length, new Set(jl.map((x) => x.clipId)).size], [rallies.length, rallies.length]);
    // the panel's outbox re-sending a point (a reconnect, a retry): the same job
    const again = jl[0];
    const dup = (await H('POST', '/clip', { json: { sport: 'volleyball', matchId: MID, clipId: again.clipId, timestamp: again.t0, point: { eventId: again.clipId.slice(MID.length + 1), set: 1 } } })).json;
    await page.evaluate(() => { window.__vbPanel.socket.disconnect(); });
    await sleep(500);
    await page.evaluate(() => { window.__vbPanel.socket.connect(); });
    await sleep(2500);
    ok('the same point delivered again — and a reconnect — make no second job', dup.duplicate === true && (await jobs()).length === rallies.length, { dup: dup.duplicate, jobs: (await jobs()).length });
    let all = [];
    for (let i = 0; i < 90; i++) { all = await jobs(); if (all.every((x) => ['SYNC_COMPLETE', 'CUT_FAILED'].includes(x.syncStatus))) break; await sleep(500); }
    ok('every clip was cut and uploaded', all.every((x) => x.syncStatus === 'SYNC_COMPLETE'), all.map((x) => x.syncStatus));
    ok('…each is its own file', new Set(all.map((x) => x.localPath)).size === all.length);

    head('A SUBSTITUTION — each point asks about the six on court THEN');
    const out = six('A')[1], inn = tA.players.find((p) => !p.libero && !six('A').includes(p.playerId)).playerId;
    await page.click('[data-sub="A"]');
    await page.click(`.sheet [data-o="${out}"]`);
    await page.click(`.sheet [data-i="${inn}"]`);
    await page.click('.sheet #ok');
    await sleep(800);
    await page.click('[data-point="A"]');
    await page.waitForSelector('#ask:not([hidden])');
    const nowSix = await page.$$eval('#ask [data-ap]', (b) => b.map((x) => x.dataset.ap));
    ok('a point after it: the new player is there, the one who went off is not', nowSix.includes(inn) && !nowSix.includes(out), nowSix);
    await page.click('#ask [data-ax]');
    // the earlier point, assigned later from the Clipper sheet
    await page.click('#clpChip');
    await page.waitForSelector(`.sheet .clprow[data-ev="${later.eventId}"] [data-assign]`, { timeout: 8000 });
    await page.click(`.sheet .clprow[data-ev="${later.eventId}"] [data-assign]`);
    await page.waitForSelector('#ask:not([hidden])');
    const thenSix = await page.$$eval('#ask [data-ap]', (b) => b.map((x) => x.dataset.ap));
    ok('the earlier point (assigned later from the Clipper sheet) shows ITS six — the player who has since gone off', thenSix.includes(out) && !thenSix.includes(inn), thenSix);
    await page.click(`#ask [data-ap="${out}"]`);
    await sleep(800);
    for (let i = 0; i < 20; i++) { c = await clipOf(later.eventId); if (c && c.attribution && c.attribution.playerId === out) break; await sleep(400); }
    ok('…assigned to that player — the earlier clips keep their own players', c && c.attribution.playerId === out && (await clipOf(p1.eventId)).attribution.playerId === killer, c && c.attribution);

    head('UNDO TAKES BACK THE SCORE, NOT AN ATTRIBUTION');
    const before = (await lastRally()).after.score;
    await page.click('#undo');
    await sleep(1200);
    const sNow = (await api('GET', `/api/volleyball/matches/${MID}?timeline=1`)).json.summary.points;
    ok('the last point is undone (the attribution made since does not stand in the way)', sNow.A + sNow.B === before.A + before.B - 1, { before, now: sNow });
    ok('…its clip is kept and marked, not deleted', !!(await page.evaluate(() => window.__vbPanel.CL.recent(40).find((r) => r.voided && r.state.k === 'CANCELLED'))));

    head('PHONE WIDTH — the question fits, nothing scrolls sideways');
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    await page.click('[data-point="B"]');
    await page.waitForSelector('#ask:not([hidden])');
    await sleep(400);
    ok('no sideways scrolling', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    const askBox = await page.locator('#ask').boundingBox();
    ok('the question is inside the screen', askBox.x >= 0 && askBox.x + askBox.width <= 390 && askBox.y + askBox.height <= 844, askBox);
    await page.screenshot({ path: path.join(OUT, 'clipper-ui-phone.png') });
    await page.click('#ask [data-ax]');
    await page.setViewportSize({ width: 1366, height: 768 });

    head('A RELOAD — clipping resumes by itself');
    await page.reload();
    await page.waitForSelector('.live [data-point="A"]', { timeout: 15000 });
    const back = await page.waitForFunction(() => window.__vbPanel.CL && window.__vbPanel.CL.model().state === 'READY', null, { timeout: 20000 }).then(() => true, () => false);
    ok('READY again without pressing anything', back, await model());

    head('vMIX STOPS RECORDING — said, not hidden');
    recorder.kill('SIGINT');
    await new Promise((r) => recorder.once('exit', r));
    recorder = null;
    const warned = await page.waitForFunction(() => { const m = window.__vbPanel.CL.model(); return m.state === 'WARNING' && /not recording/i.test(m.text); }, null, { timeout: 40000 }).then(() => true, () => false);
    ok('WARNING: vMix is not recording', warned, await model());
    await page.click('[data-point="A"]');
    const stopped = await lastRally();
    await page.click('#ask [data-ax]').catch(() => {});
    let fj;
    for (let i = 0; i < 60; i++) { fj = (await H('GET', `/clip-jobs/${MID}_${stopped.eventId}`)).json.job; if (fj && fj.syncStatus === 'CUT_FAILED') break; await sleep(500); }
    ok('a point now: "could not be cut" — no clip is invented', fj && fj.syncStatus === 'CUT_FAILED', fj && fj.syncStatus);
    await page.click('#clpChip');
    await page.waitForSelector(`.sheet .clprow[data-ev="${stopped.eventId}"] [data-retry]`, { timeout: 8000 }).then(() => ok('…with Retry next to it', true), () => ok('…with Retry next to it', false));
    await page.screenshot({ path: path.join(OUT, 'clipper-ui-warning.png') });

    head('STOP CLIPPING');
    await page.click('.sheet #clpStop');
    await page.click('.sheet .btn.primary, .sheet [data-ok]').catch(() => {});   // the confirmation
    const st = await page.waitForFunction(() => window.__vbPanel.CL.model().state === 'STOPPED', null, { timeout: 8000 }).then(() => true, () => false);
    ok('STOPPED', st, await model());
    const n0 = (await jobs()).length;
    await page.keyboard.press('Escape');
    await sleep(700);
    await page.click('[data-point="A"]');
    await sleep(2000);
    ok('a point after Stop makes no clip job', (await jobs()).length === n0);
    const srv2 = (await api('GET', `/api/volleyball/matches/${MID}/clipper`)).json.clipper;
    ok('…and the website shows the session stopped', srv2 && srv2.stoppedAt && !srv2.live, srv2);
    ok('no page error', errors.length === 0, errors);
    await ctx.close();
  } catch (e) {
    fails.push('crashed: ' + (e.stack || e));
    console.log(e.stack || e);
  } finally {
    if (recorder) try { recorder.kill('SIGKILL'); } catch (e) { /* gone */ }
    if (helper) try { helper.kill('SIGKILL'); } catch (e) { /* gone */ }
    await browser.close();
    if (fails.length) console.log('\n--- helper log (last 3000) ---\n' + hLog.slice(-3000));
    for (const id of madeMatches) fs.rmSync(path.join(REPO, 'clips', 'volleyball', id), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ':\n  - ' + fails.join('\n  - ') : ''}`);
  process.exit(fails.length ? 1 : 0);
})();
