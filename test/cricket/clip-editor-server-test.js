/* Advanced Clip Editor — the REAL server code (correctDelivery, the clip
   re-link, runClipEdit, requireOwner …, extracted from server.js by name,
   never copied) run against an in-memory database, for the owner's cases:

     1  12.6 FOUR → SIX                      score, batter runs, clip type, same video
     2  12.6 Run Out: dismissed B → A        wicket player, scorecard, clip owner
     3  12.6 WICKET: batsman A→C, bowler B→D every downstream record
     4  Caught → Run Out                     bowler credit 1 → 0, fielder
     5  Run Out → Bowled                     bowler credit 0 → 1
     6  batsman + bowler + event in one save
     7  last ball of an over                 next over's deliveries untouched
     8  an old delivery, several overs back  only its dependent figures move
     9  another account                      403, nothing changes

     node test/cricket/clip-editor-server-test.js
*/
const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

function grab(name, prefix){
  const start = src.indexOf((prefix || 'function ') + name + '(');
  if(start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
  for(let j = i; j < src.length; j++){
    if(src[j] === '{') depth++;
    else if(src[j] === '}'){ depth--; if(depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
function grabConst(name){
  const m = new RegExp('const ' + name + ' = [^\\n]*\\n').exec(src);
  if(!m) throw new Error('const not found: ' + name);
  return m[0];
}

// ---------- in-memory Mongo ----------
const clone = (o) => o == null ? o : JSON.parse(JSON.stringify(o), (k, v) => (k === '_id' && typeof v === 'string' && /^[0-9a-f]{24}$/.test(v)) ? new ObjectId(v) : v);
function matches(doc, q){
  return Object.keys(q).every(k => {
    const v = q[k];
    if(k === '$or') return v.some(sub => matches(doc, sub));
    const dv = doc[k];
    if(v && typeof v === 'object' && !(v instanceof ObjectId) && !Array.isArray(v)){
      if('$in' in v) return v.$in.some(x => String(x) === String(dv) || (x === null && dv == null));
      if('$ne' in v) return String(dv) !== String(v.$ne);
      return JSON.stringify(dv) === JSON.stringify(v);
    }
    if(v instanceof ObjectId) return dv instanceof ObjectId && dv.equals(v);
    return dv === v;
  });
}
function coll(docs){
  docs = docs || [];
  const api = {
    docs,
    findOne: async (q) => clone(docs.find(d => matches(d, q || {})) || null),
    find: (q) => {
      let rows = docs.filter(d => matches(d, q || {}));
      const cur = {
        sort: (s) => { const ks = Object.keys(s); rows = rows.slice().sort((a, b) => { for(const k of ks){ const d = ((a[k] ?? 0) > (b[k] ?? 0) ? 1 : (a[k] ?? 0) < (b[k] ?? 0) ? -1 : 0) * s[k]; if(d) return d; } return 0; }); return cur; },
        limit: (n) => { rows = rows.slice(0, n); return cur; },
        toArray: async () => rows.map(clone),
        next: async () => clone(rows[0] || null),
      };
      return cur;
    },
    replaceOne: async (q, doc) => { const i = docs.findIndex(d => matches(d, q)); if(i >= 0) docs[i] = clone(doc); return { matchedCount: i >= 0 ? 1 : 0 }; },
    updateOne: async (q, u) => { const d = docs.find(x => matches(x, q)); if(d && u.$set) Object.assign(d, clone(u.$set)); return { matchedCount: d ? 1 : 0 }; },
    updateMany: async (q, u) => { docs.filter(x => matches(x, q)).forEach(d => Object.assign(d, clone(u.$set))); return {}; },
  };
  return api;
}

// ---------- build the extracted server pieces ----------
function build(world){
  const names = [
    'personName', 'playerKey', 'deriveBallFacts', 'buildBallFromCorrection', 'findStrikeInconsistencies', 'strikeIssueKey',
    'validateCorrectedBalls', 'isSuperOverBall', 'buildLiveCardsFromBallsArray', 'serializeClip', 'serializeClipForEditor',
    'validateRosterPlacement', 'deliveryCorrectionDelta', 'clipLinkFromBall', 'clipBallMetaFromBall',
    'correctionInputFromBall', 'panelStateFromMatchRecord', 'oversStrToBallsCount', 'ballsToOversStr'
  ];
  const asyncNames = ['matchRosters', 'findClipsForDelivery', 'relinkClipsForDelivery', 'isMatchFinished', 'announceDeliveryCorrection', 'announceMatchChange',
    'findDeliveryForClip', 'findCanonicalBall', 'assembleDelivery', 'correctDelivery', 'loadClipForEditor', 'runClipEdit', 'requireOwner'];
  const code = [
    grabConst('VALID_EXTRA_TYPES'), grabConst('CLIP_EDITOR_DISMISSALS'), grabConst('CORRECTION_REPLAY_MS'), grabConst('OWNER_EMAIL'),
    ...names.map(n => grab(n)), ...asyncNames.map(n => grab(n, 'async function ')),
    grab('extractIdToken'),
    'return { ' + [...names, ...asyncNames].join(', ') + ' };'
  ].join('\n');
  const deps = {
    process: { env: {} },
    ballsCollection: world.balls, clipsCollection: world.clips, matchRecordsCollection: world.records,
    ClipAttribution: require('../../clip-attribution.js'),
    resolvePlayerId: async (o, name) => name ? 'gp:' + String(name).toLowerCase() : null,
    resolvePlayerIdExplicit: async (o, id, name) => id ? 'gp:' + id : (name ? 'gp:' + String(name).toLowerCase() : null),
    syncMatchRecordFromBalls: async (uid, matchId) => {
      if(world.failSync) throw new Error('sync down');
      const balls = world.balls.docs.filter(b => b.matchId === matchId);
      const cards = deps.__api.buildLiveCardsFromBallsArray(balls);
      const rec = world.records.docs.find(r => r.matchId === matchId);
      Object.assign(rec, { battingCard: cards.battingCard, bowlingCard: cards.bowlingCard, scoreA: cards.scoreA, scoreB: cards.scoreB });
      world.syncs++;
    },
    getRoomState: async (room) => (world.rooms[room] = world.rooms[room] || { cricketState: world.liveState || null }),
    io: { to: (room) => ({ emit: (ev, payload) => world.emits.push({ room, ev, payload }) }) },
    db: { collection: () => ({ doc: () => ({ set: async () => {} }) }) },
    invalidateClipsCache: () => {},
    logAuditAction: async (...a) => world.audits.push(a),
    verifyIdTokenFull: async (t) => t === 'owner-token' ? { email: 'chhayajeeth@gmail.com', uid: 'owner' } : t === 'other-token' ? { email: 'someone@gmail.com', uid: 'x' } : null,
    require: (m) => m === 'mongodb' ? { ObjectId } : require(m),
    console: { log: () => {} },
    __api: null,
  };
  deps.__api = new Function(...Object.keys(deps), code)(...Object.values(deps));
  return deps.__api;
}

// ---------- a match: team A batting, innings 1 ----------
const key = (n) => String(n).toLowerCase();
let seq = 0;
function ball(o){
  const b = Object.assign({
    _id: new ObjectId(), ballUid: 'd' + (++seq), matchId: 'M1', ownerUid: 'owner', innings: 1, battingTeam: 'A',
    kind: '0', runs: 0, striker: 'Amit', nonStriker: 'Bharat', bowler: 'Bowler One',
    strikerId: 'pA', nonStrikerId: 'pB', bowlerId: 'b1', dismissal: null, timestamp: seq
  }, o);
  b.strikerKey = key(b.striker); b.nonStrikerKey = key(b.nonStriker); b.bowlerKey = key(b.bowler);
  return b;
}
function freshWorld(extraBalls){
  seq = 0;
  const balls = [];
  for(let i = 1; i <= 5; i++) balls.push(ball({ over: 12, ballInOver: i, kind: '1' === '1' && i % 2 ? '0' : '2', runs: i % 2 ? 0 : 2 }));
  const last = ball({ over: 12, ballInOver: 6, kind: '4', runs: 4 }); balls.push(last);
  // next over: new bowler, ends swapped
  const next = ball({ over: 13, ballInOver: 1, kind: '1', runs: 1, striker: 'Bharat', nonStriker: 'Amit', strikerId: 'pB', nonStrikerId: 'pA', bowler: 'Bowler Two', bowlerId: 'b2' });
  balls.push(next, ...(extraBalls || []));
  const clips = [{ _id: new ObjectId(), clipId: 'M1_FOUR_111', matchId: 'M1', eventType: 'FOUR', deliveryId: last.ballUid,
    innings: 1, over: 12, ballInOver: 6, strikerName: 'Amit', strikerKey: 'amit', bowlerName: 'Bowler One', bowlerKey: 'bowler one',
    r2Url: 'https://r2/M1_FOUR_111.mp4', driveUrl: 'https://drive/abc', isHighlight: true, status: 'COMPLETE' }];
  const liveState = { teamA: { name: 'Lions', players: [{ id: 'pA', name: 'Amit' }, { id: 'pB', name: 'Bharat' }, { id: 'pC', name: 'Chetan' }] },
    teamB: { name: 'Tigers', players: [{ id: 'b1', name: 'Bowler One' }, { id: 'b2', name: 'Bowler Two' }, { id: 'b4', name: 'Dev' }, { id: 'f1', name: 'Fielder X' }] } };
  return { balls: coll(balls), clips: coll(clips), records: coll([{ matchId: 'M1', ownerUid: 'owner', teamA: { name: 'Lions' }, teamB: { name: 'Tigers' } }]),
    rooms: {}, emits: [], audits: [], syncs: 0, liveState, last, next, clip: clips[0] };
}
const ownerReq = (world, body) => ({ params: { clipId: String(world.clip._id) }, body, ownerEmail: 'chhayajeeth@gmail.com', ownerUid: 'owner' });
const rec = (w) => w.records.docs[0];
const batRow = (w, name) => (rec(w).battingCard.A || []).find(r => r.name === name) || {};
const bowlRow = (w, name) => (rec(w).bowlingCard.B || []).find(r => r.name === name) || {};
const clipNow = (w) => w.clips.docs[0];

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const input = (o) => Object.assign({ runsOffBat: 0, extras: 0, extraType: 'none', wicket: false, striker: 'Amit', strikerId: 'pA', nonStriker: 'Bharat', nonStrikerId: 'pB', bowler: 'Bowler One', bowlerId: 'b1' }, o);

(async () => {
  console.log('\n=== Case 1 — 12.6 FOUR → SIX ===');
  {
    const w = freshWorld(); const api = build(w);
    const scoreBefore = (await api.buildLiveCardsFromBallsArray(w.balls.docs)).scoreA.runs;
    const r = await api.runClipEdit(ownerReq(w, { delivery: input({ runsOffBat: 6 }) }), false);
    eq('saved', [r.status, r.body.success], [200, true]);
    eq('team score +2', rec(w).scoreA.runs, scoreBefore + 2);
    eq('Amit runs include the 6, fours→0 sixes→1', [batRow(w, 'Amit').sixes, batRow(w, 'Amit').fours], [1, 0]);
    eq('clip is a SIX now, same clipId/video', [clipNow(w).eventType, clipNow(w).clipId, clipNow(w).r2Url, clipNow(w).driveUrl], ['SIX', 'M1_FOUR_111', 'https://r2/M1_FOUR_111.mp4', 'https://drive/abc']);
    eq('delivery row is kind 6', w.balls.docs.find(b => b.ballUid === w.last.ballUid).kind, '6');
    const ev = w.emits.find(e => e.ev === 'cricketDeliveryCorrected');
    eq('live views told (room-M1), +2 runs for Amit', ev && [ev.room, ev.payload.delta.team.runs, ev.payload.delta.batting.find(b => b.name === 'Amit').runs], ['room-M1', 2, 2]);
    eq('audited as a delivery correction (undo-able)', w.audits[0] && [w.audits[0][1], w.audits[0][5].via], ['Owner delivery correction', 'advanced-clip-editor']);
  }

  console.log('\n=== Case 2 — 12.6 Run Out, dismissed B → A ===');
  {
    const w = freshWorld(); const api = build(w);
    // first make it a run out of Bharat (non-striker)
    let r = await api.runClipEdit(ownerReq(w, { delivery: input({ wicket: true, dismissalType: 'Run Out', dismissed: 'nonStriker', fielder: 'Fielder X', fielderId: 'f1' }) }), false);
    eq('run out of Bharat saved', [r.status, batRow(w, 'Bharat').out, clipNow(w).dismissedPlayerName, clipNow(w).eventType], [200, true, 'Bharat', 'WICKET']);
    r = await api.runClipEdit(ownerReq(w, { delivery: input({ wicket: true, dismissalType: 'Run Out', dismissed: 'striker', fielder: 'Fielder X', fielderId: 'f1' }) }), false);
    eq('now Amit is out, Bharat not out', [batRow(w, 'Amit').out, !!batRow(w, 'Bharat').out], [true, false]);
    const d = w.balls.docs.find(b => b.ballUid === w.last.ballUid).dismissal;
    eq('delivery stores the dismissed batter + roster id', [d.batter, d.batterId], ['Amit', 'pA']);
    eq('clip belongs to Amit now', [clipNow(w).dismissedPlayerName, clipNow(w).dismissedPlayerKey], ['Amit', 'amit']);
    eq('run out → no bowler wicket', bowlRow(w, 'Bowler One').wickets, 0);
  }

  console.log('\n=== Case 3 — 12.6 WICKET: batsman A→C, bowler B→D ===');
  {
    const w = freshWorld(); const api = build(w);
    const r = await api.runClipEdit(ownerReq(w, { delivery: input({ wicket: true, dismissalType: 'Bowled', striker: 'Chetan', strikerId: 'pC', bowler: 'Dev', bowlerId: 'b4' }) }), false);
    eq('saved', r.status, 200);
    const b = w.balls.docs.find(x => x.ballUid === w.last.ballUid);
    eq('delivery: Chetan bowled by Dev, ids', [b.striker, b.strikerId, b.bowler, b.bowlerId, b.dismissal.batter, b.dismissal.batterId], ['Chetan', 'pC', 'Dev', 'b4', 'Chetan', 'pC']);
    eq('global player ids re-resolved', [b.strikerPlayerId, b.bowlerPlayerId, b.dismissedPlayerId], ['gp:pC', 'gp:b4', 'gp:pC']);
    eq('scorecard: Chetan out b Dev, Dev 1 wicket, Bowler One 0', [batRow(w, 'Chetan').out, bowlRow(w, 'Dev').wickets, bowlRow(w, 'Bowler One').wickets || 0], [true, 1, 0]);
    eq('clip: Chetan / Dev / WICKET', [clipNow(w).strikerName, clipNow(w).bowlerName, clipNow(w).dismissedPlayerName, clipNow(w).eventType, clipNow(w).bowlerPlayerId], ['Chetan', 'Dev', 'Chetan', 'WICKET', 'gp:b4']);
  }

  console.log('\n=== Case 4 / 5 — Caught → Run Out → Bowled (bowler credit) ===');
  {
    const w = freshWorld(); const api = build(w);
    await api.runClipEdit(ownerReq(w, { delivery: input({ wicket: true, dismissalType: 'Caught', fielder: 'Fielder X', fielderId: 'f1' }) }), false);
    eq('caught: bowler +1, fielder kept', [bowlRow(w, 'Bowler One').wickets, clipNow(w).fielderName], [1, 'Fielder X']);
    await api.runClipEdit(ownerReq(w, { delivery: input({ wicket: true, dismissalType: 'Run Out', dismissed: 'striker', fielder: 'Fielder X', fielderId: 'f1' }) }), false);
    eq('caught → run out: bowler credit 0', bowlRow(w, 'Bowler One').wickets, 0);
    await api.runClipEdit(ownerReq(w, { delivery: input({ wicket: true, dismissalType: 'Bowled' }) }), false);
    eq('run out → bowled: bowler credit 1, no fielder', [bowlRow(w, 'Bowler One').wickets, clipNow(w).fielderName], [1, null]);
    const r = await api.runClipEdit(ownerReq(w, { delivery: input({ wicket: true, dismissalType: 'Caught' }) }), false);
    eq('caught with no fielder is refused', [r.status, /fielder/i.test(r.body.error)], [400, true]);
  }

  console.log('\n=== Case 6 — batsman + bowler + event in one save ===');
  {
    const w = freshWorld(); const api = build(w);
    const r = await api.runClipEdit(ownerReq(w, { delivery: input({ runsOffBat: 6, striker: 'Chetan', strikerId: 'pC', bowler: 'Dev', bowlerId: 'b4' }), isHighlight: false }), false);
    eq('saved', r.status, 200);
    eq('Amit lost the 4, Chetan got the 6', [batRow(w, 'Amit').fours, batRow(w, 'Chetan').sixes, batRow(w, 'Chetan').runs], [0, 1, 6]);
    eq('Dev charged 6, Bowler One not', [bowlRow(w, 'Dev').runs, bowlRow(w, 'Bowler One').runs], [6, 4]);
    eq('clip: SIX by Chetan off Dev, hidden from highlights', [clipNow(w).eventType, clipNow(w).strikerName, clipNow(w).bowlerName, clipNow(w).isHighlight], ['SIX', 'Chetan', 'Dev', false]);
  }

  console.log('\n=== Case 7 — last ball of the over: the next over is untouched ===');
  {
    const w = freshWorld(); const api = build(w);
    const nextBefore = JSON.stringify(w.balls.docs.find(b => b.ballUid === w.next.ballUid));
    await api.runClipEdit(ownerReq(w, { delivery: input({ wicket: true, dismissalType: 'Run Out', dismissed: 'nonStriker' }) }), false);
    eq('13.1 delivery unchanged', JSON.stringify(w.balls.docs.find(b => b.ballUid === w.next.ballUid)), nextBefore);
    eq('12.6 keeps its own players and bowler', (({ striker, nonStriker, bowler, over, ballInOver }) => [striker, nonStriker, bowler, over, ballInOver])(w.balls.docs.find(b => b.ballUid === w.last.ballUid)), ['Amit', 'Bharat', 'Bowler One', 12, 6]);
    eq('Bowler Two figures untouched', [bowlRow(w, 'Bowler Two').runs, bowlRow(w, 'Bowler Two').balls], [1, 1]);
  }

  console.log('\n=== Case 8 — an old delivery several overs back ===');
  {
    const later = [];
    for(let o = 14; o <= 17; o++) for(let bb = 1; bb <= 6; bb++) later.push(ball({ over: o, ballInOver: bb, kind: '1', runs: 1, striker: bb % 2 ? 'Amit' : 'Bharat', nonStriker: bb % 2 ? 'Bharat' : 'Amit', strikerId: bb % 2 ? 'pA' : 'pB', nonStrikerId: bb % 2 ? 'pB' : 'pA', bowler: o % 2 ? 'Bowler One' : 'Bowler Two', bowlerId: o % 2 ? 'b1' : 'b2' }));
    const w = freshWorld(later); const api = build(w);
    const laterBefore = JSON.stringify(w.balls.docs.filter(b => b.over >= 13));
    await api.runClipEdit(ownerReq(w, { delivery: input({ runsOffBat: 6 }) }), false);
    eq('every later delivery untouched', JSON.stringify(w.balls.docs.filter(b => b.over >= 13)), laterBefore);
    const ev = w.emits.find(e => e.ev === 'cricketDeliveryCorrected').payload;
    eq('only Amit (+2, 4→6) and Bowler One (+2) change', [ev.delta.batting.map(b => b.name), ev.delta.bowling.map(b => [b.name, b.runs])], [['Amit'], [['Bowler One', 2]]]);
  }

  console.log('\n=== Validation ===');
  {
    const w = freshWorld(); const api = build(w);
    let r = await api.runClipEdit(ownerReq(w, { delivery: input({ bowler: 'Chetan', bowlerId: 'pC' }) }), true);
    eq('a batting-side bowler is refused (squad check)', [r.status, /not part of the bowling team/.test(r.body.error)], [400, true]);
    r = await api.runClipEdit(ownerReq(w, { delivery: input({ extraType: 'wide', extras: 1 }) }), false);
    eq('live match: legal ball → wide refused', [r.status, /still being scored/.test(r.body.error)], [400, true]);
    r = await api.runClipEdit(ownerReq(w, { delivery: input({ wicket: true, dismissalType: 'Bowled', runsOffBat: 2 }) }), false);
    eq('bowled with runs refused (same rules as Edit Delivery)', [r.status, /delivery dead/.test(r.body.error)], [400, true]);
    eq('nothing was written by refused edits', w.balls.docs.find(b => b.ballUid === w.last.ballUid).kind, '4');
    const p = await api.runClipEdit(ownerReq(w, { delivery: input({ runsOffBat: 6 }) }), true);
    eq('preview shows the change but writes nothing', [p.status, p.body.after.ball.kind, w.balls.docs.find(b => b.ballUid === w.last.ballUid).kind, p.body.clipsAfter[0].eventType], [200, '6', '4', 'SIX']);
  }

  console.log('\n=== Atomic: a failing scorecard rebuild rolls everything back ===');
  {
    const w = freshWorld(); const api = build(w);
    w.failSync = true;
    const r = await api.runClipEdit(ownerReq(w, { delivery: input({ runsOffBat: 6 }) }), false);
    eq('refused, delivery and clip unchanged', [r.status, w.balls.docs.find(b => b.ballUid === w.last.ballUid).kind, clipNow(w).eventType], [409, '4', 'FOUR']);
  }

  console.log('\n=== Case 9 — another Gmail gets 403 and nothing changes ===');
  {
    const w = freshWorld(); const api = build(w);
    const res = { code: 200, body: null, status(c){ this.code = c; return this; }, json(b){ this.body = b; return this; } };
    let reached = false;
    await api.requireOwner({ headers: { authorization: 'Bearer other-token' }, body: { email: 'chhayajeeth@gmail.com', isOwner: true }, query: {} }, res, () => { reached = true; });
    eq('other account: 403, handler never runs', [res.code, reached], [403, false]);
    const res2 = { code: 200, status(c){ this.code = c; return this; }, json(){ return this; } };
    let reached2 = false;
    await api.requireOwner({ headers: {}, body: { email: 'chhayajeeth@gmail.com' }, query: {} }, res2, () => { reached2 = true; });
    eq('no token + a forged body email: 403', [res2.code, reached2], [403, false]);
    let reached3 = false;
    await api.requireOwner({ headers: { authorization: 'Bearer owner-token' }, body: {}, query: {} }, res2, () => { reached3 = true; });
    eq('owner token passes', reached3, true);
    eq('clip edit routes are on the owner-only router', [/adminRouter\.put\('\/clips\/:clipId\/edit'/.test(src), /adminRouter\.post\('\/clips\/:clipId\/edit\/preview'/.test(src), /adminRouter\.get\('\/clips\/:clipId\/editor'/.test(src), /adminRouter\.use\(requireOwner\)/.test(src)], [true, true, true, true]);
  }

  console.log('\n=== The older Edit Delivery path keeps working on old data ===');
  {
    const w = freshWorld(); const api = build(w);
    const old = w.balls.docs.find(b => b.over === 12 && b.ballInOver === 2);
    old.bowler = ''; old.bowlerKey = ''; old.dismissal = { type: 'Run Out', fielder: null }; old.kind = 'W'; old.runs = 0;
    const r = await api.correctDelivery(String(old._id), 'chhayajeeth@gmail.com', { runsOffBat: 1, extras: 0, extraType: 'none', wicket: true, dismissalType: 'Run Out' }, false, 'owner');
    eq('a delivery scored with no bowler can still be corrected', [r.errors.length, w.balls.docs.find(b => b._id.equals(old._id)).runs], [0, 1]);
    eq('an old run out with no named batter stays unnamed', w.balls.docs.find(b => b._id.equals(old._id)).dismissal.batter, null);
  }

  console.log('\n=== Finished match: corrected state pushed to the live room ===');
  {
    const w = freshWorld(); const api = build(w);
    rec(w).winningTeam = 'A';
    await api.runClipEdit(ownerReq(w, { delivery: input({ runsOffBat: 6 }) }), false);
    const push = w.emits.find(e => e.ev === 'liveCricketScore');
    const ev = w.emits.find(e => e.ev === 'cricketDeliveryCorrected');
    eq('state pushed BEFORE the event, already marked applied', [!!push, w.emits.indexOf(push) < w.emits.indexOf(ev), push && push.payload.appliedCorrections.includes(ev.payload.id)], [true, true, true]);
  }

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
