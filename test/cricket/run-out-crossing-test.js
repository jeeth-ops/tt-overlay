// 🏏 RUN OUT — WHERE THE BATTERS END UP (Laws 18.8.2 and 18.12.1 / 18.12.1.2),
// both panels (cricket-panel.html, cricket-panel3.html), through the real
// Wicket Details screen and the real New Batsman screen.
//
// Law 18.8.2: a Run Out scores the runs COMPLETED before the wicket was put
// down — never the run being attempted. Law 18.12.1: the not-out batter
// returns to the wicket he/she has left only if the batters had NOT already
// crossed at that instant. So "had they crossed?" is asked on every Run Out
// (nothing is assumed from the runs), and the ends are worked out from it:
//
//   A = Rohit (a1), striker · B = Ishan (a2), non-striker · C = Surya (a3)
//
//   1. last legal ball, a single attempted, they CROSS, B is run out at the
//      striker's end: no run, B out, A goes on to the bowler's end, C takes
//      the striker's end — and A faces the first ball of the next over
//   2. the same, but they had NOT crossed: A goes back, C faces next over
//   3. the striker run out at the end of the over (crossed / not crossed)
//   4. a run out in the middle of the over (crossed / not crossed)
//   5. a run completed, then a run out going for the next one
//   6. a wide / no ball on the over's 6th-ball position: another legal ball
//      is still to come — no change of ends
//   7. the incoming batter is asked after the wicket, by id, and seated at
//      the empty end
//   8. a reload, and another device opening the match: the same crease
//   9. both panels end every case in exactly the same state
//  10. CONFIRM / Send In pressed twice: one wicket, one ball
//  11. what was already scored stays as it was: a saved match reloads
//      unchanged, and a Run Out recorded without the answer (an older caller)
//      is seated exactly as before
//
//   node test/cricket/run-out-crossing-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const fails = [];
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function boot(file, storage){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const emits = [];
  const handlers = {};
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=RO', virtualConsole: vc,
    beforeParse(w){
      if(storage) Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.io = () => ({ on(ev, fn){ handlers[ev] = fn; }, emit(ev, payload, ack){ emits.push({ ev, payload }); if(typeof ack === 'function') ack({ ok: true }); }, connected: true, disconnect(){}, io: { on(){} } });
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
  return { w, errors, emits, handlers, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s), J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)),
    text: (s) => { const el = w.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; } };
}
const click = (P, sel) => { const el = P.$(sel); if(!el) throw new Error('no element ' + sel); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const clickType = (P, t) => { const el = [...P.w.document.querySelectorAll('#wd-types [data-wd-type]')].find(b => b.dataset.wdType === t); if(!el) throw new Error('no out type ' + t); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const change = (P, sel, v) => { const el = P.$(sel); el.value = v; el.dispatchEvent(new P.w.Event('change', { bubbles: true })); };
const shown = (P, id) => P.$('#' + id).classList.contains('show');

const ROSTER = ['Rohit', 'Ishan', 'Surya', 'Tilak', 'Hardik', 'Tim', 'Krunal', 'Piyush', 'Jasprit', 'Akash', 'Arjun'];
function setup(P){
  P.E(`
    closeNewOverModal(); closeNewBatsmanModal(); closeWicketModal();
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A';
    document.getElementById('match-id').value = 'RO';
    state.teamA.players = ${JSON.stringify(ROSTER)}.map((n, i) => ({ id: 'a' + (i + 1), name: n, isXI: true }));
    state.teamB.players = [{ id:'m1', name:'Mukesh', isXI:true }, { id:'r1', name:'Raj', isXI:true }, { id:'f1', name:'Jadeja', isXI:true }, { id:'k1', name:'Pant', isXI:true }];
    state.teamB.wkId = 'k1';
    state.striker    = { name: 'Rohit', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name: 'Ishan', id:'a2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Mukesh', id:'m1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = []; pendingWicketDelivery = null; disarmWicketAnimation();
    renderPanel();
  `);
  P.emits.length = 0;
}
const dots = (P, n) => { for(let i = 0; i < n; i++) P.E(`recordBall('0')`); };
// The Wicket Details screen: the answers, then CONFIRM WICKET. Returns what
// the preview said just before CONFIRM.
function runOut(P, o){
  P.E('openWicketModal()');
  clickType(P, 'Run Out');
  if(o.delivery) click(P, `[data-wd-delivery="${o.delivery}"]`);
  click(P, `[data-wd-who="${o.who}"]`);
  P.E(`wdSetFielder('f1'); renderWicketDetails();`);
  if(o.runs != null) click(P, `[data-wd-runs="${o.runs}"]`);
  if(o.crossed != null) click(P, `[data-wd-crossed="${o.crossed ? 'yes' : 'no'}"]`);
  const preview = P.text('#wd-preview');
  const blocked = P.$('#wd-confirm').disabled;
  if(o.confirm !== false) click(P, '#wd-confirm');
  return { preview, blocked };
}
const crease = (P) => P.J(`({ s: state.striker.id, n: state.nonStriker.id, end: state.newBatsmanEnd,
  ov: state.score.overs + '.' + state.score.balls, w: state.score.wickets, r: state.score.runs })`);
const strikeUi = (P) => P.J(`({ shown: !document.getElementById('newbat-strike-wrap').hidden,
  on: [...document.querySelectorAll('#newbat-strike [data-nb-strike].on')].map(b => b.dataset.nbStrike),
  hint: document.getElementById('newbat-strike-hint').textContent })`);
const lastLog = (P) => P.J(`(() => { const e = (state.ballLog || []).filter(x => x.ballType !== 'PEN').slice(-1)[0] || {};
  return { over: e.over, type: e.ballType, striker: e.strikerId || null, nonStriker: e.nonStrikerId || null, out: e.isWicket ? (e.dismissedPlayerId || null) : null,
    fielder: e.fielderId || null, dismissal: e.dismissal || null, crossed: e.runOutCrossed === undefined ? 'missing' : e.runOutCrossed, runs: e.runs }; })()`);
const dbBalls = (P) => P.emits.filter(e => e.ev === 'logBall').map(e => e.payload);
const lastDb = (P) => dbBalls(P).slice(-1)[0] || null;
// A batter's line: the batting card's record once out (the empty end only
// holds the out batter's line until the incoming batter takes it), else the crease.
const card = (P, id) => P.J(`(() => { const out = activeBattingCard(state.battingTeam).find(x => x && x.out && x.id === '${id}');
  const b = out || [state.striker, state.nonStriker].find(x => x && x.id === '${id}') || {}; return { runs: b.runs || 0, balls: b.balls || 0, out: !!b.out, howOut: b.howOut || null }; })()`);
const bowler = (P) => P.J(`({ balls: state.bowler.balls, overs: state.bowler.overs, runs: state.bowler.runs, wickets: state.bowler.wickets })`);
function sendIn(P, id, strike){
  if(strike) click(P, `[data-nb-strike="${strike}"]`);
  change(P, '#newbat-modal-select', id);
  click(P, '#newbat-modal-submit');
}
// Everything the two panels must agree on after a case.
const fingerprint = (P) => P.J(`({ s: state.striker.id, n: state.nonStriker.id, ov: state.score.overs + '.' + state.score.balls,
  r: state.score.runs, w: state.score.wickets, ext: state.extras.A, bow: [state.bowler.runs, state.bowler.wickets],
  log: state.ballLog.map(e => [e.over, e.ballType, e.runs, e.strikerId, e.nonStrikerId, e.dismissedPlayerId || null, e.runOutCrossed === undefined ? null : e.runOutCrossed]),
  out: activeBattingCard('A').filter(b => b.out).map(b => [b.id, b.runs, b.balls, b.howOut]) })`);

async function suite(file){
  console.log(`\n######## ${file} ########`);
  const P = boot(file);
  await sleep(80);
  const L = (s) => `${file}: ${s}`;
  const prints = {};

  // ---- 0. the question itself -------------------------------------------------
  setup(P); dots(P, 5);
  let pv = runOut(P, { who: 'nonStriker', runs: 0, confirm: false });
  eq(L('Run Out asks "had the batters crossed?" — and cannot be confirmed without the answer'),
    [!P.$('#wd-sec-crossed').hidden, P.$('#wd-confirm').disabled, /crossed when the wicket was put down/.test(pv.preview)], [true, true, true]);
  eq(L('…both answers offered, neither pre-chosen'), P.J(`[...document.querySelectorAll('#wd-crossed [data-wd-crossed]')].map(b => [b.dataset.wdCrossed, b.classList.contains('on')])`),
    [['yes', false], ['no', false]]);
  P.E('cancelWicketDetails()');
  for(const t of ['Bowled', 'Caught', 'LBW', 'Stumped', 'Hit Wicket', 'Obstructing the Field', 'Run Out (Mankaded)']){
    P.E('openWicketModal()'); clickType(P, t);
    const asked = !P.$('#wd-sec-crossed').hidden;
    P.E('cancelWicketDetails()');
    eq(L(`${t}: no crossing question`), asked, false);
  }
  eq(L('nothing was recorded by opening and cancelling'), [crease(P).w, crease(P).ov, P.J('state.ballLog.length')], [0, '0.5', 5]);

  // ---- 1. THE REPORTED CASE: last ball, single attempted, crossed, B run out ---
  setup(P); dots(P, 5);
  pv = runOut(P, { who: 'nonStriker', runs: 0, crossed: true });
  eq(L('1 crossed + B run out on the last ball: the preview says where everyone ends up'),
    [/Rohit ends at the bowler's end/.test(pv.preview), /new batsman comes in at the striker's end/.test(pv.preview), /next ball \(new over\): Rohit faces/.test(pv.preview)], [true, true, true]);
  let c = crease(P), ll = lastLog(P);
  eq(L('1 …B (Ishan, a2) is out — once; no run for the incomplete single; over complete (1.0)'), [ll.out, c.w, c.r, c.ov, ll.runs], ['a2', 1, 0, '1.0', 0]);
  eq(L('1 …the ball is A\'s, at 0.6, the run out by Jadeja (f1), crossed: true kept with it'), [ll.over, ll.striker, ll.nonStriker, ll.fielder, ll.crossed], ['0.6', 'a1', 'a2', 'f1', true]);
  eq(L('1 …A (Rohit) not out, no run, 6 balls faced; B\'s card: run out (Jadeja)'), [card(P, 'a1'), card(P, 'a2').out, card(P, 'a2').howOut], [{ runs: 0, balls: 6, out: false, howOut: null }, true, 'run out (Jadeja)']);
  eq(L('1 …the bowler: 6 balls, 0 runs, NO wicket credited'), bowler(P), { balls: 0, overs: 1, runs: 0, wickets: 0 });
  let db = lastDb(P);
  eq(L('1 …to the database: a Run Out of Ishan (a2), by Jadeja, crossed: true'), db && [db.kind, db.runs, db.dismissal.type, db.dismissal.batterId, db.dismissal.fielderId, db.dismissal.crossed], ['W', 0, 'Run Out', 'a2', 'f1', true]);
  let ui = strikeUi(P);
  eq(L('1 …New Batsman: Rohit (the original striker) pre-selected to face, with the reason'),
    [shown(P, 'newbat-modal-overlay'), ui.on, /Rohit/.test(ui.hint), /had crossed/.test(ui.hint), /last ball of the over/.test(ui.hint)], [true, ['survivor'], true, true, true]);
  const opts = P.J(`[...document.getElementById('newbat-modal-select').options].map(o => o.value).filter(Boolean)`);
  eq(L('1 …the incoming list: neither the out batter nor the one at the crease'), [opts.includes('a1'), opts.includes('a2'), opts.includes('a3')], [false, false, true]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('1 ✅ ACCEPTANCE: next over — A (Rohit, a1) on strike, C (Surya, a3) non-striker'), [c.s, c.n, c.w], ['a1', 'a3', 1]);
  eq(L('1 …and only then the next bowler is asked'), [shown(P, 'newbat-modal-overlay'), shown(P, 'newover-modal-overlay')], [false, true]);
  P.E(`closeNewOverModal(); state.bowler = { name:'Raj', id:'r1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 }; recordBall('1');`);
  ll = lastLog(P);
  eq(L('1 …the first ball of the next over is Rohit\'s (1.1), Surya at the other end — Surya on strike after the single'), [ll.over, ll.striker, ll.nonStriker, crease(P).s], ['1.1', 'a1', 'a3', 'a3']);
  prints.case1 = fingerprint(P);

  // ---- 2. the same, but they had NOT crossed --------------------------------
  setup(P); dots(P, 5);
  pv = runOut(P, { who: 'nonStriker', runs: 0, crossed: false });
  eq(L('2 not crossed: the preview — Rohit back at the striker\'s end, the new batsman faces the new over'),
    [/Rohit ends at the striker's end/.test(pv.preview), /next ball \(new over\): the new batsman faces/.test(pv.preview)], [true, true]);
  c = crease(P); ll = lastLog(P);
  eq(L('2 …B out, no run, 1.0, crossed: false kept'), [ll.out, c.r, c.ov, ll.crossed, lastDb(P).dismissal.crossed], ['a2', 0, '1.0', false, false]);
  ui = strikeUi(P);
  eq(L('2 …the incoming batter pre-selected to face'), [ui.on, /had not crossed/.test(ui.hint)], [['new'], true]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('2 …next over: C (Surya) on strike, A (Rohit) non-striker'), [c.s, c.n], ['a3', 'a1']);
  prints.case2 = fingerprint(P);

  // ---- 3. the STRIKER run out at the end of the over ----------------------------
  setup(P); dots(P, 5);
  runOut(P, { who: 'striker', runs: 0, crossed: true });
  eq(L('3a striker run out after crossing (at the bowler\'s end), last ball: A out, the new batter faces the new over'), [lastLog(P).out, strikeUi(P).on], ['a1', ['new']]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('3a …Surya on strike, Ishan (who went on to the striker\'s end) the non-striker'), [c.s, c.n, c.r], ['a3', 'a2', 0]);
  setup(P); dots(P, 5);
  runOut(P, { who: 'striker', runs: 0, crossed: false });
  eq(L('3b striker run out, not crossed (short of the striker\'s end), last ball: Ishan pre-selected'), [lastLog(P).out, strikeUi(P).on], ['a1', ['survivor']]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('3b …Ishan on strike, Surya non-striker'), [c.s, c.n], ['a2', 'a3']);

  // ---- 4. a run out in the MIDDLE of the over -----------------------------------
  setup(P); dots(P, 2);
  runOut(P, { who: 'nonStriker', runs: 0, crossed: true });
  c = crease(P);
  eq(L('4a mid-over (0.3), crossed, B out: no change of ends for an over — the new batter (at the striker\'s end) faces'), [c.ov, lastLog(P).out, strikeUi(P).on], ['0.3', 'a2', ['new']]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('4a …Surya on strike, Rohit at the bowler\'s end'), [c.s, c.n], ['a3', 'a1']);
  setup(P); dots(P, 2);
  runOut(P, { who: 'nonStriker', runs: 0, crossed: false });
  eq(L('4b mid-over, not crossed: Rohit keeps strike'), strikeUi(P).on, ['survivor']);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('4b …Rohit on strike, Surya non-striker'), [c.s, c.n], ['a1', 'a3']);
  setup(P); dots(P, 2);
  runOut(P, { who: 'striker', runs: 0, crossed: true });
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('4c mid-over, striker run out after crossing: Ishan (went on to the striker\'s end) faces next'), [lastLog(P).out, c.s, c.n], ['a1', 'a2', 'a3']);

  // ---- 5. a run COMPLETED, then a run out going for the next ----------------------
  setup(P); dots(P, 5);
  runOut(P, { who: 'nonStriker', runs: 1, crossed: true });
  c = crease(P); ll = lastLog(P);
  eq(L('5a 1 run completed, then B run out after crossing on the 2nd: +1 to the team and to Rohit, B out'), [c.r, card(P, 'a1').runs, ll.out, ll.runs, bowler(P).runs], [1, 1, 'a2', 1, 1]);
  eq(L('5a …last ball: Rohit is back at the striker\'s end (run 2, crossed) — the new batter faces the new over'), strikeUi(P).on, ['new']);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('5a …Surya on strike, Rohit non-striker'), [c.s, c.n], ['a3', 'a1']);
  setup(P); dots(P, 5);
  runOut(P, { who: 'nonStriker', runs: 1, crossed: false });
  eq(L('5b 1 run completed, B run out not having crossed on the 2nd: Rohit (at the bowler\'s end) faces the new over'), [crease(P).r, strikeUi(P).on], [1, ['survivor']]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('5b …Rohit on strike, Surya non-striker'), [c.s, c.n], ['a1', 'a3']);
  setup(P); dots(P, 1);
  runOut(P, { who: 'striker', runs: 2, crossed: true });
  c = crease(P);
  eq(L('5c mid-over: 2 run, striker run out after crossing on the 3rd — +2, Ishan (going on to the striker\'s end) faces'), [c.r, card(P, 'a1').runs, lastLog(P).out, strikeUi(P).on], [2, 2, 'a1', ['survivor']]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('5c …Ishan on strike, Surya non-striker'), [c.s, c.n], ['a2', 'a3']);

  // ---- 6. a WIDE / NO BALL on the 6th-ball position --------------------------------
  setup(P); dots(P, 5);
  runOut(P, { delivery: 'wide', who: 'nonStriker', runs: 0, crossed: true });
  c = crease(P); ll = lastLog(P);
  eq(L('6a wide + B run out after crossing: not a legal ball — still 0.5, 1 wide, B out, crossed kept'), [c.ov, c.r, ll.type, ll.out, ll.crossed], ['0.5', 1, 'WdW', 'a2', true]);
  eq(L('6a …no change of ends: the new batter (at the striker\'s end) faces the 6th legal ball'), strikeUi(P).on, ['new']);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('6a …Surya on strike, Rohit non-striker'), [c.s, c.n], ['a3', 'a1']);
  P.E(`closeNewOverModal(); recordBall('0')`);
  c = crease(P);
  eq(L('6a …the next legal ball ends the over — then Rohit faces the new over'), [c.ov, c.s, c.n], ['1.0', 'a1', 'a3']);
  setup(P); dots(P, 5);
  runOut(P, { delivery: 'noball', who: 'nonStriker', runs: 0, crossed: false });
  c = crease(P);
  eq(L('6b no ball + B run out, not crossed: still 0.5, 1 no ball, Rohit keeps strike'), [c.ov, c.r, lastLog(P).type, strikeUi(P).on], ['0.5', 1, 'NbW', ['survivor']]);
  sendIn(P, 'a3');
  P.E(`state.freeHit = false; closeNewOverModal(); recordBall('0')`);
  c = crease(P);
  eq(L('6b …the 6th legal ball ends the over: Surya faces the new over, Rohit at the other end'), [c.ov, c.s, c.n], ['1.0', 'a3', 'a1']);
  setup(P); dots(P, 5);
  runOut(P, { delivery: 'noball', who: 'striker', runs: 1, crossed: true });
  c = crease(P);
  // after the 1 run Rohit is at the bowler's end; going for the 2nd they cross, so his
  // ground is the striker's end — run out there; Ishan goes on to the bowler's end
  eq(L('6c no ball, 1 run, striker run out after crossing on the 2nd: 2 runs (nb + 1), Rohit +1 — the new batter (striker\'s end) faces, no new over'), [c.ov, c.r, card(P, 'a1').runs, lastLog(P).out, strikeUi(P).on], ['0.5', 2, 1, 'a1', ['new']]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('6c …Surya on strike, Ishan at the bowler\'s end'), [c.s, c.n], ['a3', 'a2']);

  // ---- 7. the incoming batter ---------------------------------------------------------
  setup(P); dots(P, 5);
  runOut(P, { who: 'nonStriker', runs: 0, crossed: true });
  eq(L('7 the New Batsman screen opens only after CONFIRM — the wicket is already recorded'), [crease(P).w, shown(P, 'wd-overlay'), shown(P, 'newbat-modal-overlay')], [1, false, true]);
  sendIn(P, 'a5');
  c = crease(P);
  eq(L('7 …the chosen player (Hardik, a5 — his own roster id) takes the empty end'), [c.s, c.n, P.J('state.nonStriker.name')], ['a1', 'a5', 'Hardik']);
  setup(P); dots(P, 5);
  runOut(P, { who: 'nonStriker', runs: 0, crossed: true });
  sendIn(P, 'a3', 'new');
  c = crease(P);
  eq(L('7 …the scorer may still change who faces: honoured (Surya on strike)'), [c.s, c.n], ['a3', 'a1']);
  setup(P); dots(P, 5);
  runOut(P, { who: 'nonStriker', runs: 0, crossed: true });
  click(P, '#newbat-modal-cancel');
  c = crease(P);
  eq(L('7 …skipped for now: Rohit on strike, the empty end is the non-striker\'s'), [c.s, c.end], ['a1', 'nonStriker']);
  P.E(`closeNewOverModal(); sendInNewBatsman('Surya', 'a3');`);
  c = crease(P);
  eq(L('7 …sent in later from the sidebar: Surya goes to that end'), [c.s, c.n], ['a1', 'a3']);

  // ---- 8. reload, and another device ---------------------------------------------------
  setup(P); dots(P, 5);
  runOut(P, { who: 'nonStriker', runs: 0, crossed: true });
  const savedMidWicket = P.w.localStorage.getItem('cricket-panel-state');
  sendIn(P, 'a3');
  P.E('closeNewOverModal()');
  const saved = P.w.localStorage.getItem('cricket-panel-state');
  const pushed = P.emits.filter(e => e.ev === 'updateCricketScore').slice(-1)[0].payload;
  const R = boot(file, { 'cricket-panel-state': saved });
  await sleep(80);
  c = crease(R);
  eq(L('8 reload: Rohit on strike, Surya non-striker, 1-1 wicket, 1.0, crossed kept in the ball log'), [c.s, c.n, c.w, c.ov, lastLog(R).crossed], ['a1', 'a3', 1, '1.0', true]);
  const R2 = boot(file, { 'cricket-panel-state': savedMidWicket });
  await sleep(80);
  c = crease(R2);
  eq(L('8 reload before the new batter was sent in: Rohit on strike, the empty end still the non-striker\'s'), [c.s, c.end, c.w], ['a1', 'nonStriker', 1]);
  R2.E(`sendInNewBatsman('Surya', 'a3')`);
  eq(L('8 …and the batter sent in after the reload goes to that end'), [crease(R2).s, crease(R2).n], ['a1', 'a3']);
  const D = boot(file);
  await sleep(80);
  eq(L('8 another device: it receives the room\'s state'), typeof D.handlers.liveCricketScore, 'function');
  D.handlers.liveCricketScore(JSON.parse(JSON.stringify(pushed)));
  c = crease(D);
  eq(L('8 …and shows the same crease: Rohit on strike, Surya non-striker, 1 wicket, 1.0'), [c.s, c.n, c.w, c.ov, lastLog(D).crossed], ['a1', 'a3', 1, '1.0', true]);

  // ---- 10. pressed twice ------------------------------------------------------------------
  setup(P); dots(P, 5);
  P.E('openWicketModal()'); clickType(P, 'Run Out');
  click(P, '[data-wd-who="nonStriker"]'); click(P, '[data-wd-runs="0"]'); click(P, '[data-wd-crossed="yes"]');
  click(P, '#wd-confirm'); click(P, '#wd-confirm');
  P.E('confirmWicketDetails()');
  eq(L('10 CONFIRM WICKET three times: one wicket, one delivery, over 1.0 (not 1.1)'), [crease(P).w, P.J('state.ballLog.filter(e => e.isWicket).length'), crease(P).ov, dbBalls(P).filter(b => b.kind === 'W').length], [1, 1, '1.0', 1]);
  change(P, '#newbat-modal-select', 'a3');
  click(P, '#newbat-modal-submit'); click(P, '#newbat-modal-submit');
  c = crease(P);
  eq(L('10 Send In twice: Surya seated once, Rohit still on strike'), [c.s, c.n, c.w], ['a1', 'a3', 1]);
  P.E(`closeNewOverModal(); document.getElementById('undo-btn').click()`);
  c = crease(P);
  eq(L('10 one Undo: back to before the run out — Rohit and Ishan, 0.5, no wicket'), [c.s, c.n, c.ov, c.w], ['a1', 'a2', '0.5', 0]);
  runOut(P, { who: 'nonStriker', runs: 0, crossed: true });
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('10 …scored again after the Undo: the same result, still one wicket'), [c.s, c.n, c.w, P.J('state.ballLog.filter(e => e.isWicket).length')], ['a1', 'a3', 1, 1]);

  // ---- 11. what is already scored stays as it was -------------------------------------------
  setup(P); dots(P, 5);
  // an older caller (no crossing answer): seated exactly as before this change
  P.E(`recordBall('W', { dismissalType: 'Run Out', runsCompleted: 0, runOutWho: 'nonStriker', dismissedPlayerId: 'a2', dismissedPlayerName: 'Ishan' })`);
  c = crease(P);
  eq(L('11 a Run Out recorded without the answer (older caller): seated as before — the empty end is the striker\'s for the new over'), [c.s, c.n, c.end, lastLog(P).crossed], ['a2', 'a1', 'striker', null]);
  setup(P); dots(P, 5);
  P.E(`recordBall('W', { dismissalType: 'Run Out', runsCompleted: 1, runOutWho: 'striker', dismissedPlayerId: 'a1', dismissedPlayerName: 'Rohit' })`);
  c = crease(P);
  eq(L('11 …and with a completed run: as before too'), [c.s, c.end, c.r], ['a1', 'striker', 1]);
  setup(P); dots(P, 3);
  P.E(`recordBall('W', { dismissalType: 'Bowled' })`);
  c = crease(P);
  eq(L('11 Bowled mid-over: the striker\'s end is the empty one, as always'), [c.s, c.n, c.end], ['a1', 'a2', 'striker']);
  // a match saved before this change (its ball log has no runOutCrossed) reloads unchanged
  const oldState = JSON.parse(saved);
  oldState.ballLog = oldState.ballLog.map(e => { const x = { ...e }; delete x.runOutCrossed; return x; });
  const O = boot(file, { 'cricket-panel-state': JSON.stringify(oldState) });
  await sleep(80);
  const before = { s: oldState.striker.id, n: oldState.nonStriker.id, r: oldState.score.runs, w: oldState.score.wickets, log: oldState.ballLog.length };
  c = crease(O);
  eq(L('11 a match saved before this change reloads exactly as saved'), [c.s, c.n, c.r, c.w, O.J('state.ballLog.length'), O.J(`state.ballLog.some(e => 'runOutCrossed' in e)`)], [before.s, before.n, before.r, before.w, before.log, false]);

  eq(L('no page errors'), P.errors.concat(R.errors, R2.errors, D.errors, O.errors), []);
  return prints;
}

(async () => {
  const a = await suite('cricket-panel.html');
  const b = await suite('cricket-panel3.html');
  console.log('\n######## 9. both panels, the same answers ########');
  eq('9 the reported case (crossed): both panels end in the identical state', a.case1, b.case1);
  eq('9 not crossed: both panels end in the identical state', a.case2, b.case2);
  eq('9 the two cases really differ (who faces the new over)', [a.case1.log.slice(-1)[0][3], a.case2.s], ['a1', 'a3']);
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  if(fail){ console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
