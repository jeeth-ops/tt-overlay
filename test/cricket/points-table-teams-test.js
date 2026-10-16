// 🏆 POINTS TABLE — every team ONCE, both panels (cricket-panel.html,
// cricket-panel3.html).
//
// The bug: the same team saved on different matches with a different
// spelling of its name ("United Cricketers" on one match, "UNITED
// CRICKETERS " on another) got TWO rows in the points table — each showing
// the same, full numbers, because every figure is counted by the
// normalised name. The table, its "N teams" count, the overlay card, the
// Team History list and the Excel report all take their team list from
// tournamentTeamNames(); it now lists each team once.
//
//   1. the screenshot's tournament: 5 matches, 6 teams — 6 rows, not 8,
//      with the right P / W / L / PTS / NRR / form, played adding up to 10
//   2. the name shown: the tournament's own team list spelling when it has
//      the team, otherwise the spelling used on the most matches
//   3. a tournament with no spelling differences: exactly as before
//   4. the overlay payload and the Team History list: one entry per team
//
//   node test/cricket/points-table-teams-test.js
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
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const emits = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=PT', virtualConsole: vc,
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

const sc = (runs, wickets, overs) => ({ runs, wickets, overs });
const m = (id, a, b, sa, sb, win) => ({ matchId: id, format: 'T20', teamA: { name: a }, teamB: { name: b }, scoreA: sa, scoreB: sb, winningTeam: win, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } });
// The screenshot's tournament: United Cricketers and Parel Sporting Club were
// typed differently on their two matches.
const SCREENSHOT = [
  m('m1', 'DY Patil SA', 'Apollo Cricket Club', sc(180, 4, '20'), sc(120, 9, '20'), 'A'),
  m('m2', 'United Cricketers', 'Parel Sporting Club', sc(150, 6, '20'), sc(140, 8, '20'), 'A'),
  m('m3', 'MIG Cricket Club', 'Muslim United SC', sc(170, 5, '20'), sc(124, 10, '18.4'), 'A'),
  m('m4', 'PAREL SPORTING CLUB ', 'Apollo  Cricket Club', sc(160, 7, '20'), sc(150, 9, '20'), 'A'),
  m('m5', 'DY PATIL SA', 'UNITED CRICKETERS', sc(190, 3, '20'), sc(130, 10, '19.2'), 'A')
];

