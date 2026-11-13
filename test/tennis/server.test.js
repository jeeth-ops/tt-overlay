/* 🎾 Tennis server — the REAL server.js over HTTP and Socket.IO (in-memory
   MongoDB, Firebase ID tokens mapped to test accounts, a stand-in R2 that
   records every upload):

     • permissions: signed out 401, a non-creator 403, another creator 403;
       private tournaments hidden
     • players: one identity, duplicates caught however the name is typed
       ("roger federer", "R. Federer", "Federer Roger"), created only on
       purpose; edits keep the id; portraits
     • tournament → event (draw) → knockout with byes to the top seeds;
       generating again never duplicates
     • the controller lease: one device scores, a second is refused, take-over
     • a whole match over the /tennis socket; an anonymous overlay socket
       gets every update; a retried event never scores twice; completion →
       result, the winner moves into the next round (only from a REALLY
       completed match), PDF scorecard (checked with pdftotext)
     • undo of the last point of a finished match needs a reason, reopens
       it, takes the winner back out of the next round, the PDF becomes v2
     • graphics: refusals with the reason, an ACE call-out once per event
       (an undo takes it off), lower thirds, output reports
     • clips: wrong token refused; a real MP4 stored on R2 under
       tennis/…/set-N/game-N/point-N; the clip follows its point's player; a
       clip by hand with a chosen player; honest states
     • isolation: cricket's and volleyball's lists and collections never see tennis

     NODE_PATH=$(npm root -g) node test/tennis/server.test.js
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 900)) : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, expected: b }); }
function head(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stand-in R2 (installed before server.js loads) ----
const bucket = new Map();
class Cmd { constructor(input) { this.input = input; } }
class PutObjectCommand extends Cmd {}
class DeleteObjectCommand extends Cmd {}
class GetObjectCommand extends Cmd {}
class S3Client {
  async send(cmd) {
    const k = cmd.input.Key;
    if (cmd instanceof PutObjectCommand) { bucket.set(k, Buffer.from(cmd.input.Body)); return {}; }
    if (cmd instanceof DeleteObjectCommand) { bucket.delete(k); return {}; }
    if (cmd instanceof GetObjectCommand) { const b = bucket.get(k); if (!b) throw new Error('NoSuchKey'); return { Body: { transformToByteArray: async () => b } }; }
    return {};
  }
}
const s3Path = require.resolve('@aws-sdk/client-s3');
require.cache[s3Path] = { id: s3Path, filename: s3Path, loaded: true, exports: { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } };
Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET_NAME: 'clips', R2_PUBLIC_URL: 'https://clips.example.test' });

const { bootServer } = require('../server-boot.js');
const { connectTn, connectNsp } = require('./tn-socket.js');

const U = {
  work: { uid: 'u-work', email: 'workallsportslive@gmail.com' },
  vinit: { uid: 'u-vinit', email: 'vinitkrkr1@gmail.com' },
  owner: { uid: 'u-owner', email: 'chhayajeeth@gmail.com' },
  rando: { uid: 'u-rando', email: 'someone@gmail.com' }
};
const TOK = { work: 'tok-work', vinit: 'tok-vinit', owner: 'tok-owner', rando: 'tok-rando' };

function call(port, method, url, { json, raw, token, headers } = {}) {
  return new Promise((resolve, reject) => {
    const body = raw || (json ? Buffer.from(JSON.stringify(json)) : null);
    const h = Object.assign({}, json ? { 'Content-Type': 'application/json' } : raw ? { 'Content-Type': 'video/mp4' } : {}, body ? { 'Content-Length': body.length } : {}, token ? { Authorization: 'Bearer ' + token } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let j = null; try { j = JSON.parse(buf.toString()); } catch (e) {} resolve({ status: res.statusCode, json: j, buf, headers: res.headers }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
function jpegDataUrl(colorHex) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-photo-'));
  const f = path.join(dir, 'p.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colorHex}:s=96x96`, '-frames:v', '1', f]);
  return 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');
}
function makeClip(seconds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-clip-'));
  const f = path.join(dir, 'c.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=320x180:r=25:d=${seconds}`, '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', f]);
  return fs.readFileSync(f);
}
let evn = 0;
const eid = () => 'tev' + (++evn) + '-' + Date.now().toString(36);

(async () => {
  const idTokens = {};
  Object.keys(U).forEach((k) => { idTokens[TOK[k]] = Object.assign({ email_verified: true }, U[k]); });
  const users = {};
  Object.values(U).forEach((u) => { users[u.uid] = u.email; });
  const { port, mem } = await bootServer({ idTokens, users });
  const api = (method, url, opts) => call(port, method, url, opts);

  head('PAGES AND CONFIG');
  for (const p of ['/tennis', '/tennis-templates', '/tennis-panel', '/tennis-remote', '/tennis-overlay', '/tennis-clipper']) {
    const r = await api('GET', p);
    eq('page ' + p + ' is served', r.status, 200);
  }
  const cfg = await api('GET', '/api/tennis/config');
  ok('config: rules, presets, kinds, scenes, call-outs, clip window', cfg.json && cfg.json.rules && cfg.json.presets.bo3 && cfg.json.kinds.ACE && cfg.json.scenes.intro && cfg.json.moments.ACE && cfg.json.clip.postRollSec === 3, cfg.json && Object.keys(cfg.json));

  head('PERMISSIONS');
  eq('signed out: 401', (await api('POST', '/api/tennis/players', { json: { name: 'X' } })).status, 401);
  eq('not an authorised creator: 403', (await api('POST', '/api/tennis/players', { json: { name: 'X' }, token: TOK.rando })).status, 403);

  head('PLAYERS — one identity, duplicates caught');
  const photo = jpegDataUrl('0x2563eb');
  const mkP = async (name, extra, token) => (await api('POST', '/api/tennis/players', { json: Object.assign({ name }, extra || {}), token: token || TOK.work }));
  const roger = await mkP('Roger Federer', { country: 'sui', club: 'Basel TC', ranking: { value: 3, label: 'ATP' }, achievements: [{ text: '20 Grand Slam titles', verified: true }, { text: 'unchecked claim', verified: false }], photo });
  ok('a player is created with a stable id', roger.status === 200 && /^tnp/.test(roger.json.player.playerId), roger.json);
  eq('country normalised; only verified achievements are public', [roger.json.player.country, roger.json.player.achievements], ['SUI', ['20 Grand Slam titles']]);
  ok('… the portrait is served', (await api('GET', roger.json.player.photo)).status === 200);
  for (const typed of ['roger federer', 'R. Federer', 'Federer Roger', 'Rogér  Federer']) {
    const d = await mkP(typed);
    ok(`"${typed}" is caught as a possible duplicate`, d.status === 409 && d.json.code === 'POSSIBLE_DUPLICATE' && d.json.candidates[0].playerId === roger.json.player.playerId, d.json);
  }
  const forced = await mkP('R. Federer', { force: true });
  ok('… and created only when asked explicitly (a different person)', forced.status === 200 && forced.json.player.playerId !== roger.json.player.playerId);
  const P = {};
  P.roger = roger.json.player;
  for (const [k, n, c] of [['rafa', 'Rafael Nadal', 'ESP'], ['novak', 'Novak Djokovic', 'SRB'], ['andy', 'Andy Murray', 'GBR'], ['stan', 'Stan Wawrinka', 'SUI'], ['dom', 'Dominic Thiem', 'AUT'], ['jim', 'Jim Courier', 'USA'], ['pete', 'Pete Sampras', 'USA']]) {
    const r = await mkP(n, { country: c });
    P[k] = r.json.player;
  }
  ok('players for the draw', Object.keys(P).every((k) => P[k] && P[k].playerId));
  const ren = await api('PUT', `/api/tennis/players/${P.andy.playerId}`, { json: { name: 'Sir Andy Murray' }, token: TOK.work });
  eq('a rename keeps the id', [ren.json.player.playerId, ren.json.player.name], [P.andy.playerId, 'Sir Andy Murray']);
  const other = await api('PUT', `/api/tennis/players/${P.andy.playerId}`, { json: { name: 'x' }, token: TOK.vinit });
  eq('another creator cannot edit my player', other.status, 403);
  const search = await api('GET', '/api/tennis/players/search?q=fed', { token: TOK.work });
  ok('search finds them', search.json.players.some((p) => p.playerId === P.roger.playerId));

  head('TOURNAMENT → EVENT → KNOCKOUT DRAW');
  const t = await api('POST', '/api/tennis/tournaments', { json: { name: 'City Open 2026', venue: 'Central Courts', city: 'Pune', surface: 'clay', courts: ['Centre Court', 'Court 1'], visibility: 'public' }, token: TOK.work });
  ok('tournament created', t.status === 200 && t.json.tournament.sport === 'tennis' && t.json.tournament.surface === 'clay', t.json);
  const TID = t.json.tournament.tournamentId;
  const priv = await api('POST', '/api/tennis/tournaments', { json: { name: 'Private Club Night', visibility: 'private' }, token: TOK.work });
  const ev = await api('POST', `/api/tennis/tournaments/${TID}/events`, { json: { name: "Men's Singles", format: 'singles', category: 'men', drawType: 'knockout', rules: { bestOf: 3 }, entries: [
    { playerIds: [P.roger.playerId], seed: 1 }, { playerIds: [P.rafa.playerId], seed: 2 }, { playerIds: [P.novak.playerId], seed: 3 }, { playerIds: [P.andy.playerId] }, { playerIds: [P.stan.playerId] }
  ] }, token: TOK.work });
  ok('event with 5 entries', ev.status === 200 && ev.json.event.entries.length === 5, ev.json);
  const EID = ev.json.event.eventId;
  const dupEntry = await api('PUT', `/api/tennis/tournaments/${TID}/events/${EID}`, { json: { entries: [{ playerIds: [P.roger.playerId] }, { playerIds: [P.roger.playerId] }] }, token: TOK.work });
  ok('a player cannot be entered twice', dupEntry.status === 400 && /twice/.test(dupEntry.json.error), dupEntry.json);
  const draw = await api('POST', `/api/tennis/tournaments/${TID}/events/${EID}/draw`, { json: {}, token: TOK.work });
  eq('draw of 8: 1 first-round match + 2 semis + final', [draw.json.created, draw.json.existing], [4, 0]);
  const again = await api('POST', `/api/tennis/tournaments/${TID}/events/${EID}/draw`, { json: {}, token: TOK.work });
  eq('generating again never duplicates', [again.json.created, again.json.existing], [0, 4]);
  let page = await api('GET', `/api/tennis/tournaments/${TID}`, { token: TOK.work });
  const ms = page.json.matches;
  const r1 = ms.find((m) => m.stage.roundIndex === 1);
  const semis = ms.filter((m) => m.stage.round === 'Semi-final');
  const finalM = ms.find((m) => m.stage.round === 'Final');
  ok('round 1: Murray v Wawrinka (the seeds have byes)', r1 && [r1.sides.A.players[0].playerId, r1.sides.B.players[0].playerId].sort().join() === [P.andy.playerId, P.stan.playerId].sort().join(), r1);
  ok('semi 1: Federer waits for that winner', semis.some((m) => m.sides.A && m.sides.A.players[0].playerId === P.roger.playerId && !m.sides.B && m.source.B.winnerOf === r1.fixtureKey), semis.map((m) => [m.sides.A && m.sides.A.name, m.sides.B && m.sides.B.name, m.source]));
  ok('semi 2: Djokovic v Nadal straight away', semis.some((m) => m.sides.A && m.sides.B && [m.sides.A.players[0].playerId, m.sides.B.players[0].playerId].sort().join() === [P.novak.playerId, P.rafa.playerId].sort().join()));
  ok('the final waits for both semis', finalM && !finalM.sides.A && !finalM.sides.B);
  const notMine = await api('POST', `/api/tennis/tournaments/${TID}/events`, { json: { name: 'x' }, token: TOK.vinit });
  eq('another creator cannot touch my tournament', notMine.status, 403);
  const dir = await api('GET', '/api/tennis/public/tournaments');
  ok('the homepage directory lists the public tournament, not the private one', dir.json.tournaments.some((x) => x.tournamentId === TID && x.sport === 'tennis' && x.url === '/tennis/tournament/' + TID) && !dir.json.tournaments.some((x) => x.tournamentId === priv.json.tournament.tournamentId));
  eq('a private tournament is not found for a visitor', (await api('GET', `/api/tennis/tournaments/${priv.json.tournament.tournamentId}`)).status, 404);

  head('THE LEASE');
  const MID = r1.matchId;
  const l1 = await api('POST', `/api/tennis/matches/${MID}/lease`, { json: { deviceId: 'laptop' }, token: TOK.work });
  ok('the laptop takes control', l1.status === 200 && l1.json.leaseToken);
  const l2 = await api('POST', `/api/tennis/matches/${MID}/lease`, { json: { deviceId: 'phone' }, token: TOK.work });
  eq('a second device is refused while the first is active', [l2.status, l2.json.code], [409, 'LEASE_HELD']);
  const l3 = await api('POST', `/api/tennis/matches/${MID}/lease`, { json: { deviceId: 'phone', force: true }, token: TOK.work });
  ok('… and takes over only explicitly', l3.status === 200);
  const old = await api('POST', `/api/tennis/matches/${MID}/events`, { json: { event: { eventId: eid(), type: 'TOSS', winner: 'A', choice: 'serve', firstServe: 'A' } }, token: TOK.work, headers: { 'x-tn-lease': l1.json.leaseToken } });
  eq('the old device can no longer write', [old.status, old.json.code], [409, 'LEASE_REQUIRED']);
  const lease = (await api('POST', `/api/tennis/matches/${MID}/lease`, { json: { deviceId: 'laptop', force: true }, token: TOK.work })).json.leaseToken;

  head('A WHOLE MATCH OVER THE SOCKET');
  const panel = await connectTn(port, { idToken: TOK.work });
  const viewer = await connectTn(port, {});
  const updates = [], graphics = [];
  viewer.on('tn:update', (u) => updates.push(u));
  viewer.on('tn:graphic', (g) => graphics.push(g.graphic));
  const jv = await viewer.emitAck('tn:join', { matchId: MID });
  ok('an anonymous viewer joins a public match', jv.ok && !jv.match.clipToken && !jv.match.overlayKey, jv);
  const jp = await panel.emitAck('tn:join', { matchId: MID, events: true });
  ok('the manager joins with the private keys', jp.ok && jp.match.clipToken && jp.match.overlayKey);
  const A = r1.sides.A.players[0].playerId, B = r1.sides.B.players[0].playerId;
  const send = (event) => panel.emitAck('tn:event', { matchId: MID, leaseToken: lease, event: Object.assign({ eventId: eid(), at: Date.now() }, event) });
  ok('toss', (await send({ type: 'TOSS', winner: 'A', choice: 'serve', firstServe: 'A', left: 'A' })).ok);
  const tossGfx = await panel.emitAck('tn:graphic', { matchId: MID, action: 'take', scene: 'setWinner' });
  ok('a graphic with nothing to show is refused with the reason', !tossGfx.ok && /No set has finished/.test(tossGfx.error), tossGfx);
  ok('start: A serves', (await send({ type: 'START', server: A, left: 'A' })).ok);
  const startEvent = { eventId: eid(), type: 'POINT', winner: 'A', kind: 'ACE', serve: 1, speed: 203, at: Date.now() };
  const p1 = await panel.emitAck('tn:event', { matchId: MID, leaseToken: lease, event: startEvent });
  ok('an ace', p1.ok && p1.summary.display.A === '15', p1);
  const p1again = await panel.emitAck('tn:event', { matchId: MID, leaseToken: lease, event: startEvent });
  ok('the same event again (a retry) is a duplicate — 15-0, not 30-0', p1again.ok && p1again.duplicate && p1again.summary.display.A === '15', p1again);
  await sleep(150);
  let air = (await viewer.emitAck('tn:sync', { matchId: MID })).graphic;
  ok('the ACE call-out is on air, once, with the event\'s id', air.moment && air.moment.kind === 'ACE' && air.moment.eventId === startEvent.eventId && air.moment.data.speed === 203, air.moment);
  const u1 = await send({ type: 'UNDO' });
  ok('undo the ace', u1.ok && u1.summary.display.A === '0');
  await sleep(150);
  air = (await viewer.emitAck('tn:sync', { matchId: MID })).graphic;
  ok('… its call-out goes off air with it', !air.moment, air.moment);
  // play the match: A wins 6-2 6-3 (B wins the 2nd, 4th of each set's games)
  const game = async (side) => { for (let i = 0; i < 4; i++) { const r = await send({ type: 'POINT', winner: side }); if (!r.ok) throw new Error('point refused: ' + r.error); } };
  const playSet = async (bGames) => { let a = 0, b = 0; while (a < 6) { if (b < bGames && (a + b) % 3 === 1) { await game('B'); b++; } else { await game('A'); a++; } } };
  await playSet(2);
  let s = (await viewer.emitAck('tn:sync', { matchId: MID })).summary;
  eq('set 1: 6-2', [s.sets[0].A, s.sets[0].B, s.sets[0].winner], [6, 2, 'A']);
  await playSet(3);
  s = (await viewer.emitAck('tn:sync', { matchId: MID })).summary;
  eq('the match: 6-2 6-3, A wins', [s.status, s.winner, s.setsWon], ['completed', 'A', { A: 2, B: 0 }]);
  ok('the overlay socket saw every update in order', updates.length >= 70 && updates.every((u, i) => i === 0 || u.seq > updates[i - 1].seq), updates.length);
  const after = await send({ type: 'POINT', winner: 'B' });
  ok('no point after the match', !after.ok && after.code === 'MATCH_OVER');
  await sleep(400);
  page = await api('GET', `/api/tennis/tournaments/${TID}`, { token: TOK.work });
  const semi1 = page.json.matches.find((m) => m.source && m.source.B && m.source.B.winnerOf === r1.fixtureKey);
  ok('the winner moved into the semi-final (from the server\'s own result)', semi1.sides.B && semi1.sides.B.players[0].playerId === A, semi1.sides);
  let rep = null;
  for (let i = 0; i < 60 && !(rep && rep.status === 'ready'); i++) { await sleep(150); rep = (await api('GET', `/api/tennis/matches/${MID}`)).json.match.report; }
  ok('the PDF scorecard is made', rep && rep.status === 'ready' && rep.version === 1, rep);
  let pdf = await api('GET', `/api/tennis/matches/${MID}/report.pdf`);
  // with cloud storage the PDF is on R2: the link redirects to it
  if (pdf.status === 302) pdf = { status: 200, buf: bucket.get(String(pdf.headers.location).replace('https://clips.example.test/', '')) || Buffer.alloc(0), redirected: true };
  ok('… served as a PDF (stored on R2)', pdf.status === 200 && pdf.redirected && pdf.buf.slice(0, 5).toString() === '%PDF-', pdf.status);
  const pdfFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-pdf-')), 's.pdf');
  fs.writeFileSync(pdfFile, pdf.buf);
  const text = execFileSync('pdftotext', ['-layout', pdfFile, '-']).toString();
  ok('the PDF says who won, the score, the format, the statistics', /won/.test(text) && /6-2 6-3/.test(text) && /Best of 3/.test(text) && /Aces/.test(text) && /Service games won/.test(text), text.slice(0, 600));
  ok('… and the game-by-game and point-by-point record', /Game by game/i.test(text) && /Point by point/i.test(text) && /Game, set and match/.test(text));

  head('UNDO OF A FINISHED MATCH');
  const noReason = await send({ type: 'UNDO' });
  ok('undo of a finished match needs a reason', !noReason.ok && noReason.code === 'REASON_REQUIRED', noReason);
  const reopened = await send({ type: 'UNDO', reason: 'the last point was out' });
  ok('with a reason: reopened at 40-…', reopened.ok && reopened.summary.status === 'in_play', reopened);
  await sleep(300);
  page = await api('GET', `/api/tennis/tournaments/${TID}`, { token: TOK.work });
  const semiBack = page.json.matches.find((m) => m.matchId === semi1.matchId);
  ok('the winner is taken back out of the semi-final (it has not started)', !semiBack.sides.B, semiBack.sides);
  await send({ type: 'POINT', winner: 'A', kind: 'WINNER', stroke: 'FH' });
  for (let i = 0; i < 60; i++) { await sleep(150); rep = (await api('GET', `/api/tennis/matches/${MID}`)).json.match.report; if (rep && rep.version === 2 && rep.status === 'ready') break; }
  eq('completed again: the scorecard is remade as v2', [rep.status, rep.version], ['ready', 2]);
  await sleep(200);
  page = await api('GET', `/api/tennis/tournaments/${TID}`, { token: TOK.work });
  ok('… and the winner is back in the semi-final', page.json.matches.find((m) => m.matchId === semi1.matchId).sides.B.players[0].playerId === A);
  const audit = await api('GET', `/api/tennis/matches/${MID}/audit`, { token: TOK.work });
  ok('the audit has the reopen, the draw moves and the reports', ['match.reopen', 'event.undo', 'report.regenerate'].every((a) => audit.json.audit.some((x) => x.action === a)), audit.json.audit.map((x) => x.action));

  head('STATS AND TIMELINE');
  const st = await api('GET', `/api/tennis/matches/${MID}/stats`);
  ok('statistics from the timeline', st.json.stats.sides.A.serve.games > 0 && st.json.stats.sides.A.gamesWon === 12, st.json.stats.sides.A);
  const tl = await api('GET', `/api/tennis/matches/${MID}/timeline`);
  ok('the public timeline hides who pressed', tl.json.timeline.every((e) => !e.by));
  const prof = await api('GET', `/api/tennis/players/${A}`);
  ok('a player page: profile + the match', prof.status === 200 && prof.json.matches.some((x) => x.match.matchId === MID) && prof.json.record.won === 1, prof.json && prof.json.record);

  head('GRAPHICS');
  const lower = await panel.emitAck('tn:graphic', { matchId: MID, action: 'lower', kind: 'player', data: { playerId: A } });
  ok('a lower third', lower.ok && lower.graphic.lower && lower.graphic.lower.kind === 'player');
  const badLower = await panel.emitAck('tn:graphic', { matchId: MID, action: 'lower', kind: 'player', data: { playerId: 'nobody' } });
  ok('a lower third of a player not in the match is refused', !badLower.ok);
  const res1 = await panel.emitAck('tn:graphic', { matchId: MID, action: 'take', scene: 'result' });
  ok('the match result on air (the lower third makes way)', res1.ok && res1.graphic.scene === 'result' && !res1.graphic.lower);
  viewer.emit('tn:output', { matchId: MID, state: 'GRAPHIC_VISIBLE', graphicId: res1.graphic.id, scene: 'result', airSeq: res1.graphic.seq });
  await sleep(250);
  const jj = await panel.emitAck('tn:join', { matchId: MID });
  ok('the manager sees what the output really shows', jj.outputs && jj.outputs.some((o) => o.state === 'GRAPHIC_VISIBLE' && o.graphicId === res1.graphic.id), jj.outputs);
  const anon = await viewer.emitAck('tn:graphic', { matchId: MID, action: 'stop' });
  ok('a viewer cannot change what is on air', !anon.ok && anon.error === 'not-authorised');
  const stop = await panel.emitAck('tn:graphic', { matchId: MID, action: 'stop', id: res1.graphic.id });
  ok('back to the score bug', stop.ok && !stop.graphic.scene);

  head('CLIPS');
  const m0 = (await api('GET', `/api/tennis/matches/${MID}`, { token: TOK.work })).json.match;
  const L = (await api('GET', `/api/tennis/matches/${MID}/timeline`, { token: TOK.work })).json.timeline;
  const winnerPt = L.filter((e) => e.type === 'POINT' && !e.voided && e.kind === 'WINNER').pop();
  const clipId = `${MID}_${winnerPt.eventId}`;
  const reg = await api('POST', `/api/tennis/matches/${MID}/clips`, { json: { clipId, eventId: winnerPt.eventId, status: 'REQUESTED', t0: winnerPt.at, preRollSec: 7, postRollSec: 3 }, token: TOK.work });
  ok('a point clip is registered', reg.status === 200 && reg.json.clip.status === 'REQUESTED', reg.json);
  const bad = await api('POST', `/api/tennis/clips/ingest?matchId=${MID}&clipId=${clipId}`, { raw: Buffer.from('xx'), headers: { 'x-point-meta': JSON.stringify({ tnClipToken: 'wrong', eventId: winnerPt.eventId }) } });
  eq('a clip without the match\'s clip token is refused', bad.status, 403);
  const mp4 = makeClip(10);
  const ing = await api('POST', `/api/tennis/clips/ingest?matchId=${MID}&clipId=${clipId}`, { raw: mp4, headers: { 'x-point-meta': JSON.stringify({ tnClipToken: m0.clipToken, eventId: winnerPt.eventId, engine: 'tennis-clipper', preRollSec: 7, postRollSec: 3, actualPreRollSec: 7, set: 2, game: 9 }) } });
  ok('a real 10-second MP4 is ingested', ing.status === 200 && ing.json.durationSec >= 9.5 && ing.json.durationSec <= 10.6, ing.json);
  let clips = null;
  for (let i = 0; i < 40; i++) { await sleep(150); clips = (await api('GET', `/api/tennis/matches/${MID}/clips`)).json.clips; if (clips[0] && clips[0].status === 'COMPLETE') break; }
  const c1 = clips.find((x) => x.clipId === clipId);
  ok('uploaded to R2 under tennis/…/set-N/game-N/point-N', c1.status === 'COMPLETE' && [...bucket.keys()].some((k) => k.startsWith(`tennis/${TID}/${MID}/set-`) && /\/game-\d+\/point-\d+-/.test(k) && k.endsWith(clipId + '.mp4')), [...bucket.keys()]);
  // that winner was the match-winning point: the clip is a MATCH_POINT clip, credited to the hitter
  ok('the clip follows its point: kind Match point (it won the match), the winner\'s player', c1.kind === 'MATCH_POINT' && c1.pointKind === 'WINNER' && c1.players.some((p) => p.playerId === A && p.role === 'winner'), c1);
  const byPlayer = await api('GET', `/api/tennis/matches/${MID}/clips?playerId=${A}`);
  ok('the player\'s clips', byPlayer.json.clips.some((x) => x.clipId === clipId));
  const manual = await api('POST', `/api/tennis/matches/${MID}/clips`, { json: { clipId: `${MID}_clip-celebration1`, kind: 'CELEBRATION', playerId: A, t0: Date.now(), scoreAtTrigger: { sets: '2-0', games: '6-3', points: '0-0', set: 2 } }, token: TOK.work });
  ok('a clip by hand, with the player chosen', manual.status === 200);
  clips = (await api('GET', `/api/tennis/matches/${MID}/clips?playerId=${A}`)).json.clips;
  ok('… listed under that player, kind Celebration', clips.some((x) => x.clipId === `${MID}_clip-celebration1` && x.kind === 'CELEBRATION' && x.players[0].role === 'chosen'), clips.map((x) => [x.clipId, x.kind]));
  const badId = await api('POST', `/api/tennis/matches/${MID}/clips`, { json: { clipId: `${MID}_nonsense` }, token: TOK.work });
  eq('a clip with no point and no hand-clip id is refused', badId.status, 400);
  const vid = await api('GET', `/api/tennis/clips/${clipId}/video`);
  ok('the video link goes to the stored clip', vid.status === 302 && /clips\.example\.test/.test(vid.headers.location), vid.status);

  head('DOUBLES — a friendly match');
  const dm = await api('POST', `/api/tennis/tournaments/${TID}/matches`, { json: { format: 'doubles', sideA: { playerIds: [P.dom.playerId, P.jim.playerId] }, sideB: { playerIds: [P.pete.playerId, P.stan.playerId] }, court: 'Court 1', title: 'Exhibition doubles', rules: { bestOf: 3, noAd: true, finalSet: 'matchTiebreak' } }, token: TOK.work });
  ok('a doubles match from four players', dm.status === 200 && dm.json.match.sides.A.players.length === 2 && dm.json.match.sides.A.name === 'Thiem / Courier', dm.json);
  const both = await api('POST', `/api/tennis/tournaments/${TID}/matches`, { json: { format: 'doubles', sideA: { playerIds: [P.dom.playerId, P.jim.playerId] }, sideB: { playerIds: [P.dom.playerId, P.stan.playerId] } }, token: TOK.work });
  eq('a player cannot be on both sides', both.status, 400);
  const DM = dm.json.match.matchId;
  const dl = (await api('POST', `/api/tennis/matches/${DM}/lease`, { json: { deviceId: 'laptop' }, token: TOK.work })).json.leaseToken;
  const dsend = (event) => panel.emitAck('tn:event', { matchId: DM, leaseToken: dl, event: Object.assign({ eventId: eid(), at: Date.now() }, event) });
  await panel.emitAck('tn:join', { matchId: DM });
  const ds = await dsend({ type: 'START', server: P.dom.playerId, order: [P.dom.playerId, P.pete.playerId, P.jim.playerId, P.stan.playerId], receive: { A: { deuce: P.dom.playerId, ad: P.jim.playerId }, B: { deuce: P.pete.playerId, ad: P.stan.playerId } } });
  ok('doubles start with the order of service', ds.ok && ds.summary.server.playerId === P.dom.playerId && ds.summary.receiver.playerId === P.pete.playerId, ds);
  const bad2 = await dsend({ type: 'START', server: P.dom.playerId });
  ok('a second start is refused', !bad2.ok && bad2.code === 'ALREADY_STARTED');
  const before = (await api('GET', `/api/tennis/matches/${DM}`)).json.match.rules;
  const lockR = await api('PUT', `/api/tennis/matches/${DM}`, { json: { rules: { bestOf: 5 } }, token: TOK.work });
  ok('the format cannot change once the match has started', lockR.status === 409 && before.noAd === true, lockR.json);

  head('ISOLATION');
  const cricketList = await api('GET', '/api/public/tournaments');
  ok('cricket\'s tournament list does not contain tennis', !JSON.stringify(cricketList.json || {}).includes(TID));
  const vbList = await api('GET', '/api/volleyball/public/tournaments');
  ok('volleyball\'s list does not contain tennis', !JSON.stringify(vbList.json || {}).includes(TID));
  const tnCols = ['tnTournaments', 'tnPlayers', 'tnMatches', 'tnEvents', 'tnClips', 'tnReports', 'tnAudit'];
  ok('tennis wrote only to its own collections', tnCols.every((n) => mem.collection(n)));
  const otherCols = ['vbTournaments', 'vbMatches', 'vbEvents', 'leagues', 'matches'];
  ok('no tennis row in any volleyball or cricket collection', otherCols.every((n) => !JSON.stringify(mem.collection(n).docs ? [...mem.collection(n).docs.values()] : []).includes(TID)));
  const vbSock = await connectNsp(port, {}, '/volleyball');
  const vbGot = [];
  vbSock.on('tn:update', (u) => vbGot.push(u));
  vbSock.on('vb:update', (u) => vbGot.push(u));
  await dsend({ type: 'POINT', winner: 'A' });
  await sleep(300);
  eq('a volleyball socket hears nothing of a tennis point', vbGot.length, 0);
  await vbSock.close();

  await panel.close(); await viewer.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
