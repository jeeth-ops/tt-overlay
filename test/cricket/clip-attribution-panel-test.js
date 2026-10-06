// End-to-end: the REAL panel scoring engine (jsdom), driven through the
// real wicket modals, checking that every clip request, clip re-label,
// website classification and ball-log row names the players of the
// delivery that created it — not the live state after the over turned.
//
//   npm install --no-save jsdom
//   node test/cricket/clip-attribution-panel-test.js
//
// Runs against both panels: cricket-panel.html (Clipper Helper) and
// cricket-panel3.html (Stream Engine).
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
const click = (P, sel) => P.w.document.querySelector(sel).dispatchEvent(new P.w.Event('click', { bubbles: true }));
// "Then the match moves on": new batsman in, next over's bowler named.
function moveOn(P){
  P.E(`sendInNewBatsman('Player C', 'pC'); state.bowler = { name:'Bowler Two', id:'b2', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };`);
}

async function runOutLastBall(P, who, runsCompleted){
  setup(P);
  P.E('openWicketModal()');
  click(P, '[data-wd-type="Run Out"]');
  if(runsCompleted) click(P, `[data-wd-runs="${runsCompleted}"]`);
  click(P, `[data-wd-who="${who}"]`);
  click(P, '#wd-confirm');
  moveOn(P);
  await sleep(2300); // the website classification is sent HL_CLASSIFY_DELAY_MS after the ball
}

