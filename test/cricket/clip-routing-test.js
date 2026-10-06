// CLIP ROUTING after the recent scoring changes — Clipper panel only (the
// Stream Engine panel has no clipper). Every clip request / re-label must
// describe the exact delivery: its over.ball, striker, bowler, dismissed
// batter, fielder and boundary status — never the next ball's state.
//
//   node test/cricket/clip-routing-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
function eq(name, actual, expected){ ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function boot(file){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://example.test/cricket-panel?room=TESTMATCH', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){} });
      w.fetch = (url, opts) => {
        let body = null;
        try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch(e) {}
        calls.push({ url: String(url), body });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, recordingActive: true }) });
      };
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.firebase = undefined; w.alert = () => {}; w.confirm = () => true;
      w.crypto = w.crypto || {};
      if(!w.crypto.randomUUID) w.crypto.randomUUID = () => 'uuid-' + Math.random().toString(36).slice(2);
    }
  });
  const w = dom.window;
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  const E = (code) => w.eval(code);
  return { w, E, calls, errors };
}

function setup(P, opts){
  opts = opts || {};
  P.E(`
    state = mergeWithDefaults(null);
    state.format = ${JSON.stringify(opts.format || 'T20')};
    state.oversPerInnings = 20;
    state.battingTeam = 'A';
    state.inningsNumber = 1;
    state.striker    = { name:'Player A', id:'pA', runs:10, balls:8, fours:1, sixes:0 };
    state.nonStriker = { name:'Player B', id:'pB', runs:5, balls:6, fours:0, sixes:0 };
    state.bowler     = { name:'Bowler One', id:'b1', overs:2, balls:5, maidens:0, runs:12, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    state.score = { runs: 60, wickets: 2, overs: ${opts.overs == null ? 12 : opts.overs}, balls: ${opts.balls == null ? 5 : opts.balls} };
    state.thisOver = ['1','0','2','1','0'];
    history = [];
    pendingHighlights = [];
    lastAutoWicketClip = null;
    pendingWicketDelivery = null;
    document.getElementById('match-id').value = 'TESTMATCH';
  `);
  P.calls.length = 0;
}
const clipCalls = (P, kind) => P.calls.filter(c => /\/clip$/.test(c.url) && (!kind || (c.body && c.body.eventType === kind)));
const metaCalls = (P) => P.calls.filter(c => /\/clip-meta$/.test(c.url));
const classifyCalls = (P) => P.calls.filter(c => /\/api\/clips\/classify$/.test(c.url));
const lastLog = (P) => JSON.parse(P.E('JSON.stringify(state.ballLog[state.ballLog.length-1])'));
const lastDbRow = (P) => JSON.parse(P.E('JSON.stringify(ballOutbox[ballOutbox.length-1])'));

