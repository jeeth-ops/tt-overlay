/* 🪦 A clip the owner deletes on the scorecard stays deleted.

   The REAL server.js (test/server-boot.js: in-memory MongoDB, an owner
   sign-in) with a stand-in Cloudflare R2 bucket that records every upload
   and delete. A clip is sent the way the Clipper helper / Stream Engine
   send it, the owner deletes it, and then everything that used to bring it
   back is tried: the same clip sent again, its status asked for (the helper
   used to read "not found" as "the website lost it" and re-send), a late
   attach / classify, and a manual "replace" of a clip on the same ball.

     NODE_PATH=$(npm root -g) node test/cricket/clip-delete-test.js
*/
const http = require('http');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- the stand-in R2 bucket (installed before server.js loads) ----
const bucket = new Map();           // key -> bytes
const r2Log = [];                   // 'PUT key' / 'DELETE key', in order
const refuseDelete = new Set();     // keys whose next delete fails (R2 down for a moment)
class Cmd { constructor(input){ this.input = input; } }
class PutObjectCommand extends Cmd {}
class DeleteObjectCommand extends Cmd {}
class GetObjectCommand extends Cmd {}
class S3Client {
  async send(cmd){
    const k = cmd.input.Key;
    if(cmd instanceof PutObjectCommand){ bucket.set(k, cmd.input.Body.length); r2Log.push('PUT ' + k); return {}; }
    if(cmd instanceof DeleteObjectCommand){
      if(refuseDelete.delete(k)) throw new Error('R2 is not answering');
      bucket.delete(k); r2Log.push('DELETE ' + k); return {};
    }
    const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e;
  }
}
const s3Path = require.resolve('@aws-sdk/client-s3');
require.cache[s3Path] = { id: s3Path, filename: s3Path, loaded: true, exports: { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } };
Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET_NAME: 'clips', R2_PUBLIC_URL: 'https://clips.example.test' });

const { bootServer } = require('../server-boot.js');
const OWNER = { email: process.env.OWNER_EMAIL || 'chhayajeeth@gmail.com', uid: 'owner' };

