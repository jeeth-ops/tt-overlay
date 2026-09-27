/* The MATCH DATA SAFETY NET, tested against the real functions in
   server.js (extracted by name, never copied) — the guard that stops a
   write erasing an innings, and the two converters the Recovery Centre
   rebuilds a lost match with.

   node test/cricket/recovery-test.js
*/
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'server.js'), 'utf8');

function grab(name){
  const start = src.indexOf('function ' + name);
  if(start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for(let j = i; j < src.length; j++){
    if(src[j] === '{') depth++;
    else if(src[j] === '}'){ depth--; if(depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
const names = ['oversStrToBallsCount','ballsToOversStr','matchRecordFootprint','footprintTotalBalls',
               'groupsLostBy','guardMatchRecordWrite','matchRecordFromPanelState','ballDocsFromPanelState',
               'playerKey','personName'];
const api = new Function([
  'const SHRINK_TOLERANCE_BALLS = 30;',
  ...names.map(grab),
  `return { ${names.join(', ')} };`
].join('\n'))();

let pass = 0, fail = 0;
function eq(name, a, b){
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if(A === B){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${A} expected ${B}`); }
}
function ok(name, v){ eq(name, !!v, true); }

const batter = (name, runs, balls, inn) => ({ name, runs, balls, fours: 0, sixes: 0, inningsNo: inn });
const bowler = (name, overs, balls, runs, wkts, inn) => ({ name, overs, balls, runs, wickets: wkts, inningsNo: inn });

// A finished two-innings match: A 237/10 in 36.4, then B 180/8 in 40.
const complete = {
  matchId: 'M1',
  scoreA: { runs: 237, wickets: 10, overs: '36.4' },
  scoreB: { runs: 180, wickets: 8, overs: '40.0' },
  battingCard: {
    A: [batter('Ravi', 120, 140, 1), batter('Sunil', 80, 60, 1)],
    B: [batter('Imran', 95, 130, 2), batter('Karim', 60, 80, 2)]
  },
  bowlingCard: {
    A: [bowler('Ravi', 12, 0, 40, 3, 2)],
    B: [bowler('Nikhil', 10, 4, 55, 4, 1)]
  },
  extras: { A: { wd: 5, nb: 1, b: 2, lb: 3, pen: 0 }, B: { wd: 4, nb: 0, b: 0, lb: 1, pen: 0 } },
  fallOfWickets: { A: [{ wkt: 1, runs: 20, over: '3.2', inningsNo: 1 }], B: [{ wkt: 1, runs: 12, over: '2.1', inningsNo: 2 }] },
  partnerships: { 1: [{ runs: 20 }], 2: [{ runs: 12 }] },
  inningsArchive: [{ no: 1, team: 'A', runs: 237, wickets: 10, overs: '36.4' }, { no: 2, team: 'B', runs: 180, wickets: 8, overs: '40.0' }],
  winningTeam: 'A'
};

console.log('\n=== FOOTPRINT ===');
eq('counts deliveries per team and innings', api.matchRecordFootprint(complete)['bat::B::2'].balls, 210);
eq('total is batting balls only', api.footprintTotalBalls(complete), 140 + 60 + 130 + 80);

console.log('\n=== THE GUARD: an innings may not be deleted by a write ===');
// Exactly the Kanga League failure: the ball log only ever received the
// first 5.1 overs of the second innings, so the rebuild has 31 balls
// where the saved record has 210.
const partialRebuild = {
  ...complete,
  scoreB: { runs: 29, wickets: 1, overs: '5.1' },
  battingCard: { A: complete.battingCard.A, B: [batter('Imran', 20, 20, 2), batter('Karim', 9, 11, 2)] },
  bowlingCard: { A: [bowler('Ravi', 2, 3, 15, 1, 2)], B: complete.bowlingCard.B },
  extras: { A: complete.extras.A, B: { wd: 0, nb: 0, b: 0, lb: 0, pen: 0 } },
  fallOfWickets: { A: complete.fallOfWickets.A, B: [] },
  partnerships: { 1: complete.partnerships[1], 2: [] }
};
const lost = api.groupsLostBy(complete, partialRebuild);
ok('the shrunken second innings is spotted', lost.some(l => l.key === 'bat::B::2'));
const guarded = api.guardMatchRecordWrite(complete, partialRebuild).record;
eq('the full second-innings batting card is kept', guarded.battingCard.B.map(r => r.runs), [95, 60]);
eq("the team's score is kept with it", guarded.scoreB, complete.scoreB);
eq('extras are kept with it', guarded.extras.B, complete.extras.B);
eq('fall of wickets is kept with it', guarded.fallOfWickets.B, complete.fallOfWickets.B);
eq('that innings\' partnerships are kept', guarded.partnerships[2], complete.partnerships[2]);
eq('the bowling spell against it is kept', guarded.bowlingCard.A.map(r => r.overs), [12]);
eq('nothing was lost overall', api.footprintTotalBalls(guarded), api.footprintTotalBalls(complete));
eq('the first innings still came from the incoming write', guarded.battingCard.A.map(r => r.runs), [120, 80]);

console.log('\n=== THE GUARD: ordinary edits still go straight through ===');
const undoOneBall = JSON.parse(JSON.stringify(complete));
undoOneBall.battingCard.B[0].balls -= 1;
undoOneBall.battingCard.B[0].runs -= 4;
undoOneBall.scoreB = { runs: 176, wickets: 8, overs: '39.5' };
eq('a one-ball undo is not treated as data loss', api.groupsLostBy(complete, undoOneBall).length, 0);
eq('and is written exactly as sent', api.guardMatchRecordWrite(complete, undoOneBall).record.scoreB.runs, 176);

const fourOverUndo = JSON.parse(JSON.stringify(complete));
fourOverUndo.battingCard.B[0].balls -= 24;
eq('so is a four-over rollback (inside the tolerance)', api.groupsLostBy(complete, fourOverUndo).length, 0);

console.log('\n=== THE GUARD: a match with nothing saved yet ===');
eq('a first save is never blocked', api.guardMatchRecordWrite(null, partialRebuild).record.scoreB.runs, 29);
eq('an empty stored innings is not "lost"', api.groupsLostBy({ battingCard: { A: [], B: [] } }, partialRebuild).length, 0);

console.log('\n=== PANEL STATE → MATCH RECORD ===');
const panelState = {
  format: 'Test', venue: 'D Y PATIL', tournamentMatchId: 'TM-1',
  teamA: { name: 'DY PATIL SA', short: 'DYP' }, teamB: { name: 'NEW HIND SC', short: 'NHSC' },
  battingTeam: 'B', inningsNumber: 2,
  score: { runs: 29, wickets: 1, overs: 5, balls: 1 },
  striker: { name: 'Imran', runs: 14, balls: 18, fours: 2, sixes: 0 },
  nonStriker: { name: 'Karim', runs: 9, balls: 11, fours: 1, sixes: 0 },
  bowler: { name: 'Ravi', overs: 2, balls: 3, runs: 15, wickets: 1 },
  battingCard: { A: [batter('Sunil', 80, 60, 1)], B: [batter('Out Man', 4, 2, 2)] },
  bowlingCard: { A: [], B: [bowler('Nikhil', 10, 4, 55, 4, 1)] },
  extras: { A: { wd: 5, nb: 1, b: 2, lb: 3, pen: 0 }, B: { wd: 1, nb: 0, b: 0, lb: 0, pen: 0 } },
  fallOfWickets: { A: [], B: [] },
  inningsArchive: [{ no: 1, team: 'A', runs: 237, wickets: 10, overs: '36.4' }],
  ballLog: [
    { innings: 2, battingTeam: 'B', over: '0.1', ballType: '4', striker: 'Imran', nonStriker: 'Karim', bowler: 'Ravi', runs: 4, isWicket: false, scoreAfter: '4-0', timestamp: 1000 },
    { innings: 2, battingTeam: 'B', over: '0.2', ballType: 'WdW', striker: 'Imran', nonStriker: 'Karim', bowler: 'Ravi', runs: 1, isWicket: true, dismissalType: 'Run Out', fielderName: 'Sunil', scoreAfter: '5-1', timestamp: 2000 }
  ],
  milestonesHit: {}, matchWinnerKey: null
};
const rec = api.matchRecordFromPanelState(panelState, { matchId: 'TM-1', roomId: 'room7' });
eq('the archived first innings becomes team A\'s score', rec.scoreA, { runs: 237, wickets: 10, overs: '36.4' });
eq('the innings in progress becomes team B\'s score', rec.scoreB, { runs: 29, wickets: 1, overs: '5.1' });
eq('the batters at the crease are folded into the card', rec.battingCard.B.map(r => r.name), ['Out Man', 'Imran', 'Karim']);
eq('the bowler mid-spell is folded in too', rec.bowlingCard.A.map(r => r.name), ['Ravi']);
eq('partnerships come out of the ball log', rec.partnerships[2].length, 1);
eq('a wide is not a ball faced by the partnership', rec.partnerships[2][0].balls, 1);
eq('the innings archive is carried over', rec.inningsArchive.length, 1);
eq('no winner is invented for a match still in progress', rec.winningTeam, null);

console.log('\n=== PANEL BALL LOG → PERMANENT DELIVERY LOG ===');
const docs = api.ballDocsFromPanelState(panelState, 'room7', 'uid1');
eq('one document per delivery', docs.length, 2);
eq('"0.2" splits into over and ball', [docs[1].over, docs[1].ballInOver], [0, 2]);
eq('a wicket off a wide is stored as a wide + a dismissal', [docs[1].kind, docs[1].dismissal.type], ['Wd', 'Run Out']);
eq('the fielder is kept', docs[1].dismissal.fielder, 'Sunil');
eq('player keys match the ones the server indexes on', docs[0].strikerKey, api.playerKey('Imran'));
eq('the match id is stamped on every delivery', docs.every(d => d.matchId === 'room7'), true);

console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
process.exit(fail ? 1 : 0);
