/* 🎾 Tennis engine — the rules, run for real (no mocks):

     • standard games: Love-All … 40-30, deuce, advantage either way, back to
       deuce, game; the call is the SERVER's score first
     • sets 6-0 … 6-4, 7-5, 7-6 by tie-break, advantage sets (no tie-break)
     • tie-breaks: 7-0, 7-5, 7-6 is not won, 8-6, beyond the target (11-9),
       the 10-point match tie-break; the tie-break's service rotation; the
       next set opens with the other server
     • best of 3 / best of 5, completion, no point after the match, no empty set
     • No-Ad: the deciding point (and who the receivers chose)
     • serve: a first-serve fault never gives a point, a double fault gives
       the receiver the point, an ace is the server's, a let changes nothing
       (and is refused under the no-let rule)
     • doubles: the order of service A1 B1 A2 B2, receiving deuce / ad, the
       tie-break in doubles, a new set (the team due, the order re-chosen),
       the match tie-break
     • change of ends: odd games, the set break, every six tie-break points
     • game / break / set / match point and how many (0-40 = three)
     • undo after a point, deuce, advantage, game, set, tie-break, match,
       double fault, rotation; undo then a new point; redo; never twice
     • corrections: how a point was won (score untouched), who won it (the
       score moves on), refused when it would contradict later points; void
     • pause / suspend / resume, retire, walkover, default, abandon
     • short sets, FAST4, pro set; rules normalisation and presets
     • THE PROPERTY: after every one of thousands of random events, the
       incremental ledger (O(1) undo) equals a full replay
     • undo stays O(1): its cost does not grow with the length of the match

     node test/tennis/engine.test.js
*/
'use strict';
const E = require('../../tennis-engine.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, expected: b }); }
function head(t) { console.log('\n=== ' + t + ' ==='); }

const P = { a1: 'pa1', a2: 'pa2', b1: 'pb1', b2: 'pb2' };
function setup(format, rules) {
  return format === 'doubles'
    ? { format: 'doubles', rules: rules || {}, sides: { A: { players: [{ playerId: P.a1, name: 'Anna Alpha' }, { playerId: P.a2, name: 'Asha Arora' }] }, B: { players: [{ playerId: P.b1, name: 'Bella Bravo' }, { playerId: P.b2, name: 'Bina Bose' }] } } }
    : { format: 'singles', rules: rules || {}, sides: { A: { players: [{ playerId: P.a1, name: 'Roger Alpha' }] }, B: { players: [{ playerId: P.b1, name: 'Rafa Bravo' }] } } };
}
let idn = 0;
const nid = () => 'e' + (++idn);
function send(L, ev) {
  const e = Object.assign({ eventId: nid(), at: 1700000000000 + idn * 1000 }, ev);
  const chk = L.check(e);
  if (!chk.ok) return chk;
  L.commit(chk.pending);
  return { ok: true, event: chk.pending.event };
}
function must(L, ev, what) {
  const r = send(L, ev);
  if (!r.ok) throw new Error((what || ev.type) + ' refused: ' + r.error);
  return r;
}
function start(format, rules, opts) {
  opts = opts || {};
  const L = new E.Ledger(setup(format, rules), []);
  const ev = { type: 'START', server: opts.server || P.a1, left: 'A' };
  if (format === 'doubles') { ev.order = opts.order || [P.a1, P.b1, P.a2, P.b2]; ev.receive = opts.receive || { A: { deuce: P.a1, ad: P.a2 }, B: { deuce: P.b1, ad: P.b2 } }; }
  must(L, ev);
  return L;
}
const S = (L) => E.summary(L.setup, L.state);
const pt = (L, side, extra) => must(L, Object.assign({ type: 'POINT', winner: side }, extra || {}));
function points(L, seq) { for (const c of seq) pt(L, c); }
// one game to `side`, whoever serves, from 0-0 (a tie-break: to its target)
function game(L, side) {
  const g = L.state.game;
  const before = L.state.gameNo;
  let guard = 0;
  while (L.state.gameNo === before && L.state.status === 'in_play' && guard++ < 40) pt(L, side);
  if (g && guard >= 40) throw new Error('game did not end');
}
function games(L, side, n) { for (let i = 0; i < n; i++) game(L, side); }
const disp = (L) => { const s = S(L); return s.display.A + '-' + s.display.B; };
const gamesOf = (L) => { const s = S(L); const cur = s.sets[s.sets.length - 1]; return cur ? cur.A + '-' + cur.B : ''; };
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).sort().forEach((k) => { if (v[k] !== undefined) o[k] = canon(v[k]); }); return o; }
  return v;
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
// the incremental ledger against a full replay: the state, and every entry that counts
function matchesReplay(L) {
  const r = L.verify();
  if (!same(L.state, r.state)) return { ok: false, why: 'state', a: L.state, b: r.state };
  if (L.timeline.length !== r.timeline.length) return { ok: false, why: 'timeline length' };
  for (let i = 0; i < r.timeline.length; i++) {
    const a = L.timeline[i], b = r.timeline[i];
    if (!!a.voided !== !!b.voided) return { ok: false, why: 'voided flag at ' + i, a, b };
    if (a.voided) { if (a.eventId !== b.eventId || a.voidedBy !== b.voidedBy || a.kind !== b.kind) return { ok: false, why: 'voided entry ' + i, a, b }; continue; }
    if (!same(a, b)) return { ok: false, why: 'entry ' + i, a, b };
  }
  if (L.stack.length !== r.stack.length || L.stack.some((x, i) => x.eventId !== r.stack[i].eventId || x.idx !== r.stack[i].idx)) return { ok: false, why: 'undo stack' };
  return { ok: true };
}

