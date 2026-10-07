// 🏆 POINTS TABLE · 🏏 TEAM HISTORY · 👤 PLAYER HISTORY — full-size broadcast
// cards. Both panels send each team's look (short name, colour, logo within a
// size budget) and last-5 form, a team's record with its rank and each
// opponent's look, and a player's match-by-match runs / wickets. On the
// overlay each card is an on/off full-size card: the score bar steps off
// while one is up and comes back when it is hidden, a re-send with nothing
// new changes nothing, and two cards never pile up on screen.
//
//   node test/cricket/history-cards-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Stand-in for CDN libraries: any property, any call.
function deep(){
  return new Proxy(function(){}, {
    get: (t, k) => k === Symbol.toPrimitive ? (() => 0) : (k === 'then' ? undefined : deep()),
    apply: () => deep()
  });
}
// A gsap stand-in that plays every tween and timeline to its end at once
// (end values applied, callbacks run in order) — enough to follow the
// cards' show / hide / hand-the-bar-back logic without a real clock.
function instantGsap(w){
  const SPECIAL = new Set(['duration', 'delay', 'ease', 'stagger', 'onStart', 'onUpdate', 'onComplete', 'overwrite', 'repeat', 'yoyo', 'immediateRender', 'transformOrigin', 'defaults']);
  const list = (t) => typeof t === 'string' ? [...w.document.querySelectorAll(t)]
    : (t && !t.nodeType && typeof t.length === 'number') ? [...t] : [t];
  function apply(targets, vars){
    if(!vars) return;
    list(targets).forEach(el => {
      if(!el) return;
      if(el.nodeType === 1){ if('opacity' in vars) el.style.opacity = String(vars.opacity); return; }
      Object.keys(vars).forEach(k => { if(!SPECIAL.has(k)) el[k] = vars[k]; });
    });
    if(vars.onStart) vars.onStart();
    if(vars.onUpdate) vars.onUpdate();
    if(vars.onComplete) vars.onComplete();
  }
  const tl = () => {
    const t = new Proxy({}, { get: (o, k) => {
      if(k === 'then') return undefined;
      if(k === 'to' || k === 'set') return (a, v) => (apply(a, v), t);
      if(k === 'fromTo') return (a, f, v) => (apply(a, v), t);
      if(k === 'call') return (fn, args) => (fn.apply(null, args || []), t);
      return () => t;
    } });
    return t;
  };
  const g = {
    to: (a, v) => (apply(a, v), tl()), set: (a, v) => (apply(a, v), tl()), fromTo: (a, f, v) => (apply(a, v), tl()),
    timeline: () => tl(), killTweensOf: () => {}
  };
  return new Proxy(g, { get: (o, k) => k in o ? o[k] : deep() });
}
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
  return { w, errors, emits, E: (c) => w.eval(c), J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)),
    text: (s) => { const el = w.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; } };
}

// ---- a small saved tournament: MW, KK, TSR, NMS ----
const T = {
  MW: { name: 'Mumbai Warriors', short: 'MW', color: '#1d4ed8' },
  KK: { name: 'Kalyan Kings', short: 'KK', color: '#0f766e' },
  TSR: { name: 'Thane Super Royals', short: 'TSR', color: '#f59e0b' },
  NMS: { name: 'Navi Mumbai Strikers', short: 'NMS', color: '#dc2626' }
};
const sc = (runs, wickets, overs) => ({ runs, wickets, overs });
const bat = (name, runs, balls, out) => ({ name, runs, balls, fours: 0, sixes: 0, out });
const bowl = (name, overs, runs, wickets) => ({ name, overs, balls: 0, maidens: 0, runs, wickets });
function matches(logos){
  return [
    { matchId: 'm1', format: 'T20', teamA: { ...T.MW }, teamB: { ...T.KK, logoUrl: logos.kk }, scoreA: sc(160, 5, '20'), scoreB: sc(150, 8, '20'), winningTeam: 'A',
      battingCard: { A: [bat('Rohit Sharma', 71, 44, false)], B: [] }, bowlingCard: { A: [], B: [bowl('Rohit Sharma', 2, 20, 1)] } },
    { matchId: 'm2', format: 'T20', teamA: { ...T.TSR, logoUrl: logos.tsr }, teamB: { ...T.MW }, scoreA: sc(170, 4, '20'), scoreB: sc(140, 9, '20'), winningTeam: 'A',
      battingCard: { A: [], B: [bat('Rohit Sharma', 12, 9, true)] }, bowlingCard: { A: [], B: [] } },
    { matchId: 'm3', format: 'T20', teamA: { ...T.MW }, teamB: { ...T.NMS }, scoreA: sc(120, 10, '18.2'), scoreB: sc(120, 9, '20'), winningTeam: 'TIE',
      battingCard: { A: [bat('Rohit Sharma', 40, 30, true)], B: [] }, bowlingCard: { A: [], B: [] } },
    { matchId: 'm4', format: 'T20', teamA: { ...T.KK, logoUrl: logos.kk }, teamB: { ...T.MW }, scoreA: sc(180, 6, '20'), scoreB: sc(90, 3, '12'), winningTeam: 'DRAW',
      battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [bowl('Rohit Sharma', 3, 25, 2)] } },
    { matchId: 'm5', format: 'T20', teamA: { ...T.NMS }, teamB: { ...T.TSR, logoUrl: logos.tsr }, scoreA: sc(150, 7, '20'), scoreB: sc(151, 3, '18'), winningTeam: 'B',
      battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } }
  ];
}

