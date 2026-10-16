// ▶ An Upcoming Match made on Laptop A, started on Laptop B (same account) —
// both real panels in jsdom, against the REAL server routes (taken out of
// server.js by text, never copied): the tournament list, the match save,
// the atomic ▶ Start, the match lock. The socket room behaves like the
// server's: on every (re)connect it hands the panel the room's last saved
// state first.
//
//   • B's tournament choice survives a reconnect and a reload (the room's
//     copy of what another moment of B was looking at no longer wipes it),
//     so the fixture and its ▶ Start stay on B
//   • ▶ Start reuses the fixture's matchId + room; one record, no copy
//   • two laptops pressing ▶ Start together: one starts it, one is told
//   • A's stale list: told it started, no key taken, nothing overwritten
//   • locked: the code is asked on B, a wrong one refused, the right one starts
//   • another account / no authorised account: refused by the server
//   • the server starting up: lists are not wiped, locks not skipped
//   • A's save that the server refused: not announced, nothing left behind,
//     saving again saves the same match (same ids, same code)
//
//   node test/cricket/cross-device-start-test.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');
const H = require('./server-harness');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000){ const t0 = Date.now(); while(Date.now() - t0 < ms){ try{ if(fn()) return true; }catch(e){} await sleep(15); } return false; }
const PANEL_DIR = process.env.PANEL_DIR || path.join(__dirname, '..', '..');
const src = H.src;
const between = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if(i < 0 || j < 0) throw new Error('marker not found: ' + a); return src.slice(i, j); };
// one whole app.get/app.post(...) statement
function route(head){
  const start = src.indexOf(head);
  if(start < 0) throw new Error('route not found: ' + head);
  let depth = 0;
  for(let j = src.indexOf('{', start + head.length - 1); j < src.length; j++){
    if(src[j] === '{') depth++;
    else if(src[j] === '}'){ depth--; if(depth === 0){ const end = src.indexOf(');', j); return src.slice(start, end + 2); } }
  }
  throw new Error('unbalanced route: ' + head);
}

/* ------------------------------------------------------------------ */
/* The real server routes, on in-memory collections                    */
/* ------------------------------------------------------------------ */
const LOCK_BLOCK = between('const MATCH_LOCK_ALPHABET', "// 🏆 Create / edit a tournament");
const ROUTES = [
  route("app.get('/api/leagues', requireAuthorizedCreator, async (req, res) => {"),
  route("app.get('/api/league/:name', requireAuthorizedCreator, async (req, res) => {"),
  route("app.post('/api/league/:name/match', requireAuthorizedCreator, async (req, res) => {"),
  route("app.post('/api/league/:name/match/:matchId/start', requireAuthorizedCreator, async (req, res) => {")
].join('\n');

