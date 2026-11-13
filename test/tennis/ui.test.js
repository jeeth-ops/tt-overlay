/* 🖥️ The tennis pages in Chromium against the REAL server (in-memory
   MongoDB, test tokens): what the operator, a phone and the public do.

     • the panel: toss, start, points from the keyboard and the buttons,
       "how was it won", undo / redo, fault → double fault, an ace — the
       server agrees with every one
     • the network drops: points still score at once, are kept on the
       device (across a reload too) and reach the server once, in order
     • one device scores at a time: the phone takes over, the laptop is told
       at once and can no longer score, then takes it back
     • graphics from the panel: a scene to air, ON AIR once an overlay has it
     • the public match centre (signed out): live without a reload, figures
       that were not recorded say so instead of showing 0
     • the draw page: a seeded knockout; a finished semi-final puts its
       winner in the final, and nobody else
     • the dashboard and who may use it: a tournament account creates a
       tournament; another signed-in account is turned away from the
       dashboard, the panel and the API — and still sees the public pages,
       but never a private tournament's
     • the player page, the overlay links, the Clipper page
     • no sideways scrolling on phone and laptop widths; no page errors

     NODE_PATH=$(npm root -g) node test/tennis/ui.test.js
   Screenshots: test/out/tennis/ui-*.png
*/
const H = require('./browser-harness.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 700) : '')); }
}
const head = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + (ms || 8000); let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step || 120); } return v; }

