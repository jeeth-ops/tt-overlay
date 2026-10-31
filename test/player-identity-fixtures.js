// 🧬 Player Merge & Management — the controlled duplicates both the server
// test (player-identity-server.test.js) and the browser test
// (player-identity-ui.test.js) run on: one owner account, two tournaments,
// Rohit Sharma (P102) / Rohit Sharmma (P219) / R. Sharma (P347) spread over
// saved teams, scorecards (with and without Player IDs), dismissal text,
// partnerships, deliveries, clips, the panel's snapshot and imported
// commentary — and the pairs that must never be merged.
const OWNER = 'U1';
const TOK = { owner: 'tok-owner', creator: 'tok-creator', stranger: 'tok-stranger', unverified: 'tok-unverified' };
const idTokens = {
  [TOK.owner]: { uid: OWNER, email: 'chhayajeeth@gmail.com', email_verified: true },
  [TOK.creator]: { uid: 'U2', email: 'workallsportslive@gmail.com', email_verified: true },
  [TOK.stranger]: { uid: 'U3', email: 'someone@example.com', email_verified: true },
  [TOK.unverified]: { uid: OWNER, email: 'chhayajeeth@gmail.com', email_verified: false }
};
const pk = (n) => String(n).trim().toLowerCase().replace(/\s+/g, ' ');
const prof = (playerId, name, extra) => Object.assign({ playerId, ownerUid: OWNER, nameKeys: [pk(name)], displayName: name, createdAt: 1, updatedAt: 1 }, extra || {});
const bat = (name, id, runs, balls, o) => Object.assign({ name, id, runs, balls, fours: 0, sixes: 0, out: false, howOut: 'not out', inningsNo: 1 }, o || {});
const bowl = (name, id, overs, runs, wickets, o) => Object.assign({ name, id, overs, balls: 0, maidens: 0, runs, wickets, inningsNo: 1 }, o || {});
const sq = (players, captainId) => ({ players: players.map(([id, name, isXI]) => ({ id, name, isXI: isXI !== false })), captainId: captainId || null, wkId: null });
function rec(o){
  return Object.assign({ ownerUid: OWNER, upcoming: false, format: 'T20', winningTeam: 'A', resultText: 'DONE', inningsArchive: [{ no: 1, team: 'A', runs: 150, wickets: 5, overs: '20.0' }, { no: 2, team: 'B', runs: 120, wickets: 10, overs: '18.0' }],
    scoreA: { runs: 150, wickets: 5, overs: '20.0' }, scoreB: { runs: 120, wickets: 10, overs: '18.0' }, extras: { A: {}, B: {} }, fallOfWickets: { A: [], B: [] } }, o);
}
let seq = 0;
const ball = (matchId, o) => Object.assign({ matchId, ownerUid: OWNER, innings: 1, over: 0, ballInOver: ++seq % 6 + 1, kind: '1', runs: 1, battingTeam: 'A', timestamp: 1700000000000 + seq, ballUid: 'b' + seq }, o);
const clip = (matchId, o) => Object.assign({ matchId, ownerUid: OWNER, clipId: 'clip-' + (++seq), r2Key: `clips/${matchId}/${seq}.mp4`, r2Url: `https://cdn.example.com/clips/${matchId}/${seq}.mp4`,
  driveFileId: 'drive-' + seq, driveUrl: 'https://drive.example.com/' + seq, status: 'COMPLETE', r2Status: 'done', driveStatus: 'done', isHighlight: true, createdAt: 1700000000000 + seq, battingTeam: 'A' }, o);

