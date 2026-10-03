// The Advanced Clip Editor in the REAL cricket-scorecard.html (jsdom):
// owner-only ⋯ button, the editor opening from the server's data, live
// change summary, server-checked preview before Save, the exact delivery
// sent on Save, and the page refreshing its clips straight after.
//
//   node test/cricket/clip-editor-ui-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const EDITOR = {
  success: true,
  clip: { clipId: '64b000000000000000000001', helperClipId: 'M1_FOUR_111', matchId: 'M1', eventType: 'FOUR', over: 12, ballInOver: 6, innings: 1,
    striker: 'Amit', bowler: 'Bowler One', ready: true, playbackUrl: 'https://r2.example/M1_FOUR_111.mp4', isHighlight: true, deliveryId: 'd6' },
  delivery: { ballId: 'b6', deliveryId: 'd6', matchId: 'M1', innings: 1, over: 12, ballInOver: 6, battingTeam: 'A', kind: '4', runs: 4, legalBall: true,
    input: { runsOffBat: 4, extras: 0, extraType: 'none', wicket: false, dismissalType: null, fielder: '', fielderId: null, dismissed: 'striker',
      striker: 'Amit', strikerId: 'pA', nonStriker: 'Bharat', nonStrikerId: 'pB', bowler: 'Bowler One', bowlerId: 'b1' } },
  rosters: { A: { name: 'Lions', hasSquad: true, players: [{ key: 'amit', name: 'Amit', id: 'pA' }, { key: 'bharat', name: 'Bharat', id: 'pB' }, { key: 'chetan', name: 'Chetan', id: 'pC' }] },
             B: { name: 'Tigers', hasSquad: true, players: [{ key: 'bowler one', name: 'Bowler One', id: 'b1' }, { key: 'dev', name: 'Dev', id: 'b4' }, { key: 'fielder x', name: 'Fielder X', id: 'f1' }] } },
  finished: false, dismissalTypes: ['Bowled', 'Caught', 'LBW', 'Stumped', 'Hit Wicket', 'Run Out'], extraTypes: []
};

function boot(email){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', 'cricket-scorecard.html'), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://example.test/cricket-scorecard?room=M1', virtualConsole: vc,
    beforeParse(w){
      const user = email ? { email, getIdToken: async () => 'tok-' + email } : null;
      w.firebase = { initializeApp(){}, auth: () => ({ currentUser: user, onAuthStateChanged(cb){ setTimeout(() => cb(user), 30); }, signInWithPopup(){}, signOut(){} }), firestore: () => ({}) };
      w.firebase.auth.GoogleAuthProvider = function(){};
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){}, removeAllListeners(){} });
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      w.IntersectionObserver = w.IntersectionObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.ResizeObserver = w.ResizeObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.HTMLMediaElement.prototype.load = () => {};
      w.HTMLMediaElement.prototype.pause = () => {};
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.confirm = () => true; w.alert = () => {};
      w.fetch = (url, opts) => {
        url = String(url);
        let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch(e) {}
        calls.push({ url, method: (opts && opts.method) || 'GET', body, auth: opts && opts.headers && opts.headers.Authorization });
        const json = (o, status) => Promise.resolve({ ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(o) });
        if(/\/api\/admin\/clips\/[^/]+\/editor$/.test(url)) return json(EDITOR);
        if(/\/edit\/preview$/.test(url)){
          const d = body.delivery;
          if(d.bowler === 'Chetan') return json({ success: false, error: 'This delivery cannot be saved because the selected bowler (Chetan) is not part of the bowling team (Tigers).' }, 400);
          return json({ success: true, errors: [], before: { cards: { scoreA: { runs: 120, wickets: 3 } } }, after: { ball: { kind: String(d.runsOffBat) }, cards: { scoreA: { runs: 120 + d.runsOffBat - 4, wickets: 3 } } }, clipsAfter: [{}] });
        }
        if(/\/clips\/[^/]+\/edit$/.test(url)) return json({ success: true, clip: { over: 12, ballInOver: 6, outcome: 'SIX', eventType: 'SIX' } });
        if(/\/api\/clips\/match\//.test(url)) return json({ success: true, clips: [] });
        return json({ success: false });
      };
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { w: dom.window, E: (c) => dom.window.eval(c), calls, errors };
}
const click = (P, el) => el.dispatchEvent(new P.w.Event('click', { bubbles: true }));
const q = (P, sel) => P.w.document.querySelector(sel);

