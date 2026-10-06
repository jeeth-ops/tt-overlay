// END-OVER LINEUPS — the cricketOverSummary payload carries the WHOLE Playing
// XI of both sides with live statuses (striker / non-striker / out / yet to
// bat; current / bowled / yet to bowl), in batting and bowling order — on
// BOTH panels.
//
//   node test/cricket/end-over-test.js
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

const BAT = ['Rohit','Ishan','Surya','Tilak','Hardik','Tim','Krunal','Piyush','Jasprit','Akash','Arjun'];
const BOWL = [['Raj','r1'],['Mukesh','m1'],['Aman','a9'],['Kabir','k2'],['Dev','d3'],['Om','o4'],['Sam','s5'],['Karan','c6'],['Rahul','h7'],['Pant','k1'],['Jadeja','j8']];
function setup(P){
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A';
    document.getElementById('match-id').value = 'EO';
    state.teamA.players = ${JSON.stringify(BAT)}.map((n, i) => ({ id: 'a' + i, name: n, isXI: true })).concat([{ id: 'sub1', name: 'Twelfth Man', isXI: false }]);
    state.teamB.players = ${JSON.stringify(BOWL)}.map(([n, id]) => ({ id, name: n, isXI: true }));
    state.striker    = { name:'Rohit', id:'a0', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Raj', id:'r1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = [];
    renderPanel();
  `);
  P.emits.length = 0;
}
const summaries = (P) => P.emits.filter(e => e.ev === 'cricketOverSummary').map(e => e.payload.data);
function nextOver(P, name, id){ P.E(`closeNewOverModal(); setLiveBowler(${JSON.stringify(name)}, ${JSON.stringify(id)}); renderPanel();`); }
function wicket(P, newBat, newId){ P.E(`recordBall('W', { dismissalType: 'Bowled' }); sendInNewBatsman(${JSON.stringify(newBat)}, ${JSON.stringify(newId)});`); }
const bat = (d) => d.batsmen.map(b => [b.name, b.status]);
const bowl = (d) => d.bowlers.map(b => [b.name, b.status, b.overs]);

async function suite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file);
  await sleep(80);
  const L = s => `${label}: ${s}`;
  setup(P);
  // Over 1 — Raj: no wicket
  P.E(`['1','0','4','0','1','0'].forEach(k => recordBall(k));`);
  let d = summaries(P).slice(-1)[0];
  eq(L('TEST 1/2: after over 1 the whole XI is there — 2 at the crease + 9 yet to bat, in Match Setup order (12th man left out)'), bat(d),
    [['Rohit', 'nonStriker'], ['Ishan', 'striker'], ...BAT.slice(2).map(n => [n, 'yet'])].map(r => r));
  eq(L('the two at the crease carry their figures; yet-to-bat rows carry none'), [d.batsmen[0].runs, d.batsmen[0].balls, d.batsmen[1].runs, d.batsmen[1].balls, d.batsmen[2].runs, d.batsmen[2].yetToBat], [1, 2, 5, 4, null, true]);
  eq(L('bowling after over 1: only the bowlers who have bowled — Raj (just bowled)'), bowl(d), [['Raj', 'current', '1.0']]);
  eq(L('payload carries partnership / extras breakdown for the graphic'), [d.partnershipRuns, typeof d.extras, d.target], [P.E('state.partnershipRuns'), 'object', null]);

  // Over 2 — Mukesh: Rohit out, Surya in
  nextOver(P, 'Mukesh', 'm1');
  P.E(`recordBall('1');`);           // Rohit on strike again? (Ishan was on strike) → Ishan 1, Rohit on strike
  wicket(P, 'Surya', 'a2');
  P.E(`['0','2','0','0'].forEach(k => recordBall(k));`);
  d = summaries(P).slice(-1)[0];
  eq(L('TEST 3: Rohit OUT, Surya batting, the rest still yet to bat — same order'), bat(d).slice(0, 4), [['Rohit', 'out'], ['Ishan', d.batsmen[1].status], ['Surya', d.batsmen[2].status], ['Tilak', 'yet']]);
  eq(L('Ishan and Surya are the two at the crease'), [d.batsmen[1].status, d.batsmen[2].status].sort(), ['nonStriker', 'striker']);
  eq(L('bowling order: Raj, Mukesh (current) — nobody who has not bowled'), bowl(d), [['Raj', 'bowled', '1.0'], ['Mukesh', 'current', '1.0']]);

  // Over 3 — Aman: Surya and Tilak out
  nextOver(P, 'Aman', 'a9');
  P.E(`state.striker.name === 'Surya' || swapStrike();`);
  wicket(P, 'Tilak', 'a3');
  P.E(`state.striker.name === 'Tilak' || swapStrike();`);
  wicket(P, 'Hardik', 'a4');
  P.E(`['0','0','0','0'].forEach(k => recordBall(k));`);
  d = summaries(P).slice(-1)[0];
  eq(L('TEST 4: several wickets — every player keeps one row, in entry order, nobody back to yet-to-bat'), bat(d).map(r => r[0]), BAT);
  eq(L('statuses: Rohit, Surya, Tilak OUT; Ishan + Hardik batting; 6 yet to bat'), [bat(d).filter(r => r[1] === 'out').map(r => r[0]), bat(d).filter(r => ['striker', 'nonStriker'].includes(r[1])).map(r => r[0]).sort(), bat(d).filter(r => r[1] === 'yet').length],
    [['Rohit', 'Surya', 'Tilak'], ['Hardik', 'Ishan'], 6]);

  // Over 4 — Raj again
  nextOver(P, 'Raj', 'r1');
  P.E(`['1','1','1','1','1','1'].forEach(k => recordBall(k));`);
  d = summaries(P).slice(-1)[0];
  eq(L('TEST 5/6: Raj returns — ONE Raj row (2.0 overs, current), order Raj, Mukesh, Aman'), bowl(d), [['Raj', 'current', '2.0'], ['Mukesh', 'bowled', '1.0'], ['Aman', 'bowled', '1.0']]);
  eq(L('figures come from the scoring state'), [d.bowlers[0].runs, d.bowlers[2].wickets, d.score, d.wickets], [P.E(`(state.bowlingCard.B.find(b => b.name === 'Raj') || state.bowler).runs`) , 2, P.E('state.score.runs'), 3]);
  // A squad of 17, every one ticked "XI": the batting list still stops at 11.
  setup(P);
  P.E(`state.teamA.players = state.teamA.players.concat(['X1','X2','X3','X4','X5','X6'].map((n, i) => ({ id: 'x' + i, name: n, isXI: true })));`);
  P.E(`['1','0','0','0','0','0'].forEach(k => recordBall(k));`);
  d = summaries(P).slice(-1)[0];
  eq(L('a 17-man squad all ticked XI → the batting list is the first 11'), [d.batsmen.length, d.batsmen.slice(-1)[0].name], [11, 'Arjun']);
  P.E(`state.customMaxWickets = 7; state.format = 'Custom';`);
  P.E(`['1','0','0','0','0','0'].forEach(k => recordBall(k));`);
  d = summaries(P).slice(-1)[0];
  eq(L('a 7-wicket Custom match → 8 batters listed'), d.batsmen.length, 8);
  eq(L('no script errors'), P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

(async () => {
  await suite('cricket-panel.html', 'Clipper panel');
  await suite('cricket-panel3.html', 'Stream Engine panel');
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
