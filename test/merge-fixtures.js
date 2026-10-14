// Realistic tournaments for the Merge Tournaments tests: matches are played
// ball by ball, and each saved scorecard is built from those balls by the
// REAL server.js rebuild (buildLiveCardsFromBallsArray) — so cards, ball log
// and clips always agree, exactly as they do in production.
const H = require('./cricket/server-harness.js');
const { ObjectId } = require('./mongo-memory.js');

// real server.js functions, extracted by name (never copied)
const NAMES = ['personName', 'playerKey', 'oversToFloat', 'fmtOversLike', 'isUpcomingRecord', 'playedMatches',
    'computePointsTable', 'computeLeaderboards', 'matchRecordFootprint', 'footprintTotalBalls',
    'deriveBallFacts', 'isSuperOverBall', 'buildLiveCardsFromBallsArray', 'effectiveIsPrivate'];
const S = new Function('isPrivateCreatorEmail', NAMES.map(n => H.grab(n)).join('\n') + '\nreturn {' + NAMES.join(',') + '};')(
    (e) => String(e || '').toLowerCase() === 'chhayajeeth@gmail.com');
const pk = S.playerKey;

const USERS = {
    owner: { email: 'chhayajeeth@gmail.com', uid: 'u-owner' },
    work: { email: 'workallsportslive@gmail.com', uid: 'u-work' },
    vinit: { email: 'vinitkrkr1@gmail.com', uid: 'u-vinit' },
    other: { email: 'someone@gmail.com', uid: 'u-other' }
};
const EMAIL_OF = Object.fromEntries(Object.values(USERS).map(u => [u.uid, u.email]));
const UID_OF = Object.fromEntries(Object.values(USERS).map(u => [u.email, u.uid]));

// the production indexes that matter to a merge (see connectMongo)
async function indexes(c) {
    await c.leagues.createIndex({ ownerUid: 1, leagueKey: 1 }, { unique: true });
    await c.leagues.createIndex({ publicToken: 1 }, { unique: true, sparse: true });
    await c.records.createIndex({ ownerUid: 1, leagueKey: 1, matchId: 1 }, { unique: true });
    await c.players.createIndex({ playerId: 1 }, { unique: true });
    await c.players.createIndex({ ownerUid: 1, nameKeys: 1 }, { unique: true });
    await c.balls.createIndex({ ballUid: 1 }, { unique: true, sparse: true });
    await c.clips.createIndex({ clipId: 1 }, { unique: true, sparse: true });
    await c.panelStates.createIndex({ matchId: 1 }, { unique: true });
    await c.merges.createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true });
}

function collections(mem) {
    return {
        leagues: mem.collection('leagues'), records: mem.collection('matchRecords'), balls: mem.collection('balls'),
        clips: mem.collection('clips'), players: mem.collection('players'), panelStates: mem.collection('matchPanelStates'),
        merges: mem.collection('tournamentMerges'), backups: mem.collection('tournamentMergeBackups'),
        locks: mem.collection('tournamentMergeLocks'), audits: mem.collection('auditLogs'), versions: mem.collection('matchRecordVersions')
    };
}

let seq = 0;
const PATTERN = ['1', '0', '4', 'W', '2', '6', '0', '1', 'Wd', '3', '0', '4', '1', 'W', '0', '2', '1', '6', '0', '1', '2', '4'];

