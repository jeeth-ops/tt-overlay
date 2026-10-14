// 📷 Scorecard OCR text → batting / bowling rows (the fallback reader).
//
// When the server has no photo-reading key, the import page reads each photo
// in the browser with Tesseract.js (the same library the scoring panel's
// "Import Players" uses) and hands the raw text to parseScorecardText().
// Plain OCR text loses the table layout, so this works line by line:
//   - a table's header ("BATTERS R B SR 4'S 6'S MORE", "Batters R B 4s 6s SR",
//     "BOWLERS O M R W ECON 0'S 4'S 6'S WD NB") says which number is which;
//     without one, the usual orders are recognised (the strike rate is the
//     number with a decimal point)
//   - a row is a name, perhaps its dismissal, then its numbers (anything after
//     them — the MCA site's "+" — is ignored)
//   - a dismissal split over two lines (MCA website) is put back together
//   - Extras / Total / Fall of wickets / Did not bat lines, in the CricHeroes
//     and MCA website forms
//   - the usual OCR slips: "¢" for c, "Ibw" for lbw, "oul" for out, "o" for 0,
//     "17619" for 176/9 (a total whose word was lost too), "16471" for 164.71;
//     a figure read as something else ("3%") keeps its column, value unknown
//   - the printed rates check the figures: a strike rate gives back balls or
//     runs that were lost or lost a digit ("15 1 136.36" is 11 balls; "1 7"
//     read as 17), an economy gives back the runs or the overs' point ("50"
//     for 5.0) — only when exactly one reading agrees; otherwise the figures
//     stay as read (a misread rate must not "correct" figures that were right)
// Every value it returns is marked low-confidence: the person checks each row
// against the photo before anything is saved. Shared by scorecard-import.html
// and the tests.
(function (root) {
    'use strict';

    const cleanName = (s) => String(s || '')
        .replace(/[|[\]{}<>_~`"“”]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const ROLE_RE = /\(\s*(?:c|wk|c\s*&\s*wk|wk\s*&\s*c)\s*\)|[*†]/gi;
    const roleOf = (name) => ({
        captain: /\(\s*(c|c\s*&\s*wk|wk\s*&\s*c)\s*\)|\bcapt\b|\*/i.test(name),
        wk: /\(\s*(wk|c\s*&\s*wk|wk\s*&\s*c)\s*\)|†/i.test(name)
    });
    const stripRoles = (name) => cleanName(String(name || '').replace(ROLE_RE, ' '));
    const toInt = (s) => (s == null || s === '' ? null : parseInt(String(s), 10));
    const toDec = (s) => (s == null || s === '' ? null : Number(String(s).replace(',', '.')));

    // ---- OCR slips ----
    function fixLine(line) {
        return String(line || '')
            .replace(/[¢©]/g, 'c')
            .replace(/[‘’´`]/g, "'")
            .replace(/[“”]/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
    }
    // one table cell that should be a number ("o", "[o]", "1o" → 0, 0, 10)
    function numTok(t) {
        let s = String(t || '').replace(/^[[(]+|[\])]+$/g, '');
        if (s === '-' || s === '–' || s === '—') return { v: null, dash: true };
        if (/^[0-9oOQDlI|.,]+$/.test(s) && /[0-9oOQD]/.test(s)) {
            s = s.replace(/[oOQD]/g, '0').replace(/[lI|]/g, '1').replace(',', '.');
            if (/^\d{1,5}(\.\d{1,2})?$/.test(s)) return { v: s, dec: s.includes('.') };
        }
        // a figure read wrongly ("3%" for 35): it keeps its column, its value unknown
        if (s.length <= 6 && (s.match(/\d/g) || []).length * 2 >= s.length) return { v: null, bad: true };
        return null;
    }
    const JUNK_TAIL = /^([+>»›▸▶*•·|.,:;]+|more)$/i;
    // a line's trailing numbers (the table cells) and what comes before them
    function splitTail(line) {
        const toks = line.split(' ');
        let end = toks.length;
        while (end > 0 && JUNK_TAIL.test(toks[end - 1])) end--;
        const nums = [];
        let i = end - 1;
        for (; i >= 0; i--) {
            const n = numTok(toks[i]);
            if (!n) break;
            nums.unshift(n);
        }
        return { prefix: toks.slice(0, i + 1).join(' '), nums };
    }

    // ---- table headers ----
    function headerCols(line, kind) {
        const toks = line.toLowerCase().replace(/['’]/g, '').split(/\s+/).slice(1);
        const out = [];
        toks.forEach(t => {
            t = t.replace(/[^a-z0-9&/]/g, '');
            if (!t) return;
            if (kind === 'bowl' && t === 'om') { out.push('o', 'm'); return; }
            if (t === 'more') return;
            const map = kind === 'bat'
                ? { r: 'r', runs: 'r', b: 'b', balls: 'b', sr: 'sr', 's/r': 'sr', '4s': '4s', '4ss': '4s', fours: '4s', '6s': '6s', '&s': '6s', '6ss': '6s', sixes: '6s', m: 'mins', mins: 'mins', min: 'mins' }
                : { o: 'o', ov: 'o', overs: 'o', m: 'm', maidens: 'm', r: 'r', runs: 'r', w: 'w', wkts: 'w', wickets: 'w', econ: 'econ', eco: 'econ', er: 'econ', economy: 'econ', '0s': '0s', os: '0s', dots: '0s', '4s': '4s', '4ss': '4s', '6s': '6s', '&s': '6s', '6ss': '6s', wd: 'wd', wides: 'wd', nb: 'nb', noballs: 'nb' };
            if (map[t]) out.push(map[t]);
        });
        return out;
    }
    // the word may come after a stray icon read as text ("¥ BATTERS", "“y> BOWLERS")
    const headWord = (l, re) => { const t = l.split(' '); const i = t.slice(0, 3).findIndex(x => re.test(x)); return i >= 0 && splitTail(l).nums.length < 4 ? i : -1; };
    const isBatHeader = (l) => headWord(l, /^\W*(batter|batters|batsman|batsmen|batting)\b/i) >= 0;
    const isBowlHeader = (l) => headWord(l, /^\W*(bowler|bowlers|bowling)\b/i) >= 0;
    const fromHead = (l, re) => l.split(' ').slice(headWord(l, re)).join(' ');

    // ---- name | dismissal ----
    const DISMISS_START = /^(c|b|lbw|ibw|st|run|fun|not|ot|retired|absent|hit|obstructing|timed|handled|c&b)$/;
    const isCaps = (t) => /[A-Z]/.test(t) && !/[a-z]/.test(t);
    function fixDismissal(s) {
        let d = String(s || '').split(' ').filter(t => {
            const good = (t.match(/[A-Za-z0-9()&/.'-]/g) || []).length;
            return t && good / t.length >= 0.7;
        }).join(' ');
        d = d.replace(/^ibw\b/i, 'lbw').replace(/\b(run|not)\s+oul\b/gi, '$1 out').replace(/^fun out\b/i, 'run out').replace(/^ot out\b/i, 'not out');
        return d.trim() || null;
    }
    // a name's words, without the marks read around them ("PUNYARTH'", ";;.Hé\\](");
    // role marks — (C), (WK), * — stay
    const ROLE_TOK = /^(\(\s*(c|wk|c\s*&\s*wk|wk\s*&\s*c)\s*\)|[*†])$/i;
    function nameWords(s) {
        return String(s || '').replace(/\(\s*(?:c|wk|c\s*&\s*wk|wk\s*&\s*c)\s*\)/gi, (m) => ' ' + m + ' ').split(' ').filter(Boolean)
            .map(t => (ROLE_TOK.test(t) ? t : (t.match(/[A-Za-z]/g) || []).length * 2 < t.length ? '' : t.replace(/^[^A-Za-z]+|[^A-Za-z.*†]+$/g, '')))
            .filter(Boolean)
            .join(' ');
    }
    function splitNameDismissal(prefix) {
        const toks = prefix.replace(/^[^A-Za-z(]+/, '').split(' ').filter(Boolean);
        let k = -1;
        for (let i = 1; i < toks.length; i++) if (DISMISS_START.test(toks[i])) { k = i; break; }
        // MCA website: the name in capitals, then the dismissal (or its 2nd line)
        if (toks.length > 1 && isCaps(toks[0].replace(/\(.*\)/, ''))) {
            for (let i = 1; i < toks.length && (k < 0 || i < k); i++) if (!isCaps(toks[i].replace(/\(.*\)/, '')) && /[a-z]/.test(toks[i])) { k = i; break; }
        }
        const nameToks = (k < 0 ? toks : toks.slice(0, k)).slice();
        while (nameToks.length > 2 && /^[^(]$/.test(nameToks[nameToks.length - 1])) nameToks.pop();
        const name = nameWords(nameToks.join(' '));
        const rest = k < 0 ? '' : toks.slice(k).join(' ');
        return { name, rest };
    }

    function parseExtras(line) {
        if (!/^extras\b/i.test(line)) return null;
        const inner = ((line.match(/\(([^)]*)\)/) || [])[1] || '').toLowerCase()
            .replace(/\bib(?=[\s\d:o-]|$)/g, 'lb')
            .replace(/\b(wd|w|nb|lb|b|p|pen)\s*[:\-]?\s*o\b/g, (m, k) => k + ' 0');
        const outside = line.replace(/\([^)]*\)/, ' ');
        const tm = outside.match(/(\d{1,3})/);
        const out = { total: tm ? toInt(tm[1]) : null, wides: null, noBalls: null, byes: null, legByes: null, penalty: null };
        const take = (re) => { const x = inner.match(re); return x ? toInt(x[1]) : null; };
        out.wides = take(/\bwd?\s*[:\-]?\s*(\d+)/);
        out.noBalls = take(/\bnb\s*[:\-]?\s*(\d+)/);
        out.legByes = take(/\blb\s*[:\-]?\s*(\d+)/);
        out.byes = take(/(?:^|[\s,(])b\s*[:\-]?\s*(\d+)/);
        out.penalty = take(/\bp(?:en)?\s*[:\-]?\s*(\d+)/);
        return out;
    }
    // expectRuns: batters + extras, when known — picks the reading of a
    // score whose "/" was read as a digit ("17619" → 176/9)
    const BARE_TOTAL = /^\d[\d/\-|Il]*\s*\(\s*\d{1,3}(?:[.,]\d)?\s*(?:ov|overs?)\b[^A-Za-z]*$/i;
    function parseTotal(line, expectRuns) {
        const m = line.match(/^(total\b[^\d]*)?([\d][\d/\-|Il]*)\s*(?:\(?\s*(\d{1,3}(?:[.,]\d)?)\s*(?:ov|overs?)\b)?/i);
        if (!m || (!m[1] && !m[3])) return null;
        let runs = null, wickets = null;
        const sc = m[2];
        const sp = sc.match(/^(\d{1,3})\s*[/\-]\s*(\d{1,2})/);
        if (sp) { runs = toInt(sp[1]); wickets = toInt(sp[2]); }
        else {
            const digits = sc.replace(/[|Il]/g, '1').replace(/\D/g, '');
            const cands = [];
            if (digits.length <= 3) cands.push([toInt(digits), null]);
            for (let i = 2; i <= 3 && digits.length > 3; i++) {
                const sep = digits[i], w = digits.slice(i + 1);
                if (/[17]/.test(sep) && w.length >= 1 && w.length <= 2 && toInt(w) <= 10) cands.push([toInt(digits.slice(0, i)), toInt(w)]);
            }
            const best = cands.find(c => expectRuns != null && c[0] === expectRuns) || cands.sort((a, b) => b[0] - a[0])[0];
            if (best) { runs = best[0]; wickets = best[1]; }
        }
        return { runs, wickets, overs: m[3] ? String(m[3]).replace(',', '.') : null, declared: /\bdec/i.test(line), allOut: /all\s*out/i.test(line) };
    }
    function parseFow(line) {
        const out = [];
        const re = /(\d{1,2})\s*[-–]\s*(\d{1,3})\s*\(\s*([^,()]+?)\s*,\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*ov\s*\)/gi;
        let m;
        while ((m = re.exec(line))) out.push({ wicket: toInt(m[1]), runs: toInt(m[2]), overs: m[4].replace(',', '.'), batter: stripRoles(m[3]) });
        return out;
    }

    const BAT_DEFAULT = ['r', 'b', '4s', '6s', 'sr'];
    // a strike rate: has a point, or lost it (4–5 digits cannot be runs, balls, 4s or 6s)
    const isRate = (n) => !!n && !n.dash && !n.bad && (n.dec || n.v.length >= 4);
    const near = (x) => Math.abs(x - Math.round(x)) < 0.02;
    // read is what OCR made of want, one digit lost: "3" of 36, "1" of 11
    const lostDigit = (read, want) => { const a = String(read), b = String(want); if (b.length !== a.length + 1) return false; for (let i = 0; i < b.length; i++) if (b.slice(0, i) + b.slice(i + 1) === a) return true; return false; };
    const ballsOf = (o) => (/^\d{1,2}(\.[0-5])?$/.test(String(o || '')) ? Math.floor(Number(o)) * 6 + Math.round((Number(o) % 1) * 10) : 0);
    // "16471" in the strike-rate column is 164.71 (OCR dropped the point)
    const rate = (n) => { if (!n || n.dash || n.bad) return null; if (n.dec) return toDec(n.v); return n.v.length >= 3 && Number(n.v) > 999 ? toDec(n.v.slice(0, -2) + '.' + n.v.slice(-2)) : toDec(n.v); };
    // the numbers of a batting row, by the header's columns (or the usual orders)
    function batFigures(nums, cols) {
        let order = cols && cols.length ? cols : null;
        // a number lost or two run together: line the rest up on the strike rate
        if (order && order.length !== nums.length && order.includes('sr') && nums.filter(isRate).length === 1) {
            const at = nums.findIndex(isRate), si = order.indexOf('sr');
            const after = nums.length - at - 1;
            if (at <= si && after <= order.length - si - 1) order = order.slice(0, at).concat(order.slice(si, si + 1 + after));
        }
        if (!order || order.length !== nums.length) {
            if (nums.length >= 5 && (isRate(nums[2]) || nums[2].dash)) order = ['r', 'b', 'sr', '4s', '6s'];
            else if (nums.length >= 5) order = BAT_DEFAULT;
            else order = (cols && cols.filter(c => c !== 'sr' && c !== 'mins').length === nums.length) ? cols.filter(c => c !== 'sr' && c !== 'mins') : ['r', 'b', '4s', '6s'];
        }
        const f = {};
        order.forEach((c, i) => { if (nums[i]) f[c] = nums[i]; });
        const int = (c) => (f[c] && !f[c].dash && !f[c].dec ? toInt(f[c].v) : null);
        const out = { runs: int('r'), balls: int('b'), fours: int('4s'), sixes: int('6s'), strikeRate: rate(f.sr) };
        // "1 1" read as "11": more fours than the runs allow, and the 6s column empty
        if (out.sixes === null && !f['6s'] && cols && cols.includes('6s') && f['4s'] && /^\d\d$/.test(f['4s'].v || '') && out.runs !== null && out.fours * 4 > out.runs) {
            out.fours = toInt(f['4s'].v[0]); out.sixes = toInt(f['4s'].v[1]);
        }
        const sr = out.strikeRate;
        // runs and balls run together ("1 7" read as "17"): the one split the strike rate agrees with
        if (sr > 0 && out.balls === null && out.runs >= 10 && !near(out.runs * 100 / sr)) {
            const d = String(out.runs), fits = [];
            for (let i = 1; i < d.length; i++) {
                if (d[i] === '0' || (i > 1 && d[0] === '0')) continue;
                const r = toInt(d.slice(0, i)), b = toInt(d.slice(i));
                if (Math.abs(r * 100 / b - sr) < 0.011) fits.push([r, b]);
            }
            if (fits.length === 1) { out.runs = fits[0][0]; out.balls = fits[0][1]; }
        }
        // the strike rate checks the runs and balls (15 runs at 136.36 is 11 balls, not 1):
        // a figure missing, or out of step by a lost digit, is put right when only one reading fits
        if (sr > 0 && sr < 1000) {
            const b = out.runs ? out.runs * 100 / sr : null, r = out.balls ? sr * out.balls / 100 : null;
            const bFits = b !== null && b >= 1 && near(b), rFits = r !== null && r >= 1 && near(r);
            if (out.balls === null && bFits) out.balls = Math.round(b);
            else if (out.runs === null && rFits) out.runs = Math.round(r);
            else if (out.runs !== null && out.balls) {
                const ok = Math.abs(out.runs * 100 / out.balls - sr) < 0.011;
                if (!ok && bFits !== rFits) {
                    if (bFits && lostDigit(out.balls, Math.round(b))) out.balls = Math.round(b);
                    else if (rFits && lostDigit(out.runs, Math.round(r))) out.runs = Math.round(r);
                }
            }
        }
        return out;
    }
    function bowlFigures(nums, cols) {
        let order = cols && cols.length === nums.length ? cols : null;
        if (!order) {
            order = ['o', 'm', 'r', 'w'];
            const e = nums.findIndex((n, i) => i >= 4 && n.dec);
            for (let i = 4; i < nums.length; i++) order.push(i === e ? 'econ' : 'x' + i);
        }
        const f = {};
        order.forEach((c, i) => { if (nums[i]) f[c] = nums[i]; });
        const int = (c) => (f[c] && !f[c].dash && !f[c].dec ? toInt(f[c].v) : null);
        const out = { overs: f.o && f.o.v ? f.o.v : null, maidens: int('m'), runs: int('r'), wickets: int('w'), wides: int('wd'), noBalls: int('nb'), dots: int('0s'), economy: rate(f.econ) };
        // the economy checks the overs and runs
        const fits = (o) => { const b = ballsOf(o); return b > 0 && out.runs !== null && Math.abs(out.runs * 6 / b - out.economy) < 0.011; };
        if (out.economy > 0 && out.overs && !fits(out.overs)) {
            // the overs' point lost: "5.0" read as 50 (5 overs at 10.00 is 50 runs)
            const dotted = /^\d{2,3}$/.test(out.overs) ? out.overs.slice(0, -1) + '.' + out.overs.slice(-1) : null;
            if (dotted && fits(dotted)) out.overs = dotted;
            // overs that cannot be misread that way: the runs, when missing or a digit
            // short (4 overs at 9.00 is 36, not 3) — 38 at a misread 9.00 stays 38
            else if (/^\d(\.[0-5])?$|^\d\d\.[0-5]$/.test(out.overs)) {
                const r = out.economy * ballsOf(out.overs) / 6;
                if (near(r) && (out.runs === null || lostDigit(out.runs, Math.round(r)))) out.runs = Math.round(r);
            }
        }
        return out;
    }

    // text: the OCR text of one photo of ONE innings. state: what the
    // previous photo of the same innings ended in (a table continued on the
    // next screenshot has no header of its own) — pass the returned state on.
    function parseScorecardText(text, photoIndex, state) {
        const lines = String(text || '').split(/\r?\n/).map(fixLine).filter(Boolean)
            .reduce((out, l) => { const k = out.length - 1; if (k >= 0 && /^\(/.test(l) && /\d{1,2}\s*[-–]\s*\d{1,3}\s*$/.test(out[k]) && /\bov\b/i.test(l)) out[k] += ' ' + l; else out.push(l); return out; }, []);
        const batting = [], bowling = [], fallOfWickets = [], didNotBat = [];
        let extras = null, total = null;
        const st = Object.assign({ mode: 'batting', batCols: null, bowlCols: null }, state || {});
        const lowRow = (row) => Object.assign(row, { photo: photoIndex == null ? null : photoIndex, confidence: 'low', unclear: [] });
        let pendingHead = null;      // a dismissal's first line, printed above its row
        let last = null;             // the last batting row (for a dismissal's 2nd line)
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (isBowlHeader(line)) { st.mode = 'bowling'; st.bowlCols = headerCols(fromHead(line, /^\W*(bowler|bowlers|bowling)\b/i), 'bowl'); last = null; continue; }
            if (isBatHeader(line)) { st.mode = 'batting'; st.batCols = headerCols(fromHead(line, /^\W*(batter|batters|batsman|batsmen|batting)\b/i), 'bat'); last = null; continue; }
            if (/^extras\b/i.test(line)) { extras = parseExtras(line) || extras; last = null; continue; }
            if (/^total\b/i.test(line) || BARE_TOTAL.test(line)) {
                const known = batting.length && batting.every(r => r.runs !== null) && extras && extras.total !== null ? batting.reduce((n, r) => n + r.runs, 0) + extras.total : null;
                total = parseTotal(line, known) || total; last = null; st.mode = 'bowling'; continue;
            }
            const fow = parseFow(line);
            if (fow.length) { fow.forEach(w => fallOfWickets.push(w)); last = null; continue; }
            if (/^(fall of wickets|fow)\b/i.test(line)) { last = null; continue; }
            const dnb = line.match(/^(did not bat|yet to bat)\s*[:\-]?\s*(.*)$/i);
            if (dnb) { dnb[2].split(',').map(stripRoles).filter(n => n.length > 1).forEach(n => didNotBat.push(n)); last = null; continue; }

            const { prefix, nums } = splitTail(line);
            const hasLetters = /[A-Za-z]{2,}/.test(prefix);
            if ((st.mode === 'bowling' || nums.length >= 8) && hasLetters && nums.length >= 4 && /^\d{1,2}(\.\d)?$/.test(nums[0].v || '')) {
                const name = stripRoles(prefix.replace(/^[^A-Za-z(]+/, ''));
                if (name.length >= 2) bowling.push(lowRow(Object.assign({ name }, bowlFigures(nums, st.bowlCols))));
                continue;
            }
            if (st.mode === 'batting' && hasLetters && nums.length >= 4) {
                const sp = splitNameDismissal(prefix);
                let dismissal = sp.rest ? sp.rest : null;
                const firstTok = dismissal ? dismissal.split(' ')[0] : '';
                if (pendingHead && (!dismissal || !DISMISS_START.test(firstTok))) dismissal = pendingHead + (dismissal ? ' ' + dismissal : '');
                pendingHead = null;
                // CricHeroes: the dismissal on the line under the row
                if (!dismissal && lines[i + 1] && DISMISS_START.test(lines[i + 1].split(' ')[0]) && splitTail(lines[i + 1]).nums.length < 4) { dismissal = lines[i + 1]; i++; }
                const roles = roleOf(sp.name);
                const name = stripRoles(sp.name);
                if (!name || name.length < 2) continue;
                const row = lowRow(Object.assign({ name, dismissal: fixDismissal(dismissal) }, batFigures(nums, st.batCols), { isCaptain: roles.captain, isWicketKeeper: roles.wk }));
                batting.push(row);
                last = row;
                continue;
            }
            // a line of words only: a dismissal's first or second line (MCA website)
            if (st.mode === 'batting' && !/\d/.test(line) && hasLetters) {
                const first = line.split(' ')[0];
                if (DISMISS_START.test(first) || /^c&b$/i.test(first)) { pendingHead = line; continue; }
                if (last && last.dismissal && /(^|\s)b(\s+\S+)?$/.test(last.dismissal) && line.split(' ').length <= 4) {
                    last.dismissal = fixDismissal(last.dismissal + ' ' + line);
                    last = null;
                }
            }
        }
        return { batting, bowling, extras, total, fallOfWickets, didNotBat, state: st };
    }

    const api = { parseScorecardText, parseExtras, parseTotal, parseFow, stripRoles, splitNameDismissal };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ScorecardTextParse = api;
})(typeof window !== 'undefined' ? window : this);
