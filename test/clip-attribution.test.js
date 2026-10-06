// Delivery-time clip attribution — unit tests for clip-attribution.js and
// the clip organiser's owner rule, plus a drift check that the copies
// inlined into the two cricket panels are byte-identical to the module.
//
//   node test/clip-attribution.test.js          run
//   node test/clip-attribution.test.js --sync   re-inline the module into the panels
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const MODULE_FILE = path.join(ROOT, 'clip-attribution.js');
const PANELS = ['cricket-panel.html', 'cricket-panel3.html'];
const BEGIN = '/* CLIP-ATTRIBUTION:BEGIN';
const END = '/* CLIP-ATTRIBUTION:END */';

function inlineBlock(html, src){
  const b = html.indexOf(BEGIN), e = html.indexOf(END);
  if(b < 0 || e < 0) throw new Error('CLIP-ATTRIBUTION markers missing');
  const headerEnd = html.indexOf('*/', b) + 2;
  return { before: html.slice(0, headerEnd), inner: html.slice(headerEnd, e), after: html.slice(e) };
}
const moduleSrc = fs.readFileSync(MODULE_FILE, 'utf8');

if(process.argv.includes('--sync')){
  for(const p of PANELS){
    const file = path.join(ROOT, p);
    const parts = inlineBlock(fs.readFileSync(file, 'utf8'), moduleSrc);
    fs.writeFileSync(file, parts.before + '\n' + moduleSrc + parts.after);
    console.log('synced', p);
  }
  process.exit(0);
}

let pass = 0, fail = 0;
function t(name, fn){
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch(e){ fail++; console.log('  FAIL  ' + name + ' :: ' + e.message); }
}
module.exports = { t, done: () => ({ pass, fail }) };

const CA = require(MODULE_FILE);
const organizer = require(path.join(ROOT, 'clipper-helper', 'clipOrganizer.js'));

console.log('\n=== inlined copies match clip-attribution.js ===');
for(const p of PANELS){
  t(`${p} carries the current module`, () => {
    const parts = inlineBlock(fs.readFileSync(path.join(ROOT, p), 'utf8'));
    assert.strictEqual(parts.inner, '\n' + moduleSrc, 'drifted — run node test/clip-attribution.test.js --sync');
  });
}

const A = { id: 'pA', name: 'Player A' }, B = { id: 'pB', name: 'Player B' };
const BOWLER = { id: 'b1', name: 'Bowler One' }, NEXT_BOWLER = { id: 'b2', name: 'Bowler Two' };
const X = { id: 'fX', name: 'Fielder X' };
// 12.6: the score holds 12.5 completed when the delivery is bowled.
function lastBall(over){
  const pos = CA.nextDeliveryPosition({ overs: over == null ? 12 : over, balls: 5 }, 6, true);
  return CA.buildDeliverySnapshot({ deliveryId: 'd-126', innings: 1, battingTeam: 'A', over: pos.over, ballInOver: pos.ballInOver,
    striker: A, nonStriker: B, bowler: BOWLER, timestamp: 1 });
}

console.log('\n=== delivery position (legal-ball count, not display ball) ===');
t('6th legal ball of over 12 is 12.6 and completes the over', () => {
  const p = CA.nextDeliveryPosition({ overs: 12, balls: 5 }, 6, true);
  assert.deepStrictEqual([p.over, p.ballInOver, p.completesOver], [12, 6, true]);
});
t('a Wide/No Ball after 12.5 stays 12.5 and never completes the over', () => {
  const p = CA.nextDeliveryPosition({ overs: 12, balls: 5 }, 6, false);
  assert.deepStrictEqual([p.over, p.ballInOver, p.completesOver], [12, 5, false]);
});
t('5-ball overs: the 5th legal ball completes the over (no hard-coded 6)', () => {
  const p = CA.nextDeliveryPosition({ overs: 3, balls: 4 }, 5, true);
  assert.deepStrictEqual([p.over, p.ballInOver, p.completesOver], [3, 5, true]);
  const a = CA.appliedDeliveryPosition({ overs: 4, balls: 0 }, 5, true);
  assert.deepStrictEqual([a.over, a.ballInOver], [3, 5]);
});
t('applied position un-rolls an over-completing ball (13.0 → 12.6)', () => {
  const a = CA.appliedDeliveryPosition({ overs: 13, balls: 0 }, 6, true);
  assert.deepStrictEqual([a.over, a.ballInOver], [12, 6]);
});

