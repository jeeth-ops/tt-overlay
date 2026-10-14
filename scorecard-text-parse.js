// 📷 Scorecard OCR text → batting / bowling rows (the fallback reader).
//
// When the server has no photo-reading key, the import page reads each photo
// in the browser with Tesseract.js (the same library the scoring panel's
// "Import Players" uses) and hands the raw text to parseScorecardText().
// Plain OCR text loses the table layout, so this only recognises rows that
// END in the usual columns (R B 4s 6s SR for batting; O M R W … Eco for
// bowling) plus the Extras / Total lines. Every value it returns is marked
// low-confidence: the person checks each row against the photo before
// anything is saved. Shared by scorecard-import.html and the tests.
(function (root) {
    'use strict';

    const NUM = String.raw`(\d{1,3})`;
    const DEC = String.raw`(\d{1,3}(?:[.,]\d{1,2})?)`;
    // name …  R  B  4s  6s  SR
    const BAT_RE = new RegExp(String.raw`^(.*?[A-Za-z].*?)\s+${NUM}\s+${NUM}\s+${NUM}\s+${NUM}\s+${DEC}\s*$`);
    // name …  O  M  R  W  [x  y  z …]  Eco      (CricHeroes may add 0s/4s/6s/WD/NB)
    const BOWL_RE = new RegExp(String.raw`^(.*?[A-Za-z].*?)\s+(\d{1,2}(?:[.,]\d)?)\s+${NUM}\s+${NUM}\s+${NUM}((?:\s+\d{1,3})*)\s+${DEC}\s*$`);
    const DISMISSAL_RE = /^(not out|run out\b.*|retired\b.*|c\s.+|b\s.+|lbw\b.*|st\s.+|hit wicket\b.*|obstruct.*|timed out\b.*|absent\b.*|handled\b.*|c&b\b.*|c\s*&\s*b\b.*)$/i;
    const HEADER_RE = /^(batter|batters|batsman|batsmen|batting|bowler|bowlers|bowling)\b/i;

    const cleanName = (s) => String(s || '')
        .replace(/[|[\]{}<>_~`"“”]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const roleOf = (name) => ({
        captain: /\((c|c\s*&\s*wk|wk\s*&\s*c)\)|\bcapt\b|\*/i.test(name),
        wk: /\((wk|c\s*&\s*wk|wk\s*&\s*c)\)|†/i.test(name)
    });
    const stripRoles = (name) => cleanName(String(name || '').replace(/\((?:c|wk|c\s*&\s*wk|wk\s*&\s*c)\)|[*†]/gi, ' '));
    const toInt = (s) => (s == null || s === '' ? null : parseInt(String(s), 10));
    const toDec = (s) => (s == null || s === '' ? null : Number(String(s).replace(',', '.')));

    function parseExtras(line) {
        const m = line.match(/^extras\b[^\d]*(\d{1,3})?\s*(?:\((.*)\))?/i);
        if (!m) return null;
        const out = { total: toInt(m[1]), wides: null, noBalls: null, byes: null, legByes: null, penalty: null };
        const inner = (m[2] || '').toLowerCase();
        const take = (re) => { const x = inner.match(re); return x ? toInt(x[1]) : null; };
        out.wides = take(/\bwd?\s*[:\-]?\s*(\d+)/);
        out.noBalls = take(/\bnb\s*[:\-]?\s*(\d+)/);
        out.legByes = take(/\blb\s*[:\-]?\s*(\d+)/);
        out.byes = take(/(?:^|[\s,(])b\s*[:\-]?\s*(\d+)/);
        out.penalty = take(/\bp(?:en)?\s*[:\-]?\s*(\d+)/);
        return out;
    }
    function parseTotal(line) {
        const m = line.match(/^total\b[^\d]*(\d{1,3})\s*(?:[\/\-]\s*(\d{1,2}))?\s*(?:\(?\s*(\d{1,3}(?:[.,]\d)?)\s*(?:ov|overs?)\b)?/i);
        if (!m) return null;
        return { runs: toInt(m[1]), wickets: m[2] != null ? toInt(m[2]) : null, overs: m[3] ? String(m[3]).replace(',', '.') : null, declared: /\bdec/i.test(line), allOut: /all\s*out/i.test(line) };
    }

    // text: the OCR text of one or more photos of ONE innings.
    function parseScorecardText(text, photoIndex) {
        const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
        const batting = [], bowling = [];
        let extras = null, total = null, mode = 'batting';
        // a bowling header ("Bowlers O M R W NB WD ECO") names the extra
        // columns between W and Eco, in the app's own order
        let bowlCols = [];
        const lowRow = (row) => Object.assign(row, { photo: photoIndex == null ? null : photoIndex, confidence: 'low', unclear: [] });
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^bowl(er|ers|ing)\b/i.test(line)) {
                mode = 'bowling';
                const cols = line.toLowerCase().split(/\s+/).slice(1);
                const w = cols.indexOf('w'), e = cols.findIndex(c => /^(eco|econ|economy|er)$/.test(c));
                bowlCols = w >= 0 && e > w ? cols.slice(w + 1, e) : [];
                continue;
            }
            if (/^bat(ter|ters|sman|smen|ting)\b/i.test(line)) { mode = 'batting'; continue; }
            if (/^extras\b/i.test(line)) { extras = parseExtras(line) || extras; continue; }
            if (/^total\b/i.test(line)) { total = parseTotal(line) || total; mode = 'bowling'; continue; }
            if (HEADER_RE.test(line)) continue;
            const bowl = mode === 'bowling' ? line.match(BOWL_RE) : null;
            if (bowl) {
                const name = stripRoles(bowl[1]);
                if (!name || name.length < 2) continue;
                const more = String(bowl[6] || '').trim().split(/\s+/).filter(Boolean).map(toInt);
                const col = (re) => { const i = bowlCols.findIndex(c => re.test(c)); return i >= 0 && more.length === bowlCols.length ? more[i] : null; };
                bowling.push(lowRow({ name, overs: String(bowl[2]).replace(',', '.'), maidens: toInt(bowl[3]), runs: toInt(bowl[4]), wickets: toInt(bowl[5]), wides: col(/^wd|^wides?$/), noBalls: col(/^nb|^no-?balls?$/), dots: col(/^0s$|^dots?$/), economy: toDec(bowl[7]) }));
                continue;
            }
            const bat = line.match(BAT_RE);
            if (bat && mode === 'batting') {
                const raw = bat[1];
                let name = raw, dismissal = null;
                // dismissal printed on the same line after the name ("Harsh Rane not out 116 …")
                const inline = raw.match(/^(.*?)\s+(not out|run out.*|retired.*|c\s.+|b\s.+|lbw.*|st\s.+)$/i);
                if (inline && /[A-Za-z]{2,}/.test(inline[1])) { name = inline[1]; dismissal = inline[2]; }
                // or on the next line
                if (!dismissal && lines[i + 1] && DISMISSAL_RE.test(lines[i + 1]) && !BAT_RE.test(lines[i + 1])) { dismissal = lines[i + 1]; i++; }
                const roles = roleOf(name);
                const clean = stripRoles(name);
                if (!clean || clean.length < 2) continue;
                batting.push(lowRow({ name: clean, dismissal: dismissal ? cleanName(dismissal) : null, runs: toInt(bat[2]), balls: toInt(bat[3]), fours: toInt(bat[4]), sixes: toInt(bat[5]), strikeRate: toDec(bat[6]), isCaptain: roles.captain, isWicketKeeper: roles.wk }));
            }
        }
        return { batting, bowling, extras, total };
    }

    const api = { parseScorecardText, parseExtras, parseTotal, stripRoles };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ScorecardTextParse = api;
})(typeof window !== 'undefined' ? window : this);
