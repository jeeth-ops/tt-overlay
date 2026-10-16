// 🏏 RUN OUT — the scorer's "had the batters crossed?" answer (Law 18.12.1) on
// the website side:
//   A. the REAL server.js, booted here against the in-memory MongoDB, stores
//      it with the delivery — over the same socket event ('logBall') the
//      panels use — for a Run Out only, and nothing new for any other ball;
//   B. an owner's Edit Delivery (the real correctDelivery) keeps it while the
//      delivery is still a Run Out, and drops it when it no longer is;
//   C. it changes no figure: the scorecard rebuilt from the balls is
//      identical with or without it (runs, wickets, extras, fall of wickets).
//
//   node test/cricket/run-out-crossing-server-test.js
const { ObjectId } = require('mongodb');
const { bootServer } = require('../server-boot.js');
const H = require('./server-harness.js');
const { connect } = require('../socketio-polling-client.js');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}

// What a panel sends for one delivery (see logBallToDb in cricket-panel.html).
function delivery(n, o){
  return Object.assign({ matchId: 'RO-M1', innings: 1, over: 0, ballInOver: n, kind: 'W', runs: 0, battingTeam: 'A',
    striker: 'Rohit', nonStriker: 'Ishan', bowler: 'Mukesh', strikerId: 'a1', nonStrikerId: 'a2', bowlerId: 'm1',
    ballUid: 'ro-uid-' + n, deliveryId: 'ro-del-' + n, timestamp: 1760000000000 + n }, o);
}

