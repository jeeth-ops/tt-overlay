// 📷 Scorecard import — the cricket rules (scorecard-model.js) and the
// browser's OCR text reader (scorecard-text-parse.js). Pure functions: the
// same file runs in the import page (live checks while figures are typed)
// and on the server (the checks again before anything is saved).
//
//   overs ↔ balls, dismissal lines, FIRST + LAST names
//   the result from two totals (defended, chased, tied, chase cut short)
//   every check on an innings: totals, sums, overs, wickets, boundaries,
//   strike rate / economy as printed, a player on both sides, over quota
//   photo reading → the working shape (sides from printed names, slots,
//   overlapping screenshots read once)
//   OCR text → rows (fallback reader): the CricHeroes and MCA website
//   layouts, Tesseract's usual slips, figures put right by the printed rates
//
// Run:  node test/scorecard-model.test.js
const M = require('../scorecard-model.js');
const T = require('../scorecard-text-parse.js');

const fails = [];
let passes = 0;
const check = (ok, msg) => { if (ok) passes++; else fails.push(msg); console.log(`  ${ok ? '✓' : '✗'} ${msg}`); };
const section = (t) => console.log('\n' + t);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

section('overs and balls');
check(M.oversToBalls('19.4') === 118, '"19.4" is 118 balls');
check(M.oversToBalls('20') === 120 && M.oversToBalls(20) === 120, '"20" and 20 are 120 balls');
check(M.oversToBalls('0.5') === 5, '"0.5" is 5 balls');
check(Number.isNaN(M.oversToBalls('3.6')), '"3.6" is impossible (balls go 0–5)');
check(Number.isNaN(M.oversToBalls('abc')), 'text is not overs');
check(M.oversToBalls(null) === null && M.oversToBalls('') === null, 'missing overs stay unknown (null), never 0');
check(M.oversToBalls('4,2') === 26, 'a decimal comma reads as a point');
check(M.ballsToOvers(118) === '19.4' && M.ballsToOvers(120) === '20', 'balls back to overs');
check(M.oversText('10.0') === '10', 'overs text is tidy');

section('dismissal lines');
const d = (s) => M.parseDismissal(s);
check(d('not out').kind === 'notout' && !d('not out').wicket, 'not out — no wicket');
check(d('c Rohit Shukla b Garv Jain').kind === 'caught' && d('c Rohit Shukla b Garv Jain').fielder === 'Rohit Shukla' && d('c Rohit Shukla b Garv Jain').bowler === 'Garv Jain' && d('c Rohit Shukla b Garv Jain').bowlerWicket, 'caught: fielder, bowler, credited to the bowler');
check(d('c & b Garv Jain').kind === 'caught' && d('c & b Garv Jain').bowler === 'Garv Jain' && d('c & b Garv Jain').fielder === 'Garv Jain', 'c & b');
check(d('c †Om K b Garv Jain').fielder === 'Om K', 'caught behind (†) — the keeper is the fielder');
check(d('b Alim Shaikh').kind === 'bowled' && d('b Alim Shaikh').bowlerWicket, 'bowled');
check(d('lbw b Alim Shaikh').kind === 'lbw' && d('lbw b Alim Shaikh').bowler === 'Alim Shaikh', 'lbw');
check(d('st Om K b Veer M').kind === 'stumped' && d('st Om K b Veer M').fielder === 'Om K', 'stumped');
check(d('run out (Harsh Rane)').kind === 'runout' && d('run out (Harsh Rane)').fielder === 'Harsh Rane' && !d('run out (Harsh Rane)').bowlerWicket && d('run out (Harsh Rane)').wicket, 'run out: a wicket, not the bowler\'s');
check(d('run out (Harsh Rane/Om K)').fielder === 'Harsh Rane', 'run out with two fielders: the first');
check(d('hit wicket b Garv Jain').kind === 'hitwicket' && d('hit wicket b Garv Jain').bowlerWicket, 'hit wicket');
check(d('retired hurt').kind === 'retiredhurt' && !d('retired hurt').wicket, 'retired hurt — not a wicket');
check(d('retired out').kind === 'retiredout' && d('retired out').wicket && !d('retired out').bowlerWicket, 'retired out — a wicket, not the bowler\'s');
check(d('absent hurt').kind === 'absent' && !d('absent hurt').wicket, 'absent hurt');
check(d('obstructing the field').kind === 'obstructing' && d('timed out').kind === 'timedout' && d('handled the ball').kind === 'handled', 'rare dismissals');
check(d('gone fishing').kind === 'unknown', 'anything else is "unknown" (flagged for the person)');
check(d('').kind === 'unknown' && !d('').wicket, 'no line at all: unknown, not a wicket');

