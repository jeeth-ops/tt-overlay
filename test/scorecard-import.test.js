// 📷 Import Scorecard from Photos — the engine (scorecard-import.js) on an
// in-memory MongoDB with the production unique indexes, with the REAL
// server.js player / team functions (resolvePlayerId, resolvePlayerIdExplicit,
// saveTeamRecord — extracted by name, never copied) and the real points
// table / leaderboard code. The photo reader is a stand-in returning what
// Claude would read (test/scorecard-import-fixtures.js).
//
// MCA names and players
//   1  "Jeeth Kumar Suvarna" is saved as "Jeeth Suvarna"; the printed name is kept
//   2  the Jeeth Suvarna who already plays for the team keeps his player ID
//   3  his runs join his existing leaderboard row (one player, one row)
//   4  same first + last name, another team only → asked, never merged
//   5  two players of one team with that name → asked
//   6  a different middle name → asked
//   7  a similar name ("J Suvarna") → asked
//   8  a new player cannot take someone else's name
//   9  two players of one team who would both shorten to one name keep full names
//  10  one ID for both teams, or for two rows of one table → refused
// Teams
//  11  the printed team is proposed, and must be confirmed
//  12  no match → choose; similar names offered
//  13  a new team: name clash refused; made with a team ID on saving; in the
//      tournament's team list with its logo; removed again on a failed save
//  14  logos: replacing one needs its own confirmation; a missing one is filled
// Match details, checks, result
//  15  format / date / venue asked for and confirmed, never guessed
//  16  a discrepancy blocks saving until fixed or confirmed as printed (reason on record)
//  17  the result: from the scores, or chosen with a reason
// Saving
//  18  one match; points table and leaderboards count it once; nothing else changes;
//      no deliveries or clips invented; unknown values stay unknown
//  19  saving twice (or twice at once) makes one match
//  20  a failure part-way keeps nothing, and the next try works
//  21  a restart mid-save / mid-read is cleaned up
//  22  the same match imported twice; a tournament merge running
// Photos, reading, commentary
//  23  photos: types, size, duplicates, order, limits
//  24  reading: names normalised, unclear values flagged, reader failure / switched off
//  25  commentary: overlap read once, in order, display only, partial flagged
//
// Run:  node test/scorecard-import.test.js
const crypto = require('crypto');
const { MemoryDb } = require('./mongo-memory.js');
const H = require('./cricket/server-harness.js');
const F = require('./merge-fixtures.js');
const X = require('./scorecard-import-fixtures.js');
const SI = require('../scorecard-import.js');
const { S } = F;

const fails = [];
let passes = 0;
const check = (ok, msg) => { if (ok) passes++; else fails.push(msg); console.log(`  ${ok ? '✓' : '✗'} ${msg}`); };
const section = (t) => console.log('\n' + t);
const W = X.W, L = X.LEAGUE;
const V = { email: X.OWNER.email, uid: X.OWNER.uid };

// the real server.js functions, bound to this world's collections
function serverFns(c) {
    const fns = [['personName'], ['playerKey'], ['canonicalPlayerId', 'async function '], ['resolvePlayerId', 'async function '], ['resolvePlayerIdExplicit', 'async function '],
        ['forgetPlayerIdCache'], ['teamNameKey'], ['sanitizeTeamColor'], ['sanitizeTeamLogo'], ['publicTeam'], ['saveTeamRecord', 'async function '],
        ['normalizeBatHand'], ['batHandsFor', 'async function '], ['setPlayerBatHand', 'async function '], ['publicTeamWithHands', 'async function ']];
    const src = fns.map(([n, p]) => H.grab(n, p)).join('\n') + '\n' + H.grabConst('TEAM_LOGO_MAX_CHARS');
    return new Function('playersCollection', 'teamsCollection', 'playerIdCache', 'crypto', 'playerTombstonesCollection',
        src + '\nreturn { resolvePlayerId, resolvePlayerIdExplicit, saveTeamRecord, forgetPlayerIdCache };')(c.players, c.teams, new Map(), crypto, null);
}

