/* 🧮 The website's result is the panel's result.

   On the REAL server.js (test/server-boot.js: in-memory MongoDB), over the
   same socket events and save route the panels use, a short match is
   scored where the server's ball log ends up holding deliveries the panel
   had undone (an Undo that never reached the server) — exactly how a
   match the panel finished at 204/6 showed 206-8 in 20.3 overs, "won by
   6 runs", on the website. Then:

     A. a panel Undo is the panel's own scoring — it never marks the
        record as owner-corrected (which froze the wrong totals for good);
     B. an Undo that overtakes its own delivery — the delivery is dropped
        whether it lands before or after the undo;
     C. the panel's save of the finished match lines the ball log up with
        the panel's deliveries, and the website's totals become the panel's
        — but only when the remaining deliveries reproduce the panel's
        totals exactly (a mismatching save touches nothing).

     NODE_PATH=$(npm root -g) node test/cricket/result-matches-panel-test.js
*/
const http = require('http');
const { bootServer } = require('../server-boot.js');
const { connect } = require('../socketio-polling-client.js');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function call(port, method, path, json){
  return new Promise((resolve, reject) => {
    const body = json ? Buffer.from(JSON.stringify(json)) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {} }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch(e){} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if(body) r.write(body);
    r.end();
  });
}

const ROOM = 'RESM' + Math.random().toString(36).slice(2, 6).toUpperCase();
const MATCH_ID = 'T-' + ROOM;
const LEAGUE = '__single_matches__';   // a single match: the public route serves it directly
// One delivery as the panel sends it (see logBallToDb / queueBallForDb).
let seq = 0;
function ball(uid, innings, over, ballInOver, kind, runs, o){
  seq++;
  return Object.assign({ matchId: ROOM, uid: 'owner', ballUid: uid, innings, over, ballInOver, kind, runs, battingTeam: innings === 1 ? 'A' : 'B',
    striker: innings === 1 ? 'Harsh Rane' : 'Vaibhav Mali', nonStriker: innings === 1 ? 'Sahil Gode' : 'Rohan Raje',
    bowler: innings === 1 ? 'Jamshed Alam' : 'Shubham Mane', timestamp: 1760000000000 + seq * 1000 }, o);
}
const W = (uid, inn, ov, b) => ball(uid, inn, ov, b, 'W', 0, { dismissal: { type: 'Bowled', batter: inn === 1 ? 'Harsh Rane' : 'Vaibhav Mali' } });