section('names: FIRST + LAST');
const n = (s) => M.normalizePlayerName(s);
check(n('Jeeth Kumar Suvarna').display === 'Jeeth Suvarna' && eq(n('Jeeth Kumar Suvarna').dropped, ['Kumar']) && n('Jeeth Kumar Suvarna').original === 'Jeeth Kumar Suvarna', '"Jeeth Kumar Suvarna" → "Jeeth Suvarna", the printed name kept');
check(n('Rohit Gurunath Sharma').display === 'Rohit Sharma', 'one middle name dropped');
check(n('Mohammed Abdul Rahim Khan').display === 'Mohammed Khan', 'several middle names dropped');
check(n('Quinton de Kock').display === 'Quinton de Kock' && n('Inzamam ul Haq').display === 'Inzamam ul Haq', 'a surname keeps its particles (de Kock, ul Haq)');
check(n('Abraham Benjamin de Villiers').display === 'Abraham de Villiers', 'particles stay with the surname when a middle name goes');
check(n('M S Dhoni').display === 'M S Dhoni' && n('S. K. Yadav').display === 'S. K. Yadav', 'initials are kept as they are');
check(n('Harsh Rane (c)').display === 'Harsh Rane' && n('Om K (wk)').display === 'Om K' && n('Garv Jain*').display === 'Garv Jain' && n('Om K†').display === 'Om K', 'role markers are not part of a name');
check(n('Jeeth').display === 'Jeeth' && n('Jeeth Suvarna').display === 'Jeeth Suvarna', 'one or two names are left alone');
check(M.hasOwnProperty('normalizePlayerName') && require('../scorecard-import.js').normalizePlayerName === M.normalizePlayerName, 'the engine and the page use the same rule');

section('the result from the two totals');
const inn = (side, runs, wkts, overs, extra) => Object.assign({ battingSide: side, batting: [], bowling: [], total: { runs, wickets: wkts, overs } }, extra || {});
const match = (a, b, overs) => ({ teams: { A: { name: 'DYP' }, B: { name: 'PSC' } }, overs: overs === undefined ? 20 : overs, innings: [a, b] });
let r = M.computeResult(match(inn('A', 168, 7, '20'), inn('B', 140, 9, '20')));
check(r.decided && r.winner === 'A' && r.byRuns === 28, 'defended: won by 28 runs');
r = M.computeResult(match(inn('A', 120, 7, '20'), inn('B', 121, 4, '17.2')));
check(r.decided && r.winner === 'B' && r.byWickets === 6, 'chased: won by 6 wickets');
r = M.computeResult(match(inn('A', 150, 7, '20'), inn('B', 150, 9, '20')));
check(r.decided && r.winner === 'TIE', 'level after the full chase: tie');
r = M.computeResult(match(inn('A', 150, 7, '20'), inn('B', 150, 4, '15.2')));
check(!r.decided && /choose the result/i.test(r.reason), 'level but the chase not over: the person decides');
r = M.computeResult(match(inn('A', 150, 7, '20'), inn('B', 90, 3, '12')));
check(!r.decided && /stopped short/i.test(r.reason), 'a chase cut short (rain): not decided from the scores');
r = M.computeResult(match(inn('A', 150, 7, '20'), inn('B', 90, 10, '12', { total: { runs: 90, wickets: 10, overs: '12', allOut: true } })));
check(r.decided && r.winner === 'A' && r.byRuns === 60, 'bowled out: the side batting first wins');
r = M.computeResult(match(inn('A', 150, 7, '20'), inn('B', 151, null, '18')));
check(!r.decided && r.winner === 'B', 'a chase without its wickets has no margin yet');
check(M.resultText({ winner: 'A', byRuns: 1 }, { A: { name: 'Dy Patil' } }) === 'DY PATIL WON BY 1 RUN', 'one run, singular');