(async () => {
  console.log('\n=== A. the real server stores the answer with the delivery (socket logBall) ===');
  const { port, mem } = await bootServer();
  const s = await connect(port, { uid: 'RO-M1' });
  const sent = [
    delivery(1, { dismissal: { type: 'Run Out', batter: 'Ishan', batterId: 'a2', fielder: 'Jadeja', fielderId: 'f1', crossed: true } }),
    delivery(2, { dismissal: { type: 'Run Out', batter: 'Rohit', batterId: 'a1', fielder: 'Jadeja', fielderId: 'f1', crossed: false } }),
    delivery(3, { dismissal: { type: 'Run Out', batter: 'Ishan', batterId: 'a2', fielder: null } }),
    delivery(4, { dismissal: { type: 'Bowled', batter: 'Rohit', batterId: 'a1', crossed: true } }),
    delivery(5, { kind: '1', runs: 1, dismissal: null })
  ];
  const acks = [];
  for(const d of sent) acks.push(await s.emitAck('logBall', d));
  eq('every delivery acknowledged as stored', acks.map(a => a && a.ok), [true, true, true, true, true]);
  const stored = (await mem.collection('balls').find({ matchId: 'RO-M1' }).toArray()).sort((a, b) => a.ballInOver - b.ballInOver);
  const dis = (n) => { const b = stored.find(x => x.ballInOver === n); return b && b.dismissal; };
  eq('5 deliveries, once each', stored.length, 5);
  eq('Run Out, crossed: kept with the delivery, with its batter and fielder', [dis(1).type, dis(1).batter, dis(1).fielder, dis(1).crossed], ['Run Out', 'Ishan', 'Jadeja', true]);
  eq('Run Out, not crossed: kept as false', [dis(2).batter, dis(2).crossed], ['Rohit', false]);
  eq('Run Out sent without the answer (an older panel): nothing added', 'crossed' in dis(3), false);
  eq('any other dismissal never carries it', [dis(4).type, 'crossed' in dis(4)], ['Bowled', false]);
  eq('an ordinary ball: no dismissal at all', dis(5), null);
  const again = await s.emitAck('logBall', sent[0]);
  eq('the same delivery sent again (a retry): receipted as a duplicate, still one row for it', [again && again.ok, again && again.duplicate, (await mem.collection('balls').find({ matchId: 'RO-M1', ballInOver: 1 }).toArray()).length], [true, true, 1]);
  await s.close();

  console.log('\n=== B. Edit Delivery keeps it while the delivery is still a Run Out ===');
  const names = ['personName', 'playerKey', 'deriveBallFacts', 'buildBallFromCorrection', 'findStrikeInconsistencies', 'strikeIssueKey',
    'validateCorrectedBalls', 'isSuperOverBall', 'buildLiveCardsFromBallsArray', 'serializeClip', 'serializeClipForEditor',
    'validateRosterPlacement', 'deliveryCorrectionDelta', 'clipLinkFromBall', 'clipBallMetaFromBall',
    'correctionInputFromBall', 'panelStateFromMatchRecord', 'oversStrToBallsCount', 'ballsToOversStr'];
  const asyncNames = ['matchRosters', 'findClipsForDelivery', 'relinkClipsForDelivery', 'isMatchFinished', 'announceDeliveryCorrection', 'announceMatchChange',
    'findDeliveryForClip', 'findCanonicalBall', 'assembleDelivery', 'correctDelivery'];
  const consts = ['VALID_EXTRA_TYPES', 'CLIP_EDITOR_DISMISSALS', 'CORRECTION_REPLAY_MS', 'OWNER_EMAIL'];
  const world = () => {
    const mk = (n, o) => Object.assign({ _id: new ObjectId(), matchId: 'RO-M2', ownerUid: 'owner', innings: 1, over: 0, ballInOver: n, kind: '0', runs: 0, battingTeam: 'A',
      striker: 'Rohit', strikerKey: 'rohit', strikerId: 'a1', nonStriker: 'Ishan', nonStrikerKey: 'ishan', nonStrikerId: 'a2',
      bowler: 'Mukesh', bowlerKey: 'mukesh', bowlerId: 'm1', dismissal: null, timestamp: 1760000000000 + n, ballUid: 'b' + n }, o);
    const balls = [1, 2, 3, 4, 5].map(n => mk(n));
    balls.push(mk(6, { kind: 'W', dismissal: { type: 'Run Out', fielder: 'Jadeja', fielderId: 'f1', batter: 'Ishan', batterId: 'a2', crossed: true }, dismissedPlayerKey: 'ishan' }));
    const liveState = { teamA: { name: 'Lions', players: [{ id: 'a1', name: 'Rohit' }, { id: 'a2', name: 'Ishan' }, { id: 'a3', name: 'Surya' }] },
      teamB: { name: 'Tigers', players: [{ id: 'm1', name: 'Mukesh' }, { id: 'f1', name: 'Jadeja' }, { id: 'r1', name: 'Raj' }] } };
    return { balls: H.coll(balls), clips: H.coll([]), records: H.coll([{ matchId: 'RO-M2', ownerUid: 'owner', teamA: { name: 'Lions' }, teamB: { name: 'Tigers' } }]),
      rooms: {}, emits: [], audits: [], syncs: 0, liveState };
  };
  const input = (o) => Object.assign({ runsOffBat: 0, extras: 0, extraType: 'none', wicket: true, dismissalType: 'Run Out', dismissed: 'nonStriker',
    striker: 'Rohit', strikerId: 'a1', nonStriker: 'Ishan', nonStrikerId: 'a2', bowler: 'Mukesh', bowlerId: 'm1', fielder: 'Jadeja', fielderId: 'f1' }, o);
  const roBall = (w) => w.balls.docs.find(b => b.ballInOver === 6);
  {
    const w = world(); const api = H.build(w, names, asyncNames, consts);
    const r = await api.correctDelivery(String(roBall(w)._id), 'chhayajeeth@gmail.com', input({ fielder: 'Raj', fielderId: 'r1' }), false, 'owner');
    eq('a Run Out\'s fielder corrected: the crossing answer stays', [r.errors.length, roBall(w).dismissal.fielder, roBall(w).dismissal.crossed], [0, 'Raj', true]);
    const r2 = await api.correctDelivery(String(roBall(w)._id), 'chhayajeeth@gmail.com', input({ runsOffBat: 1, fielder: 'Raj', fielderId: 'r1' }), false, 'owner');
    eq('…its completed runs corrected (0 → 1): still a Run Out, the answer stays', [r2.errors.length, roBall(w).runs, roBall(w).dismissal.crossed], [0, 1, true]);
    const r3 = await api.correctDelivery(String(roBall(w)._id), 'chhayajeeth@gmail.com', input({ dismissalType: 'Bowled', dismissed: 'striker', fielder: null, fielderId: null, runsOffBat: 0 }), false, 'owner');
    eq('…corrected to Bowled: no crossing answer on a Bowled delivery', [r3.errors.length, roBall(w).dismissal.type, 'crossed' in roBall(w).dismissal], [0, 'Bowled', false]);
  }
  {
    const w = world(); delete roBall(w).dismissal.crossed;
    const api = H.build(w, names, asyncNames, consts);
    await api.correctDelivery(String(roBall(w)._id), 'chhayajeeth@gmail.com', input({ fielder: 'Raj', fielderId: 'r1' }), false, 'owner');
    eq('an old Run Out without the answer, corrected: nothing is invented', 'crossed' in roBall(w).dismissal, false);
  }

  console.log('\n=== C. it changes no figure ===');
  {
    const w = world(); const api = H.build(w, names, asyncNames, consts);
    const withIt = H.clone(w.balls.docs);
    const without = H.clone(w.balls.docs).map(b => { if(b.dismissal) delete b.dismissal.crossed; return b; });
    const a = api.buildLiveCardsFromBallsArray(withIt), b = api.buildLiveCardsFromBallsArray(without);
    eq('the scorecard rebuilt from the balls: identical with and without the answer', JSON.stringify(a), JSON.stringify(b));
    const ishan = (a.battingCard.A || []).find(x => x.name === 'Ishan') || {};
    eq('…Ishan run out, the team 0-1 after 1 over, the bowler 0 wickets', [/run out/i.test(ishan.howOut || ''), a.scoreA && a.scoreA.wickets, a.scoreA && a.scoreA.runs,
      ((a.bowlingCard.B || []).find(x => x.name === 'Mukesh') || {}).wickets], [true, 1, 0, 0]);
  }

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
