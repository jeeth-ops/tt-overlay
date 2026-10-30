// 💾 Saved teams keep their WHOLE squad, every player keeps their Player ID,
// and a batter's hand is the player's own (on their profile, by Player ID) —
// on the REAL server.js (test/server-boot.js: in-memory MongoDB with the
// production indexes) and the REAL cricket-panel.html (jsdom, its fetch
// going to that server):
//
//   A. the server
//      • teams saved before squads were kept: an empty saved team gets the
//        squad of its latest match (same ids); a team with players is never
//        touched; a hand noted only on match squads (L) goes onto the
//        profile — never over a hand already set, never when the player's
//        latest match does not say so; once per account
//      • a team saved with its players: ids kept, typed names find-or-create,
//        saving again makes no new players; the roster comes back on every
//        load; adding / removing a player changes only that team (the
//        removed player's profile stays)
//      • a laptop holding an older copy is told (409 TEAM_CHANGED), nothing
//        is written over
//      • the hand: stored on the profile (POST /api/players/hand), shown with
//        every team that player is in, given back by canonicalize (a merged id
//        reads the surviving profile), an offline-made id gets its profile,
//        another account's player is never touched, 401/403
//   B. the panel, against that server
//      • squad "+ Add" → RHB / LHB per player → "Saved to the player profile"
//        only after the server said so → 💾 Save Team → "✓ Saved team"
//      • a NEW panel (a refresh, another laptop: empty localStorage) →
//        Create New Match → the same team → every player, the same ids, the
//        left-hander already LEFT (the openers' picker too), the
//        right-hander RIGHT; no new player records
//      • the hand changed at the crease → the profile → the next match
//      • a default nobody touched (new batter window) is NOT written to the
//        profile
//      • roster edit + Save Team: only this team changes; an older laptop is
//        asked before saving over it (Cancel = nothing saved)
//      • the server down: no "saved" until it answers; the pick waits in the
//        outbox (also across a refresh) and is sent when it is back
//
//   node test/cricket/team-roster-persistence-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { bootServer, request } = require('../server-boot.js');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 6000); let v; while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(40); } return v; };

const OWNER = 'U1', OTHER = 'U2', STRANGER = 'U3';
const USERS = { [OWNER]: 'workallsportslive@gmail.com', [OTHER]: 'vinitkrkr1@gmail.com', [STRANGER]: 'stranger@example.com' };
const pk = (n) => String(n).trim().toLowerCase().replace(/\s+/g, ' ');
const prof = (id, name, extra) => Object.assign({ playerId: id, ownerUid: OWNER, nameKeys: [pk(name)], displayName: name, createdAt: 1, updatedAt: 1 }, extra || {});
const rec = (matchId, savedAt, teamA, squadA, teamB, squadB) => ({ ownerUid: OWNER, leagueKey: 'legacy cup', matchId, roomId: 'r-' + matchId, savedAt, upcoming: false,
  teamA, teamB, squadA, squadB, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } });

