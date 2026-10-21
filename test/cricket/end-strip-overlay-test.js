// Innings-break / match-result strip on the overlay (cricket-overlay.html):
// what the white panel says when an innings or the match ends, in every
// format the panels score — read from the state the panel sends, never
// guessed from the score — and that the reveal plays once, not on every
// update or a refresh of the same match.
//
//   node test/cricket/end-strip-overlay-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Stand-in for GSAP: any property, any call.
function deep(){
  return new Proxy(function(){}, {
    get: (t, k) => k === Symbol.toPrimitive ? (() => 0) : (k === 'then' ? undefined : deep()),
    apply: () => deep()
  });
}
function boot(extra){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', 'cricket-overlay.html'), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-overlay.html?room=END1', virtualConsole: vc,
    beforeParse(w){
      w.gsap = deep();
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){}, io: { on(){} } });
      w.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      w.ResizeObserver = w.ResizeObserver || class { observe(){} unobserve(){} disconnect(){} };
      if(extra) extra(w);
    }
  });
  const w = dom.window;
  const text = (s) => { const el = w.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; };
  const shown = (id) => w.document.getElementById(id).style.display !== 'none';
  return { w, E: (c) => w.eval(c), errors, text, shown, render: (s) => w.eval(`renderState(${JSON.stringify(s)})`) };
}

const DYP = { name: 'D Y Patil S A', short: 'DYP', color: '#1d4ed8', logoUrl: '' };
const PSC = { name: 'Parel Sporting Club', short: 'PSC', color: '#f5c518', logoUrl: '' };
function st(over){
  return Object.assign({
    visible: true, format: 'T20', oversPerInnings: 20, phase: 'REGULATION', inningsNumber: 1, battingTeam: 'A',
    teamA: DYP, teamB: PSC, theme: {},
    score: { runs: 0, wickets: 0, overs: 0, balls: 0 },
    striker: { name: 'Jee', id: 'a1', runs: 0, balls: 0 }, nonStriker: { name: 'Jeethyiy', id: 'a2', runs: 0, balls: 0 },
    bowler: { name: 'Chhaya Suvarna', id: 'b1', overs: 0, balls: 0, runs: 0, wickets: 0 },
    thisOver: [], milestonesHit: {}, target: null, inningsArchive: [], dismissedThisInnings: { A: [], B: [] }
  }, over);
}
const FIRST = { no: 1, team: 'A', runs: 241, wickets: 2, overs: '20.0' };
// what the white panel shows
function panel(O){
  return { live: O.shown('live-segs'), brk: O.shown('break-seg'), res: O.shown('result-seg') };
}
function breakText(O){
  const item = (k) => O.w.document.getElementById(`break-item-${k}`).hidden ? null
    : [O.text(`#break-${k}-lbl`), O.text(k === 'a' ? '#break-target' : '#break-rrr'), O.text(`#break-${k}-unit`)];
  return { kicker: O.text('#break-kicker'), title: O.text('#break-title'), a: item('a'), b: item('b') };
}
function resultText(O){
  return { kicker: O.text('#res-kicker'), main: O.text('#res-main'), sub: O.text('#res-sub'), outcome: O.w.document.getElementById('result-seg').dataset.outcome };
}