function collection(docs){
  const c = H.coll(docs || []);
  // upsert + $setOnInsert (the leagues doc), and deleteMany
  const update = c.updateOne;
  c.updateOne = async (q, u, opts) => {
    const r = await update(q, u);
    if(!r.matchedCount && opts && opts.upsert){ c.docs.push(JSON.parse(JSON.stringify({ ...q, ...(u.$setOnInsert || {}), ...(u.$set || {}) }))); return { matchedCount: 0, upsertedCount: 1 }; }
    return r;
  };
  c.deleteMany = async (q) => { for(let i = c.docs.length - 1; i >= 0; i--) if(Object.keys(q).every(k => typeof q[k] !== 'object' ? c.docs[i][k] === q[k] : true)) c.docs.splice(i, 1); return {}; };
  const find = c.find;
  c.find = (q) => { const cur = find(q); cur.project = () => cur; return cur; };
  return c;
}
function lockStore(){
  const c = H.coll([]);
  const insert = c.insertOne;
  c.insertOne = async (doc) => {
    if(c.docs.some(d => d.roomId === doc.roomId || d.codeHmac === doc.codeHmac)){ const e = new Error('dup'); e.code = 11000; throw e; }
    return insert(doc);
  };
  return c;
}
const AUTHORIZED = new Set(['U1', 'U2']); // the creator accounts (U1 = workallsportslive@…)
function makeServer(){
  const routes = [];
  const add = (method) => (p, ...handlers) => routes.push({ method, re: new RegExp('^' + p.replace(/:[a-zA-Z]+/g, '([^/]+)') + '$'), keys: (p.match(/:[a-zA-Z]+/g) || []).map(k => k.slice(1)), handlers });
  const app = { get: add('GET'), post: add('POST'), delete: add('DELETE') };
  const emitted = [];
  const io = { to: (room) => ({ emit: (ev, d) => emitted.push({ room, ev, d }) }) };
  const records = collection([]), leagues = collection([]), store = lockStore();
  const requireAuthorizedCreator = (req, res, next) => {
    const uid = req.query.uid;
    if(!uid) return res.status(401).json({ success: false, error: 'Login required' });
    if(!AUTHORIZED.has(uid)) return res.status(403).json({ success: false, code: 'NOT_AUTHORIZED', error: 'This account is not authorized' });
    req.creatorEmail = uid.toLowerCase() + '@x.test';
    return next();
  };
  const requireOwner = (req, res) => res.status(403).json({ success: false });
  const ownerUidFrom = (req) => (req.query.uid || '').toString().trim() || null;
  // the safety-net writer, reduced to its $set merge
  const writeMatchRecordSafely = async (filter, rec) => {
    const d = records.docs.find(x => x.ownerUid === filter.ownerUid && x.leagueKey === filter.leagueKey && x.matchId === filter.matchId);
    if(d) Object.assign(d, JSON.parse(JSON.stringify(rec))); else records.docs.push(JSON.parse(JSON.stringify(rec)));
    return { lost: [] };
  };
  const api = new Function('app', 'io', 'crypto', 'safeMatchId', 'requireAuthorizedCreator', 'requireOwner', 'ownerUidFrom', 'logAuditAction',
    'RECORDS', 'LEAGUES', 'STORE', 'writeMatchRecordSafely', 'mergeLockResponse', 'invalidateTournamentCaches', 'ensureLeaguePublicToken',
    'let matchRecordsCollection = RECORDS, leaguesCollection = LEAGUES, matchLocksCollection = STORE;\n' +
    'let matchLockSecret = "test-secret-for-match-locks-0123456789";\n' +
    'let ready = Promise.resolve(); const whenMongoReady = () => ready;\n' +
    H.grabConst('SINGLE_MATCHES_LEAGUE_KEY') + H.grab('leagueKeyFor') + '\n' + H.grab('detectSportFromName') + '\n' + H.grab('getLeagueMatches', 'async function ') + '\n' +
    LOCK_BLOCK + '\n' + ROUTES +
    '\nreturn { decryptLockCode,' +
    '  db: (on) => { matchRecordsCollection = on ? RECORDS : null; leaguesCollection = on ? LEAGUES : null; matchLocksCollection = on ? STORE : null; },' +
    '  hold: () => { let go; ready = new Promise(r => { go = r; }); return () => { ready = Promise.resolve(); go(); }; } };')(
    app, io, crypto, new Function('return ' + H.grab('safeMatchId'))(), requireAuthorizedCreator, requireOwner, ownerUidFrom, async () => {},
    records, leagues, store, writeMatchRecordSafely, () => false, () => {}, async () => null);
  async function call(method, url, { body, headers } = {}){
    const u = new URL(url, 'https://example.test');
    const r = routes.find(x => x.method === method && x.re.test(u.pathname));
    if(!r) return null;
    const m = r.re.exec(u.pathname);
    const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const hdrs = {}; Object.entries(headers || {}).forEach(([k, v]) => { hdrs[k.toLowerCase()] = v; });
    const req = { params, query: Object.fromEntries(u.searchParams), body: body || {}, headers: hdrs, ip: '1.1.1.1', get: (h) => hdrs[h.toLowerCase()] };
    const out = { status: 200, body: null };
    const res = { status(s){ out.status = s; return res; }, json(o){ out.body = JSON.parse(JSON.stringify(o)); return res; } };
    let i = 0;
    const next = async () => { const h = r.handlers[i++]; if(h) await h(req, res, next); };
    await next();
    return out;
  }
  return { api, call, records, leagues, store, emitted };
}

