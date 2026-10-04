// Super Over + No-Ball regression suite (tests 1–14), run against BOTH
// panels (Clipper = cricket-panel.html, Stream Engine = cricket-panel3.html),
// then the same panel state fed to the public scorecard and the overlay —
// one authoritative match state, three readers that must agree.
//
//   node test/cricket/superover-noball-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Stand-in for CDN libraries (firebase, gsap): any property, any call.
function deep(){
  return new Proxy(function(){}, {
    get: (t, k) => k === Symbol.toPrimitive ? (() => 0) : (k === 'then' ? undefined : deep()),
    apply: () => deep()
  });
}
function boot(file, url, extra){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url, virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){}, io: { on(){} } });
      w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
      w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLMediaElement.prototype.pause = () => {};
      w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
      w.IntersectionObserver = w.IntersectionObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.ResizeObserver = w.ResizeObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.scrollTo = () => {};
      if(extra) extra(w);
    }
  });
  return { w: dom.window, E: (c) => dom.window.eval(c), errors, $: (s) => dom.window.document.querySelector(s), text: (s) => { const el = dom.window.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; } };
}

// A fresh T20: Team A (MI) bats first.
function newMatch(P){
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A';
    state.teamA.name = 'Mumbai Indians'; state.teamA.short = 'MI'; state.teamA.color = '#1d4ed8';
    state.teamB.name = 'Royal Challengers'; state.teamB.short = 'RCB'; state.teamB.color = '#dc2626';
    state.teamA.players = [{id:'p1',name:'Striker',isXI:true},{id:'p2',name:'NonStriker',isXI:true},{id:'p3',name:'Third',isXI:true}];
    state.teamB.players = [{id:'p9',name:'Bowler',isXI:true},{id:'p8',name:'Second Bowler',isXI:true}];
    state.striker    = { name:'Striker', id:'p1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'NonStriker', id:'p2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler     = { name:'Bowler', id:'p9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = [];
    renderPanel();
  `);
}
// Team A makes 280/0 in 20 overs; then Team B either wins the chase
// (finish = 'win') or ends level on 280 (finish = 'tie').
function playRegulation(P, finish){
  P.E(`for(let i = 0; i < 120; i++){ if(!isInningsOver()) recordBall(['1','4','0','6','1','2'][i % 6]); }`);
  P.E(`document.getElementById('next-innings-btn').click()`);
  P.E(`state.striker = {name:'Virat Kohli',id:'bb1',runs:0,balls:0,fours:0,sixes:0}; state.nonStriker = {name:'Faf du Plessis',id:'bb2',runs:0,balls:0,fours:0,sixes:0};
       state.bowler = {name:'Jasprit Bumrah',id:'a9',overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0};`);
  if(finish === 'win') P.E(`let g = 0; while(!state.milestonesHit['match-result'] && g++ < 200) recordBall('6');`);
  else P.E(`const t = state.target - 1; let g = 0; while(state.score.runs < t - 6 && g++ < 200 && !isInningsOver()) recordBall('6'); while(state.score.runs < t && !isInningsOver()) recordBall('1'); while(!isInningsOver()) recordBall('0');`);
}
// Super Over 1: RCB bat first (they batted second in the match) and make
// 14/0 including an NB+1; MI chase 15 and win it.
function playSuperOver(P){
  P.E(`startSuperOver(); state.striker = {name:'Virat Kohli',id:'bb1',runs:0,balls:0,fours:0,sixes:0}; state.nonStriker = {name:'Glenn Maxwell',id:'bb3',runs:0,balls:0,fours:0,sixes:0};
       state.bowler = {name:'Jasprit Bumrah',id:'a9',overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0};`);
  ['4', '1', '0', '6'].forEach(k => P.E(`recordBall('${k}')`));
  P.E(`recordBall('Nb', {runsOffBat:1}); recordBall('1'); recordBall('0');`);
  const soBreak = JSON.parse(P.E('JSON.stringify(state)'));
  P.E(`endSuperOverInnings(); state.striker = {name:'Rohit Sharma',id:'a1',runs:0,balls:0,fours:0,sixes:0}; state.nonStriker = {name:'Suryakumar Yadav',id:'a3',runs:0,balls:0,fours:0,sixes:0};
       state.bowler = {name:'Mohammed Siraj',id:'b9',overs:0,balls:0,maidens:0,runs:0,wickets:0,runsThisOver:0,wicketsThisOver:0};`);
  ['6', '1'].forEach(k => P.E(`recordBall('${k}')`));
  const soLive = JSON.parse(P.E('JSON.stringify(state)'));
  P.E(`recordBall('4'); recordBall('1'); recordBall('2'); recordBall('1');`);
  return { soBreak, soLive };
}
const snap = (P, expr) => JSON.parse(P.E(`JSON.stringify(${expr})`));

const fixtures = {};

async function panelSuite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file, 'https://example.test/cricket-panel?room=TESTMATCH');
  await sleep(80);

  console.log('\n=== 1. Normal T20 match → completed → correct result ===');
  newMatch(P); playRegulation(P, 'win');
  const r1 = snap(P, 'buildMatchRecordForLeague()');
  eq(`${label}: 1 chasing side wins — winner, result line`, [P.E('state.matchWinnerKey'), /WON BY 10 WICKETS/i.test(P.E('state.matchResultText') || '')], ['B', true]);
  eq(`${label}: 1 record — winningTeam, regulation scores, result text`, [r1.winningTeam, r1.scoreA.runs, r1.scoreB.runs > 280, /WON/i.test(r1.resultText || '')], ['B', 280, true, true]);

  console.log('\n=== 4. No Super Over → no Super Over section ===');
  eq(`${label}: 4 record.superOver is null`, r1.superOver, null);
  eq(`${label}: 4 match summary has no Super Over block`, snap(P, 'buildMatchSummaryPayload().superOver') || null, null);
  eq(`${label}: 4 every delivery is a regulation innings`, snap(P, 'state.ballLog.filter(b => b.innings >= 100).length'), 0);
  fixtures.normal = { state: snap(P, 'state'), record: r1 };

  console.log('\n=== 2/3/11. Tie → Super Over → completed ===');
  newMatch(P); playRegulation(P, 'tie');
  eq(`${label}: 2 regulation ends level, Super Over offered (not a result yet)`, [P.E('state.score.runs'), P.E('state.target') - 1, P.E('!!state.superOverReady')], [280, 280, true]);
  // At the tie the 2nd innings is still "live" — its batters are at the crease.
  const regBatB = snap(P, `[state.striker, state.nonStriker].map(b => [b.name, b.runs, b.balls]).sort()`);
  const { soBreak, soLive } = playSuperOver(P);
  const rec = snap(P, 'buildMatchRecordForLeague()');
  eq(`${label}: 2 main match totals are NOT replaced (280/0 v 280/0)`, [rec.scoreA, rec.scoreB].map(s => [s.runs, s.wickets, s.overs]), [[280, 0, '20.0'], [280, 0, '20.0']]);
  eq(`${label}: 2 both regulation innings archived (the 2nd one too)`, rec.inningsArchive.map(i => [i.no, i.team, i.runs]), [[1, 'A', 280], [2, 'B', 280]]);
  eq(`${label}: 2 regulation batting card untouched by the Super Over`, rec.battingCard.B.filter(b => b.inningsNo === 2).map(b => [b.name, b.runs, b.balls]).sort(), regBatB);
  eq(`${label}: 2 no Super Over batter leaks into the regulation card`, rec.battingCard.B.some(b => b.name === 'Glenn Maxwell') || rec.battingCard.A.some(b => b.name === 'Suryakumar Yadav'), false);
  eq(`${label}: 2 Super Over is its own section (innings 101/102)`, rec.superOver && rec.superOver.innings.map(i => [i.innings, i.team, i.runs, i.wickets, i.overs]), [[101, 'B', 14, 0, '1.0'], [102, 'A', 15, 0, '1.0']]);
  eq(`${label}: 2 Super Over deliveries logged as innings 101/102`, snap(P, `[...new Set(state.ballLog.map(b => b.innings))]`), [1, 2, 101, 102]);
  eq(`${label}: 3 Super Over winner is the final winner`, [rec.winningTeam, rec.superOver.winner, rec.superOver.decided], ['A', 'A', true]);
  eq(`${label}: 3 result line names the Super Over`, rec.resultText, 'MI WON THE SUPER OVER BY 2 WICKETS');
  eq(`${label}: 11 completion after the Super Over is final`, [!!P.E(`state.milestonesHit['match-result']`), P.E('state.superOverDecided'), P.E('state.matchWinnerKey')], [true, true, 'A']);
  P.E(`recordBall('6')`);
  eq(`${label}: 11 a stray ball after the result changes nothing`, snap(P, `[state.score.runs, buildMatchRecordForLeague().winningTeam]`), [15, 'A']);
  const sum = snap(P, 'buildMatchSummaryPayload()');
  eq(`${label}: 11 match summary: regulation + Super Over + winner`, [sum.regulationResult, sum.superOver && sum.superOver.innings.map(i => [i.team, i.runs]), sum.superOver && sum.superOver.winner], ['MATCH TIED', [['B', 14], ['A', 15]], 'A']);

  console.log('\n=== 12. Reload a completed match ===');
  const saved = P.E('JSON.stringify(state)');
  P.E(`state = mergeWithDefaults(JSON.parse(${JSON.stringify(saved)})); renderPanel();`);
  const rec2 = snap(P, 'buildMatchRecordForLeague()');
  const keep = r => JSON.stringify([r.winningTeam, r.scoreA, r.scoreB, r.resultText, r.superOver, r.inningsArchive, r.battingCard, r.bowlingCard, r.extras]);
  eq(`${label}: 12 reloaded record is identical (scores, Super Over, result)`, keep(rec2), keep(rec));
  fixtures.so = { state: JSON.parse(saved), record: rec, summary: sum, soLive, soBreak };
  const scHtml = P.E(`renderScorecardHtml(${JSON.stringify(rec)})`).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  eq(`${label}: 13 saved-match scorecard: both innings, then the Super Over, then the result`, [scHtml.indexOf('280/0') > -1, scHtml.indexOf('Super Over 1') > scHtml.lastIndexOf('280/0'), /MI WON THE SUPER OVER BY 2 WICKETS/.test(scHtml)], [true, true, true]);
  eq(`${label}: 4 saved-match scorecard of a normal match has no Super Over`, /Super Over/.test(P.E(`renderScorecardHtml(${JSON.stringify(r1)})`)), false);

  console.log('\n=== 5. NB only ===');
  newMatch(P);
  P.E(`recordBall('Nb')`);
  eq(`${label}: 5 NB → team +1, batsman +0 (faced 1), nb +1, no legal ball`, snap(P, `[state.score.runs, state.striker.name, state.striker.runs, state.striker.balls, state.extras.A.nb, state.score.overs * 6 + state.score.balls, state.bowler.runs]`), [1, 'Striker', 0, 1, 1, 0, 1]);
  eq(`${label}: 5 delivery linked to striker, bowler, innings, over`, snap(P, `(({ballType, striker, strikerId, bowler, innings, over, runs}) => ({ballType, striker, strikerId, bowler, innings, over, runs}))(state.ballLog[0])`), { ballType: 'Nb', striker: 'Striker', strikerId: 'p1', bowler: 'Bowler', innings: 1, over: '0.0', runs: 1 });

  console.log('\n=== 6. NB + 4 ===');
  newMatch(P);
  P.E(`recordBall('Nb', {runsOffBat:4})`);
  eq(`${label}: 6 NB+4 → team +5, batsman +4 (a four), nb +1, strike stays`, snap(P, `[state.score.runs, state.striker.name, state.striker.runs, state.striker.fours, state.extras.A.nb, state.score.overs * 6 + state.score.balls, state.bowler.runs, state.thisOver]`), [5, 'Striker', 4, 1, 1, 0, 5, ['Nb+4']]);

  console.log('\n=== 7. NB + 1 ===');
  newMatch(P);
  P.E(`recordBall('Nb', {runsOffBat:1})`);
  eq(`${label}: 7 NB+1 → team +2, the striker who faced it +1, then strike changes`, snap(P, `[state.score.runs, state.nonStriker.name, state.nonStriker.runs, state.nonStriker.balls, state.striker.name, state.extras.A.nb, state.score.overs * 6 + state.score.balls]`), [2, 'Striker', 1, 1, 'NonStriker', 1, 0]);

  console.log('\n=== 8. Multiple NBs in one over ===');
  newMatch(P);
  P.E(`['Nb'].forEach(k => recordBall(k)); recordBall('Nb', {runsOffBat:4}); recordBall('0'); recordBall('Nb'); recordBall('0'); recordBall('0'); recordBall('0'); recordBall('0');`);
  eq(`${label}: 8 three NBs + five legal balls = still 0.5`, snap(P, `[state.score.overs, state.score.balls, state.extras.A.nb, state.score.runs]`), [0, 5, 3, 7]);
  P.E(`recordBall('0')`);
  eq(`${label}: 8 the over ends on the 6th LEGAL ball; bowler 1.0-0-7-0`, snap(P, `[state.score.overs, state.score.balls, (state.bowlingCard.B.find(b => b.name === 'Bowler') || state.bowler).runs]`), [1, 0, 7]);
  eq(`${label}: 8 each NB logged against the striker who faced it`, snap(P, `state.ballLog.filter(b => b.ballType === 'Nb').map(b => [b.striker, b.runs, b.over])`), [['Striker', 1, '0.0'], ['Striker', 5, '0.0'], ['Striker', 1, '0.1']]);

  console.log('\n=== 9. NB then a legal ball ===');
  newMatch(P);
  P.E(`recordBall('Nb', {runsOffBat:1}); recordBall('0');`);
  eq(`${label}: 9 the next ball is faced by whoever is on strike now (not the NB's batsman)`, snap(P, `state.ballLog.map(b => [b.ballType, b.striker, b.strikerId])`), [['Nb', 'Striker', 'p1'], ['0', 'NonStriker', 'p2']]);
  eq(`${label}: 9 balls faced: one each`, snap(P, `[state.striker.name, state.striker.balls, state.nonStriker.name, state.nonStriker.balls, state.score.overs * 6 + state.score.balls]`), ['NonStriker', 1, 'Striker', 1, 1]);
  P.$('#undo-btn').click(); await sleep(60);
  eq(`${label}: 9 undo puts the legal ball back on the right batter`, snap(P, `[state.striker.name, state.striker.balls, state.nonStriker.name, state.nonStriker.runs, state.score.runs]`), ['NonStriker', 0, 'Striker', 1, 2]);

  console.log('\n=== 10. NB + run out ===');
  newMatch(P);
  P.E(`recordBall('NbW', {dismissalType:'Run Out', runsOffBat:1, fielderName:'F', runOutWho:'nonStriker'})`);
  eq(`${label}: 10 NB+1 run out → team +2, wicket, no legal ball, striker credited 1 (faced it)`, snap(P, `[state.score.runs, state.score.wickets, state.score.overs * 6 + state.score.balls, state.extras.A.nb, (state.battingCard.A.find(b => b.name === 'Striker') || state.striker === null || [state.striker, state.nonStriker].find(p => p && p.name === 'Striker') || {}).runs]`), [2, 1, 0, 1, 1]);
  eq(`${label}: 10 the dismissed batter is the non-striker, the delivery stays the striker's`, snap(P, `[state.battingCard.A.filter(b => b.out).map(b => b.name), state.ballLog[0].striker, state.ballLog[0].ballType, state.bowler.wickets]`), [['NonStriker'], 'Striker', 'NbW', 0]);

  eq(`${label}: no script errors`, P.errors.filter(e => !/Could not parse CSS/.test(e)), []);
}

async function scorecardSuite(){
  console.log('\n######## 13. Completed match in the Scorecard — cricket-scorecard.html ########');
  const S = boot('cricket-scorecard.html', 'https://example.test/cricket-scorecard.html?room=T1', w => { w.firebase = deep(); });
  await sleep(80);
  const rec = fixtures.so.record;
  S.E(`finalBallLog = ${JSON.stringify(fixtures.so.state.ballLog)}; renderFinalSnapshot(${JSON.stringify(rec)}, 'IPL');`);
  const card = S.text('#match-result-card');
  eq('13 result card: main match, then tie, then Super Over, then winner — in that order', (() => {
    const i = ['MAIN MATCH', 'MATCH TIED', 'SUPER OVER', 'FINAL RESULT', 'MI WON THE SUPER OVER BY 2 WICKETS'].map(t => card.toUpperCase().indexOf(t));
    return i.every((x, k) => x > -1 && (k === 0 || x > i[k - 1]));
  })(), true);
  eq('13 result card keeps BOTH regulation totals', (card.match(/280\/0/g) || []).length, 2);
  eq('13 result card shows both Super Over totals', [/14\/0/.test(card), /15\/0/.test(card)], [true, true]);
  eq('13 Super Over scorecard: its own section, two innings', [S.E(`document.getElementById('so-scorecard').hidden`), S.E(`document.querySelectorAll('#so-scorecard .so-inn').length`)], [false, 2]);
  eq('13 hero keeps the main-match score with the Super Over as an extra line', [/280-0/.test(S.text('#prev-score-a')), /SO 15\/0/.test(S.text('#prev-score-a')), /SO 14\/0/.test(S.text('#prev-score-b'))], [true, true, true]);
  eq('13 header never computes a margin from the tied scores', /won by 0|by 10 wickets/i.test(S.text('#main-score')), false);
  S.E(`document.querySelector('#final-innings-toggle button[data-team="B"]').click()`);
  const bat2 = S.text('#batting-table-body');
  eq('13 2nd innings table is the regulation innings (no Super Over batter)', [/Virat Kohli/.test(bat2), /146/.test(bat2), /Glenn Maxwell/.test(bat2)], [true, true, false]);

  // A normal match: result card, no Super Over section.
  S.E(`finalMatchData = null; finalBallLog = []; renderFinalSnapshot(${JSON.stringify(fixtures.normal.record)}, 'IPL');`);
  eq('13 normal match: result card shown, NO Super Over section', [S.E(`document.getElementById('match-result-card').hidden`), S.E(`document.getElementById('so-scorecard').hidden`), /SUPER OVER/i.test(S.text('#match-result-card'))], [false, true, false]);
  eq('13 normal match: margin in the header', /won by 10 wickets/i.test(S.text('#main-score')), true);

  // Live, mid Super Over: regulation tables stay regulation.
  S.E(`finalMatchData = null; latestState = ${JSON.stringify(fixtures.so.soLive)}; render();`);
  eq('13 live Super Over: status + badge', [/Super Over 1/.test(S.text('#chip-status-text')), /SUPER OVER 1/i.test(S.text('#batting-tag'))], [true, true]);
  eq('13 live Super Over: the regulation 2nd innings is not touched by the live batters', [/Virat Kohli/.test(S.text('#batting-table-body')), /Rohit Sharma/.test(S.text('#batting-table-body'))], [true, false]);
  eq('13 live Super Over: chase maths use 6 balls', S.text('#target-need'), 'Need 8 off 4');
  eq('13 live Super Over: the live innings sits in the Super Over section', [S.E(`document.querySelectorAll('#so-scorecard .so-inn').length`), /LIVE/.test(S.text('#so-scorecard'))], [2, true]);
  eq('13 NB shown as NB / NB+1 in the ball chips', S.E(`(latestState = ${JSON.stringify({ ...fixtures.so.soBreak, ballHistory: ['Nb', 'Nb+1', '4'] })}, _lastKey.balls = null, renderBalls(latestState), [...document.querySelectorAll('#balls-scroll .ball-chip')].map(e => e.textContent))`), ['NB', 'NB+1', '4']);
  eq('13 NB+4 commentary badge', S.E(`ballBadgeInfo({ ballType:'Nb', runs:5 }).label`), 'NB+4');
  eq('13 a first-ball NB (stored at 0.0) reads as ball 0.1', S.E(`overBallLabel(0, 'Nb')`), '0.1');
  eq('13 no script errors', S.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

async function overlaySuite(){
  console.log('\n######## 14. Completed match in the overlay — cricket-overlay.html ########');
  const O = boot('cricket-overlay.html', 'https://example.test/cricket-overlay.html?room=T1', w => { w.gsap = deep(); });
  await sleep(80);
  O.E(`renderState(${JSON.stringify(fixtures.so.soLive)})`);
  eq('14 live Super Over: SUPER OVER badge on', [O.E(`document.getElementById('so-badge').style.display !== 'none'`), O.text('#so-badge')], [true, 'SUPER OVER']);
  O.E(`renderState(${JSON.stringify(fixtures.so.state)})`);
  eq('14 completed: result strip carries the final result', O.text('#res-main'), 'MI WON THE SUPER OVER BY 2 WICKETS');
  eq('14 completed: regulation totals + Super Over line both present', [/MI 280\/0/.test(O.text('#res-sub')), /RCB 280\/0/.test(O.text('#res-sub')), /Super Over/.test(O.text('#res-sub')), /15\/0/.test(O.text('#res-sub'))], [true, true, true, true]);
  O.E(`renderMatchSummary(${JSON.stringify(fixtures.so.summary)})`);
  eq('14 match summary card: Super Over rows after the main match', O.E(`document.querySelectorAll('#ms-so-rows .ms-so-row').length`), 2);
  eq('14 NB labels on the overlay', [O.E(`ballTokenLabel('Nb')`), O.E(`ballTokenLabel('Nb+4')`), O.E(`ballTokenLabel('Nb+1')`)], ['NB', 'NB+4', 'NB+1']);
  O.E(`renderMatchSummary(${JSON.stringify({ ...fixtures.so.summary, superOver: null, regulationResult: null })})`);
  eq('14 no Super Over → no Super Over block on the summary', O.E(`document.getElementById('ms-so').hidden`), true);
  eq('14 no script errors', O.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

(async () => {
  await panelSuite('cricket-panel.html', 'Clipper panel');
  const clipperFixtures = JSON.stringify(fixtures);
  await panelSuite('cricket-panel3.html', 'Stream Engine panel');
  // Both panels must produce the same match from the same deliveries.
  const strip = (f) => JSON.stringify([f.so.record.scoreA, f.so.record.scoreB, f.so.record.superOver, f.so.record.resultText, f.normal.record.resultText]);
  eq('both panels: identical results for the same deliveries', strip(fixtures), strip(JSON.parse(clipperFixtures)));
  await scorecardSuite();
  await overlaySuite();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
