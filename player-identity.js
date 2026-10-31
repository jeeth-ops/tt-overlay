'use strict';
// ================================================================
// 🧬 PLAYER MERGE & MANAGEMENT — one real person, one Player ID.
//
// Two operations, both previewed first, both run as a journalled, staged
// migration that can be rolled back:
//
//   • CORRECT PLAYER NAME ('rename') — a player keeps their Player ID; the
//     name is corrected everywhere that player appears.
//   • GLOBAL PLAYER REPLACE ('merge') — one or more duplicate identities of
//     the same person (two spellings, an id made offline, an initial) are
//     folded into the MASTER the owner picks. The master keeps its own
//     Player ID; every reference to a duplicate is re-pointed to it; the
//     duplicate profiles are removed from the active players collection
//     once every reference has been verified as moved.
//
// What "everywhere" is in this app (see server.js):
//   players         — the profile: playerId, displayName, nameKeys (every
//                     spelling that resolves to it), batHand
//   teams           — saved teams: players [{ id, name }], captainId, wkId
//   matchRecords    — every saved match: squads, batting / bowling cards,
//                     dismissal text, partnerships, Impact Player swaps,
//                     Super Over cards
//   balls           — every delivery: striker / non-striker / bowler /
//                     dismissed batter / fielder (name, nameKey, Player ID)
//   clips           — clip metadata: the same player slots + ballMeta.
//                     Media fields (R2 / Drive keys and URLs, status) are
//                     never written — and checked unchanged afterwards
//   matchPanelStates / the live room (memory + Firestore) — the panel's own
//                     snapshot of a match (Resume, /cricket-scorecard?room=)
//   importedCommentary — commentary text of matches imported from photos
// Leaderboards, player statistics, points tables and player highlights are
// never stored: server.js rebuilds them from matchRecords / balls / clips on
// every read, so once the references are right they ARE consolidated —
// recalculated from the underlying cricket, never by adding displayed
// totals. The response caches are dropped after every operation.
//
// The rewriting itself is the Merge Tournaments engine's (tournament-
// merge.js → identity): a per-match rename map, resolved by Player ID first
// and by name only for a reference that carries no id, on the team that
// player plays for. Runs, wickets, overs, results and every delivery's
// outcome are copied as they are — a scoring fingerprint of every match is
// compared before and after.
//
// Never decided by a name alone: fuzzy matching only SUGGESTS duplicates;
// the owner picks the records and the master. Two records that played
// against each other, or batted / bowled in the same innings, are refused.
//
// Access: chhayajeeth@gmail.com only — fixed here, not configurable.
// ================================================================
const crypto = require('crypto');
const T = require('./tournament-merge.js').identity;

const IDENTITY_ADMIN_EMAIL = 'chhayajeeth@gmail.com';
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
function isIdentityAdminEmail(email) { return norm(email) === IDENTITY_ADMIN_EMAIL; }

// The stages an operation reports, in order (the progress screen shows them).
const STAGES = Object.freeze(['scanning', 'backing up', 'migrating', 'recalculating', 'verifying', 'cleaning up']);
const ROLLBACK_STAGES = Object.freeze(['checking', 'restoring', 'verifying']);
const SIDES = ['A', 'B'];
const otherSide = (s) => (s === 'A' ? 'B' : 'A');
const sideOf = (v) => (v === 'A' || v === 'B' ? v : null);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hashOf = (doc) => (doc == null ? 'none' : sha(T.stable(doc)));
// A profile's updatedAt moves every time a panel resolves that player (any
// squad save) — not a change to the player. Everything else about it is.
const hashIn = (coll, doc) => {
    if (doc == null) return 'none';
    if (coll === 'players') { const { updatedAt, ...rest } = doc; void updatedAt; return sha(T.stable(rest)); }
    return hashOf(doc);
};

// ---------------------------------------------------------------
// Names — normalisation and "could this be the same person?"
// ---------------------------------------------------------------
// lower case, accents off, punctuation as spaces, one space between words
function foldName(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[.'’`_\-,/()]/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
}
const tokensOf = (f) => f.split(' ').filter(Boolean);
const collapseDoubles = (s) => s.replace(/(\p{L})\1+/gu, '$1');
// How a word SOUNDS, roughly, for Indian / English spellings of one name:
// Mohammed ~ Muhammad, Siddiqui ~ Siddiqi, Shubhman ~ Shubman, Vaibhav ~ Waibhav.
function phonetic(w) {
    let x = collapseDoubles(w)
        .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/q/g, 'k').replace(/w/g, 'v').replace(/z/g, 'j')
        .replace(/([bdgkt])h/g, '$1').replace(/sh/g, 's').replace(/ee|ie|ea/g, 'i').replace(/oo|ou/g, 'u').replace(/aa/g, 'a')
        .replace(/y$/, 'i').replace(/h$/, '');
    return collapseDoubles(x);
}
// first letter + consonants of the phonetic form — vowels are where spellings differ most
const skeleton = (w) => { const p = phonetic(w); return p ? p[0] + p.slice(1).replace(/[aeiou]/g, '') : ''; };
function typoLimit(len) { return len >= 10 ? 2 : len >= 5 ? 1 : 0; }

// { level: 'exact' | 'high' | 'review', reason } — or null (not similar).
// A suggestion only: it never joins two players by itself.
function nameMatch(a, b) {
    const fa = foldName(a), fb = foldName(b);
    if (!fa || !fb) return null;
    if (fa === fb) return { level: 'exact', reason: 'Same name' };
    const ta = tokensOf(fa), tb = tokensOf(fb);
    if (fa.replace(/ /g, '') === fb.replace(/ /g, '')) return { level: 'high', reason: 'Same letters, different spacing' };
    if (ta.length === tb.length && ta.slice().sort().join(' ') === tb.slice().sort().join(' ')) return { level: 'high', reason: 'Same names, different order' };
    if (collapseDoubles(fa) === collapseDoubles(fb)) return { level: 'high', reason: 'A doubled letter' };
    // same first and last name, a middle name / initial added or left out
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (short.length >= 2 && long.length > short.length && short[0] === long[0] && short[short.length - 1] === long[long.length - 1]) {
        return { level: 'high', reason: long.length - short.length === 1 && long.slice(1, -1).every(t => t.length === 1) ? 'A middle initial added or left out' : 'A middle name added or left out' };
    }
    const d = T.levenshtein(fa, fb);
    if (d <= typoLimit(Math.min(fa.length, fb.length))) return { level: 'high', reason: d === 1 ? 'One letter different' : `${d} letters different` };
    if (ta.length === tb.length && ta.every((t, i) => phonetic(t) === phonetic(tb[i]))) return { level: 'high', reason: 'Spelled differently, sounds the same' };
    // an initial for a first name: "r sharma" ~ "rohit sharma", "rs sharma"
    const lastA = ta[ta.length - 1], lastB = tb[tb.length - 1];
    const sameLast = lastA === lastB || (Math.min(lastA.length, lastB.length) >= 5 && T.levenshtein(lastA, lastB) <= 1) || phonetic(lastA) === phonetic(lastB);
    if (ta.length >= 2 && tb.length >= 2 && sameLast) {
        // "r" / "rs" are initials; "rohit" stands for "r"
        const abbr = (t) => t.length === 1 || (t.length === 2 && !/[aeiou]/.test(t));
        const ini = (arr) => arr.map(t => (abbr(t) ? t : t[0])).join('');
        const firstsA = ta.slice(0, -1), firstsB = tb.slice(0, -1);
        if ((firstsA.every(abbr) || firstsB.every(abbr)) && (ini(firstsA).startsWith(ini(firstsB)) || ini(firstsB).startsWith(ini(firstsA)))) {
            return { level: 'review', reason: 'Initial and surname' };
        }
        if (skeleton(firstsA[0]) === skeleton(firstsB[0])) return { level: 'review', reason: 'Similar first name, same surname' };
    }
    // one name is the other with a surname added: "jeeth" ~ "jeeth chhaya"
    if (short.length === 1 && long.length >= 2 && short[0].length >= 3 && (long[0] === short[0] || long[long.length - 1] === short[0])) {
        return { level: 'review', reason: 'One is part of the other' };
    }
    if (ta.length === tb.length && ta.every((t, i) => skeleton(t) === skeleton(tb[i]))) return { level: 'review', reason: 'Similar sound' };
    if (T.similarNames(fa, fb)) return { level: 'review', reason: 'Similar spelling' };
    return null;
}
const LEVEL_RANK = { exact: 3, high: 2, review: 1 };

// How well a search text matches a name (0 = not at all).
function searchScore(q, name) {
    const fq = foldName(q), fn = foldName(name);
    if (!fq || !fn) return 0;
    if (fn === fq) return 100;
    if (fn.startsWith(fq)) return 92;
    const tq = tokensOf(fq), tn = tokensOf(fn);
    if (tq.every(t => tn.some(w => w.startsWith(t)))) return 86;
    if (fn.includes(fq)) return 80;
    if (fn.replace(/ /g, '').includes(fq.replace(/ /g, ''))) return 76;
    const m = nameMatch(fq, fn);
    if (m) return m.level === 'exact' ? 100 : m.level === 'high' ? 72 : 58;
    // a typo while still typing: every word of the query close to a word of the name
    if (tq.every(t => t.length >= 3 && tn.some(w => (w.startsWith(t.slice(0, -1)) || T.levenshtein(t, w.slice(0, t.length)) <= typoLimit(t.length) || phonetic(w).startsWith(phonetic(t)))))) return 54;
    return 0;
}

// ---------------------------------------------------------------
// Statistics of one identity, from saved scorecards
// ---------------------------------------------------------------
function emptyStats() {
    return {
        matchIds: new Set(), tournaments: new Set(), teams: new Map(),
        bat: { innings: 0, notOuts: 0, runs: 0, balls: 0, srRuns: 0, hs: 0, hsNotOut: false, fours: 0, sixes: 0, fifties: 0, hundreds: 0, ducks: 0 },
        bowl: { innings: 0, balls: 0, maidens: 0, runs: 0, wickets: 0, bestW: -1, bestR: 0, w3: 0, w4: 0, w5: 0 },
        field: { catches: 0, runOuts: 0, stumpings: 0 }, clips: 0, lastPlayed: null
    };
}
const ballsOfBowlingRow = (r) => (Number(r.overs) || 0) * 6 + (Number(r.balls) || 0);
function addBatting(s, r) {
    const runs = Number(r.runs) || 0;
    s.bat.innings++; s.bat.runs += runs;
    if (typeof r.balls === 'number' && isFinite(r.balls)) { s.bat.balls += r.balls; s.bat.srRuns += runs; }
    s.bat.fours += Number(r.fours) || 0; s.bat.sixes += Number(r.sixes) || 0;
    const notOut = !r.out;
    if (notOut) s.bat.notOuts++;
    if (runs > s.bat.hs || (runs === s.bat.hs && notOut && !s.bat.hsNotOut)) { s.bat.hs = runs; s.bat.hsNotOut = notOut; }
    if (runs >= 100) s.bat.hundreds++; else if (runs >= 50) s.bat.fifties++;
    if (runs === 0 && !notOut) s.bat.ducks++;
}
function addBowling(s, r) {
    const w = Number(r.wickets) || 0, runs = Number(r.runs) || 0;
    s.bowl.innings++; s.bowl.balls += ballsOfBowlingRow(r); s.bowl.maidens += Number(r.maidens) || 0; s.bowl.runs += runs; s.bowl.wickets += w;
    if (w > s.bowl.bestW || (w === s.bowl.bestW && runs < s.bowl.bestR)) { s.bowl.bestW = w; s.bowl.bestR = runs; }
    if (w >= 5) s.bowl.w5++; else if (w >= 4) s.bowl.w4++; else if (w >= 3) s.bowl.w3++;
}
// The players who PLAYED a match (the Playing XI, an Impact Player brought
// on, anyone on a batting or bowling card) and the team they played for —
// one definition for the counts, the preview and the verification.
function appearancesOf(r, resolveRow) {
    const out = new Map(); // identity -> side
    SIDES.forEach(side => {
        const sq = r['squad' + side];
        (sq && Array.isArray(sq.players) ? sq.players : []).forEach(p => {
            if (p && isStr(p.name) && (p.isXI !== false || p.impactIn)) { const id = resolveRow(p); if (id && !out.has(id)) out.set(id, side); }
        });
        ['battingCard', 'bowlingCard'].forEach(card => ((r[card] && r[card][side]) || []).forEach(row => {
            if (row && isStr(row.name)) { const id = resolveRow(row); if (id && !out.has(id)) out.set(id, side); }
        }));
    });
    return out;
}
function finishStats(s) {
    const b = s.bat, w = s.bowl;
    const outs = b.innings - b.notOuts;
    return {
        matches: s.matchIds.size, tournaments: s.tournaments.size, clips: s.clips, lastPlayed: s.lastPlayed,
        teams: [...s.teams.values()].sort((x, y) => y.n - x.n).map(t => t.name),
        batting: {
            innings: b.innings, notOuts: b.notOuts, runs: b.runs, balls: b.balls, fours: b.fours, sixes: b.sixes, fifties: b.fifties, hundreds: b.hundreds, ducks: b.ducks,
            highScore: b.innings ? `${b.hs}${b.hsNotOut ? '*' : ''}` : '—',
            average: outs > 0 ? (b.runs / outs).toFixed(2) : (b.innings ? '—' : '—'),
            strikeRate: b.balls ? ((b.srRuns / b.balls) * 100).toFixed(2) : '—'
        },
        bowling: {
            innings: w.innings, overs: `${Math.floor(w.balls / 6)}.${w.balls % 6}`, balls: w.balls, maidens: w.maidens, runs: w.runs, wickets: w.wickets,
            economy: w.balls ? (w.runs / (w.balls / 6)).toFixed(2) : '—',
            average: w.wickets ? (w.runs / w.wickets).toFixed(2) : '—',
            strikeRate: w.wickets ? (w.balls / w.wickets).toFixed(1) : '—',
            best: w.innings ? `${w.bestW}/${w.bestR}` : '—', threeW: w.w3, fourW: w.w4, fiveW: w.w5
        },
        fielding: { catches: s.field.catches, runOuts: s.field.runOuts, stumpings: s.field.stumpings }
    };
}