/* ------------------------------------------------------------------ */
/* The socket room: like io.on('connection') — the room's last state    */
/* first; updates merged and sent to everyone in the room. As on the   */
/* server, a panel's update that arrives before its connection has     */
/* been handled (the handlers are registered after the room's state is */
/* read — a cold room) is lost.                                        */
/* ------------------------------------------------------------------ */
function makeRooms(){
  const R = { rooms: {}, sockets: [] };
  R.io = (opts) => {
    const q = (opts && opts.query) || {};
    const s = { h: {}, sent: [], connected: false, ready: false, room: String(q.uid || q.room || 'default'), opts: JSON.parse(JSON.stringify(opts || {})),
      io: { opts: { query: { ...q } }, on(){} },
      on(ev, fn){ (this.h[ev] = this.h[ev] || []).push(fn); },
      emit(ev, p, ack){ this.sent.push({ ev, p }); R.receive(this, ev, p); if(typeof ack === 'function') ack({ ok: true }); },
      disconnect(){ this.connected = false; } };
    R.sockets.push(s);
    setTimeout(() => {
      s.connected = true;
      (s.h.connect || []).forEach(f => f());
      // the server answers the connection with the room's saved state
      setTimeout(() => { const st = R.rooms[s.room]; s.ready = true; if(st && s.connected) (s.h.liveCricketScore || []).forEach(f => f(JSON.parse(JSON.stringify(st)))); }, 3);
    }, 0);
    return s;
  };
  R.receive = (s, ev, p) => {
    if(!s.connected || !s.ready || (ev !== 'updateCricketScore' && ev !== 'liveCricketScore') || !p || typeof p !== 'object') return;
    R.rooms[s.room] = { ...(R.rooms[s.room] || {}), ...JSON.parse(JSON.stringify(p)) };
    const st = R.rooms[s.room];
    R.sockets.filter(x => x.connected && x.room === s.room).forEach(x => setTimeout(() => (x.h.liveCricketScore || []).forEach(f => f(JSON.parse(JSON.stringify(st)))), 1));
  };
  return R;
}

