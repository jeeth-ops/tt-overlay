/* 🏐 The volleyball module in a REAL browser (Chromium via Playwright),
   against the REAL server.js (in-memory MongoDB, stand-in Firebase) and the
   REAL Volleyball Clipper (volleyball-clipper-helper/, a temp copy —
   volleyball's own program, not the Cricket Clipper) cutting from a
   recording that is still being written, the way vMix writes one:

     dashboard  — two teams and a tournament made through the UI, fixtures
                  generated, the match opened;
     panel      — on a "phone" that cannot reach any Clipper app: toss,
                  line-ups, set 1 started, points (+1, a kill with its
                  attacker), a time-out, an undo, a substitution — every
                  number checked against the server's ledger;
     clipper    — on the "recording PC": ▶ Start Clipper, READY only once
                  the recording is really growing; the phone's kill clipped
                  by relay: the press converted to this PC's clock, 7 s
                  before + 3 s after — proven from the frames of the clip;
                  the attacker named after the point, the clip follows;
     overlay    — 1920×1080, transparent; the bar follows every point;
                  time-out, match point and final pills; each on-air
                  graphic shown, never overlapping the bar; compact layout;
     scorecard  — statistics, the attacker's 🎬 icon opens that point's
                  clip; the PDF link only once the PDF exists; phone width;
     tournament — table (3-2-1-0), leaders, teams, head-to-head;
     no uncaught page error anywhere.

   Screenshots: test/out/volleyball/*.png

     NODE_PATH=$(npm root -g) node test/volleyball/ui.test.js
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync, spawnSync } = require('child_process');
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let j = null; try { j = JSON.parse(buf.toString()); } catch (e) {} resolve({ status: res.statusCode, json: j, buf, headers: res.headers }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
// The recording's own time at a frame of a clip (left third: second,
// middle: minute, right: the fraction — see the recorder below).
function timeAt(file, which) {
  const args = which === 'first'
    ? ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=6:2:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']
    : ['-v', 'error', '-sseof', '-0.25', '-i', file, '-frames:v', '1', '-vf', 'scale=6:2:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'];
  const y = execFileSync(FFMPEG, args).subarray(0, 12);
  const col = (a) => (y[a] + y[a + 1] + y[a + 6] + y[a + 7]) / 4;
  return Math.round((col(2) - 16) / 3) * 60 + Math.round((col(0) - 16) / 3) + Math.max(0, Math.min(0.999, (col(4) - 16) / 200));
}
function duration(file) {
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(spawnSync(FFMPEG, ['-hide_banner', '-i', file]).stderr));
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

// The browser's Firebase SDK, replaced: window.__fakeUser decides who is signed in.
const FAKE_FIREBASE = `(function(){
  if (window.firebase) return;
  var u = window.__fakeUser || null;
  var cur = u ? { email: u.email, uid: u.uid, getIdToken: function(){ return Promise.resolve(u.token); } } : null;
  var authObj = {
    currentUser: cur,
    onAuthStateChanged: function(cb){ setTimeout(function(){ cb(cur); }, 0); return function(){}; },
    onIdTokenChanged: function(cb){ setTimeout(function(){ cb(cur); }, 0); return function(){}; },
    signInWithPopup: function(){ window.__signInClicked = true; return Promise.reject({ code: 'auth/popup-closed-by-user' }); },
    signInWithRedirect: function(){ return Promise.resolve(); },
    getRedirectResult: function(){ return Promise.resolve({ user: null }); },
    signOut: function(){ return Promise.resolve(); }
  };
  var auth = function(){ return authObj; };
  auth.GoogleAuthProvider = function(){ this.setCustomParameters = function(){}; this.addScope = function(){}; };
  window.firebase = { apps: [], initializeApp: function(){ window.firebase.apps.push({}); return {}; }, auth: auth };
})();`;

(async () => {
  if (spawnSync(FFMPEG, ['-version']).status !== 0) { console.log('volleyball ui: no ffmpeg — skipped'); process.exit(0); }
  const { port } = await bootServer({ idTokens: { 'tok-work': U }, users: { 'u-work': U.email } });
  const base = `http://127.0.0.1:${port}`;
  const api = (m, u, o) => call(port, m, u, Object.assign({ token: 'tok-work' }, o || {}));
  const browser = await chromium.launch();
  const pageErrors = [];
  const contexts = [];
  // helper: 'block' (a phone: no Clipper app reachable), a port (the recording PC's Volleyball Clipper), or null (untouched)
  async function open(url, { who = 'work', viewport = { width: 1366, height: 768 }, helper = 'block', scheme = 'light', init } = {}) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.addInitScript(([user, extra]) => {
      window.__fakeUser = user;
      try { Object.keys(extra || {}).forEach((k) => localStorage.setItem(k, extra[k])); } catch (e) { /* first load */ }
    }, [who ? { email: U.email, uid: U.uid, token: 'tok-' + who } : null, init || {}]);
    await page.route('https://www.gstatic.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_FIREBASE }));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
    if (helper === 'block') await page.route('http://localhost:5007/**', (r) => r.abort());
    else if (helper) await page.route('http://localhost:5007/**', (r) => r.continue({ url: r.request().url().replace('localhost:5007', '127.0.0.1:' + helper) }));
    page.on('pageerror', (e) => pageErrors.push(url.split('?')[0] + ': ' + String(e)));
    await page.goto(base + url);
    return page;
  }
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });
  // the overlay's screenshots over a camera-like picture (the page itself stays transparent)
  const backdrop = (page) => page.evaluate(() => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:-1;background:radial-gradient(ellipse at 50% 120%,#d9a066 0%,#8a5a2b 35%,#2f4f2f 70%,#16261a 100%)';
    document.body.prepend(d);
  });
  // no text cut short with an ellipsis
  const clipped = (page, sel) => page.evaluate((q) => [...document.querySelectorAll(q)].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim()), sel);
  const toastSeen = (page, text) => page.waitForSelector(`.toast:has-text("${text}")`, { timeout: 8000 }).then(() => true, () => false);
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  let helperProc = null, recProc = null, hLog = '';
  try {
    /* ------------------------------------------------------------ dashboard */
    head('DASHBOARD — teams, tournament and fixtures through the UI');
    const dash = await open('/volleyball', { viewport: { width: 1280, height: 860 } });
    await dash.waitForSelector('#newteam');
    for (const [name, short, city] of [['Pune Panthers', 'PUN', 'Pune'], ['Goa Waves', 'GOA', 'Goa']]) {
      await dash.click('#newteam');
      await dash.waitForSelector('#nm');
      await dash.fill('#nm', name);
      await dash.fill('#sn', short);
      await dash.fill('#cy', city);
      const roles = ['S', 'OH', 'OH', 'MB', 'MB', 'OPP', 'DS'];
      for (let i = 0; i < 8; i++) {
        const row = dash.locator('.rrow').nth(i === 7 ? 11 : i);
        await row.locator('[data-f="name"]').fill(`${city} Player ${i + 1}`);
        if (i < 7) await row.locator('[data-f="role"]').selectOption(roles[i]);
      }
      await dash.locator('.rrow').nth(0).locator('[data-t="captain"]').click();
      if (name === 'Pune Panthers') await shot(dash, 'dashboard-team-editor');
      await dash.click('#tsv');
      ok(`team “${name}” created in the dashboard`, await toastSeen(dash, 'Team created'));
    }
    await dash.click('#newt');
    await dash.waitForSelector('#tname');
    await dash.fill('#tname', 'Browser Cup');
    await dash.fill('#tvenue', 'Balewadi Hall');
    for (const n of ['Pune Panthers', 'Goa Waves']) await dash.click(`[data-tm]:has-text("${n}")`);
    await shot(dash, 'dashboard-tournament-editor');
    await dash.click('#tsave');
    ok('tournament created, its page opens', await toastSeen(dash, 'Tournament created'));
    await dash.waitForSelector('[data-gen]');
    await dash.click('[data-gen]');
    await dash.click('#nos');
    await dash.waitForSelector('.mrow');
    const MID = await dash.getAttribute('.mrow', 'data-m');
    ok('a fixture was generated', /^vbm/.test(MID || ''), MID);
    await shot(dash, 'dashboard-tournament');
    const M = (await api('GET', `/api/volleyball/matches/${MID}`)).json.match;
    const TID = M.tournamentId;
    eq('the match has both squads (8 each, one libero each)', [M.squads.A.length, M.squads.B.length, M.squads.A.filter((p) => p.libero).length], [8, 8, 1]);
    const six = (t) => M.squads[t].filter((p) => !p.libero).slice(0, 6).map((p) => p.playerId);

    /* ------------------------------------------------------------ engine + clipper */
    head('CLIPPER on the recording PC — the real Volleyball Clipper, vMix recording');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-ui-'));
    const recDir = path.join(tmp, 'vMix Recordings');
    fs.mkdirSync(recDir, { recursive: true });
    // what vMix writes while it records: a fragmented MP4, growing in real time;
    // every frame carries its own time in its brightness
    const W0 = Date.now();
    recProc = spawn(FFMPEG, ['-v', 'error', '-re', '-f', 'lavfi', '-i', "color=black:s=384x192:r=25,format=yuv420p,geq=lum='if(lt(X,128),16+3*mod(floor(T),60),if(lt(X,256),16+3*floor(T/60),16+200*(T-floor(T))))':cb=128:cr=128",
      '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-keyint_min', '25', '-c:a', 'aac',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1', '-f', 'mp4', path.join(recDir, 'capture.mp4')], { stdio: 'ignore' });
    // the Volleyball Clipper, from a temp copy, set up once for this PC (the recording folder)
    const hDir = path.join(tmp, 'VolleyballClipper');
    fs.mkdirSync(hDir);
    for (const f of ['volleyball-clipper-server.js', 'vb-fmp4.js', 'vb-organizer.js', 'package.json']) fs.copyFileSync(path.join(REPO, 'volleyball-clipper-helper', f), path.join(hDir, f));
    const hPort = 5300 + Math.floor(Math.random() * 600);
    fs.writeFileSync(path.join(hDir, 'volleyball-clipper-config.json'), JSON.stringify({ port: hPort, vmixRecordingFile: recDir, mainServerUrl: '' }));
    helperProc = spawn(process.execPath, [path.join(hDir, 'volleyball-clipper-server.js')], { env: Object.assign({}, process.env, { NODE_PATH: path.join(REPO, 'node_modules'), CLIPPER_NO_BROWSER: '1', FFMPEG_PATH: FFMPEG }), stdio: ['ignore', 'pipe', 'pipe'] });
    helperProc.stdout.on('data', (d) => { hLog += d; }); helperProc.stderr.on('data', (d) => { hLog += d; });
    for (let i = 0; i < 100; i++) { await sleep(100); try { if ((await call(hPort, 'GET', '/status')).status === 200) break; } catch (e) { /* booting */ } }

    const clipper = await open(`/volleyball-clipper?match=${MID}`, { helper: hPort, viewport: { width: 1280, height: 900 } });
    await clipper.waitForSelector('#clpStart', { timeout: 15000 });
    ok('before Start Clipper: STOPPED — never "ready" just because the page is open', await clipper.locator('.clphead .clpword:has-text("STOPPED")').count() === 1);
    await clipper.click('#clpStart');
    const ready = await clipper.waitForSelector('.clphead .clpword:has-text("READY")', { timeout: 30000 }).then(() => true, () => false);
    ok('▶ Start Clipper → READY: the Clipper app, this match, the recording vMix is writing, the website — all found, nothing typed', ready, await clipper.textContent('#clp').catch(() => ''));
    const hs = (await call(hPort, 'GET', '/status')).json;
    eq('…the Volleyball Clipper is set up for THIS match and THIS website', [hs.matchId, hs.sport, hs.mainServerUrl, hs.currentRecordingFile && path.basename(hs.currentRecordingFile)], [MID, 'volleyball', base, 'capture.mp4']);
    const ck = await clipper.$$eval('.clpchecks > div', (d) => d.map((x) => x.className));
    ok('…every check ticked', ck.length === 4 && ck.every((c) => c === 'ok'), ck);
    await shot(clipper, 'clipper-ready');

    /* ------------------------------------------------------------ overlay */
    head('OVERLAY — 1920×1080, transparent');
    const overlay = await open(`/volleyball-overlay?match=${MID}`, { who: null, helper: null, viewport: { width: 1920, height: 1080 } });
    await overlay.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 15000 });
    const bg = await overlay.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
    eq('the page background is transparent (OBS shows the camera through it)', bg, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
    await backdrop(overlay);
    const names = await overlay.evaluate(() => [document.querySelector('#na').textContent.trim(), document.querySelector('#nb').textContent.trim()]);
    eq('the bar shows both teams', names, ['Pune Panthers', 'Goa Waves']);

    /* ------------------------------------------------------------ live output window */
    head('LIVE OUTPUT WINDOW — the camera + overlay window the engine records');
    const camBrowser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    try {
      const lctx = await camBrowser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['camera'] });
      const lo = await lctx.newPage();
      await lo.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
      await lo.route('http://127.0.0.1:5006/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"success":true}' }));
      lo.on('pageerror', (e) => pageErrors.push('live-output: ' + String(e)));
      await lo.goto(`${base}/volleyball-live-output?match=${MID}&videoLabel=fake`);
      const playing = await lo.waitForFunction(() => document.querySelector('#camera-video').readyState >= 2, null, { timeout: 15000 }).then(() => true, () => false);
      eq('its title is the one the engine finds the window by', await lo.title(), `AllSportsLive-LiveOutput-${MID}`);
      eq('the volleyball overlay (never the cricket one) is over the camera', await lo.getAttribute('#overlay-frame', 'src'), `${base}/volleyball-overlay?match=${MID}`);
      ok('the camera picture is playing under it', playing);
      await lo.frameLocator('#overlay-frame').locator('body.ready').waitFor({ timeout: 15000 }).then(() => ok('…and the overlay inside it is live', true), () => ok('…and the overlay inside it is live', false));
      await shot(lo, 'live-output-window');
      await lctx.close();
    } finally { await camBrowser.close(); }

    /* ------------------------------------------------------------ panel */
    head('PANEL on a phone (no clip engine reachable) — toss, line-ups, scoring');
    const panel = await open(`/volleyball-panel?match=${MID}`, { viewport: { width: 1366, height: 768 } });
    await panel.waitForSelector('#tossBtn:not([disabled])', { timeout: 15000 });
    ok('the panel took control of the match (first device)', await panel.locator('.chip.on:has-text("In control")').count() === 1);
    await panel.click('#tossBtn');
    await panel.click('.sheet [data-w="A"]'); await panel.click('.sheet [data-c="serve"]'); await panel.click('.sheet [data-l="A"]');
    await panel.click('.sheet #ok');
    for (const t of ['A', 'B']) {
      for (const id of six(t)) {
        await panel.click(`[data-bp="${t}|${id}"]`);
      }
      await panel.click(`[data-save="${t}"]`);
      await panel.waitForSelector(`[data-save="${t}"]`);
      await sleep(300);
    }
    await shot(panel, 'panel-pregame');
    await panel.waitForSelector('#startBtn:not([disabled])', { timeout: 8000 });
    await panel.click('#startBtn');
    await panel.waitForSelector('.live [data-point="A"]', { timeout: 8000 });
    const sum = async () => (await api('GET', `/api/volleyball/matches/${MID}?timeline=1`)).json.summary;
    let s = await sum();
    eq('set 1 is on, the toss winner serves', [s.status, s.set, s.serving], ['in_set', 1, 'A']);

    // the kill — this is the point the clipper PC clips. The tap counts the
    // point at once; who scored it is asked afterwards, never in the way
    const attacker = six('A')[3];
    const tPress = Date.now();
    await panel.click('[data-q="ATTACK_KILL"][data-qt="A"]');
    await panel.waitForSelector('#ask:not([hidden])', { timeout: 4000 });
    const countedFirst = await panel.evaluate(() => document.querySelector('.bigscore[data-team="A"]').textContent);
    eq('the tap counts the point at once — before anyone is named', countedFirst, '1');
    ok('…and asks "Who earned this point?" without blocking anything (no dialog)', await panel.locator('.scrim').count() === 0 && /Who earned this point/.test(await panel.textContent('#ask')));
    await panel.click(`#ask [data-ap="${attacker}"]`);
    const tAfter = Date.now();
    await panel.waitForSelector('#ask', { state: 'hidden', timeout: 4000 }).catch(() => {});
    await sleep(800);
    const plus = async (t, n) => { for (let i = 0; i < n; i++) { await panel.click(`[data-point="${t}"]`); await sleep(680); } };
    await plus('B', 2);
    await plus('A', 1);
    await panel.waitForFunction(() => !document.querySelector('.bigscore.pend'), null, { timeout: 8000 });
    s = await sum();
    eq('the server has exactly what the panel scored (A 2 – B 2)', [s.points.A, s.points.B], [2, 2]);
    eq('…and the panel shows the same', await panel.evaluate(() => [...document.querySelectorAll('.bigscore')].map((b) => b.dataset.team + b.textContent)), ['A2', 'B2']);
    await overlay.waitForFunction(() => document.querySelector('#pa .n:last-child').textContent === '2' && document.querySelector('#pb .n:last-child').textContent === '2', null, { timeout: 8000 });
    ok('the overlay followed every point (2–2)', true);

    // a time-out, seen on the panel and on air
    await panel.click('[data-to="B"]');
    await overlay.waitForFunction(() => /Time-out/i.test(document.querySelector('#pill').textContent) && document.querySelector('#pill').classList.contains('show'), null, { timeout: 8000 }).then(() => ok('the overlay shows the time-out with its count-down', true), () => ok('the overlay shows the time-out with its count-down', false));
    ok('…and so does the panel', /Time-out/.test(await panel.textContent('#status')));
    await sleep(900);
    await shot(overlay, 'overlay-timeout');
    // a wrong point, undone
    await plus('B', 1);
    await panel.click('#undo');
    await sleep(900);
    s = await sum();
    eq('undo takes the last point back (still 2–2)', [s.points.A, s.points.B], [2, 2]);
    // a substitution, checked as it is chosen
    await panel.click('[data-sub="A"]');
    await panel.click(`.sheet [data-o="${six('A')[1]}"]`);
    const benchA = M.squads.A.find((p) => !p.libero && !six('A').includes(p.playerId)).playerId;
    await panel.click(`.sheet [data-i="${benchA}"]`);
    ok('the substitution sheet confirms it is legal before it is sent', /Legal substitution/.test(await panel.textContent('.sheet #check')));
    await panel.click('.sheet #ok');
    await sleep(900);
    s = await sum();
    eq('substitution recorded (5 left)', s.subsLeft.A, 5);
    await shot(panel, 'panel-live');
    ok('the panel fits 1366×768 without sideways scrolling', await noOverflow(panel));

    /* ------------------------------------------------------------ offline */
    head('OFFLINE — a dropped line never loses a point');
    await panel.evaluate(() => window.__vbPanel.socket.disconnect());
    await panel.waitForSelector('#chips .chip:has-text("Offline")', { timeout: 8000 });
    await plus('A', 1);
    await plus('B', 1);
    eq('scored while offline: the panel shows both points at once and holds them', [await panel.evaluate(() => [...document.querySelectorAll('.bigscore')].map((b) => b.textContent).join('-')), /2 waiting/.test(await panel.textContent('#chips'))], ['3-3', true]);
    s = await sum();
    eq('…the website does not have them yet', [s.points.A, s.points.B], [2, 2]);
    // the panel warns before leaving with unsent points; the person leaves anyway
    const leaveWarned = new Promise((resolve) => panel.once('dialog', (d) => { resolve(d.type()); d.accept().catch(() => {}); }));
    await panel.reload();   // the phone's browser reloads before the line is back
    eq('leaving with unsent points asks first', await Promise.race([leaveWarned, sleep(3000).then(() => 'no dialog')]), 'beforeunload');
    await panel.waitForSelector('.live [data-point="A"]', { timeout: 15000 });
    await panel.waitForFunction(() => { const c = document.querySelector('#chips').textContent; return /Live/.test(c) && !/waiting|Saving/.test(c); }, null, { timeout: 15000 }).catch(() => {});
    s = await sum();
    eq('after the reload the held points reach the website — once each (3–3)', [s.points.A, s.points.B], [3, 3]);
    const tlOff = (await api('GET', `/api/volleyball/matches/${MID}?timeline=1`)).json.timeline.filter((e) => e.type === 'RALLY');
    eq('…no rally recorded twice', new Set(tlOff.map((e) => e.eventId)).size, tlOff.length);

    /* ------------------------------------------------------------ corrections */
    head('CORRECTIONS — a void, with its reason, in the ledger and the audit log');
    await panel.click('#fixBtn');
    await panel.locator('.sheet [data-void]').first().click();
    await panel.fill('.sheet input.input', 'Line judge reversed the call');
    await panel.click('.sheet [data-ok]');
    await sleep(1000);
    s = await sum();
    eq('the voided point leaves the score (A 3 – B 2)', [s.points.A, s.points.B], [3, 2]);
    const au = (await api('GET', `/api/volleyball/matches/${MID}/audit`)).json.audit.find((a) => a.action === 'event.void');
    eq('…and the audit log keeps who, what and why', au && [au.details.reason, au.by.email], ['Line judge reversed the call', U.email]);

    /* ------------------------------------------------------------ the clip of the kill */
    head('THE KILL’S CLIP — phone press, clipped on the recording PC');
    const tl = (await api('GET', `/api/volleyball/matches/${MID}?timeline=1`)).json.timeline;
    const killEv = tl.find((e) => e.type === 'RALLY' && e.outcome === 'ATTACK_KILL');
    let clip = null;
    for (let i = 0; i < 120; i++) {
      const list = (await api('GET', `/api/volleyball/matches/${MID}/clips?eventId=${killEv.eventId}`)).json.clips;
      clip = list[0];
      if (clip && ['SERVER_ONLY', 'COMPLETE'].includes(clip.status)) break;
      await sleep(250);
    }
    ok('the Clipper PC relayed the point and its clip reached the website', clip && ['SERVER_ONLY', 'COMPLETE'].includes(clip.status), clip && { status: clip.status, local: clip.local, error: clip.error, log: hLog.slice(-800) });
    if (clip && clip.watchUrl) {
      const vid = await call(port, 'GET', clip.watchUrl);
      const f = path.join(tmp, 'kill.mp4');
      fs.writeFileSync(f, vid.buf);
      const first = timeAt(f, 'first'), last = timeAt(f, 'last'), dur = duration(f);
      // the press is the TAP (the "Kill" chip); the attacker was named afterwards
      const pressSec = (tPress - W0) / 1000;
      ok(`the attacker was named ${((tAfter - tPress) / 1000).toFixed(1)} s after the tap — the clip still keys on the tap`, tAfter > tPress);
      ok(`the clip is 10 s long (${dur && dur.toFixed(2)} s): 7 s of the rally + 3 s after`, dur && Math.abs(dur - 10) < 0.8, dur);
      ok(`it starts 7 s before the press (first frame at ${first.toFixed(2)} s of the recording, press at ${pressSec.toFixed(2)} s)`, Math.abs(first - (pressSec - 7)) <= 1.2, { first, pressSec });
      ok(`it ends 3 s after the press (last frame at ${last.toFixed(2)} s)`, Math.abs(last - (pressSec + 3)) <= 1.2, { last, pressSec });
      eq('the clip belongs to the attacker (named after the point, by id)', clip.players.filter((p) => p.playerId === attacker).map((p) => p.role), ['attacker']);
      eq('…its attribution says so', [clip.attribution.type, clip.attribution.playerId], ['kill', attacker]);
    }
    await clipper.waitForSelector(`.clprow[data-ev="${killEv.eventId}"] .clipst:has-text("Ready")`, { timeout: 20000 }).then(() => ok('the Clipper page lists the clip with its real state', true), () => ok('the Clipper page lists the clip with its real state', false));
    ok('…with the attacker named and how the point was won', /#4/.test(await clipper.textContent(`.clprow[data-ev="${killEv.eventId}"] .whoc`)) && /Kill/.test(await clipper.textContent(`.clprow[data-ev="${killEv.eventId}"] .whoc`)));
    const hj = (await call(hPort, 'GET', `/clip-jobs/${MID}_${killEv.eventId}`)).json.job;
    ok('…and on the Clipper PC the file is named for the kill and linked into the attacker’s folder', hj && /_Kill_4-/.test(hj.localPath) && hj.links.some((l) => l.playerId === attacker), hj && { path: hj.localPath, links: hj.links });
    eq('every point the phone scored was clipped (the relay clips them all)', (await api('GET', `/api/volleyball/matches/${MID}/clips`)).json.clips.filter((c) => !c.eventVoided).length >= 4, true);
    await shot(clipper, 'clipper-clips');
    ok('the phone panel’s chip says the Clipper on the vMix PC is clipping', /Clipper page/.test(await panel.textContent('#clpChip')), await panel.textContent('#clpChip').catch(() => ''));

    /* ------------------------------------------------------------ rest of the match */
    head('REST OF THE MATCH — another device takes over; the panel follows');
    const take = await api('POST', `/api/volleyball/matches/${MID}/lease`, { json: { deviceId: 'laptop-2', force: true } });
    const lease = take.json.leaseToken;
    await panel.waitForSelector('.toast:has-text("Another device took control")', { timeout: 15000 }).then(() => ok('the phone is told at once that another device took control', true), () => ok('the phone is told at once that another device took control', false));
    let n = 0;
    const ev = (e) => api('POST', `/api/volleyball/matches/${MID}/events`, { json: { event: Object.assign({ eventId: 'api-' + (++n), at: Date.now() }, e) }, headers: { 'x-vb-lease': lease } });
    let mpSeen = false;
    for (let set = 1; set <= 3; set++) {
      if (set > 1) {
        await ev({ type: 'LINEUP', team: 'A', set, positions: six('A') });
        await ev({ type: 'LINEUP', team: 'B', set, positions: six('B') });
        await ev({ type: 'SET_START', set });
      }
      for (let guard = 0; guard < 80; guard++) {
        const cur = await sum();
        if (cur.status !== 'in_set') break;
        if (set === 3 && cur.points.A === 24 && !mpSeen) {
          await overlay.waitForFunction(() => document.querySelector('#pill').classList.contains('mp'), null, { timeout: 6000 }).then(() => { mpSeen = true; }, () => {});
          await shot(overlay, 'overlay-match-point');
        }
        await ev({ type: 'RALLY', winner: 'A', outcome: guard % 5 === 0 ? 'ATTACK_KILL' : 'GENERAL', players: guard % 5 === 0 ? { attacker: six('A')[2] } : undefined });
      }
    }
    ok('the overlay showed MATCH POINT at 24 in the third set', mpSeen);
    s = await sum();
    eq('the match is complete, 3–0 to Pune', [s.status, s.setsWon.A, s.setsWon.B, s.winner], ['completed', 3, 0, 'A']);
    await panel.waitForSelector('h2:has-text("Pune Panthers win")', { timeout: 15000 }).then(() => ok('the phone panel (view only) followed to the final result', true), () => ok('the phone panel (view only) followed to the final result', false));
    await overlay.waitForFunction(() => document.querySelector('#pill').classList.contains('win') && /win/i.test(document.querySelector('#pill').textContent), null, { timeout: 8000 }).then(() => ok('the overlay says who won, 3–0', true), () => ok('the overlay says who won, 3–0', false));
    eq('the bar shows the sets', await overlay.evaluate(() => [document.querySelector('#sa .n:last-child').textContent, document.querySelector('#sb .n:last-child').textContent, document.querySelector('#setname').textContent]), ['3', '0', 'Final']);
    await shot(overlay, 'overlay-final-bar');

    /* ------------------------------------------------------------ on-air graphics */
    head('ON-AIR GRAPHICS — taken in the panel, shown on the overlay, the score bar steps aside');
    const onAir = (page, scene) => page.waitForFunction((sc) => { const o = window.__vbOverlay; return o && o.state === 'GRAPHIC_VISIBLE' && o.onAir && o.onAir.scene === sc; }, scene, { timeout: 15000 }).then(() => true, () => false);
    const barOff = (page) => page.evaluate(() => ['#stage', '#pill', '#corner'].every((q) => { const e = document.querySelector(q); return getComputedStyle(e).visibility === 'hidden' || getComputedStyle(e).display === 'none'; }));
    const insideFrame = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#gfx .scene *')).every((e) => { const r = e.getBoundingClientRect(); return !r.width || !r.height || (r.left >= -0.5 && r.top >= -0.5 && r.right <= 1920.5 && r.bottom <= 1080.5); }));
    await panel.click('#gfxBtn');
    await panel.waitForSelector('.sheet #gfxBody .gtile', { timeout: 8000 });
    await panel.click('.sheet #gfxDur button[data-v="hold"]');
    for (const [scene, label] of [['intro', 'Match intro'], ['lineup', 'Starting six'], ['toss', 'Coin toss'], ['setSummary', 'Set result'], ['final', 'Match result'], ['scorecard', 'Match statistics'], ['standings', 'Points table'], ['playerStat', 'Player card']]) {
      if (scene === 'playerStat') await panel.click(`.sheet [data-ps="${attacker}"]`);
      else await panel.click(`.sheet .gmain[data-t="${scene}"]`);
      const shown = await onAir(overlay, scene);
      await sleep(400);
      ok(`${label}: on air, inside the frame, the score bar off air under it`, shown && await insideFrame(overlay) && await barOff(overlay), { shown });
      eq(`${label}: no team or player name cut short`, await clipped(overlay, '#gfx .scene [data-fit]'), []);
      ok(`${label}: the panel says it is on air — once the overlay has it up`, await panel.waitForFunction((l) => new RegExp(l + '.* is on air').test(document.querySelector('#gfxAir').textContent) && document.querySelector('#gfxAir .airbox.k-on'), label, { timeout: 5000 }).then(() => true, () => false), await panel.textContent('#gfxAir'));
      await shot(overlay, 'overlay-' + scene);
    }
    const pc = await overlay.textContent('#gfx .scene');
    ok('the player card shows the attacker’s real kills', /Kills/.test(pc) && new RegExp(M.squads.A.find((p) => p.playerId === attacker).name.split(' ').pop(), 'i').test(pc), pc.slice(0, 160));
    await panel.click('.sheet #gfxAir [data-a="stop"]');
    await overlay.waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE' && !document.querySelector('#gfx .scene'), null, { timeout: 12000 }).then(() => ok('“Dismiss · back to live” clears the graphic and the bar returns', true), () => ok('“Dismiss · back to live” clears the graphic and the bar returns', false));

    const compact = await open(`/volleyball-overlay?match=${MID}&layout=compact`, { who: null, helper: null, viewport: { width: 1920, height: 1080 } });
    await compact.waitForFunction(() => document.body.classList.contains('ready') && window.__vbOverlay.state === 'OVERLAY_VISIBLE', null, { timeout: 15000 });
    await backdrop(compact);
    eq('compact layout: the team names fit the corner bug', await clipped(compact, '.crow .cn'), []);
    await panel.click('.sheet .gmain[data-t="lineup"]');
    ok('compact layout: a graphic takes the corner bug off air, no bottom bar', await onAir(compact, 'lineup') && await barOff(compact));
    await shot(compact, 'overlay-compact-lineup');
    await panel.click('.sheet #gfxAir [data-a="stop"]');
    await panel.keyboard.press('Escape');

    /* ------------------------------------------------------------ report */
    head('PDF REPORT');
    let rep = null;
    for (let i = 0; i < 80; i++) { rep = (await api('GET', `/api/volleyball/matches/${MID}`)).json.match.report; if (rep && rep.status === 'ready') break; await sleep(200); }
    ok('the PDF report is made when the match ends', rep && rep.status === 'ready' && rep.version === 1, rep);
    const pdf = await call(port, 'GET', `/api/volleyball/matches/${MID}/report.pdf`);
    ok('…and it is a real PDF', pdf.status === 200 && pdf.buf.subarray(0, 5).toString() === '%PDF-', pdf.status);

    /* ------------------------------------------------------------ scorecard */
    head('SCORECARD — statistics, the attacker’s video icon, the report link');
    const sc = await open(`/volleyball/match/${MID}`, { who: null, helper: null, viewport: { width: 1280, height: 900 } });
    await sc.waitForSelector('.tbl', { timeout: 15000 });
    ok('the result is shown (3–0, Final)', /3\s*–\s*0/.test(await sc.textContent('.score')) && (await sc.locator('.badge.done:has-text("Final")').count()) === 1);
    ok('the PDF link is there because the PDF exists', await sc.locator('a:has-text("Match report (PDF")').count() === 1);
    const icon = sc.locator(`[data-clips="${attacker}"]`);
    ok('the attacker has a 🎬 icon with one clip', (await icon.count()) === 1 && /1/.test(await icon.textContent()));
    ok('…a player in no clipped point has none', (await sc.locator(`[data-clips="${six('B')[0]}"]`).count()) === 0);
    await icon.click();
    await sc.waitForSelector('.sheet video', { timeout: 8000 });
    const src = await sc.getAttribute('.sheet video', 'src');
    const vstat = await sc.evaluate((u) => fetch(u).then((r) => [r.status, r.headers.get('content-type')]), src);
    eq('…it opens that point’s clip, which plays from the website', vstat, [200, 'video/mp4']);
    await shot(sc, 'scorecard-player-clips');
    await sc.click('.sheet [data-close]');
    await sc.click('#tabs [data-t="points"]');
    await sc.waitForSelector('.rally');
    ok('point by point: the kill is listed with its clip', await sc.locator('.rally:has-text("Attack kill") [data-play]').count() >= 1);
    await shot(sc, 'scorecard-points');
    await sc.click('#tabs [data-t="card"]');
    await shot(sc, 'scorecard-light');
    const scDark = await open(`/volleyball/match/${MID}`, { who: null, helper: null, viewport: { width: 1280, height: 900 }, scheme: 'dark' });
    await scDark.waitForSelector('.tbl');
    await shot(scDark, 'scorecard-dark');
    const scPhone = await open(`/volleyball/match/${MID}`, { who: null, helper: null, viewport: { width: 390, height: 844 } });
    await scPhone.waitForSelector('.tbl');
    ok('the scorecard fits a 390 px phone (tables scroll inside their cards)', await noOverflow(scPhone));
    eq('…with both team names in full', await clipped(scPhone, '.side .nm'), []);
    await shot(scPhone, 'scorecard-phone');

    /* ------------------------------------------------------------ tournament page */
    head('TOURNAMENT PAGE — table, leaders, teams');
    const tp = await open(`/volleyball/tournament/${TID}`, { who: null, helper: null, viewport: { width: 1280, height: 900 } });
    await tp.waitForSelector('.m');
    ok('the result is listed (FT, 3–0)', /3–0/.test(await tp.textContent('.m .sc')));
    await tp.click('#tabs [data-t="table"]');
    await tp.waitForSelector('.tbl tbody tr');
    const top = await tp.evaluate(() => [...document.querySelector('.tbl tbody tr').querySelectorAll('td')].map((d) => d.textContent.trim()));
    eq('the table: Pune first — 1 played, 1 won, 3 points (3-2-1-0), sets 3:0', [top[1].includes('Pune'), top[2], top[3], top[5], top[6]], [true, '1', '1', '3', '3:0']);
    ok('the table names the points policy (3-0 / 3-1 win: 3 …), not "Custom"', /3-0 \/ 3-1 win: 3/.test(await tp.textContent('#tab .card.flat')));
    await shot(tp, 'tournament-table');
    await tp.click('#tabs [data-t="leaders"]');
    await tp.waitForSelector('.lb');
    ok('leaders: the kills board lists the attacker who scored them', /Pune Player/.test(await tp.textContent('.lb:has(h3:has-text("Attack kills"))')));
    await shot(tp, 'tournament-leaders');
    await tp.click('#tabs [data-t="teams"]');
    await tp.click('#hgo');
    await tp.waitForSelector('#hout p');
    ok('head-to-head: Pune 1 – 0 Goa', /Pune Panthers 1 – 0 Goa Waves/.test(await tp.textContent('#hout')));
    const tpPhone = await open(`/volleyball/tournament/${TID}`, { who: null, helper: null, viewport: { width: 390, height: 844 } });
    await tpPhone.waitForSelector('.m');
    ok('the tournament page fits a 390 px phone', await noOverflow(tpPhone));
    await shot(tpPhone, 'tournament-phone');

    head('PAGE ERRORS');
    eq('no uncaught error on any page', pageErrors, []);
  } catch (e) {
    fails.push('crashed: ' + (e.stack || e));
    console.log(e.stack || e);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await browser.close().catch(() => {});
    if (helperProc) helperProc.kill('SIGKILL');
    if (recProc) recProc.kill('SIGKILL');
  }
  console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ':\n  - ' + fails.join('\n  - ') : ''}`);
  console.log('screenshots: ' + OUT);
  process.exit(fails.length ? 1 : 0);
})();