section('checks on a scorecard');
const bat = (name, dismissal, runs, balls, fours, sixes, extra) => Object.assign({ key: 'k' + name.replace(/\W/g, ''), name, dismissal, runs, balls, fours, sixes }, extra || {});
const bwl = (name, overs, maidens, runs, wickets, extra) => Object.assign({ key: 'w' + name.replace(/\W/g, ''), name, overs, maidens, runs, wickets }, extra || {});
function good() {
    return {
        teams: { A: { name: 'DY PATIL SA' }, B: { name: 'PAREL SC' } }, overs: 10,
        innings: [
            { battingSide: 'A', batting: [bat('Jeeth Suvarna', 'c Rohit Shukla b Garv Jain', 40, 34, 4, 1), bat('Harsh Rane', 'not out', 60, 26, 6, 2)], bowling: [bwl('Garv Jain', '5', 0, 50, 1), bwl('Rohit Shukla', '5', 0, 54, 0)], extras: { total: 10, wides: 4, noBalls: 0, byes: 2, legByes: 4, penalty: 0 }, total: { runs: 110, wickets: 1, overs: '10' } },
            { battingSide: 'B', batting: [bat('Rohit Shukla', 'b Alim Shaikh', 50, 30, 5, 2), bat('Garv Jain', 'run out (Harsh Rane)', 30, 30, 2, 1)], bowling: [bwl('Alim Shaikh', '5', 0, 45, 1), bwl('Jeeth Suvarna', '5', 0, 36, 0)], extras: { total: 5, wides: 1, noBalls: 0, byes: 4, legByes: 0, penalty: 0 }, total: { runs: 85, wickets: 2, overs: '10' } }
        ]
    };
}
const ids = (v) => v.issues.map(i => i.id);
const errs = (v) => v.issues.filter(i => i.level === 'error');
let v = M.validateMatch(good());
check(!errs(v).length && v.result.decided && v.result.winner === 'A' && v.result.byRuns === 25, 'a scorecard that adds up: no errors, DY PATIL SA won by 25 runs');
check(!v.issues.length, '…and nothing to double-check either');
let m = good(); m.innings[0].batting[1].runs = 66;
v = M.validateMatch(m);
check(ids(v).includes('inn0-runs-sum') && errs(v).find(i => i.id === 'inn0-runs-sum').ack === true, 'batters + extras ≠ total: an error the person may confirm as printed');
m = good(); m.innings[0].total.runs = null;
v = M.validateMatch(m);
check(ids(v).includes('inn0-total-runs') && errs(v).find(i => i.id === 'inn0-total-runs').ack === false, 'a missing total must be filled in (cannot be waved through)');
m = good(); m.innings[0].total.wickets = 2;
v = M.validateMatch(m);
check(ids(v).includes('inn0-wkts-sum'), 'batters out ≠ wickets in the total');
m = good(); m.innings[0].total.overs = '9.6';
v = M.validateMatch(m);
check(ids(v).includes('inn0-total-overs-bad'), '"9.6" overs is refused');
m = good(); m.innings[0].bowling[0].overs = '4';
v = M.validateMatch(m);
check(ids(v).includes('inn0-overs-sum'), 'bowlers\' overs ≠ the innings\' overs');
m = good(); m.innings[0].batting[0].fours = 12;
v = M.validateMatch(m);
check(ids(v).some(x => /bat0-boundaries/.test(x)), '12 fours in 40 runs is impossible');
m = good(); m.innings[0].batting[0].strikeRate = 150;
v = M.validateMatch(m);
check(v.issues.some(i => /bat0-sr/.test(i.id) && i.level === 'warning'), 'a printed strike rate that does not match: one of them was misread');
m = good(); m.innings[0].bowling[0].economy = 8;
v = M.validateMatch(m);
check(v.issues.some(i => /bowl0-eco/.test(i.id) && i.level === 'warning'), 'a printed economy that does not match');
m = good(); m.innings[0].batting[1].balls = null;
v = M.validateMatch(m);
check(v.issues.some(i => /bat1-balls/.test(i.id) && i.level === 'warning') && !errs(v).length, 'balls faced not printed: kept unknown, a warning (no strike rate from it)');
m = good(); m.innings[0].bowling[1].maidens = null;
v = M.validateMatch(m);
check(v.issues.some(i => /bowl1-maidens/.test(i.id) && i.level === 'warning') && !errs(v).length, 'maidens not printed: unknown, a warning');
m = good(); m.innings[0].batting.push(bat('Jeeth Suvarna', 'not out', 0, 0, 0, 0));
v = M.validateMatch(m);
check(ids(v).some(x => x.startsWith('inn0-bat-dup-')), 'the same batter twice');
m = good(); m.innings[1].batting.push(bat('Harsh Rane', 'not out', 0, 0, 0, 0));
v = M.validateMatch(m);
check(ids(v).some(x => x.startsWith('both-sides-')), 'one player on both teams');
m = good(); m.innings[0].total.overs = '12'; m.innings[0].bowling[0].overs = '7';
v = M.validateMatch(m);
check(ids(v).includes('inn0-overs-quota'), 'more overs than the format allows');
m = good(); m.innings[0].batting[0].dismissal = 'c Rohit Shukla b Zed Bowler';
v = M.validateMatch(m);
check(v.issues.some(i => /bat0-bowler/.test(i.id) && i.level === 'warning'), 'out to a bowler who is not in the bowling figures');
m = good(); m.innings[1].battingSide = 'A';
v = M.validateMatch(m);
check(ids(v).includes('innings-order'), 'both innings marked as the same team');
m = good(); m.innings = [m.innings[0]];
v = M.validateMatch(m);
check(ids(v).includes('innings-count'), 'one innings is not a match');
m = good(); m.innings[1].total.overs = '6'; m.innings[1].bowling[0].overs = '3'; m.innings[1].bowling[1].overs = '3';
v = M.validateMatch(m);
check(ids(v).includes('result-undecided'), 'a chase cut short needs the result chosen');
m.result = { override: true };
v = M.validateMatch(m);
check(!ids(v).includes('result-undecided'), '…which the person can do');
m = good(); m.innings[0].extras = { total: null, wides: null, noBalls: null, byes: null, legByes: null, penalty: null };
v = M.validateMatch(m);
check(ids(v).includes('inn0-extras') && !ids(v).includes('inn0-runs-sum'), 'extras not printed: a warning, and the runs sum is not guessed');
m = good(); m.innings[0].extras.total = 11;
v = M.validateMatch(m);
check(ids(v).includes('inn0-extras-sum'), 'extras total ≠ its parts');