async function seed(mem){
  const c = (n) => mem.collection(n);
  await c('leagues').insertOne({ ownerUid: OWNER, leagueKey: 'summer cup', displayName: 'Summer Cup', publicToken: 'tokSummer', sport: 'cricket', info: {}, liveMatches: [], createdAt: 1, updatedAt: 1 });
  await c('leagues').insertOne({ ownerUid: OWNER, leagueKey: 'winter league', displayName: 'Winter League', publicToken: 'tokWinter', sport: 'cricket', info: {}, liveMatches: [{ matchId: 'm-live', roomId: 'room-live' }], createdAt: 1, updatedAt: 1 });
  for(const p of [prof('P102', 'Rohit Sharma', { batHand: 'R' }), prof('P219', 'Rohit Sharmma', { batHand: 'L' }), prof('P347', 'R. Sharma'), prof('V1', 'Virat Kohlii'), prof('T1', 'Tiger Tom'), prof('T2', 'Tiger Bowler'),
    prof('B1', 'Jasprit Bumrah'), prof('L1', 'Lion Leo'), prof('A1', 'Amit Patil'), prof('A2', 'Amit Patel'), prof('K1', 'Karan Shah'), prof('K2', 'Karan Sha'), prof('X1', 'Live Player'), prof('X2', 'Live Playerr')]) await c('players').insertOne(p);
  await c('teams').insertOne({ ownerUid: OWNER, teamId: 't_dyp', name: 'D Y Patil', nameKey: 'd y patil', short: 'DYP', players: [{ id: 'P219', name: 'Rohit Sharmma', isXI: true }, { id: 'V1', name: 'Virat Kohlii', isXI: true }], captainId: 'P219', wkId: null, rev: 3, createdAt: 1, updatedAt: 1 });
  await c('teams').insertOne({ ownerUid: OWNER, teamId: 't_ms', name: 'Mumbai Stars', nameKey: 'mumbai stars', short: 'MS', players: [{ id: 'P102', name: 'Rohit Sharma', isXI: true }, { id: 'B1', name: 'Jasprit Bumrah', isXI: true }, { id: 'P347', name: 'R. Sharma', isXI: false }], captainId: null, wkId: 'P347', rev: 1, createdAt: 1, updatedAt: 1 });
  await c('teams').insertOne({ ownerUid: OWNER, teamId: 't_other', name: 'Untouched XI', nameKey: 'untouched xi', short: 'UX', players: [{ id: 'L1', name: 'Lion Leo', isXI: true }], captainId: null, wkId: null, rev: 1, createdAt: 1, updatedAt: 1 });
  // M1 — Summer Cup: D Y Patil (A) with Rohit Sharmma (P219) v Tigers
  await c('matchRecords').insertOne(rec({ leagueKey: 'summer cup', matchId: 'm1', roomId: 'room1', matchNo: 1, savedAt: '2026-09-01T10:00:00Z', matchDate: '2026-09-01',
    teamA: { name: 'D Y Patil', teamId: 't_dyp' }, teamB: { name: 'Tigers' },
    squadA: sq([['P219', 'Rohit Sharmma'], ['V1', 'Virat Kohlii']], 'P219'), squadB: sq([['T1', 'Tiger Tom'], ['T2', 'Tiger Bowler']]),
    battingCard: { A: [bat('Rohit Sharmma', 'P219', 67, 45, { fours: 8, sixes: 2, out: true, howOut: 'c Tiger Tom b Tiger Bowler', dismissalType: 'Caught', fielderName: 'Tiger Tom', bowlerName: 'Tiger Bowler' }), bat('Virat Kohlii', 'V1', 30, 20)],
      B: [bat('Tiger Tom', 'T1', 22, 30, { inningsNo: 2, out: true, howOut: 'c Rohit Sharmma b Virat Kohlii', dismissalType: 'Caught', fielderName: 'Rohit Sharmma', bowlerName: 'Virat Kohlii' })] },
    bowlingCard: { A: [bowl('Rohit Sharmma', 'P219', 4, 20, 2, { inningsNo: 2 }), bowl('Virat Kohlii', 'V1', 3, 25, 1, { inningsNo: 2 })], B: [bowl('Tiger Bowler', 'T2', 4, 35, 1)] },
    partnerships: { 1: [{ batters: ['Rohit Sharmma', 'Virat Kohlii'], runs: 80, pairKey: 'Rohit Sharmma|Virat Kohlii' }] } }));
  await c('balls').insertOne(ball('room1', { striker: 'Rohit Sharmma', strikerKey: 'rohit sharmma', strikerPlayerId: 'P219', nonStriker: 'Virat Kohlii', nonStrikerKey: 'virat kohlii', nonStrikerPlayerId: 'V1', bowler: 'Tiger Bowler', bowlerKey: 'tiger bowler', bowlerPlayerId: 'T2', kind: '4', runs: 4 }));
  await c('balls').insertOne(ball('room1', { innings: 2, battingTeam: 'B', striker: 'Tiger Tom', strikerKey: 'tiger tom', strikerPlayerId: 'T1', bowler: 'Rohit Sharmma', bowlerKey: 'rohit sharmma', bowlerPlayerId: 'P219', kind: 'W', runs: 0,
    dismissal: { type: 'Caught', batter: 'Tiger Tom', fielder: 'Rohit Sharmma' }, dismissedPlayerKey: 'tiger tom', dismissedPlayerId: 'T1', dismissalFielderKey: 'rohit sharmma', dismissalFielderPlayerId: 'P219' }));
  await c('clips').insertOne(clip('room1', { eventType: 'FOUR', strikerName: 'Rohit Sharmma', strikerKey: 'rohit sharmma', strikerPlayerId: 'P219', bowlerName: 'Tiger Bowler', bowlerKey: 'tiger bowler', bowlerPlayerId: 'T2' }));
  await c('clips').insertOne(clip('room1', { eventType: 'WICKET', battingTeam: 'B', strikerName: 'Tiger Tom', strikerKey: 'tiger tom', strikerPlayerId: 'T1', bowlerName: 'Rohit Sharmma', bowlerKey: 'rohit sharmma', bowlerPlayerId: 'P219', fielderName: 'Rohit Sharmma', fielderKey: 'rohit sharmma', fielderPlayerId: 'P219', dismissedPlayerName: 'Tiger Tom', dismissedPlayerKey: 'tiger tom', dismissedPlayerId: 'T1' }));
  await c('matchPanelStates').insertOne({ matchId: 'm1', updatedAt: 1, state: { tournamentMatchId: 'm1',
    teamA: { name: 'D Y Patil', players: [{ id: 'P219', name: 'Rohit Sharmma', isXI: true, hand: 'L' }, { id: 'V1', name: 'Virat Kohlii', isXI: true }], captainId: 'P219' }, teamB: { name: 'Tigers', players: [{ id: 'T1', name: 'Tiger Tom', isXI: true }] },
    battingCard: { A: [bat('Rohit Sharmma', 'P219', 67, 45)], B: [] }, bowlingCard: { A: [], B: [] }, inningsArchive: [],
    striker: { id: 'P219', name: 'Rohit Sharmma', runs: 67, balls: 45 }, ballLog: [{ strikerId: 'P219', strikerName: 'Rohit Sharmma', bowlerId: 'T2', bowlerName: 'Tiger Bowler', runs: 4 }],
    batHand: { P219: 'L', 'n:Rohit Sharmma': 'L' }, dismissedThisInnings: { A: ['P219'], B: [] }, fieldingStats: { A: { P219: { catches: 1 } }, B: {} } } });
  // M2 — Summer Cup: Mumbai Stars (A) with Rohit Sharma (P102) v Lions
  await c('matchRecords').insertOne(rec({ leagueKey: 'summer cup', matchId: 'm2', roomId: 'room2', matchNo: 2, savedAt: '2026-09-10T10:00:00Z', matchDate: '2026-09-10',
    teamA: { name: 'Mumbai Stars', teamId: 't_ms' }, teamB: { name: 'Lions' },
    squadA: sq([['P102', 'Rohit Sharma'], ['B1', 'Jasprit Bumrah']]), squadB: sq([['L1', 'Lion Leo']]),
    battingCard: { A: [bat('Rohit Sharma', 'P102', 102, 60, { fours: 10, sixes: 5 })], B: [bat('Lion Leo', 'L1', 40, 35, { inningsNo: 2, out: true, howOut: 'b Rohit Sharma', dismissalType: 'Bowled', bowlerName: 'Rohit Sharma' })] },
    bowlingCard: { A: [bowl('Rohit Sharma', 'P102', 4, 30, 2, { inningsNo: 2 })], B: [bowl('Lion Leo', 'L1', 4, 40, 0)] } }));
  await c('balls').insertOne(ball('room2', { striker: 'Rohit Sharma', strikerKey: 'rohit sharma', strikerPlayerId: 'P102', bowler: 'Lion Leo', bowlerKey: 'lion leo', bowlerPlayerId: 'L1', kind: '6', runs: 6 }));
  await c('clips').insertOne(clip('room2', { eventType: 'SIX', strikerName: 'Rohit Sharma', strikerKey: 'rohit sharma', strikerPlayerId: 'P102', bowlerName: 'Lion Leo', bowlerKey: 'lion leo', bowlerPlayerId: 'L1' }));
  // M3 — Winter League: Mumbai Stars with R. Sharma (P347)
  await c('matchRecords').insertOne(rec({ leagueKey: 'winter league', matchId: 'm3', roomId: 'room3', matchNo: 1, savedAt: '2026-10-01T10:00:00Z', matchDate: '2026-10-01',
    teamA: { name: 'Mumbai Stars', teamId: 't_ms' }, teamB: { name: 'Lions' },
    squadA: sq([['P347', 'R. Sharma'], ['B1', 'Jasprit Bumrah']]), squadB: sq([['L1', 'Lion Leo']]),
    battingCard: { A: [bat('R. Sharma', 'P347', 12, 9, { out: true, howOut: 'b Lion Leo', dismissalType: 'Bowled', bowlerName: 'Lion Leo' })], B: [] },
    bowlingCard: { A: [], B: [bowl('Lion Leo', 'L1', 4, 33, 1)] } }));
  await c('clips').insertOne(clip('room3', { eventType: 'WICKET', strikerName: 'R. Sharma', strikerKey: 'r. sharma', strikerPlayerId: 'P347', dismissedPlayerName: 'R. Sharma', dismissedPlayerKey: 'r. sharma', dismissedPlayerId: 'P347', bowlerName: 'Lion Leo', bowlerKey: 'lion leo', bowlerPlayerId: 'L1' }));
  // M4 — an older match saved with names only (no Player IDs): Rohit Sharmma for D Y Patil
  await c('matchRecords').insertOne(rec({ leagueKey: 'summer cup', matchId: 'm4', roomId: 'room4', matchNo: 3, savedAt: '2026-08-01T10:00:00Z', matchDate: '2026-08-01',
    teamA: { name: 'D Y Patil' }, teamB: { name: 'Lions' },
    battingCard: { A: [{ name: 'Rohit Sharmma', runs: 8, balls: 6, out: true, howOut: 'b Lion Leo', bowlerName: 'Lion Leo', inningsNo: 1 }], B: [] }, bowlingCard: { A: [], B: [] } }));
  // M5 — Amit Patil v Amit Patel (opposite teams); M6 — Karan Shah and Karan Sha batting in one innings
  await c('matchRecords').insertOne(rec({ leagueKey: 'winter league', matchId: 'm5', roomId: 'room5', matchNo: 2, savedAt: '2026-10-02T10:00:00Z',
    teamA: { name: 'Patil XI' }, teamB: { name: 'Patel XI' }, squadA: sq([['A1', 'Amit Patil']]), squadB: sq([['A2', 'Amit Patel']]),
    battingCard: { A: [bat('Amit Patil', 'A1', 10, 10)], B: [bat('Amit Patel', 'A2', 11, 10, { inningsNo: 2 })] }, bowlingCard: { A: [], B: [] } }));
  await c('matchRecords').insertOne(rec({ leagueKey: 'winter league', matchId: 'm6', roomId: 'room6', matchNo: 3, savedAt: '2026-10-03T10:00:00Z',
    teamA: { name: 'Shah XI' }, teamB: { name: 'Others' }, squadA: sq([['K1', 'Karan Shah'], ['K2', 'Karan Sha']]),
    battingCard: { A: [bat('Karan Shah', 'K1', 10, 10), bat('Karan Sha', 'K2', 5, 4)], B: [] }, bowlingCard: { A: [], B: [] } }));
  // M7 — a live match (listed live, no result): Live Player / Live Playerr
  await c('matchRecords').insertOne(rec({ leagueKey: 'winter league', matchId: 'm-live', roomId: 'room-live', matchNo: 4, savedAt: '2026-10-30T10:00:00Z', winningTeam: null,
    teamA: { name: 'Live XI' }, teamB: { name: 'Others' }, squadA: sq([['X1', 'Live Player'], ['X2', 'Live Playerr', false]]), battingCard: { A: [bat('Live Player', 'X1', 3, 2)], B: [] }, bowlingCard: { A: [], B: [] } }));
  // M8 — imported from scorecard photos, with its commentary text
  await c('matchRecords').insertOne(rec({ leagueKey: 'summer cup', matchId: 'm8', roomId: 'room8', matchNo: 4, savedAt: '2026-09-20T10:00:00Z', importSource: { kind: 'photos' },
    teamA: { name: 'D Y Patil' }, teamB: { name: 'Lions' }, squadA: sq([['P219', 'Rohit Sharmma']]),
    battingCard: { A: [bat('Rohit Sharmma', 'P219', 5, 7, { out: true, howOut: 'lbw b Lion Leo', bowlerName: 'Lion Leo' })], B: [] }, bowlingCard: { A: [], B: [] } }));
  await c('importedCommentary').insertOne({ _id: `${OWNER}|summer cup|m8`, ownerUid: OWNER, leagueKey: 'summer cup', matchId: 'm8', source: 'scorecard-photos',
    innings: [{ innings: 1, battingTeam: 'A', entries: [{ over: 0, ball: 1, batter: 'Rohit Sharmma', bowler: 'Lion Leo', text: 'Rohit Sharmma drives Lion Leo through the covers for four' }] }] });
}


module.exports = { OWNER, TOK, idTokens, pk, seed, bat };
