// 🖼️ Tournament thumbnails + the homepage's sport tabs — the REAL server.js
// over HTTP (in-memory MongoDB, Firebase tokens mapped to the test accounts,
// R2 stood in for by an in-memory bucket):
//   • the tournament list carries Cricket, Football and Table Tennis, each
//     tournament once, its sport normalised ('tt' → tabletennis, a legacy doc
//     placed by its name, a sport without a tab left out), TT names without
//     the panel's "TT::"; private ones still never reach a visitor
//   • only chhayajeeth@gmail.com may set / move / remove a thumbnail — 403
//     for signed out, the other creators, any other Gmail, an unverified
//     token, whatever the request claims about who it is
//   • the picture is checked by its own bytes (JPEG / PNG / WebP, real
//     size), too big / too small / not a picture refused; stored in R2 under
//     a random key, the doc keeps only a reference; a portrait picture is
//     kept whole (the card crops it, centred where the owner set)
//   • replace removes the old object; remove brings the fallback back and
//     removes the object; deleting the tournament removes it too
//   • a failed upload or a failed save leaves the old picture exactly as it
//     was, with nothing left behind in storage; a stale edit (older version)
//     is refused, never overwrites the newer picture
//   • every change is in the audit log
//   • the picture's own colours are read at upload (the most vivid hue and a
//     second one far from it; [] for a grey picture; null when it cannot be
//     read) and reach the homepage list and the tournament page, which now
//     carries the picture and the sport too; a picture saved before that gets
//     its colours the first time its tournament is shown — read back from
//     storage once per run, never written onto a newer picture; a private
//     tournament still never reaches a visitor
//
//   node test/tournament-thumbnails-server.test.js     (needs the repo's npm install)
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const F = require('./merge-fixtures.js');

let pass = 0, fail = 0;
function eq(name, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}

// ---- R2, stood in for: an in-memory bucket behind the real S3 client ----
const BUCKET = new Map(), BODIES = new Map();
const GOT = new Map();   // how many times each object was read back
let failNextPut = false, gate = null;
const got = (key) => GOT.get(key) || 0;
const s3 = require('@aws-sdk/client-s3');
s3.S3Client.prototype.send = async function (cmd) {
  const input = cmd.input || {};
  if (cmd instanceof s3.PutObjectCommand) {
    if (failNextPut) { failNextPut = false; throw new Error('R2 is down'); }
    BUCKET.set(input.Key, { type: input.ContentType, cache: input.CacheControl, bytes: input.Body.length, bucket: input.Bucket });
    BODIES.set(input.Key, Buffer.from(input.Body));
  } else if (cmd instanceof s3.GetObjectCommand) {
    GOT.set(input.Key, got(input.Key) + 1);
    const bytes = BODIES.get(input.Key);
    if (gate) await gate;
    if (!bytes) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
  } else if (cmd instanceof s3.DeleteObjectCommand) {
    BUCKET.delete(input.Key); BODIES.delete(input.Key);
  }
  return {};
};
Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET_NAME: 'asl-test', R2_PUBLIC_URL: 'https://cdn.asl.test', TOURNAMENT_THUMB_MAX_BYTES: '300000' });

