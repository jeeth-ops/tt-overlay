// 🔀 Merge Tournaments — the engine (tournament-merge.js) against an
// in-memory MongoDB with the production unique indexes, on tournaments whose
// scorecards are built ball by ball by the real server.js rebuild.
//
//   Jeeth  — 2 destination matches with PLAYER_A + 1 source match with
//            PLAYER_B: keep PLAYER_A, and (fresh data) keep PLAYER_B
//   A same player, different IDs       G invalid references block finalizing
//   B every match exactly once         H failure mid-transfer, then recovery
//   C points table, no double counting I duplicate submission is idempotent
//   D leaderboard aggregation          J only the two accounts (engine level)
//   E similar names are never merged   K media is never touched
//     on their own                     L unrelated data / settings untouched
//   F match-id collision
//
// Run:  node test/tournament-merge.test.js
const assert = require('assert');
const { MemoryDb, ObjectId } = require('./mongo-memory.js');
const F = require('./merge-fixtures.js');
const TM = require('../tournament-merge.js');
const { S, pk, P, USERS } = F;

const fails = [];
let passes = 0;
const check = (ok, msg) => { if (ok) passes++; else fails.push(msg); console.log(`  ${ok ? '✓' : '✗'} ${msg}`); };
const section = (t) => console.log('\n' + t);

const W = USERS.work.uid;
const DKEY = 'summer cup 2026', SKEY = 'summer cup 2026 b', TKEY = 'winter league';
const dRef = { ownerUid: W, leagueKey: DKEY }, sRef = { ownerUid: W, leagueKey: SKEY };

function team(name, short, id, players, bowlers) { return { name, short, teamId: id, players, bowlers: bowlers || players.slice(-2) }; }
function RS(jeeth, opts) {
    const others = [P('Rahul Patil', 'p-rahul'), P('Amit Shah', 'p-amit'), P('Kunal Rao', 'p-kunal'), P('Sameer Khan', 'p-sameer')];
    return team((opts && opts.name) || 'Royal Strikers', 'RS', 'team-rs', [jeeth, ...others], [jeeth, others[3]]);
}
const TX = () => team('Thunder XI', 'TX', 'team-tx', [P('Vikram Singh', 'p-vikram'), P('Nikhil Jain', 'p-nikhil'), P('Arjun Mehta', 'p-arjun'), P('Dev Sharma', 'p-dev'), P('Om Prakash', 'p-om')]);
const BH = () => team('Blue Hawks', 'BH', 'team-bh', [P('Harsh Vora', 'p-harsh'), P('Ishan Roy', 'p-ishan'), P('Manav Das', 'p-manav'), P('Yash Pal', 'p-yash'), P('Zaid Ali', 'p-zaid')]);

// Two tournaments of workallsportslive@gmail.com that should be one, an
// unrelated third one, and the owner's own private tournament.
async function world(opts) {
    opts = opts || {};
    const mem = new MemoryDb();
    const c = F.collections(mem);
    await F.indexes(c);
    const jeethA = opts.destJeeth || P('Jeeth', 'PLAYER_A');
    const jeethS = opts.sourceJeeth || P('Jeeth', 'PLAYER_B');
    if (!opts.noProfileA) await F.addProfile(c, W, jeethA.id, jeethA.name);
    if (opts.profileZ) await F.addProfile(c, W, 'PLAYER_Z', 'Jeeth');
    if (opts.sourceJeethProfile) await F.addProfile(c, W, jeethS.id, jeethS.name);
    for (const t of [RS(jeethA), TX(), BH()]) for (const p of t.players) if (p !== jeethA) await F.addProfile(c, W, p.id, p.name);
    const infoTeams = (list) => list.map(t => ({ name: t.name, short: t.short, color: '#123456', teamId: t.teamId, logoUrl: '' }));
    await F.addLeague(c, { ownerUid: W, leagueKey: DKEY, name: 'Summer Cup 2026', token: 'tokD', teams: infoTeams([RS(jeethA), TX(), BH()]), visibilityOverride: opts.destVisibility });
    await F.addLeague(c, { ownerUid: W, leagueKey: SKEY, name: 'Summer Cup 2026 B', token: 'tokS', teams: infoTeams([RS(jeethS), TX()]), visibilityOverride: opts.sourceVisibility, liveMatches: opts.sourceLive ? [{ matchId: 'm-s1', roomId: 'room-s1' }] : [] });
    await F.addLeague(c, { ownerUid: W, leagueKey: TKEY, name: 'Winter League', token: 'tokW' });
    const d1 = await F.addMatch(c, { ownerUid: W, leagueKey: DKEY, matchId: 'm-d1', roomId: 'room-d1', teamA: RS(jeethA), teamB: TX(), seed: 0, date: '2026-10-01', matchNo: 1, tagClips: opts.tagClips });
    const d2 = await F.addMatch(c, { ownerUid: W, leagueKey: DKEY, matchId: 'm-d2', roomId: 'room-d2', teamA: RS(jeethA), teamB: BH(), seed: 5, date: '2026-10-02', matchNo: 2 });
    const s1 = await F.addMatch(c, { ownerUid: W, leagueKey: SKEY, matchId: 'm-s1', roomId: opts.sharedRoom ? 'room-w1' : 'room-s1', teamA: TX(), teamB: RS(jeethS, { name: opts.sourceTeamName }), seed: 9, date: '2026-10-03', matchNo: 1, panelState: true, unfinished: opts.sourceUnfinished, tagClips: opts.tagClips });
    const w1 = await F.addMatch(c, { ownerUid: W, leagueKey: TKEY, matchId: 'm-w1', roomId: 'room-w1', teamA: RS(jeethA), teamB: BH(), seed: 3, date: '2026-09-01' });
    // the owner's own private tournament (scope checks)
    await F.addLeague(c, { ownerUid: USERS.owner.uid, leagueKey: 'private cup', name: 'Private Cup', token: 'tokO' });
    await F.addLeague(c, { ownerUid: USERS.vinit.uid, leagueKey: 'vinit cup', name: 'Vinit Cup', token: 'tokV' });
    return { mem, c, d1, d2, s1, w1, jeethA, jeethS };
}

function engine(w, extra) {
    w.invalidated = [];
    return TM.createTournamentMerge(Object.assign({
        db: { leagues: w.c.leagues, records: w.c.records, balls: w.c.balls, clips: w.c.clips, players: w.c.players, panelStates: w.c.panelStates, merges: w.c.merges, backups: w.c.backups, locks: w.c.locks },
        playerKey: S.playerKey, computePointsTable: S.computePointsTable, computeLeaderboards: S.computeLeaderboards,
        playedMatches: S.playedMatches, footprintTotalBalls: S.footprintTotalBalls, effectiveIsPrivate: S.effectiveIsPrivate,
        getVerifiedEmailForUid: async (uid) => F.EMAIL_OF[uid] || null, getUidForEmail: async (e) => F.UID_OF[e] || null,
        detectSportFromName: () => 'cricket', ownerEmail: 'chhayajeeth@gmail.com',
        authorizedCreatorEmails: ['workallsportslive@gmail.com', 'vinitkrkr1@gmail.com', 'chhayajeeth@gmail.com'],
        singleMatchesLeagueKey: '__single_matches__',
        invalidateTournamentCaches: (t) => w.invalidated.push(t), invalidateClipsCache: () => {}, repointPlayerIdCache: () => {},
        logAuditAction: async (...a) => { await w.c.audits.insertOne({ performedBy: a[0], action: a[1], target: a[2], extra: a[5] || null }); },
        versionMatchRecord: async (doc, reason) => { await w.c.versions.insertOne({ matchId: doc.matchId, reason, record: Object.assign({}, doc, { _id: undefined }) }); },
        toObjectId: (s) => (/^[0-9a-f]{24}$/i.test(String(s)) ? new ObjectId(String(s)) : s)
    }, extra || {}));
}

