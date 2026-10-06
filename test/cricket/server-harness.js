// Shared harness for tests that run REAL server.js functions (extracted by
// name, never copied) against an in-memory stand-in for MongoDB.
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
function coll(docs, world){
  docs = docs || [];
  const fail = (op) => { if(world && world.failOn === op) throw new Error('db down: ' + op); };
  return {
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
    insertOne: async (doc) => { fail('insertOne'); if(!doc._id) doc._id = new ObjectId(); docs.push(clone(doc)); return { insertedId: doc._id }; },
    deleteOne: async (q) => { const i = docs.findIndex(d => matches(d, q)); if(i >= 0) docs.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
    replaceOne: async (q, doc) => { const i = docs.findIndex(d => matches(d, q)); if(i >= 0) docs[i] = clone(doc); return { matchedCount: i >= 0 ? 1 : 0 }; },
    updateOne: async (q, u) => { fail('updateOne'); const d = docs.find(x => matches(x, q)); if(d && u.$set) Object.assign(d, clone(u.$set)); return { matchedCount: d ? 1 : 0 }; },
    updateMany: async (q, u) => { docs.filter(x => matches(x, q)).forEach(d => Object.assign(d, clone(u.$set))); return {}; },
    bulkWrite: async (ops) => { fail('bulkWrite'); for(const op of ops){ if(op.replaceOne){ const i = docs.findIndex(d => matches(d, op.replaceOne.filter)); if(i >= 0) docs[i] = clone(op.replaceOne.replacement); } if(op.updateOne){ const d = docs.find(x => matches(x, op.updateOne.filter)); if(d && op.updateOne.update.$set) Object.assign(d, clone(op.updateOne.update.$set)); } } return {}; },
  };
}

// world: { balls, clips, records, archive, rooms, emits, audits, liveState?, failSync?, failOn? }
function build(world, fnNames, asyncNames, constNames){
  const code = [
    ...(constNames || []).map(grabConst),
    ...fnNames.map(n => grab(n)), ...asyncNames.map(n => grab(n, 'async function ')),
    'return { ' + [...fnNames, ...asyncNames].join(', ') + ' };'
  ].join('\n');
  const deps = {
    process: { env: {} },
    ballsCollection: world.balls, clipsCollection: world.clips, matchRecordsCollection: world.records,
    ballsArchiveCollection: world.archive || null,
    ClipAttribution: require('../../clip-attribution.js'),
    resolvePlayerId: async (o, name) => name ? 'gp:' + String(name).toLowerCase() : null,
    resolvePlayerIdExplicit: async (o, id, name) => id ? 'gp:' + id : (name ? 'gp:' + String(name).toLowerCase() : null),
    syncMatchRecordFromBalls: async (uid, matchId) => {
      if(world.failSync) throw new Error('sync down');
      const balls = world.balls.docs.filter(b => b.matchId === matchId).map(clone);
      const cards = deps.__api.buildLiveCardsFromBallsArray(balls);
      const rec = world.records.docs.find(r => r.matchId === matchId);
      if(rec) Object.assign(rec, { battingCard: cards.battingCard, bowlingCard: cards.bowlingCard, scoreA: cards.scoreA, scoreB: cards.scoreB, extras: cards.extras, fallOfWickets: cards.fallOfWickets });
      world.syncs = (world.syncs || 0) + 1;
    },
    buildLiveCardsFromBalls: async (matchId) => deps.__api.buildLiveCardsFromBallsArray(world.balls.docs.filter(b => b.matchId === matchId).map(clone)),
    getRoomState: async (room) => (world.rooms[room] = world.rooms[room] || { cricketState: world.liveState || null }),
    io: { to: (room) => ({ emit: (ev, payload) => world.emits.push({ room, ev, payload }) }) },
    db: { collection: () => ({ doc: () => ({ set: async () => {} }) }) },
    invalidateClipsCache: () => {},
    scheduleMatchRecordSync: (uid, matchId, opts) => { world.scheduledSyncs = (world.scheduledSyncs || 0) + 1; return deps.syncMatchRecordFromBalls(uid, matchId, opts); },
    resolveOwnerUidForMatch: async (matchId, hint) => hint || null,
    logAuditAction: async (...a) => world.audits.push(a),
    verifyIdTokenFull: async (t) => t === 'owner-token' ? { email: 'chhayajeeth@gmail.com', uid: 'owner' } : t === 'other-token' ? { email: 'someone@gmail.com', uid: 'x' } : null,
    require: (m) => m === 'mongodb' ? { ObjectId } : require(m),
    console: { log: () => {} },
    __api: null,
  };
  deps.__api = new Function(...Object.keys(deps), code)(...Object.values(deps));
  return deps.__api;
}

module.exports = { src, grab, grabConst, clone, coll, build, ObjectId };