section('photo reading → the working shape');
const read = {
    match: { teamNames: ['DY Patil SA', 'Parel Sporting Club'], resultText: 'DY Patil SA won by 25 runs' },
    innings: [
        { inningsNumber: 2, battingTeam: 'Parel Sporting Club', batting: [{ name: 'Rohit Shukla', dismissal: 'b Alim Shaikh', runs: 50, balls: 30, fours: 5, sixes: 2, photo: 3, confidence: 'high', unclear: [] }], bowling: [], didNotBat: [], extras: {}, total: { runs: 85, wickets: 2, overs: '10.0' }, fallOfWickets: [] },
        { inningsNumber: 1, battingTeam: 'DY Patil SA', batting: [
            { name: 'Jeeth Kumar Suvarna (c)', dismissal: 'c Rohit Shukla b Garv Jain', runs: 40, balls: 34, fours: 4, sixes: 1, photo: 1, confidence: 'high', unclear: [] },
            { name: 'Jeeth Kumar Suvarna (c)', dismissal: 'c Rohit Shukla b Garv Jain', runs: 40, balls: 34, fours: 4, sixes: 1, photo: 2, confidence: 'high', unclear: [] },
            { name: 'Harsh Rane', dismissal: 'not out', runs: 60, balls: null, fours: 6, sixes: 2, photo: 2, confidence: 'low', unclear: ['balls'] }],
          bowling: [], didNotBat: ['Atharva Kale'], extras: { total: 10 }, total: { runs: 110, wickets: 1, overs: '10.0' }, fallOfWickets: [{ wicket: 1, runs: 52, overs: '5.4', batter: 'Jeeth Kumar Suvarna' }] }
    ],
    notes: ['photo 2 is cut off']
};
let x = M.fromExtraction(read, { A: { name: 'DY PATIL SA' }, B: { name: 'PAREL SPORTING CLUB' } }, { 1: 'A', 2: 'B' });
check(x.innings.length === 2 && x.innings[0].battingSide === 'A' && x.innings[1].battingSide === 'B', 'innings in match order, sides from the printed team names');
check(x.innings[0].batting.length === 2, 'the same row on two overlapping screenshots is read once');
check(x.innings[0].batting[0].name === 'Jeeth Kumar Suvarna' && x.innings[0].batting[0].captain, 'role marker becomes the captain flag');
check(x.innings[0].batting[1].balls === null && x.innings[0].batting[1].confidence === 'low' && eq(x.innings[0].batting[1].unclear, ['balls']), 'an unreadable value stays null and is flagged');
check(x.printed.resultText === 'DY Patil SA won by 25 runs' && x.notes.includes('photo 2 is cut off'), 'the printed result line and the reader\'s notes are kept for the person');
x = M.fromExtraction(read, { A: { name: '' }, B: { name: '' } }, { 1: 'B', 2: 'A' });
check(x.innings[0].battingSide === 'B' && x.innings[1].battingSide === 'A', 'teams not chosen yet: the slot the photos were added to decides');
x = M.fromExtraction(read, { A: { name: 'PAREL SPORTING CLUB' }, B: { name: 'DY PATIL SA' } }, { 1: 'A', 2: 'B' });
check(x.innings[0].battingSide === 'B' && x.notes.some(s => /heading was used/.test(s)), 'photo heading wins over the slot, and says so');
check(M.teamLikeness('DY Patil SA', 'DY Patil Sports Academy') >= 0.6 && M.teamLikeness('DY Patil SA', 'Parel Sporting Club') < 0.6, '"DY Patil SA" ~ "DY Patil Sports Academy", not Parel');
check(M.sideForTeam('Parel SC', { A: { name: 'DY Patil Sports Academy' }, B: { name: 'Parel Sporting Club' } }) === 'B', 'a short printed name finds its side');