/* ============================================================ */
head('RULES');
{
  const d = E.normalizeRules({});
  eq('default: best of 3, sets to 6, tie-break at 6-all to 7, two clear', [d.bestOf, d.gamesPerSet, d.tiebreakAt, d.tiebreakPoints, d.tiebreakMargin, d.finalSet, d.noAd, d.lets], [3, 6, 6, 7, 2, 'standard', false, true]);
  ok('the default is the standard format', d.official && d.custom.length === 0);
  ok('best of 5 is still standard (only the length differs)', E.normalizeRules({ bestOf: 5 }).official);
  eq('an even best-of becomes odd', E.normalizeRules({ bestOf: 4 }).bestOf, 5);
  eq('tiebreakAt: null = advantage sets', E.normalizeRules({ tiebreakAt: null }).tiebreakAt, null);
  eq('a tie-break below one game short of the set is not a format: back to 6-all', E.normalizeRules({ tiebreakAt: 3 }).tiebreakAt, 6);
  eq('short sets: a tie-break at 3-all in a set to 4 is allowed (FAST4)', E.normalizeRules({ gamesPerSet: 4, tiebreakAt: 3 }).tiebreakAt, 3);
  eq('a tie-break at 12-all (an old Wimbledon final set) is allowed', E.normalizeRules({ finalSet: 'tiebreak', finalTiebreakAt: 12, finalTiebreakPoints: 7 }).finalTiebreakAt, 12);
  const mtb = E.normalizeRules({ finalSet: 'matchTiebreak' });
  eq('a match tie-break defaults to first to 10', mtb.finalTiebreakPoints, 10);
  ok('… and is labelled custom', !mtb.official && mtb.custom.indexOf('finalSet') >= 0);
  ok('the label says it', /match tie-break/.test(mtb.label), mtb.label);
  eq('clamped: tie-break points 3–21', [E.normalizeRules({ tiebreakPoints: 99 }).tiebreakPoints, E.normalizeRules({ tiebreakPoints: 1 }).tiebreakPoints], [21, 3]);
  Object.keys(E.PRESETS).forEach((k) => eq('preset ' + k + ' is recognised back', E.presetOf(E.PRESETS[k].rules), k));
  eq('anything else is custom', E.presetOf({ bestOf: 3, tiebreakPoints: 9 }), 'custom');
  eq('set rule of a match tie-break final set', E.setRule(mtb, 3).type, 'mtb');
  eq('set 2 of that match is a normal set', E.setRule(mtb, 2).type, 'set');
}

head('A STANDARD GAME (the server first)');
{
  const L = start('singles');
  const s0 = S(L);
  eq('Love-All, A serving, deuce court', [disp(L), s0.serving, s0.call, s0.court, s0.serve], ['0-0', 'A', 'Love-All', 'deuce', 1]);
  pt(L, 'A'); eq('15-0', [disp(L), S(L).call, S(L).court], ['15-0', '15-Love', 'ad']);
  pt(L, 'A'); pt(L, 'B'); eq('30-15', [disp(L), S(L).call], ['30-15', '30-15']);
  pt(L, 'A'); pt(L, 'B'); eq('40-30', [disp(L), S(L).call], ['40-30', '40-30']);
  pt(L, 'B'); eq('40-40 deuce', [disp(L), S(L).deuce, S(L).call], ['40-40', true, 'Deuce']);
  pt(L, 'A'); eq('advantage A', [disp(L), S(L).advantage, S(L).call], ['AD-40', 'A', 'Advantage Roger Alpha']);
  pt(L, 'B'); eq('back to deuce', [disp(L), S(L).deuce], ['40-40', true]);
  pt(L, 'B'); eq('advantage B', [disp(L), S(L).advantage], ['40-AD', 'B']);
  pt(L, 'A'); pt(L, 'A'); eq('advantage A again', S(L).advantage, 'A');
  const r = pt(L, 'A');
  eq('game A — 1-0, points back to 0-0', [gamesOf(L), disp(L)], ['1-0', '0-0']);
  ok('a GAME_WON effect, a hold (no break)', L.timeline[L.timeline.length - 1].effects.some((x) => x.type === 'GAME_WON' && x.side === 'A' && !x.break), r);
  eq('the serve passes to B', S(L).serving, 'B');
  pt(L, 'A');
  eq('B serving at 0-15: the call reads "Love-15" (server first)', S(L).call, 'Love-15');
  pt(L, 'A'); pt(L, 'A');
  ok('0-40: three break points for A', S(L).headline && S(L).headline.kind === 'break' && S(L).headline.side === 'A' && S(L).headline.count === 3, S(L).headline);
  pt(L, 'B'); eq('15-40: two', S(L).headline.count, 2);
  pt(L, 'B'); eq('30-40: one', S(L).headline.count, 1);
  pt(L, 'A');
  eq('A breaks: 2-0', gamesOf(L), '2-0');
  ok('the game is marked a break', L.timeline[L.timeline.length - 1].effects.some((x) => x.type === 'BREAK' && x.side === 'A'));
}

head('SETS');
{
  for (const [a, b] of [[6, 0], [6, 1], [6, 2], [6, 3], [6, 4]]) {
    const L = start('singles');
    // alternate wins so the set ends exactly a-b
    let ga = 0, gb = 0;
    while (ga + gb < a + b) { if (gb < b && (ga >= a - 1 || (ga + gb) % 2 === 1)) { game(L, 'B'); gb++; } else { game(L, 'A'); ga++; } }
    const s = S(L);
    eq(`${a}-${b}: set 1 to A, set 2 begins at 0-0`, [s.sets[0].A, s.sets[0].B, s.sets[0].winner, s.set, s.setsWon.A], [a, b, 'A', 2, 1]);
  }
  const L = start('singles');
  for (let i = 0; i < 5; i++) { game(L, 'A'); game(L, 'B'); }
  eq('5-5', gamesOf(L), '5-5');
  game(L, 'A'); eq('6-5 is not a set (two clear)', [gamesOf(L), S(L).set], ['6-5', 1]);
  game(L, 'A'); eq('7-5 wins it', [S(L).sets[0].A, S(L).sets[0].B, S(L).sets[0].winner], [7, 5, 'A']);

  const T = start('singles');
  for (let i = 0; i < 6; i++) { game(T, 'A'); game(T, 'B'); }
  ok('6-6: a tie-break', S(T).tiebreak && S(T).tiebreakTarget === 7, S(T));
  eq('… with numbers, not 15/30/40', [S(T).display.A, S(T).display.B], ['0', '0']);
  points(T, 'AAABBB');
  eq('3-3 in the tie-break', disp(T), '3-3');
  points(T, 'AAAA');
  eq('7-6 by tie-break (7-3); the set line keeps the tie-break score', [S(T).sets[0].A, S(T).sets[0].B, S(T).sets[0].tb], [7, 6, { A: 7, B: 3 }]);
  ok('the set is only scored when the tie-break ends', S(T).set === 2 && S(T).sets[0].winner === 'A');

  const ADV = start('singles', { tiebreakAt: null });
  for (let i = 0; i < 6; i++) { game(ADV, 'A'); game(ADV, 'B'); }
  ok('advantage set: 6-6 is not a tie-break', !S(ADV).tiebreak && gamesOf(ADV) === '6-6');
  game(ADV, 'A'); eq('7-6 goes on', [gamesOf(ADV), S(ADV).set], ['7-6', 1]);
  game(ADV, 'B'); game(ADV, 'A'); game(ADV, 'A');
  eq('9-7 wins an advantage set', [S(ADV).sets[0].A, S(ADV).sets[0].B, S(ADV).sets[0].winner], [9, 7, 'A']);
}

