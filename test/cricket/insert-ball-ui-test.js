// Add / Insert a missing ball — the REAL cricket-scorecard.html (jsdom):
// the owner-only ＋ controls in Edit Scorecard, the editor in insert mode
// (number of the new ball, crease pre-filled, sequence preview from the
// server, attach an unmatched clip), Save, and the over list reloading.
//
//   node test/cricket/insert-ball-ui-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CTX = {
  success: true, matchId: 'M1', innings: 1, battingTeam: 'A',
  position: { idx: 50, beforeId: 'b85', afterId: 'b83' },
  label: { legal: { over: 8, ballInOver: 4 }, extra: { over: 8, ballInOver: 3 } }, overFull: false,
  neighbours: { prev: { id: 'b83', label: '8.3', text: 'Dot ball' }, next: { id: 'b85', label: '8.4', text: 'FOUR' } },
  input: { runsOffBat: 0, extras: 0, extraType: 'none', wicket: false, dismissalType: null, fielder: '', fielderId: null, dismissed: 'striker',
    striker: 'Bharat', strikerId: 'pB', nonStriker: 'Chetan', nonStrikerId: 'pC', bowler: 'Bowler Two', bowlerId: 'b2' },
  orphanClips: [{ id: 'c9', eventType: 'FOUR', over: 8, ballInOver: 4, ready: true }],
  rosters: { A: { name: 'Lions', hasSquad: false, players: [{ key: 'bharat', name: 'Bharat', id: 'pB' }, { key: 'chetan', name: 'Chetan', id: 'pC' }] },
             B: { name: 'Tigers', hasSquad: false, players: [{ key: 'bowler two', name: 'Bowler Two', id: 'b2' }] } },
  finished: true, dismissalTypes: ['Bowled', 'Caught', 'LBW', 'Stumped', 'Hit Wicket', 'Run Out']
};
const BALL = { ballId: 'b85', innings: 1, over: 8, ballInOver: 4, kind: '4', runs: 4, striker: 'Bharat', nonStriker: 'Chetan', bowler: 'Bowler Two', _key: '1.8.4' };

function boot(email){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', 'cricket-scorecard.html'), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole(); const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-scorecard?room=M1', virtualConsole: vc,
    beforeParse(w){
      const user = email ? { email, getIdToken: async () => 'tok' } : null;
      w.firebase = { initializeApp(){}, auth: () => ({ currentUser: user, onAuthStateChanged(cb){ setTimeout(() => cb(user), 30); } }) };
      w.firebase.auth.GoogleAuthProvider = function(){};
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){}, removeAllListeners(){} });
      w.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      w.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} };
      w.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
      w.HTMLMediaElement.prototype.load = () => {}; w.HTMLMediaElement.prototype.pause = () => {};
      w.confirm = () => true; w.alert = () => {};
      w.fetch = (url, opts) => {
        url = String(url);
        let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch(e) {}
        calls.push({ url, method: (opts && opts.method) || 'GET', body });
        const json = (o, status) => Promise.resolve({ ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(o) });
        if(/\/insert-context\?/.test(url)) return json(CTX);
        if(/\/insert\/preview$/.test(url)){
          const d = body.delivery, legal = !(d.extraType === 'wide' || d.extraType === 'noball');
          const lbl = legal ? '8.4' : '8.3';
          return json({ success: true, errors: [], moved: legal ? 12 : 0, swapped: legal && d.runsOffBat % 2 ? [{ id: 'x' }] : [],
            before: { cards: { scoreA: { runs: 100, wickets: 2 } } }, after: { cards: { scoreA: { runs: 100 + (d.runsOffBat || 0) + (legal ? 0 : 1), wickets: 2 } } },
            inserted: { label: lbl }, mixedBowlerOvers: legal ? [{ over: 9, bowlers: ['Bowler Two', 'Bowler One'] }] : [],
            sequence: { overs: [8], moreOvers: 0, before: [{ label: '8.3', text: 'Dot ball' }, { label: '8.4', text: 'FOUR' }], after: [{ label: '8.3', text: 'Dot ball' }, { label: lbl, text: 'NEWBALL', tag: 'new' }, { label: '8.5', text: 'FOUR', tag: 'moved' }] } });
        }
        if(/\/insert$/.test(url)) return json({ success: true, inserted: { id: 'new1', label: '8.4' } });
        if(/\/cricket\/match\/M1\/balls$/.test(url)) return json({ success: true, roster: [], balls: [] });
        if(/\/api\/clips\/match\//.test(url)) return json({ success: true, clips: [] });
        return json({ success: false });
      };
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { w: dom.window, E: (c) => dom.window.eval(c), calls, errors };
}
const click = (P, sel) => P.w.document.querySelector(sel).dispatchEvent(new P.w.Event('click', { bubbles: true }));
const q = (P, sel) => P.w.document.querySelector(sel);
const setCache = (P) => P.E(`deliveryListCache = { matchId:'M1', balls:[${JSON.stringify(BALL)}], roster:[], clipMap:new Map(), overStats:new Map() }; emState.innings = 1; emState.over = 8;`);

