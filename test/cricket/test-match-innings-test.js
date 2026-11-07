// 🏏 A Test match on the website's scorecard: EVERY innings, each on its own.
//
// The bug: a finished Test opened from the website (Tournament → match →
// /cricket-scorecard?…&history=1, read from the saved match record) had only
// two innings tabs — one per TEAM — so the 3rd innings was nowhere, and a side
// that batted twice had both its innings mixed into one batting card. The
// same match opened from its live room link (/cricket-scorecard?room=…)
// showed all three, but still marked the finished last innings "· Live".
//
// Scored on the REAL panel (cricket-panel.html in jsdom), its REAL saved
// record (buildMatchRecordForLeague) and ball log, then fed to the REAL
// scorecard page:
//   1. 3 innings, side B in first, an innings win (the reported match):
//      3 tabs; each tab only its own innings' batters, bowlers, extras and
//      partnerships, with the right sides on the cards; the score header and
//      result card read "55/2 d & 7/1 d", not both innings added up
//   2. 4 innings, the chase wins — the match-ending innings is never archived:
//      its tab, its rows and its score still come out right
//   3. a record rebuilt by the server from the deliveries (archive without
//      extras, extras added up per side): each innings' extras from its own
//      deliveries
//   4. an older limited-overs record with no innings tags: the same two tabs
//   5. live room view of the finished Test: 3 tabs, no "· Live", and a past
//      innings shows its own extras
//
//   node test/cricket/test-match-innings-test.js     (npm install --no-save jsdom)
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
      w.crypto = w.crypto || {};
      if(!w.crypto.randomUUID) w.crypto.randomUUID = () => 'uuid-' + Math.random().toString(36).slice(2);
      if(extra) extra(w);
    }
  });
  return { w: dom.window, E: (c) => dom.window.eval(c), errors, $: (s) => dom.window.document.querySelector(s),
    text: (s) => { const el = dom.window.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; } };
}
const realErrors = (errs) => errs.filter(e => !/Could not parse CSS|Not implemented/.test(e));

/* ------------------------------------------------------------------ *
 * The panel: score a Test the way an operator does.
 * ------------------------------------------------------------------ */
function scorer(P){
  let n = 0;
  const batter = (side) => `{ name:'${side} Bat ${++n}', id:'${side}${n}', runs:0, balls:0, fours:0, sixes:0 }`;
  return {
    newTest(firstIn){
      n = 0;
      P.E(`
        state = mergeWithDefaults(null);
        state.format = 'Test';
        state.teamA.name = 'ANJUMAN - I - ISLAM ALLANA ENGLISH SCHOOL'; state.teamA.short = 'A-I-'; state.teamA.color = '#1d4ed8';
        state.teamB.name = 'GENERAL EDUCATION ACADEMY'; state.teamB.short = 'GEA'; state.teamB.color = '#475569';
        state.battingTeam = ${JSON.stringify(firstIn)};
        state.toss = { winner: ${JSON.stringify(firstIn === 'A' ? 'A' : 'A')}, decision: ${JSON.stringify(firstIn === 'A' ? 'BAT' : 'BOWL')} };
        history = [];
      `);
    },
    openInnings(side, bowler){
      P.E(`state.striker = ${batter(side)}; state.nonStriker = ${batter(side)};
           state.bowler = { name:${JSON.stringify(bowler)}, id:${JSON.stringify(bowler)}, overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };`);
    },
    balls(list, times){ P.E(`for(let i = 0; i < ${times}; i++){ if(state.milestonesHit['match-result']) break; recordBall(${JSON.stringify(list)}[i % ${list.length}]); }`); },
    wicket(side){ P.E(`recordBall('W', { dismissalType: 'Bowled' }); if(!isInningsOver() && !state.milestonesHit['match-result']) state.striker = ${batter(side)};`); },
    ball(kind, opts){ P.E(`recordBall(${JSON.stringify(kind)}${opts ? ', ' + JSON.stringify(opts) : ''})`); },
    declare(){ P.E(`state.declared = true; updateBallButtonsState(); document.getElementById('next-innings-btn').click();`); },
    snapshot(){ return JSON.parse(P.E(`JSON.stringify({ rec: buildMatchRecordForLeague(), state })`)); }
  };
}