(async () => {
  // (a creator whose tournaments are public, so the public match route serves it)
  const { port, mem } = await bootServer({ users: { owner: 'workallsportslive@gmail.com' } });
  const s = await connect(port, { uid: ROOM });
  const teams = { teamA: { name: 'DY PATIL SA', short: 'DYP', color: '#8b1e2b' }, teamB: { name: 'GOREGAON SPORTS CLUB', short: 'GSC', color: '#e8590c' } };
  const save = (rec) => call(port, 'POST', `/api/league/${encodeURIComponent(LEAGUE)}/match?uid=owner`,
    { matchId: MATCH_ID, roomId: ROOM, upcoming: false, format: 'T20', ...teams, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] }, ...rec });
  const record = () => mem.collection('matchRecords').findOne({ matchId: MATCH_ID });
  const rows = async () => (await mem.collection('balls').find({ matchId: ROOM }).toArray()).length;
  const until = async (fn, ok, ms) => { const end = Date.now() + (ms || 6000); let v; while(Date.now() < end){ v = await fn(); if(ok(v)) return v; await sleep(100); } return v; };
  const score = (sc) => sc ? `${sc.runs}/${sc.wickets} (${sc.overs})` : null;

  eq('the panel saves the match as it starts', (await save({ scoreA: { runs: 0, wickets: 0, overs: '0.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' } })).json.success, true);

  console.log('\n######## A. a panel Undo is not an owner correction ########');
  // innings 1 — DYP: 6 6 6 6 6 6 = 36/0 in 1.0
  for(let b = 1; b <= 6; b++) await s.emitAck('logBall', ball(`a${b}`, 1, 0, b, '6', 6));
  await s.emitAck('logBall', ball('oops', 2, 0, 1, '4', 4));                // a mis-tap…
  eq('…undone on the panel → taken out of the ball log', [(await s.emitAck('undoBall', { matchId: ROOM, ballUid: 'oops' })).ok, await rows()], [true, 6]);
  const afterUndo = await until(record, r => r && r.scoreA && r.scoreA.runs === 36, 4000);
  eq('the website rebuilt from the log — and the record is NOT marked owner-corrected (that froze the panel\'s totals out for good)',
    [score(afterUndo.scoreA), afterUndo.ownerCorrectedAt || null], ['36/0 (1.0)', null]);

  console.log('\n######## B. an Undo that overtakes its own delivery ########');
  const [l1, u1] = await Promise.all([s.emitAck('logBall', ball('race1', 2, 0, 1, '2', 2)), s.emitAck('undoBall', { matchId: ROOM, ballUid: 'race1' })]);
  await sleep(300);
  eq('delivery and its undo sent together → never stays in the log', [l1.ok, u1.ok, await rows()], [true, true, 6]);
  await s.emitAck('undoBall', { matchId: ROOM, ballUid: 'late1' });
  const late = await s.emitAck('logBall', ball('late1', 2, 0, 1, '1', 1));
  eq('undo first, its delivery after (an outbox re-send) → acknowledged, so the outbox lets go, and not stored', [late.ok, late.undone, await rows()], [true, true, 6]);

  console.log('\n######## C. the finished match: the website shows what the panel scored ########');
  // innings 2 — GSC: 6 6 W 6 W 4 = 22/2 in 1.0 → DYP win by 14 runs.
  const inn2 = [ball('b1', 2, 0, 1, '6', 6), ball('b2', 2, 0, 2, '6', 6), W('b3', 2, 0, 3), ball('b4', 2, 0, 4, '6', 6), W('b5', 2, 0, 5), ball('b6', 2, 0, 6, '4', 4)];
  for(const d of inn2.slice(0, 3)) await s.emitAck('logBall', d);
  // two deliveries the panel undid whose undo never reached the server (a W and a 2)
  await s.emitAck('logBall', W('stray1', 2, 0, 4));
  await s.emitAck('logBall', ball('stray2', 2, 0, 4, '2', 2));
  for(const d of inn2.slice(3)) await s.emitAck('logBall', d);
  const stale = await until(record, r => r && r.scoreB && r.scoreB.runs === 24, 4000);
  eq('the ball log holds 2 deliveries the panel undid: the website says 24/3 in 1.2 — not what was scored', score(stale.scoreB), '24/3 (1.2)');

  const panelIds = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
  const finished = { winningTeam: 'A', resultText: 'DYP WON BY 14 RUNS', scoreA: { runs: 36, wickets: 0, overs: '1.0' }, deliveryIds: panelIds, deliveryIdsComplete: true };
  const wrong = await save({ ...finished, scoreB: { runs: 20, wickets: 2, overs: '1.0' } });
  eq('a save whose totals the log cannot reproduce (a panel with an older copy) → nothing is removed', [wrong.json.success, await rows()], [true, 14]);
  const good = await save({ ...finished, scoreB: { runs: 22, wickets: 2, overs: '1.0' } });
  await sleep(1500);   // (and the per-ball rebuild after it, if any)
  const rec = await record();
  eq('the panel saves the finished match → the 2 undone deliveries leave the log (kept in ballsArchive)',
    [good.json.success, await rows(), (await mem.collection('ballsArchive').find({ matchId: ROOM, ballUid: { $in: ['stray1', 'stray2'] } }).toArray()).length], [true, 12, 2]);
  eq('…and the website shows what the panel scored: 36/0 v 22/2, DYP won, by 14 runs', [score(rec.scoreA), score(rec.scoreB), rec.winningTeam, rec.resultText], ['36/0 (1.0)', '22/2 (1.0)', 'A', 'DYP WON BY 14 RUNS']);
  eq('…the list of deliveries is not kept on the record', [rec.deliveryIds, rec.deliveryIdsComplete], [undefined, undefined]);
  const pub = await call(port, 'GET', `/api/public/match/${MATCH_ID}`);
  eq('…and the public match the website reads says the same', pub.json && pub.json.match ? [score(pub.json.match.scoreB), pub.json.match.resultText] : null, ['22/2 (1.0)', 'DYP WON BY 14 RUNS']);
  const again = await save({ ...finished, scoreB: { runs: 22, wickets: 2, overs: '1.0' } });
  eq('saving it again changes nothing', [again.json.success, await rows(), score((await record()).scoreB)], [true, 12, '22/2 (1.0)']);

  await s.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
