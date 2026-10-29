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
    '\nreturn { BCG_TIMING, BCG_PREF_DEFAULTS, bcgApplyCommand, bcgApplyPrefs, bcgEndsAt, bcgSet, bcgIdle, bcgPublic, bcgCleanData, bcgLogo, bcgTimers };')(io);
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

  // PLAYING XI — AUTO 10 s / HOLD until hidden
  const xh = R.bcgApplyCommand(null, { action: 'start', mode: 'playingXI', data: xiData, xiMode: 'hold' }, now).next;
  eq('HOLD: no clock at all — team two only on NEXT TEAM, off air only when hidden', [xh.xi.hold, xh.xi.swapAt, xh.xi.endAt, R.bcgEndsAt(xh)], [true, null, null, null]);
  const nx = R.bcgApplyCommand(xh, { action: 'skip', gid: xh.gid }, now + 30000).next;
  eq('NEXT TEAM on HOLD → team two now, and still held', [nx.rev, nx.xi.hold, nx.xi.swapAt, nx.xi.endAt], [2, true, now + 30000, null]);
  eq('…NEXT TEAM again once team two is up → nothing changes', R.bcgApplyCommand(nx, { action: 'skip', gid: xh.gid }, now + 31000), { ok: true, next: null });
  let m = R.bcgApplyCommand(xh, { action: 'xiMode', gid: xh.gid, xiMode: 'auto' }, now + 500).next;
  eq('AUTO while team one is held and still coming in → its 10 s from the end of its entrance, then team two\'s',
    [m.xi.hold, m.xi.swapAt - now, m.xi.endAt - m.xi.swapAt], [false, T.xiEnterMs + 10000, T.xiSwapMs + T.xiEnterMs + 10000]);
  m = R.bcgApplyCommand(xh, { action: 'xiMode', xiMode: 'auto' }, now + 60000).next;
  eq('AUTO after a minute on team one → its 10 s from now', m.xi.swapAt - (now + 60000), 10000);
  m = R.bcgApplyCommand(nx, { action: 'xiMode', xiMode: 'auto' }, now + 40000).next;
  eq('AUTO while team two is held → its 10 s from now, then off air', [m.xi.swapAt, m.xi.endAt - (now + 40000)], [now + 30000, 10000]);
  m = R.bcgApplyCommand(xi, { action: 'xiMode', gid: xi.gid, xiMode: 'hold' }, now + 4000).next;
  eq('HOLD while AUTO team one is up → its clock stops where it is (no team two, no end)', [m.xi.hold, m.xi.swapAt, m.xi.endAt], [true, null, null]);
  m = R.bcgApplyCommand(sk, { action: 'xiMode', xiMode: 'hold' }, now + 6000).next;
  eq('HOLD while AUTO team two is up → team two stays, no end', [m.xi.swapAt, m.xi.endAt], [now + 4000, null]);
  eq('the same mode again → nothing changes', R.bcgApplyCommand(xh, { action: 'xiMode', xiMode: 'hold' }, now), { ok: true, next: null });
  eq('a mode change aimed at an older graphic → refused', R.bcgApplyCommand(xh, { action: 'xiMode', gid: 'g-old', xiMode: 'auto' }, now).stale, true);
  const held = {};
  R.bcgSet('room-T2', held, xh);
  eq('a held Playing XI arms no timer that could take it down', Object.keys(R.bcgTimers), []);

  // MATCH INTRO — HOLD until hidden, or a time
  const ih = R.bcgApplyCommand(null, { action: 'start', mode: 'matchIntro', data: { teamA: { name: 'A' }, teamB: { name: 'B' } } }, now).next;
  eq('the intro holds by default — its final picture has no end', [ih.intro.durationSec, ih.intro.readyAt - now, ih.intro.expiresAt, R.bcgEndsAt(ih)], [null, T.introEnterMs, null, null]);
  const i30 = R.bcgApplyCommand(null, { action: 'start', mode: 'matchIntro', data: { teamA: { name: 'A' }, teamB: { name: 'B' } }, durationSec: 30 }, now).next;
  eq('…or 30 s once its sequence has played', i30.intro.expiresAt - i30.intro.readyAt, 30000);
  eq('…a new time while it is up counts from now', R.bcgApplyCommand(ih, { action: 'duration', gid: ih.gid, durationSec: 15 }, now + 20000).next.intro.expiresAt - (now + 20000), 15000);

  // MANUAL SCORECARDS
  const card = (o) => ({ kind: 'bat', inningsNo: 2, label: '2ND INNINGS', batting: { name: 'CSK' }, bowling: { name: 'MI' },
    batters: [{ id: 'c1', name: 'Gaikwad', runs: 12, balls: 9, status: 'out', howOut: 'b Bumrah' }, { id: 'c1', name: 'Gaikwad again', runs: 99 }, { id: 'c2', name: 'Conway', runs: 'abc', status: 'striker' }],
    bowlers: [{ id: 'm9', name: 'Bumrah', overs: '1.2', wickets: 1, current: true }],
    groups: [{ label: 'YET TO BAT', names: ['Dube', 'Dube', 'Dhoni', ''] }, { label: 'NOT IN XI', names: [] }], total: { runs: 48, wickets: 1, overs: '6.2', extras: { wd: 2 } }, ...o });
  const cd = R.bcgCleanData('scorecard', card({}));
  eq('a scorecard keeps its real rows — each player once (by id), a non-number shown as nothing, its order kept',
    [cd.batters.map(b => [b.name, b.runs, b.status]), cd.bowlers.map(b => [b.name, b.overs, b.current])], [[['Gaikwad', 12, 'out'], ['Conway', null, 'striker']], [['Bumrah', '1.2', true]]]);
  eq('…the rest of the squad by name only, each once; an empty group left out', cd.groups, [{ label: 'YET TO BAT', names: ['Dube', 'Dhoni'] }]);
  eq('a batting card with nobody batted / a bowling card with no bowling → refused, with why',
    [R.bcgCleanData('scorecard', card({ batters: [] })).error, R.bcgCleanData('scorecard', card({ kind: 'bowl', bowlers: [] })).error, R.bcgCleanData('scorecard', card({ inningsNo: 7 })).error],
    ['No batting in this innings yet', 'No bowling figures in this innings yet', 'Pick an innings first']);
  const sc1 = R.bcgApplyCommand(null, { action: 'start', mode: 'scorecard', data: card({}) }, now).next;
  eq('a manual scorecard is pinned by default (no end); 15 s once it has come in when asked', [sc1.card.expiresAt, R.bcgApplyCommand(null, { action: 'start', mode: 'scorecard', data: card({}), durationSec: 15 }, now).next.card.expiresAt - now],
    [null, T.cardEnterMs + 15000]);

  // THE SHARED CHOICES
  const P0 = { ...R.BCG_PREF_DEFAULTS, seq: 1 };
  let pr = R.bcgApplyPrefs(P0, null, { innings: 2, xiMode: 'hold', cardDur: 30 }, now);
  eq('choices are kept (innings, AUTO / HOLD, times) with a newer seq', [pr.prefs.innings, pr.prefs.xiMode, pr.prefs.cardDur, pr.prefs.tossDur, pr.prefs.seq > 1, pr.next], [2, 'hold', 30, 10, true, null]);
  eq('…"live" (null) innings and Hold (null) are choices too', [R.bcgApplyPrefs(pr.prefs, null, { innings: null, cardDur: null }, now).prefs.innings, R.bcgApplyPrefs(pr.prefs, null, { cardDur: null }, now).prefs.cardDur], [null, null]);
  eq('…anything else is refused', [{ innings: 9 }, { innings: 'x' }, { xiMode: 'sometimes' }, { tossDur: 0 }, { introDur: 99999 }].map(p => R.bcgApplyPrefs(P0, null, p, now).error),
    ['Unknown innings', 'Unknown innings', 'Playing XI is AUTO or HOLD', `Time on screen must be 1–3600 seconds, or Hold`, `Time on screen must be 1–3600 seconds, or Hold`]);
  eq('HOLD picked while AUTO Playing XI is up → applied to it at once', R.bcgApplyPrefs(P0, xi, { xiMode: 'hold' }, now + 4000).next.xi, { hold: true, swapAt: null, endAt: null });
  eq('a scorecard time picked while one is up → from now', R.bcgApplyPrefs(P0, sc1, { cardDur: 30 }, now + 5000).next.card.expiresAt - (now + 5000), 30000);
  eq('…a time for another graphic leaves the one on air alone', R.bcgApplyPrefs(P0, sc1, { introDur: 30 }, now + 5000).next, null);
  eq('what the server sends carries its clock and the timings', Object.keys(R.bcgPublic({ mode: 'none' })).sort(), ['mode', 'serverNow', 'timing']);
}

