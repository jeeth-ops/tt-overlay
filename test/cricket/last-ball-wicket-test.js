// LAST-BALL WICKETS, both panels (cricket-panel.html, cricket-panel3.html).
// The real Wicket Details screen and the real New Batsman screen, driven like
// a scorer would:
//   1. CONFIRM WICKET records the dismissal — the new batsman is NOT asked
//      before it (the Wicket Details screen has no such question any more);
//   2. then the New Batsman screen asks who comes in, with "who faces the next
//      ball?" pre-selected by the Laws (a run out's crossing, the last ball of
//      the over) — and the scorer can change it.
// Checked every time by ids, not names: who was out (ball log, batting card),
// who stands at which end afterwards, the over count, one wicket only.
// Also: a second tap / Enter on either screen changes nothing, and no scoring
// shortcut ("1", "s") reaches the match while a popup is open.
//
//   node test/cricket/last-ball-wicket-test.js
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
function boot(file){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const emits = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=LB', virtualConsole: vc,
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
  return { w, errors, emits, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s), J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)),
    text: (s) => { const el = w.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; } };
}
const click = (P, sel) => { const el = P.$(sel); if(!el) throw new Error('no element ' + sel); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const clickType = (P, t) => { const el = [...P.w.document.querySelectorAll('#wd-types [data-wd-type]')].find(b => b.dataset.wdType === t); if(!el) throw new Error('no out type ' + t); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const change = (P, sel, v) => { const el = P.$(sel); el.value = v; el.dispatchEvent(new P.w.Event('change', { bubbles: true })); };
const key = (P, k) => P.w.document.body.dispatchEvent(new P.w.KeyboardEvent('keydown', { key: k, bubbles: true }));
const shown = (P, id) => P.$('#' + id).classList.contains('show');

const ROSTER = ['Rohit', 'Ishan', 'Surya', 'Tilak', 'Hardik', 'Tim', 'Krunal', 'Piyush', 'Jasprit', 'Akash', 'Arjun'];
function setup(P, opts){
  opts = opts || {};
  const names = opts.names || ROSTER;
  P.E(`
    closeNewOverModal(); closeNewBatsmanModal(); closeWicketModal();
    state = mergeWithDefaults(null);
    state.format = ${JSON.stringify(opts.format || 'T20')}; state.battingTeam = 'A';
    ${opts.overs ? `state.format = 'Custom'; state.customOvers = ${opts.overs}; state.oversPerInnings = ${opts.overs};` : ''}
    document.getElementById('match-id').value = 'LB';
    state.teamA.players = ${JSON.stringify(names)}.map((n, i) => ({ id: 'a' + (i + 1), name: n, isXI: true }));
    state.teamB.players = [{ id:'m1', name:'Mukesh', isXI:true }, { id:'r1', name:'Raj', isXI:true }, { id:'f1', name:'Jadeja', isXI:true }, { id:'k1', name:'Pant', isXI:true }];
    state.teamB.wkId = 'k1';
    state.striker    = { name: ${JSON.stringify(names[0])}, id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name: ${JSON.stringify(names[1])}, id:'a2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Mukesh', id:'m1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = []; pendingWicketDelivery = null; disarmWicketAnimation();
    renderPanel();
  `);
}
const dots = (P, n) => { for(let i = 0; i < n; i++) P.E(`recordBall('0')`); };
// The Wicket Details screen: every answer, then CONFIRM WICKET.
function wicket(P, o){
  P.E('openWicketModal()');
  clickType(P, o.type);
  if(o.delivery) click(P, `[data-wd-delivery="${o.delivery}"]`);
  if(o.who) click(P, `[data-wd-who="${o.who}"]`);
  if(o.fielder) P.E(`wdSetFielder(${JSON.stringify(o.fielder)}); renderWicketDetails();`);
  if(o.runs != null) click(P, `[data-wd-runs="${o.runs}"]`);
  // Run Out: had the batters crossed when the wicket was put down? (Law 18.12.1 — asked every time)
  if(o.type === 'Run Out') click(P, `[data-wd-crossed="${o.crossed ? 'yes' : 'no'}"]`);
  const blocked = P.$('#wd-confirm').disabled ? P.text('#wd-preview') : '';
  click(P, '#wd-confirm');
  return blocked;
}
const crease = (P) => P.J(`({ s: state.striker.id, sn: state.striker.name, n: state.nonStriker.id, nn: state.nonStriker.name, end: state.newBatsmanEnd,
  ov: state.score.overs + '.' + state.score.balls, w: state.score.wickets, r: state.score.runs })`);
const strikeUi = (P) => P.J(`({ shown: !document.getElementById('newbat-strike-wrap').hidden,
  on: [...document.querySelectorAll('#newbat-strike [data-nb-strike].on')].map(b => b.dataset.nbStrike),
  chips: [...document.querySelectorAll('#newbat-strike [data-nb-strike]')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
  hint: document.getElementById('newbat-strike-hint').textContent })`);
const lastBall = (P) => P.J(`(() => { const e = (state.ballLog || []).filter(x => x.ballType !== 'PEN').slice(-1)[0] || {};
  return { over: e.over, striker: e.strikerId || null, nonStriker: e.nonStrikerId || null, out: e.isWicket ? (e.dismissedPlayerId || null) : null }; })()`);
const wicketRows = (P) => P.J(`(state.ballLog || []).filter(e => e.isWicket).length`);
const outCard = (P) => P.J(`activeBattingCard(state.battingTeam).filter(b => b.out).map(b => b.id)`);
function sendIn(P, id, strike){
  if(strike) click(P, `[data-nb-strike="${strike}"]`);
  change(P, '#newbat-modal-select', id);
  click(P, '#newbat-modal-submit');
}

async function suite(file){
  console.log(`\n######## ${file} ########`);
  const P = boot(file);
  await sleep(80);
  const L = (s) => `${file}: ${s}`;

  // ---- 1. last-ball BOWLED -------------------------------------------------
  setup(P); dots(P, 5);
  eq(L('Wicket Details no longer asks the new batsman or the strike'), [!!P.$('#wd-sec-newbat'), !!P.$('#wd-sec-strike'), !!P.$('#wd-newbat-select')], [false, false, false]);
  wicket(P, { type: 'Bowled' });
  eq(L('bowled, last ball: recorded first — 1 wicket, over complete, Rohit (a1) out on 0.6'), [crease(P).w, crease(P).ov, lastBall(P), outCard(P), wicketRows(P)],
    [1, '1.0', { over: '0.6', striker: 'a1', nonStriker: 'a2', out: 'a1' }, ['a1'], 1]);
  eq(L('…then the New Batsman screen (not the next bowler yet)'), [shown(P, 'wd-overlay'), shown(P, 'newbat-modal-overlay'), shown(P, 'newover-modal-overlay')], [false, true, false]);
  let ui = strikeUi(P);
  eq(L('who faces next: Ishan pre-selected by the Laws (last ball of the over)'), [ui.shown, ui.on, /Ishan/.test(ui.hint), /last ball of the over/.test(ui.hint)], [true, ['survivor'], true, true]);
  const options = P.J(`[...document.getElementById('newbat-modal-select').options].map(o => o.value).filter(Boolean)`);
  eq(L('the incoming list has neither the out batter nor the one at the crease'), [options.includes('a1'), options.includes('a2'), options.includes('a3')], [false, false, true]);
  change(P, '#newbat-modal-select', 'a3');
  ui = strikeUi(P);
  eq(L('the new batter\'s chip shows the chosen name'), ui.chips[1].startsWith('Surya'), true);
  click(P, '#newbat-modal-submit');
  let c = crease(P);
  eq(L('Send In → Ishan (a2) faces the new over, Surya (a3) at the other end'), [c.s, c.n, c.w], ['a2', 'a3', 1]);
  eq(L('…and only then the next bowler is asked'), [shown(P, 'newbat-modal-overlay'), shown(P, 'newover-modal-overlay')], [false, true]);

  // ---- 2. last-ball CAUGHT ---------------------------------------------------
  setup(P); dots(P, 5);
  wicket(P, { type: 'Caught', fielder: 'f1' });
  eq(L('caught, last ball: Rohit (a1) out, caught by Jadeja'), [lastBall(P).out, P.J(`state.ballLog.slice(-1)[0].fielderId`), strikeUi(P).on], ['a1', 'f1', ['survivor']]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('caught: Ishan faces the new over'), [c.s, c.n], ['a2', 'a3']);

  // ---- 3. last-ball RUN OUT of the striker, no run --------------------------
  setup(P); dots(P, 5);
  eq(L('a run out is never pre-chosen — who is out must be answered'), (() => { P.E('openWicketModal()'); clickType(P, 'Run Out'); const r = [P.$('#wd-confirm').disabled, /choose WHO is out/.test(P.text('#wd-preview'))]; P.E('cancelWicketDetails()'); return r; })(), [true, true]);
  wicket(P, { type: 'Run Out', who: 'striker', runs: 0 });
  eq(L('striker run out, last ball: Rohit (a1) out; Ishan pre-selected to face'), [lastBall(P).out, strikeUi(P).on], ['a1', ['survivor']]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('…Ishan on strike, Surya at the non-striker\'s end'), [c.s, c.n, c.r], ['a2', 'a3', 0]);

  // ---- 4. last-ball RUN OUT of the non-striker, no run ----------------------
  setup(P); dots(P, 5);
  wicket(P, { type: 'Run Out', who: 'nonStriker', runs: 0 });
  ui = strikeUi(P);
  eq(L('non-striker run out, last ball: Ishan (a2) out — never Rohit; the new batter pre-selected to face'), [lastBall(P).out, outCard(P), ui.on, /last ball/.test(ui.hint)], ['a2', ['a2'], ['new'], true]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('…Surya faces the new over, Rohit at the other end'), [c.s, c.n], ['a3', 'a1']);

  // ---- 5. last-ball RUN OUT of the striker after 1 run (crossed) -------------
  setup(P); dots(P, 5);
  wicket(P, { type: 'Run Out', who: 'striker', runs: 1 });
  ui = strikeUi(P);
  eq(L('striker run out going for the 2nd: 1 run to Rohit and the team; the new batter faces'), [lastBall(P).out, crease(P).r, P.J(`activeBattingCard('A').find(b => b.id === 'a1').runs`), ui.on, /1 run completed/.test(ui.hint) && /had not crossed/.test(ui.hint)], ['a1', 1, 1, ['new'], true]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('…Surya on strike, Ishan at the other end'), [c.s, c.n], ['a3', 'a2']);

  // ---- 6. last-ball RUN OUT of the non-striker after 1 run ------------------
  setup(P); dots(P, 5);
  wicket(P, { type: 'Run Out', who: 'nonStriker', runs: 1 });
  eq(L('non-striker run out after 1 run: Ishan (a2) out, Rohit (survivor) pre-selected'), [lastBall(P).out, strikeUi(P).on, crease(P).r], ['a2', ['survivor'], 1]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('…Rohit on strike, Surya at the other end'), [c.s, c.n], ['a1', 'a3']);

  // ---- 7. last-ball RUN OUT of the non-striker after 2 runs -----------------
  setup(P); dots(P, 5);
  wicket(P, { type: 'Run Out', who: 'nonStriker', runs: 2 });
  eq(L('2 runs (no crossing): the new batter pre-selected'), [lastBall(P).out, strikeUi(P).on, crease(P).r], ['a2', ['new'], 2]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('…Surya on strike, Rohit at the other end'), [c.s, c.n], ['a3', 'a1']);

  // ---- 8. WIDE + run out on the 6th-ball position: not a legal ball ------
  setup(P); dots(P, 5);
  wicket(P, { type: 'Run Out', delivery: 'wide', who: 'nonStriker', runs: 0 });
  c = crease(P);
  eq(L('wide + run out: the over does not end (0.5), 1 wide, Ishan out'), [c.ov, c.r, lastBall(P).out, strikeUi(P).on], ['0.5', 1, 'a2', ['survivor']]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('…Rohit keeps strike; Surya at the non-striker\'s end'), [c.s, c.n], ['a1', 'a3']);
  P.E(`recordBall('0')`);
  eq(L('the next legal ball completes the over'), crease(P).ov, '1.0');

  // ---- 9. NO BALL + striker run out after 1 run, 6th-ball position ---------
  setup(P); dots(P, 5);
  wicket(P, { type: 'Run Out', delivery: 'noball', who: 'striker', runs: 1 });
  c = crease(P);
  eq(L('no ball + run out: not legal — still 0.5, 2 runs (nb + 1), Rohit out, Ishan pre-selected'), [c.ov, c.r, lastBall(P).out, strikeUi(P).on], ['0.5', 2, 'a1', ['survivor']]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('…Ishan on strike, Surya at the non-striker\'s end'), [c.s, c.n], ['a2', 'a3']);

  // ---- 10. the scorer changes the pre-selected answer ----------------------
  setup(P); dots(P, 5);
  wicket(P, { type: 'Bowled' });
  sendIn(P, 'a3', 'new');
  c = crease(P);
  eq(L('scorer\'s correction honoured: Surya on strike, Ishan at the other end'), [c.s, c.n], ['a3', 'a2']);

  // ---- 10b. one Undo takes back the wicket and the batter sent in ---------
  setup(P); dots(P, 5);
  wicket(P, { type: 'Bowled' });
  sendIn(P, 'a3');
  P.E(`closeNewOverModal(); document.getElementById('undo-btn').click()`);
  c = crease(P);
  eq(L('one Undo after Send In: back to before the wicket — Rohit and Ishan, 0.5, no wicket'), [c.s, c.n, c.ov, c.w], ['a1', 'a2', '0.5', 0]);

  // ---- 11. Skip for now: the empty end is kept, filled later -----------------
  setup(P); dots(P, 5);
  wicket(P, { type: 'Bowled' });
  click(P, '#newbat-modal-cancel');
  c = crease(P);
  eq(L('skipped: Ishan on strike, the empty end is the non-striker\'s'), [c.s, c.end, shown(P, 'newover-modal-overlay')], ['a2', 'nonStriker', true]);
  P.E(`closeNewOverModal(); sendInNewBatsman('Surya', 'a3');`);
  c = crease(P);
  eq(L('…the batter sent in later goes to that end'), [c.s, c.n], ['a2', 'a3']);

  // ---- 12. two taps on CONFIRM WICKET = one wicket --------------------------
  setup(P); dots(P, 5);
  P.E('openWicketModal()'); clickType(P, 'Bowled');
  click(P, '#wd-confirm'); click(P, '#wd-confirm');
  P.E('confirmWicketDetails()');
  eq(L('CONFIRM WICKET twice: one wicket, one dismissal in the ball log'), [crease(P).w, wicketRows(P), outCard(P)], [1, 1, ['a1']]);

  // ---- 13. two taps on Send In = one batter -----------------------------
  change(P, '#newbat-modal-select', 'a3');
  click(P, '#newbat-modal-submit'); click(P, '#newbat-modal-submit');
  P.$('#newbat-modal-input').dispatchEvent(new P.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  c = crease(P);
  eq(L('Send In twice (and Enter): Surya seated once, Ishan still at the crease'), [c.s, c.n], ['a2', 'a3']);

  // ---- 14. no scoring shortcut behind a popup ----------------------------
  setup(P); dots(P, 5);
  P.E('openWicketModal()'); clickType(P, 'Bowled');
  key(P, '1'); key(P, 's');
  eq(L('"1" and "s" while Wicket Details is open: no ball, no swap'), [crease(P).ov, crease(P).r, crease(P).s], ['0.5', 0, 'a1']);
  click(P, '#wd-confirm');
  key(P, 's'); key(P, '4'); key(P, 'u');
  c = crease(P);
  // (after the over-ending wicket: Ishan on strike, Rohit's out line holds the empty end)
  eq(L('"s", "4", "u" while New Batsman is open: nothing changes'), [c.s, c.n, c.ov, c.w, c.r], ['a2', 'a1', '1.0', 1, 0]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('…and the batter still goes to the right end: Ishan on strike, Surya non-striker'), [c.s, c.n], ['a2', 'a3']);
  key(P, 'Escape'); P.E('closeNewOverModal()');
  key(P, '1');
  eq(L('with no popup open the shortcuts work as before'), crease(P).ov, '1.1');

  // ---- 15. Esc on Wicket Details = Cancel (nothing recorded, no animation) --
  setup(P); dots(P, 2);
  P.E('openWicketModal()'); clickType(P, 'Bowled');
  key(P, 'Escape');
  eq(L('Esc cancels the wicket: nothing recorded, the WICKET graphic disarmed'), [shown(P, 'wd-overlay'), crease(P).w, P.E('wicketAnim === null'), P.E('wdState === null')], [false, 0, true, true]);

  // ---- 16. two players with the same name ---------------------------------
  setup(P, { names: ['Rohit', 'Rahul', 'Surya', 'Tilak', 'Hardik', 'Tim', 'Krunal', 'Piyush', 'Rahul', 'Akash', 'Arjun'] });
  dots(P, 5);
  wicket(P, { type: 'Bowled' });
  const opts16 = P.J(`[...document.getElementById('newbat-modal-select').options].map(o => o.value).filter(Boolean)`);
  eq(L('the other "Rahul" (a9) can come in — names do not exclude a different player'), opts16.includes('a9'), true);
  sendIn(P, 'a9');
  c = crease(P);
  eq(L('Rahul (a2) faces the new over, Rahul (a9) at the other end — by id'), [c.s, c.n], ['a2', 'a9']);

  // ---- 17. the innings' last ball: no new batsman ---------------------------
  setup(P, { overs: 1 }); dots(P, 5);
  wicket(P, { type: 'Bowled' });
  eq(L('a wicket on the innings\' last ball: recorded, no New Batsman screen'), [crease(P).w, crease(P).ov, shown(P, 'newbat-modal-overlay')], [1, '1.0', false]);

  // ---- 18. the WICKET graphic goes up once --------------------------------
  setup(P); dots(P, 5);
  const before = P.emits.length;
  wicket(P, { type: 'Bowled' });
  sendIn(P, 'a3');
  await sleep(3300);
  const wk = P.emits.slice(before).filter(e => e.ev === 'cricketEvent' && e.payload && e.payload.event && e.payload.event.kind === 'WICKET');
  eq(L('the WICKET graphic: once, naming Rohit'), [wk.length, wk[0] && wk[0].payload.event.sub], [1, 'Rohit']);

  // ---- 19. retired (not out): the new batter replaces them at that end -------
  setup(P); dots(P, 2);
  P.E('openWicketModal()'); clickType(P, 'Retired'); click(P, '[data-wd-who="striker"]'); click(P, '#wd-confirm');
  eq(L('retired: the New Batsman screen asks, the new batter pre-selected (the striker\'s end)'), [shown(P, 'newbat-modal-overlay'), strikeUi(P).on], [true, ['new']]);
  sendIn(P, 'a3');
  c = crease(P);
  eq(L('…Surya faces, Ishan unchanged; no wicket'), [c.s, c.n, c.w], ['a3', 'a2', 0]);

  eq(L('no script errors'), P.errors.filter(e => !/Not implemented|Could not parse CSS/.test(e)), []);
  P.w.close();
}

(async () => {
  for(const f of ['cricket-panel.html', 'cricket-panel3.html']) await suite(f);
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  if(fail){ console.log('FAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
