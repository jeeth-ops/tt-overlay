// 🏏 BALL-EVENT CARDS — FOUR / SIX / WICKET / WIDE / NO BALL / FREE HIT play
// on the overlay at the scorebar's own size. Both panels send the card data
// (who, their figures, how out, both teams); the overlay turns it into the
// card's word, name and detail line. Only FOUR / SIX name the batter, and no
// card shows a score. The panel never guesses who is out before CONFIRM
// WICKET.
//
//   node test/cricket/ball-event-card-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

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
    runScripts: 'dangerously', pretendToBeVisual: true, url: url || 'https://example.test/cricket-panel?room=EC', virtualConsole: vc,
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
  return { w, errors, emits, E: (c) => w.eval(c), J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)) };
}

const BAT = ['Rohit Sharma','Ishan','Surya','Tilak','Hardik','Tim','Krunal','Piyush','Jasprit','Akash','Arjun'];
const BOWL = [['Raj','r1'],['Mukesh','m1'],['Aman','a9'],['Kabir','k2'],['Dev','d3'],['Om','o4'],['Sam','s5'],['Karan','c6'],['Rahul','h7'],['Pant','k1'],['Jadeja','j8']];
function setup(P){
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A';
    state.teamA.name = 'Mumbai Indians'; state.teamA.short = 'MI'; state.teamA.color = '#17337a';
    state.teamB.name = 'Chennai Super Kings'; state.teamB.short = 'CSK'; state.teamB.color = '#f2c40f';
    document.getElementById('match-id').value = 'EC';
    state.teamA.players = ${JSON.stringify(BAT)}.map((n, i) => ({ id: 'a' + i, name: n, isXI: true }));
    state.teamB.players = ${JSON.stringify(BOWL)}.map(([n, id]) => ({ id, name: n, isXI: true }));
    state.striker    = { name:'Rohit Sharma', id:'a0', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Raj', id:'r1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = [];
    renderPanel();
  `);
  P.emits.length = 0;
}
const events = (P, kind) => P.emits.filter(e => e.ev === 'cricketEvent' && e.payload.event.kind === kind).map(e => e.payload.event);
const last = (P, kind) => events(P, kind).slice(-1)[0] || null;

async function panelSuite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file);
  await sleep(80);
  const L = s => `${label}: ${s}`;
  setup(P);

  P.E(`recordBall('1'); recordBall('4');`); // Rohit takes a single, so Ishan faces the 4
  let ev = last(P, 'FOUR');
  eq(L('FOUR carries the batter who hit it, their figures, the bowler and both teams'),
    [ev.sub, ev.data.batter, ev.data.bowler, ev.data.batTeam, ev.data.bowlTeam.short],
    ['Ishan', { name: 'Ishan', runs: 4, balls: 1 }, 'Raj', { name: 'Mumbai Indians', short: 'MI', color: '#17337a' }, 'CSK']);
  P.E(`recordBall('6')`);
  ev = last(P, 'SIX');
  eq(L('SIX: figures include the six'), [ev.data.batter.name, ev.data.batter.runs, ev.data.batter.balls], ['Ishan', 10, 2]);

  P.E(`recordBall('Wd', { extraRuns: 4, boundary: true })`);
  ev = last(P, 'WIDE');
  eq(L('WIDE carries the bowler, the runs the ball cost and "boundary"'), [ev.data.bowler, ev.data.runs, ev.data.boundary], ['Raj', 5, true]);
  P.E(`recordBall('Wd')`);
  ev = last(P, 'WIDE');
  eq(L('a plain WIDE: 1 run, no boundary'), [ev.data.runs, ev.data.boundary], [1, false]);

  P.E(`recordBall('Nb', { runsOffBat: 4, boundary: true })`);
  ev = last(P, 'NO_BALL');
  eq(L('NO BALL carries the bowler, total runs, runs off the bat and "free hit next" (T20)'),
    [ev.data.bowler, ev.data.runs, ev.data.batRuns, ev.data.byes, ev.data.legByes, ev.data.boundary, ev.data.freeHit], ['Raj', 5, 4, 0, 0, true, true]);
  P.E(`recordBall('Nb', { legByeRuns: 1 })`);
  ev = last(P, 'NO_BALL');
  eq(L('NO BALL with a leg bye'), [ev.data.runs, ev.data.batRuns, ev.data.legByes], [2, 0, 1]);
  await sleep(2700);
  ev = last(P, 'FREE_HIT');
  eq(L('FREE HIT names the batter on strike for the free hit, with their figures'), [!!ev, ev && ev.data.batter && ev.data.batter.name, ev && ev.data.batter && typeof ev.data.batter.runs], [true, P.J('state.striker.name'), 'number']);

  // a wicket recorded straight away (no Wicket Details screen)
  setup(P);
  P.E(`recordBall('2'); recordBall('W', { dismissalType: 'Bowled' })`);
  ev = last(P, 'WICKET');
  eq(L('WICKET carries the batter out, the final figures, how out and the score after it'),
    [ev.sub, ev.data.batter, ev.data.howOut, ev.data.score, ev.data.batTeam.name], ['Rohit Sharma', { name: 'Rohit Sharma', runs: 2, balls: 2 }, 'b Raj', '2/1', 'Mumbai Indians']);

  // the Wicket Details flow: the graphic goes up 3s after WICKET is pressed
  setup(P);
  P.E(`recordBall('1'); recordBall('1'); armWicketAnimation('');`);
  P.E(`recordBall('W', { dismissalType: 'Caught', fielderName: 'Mukesh', deferAnimation: true }); fireWicketAnimationOnce('Rohit Sharma');`);
  eq(L('confirmed before the 3 seconds: nothing fires early'), events(P, 'WICKET').length, 0);
  await sleep(3150);
  ev = last(P, 'WICKET');
  eq(L('… then the card has the confirmed batter, figures, "c Mukesh b Raj" and the score'),
    [ev && ev.sub, ev && ev.data.batter, ev && ev.data.howOut, ev && ev.data.score], ['Rohit Sharma', { name: 'Rohit Sharma', runs: 1, balls: 2 }, 'c Mukesh b Raj', '2/1']);

  setup(P);
  P.E(`armWicketAnimation('')`);
  await sleep(3150);
  ev = last(P, 'WICKET');
  eq(L('not confirmed within 3 seconds: the card goes up with the team only — never a guessed name'),
    [ev && ev.sub, ev && ev.data.batter === undefined, ev && ev.data.batTeam.name, ev && ev.data.score], ['', true, 'Mumbai Indians', undefined]);
  P.E(`recordBall('W', { dismissalType: 'Bowled', deferAnimation: true }); fireWicketAnimationOnce('Rohit Sharma');`);
  eq(L('… and confirming afterwards never fires a second WICKET graphic'), events(P, 'WICKET').length, 1);

  eq(L('no script errors'), P.errors, []);
  P.w.close();
}

async function overlaySuite(){
  console.log('\n######## OVERLAY — cricket-overlay.html ########');
  const O = boot('cricket-overlay.html', 'https://example.test/cricket-overlay?room=EC');
  await sleep(150);
  const C = (kind, sub, data) => O.J(`ballCardContent(${JSON.stringify(kind)}, ${JSON.stringify({ sub, data })})`);
  const MI = { name: 'Mumbai Indians', short: 'MI', color: '#17337a' }, CSK = { name: 'Chennai Super Kings', short: 'CSK', color: '#f2c40f' };
  const ALL = (c) => Object.keys(c).sort();
  let c = C('FOUR', 'Rohit Sharma', { batter: { name: 'Rohit Sharma', runs: 34, balls: 21 }, bowler: 'Deepak Chahar', batTeam: MI, bowlTeam: CSK });
  eq('OVERLAY: FOUR card — word, team, batter, "off <bowler>"', [c.word, c.kicker, c.teamColor, c.name, c.line], ['FOUR', 'Mumbai Indians', '#17337a', 'Rohit Sharma', 'off Deepak Chahar']);
  eq('OVERLAY: no card carries a score at all (no stat field)', ALL(c), ['glyph', 'kicker', 'line', 'name', 'teamColor', 'word']);
  c = C('SIX', 'Rohit Sharma', { batter: { name: 'Rohit Sharma', runs: 40, balls: 22 }, bowler: 'Deepak Chahar', batTeam: MI });
  eq('OVERLAY: SIX card — the batter\'s runs never appear', JSON.stringify(c).includes('40') || JSON.stringify(c).includes('22'), false);
  // WICKET / WIDE / NO BALL / FREE HIT: no player names, no runs
  c = C('WICKET', 'Rohit Sharma', { batter: { name: 'Rohit Sharma', runs: 34, balls: 22 }, howOut: 'c Jadeja b Chahar', score: '87/3', batTeam: MI });
  eq('OVERLAY: WICKET card — the word and the stumps only (no name, no how out, no score)', [c.word, c.kicker, c.name, c.line], ['WICKET', '', '', '']);
  c = C('WICKET', 'WICKET!', { batTeam: MI });
  eq('OVERLAY: WICKET before it is confirmed — the same card', [c.name, c.line, c.kicker], ['', '', '']);
  c = C('WIDE', '+5 runs · boundary', { bowler: 'Deepak Chahar', runs: 5, boundary: true, batTeam: MI, bowlTeam: CSK });
  eq('OVERLAY: WIDE to the boundary — just "BOUNDARY" (no bowler, no runs)', [c.kicker, c.name, c.line], ['', '', 'Boundary']);
  c = C('WIDE', '', { bowler: 'Deepak Chahar', runs: 1, boundary: false, bowlTeam: CSK });
  eq('OVERLAY: a plain WIDE — the word only', [c.name, c.line], ['', '']);
  c = C('WIDE', '', { bowler: 'Deepak Chahar', runs: 3, boundary: false, bowlTeam: CSK });
  eq('OVERLAY: a WIDE with runs taken — still no runs shown', c.line, '');
  c = C('NO_BALL', '', { bowler: 'Deepak Chahar', runs: 5, batRuns: 4, boundary: true, freeHit: true, bowlTeam: CSK });
  eq('OVERLAY: NO BALL hit to the boundary — "BOUNDARY · FREE HIT NEXT" (no bowler, no runs)', [c.word, c.name, c.line], ['NO BALL', '', 'Boundary · Free hit next']);
  c = C('NO_BALL', '', { bowler: 'Deepak Chahar', runs: 3, byes: 2, freeHit: false });
  eq('OVERLAY: NO BALL with byes, no free hit (Test) — the word only', c.line, '');
  c = C('FREE_HIT', 'Next ball is a Free Hit', { batter: { name: 'Suryakumar Yadav', runs: 12, balls: 7 }, batTeam: MI });
  eq('OVERLAY: FREE HIT card — the word and the signal only', [c.word, c.kicker, c.name, c.line], ['FREE HIT', '', '', '']);
  c = C('WICKET', 'Rohit Sharma', null);
  eq('OVERLAY: an older panel\'s WICKET (name in "sub") still shows no name', c.name, '');
  c = C('FOUR', 'Rohit Sharma', null);
  eq('OVERLAY: an older panel (no data) still gets the FOUR name from "sub"', [c.name, c.line, c.kicker], ['Rohit Sharma', '', '']);
  c = C('WIDE', '+1 run', null);
  eq('OVERLAY: an older panel\'s WIDE "+1 run" text is not shown (no runs on the cards)', [c.name, c.line], ['', '']);
  eq('OVERLAY: all six ball events use the bar-sized card', O.J('BALL_CARD_KINDS'), ['FOUR', 'SIX', 'WICKET', 'WIDE', 'NO_BALL', 'FREE_HIT']);
  eq('OVERLAY: … and play at the scorebar\'s own height (growth 1)', O.J(`['FOUR','SIX','WICKET','WIDE','NO_BALL','FREE_HIT'].map(k => EVENT_THEMES[k].growth)`), [1, 1, 1, 1, 1, 1]);
  eq('OVERLAY: a team colour that is not a plain hex is ignored', C('FOUR', 'X', { batter: { name: 'X', runs: 4, balls: 1 }, batTeam: { name: 'T', color: 'red;background:url(x)' } }).teamColor, '');
  eq('OVERLAY: no script errors', O.errors, []);
  O.w.close();
}

(async () => {
  await panelSuite('cricket-panel.html', 'CLIPPER');
  await panelSuite('cricket-panel3.html', 'STREAM ENGINE');
  await overlaySuite();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
