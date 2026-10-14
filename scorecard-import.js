// 📷 Import Scorecard from Photos — the engine behind /import-scorecard.
//
// chhayajeeth@gmail.com uploads photos of a finished match's scorecard
// (CricHeroes app, MCA website…), checks and corrects every figure, maps the
// players and teams to the ones the site already knows, and the match is
// saved into a tournament as an ordinary completed match record — the same
// document the scoring panel saves, so the scorecard page, points table,
// leaderboards and player pages pick it up with no special path.
//
// What it never does: invent deliveries, clips, timestamps or figures that
// are not on the scorecard (a missing value stays null and is left out of
// the averages it would distort), merge two people because their names
// match, or create / change a team or a logo without being asked.
//
// Server-side owner check: every route is behind requireOwner (server.js).
'use strict';

const crypto = require('crypto');
const M = require('./scorecard-model.js');

const SIDES = ['A', 'B'];
const other = (s) => (s === 'A' ? 'B' : 'A');
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const nk = M.nameKey;
const clean = M.cleanName;
const intOrNull = M.intOrNull;
const FORMATS = { T20: 20, ODI: 50, Test: null, Custom: null };
const MAX_PHOTOS = 24;
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DRAFT_DAYS = 30;
const oversOB = (balls) => (typeof balls === 'number' && isFinite(balls) && balls >= 0 ? `${Math.floor(balls / 6)}.${balls % 6}` : null);
const sha = (s, n) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n || 64);
const newId = (p) => `${p}${crypto.randomBytes(8).toString('hex')}`;
const deepClone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const bump = (m, k, by) => { if (k == null || k === '') return; m.set(k, (m.get(k) || 0) + (by || 1)); };
const topOf = (m) => { let best = null, n = -1; for (const [k, v] of m) if (v > n) { best = k; n = v; } return best; };

// ------------------------------------------------------------------
// Player names: the import convention is FIRST + LAST name.
// "Jeeth Kumar Suvarna" (MCA website) is saved as "Jeeth Suvarna", the name
// the site already knows him by; the printed name is kept as sourceName.
// A surname's particles stay with it ("Quinton de Kock", "Inzamam ul Haq"),
// and when two different players of one team would end up with the same
// short name, both keep their full names instead.
// ------------------------------------------------------------------
const normalizePlayerName = M.normalizePlayerName;
// Every spelling a player could already be known by (for finding him).
function nameVariants(name) {
    const out = new Set();
    const n = normalizePlayerName(name);
    [n.original, n.display].forEach(v => { const k = nk(v); if (k) out.add(k); });
    const t = n.original.split(' ').filter(Boolean);
    // "M S Dhoni" → "ms dhoni"
    if (t.length >= 3 && t.slice(0, -1).every(x => /^[a-z]\.?$/i.test(x))) out.add(nk(t.slice(0, -1).map(x => x[0]).join('') + ' ' + t[t.length - 1]));
    return [...out];
}
// Names that are probably the same person written differently — shown for
// review, never matched on their own.
function similarPlayerNames(a, b) {
    const x = nk(normalizePlayerName(a).display), y = nk(normalizePlayerName(b).display);
    if (!x || !y || x === y) return false;
    const tx = x.split(' '), ty = y.split(' ');
    const lx = tx[tx.length - 1], ly = ty[ty.length - 1];
    // same surname, first names where one is the other's initial ("J Suvarna")
    if (lx === ly && tx.length >= 2 && ty.length >= 2 && (tx[0].replace('.', '') === ty[0][0] || ty[0].replace('.', '') === tx[0][0])) return true;
    const d = M.levenshtein(x, y);
    const len = Math.max(x.length, y.length);
    return len >= 6 && d <= (len >= 12 ? 2 : 1);
}

// ------------------------------------------------------------------
// The draft's own working shape (what the page edits)
// ------------------------------------------------------------------
const BAT_FIELDS = ['runs', 'balls', 'fours', 'sixes'];
const BOWL_FIELDS = ['maidens', 'runs', 'wickets', 'wides', 'noBalls', 'dots'];
const strCap = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n));
const numCap = (v, max) => { const n = intOrNull(v); return n === null || n > max ? null : n; };
const decCap = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) && n >= 0 && n < 10000 ? n : null; };
const oversCap = (v) => { const s = strCap(v, 8); return s === null || s === '' ? null : s; };
const rowKey = (k, p) => (isStr(k) && /^[A-Za-z0-9_-]{1,40}$/.test(k) ? k : `${p}${crypto.randomBytes(5).toString('hex')}`);
const confCap = (c) => (c === 'high' || c === 'medium' || c === 'low' ? c : null);
const unclearCap = (u) => (Array.isArray(u) ? u.map(x => strCap(x, 20)).filter(Boolean).slice(0, 8) : []);

function sanitizeInnings(list, format) {
    const max = format === 'Test' ? 4 : 2;
    return (Array.isArray(list) ? list : []).slice(0, max).map(inn => {
        const i = inn || {};
        const batting = (Array.isArray(i.batting) ? i.batting : []).slice(0, 16).map(r => {
            const row = { key: rowKey(r && r.key, 'b'), name: strCap(r && r.name, 60) || '', sourceName: strCap(r && r.sourceName, 80), dismissal: strCap(r && r.dismissal, 120) };
            BAT_FIELDS.forEach(f => { row[f] = numCap(r && r[f], 999); });
            row.strikeRate = decCap(r && r.strikeRate);
            row.captain = !!(r && r.captain); row.wk = !!(r && r.wk);
            row.photo = numCap(r && r.photo, 99); row.confidence = confCap(r && r.confidence); row.unclear = unclearCap(r && r.unclear);
            return row;
        });
        const bowling = (Array.isArray(i.bowling) ? i.bowling : []).slice(0, 16).map(b => {
            const row = { key: rowKey(b && b.key, 'w'), name: strCap(b && b.name, 60) || '', sourceName: strCap(b && b.sourceName, 80), overs: oversCap(b && b.overs) };
            BOWL_FIELDS.forEach(f => { row[f] = numCap(b && b[f], 999); });
            row.economy = decCap(b && b.economy);
            row.photo = numCap(b && b.photo, 99); row.confidence = confCap(b && b.confidence); row.unclear = unclearCap(b && b.unclear);
            return row;
        });
        const e = i.extras || {}, t = i.total || {};
        return {
            battingSide: i.battingSide === 'A' || i.battingSide === 'B' ? i.battingSide : null,
            batting, bowling,
            didNotBat: (Array.isArray(i.didNotBat) ? i.didNotBat : []).map(x => strCap(x, 60)).filter(Boolean).slice(0, 16),
            extras: { total: numCap(e.total, 999), wides: numCap(e.wides, 999), noBalls: numCap(e.noBalls, 999), byes: numCap(e.byes, 999), legByes: numCap(e.legByes, 999), penalty: numCap(e.penalty, 999) },
            total: { runs: numCap(t.runs, 9999), wickets: numCap(t.wickets, 10), overs: oversCap(t.overs), declared: !!t.declared, allOut: !!t.allOut },
            fallOfWickets: (Array.isArray(i.fallOfWickets) ? i.fallOfWickets : []).slice(0, 10).map(w => ({ wicket: numCap(w && w.wicket, 10), runs: numCap(w && w.runs, 9999), overs: oversCap(w && w.overs), batter: strCap(w && w.batter, 60) })).filter(w => w.runs !== null),
            printedTeam: strCap(i.printedTeam, 80)
        };
    });
}

