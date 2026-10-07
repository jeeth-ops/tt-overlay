// 🔒 Match lock codes — the REAL server code (MATCH LOCK CODES block of
// server.js, the socket gate and the REST checks, extracted by text, never
// copied) and BOTH real panels (cricket-panel.html = Clipper,
// cricket-panel3.html = Stream Engine) in jsdom, talking to it:
//   • the operator picks the code (6-7 letters AND numbers, typed twice);
//     codes are unique; without one the server makes a 7-character code
//   • lock is the operator's choice (Schedule Upcoming Match / Create New Match)
//   • ▶ Start / ▶ Resume on a locked match asks for the code; wrong → refused
//   • one laptop at a time: entering the code moves scoring, the other laptop
//     is stopped by the server and shows "moved to another laptop"
//   • balls scored on the laptop that lost the match wait, then go once the
//     code is entered again
//   • wrong-code limit; owner (admin) can read / remove a lock
//   • matches without a code are unchanged
//   • the tournament page shows the codes to the owner (chhayajeeth@gmail.com)
//     and to nobody else
//
//   node test/cricket/match-lock-test.js
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
const src = H.src;
const between = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if(i < 0 || j < 0) throw new Error('marker not found: ' + a); return src.slice(i, j); };

/* ------------------------------------------------------------------ */
/* The real server pieces, on an in-memory lock store                  */
/* ------------------------------------------------------------------ */
const LOCK_BLOCK = between('const MATCH_LOCK_ALPHABET', "// 🏆 Create / edit a tournament");
const SOCKET_GATE = between('    const lockRoomFallback = ', '    const roomState = await getRoomState(currentRoom);');
const SAVE_CHECK = between('        // 🔒 A locked match is saved only by the laptop scoring it', '        // 🩹 CLIPS FIX');

function lockStore(){
  const c = H.coll([]);
  const insert = c.insertOne;
  // the unique indexes (roomId, codeHmac)
  c.insertOne = async (doc) => {
    if(c.docs.some(d => d.roomId === doc.roomId || d.codeHmac === doc.codeHmac)){ const e = new Error('dup'); e.code = 11000; throw e; }
    return insert(doc);
  };
  return c;
}
function makeServer(){
  const routes = [];
  const add = (method) => (p, ...handlers) => routes.push({ method, p, re: new RegExp('^' + p.replace(/:[a-zA-Z]+/g, '([^/]+)') + '$'), keys: (p.match(/:[a-zA-Z]+/g) || []).map(k => k.slice(1)), handlers });
  const app = { get: add('GET'), post: add('POST'), delete: add('DELETE') };
  const emitted = [];
  const io = { to: (room) => ({ emit: (ev, d) => emitted.push({ room, ev, d }) }) };
  const audits = [];
  const records = H.coll([]);
  const requireAuthorizedCreator = (req, res, next) => req.query.uid ? (req.creatorEmail = req.query.uid + '@x.test', next()) : res.status(401).json({ success: false });
  const requireOwner = (req, res, next) => req.headers.authorization === 'Bearer OWNER' ? (req.ownerEmail = 'owner@x.test', next()) : res.status(403).json({ success: false });
  const ownerUidFrom = (req) => req.query.uid || null;
  const store = lockStore();
  const api = new Function('app', 'io', 'crypto', 'safeMatchId', 'requireAuthorizedCreator', 'requireOwner', 'ownerUidFrom', 'matchRecordsCollection', 'logAuditAction', 'STORE',
    'let matchLocksCollection = STORE; let matchLockSecret = "test-secret-for-match-locks-0123456789";\n' + LOCK_BLOCK +
    '\nreturn { cacheMatchLock, genMatchLockCode, normMatchLockCode, matchLockHmac, getMatchLock, matchLockForRecord, lockTokenMatches, lockTargetRoomId, MATCH_LOCKED_EVENTS, matchLockCache, decryptLockCode, matchLockTries,' +
    ' dbDown: (on) => { matchLocksCollection = on ? { findOne: async () => { throw new Error("db down"); } } : STORE; } };')(
    app, io, crypto, new Function('return ' + H.grab('safeMatchId'))(), requireAuthorizedCreator, requireOwner, ownerUidFrom, records,
    async (...a) => audits.push(a), store);

  // one HTTP call through the real route handlers
  async function call(method, url, { body, headers, ip } = {}){
    const u = new URL(url, 'https://example.test');
    const r = routes.find(x => x.method === method && x.re.test(u.pathname));
    if(!r) return null;
    const m = r.re.exec(u.pathname);
    const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const hdrs = {}; Object.entries(headers || {}).forEach(([k, v]) => { hdrs[k.toLowerCase()] = v; });
    const req = { params, query: Object.fromEntries(u.searchParams), body: body || {}, headers: hdrs, ip: ip || '1.1.1.1', get: (h) => hdrs[h.toLowerCase()] };
    let out = { status: 200, body: null };
    const res = { status(s){ out.status = s; return res; }, json(o){ out.body = JSON.parse(JSON.stringify(o)); return res; } };
    let i = 0;
    const next = async () => { const h = r.handlers[i++]; if(h) await h(req, res, next); };
    await next();
    return out;
  }

  // the socket gate, exactly as server.js runs it on each connection
  function connectSocket({ room, lockToken }){
    const sock = { data: {}, h: {}, mw: [], out: [], delivered: [],
      on(ev, fn){ this.h[ev] = fn; }, use(fn){ this.mw.push(fn); }, emit(ev, d){ this.out.push({ ev, d }); } };
    const query = { room, lockToken };
    new Function('socket', 'query', 'cleanQueryRoom', 'cleanQueryUid', 'clientId', 'safeMatchId', 'getMatchLock', 'lockTokenMatches', 'lockTargetRoomId', 'MATCH_LOCKED_EVENTS', 'matchLocksCollection', SOCKET_GATE)(
      sock, query, room, '', 'cid', new Function('return ' + H.grab('safeMatchId'))(), api.getMatchLock, api.lockTokenMatches, api.lockTargetRoomId, api.MATCH_LOCKED_EVENTS, store);
    // a client event: through the middleware, then "the handler" (recorded)
    sock.send = (ev, data) => new Promise((resolve) => {
      let acked = null;
      const ack = (a) => { acked = a; };
      const packet = [ev, data, ack];
      if(ev === 'matchLockAuth'){ sock.h.matchLockAuth(data); return resolve('auth'); }
      sock.mw[0](packet, () => { sock.delivered.push(ev); resolve('delivered'); });
      setTimeout(() => resolve(acked ? acked : 'dropped'), 30);
    });
    return sock;
  }
  // the save route's lock check, with the stored record looked up as the route does
  async function saveCheck(record, key){
    const req = { get: (h) => h === 'x-match-key' ? key : undefined };
    let out = null;
    const res = { status(s){ out = { status: s }; return res; }, json(o){ out.body = o; return res; } };
    await new Function('req', 'res', 'record', 'ownerUid', 'leagueKey', 'matchRecordsCollection', 'matchLockForRecord', 'lockTokenMatches', 'safeMatchId', 'matchLocksCollection', 'cacheMatchLock',
      'return (async () => {\n' + SAVE_CHECK + '\n})();')(req, res, record, 'U1', 'cup', records, api.matchLockForRecord, api.lockTokenMatches, new Function('return ' + H.grab('safeMatchId'))(), store, api.cacheMatchLock);
    return out ? out.status : 'saved';
  }
  return { api, call, connectSocket, saveCheck, emitted, store, records, audits };
}

