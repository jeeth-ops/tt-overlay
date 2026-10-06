// MATCH SETUP console on BOTH panels: format chips, wickets / Super Over,
// team cards, Playing XI chips, match date, review + Start Match.
//
//   node test/cricket/match-setup-test.js
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
function fresh(P){
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A';
    document.getElementById('match-id').value = 'XT';
    state.teamA.players = ['Rohit','Ishan','Surya'].map((n, i) => ({ id: 'a' + (i + 1), name: n, isXI: true }));
    state.teamB.players = [{ id:'m1', name:'Mukesh', isXI:true }];
    state.striker    = { name:'Rohit', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan', id:'a2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Mukesh', id:'m1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = []; window.__clips = [];
    if(typeof sendClipToHelper === 'function') sendClipToHelper = (r) => window.__clips.push(r);
    renderPanel();
  `);
  P.emits.length = 0;
}

async function suite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file);
  await sleep(80);
  const L = s => `${label}: ${s}`;
  fresh(P);
  P.E(`state.teamA.players = ['Rohit','Ishan','Surya','Tilak','Hardik','Tim','Krunal','Piyush','Jasprit','Akash','Arjun','Naman'].map((n, i) => ({ id: 'a' + i, name: n, isXI: i < 11 }));
       state.teamA.name = 'Mumbai Warriors'; state.teamB.name = 'DY Patil XI'; renderSquadUI(); renderPanel();`);

  eq(L('the five sections, in order (no Playing XI step — Team Squads has it)'), P.$$('#card-match-setup .ms-sec-t').map(e => e.textContent.replace(/^\d/, '').replace('Manage squads', '').trim()),
    ['Match information', 'Match format', 'Teams', 'Innings', 'Match review']);
  eq(L('the steps are numbered 1-5'), P.$$('#card-match-setup .ms-sec-t > b').map(e => e.textContent), ['1', '2', '3', '4', '5']);
  eq(L('every old input is still there (same ids)'), ['format', 'custom-overs', 'custom-overs-wrap', 'venue', 'stream-url', 'teamA-name', 'teamA-short', 'teamA-color', 'teamA-logo-file', 'teamA-logo-remove', 'teamA-logo-preview', 'teamB-name', 'batting-team', 'target', 'visible-toggle'].filter(id => !P.$('#' + id)), []);

  eq(L('format chips show the format'), P.$('#ms-formats .on').dataset.msFormat, 'T20');
  click(P, '[data-ms-format="Custom"]');
  eq(L('CUSTOM chip → Custom format, overs + wickets shown'), [P.E('state.format'), P.$('#format').value, P.$('#custom-overs-wrap').style.display, P.$('#ms-formats .on').dataset.msFormat], ['Custom', 'Custom', 'block', 'Custom']);
  const wk = P.$('#ms-wickets'); wk.value = '8'; wk.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  eq(L('wickets per innings → the rules'), [P.E('state.customMaxWickets'), P.E('maxWickets()')], [8, 8]);
  const so = P.$('#ms-superover'); so.checked = false; so.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  eq(L('Super Over off → the rules'), [P.E('state.customSuperOverEnabled'), P.E('matchRules().superOverEnabled')], [false, false]);
  click(P, '[data-ms-format="Test"]');
  eq(L('TEST: no Super Over row, Test rules'), [P.E('state.format'), P.$('#ms-so-row').hidden, /2 innings each/.test(P.text('#ms-rules'))], ['Test', true, true]);
  click(P, '[data-ms-format="T20"]');

  eq(L('team cards: name, players, XI'), [P.text('#ms-team-A-name'), P.text('#ms-team-A-meta')], ['Mumbai Warriors', '12 players · XI 11/11 · MI']);
  eq(L('Match Setup no longer shows a Playing XI picker'), [!!P.$('#ms-xi-A'), !!P.$('#ms-xi-B')], [false, false]);

  const d = P.$('#match-date'); d.value = '2026-10-18'; d.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  eq(L('match date → state and the saved record'), [P.E('state.matchDate'), P.J('buildMatchRecordForLeague()').matchDate], ['2026-10-18', '2026-10-18']);
  eq(L('review: both teams, XI, format, date'), [/Mumbai Warriors/.test(P.text('#ms-review')), /XI 11 \/ 11/.test(P.text('#ms-review')), /T20 · 20 ov/.test(P.text('#ms-review')), /18/.test(P.text('#ms-review'))], [true, true, true, true]);
  eq(L('review checklist'), P.$$('#ms-check li').map(li => li.className), ['ok', 'ok', 'ok', 'warn', 'warn']);

  P.E(`state.teamB.name = 'mumbai warriors'; renderPanel();`);
  P.E(`window.__t = []; toast = (m) => window.__t.push(m);`);
  click(P, '#ms-start');
  eq(L('Start Match refuses the same team twice'), [P.E('window.__t.slice(-1)[0]'), P.text('#ms-state')], ['⚠️ Team A and Team B are different teams', 'Setup needed']);
  P.E(`state.teamB.name = 'DY Patil XI'; renderPanel();`);
  click(P, '#ms-start');
  eq(L('Start Match → on to the toss'), [/record the toss/.test(P.E('window.__t.slice(-1)[0]')), P.text('#ms-state')], [true, 'Ready']);
  P.E(`recordBall('1')`);
  P.E('renderPanel()');
  eq(L('once scoring starts: Match in progress'), [P.$('#ms-start').disabled, P.text('#ms-start'), P.text('#ms-state')], [true, 'Match in progress', 'LIVE']);
  P.E('startFreshMatch({ quiet: true })');
  eq(L('a new match is dated today'), P.E('state.matchDate') === P.E('msTodayISO()'), true);
  eq(L('no script errors'), P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

(async () => {
  await suite('cricket-panel.html', 'Clipper panel');
  await suite('cricket-panel3.html', 'Stream Engine panel');
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
