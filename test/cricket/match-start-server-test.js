// ▶ Starting an Upcoming Match on the REAL server.js, over HTTP — booted in
// this process against the in-memory MongoDB (test/mongo-memory.js), with
// the account workallsportslive@gmail.com. The database connects 1.2 s
// after the server starts listening, as a cold start on the host does.
//
//   • a request in those first moments waits for the database and answers
//     with the real list — not "no matches", not "not locked"
//   • two laptops pressing ▶ Start together: exactly one starts it
//   • the laptop that started it may ask again (a lost answer); no one else
//   • a stale fixture is never written over a started match
//   • a locked fixture: no key → refused; wrong code → refused; the code
//     → its key → started; a laptop with an old list is told "started"
//     without being asked for (or taking) the key
//   • another account cannot start it; no account / an unauthorised one is refused
//
//   node test/cricket/match-start-server-test.js
const path = require('path');
const http = require('http');
const { MemoryDb } = require('../mongo-memory.js');
const F = require('../merge-fixtures.js');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const CONNECT_DELAY = 1200;
const WORK = F.USERS.work.uid, VINIT = F.USERS.vinit.uid, OTHER = F.USERS.other.uid;

async function boot(seed){
  const mem = new MemoryDb();
  const realMongo = require('mongodb');
  class SlowClient { async connect(){ await new Promise(r => setTimeout(r, CONNECT_DELAY)); } db(name){ return { databaseName: name || 'scorvix', collection: (n) => mem.collection(n) }; } }
  require.cache[require.resolve('mongodb')] = { id: 'mongodb', filename: require.resolve('mongodb'), loaded: true,
    exports: new Proxy(realMongo, { get: (t, k) => (k === 'MongoClient' ? SlowClient : t[k]) }) };
  const fakeDoc = { get: async () => ({ exists: false, data: () => null }), set: async () => {}, update: async () => {}, onSnapshot: () => () => {} };
  require.cache[require.resolve('firebase-admin')] = { id: 'firebase-admin', filename: require.resolve('firebase-admin'), loaded: true, exports: {
    initializeApp(){}, credential: { cert: () => ({}) },
    firestore: () => ({ collection: () => ({ doc: () => fakeDoc, where: () => ({ get: async () => ({ docs: [] }) }) }) }),
    auth: () => ({ verifyIdToken: async () => { throw new Error('no tokens here'); },
      getUser: async (uid) => { if(!F.EMAIL_OF[uid]) throw new Error('no user'); return { uid, email: F.EMAIL_OF[uid] }; },
      getUserByEmail: async (e) => { if(!F.UID_OF[e]) throw new Error('no user'); return { uid: F.UID_OF[e], email: e }; },
      listUsers: async () => ({ users: [] }) }) } };
  const port = 4900 + Math.floor(Math.random() * 500);
  process.env.PORT = String(port);
  process.env.MONGODB_URI = 'mongodb://memory';
  const c = F.collections(mem);
  await F.indexes(c);
  if(seed) await seed(c);
  const req = (method, url, body, headers) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const t0 = Date.now();
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let buf = '';
      res.on('data', (ch) => { buf += ch; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch(e) {} resolve({ status: res.statusCode, json, ms: Date.now() - t0 }); });
    });
    r.on('error', reject);
    if(data) r.write(data);
    r.end();
  });
  process.chdir(path.join(__dirname, '..', '..'));
  const bootedAt = Date.now();
  require('../../server.js');
  for(let i = 0; i < 100; i++){
    await new Promise(r => setTimeout(r, 20));
    try { const r = await req('GET', '/cricket-overlay'); if(r.status === 200) return { c, req, mem, bootedAt }; } catch(e) {}
  }
  throw new Error('server.js did not come up');
}

const fixture = (o) => ({
  matchId: o.matchId, roomId: o.roomId, upcoming: true, scheduledDate: '2026-10-18', matchNo: o.matchNo || 1, savedAt: '2026-10-16T10:00:00.000Z',
  format: 'T20', customOvers: null, maxWickets: 10, superOverEnabled: true, matchStage: 'league', notes: '', venue: '', streamUrl: '',
  teamA: { name: 'D Y Patil', short: 'DYP', color: '#0ea5e9', logoUrl: '', teamId: 't_dyp' }, teamB: { name: 'Parel SC', short: 'PSC', color: '#8b1a2b', logoUrl: '', teamId: 't_psc' },
  winningTeam: null, scoreA: { runs: 0, wickets: 0, overs: '0.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' },
  battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] },
  squadA: { players: [{ id: 'gp_rahul', name: 'Rahul', isXI: true }], captainId: null, wkId: null }, squadB: { players: [{ id: 'gp_amit', name: 'Amit', isXI: true }], captainId: null, wkId: null },
  ...(o.locked ? { locked: true } : {})
});