/* ------------------------------------------------------------------ */
/* The world both laptops talk to                                      */
/* ------------------------------------------------------------------ */
function makeWorld(){
  const S = makeServer();
  const R = makeRooms();
  const W = { S, R, posts: [], fail: null, teams: [
    { teamId: 't_dyp', name: 'D Y Patil', short: 'DYP', color: '#0ea5e9', logoUrl: '', players: [{ id: 'gp_rahul', name: 'Rahul', isXI: true }, { id: 'gp_sam', name: 'Sam', isXI: true }], captainId: 'gp_rahul', wkId: null },
    { teamId: 't_lio', name: 'Lions', short: 'LIO', color: '#ff0000', logoUrl: '', players: [{ id: 'gp_amit', name: 'Amit', isXI: true }], captainId: null, wkId: null }] };
  W.fetch = async (url, opts) => {
    url = String(url);
    const method = (opts && opts.method) || 'GET';
    let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch(e) {}
    const headers = (opts && opts.headers) || {};
    const json = (o, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => JSON.parse(JSON.stringify(o)) });
    if(W.offline) throw new Error('offline');
    if(/\/api\/league\/[^/?]+\/match(\?|$)/.test(url) && method === 'POST'){
      W.posts.push({ body, key: headers['X-Match-Key'] || null });
      if(W.fail){ const f = W.fail; W.fail = null; return { ok: false, status: f, json: async () => { throw new Error('not json'); } }; }
    }
    if(/\/api\/league\/[^/?]+\/live-status/.test(url)) return json({ success: true });
    if(/\/api\/(match-lock|leagues|league\/)/.test(url)){
      const r = await S.call(method, url, { body, headers });
      if(r) return json(r.body, r.status);
      return json({ success: true });
    }
    const rs = /\/api\/cricket\/room-state\/([^?]+)/.exec(url);
    if(rs){ const st = R.rooms[decodeURIComponent(rs[1])]; return st ? json({ success: true, state: st }) : json({ success: false }, 404); }
    if(/\/api\/players\/canonicalize/.test(url)) return json({ success: true, map: {} });
    if(/\/api\/players\/resolve/.test(url)) return json({ success: true, playerId: 'gp_' + String(body.name).toLowerCase() });
    if(/\/api\/teams(\?|$)/.test(url) && method === 'GET') return json({ success: true, teams: W.teams });
    if(/\/api\/teams(\?|$)/.test(url)) return json({ success: true, team: body.team });
    return json({ success: false }, 404);
  };
  return W;
}
function bootPanel(file, W, { device, uid = 'U1', storage } = {}){
  let html = fs.readFileSync(path.join(PANEL_DIR, file), 'utf8').replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole(); const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel' + (uid ? '?uid=' + uid : ''), virtualConsole: vc,
    beforeParse(w){
      if(storage) Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
      if(device) w.localStorage.setItem('asl-device-id', device);
      w.io = W.R.io;
      w.fetch = W.fetch;
      w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.HTMLMediaElement.prototype.play = () => Promise.resolve(); w.HTMLMediaElement.prototype.pause = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
      w.scrollTo = () => {};
      w.open = () => {};
    }
  });
  const w = dom.window;
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  const E = (c) => w.eval(c);
  E(`(function(){ const t = toast; window.__toasts = []; toast = function(m){ window.__toasts.push(String(m)); try{ return t.apply(this, arguments); }catch(e){} }; })()`);
  return { w, E, errors, file, $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)],
    storage: () => { const o = {}; for(let i = 0; i < w.localStorage.length; i++){ const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
    lastToast: () => w.__toasts.slice(-1)[0] || '' };
}
const click = (P, el) => el.dispatchEvent(new P.w.Event('click', { bubbles: true }));
const typeIn = (P, el, v) => { el.value = v; el.dispatchEvent(new P.w.Event('input', { bubbles: true })); };
const dlg = (P) => P.$('#ml-overlay').classList.contains('show');
// the operator switches to Tournament and picks it in the dropdown (as on a fresh laptop)
async function pickTournament(P, name){
  click(P, P.$('#mode-tournament-btn'));
  await P.E('syncKnownTournamentsFromServer()');
  const sel = P.$('#tournament-select');
  sel.value = name;
  sel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  await until(() => P.E(`(leagueCache[leagueStorageKey(${JSON.stringify(name)})] || []).length > 0`), 1500);
}
// 📋 Matches, as the operator opens it: which fixtures show ▶ Start
async function openMatches(P){
  const list = P.$('#league-matches-list');
  if(list.style.display !== 'none') list.style.display = 'none';
  P.E('leagueListRefreshAt = 0');
  click(P, P.$('#view-league-matches-btn'));
  await sleep(60);
  return P.$$('#league-matches-list [data-start-upcoming]').map(b => b.getAttribute('data-start-upcoming'));
}
// Laptop A schedules a fixture through the Upcoming Match screen
async function schedule(P, { lock } = {}){
  click(P, P.$('#schedule-match-btn'));
  await until(() => P.$('#um-overlay').classList.contains('show'));
  click(P, P.$('[data-um-pick="A"]')); click(P, P.$('[data-um-select="d y patil"]'));
  click(P, P.$('[data-um-pick="B"]')); click(P, P.$('[data-um-select="lions"]'));
  if(lock){
    P.$('#um-lock').checked = true; P.$('#um-lock').dispatchEvent(new P.w.Event('change'));
    typeIn(P, P.$('#um-lock-code'), lock); typeIn(P, P.$('#um-lock-code2'), lock);
  }
  click(P, P.$('#um-save'));
  await until(() => P.$('[data-um-force]') || !P.$('#um-overlay').classList.contains('show') || P.$('#um-msg').textContent);
  if(P.$('[data-um-force]')){ click(P, P.$('[data-um-force]')); await until(() => !P.$('#um-overlay').classList.contains('show') || P.$('#um-msg').textContent); }
  if(dlg(P)) click(P, P.$('#ml-done')); // the new code was shown
}
const upcoming = (W) => W.S.records.docs.filter(r => r.upcoming === true);
const recOf = (W, matchId) => W.S.records.docs.find(r => r.matchId === matchId);

