/* 🏐 Volleyball standings, fixtures and statistics — the pure modules.

     node test/volleyball/standings-stats.test.js
*/
const S = require('../../volleyball-standings.js');
const St = require('../../volleyball-stats.js');
const E = require('../../volleyball-engine.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, expected: b }); }
function head(t) { console.log('\n=== ' + t + ' ==='); }

// a completed match from set scores, e.g. m('x', 'T1', 'T2', [[25,20],[25,18],[25,10]])
let mid = 0;
function m(a, b, sets, o) {
  const won = { A: 0, B: 0 };
  sets.forEach(([x, y]) => { if (x > y) won.A++; else won.B++; });
  return Object.assign({
    matchId: 'm' + (++mid), status: 'completed', teamA: { teamId: a }, teamB: { teamId: b }, stage: { type: 'league' },
    result: { winner: won.A > won.B ? 'A' : 'B', sets: won, setScores: sets.map(([x, y]) => ({ A: x, B: y })), forfeit: null }
  }, o || {});
}
const T = (ids) => ids.map((id) => ({ teamId: id, name: id }));

head('MATCH POINTS (3-2-1-0 default)');
{
  const r = S.compute({ teams: T(['A', 'B', 'C', 'D']), matches: [
    m('A', 'B', [[25, 20], [25, 18], [25, 10]]),                          // 3-0
    m('C', 'D', [[25, 20], [20, 25], [25, 18], [25, 10]]),                // 3-1
    m('A', 'C', [[25, 20], [20, 25], [25, 18], [23, 25], [15, 13]])       // 3-2
  ] }).groups[0].rows;
  const row = (id) => r.find((x) => x.teamId === id);
  eq('3-0 winner 3, loser 0', [row('A').matchPoints - 2, row('B').matchPoints], [3, 0]);
  eq('3-1 winner 3, loser 0', [row('D').matchPoints, row('C').matchPoints - 1], [0, 3]);
  eq('3-2: winner 2, loser 1', [row('A').matchPoints, row('C').matchPoints], [5, 4]);
  eq('sets and points ratio', [row('A').setsWon, row('A').setsLost, row('A').pointsWon], [6, 2, 75 + 108]);
  eq('the table order', r.map((x) => x.teamId), ['A', 'C', 'D', 'B']);
}
{
  const r = S.compute({ teams: T(['A', 'B']), policy: '2-1', matches: [m('A', 'B', [[25, 1], [25, 1], [25, 1]])] }).groups[0].rows;
  eq('the "win 2 · loss 1" policy', r.map((x) => x.matchPoints), [2, 1]);
  const c = S.compute({ teams: T(['A', 'B']), policy: { winStraight: 4, winDecider: 3, loseDecider: 2, loseStraight: 1 }, matches: [m('A', 'B', [[25, 1], [1, 25], [25, 1], [1, 25], [15, 1]])] }).groups[0].rows;
  eq('a custom policy: 3-2 → 3 and 2', c.map((x) => x.matchPoints), [3, 2]);
  const b3 = S.compute({ teams: T(['A', 'B']), matches: [m('A', 'B', [[25, 1], [1, 25], [15, 10]])] }).groups[0].rows;
  eq('best of three: a 2-1 is a "decider" result (2 and 1)', b3.map((x) => x.matchPoints), [2, 1]);
  const f = m('A', 'B', [[25, 0], [25, 0], [25, 0]]);
  f.result.forfeit = 'B';
  const fr = S.compute({ teams: T(['A', 'B']), policy: '2-1', matches: [f] }).groups[0].rows;
  eq('a forfeit never earns the loser’s point', fr.map((x) => x.matchPoints), [2, 0]);
}

head('ONLY COMPLETED MATCHES, ONCE');
{
  const done = m('A', 'B', [[25, 20], [25, 20], [25, 20]]);
  const r = S.compute({ teams: T(['A', 'B']), matches: [done, done,
    Object.assign(m('A', 'B', [[25, 0], [25, 0], [25, 0]]), { status: 'live' }),
    Object.assign(m('A', 'B', [[25, 0], [25, 0], [25, 0]]), { status: 'scheduled' }),
    Object.assign(m('A', 'B', [[25, 0]]), { status: 'abandoned', result: null }),
    Object.assign(m('A', 'B', [[25, 0], [25, 0], [25, 0]]), { stage: { type: 'knockout' } })
  ] }).groups[0].rows;
  eq('one completed league match counted once; live / scheduled / abandoned / knockout ignored', r.map((x) => x.played), [1, 1]);
}

head('TIE-BREAKS (FIVB order: wins, match points, set ratio, point ratio, head-to-head)');
{
  // A and B: 1 win each with 3-0 wins (3 pts). set ratio decides: A lost 0 sets, B lost 1.
  const r = S.compute({ teams: T(['A', 'B', 'C']), matches: [
    m('A', 'C', [[25, 20], [25, 20], [25, 20]]),
    m('B', 'C', [[25, 20], [20, 25], [25, 20], [25, 20]]),
    m('C', 'A', [[25, 20], [25, 20], [25, 20]]),
    m('C', 'B', [[25, 22], [25, 22], [25, 22]])
  ] }).groups[0].rows;
  // A: 3-0 win, 0-3 loss → sets 3-3 (1.00); B: 3-1 win, 0-3 loss → 3-4 (0.75)
  eq('level on wins and points: set ratio decides', r.map((x) => [x.teamId, x.decidedBy]), [['C', null], ['A', 'setRatio'], ['B', 'setRatio']]);
}
{
  // A and B level on everything (W1 L1, 3 pts, sets 3-3, points 135-135) — A beat B
  const r = S.compute({ teams: T(['A', 'B', 'C', 'D']), matches: [
    m('A', 'B', [[25, 20], [25, 20], [25, 20]]),
    m('B', 'C', [[25, 20], [25, 20], [25, 20]]),
    m('D', 'A', [[25, 20], [25, 20], [25, 20]]),
  ] }).groups[0].rows;
  const a = r.find((x) => x.teamId === 'A'), b = r.find((x) => x.teamId === 'B');
  eq('A and B level on wins, points, sets and point totals', [a.won, b.won, a.matchPoints, b.matchPoints, a.setRatio, b.setRatio, a.pointRatio, b.pointRatio], [1, 1, 3, 3, 1, 1, 1, 1]);
  eq('head-to-head decides it: A beat B', r.map((x) => [x.teamId, x.decidedBy]), [['D', 'setRatio'], ['A', 'headToHead'], ['B', 'headToHead'], ['C', null]]);
}
{
  const r = S.compute({ teams: T(['X', 'Y', 'Z']), tiebreakers: ['matchPoints', 'wins', 'setRatio', 'pointRatio', 'headToHead'], matches: [
    m('X', 'Z', [[25, 20], [20, 25], [25, 20], [20, 25], [15, 10]]),   // X 2, Z 1
    m('Y', 'Z', [[25, 20], [20, 25], [25, 20], [20, 25], [15, 10]]),   // Y 2, Z 1
    m('X', 'Y', [[25, 20], [20, 25], [25, 20], [20, 25], [15, 10]]),   // X 2, Y 1
  ] }).groups[0].rows;
  eq('league preset (points first)', r.map((x) => [x.teamId, x.matchPoints]), [['X', 4], ['Y', 3], ['Z', 2]]);
}
{
  // three teams exactly level overall; the mini-table among them decides
  const r = S.compute({ teams: T(['P', 'Q', 'R']), matches: [
    m('P', 'Q', [[25, 20], [25, 20], [25, 20]]),
    m('Q', 'R', [[25, 20], [25, 20], [25, 20]]),
    m('R', 'P', [[25, 20], [25, 20], [25, 20]]),
  ] }).groups[0].rows;
  ok('a perfect three-way tie stays stable and complete', r.length === 3 && new Set(r.map((x) => x.position)).size === 3);
}
eq('ratio display: no sets lost = MAX', [S.fmtRatio(Infinity), S.fmtRatio(1.5)], ['MAX', '1.500']);
eq('a stored (already normalised) 3-2-1-0 policy stays 3-2-1-0, not "custom"', [S.normalizePolicy(S.normalizePolicy('3-2-1-0')).key, S.normalizePolicy(JSON.parse(JSON.stringify(S.normalizePolicy('2-1')))).label], ['3-2-1-0', S.POLICIES['2-1'].label]);
eq('…while changed figures under a preset name are custom', S.normalizePolicy({ key: '3-2-1-0', winStraight: 3, winDecider: 3, loseDecider: 1, loseStraight: 0 }).key, 'custom');

head('GROUPS');
{
  const r = S.compute({ teams: T(['A1', 'A2', 'B1', 'B2']), groups: [{ name: 'A', teamIds: ['A1', 'A2'] }, { name: 'B', teamIds: ['B1', 'B2'] }], matches: [
    m('A1', 'A2', [[25, 1], [25, 1], [25, 1]], { stage: { type: 'group', group: 'A' } }),
    m('B2', 'B1', [[25, 1], [25, 1], [25, 1]], { stage: { type: 'group', group: 'B' } }),
    m('A1', 'B1', [[25, 1], [25, 1], [25, 1]], { stage: { type: 'friendly' } })
  ] });
  eq('one table per group, each with its own teams only', r.groups.map((g) => [g.name, g.rows.map((x) => x.teamId + ':' + x.played)]), [['A', ['A1:1', 'A2:1']], ['B', ['B2:1', 'B1:1']]]);
  eq('league → knockout seeds: group winners first, then runners-up', S.seedsFromGroups(r.groups, 2), ['A1', 'B2', 'A2', 'B1']);
}

head('FIXTURES');
{
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6'];
  const rr = S.roundRobin(ids);
  const pairs = new Set(rr.map((f) => [f.home, f.away].sort().join('-')));
  eq('6 teams: 15 matches, every pair exactly once, 5 rounds', [rr.length, pairs.size, Math.max(...rr.map((f) => f.round))], [15, 15, 5]);
  ok('no team plays twice in a round', [1, 2, 3, 4, 5].every((r) => { const t = rr.filter((f) => f.round === r).flatMap((f) => [f.home, f.away]); return new Set(t).size === t.length; }));
  const home = {};
  rr.forEach((f) => { home[f.home] = (home[f.home] || 0) + 1; });
  ok('home games spread (2 or 3 each)', Object.values(home).every((h) => h >= 2 && h <= 3), home);
  const odd = S.roundRobin(['a', 'b', 'c', 'd', 'e']);
  eq('5 teams: 10 matches over 5 rounds (one bye a round)', [odd.length, Math.max(...odd.map((f) => f.round))], [10, 5]);
  const dbl = S.roundRobin(['a', 'b', 'c', 'd'], { double: true });
  eq('double round robin: 12 matches, each pairing home and away', [dbl.length, dbl.filter((f) => f.home === 'a' && f.away === 'b').length + dbl.filter((f) => f.home === 'b' && f.away === 'a').length], [12, 2]);
  const k8 = S.knockout(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
  eq('8-team bracket: 1v8 and 4v5 in one half, 2v7 and 3v6 in the other', k8.filter((k) => k.round === 1).map((k) => k.A.teamId + 'v' + k.B.teamId), ['s1vs8', 's4vs5', 's2vs7', 's3vs6']);
  eq('…so seeds 1 and 2 can only meet in the final', [k8.find((k) => k.key === 'KO:R2:M1').A.winnerOf, k8.find((k) => k.key === 'KO:R2:M1').B.winnerOf], ['KO:R1:M1', 'KO:R1:M2']);
  eq('…round labels', [...new Set(k8.map((k) => k.roundLabel))], ['Quarter-final', 'Semi-final', 'Final']);
  const k5 = S.knockout(['a', 'b', 'c', 'd', 'e'], { thirdPlace: true });
  eq('5 teams: three byes, one play-in, a third-place match', [k5.filter((k) => k.round === 1).length, k5.some((k) => k.key === 'KO:3RD')], [1, true]);
}

head('STATISTICS FROM THE TIMELINE');
function squad(p) { const a = []; for (let i = 1; i <= 8; i++) a.push({ playerId: p + i, number: i, name: p + i, libero: i === 8 }); return a; }
const setup = { teams: { A: { name: 'A', players: squad('a') }, B: { name: 'B', players: squad('b') } }, rules: {} };
function play(evs) {
  const L = new E.Ledger(setup, []);
  let n = 0;
  const add = (e) => { const r = L.check(Object.assign({ eventId: 'e' + (++n), at: n * 1000 }, e)); if (!r.ok) throw new Error(e.type + ' ' + r.code); L.commit(r.pending); return r.pending.event; };
  add({ type: 'TOSS', winner: 'A', choice: 'serve', leftSide: 'A' });
  add({ type: 'LINEUP', team: 'A', positions: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] });
  add({ type: 'LINEUP', team: 'B', positions: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'] });
  add({ type: 'SET_START' });
  const out = evs.map(add);
  return { L, out, add, stats: () => St.compute({ state: L.state, timeline: L.timeline, setup: L.setup }) };
}
{
  const g = play([
    { type: 'RALLY', winner: 'A' },                                                    // plain point: no kill
    { type: 'RALLY', winner: 'A', outcome: 'ATTACK_KILL', players: { attacker: 'a4', assist: 'a1' } },
    { type: 'RALLY', winner: 'A', outcome: 'ACE', players: { receiver: 'b5' } },       // a1 serves
    { type: 'RALLY', winner: 'B', outcome: 'SERVICE_ERROR' },                           // a1's error; B rotates, b2 serves
    { type: 'RALLY', winner: 'B', outcome: 'BLOCK', players: { blockers: ['b3', 'b4'], attacker: 'a4' } },
    { type: 'RALLY', winner: 'B', outcome: 'BLOCK', players: { blockers: ['b2'] } },
    { type: 'RALLY', winner: 'A', outcome: 'ATTACK_ERROR', players: { attacker: 'b4' } },
    { type: 'RALLY', winner: 'B', outcome: 'NET_FAULT', players: { errorBy: 'a2' } },
    { type: 'RALLY', winner: 'B', outcome: 'ATTACK_KILL' }                              // no attacker named
  ]);
  const s = g.stats();
  const P = s.players;
  eq('a point alone is never a kill; a named kill is', [P.a4.attack.kills, s.teams.A.attack.kills, s.teams.B.attack.kills], [1, 1, 0]);
  eq('the setter of a kill gets the assist', P.a1.assists, 1);
  eq('aces and service errors go to the server of that rally (a1, from the rotation)', [P.a1.serve.aces, P.a1.serve.errors, P.a1.serve.attempts], [1, 1, 4]);
  eq('the receiver of an ace has a reception error', P.b5.reception.errors, 1);
  eq('a solo block is 1; a two-man block is 0.5 each', [P.b2.block.solo, P.b2.block.points, P.b3.block.assists, P.b3.block.points, P.b4.block.points], [1, 1, 1, 0.5, 0.5]);
  eq('the blocked attacker has an attack error', [P.a4.attack.errors, P.a4.attack.blocked], [1, 1]);
  eq('attack efficiency (1 kill − 1 error) / 2 = 0', [P.a4.attack.attempts, P.a4.attack.efficiency], [2, 0]);
  eq('no attempts: efficiency "–", never 0% or NaN', [P.a6.attack.efficiency, St.pct(P.a6.attack.efficiency)], [null, '–']);
  eq('player points = kills + aces + block points', [P.a4.points, P.a1.points, P.b3.points], [1, 1, 0.5]);
  eq('team points by kind', [s.teams.A.points, s.teams.A.byCategory, s.teams.B.points], [4, { attack: 1, block: 0, serve: 1, opponentError: 1, penalty: 0, general: 1 }, 5]);
  eq('faults by player', P.a2.faults.net, 1);
  eq('team block points add up to the block rallies', s.teams.B.blockPoints, 2);
  const kill = g.out[1];
  g.add({ type: 'CORRECT', target: kill.eventId, patch: { players: { attacker: 'a3' } }, reason: 'it was a3' });
  const s2 = g.stats();
  eq('a corrected attribution moves the kill', [s2.players.a4.attack.kills, s2.players.a3.attack.kills], [0, 1]);
  g.add({ type: 'UNDO' });
  eq('…and undoing the correction moves it back', g.stats().players.a4.attack.kills, 1);
  eq('who a rally is about (for the clip icons)', St.rallyParticipants(g.L.timeline.find((e) => e.eventId === g.out[4].eventId)).map((p) => p.playerId + ':' + p.role), ['a4:blocked attacker', 'b3:blocker', 'b4:blocker']);
  eq('…an ace: the server and the receiver', St.rallyParticipants(g.L.timeline.find((e) => e.eventId === g.out[2].eventId)).map((p) => p.playerId + ':' + p.role), ['a1:server', 'b5:receiver']);
  eq('…a plain point: nobody (no invented attribution)', St.rallyParticipants(g.L.timeline.find((e) => e.eventId === g.out[0].eventId)), []);
}
{
  const g = play([{ type: 'RALLY', winner: 'A' }, { type: 'SUBSTITUTION', team: 'A', pairs: [{ out: 'a2', in: 'a7' }] }, { type: 'RALLY', winner: 'B' }, { type: 'LIBERO', team: 'A', libero: 'a8', replaces: 'a5' }]);
  const P = g.stats().players;
  eq('sets played: starters, the substitute and the libero; not the bench', [P.a1.setsPlayed, P.a7.setsPlayed, P.a8.setsPlayed, P.a8.liberoEntries, P.b7.setsPlayed], [1, 1, 1, 1, 0]);
  eq('substitution counts per player', [P.a2.subs.out, P.a7.subs.in], [1, 1]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