console.log('\n=== snapshot is immutable and copied by value ===');
t('snapshot is frozen', () => {
  const s = lastBall();
  assert.ok(Object.isFrozen(s));
  assert.throws(() => { 'use strict'; s.strikerId = 'pB'; });
});
t('mutating the live batter objects after the snapshot changes nothing', () => {
  const live = { striker: { ...A }, nonStriker: { ...B }, bowler: { ...BOWLER } };
  const s = CA.buildDeliverySnapshot({ innings: 1, over: 12, ballInOver: 6, ...live });
  const tmp = live.striker; live.striker = live.nonStriker; live.nonStriker = tmp; // end-of-over swap
  live.bowler.name = NEXT_BOWLER.name; live.bowler.id = NEXT_BOWLER.id;      // next bowler
  assert.strictEqual(s.strikerId, 'pA'); assert.strictEqual(s.bowlerId, 'b1');
});

console.log('\n=== Tests A-I: last-ball clip ownership ===');
const wicket = (snap, d) => CA.resolveClipParticipants(snap, { clipType: 'WICKET', dismissal: d });
t('A: 12.6 run out — striker A out', () => {
  const c = wicket(lastBall(), { type: 'Run Out', dismissedPlayerId: 'pA', dismissedPlayerName: 'Player A', fielderId: 'fX', fielder: 'Fielder X' });
  assert.strictEqual(c.dismissedPlayerId, 'pA'); assert.strictEqual(c.batsmanId, 'pA');
  assert.strictEqual(c.over, 12); assert.strictEqual(c.ballInOver, 6); assert.strictEqual(c.innings, 1);
  assert.strictEqual(c.bowlerCredited, false);
});
t('B: 12.6 run out — non-striker B out', () => {
  const c = wicket(lastBall(), { type: 'Run Out', dismissedPlayerId: 'pB', dismissedPlayerName: 'Player B' });
  assert.strictEqual(c.dismissedPlayerId, 'pB'); assert.strictEqual(c.batsmanId, 'pB');
  assert.strictEqual(c.strikerId, 'pA', 'striker of the delivery is still recorded as A');
});
t('C: 12.6 one run completed, B run out → B', () => {
  const c = wicket(lastBall(), { type: 'Run Out', runOutWho: 'nonStriker', dismissedPlayerId: 'pB', runsCompleted: 1 });
  assert.strictEqual(c.dismissedPlayerId, 'pB');
});
t('D: 12.6 two runs completed, B run out → B', () => {
  const c = wicket(lastBall(), { type: 'Run Out', dismissedPlayerName: 'Player B', runsCompleted: 2 });
  assert.strictEqual(c.dismissedPlayerId, 'pB');
});
t('run out named by id wins over a stale position key', () => {
  const c = wicket(lastBall(), { type: 'Run Out', runOutWho: 'striker', dismissedPlayerId: 'pB' });
  assert.strictEqual(c.dismissedPlayerId, 'pB');
});
t('legacy run out with only a position resolves against the SNAPSHOT crease', () => {
  assert.strictEqual(wicket(lastBall(), { type: 'Run Out', runOutWho: 'nonStriker' }).dismissedPlayerId, 'pB');
  assert.strictEqual(wicket(lastBall(), { type: 'Run Out', runOutWho: 'striker' }).dismissedPlayerId, 'pA');
});
t('E: 12.6 bowled A — original bowler', () => {
  const c = wicket(lastBall(), { type: 'Bowled' });
  assert.deepStrictEqual([c.batsmanId, c.dismissedPlayerId, c.bowlerId, c.bowlerCredited], ['pA', 'pA', 'b1', true]);
});
t('F: 12.6 caught A by X', () => {
  const c = wicket(lastBall(), { type: 'Caught', fielderId: 'fX', fielder: 'Fielder X' });
  assert.deepStrictEqual([c.dismissedPlayerId, c.fielderId, c.fielderName, c.bowlerId], ['pA', 'fX', 'Fielder X', 'b1']);
});
for(const type of ['LBW', 'Stumped', 'Hit Wicket']){
  t(`${type} on 12.6 → striker A, bowler credited`, () => {
    const c = wicket(lastBall(), { type });
    assert.deepStrictEqual([c.dismissedPlayerId, c.bowlerId, c.bowlerCredited], ['pA', 'b1', true]);
  });
}
t('G: 12.6 SIX by A', () => {
  const c = CA.resolveClipParticipants(lastBall(), { kind: '6' });
  assert.deepStrictEqual([c.clipType, c.batsmanId, c.bowlerId, c.dismissedPlayerId], ['SIX', 'pA', 'b1', null]);
});
t('H: 12.6 FOUR by A', () => {
  const c = CA.resolveClipParticipants(lastBall(), { kind: '4' });
  assert.deepStrictEqual([c.clipType, c.batsmanId], ['FOUR', 'pA']);
});
t('I: wicket, new batsman, new over, new bowler, delayed processing → old players', () => {
  const live = { striker: { ...A }, nonStriker: { ...B }, bowler: { ...BOWLER } };
  const snap = CA.buildDeliverySnapshot({ deliveryId: 'd1', innings: 1, over: 12, ballInOver: 6, ...live });
  const meta = CA.clipBallMeta(wicket(snap, { type: 'Run Out', dismissedPlayerId: 'pA' }));
  // ...then the match moves on.
  live.striker = { id: 'pC', name: 'Player C' }; live.nonStriker = { ...B }; live.bowler = { ...NEXT_BOWLER };
  const json = JSON.parse(JSON.stringify(meta)); // through an offline queue / upload
  assert.deepStrictEqual([json.deliveryId, json.over, json.ballInOver, json.dismissedPlayerId, json.batsmanId, json.bowlerId],
    ['d1', 12, 6, 'pA', 'pA', 'b1']);
  assert.deepStrictEqual(CA.clipOwner({ eventType: 'WICKET', ...json }), { name: 'Player A', id: 'pA', role: 'dismissed' });
});
t('Retired Hurt is never a wicket clip', () => {
  const c = CA.resolveClipParticipants(lastBall(), { clipType: 'WICKET', dismissal: { type: 'Retired Hurt' } });
  assert.strictEqual(c.dismissedPlayerId, null);
});