head('TIE-BREAKS');
{
  const tb = (rules) => { const L = start('singles', rules); for (let i = 0; i < 6; i++) { game(L, 'A'); game(L, 'B'); } return L; };
  let L = tb(); points(L, 'AAAAAAA'); eq('7-0', [L.state.sets[0].tb, L.state.sets[0].winner], [{ A: 7, B: 0 }, 'A']);
  L = tb(); points(L, 'AAAAABBBBBAA'); eq('7-5', [L.state.sets[0].tb, L.state.sets[0].winner], [{ A: 7, B: 5 }, 'A']);
  L = tb(); points(L, 'AAAAAABBBBBB'); points(L, 'A'); ok('7-6 in a tie-break is not won', S(L).tiebreak && disp(L) === '7-6');
  points(L, 'A'); eq('8-6 wins it', [L.state.sets[0].tb, L.state.sets[0].winner], [{ A: 8, B: 6 }, 'A']);
  L = tb(); points(L, 'ABABABABABABABABAB'); eq('9-9', disp(L), '9-9'); points(L, 'BAB'); points(L, 'B');
  eq('beyond the target: 12-10', [L.state.sets[0].tb, L.state.sets[0].winner], [{ A: 10, B: 12 }, 'B']);

  // the tie-break's serve: A serves point 1, B points 2-3, A 4-5, B 6-7 …
  L = tb();
  const servers = [];
  for (let i = 0; i < 9; i++) { servers.push(S(L).serving); pt(L, i % 2 ? 'A' : 'B'); }
  eq('tie-break serve order (A served game 1 → A serves the tie-break first)', servers.join(''), 'ABBAABBAA');
  // the next set opens with the player who RECEIVED first in the tie-break
  L = tb(); points(L, 'AAAAAAA');
  eq('set 2 game 1: B serves (A served first in the tie-break)', S(L).serving, 'B');

  // ends change every six points of a tie-break
  L = tb();
  const left0 = L.state.left;
  points(L, 'ABABA'); eq('after 5 points: same ends', L.state.left, left0);
  points(L, 'B'); ok('after 6: they change', L.state.left !== left0 && S(L).changeover);
  points(L, 'ABABAB'); eq('after 12: back', L.state.left, left0);

  // the 10-point match tie-break in place of the third set
  const M = start('singles', { finalSet: 'matchTiebreak' });
  games(M, 'A', 6); games(M, 'B', 6);
  ok('one set all → a match tie-break, first to 10', S(M).matchTiebreak && S(M).tiebreakTarget === 10 && S(M).set === 3, S(M));
  eq('its points are numbers', S(M).display, { A: '0', B: '0' });
  points(M, 'ABABABABABABABABA'); eq('9-8', disp(M), '9-8');
  points(M, 'B'); eq('9-9 goes on', [disp(M), M.state.status], ['9-9', 'in_play']);
  points(M, 'AA');
  eq('11-9: match over, the third set is [11-9]', [M.state.status, M.state.winner, M.state.result.scores[2].tb, M.state.result.scores[2].mtb], ['completed', 'A', { A: 11, B: 9 }, true]);
  eq('score line', E.scoreLine(M.state.result), '6-0 0-6 [11-9]');
}

head('BEST OF 3 / BEST OF 5');
{
  const L = start('singles');
  games(L, 'A', 6); games(L, 'B', 6); games(L, 'A', 5);
  ok('match point A at 5-0 in the third, 40-0 → triple match point', (() => { points(L, 'AAA'); const h = S(L).headline; return h && h.kind === 'match' && h.side === 'A' && h.count === 3; })(), S(L).headline);
  pt(L, 'A');
  eq('best of 3: two sets wins it', [L.state.status, L.state.winner, L.state.setsWon], ['completed', 'A', { A: 2, B: 1 }]);
  eq('no fourth (empty) set in the result', L.state.result.scores.length, 3);
  eq('no game in progress after the match', L.state.game, null);
  const r = send(L, { type: 'POINT', winner: 'B' });
  ok('a point after the match is refused', !r.ok && r.code === 'MATCH_OVER', r);
  eq('score line from the winner', E.scoreLine(L.state.result), '6-0 0-6 6-0');
  eq('… and from the loser', E.scoreLine(L.state.result, 'B'), '0-6 6-0 0-6');

  const F = start('singles', { bestOf: 5 });
  games(F, 'A', 12);
  ok('best of 5: two sets is not enough', F.state.status === 'in_play' && F.state.setsWon.A === 2);
  games(F, 'A', 6);
  eq('three sets wins it', [F.state.status, F.state.setsWon], ['completed', { A: 3, B: 0 }]);
  const one = start('singles', { bestOf: 1 });
  games(one, 'B', 6);
  eq('one set', [one.state.status, one.state.winner], ['completed', 'B']);
}

head('NO-AD — the deciding point');
{
  const L = start('singles', { noAd: true });
  points(L, 'AAABBB');
  const s = S(L);
  ok('40-40 is the deciding point (game point for both, a break point for the receiver)', s.pressure.deciding && s.call === 'Deciding point' && s.headline.kind === 'break' && s.headline.deciding, s);
  must(L, { type: 'POINT', winner: 'B', receiver: P.b1 });
  eq('the next point wins the game (no advantage)', [gamesOf(L), disp(L)], ['0-1', '0-0']);
  const d = start('doubles', { noAd: true });
  points(d, 'AAABBB');
  must(d, { type: 'POINT', winner: 'A', receiver: P.b2 });
  const e = d.timeline[d.timeline.length - 1];
  eq('doubles: the receivers chose who receives the deciding point (kept with the point)', e.receiver, P.b2);
  // game 2: B1 serves, so B2 (the server's partner) cannot be the receiver
  const bad = send(d, { type: 'POINT', winner: 'A', receiver: P.b2 });
  ok('the receiver must be on the receiving side', !bad.ok && bad.code === 'INVALID_PLAYER', bad);
}

