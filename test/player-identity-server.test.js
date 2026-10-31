// 🧬 Player Merge & Management on the REAL server.js (test/server-boot.js:
// in-memory MongoDB with the production indexes), over HTTP:
//
//   • only chhayajeeth@gmail.com: 401 without a sign-in, 403 for every other
//     account (an authorized creator too) on every route
//   • search finds a player by spelling mistakes, an initial, a Player ID,
//     a team; duplicates are suggested (High / Review required) — never
//     merged by themselves; players who met in a match are "unlikely"
//   • GLOBAL PLAYER REPLACE: Rohit Sharmma (P219) and R. Sharma (P347) into
//     the master Rohit Sharma (P102), across two tournaments, two saved
//     teams, scorecards, dismissal text, deliveries, clips, the panel's
//     snapshot, the live room and imported commentary:
//       - preview: counts, the stats before / after, the leaderboards
//       - every reference points at P102 with the corrected name; runs,
//         wickets, results and every delivery's outcome unchanged; clip
//         videos untouched; no player twice in a roster
//       - P219 / P347 are gone from the players collection (a forwarding
//         record sends a stale laptop's id to P102), from search and from
//         the public leaderboards; the public leaderboard is consolidated
//       - Merge History; roll back → every document exactly as before
//   • CORRECT PLAYER NAME: same Player ID, the name everywhere
//   • refused: two players who played against each other / batted in one
//     innings, a name another player has, a live match; warnings must be
//     confirmed; a change after the preview → nothing written
//   • a failure half way (an injected database error) → rolled back,
//     nothing left half changed; a rollback after a later change → refused
//
//   node test/player-identity-server.test.js
const { bootServer, request } = require('./server-boot.js');
const { connect } = require('./socketio-polling-client.js');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const { OWNER, TOK, idTokens, pk, seed, bat } = require('./player-identity-fixtures.js');