(async () => {
  const { port, mem } = await bootServer({ users: USERS, seed: async (m) => {
    const players = m.collection('players'), teams = m.collection('teams'), records = m.collection('matchRecords');
    for(const p of [prof('gp_l1', 'Lefty One'), prof('gp_r1', 'Righty One'), prof('gp_x1', 'Changed Mind'), prof('gp_set', 'Already Set', { batHand: 'R' }),
      prof('gp_full', 'Full Player'), prof('gp_old', 'Old Alias', { nameKeys: [], mergedInto: 'gp_l1' })]) await players.insertOne(p);
    // saved before squads were kept: name + logo + id only
    await teams.insertOne({ ownerUid: OWNER, teamId: 't_legacy', name: 'Legacy Lions', nameKey: 'legacy lions', short: 'LL', color: '#ff0000', logoUrl: '', players: [], captainId: null, wkId: null, createdAt: 1, updatedAt: 1 });
    await teams.insertOne({ ownerUid: OWNER, teamId: 't_full', name: 'Full Team', nameKey: 'full team', short: 'FT', color: '#00ff00', logoUrl: '', players: [{ id: 'gp_full', name: 'Full Player', isXI: true }], captainId: null, wkId: null, createdAt: 1, updatedAt: 1 });
    await teams.insertOne({ ownerUid: OWNER, teamId: 't_tigers', name: 'Old Tigers', nameKey: 'old tigers', short: 'OT', color: '#0000ff', logoUrl: '', players: [], captainId: null, wkId: null, createdAt: 1, updatedAt: 1 });
    // older match: Changed Mind left-handed; newer match: not (→ not moved); Already Set has R on the profile
    await records.insertOne(rec('m-1', '2026-09-01T10:00:00.000Z', { name: 'Legacy Lions', teamId: 't_legacy' },
      { players: [{ id: 'gp_x1', name: 'Changed Mind', isXI: true, hand: 'L' }], captainId: null, wkId: null },
      { name: 'Full Team', teamId: 't_full' }, { players: [{ id: 'gp_set', name: 'Already Set', isXI: true, hand: 'L' }], captainId: null, wkId: null }));
    await records.insertOne(rec('m-2', '2026-09-20T10:00:00.000Z', { name: 'Legacy Lions', teamId: 't_legacy' },
      { players: [{ id: 'gp_l1', name: 'Lefty One', isXI: true, hand: 'L' }, { id: 'gp_r1', name: 'Righty One', isXI: false }, { id: 'gp_x1', name: 'Changed Mind', isXI: true }], captainId: 'gp_l1', wkId: 'gp_r1' },
      { name: 'Old Tigers' }, { players: [{ id: 'gp_t1', name: 'Tiger Tom', isXI: true }], captainId: null, wkId: null }));
  } });
  const api = (method, url, body, uid) => request(port, method, url + (url.includes('?') ? '&' : '?') + 'uid=' + (uid || OWNER), body);
  const players = mem.collection('players'), teamsCol = mem.collection('teams');
  const profile = (id) => players.findOne({ playerId: id });
  const teamOf = (list, name) => (list || []).find(t => t.name === name);
  const roster = (t) => t ? t.players.map(p => [p.id, p.name, p.isXI, p.hand || null]) : null;

  console.log('\n######## A1. teams saved before their squads were kept ########');
  let r = await api('GET', '/api/teams');
  eq('GET /api/teams answers', [r.status, r.json && r.json.success], [200, true]);
  eq('an empty saved team gets the squad of its latest match — the same Player IDs, its captain / keeper, the hand from the profiles',
    [roster(teamOf(r.json.teams, 'Legacy Lions')), teamOf(r.json.teams, 'Legacy Lions').captainId, teamOf(r.json.teams, 'Legacy Lions').wkId],
    [[['gp_l1', 'Lefty One', true, 'L'], ['gp_r1', 'Righty One', false, null], ['gp_x1', 'Changed Mind', true, null]], 'gp_l1', 'gp_r1']);
  eq('…found by name when the match did not carry its teamId (a new profile for a player who had none)', [roster(teamOf(r.json.teams, 'Old Tigers')), !!(await profile('gp_t1'))], [[['gp_t1', 'Tiger Tom', true, null]], true]);
  eq('a saved team that has players is never touched', roster(teamOf(r.json.teams, 'Full Team')), [['gp_full', 'Full Player', true, null]]);
  eq('a hand noted on match squads moves onto the profile (L) — not when the latest match says otherwise, never over a hand already set',
    [(await profile('gp_l1')).batHand, (await profile('gp_x1')).batHand, (await profile('gp_set')).batHand], ['L', undefined, 'R']);
  const legacyDoc = await teamsCol.findOne({ teamId: 't_legacy' });
  eq('the filled team gets a revision, and says where its squad came from', [legacyDoc.rev, legacyDoc.squadFromMatch], [1, 'm-2']);
  await teamsCol.updateOne({ teamId: 't_tigers' }, { $set: { players: [] } });
  r = await api('GET', '/api/teams');
  eq('once per account: a team emptied later on purpose stays empty', roster(teamOf(r.json.teams, 'Old Tigers')), []);
  eq('every player record is still there — nothing deleted', (await players.find({}).toArray()).length, 7);

  console.log('\n######## A2. a team saved WITH its players ########');
  const before = (await players.find({}).toArray()).length;
  r = await api('POST', '/api/teams', { team: { name: 'Mumbai Stars', short: 'MS', color: '#1d4ed8', players: [
    { id: 'gp_l1', name: 'Lefty One', isXI: true }, { name: 'New Batter', isXI: true }, { name: 'New Bowler', isXI: false }], captainId: 'gp_l1' } });
  const stars = r.json.team;
  eq('created: 201, revision 1, the picked player keeps their id, typed names get one each', [r.status, stars.rev, stars.players[0].id, stars.players.every(p => p.id), new Set(stars.players.map(p => p.id)).size], [201, 1, 'gp_l1', true, 3]);
  eq('the team shows each player\'s hand from their own profile', roster(stars).map(x => x[3]), ['L', null, null]);
  eq('two new player records (one per typed name), no more', (await players.find({}).toArray()).length, before + 2);
  r = await api('POST', '/api/teams', { team: { teamId: stars.teamId, baseRev: 1, name: 'Mumbai Stars', short: 'MS', color: '#1d4ed8',
    players: stars.players.map(p => ({ id: p.id, name: p.name, isXI: p.isXI })), captainId: 'gp_l1' } });
  eq('saved again with the same squad: the same ids, no new player records, revision 2', [r.status, r.json.team.players.map(p => p.id), (await players.find({}).toArray()).length, r.json.team.rev],
    [200, stars.players.map(p => p.id), before + 2, 2]);
  r = await api('GET', '/api/teams');
  eq('loaded again (a refresh / another laptop): the whole squad, the same Player IDs', roster(teamOf(r.json.teams, 'Mumbai Stars')).map(x => x[0]), stars.players.map(p => p.id));
  const removed = stars.players[2], legacyBefore = roster(teamOf(r.json.teams, 'Legacy Lions'));
  r = await api('POST', '/api/teams', { team: { teamId: stars.teamId, baseRev: 2, name: 'Mumbai Stars', players: [
    ...stars.players.slice(0, 2).map(p => ({ id: p.id, name: p.name })), { id: 'gp_r1', name: 'Righty One' }] } });
  eq('a player removed and one added: that team only, revision 3', [r.status, r.json.team.rev, r.json.team.players.map(p => p.id)], [200, 3, [stars.players[0].id, stars.players[1].id, 'gp_r1']]);
  eq('…the removed player\'s profile stays; the other teams are as they were', [!!(await profile(removed.id)), roster(teamOf((await api('GET', '/api/teams')).json.teams, 'Legacy Lions'))], [true, legacyBefore]);
  r = await api('POST', '/api/teams', { team: { teamId: stars.teamId, baseRev: 2, name: 'Mumbai Stars', players: [] } });
  eq('saved from an older copy (revision 2, the team is at 3) → 409 TEAM_CHANGED with the team as it is now, nothing written',
    [r.status, r.json.code, r.json.team.rev, r.json.team.players.length, (await teamsCol.findOne({ teamId: stars.teamId })).players.length], [409, 'TEAM_CHANGED', 3, 3, 3]);

  console.log('\n######## A3. the batting hand is the player\'s own ########');
  r = await api('POST', '/api/players/hand', { players: [{ id: 'gp_r1', name: 'Righty One', hand: 'L' }] });
  eq('POST /api/players/hand → stored on the profile, the server says so', [r.status, r.json.success, r.json.players[0].ok, (await profile('gp_r1')).batHand], [200, true, true, 'L']);
  r = await api('GET', '/api/teams');
  eq('…and it shows in EVERY team that player is in', [teamOf(r.json.teams, 'Legacy Lions').players.find(p => p.id === 'gp_r1').hand, teamOf(r.json.teams, 'Mumbai Stars').players.find(p => p.id === 'gp_r1').hand], ['L', 'L']);
  await api('POST', '/api/players/hand', { players: [{ id: 'gp_r1', name: 'Righty One', hand: 'R' }] });
  r = await api('POST', '/api/players/canonicalize', { ids: ['gp_r1', 'gp_l1', 'gp_old', 'gp_full'] });
  eq('canonicalize gives back the hands: right now R, left L, a merged-away id reads the surviving profile, none set → absent',
    [r.json.map.gp_old, r.json.hands], ['gp_l1', { gp_r1: 'R', gp_l1: 'L', gp_old: 'L' }]);
  r = await api('POST', '/api/players/hand', { players: [{ id: 'p_offline1', name: 'Offline Guy', hand: 'L' }] });
  eq('a player added offline (a panel-made id) gets their profile under that same id', [r.json.success, (await profile('p_offline1') || {}).batHand], [true, 'L']);
  r = await api('POST', '/api/players/hand', { players: [{ id: 'gp_l1', name: 'Lefty One', hand: 'R' }] }, OTHER);
  eq('another account cannot change this account\'s player (not stored, and said so)', [r.json.success, r.json.players[0].ok, (await profile('gp_l1')).batHand, (await players.find({ playerId: 'gp_l1' }).toArray()).length], [false, false, 'L', 1]);
  eq('a stranger: 403; no uid: 401', [(await api('POST', '/api/players/hand', { players: [{ id: 'gp_l1', hand: 'R' }] }, STRANGER)).status, (await request(port, 'POST', '/api/players/hand', { players: [] })).status], [403, 401]);
  eq('a bad request: no hand / no player → refused', [(await api('POST', '/api/players/hand', { players: [{ id: 'gp_l1', hand: 'X' }] })).json.success, (await api('POST', '/api/players/hand', {})).status], [false, 400]);
  r = await api('GET', '/api/players/search?q=lefty');
  eq('player search (the team editor\'s suggestions) carries the hand', r.json.players.map(p => [p.playerId, p.hand || null]), [['gp_l1', 'L']]);
  r = await api('POST', '/api/teams', { team: { teamId: 't_full', name: 'Full Team', players: [{ id: 'gp_full', name: 'Full Player', hand: 'L' }] } });
  eq('a hand picked in the team editor is saved with the team onto that player\'s profile', [r.status, r.json.team.players[0].hand, (await profile('gp_full')).batHand], [200, 'L', 'L']);

  // ================================================================
  console.log('\n######## B. the real panel against the real server ########');
  const base = `http://127.0.0.1:${port}`;
  const net = { handDown: false, handCalls: 0 };
  function bootPanel(storage){
    let html = fs.readFileSync(path.join(__dirname, '..', '..', 'cricket-panel.html'), 'utf8');
    html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
    const vc = new VirtualConsole();
    const errors = [];
    vc.on('jsdomError', e => errors.push(e.message));
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: `https://panel.test/cricket-panel?uid=${OWNER}`, virtualConsole: vc,
      beforeParse(w){
        if(storage) Object.keys(storage).forEach(k => w.localStorage.setItem(k, storage[k]));
        w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){} });
        w.fetch = async (url, opts) => {
          const u = new URL(String(url), base);
          if(u.host !== `127.0.0.1:${port}`) return { ok: false, status: 404, json: async () => ({}) };
          if(u.pathname === '/api/players/hand'){ net.handCalls++; if(net.handDown) throw new TypeError('Failed to fetch'); }
          const o = Object.assign({}, opts || {}); delete o.signal;
          return fetch(u.href, o);
        };
        w.firebase = undefined;
        w.alert = () => {};
        w.__confirms = []; w.__confirmAnswer = true;
        w.confirm = (m) => { w.__confirms.push(String(m)); return w.__confirmAnswer; };
        w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
        Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
        w.HTMLMediaElement.prototype.play = () => Promise.resolve();
        w.HTMLMediaElement.prototype.pause = () => {};
        w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
      }
    });
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    const E = (c) => dom.window.eval(c);
    E(`(function(){ const t = toast; window.__toasts = []; toast = function(m){ window.__toasts.push(String(m)); try{ return t.apply(this, arguments); }catch(e){} }; })()`);
    return { w: dom.window, E, errors, $: (s) => dom.window.document.querySelector(s), close: () => dom.window.close() };
  }
  const click = (P, el) => el.dispatchEvent(new P.w.Event('click', { bubbles: true }));
  const toasts = (P, re) => P.w.__toasts.filter(t => re.test(t));
  const rowOf = (P, side, name) => [...P.w.document.querySelectorAll(`#squad${side}-list .squad-player-row`)].find(r => r.querySelector('input[type="text"]').value === name);
  async function addPlayer(P, side, name){
    const n = P.E(`state.team${side}.players.length`);
    P.$(`#squad${side}-new-name`).value = name;
    click(P, P.$(`#squad${side}-add-btn`));
    await until(() => P.E(`state.team${side}.players.length`) > n);
  }

  // ---- 1. a team made in the panel, its players, one left-hander, Save Team
  let P = bootPanel();
  await sleep(300);
  eq('the panel boots with no script errors', P.errors, []);
  P.E(`state.teamA.name = 'Panel Kings'; state.teamA.short = 'PK'; state.teamA.color = '#7c3aed'; state.teamA.players = []; state.teamA.teamId = null;
       state.teamB.name = 'Panel Rivals'; state.teamB.players = []; renderSquadUI();`);
  for(const n of ['Arjun Left', 'Bala Right', 'Chetan Third']) await addPlayer(P, 'A', n);
  const ids1 = P.E(`state.teamA.players.map(p => p.id)`);
  eq('"+ Add": each player gets a permanent id from the server\'s player records', [ids1.length, new Set(ids1).size, ids1.every(id => /^[0-9a-f]{12}$/.test(id))], [3, 3, true]);
  eq('each row shows RHB (no hand on the profile yet)', ['Arjun Left', 'Bala Right'].map(n => rowOf(P, 'A', n).querySelector('.squad-hand').textContent), ['RHB', 'RHB']);
  eq('…and the squad says it is not a saved team yet', P.$('#squadA-save-status').textContent, 'Not a saved team yet — Save Team keeps this squad for every later match');
  net.handCalls = 0;
  click(P, rowOf(P, 'A', 'Arjun Left').querySelector('.squad-hand'));
  eq('LHB at once on the row', [rowOf(P, 'A', 'Arjun Left').querySelector('.squad-hand').textContent, P.E(`batHandOf(state.teamA.players[0])`)], ['LHB', 'L']);
  const saidSaved = await until(() => toasts(P, /Saved to the player profile: Arjun Left \(left-handed\)/).length);
  eq('"Saved to the player profile" — only once the server stored it', [!!saidSaved, (await profile(ids1[0])).batHand, P.E(`Object.keys(bhOutbox).length`)], [true, 'L', 0]);

  click(P, P.$('#squadA-save-btn'));
  await until(() => P.E(`!!state.teamA.teamId && !squadSaving.A`));
  const savedTeam = await teamsCol.findOne({ ownerUid: OWNER, nameKey: 'panel kings' });
  eq('💾 Save Team → the team is saved with all 3 players and their ids', savedTeam ? [savedTeam.players.map(p => p.id), savedTeam.rev, P.E(`state.teamA.teamId`) === savedTeam.teamId] : null, [ids1, 1, true]);
  eq('…the squad says "saved", and the toast came after the server\'s answer', [P.$('#squadA-save-status').textContent, toasts(P, /^✅ Panel Kings saved — 3 players/).length], ['✓ Saved team · 3 players with their Player IDs', 1]);
  P.E(`state.teamA.players[2].isXI = false; renderRosterControls();`);
  eq('a change after saving: "changes not saved" until Save Team', P.$('#squadA-save-status').textContent, '● Changes not saved to the team yet');
  P.E(`state.teamA.players[2].isXI = true; renderRosterControls();`);
  const playersBefore = (await players.find({ ownerUid: OWNER }).toArray()).length;
  const oldStorage = {}; for(let i = 0; i < P.w.localStorage.length; i++){ const k = P.w.localStorage.key(i); oldStorage[k] = P.w.localStorage.getItem(k); }
  P.close();

  // ---- 2. a NEW panel (empty storage: a refresh on another laptop) → Create New Match → the same team
  async function newMatchWith(P, nameA){
    click(P, P.$('#new-match-btn'));
    await until(() => P.$('#newmatch-modal-overlay').classList.contains('show') && [...P.$('#newmatch-team-a').options].some(o => o.textContent.startsWith(nameA)));
    const sel = P.$('#newmatch-team-a');
    sel.value = [...sel.options].find(o => o.textContent.startsWith(nameA)).value;
    sel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
    click(P, P.$('#newmatch-start'));
    await until(() => !P.$('#newmatch-modal-overlay').classList.contains('show'));
    await sleep(400);
  }
  P = bootPanel();
  await sleep(300);
  await newMatchWith(P, 'Panel Kings');
  eq('new match: the saved team comes back with EVERY player and the SAME Player IDs', [P.E(`state.teamA.name`), P.E(`state.teamA.players.map(p => p.id)`)], ['Panel Kings', ids1]);
  eq('…the left-hander is already LEFT, the others RIGHT — from their profiles', P.E(`state.teamA.players.map(p => batHandOf(p))`), ['L', 'R', 'R']);
  eq('…the rows say so, and the squad is the saved team', [['Arjun Left', 'Bala Right'].map(n => rowOf(P, 'A', n).querySelector('.squad-hand').textContent), P.$('#squadA-save-status').textContent],
    [['LHB', 'RHB'], '✓ Saved team · 3 players with their Player IDs']);
  P.E(`state.battingTeam = 'A'; renderRosterControls();`);
  const strSel = P.$('#striker-roster-select');
  strSel.value = ids1[0]; strSel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  await sleep(50);
  eq('the left-hander picked as an opener: the crease picker shows Left-hand by itself', [P.E(`state.striker.id`), P.$('#bh-striker').dataset.hand], [ids1[0], 'L']);
  eq('no new player records for bringing the team back', (await players.find({ ownerUid: OWNER }).toArray()).length, playersBefore);

  // ---- 3. the right-hander: picked at the crease → the profile → the next match
  const nsSel = P.$('#nonstriker-roster-select');
  nsSel.value = ids1[1]; nsSel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  await sleep(50);
  click(P, P.$('#bh-nonstriker [data-bh="L"]'));
  await until(() => toasts(P, /Bala Right \(left-handed\)/).length);
  click(P, P.$('#bh-nonstriker [data-bh="R"]'));
  await until(() => toasts(P, /Bala Right \(right-handed\)/).length);
  eq('Left then Right at the crease: the profile says R (the newest pick wins)', (await profile(ids1[1])).batHand, 'R');
  await newMatchWith(P, 'Panel Kings');
  eq('the next match: Arjun LEFT, Bala RIGHT — a new match does not reset either', P.E(`state.teamA.players.map(p => batHandOf(p))`), ['L', 'R', 'R']);

  // ---- 4. a default nobody touched is not written to the profile
  P.E(`state.battingTeam = 'A'; state.striker = { ...state.striker, id: '${ids1[1]}', name: 'Bala Right' }; state.nonStriker = { ...state.nonStriker, id: '', name: '' }; state.newBatsmanEnd = 'nonStriker'; openNewBatsmanModal('Someone');`);
  const nbSel = P.$('#newbat-modal-select');
  nbSel.value = ids1[2]; nbSel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  net.handCalls = 0;
  click(P, P.$('#newbat-modal-submit'));
  await sleep(500);
  eq('new batter with the shown default (Right-hand, untouched): no profile write', [net.handCalls, (await profile(ids1[2])).batHand], [0, undefined]);
  P.E(`state.striker = { ...state.striker, id: '${ids1[1]}', name: 'Bala Right' }; state.nonStriker = { ...state.nonStriker, id: '', name: '' }; state.newBatsmanEnd = 'nonStriker'; openNewBatsmanModal('Someone');`);
  nbSel.value = ids1[0]; nbSel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  eq('…the left-hander picked there: the window shows Left-hand by itself', P.$('#newbat-modal-hand').dataset.hand, 'L');
  click(P, P.$('#newbat-modal-submit'));
  await sleep(500);
  eq('…and confirming it unchanged writes nothing either', net.handCalls, 0);

  // ---- 5. roster edit + Save Team; another laptop holding the older copy
  await addPlayer(P, 'A', 'Dev Fourth');
  P.E(`(function(){ const t = state.teamA; t.players = t.players.filter(p => p.name !== 'Chetan Third'); renderSquadUI(); renderRosterControls(); })()`);
  eq('roster edited: "changes not saved"', P.$('#squadA-save-status').textContent, '● Changes not saved to the team yet');
  const fullBefore = await teamsCol.findOne({ teamId: 't_full' });
  click(P, P.$('#squadA-save-btn'));
  await until(() => P.$('#squadA-save-status').classList.contains('ok'));
  const kings2 = await teamsCol.findOne({ ownerUid: OWNER, nameKey: 'panel kings' });
  eq('Save Team: Chetan off, Dev on — the others keep their ids; revision 2; Chetan\'s profile stays', [kings2.players.map(p => p.name), kings2.players.slice(0, 2).map(p => p.id), kings2.rev, !!(await profile(ids1[2]))],
    [['Arjun Left', 'Bala Right', 'Dev Fourth'], ids1.slice(0, 2), 2, true]);
  eq('…no other team changed', JSON.stringify(await teamsCol.findOne({ teamId: 't_full' })), JSON.stringify(fullBefore));
  const P2 = P;
  P = bootPanel(oldStorage); // the first laptop, still holding the squad as saved at revision 1
  await sleep(300);
  P.w.__confirmAnswer = false;
  P.E(`state.teamA.players.push({ id: 'p_late', name: 'Late Add', isXI: true }); renderSquadUI();`);
  click(P, P.$('#squadA-save-btn'));
  await until(() => P.w.__confirms.length);
  await sleep(200);
  eq('the older laptop\'s Save Team: asked first (changed on another laptop), Cancel → nothing saved, and it says so',
    [/was changed on another laptop/.test(P.w.__confirms[0] || ''), (await teamsCol.findOne({ ownerUid: OWNER, nameKey: 'panel kings' })).rev, toasts(P, /^Not saved/).length, toasts(P, /^✅ Panel Kings saved/).length], [true, 2, 1, 0]);
  P.close();

  // ---- 6. the server out of reach: no "saved" until it answers, the pick waits (also across a refresh)
  P = P2;
  net.handDown = true;
  P.w.__toasts.length = 0;
  click(P, rowOf(P, 'A', 'Dev Fourth').querySelector('.squad-hand'));
  await until(() => toasts(P, /not saved to the player profile yet/).length);
  const devId = P.E(`state.teamA.players.find(p => p.name === 'Dev Fourth').id`);
  eq('offline: no "saved" — it says it will try again; the pick waits in the outbox on this laptop', [toasts(P, /Saved to the player profile/).length, (await profile(devId)).batHand, Object.keys(JSON.parse(P.w.localStorage.getItem('cricket-bathand-outbox') || '{}'))],
    [0, undefined, [devId]]);
  const waiting = P.w.localStorage.getItem('cricket-bathand-outbox');
  P.close();
  net.handDown = false;
  P = bootPanel({ 'cricket-bathand-outbox': waiting });
  await until(() => toasts(P, /Saved to the player profile: Dev Fourth \(left-handed\)/).length, 8000);
  eq('refreshed with the connection back: sent by itself, then "saved", the outbox empty', [(await profile(devId)).batHand, P.w.localStorage.getItem('cricket-bathand-outbox')], ['L', '{}']);

  // ---- 7. quick taps: the newest pick is the one kept
  await newMatchWith(P, 'Panel Kings');
  const balaId = ids1[1];
  eq('Bala comes in RIGHT', rowOf(P, 'A', 'Bala Right').querySelector('.squad-hand').textContent, 'RHB');
  P.w.__toasts.length = 0;
  for(let i = 0; i < 3; i++) click(P, rowOf(P, 'A', 'Bala Right').querySelector('.squad-hand'));
  await until(() => P.E(`Object.keys(bhOutbox).length === 0 && !bhFlushing`) && toasts(P, /Bala Right \(left-handed\)/).length);
  eq('three quick taps R→L→R→L: the profile ends LEFT, as the row says', [rowOf(P, 'A', 'Bala Right').querySelector('.squad-hand').textContent, (await profile(balaId)).batHand], ['LHB', 'L']);

  // ---- 8. the Upcoming Match team editor: each player's hand, saved with the team onto the profiles
  P.E(`state.leagueName = 'Roster Cup'; state.matchMode = 'tournament'; saveLocal();`);
  click(P, P.$('#schedule-match-btn'));
  await until(() => P.$('#um-overlay').classList.contains('show') && P.$('[data-um-pick="A"]') && !P.$('[data-um-pick="A"]').disabled);
  click(P, P.$('[data-um-pick="A"]'));
  await sleep(30);
  click(P, [...P.w.document.querySelectorAll('[data-um-select]')].find(b => /Panel Kings/.test(b.textContent)));
  await sleep(30);
  click(P, P.$('[data-um-edit="A"]'));
  await sleep(30);
  const teHands = () => [...P.w.document.querySelectorAll('#te-players .te-row')].map(r => [r.querySelector('input').value, r.querySelector('.te-hand').textContent]);
  eq('Edit Team: every player with their hand from their profile', teHands(), [['Arjun Left', 'LHB'], ['Bala Right', 'LHB'], ['Dev Fourth', 'LHB']]);
  const tin = P.$('#te-player-input');
  tin.value = 'Eve Editor';
  tin.dispatchEvent(new P.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(30);
  const teRow = (n) => [...P.w.document.querySelectorAll('#te-players .te-row')].find(r => r.querySelector('input').value === n);
  click(P, teRow('Eve Editor').querySelector('.te-hand'));
  click(P, teRow('Bala Right').querySelector('.te-hand'));
  eq('a new player set to LHB, Bala set to RHB', teHands(), [['Arjun Left', 'LHB'], ['Bala Right', 'RHB'], ['Dev Fourth', 'LHB'], ['Eve Editor', 'LHB']]);
  click(P, P.$('#te-save'));
  await until(() => !P.$('#te-overlay').classList.contains('show'));
  const kings3 = await teamsCol.findOne({ ownerUid: OWNER, nameKey: 'panel kings' });
  const eve = kings3.players.find(p => p.name === 'Eve Editor');
  eq('Save Team (editor): Eve on the team with her own id, the others keep theirs; the hands are on the profiles',
    [kings3.players.slice(0, 3).map(p => p.id).join() === [ids1[0], ids1[1], devId].join(), !!(eve && eve.id), eve && (await profile(eve.id)).batHand, (await profile(balaId)).batHand, (await profile(ids1[0])).batHand],
    [true, true, 'L', 'R', 'L']);
  eq('no script errors in any panel', P.errors, []);
  P.close();

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