// ---------------------------------------------------------------
// The panel's own snapshot of a match (matchPanelStates / the live room):
// the squads and cards are shaped like a match record and go through the
// same rewriter; everything else (ball log, the batters / bowler tiles,
// maps keyed by Player ID) is walked — a value is changed only through a
// Player ID the map knows, or a name the map places on exactly one team.
// ---------------------------------------------------------------
const NAME_ONLY_FIELDS = new Set(['striker', 'nonStriker', 'bowler', 'batter', 'fielder', 'fielderName', 'bowlerName', 'strikerName', 'nonStrikerName', 'batterName', 'dismissedName', 'inName', 'outName', 'name']);
function uniqueSideCanon(mm, name, pk) {
    if (!isStr(name)) return null;
    const k = pk(name);
    if (!k) return null;
    const a = mm.A.has(k), b = mm.B.has(k);
    if (a === b) return null;
    return mm.canon[(a ? mm.A : mm.B).get(k)] || null;
}
function transformPanelState(state, map, pk) {
    const mm = T.hydrate(map);
    if (!mm || !state || typeof state !== 'object') return { doc: state, changes: 0 };
    const s = T.deepClone(state);
    let n = 0;
    // 1) squads + cards, exactly as on a match record
    const pseudo = { inningsArchive: s.inningsArchive, battingCard: s.battingCard, bowlingCard: s.bowlingCard };
    SIDES.forEach(side => {
        const t = s['team' + side];
        if (t && Array.isArray(t.players)) pseudo['squad' + side] = { players: t.players, captainId: t.captainId || null, wkId: t.wkId || null };
    });
    const out = T.transformRecord(pseudo, mm, null, pk);
    if (out.changes) {
        n += out.changes;
        if (s.battingCard) s.battingCard = out.doc.battingCard;
        if (s.bowlingCard) s.bowlingCard = out.doc.bowlingCard;
        SIDES.forEach(side => {
            const sq = out.doc['squad' + side], t = s['team' + side];
            if (sq && t) { t.players = sq.players; if ('captainId' in t || sq.captainId) t.captainId = sq.captainId; if ('wkId' in t || sq.wkId) t.wkId = sq.wkId; }
        });
    }
    // 2) everything else
    const skip = new Set(['battingCard', 'bowlingCard', 'teamA', 'teamB']);
    const canonById = (id) => (isStr(id) && mm.ids.has(id) ? mm.canon[mm.ids.get(id)] : null);
    const walk = (o, top) => {
        if (Array.isArray(o)) {
            let changed = false;
            for (let i = 0; i < o.length; i++) {
                const v = o[i];
                if (typeof v === 'string') { const c = canonById(v); if (c && c.id && c.id !== v) { o[i] = c.id; changed = true; n++; } }
                else if (v && typeof v === 'object') walk(v, false);
            }
            if (changed && o.every(x => typeof x === 'string')) { const u = [...new Set(o)]; o.length = 0; u.forEach(x => o.push(x)); }
            return;
        }
        for (const k of Object.keys(o)) {
            if (top && skip.has(k)) continue;
            const v = o[k];
            if (v && typeof v === 'object') { walk(v, false); continue; }
            if (typeof v !== 'string') continue;
            if (k === 'id' || /Id$/.test(k)) {
                const c = canonById(v);
                if (!c) continue;
                if (c.id && c.id !== v) { o[k] = c.id; n++; }
                const partners = k === 'id' ? ['name'] : [k.slice(0, -2), k.slice(0, -2) + 'Name'];
                partners.forEach(p => { if (c.name && isStr(o[p]) && o[p] !== c.name) { o[p] = c.name; n++; } });
            }
        }
        for (const k of Object.keys(o)) {
            if (top && skip.has(k)) continue;
            if (!NAME_ONLY_FIELDS.has(k) || !isStr(o[k])) continue;
            const idField = k === 'name' ? 'id' : (k.endsWith('Name') ? k.slice(0, -4) + 'Id' : k + 'Id');
            if (isStr(o[idField])) continue; // linked to an id: handled above
            const c = uniqueSideCanon(mm, o[k], pk);
            if (c && c.name && o[k] !== c.name) { o[k] = c.name; n++; }
        }
        // maps keyed by Player ID or by name (batHand, fieldingStats)
        for (const k of Object.keys(o)) {
            if (top && skip.has(k)) continue;
            let to = null;
            const c = canonById(k);
            if (c && c.id && c.id !== k) to = c.id;
            const m = /^(n:|name:)(.+)$/.exec(k);
            if (!to && m) { const cn = uniqueSideCanon(mm, m[2], pk); if (cn && cn.name && cn.name !== m[2]) to = m[1] + cn.name; }
            if (!to) continue;
            if (!(to in o)) o[to] = o[k];
            delete o[k];
            n++;
        }
    };
    walk(s, true);
    return { doc: s, changes: n };
}

// Commentary imported from scorecard photos: the batter (batting side) and
// the bowler (the other side) of every entry, and the names in its text.
function transformCommentary(doc, map, pk) {
    const mm = T.hydrate(map);
    if (!mm || !doc || !Array.isArray(doc.innings)) return { doc, changes: 0 };
    const d = T.deepClone(doc);
    let n = 0;
    const renames = [];
    SIDES.forEach(side => mm.names[side].forEach(([shown, i]) => { const c = mm.canon[i]; if (c && c.name && c.name !== shown) renames.push([shown, c.name]); }));
    d.innings.forEach(inn => {
        const bt = sideOf(inn && inn.battingTeam);
        (inn && Array.isArray(inn.entries) ? inn.entries : []).forEach(e => {
            if (!e) return;
            [['batter', bt], ['bowler', bt ? otherSide(bt) : null]].forEach(([f, side]) => {
                if (!isStr(e[f])) return;
                const c = side ? T.resolveRef(mm, side, e[f], [], pk) : uniqueSideCanon(mm, e[f], pk);
                if (c && c.name && e[f] !== c.name) { e[f] = c.name; n++; }
            });
            if (isStr(e.text) && renames.length) { const t = T.replaceNames(e.text, renames, []); if (t !== e.text) { e.text = t; n++; } }
        });
    });
    return { doc: d, changes: n };
}