async function panelSuite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file, 'https://example.test/cricket-panel?room=HC');
  await sleep(80);
  const L = s => `${label}: ${s}`;
  const big = (ch) => 'data:image/png;base64,' + ch.repeat(300000);
  P.w.__M = matches({ kk: big('K'), tsr: big('T') });
  P.E(`
    state = mergeWithDefaults(null);
    state.matchMode = 'tournament'; state.leagueName = 'Kanga Premier League';
    state.teamA.name = 'Mumbai Warriors'; state.teamA.short = 'MW'; state.teamA.color = '#1d4ed8';
    state.teamB.name = 'Someone Else'; state.teamB.short = 'SE'; state.teamB.color = '#000000';
    currentLeagueMatches = () => window.__M;
    currentLeagueMatchesLive = () => window.__M;
    tournamentInfoCache['kanga premier league'] = { info: { color: '#7c3aed', season: 'Season 4', logoUrl: 'data:image/png;base64,LOGO',
      teams: [{ name: 'Navi Mumbai Strikers', short: 'NMS', color: '#dc2626' }] } };
  `);

  // ---- result keys and form ----
  eq(L('TEST 1: one match\'s result for a side — W / L / T / D / NR / undecided'),
    P.J(`[resultKeyForSide({ winningTeam: 'A' }, 'A'), resultKeyForSide({ winningTeam: 'A' }, 'B'), resultKeyForSide({ winningTeam: 'TIE' }, 'B'),
      resultKeyForSide({ winningTeam: 'DRAW' }, 'A'), resultKeyForSide({ winningTeam: 'NR' }, 'A'), resultKeyForSide({ winningTeam: '' }, 'A')]`),
    ['W', 'L', 'T', 'D', 'NR', '']);
  eq(L('TEST 2: a team\'s form, in match order'), P.J(`teamFormOf('Mumbai Warriors', window.__M)`), ['W', 'L', 'T', 'D']);
  const thr = P.J(`getTeamHistoryRows('Mumbai Warriors', window.__M)`);
  eq(L('TEST 3: team history — a DRAWN match reads "Drawn" (not "Lost"), with the opponent\'s full name'),
    thr.map(r => [r.opponentName, r.result, r.resultKey]),
    [['Kalyan Kings', 'Won', 'W'], ['Thane Super Royals', 'Lost', 'L'], ['Navi Mumbai Strikers', 'Tied', 'T'], ['Kalyan Kings', 'Drawn', 'D']]);

  // ---- points table payload ----
  const pt = P.J(`buildPointsTablePayload()`);
  eq(L('TEST 4: points table — tournament name, logo, colour and season ride along'),
    [pt.tournamentName, pt.tournamentLogo, pt.tournamentColor, pt.season, pt.matchesPlayed], ['Kanga Premier League', 'data:image/png;base64,LOGO', '#7c3aed', 'Season 4', 5]);
  const row = (n) => pt.standings.find(t => t.name === n);
  eq(L('TEST 5: each team carries its short name, colour and last-5 form'),
    [row('Mumbai Warriors').short, row('Mumbai Warriors').color, row('Mumbai Warriors').form, row('Thane Super Royals').form],
    ['MW', '#1d4ed8', ['W', 'L', 'T', 'D'], ['W', 'W']]);
  eq(L('TEST 6: a team not loaded on the panel gets its look from the tournament\'s team list, else its latest match'),
    [row('Navi Mumbai Strikers').color, row('Kalyan Kings').short, row('Kalyan Kings').color], ['#dc2626', 'KK', '#0f766e']);
  eq(L('TEST 7: logos ride along only up to the size budget (one message never outgrows the connection)'),
    pt.standings.filter(t => t.logoUrl).length, 1);
  eq(L('TEST 8: standings order unchanged — points, then NRR'), pt.standings.map(t => t.name)[0], 'Thane Super Royals');

  // ---- team history payload ----
  const th = P.J(`buildTeamHistoryPayload('Mumbai Warriors')`);
  eq(L('TEST 9: team history — tournament, rank of how many, and the record'),
    [th.tournamentName, th.rank, th.teams, th.stats.played, th.stats.won, th.stats.tied, th.stats.points],
    ['Kanga Premier League', pt.standings.findIndex(t => t.name === 'Mumbai Warriors') + 1, 4, 4, 1, 1, 3]);
  eq(L('TEST 10: every opponent with its own look'), th.rows.map(r => [r.opponentShort, r.opponentColor]),
    [['KK', '#0f766e'], ['TSR', '#f59e0b'], ['NMS', '#dc2626'], ['KK', '#0f766e']]);
  eq(L('TEST 11: opponents\' logos within the budget too'), th.rows.filter(r => r.opponentLogo).length <= 1, true);

  // ---- player history payload ----
  const ph = await P.w.eval(`buildPlayerHistoryPayload('Rohit Sharma')`);
  const phj = JSON.parse(JSON.stringify(ph));
  eq(L('TEST 12: player history — tournament name and the team\'s look'), [phj.tournamentName, phj.teamName, phj.teamShort, phj.teamColor],
    ['Kanga Premier League', 'Mumbai Warriors', 'MW', '#1d4ed8']);
  eq(L('TEST 13: match by match — runs, not out, and the bowling figures'),
    phj.thisTournament.rows.map(r => [r.label, r.runs, r.notOut, r.bowlFig]),
    [['Match 1', 71, true, '1-20'], ['Match 2', 12, false, ''], ['Match 3', 40, false, ''], ['Match 4', '—', null, '2-25']]);
  eq(L('TEST 14: no script errors'), P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

async function overlaySuite(){
  console.log('\n######## OVERLAY — cricket-overlay.html ########');
  const O = boot('cricket-overlay.html', 'https://example.test/cricket-overlay?room=HC', w => { w.gsap = instantGsap(w); });
  await sleep(120);
  O.E(`hasEntered = true;`);
  const LOGO = 'data:image/png;base64,iVBORw0KGgo';
  const standings = [
    { name: 'Mumbai Warriors', short: 'MW', color: '#1d4ed8', played: 7, won: 6, lost: 1, tied: 0, points: 12, nrr: 1.245, form: ['W', 'W', 'L', 'W', 'W', 'W'], logoUrl: '' },
    { name: 'Kalyan Kings', short: 'KK', color: '#0f766e', played: 7, won: 5, lost: 2, tied: 0, points: 10, nrr: 0.812, form: ['W', 'L', 'T', 'D', 'NR'], logoUrl: LOGO + '");background:red;(" &#41;;color:red' },
    { name: '<img src=x onerror=alert(1)>', short: 'X', color: '#dc2626', played: 7, won: 0, lost: 7, tied: 0, points: 0, nrr: -0.122, form: [], logoUrl: '' }
  ];
  const pt = { tournamentName: 'Kanga Premier League', tournamentLogo: '', tournamentColor: '#7c3aed', season: 'Season 4', matchesPlayed: 28, standings, updatedLine: 'Updated after 28 matches' };
  O.E(`renderPointsTableCard(${JSON.stringify(pt)})`);
  const cells = (sel) => O.E(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.className + '|' + e.textContent.trim()).join(' ; ')`);
  eq('OVERLAY TEST 15: points table — # centred, TEAM left over the team cells', cells('#pt-rows .sc-row-head > span').split(' ; ').slice(0, 2), ['sc-c-num|#', 'sc-c-name|TEAM']);
  eq('OVERLAY TEST 16: one row per team, the leader with the gold rank', [O.E(`document.querySelectorAll('#pt-rows .ptx-row').length`), O.E(`document.querySelector('#pt-rows .ptx-row .ptx-rank').className`)], [3, 'ptx-rank lead']);
  eq('OVERLAY TEST 17: last 5 only, as W/L/T/D/NR chips', [O.E(`[...document.querySelectorAll('#pt-rows .ptx-row')[0].querySelectorAll('.ptx-form span')].map(s => s.textContent).join('')`),
    O.E(`[...document.querySelectorAll('#pt-rows .ptx-row')[1].querySelectorAll('.ptx-form span')].map(s => s.className).join(',')`)], ['WLWWW', 'w,l,t,d,nr']);
  eq('OVERLAY TEST 18: NRR signed and coloured', O.E(`[...document.querySelectorAll('#pt-rows .ptx-nrr')].map(e => e.className.replace('sc-c-num ptx-nrr', '').trim() + e.textContent).join(' ')`), 'pos+1.245 pos+0.812 neg-0.122');
  eq('OVERLAY TEST 19: a team logo shows as the badge (url cleaned — it can never close the url() or the attribute), else its short name', [O.E(`document.querySelectorAll('#pt-rows .fx-badge.has-logo').length`),
    O.E(`document.querySelector('#pt-rows .fx-badge.has-logo').getAttribute('style').replace(/^background-image:url\\([^()"'&]*\\)$/, 'ok')`), O.E(`document.querySelector('#pt-rows .fx-badge:not(.has-logo)').textContent`)], [1, 'ok', 'MW']);
  eq('OVERLAY TEST 20: team names are text, never markup', O.E(`document.querySelectorAll('#pt-rows img').length`), 0);
  eq('OVERLAY TEST 21: header — name, season, matches played, team count, trophy when no logo',
    [O.text('#pt-name'), O.text('#pt-sub'), O.text('#pt-matches'), O.text('#pt-teams'), O.E(`!!document.querySelector('#pt-badge svg')`)],
    ['KANGA PREMIER LEAGUE', 'TOURNAMENT STANDINGS · SEASON 4', '28', '3 TEAMS', true]);
  eq('OVERLAY TEST 22: it is up and holds the score bar off air', [O.E(`document.getElementById('points-table-card').style.display`), O.E(`fullBar.holds()`)], ['flex', true]);
  eq('OVERLAY TEST 23: the same table again changes nothing (no second entrance)', [O.E(`showFullPersistent('points-table-card', document.getElementById('points-table-card').dataset.sig)`), O.J(`fullStack`)], [false, ['points-table-card']]);
  O.E(`overFlow.start({ eventId: 'ov-1', overNumber: 3, batsmen: [], bowlers: [] })`);
  eq('OVERLAY TEST 24: the between-overs card stays away while it is up', O.E(`overFlow.phase`), 'idle');
  O.E(`window.__h_score = { teamA: { name: 'Mumbai Warriors', short: 'MW', color: '#1d4ed8' }, teamB: { name: 'Kalyan Kings', short: 'KK', color: '#0f766e' }, battingTeam: 'A', score: { runs: 90, wickets: 2, overs: 9, balls: 4 }, striker: { name: 'Rohit', runs: 44, balls: 31 }, nonStriker: { name: 'Ishan', runs: 22, balls: 18 }, bowler: { name: 'Raj', overs: 2, balls: 4, runs: 24, wickets: 1 } };
    if(eventState !== 'idle' || overFlow.holdsBar() || fullBar.holds()){ pendingStateUpdate = window.__h_score; } else { renderState(window.__h_score); }`);
  eq('OVERLAY TEST 25: a score that lands meanwhile waits for the bar', O.E(`pendingStateUpdate && pendingStateUpdate.score.runs`), 90);

  // ---- team history on top: the table steps back, returns when it goes ----
  const rows = Array.from({ length: 12 }, (_, i) => ({ label: `Match ${i + 1}`, opponent: 'KK', opponentName: 'Kalyan Kings', opponentShort: 'KK', opponentColor: '#0f766e', opponentLogo: '',
    own: '150-5 (20)', opp: '140-9 (20)', resultKey: ['W', 'L', 'T', 'D', 'NR', ''][i % 6] }));
  const th = { teamName: 'Mumbai Warriors', teamShort: 'MW', teamColor: '#1d4ed8', tournamentName: 'Kanga Premier League', rows,
    stats: { played: 12, won: 2, lost: 2, tied: 2, points: 6, nrr: 0.4, highest: 201, avgScore: 159, winPct: 17 }, rank: 2, teams: 8, totalsLine: '' };
  O.E(`renderTeamHistoryCard(${JSON.stringify(th)})`);
  eq('OVERLAY TEST 26: two cards never pile up — the newer is on top, the table steps back',
    [O.J(`fullStack`), O.E(`document.getElementById('points-table-card').style.opacity`), O.E(`+document.getElementById('team-history-card').style.zIndex > +document.getElementById('points-table-card').style.zIndex`)],
    [['points-table-card', 'team-history-card'], '0', true]);
  eq('OVERLAY TEST 27: team history — the newest 10 matches, a note for the rest', [O.E(`document.querySelectorAll('#th-rows .thx-row').length`), O.text('#th-rows .fx-more')],
    [10, '+ 2 earlier matches (in the record below)']);
  eq('OVERLAY TEST 28: result chips, and each row striped in its result colour',
    [O.E(`[...document.querySelectorAll('#th-rows .fx-res')].slice(0, 6).map(e => e.textContent).join(',')`), O.E(`document.querySelectorAll('#th-rows .thx-row')[0].style.getPropertyValue('--tc')`)],
    ['TIED,DRAWN,NO RESULT,LIVE,WON,LOST', '#d97706']);
  eq('OVERLAY TEST 29: OPPONENT header sits left; rank, NRR and points in the header',
    [cells('#th-rows .sc-row-head > span').split(' ; ')[1], O.text('#th-rank'), O.text('#th-nrr'), O.text('#th-pts')], ['sc-c-name|OPPONENT', '#2 OF 8 TEAMS', 'NRR +0.400', '6']);
  eq('OVERLAY TEST 30: the record as five tiles, points last', O.E(`[...document.querySelectorAll('#th-tiles .cardg-tile .k')].map(e => e.textContent).join(',')`), 'MATCHES,HIGHEST,AVG SCORE,NRR,POINTS');
  O.E(`hideFullCard('team-history-card')`);
  eq('OVERLAY TEST 31: hidden → the table comes back, the bar stays off (the table still has it)',
    [O.J(`fullStack`), O.E(`document.getElementById('points-table-card').style.opacity`), O.E(`document.getElementById('team-history-card').style.display`), O.E(`fullBar.holds()`)],
    [['points-table-card'], '1', 'none', true]);
  // a timed summary over the table: the table steps back, then returns
  O.E(`playFullCard('match-summary-card', 15000)`);
  eq('OVERLAY TEST 32: the match summary plays over it and the table returns after',
    [O.J(`fullStack`), O.E(`document.getElementById('points-table-card').style.opacity`), O.E(`fullBar.holds()`)], [['points-table-card'], '1', true]);
  O.E(`hideFullCard('points-table-card')`);
  eq('OVERLAY TEST 33: the last card hidden → the bar is handed back with the newest score',
    [O.E(`fullBar.holds()`), O.J(`fullStack`), O.E(`pendingStateUpdate`), O.E(`lastState && lastState.score.runs`)], [false, [], null, 90]);

  // ---- player history ----
  const prow = [34, 12, 71, '—', 5, 48, 102, 0, 27, 55, 19, 40].map((runs, i) => ({ label: `Match ${i + 1}`, runs, balls: 20, notOut: runs === '—' ? null : i % 3 === 0, wkts: i === 3 ? 2 : 0, bowlFig: i === 3 ? '2-18' : '' }));
  const ph = { playerName: 'Rohit Sharma', tournamentName: 'Kanga Premier League', teamName: 'Mumbai Warriors', teamShort: 'MW', teamColor: '#1d4ed8',
    sections: { thisMatch: true, thisTournament: true, otherTournaments: true },
    thisMatch: { batting: { runs: 40, balls: 30, fours: 3, sixes: 2, out: false, sr: '133.3' }, bowling: { wickets: 1, overs: 2, balls: 0, runs: 20, maidens: 0, economy: '10.00' } },
    thisTournament: { rows: prow, batting: { matches: 11, runs: 413, average: '45.89', sr: '142.4', highScore: '102*', fours: 38, sixes: 20, fifties: 3, hundreds: 1 },
      bowling: { matches: 8, wickets: 9, overs: '22.0', runs: 163, economy: '7.41', average: '18.11', best: '3/21', maidens: 1 } },
    tournamentHistory: ['A', 'B', 'C', 'D', 'E'].map(n => ({ leagueName: 'League ' + n, matchesPlayed: 5, batting: { runs: 100, average: '20.00', sr: '120.0', highScore: '45' }, bowling: null })) };
  O.E(`renderPlayerHistoryCard(${JSON.stringify(ph)})`);
  eq('OVERLAY TEST 34: player history — all three sections on', O.E(`['ph-section-match', 'ph-section-tournament', 'ph-section-other'].map(id => document.getElementById(id).hidden)`), [false, false, false]);
  eq('OVERLAY TEST 35: the header leads with the tournament runs', [O.text('#ph-hero-k'), O.text('#ph-hero-v'), O.text('#ph-hero-s'), O.text('#ph-hero-c')], ['TOURNAMENT RUNS', '413', 'INN 11 · AVG 45.89', 'HS 102*']);
  eq('OVERLAY TEST 36: runs by match — the last 10 bars, the best in gold, DNB marked',
    [O.E(`document.querySelectorAll('#ph-chart .phx-bar').length`), O.text('#ph-t-title'), O.E(`document.querySelector('#ph-chart .phx-bar.best .val').textContent`), O.E(`document.querySelectorAll('#ph-chart .phx-bar.dnb').length`)],
    [10, 'THIS TOURNAMENT · LAST 10 OF 12 MATCHES', '102*', 1]);
  eq('OVERLAY TEST 37: this match as tiles — the runs and the wickets lead',
    O.E(`[...document.querySelectorAll('#ph-match-body .phx-tile.hero .v')].map(e => e.textContent).join(',')`), '40*,1');
  eq('OVERLAY TEST 38: tournament totals — batting and bowling, eight tiles each, with upright tags',
    [O.E(`[...document.querySelectorAll('#ph-t-body .phx-group')].map(g => g.className + ':' + g.querySelectorAll('.phx-tile').length).join(' ')`),
      O.E(`[...document.querySelectorAll('#ph-t-body .phx-group')[1].querySelectorAll('.phx-tile .k')].map(e => e.textContent).join(',')`)],
    ['phx-group vg:8 phx-group vg:8', 'INN,WKTS,AVG,ECON,BEST,OVERS,RUNS,MAIDENS']);
  eq('OVERLAY TEST 39: other tournaments — four rows and "+1 more"', [O.E(`document.querySelectorAll('#ph-other-list .phx-other-row').length`), O.text('#ph-other-list .fx-more')], [4, '+ 1 more tournament']);
  const bowler = { ...ph, playerName: 'Jasprit Bumrah', sections: { thisMatch: false, thisTournament: true, otherTournaments: false },
    thisTournament: { rows: prow.slice(0, 4).map((r, i) => ({ ...r, runs: '—', notOut: null, wkts: [2, 1, 3, 0][i], bowlFig: `${[2, 1, 3, 0][i]}-20` })), batting: null, bowling: ph.thisTournament.bowling } };
  O.E(`renderPlayerHistoryCard(${JSON.stringify(bowler)})`);
  eq('OVERLAY TEST 40: a bowler leads with wickets — the chart counts wickets; switched-off sections stay hidden',
    [O.text('#ph-hero-k'), O.text('#ph-chart-k'), O.E(`document.querySelector('#ph-chart .phx-bar.best .val').textContent`), O.E(`document.getElementById('ph-section-match').hidden`), O.E(`document.getElementById('ph-section-other').hidden`)],
    ['TOURNAMENT WICKETS', 'WICKETS BY MATCH', '3', true, true]);
  eq('OVERLAY TEST 41: re-sent while up — updated in place, one card on the stack', O.J(`fullStack`), ['player-history-card']);
  // a count still running when fresher numbers land is stopped first
  O.E(`window.__killed = 0; countTweens['points-table-card'] = [{ kill(){ window.__killed++; } }]; renderPointsTableCard(${JSON.stringify({ ...pt, matchesPlayed: 29 })}); hideFullCard('points-table-card');`);
  eq('OVERLAY TEST 41b: a count-up still running is stopped before the new numbers are written', [O.E(`window.__killed`), O.text('#pt-matches')], [1, '29']);
  O.E(`hideFullCard('player-history-card')`);
  eq('OVERLAY TEST 42: hidden → the bar is back', [O.E(`fullBar.holds()`), O.E(`document.getElementById('player-history-card').style.display`)], [false, 'none']);
  eq('OVERLAY TEST 43: no script errors', O.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

(async () => {
  await panelSuite('cricket-panel.html', 'Clipper panel');
  await panelSuite('cricket-panel3.html', 'Stream Engine panel');
  await overlaySuite();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})();