async function world(opts) {
    opts = opts || {};
    const mem = new MemoryDb();
    const c = F.collections(mem);
    c.teams = mem.collection('teams');
    c.imports = mem.collection('scorecardImports');
    c.photos = mem.collection('scorecardImportPhotos');
    c.commentary = mem.collection('importedCommentary');
    await F.indexes(c);
    await c.teams.createIndex({ ownerUid: 1, nameKey: 1 }, { unique: true });
    await c.teams.createIndex({ teamId: 1 }, { unique: true });
    await X.seed(c, { extra: opts.extra });
    const w = { mem, c, invalidated: [], calls: [], reader: true, locked: false, now: Date.parse('2026-10-14T10:00:00Z'), read: X.scorecard(), commentary: X.commentary() };
    w.SV = serverFns(c);
    return w;
}
function engine(w, extra) {
    return SI.createScorecardImport(Object.assign({
        db: { leagues: w.c.leagues, records: w.c.records, players: w.c.players, teams: w.c.teams, imports: w.c.imports, photos: w.c.photos, commentary: w.c.commentary },
        playerKey: S.playerKey, computePointsTable: S.computePointsTable, computeLeaderboards: S.computeLeaderboards, playedMatches: S.playedMatches,
        resolvePlayerId: w.SV.resolvePlayerId, resolvePlayerIdExplicit: w.SV.resolvePlayerIdExplicit, saveTeamRecord: w.SV.saveTeamRecord, forgetPlayerIdCache: w.SV.forgetPlayerIdCache,
        writeMatchRecord: (filter, rec) => w.c.records.updateOne(filter, { $set: rec }, { upsert: true }),
        ensureLeaguePublicToken: async (o, l) => { const d = await w.c.leagues.findOne({ ownerUid: o, leagueKey: l }); return d && d.publicToken; },
        invalidateTournamentCaches: (t) => w.invalidated.push(t),
        logAuditAction: async (...a) => { await w.c.audits.insertOne({ performedBy: a[0], action: a[1], target: a[2], extra: a[5] || null }); },
        mergeLocked: () => w.locked,
        singleMatchesLeagueKey: '__single_matches__',
        extractor: {
            available: () => w.reader,
            scorecard: async (photos, hints) => { w.calls.push({ kind: 'scorecard', photos: photos.length, hints }); if (w.readError) throw w.readError; return { data: JSON.parse(JSON.stringify(w.read)), usage: { input_tokens: 9000, output_tokens: 1500 }, model: 'claude-opus-5-5' }; },
            commentary: async (photos, hints) => { w.calls.push({ kind: 'commentary', photos: photos.length, hints }); return { data: JSON.parse(JSON.stringify(w.commentary)) }; }
        },
        awaitReads: true,
        now: () => w.now,
        log: () => {}
    }, extra || {}));
}
const refOf = async (E, name) => (await E.tournamentContext(V, W, L)).teams.find(t => t.name === name).ref;
// a draft read from three photos, details confirmed, both teams confirmed
async function readyDraft(E, w, opts) {
    opts = opts || {};
    let d = await E.createDraft(V, { ownerUid: W, leagueKey: L });
    const id = d.draftId;
    await E.addPhoto(V, id, { kind: 'scorecard', innings: 1, name: 'bat.png' }, X.png(1));
    await E.addPhoto(V, id, { kind: 'scorecard', innings: 1, name: 'bowl.png' }, X.png(2));
    await E.addPhoto(V, id, { kind: 'scorecard', innings: 2, name: 'inn2.png' }, X.png(3));
    if (opts.commentary) await E.addPhoto(V, id, { kind: 'commentary', innings: 1, name: 'cm.png' }, X.png(4));
    await E.startRead(V, id, { kind: 'scorecard' });
    if (opts.commentary) await E.startRead(V, id, { kind: 'commentary', innings: 1 });
    await E.updateDraft(V, id, { meta: Object.assign({ format: 'Custom', overs: 10, date: '2026-10-12', venue: 'DY Patil Ground', confirmed: true }, opts.meta || {}) });
    if (opts.teams !== false) {
        await E.updateDraft(V, id, { teams: { A: { choice: { mode: 'existing', ref: await refOf(E, 'DY PATIL SA') }, confirmed: true }, B: { choice: { mode: 'existing', ref: await refOf(E, 'PAREL SPORTING CLUB') }, confirmed: true } } });
    }
    return id;
}
const decide = (E, id, players, extra) => E.updateDraft(V, id, { decisions: Object.assign({ players: players || {}, acknowledged: {}, result: null }, extra || {}) });
const player = (a, name) => a.players.find(p => p.name === name || p.sourceName === name || (p.final && p.final.name === name));
const blocking = (a) => a.issues.filter(i => i.level === 'error' && !(i.ack && i.acknowledged));
async function snapshot(c) {
    const out = {};
    for (const k of ['leagues', 'records', 'players', 'teams', 'balls', 'clips', 'commentary']) out[k] = (await c[k].find({}).toArray()).map(d => JSON.stringify(d)).sort();
    return JSON.stringify(out);
}