// Everything a merge may touch, as plain JSON (for "nothing changed" checks).
async function snapshot(c, skipCollections) {
    const out = {};
    for (const [name, coll] of Object.entries(c)) {
        if (['merges', 'backups', 'locks', 'audits', 'versions'].concat(skipCollections || []).includes(name)) continue;
        const docs = await coll.find({}).toArray();
        out[name] = docs.map(d => JSON.stringify(d)).sort();
    }
    return out;
}
const sameSnap = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function waitOp(E, viewer, opId) {
    for (let i = 0; i < 5000; i++) {
        const op = await E.getOp(viewer, opId);
        if (!['running'].includes(op.status)) return op;
        await new Promise(r => setImmediate(r));
    }
    throw new Error('merge did not finish');
}
function defaults(a, overrides) {
    const players = {};
    a.players.candidates.forEach(c => { players[c.pairId] = c.requiresManual ? { same: false } : { same: true, keep: c.recommended || 'dest' }; });
    const teams = {};
    (a.teams.pairs || []).filter(t => t.type === 'similar').forEach(t => { teams[t.pairId] = { same: false }; });
    return Object.assign({ players, teams, matches: {}, acknowledged: a.warnings.filter(x => x.ack).map(x => x.code) }, overrides || {});
}
async function merge(E, viewer, decide, extra) {
    const a = await E.analyze(viewer, { source: sRef, dest: dRef });
    const decisions = decide ? decide(a) : defaults(a);
    const a2 = await E.analyze(viewer, { source: sRef, dest: dRef, decisions });
    const res = await E.execute(viewer, Object.assign({
        source: sRef, dest: dRef, decisions, fingerprint: a2.fingerprint,
        idempotencyKey: 'k-' + Math.random().toString(36).slice(2), confirm: { deleteSource: true, typedName: a2.source.name }
    }, extra || {}));
    const op = res.status === 'running' ? await waitOp(E, viewer, res.opId) : await E.getOp(viewer, res.opId);
    return { a, a2, res, op, decisions };
}
async function expectReject(p, status, code) {
    try { await p; return { ok: false, msg: 'did not throw' }; }
    catch (e) { return { ok: e.status === status && (!code || e.code === code || (e.errors || []).some(x => x.code === code) || (e.blockers || []).some(x => x.code === code)), e }; }
}

// every reference to a player id inside one match's data
async function refsTo(c, ids, matchKeys) {
    const out = [];
    const recs = await c.records.find({}).toArray();
    recs.filter(r => !matchKeys || matchKeys.includes(r.matchId)).forEach(r => {
        const s = JSON.stringify(r);
        ids.forEach(id => { if (s.includes(`"${id}"`)) out.push(`record ${r.matchId}`); });
    });
    for (const coll of ['balls', 'clips']) {
        const docs = await c[coll].find({}).toArray();
        docs.filter(d => !matchKeys || matchKeys.includes(d.matchId)).forEach(d => {
            const s = JSON.stringify(d);
            ids.forEach(id => { if (s.includes(`"${id}"`)) out.push(`${coll} ${d.matchId}`); });
        });
    }
    return out;
}
const jeethRuns = (recs, key) => recs.reduce((n, r) => n + ['A', 'B'].reduce((m, s) => m + ((r.battingCard[s] || []).filter(b => pk(b.name) === key).reduce((x, b) => x + (b.runs || 0), 0)), 0), 0);