function call(port, method, path, { json, raw, headers } = {}){
  return new Promise((resolve, reject) => {
    const body = raw || (json ? Buffer.from(JSON.stringify(json)) : null);
    const h = Object.assign({}, json ? { 'Content-Type': 'application/json' } : raw ? { 'Content-Type': 'video/mp4' } : {}, body ? { 'Content-Length': body.length } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch(e){} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if(body) r.write(body);
    r.end();
  });
}

(async () => {
  const { port, mem } = await bootServer({ idTokens: { 'owner-token': OWNER, 'other-token': { email: 'someone@gmail.com', uid: 'x' } } });
  const owner = { Authorization: 'Bearer owner-token' };
  const M = 'CLIPDEL' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const bytes = Buffer.alloc(4096, 7);
  const send = (clipId, eventType, ts, ballMeta) => call(port, 'POST', `/api/clips/ingest?matchId=${M}&eventType=${eventType}&timestamp=${ts}&clipId=${clipId}`,
    { raw: bytes, headers: ballMeta ? { 'X-Ball-Meta': JSON.stringify(ballMeta) } : {} });
  const status = (clipId) => call(port, 'GET', `/api/clips/status/${clipId}`);
  const listed = async () => ((await call(port, 'GET', `/api/clips/match/${M}?all=1`)).json.clips || []);
  const keysOf = (clipId) => [...bucket.keys()].filter(k => k.includes(clipId)).sort();
  const until = async (fn, ok, ms) => { const end = Date.now() + (ms || 8000); let v; while(Date.now() < end){ v = await fn(); if(ok(v)) return v; await sleep(80); } return v; };

  console.log('\n######## 1. A clip comes in, the owner deletes it ########');
  const T = Date.now(), C = `${M}_FOUR_${T}`;
  eq('the clip is received', (await send(C, 'FOUR', T, { innings: 1, over: 2, ballInOver: 3, striker: 'Rohit Sharma', bowler: 'Mitchell Starc' })).json.success, true);
  await until(() => status(C), r => r.json && r.json.r2Status === 'uploaded');
  bucket.set(`matches/${M}/clips/${C}.jpg`, 10);   // (its poster: written under this key whenever ffmpeg can make one)
  let clips = await listed();
  eq('…on the scorecard, and on R2 (video + poster)', [clips.length, keysOf(C)], [1, [`matches/${M}/clips/${C}.jpg`, `matches/${M}/clips/${C}.mp4`]]);
  const id = clips[0].clipId;

  eq('someone else cannot delete it', (await call(port, 'DELETE', `/api/admin/clips/${id}`, { headers: { Authorization: 'Bearer other-token' } })).status, 403);
  const del = await call(port, 'DELETE', `/api/admin/clips/${id}`, { headers: owner });
  eq('the owner deletes it → gone from the scorecard', [del.status, del.json.success, (await listed()).length], [200, true, 0]);
  eq('…and from Cloudflare R2: the video AND its poster', [keysOf(C), del.json.storage.r2], [[], 'deleted']);
  const mark = await mem.collection('deletedClips').findOne({ clipId: C });
  eq('…remembered as deleted', [!!mark, mark && mark.matchId], [true, M]);

  console.log('\n######## 2. Everything that used to bring it back ########');
  const putsBefore = r2Log.filter(l => l.startsWith('PUT')).length;
  const again = await send(C, 'FOUR', T, { innings: 1, over: 2, ballInOver: 3 });
  eq('the same clip sent again (helper / Stream Engine retry) → acknowledged as deleted, so the sender stops', [again.status, again.json.success, again.json.deleted], [200, true, true]);
  await sleep(600);
  eq('…and dropped: not on the scorecard, nothing uploaded to R2', [(await listed()).length, keysOf(C), r2Log.filter(l => l.startsWith('PUT')).length - putsBefore], [0, [], 0]);
  const st = await status(C);
  eq('its status says DELETED (never a 404, which the helper read as "website lost it — re-send")', [st.status, st.json.status, st.json.deleted], [200, 'DELETED', true]);
  eq('…with nothing left to send, so an older helper stops too', [st.json.r2Status, st.json.driveStatus], ['uploaded', 'uploaded']);
  const att = await call(port, 'POST', '/api/clips/attach', { json: { clipMeta: { matchId: M, clipId: C, eventType: 'FOUR', innings: 1, over: 2, ballInOver: 3 } } });
  eq('a late attach (the helper\'s last stage) → acknowledged, never re-creates it', [att.json.success, att.json.deleted, !!(await mem.collection('clips').findOne({ clipId: C }))], [true, true, false]);
  const W = `${M}_WICKET_${T + 1}`;
  await send(W, 'WICKET', T + 1, { innings: 1, over: 4, ballInOver: 1 });
  await until(() => status(W), r => r.json && r.json.r2Status === 'uploaded');
  const wid = (await listed()).find(c => c.eventType === 'WICKET').clipId;
  await call(port, 'DELETE', `/api/admin/clips/${wid}`, { headers: owner });
  const cls = await call(port, 'POST', '/api/clips/classify', { json: { clipId: W, matchId: M, isHighlight: true, eventType: 'WICKET', ballMeta: { innings: 1, over: 4, ballInOver: 1 } } });
  eq('a late classify of a deleted wicket clip → acknowledged, never re-created', [cls.json.success, cls.json.deleted, !!(await mem.collection('clips').findOne({ clipId: W }))], [true, true, false]);

  console.log('\n######## 3. Replacing a clip deletes the old one for good too ########');
  const T2 = T + 2, S = `${M}_SIX_${T2}`;
  await send(S, 'SIX', T2, { innings: 1, over: 3, ballInOver: 2 });
  await until(() => status(S), r => r.json && r.json.r2Status === 'uploaded');
  const rep = await call(port, 'POST', `/api/admin/clips/attach/upload?matchId=${M}&eventType=SIX&innings=1&over=3&ballInOver=2&replace=true`, { raw: bytes, headers: owner });
  eq('the owner replaces the clip on that ball', rep.json && rep.json.success, true);
  eq('…the replaced clip is remembered as deleted and off R2', [!!(await mem.collection('deletedClips').findOne({ clipId: S })), keysOf(S)], [true, []]);
  eq('…so the helper sending it again cannot bring it back', [(await send(S, 'SIX', T2)).json.deleted, (await listed()).filter(c => c.eventType === 'SIX').length], [true, 1]);

  console.log('\n######## 4. R2 refusing a delete for a moment ########');
  const T3 = T + 3, F = `${M}_FOUR_${T3}`;
  await send(F, 'FOUR', T3, { innings: 1, over: 5, ballInOver: 1 });
  await until(() => status(F), r => r.json && r.json.r2Status === 'uploaded');
  const fid = (await listed()).find(c => c.over === 5).clipId;
  refuseDelete.add(`matches/${M}/clips/${F}.mp4`);
  const d2 = await call(port, 'DELETE', `/api/admin/clips/${fid}`, { headers: owner });
  const m2 = await mem.collection('deletedClips').findOne({ clipId: F });
  eq('the clip is still deleted at once (off the scorecard), and what R2 kept is listed for the retry sweep',
    [d2.json.success, (await listed()).some(c => c.over === 5), d2.json.storage.r2, m2.cleanupPending, m2.r2Left], [true, false, 'failed', true, [`matches/${M}/clips/${F}.mp4`]]);

  // (the server's own temporary copies of this test's clips)
  require('fs').rmSync(require('path').join(__dirname, '..', '..', 'clips', M), { recursive: true, force: true });
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
