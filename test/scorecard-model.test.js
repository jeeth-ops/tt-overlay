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
//   OCR text → rows (fallback reader)
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

console.log(`\n${passes} passed, ${fails.length} failed`);
if (fails.length) { console.log('\nFAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