// The overlay's own reading of the knockout round (koRound in cricket-overlay.html)
function knockoutRounds(){
  console.log('\n######## 1b. The knockout round, read from the match\'s stage / title (cricket-overlay.html koRound) ########');
  const src = fs.readFileSync(path.join(ROOT, 'cricket-overlay.html'), 'utf8');
  const a = src.indexOf('  function koRound(info){'), b = src.indexOf('\n  }\n', a);
  if(a < 0 || b < 0) throw new Error('koRound not found in cricket-overlay.html');
  const koRound = new Function(src.slice(a, b + 4) + '\nreturn koRound;')();
  const read = (stage, matchTitle) => { const r = koRound({ stage, matchTitle }); return r ? `${r.tier}:${r.label}:${r.key}` : null; };
  eq('as organisers type it → the round, in one spelling', [
    read('SEMI - FINAL MATCH', 'MATCH 10'), read('Semi Final 2', ''), read('semifinal', ''), read('Final', 'Match 15'), read('GRAND FINAL', ''),
    read('Quarter-Final 3', ''), read('Pre Quarter Final', ''), read('Eliminator', ''), read('', 'Qualifier 2'), read('Play-offs', ''), read('3rd place match', '')
  ], ['semi:SEMI-FINAL:stage', 'semi:SEMI-FINAL 2:stage', 'semi:SEMI-FINAL:stage', 'final:FINAL:stage', 'final:GRAND FINAL:stage',
      'ko:QUARTER-FINAL 3:stage', 'ko:PRE-QUARTER-FINAL:stage', 'ko:ELIMINATOR:stage', 'ko:QUALIFIER 2:matchTitle', 'ko:PLAY-OFF:stage', 'ko:3RD PLACE PLAY-OFF:stage']);
  eq('a league game, or nothing typed → no round (and "Finalists" / "Semifinalist" are not one)',
    [read('League', 'Match 4'), read('', ''), read(null, undefined), read('Group A', 'Finalists Cup'), read('Semifinalist play', '')], [null, null, null, null, null]);
  eq('…the tournament\'s own name is never read for it', koRound({ tournament: 'Premier League Finals 2026', stage: 'League' }), null);
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

// A match in its 2nd innings, as the panels keep it: innings 1 archived (Mumbai
// Indians 160/7 in 20 overs), Chennai Super Kings chasing 161 at 48/1 after
// 6.2 overs — with one batting row recorded twice (the same player id).
const bat = (id, name, runs, balls, fours, sixes, out, howOut, inn) => ({ id, name, runs, balls, fours, sixes, out, howOut, inningsNo: inn });
const bowl = (id, name, overs, balls, maidens, runs, wickets, inn) => ({ id, name, overs, balls, maidens, runs, wickets, inningsNo: inn });
const INN = {
  format: 'T20', inningsNumber: 2, battingTeam: 'B', target: 161, phase: 'REGULATION',
  inningsArchive: [{ no: 1, team: 'A', runs: 160, wickets: 7, overs: '20.0', declared: false, extras: { wd: 4, nb: 1, b: 0, lb: 2, pen: 0 } }],
  battingCard: {
    A: [bat('MI0', 'Rohit Sharma', 34, 22, 4, 1, true, 'c Dhoni b Chahar', 1), bat('MI1', 'Yashasvi Jaiswal', 12, 10, 2, 0, true, 'b Pathirana', 1),
      bat('MI2', 'Shubman Gill', 41, 30, 3, 2, true, 'c Dube b Jadeja', 1), bat('MI3', 'Virat Kohli', 22, 18, 1, 1, true, 'lbw b Theekshana', 1),
      bat('MI4', 'Suryakumar Yadav', 9, 6, 1, 0, true, 'run out (Conway)', 1), bat('MI5', 'Rishabh Pant', 15, 11, 2, 0, true, 'st Dhoni b Jadeja', 1),
      bat('MI6', 'Hardik Pandya', 6, 7, 0, 0, true, 'c Gaikwad b Pathirana', 1), bat('MI7', 'Ravindra Jadeja', 8, 9, 0, 0, false, 'not out', 1),
      bat('MI8', 'Axar Patel', 6, 7, 0, 0, false, 'not out', 1), bat('MI0', 'Rohit Sharma', 34, 22, 4, 1, true, 'c Dhoni b Chahar', 1)],
    B: [bat('CSK0', 'Ruturaj Gaikwad', 14, 12, 2, 0, true, 'b Siraj', 2)]
  },
  bowlingCard: {
    A: [bowl('MI10', 'Mohammed Siraj', 3, 0, 0, 25, 1, 2), bowl('MI6', 'Hardik Pandya', 2, 0, 0, 14, 0, 2)],
    B: [bowl('CSK7', 'Deepak Chahar', 4, 0, 0, 31, 1, 1), bowl('CSK9', 'Matheesha Pathirana', 4, 0, 1, 28, 2, 1), bowl('CSK6', 'Ravindra Jadeja', 4, 0, 0, 30, 2, 1),
      bowl('CSK10', 'Maheesh Theekshana', 4, 0, 0, 33, 1, 1), bowl('CSK8', 'Tushar Deshpande', 4, 0, 0, 31, 0, 1)]
  },
  fallOfWickets: { A: [[1, 31, '3.2'], [2, 58, '6.4'], [3, 92, '11.1'], [4, 104, '12.5'], [5, 131, '16.0'], [6, 140, '17.3'], [7, 146, '18.2']].map(([wkt, runs, over]) => ({ wkt, runs, over, inningsNo: 1 })),
    B: [{ wkt: 1, runs: 20, over: '2.4', inningsNo: 2 }] },
  extras: { A: { wd: 0, nb: 0, b: 0, lb: 0, pen: 0 }, B: { wd: 2, nb: 0, b: 1, lb: 0, pen: 0 } },
  score: { runs: 48, wickets: 1, overs: 6, balls: 2 },
  striker: { id: 'CSK1', name: 'Devon Conway', runs: 22, balls: 15, fours: 3, sixes: 0 },
  nonStriker: { id: 'CSK2', name: 'Ajinkya Rahane', runs: 9, balls: 8, fours: 1, sixes: 0 },
  bowler: { id: 'MI9', name: 'Jasprit Bumrah', overs: 1, balls: 2, maidens: 0, runs: 9, wickets: 0 },
  ballLog: [{ innings: 2, striker: 'Ruturaj Gaikwad', nonStriker: 'Devon Conway', bowler: 'Mohammed Siraj', ballType: '0' },
    { innings: 2, striker: 'Ajinkya Rahane', nonStriker: 'Devon Conway', bowler: 'Jasprit Bumrah', ballType: '1', runs: 1 }]
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
    await until(() => P3.page.evaluate(() => document.querySelector('#bcg-dur-chips [aria-checked="true"]').dataset.dur), v => v === 'hold', 3000);
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
    eq('…the intro shows the real teams and this match\'s details', await OV.page.evaluate(() => [...document.querySelectorAll('#bcg .ar-name')].map(e => e.textContent).concat([...document.querySelectorAll('#bcg .ar-ii')].map(e => e.textContent))),
      ['Mumbai Indians', 'Chennai Super Kings', 'T20', 'Wankhede Stadium, Mumbai', '24 OCT 2026']);
    eq('…a final says so in gold, big, with its trophies (and not again in the details)', await OV.page.evaluate(() => {
      const k = document.querySelector('#bcg .ar-ko');
      return k ? [k.className, k.querySelector('.ar-ko-t').textContent, k.querySelectorAll('.ar-ko-ico').length, +getComputedStyle(k.querySelector('.ar-ko-plate')).opacity] : null;
    }), ['ar-ko final', 'FINAL', 2, 1]);
    eq('…the team reveal over the picture: the two teams\' strands of light, the glass, both logos (no player photos), VS between them, no team-coloured halves',
      await OV.page.evaluate(() => [document.querySelectorAll('#bcg .ar-env svg .ar-str.a').length > 0 && document.querySelectorAll('#bcg .ar-env svg .ar-str.b').length > 0, !!document.querySelector('#bcg .ar-panel'),
        document.querySelectorAll('#bcg .ar-frame .bcg-plate').length, document.querySelectorAll('#bcg .bcg-matchIntro img:not(.bcg-brand)').length, !!document.querySelector('#bcg .ar-vs-t'), !!document.querySelector('#bcg .intro-side')]), [true, true, 2, 0, true, false]);
    // reloaded while it holds: it comes back as it is — not a second opening sequence
    await OV.page.reload();
    await OV.page.waitForFunction(() => window.gsap && document.querySelector('#bcg .bcg-scene[data-ready="1"]'), null, { timeout: 6000 });
    await sleep(150);
    eq('the overlay reloaded during the intro → the one intro, already on its final picture (not played again)',
      await OV.page.evaluate(() => [document.querySelectorAll('#bcg .bcg-scene').length, document.querySelector('#bcg .bcg-scene').dataset.hold, getComputedStyle(document.querySelector('#bcg .ar-vs-t')).opacity, getComputedStyle(document.querySelector('#bcg .ar-venue')).opacity]),
      [1, 'until-hidden', '1', '1']);
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

    // —— PLAYING XI on HOLD: each team stays until NEXT TEAM / HIDE ——
    const xiMode = (P) => P.page.evaluate(() => document.querySelector('#bcg-xi-mode [aria-checked="true"]').dataset.v);
    await P3.page.click('#bcg-xi-mode button[data-v="hold"]');
    eq('HOLD picked in Cricket Panel 3 → Cricket Panel shows HOLD too (one shared choice)', await until(() => xiMode(P1), v => v === 'hold', 3000), 'hold');
    await P1.page.click('#bcg-xi-btn');
    o = await until(ov, v => v.phase === 'team1');
    eq('PLAYING XI on HOLD → team one, held', [o.team, o.hold], ['Mumbai Indians', 'hold']);
    await sleep(12500);
    o = await ov();
    eq('12.5 s later: still team one — no 10 s timer behind HOLD', [o.phase, o.team], ['team1', 'Mumbai Indians']);
    eq('…NEXT TEAM and HIDE PLAYING XI offered in both panels', await Promise.all([P1, P3].map(P => P.page.evaluate(() => [!document.getElementById('bcg-xi-skip').hidden, !document.getElementById('bcg-xi-stop').hidden]))), [[true, true], [true, true]]);
    await P3.page.click('#bcg-xi-skip');
    o = await until(ov, v => v.phase === 'team2' && v.team === 'Chennai Super Kings');
    eq('NEXT TEAM (Cricket Panel 3) → team two, the graphic still up', [o.on, o.phase, o.hold], [true, 'team2', 'hold']);
    await sleep(13500);
    o = await ov();
    eq('13.5 s later: team two still up — held until hidden', [o.on, o.phase, o.team], [true, 'team2', 'Chennai Super Kings']);
    await P1.page.click('#bcg-xi-mode button[data-v="auto"]');
    await until(ov, v => v.hold === 'auto', 3000);
    const t0 = Date.now();
    o = await until(ov, v => !v.on, 14000);
    ok(`AUTO picked (Cricket Panel) while team two was held → it gets its 10 s from now, then goes (${Date.now() - t0} ms, exit included)`, !o.on && Date.now() - t0 >= 9300 && Date.now() - t0 <= 12000, Date.now() - t0);
    await P1.page.click('#bcg-xi-mode button[data-v="hold"]');
    await until(() => xiMode(P3), v => v === 'hold', 3000);
    await P3.page.click('#bcg-xi-btn');
    await until(ov, v => v.phase === 'team1');
    await until(() => btn(P1, 'bcg-xi-btn'), v => v.on);
    await P1.page.click('#bcg-xi-stop');
    o = await until(ov, v => !v.on, 3000);
    eq('HIDE PLAYING XI (Cricket Panel) while held → gone, nothing left', [o.on, o.scenes], [false, 0]);
    await P1.page.click('#bcg-xi-mode button[data-v="auto"]');
    await until(() => xiMode(P3), v => v === 'auto', 3000);

    // —— INNINGS + MANUAL SCORECARDS (a match in its 2nd innings) ——
    for(const P of [P1, P3]) await P.page.evaluate((I) => { Object.assign(state, JSON.parse(JSON.stringify(I))); renderSquadUI(); renderPanel(); }, INN);
    const scoring = (P) => P.page.evaluate(() => JSON.stringify([state.inningsNumber, state.battingTeam, state.score, state.striker.name, state.nonStriker.name, state.bowler.name, state.target, state.battingCard, state.bowlingCard]));
    const before = await scoring(P1);
    const inn = (P) => P.page.evaluate(() => [...document.querySelectorAll('#bcg-inn button')].map(b => [b.textContent, b.getAttribute('aria-checked'), b.getAttribute('aria-disabled')]));
    eq('the innings this T20 has: LIVE (the 2nd, being scored), 1ST, 2ND', await inn(P1), [['LIVE · 2ND', 'true', 'false'], ['1ST', 'false', 'false'], ['2ND', 'false', 'false']]);
    const card = () => OV.page.evaluate(() => {
      const s = document.querySelector('#bcg .bcg-scene[data-mode="scorecard"]:not([data-leaving])');
      if(!s) return null;
      const t = (q) => { const e = s.querySelector(q); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
      return { kind: s.dataset.kind, innings: s.dataset.innings, hold: s.dataset.hold || null, team: t('.mc-team'), kicker: t('.mc-kicker'), total: t('.mc-total'), overs: t('.mc-overs'),
        rows: [...s.querySelectorAll('.mc-tr:not(.mc-th)')].map(r => [...r.children].map(c => c.textContent.trim())), groups: [...s.querySelectorAll('.mc-group')].map(g => [g.querySelector('b').textContent, g.querySelector('span').textContent.replace(/\s+/g, ' ')]),
        sum: t('.mc-sum'), fow: t('.mc-fow') };
    });
    await P1.page.click('#bcg-inn button[data-v="1"]');
    eq('1ST picked in Cricket Panel → Cricket Panel 3 shows it too', (await until(() => inn(P3), v => v[1][1] === 'true', 3000))[1][1], 'true');
    await P1.page.click('#bcg-bat-btn');
    let c = await until(card, v => v && v.kind === 'bat', 4000);
    await sleep(1600);
    c = await card();
    eq('BAT SCORECARD, 1st innings → Mumbai Indians\' real innings: 160/7 in 20 overs, pinned', [c.innings, c.team, c.kicker, c.total, c.overs, c.hold],
      ['1', 'Mumbai Indians', 'BATTING · 1ST INNINGS', '160/7', '20.0 OV · RR 8.00', 'until-hidden']);
    eq('…every batter once (the row recorded twice shows once), in batting order, with their real figures',
      c.rows.map(r => r.slice(0, 4)), INN.battingCard.A.slice(0, 9).map(b => [b.name, b.howOut, String(b.runs), String(b.balls)]));
    eq('…the rest of the squad by name only: did not bat (XI), not in the XI (bench)', c.groups, [['DID NOT BAT', 'Jasprit Bumrah · Mohammed Siraj'], ['NOT IN XI', 'Benched Batter']]);
    eq('…extras, total and the fall of wickets from the innings itself', [c.sum, c.fow], ['EXTRAS7 (wd 4, nb 1, lb 2)TOTAL 160/7 (20.0 ov)', 'FALL OF WICKETS1-31 (3.2) · 2-58 (6.4) · 3-92 (11.1) · 4-104 (12.5) · 5-131 (16.0) · 6-140 (17.3) · 7-146 (18.2)']);
    eq('…Cricket Panel 3: the BAT button lit, the over-end cards marked MANUAL', await P3.page.evaluate(() => [document.getElementById('bcg-bat-btn').classList.contains('on'), document.getElementById('bcg-auto').textContent]),
      [true, 'MANUAL — over-end cards paused']);
    await P3.page.click('#bcg-bowl-btn');
    c = await until(card, v => v && v.kind === 'bowl', 4000);
    await sleep(1600);
    c = await card();
    eq('BOWL SCORECARD (Cricket Panel 3), 1st innings → the side that bowled it: Chennai Super Kings, their figures in bowling order',
      [c.team, c.kicker, c.rows.map(r => r.slice(0, 5))], ['Chennai Super Kings', 'BOWLING · 1ST INNINGS', INN.bowlingCard.B.map(b => [b.name, `${b.overs}.${b.balls}`, String(b.maidens), String(b.runs), String(b.wickets)])]);
    eq('…did not bowl (the rest of their XI) and not in the XI — names only, no made-up figures', c.groups,
      [['DID NOT BOWL', 'Ruturaj Gaikwad · Devon Conway · Ajinkya Rahane · Shivam Dube · Moeen Ali · MS Dhoni'], ['NOT IN XI', 'Benched Bowler']]);
    await P3.page.click('#bcg-inn button[data-v="2"]');
    c = await until(card, v => v && v.innings === '2', 5000);
    await sleep(1600);
    c = await card();
    eq('2ND picked while the bowling card is up → the card follows: Mumbai Indians bowling, the bowler on marked',
      [c.kind, c.team, c.kicker, c.rows.map(r => r.slice(0, 5))], ['bowl', 'Mumbai Indians', 'BOWLING · 2ND INNINGS',
        [['Mohammed Siraj', '3.0', '0', '25', '1'], ['Jasprit Bumrah *', '1.2', '0', '9', '0'], ['Hardik Pandya', '2.0', '0', '14', '0']]]);
    eq('…during the live innings it is "not bowled yet", not "did not bowl"', c.groups[0][0], 'NOT BOWLED YET');
    await P1.page.click('#bcg-bat-btn');
    c = await until(card, v => v && v.kind === 'bat' && v.innings === '2', 4000);
    await sleep(1600);
    c = await card();
    eq('BAT SCORECARD, 2nd innings → the chase as it stands: 48/1, target 161, the two at the crease', [c.team, c.total, c.overs, c.rows.map(r => r.slice(0, 3))],
      ['Chennai Super Kings', '48/1', '6.2 OV · RR 7.58 · TARGET 161', [['Ruturaj Gaikwad', 'b Siraj', '14'], ['Devon Conway *', 'batting', '22'], ['Ajinkya Rahane', 'batting', '9']]]);
    eq('…the rest of their XI is "yet to bat" (never "did not bat" mid-innings)', c.groups[0], ['YET TO BAT', 'Shivam Dube · Moeen Ali · MS Dhoni · Ravindra Jadeja · Deepak Chahar · Tushar Deshpande · Matheesha Pathirana · Maheesh Theekshana']);
    await P3.page.click('#bcg-inn button[data-v="1"]');
    c = await until(card, v => v && v.innings === '1', 5000);
    await sleep(1600);
    c = await card();
    eq('back to the 1ST → its own figures again, never mixed with the 2nd', [c.team, c.total, c.rows.length, c.rows[0].slice(0, 3)], ['Mumbai Indians', '160/7', 9, ['Rohit Sharma', 'c Dhoni b Chahar', '34']]);
    eq('picking innings and showing cards changed nothing in the scoring (innings, strike, figures)', [await scoring(P1), await scoring(P3)], [before, before]);
    // the automatic between-overs cards wait while a card is pinned …
    await P1.page.evaluate(() => emitOverSummary(6, 7, 0, ['1', '4', '0', '1', '1', '0']));
    await sleep(1500);
    eq('an over ends while the card is pinned → its automatic over-end card waits (the pinned card stays)',
      [await OV.page.evaluate(() => getComputedStyle(document.getElementById('over-summary-card')).display), (await card()) && (await card()).kind], ['none', 'bat']);
    await P3.page.click('#bcg-card-hide');
    o = await until(ov, v => !v.on, 4000);
    eq('HIDE SCORECARD (Cricket Panel 3) → gone, both panels back to AUTO', [o.on, await P1.page.evaluate(() => document.getElementById('bcg-auto').textContent)], [false, 'Over-end cards: AUTO']);
    await sleep(1500);
    await P1.page.evaluate(() => emitOverSummary(7, 9, 1, ['W', '4', '1', '1', '2', '1']));
    const shown = await until(() => OV.page.evaluate(() => document.getElementById('over-summary-card').style.display), v => v === 'flex', 3000);
    eq('…and the next over\'s automatic card comes up by itself, as before', shown, 'flex');
    eq('…and leaves by itself', await until(() => OV.page.evaluate(() => document.getElementById('over-summary-card').style.display), v => v === 'none', 8000), 'none');
    // a Test has four innings: the ones not played yet are offered but not available
    await P3.page.evaluate(() => { state.format = 'Test'; renderPanel(); });
    eq('a Test → LIVE, 1ST–4TH; 3RD and 4TH not played yet (not pickable)', (await inn(P3)).map(b => [b[0], b[2]]), [['LIVE · 2ND', 'false'], ['1ST', 'false'], ['2ND', 'false'], ['3RD', 'true'], ['4TH', 'true']]);
    await P3.page.click('#bcg-inn button[data-v="3"]', { force: true });
    await sleep(500);
    eq('…a 3RD picked anyway changes nothing', (await inn(P3))[1][1], 'true');
    await P3.page.evaluate(() => { state.format = 'T20'; renderPanel(); });
    await P1.page.click('#bcg-inn button[data-v="live"]');
    await until(() => inn(P3), v => v[0][1] === 'true', 3000);

    // —— the score bar switched off in the panel: the graphics still go on
    //    air, and once they are hidden the bar stays off. Live Output blurs
    //    its camera a touch while one is up and clears it as it goes ——
    const LO = await open('overlay', `/live-output.html?room=${ROOM}`, 1280, 720);
    await LO.page.waitForFunction(() => { const f = document.getElementById('overlay-frame'); return f && f.contentWindow && f.contentWindow.document.getElementById('bcg'); }, null, { timeout: 15000 });
    await sleep(1500);
    const lo = () => LO.page.evaluate(() => [document.getElementById('stage').classList.contains('gfx-blur'), getComputedStyle(document.getElementById('camera-video')).filter]);
    eq('Live Output with nothing on air: the camera sharp', await lo(), [false, 'none']);
    await P1.page.evaluate(() => { const t = document.getElementById('visible-toggle'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); });
    o = await until(ov, v => v.bar < 0.05, 4000);
    ok('the score bar switched off from Cricket Panel → off the overlay', o.bar < 0.05, o);
    await P1.page.click('#bcg-intro-btn');
    o = await until(ov, v => v.mode === 'matchIntro', 4000);
    eq('…MATCH INTRO still goes on air with the bar off', [o.mode, o.live, await air(P3)], ['matchIntro', 1, 'On air · Match Intro']);
    await sleep(1000);
    const blur = await lo();
    eq('…Live Output: the intro over its camera, and the camera blurred a touch behind it', [blur[0], /^blur\(/.test(blur[1]), await LO.page.evaluate(() => !!document.getElementById('overlay-frame').contentWindow.document.querySelector('#bcg .bcg-scene[data-mode="matchIntro"]'))], [true, true, true]);
    await P3.page.click('#bcg-intro-btn');
    o = await until(ov, v => !v.on, 4000);
    await sleep(2000);
    o = await ov();
    eq('…hidden (Cricket Panel 3) → gone, and the bar stays off as the operator left it', [o.on, o.bar < 0.05], [false, true]);
    eq('…Live Output: the camera sharp again', await lo(), [false, 'none']);
    await P1.page.evaluate(() => { const t = document.getElementById('visible-toggle'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); });
    o = await until(ov, v => v.bar > 0.95, 4000);
    ok('…switched back on → the bar is back', o.bar > 0.95, o);
    await LO.ctx.close();

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
    ['its styles', '/* 🎬 BROADCAST GRAPHICS — the full-screen graphics', 'html[data-theme="light"] .bcg-msg.bad']
  ]) eq(`${what}: cricket-panel.html = cricket-panel3.html`, cut('cricket-panel.html', a, b) === cut('cricket-panel3.html', a, b), true);
}

(async () => {
  sameInBothPanels();
  await rules();
  knockoutRounds();
  if(process.env.ONLY !== 'rules') await chain();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
