const { w, errors } = require('./harness.js');
const E = (code) => w.eval(code);

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
function eq(name, actual, expected){
  ok(name, actual === expected, `got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
}
function head(t){ console.log('\n=== ' + t + ' ==='); }

// Deterministic start: fresh state, named players, no roster gating.
function newMatch(format, overs, battingTeam){
  E(`
    state = mergeWithDefaults(null);
    state.format = ${JSON.stringify(format)};
    if(${JSON.stringify(format)} === 'Custom') state.customOvers = ${overs || 20};
    state.oversPerInnings = ${overs || 20};
    state.battingTeam = ${JSON.stringify(battingTeam || 'A')};
    state.striker    = { name:'Striker', id:'p1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'NonStriker', id:'p2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler     = { name:'Bowler', id:'p9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = [];
  `);
}
const S = () => JSON.parse(E('JSON.stringify(state)'));
const R = () => JSON.parse(E('JSON.stringify(reconcileInnings())'));

/* ---------------------------------------------------------------- */
head('RULES LAYER — format awareness (no hard-coded T20)');
newMatch('T20');       eq('T20 balls per innings', E('ballsPerInnings()'), 120);
eq('T20 max wickets', E('maxWickets()'), 10);
eq('T20 super over enabled', E('superOverEnabledForMatch()'), true);
newMatch('ODI');       eq('ODI balls per innings', E('ballsPerInnings()'), 300);
newMatch('Test');      eq('Test has no overs limit', E('ballsPerInnings()'), null);
eq('Test has no Super Over', E('superOverEnabledForMatch()'), false);
eq('Test has no Free Hit', E('matchRules().freeHitOnNoBall'), false);
eq('Test follow-on deficit', E('matchRules().followOnDeficit'), 200);
newMatch('Custom', 8); eq('Custom 8 overs = 48 balls', E('ballsPerInnings()'), 48);
E('state.customMaxWickets = 5');
eq('Custom 5-wicket innings', E('maxWickets()'), 5);
E('state.customSuperOverEnabled = false');
eq('Custom can disable Super Over', E('superOverEnabledForMatch()'), false);

/* ---------------------------------------------------------------- */
head('BALL & OVER NUMBERING');
newMatch('T20');
for(let i=0;i<6;i++) E('recordBall("1")');
let s = S();
eq('6 legal balls rolls the over', `${s.score.overs}.${s.score.balls}`, '1.0');
eq('deliveries logged', s.ballLog.length, 6);
eq('first delivery is 0.1', s.ballLog[0].over, '0.1');
eq('sixth delivery is 0.6 (never 1.0)', s.ballLog[5].over, '0.6');
E('recordBall("0")');
eq('seventh delivery is 1.1', S().ballLog[6].over, '1.1');
ok('no illegal 1.7 / 1.8 delivery numbers', !S().ballLog.some(b => /\.(7|8)$/.test(b.over)));

head('WIDES AND NO-BALLS DO NOT CONSUME A LEGAL BALL');
newMatch('T20');
E('recordBall("Wd",{extraRuns:0})');
E('recordBall("Nb",{runsOffBat:0})');
s = S();
eq('over still 0.0 after a wide and a no ball', `${s.score.overs}.${s.score.balls}`, '0.0');
eq('team total 2 (1 wide + 1 no ball)', s.score.runs, 2);
eq('striker faced no balls', s.striker.balls, 0);
eq('wide extras', s.extras.A.wd, 1);
eq('no-ball extras', s.extras.A.nb, 1);

head('FREE HIT survives an illegal delivery, ends on a legal one');
newMatch('T20');
E('recordBall("Nb",{runsOffBat:0})');
eq('no ball sets a free hit', E('state.freeHit'), true);
E('recordBall("Wd",{extraRuns:0})');
eq('free hit survives a wide (no legal ball bowled)', E('state.freeHit'), true);
E('recordBall("1")');
eq('free hit ends on the next legal delivery', E('state.freeHit'), false);

/* ---------------------------------------------------------------- */
head('BUG FIX — runs run off a WIDE are never the batsman\'s (Law 22)');
newMatch('T20');
E('recordBall("Wd",{extraRuns:2})');
s = S();
eq('team total = 1 penalty + 2 run', s.score.runs, 3);
eq('all three runs are wides', s.extras.A.wd, 3);
eq('striker credited nothing', s.striker.runs, 0);
// the same, but with a run out on the wide — this is the branch that was wrong
newMatch('T20');
E('recordBall("WdW",{dismissalType:"Run Out",extraRuns:2,fielderName:"Fielder",runOutWho:"striker"})');
s = S();
eq('WdW team total = 1 + 2', s.score.runs, 3);
eq('WdW all runs are wides', s.extras.A.wd, 3);
eq('WdW striker credited nothing (was +2 before the fix)', s.battingCard.A[0].runs, 0);
ok('WdW reconciles: batters + extras === total', R().ok, JSON.stringify(R().issues));

head('BUG FIX — a six off a No Ball with a run out is tallied');
newMatch('T20');
E('recordBall("NbW",{dismissalType:"Run Out",runsOffBat:6,fielderName:"F",runOutWho:"nonStriker"})');
s = S();
eq('NbW total = 1 penalty + 6 off the bat', s.score.runs, 7);
eq('NbW striker keeps the 6 runs', s.striker.runs, 6);
eq('NbW six is tallied (was silently dropped)', s.striker.sixes, 1);
eq('NbW extras is only the 1-run penalty', s.extras.A.nb, 1);

/* ---------------------------------------------------------------- */
head('OVERTHROW — MCC Law 19.8 calculation');
// A: 2 completed, overthrow to the boundary, had NOT crossed
newMatch('T20');
E('recordBall("OT",{runsCompleted:2,boundary:true,crossed:false,boundaryAllowance:4})');
s = S();
eq('A: 2 completed + 4 allowance = 6', s.score.runs, 6);
eq('A: all 6 to the striker (Law 18.10)', s.striker.runs, 6);
eq('A: not a batsman six', s.striker.sixes, 0);
eq('A: not a batsman four', s.striker.fours, 0);
eq('A: 2 runs run is even, striker keeps strike', s.striker.name, 'Striker');
eq('A: nothing went into wides/byes/leg-byes/penalty',
   s.extras.A.wd + s.extras.A.b + s.extras.A.lb + s.extras.A.pen, 0);
eq('A: a legal ball was bowled', `${s.score.overs}.${s.score.balls}`, '0.1');
eq('A: bowler charged all 6', s.bowler.runs, 6);
let ot = s.ballLog[0].overthrow;
eq('A: components stored — completed', ot.runsCompleted, 2);
eq('A: components stored — allowance', ot.boundaryAllowance, 4);
eq('A: components stored — runs actually run', ot.runsRun, 2);

// B: 1 completed, HAD crossed at the throw, overthrow to the boundary
newMatch('T20');
E('recordBall("OT",{runsCompleted:1,boundary:true,crossed:true,boundaryAllowance:4})');
s = S();
eq('B: 1 completed + 1 crossed + 4 = 6', s.score.runs, 6);
eq('B: 2 runs run is even, striker keeps strike', s.striker.name, 'Striker');
// B2: same but they had NOT crossed -> 1 run run, strike rotates
newMatch('T20');
E('recordBall("OT",{runsCompleted:1,boundary:true,crossed:false,boundaryAllowance:4})');
s = S();
eq('B2: 1 completed + 4 = 5', s.score.runs, 5);
eq('B2: 1 run run is odd, strike rotates', s.striker.name, 'NonStriker');
ok('B2: odd TOTAL with even run count would have been wrong before', s.striker.name === 'NonStriker');

// C: overthrow that did not reach the boundary — they just kept running
newMatch('T20');
E('recordBall("OT",{runsCompleted:1,boundary:false,extraCompleted:2})');
s = S();
eq('C: 1 + 2 further completed = 3', s.score.runs, 3);
eq('C: 3 runs run is odd, strike rotates', s.striker.name, 'NonStriker');

// D: overthrow on the last ball of an over
newMatch('T20');
for(let i=0;i<5;i++) E('recordBall("0")');
E('recordBall("OT",{runsCompleted:2,boundary:true,crossed:false})');
s = S();
eq('D: over completed', `${s.score.overs}.${s.score.balls}`, '1.0');
eq('D: the overthrow ball is logged as 0.6, not 1.0', s.ballLog[5].over, '0.6');
eq('D: 2 runs run (even) then the over-end swap -> NonStriker on strike', s.striker.name, 'NonStriker');
eq('D: the overthrow runs stayed with the striker who hit it', s.nonStriker.runs, 6);

head('OVERTHROW — legacy single-total meta still works');
newMatch('T20');
E('recordBall("OT",{runs:3})');
s = S();
eq('legacy: 3 runs', s.score.runs, 3);
eq('legacy: strike rotates on 3', s.striker.name, 'NonStriker');

/* ---------------------------------------------------------------- */
head('BYES / LEG BYES');
newMatch('T20');
E('recordBall("B",{runs:2})');
s = S();
eq('byes to extras', s.extras.A.b, 2);
eq('byes not to the batsman', s.striker.runs, 0);
eq('byes are a legal ball', `${s.score.overs}.${s.score.balls}`, '0.1');
eq('byes not charged to the bowler', s.bowler.runs, 0);
eq('striker is credited the ball faced', s.striker.balls, 1);
newMatch('T20');
E('recordBall("LB",{runs:1})');
s = S();
eq('leg byes to extras', s.extras.A.lb, 1);
eq('leg byes not charged to the bowler', s.bowler.runs, 0);
eq('1 leg bye rotates the strike', s.striker.name, 'NonStriker');

head('NO BALL + LEG BYE — only the penalty is the bowler\'s');
newMatch('T20');
E('recordBall("Nb",{legByeRuns:2})');
s = S();
eq('total = 1 + 2', s.score.runs, 3);
eq('leg byes recorded as leg byes', s.extras.A.lb, 2);
eq('no-ball penalty recorded once', s.extras.A.nb, 1);
eq('bowler charged only the 1-run penalty', s.bowler.runs, 1);
eq('striker credited nothing', s.striker.runs, 0);

/* ---------------------------------------------------------------- */
head('RUN OUT — completed runs kept, bowler never credited');
newMatch('T20');
E('recordBall("W",{dismissalType:"Run Out",runsCompleted:2,fielderName:"Fielder",runOutWho:"nonStriker"})');
s = S();
eq('completed runs in the team total', s.score.runs, 2);
eq('completed runs to whoever faced the ball', s.striker.runs, 2);
eq('one wicket, not two', s.score.wickets, 1);
eq('bowler NOT credited a run out', s.bowler.wickets, 0);
eq('fielder credited the run out', Object.values(s.fieldingStats.B)[0].runOuts, 1);
eq('the non-striker is the one out', s.battingCard.A[0].name, 'NonStriker');
ok('run out reconciles', R().ok, JSON.stringify(R().issues));

head('CAUGHT — bowler credited, fielder recorded');
newMatch('T20');
E('recordBall("W",{dismissalType:"Caught",fielderName:"Catcher"})');
s = S();
eq('bowler credited the wicket', s.bowler.wickets, 1);
eq('catch recorded against the fielder', Object.values(s.fieldingStats.B)[0].catches, 1);
ok('dismissal reads "c Catcher b Bowler"', s.battingCard.A[0].howOut === 'c Catcher b Bowler', s.battingCard.A[0].howOut);

head('EVERY WICKET TYPE');
['Bowled','Caught','LBW','Stumped','Hit Wicket','Run Out'].forEach(t => {
  newMatch('T20');
  E(`recordBall("W",{dismissalType:${JSON.stringify(t)},fielderName:"F"})`);
  const st = S();
  const bowlerCredited = !['Run Out'].includes(t);
  eq(`${t}: one wicket`, st.score.wickets, 1);
  eq(`${t}: bowler credit correct`, st.bowler.wickets, bowlerCredited ? 1 : 0);
  eq(`${t}: a legal ball was bowled`, `${st.score.overs}.${st.score.balls}`, '0.1');
});

head('FREE HIT — only a run out can dismiss');
newMatch('T20');
E('recordBall("Nb",{runsOffBat:0})');
const wktsBefore = E('state.score.wickets');
E('recordBall("W",{dismissalType:"Bowled"})');
eq('bowled on a free hit is refused', E('state.score.wickets'), wktsBefore);
E('recordBall("W",{dismissalType:"Run Out",runsCompleted:0,runOutWho:"striker"})');
eq('run out on a free hit is allowed', E('state.score.wickets'), wktsBefore + 1);

/* ---------------------------------------------------------------- */
head('OVER-END STRIKE ROTATION');
newMatch('T20');
for(let i=0;i<5;i++) E('recordBall("0")');
E('recordBall("0")');
eq('ends swap at the end of the over', E('state.striker.name'), 'NonStriker');
newMatch('T20');
for(let i=0;i<5;i++) E('recordBall("0")');
E('recordBall("1")');
eq('odd run then over-end swap = back on strike', E('state.striker.name'), 'Striker');

head('WICKET ON THE LAST BALL OF AN OVER');
newMatch('T20');
for(let i=0;i<5;i++) E('recordBall("0")');
E('recordBall("W",{dismissalType:"Bowled"})');
s = S();
eq('over completed', `${s.score.overs}.${s.score.balls}`, '1.0');
eq('survivor takes strike for the new over', s.striker.name, 'NonStriker');
eq('new batsman comes in at the non-striker end', s.newBatsmanEnd, 'nonStriker');

/* ---------------------------------------------------------------- */
head('PENALTY RUNS — to the batting side');
newMatch('T20');
E('recordBall("4")');
const pen = JSON.parse(E('JSON.stringify(recordPenaltyRuns({runs:5,awardedTo:"BATTING",reasonCode:"ILLEGAL_FIELDING"}))'));
s = S();
eq('penalty in the team total', s.score.runs, 9);
eq('penalty in its own bucket', s.extras.A.pen, 5);
eq('penalty is NOT a wide', s.extras.A.wd, 0);
eq('penalty is NOT a no ball', s.extras.A.nb, 0);
eq('penalty is NOT a bye', s.extras.A.b, 0);
eq('penalty is NOT a leg bye', s.extras.A.lb, 0);
eq('batsman runs untouched', s.striker.runs, 4);
eq('balls faced untouched', s.striker.balls, 1);
eq('no legal ball consumed', `${s.score.overs}.${s.score.balls}`, '0.1');
eq('striker unchanged', s.striker.name, 'Striker');
eq('non-striker unchanged', s.nonStriker.name, 'NonStriker');
eq('bowler runs untouched', s.bowler.runs, 4);
eq('ledger entry recorded', s.penaltyLog.length, 1);
ok('ledger records the reason', !!pen.reasonLabel, JSON.stringify(pen));
ok('penalty reconciles', R().ok, JSON.stringify(R().issues));

head('PENALTY RUNS — validation');
newMatch('T20');
eq('a penalty with no reason is refused', E('recordPenaltyRuns({runs:5,awardedTo:"BATTING"})'), null);
eq('a penalty with no side is refused', E('recordPenaltyRuns({runs:5,reasonCode:"UNFAIR_PLAY"})'), null);
eq('zero runs refused', E('recordPenaltyRuns({runs:0,awardedTo:"BATTING",reasonCode:"UNFAIR_PLAY"})'), null);
eq('a batting-side-only reason cannot go to the fielding side',
   E('recordPenaltyRuns({runs:5,awardedTo:"FIELDING",reasonCode:"BALL_STRIKING_HELMET"})'), null);
eq('nothing was scored by any refused award', E('state.score.runs'), 0);

head('PENALTY RUNS — to the fielding side (Law 18.11)');
// they have not batted yet -> carried into their innings
newMatch('T20');
E('recordPenaltyRuns({runs:5,awardedTo:"FIELDING",reasonCode:"DELIBERATE_SHORT_RUN"})');
s = S();
eq('not added to the batting side', s.score.runs, 0);
eq('carried for the side that has not batted', s.pendingPenalty.B, 5);
E('for(let i=0;i<120;i++){ if(!isInningsOver()) recordBall("0"); }');
E('document.getElementById("next-innings-btn").click()');
s = S();
eq('carried penalty seeded into their innings', s.score.runs, 5);
eq('seeded as penalty extras', s.extras.B.pen, 5);
eq('carry cleared', s.pendingPenalty.B, 0);

// they HAVE batted -> onto their completed innings, and the target moves
newMatch('T20');
E('recordBall("6")');
E('for(let i=0;i<120;i++){ if(!isInningsOver()) recordBall("0"); }');
E('document.getElementById("next-innings-btn").click()');
eq('target after a 6', E('state.target'), 7);
E('recordPenaltyRuns({runs:5,awardedTo:"FIELDING",reasonCode:"DAMAGING_PITCH"})');
s = S();
eq('penalty joined their completed innings', s.inningsArchive[0].runs, 11);
eq('chase target recalculated', s.target, 12);
eq('the side batting now was not credited', s.score.runs, 0);

head('PENALTY RUNS — removal recalculates');
newMatch('T20');
E('recordBall("4")');
const pid = E('recordPenaltyRuns({runs:5,awardedTo:"BATTING",reasonCode:"UNFAIR_PLAY"}).id');
eq('total with penalty', E('state.score.runs'), 9);
E(`removePenaltyRuns(${JSON.stringify(pid)})`);
s = S();
eq('total back after removal', s.score.runs, 4);
eq('penalty bucket back to 0', s.extras.A.pen, 0);
eq('ledger entry gone', s.penaltyLog.length, 0);

head('PENALTY RUNS — undo restores exactly');
newMatch('T20');
E('recordBall("2")');
E('recordPenaltyRuns({runs:5,awardedTo:"BATTING",reasonCode:"UNFAIR_PLAY"})');
eq('before undo', E('state.score.runs'), 7);
E('restoreHistorySnapshot(history.pop())');
s = S();
eq('undo removed the penalty runs', s.score.runs, 2);
eq('undo removed the ledger entry', s.penaltyLog.length, 0);

/* ---------------------------------------------------------------- */
head('TARGET / CHASE');
newMatch('T20');
E('recordBall("4")'); E('recordBall("4")');
E('for(let i=0;i<120;i++){ if(!isInningsOver()) recordBall("0"); }');
E('document.getElementById("next-innings-btn").click()');
eq('target = first innings + 1', E('state.target'), 9);
eq('second innings team', E('state.battingTeam'), 'B');
E('state.striker={name:"C1",id:"c1",runs:0,balls:0,fours:0,sixes:0}');
E('state.nonStriker={name:"C2",id:"c2",runs:0,balls:0,fours:0,sixes:0}');
E('state.bowler={name:"B2",id:"b2",overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0}');
E('recordBall("6")'); E('recordBall("3")');
s = S();
eq('chase won at 9', s.score.runs, 9);
ok('result is a win by wickets', /WON BY 10 WICKETS/.test(s.matchResultText || ''), s.matchResultText);
eq('no further ball can be recorded', E('isInningsOver()'), true);

head('TIE in a T20 -> SUPER OVER, not a final result');
newMatch('T20');
E('recordBall("4")');
E('for(let i=0;i<120;i++){ if(!isInningsOver()) recordBall("0"); }');
E('document.getElementById("next-innings-btn").click()');
E('state.striker={name:"C1",id:"c1",runs:0,balls:0,fours:0,sixes:0};state.nonStriker={name:"C2",id:"c2",runs:0,balls:0,fours:0,sixes:0};state.bowler={name:"B2",id:"b2",overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0}');
E('recordBall("4")');
E('for(let i=0;i<200;i++){ if(!isInningsOver()) recordBall("0"); }');
s = S();
eq('scores level', s.score.runs, s.inningsArchive[0].runs);
eq('the match has NO result yet', s.matchResultText, null);
eq('a Super Over is pending', E('isSuperOverPending()'), true);
ok('the Super Over control is offered', !w.document.getElementById('so-start-btn').hidden);

head('TIE in a Test -> the match is tied, no Super Over');
// margin = target - 1 - runs; target 1 with 0 scored is a genuine tie
newMatch('Test');
E('state.target = 1; state.score.runs = 0; state.score.wickets = 9;');
E('recordBall("W",{dismissalType:"Bowled"})');
s = S();
eq('Test has no Super Over provision', E('isSuperOverPending()'), false);
ok('Test ends tied outright', (s.matchResultText || '').includes('TIED'), s.matchResultText);

/* ---------------------------------------------------------------- */
head('SUPER OVER — full procedure');
newMatch('T20');
E('recordBall("4")');
E('for(let i=0;i<120;i++){ if(!isInningsOver()) recordBall("0"); }');
E('document.getElementById("next-innings-btn").click()');
E('state.striker={name:"C1",id:"c1",runs:0,balls:0,fours:0,sixes:0};state.nonStriker={name:"C2",id:"c2",runs:0,balls:0,fours:0,sixes:0};state.bowler={name:"B2",id:"b2",overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0}');
E('recordBall("4")');
E('for(let i=0;i<200;i++){ if(!isInningsOver()) recordBall("0"); }');
eq('regulation tied', E('isSuperOverPending()'), true);
const regBattingCardA = E('state.battingCard.A.length');
const regExtrasA = JSON.parse(E('JSON.stringify(state.extras.A)'));
eq('start super over', E('startSuperOver()'), true);
s = S();
eq('phase is SUPER_OVER', s.phase, 'SUPER_OVER');
eq('this is Super Over 1', s.superOver.number, 1);
eq('the side that batted second bats first', s.battingTeam, 'B');
eq('a Super Over innings is 6 legal balls', E('ballsPerInnings()'), 6);
eq('a Super Over innings ends on 2 wickets', E('maxWickets()'), 2);
eq('score reset for the Super Over', s.score.runs, 0);
ok('the Super Over bar is visible', !w.document.getElementById('so-bar').hidden);

// bowl it, including a wide and a no ball
E('state.striker={name:"SO_B1",id:"sb1",runs:0,balls:0,fours:0,sixes:0};state.nonStriker={name:"SO_B2",id:"sb2",runs:0,balls:0,fours:0,sixes:0};state.bowler={name:"SO_BOWL",id:"sbw",overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0}');
E('recordBall("1")');
E('recordBall("Wd",{extraRuns:0})');
E('recordBall("2")');
E('recordBall("Nb",{runsOffBat:0})');
E('recordBall("4")');
E('recordBall("0")');
E('recordBall("2")');
E('recordBall("1")');
s = S();
// 8 deliveries were entered; 2 of them (the wide and the no ball) are not
// legal balls, so the innings is exactly 6 legal balls long.
eq('6 legal balls bowled, not 8', s.score.overs * 6 + s.score.balls, 6);
eq('Super Over innings total', s.score.runs, 1+1+2+1+4+0+2+1);
eq('Super Over innings is over', E('isInningsOver()'), true);
eq('Super Over extras are kept separately', s.superOver.extras.B.wd, 1);
eq('regulation extras untouched by the Super Over', JSON.stringify(s.extras.A), JSON.stringify(regExtrasA));
eq('regulation batting card untouched', s.battingCard.A.length, regBattingCardA);
ok('Super Over deliveries are tagged with the phase', s.ballLog.filter(b => b.phase === 'SUPER_OVER').length === 8,
   String(s.ballLog.filter(b => b.phase === 'SUPER_OVER').length));
ok('Super Over deliveries carry a super over id', !!s.ballLog[s.ballLog.length-1].superOverId);
ok('Super Over innings reconciles', R().ok, JSON.stringify(R().issues));

const soFirstTotal = E('state.score.runs');
eq('end the first Super Over innings', E('endSuperOverInnings()'), true);
s = S();
eq('second Super Over innings staged', s.superOver.inningsIndex, 1);
eq('the other side now bats', s.battingTeam, 'A');
eq('Super Over target', s.target, soFirstTotal + 1);
eq('first Super Over innings archived', s.superOver.archive.length, 1);
eq('archived under Super Over 1', s.superOver.archive[0].number, 1);

head('SUPER OVER — innings ends on the 2nd wicket');
E('state.striker={name:"SO_A1",id:"sa1",runs:0,balls:0,fours:0,sixes:0};state.nonStriker={name:"SO_A2",id:"sa2",runs:0,balls:0,fours:0,sixes:0};state.bowler={name:"SO_BOWL2",id:"sbw2",overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0}');
E('recordBall("1")');
E('recordBall("W",{dismissalType:"Bowled"})');
eq('1 wicket — innings continues', E('isInningsOver()'), false);
E('state.striker={name:"SO_A3",id:"sa3",runs:0,balls:0,fours:0,sixes:0}');
E('recordBall("W",{dismissalType:"Bowled"})');
eq('2 wickets — the Super Over innings is over', E('isInningsOver()'), true);
const before = E('state.score.runs');
E('recordBall("6")');
eq('no further delivery is accepted', E('state.score.runs'), before);

eq('resolve the Super Over', E('endSuperOverInnings()'), true);
s = S();
eq('both Super Over innings archived', s.superOver.archive.length, 2);
ok('the Super Over decided the match', /SUPER OVER/.test(s.matchResultText || ''), s.matchResultText);
eq('winner recorded', s.matchWinnerKey, 'B');
ok('regulation result kept separately', s.superOver.regulation && s.superOver.regulation.resultText === 'MATCH TIED');

head('SUPER OVER — a tied Super Over is followed by another');
newMatch('T20');
E(`
  state.superOverReady = true;
  state.superOver.regulation = { teamA:'100/5', teamB:'100/7', resultText:'MATCH TIED', secondTeam:'B', innings:[{no:1,team:'A',runs:100},{no:2,team:'B',runs:100}] };
`);
E('startSuperOver()');
E('state.striker={name:"X1",id:"x1",runs:0,balls:0,fours:0,sixes:0};state.nonStriker={name:"X2",id:"x2",runs:0,balls:0,fours:0,sixes:0};state.bowler={name:"XB",id:"xb",overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0}');
for(let i=0;i<6;i++) E('recordBall("1")');
E('endSuperOverInnings()');
E('state.striker={name:"Y1",id:"y1",runs:0,balls:0,fours:0,sixes:0};state.nonStriker={name:"Y2",id:"y2",runs:0,balls:0,fours:0,sixes:0};state.bowler={name:"YB",id:"yb",overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0}');
for(let i=0;i<5;i++) E('recordBall("1")');
E('recordBall("1")');
E('endSuperOverInnings()');
s = S();
eq('both Super Over 1 innings scored 6', s.superOver.archive[0].runs, 6);
eq('and 6', s.superOver.archive[1].runs, 6);
eq('no final result — another Super Over follows', s.matchResultText, null);
eq('another Super Over is offered', E('isSuperOverPending()'), true);
eq('start Super Over 2', E('startSuperOver()'), true);
eq('this is Super Over 2', E('state.superOver.number'), 2);
eq('Super Over 1 history preserved', E('state.superOver.archive.length'), 2);

head('SUPER OVER — the regulation controls cannot corrupt it');
newMatch('T20');
E(`state.battingTeam='B'; state.superOverReady = true; startSuperOver();
   state.striker={name:'S',id:'s',runs:0,balls:0,fours:0,sixes:0};
   state.nonStriker={name:'N',id:'n',runs:0,balls:0,fours:0,sixes:0};
   state.bowler={name:'B',id:'b',overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0};
   for(let i=0;i<6;i++) recordBall('1');`);
eq('the Super Over innings is over', E('isInningsOver()'), true);
eq('"Start Next Innings" is disabled during a Super Over', E('document.getElementById("next-innings-btn").disabled'), true);
// and even if something clicks it anyway, it must be a no-op
const soBefore = E('JSON.stringify({inn:state.inningsNumber,phase:state.phase,arch:state.inningsArchive.length,target:state.target,runs:state.score.runs})');
E('document.getElementById("next-innings-btn").disabled = false; document.getElementById("next-innings-btn").click();');
const soAfter = E('JSON.stringify({inn:state.inningsNumber,phase:state.phase,arch:state.inningsArchive.length,target:state.target,runs:state.score.runs})');
eq('a forced click changes nothing (no regulation innings invented)', soAfter, soBefore);
eq('the Super Over innings is still intact', E('state.score.runs'), 6);
eq('no Super Over innings leaked into the regulation archive', E('state.inningsArchive.length'), 0);
eq('the proper Super Over transition still works', E('endSuperOverInnings()'), true);
eq('and it archived to the Super Over, not the regulation innings', E('state.superOver.archive.length'), 1);
eq('regulation archive still untouched', E('state.inningsArchive.length'), 0);

head('SUPER OVER — never applied where the conditions do not provide for one');
newMatch('Test');
E('state.superOverReady = false');
eq('a Test refuses a Super Over', E('startSuperOver()'), false);
newMatch('Custom', 8);
E('state.customSuperOverEnabled = false; state.superOverReady = true;');
eq('a Custom competition can switch it off', E('startSuperOver()'), false);

head('SUPER OVER — penalty runs and overthrows use the same engine');
newMatch('T20');
// startSuperOver() derives "the side that batted second" from whoever is
// batting when the regulation match ties, so stage that rather than presetting it.
E(`state.battingTeam = 'B'; state.superOverReady = true;`);
E('startSuperOver()');
eq('the side batting at the tie bats first in the Super Over', E('state.battingTeam'), 'B');
E('state.striker={name:"Z1",id:"z1",runs:0,balls:0,fours:0,sixes:0};state.nonStriker={name:"Z2",id:"z2",runs:0,balls:0,fours:0,sixes:0};state.bowler={name:"ZB",id:"zb",overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0}');
E('recordBall("OT",{runsCompleted:2,boundary:true,crossed:false})');
E('recordPenaltyRuns({runs:5,awardedTo:"BATTING",reasonCode:"ILLEGAL_FIELDING"})');
s = S();
eq('overthrow scored the same way in a Super Over', s.striker.runs, 6);
eq('Super Over total includes the penalty', s.score.runs, 11);
eq('the penalty went to the Super Over extras, not the regulation ones', s.superOver.extras.B.pen, 5);
eq('regulation extras still clean', s.extras.B.pen, 0);
ok('Super Over with a penalty reconciles', R().ok, JSON.stringify(R().issues));

/* ---------------------------------------------------------------- */
head('TEST MATCH — four innings, declaration, follow-on');
newMatch('Test');
eq('no overs limit is applied', E('isInningsOver()'), false);
E('for(let i=0;i<200;i++) recordBall("1")');
s = S();
eq('200 legal balls bowled with no innings end', s.score.overs, 33);
eq('still not over after 33.2 overs', E('isInningsOver()'), false);
E('state.declared = true; updateBallButtonsState();');
eq('a declaration ends the innings', E('isInningsOver()'), true);
E('document.getElementById("next-innings-btn").click()');
s = S();
eq('innings 2 started', s.inningsNumber, 2);
eq('no target after the 1st Test innings', s.target, null);
eq('the other side bats', s.battingTeam, 'B');

head('TEST MATCH — 4th innings target');
newMatch('Test');
E(`
  state.inningsArchive = [
    { no:1, team:'A', runs:450, wickets:8, overs:'120.0', extras: EMPTY_EXTRAS() },
    { no:2, team:'B', runs:250, wickets:10, overs:'80.0', extras: EMPTY_EXTRAS() },
    { no:3, team:'A', runs:120, wickets:10, overs:'40.0', extras: EMPTY_EXTRAS() }
  ];
  state.inningsNumber = 4; state.battingTeam = 'B';
  recomputeTarget();
`);
eq('4th innings target = lead + 1', E('state.target'), 450 + 120 - 250 + 1);

/* ---------------------------------------------------------------- */
head('RECONCILIATION detects a corrupted score');
newMatch('T20');
E('recordBall("4")'); E('recordBall("1")');
ok('clean innings reconciles', R().ok, JSON.stringify(R().issues));
E('state.score.runs += 3'); // simulate the "just change the UI score" anti-pattern
let r = R();
ok('an invented 3 runs is caught', !r.ok, JSON.stringify(r.issues));
ok('the report names the total', r.issues.some(i => i.startsWith('total:')), JSON.stringify(r.issues));
E('state.score.runs -= 3; state.score.wickets = 2');
r = R();
ok('invented wickets are caught', r.issues.some(i => i.startsWith('wickets:')), JSON.stringify(r.issues));

head('UNDO — snapshot restore is exact for every new event type');
newMatch('T20');
E('recordBall("OT",{runsCompleted:2,boundary:true,crossed:false})');
eq('overthrow scored', E('state.score.runs'), 6);
E('restoreHistorySnapshot(history.pop())');
s = S();
eq('overthrow fully undone — runs', s.score.runs, 0);
eq('overthrow fully undone — striker', s.striker.runs, 0);
eq('overthrow fully undone — ball count', `${s.score.overs}.${s.score.balls}`, '0.0');

console.log('\njsdom errors during the run: ' + errors.length);
errors.slice(0,5).forEach(e => console.log('  ' + String(e).split('\n')[0]));
console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
if(fail) { console.log('\nFAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
