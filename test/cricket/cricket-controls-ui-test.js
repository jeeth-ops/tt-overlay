// The cricket controls that now exist in BOTH panels, driven through the
// real buttons/modals in jsdom (the engine itself is covered by test.js,
// which runs against either panel with PANEL=...):
//   Penalty Runs · Retired Hurt · Overthrow (Law 19.8 modal) · Super Over
//   · mid-over bowler change · Resume · and — Panel 3 only — that the
//   Stream Engine is still there and no Clipper Helper code came across.
//
//   node test/cricket/cricket-controls-ui-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

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
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://example.test/cricket-panel', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){} });
      w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
      w.firebase = undefined; w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLMediaElement.prototype.pause = () => {};
      w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
    }
  });
  // jsdom fires DOMContentLoaded itself once parsing ends — firing it again
  // would bind every DOMContentLoaded handler twice.
  return { w: dom.window, E: (c) => dom.window.eval(c), errors, $: (s) => dom.window.document.querySelector(s), src: html };
}
const click = (P, el) => el.dispatchEvent(new P.w.Event('click', { bubbles: true }));
const shown = (P, id) => P.$('#' + id).classList.contains('show');

function newMatch(P){
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20';
    state.battingTeam = 'A';
    state.teamA.players = [{ id:'p1', name:'Striker', isXI:true }, { id:'p2', name:'NonStriker', isXI:true }, { id:'p3', name:'Third', isXI:true }];
    state.teamB.players = [{ id:'p9', name:'Bowler', isXI:true }, { id:'p8', name:'Second Bowler', isXI:true }];
    state.striker    = { name:'Striker', id:'p1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'NonStriker', id:'p2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler     = { name:'Bowler', id:'p9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = [];
    renderPanel();
  `);
}

async function suite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file);
  await sleep(80);

  console.log('\n=== Penalty Runs ===');
  newMatch(P);
  click(P, P.$('#lc-penalty-btn'));
  eq(`${label}: + Penalty Runs opens the penalty modal`, shown(P, 'penalty-modal-overlay'), true);
  eq(`${label}: a reason must be given — reasons listed for the batting side`, P.$('#penalty-reason').options.length > 3, true);
  click(P, P.$('#penalty-modal-submit'));
  eq(`${label}: 5 penalty runs to the batting side, no ball bowled`, P.E(`[state.score.runs, state.score.balls, state.extras.A.pen, state.striker.runs, state.bowler.runs, state.penaltyLog.length]`), [5, 0, 5, 0, 0, 1]);
  eq(`${label}: ledger lists the award (reversible)`, !!P.$('#pen-ledger [data-pen-remove]'), true);
  click(P, P.$('#pen-ledger [data-pen-remove]'));
  eq(`${label}: removing it takes the 5 runs back exactly`, P.E(`[state.score.runs, state.extras.A.pen, state.penaltyLog.length]`), [0, 0, 0]);

  console.log('\n=== Retired Hurt ===');
  newMatch(P);
  P.E(`recordBall('2'); recordBall('1');`); // striker 2(1), then strike changes
  click(P, P.$('#lc-retired-btn'));
  eq(`${label}: 🩹 Retired Hurt asks who is going off`, shown(P, 'retired-modal-overlay'), true);
  click(P, P.$('#retired-nonstriker-btn'));
  eq(`${label}: not out, no wicket, no ball — leaves with 3 (2)`, P.E(`[state.score.wickets, state.score.overs * 6 + state.score.balls, state.battingCard.A.filter(b => b.retiredHurt).map(b => [b.name, b.runs, b.balls, b.howOut])]`), [0, 2, [['Striker', 3, 2, 'retired hurt']]]);
  eq(`${label}: new batsman asked for (as retired, not out)`, [shown(P, 'newbat-modal-overlay'), /retired hurt — who's coming in\?/.test(P.$('#newbat-modal-sub').textContent)], [true, true]);

  console.log('\n=== Overthrow (Law 19.8) ===');
  newMatch(P);
  click(P, P.$('#card-ball-outcome [data-ball="OT"], #live-console [data-ball="OT"]'));
  eq(`${label}: Overthrow opens its own modal (components, not a lump total)`, [shown(P, 'overthrow-modal-overlay'), shown(P, 'extras-modal-overlay')], [true, false]);
  P.$('#ot-completed').value = '2';
  click(P, P.$('[data-ot-boundary="1"]'));
  click(P, P.$('#overthrow-modal-submit'));
  eq(`${label}: 2 run + 4 overthrow = 6 to the striker, strike stays (2 run), not a six`, P.E(`[state.score.runs, state.striker.name, state.striker.runs, state.striker.sixes, state.striker.fours]`), [6, 'Striker', 6, 0, 0]);
  eq(`${label}: the boundary toggle never records a wicket (one delivery logged)`, P.E(`[state.score.wickets, state.ballLog.map(b => b.ballType)]`), [0, ['OT']]);

  console.log('\n=== Mid-over bowler change ===');
  newMatch(P);
  P.E(`recordBall('0'); recordBall('1'); recordBall('0');`);
  P.E(`applyBowlerChange('Second Bowler', 'p8')`);
  eq(`${label}: mid-over change asks: bowler change or wrong name?`, shown(P, 'midover-bowler-overlay'), true);
  click(P, P.$('#midover-replace-btn'));
  eq(`${label}: replacement — the first bowler keeps their 3 balls`, P.E(`[state.bowler.name, state.bowler.balls, (state.bowlingCard.B.find(b => b.name === 'Bowler') || {}).balls]`), ['Second Bowler', 0, 3]);

  console.log('\n=== Super Over ===');
  newMatch(P);
  P.E(`state.superOverReady = true; renderPanel();`);
  eq(`${label}: a tie shows the Super Over bar with Start`, [P.$('#so-bar').hidden, P.$('#so-start-btn').hidden], [false, false]);
  P.E(`state.score.runs = 10; state.score.overs = 20;`);
  click(P, P.$('#so-start-btn'));
  eq(`${label}: Start Super Over → its own phase, not "over 21"`, P.E(`[state.phase, state.superOver.number, state.score.runs, state.score.overs]`), ['SUPER_OVER', 1, 0, 0]);

  console.log('\n=== Resume ===');
  eq(`${label}: robust Resume (saved-copy fallback) is present`, P.E(`[typeof resumeSavedMatch, typeof matchResumeHtml, typeof startUpcomingMatch]`), ['function', 'function', 'function']);

  console.log('\n=== Architecture ===');
  const engine = /STREAM_ENGINE_URL/.test(P.src), clipper = /CLIPPER_HELPER_URL|sendClipToHelper|localhost:5005/.test(P.src);
  if(file === 'cricket-panel3.html'){
    eq(`${label}: Stream Engine still present`, [engine, P.E(`[typeof startLive, typeof ensureLiveOutputWindow, typeof triggerClip].join()`), !!P.$('#card-live-studio'), !!P.$('#card-program-monitor')], [true, 'function,function,function', true, true]);
    eq(`${label}: no Clipper Helper code brought in`, clipper, false);
  } else {
    eq(`${label}: Clipper Helper still present`, [clipper, P.E(`typeof sendClipToHelper`), !!P.$('#card-clipper-helper')], [true, 'function', true]);
    eq(`${label}: no Stream Engine code brought in`, engine, false);
  }
  eq(`${label}: no script errors`, P.errors, []);
}

(async () => {
  await suite('cricket-panel.html', 'Clipper panel');
  await suite('cricket-panel3.html', 'Stream Engine panel');
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
