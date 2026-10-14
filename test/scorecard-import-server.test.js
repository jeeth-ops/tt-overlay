// 📷 Import Scorecard over HTTP — boots the REAL server.js against an
// in-memory MongoDB and a stand-in for Firebase Admin (ID tokens → accounts),
// with the REAL @anthropic-ai/sdk reading photos from a stand-in Messages API
// (ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL → test/fake-anthropic.js):
//
//   access   only chhayajeeth@gmail.com: no sign-in 401, a bad token 401, the
//            other accounts (even the tournament creators) 403, an unverified
//            email 403 — on every import route, enforced by the server
//   the page shell /import-scorecard is served (it holds no data)
//   photos   raw JPG / PNG uploads; not an image, too large, the same twice
//   reading  POST /read → 202, the job runs in the background; the request
//            Claude gets; a refused key reported in plain words; /config says
//            whether reading is switched on
//   saving   analyze → commit 201 → the same commit again 200 (one match)
//   the public tournament page and API: the match, the points table, one
//            leaderboard row per player, the copied commentary
//   ball-by-ball tools refuse an imported match (409 IMPORTED_SCORECARD)
//
// Run:  node test/scorecard-import-server.test.js
const http = require('http');
const { startFakeAnthropic } = require('./fake-anthropic.js');
const FX = require('./scorecard-import-fixtures.js');
const F = require('./merge-fixtures.js');

const fails = [];
let passes = 0;
const check = (ok, msg) => { if (ok) passes++; else fails.push(msg); console.log(`  ${ok ? '✓' : '✗'} ${msg}`); };
const section = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const W = FX.W, L = FX.LEAGUE, LK = encodeURIComponent(FX.LEAGUE);
const API = '/api/scorecard-import';