async function serverSuite(){
  console.log('\n######## SERVER — real MATCH LOCK CODES code ########');
  const S = makeServer();
  console.log('\n=== The code ===');
  const codes = Array.from({ length: 3000 }, () => S.api.genMatchLockCode());
  eq('SERVER: 7 characters, letters AND numbers, no 0/O/1/I/L', codes.every(c => /^[A-HJKMNP-Z2-9]{7}$/.test(c) && /[0-9]/.test(c) && /[A-Z]/.test(c)), true);
  eq('SERVER: 3000 codes, all different', new Set(codes).size, 3000);

  console.log('\n=== Lock a match ===');
  eq('SERVER: no account → refused', (await S.call('POST', '/api/match-lock', { body: { roomId: 'R1' } })).status, 401);
  const c1 = await S.call('POST', '/api/match-lock?uid=U1', { body: { roomId: 'R1', matchId: 'M1', deviceId: 'dvA', claim: true } });
  eq('SERVER: lock → code + key for this laptop', [c1.status, /^[A-Z0-9]{7}$/.test(c1.body.code), typeof c1.body.token, c1.body.token.length], [200, true, 'string', 48]);
  const doc = S.store.docs[0];
  eq('SERVER: code stored only as HMAC + encrypted copy, key only hashed', [JSON.stringify(doc).includes(c1.body.code), JSON.stringify(doc).includes(c1.body.token), S.api.decryptLockCode(doc.codeEnc) === c1.body.code], [false, false, true]);
  eq('SERVER: locking the same match again → 409, code unchanged', [(await S.call('POST', '/api/match-lock?uid=U1', { body: { roomId: 'R1' } })).status, S.store.docs.length], [409, 1]);
  const c2 = await S.call('POST', '/api/match-lock?uid=U1', { body: { roomId: 'R2', matchId: 'M2', claim: false } });
  eq('SERVER: a fixture lock has a code and no laptop yet', [c2.status, c2.body.token, S.store.docs[1].holder], [200, null, null]);

  console.log('\n=== The operator\'s own code ===');
  const own = await S.call('POST', '/api/match-lock?uid=U1', { body: { roomId: 'R3', matchId: 'M3', claim: true, code: 'mi24 win' } });
  eq('SERVER: own code (any case, spaces dropped) is used as typed', [own.status, own.body.code], [200, 'MI24WIN']);
  const own6 = await S.call('POST', '/api/match-lock?uid=U1', { body: { roomId: 'R4', code: 'ABC123' } });
  eq('SERVER: 6 characters is fine too', [own6.status, own6.body.code], [200, 'ABC123']);
  const badCodes = [];
  for(const c of ['ABCDEFG', '1234567', 'AB12', 'ABCD12345']) badCodes.push((await S.call('POST', '/api/match-lock?uid=U1', { body: { roomId: 'R5', code: c } })).body.code);
  eq('SERVER: letters only / numbers only / too short / too long → refused', badCodes, ['BAD_CODE', 'BAD_CODE', 'BAD_CODE', 'BAD_CODE']);
  const taken = await S.call('POST', '/api/match-lock?uid=U1', { body: { roomId: 'R5', code: 'MI24WIN' } });
  eq('SERVER: a code another match uses → 409 CODE_TAKEN, nothing locked', [taken.status, taken.body.code, S.store.docs.some(d => d.roomId === 'R5')], [409, 'CODE_TAKEN', false]);
  const c6 = await S.call('POST', '/api/match-lock/R4/claim', { body: { code: 'abc 123', deviceId: 'dvZ' }, ip: '9.9.9.9' });
  eq('SERVER: a 6-character code opens its match', c6.status, 200);
  const late = S.store.docs.find(d => d.roomId === 'R4');
  eq('SERVER: a match locked before its record learns its matchId on the first save', [late.matchId, await S.saveCheck({ matchId: 'M4', roomId: 'R4' }, c6.body.token), await sleep(5), S.store.docs.find(d => d.roomId === 'R4').matchId], [null, 'saved', undefined, 'M4']);
  S.store.docs.splice(S.store.docs.findIndex(d => d.roomId === 'R3'), 1); S.store.docs.splice(S.store.docs.findIndex(d => d.roomId === 'R4'), 1);
  S.api.matchLockCache.clear();

  console.log('\n=== Status + claim ===');
  const st = async (room, key) => (await S.call('GET', `/api/match-lock/${room}`, { headers: key ? { 'X-Match-Key': key } : {} })).body;
  eq('SERVER: status (holder / other laptop / unlocked room)', [await st('R1', c1.body.token), await st('R1'), await st('R9')],
    [{ success: true, locked: true, held: true, you: true }, { success: true, locked: true, held: true, you: false }, { success: true, locked: false, held: false, you: false }]);
  const bad = await S.call('POST', '/api/match-lock/R1/claim', { body: { code: 'AAAAAA2', deviceId: 'dvB' }, ip: '2.2.2.2' });
  eq('SERVER: wrong code → 403 WRONG_CODE, nothing changes', [bad.status, bad.body.code, S.store.docs[0].holder.deviceId], [403, 'WRONG_CODE', 'dvA']);
  const good = await S.call('POST', '/api/match-lock/R1/claim', { body: { code: c1.body.code.toLowerCase().replace(/(....)/, '$1 '), deviceId: 'dvB' }, ip: '2.2.2.2' });
  eq('SERVER: right code (any case / with a space) → new key, laptop B holds it', [good.status, typeof good.body.token, S.store.docs[0].holder.deviceId], [200, 'string', 'dvB']);
  eq('SERVER: laptop A is told the match moved', S.emitted.slice(-1)[0], { room: 'room-R1', ev: 'matchLockTaken', d: { roomId: 'R1', deviceId: 'dvB' } });
  eq('SERVER: A\'s old key no longer works, B\'s does', [(await st('R1', c1.body.token)).you, (await st('R1', good.body.token)).you], [false, true]);

  console.log('\n=== Wrong-code limit ===');
  let last = null;
  for(let i = 0; i < 6; i++) last = await S.call('POST', '/api/match-lock/R2/claim', { body: { code: 'ZZZZZZ9' }, ip: '3.3.3.3' });
  const blocked = await S.call('POST', '/api/match-lock/R2/claim', { body: { code: c2.body.code }, ip: '3.3.3.3' });
  eq('SERVER: 6 wrong codes → even the right one waits 10 minutes', [last.status, blocked.status, blocked.body.code], [403, 429, 'TOO_MANY']);
  const other = await S.call('POST', '/api/match-lock/R2/claim', { body: { code: c2.body.code }, ip: '4.4.4.4' });
  eq('SERVER: …another address is not affected', other.status, 200);

  console.log('\n=== Socket gate (every scoring write) ===');
  const keyB = good.body.token;
  const sA = S.connectSocket({ room: 'R1', lockToken: c1.body.token });   // the laptop that lost it
  const sB = S.connectSocket({ room: 'R1', lockToken: keyB });           // the laptop that has it
  const sX = S.connectSocket({ room: 'R1' });                            // no key
  eq('SERVER: holder\'s live score goes through', await sB.send('updateCricketScore', { teamA: {} }), 'delivered');
  eq('SERVER: no key → live score blocked (never reaches the room)', [await sX.send('updateCricketScore', { teamA: {} }), sX.delivered], [{ ok: false, retry: false, locked: true, error: 'match-locked' }, []]);
  eq('SERVER: …and that laptop is told', sX.out.map(o => o.ev), ['matchLockDenied']);
  eq('SERVER: old key → a ball is refused with locked:true (kept by the panel)', await sA.send('logBall', { matchId: 'R1', kind: '4' }), { ok: false, retry: false, locked: true, error: 'match-locked' });
  eq('SERVER: undo / shot / bowler fix / graphics blocked too', [await sA.send('undoBall', { matchId: 'R1' }), await sA.send('setBallShot', { matchId: 'R1' }), await sA.send('reassignBowler', { matchId: 'R1' }), await sA.send('cricketToss', {})].map(x => x === 'dropped' || (x && x.locked)), [true, true, true, true]);
  eq('SERVER: reading is never blocked (corrections list)', await sX.send('getCricketCorrections', {}), 'delivered');
  eq('SERVER: a write aimed at ANOTHER locked room is checked against that room', await sB.send('logBall', { matchId: 'R2' }), { ok: false, retry: false, locked: true, error: 'match-locked' });
  const sU = S.connectSocket({ room: 'OPEN1' });
  eq('SERVER: a match without a code — everything as before', [await sU.send('updateCricketScore', {}), await sU.send('logBall', { matchId: 'OPEN1' })], ['delivered', 'delivered']);
  await sX.send('matchLockAuth', { roomId: 'R1', token: keyB });
  eq('SERVER: a key sent after connecting (matchLockAuth) counts', await sX.send('updateCricketScore', {}), 'delivered');
  // order is kept: events go out in the order they came in
  const sO = S.connectSocket({ room: 'R1', lockToken: keyB });
  const order = [];
  sO.mw[0](['updateCricketScore', {}, null], () => order.push(1));
  sO.mw[0](['logBall', { matchId: 'R1' }, null], () => order.push(2));
  sO.mw[0](['updateCricketScore', {}, null], () => order.push(3));
  await sleep(30);
  eq('SERVER: checks never change the order of a panel\'s updates', order, [1, 2, 3]);
  S.api.matchLockCache.clear();
  S.api.dbDown(true);
  eq('SERVER: database hiccup, nothing cached → scoring is not stopped', await sB.send('updateCricketScore', {}), 'delivered');
  S.api.dbDown(false);

  console.log('\n=== REST: match record / delete / live-status ===');
  S.records.docs.push({ ownerUid: 'U1', leagueKey: 'cup', matchId: 'M2', roomId: 'R2', upcoming: true });
  eq('SERVER: saving a locked match without its key → 423', await S.saveCheck({ matchId: 'M1', roomId: 'R1', upcoming: false }), 423);
  eq('SERVER: …with the scoring laptop\'s key → saved', await S.saveCheck({ matchId: 'M1', roomId: 'R1' }, keyB), 'saved');
  eq('SERVER: a record found by matchId alone is still checked', await S.saveCheck({ matchId: 'M1' }), 423);
  eq('SERVER: editing a locked fixture not started yet → allowed', await S.saveCheck({ matchId: 'M2', roomId: 'R2', upcoming: true }), 'saved');
  eq('SERVER: …but never moved to another room', await S.saveCheck({ matchId: 'M2', roomId: 'R2b', upcoming: true }), 423);
  S.records.docs[0].upcoming = false;
  eq('SERVER: once started, "upcoming" in the body does not help', await S.saveCheck({ matchId: 'M2', roomId: 'R2', upcoming: true }), 423);
  eq('SERVER: an unlocked match saves as before', await S.saveCheck({ matchId: 'M9', roomId: 'R9' }), 'saved');
  const delRoute = src.slice(src.indexOf("app.delete('/api/league/:name/match/:matchId'"), src.indexOf("app.delete('/api/league/:name/match/:matchId'") + 2500);
  const liveRoute = src.slice(src.indexOf("app.post('/api/league/:name/live-status'"), src.indexOf("app.post('/api/league/:name/live-status'") + 4000);
  eq('SERVER: delete + live-status check the key too', [/matchLockForRecord[\s\S]*lockTokenMatches[\s\S]*423/.test(delRoute), /lockTokenMatches\(lock, req\.get\('x-match-key'\)\)\) return res\.status\(423\)/.test(liveRoute)], [true, true]);

  console.log('\n=== Remove a code ===');
  eq('SERVER: remove without the key → 403', (await S.call('DELETE', '/api/match-lock/R1')).status, 403);
  eq('SERVER: admin list → owner only', (await S.call('GET', '/api/admin/match-locks')).status, 403);
  const list = await S.call('GET', '/api/admin/match-locks', { headers: { Authorization: 'Bearer OWNER' } });
  eq('SERVER: owner sees each locked match with its code', list.body.locks.map(l => [l.roomId, l.code]).sort(), [['R1', c1.body.code], ['R2', c2.body.code]]);
  eq('SERVER: scoring laptop removes its code', [(await S.call('DELETE', '/api/match-lock/R1', { headers: { 'X-Match-Key': keyB } })).status, S.store.docs.map(d => d.roomId), S.emitted.slice(-1)[0].ev], [200, ['R2'], 'matchLockRemoved']);
  eq('SERVER: removed → no key needed any more', await sX.send('updateCricketScore', {}), 'delivered');
  eq('SERVER: owner removes a forgotten one (audited)', [(await S.call('DELETE', '/api/admin/match-locks/R2', { headers: { Authorization: 'Bearer OWNER' } })).status, S.store.docs.length, S.audits.length], [200, 0, 1]);
}

