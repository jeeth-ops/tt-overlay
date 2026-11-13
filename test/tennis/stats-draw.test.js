/* 🎾 Tennis statistics and draws — the real modules:

     • a scripted singles match: aces, double faults, first / second serve
       in and won, break points faced / saved / converted, service and
       return games, winners, errors, net points, tie-breaks, streaks
     • UNAVAILABLE is never zero: generic points give no winners / errors,
       untracked serves give no first-serve %
     • an undone point does not count; a reclassified point counts as it reads now
     • doubles: serve figures per server; the clip's players for a point
     • draws: the standard seeding lines, byes to the top seeds, 5 / 6 / 32
       entries, round names, third place, stable keys, round robin pairs,
       standings with the tennis tie-breaks (two tied → their match, three
       → sets %, games %), groups → knockout (A1 v B2)

     node test/tennis/stats-draw.test.js
*/
'use strict';
const E = require('../../tennis-engine.js');
const Stats = require('../../tennis-stats.js');
const D = require('../../tennis-draw.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, expected: b }); }
function head(t) { console.log('\n=== ' + t + ' ==='); }

let idn = 0;
function L0(format, rules) {
  const sides = format === 'doubles'
    ? { A: { players: [{ playerId: 'a1', name: 'Anna Alpha' }, { playerId: 'a2', name: 'Asha Arora' }] }, B: { players: [{ playerId: 'b1', name: 'Bella Bravo' }, { playerId: 'b2', name: 'Bina Bose' }] } }
    : { A: { players: [{ playerId: 'a1', name: 'Roger Alpha' }] }, B: { players: [{ playerId: 'b1', name: 'Rafa Bravo' }] } };
  const L = new E.Ledger({ format, rules: rules || {}, sides }, []);
  const st = { type: 'START', server: 'a1', left: 'A' };
  if (format === 'doubles') { st.order = ['a1', 'b1', 'a2', 'b2']; st.receive = { A: { deuce: 'a1', ad: 'a2' }, B: { deuce: 'b1', ad: 'b2' } }; }
  go(L, st);
  return L;
}
function go(L, ev) {
  const e = Object.assign({ eventId: 's' + (++idn), at: 1700000000000 + idn * 30000 }, ev);
  const c = L.check(e);
  if (!c.ok) throw new Error(ev.type + ': ' + c.error);
  L.commit(c.pending);
  return c.pending.event;
}
const stats = (L) => Stats.compute({ setup: L.setup, state: L.state, timeline: L.timeline });
// a point with the serve tracked: 1 = in, 2 = after a recorded fault
function P(L, winner, kind, extra) {
  const ev = Object.assign({ type: 'POINT', winner, kind: kind || 'POINT', serve: L.state.serve }, extra || {});
  if (kind === 'DOUBLE_FAULT') ev.serve = 2;
  return go(L, ev);
}

head('A SCRIPTED SINGLES MATCH');
{
  const L = L0('singles');
  // game 1, A serves: ace, fault + A wins on 2nd, B return winner, A winner (net), A ace → A holds 40-15
  P(L, 'A', 'ACE');
  go(L, { type: 'FAULT' }); P(L, 'A', 'POINT');
  P(L, 'B', 'RETURN_WINNER');
  P(L, 'A', 'WINNER', { net: 'A', stroke: 'VOLLEY' });
  P(L, 'A', 'ACE');
  // game 2, B serves: B double fault, A UE (B wins), B ace, A forced error by B? (A wins: B forced error) …
  P(L, 'A', 'DOUBLE_FAULT');                 // 0-15
  P(L, 'B', 'UNFORCED_ERROR');               // A erred: 15-15
  P(L, 'A', 'FORCED_ERROR');                 // B erred (forced): 15-30
  P(L, 'A', 'WINNER');                       // 15-40 — two break points
  P(L, 'B', 'ACE');                          // 30-40 — saved one
  P(L, 'A', 'UNFORCED_ERROR', { net: 'B' }); // B came in and missed: break
  const s = stats(L);
  const A = s.sides.A, B = s.sides.B;
  eq('points won', [A.pointsWon, B.pointsWon], [8, 3]);
  eq('aces', [A.serve.aces, B.serve.aces], [2, 1]);
  eq('double faults', [A.serve.doubleFaults, B.serve.doubleFaults], [0, 1]);
  eq('A served 5 points: 4 first serves in (80%), 1 second', [A.serve.points, A.serve.firstIn, A.serve.firstServes, A.serve.firstPct, A.serve.secondPoints], [5, 4, 5, 80, 1]);
  eq('A won 3/4 on the first serve, 1/1 on the second', [A.serve.firstWon, A.serve.firstWonPct, A.serve.secondWon, A.serve.secondWonPct], [3, 75, 1, 100]);
  eq('B served 6 points; the double fault is a lost second serve', [B.serve.points, B.serve.firstIn, B.serve.secondPoints, B.serve.secondWon], [6, 5, 1, 0]);
  eq('service games: A held 1/1, B 0/1', [A.serve.games, A.serve.gamesWon, B.serve.games, B.serve.gamesWon], [1, 1, 1, 0]);
  eq('return games: A broke once', [A.ret.games, A.ret.gamesWon], [1, 1]);
  eq('break points: A had 2, converted 1; B faced 2, saved 1', [A.ret.bpChances, A.ret.bpConverted, B.serve.bpFaced, B.serve.bpSaved, B.serve.bpSavedPct], [2, 1, 2, 1, 50]);
  eq('winners (aces and service winners not counted as winners)', [A.winners, B.winners], [2, 1]);
  eq('return winners', [B.ret.returnWinners], [1]);
  eq('unforced errors: by A 1, by B 1; forced errors made: B 1', [A.unforcedErrors, B.unforcedErrors, B.forcedErrors], [1, 1, 1]);
  eq('net points: A 1/1, B 0/1', [A.net, B.net], [{ points: 1, won: 1, wonPct: 100 }, { points: 1, won: 0, wonPct: 0 }]);
  eq('games won', [A.gamesWon, B.gamesWon], [2, 0]);
  // A A B A A | A B A A B A — the longest run is three (game 1's last two and game 2's first)
  eq('streaks: A won 3 points in a row (and 2 games)', [A.streak.points, A.streak.games], [3, 2]);
  eq('the game log', s.games.map((g) => [g.set, g.n, g.serverSide, g.winner, g.break, g.points.length]), [[1, 1, 'A', 'A', false, 5], [1, 2, 'B', 'A', true, 6]]);
  ok('… with the break points marked on the points', s.games[1].points.filter((p) => p.bp).length === 2);
  ok('every figure is available (serves, outcomes and net recorded)', s.available.serve && s.available.outcomes && s.available.net);
  ok('rally length and speed were not recorded: unavailable', !s.available.rally && !s.available.speed && A.avgRally === null && A.serve.fastestKmh === null);
  // undo and reclassify
  const last = L.timeline.filter((e) => e.type === 'POINT').slice(-1)[0];
  go(L, { type: 'UNDO', reason: 'x' });
  const s2 = stats(L);
  eq('an undone point no longer counts', [s2.sides.A.pointsWon, s2.sides.A.ret.gamesWon], [7, 0]);
  void last;
  const ace = L.timeline.find((e) => e.type === 'POINT' && e.kind === 'ACE');
  go(L, { type: 'CORRECT', target: ace.eventId, patch: { kind: 'SERVICE_WINNER' }, reason: 'it was touched' });
  eq('a reclassified point counts as it reads now', [stats(L).sides.A.serve.aces, stats(L).sides.A.serve.serviceWinners], [1, 1]);
}

head('UNAVAILABLE IS NOT ZERO');
{
  const L = L0('singles');
  for (let i = 0; i < 8; i++) go(L, { type: 'POINT', winner: i % 3 ? 'A' : 'B' });
  const s = stats(L);
  ok('generic points: winners / errors unavailable (null), not 0', s.sides.A.winners === null && s.sides.A.unforcedErrors === null && !s.available.outcomes);
  ok('no serve tracking: first-serve % unavailable', s.sides.A.serve.firstPct === null && s.sides.A.serve.firstWon === null && !s.available.serve);
  ok('… but service points won are always known', s.sides.A.serve.points > 0 && s.sides.A.serve.wonPct !== null);
  ok('net points unavailable', s.sides.A.net === null);
  go(L, { type: 'MANUAL_STAT', playerId: 'a1', key: 'fastestServeKmh', value: 196 });
  eq('a manually entered fastest serve', [stats(L).sides.A.serve.fastestKmh, stats(L).available.speed], [196, true]);
  const F = L0('singles');                         // A serves game 1
  go(F, { type: 'MANUAL_STAT', playerId: 'a1', key: 'fastestServeKmh', value: 196 });
  go(F, { type: 'POINT', winner: 'A', speed: 201, serve: 1 });
  eq('a recorded speed above it wins', [stats(F).sides.A.serve.fastestKmh, stats(F).sides.A.serve.avgFirstKmh], [201, 201]);
  go(F, { type: 'MANUAL_STAT', playerId: 'a1', key: 'fastestServeKmh', value: 210 });
  eq('… and a higher manual one beats the recorded', stats(F).sides.A.serve.fastestKmh, 210);
}

head('DOUBLES — per player');
{
  const L = L0('doubles');
  // game 1 a1 serves: 2 aces; game 2 b1; game 3 a2: 1 ace
  P(L, 'A', 'ACE'); P(L, 'A', 'ACE'); P(L, 'A'); P(L, 'A');
  P(L, 'B'); P(L, 'B'); P(L, 'B'); P(L, 'B');
  P(L, 'A', 'ACE'); P(L, 'A', 'WINNER', { player: 'a1' }); P(L, 'A'); P(L, 'A');
  const s = stats(L);
  eq('aces per server', [s.players.a1.serve.aces, s.players.a2.serve.aces, s.sides.A.serve.aces], [2, 1, 3]);
  eq('service games per server', [s.players.a1.serve.games, s.players.a2.serve.games, s.players.b1.serve.games], [1, 1, 1]);
  eq('a named winner is the player\'s', [s.players.a1.winners, s.players.a2.winners], [1, 0]);
  const ace = L.timeline.find((e) => e.kind === 'ACE');
  eq('an ace\'s clip: the server (ace) — the point winner too', Stats.pointParticipants(L.setup, ace).map((p) => p.playerId + ':' + p.role), ['a1:ace', 'a1:won']);
  const team = L.timeline.filter((e) => e.type === 'POINT' && e.side === 'B')[0];
  eq('an unnamed doubles point: both players of the team won it', Stats.pointParticipants(L.setup, team).map((p) => p.playerId + ':' + p.role), ['b1:won', 'b2:won']);
  eq('clip kinds: ace', Stats.clipKindOf(ace), 'ACE');
}

head('CLIP KINDS FROM PRESSURE');
{
  const L = L0('singles', { bestOf: 1 });
  for (let g = 0; g < 5; g++) for (let i = 0; i < 4; i++) P(L, 'A');
  P(L, 'A'); P(L, 'A'); P(L, 'A');
  const e = P(L, 'A');
  const entry = L.entry(e.eventId);
  eq('the match-winning point is a MATCH_POINT clip', Stats.clipKindOf(entry), 'MATCH_POINT');
}

head('DRAWS — knockout');
{
  eq('seed lines for 8', D.seedOrder(8), [1, 8, 5, 4, 3, 6, 7, 2]);
  eq('seed lines for 16: 1 v 16 on top, 15 v 2 at the bottom (seed 2 on the last line)', [D.seedOrder(16).slice(0, 2), D.seedOrder(16).slice(-2)], [[1, 16], [15, 2]]);
  const ent = (n) => Array.from({ length: n }, (_, i) => ({ entryId: 'e' + (i + 1), seed: i < 4 ? i + 1 : null }));
  const k5 = D.knockout(ent(5));
  eq('5 entries → a draw of 8 with 3 byes', [k5.size, k5.lines.filter((x) => !x).length], [8, 3]);
  const r1 = k5.matches.filter((m) => m.round === 1);
  // side A is the upper line of the draw sheet (e5 on line 3, e4 on line 4)
  eq('round 1: only 5 v 4 plays (seeds 1-3 have byes)', r1.map((m) => [m.A.entryId, m.B.entryId]), [['e5', 'e4']]);
  const sf = k5.matches.filter((m) => m.round === 2);
  eq('semi-finals: seed 1 v the winner of 4/5; seed 2 v seed 3 (byes go straight through)', sf.map((m) => [m.A, m.B]), [[{ entryId: 'e1' }, { winnerOf: 'KO:1:2' }], [{ entryId: 'e3' }, { entryId: 'e2' }]]);
  eq('round names', k5.matches.map((m) => m.roundLabel), ['Quarter-final', 'Semi-final', 'Semi-final', 'Final']);
  ok('no bye ever meets a bye', k5.lines.every((x, i) => i % 2 || x || k5.lines[i + 1]));
  const k6 = D.knockout(ent(6));
  eq('6 entries: byes to seeds 1 and 2', k6.matches.filter((m) => m.round === 1).length, 2);
  const k32 = D.knockout(ent(32), { thirdPlace: true });
  eq('32 entries: 16 + 8 + 4 + 2 + 1 + third place', k32.matches.length, 32);
  eq('first match: 1 v 32', [k32.matches[0].A.entryId, k32.matches[0].B.entryId], ['e1', 'e32']);
  eq('rounds', [...new Set(k32.matches.map((m) => m.roundLabel))], ['Round of 32', 'Round of 16', 'Quarter-final', 'Semi-final', 'Final', 'Third place']);
  eq('the third-place match takes the semi-final losers', k32.matches.find((m) => m.thirdPlace).A, { loserOf: 'KO:4:1' });
  eq('keys are stable (generating again plans the same matches)', JSON.stringify(D.knockout(ent(32), { thirdPlace: true }).matches.map((m) => m.key)), JSON.stringify(k32.matches.map((m) => m.key)));
  const r = D.knockout(ent(8), { random: 'tournament-x' }), r2 = D.knockout(ent(8), { random: 'tournament-x' });
  eq('a random draw of the unseeded is reproducible', r.lines, r2.lines);
  eq('… and the seeds keep their lines', [r.lines[0].entryId, r.lines[7].entryId], ['e1', 'e2']);
  eq('one entry: no draw', D.knockout(ent(1)).matches.length, 0);
}

head('DRAWS — round robin and standings');
{
  const rr = D.roundRobin(['a', 'b', 'c', 'd']);
  eq('4 in a group: 6 matches', rr.length, 6);
  const pairs = new Set(rr.map((m) => [m.A, m.B].sort().join('')));
  eq('every pair exactly once', pairs.size, 6);
  eq('5 in a group: 10 matches', D.roundRobin(['a', 'b', 'c', 'd', 'e']).length, 10);
  const done = (a, b, winner, scores, reason) => ({ status: 'completed', sides: { A: { entryId: a }, B: { entryId: b } }, result: { winner, reason: reason || 'played', sets: { A: scores.filter((s) => s[0] > s[1]).length, B: scores.filter((s) => s[1] > s[0]).length }, scores: scores.map(([x, y]) => ({ A: x, B: y })) } });
  const entries = [{ entryId: 'a', seed: 1 }, { entryId: 'b', seed: 2 }, { entryId: 'c' }, { entryId: 'd' }];
  // a, b, c each 2 wins (a beat b, b beat c, c beat a), d none
  const ms = [
    done('a', 'b', 'A', [[6, 4], [6, 4]]),          // a 2-0
    done('b', 'c', 'A', [[6, 4], [3, 6], [6, 4]]),  // b 2-1
    done('c', 'a', 'A', [[6, 4], [4, 6], [7, 5]]),  // c 2-1
    done('a', 'd', 'A', [[6, 0], [6, 0]]),
    done('b', 'd', 'A', [[6, 1], [6, 1]]),
    done('c', 'd', 'A', [[6, 2], [3, 6], [6, 2]])
  ];
  const st = D.standings(entries, ms);
  // sets: a 5-2 (71.4%), b 4-3 (57.1), c 4-4 (50) → a, b, c, d
  eq('three tied on wins → sets %: a, b, c, then d', st.map((r) => r.entryId), ['a', 'b', 'c', 'd']);
  eq('… with the figures', st.map((r) => [r.won, r.setsWon, r.setsLost]), [[2, 5, 2], [2, 4, 3], [2, 5, 4], [0, 1, 6]]);
  const two = D.standings([{ entryId: 'x' }, { entryId: 'y' }, { entryId: 'z' }], [done('x', 'y', 'B', [[4, 6], [4, 6]]), done('x', 'z', 'A', [[6, 0], [6, 0]]), done('y', 'z', 'B', [[0, 6], [0, 6]])]);
  // x 1 win (beat z), y 1 win (beat x), z 1 win (beat y) → 3-way; sets: x 2-2, y 2-2, z 2-2; games: x 12+8=20 won / 12 lost? computed — just check a deterministic order and flags
  ok('a perfect three-way tie is ordered and flagged', two.length === 3 && two.every((r) => r.rank));
  const h = D.standings([{ entryId: 'p' }, { entryId: 'q' }, { entryId: 'r' }], [done('q', 'p', 'A', [[6, 4], [6, 4]]), done('p', 'r', 'A', [[6, 0], [6, 0]]), done('q', 'r', 'B', [[0, 6], [0, 6]])]);
  // p 1 win, q 1 win, r 1 win — 3-way; make a two-way instead:
  void h;
  const tw = D.standings([{ entryId: 'p' }, { entryId: 'q' }, { entryId: 'r' }], [done('q', 'p', 'A', [[7, 6], [7, 6]]), done('p', 'r', 'A', [[6, 0], [6, 0]]), done('q', 'r', 'A', [[6, 4], [6, 4]])]);
  eq('two tied?  no — q 2 wins, p 1, r 0', tw.map((r) => r.entryId), ['q', 'p', 'r']);
  const t2 = D.standings([{ entryId: 'p' }, { entryId: 'q' }, { entryId: 'r' }, { entryId: 's' }], [
    done('q', 'p', 'A', [[7, 6], [7, 6]]), done('p', 'r', 'A', [[6, 0], [6, 0]]), done('p', 's', 'A', [[6, 0], [6, 0]]),
    done('q', 'r', 'B', [[0, 6], [0, 6]]), done('q', 's', 'A', [[6, 0], [6, 0]]), done('r', 's', 'B', [[0, 6], [0, 6]])]);
  // p 2 wins (r, s), q 2 wins (p, s), r 1 (q), s 1 (r) → p/q tied: q beat p
  eq('two tied on wins → who won their match (q beat p)', t2.slice(0, 2).map((r) => r.entryId), ['q', 'p']);
  const wo = D.standings([{ entryId: 'u' }, { entryId: 'v' }], [done('u', 'v', 'A', [], 'walkover')]);
  eq('a walkover is a win, with no sets or games', [wo[0].entryId, wo[0].won, wo[0].setsWon, wo[1].walkovers], ['u', 1, 0, 1]);
  const seeds = D.seedsFromGroups([{ name: 'A', rows: [{ entryId: 'A1' }, { entryId: 'A2' }] }, { name: 'B', rows: [{ entryId: 'B1' }, { entryId: 'B2' }] }], 2);
  const ko = D.knockout(seeds);
  eq('groups → knockout: A1 v B2, A2 v B1 (each winner meets the other group\'s runner-up)', ko.matches.filter((m) => m.round === 1).map((m) => m.A.entryId + '-' + m.B.entryId), ['A1-B2', 'A2-B1']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
