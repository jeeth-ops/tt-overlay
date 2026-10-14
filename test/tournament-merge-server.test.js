// 🔀 Merge Tournaments over HTTP — boots the REAL server.js against an
// in-memory MongoDB (test/mongo-memory.js) and a stand-in for Firebase Admin
// (ID tokens → accounts), then checks:
//   J  only chhayajeeth@gmail.com / workallsportslive@gmail.com get in —
//      no token 401, a bad token 401, any other account 403, an unverified
//      email 403 — on every merge route, enforced by the server
//   the whole flow over HTTP: list → analyze → execute → progress → done
//   cross-page: the destination's public page has every match, one Jeeth on
//      the leaderboard; the source's old links (API + page + match page) lead
//      to the destination; a private destination stays invisible to others
//   L  a scoring laptop still on the old tournament: its live ping lands on
//      the destination, the deleted tournament is not re-created; normal
//      saves keep working
//   locks: a merge cut off by a restart keeps the source locked (saves,
//      deletes, live pings → 423) until it is rolled back
//
// Run:  node test/tournament-merge-server.test.js
const F = require('./merge-fixtures.js');
const { P, USERS } = F;

const fails = [];
let passes = 0;
const check = (ok, msg) => { if (ok) passes++; else fails.push(msg); console.log(`  ${ok ? '✓' : '✗'} ${msg}`); };
const section = (t) => console.log('\n' + t);

const { bootServer } = require('./merge-server-boot.js');
let req = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const W = USERS.work.uid;
const O = USERS.owner.uid;
async function seed(c) {
    const RS = (j) => ({ name: 'Royal Strikers', short: 'RS', teamId: 'team-rs', players: [j, P('Rahul Patil', 'p-rahul'), P('Amit Shah', 'p-amit'), P('Kunal Rao', 'p-kunal'), P('Sameer Khan', 'p-sameer')], bowlers: [j, P('Sameer Khan', 'p-sameer')] });
    const TX = () => ({ name: 'Thunder XI', short: 'TX', teamId: 'team-tx', players: [P('Vikram Singh', 'p-vikram'), P('Nikhil Jain', 'p-nikhil'), P('Arjun Mehta', 'p-arjun'), P('Dev Sharma', 'p-dev'), P('Om Prakash', 'p-om')] });
    await F.addProfile(c, W, 'PLAYER_A', 'Jeeth');
    for (const p of [...RS(P('x', 'x')).players.slice(1), ...TX().players]) await F.addProfile(c, W, p.id, p.name);
    const infoTeams = [{ name: 'Royal Strikers', short: 'RS', color: '#123456', teamId: 'team-rs', logoUrl: '' }, { name: 'Thunder XI', short: 'TX', color: '#654321', teamId: 'team-tx', logoUrl: '' }];
    await F.addLeague(c, { ownerUid: W, leagueKey: 'summer cup 2026', name: 'Summer Cup 2026', token: 'tokD', teams: infoTeams });
    await F.addLeague(c, { ownerUid: W, leagueKey: 'summer cup 2026 b', name: 'Summer Cup 2026 B', token: 'tokS', teams: infoTeams });
    await F.addMatch(c, { ownerUid: W, leagueKey: 'summer cup 2026', matchId: 'm-d1', roomId: 'room-d1', teamA: RS(P('Jeeth', 'PLAYER_A')), teamB: TX(), seed: 0 });
    await F.addMatch(c, { ownerUid: W, leagueKey: 'summer cup 2026', matchId: 'm-d2', roomId: 'room-d2', teamA: TX(), teamB: RS(P('Jeeth', 'PLAYER_A')), seed: 4 });
    await F.addMatch(c, { ownerUid: W, leagueKey: 'summer cup 2026 b', matchId: 'm-s1', roomId: 'room-s1', teamA: RS(P('Jeeth', 'PLAYER_B')), teamB: TX(), seed: 9 });
    // the owner's private pair (private destination → old links stay hidden)
    await F.addLeague(c, { ownerUid: O, leagueKey: 'private a', name: 'Private A', token: 'tokPA' });
    await F.addLeague(c, { ownerUid: O, leagueKey: 'private b', name: 'Private B', token: 'tokPB' });
    await F.addMatch(c, { ownerUid: O, leagueKey: 'private a', matchId: 'm-pa', roomId: 'room-pa', teamA: TX(), teamB: RS(P('Jeeth', 'PLAYER_A')), seed: 2 });
    await F.addMatch(c, { ownerUid: O, leagueKey: 'private b', matchId: 'm-pb', roomId: 'room-pb', teamA: TX(), teamB: RS(P('Jeeth', 'PLAYER_A')), seed: 6 });
    // a merge cut off by a restart (it holds its locks until resolved)
    await F.addLeague(c, { ownerUid: W, leagueKey: 'lock src', name: 'Lock Src', token: 'tokLS' });
    await F.addLeague(c, { ownerUid: W, leagueKey: 'lock dst', name: 'Lock Dst', token: 'tokLD' });
    await c.merges.insertOne({ _id: 'tm_seeded', status: 'running', stage: 'transferring', ownerUid: W, initiatedBy: USERS.work.email, initiatedUid: W,
        source: { leagueKey: 'lock src', displayName: 'Lock Src', publicToken: 'tokLS' }, dest: { leagueKey: 'lock dst', displayName: 'Lock Dst', publicToken: 'tokLD' },
        plan: { entries: [], destEntries: [{ matchId: 'm-rw' }], profiles: [], teamsAppend: [], destMatchIdsBefore: [], expectedClipCounts: {} },
        stages: {}, counters: {}, createdAt: 1, updatedAt: 1 });
    await c.locks.insertOne({ _id: `${W}::lock src`, opId: 'tm_seeded', role: 'source', matchIds: [] });
    await c.locks.insertOne({ _id: `${W}::lock dst`, opId: 'tm_seeded', role: 'dest', matchIds: ['m-rw'] });

}