/* ------------------------------------------------------------------ */
/* Both panels against the real lock routes                            */
/* ------------------------------------------------------------------ */
function panelWorld(S){
  const W = { roomStates: {}, records: [], posts: [], deletes: [], live: [], teams: [{ teamId: 't_dyp', name: 'D Y Patil', short: 'DYP', color: '#0ea5e9', logoUrl: '',
    players: [{ id: 'gp_rahul', name: 'Rahul', isXI: true }, { id: 'gp_sam', name: 'Sam', isXI: true }], captainId: 'gp_rahul', wkId: null },
    { teamId: 't_lio', name: 'Lions', short: 'LIO', color: '#ff0000', logoUrl: '', players: [{ id: 'gp_amit', name: 'Amit', isXI: true }], captainId: null, wkId: null }] };
  W.fetch = async (url, opts) => {
    url = String(url);
    const method = (opts && opts.method) || 'GET';
    let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch(e) {}
    const headers = (opts && opts.headers) || {};
    const json = (o, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => JSON.parse(JSON.stringify(o)) });
    if(W.offline) throw new Error('offline');
    if(/\/api\/match-lock/.test(url)){
      const r = await S.call(method, url, { body, headers });
      return json(r.body, r.status);
    }
    const rs = /\/api\/cricket\/room-state\/([^?]+)/.exec(url);
    if(rs) return W.roomStates[decodeURIComponent(rs[1])] ? json({ success: true, state: W.roomStates[decodeURIComponent(rs[1])] }) : json({ success: false }, 404);
    if(/\/api\/players\/canonicalize/.test(url)) return json({ success: true, map: {} });
    if(/\/api\/players\/resolve/.test(url)) return json({ success: true, playerId: 'gp_' + String(body.name).toLowerCase() });
    if(/\/api\/teams(\?|$)/.test(url) && method === 'GET') return json({ success: true, teams: W.teams });
    if(/\/api\/teams(\?|$)/.test(url)) return json({ success: true, team: body.team });
    if(/\/api\/league\/[^/?]+\/live-status/.test(url)){ W.live.push({ body, key: headers['X-Match-Key'] || null }); return json({ success: true }); }
    if(/\/api\/league\/[^/?]+\/match\/[^/?]+/.test(url) && method === 'DELETE'){ W.deletes.push({ url, key: (headers || {})['X-Match-Key'] || null }); return json({ success: true, matches: W.records }); }
    if(/\/api\/league\/[^/?]+\/match(\?|$)/.test(url) && method === 'POST'){
      W.posts.push({ body, key: headers['X-Match-Key'] || null });
      const i = W.records.findIndex(r => r.matchId === body.matchId);
      if(i >= 0) W.records[i] = { ...W.records[i], ...body }; else W.records.push(body);
      return json({ success: true, matches: W.records });
    }
    if(/\/api\/league\/[^/?]+(\?|$)/.test(url) && method === 'GET') return json({ success: true, matches: W.records, completed: false });
    return json({ success: false }, 404);
  };
  return W;
}
function bootPanel(file, W, { device } = {}){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8').replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole(); const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const sockets = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?uid=U1', virtualConsole: vc,
    beforeParse(w){
      w.io = (opts) => {
        const s = { h: {}, sent: [], connected: true, opts: JSON.parse(JSON.stringify(opts || {})), ackWith: () => ({ ok: true }),
          io: { opts: { query: { ...((opts && opts.query) || {}) } }, on(){} },
          on(ev, fn){ this.h[ev] = fn; }, emit(ev, p, ack){ this.sent.push({ ev, p }); if(typeof ack === 'function') ack(this.ackWith(ev, p)); }, disconnect(){ this.connected = false; } };
        sockets.push(s);
        return s;
      };
      w.fetch = W.fetch;
      w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.HTMLMediaElement.prototype.play = () => Promise.resolve(); w.HTMLMediaElement.prototype.pause = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
      w.scrollTo = () => {};
      w.open = (u) => { w.__opened = u; };
      if(device) w.localStorage.setItem('asl-device-id', device);
    }
  });
  const w = dom.window;
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  const E = (c) => w.eval(c);
  E(`(function(){ const t = toast; window.__toasts = []; toast = function(m){ window.__toasts.push(String(m)); try{ return t.apply(this, arguments); }catch(e){} }; })()`);
  return { w, E, errors, sockets, sock: () => sockets[sockets.length - 1], $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)] };
}
const click = (P, el) => el.dispatchEvent(new P.w.Event('click', { bubbles: true }));
const typeIn = (P, el, v) => { el.value = v; el.dispatchEvent(new P.w.Event('input', { bubbles: true })); };
const dlg = (P) => ({ open: P.$('#ml-overlay').classList.contains('show'), title: P.$('#ml-title').textContent });
async function until(fn, ms = 1500){ const t0 = Date.now(); while(Date.now() - t0 < ms){ if(fn()) return true; await sleep(15); } return false; }

