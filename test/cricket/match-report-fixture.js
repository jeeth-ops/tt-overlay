// A whole limited-overs match, simulated ball by ball with a seeded random
// generator — the same shape of data the panels hand to MatchReport
// (teams, innings cards, fall of wickets, extras, the ball log with
// timestamps and wagon-wheel shots). Used by match-report-test.js.
//
//   makeMatch({ seed, overs, shots })  → snapshot for MatchReport.buildModel
const M = require('../../match-report.js');

function rng(seed){
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const NAMES_A = ['Aman Khan', 'Harsh Rane', 'Atharva Kale', 'Sahil Gode', 'Suraj Shinde', 'Yogesh Pawar', 'Iqbal Abdullah', 'Shubham Mane', 'Prince Badiani', 'Karsh Kothari', 'Nikhil Giri'];
const NAMES_B = ['Aditya Parab', 'Abhinab Saha', 'Amit Jaiswal', 'Arjun Jayswal', 'Parshad Bodke', 'Viraj Jadhav', 'Shantanu Kadam', 'Jugraj Mehta', 'Yuvraj Desai', 'Het Patel', 'Riday Khandke'];

function makeMatch(opts = {}){
  const rnd = rng(opts.seed || 7);
  const oversLimit = opts.overs || 20;
  const withShots = opts.shots !== false;
  const teams = {
    A: { name: 'Dr. D.Y Patil Sports Academy', short: 'DYP', color: '#0f766e', captain: 'Karsh Kothari', keeper: 'Suraj Shinde', players: NAMES_A.map(n => ({ name: n })) },
    B: { name: 'New Hind Sporting Club', short: 'NHSC', color: '#1d4ed8', captain: 'Aditya Parab', keeper: 'Parshad Bodke', players: NAMES_B.map(n => ({ name: n })) }
  };
  const hands = {};
  [...NAMES_A, ...NAMES_B].forEach((n, i) => { hands[n] = (i % 3 === 1) ? 'L' : 'R'; });
  let t = new Date(2026, 8, 27, 14, 35, 0).getTime();
  const balls = [], innings = [];
  let target = null;

  [['A', 'B'], ['B', 'A']].forEach(([bat, bowl], idx) => {
    const no = idx + 1;
    const order = teams[bat].players.map(p => p.name);
    const bowlers = teams[bowl].players.map(p => p.name).slice(5, 11);
    const card = {}; const bowling = {}; const fow = []; const extras = { wd: 0, nb: 0, b: 0, lb: 0, pen: 0 };
    const batRow = n => card[n] || (card[n] = { name: n, runs: 0, balls: 0, fours: 0, sixes: 0, out: false, howOut: 'not out' });
    const bowlRow = n => bowling[n] || (bowling[n] = { name: n, balls: 0, maidens: 0, runs: 0, wickets: 0, overRuns: 0 });
    let striker = order[0], non = order[1], next = 2, runs = 0, wkts = 0, legal = 0;
    batRow(striker); batRow(non);
    const allOut = () => wkts >= 10;
    for(let over = 0; over < oversLimit && !allOut(); over++){
      const bowler = bowlers[over % bowlers.length];
      const bw = bowlRow(bowler); bw.overRuns = 0;
      let ballInOver = 0;
      while(ballInOver < 6 && !allOut()){
        if(target && runs >= target) break;
        t += 25000 + Math.floor(rnd() * 30000);
        const r = rnd();
        let kind, total = 0, batRuns = 0, isWicket = false, dismissalType = null;
        if(r < 0.03){ kind = 'Wd'; total = 1; extras.wd++; }
        else if(r < 0.04){ kind = 'Nb'; batRuns = rnd() < 0.5 ? 1 : 4; total = 1 + batRuns; extras.nb++; }
        else if(r < 0.05){ kind = 'LB'; total = 1; extras.lb++; }
        else if(r < 0.09){ kind = 'W'; isWicket = true; dismissalType = ['Caught', 'Bowled', 'LBW', 'Caught', 'Run Out', 'Stumped'][Math.floor(rnd() * 6)]; }
        else if(r < 0.40){ kind = '0'; }
        else if(r < 0.68){ kind = '1'; batRuns = total = 1; }
        else if(r < 0.78){ kind = '2'; batRuns = total = 2; }
        else if(r < 0.80){ kind = '3'; batRuns = total = 3; }
        else if(r < 0.93){ kind = '4'; batRuns = total = 4; }
        else { kind = '6'; batRuns = total = 6; }
        const legalBall = kind !== 'Wd' && kind !== 'Nb';
        const sRow = batRow(striker);
        if(kind !== 'Wd') sRow.balls++;
        sRow.runs += batRuns;
        if(batRuns === 4 && kind !== 'Nb') sRow.fours++;
        if(batRuns === 6) sRow.sixes++;
        runs += total;
        if(kind !== 'LB'){ bw.runs += total; bw.overRuns += total; }
        if(legalBall){ ballInOver++; legal++; bw.balls++; }
        const overLabel = `${over}.${legalBall ? ballInOver : Math.max(ballInOver, 0) + 1}`;
        let dismissed = null, fielder = null;
        if(isWicket){
          wkts++;
          dismissed = striker;
          fielder = (dismissalType === 'Caught' || dismissalType === 'Run Out' || dismissalType === 'Stumped') ? teams[bowl].players[Math.floor(rnd() * 11)].name : null;
          if(dismissalType === 'Stumped') fielder = teams[bowl].keeper;
          const bowlerCredited = dismissalType !== 'Run Out';
          if(bowlerCredited) bw.wickets++;
          const howOut = dismissalType === 'Caught' ? `c ${fielder} b ${bowler}` : dismissalType === 'Bowled' ? `b ${bowler}` : dismissalType === 'LBW' ? `lbw b ${bowler}`
            : dismissalType === 'Stumped' ? `st †${fielder} b ${bowler}` : `run out (${fielder})`;
          Object.assign(sRow, { out: true, howOut, dismissalType, bowlerName: bowlerCredited ? bowler : null, fielderName: fielder });
          fow.push({ wkt: wkts, runs, over: `${Math.floor(legal / 6)}.${legal % 6}`, inningsNo: no });
        }
        const entry = {
          innings: no, battingTeam: bat, over: overLabel, ballType: kind, striker, nonStriker: non, bowler,
          runs: total, isWicket, dismissal: isWicket ? sRow.howOut : null, dismissalType, dismissedPlayer: dismissed, fielderName: fielder,
          bowlerFacts: { legal: legalBall, runs: kind === 'LB' ? 0 : total, wicket: isWicket && dismissalType !== 'Run Out' },
          nbRunsAs: kind === 'Nb' ? 'bat' : undefined, boundary: kind === 'Nb' ? batRuns === 4 : undefined,
          phase: 'REGULATION', scoreAfter: `${runs}-${wkts}`, timestamp: t, deliveryId: `d${no}-${balls.length}`
        };
        if(withShots && batRuns > 0 && rnd() < 0.92){
          const hand = hands[striker];
          const z = M.ZONES[Math.floor(rnd() * 8)];
          const boundary = batRuns === 4 || batRuns === 6;
          const deep = boundary || rnd() < 0.45;
          const [a0, a1] = M._internal.zoneRange(z, hand);
          const deg = a0 + 4 + rnd() * 37;
          const rr = boundary ? 100 : deep ? 60 + rnd() * 35 : 22 + rnd() * 30;
          const [x, y] = M._internal.polar(rr, deg);
          entry.shot = { zone: z.id, depth: deep ? 'deep' : 'inner', hand, x: Math.round(x * 10) / 1000, y: Math.round(y * 10) / 1000 };
        }
        balls.push(entry);
        if(isWicket){
          if(next < 11){ striker = order[next++]; batRow(striker); } else break;
        } else if(total % 2 === 1 && kind !== 'Wd'){ [striker, non] = [non, striker]; }
      }
      if(ballInOver === 6){
        if(bw.overRuns === 0) bw.maidens++;
        [striker, non] = [non, striker];
      }
      if(target && runs >= target) break;
    }
    if(!target) target = runs + 1;
    const ov = `${Math.floor(legal / 6)}.${legal % 6}`;
    innings.push({
      no, team: bat, runs, wickets: wkts, overs: ov, declared: false, extras,
      batting: order.filter(n => card[n]).map(n => card[n]),
      bowling: bowlers.filter(n => bowling[n]).map(n => { const b = bowling[n]; return { name: n, overs: `${Math.floor(b.balls / 6)}.${b.balls % 6}`, maidens: b.maidens, runs: b.runs, wickets: b.wickets }; }),
      fow
    });
    t += 20 * 60000;
  });
  const [i1, i2] = innings;
  let result;
  if(i2.runs >= i1.runs + 1) result = { text: `${teams[i2.team].name} won by ${10 - i2.wickets} wickets`, winner: i2.team };
  else if(i2.runs === i1.runs) result = { text: 'Match tied', winner: 'TIE' };
  else result = { text: `${teams[i1.team].name} won by ${i1.runs - i2.runs} runs`, winner: i1.team };
  return {
    generatedAt: t, tournament: 'Kanga League 2026-27', matchTitle: 'League Match 12', date: '2026-09-27',
    format: 'Custom', oversLimit, venue: 'Dr D.Y Patil University Ground, Navi Mumbai',
    toss: { team: 'B', decision: 'BOWL' }, result, teams, innings, balls, hands, ballsPerOver: 6
  };
}
module.exports = { makeMatch };