(async () => {
    let c;
    try { const s = await bootServer(seed); c = s.c; req = s.req; check(true, 'server.js boots against the in-memory database'); }
    catch (e) { check(false, 'server.js boots against the in-memory database'); console.log(e); process.exit(1); }

    // ---------------------------------------------------------------
    section('J: who may use the merge routes (server-side)');
    {
        const routes = [['GET', '/api/tournament-merge/access'], ['GET', '/api/tournament-merge/tournaments'], ['POST', '/api/tournament-merge/analyze'],
            ['POST', '/api/tournament-merge/execute'], ['GET', '/api/tournament-merge/history'], ['GET', '/api/tournament-merge/ops/tm_seeded'], ['POST', '/api/tournament-merge/ops/tm_seeded/rollback']];
        const results = [];
        for (const [m, u] of routes) {
            results.push(['none', (await req(m, u, {}, null)).status]);
            results.push(['bad', (await req(m, u, {}, 'tok-bad')).status]);
            results.push(['other', (await req(m, u, {}, 'tok-other')).status]);
            results.push(['vinit', (await req(m, u, {}, 'tok-vinit')).status]);
            results.push(['unverified', (await req(m, u, {}, 'tok-unverified')).status]);
        }
        check(results.filter(r => r[0] === 'none' || r[0] === 'bad').every(r => r[1] === 401), 'no sign-in / unverifiable sign-in → 401 on all 7 routes');
        check(results.filter(r => r[0] === 'other' || r[0] === 'vinit' || r[0] === 'unverified').every(r => r[1] === 403), 'any other account (another authorized creator too), or an unverified email → 403 on all 7 routes');
        check((await c.merges.countDocuments({})) === 1 && (await c.locks.countDocuments({})) === 2, '… and none of them changed anything');
        const a1 = await req('GET', '/api/tournament-merge/access', null, 'tok-owner');
        const a2 = await req('GET', '/api/tournament-merge/access', null, 'tok-work');
        check(a1.json.allowed && a1.json.email === 'chhayajeeth@gmail.com' && a2.json.allowed && a2.json.email === 'workallsportslive@gmail.com', 'chhayajeeth@gmail.com and workallsportslive@gmail.com get in');
        const spoof = await req('GET', '/api/tournament-merge/access?uid=u-work&email=workallsportslive@gmail.com', null, 'tok-other');
        check(spoof.status === 403, 'a uid / email sent by the client is never trusted');
        const page = await req('GET', '/merge-tournaments');
        check(page.status === 200 && /Merge Tournaments/.test(page.text) && /no-store/.test(page.headers['cache-control'] || ''), 'the page shell is served (no data in it), never cached');
    }

    // ---------------------------------------------------------------
    section('The whole flow over HTTP (workallsportslive@gmail.com)');
    let opId = null;
    {
        const list = await req('GET', '/api/tournament-merge/tournaments', null, 'tok-work');
        check(list.status === 200 && list.json.tournaments.some(t => t.leagueKey === 'summer cup 2026') && !list.json.tournaments.some(t => t.ownerUid === O), 'tournament list: own tournaments only');
        const sum = await req('GET', '/api/tournament-merge/tournaments/' + W + '/summer%20cup%202026', null, 'tok-work');
        check(sum.status === 200 && sum.json.tournament.matches === 2 && sum.json.tournament.teams === 2 && sum.json.tournament.players === 10, 'tournament card: 2 matches, 2 teams, 10 players');
        const body = { source: { ownerUid: W, leagueKey: 'summer cup 2026 b' }, dest: { ownerUid: W, leagueKey: 'summer cup 2026' } };
        const an = await req('POST', '/api/tournament-merge/analyze', body, 'tok-work');
        check(an.status === 200 && an.json.ok && an.json.players.candidates.length === 1, 'analyze: one player pair to confirm (Jeeth)');
        const jc = an.json.players.candidates[0];
        const decisions = { players: { [jc.pairId]: { same: true, keep: 'dest' } }, acknowledged: an.json.warnings.filter(w => w.ack).map(w => w.code) };
        const an2 = await req('POST', '/api/tournament-merge/analyze', Object.assign({ decisions }, body), 'tok-work');
        const noConfirm = await req('POST', '/api/tournament-merge/execute', Object.assign({ decisions, fingerprint: an2.json.fingerprint, idempotencyKey: 'h-1', confirm: { deleteSource: false } }, body), 'tok-work');
        check(noConfirm.status === 400 && (await c.leagues.findOne({ leagueKey: 'summer cup 2026 b' })), 'execute without the deletion confirmation → 400, nothing done');
        const ex = await req('POST', '/api/tournament-merge/execute', Object.assign({ decisions, fingerprint: an2.json.fingerprint, idempotencyKey: 'h-2', confirm: { deleteSource: true, typedName: 'summer cup 2026 b' } }, body), 'tok-work');
        check(ex.status === 202 && ex.json.opId, 'execute → 202 with the merge id');
        opId = ex.json.opId;
        let op = null;
        const seen = new Set();
        for (let i = 0; i < 400; i++) {
            const r = await req('GET', '/api/tournament-merge/ops/' + opId, null, 'tok-work');
            op = r.json.op;
            seen.add(op.stage);
            if (op.status !== 'running') break;
            await sleep(5);
        }
        check(op && op.status === 'completed' && op.verification.passed, 'progress followed to "completed", verified');
        check(['analyzing', 'validating', 'transferring', 'recalculating', 'verifying', 'completed'].every(s => op.stages[s].state === 'done'), 'real stages, each reported done');
        const ownerView = await req('GET', '/api/tournament-merge/ops/' + opId, null, 'tok-owner');
        check(ownerView.status === 200, 'the owner can open it too');
        const vinitView = await req('GET', '/api/tournament-merge/ops/' + opId, null, 'tok-vinit');
        check(vinitView.status === 403, '… nobody else');
        const hist = await req('GET', '/api/tournament-merge/history', null, 'tok-work');
        check(hist.status === 200 && hist.json.merges.some(m => m.opId === opId && m.status === 'completed'), 'history lists it');
        const audit = await c.audits.find({ action: 'Tournament merge' }).toArray();
        check(audit.length === 1 && audit[0].performedBy === 'workallsportslive@gmail.com' && audit[0].mergeOpId === opId && !JSON.stringify(audit[0]).includes('tok-'), 'one audit-log entry, no token in it');
    }

    // ---------------------------------------------------------------
    section('Cross-page consistency after the merge');
    {
        const pub = await req('GET', '/api/public/tournament/tokD');
        check(pub.status === 200 && pub.json.matches.length === 3, 'destination page: all 3 matches');
        const lb = pub.json.leaderboards.topRuns.filter(r => r.name.toLowerCase() === 'jeeth');
        check(lb.length === 1 && lb[0].innings === 3, 'leaderboard: one Jeeth, 3 innings');
        check(pub.json.pointsTable.reduce((n, r) => n + r.played, 0) === 6, 'points table: 3 matches × 2 teams, nothing twice');
        const m = await req('GET', '/api/public/tournament/tokD/match/m-s1');
        check(m.status === 200 && m.json.match && !JSON.stringify(m.json.match).includes('PLAYER_B'), 'moved match scorecard opens under the destination, PLAYER_A only');
        const balls = await req('GET', '/api/public/tournament/tokD/match/m-s1/balls');
        check(balls.status === 200 && balls.json.balls.length > 0, 'its ball-by-ball opens too');
        const clips = await req('GET', '/api/clips/match/room-s1');
        check(clips.status === 200 && (clips.json.clips || []).length > 0 && clips.json.clips.every(cl => cl.playbackUrl || cl.watchUrl), 'its clips still play (same media)');
        const old = await req('GET', '/api/public/tournament/tokS');
        check(old.status === 404 && old.json.movedTo === 'tokD', 'old source link (API) → points at the destination');
        const oldPage = await req('GET', '/score/tournament/tokS');
        check(oldPage.status === 302 && oldPage.headers.location === '/score/tournament/tokD', 'old source page → redirected to the destination');
        const oldMatch = await req('GET', '/score/tournament/tokS/match/m-s1');
        check(oldMatch.status === 302 && /token=tokD/.test(oldMatch.headers.location) && /match=m-s1/.test(oldMatch.headers.location), 'old match page → the same match in the destination');
        const list = await req('GET', '/api/public/tournaments');
        check(list.json.tournaments.some(t => t.token === 'tokD') && !list.json.tournaments.some(t => t.token === 'tokS'), 'tournaments list: destination only');
    }

    // ---------------------------------------------------------------
    section('L: scoring laptops and normal saves after the merge');
    {
        const ping = await req('POST', '/api/league/' + encodeURIComponent('Summer Cup 2026 B') + '/live-status', { uid: W, matchId: 'm-s1', roomId: 'room-s1', active: true });
        check(ping.status === 200, 'a laptop still on the old tournament pings live-status → OK');
        const d = await c.leagues.findOne({ ownerUid: W, leagueKey: 'summer cup 2026' });
        check((d.liveMatches || []).some(x => x.matchId === 'm-s1'), '… and "Live now" shows on the destination');
        check(!(await c.leagues.findOne({ ownerUid: W, leagueKey: 'summer cup 2026 b' })), 'the deleted tournament is not re-created');
        await req('POST', '/api/league/' + encodeURIComponent('Summer Cup 2026 B') + '/live-status', { uid: W, matchId: 'm-s1', roomId: 'room-s1', active: false });
        const d2 = await c.leagues.findOne({ ownerUid: W, leagueKey: 'summer cup 2026' });
        check(!(d2.liveMatches || []).some(x => x.matchId === 'm-s1'), 'its "match ended" ping clears it there too');
        const stale = await req('POST', '/api/league/' + encodeURIComponent('Summer Cup 2026 B') + '/match', { uid: W, matchId: 'm-s1', roomId: 'room-s1', teamA: { name: 'Royal Strikers' }, teamB: { name: 'Thunder XI' } });
        check(stale.status === 409 && stale.json.code === 'MATCH_IN_OTHER_TOURNAMENT', 'a stale full save of the moved match is refused (it lives in the destination now)');
        const fresh = await req('POST', '/api/league/' + encodeURIComponent('Summer Cup 2026') + '/match', { uid: W, matchId: 'm-new', roomId: 'room-new', teamA: { name: 'Royal Strikers' }, teamB: { name: 'Thunder XI' }, upcoming: true });
        check(fresh.status === 200 && fresh.json.matches.length === 4, 'a normal save into the destination works');
    }

    // ---------------------------------------------------------------
    section('Undo the player changes of the finished merge (over HTTP)');
    {
        const url = '/api/tournament-merge/ops/' + opId + '/undo-players';
        check((await req('POST', url, {}, null)).status === 401 && (await req('POST', url, {}, 'tok-other')).status === 403 && (await req('POST', url, {}, 'tok-vinit')).status === 403, 'no sign-in → 401; any other account → 403');
        const h = await req('GET', '/api/tournament-merge/history', null, 'tok-work');
        check(h.json.merges.find(m => m.opId === opId).canUndoPlayers === true, 'history offers it (Jeeth was made one player)');
        const u = await req('POST', url, {}, 'tok-work');
        check(u.status === 200 && u.json.op.playersUndo.state === 'done' && u.json.op.canUndoPlayers === false, 'undone → 200');
        const m = await req('GET', '/api/public/tournament/tokD/match/m-s1');
        check(m.status === 200 && JSON.stringify(m.json.match).includes('PLAYER_B'), 'the moved match has its own player ID back, still under the destination');
        const pub = await req('GET', '/api/public/tournament/tokD');
        check(pub.status === 200 && pub.json.matches.length === 4, 'the destination keeps every match');
        const again = await req('POST', url, {}, 'tok-work');
        check(again.status === 200 && again.json.op.playersUndo.state === 'done', 'a second press changes nothing');
        const audit = await c.audits.find({ action: 'Tournament merge player changes undone' }).toArray();
        check(audit.length === 1 && audit[0].performedBy === 'workallsportslive@gmail.com', 'one audit-log entry');
    }

    // ---------------------------------------------------------------
    section('A private destination stays private');
    {
        const body = { source: { ownerUid: O, leagueKey: 'private b' }, dest: { ownerUid: O, leagueKey: 'private a' } };
        const an = await req('POST', '/api/tournament-merge/analyze', body, 'tok-owner');
        const decisions = { players: {}, acknowledged: an.json.warnings.filter(w => w.ack).map(w => w.code) };
        an.json.players.candidates.forEach(cnd => { decisions.players[cnd.pairId] = cnd.requiresManual ? { same: false } : { same: true, keep: 'dest' }; });
        const an2 = await req('POST', '/api/tournament-merge/analyze', Object.assign({ decisions }, body), 'tok-owner');
        const ex = await req('POST', '/api/tournament-merge/execute', Object.assign({ decisions, fingerprint: an2.json.fingerprint, idempotencyKey: 'p-1', confirm: { deleteSource: true, typedName: 'Private B' } }, body), 'tok-owner');
        let op;
        for (let i = 0; i < 400; i++) { op = (await req('GET', '/api/tournament-merge/ops/' + ex.json.opId, null, 'tok-owner')).json.op; if (op.status !== 'running') break; await sleep(5); }
        check(op.status === 'completed', 'owner merges two private tournaments');
        const anon = await req('GET', '/api/public/tournament/tokPB');
        check(anon.status === 404 && !anon.json.movedTo, 'an anonymous visitor of the old link learns nothing');
        const anonPage = await req('GET', '/score/tournament/tokPB');
        check(anonPage.status === 200, '… and the old page is not redirected for them');
        const ownerOld = await req('GET', '/api/public/tournament/tokPB', null, 'tok-owner');
        check(ownerOld.status === 404 && ownerOld.json.movedTo === 'tokPA', 'the owner is pointed to the destination');
        const privList = await req('GET', '/api/public/tournaments');
        check(!privList.json.tournaments.some(t => t.token === 'tokPA'), 'the destination is still not public');
    }

    // ---------------------------------------------------------------
    section('Locks: a merge cut off by a restart');
    {
        const op = await req('GET', '/api/tournament-merge/ops/tm_seeded', null, 'tok-work');
        check(op.status === 200 && op.json.op.status === 'interrupted' && op.json.op.canRollback, 'after the restart it is "interrupted" (resume / roll back offered)');
        const save = await req('POST', '/api/league/' + encodeURIComponent('Lock Src') + '/match', { uid: W, matchId: 'm-x', roomId: 'room-x', teamA: { name: 'A' }, teamB: { name: 'B' } });
        check(save.status === 423 && save.json.code === 'TOURNAMENT_MERGE_IN_PROGRESS', 'saving into the locked source → 423');
        const del = await req('DELETE', '/api/league/' + encodeURIComponent('Lock Src') + '?uid=' + W);
        check(del.status === 423, 'deleting it → 423');
        const live = await req('POST', '/api/league/' + encodeURIComponent('Lock Src') + '/live-status', { uid: W, matchId: 'm-x', roomId: 'room-x', active: true });
        check(live.status === 423, 'a live ping on it → 423');
        const dOther = await req('POST', '/api/league/' + encodeURIComponent('Lock Dst') + '/match', { uid: W, matchId: 'm-other', roomId: 'room-o', teamA: { name: 'A' }, teamB: { name: 'B' }, upcoming: true });
        check(dOther.status === 200, 'the destination keeps working for matches the merge does not touch');
        const dRw = await req('POST', '/api/league/' + encodeURIComponent('Lock Dst') + '/match', { uid: W, matchId: 'm-rw', roomId: 'room-rw', teamA: { name: 'A' }, teamB: { name: 'B' } });
        check(dRw.status === 423, '… but not for a match the merge is rewriting');
        const info = await req('POST', '/api/league/' + encodeURIComponent('Lock Dst') + '/info', { uid: W, info: { teams: [] } });
        check(info.status === 423, 'destination settings edits wait too');
        const rb = await req('POST', '/api/tournament-merge/ops/tm_seeded/rollback', {}, 'tok-work');
        check(rb.status === 200 && rb.json.op.status === 'rolled_back', 'rolled back');
        const save2 = await req('POST', '/api/league/' + encodeURIComponent('Lock Src') + '/match', { uid: W, matchId: 'm-x', roomId: 'room-x', teamA: { name: 'A' }, teamB: { name: 'B' }, upcoming: true });
        check(save2.status === 200, 'then the source saves normally again');
    }

    console.log(`\n${passes} passed, ${fails.length} failed`);
    if (fails.length) { console.log('\nFAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
