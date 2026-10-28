/* 🎬 Volleyball on-air graphics on the REAL server (server.js with
   volleyball-server.js, in-memory MongoDB, test Firebase tokens), over the
   /volleyball socket:

     • only the tournament's manager changes what is on air
     • a graphic with nothing true to show is refused (no toss yet, no
       line-up, no finished set, a knockout's points table…)
     • a timed graphic is ended BY THE SERVER, after its entrance plus its
       time — every overlay is told; a held one stays
     • a stop aimed at a replaced graphic is refused as stale
     • an overlay that (re)joins gets what is on air; one that ran out
       while the server was down is reported over, not shown again
     • a time-out graphic goes by itself when the next rally is scored
     • the broadcast look is saved per tournament and pushed to overlays
     • a team's new colours reach its live match's overlay at once;
       player portraits are stored per player and served

     node test/volleyball/graphics-server.test.js
*/
const http = require('http');
const { bootServer } = require('../server-boot.js');
const { connectVb } = require('./vb-socket.js');
const G = require('../../volleyball-graphics.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
function head(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function call(port, method, url, { json, token, headers } = {}) {
  return new Promise((resolve, reject) => {
    const body = json ? Buffer.from(JSON.stringify(json)) : null;
    const h = Object.assign({}, body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}, token ? { Authorization: 'Bearer ' + token } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let j = null; try { j = JSON.parse(buf.toString()); } catch (e) {} resolve({ status: res.statusCode, json: j, buf, type: res.headers['content-type'] }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
// wait until fn() is truthy (polling), or give up
async function until(fn, ms) { const end = Date.now() + (ms || 8000); while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(40); } return null; }

const U = { work: { uid: 'u-work', email: 'workallsportslive@gmail.com', email_verified: true }, vinit: { uid: 'u-vinit', email: 'vinitkrkr1@gmail.com', email_verified: true } };
const PNG = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360f8cf00000301010018dd8db40000000049454e44ae426082', 'hex').toString('base64');

(async () => {
  const { port, mem } = await bootServer({ idTokens: { tw: U.work, tv: U.vinit }, users: { 'u-work': U.work.email, 'u-vinit': U.vinit.email } });
  const api = (m, u, o) => call(port, m, u, Object.assign({ token: 'tw' }, o || {}));
  try {
    const mk = (name, short, color) => api('POST', '/api/volleyball/teams', { json: { name, shortName: short, colors: { primary: color, secondary: '#0a1136', text: '#ffffff' },
      players: Array.from({ length: 8 }, (_, i) => ({ name: `${short} Player ${i + 1}`, number: String(i + 1), role: ['S', 'OH', 'OH', 'MB', 'MB', 'OPP', 'DS', 'L'][i], libero: i === 7 })) } }).then((r) => r.json.team);
    const A = await mk('Pune Panthers', 'PUN', '#c81e1e'), B = await mk('Goa Waves', 'GOA', '#1d4ed8');
    const T = (await api('POST', '/api/volleyball/tournaments', { json: { name: 'Graphics Cup', teamIds: [A.teamId, B.teamId] } })).json.tournament;
    const M = (await api('POST', `/api/volleyball/tournaments/${T.tournamentId}/matches`, { json: { teamA: A.teamId, teamB: B.teamId } })).json.match;
    const lease = (await api('POST', `/api/volleyball/matches/${M.matchId}/lease`, { json: { deviceId: 'd1' } })).json.leaseToken;
    let n = 0;
    const ev = (e) => api('POST', `/api/volleyball/matches/${M.matchId}/events`, { json: { event: Object.assign({ eventId: 'g' + (++n), at: Date.now() }, e) }, headers: { 'x-vb-lease': lease } }).then((r) => r.json);
    const six = (t) => t.players.filter((p) => !p.libero).slice(0, 6).map((p) => p.playerId);

    const op = await connectVb(port, { idToken: 'tw' });
    const other = await connectVb(port, { idToken: 'tv' });
    const viewer = await connectVb(port, {});
    const seen = [];   // what an overlay is told
    viewer.on('vb:graphic', (d) => { if (d.matchId === M.matchId) seen.push(d.graphic); });
    const styles = [], matchDocs = [];
    viewer.on('vb:style', (d) => styles.push(d));
    viewer.on('vb:match', (d) => { if (d.matchId === M.matchId) matchDocs.push(d.match); });
    const j0 = await viewer.emitAck('vb:join', { matchId: M.matchId });
    ok('an overlay joins: nothing on air yet', j0.ok && j0.graphic && j0.graphic.scene === null && typeof j0.graphic.serverNow === 'number', j0.graphic);
    ok('…and is given the broadcast look', j0.style && j0.style.accent === G.STYLE_DEFAULTS.accent, j0.style);
    const gfx = (d) => op.emitAck('vb:graphic', Object.assign({ matchId: M.matchId }, d));

    head('WHO MAY CHANGE WHAT IS ON AIR');
    let r = await other.emitAck('vb:graphic', { matchId: M.matchId, action: 'take', scene: 'intro' });
    ok('another creator account cannot', !r.ok && r.error === 'not-authorised', r);
    r = await viewer.emitAck('vb:graphic', { matchId: M.matchId, action: 'take', scene: 'intro' });
    ok('an overlay (signed out) cannot', !r.ok && r.error === 'not-authorised', r);

    head('NOTHING UNTRUE ON AIR');
    r = await gfx({ action: 'take', scene: 'toss' });
    ok('no toss yet: the toss graphic is refused, with the reason', !r.ok && /No toss recorded/.test(r.error), r);
    r = await gfx({ action: 'take', scene: 'lineup' });
    ok('no line-ups yet: the starting six is refused', !r.ok && /no starting six saved for set 1/.test(r.error), r);
    r = await gfx({ action: 'take', scene: 'setSummary' });
    ok('no set finished: the set result is refused', !r.ok && /No set has finished/.test(r.error), r);
    r = await gfx({ action: 'take', scene: 'rotation' });
    ok('no set being played: the rotation is refused', !r.ok && /while a set is being played/.test(r.error), r);
    r = await gfx({ action: 'take', scene: 'timeout' });
    ok('no time-out running: the time-out graphic is refused', !r.ok && /No time-out/.test(r.error), r);
    r = await gfx({ action: 'take', scene: 'playerStat', data: { playerId: 'vbp-nobody' } });
    ok('a player card for someone in neither squad is refused', !r.ok && /Choose a player/.test(r.error), r);
    ok('…and none of that reached the overlay', seen.length === 0, seen);

    head('A TIMED GRAPHIC IS ENDED BY THE SERVER');
    await ev({ type: 'TOSS', winner: 'B', choice: 'receive', leftSide: 'A' });
    r = await gfx({ action: 'take', scene: 'toss', durationSec: 1 });
    ok('the toss goes on air for 1 s', r.ok && r.graphic.scene === 'toss' && r.graphic.durationSec === 1 && r.graphic.data.set === 1, r.graphic);
    const tossId = r.graphic.id;
    const onAir = await until(() => seen.find((g) => g.id === tossId));
    ok('…every overlay is told', !!onAir && onAir.readyAt === onAir.startedAt + G.BAR_OUT_MS + G.SCENES.toss.enterMs && onAir.expiresAt === onAir.readyAt + 1000, onAir);
    const endMsg = await until(() => seen.find((g) => g.scene === null && g.endedId === tossId), 9000);
    ok('…and told when the server takes it off air, after its entrance + 1 s', !!endMsg && endMsg.reason === 'expired', endMsg);
    ok('…not before', endMsg && endMsg.serverNow >= onAir.expiresAt, { ended: endMsg && endMsg.serverNow, expiresAt: onAir.expiresAt });

    head('HELD, REPLACED, STOPPED — AND STALE');
    r = await gfx({ action: 'take', scene: 'intro', durationSec: 'hold' });
    const introId = r.graphic.id;
    ok('the intro on Hold', r.ok && r.graphic.expiresAt === null, r.graphic);
    r = await gfx({ action: 'take', scene: 'intro', durationSec: 'hold' });
    ok('pressing it again keeps it (no second entrance)', r.ok && r.same && r.graphic.id === introId, r);
    await sleep(600);
    ok('…a held graphic is not ended by the server', (await viewer.emitAck('vb:sync', { matchId: M.matchId })).graphic.id === introId);
    r = await gfx({ action: 'take', scene: 'standings', durationSec: 'hold' });
    const tableId = r.graphic.id;
    ok('the points table replaces it', r.ok && r.graphic.scene === 'standings' && r.graphic.endedId === introId, r.graphic);
    r = await gfx({ action: 'stop', id: introId });
    ok('a late "dismiss" for the replaced intro is refused as stale', !r.ok && r.stale && r.graphic.id === tableId, r);
    r = await gfx({ action: 'stop', id: tableId });
    ok('dismissing the points table takes it off air', r.ok && r.graphic.scene === null && r.graphic.endedId === tableId && r.graphic.reason === 'stopped', r.graphic);
    r = await gfx({ action: 'clean' });
    ok('"hide everything"', r.ok && r.graphic.clean === true, r.graphic);
    r = await gfx({ scene: 'scorebug' });
    ok('an older panel\'s "scoreboard only" still works', r.ok && r.graphic.scene === null && r.graphic.clean === false, r.graphic);

    head('STARTING SIX — BOTH TEAMS, NEXT TEAM');
    await ev({ type: 'LINEUP', team: 'A', set: 1, positions: six(A) });
    r = await gfx({ action: 'take', scene: 'lineup' });
    ok('only one line-up saved: both teams is refused, naming the other', !r.ok && /Goa Waves: no starting six saved for set 1/.test(r.error), r);
    r = await gfx({ action: 'take', scene: 'lineup', data: { team: 'A' } });
    ok('…the team with one is fine', r.ok && r.graphic.data.team === 'A' && r.graphic.data.set === 1, r.graphic);
    await ev({ type: 'LINEUP', team: 'B', set: 1, positions: six(B) });
    r = await gfx({ action: 'take', scene: 'lineup', durationSec: 'hold' });
    ok('both teams, held', r.ok && !r.graphic.data.team && r.graphic.swapAt === null && r.graphic.expiresAt === null, r.graphic);
    const lu = r.graphic;
    r = await gfx({ action: 'next', id: lu.id });
    ok('NEXT TEAM: team two takes over (once team one is in)', r.ok && r.graphic.swapAt === lu.readyAt, r.graphic);

    head('A RELOADED OVERLAY — AND A SERVER THAT WAS DOWN');
    const late = await connectVb(port, {});
    let j = await late.emitAck('vb:join', { matchId: M.matchId });
    ok('an overlay that joins now gets the graphic on air (with its times)', j.ok && j.graphic.id === lu.id && j.graphic.swapAt === lu.readyAt, j.graphic);
    // a timed graphic whose time ran out while no timer was armed (a restart)
    const past = Object.assign({}, lu, { seq: lu.seq + 1000, id: 'gpast', scene: 'intro', data: {}, expiresAt: Date.now() - 5000, swapAt: null });
    delete past.serverNow; delete past.timing; delete past.label;
    await mem.collection('vbMatches').updateOne({ matchId: M.matchId }, { $set: { graphic: past } });
    j = await late.emitAck('vb:join', { matchId: M.matchId });
    ok('a graphic that ran out meanwhile is reported over, never shown again', j.ok && j.graphic.scene === null && j.graphic.endedId === 'gpast' && j.graphic.reason === 'expired', j.graphic);
    await late.close();

    head('TIME-OUT: THE GRAPHIC GOES WHEN PLAY IS BACK ON');
    await ev({ type: 'SET_START', set: 1 });
    await ev({ type: 'RALLY', winner: 'A', outcome: 'GENERAL' });
    await ev({ type: 'TIMEOUT', team: 'B' });
    r = await gfx({ action: 'take', scene: 'timeout' });
    ok('during a time-out the time-out graphic goes on air', r.ok && r.graphic.scene === 'timeout' && r.graphic.data.team === 'B', r.graphic);
    const toId = r.graphic.id;
    ok('…set to end with the time-out (30 s after it was called)', r.graphic.until === true && Math.abs(r.graphic.expiresAt - (Date.now() + 30000)) < 3000, r.graphic);
    await ev({ type: 'RALLY', winner: 'B', outcome: 'GENERAL' });
    const resumed = await until(() => seen.find((g) => g.scene === null && g.endedId === toId));
    ok('the next rally takes it off air (play resumed)', !!resumed && resumed.reason === 'play-resumed', resumed);
    r = await gfx({ action: 'take', scene: 'rotation' });
    ok('during the set the rotation can go on air', r.ok && r.graphic.scene === 'rotation', r);
    r = await gfx({ action: 'take', scene: 'playerStat', data: { playerId: A.players[3].playerId } });
    ok('…and a player card', r.ok && r.graphic.data.playerId === A.players[3].playerId, r);
    r = await gfx({ action: 'take', scene: 'standings' });
    ok('the points table (league)', r.ok && r.graphic.scene === 'standings', r);
    await gfx({ action: 'live' });

    head('THE BROADCAST LOOK — SAVED, PUSHED, VALIDATED');
    r = await call(port, 'PUT', `/api/volleyball/tournaments/${T.tournamentId}/broadcast`, { token: 'tv', json: { style: { accent: '#ff0000' } } });
    ok('another account cannot change it', r.status === 403, r.status);
    r = await api('PUT', `/api/volleyball/tournaments/${T.tournamentId}/broadcast`, { json: { style: { accent: '#00C2FF', backdrop: 'solid', speed: 1.25, font: 'oswald', durations: { toss: 6, final: 'hold' }, junk: 1, dim: 2 } } });
    ok('the manager saves it — cleaned', r.status === 200 && r.json.style.accent === '#00c2ff' && r.json.style.backdrop === 'solid' && r.json.style.speed === 1.25 && r.json.style.font === 'oswald' && r.json.style.dim === 0.95 && !('junk' in r.json.style), r.json);
    const pushed = await until(() => styles.find((x) => x.tournamentId === T.tournamentId && x.style.accent === '#00c2ff'));
    ok('…the overlays on air are told at once', !!pushed);
    r = await api('PUT', `/api/volleyball/tournaments/${T.tournamentId}/broadcast`, { json: { style: { pointTags: false } } });
    ok('…a later change keeps the rest', r.json.style.accent === '#00c2ff' && r.json.style.pointTags === false && r.json.style.durations.toss === 6, r.json.style);
    r = await gfx({ action: 'take', scene: 'playerStat', data: { playerId: B.players[2].playerId } });
    ok('a graphic taken now uses the tournament\'s speed', r.graphic.speed === 1.25 && r.graphic.readyAt === r.graphic.startedAt + Math.round((G.BAR_OUT_MS + G.SCENES.playerStat.enterMs) * 1.25), r.graphic);
    const pub = await call(port, 'GET', `/api/volleyball/matches/${M.matchId}`);
    ok('the match page carries the look', pub.json.tournament.broadcast.accent === '#00c2ff', pub.json.tournament && pub.json.tournament.broadcast);

    head('A LIVE MATCH FOLLOWS ITS TEAM\'S NEW LOOK; PORTRAITS');
    matchDocs.length = 0;
    r = await api('PUT', `/api/volleyball/teams/${A.teamId}`, { json: { colors: { primary: '#22aa55', secondary: '#0a1136', text: '#ffffff' } } });
    ok('team colours changed', r.status === 200, r.status);
    const md = await until(() => matchDocs.find((x) => x.teamA && x.teamA.colors && x.teamA.colors.primary === '#22aa55'));
    ok('…the live match\'s overlay is sent the new colours', !!md);
    const sq = (await call(port, 'GET', `/api/volleyball/matches/${M.matchId}`)).json.match.squads.A;
    ok('…its squad is untouched', sq.length === 8 && sq.every((p) => A.players.some((q) => q.playerId === p.playerId)), sq.length);
    const pid = A.players[0].playerId;
    r = await call(port, 'PUT', `/api/volleyball/teams/${A.teamId}/players/${pid}/photo`, { token: 'tv', json: { photo: PNG } });
    ok('another account cannot set a portrait', r.status === 403, r.status);
    r = await api('PUT', `/api/volleyball/teams/${A.teamId}/players/${pid}/photo`, { json: { photo: 'data:text/html;base64,PGI+' } });
    ok('…anything but a picture is refused', r.status === 400, r.status);
    r = await api('PUT', `/api/volleyball/teams/${A.teamId}/players/${pid}/photo`, { json: { photo: PNG } });
    ok('the manager sets one', r.status === 200 && /\/api\/volleyball\/players\/.+\/photo\?v=1$/.test(r.json.photo), r.json);
    const img = await call(port, 'GET', r.json.photo);
    ok('…it is served as the picture it is', img.status === 200 && img.type === 'image/png' && img.buf.length > 20, { status: img.status, type: img.type });
    const info = (await call(port, 'GET', `/api/volleyball/matches/${M.matchId}`)).json;
    ok('…and the match knows it (and no one else\'s)', info.photos && info.photos[pid] === r.json.photo && Object.keys(info.photos).length === 1, info.photos);
    r = await api('PUT', `/api/volleyball/teams/${A.teamId}/players/${pid}/photo`, { json: { photo: null } });
    ok('removed again', r.status === 200 && r.json.photo === null && (await call(port, 'GET', `/api/volleyball/players/${pid}/photo`)).status === 404, r.json);

    await op.close(); await other.close(); await viewer.close();
  } catch (e) {
    fail++; console.log('  FAIL  crashed: ' + (e.stack || e));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
