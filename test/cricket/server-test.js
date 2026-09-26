/* Extracts the server's canonical derivation (deriveBallFacts +
   buildLiveCardsFromBallsArray) out of server.js and runs the SAME ball
   documents the panel would emit through it, so panel and server can be
   compared instead of assumed to agree. */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname,'..','..','server.js'), 'utf8');

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
const sandbox = {};
const code = [grab('deriveBallFacts'), grab('buildLiveCardsFromBallsArray'), 'return { deriveBallFacts, buildLiveCardsFromBallsArray };'].join('\n');
const api = new Function(code)();

let pass = 0, fail = 0;
function eq(name, a, b){
  if(a === b){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const key = n => n ? String(n).toLowerCase().replace(/\s+/g,' ').trim() : null;
const ball = o => Object.assign({
  matchId:'M', innings:1, over:0, ballInOver:1, battingTeam:'A', runs:0, kind:'0',
  striker:'Striker', strikerKey:key('Striker'), nonStriker:'NonStriker', nonStrikerKey:key('NonStriker'),
  bowler:'Bowler', bowlerKey:key('Bowler'), dismissal:null
}, o);

console.log('\n=== SERVER DERIVATION — penalty events ===');
let cards = api.buildLiveCardsFromBallsArray([
  ball({ kind:'4', runs:4, ballInOver:1 }),
  // a penalty award: no striker, no bowler, not a delivery
  { matchId:'M', innings:1, over:0, ballInOver:1, battingTeam:'A', kind:'PEN', runs:5,
    striker:null, strikerKey:null, nonStriker:null, nonStrikerKey:null, bowler:null, bowlerKey:null,
    dismissal:null, penalty:{ runs:5, awardedTo:'BATTING', team:'A', reasonCode:'ILLEGAL_FIELDING' } },
  ball({ kind:'1', runs:1, ballInOver:2 })
]);
eq('team total includes the penalty', cards.scoreA.runs, 10);
eq('penalty consumed no legal ball', cards.scoreA.overs, '0.2');
eq('penalty is its own extras bucket', cards.extras.A.pen, 5);
eq('penalty is not a wide', cards.extras.A.wd, 0);
eq('penalty is not a no ball', cards.extras.A.nb, 0);
eq('penalty is not a bye', cards.extras.A.b, 0);
eq('penalty is not a leg bye', cards.extras.A.lb, 0);
eq('no batsman was credited the penalty', cards.battingCard.A[0].runs, 5);
eq('no extra ball faced', cards.battingCard.A[0].balls, 2);
eq('no bowler was charged the penalty', cards.bowlingCard.B[0].runs, 5);
eq('penalty took no wicket', cards.scoreA.wickets, 0);
eq('derive: a penalty is not a legal ball', api.deriveBallFacts('PEN', 5).legalBall, false);
eq('derive: a penalty credits no bat runs', api.deriveBallFacts('PEN', 5).runsOffBat, 0);

console.log('\n=== SERVER DERIVATION — wide with runs run (Law 22) ===');
cards = api.buildLiveCardsFromBallsArray([ ball({ kind:'Wd', runs:3, ballInOver:1 }) ]);
eq('all wide runs are extras', cards.extras.A.wd, 3);
eq('team total', cards.scoreA.runs, 3);
eq('no legal ball', cards.scoreA.overs, '0.0');
eq('no batting row at all for a wide', cards.battingCard.A.length, 0);
eq('bowler charged the wide', cards.bowlingCard.B[0].runs, 3);

console.log('\n=== SERVER DERIVATION — overthrow ===');
cards = api.buildLiveCardsFromBallsArray([ ball({ kind:'OT', runs:6, ballInOver:1 }) ]);
eq('overthrow runs all to the striker', cards.battingCard.A[0].runs, 6);
eq('overthrow is not a batsman six', cards.battingCard.A[0].sixes, 0);
eq('overthrow is not a batsman four', cards.battingCard.A[0].fours, 0);
eq('overthrow is a legal ball', cards.scoreA.overs, '0.1');
eq('overthrow never touches extras',
   cards.extras.A.wd + cards.extras.A.nb + cards.extras.A.b + cards.extras.A.lb + cards.extras.A.pen, 0);
eq('bowler charged the overthrow runs', cards.bowlingCard.B[0].runs, 6);

console.log('\n=== PANEL <-> SERVER: the same balls must give the same card ===');
const { w } = require('./harness.js');
const E = c => w.eval(c);
E(`
  state = mergeWithDefaults(null);
  state.format='T20'; state.battingTeam='A';
  state.striker    = { name:'Striker', id:'p1', runs:0, balls:0, fours:0, sixes:0 };
  state.nonStriker = { name:'NonStriker', id:'p2', runs:0, balls:0, fours:0, sixes:0 };
  state.bowler     = { name:'Bowler', id:'p9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
  history = [];
  recordBall('4');
  recordBall('Wd',{extraRuns:2});
  recordBall('OT',{runsCompleted:2,boundary:true,crossed:false});
  recordBall('Nb',{runsOffBat:6});
  recordBall('B',{runs:2});
  recordBall('LB',{runs:1});
  recordPenaltyRuns({runs:5,awardedTo:'BATTING',reasonCode:'UNFAIR_PLAY'});
  recordBall('1');
`);
const st = JSON.parse(E('JSON.stringify(state)'));

// Rebuild the ball documents exactly as logBallToDb/the penalty emit would.
const dbKind = k => k === 'WdW' ? 'Wd' : k === 'NbW' ? 'Nb' : k;
let n = 0;
const docs = st.ballLog.map(b => {
  const [ov, bi] = String(b.over).split('.').map(x => parseInt(x, 10));
  if(b.ballType === 'PEN'){
    return { matchId:'M', innings:b.innings, over:ov, ballInOver:bi, battingTeam:b.battingTeam,
             kind:'PEN', runs:b.runs, striker:null, strikerKey:null, nonStriker:null, nonStrikerKey:null,
             bowler:null, bowlerKey:null, dismissal:null, penalty:b.penalty, seq:n++ };
  }
  return { matchId:'M', innings:b.innings, over:ov, ballInOver:bi, battingTeam:b.battingTeam,
           kind:dbKind(b.ballType), runs:b.runs,
           striker:b.striker, strikerKey:key(b.striker), nonStriker:b.nonStriker, nonStrikerKey:key(b.nonStriker),
           bowler:b.bowler, bowlerKey:key(b.bowler),
           dismissal: b.isWicket ? { type: b.dismissalType || 'Out', fielder: b.fielderName || null } : null, seq:n++ };
});
const srv = api.buildLiveCardsFromBallsArray(docs);

eq('team total agrees', srv.scoreA.runs, st.score.runs);
eq('wickets agree', srv.scoreA.wickets, st.score.wickets);
eq('overs agree', srv.scoreA.overs, `${st.score.overs}.${st.score.balls}`);
eq('wides agree', srv.extras.A.wd, st.extras.A.wd);
eq('no balls agree', srv.extras.A.nb, st.extras.A.nb);
eq('byes agree', srv.extras.A.b, st.extras.A.b);
eq('leg byes agree', srv.extras.A.lb, st.extras.A.lb);
eq('penalty runs agree', srv.extras.A.pen, st.extras.A.pen);
const srvBatRuns = srv.battingCard.A.reduce((s,r)=>s+r.runs,0);
const panelBatRuns = st.striker.runs + st.nonStriker.runs;
eq('batting runs agree', srvBatRuns, panelBatRuns);
const srvExtras = Object.values(srv.extras.A).reduce((a,b)=>a+b,0);
eq('server card balances: batters + extras === total', srvBatRuns + srvExtras, srv.scoreA.runs);
eq('panel reconciles too', E('reconcileInnings().ok'), true);
eq('bowler runs agree', srv.bowlingCard.B[0].runs, st.bowler.runs);

console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail ? 1 : 0);
