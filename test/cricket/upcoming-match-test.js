// 📅 Schedule Upcoming Match — the REAL cricket-panel.html, server.js and
// score-tournament.html (jsdom / extracted functions, never copied):
// scheduling a fixture without touching the panel, listing it in 📋 Matches,
// ▶ Start putting it on the panel under its OWN matchId + room, the saved
// record flipping to a played match, and the tournament page showing it
// under Upcoming (never in points / stats).
//
//   node test/cricket/upcoming-match-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const H = require('./server-harness');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- an in-memory stand-in for the league routes (merge-on-save, like the
// real writeMatchRecordSafely's $set) ----
function fakeServer(){
  const srv = { records: [], posts: [], live: [], roomStates: {}, toasts: [] };
  srv.records.push({
    matchId: 'm-old', roomId: 'room-old', matchNo: 1, savedAt: '2026-10-01T10:00:00.000Z', winningTeam: 'A',
    teamA: { name: 'Lions', short: 'LIO', color: '#ff0000', logoUrl: '' }, teamB: { name: 'Tigers', short: 'TIG', color: '#0000ff', logoUrl: '' },
    scoreA: { runs: 150, wickets: 6, overs: '20.0' }, scoreB: { runs: 120, wickets: 9, overs: '20.0' },
    battingCard: { A: [{ name: 'Amit', runs: 70, balls: 50 }], B: [{ name: 'Tom', runs: 40, balls: 30 }] }, bowlingCard: { A: [], B: [] },
    squadA: { players: [{ id: 'gp_amit', name: 'Amit', isXI: true }, { id: 'gp_bharat', name: 'Bharat', isXI: true }], captainId: 'gp_amit', wkId: 'gp_bharat' },
    squadB: { players: [{ id: 'gp_tom', name: 'Tom', isXI: true }], captainId: null, wkId: null }
  });
  srv.fetch = (url, opts) => {
    url = String(url);
    const method = (opts && opts.method) || 'GET';
    let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch(e) {}
    const json = (o, status) => Promise.resolve({ ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
    let m;
    if((m = /\/api\/cricket\/room-state\/([^?]+)/.exec(url))){
      const st = srv.roomStates[decodeURIComponent(m[1])];
      return st ? json({ success: true, state: st }) : json({ success: false }, 404);
    }
    if(/\/api\/players\/canonicalize/.test(url)) return json({ success: true, map: {} });
    if(/\/api\/players\/resolve/.test(url)) return json({ success: true, playerId: 'gp_' + String(body.name).toLowerCase() });
    if(/\/api\/league\/[^/?]+\/live-status/.test(url)){ srv.live.push(body); return json({ success: true }); }
    if(/\/api\/league\/[^/?]+\/match(\?|$)/.test(url) && method === 'POST'){
      srv.posts.push(body);
      const i = srv.records.findIndex(r => r.matchId === body.matchId);
      if(i >= 0) srv.records[i] = { ...srv.records[i], ...body }; else srv.records.push(body);
      return json({ success: true, matches: srv.records });
    }
    if(/\/api\/league\/[^/?]+(\?|$)/.test(url) && method === 'GET') return json({ success: true, matches: srv.records, completed: false });
    return json({ success: false });
  };
  return srv;
}

function bootPanel(srv){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', 'cricket-panel.html'), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://example.test/cricket-panel?uid=U1', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){} });
      w.fetch = srv.fetch;
      w.firebase = undefined;
      w.alert = () => {};
      w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      w.crypto = w.crypto || {};
      let n = 0;
      w.crypto.randomUUID = () => 'uuid-' + (++n);
      w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  const E = (c) => dom.window.eval(c);
  // capture toasts
  E(`(function(){ const t = toast; window.__toasts = []; toast = function(m){ window.__toasts.push(String(m)); try{ return t.apply(this, arguments); }catch(e){} }; })()`);
  return { w: dom.window, E, errors, $: (s) => dom.window.document.querySelector(s) };
}
const click = (P, el) => el.dispatchEvent(new P.w.Event('click', { bubbles: true }));
const setVal = (P, sel, v) => { const el = P.$(sel); el.value = v; el.dispatchEvent(new P.w.Event('change', { bubbles: true })); };

