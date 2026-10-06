// EXTRAS: No Ball / Wide / Penalty with any number of runs ("+"), BOUNDARY vs
// RUNNING on a 4 / 6, No Ball runs From bat / Bye / Leg bye — on BOTH panels
// through the real picker, then the same deliveries rebuilt by the server.
//
//   node test/cricket/extras-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const H = require('./server-harness.js');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function boot(file){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const emits = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=XT', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(ev, payload, ack){ emits.push({ ev, payload }); if(typeof ack === 'function') ack({ ok: true }); }, connected: true, disconnect(){}, io: { on(){} } });
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
    }
  });
  const w = dom.window;
  return { w, errors, emits, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)], J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)),
    text: (s) => { const el = w.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; } };
}
const click = (P, sel) => { const el = typeof sel === 'string' ? P.$(sel) : sel; if(!el) throw new Error('no element ' + sel); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
function fresh(P){
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A';
    document.getElementById('match-id').value = 'XT';
    state.teamA.players = ['Rohit','Ishan','Surya'].map((n, i) => ({ id: 'a' + (i + 1), name: n, isXI: true }));
    state.teamB.players = [{ id:'m1', name:'Mukesh', isXI:true }];
    state.striker    = { name:'Rohit', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan', id:'a2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Mukesh', id:'m1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = []; window.__clips = [];
    if(typeof sendClipToHelper === 'function') sendClipToHelper = (r) => window.__clips.push(r);
    renderPanel();
  `);
  P.emits.length = 0;
}
// Score an extra through the picker: { kind, as, runs | custom, bnd: 'boundary'|'running' }
function extra(P, o){
  P.E(`openExtrasModal(${JSON.stringify(o.kind)})`);
  if(o.as) click(P, `[data-xm-as="${o.as}"]`);
  if(o.custom != null){
    click(P, '[data-xm-runs="custom"]');
    P.$('#xm-custom-input').value = String(o.custom);
    click(P, '[data-xm-apply]');
  } else click(P, `[data-xm-runs="${o.runs}"]`);
  if(o.bnd){ click(P, `[data-xm-bnd="${o.bnd === 'boundary' ? 1 : 0}"]`); click(P, '[data-xm-go]'); }
}
const S = (P) => P.J(`{ team: state.score.runs, legal: state.score.overs * 6 + state.score.balls, wd: state.extras.A.wd, nb: state.extras.A.nb, b: state.extras.A.b, lb: state.extras.A.lb,
  batRuns: state.striker.runs + state.nonStriker.runs, fours: state.striker.fours + state.nonStriker.fours, sixes: state.striker.sixes + state.nonStriker.sixes, faced: state.striker.balls + state.nonStriker.balls, bowler: state.bowler.runs }`);
const lastDb = (P) => { const e = P.emits.filter(x => x.ev === 'logBall').slice(-1)[0]; return e ? e.payload : null; };
const clips = (P) => P.J('window.__clips || []').map(c => c.eventType);

async function suite(file, label, isClipper){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file);
  await sleep(80);
  const L = s => `${label}: ${s}`;

  console.log('\n=== the picker ===');
  fresh(P);
  P.E(`openExtrasModal('Nb')`);
  eq(L('No ball: From bat / Bye / Leg bye, NB + 0…6 and "+"'), [P.$$('[data-xm-as]').map(b => b.textContent), P.$$('#extras-modal-options [data-xm-runs]').map(b => b.textContent)],
    [['From bat', 'Bye', 'Leg bye'], ['NB + 0', 'NB + 1', 'NB + 2', 'NB + 3', 'NB + 4', 'NB + 5', 'NB + 6', '+']]);
  eq(L('title says the penalty'), P.text('#extras-modal-title'), 'No ball (NB = 1)');
  click(P, '[data-xm-runs="4"]');
  eq(L('NB + 4 asks Boundary or Running (Boundary pre-selected), nothing recorded yet'), [P.$('[data-xm-bnd]').closest('.xm-row').hidden, P.$('[data-xm-bnd="1"]').classList.contains('on'), P.E('state.ballLog.length'), P.text('[data-xm-go]')], [false, true, 0, 'Save NB + 4 · Boundary']);
  click(P, '#extras-modal-cancel');
  P.E(`openExtrasModal('Nb')`);
  eq(L('Boundary / Running is on the screen from the start'), [P.$('[data-xm-bnd]').closest('.xm-row').hidden, P.$$('[data-xm-bnd].on').length], [false, 0]);
  click(P, '[data-xm-bnd="0"]');
  click(P, '[data-xm-runs="4"]');
  eq(L('Running chosen first, then NB + 4 → saved at once as running, not a four'), [P.E('state.ballLog.length'), P.J('state.ballLog[0].boundary'), P.E('state.striker.fours + state.nonStriker.fours')], [1, false, 0]);
  fresh(P);
  P.E(`openExtrasModal('Wd')`);
  eq(L('Wide: WD + 0…6 and "+"'), P.$$('#extras-modal-options [data-xm-runs]').map(b => b.textContent), ['WD + 0', 'WD + 1', 'WD + 2', 'WD + 3', 'WD + 4', 'WD + 5', 'WD + 6', '+']);
  // custom validation
  click(P, '[data-xm-runs="custom"]');
  const tryCustom = (v) => { const i = P.$('#xm-custom-input'); i.value = v; click(P, '[data-xm-apply]'); return P.text('.xm-err'); };
  eq(L('"+": empty, letters, negative, decimal are refused with a message'), [tryCustom(''), tryCustom('abc'), tryCustom('-3'), tryCustom('2.5'), tryCustom('0'), P.E('state.ballLog.length')],
    ['Enter the number of runs', 'Enter the number of runs', 'Runs must be a whole number — no letters, signs or decimals', 'Runs must be a whole number — no letters, signs or decimals', 'Runs must be 1 or more', 0]);
  click(P, '#extras-modal-cancel');

  console.log('\n=== WIDE: any number, never the batter’s, never a legal ball ===');
  for(const n of [1, 10, 25, 100]){
    fresh(P);
    if(n === 1) extra(P, { kind: 'Wd', runs: 1 }); else extra(P, { kind: 'Wd', custom: n });
    eq(L(`WD + ${n}: team +${n + 1}, wides +${n + 1}, bowler +${n + 1}, batter 0, no ball faced, not legal`), S(P),
      { team: n + 1, legal: 0, wd: n + 1, nb: 0, b: 0, lb: 0, batRuns: 0, fours: 0, sixes: 0, faced: 0, bowler: n + 1 });
    eq(L(`WD + ${n}: to the database as a Wide of ${n + 1}, running`), [lastDb(P).kind, lastDb(P).runs, lastDb(P).boundary], ['Wd', n + 1, false]);
  }
  fresh(P);
  extra(P, { kind: 'Wd', runs: 4, bnd: 'boundary' });
  eq(L('WD + 4 BOUNDARY: 5 wides, stored as a boundary'), [S(P).wd, lastDb(P).boundary, P.J('state.ballLog[0].boundary')], [5, true, true]);
  if(isClipper) eq(L('WD + 4 BOUNDARY: a FOUR clip'), clips(P), ['FOUR']);
  fresh(P);
  extra(P, { kind: 'Wd', runs: 4, bnd: 'running' });
  eq(L('WD + 4 RUNNING: same 5 wides, stored as running, strike unchanged (4 run)'), [S(P).wd, lastDb(P).boundary, P.E('state.striker.name')], [5, false, 'Rohit']);
  if(isClipper) eq(L('WD + 4 RUNNING: no boundary clip'), clips(P), []);

  console.log('\n=== NO BALL: the penalty is never the batter’s ===');
  fresh(P);
  extra(P, { kind: 'Nb', runs: 1 });
  eq(L('NB + 1: team +2, batter +1 (1 ball), NB +1, bowler +2'), S(P), { team: 2, legal: 0, wd: 0, nb: 1, b: 0, lb: 0, batRuns: 1, fours: 0, sixes: 0, faced: 1, bowler: 2 });
  fresh(P);
  extra(P, { kind: 'Nb', runs: 4, bnd: 'boundary' });
  eq(L('NB + 4 BOUNDARY: team +5, batter +4 and a four, NB +1, bowler +5'), S(P), { team: 5, legal: 0, wd: 0, nb: 1, b: 0, lb: 0, batRuns: 4, fours: 1, sixes: 0, faced: 1, bowler: 5 });
  eq(L('NB + 4 BOUNDARY: stored as boundary, off the bat'), [lastDb(P).kind, lastDb(P).runs, lastDb(P).boundary, lastDb(P).nbRunsAs], ['Nb', 5, true, 'bat']);
  if(isClipper) eq(L('NB + 4 BOUNDARY: a FOUR clip'), clips(P), ['FOUR']);
  fresh(P);
  extra(P, { kind: 'Nb', runs: 4, bnd: 'running' });
  eq(L('NB + 4 RUNNING: same runs, but NOT a four'), S(P), { team: 5, legal: 0, wd: 0, nb: 1, b: 0, lb: 0, batRuns: 4, fours: 0, sixes: 0, faced: 1, bowler: 5 });
  eq(L('NB + 4 RUNNING: stored as running'), lastDb(P).boundary, false);
  if(isClipper) eq(L('NB + 4 RUNNING: no FOUR clip'), clips(P), []);
  fresh(P);
  extra(P, { kind: 'Nb', runs: 6, bnd: 'boundary' });
  eq(L('NB + 6 BOUNDARY: a six for the batter'), [S(P).batRuns, S(P).sixes, S(P).team], [6, 1, 7]);
  if(isClipper) eq(L('NB + 6 BOUNDARY: a SIX clip'), clips(P), ['SIX']);
  for(const n of [10, 25, 100]){
    fresh(P);
    extra(P, { kind: 'Nb', custom: n });
    eq(L(`NB + ${n} (custom): team +${n + 1}, batter +${n}, NB +1, still not a legal ball`), S(P), { team: n + 1, legal: 0, wd: 0, nb: 1, b: 0, lb: 0, batRuns: n, fours: 0, sixes: 0, faced: 1, bowler: n + 1 });
  }
  fresh(P);
  extra(P, { kind: 'Nb', as: 'bye', runs: 2 });
  eq(L('NB + 2 byes: team +3, byes +2, batter 0 (1 ball faced), bowler +1'), S(P), { team: 3, legal: 0, wd: 0, nb: 1, b: 2, lb: 0, batRuns: 0, fours: 0, sixes: 0, faced: 1, bowler: 1 });
  eq(L('NB + 2 byes: stored as byes'), [lastDb(P).runs, lastDb(P).nbRunsAs], [3, 'bye']);
  fresh(P);
  extra(P, { kind: 'Nb', as: 'legbye', runs: 4, bnd: 'running' });
  eq(L('NB + 4 leg byes (run): team +5, leg byes +4, bowler +1'), S(P), { team: 5, legal: 0, wd: 0, nb: 1, b: 0, lb: 4, batRuns: 0, fours: 0, sixes: 0, faced: 1, bowler: 1 });

  console.log('\n=== the next ball is still the first legal ball ===');
  fresh(P);
  extra(P, { kind: 'Wd', custom: 18 });
  extra(P, { kind: 'Nb', custom: 20 });
  P.E(`recordBall('1')`);
  eq(L('WD + 18, NB + 20, then a single: 0.1'), [P.J('state.ballLog.map(b => b.over)'), P.E('state.score.overs * 6 + state.score.balls')], [['0.0', '0.0', '0.1'], 1]);

  console.log('\n=== PENALTY: 1-5 or any number ===');
  for(const n of [1, 5, 10, 25, 100]){
    fresh(P);
    P.E('openPenaltyModal()');
    if(n <= 5) click(P, `[data-pen-runs="${n}"]`);
    else { click(P, '[data-pen-runs="custom"]'); P.$('#penalty-custom-input').value = String(n); click(P, '#penalty-custom-apply'); }
    click(P, '#penalty-modal-submit');
    eq(L(`Penalty + ${n}: team +${n}, no ball, no batter`), [P.E('state.score.runs'), P.E('state.score.overs * 6 + state.score.balls'), S(P).batRuns], [n, 0, 0]);
  }
  fresh(P);
  P.E('openPenaltyModal()');
  click(P, '[data-pen-runs="custom"]');
  P.$('#penalty-custom-input').value = '7.5';
  click(P, '#penalty-custom-apply');
  eq(L('Penalty "+": a decimal is refused'), [P.text('#penalty-custom-err'), P.$('#penalty-runs').value], ['Runs must be a whole number — no letters, signs or decimals', '5']);
  click(P, '#penalty-modal-cancel');

  console.log('\n=== server: the same deliveries ===');
  fresh(P);
  extra(P, { kind: 'Nb', runs: 4, bnd: 'boundary' });
  extra(P, { kind: 'Nb', runs: 4, bnd: 'running' });
  extra(P, { kind: 'Nb', as: 'bye', runs: 2 });
  extra(P, { kind: 'Nb', as: 'legbye', custom: 9 });
  extra(P, { kind: 'Wd', custom: 25 });
  P.E(`recordBall('6')`);
  const api = H.build({ balls: H.coll([]), clips: H.coll([]), records: H.coll([]), rooms: {}, emits: [], audits: [] },
    ['personName', 'playerKey', 'deriveBallFacts', 'isSuperOverBall', 'buildLiveCardsFromBallsArray'], []);
  const docs = P.emits.filter(e => e.ev === 'logBall').map((e, i) => {
    const d = e.payload;
    return { _id: new H.ObjectId(), matchId: 'XT', ballUid: 'b' + i, innings: d.innings, over: d.over, ballInOver: d.ballInOver, kind: d.kind, runs: d.runs, battingTeam: d.battingTeam,
      striker: d.striker, strikerKey: api.playerKey(d.striker), nonStriker: d.nonStriker, nonStrikerKey: api.playerKey(d.nonStriker), bowler: d.bowler, bowlerKey: api.playerKey(d.bowler),
      dismissal: null, ...(typeof d.boundary === 'boolean' ? { boundary: d.boundary } : {}), ...(d.nbRunsAs ? { nbRunsAs: d.nbRunsAs } : {}) };
  });
  const cards = api.buildLiveCardsFromBallsArray(docs);
  const st = S(P);
  const bat = cards.battingCard.A.reduce((a, r) => ({ runs: a.runs + r.runs, fours: a.fours + r.fours, sixes: a.sixes + r.sixes, balls: a.balls + r.balls }), { runs: 0, fours: 0, sixes: 0, balls: 0 });
  eq(L('server = panel: team, extras, batters, bowler'), [cards.scoreA.runs, cards.extras.A.nb, cards.extras.A.b, cards.extras.A.lb, cards.extras.A.wd, bat.runs, bat.fours, bat.sixes, bat.balls, cards.bowlingCard.B[0].runs],
    [st.team, st.nb, st.b, st.lb, st.wd, st.batRuns, st.fours, st.sixes, st.faced, st.bowler]);
  eq(L('the numbers themselves'), [st.team, st.nb, st.b, st.lb, st.wd, st.batRuns, st.fours, st.sixes, st.bowler], [5 + 5 + 3 + 10 + 26 + 6, 4, 2, 9, 26, 4 + 4 + 6, 1, 1, 5 + 5 + 1 + 1 + 26 + 6]);
  eq(L('no script errors'), P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

(async () => {
  await suite('cricket-panel.html', 'Clipper panel', true);
  await suite('cricket-panel3.html', 'Stream Engine panel', false);
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