(async () => {
  console.log('\n=== Who sees the ⋯ Edit action ===');
  {
    const P = boot("someone@gmail.com"); await sleep(120);
    const html = P.E(`hlCardHtml(${JSON.stringify(EDITOR.clip)}, -1)`);
    eq('another Gmail: no ⋯ edit button', /data-edit-clip/.test(html), false);
    P.E(`openClipEditor('x')`);
    eq('another Gmail: the editor refuses to open (no request sent)', P.calls.filter(c => /\/api\/admin\//.test(c.url)).length, 0);
  }
  const P = boot("chhayajeeth@gmail.com"); await sleep(120);
  {
    const html = P.E(`hlCardHtml(${JSON.stringify(EDITOR.clip)}, -1)`);
    eq('owner: ⋯ edit button on the clip card', /data-edit-clip="64b000000000000000000001"/.test(html), true);
    const row = P.E(`clipRowHtml(${JSON.stringify(EDITOR.clip)})`);
    eq('owner: ⋯ edit button on list rows too', /data-edit-clip/.test(row), true);
  }

  console.log('\n=== Opening the editor ===');
  P.E(`openClipEditor('64b000000000000000000001')`);
  await sleep(50);
  const load = P.calls.find(c => /\/editor$/.test(c.url));
  eq('loads through the owner API with the signed-in token', load && [load.method, load.auth], ['GET', 'Bearer tok-chhayajeeth@gmail.com']);
  eq('title is the delivery: 12.6 • FOUR', q(P, '#ce-root .em-title').textContent, '12.6 • FOUR');
  eq('preview plays the existing clip (no re-cut)', q(P, '#ce-video').getAttribute('src'), 'https://r2.example/M1_FOUR_111.mp4');
  eq('delivery link shown read-only', /d6/.test(q(P, '.ce-meta').textContent) && /M1/.test(q(P, '.ce-meta').textContent), true);
  eq('Save disabled with no changes', q(P, '#ce-save').disabled, true);

  console.log('\n=== FOUR → SIX: live summary, server check, Save ===');
  click(P, q(P, '[data-run="6"]'));
  eq('summary After updates at once', /12\.6 • SIX/.test(q(P, '.ce-sum .after').textContent), true);
  eq('Save waits for the server check', q(P, '#ce-save').disabled, true);
  await sleep(450);
  const pv = P.calls.filter(c => /\/edit\/preview$/.test(c.url)).slice(-1)[0];
  eq('preview sent the corrected delivery', pv && [pv.method, pv.body.delivery.runsOffBat, pv.body.delivery.striker, pv.body.delivery.strikerId, pv.body.delivery.bowlerId], ['POST', 6, 'Amit', 'pA', 'b1']);
  eq('impact line: team total 120/3 → 122/3', /120\/3 → 122\/3/.test(q(P, '.ce-impact').textContent), true);
  eq('Save enabled after a clean check', q(P, '#ce-save').disabled, false);

  console.log('\n=== Invalid bowler is shown inline and blocks Save ===');
  P.E(`(function(){ const b = document.querySelector('[data-person="bowler"]'); b.click(); })()`);
  await sleep(10);
  P.E(`(function(){ const i = document.querySelector('.pk input'); i.value = 'Chetan'; i.dispatchEvent(new Event('input')); })()`);
  await sleep(10);
  click(P, q(P, '.pk-it'));
  eq('typed name kept exactly as typed', q(P, '[data-person="bowler"] b').textContent, 'Chetan');
  await sleep(450);
  eq('server refusal shown inline', /not part of the bowling team/.test(q(P, '#ce-msgs').textContent), true);
  eq('Save blocked', q(P, '#ce-save').disabled, true);
  // back to the right bowler through the picker
  P.E(`document.querySelector('[data-person="bowler"]').click()`);
  await sleep(10);
  P.E(`(function(){ const i = document.querySelector('.pk input'); i.value = 'Bowler One'; i.dispatchEvent(new Event('input')); })()`);
  await sleep(10);
  click(P, q(P, '.pk-it'));
  await sleep(450);

  console.log('\n=== Wicket section: Run Out → who was out ===');
  click(P, q(P, '[data-wk="1"]'));
  click(P, q(P, '[data-dis="Run Out"]'));
  eq('run out shows Striker / Non-striker with names', [/Striker\s*Amit/.test(q(P, '.ce-seg').textContent), /Non-striker\s*Bharat/.test(q(P, '.ce-seg').textContent)], [true, true]);
  click(P, q(P, '[data-who="nonStriker"]'));
  eq('summary: Dismissed Bharat', /Dismissed: Bharat/.test(q(P, '.ce-sum .after').textContent), true);
  eq('credit line: not a bowler wicket', [...P.w.document.querySelectorAll('.ce-credit')].some(e => /Not a bowler's wicket/.test(e.textContent)), true);
  click(P, q(P, '[data-dis="Caught"]'));
  eq('caught needs a fielder — shown before Save', /choose the fielder/.test(q(P, '#ce-msgs').textContent), true);
  click(P, q(P, '[data-wk="1"]')); // back to no wicket
  click(P, q(P, '[data-run="6"]'));
  await sleep(450);

  console.log('\n=== Save ===');
  click(P, q(P, '#ce-save'));
  await sleep(80);
  const put = P.calls.filter(c => /\/edit$/.test(c.url)).slice(-1)[0];
  eq('PUT sends delivery + highlight choice', put && [put.method, put.body.delivery.runsOffBat, put.body.delivery.wicket, put.body.isHighlight], ['PUT', 6, false, true]);
  eq('editor closed', P.w.document.getElementById('edit-modal-backdrop').classList.contains('open'), false);
  eq('clips reloaded straight away (no page refresh)', P.calls.filter(c => /\/api\/clips\/match\//.test(c.url) && P.calls.indexOf(c) > P.calls.indexOf(put)).length > 0, true);
  eq('no script errors', P.errors, []);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
