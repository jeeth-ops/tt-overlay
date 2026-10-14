'use strict';
// ================================================================
// 🔀 MERGE TOURNAMENTS — the engine behind /merge-tournaments.
//
// Folds every match of one tournament (the SOURCE) into another tournament
// of the same account (the DESTINATION), then removes the source — and only
// after the merged destination has been checked.
//
// What a tournament is in this app (see server.js): a `leagues` doc keyed by
// (ownerUid, leagueKey) plus one `matchRecords` doc per match carrying that
// leagueKey. Balls and clips never name a tournament — they hang off the
// match's live room id — so moving a match is a leagueKey change on its
// record, and its ball log and clips follow on their own. The points table
// and leaderboards are never stored: computePointsTable() /
// computeLeaderboards() rebuild them from matchRecords on every read, so
// "rebuilding" them means making sure every match is there exactly once,
// then dropping the response caches.
//
// Player identity: a player is a playerId PROFILE per account (`players`:
// playerId + every nameKey merged into it). Ids are account-wide, never
// tournament-scoped. The same person can still end up with two ids (two
// spellings, an id minted offline) — the merge finds those pairs and asks
// which id survives; it never joins two players on a similar name alone.
// Records in OTHER tournaments are never rewritten; linking the profiles
// (mergedInto, exactly as the existing player merge does) is what makes an
// old id elsewhere resolve to the surviving one.
//
// Safety: every document the merge changes is copied into
// tournamentMergeBackups first. Each stage recomputes its writes from those
// copies, so a stage can run twice with the same result — a merge that dies
// half way is resumed or rolled back, never left guessing. The source is
// deleted last, after verification. Media (R2 / Drive files) is never
// touched — only player fields on clip documents.
// ================================================================
const crypto = require('crypto');

// Only these two accounts may see or run a merge. Fixed in code on purpose:
// an environment variable could quietly widen it.
const MERGE_ADMIN_EMAILS = Object.freeze(['chhayajeeth@gmail.com', 'workallsportslive@gmail.com']);
function isMergeAdminEmail(email) {
    return MERGE_ADMIN_EMAILS.includes(String(email || '').trim().toLowerCase());
}

// The stages a merge reports, in order (the progress screen shows these).
const STAGES = Object.freeze(['analyzing', 'validating', 'transferring', 'recalculating', 'verifying', 'completed']);

const SIDES = ['A', 'B'];
const otherSide = (s) => (s === 'A' ? 'B' : 'A');
const sideOf = (v) => (v === 'A' || v === 'B' ? v : null);
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const safeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

// Deep copy that keeps ObjectIds and Dates as they are (a plain JSON round
// trip would turn an _id into a string and break every lookup by it).
function deepClone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return new Date(v.getTime());
    if (v._bsontype) return v;
    if (Array.isArray(v)) return v.map(deepClone);
    const out = {};
    for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
    return out;
}

// Deterministic JSON (sorted keys) — for fingerprints and comparisons.
function stable(v) {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (v instanceof Date) return JSON.stringify(v.toISOString());
    if (v._bsontype) return JSON.stringify(String(v));
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
const sha = (s, n) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n || 64);

class DSU {
    constructor() { this.p = new Map(); }
    find(x) {
        if (!this.p.has(x)) this.p.set(x, x);
        let r = x;
        while (this.p.get(r) !== r) r = this.p.get(r);
        let c = x;
        while (this.p.get(c) !== r) { const n = this.p.get(c); this.p.set(c, r); c = n; }
        return r;
    }
    union(a, b) {
        const ra = this.find(a), rb = this.find(b);
        if (ra === rb) return;
        // smaller root wins, so the same data always gives the same roots
        if (ra < rb) this.p.set(rb, ra); else this.p.set(ra, rb);
    }
}