(async () => {
  // ================================================================
  console.log('\n=== Panel: Schedule Upcoming Match ===');
  const srv = fakeServer();
  const P = bootPanel(srv);
  await sleep(50);
  eq('button sits with Create New Match', !!P.$('#new-match-btn + #schedule-match-btn'), true);

  // No tournament picked → refuses, modal stays shut
  P.E(`state.leagueName = ''; state.matchMode = 'tournament';`);
  click(P, P.$('#schedule-match-btn'));
  await sleep(20);
  eq('no tournament: modal does not open', P.$('#newmatch-modal-overlay').classList.contains('show'), false);
  eq('no tournament: says why', P.w.__toasts.slice(-1)[0], 'Pick or start a tournament first');

  P.E(`state.leagueName = 'Test Cup'; state.matchMode = 'tournament'; saveLocal();`);
  P.$('#match-id').value = 'room-current';
  P.E(`state.teamA.name = 'Current A'; state.teamB.name = 'Current B';`);
  click(P, P.$('#schedule-match-btn'));
  await sleep(80);
  eq('modal open in schedule mode', [P.$('#newmatch-modal-overlay').classList.contains('show'), P.$('#newmatch-modal h3').textContent, P.$('#newmatch-start').textContent],
    [true, '📅 Schedule Upcoming Match', '📅 Save Upcoming Match']);
  eq('date/venue fields shown, date defaults to a day', [P.$('#newmatch-date').closest('.nm-schedule-only').style.display, /^\d{4}-\d{2}-\d{2}$/.test(P.$('#newmatch-date').value)], ['', true]);
  eq('tournament teams offered (from saved matches)', [...P.$('#newmatch-team-a').options].map(o => o.value), ['', 'lions', 'tigers']);
  eq('"New team" shows a name box', P.$('#newmatch-name-a').style.display, '');

  setVal(P, '#newmatch-team-a', 'lions');
  eq('picked team hides the name box', P.$('#newmatch-name-a').style.display, 'none');
  P.$('#newmatch-name-b').value = '';
  click(P, P.$('#newmatch-start'));
  await sleep(20);
  eq('missing Team B name refused', /both sides/.test(P.w.__toasts.slice(-1)[0]), true);
  P.$('#newmatch-name-b').value = 'lions';
  click(P, P.$('#newmatch-start'));
  await sleep(20);
  eq('same team twice refused (typed name = existing team)', P.w.__toasts.slice(-1)[0], 'Team A and Team B cannot be the same team');

  P.$('#newmatch-name-b').value = 'Golden Eagles';
  P.$('#newmatch-title').value = 'Semi Final';
  P.$('#newmatch-date').value = '2026-10-10';
  P.$('#newmatch-time').value = '16:00';
  P.$('#newmatch-venue').value = 'DY Patil';
  const postsBefore = srv.posts.length;
  click(P, P.$('#newmatch-start'));
  await sleep(120);
  const up = srv.posts.slice(postsBefore)[0];
  eq('saved to the server as an upcoming record', up && [up.upcoming, up.matchNo, up.matchTitle, up.venue, up.scheduledHasTime, up.winningTeam], [true, 2, 'Semi Final', 'DY Patil', true, null]);
  eq('scheduled for the chosen local date/time', up && new Date(up.scheduledAt).getTime(), new Date('2026-10-10T16:00').getTime());
  eq('own matchId + own room id (not the panel\'s)', up && [!!up.matchId, up.matchId !== P.E('state.tournamentMatchId'), !!up.roomId, up.roomId !== 'room-current'], [true, true, true, true]);
  eq('Team A = saved team with its squad + same player ids', up && [up.teamA.name, up.teamA.short, up.teamA.color, up.squadA.players.map(p => p.id), up.squadA.captainId], ['Lions', 'LIO', '#ff0000', ['gp_amit', 'gp_bharat'], 'gp_amit']);
  eq('Team B = new team, short name made up', up && [up.teamB.name, up.teamB.short, up.squadB.players.length], ['Golden Eagles', 'GE', 0]);
  eq('no scores / cards on a fixture', up && [up.scoreA, up.battingCard], [{ runs: 0, wickets: 0, overs: '0.0' }, { A: [], B: [] }]);
  eq('panel untouched: match id, teams', [P.$('#match-id').value, P.E('state.teamA.name'), P.E('state.teamB.name')], ['room-current', 'Current A', 'Current B']);
  eq('modal closed', P.$('#newmatch-modal-overlay').classList.contains('show'), false);

  console.log('\n=== Panel: 📋 Matches list ===');
  const listEl = P.$('#league-matches-list');
  eq('Matches list opened', listEl.style.display, 'block');
  const firstRow = listEl.querySelector('.league-match-row');
  eq('upcoming fixture listed first', firstRow && firstRow.getAttribute('data-view-match'), up.matchId);
  eq('row says Upcoming + date, no score', firstRow && [/📅 Upcoming · /.test(firstRow.textContent), /0-0/.test(firstRow.textContent), /Match 2 · Semi Final · DY Patil/.test(firstRow.textContent)], [true, false, true]);
  eq('row has ▶ Start', firstRow && firstRow.querySelector('[data-start-upcoming]') && firstRow.querySelector('[data-start-upcoming]').textContent, '▶ Start');
  eq('count line mentions it', /1 match saved.*📅 1 upcoming match scheduled/.test(P.$('#league-match-count').textContent), true);
  eq('not a played match: points / stats / history skip it', [P.E('currentLeagueMatches().length'), P.E('currentLeagueMatchesAll().length'), P.E('computeStandings(currentLeagueMatches()).length')], [1, 2, 2]);
  eq('next Create New Match number continues after it', P.E('nextTournamentMatchNo()'), 3);
  // Create New Match mode still the old modal
  click(P, P.$('#new-match-btn'));
  await sleep(80);
  eq('Create New Match modal unchanged', [P.$('#newmatch-modal h3').textContent, P.$('#newmatch-start').textContent, P.$('#newmatch-date').closest('.nm-schedule-only').style.display, P.$('#newmatch-name-a').style.display], ['➕ Create New Match', 'Start New Match', 'none', 'none']);
  click(P, P.$('#newmatch-cancel'));

  console.log('\n=== Panel: ▶ Start the upcoming match ===');
  // something already scored on the panel → parked first
  P.E(`state.ballLog = [{ innings: 1, over: 0, ball: 1, kind: '1' }]; state.matchLeague = 'Test Cup'; state.tournamentMatchId = 'm-current'; saveLocal();`);
  P.E(`setHistoryPanelView('matches')`);
  const postsBeforeStart = srv.posts.length;
  click(P, listEl.querySelector('[data-start-upcoming]'));
  await sleep(200);
  const parked = srv.posts.slice(postsBeforeStart).find(r => r.matchId === 'm-current');
  eq('current match parked (saved to its own tournament first)', !!parked, true);
  eq('panel now on the fixture\'s own Match ID', P.$('#match-id').value, up.roomId);
  eq('state carries the fixture\'s matchId / tournament / number / title / venue',
    P.E(`[state.tournamentMatchId, state.matchLeague, state.leagueName, state.matchMode, state.matchNo, state.matchTitle, state.venue]`),
    [up.matchId, 'Test Cup', 'Test Cup', 'tournament', 2, 'Semi Final', 'DY Patil']);
  eq('teams + squads loaded with the same player ids', P.E(`[state.teamA.name, state.teamA.players.map(p => p.id), state.teamA.captainId, state.teamB.name, state.teamB.short]`),
    ['Lions', ['gp_amit', 'gp_bharat'], 'gp_amit', 'Golden Eagles', 'GE']);
  eq('fresh match: nothing scored', P.E(`[state.ballLog.length, state.score.runs]`), [0, 0]);
  const flip = srv.posts.slice(postsBeforeStart).filter(r => r.matchId === up.matchId).slice(-1)[0];
  eq('server record flipped: upcoming:false, same matchId + room', flip && [flip.upcoming, flip.roomId, flip.matchNo], [false, up.roomId, 2]);
  const stored = srv.records.find(r => r.matchId === up.matchId);
  eq('stored record keeps its scheduled date', stored && [stored.upcoming, stored.scheduledAt], [false, up.scheduledAt]);
  await sleep(900);
  const ping = srv.live.slice(-1)[0];
  eq('live on the tournament page: live-status ping with its room + matchId', ping && [ping.active, ping.roomId, ping.matchId], [true, up.roomId, up.matchId]);
  P.E(`setHistoryPanelView('matches')`);
  const row = [...listEl.querySelectorAll('.league-match-row')].find(r => r.getAttribute('data-view-match') === up.matchId);
  eq('list: the fixture is now "On panel", not upcoming', row && [/On panel/.test(row.textContent), /Upcoming/.test(row.textContent)], [true, false]);
  eq('scores from now on go to the same record (snapshot = fixture matchId)', P.E('buildMatchRecordForLeague().matchId'), up.matchId);

  console.log('\n=== Panel: a fixture already started on another laptop is not restarted ===');
  P.E(`state.leagueName = 'Test Cup';`);
  srv.records.push({ matchId: 'm-up2', roomId: 'room-up2', upcoming: true, matchNo: 4, savedAt: '2026-10-02T00:00:00.000Z', scheduledAt: '2026-10-12T00:00:00.000Z',
    teamA: { name: 'Tigers', short: 'TIG' }, teamB: { name: 'Lions', short: 'LIO' }, scoreA: { runs: 0, wickets: 0, overs: '0.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' },
    battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } });
  srv.roomStates['room-up2'] = { tournamentMatchId: 'm-up2', ballLog: [{ innings: 1 }], battingCard: { A: [], B: [] } };
  await P.E(`syncLeagueFromServer('Test Cup')`);
  P.E(`setHistoryPanelView('matches')`);
  const before2 = P.$('#match-id').value;
  click(P, listEl.querySelector('[data-start-upcoming="m-up2"]'));
  await sleep(150);
  eq('panel stays on its match', [P.$('#match-id').value, P.E('state.tournamentMatchId')], [before2, up.matchId]);
  eq('operator told to Resume it instead', /already been started on another device/.test(P.w.__toasts.join('\n')), true);
  eq('no script errors (panel)', P.errors, []);

  // ================================================================
  console.log('\n=== Server: fixtures never count as played ===');
  const api = H.build({ balls: H.coll([]), clips: H.coll([]), records: H.coll([]), rooms: {}, emits: [], audits: [] },
    ['isUpcomingRecord', 'playedMatches', 'oversToFloat', 'computePointsTable'], []);
  const recs = [
    { teamA: { name: 'Lions' }, teamB: { name: 'Tigers' }, winningTeam: 'A', scoreA: { runs: 150, overs: '20.0' }, scoreB: { runs: 120, overs: '20.0' } },
    { teamA: { name: 'Lions' }, teamB: { name: 'Eagles' }, upcoming: true, scoreA: { runs: 0, overs: '0.0' }, scoreB: { runs: 0, overs: '0.0' } },
  ];
  const pt = api.computePointsTable(recs);
  eq('points table: Lions played 1 (fixture skipped), Eagles absent', pt.map(r => [r.team, r.played]), [['Lions', 1], ['Tigers', 1]]);
  eq('a started fixture (upcoming:false) counts again', api.computePointsTable([{ ...recs[1], upcoming: false }]).map(r => r.played), [1, 1]);
  const src = H.src;
  eq('leaderboards skip fixtures', /function computeLeaderboards\(matches\) \{\r?\n\s+matches = playedMatches\(matches\);/.test(src), true);
  eq('public tournament status/count use played matches only', (src.match(/playedMatches\(matches\)\.length > 0 \? 'ongoing'/g) || []).length, 2);
  eq('admin counts skip fixtures', [/countDocuments\(\{ ownerUid: l\.ownerUid, leagueKey: l\.leagueKey, upcoming: \{ \$ne: true \} \}\)/.test(src), /\$match: \{ upcoming: \{ \$ne: true \} \}/.test(src)], [true, true]);

  // ================================================================
  console.log('\n=== Tournament page: Upcoming group ===');
  const payload = {
    success: true, displayName: 'Test Cup',
    matches: [
      { matchId: 'm-old', roomId: 'room-old', matchNo: 1, savedAt: '2026-10-01T10:00:00.000Z', winningTeam: 'A', teamA: { name: 'Lions', short: 'LIO' }, teamB: { name: 'Tigers', short: 'TIG' },
        scoreA: { runs: 150, wickets: 6, overs: '20.0' }, scoreB: { runs: 120, wickets: 9, overs: '20.0' }, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } },
      { matchId: 'm-up-late', roomId: 'room-late', upcoming: true, matchNo: 3, scheduledAt: '2026-10-20T10:30:00.000Z', scheduledHasTime: true, venue: 'Wankhede', teamA: { name: 'Tigers', short: 'TIG' }, teamB: { name: 'Golden Eagles', short: 'GE' },
        scoreA: { runs: 0, wickets: 0, overs: '0.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' }, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } },
      { matchId: 'm-up-soon', roomId: 'room-soon', upcoming: true, matchNo: 2, matchTitle: 'Semi Final', scheduledAt: '2026-10-10T10:30:00.000Z', teamA: { name: 'Lions', short: 'LIO' }, teamB: { name: 'Golden Eagles', short: 'GE' },
        scoreA: { runs: 0, wickets: 0, overs: '0.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' }, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } },
      // started a second ago on the panel — its room is live, record not flipped yet
      { matchId: 'm-up-live', roomId: 'room-live', upcoming: true, matchNo: 4, scheduledAt: '2026-10-03T10:30:00.000Z', teamA: { name: 'Sharks', short: 'SHK' }, teamB: { name: 'Lions', short: 'LIO' },
        scoreA: { runs: 0, wickets: 0, overs: '0.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' }, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } },
    ],
    live: { roomId: 'room-live', matchId: 'm-up-live', matches: [{ roomId: 'room-live', matchId: 'm-up-live' }] },
    pointsTable: [], leaderboards: { topRuns: [], topWickets: [] }
  };
  let tHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'score-tournament.html'), 'utf8');
  tHtml = tHtml.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc2 = new VirtualConsole(); const tErrors = [];
  vc2.on('jsdomError', e => tErrors.push(e.message));
  const T = new JSDOM(tHtml, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/score/tournament/TOK', virtualConsole: vc2,
    beforeParse(w){
      w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(payload))) });
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      w.IntersectionObserver = w.IntersectionObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.ResizeObserver = w.ResizeObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.scrollTo = () => {};
    }
  });
  T.window.document.dispatchEvent(new T.window.Event('DOMContentLoaded'));
  await sleep(300);
  const tdoc = T.window.document;
  const groups = [...tdoc.querySelectorAll('#matches-card .mc-group')].map(g => [g.getAttribute('aria-label'), [...g.querySelectorAll('[data-goto-match]')].map(a => a.getAttribute('data-goto-match'))]);
  eq('groups: Live (just-started fixture), Completed, Upcoming soonest first', groups,
    [['Live', ['m-up-live']], ['Completed', ['m-old']], ['Upcoming', ['m-up-soon', 'm-up-late']]]);
  const soon = tdoc.querySelector('[data-goto-match="m-up-soon"]');
  eq('upcoming card: badge, starts-at line, no "Yet to bat"', soon && [soon.querySelector('.mc-status').textContent.trim(), /Starts /.test(soon.querySelector('.mc-result').textContent), /Yet to bat/.test(soon.textContent)], ['Upcoming', true, false]);
  eq('upcoming card links to its own live room', soon && soon.getAttribute('href'), '/cricket-scorecard?room=room-soon');
  eq('hero counts played matches only', /^2 matches played/.test((tdoc.getElementById('tourney-meta') || {}).textContent || ''), true);
  eq('match count shows the fixtures separately', (tdoc.querySelector('.mc-count') || {}).textContent, '2 matches · 2 upcoming');
  eq('no script errors (tournament page)', tErrors, []);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