async function main(){
  const P = boot(process.env.PANEL || 'cricket-panel.html', 'https://example.test/cricket-panel?room=TESTMATCH', w => { w.firebase = undefined; });
  P.w.document.dispatchEvent(new P.w.Event('DOMContentLoaded'));
  await sleep(60);
  const sc = scorer(P);

  // 1. The reported match: GEA (B) in first, A-I- (A) declare, GEA lose by an innings.
  sc.newTest('B');
  sc.openInnings('B', 'Aarav Yadav');
  sc.balls(['1', '4', '0', '2'], 30); sc.wicket('B'); sc.wicket('B'); sc.ball('Wd');
  sc.declare();
  sc.openInnings('A', 'Shamsuddin Mansebdar');
  sc.balls(['4', '6', '1', '0'], 60); sc.wicket('A'); sc.ball('Nb');
  sc.declare();
  sc.openInnings('B', 'Rajveersinh Surve');
  sc.balls(['1', '0'], 12); sc.wicket('B'); sc.ball('LB', { runs: 1 });
  sc.declare();
  const m1 = sc.snapshot();
  eq('panel: an innings win after the 3rd innings, all three archived', [m1.rec.winningTeam, m1.rec.inningsArchive.map(i => [i.no, i.team])], ['A', [[1, 'B'], [2, 'A'], [3, 'B']]]);
  eq('panel: side B batted twice — its record total adds both innings (what the header used to show)', [m1.rec.scoreB.runs, m1.rec.scoreB.wickets], [62, 1]);

  // 2. Four innings: A in first, B, A again, B chase and win — innings 4 never archived.
  sc.newTest('A');
  sc.openInnings('A', 'Bowler One');
  sc.balls(['2', '1', '0', '4'], 24); sc.wicket('A'); sc.declare();
  sc.openInnings('B', 'Bowler Two');
  sc.balls(['1', '0'], 18); sc.wicket('B'); sc.declare();
  sc.openInnings('A', 'Bowler Three');
  sc.balls(['1', '2'], 12); sc.wicket('A'); sc.ball('B', { runs: 2 }); sc.declare();
  sc.openInnings('B', 'Bowler Four');
  sc.balls(['6', '4', '1'], 60);
  const m2 = sc.snapshot();
  eq('panel: the chase wins in the 4th innings, which is not archived', [m2.rec.winningTeam, m2.rec.inningsArchive.length, m2.state.inningsNumber], ['B', 3, 4]);
  eq('no panel script errors', realErrors(P.errors), []);

  /* ---------------------------------------------------------------- *
   * The website's scorecard
   * ---------------------------------------------------------------- */
  const S = boot('cricket-scorecard.html', 'https://example.test/cricket-scorecard.html?room=T1', w => { w.firebase = deep(); });
  await sleep(80);
  const tabs = () => S.E(`[...document.querySelectorAll('#final-innings-toggle button')].map(b => b.textContent.trim())`);
  const pick = (n) => S.E(`document.querySelector('#final-innings-toggle button[data-inn="${n}"]').click()`);
  const names = (sel) => S.E(`[...document.querySelectorAll('${sel} tr')].map(tr => (tr.querySelector('td') || {}).firstChild).filter(Boolean).map(n => n.textContent.trim())`);
  const chips = () => [S.text('#batting-team-chip'), S.text('#bowling-team-chip')];
  const extras = () => ['ex-wd', 'ex-nb', 'ex-b', 'ex-lb', 'ex-total'].map(id => S.text('#' + id));
  const batOf = (rec, k, inn) => rec.battingCard[k].filter(r => r.inningsNo === inn).map(r => r.name).sort();
  const bowlOf = (rec, k, inn) => rec.bowlingCard[k].filter(r => r.inningsNo === inn).map(r => r.name).sort();
  const render = (m, balls) => S.E(`latestState = null; finalMatchData = null; finalBallLog = ${JSON.stringify(balls || [])}; renderFinalSnapshot(${JSON.stringify(m)}, 'Harris Shield 2026');`);

  console.log('\n=== 1. Three innings, side B in first, an innings win ===');
  const r1 = m1.rec;
  render(r1, m1.state.ballLog);
  eq('1 three innings tabs, not one per team', tabs(), ['1st Innings', '2nd Innings', '3rd Innings']);
  eq('1 opens on the 1st innings', S.text('#final-innings-toggle .active'), '1st Innings');
  eq('1 1st innings: only its own batters (not the 3rd innings\' too)', names('#batting-table-body').sort(), batOf(r1, 'B', 1));
  eq('1 1st innings: only its own bowlers', names('#bowling-table-body').sort(), bowlOf(r1, 'A', 1));
  eq('1 1st innings: GEA bat, A-I- bowl', chips(), ['GEA', 'A-I-']);
  eq('1 1st innings: its own extras (1 wide)', extras(), ['1', '0', '0', '0', 'Total extras: 1']);
  pick(2);
  eq('1 2nd innings: A-I- bat, GEA bowl', chips(), ['A-I-', 'GEA']);
  eq('1 2nd innings: its batters and bowlers', [names('#batting-table-body').sort(), names('#bowling-table-body').sort()], [batOf(r1, 'A', 2), bowlOf(r1, 'B', 2)]);
  eq('1 2nd innings: its extras (1 no ball)', extras(), ['0', '1', '0', '0', 'Total extras: 1']);
  pick(3);
  eq('1 3rd innings tab is there and active', S.text('#final-innings-toggle .active'), '3rd Innings');
  eq('1 3rd innings: GEA bat again, A-I- bowl', chips(), ['GEA', 'A-I-']);
  eq('1 3rd innings: only its own batters', names('#batting-table-body').sort(), batOf(r1, 'B', 3));
  eq('1 3rd innings: only its own bowler', names('#bowling-table-body').sort(), bowlOf(r1, 'A', 3));
  eq('1 3rd innings: its own extras (1 leg bye)', extras(), ['0', '0', '0', '1', 'Total extras: 1']);
  eq('1 3rd innings: its own partnerships', S.E(`document.querySelectorAll('#final-pship-list .fow-item').length`), (r1.partnerships[3] || []).length);
  const runsOf = (inn) => S.E(`[...document.querySelectorAll('#batting-table-body tr')].reduce((n, tr) => n + (Number((tr.querySelectorAll('td')[1] || {}).textContent) || 0), 0)`);
  eq('1 3rd innings: batters\' runs + extras = the innings total', runsOf(3) + 1, r1.inningsArchive[2].runs);
  eq('1 header: each innings, not both added up into "62-1"', [S.text('#prev-score-a'), S.text('#prev-score-b')], ['166/1 d', '55/2 d & 7/1 d']);
  eq('1 result card: the same lines', [/166\/1 d/.test(S.text('#match-result-card')), /55\/2 d & 7\/1 d/.test(S.text('#match-result-card'))], [true, true]);
  eq('1 result line', S.text('#main-score'), 'Won by an innings and 104 runs');
  // the 30s poll re-renders the same match: the viewer stays on their tab
  S.E(`renderFinalSnapshot(${JSON.stringify(r1)}, 'Harris Shield 2026')`);
  eq('1 a re-render of the same match keeps the 3rd innings on show', [S.text('#final-innings-toggle .active'), chips()], ['3rd Innings', ['GEA', 'A-I-']]);
  eq('1 fall of wickets has all three innings too', S.E(`[...document.querySelectorAll('#fow-innings button')].map(b => b.dataset.fowInn)`), ['1', '2', '3']);

  console.log('\n=== 2. Four innings, the chase wins (innings 4 not archived) ===');
  const r2 = m2.rec;
  render(r2, m2.state.ballLog);
  eq('2 four innings tabs', tabs(), ['1st Innings', '2nd Innings', '3rd Innings', '4th Innings']);
  pick(4);
  eq('2 4th innings: B chase, A bowl', chips(), ['GEA', 'A-I-']);
  eq('2 4th innings: its own batters and bowler', [names('#batting-table-body').sort(), names('#bowling-table-body').sort()], [batOf(r2, 'B', 4), bowlOf(r2, 'A', 4)]);
  const s2 = m2.state.score;
  eq('2 header: the unarchived chase innings is in the line, with its own score', S.text('#prev-score-b'),
    `${r2.inningsArchive[1].runs}/${r2.inningsArchive[1].wickets} d & ${s2.runs}/${s2.wickets}`);
  eq('2 result card: the chase innings too', S.text('#match-result-card').includes(`& ${s2.runs}/${s2.wickets}`), true);
  pick(3);
  eq('2 3rd innings: A bat again, its own extras (2 byes)', [chips(), extras()], [['A-I-', 'GEA'], ['0', '0', '2', '0', 'Total extras: 2']]);
  pick(1);
  eq('2 1st innings: only its own batters', names('#batting-table-body').sort(), batOf(r2, 'A', 1));
  eq('2 1st innings: no extras (the 3rd innings\' byes are not here)', extras(), ['0', '0', '0', '0', 'Total extras: 0']);

  console.log('\n=== 3. A record rebuilt by the server from the deliveries ===');
  // inningsArchiveFromBalls() keeps no extras; buildLiveCardsFromBallsArray()
  // adds a side's extras up over the whole match.
  const sum = (k) => ['wd', 'nb', 'b', 'lb', 'pen'].reduce((o, x) => ({ ...o, [x]: r1.inningsArchive.filter(i => i.team === k).reduce((n, i) => n + (i.extras[x] || 0), 0) }), {});
  const rebuilt = { ...r1, inningsArchive: r1.inningsArchive.map(({ extras, ...i }) => i), extras: { A: sum('A'), B: sum('B') } };
  render(rebuilt, m1.state.ballLog);
  eq('3 three tabs', tabs(), ['1st Innings', '2nd Innings', '3rd Innings']);
  eq('3 1st innings: its extras from its deliveries (1 wide, not the side\'s 2)', extras(), ['1', '0', '0', '0', 'Total extras: 1']);
  pick(3);
  eq('3 3rd innings: its extras from its deliveries (1 leg bye)', extras(), ['0', '0', '0', '1', 'Total extras: 1']);
  pick(2);
  eq('3 2nd innings (a side that batted once): the side\'s extras', extras(), ['0', '1', '0', '0', 'Total extras: 1']);

  console.log('\n=== 4. An older limited-overs record with no innings tags ===');
  const strip = (rows) => rows.map(({ inningsNo, ...r }) => r);
  const old = { format: 'T20', teamA: { name: 'Lions', short: 'LIO' }, teamB: { name: 'Tigers', short: 'TIG' }, winningTeam: 'A',
    scoreA: { runs: 150, wickets: 4, overs: '20.0' }, scoreB: { runs: 120, wickets: 9, overs: '20.0' },
    battingCard: { A: strip([{ name: 'Lion One', runs: 90, balls: 60, out: true, howOut: 'b Tiger Bowl' }, { name: 'Lion Two', runs: 50, balls: 60, out: false }]),
      B: strip([{ name: 'Tiger One', runs: 100, balls: 100, out: true, howOut: 'b Lion Bowl' }]) },
    bowlingCard: { A: strip([{ name: 'Lion Bowl', overs: 20, balls: 0, runs: 120, wickets: 9 }]), B: strip([{ name: 'Tiger Bowl', overs: 20, balls: 0, runs: 150, wickets: 4 }]) },
    extras: { A: { wd: 3, nb: 0, b: 0, lb: 0 }, B: { wd: 1, nb: 1, b: 0, lb: 0 } }, fallOfWickets: { A: [], B: [] } };
  render(old, []);
  eq('4 the same two tabs as always', tabs(), ['1st Innings', '2nd Innings']);
  eq('4 1st innings: team A\'s card, its extras', [names('#batting-table-body'), names('#bowling-table-body'), S.text('#ex-total')], [['Lion One', 'Lion Two'], ['Tiger Bowl'], 'Total extras: 3']);
  pick(2);
  eq('4 2nd innings: team B\'s card, its extras', [names('#batting-table-body'), names('#bowling-table-body'), S.text('#ex-total')], [['Tiger One'], ['Lion Bowl'], 'Total extras: 2']);
  eq('4 a limited-overs header keeps its score + overs', S.text('#prev-score-a'), '150-4(20.0 ov)');

  console.log('\n=== 5. The live room view of the finished Test ===');
  S.E(`finalMatchData = null; liveSelectedInnings = null; latestState = ${JSON.stringify(m1.state)}; render();`);
  const liveTabs = () => S.E(`[...document.querySelectorAll('#live-innings-toggle button')].map(b => b.textContent.trim())`);
  eq('5 three tabs, the finished last innings not marked "· Live"', liveTabs(), ['1st Innings', '2nd Innings', '3rd Innings']);
  S.E(`document.querySelector('#live-innings-toggle button[data-inn="1"]').click()`);
  eq('5 1st innings: its own extras (not the 3rd innings\' leg bye)', [S.text('#ex-wd'), S.text('#ex-lb'), S.text('#ex-total')], ['1', '0', 'Total extras: 1']);
  // …while a match is still being played the innings at the crease IS live
  S.E(`liveSelectedInnings = null; latestState = ${JSON.stringify({ ...m2.state, milestonesHit: {}, matchResultText: null, matchWinnerKey: null })}; render();`);
  eq('5 a Test still in play: its current innings is "· Live"', liveTabs().slice(-1), ['4th Innings · Live']);

  eq('no scorecard script errors', realErrors(S.errors), []);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
