// Every out type of the Wicket Details screen under the Laws of Cricket,
// the mandatory "who is on strike next?" question, Stumped (keeper or
// bowler, optional Wide), dismissals that are not a delivery (Mankad, Timed
// Out, Retired Out), Retired / Absent Hurt — on BOTH panels — plus the
// bowling scorecard's O M R W 0s NB WD Eco columns (live and completed) and
// the server's rebuild of the same deliveries.
//
//   node test/cricket/out-types-test.js
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
function deep(){ return new Proxy(function(){}, { get: (t, k) => k === Symbol.toPrimitive ? (() => 0) : (k === 'then' ? undefined : deep()), apply: () => deep() }); }
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
  return { w, errors, emits, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s), J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)),
    text: (s) => { const el = w.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; } };
}
const click = (P, sel) => { const el = P.$(sel); if(!el) throw new Error('no element ' + sel); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
// jsdom's selector engine can't match an attribute value containing "&", so
// out-type buttons are found by their data value.
const clickType = (P, t) => { const el = [...P.w.document.querySelectorAll('#wd-types [data-wd-type]')].find(b => b.dataset.wdType === t); if(!el) throw new Error('no out type ' + t); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const change = (P, sel, v) => { const el = P.$(sel); el.value = v; el.dispatchEvent(new P.w.Event('change', { bubbles: true })); };
function newMatch(P, opts){
  opts = opts || {};
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A';
    document.getElementById('match-id').value = 'OTTEST';
    state.teamA.players = ['Rohit','Ishan','Surya','Tilak','Hardik'].map((n, i) => ({ id: 'a' + (i + 1), name: n, isXI: true }));
    state.teamB.players = [{ id:'m1', name:'Mukesh', isXI:true }, { id:'r1', name:'Raj', isXI:true }, { id:'f1', name:'Jadeja', isXI:true }, { id:'k1', name:'Pant', isXI:true }];
    state.teamB.wkId = 'k1';
    state.striker    = { name:'Rohit', id:'a1', runs:${opts.fresh ? 0 : 10}, balls:${opts.fresh ? 0 : 8}, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan', id:'a2', runs:5, balls:6, fours:0, sixes:0 };
    state.bowler = { name:'Mukesh', id:'m1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = []; pendingWicketDelivery = null; lastAutoWicketClip = null;
    renderPanel();
  `);
}
const lastDb = (P) => { const e = P.emits.filter(x => x.ev === 'logBall').slice(-1)[0]; return e ? e.payload : null; };
const legal = (P) => P.E('state.score.overs * 6 + state.score.balls');
// Pick an out type and, if asked, the rest — always answering the strike question.
function out(P, o){
  P.E('openWicketModal()');
  clickType(P, o.type);
  if(o.delivery) click(P, `[data-wd-delivery="${o.delivery}"]`);
  if(o.wide){ P.$('#wd-wide-check').checked = true; P.$('#wd-wide-check').dispatchEvent(new P.w.Event('change', { bubbles: true })); }
  if(o.stumpBy) click(P, `[data-wd-stumpby="${o.stumpBy}"]`);
  if(o.who) click(P, `[data-wd-who="${o.who}"]`);
  if(o.pick) change(P, '#wd-who-select', o.pick);
  if(o.runs != null) click(P, `[data-wd-runs="${o.runs}"]`);
  if(o.newBat && !P.$('#wd-sec-newbat').hidden) change(P, '#wd-newbat-select', o.newBat);
  if(!P.$('#wd-sec-strike').hidden) click(P, `[data-wd-strike="${o.next || (P.E('wdPredictNewOnStrike()') ? 'new' : 'survivor')}"]`);
  if(o.confirm !== false) click(P, '#wd-confirm');
}

const fixtures = {};
const getComputedStyleSafe = (P, sel) => P.w.getComputedStyle(P.$(sel)).display;

async function panelSuite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file, 'https://example.test/cricket-panel?room=OTTEST');
  await sleep(80);
  const L = (s) => `${label}: ${s}`;

  console.log('\n=== Select out type: all 16 ===');
  newMatch(P);
  P.E('openWicketModal()');
  eq(L('the out types, in order'), [...P.w.document.querySelectorAll('#wd-types [data-wd-type]')].map(b => b.dataset.wdType),
    ['Bowled', 'Caught', 'Caught Behind', 'Caught & Bowled', 'Run Out', 'LBW', 'Stumped', 'Retired Hurt', 'Run Out (Mankaded)', 'Hit Wicket', 'Absent Hurt', 'Retired Out', 'Hit the Ball Twice', 'Obstructing the Field', 'Timed Out', 'Retired']);
  click(P, '#wd-cancel');
  P.E('state.freeHit = true');
  P.E('openWicketModal()');
  eq(L('Free Hit: only what the Laws allow off a free hit'), [...P.w.document.querySelectorAll('#wd-types [data-wd-type]')].filter(b => !b.disabled).map(b => b.dataset.wdType),
    ['Run Out', 'Retired Hurt', 'Run Out (Mankaded)', 'Absent Hurt', 'Retired Out', 'Hit the Ball Twice', 'Obstructing the Field', 'Timed Out', 'Retired']);
  click(P, '#wd-cancel');

  console.log('\n=== Strike question after every wicket ===');
  newMatch(P);
  out(P, { type: 'Bowled', newBat: 'a3', confirm: false });
  P.E(`wdState.nextStriker = null; renderWicketDetails();`);
  eq(L('Confirm stays blocked until "who is on strike?" is answered'), [P.$('#wd-confirm').disabled, P.text('#wd-preview'), P.$('#wd-sec-strike').hidden], [true, 'Who is on strike for the next ball? — choose one.', false]);
  eq(L('nothing is chosen for the scorer — both answers offered'), [...P.w.document.querySelectorAll('#wd-strike .wd-chip.on')].length, 0);
  click(P, '[data-wd-strike="survivor"]');
  click(P, '#wd-confirm');
  eq(L('the answer is what happens: Ishan faces, Surya at the other end'), P.J('[state.striker.name, state.nonStriker.name, state.score.wickets]'), ['Ishan', 'Surya', 1]);

  console.log('\n=== Who is out: striker by default, non-striker on a tap ===');
  newMatch(P);
  P.E('openWicketModal()');
  clickType(P, 'Bowled');
  eq(L('Bowled offers both batters, the striker pre-selected'), [...P.w.document.querySelectorAll('#wd-who [data-wd-who]')].map(b => [b.dataset.wdWho, b.classList.contains('on')]),
    [['striker', true], ['nonStriker', false]]);
  click(P, '#wd-cancel');
  newMatch(P);
  out(P, { type: 'Bowled', newBat: 'a3' });
  eq(L('no tap = the striker is out'), P.J(`[state.battingCard.A.find(b => b.name === 'Rohit').howOut, state.striker.name === 'Rohit' || state.nonStriker.name === 'Rohit']`), ['b Mukesh', false]);
  for(const type of ['Bowled', 'Caught', 'LBW', 'Stumped', 'Hit Wicket']){
    newMatch(P);
    out(P, { type, who: 'nonStriker', newBat: 'a3', confirm: false });
    if(type === 'Caught') P.E(`wdSetFielder('f1'); renderWicketDetails();`);
    eq(L(`${type}: the non-striker can be chosen — hint says they were facing`), [P.$('[data-wd-who="nonStriker"]').classList.contains('on'), /recorded as on strike/.test(P.text('#wd-who-label'))], [true, true]);
    eq(L(`${type}: the strike question predicts the new batter faces (the striker's end is the empty one)`), P.E('wdPredictNewOnStrike()'), true);
    if(!P.$('#wd-sec-strike').hidden) click(P, '[data-wd-strike="new"]');
    click(P, '#wd-confirm');
    const r = P.J(`(() => { const c = state.battingCard.A; const g = n => c.find(b => b.name === n) || {};
      return [g('Ishan').howOut || '', g('Ishan').balls, g('Rohit').howOut || 'not out', state.nonStriker.name === 'Rohit' ? state.nonStriker.balls : -1, state.striker.name, state.nonStriker.name, state.score.wickets, state.bowler.wickets, state.ballLog.slice(-1)[0].strikerId || state.ballLog.slice(-1)[0].striker]; })()`);
    eq(L(`${type}: Ishan (the non-striker) is out, his ball faced; Rohit not out, Surya in and facing`), [r[0] !== '' && r[0] !== 'not out', r[1], r[2], r[3], r[4], r[5], r[6], r[7]],
      [true, 7, 'not out', 8, 'Surya', 'Rohit', 1, type === 'Stumped' || type === 'Hit Wicket' || type === 'Bowled' || type === 'LBW' || type === 'Caught' ? 1 : 0]);
    const db = lastDb(P);
    eq(L(`${type}: the database names Ishan as out and as the striker of that ball`), [db.dismissal && (db.dismissal.batterId || db.dismissal.batter), db.striker], [db.dismissal.batterId ? 'a2' : 'Ishan', 'Ishan']);
  }
  newMatch(P);
  out(P, { type: 'Bowled', who: 'nonStriker', newBat: 'a3' });
  P.E(`document.getElementById('undo-btn').click()`);
  eq(L('one Undo puts it all back — wicket and the ends'), P.J('[state.striker.name, state.nonStriker.name, state.score.wickets, state.ballLog.length]'), ['Rohit', 'Ishan', 0, 0]);

  console.log('\n=== Caught Behind / Caught & Bowled ===');
  newMatch(P);
  out(P, { type: 'Caught Behind', newBat: 'a3' });
  eq(L('Caught Behind: the keeper, the bowler’s wicket'), P.J(`[state.battingCard.A[0].howOut, state.bowler.wickets, Object.values(state.fieldingStats.B).map(f => [f.name, f.catches]), state.ballLog[0].dismissalType]`), ['c †Pant b Mukesh', 1, [['Pant', 1]], 'Caught']);
  eq(L('Caught Behind reaches the database as a catch, subtype caught behind'), [lastDb(P).dismissal.type, lastDb(P).dismissal.fielder, lastDb(P).dismissal.subtype], ['Caught', 'Pant', 'caught behind']);
  newMatch(P);
  out(P, { type: 'Caught & Bowled', newBat: 'a3' });
  eq(L('Caught & Bowled: c & b, the catch is the bowler’s too'), P.J(`[state.battingCard.A[0].howOut, state.bowler.wickets, Object.values(state.fieldingStats.B).map(f => [f.name, f.catches])]`), ['c & b Mukesh', 1, [['Mukesh', 1]]]);

  console.log('\n=== Stumped — wicket-keeper or bowler, optional Wide Ball ===');
  newMatch(P);
  P.E('openWicketModal()'); clickType(P, 'Stumped');
  eq(L('Stumped: who = the striker (non-striker on a tap); by Wicket-keeper (pre-filled) or Bowler; a Wide Ball tick-box'), [P.text('#wd-who'), P.text('#wd-fielder-by'), P.$('#wd-sec-wide').hidden, P.$('#wd-sec-delivery').hidden], ['RohitSTRIKERIshanNON-STRIKER', 'Wicket-keeperPantBowlerMukesh', false, true]);
  click(P, '#wd-cancel');
  newMatch(P);
  out(P, { type: 'Stumped', newBat: 'a3' });
  eq(L('Stumped by the keeper — legal ball, bowler’s wicket'), P.J(`[state.battingCard.A[0].howOut, state.bowler.wickets, state.score.runs, state.score.balls, state.extras.A.wd]`), ['st Pant b Mukesh', 1, 0, 1, 0]);
  newMatch(P);
  out(P, { type: 'Stumped', wide: true, newBat: 'a3' });
  eq(L('Stumped + Wide Ball: +1 wide to the team, not a legal ball, then the wicket (bowler’s)'), P.J(`[state.score.runs, state.extras.A.wd, state.score.overs * 6 + state.score.balls, state.bowler.wickets, state.bowler.runs, state.ballLog[0].ballType, state.battingCard.A[0].howOut]`), [1, 1, 0, 1, 1, 'WdW', 'st Pant b Mukesh (Wd)']);
  eq(L('Stumped + Wide reaches the database as a Wide with the stumping'), [lastDb(P).kind, lastDb(P).runs, lastDb(P).dismissal.type], ['Wd', 1, 'Stumped']);
  newMatch(P);
  out(P, { type: 'Stumped', stumpBy: 'bowler', newBat: 'a3' });
  eq(L('Stumped by the bowler'), P.J(`[state.ballLog[0].fielderName, state.bowler.wickets]`), ['Mukesh', 1]);

  console.log('\n=== Hit the Ball Twice / Obstructing the Field ===');
  newMatch(P);
  out(P, { type: 'Hit the Ball Twice', newBat: 'a3' });
  eq(L('Hit the Ball Twice: striker out, legal ball, NOT the bowler’s wicket'), P.J(`[state.battingCard.A[0].name, state.battingCard.A[0].howOut, state.bowler.wickets, state.score.balls]`), ['Rohit', 'hit the ball twice', 0, 1]);
  newMatch(P);
  out(P, { type: 'Obstructing the Field', who: 'nonStriker', runs: 1, newBat: 'a3' });
  eq(L('Obstructing the Field: either batter, runs completed count, not the bowler’s'), P.J(`[state.battingCard.A[0].name, state.battingCard.A[0].howOut, state.score.runs, state.bowler.wickets]`), ['Ishan', 'obstructing the field', 1, 0]);

  console.log('\n=== Run Out (Mankaded) — no ball is bowled ===');
  newMatch(P);
  const before = legal(P);
  out(P, { type: 'Run Out (Mankaded)', newBat: 'a3', next: 'survivor' });
  eq(L('Mankad: non-striker out, no ball, not the bowler’s wicket'), P.J(`[state.battingCard.A[0].name, state.battingCard.A[0].howOut, state.score.wickets, state.score.overs * 6 + state.score.balls, state.bowler.wickets, state.bowler.balls]`).concat(before), ['Ishan', 'run out (Mukesh) — mankaded', 1, 0, 0, 0, 0]);
  eq(L('Mankad: the striker stays, the new batter comes in at the other end'), P.J('[state.striker.name, state.nonStriker.name]'), ['Rohit', 'Surya']);
  eq(L('Mankad: its own OUT event — no bowler, never a delivery'), [P.J('state.ballLog[0].ballType'), lastDb(P).kind, lastDb(P).bowler, lastDb(P).dismissal.type], ['OUT', 'OUT', null, 'Run Out (Mankaded)']);
  P.E(`recordBall('1')`);
  eq(L('the next ball is the first ball of the over'), [P.J('state.ballLog[1].over'), legal(P)], ['0.1', 1]);

  console.log('\n=== Mankad: who (non-striker default) and by whom (bowler default) ===');
  newMatch(P);
  P.E('openWicketModal()');
  clickType(P, 'Stumped');
  clickType(P, 'Run Out (Mankaded)');
  eq(L('Mankad: both batters offered, the non-striker selected'), [...P.w.document.querySelectorAll('#wd-who [data-wd-who]')].map(b => [b.dataset.wdWho, b.classList.contains('on')]), [['striker', false], ['nonStriker', true]]);
  eq(L('Mankad: Wicket-keeper or Bowler, the bowler selected; keeper list hidden'), [P.$('#wd-fielder-by').hidden, [...P.w.document.querySelectorAll('#wd-fielder-by [data-wd-stumpby]')].map(b => [b.dataset.wdStumpby, b.classList.contains('on')]), P.text('#wd-fielder-note')],
    [false, [['keeper', false], ['bowler', true]], 'Run out by the bowler — Mukesh']);
  click(P, '[data-wd-stumpby="keeper"]');
  eq(L('Mankad by the keeper: keeper pre-filled, no bowler note'), [P.E('wdFielderChoice().name'), P.$('#wd-fielder-note').hidden], ['Pant', true]);
  clickType(P, 'Caught');
  eq(L('the Keeper/Bowler choice only shows for Stumped and Mankad'), [P.$('#wd-fielder-by').hidden, getComputedStyleSafe(P, '#wd-fielder-by')], [true, 'none']);
  click(P, '#wd-cancel');
  newMatch(P);
  out(P, { type: 'Run Out (Mankaded)', stumpBy: 'keeper', newBat: 'a3' });
  eq(L('Mankad by the keeper: on the card and his run out'), P.J(`[state.battingCard.A[0].name, state.battingCard.A[0].howOut, Object.values(state.fieldingStats.B).filter(f => f.name === 'Pant').map(f => f.runOuts)]`).concat(lastDb(P).dismissal.fielder), ['Ishan', 'run out (Pant) — mankaded', [1], 'Pant']);
  newMatch(P);
  out(P, { type: 'Run Out (Mankaded)', who: 'striker', newBat: 'a3' });
  eq(L('Mankad of the batter shown on strike: he is out, the other faces, the new batter at the non-striker’s end'), P.J(`[state.battingCard.A[0].name, state.battingCard.A[0].howOut, state.striker.name, state.nonStriker.name, state.score.wickets, state.score.balls]`), ['Rohit', 'run out (Mukesh) — mankaded', 'Ishan', 'Surya', 1, 0]);
  P.E(`document.getElementById('undo-btn').click()`);
  eq(L('…one Undo restores the wicket and the ends'), P.J('[state.striker.name, state.nonStriker.name, state.score.wickets]'), ['Rohit', 'Ishan', 0]);

  console.log('\n=== Timed Out / Retired Out / Retired ===');
  newMatch(P);
  P.E('openWicketModal()'); clickType(P, 'Timed Out');
  eq(L('Timed Out: the incoming batter is picked from the list'), [...P.$('#wd-who-select').options].map(o => o.value).filter(Boolean), ['p:a3', 'p:a4', 'p:a5']);
  change(P, '#wd-who-select', 'p:a4');
  eq(L('Timed Out of a batter not yet in: nobody at the crease changes — no new batsman, no strike question'), [P.$('#wd-sec-newbat').hidden, P.$('#wd-sec-strike').hidden], [true, true]);
  click(P, '#wd-confirm');
  eq(L('Timed Out: a wicket, no ball, crease unchanged'), P.J(`[state.score.wickets, state.score.balls, state.battingCard.A.map(b => [b.name, b.howOut]), state.striker.name, state.nonStriker.name]`), [1, 0, [['Tilak', 'timed out']], 'Rohit', 'Ishan']);
  P.E('openWicketModal()'); clickType(P, 'Bowled');
  eq(L('a timed-out batter can no longer come in'), [...P.$('#wd-newbat-select').options].map(o => o.value).filter(Boolean), ['a3', 'a5']);
  click(P, '#wd-cancel');
  newMatch(P, { fresh: true });
  out(P, { type: 'Timed Out', pick: 'crease:striker', newBat: 'a3', next: 'new' });
  eq(L('Timed Out of the batter just in: that end is filled again'), P.J(`[state.score.wickets, state.battingCard.A[0].name, state.striker.name, state.nonStriker.name]`), [1, 'Rohit', 'Surya', 'Ishan']);
  newMatch(P);
  out(P, { type: 'Retired Out', who: 'striker', newBat: 'a3', next: 'new' });
  eq(L('Retired Out: out, a wicket, no ball, not the bowler’s'), P.J(`[state.battingCard.A[0].howOut, state.score.wickets, state.score.balls, state.bowler.wickets, state.striker.name]`), ['retired out', 1, 0, 0, 'Surya']);
  newMatch(P);
  out(P, { type: 'Retired', who: 'nonStriker', newBat: 'a3', next: 'survivor' });
  eq(L('Retired (not out): not a wicket, no ball; new batsman in, strike asked'), P.J(`[state.battingCard.A.map(b => [b.name, b.howOut, b.out]), state.score.wickets, state.score.balls, state.striker.name, state.nonStriker.name]`), [[['Ishan', 'retired not out', false]], 0, 0, 'Rohit', 'Surya']);

  console.log('\n=== Absent Hurt ===');
  newMatch(P);
  P.E('state.score.wickets = 8');
  out(P, { type: 'Absent Hurt', pick: 'p:a5' });
  eq(L('Absent Hurt: not out, not a wicket, no ball, nobody at the crease changes'), P.J(`[state.score.wickets, state.score.balls, state.battingCard.A.map(b => [b.name, b.howOut, b.out]), state.striker.name, isAllOut()]`), [8, 0, [['Hardik', 'absent hurt', false]], 'Rohit', false]);
  P.E(`recordBall('W', { dismissalType: 'Bowled' })`);
  eq(L('…and the side is all out one wicket earlier (9 wickets)'), P.J('[state.score.wickets, isAllOut()]'), [9, true]);
  fixtures[label] = P;

  console.log('\n=== Bowling figures for the scorecard: 0s / NB / WD ===');
  newMatch(P);
  P.E(`recordBall('0'); recordBall('Wd', { extraRuns: 1 }); recordBall('Nb', { runsOffBat: 4 }); recordBall('1'); recordBall('B', { runs: 2 }); recordBall('W', { dismissalType: 'Bowled' }); sendInNewBatsman('Surya', 'a3'); recordBall('0');`);
  const rec = P.J('buildMatchRecordForLeague()');
  const row = (rec.bowlingCard.B || []).concat(P.J('state.bowler')).find(b => b.name === 'Mukesh');
  eq(L('the saved record carries 0s / NB / WD for each bowler (dots: 0, bye, wicket, 0)'), [row.dots, row.noBalls, row.wides], [4, 1, 1]);
  fixtures[label + ':live'] = P.J('state');
  eq(L('no script errors'), P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

async function scorecardSuite(){
  console.log('\n######## Scorecard: Bowlers | O | M | R | W | 0s | NB | WD | Eco ########');
  const st = fixtures['Clipper panel:live'];
  const S = boot('cricket-scorecard.html', 'https://example.test/cricket-scorecard.html?room=OTTEST', w => { w.firebase = deep(); });
  await sleep(80);
  S.E(`latestState = ${JSON.stringify(st)}; render();`);
  eq('the bowling table has the columns', [...S.w.document.querySelectorAll('#bowling-card thead th')].map(t => t.textContent.trim()).filter(Boolean), ['Bowler', 'O', 'M', 'R', 'W', '0s', 'NB', 'WD', 'Eco']);
  const cells = [...S.w.document.querySelectorAll('#bowling-table-body tr:first-child td')].map(t => t.textContent.trim()).slice(0, 9);
  eq('live: Mukesh 0.5-0-8-1 (wides + no ball + bat runs, no byes), 0s 4, NB 1, WD 1, Eco 9.60', cells.map((c, i) => i === 0 ? c.replace(/\s+.*/, '') : c), ['Mukesh', '0.5', '0', '8', '1', '4', '1', '1', '9.60']);
  eq('the footnote', S.text('.bowl-note'), '*Counts wide deliveries, not extra runs.');
  // A completed match read from the website: its record + its ball-by-ball.
  const rec = { matchId: 'X', teamA: st.teamA, teamB: st.teamB, format: 'T20', winningTeam: 'A', scoreA: { runs: 11, wickets: 1, overs: '1.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' },
    battingCard: { A: [{ name: 'Rohit', runs: 1, balls: 3, out: true, howOut: 'b Mukesh', inningsNo: 1 }], B: [] },
    bowlingCard: { A: [], B: [{ name: 'Mukesh', overs: 0, balls: 5, maidens: 0, runs: 8, wickets: 1, inningsNo: 1 }] },
    inningsArchive: [{ no: 1, team: 'A', runs: 11, wickets: 1, overs: '1.0' }] };
  const pub = [['0', 0], ['WD', 2], ['NB', 5], ['1', 1], ['B', 2], ['W', 0], ['0', 0]].map(([k, r], i) => ({ innings: 1, over: 0.1 * (i + 1), ballType: k, runs: r, striker: 'Rohit', bowler: 'Mukesh', battingTeam: 'A', isWicket: k === 'W' }));
  S.E(`latestState = null; finalMatchData = null; finalBallLog = ${JSON.stringify(pub)}; renderFinalSnapshot(${JSON.stringify(rec)}, '');`);
  const c2 = [...S.w.document.querySelectorAll('#bowling-table-body tr:first-child td')].map(t => t.textContent.trim()).slice(0, 9);
  eq('completed match: the same columns from its ball-by-ball', c2.map((c, i) => i === 0 ? c.replace(/\s+.*/, '') : c), ['Mukesh', '0.5', '0', '8', '1', '4', '1', '1', '9.60']);
  S.E(`finalMatchData = null; finalBallLog = []; renderFinalSnapshot(${JSON.stringify({ ...rec, bowlingCard: { A: [], B: [{ ...rec.bowlingCard.B[0], dots: 3, noBalls: 2, wides: 1 }] } })}, '');`);
  const c3 = [...S.w.document.querySelectorAll('#bowling-table-body tr:first-child td')].map(t => t.textContent.trim()).slice(5, 8);
  eq('no ball-by-ball at hand: the saved record’s own counts', c3, ['3', '2', '1']);
  eq('scorecard: no script errors', S.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

async function serverSuite(){
  console.log('\n######## Server: the same deliveries rebuilt ########');
  const world = { balls: H.coll([]), clips: H.coll([]), records: H.coll([]), rooms: {}, emits: [], audits: [] };
  const api = H.build(world, ['personName', 'playerKey', 'deriveBallFacts', 'isSuperOverBall', 'buildLiveCardsFromBallsArray'], ['reassignBowlerInDb']);
  let i = 0;
  const mk = (kind, runs, extra) => ({ _id: new H.ObjectId(), matchId: 'M1', ownerUid: 'u1', ballUid: 'd' + (++i), innings: 1, over: 0, ballInOver: i, kind, runs, battingTeam: 'A',
    striker: 'Rohit', strikerKey: 'rohit', nonStriker: 'Ishan', bowler: 'Mukesh', bowlerKey: 'mukesh', dismissal: null, ...(extra || {}) });
  const balls = [
    mk('0', 0), mk('Wd', 2), mk('Nb', 5), mk('1', 1), mk('B', 2),
    mk('W', 0, { dismissal: { type: 'Caught', fielder: 'Mukesh', batter: 'Rohit', subtype: 'caught and bowled' } }),
    mk('OUT', 0, { bowler: null, bowlerKey: null, striker: 'Surya', strikerKey: 'surya', dismissal: { type: 'Run Out (Mankaded)', fielder: 'Mukesh', batter: 'Ishan', subtype: 'mankaded' } }),
    mk('W', 0, { striker: 'Surya', strikerKey: 'surya', dismissal: { type: 'Caught', fielder: 'Pant', batter: 'Surya', subtype: 'caught behind' } })
  ];
  const cards = api.buildLiveCardsFromBallsArray(balls);
  const m = cards.bowlingCard.B.find(b => b.name === 'Mukesh');
  eq('server: Mukesh — 5 legal balls (bye counts, Mankad does not), runs 8 (no byes), wickets 2 (not the Mankad), 0s 4, NB 1, WD 1', [m.overs, m.balls, m.runs, m.wickets, m.dots, m.noBalls, m.wides], [0, 5, 8, 2, 4, 1, 1]);
  eq('server: team 3 wickets (the Mankad is one), legal balls unchanged by it', [cards.scoreA.wickets, cards.scoreA.overs], [3, '0.5']);
  const how = Object.fromEntries(cards.battingCard.A.map(b => [b.name, b.howOut]));
  eq('server: dismissal texts', [how.Rohit, how.Ishan, how.Surya], ['c & b Mukesh', 'run out (Mukesh) — mankaded', 'c †Pant b Mukesh']);
  eq('server: the Mankad is not a ball faced by anyone', cards.battingCard.A.find(b => b.name === 'Surya').balls, 1);
  world.balls.docs.push(...balls.map(H.clone));
  const r = await api.reassignBowlerInDb('M1', { innings: 1, over: 0, bowler: 'Raj', deliveryIds: [], allHaveIds: false, fromBowlers: [''] });
  eq('server: assigning an over’s bowler never touches the Mankad event', [r.updated, world.balls.docs.find(b => b.kind === 'OUT').bowler], [0, null]);
}

(async () => {
  await panelSuite('cricket-panel.html', 'Clipper panel');
  await panelSuite('cricket-panel3.html', 'Stream Engine panel');
  await scorecardSuite();
  await serverSuite();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