async function panelSuite(file){
  const L = (s) => `${file}: ${s}`;
  console.log(`\n######## ${file} ########`);
  const S = makeServer();
  const W = panelWorld(S);
  const A = bootPanel(file, W, { device: 'dv-laptopA' });
  await sleep(80);
  A.E(`state.leagueName = 'Test Cup'; state.matchMode = 'tournament'; state.matchLeague = 'Test Cup'; saveLocal();`);

  console.log('\n=== The choice is the operator\'s ===');
  eq(L('code dialog + both toggles are in the page'), [!!A.$('#ml-overlay'), !!A.$('#um-lock'), !!A.$('#newmatch-lock')], [true, true, true]);
  click(A, A.$('#schedule-match-btn'));
  await until(() => A.$('#um-overlay').classList.contains('show'));
  eq(L('Schedule: "Lock with a code" is OFF by default'), [A.$('#um-lock').checked, A.$('#um-lock').disabled], [false, false]);

  console.log('\n=== Schedule an Upcoming Match WITH a code ===');
  click(A, A.$('[data-um-pick="A"]')); click(A, A.$('[data-um-select="d y patil"]'));
  click(A, A.$('[data-um-pick="B"]')); click(A, A.$('[data-um-select="lions"]'));
  eq(L('code boxes hidden while the switch is off'), A.$('#um-lock-fields').hidden, true);
  A.$('#um-lock').checked = true; A.$('#um-lock').dispatchEvent(new A.w.Event('change'));
  eq(L('switch on → two code boxes appear'), [A.$('#um-lock-fields').hidden, !!A.$('#um-lock-code'), !!A.$('#um-lock-code2')], [false, true, true]);
  click(A, A.$('#um-save')); await sleep(30);
  eq(L('no code typed → not saved, asks for it'), [A.$('#um-msg').textContent, W.records.some(r => r.upcoming)], ['🔒 Type the code you want for this match', false]);
  typeIn(A, A.$('#um-lock-code'), 'finals');
  click(A, A.$('#um-save')); await sleep(30);
  eq(L('letters only → refused'), A.$('#um-msg').textContent, '🔒 Use letters AND numbers in the code (e.g. MI24WIN)');
  typeIn(A, A.$('#um-lock-code'), 'final-26');
  typeIn(A, A.$('#um-lock-code2'), 'FINAL27');
  eq(L('typing: upper case, letters/numbers only; mismatch shown live'), [A.$('#um-lock-code').value, A.$('#um-lock-hint').textContent, A.$('#um-lock-hint').className], ['FINAL26', 'The two codes are not the same — type the same code twice', 'ml-cf-hint bad']);
  click(A, A.$('#um-save')); await sleep(30);
  eq(L('two different codes → not saved'), [A.$('#um-msg').textContent, W.records.some(r => r.upcoming)], ['🔒 The two codes are not the same — type the same code twice', false]);
  typeIn(A, A.$('#um-lock-code2'), 'final26');
  eq(L('same code twice → ✓ Codes match'), [A.$('#um-lock-hint').textContent, A.$('#um-lock-hint').className], ['✓ Codes match — FINA L26', 'ml-cf-hint ok']);
  click(A, A.$('#um-save'));
  await until(() => dlg(A).open);
  const fx = W.records.find(r => r.upcoming);
  const fxLock = S.store.docs.find(d => fx && d.roomId === fx.roomId);
  eq(L('fixture saved, marked locked, lock made on the server first'), [!!fx, fx && fx.locked, !!fxLock, fxLock && fxLock.matchId === fx.matchId, fxLock && fxLock.holder], [true, true, true, true, null]);
  const fxCode = S.api.decryptLockCode(fxLock.codeEnc);
  eq(L('the server holds the operator\'s own code'), fxCode, 'FINAL26');
  eq(L('the code is shown, easy to read (XXXX XXX), with Copy / WhatsApp'), [dlg(A), A.$('#ml-code').textContent, A.$('#ml-show').hidden, A.$('#ml-entry').hidden],
    [{ open: true, title: 'Match code' }, fxCode.slice(0, 4) + ' ' + fxCode.slice(4), false, true]);
  eq(L('a fixture code has no "Remove" here (no laptop scores it yet)'), A.$('#ml-remove').hidden, true);
  click(A, A.$('#ml-share'));
  eq(L('WhatsApp share carries the code'), decodeURIComponent(A.w.__opened || '').includes(fxCode), true);
  click(A, A.$('#ml-done'));
  eq(L('Done closes it'), dlg(A).open, false);
  A.E(`refreshLeagueUI()`); await sleep(30);
  eq(L('📋 Matches: 🔒 on the fixture, and NO way to see the code again on this laptop'), [A.$$('.lm-lock').length >= 1, A.$$('[data-ml-code]').length], [true, 0]);
  eq(L('the code is not kept anywhere on the laptop'), Object.keys(A.w.localStorage).some(k => (A.w.localStorage.getItem(k) || '').includes(fxCode)), false);
  click(A, A.$('#schedule-match-btn'));
  await until(() => A.$('#um-overlay').classList.contains('show'));
  eq(L('the next new fixture starts with the lock OFF again, boxes empty'), [A.$('#um-lock').checked, A.$('#um-lock-fields').hidden, A.$('#um-lock-code').value], [false, true, '']);
  // the same code for another match → refused, nothing saved
  click(A, A.$('[data-um-pick="A"]')); click(A, A.$('[data-um-select="d y patil"]'));
  click(A, A.$('[data-um-pick="B"]')); click(A, A.$('[data-um-select="lions"]'));
  A.$('#um-lock').checked = true; A.$('#um-lock').dispatchEvent(new A.w.Event('change'));
  typeIn(A, A.$('#um-lock-code'), 'FINAL26'); typeIn(A, A.$('#um-lock-code2'), 'FINAL26');
  const nFx = W.records.length;
  click(A, A.$('#um-save'));
  await until(() => A.$('[data-um-force]'));
  click(A, A.$('[data-um-force]')); // same teams, same day — "Save anyway"
  await until(() => /already used/.test(A.$('#um-msg').textContent));
  eq(L('a code already used by another match → "choose a different code", not saved'), [A.$('#um-msg').textContent, W.records.length, A.$('#um-overlay').classList.contains('show')], ['🔒 This code is already used by another match — choose a different code', nFx, true]);
  A.E(`closeUpcomingModal()`);
  A.E(`openUpcomingModal(${JSON.stringify(fx)})`); await until(() => A.$('#um-overlay').classList.contains('show'));
  eq(L('editing a locked fixture: shown ON, cannot be turned off, code not asked again'), [A.$('#um-lock').checked, A.$('#um-lock').disabled, A.$('#um-lock-fields').hidden], [true, true, true]);
  A.E(`closeUpcomingModal()`);

  console.log('\n=== Another laptop (or the same Gmail elsewhere) ===');
  const B = bootPanel(file, W, { device: 'dv-laptopB' });
  await sleep(80);
  B.E(`state.leagueName = 'Test Cup'; state.matchMode = 'tournament'; saveLocal();`);
  const before = B.E('currentMatchId()');
  B.E(`window.__start = startUpcomingMatch(${JSON.stringify(fx)}, null, 'Test Cup')`);
  await until(() => dlg(B).open);
  eq(L('▶ Start on a locked match asks for the code'), [dlg(B), B.$('#ml-entry').hidden, B.$('#ml-alt').textContent], [{ open: true, title: 'Enter the match code' }, false, 'Cancel']);
  typeIn(B, B.$('#ml-input'), 'abc-12');
  eq(L('typing: letters/numbers only, upper case'), B.$('#ml-input').value, 'ABC12');
  click(B, B.$('#ml-go'));
  eq(L('too short → says so'), B.$('#ml-err').textContent, 'The code has 6 or 7 letters and numbers');
  typeIn(B, B.$('#ml-input'), fxCode === 'ZZZZ999' ? 'ZZZZ998' : 'ZZZZ999');
  click(B, B.$('#ml-go'));
  await until(() => B.$('#ml-err').textContent);
  eq(L('wrong code → refused, match not opened'), [B.$('#ml-err').textContent, B.E('currentMatchId()') === before], ['Wrong code for this match', true]);
  click(B, B.$('#ml-alt'));
  await sleep(40);
  eq(L('Cancel → nothing on the panel changed'), [dlg(B).open, B.E('currentMatchId()') === before], [false, true]);

  B.E(`window.__start = startUpcomingMatch(${JSON.stringify(fx)}, null, 'Test Cup')`);
  await until(() => dlg(B).open);
  typeIn(B, B.$('#ml-input'), fxCode.toLowerCase());
  click(B, B.$('#ml-go'));
  await until(() => B.E('currentMatchId()') === fx.roomId);
  await sleep(60);
  const keyB = B.E(`mlToken(${JSON.stringify(fx.roomId)})`);
  eq(L('right code → the match opens on this laptop'), [dlg(B).open, B.E('currentMatchId()'), B.E('state.matchLocked'), B.E('state.tournamentMatchId')], [false, fx.roomId, true, fx.matchId]);
  eq(L('this laptop now holds it (server)'), [S.store.docs.find(d => d.roomId === fx.roomId).holder.deviceId, typeof keyB, keyB.length], ['dv-laptopB', 'string', 48]);
  eq(L('the key goes with the live connection'), B.sock().opts.query, { uid: fx.roomId, lockToken: keyB });
  const startSave = W.posts.filter(p => p.body.matchId === fx.matchId).slice(-1)[0];
  eq(L('match record saves carry the key (and say locked)'), [startSave.key === keyB, startSave.body.locked], [true, true]);
  eq(L('real server accepts that save; without the key it would not'), [await S.saveCheck(startSave.body, keyB), await S.saveCheck(startSave.body)], ['saved', 423]);
  B.E(`pingTournamentLiveStatus(true)`); await sleep(900);
  eq(L('live-status ping carries the key'), W.live.slice(-1)[0].key === keyB, true);
  // reconnect → key in the handshake + matchLockAuth on connect
  B.sock().h.connect();
  eq(L('on (re)connect the key is sent again'), B.sock().sent.filter(x => x.ev === 'matchLockAuth').slice(-1)[0].p, { roomId: fx.roomId, token: keyB });

  console.log('\n=== One laptop at a time ===');
  // laptop A — the one that MADE the fixture — opens it: the code is asked all the same
  W.roomStates[fx.roomId] = JSON.parse(B.E('JSON.stringify(state)'));
  A.E(`window.__res = resumeSavedMatch(${JSON.stringify({ ...fx, upcoming: false })}, null, 'Test Cup')`);
  await until(() => dlg(A).open);
  eq(L('the laptop that made the match is asked for the code too'), [dlg(A), A.E('currentMatchId()') !== fx.roomId], [{ open: true, title: 'Enter the match code' }, true]);
  typeIn(A, A.$('#ml-input'), fxCode);
  click(A, A.$('#ml-go'));
  await until(() => A.E('currentMatchId()') === fx.roomId, 2500);
  await sleep(60);
  eq(L('laptop A (typed the code) moves scoring to itself'), [S.store.docs.find(d => d.roomId === fx.roomId).holder.deviceId, A.E('state.matchLocked')], ['dv-laptopA', true]);
  // the server tells B; B steps aside
  B.sock().h.matchLockTaken({ roomId: fx.roomId, deviceId: 'dv-laptopA' });
  eq(L('laptop B is told: match moved, its key is dropped'), [dlg(B), B.E(`mlToken(${JSON.stringify(fx.roomId)})`), B.$('#ml-alt').textContent], [{ open: true, title: 'This match moved to another laptop' }, '', 'Leave this match']);
  // B scores anyway (dialog open → shortcuts blocked; a queued ball is refused by the server)
  B.sock().ackWith = (ev) => ev === 'logBall' ? { ok: false, retry: false, locked: true, error: 'match-locked' } : { ok: true };
  B.E(`queueBallForDb({ matchId: currentMatchId(), kind: '4', innings: 1, over: 3, ballInOver: 2 })`);
  await sleep(20);
  eq(L('a ball the server refused is KEPT on this laptop, not retried'), [B.E('ballOutbox.length'), B.E(`mlLockedOut.has(${JSON.stringify(fx.roomId)})`)], [1, true]);
  const sentBefore = B.sock().sent.filter(x => x.ev === 'logBall').length;
  B.E(`flushBallOutbox()`);
  eq(L('…and waits (no resend loop)'), B.sock().sent.filter(x => x.ev === 'logBall').length, sentBefore);
  B.E(`mlRender()`);
  eq(L('the dialog says 1 ball is waiting'), /1 ball scored here has not reached the website/.test(B.$('#ml-sub').textContent), true);
  const kd = new B.w.KeyboardEvent('keydown', { key: '4', bubbles: true, cancelable: true });
  let reached = false; B.w.addEventListener('keydown', () => { reached = true; });
  B.w.document.body.dispatchEvent(kd);
  eq(L('scoring keys do nothing behind the dialog'), reached, false);
  // B takes it back with the code
  B.sock().ackWith = () => ({ ok: true });
  typeIn(B, B.$('#ml-input'), fxCode);
  click(B, B.$('#ml-go'));
  await until(() => !dlg(B).open);
  await sleep(30);
  eq(L('code entered again → laptop B scores again, the waiting ball is sent'), [S.store.docs.find(d => d.roomId === fx.roomId).holder.deviceId, B.E('ballOutbox.length'), B.E(`mlLockedOut.has(${JSON.stringify(fx.roomId)})`)], ['dv-laptopB', 0, false]);
  eq(L('…with its new key on the connection'), B.sock().sent.filter(x => x.ev === 'matchLockAuth').slice(-1)[0].p.token === B.E(`mlToken(${JSON.stringify(fx.roomId)})`), true);
  // B is scoring it (holds the key), switches away, then comes back: asked again
  W.roomStates[fx.roomId] = JSON.parse(B.E('JSON.stringify(state)'));
  B.E(`startFreshMatch()`);
  B.E(`window.__back = resumeSavedMatch(${JSON.stringify({ ...fx, upcoming: false })}, null, 'Test Cup')`);
  await until(() => dlg(B).open);
  eq(L('same laptop, same Gmail, even holding the match → code asked again on ▶ Resume'), [dlg(B), B.E('currentMatchId()') !== fx.roomId], [{ open: true, title: 'Enter the match code' }, true]);
  click(B, B.$('#ml-alt'));
  await sleep(40);
  eq(L('…Cancel → not opened'), [dlg(B).open, B.E('currentMatchId()') !== fx.roomId], [false, true]);
  B.E(`window.__back = resumeSavedMatch(${JSON.stringify({ ...fx, upcoming: false })}, null, 'Test Cup')`);
  await until(() => dlg(B).open);
  typeIn(B, B.$('#ml-input'), fxCode); click(B, B.$('#ml-go'));
  await until(() => B.E('currentMatchId()') === fx.roomId, 2500);
  eq(L('…right code → opened'), B.E('currentMatchId()'), fx.roomId);

  console.log('\n=== Server says locked on connect (page reload without a key) ===');
  const C = bootPanel(file, W, { device: 'dv-laptopC' });
  await sleep(80);
  C.$('#match-id').value = fx.roomId; C.E('connect()');
  C.sock().h.matchLockStatus({ roomId: fx.roomId, locked: true, you: false });
  eq(L('a locked match without its key → "This match is locked"'), dlg(C), { open: true, title: 'This match is locked' });
  click(C, C.$('#ml-alt'));
  await sleep(40);
  eq(L('"Leave this match" → a fresh blank match, the locked one untouched'), [dlg(C).open, C.E('currentMatchId()') !== fx.roomId], [false, true]);

  console.log('\n=== Create New Match ===');
  const D = bootPanel(file, W, { device: 'dv-laptopD' });
  await sleep(80);
  D.E(`state.leagueName = 'Test Cup'; state.matchMode = 'tournament'; saveLocal();`);
  await D.E('openNewMatchModal()');
  eq(L('Create New Match: "Lock with a code" OFF by default'), D.$('#newmatch-lock').checked, false);
  click(D, D.$('#newmatch-start'));
  await until(() => !D.$('#newmatch-modal-overlay').classList.contains('show'));
  await sleep(60);
  eq(L('left off → no code, no dialog, nothing locked (as before)'), [dlg(D).open, S.store.docs.some(d => d.roomId === D.E('currentMatchId()')), D.E('state.matchLocked')], [false, false, false]);
  await D.E('openNewMatchModal()');
  D.$('#newmatch-lock').checked = true; D.$('#newmatch-lock').dispatchEvent(new D.w.Event('change'));
  const roomBefore = D.E('currentMatchId()');
  typeIn(D, D.$('#newmatch-lock-code'), 'MI24WIN'); typeIn(D, D.$('#newmatch-lock-code2'), 'MI24WIM');
  click(D, D.$('#newmatch-start')); await sleep(40);
  eq(L('Create New Match: codes differ → stays open, nothing changed'), [D.$('#newmatch-modal-overlay').classList.contains('show'), D.$('#newmatch-lock-hint').textContent, D.E('currentMatchId()') === roomBefore], [true, 'The two codes are not the same — type the same code twice', true]);
  typeIn(D, D.$('#newmatch-lock-code2'), 'MI24WIN');
  click(D, D.$('#newmatch-start'));
  await until(() => dlg(D).open);
  const room = D.E('currentMatchId()');
  const dLock = S.store.docs.find(d => d.roomId === room);
  eq(L('turned on → new match locked, THIS laptop scores it'), [!!dLock, dLock && dLock.holder.deviceId, D.E('state.matchLocked'), D.E(`mlToken(${JSON.stringify(room)})`).length], [true, 'dv-laptopD', true, 48]);
  eq(L('its code (the one typed) is shown (with Remove code)'), [dlg(D), D.$('#ml-code').textContent.replace(' ', ''), S.api.decryptLockCode(dLock.codeEnc), D.$('#ml-remove').hidden], [{ open: true, title: 'Match code' }, 'MI24WIN', 'MI24WIN', false]);
  eq(L('the new match runs in the locked room from its first message'), [D.sock().opts.query.uid, D.sock().opts.query.lockToken === D.E(`mlToken(${JSON.stringify(room)})`)], [room, true]);
  D.sock().h.connect();
  eq(L('the key goes with the live connection'), D.sock().sent.filter(x => x.ev === 'matchLockAuth').slice(-1)[0].p, { roomId: room, token: D.E(`mlToken(${JSON.stringify(room)})`) });
  click(D, D.$('#ml-remove'));
  await until(() => !dlg(D).open);
  eq(L('Remove code → unlocked everywhere'), [S.store.docs.some(d => d.roomId === room), D.E('state.matchLocked')], [false, false]);
  // the code cannot be set (server down / taken) → nothing on the panel changes
  await D.E('openNewMatchModal()');
  D.$('#newmatch-lock').checked = true; D.$('#newmatch-lock').dispatchEvent(new D.w.Event('change'));
  typeIn(D, D.$('#newmatch-lock-code'), 'FINAL26'); typeIn(D, D.$('#newmatch-lock-code2'), 'FINAL26');
  const roomNow = D.E('currentMatchId()');
  click(D, D.$('#newmatch-start'));
  await until(() => D.w.__toasts.some(t => /nothing was changed/.test(t)));
  eq(L('code already used → said so, the panel did not change'), [D.$('#newmatch-lock-hint').textContent, D.E('currentMatchId()') === roomNow, D.$('#newmatch-modal-overlay').classList.contains('show')], ['This code is already used by another match — choose a different code', true, true]);
  D.E('closeNewMatchModal()');

  console.log('\n=== Unlocked matches unchanged ===');
  const open = { matchId: 'm-open', roomId: 'room-open', upcoming: true, scheduledDate: '2026-10-10', matchNo: 9, teamA: { name: 'D Y Patil' }, teamB: { name: 'Lions' }, squadA: { players: [] }, squadB: { players: [] } };
  const fetchesBefore = S.store.docs.length;
  D.E(`window.__s2 = startUpcomingMatch(${JSON.stringify(open)}, null, 'Test Cup')`);
  await until(() => D.E('currentMatchId()') === 'room-open', 2500);
  eq(L('▶ Start on a match without a code → no dialog, starts as before'), [dlg(D).open, D.E('currentMatchId()'), D.E('state.matchLocked'), S.store.docs.length], [false, 'room-open', false, fetchesBefore]);
  eq(L('no key header on its saves'), W.posts.filter(p => p.body.matchId === 'm-open').every(p => p.key === null), true);
  W.offline = true;
  eq(L('offline + a match not known to be locked → still opens'), await D.E(`mlEnsureAccess('room-x', 'X', { locked: false })`), true);
  eq(L('offline + a locked match → refused (code is checked online)'), await D.E(`mlEnsureAccess('room-y', 'Y', { locked: true })`), false);
  W.offline = false;

  for(const P of [A, B, C, D]) eq(L('no script errors'), P.errors.filter(e => !/getContext|Not implemented/.test(e)), []);
}

