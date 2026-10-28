/* 🏐 Volleyball server — the REAL server.js over HTTP and Socket.IO
   (in-memory MongoDB, Firebase ID tokens mapped to test accounts, a
   stand-in R2 bucket that records every upload):

     • permissions: signed out 401, a non-creator 403, another creator 403
       on someone else's tournament, private tournaments hidden
     • teams with logos and stable player ids, tournament, fixtures that
       never duplicate
     • controller lease: one device scores, a second is refused, take-over
       is explicit and the old device can no longer write; lock / unlock
     • a whole match scored over the /volleyball socket, an anonymous
       overlay socket receiving every update; a retried event never scores
       twice; completion → standings + PDF report (checked with pdftotext)
     • undo of the final point on a finished match needs a reason, reopens
       it, the report is remade as v2; a classification correction moves
       the statistics
     • clip ingest: wrong token refused; a real 10-second MP4 stored on R2
       under volleyball/…/set-N/point-N-…; the clip follows its POINT to
       the right player's video icon; honest "unavailable" states
     • isolation: cricket's tournament list and cricket sockets never see
       any of it

     NODE_PATH=$(npm root -g) node test/volleyball/server.test.js
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, expected: b }); }
function head(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stand-in R2 (installed before server.js loads) ----
const bucket = new Map();
let r2FailVideos = 0;   // the next N clip uploads fail (R2 "down")
class Cmd { constructor(input) { this.input = input; } }
class PutObjectCommand extends Cmd {}
class DeleteObjectCommand extends Cmd {}
class GetObjectCommand extends Cmd {}
class S3Client {
  async send(cmd) {
    const k = cmd.input.Key;
    if (cmd instanceof PutObjectCommand && r2FailVideos > 0 && /\.mp4$/.test(k)) { r2FailVideos--; throw new Error('R2 is down'); }
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
const { connectVb } = require('./vb-socket.js');
const { connect: connectCricket } = require('../socketio-polling-client.js');

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
    const h = Object.assign({}, json ? { 'Content-Type': 'application/json' } : raw ? { 'Content-Type': 'video/mp4' } : {}, body ? { 'Content-Length': body.length } : {},
      token ? { Authorization: 'Bearer ' + token } : {}, headers || {});
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

function pngDataUrl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-logo-'));
  const f = path.join(dir, 'l.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1d4ed8@0.8:s=64x64,format=rgba', '-frames:v', '1', f]);
  return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
}
function makeClip(seconds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-clip-'));
  const f = path.join(dir, 'c.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=320x180:r=25:d=${seconds}`, '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', f]);
  return fs.readFileSync(f);
}
function roster(prefix) {
  const roles = ['S', 'OH', 'OH', 'MB', 'MB', 'OPP', 'DS', 'OH', 'MB', 'S', 'L', 'L'];
  return roles.map((r, i) => ({ name: `${prefix} Player ${i + 1}`, number: String(i + 1), role: r, libero: r === 'L', captain: i === 0 }));
}

(async () => {
  const idTokens = {};
  Object.keys(U).forEach((k) => { idTokens[TOK[k]] = Object.assign({ email_verified: true }, U[k]); });
  const users = {};
  Object.values(U).forEach((u) => { users[u.uid] = u.email; });
  const { port, mem } = await bootServer({ idTokens, users });
  const api = (method, url, opts) => call(port, method, url, opts);

  head('PERMISSIONS');
  eq('signed out: 401', (await api('POST', '/api/volleyball/teams', { json: { name: 'X' } })).status, 401);
  eq('a signed-in account that is not an authorised creator: 403', (await api('POST', '/api/volleyball/teams', { json: { name: 'X' }, token: TOK.rando })).status, 403);

  head('TEAMS, TOURNAMENT, FIXTURES');
  const logo = pngDataUrl();
  const teams = [];
  for (const [i, nm] of ['Mumbai Spikers', 'Delhi Blockers', 'Chennai Aces', 'Kolkata Thunder'].entries()) {
    const r = await api('POST', '/api/volleyball/teams', { json: { name: nm, colors: { primary: ['#1d4ed8', '#dc2626', '#f59e0b', '#7c3aed'][i] }, logo: i === 0 ? logo : undefined, players: roster(nm.split(' ')[0]) }, token: TOK.work });
    teams.push(r.json.team);
  }
  ok('four teams, each with 12 players and stable ids', teams.length === 4 && teams.every((t) => t.players.length === 12 && t.players.every((p) => /^vbp/.test(p.playerId))));
  eq('two liberos and one captain each', [teams[0].players.filter((p) => p.libero).length, teams[0].players.filter((p) => p.captain).length], [2, 1]);
  const lg = await api('GET', teams[0].logo);
  eq('the logo is served as an image', [lg.status, lg.headers['content-type']], [200, 'image/png']);
  const dup = await api('POST', '/api/volleyball/teams', { json: { name: 'Dup', players: [{ name: 'A', number: '7' }, { name: 'B', number: '7' }] }, token: TOK.work });
  eq('two players with the same jersey number are refused', dup.status, 400);
  const libCap = await api('POST', '/api/volleyball/teams', { json: { name: 'LibCap', players: [{ name: 'A', number: '1', libero: true, captain: true }, { name: 'B', number: '2' }] }, token: TOK.work });
  eq('a libero as team captain is refused (FIVB 19.1)', [libCap.status, /libero cannot be the team captain/.test(JSON.stringify(libCap.json))], [400, true]);

  const tr = await api('POST', '/api/volleyball/tournaments', { json: { name: 'Mumbai Volley League', venue: 'NSCI Dome', city: 'Mumbai', startDate: '2026-11-01', endDate: '2026-11-08', teamIds: teams.map((t) => t.teamId), format: { type: 'league' } }, token: TOK.work });
  const T = tr.json.tournament;
  eq('tournament created with FIVB defaults, public (creator default)', [tr.status, T.rules.bestOf, T.rules.setPoints, T.rules.decidingSetPoints, T.visibility, T.pointsPolicy.key], [200, 5, 25, 15, 'public', '3-2-1-0']);
  const fx = await api('POST', `/api/volleyball/tournaments/${T.tournamentId}/fixtures`, { json: { kind: 'league' }, token: TOK.work });
  eq('round robin of 4: six fixtures', [fx.status, fx.json.created], [200, 6]);
  const fx2 = await api('POST', `/api/volleyball/tournaments/${T.tournamentId}/fixtures`, { json: { kind: 'league' }, token: TOK.work });
  eq('generating again duplicates nothing', [fx2.json.created, fx2.json.existing], [0, 6]);
  eq('another creator cannot edit this tournament', (await api('PUT', `/api/volleyball/tournaments/${T.tournamentId}`, { json: { name: 'Hijack' }, token: TOK.vinit })).status, 403);
  const pub = await api('GET', `/api/volleyball/tournaments/${T.tournamentId}`);
  ok('anyone can view a public tournament (6 matches, a 4-row table)', pub.status === 200 && pub.json.matches.length === 6 && pub.json.standings.groups[0].rows.length === 4);
  ok('…but a viewer never receives the clip token or overlay key', pub.json.matches.every((m) => !m.clipToken && !m.overlayKey));
  const priv = await api('POST', '/api/volleyball/tournaments', { json: { name: 'Owner Private Cup' }, token: TOK.owner });
  eq('the owner account\'s tournaments are private by default', priv.json.tournament.visibility, 'private');
  eq('a private tournament is 404 to everyone else', [(await api('GET', `/api/volleyball/tournaments/${priv.json.tournament.tournamentId}`)).status, (await api('GET', `/api/volleyball/tournaments/${priv.json.tournament.tournamentId}`, { token: TOK.work })).status], [404, 404]);
  eq('…and visible to its owner', (await api('GET', `/api/volleyball/tournaments/${priv.json.tournament.tournamentId}`, { token: TOK.owner })).status, 200);
  // a private match's overlay / scorecard media open with the match key only
  const PT = priv.json.tournament.tournamentId;
  const pteams = [];
  for (const nm of ['Owner Hawks', 'Owner Owls']) pteams.push((await api('POST', '/api/volleyball/teams', { json: { name: nm, players: roster(nm.split(' ')[1]) }, token: TOK.owner })).json.team);
  await api('PUT', `/api/volleyball/tournaments/${PT}`, { json: { teamIds: pteams.map((t) => t.teamId), logo }, token: TOK.owner });
  const pm = (await api('POST', `/api/volleyball/tournaments/${PT}/matches`, { json: { teamA: pteams[0].teamId, teamB: pteams[1].teamId }, token: TOK.owner })).json.match;
  // (the first version's fixture index let a tournament hold only ONE match made by hand)
  const pm2 = await api('POST', `/api/volleyball/tournaments/${PT}/matches`, { json: { teamA: pteams[1].teamId, teamB: pteams[0].teamId }, token: TOK.owner });
  const pm3 = await api('POST', `/api/volleyball/tournaments/${PT}/matches`, { json: { teamA: pteams[0].teamId, teamB: pteams[1].teamId }, token: TOK.owner });
  eq('more matches made by hand in the same tournament', [pm2.status, pm3.status, pm3.json && pm3.json.match && pm3.json.match.matchNo], [200, 200, 3]);
  eq('private: the overlay\'s points table needs the match key', [(await api('GET', `/api/volleyball/matches/${pm.matchId}/standings`)).status, (await api('GET', `/api/volleyball/matches/${pm.matchId}/standings?key=wrong`)).status, (await api('GET', `/api/volleyball/matches/${pm.matchId}/standings?key=${pm.overlayKey}`)).status], [404, 404, 200]);
  const plogo = (await api('GET', `/api/volleyball/tournaments/${PT}`, { token: TOK.owner })).json.tournament.logo;
  eq('private: the tournament logo shows on its overlay with the key, nowhere else', [(await api('GET', plogo)).status, (await api('GET', `${plogo}&match=${pm.matchId}&key=${pm.overlayKey}`)).status], [404, 200]);
  const pclip = `${pm.matchId}_ev-private`;
  await api('POST', `/api/volleyball/matches/${pm.matchId}/clips`, { json: { clipId: pclip, eventId: 'ev-private', status: 'REQUESTED' }, token: TOK.owner });
  await api('POST', `/api/volleyball/clips/ingest?matchId=${pm.matchId}&clipId=${pclip}&timestamp=${Date.now()}`, { raw: makeClip(2), headers: { 'X-Ball-Meta': JSON.stringify({ sport: 'volleyball', vbClipToken: pm.clipToken, eventId: 'ev-private' }) } });
  const pv = [(await api('GET', `/api/volleyball/clips/${pclip}/video`)).status, (await api('GET', `/api/volleyball/clips/${pclip}/video?key=${pm.overlayKey}`)).status];
  ok('private: a clip video plays with the match key (a <video> carries no sign-in), never without', pv[0] === 404 && (pv[1] === 200 || pv[1] === 302), pv);
  const dir = (await api('GET', '/api/volleyball/public/tournaments')).json.tournaments.map((t) => t.name);
  ok('the public list has the public tournament only', dir.includes('Mumbai Volley League') && !dir.includes('Owner Private Cup'));

  // the first fixture: Mumbai (team A) v someone
  const mine = await api('GET', `/api/volleyball/tournaments/${T.tournamentId}`, { token: TOK.work });
  const M0 = mine.json.matches.find((m) => m.teamA.teamId === teams[0].teamId || m.teamB.teamId === teams[0].teamId);
  ok('a manager sees the match clip token', !!M0.clipToken && !!M0.overlayKey);
  const MID = M0.matchId;

  head('CONTROLLER LEASE AND LOCK');
  const l1 = await api('POST', `/api/volleyball/matches/${MID}/lease`, { json: { deviceId: 'laptop-1' }, token: TOK.work });
  ok('laptop 1 takes control', l1.status === 200 && !!l1.json.leaseToken);
  const l2 = await api('POST', `/api/volleyball/matches/${MID}/lease`, { json: { deviceId: 'laptop-2' }, token: TOK.work });
  eq('laptop 2 is refused while laptop 1 is active', [l2.status, l2.json.code, l2.json.holder.deviceId], [409, 'LEASE_HELD', 'laptop-1']);
  const l2f = await api('POST', `/api/volleyball/matches/${MID}/lease`, { json: { deviceId: 'laptop-2', force: true }, token: TOK.work });
  ok('an explicit take-over works', l2f.status === 200 && !!l2f.json.leaseToken);
  const stale = await api('POST', `/api/volleyball/matches/${MID}/events`, { json: { event: { eventId: 'x-1', type: 'NOTE', text: 'hi' } }, token: TOK.work, headers: { 'x-vb-lease': l1.json.leaseToken } });
  eq('…and laptop 1 can no longer write', [stale.status, stale.json.code], [409, 'LEASE_REQUIRED']);
  const LEASE = l2f.json.leaseToken;
  await api('POST', `/api/volleyball/matches/${MID}/lock`, { json: { locked: true, reason: 'not before 6pm' }, token: TOK.work });
  const lk = await api('POST', `/api/volleyball/matches/${MID}/events`, { json: { event: { eventId: 'x-2', type: 'NOTE', text: 'hi' } }, token: TOK.work, headers: { 'x-vb-lease': LEASE } });
  eq('a locked match takes no event', [lk.status, lk.json.code], [423, 'MATCH_LOCKED']);
  eq('…nor a lease claim', (await api('POST', `/api/volleyball/matches/${MID}/lease`, { json: { deviceId: 'laptop-3' }, token: TOK.work })).status, 423);
  eq('…nor an edit', (await api('PUT', `/api/volleyball/matches/${MID}`, { json: { venue: 'X' }, token: TOK.work })).status, 423);
  eq('…but it is still viewable', (await api('GET', `/api/volleyball/matches/${MID}`)).status, 200);
  await api('POST', `/api/volleyball/matches/${MID}/lock`, { json: { locked: false }, token: TOK.work });

  head('A WHOLE MATCH OVER THE SOCKET');
  const scorer = await connectVb(port, { idToken: TOK.work });
  const overlay = await connectVb(port, {});
  const cricket = await connectCricket(port, { uid: MID });
  let cricketSaw = 0;
  ['vb:update', 'liveCricketScore', 'cricketEvent'].forEach((ev) => cricket.on(ev, () => { if (ev === 'vb:update') cricketSaw++; }));
  const updates = [];
  overlay.on('vb:update', (u) => updates.push(u));
  const oj = await overlay.emitAck('vb:join', { matchId: MID });
  ok('an anonymous overlay joins a public match', oj.ok && !oj.match.clipToken);
  const sj = await scorer.emitAck('vb:join', { matchId: MID, timeline: true });
  ok('the scorer joins with the manager view', sj.ok && !!sj.match.clipToken);
  const match = sj.match;
  const sideTeam = { A: teams.find((t) => t.teamId === match.teamA.teamId), B: teams.find((t) => t.teamId === match.teamB.teamId) };
  const six = (side) => sideTeam[side].players.filter((p) => !p.libero).slice(0, 6).map((p) => p.playerId);
  let n = 0;
  const send = (event) => scorer.emitAck('vb:event', { matchId: MID, leaseToken: LEASE, event: Object.assign({ eventId: 'ev-' + (++n) + '-' + Math.random().toString(36).slice(2, 6), at: Date.now() }, event) });
  let r = await send({ type: 'TOSS', winner: 'A', choice: 'serve', leftSide: 'A' });
  ok('toss recorded', r.ok, r);
  const statusAfterToss = (await api('GET', `/api/volleyball/matches/${MID}`)).json.match.status;
  eq('the match is live once the toss is recorded', statusAfterToss, 'live');
  const lineups = async (set) => { await send({ type: 'LINEUP', set, team: 'A', positions: six('A') }); await send({ type: 'LINEUP', set, team: 'B', positions: six('B') }); };
  await lineups(1);
  r = await send({ type: 'SET_START', set: 1 });
  ok('set 1 starts', r.ok && r.summary.status === 'in_set', r);
  const attacker = six('A')[2];
  const killEvent = { eventId: 'kill-1', type: 'RALLY', winner: 'A', outcome: 'ATTACK_KILL', players: { attacker }, at: Date.now() };
  r = await scorer.emitAck('vb:event', { matchId: MID, leaseToken: LEASE, event: killEvent });
  ok('a kill by a named attacker', r.ok && r.summary.points.A === 1);
  const again = await scorer.emitAck('vb:event', { matchId: MID, leaseToken: LEASE, event: killEvent });
  eq('the same event again (a network retry): acknowledged as a duplicate, no second point', [again.ok, again.duplicate, again.summary.points], [true, true, { A: 1, B: 0 }]);
  const winSet = async (team) => { for (let i = 0; i < 40; i++) { const x = await send({ type: 'RALLY', winner: team }); if (x.summary.status !== 'in_set') return x; } };
  await winSet('A');
  await lineups(2); await send({ type: 'SET_START', set: 2 }); await winSet('B');
  await lineups(3); await send({ type: 'SET_START', set: 3 }); await winSet('A');
  await lineups(4); await send({ type: 'SET_START', set: 4 });
  // a timeout, a substitution, then the set
  r = await send({ type: 'TIMEOUT', team: 'B' });
  ok('time-out recorded', r.ok && r.summary.timeoutsLeft.B === 1);
  const benchA = sideTeam.A.players.filter((p) => !p.libero).slice(6, 7)[0].playerId;
  r = await send({ type: 'SUBSTITUTION', team: 'A', pairs: [{ out: six('A')[5], in: benchA }] });
  ok('substitution recorded', r.ok && r.summary.subsLeft.A === 5, r);
  const last = await winSet('A');
  eq('3-1: the match is complete', [last.status, last.summary.setsWon, last.summary.winner], ['completed', { A: 3, B: 1 }, 'A']);
  await sleep(150);
  ok('the overlay socket received every update, in order', updates.length >= 100 && updates.every((u, i) => i === 0 || u.seq > updates[i - 1].seq));
  eq('…none of it reached a cricket socket in the same match id', cricketSaw, 0);
  const doneMatch = (await api('GET', `/api/volleyball/matches/${MID}`)).json.match;
  eq('the match record: completed, result 3-1 with set scores', [doneMatch.status, doneMatch.result.sets, doneMatch.result.setScores.length], ['completed', { A: 3, B: 1 }, 4]);

  head('STANDINGS AND THE PDF');
  const st = (await api('GET', `/api/volleyball/tournaments/${T.tournamentId}/standings`)).json.standings.groups[0].rows;
  const winRow = st.find((x) => x.teamId === match.teamA.teamId), loseRow = st.find((x) => x.teamId === match.teamB.teamId);
  eq('3-1 win: 3 match points, 1 played, sets 3-1', [winRow.matchPoints, winRow.played, winRow.won, winRow.setsWon, winRow.setsLost, winRow.position], [3, 1, 1, 3, 1, 1]);
  eq('3-1 loss: 0 points', [loseRow.matchPoints, loseRow.lost], [0, 1]);
  let rep = null;
  for (let i = 0; i < 60; i++) { rep = await api('GET', `/api/volleyball/matches/${MID}/report.pdf`); if (rep.status === 302 || rep.status === 200) break; await sleep(100); }
  // with R2 configured the report lives there and the link redirects to it
  const reportKey = `volleyball/${T.tournamentId}/${MID}/report-v1.pdf`;
  eq('the PDF report is generated automatically on completion and stored on R2', [rep.status, rep.headers.location], [302, `https://clips.example.test/${reportKey}`]);
  const pdfBytes = bucket.get(reportKey) || Buffer.alloc(0);
  eq('…a real PDF', pdfBytes.slice(0, 5).toString(), '%PDF-');
  const pdfFile = path.join(os.tmpdir(), `vb-report-${Date.now()}.pdf`);
  fs.writeFileSync(pdfFile, pdfBytes);
  const txt = execFileSync('pdftotext', ['-layout', pdfFile, '-']).toString();
  ok('…with both teams, the result, the venue and set scores', txt.includes(match.teamA.name) && txt.includes(match.teamB.name) && /3\s+–\s+1/.test(txt) && txt.includes('NSCI Dome') && /SET 4/.test(txt));
  ok('…the player scorecards', txt.includes('— PLAYERS') && txt.includes(sideTeam.A.players[2].name));
  ok('…and its version in the footer', /report v1/.test(txt) && /Page 1 of \d/.test(txt));
  const rec1 = (await api('GET', `/api/volleyball/matches/${MID}`)).json.match.report;
  eq('report v1 recorded on the match', [rec1.status, rec1.version], ['ready', 1]);

  head('CORRECTIONS AFTER COMPLETION');
  const noReason = await send({ type: 'UNDO' });
  eq('undoing the final point of a finished match needs a reason', noReason.code, 'REASON_REQUIRED');
  const undo = await send({ type: 'UNDO', reason: 'last point given to the wrong team' });
  eq('with a reason: the match is reopened', [undo.ok, undo.status, undo.summary.points.A], [true, 'live', 24]);
  const reopened = (await api('GET', `/api/volleyball/matches/${MID}`)).json.match;
  eq('…the report is marked out of date, the standings drop the result', [reopened.report.stale, (await api('GET', `/api/volleyball/tournaments/${T.tournamentId}/standings`)).json.standings.groups[0].rows.find((x) => x.teamId === match.teamA.teamId).played], [true, 0]);
  await send({ type: 'RALLY', winner: 'A' });
  let rec2 = null;
  for (let i = 0; i < 60; i++) { rec2 = (await api('GET', `/api/volleyball/matches/${MID}`)).json.match.report; if (rec2 && rec2.version === 2 && rec2.status === 'ready') break; await sleep(100); }
  eq('completed again: the report is remade as v2', [rec2.version, rec2.status, rec2.stale], [2, 'ready', false]);
  const statsBefore = (await api('GET', `/api/volleyball/matches/${MID}/stats`)).json.stats;
  const tl = (await api('GET', `/api/volleyball/matches/${MID}/timeline`)).json.timeline;
  const plain = tl.find((e) => e.type === 'RALLY' && e.team === 'A' && e.outcome === 'GENERAL' && !e.voided);
  const cor = await send({ type: 'CORRECT', target: plain.eventId, patch: { outcome: 'ATTACK_KILL', players: { attacker } }, reason: 'video review: kill by the opposite' });
  ok('a classification correction on the finished match', cor.ok, cor);
  const statsAfter = (await api('GET', `/api/volleyball/matches/${MID}/stats`)).json.stats;
  eq('…the attacker has one more kill, the score is unchanged', [statsAfter.players[attacker].attack.kills - statsBefore.players[attacker].attack.kills, statsAfter.teams.A.points === statsBefore.teams.A.points], [1, true]);

  head('CLIPS');
  const pointEntry = tl.find((e) => e.eventId === 'kill-1');
  const clipId = `${MID}_${pointEntry.eventId}`;
  const bytes = makeClip(10);
  const meta = (tok) => JSON.stringify({ sport: 'volleyball', vbClipToken: tok, eventId: pointEntry.eventId, team: 'A', set: 1, score: { A: 1, B: 0 }, preRollSec: 7, postRollSec: 3 });
  const bad = await api('POST', `/api/volleyball/clips/ingest?matchId=${MID}&clipId=${clipId}&timestamp=${Date.now()}`, { raw: bytes, headers: { 'X-Ball-Meta': meta('wrong') } });
  eq('a clip without the match’s clip token is refused', bad.status, 403);
  const other = await api('POST', `/api/volleyball/clips/ingest?matchId=${MID}&clipId=NOTMINE_1&timestamp=1`, { raw: bytes, headers: { 'X-Ball-Meta': meta(match.clipToken) } });
  eq('a clipId of another match is refused', other.status, 400);
  const good = await api('POST', `/api/volleyball/clips/ingest?matchId=${MID}&clipId=${clipId}&timestamp=${Date.now()}`, { raw: bytes, headers: { 'X-Ball-Meta': meta(match.clipToken), 'X-Clip-Meta': JSON.stringify({ preRollSec: 7, postRollSec: 3, actualPreRollSec: 7 }) } });
  eq('the real clip is received', [good.status, good.json.status], [200, 'LOCAL_RECEIVED']);
  ok('…its real duration measured (~10 s)', Math.abs(good.json.durationSec - 10) < 0.6, good.json.durationSec);
  let st2 = null;
  for (let i = 0; i < 80; i++) { st2 = (await api('GET', `/api/volleyball/clips/status/${clipId}`)).json; if (st2.status === 'COMPLETE') break; await sleep(100); }
  eq('uploaded to R2 (Drive not configured counts as nothing to do)', [st2.status, st2.r2Status], ['COMPLETE', 'uploaded']);
  const key = [...bucket.keys()].find((k) => k.endsWith(clipId + '.mp4'));
  eq('stored under the volleyball namespace, by set and point', key, `volleyball/${T.tournamentId}/${MID}/set-1/point-1-${clipId}.mp4`);
  const forAttacker = (await api('GET', `/api/volleyball/matches/${MID}/clips?playerId=${attacker}`)).json.clips;
  eq('the attacker’s video icon finds the clip of their point', forAttacker.map((c) => [c.clipId, c.set, c.pointNo, c.displayStatus]), [[clipId, 1, 1, 'Upload complete']]);
  const someoneElse = six('A')[0];
  eq('…another player’s icon does not', (await api('GET', `/api/volleyball/matches/${MID}/clips?playerId=${someoneElse}`)).json.clips.length, 0);
  await api('POST', `/api/volleyball/clips/${clipId}/players`, { json: { links: [{ playerId: someoneElse, role: 'setter' }] }, token: TOK.work });
  eq('linked by hand to the setter: now in their list too', (await api('GET', `/api/volleyball/matches/${MID}/clips?playerId=${someoneElse}`)).json.clips.length, 1);
  eq('only a manager can link players', (await api('POST', `/api/volleyball/clips/${clipId}/players`, { json: { links: [] }, token: TOK.vinit })).status, 403);
  const reg = await api('POST', `/api/volleyball/matches/${MID}/clips`, { json: { clipId: `${MID}_ev-unavail`, eventId: 'ev-unavail', status: 'UNAVAILABLE', error: 'Stream Engine not running on this PC' }, token: TOK.work });
  eq('a point whose clip could not be made says so honestly', reg.json.clip.displayStatus, 'Unavailable');
  const counts = (await api('GET', `/api/volleyball/matches/${MID}/stats`)).json.clipCounts;
  ok('per-player clip counts for the scorecard', counts[attacker] === 1 && counts[someoneElse] === 1, counts);

  head('ONE POINT, TWO DEVICES (phone panel + Clipper PC)');
  const twoId = `${MID}_ev-two-dev`;
  const regAs = (status, extra) => api('POST', `/api/volleyball/matches/${MID}/clips`, { json: Object.assign({ clipId: twoId, eventId: 'ev-two-dev', status, t0: Date.now(), preRollSec: 7, postRollSec: 3 }, extra || {}), token: TOK.work });
  const st1 = await regAs('UNAVAILABLE', { error: 'The Stream Engine is not running on this PC' });
  eq('the phone (no engine) says it could not clip the point', [st1.status, st1.json.clip.status], [200, 'UNAVAILABLE']);
  const st2b = await regAs('REQUESTED', { sourceSessionId: 'clipper:pc' });
  eq('the Clipper PC then clips it: the record is upgraded', [st2b.json.clip.status, st2b.json.clip.displayStatus], ['REQUESTED', 'Waiting for post-roll']);
  const st3 = await regAs('UNAVAILABLE', { error: 'late answer from the phone' });
  eq('a late "could not" from the phone never overwrites the clip being made', st3.json.clip.status, 'REQUESTED');
  const shown2 = (await api('GET', `/api/volleyball/matches/${MID}/clips?eventId=ev-two-dev`)).json.clips;
  eq('…and the website shows one clip for the point, with no error', [shown2.length, shown2[0].error], [1, null]);
  head('THE UPLOAD FAILS, THEN A RETRY');
  r2FailVideos = 1;
  const rid = `${MID}_ev-retry`;
  await api('POST', `/api/volleyball/matches/${MID}/clips`, { json: { clipId: rid, eventId: 'ev-retry', status: 'REQUESTED' }, token: TOK.work });
  await api('POST', `/api/volleyball/clips/ingest?matchId=${MID}&clipId=${rid}&timestamp=${Date.now()}`, { raw: makeClip(3), headers: { 'X-Ball-Meta': JSON.stringify({ sport: 'volleyball', vbClipToken: match.clipToken, eventId: 'ev-retry' }) } });
  let rst = null;
  for (let i = 0; i < 80; i++) { rst = (await api('GET', `/api/volleyball/matches/${MID}/clips?eventId=ev-retry`)).json.clips[0]; if (rst && rst.status === 'RETRY_PENDING') break; await sleep(100); }
  eq('R2 down: the clip stays on the website, "Upload pending" — never reported complete', rst && [rst.status, rst.displayStatus, rst.r2Status, !!rst.watchUrl], ['RETRY_PENDING', 'Upload pending', 'failed', true]);
  eq('…the engine is told it is not done', (await api('GET', `/api/volleyball/clips/status/${rid}`)).json.status, 'RETRY_PENDING');
  eq('…another account cannot ask for a retry', (await api('POST', `/api/volleyball/clips/${rid}/retry`, { token: TOK.vinit })).status, 403);
  const t0r = Date.now();
  const rr = await api('POST', `/api/volleyball/clips/${rid}/retry`, { token: TOK.work });
  for (let i = 0; i < 80; i++) { rst = (await api('GET', `/api/volleyball/matches/${MID}/clips?eventId=ev-retry`)).json.clips[0]; if (rst.status === 'COMPLETE') break; await sleep(100); }
  eq('…the operator\'s retry (R2 back) uploads it at once', [rr.status, rst.status, rst.displayStatus, Date.now() - t0r < 5000], [200, 'COMPLETE', 'Upload complete', true]);
  eq('a clip id cannot be re-used for another point', (await api('POST', `/api/volleyball/matches/${MID}/clips`, { json: { clipId: twoId, eventId: 'ev-other', status: 'REQUESTED' }, token: TOK.work })).status, 409);

  head('THE CLIPPING SESSION — one device clips a match');
  const clp = (body, token) => api('POST', `/api/volleyball/matches/${MID}/clipper`, { json: body, token: token || TOK.work });
  const k1 = await clp({ action: 'start', sessionId: 'clp-pc', label: 'vMix PC', status: { state: 'READY', text: 'Recording detected', recording: { file: 'C:\\Users\\op\\Videos\\match.mp4', seconds: 120, growing: true }, counts: { done: 3 } } });
  eq('the vMix PC starts clipping the match', [k1.status, k1.json.clipper.live, k1.json.clipper.label, k1.json.clipper.status.state], [200, true, 'vMix PC', 'READY']);
  eq('…its recording is kept as a file NAME only (never a local path)', k1.json.clipper.status.recording.file, 'match.mp4');
  eq('another account cannot start or see it', [(await clp({ action: 'start', sessionId: 'x' }, TOK.vinit)).status, (await api('GET', `/api/volleyball/matches/${MID}/clipper`, { token: TOK.vinit })).status], [403, 403]);
  const k2 = await clp({ action: 'start', sessionId: 'clp-laptop', label: 'Laptop' });
  eq('a second device is refused while the first one clips (no point cut twice)', [k2.status, k2.json.code, k2.json.clipper.label], [409, 'CLIPPER_ELSEWHERE', 'vMix PC']);
  eq('the clipping device keeps it alive with its status', [(await clp({ action: 'beat', sessionId: 'clp-pc', status: { state: 'PROCESSING', counts: { processing: 2 } } })).json.clipper.status.counts.processing], [2]);
  const k3 = await clp({ action: 'start', sessionId: 'clp-laptop', label: 'Laptop', force: true });
  eq('…an explicit take-over moves it', [k3.status, k3.json.clipper.label, k3.json.clipper.takenFrom], [200, 'Laptop', 'vMix PC']);
  eq('the first device then learns it lost it (and stops sending clips)', [(await clp({ action: 'beat', sessionId: 'clp-pc' })).status, (await clp({ action: 'beat', sessionId: 'clp-pc' })).json.code], [409, 'CLIPPER_LOST']);
  const k4 = await clp({ action: 'stop', sessionId: 'clp-laptop' });
  eq('stopped: no longer live, the state says STOPPED', [k4.json.clipper.live, k4.json.clipper.status.state, !!k4.json.clipper.stoppedAt], [false, 'STOPPED', true]);
  eq('…and anyone may start clipping again', (await clp({ action: 'start', sessionId: 'clp-pc', label: 'vMix PC' })).status, 200);
  await clp({ action: 'stop', sessionId: 'clp-pc' });

  head('AUDIT AND ISOLATION');
  const au = (await api('GET', `/api/volleyball/matches/${MID}/audit`, { token: TOK.work })).json.audit.map((a) => a.action);
  ['lease.takeover', 'match.lock', 'match.unlock', 'match.start', 'match.complete', 'match.reopen', 'event.correct', 'report.generate', 'report.regenerate', 'clip.links', 'clipper.start', 'clipper.stop'].forEach((a) => ok('audit: ' + a, au.includes(a), au));
  const cricketList = (await api('GET', '/api/public/tournaments')).json;
  ok('cricket’s tournament list does not contain volleyball', !JSON.stringify(cricketList).includes('Mumbai Volley League'));
  const leagues = await mem.collection('leagues').countDocuments({});
  eq('no volleyball row in any cricket collection', [leagues, await mem.collection('matchRecords').countDocuments({}), await mem.collection('balls').countDocuments({}), await mem.collection('clips').countDocuments({})], [0, 0, 0, 0]);

  await scorer.close(); await overlay.close(); await cricket.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