function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        const t = prev; prev = cur; cur = t;
    }
    return prev[n];
}
const nameTokens = (k) => String(k || '').replace(/[.'’`_-]/g, ' ').split(/\s+/).filter(Boolean);

// Two DIFFERENT name keys that could be one person typed two ways:
//   "jeeth" ~ "jeeth chhaya" (one is the other with a surname added)
//   "r sharma" ~ "rohit sharma" (an initial for the first name)
//   "rohit sharmma" ~ "rohit sharma" (a typo — one letter on short names,
//   two on long ones, so "rahul" and "rahim" are NOT flagged).
// This only ever puts a pair in front of the user; it never merges anything.
function similarNames(a, b) {
    if (!a || !b || a === b) return false;
    const ta = nameTokens(a), tb = nameTokens(b);
    if (!ta.length || !tb.length) return false;
    const [s, l] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (s.length < l.length && s[0] === l[0] && s.every(t => l.includes(t))) return true;
    if (ta.length >= 2 && tb.length >= 2 && ta[ta.length - 1] === tb[tb.length - 1]
        && ta[0][0] === tb[0][0] && (ta[0].length === 1 || tb[0].length === 1)) return true;
    const aj = ta.join(' '), bj = tb.join(' ');
    const len = Math.min(aj.length, bj.length);
    const d = levenshtein(aj, bj);
    return (len >= 4 && d === 1) || (len >= 12 && d === 2);
}
function similarTeams(a, b, shortA, shortB) {
    if (!a || !b || a === b) return false;
    const sa = norm(shortA), sb = norm(shortB);
    if (sa && sb && sa.length >= 2 && sa === sb) return true;
    return similarNames(a, b);
}

// Swaps names inside a line of scorecard text ("c Rahul b Jeeth C",
// "MUMBAI INDIAN WON BY 5 RUNS"): whole words only, any case, an all-capitals
// original stays all capitals. `keep` lists names that must not be touched —
// the longest name wins at each position, so "Jeeth Chhaya" is never mistaken
// for "Jeeth" + something.
function replaceNames(text, renames, keep) {
    if (typeof text !== 'string' || !text || !renames || !renames.length) return text;
    const table = new Map();
    (keep || []).forEach(n => { const k = norm(n); if (k && !table.has(k)) table.set(k, null); });
    renames.forEach(([from, to]) => { const k = norm(from); if (k && to) table.set(k, to); });
    if (![...table.values()].some(Boolean)) return text;
    const alts = [...table.keys()].sort((x, y) => y.length - x.length).map(k => k.split(' ').map(escRe).join('\\s+'));
    const re = new RegExp('(^|[^\\p{L}\\p{N}])(' + alts.join('|') + ')(?=$|[^\\p{L}\\p{N}])', 'giu');
    return text.replace(re, (m, pre, hit) => {
        const to = table.get(norm(hit));
        if (!to || norm(to) === norm(hit) && to === hit) return m;
        const upper = hit === hit.toUpperCase() && hit !== hit.toLowerCase();
        return pre + (upper ? to.toUpperCase() : to);
    });
}

// Which clips belong to a match: one tagged with its tournament match id is
// its own (unless two saved matches share that id — then the room decides);
// an untagged clip goes by the match's own room id.
function clipBelongs(rule, c) {
    if (isStr(c.tournamentMatchId)) return c.tournamentMatchId === rule.matchId && (!rule.clash || rule.ownKeys.includes(c.matchId));
    return rule.ownKeys.includes(c.matchId);
}

// A merged-away profile keeps a key no typed name can produce. An empty
// nameKeys list is NOT used: under the unique (ownerUid, nameKeys) index two
// profiles with [] would collide.
const retiredKey = (playerId) => '#merged:' + playerId;

const topOf = (m) => {
    let best = null, n = -1;
    for (const [k, c] of m) if (c > n || (c === n && String(k) < String(best))) { best = k; n = c; }
    return best;
};
const bump = (m, k, by) => { if (k == null || k === '') return; m.set(k, (m.get(k) || 0) + (by || 1)); };

// ---------------------------------------------------------------
// Where a saved match names a player
// ---------------------------------------------------------------
function refOf(side, name, ids, kind, extra, pk) {
    const nm = typeof name === 'string' ? name.trim()
        : (name && typeof name === 'object' && typeof name.name === 'string' ? name.name.trim() : '');
    const key = nm ? pk(nm) : null;
    const idList = [...new Set((ids || []).filter(isStr).map(x => x.trim()))];
    if (!key && !idList.length) return null;
    return Object.assign({ side, name: nm || null, key: key || null, ids: idList, kind }, extra || {});
}

// The team that batted in innings n of a saved match (null when unknown).
function inningsBattingSide(rec, n) {
    const arch = Array.isArray(rec.inningsArchive) ? rec.inningsArchive : [];
    const hit = arch.find(e => e && Number(e.no) === Number(n));
    if (hit && sideOf(hit.team)) return hit.team;
    for (const s of SIDES) {
        if (((rec.battingCard && rec.battingCard[s]) || []).some(r => r && Number(r.inningsNo || 1) === Number(n))) return s;
    }
    return null;
}

// Every place a match record names a player, with the side (team A/B) that
// player belongs to: squads, batting/bowling cards (and the bowler/fielder
// named in a batter's dismissal — the OTHER side), Impact Player swaps,
// Super Over cards and partnerships.
function recordRefs(rec, pk) {
    const out = [];
    const push = (r) => { if (r) out.push(r); };
    SIDES.forEach(side => {
        const sq = rec['squad' + side];
        if (sq && Array.isArray(sq.players)) {
            sq.players.forEach(p => p && push(refOf(side, p.name, [p.id], 'squad', {
                hand: p.hand === 'L' ? 'L' : null,
                captain: !!(sq.captainId && p.id === sq.captainId),
                wk: !!(sq.wkId && p.id === sq.wkId)
            }, pk)));
        }
        ((rec.battingCard && rec.battingCard[side]) || []).forEach(r => {
            if (!r) return;
            push(refOf(side, r.name, [r.id], 'bat', { runs: Number(r.runs) || 0, balls: Number(r.balls) || 0 }, pk));
            if (r.bowlerName) push(refOf(otherSide(side), r.bowlerName, [], 'howOut', null, pk));
            if (r.fielderName) push(refOf(otherSide(side), r.fielderName, [], 'howOut', null, pk));
        });
        ((rec.bowlingCard && rec.bowlingCard[side]) || []).forEach(r => r && push(refOf(side, r.name, [r.id], 'bowl', {
            wickets: Number(r.wickets) || 0, runs: Number(r.runs) || 0
        }, pk)));
    });
    (Array.isArray(rec.impactPlayers) ? rec.impactPlayers : []).forEach(e => {
        const side = e && sideOf(e.team);
        if (!side) return;
        push(refOf(side, e.inName, [e.inId], 'impact', null, pk));
        push(refOf(side, e.outName, [e.outId], 'impact', null, pk));
    });
    const so = rec.superOver;
    (so && Array.isArray(so.innings) ? so.innings : []).forEach(inn => {
        const bat = inn && sideOf(inn.team);
        if (!bat) return;
        (inn.battingCard || []).forEach(r => r && push(refOf(bat, r.name, [r.id], 'superOver', null, pk)));
        (inn.bowlingCard || []).forEach(r => r && push(refOf(otherSide(bat), r.name, [r.id], 'superOver', null, pk)));
    });
    const ps = rec.partnerships;
    if (ps && typeof ps === 'object') {
        Object.keys(ps).forEach(n => {
            const side = inningsBattingSide(rec, n);
            if (!side) return;
            (Array.isArray(ps[n]) ? ps[n] : []).forEach(p => (p && Array.isArray(p.batters) ? p.batters : [])
                .forEach(b => push(refOf(side, b, [], 'partnership', null, pk))));
        });
    }
    return out;
}

// The player slots of one logged delivery. Striker, non-striker and the
// batter given out play for the batting team; bowler and fielder for the other.
function ballSlots(b) {
    const bt = sideOf(b.battingTeam), bw = bt ? otherSide(bt) : null;
    const d = b.dismissal && typeof b.dismissal === 'object' ? b.dismissal : null;
    const out = [
        { side: bt, name: b.striker || b.strikerKey, ids: [b.strikerPlayerId, b.strikerId] },
        { side: bt, name: b.nonStriker || b.nonStrikerKey, ids: [b.nonStrikerPlayerId, b.nonStrikerId] },
        { side: bw, name: b.bowler || b.bowlerKey, ids: [b.bowlerPlayerId, b.bowlerId] }
    ];
    if (d) {
        out.push({ side: bt, name: d.batter || b.dismissedPlayerKey, ids: [b.dismissedPlayerId, d.batterId] });
        out.push({ side: bw, name: d.fielder || b.dismissalFielderKey, ids: [b.dismissalFielderPlayerId, d.fielderId] });
    }
    return out;
}
function clipSide(c) {
    const bm = c.ballMeta && typeof c.ballMeta === 'object' ? c.ballMeta : null;
    return sideOf(c.battingTeam) || (bm && sideOf(bm.battingTeam)) || null;
}
function clipSlots(c) {
    const bt = clipSide(c), bw = bt ? otherSide(bt) : null;
    const bm = c.ballMeta && typeof c.ballMeta === 'object' ? c.ballMeta : null;
    const out = [
        { side: bt, name: c.strikerName || c.strikerKey, ids: [c.strikerPlayerId] },
        { side: bt, name: c.nonStrikerName || c.nonStrikerKey, ids: [c.nonStrikerPlayerId] },
        { side: bt, name: c.dismissedPlayerName || c.dismissedPlayerKey, ids: [c.dismissedPlayerId] },
        { side: bw, name: c.bowlerName || c.bowlerKey, ids: [c.bowlerPlayerId] },
        { side: bw, name: c.fielderName || c.fielderKey, ids: [c.fielderPlayerId] }
    ];
    if (bm) {
        out.push({ side: bt, name: bm.striker, ids: [bm.strikerId] }, { side: bt, name: bm.nonStriker, ids: [bm.nonStrikerId] }, { side: bw, name: bm.bowler, ids: [bm.bowlerId] });
        const d = bm.dismissal && typeof bm.dismissal === 'object' ? bm.dismissal : null;
        if (d) out.push({ side: bt, name: d.batter, ids: [d.batterId, bm.dismissedPlayerId] }, { side: bw, name: d.fielder, ids: [d.fielderId] });
    }
    return out;
}

// ---------------------------------------------------------------
// Rename maps — how one match's references change
//   canon: [{ id, name, key }]   the surviving identities (name null = keep
//                                the name, only the id changes)
//   ids:   [[storedId, i]]       any reference carrying that id
//   A, B:  [[nameKey, i]]        references with NO id, on that team
//   names: { A, B: [[shown name, i]] } — for free text (dismissal lines)
// Arrays, not objects: Mongo field names cannot hold every player name.
// ---------------------------------------------------------------
function hydrate(map) {
    if (!map) return null;
    if (map._h) return map;
    return {
        _h: true,
        canon: map.canon || [],
        ids: new Map(map.ids || []),
        A: new Map(map.A || []),
        B: new Map(map.B || []),
        names: { A: (map.names && map.names.A) || [], B: (map.names && map.names.B) || [] }
    };
}
// A reference resolves through an id the map knows; a reference with no id
// at all is matched on its name, within its own team; a reference carrying
// some OTHER id is never touched.
function resolveRef(mm, side, name, ids, pk) {
    if (!mm) return null;
    const idl = (ids || []).filter(isStr);
    for (const id of idl) if (mm.ids.has(id)) return mm.canon[mm.ids.get(id)];
    if (idl.length) return null;
    const k = isStr(name) ? pk(name) : null;
    if (k && side && mm[side].has(k)) return mm.canon[mm[side].get(k)];
    return null;
}
// Rewrites one player slot: its name, its nameKey field and every id field.
function rewriteSlot(mm, side, holder, nameField, keyHolder, keyField, idSpecs, pk) {
    const shown = holder && isStr(holder[nameField]) ? holder[nameField]
        : (keyHolder && keyField && isStr(keyHolder[keyField]) ? keyHolder[keyField] : null);
    const c = resolveRef(mm, side, shown, idSpecs.map(([o, f]) => o && o[f]), pk);
    if (!c) return 0;
    let n = 0;
    if (c.name && holder && isStr(holder[nameField]) && holder[nameField] !== c.name) { holder[nameField] = c.name; n++; }
    if (c.name && keyHolder && keyField && keyHolder[keyField] != null && keyHolder[keyField] !== c.key) { keyHolder[keyField] = c.key; n++; }
    if (c.id) idSpecs.forEach(([o, f]) => { if (o && isStr(o[f]) && o[f] !== c.id) { o[f] = c.id; n++; } });
    return n;
}
function renameNameOnly(mm, side, holder, field, pk) {
    if (!holder || !isStr(holder[field])) return 0;
    const c = resolveRef(mm, side, holder[field], [], pk);
    if (c && c.name && c.name !== holder[field]) { holder[field] = c.name; return 1; }
    return 0;
}
function sideTextRenames(mm, side) {
    const out = [];
    for (const [shown, i] of mm.names[side]) {
        const c = mm.canon[i];
        if (c && c.name && c.name !== shown) out.push([shown, c.name]);
    }
    return out;
}

// One saved match record with a rename map (and team renames) applied.
// Scores, cards' numbers, results and everything else are copied as they are.
function transformRecord(rec, map, teamRename, pk) {
    const mm = hydrate(map);
    const r = deepClone(rec);
    let n = 0;
    if (mm) {
        const keep = { A: [], B: [] };
        recordRefs(rec, pk).forEach(ref => { if (ref.side && ref.name) keep[ref.side].push(ref.name); });
        const renames = { A: sideTextRenames(mm, 'A'), B: sideTextRenames(mm, 'B') };
        const fixText = (holder, field, side) => {
            if (!holder || typeof holder[field] !== 'string') return;
            const t = replaceNames(holder[field], renames[side], keep[side]);
            if (t !== holder[field]) { holder[field] = t; n++; }
        };
        const fixBatRow = (row, side) => {
            if (!row) return;
            n += rewriteSlot(mm, side, row, 'name', null, null, [[row, 'id']], pk);
            n += renameNameOnly(mm, otherSide(side), row, 'bowlerName', pk);
            n += renameNameOnly(mm, otherSide(side), row, 'fielderName', pk);
            fixText(row, 'howOut', otherSide(side));
        };
        SIDES.forEach(side => {
            const sq = r['squad' + side];
            if (sq && Array.isArray(sq.players)) {
                sq.players.forEach(p => { if (p) n += rewriteSlot(mm, side, p, 'name', null, null, [[p, 'id']], pk); });
                // the same person twice in one squad (two ids before) → once
                const seen = new Map();
                sq.players = sq.players.filter(p => {
                    if (!p || !isStr(p.id)) return true;
                    const prev = seen.get(p.id);
                    if (prev) { if (p.isXI !== false) prev.isXI = true; n++; return false; }
                    seen.set(p.id, p);
                    return true;
                });
                ['captainId', 'wkId'].forEach(f => {
                    if (isStr(sq[f]) && mm.ids.has(sq[f])) {
                        const c = mm.canon[mm.ids.get(sq[f])];
                        if (c && c.id && c.id !== sq[f]) { sq[f] = c.id; n++; }
                    }
                });
            }
            ((r.battingCard && r.battingCard[side]) || []).forEach(row => fixBatRow(row, side));
            ((r.bowlingCard && r.bowlingCard[side]) || []).forEach(row => {
                if (row) n += rewriteSlot(mm, side, row, 'name', null, null, [[row, 'id']], pk);
            });
        });
        (Array.isArray(r.impactPlayers) ? r.impactPlayers : []).forEach(e => {
            const side = e && sideOf(e.team);
            if (!side) return;
            n += rewriteSlot(mm, side, e, 'inName', null, null, [[e, 'inId']], pk);
            n += rewriteSlot(mm, side, e, 'outName', null, null, [[e, 'outId']], pk);
        });
        const so = r.superOver;
        (so && Array.isArray(so.innings) ? so.innings : []).forEach(inn => {
            const bat = inn && sideOf(inn.team);
            if (!bat) return;
            (inn.battingCard || []).forEach(row => fixBatRow(row, bat));
            (inn.bowlingCard || []).forEach(row => { if (row) n += rewriteSlot(mm, otherSide(bat), row, 'name', null, null, [[row, 'id']], pk); });
        });
        const ps = r.partnerships;
        if (ps && typeof ps === 'object') {
            Object.keys(ps).forEach(inn => {
                const side = inningsBattingSide(rec, inn);
                if (!side) return;
                (Array.isArray(ps[inn]) ? ps[inn] : []).forEach(p => {
                    if (!p || !Array.isArray(p.batters)) return;
                    let changed = false;
                    p.batters = p.batters.map(b => {
                        const c = isStr(b) ? resolveRef(mm, side, b, [], pk) : null;
                        if (c && c.name && c.name !== b) { changed = true; return c.name; }
                        return b;
                    });
                    if (changed) {
                        n++;
                        if (typeof p.pairKey === 'string') p.pairKey = p.batters.map(x => x || '').sort().join('|');
                    }
                });
            });
        }
    }
    if (teamRename) {
        SIDES.forEach(side => {
            const t = teamRename[side];
            if (!t) return;
            const team = r['team' + side] = Object.assign({}, r['team' + side] || {});
            const oldName = team.name;
            if (t.name && team.name !== t.name) { team.name = t.name; n++; }
            if (t.short && team.short !== t.short) { team.short = t.short; n++; }
            if (t.teamId && team.teamId !== t.teamId) { team.teamId = t.teamId; n++; }
            if (isStr(oldName) && t.name && oldName !== t.name) {
                const otherName = (r['team' + otherSide(side)] || {}).name;
                const swap = (holder, f) => {
                    if (!holder || typeof holder[f] !== 'string') return;
                    const x = replaceNames(holder[f], [[oldName, t.name]], otherName ? [otherName] : []);
                    if (x !== holder[f]) { holder[f] = x; n++; }
                };
                swap(r, 'resultText');
                swap(r, 'matchResultText');
                if (r.superOver) swap(r.superOver, 'resultText');
            }
        });
    }
    return { doc: r, changes: n };
}

const BALL_FIELDS = ['striker', 'strikerKey', 'strikerPlayerId', 'strikerId', 'nonStriker', 'nonStrikerKey', 'nonStrikerPlayerId', 'nonStrikerId',
    'bowler', 'bowlerKey', 'bowlerPlayerId', 'bowlerId', 'dismissal', 'dismissedPlayerKey', 'dismissedPlayerId', 'dismissalFielderKey', 'dismissalFielderPlayerId'];
// The $set that renames the players of one logged delivery (null = unchanged).
// Runs, kind, over/ball numbers and the score snapshot are never part of it.
function transformBall(b, map, pk) {
    const mm = hydrate(map);
    if (!mm || !b) return null;
    const x = deepClone(b);
    const bt = sideOf(x.battingTeam), bw = bt ? otherSide(bt) : null;
    let n = 0;
    n += rewriteSlot(mm, bt, x, 'striker', x, 'strikerKey', [[x, 'strikerPlayerId'], [x, 'strikerId']], pk);
    n += rewriteSlot(mm, bt, x, 'nonStriker', x, 'nonStrikerKey', [[x, 'nonStrikerPlayerId'], [x, 'nonStrikerId']], pk);
    n += rewriteSlot(mm, bw, x, 'bowler', x, 'bowlerKey', [[x, 'bowlerPlayerId'], [x, 'bowlerId']], pk);
    if (x.dismissal && typeof x.dismissal === 'object') {
        n += rewriteSlot(mm, bt, x.dismissal, 'batter', x, 'dismissedPlayerKey', [[x, 'dismissedPlayerId'], [x.dismissal, 'batterId']], pk);
        n += rewriteSlot(mm, bw, x.dismissal, 'fielder', x, 'dismissalFielderKey', [[x, 'dismissalFielderPlayerId'], [x.dismissal, 'fielderId']], pk);
    }
    if (!n) return null;
    const set = {};
    BALL_FIELDS.forEach(f => { if (stable(x[f]) !== stable(b[f])) set[f] = x[f]; });
    return Object.keys(set).length ? set : null;
}

const CLIP_FIELDS = ['strikerName', 'strikerKey', 'strikerPlayerId', 'nonStrikerName', 'nonStrikerKey', 'nonStrikerPlayerId',
    'bowlerName', 'bowlerKey', 'bowlerPlayerId', 'fielderName', 'fielderKey', 'fielderPlayerId',
    'dismissedPlayerName', 'dismissedPlayerKey', 'dismissedPlayerId', 'ballMeta'];
// The fields a clip keeps its media in — compared before/after, never written.
const CLIP_MEDIA_FIELDS = ['r2Key', 'r2Url', 'r2PosterKey', 'r2PosterUrl', 'driveFileId', 'driveUrl', 'status', 'r2Status', 'driveStatus', 'clipId', 'matchId'];
// The $set that renames the players linked to one clip (null = unchanged).
function transformClip(c, map, pk) {
    const mm = hydrate(map);
    if (!mm || !c) return null;
    const x = deepClone(c);
    const bt = clipSide(x), bw = bt ? otherSide(bt) : null;
    let n = 0;
    n += rewriteSlot(mm, bt, x, 'strikerName', x, 'strikerKey', [[x, 'strikerPlayerId']], pk);
    n += rewriteSlot(mm, bt, x, 'nonStrikerName', x, 'nonStrikerKey', [[x, 'nonStrikerPlayerId']], pk);
    n += rewriteSlot(mm, bt, x, 'dismissedPlayerName', x, 'dismissedPlayerKey', [[x, 'dismissedPlayerId']], pk);
    n += rewriteSlot(mm, bw, x, 'bowlerName', x, 'bowlerKey', [[x, 'bowlerPlayerId']], pk);
    n += rewriteSlot(mm, bw, x, 'fielderName', x, 'fielderKey', [[x, 'fielderPlayerId']], pk);
    const bm = x.ballMeta && typeof x.ballMeta === 'object' ? x.ballMeta : null;
    if (bm) {
        n += rewriteSlot(mm, bt, bm, 'striker', null, null, [[bm, 'strikerId']], pk);
        n += rewriteSlot(mm, bt, bm, 'nonStriker', null, null, [[bm, 'nonStrikerId']], pk);
        n += rewriteSlot(mm, bw, bm, 'bowler', null, null, [[bm, 'bowlerId']], pk);
        const d = bm.dismissal && typeof bm.dismissal === 'object' ? bm.dismissal : null;
        if (d) {
            n += rewriteSlot(mm, bt, d, 'batter', null, null, [[d, 'batterId'], [bm, 'dismissedPlayerId']], pk);
            n += rewriteSlot(mm, bw, d, 'fielder', null, null, [[d, 'fielderId']], pk);
        } else if (isStr(bm.dismissedPlayerId)) {
            n += rewriteSlot(mm, bt, bm, '__none', null, null, [[bm, 'dismissedPlayerId']], pk);
        }
    }
    if (!n) return null;
    const set = {};
    CLIP_FIELDS.forEach(f => { if (stable(x[f]) !== stable(c[f])) set[f] = x[f]; });
    return Object.keys(set).length ? set : null;
}

// Everything a match record says about the CRICKET, none of the names —
// equal before and after a merge, or the merge changed a score.
function scoringFingerprint(rec) {
    const bat = (rows) => (rows || []).map(r => r ? [Number(r.runs) || 0, Number(r.balls) || 0, Number(r.fours) || 0, Number(r.sixes) || 0, !!r.out, Number(r.inningsNo) || 1] : null);
    const bowl = (rows) => (rows || []).map(r => r ? [Number(r.overs) || 0, Number(r.balls) || 0, Number(r.runs) || 0, Number(r.wickets) || 0, Number(r.maidens) || 0, Number(r.inningsNo) || 1] : null);
    const so = rec.superOver && Array.isArray(rec.superOver.innings)
        ? rec.superOver.innings.map(i => i ? [i.team || null, i.runs || 0, i.wickets || 0, i.overs || null] : null) : null;
    return stable({
        a: rec.scoreA || null, b: rec.scoreB || null, w: rec.winningTeam || null, u: !!rec.upcoming,
        bat: { A: bat(rec.battingCard && rec.battingCard.A), B: bat(rec.battingCard && rec.battingCard.B) },
        bowl: { A: bowl(rec.bowlingCard && rec.bowlingCard.A), B: bowl(rec.bowlingCard && rec.bowlingCard.B) },
        ex: rec.extras || null, fow: rec.fallOfWickets || null, so,
        fmt: rec.format || null, date: rec.matchDate || null
    });
}

function matchStatus(rec) {
    if (rec.upcoming === true) return 'upcoming';
    if (rec.winningTeam) return 'completed';
    return 'ongoing';
}

// Same match saved twice (a copy) — vs an unrelated match that happens to
// carry the same id.
function sameMatch(a, b) {
    if (isStr(a.roomId) && a.roomId === b.roomId) return true;
    const t = (r) => [norm(r.teamA && r.teamA.name), norm(r.teamB && r.teamB.name)].sort().join('|');
    const day = (r) => String(r.matchDate || r.savedAt || '').slice(0, 10);
    return t(a) === t(b) && !!t(a).replace('|', '') && day(a) === day(b);
}

// ---------------------------------------------------------------
// Player identities inside one tournament
// ---------------------------------------------------------------
// A "unit" is one player as this tournament knows him: every reference on
// the same team that shares a name key or an id (canonical, after earlier
// player merges) is the same unit.
function buildUnits(entries, role, ctx, pk) {
    const dsu = new DSU();
    const teamOf = (rec, side) => norm(rec['team' + side] && rec['team' + side].name) || `?${rec.matchId}:${side}`;
    const node = (tk, kind, v) => `${tk}\u0001${kind}\u0001${v}`;
    const work = [];
    for (const rec of entries) {
        const att = ctx.att.get(String(rec._id)) || { balls: [], clips: [] };
        const refs = recordRefs(rec, pk);
        att.balls.forEach(b => ballSlots(b).forEach(s => { const r = refOf(s.side, s.name, s.ids, 'ball', null, pk); if (r) refs.push(r); }));
        att.clips.forEach(c => clipSlots(c).forEach(s => { const r = refOf(s.side, s.name, s.ids, 'clip', null, pk); if (r) refs.push(r); }));
        for (const r of refs) {
            if (!r.side) continue;
            const tk = teamOf(rec, r.side);
            const nodes = [];
            if (r.key) nodes.push(node(tk, 'k', r.key));
            r.ids.forEach(id => nodes.push(node(tk, 'i', ctx.canon(id))));
            if (!nodes.length) continue;
            nodes.forEach(x => dsu.find(x));
            for (let i = 1; i < nodes.length; i++) dsu.union(nodes[0], nodes[i]);
            r._node = nodes[0];
            r._tk = tk;
        }
        work.push({ rec, refs });
    }
    const byRoot = new Map();
    for (const { rec, refs } of work) {
        const recId = String(rec._id);
        for (const r of refs) {
            if (!r._node) continue;
            const root = dsu.find(r._node);
            let u = byRoot.get(root);
            if (!u) {
                u = {
                    role, teamKey: r._tk, teamNames: new Map(), keys: new Set(), ids: new Set(), rawIds: new Set(),
                    recNames: new Map(), allNames: new Map(), idUse: new Map(), matches: new Set(), sidesByRec: new Map(),
                    bat: { inns: 0, runs: 0, balls: 0 }, bowl: { inns: 0, wickets: 0, runs: 0 }, hand: new Set(), roles: new Set()
                };
                byRoot.set(root, u);
            }
            if (r.key) u.keys.add(r.key);
            if (r.name) { bump(u.allNames, r.name); if (r.kind !== 'ball' && r.kind !== 'clip') bump(u.recNames, r.name); }
            r.ids.forEach(id => { u.rawIds.add(id); const c = ctx.canon(id); u.ids.add(c); bump(u.idUse, c, r.kind === 'ball' || r.kind === 'clip' ? 1 : 5); });
            u.matches.add(rec.matchId);
            if (!u.sidesByRec.has(recId)) u.sidesByRec.set(recId, new Set());
            u.sidesByRec.get(recId).add(r.side);
            bump(u.teamNames, rec['team' + r.side] && rec['team' + r.side].name);
            if (r.kind === 'bat') { u.bat.inns++; u.bat.runs += r.runs; u.bat.balls += r.balls; }
            if (r.kind === 'bowl') { u.bowl.inns++; u.bowl.wickets += r.wickets; u.bowl.runs += r.runs; }
            if (r.hand) u.hand.add(r.hand);
            if (r.captain) u.roles.add('captain');
            if (r.wk) u.roles.add('wk');
        }
    }
    const units = [];
    for (const u of byRoot.values()) {
        u.name = topOf(u.recNames.size ? u.recNames : u.allNames) || [...u.keys][0] || '';
        u.key = pk(u.name) || [...u.keys].sort()[0] || null;
        // the id to keep for this player: one with a profile, most used
        const ids = [...u.ids].sort((a, b) => ((ctx.profiles.has(b) ? 1 : 0) - (ctx.profiles.has(a) ? 1 : 0))
            || ((u.idUse.get(b) || 0) - (u.idUse.get(a) || 0)) || (a < b ? -1 : a > b ? 1 : 0));
        u.primaryId = ids[0] || null;
        u.teamName = topOf(u.teamNames) || '';
        u.uid = sha(`${role}|${u.teamKey}|${[...u.keys].sort()[0] || ('#' + [...u.ids].sort()[0])}`, 16);
        units.push(u);
    }
    units.sort((a, b) => (a.uid < b.uid ? -1 : 1));
    return units;
}

function unitPublic(u, ctx, usage, tournamentName) {
    const profileName = (id) => { const p = ctx.profiles.get(id); return p ? (p.displayName || null) : null; };
    return {
        name: u.name,
        names: [...u.allNames.keys()].sort(),
        team: u.teamName,
        tournament: tournamentName,
        primaryId: u.primaryId,
        ids: [...u.ids].sort().map(id => ({
            id, hasProfile: ctx.profiles.has(id), profileName: profileName(id),
            otherTournaments: (usage && usage[id] && usage[id].tournaments) || [],
            otherMatches: (usage && usage[id] && usage[id].matches) || 0
        })),
        matches: u.matches.size,
        batting: { innings: u.bat.inns, runs: u.bat.runs, balls: u.bat.balls },
        bowling: { innings: u.bowl.inns, wickets: u.bowl.wickets, runs: u.bowl.runs },
        hand: [...u.hand][0] || null,
        roles: [...u.roles].sort()
    };
}

// ---------------------------------------------------------------
// Teams
// ---------------------------------------------------------------
function teamCatalog(recs, info) {
    const cat = new Map();
    const add = (t, src) => {
        if (!t || !isStr(t.name)) return;
        const k = norm(t.name);
        let e = cat.get(k);
        if (!e) { e = { key: k, names: new Map(), shorts: new Map(), teamIds: new Set(), colors: new Map(), logos: new Map(), matches: 0, inInfo: false, info: null }; cat.set(k, e); }
        bump(e.names, t.name.trim());
        if (isStr(t.short)) bump(e.shorts, t.short.trim());
        if (isStr(t.teamId)) e.teamIds.add(t.teamId.trim());
        if (isStr(t.color)) bump(e.colors, t.color.trim());
        if (isStr(t.logoUrl)) bump(e.logos, t.logoUrl.trim());
        if (src === 'match') e.matches++;
        else { e.inInfo = true; if (!e.info) e.info = t; }
    };
    recs.forEach(r => SIDES.forEach(s => add(r['team' + s], 'match')));
    ((info && Array.isArray(info.teams)) ? info.teams : []).forEach(t => add(t, 'info'));
    for (const e of cat.values()) {
        e.name = topOf(e.names);
        e.short = topOf(e.shorts) || '';
        e.teamId = e.teamIds.size === 1 ? [...e.teamIds][0] : null;
        e.color = topOf(e.colors) || '';
        e.logoUrl = topOf(e.logos) || '';
    }
    return cat;
}

// ---------------------------------------------------------------
// The whole plan: what moves, what is renamed, what is checked.
// Pure — given the loaded data (ctx) and the user's decisions.
// ---------------------------------------------------------------
function planMerge(ctx, decisions, pk, opts) {
    decisions = decisions || {};
    opts = opts || {};
    const errors = [], warnings = [], blockers = [];
    const dec = (k) => (decisions[k] && typeof decisions[k] === 'object') ? decisions[k] : {};
    const sName = ctx.sDoc.displayName || ctx.sDoc.leagueKey, dName = ctx.dDoc.displayName || ctx.dDoc.leagueKey;

    // ---- matches: move, or an id clash with a destination match ----
    const dById = new Map(ctx.dRecs.map(r => [r.matchId, r]));
    const matchDec = dec('matches');
    const entries = [];          // source records, each with what happens to it
    const dReplaced = new Set(); // destination records replaced by a source copy
    const takenIds = new Set([...ctx.dRecs.map(r => r.matchId)]);
    for (const rec of ctx.sRecs) {
        const status = matchStatus(rec);
        const e = { recId: String(rec._id), matchId: rec.matchId, roomId: rec.roomId || null, status, action: 'move', newMatchId: null, destRecId: null, conflict: null };
        if (!isStr(rec.matchId)) {
            e.action = 'blocked';
            blockers.push({ code: 'MATCH_WITHOUT_ID', message: `A match in "${sName}" has no match id — it cannot be moved safely.` });
        } else if (dById.has(rec.matchId)) {
            const d = dById.get(rec.matchId);
            e.destRecId = String(d._id);
            if (sameMatch(rec, d)) {
                const differs = scoringFingerprint(rec) !== scoringFingerprint(d);
                e.conflict = differs ? { type: 'copy-differs', destBalls: ctx.footprint(d), sourceBalls: ctx.footprint(rec), destResult: d.winningTeam || null, sourceResult: rec.winningTeam || null } : null;
                const keep = (matchDec[rec.matchId] && matchDec[rec.matchId].keep) === 'source' ? 'source' : 'dest';
                if (differs && keep === 'source') { e.action = 'replace-dest'; dReplaced.add(String(d._id)); }
                else e.action = 'duplicate';
            } else {
                const ownRoom = isStr(rec.roomId) && rec.roomId !== rec.matchId && ctx.ownKeys.get(String(rec._id)).some(k => safeId(k) === safeId(rec.roomId));
                if (!ownRoom) {
                    e.action = 'blocked';
                    blockers.push({ code: 'MATCH_ID_CLASH', message: `Match "${ctx.title(rec)}" has the same id as a different match in "${dName}", and its ball log cannot be told apart — it cannot be merged safely.` });
                } else {
                    e.action = 'remap';
                    let nid = `${rec.matchId}-m${sha(ctx.sDoc.leagueKey + '|' + rec.matchId, 6)}`, i = 2;
                    while (takenIds.has(nid)) nid = `${rec.matchId}-m${sha(ctx.sDoc.leagueKey + '|' + rec.matchId + '|' + (i++), 6)}`;
                    e.newMatchId = nid;
                }
            }
        }
        takenIds.add(e.newMatchId || rec.matchId);
        entries.push(e);
    }
    const sMoving = ctx.sRecs.filter(r => { const e = entries.find(x => x.recId === String(r._id)); return e && (e.action === 'move' || e.action === 'remap' || e.action === 'replace-dest'); });
    const dKept = ctx.dRecs.filter(r => !dReplaced.has(String(r._id)));

    // ---- teams ----
    const dCat = teamCatalog(dKept, ctx.dDoc.info), sCat = teamCatalog(sMoving, null);
    const teamDec = dec('teams');
    const teamPairs = [];
    const teamAlias = new Map(); // source team key -> destination team key
    for (const [sk, s] of sCat) {
        if (dCat.has(sk)) {
            const d = dCat.get(sk);
            const idsDiffer = s.teamIds.size && d.teamIds.size && ![...s.teamIds].some(x => d.teamIds.has(x));
            teamPairs.push({ pairId: 't' + sha('same|' + sk, 12), type: 'same', sourceTeam: s.name, destTeam: d.name, sourceMatches: s.matches, destMatches: d.matches, idsDiffer: !!idsDiffer, requiresManual: false });
            teamAlias.set(sk, sk);
            if (idsDiffer) warnings.push({ code: 'TEAM_ID_DIFFERS', message: `"${d.name}" has a different saved-team id in each tournament — it is shown as one team (the points table goes by team name).` });
            continue;
        }
        let matched = false;
        for (const [dk, d] of dCat) {
            if (!similarTeams(sk, dk, s.short, d.short)) continue;
            matched = true;
            const pairId = 't' + sha(dk + '|' + sk, 12);
            const choice = teamDec[pairId];
            const same = choice && choice.same === true;
            teamPairs.push({ pairId, type: 'similar', sourceTeam: s.name, destTeam: d.name, sourceShort: s.short, destShort: d.short, sourceMatches: s.matches, destMatches: d.matches, requiresManual: true, decision: choice ? (same ? 'same' : 'different') : null });
            if (same) {
                if (teamAlias.has(sk) && teamAlias.get(sk) !== dk) errors.push({ code: 'TEAM_DOUBLE_MATCH', message: `"${s.name}" can only be the same team as one destination team.` });
                else teamAlias.set(sk, dk);
            }
        }
        if (!matched) teamPairs.push({ pairId: null, type: 'new', sourceTeam: s.name, sourceMatches: s.matches, requiresManual: false });
    }
    const teamRenames = new Map(); // source team key -> rename
    for (const [sk, dk] of teamAlias) {
        if (sk === dk) continue;
        const d = dCat.get(dk);
        teamRenames.set(sk, { name: d.name, short: d.short || null, teamId: d.teamId || null });
    }
    const sameTeam = (sk, dk) => (teamAlias.get(sk) || sk) === dk;

    // ---- players ----
    const dUnits = buildUnits(dKept, 'dest', ctx, pk);
    const sUnits = buildUnits(sMoving, 'source', ctx, pk);
    const byKey = new Map(), byId = new Map(), byTeam = new Map();
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    dUnits.forEach(d => { d.keys.forEach(k => push(byKey, k, d)); d.ids.forEach(i => push(byId, i, d)); push(byTeam, d.teamKey, d); });
    const candidates = [];
    const infos = [];
    for (const s of sUnits) {
        const seen = new Set();
        const look = (d, viaSimilar) => {
            if (seen.has(d.uid)) return;
            const teamSame = sameTeam(s.teamKey, d.teamKey);
            const shared = [...s.ids].filter(i => d.ids.has(i));
            const keyOverlap = [...s.keys].some(k => d.keys.has(k));
            const sameKeys = s.keys.size === d.keys.size && [...s.keys].every(k => d.keys.has(k));
            let type = null, reason = '';
            if (shared.length) {
                const extraIds = s.ids.size > shared.length || d.ids.size > shared.length;
                if (!sameKeys) { type = 'linked'; reason = 'Same player ID, spelled differently'; }
                else if (extraIds) { type = 'exact'; reason = 'Same player, more than one ID'; }
            } else if (keyOverlap) {
                if (s.ids.size && d.ids.size) {
                    if (teamSame) { type = 'exact'; reason = 'Same name, same team, different IDs'; }
                    else { type = 'ambiguous'; reason = 'Same name, different teams, different IDs'; }
                } else if (!teamSame) {
                    infos.push({ code: 'SAME_NAME_OTHER_TEAM', message: `"${s.name}" plays for ${s.teamName} in "${sName}" and "${d.name}" for ${d.teamName} in "${dName}" — leaderboards group players by name, so they share one row.` });
                }
            } else if (viaSimilar && teamSame) { type = 'similar'; reason = 'Similar name, same team'; }
            if (!type) return;
            seen.add(d.uid);
            candidates.push({ pairId: 'p' + sha(d.uid + '|' + s.uid, 15), type, reason, d, s, teamSame });
        };
        s.ids.forEach(i => (byId.get(i) || []).forEach(d => look(d, false)));
        s.keys.forEach(k => (byKey.get(k) || []).forEach(d => look(d, false)));
        const dk = teamAlias.get(s.teamKey) || s.teamKey;
        (byTeam.get(dk) || []).forEach(d => {
            if (seen.has(d.uid)) return;
            if ([...s.keys].some(a => [...d.keys].some(b => similarNames(a, b)))) look(d, true);
        });
    }
    candidates.sort((a, b) => (a.pairId < b.pairId ? -1 : 1));

    // decisions → which candidates are the same person, and whose id stays
    const pDec = dec('players');
    const unitLiveRecs = (u) => [...u.sidesByRec.keys()].filter(recId => ctx.liveRecIds.has(recId));
    const canonOf = (u, others) => {
        let id = u.primaryId || ctx.keyOwners.get(u.key) || null;
        if (!id) for (const o of others) if (o.primaryId) { id = o.primaryId; break; }
        return { id, name: u.name, key: u.key };
    };
    // can this side's id be the one that stays?
    const optionCheck = (keepU, otherU) => {
        const c = canonOf(keepU, [otherU]);
        if (keepU.role === 'source') {
            const liveRecs = unitLiveRecs(otherU);
            if (liveRecs.length) return { ok: false, reason: `"${otherU.name}" is in a destination match that is live right now — keep the destination ID, or merge after the match.` };
        }
        if (c.id && !ctx.profiles.has(c.id)) {
            const owner = ctx.keyOwners.get(c.key);
            const folding = new Set([...otherU.ids, ...keepU.ids]);
            if (owner && owner !== c.id && !folding.has(owner)) {
                return { ok: false, reason: `ID ${c.id} has no player profile, and the name "${c.name}" already belongs to profile ${owner} — keeping ${c.id} would make new duplicates. Keep the other ID instead.` };
            }
        }
        return { ok: true, id: c.id, name: c.name };
    };
    const decided = [];
    candidates.forEach(c => {
        const o = { dest: optionCheck(c.d, c.s), source: optionCheck(c.s, c.d) };
        c.options = o;
        c.requiresManual = c.type === 'ambiguous' || c.type === 'similar';
        c.recommended = c.requiresManual ? null : (o.dest.ok ? 'dest' : (o.source.ok ? 'source' : null));
        const d = pDec[c.pairId];
        c.decision = d ? (d.same === true ? ((d.keep === 'source') ? 'source' : 'dest') : 'different') : null;
        // preview only: a high-confidence pair counts as recommended until
        // the user says otherwise; a manual-review pair stays separate
        const effective = c.decision || (opts.strict ? null : (c.requiresManual ? 'different' : c.recommended));
        c.effective = effective;
        if (effective === 'dest' || effective === 'source') {
            if (!o[effective].ok) errors.push({ code: 'ID_NOT_RETAINABLE', pairId: c.pairId, message: o[effective].reason });
            else decided.push(c);
        }
    });

    // components: everything decided "same" collapses into one identity
    const dsu = new DSU();
    const unitsByUid = new Map([...dUnits, ...sUnits].map(u => [u.uid, u]));
    decided.forEach(c => dsu.union(c.d.uid, c.s.uid));
    const compKeep = new Map(); // root -> uid of the unit whose id/name stays
    decided.forEach(c => {
        const root = dsu.find(c.d.uid);
        const keepUid = c.effective === 'source' ? c.s.uid : c.d.uid;
        if (compKeep.has(root) && compKeep.get(root) !== keepUid) {
            errors.push({ code: 'CONFLICTING_CHOICES', pairId: c.pairId, message: `Conflicting ID choices for "${c.d.name}" / "${c.s.name}" — one player can keep only one ID.` });
        } else compKeep.set(root, keepUid);
    });
    const comps = new Map();
    decided.forEach(c => {
        const root = dsu.find(c.d.uid);
        if (!comps.has(root)) comps.set(root, new Set());
        comps.get(root).add(c.d.uid).add(c.s.uid);
    });
    // one source player cannot be "the same" as two different destination players
    for (const set of comps.values()) {
        const ds = [...set].map(u => unitsByUid.get(u)).filter(u => u.role === 'dest');
        const ss = [...set].map(u => unitsByUid.get(u)).filter(u => u.role === 'source');
        if (ds.length > 1 && ss.length >= 1) {
            errors.push({ code: 'SOURCE_TO_TWO_DEST', message: `"${ss[0].name}" is marked the same as ${ds.length} different destination players — pick one.` });
        }
    }
    // one id cannot end up kept under two different identities
    const idOwner = new Map();
    for (const [root, set] of comps) {
        [...set].forEach(uid => unitsByUid.get(uid).ids.forEach(id => {
            if (idOwner.has(id) && idOwner.get(id) !== root) errors.push({ code: 'ID_IN_TWO_PLAYERS', message: `Player ID ${id} is part of two different players in your choices — mark only one of them as the same player.` });
            idOwner.set(id, root);
        }));
    }
    const components = [];
    for (const [root, set] of comps) {
        const keepUid = compKeep.get(root);
        const units = [...set].map(u => unitsByUid.get(u));
        const keepU = unitsByUid.get(keepUid);
        const canon = canonOf(keepU, units.filter(u => u !== keepU));
        components.push({ root, canon, keep: keepU, units });
    }

    // ---- per-match rename maps ----
    const maps = new Map(); // recId -> working map
    const mapFor = (recId) => {
        let m = maps.get(recId);
        if (!m) { m = { canon: [], canonIdx: new Map(), ids: new Map(), A: new Map(), B: new Map(), names: { A: new Map(), B: new Map() } }; maps.set(recId, m); }
        return m;
    };
    const idxOf = (m, c) => {
        const k = stable(c);
        if (!m.canonIdx.has(k)) { m.canonIdx.set(k, m.canon.length); m.canon.push(c); }
        return m.canonIdx.get(k);
    };
    const dLiveSkipped = new Set();
    components.forEach(comp => {
        comp.units.forEach(u => {
            for (const [recId, sides] of u.sidesByRec) {
                // a live destination match is never rewritten (keep-dest only
                // tidies the destination's own spellings there — skip it)
                if (u.role === 'dest' && ctx.liveRecIds.has(recId)) { dLiveSkipped.add(recId); continue; }
                const m = mapFor(recId);
                const i = idxOf(m, comp.canon);
                u.rawIds.forEach(id => m.ids.set(id, i));
                u.ids.forEach(id => m.ids.set(id, i));
                sides.forEach(side => {
                    u.keys.forEach(k => m[side].set(k, i));
                    u.allNames.forEach((cnt, shown) => m.names[side].set(shown, i));
                });
            }
        });
    });
    // ids already linked by an earlier player merge (id → mergedInto) are
    // brought up to date on the matches that move
    const autoLinked = new Set();
    sMoving.forEach(rec => {
        const recId = String(rec._id);
        const att = ctx.att.get(recId) || { balls: [], clips: [] };
        const ids = new Set();
        recordRefs(rec, pk).forEach(r => r.ids.forEach(x => ids.add(x)));
        att.balls.forEach(b => ballSlots(b).forEach(s => s.ids.filter(isStr).forEach(x => ids.add(x))));
        att.clips.forEach(c => clipSlots(c).forEach(s => s.ids.filter(isStr).forEach(x => ids.add(x))));
        ids.forEach(raw => {
            const c = ctx.canon(raw);
            if (c === raw) return;
            const m = mapFor(recId);
            if (m.ids.has(raw)) return;
            m.ids.set(raw, idxOf(m, { id: c, name: null, key: null }));
            autoLinked.add(raw + '→' + c);
        });
    });
    const serialize = (m) => m ? {
        canon: m.canon, ids: [...m.ids.entries()], A: [...m.A.entries()], B: [...m.B.entries()],
        names: { A: [...m.names.A.entries()], B: [...m.names.B.entries()] }
    } : null;

    // ---- the plan entries + a projection of the merged tournament ----
    const recById = new Map([...ctx.sRecs, ...ctx.dRecs].map(r => [String(r._id), r]));
    const planEntries = [];
    const projected = [];
    const counts = { ballsToRewrite: 0, clipsToRewrite: 0, dismissalsToRewrite: 0, recordsToRewrite: 0, sharedRoomMatches: 0 };
    const sharedWithChanges = [], unfinishedWithChanges = [];
    const teamRenameFor = (rec) => {
        const tr = {};
        let any = false;
        SIDES.forEach(side => {
            const k = norm(rec['team' + side] && rec['team' + side].name);
            if (teamRenames.has(k)) { tr[side] = teamRenames.get(k); any = true; }
        });
        return any ? tr : null;
    };
    const countAtt = (recId, map) => {
        const att = ctx.att.get(recId) || { balls: [], clips: [] };
        let balls = 0, clips = 0, dism = 0;
        if (map) {
            att.balls.forEach(b => { const set = transformBall(b, map, pk); if (set) { balls++; if (b.dismissal) dism++; } });
            att.clips.forEach(c => { if (transformClip(c, map, pk)) clips++; });
        }
        return { balls, clips, dism, ballTotal: att.balls.length, clipTotal: att.clips.length };
    };
    for (const e of entries) {
        if (e.action === 'blocked' || e.action === 'duplicate') { planEntries.push(Object.assign({ role: 'source', map: null }, e)); continue; }
        const rec = recById.get(e.recId);
        const map = maps.has(e.recId) ? serialize(maps.get(e.recId)) : null;
        const tr = teamRenameFor(rec);
        const t = transformRecord(rec, map, tr, pk);
        const doc = t.doc;
        doc.leagueKey = ctx.dDoc.leagueKey;
        if (e.newMatchId) doc.matchId = e.newMatchId;
        projected.push(doc);
        const a = countAtt(e.recId, map);
        counts.ballsToRewrite += a.balls; counts.clipsToRewrite += a.clips; counts.dismissalsToRewrite += a.dism;
        if (t.changes) counts.recordsToRewrite++;
        const shared = !!(ctx.shared.get(e.recId));
        const identityChange = !!(map && (t.changes || a.balls || a.clips));
        if (shared) counts.sharedRoomMatches++;
        if (shared && map && map.canon.some(c => c.name)) sharedWithChanges.push(ctx.title(rec));
        if (identityChange && e.status === 'ongoing') unfinishedWithChanges.push(ctx.title(rec));
        planEntries.push(Object.assign({ role: 'source', map, teamRename: tr, ownKeys: ctx.ownKeys.get(e.recId) || [], clash: !!ctx.clash.get(e.recId), sharedRoom: shared, identityChange, ballsToRewrite: a.balls, clipsToRewrite: a.clips, ballTotal: a.ballTotal, clipTotal: a.clipTotal }, e));
    }
    const destEntries = [];
    for (const rec of dKept) {
        const recId = String(rec._id);
        const map = maps.has(recId) ? serialize(maps.get(recId)) : null;
        if (!map) { projected.push(rec); continue; }
        const t = transformRecord(rec, map, null, pk);
        const a = countAtt(recId, map);
        if (!t.changes && !a.balls && !a.clips) { projected.push(rec); continue; }
        projected.push(t.doc);
        counts.ballsToRewrite += a.balls; counts.clipsToRewrite += a.clips; counts.dismissalsToRewrite += a.dism;
        if (t.changes) counts.recordsToRewrite++;
        const shared = !!(ctx.shared.get(recId));
        if (shared && map.canon.some(c => c.name)) sharedWithChanges.push(ctx.title(rec));
        destEntries.push({ role: 'dest', recId, matchId: rec.matchId, status: matchStatus(rec), action: 'rewrite', map, teamRename: null, ownKeys: ctx.ownKeys.get(recId) || [], clash: !!ctx.clash.get(recId), sharedRoom: shared, identityChange: true, ballsToRewrite: a.balls, clipsToRewrite: a.clips, ballTotal: a.ballTotal, clipTotal: a.clipTotal });
    }

    // ---- profiles to link ----
    const profiles = [];
    components.forEach(comp => {
        const into = comp.canon.id;
        if (!into) return;
        const fromIds = new Set();
        comp.units.forEach(u => u.ids.forEach(id => { if (id !== into && ctx.profiles.has(id) && !ctx.profiles.get(id).mergedInto) fromIds.add(id); }));
        const owner = ctx.keyOwners.get(comp.canon.key);
        const addKey = !!comp.canon.key && (!owner || owner === into || fromIds.has(owner));
        const create = !ctx.profiles.has(into);
        if (!fromIds.size && !create && !addKey) return;
        if (!fromIds.size && !create && addKey && ctx.profiles.get(into) && (ctx.profiles.get(into).nameKeys || []).includes(comp.canon.key)) return;
        profiles.push({ intoId: into, intoName: comp.canon.name, intoKey: addKey ? comp.canon.key : null, fromIds: [...fromIds].sort(), create });
    });

    // ---- teams the destination list gains ----
    const teamsAppend = [];
    const dInfoTeams = ctx.dDoc.info && Array.isArray(ctx.dDoc.info.teams) ? ctx.dDoc.info.teams : null;
    const sInfoTeams = new Map(((ctx.sDoc.info && Array.isArray(ctx.sDoc.info.teams)) ? ctx.sDoc.info.teams : []).map(t => [norm(t && t.name), t]));
    if (dInfoTeams && dInfoTeams.length) {
        const have = new Set(dInfoTeams.map(t => norm(t && t.name)));
        for (const [sk, s] of sCat) {
            if (teamAlias.has(sk) || have.has(sk)) continue;
            const fromInfo = sInfoTeams.get(sk);
            const logo = (fromInfo && fromInfo.logoUrl) || s.logoUrl || '';
            const okLogo = /^https:\/\/[^\s"'<>]+$/i.test(logo) && logo.length <= 600 ? logo
                : (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(logo) && logo.length <= 40000 ? logo : '');
            const color = (fromInfo && fromInfo.color) || s.color || '';
            teamsAppend.push({
                name: String((fromInfo && fromInfo.name) || s.name).slice(0, 60),
                short: String((fromInfo && fromInfo.short) || s.short || '').slice(0, 8).toUpperCase(),
                color: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : '',
                teamId: (fromInfo && fromInfo.teamId) || s.teamId || null,
                logoUrl: okLogo
            });
            have.add(sk);
        }
        while (dInfoTeams.length + teamsAppend.length > 40) teamsAppend.pop();
    }

    // ---- blockers & warnings ----
    if (ctx.sLive.length) blockers.push({ code: 'SOURCE_LIVE', message: `"${sName}" has a match being scored live right now — finish or stop it, then merge.` });
    if (ctx.sDoc.ownerUid !== ctx.dDoc.ownerUid) blockers.push({ code: 'DIFFERENT_ACCOUNTS', message: 'These tournaments belong to different accounts — only tournaments of the same account can be merged (player IDs and teams are per account).' });
    const sPriv = !!ctx.sPrivate, dPriv = !!ctx.dPrivate;
    if (sPriv && !dPriv) warnings.push({ code: 'BECOMES_PUBLIC', ack: true, message: `"${sName}" is private and "${dName}" is public — its ${sMoving.length} match${sMoving.length === 1 ? '' : 'es'} will be visible to everyone as part of "${dName}".` });
    if (!sPriv && dPriv) warnings.push({ code: 'BECOMES_PRIVATE', ack: true, message: `"${sName}" is public and "${dName}" is private — its matches will no longer be public.` });
    if (unfinishedWithChanges.length) warnings.push({ code: 'UNFINISHED_RENAMED', ack: true, message: `${unfinishedWithChanges.length} unfinished match${unfinishedWithChanges.length === 1 ? '' : 'es'} (${unfinishedWithChanges.slice(0, 3).join(', ')}${unfinishedWithChanges.length > 3 ? '…' : ''}) change player IDs. If a scoring laptop still has one open, reload its panel and resume the match from "${dName}" before scoring again.` });
    if (sharedWithChanges.length) warnings.push({ code: 'SHARED_ROOM', ack: true, message: `${sharedWithChanges.length} match${sharedWithChanges.length === 1 ? '' : 'es'} (${sharedWithChanges.slice(0, 3).join(', ')}${sharedWithChanges.length > 3 ? '…' : ''}) were scored in a room that also holds other matches — their scorecards are updated, but their ball-by-ball log and clips keep the old player names.` });
    const fmt = (doc) => doc.info ? [doc.info.format || '', doc.info.overs || ''].join('/') : '';
    if (fmt(ctx.sDoc) && fmt(ctx.dDoc) && fmt(ctx.sDoc) !== fmt(ctx.dDoc)) {
        warnings.push({ code: 'FORMAT_DIFFERS', message: `"${sName}" is ${ctx.sDoc.info.format}${ctx.sDoc.info.overs ? ' (' + ctx.sDoc.info.overs + ' overs)' : ''} and "${dName}" is ${ctx.dDoc.info.format}${ctx.dDoc.info.overs ? ' (' + ctx.dDoc.info.overs + ' overs)' : ''} — the points table's net run rate will mix both.` });
    }
    const upcoming = entries.filter(e => e.status === 'upcoming' && (e.action === 'move' || e.action === 'remap')).length;
    if (upcoming) warnings.push({ code: 'UPCOMING_MOVED', message: `${upcoming} scheduled fixture${upcoming === 1 ? '' : 's'} move to "${dName}" — start ${upcoming === 1 ? 'it' : 'them'} from "${dName}" in the scoring panel.` });
    if (ctx.dLive.length) warnings.push({ code: 'DEST_LIVE', message: `"${dName}" has a match live right now. It keeps scoring normally; the merge does not change it.` });
    if (dLiveSkipped.size) warnings.push({ code: 'DEST_LIVE_SKIPPED', message: `${dLiveSkipped.size} live destination match${dLiveSkipped.size === 1 ? '' : 'es'} keep their player spellings until they finish.` });
    [...new Map(infos.map(w => [w.message, w])).values()].slice(0, 20).forEach(w => warnings.push(w));
    if (ctx.unscopedBalls) warnings.push({ code: 'UNSCOPED_BALLS', message: `${ctx.unscopedBalls} logged deliveries have no batting team recorded; only their player IDs (not names) can be updated.` });
    if (!ctx.sRecs.length) warnings.push({ code: 'SOURCE_EMPTY', message: `"${sName}" has no matches — merging just removes it.` });

    // strict (execute): every pair answered, every warning acknowledged
    if (opts.strict) {
        candidates.forEach(c => {
            if (!c.decision) errors.push({ code: c.requiresManual ? 'NEEDS_REVIEW' : 'NOT_CONFIRMED', pairId: c.pairId, message: c.requiresManual
                ? `Review "${c.d.name}" (${dName}) and "${c.s.name}" (${sName}) — same player or different players?`
                : `Confirm the player ID to keep for "${c.d.name}".` });
        });
        teamPairs.filter(t => t.requiresManual && !t.decision).forEach(t => errors.push({ code: 'TEAM_NEEDS_REVIEW', pairId: t.pairId, message: `Review teams "${t.destTeam}" and "${t.sourceTeam}" — same team or different?` }));
        const acks = new Set(Array.isArray(decisions.acknowledged) ? decisions.acknowledged : []);
        warnings.filter(w => w.ack && !acks.has(w.code)).forEach(w => errors.push({ code: 'NOT_ACKNOWLEDGED', warning: w.code, message: 'Please confirm: ' + w.message }));
    }

    return {
        entries: planEntries, destEntries, profiles, teamsAppend, teamPairs, candidates, components,
        projected, counts, errors, warnings, blockers, autoLinked: [...autoLinked],
        dUnits, sUnits, sMoving, dKept, sCat, dCat
    };
}

// ================================================================
// The engine bound to the database
// ================================================================
function createTournamentMerge(deps) {
    const db = deps.db;
    const pk = deps.playerKey;
    const now = deps.now || (() => Date.now());
    const log = deps.log || (() => {});
    const SINGLE = deps.singleMatchesLeagueKey || '__single_matches__';
    const newOpId = deps.newOpId || (() => 'tm_' + crypto.randomBytes(8).toString('hex'));
    const ownerEmail = norm(deps.ownerEmail || 'chhayajeeth@gmail.com');

    // ---- locks: one merge per tournament at a time ----
    // In memory for the request hot paths (save / live-status ask "is this
    // tournament being merged?"), in Mongo so a restart keeps them.
    const activeLocks = new Map();   // `${ownerUid}::${leagueKey}` -> { opId, role, matchIds: Set }
    const mergedAway = new Map();    // `${ownerUid}::${leagueKey}` -> { destLeagueKey, opId }
    const lockKey = (ownerUid, leagueKey) => `${ownerUid}::${leagueKey}`;

    async function loadState() {
        activeLocks.clear();
        mergedAway.clear();
        const locks = await db.locks.find({}).toArray();
        locks.forEach(l => activeLocks.set(l._id, { opId: l.opId, role: l.role, matchIds: new Set(l.matchIds || []) }));
        const done = await db.merges.find({ status: 'completed' }).toArray();
        for (const op of done) {
            const still = await db.leagues.findOne({ ownerUid: op.ownerUid, leagueKey: op.source.leagueKey });
            if (!still) mergedAway.set(lockKey(op.ownerUid, op.source.leagueKey), { destLeagueKey: op.dest.leagueKey, opId: op._id });
        }
    }
    function lockFor(ownerUid, leagueKey) {
        return activeLocks.get(lockKey(ownerUid, leagueKey)) || null;
    }
    async function acquireLocks(opId, ownerUid, sKey, dKey, destMatchIds) {
        const want = [
            { _id: lockKey(ownerUid, sKey), opId, role: 'source', matchIds: [], createdAt: now() },
            { _id: lockKey(ownerUid, dKey), opId, role: 'dest', matchIds: destMatchIds || [], createdAt: now() }
        ];
        const got = [];
        for (const l of want) {
            try {
                await db.locks.insertOne(l);
                got.push(l);
            } catch (err) {
                const cur = await db.locks.findOne({ _id: l._id });
                if (cur && cur.opId === opId) { got.push(l); continue; }
                for (const g of got) await db.locks.deleteOne({ _id: g._id, opId });
                got.forEach(g => activeLocks.delete(g._id));
                const e = new Error('Another merge is running on one of these tournaments.');
                e.code = 'LOCKED';
                e.opId = cur ? cur.opId : null;
                throw e;
            }
        }
        want.forEach(l => activeLocks.set(l._id, { opId, role: l.role, matchIds: new Set(l.matchIds) }));
    }
    async function setDestLockMatches(opId, ownerUid, dKey, matchIds) {
        await db.locks.updateOne({ _id: lockKey(ownerUid, dKey), opId }, { $set: { matchIds } });
        const cur = activeLocks.get(lockKey(ownerUid, dKey));
        if (cur && cur.opId === opId) cur.matchIds = new Set(matchIds);
    }
    async function releaseLocks(opId) {
        const mine = await db.locks.find({ opId }).toArray();
        await db.locks.deleteMany({ opId });
        mine.forEach(l => activeLocks.delete(l._id));
        for (const [k, v] of activeLocks) if (v.opId === opId) activeLocks.delete(k);
    }

    // ---- who may act on which tournaments ----
    // chhayajeeth@gmail.com (the owner, who already manages every creator's
    // tournaments in the admin portal) sees every authorized creator's;
    // workallsportslive@gmail.com sees its own. Same boundaries as before —
    // the merge grants no access to anything the account could not reach.
    async function scopeFor(viewer) {
        if (!viewer || !isMergeAdminEmail(viewer.email) || !isStr(viewer.uid)) return null;
        const uids = new Set([viewer.uid]);
        const isOwner = norm(viewer.email) === ownerEmail;
        if (isOwner) {
            for (const e of (deps.authorizedCreatorEmails || [])) {
                try { const u = await deps.getUidForEmail(e); if (u) uids.add(u); } catch (err) { /* account not created yet */ }
            }
        }
        return { uids, isOwner };
    }
    function httpError(status, message, extra) {
        const e = new Error(message);
        e.status = status;
        Object.assign(e, extra || {});
        return e;
    }
    const refOfBody = (v) => {
        if (!v || typeof v !== 'object') return null;
        const ownerUid = String(v.ownerUid || '').trim();
        const leagueKey = norm(v.leagueKey);
        return ownerUid && leagueKey ? { ownerUid, leagueKey } : null;
    };
    async function loadLeague(scope, ref, label) {
        if (!ref) throw httpError(400, `Pick the ${label} tournament`);
        if (!scope.uids.has(ref.ownerUid)) throw httpError(403, 'Access Denied');
        if (ref.leagueKey === SINGLE) throw httpError(400, 'Single matches are not a tournament');
        const doc = await db.leagues.findOne({ ownerUid: ref.ownerUid, leagueKey: ref.leagueKey });
        if (!doc) throw httpError(404, `The ${label} tournament was not found`);
        return doc;
    }
    async function creatorEmailOf(doc) {
        if (doc.createdBy) return doc.createdBy;
        try { return await deps.getVerifiedEmailForUid(doc.ownerUid); } catch (e) { return null; }
    }
    async function isPrivate(doc) {
        return !!deps.effectiveIsPrivate(doc, await creatorEmailOf(doc));
    }
    const sportOf = (doc) => doc.sport || (deps.detectSportFromName ? deps.detectSportFromName(doc.displayName || doc.leagueKey) : 'cricket');
    const tournamentId = (doc) => doc.publicToken || doc.leagueKey;
    const isLiveRec = (rec) => rec && !rec.winningTeam && rec.upcoming !== true;

    function liveMatchIdsOf(doc, recs) {
        const byId = new Map(recs.map(r => [r.matchId, r]));
        const byRoom = new Map(recs.filter(r => r.roomId).map(r => [r.roomId, r]));
        return (doc.liveMatches || []).filter(lm => {
            const rec = (lm.matchId && byId.get(lm.matchId)) || (lm.roomId && byRoom.get(lm.roomId)) || null;
            return !rec || isLiveRec(rec);
        }).map(lm => lm.matchId || lm.roomId).filter(Boolean);
    }

    async function statusOf(doc, played) {
        const live = liveMatchIdsOf(doc, []).length > 0;
        return doc.statusOverride || (live ? 'live' : (doc.completed ? 'completed' : (played > 0 ? 'ongoing' : 'upcoming')));
    }

    async function listTournaments(viewer) {
        const scope = await scopeFor(viewer);
        if (!scope) throw httpError(403, 'Access Denied');
        const docs = await db.leagues.find({ ownerUid: { $in: [...scope.uids] }, leagueKey: { $ne: SINGLE } }).toArray();
        const out = [];
        for (const doc of docs) {
            if (sportOf(doc) !== 'cricket') continue;
            const played = await db.records.countDocuments({ ownerUid: doc.ownerUid, leagueKey: doc.leagueKey, upcoming: { $ne: true } });
            const upcoming = await db.records.countDocuments({ ownerUid: doc.ownerUid, leagueKey: doc.leagueKey, upcoming: true });
            const priv = await isPrivate(doc);
            out.push({
                ownerUid: doc.ownerUid, leagueKey: doc.leagueKey, id: tournamentId(doc), name: doc.displayName || doc.leagueKey,
                sport: 'cricket', format: (doc.info && doc.info.format) || null, overs: (doc.info && doc.info.overs) || null,
                status: await statusOf(doc, played), visibility: priv ? 'private' : 'public',
                matches: played, upcoming, live: (doc.liveMatches || []).length > 0,
                createdBy: scope.isOwner ? (await creatorEmailOf(doc)) || null : undefined,
                lock: lockFor(doc.ownerUid, doc.leagueKey) ? lockFor(doc.ownerUid, doc.leagueKey).opId : null,
                updatedAt: doc.updatedAt || 0
            });
        }
        out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return out;
    }

    // Counts + leaders for one tournament card (step 1).
    async function tournamentSummary(viewer, ref) {
        const scope = await scopeFor(viewer);
        if (!scope) throw httpError(403, 'Access Denied');
        const doc = await loadLeague(scope, refOfBody(ref), 'selected');
        const recs = await db.records.find({ ownerUid: doc.ownerUid, leagueKey: doc.leagueKey }).toArray();
        const played = deps.playedMatches(recs);
        const teams = new Set(), players = new Set();
        recs.forEach(r => {
            SIDES.forEach(s => { const k = norm(r['team' + s] && r['team' + s].name); if (k) teams.add(k); });
            recordRefs(r, pk).forEach(x => { if (x.key && x.kind !== 'howOut' && x.kind !== 'partnership') players.add(x.key); });
        });
        const table = deps.computePointsTable(recs);
        const lb = deps.computeLeaderboards(recs);
        const priv = await isPrivate(doc);
        return {
            ownerUid: doc.ownerUid, leagueKey: doc.leagueKey, id: tournamentId(doc), name: doc.displayName || doc.leagueKey,
            sport: sportOf(doc), format: (doc.info && doc.info.format) || null, overs: (doc.info && doc.info.overs) || null,
            status: await statusOf(doc, played.length), visibility: priv ? 'private' : 'public',
            matches: played.length, upcoming: recs.length - played.length, teams: teams.size, players: players.size,
            live: liveMatchIdsOf(doc, recs).length,
            pointsLeader: table[0] ? { team: table[0].team, points: table[0].points, played: table[0].played, nrr: table[0].nrr } : null,
            topRunScorer: lb.topRuns[0] ? { name: lb.topRuns[0].name, runs: lb.topRuns[0].runs } : null,
            topWicketTaker: lb.topWickets[0] ? { name: lb.topWickets[0].name, wickets: lb.topWickets[0].wickets } : null,
            lock: lockFor(doc.ownerUid, doc.leagueKey) ? lockFor(doc.ownerUid, doc.leagueKey).opId : null
        };
    }

    // ---- loading everything a merge looks at ----
    async function loadContext(sDoc, dDoc) {
        const ownerUid = dDoc.ownerUid;
        const byMatchId = (a, b) => String(a.savedAt || '').localeCompare(String(b.savedAt || '')) || String(a.matchId).localeCompare(String(b.matchId));
        const [sRecs, dRecs] = await Promise.all([
            db.records.find({ ownerUid: sDoc.ownerUid, leagueKey: sDoc.leagueKey }).toArray(),
            db.records.find({ ownerUid: dDoc.ownerUid, leagueKey: dDoc.leagueKey }).toArray()
        ]);
        sRecs.sort(byMatchId); dRecs.sort(byMatchId);
        const all = [...sRecs, ...dRecs];
        const keysOf = (r) => [...new Set([r.roomId, r.matchId].filter(isStr).flatMap(x => [x, safeId(x)]).filter(Boolean))];
        const allKeys = [...new Set(all.flatMap(keysOf))];
        // which room ids are used by more than one match (anywhere, any account)
        const users = new Map();
        const ident = (r) => `${r.matchId}|${r.roomId || ''}`;
        if (allKeys.length) {
            const others = await db.records.find({ $or: [{ roomId: { $in: allKeys } }, { matchId: { $in: allKeys } }] }, { projection: { matchId: 1, roomId: 1 } }).toArray();
            [...others, ...all].forEach(o => keysOf(o).forEach(k => { if (!users.has(k)) users.set(k, new Set()); users.get(k).add(ident(o)); }));
        }
        const balls = allKeys.length ? await db.balls.find({ matchId: { $in: allKeys } }).toArray() : [];
        const matchIds = all.map(r => r.matchId).filter(isStr);
        const clips = (allKeys.length || matchIds.length) ? await db.clips.find({ $or: [{ matchId: { $in: allKeys } }, { tournamentMatchId: { $in: matchIds } }] }).toArray() : [];
        // a match id two DIFFERENT saved matches share (an id clash)
        const identsById = new Map();
        all.forEach(r => { if (!identsById.has(r.matchId)) identsById.set(r.matchId, new Set()); identsById.get(r.matchId).add(ident(r)); });
        const att = new Map(), ownKeys = new Map(), shared = new Map(), clash = new Map();
        let unscopedBalls = 0;
        for (const r of all) {
            const id = String(r._id);
            const keys = keysOf(r);
            const own = keys.filter(k => { const s = users.get(k); return !s || (s.size === 1 && s.has(ident(r))); });
            const ownSet = new Set(own);
            const sharedKeys = keys.filter(k => !ownSet.has(k));
            const rule = { matchId: r.matchId, ownKeys: own, clash: (identsById.get(r.matchId) || new Set()).size > 1 };
            const rb = balls.filter(b => ownSet.has(b.matchId));
            const rc = clips.filter(c => clipBelongs(rule, c));
            att.set(id, { balls: rb, clips: rc });
            ownKeys.set(id, own);
            clash.set(id, rule.clash);
            shared.set(id, sharedKeys.length > 0 && balls.some(b => sharedKeys.includes(b.matchId)));
            unscopedBalls += rb.filter(b => !sideOf(b.battingTeam)).length;
        }
        // player profiles — every id the two tournaments use, plus where any
        // earlier merge sent it (mergedInto, up to 5 hops)
        const rawIds = new Set();
        const keys = new Set();
        all.forEach(r => {
            recordRefs(r, pk).forEach(x => { x.ids.forEach(i => rawIds.add(i)); if (x.key) keys.add(x.key); });
            const a = att.get(String(r._id));
            a.balls.forEach(b => ballSlots(b).forEach(s => { s.ids.filter(isStr).forEach(i => rawIds.add(i)); if (isStr(s.name)) keys.add(pk(s.name)); }));
            a.clips.forEach(c => clipSlots(c).forEach(s => { s.ids.filter(isStr).forEach(i => rawIds.add(i)); if (isStr(s.name)) keys.add(pk(s.name)); }));
        });
        const profiles = new Map();
        let frontier = [...rawIds];
        for (let hop = 0; hop < 6 && frontier.length; hop++) {
            const docs = await db.players.find({ ownerUid, playerId: { $in: frontier } }).toArray();
            docs.forEach(d => profiles.set(d.playerId, d));
            frontier = docs.map(d => d.mergedInto).filter(t => isStr(t) && !profiles.has(t));
        }
        const canon = (id) => {
            let x = id;
            for (let i = 0; i < 6; i++) {
                const p = profiles.get(x);
                if (!p || !isStr(p.mergedInto) || p.mergedInto === x) return x;
                x = p.mergedInto;
            }
            return x;
        };
        const keyOwners = new Map();
        const keyList = [...keys].filter(Boolean);
        if (keyList.length) {
            const owners = await db.players.find({ ownerUid, nameKeys: { $in: keyList } }).toArray();
            owners.forEach(p => { (p.nameKeys || []).forEach(k => keyOwners.set(k, p.playerId)); if (!profiles.has(p.playerId)) profiles.set(p.playerId, p); });
        }
        const sLive = liveMatchIdsOf(sDoc, sRecs);
        const dLive = liveMatchIdsOf(dDoc, dRecs);
        const liveRecIds = new Set(dRecs.filter(r => dLive.includes(r.matchId) || dLive.includes(r.roomId)).map(r => String(r._id)));
        const [sPrivate, dPrivate] = await Promise.all([isPrivate(sDoc), isPrivate(dDoc)]);
        const title = (r) => {
            const t = [r.teamA && r.teamA.name, r.teamB && r.teamB.name].filter(Boolean).join(' vs ');
            return (r.matchTitle ? r.matchTitle + ' · ' : (r.matchNo ? 'Match ' + r.matchNo + ' · ' : '')) + (t || r.matchId);
        };
        return {
            ownerUid, sDoc, dDoc, sRecs, dRecs, att, ownKeys, shared, clash, unscopedBalls, profiles, canon, keyOwners,
            sLive, dLive, liveRecIds, sPrivate, dPrivate, title,
            footprint: deps.footprintTotalBalls || (() => 0)
        };
    }

    // Fingerprint of everything the user approved: the whole source, the
    // destination's settings and its list of matches. A live destination
    // match scoring meanwhile does not change it; anything else does.
    function fingerprintOf(ctx) {
        const pick = (doc, live) => {
            const o = {};
            ['ownerUid', 'leagueKey', 'displayName', 'publicToken', 'info', 'statusOverride', 'visibilityOverride', 'completed', 'sport', 'createdBy']
                .forEach(k => { o[k] = doc[k] === undefined ? null : doc[k]; });
            if (live) o.liveMatches = doc.liveMatches || [];
            return o;
        };
        const sAtt = ctx.sRecs.map(r => { const a = ctx.att.get(String(r._id)); return [r.matchId, a.balls.length, a.clips.length]; });
        return sha(stable({
            s: pick(ctx.sDoc, true), d: pick(ctx.dDoc, false),
            sr: ctx.sRecs.map(r => { const x = Object.assign({}, r); delete x._id; return x; }), sa: sAtt,
            dr: ctx.dRecs.map(r => r.matchId).sort()
        }), 32);
    }

    async function usageElsewhere(ctx, ids) {
        const usage = {};
        if (!ids.length) return usage;
        const or = [];
        ['squadA.players.id', 'squadB.players.id', 'battingCard.A.id', 'battingCard.B.id', 'bowlingCard.A.id', 'bowlingCard.B.id']
            .forEach(f => or.push({ [f]: { $in: ids } }));
        const docs = await db.records.find({ ownerUid: ctx.ownerUid, leagueKey: { $nin: [ctx.sDoc.leagueKey, ctx.dDoc.leagueKey] }, $or: or }).toArray();
        const leagueNames = new Map();
        for (const d of docs) {
            const found = new Set();
            recordRefs(d, pk).forEach(r => r.ids.forEach(i => { if (ids.includes(i)) found.add(i); }));
            for (const i of found) {
                if (!usage[i]) usage[i] = { tournaments: new Set(), matches: 0 };
                usage[i].matches++;
                if (!leagueNames.has(d.leagueKey)) {
                    const lg = d.leagueKey === SINGLE ? null : await db.leagues.findOne({ ownerUid: ctx.ownerUid, leagueKey: d.leagueKey });
                    leagueNames.set(d.leagueKey, d.leagueKey === SINGLE ? 'Single matches' : ((lg && lg.displayName) || d.leagueKey));
                }
                usage[i].tournaments.add(leagueNames.get(d.leagueKey));
            }
        }
        Object.keys(usage).forEach(i => { usage[i].tournaments = [...usage[i].tournaments].sort(); });
        return usage;
    }

    // What the analysis screen shows (and execute re-checks).
    async function analysisFor(scope, body, strict) {
        const sRef = refOfBody(body && body.source), dRef = refOfBody(body && body.dest);
        const sDoc = await loadLeague(scope, sRef, 'source');
        const dDoc = await loadLeague(scope, dRef, 'destination');
        const pre = [];
        if (sDoc.ownerUid === dDoc.ownerUid && sDoc.leagueKey === dDoc.leagueKey) pre.push({ code: 'SAME_TOURNAMENT', message: 'Pick two different tournaments.' });
        if (sportOf(sDoc) !== 'cricket' || sportOf(dDoc) !== 'cricket') pre.push({ code: 'NOT_CRICKET', message: 'Only cricket tournaments can be merged.' });
        if (sDoc.ownerUid !== dDoc.ownerUid) pre.push({ code: 'DIFFERENT_ACCOUNTS', message: 'These tournaments belong to different accounts — only tournaments of the same account can be merged (player IDs and teams are per account).' });
        for (const [doc, label] of [[sDoc, 'source'], [dDoc, 'destination']]) {
            const l = lockFor(doc.ownerUid, doc.leagueKey);
            if (l) pre.push({ code: 'MERGE_RUNNING', opId: l.opId, message: `A merge is already running on the ${label} tournament.` });
        }
        if (pre.some(p => p.code === 'SAME_TOURNAMENT' || p.code === 'DIFFERENT_ACCOUNTS' || p.code === 'NOT_CRICKET')) {
            return { sDoc, dDoc, ctx: null, plan: null, preBlockers: pre };
        }
        const ctx = await loadContext(sDoc, dDoc);
        const decisions = (body && body.decisions) || {};
        const plan = planMerge(ctx, decisions, pk, { strict });
        plan.blockers = pre.concat(plan.blockers.filter(b => !pre.some(p => p.code === b.code)));
        return { sDoc, dDoc, ctx, plan, preBlockers: pre };
    }

    function settingsOf(doc, priv) {
        const info = doc.info || {};
        return {
            name: doc.displayName || doc.leagueKey, id: tournamentId(doc), visibility: priv ? 'private' : 'public',
            status: doc.statusOverride || null, completed: !!doc.completed,
            format: info.format || null, overs: info.overs || null, season: info.season || null,
            startDate: info.startDate || null, endDate: info.endDate || null, venue: info.venue || null,
            organizer: info.organizer || null, teamsListed: Array.isArray(info.teams) ? info.teams.length : 0
        };
    }
    const tableRows = (t) => (t || []).map(r => ({ team: r.team, played: r.played, won: r.won, lost: r.lost, tied: r.tied, noResult: r.noResult, points: r.points, nrr: r.nrr }));
    const lbRows = (lb) => ({
        topRuns: (lb.topRuns || []).slice(0, 10).map(r => ({ name: r.name, innings: r.innings, runs: r.runs, highScore: r.highScore, strikeRate: r.strikeRate })),
        topWickets: (lb.topWickets || []).slice(0, 10).map(r => ({ name: r.name, innings: r.innings, wickets: r.wickets, overs: r.overs, economy: r.economy, bestFigures: r.bestFigures }))
    });
    const distinctPlayers = (recs) => {
        const s = new Set();
        recs.forEach(r => recordRefs(r, pk).forEach(x => { if (x.key && x.kind !== 'howOut' && x.kind !== 'partnership') s.add(x.key); }));
        return s.size;
    };
    const distinctTeams = (recs) => {
        const s = new Set();
        recs.forEach(r => SIDES.forEach(side => { const k = norm(r['team' + side] && r['team' + side].name); if (k) s.add(k); }));
        return s.size;
    };

    function candidateView(c, ctx, usage) {
        const sName = ctx.sDoc.displayName || ctx.sDoc.leagueKey, dName = ctx.dDoc.displayName || ctx.dDoc.leagueKey;
        return {
            pairId: c.pairId, type: c.type, reason: c.reason, teamSame: c.teamSame,
            requiresManual: c.requiresManual, recommended: c.recommended, decision: c.decision,
            dest: unitPublic(c.d, ctx, usage, dName),
            source: unitPublic(c.s, ctx, usage, sName),
            options: {
                dest: { ok: c.options.dest.ok, id: c.options.dest.id || null, name: c.options.dest.name || null, reason: c.options.dest.reason || null },
                source: { ok: c.options.source.ok, id: c.options.source.id || null, name: c.options.source.name || null, reason: c.options.source.reason || null }
            }
        };
    }

    async function analyze(viewer, body) {
        const scope = await scopeFor(viewer);
        if (!scope) throw httpError(403, 'Access Denied');
        const a = await analysisFor(scope, body, false);
        const sPriv = await isPrivate(a.sDoc), dPriv = await isPrivate(a.dDoc);
        const base = {
            source: settingsOf(a.sDoc, sPriv), dest: settingsOf(a.dDoc, dPriv),
            sourceRef: { ownerUid: a.sDoc.ownerUid, leagueKey: a.sDoc.leagueKey },
            destRef: { ownerUid: a.dDoc.ownerUid, leagueKey: a.dDoc.leagueKey }
        };
        if (!a.ctx) return Object.assign(base, { ok: false, blockers: a.preBlockers, warnings: [] });
        const { ctx, plan } = a;
        const ids = [...new Set(plan.candidates.flatMap(c => [...c.d.ids, ...c.s.ids]))];
        const usage = await usageElsewhere(ctx, ids);
        const sTitle = (e) => { const r = ctx.sRecs.find(x => String(x._id) === e.recId); return r ? ctx.title(r) : e.matchId; };
        const rec = (e) => ctx.sRecs.find(x => String(x._id) === e.recId);
        const matches = plan.entries.map(e => {
            const r = rec(e);
            return {
                matchId: e.matchId, newMatchId: e.newMatchId || null, title: sTitle(e), status: e.status, action: e.action,
                teams: [r.teamA && r.teamA.name, r.teamB && r.teamB.name], date: r.matchDate || (r.savedAt ? String(r.savedAt).slice(0, 10) : null),
                result: r.resultText || r.matchResultText || null, conflict: e.conflict || null,
                balls: e.ballTotal || 0, clips: e.clipTotal || 0, ballsToRewrite: e.ballsToRewrite || 0, clipsToRewrite: e.clipsToRewrite || 0,
                sharedRoom: !!e.sharedRoom, identityChange: !!e.identityChange
            };
        });
        const byStatus = (list) => ({
            completed: list.filter(e => e.status === 'completed').length,
            ongoing: list.filter(e => e.status === 'ongoing').length,
            upcoming: list.filter(e => e.status === 'upcoming').length
        });
        const sAtt = ctx.sRecs.map(r => ctx.att.get(String(r._id)));
        const dAtt = plan.dKept.map(r => ctx.att.get(String(r._id)));
        const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);
        const mediaClips = (list) => sum(list, x => x.clips.filter(c => c.r2Url || c.driveUrl || c.driveFileId || c.r2Key).length);
        const moving = plan.entries.filter(e => e.action === 'move' || e.action === 'remap' || e.action === 'replace-dest');
        const fp = fingerprintOf(ctx);
        const pointsBefore = deps.computePointsTable(ctx.dRecs);
        const pointsAfter = deps.computePointsTable(plan.projected);
        const lbBefore = deps.computeLeaderboards(ctx.dRecs);
        const lbAfter = deps.computeLeaderboards(plan.projected);
        const unified = plan.components.map(comp => ({
            keep: { id: comp.canon.id, name: comp.canon.name },
            from: comp.units.filter(u => u !== comp.keep || u.ids.size > 1).map(u => ({ name: u.name, ids: [...u.ids].sort(), side: u.role }))
        }));
        return Object.assign(base, {
            ok: !plan.blockers.length,
            fingerprint: fp,
            blockers: plan.blockers,
            warnings: plan.warnings,
            errors: plan.errors,
            matches: {
                transfer: matches,
                counts: Object.assign(byStatus(plan.entries.filter(e => e.action !== 'duplicate' && e.action !== 'blocked')), {
                    moving: moving.length,
                    duplicates: plan.entries.filter(e => e.action === 'duplicate').length,
                    remapped: plan.entries.filter(e => e.action === 'remap').length,
                    blocked: plan.entries.filter(e => e.action === 'blocked').length
                }),
                destCount: ctx.dRecs.length,
                finalCount: plan.projected.length
            },
            teams: { pairs: plan.teamPairs, added: plan.teamsAppend.map(t => t.name), destTeams: plan.dCat.size, sourceTeams: plan.sCat.size },
            players: {
                candidates: plan.candidates.map(c => candidateView(c, ctx, usage)),
                autoLinked: plan.autoLinked.length,
                destPlayers: distinctPlayers(ctx.dRecs), sourcePlayers: distinctPlayers(plan.sMoving), finalPlayers: distinctPlayers(plan.projected),
                unified
            },
            scorecards: {
                sourceBalls: sum(sAtt, x => x.balls.length), sourceClips: sum(sAtt, x => x.clips.length),
                ballsToRewrite: plan.counts.ballsToRewrite, clipsToRewrite: plan.counts.clipsToRewrite,
                dismissalsToRewrite: plan.counts.dismissalsToRewrite, recordsToRewrite: plan.counts.recordsToRewrite,
                destMatchesToRewrite: plan.destEntries.length, sharedRoomMatches: plan.counts.sharedRoomMatches
            },
            clips: {
                source: sum(sAtt, x => x.clips.length), sourceWithMedia: mediaClips(sAtt),
                dest: sum(dAtt, x => x.clips.length), toRelabel: plan.counts.clipsToRewrite,
                mediaUntouched: true,
                sourceLinkRedirects: !!ctx.sDoc.publicToken
            },
            settings: { keep: settingsOf(ctx.dDoc, ctx.dPrivate), drop: settingsOf(ctx.sDoc, ctx.sPrivate) },
            pointsTable: { before: tableRows(pointsBefore), after: tableRows(pointsAfter), source: tableRows(deps.computePointsTable(ctx.sRecs)) },
            leaderboards: { before: lbRows(lbBefore), after: lbRows(lbAfter) },
            statuses: Object.assign(byStatus(plan.entries), { live: ctx.sLive.length }),
            expected: {
                matches: deps.playedMatches(plan.projected).length,
                upcoming: plan.projected.length - deps.playedMatches(plan.projected).length,
                teams: distinctTeams(plan.projected),
                players: distinctPlayers(plan.projected),
                clips: sum(dAtt, x => x.clips.length) + sum(moving.map(e => ctx.att.get(e.recId)), x => x.clips.length)
            },
            profiles: plan.profiles.map(p => ({ keep: p.intoId, name: p.intoName, link: p.fromIds, create: p.create }))
        });
    }

    // ---------------------------------------------------------------
    // Execute
    // ---------------------------------------------------------------
    const running = new Set();
    function stagesInit() {
        const s = {};
        STAGES.forEach(k => { s[k] = { state: 'pending', at: null }; });
        return s;
    }
    async function patchOp(opId, set) {
        await db.merges.updateOne({ _id: opId }, { $set: Object.assign({ updatedAt: now(), heartbeatAt: now() }, set) });
    }
    async function stageState(opId, stage, state, extra) {
        const set = { stage, [`stages.${stage}`]: Object.assign({ state, at: now() }, extra || {}) };
        await patchOp(opId, set);
    }

    async function execute(viewer, body) {
        const scope = await scopeFor(viewer);
        if (!scope) throw httpError(403, 'Access Denied');
        body = body || {};
        const idem = isStr(body.idempotencyKey) ? String(body.idempotencyKey).slice(0, 80) : null;
        if (!idem) throw httpError(400, 'Missing request id — reload the page and try again');
        const prior = await db.merges.findOne({ idempotencyKey: idem });
        if (prior) {
            if (prior.initiatedUid !== viewer.uid) throw httpError(409, 'That request id was already used');
            return { opId: prior._id, duplicate: true, status: prior.status };
        }
        const sRef = refOfBody(body.source), dRef = refOfBody(body.dest);
        if (sRef && dRef) {
            const done = await db.merges.findOne({ ownerUid: sRef.ownerUid, 'source.leagueKey': sRef.leagueKey, 'dest.leagueKey': dRef.leagueKey, status: 'completed' });
            const stillThere = done ? await db.leagues.findOne({ ownerUid: sRef.ownerUid, leagueKey: sRef.leagueKey }) : null;
            if (done && !stillThere) return { opId: done._id, duplicate: true, status: done.status, alreadyMerged: true };
        }
        // explicit deletion confirmation, checked server-side
        const confirm = body.confirm || {};
        const sDocPeek = sRef ? await db.leagues.findOne({ ownerUid: sRef.ownerUid, leagueKey: sRef.leagueKey }) : null;
        if (!confirm.deleteSource || !sDocPeek || norm(confirm.typedName) !== norm(sDocPeek.displayName || sDocPeek.leagueKey)) {
            throw httpError(400, 'Type the source tournament name exactly to confirm it will be deleted after the merge');
        }
        const opId = newOpId();
        const t0 = now();
        const op = {
            _id: opId, idempotencyKey: idem, status: 'running', stage: 'analyzing', stages: stagesInit(),
            ownerUid: sRef ? sRef.ownerUid : null, initiatedBy: norm(viewer.email), initiatedUid: viewer.uid,
            source: { leagueKey: sRef && sRef.leagueKey, displayName: sDocPeek.displayName || sDocPeek.leagueKey, publicToken: sDocPeek.publicToken || null },
            dest: { leagueKey: dRef && dRef.leagueKey, displayName: null, publicToken: null },
            counters: {}, warnings: [], errors: [], verification: null, cleanup: null, rollback: null, error: null,
            createdAt: t0, updatedAt: t0, heartbeatAt: t0, startedAt: t0, finishedAt: null
        };
        op.stages.analyzing = { state: 'running', at: t0 };
        try {
            await db.merges.insertOne(op);
        } catch (err) {
            const again = await db.merges.findOne({ idempotencyKey: idem });
            if (again) return { opId: again._id, duplicate: true, status: again.status };
            throw err;
        }
        // locks first, then the fresh analysis the plan is built from
        try {
            await acquireLocks(opId, sRef.ownerUid, sRef.leagueKey, dRef.leagueKey, []);
        } catch (err) {
            await patchOp(opId, { status: 'rejected', error: { message: err.message, stage: 'analyzing', at: now() }, finishedAt: now(), 'stages.analyzing': { state: 'failed', at: now() } });
            throw httpError(409, err.message, { code: 'LOCKED', opId: err.opId || null });
        }
        let a;
        try {
            a = await analysisFor(scope, body, true);
        } catch (err) {
            await releaseLocks(opId);
            await patchOp(opId, { status: 'rejected', error: { message: err.message, stage: 'analyzing', at: now() }, finishedAt: now(), 'stages.analyzing': { state: 'failed', at: now() } });
            throw err;
        }
        const reject = async (status, message, extra) => {
            await releaseLocks(opId);
            await patchOp(opId, { status: 'rejected', error: Object.assign({ message, stage: 'analyzing', at: now() }, extra || {}), finishedAt: now(), 'stages.analyzing': { state: 'failed', at: now() } });
            throw httpError(status, message, extra);
        };
        if (!a.ctx) await reject(400, (a.preBlockers[0] && a.preBlockers[0].message) || 'These tournaments cannot be merged', { blockers: a.preBlockers });
        const blockers = a.plan.blockers.filter(b => !(b.code === 'MERGE_RUNNING' && b.opId === opId));
        if (blockers.length) await reject(409, blockers[0].message, { blockers });
        if (fingerprintOf(a.ctx) !== body.fingerprint) await reject(409, 'The tournaments changed since the preview — please analyze again.', { code: 'STALE_PREVIEW' });
        if (a.plan.errors.length) await reject(400, a.plan.errors[0].message, { errors: a.plan.errors });

        const { ctx, plan } = a;
        const destRewriteIds = plan.destEntries.map(e => e.matchId);
        await setDestLockMatches(opId, ctx.ownerUid, ctx.dDoc.leagueKey, destRewriteIds);
        const storedPlan = {
            entries: plan.entries.map(e => ({
                role: e.role, recId: e.recId, matchId: e.matchId, roomId: e.roomId || null, status: e.status, action: e.action,
                newMatchId: e.newMatchId || null, destRecId: e.destRecId || null, map: e.map || null, teamRename: e.teamRename || null,
                ownKeys: e.ownKeys || [], clash: !!e.clash, sharedRoom: !!e.sharedRoom, title: ctx.title(ctx.sRecs.find(r => String(r._id) === e.recId))
            })),
            destEntries: plan.destEntries.map(e => ({ role: 'dest', recId: e.recId, matchId: e.matchId, status: e.status, action: 'rewrite', map: e.map, ownKeys: e.ownKeys, clash: !!e.clash, sharedRoom: !!e.sharedRoom, title: ctx.title(ctx.dRecs.find(r => String(r._id) === e.recId)) })),
            profiles: plan.profiles,
            teamsAppend: plan.teamsAppend,
            destMatchIdsBefore: ctx.dRecs.map(r => r.matchId),
            expectedClipCounts: Object.fromEntries(plan.entries.filter(e => e.action !== 'blocked').map(e => [e.recId, (ctx.att.get(e.recId) || { clips: [] }).clips.length]))
        };
        const decisionsSummary = {
            players: plan.candidates.map(c => ({
                pairId: c.pairId, type: c.type, decision: c.decision,
                dest: { name: c.d.name, ids: [...c.d.ids].sort(), team: c.d.teamName, matches: c.d.matches.size },
                source: { name: c.s.name, ids: [...c.s.ids].sort(), team: c.s.teamName, matches: c.s.matches.size },
                keptId: c.decision === 'dest' ? c.options.dest.id : (c.decision === 'source' ? c.options.source.id : null),
                keptName: c.decision === 'dest' ? c.options.dest.name : (c.decision === 'source' ? c.options.source.name : null)
            })),
            teams: plan.teamPairs.filter(t => t.type === 'similar').map(t => ({ pairId: t.pairId, destTeam: t.destTeam, sourceTeam: t.sourceTeam, decision: t.decision })),
            matchConflicts: plan.entries.filter(e => e.conflict).map(e => ({ matchId: e.matchId, keep: e.action === 'replace-dest' ? 'source' : 'dest' })),
            autoLinked: plan.autoLinked.length,
            acknowledged: Array.isArray(body.decisions && body.decisions.acknowledged) ? body.decisions.acknowledged.slice(0, 20) : []
        };
        const moving = plan.entries.filter(e => e.action === 'move' || e.action === 'remap' || e.action === 'replace-dest').length;
        await patchOp(opId, {
            stage: 'validating',
            'stages.analyzing': { state: 'done', at: now() },
            'stages.validating': { state: 'running', at: now() },
            ownerUid: ctx.ownerUid,
            source: { leagueKey: ctx.sDoc.leagueKey, displayName: ctx.sDoc.displayName || ctx.sDoc.leagueKey, publicToken: ctx.sDoc.publicToken || null, id: tournamentId(ctx.sDoc), docId: String(ctx.sDoc._id) },
            dest: { leagueKey: ctx.dDoc.leagueKey, displayName: ctx.dDoc.displayName || ctx.dDoc.leagueKey, publicToken: ctx.dDoc.publicToken || null, id: tournamentId(ctx.dDoc), docId: String(ctx.dDoc._id) },
            plan: storedPlan, decisions: decisionsSummary, fingerprint: body.fingerprint,
            warnings: plan.warnings.map(w => ({ code: w.code, message: w.message })),
            counters: {
                matchesTotal: moving, matchesMoved: 0, duplicatesSkipped: plan.entries.filter(e => e.action === 'duplicate').length,
                destMatchesTotal: plan.destEntries.length, destMatchesRewritten: 0, ballsRewritten: 0, clipsRewritten: 0,
                profilesLinked: 0, teamsAdded: 0, backups: 0,
                playersUnified: plan.components.length, teamsUnified: plan.teamPairs.filter(t => t.decision === 'same').length
            }
        });
        // the rest runs in the background; the page follows it with getOp()
        if (deps.autoRun !== false) setImmediate(() => { runOp(opId).catch(err => log('Tournament merge run error:', err)); });
        return { opId, duplicate: false, status: 'running' };
    }

    // ---- backups: the first copy of each document wins ----
    async function backup(opId, coll, doc, extra) {
        const docId = String(doc._id);
        await db.backups.updateOne(
            { _id: `${opId}|${coll}|${docId}` },
            { $setOnInsert: Object.assign({ opId, coll, docId, doc: deepClone(doc), at: now() }, extra || {}) },
            { upsert: true }
        );
    }
    async function backupsOf(opId, coll, extra) {
        const rows = await db.backups.find(Object.assign({ opId, coll }, extra || {})).toArray();
        return rows;
    }
    async function backupDoc(opId, coll, docId) {
        const row = await db.backups.findOne({ _id: `${opId}|${coll}|${docId}` });
        return row ? row.doc : null;
    }

    function attributable(entry, ball) {
        return (entry.ownKeys || []).includes(ball.matchId);
    }
    function attributableClip(entry, c) {
        return clipBelongs({ matchId: entry.matchId, ownKeys: entry.ownKeys || [], clash: !!entry.clash }, c);
    }

    async function stageValidate(op) {
        const plan = op.plan;
        const opId = op._id;
        let n = 0;
        const sDoc = await db.leagues.findOne({ ownerUid: op.ownerUid, leagueKey: op.source.leagueKey });
        const dDoc = await db.leagues.findOne({ ownerUid: op.ownerUid, leagueKey: op.dest.leagueKey });
        if (!sDoc || !dDoc) throw new Error('A tournament disappeared before the merge started');
        await backup(opId, 'leagues', sDoc, { role: 'source' }); n++;
        await backup(opId, 'leagues', dDoc, { role: 'dest' }); n++;
        const all = [...plan.entries, ...plan.destEntries];
        for (const e of all) {
            if (e.action === 'blocked') throw new Error('A match cannot be merged safely');
            const rec = await db.records.findOne({ _id: await idOf(e.recId) });
            if (!rec) throw new Error(`Match ${e.matchId} disappeared before the merge started`);
            await backup(opId, 'records', rec, { recId: e.recId, role: e.role }); n++;
            if (e.destRecId) {
                const d = await db.records.findOne({ _id: await idOf(e.destRecId) });
                if (d) { await backup(opId, 'records', d, { recId: e.destRecId, role: 'dest' }); n++; }
            }
            if (!e.map || (e.action === 'duplicate')) continue;
            if (e.ownKeys.length) {
                const balls = await db.balls.find({ matchId: { $in: e.ownKeys } }).toArray();
                for (const b of balls) {
                    if (!attributable(e, b)) continue;
                    if (transformBall(b, e.map, pk)) { await backup(opId, 'balls', b, { recId: e.recId }); n++; }
                }
            }
            const clips = await db.clips.find({ $or: [{ matchId: { $in: e.ownKeys } }, { tournamentMatchId: e.matchId }] }).toArray();
            for (const c of clips) {
                if (!attributableClip(e, c)) continue;
                if (transformClip(c, e.map, pk)) { await backup(opId, 'clips', c, { recId: e.recId }); n++; }
            }
            if (db.panelStates) {
                const ps = await db.panelStates.findOne({ matchId: e.matchId });
                if (ps) { await backup(opId, 'panelStates', ps, { recId: e.recId }); n++; }
            }
        }
        for (const p of plan.profiles) {
            const into = await db.players.findOne({ ownerUid: op.ownerUid, playerId: p.intoId });
            if (into) { await backup(opId, 'players', into, { playerId: p.intoId }); n++; }
            for (const f of p.fromIds) {
                const from = await db.players.findOne({ ownerUid: op.ownerUid, playerId: f });
                if (from) { await backup(opId, 'players', from, { playerId: f }); n++; }
            }
        }
        await patchOp(opId, { 'counters.backups': n });
    }

    // _ids are stored as strings in the plan; turn them back into ObjectIds
    // (or leave them as they were if the collection uses string ids).
    async function idOf(s) {
        return deps.toObjectId ? deps.toObjectId(s) : s;
    }

    async function stageTransfer(op) {
        const plan = op.plan;
        const opId = op._id;
        const kd = op.dest.leagueKey;
        let moved = 0, destRw = 0, balls = 0, clips = 0;
        const all = [...plan.entries, ...plan.destEntries];
        for (const e of all) {
            if (e.action === 'blocked') throw new Error('A match cannot be merged safely');
            const orig = await backupDoc(opId, 'records', e.recId);
            if (!orig) throw new Error(`No backup for match ${e.matchId}`);
            if (e.action !== 'duplicate') {
                const target = transformRecord(orig, e.map, e.teamRename, pk).doc;
                if (e.role === 'source') target.leagueKey = kd;
                if (e.action === 'move' || e.action === 'rewrite') {
                    const r = await db.records.replaceOne({ _id: orig._id }, target);
                    if (!r || !r.matchedCount) throw new Error(`Match ${e.matchId} could not be written`);
                } else if (e.action === 'remap') {
                    const t = Object.assign({}, target, { matchId: e.newMatchId });
                    delete t._id;
                    await db.records.replaceOne({ ownerUid: op.ownerUid, leagueKey: kd, matchId: e.newMatchId }, t, { upsert: true });
                    await db.records.deleteOne({ _id: orig._id });
                } else if (e.action === 'replace-dest') {
                    const destOrig = await backupDoc(opId, 'records', e.destRecId);
                    if (!destOrig) throw new Error(`No backup for destination copy of ${e.matchId}`);
                    const t = Object.assign({}, target, { _id: destOrig._id, leagueKey: kd });
                    const r = await db.records.replaceOne({ _id: destOrig._id }, t);
                    if (!r || !r.matchedCount) throw new Error(`Match ${e.matchId} could not be written`);
                }
                if (deps.versionMatchRecord) {
                    try { await deps.versionMatchRecord(orig, 'tournament merge', { forced: true, mergeOpId: opId }); } catch (err) { /* history is a nicety */ }
                }
            }
            if (e.map && e.action !== 'duplicate') {
                const bRows = await backupsOf(opId, 'balls', { recId: e.recId });
                const ops = [];
                bRows.forEach(row => { const set = transformBall(row.doc, e.map, pk); if (set) ops.push({ updateOne: { filter: { _id: row.doc._id }, update: { $set: set } } }); });
                if (ops.length) await db.balls.bulkWrite(ops, { ordered: false });
                balls += ops.length;
                const cRows = await backupsOf(opId, 'clips', { recId: e.recId });
                const cOps = [];
                const touched = new Set();
                cRows.forEach(row => { const set = transformClip(row.doc, e.map, pk); if (set) { cOps.push({ updateOne: { filter: { _id: row.doc._id }, update: { $set: set } } }); touched.add(row.doc.matchId); } });
                if (cOps.length) await db.clips.bulkWrite(cOps, { ordered: false });
                clips += cOps.length;
                touched.forEach(m => { try { deps.invalidateClipsCache && deps.invalidateClipsCache(m); } catch (err) { /* cache */ } });
                // an old resume snapshot would bring the old ids back — the
                // panel rebuilds from the (renamed) record without it
                const ps = await backupsOf(opId, 'panelStates', { recId: e.recId });
                if (db.panelStates) for (const row of ps) await db.panelStates.deleteOne({ _id: row.doc._id });
            }
            if (e.role === 'source' && e.action !== 'duplicate') moved++;
            if (e.role === 'dest') destRw++;
            await patchOp(opId, { 'counters.matchesMoved': moved, 'counters.destMatchesRewritten': destRw, 'counters.ballsRewritten': balls, 'counters.clipsRewritten': clips });
        }
        // player profiles: link the ids that no longer stand on their own
        let linked = 0;
        for (const p of plan.profiles) {
            const intoRows = await backupsOf(opId, 'players', { playerId: p.intoId });
            const intoOrig = intoRows[0] ? intoRows[0].doc : null;
            const keys = new Set(((intoOrig && intoOrig.nameKeys) || []).filter(k => !String(k).startsWith('#merged:')));
            // 1) retire the other profiles first — that frees their name keys
            for (const f of p.fromIds) {
                const rows = await backupsOf(opId, 'players', { playerId: f });
                const fromOrig = rows[0] && rows[0].doc;
                if (!fromOrig) continue;
                (fromOrig.nameKeys || []).filter(k => !String(k).startsWith('#merged:')).forEach(k => keys.add(k));
                await db.players.updateOne({ _id: fromOrig._id }, { $set: { nameKeys: [retiredKey(f)], mergedInto: p.intoId, updatedAt: now(), mergedByMergeOp: opId } });
                try { deps.repointPlayerIdCache && deps.repointPlayerIdCache(f, p.intoId); } catch (err) { /* cache */ }
                linked++;
            }
            // 2) the kept profile takes every spelling (its own name too, if
            //    no other player holds it)
            if (p.intoKey) {
                const holder = await db.players.findOne({ ownerUid: op.ownerUid, nameKeys: p.intoKey });
                if (!holder || holder.playerId === p.intoId) keys.add(p.intoKey);
            }
            const keyList = keys.size ? [...keys] : [retiredKey(p.intoId).replace('#merged:', '#profile:')];
            if (!intoOrig) {
                await db.players.updateOne(
                    { ownerUid: op.ownerUid, playerId: p.intoId },
                    { $setOnInsert: { playerId: p.intoId, ownerUid: op.ownerUid, displayName: p.intoName, createdAt: now(), createdByMergeOp: opId }, $set: { nameKeys: keyList, updatedAt: now() } },
                    { upsert: true }
                );
            } else {
                await db.players.updateOne({ ownerUid: op.ownerUid, playerId: p.intoId }, { $set: { nameKeys: keyList, updatedAt: now() } });
            }
        }
        // teams the destination's list did not have yet (append only)
        let added = 0;
        if (plan.teamsAppend.length) {
            const dDoc = await db.leagues.findOne({ ownerUid: op.ownerUid, leagueKey: kd });
            const have = new Set(((dDoc && dDoc.info && Array.isArray(dDoc.info.teams)) ? dDoc.info.teams : []).map(t => norm(t && t.name)));
            const list = plan.teamsAppend.filter(t => !have.has(norm(t.name)));
            if (list.length && dDoc && dDoc.info && Array.isArray(dDoc.info.teams)) {
                await db.leagues.updateOne({ _id: dDoc._id }, { $push: { 'info.teams': { $each: list } } });
                added = list.length;
            }
        }
        await db.leagues.updateOne({ ownerUid: op.ownerUid, leagueKey: kd }, { $set: { updatedAt: now() } });
        await patchOp(opId, { 'counters.profilesLinked': linked, 'counters.teamsAdded': added });
        try { deps.invalidateTournamentCaches && deps.invalidateTournamentCaches(op.dest.publicToken); } catch (err) { /* cache */ }
    }

    async function stageRecalculate(op) {
        const recs = await db.records.find({ ownerUid: op.ownerUid, leagueKey: op.dest.leagueKey }).toArray();
        const table = deps.computePointsTable(recs);
        const lb = deps.computeLeaderboards(recs);
        try { deps.invalidateTournamentCaches && deps.invalidateTournamentCaches(op.dest.publicToken); } catch (err) { /* cache */ }
        try { deps.invalidateTournamentCaches && op.source.publicToken && deps.invalidateTournamentCaches(op.source.publicToken); } catch (err) { /* cache */ }
        await patchOp(op._id, { result: { pointsTable: tableRows(table), leaderboards: lbRows(lb), matches: deps.playedMatches(recs).length, upcoming: recs.length - deps.playedMatches(recs).length, players: distinctPlayers(recs), teams: distinctTeams(recs) } });
    }

    // Everything the merged destination must satisfy before the source may go.
    async function verifyOp(op) {
        const plan = op.plan;
        const opId = op._id;
        const kd = op.dest.leagueKey, ks = op.source.leagueKey;
        const checks = [];
        const add = (id, label, ok, detail) => checks.push({ id, label, ok: !!ok, detail: detail || null });
        const finalD = await db.records.find({ ownerUid: op.ownerUid, leagueKey: kd }).toArray();
        const idCount = new Map();
        finalD.forEach(r => idCount.set(r.matchId, (idCount.get(r.matchId) || 0) + 1));
        const expected = new Set(plan.destMatchIdsBefore);
        plan.entries.forEach(e => { if (e.action === 'move' || e.action === 'replace-dest' || e.action === 'duplicate') expected.add(e.matchId); if (e.action === 'remap') expected.add(e.newMatchId); });
        const missing = [...expected].filter(id => !idCount.has(id));
        add('all-matches-present', 'Every match is in the destination', !missing.length, missing.length ? `Missing: ${missing.slice(0, 5).join(', ')}` : `${expected.size} matches`);
        const dupes = [...idCount.entries()].filter(([, c]) => c > 1).map(([id]) => id);
        add('no-duplicates', 'No match counted twice', !dupes.length, dupes.length ? `Twice: ${dupes.slice(0, 5).join(', ')}` : null);
        const sourceIds = new Set(plan.entries.map(e => e.matchId));
        const leftover = await db.records.find({ ownerUid: op.ownerUid, leagueKey: ks }).toArray();
        const allowedLeft = new Set(plan.entries.filter(e => e.action === 'duplicate' || e.action === 'replace-dest').map(e => e.recId));
        const strays = leftover.filter(r => !allowedLeft.has(String(r._id)));
        add('source-emptied', 'No match left behind in the source', !strays.length, strays.length ? `${strays.length} match${strays.length === 1 ? '' : 'es'} still in the source (saved during the merge?)` : null);
        // scorecards: every moved match's cricket exactly as before
        let scoreBad = [];
        const byMatchId = new Map(finalD.map(r => [r.matchId, r]));
        for (const e of plan.entries) {
            if (!(e.action === 'move' || e.action === 'remap' || e.action === 'replace-dest')) continue;
            const orig = await backupDoc(opId, 'records', e.recId);
            const cur = byMatchId.get(e.newMatchId || e.matchId);
            if (!orig || !cur || scoringFingerprint(orig) !== scoringFingerprint(cur)) scoreBad.push(e.matchId);
        }
        for (const e of plan.destEntries) {
            const orig = await backupDoc(opId, 'records', e.recId);
            const cur = byMatchId.get(e.matchId);
            if (!orig || !cur || scoringFingerprint(orig) !== scoringFingerprint(cur)) scoreBad.push(e.matchId);
        }
        add('scorecards-intact', 'Scores, results and figures unchanged', !scoreBad.length, scoreBad.length ? `Changed: ${scoreBad.slice(0, 5).join(', ')}` : null);
        // player references: nothing left pointing at a replaced id / spelling
        let refBad = [];
        for (const e of [...plan.entries, ...plan.destEntries]) {
            if (!e.map || e.action === 'duplicate' || e.action === 'blocked') continue;
            const cur = byMatchId.get(e.newMatchId || e.matchId);
            if (!cur) continue;
            if (transformRecord(cur, e.map, null, pk).changes) refBad.push(e.matchId);
            if (e.ownKeys.length) {
                const balls = await db.balls.find({ matchId: { $in: e.ownKeys } }).toArray();
                if (balls.some(b => attributable(e, b) && transformBall(b, e.map, pk))) refBad.push(e.matchId + ' (balls)');
            }
            const clips = await db.clips.find({ $or: [{ matchId: { $in: e.ownKeys } }, { tournamentMatchId: e.matchId }] }).toArray();
            if (clips.some(c => attributableClip(e, c) && transformClip(c, e.map, pk))) refBad.push(e.matchId + ' (clips)');
        }
        add('references-updated', 'Every player reference points at the kept ID', !refBad.length, refBad.length ? refBad.slice(0, 5).join(', ') : null);
        // clips: same count per match, media fields untouched
        let clipBad = [];
        for (const e of plan.entries) {
            if (!(e.action === 'move' || e.action === 'remap' || e.action === 'replace-dest')) continue;
            const exp = plan.expectedClipCounts[e.recId];
            if (exp == null) continue;
            const clips = await db.clips.find({ $or: [{ matchId: { $in: e.ownKeys } }, { tournamentMatchId: e.matchId }] }).toArray();
            const got = clips.filter(c => attributableClip(e, c)).length;
            if (got < exp) clipBad.push(`${e.matchId}: ${got}/${exp}`);
        }
        const cRows = await backupsOf(opId, 'clips');
        for (const row of cRows) {
            const cur = await db.clips.findOne({ _id: row.doc._id });
            if (!cur) { clipBad.push(`clip ${row.docId} missing`); continue; }
            if (CLIP_MEDIA_FIELDS.some(f => stable(cur[f]) !== stable(row.doc[f]))) clipBad.push(`clip ${row.docId} media changed`);
        }
        add('clips-preserved', 'Every clip kept, media untouched', !clipBad.length, clipBad.length ? clipBad.slice(0, 5).join(', ') : `${cRows.length} relinked`);
        // points table: every played match once
        const played = deps.playedMatches(finalD).filter(r => norm(r.teamA && r.teamA.name) && norm(r.teamB && r.teamB.name));
        const table = deps.computePointsTable(finalD);
        const sumPlayed = table.reduce((n, r) => n + r.played, 0);
        const perTeam = new Map();
        played.forEach(r => SIDES.forEach(s => { const k = norm(r['team' + s].name); perTeam.set(k, (perTeam.get(k) || 0) + 1); }));
        const teamOk = table.every(r => perTeam.get(norm(r.team)) === r.played);
        add('points-table', 'Points table counts every match exactly once', sumPlayed === 2 * played.length && teamOk, `${played.length} matches, ${table.length} teams`);
        // leaderboards: every batter/bowler row adds up, kept players once
        const agg = new Map();
        finalD.forEach(r => deps.playedMatches([r]).forEach(m => SIDES.forEach(s => {
            ((m.battingCard && m.battingCard[s]) || []).forEach(b => { if (b && b.name) { const k = pk(b.name); agg.set(k, (agg.get(k) || 0) + (Number(b.runs) || 0)); } });
        })));
        const wagg = new Map();
        finalD.forEach(r => deps.playedMatches([r]).forEach(m => SIDES.forEach(s => {
            ((m.bowlingCard && m.bowlingCard[s]) || []).forEach(b => { if (b && b.name) { const k = pk(b.name); wagg.set(k, (wagg.get(k) || 0) + (Number(b.wickets) || 0)); } });
        })));
        const lb = deps.computeLeaderboards(finalD);
        const lbOk = lb.topRuns.every(row => agg.get(pk(row.name)) === row.runs) && lb.topWickets.every(row => wagg.get(pk(row.name)) === row.wickets);
        // each merged player is one row: his runs/wickets are the sum of the
        // destination's and the source's, never counted twice
        const kept = new Map();
        [...plan.entries, ...plan.destEntries].forEach(e => { const mm = hydrate(e.map); if (mm) mm.canon.forEach(c => { if (c && c.key) kept.set(c.key, c.name); }); });
        const keptRows = [...kept.keys()].filter(k => lb.topRuns.filter(r => pk(r.name) === k).length > 1 || lb.topWickets.filter(r => pk(r.name) === k).length > 1);
        add('leaderboards', 'Leaderboards add up, each merged player once', lbOk && !keptRows.length,
            keptRows.length ? `Listed twice: ${keptRows.slice(0, 3).join(', ')}` : `${lb.topRuns.length} batters, ${lb.topWickets.length} bowlers ranked`);
        // destination settings unchanged (its team list may only grow)
        const dOrig = await backupsOf(opId, 'leagues', { role: 'dest' });
        const dNow = await db.leagues.findOne({ ownerUid: op.ownerUid, leagueKey: kd });
        let setOk = !!(dOrig[0] && dNow);
        if (setOk) {
            const a = dOrig[0].doc, b = dNow;
            ['ownerUid', 'leagueKey', 'displayName', 'publicToken', 'statusOverride', 'visibilityOverride', 'completed', 'sport', 'createdBy'].forEach(k => { if (stable(a[k]) !== stable(b[k])) setOk = false; });
            const ia = Object.assign({}, a.info || {}), ib = Object.assign({}, b.info || {});
            const ta = ia.teams || [], tb = ib.teams || [];
            delete ia.teams; delete ib.teams;
            if (stable(ia) !== stable(ib)) setOk = false;
            if (stable(tb.slice(0, ta.length)) !== stable(ta)) setOk = false;
        }
        add('destination-settings', 'Destination name, ID, visibility and status unchanged', setOk, null);
        // profiles linked as planned
        let profOk = true;
        for (const p of plan.profiles) {
            for (const f of p.fromIds) {
                const doc = await db.players.findOne({ ownerUid: op.ownerUid, playerId: f });
                if (doc && (doc.mergedInto !== p.intoId || (doc.nameKeys || []).some(k => !String(k).startsWith('#merged:')))) profOk = false;
            }
            const into = await db.players.findOne({ ownerUid: op.ownerUid, playerId: p.intoId });
            if (!into) profOk = false;
        }
        add('profiles-linked', 'Player profiles linked to the kept IDs', profOk, plan.profiles.length ? `${plan.profiles.length} kept ID${plan.profiles.length === 1 ? '' : 's'}` : 'Nothing to link');
        const passed = checks.every(c => c.ok);
        return { passed, checks, at: now() };
    }

    async function stageCleanup(op) {
        const ks = op.source.leagueKey;
        const sDoc = await db.leagues.findOne({ ownerUid: op.ownerUid, leagueKey: ks });
        // copies of matches the destination already had (kept once)
        const leftover = op.plan.entries.filter(e => e.action === 'duplicate' || e.action === 'replace-dest');
        for (const e of leftover) await db.records.deleteOne({ _id: await idOf(e.recId), leagueKey: ks });
        if (sDoc) await db.leagues.deleteOne({ _id: sDoc._id });
        mergedAway.set(lockKey(op.ownerUid, ks), { destLeagueKey: op.dest.leagueKey, opId: op._id });
        try { deps.invalidateTournamentCaches && deps.invalidateTournamentCaches(op.source.publicToken); } catch (err) { /* cache */ }
        try { deps.invalidateTournamentCaches && deps.invalidateTournamentCaches(op.dest.publicToken); } catch (err) { /* cache */ }
    }

    // ---- rollback: put every backed-up document back ----
    async function rollbackOp(opId) {
        const op = await db.merges.findOne({ _id: opId });
        if (!op) throw httpError(404, 'Merge not found');
        const plan = op.plan || { entries: [], destEntries: [], profiles: [] };
        const restore = async (coll, store) => {
            const rows = await backupsOf(opId, coll);
            for (const row of rows) await store.replaceOne({ _id: row.doc._id }, row.doc, { upsert: true });
            return rows.length;
        };
        // matches remapped to a new id: remove the new copy
        for (const e of (plan.entries || [])) {
            if (e.action === 'remap' && e.newMatchId) await db.records.deleteOne({ ownerUid: op.ownerUid, leagueKey: op.dest.leagueKey, matchId: e.newMatchId });
        }
        const n = { records: await restore('records', db.records), balls: await restore('balls', db.balls), clips: await restore('clips', db.clips) };
        if (db.panelStates) n.panelStates = await restore('panelStates', db.panelStates);
        n.players = await restore('players', db.players);
        await db.players.deleteMany({ ownerUid: op.ownerUid, createdByMergeOp: opId });
        // league docs: the destination's team list goes back; a deleted
        // source comes back whole
        const lg = await backupsOf(opId, 'leagues');
        for (const row of lg) {
            if (row.role === 'dest') {
                // only what the merge itself changed: the team list and updatedAt
                const info = row.doc.info;
                const set = { updatedAt: row.doc.updatedAt === undefined ? null : row.doc.updatedAt };
                if (info && Array.isArray(info.teams)) set['info.teams'] = info.teams;
                await db.leagues.updateOne({ _id: row.doc._id }, { $set: set });
            } else {
                const cur = await db.leagues.findOne({ _id: row.doc._id });
                if (!cur) await db.leagues.replaceOne({ _id: row.doc._id }, row.doc, { upsert: true });
            }
        }
        mergedAway.delete(lockKey(op.ownerUid, op.source.leagueKey));
        try { deps.invalidateTournamentCaches && deps.invalidateTournamentCaches(op.dest.publicToken); } catch (err) { /* cache */ }
        try { deps.invalidateTournamentCaches && deps.invalidateTournamentCaches(op.source.publicToken); } catch (err) { /* cache */ }
        return n;
    }

    const ORDER = ['validating', 'transferring', 'recalculating', 'verifying', 'cleanup'];
    async function runOp(opId, opts) {
        if (running.has(opId)) return;
        running.add(opId);
        let stage = null;
        try {
            let op = await db.merges.findOne({ _id: opId });
            if (!op || !op.plan) return;
            const start = Math.max(0, ORDER.indexOf(op.stage === 'cleanup' ? 'cleanup' : op.stage));
            for (let i = start; i < ORDER.length; i++) {
                stage = ORDER[i];
                op = await db.merges.findOne({ _id: opId });
                if (stage === 'cleanup') {
                    await patchOp(opId, { stage: 'verifying', cleanup: { state: 'running', at: now() } });
                    try {
                        await stageCleanup(op);
                    } catch (err) {
                        await patchOp(opId, { status: 'pending_cleanup', cleanup: { state: 'failed', at: now(), error: err.message }, stage: 'verifying' });
                        log('Tournament merge cleanup error:', err);
                        await audit(op, 'Tournament merge (source kept, cleanup pending)');
                        return;
                    }
                    await patchOp(opId, { cleanup: { state: 'done', at: now() } });
                    continue;
                }
                await stageState(opId, stage, 'running');
                if (stage === 'validating') await stageValidate(op);
                if (stage === 'transferring') await stageTransfer(op);
                if (stage === 'recalculating') await stageRecalculate(op);
                if (stage === 'verifying') {
                    const v = await verifyOp(op);
                    await patchOp(opId, { verification: v });
                    if (!v.passed) {
                        const bad = v.checks.filter(c => !c.ok).map(c => c.label).join('; ');
                        const e = new Error('Verification failed: ' + bad);
                        e.verification = true;
                        throw e;
                    }
                }
                await stageState(opId, stage, 'done');
                if (deps.afterStage) await deps.afterStage(stage, opId);
                // test hook: stop between stages like a crash would
                if (opts && opts.stopAfter === stage) { const e = new Error('stopped for test'); e.simulatedCrash = true; throw e; }
                if (deps.failAfterStage && deps.failAfterStage === stage) { const e = new Error('simulated failure after ' + stage); throw e; }
            }
            await patchOp(opId, { status: 'completed', stage: 'completed', 'stages.completed': { state: 'done', at: now() }, finishedAt: now() });
            op = await db.merges.findOne({ _id: opId });
            await releaseLocks(opId);
            await audit(op, 'Tournament merge');
        } catch (err) {
            log('Tournament merge failed at', stage, err && err.message);
            if (err && err.simulatedCrash) {
                await patchOp(opId, { status: 'interrupted', error: { message: 'Stopped during ' + stage, stage, at: now() } });
                return;
            }
            await patchOp(opId, { status: 'failed', error: { message: (err && err.message) || 'Merge failed', stage, at: now() }, [`stages.${stage || 'validating'}`]: { state: 'failed', at: now() } });
            // nothing was written before transferring began → just unlock
            if (stage === 'validating') {
                await releaseLocks(opId);
                await patchOp(opId, { status: 'rolled_back', rollback: { state: 'done', at: now(), restored: {} }, finishedAt: now() });
                const op = await db.merges.findOne({ _id: opId });
                await audit(op, 'Tournament merge failed (nothing changed)');
                return;
            }
            try {
                const restored = await rollbackOp(opId);
                await releaseLocks(opId);
                await patchOp(opId, { status: 'rolled_back', rollback: { state: 'done', at: now(), restored }, finishedAt: now() });
                const op = await db.merges.findOne({ _id: opId });
                await audit(op, 'Tournament merge rolled back');
            } catch (rbErr) {
                log('Tournament merge rollback error:', rbErr);
                await patchOp(opId, { rollback: { state: 'failed', at: now(), error: rbErr.message } });
            }
        } finally {
            running.delete(opId);
        }
    }

    async function audit(op, action) {
        if (!deps.logAuditAction || !op) return;
        const c = op.counters || {};
        try {
            await deps.logAuditAction(op.initiatedBy, action,
                `${op.source.displayName} → ${op.dest.displayName}`,
                { source: { name: op.source.displayName, id: op.source.id || op.source.leagueKey } },
                { dest: { name: op.dest.displayName, id: op.dest.id || op.dest.leagueKey }, status: op.status },
                {
                    mergeOpId: op._id, mergeStatus: op.status,
                    matchesTransferred: c.matchesMoved || 0, playersUnified: c.playersUnified || 0, teamsUnified: c.teamsUnified || 0,
                    ballsRelinked: c.ballsRewritten || 0, clipsRelinked: c.clipsRewritten || 0,
                    verification: op.verification ? op.verification.passed : null,
                    cleanup: op.cleanup ? op.cleanup.state : null
                });
        } catch (err) { log('Tournament merge audit error:', err); }
    }

    // ---- reading an operation (progress screen, history) ----
    function opView(op) {
        if (!op) return null;
        const terminal = ['completed', 'rolled_back', 'rejected'].includes(op.status);
        return {
            opId: op._id, status: op.status, stage: op.stage, stages: op.stages, counters: op.counters || {},
            source: op.source, dest: op.dest, initiatedBy: op.initiatedBy,
            createdAt: op.createdAt, finishedAt: op.finishedAt || null, updatedAt: op.updatedAt,
            warnings: op.warnings || [], verification: op.verification || null, result: op.result || null,
            cleanup: op.cleanup || null, rollback: op.rollback || null, error: op.error || null,
            decisions: op.decisions || null,
            matches: op.plan ? op.plan.entries.map(e => ({ matchId: e.matchId, newMatchId: e.newMatchId, title: e.title, action: e.action, status: e.status })) : [],
            canResume: !terminal && (op.status === 'interrupted' || (op.status === 'failed' && op.rollback && op.rollback.state === 'failed')),
            canRollback: !terminal && (op.status === 'interrupted' || op.status === 'failed' || op.status === 'pending_cleanup'),
            canRetryCleanup: op.status === 'pending_cleanup'
        };
    }
    async function opFor(viewer, opId) {
        const scope = await scopeFor(viewer);
        if (!scope) throw httpError(403, 'Access Denied');
        const op = await db.merges.findOne({ _id: String(opId || '') });
        if (!op || (op.ownerUid && !scope.uids.has(op.ownerUid))) throw httpError(404, 'Merge not found');
        return op;
    }
    async function getOp(viewer, opId) {
        return opView(await opFor(viewer, opId));
    }
    async function history(viewer) {
        const scope = await scopeFor(viewer);
        if (!scope) throw httpError(403, 'Access Denied');
        const ops = await db.merges.find({ ownerUid: { $in: [...scope.uids] }, status: { $ne: 'rejected' } }).sort({ createdAt: -1 }).limit(50).toArray();
        return ops.map(op => {
            const v = opView(op);
            return { opId: v.opId, status: v.status, stage: v.stage, source: v.source, dest: v.dest, initiatedBy: v.initiatedBy,
                createdAt: v.createdAt, finishedAt: v.finishedAt, counters: v.counters,
                verification: v.verification ? { passed: v.verification.passed } : null, cleanup: v.cleanup, error: v.error,
                canResume: v.canResume, canRollback: v.canRollback, canRetryCleanup: v.canRetryCleanup };
        });
    }
    async function resume(viewer, opId) {
        const op = await opFor(viewer, opId);
        if (!(op.status === 'interrupted' || (op.status === 'failed' && op.rollback && op.rollback.state === 'failed'))) throw httpError(409, 'This merge cannot be resumed');
        if (running.has(op._id)) throw httpError(409, 'This merge is still running');
        // locks must still be ours
        await acquireLocks(op._id, op.ownerUid, op.source.leagueKey, op.dest.leagueKey, (op.plan.destEntries || []).map(e => e.matchId));
        await patchOp(op._id, { status: 'running', error: null, rollback: null });
        if (deps.autoRun !== false) setImmediate(() => { runOp(op._id).catch(err => log('Tournament merge resume error:', err)); });
        return opView(await db.merges.findOne({ _id: op._id }));
    }
    async function rollback(viewer, opId) {
        const op = await opFor(viewer, opId);
        if (!['interrupted', 'failed', 'pending_cleanup'].includes(op.status)) throw httpError(409, 'Only an unfinished merge can be rolled back');
        if (running.has(op._id)) throw httpError(409, 'This merge is still running');
        const restored = await rollbackOp(op._id);
        await releaseLocks(op._id);
        await patchOp(op._id, { status: 'rolled_back', rollback: { state: 'done', at: now(), restored, by: norm(viewer.email) }, finishedAt: now() });
        const done = await db.merges.findOne({ _id: op._id });
        await audit(done, 'Tournament merge rolled back');
        return opView(done);
    }
    async function retryCleanup(viewer, opId) {
        const op = await opFor(viewer, opId);
        if (op.status !== 'pending_cleanup') throw httpError(409, 'Nothing to clean up');
        await stageCleanup(op);
        await patchOp(op._id, { status: 'completed', stage: 'completed', 'stages.completed': { state: 'done', at: now() }, cleanup: { state: 'done', at: now() }, finishedAt: now() });
        await releaseLocks(op._id);
        const done = await db.merges.findOne({ _id: op._id });
        await audit(done, 'Tournament merge');
        return opView(done);
    }

    // A merge still marked "running" when the server starts was cut off by
    // the restart. It keeps its locks (the source stays protected) and waits
    // for someone to resume or roll it back.
    async function recoverInterrupted() {
        const stuck = await db.merges.find({ status: 'running' }).toArray();
        for (const op of stuck) {
            if (running.has(op._id)) continue;
            await patchOp(op._id, { status: 'interrupted', error: { message: 'The server restarted during the merge — resume it or roll it back.', stage: op.stage, at: now() } });
        }
        await loadState();
        return stuck.length;
    }

    // ---- after a merge: where the source's old links and live pings go ----
    async function aliasForToken(token) {
        let t = String(token || '');
        let hop = null;
        for (let i = 0; i < 5 && t; i++) {
            const op = await db.merges.findOne({ 'source.publicToken': t, status: 'completed' });
            if (!op) break;
            hop = { destToken: op.dest.publicToken, ownerUid: op.ownerUid, destLeagueKey: op.dest.leagueKey, opId: op._id,
                matchIdMap: Object.fromEntries(((op.plan && op.plan.entries) || []).filter(e => e.newMatchId).map(e => [e.matchId, e.newMatchId])) };
            const still = await db.leagues.findOne({ publicToken: op.dest.publicToken });
            if (still) return Object.assign(hop, { doc: still });
            t = op.dest.publicToken;
        }
        return null;
    }
    // A scoring laptop still bound to a merged-away tournament pings
    // live-status for a match that now lives in the destination.
    async function redirectLeagueKey(ownerUid, leagueKey, matchId) {
        const m = mergedAway.get(lockKey(ownerUid, leagueKey));
        if (!m || !isStr(matchId)) return null;
        const own = await db.leagues.findOne({ ownerUid, leagueKey });
        if (own) return null; // a new tournament with that name exists now
        const rec = await db.records.findOne({ ownerUid, leagueKey: m.destLeagueKey, matchId });
        return rec ? m.destLeagueKey : null;
    }

    return {
        listTournaments, tournamentSummary, analyze, execute, getOp, history, resume, rollback, retryCleanup,
        recoverInterrupted, loadState, lockFor, aliasForToken, redirectLeagueKey,
        // for tests
        _runOp: runOp, _rollbackOp: rollbackOp, _verifyOp: verifyOp
    };
}

module.exports = {
    createTournamentMerge, isMergeAdminEmail, MERGE_ADMIN_EMAILS, STAGES,
    // pure helpers (unit tests)
    _internals: {
        similarNames, similarTeams, replaceNames, recordRefs, ballSlots, clipSlots, transformRecord, transformBall, transformClip,
        scoringFingerprint, planMerge, buildUnits, teamCatalog, levenshtein, hydrate, stable, sameMatch
    }
};
