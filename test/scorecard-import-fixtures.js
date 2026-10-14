// Shared by the scorecard import tests (engine, HTTP, Chromium): one
// tournament with two teams and a played match, another tournament with a
// player of the same name in a different team, real PNG photos, and what
// the photo reader (Claude) "reads" from them.
const zlib = require('zlib');
const F = require('./merge-fixtures.js');
const { P, USERS } = F;

const W = USERS.work.uid;
const OWNER = { email: USERS.owner.email, uid: USERS.owner.uid };
const LEAGUE = 'mca cup';
// a 1×1 PNG logo (the tournament's own team list keeps small logos only)
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// A real PNG (4×6 pixels): `seed` makes each one different.
function png(seed, w, h) {
    w = w || 4; h = h || 6;
    const crc32 = (buf) => {
        let crc = 0xffffffff;
        for (let n = 0; n < buf.length; n++) {
            let c = (crc ^ buf[n]) & 0xff;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crc = (crc >>> 8) ^ c;
        }
        return (crc ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const row = 1 + w * 3;
    const raw = Buffer.alloc(h * row);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        raw[y * row + 1 + x * 3] = (seed * 37 + x) & 255;
        raw[y * row + 2 + x * 3] = (seed * 91 + y) & 255;
        raw[y * row + 3 + x * 3] = (seed * 13) & 255;
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const team = (name, short, players, extra) => Object.assign({ name, short, teamId: null, players, bowlers: players.slice(-2) }, extra || {});
const DYP = () => team('DY PATIL SA', 'DYP', [P('Jeeth Suvarna', 'PLAYER_A'), P('HARSH RANE', 'p-harsh'), P('ATHARVA KALE', 'p-ath'), P('ALIM SHAIKH', 'p-alim'), P('SURAJ SHINDE', 'p-suraj')]);
const PSC = () => team('PAREL SPORTING CLUB', 'PSC', [P('ROHIT SHUKLA', 'p-rohit'), P('GARV JAIN', 'p-garv'), P('JAI CHOUGULE', 'p-jai'), P('VEER M', 'p-veer'), P('OM K', 'p-omk')]);
const THANE = () => team('THANE CC', 'TCC', [P('SURAJ PATIL', 'p-surajp'), P('KIRAN RAO', 'p-kiran'), P('AMIT JOSHI', 'p-amit')]);
const VASHI = () => team('VASHI XI', 'VXI', [P('NEEL SHAH', 'p-neel'), P('DEV IYER', 'p-dev'), P('RAJ NAIR', 'p-raj')]);

async function seed(c, opts) {
    opts = opts || {};
    for (const t of [DYP(), PSC(), THANE(), VASHI()]) for (const p of t.players) await F.addProfile(c, W, p.id, p.name);
    await F.addLeague(c, {
        ownerUid: W, leagueKey: LEAGUE, name: 'MCA CUP', token: 'tokM',
        info: { format: 'Custom', overs: 10, venue: 'DY Patil Ground', teams: [{ name: 'DY PATIL SA', short: 'DYP', color: '#1d4ed8', logoUrl: LOGO, teamId: null }, { name: 'PAREL SPORTING CLUB', short: 'PSC', color: '#b91c1c', logoUrl: '', teamId: null }] }
    });
    await F.addMatch(c, { ownerUid: W, leagueKey: LEAGUE, matchId: 'm1', roomId: 'r1', teamA: DYP(), teamB: PSC(), seed: 0, date: '2026-10-10', overs: 3 });
    await F.addLeague(c, { ownerUid: W, leagueKey: 'thane league', name: 'THANE LEAGUE', token: 'tokT' });
    await F.addMatch(c, { ownerUid: W, leagueKey: 'thane league', matchId: 't1', roomId: 'rt1', teamA: THANE(), teamB: VASHI(), seed: 3, date: '2026-09-20', overs: 3 });
    if (opts.extra) await opts.extra(c);
}

const row = (name, dismissal, runs, balls, fours, sixes, extra) => Object.assign({ name, dismissal, runs, balls, fours, sixes, strikeRate: balls ? Math.round(runs * 10000 / balls) / 100 : null, isCaptain: false, isWicketKeeper: false, photo: 1, confidence: 'high', unclear: [] }, extra || {});
const bowl = (name, overs, maidens, runs, wickets, extra) => Object.assign({ name, overs, maidens, runs, wickets, wides: null, noBalls: null, dots: null, economy: Math.round(runs * 600 / (Number(overs) * 6)) / 100, photo: 2, confidence: 'high', unclear: [] }, extra || {});
// DY PATIL SA 110/1 (10) beat PAREL SPORTING CLUB 85/2 (10) by 25 runs.
// Names as the MCA website prints them (full names, role markers).
function scorecard() {
    return {
        match: { teamNames: ['DY Patil SA', 'Parel Sporting Club'], resultText: 'DY Patil SA won by 25 runs', tossText: 'Parel Sporting Club won the toss and chose to field', venue: 'DY Patil Ground', date: '12 Oct 2026', format: null, oversPerInnings: 10 },
        innings: [
            {
                inningsNumber: 1, battingTeam: 'DY Patil SA',
                batting: [
                    row('Jeeth Kumar Suvarna (c)', 'c Rohit Shukla b Garv Jain', 40, 34, 4, 1, { isCaptain: true }),
                    row('Harsh Rajesh Rane', 'not out', 60, 26, 6, 2, { confidence: 'medium', unclear: ['balls'] }),
                    row('Suraj Patil', 'not out', 0, 0, 0, 0, { strikeRate: null })
                ],
                didNotBat: ['Atharva Kale', 'Alim Shaikh', 'Suraj Shinde', 'Aarav Desai'],
                bowling: [bowl('Garv Jain', '5', 0, 50, 1, { wides: 2, noBalls: 0 }), bowl('Rohit Shukla', '5', null, 54, 0, { confidence: 'low', unclear: ['maidens'] })],
                extras: { total: 10, wides: 4, noBalls: 0, byes: 2, legByes: 4, penalty: 0 },
                total: { runs: 110, wickets: 1, overs: '10.0', declared: false, allOut: false },
                fallOfWickets: [{ wicket: 1, runs: 52, overs: '5.4', batter: 'Jeeth Kumar Suvarna' }],
                sourcePhotos: [1, 2]
            },
            {
                inningsNumber: 2, battingTeam: 'Parel Sporting Club',
                batting: [
                    row('Rohit Shukla', 'b Alim Shaikh', 50, 30, 5, 2, { photo: 3 }),
                    row('Garv Jain', 'run out (Harsh Rane)', 30, 30, 2, 1, { photo: 3 })
                ],
                didNotBat: ['Jai Chougule', 'Veer M', 'Om K'],
                bowling: [bowl('Alim Shaikh', '5', 0, 45, 1, { photo: 3 }), bowl('Jeeth Suvarna', '5', 0, 36, 0, { photo: 3 })],
                extras: { total: 5, wides: 1, noBalls: 0, byes: 4, legByes: 0, penalty: 0 },
                total: { runs: 85, wickets: 2, overs: '10.0', declared: false, allOut: false },
                fallOfWickets: [],
                sourcePhotos: [3]
            }
        ],
        notes: ['Photo 2 is cut off at the bottom; the last bowler row was read from photo 1.']
    };
}
function commentary() {
    return {
        entries: [
            { label: '0.1', marker: '1', bowler: 'Garv Jain', batter: 'Jeeth Kumar Suvarna', text: 'pushed to cover for one', photo: 1, confidence: 'high' },
            { label: '0.2', marker: '4', bowler: 'Garv Jain', batter: 'Harsh Rajesh Rane', text: 'FOUR! driven through the covers', photo: 1, confidence: 'high' },
            { label: '0.3', marker: '1wd', bowler: 'Garv Jain', batter: 'Harsh Rajesh Rane', text: 'wide down the leg side', photo: 1, confidence: 'high' },
            { label: '0.3', marker: '6', bowler: 'Garv Jain', batter: 'Harsh Rajesh Rane', text: 'SIX! over long-on', photo: 2, confidence: 'high' },
            // the same ball again on the next (overlapping) screenshot
            { label: '0.3', marker: '6', bowler: 'Garv Jain', batter: 'Harsh Rajesh Rane', text: 'SIX! over long-on', photo: 2, confidence: 'high' }
        ],
        overSummaries: [],
        notes: ['Only the first over is in the photos.']
    };
}
// what the fake Anthropic API answers (test/fake-anthropic.js)
function fakeClaude(body) {
    const sys = String((body && body.system) || '');
    if (/ball-by-ball/i.test(sys)) return { json: commentary() };
    return { json: scorecard() };
}

module.exports = { W, OWNER, LEAGUE, LOGO, png, seed, scorecard, commentary, fakeClaude, DYP, PSC, THANE, VASHI };