(async () => {
  const h = await H.start();
  const api = h.api;
  const guest = (m, u, o) => H.call(h.port, m, u, Object.assign({ token: 'tok-guest' }, o || {}));
  try {
    const { m, P, t } = await h.seed({ photos: false });
    const MID = m.matchId;
    const server = async () => (await api('GET', `/api/tennis/matches/${MID}?timeline=1`)).json;
    const display = async () => { const j = await server(); return j.summary ? j.summary.display.A + '-' + j.summary.display.B : null; };
    const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

    head('1 · THE PANEL — every press reaches the server as it is');
    const panel = await h.open('/tennis-panel?match=' + MID, { viewport: { width: 1440, height: 900 }, captureSockets: true });
    await panel.waitForSelector('#tossBtn', { timeout: 15000 });
    await panel.click('#tossBtn'); await panel.click('#ok');
    await panel.waitForSelector('#startBtn'); await panel.click('#startBtn'); await panel.click('#go');
    await panel.waitForSelector('.point', { timeout: 8000 });
    let j = await until(async () => { const x = await server(); return x.match.status === 'live' ? x : null; });
    ok('toss and start: the match is live on the server, Alcaraz serving', j && j.match.status === 'live' && j.summary.server && j.summary.server.playerId === P.a.playerId, j && j.summary && j.summary.server);
    await panel.keyboard.press('ArrowLeft'); await sleep(80);
    await panel.keyboard.press('ArrowLeft'); await sleep(80);
    await panel.click('.side[data-pos="R"] .point'); await sleep(80);
    ok('two points from the keyboard (←), one from the button: 30-15 on the server', await until(async () => (await display()) === '30-15'), await display());
    const board = (await panel.textContent('#board')).replace(/\s+/g, ' ');
    ok('…and on the panel’s own board', /30/.test(board) && /15/.test(board), board);
    await panel.keyboard.press('1');   // "how was it won": a winner (for the last point, Sinner's)
    j = await until(async () => { const x = await server(); const e = x.timeline.filter((y) => y.type === 'POINT').pop(); return e && e.kind === 'WINNER' ? x : null; });
    ok('"1" after a point: classified as a winner (a correction the server keeps)', !!j);
    await panel.keyboard.press('z');
    ok('Z: the last point undone — 30-0', await until(async () => (await display()) === '30-0'), await display());
    await panel.keyboard.press('Shift+Z');
    ok('Shift+Z: redone — 30-15, still a winner', await until(async () => { const x = await server(); const e = x.timeline.filter((y) => y.type === 'POINT' && !y.voided).pop(); return x.summary.display.A === '30' && x.summary.display.B === '15' && e.kind === 'WINNER'; }));
    await panel.keyboard.press('f'); await sleep(150);
    ok('F: a fault — the second serve now', await until(async () => (await server()).summary.serve === 2));
    await panel.keyboard.press('f');
    ok('F again: a double fault — the point to Sinner, 30-30', await until(async () => (await display()) === '30-30'), await display());
    await panel.keyboard.press('e');
    j = await until(async () => { const x = await server(); return x.summary.display.A === '40' ? x : null; });
    const lastPt = j && j.timeline.filter((y) => y.type === 'POINT' && !y.voided).pop();
    ok('E: an ace — 40-30, recorded as an ace by the server', j && lastPt.kind === 'ACE' && lastPt.side === 'A', lastPt && { kind: lastPt.kind, side: lastPt.side });
    await h.shot(panel, 'ui-panel-live');

    head('2 · THE NETWORK DROPS — scored at once, kept, sent once');
    const before = (await server()).match.eventSeq;
    await panel.evaluate(() => window.__sockets.forEach((s) => s.disconnect()));
    await sleep(300);
    await panel.keyboard.press('ArrowLeft'); await sleep(200);   // game Alcaraz — and they change ends
    const leftNow = await panel.textContent('.side[data-pos="L"] [data-nm]');
    ok('after the first game the players change ends — the panel’s left button is Sinner’s now', /Sinner/.test(leftNow), leftNow);
    await panel.keyboard.press('ArrowLeft'); await sleep(200);   // Sinner (left now), serving: 0-15
    const local = (await panel.textContent('#board')).replace(/\s+/g, ' ');
    const kept = await panel.evaluate((id) => JSON.parse(localStorage.getItem('tn_outbox:' + id) || '[]').length, MID);
    ok('offline: both points show on the panel at once', /15/.test(local), local);
    ok('…kept on the device (2 waiting), the server untouched', kept === 2 && (await server()).match.eventSeq === before, { kept, seq: (await server()).match.eventSeq, before });
    const chips = await panel.textContent('#chips');
    ok('…and the panel says it is offline / waiting', /offline|wait|2/i.test(chips), chips);
    await panel.reload();   // a reload while they wait: still there, and sent once the socket is back
    await panel.waitForSelector('.point', { timeout: 15000 });
    j = await until(async () => { const x = await server(); return x.match.eventSeq === before + 2 ? x : null; }, 12000);
    ok('after a reload the two points reach the server — exactly once each, in order (games 1-0, 0-15)', j && j.summary.display.A === '0' && j.summary.display.B === '15' && j.summary.sets[0].A === 1 && j.summary.sets[0].B === 0, j && { seq: j.match.eventSeq, before, d: j.summary.display, s: j.summary.sets });
    await sleep(800);
    ok('…nothing sent twice; nothing left waiting', (await server()).match.eventSeq === before + 2 && await panel.evaluate((id) => !localStorage.getItem('tn_outbox:' + id), MID));

    head('3 · ONE DEVICE SCORES AT A TIME');
    const phone = await h.open('/tennis-remote?match=' + MID, { viewport: { width: 390, height: 844 }, mobile: true });
    await phone.waitForSelector('.pbtn', { timeout: 15000 });
    await phone.waitForSelector('#take', { timeout: 8000 });
    ok('the phone shows the score and that the laptop is scoring', /is scoring now/.test(await phone.textContent('.lock')), await phone.textContent('.lock'));
    await phone.click('#take');
    await phone.click('.sheet .btn.primary');
    ok('the phone takes over: the laptop is told at once and can no longer score', await until(() => panel.evaluate(() => document.body.classList.contains('view-only')), 6000));
    const seq3 = (await server()).match.eventSeq;
    await panel.keyboard.press('ArrowLeft'); await sleep(600);
    ok('…a press on the laptop changes nothing on the server', (await server()).match.eventSeq === seq3);
    await phone.tap('[data-p="B"]');
    ok('the phone scores: 0-30 on the server', await until(async () => (await display()) === '0-30'), await display());
    ok('…and the laptop follows it live', await until(async () => /30/.test(await panel.textContent('#board')), 5000));
    await h.shot(phone, 'ui-remote-scoring');
    await panel.click('#takeBtn');
    await panel.click('.sheet .btn.primary');
    ok('the laptop takes it back; the phone is told', await until(() => panel.evaluate(() => !document.body.classList.contains('view-only')), 6000) && await until(async () => !!(await phone.$('#take')), 6000));
    ok('the phone fits a phone (no sideways scroll)', await noSideways(phone));

    head('4 · GRAPHICS FROM THE PANEL');
    const ov = await h.open('/tennis-overlay?match=' + MID, { viewport: { width: 1920, height: 1080 }, who: null });
    await ov.waitForSelector('body.ready', { timeout: 15000 });
    await panel.click('[data-tab="graphics"]');
    await panel.waitForSelector('[data-take="setScore"]', { timeout: 5000 });
    await panel.click('[data-take="setScore"]');
    j = await until(async () => { const x = await server(); return x.match.graphic && x.match.graphic.scene === 'setScore' ? x : null; });
    ok('the set score taken to air from the panel', !!j);
    ok('…the panel says ON AIR once the overlay really has it', await until(async () => /on air/i.test(await panel.textContent('#airChip')), 9000), await panel.textContent('#airChip'));
    await h.shot(panel, 'ui-panel-graphics');
    await panel.click('#backLive').catch(() => {});
    await ov.close();

    head('5 · THE PUBLIC MATCH CENTRE');
    const mc = await h.open('/tennis/match/' + MID, { viewport: { width: 390, height: 844 }, mobile: true, who: null });
    await mc.waitForSelector('#tabs', { timeout: 15000 });
    let text = await mc.textContent('#app');
    ok('signed out, the match centre shows the match: both players, the live score', /Alcaraz/.test(text) && /Sinner/.test(text) && /0/.test(text), text.slice(0, 200));
    const lease = (await api('POST', `/api/tennis/matches/${MID}/lease`, { json: { deviceId: 'api', force: true } })).json.leaseToken;
    await api('POST', `/api/tennis/matches/${MID}/events`, { json: { leaseToken: lease, event: { eventId: 'mc' + Date.now().toString(36), type: 'POINT', winner: 'B', serve: 1 } } });
    ok('a point scored elsewhere appears without a reload (0-40)', await until(async () => /40/.test(await mc.textContent('#app')), 6000));
    await mc.click('[data-t="stats"]');
    await sleep(500);
    text = await mc.textContent('#tab');
    ok('statistics: aces counted (1), and a figure that was not recorded says so — not 0', /Aces/.test(text) && /1/.test(text) && /(–|not recorded|Not recorded)/i.test(text), text.slice(0, 400));
    await h.shot(mc, 'ui-matchcentre-stats', { fullPage: true });
    ok('the match centre fits a phone', await noSideways(mc));

    head('6 · THE DRAW — a winner moves on, nobody else');
    const T2 = (await api('POST', '/api/tennis/tournaments', { json: { name: 'Draw Cup 2026', visibility: 'public', surface: 'clay' } })).json.tournament;
    const ev = (await api('POST', `/api/tennis/tournaments/${T2.tournamentId}/events`, { json: { name: "Men's Singles", format: 'singles', category: 'men', drawType: 'knockout', rules: { bestOf: 1, finalSet: 'matchTiebreak', finalTiebreakPoints: 10 },
      entries: [{ playerIds: [P.a.playerId], seed: 1 }, { playerIds: [P.b.playerId], seed: 2 }, { playerIds: [P.c.playerId] }, { playerIds: [P.d.playerId] }] } })).json.event;
    const dr = await api('POST', `/api/tennis/tournaments/${T2.tournamentId}/events/${ev.eventId}/draw`, { json: {} });
    ok('a draw of four: two semi-finals and a final', dr.status === 200 && dr.json.created === 3, dr.json);
    let tj = (await api('GET', `/api/tennis/tournaments/${T2.tournamentId}`)).json;
    const sf = tj.matches.find((x) => x.stage.round === 'Semi-final' && x.sides.A && x.sides.A.players[0].playerId === P.a.playerId);
    // a match tie-break only: first to 10
    const l2 = (await api('POST', `/api/tennis/matches/${sf.matchId}/lease`, { json: { deviceId: 'api' } })).json.leaseToken;
    let k = 0;
    const ev2 = (e) => api('POST', `/api/tennis/matches/${sf.matchId}/events`, { json: { leaseToken: l2, event: Object.assign({ eventId: 'sf' + (++k) + 'x' + Date.now().toString(36) }, e) } });
    await ev2({ type: 'TOSS', winner: 'A', choice: 'serve', firstServe: 'A', left: 'A' });
    await ev2({ type: 'START', server: sf.sides.A.players[0].playerId, left: 'A' });
    for (let i = 0; i < 10; i++) await ev2({ type: 'POINT', winner: 'A' });
    tj = (await api('GET', `/api/tennis/tournaments/${T2.tournamentId}`)).json;
    const fin = tj.matches.find((x) => x.stage.round === 'Final');
    ok('the semi-final is over 10-0 and its winner (only) is in the final', tj.matches.find((x) => x.matchId === sf.matchId).status === 'completed' && fin && ((fin.sides.A && fin.sides.A.players[0].playerId === P.a.playerId) || (fin.sides.B && fin.sides.B.players[0].playerId === P.a.playerId)) && !(fin.sides.A && fin.sides.B), fin && { A: fin.sides.A && fin.sides.A.name, B: fin.sides.B && fin.sides.B.name });
    const dp = await h.open('/tennis/tournament/' + T2.tournamentId, { viewport: { width: 1280, height: 860 }, who: null });
    await dp.waitForSelector('.bracket', { timeout: 15000 });
    const br = await dp.evaluate(() => Array.from(document.querySelectorAll('.bracket .round')).map((r) => ({ title: (r.querySelector('.rtitle') || {}).textContent, winners: Array.from(r.querySelectorAll('.bs.w')).map((x) => x.textContent.trim()), all: r.textContent.replace(/\s+/g, ' ') })));
    ok('the draw page: semi-finals, final, champion — the winner marked, and carried into the final', br.length === 3 && /Semi/.test(br[0].title) && br[0].winners.some((x) => /Alcaraz/.test(x)) && /Alcaraz/.test(br[1].all) && /To be decided/.test(br[2].all), br);
    await h.shot(dp, 'ui-draw');
    ok('the draw page fits a laptop', await noSideways(dp));

    head('7 · THE DASHBOARD, AND WHO MAY USE IT');
    const dash = await h.open('/tennis', { viewport: { width: 1280, height: 860 } });
    await dash.waitForSelector('#newt', { timeout: 15000 });
    ok('a tournament account sees its tournaments', /Pune Open 2026/.test(await dash.textContent('#app')));
    await dash.click('#newt');
    await dash.waitForSelector('#tname');
    await dash.fill('#tname', 'Dashboard Trophy 2026');
    await dash.click('#tsave');
    ok('…and creates one from the dashboard (the server has it)', await until(async () => (await api('GET', '/api/tennis/mine')).json.tournaments.some((x) => x.name === 'Dashboard Trophy 2026'), 6000));
    await h.shot(dash, 'ui-dashboard');
    const gdash = await h.open('/tennis', { viewport: { width: 390, height: 844 }, mobile: true, who: 'guest' });
    ok('another signed-in account: the dashboard says it is not a tournament account', await until(async () => /Not authorised/.test(await gdash.textContent('#app')), 8000), await gdash.textContent('#app'));
    const gpanel = await h.open('/tennis-panel?match=' + MID, { who: 'guest' });
    ok('…the panel opens view-only for it (no scoring)', await until(async () => /View only/.test(await gpanel.textContent('#main')), 8000));
    const gt = await guest('POST', '/api/tennis/tournaments', { json: { name: 'Sneaky Open' } });
    const ge = await guest('POST', `/api/tennis/matches/${MID}/events`, { json: { event: { eventId: 'g1x1', type: 'POINT', winner: 'A' } } });
    const gl = await guest('POST', `/api/tennis/matches/${MID}/lease`, { json: { deviceId: 'g' } });
    ok('…and the API refuses it: no tournament, no point, no control of the match', gt.status === 403 && ge.status === 403 && [403].includes(gl.status), [gt.status, ge.status, gl.status]);
    const priv = (await api('POST', '/api/tennis/tournaments', { json: { name: 'Members Night', visibility: 'private' } })).json.tournament;
    const pm = (await api('POST', `/api/tennis/tournaments/${priv.tournamentId}/matches`, { json: { format: 'singles', sideA: { playerIds: [P.c.playerId] }, sideB: { playerIds: [P.d.playerId] } } })).json.match;
    const gpm = await guest('GET', `/api/tennis/matches/${pm.matchId}`);
    const pub = (await H.call(h.port, 'GET', '/api/tennis/public/tournaments')).json.tournaments.map((x) => x.name);
    ok('a private tournament: its match is not found for others, and it is not in the public list', gpm.status === 404 && !pub.includes('Members Night') && pub.includes('Pune Open 2026'), { gpm: gpm.status, pub });
    const gmc = await h.open('/tennis/match/' + MID, { who: 'guest' });
    ok('…while the public match centre stays open to that account', await until(async () => /Alcaraz/.test(await gmc.textContent('#app')), 8000));
    ok('the dashboard (turned-away view) fits a phone', await noSideways(gdash));

    head('8 · THE PLAYER PAGE, THE OVERLAY LINKS, THE CLIPPER PAGE');
    const pp = await h.open('/tennis/player/' + P.a.playerId, { viewport: { width: 390, height: 844 }, mobile: true, who: null });
    await pp.waitForSelector('.tiles', { timeout: 15000 });
    text = await pp.textContent('#app');
    ok('the player page: the name, the country, the matches', /Carlos Alcaraz/.test(text) && /ESP/.test(text) && /Matches/.test(text), text.slice(0, 200));
    ok('…fits a phone', await noSideways(pp));
    const tp = await h.open('/tennis-templates', { viewport: { width: 1280, height: 860 } });
    await tp.waitForSelector('[data-copy]', { timeout: 15000 });
    const links = await tp.$$eval('[data-copy]', (b) => b.map((x) => x.dataset.copy));
    ok('the overlay links for the match: everything, graphics only, the wide bar, a preview monitor', links.some((u) => u.includes(MID) && !/layout=|monitor=/.test(u)) && links.some((u) => /layout=graphics/.test(u)) && links.some((u) => /layout=bar/.test(u)) && links.some((u) => /monitor=1/.test(u)) && links.every((u) => /\/tennis-overlay\?match=/.test(u)), links.slice(0, 4));
    const cp = await h.open('/tennis-clipper?match=' + MID, { viewport: { width: 1280, height: 860 } });
    ok('the Clipper page: the Tennis Clipper is not running on this PC — it says so (▶ Start Clipper)', await until(async () => /Not running|Start Clipper/.test(await cp.textContent('#clp')), 10000), (await cp.textContent('#clp')).slice(0, 200));

    head('9 · LAYOUT AND ERRORS');
    await panel.setViewportSize({ width: 1024, height: 768 });
    await sleep(300);
    ok('the panel at 1024 × 768: no sideways scroll', await noSideways(panel));
    ok('no page errors anywhere', h.pageErrors.length === 0, h.pageErrors);
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e.stack || e));
  } finally {
    await h.browser.close();
  }
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})();
