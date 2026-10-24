// 🎬 Broadcast graphics — PLAYING XI / TOSS / MATCH INTRO, end to end.
//
//   1. The server's rules (the REAL BROADCAST GRAPHICS block of server.js,
//      extracted by text, never copied): what each command does to the one
//      graphic of a match — timings, validation, the duration of the toss
//      (Hold included), stop / skip / a new time aimed at an older graphic
//      refused, a retried press starting nothing twice, the timer that ends
//      a graphic never ending a newer one, nothing unsafe reaching url().
//   2. The whole chain in Chromium: the REAL server.js (in-memory MongoDB),
//      the REAL overlay and BOTH REAL panels — Cricket Panel and Cricket
//      Panel 3 — driven through their own buttons:
//        • Playing XI from one panel → on the overlay with the real teams,
//          logos and XI (benched players left out, saved order, C / WK),
//          the other panel lit; team one 10 s readable, the handover, team
//          two 10 s readable, then off air on its own and the bar back
//        • stop from the other panel — during team one, the handover, team two
//        • skip to team two; the overlay reloaded mid-graphic carries on
//          where it is (no restart from team one)
//        • the toss: Hold stays up; a new time while it is up counts from
//          now; a finite time ends it by itself; hide during its entrance
//        • a graphic replacing another: the old one's timer can never take
//          the new one down; double presses start nothing twice
//        • missing data: no XI ticked / no toss result → the card says so,
//          nothing goes on air
//        • an overlay that asks for reduced motion still shows every graphic
//   3. The controls are one block, the same in both panels.
//
//   NODE_PATH=$(npm root -g) node test/cricket/broadcast-graphics-test.js
//   (needs playwright + chromium, and gsap from node_modules or its CDN)
const fs = require('fs');
const path = require('path');
const H = require('./server-harness');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const ok = (name, cond, detail) => eq(name + (cond ? '' : ` (${JSON.stringify(detail)})`), !!cond, true);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..', '..');