// One played match: team A bats first, then B. players: [{ name, id }];
// bowlers / fielders come from the bowling side's `bowlers` list.
function playMatch(o) {
    const balls = [];
    let p = o.seed || 0;
    const play = (bat, bowl, inn) => {
        const batters = o['team' + bat].players;
        const bowlers = o['team' + bowl].bowlers || o['team' + bowl].players.slice(-2);
        const fielders = o['team' + bowl].players;
        let s = 0, ns = 1, next = 2, out = false;
        for (let over = 0; over < (o.overs || 3) && !out; over++) {
            const bowler = bowlers[over % bowlers.length];
            let legal = 0;
            while (legal < 6) {
                const kind = PATTERN[p++ % PATTERN.length];
                const st = batters[s], nst = batters[ns];
                const isLegal = kind !== 'Wd';
                const runs = kind === 'W' ? 0 : kind === 'Wd' ? 1 : Number(kind);
                let dismissal = null;
                if (kind === 'W') {
                    const f = fielders[(over + legal + p) % fielders.length];
                    dismissal = (p % 2 === 0)
                        ? { type: 'Caught', fielder: f.name, fielderId: f.id, batter: st.name, batterId: st.id }
                        : { type: 'Bowled', fielder: null, fielderId: null, batter: st.name, batterId: st.id };
                }
                const uid = `b${++seq}`;
                balls.push({
                    _id: new ObjectId(), matchId: o.roomId, ballUid: uid, ownerUid: o.ownerUid,
                    innings: inn, over, ballInOver: isLegal ? legal + 1 : legal, kind, runs, battingTeam: bat,
                    striker: st.name, strikerKey: pk(st.name), strikerPlayerId: st.id, strikerId: st.id,
                    nonStriker: nst.name, nonStrikerKey: pk(nst.name), nonStrikerPlayerId: nst.id, nonStrikerId: nst.id,
                    bowler: bowler.name, bowlerKey: pk(bowler.name), bowlerPlayerId: bowler.id, bowlerId: bowler.id,
                    dismissal,
                    dismissedPlayerKey: dismissal ? pk(st.name) : null, dismissedPlayerId: dismissal ? st.id : null,
                    dismissalFielderKey: dismissal && dismissal.fielder ? pk(dismissal.fielder) : null,
                    dismissalFielderPlayerId: dismissal && dismissal.fielderId ? dismissal.fielderId : null,
                    ...(kind === '4' || kind === '6' ? { shot: { zone: 'cover', x: 0.3, y: -0.5 } } : {}),
                    score: { runs: 0, wickets: 0 }, timestamp: 1700000000000 + seq
                });
                if (isLegal) legal++;
                if (kind === 'W') {
                    if (next >= batters.length) { out = true; break; }
                    s = next++;
                } else if (isLegal && runs % 2 === 1) { const t = s; s = ns; ns = t; }
            }
            const t = s; s = ns; ns = t;
        }
    };
    play('A', 'B', 1);
    play('B', 'A', 2);
    return balls;
}

function clipsFor(balls, o) {
    return balls.filter(b => b.kind === '4' || b.kind === '6' || b.dismissal).map(b => {
        const d = b.dismissal;
        return {
            _id: new ObjectId(), clipId: 'clip-' + b.ballUid, matchId: b.matchId, ownerUid: o.ownerUid,
            eventType: d ? 'WICKET' : (b.kind === '6' ? 'SIX' : 'FOUR'), deliveryId: b.ballUid,
            innings: b.innings, over: b.over, ballInOver: b.ballInOver, battingTeam: b.battingTeam, runs: b.runs,
            strikerName: b.striker, strikerKey: b.strikerKey, strikerPlayerId: b.strikerPlayerId,
            nonStrikerName: b.nonStriker, nonStrikerKey: b.nonStrikerKey, nonStrikerPlayerId: b.nonStrikerPlayerId,
            bowlerName: b.bowler, bowlerKey: b.bowlerKey, bowlerPlayerId: b.bowlerPlayerId,
            fielderName: d ? d.fielder : null, fielderKey: d && d.fielder ? pk(d.fielder) : null, fielderPlayerId: d ? d.fielderId : null,
            dismissedPlayerName: d ? d.batter : null, dismissedPlayerKey: d ? pk(d.batter) : null, dismissedPlayerId: d ? d.batterId : null,
            ballMeta: {
                striker: b.striker, strikerId: b.strikerId, nonStriker: b.nonStriker, nonStrikerId: b.nonStrikerId,
                bowler: b.bowler, bowlerId: b.bowlerId, innings: b.innings, over: b.over, ballInOver: b.ballInOver,
                battingTeam: b.battingTeam, deliveryId: b.ballUid, dismissal: d ? Object.assign({}, d) : null
            },
            ...(o.tagClips ? { tournamentMatchId: o.matchId, tournamentName: o.leagueName } : {}),
            r2Key: `clips/${b.matchId}/${b.ballUid}.mp4`, r2Url: `https://cdn.example.com/clips/${b.matchId}/${b.ballUid}.mp4`,
            r2PosterUrl: `https://cdn.example.com/posters/${b.ballUid}.jpg`,
            driveFileId: 'drive-' + b.ballUid, driveUrl: `https://drive.example.com/file/${b.ballUid}`,
            status: 'COMPLETE', r2Status: 'done', driveStatus: 'done', isHighlight: true, createdAt: b.timestamp
        };
    });
}

