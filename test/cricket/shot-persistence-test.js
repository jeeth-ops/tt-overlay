// 🎯 WAGON WHEEL SHOTS — every shot the operator marks reaches the finished
// match's commentary, the same as the live one.
//
// The bug (the Harris Shield final: 301 shots in the live commentary, 108 in
// the finished match's): a marked shot goes onto the delivery in the panel's
// ball log (live) and, by setBallShot, onto the stored delivery (finished).
// The second one's retry queue lived ONLY in browser storage — with storage
// full (the old undo stack filled it) the queue write failed silently and the
// shot was never sent.
//
//   PANELS (both, jsdom):
//     1. storage full: a marked shot is still sent
//     2. the stored delivery is not there yet: kept, sent again until stored
//     3. a decided match's save sends every shot on the ball log once more
//   SERVER (the real server.js, in-memory MongoDB, the panel's own socket events):
//     4. a stored delivery with no shot gets the one on the SAME delivery in
//        the room's live ball log — when innings, over and ball agree too
//     5. never: onto a delivery that has a shot, from a delivery that
//        disagrees, for a delivery the live state does not know
//     6. the healed shots are stored (a second read finds them on the rows)
//     7. a recovery restore from the panel state keeps each delivery's shot
//
//   NODE_PATH=$(npm root -g) node test/cricket/shot-persistence-test.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function bootPanel(file){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const net = { emits: [], reply: () => ({ ok: true }) };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=SHOTS', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(ev, payload, ack){ net.emits.push({ ev, payload }); if(typeof ack === 'function') ack(net.reply(ev, payload)); }, connected: true, disconnect(){}, io: { on(){} } });
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.firebase = undefined; w.alert = () => {}; w.confirm = () => true;
      w.crypto = w.crypto || {};
      if(!w.crypto.randomUUID) w.crypto.randomUUID = () => 'uuid-' + Math.random().toString(36).slice(2);
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { w: dom.window, E: (c) => dom.window.eval(c), J: (c) => JSON.parse(dom.window.eval(`JSON.stringify(${c})`)), errors, net };
}
const shotsSent = (P) => P.net.emits.filter(e => e.ev === 'setBallShot');