head('SERVE: faults, double faults, aces, lets');
{
  const L = start('singles');
  must(L, { type: 'FAULT' });
  eq('a first-serve fault gives no point — second serve', [disp(L), S(L).serve], ['0-0', 2]);
  const again = send(L, { type: 'FAULT' });
  ok('a second FAULT is refused — it is a double fault', !again.ok && again.code === 'SECOND_SERVE', again);
  must(L, { type: 'POINT', winner: 'B', kind: 'DOUBLE_FAULT' });
  eq('a double fault: the receiver wins the point, first serve again', [disp(L), S(L).serve], ['0-15', 1]);
  const dfEntry = L.timeline[L.timeline.length - 1];
  eq('… credited to the server, on the 2nd serve', [dfEntry.player, dfEntry.serve, dfEntry.kind], [P.a1, 2, 'DOUBLE_FAULT']);
  const wrongAce = send(L, { type: 'POINT', winner: 'B', kind: 'ACE' });
  ok('an ace can only be the server\'s point', !wrongAce.ok && wrongAce.code === 'KIND_MISMATCH', wrongAce);
  const wrongDf = send(L, { type: 'POINT', winner: 'A', kind: 'DOUBLE_FAULT' });
  ok('a double fault can only be the receiver\'s point', !wrongDf.ok && wrongDf.code === 'KIND_MISMATCH');
  must(L, { type: 'POINT', winner: 'A', kind: 'ACE' });
  eq('ace: 15-15', disp(L), '15-15');
  ok('ACE effect credited to the server', L.timeline[L.timeline.length - 1].effects.some((x) => x.type === 'ACE' && x.player === P.a1));
  const seqBefore = L.state.pointNo;
  must(L, { type: 'LET' });
  must(L, { type: 'LET' });
  eq('lets: nothing changes but the let count', [disp(L), L.state.pointNo, S(L).lets, S(L).serve], ['15-15', seqBefore, 2, 1]);
  must(L, { type: 'FAULT' }); must(L, { type: 'LET' });
  eq('a let on the second serve: still the second serve', S(L).serve, 2);
  must(L, { type: 'POINT', winner: 'A', serve: 2, kind: 'WINNER', stroke: 'FH' });
  eq('a second-serve point', [L.timeline[L.timeline.length - 1].serve, L.timeline[L.timeline.length - 1].stroke], [2, 'FH']);
  const first = send(L, { type: 'POINT', winner: 'A', serve: 2 });
  ok('a point may say it was on the 2nd serve (the fault was not recorded)', first.ok);
  const noLet = start('singles', { lets: false });
  const lr = send(noLet, { type: 'LET' });
  ok('the no-let rule: a let is refused', !lr.ok && lr.code === 'NO_LET', lr);
  const wrongSide = send(L, { type: 'POINT', winner: 'A', kind: 'UNFORCED_ERROR', player: P.a1 });
  ok('an unforced error belongs to the side that LOST the point', !wrongSide.ok && wrongSide.code === 'INVALID_PLAYER', wrongSide);
  const okUe = send(L, { type: 'POINT', winner: 'A', kind: 'UNFORCED_ERROR', player: P.b1 });
  ok('… named on the losing side, accepted', okUe.ok);
}

head('DOUBLES — order of service and of receiving');
{
  const L = start('doubles');
  const order = [];
  for (let g = 0; g < 6; g++) { order.push(S(L).server.playerId); game(L, g % 2 ? 'B' : 'A'); }
  eq('servers by game: A1 B1 A2 B2 A1 B1', order, [P.a1, P.b1, P.a2, P.b2, P.a1, P.b1]);
  // receiving: deuce court / ad court alternate, the same player always takes the deuce court in the set
  const L2 = start('doubles');
  const rcv = [];
  for (let i = 0; i < 4; i++) { rcv.push(S(L2).receiver.playerId + ':' + S(L2).court); pt(L2, 'A'); }
  eq('game 1 receivers: B1 deuce, B2 ad, B1 deuce, B2 ad', rcv, [P.b1 + ':deuce', P.b2 + ':ad', P.b1 + ':deuce', P.b2 + ':ad']);
  eq('game 2 (B1 serving): A1 receives in the deuce court', [S(L2).server.playerId, S(L2).receiver.playerId, S(L2).court], [P.b1, P.a1, 'deuce']);
  // the tie-break in doubles: A1 1, B1 2-3, A2 4-5, B2 6-7, A1 8-9
  const T = start('doubles');
  for (let i = 0; i < 6; i++) { game(T, 'A'); game(T, 'B'); }
  ok('6-6 tie-break', S(T).tiebreak);
  const first = S(T).server.playerId;
  const seq = [];
  for (let i = 0; i < 9; i++) { seq.push(S(T).server.playerId); pt(T, i % 2 ? 'A' : 'B'); }
  // 12 games played: A1 B1 A2 B2 ×3 → game 13 (the tie-break) is A1's turn
  eq('the tie-break opens with the player whose turn it is (A1)', first, P.a1);
  eq('tie-break rotation in doubles', seq, [P.a1, P.b1, P.b1, P.a2, P.a2, P.b2, P.b2, P.a1, P.a1]);
  // after the tie-break (4-5 → A wins three in a row: 7-5): set 2, the team that
  // received first (B) serves — and may choose its order
  points(T, 'AAA');
  ok('set 1 to A by tie-break, set 2 in its break', T.state.sets[0].winner === 'A' && S(T).betweenSets, S(T));
  eq('team due to serve set 2: B', S(T).teamDue, 'B');
  const wrong = send(T, { type: 'SET_ORDER', order: [P.a2, P.b2, P.a1, P.b1] });
  ok('the wrong team cannot open the set', !wrong.ok && wrong.code === 'ORDER_INVALID', wrong);
  must(T, { type: 'SET_ORDER', order: [P.b2, P.a2, P.b1, P.a1], receive: { A: { deuce: P.a2, ad: P.a1 }, B: { deuce: P.b1, ad: P.b2 } } });
  eq('the new order serves: B2, and A2 now takes the deuce court', [S(T).server.playerId, S(T).receiver.playerId], [P.b2, P.a2]);
  pt(T, 'B');
  const late = send(T, { type: 'SET_ORDER', order: [P.b1, P.a1, P.b2, P.a2] });
  ok('once the set has begun the order cannot change (only a correction)', !late.ok && late.code === 'NOT_SET_BREAK', late);
  const singles = send(start('singles'), { type: 'SET_ORDER', order: [P.a1, P.b1] });
  ok('singles has no set order', !singles.ok && singles.code === 'DOUBLES_ONLY');
  // doubles with a match tie-break: the rotation carries on, the order may change before it
  const M = start('doubles', { finalSet: 'matchTiebreak', noAd: true });
  games(M, 'A', 6); games(M, 'B', 6);
  ok('doubles match tie-break', S(M).matchTiebreak && S(M).betweenSets);
  const due = S(M).teamDue;
  const orderDue = due === 'A' ? [P.a2, P.b1, P.a1, P.b2] : [P.b2, P.a1, P.b1, P.a2];
  must(M, { type: 'SET_ORDER', order: orderDue });
  eq('the chosen player serves the first point of the match tie-break', S(M).server.playerId, orderDue[0]);
  const bad = send(start('doubles'), { type: 'POINT', winner: 'A', kind: 'WINNER', player: P.b1 });
  ok('a winner is credited to a player of the winning side', !bad.ok && bad.code === 'INVALID_PLAYER');
  const badStart = new E.Ledger(setup('doubles'), []);
  const bs = send(badStart, { type: 'START', server: P.a1, order: [P.a1, P.a2, P.b1, P.b2] });
  ok('a doubles order must alternate the sides', !bs.ok && bs.code === 'ORDER_INVALID', bs);
  const half = new E.Ledger({ format: 'doubles', sides: { A: { players: [{ playerId: P.a1, name: 'A' }] }, B: { players: [{ playerId: P.b1, name: 'B' }, { playerId: P.b2, name: 'C' }] } } }, []);
  const hs = send(half, { type: 'START', server: P.a1 });
  ok('doubles needs two players a side to start', !hs.ok && hs.code === 'PLAYERS_MISSING', hs);
}