(async () => {
    let mode = 'ok';
    const fake = await startFakeAnthropic((body) => {
        if (mode === 'refused') return { status: 401, error: 'invalid x-api-key' };
        return FX.fakeClaude(body);
    });
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ANTHROPIC_BASE_URL = fake.url;
    const { bootServer } = require('./merge-server-boot.js');
    const { port, c, mem, req } = await bootServer(FX.seed);
    const raw = (method, url, buf, type, token) => new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: Object.assign({ 'Content-Type': type, 'Content-Length': buf.length }, token ? { Authorization: 'Bearer ' + token } : {}) }, (res) => {
            const parts = [];
            res.on('data', (ch) => parts.push(ch));
            res.on('end', () => { const b = Buffer.concat(parts); let json = null; try { json = JSON.parse(b.toString()); } catch (e) { /* bytes */ } resolve({ status: res.statusCode, json, body: b, headers: res.headers }); });
        });
        r.on('error', reject);
        r.write(buf);
        r.end();
    });
    const T = 'tok-owner';

    section('access: chhayajeeth@gmail.com only, checked by the server');
    let r = await req('GET', API + '/access');
    check(r.status === 401, 'no sign-in → 401');
    r = await req('GET', API + '/access', null, 'not-a-real-token');
    check(r.status === 401, 'a token that does not verify → 401');
    for (const who of ['tok-work', 'tok-vinit', 'tok-other']) {
        r = await req('GET', API + '/access', null, who);
        check(r.status === 403 && r.json && r.json.error === 'Access Denied', `${who.slice(4)} account → 403 (even a tournament creator)`);
    }
    r = await req('GET', API + '/access', null, 'tok-unverified');
    check(r.status === 403, 'an unverified email → 403');
    r = await req('GET', API + '/access', null, T);
    check(r.status === 200 && r.json.allowed === true && r.json.email === 'chhayajeeth@gmail.com', 'chhayajeeth@gmail.com → 200');
    const routes = [['GET', '/config'], ['GET', '/tournaments'], ['GET', `/tournaments/${W}/${LK}`], ['GET', '/drafts'], ['POST', '/drafts'], ['GET', '/drafts/sci_x'], ['PATCH', '/drafts/sci_x'], ['DELETE', '/drafts/sci_x'],
        ['PUT', '/drafts/sci_x/photos'], ['GET', '/drafts/sci_x/photos/ph_x'], ['POST', '/drafts/sci_x/read'], ['POST', '/drafts/sci_x/analyze'], ['POST', '/drafts/sci_x/commit'], ['GET', '/history']];
    let denied = 0, unauth = 0;
    for (const [m, p] of routes) {
        if ((await req(m, API + p, m === 'GET' || m === 'DELETE' ? null : {}, 'tok-work')).status === 403) denied++;
        if ((await req(m, API + p, m === 'GET' || m === 'DELETE' ? null : {})).status === 401) unauth++;
    }
    const up = await raw('POST', API + '/drafts/sci_x/photos?kind=scorecard&innings=1', FX.png(1), 'image/png', 'tok-work');
    check(denied === routes.length && up.status === 403, `every import route (${routes.length + 1}) refuses another account with 403`);
    check(unauth === routes.length, 'and refuses no sign-in with 401');
    check(await c.records.countDocuments({}) === 2 && await mem.collection('scorecardImports').countDocuments({}) === 0, 'nothing was created by the refused calls');

    section('the page');
    r = await req('GET', '/import-scorecard');
    check(r.status === 200 && /<title>Import Scorecard/.test(r.text) && /api\/scorecard-import/.test(r.text) && /no-store/.test(r.headers['cache-control'] || ''), 'the page shell is served (no data in it), never cached');
    r = await req('GET', '/scorecard-model.js');
    check(r.status === 200 && /normalizePlayerName/.test(r.text), 'the shared cricket rules load in the browser');

    section('config and tournaments');
    r = await req('GET', API + '/config', null, T);
    check(r.json.reader === true && r.json.model === 'claude-opus-5-5', 'reading with Claude is on (ANTHROPIC_API_KEY set)');
    delete process.env.ANTHROPIC_API_KEY;
    r = await req('GET', API + '/config', null, T);
    check(r.json.reader === false, 'and off without the key');
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    r = await req('GET', API + '/tournaments', null, T);
    const mca = (r.json.tournaments || []).find(t => t.leagueKey === L);
    check(mca && mca.token === 'tokM' && mca.matchCount === 1 && mca.format === 'Custom' && mca.overs === 10, 'tournaments listed with their format and match count');
    r = await req('GET', API + `/tournaments/${W}/${LK}`, null, T);
    check(r.status === 200 && r.json.teams.some(t => t.name === 'DY PATIL SA' && t.logoUrl === FX.LOGO), 'a tournament\'s teams, with their logos (for the team picker)');

    section('photos');
    r = await req('POST', API + '/drafts', { ownerUid: W, leagueKey: L }, T);
    check(r.status === 201 && /^sci_/.test(r.json.draft.draftId), 'an import starts');
    const id = r.json.draft.draftId;
    r = await raw('POST', API + `/drafts/${id}/photos?kind=scorecard&innings=1&name=bat.png`, FX.png(1), 'image/png', T);
    check(r.status === 201 && r.json.draft.photos.length === 1 && r.json.draft.photos[0].name === 'bat.png', 'a PNG goes up as the image itself');
    r = await raw('POST', API + `/drafts/${id}/photos?kind=scorecard&innings=1`, FX.png(1), 'image/png', T);
    check(r.status === 409 && r.json.code === 'DUPLICATE_PHOTO', 'the same photo twice → 409');
    r = await raw('POST', API + `/drafts/${id}/photos?kind=scorecard&innings=1`, Buffer.from('definitely not an image, just some text bytes'), 'image/png', T);
    check(r.status === 415, 'not really an image → 415');
    r = await raw('POST', API + `/drafts/${id}/photos?kind=scorecard&innings=1`, Buffer.from('hello'), 'text/plain', T);
    check(r.status === 400, 'not sent as an image → 400');
    r = await raw('POST', API + `/drafts/${id}/photos?kind=scorecard&innings=1`, Buffer.concat([FX.png(7), Buffer.alloc(7.5 * 1024 * 1024)]), 'image/png', T);
    check(r.status === 413, 'too large → 413');
    await raw('POST', API + `/drafts/${id}/photos?kind=scorecard&innings=1&name=bowl.png`, FX.png(2), 'image/png', T);
    r = await raw('POST', API + `/drafts/${id}/photos?kind=scorecard&innings=2&name=inn2.png`, FX.png(3), 'image/png', T);
    r = await raw('POST', API + `/drafts/${id}/photos?kind=commentary&innings=1&name=cm.png`, FX.png(4), 'image/png', T);
    const photos = r.json.draft.photos;
    check(photos.length === 4 && photos.filter(p => p.kind === 'scorecard').length === 3, 'three scorecard photos and one of commentary');
    r = await raw('GET', API + `/drafts/${id}/photos/${photos[0].id}`, Buffer.alloc(0), 'application/octet-stream', T);
    check(r.status === 200 && r.headers['content-type'] === 'image/png' && Buffer.compare(r.body, FX.png(1)) === 0 && /no-store/.test(r.headers['cache-control']), 'a photo comes back byte for byte, never cached');
    r = await raw('GET', API + `/drafts/${id}/photos/${photos[0].id}`, Buffer.alloc(0), 'application/octet-stream', 'tok-work');
    check(r.status === 403, 'and not to anyone else');

    section('reading the photos (Claude, in the background)');
    r = await req('POST', API + `/drafts/${id}/read`, { kind: 'scorecard' }, T);
    check(r.status === 202 && ['running', 'done'].includes(r.json.draft.read.scorecard.state), 'POST /read → 202, reading');
    r = await req('POST', API + `/drafts/${id}/read`, { kind: 'commentary', innings: 1 }, T);
    let d = null;
    for (let i = 0; i < 100; i++) {
        d = (await req('GET', API + `/drafts/${id}`, null, T)).json.draft;
        if (d.read.scorecard.state !== 'running' && !(d.read.commentary[1] && d.read.commentary[1].state === 'running')) break;
        await sleep(100);
    }
    check(d.read.scorecard.state === 'done' && d.read.scorecard.by === 'claude' && d.innings.length === 2, 'read: two innings');
    check(d.innings[0].batting[0].name === 'Jeeth Suvarna' && d.innings[0].batting[0].sourceName === 'Jeeth Kumar Suvarna', '"Jeeth Kumar Suvarna" read as "Jeeth Suvarna"');
    check(d.read.commentary[1].state === 'done' && d.commentary[1].entries.length === 4, 'commentary read (the overlapping ball once)');
    const sc = fake.requests.find(x => x.body && /scorecard/i.test(x.body.system) && !/ball-by-ball/i.test(x.body.system));
    check(sc && sc.body.model === 'claude-opus-5-5' && sc.body.messages[0].content.filter(b => b.type === 'image').length === 3 && sc.headers['x-api-key'] === 'sk-test', 'Claude got the three scorecard photos, with the server\'s key');
    mode = 'refused';
    const id2 = (await req('POST', API + '/drafts', { ownerUid: W, leagueKey: L }, T)).json.draft.draftId;
    await raw('POST', API + `/drafts/${id2}/photos?kind=scorecard&innings=1`, FX.png(11), 'image/png', T);
    await req('POST', API + `/drafts/${id2}/read`, { kind: 'scorecard' }, T);
    let d2 = null;
    for (let i = 0; i < 100; i++) { d2 = (await req('GET', API + `/drafts/${id2}`, null, T)).json.draft; if (d2.read.scorecard.state !== 'running') break; await sleep(100); }
    check(d2.read.scorecard.state === 'failed' && d2.read.scorecard.code === 'AUTH' && /ANTHROPIC_API_KEY/.test(d2.read.scorecard.error), 'a refused key: the reading fails and says to check ANTHROPIC_API_KEY');
    mode = 'ok';
    r = await req('DELETE', API + `/drafts/${id2}`, null, T);
    check(r.status === 200 && r.json.deleted, 'an import can be discarded');

    section('checking and saving');
    const tctx = (await req('GET', API + `/tournaments/${W}/${LK}`, null, T)).json;
    const ref = (n) => tctx.teams.find(t => t.name === n).ref;
    r = await req('PATCH', API + `/drafts/${id}`, {
        meta: { format: 'Custom', overs: 10, date: '2026-10-12', venue: 'DY Patil Ground', title: 'Match 2', confirmed: true },
        teams: { A: { choice: { mode: 'existing', ref: ref('DY PATIL SA') }, confirmed: true }, B: { choice: { mode: 'existing', ref: ref('PAREL SPORTING CLUB') }, confirmed: true } },
        decisions: { players: { 'A|suraj patil': { mode: 'new', name: 'Suraj A Patil' } }, acknowledged: {}, result: null }
    }, T);
    check(r.status === 200, 'details, teams and the one player decision saved');
    r = await req('POST', API + `/drafts/${id}/analyze`, {}, T);
    check(r.status === 200 && r.json.canSave === true && r.json.preview.matchesBefore === 1 && r.json.preview.matchesAfter === 2, 'checked: ready to save (1 → 2 matches)');
    r = await req('POST', API + `/drafts/${id}/commit`, { idempotencyKey: 'k1' }, T);
    check(r.status === 400 && r.json.code === 'NOT_CONFIRMED', 'saving needs an explicit confirm');
    r = await req('POST', API + `/drafts/${id}/commit`, { idempotencyKey: 'k1', confirm: true }, 'tok-work');
    check(r.status === 403, 'another account cannot save it');
    r = await req('POST', API + `/drafts/${id}/commit`, { idempotencyKey: 'k1', confirm: true }, T);
    check(r.status === 201 && r.json.verification.passed && r.json.matchUrl && r.json.tournamentUrl === '/score/tournament/tokM', 'saved (201), every check passed');
    const matchId = r.json.matchId;
    r = await req('POST', API + `/drafts/${id}/commit`, { idempotencyKey: 'k1', confirm: true }, T);
    check(r.status === 200 && r.json.duplicate === true && r.json.matchId === matchId, 'the same save again → 200, the same match');
    check(await c.records.countDocuments({ leagueKey: L }) === 2, 'one new match in the tournament');
    r = await req('PATCH', API + `/drafts/${id}`, { meta: { format: 'T20' } }, T);
    check(r.status === 409, 'a saved import can no longer be changed');
    r = await req('GET', API + '/history', null, T);
    check(r.json.imports.length === 1 && r.json.imports[0].result.matchId === matchId, 'in the import history');
    check((await c.audits.find({ action: 'Scorecard import' }).toArray()).length === 1, 'in the audit log');

    section('the public tournament page');
    r = await req('GET', '/api/public/tournament/tokM');
    const pub = r.json;
    const im = (pub.matches || []).find(m => m.matchId === matchId);
    check(im && im.winningTeam === 'A' && im.resultText === 'DYP WON BY 25 RUNS' && im.matchTitle === 'Match 2', 'the match is on the tournament page');
    const dyp = pub.pointsTable.find(t => t.team === 'DY PATIL SA');
    check(dyp && dyp.played === 2 && dyp.won === 1, 'the points table counts it (2 played, 1 won)');
    const jeeths = pub.leaderboards.topRuns.filter(b => /jeeth/i.test(b.name));
    check(jeeths.length === 1 && jeeths[0].name === 'Jeeth Suvarna', 'one Jeeth Suvarna on the leaderboard (no "Jeeth Kumar Suvarna")');
    const harsh = pub.leaderboards.topRuns.find(b => /harsh/i.test(b.name));
    check(harsh && harsh.runs >= 60, 'Harsh\'s 60 counted on his existing row');
    r = await req('GET', `/api/public/tournament/tokM/match/${matchId}/balls`);
    check(r.status === 200 && r.json.imported === true && r.json.balls.length === 0 && r.json.importedCommentary && r.json.importedCommentary.innings[0].entries.length === 4, 'the scorecard page gets the copied commentary — and no deliveries');
    r = await req('GET', `/cricket-scorecard?token=tokM&match=${matchId}&history=1`);
    check(r.status === 200, 'the scorecard page opens');

    section('ball-by-ball tools leave an imported match alone');
    r = await req('GET', `/api/admin/cricket/match/${matchId}/insert-context`, null, T);
    check(r.status === 409 && r.json.code === 'IMPORTED_SCORECARD', 'insert a ball: 409');
    r = await req('POST', `/api/admin/cricket/match/${matchId}/insert/preview`, {}, T);
    check(r.status === 409 && r.json.code === 'IMPORTED_SCORECARD', 'insert preview: 409');
    r = await req('POST', `/api/admin/cricket/match/${matchId}/insert`, {}, T);
    check(r.status === 409 && r.json.code === 'IMPORTED_SCORECARD', 'insert: 409');
    r = await req('PUT', `/api/admin/cricket/match/${matchId}/apply-result`, {}, T);
    check(r.status === 409 && r.json.code === 'IMPORTED_SCORECARD', 'work the result out from the balls: 409');
    r = await req('POST', '/api/admin/cricket/recover/add-ball', { matchId }, T);
    check(r.status === 409 && r.json.code === 'IMPORTED_SCORECARD', 'Recovery Centre add-ball: 409');
    const after = await c.records.findOne({ matchId });
    check(after.battingCard.A[0].runs === 40 && after.winningTeam === 'A' && after.importSource, 'the imported match is untouched');

    await fake.close();
    console.log(`\n${passes} passed, ${fails.length} failed`);
    if (fails.length) { console.log('\nFAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
