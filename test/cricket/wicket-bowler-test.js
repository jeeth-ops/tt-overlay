// Wicket Details workflow + optional / late / corrected bowler (tests 1–45),
// run against BOTH panels (Clipper = cricket-panel.html, Stream Engine =
// cricket-panel3.html), then the same panel state read by the public
// scorecard and the overlay, and the database side (server.js
// reassignBowlerInDb + buildLiveCardsFromBallsArray, the real functions).
//
//   node test/cricket/wicket-bowler-test.js
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
  const emits = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url, virtualConsole: vc,
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
      if(extra) extra(w);
    }
  });
  const w = dom.window;
  return {
    w, errors, emits, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s),
    J: (expr) => JSON.parse(w.eval(`JSON.stringify(${expr})`)),
    text: (s) => { const el = w.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }
  };
}
const click = (P, sel) => { const el = P.$(sel); if(!el) throw new Error('no element ' + sel); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const shown = (P, id) => P.$('#' + id).classList.contains('show');

// A fresh T20, Team A batting. withBowler=false → nobody named to bowl.
function newMatch(P, withBowler){
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A';
    document.getElementById('match-id').value = 'WBTEST';
    state.teamA.name = 'Mumbai'; state.teamA.short = 'MI';
    state.teamB.name = 'Delhi'; state.teamB.short = 'DC';
    state.teamA.players = ['Rohit','Ishan','Surya','Tilak','Hardik'].map((n, i) => ({ id: 'a' + (i + 1), name: n, isXI: true }));
    state.teamB.players = [{ id:'m1', name:'Mukesh', isXI:true }, { id:'r1', name:'Raj', isXI:true }, { id:'f1', name:'Jadeja', isXI:true }, { id:'k1', name:'Pant', isXI:true }];
    state.teamB.wkId = 'k1';
    state.striker    = { name:'Rohit', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan', id:'a2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = ${withBowler === false ? `{ name:'', id:null, overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 }` : `{ name:'Mukesh', id:'m1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 }`};
    history = []; ballOutbox = []; pendingWicketDelivery = null; lastAutoWicketClip = null;
    try{ localStorage.removeItem('cricket-bowler-reassign-queue'); }catch(e){}
    renderPanel();
  `);
}
// Drive the Wicket Details screen like a scorer.
function wicket(P, o){
  P.E('openWicketModal()');
  click(P, `[data-wd-type="${o.type}"]`);
  if(o.delivery) click(P, `[data-wd-delivery="${o.delivery}"]`);
  if(o.who) click(P, `[data-wd-who="${o.who}"]`);
  if(o.custom != null){
    click(P, '[data-wd-runs="custom"]');
    P.$('#wd-runs-custom').value = String(o.custom);
    P.$('#wd-runs-custom').dispatchEvent(new P.w.Event('input', { bubbles: true }));
  } else if(o.runs != null) click(P, `[data-wd-runs="${o.runs}"]`);
  if(o.fielder) P.E(`(() => { const s = document.getElementById('wd-fielder-select'); if(![...s.options].some(x => x.value === '${o.fielder}')){ const op = document.createElement('option'); op.value = '${o.fielder}'; s.appendChild(op); } s.value = '${o.fielder}'; s.dispatchEvent(new Event('change')); })()`);
  if(o.newBat){ P.$('#wd-newbat-select').value = o.newBat; P.$('#wd-newbat-select').dispatchEvent(new P.w.Event('change', { bubbles: true })); }
  if(o.next) click(P, `[data-wd-strike="${o.next}"]`);
  if(o.confirm !== false) click(P, '#wd-confirm');
}
const legalBalls = (P) => P.E('state.score.overs * 6 + state.score.balls');
const lastLog = (P) => P.J('state.ballLog[state.ballLog.length - 1]');
// What reached the database (the socket here acknowledges at once).
const lastDb = (P) => { const e = P.emits.filter(x => x.ev === 'logBall').slice(-1)[0]; return e ? e.payload : null; };
const fig = (r) => r ? [r.name, `${r.overs}.${r.balls}`, r.maidens || 0, r.runs, r.wickets] : null;
const bowlerFig = (P, name) => fig(P.J(`(state.bowler.name === '${name}' ? state.bowler : (state.bowlingCard.B.find(b => b.name === '${name}') || null))`));

const fixtures = {};

async function panelSuite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file, 'https://example.test/cricket-panel?room=WBTEST');
  await sleep(80);
  const L = (s) => `${label}: ${s}`;

  console.log('\n=== WICKET 1–2: Bowled, Caught ===');
  newMatch(P);
  wicket(P, { type: 'Bowled', newBat: 'a3' });
  eq(L('1 Bowled — striker out, bowler credited, legal ball, new batsman in'), P.J(`[state.score, state.battingCard.A.map(b => [b.name, b.howOut]), state.bowler.wickets, state.striker.name, state.nonStriker.name]`),
    [{ runs: 0, wickets: 1, overs: 0, balls: 1 }, [['Rohit', 'b Mukesh']], 1, 'Surya', 'Ishan']);
  newMatch(P);
  wicket(P, { type: 'Caught', fielder: 'f1', newBat: 'a3' });
  eq(L('2 Caught — fielder stored against the dismissal'), P.J(`[state.battingCard.A[0].howOut, lastLogEntry = state.ballLog[0].fielderName, state.bowler.wickets, Object.values(state.fieldingStats.B)[0].catches]`), ['c Jadeja b Mukesh', 'Jadeja', 1, 1]);

  console.log('\n=== WICKET 3–5: Run Out — who is out is never assumed ===');
  newMatch(P);
  wicket(P, { type: 'Run Out', confirm: false });
  eq(L('4 Run Out cannot be confirmed until WHO is out is chosen'), [P.$('#wd-confirm').disabled, P.text('#wd-preview')], [true, 'Run Out — choose WHO is out.']);
  click(P, '#wd-cancel');
  newMatch(P);
  wicket(P, { type: 'Run Out', who: 'striker', fielder: 'f1', newBat: 'a3' });
  eq(L('3/4 Run Out (striker) — not the bowler’s wicket'), P.J(`[state.battingCard.A[0].name, state.battingCard.A[0].howOut, state.bowler.wickets, state.score.wickets, Object.values(state.fieldingStats.B)[0].runOuts]`), ['Rohit', 'run out (Jadeja)', 0, 1, 1]);
  newMatch(P);
  wicket(P, { type: 'Run Out', who: 'nonStriker', newBat: 'a3' });
  eq(L('5 Run Out (non-striker) — the delivery stays the striker’s'), P.J(`[state.battingCard.A[0].name, state.ballLog[0].striker, state.ballLog[0].dismissedPlayer, state.striker.name]`), ['Ishan', 'Rohit', 'Ishan', 'Rohit']);

  console.log('\n=== WICKET 6–12: Run Out + runs (off the bat) ===');
  for(const r of [1, 2, 3, 4, 5, 6]){
    newMatch(P);
    wicket(P, { type: 'Run Out', who: 'nonStriker', runs: r, newBat: 'a3' });
    const crossed = r % 2 === 1;
    eq(L(`${5 + r} Run Out + ${r}: team +${r}, striker +${r}, bowler concedes ${r}, ${crossed ? 'crossed' : 'not crossed'}`),
      P.J(`[state.score.runs, (state.striker.name === 'Rohit' ? state.striker : state.nonStriker).runs, state.bowler.runs, state.bowler.wickets, state.extras.A.b + state.extras.A.lb, state.striker.name]`),
      [r, r, r, 0, 0, crossed ? 'Surya' : 'Rohit']);
  }
  newMatch(P);
  wicket(P, { type: 'Run Out', who: 'striker', custom: 9, newBat: 'a3' });
  eq(L('12 Run Out + custom 9 (no cap at 6)'), P.J(`[state.score.runs, state.battingCard.A[0].runs, state.bowler.runs, lastLogRuns = state.ballLog[0].runs]`), [9, 9, 9, 9]);

  console.log('\n=== WICKET 13–16: Run Out on Wide / No Ball / Bye / Leg Bye ===');
  newMatch(P);
  wicket(P, { type: 'Run Out', delivery: 'wide', who: 'striker', runs: 1, newBat: 'a3' });
  eq(L('13 Wide + Run Out (+1): team +2 as wides, not a legal ball, striker gets nothing'), P.J(`[state.score.runs, state.extras.A.wd, state.score.overs * 6 + state.score.balls, state.battingCard.A[0].runs, state.bowler.runs, state.ballLog[0].ballType]`), [2, 2, 0, 0, 2, 'WdW']);
  newMatch(P);
  wicket(P, { type: 'Run Out', delivery: 'noball', who: 'nonStriker', runs: 1, newBat: 'a3' });
  eq(L('14 No Ball + Run Out (+1): team +2, nb +1, striker +1 (faced it), not legal'), P.J(`[state.score.runs, state.extras.A.nb, (state.striker.name === 'Rohit' ? state.striker : state.nonStriker).runs, (state.striker.name === 'Rohit' ? state.striker : state.nonStriker).balls, state.score.overs * 6 + state.score.balls]`), [2, 1, 1, 1, 0]);
  newMatch(P);
  wicket(P, { type: 'Run Out', delivery: 'bye', who: 'nonStriker', runs: 2, newBat: 'a3' });
  eq(L('15 Bye + Run Out (+2): byes to extras, never the striker or the bowler, legal ball'), P.J(`[state.score.runs, state.extras.A.b, state.striker.runs, state.striker.balls, state.bowler.runs, state.bowler.balls, state.score.balls, state.ballLog[0].runsAs]`), [2, 2, 0, 1, 0, 1, 1, 'bye']);
  eq(L('15 Bye + Run Out is stored as a Bye delivery with its dismissal'), [lastDb(P).kind, lastDb(P).runs, lastDb(P).dismissal && lastDb(P).dismissal.batter], ['B', 2, 'Ishan']);
  newMatch(P);
  wicket(P, { type: 'Run Out', delivery: 'legbye', who: 'striker', runs: 1, newBat: 'a3' });
  eq(L('16 Leg Bye + Run Out (+1)'), P.J(`[state.score.runs, state.extras.A.lb, state.battingCard.A[0].runs, state.bowler.runs]`).concat(lastDb(P).kind), [1, 1, 0, 0, 'LB']);

  console.log('\n=== WICKET 17–18: new batsman, next striker ===');
  newMatch(P);
  P.E(`state.dismissedThisInnings = { A: ['a4'], B: [] }`);
  P.E('openWicketModal()');
  click(P, '[data-wd-type="Bowled"]');
  const opts = [...P.$('#wd-newbat-select').options].map(o => o.value).filter(Boolean);
  eq(L('17 new batsman list: never someone already out or at the crease'), opts, ['a3', 'a5']);
  P.$('#wd-newbat-select').value = 'a5'; P.$('#wd-newbat-select').dispatchEvent(new P.w.Event('change', { bubbles: true }));
  click(P, '#wd-confirm');
  eq(L('17 new batsman seated at the vacant end'), P.J('[state.striker.name, state.nonStriker.name]'), ['Hardik', 'Ishan']);
  newMatch(P);
  wicket(P, { type: 'Bowled', newBat: 'a3', next: 'survivor' });
  eq(L('18 next striker chosen explicitly overrides the default'), P.J('[state.striker.name, state.nonStriker.name]'), ['Ishan', 'Surya']);

  console.log('\n=== WICKET 19: Run Out on the last legal ball ===');
  newMatch(P);
  P.E(`['1','0','2','0','0'].forEach(k => recordBall(k))`);
  wicket(P, { type: 'Run Out', who: 'striker', runs: 1, newBat: 'a3' });
  const w19 = lastLog(P);
  eq(L('19 the wicket stays on 0.6 with Mukesh, the over completes'), [w19.over, w19.bowler, w19.dismissedPlayer, P.E('state.score.overs'), P.E('state.score.balls')], ['0.6', 'Mukesh', 'Ishan', 1, 0]);
  P.E(`applyBowlerChange('Raj', 'r1')`);
  eq(L('19 next bowler for the new over — 0.6 is not moved to him'), [P.E('state.bowler.name'), P.J('state.ballLog.map(b => b.bowler)'), shown(P, 'ba-overlay')], ['Raj', ['Mukesh', 'Mukesh', 'Mukesh', 'Mukesh', 'Mukesh', 'Mukesh'], false]);

  console.log('\n=== WICKET 20–21: cancel, reload ===');
  newMatch(P);
  P.E(`recordBall('1')`);
  const before20 = P.J('[state.score, state.striker, state.nonStriker, state.ballLog.length, history.length, ballOutbox.length]');
  wicket(P, { type: 'Run Out', who: 'nonStriker', runs: 2, newBat: 'a3', confirm: false });
  click(P, '#wd-cancel');
  eq(L('20 Cancel before confirmation changes nothing'), P.J('[state.score, state.striker, state.nonStriker, state.ballLog.length, history.length, ballOutbox.length]'), before20);
  wicket(P, { type: 'Caught', fielder: 'f1', newBat: 'a3' });
  const saved = P.E('JSON.stringify(state)');
  P.E(`state = mergeWithDefaults(JSON.parse(${JSON.stringify(saved)})); renderPanel();`);
  eq(L('21 reload after save keeps the full wicket'), P.J(`[state.score, state.battingCard.A.map(b => [b.name, b.howOut, b.fielderName]), state.ballLog[1].dismissedPlayer, state.striker.name]`),
    [{ runs: 1, wickets: 1, overs: 0, balls: 2 }, [['Ishan', 'c Jadeja b Mukesh', 'Jadeja']], 'Ishan', 'Surya']);
  eq(L('one wicket (with its new batsman) = one undo step'), P.E('history.length'), 2);

  console.log('\n=== BOWLER 22–25: no bowler needed to score ===');
  newMatch(P, false);
  P.E(`recordBall('1')`);
  eq(L('22/24 innings starts and a ball is recorded with no bowler'), P.J('[state.ballLog.length, state.ballLog[0].bowler, state.ballLog[0].bowlerFacts, state.score.runs]'), [1, '', { legal: true, runs: 1, wicket: false }, 1]);
  P.E(`recordBall('0'); recordBall('4')`);
  wicket(P, { type: 'Bowled', newBat: 'a3' });
  eq(L('25 four balls without a bowler, wicket included'), P.J('[state.ballLog.map(b => b.bowler), state.score, state.battingCard.A[0].howOut, state.bowler.name]'), [['', '', '', ''], { runs: 5, wickets: 1, overs: 0, balls: 4 }, 'b', '']);
  eq(L('25 the panel shows the bowler as Unassigned'), P.text('#disp-bowler-name'), 'UNASSIGNED');

  console.log('\n=== BOWLER 26: assign Mukesh to this over from the beginning ===');
  P.E(`applyBowlerChange('Mukesh', 'm1')`);
  eq(L('26 asked: 4 deliveries recorded without a bowler'), [shown(P, 'ba-overlay'), P.text('#ba-note'), P.text('#ba-current')], [true, '4 deliveries have already been recorded without a bowler.', 'Unassigned']);
  click(P, '#ba-from-start');
  eq(L('26 every ball of the over is now Mukesh’s, figures from the balls'), [P.J('state.ballLog.map(b => b.bowler)'), bowlerFig(P, 'Mukesh'), P.J('state.battingCard.A[0].howOut')], [['Mukesh', 'Mukesh', 'Mukesh', 'Mukesh'], ['Mukesh', '0.4', 0, 5, 1], 'b Mukesh']);
  const q26 = P.J(`JSON.parse(localStorage.getItem('cricket-bowler-reassign-queue') || '[]')`);
  const sent26 = P.emits.filter(e => e.ev === 'reassignBowler').slice(-1)[0];
  eq(L('26 the change goes to the database (the delivery records)'), sent26 && [sent26.payload.bowler, sent26.payload.over, sent26.payload.innings, sent26.payload.deliveryIds.length, sent26.payload.fromBowlers], ['Mukesh', 0, 1, 4, ['']]);
  eq(L('26 acknowledged → nothing left queued'), q26.length, 0);

  console.log('\n=== BOWLER 28–31, 38–44: Mukesh → Raj for this over from the start ===');
  const snapBefore = P.J('[state.score, state.extras.A, state.ballLog.length, ballOutbox.length, state.striker, state.nonStriker, state.battingCard.A]');
  P.E(`applyBowlerChange('Raj', 'r1')`);
  eq(L('28/29 asked: 4 deliveries currently assigned to Mukesh'), [P.text('#ba-note'), P.text('#ba-current'), P.text('#ba-new')], ['4 deliveries are currently assigned to Mukesh.', 'Mukesh', 'Raj']);
  click(P, '#ba-from-start');
  eq(L('29 the deliveries themselves now say Raj'), P.J('state.ballLog.map(b => b.bowler)'), ['Raj', 'Raj', 'Raj', 'Raj']);
  eq(L('30 Mukesh no longer has those figures (no empty duplicate row)'), [bowlerFig(P, 'Mukesh'), P.J(`state.bowlingCard.B.filter(b => b.name === 'Mukesh').length`)], [null, 0]);
  eq(L('31/44 Raj has them — overs, runs, wickets, economy'), [bowlerFig(P, 'Raj'), P.E(`bowlerEcon(state.bowler)`)], [['Raj', '0.4', 0, 5, 1], '7.50']);
  eq(L('38–43 no new balls; score, overs, extras, wickets, batting unchanged'), P.J('[state.score, state.extras.A, state.ballLog.length, ballOutbox.length, state.striker, state.nonStriker, state.battingCard.A]').map((v, i) => i === 6 ? v.map(b => [b.name, b.runs, b.balls]) : v),
    snapBefore.map((v, i) => i === 6 ? v.map(b => [b.name, b.runs, b.balls]) : v));
  eq(L('the bowled dismissal now reads b Raj'), P.J('state.battingCard.A[0].howOut'), 'b Raj');
  eq(L('32 panel updates at once (bowler tile)'), P.text('#disp-bowler-name'), 'Raj');
  if(P.$('#lc-bowler-name')) eq(L('32 live console bowler'), P.text('#lc-bowler-name'), 'Raj');
  fixtures[label] = { live: P.J('state') };

  console.log('\n=== BOWLER 36–37: reload / resume keep Raj ===');
  const saved36 = P.E('JSON.stringify(state)');
  P.E(`state = mergeWithDefaults(JSON.parse(${JSON.stringify(saved36)})); renderPanel();`);
  eq(L('36 reload: deliveries and figures still Raj'), [P.J('state.ballLog.map(b => b.bowler)'), bowlerFig(P, 'Raj')], [['Raj', 'Raj', 'Raj', 'Raj'], ['Raj', '0.4', 0, 5, 1]]);
  const rec = P.J('buildMatchRecordForLeague()');
  eq(L('37 the saved match record (resume / scorecard) has Raj, not Mukesh'), (rec.bowlingCard.B || []).map(b => [b.name, b.overs, b.balls, b.runs, b.wickets]), [['Raj', 0, 4, 5, 1]]);

  console.log('\n=== BOWLER 27: future deliveries only ===');
  newMatch(P, false);
  P.E(`recordBall('1'); recordBall('2')`);
  P.E(`applyBowlerChange('Mukesh', 'm1')`);
  click(P, '#ba-future');
  P.E(`recordBall('4')`);
  eq(L('27 recorded balls stay Unassigned, Mukesh only from the next ball'), [P.J('state.ballLog.map(b => b.bowler)'), bowlerFig(P, 'Mukesh')], [['', '', 'Mukesh'], ['Mukesh', '0.1', 0, 4, 0]]);

  console.log('\n=== BOWLER 23: new over with the bowler not known yet ===');
  newMatch(P);
  P.E(`['1','0','0','0','0','0'].forEach(k => recordBall(k)); maybePromptNewBowler();`);
  eq(L('23 over complete → the new-bowler prompt offers "not known yet"'), [shown(P, 'newover-modal-overlay'), /Not known yet/.test(P.text('#newover-modal-cancel'))], [true, true]);
  click(P, '#newover-modal-cancel');
  P.E(`recordBall('1')`);
  eq(L('23 the new over is scored Unassigned — never handed to last over’s bowler'), [P.E('state.bowler.name'), lastLog(P).bowler, bowlerFig(P, 'Mukesh')], ['', '', ['Mukesh', '1.0', 0, 1, 0]]);
  // Later: who bowled over 1 becomes known — the specific-over tool.
  P.E(`openBowlerAssignModal({ mode: 'fix', overIdx: 1 })`);
  P.$('#ba-bowler-input').value = 'Raj';
  P.E(`(() => { const s = document.getElementById('ba-bowler-select'); const op = document.createElement('option'); op.value = 'r1'; s.appendChild(op); s.value = 'r1'; s.dispatchEvent(new Event('change')); })()`);
  eq(L('21 specific over: the chooser lists over 2 and shows 1 delivery without a bowler'), [P.text('#ba-title'), P.text('#ba-note')], ['🎯 Bowler for Over 2', '1 delivery has already been recorded without a bowler.']);
  click(P, '#ba-from-start');
  eq(L('21 over 2 → Raj; over 1 stays Mukesh’s'), [P.J('state.ballLog.map(b => b.bowler)'), bowlerFig(P, 'Mukesh'), bowlerFig(P, 'Raj')], [['Mukesh', 'Mukesh', 'Mukesh', 'Mukesh', 'Mukesh', 'Mukesh', 'Raj'], ['Mukesh', '1.0', 0, 1, 0], ['Raj', '0.1', 0, 1, 0]]);

  console.log('\n=== BOWLER 45: Wide / No Ball / Bye / Leg Bye keep their rules ===');
  newMatch(P, false);
  P.E(`recordBall('Wd', { extraRuns: 1 }); recordBall('Nb', { runsOffBat: 2 }); recordBall('B', { runs: 2 }); recordBall('LB', { runs: 1 }); recordBall('1');`);
  const sc45 = P.J('[state.score, state.extras.A]');
  P.E(`applyBowlerChange('Mukesh', 'm1')`); click(P, '#ba-from-start');
  eq(L('45 Mukesh is charged wides + no-ball + bat runs only, 3 legal balls'), bowlerFig(P, 'Mukesh'), ['Mukesh', '0.3', 0, 6, 0]);
  P.E(`applyBowlerChange('Raj', 'r1')`); click(P, '#ba-from-start');
  eq(L('45 → Raj: identical figures, score and extras untouched'), [bowlerFig(P, 'Raj'), bowlerFig(P, 'Mukesh'), P.J('[state.score, state.extras.A]')], [['Raj', '0.3', 0, 6, 0], null, sc45]);

  console.log('\n=== Maiden follows the bowler ===');
  newMatch(P);
  P.E(`['0','0','0','0','0','0'].forEach(k => recordBall(k))`);
  eq(L('a maiden over by Mukesh'), bowlerFig(P, 'Mukesh'), ['Mukesh', '1.0', 1, 0, 0]);
  P.E(`openBowlerAssignModal({ mode: 'fix', overIdx: 0 })`);
  P.E(`(() => { const s = document.getElementById('ba-bowler-select'); const op = document.createElement('option'); op.value = 'r1'; s.appendChild(op); s.value = 'r1'; s.dispatchEvent(new Event('change')); })()`);
  click(P, '#ba-from-start');
  eq(L('corrected to Raj → the maiden moves with the over (Mukesh, still on for over 2, keeps nothing)'), [bowlerFig(P, 'Raj'), bowlerFig(P, 'Mukesh')], [['Raj', '1.0', 1, 0, 0], ['Mukesh', '0.0', 0, 0, 0]]);

  console.log('\n=== Website (Edit Scorecard) correction reaches the panel ===');
  newMatch(P);
  P.E(`recordBall('1'); recordBall('4')`);
  P.E(`applyRemoteBowlerReassign({ id: 'bwl_1', matchId: 'WBTEST', innings: 1, overs: [0], fromBowler: 'Mukesh', toBowler: 'Raj' })`);
  eq(L('28 a correction made on the scorecard applies here with the same engine (and Raj bowls on)'), [P.J('state.ballLog.map(b => b.bowler)'), bowlerFig(P, 'Raj'), bowlerFig(P, 'Mukesh'), P.E('state.bowler.name')], [['Raj', 'Raj'], ['Raj', '0.2', 0, 5, 0], null, 'Raj']);
  P.E(`applyRemoteBowlerReassign({ id: 'bwl_1', matchId: 'WBTEST', innings: 1, overs: [0], fromBowler: 'Mukesh', toBowler: 'Raj' })`);
  eq(L('the same correction twice is applied once'), bowlerFig(P, 'Raj'), ['Raj', '0.2', 0, 5, 0]);

  console.log('\n=== WICKET animation: on the overlay 3 seconds after WICKET is pressed ===');
  const wkAnims = () => P.emits.filter(e => e.ev === 'cricketEvent' && e.payload && e.payload.event && e.payload.event.kind === 'WICKET').map(e => e.payload.event.sub);
  newMatch(P);
  let n0 = wkAnims().length;
  wicket(P, { type: 'Run Out', who: 'nonStriker', newBat: 'a3', confirm: false });
  await sleep(1500);
  eq(L('anim: nothing at 1.5s'), wkAnims().length - n0, 0);
  await sleep(1700);
  eq(L('anim: WICKET goes up at 3s while the scorer is still filling the details — nothing recorded yet'), [wkAnims().length - n0, P.E('state.ballLog.length'), shown(P, 'wd-overlay')], [1, 0, true]);
  click(P, '#wd-confirm');
  await sleep(200);
  eq(L('anim: Confirm afterwards does not show it a second time'), [wkAnims().length - n0, P.E('state.score.wickets')], [1, 1]);
  newMatch(P);
  n0 = wkAnims().length;
  wicket(P, { type: 'Bowled', newBat: 'a3' });
  await sleep(300);
  eq(L('anim: quick Confirm — still waits for the 3 seconds'), wkAnims().length - n0, 0);
  await sleep(3000);
  eq(L('anim: then exactly one, with the dismissed batter'), wkAnims().slice(n0), ['Rohit']);
  newMatch(P);
  n0 = wkAnims().length;
  wicket(P, { type: 'Bowled', confirm: false });
  await sleep(1000);
  click(P, '#wd-cancel');
  await sleep(2400);
  eq(L('anim: Cancel within 3 seconds — never shown'), [wkAnims().length - n0, P.E('state.score.wickets')], [0, 0]);

  eq(L('no script errors'), P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

async function scorecardAndOverlay(){
  const st = fixtures['Clipper panel'].live;
  console.log('\n######## 33–35: Scorecard, ball-by-ball, overlay read the corrected state ########');
  const S = boot('cricket-scorecard.html', 'https://example.test/cricket-scorecard.html?room=WBTEST', w => { w.firebase = deep(); });
  await sleep(80);
  S.E(`latestState = ${JSON.stringify(st)}; render();`);
  const bowl = S.text('#bowling-table-body');
  eq('33 scorecard bowling table: Raj 0.4-0-5-1, no Mukesh', [/Raj/.test(bowl), /0\.4\s*0\s*5\s*1/.test(bowl), /Mukesh/.test(bowl)], [true, true, false]);
  const comm = S.E(`currentInningsLog(latestState).map(b => commentaryLine(b).text).join(' | ')`);
  eq('34 ball-by-ball names Raj on every delivery', [/Raj/.test(comm), /Mukesh/.test(comm)], [true, false]);
  const O = boot('cricket-overlay.html', 'https://example.test/cricket-overlay.html?room=WBTEST', w => { w.gsap = deep(); });
  await sleep(80);
  O.E(`renderState(${JSON.stringify(st)})`);
  eq('35 overlay bowler: Raj 1-5 (0.4)', [(O.text('#bowler-name-val') || '').toUpperCase(), O.text('#bowler-figures-val'), O.text('#bowler-overs-val')], ['RAJ', '1-5', '0.4']);
  eq('scorecard/overlay: no script errors', [...S.errors, ...O.errors].filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

async function serverSuite(){
  console.log('\n######## Database: reassignBowlerInDb + the rebuilt scorecard ########');
  const world = { balls: H.coll([]), clips: H.coll([]), records: H.coll([]), rooms: {}, emits: [], audits: [] };
  const api = H.build(world, ['personName', 'playerKey', 'deriveBallFacts', 'isSuperOverBall', 'buildLiveCardsFromBallsArray'], ['reassignBowlerInDb']);
  const mk = (i, kind, runs, extra) => ({ _id: new H.ObjectId(), matchId: 'M1', ownerUid: 'u1', ballUid: 'd' + i, innings: 1, over: 0, ballInOver: i, kind, runs, battingTeam: 'A',
    striker: 'Rohit', strikerKey: 'rohit', nonStriker: 'Ishan', bowler: '', bowlerKey: '', dismissal: null, ...(extra || {}) });
  world.balls.docs.push(mk(1, '1', 1), mk(2, '0', 0), mk(3, '4', 4), mk(4, 'W', 0, { dismissal: { type: 'Bowled', batter: 'Rohit' } }), mk(5, 'B', 2));
  world.balls.docs.push({ ...mk(9, '6', 6), over: 1, ballInOver: 1, ballUid: 'other-over', bowler: 'Someone', bowlerKey: 'someone' });
  world.records.docs.push({ matchId: 'M1' });
  const before = api.buildLiveCardsFromBallsArray(world.balls.docs.map(H.clone));
  eq('DB: an unassigned over is credited to nobody', (before.bowlingCard.B || []).map(b => b.name), ['Someone']);
  let r = await api.reassignBowlerInDb('M1', { innings: 1, over: 0, bowler: 'Mukesh', bowlerId: 'm1', deliveryIds: ['d1', 'd2', 'd3', 'd4', 'd5'], allHaveIds: true, fromBowlers: [''] });
  eq('DB 26: 5 deliveries assigned to Mukesh, nothing else touched', [r.ok, r.updated, world.balls.docs.map(b => b.bowler)], [true, 5, ['Mukesh', 'Mukesh', 'Mukesh', 'Mukesh', 'Mukesh', 'Someone']]);
  const rec1 = world.records.docs[0];
  const muk = (rec1.bowlingCard.B || []).find(b => b.name === 'Mukesh');
  eq('DB: saved scorecard rebuilt — Mukesh 5 legal balls (bye counts as a ball, its runs do not), 5 runs, 1 wkt', muk && [muk.overs, muk.balls, muk.runs, muk.wickets], [0, 5, 5, 1]);
  r = await api.reassignBowlerInDb('M1', { innings: 1, over: 0, bowler: 'Raj', bowlerId: 'r1', deliveryIds: ['d1', 'd2', 'd3'], allHaveIds: true, fromBowlers: ['Mukesh'] });
  eq('DB 29: 3 deliveries Mukesh → Raj', [r.updated, world.balls.docs.map(b => b.bowler)], [3, ['Raj', 'Raj', 'Raj', 'Mukesh', 'Mukesh', 'Someone']]);
  const cards = world.records.docs[0];
  const byName = (n) => { const x = (cards.bowlingCard.B || []).find(b => b.name === n); return x && [x.overs, x.balls, x.runs, x.wickets]; };
  eq('DB 30/31: Mukesh loses them, Raj gains them', [byName('Mukesh'), byName('Raj')], [[0, 2, 0, 1], [0, 3, 5, 0]]);
  eq('DB 38–42: no deliveries created, team total unchanged', [world.balls.docs.length, cards.scoreA && cards.scoreA.runs, before.scoreA && before.scoreA.runs], [6, 13, 13]);
  r = await api.reassignBowlerInDb('M1', { innings: 1, over: 0, bowler: 'X', deliveryIds: [], allHaveIds: false, fromBowlers: [] });
  eq('DB: a request naming no deliveries changes nothing (never a whole match)', [r.updated, world.balls.docs.map(b => b.bowler)], [0, ['Raj', 'Raj', 'Raj', 'Mukesh', 'Mukesh', 'Someone']]);
  r = await api.reassignBowlerInDb('M1', { innings: 1, over: 0, bowler: '', deliveryIds: ['d1'], allHaveIds: true });
  eq('DB: an empty bowler name is refused', r.ok, false);
  eq('DB: every change is in the audit log', world.audits.length, 2);
}

(async () => {
  await panelSuite('cricket-panel.html', 'Clipper panel');
  await panelSuite('cricket-panel3.html', 'Stream Engine panel');
  await scorecardAndOverlay();
  await serverSuite();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