head('CHANGE OF ENDS');
{
  const L = start('singles');
  const l0 = L.state.left;
  game(L, 'A'); ok('after game 1: change', L.state.left !== l0 && S(L).changeover);
  game(L, 'A'); ok('after game 2: no change', L.state.left !== l0 && !S(L).changeover);
  game(L, 'A'); ok('after game 3: change back', L.state.left === l0);
  games(L, 'A', 2);
  const l5 = L.state.left;
  ok('after game 5: changed again', l5 !== l0);
  game(L, 'A');
  // set 1: 6-0 — an even set: no change at the set break, then after game 1 of set 2
  ok('6-0 (even): no change at the set break', L.state.left === l5 && !S(L).changeover && S(L).set === 2);
  game(L, 'B'); ok('… they change after game 1 of set 2', L.state.left !== l5 && S(L).changeover);
  const O = start('singles');
  games(O, 'A', 5); game(O, 'B'); game(O, 'A');   // 6-1: odd
  ok('a set that ends odd (6-1): change at the set break', S(O).set === 2 && S(O).changeover);
}

head('PRESSURE — game, break, set and match point');
{
  const L = start('singles');
  points(L, 'AAA');
  let h = S(L).headline;
  ok('40-0 on serve: three game points', h.kind === 'game' && h.side === 'A' && h.count === 3, h);
  games(L, 'A', 1);
  for (let i = 0; i < 4; i++) { game(L, 'A'); game(L, 'B'); }
  // 5-4 A, A serving? game 10 → turn 9 → B serves (A served games 1,3,5,7,9)
  eq('5-4, B to serve', [gamesOf(L), S(L).serving], ['5-4', 'B']);
  points(L, 'AAA');
  h = S(L).headline;
  ok('0-40 on B\'s serve at 4-5: triple SET point for A (also a break)', h.kind === 'set' && h.side === 'A' && h.count === 3 && h.alsoBreak, h);
  const pr = S(L).pressure;
  ok('… pressure says set point and break point for A, nothing for B', pr.A.set && pr.A.break && !pr.B, pr);
  const T = start('singles');
  for (let i = 0; i < 6; i++) { game(T, 'A'); game(T, 'B'); }
  points(T, 'AAAAAABBB');
  h = S(T).headline;
  ok('tie-break 6-3: three set points', h.kind === 'set' && h.count === 3 && !h.alsoBreak, h);
  const F4 = start('singles', { gamesPerSet: 4, tiebreakAt: 3, tiebreakPoints: 5, tiebreakMargin: 1, noAd: true });
  for (let i = 0; i < 3; i++) { game(F4, 'A'); game(F4, 'B'); }
  ok('FAST4: tie-break at 3-all, to 5', S(F4).tiebreak && S(F4).tiebreakTarget === 5);
  points(F4, 'ABABABAB');
  ok('4-4: sudden death — set point for both', S(F4).pressure.A && S(F4).pressure.B && S(F4).pressure.deciding, S(F4).pressure);
  pt(F4, 'B');
  eq('5-4 wins the set 4-3', [F4.state.sets[0].games.A, F4.state.sets[0].games.B, F4.state.sets[0].winner, F4.state.sets[0].tb], [3, 4, 'B', { A: 4, B: 5 }]);
}

head('UNDO — every transition');
{
  const snap = (L) => JSON.stringify(canon(L.state));
  const undoBack = (name, build) => {
    const L = build();
    const before = snap(L);
    const ev = build.last(L);
    ok(name + ': recorded', !!ev);
    const u = send(L, { type: 'UNDO' });
    ok(name + ': undone', u.ok, u);
    eq(name + ': the state is exactly what it was', snap(L), before);
    const mr = matchesReplay(L);
    ok(name + ': incremental = full replay', mr.ok, mr);
  };
  const mk = (prep, last) => { const f = () => { const L = start('singles'); prep(L); return L; }; f.last = last; return f; };
  undoBack('a normal point', mk((L) => points(L, 'AB'), (L) => pt(L, 'A')));
  undoBack('deuce', mk((L) => points(L, 'AAABB'), (L) => pt(L, 'B')));
  undoBack('advantage', mk((L) => points(L, 'AAABBB'), (L) => pt(L, 'A')));
  undoBack('a game', mk((L) => points(L, 'AAA'), (L) => pt(L, 'A')));
  undoBack('a set', mk((L) => { games(L, 'A', 5); points(L, 'AAA'); }, (L) => pt(L, 'A')));
  undoBack('a tie-break (and the set)', mk((L) => { for (let i = 0; i < 6; i++) { game(L, 'A'); game(L, 'B'); } points(L, 'AAAAAA'); }, (L) => pt(L, 'A')));
  undoBack('the match', mk((L) => { games(L, 'A', 11); points(L, 'AAA'); }, (L) => pt(L, 'A')));
  undoBack('a double fault', mk((L) => { must(L, { type: 'FAULT' }); }, (L) => must(L, { type: 'POINT', winner: 'B', kind: 'DOUBLE_FAULT' })));
  undoBack('a first-serve fault', mk((L) => points(L, 'A'), (L) => must(L, { type: 'FAULT' })));
  undoBack('a let', mk((L) => points(L, 'A'), (L) => must(L, { type: 'LET' })));
  undoBack('a rotation (the game that passes the serve)', mk((L) => { games(L, 'A', 2); points(L, 'BBB'); }, (L) => pt(L, 'B')));

  // the game that ended undone: the server is the one who served it
  const R = start('singles');
  points(R, 'AAA'); pt(R, 'A');
  eq('after game 1, B serves', S(R).serving, 'B');
  must(R, { type: 'UNDO' });
  eq('undo: A serves again at 40-0', [S(R).serving, disp(R)], ['A', '40-0']);
  pt(R, 'B');
  eq('undo then a new point: 40-15', disp(R), '40-15');
  ok('incremental = replay after undo + new point', matchesReplay(R).ok, matchesReplay(R));

  // two undos take back two events — never the same one twice
  const D = start('singles');
  points(D, 'ABA');
  const u1 = send(D, { type: 'UNDO' }), u2 = send(D, { type: 'UNDO' });
  eq('two undos: back to 15-0 (two different events)', [disp(D), u1.event.target !== u2.event.target], ['15-0', true]);
  const dup = D.check(Object.assign({}, u2.event, { seq: undefined }));
  ok('the same undo sent again is a duplicate, not a third undo', !dup.ok && dup.duplicate);
  must(D, { type: 'REDO' });
  eq('redo: 15-15', disp(D), '15-15');
  must(D, { type: 'REDO' });
  eq('redo again: 30-15', disp(D), '30-15');
  const r3 = send(D, { type: 'REDO' });
  ok('nothing left to redo', !r3.ok && r3.code === 'NOTHING_TO_REDO');
  must(D, { type: 'UNDO' }); pt(D, 'B');
  const r4 = send(D, { type: 'REDO' });
  ok('redo is gone once a new point is recorded', !r4.ok && r4.code === 'NOTHING_TO_REDO');
  ok('incremental = replay after undo/redo', matchesReplay(D).ok, matchesReplay(D));
  const Z = start('singles');
  must(Z, { type: 'UNDO' });
  eq('undo the start: pregame', Z.state.status, 'pregame');
  const z2 = send(Z, { type: 'UNDO' });
  ok('nothing to undo', !z2.ok && z2.code === 'NOTHING_TO_UNDO');
  const U = start('singles');
  pt(U, 'A');
  const target = U.timeline[U.timeline.length - 1].eventId;
  pt(U, 'A');
  const old = send(U, { type: 'UNDO', target });
  ok('undo of an older event is refused (correct it instead)', !old.ok && old.code === 'UNDO_NOT_LAST', old);
  // an undo across a service rotation in doubles
  const DU = start('doubles');
  game(DU, 'A'); game(DU, 'B'); points(DU, 'AAA');
  const sv = S(DU).server.playerId;
  pt(DU, 'A');
  must(DU, { type: 'UNDO' });
  eq('doubles: undo the game, the same server (A2) again', [S(DU).server.playerId, sv], [P.a2, P.a2]);
  ok('doubles incremental = replay', matchesReplay(DU).ok);
}