// ------------------------------------------------------------------
// Commentary photos → entries the scorecard page can show (display only:
// never stored as deliveries, never counted in any statistic)
// ------------------------------------------------------------------
function parseMarker(marker) {
    const m = String(marker == null ? '' : marker).trim().toLowerCase().replace(/\s+/g, '');
    let x;
    if (!m || m === '•' || m === '.' || m === '0' || m === 'dot' || m === '·') return { ballType: '0', runs: 0, legal: true };
    if (m === 'w' || m === 'wkt' || m === 'out') return { ballType: 'W', runs: 0, legal: true, wicket: true };
    if ((x = m.match(/^(\d+)?(?:wd|wides?)$/))) return { ballType: 'WD', runs: x[1] ? Number(x[1]) : 1, legal: false };
    if ((x = m.match(/^(\d+)?(?:nb|noballs?)$/))) return { ballType: 'NB', runs: x[1] ? Number(x[1]) : 1, legal: false };
    if ((x = m.match(/^(\d+)?(?:lb|legbyes?)$/))) return { ballType: 'LB', runs: x[1] ? Number(x[1]) : 1, legal: true };
    if ((x = m.match(/^(\d+)?(?:b|byes?)$/))) return { ballType: 'B', runs: x[1] ? Number(x[1]) : 1, legal: true };
    if ((x = m.match(/^(\d+)w$|^w\+?(\d+)$/))) return { ballType: 'W', runs: Number(x[1] || x[2]) || 0, legal: true, wicket: true };
    if ((x = m.match(/^(\d+)$/))) { const n = Number(x[1]); return { ballType: n <= 6 ? String(n) : 'OT', runs: n, legal: true }; }
    return { ballType: '0', runs: 0, legal: true, unknown: true };
}
function sanitizeCommentary(raw) {
    const r = raw || {};
    const entries = (Array.isArray(r.entries) ? r.entries : []).slice(0, 700).map(e => {
        const label = strCap(e && e.label, 8) || '';
        const lm = label.match(/^(\d{1,3})\.(\d)$/);
        const p = parseMarker(e && e.marker);
        return {
            label, over: lm ? Number(lm[1]) : null, ball: lm ? Number(lm[2]) : null,
            marker: strCap(e && e.marker, 8), ballType: p.ballType, runs: p.runs, legal: p.legal, wicket: !!p.wicket, unknownMarker: !!p.unknown,
            bowler: strCap(e && e.bowler, 60), batter: strCap(e && e.batter, 60), text: strCap(e && e.text, 400),
            photo: numCap(e && e.photo, 99), confidence: confCap(e && e.confidence)
        };
    }).filter(e => e.over !== null);
    return { entries, notes: (Array.isArray(r.notes) ? r.notes : []).map(n => strCap(n, 300)).filter(Boolean).slice(0, 20) };
}
// Entries in match order, the same delivery read twice (overlapping
// screenshots) once.
function mergeCommentary(chunks) {
    const seen = new Set(), out = [];
    chunks.forEach(c => (c || []).forEach(e => {
        const k = `${e.label}|${nk(e.bowler)}|${nk(e.batter)}|${e.marker}|${nk(e.text).slice(0, 60)}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push(e);
    }));
    // stable sort by over.ball (a wide keeps its place before the re-bowled ball)
    return out.map((e, i) => ({ e, i })).sort((a, b) => (a.e.over - b.e.over) || (a.e.ball - b.e.ball) || (a.i - b.i)).map(x => x.e);
}
function commentaryCoverage(entries, inn) {
    const legal = entries.filter(e => e.legal).length;
    const runs = entries.reduce((n, e) => n + (e.runs || 0), 0);
    const wkts = entries.filter(e => e.wicket).length;
    const balls = inn ? M.oversToBalls(inn.total && inn.total.overs) : null;
    const total = inn ? intOrNull(inn.total && inn.total.runs) : null;
    const complete = typeof balls === 'number' && isFinite(balls) && total !== null && legal === balls && runs === total;
    return { legal, runs, wickets: wkts, inningsBalls: typeof balls === 'number' && isFinite(balls) ? balls : null, inningsRuns: total, complete };
}

// ------------------------------------------------------------------
// The engine
// ------------------------------------------------------------------
function createScorecardImport(deps) {
    const db = deps.db;
    const pk = deps.playerKey;
    const now = () => (deps.now ? deps.now() : Date.now());
    const log = deps.log || (() => {});
    const jobs = new Map();       // `${draftId}|${kind}` → running promise
    const committing = new Set(); // draftIds being saved right now
    const ctxCache = new Map();   // `${ownerUid}|${leagueKey}` → { at, ctx }

    function httpError(status, message, extra) {
        const e = new Error(message);
        e.status = status;
        Object.assign(e, extra || {});
        return e;
    }
    const viewerEmail = (viewer) => String((viewer && viewer.email) || '').trim().toLowerCase();

    // ---- tournaments the owner can import into (every creator's) ----
    async function listTournaments() {
        const leagues = await db.leagues.find({ leagueKey: { $ne: deps.singleMatchesLeagueKey || '__single_matches__' } })
            .project({ ownerUid: 1, leagueKey: 1, displayName: 1, updatedAt: 1, sport: 1, publicToken: 1, createdBy: 1, info: 1 })
            .sort({ updatedAt: -1 }).limit(300).toArray();
        const out = [];
        for (const l of leagues) {
            if (l.sport && l.sport !== 'cricket') continue;
            const matchCount = await db.records.countDocuments({ ownerUid: l.ownerUid, leagueKey: l.leagueKey, upcoming: { $ne: true } });
            out.push({
                ownerUid: l.ownerUid, leagueKey: l.leagueKey, displayName: l.displayName || l.leagueKey, token: l.publicToken || null,
                createdBy: l.createdBy || null, matchCount, updatedAt: l.updatedAt || null,
                format: (l.info && l.info.format) || null, overs: (l.info && l.info.overs) || null, venue: (l.info && l.info.venue) || null
            });
        }
        return out;
    }
    async function loadLeague(ownerUid, leagueKey) {
        if (!isStr(ownerUid) || !isStr(leagueKey)) throw httpError(400, 'Tournament required');
        const league = await db.leagues.findOne({ ownerUid, leagueKey });
        if (!league || leagueKey === (deps.singleMatchesLeagueKey || '__single_matches__')) throw httpError(404, 'Tournament not found');
        return league;
    }

    // ---- everything the import needs to know about the account ----
    async function loadContext(ownerUid, leagueKey, fresh) {
        const ck = `${ownerUid}|${leagueKey}`;
        const hit = ctxCache.get(ck);
        if (!fresh && hit && now() - hit.at < 20000) return hit.ctx;
        const league = await loadLeague(ownerUid, leagueKey);
        const accountRecs = await db.records.find({ ownerUid }).project({
            leagueKey: 1, matchId: 1, roomId: 1, upcoming: 1, teamA: 1, teamB: 1, squadA: 1, squadB: 1, battingCard: 1, bowlingCard: 1,
            scoreA: 1, scoreB: 1, winningTeam: 1, matchDate: 1, savedAt: 1, importSource: 1
        }).toArray();
        const leagueRecs = accountRecs.filter(r => r.leagueKey === leagueKey);
        const profiles = new Map(), keyOwner = new Map();
        (await db.players.find({ ownerUid }).project({ playerId: 1, nameKeys: 1, displayName: 1, mergedInto: 1 }).toArray()).forEach(p => {
            profiles.set(p.playerId, p);
            (p.nameKeys || []).forEach(k => { if (!String(k).startsWith('#')) keyOwner.set(k, p.playerId); });
        });
        const canon = (id) => {
            let cur = id;
            for (let i = 0; i < 6 && cur; i++) {
                const p = profiles.get(cur);
                if (!p || !p.mergedInto || p.mergedInto === cur) return cur;
                cur = p.mergedInto;
            }
            return cur;
        };
        const savedTeams = deps.db.teams ? await db.teams.find({ ownerUid }).toArray() : [];

        // who played for which team, under which ids and names
        const idTeams = new Map(), idNames = new Map(), nameIds = new Map(), idMatches = new Map(), exactIds = new Map();
        const teamPlayers = new Map(); // teamKey → Map(nameKey → { names, ids, matches })
        const teamInfo = new Map();    // teamKey → { name, short, color, logoUrl, teamId, matches, sources }
        const teamNames = new Map();   // teamKey → names as written (every tournament of the account)
        const noteTeam = (t, source, leagueOnly) => {
            const key = nk(t && t.name);
            if (!key) return null;
            let e = teamInfo.get(key);
            if (!e) { e = { key, names: new Map(), short: '', color: '', logoUrl: '', teamId: null, matches: 0, sources: new Set(), latestLogoAt: '' }; teamInfo.set(key, e); }
            bump(e.names, clean(t.name));
            e.sources.add(source);
            if (!leagueOnly) return e;
            return e;
        };
        const notePlayer = (teamKey, name, id, matchKey, inLeague) => {
            const k = nk(name);
            if (!k) return;
            const c = isStr(id) ? canon(id) : null;
            if (inLeague) {
                if (!teamPlayers.has(teamKey)) teamPlayers.set(teamKey, new Map());
                const tp = teamPlayers.get(teamKey);
                if (!tp.has(k)) tp.set(k, { names: new Map(), ids: new Map(), matches: new Set() });
                const e = tp.get(k);
                bump(e.names, clean(name));
                if (c) bump(e.ids, c);
                if (matchKey) e.matches.add(matchKey);
            }
            if (c) {
                if (!idTeams.has(c)) idTeams.set(c, new Set());
                idTeams.get(c).add(teamKey);
                if (!idNames.has(c)) idNames.set(c, new Map());
                bump(idNames.get(c), clean(name));
                if (!idMatches.has(c)) idMatches.set(c, new Set());
                if (matchKey) idMatches.get(c).add(matchKey);
                nameVariants(name).forEach(v => { if (!nameIds.has(v)) nameIds.set(v, new Set()); nameIds.get(v).add(c); });
                if (!exactIds.has(k)) exactIds.set(k, new Set());
                exactIds.get(k).add(c);
            }
        };
        accountRecs.forEach(r => {
            const inLeague = r.leagueKey === leagueKey;
            const mk = `${r.leagueKey}|${r.matchId}`;
            SIDES.forEach(side => {
                const team = r['team' + side];
                const tk = nk(team && team.name);
                if (!tk) return;
                if (!teamNames.has(tk)) teamNames.set(tk, new Map());
                bump(teamNames.get(tk), clean(team.name));
                if (inLeague) {
                    const e = noteTeam(team, 'matches', true);
                    if (e && !r.upcoming) e.matches++;
                    if (e && isStr(team.logoUrl) && String(r.savedAt || '') >= e.latestLogoAt) { e.logoUrl = team.logoUrl; e.latestLogoAt = String(r.savedAt || ''); }
                    if (e && isStr(team.short) && !e.short) e.short = team.short;
                    if (e && isStr(team.color) && !e.color) e.color = team.color;
                    if (e && isStr(team.teamId) && !e.teamId) e.teamId = team.teamId;
                }
                const sq = r['squad' + side];
                ((sq && sq.players) || []).forEach(p => notePlayer(tk, p && p.name, p && p.id, mk, inLeague));
                ((r.battingCard && r.battingCard[side]) || []).forEach(b => notePlayer(tk, b && b.name, b && b.id, mk, inLeague));
                ((r.bowlingCard && r.bowlingCard[side]) || []).forEach(b => notePlayer(tk, b && b.name, b && b.id, mk, inLeague));
            });
        });
        ((league.info && Array.isArray(league.info.teams)) ? league.info.teams : []).forEach(t => {
            const e = noteTeam(t, 'tournament', true);
            if (!e) return;
            e.inInfo = true;
            if (isStr(t.logoUrl) && !e.infoLogo) e.infoLogo = t.logoUrl;
            if (isStr(t.short) && !e.short) e.short = t.short;
            if (isStr(t.color) && !e.color) e.color = t.color;
            if (isStr(t.teamId) && !e.teamId) e.teamId = t.teamId;
        });
        // a saved team's roster counts as "played for this team"
        savedTeams.forEach(st => {
            const tk = nk(st.name);
            (st.players || []).forEach(p => {
                const c = isStr(p && p.id) ? canon(p.id) : null;
                if (!c) return;
                if (!idTeams.has(c)) idTeams.set(c, new Set());
                idTeams.get(c).add(tk);
                if (!idNames.has(c)) idNames.set(c, new Map());
                bump(idNames.get(c), clean(p.name));
                nameVariants(p.name).forEach(v => { if (!nameIds.has(v)) nameIds.set(v, new Set()); nameIds.get(v).add(c); });
            });
        });
        savedTeams.forEach(st => { const tk = nk(st.name); if (tk && !teamNames.has(tk)) teamNames.set(tk, new Map([[clean(st.name), 1]])); });
        const ctx = { ownerUid, leagueKey, league, leagueRecs, accountRecs, profiles, keyOwner, canon, savedTeams, idTeams, idNames, nameIds, exactIds, idMatches, teamPlayers, teamInfo, teamNames };
        ctxCache.set(ck, { at: now(), ctx });
        return ctx;
    }

    // ---- teams ----
    function teamOptions(ctx) {
        const out = [];
        for (const e of ctx.teamInfo.values()) {
            out.push({
                ref: 'tournament:' + e.key, source: 'tournament', name: topOf(e.names) || e.key, short: e.short || '', color: e.color || '',
                logoUrl: e.infoLogo || e.logoUrl || '', teamId: e.teamId || null, matches: e.matches, inTournamentList: !!e.inInfo
            });
        }
        const have = new Set(out.map(o => nk(o.name)));
        ctx.savedTeams.forEach(st => {
            const key = nk(st.name);
            if (have.has(key)) {
                // the same team: the saved team fills in what the tournament lacks
                const o = out.find(x => nk(x.name) === key);
                if (o) { o.savedTeamId = st.teamId; if (!o.logoUrl && st.logoUrl) { o.logoUrl = st.logoUrl; o.logoFrom = 'saved'; } if (!o.teamId) o.teamId = st.teamId; }
                return;
            }
            out.push({ ref: 'saved:' + st.teamId, source: 'saved', name: st.name, short: st.short || '', color: st.color || '', logoUrl: st.logoUrl || '', teamId: st.teamId, savedTeamId: st.teamId, matches: 0, players: (st.players || []).length });
        });
        return out.sort((a, b) => (b.matches - a.matches) || a.name.localeCompare(b.name));
    }
    function planTeams(draft, ctx) {
        const options = teamOptions(ctx);
        const byRef = new Map(options.map(o => [o.ref, o]));
        const plan = {};
        const issues = [];
        SIDES.forEach(side => {
            const t = (draft.teams && draft.teams[side]) || {};
            const ch = t.choice || {};
            const printed = t.printed || null;
            const lookFor = isStr(ch.name) ? ch.name : printed;
            const exact = options.filter(o => lookFor && nk(o.name) === nk(lookFor));
            const similar = options.filter(o => lookFor && nk(o.name) !== nk(lookFor) && M.teamLikeness(lookFor, o.name) >= 0.6);
            let team = null, mode = null, status = 'needs-choice', message = null;
            if (ch.mode === 'existing' && byRef.has(ch.ref)) {
                const o = byRef.get(ch.ref);
                team = { name: o.name, short: o.short, color: o.color, logoUrl: o.logoUrl, teamId: o.teamId, ref: o.ref, savedTeamId: o.savedTeamId || null, existing: true };
                mode = 'existing'; status = 'ok';
            } else if (ch.mode === 'new' && isStr(ch.name)) {
                const name = clean(ch.name).slice(0, 60);
                const clash = options.find(o => nk(o.name) === nk(name));
                if (clash) { status = 'error'; message = `"${clash.name}" already exists — use it instead of creating a second team with the same name.`; }
                else { status = 'ok'; }
                team = { name, short: strCap(ch.short, 6) || '', color: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(ch.color || '')) ? ch.color : '', logoUrl: '', teamId: null, existing: false, saveTeam: ch.saveTeam !== false };
                mode = 'new';
            } else if (exact.length === 1) {
                const o = exact[0];
                team = { name: o.name, short: o.short, color: o.color, logoUrl: o.logoUrl, teamId: o.teamId, ref: o.ref, savedTeamId: o.savedTeamId || null, existing: true };
                mode = 'existing'; status = 'proposed';
            }
            // the logo
            const lg = ch.logo || {};
            let logo = { mode: 'keep', url: team && team.logoUrl ? team.logoUrl : '' };
            if (team) {
                if (lg.mode === 'upload' && isStr(lg.dataUrl)) {
                    if (team.logoUrl && !lg.replaceConfirmed) { status = status === 'ok' ? 'error' : status; message = message || `"${team.name}" already has a logo — confirm that the new one replaces it.`; }
                    logo = { mode: team.logoUrl ? 'replace' : 'upload', url: lg.dataUrl };
                } else if (lg.mode === 'none') logo = { mode: 'none', url: '' };
                else logo = { mode: team.logoUrl ? 'keep' : 'none', url: team.logoUrl || '' };
            }
            if (team && logo.mode !== 'none') team.logoUrl = logo.url;
            if (team && logo.mode === 'none') team.logoUrl = '';
            plan[side] = {
                side, printed, mode, status, message, team, logo, confirmed: !!t.confirmed,
                exact: exact.map(o => o.ref), similar: similar.map(o => ({ ref: o.ref, name: o.name, logoUrl: o.logoUrl, matches: o.matches }))
            };
            const label = side === 'A' ? 'Team batting first' : 'Team batting second';
            if (!team) issues.push({ id: `team-${side}`, level: 'error', ack: false, table: 'teams', side, message: `${label}: choose the existing team or create a new one${printed ? ` (the photos say "${printed}")` : ''}.` });
            else if (status === 'error') issues.push({ id: `team-${side}`, level: 'error', ack: false, table: 'teams', side, message });
            else if (!t.confirmed) issues.push({ id: `team-${side}-confirm`, level: 'error', ack: false, table: 'teams', side, message: `${label}: confirm "${team.name}" and its logo.` });
        });
        if (plan.A.team && plan.B.team && nk(plan.A.team.name) === nk(plan.B.team.name)) issues.push({ id: 'teams-same', level: 'error', ack: false, table: 'teams', message: 'Both sides are the same team.' });
        return { options, plan, issues };
    }

    // ---- players: who is who ----
    // Every distinct (side, printed name) of the scorecard is one player.
    function playersOf(draft) {
        const list = new Map();
        const add = (side, name, sourceName, where) => {
            const n = clean(name);
            if (!n || !side) return;
            const key = `${side}|${nk(sourceName || n)}`;
            if (!list.has(key)) list.set(key, { key, side, name: n, sourceName: clean(sourceName || n), where: new Set() });
            list.get(key).where.add(where);
        };
        (draft.innings || []).forEach((inn, i) => {
            const bat = inn.battingSide, bowl = bat ? other(bat) : null;
            (inn.batting || []).forEach(r => add(bat, r.name, r.sourceName, `bat${i}`));
            (inn.didNotBat || []).forEach(n => add(bat, n, n, `dnb${i}`));
            (inn.bowling || []).forEach(r => add(bowl, r.name, r.sourceName, `bowl${i}`));
        });
        return [...list.values()];
    }
    function candidateInfo(ctx, id, teamKey) {
        const teams = [...(ctx.idTeams.get(id) || [])];
        const teamNames = teams.map(k => { const e = ctx.teamInfo.get(k); return (e && topOf(e.names)) || (ctx.teamNames.get(k) && topOf(ctx.teamNames.get(k))) || k; });
        const names = ctx.idNames.get(id) || new Map();
        const prof = ctx.profiles.get(id);
        const leagueMatches = [...(ctx.idMatches.get(id) || [])].filter(m => m.startsWith(ctx.leagueKey + '|')).length;
        return {
            id, name: topOf(names) || (prof && prof.displayName) || null, names: [...names.keys()].slice(0, 4),
            teams: teamNames.slice(0, 4), sameTeam: teams.includes(teamKey), matches: (ctx.idMatches.get(id) || new Set()).size,
            leagueMatches, hasProfile: !!prof
        };
    }
    function planPlayers(draft, ctx, teamPlan) {
        const people = playersOf(draft);
        const decisions = (draft.decisions && draft.decisions.players) || {};
        const out = [];
        const issues = [];
        // the team each side really is (for "played for this team")
        const teamKeyOf = (side) => nk(teamPlan.plan[side] && teamPlan.plan[side].team && teamPlan.plan[side].team.name);
        // The short name is the row's (the person may have corrected it); the
        // full name is the printed one when it still shortens to that name.
        const namesOf = (p) => {
            const short = normalizePlayerName(p.name);
            const src = p.sourceName ? normalizePlayerName(p.sourceName) : null;
            const printed = src && nk(src.display) === nk(short.display) ? src : short;
            return { display: short.display, full: printed.original, dropped: printed.dropped };
        };
        // a short name two players of the same team would share → both keep their full names
        const shortCount = new Map();
        people.forEach(p => { const k = `${p.side}|${nk(namesOf(p).display)}`; shortCount.set(k, (shortCount.get(k) || 0) + 1); });
        people.forEach(p => {
            const tk = teamKeyOf(p.side);
            const norm = namesOf(p);
            const clash = (shortCount.get(`${p.side}|${nk(norm.display)}`) || 0) > 1;
            // someone in the account is already known by this short name (his
            // full name shortens to it): a new player keeps his full name
            const shortTaken = norm.dropped.length > 0 && (ctx.nameIds.get(nk(norm.display)) || new Set()).size > 0;
            const proposed = clash || shortTaken ? norm.full : norm.display;
            const keys = new Set([...nameVariants(p.name), ...nameVariants(p.sourceName)]);
            const ids = new Set();
            keys.forEach(k => {
                (ctx.nameIds.get(k) || new Set()).forEach(id => ids.add(id));
                if (ctx.keyOwner.has(k)) ids.add(ctx.canon(ctx.keyOwner.get(k)));
            });
            // names this team used in this tournament without an id (older records)
            const tp = tk ? ctx.teamPlayers.get(tk) : null;
            const namedOnly = [];
            if (tp) keys.forEach(k => { const e = tp.get(k); if (e && !e.ids.size) namedOnly.push(topOf(e.names)); });
            const cands = [...ids].map(id => candidateInfo(ctx, id, tk));
            // "Rahul Dev Sharma" is not "Rahul Kumar Sharma": both short to
            // "Rahul Sharma", but their full names say two people
            const fullOf = (n) => normalizePlayerName(n);
            const mine = [fullOf(p.sourceName), fullOf(p.name)].find(x => x.dropped.length);
            cands.forEach(c => {
                if (!mine) return;
                const theirs = (c.names || []).map(fullOf).find(x => x.dropped.length && nk(x.display) === nk(mine.display));
                if (theirs && nk(theirs.dropped.join(' ')) !== nk(mine.dropped.join(' ')) && !(theirs.dropped.join('').length === 1 || mine.dropped.join('').length === 1) ) c.middleNameDiffers = theirs.original;
            });
            const strong = cands.filter(c => c.sameTeam && !c.middleNameDiffers);
            // similar names in the same team — review only
            const similar = [];
            if (tp) for (const [k, e] of tp) {
                if (keys.has(k)) continue;
                const nm = topOf(e.names);
                if (similarPlayerNames(nm, p.name)) {
                    const id = topOf(e.ids);
                    if (id && !ids.has(id)) similar.push(candidateInfo(ctx, id, tk));
                    else if (!id) similar.push({ id: null, name: nm, names: [nm], teams: [], sameTeam: true, matches: e.matches.size, leagueMatches: e.matches.size, hasProfile: false });
                }
            }
            let suggestion = null, status, reason;
            if (strong.length === 1) { suggestion = { mode: 'existing', id: strong[0].id }; status = 'auto'; reason = `Same name, already plays for this team (${strong[0].leagueMatches || strong[0].matches} match${(strong[0].leagueMatches || strong[0].matches) === 1 ? '' : 'es'})`; }
            else if (strong.length > 1) { status = 'review'; reason = `${strong.length} different players with this name have played for this team — choose the right one.`; }
            else if (!cands.length && namedOnly.length) { suggestion = { mode: 'existing', id: null, name: namedOnly[0] }; status = 'auto'; reason = 'Same name in this team\'s earlier scorecards'; }
            else if (cands.some(c => c.middleNameDiffers)) { const c = cands.find(x => x.middleNameDiffers); status = 'review'; reason = `"${c.middleNameDiffers}" has played for ${c.teams[0] || 'a team'} — a different middle name. The same person, or a different one?`; }
            else if (cands.length) { status = 'review'; reason = `A player with this name has played for ${[...new Set(cands.flatMap(c => c.teams))].slice(0, 2).join(', ') || 'another team'} — the same person, or a different one?`; }
            else if (similar.length) { status = 'review'; reason = `Similar name in this team: ${similar.map(s => s.name).join(', ')} — the same person, or a different one?`; }
            else { suggestion = { mode: 'new' }; status = 'auto'; reason = 'New player'; }

            // the person's decision wins
            const d = decisions[p.key];
            let final = null;
            if (d && d.mode === 'existing' && (d.id || d.name)) {
                const okId = d.id && (ids.has(d.id) || similar.some(s => s.id === d.id) || ctx.profiles.has(d.id) || ctx.idTeams.has(d.id));
                if (d.id && !okId) issues.push({ id: `player-${p.key}`, level: 'error', ack: false, table: 'players', side: p.side, message: `"${p.name}": the chosen player ID ${d.id} is not in this account.` });
                else final = { mode: 'existing', id: d.id ? ctx.canon(d.id) : null, name: d.id ? (candidateInfo(ctx, ctx.canon(d.id), tk).name || proposed) : clean(d.name) };
            } else if (d && d.mode === 'new') {
                final = { mode: 'new', id: null, name: clean(d.name) || proposed };
            } else if (suggestion && status === 'auto') {
                final = suggestion.mode === 'existing'
                    ? { mode: 'existing', id: suggestion.id, name: suggestion.id ? (candidateInfo(ctx, suggestion.id, tk).name || proposed) : suggestion.name }
                    : { mode: 'new', id: null, name: proposed };
            }
            if (!final && status === 'review') issues.push({ id: `player-${p.key}`, level: 'error', ack: false, table: 'players', side: p.side, message: `${p.name}: ${reason}` });
            out.push({
                key: p.key, side: p.side, name: p.name, sourceName: p.sourceName, normalized: proposed, middleDropped: norm.dropped,
                status: d ? 'decided' : status, reason, candidates: cands, similar, suggestion, final, where: [...p.where]
            });
        });
        // a new player must not share a name with someone else: leaderboards
        // and player pages count by name, so the two would be mixed up
        out.forEach(p => {
            if (!p.final || p.final.mode !== 'new') return;
            const k = nk(p.final.name);
            const owners = new Set();
            (ctx.exactIds.get(k) || new Set()).forEach(id => owners.add(id));
            if (ctx.keyOwner.has(k)) owners.add(ctx.canon(ctx.keyOwner.get(k)));
            const tp = ctx.teamPlayers.get(nk(teamPlan.plan[p.side] && teamPlan.plan[p.side].team && teamPlan.plan[p.side].team.name));
            const namedHere = tp && tp.has(k);
            if (owners.size || namedHere) {
                const alt = p.sourceName && nk(p.sourceName) !== k ? p.sourceName : `${p.final.name.split(' ')[0]} ${String.fromCharCode(65 + (p.side === 'A' ? 0 : 1))}. ${p.final.name.split(' ').slice(1).join(' ')}`;
                issues.push({ id: `player-name-${p.key}`, level: 'error', ack: false, table: 'players', side: p.side, message: `"${p.final.name}" is already another player's name — a new player needs a name of his own (for example "${alt}"), or his runs and wickets would be added to the other player's.` });
                p.nameClash = { suggestion: alt };
            }
        });
        // one person, one row in each table; two people never one id
        const byId = new Map();
        out.forEach(p => {
            if (!p.final || !p.final.id) return;
            const k = `${p.final.id}`;
            if (!byId.has(k)) byId.set(k, []);
            byId.get(k).push(p);
        });
        for (const [id, list] of byId) {
            const sides = new Set(list.map(p => p.side));
            if (sides.size > 1) issues.push({ id: `player-both-${id}`, level: 'error', ack: false, table: 'players', message: `Player ID ${id} is chosen for both teams (${list.map(p => p.name).join(' / ')}).` });
            const tables = new Map();
            list.forEach(p => p.where.forEach(w => { if (!w.startsWith('dnb')) { tables.set(w, (tables.get(w) || 0) + 1); } }));
            for (const [w, n] of tables) if (n > 1) issues.push({ id: `player-twice-${id}-${w}`, level: 'error', ack: false, table: 'players', message: `${list.map(p => p.name).join(' and ')} are two rows of the same table but were both mapped to one player (${id}).` });
        }
        return { players: out, issues };
    }

    // ---- the match record, exactly as the scoring panel saves one ----
    const DISMISSAL_TYPE = { bowled: 'Bowled', caught: 'Caught', lbw: 'LBW', stumped: 'Stumped', hitwicket: 'Hit Wicket', runout: 'Run Out', retiredhurt: 'Retired Hurt', retiredout: 'Retired Out', obstructing: 'Obstructing the Field', hittwice: 'Hit the Ball Twice', timedout: 'Timed Out', absent: 'Absent Hurt', handled: 'Handled the Ball' };
    function buildRecord(draft, ctx, teamPlan, playerPlan, opts) {
        opts = opts || {};
        const ids = opts.ids || {}; // player key → id decided at save time
        const byKey = new Map(playerPlan.players.map(p => [p.key, p]));
        const idOf = (p) => (p && p.final ? (p.final.id || ids[p.key] || null) : null);
        // a name as printed on this scorecard → the player (within one side)
        const lookup = { A: new Map(), B: new Map() };
        playerPlan.players.forEach(p => {
            [p.name, p.sourceName, normalizePlayerName(p.name).display, normalizePlayerName(p.sourceName).display].forEach(n => { const k = nk(n); if (k && !lookup[p.side].has(k)) lookup[p.side].set(k, p); });
        });
        const playerFor = (side, name) => {
            const k = nk(name);
            if (!k || !side) return null;
            const direct = lookup[side].get(k) || lookup[side].get(nk(normalizePlayerName(name).display));
            if (direct) return direct;
            // "Garv" for "Garv Jain" in a dismissal line: one surname/first-name match only
            const hits = [...new Set([...lookup[side].values()])].filter(p => {
                const parts = nk(p.final ? p.final.name : p.name).split(' ');
                return parts.includes(k) || parts[parts.length - 1] === k;
            });
            return hits.length === 1 ? hits[0] : null;
        };
        const display = (p, fallback) => (p && p.final ? p.final.name : clean(fallback));
        const keyOf = (side, name, sourceName) => `${side}|${nk(sourceName || name)}`;
        const teams = { A: teamPlan.plan.A.team, B: teamPlan.plan.B.team };
        const inns = draft.innings || [];
        const battingCard = { A: [], B: [] }, bowlingCard = { A: [], B: [] };
        const extras = { A: { wd: 0, nb: 0, b: 0, lb: 0, pen: 0 }, B: { wd: 0, nb: 0, b: 0, lb: 0, pen: 0 } };
        const fallOfWickets = { A: [], B: [] };
        const inningsArchive = [];
        const totals = { A: { runs: 0, balls: 0, wickets: 0, any: false }, B: { runs: 0, balls: 0, wickets: 0, any: false } };
        inns.forEach((inn, i) => {
            const no = i + 1, bat = inn.battingSide, bowl = other(bat);
            (inn.batting || []).forEach((r, pos) => {
                const p = byKey.get(keyOf(bat, r.name, r.sourceName));
                const d = M.parseDismissal(r.dismissal);
                const fielderP = d.fielder ? playerFor(bowl, d.fielder) : null;
                const bowlerP = d.bowler ? playerFor(bowl, d.bowler) : null;
                const fielder = d.fielder ? display(fielderP, d.fielder) : null;
                const bowler = d.bowler ? display(bowlerP, d.bowler) : null;
                const behind = /c\s*†/i.test(String(r.dismissal || ''));
                let howOut;
                switch (d.kind) {
                    case 'notout': howOut = 'not out'; break;
                    case 'retiredhurt': howOut = 'retired hurt'; break;
                    case 'absent': howOut = 'absent hurt'; break;
                    case 'caught': howOut = (fielder && bowler && nk(fielder) === nk(bowler)) ? `c & b ${bowler}` : `c ${behind ? '†' : ''}${fielder || ''} b ${bowler || ''}`.replace(/\s+/g, ' ').trim(); break;
                    case 'stumped': howOut = `st ${fielder || ''} b ${bowler || ''}`.replace(/\s+/g, ' ').trim(); break;
                    case 'runout': howOut = fielder ? `run out (${fielder})` : 'run out'; break;
                    case 'bowled': howOut = `b ${bowler || ''}`.trim(); break;
                    case 'lbw': howOut = `lbw b ${bowler || ''}`.trim(); break;
                    case 'hitwicket': howOut = `hit wkt b ${bowler || ''}`.trim(); break;
                    case 'retiredout': howOut = 'retired out'; break;
                    case 'timedout': howOut = 'timed out'; break;
                    case 'obstructing': howOut = 'obstructing the field'; break;
                    case 'hittwice': howOut = 'hit the ball twice'; break;
                    default: howOut = clean(r.dismissal) || 'not out';
                }
                const row = { name: display(p, r.name), id: idOf(p), runs: r.runs, balls: r.balls, fours: r.fours, sixes: r.sixes, out: !!d.wicket, howOut, inningsNo: no, battingPosition: pos + 1 };
                if (d.kind === 'retiredhurt') { row.retiredHurt = true; row.retiredHurtCount = 1; }
                if (d.kind === 'absent') { row.absentHurt = true; row.dismissalType = 'Absent Hurt'; }
                if (d.wicket) {
                    row.dismissalType = DISMISSAL_TYPE[d.kind] || 'Out';
                    row.fielderName = fielder || null;
                    row.bowlerName = d.bowlerWicket ? (bowler || null) : null;
                    row.retiredHurtCount = 0;
                }
                if (r.sourceName && nk(r.sourceName) !== nk(row.name)) row.sourceName = r.sourceName;
                battingCard[bat].push(row);
            });
            (inn.bowling || []).forEach((b, pos) => {
                const p = byKey.get(keyOf(bowl, b.name, b.sourceName));
                const balls = M.oversToBalls(b.overs);
                const row = {
                    name: display(p, b.name), id: idOf(p), overs: Math.floor(balls / 6), balls: balls % 6, maidens: b.maidens, runs: b.runs, wickets: b.wickets,
                    dots: b.dots, noBalls: b.noBalls, wides: b.wides, inningsNo: no, bowlingPosition: pos + 1
                };
                if (b.sourceName && nk(b.sourceName) !== nk(row.name)) row.sourceName = b.sourceName;
                bowlingCard[bowl].push(row);
            });
            const e = inn.extras || {};
            const ex = { wd: e.wides, nb: e.noBalls, b: e.byes, lb: e.legByes, pen: e.penalty };
            // the record keeps one extras block per team (a Test adds both innings up;
            // each innings' own is in inningsArchive). An unknown part stays unknown.
            ['wd', 'nb', 'b', 'lb', 'pen'].forEach(k => {
                if (ex[k] === null || ex[k] === undefined) extras[bat][k] = null;
                else if (extras[bat][k] !== null) extras[bat][k] += ex[k];
            });
            if (M.extrasSum(e) === null && intOrNull(e.total) !== null) extras[bat].total = (extras[bat].total || 0) + intOrNull(e.total);
            (inn.fallOfWickets || []).forEach(w => {
                const p = w.batter ? playerFor(bat, w.batter) : null;
                fallOfWickets[bat].push(Object.assign({ wkt: w.wicket, runs: w.runs, over: w.overs ? (oversOB(M.oversToBalls(w.overs)) || String(w.overs)) : null, inningsNo: no }, w.batter ? { batter: display(p, w.batter) } : {}));
            });
            const tb = M.oversToBalls(inn.total && inn.total.overs);
            totals[bat].runs += intOrNull(inn.total && inn.total.runs) || 0;
            totals[bat].balls += (typeof tb === 'number' && isFinite(tb)) ? tb : 0;
            totals[bat].wickets = intOrNull(inn.total && inn.total.wickets) || 0;
            totals[bat].any = true;
            if (i < inns.length - 1) {
                inningsArchive.push({ no, team: bat, runs: intOrNull(inn.total && inn.total.runs) || 0, wickets: intOrNull(inn.total && inn.total.wickets) || 0, overs: oversOB(tb) || '0.0', declared: !!(inn.total && inn.total.declared), extras: Object.assign({}, ex) });
            }
        });
        const score = (s) => ({ runs: totals[s].runs, wickets: totals[s].wickets, overs: totals[s].any ? oversOB(totals[s].balls) : '0.0' });

        // squads: everyone of the side on this scorecard, batting order first
        const squad = (side) => {
            const seen = new Set(), players = [];
            playerPlan.players.filter(p => p.side === side).sort((a, b) => {
                const pos = (p) => { const w = p.where.find(x => x.startsWith('bat')); return w ? 0 : (p.where.some(x => x.startsWith('dnb')) ? 1 : 2); };
                return pos(a) - pos(b);
            }).forEach(p => {
                const id = idOf(p);
                const k = id || nk(p.final ? p.final.name : p.name);
                if (seen.has(k)) return;
                seen.add(k);
                players.push({ id, name: display(p, p.name), isXI: true });
            });
            const capt = (draft.innings || []).flatMap(inn => (inn.battingSide === side ? inn.batting : [])).find(r => r.captain);
            const wk = (draft.innings || []).flatMap(inn => (inn.battingSide === side ? inn.batting : [])).find(r => r.wk);
            const idFor = (r) => r ? idOf(byKey.get(keyOf(side, r.name, r.sourceName))) : null;
            return { players, captainId: idFor(capt) || null, wkId: idFor(wk) || null };
        };

        // the result
        const res = resultOf(draft, teams);
        const meta = draft.meta || {};
        const matchId = `imp-${String(draft._id).replace(/^sci_/, '')}`;
        const rec = {
            ownerUid: ctx.ownerUid, leagueKey: ctx.leagueKey, matchId, roomId: null,
            matchNo: intOrNull(meta.matchNo), matchTitle: strCap(meta.title, 80) || '', matchDate: meta.date || null,
            locked: false, impactPlayers: [], upcoming: false,
            // the tournament page dates and orders matches by savedAt: the day the
            // match was played, not the day it was imported (importedAt below)
            savedAt: meta.date ? `${meta.date}T12:00:00.000Z` : new Date(now()).toISOString(),
            venue: strCap(meta.venue, 80) || '', streamUrl: '', format: meta.format,
            customOvers: meta.format === 'Custom' ? (intOrNull(meta.overs) || null) : null, matchStage: strCap(meta.stage, 40) || '',
            teamA: { name: teams.A.name, short: teams.A.short || '', color: teams.A.color || '', logoUrl: teams.A.logoUrl || '', teamId: teams.A.teamId || null },
            teamB: { name: teams.B.name, short: teams.B.short || '', color: teams.B.color || '', logoUrl: teams.B.logoUrl || '', teamId: teams.B.teamId || null },
            winningTeam: res.winningTeam, scoreA: score('A'), scoreB: score('B'),
            battingCard, bowlingCard, squadA: squad('A'), squadB: squad('B'), inningsArchive, extras, fallOfWickets,
            partnerships: {}, resultText: res.text || null, superOver: null,
            importSource: {
                kind: 'scorecard', importId: draft._id, importedAt: opts.importedAt || null, importedBy: opts.importedBy || null,
                reader: (draft.read && draft.read.scorecard && draft.read.scorecard.by) || 'manual',
                photos: (draft.photos || []).filter(p => p.kind === 'scorecard').map(p => ({ sha256: p.sha256, innings: p.innings })),
                commentary: !!opts.hasCommentary, ballByBall: false, clips: false,
                acknowledged: opts.acknowledged || []
            }
        };
        return JSON.parse(JSON.stringify(rec));
    }
    function resultOf(draft, teams) {
        const ov = draft.decisions && draft.decisions.result;
        const match = modelOf(draft, teams);
        const auto = M.computeResult(match);
        const label = (s) => String((teams[s] && (teams[s].short || teams[s].name)) || s).toUpperCase();
        const textFor = (r) => {
            if (r.winner === 'TIE') return 'MATCH TIED';
            if (r.winner === 'NR') return 'NO RESULT';
            if (r.winner === 'DRAW') return 'MATCH DRAWN';
            if (r.winner === 'A' || r.winner === 'B') {
                if (r.byRuns != null) return `${label(r.winner)} WON BY ${r.byRuns} RUN${r.byRuns === 1 ? '' : 'S'}`;
                if (r.byWickets != null) return `${label(r.winner)} WON BY ${r.byWickets} WICKET${r.byWickets === 1 ? '' : 'S'}`;
                return `${label(r.winner)} WON`;
            }
            return null;
        };
        if (ov && ['A', 'B', 'TIE', 'NR', 'DRAW'].includes(ov.winner)) {
            return { winningTeam: ov.winner, text: strCap(ov.text, 80) || textFor(ov), auto, override: true, reason: strCap(ov.reason, 200) || '' };
        }
        if (auto.decided) return { winningTeam: auto.winner, text: textFor(auto), auto, override: false };
        return { winningTeam: null, text: null, auto, override: false };
    }
    function modelOf(draft, teams) {
        const meta = draft.meta || {};
        const overs = meta.format === 'Custom' ? intOrNull(meta.overs) : FORMATS[meta.format] || null;
        return { teams: { A: { name: teams && teams.A ? teams.A.name : 'A' }, B: { name: teams && teams.B ? teams.B.name : 'B' } }, overs, innings: draft.innings || [], result: { override: !!(draft.decisions && draft.decisions.result && draft.decisions.result.winner) } };
    }

    // ---- totals per player over a set of records (as the leaderboard counts) ----
    function playerTotals(recs) {
        const bat = new Map(), bowl = new Map();
        deps.playedMatches(recs).forEach(m => SIDES.forEach(s => {
            ((m.battingCard && m.battingCard[s]) || []).forEach(b => { if (!b || !b.name) return; const k = pk(b.name); const r = bat.get(k) || { innings: 0, runs: 0 }; r.innings++; r.runs += b.runs || 0; bat.set(k, r); });
            ((m.bowlingCard && m.bowlingCard[s]) || []).forEach(b => { if (!b || !b.name) return; const k = pk(b.name); const r = bowl.get(k) || { innings: 0, wickets: 0, runs: 0 }; r.innings++; r.wickets += b.wickets || 0; r.runs += b.runs || 0; bowl.set(k, r); });
        }));
        return { bat, bowl };
    }

    // ---- everything the page shows before saving ----
    const lightPlan = (p) => Object.assign({}, p, { similar: (p.similar || []).map(s => Object.assign({}, s, { logoUrl: null, hasLogo: !!s.logoUrl })) });
    async function analyze(viewer, draftId, opts) {
        const draft = await draftFor(draftId);
        const ctx = await loadContext(draft.target.ownerUid, draft.target.leagueKey, opts && opts.fresh);
        const teamPlan = planTeams(draft, ctx);
        const playerPlan = planPlayers(draft, ctx, teamPlan);
        const teams = { A: teamPlan.plan.A.team || { name: '' }, B: teamPlan.plan.B.team || { name: '' } };
        const meta = draft.meta || {};
        const issues = [];
        const add = (level, id, message, extra) => issues.push(Object.assign({ id, level, message, ack: level === 'warning', innings: null, table: null, field: null, rowKey: null, side: null }, extra || {}));

        // match details: asked for, never guessed
        if (!FORMATS.hasOwnProperty(meta.format)) add('error', 'meta-format', 'Choose the match format (T20, ODI, Test or Custom overs).', { ack: false, table: 'meta', field: 'format' });
        if (meta.format === 'Custom' && !(intOrNull(meta.overs) >= 1 && intOrNull(meta.overs) <= 200)) add('error', 'meta-overs', 'Enter the overs per innings for this custom format.', { ack: false, table: 'meta', field: 'overs' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meta.date || '')) || isNaN(Date.parse(meta.date))) add('error', 'meta-date', 'Enter the date the match was played.', { ack: false, table: 'meta', field: 'date' });
        else if (Date.parse(meta.date) > now() + 36 * 3600 * 1000) add('error', 'meta-date-future', 'The match date is in the future.', { ack: false, table: 'meta', field: 'date' });
        if (!isStr(meta.venue)) add('error', 'meta-venue', 'Enter the ground / venue.', { ack: false, table: 'meta', field: 'venue' });
        if (!meta.confirmed) add('error', 'meta-confirm', 'Confirm the format, date and venue.', { ack: false, table: 'meta' });

        // the cricket
        const model = modelOf(draft, teams);
        const v = M.validateMatch(model, {});
        v.issues.forEach(i => issues.push(i));
        teamPlan.issues.forEach(i => issues.push(i));
        playerPlan.issues.forEach(i => issues.push(i));
        const res = resultOf(draft, teams);
        if (res.override && res.auto.decided && res.auto.winner !== res.winningTeam && !isStr(res.reason)) add('error', 'result-reason', 'The chosen result differs from the scores — say why (DLS, penalty, abandoned…).', { ack: false, table: 'result' });
        if (res.override && !res.auto.decided && !isStr(res.reason)) add('error', 'result-reason', 'Say why this is the result (DLS, abandoned, conceded…).', { ack: false, table: 'result' });

        // the same match imported twice?
        const date = meta.date || '';
        const dup = ctx.leagueRecs.find(r => {
            if (r.upcoming || (r.importSource && r.importSource.importId === draft._id)) return false;
            const same = (x, y) => nk(x && x.name) === nk(y && y.name);
            const sameTeams = (same(r.teamA, teams.A) && same(r.teamB, teams.B)) || (same(r.teamA, teams.B) && same(r.teamB, teams.A));
            const rd = String(r.matchDate || r.savedAt || '').slice(0, 10);
            return sameTeams && teams.A.name && rd === date;
        });
        if (dup) add('error', 'duplicate-match', `${dup.teamA.name} v ${dup.teamB.name} on ${date} is already in this tournament${dup.importSource ? ' (imported earlier)' : ''} — check it is not the same match before saving another.`, { ack: true, table: 'meta' });

        // tournament busy (a merge holds it)?
        if (deps.mergeLocked && deps.mergeLocked(ctx.ownerUid, ctx.leagueKey)) add('error', 'merge-lock', 'A tournament merge is running on this tournament — try again when it finishes.', { ack: false });
        if (draft.status === 'completed') add('error', 'already-saved', 'This scorecard has already been saved as a match.', { ack: false });

        // commentary (optional, display only)
        const commentary = {};
        Object.keys(draft.commentary || {}).forEach(n => {
            const c = draft.commentary[n];
            if (!c || !(c.entries || []).length) return;
            const inn = (draft.innings || [])[Number(n) - 1];
            const cov = commentaryCoverage(c.entries, inn);
            commentary[n] = Object.assign({ count: c.entries.length }, cov);
            if (!cov.complete) add('warning', `commentary-${n}`, `Innings ${n} commentary: ${cov.legal} legal balls and ${cov.runs} runs read, the scorecard says ${cov.inningsBalls === null ? '?' : cov.inningsBalls} balls and ${cov.inningsRuns === null ? '?' : cov.inningsRuns} runs — it will show as partial commentary (no end-of-over scores).`, { innings: Number(n) - 1, table: 'commentary' });
        });

        // acknowledgements
        const acks = (draft.decisions && draft.decisions.acknowledged) || {};
        issues.forEach(i => { if (i.ack && acks[i.id]) i.acknowledged = acks[i.id]; });
        const blocking = issues.filter(i => i.level === 'error' && !(i.ack && i.acknowledged));
        const pendingWarnings = issues.filter(i => i.level === 'warning' && !i.acknowledged);

        // what saving would do
        let preview = null;
        const ready = teamPlan.plan.A.team && teamPlan.plan.B.team && (draft.innings || []).length >= 2 && (draft.innings || []).every(i => i.battingSide);
        if (ready) {
            const rec = buildRecord(draft, ctx, teamPlan, playerPlan, {});
            const before = ctx.leagueRecs.filter(r => !(r.importSource && r.importSource.importId === draft._id));
            const after = before.concat([rec]);
            const tb = deps.computePointsTable(before), ta = deps.computePointsTable(after);
            const row = (t, name) => t.find(r => nk(r.team) === nk(name)) || null;
            const pb = playerTotals(before), pa = playerTotals(after);
            const playersOut = playerPlan.players.map(p => {
                const k = pk(p.final ? p.final.name : p.name);
                return {
                    key: p.key, name: p.final ? p.final.name : p.name, side: p.side,
                    batBefore: pb.bat.get(k) || null, batAfter: pa.bat.get(k) || null,
                    bowlBefore: pb.bowl.get(k) || null, bowlAfter: pa.bowl.get(k) || null
                };
            });
            preview = {
                record: rec,
                pointsTable: { before: tb, after: ta, teams: SIDES.map(s => ({ side: s, name: rec['team' + s].name, before: row(tb, rec['team' + s].name), after: row(ta, rec['team' + s].name) })) },
                players: playersOut,
                matchesBefore: deps.playedMatches(before).length, matchesAfter: deps.playedMatches(after).length
            };
        }
        return {
            draftId: draft._id, status: draft.status,
            target: draft.target,
            issues, blocking: blocking.length, pendingWarnings: pendingWarnings.length,
            // the options' logos can be large images: the page has them from
            // GET /tournaments/:ownerUid/:leagueKey, here only whether there is one
            teams: Object.assign({}, teamPlan, {
                options: teamPlan.options.map(o => Object.assign({}, o, { logoUrl: null, hasLogo: !!o.logoUrl })),
                plan: { A: lightPlan(teamPlan.plan.A), B: lightPlan(teamPlan.plan.B) }
            }),
            players: playerPlan.players,
            result: res, commentary, preview,
            canSave: !blocking.length && !!preview && draft.status !== 'completed'
        };
    }

    // ---- drafts ----
    function draftView(d) {
        if (!d) return null;
        const v = deepClone(d);
        v.draftId = v._id;
        v.photos = (v.photos || []).map(p => ({ id: p.id, kind: p.kind, innings: p.innings, order: p.order, mediaType: p.mediaType, bytes: p.bytes, width: p.width || null, height: p.height || null, name: p.name || '' }));
        return v;
    }
    async function draftFor(id) {
        const d = await db.imports.findOne({ _id: String(id || '') });
        if (!d) throw httpError(404, 'Import not found');
        return d;
    }
    async function createDraft(viewer, body) {
        body = body || {};
        const league = await loadLeague(String(body.ownerUid || ''), String(body.leagueKey || ''));
        const info = league.info || {};
        const fmt = FORMATS.hasOwnProperty(info.format) ? info.format : null;
        const d = {
            _id: newId('sci_'), status: 'draft',
            target: { ownerUid: league.ownerUid, leagueKey: league.leagueKey, displayName: league.displayName || league.leagueKey, token: league.publicToken || null },
            createdBy: viewerEmail(viewer), createdAt: now(), updatedAt: now(), expiresAt: new Date(now() + DRAFT_DAYS * 86400000),
            // the tournament's own default format, still to be confirmed
            meta: { format: fmt, overs: fmt === 'Custom' ? (info.overs || null) : (fmt ? FORMATS[fmt] : null), date: null, venue: info.venue || '', title: '', matchNo: null, stage: '', confirmed: false },
            photos: [], read: { scorecard: { state: 'idle' }, commentary: {} },
            teams: { A: {}, B: {} }, innings: [], commentary: {},
            decisions: { players: {}, acknowledged: {}, result: null }
        };
        await db.imports.insertOne(d);
        return draftView(d);
    }
    async function getDraft(viewer, id) { return draftView(await draftFor(id)); }
    async function listDrafts(viewer) {
        const list = await db.imports.find({}).sort({ updatedAt: -1 }).limit(30).toArray();
        return list.map(d => ({
            draftId: d._id, status: d.status, target: d.target, updatedAt: d.updatedAt, createdBy: d.createdBy,
            teams: SIDES.map(s => (d.teams[s] && d.teams[s].choice && d.teams[s].choice.name) || (d.teams[s] && d.teams[s].printed) || null),
            date: d.meta && d.meta.date, matchId: d.result ? d.result.matchId : null, photos: (d.photos || []).length
        }));
    }
    async function updateDraft(viewer, id, patch) {
        const d = await draftFor(id);
        if (d.status === 'completed' || d.status === 'saving') throw httpError(409, d.status === 'completed' ? 'This import has already been saved.' : 'This import is being saved.');
        patch = patch || {};
        const set = { updatedAt: now() };
        if (patch.meta) {
            const m = patch.meta;
            const fmt = FORMATS.hasOwnProperty(m.format) ? m.format : null;
            set.meta = {
                format: fmt,
                overs: fmt === 'Custom' ? numCap(m.overs, 200) : (fmt ? FORMATS[fmt] : null),
                date: /^\d{4}-\d{2}-\d{2}$/.test(String(m.date || '')) ? m.date : null,
                venue: strCap(m.venue, 80) || '', title: strCap(m.title, 80) || '', matchNo: numCap(m.matchNo, 999), stage: strCap(m.stage, 40) || '',
                confirmed: !!m.confirmed
            };
        }
        if (patch.innings) {
            set.innings = sanitizeInnings(patch.innings, (set.meta || d.meta).format);
            if (patch.reader === 'browser' || patch.reader === 'manual') set['read.scorecard'] = Object.assign({}, d.read && d.read.scorecard, { state: 'done', by: patch.reader, finishedAt: now() });
        }
        if (patch.teams) {
            const t = {};
            SIDES.forEach(s => {
                const x = patch.teams[s] || {};
                const ch = x.choice || {};
                const logo = ch.logo || {};
                const okLogo = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(String(logo.dataUrl || '')) && String(logo.dataUrl).length <= 120000 ? logo.dataUrl : null;
                t[s] = {
                    printed: strCap(x.printed !== undefined ? x.printed : (d.teams[s] && d.teams[s].printed), 80),
                    choice: {
                        mode: ch.mode === 'existing' || ch.mode === 'new' ? ch.mode : null, ref: strCap(ch.ref, 120), name: strCap(ch.name, 60),
                        short: strCap(ch.short, 6), color: strCap(ch.color, 9), saveTeam: ch.saveTeam !== false,
                        logo: { mode: ['keep', 'upload', 'none'].includes(logo.mode) ? logo.mode : 'keep', dataUrl: okLogo, replaceConfirmed: !!logo.replaceConfirmed }
                    },
                    confirmed: !!x.confirmed
                };
            });
            set.teams = t;
        }
        if (patch.decisions) {
            const dz = patch.decisions;
            const players = {};
            Object.keys(dz.players || {}).slice(0, 120).forEach(k => {
                const v = dz.players[k] || {};
                if (v.mode === 'existing') players[k] = { mode: 'existing', id: strCap(v.id, 64), name: strCap(v.name, 60) };
                else if (v.mode === 'new') players[k] = { mode: 'new', name: strCap(v.name, 60) };
            });
            const acknowledged = {};
            Object.keys(dz.acknowledged || {}).slice(0, 80).forEach(k => {
                const a = dz.acknowledged[k] || {};
                acknowledged[strCap(k, 120)] = { reason: strCap(a.reason, 200) || '', at: (d.decisions.acknowledged[k] && d.decisions.acknowledged[k].at) || now(), by: viewerEmail(viewer) };
            });
            const r = dz.result;
            set.decisions = {
                players, acknowledged,
                result: r && ['A', 'B', 'TIE', 'NR', 'DRAW'].includes(r.winner) ? { winner: r.winner, byRuns: numCap(r.byRuns, 999), byWickets: numCap(r.byWickets, 10), text: strCap(r.text, 80), reason: strCap(r.reason, 200) } : null
            };
        }
        if (patch.commentary) {
            const c = {};
            Object.keys(patch.commentary).filter(n => ['1', '2', '3', '4'].includes(String(n))).forEach(n => {
                const s = sanitizeCommentary(patch.commentary[n]);
                c[n] = Object.assign({}, (d.commentary || {})[n] || {}, { entries: s.entries, notes: s.notes, editedAt: now() });
            });
            set.commentary = Object.assign({}, d.commentary || {}, c);
        }
        await db.imports.updateOne({ _id: d._id, status: { $in: ['draft', 'failed'] } }, { $set: set });
        return draftView(await draftFor(id));
    }
    async function deleteDraft(viewer, id) {
        const d = await draftFor(id);
        if (d.status === 'saving') throw httpError(409, 'This import is being saved.');
        await db.photos.deleteMany({ draftId: d._id });
        if (d.status !== 'completed') await db.imports.deleteOne({ _id: d._id });
        return { deleted: true };
    }

    // ---- photos ----
    function imageSize(buf, type) {
        try {
            if (type === 'image/png' && buf.length > 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
            if (type === 'image/jpeg') {
                let i = 2;
                while (i < buf.length - 9) {
                    if (buf[i] !== 0xff) { i++; continue; }
                    const marker = buf[i + 1];
                    const len = buf.readUInt16BE(i + 2);
                    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
                    i += 2 + len;
                }
            }
            if (type === 'image/webp' && buf.length > 30 && buf.toString('ascii', 12, 16) === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
        } catch (e) { /* unknown */ }
        return { width: null, height: null };
    }
    function sniffType(buf) {
        if (!buf || buf.length < 12) return null;
        if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
        if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
        if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
        return null;
    }
    async function addPhoto(viewer, id, q, buf) {
        const d = await draftFor(id);
        if (d.status === 'completed' || d.status === 'saving') throw httpError(409, 'This import has already been saved.');
        if (!Buffer.isBuffer(buf) || !buf.length) throw httpError(400, 'No photo received.');
        if (buf.length > MAX_PHOTO_BYTES) throw httpError(413, 'That photo is too large (6 MB max).');
        const type = sniffType(buf);
        if (!type || !PHOTO_TYPES.has(type)) throw httpError(415, 'Photos must be JPG, PNG or WebP images.');
        if ((d.photos || []).length >= MAX_PHOTOS) throw httpError(400, `At most ${MAX_PHOTOS} photos per scorecard.`);
        const kind = q.kind === 'commentary' ? 'commentary' : 'scorecard';
        const innings = Math.min(4, Math.max(1, intOrNull(q.innings) || 1));
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        if ((d.photos || []).some(p => p.sha256 === hash && p.kind === kind)) throw httpError(409, 'This photo is already added.', { code: 'DUPLICATE_PHOTO' });
        const photo = {
            id: newId('ph_'), kind, innings, order: (d.photos || []).reduce((n, p) => Math.max(n, typeof p.order === 'number' ? p.order : -1), -1) + 1,
            mediaType: type, bytes: buf.length, sha256: hash, name: strCap(q.name, 80) || '', ...imageSize(buf, type)
        };
        // stored as base64 text: the same on every driver / test store
        await db.photos.insertOne({ _id: photo.id, draftId: d._id, data: buf.toString('base64'), mediaType: type, createdAt: now(), expiresAt: d.expiresAt });
        await db.imports.updateOne({ _id: d._id }, { $push: { photos: photo }, $set: { updatedAt: now() } });
        return draftView(await draftFor(id));
    }
    async function updatePhotos(viewer, id, list) {
        const d = await draftFor(id);
        if (d.status === 'completed' || d.status === 'saving') throw httpError(409, 'This import has already been saved.');
        const byId = new Map((d.photos || []).map(p => [p.id, p]));
        const next = [];
        (Array.isArray(list) ? list : []).forEach((x, i) => {
            const p = byId.get(x && x.id);
            if (!p) return;
            next.push(Object.assign({}, p, { innings: Math.min(4, Math.max(1, intOrNull(x.innings) || p.innings)), kind: x.kind === 'commentary' ? 'commentary' : (x.kind === 'scorecard' ? 'scorecard' : p.kind), order: i }));
            byId.delete(p.id);
        });
        // photos left out of the list are removed
        for (const p of byId.values()) await db.photos.deleteOne({ _id: p.id, draftId: d._id });
        await db.imports.updateOne({ _id: d._id }, { $set: { photos: next, updatedAt: now() } });
        return draftView(await draftFor(id));
    }
    async function getPhoto(viewer, id, photoId) {
        const d = await draftFor(id);
        const meta = (d.photos || []).find(p => p.id === photoId);
        const doc = meta ? await db.photos.findOne({ _id: photoId, draftId: d._id }) : null;
        if (!doc) throw httpError(404, 'Photo not found');
        return { mediaType: doc.mediaType, data: Buffer.from(String(doc.data || ''), 'base64') };
    }

    // ---- reading the photos ----
    function readerAvailable() { return !!(deps.extractor && deps.extractor.available && deps.extractor.available()); }
    async function photoInputs(d, kind, innings) {
        const list = (d.photos || []).filter(p => p.kind === kind && (innings == null || p.innings === innings)).sort((a, b) => (a.innings - b.innings) || (a.order - b.order));
        const out = [];
        for (const p of list) {
            const doc = await db.photos.findOne({ _id: p.id, draftId: d._id });
            if (!doc) continue;
            out.push({ id: p.id, mediaType: p.mediaType, data: String(doc.data || ''), innings: p.innings });
        }
        return out;
    }
    async function startRead(viewer, id, body) {
        if (!readerAvailable()) throw httpError(503, 'Automatic photo reading is not set up on the server (ANTHROPIC_API_KEY). Read them in the browser or type the figures.', { code: 'NO_READER' });
        const d = await draftFor(id);
        if (d.status === 'completed' || d.status === 'saving') throw httpError(409, 'This import has already been saved.');
        const kind = body && body.kind === 'commentary' ? 'commentary' : 'scorecard';
        const innings = kind === 'commentary' ? Math.min(4, Math.max(1, intOrNull(body.innings) || 1)) : null;
        const jk = `${d._id}|${kind}|${innings || ''}`;
        if (jobs.has(jk)) return draftView(d);
        const photos = (d.photos || []).filter(p => p.kind === kind && (innings == null || p.innings === innings));
        if (!photos.length) throw httpError(400, kind === 'commentary' ? `Add commentary photos for innings ${innings} first.` : 'Add the scorecard photos first.');
        const path = kind === 'commentary' ? `read.commentary.${innings}` : 'read.scorecard';
        await db.imports.updateOne({ _id: d._id }, { $set: { [path]: { state: 'running', startedAt: now(), photos: photos.length, progress: { done: 0, total: kind === 'commentary' ? Math.ceil(photos.length / 8) : 1 } }, updatedAt: now() } });
        const job = (kind === 'commentary' ? runCommentaryRead(d._id, innings) : runScorecardRead(d._id))
            .catch(async (err) => {
                log('Scorecard import read error:', err && err.message ? err.message : err);
                await db.imports.updateOne({ _id: d._id }, { $set: { [path]: { state: 'failed', finishedAt: now(), error: err && err.code && err.message ? err.message : 'The photos could not be read — try again, or type the figures.', code: (err && err.code) || 'ERROR', retryable: !!(err && err.retryable) } } });
            })
            .finally(() => jobs.delete(jk));
        jobs.set(jk, job);
        if (deps.awaitReads) await job;
        return draftView(await draftFor(id));
    }
    async function runScorecardRead(draftId) {
        const d = await draftFor(draftId);
        const photos = await photoInputs(d, 'scorecard', null);
        const teamNames = SIDES.map(s => { const t = d.teams && d.teams[s]; return t && t.choice && t.choice.name ? t.choice.name : null; });
        const meta = d.meta || {};
        const r = await deps.extractor.scorecard(photos, { teamA: teamNames[0], teamB: teamNames[1], format: meta.format, overs: meta.overs });
        const teams = { A: { name: teamNames[0] || '' }, B: { name: teamNames[1] || '' } };
        // photos added under "1st innings" are the first batting side (A)
        const slotSides = { 1: 'A', 2: 'B', 3: 'A', 4: 'B' };
        const x = M.fromExtraction(r.data, teams, slotSides);
        // names: kept as printed in sourceName, saved as first + last
        x.innings.forEach(inn => {
            const fix = (row) => { const n = normalizePlayerName(row.name); row.sourceName = n.original; row.name = n.display || n.original; };
            inn.batting.forEach(fix); inn.bowling.forEach(fix);
            inn.didNotBat = inn.didNotBat.map(n => normalizePlayerName(n).display || n);
            inn.fallOfWickets.forEach(w => { if (w.batter) w.batter = normalizePlayerName(w.batter).display || w.batter; });
        });
        const printedTeams = {};
        x.innings.forEach(inn => { if (inn.battingSide && inn.printedTeam && !printedTeams[inn.battingSide]) printedTeams[inn.battingSide] = inn.printedTeam; });
        const fresh = await draftFor(draftId);
        const meta2 = Object.assign({}, fresh.meta || {});
        const printed = x.printed || {};
        const set = {
            innings: sanitizeInnings(x.innings, meta2.format),
            'read.scorecard': { state: 'done', by: 'claude', model: r.model || null, finishedAt: now(), notes: x.notes.slice(0, 20), printed, usage: r.usage ? { input: r.usage.input_tokens || null, output: r.usage.output_tokens || null } : null },
            updatedAt: now()
        };
        SIDES.forEach(s => { if (printedTeams[s]) set[`teams.${s}.printed`] = strCap(printedTeams[s], 80); });
        await db.imports.updateOne({ _id: draftId }, { $set: set });
    }
    async function runCommentaryRead(draftId, innings) {
        const d = await draftFor(draftId);
        const photos = await photoInputs(d, 'commentary', innings);
        const chunks = [];
        const notes = [];
        for (let i = 0; i < photos.length; i += 8) {
            const part = photos.slice(i, i + 8);
            const inn = (d.innings || [])[innings - 1];
            const side = inn && inn.battingSide;
            const team = side && d.teams && d.teams[side] && d.teams[side].choice ? d.teams[side].choice.name : null;
            const r = await deps.extractor.commentary(part, { innings, battingTeam: team });
            const s = sanitizeCommentary(r.data);
            // photo numbers are per request: make them the draft's own
            s.entries.forEach(e => { if (e.photo) e.photo = e.photo + i; });
            chunks.push(s.entries);
            notes.push(...s.notes);
            await db.imports.updateOne({ _id: draftId }, { $set: { [`read.commentary.${innings}.progress`]: { done: chunks.length, total: Math.ceil(photos.length / 8) } } });
        }
        const entries = mergeCommentary(chunks);
        const fresh = await draftFor(draftId);
        await db.imports.updateOne({ _id: draftId }, {
            $set: {
                [`commentary.${innings}`]: { entries, notes: notes.slice(0, 20), readAt: now() },
                [`read.commentary.${innings}`]: { state: 'done', by: 'claude', finishedAt: now(), entries: entries.length },
                updatedAt: now()
            }
        });
        void fresh;
    }
    // a read cut off by a restart is reported, not left "running" forever
    async function recoverInterrupted() {
        const stale = await db.imports.find({ 'read.scorecard.state': 'running' }).toArray();
        for (const d of stale) await db.imports.updateOne({ _id: d._id }, { $set: { 'read.scorecard': { state: 'failed', error: 'Reading was interrupted by a server restart — read the photos again.', code: 'INTERRUPTED', retryable: true } } });
        const savingStale = await db.imports.find({ status: 'saving' }).toArray();
        for (const d of savingStale) await rollbackCommit(d, 'Saving was interrupted by a server restart — nothing was kept; save again.');
        return stale.length + savingStale.length;
    }

    // ---- saving the match ----
    async function commit(viewer, id, body) {
        body = body || {};
        let d = await draftFor(id);
        if (d.status === 'completed') return { duplicate: true, ...d.result };
        if (committing.has(d._id) || d.status === 'saving') throw httpError(409, 'This import is already being saved.', { code: 'IN_PROGRESS' });
        const key = strCap(body.idempotencyKey, 80);
        if (!key) throw httpError(400, 'idempotencyKey required');
        committing.add(d._id);
        try {
            const a = await analyze(viewer, d._id, { fresh: true });
            if (!a.canSave) throw httpError(400, 'The scorecard is not ready to save.', { code: 'NOT_READY', issues: a.issues.filter(i => i.level === 'error' && !(i.ack && i.acknowledged)).slice(0, 30) });
            if (body.confirm !== true) throw httpError(400, 'Confirm the import first.', { code: 'NOT_CONFIRMED' });
            const claimed = await db.imports.updateOne(
                { _id: d._id, status: { $in: ['draft', 'failed'] } },
                { $set: { status: 'saving', commit: { key, startedAt: now(), by: viewerEmail(viewer), created: {} } } }
            );
            d = claimed && claimed.matchedCount === 1 ? await draftFor(d._id) : null;
            if (!d || d.status !== 'saving') {
                const cur = await draftFor(id);
                if (cur.status === 'completed') return { duplicate: true, ...cur.result };
                throw httpError(409, 'This import is already being saved.', { code: 'IN_PROGRESS' });
            }
            try {
                const out = await writeImport(viewer, d);
                return out;
            } catch (err) {
                await rollbackCommit(await draftFor(d._id), err && err.message ? err.message : 'Saving failed');
                if (err && err.status) throw err;
                throw httpError(500, 'Saving failed — nothing was kept. Try again.', { code: 'SAVE_FAILED' });
            }
        } finally {
            committing.delete(String(id));
        }
    }
    async function noteCreated(draftId, path, value) {
        await db.imports.updateOne({ _id: draftId }, { $push: { [`commit.created.${path}`]: value } });
    }
    async function writeImport(viewer, d) {
        const ctx = await loadContext(d.target.ownerUid, d.target.leagueKey, true);
        const { ownerUid, leagueKey } = ctx;
        if (deps.mergeLocked && deps.mergeLocked(ownerUid, leagueKey)) throw httpError(423, 'A tournament merge is running on this tournament — try again when it finishes.', { code: 'TOURNAMENT_MERGE_IN_PROGRESS' });
        const teamPlan = planTeams(d, ctx);
        const playerPlan = planPlayers(d, ctx, teamPlan);
        if (playerPlan.issues.some(i => i.level === 'error') || teamPlan.issues.some(i => i.level === 'error')) throw httpError(400, 'Players or teams still need a decision.', { code: 'NOT_READY' });

        // 1) player ids: an existing player keeps his; a new one gets his own
        const ids = {};
        for (const p of playerPlan.players) {
            if (p.final.mode === 'existing' && p.final.id) continue;
            const existedBefore = await db.players.findOne({ ownerUid, nameKeys: pk(p.final.name) }, { projection: { playerId: 1 } });
            let id = null;
            if (p.final.mode === 'existing' || !existedBefore) id = await deps.resolvePlayerId(ownerUid, p.final.name);
            if (!id) id = await deps.resolvePlayerIdExplicit(ownerUid, 'p_' + crypto.randomBytes(6).toString('hex'), p.final.name);
            if (!id) throw new Error(`Could not register ${p.final.name}`);
            ids[p.key] = id;
            if (!existedBefore) await noteCreated(d._id, 'players', { id, key: pk(p.final.name) });
        }

        // 2) teams: a new team is created only when asked; nothing else changes
        const teamsOut = {};
        for (const side of SIDES) {
            const tp = teamPlan.plan[side];
            const t = Object.assign({}, tp.team);
            if (!tp.team.existing && tp.team.saveTeam && deps.saveTeamRecord) {
                const players = playerPlan.players.filter(p => p.side === side).map(p => ({ id: p.final.id || ids[p.key], name: p.final.name, isXI: true }));
                const r = await deps.saveTeamRecord(ownerUid, { name: t.name, short: t.short, color: t.color, logoUrl: tp.logo.mode === 'none' ? '' : tp.logo.url, players }, { mode: 'ensure', creatorEmail: viewerEmail(viewer) });
                // 201: made now; 200: one with this name already existed (reused)
                if (r && (r.status === 200 || r.status === 201) && r.body && r.body.team) {
                    t.teamId = r.body.team.teamId;
                    if (!r.body.reused) await noteCreated(d._id, 'teams', t.teamId);
                } else {
                    throw httpError(r && r.status >= 400 && r.status < 500 ? r.status : 500, (r && r.body && r.body.error) || `Could not create team "${t.name}"`);
                }
            }
            teamsOut[side] = t;
        }
        const teamPlanSaved = { plan: { A: Object.assign({}, teamPlan.plan.A, { team: teamsOut.A }), B: Object.assign({}, teamPlan.plan.B, { team: teamsOut.B }) } };

        // 3) the match record
        const acks = d.decisions && d.decisions.acknowledged ? Object.keys(d.decisions.acknowledged).map(k => ({ id: k, reason: d.decisions.acknowledged[k].reason || '', by: d.decisions.acknowledged[k].by || null })) : [];
        const hasCommentary = Object.keys(d.commentary || {}).some(n => (d.commentary[n].entries || []).length);
        const rec = buildRecord(d, ctx, teamPlanSaved, playerPlan, { ids, importedAt: now(), importedBy: viewerEmail(viewer), acknowledged: acks, hasCommentary });
        const exists = await db.records.findOne({ ownerUid, leagueKey, matchId: rec.matchId });
        if (exists && !(exists.importSource && exists.importSource.importId === d._id)) throw httpError(409, 'A different match already uses this id.');
        if (!exists) {
            if (deps.writeMatchRecord) await deps.writeMatchRecord({ ownerUid, leagueKey, matchId: rec.matchId }, rec);
            else await db.records.insertOne(rec);
        }
        await db.imports.updateOne({ _id: d._id }, { $set: { 'commit.created.matchId': rec.matchId } });

        // 4) commentary (shown on the match page; never counted anywhere)
        if (hasCommentary && db.commentary) {
            const innings = Object.keys(d.commentary).sort().map(n => {
                const inn = (d.innings || [])[Number(n) - 1];
                const cov = commentaryCoverage(d.commentary[n].entries || [], inn);
                return { innings: Number(n), battingTeam: inn ? inn.battingSide : null, complete: cov.complete, entries: (d.commentary[n].entries || []).map(e => ({ label: e.label, over: e.over, ball: e.ball, marker: e.marker, ballType: e.ballType, runs: e.runs, legal: e.legal, wicket: e.wicket, bowler: e.bowler, batter: e.batter, text: e.text })) };
            });
            await db.commentary.updateOne({ _id: `${ownerUid}|${leagueKey}|${rec.matchId}` }, { $set: { ownerUid, leagueKey, matchId: rec.matchId, source: 'scorecard-photos', innings, updatedAt: now() } }, { upsert: true });
        }

        // 5) the tournament's own team list: a new team is added, a missing logo filled in
        const league = await db.leagues.findOne({ ownerUid, leagueKey });
        if (league && league.info && Array.isArray(league.info.teams)) {
            const list = league.info.teams.slice();
            const before = deepClone(list);
            let changed = false;
            SIDES.forEach(side => {
                const t = teamsOut[side];
                const lg = teamPlan.plan[side].logo;
                const i = list.findIndex(x => nk(x && x.name) === nk(t.name));
                const small = /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(t.logoUrl || '') && t.logoUrl.length <= 40000 ? t.logoUrl : (/^https:\/\//.test(t.logoUrl || '') ? t.logoUrl : '');
                if (i === -1 && list.length < 40) { list.push({ name: t.name, short: String(t.short || '').toUpperCase().slice(0, 8), color: t.color || '', teamId: t.teamId || null, logoUrl: small }); changed = true; }
                else if (i >= 0 && (lg.mode === 'upload' || lg.mode === 'replace') && small && list[i].logoUrl !== small) { list[i] = Object.assign({}, list[i], { logoUrl: small }); changed = true; }
            });
            if (changed) {
                await db.imports.updateOne({ _id: d._id }, { $set: { 'commit.created.infoTeamsBefore': before } });
                await db.leagues.updateOne({ _id: league._id }, { $set: { 'info.teams': list } });
            }
        }
        await db.leagues.updateOne({ ownerUid, leagueKey }, { $set: { updatedAt: now() } });

        // 6) recalculated and checked before it counts as done
        const token = deps.ensureLeaguePublicToken ? await deps.ensureLeaguePublicToken(ownerUid, leagueKey) : (league && league.publicToken);
        try { deps.invalidateTournamentCaches && deps.invalidateTournamentCaches(token); } catch (e) { /* cache */ }
        const verification = await verifyImport(d, ctx, rec, playerPlan, ids);
        if (!verification.passed) throw httpError(500, 'The saved match did not check out — nothing was kept.', { code: 'VERIFY_FAILED', verification });

        const result = {
            matchId: rec.matchId, token: token || null,
            matchUrl: token ? `/cricket-scorecard?token=${encodeURIComponent(token)}&match=${encodeURIComponent(rec.matchId)}&history=1` : null,
            tournamentUrl: token ? `/score/tournament/${encodeURIComponent(token)}` : null,
            verification, savedAt: now(),
            summary: { teams: [rec.teamA.name, rec.teamB.name], result: rec.resultText, players: playerPlan.players.length, newPlayers: Object.keys(ids).length }
        };
        await db.imports.updateOne({ _id: d._id }, { $set: { status: 'completed', result, 'commit.finishedAt': now() } });
        ctxCache.delete(`${ownerUid}|${leagueKey}`);
        if (deps.logAuditAction) {
            try {
                await deps.logAuditAction(viewerEmail(viewer), 'Scorecard import', `${d.target.displayName}: ${rec.teamA.name} v ${rec.teamB.name}`, null,
                    { matchId: rec.matchId, result: rec.resultText }, { importId: d._id, matchId: rec.matchId, ownerUid, leagueKey, reader: rec.importSource.reader, acknowledged: acks.length, newPlayers: Object.keys(ids).length });
            } catch (e) { /* audit is best effort */ }
        }
        return Object.assign({ duplicate: false }, result);
    }
    async function verifyImport(d, ctx, rec, playerPlan, ids) {
        const checks = [];
        const add = (id, label, ok, detail) => checks.push({ id, label, ok: !!ok, detail: detail || null });
        const recs = await db.records.find({ ownerUid: ctx.ownerUid, leagueKey: ctx.leagueKey }).toArray();
        const mine = recs.filter(r => r.matchId === rec.matchId);
        add('match-once', 'The match is in the tournament exactly once', mine.length === 1, `${deps.playedMatches(recs).length} matches`);
        const saved = mine[0] || {};
        const same = ['scoreA', 'scoreB', 'winningTeam', 'battingCard', 'bowlingCard', 'extras'].every(k => JSON.stringify(saved[k]) === JSON.stringify(rec[k]));
        add('figures-saved', 'Every figure saved as checked', same);
        const before = recs.filter(r => r.matchId !== rec.matchId);
        const tb = deps.computePointsTable(before), ta = deps.computePointsTable(recs);
        const row = (t, n) => t.find(r => nk(r.team) === nk(n)) || { played: 0, points: 0, won: 0, lost: 0, tied: 0, noResult: 0 };
        let tableOk = true;
        SIDES.forEach(s => {
            const n = rec['team' + s].name, b = row(tb, n), a = row(ta, n);
            const expectPts = rec.winningTeam === s ? 2 : (rec.winningTeam === 'TIE' ? 1 : 0);
            if (a.played !== b.played + 1 || a.points !== b.points + expectPts) tableOk = false;
        });
        add('points-table', 'Points table counts the match once, with the right points', tableOk);
        const pb = playerTotals(before), pa = playerTotals(recs);
        let lbOk = true;
        const seen = new Set();
        SIDES.forEach(s => (rec.battingCard[s] || []).forEach(r => {
            const k = pk(r.name);
            if (seen.has('b' + k)) return;
            seen.add('b' + k);
            const added = SIDES.reduce((n, t) => n + (rec.battingCard[t] || []).filter(x => pk(x.name) === k).reduce((m, x) => m + (x.runs || 0), 0), 0);
            const b = (pb.bat.get(k) || { runs: 0 }).runs, a = (pa.bat.get(k) || { runs: 0 }).runs;
            if (a !== b + added) lbOk = false;
        }));
        SIDES.forEach(s => (rec.bowlingCard[s] || []).forEach(r => {
            const k = pk(r.name);
            if (seen.has('w' + k)) return;
            seen.add('w' + k);
            const added = SIDES.reduce((n, t) => n + (rec.bowlingCard[t] || []).filter(x => pk(x.name) === k).reduce((m, x) => m + (x.wickets || 0), 0), 0);
            const b = (pb.bowl.get(k) || { wickets: 0 }).wickets, a = (pa.bowl.get(k) || { wickets: 0 }).wickets;
            if (a !== b + added) lbOk = false;
        }));
        add('leaderboards', 'Leaderboards add the match\'s runs and wickets exactly once', lbOk);
        const allIds = SIDES.every(s => (rec.battingCard[s] || []).every(r => isStr(r.id)) && (rec.bowlingCard[s] || []).every(r => isStr(r.id)));
        add('player-ids', 'Every player has a player ID', allIds);
        const otherBefore = JSON.stringify(ctx.leagueRecs.filter(r => r.matchId !== rec.matchId).map(r => [r.matchId, r.winningTeam, r.scoreA, r.scoreB]));
        const otherAfter = JSON.stringify(before.map(r => [r.matchId, r.winningTeam, r.scoreA, r.scoreB]));
        add('others-untouched', 'Every other match unchanged', otherBefore === otherAfter);
        void ids; void playerPlan;
        return { passed: checks.every(c => c.ok), checks, at: now() };
    }
    async function rollbackCommit(d, message) {
        const created = (d && d.commit && d.commit.created) || {};
        try {
            if (created.matchId) {
                await db.records.deleteOne({ ownerUid: d.target.ownerUid, leagueKey: d.target.leagueKey, matchId: created.matchId, 'importSource.importId': d._id });
                if (db.commentary) await db.commentary.deleteOne({ _id: `${d.target.ownerUid}|${d.target.leagueKey}|${created.matchId}` });
            }
            if (Array.isArray(created.infoTeamsBefore)) await db.leagues.updateOne({ ownerUid: d.target.ownerUid, leagueKey: d.target.leagueKey }, { $set: { 'info.teams': created.infoTeamsBefore } });
            for (const teamId of (created.teams || [])) if (db.teams) await db.teams.deleteOne({ ownerUid: d.target.ownerUid, teamId });
            for (const c of (created.players || [])) {
                const playerId = c && c.id ? c.id : c;
                const used = await db.records.countDocuments({ ownerUid: d.target.ownerUid, $or: [{ 'squadA.players.id': playerId }, { 'squadB.players.id': playerId }] });
                if (!used) await db.players.deleteOne({ ownerUid: d.target.ownerUid, playerId });
            }
            if (deps.forgetPlayerIdCache && created.players && created.players.length) deps.forgetPlayerIdCache(d.target.ownerUid, created.players.map(c => c && c.key).filter(Boolean));
        } catch (err) {
            log('Scorecard import rollback error:', err);
        }
        await db.imports.updateOne({ _id: d._id }, { $set: { status: 'failed', 'commit.error': String(message || 'failed'), 'commit.rolledBackAt': now() } });
        ctxCache.delete(`${d.target.ownerUid}|${d.target.leagueKey}`);
    }

    async function history() {
        const list = await db.imports.find({ status: 'completed' }).sort({ updatedAt: -1 }).limit(30).toArray();
        return list.map(d => ({ draftId: d._id, target: d.target, result: d.result || null, createdBy: d.createdBy, date: d.meta && d.meta.date }));
    }

    return {
        listTournaments, tournamentContext: async (viewer, ownerUid, leagueKey) => {
            const ctx = await loadContext(ownerUid, leagueKey, true);
            return { tournament: { ownerUid, leagueKey, displayName: ctx.league.displayName || leagueKey, token: ctx.league.publicToken || null, info: ctx.league.info || {} }, teams: teamOptions(ctx), matchCount: deps.playedMatches(ctx.leagueRecs).length };
        },
        createDraft, getDraft, listDrafts, updateDraft, deleteDraft,
        addPhoto, updatePhotos, getPhoto, startRead, readerAvailable,
        analyze, commit, history, recoverInterrupted,
        // tests
        _internals: { planPlayers, planTeams, buildRecord, loadContext, playerTotals }
    };
}

module.exports = {
    createScorecardImport, normalizePlayerName, nameVariants, similarPlayerNames, parseMarker, sanitizeCommentary,
    mergeCommentary, commentaryCoverage, sanitizeInnings, FORMATS
};
