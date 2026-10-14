// 🏏 Imported scorecards — the cricket rules, shared by the import page
// (live checks while the person corrects figures) and the server (the same
// checks again before anything is saved). Pure functions, no I/O.
//
// A match here is the import's own working shape:
//   { teams: { A: { name }, B: { name } }, overs (per innings, limited-overs
//     formats; null for an unlimited format),
//     innings: [ { battingSide: 'A'|'B',
//                  batting:  [{ key, name, dismissal (text), runs, balls, fours, sixes, … }],
//                  didNotBat: [names],
//                  bowling:  [{ key, name, overs ("3.4"), maidens, runs, wickets, wides, noBalls, … }],
//                  extras:   { total, wides, noBalls, byes, legByes, penalty },
//                  total:    { runs, wickets, overs ("19.4"), declared, allOut },
//                  fallOfWickets: [{ wicket, runs, overs, batter }] }, … ] }
// null always means "not on the scorecard" — never zero.
(function (root) {
    'use strict';

    const BALLS_PER_OVER = 6;
    const isNum = (v) => typeof v === 'number' && isFinite(v);
    const intOrNull = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = typeof v === 'number' ? v : Number(String(v).trim());
        return Number.isInteger(n) && n >= 0 ? n : null;
    };
    const cleanName = (s) => String(s == null ? '' : s).replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    // a player's name without the scorecard's role markers: (c), (wk), †, *
    const ROLE_RE = /\(\s*(?:c|wk|c\s*&\s*wk|wk\s*&\s*c|capt|captain)\s*\)|[†*]/gi;
    const playerName = (s) => cleanName(String(s == null ? '' : s).replace(ROLE_RE, ' '));
    const hasRole = (s, role) => role === 'wk' ? /\(\s*(?:wk|c\s*&\s*wk|wk\s*&\s*c)\s*\)|†/i.test(String(s || '')) : /\(\s*(?:c|c\s*&\s*wk|wk\s*&\s*c|capt|captain)\s*\)|\*/i.test(String(s || ''));
    const nameKey = (s) => cleanName(s).toLowerCase() || null;
    // Player names are saved as FIRST + LAST name: "Jeeth Kumar Suvarna" (MCA
    // website) becomes "Jeeth Suvarna", the name the site already knows him by.
    // A surname keeps its particles ("Quinton de Kock", "Inzamam ul Haq").
    // original: the printed name without role markers; dropped: the middle names.
    const SURNAME_PARTICLES = new Set(['de', 'da', 'di', 'du', 'del', 'della', 'der', 'den', 'van', 'von', 'la', 'le', 'st', 'st.', 'ul', 'ud', 'al', 'el', 'bin', 'ibn', 'abu', 'dos', 'do']);
    function normalizePlayerName(raw) {
        const original = playerName(raw);
        const cleaned = original.replace(/^[\s,.;:\-\u2013\u2014]+/, '').replace(/[\s,;:\-\u2013\u2014]+$/, '');
        const tokens = cleaned.split(' ').filter(Boolean);
        if (tokens.length <= 2) return { display: tokens.join(' '), original, dropped: [], changed: tokens.join(' ') !== original };
        let s = tokens.length - 1;
        while (s - 1 >= 1 && SURNAME_PARTICLES.has(tokens[s - 1].toLowerCase())) s--;
        // "M S Dhoni", "S K Yadav": initials are already short — keep them all
        if (tokens.slice(0, s).every(t => /^[A-Za-z]\.?$/.test(t))) return { display: tokens.join(' '), original, dropped: [], changed: tokens.join(' ') !== original };
        const dropped = tokens.slice(1, s);
        const display = [tokens[0], ...tokens.slice(s)].join(' ');
        return { display, original, dropped, changed: dropped.length > 0 };
    }
    const other = (side) => (side === 'A' ? 'B' : 'A');

    // "19.4" → 118 legal balls; null when unreadable; NaN when impossible ("3.6")
    function oversToBalls(overs) {
        if (overs === null || overs === undefined || overs === '') return null;
        const s = String(overs).trim().replace(',', '.');
        if (!/^\d{1,3}(\.\d)?$/.test(s)) return NaN;
        const [o, b] = s.split('.');
        const balls = b === undefined ? 0 : Number(b);
        if (balls >= BALLS_PER_OVER) return NaN;
        return Number(o) * BALLS_PER_OVER + balls;
    }
    function ballsToOvers(balls) {
        if (!isNum(balls) || balls < 0) return null;
        const o = Math.floor(balls / BALLS_PER_OVER), b = balls % BALLS_PER_OVER;
        return b ? `${o}.${b}` : `${o}`;
    }
    const oversText = (overs) => { const b = oversToBalls(overs); return isNum(b) ? ballsToOvers(b) : (overs == null ? null : String(overs)); };

    // A dismissal line as printed → what it means for the scorecard.
    //   wicket:        counts as a team wicket
    //   bowlerWicket:  credited to the bowler
    function parseDismissal(text) {
        const raw = cleanName(text);
        const t = raw.toLowerCase().replace(/[†*]/g, '').replace(/\s+/g, ' ').trim();
        const out = { text: raw, kind: 'unknown', bowler: null, fielder: null, wicket: true, bowlerWicket: false, notOut: false };
        const name = (s) => cleanName(String(s || '').replace(/^\(|\)$/g, '').replace(/[†*]/g, '').replace(/^sub\s*[:(]?\s*/i, '').replace(/\)$/, '')) || null;
        const keep = (re) => { const m = raw.replace(/[†*]/g, '').match(re); return m; };
        if (!t) { out.kind = 'unknown'; out.wicket = false; return out; }
        if (/^not out$/.test(t) || t === 'batting' || t === '*') { Object.assign(out, { kind: 'notout', wicket: false, notOut: true }); return out; }
        if (/^retired( hurt| ill| not out)?$/.test(t) && !/retired out/.test(t)) { Object.assign(out, { kind: 'retiredhurt', wicket: false, notOut: true }); return out; }
        if (/^retired out/.test(t)) { out.kind = 'retiredout'; return out; }
        if (/^absent( hurt)?/.test(t)) { Object.assign(out, { kind: 'absent', wicket: false, notOut: true }); return out; }
        if (/^did not bat|^dnb$|^yet to bat/.test(t)) { Object.assign(out, { kind: 'dnb', wicket: false, notOut: false }); return out; }
        let m;
        if ((m = keep(/^run\s*out\s*\(?\s*([^)]*?)\s*\)?$/i))) { out.kind = 'runout'; out.fielder = name(String(m[1]).split('/')[0]); return out; }
        if ((m = keep(/^c\s*(?:&|and)\s*b\s+(.+)$/i))) { Object.assign(out, { kind: 'caught', bowler: name(m[1]), fielder: name(m[1]), bowlerWicket: true }); return out; }
        if ((m = keep(/^c\s+(.+?)\s+b\s+(.+)$/i))) { Object.assign(out, { kind: 'caught', fielder: name(m[1]), bowler: name(m[2]), bowlerWicket: true }); return out; }
        if ((m = keep(/^st\s+(.+?)\s+b\s+(.+)$/i))) { Object.assign(out, { kind: 'stumped', fielder: name(m[1]), bowler: name(m[2]), bowlerWicket: true }); return out; }
        if ((m = keep(/^lbw\s+(?:b\s+)?(.+)$/i))) { Object.assign(out, { kind: 'lbw', bowler: name(m[1]), bowlerWicket: true }); return out; }
        if ((m = keep(/^hit\s*wicket\s+(?:b\s+)?(.+)$/i))) { Object.assign(out, { kind: 'hitwicket', bowler: name(m[1]), bowlerWicket: true }); return out; }
        if ((m = keep(/^b\s+(.+)$/i))) { Object.assign(out, { kind: 'bowled', bowler: name(m[1]), bowlerWicket: true }); return out; }
        if (/^c\s+/.test(t)) { out.kind = 'caught'; out.fielder = name(raw.replace(/^c\s+/i, '')); return out; } // bowler cut off
        if (/obstruct/.test(t)) { out.kind = 'obstructing'; return out; }
        if (/handled/.test(t)) { out.kind = 'handled'; return out; }
        if (/timed out/.test(t)) { out.kind = 'timedout'; return out; }
        if (/hit (the )?ball twice/.test(t)) { out.kind = 'hittwice'; return out; }
        out.kind = 'unknown';
        return out;
    }

    function extrasSum(e) {
        if (!e) return null;
        const parts = ['wides', 'noBalls', 'byes', 'legByes', 'penalty'].map(k => intOrNull(e[k]));
        return parts.every(v => v !== null) ? parts.reduce((a, b) => a + b, 0) : null;
    }
    function extrasTotal(e) {
        if (!e) return null;
        const t = intOrNull(e.total);
        return t !== null ? t : extrasSum(e);
    }

    // Everything the checks and the match record need, worked out once.
    function inningsFacts(inn) {
        const batting = (inn && inn.batting) || [];
        const bowling = (inn && inn.bowling) || [];
        const rows = batting.map(r => Object.assign({ row: r }, { d: parseDismissal(r.dismissal) }));
        const known = (k) => batting.every(r => intOrNull(r[k]) !== null);
        const sum = (list, k) => list.reduce((n, r) => n + (intOrNull(r[k]) || 0), 0);
        const bowlBalls = bowling.map(b => oversToBalls(b.overs));
        const total = (inn && inn.total) || {};
        return {
            batRuns: sum(batting, 'runs'), batRunsKnown: known('runs'),
            batBalls: sum(batting, 'balls'), batBallsKnown: batting.length > 0 && known('balls'),
            wicketsFromCard: rows.filter(x => x.d.wicket).length,
            bowlerCredited: rows.filter(x => x.d.bowlerWicket).length,
            bowlRuns: sum(bowling, 'runs'), bowlRunsKnown: bowling.every(b => intOrNull(b.runs) !== null),
            bowlWkts: sum(bowling, 'wickets'), bowlWktsKnown: bowling.every(b => intOrNull(b.wickets) !== null),
            bowlBalls: bowlBalls.reduce((n, b) => n + (isNum(b) ? b : 0), 0), bowlBallsKnown: bowling.length > 0 && bowlBalls.every(isNum),
            totalRuns: intOrNull(total.runs), totalWkts: intOrNull(total.wickets), totalBalls: oversToBalls(total.overs),
            extras: extrasTotal(inn && inn.extras), extrasSum: extrasSum(inn && inn.extras),
            rows
        };
    }

    // Who won, from the two innings (limited-overs: one innings each).
    // xi: players per side (wickets available = xi - 1).
    function computeResult(match, opts) {
        opts = opts || {};
        const inns = (match && match.innings) || [];
        const xi = opts.playersPerSide || 11;
        if (inns.length < 2) return { decided: false, reason: 'Both innings are needed for a result.' };
        const [a, b] = inns;
        const r1 = intOrNull(a.total && a.total.runs), r2 = intOrNull(b.total && b.total.runs);
        const w2 = intOrNull(b.total && b.total.wickets);
        if (r1 === null || r2 === null) return { decided: false, reason: 'Both innings totals are needed for a result.' };
        const s1 = a.battingSide, s2 = b.battingSide;
        if (r2 > r1) {
            const left = w2 === null ? null : Math.max(0, (xi - 1) - w2);
            return { decided: left !== null, winner: s2, byWickets: left, byRuns: null, reason: left === null ? 'Wickets lost in the chase are needed for the margin.' : null };
        }
        const b2balls = oversToBalls(b.total && b.total.overs);
        const quota = isNum(match.overs) && match.overs > 0 ? match.overs * BALLS_PER_OVER : null;
        const chaseOver = (w2 !== null && w2 >= xi - 1) || (b.total && b.total.allOut) || (quota !== null && isNum(b2balls) && b2balls >= quota);
        if (r2 === r1) {
            if (chaseOver) return { decided: true, winner: 'TIE', byRuns: null, byWickets: null };
            return { decided: false, reason: 'Scores are level but the chase was not finished — choose the result.' };
        }
        if (!chaseOver) return { decided: false, reason: 'The chase stopped short (rain, abandoned or not finished) — choose the result.' };
        return { decided: true, winner: s1, byRuns: r1 - r2, byWickets: null };
    }

    function resultText(res, teams) {
        if (!res || !res.winner) return '';
        if (res.winner === 'TIE') return 'MATCH TIED';
        if (res.winner === 'NR') return 'NO RESULT';
        const name = String(((teams && teams[res.winner]) || {}).name || (res.winner === 'A' ? 'Team A' : 'Team B')).toUpperCase();
        if (res.byRuns != null) return `${name} WON BY ${res.byRuns} RUN${res.byRuns === 1 ? '' : 'S'}`;
        if (res.byWickets != null) return `${name} WON BY ${res.byWickets} WICKET${res.byWickets === 1 ? '' : 'S'}`;
        return `${name} WON`;
    }

    // Every check the scorecard must pass. Each issue:
    //   { id, level: 'error' | 'warning', innings (0-based) | null, side, rowKey | null, table, field, photo, message, ack }
    // 'error' blocks saving unless ack is true (a genuine discrepancy in the
    // source scorecard that the person confirms, with a reason, on record).
    function validateMatch(match, opts) {
        opts = opts || {};
        const issues = [];
        const add = (level, id, message, extra) => issues.push(Object.assign({ id, level, message, innings: null, rowKey: null, table: null, field: null, photo: null, ack: level === 'warning' }, extra || {}));
        const teams = (match && match.teams) || {};
        const inns = (match && match.innings) || [];
        const xi = opts.playersPerSide || 11;
        const quotaBalls = isNum(match && match.overs) && match.overs > 0 ? match.overs * BALLS_PER_OVER : null;

        if (!cleanName(teams.A && teams.A.name) || !cleanName(teams.B && teams.B.name)) add('error', 'teams-missing', 'Both team names are needed.', { ack: false });
        else if (nameKey(teams.A.name) === nameKey(teams.B.name)) add('error', 'teams-same', 'The two teams have the same name.', { ack: false });
        if (inns.length !== 2) add('error', 'innings-count', `This match type needs two innings (one per team) — the scorecard has ${inns.length}.`, { ack: false });
        if (inns.length === 2 && inns[0].battingSide === inns[1].battingSide) add('error', 'innings-order', 'Both innings are marked as batted by the same team.', { ack: false });

        const seenTeamPlayers = { A: new Map(), B: new Map() };
        inns.forEach((inn, i) => {
            const side = inn.battingSide;
            const bowlSide = side ? other(side) : null;
            const label = `${(teams[side] && teams[side].name) || 'Innings ' + (i + 1)} innings`;
            const where = { innings: i, side };
            if (side !== 'A' && side !== 'B') { add('error', `inn${i}-side`, `Innings ${i + 1}: choose which team batted.`, Object.assign({ ack: false }, where)); return; }
            const f = inningsFacts(inn);
            const total = inn.total || {};

            // the total itself
            if (f.totalRuns === null) add('error', `inn${i}-total-runs`, `${label}: the total runs are missing.`, Object.assign({ ack: false, table: 'total', field: 'runs' }, where));
            if (f.totalWkts === null) add('error', `inn${i}-total-wkts`, `${label}: the wickets lost are missing.`, Object.assign({ ack: false, table: 'total', field: 'wickets' }, where));
            else if (f.totalWkts > xi - 1) add('error', `inn${i}-total-wkts-max`, `${label}: ${f.totalWkts} wickets — a side can lose at most ${xi - 1}.`, Object.assign({ ack: false, table: 'total', field: 'wickets' }, where));
            if (f.totalBalls === null) add('error', `inn${i}-total-overs`, `${label}: the overs faced are missing (needed for the run rate).`, Object.assign({ ack: false, table: 'total', field: 'overs' }, where));
            else if (!isNum(f.totalBalls)) add('error', `inn${i}-total-overs-bad`, `${label}: "${total.overs}" is not a valid overs figure (balls go 0–5).`, Object.assign({ ack: false, table: 'total', field: 'overs' }, where));
            else if (quotaBalls !== null && f.totalBalls > quotaBalls) add('error', `inn${i}-overs-quota`, `${label}: ${oversText(total.overs)} overs is more than the ${match.overs} overs of this format.`, Object.assign({ ack: true, table: 'total', field: 'overs' }, where));

            // batting rows
            if (!(inn.batting || []).length) add('error', `inn${i}-no-batting`, `${label}: no batters.`, Object.assign({ ack: false, table: 'batting' }, where));
            if ((inn.batting || []).length > xi + 1) add('warning', `inn${i}-many-batters`, `${label}: ${(inn.batting || []).length} batters — more than ${xi} (impact / concussion substitutes?).`, Object.assign({ table: 'batting' }, where));
            const batKeys = new Map();
            (inn.batting || []).forEach((r, k) => {
                const at = Object.assign({ table: 'batting', rowKey: r.key || null, photo: r.photo || null }, where);
                const nm = cleanName(r.name);
                if (!nm) { add('error', `inn${i}-bat${k}-name`, `${label}: batter ${k + 1} has no name.`, Object.assign({ ack: false, field: 'name' }, at)); return; }
                const nk = nameKey(nm);
                if (batKeys.has(nk)) add('error', `inn${i}-bat-dup-${nk}`, `${label}: "${nm}" is listed twice.`, Object.assign({ ack: false, field: 'name' }, at));
                batKeys.set(nk, true);
                seenTeamPlayers[side].set(nk, nm);
                const runs = intOrNull(r.runs), balls = intOrNull(r.balls), fours = intOrNull(r.fours), sixes = intOrNull(r.sixes);
                if (runs === null) add('error', `inn${i}-bat${k}-runs`, `${label}: ${nm}'s runs are missing.`, Object.assign({ ack: false, field: 'runs' }, at));
                if (balls === null) add('warning', `inn${i}-bat${k}-balls`, `${label}: ${nm}'s balls faced are not on the scorecard — strike rate will leave this innings out.`, Object.assign({ field: 'balls' }, at));
                if (runs !== null && fours !== null && sixes !== null && fours * 4 + sixes * 6 > runs) add('error', `inn${i}-bat${k}-boundaries`, `${label}: ${nm} has ${fours}×4 and ${sixes}×6 = ${fours * 4 + sixes * 6} runs in boundaries but only ${runs} runs.`, Object.assign({ ack: false, field: 'runs' }, at));
                if (runs !== null && balls !== null && isNum(Number(r.strikeRate)) && r.strikeRate !== null && r.strikeRate !== '' && balls > 0) {
                    const sr = runs * 100 / balls;
                    if (Math.abs(sr - Number(r.strikeRate)) > 1.01) add('warning', `inn${i}-bat${k}-sr`, `${label}: ${nm}'s printed strike rate ${r.strikeRate} does not match ${runs} runs off ${balls} balls (${sr.toFixed(2)}) — one of them was misread.`, Object.assign({ field: 'balls' }, at));
                }
                const d = parseDismissal(r.dismissal);
                if (!cleanName(r.dismissal)) add('warning', `inn${i}-bat${k}-howout`, `${label}: how was ${nm} out? (not out, caught, bowled…)`, Object.assign({ field: 'dismissal' }, at));
                else if (d.kind === 'unknown') add('warning', `inn${i}-bat${k}-howout-unknown`, `${label}: "${d.text}" is not a dismissal the scorecard understands — check ${nm}'s line.`, Object.assign({ field: 'dismissal' }, at));
                if (d.bowler && inn.bowling && inn.bowling.length && !inn.bowling.some(b => nameKey(b.name) === nameKey(d.bowler))) {
                    add('warning', `inn${i}-bat${k}-bowler`, `${label}: ${nm} was out to "${d.bowler}", who is not in the bowling figures.`, Object.assign({ field: 'dismissal' }, at));
                }
            });

            // bowling rows
            if (!(inn.bowling || []).length) add('error', `inn${i}-no-bowling`, `${label}: no bowling figures.`, Object.assign({ ack: false, table: 'bowling' }, where));
            const bowlKeys = new Map();
            (inn.bowling || []).forEach((b, k) => {
                const at = Object.assign({ table: 'bowling', rowKey: b.key || null, photo: b.photo || null }, where);
                const nm = cleanName(b.name);
                if (!nm) { add('error', `inn${i}-bowl${k}-name`, `${label}: bowler ${k + 1} has no name.`, Object.assign({ ack: false, field: 'name' }, at)); return; }
                const nk = nameKey(nm);
                if (bowlKeys.has(nk)) add('error', `inn${i}-bowl-dup-${nk}`, `${label}: bowler "${nm}" is listed twice.`, Object.assign({ ack: false, field: 'name' }, at));
                bowlKeys.set(nk, true);
                if (bowlSide) seenTeamPlayers[bowlSide].set(nk, nm);
                const balls = oversToBalls(b.overs);
                if (balls === null) add('error', `inn${i}-bowl${k}-overs`, `${label}: ${nm}'s overs are missing.`, Object.assign({ ack: false, field: 'overs' }, at));
                else if (!isNum(balls)) add('error', `inn${i}-bowl${k}-overs-bad`, `${label}: ${nm}'s overs "${b.overs}" are not valid (balls go 0–5).`, Object.assign({ ack: false, field: 'overs' }, at));
                if (intOrNull(b.runs) === null) add('error', `inn${i}-bowl${k}-runs`, `${label}: runs conceded by ${nm} are missing.`, Object.assign({ ack: false, field: 'runs' }, at));
                if (intOrNull(b.wickets) === null) add('error', `inn${i}-bowl${k}-wkts`, `${label}: ${nm}'s wickets are missing.`, Object.assign({ ack: false, field: 'wickets' }, at));
                if (intOrNull(b.maidens) === null) add('warning', `inn${i}-bowl${k}-maidens`, `${label}: ${nm}'s maidens are not on the scorecard — saved as unknown.`, Object.assign({ field: 'maidens' }, at));
                if (isNum(balls) && balls > 0 && intOrNull(b.runs) !== null && b.economy !== null && b.economy !== '' && isNum(Number(b.economy))) {
                    const eco = intOrNull(b.runs) * BALLS_PER_OVER / balls;
                    if (Math.abs(eco - Number(b.economy)) > 0.06) add('warning', `inn${i}-bowl${k}-eco`, `${label}: ${nm}'s printed economy ${b.economy} does not match ${b.runs} runs in ${ballsToOvers(balls)} overs (${eco.toFixed(2)}) — one of them was misread.`, Object.assign({ field: 'overs' }, at));
                }
                if (isNum(balls) && intOrNull(b.maidens) !== null && intOrNull(b.maidens) * BALLS_PER_OVER > balls) add('error', `inn${i}-bowl${k}-maidens-max`, `${label}: ${nm} has more maidens than overs.`, Object.assign({ ack: false, field: 'maidens' }, at));
            });

            // the innings adds up
            if (f.totalRuns !== null && f.batRunsKnown && f.extras !== null && f.batRuns + f.extras !== f.totalRuns) {
                add('error', `inn${i}-runs-sum`, `${label}: batters' runs ${f.batRuns} + extras ${f.extras} = ${f.batRuns + f.extras}, but the total says ${f.totalRuns}.`, Object.assign({ ack: true, table: 'total', field: 'runs' }, where));
            }
            if (f.extras === null) add('warning', `inn${i}-extras`, `${label}: extras are not on the scorecard.`, Object.assign({ table: 'extras', field: 'total' }, where));
            else if (f.extrasSum !== null && intOrNull(inn.extras && inn.extras.total) !== null && f.extrasSum !== intOrNull(inn.extras.total)) {
                add('error', `inn${i}-extras-sum`, `${label}: extras ${inn.extras.total} but wd + nb + b + lb + p = ${f.extrasSum}.`, Object.assign({ ack: true, table: 'extras', field: 'total' }, where));
            }
            if (f.totalWkts !== null && f.wicketsFromCard !== f.totalWkts) {
                add('error', `inn${i}-wkts-sum`, `${label}: ${f.wicketsFromCard} batter${f.wicketsFromCard === 1 ? ' is' : 's are'} out, but the total says ${f.totalWkts} wicket${f.totalWkts === 1 ? '' : 's'}.`, Object.assign({ ack: true, table: 'batting', field: 'dismissal' }, where));
            }
            if (isNum(f.totalBalls) && f.bowlBallsKnown && f.bowlBalls !== f.totalBalls) {
                add('error', `inn${i}-overs-sum`, `${label}: the bowlers bowled ${ballsToOvers(f.bowlBalls)} overs, but the innings lasted ${ballsToOvers(f.totalBalls)}.`, Object.assign({ ack: true, table: 'bowling', field: 'overs' }, where));
            }
            const e = inn.extras || {};
            const byes = intOrNull(e.byes), lb = intOrNull(e.legByes), pen = intOrNull(e.penalty);
            if (f.totalRuns !== null && f.bowlRunsKnown && byes !== null && lb !== null) {
                const expect = f.totalRuns - byes - lb - (pen || 0);
                if (f.bowlRuns !== expect) add('warning', `inn${i}-bowl-runs`, `${label}: the bowlers conceded ${f.bowlRuns}, but total − byes − leg byes${pen ? ' − penalty' : ''} = ${expect}.`, Object.assign({ table: 'bowling', field: 'runs' }, where));
            }
            if (f.bowlWktsKnown && f.bowlWkts !== f.bowlerCredited) {
                add('warning', `inn${i}-bowl-wkts`, `${label}: the bowlers took ${f.bowlWkts} wicket${f.bowlWkts === 1 ? '' : 's'}, but ${f.bowlerCredited} dismissal${f.bowlerCredited === 1 ? ' is' : 's are'} credited to a bowler (run outs are not).`, Object.assign({ table: 'bowling', field: 'wickets' }, where));
            }
            if (isNum(f.totalBalls) && f.batBallsKnown) {
                const nb = intOrNull(e.noBalls);
                if (f.batBalls < f.totalBalls || (nb !== null && f.batBalls > f.totalBalls + nb)) {
                    add('warning', `inn${i}-balls-faced`, `${label}: batters faced ${f.batBalls} balls in an innings of ${ballsToOvers(f.totalBalls)} overs (${f.totalBalls} legal balls${nb !== null ? ` + up to ${nb} no-balls` : ''}).`, Object.assign({ table: 'batting', field: 'balls' }, where));
                }
            }
        });

        // a player on both sides
        if (seenTeamPlayers.A.size && seenTeamPlayers.B.size) {
            for (const [k, nm] of seenTeamPlayers.A) if (seenTeamPlayers.B.has(k)) add('error', `both-sides-${k}`, `"${nm}" appears for both teams.`, { ack: false });
        }

        // the result
        const res = computeResult(match, opts);
        if (inns.length === 2) {
            const r1 = intOrNull(inns[0].total && inns[0].total.runs), r2 = intOrNull(inns[1].total && inns[1].total.runs);
            if (r1 !== null && r2 !== null && r2 > r1 + 6) add('warning', 'chase-overshoot', `The chase finished ${r2 - r1} runs past the target — a chase usually stops within one hit of it. Check both totals.`, { innings: 1, table: 'total', field: 'runs' });
            if (!res.decided && !(match.result && match.result.override)) add('error', 'result-undecided', res.reason || 'Choose the result.', { ack: false, table: 'result' });
        }
        return { issues, result: res };
    }

    // ---- photo reading → the working shape --------------------------------
    function levenshtein(a, b) {
        if (a === b) return 0;
        const m = a.length, n = b.length;
        if (!m || !n) return Math.max(m, n);
        let prev = Array.from({ length: n + 1 }, (_, j) => j);
        for (let i = 1; i <= m; i++) {
            const cur = [i];
            for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = cur;
        }
        return prev[n];
    }
    // How much a printed team name looks like one of the two teams (0..1).
    function teamLikeness(printed, name) {
        const a = nameKey(printed) || '', b = nameKey(name) || '';
        if (!a || !b) return 0;
        if (a === b) return 1;
        const squash = (s) => s.replace(/[^a-z0-9]/g, '');
        if (squash(a) === squash(b)) return 0.98;
        if (squash(b).startsWith(squash(a)) || squash(a).startsWith(squash(b))) return 0.9;
        const wa = a.split(/[^a-z0-9]+/).filter(Boolean), wb = b.split(/[^a-z0-9]+/).filter(Boolean);
        const ta = new Set(wa), tb = new Set(wb);
        const shared = [...ta].filter(t => tb.has(t)).length;
        const tok = shared / Math.max(ta.size, tb.size, 1);
        const lev = 1 - levenshtein(squash(a), squash(b)) / Math.max(squash(a).length, squash(b).length, 1);
        // "DY Patil SA" ~ "DY Patil Sports Academy": same leading words, the
        // rest written as initials
        let initials = 0, k = 0;
        while (k < wa.length && k < wb.length && wa[k] === wb[k]) k++;
        if (k > 0) {
            const ra = wa.slice(k), rb = wb.slice(k);
            const ini = (ws) => ws.map(w => w[0]).join('');
            if ((ra.length && ra.join('') === ini(rb)) || (rb.length && rb.join('') === ini(ra))) initials = 0.9;
        }
        return Math.max(tok * 0.95, lev, initials);
    }
    function sideForTeam(printed, teams) {
        const la = teamLikeness(printed, teams && teams.A && teams.A.name), lb = teamLikeness(printed, teams && teams.B && teams.B.name);
        if (Math.max(la, lb) < 0.6 || Math.abs(la - lb) < 0.15) return null;
        return la > lb ? 'A' : 'B';
    }
    let keySeq = 0;
    const rowKey = (p) => `${p}${Date.now().toString(36)}${(keySeq++).toString(36)}`;
    const conf = (c) => (c === 'high' || c === 'medium' || c === 'low' ? c : 'low');
    const list = (v) => (Array.isArray(v) ? v : []);
    function dedupeRows(rows, fields) {
        const out = [], seen = new Map();
        rows.forEach(r => {
            const k = nameKey(r.name);
            if (!k) { out.push(r); return; }
            const sig = fields.map(f => String(r[f])).join('|');
            if (seen.has(k) && seen.get(k) === sig) return; // the same row on two overlapping screenshots
            seen.set(k, sig);
            out.push(r);
        });
        return out;
    }

    // data: what the photo reader returned (SCORECARD_SCHEMA in
    // scorecard-extract.js, or the browser fallback's rows).
    // teams: { A: { name }, B: { name } }; slotSides: { 1: 'A'|'B', 2: … } —
    // the batting order the person gave the photos, used when a printed team
    // name cannot be matched.
    function fromExtraction(data, teams, slotSides) {
        const notes = list(data && data.notes).map(String);
        const inns = list(data && data.innings).slice().sort((x, y) => (Number(x.inningsNumber) || 0) - (Number(y.inningsNumber) || 0));
        const out = inns.slice(0, 2).map((inn, i) => {
            const n = Number(inn.inningsNumber) || i + 1;
            let side = sideForTeam(inn.battingTeam, teams);
            const slot = slotSides && (slotSides[n] || slotSides[i + 1]);
            if (!side && slot) side = slot;
            if (side && slot && side !== slot) notes.push(`Innings ${n}: the photo says "${inn.battingTeam}" batted, the photos were added under the other team — the photo's heading was used.`);
            const batting = dedupeRows(list(inn.batting).map(r => ({
                key: rowKey('b'), name: playerName(r.name), dismissal: r.dismissal == null ? null : cleanName(r.dismissal),
                runs: intOrNull(r.runs), balls: intOrNull(r.balls), fours: intOrNull(r.fours), sixes: intOrNull(r.sixes),
                strikeRate: isNum(r.strikeRate) ? r.strikeRate : null, captain: !!r.isCaptain || hasRole(r.name, 'c'), wk: !!r.isWicketKeeper || hasRole(r.name, 'wk'),
                photo: intOrNull(r.photo), confidence: conf(r.confidence), unclear: list(r.unclear).map(String)
            })).filter(r => r.name), ['runs', 'balls', 'dismissal']);
            const bowling = dedupeRows(list(inn.bowling).map(b => ({
                key: rowKey('w'), name: playerName(b.name), overs: b.overs == null ? null : String(b.overs).trim(),
                maidens: intOrNull(b.maidens), runs: intOrNull(b.runs), wickets: intOrNull(b.wickets),
                wides: intOrNull(b.wides), noBalls: intOrNull(b.noBalls), dots: intOrNull(b.dots),
                economy: isNum(b.economy) ? b.economy : null,
                photo: intOrNull(b.photo), confidence: conf(b.confidence), unclear: list(b.unclear).map(String)
            })).filter(b => b.name), ['overs', 'runs', 'wickets']);
            const e = inn.extras || {}, t = inn.total || {};
            return {
                battingSide: side || null,
                batting, bowling,
                didNotBat: list(inn.didNotBat).map(playerName).filter(Boolean),
                extras: { total: intOrNull(e.total), wides: intOrNull(e.wides), noBalls: intOrNull(e.noBalls), byes: intOrNull(e.byes), legByes: intOrNull(e.legByes), penalty: intOrNull(e.penalty) },
                total: { runs: intOrNull(t.runs), wickets: intOrNull(t.wickets), overs: t.overs == null ? null : String(t.overs).trim(), declared: !!t.declared, allOut: !!t.allOut },
                fallOfWickets: list(inn.fallOfWickets).map(w => ({ wicket: intOrNull(w.wicket), runs: intOrNull(w.runs), overs: w.overs == null ? null : String(w.overs), batter: w.batter == null ? null : playerName(w.batter) })).filter(w => w.runs !== null),
                sourcePhotos: list(inn.sourcePhotos).map(intOrNull).filter(v => v !== null),
                printedTeam: inn.battingTeam || null
            };
        });
        // two innings, two different teams: fill a missing side from the other
        if (out.length === 2) {
            if (!out[0].battingSide && out[1].battingSide) out[0].battingSide = other(out[1].battingSide);
            if (!out[1].battingSide && out[0].battingSide) out[1].battingSide = other(out[0].battingSide);
        }
        if (list(data && data.innings).length > 2) notes.push(`The photos show ${data.innings.length} innings — only the first two were read (one per team).`);
        const m = (data && data.match) || {};
        return {
            innings: out,
            printed: { teamNames: list(m.teamNames), resultText: m.resultText || null, tossText: m.tossText || null, venue: m.venue || null, date: m.date || null, format: m.format || null, oversPerInnings: intOrNull(m.oversPerInnings) },
            notes
        };
    }

    const api = {
        BALLS_PER_OVER, oversToBalls, ballsToOvers, oversText, parseDismissal, extrasSum, extrasTotal,
        inningsFacts, computeResult, resultText, validateMatch, cleanName, playerName, nameKey, intOrNull, normalizePlayerName,
        levenshtein, teamLikeness, sideForTeam, fromExtraction
    };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ScorecardModel = api;
})(typeof window !== 'undefined' ? window : this);