async function suite(fileA, fileB){
  const L = (s) => `${fileA === fileB ? fileA : fileA + ' → ' + fileB}: ${s}`;
  console.log(`\n######## Laptop A = ${fileA}, Laptop B = ${fileB} ########`);
  const W = makeWorld();
  const A = bootPanel(fileA, W, { device: 'dv-laptopA' });
  await sleep(1400); // connected, first state up
  A.E(`state.leagueName = 'Test Cup'; state.matchMode = 'tournament'; addKnownTournament('Test Cup'); saveLocal(); syncBrowsingControls();`);

  console.log('\n=== Laptop A schedules an (unlocked) Upcoming Match ===');
  await schedule(A);
  const fx = JSON.parse(JSON.stringify(upcoming(W)[0])); // (as A has it on screen)
  eq(L('saved on the server: upcoming, under the account and the tournament'), [!!fx, fx && fx.ownerUid, fx && fx.leagueKey, fx && !!fx.roomId], [true, 'U1', 'test cup', true]);
  eq(L('announced only after the server saved it'), /scheduled/.test(A.lastToast()), true);

  console.log('\n=== Laptop B, same account, opens the panel at the ground ===');
  const B = bootPanel(fileB, W, { device: 'dv-laptopB' });
  await sleep(1400);
  const roomB = B.E('currentMatchId()');
  // anything the operator does on B sends B's state to its room — here
  // before the tournament is chosen (the room keeps that copy)
  B.E('pushState(true, true)'); await sleep(60);
  eq(L('B\'s room holds B\'s state from before the tournament was chosen'), [!!W.R.rooms[roomB], W.R.rooms[roomB] && W.R.rooms[roomB].leagueName], [true, '']);
  await pickTournament(B, 'Test Cup');
  eq(L('B picks the tournament: the fixture is there, with ▶ Start'), await openMatches(B), [fx.matchId]);

  B.E('connect()'); // the ground's Wi-Fi drops and comes back
  await sleep(250);
  eq(L('after a reconnect B still looks at the tournament (the room\'s old copy did not replace it)'), [B.E('state.leagueName'), B.E('state.matchMode'), B.$('#tournament-select').value], ['Test Cup', 'tournament', 'Test Cup']);
  eq(L('…and ▶ Start is still there'), await openMatches(B), [fx.matchId]);

  const B2 = bootPanel(fileB, W, { device: 'dv-laptopB', storage: B.storage() }); // refresh the page
  B.E('socket.disconnect()');
  await sleep(1400);
  eq(L('after a refresh: same room, same tournament'), [B2.E('currentMatchId()'), B2.E('state.leagueName'), B2.$('#tournament-select').value], [roomB, 'Test Cup', 'Test Cup']);
  eq(L('after a refresh: the fixture and its ▶ Start'), await openMatches(B2), [fx.matchId]);

  console.log('\n=== ▶ Start on Laptop B ===');
  const nRecords = W.S.records.docs.length;
  click(B2, B2.$(`#league-matches-list [data-start-upcoming="${fx.matchId}"]`));
  await until(() => B2.E('currentMatchId()') === fx.roomId);
  await sleep(150);
  const started = recOf(W, fx.matchId);
  eq(L('the panel is on the fixture\'s own match: same matchId, its room'), [B2.E('state.tournamentMatchId'), B2.E('currentMatchId()'), B2.E('state.matchLeague')], [fx.matchId, fx.roomId, 'Test Cup']);
  eq(L('server: the same record started (no copy), by laptop B'), [W.S.records.docs.length, started.upcoming, started.startedBy && started.startedBy.deviceId, W.S.records.docs.filter(r => r.matchId === fx.matchId).length], [nRecords, false, 'dv-laptopB', 1]);
  eq(L('the teams and squads came from the fixture (player ids kept)'), [B2.E('state.teamA.name'), B2.E('state.teamB.name'), B2.E('state.teamA.players.map(p => p.id).join()')], ['D Y Patil', 'Lions', 'gp_rahul,gp_sam']);
  eq(L('the started match is saved under its matchId, no longer upcoming'), W.posts.filter(p => p.body.matchId === fx.matchId).slice(-1)[0].body.upcoming, false);

  console.log('\n=== Laptop A, with its old list ===');
  const aRoom = A.E('currentMatchId()');
  eq(L('A\'s list still shows ▶ Start (not refreshed yet)'), A.$$(`#league-matches-list [data-start-upcoming="${fx.matchId}"]`).length + (await A.E(`isUpcomingMatch(currentLeagueMatchesAll().find(m => m.matchId === ${JSON.stringify(fx.matchId)}))`) ? 1 : 0) >= 1, true);
  await A.E(`startUpcomingMatch(currentLeagueMatchesAll().find(m => m.matchId === ${JSON.stringify(fx.matchId)}), null, 'Test Cup')`);
  eq(L('A pressing ▶ Start: told it has started, A\'s panel unchanged'), [/already been started on another laptop/.test(A.lastToast()), A.E('currentMatchId()'), A.E('state.tournamentMatchId') === fx.matchId], [true, aRoom, false]);
  eq(L('server record untouched by A'), [recOf(W, fx.matchId).startedBy.deviceId, W.S.records.docs.length], ['dv-laptopB', nRecords]);
  eq(L('A\'s 📋 Matches, refreshed: no ▶ Start for it any more'), await openMatches(A), []);
  // A edits the old fixture it still had on screen → refused, nothing wiped
  const scoreBefore = JSON.stringify(recOf(W, fx.matchId));
  const r409 = await W.S.call('POST', '/api/league/Test%20Cup/match?uid=U1', { body: { ...fx, venue: 'Changed', scoreA: { runs: 0, wickets: 0, overs: '0.0' } } });
  eq(L('server: a fixture written over the started match is refused (409), record unchanged'), [r409.status, r409.body.code, JSON.stringify(recOf(W, fx.matchId)) === scoreBefore], [409, 'ALREADY_STARTED', true]);

  console.log('\n=== Both laptops press ▶ Start together ===');
  await schedule(A);
  const fy = upcoming(W).find(r => r.matchId !== fx.matchId);
  await openMatches(A); await openMatches(B2);
  const roomA0 = A.E('currentMatchId()'), roomB0 = B2.E('currentMatchId()');
  const n2 = W.S.records.docs.length;
  await Promise.all([
    A.E(`startUpcomingMatch(currentLeagueMatchesAll().find(m => m.matchId === ${JSON.stringify(fy.matchId)}), null, 'Test Cup')`),
    B2.E(`startUpcomingMatch(currentLeagueMatchesAll().find(m => m.matchId === ${JSON.stringify(fy.matchId)}), null, 'Test Cup')`)
  ]);
  await sleep(150);
  const onA = A.E('state.tournamentMatchId') === fy.matchId, onB = B2.E('state.tournamentMatchId') === fy.matchId;
  const winner = recOf(W, fy.matchId).startedBy.deviceId;
  eq(L('exactly ONE laptop started it'), [onA !== onB, winner === (onA ? 'dv-laptopA' : 'dv-laptopB')], [true, true]);
  const loser = onA ? B2 : A;
  eq(L('the other one was told, and its panel did not change'), [/already been started/.test(loser.lastToast()), loser.E('currentMatchId()') === (onA ? roomB0 : roomA0)], [true, true]);
  eq(L('one record, no copies'), [W.S.records.docs.length, W.S.records.docs.filter(r => r.matchId === fy.matchId).length], [n2, 1]);

  console.log('\n=== A fixture removed on another laptop ===');
  await schedule(A);
  const fr = JSON.parse(JSON.stringify(upcoming(W).find(r => r.matchId !== fx.matchId && r.matchId !== fy.matchId)));
  W.S.records.docs.splice(W.S.records.docs.findIndex(r => r.matchId === fr.matchId), 1); // 🗑 on Laptop A
  const bRoomNow = B2.E('currentMatchId()');
  B2.w.confirm = (m) => { B2.w.__asked = String(m); return !/not on the server/.test(m); };
  await B2.E(`startUpcomingMatch(${JSON.stringify(fr)}, null, 'Test Cup')`);
  eq(L('▶ Start on it from an old list: asked first; "no" → nothing started, nothing re-created'), [/not on the server/.test(B2.w.__asked || ''), B2.E('currentMatchId()') === bRoomNow, !!recOf(W, fr.matchId)], [true, true, false]);
  B2.w.confirm = () => true;

  console.log('\n=== A LOCKED Upcoming Match ===');
  await schedule(A, { lock: 'FINAL26' });
  const fz = upcoming(W).find(r => r.locked);
  const lockDoc = W.S.store.docs.find(d => fz && d.roomId === fz.roomId);
  eq(L('saved locked, its lock on the server'), [!!fz, !!lockDoc, lockDoc && W.S.api.decryptLockCode(lockDoc.codeEnc)], [true, true, 'FINAL26']);
  const C = bootPanel(fileB, W, { device: 'dv-laptopC' }); // a third laptop, same account
  await sleep(1400);
  await pickTournament(C, 'Test Cup');
  eq(L('C sees the locked fixture with ▶ Start (🔒)'), (await openMatches(C)).includes(fz.matchId), true);
  const cRoom = C.E('currentMatchId()');
  C.E(`window.__s = startUpcomingMatch(currentLeagueMatchesAll().find(m => m.matchId === ${JSON.stringify(fz.matchId)}), null, 'Test Cup')`);
  await until(() => dlg(C));
  eq(L('locked: the code is asked'), dlg(C), true);
  typeIn(C, C.$('#ml-input'), 'WRONG99');
  click(C, C.$('#ml-go'));
  await until(() => C.$('#ml-err').textContent);
  eq(L('a wrong code is refused; nothing started'), [C.$('#ml-err').textContent, recOf(W, fz.matchId).upcoming, C.E('currentMatchId()')], ['Wrong code for this match', true, cRoom]);
  click(C, C.$('#ml-alt')); await C.E('window.__s');
  C.E(`window.__s = startUpcomingMatch(currentLeagueMatchesAll().find(m => m.matchId === ${JSON.stringify(fz.matchId)}), null, 'Test Cup')`);
  await until(() => dlg(C));
  typeIn(C, C.$('#ml-input'), 'final26');
  click(C, C.$('#ml-go'));
  await until(() => C.E('currentMatchId()') === fz.roomId);
  await C.E('window.__s'); await sleep(120);
  eq(L('the right code starts it on C, under its matchId and room'), [C.E('state.tournamentMatchId'), C.E('currentMatchId()'), recOf(W, fz.matchId).upcoming, recOf(W, fz.matchId).startedBy.deviceId], [fz.matchId, fz.roomId, false, 'dv-laptopC']);
  eq(L('C holds the key (server)'), W.S.store.docs.find(d => d.roomId === fz.roomId).holder.deviceId, 'dv-laptopC');
  // A's stale list: told it started BEFORE any code is asked — the key stays with C
  await A.E(`startUpcomingMatch(currentLeagueMatchesAll().find(m => m.matchId === ${JSON.stringify(fz.matchId)}) || ${JSON.stringify(fz)}, null, 'Test Cup')`);
  eq(L('A on the started locked match: told, no code asked, C keeps the key'), [/already been started/.test(A.lastToast()), dlg(A), W.S.store.docs.find(d => d.roomId === fz.roomId).holder.deviceId], [true, false, 'dv-laptopC']);
  const keyless = await W.S.call('POST', `/api/league/Test%20Cup/match/${fz.matchId}/start?uid=U1`, { body: { deviceId: 'dv-laptopC' } });
  eq(L('server: the started-here answer for a locked match still needs its key'), [keyless.status, keyless.body.code], [423, 'MATCH_LOCKED']);

  console.log('\n=== Other accounts ===');
  const other = await W.S.call('GET', '/api/league/Test%20Cup?uid=U2');
  eq(L('another authorised account sees none of U1\'s matches'), [other.status, other.body.matches.length], [200, 0]);
  await schedule(A);
  const fw = upcoming(W).find(r => !r.locked && r.matchId !== fx.matchId && r.matchId !== fy.matchId);
  const cross = await W.S.call('POST', `/api/league/Test%20Cup/match/${fw.matchId}/start?uid=U2`, { body: { deviceId: 'dv-x' } });
  const stranger = await W.S.call('POST', `/api/league/Test%20Cup/match/${fw.matchId}/start?uid=EVIL`, { body: { deviceId: 'dv-x' } });
  const nobody = await W.S.call('POST', `/api/league/Test%20Cup/match/${fw.matchId}/start`, { body: { deviceId: 'dv-x' } });
  eq(L('server: U2 cannot start U1\'s match (not found under U2), an unauthorised or missing account is refused'), [cross.status, stranger.status, nobody.status, recOf(W, fw.matchId).upcoming], [404, 403, 401, true]);
  const Z = bootPanel(fileB, W, { device: 'dv-z', uid: 'EVIL' });
  await sleep(1400);
  Z.E(`state.leagueName = 'Test Cup'; state.matchMode = 'tournament'; saveLocal();`);
  await Z.E(`startUpcomingMatch(${JSON.stringify(fw)}, null, 'Test Cup')`);
  eq(L('panel on an unauthorised account: refused with the reason, nothing started'), [/cannot start tournament matches/.test(Z.lastToast()), recOf(W, fw.matchId).upcoming, Z.E('state.tournamentMatchId') === fw.matchId], [true, true, false]);

  console.log('\n=== The server starting up (a cold start) ===');
  const before = B2.E(`(leagueCache[leagueStorageKey('Test Cup')] || []).length`);
  W.S.api.db(false);
  const cold = await W.S.call('GET', '/api/league/Test%20Cup?uid=U1');
  eq(L('server: no database yet → 503, not an empty list'), [cold.status, cold.body.success, cold.body.matches], [503, false, undefined]);
  await B2.E(`syncLeagueFromServer('Test Cup')`);
  eq(L('B keeps its list (not wiped) and says why'), [B2.E(`(leagueCache[leagueStorageKey('Test Cup')] || []).length`), /starting up/.test(B2.E(`leagueSyncNote[leagueStorageKey('Test Cup')]`))], [before, true]);
  const lockCold = await W.S.call('GET', `/api/match-lock/${fz.roomId}`);
  eq(L('server: lock store not there yet → 503, never "not locked"'), [lockCold.status, lockCold.body.locked], [503, undefined]);
  const go = W.S.api.hold(); W.S.api.db(true);
  setTimeout(go, 200); // connected a moment later
  const t0 = Date.now();
  const waited = await W.S.call('GET', '/api/league/Test%20Cup?uid=U1');
  eq(L('a request during start-up waits for the database, then answers with the real list'), [waited.status, waited.body.matches.length > 0, Date.now() - t0 >= 150], [200, true, true]);
  await until(() => !B2.E(`leagueSyncNote[leagueStorageKey('Test Cup')]`), 4500);
  eq(L('B refreshes by itself once the server is up'), B2.E(`leagueSyncNote[leagueStorageKey('Test Cup')]`), '');

  console.log('\n=== A save the server refuses (Laptop A) ===');
  const nUp = upcoming(W).length, nToasts = A.w.__toasts.length;
  W.fail = 413;
  click(A, A.$('#schedule-match-btn'));
  await until(() => A.$('#um-overlay').classList.contains('show'));
  click(A, A.$('[data-um-pick="A"]')); click(A, A.$('[data-um-select="d y patil"]'));
  click(A, A.$('[data-um-pick="B"]')); click(A, A.$('[data-um-select="lions"]'));
  A.$('#um-lock').checked = true; A.$('#um-lock').dispatchEvent(new A.w.Event('change'));
  typeIn(A, A.$('#um-lock-code'), 'SEMI2026'.slice(0, 7)); typeIn(A, A.$('#um-lock-code2'), 'SEMI2026'.slice(0, 7));
  click(A, A.$('#um-save'));
  await until(() => A.$('[data-um-force]') || /Too large/.test(A.$('#um-msg').textContent));
  if(A.$('[data-um-force]')){ W.fail = 413; click(A, A.$('[data-um-force]')); }
  await until(() => /Too large/.test(A.$('#um-msg').textContent));
  const draft = A.E('umDraft');
  eq(L('refused (413): the screen stays open and says why; nothing announced'), [A.$('#um-overlay').classList.contains('show'), A.$('#um-msg').textContent, A.w.__toasts.slice(nToasts).some(t => /scheduled/.test(t))],
    [true, '⚠️ Too large to save — use smaller team logos, then save again.', false]);
  eq(L('…and no fixture left that only A can see'), [upcoming(W).length, A.E(`currentLeagueMatchesAll().some(m => m.matchId === ${JSON.stringify(draft.matchId)})`)], [nUp, false]);
  click(A, A.$('#um-save'));
  await until(() => !A.$('#um-overlay').classList.contains('show'));
  if(dlg(A)) click(A, A.$('#ml-done'));
  const saved = recOf(W, draft.matchId);
  eq(L('saving again saves the SAME match: same ids, locked with the same code, one lock'), [!!saved, saved && saved.roomId === draft.roomId, saved && saved.locked, W.S.store.docs.filter(d => d.roomId === draft.roomId).length, W.S.api.decryptLockCode(W.S.store.docs.find(d => d.roomId === draft.roomId).codeEnc)], [true, true, true, 1, 'SEMI202']);

  eq(L('no script errors'), [A, B, B2, C, Z].map(P => P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e))), [[], [], [], [], []]);
  [A, B, B2, C, Z].forEach(P => { try{ P.E('socket && socket.disconnect()'); }catch(e){} P.w.close(); });
}

(async () => {
  await suite('cricket-panel.html', 'cricket-panel.html');
  await suite('cricket-panel3.html', 'cricket-panel3.html');
  await suite('cricket-panel.html', 'cricket-panel3.html');
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