// ================================================================
function createPlayerIdentity(deps) {
    const db = deps.db;
    const pk = deps.playerKey;
    const now = deps.now || (() => Date.now());
    const log = deps.log || (() => {});
    const newOpId = deps.newOpId || (() => 'pi_' + crypto.randomBytes(8).toString('hex'));
    const isTournamentLocked = deps.isTournamentLocked || (() => false);
    const rooms = deps.rooms || null;
    const LIVE_WINDOW_MS = deps.liveWindowMs || 3 * 60 * 60 * 1000;

    function httpError(status, message, extra) {
        const e = new Error(message);
        e.status = status;
        Object.assign(e, extra || {});
        return e;
    }
    function assertViewer(viewer) {
        if (!viewer || !isIdentityAdminEmail(viewer.email)) throw httpError(403, 'Access Denied');
    }

    // ---- which accounts the owner manages (every authorized creator) ----
    async function accountUids(viewer) {
        const out = [{ uid: viewer.uid, email: viewer.email }];
        for (const e of (deps.authorizedCreatorEmails || [])) {
            if (norm(e) === norm(viewer.email)) continue;
            try { const u = await deps.getUidForEmail(e); if (u && !out.some(x => x.uid === u)) out.push({ uid: u, email: norm(e) }); } catch (err) { /* not signed up yet */ }
        }
        return out;
    }
    async function checkAccount(viewer, ownerUid) {
        const list = await accountUids(viewer);
        const hit = list.find(a => a.uid === ownerUid);
        if (!hit) throw httpError(403, 'Access Denied');
        return hit;
    }

    // ---- locks: one operation per account at a time; its matches refuse saves meanwhile ----
    const active = new Map(); // ownerUid -> { opId, matchIds:Set }
    function lockFor(ownerUid, matchId) {
        const a = active.get(ownerUid);
        if (!a) return null;
        if (matchId !== undefined && matchId !== null && !a.matchIds.has(String(matchId))) return null;
        return a;
    }
    async function takeLock(ownerUid, opId, matchIds) {
        try { await db.locks.insertOne({ _id: 'identity:' + ownerUid, opId, createdAt: now() }); }
        catch (err) {
            const cur = await db.locks.findOne({ _id: 'identity:' + ownerUid });
            if (!cur || cur.opId !== opId) throw httpError(409, 'Another player operation is running on this account — wait for it to finish', { code: 'BUSY' });
        }
        active.set(ownerUid, { opId, matchIds: new Set(matchIds.map(String)) });
    }
    async function releaseLock(ownerUid, opId) {
        await db.locks.deleteOne({ _id: 'identity:' + ownerUid, opId }).catch(() => {});
        const a = active.get(ownerUid);
        if (a && a.opId === opId) active.delete(ownerUid);
    }

    // ================================================================
    // One account, read once: profiles, matches, deliveries' owners,
    // clips, teams — and every player identity in them with its numbers.
    // ================================================================
    const accountCache = new Map(); // ownerUid -> { at, ctx }
    function forgetAccount(ownerUid) { accountCache.delete(ownerUid); }
    const keysOfRec = (r) => [...new Set([r.roomId, r.matchId].filter(isStr).flatMap(x => [x, String(x).replace(/[^a-zA-Z0-9_-]/g, '')]).filter(Boolean))];

    async function loadAccount(ownerUid, opts) {
        opts = opts || {};
        const hit = accountCache.get(ownerUid);
        if (!opts.fresh && hit && now() - hit.at < 30000) return hit.ctx;
        const [profiles, tombs, recs, leagues, teams] = await Promise.all([
            db.players.find({ ownerUid }).toArray(),
            db.tombstones.find({ ownerUid }).toArray(),
            db.records.find({ ownerUid }).toArray(),
            db.leagues.find({ ownerUid }).toArray(),
            db.teams ? db.teams.find({ ownerUid }).toArray() : Promise.resolve([])
        ]);
        const prof = new Map(profiles.map(p => [p.playerId, p]));
        const tomb = new Map(tombs.map(t => [t.playerId, t]));
        const canon = (id) => {
            let x = id;
            for (let i = 0; i < 8; i++) {
                const p = prof.get(x);
                const nx = p ? p.mergedInto : (tomb.get(x) || {}).mergedInto;
                if (!isStr(nx) || nx === x) return x;
                x = nx;
            }
            return x;
        };
        const keyOwner = new Map();
        profiles.forEach(p => { if (!isStr(p.mergedInto)) (p.nameKeys || []).forEach(k => { if (isStr(k) && !k.startsWith('#')) keyOwner.set(k, p.playerId); }); });
        const leagueOf = new Map(leagues.map(l => [l.leagueKey, l]));
        // which deliveries / clips belong to which saved match (as Merge Tournaments decides it)
        const allKeys = [...new Set(recs.flatMap(keysOfRec))];
        const users = new Map();
        const ident = (r) => `${r.matchId}|${r.roomId || ''}`;
        recs.forEach(r => keysOfRec(r).forEach(k => { if (!users.has(k)) users.set(k, new Set()); users.get(k).add(ident(r)); }));
        const idsById = new Map();
        recs.forEach(r => { if (!idsById.has(r.matchId)) idsById.set(r.matchId, new Set()); idsById.get(r.matchId).add(ident(r)); });
        const ownKeys = new Map(), rules = new Map();
        recs.forEach(r => {
            const own = keysOfRec(r).filter(k => { const s = users.get(k); return !s || (s.size === 1 && s.has(ident(r))); });
            ownKeys.set(String(r._id), own);
            rules.set(String(r._id), { matchId: r.matchId, ownKeys: own, clash: (idsById.get(r.matchId) || new Set()).size > 1 });
        });
        const matchIds = recs.map(r => r.matchId).filter(isStr);
        const clips = (allKeys.length || matchIds.length)
            ? await db.clips.find({ $or: [{ matchId: { $in: allKeys } }, { tournamentMatchId: { $in: matchIds } }] }).toArray() : [];
        const clipsByRec = new Map();
        recs.forEach(r => { const rule = rules.get(String(r._id)); clipsByRec.set(String(r._id), clips.filter(c => T.clipBelongs(rule, c))); });

        // the identity a reference belongs to: its Player ID (after earlier
        // merges), else the profile that owns its name, else the name itself
        const identOf = (ref) => {
            for (const id of (ref.ids || [])) if (isStr(id)) return canon(id.trim());
            if (ref.key && keyOwner.has(ref.key)) return keyOwner.get(ref.key);
            return ref.key ? 'key:' + ref.key : null;
        };
        const stats = new Map();      // identity -> raw stats
        const names = new Map();      // identity -> Map(name -> count)
        const seenIn = new Map();     // identity -> Set(record _id)
        const S = (id) => { if (!stats.has(id)) stats.set(id, emptyStats()); return stats.get(id); };
        const noteName = (id, name) => { if (!isStr(name)) return; if (!names.has(id)) names.set(id, new Map()); const m = names.get(id); m.set(name.trim(), (m.get(name.trim()) || 0) + 1); };
        const playedRecs = recs.filter(r => r.upcoming !== true);
        const resolveRow = (p) => identOf({ ids: [p.id], key: pk(p.name) });
        recs.forEach(r => {
            const rid = String(r._id);
            T.recordRefs(r, pk).forEach(ref => {
                const id = identOf(ref);
                if (!id) return;
                noteName(id, ref.name);
                if (!seenIn.has(id)) seenIn.set(id, new Set());
                seenIn.get(id).add(rid);
            });
            if (r.upcoming === true) return;
            appearancesOf(r, resolveRow).forEach((side, id) => {
                const st = S(id);
                st.matchIds.add(rid);
                if (r.leagueKey) st.tournaments.add(r.leagueKey);
                const team = r['team' + side];
                if (team && isStr(team.name)) { const tk = norm(team.name); const cur = st.teams.get(tk) || { name: team.name.trim(), n: 0 }; cur.n++; st.teams.set(tk, cur); }
                const when = r.matchDate || (r.savedAt ? String(r.savedAt).slice(0, 10) : null);
                if (when && (!st.lastPlayed || when > st.lastPlayed)) st.lastPlayed = when;
            });
        });
        playedRecs.forEach(r => {
            SIDES.forEach(side => {
                ((r.battingCard && r.battingCard[side]) || []).forEach(row => {
                    if (!row || !isStr(row.name)) return;
                    const id = identOf({ ids: [row.id], key: pk(row.name) });
                    if (id) addBatting(S(id), row);
                    const how = String(row.dismissalType || row.howOut || '').toLowerCase();
                    const fielder = isStr(row.fielderName) ? row.fielderName : null;
                    const credit = (nm, f) => { const fid = identOf({ ids: [], key: pk(nm) }); if (fid) S(fid).field[f]++; };
                    if (row.out) {
                        if (/run ?out/.test(how) && fielder) credit(fielder, 'runOuts');
                        else if (/stump/.test(how) && fielder) credit(fielder, 'stumpings');
                        else if (/caught|^c /.test(how)) { if (fielder) credit(fielder, 'catches'); else if (/caught (and|&) bowled|^c ?& ?b/.test(how) && isStr(row.bowlerName)) credit(row.bowlerName, 'catches'); }
                    }
                });
                ((r.bowlingCard && r.bowlingCard[side]) || []).forEach(row => {
                    if (!row || !isStr(row.name)) return;
                    const id = identOf({ ids: [row.id], key: pk(row.name) });
                    if (id) addBowling(S(id), row);
                });
            });
        });
        // clips: every clip once per player it names
        recs.forEach(r => {
            (clipsByRec.get(String(r._id)) || []).forEach(c => {
                const ids = new Set();
                T.clipSlots(c).forEach(s => { const id = identOf({ ids: s.ids, key: isStr(s.name) ? pk(s.name) : null }); if (id) ids.add(id); });
                ids.forEach(id => { S(id).clips++; });
            });
        });
        // the teams saved in Tournament Manager / the panel
        const savedTeams = new Map(); // identity -> Set(team name)
        teams.forEach(t => (t.players || []).forEach(p => {
            if (!p || !isStr(p.id)) return;
            const id = canon(p.id);
            if (!savedTeams.has(id)) savedTeams.set(id, new Set());
            savedTeams.get(id).add(t.name);
            noteName(id, p.name);
        }));
        const all = new Set([...profiles.filter(p => !isStr(p.mergedInto)).map(p => p.playerId), ...stats.keys(), ...savedTeams.keys()]);
        const people = new Map();
        for (const id of all) {
            const p = prof.get(id);
            if (p && isStr(p.mergedInto)) continue;
            const nm = names.get(id);
            const top = nm ? [...nm.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
            const name = (p && isStr(p.displayName)) ? p.displayName : (top || (id.startsWith('key:') ? id.slice(4) : id));
            const st = finishStats(stats.get(id) || emptyStats());
            (savedTeams.get(id) || new Set()).forEach(tn => { if (!st.teams.some(x => norm(x) === norm(tn))) st.teams.push(tn); });
            const tourns = [...((stats.get(id) || emptyStats()).tournaments)].map(k => ({ leagueKey: k, name: (leagueOf.get(k) || {}).displayName || k }));
            people.set(id, {
                playerId: id, registered: !!p, unregistered: !p ? (id.startsWith('key:') ? 'name' : 'id') : null,
                name, aliases: [...new Set([...(p ? (p.nameKeys || []).filter(k => isStr(k) && !k.startsWith('#')) : []), ...(nm ? [...nm.keys()].map(pk) : [])])].filter(Boolean),
                spellings: nm ? [...nm.keys()] : [name],
                hand: p && (p.batHand === 'L' || p.batHand === 'R') ? p.batHand : null,
                createdAt: p ? p.createdAt || null : null,
                ...st, tournamentList: tourns,
                savedTeams: [...(savedTeams.get(id) || [])]
            });
        }
        const ctx = { ownerUid, profiles, prof, tomb, canon, keyOwner, recs, leagues, leagueOf, teams, clips, clipsByRec, ownKeys, rules, identOf, people, seenIn };
        accountCache.set(ownerUid, { at: now(), ctx });
        return ctx;
    }

    // Where two identities met in one match: on opposite teams, in the same
    // batting / bowling innings (never one person), or on the same side.
    function sharedMatches(ctx, a, b) {
        const out = [];
        const both = [...(ctx.seenIn.get(a) || [])].filter(rid => (ctx.seenIn.get(b) || new Set()).has(rid));
        for (const rid of both) {
            const r = ctx.recs.find(x => String(x._id) === rid);
            if (!r) continue;
            const refs = T.recordRefs(r, pk);
            const sides = (id) => new Set(refs.filter(x => ctx.identOf(x) === id && x.kind !== 'howOut').map(x => x.side).filter(Boolean));
            const sa = sides(a), sb = sides(b);
            let relation = 'same-side';
            if ([...sa].some(s => !sb.has(s)) || [...sb].some(s => !sa.has(s))) relation = 'opposite';
            const rowsIn = (id, card) => {
                const set = new Set();
                SIDES.forEach(side => ((r[card] && r[card][side]) || []).forEach(row => {
                    if (row && isStr(row.name) && ctx.identOf({ ids: [row.id], key: pk(row.name) }) === id) set.add(side + ':' + (Number(row.inningsNo) || 1));
                }));
                return set;
            };
            const batA = rowsIn(a, 'battingCard'), batB = rowsIn(b, 'battingCard'), bowlA = rowsIn(a, 'bowlingCard'), bowlB = rowsIn(b, 'bowlingCard');
            if (relation === 'same-side' && ([...batA].some(x => batB.has(x)) || [...bowlA].some(x => bowlB.has(x)))) relation = 'same-innings';
            out.push({ recId: rid, matchId: r.matchId, title: titleOf(r), tournament: (ctx.leagueOf.get(r.leagueKey) || {}).displayName || r.leagueKey, relation });
        }
        return out;
    }
    function titleOf(r) {
        const t = [r.teamA && r.teamA.name, r.teamB && r.teamB.name].filter(Boolean).join(' vs ');
        return (r.matchTitle ? r.matchTitle + ' · ' : (r.matchNo ? 'Match ' + r.matchNo + ' · ' : '')) + (t || r.matchId);
    }
    function personPublic(p) {
        if (!p) return null;
        const { savedTeams, ...rest } = p;
        return { ...rest, savedTeams };
    }

    // ---- duplicates: candidates for one player, and groups for the account ----
    function candidatesFor(ctx, id, opts) {
        const me = ctx.people.get(id);
        if (!me) return [];
        const out = [];
        for (const [oid, o] of ctx.people) {
            if (oid === id) continue;
            let best = null;
            for (const a of me.spellings.concat([me.name])) {
                for (const b of o.spellings.concat([o.name])) {
                    const m = nameMatch(a, b);
                    if (m && (!best || LEVEL_RANK[m.level] > LEVEL_RANK[best.level])) best = m;
                }
            }
            if (!best) continue;
            const met = sharedMatches(ctx, id, oid);
            const clash = met.find(m => m.relation === 'opposite' || m.relation === 'same-innings');
            out.push({
                ...personPublic(o),
                level: clash ? 'unlikely' : best.level, reason: best.reason,
                conflict: clash ? (clash.relation === 'opposite' ? `Played against each other — ${clash.title}` : `Both batted or bowled in one innings — ${clash.title}`) : null,
                sharedMatches: met
            });
        }
        const rank = { exact: 4, high: 3, review: 2, unlikely: 1 };
        out.sort((x, y) => (rank[y.level] - rank[x.level]) || (y.matches - x.matches));
        return opts && opts.limit ? out.slice(0, opts.limit) : out;
    }
    function duplicateGroups(ctx) {
        // compare only names that share a block (same surname sound, same squashed letters, same first-name sound)
        const blocks = new Map();
        const add = (k, id) => { if (!k) return; if (!blocks.has(k)) blocks.set(k, new Set()); blocks.get(k).add(id); };
        for (const [id, p] of ctx.people) {
            p.spellings.concat([p.name]).forEach(nm => {
                const f = foldName(nm), t = tokensOf(f);
                if (!t.length) return;
                add('L:' + skeleton(t[t.length - 1]), id);
                add('S:' + collapseDoubles(f.replace(/ /g, '')), id);
                add('F:' + skeleton(t[0]), id);
            });
        }
        const pairs = new Map();
        for (const ids of blocks.values()) {
            if (ids.size < 2 || ids.size > 400) continue;
            const arr = [...ids];
            for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
                const key = arr[i] < arr[j] ? arr[i] + '\u0001' + arr[j] : arr[j] + '\u0001' + arr[i];
                if (pairs.has(key)) continue;
                const a = ctx.people.get(arr[i]), b = ctx.people.get(arr[j]);
                let best = null;
                for (const x of a.spellings.concat([a.name])) for (const y of b.spellings.concat([b.name])) {
                    const m = nameMatch(x, y);
                    if (m && (!best || LEVEL_RANK[m.level] > LEVEL_RANK[best.level])) best = m;
                }
                pairs.set(key, best);
            }
        }
        const parent = new Map();
        const find = (x) => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x); return x; };
        const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
        const reasons = new Map();
        let reviewPairs = 0;
        for (const [key, m] of pairs) {
            if (!m) continue;
            const [a, b] = key.split('\u0001');
            const met = sharedMatches(ctx, a, b);
            if (met.some(x => x.relation === 'opposite' || x.relation === 'same-innings')) continue;
            if (m.level === 'review') { reviewPairs++; }
            if (!parent.has(a)) parent.set(a, a);
            if (!parent.has(b)) parent.set(b, b);
            union(a, b);
            const r = find(a);
            if (!reasons.has(r) || LEVEL_RANK[m.level] > LEVEL_RANK[reasons.get(r).level]) reasons.set(r, m);
        }
        const groups = new Map();
        for (const id of parent.keys()) { const r = find(id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(id); }
        const out = [];
        for (const [r, ids] of groups) {
            if (ids.length < 2) continue;
            let best = null;
            for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
                const k = ids[i] < ids[j] ? ids[i] + '\u0001' + ids[j] : ids[j] + '\u0001' + ids[i];
                const m = pairs.get(k);
                if (m && (!best || LEVEL_RANK[m.level] > LEVEL_RANK[best.level])) best = m;
            }
            const members = ids.map(id => ctx.people.get(id)).sort((a, b) => (b.matches - a.matches) || ((b.registered ? 1 : 0) - (a.registered ? 1 : 0)));
            out.push({ level: best ? best.level : 'review', reason: best ? best.reason : 'Similar names', players: members.map(personPublic) });
            void r;
        }
        out.sort((a, b) => (LEVEL_RANK[b.level] - LEVEL_RANK[a.level]) || (b.players.reduce((s, p) => s + p.matches, 0) - a.players.reduce((s, p) => s + p.matches, 0)));
        return { groups: out, reviewPairs };
    }

    // ================================================================
    // Read side
    // ================================================================
    async function accounts(viewer) {
        assertViewer(viewer);
        const list = await accountUids(viewer);
        const out = [];
        for (const a of list) {
            const [players, tournaments] = await Promise.all([
                db.players.countDocuments ? db.players.countDocuments({ ownerUid: a.uid }) : (await db.players.find({ ownerUid: a.uid }).toArray()).length,
                db.leagues.countDocuments ? db.leagues.countDocuments({ ownerUid: a.uid }) : (await db.leagues.find({ ownerUid: a.uid }).toArray()).length
            ]);
            out.push({ ownerUid: a.uid, email: a.email, players, tournaments, you: a.uid === viewer.uid });
        }
        return { accounts: out };
    }
    async function overview(viewer, q) {
        assertViewer(viewer);
        const ownerUid = String((q && q.ownerUid) || viewer.uid);
        await checkAccount(viewer, ownerUid);
        const ctx = await loadAccount(ownerUid, { fresh: !!(q && q.fresh) });
        const leagueKey = q && isStr(q.leagueKey) ? norm(q.leagueKey) : null;
        const inLeague = (p) => !leagueKey || p.tournamentList.some(t => t.leagueKey === leagueKey);
        const dup = duplicateGroups(ctx);
        const groups = dup.groups.filter(g => g.players.some(inLeague));
        const ops = await db.ops.find({ ownerUid }).sort({ createdAt: -1 }).limit(200).toArray();
        const done = ops.filter(o => o.status === 'completed');
        return {
            ownerUid,
            tournaments: ctx.leagues.map(l => ({ leagueKey: l.leagueKey, name: l.displayName || l.leagueKey, matches: ctx.recs.filter(r => r.leagueKey === l.leagueKey).length }))
                .sort((a, b) => b.matches - a.matches),
            totals: {
                players: [...ctx.people.values()].filter(inLeague).length,
                registered: [...ctx.people.values()].filter(p => p.registered && inLeague(p)).length,
                potentialDuplicates: groups.reduce((s, g) => s + g.players.length, 0),
                duplicateGroups: groups.length,
                merged: done.filter(o => o.kind === 'merge').reduce((s, o) => s + (o.mergeIds || []).length, 0),
                renamed: done.filter(o => o.kind === 'rename').length
            },
            duplicates: groups.slice(0, 60),
            recent: ops.filter(o => o.status !== 'previewed').slice(0, 8).map(opSummary)
        };
    }
    async function search(viewer, q) {
        assertViewer(viewer);
        const ownerUid = String((q && q.ownerUid) || viewer.uid);
        await checkAccount(viewer, ownerUid);
        const ctx = await loadAccount(ownerUid);
        const text = String((q && q.q) || '').trim().slice(0, 80);
        const leagueKey = q && isStr(q.leagueKey) ? norm(q.leagueKey) : null;
        const out = [];
        for (const p of ctx.people.values()) {
            if (leagueKey && !p.tournamentList.some(t => t.leagueKey === leagueKey)) continue;
            let score = 0, why = null;
            if (!text) score = 1;
            else {
                if (p.playerId.toLowerCase() === text.toLowerCase()) { score = 100; why = 'Player ID'; }
                for (const nm of [p.name, ...p.spellings]) { const s = searchScore(text, nm); if (s > score) { score = s; why = nm === p.name ? null : `Also written “${nm}”`; } }
                if (score < 60) {
                    const team = p.teams.concat(p.savedTeams).find(t => foldName(t).includes(foldName(text)));
                    if (team) { score = 55; why = `Team ${team}`; }
                }
                if (score < 50) {
                    const tn = p.tournamentList.find(t => foldName(t.name).includes(foldName(text)));
                    if (tn) { score = 45; why = `Tournament ${tn.name}`; }
                }
            }
            if (score > 0) out.push({ ...personPublic(p), score, matchedBy: why });
        }
        out.sort((a, b) => (b.score - a.score) || (b.matches - a.matches) || a.name.localeCompare(b.name));
        return { results: out.slice(0, text ? 40 : 60), total: out.length };
    }
    async function player(viewer, q) {
        assertViewer(viewer);
        const ownerUid = String((q && q.ownerUid) || viewer.uid);
        await checkAccount(viewer, ownerUid);
        const ctx = await loadAccount(ownerUid);
        const id = String((q && q.playerId) || '');
        let p = ctx.people.get(id);
        if (!p && ctx.tomb.has(id)) {
            const t = ctx.tomb.get(id);
            return { player: null, mergedInto: ctx.canon(id), tombstone: { playerId: id, names: t.names || [], at: t.at, opId: t.opId } };
        }
        if (!p) throw httpError(404, 'Player not found');
        return { player: personPublic(p), candidates: candidatesFor(ctx, id, { limit: 30 }) };
    }

    // ================================================================
    // The plan: every document the operation would change, as it would be
    // ================================================================
    async function buildPlan(ownerUid, input, opts) {
        opts = opts || {};
        const ctx = await loadAccount(ownerUid, { fresh: true });
        const kind = input.kind === 'rename' ? 'rename' : input.kind === 'merge' ? 'merge' : null;
        if (!kind) throw httpError(400, 'Choose Correct Player Name or Global Player Replace');
        const primaryId = String(input.primaryId || '').trim();
        const primary = ctx.prof.get(primaryId);
        if (!primary || isStr(primary.mergedInto)) {
            if (ctx.tomb.has(primaryId)) throw httpError(400, 'That Player ID was already merged into another player');
            throw httpError(400, kind === 'rename' ? 'Pick the player to correct' : 'Pick the master player (a registered Player ID)');
        }
        const mergeIds = kind === 'merge' ? [...new Set((Array.isArray(input.mergeIds) ? input.mergeIds : []).map(x => String(x || '').trim()).filter(Boolean))] : [];
        if (kind === 'merge') {
            if (!mergeIds.length) throw httpError(400, 'Select at least one record to merge into the master');
            if (mergeIds.includes(primaryId)) throw httpError(400, 'The master cannot also be merged into itself');
            for (const id of mergeIds) if (!ctx.people.has(id)) throw httpError(400, `Record ${id} was not found in this account`);
            if (mergeIds.length > 25) throw httpError(400, 'Merge at most 25 records at a time');
        }
        const rawName = isStr(input.name) ? input.name : (kind === 'merge' ? primary.displayName : '');
        const finalName = String(rawName || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (finalName.length < 2) throw httpError(400, 'Enter the correct player name');
        const finalKey = pk(finalName);
        const Sset = new Set([primaryId, ...mergeIds]);
        const inS = (identity) => Sset.has(identity);
        const blockers = [], warnings = [];
        const keyHolder = ctx.keyOwner.get(finalKey);
        if (keyHolder && !Sset.has(keyHolder)) {
            const other = ctx.people.get(keyHolder);
            blockers.push({ code: 'NAME_TAKEN', text: `Another player is already called “${(other && other.name) || finalName}” (${keyHolder}). If they are the same person, use Global Player Replace with them as the master.`, playerId: keyHolder });
        }
        // every spelling of the identities, and every raw Player ID that resolves to them
        const profilesOfS = [...Sset].map(id => ctx.prof.get(id)).filter(Boolean);
        const sKeys = new Set([finalKey]);
        profilesOfS.forEach(p => (p.nameKeys || []).forEach(k => { if (isStr(k) && !k.startsWith('#')) sKeys.add(k); }));
        mergeIds.filter(id => id.startsWith('key:')).forEach(id => sKeys.add(id.slice(4)));
        [...Sset].forEach(id => { const pp = ctx.people.get(id); if (pp) pp.aliases.forEach(k => sKeys.add(k)); });
        const sIdRaw = new Set([...Sset].filter(id => !id.startsWith('key:')));
        ctx.profiles.forEach(p => { if (isStr(p.mergedInto) && inS(ctx.canon(p.playerId))) sIdRaw.add(p.playerId); });
        ctx.tomb.forEach((t, id) => { if (inS(ctx.canon(id))) sIdRaw.add(id); });

        const canonEntry = { id: primaryId, name: finalName, key: finalKey };
        const primaryLabel = primary.displayName;
        const plan = {
            kind, ownerUid, primaryId, mergeIds, finalName, finalKey,
            originalNames: Object.fromEntries([...Sset].map(id => [id, (ctx.people.get(id) || {}).name || (ctx.prof.get(id) || {}).displayName || id])),
            records: [], balls: [], clips: [], teams: [], panelStates: [], roomStates: [], commentary: [], players: [],
            matches: [], blockers, warnings, skipped: [],
            ctx
        };

        // ---- matches ----
        const attachedBallKeys = [];
        const recRefsCache = new Map();
        for (const r of ctx.recs) {
            const rid = String(r._id);
            const refs = T.recordRefs(r, pk);
            recRefsCache.set(rid, refs);
        }
        // a quick pre-filter: the matches that name an identity of S at all
        const touched = ctx.recs.filter(r => {
            const rid = String(r._id);
            return [...Sset].some(id => (ctx.seenIn.get(id) || new Set()).has(rid)) || (ctx.clipsByRec.get(rid) || []).some(c => T.clipSlots(c).some(s => inS(ctx.identOf({ ids: s.ids, key: isStr(s.name) ? pk(s.name) : null }))));
        });
        const ownKeysAll = touched.flatMap(r => ctx.ownKeys.get(String(r._id)) || []);
        const balls = ownKeysAll.length ? await db.balls.find({ matchId: { $in: ownKeysAll } }).toArray() : [];
        for (const r of touched) {
            const rid = String(r._id);
            const own = new Set(ctx.ownKeys.get(rid) || []);
            const rb = balls.filter(b => own.has(b.matchId));
            rb.forEach(b => attachedBallKeys.push(String(b._id)));
            const rc = ctx.clipsByRec.get(rid) || [];
            const refs = recRefsCache.get(rid).slice();
            rb.forEach(b => T.ballSlots(b).forEach(s => { const ref = refOfSlot(s, 'ball'); if (ref) refs.push(ref); }));
            rc.forEach(c => T.clipSlots(c).forEach(s => { const ref = refOfSlot(s, 'clip'); if (ref) refs.push(ref); }));
            const mine = refs.filter(x => inS(ctx.identOf(x)));
            if (!mine.length) continue;
            const idSides = new Set(mine.filter(x => x.ids.some(isStr)).map(x => x.side).filter(Boolean));
            const nameSides = new Set(mine.filter(x => !x.ids.some(isStr)).map(x => x.side).filter(Boolean));
            const title = titleOf(r);
            const tournament = (ctx.leagueOf.get(r.leagueKey) || {}).displayName || r.leagueKey;
            const entry = { recId: rid, matchId: r.matchId, roomId: r.roomId || null, leagueKey: r.leagueKey, title, tournament, date: r.matchDate || (r.savedAt ? String(r.savedAt).slice(0, 10) : null), status: r.upcoming === true ? 'upcoming' : r.winningTeam ? 'completed' : 'unfinished', side: null, roles: [], changes: 0, conflicts: [] };
            let sides = idSides.size ? idSides : nameSides;
            if (sides.size === 2) {
                const by = (side) => [...new Set(mine.filter(x => x.side === side && (idSides.size ? x.ids.some(isStr) : true)).map(x => (ctx.people.get(ctx.identOf(x)) || {}).name || x.name))].join(', ');
                if (idSides.size) {
                    blockers.push({ code: 'OPPOSITE_TEAMS', text: `${title}: ${by('A')} played for ${(r.teamA && r.teamA.name) || 'Team A'} and ${by('B')} for ${(r.teamB && r.teamB.name) || 'Team B'} — two different players.`, matchId: r.matchId });
                    entry.conflicts.push('Opposite teams');
                } else {
                    warnings.push({ code: 'AMBIGUOUS_NAME', text: `${title}: the name is on both teams with no Player ID — this match is left as it is.`, matchId: r.matchId });
                    plan.skipped.push({ matchId: r.matchId, title, reason: 'Name on both teams, no Player ID' });
                }
                plan.matches.push(entry);
                continue;
            }
            const side = [...sides][0] || null;
            entry.side = side;
            // two identities of S in one innings → two different people
            const rowsIn = (card) => {
                const by = new Map();
                ((r[card] && r[card][side]) || []).forEach(row => {
                    if (!row || !isStr(row.name)) return;
                    const id = ctx.identOf({ ids: [row.id], key: pk(row.name) });
                    if (!inS(id)) return;
                    const inn = Number(row.inningsNo) || 1;
                    if (!by.has(inn)) by.set(inn, new Set());
                    by.get(inn).add(id);
                });
                return by;
            };
            const batBy = rowsIn('battingCard'), bowlBy = rowsIn('bowlingCard');
            const twice = [...batBy.values()].some(s => s.size > 1) || [...bowlBy.values()].some(s => s.size > 1);
            if (twice) {
                const ids = new Set([...batBy.values(), ...bowlBy.values()].flatMap(s => [...s]));
                blockers.push({ code: 'SAME_INNINGS', text: `${title}: ${[...ids].map(id => (ctx.people.get(id) || {}).name || id).join(' and ')} both batted (or both bowled) in the same innings — two different players.`, matchId: r.matchId });
                entry.conflicts.push('Same innings');
            }
            const identsHere = new Set(mine.map(x => ctx.identOf(x)));
            if (identsHere.size > 1 && !twice) {
                warnings.push({ code: 'SAME_MATCH', text: `${title}: ${[...identsHere].map(id => (ctx.people.get(id) || {}).name || id).join(' and ')} are both in this match for the same team — they become one player in it (roles are not added twice: each row stays as it is).`, matchId: r.matchId });
                entry.conflicts.push('Both in this match');
            }
            // live: being scored right now → never rewritten under the panel
            const league = ctx.leagueOf.get(r.leagueKey);
            const listedLive = !!(league && (league.liveMatches || []).some(lm => lm && (lm.matchId === r.matchId || (r.roomId && lm.roomId === r.roomId))));
            const lastBall = rb.reduce((m, b) => Math.max(m, Number(b.timestamp) || 0), 0);
            if (r.upcoming !== true && !r.winningTeam && (listedLive || (lastBall && now() - lastBall < LIVE_WINDOW_MS))) {
                blockers.push({ code: 'LIVE_MATCH', text: `${title} is being scored right now — correct the player on the panel (Team Squads), or wait until the match is finished.`, matchId: r.matchId });
                entry.conflicts.push('Live');
            } else if (r.upcoming !== true && !r.winningTeam) {
                warnings.push({ code: 'UNFINISHED', text: `${title} has no result saved. If it is resumed on a laptop that still holds the old squad, re-check the squad there.`, matchId: r.matchId });
            }
            if (isTournamentLocked(ownerUid, r.leagueKey)) blockers.push({ code: 'TOURNAMENT_LOCKED', text: `${tournament} is being merged right now — try again when Merge Tournaments has finished.`, matchId: r.matchId });

            // the rename map for this match
            const otherOnSide = new Set(refs.filter(x => x.side === side && x.ids.some(isStr) && !inS(ctx.identOf(x)) && x.key).map(x => x.key));
            const keysHere = [...sKeys].filter(k => !otherOnSide.has(k));
            [...sKeys].filter(k => otherOnSide.has(k)).forEach(k => warnings.push({ code: 'SHARED_NAME', text: `${title}: another player of the same team is also written “${k}” — only references by Player ID are changed there.`, matchId: r.matchId }));
            const idsHere = new Set();
            mine.forEach(x => x.ids.filter(isStr).forEach(i => { if (inS(ctx.canon(i))) idsHere.add(i); }));
            sIdRaw.forEach(i => idsHere.add(i));
            const shown = [...new Set(mine.filter(x => x.side === side && isStr(x.name)).map(x => x.name))];
            const map = {
                canon: [canonEntry],
                ids: [...idsHere].map(i => [i, 0]),
                A: side === 'A' ? keysHere.map(k => [k, 0]) : [],
                B: side === 'B' ? keysHere.map(k => [k, 0]) : [],
                names: { A: side === 'A' ? shown.map(n => [n, 0]) : [], B: side === 'B' ? shown.map(n => [n, 0]) : [] }
            };
            const mm = T.hydrate(map);
            entry.map = map;
            const roles = new Set();
            mine.forEach(x => { if (x.kind === 'bat') roles.add('Batting'); else if (x.kind === 'bowl') roles.add('Bowling'); else if (x.kind === 'howOut') roles.add('Fielding'); else if (x.kind === 'squad') roles.add('Playing XI'); });
            entry.roles = [...roles];
            const tr = T.transformRecord(r, mm, null, pk);
            if (T.scoringFingerprint(tr.doc) !== T.scoringFingerprint(r)) blockers.push({ code: 'SCORE_GUARD', text: `${title}: the change would alter a score — refused.`, matchId: r.matchId });
            if (tr.changes) { plan.records.push({ before: r, after: tr.doc, recId: rid }); entry.changes += tr.changes; }
            rb.forEach(b => { const set = T.transformBall(b, mm, pk); if (set) { plan.balls.push({ before: b, set, recId: rid }); entry.changes++; } });
            rc.forEach(c => { const set = T.transformClip(c, mm, pk); if (set) { plan.clips.push({ before: c, set, recId: rid }); entry.changes++; } });
            entry.counts = {
                batting: mine.filter(x => x.kind === 'bat').length, bowling: mine.filter(x => x.kind === 'bowl').length,
                fielding: mine.filter(x => x.kind === 'howOut').length, squad: mine.filter(x => x.kind === 'squad').length,
                balls: plan.balls.filter(x => x.recId === rid).length, clips: plan.clips.filter(x => x.recId === rid).length
            };
            plan.matches.push(entry);
        }
        // ---- deliveries and clips no saved match holds (a match never saved) ----
        const idList = [...sIdRaw];
        if (idList.length) {
            const attached = new Set(attachedBallKeys);
            const strayBalls = (await db.balls.find({ $or: ['strikerPlayerId', 'nonStrikerPlayerId', 'bowlerPlayerId', 'dismissedPlayerId', 'dismissalFielderPlayerId', 'strikerId', 'nonStrikerId', 'bowlerId'].map(f => ({ [f]: { $in: idList } })) }).toArray())
                .filter(b => !attached.has(String(b._id)) && (!isStr(b.ownerUid) || b.ownerUid === ownerUid));
            const groups = new Map();
            strayBalls.forEach(b => { if (!groups.has(b.matchId)) groups.set(b.matchId, []); groups.get(b.matchId).push(b); });
            for (const [mid, bs] of groups) {
                const sides = new Set(), seenKeys = new Set();
                bs.forEach(b => T.ballSlots(b).forEach(s => { if (s.side && s.ids.some(i => isStr(i) && sIdRaw.has(i))) { sides.add(s.side); if (isStr(s.name)) seenKeys.add(pk(s.name)); } }));
                if (sides.size !== 1) { warnings.push({ code: 'STRAY_BALLS', text: `Deliveries of an unsaved match (${mid}) name the player on both teams — left as they are.` }); continue; }
                const side = [...sides][0];
                const map = { canon: [canonEntry], ids: idList.map(i => [i, 0]), A: [], B: [], names: { A: [], B: [] } };
                map[side] = [...seenKeys].map(k => [k, 0]);
                const mm = T.hydrate(map);
                bs.forEach(b => { const set = T.transformBall(b, mm, pk); if (set) plan.balls.push({ before: b, set, recId: null, stray: mid }); });
            }
            const attachedClips = new Set(plan.clips.map(x => String(x.before._id)));
            ctx.recs.forEach(r => (ctx.clipsByRec.get(String(r._id)) || []).forEach(c => attachedClips.add(String(c._id))));
            const strayClips = (await db.clips.find({ $or: ['strikerPlayerId', 'nonStrikerPlayerId', 'bowlerPlayerId', 'fielderPlayerId', 'dismissedPlayerId'].map(f => ({ [f]: { $in: idList } })) }).toArray())
                .filter(c => !attachedClips.has(String(c._id)) && (!isStr(c.ownerUid) || c.ownerUid === ownerUid));
            strayClips.forEach(c => {
                const seen = T.clipSlots(c).filter(s => s.ids.some(i => isStr(i) && sIdRaw.has(i)) && isStr(s.name)).map(s => [pk(s.name), 0]);
                const map = { canon: [canonEntry], ids: idList.map(i => [i, 0]), A: seen, B: seen, names: { A: [], B: [] } };
                const set = T.transformClip(c, T.hydrate(map), pk);
                if (set) plan.clips.push({ before: c, set, recId: null, stray: c.matchId });
            });
        }
        // ---- saved teams ----
        for (const t of ctx.teams) {
            if (!(t.players || []).some(p => p && isStr(p.id) && inS(ctx.canon(p.id)))) continue;
            const seen = new Map();
            const players = [];
            (t.players || []).forEach(p => {
                if (!p) return;
                const mineP = isStr(p.id) && inS(ctx.canon(p.id));
                const q = mineP ? { ...p, id: primaryId, name: finalName } : { ...p };
                const k = isStr(q.id) ? q.id : null;
                if (k && seen.has(k)) { const prev = seen.get(k); if (q.isXI !== false) prev.isXI = true; return; }
                if (k) seen.set(k, q);
                players.push(q);
            });
            const remap = (v) => (isStr(v) && inS(ctx.canon(v)) ? primaryId : (v || null));
            const after = { ...t, players, captainId: remap(t.captainId), wkId: remap(t.wkId) };
            if (T.stable(after) !== T.stable(t)) plan.teams.push({ before: t, after: { ...after, rev: (Number(t.rev) || 0) + 1, updatedAt: now() } });
        }
        // ---- the panel's own snapshots and the live rooms of those matches ----
        const affected = plan.matches.filter(m => m.map);
        if (db.panelStates && affected.length) {
            const states = await db.panelStates.find({ matchId: { $in: affected.map(m => m.matchId) } }).toArray();
            states.forEach(ps => {
                const m = affected.find(x => x.matchId === ps.matchId);
                if (!m || !ps.state) return;
                const tr = transformPanelState(ps.state, m.map, pk);
                if (tr.changes) plan.panelStates.push({ before: ps, after: { ...ps, state: tr.doc } });
            });
        }
        if (rooms && affected.length) {
            for (const m of affected) {
                const roomId = String(m.roomId || m.matchId || '').replace(/[^a-zA-Z0-9_-]/g, '');
                if (!roomId) continue;
                let st = null;
                try { st = await rooms.read(roomId); } catch (e) { st = null; }
                if (!st || typeof st !== 'object') continue;
                const tr = transformPanelState(st, m.map, pk);
                if (tr.changes) plan.roomStates.push({ roomId, before: st, after: tr.doc, matchId: m.matchId });
            }
        }
        if (db.commentary) {
            const imported = affected.filter(m => { const r = ctx.recs.find(x => String(x._id) === m.recId); return r && r.importSource; });
            if (imported.length) {
                const docs = await db.commentary.find({ _id: { $in: imported.map(m => `${ownerUid}|${m.leagueKey}|${m.matchId}`) } }).toArray();
                docs.forEach(d => {
                    const m = imported.find(x => `${ownerUid}|${x.leagueKey}|${x.matchId}` === d._id);
                    const tr = transformCommentary(d, m.map, pk);
                    if (tr.changes) plan.commentary.push({ before: d, after: tr.doc });
                });
            }
        }
        // ---- the profiles ----
        const newKeys = new Set([...(primary.nameKeys || []).filter(k => isStr(k) && !k.startsWith('#'))]);
        newKeys.add(finalKey);
        for (const k of sKeys) {
            const holder = ctx.keyOwner.get(k);
            if (!holder || Sset.has(holder)) newKeys.add(k);
        }
        let batHand = primary.batHand === 'L' || primary.batHand === 'R' ? primary.batHand : null;
        const mergedProfiles = mergeIds.map(id => ctx.prof.get(id)).filter(p => p && !isStr(p.mergedInto));
        if (!batHand) { const h = mergedProfiles.find(p => p.batHand === 'L' || p.batHand === 'R'); if (h) batHand = h.batHand; }
        const handsDiffer = [primary, ...mergedProfiles].map(p => p.batHand).filter(h => h === 'L' || h === 'R');
        if (new Set(handsDiffer).size > 1) warnings.push({ code: 'HANDS_DIFFER', text: `The records have different batting hands — the master keeps ${batHand === 'L' ? 'left' : 'right'}-handed.` });
        mergedProfiles.forEach(p => plan.players.push({ role: 'merged', before: p, after: { ...p, nameKeys: [T.retiredKey(p.playerId)], mergedInto: primaryId, mergedAt: now(), updatedAt: now() } }));
        const primaryAfter = { ...primary, displayName: finalName, nameKeys: [...newKeys], updatedAt: now(), ...(batHand ? { batHand } : {}) };
        if (T.stable({ ...primaryAfter, updatedAt: 0 }) !== T.stable({ ...primary, updatedAt: 0 })) plan.players.push({ role: 'primary', before: primary, after: primaryAfter });
        if (kind === 'rename' && primary.displayName === finalName && !plan.records.length && !plan.balls.length && !plan.clips.length && !plan.teams.length) {
            blockers.push({ code: 'NOTHING', text: 'That is already the player’s name everywhere.' });
        }
        // what the owner approves: the exact documents as they are now
        const parts = [];
        ['records', 'balls', 'clips', 'teams', 'panelStates', 'commentary', 'players'].forEach(coll => plan[coll].forEach(x => parts.push(coll + ':' + String(x.before._id) + ':' + hashOf(x.before))));
        plan.roomStates.forEach(x => parts.push('room:' + x.roomId + ':' + hashOf(x.before)));
        parts.push('input:' + T.stable({ kind, primaryId, mergeIds: mergeIds.slice().sort(), finalName }));
        plan.fingerprint = sha(parts.sort().join('\n'));
        return plan;

        function refOfSlot(s, kind) {
            const nm = isStr(s.name) ? s.name.trim() : null;
            const ids = (s.ids || []).filter(isStr).map(x => x.trim());
            if (!nm && !ids.length) return null;
            return { side: s.side || null, name: nm, key: nm ? pk(nm) : null, ids, kind };
        }
    }

    // What the numbers look like before (each record) and after (the master).
    function statsPreview(plan) {
        const ctx = plan.ctx;
        const before = [plan.primaryId, ...plan.mergeIds].map(id => personPublic(ctx.people.get(id))).filter(Boolean);
        // after: the same computation over the rewritten matches
        const replaced = new Map(plan.records.map(x => [x.recId, x.after]));
        const recs = ctx.recs.map(r => replaced.get(String(r._id)) || r).filter(r => r.upcoming !== true);
        const st = emptyStats();
        const canonAfter = (row) => {
            if (isStr(row.id)) { const c = ctx.canon(row.id); return plan.mergeIds.includes(c) ? plan.primaryId : c; }
            const k = pk(row.name);
            if (k === plan.finalKey) return plan.primaryId;
            const o = ctx.keyOwner.get(k);
            return o ? (plan.mergeIds.includes(o) ? plan.primaryId : o) : 'key:' + k;
        };
        recs.forEach(r => {
            const here = appearancesOf(r, canonAfter).has(plan.primaryId);
            SIDES.forEach(side => {
                ((r.battingCard && r.battingCard[side]) || []).forEach(row => {
                    if (row && isStr(row.name) && canonAfter(row) === plan.primaryId) addBatting(st, row);
                    if (row && row.out) {
                        const how = String(row.dismissalType || row.howOut || '').toLowerCase();
                        const f = isStr(row.fielderName) ? row.fielderName : null;
                        const isMe = (nm) => isStr(nm) && canonAfter({ name: nm }) === plan.primaryId;
                        if (/run ?out/.test(how) && isMe(f)) st.field.runOuts++;
                        else if (/stump/.test(how) && isMe(f)) st.field.stumpings++;
                        else if (/caught|^c /.test(how)) { if (f ? isMe(f) : (/caught (and|&) bowled|^c ?& ?b/.test(how) && isMe(row.bowlerName))) st.field.catches++; }
                    }
                });
                ((r.bowlingCard && r.bowlingCard[side]) || []).forEach(row => { if (row && isStr(row.name) && canonAfter(row) === plan.primaryId) addBowling(st, row); });
            });
            if (here) { st.matchIds.add(String(r._id)); if (r.leagueKey) st.tournaments.add(r.leagueKey); }
        });
        const clipIds = new Set();
        ctx.recs.forEach(r => (ctx.clipsByRec.get(String(r._id)) || []).forEach(c => {
            if (T.clipSlots(c).some(s => [plan.primaryId, ...plan.mergeIds].includes(ctx.identOf({ ids: s.ids, key: isStr(s.name) ? pk(s.name) : null })))) clipIds.add(String(c._id));
        }));
        plan.clips.filter(x => x.stray).forEach(x => clipIds.add(String(x.before._id)));
        st.clips = clipIds.size;
        const after = { playerId: plan.primaryId, name: plan.finalName, ...finishStats(st) };
        return { before, after };
    }
    // Leaderboards of every tournament touched: the player's place before / after.
    function leaderboardPreview(plan) {
        const ctx = plan.ctx;
        const replaced = new Map(plan.records.map(x => [x.recId, x.after]));
        const leagues = [...new Set(plan.matches.map(m => m.leagueKey).filter(Boolean))];
        const keysBefore = new Set([plan.primaryId, ...plan.mergeIds].flatMap(id => { const p = ctx.people.get(id); return p ? [pk(p.name), ...p.aliases] : []; }));
        return leagues.map(lk => {
            const recs = ctx.recs.filter(r => r.leagueKey === lk);
            const b = deps.computeLeaderboards(recs);
            const a = deps.computeLeaderboards(recs.map(r => replaced.get(String(r._id)) || r));
            const pos = (list, keys) => list.map((x, i) => ({ i, k: pk(x.name), x })).filter(e => keys.has(e.k)).map(e => ({ rank: e.i + 1, name: e.x.name, runs: e.x.runs, wickets: e.x.wickets }));
            return {
                leagueKey: lk, tournament: (ctx.leagueOf.get(lk) || {}).displayName || lk,
                runs: { before: pos(b.topRuns, keysBefore), after: pos(a.topRuns, new Set([plan.finalKey])) },
                wickets: { before: pos(b.topWickets, keysBefore), after: pos(a.topWickets, new Set([plan.finalKey])) }
            };
        });
    }
    function counts(plan) {
        const recIds = new Set(plan.matches.filter(m => m.map).map(m => m.recId));
        const cardRecs = plan.records.filter(x => T.stable(x.before.battingCard) !== T.stable(x.after.battingCard) || T.stable(x.before.bowlingCard) !== T.stable(x.after.bowlingCard));
        return {
            teams: plan.teams.length,
            tournaments: new Set(plan.matches.filter(m => m.map).map(m => m.leagueKey).filter(Boolean)).size,
            matches: recIds.size,
            matchRecords: plan.records.length,
            scorecards: cardRecs.length,
            battingRecords: plan.matches.reduce((s, m) => s + ((m.counts && m.counts.batting) || 0), 0),
            bowlingRecords: plan.matches.reduce((s, m) => s + ((m.counts && m.counts.bowling) || 0), 0),
            fieldingRecords: plan.matches.reduce((s, m) => s + ((m.counts && m.counts.fielding) || 0), 0),
            playingXI: plan.matches.reduce((s, m) => s + ((m.counts && m.counts.squad) || 0), 0),
            deliveries: plan.balls.length,
            clips: plan.clips.length,
            panelSnapshots: plan.panelStates.length + plan.roomStates.length,
            commentary: plan.commentary.length,
            profilesUpdated: plan.players.filter(p => p.role === 'primary').length,
            profilesRemoved: plan.kind === 'merge' ? plan.players.filter(p => p.role === 'merged').length : 0,
            leaderboards: new Set(plan.matches.filter(m => m.map && m.status !== 'upcoming').map(m => m.leagueKey).filter(Boolean)).size * 2
        };
    }
    function opSummary(o) {
        return {
            opId: o._id, kind: o.kind, status: o.status, createdAt: o.createdAt, completedAt: o.completedAt || null, by: o.createdBy,
            primaryId: o.primaryId, mergeIds: o.mergeIds || [], finalName: o.finalName, originalNames: o.originalNames || {},
            counts: o.counts || {}, warnings: o.warnings || [], error: o.error || null, rolledBackAt: o.rolledBackAt || null, rollbackBy: o.rollbackBy || null,
            stages: o.stages || [], verification: o.verification || null, rollback: o.rollback || null
        };
    }

    // ================================================================
    // Preview → the operation, journalled
    // ================================================================
    async function preview(viewer, body) {
        assertViewer(viewer);
        body = body || {};
        const ownerUid = String(body.ownerUid || viewer.uid);
        await checkAccount(viewer, ownerUid);
        const plan = await buildPlan(ownerUid, body);
        // previews nobody confirmed, older than a day, are not kept
        await db.ops.deleteMany({ ownerUid, status: 'previewed', createdAt: { $lt: now() - 24 * 60 * 60 * 1000 } }).catch(() => {});
        const opId = newOpId();
        const c = counts(plan);
        const stats = statsPreview(plan);
        const boards = leaderboardPreview(plan);
        await db.ops.insertOne({
            _id: opId, kind: plan.kind, ownerUid, status: 'previewed', createdAt: now(), createdBy: viewer.email,
            primaryId: plan.primaryId, mergeIds: plan.mergeIds, finalName: plan.finalName, originalNames: plan.originalNames,
            fingerprint: plan.fingerprint, counts: c, blockers: plan.blockers, warnings: plan.warnings, skipped: plan.skipped,
            expected: stats.after, matches: plan.matches.map(stripMap)
        });
        return {
            opId, kind: plan.kind, ownerUid, primaryId: plan.primaryId, mergeIds: plan.mergeIds, finalName: plan.finalName, originalNames: plan.originalNames,
            counts: c, blockers: plan.blockers, warnings: plan.warnings, skipped: plan.skipped, matches: plan.matches.map(stripMap),
            stats, leaderboards: boards, canExecute: !plan.blockers.length, needsAcknowledge: plan.warnings.length > 0
        };
    }
    const stripMap = (m) => { const { map, ...rest } = m; return rest; };

    const running = new Map(); // opId -> promise
    async function execute(viewer, body) {
        assertViewer(viewer);
        const opId = String((body && body.opId) || '');
        const op = await db.ops.findOne({ _id: opId });
        if (!op) throw httpError(404, 'Preview not found — preview the change again');
        await checkAccount(viewer, op.ownerUid);
        if (op.status === 'completed' || op.status === 'running') return { opId, status: op.status }; // a second click: the same operation
        if (op.status !== 'previewed') throw httpError(409, `This preview is ${op.status.replace('_', ' ')} — preview the change again`);
        if ((op.blockers || []).length) throw httpError(400, op.blockers[0].text, { code: op.blockers[0].code });
        if ((op.warnings || []).length && !(body && body.acknowledged)) throw httpError(400, 'Review the warnings and confirm them first', { code: 'ACK_REQUIRED' });
        if (now() - op.createdAt > 30 * 60 * 1000) throw httpError(409, 'This preview is older than 30 minutes — preview the change again', { code: 'STALE' });
        const claim = await db.ops.updateOne({ _id: opId, status: 'previewed' }, { $set: { status: 'running', startedAt: now(), startedBy: viewer.email, stages: [] } });
        if (!claim.matchedCount) return { opId, status: (await db.ops.findOne({ _id: opId })).status };
        const p = runOperation(op, viewer).catch(err => log('Player operation crashed:', err));
        running.set(opId, p);
        p.finally(() => running.delete(opId));
        if (body && body.wait) await p;
        return { opId, status: 'running' };
    }

    async function stage(opId, name, status, detail) {
        await db.ops.updateOne({ _id: opId }, { $push: { stages: { name, status, at: now(), ...(detail ? { detail } : {}) } } });
    }
    async function backupRow(opId, coll, key, before, extra) {
        await db.backups.insertOne({ opId, coll, key: String(key), before: before == null ? null : before, afterHash: null, createdAt: now(), ...(extra || {}) });
    }
    async function markAfter(opId, coll, key, afterDoc) {
        await db.backups.updateOne({ opId, coll, key: String(key) }, { $set: { afterHash: hashIn(coll, afterDoc), writtenAt: now() } });
    }

    async function runOperation(op, viewer) {
        const opId = op._id, ownerUid = op.ownerUid;
        let locked = false, plan = null;
        try {
            await stage(opId, 'scanning', 'running');
            plan = await buildPlan(ownerUid, { kind: op.kind, primaryId: op.primaryId, mergeIds: op.mergeIds, name: op.finalName });
            if (plan.fingerprint !== op.fingerprint) throw httpError(409, 'The data changed after the preview (a match was saved or corrected meanwhile) — nothing was changed. Preview again.', { code: 'DATA_CHANGED', noWrites: true });
            if (plan.blockers.length) throw httpError(400, plan.blockers[0].text, { noWrites: true });
            await takeLock(ownerUid, opId, plan.matches.filter(m => m.map).flatMap(m => [m.matchId, m.roomId].filter(Boolean)));
            locked = true;
            await stage(opId, 'scanning', 'done', `${plan.matches.filter(m => m.map).length} matches, ${plan.balls.length} deliveries, ${plan.clips.length} clips, ${plan.teams.length} teams`);

            // ---- backing up: every document as it is, before anything is written ----
            await stage(opId, 'backing up', 'running');
            let nb = 0;
            for (const x of plan.records) { await backupRow(opId, 'records', x.before._id, x.before); nb++; }
            for (const x of plan.balls) { await backupRow(opId, 'balls', x.before._id, x.before); nb++; }
            for (const x of plan.clips) { await backupRow(opId, 'clips', x.before._id, x.before); nb++; }
            for (const x of plan.teams) { await backupRow(opId, 'teams', x.before._id, x.before); nb++; }
            for (const x of plan.panelStates) { await backupRow(opId, 'panelStates', x.before._id, x.before); nb++; }
            for (const x of plan.commentary) { await backupRow(opId, 'commentary', x.before._id, x.before); nb++; }
            for (const x of plan.players) { await backupRow(opId, 'players', x.before._id, x.before, { role: x.role, playerId: x.before.playerId }); nb++; }
            for (const x of plan.roomStates) { await backupRow(opId, 'roomStates', x.roomId, x.before); nb++; }
            await stage(opId, 'backing up', 'done', `${nb} documents copied`);

            // ---- migrating ----
            await stage(opId, 'migrating', 'running');
            const sameNow = async (coll, before) => {
                const cur = await db[coll].findOne({ _id: before._id });
                if (hashIn(coll, cur) !== hashIn(coll, before)) throw httpError(409, `A ${coll === 'records' ? 'match' : coll.replace(/s$/, '')} changed while this was running — rolled back. Preview again.`, { code: 'DATA_CHANGED' });
            };
            for (const x of plan.records) {
                await sameNow('records', x.before);
                if (deps.versionMatchRecord) await deps.versionMatchRecord(x.before, 'player identity ' + op.kind, { forced: true, opId }).catch(() => {});
                const r = await db.records.replaceOne({ _id: x.before._id }, x.after);
                if (r && r.matchedCount === 0) throw httpError(500, 'A match record could not be written');
                await markAfter(opId, 'records', x.before._id, x.after);
            }
            for (const x of plan.balls) {
                await db.balls.updateOne({ _id: x.before._id }, { $set: x.set });
                await markAfter(opId, 'balls', x.before._id, { ...x.before, ...x.set });
            }
            for (const x of plan.clips) {
                await db.clips.updateOne({ _id: x.before._id }, { $set: x.set });
                await markAfter(opId, 'clips', x.before._id, { ...x.before, ...x.set });
            }
            for (const x of plan.teams) {
                await sameNow('teams', x.before);
                await db.teams.replaceOne({ _id: x.before._id }, x.after);
                await markAfter(opId, 'teams', x.before._id, x.after);
            }
            for (const x of plan.panelStates) {
                await db.panelStates.replaceOne({ _id: x.before._id }, x.after);
                await markAfter(opId, 'panelStates', x.before._id, x.after);
            }
            for (const x of plan.commentary) {
                await db.commentary.replaceOne({ _id: x.before._id }, x.after);
                await markAfter(opId, 'commentary', x.before._id, x.after);
            }
            // the duplicates give up their spellings first (one spelling, one profile)
            for (const x of plan.players.filter(p => p.role === 'merged')) {
                await db.players.replaceOne({ _id: x.before._id }, x.after);
                await markAfter(opId, 'players', x.before._id, x.after);
            }
            for (const x of plan.players.filter(p => p.role === 'primary')) {
                await sameNow('players', x.before);
                await db.players.replaceOne({ _id: x.before._id }, x.after);
                await markAfter(opId, 'players', x.before._id, x.after);
            }
            for (const x of plan.roomStates) {
                await rooms.write(x.roomId, x.after);
                await markAfter(opId, 'roomStates', x.roomId, x.after);
            }
            await stage(opId, 'migrating', 'done', `${plan.records.length} match records, ${plan.balls.length} deliveries, ${plan.clips.length} clips, ${plan.teams.length} teams, ${plan.players.length} profiles`);

            // ---- recalculating: every response cache built from the old names ----
            await stage(opId, 'recalculating', 'running');
            dropCaches(plan);
            const boards = leaderboardPreview(plan);
            await stage(opId, 'recalculating', 'done', `${boards.length} tournament leaderboard${boards.length === 1 ? '' : 's'} rebuilt`);

            // ---- verifying, from the database ----
            await stage(opId, 'verifying', 'running');
            const report = await verify(plan, op);
            await db.ops.updateOne({ _id: opId }, { $set: { verification: report } });
            const failed = report.checks.filter(c => !c.ok);
            if (failed.length) throw httpError(500, 'Verification failed: ' + failed.map(c => c.name + (c.detail ? ' (' + c.detail + ')' : '')).join('; '), { code: 'VERIFY_FAILED' });
            await stage(opId, 'verifying', 'done', `${report.checks.length} checks passed`);

            // ---- cleaning up: the duplicate profiles leave the active players collection ----
            await stage(opId, 'cleaning up', 'running');
            let removed = 0;
            if (op.kind === 'merge') {
                // a forwarding record per removed id, so a laptop still holding
                // the old id is sent to the master instead of bringing it back
                const tombFor = async (playerId, names) => {
                    const tomb = { _id: 'tomb:' + ownerUid + ':' + playerId, ownerUid, playerId, mergedInto: plan.primaryId, names, opId, at: now(), by: viewer.email };
                    await backupRow(opId, 'tombstones', tomb._id, null);
                    await db.tombstones.insertOne(tomb);
                    await markAfter(opId, 'tombstones', tomb._id, tomb);
                };
                for (const x of plan.players.filter(p => p.role === 'merged')) {
                    await tombFor(x.before.playerId, [x.before.displayName, ...(x.before.nameKeys || [])].filter(isStr));
                    await db.players.deleteOne({ _id: x.before._id });
                    await db.backups.updateOne({ opId, coll: 'players', key: String(x.before._id) }, { $set: { afterHash: 'deleted', deleted: true } });
                    removed++;
                }
                for (const id of plan.mergeIds.filter(i => !i.startsWith('key:') && !plan.players.some(x => x.before.playerId === i))) {
                    await tombFor(id, [plan.originalNames[id]].filter(isStr));
                }
                const left = await db.players.find({ ownerUid, playerId: { $in: op.mergeIds } }).toArray();
                if (left.length) throw httpError(500, 'A duplicate profile could not be removed', { code: 'CLEANUP_FAILED' });
            }
            dropCaches(plan);
            await stage(opId, 'cleaning up', 'done', op.kind === 'merge' ? `${removed} duplicate profile${removed === 1 ? '' : 's'} removed — only the master ${plan.primaryId} remains` : 'Nothing to remove');

            await db.ops.updateOne({ _id: opId }, { $set: { status: 'completed', completedAt: now(), counts: counts(plan), leaderboards: boards } });
            if (deps.logAuditAction) {
                await deps.logAuditAction(viewer.email, op.kind === 'merge' ? 'Global player replace' : 'Correct player name',
                    op.kind === 'merge' ? `${op.mergeIds.map(id => `${op.originalNames[id] || id} (${id})`).join(', ')} → ${plan.finalName} (${plan.primaryId})` : `${op.originalNames[plan.primaryId]} → ${plan.finalName} (${plan.primaryId})`,
                    { names: op.originalNames }, { name: plan.finalName, primaryId: plan.primaryId }, { opId }).catch(() => {});
            }
            forgetAccount(ownerUid);
        } catch (err) {
            log('Player operation ' + opId + ' failed:', err.message || err);
            const fields = { status: 'failed', failedAt: now(), error: err.message || String(err), errorCode: err.code || null };
            await stage(opId, 'failed', 'error', err.message || String(err)).catch(() => {});
            if (!err.noWrites) {
                try {
                    const rb = await restore(opId, { requireUnchanged: false, force: true });
                    fields.rollback = { automatic: true, ok: rb.ok, restored: rb.restored, at: now() };
                    fields.status = 'failed';
                    await stage(opId, 'rolled back', rb.ok ? 'done' : 'error', rb.ok ? `${rb.restored} documents restored — nothing was left half changed` : rb.error);
                } catch (e2) {
                    fields.rollback = { automatic: true, ok: false, error: e2.message || String(e2), at: now() };
                }
            }
            await db.ops.updateOne({ _id: opId }, { $set: fields }).catch(() => {});
            if (plan) dropCaches(plan);
            forgetAccount(ownerUid);
        } finally {
            if (locked) await releaseLock(ownerUid, opId);
        }
    }

    function dropCaches(plan) {
        const leagues = new Set(plan.matches.map(m => m.leagueKey).filter(Boolean));
        leagues.forEach(lk => { const l = plan.ctx.leagueOf.get(lk); if (deps.invalidateTournamentCaches) deps.invalidateTournamentCaches(l && l.publicToken); });
        if (deps.invalidateTournamentCaches) deps.invalidateTournamentCaches(null);
        const mids = new Set();
        plan.matches.forEach(m => { [m.matchId, m.roomId].filter(Boolean).forEach(x => mids.add(x)); });
        plan.clips.forEach(x => { if (x.before.matchId) mids.add(x.before.matchId); });
        if (deps.invalidateClipsCache) mids.forEach(m => deps.invalidateClipsCache(m));
        const keys = new Set();
        plan.players.forEach(x => (x.before.nameKeys || []).forEach(k => keys.add(k)));
        keys.add(plan.finalKey);
        if (deps.forgetPlayerIdCache) deps.forgetPlayerIdCache(plan.ownerUid, [...keys]);
        if (deps.repointPlayerIdCache) plan.mergeIds.forEach(id => deps.repointPlayerIdCache(id, plan.primaryId));
    }

    // Every promise of the operation, checked from the database.
    async function verify(plan) {
        const checks = [];
        const ok = (name, pass, detail) => checks.push({ name, ok: !!pass, detail: detail || null });
        const ownerUid = plan.ownerUid;
        // 1) what was written is what is there
        let mismatch = 0;
        for (const x of plan.records) { const cur = await db.records.findOne({ _id: x.before._id }); if (hashOf(cur) !== hashOf(x.after)) mismatch++; }
        for (const x of plan.teams) { const cur = await db.teams.findOne({ _id: x.before._id }); if (hashOf(cur) !== hashOf(x.after)) mismatch++; }
        ok('Every match record and team was written', !mismatch, mismatch ? `${mismatch} not as expected` : null);
        // 2) no score changed
        let scoreChanged = 0;
        for (const x of plan.records) { const cur = await db.records.findOne({ _id: x.before._id }); if (T.scoringFingerprint(cur) !== T.scoringFingerprint(x.before)) scoreChanged++; }
        ok('No run, wicket, over or result changed', !scoreChanged, scoreChanged ? `${scoreChanged} matches` : null);
        let ballChanged = 0;
        for (const x of plan.balls) {
            const cur = await db.balls.findOne({ _id: x.before._id });
            const strip = (b) => { const c = { ...b }; T.BALL_FIELDS.forEach(f => delete c[f]); return T.stable(c); };
            if (!cur || strip(cur) !== strip(x.before)) ballChanged++;
        }
        ok('Every delivery keeps its outcome', !ballChanged, ballChanged ? `${ballChanged} deliveries` : null);
        let mediaChanged = 0;
        for (const x of plan.clips) {
            const cur = await db.clips.findOne({ _id: x.before._id });
            if (!cur || T.CLIP_MEDIA_FIELDS.some(f => T.stable(cur[f]) !== T.stable(x.before[f]))) mediaChanged++;
        }
        ok('Every clip keeps its video (R2 / Drive / status untouched)', !mediaChanged, mediaChanged ? `${mediaChanged} clips` : null);
        // 3) no reference to a duplicate's Player ID is left anywhere
        const gone = new Set(plan.kind === 'merge' ? plan.mergeIds.filter(id => !id.startsWith('key:')) : []);
        if (gone.size) {
            const ids = [...gone];
            const recs = await db.records.find({ ownerUid }).toArray();
            let dangling = 0;
            recs.forEach(r => T.recordRefs(r, pk).forEach(x => { if (x.ids.some(i => gone.has(i))) dangling++; }));
            const ballLeft = await db.balls.find({ $or: ['strikerPlayerId', 'nonStrikerPlayerId', 'bowlerPlayerId', 'dismissedPlayerId', 'dismissalFielderPlayerId', 'strikerId', 'nonStrikerId', 'bowlerId'].map(f => ({ [f]: { $in: ids } })) }).toArray();
            const clipLeft = await db.clips.find({ $or: ['strikerPlayerId', 'nonStrikerPlayerId', 'bowlerPlayerId', 'fielderPlayerId', 'dismissedPlayerId'].map(f => ({ [f]: { $in: ids } })) }).toArray();
            const teamLeft = (await db.teams.find({ ownerUid }).toArray()).filter(t => (t.players || []).some(p => p && gone.has(p.id)) || gone.has(t.captainId) || gone.has(t.wkId));
            let panelLeft = 0;
            for (const x of plan.panelStates) { const cur = await db.panelStates.findOne({ _id: x.before._id }); if (ids.some(i => JSON.stringify(cur || {}).includes('"' + i + '"'))) panelLeft++; }
            const strayLeft = ballLeft.filter(b => !isStr(b.ownerUid) || b.ownerUid === ownerUid).length + clipLeft.filter(c => !isStr(c.ownerUid) || c.ownerUid === ownerUid).length;
            ok('No match, delivery, clip, team or snapshot still points at a removed Player ID', !(dangling + strayLeft + teamLeft.length + panelLeft),
                (dangling + strayLeft + teamLeft.length + panelLeft) ? `${dangling} in matches, ${strayLeft} deliveries / clips, ${teamLeft.length} teams, ${panelLeft} snapshots` : null);
        }
        // 4) the player's name, everywhere the player is
        const after = await loadAccount(ownerUid, { fresh: true });
        let wrongName = 0;
        for (const m of plan.matches.filter(x => x.map)) {
            const r = after.recs.find(x => String(x._id) === m.recId);
            if (!r) continue;
            T.recordRefs(r, pk).forEach(x => {
                if (x.side !== m.side || !isStr(x.name) || x.kind === 'howOut' || x.kind === 'partnership') return;
                const id = after.identOf(x);
                if ((id === plan.primaryId || plan.mergeIds.includes(id)) && x.name !== plan.finalName) wrongName++;
            });
        }
        ok(`“${plan.finalName}” is the name on every scorecard the player is in`, !wrongName, wrongName ? `${wrongName} references` : null);
        // 5) no duplicates in any roster
        let dupRoster = 0;
        (await db.teams.find({ ownerUid }).toArray()).forEach(t => { const ids = (t.players || []).map(p => p && p.id).filter(isStr); if (new Set(ids).size !== ids.length) dupRoster++; });
        after.recs.forEach(r => SIDES.forEach(side => { const sq = r['squad' + side]; const ids = sq && Array.isArray(sq.players) ? sq.players.map(p => p && p.id).filter(isStr) : []; if (new Set(ids).size !== ids.length) dupRoster++; }));
        ok('No player twice in one team or one match squad', !dupRoster, dupRoster ? `${dupRoster} rosters` : null);
        // 6) the numbers: recomputed from the database = the preview's
        const expect = statsPreview(plan).after;
        const p = after.people.get(plan.primaryId);
        const got = p ? { runs: p.batting.runs, innings: p.batting.innings, wickets: p.bowling.wickets, bowlBalls: p.bowling.balls, matches: p.matches } : null;
        const want = { runs: expect.batting.runs, innings: expect.batting.innings, wickets: expect.bowling.wickets, bowlBalls: expect.bowling.balls, matches: expect.matches };
        ok('Batting and bowling totals recalculated from the scorecards = the preview', got && T.stable(got) === T.stable(want), got ? `${got.runs} runs in ${got.innings} innings, ${got.wickets} wickets` : 'master not found');
        // 7) leaderboards: one entry for the player, none for an old spelling
        const oldKeys = new Set(Object.values(plan.originalNames).map(n => pk(n)).filter(k => k && k !== plan.finalKey));
        let oldOnBoard = 0, twiceOnBoard = 0;
        new Set(plan.matches.map(m => m.leagueKey).filter(Boolean)).forEach(lk => {
            const lb = deps.computeLeaderboards(after.recs.filter(r => r.leagueKey === lk));
            [lb.topRuns, lb.topWickets].forEach(list => {
                const keys = list.map(x => pk(x.name));
                if (keys.some(k => oldKeys.has(k))) oldOnBoard++;
                if (keys.filter(k => k === plan.finalKey).length > 1) twiceOnBoard++;
            });
        });
        ok('Leaderboards list the player once, under the corrected name', !oldOnBoard && !twiceOnBoard, (oldOnBoard || twiceOnBoard) ? `${oldOnBoard} boards still list an old spelling` : null);
        // 8) the profiles
        const master = await db.players.findOne({ ownerUid, playerId: plan.primaryId });
        ok('The master profile keeps its Player ID and the corrected name', master && master.displayName === plan.finalName && (master.nameKeys || []).includes(plan.finalKey) && !isStr(master.mergedInto));
        if (plan.kind === 'merge') {
            const dups = await db.players.find({ ownerUid, playerId: { $in: plan.mergeIds } }).toArray();
            ok('Every duplicate profile is retired (removed in clean-up)', dups.every(d => isStr(d.mergedInto) && d.mergedInto === plan.primaryId));
        }
        return { at: now(), checks };
    }

    // ================================================================
    // Restore from the backups (an automatic rollback, or the owner's)
    // ================================================================
    async function restore(opId, opts) {
        opts = opts || {};
        const rows = await db.backups.find({ opId }).toArray();
        const current = async (row) => {
            if (row.coll === 'roomStates') return rooms ? await rooms.read(row.key) : null;
            const coll = db[row.coll];
            if (!coll) return null;
            const byId = row.before && row.before._id !== undefined ? row.before._id : row.key;
            return await coll.findOne({ _id: byId });
        };
        if (opts.requireUnchanged) {
            const changed = [];
            for (const row of rows) {
                if (!row.afterHash) continue; // never written
                const cur = await current(row);
                const want = row.afterHash === 'deleted' ? 'none' : row.afterHash;
                if (hashIn(row.coll, cur) !== want) changed.push(describeRow(row));
            }
            if (changed.length) return { ok: false, changed, restored: 0, error: 'Changed since this operation' };
        }
        let restored = 0;
        const order = ['tombstones', 'players:primary', 'players:merged', 'records', 'balls', 'clips', 'teams', 'panelStates', 'commentary', 'roomStates'];
        const bucket = (row) => (row.coll === 'players' ? 'players:' + (row.role || 'primary') : row.coll);
        for (const b of order) {
            for (const row of rows.filter(r => bucket(r) === b)) {
                if (!row.afterHash && !opts.force) continue; // nothing was written for it
                if (row.coll === 'roomStates') { if (rooms && row.before) await rooms.write(row.key, row.before); restored++; continue; }
                const coll = db[row.coll];
                if (!coll) continue;
                if (row.before == null) { await coll.deleteOne({ _id: row.key }); restored++; continue; }
                const r = await coll.replaceOne({ _id: row.before._id }, row.before);
                if (!r || !r.matchedCount) await coll.insertOne(row.before);
                restored++;
            }
        }
        // what was restored is what is there
        let wrong = 0;
        for (const row of rows) {
            if (!row.afterHash && !opts.force) continue;
            const cur = await current(row);
            if (hashIn(row.coll, cur) !== hashIn(row.coll, row.before)) wrong++;
        }
        return { ok: !wrong, restored, error: wrong ? `${wrong} documents could not be restored` : null };
    }
    function describeRow(row) {
        const b = row.before || {};
        if (row.coll === 'records') return `Match record ${b.matchId || row.key}${b.teamA && b.teamB ? ` (${b.teamA.name} vs ${b.teamB.name})` : ''}`;
        if (row.coll === 'teams') return `Team ${b.name || row.key}`;
        if (row.coll === 'players') return `Player profile ${b.playerId || row.key}`;
        if (row.coll === 'balls') return `A delivery of match ${b.matchId || '?'} (${b.over}.${b.ballInOver})`;
        if (row.coll === 'clips') return `Clip ${b.clipId || row.key}`;
        if (row.coll === 'tombstones') return 'The removed-ID record';
        return `${row.coll} ${row.key}`;
    }

    async function rollback(viewer, opId) {
        assertViewer(viewer);
        const op = await db.ops.findOne({ _id: String(opId || '') });
        if (!op) throw httpError(404, 'Operation not found');
        await checkAccount(viewer, op.ownerUid);
        if (op.status !== 'completed') throw httpError(409, op.status === 'rolled_back' ? 'This operation was already rolled back' : 'Only a completed operation can be rolled back');
        const newer = await db.ops.find({ ownerUid: op.ownerUid, status: 'completed', completedAt: { $gt: op.completedAt } }).toArray();
        await takeLock(op.ownerUid, opId, (op.matches || []).flatMap(m => [m.matchId, m.roomId].filter(Boolean)));
        try {
            await db.ops.updateOne({ _id: opId }, { $set: { rollbackStages: [] } });
            const rs = async (name, status, detail) => db.ops.updateOne({ _id: opId }, { $push: { rollbackStages: { name, status, at: now(), ...(detail ? { detail } : {}) } } });
            await rs('checking', 'running');
            const rows = await db.backups.find({ opId }).toArray();
            const changed = [];
            for (const row of rows) {
                if (!row.afterHash) continue;
                const cur = row.coll === 'roomStates' ? (rooms ? await rooms.read(row.key) : null) : await db[row.coll].findOne({ _id: row.before && row.before._id !== undefined ? row.before._id : row.key });
                const want = row.afterHash === 'deleted' ? 'none' : row.afterHash;
                if (hashIn(row.coll, cur) !== want) changed.push(describeRow(row));
            }
            if (changed.length) {
                await rs('checking', 'error', `${changed.length} changed since`);
                await db.ops.updateOne({ _id: opId }, { $set: { lastRollbackRefused: { at: now(), by: viewer.email, changed: changed.slice(0, 50) } } });
                throw httpError(409, `This cannot be rolled back safely: ${changed.length} record${changed.length === 1 ? '' : 's'} changed after it${newer.length ? ` (${newer.length} later player operation${newer.length === 1 ? '' : 's'} — roll those back first)` : ''}. Nothing was changed.`, { code: 'CHANGED_SINCE', changed: changed.slice(0, 50) });
            }
            await rs('checking', 'done', 'Nothing changed since — safe to restore');
            await rs('restoring', 'running');
            const r = await restore(opId, { requireUnchanged: false });
            await rs('restoring', r.ok ? 'done' : 'error', `${r.restored} documents restored`);
            await rs('verifying', r.ok ? 'done' : 'error', r.ok ? 'Every document is back as it was' : r.error);
            const fakePlan = { ctx: await loadAccount(op.ownerUid, { fresh: true }), matches: op.matches || [], clips: [], players: [], mergeIds: op.mergeIds || [], primaryId: op.primaryId, ownerUid: op.ownerUid, finalKey: pk(op.finalName) };
            dropCaches(fakePlan);
            forgetAccount(op.ownerUid);
            if (!r.ok) throw httpError(500, 'Rollback incomplete: ' + r.error);
            await db.ops.updateOne({ _id: opId }, { $set: { status: 'rolled_back', rolledBackAt: now(), rollbackBy: viewer.email } });
            if (deps.logAuditAction) await deps.logAuditAction(viewer.email, 'Player operation rolled back', `${op.kind === 'merge' ? 'Global player replace' : 'Correct player name'} ${opId} — ${op.finalName}`, null, null, { opId }).catch(() => {});
            return { opId, status: 'rolled_back', restored: r.restored };
        } finally {
            await releaseLock(op.ownerUid, opId);
        }
    }

    async function getOp(viewer, opId) {
        assertViewer(viewer);
        const op = await db.ops.findOne({ _id: String(opId || '') });
        if (!op) throw httpError(404, 'Operation not found');
        await checkAccount(viewer, op.ownerUid);
        return { op: { ...opSummary(op), matches: op.matches || [], blockers: op.blockers || [], skipped: op.skipped || [], expected: op.expected || null, leaderboards: op.leaderboards || null, rollbackStages: op.rollbackStages || [], lastRollbackRefused: op.lastRollbackRefused || null } };
    }
    async function listOps(viewer, q) {
        assertViewer(viewer);
        const ownerUid = String((q && q.ownerUid) || viewer.uid);
        await checkAccount(viewer, ownerUid);
        const ops = await db.ops.find({ ownerUid }).sort({ createdAt: -1 }).limit(200).toArray();
        return { ops: ops.filter(o => o.status !== 'previewed').map(opSummary) };
    }

    // An operation a restart cut off: put every document back.
    async function recoverInterrupted() {
        const cut = await db.ops.find({ status: 'running' }).toArray();
        for (const op of cut) {
            const r = await restore(op._id, { requireUnchanged: false, force: true }).catch(e => ({ ok: false, error: e.message, restored: 0 }));
            await db.ops.updateOne({ _id: op._id }, { $set: { status: 'failed', error: 'Interrupted by a server restart — every document was put back', rollback: { automatic: true, ok: r.ok, restored: r.restored, at: now() } } });
            await db.locks.deleteOne({ _id: 'identity:' + op.ownerUid }).catch(() => {});
        }
        return cut.length;
    }

    return { accounts, overview, search, player, preview, execute, getOp, listOps, rollback, recoverInterrupted, lockFor, isIdentityAdminEmail, _running: running };
}

module.exports = {
    createPlayerIdentity, isIdentityAdminEmail, IDENTITY_ADMIN_EMAIL, STAGES, ROLLBACK_STAGES,
    _internals: { foldName, nameMatch, searchScore, phonetic, skeleton, transformPanelState, transformCommentary, finishStats, emptyStats, addBatting, addBowling }
};