console.log('\n=== extras on the last ball ===');
t('No-ball + FOUR / Wide + boundary / Bye 4 / Leg-bye 4 stay on the delivery striker', () => {
  const pos = CA.nextDeliveryPosition({ overs: 12, balls: 5 }, 6, false);
  const s = CA.buildDeliverySnapshot({ innings: 1, over: pos.over, ballInOver: pos.ballInOver, striker: A, nonStriker: B, bowler: BOWLER });
  for(const clipType of ['FOUR', 'SIX', 'CLIP']){
    const c = CA.resolveClipParticipants(s, { clipType });
    assert.deepStrictEqual([c.batsmanId, c.bowlerId, c.over, c.ballInOver], ['pA', 'b1', 12, 5]);
  }
});

console.log('\n=== crease guard (multi-device / delayed sync) ===');
t('same crease passes; a rotated or replaced crease fails', () => {
  const s = lastBall();
  assert.ok(CA.creaseMatches(s, { striker: A, nonStriker: B }));
  assert.ok(!CA.creaseMatches(s, { striker: B, nonStriker: A }));
  assert.ok(!CA.creaseMatches(s, { striker: { id: 'pC', name: 'C' }, nonStriker: B }));
});

console.log('\n=== canonical-ball matching (server) ===');
t('deliveryId decides when present', () => {
  assert.ok(CA.sameDelivery({ ballUid: 'd1', over: 1, ballInOver: 1 }, { deliveryId: 'd1', over: 9, ballInOver: 9 }));
  assert.ok(!CA.sameDelivery({ ballUid: 'd2', over: 12, ballInOver: 6 }, { deliveryId: 'd1', over: 12, ballInOver: 6 }));
});
t('a Wide sharing 12.5 with a wicket ball is not the wicket ball', () => {
  const wicketMeta = { innings: 1, over: 12, ballInOver: 5, striker: 'Player A', strikerId: 'pA' };
  const wideByNewBatter = { innings: 1, over: 12, ballInOver: 5, striker: 'Player C', kind: 'Wd' };
  assert.ok(!CA.sameDelivery(wideByNewBatter, wicketMeta, 'WICKET'));
  assert.ok(CA.sameDelivery({ innings: 1, over: 12, ballInOver: 5, striker: 'Player A', dismissal: { type: 'Bowled' } }, wicketMeta, 'WICKET'));
});
t('different innings never match', () => {
  assert.ok(!CA.sameDelivery({ innings: 2, over: 3, ballInOver: 4, striker: 'A' }, { innings: 1, over: 3, ballInOver: 4, striker: 'A' }));
});