(async () => {
  console.log('\n=== Owner only ===');
  {
    const P = boot('someone@gmail.com'); await sleep(120);
    setCache(P);
    P.E(`openInsertBall({ endOfOver: 8 })`);
    await sleep(30);
    eq('another Gmail: nothing opens, nothing is requested', P.calls.filter(c => /insert/.test(c.url)).length, 0);
    eq('the Edit Scorecard entry chip stays hidden', q(P, '#owner-chip').classList.contains('show'), false);
  }
  const P = boot('chhayajeeth@gmail.com'); await sleep(120);
  setCache(P);
  eq('owner: ＋ insert-before on every ball row', /data-insert-before="b85"/.test(P.E(`emRowHtml(${JSON.stringify(BALL)})`)), true);

  console.log('\n=== Insert before 8.4 (the ＋ on that ball) ===');
  P.E(`openInsertBall({ before: 'b85' })`);
  await sleep(60);
  const ctxCall = P.calls.find(c => /insert-context/.test(c.url));
  eq('context asked for innings 1, before b85', /innings=1/.test(ctxCall.url) && /before=b85/.test(ctxCall.url), true);
  eq('title: New ball 8.4', q(P, '#ce-title').textContent, 'New ball 8.4');
  eq('crease and bowler pre-filled from the history', [q(P, '[data-person="striker"] b').textContent, q(P, '[data-person="nonStriker"] b').textContent, q(P, '[data-person="bowler"] b').textContent], ['Bharat', 'Chetan', 'Bowler Two']);
  eq('recalculation warning shown', /recalculate all affected deliveries/.test(q(P, '#ce-root').textContent), true);
  await sleep(450);
  const pv = P.calls.filter(c => /insert\/preview/.test(c.url)).slice(-1)[0];
  eq('server preview with position + strike fix on', pv && [pv.body.innings, pv.body.position.before, pv.body.restrike, pv.body.delivery.striker], [1, 'b85', true, 'Bharat']);
  eq('sequence preview: NEW ball and the moved ones', [/NEWBALL/.test(q(P, '#ce-root').textContent), /moved/.test(q(P, '#ce-root').textContent)], [true, true]);
  eq('mixed-bowler over flagged', /Transfer Over/.test(q(P, '#ce-root').textContent), true);
  eq('Save Ball enabled once checked', [q(P, '#ce-save').textContent, q(P, '#ce-save').disabled], ['Save Ball', false]);

  console.log('\n=== A Wide keeps the position; a run changes the strike preview ===');
  click(P, '[data-ex="wide"]');
  eq('title: New ball 8.3 for a Wide', q(P, '#ce-title').textContent, 'New ball 8.3');
  click(P, '[data-ex="wide"]');
  click(P, '[data-run="1"]');
  await sleep(450);
  eq('back to 8.4; strike corrected on a later ball reported', [q(P, '#ce-title').textContent, /striker corrected on 1 later delivery/.test(q(P, '.ce-impact').textContent)], ['New ball 8.4', true]);

  console.log('\n=== Attach an unmatched clip, then Save ===');
  click(P, '[data-ac="c9"]');
  eq('clip category appears once a clip is attached', q(P, '[data-hl="1"]').closest('.ed-card').hasAttribute('hidden'), false);
  await sleep(450);
  click(P, '#ce-save');
  await sleep(80);
  const save = P.calls.filter(c => /\/insert$/.test(c.url)).slice(-1)[0];
  eq('POST insert with the full delivery + clip', save && [save.method, save.body.delivery.runsOffBat, save.body.attachClipId, save.body.position.before], ['POST', 1, 'c9', 'b85']);
  eq('back to the over list (reloaded from the server)', P.calls.some(c => /\/cricket\/match\/M1\/balls$/.test(c.url) && P.calls.indexOf(c) > P.calls.indexOf(save)), true);
  eq('clips reloaded too', P.calls.some(c => /\/api\/clips\/match\//.test(c.url) && P.calls.indexOf(c) > P.calls.indexOf(save)), true);
  eq('no script errors', P.errors, []);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
