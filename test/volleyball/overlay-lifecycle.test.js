/* 🎬 The volleyball overlay's graphics controller in Chromium at 1920×1080,
   against the REAL server (in-memory MongoDB, test tokens) — what vMix /
   OBS would show, frame by frame:

     • a standalone graphic never sits on the score bar: every animation
       frame is sampled, and a frame with a graphic mounted while any part
       of the bar (or its status pill) is visible is a failure
     • the bar leaves first; when the graphic ends (dismissed, timed out,
       replaced by nothing) the bar comes back ONCE, with the score as it
       is NOW (points scored meanwhile included)
     • a timed graphic goes by itself; a held one stays
     • rapid takes: only ever one graphic mounted, the last one wins;
       pressing the same graphic again changes nothing
     • an entrance that is overtaken plays back — no jump, no flash
     • a reload (or a vMix restart) in the middle of a graphic shows it as
       it is, never the bar first and never its whole entrance again
     • the server unreachable: a timed graphic still ends on time and the
       bar returns — once — and stays right when the server is back
     • hide everything, graphics-only and corner layouts; the time-out
       graphic goes when the next rally is scored; the starting six hands
       over from team one to team two
     • the live overlay by hand: taken off air it plays its exit and no
       point, timer or graphic brings it back; the corner bug replaces the
       score bar (the bar leaves, then the bug comes in — never both, never
       a cut); Automatic ⇄ Manual without a flash; what each output shows
       is reported to the server
     • vMix safety: transparent page, no color-mix / :has / container
       queries / flex gap; no animations left running afterwards

     NODE_PATH=$(npm root -g) node test/volleyball/overlay-lifecycle.test.js
   Screenshots: test/out/volleyball/lifecycle-*.png
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { bootServer } = require('../server-boot.js');
const { connectVb } = require('./vb-socket.js');

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
async function until(fn, ms) { const end = Date.now() + (ms || 8000); while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(40); } return null; }

// Installed in the page: every animation frame, is a graphic mounted while
// the score bar (any part of it) is visible? More than one graphic mounted?
const SAMPLER = () => {
  window.__vio = []; window.__frames = 0; window.__maxScenes = 0;
  // the live overlay itself: frames with the bar / the corner bug on screen, both at once, each seen leaving
  window.__lv = { both: 0, stage: 0, corner: 0, exitStage: 0, exitCorner: 0 };
  const vis = (el) => !!el && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  (function loop() {
    const o = window.__vbOverlay;
    if (o) {
      window.__frames++;
      const st = vis(document.getElementById('stage')), co = vis(document.getElementById('corner')), lv = window.__lv;
      if (st && co) lv.both++;
      if (st) lv.stage++;
      if (co) lv.corner++;
      if (o.state === 'OVERLAY_EXITING') { if (st) lv.exitStage++; if (co) lv.exitCorner++; }
      const scenes = document.querySelectorAll('#gfx .scene').length;
      window.__maxScenes = Math.max(window.__maxScenes, scenes);
      const barOn = vis(document.getElementById('stage')) || vis(document.getElementById('pill')) || vis(document.getElementById('corner')) || vis(document.getElementById('tagL')) || vis(document.getElementById('tagR'));
      if (scenes && barOn && window.__vio.length < 20) window.__vio.push({ state: o.state, scenes, t: Math.round(performance.now()) });
    }
    requestAnimationFrame(loop);
  })();
};

(async () => {
  const { port, mem } = await bootServer({ idTokens: { tok: U }, users: { 'u-work': U.email } });
  const api = (m, u, o) => call(port, m, u, Object.assign({ token: 'tok' }, o || {}));
  const browser = await chromium.launch();
  const errors = [];
  try {
    const mk = (name, short, color) => api('POST', '/api/volleyball/teams', { json: { name, shortName: short, colors: { primary: color, secondary: '#0a1136', text: '#ffffff' },
      players: Array.from({ length: 8 }, (_, i) => ({ name: `${short} Player ${i + 1}`, number: String(i + 1), role: ['S', 'OH', 'OH', 'MB', 'MB', 'OPP', 'DS', 'L'][i], libero: i === 7, captain: i === 0 })) } }).then((r) => r.json.team);
    const A = await mk('Pune Panthers', 'PUN', '#c81e1e'), B = await mk('Goa Waves', 'GOA', '#1d4ed8');
    const T = (await api('POST', '/api/volleyball/tournaments', { json: { name: 'Lifecycle Cup', teamIds: [A.teamId, B.teamId] } })).json.tournament;
    const M = (await api('POST', `/api/volleyball/tournaments/${T.tournamentId}/matches`, { json: { teamA: A.teamId, teamB: B.teamId, venue: 'Balewadi Stadium' } })).json.match;
    const lease = (await api('POST', `/api/volleyball/matches/${M.matchId}/lease`, { json: { deviceId: 'd' } })).json.leaseToken;
    let n = 0;
    const ev = (e) => api('POST', `/api/volleyball/matches/${M.matchId}/events`, { json: { event: Object.assign({ eventId: 'e' + (++n), at: Date.now() }, e) }, headers: { 'x-vb-lease': lease } }).then((r) => r.json);
    const six = (t) => t.players.filter((p) => !p.libero).slice(0, 6).map((p) => p.playerId);
    await ev({ type: 'TOSS', winner: 'B', choice: 'receive', leftSide: 'A' });
    await ev({ type: 'LINEUP', team: 'A', set: 1, positions: six(A) });
    await ev({ type: 'LINEUP', team: 'B', set: 1, positions: six(B) });
    await ev({ type: 'SET_START', set: 1 });
    for (let i = 0; i < 6; i++) await ev({ type: 'RALLY', winner: i % 3 ? 'A' : 'B', outcome: 'GENERAL' });
    const op = await connectVb(port, { idToken: 'tok' });
    const take = (scene, data, durationSec) => op.emitAck('vb:graphic', Object.assign({ matchId: M.matchId, action: 'take', scene, data: data || {} }, durationSec !== undefined ? { durationSec } : {}));
    const cmd = (action, extra) => op.emitAck('vb:graphic', Object.assign({ matchId: M.matchId, action }, extra || {}));
    const score = async () => (await api('GET', `/api/volleyball/matches/${M.matchId}?timeline=1`)).json.summary;

    async function openOverlay(q) {
      const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await ctx.newPage();
      await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_FAILED/.test(m.text())) errors.push('console: ' + m.text()); });
      await page.addInitScript(SAMPLER);
      await page.goto(`http://127.0.0.1:${port}/volleyball-overlay?match=${M.matchId}${q || ''}`);
      return { ctx, page };
    }
    const state = (page) => page.evaluate(() => window.__vbOverlay && window.__vbOverlay.state);
    const waitState = (page, s, ms) => page.waitForFunction((s) => window.__vbOverlay && window.__vbOverlay.state === s, s, { timeout: ms || 12000 }).then(() => true, () => false);
    const waitOnAir = (page, id, ms) => page.waitForFunction((id) => { const o = window.__vbOverlay; return o && o.state === 'GRAPHIC_VISIBLE' && o.onAir && o.onAir.id === id; }, id, { timeout: ms || 12000 }).then(() => true, () => false);
    const counts = (page) => page.evaluate(() => Object.assign({}, window.__vbOverlay.counts));
    const history = (page) => page.evaluate(() => window.__vbOverlay.C.history.map((h) => h.s));
    const bars = (page) => page.evaluate(() => ({ a: document.querySelector('#pa .roll .n:last-child').textContent, b: document.querySelector('#pb .roll .n:last-child').textContent, sa: document.querySelector('#sa .roll .n:last-child').textContent }));
    const violations = (page) => page.evaluate(() => ({ vio: window.__vio, frames: window.__frames, max: window.__maxScenes }));

    head('START-UP: the live score bar comes in');
    let { ctx, page } = await openOverlay();
    ok('the bar comes in (OVERLAY_ENTERING → OVERLAY_VISIBLE)', await waitState(page, 'OVERLAY_VISIBLE'), await state(page));
    ok('…by its own entrance', (await history(page)).slice(0, 2).join() === 'OVERLAY_ENTERING,OVERLAY_VISIBLE', await history(page));
    const tr = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
    ok('the page is transparent (html, body)', tr.every((c) => c === 'rgba(0, 0, 0, 0)'), tr);
    ok('no backdrop while only the bar is up', await page.evaluate(() => getComputedStyle(document.getElementById('bd')).visibility === 'hidden'));

    head('A HELD GRAPHIC: the bar leaves first, comes back once with the score as it is now');
    let r = await take('standings', {}, 'hold');
    const tableId = r.graphic.id;
    ok('the points table is taken (held)', r.ok && r.graphic.expiresAt === null, r);
    ok('…on air', await waitOnAir(page, tableId));
    let h = await history(page);
    ok('…after the bar left: OVERLAY_EXITING → IDLE → GRAPHIC_ENTERING → GRAPHIC_VISIBLE', h.slice(-4).join() === 'OVERLAY_EXITING,IDLE,GRAPHIC_ENTERING,GRAPHIC_VISIBLE', h.slice(-6));
    ok('…with the designed backdrop behind it', await page.evaluate(() => getComputedStyle(document.getElementById('bd')).visibility === 'visible'));
    await page.screenshot({ path: path.join(OUT, 'lifecycle-table.png') });
    let before = await counts(page);
    // the match goes on meanwhile
    await ev({ type: 'RALLY', winner: 'A', outcome: 'GENERAL' });
    await ev({ type: 'RALLY', winner: 'A', outcome: 'GENERAL' });
    await sleep(2200);
    ok('a held graphic stays up', (await state(page)) === 'GRAPHIC_VISIBLE');
    r = await cmd('stop', { id: tableId });
    ok('dismissed', r.ok && r.graphic.scene === null, r);
    ok('the bar comes back (OVERLAY_RETURNING → OVERLAY_VISIBLE)', await waitState(page, 'OVERLAY_VISIBLE'));
    h = await history(page);
    ok('…after the graphic left: GRAPHIC_EXITING → IDLE → OVERLAY_RETURNING → OVERLAY_VISIBLE', h.slice(-4).join() === 'GRAPHIC_EXITING,IDLE,OVERLAY_RETURNING,OVERLAY_VISIBLE', h.slice(-6));
    let after = await counts(page);
    ok('…exactly once', after.returns - before.returns === 1 && after.overlayIn - before.overlayIn === 1, { before, after });
    let sc = await score();
    let bb = await bars(page);
    ok('…with the latest score (points scored while it was off air)', bb.a === String(sc.points.A) && bb.b === String(sc.points.B), { bar: bb, server: sc.points });
    let v = await violations(page);
    ok('not one frame with the graphic and the bar on screen together', v.vio.length === 0 && v.frames > 60, v);

    head('A TIMED GRAPHIC goes by itself');
    before = await counts(page);
    r = await take('toss', {}, 2);
    ok('the toss for 2 s', r.ok && r.graphic.durationSec === 2, r);
    ok('…on air', await waitOnAir(page, r.graphic.id));
    ok('…and the bar back by itself after its time', await waitState(page, 'OVERLAY_VISIBLE', 9000));
    after = await counts(page);
    ok('…once', after.returns - before.returns === 1, { before, after });

    head('RAPID TAKES: one graphic at a time, the last one wins');
    before = await counts(page);
    await page.evaluate(() => { window.__maxScenes = 0; });
    const r1 = take('intro', {}, 'hold');
    await sleep(250);
    const r2 = take('standings', {}, 'hold');
    await sleep(250);
    const r3 = await take('setStart', {}, 'hold');
    await r1; await r2;
    ok('the last take is on air', await waitOnAir(page, r3.graphic.id, 15000));
    v = await violations(page);
    ok('…never two graphics mounted at once', v.max <= 1, v.max);
    ok('…and still no frame with the bar under a graphic', v.vio.length === 0, v.vio);
    const again = await take('setStart', {}, 'hold');
    ok('the same graphic pressed again: "already on air"', again.ok && again.same && again.graphic.id === r3.graphic.id, again);
    const cIn = (await counts(page)).graphicIn;
    await take('setStart', {}, 'hold');
    await sleep(500);
    ok('…no second entrance: it came in once and stays up', (await counts(page)).graphicIn === cIn && (await state(page)) === 'GRAPHIC_VISIBLE');
    await cmd('live');
    ok('back to live', await waitState(page, 'OVERLAY_VISIBLE'));
    after = await counts(page);
    ok('…the bar returned once for all three', after.returns - before.returns === 1, { before, after });

    head('AN ENTRANCE OVERTAKEN plays back — the bar returns once');
    before = await counts(page);
    r = await take('intro', {}, 'hold');
    await page.waitForFunction(() => window.__vbOverlay.state === 'GRAPHIC_ENTERING' && document.querySelector('#gfx .scene'), null, { timeout: 8000 }).catch(() => {});
    await sleep(250);
    await cmd('stop', { id: r.graphic.id });
    ok('dismissed mid-entrance: the bar comes back', await waitState(page, 'OVERLAY_VISIBLE'));
    after = await counts(page);
    ok('…the entrance was played back, not finished first', after.interrupted > before.interrupted, { before, after });
    ok('…one return', after.returns - before.returns === 1, { before, after });
    v = await violations(page);
    ok('…and no frame with both on screen', v.vio.length === 0, v.vio);

    head('RELOAD / vMIX RESTART in the middle of a graphic');
    r = await take('final', {}, 'hold');
    ok('the match result on air', await waitOnAir(page, r.graphic.id));
    await ctx.close();
    ({ ctx, page } = await openOverlay());
    ok('the reloaded overlay shows the graphic on air', await waitOnAir(page, r.graphic.id));
    h = await history(page);
    ok('…straight away — never the bar first', h.indexOf('OVERLAY_ENTERING') < 0 && h[0] === 'GRAPHIC_ENTERING', h);
    // what the overlay did, not the wall clock (a fresh renderer's first frame alone can take a second)
    const settled = await counts(page);
    ok('…settled (a short fade), not its whole entrance again', settled.settled === 1 && settled.graphicIn === 1, settled);
    await cmd('stop', { id: r.graphic.id });
    ok('dismissed: the bar comes in', await waitState(page, 'OVERLAY_VISIBLE'));
    r = await take('intro', {}, 'hold');
    await page.waitForFunction(() => window.__vbOverlay.state === 'GRAPHIC_ENTERING' && document.querySelector('#gfx .scene'), null, { timeout: 8000 }).catch(() => {});
    await sleep(500);
    await ctx.close();
    ({ ctx, page } = await openOverlay());
    ok('reloaded in the middle of an entrance: on air', await waitOnAir(page, r.graphic.id));
    const mid = await counts(page);
    ok('…settled, in step with the other outputs, not its entrance from the start', mid.settled === 1 && mid.overlayIn === 0, mid);
    await cmd('stop', { id: r.graphic.id });
    await waitState(page, 'OVERLAY_VISIBLE');

    head('THE SERVER UNREACHABLE: a timed graphic still ends on time, the bar returns once');
    before = await counts(page);
    r = await take('setStart', {}, 3);
    ok('a 3 s graphic on air', await waitOnAir(page, r.graphic.id));
    await page.evaluate(() => window.__vbOverlay.O.socket.disconnect());
    ok('…the overlay ends it on its own clock and the bar returns', await waitState(page, 'OVERLAY_VISIBLE', 10000));
    await page.evaluate(() => window.__vbOverlay.O.socket.connect());
    await sleep(2500);
    after = await counts(page);
    ok('…back online: still the bar, returned once', (await state(page)) === 'OVERLAY_VISIBLE' && after.returns - before.returns === 1, { before, after, state: await state(page) });

    head('HIDE EVERYTHING — then a graphic, then live');
    r = await cmd('clean');
    ok('hide everything: the bar goes', await waitState(page, 'IDLE'));
    ok('…nothing visible', await page.evaluate(() => getComputedStyle(document.getElementById('stage')).visibility === 'hidden' && !document.querySelector('#gfx .scene')));
    r = await take('intro', {}, 'hold');
    ok('a graphic from "hidden": it comes straight in', await waitOnAir(page, r.graphic.id));
    await cmd('stop', { id: r.graphic.id });
    ok('…dismissed: the live score returns', await waitState(page, 'OVERLAY_VISIBLE'));
    await cmd('clean');
    await waitState(page, 'IDLE');
    await cmd('live');
    ok('"show the score bar" brings it back', await waitState(page, 'OVERLAY_VISIBLE'));

    head('TIME-OUT: the graphic goes when the next rally is scored');
    await ev({ type: 'TIMEOUT', team: 'B' });
    r = await take('timeout');
    ok('the time-out graphic on air', r.ok && await waitOnAir(page, r.graphic.id), r);
    await page.waitForTimeout(1200);
    const n1 = await page.evaluate(() => Number(document.querySelector('.timeout .tos').textContent));
    await page.waitForTimeout(1300);
    const n2 = await page.evaluate(() => Number(document.querySelector('.timeout .tos').textContent));
    ok('…its count-down runs', n1 > n2 && n2 > 20, [n1, n2]);
    await page.screenshot({ path: path.join(OUT, 'lifecycle-timeout.png') });
    await ev({ type: 'RALLY', winner: 'B', outcome: 'GENERAL' });
    ok('…the rally takes it off air and the bar returns', await waitState(page, 'OVERLAY_VISIBLE', 9000));
    sc = await score(); bb = await bars(page);
    ok('…with that rally on it', bb.a === String(sc.points.A) && bb.b === String(sc.points.B), { bar: bb, server: sc.points });

    head('STARTING SIX OF BOTH TEAMS: team one, then team two, then live');
    await page.evaluate(() => { window.__teams = []; setInterval(() => { const s = window.__vbOverlay.C.scene; if (s && window.__teams[window.__teams.length - 1] !== s.team) window.__teams.push(s.team); }, 50); });
    r = await take('lineup', { set: 1 }, 2);
    ok('both teams, 2 s each', r.ok && r.graphic.swapAt, r);
    ok('…on air', await waitOnAir(page, r.graphic.id));
    ok('…and the bar back after both', await waitState(page, 'OVERLAY_VISIBLE', 15000));
    const teams = await page.evaluate(() => window.__teams.filter(Boolean));
    ok('…team one then team two', teams.join() === 'A,B', teams);

    head('POINT TAGS: only a named player’s kill, never a guess');
    const tagOn = () => page.evaluate(() => ['#tagL', '#tagR'].map((s) => document.querySelector(s)).filter((el) => getComputedStyle(el).visibility === 'visible').map((el) => el.textContent));
    await ev({ type: 'RALLY', winner: 'A', outcome: 'GENERAL' });
    await sleep(700);
    ok('a point with nobody named: no tag', (await tagOn()).length === 0, await tagOn());
    const killer = A.players.find((p) => p.playerId === six(A)[2]);
    await ev({ type: 'RALLY', winner: 'A', outcome: 'ATTACK_KILL', players: { attacker: killer.playerId } });
    const tagged = await page.waitForFunction(() => ['#tagL', '#tagR'].some((s) => getComputedStyle(document.querySelector(s)).visibility === 'visible'), null, { timeout: 4000 }).then(() => true, () => false);
    const tagText = await tagOn();
    ok('a kill by a named attacker: "Kill #3 P. 3" over that team’s side', tagged && tagText.length === 1 && tagText[0] === 'Kill#' + killer.number + ' P. 3', tagText);
    const tagSide = await page.evaluate(() => (getComputedStyle(document.querySelector('#tagL')).visibility === 'visible' ? 0 : 1) === window.__vbOverlay.O.sides.indexOf('A'));
    ok('…on the scoring team’s side of the bar', tagSide);
    await page.screenshot({ path: path.join(OUT, 'lifecycle-pointtag.png') });
    ok('…and gone again by itself', await page.waitForFunction(() => ['#tagL', '#tagR'].every((s) => getComputedStyle(document.querySelector(s)).visibility === 'hidden'), null, { timeout: 7000 }).then(() => true, () => false));
    r = await take('setStart', {}, 'hold');
    await waitOnAir(page, r.graphic.id);
    await ev({ type: 'RALLY', winner: 'A', outcome: 'ATTACK_KILL', players: { attacker: killer.playerId } });
    await sleep(900);
    ok('no tag while a graphic is on air', (await tagOn()).length === 0, await tagOn());
    await cmd('live');
    await waitState(page, 'OVERLAY_VISIBLE');

    v = await violations(page);
    ok('all along: never a frame with a graphic on the bar', v.vio.length === 0, v);
    ok('all along: never two graphics mounted', v.max <= 1, v.max);

    head('vMIX SAFETY');
    // the source text (the CSSOM would re-serialise top/right/bottom/left as "inset" by itself)
    const css = await page.evaluate(() => Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('\n'));
    ok('no color-mix(), :has(), @container, aspect-ratio or inset: in the overlay', !/color-mix\(|:has\(|@container|aspect-ratio|(^|[;{\s])inset\s*:/.test(css));
    r = await take('scorecard', {}, 'hold');
    await waitOnAir(page, r.graphic.id);
    const flexGap = await page.evaluate(() => Array.from(document.querySelectorAll('#fit *')).filter((e) => { const cs = getComputedStyle(e); return /flex/.test(cs.display) && ((cs.columnGap !== 'normal' && cs.columnGap !== '0px') || (cs.rowGap !== 'normal' && cs.rowGap !== '0px')); }).map((e) => e.className).slice(0, 5));
    ok('no flex gap (older Chromium in vMix) on the bar or a graphic', flexGap.length === 0, flexGap);
    await cmd('live');
    await waitState(page, 'OVERLAY_VISIBLE');
    await sleep(800);
    const anims = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' || a.playState === 'paused').map((a) => (a.effect && a.effect.target && (a.effect.target.id || a.effect.target.className)) + ':' + (a.animationName || 'waapi')));
    ok('no animation left behind after all of that', anims.length <= 2, anims);
    await ctx.close();

    head('GRAPHICS-ONLY LAYOUT: no bar ever');
    ({ ctx, page } = await openOverlay('&layout=graphics'));
    await sleep(2500);
    ok('nothing on screen with no graphic', (await state(page)) === 'IDLE' && await page.evaluate(() => !document.querySelector('#gfx .scene')));
    r = await take('intro', {}, 'hold');
    ok('a graphic shows', await waitOnAir(page, r.graphic.id));
    await cmd('stop', { id: r.graphic.id });
    ok('…dismissed: back to nothing (no bar)', await waitState(page, 'IDLE'));
    ok('…the bar never came in', (await counts(page)).overlayIn === 0);
    await ctx.close();

    head('CORNER LAYOUT: the corner bug steps aside too');
    ({ ctx, page } = await openOverlay('&layout=compact'));
    ok('the corner bug comes in', await waitState(page, 'OVERLAY_VISIBLE'));
    r = await take('standings', {}, 2);
    ok('a graphic replaces it', await waitOnAir(page, r.graphic.id));
    ok('…and it returns after', await waitState(page, 'OVERLAY_VISIBLE', 9000));
    v = await violations(page);
    ok('…never both on screen', v.vio.length === 0, v.vio);
    await page.screenshot({ path: path.join(OUT, 'lifecycle-compact.png') });
    await ctx.close();

    head('THE LIVE OVERLAY BY HAND — taken off air, it stays off');
    const outLists = [];
    op.on('vb:outputs', (d) => { if (d.matchId === M.matchId) outLists.push(d.outputs); });
    await op.emitAck('vb:join', { matchId: M.matchId });
    const lastOut = () => { const l = outLists[outLists.length - 1] || []; return l.filter((o) => !o.monitor); };
    const lvc = (page) => page.evaluate(() => Object.assign({}, window.__lv));
    const resetLv = (page) => page.evaluate(() => { Object.keys(window.__lv).forEach((k) => { window.__lv[k] = 0; }); });
    ({ ctx, page } = await openOverlay());
    ok('automatic: the tournament\'s score bar comes in', await waitState(page, 'OVERLAY_VISIBLE') && await page.evaluate(() => window.__vbOverlay.C.barLayout === 'bar'));
    ok('…and the output says so to the server (what the panels read ON AIR from)', !!(await until(() => lastOut().some((o) => o.state === 'OVERLAY_VISIBLE' && o.layout === 'bar'))), lastOut());
    before = await counts(page);
    r = await cmd('live-off', { layout: 'bar' });
    ok('TAKE OFF AIR: the bar plays its exit', r.ok && await waitState(page, 'IDLE') && (await history(page)).slice(-2).join() === 'OVERLAY_EXITING,IDLE', await history(page));
    ok('…seen leaving, not cut', (await lvc(page)).exitStage > 3, await lvc(page));
    ok('…the output reports nothing on', !!(await until(() => lastOut().some((o) => o.state === 'IDLE'))), lastOut());
    await resetLv(page);
    await ev({ type: 'RALLY', winner: 'A', outcome: 'GENERAL' });
    await ev({ type: 'RALLY', winner: 'B', outcome: 'GENERAL' });
    await sleep(2500);
    ok('points scored after it do NOT bring it back (not one frame)', (await state(page)) === 'IDLE' && (await lvc(page)).stage === 0, await lvc(page));
    r = await take('intro', {}, 2);
    ok('a graphic taken now comes straight in (no bar to wait for)', await waitOnAir(page, r.graphic.id) && (await history(page)).slice(-3).join() === 'IDLE,GRAPHIC_ENTERING,GRAPHIC_VISIBLE', (await history(page)).slice(-4));
    ok('…ends on its time — and nothing comes back after it', await waitState(page, 'IDLE', 9000));
    await sleep(1500);
    ok('…not one frame of the bar since it was taken off air', (await lvc(page)).stage === 0 && (await counts(page)).overlayIn === before.overlayIn, { lv: await lvc(page), before, now: await counts(page) });
    await page.screenshot({ path: path.join(OUT, 'lifecycle-live-off.png') });

    head('THE CORNER BUG REPLACES THE SCORE BAR — never both, never a cut');
    r = await cmd('live-on', { layout: 'compact' });
    ok('TAKE ON AIR the corner bug: it comes in by its entrance', r.ok && await waitState(page, 'OVERLAY_VISIBLE') && await page.evaluate(() => window.__vbOverlay.C.barLayout === 'compact') && (await history(page)).slice(-2).join() === 'OVERLAY_ENTERING,OVERLAY_VISIBLE', (await history(page)).slice(-3));
    ok('…the corner bug on screen, the bar not', await page.evaluate(() => getComputedStyle(document.getElementById('corner')).display !== 'none' && getComputedStyle(document.getElementById('stage')).display === 'none'));
    ok('…the output reports the corner bug', !!(await until(() => lastOut().some((o) => o.state === 'OVERLAY_VISIBLE' && o.layout === 'compact'))), lastOut());
    sc = await score();
    const cornerPts = await page.evaluate(() => ['#cr0', '#cr1'].map((q) => document.querySelector(q + ' .cp .roll .n:last-child').textContent));
    ok('…with the latest score (the points scored while nothing was on air)', cornerPts[0] === String(sc.points.A) && cornerPts[1] === String(sc.points.B), { corner: cornerPts, server: sc.points });
    await ev({ type: 'RALLY', winner: 'B', outcome: 'GENERAL' });
    sc = await score();
    ok('…a point while it is up: it follows at once', await page.waitForFunction((b) => document.querySelector('#cr1 .cp .roll .n:last-child').textContent === b, String(sc.points.B), { timeout: 5000 }).then(() => true, () => false));
    await page.screenshot({ path: path.join(OUT, 'lifecycle-live-corner.png') });
    await resetLv(page);
    r = await cmd('live-on', { layout: 'bar' });
    ok('TAKE ON AIR the score bar: the corner bug leaves, then the bar comes in', r.ok && await page.waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE' && window.__vbOverlay.C.barLayout === 'bar', null, { timeout: 12000 }).then(() => true, () => false) && (await history(page)).slice(-4).join() === 'OVERLAY_EXITING,IDLE,OVERLAY_ENTERING,OVERLAY_VISIBLE', (await history(page)).slice(-5));
    sc = await score(); bb = await bars(page);
    ok('…the bar with the latest score', bb.a === String(sc.points.A) && bb.b === String(sc.points.B), { bar: bb, server: sc.points });
    let lv = await lvc(page);
    ok('…the corner bug was seen leaving (an exit, not a cut)', lv.exitCorner > 3, lv);
    ok('…and not one frame with both on screen', lv.both === 0 && lv.stage > 0, lv);
    await resetLv(page);
    r = await cmd('live-on', { layout: 'compact' });
    await page.waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE' && window.__vbOverlay.C.barLayout === 'compact', null, { timeout: 12000 });
    lv = await lvc(page);
    ok('…and back: the bar leaves by its exit, then the corner bug — never both', lv.exitStage > 3 && lv.both === 0 && lv.corner > 0, lv);

    head('OFF AIR UNDER A GRAPHIC — nothing returns when it goes');
    r = await take('standings', {}, 'hold');
    const under = r.graphic.id;
    ok('a held graphic over the corner bug', await waitOnAir(page, under));
    r = await cmd('live-off', { layout: 'compact' });
    ok('TAKE OFF AIR the corner bug meanwhile: the graphic stays on air', r.ok && r.graphic.scene === 'standings' && (await state(page)) === 'GRAPHIC_VISIBLE', r.graphic);
    await resetLv(page);
    await cmd('stop', { id: under });
    ok('dismissed: nothing comes back', await waitState(page, 'IDLE'));
    await sleep(1800);
    lv = await lvc(page);
    ok('…not one frame of the corner bug or the bar', lv.corner === 0 && lv.stage === 0 && (await state(page)) === 'IDLE', lv);

    head('HIDE EVERYTHING — a timer cannot bring anything back; RESTORE');
    await cmd('live-on', { layout: 'bar' });
    await waitState(page, 'OVERLAY_VISIBLE');
    r = await take('toss', {}, 2);
    const timed = r.graphic;
    await waitOnAir(page, timed.id);
    r = await cmd('clean');
    ok('hide everything while a 2 s graphic is up: everything goes', r.ok && r.graphic.clean && await waitState(page, 'IDLE'));
    await resetLv(page);
    await page.waitForTimeout(Math.max(0, timed.expiresAt - Date.now()) + 2000);
    lv = await lvc(page);
    ok('…past that graphic\'s time: still nothing (no timer revived it)', (await state(page)) === 'IDLE' && lv.stage === 0 && lv.corner === 0 && await page.evaluate(() => !document.querySelector('#gfx .scene')), lv);
    r = await cmd('live');
    ok('RESTORE LIVE OVERLAY: the score bar the operator had on air', r.ok && await waitState(page, 'OVERLAY_VISIBLE') && await page.evaluate(() => window.__vbOverlay.C.barLayout === 'bar'));

    head('AUTOMATIC ⇄ MANUAL — what shows keeps showing, no flash');
    before = await counts(page);
    await resetLv(page);
    r = await cmd('live-mode', { mode: 'auto' });
    ok('to Automatic (the tournament\'s layout is the bar on air)', r.ok && r.graphic.live.mode === 'auto', r.graphic);
    await sleep(1500);
    r = await cmd('live-mode', { mode: 'manual' });
    ok('…and back to Manual', r.ok && r.graphic.live.mode === 'manual' && r.graphic.live.layout === 'bar', r.graphic);
    await sleep(1500);
    after = await counts(page);
    lv = await lvc(page);
    ok('…the bar never left nor re-entered', (await state(page)) === 'OVERLAY_VISIBLE' && after.overlayIn === before.overlayIn && after.overlayOut === before.overlayOut && lv.exitStage === 0, { before, after, lv });
    head('CONFLICTING COMMANDS — rapid takes, a mode change and hide everything mid-transition');
    await page.evaluate(() => { window.__maxScenes = 0; });
    const c1 = take('intro', {}, 2);                    // the bar starts leaving
    await sleep(150);
    const c2 = cmd('live-mode', { mode: 'auto' });      // the mode changed mid-transition
    await sleep(150);
    const c3 = take('standings', {}, 'hold');           // replaced before it is even in
    await sleep(350);
    const c4 = cmd('clean');                            // hide everything during an entrance
    const rs = await Promise.all([c1, c2, c3, c4]);
    ok('every command answered (none lost)', rs.every((x) => x && x.ok), rs.map((x) => x && (x.ok || x.error)));
    ok('…it ends hidden: nothing on screen', await waitState(page, 'IDLE') && await page.evaluate(() => !document.querySelector('#gfx .scene')));
    await resetLv(page);
    await page.waitForTimeout(4500);                    // well past the 2 s intro's time
    lv = await lvc(page);
    ok('…no stale timer or command brings anything back', (await state(page)) === 'IDLE' && lv.stage === 0 && lv.corner === 0 && await page.evaluate(() => !document.querySelector('#gfx .scene')), { lv, state: await state(page) });
    v = await violations(page);
    ok('…never two graphics mounted, never one on the bar', v.max <= 1 && v.vio.length === 0, v);
    r = await cmd('live');
    ok('RESTORE: the live overlay (Automatic, the tournament\'s bar) comes back', r.ok && r.graphic.live.mode === 'auto' && await waitState(page, 'OVERLAY_VISIBLE') && await page.evaluate(() => window.__vbOverlay.C.barLayout === 'bar'));

    r = await cmd('live-off', { layout: 'bar' });
    await waitState(page, 'IDLE');
    await ctx.close();
    ({ ctx, page } = await openOverlay());
    await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 12000 });
    await sleep(2500);
    ok('a reloaded overlay (vMix restart) with the bar off air: the bar never comes in', (await state(page)) === 'IDLE' && (await counts(page)).overlayIn === 0 && (await lvc(page)).stage === 0, { state: await state(page), counts: await counts(page) });
    r = await cmd('live-mode', { mode: 'auto' });
    ok('Automatic again: the tournament\'s bar comes in', r.ok && await waitState(page, 'OVERLAY_VISIBLE'));
    v = await violations(page);
    ok('all along: never a graphic on the live overlay', v.vio.length === 0, v.vio);
    await ctx.close();

    head('A TEAM LOGO THAT WILL NOT LOAD: the team’s initials on its colour, never a broken image');
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGM4ISdHEmIY1TCqYfhqAADkYgQQ60fIxgAAAABJRU5ErkJggg==';
    r = await api('PUT', `/api/volleyball/teams/${A.teamId}`, { json: { logo: PNG } });
    ok('team one gets a logo', r.status === 200, r.json);
    const plateOf = (p) => p.evaluate(() => { const i = window.__vbOverlay.O.sides.indexOf('A'); const el = document.getElementById(i === 0 ? 'ia' : 'ib'); return { mono: el.classList.contains('mono'), img: !!el.querySelector('img'), text: el.textContent }; });
    ({ ctx, page } = await openOverlay());
    await waitState(page, 'OVERLAY_VISIBLE');
    await page.waitForFunction(() => { const i = window.__vbOverlay.O.sides.indexOf('A'); const im = document.querySelector((i === 0 ? '#ia' : '#ib') + ' img'); return im && im.complete && im.naturalWidth > 0; }, null, { timeout: 6000 }).catch(() => {});
    let pl = await plateOf(page);
    ok('…it loads: the bar shows it', pl.img && !pl.mono, pl);
    await ctx.close();
    ({ ctx, page } = await openOverlay());
    await ctx.route(new RegExp(`/api/volleyball/teams/${A.teamId}/logo`), (rt) => rt.abort());
    await page.reload();
    await waitState(page, 'OVERLAY_VISIBLE');
    await page.waitForFunction(() => { const i = window.__vbOverlay.O.sides.indexOf('A'); return document.getElementById(i === 0 ? 'ia' : 'ib').classList.contains('mono'); }, null, { timeout: 6000 }).catch(() => {});
    pl = await plateOf(page);
    ok('…it fails to load: the initials plate instead', pl.mono && !pl.img && pl.text === 'PUN', pl);
    r = await take('intro', {}, 'hold');
    ok('…the intro still goes on air', await waitOnAir(page, r.graphic.id));
    const broken = await page.evaluate(() => Array.from(document.querySelectorAll('#gfx img')).filter((im) => !im.complete || im.naturalWidth === 0).map((im) => im.getAttribute('src')));
    ok('…with no broken image in it', broken.length === 0, broken);
    ok('…and both teams named', await page.evaluate(() => /Pune Panthers/.test(document.getElementById('gfx').textContent) && /Goa Waves/.test(document.getElementById('gfx').textContent)));
    await page.screenshot({ path: path.join(OUT, 'lifecycle-nologo.png') });
    await cmd('live');
    await waitState(page, 'OVERLAY_VISIBLE');
    await ctx.close();

    await op.close();
    void mem;
    ok('no uncaught page or console error', errors.length === 0, errors);
  } catch (e) {
    fails.push('crashed: ' + (e.stack || e));
    console.log(e.stack || e);
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ':\n  - ' + fails.join('\n  - ') : ''}`);
  process.exit(fails.length ? 1 : 0);
})();