console.log('\n=== clip owner for stored docs ===');
t('legacy wicket doc with no dismissed player → striker', () => {
  assert.deepStrictEqual(CA.clipOwner({ eventType: 'WICKET', strikerName: 'Player A' }).name, 'Player A');
});
t('wicket doc with dismissal.batter → that batter', () => {
  assert.strictEqual(CA.clipOwner({ eventType: 'WICKET', striker: 'Player A', dismissal: { type: 'Run Out', batter: 'Player B' } }).name, 'Player B');
});
t('SIX doc → striker even if a dismissal field is present', () => {
  assert.strictEqual(CA.clipOwner({ eventType: 'SIX', striker: 'Player A', dismissedPlayer: 'Player B' }).name, 'Player A');
});

console.log('\n=== local folders + file name (clip organiser) ===');
t('run out of the non-striker files under the non-striker, named after them', () => {
  const meta = { eventType: 'WICKET', outcomeLabel: 'WICKET — Run Out', over: 12, ballInOver: 6, innings: 1,
    strikerName: 'Player A', strikerId: 'pA', dismissedPlayerName: 'Player B', dismissedPlayerId: 'pB',
    dismissal: { type: 'Run Out', batter: 'Player B' }, bowlerName: 'Bowler One' };
  assert.strictEqual(organizer.clipBatsman(meta).name, 'Player B');
  assert.strictEqual(organizer.buildClipFileName(meta), '12.6_WICKET-RUNOUT_Player-B_vs_Bowler-One.mp4');
});
t('a SIX files under the striker', () => {
  const meta = { eventType: 'SIX', over: 12, ballInOver: 6, strikerName: 'Player A', bowlerName: 'Bowler One' };
  assert.strictEqual(organizer.clipBatsman(meta).name, 'Player A');
  assert.strictEqual(organizer.buildClipFileName(meta), '12.6_SIX_Player-A_vs_Bowler-One.mp4');
});
t('a bowled wicket names the dismissal', () => {
  const meta = { eventType: 'WICKET', outcomeLabel: 'WICKET — Bowled', over: 0, ballInOver: 6, strikerName: 'Player A', bowlerName: 'Bowler One', dismissal: { type: 'Bowled' } };
  assert.strictEqual(organizer.buildClipFileName(meta), '00.6_WICKET-BOWLED_Player-A_vs_Bowler-One.mp4');
});