/* ------------------------------------------------------------------ */
/* 1. The server's rules                                               */
/* ------------------------------------------------------------------ */
function serverRules(){
  const src = H.src;
  const a = src.indexOf('const BCG_TIMING = '), b = src.indexOf('// 🩹 FIX: MATCH SCORECARD', a);
  if(a < 0 || b < 0) throw new Error('BROADCAST GRAPHICS block not found in server.js');
  const emitted = [];
  const io = { to: (room) => ({ emit: (ev, d) => emitted.push({ room, ev, d }) }) };
  const api = new Function('io', src.slice(a, src.lastIndexOf('// ====', b)) +
    '\nreturn { BCG_TIMING, bcgApplyCommand, bcgSet, bcgIdle, bcgPublic, bcgCleanData, bcgLogo, bcgTimers };')(io);
  return { ...api, emitted };
}
async function rules(){
  console.log('\n######## 1. The server\'s rules (server.js BROADCAST GRAPHICS) ########');
  const R = serverRules(), T = R.BCG_TIMING;
  const team = (name, n, pre) => ({ name, short: name.slice(0, 3).toUpperCase(), color: '#1d4ed8', logoUrl: '',
    players: Array.from({ length: n }, (_, i) => ({ id: pre + i, name: `${name} Player ${i + 1}`, captain: i === 0, keeper: i === 1 })) });
  const xiData = { teams: [team('Mumbai Indians', 11, 'a'), team('Chennai Super Kings', 11, 'b')], info: { tournament: 'Cup', venue: 'Wankhede' } };
  const now = 1_000_000;

  let r = R.bcgApplyCommand(null, { action: 'start', mode: 'playingXI', data: xiData, reqId: 'r1' }, now);
  const xi = r.next;
  eq('PLAYING XI starts: team two at enter + 10 s, off air after its own enter + 10 s',
    [r.ok, xi.mode, xi.startedAt, xi.xi.swapAt - now, xi.xi.endAt - xi.xi.swapAt], [true, 'playingXI', now, T.xiEnterMs + 10000, T.xiSwapMs + T.xiEnterMs + 10000]);
  eq('…each team has its full 10 s once it has come in (the handover does not eat into it)', [T.xiHoldMs, xi.xi.swapAt - T.xiHoldMs - now, xi.xi.endAt - T.xiHoldMs - xi.xi.swapAt - T.xiSwapMs], [10000, T.xiEnterMs, T.xiEnterMs]);
  eq('…both XIs kept, in order', xi.data.teams.map(t => [t.name, t.players.length, t.players[0].name, t.players[0].captain, t.players[1].keeper]),
    [['Mumbai Indians', 11, 'Mumbai Indians Player 1', true, true], ['Chennai Super Kings', 11, 'Chennai Super Kings Player 1', true, true]]);
  eq('the same press again (a retry) starts nothing new', R.bcgApplyCommand(xi, { action: 'start', mode: 'playingXI', data: xiData, reqId: 'r1' }, now + 50), { ok: true, next: null });
  const xi2 = R.bcgApplyCommand(xi, { action: 'start', mode: 'playingXI', data: xiData, reqId: 'r2' }, now + 60).next;
  ok('a new press does start it again — a new gid, a later seq', xi2.gid !== xi.gid && xi2.seq > xi.seq);

  eq('a team with no XI → nothing on air, and why',
    R.bcgApplyCommand(null, { action: 'start', mode: 'playingXI', data: { teams: [team('Mumbai Indians', 11, 'a'), team('Chennai Super Kings', 0, 'b')] } }, now),
    { ok: false, next: null, error: 'Chennai Super Kings has no Playing XI' });
  eq('an unnamed team → refused', R.bcgApplyCommand(null, { action: 'start', mode: 'matchIntro', data: { teamA: { name: 'A' }, teamB: { name: '' } } }, now).error, 'Both teams need a name');
  const dup = R.bcgCleanData('playingXI', { teams: [{ name: 'X', players: [{ id: 'p1', name: ' Rohit ' }, { id: 'p1', name: 'Rohit again' }, { name: '' }, { id: 'p2', name: 'Virat' }, { name: 'Virat' }] }, { name: 'Y', players: [{ name: 'Z' }] }] });
  eq('a lineup: each player once (by id), blanks dropped, names trimmed, its order kept', dup.teams[0].players.map(p => p.name), ['Rohit', 'Virat', 'Virat']);
  eq('…never more than 30', R.bcgCleanData('playingXI', { teams: [team('A', 40, 'a'), team('B', 3, 'b')] }).teams[0].players.length, 30);
  eq('only a picture can reach url(): data:image base64, http(s), a path here — nothing that ends the url()',
    ['data:image/png;base64,iVBORw0KGgo=', 'https://cdn.x/logo.png', '/uploads/a.png', 'javascript:alert(1)', 'https://x/a.png")', "https://x/a'b.png", 'data:text/html;base64,AAAA', 'data:image/svg+xml;utf8,<svg>'].map(R.bcgLogo),
    ['data:image/png;base64,iVBORw0KGgo=', 'https://cdn.x/logo.png', '/uploads/a.png', '', '', '', '', '']);
  eq('…and only a real colour', R.bcgCleanData('matchIntro', { teamA: { name: 'A', color: 'red;background:url(x)' }, teamB: { name: 'B', color: '#ABC' } }).teamA.color + '|' + R.bcgCleanData('matchIntro', { teamA: { name: 'A' }, teamB: { name: 'B', color: '#ABC' } }).teamB.color, '|#ABC');

  // TOSS
  const tossData = { teamA: { name: 'Mumbai Indians' }, teamB: { name: 'Chennai Super Kings' }, winner: 'B', decision: 'BOWL' };
  eq('the toss with no result recorded → refused', R.bcgApplyCommand(null, { action: 'start', mode: 'toss', data: { ...tossData, winner: '' } }, now).error, 'No toss result recorded');
  eq('…with no decision → refused', R.bcgApplyCommand(null, { action: 'start', mode: 'toss', data: { ...tossData, decision: 'FIELD?' } }, now).error, 'No toss decision recorded');
  const t15 = R.bcgApplyCommand(null, { action: 'start', mode: 'toss', data: tossData, durationSec: 15 }, now).next;
  eq('a 15 s toss counts from the end of its entrance', [t15.toss.durationSec, t15.toss.readyAt - now, t15.toss.expiresAt - t15.toss.readyAt], [15, T.tossEnterMs, 15000]);
  const tHold = R.bcgApplyCommand(null, { action: 'start', mode: 'toss', data: tossData, durationSec: null }, now).next;
  eq('Hold: no end at all (stays until hidden)', [tHold.toss.durationSec, tHold.toss.expiresAt, R.bcgApplyCommand(null, { action: 'start', mode: 'toss', data: tossData, durationSec: 'hold' }, now).next.toss.expiresAt], [null, null, null]);
  eq('times outside 1–3600 s are refused', [0, -5, 3601, 'abc'].map(d => R.bcgApplyCommand(null, { action: 'start', mode: 'toss', data: tossData, durationSec: d }, now).ok), [false, false, false, false]);
  eq('no time given → 10 s', R.bcgApplyCommand(null, { action: 'start', mode: 'toss', data: tossData }, now).next.toss.durationSec, 10);
  eq('the winner and the choice are the recorded ones', [t15.data.winner, t15.data.decision, t15.data.teamB.name], ['B', 'BOWL', 'Chennai Super Kings']);
  let d = R.bcgApplyCommand(t15, { action: 'duration', gid: t15.gid, durationSec: 60 }, now + 500).next;
  eq('a new time during the entrance → counts from the end of the entrance', [d.rev, d.toss.expiresAt - d.toss.readyAt], [2, 60000]);
  d = R.bcgApplyCommand(t15, { action: 'duration', gid: t15.gid, durationSec: 5 }, now + 9000).next;
  eq('a new time later on → counts from now', d.toss.expiresAt - (now + 9000), 5000);
  d = R.bcgApplyCommand(t15, { action: 'duration', gid: t15.gid, durationSec: null }, now + 9000).next;
  eq('…and Hold takes its end away', d.toss.expiresAt, null);
  eq('a new time aimed at an earlier graphic → refused, nothing changes', R.bcgApplyCommand(t15, { action: 'duration', gid: 'g-old', durationSec: 5 }, now).stale, true);

  // STOP / SKIP
  const intro = R.bcgApplyCommand(t15, { action: 'start', mode: 'matchIntro', data: { teamA: { name: 'A' }, teamB: { name: 'B' } } }, now + 100).next;
  eq('a stop for the toss that arrives after the intro replaced it → refused', R.bcgApplyCommand(intro, { action: 'stop', mode: 'toss', gid: t15.gid }, now + 200), { ok: false, next: null, stale: true, error: 'Another graphic is on air now' });
  const off = R.bcgApplyCommand(intro, { action: 'stop', mode: 'matchIntro', gid: intro.gid }, now + 300);
  eq('the right stop → off air, naming what ended', [off.ok, off.next.mode, off.next.gid, off.next.endedGid, off.next.endedMode, off.next.seq > intro.seq], [true, 'none', null, intro.gid, 'matchIntro', true]);
  eq('stop with nothing on air → fine, nothing changes', R.bcgApplyCommand(off.next, { action: 'stop', mode: 'matchIntro' }, now), { ok: true, next: null });
  const sk = R.bcgApplyCommand(xi, { action: 'skip', gid: xi.gid }, now + 4000).next;
  eq('skip → team two now, its full time after', [sk.rev, sk.xi.swapAt, sk.xi.endAt - sk.xi.swapAt], [2, now + 4000, T.xiSwapMs + T.xiEnterMs + 10000]);
  eq('skip once team two is up → nothing changes', R.bcgApplyCommand(sk, { action: 'skip', gid: xi.gid }, now + 6000), { ok: true, next: null });
  eq('skip aimed at an older graphic → refused', R.bcgApplyCommand(xi2, { action: 'skip', gid: xi.gid }, now).stale, true);
  ok('the idle state is never older than anything sent', R.bcgIdle().seq >= off.next.seq);

  // TIMERS (real ones, on the real bcgSet)
  const room = 'room-T1', state = {};
  R.emitted.length = 0;
  const shortToss = R.bcgApplyCommand(null, { action: 'start', mode: 'toss', data: tossData, durationSec: 1 }, Date.now()).next;
  R.bcgSet(room, state, shortToss);
  eq('bcgSet tells the room at once', R.emitted.map(e => [e.room, e.ev, e.d.gid]), [[room, 'cricketGraphicState', shortToss.gid]]);
  await sleep(T.tossEnterMs + 1000 + 300);
  eq('a 1 s toss goes off air by itself once its time is up', [state.cricketGraphic.mode, state.cricketGraphic.reason, state.cricketGraphic.endedGid, R.emitted.length], ['none', 'expired', shortToss.gid, 2]);
  const t1 = R.bcgApplyCommand(null, { action: 'start', mode: 'toss', data: tossData, durationSec: 1 }, Date.now()).next;
  R.bcgSet(room, state, t1);
  const replaced = R.bcgApplyCommand(t1, { action: 'start', mode: 'matchIntro', data: { teamA: { name: 'A' }, teamB: { name: 'B' } } }, Date.now()).next;
  R.bcgSet(room, state, replaced);
  await sleep(T.tossEnterMs + 1000 + 300);
  eq('the toss\'s timer never takes down the intro that replaced it', [state.cricketGraphic.gid, state.cricketGraphic.mode], [replaced.gid, 'matchIntro']);
  R.bcgSet(room, state, R.bcgApplyCommand(replaced, { action: 'stop', gid: replaced.gid }, Date.now()).next);
  eq('nothing left armed', Object.keys(R.bcgTimers), []);
  eq('what the server sends carries its clock and the timings', Object.keys(R.bcgPublic({ mode: 'none' })).sort(), ['mode', 'serverNow', 'timing']);
}

