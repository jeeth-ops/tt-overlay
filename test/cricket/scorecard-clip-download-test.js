// The player clip drawer in the REAL cricket-scorecard.html (jsdom): "Download
// as one video" — every clip of this player in this match, or only one kind
// (his 4s, his 6s, 4s + 6s, the wickets he took) — offers only what exists,
// says how many clips each option holds, and sends that category to the
// match compile (POST /api/highlights/compile { type:'player', category }).
//
//   node test/cricket/scorecard-clip-download-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const clip = (id, eventType, o) => Object.assign({ clipId: id, matchId: 'M1', eventType, over: 3, ballInOver: 2, innings: 1, ready: true, downloadUrl: '/api/clips/' + id + '/download' }, o);
// What /api/clips/player/:key?scope=match returns, per player.
const CLIPS = {
  amit: { batting: { fours: [clip('f1', 'FOUR'), clip('f2', 'FOUR')], sixes: [clip('s1', 'SIX')], dismissal: [clip('d1', 'WICKET', { dismissalType: 'Bowled' })], other: [] },
          bowling: { wickets: [clip('w1', 'WICKET'), clip('w2', 'WICKET')], other: [clip('o1', 'CLIP')] } },
  bharat: { batting: { fours: [clip('f3', 'FOUR')], sixes: [], dismissal: [], other: [] }, bowling: { wickets: [], other: [] } },
  dev: { batting: { fours: [], sixes: [], dismissal: [], other: [] }, bowling: { wickets: [clip('w3', 'WICKET')], other: [] } },
  nobody: { batting: { fours: [], sixes: [], dismissal: [], other: [] }, bowling: { wickets: [], other: [] } },
};

function boot(){
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
      w.firebase = { initializeApp(){}, auth: () => ({ currentUser: null, onAuthStateChanged(cb){ setTimeout(() => cb(null), 30); }, signInWithPopup(){}, signOut(){} }), firestore: () => ({}) };
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
        calls.push({ url, method: (opts && opts.method) || 'GET', body });
        const json = (o, status) => Promise.resolve({ ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(o) });
        const m = /\/api\/clips\/player\/([^?]+)\?/.exec(url);
        if(m) return json({ success: true, scope: 'match', ...CLIPS[decodeURIComponent(m[1])] });
        if(/\/api\/highlights\/compile$/.test(url)) return json({ success: true, jobId: 'job1' });
        if(/\/api\/highlights\/compile\/job1\/status$/.test(url)) return json({ success: true, status: 'ready', progress: 100, included: 3, skipped: 0 });
        if(/\/api\/clips\/match\//.test(url)) return json({ success: true, clips: [] });
        return json({ success: false });
      };
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { w: dom.window, E: (c) => dom.window.eval(c), calls, errors };
}
const q = (P, sel) => P.w.document.querySelector(sel);
const options = (P) => [...P.w.document.querySelectorAll('#cd-download [data-dl-cat]')].map(b => b.dataset.dlCat + '=' + b.querySelector('.n').textContent);
async function openFor(P, name){
  P.E(`openPlayerClipDrawer(${JSON.stringify(name)}, 'batter')`);
  await sleep(150);
}

(async () => {
  const P = boot();
  await sleep(150);

  console.log('\n=== What the drawer offers ===');
  await openFor(P, 'Amit');
  eq('all-rounder with 4s, a 6 and wickets: every option, with its clip count', options(P),
    ['all=7', 'fours=2', 'sixes=1', 'boundaries=3', 'wickets=2']);
  eq('the options sit above the clip list', !!q(P, '#clip-drawer-body > .hl-dl:first-child'), true);
  eq('labels read as a viewer would say them', [...P.w.document.querySelectorAll('#cd-download [data-dl-cat]')].map(b => [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()),
    ['All clips', 'Fours', 'Sixes', '4s + 6s', 'Wickets']);
  await openFor(P, 'Bharat');
  eq('only fours: no sixes, no "4s + 6s" (it would be the same video), no wickets', options(P), ['all=1', 'fours=1']);
  await openFor(P, 'Dev');
  eq('a bowler: his wickets', options(P), ['all=1', 'wickets=1']);
  await openFor(P, 'Nobody');
  eq('no clips: nothing to download, no box', q(P, '#cd-download'), null);

  console.log('\n=== What each option downloads ===');
  const compiles = () => P.calls.filter(c => /\/api\/highlights\/compile$/.test(c.url)).map(c => c.body);
  await openFor(P, 'Amit');
  P.E(`window.__names = []; const __poll = pollCompileJob; pollCompileJob = function(id, name){ window.__names.push(name); return __poll.apply(this, arguments); };`);
  for(const cat of ['boundaries', 'fours', 'sixes', 'wickets', 'all']){
    q(P, `#cd-download [data-dl-cat="${cat}"]`).click();
    await sleep(60);
  }
  eq('each option asks the server for exactly that category of THIS match', compiles(),
    ['boundaries', 'fours', 'sixes', 'wickets', 'all'].map(category => ({ matchId: 'M1', type: 'player', playerKey: 'amit', category })));
  eq('the progress / download window opens', q(P, '#compile-modal-backdrop').classList.contains('open'), true);
  eq('each file is named for the player and what is in it', P.E('window.__names'),
    ['Amit_Match_4s_and_6s', 'Amit_Match_Fours', 'Amit_Match_Sixes', 'Amit_Match_Wickets', 'Amit_Match_Highlights']);

  console.log('\n=== Other tabs ===');
  P.E(`loadClipDrawerScope('tournament')`);
  await sleep(150);
  eq('tournament / career tabs: no match download (the compile is per match)', q(P, '#cd-download'), null);

  eq('no script errors', P.errors, []);
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