(async () => {
    const viewer = USERS.work;

    // ---------------------------------------------------------------
    section('Analysis: what the preview shows');
    {
        const w = await world();
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        check(a.ok && !a.blockers.length, 'no blockers for two tournaments of the same account');
        check(a.matches.transfer.length === 1 && a.matches.transfer[0].action === 'move' && a.matches.transfer[0].status === 'completed', 'the source match will move (completed)');
        const jc = a.players.candidates.find(c => c.dest.name === 'Jeeth');
        check(!!jc && jc.type === 'exact' && jc.recommended === 'dest' && !jc.requiresManual, 'Jeeth: same name, same team, two IDs → recommended to keep the destination ID');
        check(jc && jc.dest.primaryId === 'PLAYER_A' && jc.source.primaryId === 'PLAYER_B', 'both IDs shown (PLAYER_A / PLAYER_B)');
        check(jc && jc.dest.matches === 2 && jc.source.matches === 1, 'match counts shown (2 / 1)');
        check(jc && jc.dest.tournament === 'Summer Cup 2026' && jc.source.tournament === 'Summer Cup 2026 B', 'tournament names shown');
        check(jc && jc.options.dest.ok && jc.options.source.ok, 'either ID may be kept');
        check(a.players.candidates.length === 1, 'only the real duplicate is asked about (no question for the others)');
        check(a.teams.pairs.filter(t => t.type === 'same').length === 2, 'teams matched by name (Royal Strikers, Thunder XI)');
        check(a.expected.matches === 3 && a.matches.finalCount === 3, 'expected final state: 3 matches');
        check(a.pointsTable.after.find(r => r.team === 'Royal Strikers').played === 3, 'points table preview: Royal Strikers 3 played');
        const lbJeeth = a.leaderboards.after.topRuns.filter(r => pk(r.name) === 'jeeth');
        check(lbJeeth.length === 1, 'leaderboard preview: one Jeeth');
        check(a.settings.keep.name === 'Summer Cup 2026' && a.settings.drop.name === 'Summer Cup 2026 B', 'settings: destination kept, source dropped');
        check(a.clips.mediaUntouched === true && a.clips.source > 0, 'clips listed, media untouched');
        check(typeof a.fingerprint === 'string' && a.fingerprint.length === 32, 'fingerprint returned');
    }

    // ---------------------------------------------------------------
    section('Jeeth acceptance — keep PLAYER_A (A, B, C, D, K, L)');
    {
        const w = await world({ panelState: true });
        const before = await snapshot(w.c);
        const recsBefore = [w.d1.rec, w.d2.rec, w.s1.rec];
        const runsBefore = jeethRuns(recsBefore, 'jeeth');
        const tableBefore = S.computePointsTable(recsBefore);
        const clipMediaBefore = (await w.c.clips.find({}).toArray()).map(cl => [cl.clipId, cl.r2Key, cl.r2Url, cl.driveFileId, cl.driveUrl, cl.status, cl.r2PosterUrl].join('|')).sort();
        const w1Before = JSON.stringify(await w.c.records.findOne({ matchId: 'm-w1' }));
        const w1Balls = JSON.stringify(await w.c.balls.find({ matchId: 'room-w1' }).toArray());
        const E = engine(w);
        const { op } = await merge(E, viewer);
        check(op.status === 'completed', 'merge completed (' + op.status + (op.error ? ': ' + op.error.message : '') + ')');
        check(op.verification && op.verification.passed && op.verification.checks.every(x => x.ok), 'every verification check passed');
        const finalD = await w.c.records.find({ ownerUid: W, leagueKey: DKEY }).toArray();
        check(finalD.length === 3 && new Set(finalD.map(r => r.matchId)).size === 3, 'B: destination has 3 matches, each once');
        check(!(await w.c.leagues.findOne({ ownerUid: W, leagueKey: SKEY })), 'source tournament removed (after verification)');
        check((await w.c.records.countDocuments({ leagueKey: SKEY })) === 0, 'no match left under the source');
        check((await refsTo(w.c, ['PLAYER_B'], ['m-s1', 'room-s1'])).length === 0, 'A: no reference to PLAYER_B left in the moved match (record, balls, clips)');
        const s1 = finalD.find(r => r.matchId === 'm-s1');
        const jRow = s1.battingCard.B.find(r => pk(r.name) === 'jeeth') || s1.bowlingCard.B.find(r => pk(r.name) === 'jeeth');
        check(jRow && jRow.id === 'PLAYER_A', 'scorecard row carries PLAYER_A');
        check(s1.squadB.players.find(p => pk(p.name) === 'jeeth').id === 'PLAYER_A' && s1.squadB.captainId === 'PLAYER_A', 'squad + captain carry PLAYER_A');
        const sBalls = await w.c.balls.find({ matchId: 'room-s1' }).toArray();
        check(sBalls.some(b => b.bowlerPlayerId === 'PLAYER_A' || b.strikerPlayerId === 'PLAYER_A'), 'ball-by-ball carries PLAYER_A');
        check(S.computePointsTable(finalD).find(r => r.team === 'Royal Strikers').played === 3, 'C: Royal Strikers played 3');
        check(JSON.stringify(S.computePointsTable(finalD)) === JSON.stringify(tableBefore), 'C: points table = the three matches counted once each');
        const lb = S.computeLeaderboards(finalD);
        const js = lb.topRuns.filter(r => pk(r.name) === 'jeeth');
        check(js.length === 1 && js[0].runs === runsBefore && js[0].innings === 3, `D: one Jeeth on the leaderboard with 3-match stats (${js[0] && js[0].runs} runs in ${js[0] && js[0].innings})`);
        const clipMediaAfter = (await w.c.clips.find({}).toArray()).map(cl => [cl.clipId, cl.r2Key, cl.r2Url, cl.driveFileId, cl.driveUrl, cl.status, cl.r2PosterUrl].join('|')).sort();
        check(JSON.stringify(clipMediaAfter) === JSON.stringify(clipMediaBefore), 'K: every clip kept, media fields (R2/Drive) byte-identical');
        check(JSON.stringify(await w.c.records.findOne({ matchId: 'm-w1' })) === w1Before && JSON.stringify(await w.c.balls.find({ matchId: 'room-w1' }).toArray()) === w1Balls, 'L: unrelated tournament untouched (record + balls)');
        const dDoc = await w.c.leagues.findOne({ ownerUid: W, leagueKey: DKEY });
        check(dDoc.publicToken === 'tokD' && dDoc.displayName === 'Summer Cup 2026' && !dDoc.visibilityOverride, 'L: destination name, ID and visibility unchanged');
        check(!(await w.c.panelStates.findOne({ matchId: 'm-s1' })), 'old resume snapshot of the moved match archived (it held PLAYER_B)');
        check((await w.c.backups.countDocuments({ coll: 'panelStates' })) === 1, '… and kept in the backups');
        check((await w.c.audits.find({}).toArray()).some(x => x.action === 'Tournament merge' && x.performedBy === 'workallsportslive@gmail.com' && x.extra && x.extra.mergeOpId === op.opId), 'audit log entry written');
        check((await w.c.locks.countDocuments({})) === 0 && !E.lockFor(W, SKEY) && !E.lockFor(W, DKEY), 'locks released');
        const alias = await E.aliasForToken('tokS');
        check(alias && alias.destToken === 'tokD', 'old source link resolves to the destination');
        check((await E.redirectLeagueKey(W, SKEY, 'm-s1')) === DKEY, 'a laptop still on the old tournament is sent to the destination');
        check(w.invalidated.includes('tokD') && w.invalidated.includes('tokS'), 'caches of both tournaments dropped');
        const audit = op.decisions.players.find(p => p.dest.name === 'Jeeth');
        check(audit && audit.keptId === 'PLAYER_A', 'decision recorded in the merge record');
        // a save into the destination still works normally afterwards
        void before;
    }

    // ---------------------------------------------------------------
    section('Jeeth acceptance — keep PLAYER_B (the other ID)');
    {
        const w = await world();
        const runsBefore = jeethRuns([w.d1.rec, w.d2.rec, w.s1.rec], 'jeeth');
        const w1Before = JSON.stringify(await w.c.records.findOne({ matchId: 'm-w1' }));
        const E = engine(w);
        const { op } = await merge(E, viewer, (a) => {
            const d = defaults(a);
            const jc = a.players.candidates.find(c => c.dest.name === 'Jeeth');
            d.players[jc.pairId] = { same: true, keep: 'source' };
            return d;
        });
        check(op.status === 'completed' && op.verification.passed, 'merge completed with PLAYER_B kept (' + op.status + (op.error ? ': ' + op.error.message : '') + ')');
        const finalD = await w.c.records.find({ ownerUid: W, leagueKey: DKEY }).toArray();
        check((await refsTo(w.c, ['PLAYER_A'], ['m-d1', 'm-d2', 'm-s1', 'room-d1', 'room-d2', 'room-s1'])).length === 0, 'every destination reference now uses PLAYER_B');
        const pb = await w.c.players.findOne({ playerId: 'PLAYER_B' });
        const pa = await w.c.players.findOne({ playerId: 'PLAYER_A' });
        check(pb && pb.nameKeys.includes('jeeth'), 'PLAYER_B now has a profile holding the name "jeeth"');
        check(pa && pa.mergedInto === 'PLAYER_B' && !pa.nameKeys.includes('jeeth'), 'PLAYER_A linked to PLAYER_B (mergedInto), not deleted');
        check(JSON.stringify(await w.c.records.findOne({ matchId: 'm-w1' })) === w1Before, 'the unrelated tournament keeps PLAYER_A (resolves through the link)');
        const js = S.computeLeaderboards(finalD).topRuns.filter(r => pk(r.name) === 'jeeth');
        check(js.length === 1 && js[0].runs === runsBefore, 'one Jeeth on the leaderboard with all 3 matches');
    }

    // ---------------------------------------------------------------
    section('E: similar names are never merged on their own');
    {
        const w = await world({ sourceJeeth: P('Jeeth Chhaya', 'PLAYER_C'), sourceJeethProfile: true });
        const before = await snapshot(w.c);
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const jc = a.players.candidates.find(c => c.dest.name === 'Jeeth');
        check(jc && jc.type === 'similar' && jc.requiresManual && jc.recommended === null, '"Jeeth" ~ "Jeeth Chhaya": flagged for review, no default');
        check(a.leaderboards.after.topRuns.some(r => r.name === 'Jeeth Chhaya'), 'preview keeps them apart until the user decides');
        const noDecision = await expectReject(E.execute(viewer, { source: sRef, dest: dRef, decisions: { acknowledged: a.warnings.filter(x => x.ack).map(x => x.code) }, fingerprint: a.fingerprint, idempotencyKey: 'e1', confirm: { deleteSource: true, typedName: 'Summer Cup 2026 B' } }), 400, 'NEEDS_REVIEW');
        check(noDecision.ok, 'executing without a decision is refused (needs review)');
        check(sameSnap(await snapshot(w.c), before) && (await w.c.locks.countDocuments({})) === 0, 'nothing changed, nothing left locked');
        const { op } = await merge(E, viewer);
        check(op.status === 'completed', '"different players" → merge completes');
        const finalD = await w.c.records.find({ ownerUid: W, leagueKey: DKEY }).toArray();
        const lb = S.computeLeaderboards(finalD);
        check(lb.topRuns.some(r => r.name === 'Jeeth') && lb.topRuns.some(r => r.name === 'Jeeth Chhaya'), 'both players stay separate');
        check((await refsTo(w.c, ['PLAYER_C'], ['m-s1', 'room-s1'])).length > 0 && !(await w.c.players.findOne({ playerId: 'PLAYER_C' })).mergedInto, 'PLAYER_C and its profile untouched');
    }
    {
        const w = await world({ sourceJeeth: P('Jeeth Chhaya', 'PLAYER_C'), sourceJeethProfile: true });
        const E = engine(w);
        const howOutBefore = JSON.stringify(w.s1.rec.battingCard.A.map(r => r.howOut));
        const { op } = await merge(E, viewer, (a) => {
            const d = defaults(a);
            const jc = a.players.candidates.find(c => c.dest.name === 'Jeeth');
            d.players[jc.pairId] = { same: true, keep: 'dest' };
            return d;
        });
        check(op.status === 'completed' && op.verification.passed, 'user confirms "same player, keep PLAYER_A" → merged');
        const s1 = await w.c.records.findOne({ matchId: 'm-s1' });
        const allNames = JSON.stringify([s1.battingCard, s1.bowlingCard, s1.squadB, s1.partnerships]);
        check(!allNames.includes('Jeeth Chhaya') && allNames.includes('"Jeeth"'), 'every spelling in the moved scorecard is now "Jeeth"');
        check(howOutBefore.includes('Jeeth Chhaya') ? !JSON.stringify(s1.battingCard.A.map(r => r.howOut)).includes('Jeeth Chhaya') : true, 'dismissal lines ("c … b Jeeth") follow the new spelling');
        const pc = await w.c.players.findOne({ playerId: 'PLAYER_C' });
        const pa = await w.c.players.findOne({ playerId: 'PLAYER_A' });
        check(pc.mergedInto === 'PLAYER_A' && pa.nameKeys.includes('jeeth chhaya') && pa.nameKeys.includes('jeeth'), 'PLAYER_C linked to PLAYER_A; "jeeth chhaya" now resolves to PLAYER_A');
        const lb = S.computeLeaderboards(await w.c.records.find({ ownerUid: W, leagueKey: DKEY }).toArray());
        check(lb.topRuns.filter(r => pk(r.name) === 'jeeth').length === 1 && !lb.topRuns.some(r => r.name === 'Jeeth Chhaya'), 'one Jeeth on the leaderboard');
    }
    {
        // same name, different team → ambiguous; "different" leaves both alone
        const w = await world();
        await w.c.records.updateOne({ matchId: 'm-s1' }, { $set: { 'squadA.players.0.name': 'Rahul Patil', 'squadA.players.0.id': 'p-rahul-2' } });
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const amb = a.players.candidates.find(c => c.type === 'ambiguous');
        check(!!amb && amb.requiresManual && amb.dest.team !== amb.source.team, 'same name in different teams with different IDs → manual review');
    }

    // ---------------------------------------------------------------
    section('F: match-id collision');
    {
        const w = await world();
        // a DIFFERENT match in the source that happens to carry m-d2's id
        await F.addMatch(w.c, { ownerUid: W, leagueKey: SKEY, matchId: 'm-d2', roomId: 'room-s2', teamA: TX(), teamB: BH(), seed: 13, date: '2026-10-05' });
        const d2Before = JSON.stringify(await w.c.records.findOne({ leagueKey: DKEY, matchId: 'm-d2' }));
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const clash = a.matches.transfer.find(m => m.matchId === 'm-d2');
        check(clash && clash.action === 'remap' && clash.newMatchId && clash.newMatchId !== 'm-d2', 'clash detected → moved under a new id (' + (clash && clash.newMatchId) + ')');
        const { op } = await merge(E, viewer);
        check(op.status === 'completed' && op.verification.passed, 'merge completed');
        check(JSON.stringify(await w.c.records.findOne({ leagueKey: DKEY, matchId: 'm-d2' })) === d2Before, 'the destination match with that id is untouched');
        const moved = await w.c.records.findOne({ leagueKey: DKEY, matchId: clash.newMatchId });
        check(moved && moved.roomId === 'room-s2' && moved.teamA.name === 'Thunder XI', 'the source match is there under its new id, scorecard intact');
        check((await w.c.records.countDocuments({ leagueKey: DKEY })) === 4, '4 matches, none overwritten');
        const alias = await E.aliasForToken('tokS');
        check(alias && alias.matchIdMap['m-d2'] === clash.newMatchId, 'old match link maps to the new id');
    }

    // ---------------------------------------------------------------
    section('B: a copy of a destination match is counted once');
    {
        const w = await world();
        const copy = Object.assign({}, w.d1.rec, { _id: new ObjectId(), leagueKey: SKEY });
        await w.c.records.insertOne(copy);
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        check(a.matches.transfer.find(m => m.matchId === 'm-d1').action === 'duplicate', 'identical copy recognised as the same match');
        const { op } = await merge(E, viewer);
        check(op.status === 'completed' && op.verification.passed, 'merge completed');
        const finalD = await w.c.records.find({ ownerUid: W, leagueKey: DKEY }).toArray();
        check(finalD.filter(r => r.matchId === 'm-d1').length === 1 && finalD.length === 3, 'm-d1 once; 3 matches in all');
        check((await w.c.records.countDocuments({ leagueKey: SKEY })) === 0, 'the stray copy left with the source');
        check(S.computePointsTable(finalD).find(r => r.team === 'Thunder XI').played === 2, 'points table counts it once');
    }

    // ---------------------------------------------------------------
    section('G: invalid references block finalization');
    {
        // neither ID can be kept safely: no profiles, and "jeeth" belongs to an unrelated PLAYER_Z
        const w = await world({ destJeeth: P('Jeeth', 'PLAYER_X'), noProfileA: true, profileZ: true });
        const before = await snapshot(w.c);
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const jc = a.players.candidates.find(c => c.dest.name === 'Jeeth');
        check(jc && !jc.options.dest.ok && !jc.options.source.ok && /PLAYER_Z/.test(jc.options.dest.reason), 'unsafe IDs explained (the name belongs to PLAYER_Z)');
        const d = defaults(a);
        d.players[jc.pairId] = { same: true, keep: 'dest' };
        const r = await expectReject(E.execute(viewer, { source: sRef, dest: dRef, decisions: d, fingerprint: a.fingerprint, idempotencyKey: 'g1', confirm: { deleteSource: true, typedName: 'Summer Cup 2026 B' } }), 400, 'ID_NOT_RETAINABLE');
        check(r.ok, 'keeping an unsafe ID is refused');
        check(sameSnap(await snapshot(w.c), before), 'nothing changed');
    }
    {
        // a match saved into the source WHILE the merge runs → verification fails → rolled back
        const w = await world();
        const before = await snapshot(w.c);
        const E = engine(w, {
            afterStage: async (stage) => {
                if (stage === 'transferring') await w.c.records.insertOne({ _id: new ObjectId(), ownerUid: W, leagueKey: SKEY, matchId: 'm-stray', roomId: 'room-stray', teamA: { name: 'Thunder XI' }, teamB: { name: 'Blue Hawks' }, upcoming: true });
            }
        });
        const { op } = await merge(E, viewer);
        check(op.status === 'rolled_back', 'verification failed → rolled back (' + op.status + ')');
        check(op.verification && op.verification.checks.find(x => x.id === 'source-emptied').ok === false, 'the failing check is named (source not empty)');
        check(!!(await w.c.leagues.findOne({ ownerUid: W, leagueKey: SKEY })), 'source NOT deleted');
        await w.c.records.deleteOne({ matchId: 'm-stray' });
        check(sameSnap(await snapshot(w.c), before), 'every document back exactly as before');
        check((await w.c.locks.countDocuments({})) === 0, 'locks released');
    }

    // ---------------------------------------------------------------
    section('H: failure mid-transfer, then recovery');
    {
        const w = await world();
        const before = await snapshot(w.c);
        w.mem.fail('balls', 'bulkWrite', { times: 1 });
        const E = engine(w);
        const { op } = await merge(E, viewer);
        check(op.status === 'rolled_back' && op.error && /injected failure/.test(op.error.message), 'a write failing half way → automatic rollback');
        check(sameSnap(await snapshot(w.c), before), 'database exactly as before the merge');
        check(!!(await w.c.leagues.findOne({ ownerUid: W, leagueKey: SKEY })), 'source still there');
    }
    {
        // the server dies after transferring (interrupted) → resume
        const w = await world();
        const E = engine(w, { autoRun: false });
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const decisions = defaults(a);
        const res = await E.execute(viewer, { source: sRef, dest: dRef, decisions, fingerprint: a.fingerprint, idempotencyKey: 'h2', confirm: { deleteSource: true, typedName: 'Summer Cup 2026 B' } });
        await E._runOp(res.opId, { stopAfter: 'transferring' });
        let op = await E.getOp(viewer, res.opId);
        check(op.status === 'interrupted' && op.canResume && op.canRollback, 'cut off after transferring → interrupted (resume / roll back offered)');
        check(!!E.lockFor(W, SKEY), 'the source stays locked meanwhile');
        // a restart: a fresh engine loads the state from the database
        const E2 = engine(w, { autoRun: false });
        await E2.recoverInterrupted();
        check(!!E2.lockFor(W, SKEY), 'locks survive a restart');
        await E2.resume(viewer, res.opId);
        await E2._runOp(res.opId);
        op = await E2.getOp(viewer, res.opId);
        check(op.status === 'completed' && op.verification.passed, 'resumed → completed and verified');
        const finalD = await w.c.records.find({ ownerUid: W, leagueKey: DKEY }).toArray();
        check(finalD.length === 3 && (await refsTo(w.c, ['PLAYER_B'], ['m-s1', 'room-s1'])).length === 0, 'same result as an uninterrupted merge');
        check((await w.c.balls.countDocuments({ matchId: 'room-s1' })) === w.s1.balls.length, 'no delivery duplicated or lost by running a stage twice');
    }
    {
        // interrupted → roll back instead
        const w = await world();
        const before = await snapshot(w.c);
        const E = engine(w, { autoRun: false });
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const res = await E.execute(viewer, { source: sRef, dest: dRef, decisions: defaults(a), fingerprint: a.fingerprint, idempotencyKey: 'h3', confirm: { deleteSource: true, typedName: 'Summer Cup 2026 B' } });
        await E._runOp(res.opId, { stopAfter: 'transferring' });
        const op = await E.rollback(viewer, res.opId);
        check(op.status === 'rolled_back', 'interrupted merge rolled back on request');
        check(sameSnap(await snapshot(w.c), before), 'database exactly as before');
        check(!E.lockFor(W, SKEY) && (await w.c.locks.countDocuments({})) === 0, 'unlocked');
    }

    // ---------------------------------------------------------------
    section('I: duplicate submission is idempotent');
    {
        const w = await world();
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const body = { source: sRef, dest: dRef, decisions: defaults(a), fingerprint: a.fingerprint, idempotencyKey: 'same-key', confirm: { deleteSource: true, typedName: 'Summer Cup 2026 B' } };
        const [r1, r2] = await Promise.all([E.execute(viewer, body), E.execute(viewer, body)]);
        check(r1.opId === r2.opId && (r1.duplicate || r2.duplicate), 'double submit → one merge (same id)');
        await waitOp(E, viewer, r1.opId);
        check((await w.c.merges.countDocuments({})) === 1, 'one merge record');
        const r3 = await E.execute(viewer, Object.assign({}, body, { idempotencyKey: 'another-key' }));
        check(r3.alreadyMerged && r3.opId === r1.opId, 'submitting again after it finished → "already merged", nothing re-run');
        check((await w.c.records.countDocuments({ ownerUid: W, leagueKey: DKEY })) === 3, 'still 3 matches');
    }
    {
        const w = await world();
        const E = engine(w, { autoRun: false });
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const body = (k) => ({ source: sRef, dest: dRef, decisions: defaults(a), fingerprint: a.fingerprint, idempotencyKey: k, confirm: { deleteSource: true, typedName: 'Summer Cup 2026 B' } });
        const r1 = await E.execute(viewer, body('k1'));
        const r2 = await expectReject(E.execute(viewer, body('k2')), 409, 'LOCKED');
        check(r1.opId && r2.ok, 'a second merge of the same tournaments while one runs → 409 (locked)');
    }
    {
        const w = await world();
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        await w.c.records.updateOne({ matchId: 'm-s1' }, { $set: { venue: 'Changed after the preview' } });
        const r = await expectReject(E.execute(viewer, { source: sRef, dest: dRef, decisions: defaults(a), fingerprint: a.fingerprint, idempotencyKey: 'stale', confirm: { deleteSource: true, typedName: 'Summer Cup 2026 B' } }), 409, 'STALE_PREVIEW');
        check(r.ok, 'source changed after the preview → refused, analyze again');
        const r2 = await expectReject(E.execute(viewer, { source: sRef, dest: dRef, decisions: defaults(a), fingerprint: a.fingerprint, idempotencyKey: 'noconfirm', confirm: { deleteSource: true, typedName: 'Summer Cup' } }), 400);
        check(r2.ok, 'wrong confirmation name → refused');
    }

    // ---------------------------------------------------------------
    section('J: only the two accounts (engine level; HTTP + page in their own tests)');
    {
        const w = await world();
        const E = engine(w);
        const other = USERS.other;
        const denied = await Promise.all([
            expectReject(E.listTournaments(other), 403), expectReject(E.analyze(other, { source: sRef, dest: dRef }), 403),
            expectReject(E.execute(other, { idempotencyKey: 'x' }), 403), expectReject(E.history(other), 403),
            expectReject(E.analyze(USERS.vinit, { source: { ownerUid: USERS.vinit.uid, leagueKey: 'vinit cup' }, dest: { ownerUid: USERS.vinit.uid, leagueKey: 'vinit cup' } }), 403)
        ]);
        check(denied.every(x => x.ok), 'any other account (vinitkrkr1@gmail.com included) → 403 on every call');
        const workList = await E.listTournaments(USERS.work);
        check(workList.every(t => t.ownerUid === W) && workList.length === 3, 'workallsportslive@gmail.com sees only its own tournaments');
        const r = await expectReject(E.analyze(USERS.work, { source: { ownerUid: USERS.owner.uid, leagueKey: 'private cup' }, dest: dRef }), 403);
        check(r.ok, '… and cannot reach the owner\'s private tournament');
        const ownerList = await E.listTournaments(USERS.owner);
        check(ownerList.some(t => t.ownerUid === W) && ownerList.some(t => t.ownerUid === USERS.owner.uid) && ownerList.some(t => t.ownerUid === USERS.vinit.uid), 'chhayajeeth@gmail.com sees every creator\'s tournaments (as in the admin portal)');
        const priv = ownerList.find(t => t.leagueKey === 'private cup');
        check(priv && priv.visibility === 'private', 'visibility shown as it is');
        const cross = await E.analyze(USERS.owner, { source: { ownerUid: USERS.vinit.uid, leagueKey: 'vinit cup' }, dest: dRef });
        check(!cross.ok && cross.blockers.some(b => b.code === 'DIFFERENT_ACCOUNTS'), 'tournaments of different accounts cannot be merged');
        const same = await E.analyze(USERS.work, { source: dRef, dest: dRef });
        check(!same.ok && same.blockers.some(b => b.code === 'SAME_TOURNAMENT'), 'the same tournament twice is refused');
    }

    // ---------------------------------------------------------------
    section('Visibility, live matches, unfinished matches, shared rooms, team spellings');
    {
        const w = await world({ sourceVisibility: 'private' });
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const warn = a.warnings.find(x => x.code === 'BECOMES_PUBLIC');
        check(warn && warn.ack, 'private source into a public destination → must be acknowledged');
        const d = defaults(a);
        d.acknowledged = [];
        const r = await expectReject(E.execute(viewer, { source: sRef, dest: dRef, decisions: d, fingerprint: a.fingerprint, idempotencyKey: 'v1', confirm: { deleteSource: true, typedName: 'Summer Cup 2026 B' } }), 400, 'NOT_ACKNOWLEDGED');
        check(r.ok, 'without the acknowledgement → refused');
        const { op } = await merge(E, viewer);
        check(op.status === 'completed', 'acknowledged → merged');
        const dDoc = await w.c.leagues.findOne({ ownerUid: W, leagueKey: DKEY });
        check(!dDoc.visibilityOverride && S.effectiveIsPrivate(dDoc, 'workallsportslive@gmail.com') === false, 'destination visibility unchanged (still public)');
    }
    {
        const w = await world({ sourceLive: true, sourceUnfinished: true });
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        check(!a.ok && a.blockers.some(b => b.code === 'SOURCE_LIVE'), 'a live match in the source blocks the merge');
        const r = await expectReject(E.execute(viewer, { source: sRef, dest: dRef, decisions: defaults(a), fingerprint: a.fingerprint, idempotencyKey: 'live', confirm: { deleteSource: true, typedName: 'Summer Cup 2026 B' } }), 409, 'SOURCE_LIVE');
        check(r.ok, '… also at execute (server-side)');
    }
    {
        const w = await world({ sourceUnfinished: true });
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        check(a.warnings.some(x => x.code === 'UNFINISHED_RENAMED' && x.ack), 'an unfinished match changing IDs → warning to acknowledge');
        check(a.matches.transfer[0].status === 'ongoing', 'its status is kept (ongoing)');
        const { op } = await merge(E, viewer);
        const s1 = await w.c.records.findOne({ matchId: 'm-s1' });
        check(op.status === 'completed' && s1.winningTeam === null && s1.upcoming === false, 'moved as an ongoing match');
    }
    {
        const w = await world({ sharedRoom: true });
        const ballsBefore = JSON.stringify(await w.c.balls.find({ matchId: 'room-w1' }).toArray());
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        check(a.warnings.some(x => x.code === 'SHARED_ROOM' && x.ack), 'room also used by another match → warned');
        const { op } = await merge(E, viewer);
        check(op.status === 'completed' && op.verification.passed, 'merged');
        check(JSON.stringify(await w.c.balls.find({ matchId: 'room-w1' }).toArray()) === ballsBefore, 'the shared ball log is left alone (it also holds another tournament\'s match)');
        const s1 = await w.c.records.findOne({ matchId: 'm-s1' });
        check(!JSON.stringify(s1).includes('PLAYER_B'), 'the scorecard itself is updated');
    }
    {
        const w = await world({ sourceTeamName: 'Royal Striker' });
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const tp = a.teams.pairs.find(t => t.type === 'similar');
        check(tp && tp.requiresManual && tp.sourceTeam === 'Royal Striker' && tp.destTeam === 'Royal Strikers', '"Royal Striker" ~ "Royal Strikers" flagged for review');
        const jc = a.players.candidates.find(c => c.dest.name === 'Jeeth');
        check(jc && jc.type === 'ambiguous', 'until then, the teams count as different (Jeeth: needs review)');
        const decided = (x) => { const d = defaults(x); d.teams[tp.pairId] = { same: true }; return d; };
        const a2 = await E.analyze(viewer, { source: sRef, dest: dRef, decisions: decided(a) });
        const jc2 = a2.players.candidates.find(c => c.dest.name === 'Jeeth');
        check(jc2 && jc2.type === 'exact', 'same team confirmed → Jeeth becomes a high-confidence pair');
        const { op } = await merge(E, viewer, (x) => {
            const d = decided(x);
            x.players.candidates.forEach(c => { if (!c.requiresManual) d.players[c.pairId] = { same: true, keep: 'dest' }; });
            return d;
        });
        const s1 = await w.c.records.findOne({ matchId: 'm-s1' });
        check(op.status === 'completed' && s1.teamB.name === 'Royal Strikers' && /ROYAL STRIKERS|THUNDER XI/.test(s1.resultText), 'team renamed in the moved match (result line too)');
        const t = S.computePointsTable(await w.c.records.find({ ownerUid: W, leagueKey: DKEY }).toArray());
        check(t.find(r => r.team === 'Royal Strikers').played === 3 && !t.some(r => r.team === 'Royal Striker'), 'one Royal Strikers row with 3 matches');
    }

    // ---------------------------------------------------------------
    section('Shared ID: two different players are never made one');
    {
        // a scorer left Harsh Rane's ID on Atharva Kale's innings in one
        // destination match (renamed mid-match) — the production case
        const mem = new MemoryDb();
        const c = F.collections(mem);
        await F.indexes(c);
        const harsh = P('HARSH RANE', 'p-harsh');
        const dyp = (athId) => team('DY PATIL SA', 'DYP', 'team-dyp', [harsh, P('ATHARVA KALE', athId), P('SHASHANK SINGH', 'p-shash'), P('SURAJ SHINDE', 'p-suraj'), P('ALIM SHAIKH', 'p-alim')]);
        const parel = team('PAREL SPORTING CLUB', 'PSC', 'team-psc', [P('ROHIT SHUKLA', 'p-rohit'), P('GARV JAIN', 'p-garv'), P('JAI CHOUGULE', 'p-jai'), P('VEER M', 'p-veer'), P('OM K', 'p-omk')]);
        const apollo = team('APOLLO CRICKET CLUB', 'ACC', 'team-acc', [P('YASH SINGH', 'p-yashs'), P('RAJ P', 'p-rajp'), P('KIRAN D', 'p-kiran'), P('AMOL T', 'p-amol'), P('NEEL S', 'p-neel')]);
        for (const t of [dyp('p-ath'), parel, apollo]) for (const pl of t.players) await F.addProfile(c, W, pl.id, pl.name);
        await F.addLeague(c, { ownerUid: W, leagueKey: DKEY, name: 'Summer Cup 2026', token: 'tokD', teams: [] });
        await F.addLeague(c, { ownerUid: W, leagueKey: SKEY, name: 'Summer Cup 2026 B', token: 'tokS', teams: [] });
        const d1 = await F.addMatch(c, { ownerUid: W, leagueKey: DKEY, matchId: 'm-d1', roomId: 'room-d1', teamA: dyp('p-harsh'), teamB: parel, seed: 0, date: '2026-10-10', overs: 4 });
        await F.addMatch(c, { ownerUid: W, leagueKey: DKEY, matchId: 'm-d2', roomId: 'room-d2', teamA: parel, teamB: dyp('p-ath'), seed: 5, date: '2026-10-12', overs: 4 });
        const s1 = await F.addMatch(c, { ownerUid: W, leagueKey: SKEY, matchId: 'm-s1', roomId: 'room-s1', teamA: dyp('p-ath'), teamB: apollo, seed: 9, date: '2026-10-11', overs: 4 });
        const w = { mem, c };
        const d1Before = JSON.stringify(d1.rec);
        const ballsBefore = JSON.stringify(await c.balls.find({ matchId: 'room-d1' }).toArray());
        const playersBefore = JSON.stringify(await c.players.find({}).toArray());
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        check(!a.players.candidates.some(x => !x.requiresManual && [x.dest.name, x.source.name].includes('HARSH RANE') && [x.dest.name, x.source.name].includes('ATHARVA KALE')), 'Harsh Rane / Atharva Kale are never offered as one player by default');
        const { op } = await merge(E, viewer);
        check(op.status === 'completed' && op.verification.passed, 'merge completed and verified (' + op.status + ')');
        check(op.verification.checks.some(x => x.id === 'players-apart' && x.ok), 'verification includes "different players keep their own names"');
        check(JSON.stringify(await c.records.findOne({ matchId: 'm-d1' })) === d1Before, 'the destination match with the shared ID is untouched (Atharva Kale keeps his 93)');
        check(JSON.stringify(await c.balls.find({ matchId: 'room-d1' }).toArray()) === ballsBefore, '… and so is its ball-by-ball');
        const ms1 = await c.records.findOne({ matchId: 'm-s1' });
        const names = (rec) => ['A', 'B'].flatMap(sd => rec.battingCard[sd].map(r => r.name)).join('|');
        check(ms1.leagueKey === DKEY && names(ms1) === names(s1.rec), 'the moved match keeps every batter\'s own name');
        check(JSON.stringify(await c.players.find({}).toArray()) === playersBefore, 'no player profile linked to another');
        const lb = S.computeLeaderboards(await c.records.find({ ownerUid: W, leagueKey: DKEY }).toArray()).topRuns;
        check(lb.filter(r => r.name === 'ATHARVA KALE').length === 1 && lb.filter(r => r.name === 'HARSH RANE').length === 1, 'leaderboard: Atharva Kale and Harsh Rane are separate rows');
    }
    {
        // same ID, different names → a manual review with no default
        const w = await world({ sourceJeeth: P('Jeeth C', 'PLAYER_A') });
        const E = engine(w);
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const jc = a.players.candidates.find(x => x.dest.name === 'Jeeth');
        check(jc && jc.type === 'linked' && jc.requiresManual && jc.recommended === null, '"Jeeth" / "Jeeth C" on one ID: needs review, nothing pre-selected');
        const { op } = await merge(E, viewer);
        check(op.status === 'completed' && (await w.c.records.findOne({ matchId: 'm-s1' })).battingCard.B.concat((await w.c.records.findOne({ matchId: 'm-s1' })).bowlingCard.B).some(r => r.name === 'Jeeth C'), 'left as different players, "Jeeth C" keeps its name');
    }
    {
        const I = TM._internals;
        const mm = I.hydrate({ canon: [{ id: 'X', name: 'Jeeth', key: 'jeeth' }], ids: [['X', 0], ['Y', 0]], A: [['jeeth', 0], ['jeeth c', 0]], B: [], names: { A: [], B: [] } });
        check(I.resolveRef(mm, 'A', 'Jeeth C', ['Y'], pk) && I.resolveRef(mm, 'A', null, ['Y'], pk), 'an id resolves for the player\'s own names (or no name)');
        check(I.resolveRef(mm, 'A', 'Harsh Rane', ['X'], pk) === null, 'an id carried by a different name is never followed');
        const rec = { battingCard: { A: [{ name: 'Harsh Rane' }, { name: 'Atharva Kale' }], B: [] }, bowlingCard: { A: [], B: [] } };
        const bad = { battingCard: { A: [{ name: 'Harsh Rane' }, { name: 'Harsh Rane' }], B: [] }, bowlingCard: { A: [], B: [] } };
        check(I.collapsedNames(rec, bad, null, pk) && !I.collapsedNames(rec, rec, null, pk), 'two batters under one name is caught');
    }

    // ---------------------------------------------------------------
    section('Undo the player changes of a finished merge');
    {
        const w = await world({ panelState: true });
        const before = {
            d1: JSON.stringify(await w.c.records.findOne({ matchId: 'm-d1' })), d2: JSON.stringify(await w.c.records.findOne({ matchId: 'm-d2' })),
            s1: await w.c.records.findOne({ matchId: 'm-s1' }),
            balls: JSON.stringify(await w.c.balls.find({}).toArray()), clips: JSON.stringify(await w.c.clips.find({}).toArray()),
            players: JSON.stringify(await w.c.players.find({}).toArray())
        };
        const E = engine(w);
        const { op } = await merge(E, viewer);
        check(op.status === 'completed' && op.counters.playersUnified === 1 && op.canUndoPlayers, 'merged with Jeeth made one player → undo offered');
        const h = await E.history(viewer);
        check(h[0].canUndoPlayers && h[0].decisions.players.some(x => x.dest === 'Jeeth' && x.keptId === 'PLAYER_A'), 'history shows which players were made one');
        check((await expectReject(E.undoPlayers(USERS.other, op.opId), 403)).ok, 'another account cannot undo');
        // an edit after the merge is never overwritten
        const edited = await w.c.balls.findOne({ matchId: 'room-s1', strikerPlayerId: 'PLAYER_A' });
        await w.c.balls.updateOne({ _id: edited._id }, { $set: { strikerPlayerId: 'PLAYER_EDIT' } });
        const res = await E.undoPlayers(viewer, op.opId);
        const u = res.playersUndo;
        check(u && u.state === 'done' && u.restored.records >= 1 && u.restored.balls > 0 && u.restored.clips > 0, `undone (${JSON.stringify(u && u.restored)})`);
        check(u.conflicts.length === 1 && /edited after the merge/.test(u.conflicts[0]), 'the delivery edited after the merge is reported…');
        check(JSON.stringify(await w.c.balls.findOne({ _id: edited._id })) === JSON.stringify(Object.assign({}, edited, { strikerPlayerId: 'PLAYER_EDIT' })), '… and left exactly as edited (not half undone)');
        check(JSON.stringify(await w.c.records.findOne({ matchId: 'm-d1' })) === before.d1 && JSON.stringify(await w.c.records.findOne({ matchId: 'm-d2' })) === before.d2, 'destination matches exactly as before the merge');
        const s1 = await w.c.records.findOne({ matchId: 'm-s1' });
        check(JSON.stringify(s1) === JSON.stringify(Object.assign({}, before.s1, { leagueKey: DKEY })), 'the moved match: its own players back, still in the destination');
        const ballsNow = (await w.c.balls.find({}).toArray()).filter(b => String(b._id) !== String(edited._id));
        const ballsWas = JSON.parse(before.balls).filter(b => String(b._id) !== String(edited._id));
        check(JSON.stringify(ballsNow) === JSON.stringify(ballsWas), 'every other delivery exactly as before');
        check(JSON.stringify(await w.c.clips.find({}).toArray()) === before.clips, 'every clip exactly as before (media untouched)');
        check(JSON.stringify(await w.c.players.find({}).toArray()).replace(/"updatedAt":\d+/g, '') === before.players.replace(/"updatedAt":\d+/g, ''), 'player profiles separated again');
        check((await w.c.records.countDocuments({ ownerUid: W, leagueKey: DKEY })) === 3 && !(await w.c.leagues.findOne({ ownerUid: W, leagueKey: SKEY })), 'the merge itself stays: 3 matches, source still gone');
        check((await w.c.locks.countDocuments({})) === 0, 'no lock left behind');
        check((await w.c.audits.find({}).toArray()).some(x => x.action === 'Tournament merge player changes undone'), 'audit log entry written');
        const again = await E.undoPlayers(viewer, op.opId);
        check(again.playersUndo.state === 'done' && !again.canUndoPlayers && JSON.stringify(again.playersUndo.restored) === JSON.stringify(u.restored), 'running it again changes nothing');
    }
    {
        const w = await world();
        const E = engine(w, { autoRun: false, failAfterStage: 'transferring' });
        const a = await E.analyze(viewer, { source: sRef, dest: dRef });
        const decisions = defaults(a);
        const a2 = await E.analyze(viewer, { source: sRef, dest: dRef, decisions });
        const r = await E.execute(viewer, { source: sRef, dest: dRef, decisions, fingerprint: a2.fingerprint, idempotencyKey: 'u1', confirm: { deleteSource: true, typedName: a2.source.name } });
        check((await expectReject(E.undoPlayers(viewer, r.opId), 409)).ok, 'an unfinished merge is rolled back, not "undone players"');
    }

    // ---------------------------------------------------------------
    section('History, op view');
    {
        const w = await world();
        const E = engine(w);
        await merge(E, viewer);
        const h = await E.history(viewer);
        check(h.length === 1 && h[0].status === 'completed' && h[0].source.displayName === 'Summer Cup 2026 B' && h[0].counters.matchesMoved === 1, 'history lists the merge with its counts');
        const hOwner = await E.history(USERS.owner);
        check(hOwner.length === 1, 'the owner sees it too');
        const view = await E.getOp(viewer, h[0].opId);
        check(view.stages.analyzing.state === 'done' && view.stages.verifying.state === 'done' && view.stages.completed.state === 'done', 'every stage reported done, in order');
        check(!JSON.stringify(view).match(/idToken|Bearer/i), 'no tokens stored in the merge record');
    }

    // ---------------------------------------------------------------
    section('Pure helpers');
    {
        const I = TM._internals;
        check(I.similarNames('jeeth', 'jeeth chhaya') && I.similarNames('r sharma', 'rohit sharma') && I.similarNames('rohit sharmma', 'rohit sharma'), 'similar: surname added, initial, one-letter typo');
        check(!I.similarNames('rahul', 'rahim') && !I.similarNames('amit shah', 'sumit shah') && !I.similarNames('dev', 'om'), 'different people are not flagged (rahul / rahim, amit shah / sumit shah)');
        check(I.similarNames('suryakumar yadhav', 'suryakumar yadav') && I.similarNames('bhuvneshwar kumaar', 'bhuvaneshwar kumar'), 'long names: up to two letters apart');
        check(I.replaceNames('c Rahul b Jeeth C', [['Jeeth C', 'Jeeth']], ['Rahul']) === 'c Rahul b Jeeth', 'dismissal line renamed');
        check(I.replaceNames('c Jeeth Chhaya b Jeeth', [['Jeeth', 'Jeeth Chhaya']], ['Jeeth Chhaya']) === 'c Jeeth Chhaya b Jeeth Chhaya', 'a longer name is never mistaken for a shorter one');
        check(I.replaceNames('MUMBAI INDIAN WON BY 5 RUNS', [['Mumbai Indian', 'Mumbai Indians']], []) === 'MUMBAI INDIANS WON BY 5 RUNS', 'capitals kept');
        check(I.replaceNames('Jeethu b Jeeth', [['Jeeth', 'J. Patel']], []) === 'Jeethu b J. Patel', 'whole words only');
    }

    console.log(`\n${passes} passed, ${fails.length} failed`);
    if (fails.length) { console.log('\nFAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