section('the browser\'s OCR text → rows (fallback reader)');
const text = [
    'DY Patil SA 110/1 (10.0 Ov)',
    'Batters R B 4s 6s SR',
    'Jeeth Kumar Suvarna (c) 40 34 4 1 117.65',
    'c Rohit Shukla b Garv Jain',
    'Harsh Rane not out 60 26 6 2 230.77',
    'Extras 10 (wd 4, nb 0, b 2, lb 4)',
    'Total 110/1 (10.0 Ov)',
    'Bowlers O M R W NB WD ECO',
    'Garv Jain 5 0 50 1 0 2 10.00',
    'Rohit Shukla 5.0 0 54 0 0 2 10.80'
].join('\n');
const t = T.parseScorecardText(text, 1);
check(t.batting.length === 2 && t.batting[0].name === 'Jeeth Kumar Suvarna' && t.batting[0].runs === 40 && t.batting[0].balls === 34 && t.batting[0].isCaptain, 'batting rows: name, R B 4s 6s, captain');
check(t.batting[0].dismissal === 'c Rohit Shukla b Garv Jain' && t.batting[1].dismissal === 'not out', 'dismissal on the next line, or on the same line');
check(t.bowling.length === 2 && t.bowling[0].overs === '5' && t.bowling[0].wickets === 1 && t.bowling[0].wides === 2 && t.bowling[0].noBalls === 0, 'bowling rows, the NB / WD columns named by the header');
check(t.extras && t.extras.total === 10 && t.extras.wides === 4 && t.extras.legByes === 4 && t.extras.byes === 2, 'extras line');
check(t.total && t.total.runs === 110 && t.total.wickets === 1 && t.total.overs === '10.0', 'total line');
check(t.batting.concat(t.bowling).every(r => r.confidence === 'low' && r.photo === 1), 'every OCR row is marked for checking against its photo');

