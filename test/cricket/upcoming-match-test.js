// 📅 Upcoming Match with saved, reusable teams — run against BOTH real
// panels (cricket-panel.html = Clipper, cricket-panel3.html = Stream Engine)
// in jsdom, plus the real server team registry and the tournament page:
//   • date-only fixture (no time field anywhere)
//   • Existing Team → name, logo, colour, players + player ids load by themselves
//   • ＋ Create New Team → name, logo upload (preview), colour, players
//     (pick a saved player = same id; a new name goes through find-or-create)
//   • a created team is reusable (shows under Existing Teams next time)
//   • no duplicate teams ("D Y Patil" twice is refused / reused)
//   • ▶ Start puts the fixture on the panel under its own matchId + room,
//     with the team references; the tournament page lists it under Upcoming
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
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---- an in-memory stand-in for the server: league routes (merge-on-save,
// like writeMatchRecordSafely's $set), the team registry and player search.
function fakeServer(){
  const srv = { records: [], posts: [], live: [], roomStates: {}, teams: [], teamPosts: [], players: [
    { playerId: 'gp_karan', displayName: 'Karan Shah' }, { playerId: 'gp_kabir', displayName: 'Kabir Rao' }
  ] };
  srv.records.push({
    matchId: 'm-old', roomId: 'room-old', matchNo: 1, savedAt: '2026-10-01T10:00:00.000Z', winningTeam: 'A',
    teamA: { name: 'Lions', short: 'LIO', color: '#ff0000', logoUrl: '' }, teamB: { name: 'Tigers', short: 'TIG', color: '#0000ff', logoUrl: '' },
    scoreA: { runs: 150, wickets: 6, overs: '20.0' }, scoreB: { runs: 120, wickets: 9, overs: '20.0' },
    battingCard: { A: [{ name: 'Amit', runs: 70, balls: 50 }], B: [{ name: 'Tom', runs: 40, balls: 30 }] }, bowlingCard: { A: [], B: [] },
    squadA: { players: [{ id: 'gp_amit', name: 'Amit', isXI: true }, { id: 'gp_bharat', name: 'Bharat', isXI: true }], captainId: 'gp_amit', wkId: 'gp_bharat' },
    squadB: { players: [{ id: 'gp_tom', name: 'Tom', isXI: true }], captainId: null, wkId: null }
  });
  srv.teams.push({ teamId: 't_dyp', name: 'D Y Patil', short: 'DYP', color: '#0ea5e9', logoUrl: LOGO,
    players: [{ id: 'gp_rahul', name: 'Rahul', isXI: true }, { id: 'gp_sam', name: 'Sam', isXI: true }], captainId: 'gp_rahul', wkId: null });
  const key = n => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
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
    if((m = /\/api\/players\/search\?q=([^&]*)/.exec(url))){
      const q = decodeURIComponent(m[1]).toLowerCase();
      return json({ success: true, players: srv.players.filter(p => p.displayName.toLowerCase().includes(q)) });
    }
    if(/\/api\/teams(\?|$)/.test(url) && method === 'GET') return json({ success: true, teams: srv.teams });
    if(/\/api\/teams(\?|$)/.test(url) && method === 'POST'){
      srv.teamPosts.push(body);
      const t = body.team;
      const same = srv.teams.find(x => key(x.name) === key(t.name));
      if(!t.teamId && same) return body.mode === 'ensure' ? json({ success: true, team: same, reused: true }) : json({ success: false, code: 'TEAM_EXISTS', error: `A team called "${same.name}" already exists — pick it from Existing Teams`, team: same }, 409);
      const players = (t.players || []).map(p => ({ id: p.id || ('gp_' + p.name.toLowerCase()), name: p.name, isXI: p.isXI !== false }));
      if(t.teamId){ const ex = srv.teams.find(x => x.teamId === t.teamId); Object.assign(ex, t, { players }); return json({ success: true, team: ex }); }
      const team = { ...t, teamId: 't_' + (srv.teams.length + 1), players };
      srv.teams.push(team);
      return json({ success: true, team }, 201);
    }
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

function bootPanel(file, srv){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
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
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLMediaElement.prototype.pause = () => {};
      w.crypto = w.crypto || {};
      let n = 0;
      w.crypto.randomUUID = () => 'uuid-' + (++n);
      w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  const E = (c) => dom.window.eval(c);
  E(`(function(){ const t = toast; window.__toasts = []; toast = function(m){ window.__toasts.push(String(m)); try{ return t.apply(this, arguments); }catch(e){} }; })()`);
  // jsdom has no canvas: the logo compressor hands back a fixed small image.
  E(`compressImageToDataURL = async () => ${JSON.stringify(LOGO)};`);
  return { w: dom.window, E, errors, $: (s) => dom.window.document.querySelector(s), $$: (s) => [...dom.window.document.querySelectorAll(s)] };
}
const click = (P, el) => el.dispatchEvent(new P.w.Event('click', { bubbles: true }));
const typeIn = (P, el, v) => { el.value = v; el.dispatchEvent(new P.w.Event('input', { bubbles: true })); };
const key = (P, el, k) => el.dispatchEvent(new P.w.KeyboardEvent('keydown', { key: k, bubbles: true }));

async function panelSuite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const srv = fakeServer();
  const P = bootPanel(file, srv);
  await sleep(60);
  eq(`${label}: Schedule button sits with Create New Match`, !!P.$('#new-match-btn + #schedule-match-btn'), true);

  P.E(`state.leagueName = ''; state.matchMode = 'tournament';`);
  click(P, P.$('#schedule-match-btn'));
  await sleep(30);
  eq(`${label}: no tournament → modal stays shut, says why`, [P.$('#um-overlay').classList.contains('show'), P.w.__toasts.slice(-1)[0]], [false, 'Pick or start a tournament first']);

  P.E(`state.leagueName = 'Test Cup'; state.matchMode = 'tournament'; saveLocal();`);
  P.$('#match-id').value = 'room-current';
  P.E(`state.teamA.name = 'Current A'; state.teamB.name = 'Current B';`);
  click(P, P.$('#schedule-match-btn'));
  await sleep(120);
  console.log('\n=== Date only ===');
  eq(`${label}: Upcoming Match modal open`, [P.$('#um-overlay').classList.contains('show'), P.$('#um-title').textContent, P.$('#um-kicker').textContent], [true, 'Upcoming Match', 'Test Cup']);
  eq(`${label}: a date field, defaulting to today`, [P.$('#um-date').type, /^\d{4}-\d{2}-\d{2}$/.test(P.$('#um-date').value)], ['date', true]);
  eq(`${label}: no time field anywhere`, [P.$$('#um-overlay input[type=time], #newmatch-modal input[type=time]').length, /\btime\b/i.test(P.$('#um-overlay').textContent)], [0, false]);
  eq(`${label}: both sides start empty with Select Existing / ＋ Create New Team`, P.$$('#um-overlay .um-side').map(s => [!!s.querySelector('[data-um-pick]'), !!s.querySelector('[data-um-new]')]), [[true, true], [true, true]]);

  console.log('\n=== Existing team ===');
  click(P, P.$('[data-um-pick="A"]'));
  const items = P.$$('#um-overlay .um-side[data-side="A"] [data-um-select]').map(b => b.getAttribute('data-um-select'));
  eq(`${label}: Existing Teams = saved teams + this tournament's teams`, items, ['d y patil', 'lions', 'tigers']);
  typeIn(P, P.$('[data-um-search="A"]'), 'pat');
  eq(`${label}: search narrows the list`, P.$$('#um-overlay .um-side[data-side="A"] [data-um-select]').map(b => b.getAttribute('data-um-select')), ['d y patil']);
  click(P, P.$('[data-um-select="d y patil"]'));
  const sideA = P.$('#um-overlay .um-side[data-side="A"]');
  eq(`${label}: D Y Patil loads name, logo, colour, players`, [sideA.querySelector('.um-team-name').textContent, sideA.querySelector('.um-logo img').getAttribute('src') === LOGO, sideA.style.getPropertyValue('--c'), sideA.querySelectorAll('.um-chip').length, sideA.classList.contains('has-team')],
    ['D Y Patil', true, '#0ea5e9', 2, true]);

  console.log('\n=== ＋ Create New Team ===');
  click(P, P.$('[data-um-new="B"]'));
  await sleep(10);
  eq(`${label}: team editor opens`, [P.$('#te-overlay').classList.contains('show'), P.$('#te-title').textContent, P.$('#te-kicker').textContent], [true, 'Create New Team', 'Team B']);
  typeIn(P, P.$('#te-name'), 'Mumbai Warriors');
  eq(`${label}: name shows in the live preview`, P.$('#te-preview .um-team-name').textContent, 'Mumbai Warriors');
  // logo upload → preview at once
  const logoFile = new P.w.File(['x'], 'logo.png', { type: 'image/png' });
  Object.defineProperty(P.$('#te-logo-file'), 'files', { value: [logoFile], configurable: true });
  P.$('#te-logo-file').dispatchEvent(new P.w.Event('change'));
  await sleep(20);
  eq(`${label}: logo previews immediately (picker + card)`, [P.$('#te-logo-btn img') && P.$('#te-logo-btn img').getAttribute('src') === LOGO, !!P.$('#te-preview .um-logo img'), P.$('#te-logo-remove').hidden], [true, true, false]);
  // colour
  click(P, P.$('[data-te-color="#dc2626"]'));
  eq(`${label}: colour swatch picked, preview follows`, [P.$('[data-te-color="#dc2626"]').classList.contains('on'), P.$('#te-preview').style.getPropertyValue('--c')], [true, '#dc2626']);
  // players: a saved player from search keeps their id
  typeIn(P, P.$('#te-player-input'), 'Ka');
  await sleep(320);
  eq(`${label}: typing suggests saved players`, P.$$('#te-suggest [data-te-suggest]').map(b => b.textContent.replace('Saved player', '').trim()), ['Karan Shah', 'Kabir Rao']);
  click(P, P.$('[data-te-suggest="0"]'));
  eq(`${label}: picked saved player is added with their id`, P.E(`teEdit.players.map(p => [p.name, p.id, p.saved])`), [['Karan Shah', 'gp_karan', true]]);
  // a new name
  typeIn(P, P.$('#te-player-input'), 'New Guy');
  key(P, P.$('#te-player-input'), 'Enter');
  typeIn(P, P.$('#te-player-input'), 'Temp Player');
  click(P, P.$('#te-player-add'));
  eq(`${label}: new names added as New`, P.$$('#te-players .te-tag').map(t => t.textContent), ['Saved player', 'New', 'New']);
  typeIn(P, P.$('#te-player-input'), 'new guy');
  key(P, P.$('#te-player-input'), 'Enter');
  eq(`${label}: same player twice is refused`, [P.E('teEdit.players.length'), P.$('#te-msg').textContent], [3, 'new guy is already in this team']);
  // remove + edit
  click(P, P.$('[data-te-remove="2"]'));
  const nameInput = P.$('[data-te-name="1"]');
  nameInput.value = 'New  Guy Jr'; nameInput.dispatchEvent(new P.w.Event('change'));
  eq(`${label}: remove + edit a player`, P.E(`teEdit.players.map(p => p.name)`), ['Karan Shah', 'New Guy Jr']);
  eq(`${label}: count + preview follow`, [P.$('#te-count').textContent, /2 players/.test(P.$('#te-preview').textContent)], ['(2)', true]);
  click(P, P.$('#te-save'));
  await sleep(60);
  const tp = srv.teamPosts.slice(-1)[0];
  eq(`${label}: team saved with name, logo, colour, players (+ ids)`, tp && [tp.team.name, tp.team.short, tp.team.color, tp.team.logoUrl === LOGO, tp.team.players, tp.team.teamId], ['Mumbai Warriors', 'MW', '#dc2626', true, [{ id: 'gp_karan', name: 'Karan Shah', isXI: true }, { id: null, name: 'New Guy Jr', isXI: true }], null]);
  const sideB = P.$('#um-overlay .um-side[data-side="B"]');
  eq(`${label}: Team B is the new team`, [P.$('#te-overlay').classList.contains('show'), sideB.querySelector('.um-team-name').textContent, sideB.style.getPropertyValue('--c'), !!sideB.querySelector('.um-logo img')], [false, 'Mumbai Warriors', '#dc2626', true]);
  eq(`${label}: …and is now an Existing Team`, P.E(`umTeams.map(t => t.key)`), ['d y patil', 'lions', 'mumbai warriors', 'tigers']);

  console.log('\n=== Duplicate team protection ===');
  click(P, P.$('[data-um-pick="B"]'));
  eq(`${label}: the other side's team can't be picked twice`, P.$('#um-overlay .um-side[data-side="B"] [data-um-select="d y patil"]').disabled, true);
  click(P, P.$('[data-um-new="B"]'));
  typeIn(P, P.$('#te-name'), 'd y  patil');
  click(P, P.$('#te-save'));
  await sleep(40);
  eq(`${label}: same name as Team A refused before saving`, P.$('#te-msg').textContent, 'd y patil is already Team A');
  typeIn(P, P.$('#te-name'), 'tigers'); // a team only in this tournament's matches (not saved yet)
  click(P, P.$('#te-save'));
  await sleep(40);
  eq(`${label}: a team so far only in this tournament's matches can be saved as a team`, [P.$('#um-overlay .um-side[data-side="B"] .um-team-name').textContent, srv.teams.filter(t => /tigers/i.test(t.name)).length], ['tigers', 1]);
  srv.teams.push({ teamId: 't_x', name: 'Royal XI', short: 'RXI', color: '#111827', logoUrl: '', players: [] });
  click(P, P.$('[data-um-pick="B"]'));
  click(P, P.$('[data-um-new="B"]'));
  typeIn(P, P.$('#te-name'), 'royal  xi');
  click(P, P.$('#te-save'));
  await sleep(40);
  eq(`${label}: server says it exists → "Use Royal XI" (no duplicate)`, [/already exists/.test(P.$('#te-msg').textContent), !!P.$('#te-use-existing'), srv.teams.filter(t => /royal/i.test(t.name)).length], [true, true, 1]);
  click(P, P.$('#te-use-existing'));
  eq(`${label}: existing team adopted`, P.$('#um-overlay .um-side[data-side="B"] .um-team-name').textContent, 'Royal XI');
  // back to Mumbai Warriors for Team B
  click(P, P.$('[data-um-pick="B"]'));
  click(P, P.$('[data-um-select="mumbai warriors"]'));

  console.log('\n=== Save Upcoming Match (date only) ===');
  P.$('#um-date').value = '';
  click(P, P.$('#um-save'));
  await sleep(20);
  eq(`${label}: no date → asked for the date`, P.$('#um-msg').textContent, 'Pick the match date');
  P.$('#um-date').value = '2026-10-04';
  P.$('#um-title-input').value = 'Semi Final';
  P.$('#um-venue').value = 'DY Patil Ground';
  const postsBefore = srv.posts.length;
  click(P, P.$('#um-save'));
  await sleep(200);
  const up = srv.posts.slice(postsBefore).find(r => r.upcoming === true);
  eq(`${label}: fixture saved, DATE ONLY`, up && [up.upcoming, up.scheduledDate, 'scheduledAt' in up, 'scheduledHasTime' in up, up.matchNo, up.matchTitle, up.venue], [true, '2026-10-04', false, false, 2, 'Semi Final', 'DY Patil Ground']);
  eq(`${label}: team references stored`, up && [up.teamA.teamId, up.teamAId, !!up.teamB.teamId, up.teamBId === up.teamB.teamId], ['t_dyp', 't_dyp', true, true]);
  eq(`${label}: snapshot of each team as it is today (logo, colour, players + ids)`, up && [up.teamA.logoUrl === LOGO, up.teamA.color, up.squadA.players.map(p => p.id), up.squadA.captainId, up.teamB.color, up.squadB.players.map(p => p.id)],
    [true, '#0ea5e9', ['gp_rahul', 'gp_sam'], 'gp_rahul', '#dc2626', ['gp_karan', 'gp_new guy jr']]);
  eq(`${label}: no new team record for a team that was picked (no duplicates)`, srv.teams.filter(t => /patil/i.test(t.name)).length, 1);
  eq(`${label}: panel untouched`, [P.$('#match-id').value, P.E('state.teamA.name')], ['room-current', 'Current A']);
  const row = P.$('#league-matches-list .league-match-row');
  eq(`${label}: Matches list shows it first: Upcoming · date (no time)`, row && [row.getAttribute('data-view-match') === up.matchId, /📅 Upcoming · .*4.*Oct.*2026|📅 Upcoming · .*Oct.*4.*2026/.test(row.textContent), /\d{1,2}:\d{2}/.test(row.textContent), !!row.querySelector('[data-start-upcoming]')], [true, true, false, true]);

  console.log('\n=== Teams are reusable ===');
  click(P, P.$('#schedule-match-btn'));
  await sleep(120);
  click(P, P.$('[data-um-pick="A"]'));
  eq(`${label}: Mumbai Warriors offered next time`, P.$$('#um-overlay .um-side[data-side="A"] [data-um-select]').map(b => b.getAttribute('data-um-select')).includes('mumbai warriors'), true);
  click(P, P.$('[data-um-select="mumbai warriors"]'));
  eq(`${label}: loads with its players`, P.$$('#um-overlay .um-side[data-side="A"] .um-chip').map(c => c.textContent), ['Karan Shah', 'New Guy Jr']);
  click(P, P.$('#um-cancel'));
  P.E(`openNewMatchModal()`);
  await sleep(120);
  eq(`${label}: Create New Match lists saved teams too`, [...P.$('#newmatch-team-a').options].map(o => o.value), ['', 'd y patil', 'lions', 'mumbai warriors', 'royal xi', 'tigers']);
  click(P, P.$('#newmatch-cancel'));

  console.log('\n=== ▶ Start ===');
  P.E(`setHistoryPanelView('matches')`);
  click(P, P.$(`[data-start-upcoming="${up.matchId}"]`));
  await sleep(250);
  eq(`${label}: panel on the fixture's own room + matchId`, [P.$('#match-id').value, P.E('state.tournamentMatchId'), P.E('state.matchNo'), P.E('state.venue')], [up.roomId, up.matchId, 2, 'DY Patil Ground']);
  eq(`${label}: teams with their ids and team references`, P.E(`[state.teamA.name, state.teamA.teamId, state.teamA.players.map(p => p.id), state.teamB.name, state.teamB.teamId === ${JSON.stringify(up.teamB.teamId)}]`), ['D Y Patil', 't_dyp', ['gp_rahul', 'gp_sam'], 'Mumbai Warriors', true]);
  const flip = srv.posts.filter(r => r.matchId === up.matchId).slice(-1)[0];
  eq(`${label}: record flipped to a played match, date + team ids kept`, flip && [flip.upcoming, flip.scheduledDate, flip.teamA.teamId, flip.teamAId], [false, '2026-10-04', 't_dyp', 't_dyp']);
  await sleep(900);
  const ping = srv.live.slice(-1)[0];
  eq(`${label}: goes live on the tournament page`, ping && [ping.active, ping.roomId, ping.matchId], [true, up.roomId, up.matchId]);
  eq(`${label}: no script errors`, P.errors, []);
}

(async () => {
  await panelSuite('cricket-panel.html', 'Clipper panel');
  await panelSuite('cricket-panel3.html', 'Stream Engine panel');

  console.log('\n######## Server: saved teams (real saveTeamRecord) ########');
  {
    const teams = H.coll([]);
    const players = { 'karan shah': 'gp_karan' };
    let minted = 0;
    const code = [
      H.grabConst('TEAM_LOGO_MAX_CHARS'),
      ...['teamNameKey', 'sanitizeTeamColor', 'sanitizeTeamLogo', 'publicTeam'].map(n => H.grab(n)),
      H.grab('saveTeamRecord', 'async function '),
      'return { saveTeamRecord, sanitizeTeamLogo };'
    ].join('\n');
    const api = new Function('teamsCollection', 'resolvePlayerId', 'resolvePlayerIdExplicit', 'crypto', code)(
      teams,
      async (uid, name) => { const k = name.toLowerCase(); return players[k] || (players[k] = 'gp_new' + (++minted)); },
      async (uid, id) => id,
      require('crypto')
    );
    const r1 = await api.saveTeamRecord('U1', { name: '  D Y  Patil ', color: '#0ea5e9', logoUrl: LOGO, players: [{ id: 'gp_rahul', name: 'Rahul' }, { name: 'Karan Shah' }, { name: 'Brand New' }, { id: 'gp_rahul', name: 'Rahul again' }], captainId: 'gp_rahul' });
    eq('create: 201, tidy name, team id', [r1.status, r1.body.team.name, /^t_[0-9a-f]{12}$/.test(r1.body.team.teamId)], [201, 'D Y Patil', true]);
    eq('create: given id kept, saved name reused, new name registered, duplicate id dropped', r1.body.team.players.map(p => p.id), ['gp_rahul', 'gp_karan', 'gp_new1']);
    eq('create: logo, colour, captain stored', [r1.body.team.logoUrl === LOGO, r1.body.team.color, r1.body.team.captainId], [true, '#0ea5e9', 'gp_rahul']);
    const r2 = await api.saveTeamRecord('U1', { name: 'd y patil', players: [] });
    eq('same name again → 409 TEAM_EXISTS with the existing team (no "D Y Patil 2")', [r2.status, r2.body.code, r2.body.team.teamId, teams.docs.length], [409, 'TEAM_EXISTS', r1.body.team.teamId, 1]);
    const r3 = await api.saveTeamRecord('U1', { name: 'D Y PATIL', players: [{ name: 'X' }] }, { mode: 'ensure' });
    eq('ensure → the existing team is handed back unchanged', [r3.status, r3.body.reused, r3.body.team.players.length, teams.docs.length], [200, true, 3, 1]);
    const r4 = await api.saveTeamRecord('U1', { teamId: r1.body.team.teamId, name: 'D Y Patil', color: 'red', logoUrl: '', players: [{ id: 'gp_karan', name: 'Karan Shah' }] });
    eq('update by teamId: same team, new details; bad colour dropped', [r4.status, r4.body.team.teamId, r4.body.team.color, r4.body.team.logoUrl, r4.body.team.players.map(p => p.id), r4.body.team.captainId, teams.docs.length], [200, r1.body.team.teamId, '', '', ['gp_karan'], null, 1]);
    await api.saveTeamRecord('U1', { name: 'Mumbai Warriors', players: [] });
    const r5 = await api.saveTeamRecord('U1', { teamId: r1.body.team.teamId, name: 'mumbai  warriors', players: [] });
    eq('rename onto another team → 409', [r5.status, r5.body.code], [409, 'TEAM_EXISTS']);
    const r6 = await api.saveTeamRecord('U2', { name: 'D Y Patil', players: [] });
    eq('another account has its own teams', r6.status, 201);
    eq('unknown teamId → 404', (await api.saveTeamRecord('U1', { teamId: 't_nope', name: 'Zed' })).status, 404);
    eq('no name → 400', (await api.saveTeamRecord('U1', { name: '  ' })).status, 400);
    eq('logo must be an image', [(await api.saveTeamRecord('U1', { name: 'Bad', logoUrl: 'javascript:alert(1)' })).status, (await api.saveTeamRecord('U1', { name: 'Big', logoUrl: 'data:image/png;base64,' + 'A'.repeat(400001) })).status, api.sanitizeTeamLogo('https://cdn.example/l.png')], [400, 400, 'https://cdn.example/l.png']);
    eq('routes are owner-gated', [/app\.get\('\/api\/teams', requireAuthorizedCreator/.test(H.src), /app\.post\('\/api\/teams', requireAuthorizedCreator/.test(H.src)], [true, true]);
    eq('one team per owner + name in the database', /teamsCollection\.createIndex\(\{ ownerUid: 1, nameKey: 1 \}, \{ unique: true \}\)/.test(H.src), true);
  }

  console.log('\n######## Server: fixtures never count as played ########');
  {
    const api = H.build({ balls: H.coll([]), clips: H.coll([]), records: H.coll([]), rooms: {}, emits: [], audits: [] },
      ['isUpcomingRecord', 'playedMatches', 'oversToFloat', 'computePointsTable'], []);
    const recs = [
      { teamA: { name: 'Lions' }, teamB: { name: 'Tigers' }, winningTeam: 'A', scoreA: { runs: 150, overs: '20.0' }, scoreB: { runs: 120, overs: '20.0' } },
      { teamA: { name: 'Lions' }, teamB: { name: 'Eagles' }, upcoming: true, scoreA: { runs: 0, overs: '0.0' }, scoreB: { runs: 0, overs: '0.0' } },
    ];
    eq('points table skips the fixture', api.computePointsTable(recs).map(r => [r.team, r.played]), [['Lions', 1], ['Tigers', 1]]);
    eq('a started fixture counts again', api.computePointsTable([{ ...recs[1], upcoming: false }]).map(r => r.played), [1, 1]);
    eq('leaderboards / status / counts skip fixtures', [/function computeLeaderboards\(matches\) \{\r?\n\s+matches = playedMatches\(matches\);/.test(H.src), (H.src.match(/playedMatches\(matches\)\.length > 0 \? 'ongoing'/g) || []).length], [true, 2]);
  }

  console.log('\n######## Tournament page: Upcoming group (date only) ########');
  {
    const payload = {
      success: true, displayName: 'Test Cup',
      matches: [
        { matchId: 'm-old', roomId: 'room-old', matchNo: 1, savedAt: '2026-10-01T10:00:00.000Z', winningTeam: 'A', teamA: { name: 'Lions', short: 'LIO' }, teamB: { name: 'Tigers', short: 'TIG' },
          scoreA: { runs: 150, wickets: 6, overs: '20.0' }, scoreB: { runs: 120, wickets: 9, overs: '20.0' }, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } },
        { matchId: 'm-up-late', roomId: 'room-late', upcoming: true, matchNo: 3, scheduledDate: '2026-10-20', venue: 'Wankhede', teamA: { name: 'Tigers', short: 'TIG' }, teamB: { name: 'Golden Eagles', short: 'GE' },
          scoreA: { runs: 0, wickets: 0, overs: '0.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' }, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } },
        { matchId: 'm-up-soon', roomId: 'room-soon', upcoming: true, matchNo: 2, matchTitle: 'Semi Final', scheduledDate: '2026-10-04', teamA: { name: 'Lions', short: 'LIO', teamId: 't1' }, teamB: { name: 'Golden Eagles', short: 'GE' },
          scoreA: { runs: 0, wickets: 0, overs: '0.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' }, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } },
        { matchId: 'm-up-live', roomId: 'room-live', upcoming: true, matchNo: 4, scheduledDate: '2026-10-03', teamA: { name: 'Sharks', short: 'SHK' }, teamB: { name: 'Lions', short: 'LIO' },
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
    const startsLine = soon && soon.querySelector('.mc-result').textContent;
    eq('upcoming card: badge + "Starts <date>" (no time), no "Yet to bat"', soon && [soon.querySelector('.mc-status').textContent.trim(), /^Starts .*2026$/.test(startsLine), /\d{1,2}:\d{2}/.test(startsLine), /Yet to bat/.test(soon.textContent)], ['Upcoming', true, false, false]);
    eq('date is the fixture date in any time zone (4 Oct)', /\b4\b/.test(startsLine) && /Oct/.test(startsLine), true);
    eq('upcoming card links to its own live room', soon && soon.getAttribute('href'), '/cricket-scorecard?room=room-soon');
    eq('hero counts played matches only', /^2 matches played/.test((tdoc.getElementById('tourney-meta') || {}).textContent || ''), true);
    eq('match count shows the fixtures separately', (tdoc.querySelector('.mc-count') || {}).textContent, '2 matches · 2 upcoming');
    eq('no script errors (tournament page)', tErrors, []);
  }

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
