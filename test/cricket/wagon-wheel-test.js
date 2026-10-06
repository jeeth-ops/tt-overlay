// 🎯 WAGON WHEEL — after a scoring shot the field opens; one tap stores where
// the ball went on that delivery (ball log → live commentary, database row →
// finished-match commentary). Skip leaves it blank. The scoring itself never
// changes. Both panels, the server's setBallShot, and the scorecard's
// commentary.
//
//   node test/cricket/wagon-wheel-test.js
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
function boot(file, url){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const emits = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: url || 'https://example.test/cricket-panel?room=WW', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(ev, payload, ack){ emits.push({ ev, payload }); if(typeof ack === 'function') ack({ ok: true }); }, connected: true, disconnect(){}, io: { on(){} } });
      w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
      w.firebase = { initializeApp(){}, auth: () => ({ currentUser: null, onAuthStateChanged(){}, signInWithPopup(){}, signOut(){} }), firestore: () => ({}) };
      w.firebase.auth.GoogleAuthProvider = function(){};
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
const click = (P, sel) => { const el = typeof sel === 'string' ? P.$(sel) : sel; if(!el) throw new Error('no element ' + sel); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const key = (P, k) => P.w.document.body.dispatchEvent(new P.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

const BAT = ['Rohit Sharma','Ishan','Surya','Tilak','Hardik','Tim','Krunal','Piyush','Jasprit','Akash','Arjun'];
const BOWL = [['Raj','r1'],['Mukesh','m1'],['Aman','a9'],['Kabir','k2'],['Dev','d3'],['Om','o4'],['Sam','s5'],['Karan','c6'],['Rahul','h7'],['Pant','k1'],['Jadeja','j8']];
function setup(P){
  P.E(`
    closeWagonWheel();
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A';
    document.getElementById('match-id').value = 'WW';
    state.teamA.players = ${JSON.stringify(BAT)}.map((n, i) => ({ id: 'a' + i, name: n, isXI: true }));
    state.teamB.players = ${JSON.stringify(BOWL)}.map(([n, id]) => ({ id, name: n, isXI: true }));
    state.striker    = { name:'Rohit Sharma', id:'a0', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Raj', id:'r1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = [];
    try{ localStorage.removeItem('cricket-ball-shot-queue'); }catch(e){}
    renderPanel();
  `);
  P.emits.length = 0;
}
const open = (P) => P.$('#ww-overlay').classList.contains('show');
const lastBall = (P) => P.J('state.ballLog[state.ballLog.length - 1]');
// a point in the field (batter at the top): angle clockwise from straight behind the batter, radius 0-100
const at = (deg, r) => [r * Math.sin(deg * Math.PI / 180), -r * Math.cos(deg * Math.PI / 180)];
const pickAt = (P, deg, r) => { const [x, y] = at(deg, r); return P.J(`wwPickAt(${x}, ${y})`); };

async function panelSuite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file);
  await sleep(80);
  const L = s => `${label}: ${s}`;
  setup(P);

  eq(L('the wheel is on by default, and Match Setup has its switch'), [P.J('wwOn()'), !!P.$('#ms-wagon')], [true, true]);
  P.E(`recordBall('2')`);
  const before = P.J('[state.score.runs, state.score.wickets, state.score.balls, state.striker.name, state.ballLog.length]');
  await sleep(10);
  eq(L('TEST 1: after 2 runs the wagon wheel opens'), open(P), true);
  eq(L('TEST 2: it says which ball, who, and what it was worth'), [/Over 0\.1 · Rohit Sharma off Raj/.test(P.text('#ww-kicker')), P.text('#ww-runs')], [true, '2 runs']);
  eq(L('TEST 3: all 16 regions are drawn and labelled'), [P.w.document.querySelectorAll('#ww-svg .ww-zone').length, /Deep mid-wicket/.test(P.text('#ww-svg')), /Third man/.test(P.text('#ww-svg'))], [16, true, true]);
  eq(L('TEST 4: tapping deep mid-wicket (right-hander) picks it'), pickAt(P, 112, 80), true);
  const b = lastBall(P);
  eq(L('… stored on that delivery'), [b.shot.zone, b.shot.depth, b.shot.hand], ['midwicket', 'deep', 'R']);
  eq(L('… shown to the scorer'), P.text('#ww-pick'), '📍 Deep mid-wicket');
  eq(L('TEST 5: the score, strike and ball count are exactly what they were'), P.J('[state.score.runs, state.score.wickets, state.score.balls, state.striker.name, state.ballLog.length]'), before);
  const sent = P.emits.filter(e => e.ev === 'setBallShot').slice(-1)[0];
  eq(L('TEST 6: the database row gets it (setBallShot, same delivery id)'), [!!sent, sent && sent.payload.ballUid === b.deliveryId, sent && sent.payload.shot.zone, sent && sent.payload.matchId], [true, true, 'midwicket', 'WW']);
  eq(L('… and nothing waits on this laptop once the server has it'), P.J(`JSON.parse(localStorage.getItem('cricket-ball-shot-queue') || '[]').length`), 0);
  eq(L('TEST 7: the live state carries the shot (scorecard commentary)'), P.J('state.ballLog[state.ballLog.length - 1].shot.zone'), 'midwicket');
  await sleep(760);
  eq(L('TEST 8: the wheel closes by itself after the tap'), open(P), false);

  // inner / left-hander
  setup(P);
  P.E(`recordBall('1')`); await sleep(10);
  click(P, '#ww-hand [data-ww-hand="L"]');
  eq(L('TEST 9: left-hander — the same spot is now cover, not mid-wicket'), [pickAt(P, 112, 40), lastBall(P).shot.zone, lastBall(P).shot.depth, lastBall(P).shot.hand], [true, 'cover', 'inner', 'L']);
  eq(L('… and the batter is remembered as a left-hander'), P.J(`state.batHand['a0']`), 'L');

  // boundaries are always deep
  setup(P);
  P.E(`recordBall('4')`); await sleep(10);
  eq(L('TEST 10: a FOUR opens it too, marked FOUR'), [open(P), P.text('#ww-runs')], [true, 'FOUR']);
  pickAt(P, 250, 30);
  eq(L('… a boundary is always on the rope (deep), even tapped inside the circle'), [lastBall(P).shot.zone, lastBall(P).shot.depth, P.text('#ww-pick')], ['cover', 'deep', '📍 Deep cover']);
  setup(P);
  P.E(`recordBall('6')`); await sleep(10);
  pickAt(P, 160, 90);
  eq(L('TEST 11: a SIX over long-on'), [P.text('#ww-runs'), lastBall(P).shot.zone, lastBall(P).shot.depth], ['SIX', 'midon', 'deep']);

  // which balls ask
  const asks = async (code) => { setup(P); P.E(code); await sleep(10); const o = open(P); P.E('closeWagonWheel()'); return o; };
  eq(L('TEST 12: dot ball, wicket, plain wide, plain no ball — no wheel'), [await asks(`recordBall('0')`), await asks(`recordBall('W', { dismissalType: 'Bowled' })`), await asks(`recordBall('Wd')`), await asks(`recordBall('Nb')`)], [false, false, false, false]);
  eq(L('TEST 13: byes, leg byes, a no ball with runs, an overthrow — the wheel'),
    [await asks(`recordBall('B', { runs: 2 })`), await asks(`recordBall('LB', { runs: 1 })`), await asks(`recordBall('Nb', { runsOffBat: 2 })`), await asks(`recordBall('Nb', { byeRuns: 1 })`)], [true, true, true, true]);
  setup(P); P.E(`recordBall('LB', { runs: 3 })`); await sleep(10);
  eq(L('… marked as leg byes'), P.text('#ww-runs'), '3 leg byes'); P.E('closeWagonWheel()');

  // skip / keys
  setup(P);
  P.E(`recordBall('3')`); await sleep(10);
  click(P, '#ww-skip');
  eq(L('TEST 14: Skip closes it and stores nothing'), [open(P), lastBall(P).shot === undefined, P.emits.filter(e => e.ev === 'setBallShot').length], [false, true, 0]);
  P.E(`recordBall('1')`); await sleep(10);
  key(P, 'Escape');
  eq(L('TEST 15: Esc skips too'), open(P), false);
  P.E(`recordBall('1')`); await sleep(10);
  const runsNow = P.J('state.score.runs');
  key(P, '4');
  await sleep(10);
  eq(L('TEST 16: typing the next ball while it is open never holds the scorer up — the 4 is scored'), P.J('state.score.runs'), runsNow + 4);
  eq(L('… and the wheel is now asking about the 4'), [open(P), P.text('#ww-runs')], [true, 'FOUR']);
  P.E('closeWagonWheel()');

  // off switch
  setup(P);
  const sw = P.$('#ms-wagon'); sw.checked = false; sw.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  P.E(`recordBall('2')`); await sleep(10);
  eq(L('TEST 17: switched off in Match Setup — no wheel'), [P.J('state.wagonWheelOn'), open(P)], [false, false]);
  sw.checked = true; sw.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  P.E(`recordBall('2')`); await sleep(10);
  click(P, '#ww-off');
  eq(L('TEST 18: "Turn off" in the wheel switches it off'), [open(P), P.J('state.wagonWheelOn'), P.$('#ms-wagon').checked], [false, false, false]);

  // offline: kept on the laptop, sent later
  setup(P);
  P.E(`socket.connected = false; recordBall('2');`); await sleep(10);
  pickAt(P, 300, 70);
  eq(L('TEST 19: offline — the shot waits on this laptop'), P.J(`JSON.parse(localStorage.getItem('cricket-ball-shot-queue') || '[]').map(x => x.shot.zone)`), ['point']);
  eq(L('… and rides inside the ball\'s own outbox entry too'), P.J(`ballOutbox.slice(-1)[0].payload.shot.zone`), 'point');
  P.E(`socket.connected = true; flushShotQueue();`);
  eq(L('… then goes once the line is back'), [P.emits.filter(e => e.ev === 'setBallShot').length, P.J(`JSON.parse(localStorage.getItem('cricket-ball-shot-queue') || '[]').length`)], [1, 0]);

  // ---- batting hand: asked with the batters, used by the wheel ----
  setup(P);
  const handOn = (id) => { const b = P.$(`#${id} .on`); return b ? b.dataset.bh : null; };
  eq(L('HAND 1: the Players card asks both batters (right-hand by default)'), [handOn('bh-striker'), handOn('bh-nonstriker')], ['R', 'R']);
  click(P, '#bh-striker [data-bh="L"]');
  eq(L('HAND 2: striker marked left-handed — kept for the match and on the squad player'), [P.J(`state.batHand['a0']`), P.J(`state.teamA.players.find(p => p.id === 'a0').hand`), handOn('bh-striker')], ['L', 'L', 'L']);
  P.E(`recordBall('1')`); await sleep(10);
  eq(L('HAND 3: the wheel opens the left-hander\'s way round by itself'), [P.J('ww.hand'), P.$('#ww-hand .on').dataset.wwHand], ['L', 'L']);
  P.E('closeWagonWheel()');
  P.E(`recordBall('2')`); await sleep(10);
  eq(L('HAND 4: the right-handed partner (now on strike) gets the right-hander\'s field'), P.J('ww.hand'), 'R');
  click(P, '#ww-hand [data-ww-hand="L"]');
  eq(L('HAND 5: flipping it in the wheel updates that batter too'), [P.J(`state.batHand['a1']`), handOn('bh-striker')], ['L', 'L']);
  P.E('closeWagonWheel()');
  // a new batter through the New Batsman popup
  P.E(`openNewBatsmanModal('Ishan')`);
  eq(L('HAND 6: the New Batsman popup asks too (right-hand by default)'), [!!P.$('#newbat-modal-hand'), handOn('newbat-modal-hand')], [true, 'R']);
  const sel = P.$('#newbat-modal-select'); sel.value = 'a5'; sel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  click(P, '#newbat-modal-hand [data-bh="L"]');
  click(P, '#newbat-modal-submit');
  eq(L('HAND 7: sent in as a left-hander'), [P.J(`state.batHand['a5']`), P.J(`state.teamA.players.find(p => p.id === 'a5').hand`)], ['L', 'L']);
  P.E(`state.teamA.players.find(p => p.id === 'a6').hand = 'L'; openNewBatsmanModal('Tim');`);
  const sel2 = P.$('#newbat-modal-select'); sel2.value = 'a6'; sel2.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  eq(L('HAND 8: a batter already known as a left-hander is pre-selected Left'), handOn('newbat-modal-hand'), 'L');
  P.E('closeNewBatsmanModal()');
  // the Wicket Details screen
  eq(L('HAND 9: Wicket Details asks the incoming batter\'s hand'), !!P.$('#wd-sec-newbat #wd-newbat-hand'), true);
  P.E(`wdState = { newHand: 'L' }; wdSeatNewBatsmanAndStrike('Ishan', { name: 'Piyush', id: 'a7' }, false); wdState = null;`);
  eq(L('HAND 10: confirming the wicket stores the new batter\'s hand'), P.J(`state.batHand['a7']`), 'L');
  eq(L('HAND 11: the squad carries it to the next match'), P.J(`squadSnapshotOf(state.teamA).players.filter(p => p.hand === 'L').map(p => p.id).sort()`), ['a0', 'a1', 'a5', 'a6', 'a7']);

  eq(L('no script errors'), P.errors, []);
  P.w.close();
}

