// ⏱ END-OF-OVER GRAPHICS — on air exactly 2 seconds after the over. Both panels.
//
// The three automatic between-overs graphics (Over Summary → Batting card →
// Bowling card — one per over, the overlay rotates them) come from one
// cricketOverSummary event. It now goes out OVER_END_GRAPHICS_DELAY_MS after
// the over's last ball; the score itself is never held back.
//   1. the over's last ball: the score goes out at once, the graphic not yet;
//      at 2 s exactly one, painted from the over as it ended (a ball of the
//      next over scored meanwhile changes nothing in it)
//   2. a wide / no ball never ends an over; an over with extras still gets one
//   3. Undo of the over's last ball within the 2 s: nothing on air; that ball
//      re-bowled: its own graphic 2 s later, once
//   4. Undo of something that is not a delivery (the bowler named for the next
//      over): the graphic still goes
//   5. Reset, or switching match, within the 2 s: nothing on air
//   6. a wicket off the over's last ball: one graphic; and undoing the new
//      batter takes the pending "SHOW BATSMAN CARD?" for them with it
//   7. not connected when the 2 s are up: nothing sent, no error
//
//   node test/cricket/over-end-delay-test.js     (npm install --no-save jsdom)
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
  const net = { emits: [], connected: true };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=OVEREND', virtualConsole: vc,
    beforeParse(w){
      const sock = { on(){}, emit(ev, payload, ack){ net.emits.push({ ev, payload, at: Date.now() }); if(typeof ack === 'function') ack({ ok: true }); }, disconnect(){}, io: { on(){} } };
      Object.defineProperty(sock, 'connected', { get: () => net.connected });
      w.io = () => sock;
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.firebase = undefined; w.alert = () => {}; w.confirm = () => true;
      w.crypto = w.crypto || {};
      if(!w.crypto.randomUUID) w.crypto.randomUUID = () => 'uuid-' + Math.random().toString(36).slice(2);
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { w: dom.window, E: (c) => dom.window.eval(c), J: (c) => JSON.parse(dom.window.eval(`JSON.stringify(${c})`)), errors, net };
}