async function suite(file){
  console.log(`\n######## ${file} ########`);
  const P = boot(file);
  await sleep(80);
  const L = s => `${file}: ${s}`;
  const load = (ms, teams) => {
    P.w.__M = ms;
    P.E(`state = mergeWithDefaults(null); state.matchMode = 'tournament'; state.leagueName = 'MCA President Cup';
      currentLeagueMatches = () => window.__M; currentLeagueMatchesLive = () => window.__M;
      tournamentInfoCache['mca president cup'] = ${JSON.stringify({ info: { teams: teams || [] } })};`);
  };

  // ---- 1 ----
  load(SCREENSHOT);
  const st = P.J('computeStandings(currentLeagueMatches())');
  eq(L('1 six teams, six rows (was eight)'), st.length, 6);
  eq(L('1 …no team twice'), new Set(st.map(t => t.name.toLowerCase().replace(/\s+/g, ' ').trim())).size, 6);
  eq(L('1 …played adds up to 2 × 5 matches'), st.reduce((s, t) => s + t.played, 0), 10);
  const row = (k) => st.find(t => t.name.toLowerCase().replace(/\s+/g, ' ').trim() === k);
  eq(L('1 United Cricketers: P2 W1 L1, 2 pts — both its matches, counted once'), ['played', 'won', 'lost', 'points'].map(f => row('united cricketers')[f]), [2, 1, 1, 2]);
  eq(L('1 Parel Sporting Club: P2 W1 L1, 2 pts'), ['played', 'won', 'lost', 'points'].map(f => row('parel sporting club')[f]), [2, 1, 1, 2]);
  eq(L('1 DY Patil SA: P2 W2, 4 pts, top'), [st[0].name.toLowerCase(), st[0].played, st[0].won, st[0].points], ['dy patil sa', 2, 2, 4]);
  eq(L('1 Apollo (once typed with a double space): P2 L2'), [row('apollo cricket club').played, row('apollo cricket club').lost], [2, 2]);
  eq(L('1 the other teams: one match each'), [row('mig cricket club').played, row('muslim united sc').played], [1, 1]);

  // ---- 2 ----
  eq(L('2 the name shown: extra spaces tidied (Apollo, once typed with a double space)'), row('apollo cricket club').name, 'Apollo Cricket Club');
  eq(L('2 …the spelling used on the most matches wins'), (load([...SCREENSHOT, m('m6', 'DY Patil SA', 'MIG Cricket Club', sc(1, 0, '1'), sc(0, 0, '1'), 'A')]),
    P.J('tournamentTeamNames(currentLeagueMatches())').find(n => /^dy patil/i.test(n))), 'DY Patil SA');
  load(SCREENSHOT);
  eq(L('2 …a tie: the latest match\'s spelling'), [row('united cricketers').name, row('parel sporting club').name, row('dy patil sa').name], ['UNITED CRICKETERS', 'PAREL SPORTING CLUB', 'DY PATIL SA']);
  load(SCREENSHOT, [{ name: 'United Cricketers' }, { name: 'Parel Sporting Club' }]);
  const st2 = P.J('computeStandings(currentLeagueMatches())');
  eq(L('2 the tournament\'s own team list spelling wins when it has the team'),
    st2.filter(t => /^(united cricketers|parel sporting club)$/i.test(t.name)).map(t => t.name).sort(), ['Parel Sporting Club', 'United Cricketers']);
  eq(L('2 …and the numbers do not change with the name'), st2.map(t => [t.played, t.won, t.lost, t.points, t.nrr]), st.map(t => [t.played, t.won, t.lost, t.points, t.nrr]));

  // ---- 3 ----
  const CLEAN = [
    m('c1', 'Lions', 'Tigers', sc(150, 5, '20'), sc(140, 7, '20'), 'A'),
    m('c2', 'Tigers', 'Eagles', sc(160, 3, '20'), sc(161, 4, '19.1'), 'B'),
    m('c3', 'Eagles', 'Lions', sc(120, 10, '17'), sc(120, 8, '20'), 'TIE')
  ];
  load(CLEAN);
  eq(L('3 no spelling differences: the same teams in the same order as before'), P.J('tournamentTeamNames(currentLeagueMatches())'), ['Lions', 'Tigers', 'Eagles']);
  eq(L('3 …and the same figures'), P.J('computeStandings(currentLeagueMatches()).map(t => [t.name, t.played, t.won, t.lost, t.tied, t.points])').sort(),
    [['Eagles', 2, 1, 0, 1, 3], ['Lions', 2, 1, 0, 1, 3], ['Tigers', 2, 0, 2, 0, 0]]);
  eq(L('3 an empty tournament: no teams'), (load([]), P.J('tournamentTeamNames(currentLeagueMatches())')), []);
  eq(L('3 a match with a missing team name is skipped, not a blank row'), (load([m('x', '', 'Lions', sc(1, 0, '1'), sc(0, 0, '1'), 'A')]), P.J('tournamentTeamNames(currentLeagueMatches())')), ['Lions']);

  // ---- 4 ----
  load(SCREENSHOT);
  const pay = P.J('buildPointsTablePayload()');
  eq(L('4 the overlay card: 6 rows, 5 matches played'), [pay.standings.length, pay.matchesPlayed], [6, 5]);
  eq(L('4 …United Cricketers\' form once: W L'), pay.standings.find(t => /united cricketers/i.test(t.name)).form, ['W', 'L']);
  P.E(`renderTeamHistoryView(currentLeagueMatches())`);
  const opts = P.J(`[...document.querySelectorAll('#team-history-select option')].map(o => o.value).filter(Boolean)`);
  eq(L('4 the Team History list: each team once'), opts.length, 6);
  P.E(`renderPointsTableView(currentLeagueMatches())`);
  eq(L('4 the panel\'s Points Table view: 6 rows'), P.J(`document.querySelectorAll('#league-matches-list tbody tr').length`), 6);
  eq(L('no page errors'), P.errors.filter(e => !/Not implemented|Could not load/.test(e)), []);
  return st;
}

(async () => {
  const a = await suite('cricket-panel.html');
  const b = await suite('cricket-panel3.html');
  console.log('\n######## both panels ########');
  eq('both panels: the same table', a, b);
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