async function panelSuite(file){
  console.log(`\n######## ${file} ########`);
  const P = bootPanel(file);
  await sleep(50);
  const L = (t) => `${file}: ${t}`;
  P.E(`
    document.getElementById('match-id').value = 'SHOTS';
    state = mergeWithDefaults(null); state.format = 'T20'; state.battingTeam = 'A'; state.wagonWheelOn = false;
    state.striker = { name:'Striker', id:'p1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'NonStriker', id:'p2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Bowler', id:'p9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; renderPanel();
    recordBall('4'); recordBall('1'); recordBall('6'); recordBall('2');
  `);
  const shot = (i, zone) => P.E(`setBallShot(state.ballLog[${i}], { zone: '${zone}', depth: 'deep', hand: 'R', x: -0.5, y: 0.5 })`);

  console.log('\n=== 1. Browser storage full: the shot is still sent ===');
  const filled = P.J(`(() => { let n = 0; for(const size of [100000, 10000, 1000, 100, 10, 1]){ try { for(;; n++) localStorage.setItem('filler-' + n, 'x'.repeat(size)); } catch(e) {} } return n; })()`);
  eq(L('storage is full, down to the last character'), filled > 0, true);
  P.net.emits.length = 0;
  shot(0, 'cover');
  eq(L('the shot goes to the server at once, storage full or not'), shotsSent(P).map(e => [e.payload.ballUid, e.payload.shot.zone]), [[P.J('state.ballLog[0].deliveryId'), 'cover']]);
  eq(L('…on the live ball log too'), P.J('state.ballLog[0].shot.zone'), 'cover');
  P.E(`Object.keys(localStorage).filter(k => k.startsWith('filler-')).forEach(k => localStorage.removeItem(k));`);

  console.log('\n=== 2. The stored delivery is not there yet: sent again until it is stored ===');
  P.net.emits.length = 0;
  let found = false;
  P.net.reply = (ev) => ev === 'setBallShot' ? (found ? { ok: true } : { ok: false, retry: true, error: 'not-found' }) : { ok: true };
  shot(1, 'point');
  eq(L('first send: not found yet'), shotsSent(P).length, 1);
  P.E(`flushShotQueue()`);
  eq(L('kept and sent again on the next flush'), shotsSent(P).filter(e => e.payload.shot.zone === 'point').length, 2);
  found = true;
  P.E(`flushShotQueue()`);
  const n0 = shotsSent(P).length;
  P.E(`flushShotQueue()`);
  eq(L('once stored, it is not sent any more'), shotsSent(P).length, n0);
  P.net.reply = () => ({ ok: true });

  console.log('\n=== 3. A decided match: every shot goes up once more ===');
  shot(2, 'midwicket'); shot(3, 'thirdman');
  P.net.emits.length = 0;
  P.E(`state.milestonesHit['match-result'] = true; state.matchLeague = 'Shots Cup'; state.leagueName = 'Shots Cup'; saveMatchToLeague(true);`);
  const sent = shotsSent(P).map(e => e.payload.shot.zone).sort();
  eq(L('the save of a decided match sends all four shots on the ball log'), sent, ['cover', 'midwicket', 'point', 'thirdman']);
  P.net.emits.length = 0;
  P.E(`saveMatchToLeague(true)`);
  eq(L('…and a repeat save of the same match sends nothing new'), shotsSent(P).length, 0);
  eq(L('no script errors'), P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

function call(port, method, p, json){
  return new Promise((resolve, reject) => {
    const body = json ? Buffer.from(JSON.stringify(json)) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {} }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch(e){} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if(body) r.write(body);
    r.end();
  });
}

async function serverSuite(){
  console.log('\n######## SERVER — the real server.js ########');
  const { bootServer } = require('../server-boot.js');
  const { connect } = require('../socketio-polling-client.js');
  const ROOM = 'SHOT' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const MATCH_ID = 'S-' + ROOM;
  const { port, mem } = await bootServer({ users: { owner: 'workallsportslive@gmail.com' } });
  const s = await connect(port, { uid: ROOM });
  const teams = { teamA: { name: 'GENERAL EDUCATION ACADEMY', short: 'GEA' }, teamB: { name: 'ANJUMAN', short: 'A-I-' } };
  await call(port, 'POST', `/api/league/__single_matches__/match?uid=owner`, { matchId: MATCH_ID, roomId: ROOM, upcoming: false, format: 'Test', ...teams, winningTeam: 'B',
    battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] }, scoreA: { runs: 20, wickets: 1, overs: '1.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' } });
  const C = (zone, x, y) => ({ zone, depth: 'deep', hand: 'R', x, y });
  // six deliveries of over 39 (0-based 38), innings 3, as the panel sends them
  const del = [
    { uid: 'd1', ball: 1, kind: '4', runs: 4, live: C('cover', -0.64, 0.33), stored: null },          // lost on the way → healed
    { uid: 'd2', ball: 2, kind: '1', runs: 1, live: C('midwicket', 0.5, 0.2), stored: null },          // lost → healed
    { uid: 'd3', ball: 3, kind: '4', runs: 4, live: C('point', -0.9, 0.1), stored: C('thirdman', -0.8, -0.5) }, // has its own: kept
    { uid: 'd4', ball: 4, kind: '2', runs: 2, live: C('fineleg', 0.3, -0.9), stored: null, liveOver: '37.4' },  // disagrees: not copied
    { uid: 'd5', ball: 5, kind: '6', runs: 6, live: null, stored: null },                               // never marked: stays empty
    { uid: 'd6', ball: 6, kind: '3', runs: 3, live: C('midon', 0.2, 0.8), stored: null, notLive: true } // live state does not know it
  ];
  for(const d of del){
    const r = await s.emitAck('logBall', { matchId: ROOM, uid: 'owner', ballUid: d.uid, innings: 3, over: 38, ballInOver: d.ball, kind: d.kind, runs: d.runs, battingTeam: 'A',
      striker: 'RUDRA PANDAV', nonStriker: 'SAMARTH MAHADIK', bowler: 'ANUJ SINGH', timestamp: 1762400000000 + d.ball * 1000 });
    if(d.stored) await s.emitAck('setBallShot', { matchId: ROOM, ballUid: d.uid, shot: d.stored });
    void r;
  }
  // the panel's live state: its ball log carries every shot the operator marked
  const ballLog = del.filter(d => !d.notLive).map(d => ({ deliveryId: d.uid, innings: 3, over: d.liveOver || `38.${d.ball}`, ballType: d.kind, runs: d.runs,
    striker: 'RUDRA PANDAV', bowler: 'ANUJ SINGH', battingTeam: 'A', ...(d.live ? { shot: d.live } : {}) }));
  ballLog.push({ deliveryId: 'd6', innings: 3, over: '38.6', ballType: '3', runs: 3 }); // known, but without a shot
  s.emit('updateCricketScore', { matchLeague: '', format: 'Test', inningsNumber: 3, battingTeam: 'A', ...teams, score: { runs: 20, wickets: 1, overs: 1, balls: 0 }, ballLog, localRev: 5 });
  await sleep(300);

  console.log('\n=== 4-6. The finished match\'s commentary reads its deliveries ===');
  const get = async () => (await call(port, 'GET', `/api/public/match/${encodeURIComponent(MATCH_ID)}/balls`)).json;
  const r1 = await get();
  const zones = (r) => Object.fromEntries((r.balls || []).map(b => [b.deliveryId, b.shot ? b.shot.zone : null]));
  eq('the lost shots come back, from the SAME delivery of the live ball log', [zones(r1).d1, zones(r1).d2], ['cover', 'midwicket']);
  eq('…with the exact spot the operator tapped', (r1.balls || []).find(b => b.deliveryId === 'd1').shot, { zone: 'cover', depth: 'deep', hand: 'R', x: -0.64, y: 0.33 });
  eq('a delivery that has its own shot keeps it', zones(r1).d3, 'thirdman');
  eq('a live delivery that disagrees (another over) is not copied', zones(r1).d4, null);
  eq('a ball never marked stays empty', zones(r1).d5, null);
  eq('a delivery the live state has no shot for stays empty', zones(r1).d6, null);
  const rows = await mem.collection('balls').find({ matchId: ROOM }).toArray();
  eq('the healed shots are stored on the delivery rows themselves', Object.fromEntries(rows.map(b => [b.ballUid, b.shot ? b.shot.zone : null])), { d1: 'cover', d2: 'midwicket', d3: 'thirdman', d4: null, d5: null, d6: null });
  eq('…marked as recovered', rows.filter(b => b.shotRecoveredAt).map(b => b.ballUid).sort(), ['d1', 'd2']);
  const r2 = await get();
  eq('a second read: the same shots, straight from the rows', zones(r2), zones(r1));

  console.log('\n=== 7. A recovery restore keeps each delivery\'s shot ===');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const grab = (name) => { const a = src.indexOf('function ' + name + '('); let i = src.indexOf('{', src.indexOf(')', a)), d = 0; for(let j = i; j < src.length; j++){ if(src[j] === '{') d++; else if(src[j] === '}' && --d === 0) return src.slice(a, j + 1); } };
  const SHOT_ZONES = new Set(['fineleg', 'squareleg', 'midwicket', 'midon', 'midoff', 'cover', 'point', 'thirdman']);
  const personName = (p) => typeof p === 'string' ? p : (p && p.name) || '';
  const playerKey = (n) => String(n || '').trim().toLowerCase();
  const fns = new Function('SHOT_ZONES', 'personName', 'playerKey', grab('sanitizeShot') + '\n' + grab('ballDocsFromPanelState') + '\nreturn { ballDocsFromPanelState };')(SHOT_ZONES, personName, playerKey);
  const docs = fns.ballDocsFromPanelState({ ballLog: [{ over: '0.1', ballType: '4', runs: 4, shot: C('cover', -0.6, 0.6) }, { over: '0.2', ballType: '0', runs: 0 }] }, ROOM, 'owner');
  eq('a delivery restored from the panel state keeps its shot; one without stays without', docs.map(d => d.shot ? d.shot.zone : null), ['cover', null]);
  await s.close();
}

(async () => {
  for(const f of ['cricket-panel.html', 'cricket-panel3.html']) await panelSuite(f);
  await serverSuite();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