(async () => {
  const { port, mem } = await bootServer({ idTokens, users: { [OWNER]: 'chhayajeeth@gmail.com' }, seed });
  const call = (method, url, body, who) => request(port, method, url, body, who === null ? {} : { Authorization: 'Bearer ' + (who || TOK.owner) });
  const C = (n) => mem.collection(n);
  const snap = async () => {
    const out = {};
    for(const n of ['players', 'teams', 'matchRecords', 'balls', 'clips', 'matchPanelStates', 'importedCommentary', 'playerTombstones']) out[n] = JSON.stringify((await C(n).find({}).toArray()).map(d => { const { _id, ...rest } = d; return [String(_id), rest]; }).sort((a, b) => a[0].localeCompare(b[0])));
    return out;
  };
  const waitOp = async (opId) => { for(let i = 0; i < 200; i++){ const r = await call('GET', `/api/player-identity/ops/${opId}`); if(r.json && r.json.op && !['running', 'previewed'].includes(r.json.op.status)) return r.json.op; await sleep(50); } return null; };
  // the live room of M1, as a panel would have left it
  const room = await connect(port, { uid: 'room1' });
  room.emit('updateCricketScore', { teamA: { name: 'D Y Patil', players: [{ id: 'P219', name: 'Rohit Sharmma' }] }, striker: { id: 'P219', name: 'Rohit Sharmma', runs: 67 }, battingCard: { A: [bat('Rohit Sharmma', 'P219', 67, 45)], B: [] }, ballLog: [{ strikerId: 'P219', strikerName: 'Rohit Sharmma', runs: 4 }], localRev: 5 });
  await sleep(400);
  const original = await snap();

  console.log('\n######## Access — chhayajeeth@gmail.com only ########');
  const routes = [['GET', '/api/player-identity/overview'], ['GET', '/api/player-identity/search?q=rohit'], ['GET', '/api/player-identity/player/P102'], ['POST', '/api/player-identity/preview'],
    ['POST', '/api/player-identity/execute'], ['GET', '/api/player-identity/ops'], ['POST', '/api/player-identity/ops/x/rollback']];
  const codes = async (who) => { const out = []; for(const [m, u] of routes) out.push((await call(m, u, {}, who)).status); return out; };
  eq('no sign-in → 401 on every route', await codes(null), routes.map(() => 401));
  eq('an authorized tournament creator (workallsportslive) → 403 on every route', await codes(TOK.creator), routes.map(() => 403));
  eq('any other account → 403', await codes(TOK.stranger), routes.map(() => 403));
  eq('the owner email, not verified → 403', await codes(TOK.unverified), routes.map(() => 403));
  eq('the owner → allowed', (await call('GET', '/api/player-identity/access')).json, { success: true, allowed: true, email: 'chhayajeeth@gmail.com' });
  eq('another account\'s players cannot be opened by asking for its uid', (await call('GET', '/api/player-identity/overview?ownerUid=U2')).status, 403);

  console.log('\n######## Search and duplicate detection ########');
  let r = await call('GET', '/api/player-identity/search?q=Rohit%20Sharma');
  const ids = (list) => list.map(p => p.playerId);
  eq('“Rohit Sharma” finds Rohit Sharma, Rohit Sharmma and R. Sharma (best first)', ids(r.json.results).slice(0, 3), ['P102', 'P219', 'P347']);
  eq('…each with its numbers: matches, runs, wickets, clips, teams, tournaments', (({ matches, batting, bowling, clips, teams, tournaments }) => [matches, batting.runs, bowling.wickets, clips, teams.sort(), tournaments])(r.json.results.find(p => p.playerId === 'P219')),
    [3, 80, 2, 2, ['D Y Patil'], 1]);
  eq('a spelling mistake while searching: “sharmma” → P219 first', ids((await call('GET', '/api/player-identity/search?q=sharmma')).json.results)[0], 'P219');
  eq('a Player ID', ids((await call('GET', '/api/player-identity/search?q=P347')).json.results)[0], 'P347');
  eq('a team: “D Y Patil” lists its players', ids((await call('GET', '/api/player-identity/search?q=D%20Y%20Patil')).json.results).filter(i => ['P219', 'V1'].includes(i)).sort(), ['P219', 'V1']);
  eq('within one tournament only: Winter League has R. Sharma, not Rohit Sharmma', [ids((await call('GET', '/api/player-identity/search?q=sharma&leagueKey=winter%20league')).json.results).includes('P347'), ids((await call('GET', '/api/player-identity/search?q=sharma&leagueKey=winter%20league')).json.results).includes('P219')], [true, false]);
  r = await call('GET', '/api/player-identity/player/P102');
  const cand = Object.fromEntries(r.json.candidates.map(c => [c.playerId, c.level]));
  eq('P102\'s likely duplicates: Rohit Sharmma — High, R. Sharma — Review required', [cand.P219, cand.P347], ['high', 'review']);
  const amit = (await call('GET', '/api/player-identity/player/A1')).json.candidates.find(c => c.playerId === 'A2');
  eq('Amit Patil / Amit Patel played against each other → “unlikely”, with the match named', [amit.level, /Played against each other/.test(amit.conflict)], ['unlikely', true]);
  r = await call('GET', '/api/player-identity/overview');
  const group = r.json.duplicates.find(g => g.players.some(p => p.playerId === 'P102'));
  eq('the dashboard: the Rohit Sharma group, counts, two tournaments to choose from', [group && ids(group.players).sort(), r.json.totals.players >= 14, r.json.tournaments.map(t => t.name).sort()], [['P102', 'P219', 'P347'], true, ['Summer Cup', 'Winter League']]);
  eq('…Amit Patil / Amit Patel are NOT offered as a group (they met on opposite teams)', r.json.duplicates.some(g => ids(g.players).includes('A1') && ids(g.players).includes('A2')), false);
  eq('nothing was changed by looking', await snap(), original);

  console.log('\n######## Global Player Replace — preview ########');
  r = await call('POST', '/api/player-identity/preview', { kind: 'merge', primaryId: 'P102', mergeIds: ['P219', 'P347'] });
  const pv = r.json;
  eq('preview: allowed, nothing written yet', [r.status, pv.canExecute, await snap()], [200, true, original]);
  eq('impact: 2 teams, 2 tournaments, 5 matches, deliveries, clips, the panel snapshot + live room, commentary, 1 profile updated, 2 removed',
    (({ teams, tournaments, matches, deliveries, clips, panelSnapshots, commentary, profilesUpdated, profilesRemoved }) => ({ teams, tournaments, matches, deliveries, clips, panelSnapshots, commentary, profilesUpdated, profilesRemoved }))(pv.counts),
    { teams: 2, tournaments: 2, matches: 5, deliveries: 2, clips: 3, panelSnapshots: 2, commentary: 1, profilesUpdated: 1, profilesRemoved: 2 });
  eq('the numbers before (each record) and after (P102): runs 67+8+5 | 102 | 12 → 194, wickets 2+2, the hundred, a catch, matches 3+1+1',
    [pv.stats.before.map(p => [p.playerId, p.batting.runs, p.bowling.wickets]), pv.stats.after.batting.runs, pv.stats.after.batting.innings, pv.stats.after.batting.hundreds, pv.stats.after.bowling.wickets, pv.stats.after.fielding.catches, pv.stats.after.matches, pv.stats.after.batting.highScore, pv.stats.after.clips],
    [[['P102', 102, 2], ['P219', 80, 2], ['P347', 12, 0]], 194, 5, 1, 4, 1, 5, '102*', 4]);
  eq('…batting average and strike rate recalculated from the totals (194 runs, 4 outs; 194 off 45+6+7+60+9 = 127 balls)', [pv.stats.after.batting.average, pv.stats.after.batting.strikeRate], [(194 / 4).toFixed(2), (194 / 127 * 100).toFixed(2)]);
  const sc = pv.leaderboards.find(l => l.tournament === 'Summer Cup');
  eq('Summer Cup leaderboard: two entries before (Rohit Sharma, Rohit Sharmma), ONE after: 102 + 67 + 8 + 5 = 182 runs', [sc.runs.before.length, sc.runs.after.length, sc.runs.after[0].runs, sc.runs.after[0].name], [2, 1, 182, 'Rohit Sharma']);
  eq('warnings to confirm: the records have different batting hands', pv.warnings.map(w => w.code), ['HANDS_DIFFER']);
  eq('the name-only match (no Player IDs) is included, on its own team', pv.matches.find(m => m.matchId === 'm4').side, 'A');

  console.log('\n######## Global Player Replace — run ########');
  r = await call('POST', '/api/player-identity/execute', { opId: pv.opId });
  eq('not without the warnings confirmed', [r.status, r.json.code], [400, 'ACK_REQUIRED']);
  r = await call('POST', '/api/player-identity/execute', { opId: pv.opId, acknowledged: true });
  eq('confirmed → starts', [r.status, r.json.status], [200, 'running']);
  const again = await call('POST', '/api/player-identity/execute', { opId: pv.opId, acknowledged: true });
  eq('a second click is the same operation, not a second one', again.json.opId, pv.opId);
  let op = await waitOp(pv.opId);
  eq('completed, every stage in order, every check passed', [op.status, [...new Set(op.stages.map(s => s.name))], op.verification.checks.filter(c => !c.ok)],
    ['completed', ['scanning', 'backing up', 'migrating', 'recalculating', 'verifying', 'cleaning up'], []]);
  const recs = Object.fromEntries((await C('matchRecords').find({}).toArray()).map(x => [x.matchId, x]));
  const origRec = Object.fromEntries(JSON.parse(original.matchRecords).map(([, d]) => [d.matchId, d]));
  eq('M1: squad, batting, bowling, captain → P102 / Rohit Sharma', [recs.m1.squadA.players[0], recs.m1.squadA.captainId, recs.m1.battingCard.A[0].id, recs.m1.battingCard.A[0].name, recs.m1.bowlingCard.A[0].id, recs.m1.bowlingCard.A[0].name],
    [{ id: 'P102', name: 'Rohit Sharma', isXI: true }, 'P102', 'P102', 'Rohit Sharma', 'P102', 'Rohit Sharma']);
  eq('…the dismissal he took, in the other team\'s card, and the partnership: the corrected name', [recs.m1.battingCard.B[0].howOut, recs.m1.battingCard.B[0].fielderName, recs.m1.partnerships[1][0].batters], ['c Rohit Sharma b Virat Kohlii', 'Rohit Sharma', ['Rohit Sharma', 'Virat Kohlii']]);
  eq('…67 off 45, 8 fours, 2 sixes, out; 4-0-20-2; the result — all exactly as they were', [recs.m1.battingCard.A[0].runs, recs.m1.battingCard.A[0].balls, recs.m1.battingCard.A[0].fours, recs.m1.battingCard.A[0].sixes, recs.m1.battingCard.A[0].out, recs.m1.bowlingCard.A[0].overs, recs.m1.bowlingCard.A[0].runs, recs.m1.bowlingCard.A[0].wickets, recs.m1.winningTeam, recs.m1.scoreA],
    [67, 45, 8, 2, true, 4, 20, 2, 'A', origRec.m1.scoreA]);
  eq('M3 (Winter League) R. Sharma → Rohit Sharma, P102; M4 (names only) → Rohit Sharma; M8 (imported) → P102', [recs.m3.battingCard.A[0].name, recs.m3.battingCard.A[0].id, recs.m4.battingCard.A[0].name, recs.m8.squadA.players[0].id], ['Rohit Sharma', 'P102', 'Rohit Sharma', 'P102']);
  eq('matches of other players untouched (M2 already right, M5, M6)', [JSON.stringify(recs.m5) === JSON.stringify({ ...origRec.m5, _id: recs.m5._id }), recs.m6.battingCard.A.map(x => x.name)], [true, ['Karan Shah', 'Karan Sha']]);
  const b1 = (await C('balls').find({ matchId: 'room1' }).toArray());
  eq('deliveries: striker / bowler / fielder → P102, Rohit Sharma, rohit sharma; runs and the wicket unchanged',
    b1.map(x => [x.strikerPlayerId, x.striker, x.strikerKey, x.bowlerPlayerId, x.bowler, x.dismissalFielderPlayerId || null, x.dismissal ? x.dismissal.fielder : null, x.runs, x.kind]),
    [['P102', 'Rohit Sharma', 'rohit sharma', 'T2', 'Tiger Bowler', null, null, 4, '4'], ['T1', 'Tiger Tom', 'tiger tom', 'P102', 'Rohit Sharma', 'P102', 'Rohit Sharma', 0, 'W']]);
  const clipsNow = await C('clips').find({}).toArray(), clipsBefore = JSON.parse(original.clips).map(([, d]) => d);
  eq('clips: every one follows P102 (FOUR, the wicket he bowled + caught, the R. Sharma wicket); none added', [clipsNow.length, clipsNow.filter(x => [x.strikerPlayerId, x.bowlerPlayerId, x.fielderPlayerId, x.dismissedPlayerId].includes('P102')).length, clipsNow.some(x => JSON.stringify(x).includes('P219') || JSON.stringify(x).includes('P347'))], [4, 4, false]);
  eq('…the same videos: R2 / Drive keys, URLs and status unchanged', clipsNow.map(x => [x.clipId, x.r2Key, x.r2Url, x.driveFileId, x.status]).sort(), clipsBefore.map(x => [x.clipId, x.r2Key, x.r2Url, x.driveFileId, x.status]).sort());
  const teams = Object.fromEntries((await C('teams').find({}).toArray()).map(t => [t.teamId, t]));
  eq('teams: D Y Patil has P102 (captain); Mumbai Stars has P102 once (R. Sharma was a 2nd entry) and the keeper → P102; Untouched XI untouched',
    [teams.t_dyp.players.map(p => p.id + ':' + p.name), teams.t_dyp.captainId, teams.t_ms.players.map(p => p.id), teams.t_ms.wkId, teams.t_other.rev], [['P102:Rohit Sharma', 'V1:Virat Kohlii'], 'P102', ['P102', 'B1'], 'P102', 1]);
  const ps = (await C('matchPanelStates').findOne({ matchId: 'm1' })).state;
  eq('the panel\'s snapshot (Resume): roster, tiles, ball log, batting hand, fielding, dismissed list → P102', [ps.teamA.players[0].id, ps.teamA.captainId, ps.striker, ps.ballLog[0].strikerId + '/' + ps.ballLog[0].strikerName, Object.keys(ps.batHand).sort(), ps.dismissedThisInnings.A, Object.keys(ps.fieldingStats.A)],
    ['P102', 'P102', { id: 'P102', name: 'Rohit Sharma', runs: 67, balls: 45 }, 'P102/Rohit Sharma', ['P102', 'n:Rohit Sharma'], ['P102'], ['P102']]);
  const roomNow = await request(port, 'GET', '/api/cricket/room-state/room1');
  eq('the live room (/cricket-scorecard?room=…) → Rohit Sharma, P102', roomNow.json && roomNow.json.state ? [roomNow.json.state.striker.name, roomNow.json.state.striker.id, roomNow.json.state.teamA.players[0].id] : null, ['Rohit Sharma', 'P102', 'P102']);
  const ic = await C('importedCommentary').findOne({ matchId: 'm8' });
  eq('imported commentary text → Rohit Sharma', [ic.innings[0].entries[0].batter, ic.innings[0].entries[0].text], ['Rohit Sharma', 'Rohit Sharma drives Lion Leo through the covers for four']);
  const P = Object.fromEntries((await C('players').find({}).toArray()).map(p => [p.playerId, p]));
  eq('profiles: P102 keeps its ID, name, hand; the old spellings resolve to it; P219 / P347 gone from players', [P.P102.displayName, P.P102.batHand, ['rohit sharmma', 'r. sharma'].every(k => P.P102.nameKeys.includes(k)), !!P.P219, !!P.P347], ['Rohit Sharma', 'R', true, false, false]);
  const tombs = await C('playerTombstones').find({}).toArray();
  eq('…a forwarding record per removed ID (old ID → P102), nothing else kept active', tombs.map(t => [t.playerId, t.mergedInto]).sort(), [['P219', 'P102'], ['P347', 'P102']]);
  const oldLink = await request(port, 'GET', '/api/players/P219/stats?scope=career&uid=' + OWNER);
  eq('an old link to P219\'s statistics still answers — with the master\'s (not 404)', [oldLink.status, oldLink.json && oldLink.json.success], [200, true]);
  eq('a laptop still holding P219: the profile route and canonicalize answer P102', [(await request(port, 'GET', '/api/players/P219')).json.playerId, (await request(port, 'GET', '/api/players/P219')).json.mergedFrom], ['P102', 'P219']);
  eq('…canonicalize (Create New Match / Start) maps P219 → P102', (await call('POST', '/api/players/canonicalize?uid=' + OWNER, { ids: ['P219', 'P347'] }, null)).json.map, { P219: 'P102', P347: 'P102' });
  const stale = await call('POST', '/api/teams?uid=' + OWNER, { team: { name: 'Stale Laptop XI', players: [{ id: 'P219', name: 'Rohit Sharmma' }] } }, null);
  eq('…a laptop still holding P219 saves its team: the team gets P102, and no P219 profile comes back', [stale.status, stale.json.team.players.map(p => p.id), await C('players').countDocuments({ playerId: 'P219' })], [201, ['P102'], 0]);
  await C('teams').deleteOne({ teamId: stale.json.team.teamId });
  const searchNow = await call('GET', '/api/player-identity/search?q=sharma');
  eq('search: only P102 for “sharma” — no Rohit Sharmma, no R. Sharma', ids(searchNow.json.results).filter(i => ['P102', 'P219', 'P347'].includes(i)), ['P102']);
  const pub = await call('GET', '/api/public/tournament/tokSummer');
  const lb = pub.json && pub.json.leaderboards;
  eq('public Summer Cup leaderboard: ONE Rohit Sharma, 182 runs in 4 innings (102 + 67 + 8 + 5), 4 wickets; no Rohit Sharmma',
    lb ? [lb.topRuns.filter(x => /sharm/i.test(x.name)).map(x => [x.name, x.runs, x.innings]), lb.topWickets.filter(x => /sharm/i.test(x.name)).map(x => [x.name, x.wickets])] : null,
    [[['Rohit Sharma', 182, 4]], [['Rohit Sharma', 4]]]);
  const lbW = (await call('GET', '/api/public/tournament/tokWinter')).json.leaderboards;
  eq('public Winter League leaderboard: R. Sharma\'s 12 now Rohit Sharma\'s', lbW.topRuns.filter(x => /sharm/i.test(x.name)).map(x => [x.name, x.runs]), [['Rohit Sharma', 12]]);
  const hist = (await call('GET', '/api/player-identity/ops')).json.ops;
  eq('Merge History: the operation, who, the IDs and the original names, the counts', [hist[0].opId, hist[0].kind, hist[0].status, hist[0].by, hist[0].primaryId, hist[0].mergeIds, hist[0].originalNames, hist[0].counts.matches],
    [pv.opId, 'merge', 'completed', 'chhayajeeth@gmail.com', 'P102', ['P219', 'P347'], { P102: 'Rohit Sharma', P219: 'Rohit Sharmma', P347: 'R. Sharma' }, 5]);
  const audit = await C('auditLogs').find({ action: 'Global player replace' }).toArray();
  eq('…and the audit log', audit.length, 1);

  console.log('\n######## Roll back ########');
  r = await call('POST', `/api/player-identity/ops/${pv.opId}/rollback`);
  eq('roll back: allowed (nothing changed since), every document restored', [r.status, r.json.status], [200, 'rolled_back']);
  const back = await snap();
  ['players', 'teams', 'matchRecords', 'balls', 'clips', 'matchPanelStates', 'importedCommentary', 'playerTombstones'].forEach(n => eq(`…${n}: exactly as before the merge`, back[n] === original[n], true));
  const roomBack = await request(port, 'GET', '/api/cricket/room-state/room1');
  eq('…the live room back to Rohit Sharmma', roomBack.json.state.striker.name, 'Rohit Sharmma');
  eq('…Merge History says rolled back', (await call('GET', '/api/player-identity/ops')).json.ops[0].status, 'rolled_back');
  eq('…a second rollback is refused', (await call('POST', `/api/player-identity/ops/${pv.opId}/rollback`)).status, 409);

  console.log('\n######## Refused, and warnings ########');
  r = await call('POST', '/api/player-identity/preview', { kind: 'merge', primaryId: 'A1', mergeIds: ['A2'] });
  eq('Amit Patil + Amit Patel: played on opposite teams → blocked', [r.json.canExecute, r.json.blockers.map(b => b.code)], [false, ['OPPOSITE_TEAMS']]);
  eq('…and execute refuses it', (await call('POST', '/api/player-identity/execute', { opId: r.json.opId })).status, 400);
  r = await call('POST', '/api/player-identity/preview', { kind: 'merge', primaryId: 'K1', mergeIds: ['K2'] });
  eq('Karan Shah + Karan Sha: both batted in one innings → blocked', r.json.blockers.map(b => b.code), ['SAME_INNINGS']);
  r = await call('POST', '/api/player-identity/preview', { kind: 'rename', primaryId: 'P219', name: 'Rohit Sharma' });
  eq('rename P219 to “Rohit Sharma” — another player (P102) has that name → blocked, pointing at Global Player Replace', [r.json.blockers.map(b => b.code), /Global Player Replace/.test(r.json.blockers[0].text)], [['NAME_TAKEN'], true]);
  r = await call('POST', '/api/player-identity/preview', { kind: 'merge', primaryId: 'X1', mergeIds: ['X2'] });
  eq('a match being scored right now → blocked', r.json.blockers.map(b => b.code), ['LIVE_MATCH']);
  r = await call('POST', '/api/player-identity/preview', { kind: 'merge', primaryId: 'P102', mergeIds: ['P102'] });
  eq('the master cannot be merged into itself', r.status, 400);
  r = await call('POST', '/api/player-identity/preview', { kind: 'merge', primaryId: 'P102', mergeIds: ['P219'] });
  eq('a merge with a warning (hands differ) needs the warnings confirmed', [r.json.warnings.map(w => w.code), (await call('POST', '/api/player-identity/execute', { opId: r.json.opId })).json.code], [['HANDS_DIFFER'], 'ACK_REQUIRED']);
  // the data changes after the preview → nothing written
  await C('matchRecords').updateOne({ matchId: 'm1' }, { $set: { venue: 'Changed meanwhile' } });
  const beforeStale = await snap();
  await call('POST', '/api/player-identity/execute', { opId: r.json.opId, acknowledged: true });
  op = await waitOp(r.json.opId);
  eq('a match changed after the preview → failed with DATA_CHANGED, nothing written', [op.status, /changed after the preview/.test(op.error), await snap()], ['failed', true, beforeStale]);

  console.log('\n######## A failure half way → rolled back ########');
  r = await call('POST', '/api/player-identity/preview', { kind: 'merge', primaryId: 'P102', mergeIds: ['P219'] });
  mem.fail('clips', 'updateOne', { times: 1 });
  await call('POST', '/api/player-identity/execute', { opId: r.json.opId, acknowledged: true });
  op = await waitOp(r.json.opId);
  mem.clearFaults();
  eq('an injected database error while moving the clips → failed, rolled back automatically, every document as it was',
    [op.status, op.rollback && op.rollback.ok, op.stages.some(s => s.name === 'rolled back'), await snap()], ['failed', true, true, beforeStale]);
  eq('…never reported as a success', (await call('GET', '/api/player-identity/ops')).json.ops.filter(o => o.opId === r.json.opId).map(o => o.status), ['failed']);

  console.log('\n######## Correct Player Name ########');
  r = await call('POST', '/api/player-identity/preview', { kind: 'rename', primaryId: 'V1', name: 'Virat Kohli' });
  eq('preview: Virat Kohlii → Virat Kohli, same Player ID', [r.json.canExecute, r.json.primaryId, r.json.counts.teams, r.json.counts.matches], [true, 'V1', 1, 1]);
  await call('POST', '/api/player-identity/execute', { opId: r.json.opId, acknowledged: true, wait: true });
  op = await waitOp(r.json.opId);
  const m1 = await C('matchRecords').findOne({ matchId: 'm1' });
  eq('completed: the profile, the team, the scorecard (row, dismissal text, partnership), the delivery — all “Virat Kohli”, still V1',
    [op.status, (await C('players').findOne({ playerId: 'V1' })).displayName, (await C('teams').findOne({ teamId: 't_dyp' })).players[1], m1.battingCard.A[1].name, m1.battingCard.A[1].id, m1.battingCard.B[0].howOut, m1.partnerships[1][0].batters[1], (await C('balls').findOne({ nonStrikerPlayerId: 'V1' })).nonStriker],
    ['completed', 'Virat Kohli', { id: 'V1', name: 'Virat Kohli', isXI: true }, 'Virat Kohli', 'V1', 'c Rohit Sharmma b Virat Kohli', 'Virat Kohli', 'Virat Kohli']);
  eq('…the old spelling is kept only as an alias of the same player (typing it again finds V1)', (await C('players').findOne({ playerId: 'V1' })).nameKeys.sort(), ['virat kohli', 'virat kohlii']);
  // a later change to a match it touched → its rollback is refused, nothing changed
  await C('matchRecords').updateOne({ matchId: 'm1' }, { $set: { venue: 'Edited after the rename' } });
  const beforeRefuse = await snap();
  r = await call('POST', `/api/player-identity/ops/${op.opId}/rollback`);
  eq('rollback after the match was edited → refused (409 CHANGED_SINCE, names the match), nothing changed', [r.status, r.json.code, /m1/.test((r.json.changed || []).join(' ')), await snap()], [409, 'CHANGED_SINCE', true, beforeRefuse]);

  console.log('\n######## A restart cuts an operation off → every document put back ########');
  {
    const PlayerIdentity = require('../player-identity.js');
    r = await call('POST', '/api/player-identity/preview', { kind: 'rename', primaryId: 'L1', name: 'Lion Leon' });
    const beforeCut = await snap();
    await call('POST', '/api/player-identity/execute', { opId: r.json.opId, acknowledged: true });
    op = await waitOp(r.json.opId);
    eq('(the rename ran and wrote: Lion Leo → Lion Leon)', [op.status, (await C('players').findOne({ playerId: 'L1' })).displayName], ['completed', 'Lion Leon']);
    // as if the server stopped after writing, before marking it done
    await C('playerIdentityOps').updateOne({ _id: r.json.opId }, { $set: { status: 'running' } });
    const fresh = PlayerIdentity.createPlayerIdentity({
      db: { players: C('players'), teams: C('teams'), records: C('matchRecords'), balls: C('balls'), clips: C('clips'), leagues: C('leagues'), panelStates: C('matchPanelStates'),
        commentary: C('importedCommentary'), ops: C('playerIdentityOps'), backups: C('playerIdentityBackups'), locks: C('playerIdentityLocks'), tombstones: C('playerTombstones') },
      playerKey: pk, computeLeaderboards: () => ({ topRuns: [], topWickets: [] })
    });
    eq('on start-up: the cut-off operation is found and every document put back', [await fresh.recoverInterrupted(), await snap()], [1, beforeCut]);
    const cut = await C('playerIdentityOps').findOne({ _id: r.json.opId });
    eq('…and it says so in Merge History (failed, restored), never "completed"', [cut.status, /server restart/.test(cut.error), cut.rollback.ok], ['failed', true, true]);
  }

  room.close && room.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