(async () => {
  const { c, req, bootedAt } = await boot(async (c) => {
    // made on Laptop A earlier — already on the server
    await c.records.insertOne({ ...fixture({ matchId: 'm-fx1', roomId: 'R-FX1' }), ownerUid: WORK, leagueKey: 'test cup' });
    await c.leagues.insertOne({ ownerUid: WORK, leagueKey: 'test cup', displayName: 'Test Cup', sport: 'cricket', publicToken: 'tok-tc', updatedAt: 1 });
  });
  const L = (url) => url + (url.includes('?') ? '&' : '?') + 'uid=' + WORK;

  console.log('\n=== A cold start: the database connects after the server answers ===');
  const early = await req('GET', L('/api/league/Test%20Cup'));
  eq('the first list request waits for the database and returns the real list', [early.status, early.json && early.json.success, early.json && early.json.matches.map(m => m.matchId), Date.now() - bootedAt >= CONNECT_DELAY - 100], [200, true, ['m-fx1'], true]);
  const lockEarly = await req('GET', '/api/match-lock/R-FX1');
  eq('lock status after start-up: a real answer (not locked), not a guess', [lockEarly.status, lockEarly.json.locked], [200, false]);

  console.log('\n=== Two laptops press ▶ Start together (unlocked) ===');
  const [a, b] = await Promise.all([
    req('POST', L('/api/league/Test%20Cup/match/m-fx1/start'), { deviceId: 'dv-laptopA' }),
    req('POST', L('/api/league/Test%20Cup/match/m-fx1/start'), { deviceId: 'dv-laptopB' })
  ]);
  const winner = a.status === 200 ? 'dv-laptopA' : 'dv-laptopB';
  eq('exactly one starts it, the other is told it has started', [a.status, b.status].sort(), [200, 409]);
  eq('the loser\'s answer says so', (a.status === 409 ? a : b).json.code, 'ALREADY_STARTED');
  let rec = await c.records.findOne({ ownerUid: WORK, leagueKey: 'test cup', matchId: 'm-fx1' });
  eq('the record: same matchId, started, by the winner, still one record', [rec.upcoming, rec.startedBy.deviceId, rec.startedBy.email, (await c.records.find({ matchId: 'm-fx1' }).toArray()).length], [false, winner, 'workallsportslive@gmail.com', 1]);
  const again = await req('POST', L('/api/league/Test%20Cup/match/m-fx1/start'), { deviceId: winner });
  const loserAgain = await req('POST', L('/api/league/Test%20Cup/match/m-fx1/start'), { deviceId: winner === 'dv-laptopA' ? 'dv-laptopB' : 'dv-laptopA' });
  eq('the laptop that started it asking again: started (a lost answer); the other: still refused', [again.status, again.json.again, loserAgain.status], [200, true, 409]);

  console.log('\n=== The started match is saved; a stale fixture cannot overwrite it ===');
  const startedSave = await req('POST', L('/api/league/Test%20Cup/match'), { ...fixture({ matchId: 'm-fx1', roomId: 'R-FX1' }), upcoming: false, scoreA: { runs: 57, wickets: 2, overs: '6.3' }, battingCard: { A: [{ name: 'Rahul', id: 'gp_rahul', runs: 40, balls: 22 }], B: [] } });
  eq('the started match saves under the same matchId', [startedSave.status, startedSave.json.matches.filter(m => m.matchId === 'm-fx1').length], [200, 1]);
  const stale = await req('POST', L('/api/league/Test%20Cup/match'), { ...fixture({ matchId: 'm-fx1', roomId: 'R-FX1' }), venue: 'Changed on Laptop A' });
  rec = await c.records.findOne({ ownerUid: WORK, leagueKey: 'test cup', matchId: 'm-fx1' });
  eq('the old fixture from Laptop A is refused (409) — scores untouched', [stale.status, stale.json.code, rec.upcoming, rec.scoreA.runs, rec.battingCard.A.length, rec.venue], [409, 'ALREADY_STARTED', false, 57, 1, '']);

  console.log('\n=== A LOCKED Upcoming Match ===');
  const saveFx2 = await req('POST', L('/api/league/Test%20Cup/match'), fixture({ matchId: 'm-fx2', roomId: 'R-FX2', matchNo: 2, locked: true }));
  const made = await req('POST', L('/api/match-lock'), { roomId: 'R-FX2', matchId: 'm-fx2', deviceId: 'dv-laptopA', claim: false, code: 'FINAL26' });
  eq('fixture saved, its code made (no laptop holds it yet)', [saveFx2.status, made.status, made.json.code, made.json.token], [200, 200, 'FINAL26', null]);
  const noKey = await req('POST', L('/api/league/Test%20Cup/match/m-fx2/start'), { deviceId: 'dv-laptopB' });
  eq('▶ Start without the key → refused (423), still upcoming', [noKey.status, noKey.json.code, (await c.records.findOne({ matchId: 'm-fx2' })).upcoming], [423, 'MATCH_LOCKED', true]);
  const wrong = await req('POST', '/api/match-lock/R-FX2/claim', { code: 'WRONG99', deviceId: 'dv-laptopB' });
  eq('a wrong code → refused (403)', [wrong.status, wrong.json.code], [403, 'WRONG_CODE']);
  const right = await req('POST', '/api/match-lock/R-FX2/claim', { code: 'final26', deviceId: 'dv-laptopB' });
  eq('the code → this laptop\'s key', [right.status, typeof right.json.token, right.json.token.length], [200, 'string', 48]);
  const go = await req('POST', L('/api/league/Test%20Cup/match/m-fx2/start'), { deviceId: 'dv-laptopB' }, { 'X-Match-Key': right.json.token });
  rec = await c.records.findOne({ matchId: 'm-fx2' });
  eq('with its key → started on Laptop B', [go.status, rec.upcoming, rec.startedBy.deviceId], [200, false, 'dv-laptopB']);
  const staleA = await req('POST', L('/api/league/Test%20Cup/match/m-fx2/start'), { deviceId: 'dv-laptopA' });
  const st = await req('GET', '/api/match-lock/R-FX2', null, { 'X-Match-Key': right.json.token });
  eq('Laptop A (old list, no key): told it has started (409) — no key asked, B still holds it', [staleA.status, staleA.json.code, st.json.held, st.json.you], [409, 'ALREADY_STARTED', true, true]);
  const winnerNoKey = await req('POST', L('/api/league/Test%20Cup/match/m-fx2/start'), { deviceId: 'dv-laptopB' });
  eq('"started here" on a locked match still needs its key', [winnerNoKey.status, winnerNoKey.json.code], [423, 'MATCH_LOCKED']);

  console.log('\n=== Other accounts ===');
  const saveFx3 = await req('POST', L('/api/league/Test%20Cup/match'), fixture({ matchId: 'm-fx3', roomId: 'R-FX3', matchNo: 3 }));
  const vinit = await req('POST', `/api/league/Test%20Cup/match/m-fx3/start?uid=${VINIT}`, { deviceId: 'dv-x' });
  const other = await req('POST', `/api/league/Test%20Cup/match/m-fx3/start?uid=${OTHER}`, { deviceId: 'dv-x' });
  const none = await req('POST', '/api/league/Test%20Cup/match/m-fx3/start', { deviceId: 'dv-x' });
  const vinitList = await req('GET', `/api/league/Test%20Cup?uid=${VINIT}`);
  eq('another authorised account: not found under it (404), sees none of these matches', [saveFx3.status, vinit.status, vinitList.status, vinitList.json.matches.length], [200, 404, 200, 0]);
  eq('an unauthorised account (403) / no account (401): refused; the fixture is untouched', [other.status, none.status, (await c.records.findOne({ matchId: 'm-fx3' })).upcoming], [403, 401, true]);
  // the same account's other tournament (similar teams) cannot reach this match
  await req('POST', L('/api/league/Test%20Cup%202/match'), { ...fixture({ matchId: 'm-other', roomId: 'R-OTHER' }) });
  const viaOther = await req('POST', L('/api/league/Test%20Cup%202/match/m-fx3/start'), { deviceId: 'dv-laptopA' });
  eq('a match is started only through its own tournament (404 through another, untouched)', [viaOther.status, viaOther.json.code, (await c.records.findOne({ matchId: 'm-fx3' })).upcoming, (await c.records.findOne({ matchId: 'm-other' })).upcoming], [404, 'NOT_FOUND', true, true]);
  eq('records for the account: one per match, in its own tournament, no copies',
    (await c.records.find({ ownerUid: WORK }).toArray()).map(r => r.leagueKey + ':' + r.matchId).sort(), ['test cup 2:m-other', 'test cup:m-fx1', 'test cup:m-fx2', 'test cup:m-fx3']);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