(async () => {
    // ------------------------------------------------------------------
    section('1–3  Jeeth Kumar Suvarna → Jeeth Suvarna, his ID, his leaderboard row');
    let w = await world();
    let E = engine(w);
    let id = await readyDraft(E, w);
    let d = await E.getDraft(V, id);
    const r0 = d.innings[0].batting[0];
    check(r0.name === 'Jeeth Suvarna' && r0.sourceName === 'Jeeth Kumar Suvarna', '1  read as "Jeeth Suvarna", printed "Jeeth Kumar Suvarna" kept');
    check(d.innings[0].batting[1].name === 'Harsh Rane' && d.innings[0].batting[1].sourceName === 'Harsh Rajesh Rane', '1  "Harsh Rajesh Rane" → "Harsh Rane"');
    let a = await E.analyze(V, id);
    let jeeth = a.players.find(p => p.key === 'A|jeeth kumar suvarna');
    check(jeeth && jeeth.final && jeeth.final.mode === 'existing' && jeeth.final.id === 'PLAYER_A' && jeeth.status === 'auto', '2  matched to PLAYER_A on its own: same name, already plays for DY PATIL SA');
    const jeethBowl = a.players.find(p => p.key === 'A|jeeth suvarna');
    check(jeethBowl && jeethBowl.final && jeethBowl.final.id === 'PLAYER_A', '2  his bowling row (printed "Jeeth Suvarna") is the same player');
    const harsh = a.players.find(p => p.key === 'A|harsh rajesh rane');
    check(harsh.final.id === 'p-harsh' && harsh.final.name === 'HARSH RANE', '2  Harsh keeps p-harsh and the name the site knows him by');
    const suraj = a.players.find(p => p.key === 'A|suraj patil');
    check(suraj && !suraj.final && suraj.status === 'review', '4  "Suraj Patil" (a SURAJ PATIL plays for THANE CC only) is asked, not merged');
    check(suraj.candidates.length === 1 && suraj.candidates[0].id === 'p-surajp' && !suraj.candidates[0].sameTeam && suraj.candidates[0].teams[0] === 'THANE CC', '4  …showing his ID and his team, named as written');
    check(blocking(a).some(i => i.id === 'player-A|suraj patil'), '4  and nothing can be saved until it is decided');
    const aarav = a.players.find(p => p.key === 'A|aarav desai');
    check(aarav.final && aarav.final.mode === 'new' && aarav.status === 'auto', 'a name nobody has (Aarav Desai) is a new player');
    // Suraj is the THANE CC player who now plays here: the same person
    await decide(E, id, { 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } });
    a = await E.analyze(V, id);
    check(a.canSave, 'decided: ready to save');
    const lbBefore = S.computeLeaderboards(await w.c.records.find({ ownerUid: W, leagueKey: L }).toArray());
    const ptBefore = S.computePointsTable(await w.c.records.find({ ownerUid: W, leagueKey: L }).toArray());
    const snapOther = JSON.stringify((await w.c.records.find({}).toArray()).map(r => [r.matchId, r.scoreA, r.scoreB, r.battingCard, r.winningTeam]));
    const ballsBefore = await w.c.balls.countDocuments({}), clipsBefore = await w.c.clips.countDocuments({});
    let res = await E.commit(V, id, { idempotencyKey: 'k1', confirm: true });
    check(!res.duplicate && res.verification.passed && res.verification.checks.length === 6, '18  saved, and all six checks passed');
    const recs = await w.c.records.find({ ownerUid: W, leagueKey: L }).toArray();
    const rec = recs.find(r => r.importSource);
    const bA = rec.battingCard.A, wB = rec.bowlingCard.B, wA = rec.bowlingCard.A;
    check(bA[0].name === 'Jeeth Suvarna' && bA[0].id === 'PLAYER_A' && bA[0].sourceName === 'Jeeth Kumar Suvarna', '1–2  saved as Jeeth Suvarna, PLAYER_A, printed name on record');
    check(wA.find(r => r.name === 'Jeeth Suvarna').id === 'PLAYER_A', '2  his bowling figures under the same ID');
    check(bA[2].id === 'p-surajp' && bA[2].name === 'SURAJ PATIL', '4  Suraj under the ID that was chosen');
    const newAarav = rec.squadA.players.find(p => p.name === 'Aarav Desai');
    check(newAarav && newAarav.id && !['PLAYER_A', 'p-surajp'].includes(newAarav.id) && !!(await w.c.players.findOne({ playerId: newAarav.id })), 'a new player gets his own profile and ID');
    const lbAfter = S.computeLeaderboards(recs);
    const runsOf = (lb, n) => lb.topRuns.filter(r => r.name.toLowerCase() === n.toLowerCase());
    check(runsOf(lbAfter, 'Jeeth Suvarna').length === 1 && runsOf(lbAfter, 'Jeeth Suvarna')[0].runs === (runsOf(lbBefore, 'Jeeth Suvarna')[0] || { runs: 0 }).runs + 40, '3  one Jeeth Suvarna on the leaderboard, +40 runs');
    check(!lbAfter.topRuns.some(r => /kumar/i.test(r.name)), '3  no "Jeeth Kumar Suvarna" row');
    const wk = (lb, n) => (lb.topWickets.find(r => r.name.toLowerCase() === n.toLowerCase()) || { wickets: 0 }).wickets;
    check(wk(lbAfter, 'GARV JAIN') === wk(lbBefore, 'GARV JAIN') + 1 && wk(lbAfter, 'ALIM SHAIKH') === wk(lbBefore, 'ALIM SHAIKH') + 1, '18  wickets counted once (Garv +1, Alim +1)');
    const ptAfter = S.computePointsTable(recs);
    const pt = (t, n) => t.find(r => r.team === n);
    check(pt(ptAfter, 'DY PATIL SA').played === pt(ptBefore, 'DY PATIL SA').played + 1 && pt(ptAfter, 'DY PATIL SA').points === pt(ptBefore, 'DY PATIL SA').points + 2 && pt(ptAfter, 'PAREL SPORTING CLUB').points === pt(ptBefore, 'PAREL SPORTING CLUB').points && pt(ptAfter, 'PAREL SPORTING CLUB').lost === pt(ptBefore, 'PAREL SPORTING CLUB').lost + 1, '18  points table: +1 played each, +2 to DY PATIL SA, a loss for PAREL');
    check(rec.winningTeam === 'A' && rec.resultText === 'DYP WON BY 25 RUNS' && rec.scoreA.runs === 110 && rec.scoreB.overs === '10.0', '18  result and scores');
    check(rec.savedAt === '2026-10-12T12:00:00.000Z' && rec.matchDate === '2026-10-12' && rec.venue === 'DY Patil Ground' && rec.format === 'Custom' && rec.customOvers === 10, '15  date, venue and format as confirmed (the page orders matches by the day played)');
    check(rec.importSource && rec.importSource.kind === 'scorecard' && rec.importSource.reader === 'claude' && rec.importSource.ballByBall === false && rec.importSource.clips === false && rec.importSource.photos.length === 3 && rec.importSource.importedBy === 'chhayajeeth@gmail.com', '18  marked as imported (reader, photos, who), with no ball-by-ball and no clips');
    check(await w.c.balls.countDocuments({}) === ballsBefore && await w.c.clips.countDocuments({}) === clipsBefore, '18  no deliveries and no clips were invented');
    check(bA[1].balls === 26 && wB[1].maidens === null && rec.extras.A.wd === 4, '18  printed values saved as printed; an unknown one (maidens) stays null, not 0');
    check(bA[0].howOut === 'c ROHIT SHUKLA b GARV JAIN' && bA[0].dismissalType === 'Caught' && bA[0].fielderName === 'ROHIT SHUKLA' && bA[0].bowlerName === 'GARV JAIN', 'dismissal written with the players\' saved names');
    check(rec.battingCard.B[1].howOut === 'run out (HARSH RANE)' && rec.battingCard.B[1].bowlerName === null, 'a run out is not credited to the bowler');
    check(rec.squadA.captainId === 'PLAYER_A' && rec.squadA.players.length === 7 && rec.squadB.players.length === 5, 'squads: everyone on the scorecard, the captain marked');
    check(rec.fallOfWickets.A[0].batter === 'Jeeth Suvarna' && rec.fallOfWickets.A[0].over === '5.4', 'fall of wickets with the saved name');
    check(JSON.stringify((await w.c.records.find({ matchId: { $ne: rec.matchId } }).toArray()).map(r => [r.matchId, r.scoreA, r.scoreB, r.battingCard, r.winningTeam])) === snapOther, '18  every other match exactly as it was');
    check((await w.c.audits.find({ action: 'Scorecard import' }).toArray()).length === 1 && w.invalidated.includes('tokM'), 'audit record written; the tournament page cache refreshed');
    d = await E.getDraft(V, id);
    check(d.status === 'completed' && d.result.matchUrl === `/cricket-scorecard?token=tokM&match=${rec.matchId}&history=1`, 'the import remembers the match it made (and its scorecard link)');

    section('19  saving twice makes one match');
    res = await E.commit(V, id, { idempotencyKey: 'k1', confirm: true });
    check(res.duplicate === true && res.matchId === rec.matchId, 'the same save again: told it is done, same match');
    res = await E.commit(V, id, { idempotencyKey: 'another-key', confirm: true });
    check(res.duplicate === true && await w.c.records.countDocuments({ 'importSource.importId': id }) === 1, 'even with another key: still one match');
    let threw = null;
    try { await E.updateDraft(V, id, { meta: { format: 'T20' } }); } catch (e) { threw = e; }
    check(threw && threw.status === 409, 'a saved import can no longer be edited');
    // two saves at the same instant
    w = await world(); E = engine(w);
    id = await readyDraft(E, w);
    await decide(E, id, { 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } });
    const both = await Promise.allSettled([E.commit(V, id, { idempotencyKey: 'a', confirm: true }), E.commit(V, id, { idempotencyKey: 'b', confirm: true })]);
    check(await w.c.records.countDocuments({ 'importSource.importId': id }) === 1, '19  two saves at once: one match');
    check(both.filter(x => x.status === 'fulfilled').length >= 1 && both.every(x => x.status === 'fulfilled' || (x.reason && x.reason.code === 'IN_PROGRESS')), '19  the other is told it is already being saved');
    threw = null;
    try { await E.commit(V, (await readyDraft(E, w)), { idempotencyKey: 'x' }); } catch (e) { threw = e; }
    check(threw && (threw.code === 'NOT_CONFIRMED' || threw.code === 'NOT_READY'), 'saving needs confirm: true');

    // ------------------------------------------------------------------
    section('5–10  people with the same or similar names');
    w = await world({ extra: async (c) => {
        // two different Rahul Sharmas have played for DY PATIL SA, and a
        // "Rahul Kumar Sharma" (middle name on record) for PAREL
        await F.addProfile(c, W, 'p-rs1', 'Rahul Sharma');
        await F.addProfile(c, W, 'p-rs2', 'Rahul Sharma Jr');
        await F.addMatch(c, { ownerUid: W, leagueKey: L, matchId: 'm2', roomId: 'r2', teamA: { name: 'DY PATIL SA', short: 'DYP', players: [F.P('Rahul Sharma', 'p-rs1'), F.P('Jeeth Suvarna', 'PLAYER_A'), F.P('HARSH RANE', 'p-harsh')], bowlers: [F.P('HARSH RANE', 'p-harsh')] }, teamB: X.PSC(), seed: 1, date: '2026-10-05', overs: 2 });
        await F.addMatch(c, { ownerUid: W, leagueKey: L, matchId: 'm3', roomId: 'r3', teamA: { name: 'DY PATIL SA', short: 'DYP', players: [F.P('Rahul Sharma', 'p-rs2'), F.P('ALIM SHAIKH', 'p-alim'), F.P('SURAJ SHINDE', 'p-suraj')], bowlers: [F.P('SURAJ SHINDE', 'p-suraj')] }, teamB: X.PSC(), seed: 2, date: '2026-10-06', overs: 2 });
        await F.addProfile(c, W, 'p-vikas', 'Vikas Kumar Patil');
        await F.addMatch(c, { ownerUid: W, leagueKey: L, matchId: 'm4', roomId: 'r4', teamA: { name: 'DY PATIL SA', short: 'DYP', players: [F.P('Vikas Kumar Patil', 'p-vikas'), F.P('ATHARVA KALE', 'p-ath'), F.P('ALIM SHAIKH', 'p-alim')], bowlers: [F.P('ALIM SHAIKH', 'p-alim')] }, teamB: X.PSC(), seed: 4, date: '2026-10-07', overs: 2 });
    } });
    E = engine(w);
    w.read.innings[0].batting.push(
        { name: 'Rahul Sharma', dismissal: 'not out', runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: null, isCaptain: false, isWicketKeeper: false, photo: 1, confidence: 'high', unclear: [] },
        { name: 'Vikas Dev Patil', dismissal: 'not out', runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: null, isCaptain: false, isWicketKeeper: false, photo: 1, confidence: 'high', unclear: [] },
        { name: 'J Suvarna', dismissal: 'not out', runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: null, isCaptain: false, isWicketKeeper: false, photo: 1, confidence: 'high', unclear: [] }
    );
    id = await readyDraft(E, w);
    a = await E.analyze(V, id);
    const rahul = a.players.find(p => p.key === 'A|rahul sharma');
    check(rahul && !rahul.final && rahul.status === 'review' && rahul.candidates.filter(c => c.sameTeam).length >= 2, '5  two Rahul Sharmas have played for this team: asked which one');
    const vikas = a.players.find(p => p.key === 'A|vikas dev patil');
    check(vikas && !vikas.final && vikas.status === 'review' && vikas.candidates.some(c => c.middleNameDiffers === 'Vikas Kumar Patil'), '6  "Vikas Dev Patil" vs "Vikas Kumar Patil" (same short name): asked, the other middle name shown');
    const js = a.players.find(p => p.key === 'A|j suvarna');
    check(js && !js.final && js.status === 'review' && js.similar.some(s => s.id === 'PLAYER_A'), '7  "J Suvarna" looks like Jeeth Suvarna: asked, never matched on its own');
    // 8: J Suvarna is someone else → a new player, but not under a taken name
    await decide(E, id, { 'A|j suvarna': { mode: 'new', name: 'Jeeth Suvarna' }, 'A|rahul sharma': { mode: 'existing', id: 'p-rs2' }, 'A|vikas dev patil': { mode: 'new' }, 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } });
    a = await E.analyze(V, id);
    const clash = a.issues.find(i => i.id === 'player-name-A|j suvarna');
    check(clash && clash.level === 'error' && /already another player's name/.test(clash.message), '8  a new player named "Jeeth Suvarna" is refused — his runs would join the other Jeeth\'s');
    const vk = a.issues.find(i => i.id === 'player-name-A|vikas dev patil');
    check(!vk && a.players.find(p => p.key === 'A|vikas dev patil').final.name === 'Vikas Dev Patil', '6  a new "Vikas Patil" keeps his full name: the short one belongs to someone else');
    await decide(E, id, { 'A|j suvarna': { mode: 'new', name: 'Jai Suvarna' }, 'A|rahul sharma': { mode: 'existing', id: 'p-rs2' }, 'A|vikas dev patil': { mode: 'new', name: 'Vikas Dev Patil' }, 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } });
    a = await E.analyze(V, id);
    check(!a.issues.some(i => i.table === 'players' && i.level === 'error'), '8  with a name of his own, accepted');
    check(a.players.find(p => p.key === 'A|rahul sharma').final.id === 'p-rs2', '5  the Rahul Sharma that was chosen');
    // 10: one id for two people
    await decide(E, id, { 'A|j suvarna': { mode: 'existing', id: 'PLAYER_A' }, 'A|rahul sharma': { mode: 'existing', id: 'p-rohit' }, 'A|vikas dev patil': { mode: 'new', name: 'Vikas Dev Patil' }, 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } });
    a = await E.analyze(V, id);
    check(a.issues.some(i => i.id === 'player-twice-PLAYER_A-bat0'), '10  two batters of one innings on one ID (Jeeth + J Suvarna): refused');
    check(a.issues.some(i => i.id === 'player-both-p-rohit'), '10  one ID on both teams (Rohit Shukla of PAREL for a DYP batter): refused');
    // 9: two players of one team who would both be "Amit Joshi"
    w = await world(); E = engine(w);
    w.read.innings[0].batting.push(
        { name: 'Amit Kumar Joshi', dismissal: 'not out', runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: null, isCaptain: false, isWicketKeeper: false, photo: 1, confidence: 'high', unclear: [] },
        { name: 'Amit Ravi Joshi', dismissal: 'not out', runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: null, isCaptain: false, isWicketKeeper: false, photo: 1, confidence: 'high', unclear: [] });
    id = await readyDraft(E, w);
    a = await E.analyze(V, id);
    const amits = a.players.filter(p => /amit/i.test(p.name));
    check(amits.length === 2 && amits.every(p => /Kumar|Ravi/.test(p.normalized)), '9  "Amit Kumar Joshi" and "Amit Ravi Joshi" keep their full names (both would be "Amit Joshi")');

    // ------------------------------------------------------------------
    section('11–14  teams and logos');
    w = await world(); E = engine(w);
    id = await readyDraft(E, w, { teams: false });
    d = await E.getDraft(V, id);
    check(d.teams.A.printed === 'DY Patil SA' && d.teams.B.printed === 'Parel Sporting Club', 'the photos\' team names are kept');
    a = await E.analyze(V, id);
    check(a.teams.plan.A.status === 'proposed' && a.teams.plan.A.team.name === 'DY PATIL SA' && a.teams.plan.B.team.name === 'PAREL SPORTING CLUB', '11  "DY Patil SA" proposes the tournament\'s DY PATIL SA');
    check(a.issues.some(i => i.id === 'team-A-confirm') && a.issues.some(i => i.id === 'team-B-confirm') && !a.canSave, '11  …and still has to be confirmed');
    check(a.teams.options.every(o => o.logoUrl === null) && a.teams.options.find(o => o.name === 'DY PATIL SA').hasLogo, 'the check sends no logo images (the page loads them once)');
    w.read.innings[0].battingTeam = 'DY Patil Sports Academy';
    await E.startRead(V, id, { kind: 'scorecard' });
    a = await E.analyze(V, id);
    check(!a.teams.plan.A.team && a.teams.plan.A.status === 'needs-choice' && a.teams.plan.A.similar.some(s => s.name === 'DY PATIL SA'), '12  "DY Patil Sports Academy": no exact team — asked, DY PATIL SA offered');
    await E.updateDraft(V, id, { teams: { A: { choice: { mode: 'new', name: 'Dy Patil Sa', short: 'DPS' } }, B: { choice: { mode: 'existing', ref: await refOf(E, 'PAREL SPORTING CLUB') }, confirmed: true } } });
    a = await E.analyze(V, id);
    check(a.teams.plan.A.status === 'error' && /already exists/.test(a.teams.plan.A.message), '13  a new team called "Dy Patil Sa" is refused: DY PATIL SA exists');
    await E.updateDraft(V, id, { teams: { A: { choice: { mode: 'existing', ref: await refOf(E, 'PAREL SPORTING CLUB') }, confirmed: true }, B: { choice: { mode: 'existing', ref: await refOf(E, 'PAREL SPORTING CLUB') }, confirmed: true } } });
    a = await E.analyze(V, id);
    check(a.issues.some(i => i.id === 'teams-same'), '15  both sides the same team: refused');
    // 13: a brand-new team, with a logo, saved
    const NEWLOGO = 'data:image/png;base64,' + X.png(9).toString('base64');
    await E.updateDraft(V, id, { teams: { A: { choice: { mode: 'new', name: 'Navi Mumbai Lions', short: 'NML', color: '#0f766e', saveTeam: true, logo: { mode: 'upload', dataUrl: NEWLOGO } } }, B: { choice: { mode: 'existing', ref: await refOf(E, 'PAREL SPORTING CLUB') }, confirmed: true } } });
    a = await E.analyze(V, id);
    check(a.teams.plan.A.status === 'ok' && a.teams.plan.A.team.existing === false && a.teams.plan.A.logo.mode === 'upload' && a.issues.some(i => i.id === 'team-A-confirm'), '13  a new team with its logo, waiting for confirmation');
    await E.updateDraft(V, id, { teams: { A: { choice: { mode: 'new', name: 'Navi Mumbai Lions', short: 'NML', color: '#0f766e', saveTeam: true, logo: { mode: 'upload', dataUrl: NEWLOGO } }, confirmed: true }, B: { choice: { mode: 'existing', ref: await refOf(E, 'PAREL SPORTING CLUB') }, confirmed: true } } });
    a = await E.analyze(V, id);
    // DY PATIL SA's players are now "new team" players: nothing is assumed
    check(a.players.find(p => p.key === 'A|jeeth kumar suvarna').status === 'review', '2/4  for a new team, even Jeeth Suvarna is asked (he played for DY PATIL SA, not this team)');
    const allExisting = {};
    a.players.filter(p => p.side === 'A' && !p.final).forEach(p => { allExisting[p.key] = p.candidates[0] ? { mode: 'existing', id: p.candidates[0].id } : { mode: 'new' }; });
    await decide(E, id, allExisting);
    a = await E.analyze(V, id);
    check(a.canSave, 'decided: ready');
    const infoBefore = JSON.stringify((await w.c.leagues.findOne({ leagueKey: L })).info.teams);
    // 20: the save fails part-way (the match record cannot be written)
    const Efail = engine(w, { writeMatchRecord: async () => { throw new Error('disk full'); } });
    threw = null;
    const playersBefore = await w.c.players.countDocuments({});
    try { await Efail.commit(V, id, { idempotencyKey: 'f1', confirm: true }); } catch (e) { threw = e; }
    d = await E.getDraft(V, id);
    check(threw && d.status === 'failed' && /disk full|Saving failed/.test(d.commit.error), '20  the save failed and says so');
    check(await w.c.records.countDocuments({ 'importSource.importId': id }) === 0 && await w.c.teams.countDocuments({}) === 0, '20  nothing kept: no match, the new team removed');
    check(JSON.stringify((await w.c.leagues.findOne({ leagueKey: L })).info.teams) === infoBefore && await w.c.players.countDocuments({}) === playersBefore, '20  the tournament\'s team list and the players as before');
    res = await E.commit(V, id, { idempotencyKey: 'f2', confirm: true });
    check(res.verification.passed && await w.c.records.countDocuments({ 'importSource.importId': id }) === 1, '20  the next try saves it');
    const nml = await w.c.teams.findOne({ name: 'Navi Mumbai Lions' });
    const savedRec = await w.c.records.findOne({ 'importSource.importId': id });
    check(nml && /^t_/.test(nml.teamId) && nml.logoUrl === NEWLOGO && savedRec.teamA.teamId === nml.teamId && savedRec.teamA.logoUrl === NEWLOGO, '13  the new team is saved with a team ID and its logo; the match uses both');
    const infoTeams = (await w.c.leagues.findOne({ leagueKey: L })).info.teams;
    check(infoTeams.length === 3 && infoTeams[2].name === 'Navi Mumbai Lions' && infoTeams[2].logoUrl === NEWLOGO && infoTeams[2].teamId === nml.teamId, '13  …and added to the tournament\'s team list');
    // 14: replacing an existing logo needs its own confirmation
    w = await world(); E = engine(w);
    id = await readyDraft(E, w);
    await E.updateDraft(V, id, { teams: { A: { choice: { mode: 'existing', ref: await refOf(E, 'DY PATIL SA'), logo: { mode: 'upload', dataUrl: NEWLOGO } }, confirmed: true }, B: { choice: { mode: 'existing', ref: await refOf(E, 'PAREL SPORTING CLUB'), logo: { mode: 'upload', dataUrl: NEWLOGO } }, confirmed: true } } });
    a = await E.analyze(V, id);
    check(a.teams.plan.A.status === 'error' && /replaces it/.test(a.teams.plan.A.message), '14  DY PATIL SA already has a logo: replacing it must be confirmed');
    check(a.teams.plan.B.status === 'ok' && a.teams.plan.B.logo.mode === 'upload', '14  PAREL has none: the new logo is simply added');
    await E.updateDraft(V, id, { teams: { A: { choice: { mode: 'existing', ref: await refOf(E, 'DY PATIL SA'), logo: { mode: 'keep' } }, confirmed: true }, B: { choice: { mode: 'existing', ref: await refOf(E, 'PAREL SPORTING CLUB'), logo: { mode: 'upload', dataUrl: NEWLOGO } }, confirmed: true } } });
    await decide(E, id, { 'A|suraj patil': { mode: 'new', name: 'Suraj A Patil' } });
    res = await E.commit(V, id, { idempotencyKey: 'l1', confirm: true });
    const it = (await w.c.leagues.findOne({ leagueKey: L })).info.teams;
    check(res.verification.passed && it[0].logoUrl === X.LOGO && it[1].logoUrl === NEWLOGO, '14  DY PATIL SA\'s logo kept, PAREL\'s filled in');
    check((await w.c.records.findOne({ 'importSource.importId': id })).battingCard.A[2].name === 'Suraj A Patil', '8  the new Suraj saved under his own name');

    // ------------------------------------------------------------------
    section('15–17  match details, checks, the result');
    w = await world(); E = engine(w);
    d = await E.createDraft(V, { ownerUid: W, leagueKey: L });
    check(d.meta.format === 'Custom' && d.meta.overs === 10 && d.meta.venue === 'DY Patil Ground' && d.meta.date === null && d.meta.confirmed === false, '15  a new import starts from the tournament\'s format and venue, unconfirmed, no date');
    id = await readyDraft(E, w, { meta: { confirmed: false } });
    await decide(E, id, { 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } });
    a = await E.analyze(V, id);
    check(a.issues.some(i => i.id === 'meta-confirm') && !a.canSave, '15  the details must be confirmed');
    await E.updateDraft(V, id, { meta: { format: 'Custom', overs: 10, date: '2026-12-25', venue: 'DY Patil Ground', confirmed: true } });
    a = await E.analyze(V, id);
    check(a.issues.some(i => i.id === 'meta-date-future'), '15  a date in the future is refused');
    await E.updateDraft(V, id, { meta: { format: 'Custom', overs: null, date: '2026-10-12', venue: '', confirmed: true } });
    a = await E.analyze(V, id);
    check(a.issues.some(i => i.id === 'meta-overs') && a.issues.some(i => i.id === 'meta-venue'), '15  custom overs and the venue are required');
    await E.updateDraft(V, id, { meta: { format: 'T20', date: '2026-10-12', venue: 'DY Patil Ground', confirmed: true } });
    d = await E.getDraft(V, id);
    a = await E.analyze(V, id);
    check(d.meta.overs === 20 && a.issues.some(i => i.id === 'result-undecided'), 'T20 means 20 overs (so 10 overs of the chase is not a finished match)');
    await E.updateDraft(V, id, { meta: { format: 'Custom', overs: 10, date: '2026-10-12', venue: 'DY Patil Ground', confirmed: true } });
    // 16: a discrepancy
    d.innings[0].batting[1].runs = 66;
    await E.updateDraft(V, id, { innings: d.innings });
    a = await E.analyze(V, id);
    const sumIssue = a.issues.find(i => i.id === 'inn0-runs-sum');
    check(sumIssue && sumIssue.level === 'error' && sumIssue.ack && !a.canSave, '16  batters + extras ≠ total: saving blocked');
    await decide(E, id, { 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } }, { acknowledged: { 'inn0-runs-sum': { reason: 'The MCA scorecard itself shows 116 for Harsh', message: sumIssue.message } } });
    a = await E.analyze(V, id);
    check(a.canSave && a.issues.find(i => i.id === 'inn0-runs-sum').acknowledged.reason === 'The MCA scorecard itself shows 116 for Harsh', '16  confirmed as printed, with a reason: allowed');
    d = await E.getDraft(V, id);
    d.innings[0].batting[1].runs = 70;
    await E.updateDraft(V, id, { innings: d.innings });
    a = await E.analyze(V, id);
    check(!a.canSave && !a.issues.find(i => i.id === 'inn0-runs-sum').acknowledged, '16  the figures changed again: that confirmation does not cover the new difference');
    d.innings[0].batting[1].runs = 66;
    await E.updateDraft(V, id, { innings: d.innings });
    a = await E.analyze(V, id);
    check(a.canSave, '16  back to the confirmed figures: allowed again');
    res = await E.commit(V, id, { idempotencyKey: 'ack', confirm: true });
    const ackRec = await w.c.records.findOne({ 'importSource.importId': id });
    check(ackRec.importSource.acknowledged.some(x => x.id === 'inn0-runs-sum' && /116/.test(x.reason) && x.by === 'chhayajeeth@gmail.com'), '16  the reason is kept on the match');
    check(ackRec.format === 'Custom' && ackRec.customOvers === 10, 'the format saved as confirmed');
    // 17: the result
    w = await world(); E = engine(w);
    w.read.innings[1].total = { runs: 60, wickets: 2, overs: '6.0', declared: false, allOut: false };
    w.read.innings[1].batting = [Object.assign({}, w.read.innings[1].batting[0], { runs: 30, balls: 18, fours: 3, sixes: 1 }), Object.assign({}, w.read.innings[1].batting[1], { runs: 25, balls: 18 })];
    w.read.innings[1].bowling = [Object.assign({}, w.read.innings[1].bowling[0], { overs: '3', runs: 30 }), Object.assign({}, w.read.innings[1].bowling[1], { overs: '3', runs: 26 })];
    id = await readyDraft(E, w);
    await decide(E, id, { 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } });
    a = await E.analyze(V, id);
    check(a.issues.some(i => i.id === 'result-undecided') && !a.canSave && a.result.winningTeam === null, '17  a chase stopped after 6 overs: the result is not guessed');
    await decide(E, id, { 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } }, { result: { winner: 'B', byWickets: 8 } });
    a = await E.analyze(V, id);
    check(a.issues.some(i => i.id === 'result-reason'), '17  a chosen result needs a reason');
    await decide(E, id, { 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } }, { result: { winner: 'B', byWickets: 8, reason: 'Won on DLS — rain after 6 overs' } });
    a = await E.analyze(V, id);
    check(a.canSave && a.result.winningTeam === 'B' && a.result.text === 'PSC WON BY 8 WICKETS', '17  PSC won by 8 wickets (DLS), with the reason');
    res = await E.commit(V, id, { idempotencyKey: 'dls', confirm: true });
    const dls = await w.c.records.findOne({ 'importSource.importId': id });
    check(dls.winningTeam === 'B' && S.computePointsTable([dls]).find(r => r.team === 'PAREL SPORTING CLUB').points === 2, '17  the points go to the chosen winner');

    // ------------------------------------------------------------------
    section('21  a restart in the middle');
    w = await world(); E = engine(w);
    id = await readyDraft(E, w);
    await decide(E, id, { 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } });
    const before21 = await snapshot(w.c);
    // a save that got as far as the match record, then the server stopped
    await w.c.imports.updateOne({ _id: id }, { $set: { status: 'saving', commit: { key: 'r', created: { matchId: 'imp-' + id.replace(/^sci_/, '') } } } });
    const recCopy = Object.assign({}, await w.c.records.findOne({ matchId: 'm1' }), { _id: undefined, matchId: 'imp-' + id.replace(/^sci_/, ''), importSource: { importId: id } });
    delete recCopy._id;
    await w.c.records.insertOne(recCopy);
    await w.c.imports.updateOne({ _id: id }, { $set: { 'read.scorecard.state': 'running' } });
    const fixed = await engine(w).recoverInterrupted();
    d = await E.getDraft(V, id);
    check(fixed >= 1 && d.status === 'failed' && /restart/.test(d.commit.error) && await w.c.records.countDocuments({ 'importSource.importId': id }) === 0, '21  a save cut off by a restart is rolled back (the half-written match removed)');
    check(d.read.scorecard.state === 'failed' && /restart/i.test(d.read.scorecard.error), '21  a reading cut off by a restart is reported, not left "running"');
    check(await snapshot(w.c) === before21, '21  the tournament exactly as before');

    section('22  the same match twice; a merge running');
    w = await world(); E = engine(w);
    id = await readyDraft(E, w, { meta: { date: '2026-10-10' } });
    await decide(E, id, { 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } });
    a = await E.analyze(V, id);
    const dup = a.issues.find(i => i.id === 'duplicate-match');
    check(dup && dup.ack && !a.canSave, '22  DY PATIL SA v PAREL on 10 Oct is already in the tournament: blocked until confirmed as a different match');
    w.locked = true;
    a = await E.analyze(V, id);
    check(a.issues.some(i => i.id === 'merge-lock'), '22  a tournament merge running: blocked');

    // ------------------------------------------------------------------
    section('23  photos');
    w = await world(); E = engine(w);
    d = await E.createDraft(V, { ownerUid: W, leagueKey: L });
    id = d.draftId;
    d = await E.addPhoto(V, id, { kind: 'scorecard', innings: 1 }, X.png(1, 8, 10));
    check(d.photos.length === 1 && d.photos[0].mediaType === 'image/png' && d.photos[0].width === 8 && d.photos[0].height === 10, 'a PNG is accepted (type and size read from the file)');
    const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
    let e1 = await err(() => E.addPhoto(V, id, { kind: 'scorecard', innings: 1 }, X.png(1, 8, 10)));
    check(e1 && e1.status === 409 && e1.code === 'DUPLICATE_PHOTO', 'the same photo twice is refused');
    e1 = await err(() => E.addPhoto(V, id, { kind: 'scorecard', innings: 1 }, Buffer.from('GIF89a this is not a photo we take')));
    check(e1 && e1.status === 415, 'not a JPG / PNG / WebP: refused');
    e1 = await err(() => E.addPhoto(V, id, { kind: 'scorecard', innings: 1 }, Buffer.concat([X.png(5), Buffer.alloc(6 * 1024 * 1024)])));
    check(e1 && e1.status === 413, 'over 6 MB: refused');
    await E.addPhoto(V, id, { kind: 'scorecard', innings: 1 }, X.png(2));
    await E.addPhoto(V, id, { kind: 'scorecard', innings: 2 }, X.png(3));
    d = await E.getDraft(V, id);
    const [p1, p2, p3] = d.photos;
    d = await E.updatePhotos(V, id, [p2, p1, p3].map(p => ({ id: p.id, kind: p.kind, innings: p.innings })));
    check(d.photos.map(p => p.id).join() === [p2.id, p1.id, p3.id].join(), 'photos re-ordered');
    d = await E.addPhoto(V, id, { kind: 'scorecard', innings: 1 }, X.png(6));
    const inn1 = d.photos.filter(p => p.innings === 1).sort((x, y) => x.order - y.order).map(p => p.id);
    check(inn1[0] === p2.id && inn1[1] === p1.id && inn1.length === 3, 'a photo added after a re-order goes last');
    d = await E.updatePhotos(V, id, [p2, p3].map(p => ({ id: p.id, kind: p.kind, innings: p.innings })));
    check(d.photos.length === 2 && !(await w.c.photos.findOne({ _id: p1.id })), 'a photo left out is removed, with its image');
    const got = await E.getPhoto(V, id, p2.id);
    check(got.mediaType === 'image/png' && Buffer.compare(got.data, X.png(2)) === 0, 'a photo comes back byte for byte');
    for (let i = 0; i < 22; i++) await E.addPhoto(V, id, { kind: 'commentary', innings: 1 }, X.png(100 + i));
    e1 = await err(() => E.addPhoto(V, id, { kind: 'commentary', innings: 1 }, X.png(200)));
    check(e1 && e1.status === 400 && /24/.test(e1.message), 'at most 24 photos');
    await E.deleteDraft(V, id);
    check(!(await w.c.imports.findOne({ _id: id })) && await w.c.photos.countDocuments({ draftId: id }) === 0, 'discarding an import deletes it and its photos');

    section('24  reading');
    w = await world(); E = engine(w);
    id = await readyDraft(E, w);
    check(w.calls[0].kind === 'scorecard' && w.calls[0].photos === 3, 'all three scorecard photos go to the reader together');
    d = await E.getDraft(V, id);
    check(d.read.scorecard.state === 'done' && d.read.scorecard.by === 'claude' && d.read.scorecard.notes[0].includes('cut off') && d.read.scorecard.printed.resultText === 'DY Patil SA won by 25 runs', 'the reading, its notes and the printed result are kept for the person');
    const rohitBowl = d.innings[0].bowling[1];
    check(rohitBowl.maidens === null && rohitBowl.confidence === 'low' && rohitBowl.unclear.includes('maidens'), 'an unreadable value stays empty and is flagged');
    check(d.innings[0].batting[0].captain === true && d.innings[0].didNotBat.includes('Aarav Desai'), 'captain and did-not-bat read');
    w.readError = Object.assign(new Error('Photo reading is busy right now — try again in a minute.'), { code: 'RATE_LIMIT', retryable: true });
    await E.startRead(V, id, { kind: 'scorecard' });
    d = await E.getDraft(V, id);
    check(d.read.scorecard.state === 'failed' && d.read.scorecard.code === 'RATE_LIMIT' && /busy/.test(d.read.scorecard.error) && d.read.scorecard.retryable, 'a reader failure is reported with its message');
    check(d.innings.length === 2, '…and the figures already there are kept');
    w.reader = false;
    e1 = await err(() => E.startRead(V, id, { kind: 'scorecard' }));
    check(e1 && e1.status === 503 && e1.code === 'NO_READER', 'no reader on the server: 503, type the figures or read them in the browser');
    // the browser / typed path
    d.innings[0].batting[0].runs = 41;
    d = await E.updateDraft(V, id, { innings: d.innings, reader: 'browser' });
    check(d.read.scorecard.by === 'browser' && d.innings[0].batting[0].runs === 41, 'figures from the browser reader (or typed) are taken as they are');
    const san = SI.sanitizeInnings([{ battingSide: 'A', batting: [{ name: 'X', runs: '12', balls: 'abc', fours: -1 }], bowling: [{ name: 'Y', overs: '3.2', wickets: 11 }], total: { runs: 20, wickets: 11 } }]);
    check(san[0].batting[0].runs === 12 && san[0].batting[0].balls === null && san[0].batting[0].fours === null && san[0].total.wickets === null, 'figures are cleaned: text and impossible values become "unknown", never a guess');

    section('25  commentary (shown on the match page, never counted)');
    check(SI.parseMarker('•').ballType === '0' && SI.parseMarker('W').wicket && SI.parseMarker('1wd').ballType === 'WD' && SI.parseMarker('1wd').runs === 1 && !SI.parseMarker('1wd').legal && SI.parseMarker('nb').ballType === 'NB' && SI.parseMarker('2lb').runs === 2 && SI.parseMarker('6').ballType === '6', 'ball markers: dot, W, 1wd, nb, 2lb, 6');
    w = await world(); E = engine(w);
    id = await readyDraft(E, w, { commentary: true });
    d = await E.getDraft(V, id);
    const ents = d.commentary[1].entries;
    check(ents.length === 4 && ents.map(e => e.label).join() === '0.1,0.2,0.3,0.3' && ents[2].ballType === 'WD', 'the same ball on two screenshots read once, in match order (the wide before its re-bowl)');
    await decide(E, id, { 'A|suraj patil': { mode: 'existing', id: 'p-surajp' } });
    a = await E.analyze(V, id);
    check(a.commentary[1] && !a.commentary[1].complete && a.issues.some(i => i.id === 'commentary-1' && i.level === 'warning') && a.canSave, 'partial commentary (one over of ten) is flagged, and does not block saving');
    const ballsBefore25 = await w.c.balls.countDocuments({});
    res = await E.commit(V, id, { idempotencyKey: 'cm', confirm: true });
    const cdoc = await w.c.commentary.findOne({});
    check(cdoc && cdoc.matchId === res.matchId && cdoc.innings[0].entries.length === 4 && cdoc.innings[0].complete === false, 'stored for the match page, marked partial');
    check(await w.c.balls.countDocuments({}) === ballsBefore25 && (await w.c.records.findOne({ matchId: res.matchId })).importSource.commentary === true, 'never turned into deliveries');

    section('history');
    const hist = await E.history(V);
    check(hist.length === 1 && hist[0].result.matchId === res.matchId, 'the saved import is in the history');

    console.log(`\n${passes} passed, ${fails.length} failed`);
    if (fails.length) { console.log('\nFAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