const clickType = (P, t) => { const el = [...P.w.document.querySelectorAll('#wd-types [data-wd-type]')].find(b => b.dataset.wdType === t); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const click = (P, sel) => { const el = P.w.document.querySelector(sel); if(!el) throw new Error('no ' + sel); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const change = (P, sel, v) => { const el = P.w.document.querySelector(sel); el.value = v; el.dispatchEvent(new P.w.Event('change', { bubbles: true })); };
function squads(P){
  P.E(`state.teamA.players = [{ id:'pA', name:'Player A', isXI:true }, { id:'pB', name:'Player B', isXI:true }, { id:'pC', name:'Player C', isXI:true }, { id:'pD', name:'Player D', isXI:true }];
       state.teamB.players = [{ id:'b1', name:'Bowler One', isXI:true }, { id:'b2', name:'Bowler Two', isXI:true }, { id:'k1', name:'Keeper', isXI:true }, { id:'f1', name:'Fielder X', isXI:true }];
       state.teamB.wkId = 'k1'; renderPanel();`);
}
function wicket(P, o){
  P.E('openWicketModal()');
  clickType(P, o.type);
  if(o.delivery) click(P, `[data-wd-delivery="${o.delivery}"]`);
  if(o.wide){ const c = P.w.document.querySelector('#wd-wide-check'); c.checked = true; c.dispatchEvent(new P.w.Event('change', { bubbles: true })); }
  if(o.who) click(P, `[data-wd-who="${o.who}"]`);
  if(o.fielder) P.E(`wdSetFielder(${JSON.stringify(o.fielder)}); renderWicketDetails();`);
  if(o.runs != null) click(P, `[data-wd-runs="${o.runs}"]`);
  if(!P.w.document.querySelector('#wd-sec-newbat').hidden) change(P, '#wd-newbat-select', o.newBat || 'pC');
  if(!P.w.document.querySelector('#wd-sec-strike').hidden) click(P, `[data-wd-strike="${P.E('wdPredictNewOnStrike()') ? 'new' : 'survivor'}"]`);
  click(P, '#wd-confirm');
}
function extra(P, o){
  P.E(`openExtrasModal(${JSON.stringify(o.kind)})`);
  if(o.as) click(P, `[data-xm-as="${o.as}"]`);
  click(P, `[data-xm-runs="${o.runs}"]`);
  if(o.bnd){ click(P, `[data-xm-bnd="${o.bnd === 'boundary' ? 1 : 0}"]`); click(P, '[data-xm-go]'); }
}
const J = (P, x) => JSON.parse(P.E(`JSON.stringify(${x})`));
const meta = (c) => c && c.body && c.body.ballMeta;
const lastOf = (arr) => arr[arr.length - 1];

(async () => {
  const P = boot('cricket-panel.html');
  await sleep(100);

  console.log('\n=== wicket on the LAST ball of the over (Wicket Details), new batsman + new bowler after ===');
  setup(P, { overs: 0, balls: 5 }); squads(P);
  wicket(P, { type: 'Caught', fielder: 'f1', newBat: 'pC' });
  P.E(`closeNewOverModal(); setLiveBowler('Bowler Two', 'b2'); renderPanel();`);
  await sleep(2300);
  const press = lastOf(clipCalls(P, 'WICKET'));
  eq('the WICKET clip is cut at the press, on 0.6, with that over’s bowler', meta(press) && [meta(press).over, meta(press).ballInOver, meta(press).bowlerId, meta(press).strikerId], [0, 6, 'b1', 'pA']);
  const relabel = lastOf(metaCalls(P));
  eq('re-label after CONFIRM: 0.6, A out, c Fielder X, bowler One — not the new batter, not the next bowler', meta(relabel) && [meta(relabel).over, meta(relabel).ballInOver, meta(relabel).dismissedPlayerId, meta(relabel).dismissal.fielder, meta(relabel).bowlerId, meta(relabel).batsmanId],
    [0, 6, 'pA', 'Fielder X', 'b1', 'pA']);
  const cls = lastOf(classifyCalls(P));
  eq('the website gets the same', meta(cls) && [cls.body.eventType, meta(cls).over, meta(cls).ballInOver, meta(cls).dismissedPlayerId, meta(cls).bowlerId], ['WICKET', 0, 6, 'pA', 'b1']);
  eq('the panel moved on (Player C in, Bowler Two on) — the clip did not', J(P, '[state.striker.name === "Player C" || state.nonStriker.name === "Player C", state.bowler.name]'), [true, 'Bowler Two']);

  console.log('\n=== Run Out on a Wide / a No Ball, non-striker out ===');
  setup(P, { overs: 3, balls: 2 }); squads(P);
  wicket(P, { type: 'Run Out', delivery: 'wide', who: 'nonStriker', fielder: 'f1', runs: 1, newBat: 'pC' });
  await sleep(2300);
  let m = meta(lastOf(metaCalls(P)));
  eq('Wide + Run Out: still ball 3.2 (a wide is not legal), B out, run out by Fielder X, bowler One', m && [m.over, m.ballInOver, m.dismissedPlayerId, m.dismissal.type, m.dismissal.fielder, m.bowlerId], [3, 2, 'pB', 'Run Out', 'Fielder X', 'b1']);
  eq('…and the database row is that wide', [lastDbRow(P).payload ? lastDbRow(P).payload.kind : lastDbRow(P).kind], ['Wd']);
  setup(P, { overs: 3, balls: 2 }); squads(P);
  wicket(P, { type: 'Run Out', delivery: 'noball', who: 'nonStriker', fielder: 'k1', runs: 2, newBat: 'pC' });
  await sleep(2300);
  m = meta(lastOf(metaCalls(P)));
  eq('No Ball + Run Out: ball 3.2, B out, run out by the keeper', m && [m.over, m.ballInOver, m.dismissedPlayerId, m.dismissal.fielder], [3, 2, 'pB', 'Keeper']);

  console.log('\n=== No Ball / Wide: BOUNDARY vs RUNNING decides the clip ===');
  setup(P, { overs: 5, balls: 5 }); squads(P);
  extra(P, { kind: 'Nb', runs: 4, bnd: 'boundary' });
  let c = lastOf(clipCalls(P, 'FOUR'));
  eq('NB + 4 BOUNDARY: a FOUR clip of 5.5 (not legal, the over does not move), striker A', meta(c) && [meta(c).over, meta(c).ballInOver, meta(c).strikerId, meta(c).bowlerId], [5, 5, 'pA', 'b1']);
  setup(P, { overs: 5, balls: 5 }); squads(P);
  extra(P, { kind: 'Nb', runs: 4, bnd: 'running' });
  eq('NB + 4 RUNNING: no boundary clip', clipCalls(P).filter(x => ['FOUR', 'SIX'].includes(x.body.eventType)).length, 0);
  setup(P, { overs: 5, balls: 5 }); squads(P);
  extra(P, { kind: 'Wd', runs: 4, bnd: 'boundary' });
  eq('WD + BOUNDARY: a FOUR clip of 5.5', meta(lastOf(clipCalls(P, 'FOUR'))) && [meta(lastOf(clipCalls(P, 'FOUR'))).over, meta(lastOf(clipCalls(P, 'FOUR'))).ballInOver], [5, 5]);
  setup(P, { overs: 5, balls: 5 }); squads(P);
  extra(P, { kind: 'Wd', runs: 4, bnd: 'running' });
  eq('WD + RUNNING: no boundary clip', clipCalls(P).filter(x => ['FOUR', 'SIX'].includes(x.body.eventType)).length, 0);

  console.log('\n=== 4 / 6 on the last ball, then the over changes ===');
  for(const k of ['4', '6']){
    setup(P, { overs: 7, balls: 5 }); squads(P);
    P.E(`recordBall('${k}')`);
    P.E(`closeNewOverModal(); setLiveBowler('Bowler Two', 'b2'); renderPanel();`);
    c = lastOf(clipCalls(P, k === '4' ? 'FOUR' : 'SIX'));
    eq(`${k} on 7.6: the clip is 7.6, batter A, bowler One — not 8.1, not the next striker or bowler`, meta(c) && [meta(c).over, meta(c).ballInOver, meta(c).batsmanId, meta(c).bowlerId], [7, 6, 'pA', 'b1']);
  }

  console.log('\n=== Unassigned bowler, then assigned ===');
  setup(P, { overs: 9, balls: 0 }); squads(P);
  P.E(`setLiveBowler('', null); renderPanel(); recordBall('1'); recordBall('4');`);
  c = lastOf(clipCalls(P, 'FOUR'));
  eq('a FOUR with no bowler yet: the clip names no bowler (never a guessed or stale one)', meta(c) && [meta(c).over, meta(c).ballInOver, meta(c).bowler, meta(c).bowlerId], [9, 2, null, null]);
  P.E(`reassignOverBowler({ overIdx: 9, name: 'Bowler Two', id: 'b2', makeLive: true }); renderPanel();`);
  eq('assigning the over updates the deliveries it owns (the server moves their clips — see wicket-bowler-test "clips 55")', J(P, 'state.ballLog.slice(-2).map(b => b.bowler)'), ['Bowler Two', 'Bowler Two']);
  eq('no script errors', P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