section('the MCA website scorecard, as Tesseract reads it');
// Tesseract.js 4.1.1 output (one line per table row, PSM 4) for screenshots
// of the MCA website's scorecard, enlarged 2.5x the way the import page does:
// a "+" (MORE) column, dismissals wrapped onto a second line, "¢" for c,
// "Ibw" for lbw, the total in a dark bar whose "TOTAL" is lost and whose "/"
// is read as a digit, fall of wickets two to a line, a ten-column bowling
// table. The 1st innings is three overlapping screenshots: only the first
// has the table's header.
const MCA1 = [`United Cricketers Apollo Cricket Club
1stinn 176-9 RR 8.8
+/ BATTERS R B SR 4s &S MORE
SAGAR GUPTA(WK) not out 73 51 143.14 6 2 +
ADITYA SANDIP SHELKE b Meet Anil Patil 5 4 125.00 1 0 +
PIYUSH KARKHUR ¢ Parag Ramchandra Jadhav b Akash 13 10 130.00 2 0 +
Suryakanl Pawar
OMKAR DEEPAK RAHATE(C) Ibw Shashwat Pathak 15 1 136.36 3 0 +
SUCHIT DIGAMBAR DEVLI Ibw Shashwat Pathak 2 3 66.67 0 0 +
VEDANT SANTOSH HARIDAS ¢ Shashwat Pathak b Akash 28 17 164.71 4 0 +
Suryakanl Pawar
RAJESH NARAYAN BHUJBAL b Varun Malik 19 13 146.15 3 0 +`, `RAJESH NARAYAN BHUJBAL b Varun Malik 19 13 146.15 3 0 +
ANKIT DILIP VISHWAKARMA run out (Sarvesh Devendra Patil) 1 7 14.29 0 0 +
SIDDHANT SACHIN JADHAV ¢ Jaineel Nirav Nandha b Varun Malik 7 4 175.00 0 1 +
ASHWIN KUMAR LALDHARI YAD run out (Sagar Vinod Patil) 1 1 100.00 0 0 +
DIVYESH SURESH SHETTY not out 0 o - 0 0 +
Extras( b 3,lb 2,w 6,nb 1) 12
17619 (20.0 ov)
/" FALL OF WICKETS
1-16 (ADITYA SANDIP SHELKE, 1.2 ov) 2 - 47 (PIYUSH KARKHUR, 4.6 ov)
3 - 75 (OMKAR DEEPAK RAHATE, 8.3 ov) 4 - 77 (SUCHIT DIGAMBAR DEVLI, 8.6 ov)
5 - 133 (VEDANT SANTOSH HARIDAS, 14.1 ov) 6 - 161 (RAJESH NARAYAN BHUJBAL, 17.6 ov)
7 - 174 (SIDDHANT SACHIN JADHAV, 19.5 ov) 8 - 176 (ASHWIN KUMAR LALDHARI YAD, 19.6 ov)
9 - 175 (ANKIT DILIP VISHWAKARMA, 19.6 ov)`, `> BOWLERS o M R w ECON 0's 4's 6'S wD NB MORE
MEET ANIL PATIL 4 0 31 1 7.75 0 9 0 2 0 +
SHASHWAT PATHAK 4 0 36 2 9.00 0 7 0 1 0 +
AKASH SURYAKANT PAWAR 4 0 30 2 7.50 0 9 0 1 1 +
VARUN MALIK 4 0 39 2 9.75 0 6 0 2 0 +
SIDDHANT SACHIN JADHAV 4 0 35 0 8.75 0 7 0 0 0 +`];
const MCA2 = `United Cricketers Apollo Cricket Club
2ndInn 173-9 RR 8.65
7 BATTERS R B SR 4S 6'S MORE
SHUBHAM SHYAM PUNYARTHI(C) ¢ Asiin Kumar Laldhar Yad b 15 8 187.50 2 1 +
JAINEEL NIRAV NANDHA ¢ Rajesh Narayan Bhujbal b Siddhant 9 13 69.23 1 0 +
Sachin Jadhav
ADITYA SUNIL RAWAT ¢ ADITYA SANDIP SHELKE b Divyesh 16 17 94.12 3 0 +
Suresh Shetty
PARAG RAMCHANDRA JADHAV ¢ Omkar Deepak Rahate b Ashvwan 42 36 116.67 4 0 +
Kumar Laldhari Yad
SARVESH DEVENDRA PATIL(WK) b Divyesh Suresh Shetty 0o 2 0.00 0 0 +
SHASHWAT PATHAK Ibw Divyesh Suresh Shetty 35 24 145.83 4 1 +
AKASH SURYAKANT PAWAR b Divyesh Suresh Shetty 1 2 50.00 0 0 +
SAGAR VINOD PATIL b Ankit Dilip Vishwakarma 6 4 150.00 1 0 +
YASH ASHOK SINGH run out (Suchit Digambar Devli) 12 8 150.00 1 1 +
MEET ANIL PATIL not out 13 7 185.71 1 1 +
Extras(b 0,lb 9,w 14,nb 1) 24
17319 (20.0 ov)`;
const figs = (r) => [r.runs, r.balls, r.fours, r.sixes, r.strikeRate];
let st = null;
const m1 = MCA1.map((x, i) => { const p = T.parseScorecardText(x, i + 1, st); st = p.state; return p; });
const b1 = m1[0].batting;
check(b1.length === 7 && b1.map(r => r.name).join() === 'SAGAR GUPTA,ADITYA SANDIP SHELKE,PIYUSH KARKHUR,OMKAR DEEPAK RAHATE,SUCHIT DIGAMBAR DEVLI,VEDANT SANTOSH HARIDAS,RAJESH NARAYAN BHUJBAL', 'MCA: the batters; the stray icon before the header and the "+" after each row left out');
check(eq(figs(b1[0]), [73, 51, 6, 2, 143.14]) && b1[0].isWicketKeeper && b1[3].isCaptain, 'the header\'s order (R B SR 4s 6s); "(WK)" and "(C)" kept as roles');
check(b1[2].dismissal === 'c Parag Ramchandra Jadhav b Akash Suryakanl Pawar' && b1[5].dismissal === 'c Shashwat Pathak b Akash Suryakanl Pawar' && b1[3].dismissal === 'lbw Shashwat Pathak', 'a dismissal over two lines put back together; "¢" and "Ibw" read as c and lbw');
check(b1[3].balls === 11, 'balls misread as 1: the strike rate says 15 runs at 136.36 is 11 balls');
check(m1[0].total === null && m1[0].fallOfWickets.length === 0, 'the tab\'s "176-9" is not taken for the total');
const b2 = m1[1].batting;
check(b2.length === 5 && b2[0].name === 'RAJESH NARAYAN BHUJBAL' && eq(figs(b2[1]), [1, 7, 0, 0, 14.29]), 'the next screenshot, no header: the table carries on (the repeated row is left to the page to merge)');
check(eq(figs(b2[4]), [0, 0, 0, 0, null]) && b2[4].dismissal === 'not out', 'a strike rate printed "-" is left empty');
check(m1[1].extras && m1[1].extras.total === 12 && m1[1].extras.byes === 3 && m1[1].extras.legByes === 2 && m1[1].extras.wides === 6 && m1[1].extras.noBalls === 1, 'extras: "Extras( b 3,lb 2,w 6,nb 1) 12"');
check(m1[1].total && m1[1].total.runs === 176 && m1[1].total.wickets === 9 && m1[1].total.overs === '20.0', 'the total without its word, its "/" read as 1: "17619 (20.0 ov)" is 176/9 in 20.0 overs');
check(m1[1].fallOfWickets.length === 9 && eq(m1[1].fallOfWickets[0], { wicket: 1, runs: 16, overs: '1.2', batter: 'ADITYA SANDIP SHELKE' }) && eq(m1[1].fallOfWickets[8], { wicket: 9, runs: 175, overs: '19.6', batter: 'ANKIT DILIP VISHWAKARMA' }), 'fall of wickets, two to a line');
const w1 = m1[2].bowling;
check(m1[2].batting.length === 0 && w1.length === 5 && w1.map(r => r.name).join() === 'MEET ANIL PATIL,SHASHWAT PATHAK,AKASH SURYAKANT PAWAR,VARUN MALIK,SIDDHANT SACHIN JADHAV', 'MCA: the bowlers');
check(eq([w1[0].overs, w1[0].maidens, w1[0].runs, w1[0].wickets, w1[0].economy, w1[0].dots, w1[0].wides, w1[0].noBalls], ['4', 0, 31, 1, 7.75, 0, 2, 0]) && w1[2].noBalls === 1, 'O M R W ECON 0\'s 4\'s 6\'s WD NB, each where its header says');
const m2 = T.parseScorecardText(MCA2, 4);
check(m2.batting.length === 10 && m2.batting[0].isCaptain && m2.batting[4].isWicketKeeper && m2.batting[4].name === 'SARVESH DEVENDRA PATIL', 'the 2nd innings: ten batters, roles');
check(m2.batting[1].dismissal === 'c Rajesh Narayan Bhujbal b Siddhant Sachin Jadhav' && m2.batting[2].dismissal === 'c ADITYA SANDIP SHELKE b Divyesh Suresh Shetty' && eq(figs(m2.batting[3]), [42, 36, 4, 0, 116.67]), 'dismissals and figures');
check(m2.total && m2.total.runs === 173 && m2.total.wickets === 9 && m2.extras.total === 24 && m2.extras.wides === 14 && m2.extras.byes === 0, '"17319 (20.0 ov)" is 173/9; extras 24 (w 14, b 0)');
check(m2.batting.concat(m1[0].batting, w1).every(r => r.confidence === 'low'), 'every row still marked for checking');