async function suite(file){
  console.log(`\n######## ${file} ########`);
  const P = boot(file);
  await sleep(50);
  const L = (t) => `${file}: ${t}`;
  const cards = () => P.net.emits.filter(e => e.ev === 'cricketOverSummary');
  const newMatch = (id) => {
    P.E(`
      document.getElementById('match-id').value = ${JSON.stringify(id || 'OVEREND')};
      state = mergeWithDefaults(null); state.format = 'T20'; state.battingTeam = 'A'; state.wagonWheelOn = false;
      state.teamA.name = 'Lions'; state.teamB.name = 'Tigers';
      state.striker = { name:'Striker', id:'p1', runs:0, balls:0, fours:0, sixes:0 };
      state.nonStriker = { name:'NonStriker', id:'p2', runs:0, balls:0, fours:0, sixes:0 };
      state.bowler = { name:'Bowler', id:'p9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
      history = []; clearAutoCardFlow(); cancelPendingOverEndGraphics(); renderPanel();
    `);
    P.net.emits.length = 0;
  };
  const fiveBalls = () => P.E(`['1','0','4','0','2'].forEach(k => recordBall(k));`);

  console.log('\n=== 1. The over\'s last ball: score at once, the graphic 2 s later ===');
  newMatch();
  fiveBalls();
  const t0 = Date.now();
  P.E(`recordBall('1')`);
  eq(L('the score goes out at once'), P.net.emits.some(e => e.ev === 'updateCricketScore' && e.payload.score && e.payload.score.overs === 1 && e.payload.score.balls === 0), true);
  eq(L('the over is saved at once'), P.J('state.overHistory.map(o => [o.overNumber, o.runs])'), [[1, 8]]);
  eq(L('the graphic is not on air yet'), cards().length, 0);
  // the next over starts at once: a new bowler and a ball, a second later
  P.E(`applyBowlerChange('Second Bowler', 'p8'); closeNewOverModal();`);
  await sleep(1000);
  P.E(`recordBall('6')`);
  await sleep(850);
  eq(L('still nothing at 1.85 s'), cards().length, 0);
  await sleep(300);
  const c = cards();
  eq(L('at 2 s: exactly one'), c.length, 1);
  const lag = c.length ? c[0].at - t0 : -1;
  eq(L(`on air 2.0 s after the over (${lag} ms)`), lag >= 1990 && lag < 2150, true);
  eq(L('painted from the over as it ended — not the ball of over 2 scored meanwhile'), c.length && [c[0].payload.data.overNumber, c[0].payload.data.score, c[0].payload.data.overs, c[0].payload.data.ballsIntoOver, c[0].payload.data.bowler.name], [1, 8, 1, 0, 'Bowler']);
  await sleep(2300);
  eq(L('and only once'), cards().length, 1);

  console.log('\n=== 2. Wides and no balls never end an over ===');
  newMatch();
  P.E(`['1','Wd','0','Nb','4','0','2'].forEach(k => recordBall(k));`);
  eq(L('6 deliveries with a wide and a no ball: the over is not over'), [P.J('[state.score.overs, state.score.balls]'), P.J('pendingOverEnd === null')], [[0, 5], true]);
  P.E(`recordBall('1')`);
  await sleep(2150);
  eq(L('the 6th LEGAL ball ends it: one graphic'), cards().map(x => x.payload.data.overNumber), [1]);

  console.log('\n=== 3. Undo of the over\'s last ball within the 2 s ===');
  newMatch();
  fiveBalls(); P.E(`recordBall('4')`);
  await sleep(600);
  P.E(`document.getElementById('undo-btn').click()`);
  await sleep(1700);
  eq(L('nothing on air for an over that was undone'), cards().length, 0);
  eq(L('the over is back to 5 balls'), P.J('[state.score.overs, state.score.balls]'), [0, 5]);
  const t1 = Date.now();
  P.E(`recordBall('2')`);
  await sleep(2150);
  const c3 = cards();
  eq(L('the re-bowled last ball: its own graphic, once, 2 s later — the over\'s runs counted again from its balls (1 0 4 0 2 + 2)'), [c3.length, c3.length && c3[0].at - t1 >= 1990, c3.length && c3[0].payload.data.overRuns], [1, true, 9]);

  console.log('\n=== 4. Undo of something that is not a delivery ===');
  newMatch();
  fiveBalls(); P.E(`recordBall('1')`);
  P.E(`applyBowlerChange('Second Bowler', 'p8'); closeNewOverModal();`);
  P.E(`document.getElementById('undo-btn').click()`); // takes back the bowler, not the ball
  await sleep(2150);
  eq(L('the over still stands: its graphic goes on air'), [cards().length, P.J('state.ballLog.length')], [1, 6]);

  console.log('\n=== 5. Reset or a new match within the 2 s ===');
  newMatch();
  fiveBalls(); P.E(`recordBall('1')`);
  await sleep(500);
  P.E(`document.getElementById('match-id').value = 'ANOTHER-MATCH';`);
  await sleep(1700);
  eq(L('switching match: the last one\'s graphic never comes up'), cards().length, 0);
  newMatch();
  fiveBalls(); P.E(`recordBall('1')`);
  P.E(`state = mergeWithDefaults(null); history = []; saveHistoryLocal(); cancelPendingOverEndGraphics();`); // what Reset does
  await sleep(2150);
  eq(L('Reset: nothing'), cards().length, 0);

  console.log('\n=== 6. Wickets ===');
  newMatch();
  fiveBalls(); P.E(`recordBall('W', { dismissalType: 'Bowled' }); sendInNewBatsman('Third', 'p3');`);
  await sleep(2150);
  eq(L('a wicket off the over\'s last ball: one graphic'), cards().map(x => [x.payload.data.overNumber, x.payload.data.overWickets]), [[1, 1]]);
  newMatch();
  P.E(`recordBall('1'); recordBall('W', { dismissalType: 'Bowled' }); sendInNewBatsman('Third', 'p3');`);
  const popup = () => P.E(`document.getElementById('auto-card-modal-overlay').classList.contains('show')`);
  eq(L('the new batter asks "SHOW BATSMAN CARD?"'), popup(), true);
  P.E(`document.getElementById('undo-btn').click()`);
  await sleep(20);
  eq(L('undoing the new batter takes that pending card with it'), [popup(), P.J('state.showPlayerStatCard')], [false, false]);
  await sleep(7200);
  eq(L('…and it never comes up on its own 7 s later'), [P.net.emits.filter(e => e.ev === 'cricketPlayerStat').length, P.J('state.showPlayerStatCard')], [0, false]);

  console.log('\n=== 7. Not connected when the 2 s are up ===');
  newMatch();
  fiveBalls(); P.E(`recordBall('1')`);
  P.net.connected = false;
  await sleep(2150);
  P.net.connected = true;
  eq(L('nothing sent, nothing pending, no error'), [cards().length, P.J('pendingOverEnd === null')], [0, true]);

  eq(L('no script errors'), P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

(async () => {
  await Promise.all(['cricket-panel.html', 'cricket-panel3.html'].map(suite));
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