head('CORRECTIONS');
{
  const L = start('singles');
  pt(L, 'A');
  const first = L.timeline[L.timeline.length - 1].eventId;
  points(L, 'AB');
  // how the point was won: the score does not move
  must(L, { type: 'CORRECT', target: first, patch: { kind: 'WINNER', stroke: 'BH' }, reason: 'classified' });
  eq('a classification changes the point, not the score', [disp(L), L.entry(first).kind, L.entry(first).stroke], ['30-15', 'WINNER', 'BH']);
  ok('… and Undo does not take a classification back (it takes back the last point)', E.lastUndoable(L.events).type === 'POINT');
  ok('incremental = replay (detail correction)', matchesReplay(L).ok, matchesReplay(L));
  const badKind = send(L, { type: 'CORRECT', target: first, patch: { kind: 'DOUBLE_FAULT' }, reason: 'x' });
  ok('a classification that contradicts the point is refused (A served and won it)', !badKind.ok && badKind.code === 'KIND_MISMATCH', badKind);
  // who won it: the score is recomputed from there
  must(L, { type: 'CORRECT', target: first, patch: { winner: 'B' }, reason: 'umpire overruled' });
  eq('the first point now B\'s: 15-30', disp(L), '15-30');
  ok('incremental = replay (winner correction)', matchesReplay(L).ok, matchesReplay(L));
  const r = send(L, { type: 'CORRECT', target: first, patch: { winner: 'A' } });
  ok('a correction needs a reason', !r.ok && r.code === 'REASON_REQUIRED');
  // a correction that would end the game earlier than points already recorded
  const C = start('singles');
  points(C, 'AAAB');                // 40-15
  const p4 = C.timeline[C.timeline.length - 1].eventId;
  pt(C, 'A');                       // game A
  games(C, 'A', 5);                 // set A 6-0, now set 2
  const games0 = C.state.setsWon.A;
  const conflict = send(C, { type: 'CORRECT', target: p4, patch: { winner: 'A' }, reason: 'x' });
  // 40-15 point to A instead of B → game ends one point earlier; the next point starts game 2 — still valid; ok either way
  ok('a winner correction is either applied consistently or refused as a conflict', conflict.ok ? matchesReplay(C).ok : conflict.code === 'CORRECTION_CONFLICT', conflict);
  void games0;
  const M = start('singles', { bestOf: 1 });
  games(M, 'A', 5); points(M, 'AAAB');
  const pm = M.timeline[M.timeline.length - 1].eventId;
  pt(M, 'A');                       // match over 6-0
  const cm = send(M, { type: 'CORRECT', target: pm, patch: { winner: 'A' }, reason: 'x' });
  // the 40-15 point to A would have ended the match one point earlier: the last point would be after the match
  ok('a correction that would put a point after the match is refused', !cm.ok && cm.code === 'CORRECTION_CONFLICT', cm);
  const V = start('singles');
  points(V, 'AAB');
  const v2 = V.timeline[V.timeline.length - 2].eventId;
  must(V, { type: 'VOID', target: v2, reason: 'recorded twice' });
  eq('void an earlier point: 15-15', disp(V), '15-15');
  ok('incremental = replay (void)', matchesReplay(V).ok);
  const SC = start('singles');
  points(SC, 'AA');
  must(SC, { type: 'SERVE_CORRECTION', server: P.b1, reason: 'wrong player served' });
  eq('server corrected mid-game: B serves now, the points stand', [S(SC).serving, disp(SC)], ['B', '30-0']);
  pt(SC, 'A'); pt(SC, 'A');
  eq('… and the rotation continues from the corrected server', [gamesOf(SC), S(SC).serving], ['1-0', 'A']);
  const nr = send(SC, { type: 'SERVE_CORRECTION', server: P.a1 });
  ok('a server correction needs a reason', !nr.ok && nr.code === 'REASON_REQUIRED');
}