// ---- pictures: real files from the repo, and a PNG made here ----
const ROOT = path.join(__dirname, '..');
const file = (p) => fs.readFileSync(path.join(ROOT, p));
const JPEG = file('assets/home/og-image.jpg');            // 1200 × 630
const WEBP = file('assets/home/walk-six.webp');           // 720 × 405 (VP8)
const PORTRAIT = file('assets/home/walk-player.webp');    // 645 × 1398
const SMALL_PNG = file('logo.png');                       // 307 × 307
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, paint = () => [0x40, 0x40, 0x40]) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) row.set(paint(x), 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(1600, 900);                               // grey
const ORANGE = [0xe8, 0x61, 0x1a], BLUE = [0x1f, 0x5f, 0xd6], GREEN = [0x2a, 0xa8, 0x4a], MAGENTA = [0xc2, 0x2a, 0x8c];
const ORANGE_BLUE = png(1600, 900, (x) => (x < 1100 ? ORANGE : BLUE));       // mostly orange
const GREEN_MAGENTA = png(1280, 720, (x) => (x < 640 ? GREEN : MAGENTA));   // magenta is the more vivid half
const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
// colours read from a picture, each channel within a hair of what was painted
const near = (got, want) => Array.isArray(got) && got.length === want.length && got.every((c, i) => /^#[0-9a-f]{6}$/.test(c) &&
  [1, 3, 5].every((k) => Math.abs(parseInt(c.slice(k, k + 2), 16) - parseInt(want[i].slice(k, k + 2), 16)) <= 6));
const vp8l = (w, h) => { const b = Buffer.alloc(64); b.write('RIFF', 0); b.writeUInt32LE(56, 4); b.write('WEBPVP8L', 8); b.writeUInt32LE(40, 16); b[20] = 0x2f; b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21); return b; };