async function limitedOvers(){
  console.log('\n######## Limited overs: innings break, chase, results ########');
  const O = boot();
  await sleep(50);

  // The screenshot: DYP 241-2 after their 20 overs, next innings not started.
  O.render(st({ score: { runs: 241, wickets: 2, overs: 20, balls: 0 }, milestonesHit: { 'innings-complete': true } }));
  eq('break: the white panel shows the break strip, not the live batters', panel(O), { live: false, brk: true, res: false });
  eq('break: headline, target = runs + 1, chaser and overs, required rate',
    breakText(O), { kicker: 'END OF 1ST INNINGS', title: 'INNINGS BREAK', a: ['Target', '242', 'PSC · 20 overs'], b: ['Req. Run Rate', '12.10', 'per over'] });
  eq('break: the score is not repeated in the strip (it is in the score block)', [O.E(`document.getElementById('break-score')`), O.text('#score-row')], [null, '241-2']);
  eq('break: the strip is revealed once', O.E('endStripRevealCount'), 1);
  O.render(st({ score: { runs: 241, wickets: 2, overs: 20, balls: 0 }, milestonesHit: { 'innings-complete': true }, theme: { badgeColor: '#ff0000' } }));
  eq('break: a later update of the same break does not reveal it again', O.E('endStripRevealCount'), 1);

  // All out in a 10-wicket T20.
  O.render(st({ score: { runs: 133, wickets: 10, overs: 17, balls: 4 } }));
  eq('all out: reason in the headline, target 134, rate 6.70', breakText(O), { kicker: 'END OF 1ST INNINGS · ALL OUT', title: 'INNINGS BREAK', a: ['Target', '134', 'PSC · 20 overs'], b: ['Req. Run Rate', '6.70', 'per over'] });

  // Not over yet: 9 down in the 20th over → live strip, no break.
  O.render(st({ score: { runs: 150, wickets: 9, overs: 19, balls: 5 } }));
  eq('9 down at 19.5: still the live strip (no false break)', panel(O), { live: true, brk: false, res: false });
  // The panel's all-out rule: a batter absent hurt this innings makes 9 down all out.
  O.render(st({ score: { runs: 150, wickets: 9, overs: 19, balls: 5 }, absentHurt: [{ team: 'A', inn: 1, name: 'Hurt' }] }));
  eq('9 down with one absent hurt: all out → break', [panel(O).brk, O.text('#break-kicker')], [true, 'END OF 1ST INNINGS · ALL OUT']);
  O.render(st({ score: { runs: 150, wickets: 9, overs: 19, balls: 5 }, absentHurt: [{ team: 'B', inn: 1, name: 'Hurt' }] }));
  eq('absent hurt on the OTHER side does not end this innings', panel(O).brk, false);
  // A match's custom wicket limit applies in any format (panel: matchRules).
  O.render(st({ customMaxWickets: 7, score: { runs: 98, wickets: 7, overs: 12, balls: 1 } }));
  eq('7-wicket match: 7 down is all out → break', [panel(O).brk, O.text('#break-target')], [true, '99']);
  // Custom overs: 8-over match, target / 8.
  O.render(st({ format: 'Custom', oversPerInnings: 8, score: { runs: 77, wickets: 4, overs: 8, balls: 0 } }));
  eq('8-over custom match: target and rate over 8 overs', breakText(O).a.concat(breakText(O).b), ['Target', '78', 'PSC · 8 overs', 'Req. Run Rate', '9.75', 'per over']);

  // The chase starts: the break goes, the live strip shows what is needed.
  const chase = { inningsNumber: 2, battingTeam: 'B', target: 242, inningsArchive: [FIRST], striker: { name: 'Himesh', id: 'p1', runs: 40, balls: 30 }, nonStriker: { name: 'Raj', id: 'p2', runs: 20, balls: 18 } };
  O.render(st({ ...chase, score: { runs: 100, wickets: 3, overs: 12, balls: 0 } }));
  eq('chase: live strip back, break strip gone', panel(O), { live: true, brk: false, res: false });
  eq('chase: target 242, need 142 from 48 balls, required rate 17.75',
    [O.text('#ch-target'), O.text('#ch-need'), O.text('#ch-balls'), O.text('#ch-balls-w'), O.text('#rrr-val'), O.shown('crr-seg')], ['242', '142', '48', 'BALLS', '17.75', true]);

  // Target reached, but the panel has not called the result: the overlay does not either.
  O.render(st({ ...chase, score: { runs: 242, wickets: 5, overs: 19, balls: 2 } }));
  eq('target reached without the panel\'s result flag: no result shown', panel(O), { live: true, brk: false, res: false });

  // Successful chase.
  O.render(st({ ...chase, score: { runs: 243, wickets: 5, overs: 19, balls: 2 }, milestonesHit: { 'match-result': true }, matchResultText: 'PSC WON BY 5 WICKETS', matchWinnerKey: 'B' }));
  eq('chase won: result strip', panel(O), { live: false, brk: false, res: true });
  eq('chase won: result line, winner named in full, both totals',
    resultText(O), { kicker: 'RESULT · PAREL SPORTING CLUB', main: 'PSC WON BY 5 WICKETS', sub: 'DYP 241/2 (20.0) · PSC 243/5 (19.2)', outcome: 'win' });
  eq('chase won: the winner\'s colour on the badge; a readable dark version for the kicker',
    [O.E(`document.getElementById('result-seg').style.getPropertyValue('--res-accent')`), O.E(`document.getElementById('result-seg').style.getPropertyValue('--res-accent-text')`) !== '#f5c518', O.E(`document.getElementById('res-badge').dataset.icon`)],
    ['#f5c518', true, 'trophy']);
  eq('chase won: no stale chase figures (target segment off)', O.shown('crr-seg'), false);
  eq('chase won: revealed once (2nd strip of this match)', O.E('endStripRevealCount'), 2);
  O.render(st({ ...chase, score: { runs: 243, wickets: 5, overs: 19, balls: 2 }, milestonesHit: { 'match-result': true }, matchResultText: 'PSC WON BY 5 WICKETS', matchWinnerKey: 'B' }));
  eq('chase won: the same result again does not replay', O.E('endStripRevealCount'), 2);
  // A browser-source refresh: the page forgets everything but its session storage.
  O.E('endStripSeenMem.clear(); endStripKey = null; endStripText = null;');
  O.render(st({ ...chase, score: { runs: 243, wickets: 5, overs: 19, balls: 2 }, milestonesHit: { 'match-result': true }, matchResultText: 'PSC WON BY 5 WICKETS', matchWinnerKey: 'B' }));
  eq('refresh of the same match: shown, not replayed', [panel(O).res, O.E('endStripRevealCount')], [true, 2]);

  // Defended: the side batting first wins by runs.
  O.render(st({ ...chase, tournamentMatchId: 'M2', score: { runs: 199, wickets: 10, overs: 18, balls: 3 }, milestonesHit: { 'match-result': true }, matchResultText: 'DYP WON BY 42 RUNS', matchWinnerKey: 'A' }));
  eq('defended: result line and totals', resultText(O), { kicker: 'RESULT · D Y PATIL S A', main: 'DYP WON BY 42 RUNS', sub: 'DYP 241/2 (20.0) · PSC 199/10 (18.3)', outcome: 'win' });
  eq('defended: DYP colour', O.E(`document.getElementById('result-seg').style.getPropertyValue('--res-accent')`), '#1d4ed8');
  eq('another match\'s result is revealed', O.E('endStripRevealCount'), 3);

  // Tied, Super Over to follow: NOT a result.
  O.render(st({ ...chase, tournamentMatchId: 'M3', score: { runs: 200, wickets: 4, overs: 15, balls: 0 } }));
  eq('M3 chase on: Target segment showing', O.shown('crr-seg'), true);
  O.render(st({ ...chase, tournamentMatchId: 'M3', score: { runs: 241, wickets: 6, overs: 20, balls: 0 }, superOverReady: true, matchResultText: null, matchWinnerKey: null }));
  eq('tie, Super Over to follow: said as exactly that',
    resultText(O), { kicker: 'SCORES LEVEL', main: 'MATCH TIED', sub: 'Super Over to follow | DYP 241/2 (20.0) · PSC 241/6 (20.0)', outcome: 'tie-pending' });
  eq('tie, Super Over to follow: no stale "need 1 off 0" (live strip and target segment off)', [panel(O).live, O.shown('crr-seg')], [false, false]);

  // Tie accepted as the result (or no Super Over in this competition).
  O.render(st({ ...chase, tournamentMatchId: 'M3', score: { runs: 241, wickets: 6, overs: 20, balls: 0 }, milestonesHit: { 'match-result': true }, matchResultText: 'MATCH TIED', matchWinnerKey: 'TIE' }));
  eq('tie as the result', resultText(O), { kicker: 'RESULT', main: 'MATCH TIED', sub: 'DYP 241/2 (20.0) · PSC 241/6 (20.0)', outcome: 'level' });

  // Decided with no result line.
  O.render(st({ ...chase, tournamentMatchId: 'M4', score: { runs: 120, wickets: 4, overs: 14, balls: 0 }, milestonesHit: { 'match-result': true }, matchResultText: null, matchWinnerKey: null }));
  eq('decided, no result line: MATCH COMPLETE, no kicker', [resultText(O).main, resultText(O).kicker, resultText(O).outcome], ['MATCH COMPLETE', '', 'complete']);

  eq('no script errors', O.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

async function superOver(){
  console.log('\n######## Super Over ########');
  const O = boot();
  await sleep(50);
  const regulation = [{ no: 1, team: 'A', runs: 280, wickets: 0, overs: '20.0' }, { no: 2, team: 'B', runs: 280, wickets: 0, overs: '20.0' }];
  // First Super Over innings over, operator has not started the second yet.
  O.render(st({ phase: 'SUPER_OVER', inningsArchive: regulation, battingTeam: 'B', superOver: { number: 1, inningsIndex: 0, archive: [] }, superOverRules: { ballsPerInnings: 6, maxWickets: 2 },
    score: { runs: 14, wickets: 1, overs: 1, balls: 0 } }));
  eq('Super Over break: target off 6 balls, 2 wickets', breakText(O), { kicker: 'SUPER OVER', title: 'INNINGS BREAK', a: ['Target', '15', 'DYP to win'], b: ['Super Over', '6', 'balls · 2 wickets'] });
  // Super Over tied, another to follow.
  const soArch = [{ number: 1, team: 'B', runs: 14, wickets: 0 }, { number: 1, team: 'A', runs: 14, wickets: 1 }];
  O.render(st({ phase: 'SUPER_OVER', inningsArchive: regulation, battingTeam: 'A', target: 15, superOverReady: true, superOverDecided: true, superOver: { number: 1, inningsIndex: 1, archive: soArch }, superOverRules: { ballsPerInnings: 6, maxWickets: 2 },
    score: { runs: 14, wickets: 1, overs: 1, balls: 0 } }));
  eq('Super Over tied: another to follow, not a result', resultText(O), { kicker: 'SCORES LEVEL', main: 'SUPER OVER TIED', sub: 'Super Over 2 to follow | PSC 14/0 · DYP 14/1', outcome: 'tie-pending' });
  eq('Super Over tied: no chase figures', O.shown('crr-seg'), false);
  // Decided in Super Over 2.
  const soArch2 = soArch.concat([{ number: 2, team: 'B', runs: 9, wickets: 1 }, { number: 2, team: 'A', runs: 10, wickets: 0 }]);
  O.render(st({ phase: 'SUPER_OVER', inningsArchive: regulation, battingTeam: 'A', target: 10, superOver: { number: 2, inningsIndex: 1, archive: soArch2 }, superOverRules: { ballsPerInnings: 6, maxWickets: 2 },
    score: { runs: 10, wickets: 0, overs: 0, balls: 4 }, milestonesHit: { 'match-result': true }, matchResultText: 'DYP WON THE SUPER OVER BY 2 WICKETS', matchWinnerKey: 'A' }));
  eq('Super Over decided: result, regulation totals and the deciding Super Over',
    resultText(O), { kicker: 'RESULT · SUPER OVER', main: 'DYP WON THE SUPER OVER BY 2 WICKETS', sub: 'Tied DYP 280/0 (20.0) · PSC 280/0 (20.0) | Super Over 2: PSC 9/1 · DYP 10/0', outcome: 'win' });
  eq('Super Over decided: the bar keeps the regulation score', O.text('#score-row'), '280-0');
  eq('no script errors', O.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

async function testMatch(){
  console.log('\n######## Test match: innings breaks are not the match end ########');
  const O = boot();
  await sleep(50);
  const T = (o) => st({ format: 'Test', oversPerInnings: null, ...o });
  O.render(T({ score: { runs: 350, wickets: 10, overs: 98, balls: 3 } }));
  eq('Test, 1st innings all out: who bats next, nothing compared yet',
    breakText(O), { kicker: 'END OF 1ST INNINGS · ALL OUT', title: 'INNINGS BREAK', a: ['Next to bat', 'PSC', '2nd innings'], b: null });
  O.render(T({ score: { runs: 350, wickets: 5, overs: 98, balls: 3 } }));
  eq('Test, 5 down after 98 overs: no overs limit, still batting', panel(O), { live: true, brk: false, res: false });
  const i1 = { no: 1, team: 'A', runs: 350, wickets: 10, overs: '98.3' };
  O.render(T({ inningsNumber: 2, battingTeam: 'B', inningsArchive: [i1], score: { runs: 300, wickets: 10, overs: 80, balls: 0 } }));
  eq('Test, end of 2nd innings: the first-innings lead', breakText(O), { kicker: 'END OF 2ND INNINGS · ALL OUT', title: 'INNINGS BREAK', a: ['DYP lead by', '50', 'runs'], b: null });
  const i2 = { no: 2, team: 'B', runs: 300, wickets: 10, overs: '80.0' };
  O.render(T({ inningsNumber: 3, battingTeam: 'A', inningsArchive: [i1, i2], declared: true, score: { runs: 200, wickets: 5, overs: 50, balls: 0 } }));
  eq('Test, 3rd innings declared: the 4th-innings target (lead + 1)', breakText(O), { kicker: 'END OF 3RD INNINGS · DECLARED', title: 'INNINGS BREAK', a: ['Target', '251', 'PSC to win'], b: null });
  // Follow-on: PSC bat 2nd and 3rd and still trail after the 3rd — an innings
  // defeat, but the panel calls it at "Start Next Innings", so no result yet.
  const fo1 = { no: 1, team: 'A', runs: 450, wickets: 10, overs: '120.0' }, fo2 = { no: 2, team: 'B', runs: 200, wickets: 10, overs: '60.0' };
  O.render(T({ inningsNumber: 3, battingTeam: 'B', inningsArchive: [fo1, fo2], score: { runs: 150, wickets: 10, overs: 50, balls: 0 } }));
  eq('Test, follow-on side still behind after the 3rd innings: the lead, no result claimed',
    [breakText(O).a, panel(O)], [['DYP lead by', '100', 'runs'], { live: false, brk: true, res: false }]);
  O.render(T({ inningsNumber: 3, battingTeam: 'B', inningsArchive: [fo1, fo2, { no: 3, team: 'B', runs: 150, wickets: 10, overs: '50.0' }], score: { runs: 150, wickets: 10, overs: 50, balls: 0 },
    milestonesHit: { 'match-result': true }, matchResultText: 'DYP WON BY AN INNINGS AND 100 RUNS', matchWinnerKey: 'A' }));
  eq('Test, innings win (called by the panel): result with both sides\' innings',
    resultText(O), { kicker: 'RESULT · D Y PATIL S A', main: 'DYP WON BY AN INNINGS AND 100 RUNS', sub: 'DYP 450 · PSC 200 & 150', outcome: 'win' });
  const i3 = { no: 3, team: 'A', runs: 200, wickets: 5, overs: '50.0', declared: true };
  O.render(T({ inningsNumber: 4, battingTeam: 'B', target: 251, inningsArchive: [i1, i2, i3], score: { runs: 120, wickets: 3, overs: 40, balls: 0 },
    milestonesHit: { 'match-result': true }, matchResultText: 'MATCH DRAWN', matchWinnerKey: 'DRAW' }));
  eq('Test drawn: result with every innings, a declaration marked d',
    resultText(O), { kicker: 'RESULT', main: 'MATCH DRAWN', sub: 'DYP 350 & 200/5d · PSC 300 & 120/3', outcome: 'level' });
  eq('no script errors', O.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

async function creaseAndMotion(){
  console.log('\n######## The out batter\'s slot; reduced motion; storage blocked ########');
  const O = boot();
  await sleep(50);
  // The wicket is recorded; the panel keeps the out batter in his slot until
  // the next batter is sent in.
  O.render(st({ score: { runs: 12, wickets: 2, overs: 14, balls: 0 }, striker: { name: 'Jee', id: 'a1', runs: 7, balls: 9 }, nonStriker: { name: 'Jeethyiy', id: 'a2', runs: 4, balls: 3 }, dismissedThisInnings: { A: ['a1'], B: [] } }));
  eq('out batter\'s slot reads empty: no name, no runs, no balls, no strike star',
    [O.text('#striker-name'), O.E(`document.getElementById('striker-runs').firstChild.textContent`), O.text('#striker-balls'), O.E(`document.getElementById('striker-star').style.display`)], ['—', '', '', 'none']);
  eq('the not-out batter is unchanged', [O.text('#nonstriker-name'), O.text('#nonstriker-runs'), O.text('#nonstriker-balls')], ['Jeethyiy', '4', '3']);
  O.render(st({ score: { runs: 12, wickets: 2, overs: 14, balls: 0 }, striker: { name: 'Himesh', id: 'a5', runs: 0, balls: 0 }, nonStriker: { name: 'Jeethyiy', id: 'a2', runs: 4, balls: 3 }, dismissedThisInnings: { A: ['a1'], B: [] } }));
  eq('the new batter sent in: name, 0, strike star back', [O.text('#striker-name'), O.E(`document.getElementById('striker-runs').firstChild.textContent`), O.E(`document.getElementById('striker-star').style.display`)], ['Himesh', '0', '']);
  // Decided by id only — a different player with the same name stays in.
  O.render(st({ striker: { name: 'Jee', id: 'a9', runs: 3, balls: 2 }, dismissedThisInnings: { A: ['a1'], B: [] } }));
  eq('same name, different player: shown', [O.text('#striker-name'), O.E(`document.getElementById('striker-runs').firstChild.textContent`)], ['Jee', '3']);
  O.render(st({ striker: { name: 'Jee', id: null, runs: 3, balls: 2 }, dismissedThisInnings: { A: ['a1'], B: [] } }));
  eq('batter with no id: shown as before', O.text('#striker-name'), 'Jee');

  // Reduced motion: still shown, revealed by a plain fade.
  const R = boot(w => { w.matchMedia = () => ({ matches: true, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }); });
  await sleep(50);
  R.render(st({ score: { runs: 241, wickets: 2, overs: 20, balls: 0 } }));
  eq('reduced motion: break strip shown and revealed once', [R.shown('break-seg'), R.E('endStripRevealCount')], [true, 1]);
  eq('reduced motion: no script errors', R.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);

  // Session storage blocked (private window / locked-down browser source):
  // the page still never replays within itself.
  const S = boot(w => { Object.defineProperty(w, 'sessionStorage', { get(){ throw new Error('blocked'); } }); });
  await sleep(50);
  const done = st({ inningsNumber: 2, battingTeam: 'B', target: 242, inningsArchive: [FIRST], score: { runs: 243, wickets: 5, overs: 19, balls: 2 }, milestonesHit: { 'match-result': true }, matchResultText: 'PSC WON BY 5 WICKETS', matchWinnerKey: 'B' });
  S.render(done); S.render(done); S.render({ ...done, theme: { badgeColor: '#00ff00' } });
  eq('storage blocked: result shown, revealed once', [S.shown('result-seg'), S.text('#res-main'), S.E('endStripRevealCount')], [true, 'PSC WON BY 5 WICKETS', 1]);
  eq('storage blocked: no script errors', S.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
  eq('no script errors', O.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

(async () => {
  await limitedOvers();
  await superOver();
  await testMatch();
  await creaseAndMotion();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