head('STATUS — pause, suspend, resume, retire, walkover, default, abandon');
{
  const L = start('singles');
  points(L, 'AA');
  must(L, { type: 'PAUSE', kind: 'MEDICAL', side: 'B' });
  eq('paused', [L.state.status, S(L).interruption.kind], ['paused', 'MEDICAL']);
  const r = send(L, { type: 'POINT', winner: 'A' });
  ok('no point while paused', !r.ok && r.code === 'PAUSED', r);
  must(L, { type: 'RESUME' });
  pt(L, 'A');
  eq('resumed: 40-0', disp(L), '40-0');
  must(L, { type: 'SUSPEND', kind: 'RAIN', reason: 'rain' });
  eq('suspended', L.state.status, 'suspended');
  must(L, { type: 'RESUME' });
  games(L, 'A', 1); points(L, 'B');
  must(L, { type: 'RETIRE', side: 'B', reason: 'injury' });
  eq('retired: A wins, reason kept', [L.state.status, L.state.winner, L.state.result.reason, L.state.result.by], ['completed', 'A', 'retired', 'B']);
  // 1-0 and B 15-0 up on serve in game 2 when B stopped
  eq('the score line ends "ret."', E.scoreLine(L.state.result), '1-0 ret.');
  eq('the unfinished game is part of the record', L.state.result.openGame, { A: 0, B: 1, tiebreak: false });
  must(L, { type: 'UNDO', reason: 'wrong button' });
  eq('undo a retirement: back in play', L.state.status, 'in_play');
  const W = new E.Ledger(setup('singles'), []);
  must(W, { type: 'WALKOVER', side: 'A' });
  eq('walkover before play: B advances', [W.state.status, W.state.winner, W.state.result.reason, E.scoreLine(W.state.result)], ['completed', 'B', 'walkover', 'w/o']);
  const W2 = start('singles');
  const w2 = send(W2, { type: 'WALKOVER', side: 'A' });
  ok('a walkover once play has begun is refused (it is a retirement)', !w2.ok && w2.code === 'ALREADY_STARTED');
  const R0 = new E.Ledger(setup('singles'), []);
  const r0 = send(R0, { type: 'RETIRE', side: 'A' });
  ok('a retirement before the first point is refused (a walkover)', !r0.ok && r0.code === 'NOT_STARTED');
  const DF = start('singles');
  const nd = send(DF, { type: 'DEFAULT', side: 'B' });
  ok('a default needs its reason', !nd.ok && nd.code === 'REASON_REQUIRED');
  must(DF, { type: 'DEFAULT', side: 'B', reason: 'code violation' });
  eq('default', [DF.state.result.reason, DF.state.winner], ['default', 'A']);
  const AB = start('singles');
  points(AB, 'AB');
  must(AB, { type: 'ABANDON', reason: 'flood lights failed' });
  eq('abandoned: no winner', [AB.state.status, AB.state.winner, AB.state.result.reason], ['abandoned', null, 'abandoned']);
  const ab2 = send(AB, { type: 'POINT', winner: 'A' });
  ok('nothing after an abandonment', !ab2.ok && ab2.code === 'MATCH_OVER');
}

head('SHORT SETS, PRO SET, TOSS');
{
  const SS = start('singles', { gamesPerSet: 4, tiebreakAt: 4, finalSet: 'matchTiebreak' });
  for (let i = 0; i < 4; i++) { game(SS, 'A'); game(SS, 'B'); }
  ok('short sets: tie-break at 4-4', S(SS).tiebreak && gamesOf(SS) === '4-4');
  const SS2 = start('singles', { gamesPerSet: 4, tiebreakAt: 4 });
  games(SS2, 'A', 4);
  eq('4-0 wins a short set', SS2.state.sets[0].winner, 'A');
  const PRO = start('singles', { bestOf: 1, gamesPerSet: 8, tiebreakAt: 8 });
  games(PRO, 'A', 7);
  ok('pro set: 7-0 is not over', PRO.state.status === 'in_play');
  game(PRO, 'A');
  eq('8-0 is', PRO.state.status, 'completed');
  const T = new E.Ledger(setup('singles'), []);
  const t1 = send(T, { type: 'TOSS', winner: 'A', choice: 'serve', firstServe: 'B' });
  ok('a toss winner who chose to serve serves', !t1.ok && t1.code === 'TOSS_INVALID');
  must(T, { type: 'TOSS', winner: 'A', choice: 'receive', firstServe: 'B', left: 'B' });
  eq('toss recorded; B starts at the left end', [T.state.toss.choice, T.state.left], ['receive', 'B']);
  must(T, { type: 'START', server: P.b1 });
  eq('the start keeps the toss\'s ends', [S(T).left, S(T).serving], ['B', 'B']);
  const t3 = send(T, { type: 'TOSS', winner: 'B', choice: 'serve', firstServe: 'B' });
  ok('no toss once the match has started', !t3.ok && t3.code === 'ALREADY_STARTED');
}

head('IDEMPOTENCY');
{
  const L = start('singles');
  const ev = { eventId: 'same-press', type: 'POINT', winner: 'A' };
  const c1 = L.check(ev); L.commit(c1.pending);
  const c2 = L.check(ev);
  ok('the same eventId twice is a duplicate — never scored twice', !c2.ok && c2.duplicate, c2);
  eq('15-0, not 30-0', disp(L), '15-0');
}

head('COMMENTARY');
{
  const L = start('singles');
  must(L, { type: 'POINT', winner: 'A', kind: 'ACE' });
  ok('ace commentary', /Ace by Roger Alpha/.test(E.commentary(L.setup, L.timeline[L.timeline.length - 1]).text));
  points(L, 'AA'); pt(L, 'A');
  ok('game commentary', /Game Roger Alpha/.test(E.commentary(L.setup, L.timeline[L.timeline.length - 1]).text));
  points(L, 'AAAA');
  const c = E.commentary(L.setup, L.timeline[L.timeline.length - 1]);
  ok('break commentary', /Break of serve/.test(c.text) && c.tone === 'break', c);
  must(L, { type: 'FAULT' });
  ok('fault commentary', /second serve/.test(E.commentary(L.setup, L.timeline[L.timeline.length - 1]).text));
}