/* ------------------------------------------------------------------ */
/* 2. The whole chain in Chromium                                      */
/* ------------------------------------------------------------------ */
const tryResolve = (p) => { try { return require.resolve(p); } catch(e){ return null; } };
const GSAP = tryResolve('gsap/dist/gsap.min.js');
const PNG = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'favicon-32x32.png')).toString('base64');
const ROOM = 'BCGE2E' + Math.random().toString(36).slice(2, 6);
const XI_A = ['Rohit Sharma', 'Yashasvi Jaiswal', 'Shubman Gill', 'Virat Kohli', 'Suryakumar Yadav', 'Rishabh Pant', 'Hardik Pandya', 'Ravindra Jadeja', 'Axar Patel', 'Jasprit Bumrah', 'Mohammed Siraj'];
const XI_B = ['Ruturaj Gaikwad', 'Devon Conway', 'Ajinkya Rahane', 'Shivam Dube', 'Moeen Ali', 'MS Dhoni', 'Ravindra Jadeja', 'Deepak Chahar', 'Tushar Deshpande', 'Matheesha Pathirana', 'Maheesh Theekshana'];
// the match as an operator sets it up: squads with one benched player each, captain + keeper, a logo for one side
const MATCH = {
  teamA: { name: 'Mumbai Indians', short: 'MI', color: '#1d4ed8', logoUrl: PNG,
    players: [...XI_A.map((n, i) => ({ id: 'MI' + i, name: n, isXI: true })), { id: 'MI99', name: 'Benched Batter', isXI: false }], captainId: 'MI0', wkId: 'MI5' },
  teamB: { name: 'Chennai Super Kings', short: 'CSK', color: '#f5c518', logoUrl: '',
    players: [{ id: 'CSK99', name: 'Benched Bowler', isXI: false }, ...XI_B.map((n, i) => ({ id: 'CSK' + i, name: n, isXI: true }))], captainId: 'CSK5', wkId: 'CSK5' },
  toss: { winner: 'B', decision: 'BOWL' }, venue: 'Wankhede Stadium, Mumbai', matchDate: '2026-10-24', matchStage: 'Final'
};

