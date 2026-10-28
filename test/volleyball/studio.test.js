/* 🎬 The volleyball graphics studio (/volleyball-templates) and the scoring
   panel's graphics controls, in Chromium against the REAL server:

     • signed out: the templates, explained — no match data, no controls
     • PREVIEW is not ON AIR: picking a template changes the preview only;
       "Take to air" changes what the real overlay shows; Dismiss brings the
       live score back
     • a graphic with nothing true to show says why (no time-out running)
     • the look: edited in the preview at once, on air only once saved —
       then every overlay of the tournament follows it; times on screen too
     • a team's colours saved here reach the live overlay at once
     • the panel: the on-air chip counts down, its sheet takes / dismisses,
       the links sheet never grows sideways (screenshot 1 of the report)
     • ON AIR is the outputs' word: with no programme output (the studio's
       own monitor does not count) the studio says nothing shows it; a
       card goes "Taking to air…" → "● ON AIR" only once a real output
       (a vMix-like overlay page) has it up
     • the live overlay by hand, from the studio and from the panel: take
       the score bar off air (a point does not bring it back), the corner
       bug on air, hide everything / restore, Automatic again — each
       checked on the real output page
     • the time on screen: 10 s ends by itself; an unavailable card says why
     • no page error; no sideways scrolling at desktop or phone width

     NODE_PATH=$(npm root -g) node test/volleyball/studio.test.js
   Screenshots: test/out/volleyball/studio-*.png
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { bootServer } = require('../server-boot.js');

const OUT = path.join(__dirname, '..', 'out', 'volleyball');
fs.mkdirSync(OUT, { recursive: true });
let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
const head = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const U = { uid: 'u-work', email: 'workallsportslive@gmail.com', email_verified: true };
async function until(fn, ms) { const end = Date.now() + (ms || 8000); while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(60); } return null; }
const FAKE_FIREBASE = `(function(){
  if (window.firebase) return;
  var u = window.__fakeUser || null;
  var cur = u ? { email: u.email, uid: u.uid, getIdToken: function(){ return Promise.resolve(u.token); } } : null;
  var authObj = { currentUser: cur, onAuthStateChanged: function(cb){ setTimeout(function(){ cb(cur); }, 0); return function(){}; }, onIdTokenChanged: function(cb){ setTimeout(function(){ cb(cur); }, 0); return function(){}; },
    signInWithPopup: function(){ window.__signInClicked = true; return Promise.reject({}); }, signInWithRedirect: function(){ return Promise.resolve(); }, getRedirectResult: function(){ return Promise.resolve({ user: null }); }, signOut: function(){ return Promise.resolve(); } };
  var auth = function(){ return authObj; }; auth.GoogleAuthProvider = function(){ this.setCustomParameters = function(){}; };
  window.firebase = { apps: [], initializeApp: function(){ window.firebase.apps.push({}); return {}; }, auth: auth };
})();`;

(async () => {
  const { port } = await bootServer({ idTokens: { tok: U }, users: { 'u-work': U.email } });
  const base = `http://127.0.0.1:${port}`;
  const api = (m, u, o) => call(port, m, u, Object.assign({ token: 'tok' }, o || {}));
  const browser = await chromium.launch();
  const errors = [];
  async function open(url, { signedIn = true, viewport = { width: 1440, height: 950 } } = {}) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await page.addInitScript((u) => { window.__fakeUser = u; }, signedIn ? { email: U.email, uid: U.uid, token: 'tok' } : null);
    await page.route('https://www.gstatic.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_FIREBASE }));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('http://127.0.0.1:5006/**', (r) => r.abort());
    page.on('pageerror', (e) => errors.push(url.split('?')[0] + ': ' + String(e)));
    await page.goto(base + url);
    return { ctx, page };
  }
  const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  try {
    const mk = (name, short, color) => api('POST', '/api/volleyball/teams', { json: { name, shortName: short, colors: { primary: color, secondary: '#0a1136', text: '#ffffff' },
      players: Array.from({ length: 8 }, (_, i) => ({ name: `${short} Player ${i + 1}`, number: String(i + 1), role: ['S', 'OH', 'OH', 'MB', 'MB', 'OPP', 'DS', 'L'][i], libero: i === 7 })) } }).then((r) => r.json.team);
    const A = await mk('Pune Panthers', 'PUN', '#c81e1e'), B = await mk('Goa Waves', 'GOA', '#1d4ed8');
    const T = (await api('POST', '/api/volleyball/tournaments', { json: { name: 'Studio Cup', teamIds: [A.teamId, B.teamId] } })).json.tournament;
    const M = (await api('POST', `/api/volleyball/tournaments/${T.tournamentId}/matches`, { json: { teamA: A.teamId, teamB: B.teamId } })).json.match;
    const lease = (await api('POST', `/api/volleyball/matches/${M.matchId}/lease`, { json: { deviceId: 'studio-test' } })).json.leaseToken;
    let n = 0;
    const ev = (e) => api('POST', `/api/volleyball/matches/${M.matchId}/events`, { json: { event: Object.assign({ eventId: 's' + (++n), at: Date.now() }, e) }, headers: { 'x-vb-lease': lease } }).then((r) => r.json);
    const six = (t) => t.players.filter((p) => !p.libero).slice(0, 6).map((p) => p.playerId);
    await ev({ type: 'TOSS', winner: 'A', choice: 'serve', leftSide: 'A' });
    await ev({ type: 'LINEUP', team: 'A', set: 1, positions: six(A) });
    await ev({ type: 'LINEUP', team: 'B', set: 1, positions: six(B) });
    await ev({ type: 'SET_START', set: 1 });
    for (let i = 0; i < 4; i++) await ev({ type: 'RALLY', winner: i % 2 ? 'B' : 'A', outcome: 'GENERAL' });

    head('SIGNED OUT');
    let { ctx, page } = await open('/volleyball-templates', { signedIn: false });
    await page.waitForSelector('.gate', { timeout: 10000 });
    ok('the templates are explained, all of them', (await page.$$('.tpl')).length === 13);
    ok('…with no match data and no controls', !(await page.$('#take')) && !(await page.$('iframe')));
    await ctx.close();

    head('PREVIEW IS NOT ON AIR');
    ({ ctx, page } = await open(`/volleyball-templates?match=${M.matchId}`));
    await page.waitForSelector('#pvFrame', { timeout: 15000 });
    const pv = () => page.frame({ url: /preview=1/ });
    const pg = () => page.frames().find((f) => /volleyball-overlay/.test(f.url()) && !/preview=1/.test(f.url()));
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 2, null, { timeout: 10000 });
    await sleep(500);
    const air = (f, s) => f.waitForFunction((s) => window.__vbOverlay && window.__vbOverlay.state === s, s, { timeout: 15000 }).then(() => true, () => false);
    ok('the on-air monitor shows the live score bar', await air(pg(), 'OVERLAY_VISIBLE'));
    ok('the preview shows the live score bar too', await air(pv(), 'OVERLAY_VISIBLE'));
    ok('the gallery: every template, with what the match has', (await page.$$('.tpl')).length === 13 && /Line-ups saved/.test(await page.textContent('.tpl[data-k="lineup"]')));
    await page.click('.tpl[data-k="lineup"]');
    ok('picking "Starting six" plays it in the preview', await pv().waitForFunction(() => window.__vbOverlay.state === 'GRAPHIC_VISIBLE' && window.__vbOverlay.onAir.scene === 'lineup', null, { timeout: 15000 }).then(() => true, () => false));
    ok('…and leaves the air alone', (await pg().evaluate(() => window.__vbOverlay.state)) === 'OVERLAY_VISIBLE' && (await api('GET', `/api/volleyball/matches/${M.matchId}`)).json.match.graphic.scene === null);
    ok('…the preview overlay never offers its state as on air', await pv().evaluate(() => window.__vbOverlay.O.preview === true));
    await page.screenshot({ path: path.join(OUT, 'studio-preview.png') });
    await page.click('#take');
    ok('Take to air: the real overlay shows it', await pg().waitForFunction(() => window.__vbOverlay.state === 'GRAPHIC_VISIBLE' && window.__vbOverlay.onAir.scene === 'lineup', null, { timeout: 15000 }).then(() => true, () => false));
    ok('…the server says so', (await api('GET', `/api/volleyball/matches/${M.matchId}`)).json.match.graphic.scene === 'lineup');
    ok('…and the studio marks it on air with its time left', await page.waitForFunction(() => /Starting six.*is on air/.test(document.querySelector('#airBox').textContent) && /\d+ s/.test(document.querySelector('#airBox').textContent), null, { timeout: 8000 }).then(() => true, () => false));
    ok('…saying that no programme output shows it — its own ON AIR monitor does not count', /No overlay output is connected/.test(await page.textContent('#airBox')) && /1 monitor \(not counted\)/.test(await page.textContent('#airBox')) && /monitor=1/.test(await page.getAttribute('#pgFrame', 'src')), await page.textContent('#airBox'));
    await page.screenshot({ path: path.join(OUT, 'studio-onair.png') });
    await page.click('#airBox [data-a="stop"]');
    ok('Dismiss: the live score returns on air', await air(pg(), 'OVERLAY_VISIBLE'));

    head('NOTHING UNTRUE');
    await page.click('.tpl[data-k="timeout"]');
    ok('the time-out with none running: the preview says why', await page.waitForFunction(() => !document.querySelector('#pvNote').classList.contains('hide') && /No time-out is running/.test(document.querySelector('#pvNote').textContent), null, { timeout: 10000 }).then(() => true, () => false));
    await page.click('#take');
    ok('…and taking it is refused with the server\'s reason', await page.waitForSelector('.toast:has-text("No time-out is running")', { timeout: 8000 }).then(() => true, () => false));

    head('THE LOOK');
    await page.click('.tpl[data-k="intro"]');
    await pv().waitForFunction(() => window.__vbOverlay.state === 'GRAPHIC_VISIBLE', null, { timeout: 15000 });
    await page.$eval('#lAcc', (e) => { e.value = '#00c2ff'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    const accOf = (f) => f.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--acc').trim());
    ok('a new accent shows in the preview at once', await pv().waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() === 'rgb(0,194,255)', null, { timeout: 5000 }).then(() => true, () => false), await accOf(pv()));
    ok('…not on air yet ("not saved")', (await accOf(pg())) !== 'rgb(0,194,255)' && await page.isVisible('#dirty'));
    await page.fill('[data-d="toss"]', '6');
    await page.dispatchEvent('[data-d="toss"]', 'change');
    await page.click('#saveLook');
    ok('saved: the overlay on air follows it', await pg().waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() === 'rgb(0,194,255)', null, { timeout: 8000 }).then(() => true, () => false), await accOf(pg()));
    const tb = (await api('GET', `/api/volleyball/tournaments/${T.tournamentId}`)).json.tournament.broadcast;
    ok('…kept on the tournament (accent, the toss\'s 6 s)', tb.accent === '#00c2ff' && tb.durations.toss === 6, tb);
    await page.click('.tpl[data-k="toss"]');
    await page.click('#take');
    await sleep(800);
    const g = (await api('GET', `/api/volleyball/matches/${M.matchId}`)).json.match.graphic;
    ok('a graphic taken without a time uses the tournament\'s (6 s)', g.scene === 'toss' && g.durationSec === 6, g);
    ok('…and goes by itself', await pg().waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE', null, { timeout: 15000 }).then(() => true, () => false));

    head('TEAMS');
    const cardA = `#teams [data-team="${A.teamId}"]`;
    await page.$eval(`${cardA} [data-c="primary"]`, (e) => { e.value = '#16a34a'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click(`${cardA} [data-save]`);
    ok('a team colour saved here reaches the live overlay at once', await pg().waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ca').trim() === 'rgb(22,163,74)', null, { timeout: 8000 }).then(() => true, () => false));
    head('THE STUDIO — THE LIVE OVERLAY BY HAND, on a real output');
    // a programme output, like vMix: the overlay link in a window of its own
    let { ctx: progCtx, page: prog } = await open(`/volleyball-overlay?match=${M.matchId}`, { signedIn: false, viewport: { width: 1920, height: 1080 } });
    const progAir = (st) => prog.waitForFunction((x) => window.__vbOverlay && window.__vbOverlay.state === x, st, { timeout: 12000 }).then(() => true, () => false);
    ok('the output shows the score bar', await progAir('OVERLAY_VISIBLE'));
    ok('the studio: "Live score bar is on air" — from that output', await page.waitForFunction(() => /Live score bar is on air/.test(document.querySelector('#airBox').textContent) && document.querySelector('#airBox .airbox.k-live'), null, { timeout: 10000 }).then(() => true, () => false), await page.textContent('#airBox'));
    ok('…its card: ● ON AIR · Automatic', /● ON AIR · Automatic/.test(await page.textContent('.tpl[data-k="bar"] .st')), await page.textContent('.tpl[data-k="bar"] .st'));
    await page.click('.tpl[data-k="bar"]');
    await page.click('#selAct #lvOff');
    ok('TAKE OFF AIR from the studio: the output takes the bar off', await progAir('IDLE'));
    ok('…the card says OFF AIR, the mode Manual', await page.waitForFunction(() => /OFF AIR/.test(document.querySelector('.tpl[data-k="bar"] .st').textContent) && document.querySelector('#oMode [data-m="manual"]').getAttribute('aria-pressed') === 'true', null, { timeout: 8000 }).then(() => true, () => false));
    ok('…and the server keeps it', (await api('GET', `/api/volleyball/matches/${M.matchId}`)).json.match.graphic.live.layout === null);
    await ev({ type: 'RALLY', winner: 'B', outcome: 'GENERAL' });
    await sleep(1500);
    ok('…a point scored does not bring it back', (await prog.evaluate(() => window.__vbOverlay.state)) === 'IDLE');
    await page.click('.tpl[data-k="compact"]');
    await page.click('#selAct #lvOn');
    ok('TAKE ON AIR the corner bug: the output shows the corner bug', await prog.waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE' && window.__vbOverlay.C.barLayout === 'compact', null, { timeout: 12000 }).then(() => true, () => false));
    ok('…the studio\'s ON AIR monitor shows the same', await pg().waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE' && window.__vbOverlay.C.barLayout === 'compact', null, { timeout: 12000 }).then(() => true, () => false));
    ok('…its card: ● ON AIR · Manual', await page.waitForFunction(() => /● ON AIR · Manual/.test(document.querySelector('.tpl[data-k="compact"] .st').textContent), null, { timeout: 8000 }).then(() => true, () => false), await page.textContent('.tpl[data-k="compact"] .st'));
    await page.screenshot({ path: path.join(OUT, 'studio-live-corner.png') });
    await page.click('#airBox [data-a="clean"]');
    ok('HIDE EVERYTHING: the output shows nothing', await progAir('IDLE'));
    ok('…"Everything is hidden" with Restore live overlay', await page.waitForFunction(() => /Everything is hidden/.test(document.querySelector('#airBox').textContent) && document.querySelector('#airBox [data-a="live"]'), null, { timeout: 8000 }).then(() => true, () => false));
    await page.click('#airBox [data-a="live"]');
    ok('RESTORE LIVE OVERLAY: the corner bug again', await prog.waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE' && window.__vbOverlay.C.barLayout === 'compact', null, { timeout: 12000 }).then(() => true, () => false));
    await page.click('#oMode [data-m="auto"]');
    ok('AUTOMATIC: the tournament\'s score bar again', await prog.waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE' && window.__vbOverlay.C.barLayout === 'bar', null, { timeout: 15000 }).then(() => true, () => false));

    ok('no sideways scrolling (desktop)', await noSideways(page));
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(400);
    ok('…nor at phone width', await noSideways(page));
    await page.screenshot({ path: path.join(OUT, 'studio-phone.png'), fullPage: false });
    await ctx.close();

    head('THE PANEL\'S CONTROLS');
    ({ ctx, page } = await open(`/volleyball-panel?match=${M.matchId}`));
    await page.waitForSelector('#air', { timeout: 15000 });
    ok('the chip says the live score is on air', /Live score/.test(await page.textContent('#air')));
    await page.click('#gfxBtn');
    await page.waitForSelector('#gfxBody .gtile', { timeout: 8000 });
    await page.click('#gfxDur button[data-v="hold"]');
    await page.click('#gfxBody [data-t="intro"]');
    ok('take from the panel: ON AIR in its sheet (the output has it up)', await page.waitForFunction(() => /Match intro is on air/.test(document.querySelector('#gfxAir').textContent) && document.querySelector('#gfxAir .airbox.k-on'), null, { timeout: 12000 }).then(() => true, () => false), await page.textContent('#gfxAir'));
    ok('…held (no count-down)', /held until dismissed/.test(await page.textContent('#gfxAir')));
    ok('…and on the chip', /On air · Match intro · hold/.test(await page.textContent('#air')));
    ok('…its card says ● ON AIR, with a Take off', /● ON AIR/.test(await page.textContent('.gtile[data-sc="intro"]')) && !!(await page.$('.gtile[data-sc="intro"] [data-off]')));
    await page.click('.gtile[data-sc="intro"] .gmain');
    ok('…pressing it again does not take it twice ("already on air")', await page.waitForSelector('.toast:has-text("already on air")', { timeout: 5000 }).then(() => true, () => false));
    await page.click('#gfxAir [data-a="stop"]');
    ok('dismissed: back to live', await page.waitForFunction(() => /Live score bar is on air/.test(document.querySelector('#gfxAir').textContent), null, { timeout: 12000 }).then(() => true, () => false), await page.textContent('#gfxAir'));
    ok('…on the real output too', await progAir('OVERLAY_VISIBLE'));

    // time on screen: 10 s — "Taking to air…" first, ● ON AIR once the output has it, then it goes by itself
    await page.click('#gfxDur button[data-v="10"]');
    await page.evaluate(() => { window.__tossSeq = []; setInterval(() => { const t = document.querySelector('.gtile[data-sc="toss"]'); const k = t ? (t.className.match(/s-(\w+)/) || [])[1] : null; if (k && window.__tossSeq[window.__tossSeq.length - 1] !== k) window.__tossSeq.push(k); }, 30); });
    await page.click('.gtile[data-sc="toss"] .gmain');
    ok('TIME ON SCREEN 10 s: the toss is taken for 10 s', await until(async () => { const gg = (await api('GET', `/api/volleyball/matches/${M.matchId}`)).json.match.graphic; return gg.scene === 'toss' && gg.durationSec === 10; }));
    ok('…on the real output', await prog.waitForFunction(() => window.__vbOverlay.state === 'GRAPHIC_VISIBLE' && window.__vbOverlay.onAir.scene === 'toss', null, { timeout: 12000 }).then(() => true, () => false));
    await page.waitForFunction(() => document.querySelector('.gtile[data-sc="toss"].s-on'), null, { timeout: 8000 }).catch(() => {});
    const seq1 = await page.evaluate(() => window.__tossSeq.slice());
    ok('…its card: Taking to air → ● ON AIR (never ON AIR before the output had it)', seq1.indexOf('taking') >= 0 && seq1.indexOf('on') > seq1.indexOf('taking'), seq1);
    ok('…counting down', /\d+ s left/.test(await page.textContent('.gtile[data-sc="toss"]')));
    ok('…and it goes by itself after its 10 s — the bar back on the output', await prog.waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE', null, { timeout: 20000 }).then(() => true, () => false));
    ok('…the card ready again', await page.waitForFunction(() => document.querySelector('.gtile[data-sc="toss"].s-ready'), null, { timeout: 8000 }).then(() => true, () => false), await page.evaluate(() => window.__tossSeq.slice()));
    await page.click('#gfxDur button[data-v="hold"]');
    ok('an unavailable card says why (no time-out running) and takes nothing', !!(await page.$('.gtile.s-na[data-sc="timeout"]')));
    await page.click('.gtile[data-sc="timeout"] .gmain', { force: true });   // aria-disabled: a person can still press it
    ok('…pressed: the reason, nothing on air', await page.waitForSelector('.toast:has-text("time-out")', { timeout: 5000 }).then(() => true, () => false) && (await api('GET', `/api/volleyball/matches/${M.matchId}`)).json.match.graphic.scene === null);

    // the player card: the last point's credited player, else the roster
    await page.click('.gtile[data-sc="playerStat"] .gmain');
    ok('PLAYER CARD with nobody credited for the last point: it asks for the player (the roster below)', await page.waitForSelector('.toast:has-text("Choose the player")', { timeout: 5000 }).then(() => true, () => false) && (await api('GET', `/api/volleyball/matches/${M.matchId}`)).json.match.graphic.scene === null);
    const killer = A.players.find((p) => p.playerId === six(A)[2]);
    await ev({ type: 'RALLY', winner: 'A', outcome: 'ATTACK_KILL', players: { attacker: killer.playerId } });
    ok('…a named kill: the card offers that player', await page.waitForFunction((n) => document.querySelector('.gtile[data-sc="playerStat"]').textContent.includes('Last point: #' + n), killer.number, { timeout: 8000 }).then(() => true, () => false), await page.textContent('.gtile[data-sc="playerStat"]'));
    await page.click('.gtile[data-sc="playerStat"] .gmain');
    ok('…pressed: that player\'s card on the real output', await prog.waitForFunction((pid) => window.__vbOverlay.state === 'GRAPHIC_VISIBLE' && window.__vbOverlay.onAir.scene === 'playerStat' && window.__vbOverlay.onAir.data.playerId === pid, killer.playerId, { timeout: 12000 }).then(() => true, () => false));
    await page.click('#gfxAir [data-a="stop"]');
    ok('…dismissed', await progAir('OVERLAY_VISIBLE'));

    head('THE PANEL — THE LIVE OVERLAY BY HAND');
    const lvst = (lay) => page.textContent(`#gfxLive .lvcard[data-lay="${lay}"] .lvst`);
    ok('the score bar card: ● ON AIR (the output has it up) · the corner bug: OFF AIR', await page.waitForFunction(() => /^● ON AIR$/.test(document.querySelector('#gfxLive .lvcard[data-lay="bar"] .lvst').textContent), null, { timeout: 8000 }).then(() => true, () => false) && /OFF AIR/.test(await lvst('compact')), [await lvst('bar'), await lvst('compact')]);
    await page.screenshot({ path: path.join(OUT, 'studio-panel-live.png') });
    await page.click('#gfxLive [data-lv="off"][data-lay="bar"]');
    ok('TAKE OFF AIR the score bar: the output takes it off', await progAir('IDLE'));
    ok('…the card says OFF AIR, Manual', await page.waitForFunction(() => /OFF AIR/.test(document.querySelector('#gfxLive .lvcard[data-lay="bar"] .lvst').textContent) && document.querySelector('#lvMode [data-m="manual"]').getAttribute('aria-pressed') === 'true', null, { timeout: 8000 }).then(() => true, () => false));
    await ev({ type: 'RALLY', winner: 'A', outcome: 'GENERAL' });
    await sleep(1500);
    ok('…a point scored does not bring it back', (await prog.evaluate(() => window.__vbOverlay.state)) === 'IDLE');
    await page.click('#gfxLive [data-lv="on"][data-lay="compact"]');
    ok('TAKE ON AIR the corner bug: the output shows the corner bug', await prog.waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE' && window.__vbOverlay.C.barLayout === 'compact', null, { timeout: 12000 }).then(() => true, () => false));
    ok('…its card ● ON AIR', await page.waitForFunction(() => /^● ON AIR$/.test(document.querySelector('#gfxLive .lvcard[data-lay="compact"] .lvst').textContent), null, { timeout: 8000 }).then(() => true, () => false), await lvst('compact'));
    await page.reload();
    await page.waitForSelector('#air', { timeout: 15000 });
    await page.click('#gfxBtn');
    ok('A RELOADED PANEL reconciles with the output: the corner bug ● ON AIR, the bar OFF AIR, Manual', await page.waitForFunction(() => { const st = (l) => document.querySelector(`#gfxLive .lvcard[data-lay="${l}"] .lvst`); return st('compact') && /^● ON AIR$/.test(st('compact').textContent) && /OFF AIR/.test(st('bar').textContent) && document.querySelector('#lvMode [data-m="manual"]').getAttribute('aria-pressed') === 'true'; }, null, { timeout: 12000 }).then(() => true, () => false));
    ok('…and the output was not touched by the reload', (await prog.evaluate(() => window.__vbOverlay.state)) === 'OVERLAY_VISIBLE' && (await prog.evaluate(() => window.__vbOverlay.C.barLayout)) === 'compact');
    await page.click('#gfxAir [data-a="clean"]');
    ok('HIDE EVERYTHING from the panel: the output shows nothing', await progAir('IDLE'));
    ok('…"Everything is hidden", with Restore live overlay', await page.waitForFunction(() => /Everything is hidden/.test(document.querySelector('#gfxAir').textContent) && document.querySelector('#gfxAir [data-a="live"]'), null, { timeout: 8000 }).then(() => true, () => false));
    await page.click('#gfxAir [data-a="live"]');
    ok('RESTORE: the corner bug again', await prog.waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE' && window.__vbOverlay.C.barLayout === 'compact', null, { timeout: 12000 }).then(() => true, () => false));
    await page.click('#lvMode [data-m="auto"]');
    ok('AUTOMATIC: the tournament\'s score bar', await prog.waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE' && window.__vbOverlay.C.barLayout === 'bar', null, { timeout: 15000 }).then(() => true, () => false));
    await progCtx.close();
    ok('the output closed: the panel says no output shows anything', await page.waitForFunction(() => /No overlay output/.test(document.querySelector('#gfxAir').textContent), null, { timeout: 12000 }).then(() => true, () => false), await page.textContent('#gfxAir'));
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(400);
    ok('the graphics sheet never grows sideways at phone width', await page.evaluate(() => { const sh = document.querySelector('.sheet'); return sh.scrollWidth <= sh.clientWidth + 1; }));
    await page.screenshot({ path: path.join(OUT, 'studio-panel-gfx-phone.png') });
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#moreBtn');
    await page.waitForSelector('.linkrow', { timeout: 5000 });
    await sleep(400);
    ok('the links sheet never grows sideways at phone width', await page.evaluate(() => { const sh = document.querySelector('.sheet'); return sh.scrollWidth <= sh.clientWidth + 1; }));
    await page.screenshot({ path: path.join(OUT, 'studio-panel-links-phone.png') });
    await ctx.close();
    ok('no uncaught page error', errors.length === 0, errors);
  } catch (e) {
    fails.push('crashed: ' + (e.stack || e));
    console.log(e.stack || e);
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ':\n  - ' + fails.join('\n  - ') : ''}`);
  process.exit(fails.length ? 1 : 0);
})();