/* ------------------------------------------------------------------ */
/* Tournament page: the owner (and only the owner) sees the codes      */
/* ------------------------------------------------------------------ */
async function tournamentPageSuite(){
  console.log('\n######## TOURNAMENT PAGE — codes for the owner only ########');
  const S = makeServer();
  const live = await S.call('POST', '/api/match-lock?uid=U1', { body: { roomId: 'room-live', matchId: 'm-live', claim: true, code: 'MI24WIN' } });
  await S.call('POST', '/api/match-lock?uid=U1', { body: { roomId: 'room-up', matchId: 'm-up', code: 'ABC123' } });
  const blank = { scoreA: { runs: 0, wickets: 0, overs: '0.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' }, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } };
  const payload = { success: true, tournament: { name: 'Test Cup' }, pointsTable: [], leaderboards: { topRuns: [], topWickets: [] },
    matches: [
      { ...blank, matchId: 'm-live', roomId: 'room-live', matchNo: 1, teamA: { name: 'Mumbai', short: 'MUM' }, teamB: { name: 'Pune', short: 'PUN' }, scoreA: { runs: 40, wickets: 1, overs: '5.0' } },
      { ...blank, matchId: 'm-up', roomId: 'room-up', upcoming: true, matchNo: 2, scheduledDate: '2026-10-20', teamA: { name: 'Thane', short: 'THA' }, teamB: { name: 'Nashik', short: 'NAS' } },
      { ...blank, matchId: 'm-open', roomId: 'room-open', upcoming: true, matchNo: 3, scheduledDate: '2026-10-21', teamA: { name: 'Goa', short: 'GOA' }, teamB: { name: 'Surat', short: 'SUR' } }
    ],
    live: { roomId: 'room-live', matchId: 'm-live', matches: [{ roomId: 'room-live', matchId: 'm-live' }] } };
  async function open(email){
    let html = fs.readFileSync(path.join(__dirname, '..', '..', 'score-tournament.html'), 'utf8').replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
    const vc = new VirtualConsole(); const errors = []; const lockCalls = [];
    vc.on('jsdomError', e => errors.push(e.message));
    const user = email ? { email, getIdToken: async () => email === 'chhayajeeth@gmail.com' ? 'OWNER' : 'SOMEONE' } : null;
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/score/tournament/TOK', virtualConsole: vc,
      beforeParse(w){
        w.firebase = { initializeApp(){}, auth: () => ({ currentUser: user, onAuthStateChanged(cb){ setTimeout(() => cb(user), 0); } }) };
        w.fetch = async (url, opts) => {
          url = String(url);
          const json = (o, st) => ({ ok: (st || 200) < 400, status: st || 200, json: async () => JSON.parse(JSON.stringify(o)) });
          if(/\/api\/admin\/match-locks/.test(url)){
            const hdr = (opts && opts.headers) || {};
            lockCalls.push(hdr.Authorization || null);
            const r = await S.call('GET', '/api/admin/match-locks', { headers: hdr });
            return json(r.body, r.status);
          }
          if(/\/api\/public\/tournament\//.test(url)) return json(payload);
          return json({ success: false }, 404);
        };
        w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
        w.IntersectionObserver = w.IntersectionObserver || class { observe(){} unobserve(){} disconnect(){} };
        w.ResizeObserver = w.ResizeObserver || class { observe(){} unobserve(){} disconnect(){} };
        w.scrollTo = () => {};
      }
    });
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await sleep(350);
    const doc = dom.window.document;
    const codeOf = (id) => { const c = doc.querySelector(`[data-goto-match="${id}"] .mc-lockcode b`); return c ? c.textContent : null; };
    return { doc, errors, lockCalls, codeOf, html: doc.body.innerHTML };
  }
  const O = await open('chhayajeeth@gmail.com');
  eq('PAGE: owner sees each locked match\'s code on its card', [O.codeOf('m-live'), O.codeOf('m-up'), O.codeOf('m-open')], ['MI24 WIN', 'ABC 123', null]);
  eq('PAGE: …with whether it is being scored', [...O.doc.querySelectorAll('.mc-lockcode i')].map(i => i.textContent).sort(), ['being scored', 'not started']);
  for(const [who, email] of [['another Gmail (a creator)', 'workallsportslive@gmail.com'], ['a visitor, signed out', null]]){
    const V = await open(email);
    eq(`PAGE: ${who} — no codes on the page`, [V.doc.querySelectorAll('.mc-lockcode').length, /MI24|ABC 123|ABC123/.test(V.html), V.doc.querySelectorAll('[data-goto-match]').length], [0, false, 3]);
    eq(`PAGE: ${who} — the page does not even ask for codes`, V.lockCalls.length, 0);
    eq(`PAGE: ${who} — no script errors`, V.errors, []);
  }
  const forged = await S.call('GET', '/api/admin/match-locks', { headers: { Authorization: 'Bearer SOMEONE' } });
  eq('PAGE: a forged request without the owner\'s sign-in → 403, no codes', [forged.status, JSON.stringify(forged.body).includes('MI24WIN')], [403, false]);
  eq('PAGE: no script errors (owner)', O.errors, []);
}

(async () => {
  await serverSuite();
  await tournamentPageSuite();
  for(const f of ['cricket-panel.html', 'cricket-panel3.html']) await panelSuite(f);
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