section('figures Tesseract garbled: put right only when the printed rates agree');
const BAT_HEAD = '¥ BATTERS R B SR 4s &S MORE\n';
const one = (line) => T.parseScorecardText(BAT_HEAD + line, 1).batting[0];
let g = one(`SHUBHAM SHYAM PUNYARTH'(C) ¢ Ashwin Kumar Laldhar Yad b 15 8 187.50 2 1 +`);
check(g.name === 'SHUBHAM SHYAM PUNYARTH' && g.isCaptain, 'a stray mark after a name dropped, the captain kept');
g = one(`JAINEEL NIRAV NANDHA ";;.Hé\\](' sh Narayan Bhupbal b Siddhant 9 13 69.23 1 0 +`);
check(g.name === 'JAINEEL NIRAV NANDHA' && eq(figs(g), [9, 13, 1, 0, 69.23]), 'a run of marks after a name is not part of it');
g = one('YASH ASHOK SINGH run out (Suchit Digambar Devi) 12 8 15000 11 +');
check(eq(figs(g), [12, 8, 1, 1, 150]), 'the strike rate without its point (15000), and "1 1" run together (11 fours in 12 runs cannot be)');
g = one('PARAG RAMCHANDRA JADHAV O Pt b Achwdn 42 36 11667 4 o0 +');
check(g.name === 'PARAG RAMCHANDRA JADHAV' && eq(figs(g), [42, 36, 4, 0, 116.67]), '"11667" is 116.67, "o0" is 0, a stray capital after the name dropped');
g = one('SHASHWAT PATHAK lbow Divyesh Suresh Shetty 3 24 14583 4 1 +');
check(g.runs === 35 && g.balls === 24, '3 runs off 24 balls at 145.83 cannot be: 35');
g = one('ANKIT DILIP VISHWAKARMA run out (Sarvesh Devendra Patil) 17 14.29 0 0 +');
check(eq(figs(g), [1, 7, 0, 0, 14.29]), '"1 7" read as 17: the one split the strike rate agrees with');
g = one('ANKIT DILIP VISHWAKARMA run out (Sarvesh Devendra Patil) 1 7 14.2% 0 0 +');
check(eq(figs(g), [1, 7, 0, 0, null]), 'a strike rate read as "14.2%" is left empty, the other figures stay in their columns');
g = one('ASHWIN KUMAR LALDHARI YAD run out (Sagar Vinod Patil) 1 1 100.00 0 0 +');
check(eq(figs(g), [1, 1, 0, 0, 100]), 'figures that agree are left alone');
g = one('KARAN MEHTA c Rohit Shukla b Garv Jain 4 1 200.00 1 0 +');
check(g.runs === 4 && g.balls === 1, 'out of step, but either could be the misread one (4 off 2, or 2 off 1): left for the person to check');
g = one('VIKAS SHARMA b Garv Jain 8 4 250.00 1 0 +');
check(g.runs === 8 && g.balls === 4, 'a misread strike rate (250.00 for 200.00) does not "correct" figures that were right');
const BOWL_HEAD = "> BOWLERS O M R w ECON o's 4's 6'S WD NB MORE\n";
const w = T.parseScorecardText(BOWL_HEAD + 'SHASHWAT PATHAK 4 0 3 2 9.00 0 7 0 1 0 +\nSIDDHANT SACHIN JADHAV 4 0 3% 0 8.75 0 7 0 0 0 +\nMEET ANIL PATIL 4 0 31 1 7.75 0 9 0 2 0 +', 1).bowling;
check(w.length === 3 && w[0].runs === 36 && w[0].economy === 9 && w[0].wides === 1, '"o\'s" in the header is 0\'s; 3 runs in 4 overs at 9.00 is 36');
check(w[1].name === 'SIDDHANT SACHIN JADHAV' && w[1].runs === 35 && w[1].wickets === 0 && w[1].dots === 0, '"3%" keeps its column, and the economy gives 35');
check(w[2].runs === 31 && w[2].economy === 7.75, 'a bowler whose figures agree is left alone');
const w2 = T.parseScorecardText(BOWL_HEAD + 'VARUN MALIK 4 0 38 2 9.00 0 6 0 2 0 +', 1).bowling[0];
check(w2.runs === 38 && w2.economy === 9, 'a misread economy (9.00 for 9.50) does not turn 38 runs into 36');
section('a CricHeroes-style phone screenshot, as Tesseract reads it');
// the same reader on an app screenshot (large text, not enlarged): the
// dismissal under each name, "†" read as T, the overs' point lost ("5.0" read
// as 50, "13.50" as 1350), "O" for 0 in the extras, a fall of wickets broken
// over two lines
const CH = `DY Patil SA 107/3 (10.0 Ov)
Batters R B 4s 6s SR
Jeeth Kumar Suvarna (c) 40 34 4 1 117.65
¢ Rohit Shukla b Garv Jain
Harsh Rajesh Rane 60 26 6 2 230.77
not out
Suraj Patil T 0 2 0 O 0.00
b Alim Shaikh
Atharva Kale 7 9 1 O 77.78
run out (Garv Jain)
Extras 0(wdO,nb0,b0,Ib0)
Total 107/3 (10.0 Ov)
Bowlers O M R W NB WD ECO
Garv Jain 50 0 50 1 0 2 10.00
Rohit Shukla 40 0 54 0 O 2 1350
Alim Shaikh 10 0 7 1 0 0 7.00
Fall of wickets: 1-52 (Jeeth Kumar Suvarna, 5.4 ov), 2-60
(Suraj Patil, 6.3 ov), 3-107 (Atharva Kale, 9.6 ov)`;
const ch = T.parseScorecardText(CH, 1);
check(ch.batting.map(r => [r.name, r.dismissal].join(' / ')).join(' | ') === 'Jeeth Kumar Suvarna / c Rohit Shukla b Garv Jain | Harsh Rajesh Rane / not out | Suraj Patil / b Alim Shaikh | Atharva Kale / run out (Garv Jain)', 'CricHeroes: names, each dismissal from the line under it; "T" read for † dropped');
check(eq(figs(ch.batting[2]), [0, 2, 0, 0, 0]) && eq(figs(ch.batting[3]), [7, 9, 1, 0, 77.78]), '"O" in a figure is 0');
check(eq(ch.bowling.map(r => [r.overs, r.runs, r.economy]), [['5.0', 50, 10], ['4.0', 54, 13.5], ['1.0', 7, 7]]), 'overs read without their point ("50") put right by the economy — the runs left alone');
check(ch.bowling[0].wides === 2 && ch.bowling[0].noBalls === 0 && ch.bowling[1].noBalls === 0, 'NB and WD where the header says');
check(eq(ch.extras, { total: 0, wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: null }), 'extras "0(wdO,nb0,b0,Ib0)": every part 0');
check(ch.total.runs === 107 && ch.total.wickets === 3 && ch.fallOfWickets.map(w => `${w.wicket}-${w.runs} ${w.batter} ${w.overs}`).join(', ') === '1-52 Jeeth Kumar Suvarna 5.4, 2-60 Suraj Patil 6.3, 3-107 Atharva Kale 9.6', 'the total; a fall of wickets broken over two lines put back together');
console.log(`\n${passes} passed, ${fails.length} failed`);
if (fails.length) { console.log('\nFAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