console.log('\n=== clip event for a stored delivery ===');
t('4/6/W/extras map to the same buckets the panel uses', () => {
  const ev = (b) => CA.clipEventForBall(b).eventType + '|' + CA.clipEventForBall(b).outcomeLabel;
  assert.strictEqual(ev({ kind: '4', runs: 4 }), 'FOUR|FOUR');
  assert.strictEqual(ev({ kind: '6', runs: 6 }), 'SIX|SIX');
  assert.strictEqual(ev({ kind: 'W', runs: 0, dismissal: { type: 'Run Out' } }), 'WICKET|WICKET — Run Out');
  assert.strictEqual(ev({ kind: 'Wd', runs: 5 }), 'FOUR|Wide 4');
  assert.strictEqual(ev({ kind: 'Nb', runs: 7 }), 'SIX|No Ball 6');
  assert.strictEqual(ev({ kind: 'LB', runs: 4 }), 'CLIP|Leg Bye 4');
  // BOUNDARY vs RUNNING is the scorer's stored answer, never the run count.
  assert.strictEqual(ev({ kind: 'Nb', runs: 5, boundary: true }), 'FOUR|No Ball 4');
  assert.strictEqual(ev({ kind: 'Nb', runs: 5, boundary: false }), 'CLIP|No Ball +4');
  assert.strictEqual(ev({ kind: 'Nb', runs: 7, boundary: false }), 'CLIP|No Ball +6');
  assert.strictEqual(ev({ kind: 'Wd', runs: 5, boundary: false }), 'CLIP|Wide +4');
  assert.strictEqual(ev({ kind: 'Wd', runs: 5, boundary: true }), 'FOUR|Wide 4');
  assert.strictEqual(ev({ kind: 'Nb', runs: 5, nbRunsAs: 'legbye', boundary: true }), 'FOUR|No Ball + 4 leg byes (boundary)');
  assert.strictEqual(ev({ kind: 'Nb', runs: 3, nbRunsAs: 'bye' }), 'CLIP|No Ball + 2 bye' + 's');
  assert.strictEqual(ev({ kind: 'Wd', runs: 26 }), 'CLIP|Wide +25');
  assert.strictEqual(ev({ kind: 'W', runs: 0, dismissal: { type: 'Retired Hurt' } }), 'CLIP|0 runs');
});

console.log('\n=== applying a website correction to panel state ===');
const liveState = () => ({ inningsNumber: 1, battingTeam: 'A', score: { runs: 100, wickets: 2 },
  striker: { name: 'B', runs: 10, balls: 8, fours: 0, sixes: 0 }, nonStriker: { name: 'A', runs: 30, balls: 20, fours: 3, sixes: 0 },
  bowler: { name: 'Two', overs: 0, balls: 1, runs: 1, wickets: 0 }, battingCard: { A: [], B: [] },
  bowlingCard: { A: [], B: [{ name: 'One', overs: 3, balls: 0, runs: 20, wickets: 1, inningsNo: 1 }] }, extras: { A: { wd: 0, nb: 0, b: 0, lb: 0 }, B: {} }, ballLog: [] });
const sixEv = { id: 'c1', innings: 1, battingTeam: 'A', overLabel: '12.6', after: { kind: '6', runs: 6 },
  delta: { team: { runs: 2, wickets: 0, extras: {} }, batting: [{ name: 'A', runs: 2, balls: 0, fours: -1, sixes: 1 }], bowling: [{ name: 'One', balls: 0, runs: 2, wickets: 0 }] } };
t('FOUR → SIX lands on the right tiles/rows, once', () => {
  const st = liveState();
  assert.ok(CA.applyDeliveryCorrection(st, sixEv).applied);
  assert.deepStrictEqual([st.score.runs, st.nonStriker.runs, st.nonStriker.fours, st.nonStriker.sixes, st.striker.runs, st.bowlingCard.B[0].runs, st.bowler.runs], [102, 32, 2, 1, 10, 22, 1]);
  assert.ok(CA.applyDeliveryCorrection(st, sixEv).duplicate);
  assert.strictEqual(st.score.runs, 102);
});
t('a legal-ball change is not patched into running totals', () => {
  const st = liveState();
  const r = CA.applyDeliveryCorrection(st, Object.assign({}, sixEv, { id: 'c2', legalChanged: true }));
  assert.ok(!r.applied && r.warnings.length === 1 && st.score.runs === 100);
});

console.log(`\n${pass} passed, ${fail} failed`);
if(fail) process.exit(1);