const DAY = 24 * 60 * 60 * 1000;
(async () => {
  const { bootServer } = require('./merge-server-boot.js');
  const { c, mem, req, port } = await bootServer(async (c) => {
    const work = F.USERS.work.uid, owner = F.USERS.owner.uid;
    const league = async (o, sport) => { const d = await F.addLeague(c, o); if (sport === undefined) await c.leagues.updateOne({ _id: d._id }, { $unset: { sport: '' } }); else await c.leagues.updateOne({ _id: d._id }, { $set: { sport } }); return d; };
    await league({ ownerUid: work, leagueKey: 'pub cup', name: 'Pub Cup', token: 'tokPub' }, 'cricket');
    await league({ ownerUid: work, leagueKey: 'tt::city open', name: 'TT::City Open', token: 'tokTT' }, 'tt');
    await league({ ownerUid: work, leagueKey: 'juhu football league', name: 'Juhu Football League', token: 'tokFB' }, 'football');
    await league({ ownerUid: work, leagueKey: 'monsoon kabaddi', name: 'Monsoon Kabaddi', token: 'tokKB' }, 'kabaddi');
    await league({ ownerUid: work, leagueKey: 'table tennis masters', name: 'Table Tennis Masters', token: 'tokTTM' }, undefined);   // saved before `sport` existed
    await league({ ownerUid: owner, leagueKey: 'own cup', name: 'Own Cup', token: 'tokOwn' }, 'cricket');                          // the owner's own: private
    await c.records.insertOne({ _id: new F.ObjectId(), ownerUid: work, leagueKey: 'tt::city open', matchId: 'tt1', sport: 'tt', savedAt: new Date(Date.now() - DAY).toISOString(),
      teamA: { name: 'Arjun Mehta' }, teamB: { name: 'Kabir Rao' }, winningTeam: 'A', scoreA: { sets: 3 }, scoreB: { sets: 1 }, streamUrl: 'https://youtu.be/TTVIDEO0001' });
    await c.records.insertOne({ _id: new F.ObjectId(), ownerUid: work, leagueKey: 'pub cup', matchId: 'c1', savedAt: new Date(Date.now() - DAY).toISOString(), format: 'T20',
      teamA: { name: 'Dr DY Patil', short: 'DYP' }, teamB: { name: 'New Cricket Club', short: 'NCC' }, winningTeam: 'A', streamUrl: 'https://youtu.be/CRICKVIDEO1',
      scoreA: { runs: 150, wickets: 5, overs: '20.0' }, scoreB: { runs: 140, wickets: 9, overs: '20.0' }, battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] } });
  });
  // a picture (or anything) PUT as the request body
  const put = (url, body, type, token) => new Promise((resolve, reject) => {
    let answered = false;
    const r = http.request({ host: '127.0.0.1', port, method: 'PUT', path: url, headers: Object.assign({ 'Content-Type': type, 'Content-Length': body.length }, token ? { Authorization: 'Bearer ' + token } : {}) }, (res) => {
      answered = true;
      let buf = ''; res.on('data', (ch) => { buf += ch; }); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    // a refusal can close the connection before the whole body is sent
    r.on('error', (e) => { if (!answered) reject(e); }); r.write(body); r.end();
  });
  const T = (league) => `/api/admin/tournaments/${encodeURIComponent(F.USERS.work.uid)}/${encodeURIComponent(league)}/thumbnail`;
  const PUB = T('pub cup');
  const list = async (token) => (await req('GET', '/api/public/tournaments', null, token)).json;
  const one = (j, token) => j.tournaments.find((t) => t.token === token);
  const doc = (leagueKey) => c.leagues.findOne({ leagueKey });

  console.log('\n=== the list: three sports ===');
  let j = await list();
  eq('a visitor: every public tournament of the three sports, each once', j.tournaments.map((t) => [t.token, t.sport, t.name]).sort(),
    [['tokFB', 'football', 'Juhu Football League'], ['tokPub', 'cricket', 'Pub Cup'], ['tokTT', 'tabletennis', 'City Open'], ['tokTTM', 'tabletennis', 'Table Tennis Masters']]);
  eq('… "tt" saved by the TT panel reads Table Tennis, its "TT::" dropped from the name; a sport with no tab is left out', [one(j, 'tokTT').sport, one(j, 'tokTT').name, !!one(j, 'tokKB')], ['tabletennis', 'City Open', false]);
  eq('… the owner\'s private tournament never reaches a visitor', !!one(j, 'tokOwn'), false);
  eq('… Latest streams come from the cricket matches only', [one(j, 'tokPub').streams.map((s) => s.videoId), one(j, 'tokTT').streams], [['CRICKVIDEO1'], []]);
  eq('… no thumbnails yet', j.tournaments.map((t) => t.thumb), [null, null, null, null]);
  let own = await list('tok-owner');
  eq('the owner\'s view: their private one too, with the thumbnail version to edit from', [!!one(own, 'tokOwn'), one(own, 'tokPub').thumbV, one(own, 'tokPub').thumb], [true, 0, null]);
  const before = JSON.stringify(await c.leagues.find({}).toArray());

  console.log('\n=== only the owner ===');
  const statuses = [];
  for (const tok of [null, 'tok-work', 'tok-vinit', 'tok-other', 'tok-unverified']) {
    statuses.push((await put(PUB + '?expect=0', JPEG, 'image/jpeg', tok)).status);
    statuses.push((await req('POST', PUB + '/focus', { x: 10, y: 10, expect: 0 }, tok)).status);
    statuses.push((await req('DELETE', PUB + '?expect=0', null, tok)).status);
  }
  eq('signed out, the other creators, any other Gmail, an unverified token: refused on every route', [...new Set(statuses)], [403]);
  const spoof = await put(PUB + '?expect=0&email=chhayajeeth@gmail.com&isAdmin=true&uid=' + F.USERS.owner.uid, JPEG, 'image/jpeg', 'tok-other');
  const spoof2 = await req('POST', PUB + '/focus', { x: 1, y: 1, expect: 0, email: 'chhayajeeth@gmail.com', isAdmin: true }, 'tok-work');
  eq('… claiming to be the owner in the request changes nothing', [spoof.status, spoof2.status], [403, 403]);
  eq('… nothing stored, nothing changed', [BUCKET.size, JSON.stringify(await c.leagues.find({}).toArray()) === before], [0, true]);

  console.log('\n=== what counts as a picture ===');
  const bad = async (body, type, url = PUB + '?expect=0') => { const r = await put(url, body, type, 'tok-owner'); return [r.status, r.json && r.json.error]; };
  eq('no version to start from: refused', (await bad(JPEG, 'image/jpeg', PUB))[0], 400);
  eq('text sent as a PNG: refused by its bytes', await bad(Buffer.from('hello, this is not a picture at all.....'), 'image/png'), [415, 'That file is not a JPG, PNG or WebP picture']);
  eq('a GIF sent as WebP: refused by its bytes', (await bad(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(60)]), 'image/webp'))[0], 415);
  eq('anything but a picture type: refused', (await bad(JPEG, 'application/octet-stream'))[0], 415);
  eq('too small for a sharp card (307 × 307): refused, says the size', await bad(SMALL_PNG, 'image/png'), [422, 'That picture is too small for a sharp card — it needs at least 480 × 270']);
  eq('over the size limit: refused before it is read', await bad(Buffer.concat([PNG, Buffer.alloc(320000)]), 'image/png'), [413, 'That picture is too big — up to 293 KB']);
  eq('a tournament that does not exist: 404', (await bad(JPEG, 'image/jpeg', T('no such cup') + '?expect=0'))[0], 404);
  eq('the single-matches bucket: refused', (await bad(JPEG, 'image/jpeg', T('__single_matches__') + '?expect=0'))[0], 400);
  eq('… after all that: nothing stored, nothing changed', [BUCKET.size, JSON.stringify(await c.leagues.find({}).toArray()) === before], [0, true]);

  console.log('\n=== set ===');
  let r = await put(PUB + '?expect=0&x=50&y=30', JPEG, 'image/jpeg', 'tok-owner');
  let d = await doc('pub cup');
  eq('the owner sets a JPEG: stored, the doc points at it', [r.status, r.json.thumbV, d.thumbV, BUCKET.has(d.thumb.key)], [200, 1, 1, true]);
  eq('… a random key naming nothing, the real type and size, cached for good', [/^tournament-thumbs\/[0-9a-f]{24}\.jpg$/.test(d.thumb.key), BUCKET.get(d.thumb.key), [d.thumb.w, d.thumb.h, d.thumb.type, d.thumb.by]],
    [true, { type: 'image/jpeg', cache: 'public, max-age=31536000, immutable', bytes: JPEG.length, bucket: 'asl-test' }, [1200, 630, 'image/jpeg', 'chhayajeeth@gmail.com']]);
  eq('… the doc holds a reference, never the picture', JSON.stringify(d.thumb).length < 400, true);
  const pal = d.thumb.palette;
  eq('… and the picture\'s own colours, read as it was stored', Array.isArray(pal) && pal.length > 0 && pal.every((c) => /^#[0-9a-f]{6}$/.test(c)), true);
  j = await list();
  eq('everyone sees it at once: its URL, where the frame centres and its colours — no key, no uploader', one(j, 'tokPub').thumb, { url: 'https://cdn.asl.test/' + d.thumb.key, x: 50, y: 30, w: 1200, h: 630, palette: d.thumb.palette });
  const firstKey = d.thumb.key;

  console.log('\n=== replace, move, stale edits ===');
  r = await put(PUB + '?expect=1', PORTRAIT, 'image/png', 'tok-owner');   // a WebP, whatever the header says
  d = await doc('pub cup');
  eq('replace with a portrait WebP: kept whole (the card crops it), centred by default', [r.status, d.thumb.type, d.thumb.w, d.thumb.h, d.thumb.focus, d.thumbV], [200, 'image/webp', 645, 1398, { x: 50, y: 50 }, 2]);
  eq('… the old picture\'s object is gone, only the new one is stored', [BUCKET.has(firstKey), [...BUCKET.keys()]], [false, [d.thumb.key]]);
  const stale = await put(PUB + '?expect=1', WEBP, 'image/webp', 'tok-owner');
  eq('an edit from an older version (another tab): refused with the newest picture, nothing overwritten', [stale.status, stale.json.code, stale.json.thumbV, stale.json.thumb.url.endsWith(d.thumb.key)], [409, 'THUMB_CHANGED', 2, true]);
  eq('… and nothing left behind in storage', [...BUCKET.keys()], [d.thumb.key]);
  r = await req('POST', PUB + '/focus', { x: 50, y: 18.25, expect: 2 }, 'tok-owner');
  eq('move what the frame shows (the top of the portrait)', [r.status, r.json.thumb.y, r.json.thumbV, (await doc('pub cup')).thumb.focus], [200, 18.3, 3, { x: 50, y: 18.3 }]);
  eq('… a position outside the picture is held to its edge', (await req('POST', PUB + '/focus', { x: -40, y: 400, expect: 3 }, 'tok-owner')).json.thumb, { url: 'https://cdn.asl.test/' + d.thumb.key, x: 0, y: 100, w: 645, h: 1398, palette: d.thumb.palette });
  eq('… a stale move: refused', (await req('POST', PUB + '/focus', { x: 1, y: 1, expect: 3 }, 'tok-owner')).status, 409);
  eq('… everyone sees the new position', [one(await list(), 'tokPub').thumb.x, one(await list(), 'tokPub').thumb.y], [0, 100]);

  console.log('\n=== failures keep the old picture ===');
  const kept = JSON.stringify(await doc('pub cup'));
  failNextPut = true;
  r = await put(PUB + '?expect=4', PNG, 'image/png', 'tok-owner');
  eq('storage down: says so, the old picture stays, nothing new stored', [r.status, /old one is unchanged/.test(r.json.error), JSON.stringify(await doc('pub cup')) === kept, BUCKET.size], [502, true, true, 1]);
  mem.fail('leagues', 'updateOne', { times: 1 });
  r = await put(PUB + '?expect=4', PNG, 'image/png', 'tok-owner');
  eq('the database save fails after the upload: the old picture stays, the new object is removed again', [r.status, JSON.stringify(await doc('pub cup')) === kept, [...BUCKET.keys()]], [500, true, [d.thumb.key]]);
  mem.clearFaults();
  r = await put(PUB + '?expect=4', PNG, 'image/png', 'tok-owner');
  d = await doc('pub cup');
  eq('… and the retry works (a PNG this time)', [r.status, d.thumb.type, d.thumb.w, d.thumbV, BUCKET.size], [200, 'image/png', 1600, 5, 1]);
  eq('… a grey picture has no colours of its own: [] (the page uses the tournament\'s own)', [d.thumb.palette, r.json.thumb.palette], [[], []]);

  console.log('\n=== remove ===');
  const lastKey = d.thumb.key;
  eq('remove from a stale version: refused, the picture stays', [(await req('DELETE', PUB + '?expect=4', null, 'tok-owner')).status, BUCKET.has(lastKey)], [409, true]);
  r = await req('DELETE', PUB + '?expect=5', null, 'tok-owner');
  d = await doc('pub cup');
  eq('remove: the card falls back to its designed picture, the object is gone', [r.status, r.json.thumb, d.thumb, d.thumbV, BUCKET.size, one(await list(), 'tokPub').thumb], [200, null, undefined, 6, 0, null]);
  eq('… moving a picture that is not there: 404', (await req('POST', PUB + '/focus', { x: 1, y: 1, expect: 6 }, 'tok-owner')).status, 404);

  console.log('\n=== private, other sports, deleting a tournament ===');
  const OWN = `/api/admin/tournaments/${encodeURIComponent(F.USERS.owner.uid)}/own%20cup/thumbnail`;
  r = await put(OWN + '?expect=0', WEBP, 'image/webp', 'tok-owner');
  const ownDoc = await doc('own cup');
  eq('a thumbnail on the owner\'s private tournament: theirs to see, still nobody else\'s', [r.status, !!one(await list(), 'tokOwn'), !!one(await list('tok-owner'), 'tokOwn').thumb, ownDoc.thumb.key.includes('own') || ownDoc.thumb.key.includes('tokOwn')], [200, false, true, false]);
  r = await put(T('tt::city open') + '?expect=0', vp8l(1280, 720), 'image/webp', 'tok-owner');
  eq('a Table Tennis tournament gets one too (lossless WebP read by its own header)', [r.status, one(await list(), 'tokTT').thumb.w, one(await list(), 'tokTT').thumb.h], [200, 1280, 720]);
  const ttKey = (await doc('tt::city open')).thumb.key;
  const del = await req('DELETE', '/api/league/' + encodeURIComponent('TT::City Open') + '?uid=' + encodeURIComponent(F.USERS.work.uid), null, 'tok-work');
  await new Promise((res) => setTimeout(res, 50));
  eq('deleting the tournament (its creator) removes its picture from storage too', [del.status, BUCKET.has(ttKey), !!one(await list(), 'tokTT')], [200, false, false]);

  console.log('\n=== the record ===');
  const audits = (await c.audits.find({}).toArray()).filter((a) => /thumbnail/.test(a.action)).map((a) => `${a.action} · ${a.target} · ${a.performedBy}`);
  eq('every change in the audit log, by the owner', audits, [
    'Tournament thumbnail set · Pub Cup · chhayajeeth@gmail.com', 'Tournament thumbnail set · Pub Cup · chhayajeeth@gmail.com',
    'Tournament thumbnail position · Pub Cup · chhayajeeth@gmail.com', 'Tournament thumbnail position · Pub Cup · chhayajeeth@gmail.com',
    'Tournament thumbnail set · Pub Cup · chhayajeeth@gmail.com', 'Tournament thumbnail removed · Pub Cup · chhayajeeth@gmail.com',
    'Tournament thumbnail set · Own Cup · chhayajeeth@gmail.com', 'Tournament thumbnail set · TT::City Open · chhayajeeth@gmail.com']);
  eq('… with no storage key or token in them', (await c.audits.find({}).toArray()).some((a) => /tok-|tournament-thumbs\/[0-9a-f]{24}"/.test(JSON.stringify([a.previousValue && a.previousValue.key, a.newValue && a.newValue.key]))), false);

  console.log('\n=== its colours ===');
  const oldThumb = (key, type) => ({ key, url: 'https://cdn.asl.test/' + key, type, w: 1280, h: 720, bytes: 1000, focus: { x: 50, y: 50 }, at: Date.now() - DAY, by: 'chhayajeeth@gmail.com' });
  const until = async (ok, what) => { for (let i = 0; i < 200; i++) { if (await ok()) return; await new Promise((res) => setTimeout(res, 25)); } throw new Error('timed out waiting for ' + what); };
  const page = async (token, as) => req('GET', '/api/public/tournament/' + token, null, as);
  // colours are read one picture at a time: once a picture queued last has
  // its colours, every one before it is done too
  const settle = async () => {
    const key = 'tournament-thumbs/' + require('crypto').randomBytes(12).toString('hex') + '.png';
    BODIES.set(key, ORANGE_BLUE);
    await c.leagues.updateOne({ leagueKey: 'table tennis masters' }, { $set: { thumb: oldThumb(key, 'image/png'), thumbV: 1 } });
    await page('tokTTM');
    await until(async () => Array.isArray((await doc('table tennis masters')).thumb.palette), 'the colours queue');
  };
  let v = (await doc('pub cup')).thumbV;
  r = await put(PUB + '?expect=' + v, ORANGE_BLUE, 'image/png', 'tok-owner');
  d = await doc('pub cup');
  eq('a mostly orange picture with a blue side: orange first, then blue — in the answer and saved', [r.status, near(d.thumb.palette, [hex(ORANGE), hex(BLUE)]), r.json.thumb.palette], [200, true, d.thumb.palette]);
  const shown = { url: 'https://cdn.asl.test/' + d.thumb.key, x: 50, y: 50, w: 1600, h: 900, palette: d.thumb.palette };
  let pg = (await page('tokPub')).json;
  eq('… the homepage card and the tournament page get the same picture and colours — and the page its sport', [one(await list(), 'tokPub').thumb, pg.thumb, pg.sport], [shown, shown, 'cricket']);
  pg = (await page('tokTTM')).json;
  eq('… a tournament with no picture: thumb null, its sport still there (a legacy doc\'s, from its name)', [pg.thumb, pg.sport], [null, 'tabletennis']);

  console.log('\n=== colours for a picture saved before they were read ===');
  const OLD = 'tournament-thumbs/' + 'a1'.repeat(12) + '.png';
  BODIES.set(OLD, GREEN_MAGENTA);
  await c.leagues.updateOne({ leagueKey: 'juhu football league' }, { $set: { thumb: oldThumb(OLD, 'image/png'), thumbV: 1 } });
  let openGate = null;
  gate = new Promise((res) => { openGate = res; });
  pg = (await page('tokFB')).json;
  eq('shown at once, before its colours are known: the picture with palette null', [pg.thumb && pg.thumb.url, pg.thumb && pg.thumb.palette], ['https://cdn.asl.test/' + OLD, null]);
  gate = null; openGate();
  await until(async () => Array.isArray((await doc('juhu football league')).thumb.palette), 'the football colours');
  d = await doc('juhu football league');
  eq('… then read back from storage and saved on that picture: magenta (the more vivid half) first, then green', [got(OLD), near(d.thumb.palette, [hex(MAGENTA), hex(GREEN)])], [1, true]);
  eq('… the very next visit and the homepage card show them — no stale cached page', [((await page('tokFB')).json.thumb || {}).palette, (one(await list(), 'tokFB').thumb || {}).palette], [d.thumb.palette, d.thumb.palette]);
  const BROKEN = 'tournament-thumbs/' + 'b2'.repeat(12) + '.webp';
  BODIES.set(BROKEN, vp8l(1280, 720));
  await c.leagues.updateOne({ leagueKey: 'monsoon kabaddi' }, { $set: { thumb: oldThumb(BROKEN, 'image/webp'), thumbV: 1 } });
  for (let i = 0; i < 3; i++) await page('tokKB');
  await settle();
  eq('a picture its colours cannot be read from: tried once per run, still shown (palette null)', [got(BROKEN), (await page('tokKB')).json.thumb.palette, (await doc('monsoon kabaddi')).thumb.palette], [1, null, undefined]);

  console.log('\n=== never onto a newer picture ===');
  const OLDER = 'tournament-thumbs/' + 'c3'.repeat(12) + '.png';
  BODIES.set(OLDER, GREEN_MAGENTA);
  BUCKET.set(OLDER, { type: 'image/png' });
  v = (await doc('pub cup')).thumbV;
  await c.leagues.updateOne({ leagueKey: 'pub cup' }, { $set: { thumb: oldThumb(OLDER, 'image/png') } });
  gate = new Promise((res) => { openGate = res; });
  await page('tokPub');                                                  // its colours are being read …
  await until(() => got(OLDER) > 0, 'the older picture to be read');
  r = await put(PUB + '?expect=' + v, ORANGE_BLUE, 'image/png', 'tok-owner');   // … while the owner puts up a new picture
  gate = null; openGate();
  await settle();
  d = await doc('pub cup');
  eq('the old picture\'s colours, read late, are never written onto the new one', [r.status, d.thumb.key !== OLDER, near(d.thumb.palette, [hex(ORANGE), hex(BLUE)])], [200, true, true]);

  console.log('\n=== private stays private ===');
  eq('a private tournament\'s page: a visitor and another creator get "not found" — a picture is no way in', [(await page('tokOwn')).status, (await page('tokOwn', 'tok-work')).status], [404, 404]);
  pg = (await page('tokOwn', 'tok-owner')).json;
  eq('… its owner sees it in its picture and colours', [/^https:\/\/cdn\.asl\.test\/tournament-thumbs\//.test(pg.thumb.url), Array.isArray(pg.thumb.palette)], [true, true]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