head('THE PROPERTY — incremental ledger = full replay, after every random event');
{
  let seed = 20261112;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const formats = [
    ['singles', {}], ['singles', { bestOf: 5 }], ['singles', { noAd: true, finalSet: 'matchTiebreak' }],
    ['doubles', { noAd: true, finalSet: 'matchTiebreak' }], ['doubles', {}], ['singles', { tiebreakAt: null }],
    ['singles', { gamesPerSet: 4, tiebreakAt: 3, tiebreakPoints: 5, tiebreakMargin: 1, noAd: true, lets: false }],
    ['singles', { bestOf: 5, finalSet: 'tiebreak', finalTiebreakAt: 6, finalTiebreakPoints: 10 }]
  ];
  let checked = 0, bad = null, kinds = {};
  for (let round = 0; round < 24 && !bad; round++) {
    const [fmt, rules] = formats[round % formats.length];
    const L = start(fmt, rules);
    for (let i = 0; i < 260 && !bad; i++) {
      const x = rnd();
      let ev;
      const sum = S(L);
      const srvSide = sum.serving || 'A';
      if (L.state.status === 'completed') ev = rnd() < 0.7 ? { type: 'UNDO', reason: 'property' } : { type: 'NOTE', text: 'after' };
      else if (x < 0.55) {
        const w = rnd() < 0.5 ? 'A' : 'B';
        const kind = w === srvSide ? pick(['POINT', 'ACE', 'WINNER', 'FORCED_ERROR', 'UNFORCED_ERROR', 'SERVICE_WINNER']) : pick(['POINT', 'DOUBLE_FAULT', 'RETURN_WINNER', 'UNFORCED_ERROR', 'WINNER']);
        ev = { type: 'POINT', winner: w, kind };
        if (L.state.serve === 2 || kind === 'DOUBLE_FAULT') ev.serve = 2;
      } else if (x < 0.63) ev = { type: 'FAULT' };
      else if (x < 0.66) ev = { type: 'LET' };
      else if (x < 0.8) ev = { type: 'UNDO', reason: 'property' };
      else if (x < 0.86) ev = { type: 'REDO', reason: 'property' };
      else if (x < 0.88) ev = { type: 'NOTE', text: 'n' + i };
      else if (x < 0.9 && L.state.status === 'in_play') ev = { type: rnd() < 0.5 ? 'PAUSE' : 'SUSPEND', kind: 'RAIN' };
      else if (x < 0.92 && (L.state.status === 'paused' || L.state.status === 'suspended')) ev = { type: 'RESUME' };
      else {
        // a correction of some earlier point: detail (most) or who won it
        const pts = L.timeline.filter((e) => e.type === 'POINT' && !e.voided && !e.invalid);
        if (!pts.length) continue;
        const t = pick(pts);
        ev = rnd() < 0.75 ? { type: 'CORRECT', target: t.eventId, reason: 'p', patch: { kind: t.side === t.serverSide ? pick(['WINNER', 'UNFORCED_ERROR']) : pick(['RETURN_WINNER', 'FORCED_ERROR']), stroke: pick(['FH', 'BH', 'VOLLEY']) } }
          : { type: 'CORRECT', target: t.eventId, reason: 'p', patch: { winner: t.side === 'A' ? 'B' : 'A', kind: 'POINT' } };
      }
      const r = send(L, ev);
      if (r.ok) {
        kinds[ev.type] = (kinds[ev.type] || 0) + 1;
        const m = matchesReplay(L);
        checked++;
        if (!m.ok) bad = { round, i, ev, m: m.why, a: m.a, b: m.b };
      }
    }
  }
  ok(`incremental state = full replay after each of ${checked} accepted random events`, !bad, bad);
  ok('the random run exercised points, faults, lets, undo, redo, corrections, pauses', ['POINT', 'FAULT', 'LET', 'UNDO', 'REDO', 'CORRECT', 'RESUME'].every((k) => kinds[k] > 0), kinds);
}

head('PERFORMANCE — undo is O(1), never a copy of the match');
{
  // a long match (best of 5, every set to a tie-break)
  // every game to deuce three times, every set to a tie-break: a five-hour match
  const L = start('singles', { bestOf: 5 });
  const long = (side) => { points(L, 'ABABAB'); points(L, side + side); };
  for (let s = 0; s < 4; s++) { for (let i = 0; i < 6; i++) { long('A'); long('B'); } points(L, s % 2 ? 'BBBBBBB' : 'AAAAAAA'); }
  for (let i = 0; i < 6; i++) { long('A'); long('B'); }
  const nEvents = L.events.length;
  ok('a long match: ' + nEvents + ' events', nEvents > 450);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) { must(L, { type: 'UNDO' }); must(L, { type: 'REDO' }); }
  const undoMs = Number(process.hrtime.bigint() - t0) / 1e6 / 400;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) L.verify();
  const replayMs = Number(process.hrtime.bigint() - t1) / 1e6 / 20;
  console.log(`        undo/redo: ${undoMs.toFixed(3)} ms each · a full replay of the match: ${replayMs.toFixed(2)} ms`);
  ok('undo/redo are far cheaper than replaying the match (no copy of the match)', undoMs < replayMs / 4, { undoMs, replayMs });
  ok('incremental = replay after 400 undo/redo on a long match', matchesReplay(L).ok);
  const t2 = process.hrtime.bigint();
  const B = start('singles', { bestOf: 5, tiebreakAt: null });
  let n = 0;
  while (B.state.status === 'in_play' && n < 6000) { pt(B, n % 7 < 4 ? 'A' : 'B'); n++; }
  const perPoint = Number(process.hrtime.bigint() - t2) / 1e6 / n;
  console.log(`        a point: ${perPoint.toFixed(3)} ms (${n} points, the state never copied)`);
  ok('a point is checked and applied in well under a millisecond', perPoint < 1, perPoint);
}

head('FOOT FAULTS — a fault like any other; on the second serve, a double fault');
{
  const Stats = require('../../tennis-stats.js');
  const L = start('singles', {});
  must(L, { type: 'FAULT', foot: true });
  let tl = L.timeline[L.timeline.length - 1];
  ok('a foot fault on the first serve: a fault — the second serve now', tl.type === 'FAULT' && tl.foot === true && L.state.serve === 2 && S(L).display.A === '0');
  eq('…the commentary calls it a foot fault', E.commentary(L.setup, tl).text, 'Foot fault — second serve, Roger Alpha');
  const df = pt(L, 'B', { kind: 'DOUBLE_FAULT', foot: true, serve: 2 });
  tl = L.entry(df.event.eventId);
  ok('a foot fault on the second serve: a double fault — the point to the receiver, marked a foot fault', tl.kind === 'DOUBLE_FAULT' && tl.foot === true && tl.side === 'B' && S(L).display.B === '15' && L.state.serve === 1);
  ok('…the commentary says so', /^Double fault \(foot fault\) — Roger Alpha/.test(E.commentary(L.setup, tl).text), E.commentary(L.setup, tl).text);
  const notDf = send(L, { type: 'POINT', winner: 'A', kind: 'WINNER', foot: true });
  ok('a "foot" on a point that is not a double fault means nothing (the point stands, no foot fault)', notDf.ok && !L.entry(notDf.event.eventId).foot);
  must(L, { type: 'FAULT' });
  let st = Stats.compute({ setup: L.setup, state: L.state, timeline: L.timeline });
  ok('statistics: 2 foot faults (the fault and the double fault), 1 double fault — the server’s, not the receiver’s', st.sides.A.serve.footFaults === 2 && st.sides.A.serve.doubleFaults === 1 && st.players[P.a1].serve.footFaults === 2 && st.sides.B.serve.footFaults === 0, st.sides.A.serve);
  // the operator meant a plain double fault
  must(L, { type: 'CORRECT', target: df.event.eventId, patch: { foot: null }, reason: 'not a foot fault' });
  st = Stats.compute({ setup: L.setup, state: L.state, timeline: L.timeline });
  ok('corrected: no longer a foot fault — still the double fault', !L.entry(df.event.eventId).foot && L.entry(df.event.eventId).kind === 'DOUBLE_FAULT' && st.sides.A.serve.footFaults === 1);
  const last = L.lastUndoable();
  must(L, { type: 'UNDO', target: last.eventId });
  ok('undo the last fault: back to the first serve', L.state.serve === 1);
  ok('incremental = replay with foot faults, corrections and undo', matchesReplay(L).ok);
  const plain = start('singles', {});
  ok('no foot fault recorded: the count is 0 (an untracked match shows no foot-fault row)', Stats.compute({ setup: plain.setup, state: plain.state, timeline: plain.timeline }).sides.A.serve.footFaults === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
