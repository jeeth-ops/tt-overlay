// ↩️ UNDO — instant, exact, and kept within browser storage. Both panels.
//
// The lag: every scoring action and every Undo wrote the whole undo stack —
// up to 300 complete copies of the match state, ball log included — to
// browser storage. On a Test match that is a 228 MB string (over a second
// frozen per click) and far past the ~5 MB storage holds, so the write failed
// and the old stack that last fitted stayed behind, filling storage for
// everything else (the wagon wheel's shot queue too — see
// shot-persistence-test.js).
//
//   1. exactness: runs, 4, 6, wide, no ball + runs, byes, leg byes, overthrow,
//      bowled + new batter, run out after completed runs, a run out off a no
//      ball, the over's last ball — every Undo puts the match back to exactly
//      the state before that action, one step per press; Undo then a new ball
//   2. the wagon wheel: a shot stays on its ball when a LATER ball is undone,
//      and goes with its ball when that ball is undone
//   3. a Test-size match (1,000+ deliveries, 300 undo steps): Undo and scoring
//      take milliseconds, snapshots share unchanged deliveries, a restored
//      state never edits the stack
//   4. a reload keeps the latest undo steps (same exact states), the old
//      full-copy stack is read once and removed, storage stays within budget
//      — even with storage already full
//   5. the Undo button: a press while an undo is still running is not a second undo
//
//   node test/cricket/undo-history-test.js     (npm install --no-save jsdom)
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
function ok(name, cond, detail){ eq(name + (cond ? '' : ' — ' + detail), !!cond, true); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function boot(file){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const emits = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=UNDO', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(ev, payload, ack){ emits.push({ ev, payload }); if(typeof ack === 'function') ack({ ok: true }); }, connected: true, disconnect(){}, io: { on(){} } });
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.firebase = undefined; w.alert = () => {}; w.confirm = () => true;
      w.crypto = w.crypto || {};
      if(!w.crypto.randomUUID) w.crypto.randomUUID = () => 'uuid-' + Math.random().toString(36).slice(2);
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { w: dom.window, E: (c) => dom.window.eval(c), J: (c) => JSON.parse(dom.window.eval(`JSON.stringify(${c})`)), errors, emits };
}

// the state as an exact fingerprint — minus the push counter every update
// bumps, and the two stat-card display flags a wicket's own 7-second card
// timer flips by itself (that timer is not part of the undo stack)
const SIG = `(() => { const s = JSON.parse(JSON.stringify(state)); delete s.localRev; delete s.localRevAt; delete s.showPlayerStatCard; delete s.showBowlerStatCard; return JSON.stringify(s); })()`;

async function suite(file){
  console.log(`\n######## ${file} ########`);
  const P = boot(file);
  await sleep(50);
  const L = (t) => `${file}: ${t}`;
  const newMatch = (format) => P.E(`
    state = mergeWithDefaults(null);
    state.format = ${JSON.stringify(format || 'T20')}; state.battingTeam = 'A'; state.wagonWheelOn = false;
    state.teamA.name = 'Lions'; state.teamA.short = 'LIO'; state.teamB.name = 'Tigers'; state.teamB.short = 'TIG';
    state.striker    = { name:'Striker', id:'p1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'NonStriker', id:'p2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler     = { name:'Bowler', id:'p9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; clearAutoCardFlow(); renderPanel();
  `);
  const undo = async () => { P.E(`document.getElementById('undo-btn').click()`); await sleep(5); };

  console.log('\n=== 1. Every Undo puts back exactly the state before that action ===');
  newMatch();
  const actions = [
    // over 1: 1, 4, 6, wide, no ball + 4, 2 byes, 1 leg bye, overthrow (its 6th legal ball ends the over)
    `recordBall('1')`, `recordBall('4')`, `recordBall('6')`, `recordBall('Wd', { extraRuns: 1 })`,
    `recordBall('Nb', { runsOffBat: 4 })`, `recordBall('B', { runs: 2 })`, `recordBall('LB', { runs: 1 })`,
    `recordBall('OT', { runsCompleted: 2, boundary: true, crossed: false })`,
    `applyBowlerChange('Second Bowler', 'p8'); closeNewOverModal();`,
    // over 2: bowled, run out after 2 completed runs, run out off a no ball, then 0 2 3 1 (the over's last ball)
    `recordBall('W', { dismissalType: 'Bowled' })`, `sendInNewBatsman('Third', 'p3')`,
    `recordBall('W', { dismissalType: 'Run Out', runsCompleted: 2, fielderName: 'Fielder', runOutWho: 'nonStriker' })`, `sendInNewBatsman('Fourth', 'p4')`,
    `recordBall('NbW', { dismissalType: 'Run Out', runsOffBat: 1, fielderName: 'Fielder', runOutWho: 'nonStriker' })`, `sendInNewBatsman('Fifth', 'p5')`,
    `recordBall('0')`, `recordBall('2')`, `recordBall('3')`, `recordBall('1')`
  ];
  const before = [];
  for(const a of actions){ before.push(P.E(SIG)); P.E(a); }
  eq(L('both overs were bowled, the last ball ending the 2nd'), P.J('[state.score.overs, state.score.balls, state.ballLog.length]'), [2, 0, 15]);
  const steps = P.J('history.length');
  const after = [];
  for(let i = 0; i < steps; i++){ const h0 = P.J('history.length'); await undo(); after.push(P.E(SIG)); eq(L(`Undo ${i + 1}: exactly one step back`), P.J('history.length'), h0 - 1); }
  // every state the operator was in before an action comes back, newest first
  let at = 0;
  const found = before.slice().reverse().map(s => { const k = after.indexOf(s, at); if(k >= 0) at = k + 1; return k >= 0; });
  eq(L('every pre-action state comes back, in order (runs, 4, 6, wide, no ball, byes, leg byes, overthrow, bowled, run out + runs, run out off a no ball, over end)'), found.every(Boolean), true);
  eq(L('the last Undo is the empty match'), after[after.length - 1], before[0]);
  eq(L('nothing left to undo'), P.J('[state.ballLog.length, history.length, state.score.runs, state.score.overs, state.score.balls]'), [0, 0, 0, 0, 0]);
  // Undo, then a new ball, then Undo again
  P.E(`recordBall('4')`); const s4 = P.E(SIG); P.E(`recordBall('1')`);
  await undo();
  eq(L('Undo after two balls: back to after the first'), P.E(SIG), s4);
  P.E(`recordBall('6')`);
  eq(L('a new ball after Undo scores normally'), P.J('[state.score.runs, state.ballLog.length, state.ballLog.map(b => b.ballType)]'), [10, 2, ['4', '6']]);
  await undo(); eq(L('…and is undone in its turn'), P.E(SIG), s4);

  console.log('\n=== 2. The wagon wheel follows the ball it was marked on ===');
  newMatch();
  P.E(`recordBall('4'); setBallShot(state.ballLog[0], { zone:'cover', depth:'deep', hand:'R', x:-0.7, y:0.7 });`);
  P.E(`recordBall('2')`);
  await undo();
  eq(L('undoing a LATER ball keeps the shot on this one'), P.J('state.ballLog.map(b => b.shot && b.shot.zone)'), ['cover']);
  await undo();
  eq(L('undoing the ball itself takes its shot with it'), P.J('state.ballLog.length'), 0);

  console.log('\n=== 3. A Test-size match: milliseconds, shared copies, a stack that is never edited ===');
  newMatch('Test');
  P.E(`for(let i = 0; i < 1050; i++) recordBall(['1','0','4','2','0','6','1','0'][i % 8]);`);
  eq(L('1,050 deliveries, 300 undo steps'), P.J('[state.ballLog.length, history.length]'), [1050, 300]);
  const t = P.J(`(() => { const r = {}; let t0 = performance.now(); recordBall('1'); r.ball = performance.now() - t0;
    t0 = performance.now(); deleteLastBall(); pushState(true, true); r.undo = performance.now() - t0;
    t0 = performance.now(); snapshot(); r.snap = performance.now() - t0; return r; })()`);
  ok(L(`scoring a ball takes milliseconds (${t.ball.toFixed(0)} ms)`), t.ball < 250, 'too slow');
  ok(L(`Undo takes milliseconds (${t.undo.toFixed(0)} ms)`), t.undo < 250, 'too slow');
  eq(L('snapshots share every delivery that did not change'), P.J('[history[0].ballLog[0] === history[history.length - 1].ballLog[0], history[10].ballLog[500] === history[200].ballLog[500]]'), [true, true]);
  P.E(`deleteLastBall(); pushState(true, true);`);
  const top = P.E(`JSON.stringify(history[history.length - 1].ballLog[0])`);
  P.E(`state.ballLog[0].shot = { zone: 'point', depth: 'inner', hand: 'R', x: -0.3, y: 0 }; state.ballLog[0].runs = 99;`);
  eq(L('editing the live state after an Undo never edits a snapshot'), P.E(`JSON.stringify(history[history.length - 1].ballLog[0])`), top);
  P.E(`state.ballLog[0].runs = 1; delete state.ballLog[0].shot;`);

  console.log('\n=== 4. A reload keeps the latest undo steps, within storage ===');
  newMatch();
  const sigs = [];
  for(const a of [`recordBall('1')`, `recordBall('4')`, `recordBall('Wd')`, `recordBall('W', { dismissalType: 'Caught', fielderName: 'Slip' })`, `sendInNewBatsman('Third', 'p3')`, `recordBall('6')`]){ sigs.push(P.E(SIG)); P.E(a); }
  P.E(`_writeHistoryNow()`);
  const stored = P.J(`(() => { const r = localStorage.getItem('cricket-panel-history-v2'); return { len: r ? r.length : 0, v: r ? JSON.parse(r).v : null, snaps: r ? JSON.parse(r).snaps.length : 0 }; })()`);
  eq(L('the stack is stored in the shared form'), [stored.v, stored.snaps], [2, P.J('history.length')]);
  // a reload: the stack is read back from storage
  P.E(`history = loadHistory();`);
  const back = [];
  while(P.J('history.length')){ await undo(); back.push(P.E(SIG)); }
  eq(L('after a reload every Undo still lands on the exact earlier state'), back, sigs.slice().reverse());
  // the old format (every snapshot in full) is read once, then removed
  newMatch(); P.E(`recordBall('1'); recordBall('2');`);
  const oldStack = P.E(`JSON.stringify(history)`); const oldSig = P.E(SIG);
  P.E(`localStorage.removeItem('cricket-panel-history-v2'); localStorage.setItem('cricket-panel-history', ${JSON.stringify(oldStack)}); history = loadHistory();`);
  eq(L('the old full-copy stack still undoes after the update'), P.J('history.length'), 2);
  eq(L('…and is removed from storage at once'), P.J(`localStorage.getItem('cricket-panel-history')`), null);
  await sleep(450);
  eq(L('…its steps kept in the new form instead'), P.J(`JSON.parse(localStorage.getItem('cricket-panel-history-v2') || '{}').snaps.length`), 2);
  await undo(); await undo();
  eq(L('…landing on the right states'), P.J('state.ballLog.length'), 0);
  void oldSig;
  // storage already (nearly) full: never an error, never a stale stack left behind
  newMatch('Test');
  P.E(`for(let i = 0; i < 400; i++) recordBall('1');`);
  const filled = P.J(`(() => { let n = 0; for(const size of [100000, 10000, 1000, 100, 10, 1]){ try { for(;; n++) localStorage.setItem('filler-' + n, 'x'.repeat(size)); } catch(e) {} } return n; })()`);
  ok(L(`storage filled to its last character (${filled} items)`), filled > 0, 'storage has no limit here');
  const res = P.J(`(() => { try { _writeHistoryNow(); return 'no error'; } catch(e) { return e.message; } })()`);
  eq(L('writing the stack with storage full raises no error'), res, 'no error');
  P.E(`Object.keys(localStorage).filter(k => k.startsWith('filler-')).forEach(k => localStorage.removeItem(k));`);
  P.E(`_writeHistoryNow()`);
  const sz = P.J(`(localStorage.getItem('cricket-panel-history-v2') || '').length`);
  ok(L(`with room again, the stack is kept, within its budget (${sz} chars)`), sz > 0 && sz <= P.J('HISTORY_PERSIST_BUDGET'), 'over budget');
  eq(L('no more than the latest steps are kept'), P.J(`JSON.parse(localStorage.getItem('cricket-panel-history-v2')).snaps.length <= HISTORY_PERSIST_MAX`), true);

  console.log('\n=== 5. The Undo button: one press, one undo ===');
  newMatch();
  P.E(`recordBall('1'); recordBall('2'); recordBall('3');`);
  eq(L('quick presses, one after another: each one undoes one ball'), P.J(`(() => { const b = document.getElementById('undo-btn'); b.click(); const a = state.ballLog.length; b.click(); return [a, state.ballLog.length]; })()`), [2, 1]);
  // the one undo that waits on the network (no local snapshot, a wicket — the owner's server path)
  newMatch();
  P.E(`recordBall('W', { dismissalType: 'Bowled' }); history = []; isOwnerOperator = true; window.__srv = 0;
       deleteLastBallViaServer = async () => { window.__srv++; await new Promise(r => setTimeout(r, 80)); return { ok: false }; };`);
  P.E(`document.getElementById('undo-btn').click(); document.getElementById('undo-btn').click(); document.getElementById('undo-btn').click();`);
  await sleep(150);
  eq(L('three presses while the server undo is on its way: ONE server undo'), P.J('window.__srv'), 1);
  P.E(`document.getElementById('undo-btn').click();`); await sleep(150);
  eq(L('once it has answered, the next press is a new undo'), P.J('window.__srv'), 2);
  P.E(`isOwnerOperator = false;`);

  eq(L('no script errors'), P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

(async () => {
  for(const f of ['cricket-panel.html', 'cricket-panel3.html']) await suite(f);
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