async function suite(file, opts){
  console.log(`\n################ ${file} ################`);
  const P = boot(file);
  ok(`${file}: boots without script errors`, P.errors.length === 0, P.errors.join(' | '));
  ok(`${file}: ClipAttribution is inlined`, P.E('typeof ClipAttribution') === 'object');

  console.log('\n=== Test A — 12.6 run out, STRIKER A out ===');
  await runOutLastBall(P, 'striker', 0);
  {
    const press = clipCalls(P, 'WICKET')[0];
    ok('wicket clip cut at the press', !!press);
    eq('press ball = 12.6', press && [press.body.ballMeta.over, press.body.ballMeta.ballInOver], [12, 6]);
    eq('press bowler = original bowler', press && press.body.ballMeta.bowlerId, 'b1');
    const log = lastLog(P);
    eq('ball log: 12.6, A out', [log.over, log.dismissedPlayerId, log.dismissedPlayer], ['12.6', 'pA', 'Player A']);
    const row = lastDbRow(P);
    eq('DB row: dismissal.batterId = A, bowler = b1', [row.payload.dismissal.batterId, row.payload.bowlerId, row.payload.over, row.payload.ballInOver], ['pA', 'b1', 12, 6]);
    eq('DB row uid = deliveryId on the ball log', row.uid, log.deliveryId);
    if(opts.relabels){
      const m = metaCalls(P).slice(-1)[0];
      eq('clip re-label: dismissedPlayerId = A, batsman = A', m && [m.body.ballMeta.dismissedPlayerId, m.body.ballMeta.batsmanId, m.body.ballMeta.bowlerId, m.body.ballMeta.deliveryId], ['pA', 'pA', 'b1', log.deliveryId]);
    }
    const c = classifyCalls(P).filter(x => /_WICKET_/.test(x.body.clipId)).slice(-1)[0];
    eq('website classification: dismissed A, ball 12.6', c && [c.body.ballMeta.dismissedPlayerId, c.body.ballMeta.over, c.body.ballMeta.ballInOver, c.body.eventType], ['pA', 12, 6, 'WICKET']);
    eq('live state really moved on (striker now B, bowler two)', [P.E('state.striker.id'), P.E('state.bowler.id')], ['pB', 'b2']);
  }

  console.log('\n=== Test B — 12.6 run out, NON-STRIKER B out ===');
  await runOutLastBall(P, 'nonStriker', 0);
  {
    const log = lastLog(P);
    eq('ball log: B out, striker of the delivery still A', [log.dismissedPlayerId, log.strikerId], ['pB', 'pA']);
    eq('DB row: dismissal.batterId = B', lastDbRow(P).payload.dismissal.batterId, 'pB');
    const c = classifyCalls(P).filter(x => /_WICKET_/.test(x.body.clipId)).slice(-1)[0];
    eq('website classification: dismissed B, batsman B, bowler b1', c && [c.body.ballMeta.dismissedPlayerId, c.body.ballMeta.batsmanId, c.body.ballMeta.bowlerId], ['pB', 'pB', 'b1']);
    eq('batting card: B is the one marked out', JSON.parse(P.E(`JSON.stringify((typeof activeBattingCard === "function" ? activeBattingCard("A") : state.battingCard.A).slice(-1)[0])`)).id, 'pB');
  }

  console.log('\n=== Test C — 12.6, one run completed, B run out ===');
  await runOutLastBall(P, 'nonStriker', 1);
  {
    const log = lastLog(P);
    eq('B out, 1 run credited to striker A', [log.dismissedPlayerId, log.runs], ['pB', 1]);
  }
  console.log('\n=== Test D — 12.6, two runs completed, B run out ===');
  await runOutLastBall(P, 'nonStriker', 2);
  eq('B out', lastLog(P).dismissedPlayerId, 'pB');

  console.log('\n=== Test E / F — 12.6 bowled A, caught A by X ===');
  setup(P);
  P.E('openWicketModal()');
  click(P, '[data-wd-type="Bowled"]'); click(P, '#wd-confirm');
  moveOn(P);
  await sleep(2300);
  {
    const log = lastLog(P);
    eq('bowled: A out, bowler b1, 12.6', [log.dismissedPlayerId, log.over, lastDbRow(P).payload.bowlerId], ['pA', '12.6', 'b1']);
    const c = classifyCalls(P).filter(x => /_WICKET_/.test(x.body.clipId)).slice(-1)[0];
    eq('bowled classification', c && [c.body.ballMeta.dismissedPlayerId, c.body.ballMeta.bowlerId, c.body.ballMeta.dismissal.type], ['pA', 'b1', 'Bowled']);
  }
  setup(P);
  P.E('openWicketModal()');
  click(P, '[data-wd-type="Caught"]');
  P.E(`document.getElementById('wd-fielder-input').value = 'Fielder X'`);
  click(P, '#wd-confirm');
  moveOn(P);
  await sleep(2300);
  {
    const c = classifyCalls(P).filter(x => /_WICKET_/.test(x.body.clipId)).slice(-1)[0];
    eq('caught: A out, fielder X, bowler b1', c && [c.body.ballMeta.dismissedPlayerId, c.body.ballMeta.dismissal.fielder, c.body.ballMeta.bowlerId], ['pA', 'Fielder X', 'b1']);
  }

  console.log('\n=== Test G / H — 12.6 SIX / FOUR by A ===');
  for(const k of ['6', '4']){
    setup(P);
    P.E(`recordBall('${k}')`);
    eq(`${k}: the over turned — live striker is now B`, P.E('state.striker.id'), 'pB');
    P.E(`state.bowler = { name:'Bowler Two', id:'b2', overs:0, balls:0, maidens:0, runs:0, wickets:0 }`);
    const ev = k === '6' ? 'SIX' : 'FOUR';
    const c = clipCalls(P, ev)[0];
    eq(`${ev} clip: batsman A, bowler b1, ball 12.6`, c && [c.body.ballMeta.strikerId, c.body.ballMeta.batsmanId, c.body.ballMeta.bowlerId, c.body.ballMeta.over, c.body.ballMeta.ballInOver], ['pA', 'pA', 'b1', 12, 6]);
    eq(`${ev} clip carries the delivery id`, c && c.body.ballMeta.deliveryId, lastLog(P).deliveryId);
  }

  console.log('\n=== Last-ball extras ===');
  setup(P);
  P.E(`recordBall('Nb', { runsOffBat: 4 })`);
  {
    const c = clipCalls(P, 'FOUR')[0];
    eq('No-ball + FOUR on 12.5+: A, not a legal ball (12.5)', c && [c.body.ballMeta.batsmanId, c.body.ballMeta.over, c.body.ballMeta.ballInOver], ['pA', 12, 5]);
    eq('over not completed by a no-ball', [P.E('state.score.overs'), P.E('state.score.balls')], [12, 5]);
  }

  console.log('\n=== Test I — multi-device: crease changes while the wicket modal is open ===');
  setup(P);
  P.E('openWicketModal()');
  click(P, '[data-wd-type="Run Out"]');
  click(P, '[data-wd-who="striker"]');
  const logLen = P.E('state.ballLog.length');
  // Another device's update lands: different batters at the crease.
  P.E(`state.striker = { name:'Player C', id:'pC', runs:0, balls:0, fours:0, sixes:0 }`);
  click(P, '#wd-confirm');
  eq('nothing recorded against the wrong batter', P.E('state.ballLog.length'), logLen);

  console.log('\n=== one wicket, one clip ===');
  setup(P);
  P.E('openWicketModal()');
  click(P, '#wd-cancel');
  P.E('openWicketModal()');
  click(P, '[data-wd-type="Bowled"]'); click(P, '#wd-confirm');
  eq('cancel + re-press cuts ONE wicket clip', clipCalls(P, 'WICKET').length, 1);
  setup(P);
  P.E('openWicketModal()');
  click(P, '#wd-cancel');
  P.E(`recordBall('1')`);
  P.E('answerOldestHighlightPrompt(false)'); // "Add this clip to Highlights?" → NO
  await sleep(2300);
  {
    const m = metaCalls(P).slice(-1)[0];
    ok('a cancelled wicket press becomes a normal clip of the ball actually scored', m && m.body.eventType === 'CLIP' && /_WICKET_/.test(m.body.clipId), JSON.stringify(m && m.body));
  }

  if(opts.undo){
    console.log('\n=== Undo → re-score reuses the same wicket clip ===');
    setup(P);
    P.E('openWicketModal()');
    click(P, '[data-wd-type="Bowled"]'); click(P, '#wd-confirm');
    const firstClip = clipCalls(P, 'WICKET')[0].body.clipId;
    P.E('sendInNewBatsman("Player C", "pC")');
    const lenAfterWicket = P.E('state.ballLog.length');
    await P.E('deleteLastBall()'); // undoes "new batsman" only
    eq('undoing the new batsman keeps the wicket in the log', P.E('state.ballLog.length'), lenAfterWicket);
    await P.E('deleteLastBall()'); // undoes the wicket
    eq('undoing the wicket removes it', P.E('state.ballLog.length'), lenAfterWicket - 1);
    P.E('openWicketModal()');
    click(P, '[data-wd-type="Run Out"]');
    click(P, '[data-wd-who="nonStriker"]');
    click(P, '#wd-confirm');
    eq('no second wicket clip after undo', clipCalls(P, 'WICKET').length, 1);
    const m = metaCalls(P).filter(x => x.body.clipId === firstClip).slice(-1)[0];
    eq('the original clip is re-labelled with the corrected dismissal', m && [m.body.ballMeta.dismissedPlayerId, m.body.ballMeta.dismissal.type], ['pB', 'Run Out']);
  }

  if(opts.fiveBallOvers){
    console.log('\n=== 5-ball overs: the over-completing ball is ball 5, not 6 ===');
    setup(P, { overs: 3, balls: 4 });
    P.E(`FORMAT_RULES.T20.ballsPerOver = 5`);
    P.E(`recordBall('6')`);
    const c = clipCalls(P, 'SIX')[0];
    eq('SIX on 3.5 labelled 3.5', c && [c.body.ballMeta.over, c.body.ballMeta.ballInOver], [3, 5]);
    eq('ball log 3.5', lastLog(P).over, '3.5');
    P.E(`FORMAT_RULES.T20.ballsPerOver = 6`);
  }
  console.log('\n=== Owner correction from the website reaches the live panel (12.6 FOUR → SIX) ===');
  {
    setup(P);
    P.E(`recordBall('4')`);
    const did = lastLog(P).deliveryId;
    // the over turned; the next bowler is on and Bowler One's spell is on the card
    P.E(`state.bowlingCard.B = [Object.assign({}, state.bowler, { inningsNo: 1 })]; state.bowler = { name:'Bowler Two', id:'b2', overs:0, balls:0, maidens:0, runs:0, wickets:0 };`);
    const before = JSON.parse(P.E('JSON.stringify({ runs: state.score.runs, a: state.nonStriker, b: state.striker, bowl: state.bowlingCard.B[0], two: state.bowler })'));
    P.calls.length = 0;
    const ev = { id: 'corr_test_1', matchId: 'TESTMATCH', deliveryId: did, innings: 1, battingTeam: 'A', overLabel: '12.6', legalChanged: false,
      before: { kind: '4', runs: 4, striker: 'Player A', nonStriker: 'Player B', bowler: 'Bowler One', dismissal: null },
      after: { kind: '6', runs: 6, striker: 'Player A', nonStriker: 'Player B', bowler: 'Bowler One', dismissal: null },
      delta: { team: { runs: 2, wickets: 0, extras: {} }, batting: [{ name: 'Player A', runs: 2, balls: 0, fours: -1, sixes: 1, outBefore: false, outAfter: false }], bowling: [{ name: 'Bowler One', balls: 0, runs: 2, wickets: 0 }] },
      clips: [{ clipId: 'TESTMATCH_FOUR_1790000000000', eventType: 'SIX', outcomeLabel: 'SIX', isHighlight: true }],
      ballMeta: { deliveryId: did, innings: 1, over: 12, ballInOver: 6, striker: 'Player A', strikerId: 'pA', bowler: 'Bowler One', bowlerId: 'b1', dismissal: null } };
    P.w.__ev = ev;
    P.E('applyServerCorrection(window.__ev)');
    const after = JSON.parse(P.E('JSON.stringify({ runs: state.score.runs, a: state.nonStriker, b: state.striker, bowl: state.bowlingCard.B[0], two: state.bowler, log: state.ballLog[state.ballLog.length-1] })'));
    eq('team total +2', after.runs - before.runs, 2);
    eq('Player A (now non-striker) +2, 4s -1, 6s +1', [after.a.runs - before.a.runs, after.a.fours - before.a.fours, after.a.sixes - before.a.sixes], [2, -1, 1]);
    eq('Player B (now on strike) untouched', after.b.runs, before.b.runs);
    eq("Bowler One's card row +2; Bowler Two (bowling now) untouched", [after.bowl.runs - before.bowl.runs, after.two.runs], [2, 0]);
    eq('ball log row for that delivery is a 6', [after.log.ballType, after.log.runs], ['6', 6]);
    const refile = P.calls.filter(c => /\/clip-meta$/.test(c.url)).slice(-1)[0];
    eq('clip re-filed locally as a SIX (metadata only)', refile && [refile.body.clipId, refile.body.eventType], ['TESTMATCH_FOUR_1790000000000', 'SIX']);
    P.E('applyServerCorrection(window.__ev)');
    eq('the same correction twice is applied once', P.E('state.score.runs') - before.runs, 2);
  }

  ok(`${file}: no script errors during the run`, P.errors.length === 0, P.errors.join(' | '));
}

(async () => {
  await suite('cricket-panel.html', { relabels: true, undo: true, fiveBallOvers: true });
  await suite('cricket-panel3.html', { relabels: true, undo: true });
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  if(fail){ console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})();