async function serverSuite(){
  console.log('\n######## SERVER — setBallShot / public ball ########');
  const src = H.src;
  const sanitizeShot = new Function(H.grabConst('SHOT_ZONES') + H.grab('sanitizeShot') + '; return sanitizeShot;')();
  eq('SERVER: a known region is kept, rounded and clamped', sanitizeShot({ zone: 'cover', depth: 'deep', hand: 'L', x: -0.83456, y: 9 }), { zone: 'cover', depth: 'deep', hand: 'L', x: -0.835, y: 1.2 });
  eq('SERVER: anything else is refused (no free text ever stored)', [sanitizeShot({ zone: '<b>x</b>' }), sanitizeShot(null), sanitizeShot('cover')], [null, null, null]);
  // the socket handler itself, cut out of server.js
  const start = src.indexOf("socket.on('setBallShot'");
  const open = src.indexOf('{', src.indexOf('=>', start));
  let depth = 0, end = open;
  for(let j = open; j < src.length; j++){ if(src[j] === '{') depth++; else if(src[j] === '}'){ depth--; if(depth === 0){ end = j; break; } } }
  const body = src.slice(open, end + 1);
  const balls = H.coll([{ matchId: 'M1', ballUid: 'u1', kind: '2', runs: 2 }]);
  const handler = new Function('ballsCollection', 'safeMatchId', 'sanitizeShot', 'matchIdForClient', 'return async (data, ack) => ' + body)(balls, (id) => id ? String(id) : null, sanitizeShot, null);
  const call = (d) => new Promise(r => handler(d, r));
  let ack = await call({ matchId: 'M1', ballUid: 'u1', shot: { zone: 'midwicket', depth: 'deep', hand: 'R', x: 0.7, y: 0.3 } });
  eq('SERVER: setBallShot stores the region on that delivery only', [ack.ok, balls.docs[0].shot && balls.docs[0].shot.zone, balls.docs[0].runs, balls.docs[0].kind], [true, 'midwicket', 2, '2']);
  ack = await call({ matchId: 'M1', ballUid: 'nope', shot: { zone: 'cover' } });
  eq('SERVER: a ball not stored yet → retry later', [ack.ok, ack.retry], [false, true]);
  ack = await call({ matchId: 'M1', ballUid: 'u1', shot: { zone: 'evil' } });
  eq('SERVER: a bad region is refused and never retried', [ack.ok, ack.retry, balls.docs[0].shot.zone], [false, false, 'midwicket']);
  const mapBall = new Function(H.grabConst('SHOT_ZONES') + H.grab('sanitizeShot') + H.grab('normalizeKindForPublic') + H.grab('mapBallForPublic') + '; return mapBallForPublic;')();
  eq('SERVER: the public ball log (finished-match commentary) carries it', mapBall(balls.docs[0]).shot, { zone: 'midwicket', depth: 'deep', hand: 'R', x: 0.7, y: 0.3 });
  eq('SERVER: … and logBall stores it when the ball arrives with one', /\.\.\.\(sanitizeShot\(data\.shot\) \? \{ shot: sanitizeShot\(data\.shot\) \} : \{\}\)/.test(src), true);
}

