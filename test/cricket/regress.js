const { w, errors } = require('./harness.js');
const E = c => w.eval(c);
let pass=0, fail=0;
function ok(n,c,d){ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+(d?' :: '+d:''));} }
function noThrow(n, code){
  try { const r = E(code); ok(n, true); return r; }
  catch(e){ ok(n, false, e.message); return null; }
}
function head(t){ console.log('\n=== '+t+' ==='); }

// A realistic match with every new event type in it, then exercise every
// downstream builder that reads state.
E(`
  state = mergeWithDefaults(null);
  state.format='T20'; state.battingTeam='A'; state.leagueName='Regress Cup'; state.matchMode='tournament';
  state.striker    = { name:'Striker', id:'p1', runs:0, balls:0, fours:0, sixes:0 };
  state.nonStriker = { name:'NonStriker', id:'p2', runs:0, balls:0, fours:0, sixes:0 };
  state.bowler     = { name:'Bowler', id:'p9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
  history = [];
  recordBall('4');
  recordBall('Wd',{extraRuns:2});
  recordBall('OT',{runsCompleted:2,boundary:true,crossed:true});
  recordBall('Nb',{runsOffBat:6});
  recordBall('B',{runs:2});
  recordBall('LB',{runs:1});
  recordPenaltyRuns({runs:5,awardedTo:'BATTING',reasonCode:'UNFAIR_PLAY'});
  // The incoming batsman fills whichever end the engine says is vacant —
  // overwriting state.striker unconditionally would wipe the SURVIVOR's runs
  // whenever the batters had crossed, which is exactly what the reconciliation
  // check flagged the first time this ran.
  function sendIn(name, id){
    state[state.newBatsmanEnd] = { name, id, runs:0, balls:0, fours:0, sixes:0 };
  }
  recordBall('W',{dismissalType:'Caught',fielderName:'Catcher'});
  sendIn('New','p3');
  recordBall('1');
  recordBall('WdW',{dismissalType:'Run Out',extraRuns:1,fielderName:'F',runOutWho:'striker'});
  sendIn('New2','p4');
  recordBall('NbW',{dismissalType:'Run Out',runsOffBat:1,fielderName:'F',runOutWho:'nonStriker'});
  sendIn('New3','p5');
`);

head('EXISTING BUILDERS still work with penalties / overthrows in the innings');
noThrow('renderPanel()', 'renderPanel(); true');
noThrow('buildInningsSummaryPayload()', 'JSON.stringify(buildInningsSummaryPayload()).length > 0');
noThrow('buildMatchSummaryPayload()', 'JSON.stringify(buildMatchSummaryPayload()).length > 0');
noThrow('buildMatchRecordForLeague()', 'JSON.stringify(buildMatchRecordForLeague()).length > 0');
noThrow('buildPlayerStatPayload()', 'typeof buildPlayerStatPayload === "function" ? !!buildPlayerStatPayload() : true');
noThrow('buildBowlerStatPayload()', 'typeof buildBowlerStatPayload === "function" ? !!buildBowlerStatPayload() : true');
noThrow('computeOverSummary()', 'typeof computeOverSummary === "function" ? (computeOverSummary(), true) : true');
noThrow('computeLivePartnerships()', 'typeof computeLivePartnerships === "function" ? (computeLivePartnerships(), true) : true');
noThrow('renderScorecardHtml()', 'renderScorecardHtml(buildMatchRecordForLeague()).length > 0');
noThrow('battingRowsForExcel()', 'typeof battingRowsForExcel === "function" ? (battingRowsForExcel("A",1), true) : true');
noThrow('bowlingRowsForExcel()', 'typeof bowlingRowsForExcel === "function" ? (bowlingRowsForExcel("B",1), true) : true');
noThrow('renderBallEditList()', 'renderBallEditList(); true');
noThrow('reconcileInnings()', 'reconcileInnings().issues.length >= 0');
noThrow('renderPenaltyLedger()', 'renderPenaltyLedger(); true');
noThrow('renderSuperOverPanel()', 'renderSuperOverPanel(); true');

head('THE MATCH RECORD carries the penalty runs');
const rec = JSON.parse(E('JSON.stringify(buildMatchRecordForLeague())'));
ok('record has extras for team A', !!(rec.extras && rec.extras.A), JSON.stringify(rec.extras));
ok('penalty runs are in the saved record', (rec.extras.A.pen || 0) === 5, JSON.stringify(rec.extras.A));

head('RECONCILIATION on that whole innings');
const r = JSON.parse(E('JSON.stringify(reconcileInnings())'));
ok('a mixed innings with every event type reconciles', r.ok, JSON.stringify(r.issues));

head('THE LEDGER survives a reload (state persists through localStorage)');
E('saveLocal()');
const reloaded = JSON.parse(E('JSON.stringify(mergeWithDefaults(loadState()))'));
ok('penalty ledger persisted', reloaded.penaltyLog.length === 1, String(reloaded.penaltyLog.length));
ok('penalty extras persisted', reloaded.extras.A.pen === 5, String(reloaded.extras.A.pen));
ok('phase persisted', reloaded.phase === 'REGULATION', reloaded.phase);

head('BACKWARD COMPATIBILITY with a state saved before these fields existed');
const legacy = JSON.parse(E('JSON.stringify(mergeWithDefaults({ format:"T20", score:{runs:50,wickets:2,overs:8,balls:3}, extras:{ A:{wd:3,nb:1,b:0,lb:2}, B:{wd:0,nb:0,b:0,lb:0} } }))'));
ok('an old saved state gains a penalty bucket', legacy.extras.A.pen === 0, JSON.stringify(legacy.extras.A));
ok('old wide count preserved', legacy.extras.A.wd === 3, String(legacy.extras.A.wd));
ok('an old saved state gains a phase', legacy.phase === 'REGULATION', legacy.phase);
ok('an old saved state gains a penalty ledger', Array.isArray(legacy.penaltyLog), typeof legacy.penaltyLog);
ok('an old saved state gains super over state', !!legacy.superOver && legacy.superOver.number === 0, JSON.stringify(legacy.superOver && legacy.superOver.number));
E('state = mergeWithDefaults({ format:"T20", score:{runs:50,wickets:2,overs:8,balls:3}, extras:{ A:{wd:3,nb:1,b:0,lb:2}, B:{wd:0,nb:0,b:0,lb:0} } })');
noThrow('an old saved state still renders', 'renderPanel(); true');
noThrow('an old saved state still scores', 'state.striker={name:"S",id:"s",runs:0,balls:0,fours:0,sixes:0}; state.nonStriker={name:"N",id:"n",runs:0,balls:0,fours:0,sixes:0}; state.bowler={name:"B",id:"b",overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0}; recordBall("4"); state.score.runs === 54');

head('RESET still clears everything');
E('state = defaultState()');
ok('reset clears the phase', E('state.phase') === 'REGULATION');
ok('reset clears the penalty ledger', E('state.penaltyLog.length') === 0);
ok('reset clears super over history', E('state.superOver.archive.length') === 0);

console.log('\njsdom errors: ' + errors.length);
errors.slice(0,5).forEach(e => console.log('  ' + String(e).split('\n')[0]));
console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail ? 1 : 0);