// The saved match record, built from its balls by the real server rebuild
// (plus what the panel adds: squads with player ids, ids on card rows, the
// innings archive and the result).
function recordFor(balls, o) {
    const cards = S.buildLiveCardsFromBallsArray(balls.map(b => Object.assign({}, b)));
    const idOf = (side, name) => { const p = o['team' + side].players.find(x => pk(x.name) === pk(name)); return p ? p.id : null; };
    const withIds = (rows, side) => rows.map(r => Object.assign({}, r, { id: idOf(side, r.name) }));
    const winner = cards.scoreA.runs > cards.scoreB.runs ? 'A' : cards.scoreB.runs > cards.scoreA.runs ? 'B' : 'TIE';
    const team = (t) => ({ name: t.name, short: t.short || '', color: t.color || '#123456', logoUrl: '', teamId: t.teamId || null });
    const squad = (t) => ({ players: t.players.map(p => Object.assign({ id: p.id, name: p.name, isXI: true }, p.hand ? { hand: p.hand } : {})), captainId: t.players[0].id, wkId: t.players[1].id });
    return {
        _id: new ObjectId(), ownerUid: o.ownerUid, leagueKey: o.leagueKey, matchId: o.matchId, roomId: o.roomId,
        matchNo: o.matchNo || null, matchTitle: o.matchTitle || '', matchDate: o.date || '2026-10-01', savedAt: (o.date || '2026-10-01') + 'T12:00:00.000Z',
        format: 'T20', upcoming: false, venue: 'Oval',
        teamA: team(o.teamA), teamB: team(o.teamB), squadA: squad(o.teamA), squadB: squad(o.teamB),
        battingCard: { A: withIds(cards.battingCard.A, 'A'), B: withIds(cards.battingCard.B, 'B') },
        bowlingCard: { A: withIds(cards.bowlingCard.A, 'A'), B: withIds(cards.bowlingCard.B, 'B') },
        scoreA: cards.scoreA, scoreB: cards.scoreB, extras: cards.extras, fallOfWickets: cards.fallOfWickets, partnerships: cards.partnerships,
        inningsArchive: [
            { no: 1, team: 'A', runs: cards.scoreA.runs, wickets: cards.scoreA.wickets, overs: cards.scoreA.overs },
            { no: 2, team: 'B', runs: cards.scoreB.runs, wickets: cards.scoreB.wickets, overs: cards.scoreB.overs }
        ],
        winningTeam: o.unfinished ? null : winner,
        resultText: o.unfinished ? null : (winner === 'TIE' ? 'MATCH TIED' : `${(winner === 'A' ? o.teamA : o.teamB).name.toUpperCase()} WON`)
    };
}

async function addMatch(c, o) {
    const balls = playMatch(o);
    const rec = recordFor(balls, o);
    const clips = clipsFor(balls, o);
    await c.records.insertOne(rec);
    for (const b of balls) await c.balls.insertOne(b);
    for (const cl of clips) await c.clips.insertOne(cl);
    if (o.panelState) await c.panelStates.insertOne({ matchId: o.matchId, state: { tournamentMatchId: o.matchId, battingCard: rec.battingCard, ballLog: [] }, updatedAt: 1 });
    return { rec, balls, clips };
}

async function addLeague(c, o) {
    const doc = {
        _id: new ObjectId(), ownerUid: o.ownerUid, leagueKey: o.leagueKey, displayName: o.name, sport: 'cricket',
        publicToken: o.token, createdBy: o.createdBy || EMAIL_OF[o.ownerUid], updatedAt: 1,
        info: o.info === null ? undefined : (o.info || { format: 'T20', overs: 20, venue: 'Oval', teams: o.teams || [] }),
        liveMatches: o.liveMatches || [],
        ...(o.visibilityOverride ? { visibilityOverride: o.visibilityOverride } : {})
    };
    await c.leagues.insertOne(doc);
    return doc;
}

async function addProfile(c, ownerUid, playerId, name, extraKeys) {
    await c.players.insertOne({ playerId, ownerUid, nameKeys: [pk(name), ...(extraKeys || [])], displayName: name, createdAt: 1, updatedAt: 1 });
}

const P = (name, id) => ({ name, id });

module.exports = { S, pk, USERS, EMAIL_OF, UID_OF, indexes, collections, playMatch, recordFor, clipsFor, addMatch, addLeague, addProfile, P, ObjectId };