async function scorecardSuite(){
  console.log('\n######## SCORECARD — commentary ########');
  const S = boot('cricket-scorecard.html', 'https://example.test/cricket-scorecard?room=WW');
  await sleep(300);
  const line = (b) => S.J(`commentaryLine(${JSON.stringify(b)}).text`);
  const base = { striker: 'Rohit Sharma', bowler: 'Deepak Chahar' };
  eq('COMMENTARY: FOUR through the covers', line({ ...base, ballType: '4', runs: 4, shot: { zone: 'cover', depth: 'deep' } }), 'FOUR! Rohit Sharma finds the boundary through the covers off Deepak Chahar');
  eq('COMMENTARY: SIX over long-on', line({ ...base, ballType: '6', runs: 6, shot: { zone: 'midon', depth: 'deep' } }), 'SIX! Rohit Sharma sends Deepak Chahar over long-on');
  eq('COMMENTARY: 2 runs to deep mid-wicket', line({ ...base, ballType: '2', runs: 2, shot: { zone: 'midwicket', depth: 'deep' } }), '2 runs. Rohit Sharma works it to deep mid-wicket and they come back for two, off Deepak Chahar');
  eq('COMMENTARY: a single to cover', line({ ...base, ballType: '1', runs: 1, shot: { zone: 'cover', depth: 'inner' } }), '1 run. Rohit Sharma pushes it to cover for a single, off Deepak Chahar');
  eq('COMMENTARY: FOUR behind square on the leg side', line({ ...base, ballType: '4', runs: 4, shot: { zone: 'squareleg', depth: 'deep' } }), 'FOUR! Rohit Sharma finds the boundary behind square on the leg side off Deepak Chahar');
  eq('COMMENTARY: leg byes off the pad', line({ ...base, ballType: 'LB', runs: 1, shot: { zone: 'fineleg', depth: 'inner' } }), '1 run (Leg Bye) — off the pad to short fine leg');
  eq('COMMENTARY: a ball nobody marked reads exactly as before', line({ ...base, ballType: '2', runs: 2 }), '2 runs. Rohit Sharma off Deepak Chahar');
  eq('COMMENTARY: an unknown region is ignored', line({ ...base, ballType: '4', runs: 4, shot: { zone: '<img>' } }), 'FOUR! Rohit Sharma finds the gap off Deepak Chahar');
  eq('COMMENTARY: no script errors', S.errors, []);
  S.w.close();
}

(async () => {
  await panelSuite('cricket-panel.html', 'CLIPPER');
  await panelSuite('cricket-panel3.html', 'STREAM ENGINE');
  await serverSuite();
  await scorecardSuite();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
