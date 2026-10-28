/* 🏐 Volleyball engine — the rules (FIVB 2025-2028) as the engine applies them.

   Every test drives the REAL volleyball-engine.js through its Ledger (the
   same path the server uses), and after every single event checks that the
   incremental state equals a from-scratch replay of the ledger — the
   property that makes Resume and corrections exact.

     node test/volleyball/engine.test.js
*/
const E = require('../../volleyball-engine.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, expected: b }); }
function head(t) { console.log('\n=== ' + t + ' ==='); }

// Two squads: 12 court players + 2 liberos each.
function squad(p, name) {
  const players = [];
  for (let i = 1; i <= 14; i++) players.push({ playerId: p + i, number: i, name: name + ' ' + i, role: i === 13 || i === 14 ? 'L' : 'OH', libero: i >= 13 });
  return players;
}
const SETUP = (rules) => ({
  teams: { A: { teamId: 'tA', name: 'Alpha', players: squad('a', 'Alpha') }, B: { teamId: 'tB', name: 'Bravo', players: squad('b', 'Bravo') } },
  rules: rules || {}
});
const SIX = { A: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], B: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'] };

// A match driven through the Ledger, checked against a full replay after every event.
function Match(rules) {
  const L = new E.Ledger(SETUP(rules), []);
  let n = 0, consistent = true;
  const m = {
    L,
    send(type, o, expectFail) {
      const ev = Object.assign({ eventId: 'ev' + (++n), type, at: 1000 * n }, o || {});
      const r = L.check(ev);
      if (r.ok) {
        L.commit(r.pending);
        const full = E.replay(SETUP(rules), L.events);
        if (JSON.stringify(full.state) !== JSON.stringify(L.state)) consistent = false;
      } else if (!expectFail) {
        throw new Error(type + ' refused: ' + r.code + ' ' + r.error);
      }
      return r;
    },
    toss(o) { return m.send('TOSS', Object.assign({ set: 1, winner: 'A', choice: 'serve', leftSide: 'A' }, o)); },
    lineups(set, a, b) { m.send('LINEUP', { set, team: 'A', positions: a || SIX.A }); m.send('LINEUP', { set, team: 'B', positions: b || SIX.B }); },
    start(set) { return m.send('SET_START', { set }); },
    begin() { m.toss(); m.lineups(1); m.start(1); return m; },
    point(team, o, expectFail) { return m.send('RALLY', Object.assign({ winner: team }, o || {}), expectFail); },
    points(seq) { for (const c of seq) m.point(c); },
    // score `a`-`b` in the current set without ending it on the way: alternate, then finish
    to(a, b) {
      const s = E.score(L.state);
      let needA = a - s.A, needB = b - s.B;
      while (needA > 0 || needB > 0) {
        if (needA > 0) { m.point('A'); needA--; }
        if (needB > 0) { m.point('B'); needB--; }
      }
    },
    winSet(team) { // `team` scores until the set is over
      const n = L.state.sets.length;
      while (L.state.status === 'in_set' && L.state.sets.length === n) m.point(team);
    },
    get s() { return E.summary(L.setup, L.state); },
    get state() { return L.state; },
    consistent() { return consistent; }
  };
  return m;
}

head('1-4  SET POINTS: 25, two clear, no ceiling');
{
  const m = Match().begin();
  m.to(24, 20);
  ok('24-20: set still on', m.s.status === 'in_set');
  m.point('A');
  eq('1. 25-20 wins the set', [m.s.sets[0], m.s.setsWon], [{ set: 1, A: 25, B: 20, winner: 'A', status: 'completed', forfeit: false, deciding: false }, { A: 1, B: 0 }]);
}
{
  const m = Match().begin();
  m.to(24, 24);
  eq('2. 24-24 continues', [m.s.status, m.s.points], ['in_set', { A: 24, B: 24 }]);
  m.point('A');
  eq('3. 25-24 does not end the set', [m.s.status, m.s.points, m.s.setPoint], ['in_set', { A: 25, B: 24 }, 'A']);
  m.point('A');
  eq('4. 26-24 ends it', [m.s.status, m.s.sets[0].A, m.s.sets[0].B, m.s.sets[0].winner], ['set_break', 26, 24, 'A']);
}
{
  const m = Match().begin();
  m.to(28, 28); m.point('B'); m.point('A'); m.point('A');
  eq('28-29, 29-29, 30-29: still on (no ceiling)', [m.s.status, m.s.points], ['in_set', { A: 30, B: 29 }]);
  m.point('A');
  eq('31-29 ends it', [m.s.sets[0].A, m.s.sets[0].B, m.s.status], [31, 29, 'set_break']);
  const m2 = Match().begin();
  m2.to(28, 28); m2.point('A');
  ok('29-28: not yet', m2.s.status === 'in_set');
  m2.point('A');
  eq('30-28 wins', [m2.s.sets[0].A, m2.s.sets[0].B, m2.s.status], [30, 28, 'set_break']);
}

// Plays sets 1-4 to 2-2 so set 5 is the deciding set.
function toDecider() {
  const m = Match().begin();
  m.winSet('A'); m.lineups(2); m.start(2);
  m.winSet('B'); m.lineups(3); m.start(3);
  m.winSet('A'); m.lineups(4); m.start(4);
  m.winSet('B');
  return m;
}

head('5-7  THE DECIDING SET: 15, two clear');
{
  const m = toDecider();
  eq('2-2 after four sets, set 5 is the decider', [m.s.setsWon, m.s.nextSet, m.s.nextDeciding], [{ A: 2, B: 2 }, 5, true]);
  m.lineups(5);
  const r = m.send('SET_START', { set: 5 }, true);
  eq('16. the deciding set needs a fresh toss first', r.code, 'TOSS_REQUIRED');
  m.toss({ set: 5, winner: 'B', choice: 'receive', leftSide: 'B' });
  m.start(5);
  eq('16. the new toss decides who serves first in set 5', [m.s.serving, m.s.target, m.s.leftSide, m.s.decidingToss.winner], ['A', 15, 'B', 'B']);
  m.to(14, 14);
  m.point('A');
  eq('6. 15-14 in the decider continues', [m.s.status, m.s.points], ['in_set', { A: 15, B: 14 }]);
  m.point('B'); m.point('B');
  ok('15-15 then 15-16', m.s.points.B === 16 && m.s.status === 'in_set');
  m.point('A'); m.point('A'); m.point('A');
  eq('7. 18-16 ends the decider and the match', [m.s.sets[4], m.s.status, m.s.winner, m.s.setsWon], [{ set: 5, A: 18, B: 16, winner: 'A', status: 'completed', forfeit: false, deciding: true }, 'completed', 'A', { A: 3, B: 2 }]);
}
{
  const m = toDecider();
  m.toss({ set: 5, winner: 'A', choice: 'serve', leftSide: 'A' }); m.lineups(5); m.start(5);
  m.to(13, 12); m.point('A'); m.point('A');
  eq('5. 15-12 in the decider wins it', [m.s.sets[4].A, m.s.sets[4].B, m.s.winner], [15, 12, 'A']);
  const m2 = toDecider();
  m2.toss({ set: 5, winner: 'A', choice: 'serve', leftSide: 'A' }); m2.lineups(5); m2.start(5);
  m2.to(15, 15); m2.point('B'); m2.point('B');
  eq('17-15 decider for B', [m2.s.sets[4].A, m2.s.sets[4].B, m2.s.winner], [15, 17, 'B']);
}

head('8-9  THE MATCH: first to three sets, never a fourth after 3-0');
{
  const m = Match().begin();
  m.winSet('A'); m.lineups(2); m.start(2); m.winSet('A'); m.lineups(3); m.start(3); m.winSet('A');
  eq('8. 3-0 ends the match', [m.s.status, m.s.winner, m.s.setsWon, m.s.result.setScores.length], ['completed', 'A', { A: 3, B: 0 }, 3]);
  const r1 = m.send('LINEUP', { set: 4, team: 'A', positions: SIX.A }, true);
  const r2 = m.send('SET_START', { set: 4 }, true);
  const r3 = m.point('A', null, true) || {};
  eq('9. no fourth set: line-up, set start and rally all refused', [r1.code, r2.code], ['MATCH_OVER', 'MATCH_OVER']);
  ok('9. …and no further rally scores', m.s.sets.length === 3);
}
{
  const m = Match({ bestOf: 3 }).begin();
  m.winSet('B'); m.lineups(2); m.start(2); m.winSet('A');
  eq('best of three: 1-1 after two sets, set 3 is the decider to 15', [m.s.setsWon, m.s.nextDeciding], [{ A: 1, B: 1 }, true]);
  m.toss({ set: 3, winner: 'A', choice: 'court', firstServe: 'B', leftSide: 'B' }); m.lineups(3); m.start(3);
  eq('…its toss winner chose the court: the other team serves', [m.s.target, m.s.serving, m.s.leftSide], [15, 'B', 'B']);
  m.winSet('B');
  eq('…and 2 sets win a best of three', [m.s.winner, m.s.setsWon], ['B', { A: 1, B: 2 }]);
}

head('10-13  SERVICE AND ROTATION');
{
  const m = Match().begin();
  const before = m.state.positions.A.slice();
  eq('13. the server is the player in position I', [m.s.serving, m.s.server.playerId], ['A', 'a1']);
  m.point('A');
  eq('10. the serving team wins the rally: keeps serving, no rotation', [m.s.serving, m.state.positions.A, m.s.server.playerId], ['A', before, 'a1']);
  const bBefore = m.state.positions.B.slice();
  m.point('B');
  eq('11. the receiving team wins: it serves now and has rotated', [m.s.serving, m.state.positions.B], ['B', E.rotateClockwise(bBefore)]);
  eq('11. …and the serving team that lost did not rotate', m.state.positions.A, before);
  // FIVB 7.6.1: II→I, I→VI, VI→V, V→IV, IV→III, III→II
  const p = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  const r = E.rotateClockwise(p);
  eq('12. clockwise: II→I, I→VI, VI→V, V→IV, IV→III, III→II', [r[0], r[5], r[4], r[3], r[2], r[1]], ['p2', 'p1', 'p6', 'p5', 'p4', 'p3']);
  eq('13. after the side-out the new server is the player from II', m.s.server.playerId, 'b2');
}
{
  const m = Match().begin();
  // B receives first. Six side-outs for B: its servers are b2, b3, b4, b5, b6, b1.
  const servers = [];
  for (let i = 0; i < 6; i++) { m.point('B'); servers.push(m.s.server.playerId); m.point('A'); }
  eq('a full turn of rotation: each player serves once, in order', servers, ['b2', 'b3', 'b4', 'b5', 'b6', 'b1']);
  eq('six rotations each: both teams are back in their starting order', [m.state.positions.A, m.state.positions.B], [SIX.A, SIX.B]);
  eq('rotation count kept per set', m.state.sets[0].rotations, { A: 6, B: 6 });
}

head('14-15  CHANGE OF COURTS');
{
  const m = Match().begin();
  eq('set 1 courts come from the toss', m.s.leftSide, 'A');
  m.winSet('A');
  m.lineups(2); m.start(2);
  eq('14. a new set: courts changed, 0-0, no point awarded', [m.s.leftSide, m.s.points, m.s.setsWon], ['B', { A: 0, B: 0 }, { A: 1, B: 0 }]);
  eq('…and the team that received first in set 1 serves first in set 2', m.s.serving, 'B');
}
{
  const m = toDecider();
  m.toss({ set: 5, winner: 'A', choice: 'serve', leftSide: 'A' }); m.lineups(5); m.start(5);
  m.to(7, 5);
  const posA = m.state.positions.A.slice(), posB = m.state.positions.B.slice(), srv = m.s.server, sc = Object.assign({}, m.s.points);
  ok('7-5: no change yet', m.s.leftSide === 'A' && !m.s.sideSwitched);
  const r = m.point('A');
  ok('15. the leader reaches 8: CHANGE_COURTS', r.pending.effects.some(e => e.type === 'CHANGE_COURTS'));
  eq('15. courts changed, line-ups and server untouched by it', [m.s.leftSide, m.state.positions.A, m.state.positions.B, m.s.server.playerId, m.s.points], ['B', posA, posB, srv.playerId, { A: sc.A + 1, B: sc.B }]);
  m.point('B'); m.point('A');
  eq('…once only', m.s.leftSide, 'B');
}

head('17  REPLAYED RALLY');
{
  const m = Match().begin();
  m.points('AB');
  const before = JSON.stringify([m.s.points, m.s.serving, m.s.server, m.state.positions]);
  const r = m.send('REPLAY', { reason: 'DOUBLE_FAULT' });
  eq('17. a replay awards no point, keeps the server and the rotation', JSON.stringify([m.s.points, m.s.serving, m.s.server, m.state.positions]), before);
  ok('…but is counted as a rally played', m.state.sets[0].replays === 1 && m.state.sets[0].rallies === 3);
}

head('18-20  UNDO, CORRECTION, DUPLICATES');
{
  const m = Match().begin();
  m.points('AAB');
  const snap = JSON.stringify([m.s.points, m.s.serving, m.s.server, m.state.positions, m.state.sets[0].rotations]);
  m.point('A');
  ok('a side-out happened', m.s.serving === 'A');
  m.send('UNDO', {});
  eq('18. Undo restores score, server, rotation exactly', JSON.stringify([m.s.points, m.s.serving, m.s.server, m.state.positions, m.state.sets[0].rotations]), snap);
  m.send('REDO', {});
  eq('Redo brings the point back', m.s.points, { A: 3, B: 1 });
  m.send('UNDO', {}); m.send('UNDO', {});
  eq('two undos: back two rallies', m.s.points, { A: 2, B: 0 });
  m.point('B');
  const rr = m.send('REDO', {}, true);
  eq('no redo once something new was recorded', rr.code, 'NOTHING_TO_REDO');
  const tl = m.L.timeline.filter(e => e.type === 'RALLY');
  eq('the undone rallies stay in the ledger, marked', [tl.filter(e => e.voided).length, tl.length], [2, 5]);
}
{
  const m = Match().begin();
  // A serves: A A B(side-out) B A(side-out)
  m.point('A'); const wrong = m.point('A'); m.points('BBA');
  eq('before the correction', [m.s.points, m.s.serving, m.s.server.playerId], [{ A: 3, B: 2 }, 'A', 'a2']);
  m.send('CORRECT', { target: wrong.pending.event.eventId, patch: { winner: 'B' }, reason: 'scorer pressed the wrong team' });
  // now: A, B(side-out B), B, B, A(side-out A) => 2-3
  eq('19. correcting rally 2 recomputes the score and every later server', [m.s.points, m.s.serving, m.s.server.playerId], [{ A: 2, B: 3 }, 'A', 'a2']);
  ok('…the timeline shows the corrected rally', m.L.timeline.find(e => e.eventId === wrong.pending.event.eventId).corrected.length === 1);
  const c2 = m.send('CORRECT', { target: wrong.pending.event.eventId, patch: { outcome: 'ATTACK_KILL', players: { attacker: 'b4' } }, reason: 'who scored' });
  ok('a second correction (classification) keeps the first (winner)', c2.ok && m.s.points.B === 3);
  const bad = m.send('CORRECT', { target: wrong.pending.event.eventId, patch: { outcome: 'ACE' }, reason: 'x' }, true);
  eq('a correction that cannot be true where it stands is refused', bad.code, 'OUTCOME_SERVING');
}
{
  // who earned a point, said AFTER it (the panel's "Who earned this point?")
  const m = Match().begin();
  m.point('A'); const p2 = m.point('A');
  const at = m.send('CORRECT', { target: p2.pending.event.eventId, patch: { outcome: 'ATTACK_KILL', players: { attacker: 'a4' } }, reason: 'Point attribution', attribution: true });
  ok('an attribution after the point: a kill by the player, the score untouched', at.ok && m.s.points.A === 2 && m.L.timeline.find((e) => e.eventId === p2.pending.event.eventId).players.attacker === 'a4');
  m.send('UNDO', {});
  eq('Undo takes back the last POINT — not the attribution made after it', [m.s.points, !!m.L.timeline.find((e) => e.eventId === p2.pending.event.eventId).voided], [{ A: 1, B: 0 }, true]);
  m.send('CORRECT', { target: m.L.timeline.find((e) => e.type === 'RALLY' && !e.voided).eventId, patch: { outcome: 'GENERAL', players: null }, reason: 'Point attribution', attribution: true });
  const rd = m.send('REDO', {});
  eq('…and an attribution in between does not stand in the way of Redo (the kill comes back with its player)', [rd.ok, m.s.points, m.L.timeline.find((e) => e.eventId === p2.pending.event.eventId).players.attacker], [true, { A: 2, B: 0 }, 'a4']);
  const plain = m.send('CORRECT', { target: p2.pending.event.eventId, patch: { outcome: 'GENERAL' }, reason: 'scorer correction' });
  m.send('UNDO', {});
  ok('an ordinary correction is still what Undo takes back first (unchanged)', plain.ok && m.s.points.A === 2 && m.L.timeline.find((e) => e.eventId === plain.pending.event.eventId).voided === true);
}
{
  const m = Match().begin();
  const r = m.point('A');
  const dup = m.L.check(Object.assign({}, r.pending.event, { seq: undefined }));
  eq('20. the same eventId again (a retry) is a duplicate, never a second point', [dup.code, dup.duplicate, m.s.points], ['DUPLICATE', true, { A: 1, B: 0 }]);
}
{
  const m = Match().begin();
  m.to(24, 20);
  const early = m.L.timeline.filter(e => e.type === 'RALLY' && !e.voided)[3];
  m.point('A');      // 25-20, set over
  m.lineups(2); m.start(2);
  m.point('B');
  // flipping an early B point to A would end set 1 at 25-19 one rally sooner -> the
  // set's last rally and set 2 would have nowhere to go: refused, nothing changes
  const target = m.L.timeline.find(e => e.type === 'RALLY' && e.team === 'B' && !e.voided && e.after.set === 1);
  const r = m.send('CORRECT', { target: target.eventId, patch: { winner: 'A' }, reason: 'test' }, true);
  eq('a correction that would rewrite where a set ended is refused, with the reason', r.code, 'CORRECTION_CONFLICT');
  eq('…and changes nothing', [m.s.set, m.s.points, m.s.setsWon], [2, { A: 0, B: 1 }, { A: 1, B: 0 }]);
  const v = m.send('VOID', { target: target.eventId, reason: 'point given in error' });
  eq('voiding that B point instead is fine: set 1 still ends on the same rally, now 25-19', [v.ok, m.s.sets[0].A, m.s.sets[0].B, m.s.set, m.s.points], [true, 25, 19, 2, { A: 0, B: 1 }]);
  ok('(the early rally is still there)', !!early);
}

head('LINE-UPS');
{
  const m = Match();
  m.toss();
  eq('five players is not a line-up', m.send('LINEUP', { set: 1, team: 'A', positions: ['a1', 'a2', 'a3', 'a4', 'a5'] }, true).code, 'LINEUP_INVALID');
  eq('a player twice is not a line-up', m.send('LINEUP', { set: 1, team: 'A', positions: ['a1', 'a1', 'a3', 'a4', 'a5', 'a6'] }, true).code, 'LINEUP_INVALID');
  eq('a libero is not in the starting six', m.send('LINEUP', { set: 1, team: 'A', positions: ['a1', 'a2', 'a3', 'a4', 'a5', 'a13'] }, true).code, 'LINEUP_LIBERO');
  eq('a player from the other squad is refused', m.send('LINEUP', { set: 1, team: 'A', positions: ['a1', 'a2', 'a3', 'a4', 'a5', 'b6'] }, true).code, 'INVALID_PLAYER');
  m.send('LINEUP', { set: 1, team: 'A', positions: SIX.A });
  eq('both line-ups are needed to start', m.send('SET_START', { set: 1 }, true).code, 'LINEUP_REQUIRED');
  m.send('LINEUP', { set: 1, team: 'B', positions: SIX.B });
  m.start(1);
  eq('the set starts with the six as entered, position I serving', [m.state.positions.A, m.s.server.playerId], [SIX.A, 'a1']);
  eq('a line-up during a set is refused (use a substitution)', m.send('LINEUP', { set: 2, team: 'A', positions: SIX.A }, true).code, 'SET_IN_PROGRESS');
  const m2 = Match();
  m2.lineups(1);
  eq('no first set without the toss', m2.send('SET_START', { set: 1 }, true).code, 'TOSS_REQUIRED');
}

head('SUBSTITUTIONS (FIVB 15.6)');
{
  const m = Match().begin();
  m.point('A');
  m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a3', in: 'a7' }] });
  eq('legal: a starter out, a substitute in, in the same position', m.state.positions.A, ['a1', 'a2', 'a7', 'a4', 'a5', 'a6']);
  eq('…counted (5 left)', m.s.subsLeft.A, 5);
  eq('a second request in the same interruption is improper', m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a4', in: 'a8' }] }, true).code, 'SAME_INTERRUPTION');
  m.point('B');
  eq('the substitute can only be replaced by the starter he replaced', m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a7', in: 'a8' }] }, true).code, 'SUB_ILLEGAL');
  m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a7', in: 'a3' }] });
  ok('legal: the starter returns for his substitute (to his own place in the line-up)', m.state.positions.A.indexOf('a3') >= 0 && m.state.positions.A.indexOf('a7') < 0);
  m.point('A');
  eq('the starter may not leave a second time', m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a3', in: 'a9' }] }, true).code, 'SUB_ILLEGAL');
  eq('the substitute who left may not come back this set', m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a5', in: 'a7' }] }, true).code, 'SUB_ILLEGAL');
  eq('a starter on court cannot come in', m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a5', in: 'a6' }] }, true).code, 'SUB_ALREADY_ON_COURT');
  eq('a libero is never a regular substitute', m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a5', in: 'a13' }] }, true).code, 'SUB_LIBERO');
  // 2 used; 4 left: four more in one request is fine, the 7th is not
  m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a1', in: 'a8' }, { out: 'a2', in: 'a9' }, { out: 'a4', in: 'a10' }, { out: 'a5', in: 'a11' }] });
  eq('six used, none left', m.s.subsLeft.A, 0);
  m.point('B');
  eq('the seventh is refused', m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a6', in: 'a12' }] }, true).code, 'SUB_LIMIT');
  const o = m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a6', in: 'a12' }], override: { reason: 'first referee allowed it' } });
  ok('…unless an authorised override with a reason — flagged in the timeline', o.ok && m.L.timeline[m.L.timeline.length - 1].overridden === 'SUB_LIMIT');
  eq('per-set history kept', m.state.sets[0].subs.A.length, 4);
  m.winSet('A');
  m.lineups(2, ['a7', 'a8', 'a9', 'a10', 'a11', 'a12']); m.start(2);
  eq('a new set: a full allowance again and new starters', [m.s.subsLeft.A, m.state.positions.A[0]], [6, 'a7']);
}
{
  const m = Match().begin();
  m.point('A');
  m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a2', in: 'a7' }], exceptional: true, reason: 'injury' });
  eq('exceptional substitution (FIVB 15.7): not counted', m.s.subsLeft.A, 6);
  m.point('A');
  eq('…and the injured player may not come back this match', m.send('SUBSTITUTION', { team: 'A', pairs: [{ out: 'a7', in: 'a2' }] }, true).code, 'SUB_BARRED');
}

head('TIME-OUTS');
{
  const m = Match().begin();
  m.send('TIMEOUT', { team: 'B' });
  eq('one used, one left', m.s.timeoutsLeft, { A: 2, B: 1 });
  m.send('TIMEOUT', { team: 'B' });
  eq('a third is refused', m.send('TIMEOUT', { team: 'B' }, true).code, 'TIMEOUT_LIMIT');
  eq('…time-outs give no point', m.s.points, { A: 0, B: 0 });
  m.winSet('A'); m.lineups(2); m.start(2);
  eq('two again in the next set', m.s.timeoutsLeft, { A: 2, B: 2 });
}

head('THE LIBERO (FIVB 19)');
{
  const m = Match().begin();   // A serves with a1 in I
  eq('the libero may not replace the server', m.send('LIBERO', { team: 'A', libero: 'a13', replaces: 'a1' }, true).code, 'LIBERO_SERVE');
  eq('the libero may not replace a front-row player', m.send('LIBERO', { team: 'A', libero: 'a13', replaces: 'a3' }, true).code, 'LIBERO_FRONT_ROW');
  eq('only a designated libero', m.send('LIBERO', { team: 'A', libero: 'a7', replaces: 'a5' }, true).code, 'LIBERO_NOT_DESIGNATED');
  m.send('LIBERO', { team: 'B', libero: 'b13', replaces: 'b1' }); // B is receiving: its position I may be replaced
  eq('a receiving team: the libero replaces the back-row player in I', m.state.positions.B[0], 'b13');
  eq('libero replacements are not substitutions', m.s.subsLeft.B, 6);
  eq('two libero replacements need a rally in between', m.send('LIBERO', { team: 'B', libero: 'b13', action: 'out', returning: 'b1' }, true).code, 'LIBERO_NO_RALLY_BETWEEN');
  m.point('A');
  eq('…and the libero leaves only for the player he/she replaced', m.send('LIBERO', { team: 'B', libero: 'b13', action: 'out', returning: 'b2' }, true).code, 'LIBERO_WRONG_RETURN');
  m.point('B'); // side-out: B rotates — b13 from I to VI, b3 (from III→II→I)… the server is b2
  eq('B rotated: the libero is in VI now, the server is b2', [m.state.positions.B[5], m.s.server.playerId], ['b13', 'b2']);
  m.point('A');   // A wins (side-out A); B does not rotate
  m.point('B');   // B side-out: libero VI -> V
  eq('libero in V', m.state.positions.B[4], 'b13');
  m.point('A');
  const r = m.point('B');   // B side-out: the libero would go V -> IV (front row)
  ok('the libero rotating into the front row leaves automatically', r.pending.effects.some(e => e.type === 'LIBERO_AUTO_EXIT'));
  eq('…and the player he/she replaced is back, in IV', [m.state.positions.B[3], m.state.libero.B], ['b1', null]);
  const ex = m.send('SUBSTITUTION', { team: 'B', pairs: [{ out: 'b4', in: 'b7' }] });
  ok('(a regular substitution is still possible)', ex.ok);
  m.point('B');
  const bl = m.point('B', { outcome: 'BLOCK', players: { blockers: ['b14'] } }, true);
  eq('a libero credited with a block is flagged (FIVB 19.3.1.3)', bl.code, 'LIBERO_BLOCK');
  eq('a libero is never part of the starting six', (() => { const mm = Match(); mm.toss(); return mm.send('LINEUP', { set: 1, team: 'B', positions: ['b1', 'b2', 'b3', 'b4', 'b5', 'b14'] }, true).code; })(), 'LINEUP_LIBERO');
}

head('OUTCOMES, PENALTIES, ROTATION FAULTS');
{
  const m = Match().begin();
  eq('an ace can only be the serving team\'s point', m.point('B', { outcome: 'ACE' }, true).code, 'OUTCOME_SERVING');
  eq('a service error can only give the point to the receivers', m.point('A', { outcome: 'SERVICE_ERROR' }, true).code, 'OUTCOME_SERVING');
  m.point('A', { outcome: 'ACE', players: { receiver: 'b5' } });
  m.point('B', { outcome: 'SERVICE_ERROR', players: { errorBy: 'a1' } });
  eq('fault points go to the right team, with service', [m.s.points, m.s.serving], [{ A: 1, B: 1 }, 'B']);
  m.point('A', { outcome: 'ROTATION_FAULT' });
  eq('a rotation fault: point and service to the opponent', [m.s.points, m.s.serving], [{ A: 2, B: 1 }, 'A']);
  m.send('SANCTION', { team: 'A', kind: 'PENALTY', playerId: 'a3' });
  eq('a penalty (red card): point and service to the opponent', [m.s.points, m.s.serving], [{ A: 2, B: 2 }, 'B']);
  m.send('SANCTION', { team: 'A', kind: 'WARNING' });
  eq('a warning gives no point', m.s.points, { A: 2, B: 2 });
  eq('a player from the other team cannot be credited', m.point('B', { outcome: 'ATTACK_KILL', players: { attacker: 'a4' } }, true).code, 'INVALID_PLAYER');
}

head('FORFEIT / ABANDON');
{
  const m = Match().begin();
  m.to(10, 12);
  m.send('FORFEIT', { team: 'A', reason: 'team incomplete' });
  eq('incomplete (FIVB 6.4.3): B gets the points and sets it needs; A keeps its own', [m.s.status, m.s.winner, m.s.result.setScores.map(s => [s.A, s.B])], ['completed', 'B', [[10, 25], [0, 25], [0, 25]]]);
  const m2 = Match();
  m2.send('FORFEIT', { team: 'B', reason: 'did not show' });
  eq('default before the match: 3-0, 25-0 each', [m2.s.winner, m2.s.result.setScores.map(s => [s.A, s.B])], ['A', [[25, 0], [25, 0], [25, 0]]]);
  const m3 = Match().begin();
  m3.point('A');
  m3.send('ABANDON', { reason: 'rain' });
  eq('abandoned: no result', [m3.s.status, m3.s.result], ['abandoned', null]);
  eq('…and nothing more is scored', m3.point('A', null, true).code, 'MATCH_OVER');
}

head('DELAY SANCTIONS (FIVB 16.2) · INCOMPLETE FOR THE SET (FIVB 6.4.3)');
{
  const m = Match().begin();
  eq('a team\'s first delay in the match cannot be a delay penalty', m.send('SANCTION', { team: 'A', kind: 'DELAY_PENALTY' }, true).code, 'DELAY_FIRST');
  m.send('SANCTION', { team: 'A', kind: 'DELAY_WARNING' });
  eq('the first delay: a warning, no point', m.s.points, { A: 0, B: 0 });
  eq('a second delay cannot be another warning', m.send('SANCTION', { team: 'A', kind: 'DELAY_WARNING' }, true).code, 'DELAY_REPEAT');
  m.send('SANCTION', { team: 'A', kind: 'DELAY_PENALTY' });
  eq('…it is a delay penalty: point and service to the opponent', [m.s.points, m.s.serving], [{ A: 0, B: 1 }, 'B']);
  eq('the other team\'s first delay is still only a warning', m.send('SANCTION', { team: 'B', kind: 'DELAY_PENALTY' }, true).code, 'DELAY_FIRST');
  m.to(10, 12);
  m.send('FORFEIT', { team: 'A', scope: 'set', reason: 'incomplete for the set' });
  eq('incomplete for the SET: B wins set 1 with the points it needs, A keeps its 10, the match goes on', [m.s.status, m.s.setsWon, m.s.sets[0].A, m.s.sets[0].B, m.s.sets[0].forfeit], ['set_break', { A: 0, B: 1 }, 10, 25, true]);
  m.lineups(2); m.start(2);
  eq('…set 2 starts as usual', [m.s.status, m.s.set], ['in_set', 2]);
}

head('A PROFESSIONAL MATCH, RULE BY RULE (FIVB 2025-2028)');
{
  const m = Match().begin();
  eq('best of five, 25-point sets, 15 in the fifth, no point cap', [m.s.bestOf, m.s.setsToWin, m.s.target, m.state.rules.decidingSetPoints, m.state.rules.pointCap, m.state.rules.official], [5, 3, 25, 15, null, true]);
  m.to(24, 24);
  m.point('A'); m.point('B'); m.point('A');
  eq('24-24 is not the end: play on until two clear (26-25 still going)', [m.s.status, m.s.points], ['in_set', { A: 26, B: 25 }]);
  m.point('A');
  eq('…27-25 wins it', [m.s.setsWon, m.state.sets[0].points], [{ A: 1, B: 0 }, { A: 27, B: 25 }]);
  m.lineups(2); m.start(2);
  eq('set 2: the team that did not serve first in set 1 serves first, and the teams have changed courts', [m.s.serving, m.s.leftSide], ['B', 'B']);
  const before = m.state.positions.A.slice();
  m.point('A');
  eq('a side-out: the team gaining the serve rotates one position clockwise (II → I)', m.state.positions.A, [before[1], before[2], before[3], before[4], before[5], before[0]]);
  m.point('A');
  eq('…and does not rotate again while it keeps serving', m.state.positions.A, [before[1], before[2], before[3], before[4], before[5], before[0]]);
  m.send('TIMEOUT', { team: 'B' }); m.point('A'); m.send('TIMEOUT', { team: 'B' });
  eq('two 30-second time-outs per team per set', [m.send('TIMEOUT', { team: 'B' }, true).code, m.state.rules.timeoutSeconds], ['TIMEOUT_LIMIT', 30]);
  eq('six substitutions per team per set', m.state.rules.substitutionsPerSet, 6);
  m.winSet('A');
  m.lineups(3); m.start(3);
  m.winSet('B');
  m.lineups(4); m.start(4);
  m.winSet('B');
  eq('2-2 after four sets', m.s.setsWon, { A: 2, B: 2 });
  eq('the deciding set needs its own toss first', m.send('SET_START', { set: 5 }, true).code, 'TOSS_REQUIRED');
  m.toss({ set: 5, winner: 'B', choice: 'serve', leftSide: 'B' });
  m.lineups(5); m.start(5);
  eq('set 5: to 15, the toss winner serves', [m.s.target, m.s.deciding, m.s.serving], [15, true, 'B']);
  m.to(7, 6);
  eq('no change of courts before the leader reaches 8', m.s.sideSwitched, false);
  m.point('A');
  eq('…courts change when the leading team reaches 8 (8-6)', [m.s.sideSwitched, m.s.points], [true, { A: 8, B: 6 }]);
  m.to(14, 14);
  m.point('A');
  eq('15-14 is not enough in the fifth set', m.s.status, 'in_set');
  m.point('A');
  eq('16-14: A wins the match 3-2', [m.s.status, m.s.winner, m.s.setsWon], ['completed', 'A', { A: 3, B: 2 }]);
  ok('the live ledger and a full replay agree all the way', m.consistent());
}

head('RULES');
{
  const fivb = E.normalizeRules({});
  eq('FIVB defaults', [fivb.bestOf, fivb.setPoints, fivb.decidingSetPoints, fivb.winBy, fivb.pointCap, fivb.timeoutsPerSet, fivb.substitutionsPerSet, fivb.official], [5, 25, 15, 2, null, 2, 6, true]);
  const c = E.normalizeRules({ bestOf: 3, setPoints: 21, pointCap: 23 });
  eq('a custom competition is labelled as one', [c.official, c.custom], [false, ['bestOf', 'setPoints', 'pointCap']]);
  eq('an even "best of" is made odd', E.normalizeRules({ bestOf: 4 }).bestOf, 5);
  const m = Match({ setPoints: 21, pointCap: 23 }).begin();
  m.to(22, 22); m.point('B');
  eq('a capped set ends at the cap (23-22)', [m.s.sets[0].A, m.s.sets[0].B, m.s.sets[0].winner], [22, 23, 'B']);
  ok('isSetWon(25,23) / (25,24) / (26,24)', E.isSetWon(25, 23, 25, 2) && !E.isSetWon(25, 24, 25, 2) && E.isSetWon(26, 24, 25, 2));
}

head('RESUME = REPLAY');
{
  const m = toDecider();
  m.toss({ set: 5, winner: 'B', choice: 'serve', leftSide: 'A' }); m.lineups(5); m.start(5);
  m.send('TIMEOUT', { team: 'A' });
  m.send('LIBERO', { team: 'A', libero: 'a13', replaces: 'a5' });
  m.points('ABBAAB');
  m.send('SUBSTITUTION', { team: 'B', pairs: [{ out: 'b2', in: 'b8' }] });
  const fresh = new E.Ledger(SETUP(), m.L.events.map(e => JSON.parse(JSON.stringify(e))).reverse());
  eq('a brand-new Ledger from the stored events (any order) is the same match', JSON.stringify(fresh.state), JSON.stringify(m.state));
  eq('…same server, rotation, libero, counters', [E.summary(fresh.setup, fresh.state).server.playerId, fresh.state.positions, fresh.state.libero.A, E.summary(fresh.setup, fresh.state).timeoutsLeft],
    [m.s.server.playerId, m.state.positions, m.state.libero.A, m.s.timeoutsLeft]);
  ok('incremental state == full replay after every one of ' + m.L.events.length + ' events', m.consistent());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
