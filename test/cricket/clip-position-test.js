// 🎬 CLIP → the right batter and bowler, wherever in the over it happens.
// FOUR / SIX / WICKET (caught, bowled, LBW, stumped, run out — striker or
// non-striker) on the FIRST, a MIDDLE and the LAST ball of an over, in BOTH
// panels (Clipper and Stream Engine each cut their own clips). Every clip
// request, its re-label after the wicket is confirmed, and the website
// classification must name that delivery's over.ball, striker, bowler and
// dismissed batter — never the state after it (strike rotation, the over
// ending, the new batter, the next bowler).
//
//   node test/cricket/clip-position-test.js
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
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8').replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole(); const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=CLIPPOS', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){} });
      w.fetch = (url, opts) => {
        let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch(e) {}
        calls.push({ url: String(url), body });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, recordingActive: true }) });
      };
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.firebase = undefined; w.alert = () => {}; w.confirm = () => true;
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.crypto = w.crypto || {};
      if(!w.crypto.randomUUID) w.crypto.randomUUID = () => 'uuid-' + Math.random().toString(36).slice(2);
    }
  });
  const w = dom.window;
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return { w, E: (c) => w.eval(c), calls, errors };
}
const J = (P, x) => JSON.parse(P.E(`JSON.stringify(${x})`));
const click = (P, sel) => { const el = P.w.document.querySelector(sel); if(!el) throw new Error('no ' + sel); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const change = (P, sel, v) => { const el = P.w.document.querySelector(sel); el.value = v; el.dispatchEvent(new P.w.Event('change', { bubbles: true })); };
const clips = (P, type) => P.calls.filter(c => /\/clip$/.test(c.url) && c.body && (!type || c.body.eventType === type));
const metas = (P) => P.calls.filter(c => /\/clip-meta$/.test(c.url));
const classify = (P) => P.calls.filter(c => /\/api\/clips\/classify$/.test(c.url));
const last = (a) => a[a.length - 1];

// position in the over: first ball = score at x.0, middle = x.2 (ball 3), last = x.5 (ball 6)
const SPOTS = [['FIRST', 0, 1], ['MIDDLE', 2, 3], ['LAST', 5, 6]];
function setup(P, ballsDone){
  P.E(`
    try{ closeWagonWheel(); }catch(e){}
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A'; state.inningsNumber = 1; state.wagonWheelOn = false;
    state.teamA.players = [['pA','Player A'],['pB','Player B'],['pC','Player C'],['pD','Player D']].map(([id, name]) => ({ id, name, isXI: true }));
    state.teamB.players = [['b1','Bowler One'],['b2','Bowler Two'],['k1','Keeper'],['f1','Fielder X']].map(([id, name]) => ({ id, name, isXI: true }));
    state.teamB.wkId = 'k1';
    state.striker    = { name:'Player A', id:'pA', runs:10, balls:8, fours:1, sixes:0 };
    state.nonStriker = { name:'Player B', id:'pB', runs:5, balls:6, fours:0, sixes:0 };
    state.bowler     = { name:'Bowler One', id:'b1', overs:4, balls:${ballsDone}, maidens:0, runs:20, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    state.score = { runs: 60, wickets: 2, overs: 4, balls: ${ballsDone} };
    state.thisOver = ${JSON.stringify(Array(ballsDone).fill('0'))};
    history = []; pendingHighlights = []; lastAutoWicketClip = null; pendingWicketDelivery = null;
    document.getElementById('match-id').value = 'CLIPPOS';
    renderPanel();
  `);
  P.calls.length = 0;
}
function wicket(P, o){
  P.E('openWicketModal()');
  const t = [...P.w.document.querySelectorAll('#wd-types [data-wd-type]')].find(b => b.dataset.wdType === o.type);
  t.dispatchEvent(new P.w.Event('click', { bubbles: true }));
  if(o.who) click(P, `[data-wd-who="${o.who}"]`);
  if(o.fielder) P.E(`wdSetFielder(${JSON.stringify(o.fielder)}); renderWicketDetails();`);
  if(o.runs != null) click(P, `[data-wd-runs="${o.runs}"]`);
  if(!P.w.document.querySelector('#wd-sec-newbat').hidden) change(P, '#wd-newbat-select', 'pC');
  if(!P.w.document.querySelector('#wd-sec-strike').hidden) click(P, `[data-wd-strike="${P.E('wdPredictNewOnStrike()') ? 'new' : 'survivor'}"]`);
  click(P, '#wd-confirm');
}
// what happens after the ball: the over ends → next bowler; strike changes
function moveOn(P){ P.E(`try{ closeNewOverModal(); }catch(e){} if(state.score.balls === 0){ setLiveBowler('Bowler Two', 'b2'); } renderPanel();`); }
const who = (m) => m && [m.over, m.ballInOver, m.batsmanId || m.strikerId, m.bowlerId];

async function panelSuite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file);
  await sleep(100);
  for(const [spot, done, ballNo] of SPOTS){
    console.log(`\n=== ${spot} ball of the over (4.${ballNo}) ===`);
    for(const k of ['4', '6']){
      setup(P, done);
      P.E(`recordBall('${k}')`);
      moveOn(P);
      const c = last(clips(P, k === '4' ? 'FOUR' : 'SIX'));
      eq(`${label} ${spot}: ${k === '4' ? 'FOUR' : 'SIX'} clip → 4.${ballNo}, Player A, Bowler One`, who(c && c.body.ballMeta), [4, ballNo, 'pA', 'b1']);
      eq(`${label} ${spot}: …one clip only`, clips(P, k === '4' ? 'FOUR' : 'SIX').length, 1);
      if(ballNo === 6) eq(`${label} ${spot}: …though the over moved on to Bowler Two`, J(P, '[state.score.overs, state.score.balls, state.bowler.name]'), [5, 0, 'Bowler Two']);
    }
    // a single changes strike: the next ball's clip is Player B's
    setup(P, done === 5 ? 1 : done);
    P.E(`recordBall('1'); recordBall('4');`);
    const c2 = last(clips(P, 'FOUR'));
    const nb = (done === 5 ? 1 : done) + 2;
    eq(`${label} ${spot}: after a single, the FOUR is Player B's (strike changed)`, who(c2 && c2.body.ballMeta), [4, nb, 'pB', 'b1']);

    const cases = [
      { type: 'Caught', fielder: 'f1', out: 'pA', fld: 'Fielder X' },
      { type: 'Bowled', out: 'pA' },
      { type: 'LBW', out: 'pA' },
      { type: 'Stumped', out: 'pA', fld: 'Keeper' },
      { type: 'Run Out', who: 'nonStriker', fielder: 'f1', runs: 0, out: 'pB', fld: 'Fielder X' }
    ];
    for(const o of cases){
      setup(P, done);
      wicket(P, o);
      moveOn(P);
      await sleep(2300);
      const press = last(clips(P, 'WICKET'));
      eq(`${label} ${spot}: ${o.type}${o.who ? ' (non-striker)' : ''} — the clip is cut at the press: 4.${ballNo}, striker A, Bowler One`, who(press && press.body.ballMeta), [4, ballNo, 'pA', 'b1']);
      eq(`${label} ${spot}: ${o.type} — exactly one wicket clip`, clips(P, 'WICKET').length, 1);
      const rl = last(metas(P));
      const m = rl && rl.body.ballMeta;
      eq(`${label} ${spot}: ${o.type} — re-labelled: the right batter out, the bowler, the fielder`,
        m && [m.over, m.ballInOver, m.dismissedPlayerId, m.bowlerId, (m.dismissal && m.dismissal.fielder) || null], [4, ballNo, o.out, 'b1', o.fld || null]);
      const cl = last(classify(P));
      eq(`${label} ${spot}: ${o.type} — the website is told the same`, cl && cl.body.ballMeta && [cl.body.eventType, cl.body.ballMeta.ballInOver, cl.body.ballMeta.dismissedPlayerId, cl.body.ballMeta.bowlerId], ['WICKET', ballNo, o.out, 'b1']);
      eq(`${label} ${spot}: ${o.type} — the ball log row agrees`, J(P, `(() => { const b = state.ballLog.filter(x => x.isWicket).pop(); return [b.over, b.dismissedPlayerId, b.bowler]; })()`), [`4.${ballNo}`, o.out, 'Bowler One']);
    }
  }
  console.log(`\n=== FIRST ball of a NEW over, new bowler on ===`);
  setup(P, 5);
  P.E(`recordBall('0')`); moveOn(P);
  eq(`${label}: over ended, strike changed, Bowler Two on`, J(P, '[state.score.overs, state.score.balls, state.striker.name, state.bowler.name]'), [5, 0, 'Player B', 'Bowler Two']);
  P.E(`recordBall('6')`);
  eq(`${label}: SIX on 5.1 → Player B off Bowler Two`, who(last(clips(P, 'SIX')).body.ballMeta), [5, 1, 'pB', 'b2']);
  P.calls.length = 0;
  P.E(`recordBall('1')`);
  wicket(P, { type: 'Caught', fielder: 'k1', out: 'pA' });
  await sleep(2300);
  const m = last(metas(P)).body.ballMeta;
  eq(`${label}: wicket on 5.3 → Player A out, Bowler Two, caught by the keeper`, [m.over, m.ballInOver, m.dismissedPlayerId, m.bowlerId, m.dismissal.fielder], [5, 3, 'pA', 'b2', 'Keeper']);
  eq(`${label}: no script errors`, P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}
(async () => {
  await panelSuite('cricket-panel.html', 'CLIPPER');
  await panelSuite('cricket-panel3.html', 'ENGINE');
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