async function chain(){
  console.log('\n######## 2. Cricket Panel + Cricket Panel 3 + the overlay, on the real server ########');
  const { chromium } = require('playwright');
  const { bootServer } = require('../server-boot.js');
  const { port } = await bootServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  const errors = { overlay: [], panel: [], panel3: [] };
  async function open(kind, url, w, h){
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors[kind].push(e.message));
    await page.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if(u.hostname === '127.0.0.1') return route.continue();
      if(u.hostname === 'cdnjs.cloudflare.com' && /gsap/.test(u.pathname) && GSAP) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(GSAP) });
      if(/\.js$/.test(u.pathname)) return route.fulfill({ contentType: 'text/javascript', body: '' });
      if(/fonts\.googleapis/.test(u.hostname)) return route.fulfill({ contentType: 'text/css', body: '' });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto(base + url);
    return { ctx, page };
  }
  try {
    const OV = await open('overlay', `/cricket-overlay?room=${ROOM}`, 1280, 720);
    const P1 = await open('panel', `/cricket-panel?room=${ROOM}`, 1500, 950);
    const P3 = await open('panel3', `/cricket-panel3?room=${ROOM}`, 1500, 950);
    const connected = (P) => P.page.waitForFunction(() => { try { return socket && socket.connected; } catch(e){ return false; } }, null, { timeout: 15000 });
    await connected(P1); await connected(P3);
    // both laptops have this match loaded (each panel's own state, as when it is opened on it)
    for(const P of [P1, P3]){
      await P.page.evaluate((M) => {
        Object.assign(state.teamA, JSON.parse(JSON.stringify(M.teamA)));
        Object.assign(state.teamB, JSON.parse(JSON.stringify(M.teamB)));
        state.toss = { ...M.toss }; state.venue = M.venue; state.matchDate = M.matchDate; state.matchStage = M.matchStage;
        renderSquadUI(); renderPanel();
      }, MATCH);
    }
    await OV.page.waitForFunction(() => window.gsap && document.getElementById('bcg'), null, { timeout: 15000 });
    await sleep(600);

    const ov = () => OV.page.evaluate(() => {
      const live = [...document.querySelectorAll('#bcg .bcg-scene')].filter(s => !s.dataset.leaving);
      const s = live[0];
      const page = s && s.querySelector('.xi-page[style*="visible"]') ;
      return { on: document.getElementById('bcg').classList.contains('on'), scenes: document.querySelectorAll('#bcg .bcg-scene').length, live: live.length,
        mode: s ? s.dataset.mode : null, phase: s ? s.dataset.phase || null : null, hold: s ? s.dataset.hold || null : null,
        team: page ? page.querySelector('.xi-name').textContent : null,
        names: page ? [...page.querySelectorAll('.xi-nm')].map(e => e.textContent) : null,
        tags: page ? [...page.querySelectorAll('.xi-row')].filter(r => r.querySelector('.xi-tag')).map(r => r.querySelector('.xi-nm').textContent + ':' + [...r.querySelectorAll('.xi-tag')].map(t => t.textContent).join('+')) : null,
        bar: +getComputedStyle(document.getElementById('scorecard')).opacity };
    });
    const btn = (P, id) => P.page.evaluate((id) => { const b = document.getElementById(id); return { on: b.classList.contains('on'), pressed: b.getAttribute('aria-pressed'), sub: b.querySelector('small').textContent }; }, id);
    const air = (P) => P.page.evaluate(() => document.getElementById('bcg-air').textContent);
    const msg = (P) => P.page.evaluate(() => { const m = document.getElementById('bcg-msg'); return m.hidden ? '' : m.textContent; });
    const until = async (fn, test, ms) => { const end = Date.now() + (ms || 8000); let v; while(Date.now() < end){ v = await fn(); if(test(v)) return v; await sleep(100); } return v; };

    ok('the card sits right above the team squads, in both panels', (await Promise.all([P1, P3].map(P => P.page.evaluate(() => {
      const c = document.getElementById('card-broadcast-graphics'), s = document.getElementById('card-team-squads');
      return c && c.nextElementSibling === s && ['bcg-xi-btn', 'bcg-toss-btn', 'bcg-intro-btn'].every(id => document.getElementById(id));
    })))).every(Boolean));
    eq('before anything: off air everywhere', [await air(P1), await air(P3), (await ov()).on], ['Off air', 'Off air', false]);

    // —— PLAYING XI from Cricket Panel, the full sequence, timed on the overlay ——
    await OV.page.evaluate(() => {
      window.__marks = [];
      const t0 = performance.now();
      new MutationObserver(() => {
        const s = document.querySelector('#bcg .bcg-scene:not([data-leaving])');
        const k = s ? s.dataset.mode + ':' + (s.dataset.phase || '') : 'none';
        if(!window.__marks.length || window.__marks[window.__marks.length - 1][0] !== k) window.__marks.push([k, Math.round(performance.now() - t0)]);
      }).observe(document.getElementById('bcg'), { subtree: true, attributes: true, childList: true });
    });
    await P1.page.click('#bcg-xi-btn');
    let o = await until(ov, v => v.phase === 'team1');
    eq('PLAYING XI (Cricket Panel) → the overlay: team one, its real XI in its saved order, the benched player left out',
      [o.mode, o.team, o.names], ['playingXI', 'Mumbai Indians', XI_A]);
    eq('…captain and keeper marked on the right players', o.tags, ['Rohit Sharma:C', 'Rishabh Pant:WK']);
    eq('…Cricket Panel 3 shows it on air too (and Cricket Panel)', [(await btn(P3, 'bcg-xi-btn')).on, (await btn(P3, 'bcg-xi-btn')).pressed, await air(P3), (await btn(P1, 'bcg-xi-btn')).on], [true, 'true', 'On air · Playing XI', true]);
    ok('…the score bar has stepped off air', (await until(ov, v => v.bar < 0.05, 3000)).bar < 0.05);
    eq('…the logo is the team\'s own picture; the side without one shows its initials', await OV.page.evaluate(() => [...document.querySelectorAll('#bcg .xi-logo .bcg-plate')].map(p => p.classList.contains('mono') ? 'mono:' + p.textContent.trim() : (p.querySelector('.bcg-plate-img').style.backgroundImage.startsWith('url("data:image/png;base64,') ? 'png' : '?'))), ['png', 'mono:CSK']);
    await sleep(10500);
    o = await ov();
    eq('10.5 s later: still team one (its 10 readable seconds come after its 1.5 s entrance)', [o.phase, o.team], ['team1', 'Mumbai Indians']);
    o = await until(ov, v => v.phase === 'team2', 3000);
    await sleep(2600);
    o = await ov();
    eq('then team two, with its own XI (its benched player left out, captain and keeper the same man)', [o.phase, o.team, o.names, o.tags], ['team2', 'Chennai Super Kings', XI_B, ['MS Dhoni:C+WK']]);
    o = await until(ov, v => !v.on, 14000);
    eq('…and when its time is up: gone from the overlay, nothing left behind', [o.on, o.scenes], [false, 0]);
    const marks = await OV.page.evaluate(() => window.__marks);
    const at = (k) => (marks.find(m => m[0] === k) || [0, NaN])[1];
    const team1 = at('playingXI:team2') - at('playingXI:team1'), team2 = at('none') - at('playingXI:team2');
    ok(`team one on screen ${team1} ms (1.5 s in + 10 s readable)`, team1 >= 11300 && team1 <= 12600, marks);
    // (the mark is where its exit begins: the handover, team two's 1.5 s entrance — begun under the
    // handover's last 0.2 s — and then 10 s readable)
    ok(`team two on screen ${team2} ms (handover + 1.5 s in + 10 s readable)`, team2 >= 12200 && team2 <= 13200, marks);
    eq('…both panels back to off air', [await air(P1), await air(P3), (await btn(P3, 'bcg-xi-btn')).on], ['Off air', 'Off air', false]);
    ok('…and the score bar back on air', (await until(ov, v => v.bar > 0.95, 4000)).bar > 0.95);

    // —— stop from the OTHER panel: during team one, the handover, team two ——
    for(const [label, wait, skip] of [['during team one', 1200, false], ['during the handover', 300, true], ['during team two', 3000, true]]){
      await P1.page.click('#bcg-xi-btn');
      await until(ov, v => v.phase === 'team1');
      if(skip){ await until(() => btn(P3, 'bcg-xi-btn'), v => v.on); await P3.page.click('#bcg-xi-skip'); await until(ov, v => v.phase === 'team2'); }
      await sleep(wait);
      await until(() => btn(P3, 'bcg-xi-btn'), v => v.on);
      await P3.page.click('#bcg-xi-stop');
      o = await until(ov, v => !v.on, 4000);
      eq(`stop from Cricket Panel 3 ${label} → gone at once, both panels off air`, [o.on, o.scenes, await air(P1), await air(P3)], [false, 0, 'Off air', 'Off air']);
    }

    // —— skip, then the overlay reloaded mid-graphic ——
    await P3.page.click('#bcg-xi-btn');
    await until(ov, v => v.phase === 'team1');
    await until(() => btn(P1, 'bcg-xi-btn'), v => v.on);
    await P1.page.click('#bcg-xi-skip');
    o = await until(ov, v => v.phase === 'team2' && v.team === 'Chennai Super Kings');
    eq('⏭ Next team now (Cricket Panel) → team two straight away', [o.phase, o.team], ['team2', 'Chennai Super Kings']);
    await OV.page.reload();
    await OV.page.waitForFunction(() => window.gsap && document.getElementById('bcg'));
    await OV.page.evaluate(() => {
      window.__seen = [];
      new MutationObserver(() => { const s = document.querySelector('#bcg .bcg-scene'); if(s && s.dataset.phase) window.__seen.push(s.dataset.phase); })
        .observe(document.getElementById('bcg'), { subtree: true, attributes: true, childList: true });
    });
    o = await until(ov, v => v.phase === 'team2' && v.team === 'Chennai Super Kings', 5000);
    eq('the overlay reloaded mid-graphic → team two, where the graphic is — never team one again', [o.phase, o.team, (await OV.page.evaluate(() => window.__seen)).includes('team1')], ['team2', 'Chennai Super Kings', false]);
    await P1.page.click('#bcg-xi-stop');
    await until(ov, v => !v.on, 4000);

    // —— TOSS from Cricket Panel 3: Hold, a new time while it is up, the end by itself ——
    await P3.page.click('#bcg-toss-btn');
    await P3.page.click('#bcg-dur-chips button[data-dur="hold"]');
    eq('the toss card: the recorded result, Hold picked', await P3.page.evaluate(() => [document.getElementById('bcg-toss-result').textContent, document.querySelector('#bcg-dur-chips [aria-checked="true"]').dataset.dur]),
      ['Chennai Super Kings won the toss · elected to bowl first', 'hold']);
    await P3.page.click('#bcg-toss-show');
    o = await until(ov, v => v.mode === 'toss');
    const tossText = await OV.page.evaluate(() => [document.querySelector('#bcg .toss-name').textContent, document.querySelector('#bcg .toss-dec').textContent, [...document.querySelectorAll('#bcg .toss-fix b')].map(b => b.textContent)]);
    eq('SHOW TOSS (Cricket Panel 3) → the overlay: the recorded winner and choice, both teams', tossText, ['Chennai Super Kings', 'ELECTED TO BOWL FIRST', ['Mumbai Indians', 'Chennai Super Kings']]);
    eq('…Cricket Panel shows it on air, held', [await air(P1), o.hold], ['On air · Toss', 'until-hidden']);
    await sleep(5000);
    eq('Hold: still up 5 s later — no hidden time limit', (await ov()).mode, 'toss');
    await until(() => btn(P1, 'bcg-toss-btn'), v => v.on);
    await P1.page.click('#bcg-toss-btn');
    await P1.page.click('#bcg-dur-chips button[data-dur="5"]');
    o = await until(ov, v => v.hold === '5', 3000);
    eq('5 s picked in Cricket Panel while it is up → the overlay holds it 5 s from now', o.hold, '5');
    const left = await until(() => P1.page.evaluate(() => document.getElementById('bcg-toss-status').textContent), t => /On air — [1-5] s left/.test(t), 2000);
    ok('…the panel counts it down', /On air — [1-5] s left/.test(left), left);
    o = await until(ov, v => !v.on, 8000);
    eq('…and it goes off air by itself, everywhere', [o.on, await air(P1), await air(P3)], [false, 'Off air', 'Off air']);

    // —— hide during its entrance ——
    await P1.page.click('#bcg-dur-chips button[data-dur="30"]');
    await P1.page.click('#bcg-toss-show');
    await until(ov, v => v.mode === 'toss');
    await until(() => btn(P3, 'bcg-toss-btn'), v => v.on);
    await P3.page.click('#bcg-toss-btn');
    await P3.page.click('#bcg-toss-hide');
    o = await until(ov, v => !v.on, 3000);
    eq('HIDE TOSS (Cricket Panel 3) during its entrance → gone at once', [o.on, o.scenes], [false, 0]);

    // —— a graphic replacing another; the old timer cannot take the new one down ——
    await P1.page.click('#bcg-dur-chips button[data-dur="5"]');
    await P1.page.click('#bcg-toss-show');
    await until(ov, v => v.mode === 'toss');
    await P3.page.click('#bcg-intro-btn');
    o = await until(ov, v => v.mode === 'matchIntro' && v.scenes === 1, 3000);
    eq('MATCH INTRO while the toss is up → the intro alone on the overlay', [o.mode, o.live, o.scenes], ['matchIntro', 1, 1]);
    await sleep(8000);
    o = await ov();
    eq('…past the toss\'s 5 s: the intro is still up (holds until stopped)', [o.mode, o.phase, await air(P1)], ['matchIntro', 'intro', 'On air · Match Intro']);
    eq('…the intro shows the real teams and this match\'s details', await OV.page.evaluate(() => [...document.querySelectorAll('#bcg .intro-name')].map(e => e.textContent).concat([...document.querySelectorAll('#bcg .intro-ii')].map(e => e.textContent))),
      ['Mumbai Indians', 'Chennai Super Kings', 'Final', 'T20', 'Wankhede Stadium, Mumbai', '24 OCT 2026']);
    await P1.page.click('#bcg-intro-btn');
    o = await until(ov, v => !v.on, 3000);
    eq('MATCH INTRO pressed again (Cricket Panel) = stop → gone', [o.on, await air(P3)], [false, 'Off air']);
    // stopped in its opening seconds
    await P1.page.click('#bcg-intro-btn');
    await until(ov, v => v.mode === 'matchIntro');
    await sleep(900);
    await until(() => btn(P3, 'bcg-intro-btn'), v => v.on);
    await P3.page.click('#bcg-intro-stop');
    o = await until(ov, v => !v.on, 3000);
    eq('STOP INTRO (Cricket Panel 3) in its opening → gone at once', [o.on, o.scenes], [false, 0]);

    // —— double presses ——
    await P1.page.dblclick('#bcg-xi-btn');
    await sleep(1500);
    o = await ov();
    eq('a double click on PLAYING XI → one Playing XI, not two (and not started-then-stopped)', [o.mode, o.scenes], ['playingXI', 1]);
    await P1.page.click('#bcg-xi-btn');
    await until(ov, v => !v.on, 3000);

    // —— missing data ——
    await P1.page.evaluate(() => { state.toss = { winner: '', decision: 'BAT' }; state.teamB.players.forEach(p => { p.isXI = false; }); renderPanel(); });
    await P1.page.click('#bcg-xi-btn');
    await sleep(400);
    eq('no XI ticked for a side → the card says so, nothing goes on air', [await msg(P1), (await ov()).on],
      ['Chennai Super Kings has no Playing XI yet — add the players and tick "XI" in Team Squads below.', false]);
    await P1.page.click('#bcg-toss-show');
    await sleep(400);
    eq('no toss result recorded → the card says so, nothing goes on air', [await msg(P1), (await ov()).on, await P1.page.evaluate(() => document.getElementById('bcg-toss-result').textContent.trim().startsWith('⚠ No toss result recorded yet'))],
      ['No toss result recorded yet — pick who won in the 🪙 Toss card.', false, true]);

    // —— an output that asks for reduced motion: the same graphics, fading instead of moving ——
    const RM = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const rmPage = await RM.newPage();
    rmPage.on('pageerror', e => errors.overlay.push(e.message));
    await rmPage.route('**/*', (route) => { const u = new URL(route.request().url()); if(u.hostname === '127.0.0.1') return route.continue();
      if(/gsap/.test(u.pathname) && GSAP) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(GSAP) }); return route.fulfill({ status: 404, body: '' }); });
    await rmPage.goto(`${base}/cricket-overlay?room=${ROOM}`);
    await rmPage.waitForFunction(() => window.gsap && document.getElementById('bcg'));
    await P1.page.evaluate((M) => { state.toss = { ...M.toss }; Object.assign(state.teamB, JSON.parse(JSON.stringify(M.teamB))); renderPanel(); }, MATCH);
    await P1.page.click('#bcg-xi-btn');
    await sleep(1200);
    eq('reduced motion: PLAYING XI fully there within a second (team, all eleven)', await rmPage.evaluate(() => {
      const p = document.querySelector('#bcg .xi-page[style*="visible"]');
      return p ? [+getComputedStyle(p).opacity, p.querySelector('.xi-name').textContent, p.querySelectorAll('.xi-nm').length] : null;
    }), [1, 'Mumbai Indians', 11]);
    await P1.page.click('#bcg-xi-btn');
    await rmPage.waitForFunction(() => !document.getElementById('bcg').classList.contains('on'), null, { timeout: 4000 }).catch(() => {});
    eq('…and gone when stopped', await rmPage.evaluate(() => document.querySelectorAll('#bcg .bcg-scene').length), 0);
    await RM.close();

    eq('no script errors on the overlay', errors.overlay, []);
    eq('no script errors from the graphics in either panel', [...errors.panel, ...errors.panel3].filter(e => /bcg|cricketGraphic/i.test(e)), []);
    await OV.ctx.close(); await P1.ctx.close(); await P3.ctx.close();
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ */
/* 3. One block, the same in both panels                               */
/* ------------------------------------------------------------------ */
function sameInBothPanels(){
  console.log('\n######## 3. The controls are the same in both panels ########');
  const cut = (f, a, b) => { const s = fs.readFileSync(path.join(ROOT, f), 'utf8'); const i = s.indexOf(a), j = s.indexOf(b, i); if(i < 0 || j < 0) throw new Error(`${f}: marker not found: ${a}`); return s.slice(i, j); };
  for(const [what, a, b] of [
    ['the script', '/* ============================================================\n   🎬 BROADCAST GRAPHICS — Playing XI / Toss / Match Intro', '\nbcgRender();\n'],
    ['the card', '<!-- 🎬 BROADCAST GRAPHICS — Playing XI / Toss / Match Intro, full screen on', '<div class="card squad-hub" id="card-team-squads">'],
    ['its styles', '/* 🎬 BROADCAST GRAPHICS — the three full-screen graphics', 'html[data-theme="light"] .bcg-msg.bad']
  ]) eq(`${what}: cricket-panel.html = cricket-panel3.html`, cut('cricket-panel.html', a, b) === cut('cricket-panel3.html', a, b), true);
}

(async () => {
  sameInBothPanels();
  await rules();
  if(process.env.ONLY !== 'rules') await chain();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
