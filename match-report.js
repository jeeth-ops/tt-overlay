/* ================================================================
   📑 MATCH REPORT — the scorecard Excel and the PDF match report.

   One file builds both, from one model of the match:
     buildModel(snapshot)   → every number the reports print
     wagonOf(balls, opts)   → where the runs went (wagon wheel)
     drawWagonWheel(canvas, wheel, opts) → the wheel as a picture
     buildExcel(ExcelJS, model, images)  → the scorecard workbook
     buildPdf(jsPDF, model, images)      → the PDF match report

   The snapshot is plain data the panel hands over (teams, innings
   cards, fall of wickets, the ball log) — nothing here reads live
   state, so the same match always gives the same report.

   Used by:
     - cricket-panel.html  (inlined)  — Clipper Helper panel
     - cricket-panel3.html (inlined)  — Stream Engine panel
   The panels carry an inlined copy between the MATCH-REPORT markers;
   test/cricket/match-report-test.js fails if a copy drifts from this
   file. Edit THIS file, then run:
     node test/cricket/match-report-test.js --sync
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MatchReport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- wagon wheel geometry (same field as the panel's picker) ----------
     Field units: boundary radius 100, the batter at the top end, the bowler
     at the bottom. Angles clockwise from straight behind the batter. Zones
     are a right-hander's; a left-hander's are mirrored. */
  var ZONES = [
    { id: 'fineleg',   from: 0,   inner: 'Short fine leg', deep: 'Fine leg',        name: 'Fine leg',   side: 'leg' },
    { id: 'squareleg', from: 45,  inner: 'Square leg',     deep: 'Deep square leg', name: 'Square leg', side: 'leg' },
    { id: 'midwicket', from: 90,  inner: 'Mid-wicket',     deep: 'Deep mid-wicket', name: 'Mid-wicket', side: 'leg' },
    { id: 'midon',     from: 135, inner: 'Mid-on',         deep: 'Long-on',         name: 'Long-on',    side: 'leg' },
    { id: 'midoff',    from: 180, inner: 'Mid-off',        deep: 'Long-off',        name: 'Long-off',   side: 'off' },
    { id: 'cover',     from: 225, inner: 'Cover',          deep: 'Deep cover',      name: 'Cover',      side: 'off' },
    { id: 'point',     from: 270, inner: 'Point',          deep: 'Deep point',      name: 'Point',      side: 'off' },
    { id: 'thirdman',  from: 315, inner: 'Gully',          deep: 'Third man',       name: 'Third man',  side: 'off' }
  ];
  var R_IN = 55, R_OUT = 100, BAT = [0, -11.5];

  /* ---------- small helpers ---------- */
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function lower(v) { return str(v).trim().toLowerCase(); }
  function oversToBalls(o, bpo) {
    bpo = bpo || 6;
    var p = str(o || '0').split('.');
    return (parseInt(p[0], 10) || 0) * bpo + Math.min(parseInt(p[1], 10) || 0, bpo - 1);
  }
  function ballsToOvers(b, bpo) { bpo = bpo || 6; return Math.floor(b / bpo) + '.' + (b % bpo); }
  function rate(runs, balls) { return balls > 0 ? (runs / (balls / 6)) : 0; }
  function fixed(n, d) { return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d); }
  function sr(runs, balls) { return balls > 0 ? fixed(runs * 100 / balls, 2) : '0.00'; }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateText(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : '';
  }
  function isoOf(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function clockText(ts) {
    if (!ts) return '';
    var d = new Date(ts), h = d.getHours(), m = d.getMinutes();
    return ((h % 12) || 12) + ':' + ('0' + m).slice(-2) + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  // Morning / Afternoon / Evening / Night — from when the first ball was bowled.
  function dayPart(ts) {
    if (!ts) return '';
    var h = new Date(ts).getHours();
    return h < 12 ? 'Morning' : h < 16 ? 'Afternoon' : h < 19 ? 'Evening' : 'Night';
  }
  var ORDINAL = ['First', 'Second', 'Third', 'Fourth'];
  function isRegulation(b) { return !!b && !b.superOverId && b.phase !== 'SUPER_OVER'; }

  /* ---------- runs off the bat, boundaries ---------- */
  function batRunsOf(e) {
    var k = e && e.ballType, r = num(e && e.runs);
    if (/^[1-6]$/.test(k || '')) return r;
    if (k === 'Nb') return (e.nbRunsAs && e.nbRunsAs !== 'bat') ? 0 : Math.max(0, r - 1);
    if (k === 'OT') return r;
    return 0;
  }
  function isFour(e) { return e.ballType === '4' || (e.ballType === 'Nb' && e.boundary === true && batRunsOf(e) === 4); }
  function isSix(e) { return e.ballType === '6' || (e.ballType === 'Nb' && e.boundary === true && batRunsOf(e) === 6); }

  /* ---------- wagon wheel ---------- */
  function zoneRange(z, hand) { return hand === 'L' ? [360 - z.from - 45, 360 - z.from] : [z.from, z.from + 45]; }
  function polar(r, deg) { var a = deg * Math.PI / 180; return [r * Math.sin(a), -r * Math.cos(a)]; }
  // Where the shot ended, in field units, as the picker stored it (x/y are
  // field/100); an old shot with only a region gets the middle of it.
  function shotPoint(shot, hand) {
    if (shot && isFinite(shot.x) && isFinite(shot.y) && (shot.x || shot.y)) return [num(shot.x) * 100, num(shot.y) * 100];
    var z = ZONES.filter(function (q) { return q.id === (shot && shot.zone); })[0] || ZONES[0];
    var rg = zoneRange(z, hand);
    return polar(shot && shot.depth === 'deep' ? 86 : 40, (rg[0] + rg[1]) / 2);
  }
  function emptyZones() {
    var z = {};
    ZONES.forEach(function (q) { z[q.id] = { id: q.id, name: q.name, side: q.side, runs: 0, shots: 0, fours: 0, sixes: 0 }; });
    return z;
  }
  /* Everything one wagon wheel needs. opts:
       team   'A' | 'B'   — only that side's innings
       batter name        — only that batter's shots
       hand   'R' | 'L'   — the view to draw in; a shot played by a batter of
                            the other hand is mirrored into it, so a team's
                            right- and left-handers share one picture. */
  function wagonOf(balls, opts) {
    opts = opts || {};
    var view = opts.hand === 'L' ? 'L' : 'R';
    var w = { hand: view, shots: [], zones: emptyZones(), runs: 0, scoringShots: 0, mapped: 0, fours: 0, sixes: 0, offRuns: 0, legRuns: 0, top: null };
    (balls || []).forEach(function (e) {
      if (!isRegulation(e)) return;
      if (opts.team && e.battingTeam !== opts.team) return;
      if (opts.batter && lower(e.striker) !== lower(opts.batter)) return;
      var runs = batRunsOf(e);
      if (runs <= 0) return;
      w.scoringShots++;
      if (!e.shot || !e.shot.zone) return;
      var hand = e.shot.hand === 'L' ? 'L' : 'R';
      var p = shotPoint(e.shot, hand);
      if (hand !== view) p = [-p[0], p[1]];
      var four = isFour(e), six = isSix(e);
      w.shots.push({ x: p[0], y: p[1], runs: runs, four: four, six: six, zone: e.shot.zone, depth: e.shot.depth || '', batter: e.striker || '', hand: hand });
      var z = w.zones[e.shot.zone];
      if (z) { z.runs += runs; z.shots++; if (four) z.fours++; if (six) z.sixes++; if (z.side === 'off') w.offRuns += runs; else w.legRuns += runs; }
      w.runs += runs; w.mapped++;
      if (four) w.fours++;
      if (six) w.sixes++;
    });
    var list = ZONES.map(function (q) { return w.zones[q.id]; });
    list.forEach(function (z) { z.pct = w.runs ? Math.round(z.runs * 100 / w.runs) : 0; });
    w.top = list.slice().sort(function (a, b) { return b.runs - a.runs || b.shots - a.shots; })[0];
    if (w.top && !w.top.runs) w.top = null;
    w.offPct = w.runs ? Math.round(w.offRuns * 100 / w.runs) : 0;
    w.legPct = w.runs ? 100 - w.offPct : 0;
    w.list = list;
    return w;
  }

  /* ---------- the model ---------- */
  var OUT_SHORT = {
    'Caught': 'CAUGHT', 'Bowled': 'BOWLED', 'LBW': 'LBW', 'Stumped': 'STUMPED', 'Run Out': 'RUN OUT',
    'Run Out (Mankaded)': 'RUN OUT', 'Hit Wicket': 'HIT WICKET', 'Retired Out': 'RETIRED OUT', 'Timed Out': 'TIMED OUT',
    'Obstructing the Field': 'OBSTRUCTING', 'Handled the Ball': 'HANDLED BALL', 'Hit the Ball Twice': 'HIT TWICE',
    'Absent Hurt': 'ABSENT HURT'
  };
  function howOutShort(r) {
    if (!r.out) {
      if (/absent hurt/i.test(r.howOut || '')) return 'ABSENT HURT';
      if (/retired/i.test(r.howOut || '')) return 'RETIRED HURT';
      return 'NOT OUT';
    }
    if (r.dismissalType === 'Caught' && /^c\s*&\s*b/i.test(r.howOut || '')) return 'CAUGHT & BOWLED';
    if (r.dismissalType && OUT_SHORT[r.dismissalType]) return OUT_SHORT[r.dismissalType];
    if (r.dismissalType) return str(r.dismissalType).toUpperCase();
    var h = lower(r.howOut);
    if (/^c\s*&\s*b/.test(h)) return 'CAUGHT & BOWLED';
    if (/^c /.test(h)) return 'CAUGHT';
    if (/^st /.test(h)) return 'STUMPED';
    if (/^lbw/.test(h)) return 'LBW';
    if (/^b /.test(h)) return 'BOWLED';
    if (/run out/.test(h)) return 'RUN OUT';
    return 'OUT';
  }
  function sameName(a, b) { return lower(a) === lower(b) && lower(a) !== ''; }

  function buildInnings(inp, inn, balls, idx) {
    var team = inn.team, opp = team === 'A' ? 'B' : 'A';
    var teamObj = (inp.teams && inp.teams[team]) || {};
    var oppObj = (inp.teams && inp.teams[opp]) || {};
    var iballs = balls.filter(function (b) { return (b.innings || 1) === inn.no; });
    var times = iballs.map(function (b) { return num(b.timestamp); }).filter(function (t) { return t > 0; });
    var start = times.length ? Math.min.apply(null, times) : null;
    var end = times.length ? Math.max.apply(null, times) : null;
    var hands = inp.hands || {};

    function arrivalOf(name) {
      for (var i = 0; i < iballs.length; i++) {
        var b = iballs[i];
        if (sameName(b.striker, name) || sameName(b.nonStriker, name)) {
          for (var j = i - 1; j >= 0; j--) if (num(iballs[j].timestamp)) return num(iballs[j].timestamp);
          return num(b.timestamp) || start;
        }
      }
      return null;
    }
    function departureOf(name, out) {
      if (out) {
        for (var i = iballs.length - 1; i >= 0; i--) {
          var b = iballs[i];
          if (b.isWicket && sameName(b.dismissedPlayer || b.striker, name)) return num(b.timestamp) || end;
        }
      }
      return end;
    }
    var batting = (inn.batting || []).map(function (r, i) {
      var arr = arrivalOf(r.name), dep = departureOf(r.name, r.out);
      var mins = arr && dep && dep >= arr ? Math.round((dep - arr) / 60000) : null;
      var h = hands[r.name] || r.hand;
      return {
        no: i + 1, name: str(r.name), hand: h === 'L' ? 'LHB' : 'RHB',
        captain: sameName(teamObj.captain, r.name), keeper: sameName(teamObj.keeper, r.name),
        status: r.out ? str(r.howOut || 'out') : str(r.howOut || 'not out'),
        howOut: howOutShort(r), bowler: str(r.bowlerName || ''), fielder: str(r.fielderName || ''),
        runs: num(r.runs), balls: num(r.balls), mins: mins, fours: num(r.fours), sixes: num(r.sixes),
        sr: sr(num(r.runs), num(r.balls)), out: !!r.out
      };
    });
    var batted = {};
    batting.forEach(function (b) { batted[lower(b.name)] = 1; });
    var toBat = (teamObj.players || []).map(function (p) { return p.name; })
      .filter(function (n) { return n && !batted[lower(n)]; });

    var bowling = (inn.bowling || []).map(function (r, i) {
      var mine = iballs.filter(function (b) { return sameName(b.bowler, r.name); });
      var dots = 0, wd = 0, nb = 0, fours = 0, sixes = 0;
      mine.forEach(function (b) {
        var t = b.ballType;
        if (t === 'PEN' || t === 'OUT') return;
        if (t === 'Wd' || t === 'WdW') { wd++; return; }
        if (t === 'Nb' || t === 'NbW') { nb++; if (isFour(b)) fours++; if (isSix(b)) sixes++; return; }
        if (t === '4') fours++;
        if (t === '6') sixes++;
        var f = b.bowlerFacts;
        var conceded = f ? num(f.runs) : (['B', 'LB', 'W'].indexOf(t) >= 0 ? 0 : num(b.runs));
        if (!conceded) dots++;
      });
      var balls = oversToBalls(r.overs);
      return {
        no: i + 1, name: str(r.name), type: str(r.type || ''), overs: str(r.overs || '0.0'), ballsBowled: balls,
        maidens: num(r.maidens), runs: num(r.runs), wickets: num(r.wickets),
        dots: r.dots != null ? num(r.dots) : dots, nb: r.noBalls != null ? num(r.noBalls) : nb, wd: r.wides != null ? num(r.wides) : wd,
        fours: fours, sixes: sixes, econ: fixed(rate(num(r.runs), balls), 2),
        captain: sameName(oppObj.captain, r.name)
      };
    });

    var ex = inn.extras || {};
    var extras = { b: num(ex.b), lb: num(ex.lb), wd: num(ex.wd), nb: num(ex.nb), pen: num(ex.pen) };
    extras.total = extras.b + extras.lb + extras.wd + extras.nb + extras.pen;

    // Fall of wickets — the name comes from the wicket deliveries, in order.
    var wkBalls = iballs.filter(function (b) { return b.isWicket; });
    var prev = 0;
    var fow = (inn.fow || []).slice().sort(function (a, b) { return num(a.wkt) - num(b.wkt); }).map(function (f, i) {
      var wb = wkBalls[i];
      var row = { no: num(f.wkt) || i + 1, runs: num(f.runs), over: str(f.over), name: wb ? str(wb.dismissedPlayer || wb.striker) : '', partnership: num(f.runs) - prev };
      prev = num(f.runs);
      return row;
    });

    // Score after every over (the worm), wickets marked where they fell.
    // A delivery's over label is "over.ball" (8.6 = the 6th ball of the 9th
    // over), so each over closes at the score after its last delivery.
    var bpo = inp.ballsPerOver || 6;
    var perOver = {}, wkts = [], runsNow = 0;
    iballs.forEach(function (b) {
      var sa = str(b.scoreAfter).split('-');
      if (sa[0] !== '') runsNow = num(sa[0]);
      var p = str(b.over).split('.');
      var o = parseInt(p[0], 10) || 0, ball = parseInt(p[1], 10) || 0;
      perOver[o] = runsNow;
      if (b.isWicket) wkts.push({ x: o + ball / bpo, runs: runsNow });
    });
    var worm = [{ over: 0, runs: 0 }];
    Object.keys(perOver).map(Number).sort(function (a, b) { return a - b; }).forEach(function (o) { worm.push({ over: o + 1, runs: perOver[o] }); });
    if (iballs.length) {
      // an over still in progress ends where its last ball was
      var lp = str(iballs[iballs.length - 1].over).split('.');
      var lastBall = parseInt(lp[1], 10) || 0;
      if (lastBall > 0 && lastBall < bpo) worm[worm.length - 1].over = (parseInt(lp[0], 10) || 0) + lastBall / bpo;
    }

    // Partnerships — every spell two batters spent together, in order.
    var parts = [], cur = null, wk = 0;
    iballs.forEach(function (b) {
      if (b.ballType === 'PEN' || !b.striker || !b.nonStriker) return;
      var key = [lower(b.striker), lower(b.nonStriker)].sort().join('|');
      if (!cur || cur.key !== key) {
        if (cur) parts.push(cur);
        cur = { key: key, a: str(b.striker), b: str(b.nonStriker), runs: 0, balls: 0, wkt: wk + 1, unbroken: false };
      }
      cur.runs += num(b.runs);
      if (['Wd', 'WdW', 'Nb', 'NbW', 'OUT'].indexOf(b.ballType) < 0) cur.balls++;
      if (b.isWicket) wk++;
    });
    if (cur) { cur.unbroken = !iballs[iballs.length - 1].isWicket; parts.push(cur); }
    parts.forEach(function (p) { delete p.key; });

    var overs = str(inn.overs || '0.0');
    var legal = oversToBalls(overs, inp.ballsPerOver);
    var topBat = batting.slice().sort(function (a, b) { return b.runs - a.runs || a.balls - b.balls; })[0] || null;
    var topBowl = bowling.slice().sort(function (a, b) { return b.wickets - a.wickets || a.runs - b.runs; })[0] || null;
    return {
      no: inn.no, team: team, teamName: str(teamObj.name || ('Team ' + team)), teamShort: str(teamObj.short || teamObj.name || team),
      color: teamObj.color || '', label: (ORDINAL[inn.no - 1] || ('Innings ' + inn.no)) + ' Innings',
      runs: num(inn.runs), wickets: num(inn.wickets), overs: overs, declared: !!inn.declared,
      crr: fixed(rate(num(inn.runs), legal), 2), captain: str(teamObj.captain || ''),
      start: start, end: end, startText: clockText(start), endText: clockText(end),
      minutes: start && end ? Math.round((end - start) / 60000) : null,
      batting: batting, bowling: bowling, toBat: toBat, extras: extras, fow: fow, worm: worm, wormWickets: wkts, partnerships: parts,
      topBat: topBat && topBat.runs > 0 ? topBat.name : null,
      topBowl: topBowl && (topBowl.wickets > 0 || topBowl.ballsBowled > 0) ? topBowl.name : null
    };
  }

  function buildModel(inp) {
    inp = inp || {};
    var balls = (inp.balls || []).filter(isRegulation);
    var teams = { A: inp.teams && inp.teams.A || { name: 'Team A' }, B: inp.teams && inp.teams.B || { name: 'Team B' } };
    ['A', 'B'].forEach(function (k) {
      var t = teams[k];
      teams[k] = {
        key: k, name: str(t.name || ('Team ' + k)), short: str(t.short || t.name || k), color: t.color || '', logo: str(t.logo || ''),
        captain: str(t.captain || ''), keeper: str(t.keeper || ''),
        players: (t.players || []).filter(function (p) { return p && p.name; }).map(function (p) { return { name: str(p.name), role: p.role || '' }; })
      };
    });
    var innings = (inp.innings || []).map(function (inn, i) { return buildInnings(inp, inn, balls, i); });
    var times = balls.map(function (b) { return num(b.timestamp); }).filter(function (t) { return t > 0; });
    var first = times.length ? Math.min.apply(null, times) : null;
    var iso = /^\d{4}-\d{2}-\d{2}$/.test(inp.date || '') ? inp.date : (first ? isoOf(first) : isoOf(inp.generatedAt || Date.now()));
    var tossTeam = inp.toss && teams[inp.toss.team];
    var toss = tossTeam ? tossTeam.name + ' won the toss and chose to ' + ((inp.toss.decision === 'BOWL') ? 'field' : 'bat') : '';

    // Best performers across the match (a Test batter's two innings add up).
    var bat = {}, bowl = {}, field = {};
    innings.forEach(function (inn) {
      var oppKey = inn.team === 'A' ? 'B' : 'A';
      inn.batting.forEach(function (b) {
        var k = inn.team + '|' + lower(b.name);
        var e = bat[k] || (bat[k] = { name: b.name, team: inn.team, teamShort: teams[inn.team].short, runs: 0, balls: 0, fours: 0, sixes: 0, outs: 0 });
        e.runs += b.runs; e.balls += b.balls; e.fours += b.fours; e.sixes += b.sixes; if (b.out) e.outs++;
        if (b.out && b.fielder && /CAUGHT|RUN OUT|STUMPED/.test(b.howOut)) {
          var fk = oppKey + '|' + lower(b.fielder);
          field[fk] = (field[fk] || 0) + 1;
        }
      });
      inn.bowling.forEach(function (b) {
        var k = oppKey + '|' + lower(b.name);
        var e = bowl[k] || (bowl[k] = { name: b.name, team: oppKey, teamShort: teams[oppKey].short, balls: 0, maidens: 0, runs: 0, wickets: 0 });
        e.balls += b.ballsBowled; e.maidens += b.maidens; e.runs += b.runs; e.wickets += b.wickets;
      });
    });
    var batters = Object.keys(bat).map(function (k) { var e = bat[k]; e.sr = sr(e.runs, e.balls); return e; })
      .sort(function (a, b) { return b.runs - a.runs || a.balls - b.balls; });
    var bowlers = Object.keys(bowl).map(function (k) { var e = bowl[k]; e.overs = ballsToOvers(e.balls); e.econ = fixed(rate(e.runs, e.balls), 2); return e; })
      .filter(function (e) { return e.balls > 0 || e.wickets > 0; })
      .sort(function (a, b) { return b.wickets - a.wickets || a.runs - b.runs || b.balls - a.balls; });

    // Player of the match — runs, wickets and dismissals made, a nudge for the winners.
    var winner = inp.result && inp.result.winner;
    var cand = {};
    function cnd(team, name) { var k = team + '|' + lower(name); return cand[k] || (cand[k] = { name: name, team: team, pts: 0, bat: null, bowl: null, field: 0 }); }
    batters.forEach(function (b) { var c = cnd(b.team, b.name); c.bat = b; c.pts += b.runs + (b.balls >= 10 && b.runs * 100 / b.balls >= 150 ? 8 : 0); });
    bowlers.forEach(function (b) { var c = cnd(b.team, b.name); c.bowl = b; c.pts += b.wickets * 22 + b.maidens * 4; });
    Object.keys(field).forEach(function (k) { var c = cand[k]; if (c) { c.field = field[k]; c.pts += field[k] * 6; } });
    var star = Object.keys(cand).map(function (k) { var c = cand[k]; if (winner === c.team) c.pts *= 1.15; return c; })
      .sort(function (a, b) { return b.pts - a.pts || ((b.bat && b.bat.runs) || 0) - ((a.bat && a.bat.runs) || 0); })[0] || null;
    if (star && star.pts <= 0) star = null;
    if (star) star.teamName = teams[star.team].name;

    // Match in numbers, per batting side.
    var numbers = {};
    ['A', 'B'].forEach(function (k) {
      var mine = innings.filter(function (i) { return i.team === k; });
      var dots = 0, legal = 0;
      balls.forEach(function (b) {
        if (b.battingTeam !== k) return;
        var t = b.ballType;
        if (t === 'PEN' || t === 'OUT' || t === 'Wd' || t === 'WdW' || t === 'Nb' || t === 'NbW') return;
        legal++;
        if (!num(b.runs)) dots++;
      });
      numbers[k] = {
        runs: mine.reduce(function (s, i) { return s + i.runs; }, 0),
        fours: mine.reduce(function (s, i) { return s + i.batting.reduce(function (t, b) { return t + b.fours; }, 0); }, 0),
        sixes: mine.reduce(function (s, i) { return s + i.batting.reduce(function (t, b) { return t + b.sixes; }, 0); }, 0),
        extras: mine.reduce(function (s, i) { return s + i.extras.total; }, 0),
        dots: dots, dotPct: legal ? Math.round(dots * 100 / legal) : 0
      };
    });

    // Wagon wheels: each team, and the match's top scorer.
    var wagon = { A: wagonOf(balls, { team: 'A' }), B: wagonOf(balls, { team: 'B' }) };
    var starBat = null;
    batters.some(function (b) {
      var w = wagonOf(balls, { team: b.team, batter: b.name, hand: (inp.hands || {})[b.name] === 'L' ? 'L' : 'R' });
      if (w.mapped) { starBat = { name: b.name, team: b.team, teamName: teams[b.team].name, bat: b, hand: w.hand, wheel: w }; return true; }
      return false;
    });
    wagon.star = starBat;
    wagon.scoringShots = wagon.A.scoringShots + wagon.B.scoringShots;
    wagon.mapped = wagon.A.mapped + wagon.B.mapped;

    return {
      generatedAt: inp.generatedAt || Date.now(),
      meta: {
        title: teams.A.name + ' vs ' + teams.B.name,
        tournament: str(inp.tournament || ''), matchTitle: str(inp.matchTitle || ''),
        date: iso, dateText: dateText(iso), dayPart: dayPart(first), start: first,
        venue: str(inp.venue || ''), format: str(inp.format || ''), oversLimit: inp.oversLimit || null,
        toss: toss, result: str(inp.result && inp.result.text || ''), winner: winner || null
      },
      teams: teams, innings: innings,
      best: { batters: batters.slice(0, 3), bowlers: bowlers.slice(0, 3) },
      star: star, numbers: numbers, wagon: wagon
    };
  }

  /* ---------- the wagon wheel picture (canvas) ----------
     A dark card: the ground with mowing stripes, each region shaded by how
     many runs went there, every shot as a line from the bat (white 1-3s,
     gold fours, red sixes), the run total of each region on the field,
     fielding positions round the rope, and a legend with the off/leg split.
     Returns { dataUrl, width, height } in CSS pixels (drawn at 2x). */
  var WHEEL = { bg: '#0B1220', rim: '#123A1F', grassIn: '#5DB33A', grassOut: '#2F7D1E', heat: '250,204,21',
    run: 'rgba(255,255,255,0.8)', four: '#FACC15', six: '#FF4D6D', gold: '#E8B931', dim: 'rgba(226,232,240,0.72)' };
  function hexRgb(hex) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str(hex).trim());
    if (!m) return null;
    var h = m[1].length === 3 ? m[1].replace(/./g, function (c) { return c + c; }) : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function drawWagonWheel(canvas, wheel, opts) {
    opts = opts || {};
    var S = opts.size || 440, LEG = 96, W = S, H = S + LEG, dpr = 2;
    canvas.width = W * dpr; canvas.height = H * dpr;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var font = function (px, bold) { return (bold ? '700 ' : '500 ') + px + 'px "Segoe UI", -apple-system, Helvetica, Arial, sans-serif'; };
    var hand = wheel && wheel.hand === 'L' ? 'L' : 'R';
    var shots = (wheel && wheel.shots) || [];

    ctx.fillStyle = WHEEL.bg; roundRect(ctx, 0, 0, W, H, 18); ctx.fill();
    var cx = W / 2, cy = S / 2 + 6, R = S * 0.37, k = R / 100;
    var P = function (x, y) { return [cx + x * k, cy + y * k]; };
    var ang = function (deg) { return (deg - 90) * Math.PI / 180; }; // field degrees → canvas radians

    // ground
    ctx.fillStyle = WHEEL.rim; ctx.beginPath(); ctx.arc(cx, cy, R * 1.075, 0, Math.PI * 2); ctx.fill();
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, WHEEL.grassIn); g.addColorStop(1, WHEEL.grassOut);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    for (var s = 0; s < 16; s += 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, ang(s * 22.5), ang((s + 1) * 22.5)); ctx.closePath(); ctx.fill();
    }
    // regions, shaded by runs
    var maxRuns = 0;
    ZONES.forEach(function (z) { var zr = wheel && wheel.zones && wheel.zones[z.id]; if (zr && zr.runs > maxRuns) maxRuns = zr.runs; });
    ZONES.forEach(function (z) {
      var zr = wheel && wheel.zones && wheel.zones[z.id], rg = zoneRange(z, hand);
      if (zr && zr.runs > 0 && maxRuns) {
        ctx.fillStyle = 'rgba(' + WHEEL.heat + ',' + (0.08 + 0.34 * zr.runs / maxRuns).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(cx, cy, R, ang(rg[0]), ang(rg[1])); ctx.arc(cx, cy, 18 * k, ang(rg[1]), ang(rg[0]), true); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
      var a = polar(18, rg[0]), b = polar(100, rg[0]);
      ctx.beginPath(); ctx.moveTo(P(a[0], a[1])[0], P(a[0], a[1])[1]); ctx.lineTo(P(b[0], b[1])[0], P(b[0], b[1])[1]); ctx.stroke();
    });
    ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(cx, cy, R_IN * k, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    // pitch
    ctx.fillStyle = '#D9BC86'; ctx.fillRect(cx - 4.2 * k, cy - 15 * k, 8.4 * k, 30 * k);
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 5.5 * k, cy - 11.5 * k); ctx.lineTo(cx + 5.5 * k, cy - 11.5 * k);
    ctx.moveTo(cx - 5.5 * k, cy + 11.5 * k); ctx.lineTo(cx + 5.5 * k, cy + 11.5 * k); ctx.stroke();

    // shots: singles first, sixes on top
    var b0 = P(BAT[0], BAT[1]);
    var order = shots.slice().sort(function (a, b) { return (a.six ? 2 : a.four ? 1 : 0) - (b.six ? 2 : b.four ? 1 : 0); });
    order.forEach(function (sh) {
      var e = P(sh.x, sh.y);
      ctx.strokeStyle = sh.six ? WHEEL.six : sh.four ? WHEEL.four : WHEEL.run;
      ctx.lineWidth = sh.six ? 2.6 : sh.four ? 2.2 : 1.3;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(b0[0], b0[1]);
      if (sh.six) ctx.quadraticCurveTo((b0[0] + e[0]) / 2 + (e[1] - b0[1]) * 0.16, (b0[1] + e[1]) / 2 - (e[0] - b0[0]) * 0.16, e[0], e[1]);
      else ctx.lineTo(e[0], e[1]);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(e[0], e[1], sh.six || sh.four ? 3 : 2.2, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = '#FFFFFF'; ctx.strokeStyle = '#16A34A'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(b0[0], b0[1], 3.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    // run total of each region, on the field
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ZONES.forEach(function (z) {
      var zr = wheel && wheel.zones && wheel.zones[z.id];
      var rg = zoneRange(z, hand), mid = (rg[0] + rg[1]) / 2;
      if (zr && zr.runs > 0) {
        var p = polar(76, mid), q = P(p[0], p[1]);
        var label = String(zr.runs);
        ctx.font = font(13, true);
        var tw = Math.max(26, ctx.measureText(label).width + 14);
        ctx.fillStyle = 'rgba(11,18,32,0.78)'; roundRect(ctx, q[0] - tw / 2, q[1] - 10, tw, 20, 10); ctx.fill();
        ctx.fillStyle = '#FFFFFF'; ctx.fillText(label, q[0], q[1] + 0.5);
      }
      // fielding position round the rope
      var o = polar(114, mid), t = P(o[0], o[1]);
      ctx.font = font(10, false); ctx.fillStyle = WHEEL.dim;
      ctx.fillText(z.name, t[0], t[1]);
    });
    ctx.font = font(9, true); ctx.fillStyle = WHEEL.gold;
    ctx.textAlign = 'left'; ctx.fillText(hand === 'L' ? 'LEG SIDE' : 'OFF SIDE', 14, 16);
    ctx.textAlign = 'right'; ctx.fillText(hand === 'L' ? 'OFF SIDE' : 'LEG SIDE', W - 14, 16);
    ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(226,232,240,0.5)';
    ctx.fillText(hand === 'L' ? 'LEFT-HANDED VIEW' : (opts.mirrored ? 'RIGHT-HANDED VIEW' : 'RIGHT-HANDED'), W / 2, 16);

    if (!shots.length) {
      ctx.fillStyle = 'rgba(11,18,32,0.82)'; roundRect(ctx, cx - 92, cy - 18, 184, 36, 18); ctx.fill();
      ctx.fillStyle = '#FFFFFF'; ctx.font = font(13, true); ctx.textAlign = 'center';
      ctx.fillText('No shots marked', cx, cy + 0.5);
    }

    // legend
    var y0 = S + 14;
    var ones = shots.filter(function (x) { return !x.four && !x.six; }).length;
    var items = [[WHEEL.run, '1s-3s', ones], [WHEEL.four, 'Fours', wheel ? wheel.fours : 0], [WHEEL.six, 'Sixes', wheel ? wheel.sixes : 0]];
    var colW = (W - 28) / 3;
    items.forEach(function (it, i) {
      var x = 14 + colW * i;
      ctx.fillStyle = 'rgba(255,255,255,0.06)'; roundRect(ctx, x + 2, y0, colW - 4, 30, 9); ctx.fill();
      ctx.fillStyle = it[0]; ctx.beginPath(); ctx.arc(x + 16, y0 + 15, 5, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = 'left'; ctx.font = font(11.5, false); ctx.fillStyle = WHEEL.dim; ctx.fillText(it[1], x + 27, y0 + 15.5);
      ctx.textAlign = 'right'; ctx.font = font(15, true); ctx.fillStyle = '#FFFFFF'; ctx.fillText(String(it[2]), x + colW - 12, y0 + 15.5);
    });
    var by = y0 + 44, bw = W - 28, off = wheel && wheel.runs ? wheel.offRuns / wheel.runs : 0.5;
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; roundRect(ctx, 14, by, bw, 8, 4); ctx.fill();
    if (wheel && wheel.runs) {
      ctx.fillStyle = WHEEL.gold; roundRect(ctx, 14, by, Math.max(8, bw * off), 8, 4); ctx.fill();
      ctx.fillStyle = '#38BDF8'; roundRect(ctx, 14 + bw * off, by, Math.max(8, bw * (1 - off)), 8, 4); ctx.fill();
    }
    ctx.font = font(10.5, true); ctx.textAlign = 'left'; ctx.fillStyle = WHEEL.gold;
    ctx.fillText('OFF ' + (wheel ? wheel.offPct : 0) + '%', 14, by + 22);
    ctx.textAlign = 'right'; ctx.fillStyle = '#38BDF8';
    ctx.fillText((wheel ? wheel.legPct : 0) + '% LEG', W - 14, by + 22);
    ctx.textAlign = 'center'; ctx.font = font(10.5, false); ctx.fillStyle = WHEEL.dim;
    var cov = wheel ? (wheel.mapped + ' of ' + wheel.scoringShots + ' scoring shots placed · ' + wheel.runs + ' runs') : '';
    ctx.fillText(cov, W / 2, by + 22);
    return { dataUrl: canvas.toDataURL('image/png'), width: W, height: H };
  }

  /* ---------- the scorecard workbook (ExcelJS) ----------
     Sheet "Scorecard" follows the club's own paper scoresheet: per
     innings, batting (No, Batsmen, How out, Bowler, Runs, Balls, Mins, 4's,
     6's) beside bowling (No, Bowlers, Type, Over, Maiden, Runs, Wkt, NB,
     WB), the extras breakdown, totals, start/end time and the fall of
     wickets with partnerships. Sheet "Wagon Wheel" adds where the runs
     went: both teams and the top scorer, picture + region table. */
  var XC = { navy: 'FF0B1220', green: 'FF14532D', green2: 'FF1F6B3B', gold: 'FFB8862E', goldFill: 'FFFBF1DE',
    zebra: 'FFF5F7FA', white: 'FFFFFFFF', ink: 'FF111827', dim: 'FF6B7280', line: 'FFD9DEE5', soft: 'FFEFF6F1', red: 'FFB2554A' };
  var XF = 'Calibri';
  function argbOf(hex, fallback) {
    var c = hexRgb(hex);
    if (!c) return fallback;
    // too light to carry white text → fall back
    if ((c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 > 175) return fallback;
    return 'FF' + c.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('').toUpperCase();
  }
  function xBorder(c) { var s = { style: 'thin', color: { argb: c || XC.line } }; return { top: s, left: s, bottom: s, right: s }; }
  function xFill(a) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: a } }; }
  function xCell(ws, r, c, v, st) {
    var cell = ws.getCell(r, c);
    if (v !== undefined) cell.value = v;
    st = st || {};
    cell.font = { name: XF, size: st.size || 10.5, bold: !!st.bold, italic: !!st.italic, color: { argb: st.color || XC.ink } };
    if (st.fill) cell.fill = xFill(st.fill);
    cell.alignment = { horizontal: st.align || (typeof v === 'number' ? 'center' : 'left'), vertical: 'middle', wrapText: !!st.wrap, indent: st.indent || 0 };
    if (st.border !== false) cell.border = xBorder(st.borderColor);
    if (st.numFmt) cell.numFmt = st.numFmt;
    return cell;
  }
  function xMerge(ws, r1, c1, r2, c2, v, st) {
    if (r1 !== r2 || c1 !== c2) ws.mergeCells(r1, c1, r2, c2);
    var cell = xCell(ws, r1, c1, v, st);
    if (st && st.fill) for (var r = r1; r <= r2; r++) for (var c = c1; c <= c2; c++) { var x = ws.getCell(r, c); x.fill = xFill(st.fill); if (st.border !== false) x.border = xBorder(st.borderColor); }
    return cell;
  }
  function timeValue(ts) { if (!ts) return ''; var d = new Date(ts); return (d.getHours() * 60 + d.getMinutes()) / 1440; }
  function oversNumber(o) { var n = parseFloat(str(o)); return isFinite(n) ? n : 0; }

  function excelScorecardSheet(wb, m) {
    var ws = wb.addWorksheet('Scorecard', { properties: { tabColor: { argb: XC.green } }, views: [{ showGridLines: false }] });
    [6, 26, 17, 22, 11, 10, 8, 9, 10, 3, 5, 24, 8, 8, 9, 8, 7, 6, 6].forEach(function (w, i) { ws.getColumn(i + 1).width = w; });
    ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
    var A = m.teams.A, B = m.teams.B;
    // header — the match, the day, the ground
    xMerge(ws, 1, 1, 1, 19, (A.name + '  vs  ' + B.name).toUpperCase(), { size: 18, bold: true, color: XC.white, fill: XC.navy, align: 'center', border: false });
    ws.getRow(1).height = 34;
    var sub = [m.meta.tournament, m.meta.matchTitle].filter(Boolean).join('  ·  ') || 'MATCH SCORECARD';
    xMerge(ws, 2, 1, 2, 19, sub.toUpperCase(), { size: 12, bold: true, color: XC.white, fill: XC.green, align: 'center', border: false });
    ws.getRow(2).height = 22;
    var L = { bold: true, color: XC.dim, size: 9.5, fill: XC.zebra }, V = { bold: true, size: 11, fill: XC.white };
    xCell(ws, 3, 1, '', L); xCell(ws, 3, 2, 'DATE', L); xMerge(ws, 3, 3, 3, 4, m.meta.dateText || m.meta.date, V);
    xMerge(ws, 3, 5, 3, 6, 'MATCH', L); xMerge(ws, 3, 7, 3, 9, m.meta.dayPart ? m.meta.dayPart.toUpperCase() + ' MATCH' : '—', V);
    xMerge(ws, 3, 11, 3, 12, 'FORMAT', L); xMerge(ws, 3, 13, 3, 19, [m.meta.format, m.meta.oversLimit ? m.meta.oversLimit + ' overs' : ''].filter(Boolean).join(' · ') || '—', V);
    xCell(ws, 4, 1, '', L); xCell(ws, 4, 2, 'GROUND', L); xMerge(ws, 4, 3, 4, 9, m.meta.venue || '—', V);
    xMerge(ws, 4, 11, 4, 12, 'TOSS', L); xMerge(ws, 4, 13, 4, 19, m.meta.toss || '—', V);
    xCell(ws, 5, 1, '', { fill: XC.goldFill }); xCell(ws, 5, 2, 'RESULT', { bold: true, color: XC.gold, size: 9.5, fill: XC.goldFill });
    xMerge(ws, 5, 3, 5, 19, m.meta.result || 'Match in progress', { bold: true, size: 12, fill: XC.goldFill });
    [3, 4].forEach(function (r) { ws.getRow(r).height = 19; });
    ws.getRow(5).height = 22;

    var row = 7;
    m.innings.forEach(function (inn) {
      var teamFill = argbOf(inn.color, XC.green);
      // innings band: team, which innings, start and end time, the score
      xMerge(ws, row, 1, row, 3, inn.teamName.toUpperCase(), { bold: true, size: 13, color: XC.white, fill: teamFill, border: false, indent: 1 });
      xCell(ws, row, 4, inn.label.toUpperCase().replace(' INNINGS', ' INNING'), { bold: true, color: XC.white, fill: teamFill, border: false });
      xCell(ws, row, 5, 'Start Time', { bold: true, size: 9, color: XC.white, fill: teamFill, border: false, align: 'right' });
      xCell(ws, row, 6, inn.start ? timeValue(inn.start) : '—', { bold: true, color: XC.white, fill: teamFill, border: false, numFmt: 'h:mm AM/PM', align: 'center' });
      xCell(ws, row, 7, '', { fill: teamFill, border: false });
      xCell(ws, row, 8, 'End Time', { bold: true, size: 9, color: XC.white, fill: teamFill, border: false, align: 'right' });
      xCell(ws, row, 9, inn.end ? timeValue(inn.end) : '—', { bold: true, color: XC.white, fill: teamFill, border: false, numFmt: 'h:mm AM/PM', align: 'center' });
      var scoreText = inn.runs + '/' + inn.wickets + (inn.declared ? 'd' : '') + '  (' + inn.overs + ' Ov)   ·   CRR ' + inn.crr;
      xMerge(ws, row, 11, row, 19, scoreText, { bold: true, size: 13, color: XC.white, fill: teamFill, border: false, align: 'right', indent: 1 });
      ws.getRow(row).height = 26;
      row++;
      xMerge(ws, row, 1, row, 9, 'Batting Scorecard', { bold: true, color: XC.green, fill: XC.soft, border: false });
      xMerge(ws, row, 11, row, 19, 'Bowling Scorecard', { bold: true, color: XC.green, fill: XC.soft, border: false });
      row++;
      var H = { bold: true, color: XC.white, fill: XC.navy, align: 'center', size: 10, borderColor: XC.navy };
      ['No', 'Batsmen', 'How out', 'Bowler', 'Runs', 'Balls', 'Mins', "4's", "6's"].forEach(function (h, i) { xCell(ws, row, i + 1, h, H); });
      ['No', 'Bowlers', 'TYPE', 'OVER', 'MAIDEN', 'RUNS', 'WKT', 'NB', 'WB'].forEach(function (h, i) { xCell(ws, row, i + 11, h, H); });
      ws.getRow(row).height = 20;
      row++;
      var first = row;
      var nBat = inn.batting.length, nBowl = inn.bowling.length + 1;
      inn.batting.forEach(function (b, i) {
        var top = inn.topBat === b.name;
        var st = { fill: top ? XC.goldFill : (i % 2 ? XC.zebra : XC.white), bold: top };
        xCell(ws, first + i, 1, b.no, st);
        xCell(ws, first + i, 2, b.name.toUpperCase() + (b.captain ? ' (C)' : '') + (b.keeper ? ' (WK)' : ''), Object.assign({}, st, { bold: true }));
        xCell(ws, first + i, 3, b.howOut, Object.assign({}, st, { size: 9.5, color: b.out ? XC.ink : XC.green, bold: !b.out || top }));
        xCell(ws, first + i, 4, b.bowler ? b.bowler.toUpperCase() : (b.howOut === 'RUN OUT' && b.fielder ? '(' + b.fielder.toUpperCase() + ')' : ''), Object.assign({}, st, { size: 9.5 }));
        xCell(ws, first + i, 5, b.runs, Object.assign({}, st, { bold: true }));
        xCell(ws, first + i, 6, b.balls, st);
        xCell(ws, first + i, 7, b.mins == null ? '' : b.mins, st);
        xCell(ws, first + i, 8, b.fours, st);
        xCell(ws, first + i, 9, b.sixes, st);
      });
      inn.bowling.forEach(function (w, i) {
        var top = inn.topBowl === w.name;
        var st = { fill: top ? XC.goldFill : (i % 2 ? XC.zebra : XC.white), bold: top };
        xCell(ws, first + i, 11, w.no, st);
        xCell(ws, first + i, 12, w.name.toUpperCase() + (w.captain ? ' (C)' : ''), Object.assign({}, st, { bold: true }));
        xCell(ws, first + i, 13, w.type || '', st);
        xCell(ws, first + i, 14, oversNumber(w.overs), Object.assign({}, st, { numFmt: '0.0' }));
        xCell(ws, first + i, 15, w.maidens, st);
        xCell(ws, first + i, 16, w.runs, st);
        xCell(ws, first + i, 17, w.wickets, Object.assign({}, st, { bold: true }));
        xCell(ws, first + i, 18, w.nb, st);
        xCell(ws, first + i, 19, w.wd, st);
      });
      // byes, leg byes and penalty runs belong to no bowler
      var er = first + inn.bowling.length, other = inn.extras.b + inn.extras.lb + inn.extras.pen;
      var est = { italic: true, color: XC.dim, fill: XC.zebra, size: 9.5 };
      xCell(ws, er, 11, '', est); xCell(ws, er, 12, 'LB, B, R/O Etc', est); xCell(ws, er, 13, '', est); xCell(ws, er, 14, '', est); xCell(ws, er, 15, '', est);
      xCell(ws, er, 16, other, Object.assign({}, est, { italic: false, color: XC.ink })); xCell(ws, er, 17, '', est); xCell(ws, er, 18, '', est); xCell(ws, er, 19, '', est);
      var dataEnd = Math.max(first + nBat - 1, first + nBowl - 1);
      var tr = first + nBowl;
      var T = { bold: true, fill: XC.goldFill, borderColor: XC.gold };
      var sumRow = function (col, result) { var L2 = String.fromCharCode(64 + col); return { formula: 'SUM(' + L2 + first + ':' + L2 + er + ')', result: result }; };
      xCell(ws, tr, 11, '', T); xCell(ws, tr, 12, 'TOTAL', T); xCell(ws, tr, 13, '', T);
      xCell(ws, tr, 14, oversNumber(inn.overs), Object.assign({}, T, { numFmt: '0.0' }));
      xCell(ws, tr, 15, sumRow(15, inn.bowling.reduce(function (s, w) { return s + w.maidens; }, 0)), T);
      xCell(ws, tr, 16, sumRow(16, inn.bowling.reduce(function (s, w) { return s + w.runs; }, 0) + other), T);
      xCell(ws, tr, 17, sumRow(17, inn.bowling.reduce(function (s, w) { return s + w.wickets; }, 0)), T);
      xCell(ws, tr, 18, sumRow(18, inn.bowling.reduce(function (s, w) { return s + w.nb; }, 0)), T);
      xCell(ws, tr, 19, sumRow(19, inn.bowling.reduce(function (s, w) { return s + w.wd; }, 0)), T);
      row = Math.max(dataEnd, tr) + 2;

      // extras + totals (the paper sheet's bottom-left block)
      var xr = row;
      var exList = [['B', inn.extras.b], ['LB', inn.extras.lb], ['Wd', inn.extras.wd], ['Nb', inn.extras.nb]];
      if (inn.extras.pen) exList.push(['Pen', inn.extras.pen]);
      exList.forEach(function (e, i) { xCell(ws, xr + i, 2, e[0] + ' - ' + e[1], { bold: true, fill: XC.zebra, color: XC.dim }); });
      var batSum = inn.batting.reduce(function (s, b) { return s + b.runs; }, 0);
      var tot = [['Extras', inn.extras.total], ['Total', { formula: 'SUM(E' + first + ':E' + (first + Math.max(nBat, 1) - 1) + ')+E' + xr, result: batSum + inn.extras.total }],
        ['Wickets', inn.wickets], ['Overs', oversNumber(inn.overs)], ['Total Min', inn.minutes == null ? '' : inn.minutes]];
      tot.forEach(function (t, i) {
        var hi = t[0] === 'Total';
        xCell(ws, xr + i, 4, t[0], { bold: true, fill: hi ? XC.goldFill : XC.zebra, borderColor: hi ? XC.gold : undefined });
        xCell(ws, xr + i, 5, t[1], { bold: true, fill: hi ? XC.goldFill : XC.white, borderColor: hi ? XC.gold : undefined, numFmt: t[0] === 'Overs' ? '0.0' : undefined, align: 'center' });
      });
      row = xr + Math.max(exList.length, tot.length) + 1;

      // fall of wickets
      xMerge(ws, row, 1, row, 5, 'FALL OF WICKET', { bold: true, color: XC.green, fill: XC.soft, border: false });
      row++;
      ['No', 'Runs', 'Over No', 'Name of Batsmen Out', 'Partnership'].forEach(function (h, i) { xCell(ws, row, i + 1, h, H); });
      row++;
      if (!inn.fow.length) { xMerge(ws, row, 1, row, 5, 'No wickets fell', { italic: true, color: XC.dim }); row++; }
      var bestP = Math.max.apply(null, inn.fow.map(function (f) { return f.partnership; }).concat([0]));
      inn.fow.forEach(function (f, i) {
        var st = { fill: f.partnership === bestP && bestP > 0 ? XC.goldFill : (i % 2 ? XC.zebra : XC.white) };
        xCell(ws, row, 1, f.no, st); xCell(ws, row, 2, f.runs, Object.assign({}, st, { bold: true }));
        xCell(ws, row, 3, oversNumber(f.over), Object.assign({}, st, { numFmt: '0.0' }));
        xCell(ws, row, 4, f.name.toUpperCase(), st); xCell(ws, row, 5, f.partnership, st);
        row++;
      });
      row += 3;
    });
    return ws;
  }

  function excelWagonSheet(wb, m, images) {
    var ws = wb.addWorksheet('Wagon Wheel', { properties: { tabColor: { argb: XC.gold } }, views: [{ showGridLines: false }] });
    for (var c = 1; c <= 19; c++) ws.getColumn(c).width = c === 10 ? 3 : 10.5;
    ws.pageSetup = { orientation: 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    xMerge(ws, 1, 1, 1, 19, 'WAGON WHEEL  ·  ' + m.teams.A.name.toUpperCase() + '  vs  ' + m.teams.B.name.toUpperCase(), { size: 16, bold: true, color: XC.white, fill: XC.navy, align: 'center', border: false });
    ws.getRow(1).height = 30;
    xMerge(ws, 2, 1, 2, 19, 'Where every run went  ·  gold = fours, red = sixes  ·  a team wheel shows left-handers mirrored into a right-hander’s view', { italic: true, color: XC.dim, align: 'center', border: false, fill: XC.zebra });
    var addImg = function (img, row, col, maxW) {
      if (!img || !img.dataUrl) return 0;
      var scale = Math.min(1, maxW / img.width);
      var id = wb.addImage({ base64: img.dataUrl.split(',')[1], extension: 'png' });
      ws.addImage(id, { tl: { col: col - 1, row: row - 1 }, ext: { width: img.width * scale, height: img.height * scale } });
      return Math.ceil(img.height * scale / 20) + 1;
    };
    var zoneTable = function (w, row, col, title, fill) {
      xMerge(ws, row, col, row, col + 5, title, { bold: true, color: XC.white, fill: fill, border: false, indent: 1 });
      row++;
      var H = { bold: true, color: XC.white, fill: XC.navy, align: 'center', size: 9.5, borderColor: XC.navy };
      ['Region', 'Runs', 'Shots', '4s', '6s', '% Runs'].forEach(function (h, i) { xCell(ws, row, col + i, h, H); });
      row++;
      var first = row;
      w.list.forEach(function (z, i) {
        var top = w.top && w.top.id === z.id;
        var st = { fill: top ? XC.goldFill : (i % 2 ? XC.zebra : XC.white), bold: top };
        xCell(ws, row, col, z.name, Object.assign({}, st, { bold: true }));
        xCell(ws, row, col + 1, z.runs, st); xCell(ws, row, col + 2, z.shots, st);
        xCell(ws, row, col + 3, z.fours, st); xCell(ws, row, col + 4, z.sixes, st);
        xCell(ws, row, col + 5, z.pct / 100, Object.assign({}, st, { numFmt: '0%' }));
        row++;
      });
      var colL = String.fromCharCode(64 + col + 1);
      ws.addConditionalFormatting({ ref: colL + first + ':' + colL + (row - 1), rules: [{ type: 'dataBar', gradient: false, cfvo: [{ type: 'num', value: 0 }, { type: 'max' }], color: { argb: 'FFE8B931' } }] });
      var T = { bold: true, fill: XC.goldFill, borderColor: XC.gold };
      xCell(ws, row, col, 'Off side', T); xCell(ws, row, col + 1, w.offRuns, T); xMerge(ws, row, col + 2, row, col + 5, w.offPct + '% of runs', T); row++;
      xCell(ws, row, col, 'Leg side', T); xCell(ws, row, col + 1, w.legRuns, T); xMerge(ws, row, col + 2, row, col + 5, w.legPct + '% of runs', T); row++;
      xMerge(ws, row, col, row, col + 5, w.mapped + ' of ' + w.scoringShots + ' scoring shots placed', { italic: true, color: XC.dim, border: false, size: 9 });
      return row + 1;
    };
    var fillA = argbOf(m.teams.A.color, XC.green), fillB = argbOf(m.teams.B.color, XC.green2);
    xMerge(ws, 4, 1, 4, 9, m.teams.A.name.toUpperCase() + '  ·  ' + m.wagon.A.runs + ' runs mapped', { bold: true, color: XC.white, fill: fillA, border: false, indent: 1 });
    xMerge(ws, 4, 11, 4, 19, m.teams.B.name.toUpperCase() + '  ·  ' + m.wagon.B.runs + ' runs mapped', { bold: true, color: XC.white, fill: fillB, border: false, indent: 1 });
    var h1 = addImg(images && images.A, 5, 2, 380), h2 = addImg(images && images.B, 5, 12, 380);
    var row = 5 + Math.max(h1, h2, 1) + 1;
    var endA = zoneTable(m.wagon.A, row, 2, m.teams.A.short.toUpperCase() + ' — RUNS BY REGION', fillA);
    var endB = zoneTable(m.wagon.B, row, 12, m.teams.B.short.toUpperCase() + ' — RUNS BY REGION', fillB);
    row = Math.max(endA, endB) + 2;
    var st = m.wagon.star;
    if (st) {
      var b = st.bat;
      xMerge(ws, row, 1, row, 19, 'TOP SCORER  ·  ' + st.name.toUpperCase() + ' (' + st.teamName + ')  ·  ' + b.runs + ' (' + b.balls + ')  ·  ' + b.fours + ' x 4, ' + b.sixes + ' x 6  ·  SR ' + b.sr + '  ·  ' + (st.hand === 'L' ? 'Left-handed' : 'Right-handed'),
        { bold: true, size: 12, color: XC.white, fill: XC.gold, border: false, indent: 1 });
      ws.getRow(row).height = 24;
      row++;
      var h3 = addImg(images && images.star, row + 1, 2, 380);
      zoneTable(st.wheel, row + 1, 12, st.name.toUpperCase() + ' — RUNS BY REGION', XC.gold);
      row += Math.max(h3, 14) + 2;
    } else {
      xMerge(ws, row, 1, row, 19, 'No wagon wheel shots were marked in this match — turn the wagon wheel on in Match Setup to capture where every run goes.', { italic: true, color: XC.dim, border: false });
    }
    return ws;
  }
  function buildExcel(ExcelJS, model, images) {
    var wb = new ExcelJS.Workbook();
    wb.creator = 'All Sports Live'; wb.created = new Date(model.generatedAt || Date.now());
    excelScorecardSheet(wb, model);
    excelWagonSheet(wb, model, images || {});
    return wb;
  }

  /* ---------- the PDF match report (jsPDF) ----------
     Page 1  the match at a glance: both scores, result, toss, the match in
             numbers, player of the match, best batters / bowlers, the worm
     Page 2  wagon wheels: both teams side by side + the top scorer
     Then    one scorecard page per innings (batting, extras, fall of
             wickets as a timeline, bowling) and the playing squads with the
             captains' signature block. */
  // All Sports Live — the brand on every PDF page (160px, on the report's navy).
  var BRAND = { name: 'ALL SPORTS LIVE', logo: 'data:image/jpeg;base64,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' };
  function pdfSafe(s) {
    return str(s).replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-')
      .replace(/\u2026/g, '...').replace(/\u2020\s*/g, '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
  }
  function buildPdf(JsPDF, m, images) {
    images = images || {};
    var doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    var PW = 210, PH = 297, MX = 14, CW = PW - 2 * MX;
    var C = { navy: [11, 18, 32], navy2: [24, 34, 54], green: [20, 83, 45], gold: [217, 164, 65], goldSoft: [252, 244, 226],
      ink: [15, 23, 42], dim: [100, 116, 139], line: [226, 232, 240], soft: [246, 248, 251], white: [255, 255, 255], notout: [21, 128, 61], sky: [56, 189, 248] };
    var fill = function (c) { doc.setFillColor(c[0], c[1], c[2]); };
    var draw = function (c) { doc.setDrawColor(c[0], c[1], c[2]); };
    var color = function (c) { doc.setTextColor(c[0], c[1], c[2]); };
    var font = function (size, bold) { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); };
    var fit = function (t, maxW) {
      if (doc.getTextWidth(t) <= maxW) return t;
      while (t.length > 1 && doc.getTextWidth(t + '...') > maxW) t = t.slice(0, -1);
      return t.replace(/\s+$/, '') + '...';
    };
    var T = function (s, x, y, o) {
      o = o || {};
      font(o.size || 9, o.bold); color(o.color || C.ink);
      var t = pdfSafe(s);
      if (o.maxW) t = fit(t, o.maxW);
      doc.text(t, x, y, { align: o.align || 'left' });
      return doc.getTextWidth(t);
    };
    var teamRgb = function (k) {
      var c = hexRgb(m.teams[k] && m.teams[k].color);
      var fb = k === 'A' ? [37, 99, 235] : [220, 38, 38];
      if (!c) return fb;
      if ((c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 > 185) return fb; // too pale for white text
      return c;
    };
    var cA = teamRgb('A'), cB = teamRgb('B');
    if (Math.abs(cA[0] - cB[0]) + Math.abs(cA[1] - cB[1]) + Math.abs(cA[2] - cB[2]) < 60) cB = C.gold; // two near-identical team colours
    var colOf = function (k) { return k === 'A' ? cA : cB; };
    var initials = function (t) {
      var s = str(t.short || '').trim();
      if (s && s.length <= 4) return s.toUpperCase();
      var w = str(t.name).trim().split(/\s+/).filter(Boolean);
      return (w.length > 1 ? w.slice(0, 3).map(function (x) { return x[0]; }).join('') : (w[0] || '?').slice(0, 3)).toUpperCase();
    };
    // a team's badge: its logo in a white disc ringed in the team colour
    // (images.logos[k], already cut to a circle), else its initials
    var avatar = function (k, x, y, r) {
      var lg = images.logos && images.logos[k];
      if (lg) {
        fill(colOf(k)); doc.circle(x, y, r + r * 0.12, 'F');
        fill(C.white); doc.circle(x, y, r, 'F');
        try { doc.addImage(lg, 'PNG', x - r, y - r, 2 * r, 2 * r, 'logo' + k, 'FAST'); return; } catch (e) { /* fall back to initials */ }
      }
      fill(colOf(k)); doc.circle(x, y, r, 'F');
      draw(C.white); doc.setLineWidth(0.6); doc.circle(x, y, r, 'S');
      var ini = initials(m.teams[k]);
      T(ini, x, y + r * 0.32, { size: r * (ini.length > 3 ? 1.35 : 1.7), bold: true, color: C.white, align: 'center' });
    };
    var mix = function (c, base, t) { return [0, 1, 2].map(function (i) { return Math.round(base[i] + (c[i] - base[i]) * t); }); };
    var poly = function (pts, style) {
      var segs = [];
      for (var i = 1; i < pts.length; i++) segs.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
      doc.lines(segs, pts[0][0], pts[0][1], [1, 1], style || 'F', true);
    };
    /* A team's banner: its colour on a slanted panel carrying the logo badge,
       name and a line under it, a gold edge, and the dark side for the
       numbers (o.score / o.scoreSub on the right, o.chips in the middle,
       o.right for a short note). Used for every team heading in the report. */
    var teamBanner = function (k, x, y, w, h, o) {
      o = o || {};
      var c = colOf(k), sl = Math.min(o.slant || w * 0.5, w - 10), cut = Math.min(h * 0.45, 10);
      fill(C.navy); doc.rect(x, y, w, h, 'F');
      fill(mix(c, C.navy, 0.35)); poly([[x + sl - cut + 5, y], [x + sl + 9, y], [x + sl + 9 - cut, y + h], [x + sl - 2 * cut + 5, y + h]]);
      fill(c); poly([[x, y], [x + sl, y], [x + sl - cut, y + h], [x, y + h]]);
      fill(C.gold); poly([[x + sl, y], [x + sl + 1.4, y], [x + sl + 1.4 - cut, y + h], [x + sl - cut, y + h]]);
      fill(C.gold); doc.rect(x, y + h - 0.7, w, 0.7, 'F');
      var r = Math.min(h * 0.36, 9), ax = x + r + (h - 2 * r) / 2 + 1.2;
      avatar(k, ax, y + h / 2 - 0.2, r);
      var tx = ax + r + 3.6, tw = sl - cut - (tx - x) - 2;
      var ts = o.titleSize || (h >= 20 ? 13 : h >= 14 ? 10.5 : 9);
      font(ts, true);
      while (ts > (o.minTitle || 7.5) && doc.getTextWidth(pdfSafe(m.teams[k].name)) > tw) { ts -= 0.5; font(ts, true); }
      var ty = o.sub ? y + h / 2 - 0.6 : y + h / 2 + ts * 0.13;
      T(m.teams[k].name, tx, ty, { size: ts, bold: true, color: C.white, maxW: tw });
      if (o.sub) T(o.sub, tx, ty + (h >= 20 ? 6 : 4.4), { size: h >= 20 ? 7.6 : 6.6, color: [226, 232, 240], maxW: tw });
      var rx = x + w - 4;
      if (o.score) {
        T(o.score, rx, o.scoreSub ? y + h / 2 + 1.6 : y + h / 2 + 2.6, { size: h >= 20 ? 22 : 12, bold: true, color: o.won ? C.gold : C.white, align: 'right' });
        if (o.scoreSub) T(o.scoreSub, rx, y + h / 2 + 7.4, { size: 7.4, color: [148, 163, 184], align: 'right' });
      }
      if (o.right) T(o.right, rx, y + h / 2 + 1.3, { size: 7.4, bold: true, color: [203, 213, 225], align: 'right' });
      if (o.chips && o.chips.length) {
        var cx = x + sl + 6, cw = 15.5;
        o.chips.forEach(function (ch, i) {
          var px = cx + i * (cw + 2.2);
          fill(C.navy2); doc.roundedRect(px, y + h / 2 - 6.2, cw, 12, 1.8, 1.8, 'F');
          T(String(ch[1]), px + cw / 2, y + h / 2 + 0.4, { size: 11, bold: true, color: ch[2] || C.white, align: 'center' });
          T(ch[0], px + cw / 2, y + h / 2 + 4, { size: 5.6, bold: true, color: [148, 163, 184], align: 'center' });
        });
      }
    };
    var scoreOf = function (k) {
      var inns = m.innings.filter(function (i) { return i.team === k; });
      if (!inns.length) return { main: 'Yet to bat', overs: '' };
      return {
        main: inns.map(function (i) { return i.runs + (i.wickets < 10 ? '/' + i.wickets : '') + (i.declared ? 'd' : ''); }).join(' & '),
        overs: inns.map(function (i) { return i.overs + ' ov'; }).join(' & ')
      };
    };
    var hdrTitle = [m.meta.tournament, m.meta.matchTitle].filter(Boolean).join('  ·  ');
    var logo = function (x, y, size) { try { doc.addImage(images.brandLogo || BRAND.logo, 'JPEG', x, y, size, size, 'brand', 'FAST'); } catch (e) { /* no logo, still a report */ } };
    var pageHeader = function (title) {
      fill(C.navy); doc.rect(0, 0, PW, 12, 'F');
      fill(C.gold); doc.rect(0, 12, PW, 0.8, 'F');
      logo(MX, 1.6, 8.8);
      T(BRAND.name, MX + 11, 7.8, { size: 8.5, bold: true, color: C.white });
      T(hdrTitle || m.meta.title, MX + 46, 7.8, { size: 8, color: [203, 213, 225], maxW: 100 });
      T('MATCH REPORT', PW - MX, 7.8, { size: 8, bold: true, color: C.gold, align: 'right' });
      T(title, MX, 25, { size: 16, bold: true });
      fill(C.gold); doc.rect(MX, 27.6, 16, 1.1, 'F');
      return 34;
    };
    // generic table: cols [{h, w, align}], rows [[cell, ...]], o {hi:[rowIdx], rowH, size}
    var table = function (x, y, cols, rows, o) {
      o = o || {};
      var rowH = o.rowH || 6.4, size = o.size || 8.2, w = cols.reduce(function (s, c) { return s + c.w; }, 0);
      fill(o.head || C.navy); doc.roundedRect(x, y, w, rowH + 0.6, 1.2, 1.2, 'F');
      var cx = x;
      cols.forEach(function (c) {
        var ax = c.align === 'right' ? cx + c.w - 2 : c.align === 'center' ? cx + c.w / 2 : cx + 2.2;
        T(c.h, ax, y + rowH * 0.68, { size: size - 0.6, bold: true, color: C.white, align: c.align || 'left' });
        cx += c.w;
      });
      y += rowH + 0.6;
      rows.forEach(function (r, i) {
        var hi = o.hi && o.hi.indexOf(i) >= 0;
        if (hi) { fill(C.goldSoft); doc.rect(x, y, w, rowH, 'F'); fill(C.gold); doc.rect(x, y, 0.9, rowH, 'F'); }
        else if (i % 2) { fill(C.soft); doc.rect(x, y, w, rowH, 'F'); }
        cx = x;
        cols.forEach(function (c, j) {
          var cell = r[j], txt = cell, st = {};
          if (cell && typeof cell === 'object') { txt = cell.t; st = cell; }
          var ax = c.align === 'right' ? cx + c.w - 2 : c.align === 'center' ? cx + c.w / 2 : cx + 2.2;
          T(txt == null ? '' : txt, ax, y + rowH * 0.66, { size: st.size || size, bold: st.bold != null ? st.bold : (hi && j < 2) || !!c.bold, color: st.color || C.ink, align: c.align || 'left', maxW: c.w - 3 });
          if (st.sub) {
            var tw = doc.getTextWidth(pdfSafe(txt));
            T(st.sub, ax + tw + 1.2, y + rowH * 0.66, { size: size - 2, bold: true, color: C.dim });
          }
          cx += c.w;
        });
        draw(C.line); doc.setLineWidth(0.15); doc.line(x, y + rowH, x + w, y + rowH);
        y += rowH;
      });
      return y;
    };

    doc.setProperties({ title: pdfSafe(m.meta.title + ' - Match Report'), subject: pdfSafe(hdrTitle), author: 'All Sports Live', creator: 'All Sports Live' });

    /* ---- page 1 — the match at a glance ----
       Brand strip, the tournament, then the two sides on slanted panels in
       their own colours, meeting at the VS badge. */
    var HH = 112, deep = [6, 10, 20];
    fill(C.navy); doc.rect(0, 0, PW, HH, 'F');
    fill(mix(cA, C.navy, 0.30)); poly([[0, 42], [112, 42], [98, HH], [0, HH]]);
    fill(mix(cB, C.navy, 0.30)); poly([[112, 42], [PW, 42], [PW, HH], [98, HH]]);
    fill(mix(cA, C.navy, 0.55)); poly([[0, 42], [26, 42], [12, HH], [0, HH]]);
    fill(mix(cB, C.navy, 0.55)); poly([[PW - 12, 42], [PW, 42], [PW, HH], [PW - 26, HH]]);
    fill(C.gold); poly([[110.6, 42], [113.4, 42], [99.4, HH], [96.6, HH]]);
    fill(deep); doc.rect(0, 0, PW, 24, 'F');
    fill(C.gold); doc.rect(0, 24, PW, 0.7, 'F'); doc.rect(0, HH, PW, 1.2, 'F');
    // the brand, top left; the report and its date, top right
    logo(MX, 4.5, 15);
    T(BRAND.name, MX + 19, 11, { size: 12.5, bold: true, color: C.white });
    T('Live scores  ·  highlights  ·  match reports', MX + 19, 16.4, { size: 7.2, color: [148, 163, 184] });
    draw(C.gold); doc.setLineWidth(0.4); doc.roundedRect(PW - MX - 34, 6.6, 34, 7, 3.5, 3.5, 'S');
    T('MATCH REPORT', PW - MX - 17, 11.2, { size: 7.8, bold: true, color: C.gold, align: 'center' });
    T([m.meta.dateText, m.meta.dayPart ? m.meta.dayPart + ' match' : ''].filter(Boolean).join('  ·  '), PW - MX, 19, { size: 7.4, color: [148, 163, 184], align: 'right' });
    // the tournament
    T((m.meta.tournament || 'MATCH REPORT').toUpperCase(), PW / 2, 32.5, { size: 10.5, bold: true, color: C.gold, align: 'center', maxW: CW });
    T([m.meta.matchTitle, m.meta.format, m.meta.oversLimit ? m.meta.oversLimit + ' overs' : ''].filter(Boolean).join('  ·  '), PW / 2, 38, { size: 8.2, color: [203, 213, 225], align: 'center', maxW: CW });
    var sideX = { A: 54, B: 156 };
    ['A', 'B'].forEach(function (k) {
      var x = sideX[k], t = m.teams[k], sc = scoreOf(k), won = m.meta.winner === k;
      avatar(k, x, 61, 12.5);
      if (won) { fill(C.gold); doc.roundedRect(x - 11, 45.2, 22, 5, 2.5, 2.5, 'F'); T('WINNER', x, 48.8, { size: 6.8, bold: true, color: C.navy, align: 'center' }); }
      font(10.5, true);
      var lines = doc.splitTextToSize(pdfSafe(t.name), 76).slice(0, 2);
      lines.forEach(function (ln, i) { T(ln, x, 81 + i * 4.4, { size: 10.5, bold: true, color: C.white, align: 'center' }); });
      var sy = 81 + (lines.length - 1) * 4.4 + 12;
      T(sc.main, x, sy, { size: sc.main.length > 9 ? 17 : 23, bold: true, color: won ? C.gold : C.white, align: 'center' });
      if (sc.overs) T(sc.overs, x, sy + 6, { size: 8.2, color: [203, 213, 225], align: 'center' });
    });
    // VS, the ground
    fill(deep); doc.circle(105, 66, 9, 'F');
    fill(C.gold); doc.circle(105, 66, 7.4, 'F');
    T('VS', 105, 68.3, { size: 10, bold: true, color: C.navy, align: 'center' });
    font(7.4, false);
    var ven = doc.splitTextToSize(pdfSafe(m.meta.venue || ''), 40).slice(0, 3);
    if (ven.length) {
      var vh = ven.length * 3.6 + 3.4;
      fill(deep); doc.roundedRect(105 - 23, 79, 46, vh, 2, 2, 'F');
      ven.forEach(function (ln, i) { T(ln, 105, 83.2 + i * 3.6, { size: 7.4, color: [203, 213, 225], align: 'center' }); });
    }

    var y = HH + 7;
    fill(C.goldSoft); doc.roundedRect(MX, y, CW, 12, 2, 2, 'F');
    fill(C.gold); doc.roundedRect(MX, y, 3, 12, 1.5, 1.5, 'F');
    T('RESULT', MX + 7, y + 7.6, { size: 7.5, bold: true, color: C.gold });
    T(m.meta.result || 'Match in progress', MX + 22, y + 7.9, { size: 11, bold: true, maxW: CW - 26 });
    y += 17;
    if (m.meta.toss) { T('TOSS', MX, y, { size: 7.5, bold: true, color: C.dim }); T(m.meta.toss, MX + 10, y, { size: 8.5, color: C.ink, maxW: CW - 10 }); y += 6; }

    // the match in numbers
    var tiles = [['RUNS', 'runs'], ['FOURS', 'fours'], ['SIXES', 'sixes'], ['EXTRAS', 'extras'], ['DOT BALLS', 'dotPct', '%']];
    var gap = 3, tw = (CW - gap * (tiles.length - 1)) / tiles.length, th = 25;
    T('MATCH IN NUMBERS', MX, y + 3, { size: 8, bold: true, color: C.dim });
    y += 6;
    tiles.forEach(function (t, i) {
      var x = MX + i * (tw + gap), a = m.numbers.A[t[1]] || 0, b = m.numbers.B[t[1]] || 0;
      fill(C.soft); doc.roundedRect(x, y, tw, th, 2, 2, 'F');
      T(t[0], x + tw / 2, y + 5.5, { size: 6.8, bold: true, color: C.dim, align: 'center' });
      T(a + (t[2] || ''), x + 3, y + 15, { size: 14, bold: true, color: cA });
      T(b + (t[2] || ''), x + tw - 3, y + 15, { size: 14, bold: true, color: cB, align: 'right' });
      T(initials(m.teams.A), x + 3, y + 19.4, { size: 6, bold: true, color: C.dim });
      T(initials(m.teams.B), x + tw - 3, y + 19.4, { size: 6, bold: true, color: C.dim, align: 'right' });
      var tot = a + b, sx = x + 3, sw = tw - 6;
      fill(C.line); doc.roundedRect(sx, y + th - 3.6, sw, 1.6, 0.8, 0.8, 'F');
      if (tot > 0) {
        fill(cA); doc.roundedRect(sx, y + th - 3.6, Math.max(1.6, sw * a / tot), 1.6, 0.8, 0.8, 'F');
        fill(cB); doc.roundedRect(sx + sw * a / tot, y + th - 3.6, Math.max(1.6, sw * b / tot), 1.6, 0.8, 0.8, 'F');
      }
    });
    y += th + 7;

    // player of the match
    var star = m.star;
    if (star) {
      fill(C.navy); doc.roundedRect(MX, y, CW, 24, 3, 3, 'F');
      fill(C.gold); doc.circle(MX + 12, y + 12, 7.5, 'F');
      T('MVP', MX + 12, y + 13.6, { size: 9, bold: true, color: C.navy, align: 'center' });
      T('PLAYER OF THE MATCH', MX + 24, y + 7.5, { size: 7.5, bold: true, color: C.gold });
      T(star.name, MX + 24, y + 15, { size: 15, bold: true, color: C.white, maxW: 78 });
      T(star.teamName, MX + 24, y + 20.4, { size: 8, color: [148, 163, 184], maxW: 78 });
      var pills = [];
      if (star.bat && (star.bat.runs || star.bat.balls)) pills.push([star.bat.runs + ' (' + star.bat.balls + ')', star.bat.fours + ' x 4 · ' + star.bat.sixes + ' x 6']);
      if (star.bowl && (star.bowl.wickets || star.bowl.balls)) pills.push([star.bowl.wickets + '/' + star.bowl.runs, star.bowl.overs + ' ov · econ ' + star.bowl.econ]);
      if (star.field) pills.push([String(star.field), 'catch' + (star.field === 1 ? '' : 'es') + ' / run outs']);
      var px = PW - MX - 4;
      pills.slice(0, 3).reverse().forEach(function (p) {
        font(12, true); var w1 = doc.getTextWidth(pdfSafe(p[0])); font(6.8, false); var w2 = doc.getTextWidth(pdfSafe(p[1]));
        var w = Math.max(w1, w2) + 8;
        px -= w;
        fill(C.navy2); doc.roundedRect(px, y + 5, w, 14, 2, 2, 'F');
        T(p[0], px + w / 2, y + 11.4, { size: 12, bold: true, color: C.white, align: 'center' });
        T(p[1], px + w / 2, y + 16.2, { size: 6.8, color: [148, 163, 184], align: 'center' });
        px -= 3;
      });
      y += 30;
    }

    // best performances
    var half = (CW - 6) / 2;
    T('BEST PERFORMANCES - BATTERS', MX, y + 3, { size: 8, bold: true, color: C.dim });
    T('BEST PERFORMANCES - BOWLERS', MX + half + 6, y + 3, { size: 8, bold: true, color: C.dim });
    y += 5;
    var yb = table(MX, y, [{ h: 'Batter', w: half - 50 }, { h: 'R', w: 10, align: 'center' }, { h: 'B', w: 10, align: 'center' }, { h: '4s', w: 9, align: 'center' }, { h: '6s', w: 9, align: 'center' }, { h: 'SR', w: 12, align: 'right' }],
      m.best.batters.map(function (b) { return [{ t: b.name, bold: true, sub: initials(m.teams[b.team]) }, { t: b.runs, bold: true }, b.balls, b.fours, b.sixes, b.sr]; }), { hi: m.best.batters.length ? [0] : [] });
    var yw = table(MX + half + 6, y, [{ h: 'Bowler', w: half - 52 }, { h: 'O', w: 11, align: 'center' }, { h: 'M', w: 9, align: 'center' }, { h: 'R', w: 10, align: 'center' }, { h: 'W', w: 9, align: 'center' }, { h: 'Eco', w: 13, align: 'right' }],
      m.best.bowlers.map(function (b) { return [{ t: b.name, bold: true, sub: initials(m.teams[b.team]) }, b.overs, b.maidens, b.runs, { t: b.wickets, bold: true }, b.econ]; }), { hi: m.best.bowlers.length ? [0] : [] });
    if (!m.best.batters.length) T('No batting yet', MX + 2, y + 12, { size: 8, color: C.dim });
    if (!m.best.bowlers.length) T('No bowling yet', MX + half + 8, y + 12, { size: 8, color: C.dim });
    y = Math.max(yb, yw, y + 14) + 8;

    // the worm — runs after every over
    var wy = y, wh = Math.min(PH - 20 - wy, 82);
    if (wh > 34 && m.innings.length) {
      T('RUN PROGRESSION', MX, wy + 3, { size: 8, bold: true, color: C.dim });
      var gx = MX + 9, gy = wy + 8, gw = CW - 11, gh = wh - 16;
      var maxR = 10, maxO = 1;
      m.innings.forEach(function (i) { i.worm.forEach(function (p) { maxR = Math.max(maxR, p.runs); maxO = Math.max(maxO, p.over); }); });
      if (m.meta.oversLimit && m.meta.oversLimit < 200) maxO = Math.max(maxO, m.meta.oversLimit);
      var stepR = maxR > 200 ? 50 : maxR > 100 ? 25 : maxR > 40 ? 10 : 5;
      maxR = Math.ceil(maxR / stepR) * stepR;
      var stepO = maxO > 40 ? 10 : maxO > 15 ? 5 : maxO > 6 ? 2 : 1;
      var X = function (o) { return gx + o / maxO * gw; }, Y = function (r) { return gy + gh - r / maxR * gh; };
      draw(C.line); doc.setLineWidth(0.15);
      for (var r = 0; r <= maxR; r += stepR) { doc.line(gx, Y(r), gx + gw, Y(r)); T(String(r), gx - 1.5, Y(r) + 1, { size: 6.2, color: C.dim, align: 'right' }); }
      for (var o = 0; o <= maxO; o += stepO) T(String(o), X(o), gy + gh + 4, { size: 6.2, color: C.dim, align: 'center' });
      T('OVERS', gx + gw / 2, gy + gh + 8.5, { size: 6.2, bold: true, color: C.dim, align: 'center' });
      var seen = {};
      m.innings.forEach(function (inn) {
        var c = colOf(inn.team);
        draw(c); doc.setLineWidth(0.7);
        if (seen[inn.team]) doc.setLineDashPattern([1.2, 0.9], 0); else doc.setLineDashPattern([], 0);
        for (var i = 1; i < inn.worm.length; i++) doc.line(X(inn.worm[i - 1].over), Y(inn.worm[i - 1].runs), X(inn.worm[i].over), Y(inn.worm[i].runs));
        doc.setLineDashPattern([], 0);
        inn.wormWickets.forEach(function (w) { fill(C.white); draw(c); doc.setLineWidth(0.45); doc.circle(X(w.x), Y(w.runs), 0.9, 'FD'); });
        seen[inn.team] = 1;
      });
      var lx = gx + 2;
      m.innings.forEach(function (inn) {
        fill(colOf(inn.team)); doc.roundedRect(lx, gy - 1.6, 4, 1.6, 0.8, 0.8, 'F');
        lx += 5 + T(inn.teamShort + (m.innings.filter(function (q) { return q.team === inn.team; }).length > 1 ? ' (' + inn.label.split(' ')[0] + ')' : ''), lx + 5, gy, { size: 6.8, bold: true, color: C.ink }) + 6;
      });
      T('o = wicket', gx + gw, gy, { size: 6.5, color: C.dim, align: 'right' });
    }

    /* ---- page 2 — wagon wheels ---- */
    doc.addPage();
    y = pageHeader('WAGON WHEELS');
    T('Where every run went  ·  gold = fours, red = sixes  ·  a team wheel shows left-handers mirrored into a right-hander\'s view', MX, y, { size: 7.6, color: C.dim, maxW: CW });
    y += 5;
    var ww = (CW - 8) / 2;
    var wheelImg = function (img, x, yy, w) {
      if (img && img.dataUrl) { var h = w * img.height / img.width; doc.addImage(img.dataUrl, 'PNG', x, yy, w, h, undefined, 'FAST'); return h; }
      var h2 = w * 1.218;
      fill(C.navy); doc.roundedRect(x, yy, w, h2, 4, 4, 'F');
      T('Wagon wheel picture not available', x + w / 2, yy + h2 / 2, { size: 8, color: [148, 163, 184], align: 'center' });
      return h2;
    };
    var hW = 0;
    ['A', 'B'].forEach(function (k, i) {
      var x = MX + i * (ww + 8), w = m.wagon[k];
      teamBanner(k, x, y, ww, 14, { slant: ww - 26, minTitle: 6.6, sub: w.mapped + ' of ' + w.scoringShots + ' shots placed', score: String(w.runs), scoreSub: '' });
      T('RUNS', x + ww - 4, y + 11.6, { size: 5.6, bold: true, color: [148, 163, 184], align: 'right' });
      hW = Math.max(hW, wheelImg(images[k], x + 4.5, y + 16, ww - 9));
    });
    y += 16 + hW + 6;
    ['A', 'B'].forEach(function (k, i) {
      var x = MX + i * (ww + 8), w = m.wagon[k];
      T('TOP REGIONS', x, y, { size: 7.2, bold: true, color: C.dim });
      var tops = w.list.slice().sort(function (a, b) { return b.runs - a.runs; }).filter(function (z) { return z.runs > 0; }).slice(0, 4);
      if (!tops.length) T('No shots marked', x, y + 6, { size: 8, color: C.dim });
      var mx = tops.length ? tops[0].runs : 1;
      tops.forEach(function (z, j) {
        var ry = y + 3 + j * 6;
        T(z.name, x, ry + 3.6, { size: 8, bold: true, maxW: 24 });
        fill(C.line); doc.roundedRect(x + 25, ry + 1.2, ww - 46, 3, 1.5, 1.5, 'F');
        fill(colOf(k)); doc.roundedRect(x + 25, ry + 1.2, Math.max(3, (ww - 46) * z.runs / mx), 3, 1.5, 1.5, 'F');
        T(z.runs + ' (' + z.pct + '%)', x + ww, ry + 3.6, { size: 7.8, bold: true, align: 'right' });
      });
    });
    y += 30;
    var st = m.wagon.star;
    fill(C.gold); doc.roundedRect(MX, y, CW, 8, 2, 2, 'F');
    T('TOP SCORER - WAGON WHEEL', MX + 4, y + 5.5, { size: 9, bold: true, color: C.navy });
    y += 11;
    if (st) {
      var sw = 64, sh = wheelImg(images.star, MX, y, sw);
      var rx = MX + sw + 8, rw = CW - sw - 8;
      T(st.name, rx, y + 7, { size: 17, bold: true, maxW: rw });
      T(st.teamName + '  ·  ' + (st.hand === 'L' ? 'Left-handed batter' : 'Right-handed batter'), rx, y + 12.5, { size: 8.5, color: C.dim, maxW: rw });
      var stats = [['RUNS', st.bat.runs], ['BALLS', st.bat.balls], ['SR', st.bat.sr], ['4s', st.bat.fours], ['6s', st.bat.sixes]];
      var tw2 = (rw - 4 * 2.5) / 5;
      stats.forEach(function (s, i) {
        var x = rx + i * (tw2 + 2.5);
        fill(i === 0 ? C.navy : C.soft); doc.roundedRect(x, y + 16, tw2, 14, 2, 2, 'F');
        T(String(s[1]), x + tw2 / 2, y + 24, { size: 12, bold: true, color: i === 0 ? C.gold : C.ink, align: 'center' });
        T(s[0], x + tw2 / 2, y + 28, { size: 6.2, bold: true, color: i === 0 ? [148, 163, 184] : C.dim, align: 'center' });
      });
      T('RUNS BY REGION', rx, y + 36, { size: 7.2, bold: true, color: C.dim });
      var mxz = Math.max.apply(null, st.wheel.list.map(function (z) { return z.runs; }).concat([1]));
      st.wheel.list.slice().sort(function (a, b) { return b.runs - a.runs; }).forEach(function (z, j) {
        var ry = y + 38 + j * 5.4, top = j === 0 && z.runs > 0;
        T(z.name, rx, ry + 3.4, { size: 7.6, bold: top, maxW: 22 });
        fill(C.line); doc.roundedRect(rx + 23, ry + 1.1, rw - 46, 2.8, 1.4, 1.4, 'F');
        if (z.runs) { fill(top ? C.gold : C.navy2); doc.roundedRect(rx + 23, ry + 1.1, Math.max(2.8, (rw - 46) * z.runs / mxz), 2.8, 1.4, 1.4, 'F'); }
        T(z.runs + ' runs · ' + z.shots + ' shot' + (z.shots === 1 ? '' : 's'), rx + rw, ry + 3.4, { size: 7.2, color: top ? C.ink : C.dim, bold: top, align: 'right' });
      });
    } else {
      fill(C.soft); doc.roundedRect(MX, y, CW, 20, 3, 3, 'F');
      T('No wagon wheel shots were marked in this match.', MX + CW / 2, y + 9, { size: 9.5, bold: true, color: C.ink, align: 'center' });
      T('Turn the wagon wheel on in Match Setup to capture where every run goes.', MX + CW / 2, y + 14.5, { size: 8, color: C.dim, align: 'center' });
    }

    /* ---- one scorecard page per innings ---- */
    m.innings.forEach(function (inn) {
      doc.addPage();
      y = pageHeader('SCORECARD  ·  ' + inn.label.toUpperCase());
      var c = colOf(inn.team);
      var f4 = inn.batting.reduce(function (s2, b) { return s2 + b.fours; }, 0), f6 = inn.batting.reduce(function (s2, b) { return s2 + b.sixes; }, 0);
      teamBanner(inn.team, MX, y, CW, 26, {
        slant: 92, sub: inn.label + (inn.captain ? '  ·  Captain: ' + inn.captain : ''),
        score: inn.runs + '/' + inn.wickets + (inn.declared ? 'd' : ''), scoreSub: inn.overs + ' Ov  ·  CRR ' + inn.crr,
        won: m.meta.winner === inn.team, chips: [['FOURS', f4, C.gold], ['SIXES', f6, [255, 99, 132]], ['EXTRAS', inn.extras.total]]
      });
      y += 31;
      var meta = [inn.startText ? 'Start ' + inn.startText : '', inn.endText ? 'End ' + inn.endText : '', inn.minutes != null ? inn.minutes + ' min' : '', inn.toBat.length ? '' : 'All batted'].filter(Boolean).join('   ·   ');
      T(meta, MX, y, { size: 7.8, color: C.dim, maxW: CW });
      y += 4;
      var hiB = [];
      inn.batting.forEach(function (b, i) { if (b.name === inn.topBat) hiB.push(i); });
      y = table(MX, y, [{ h: 'No', w: 8, align: 'center' }, { h: 'Batsman', w: 48 }, { h: 'Status', w: 58 }, { h: 'R', w: 11, align: 'center' }, { h: 'B', w: 11, align: 'center' },
        { h: 'M', w: 11, align: 'center' }, { h: '4s', w: 10, align: 'center' }, { h: '6s', w: 10, align: 'center' }, { h: 'SR', w: 15, align: 'right' }],
        inn.batting.map(function (b) {
          return [b.no, { t: b.name + (b.captain ? ' (c)' : '') + (b.keeper ? ' (wk)' : ''), bold: true, sub: b.hand }, { t: b.status, color: b.out ? C.dim : C.notout, bold: !b.out, size: 7.6 },
            { t: b.runs, bold: true }, b.balls, b.mins == null ? '-' : b.mins, b.fours, b.sixes, b.sr];
        }), { hi: hiB });
      var ex = inn.extras;
      fill(C.soft); doc.rect(MX, y, CW, 6.4, 'F');
      T('Extras', MX + 2.2, y + 4.3, { size: 8.2, bold: true });
      T('(b ' + ex.b + ', lb ' + ex.lb + ', wd ' + ex.wd + ', nb ' + ex.nb + (ex.pen ? ', pen ' + ex.pen : '') + ')', MX + 18, y + 4.3, { size: 7.6, color: C.dim });
      T(String(ex.total), MX + 8 + 48 + 58 + 5.5, y + 4.3, { size: 8.6, bold: true, align: 'center' });
      y += 6.4;
      fill(C.navy); doc.rect(MX, y, CW, 7.4, 'F');
      T('TOTAL', MX + 2.2, y + 5, { size: 8.6, bold: true, color: C.white });
      T('(' + inn.overs + ' Ov, ' + inn.wickets + ' wkt' + (inn.wickets === 1 ? '' : 's') + (inn.declared ? ', declared' : '') + ')', MX + 18, y + 5, { size: 7.8, color: [203, 213, 225] });
      T(String(inn.runs), MX + 8 + 48 + 58 + 5.5, y + 5.1, { size: 10, bold: true, color: C.gold, align: 'center' });
      T('CRR ' + inn.crr, PW - MX - 2, y + 5, { size: 7.8, bold: true, color: C.white, align: 'right' });
      y += 11;
      if (inn.toBat.length) {
        T('To bat:', MX, y, { size: 8, bold: true });
        font(8, false);
        var tb = doc.splitTextToSize(pdfSafe(inn.toBat.join(', ')), CW - 14);
        tb.slice(0, 2).forEach(function (ln, i) { T(ln, MX + 12, y + i * 4, { size: 8, color: C.dim }); });
        y += 4 * Math.min(tb.length, 2) + 3;
      }
      // fall of wickets — a timeline from 0 to the total, then the list
      T('FALL OF WICKETS', MX, y + 2, { size: 8, bold: true, color: C.dim });
      y += 5;
      if (inn.fow.length) {
        var lx0 = MX + 2, lw = CW - 4, tot = Math.max(inn.runs, 1);
        fill(C.line); doc.roundedRect(lx0, y + 6, lw, 1.6, 0.8, 0.8, 'F');
        fill(c); doc.roundedRect(lx0, y + 6, lw, 1.6, 0.8, 0.8, 'F');
        inn.fow.forEach(function (f, i) {
          var fx = lx0 + lw * Math.min(f.runs, tot) / tot, up = i % 2 === 0;
          fill(C.white); draw(c); doc.setLineWidth(0.5); doc.circle(fx, y + 6.8, 1.6, 'FD');
          T(String(f.no), fx, y + 7.7, { size: 5.6, bold: true, color: C.ink, align: 'center' });
          T(String(f.runs), fx, up ? y + 3.2 : y + 12.4, { size: 6.2, bold: true, color: C.dim, align: 'center' });
        });
        y += 16;
        font(7.6, false);
        var fl = doc.splitTextToSize(pdfSafe(inn.fow.map(function (f) { return f.runs + '-' + f.no + ' (' + (f.name || '?') + ', ' + f.over + ' ov)'; }).join(',  ')), CW);
        fl.forEach(function (ln, i) { T(ln, MX, y + i * 3.8, { size: 7.6, color: C.ink }); });
        y += fl.length * 3.8 + 4;
      } else { T('No wickets fell', MX, y + 3, { size: 8, color: C.dim }); y += 8; }
      var hiW = [];
      inn.bowling.forEach(function (w, i) { if (w.name === inn.topBowl) hiW.push(i); });
      y = table(MX, y, [{ h: 'No', w: 8, align: 'center' }, { h: 'Bowler', w: 50 }, { h: 'O', w: 13, align: 'center' }, { h: 'M', w: 11, align: 'center' }, { h: 'R', w: 12, align: 'center' },
        { h: 'W', w: 11, align: 'center' }, { h: '0s', w: 12, align: 'center' }, { h: '4s', w: 11, align: 'center' }, { h: '6s', w: 11, align: 'center' },
        { h: 'WD', w: 12, align: 'center' }, { h: 'NB', w: 12, align: 'center' }, { h: 'Eco', w: 19, align: 'right' }],
        inn.bowling.map(function (w) { return [w.no, { t: w.name + (w.captain ? ' (c)' : ''), bold: true }, w.overs, w.maidens, w.runs, { t: w.wickets, bold: true }, w.dots, w.fours, w.sixes, w.wd, w.nb, w.econ]; }), { hi: hiW });
      // partnerships — as many as the page has room for
      var ps = inn.partnerships.filter(function (p) { return p.runs > 0 || p.balls > 0; });
      if (ps.length && y + 18 < PH - 16) {
        y += 8;
        T('PARTNERSHIPS', MX, y, { size: 8, bold: true, color: C.dim });
        y += 2;
        var mxp = Math.max.apply(null, ps.map(function (p) { return p.runs; }).concat([1]));
        var ord = function (n) { return n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'); };
        ps.forEach(function (p) {
          if (y + 6 > PH - 15) return;
          var best = p.runs === mxp;
          T(ord(p.wkt), MX, y + 3.9, { size: 7.2, bold: true, color: C.dim });
          T(p.a + ' & ' + p.b, MX + 10, y + 3.9, { size: 7.6, bold: best, maxW: 62 });
          var bx = MX + 74, bw = CW - 74 - 26;
          fill(C.line); doc.roundedRect(bx, y + 1.5, bw, 2.8, 1.4, 1.4, 'F');
          fill(best ? C.gold : c); doc.roundedRect(bx, y + 1.5, Math.max(2.8, bw * p.runs / mxp), 2.8, 1.4, 1.4, 'F');
          T(p.runs + (p.unbroken ? '*' : '') + ' (' + p.balls + ')', PW - MX, y + 3.9, { size: 7.6, bold: true, align: 'right' });
          y += 5.6;
        });
      }
    });

    /* ---- squads + officials ---- */
    doc.addPage();
    y = pageHeader('PLAYING SQUADS');
    var colW = (CW - 8) / 2, maxRows = 0;
    ['A', 'B'].forEach(function (k, i) {
      var x = MX + i * (colW + 8), t = m.teams[k];
      var names = t.players.length ? t.players.map(function (p) { return p.name; })
        : m.innings.filter(function (q) { return q.team === k; }).reduce(function (a, q) { return a.concat(q.batting.map(function (b) { return b.name; })); }, []);
      names = names.filter(function (n, j) { return names.indexOf(n) === j; });
      teamBanner(k, x, y, colW, 16, { slant: colW - 22, sub: 'Playing XI', right: names.length + ' players' });
      names.forEach(function (n, j) {
        var ry = y + 19 + j * 7.2;
        if (j % 2) { fill(C.soft); doc.rect(x, ry, colW, 7.2, 'F'); }
        T(String(j + 1), x + 4, ry + 4.8, { size: 8, color: C.dim, align: 'center' });
        var tag = (sameName(t.captain, n) ? ' (C)' : '') + (sameName(t.keeper, n) ? ' (WK)' : '');
        var w0 = T(n, x + 10, ry + 4.8, { size: 8.8, bold: !!tag, maxW: colW - 26 });
        if (tag) T(tag.trim(), x + 11 + w0, ry + 4.8, { size: 7.2, bold: true, color: C.gold });
      });
      maxRows = Math.max(maxRows, names.length);
    });
    y += 19 + maxRows * 7.2 + 10;
    T('MATCH OFFICIALS', MX, y, { size: 11, bold: true });
    fill(C.gold); doc.rect(MX, y + 2, 12, 0.9, 'F');
    y += 6;
    // the two captains sign
    var off = ['A', 'B'].map(function (k) { var t = m.teams[k]; return [t.captain ? t.captain + ' (' + t.name + ')' : t.name, 'Captain']; });
    y = table(MX, y, [{ h: 'No', w: 12, align: 'center' }, { h: 'Name', w: 92 }, { h: 'Role', w: 30 }, { h: 'Signature', w: CW - 134 }],
      off.map(function (o, i) { return [i + 1, { t: o[0], bold: true }, o[1], '']; }), { rowH: 9 });

    // footer on every page
    var n = doc.getNumberOfPages();
    var gen = new Date(m.generatedAt || Date.now());
    var genText = dateText(isoOf(gen)) + ', ' + clockText(gen.getTime());
    for (var p = 1; p <= n; p++) {
      doc.setPage(p);
      draw(C.line); doc.setLineWidth(0.2); doc.line(MX, PH - 11, PW - MX, PH - 11);
      T('All Sports Live  ·  ' + m.meta.title + '  ·  generated ' + genText, MX, PH - 6.5, { size: 7, color: C.dim, maxW: 150 });
      T('Page ' + p + ' of ' + n, PW - MX, PH - 6.5, { size: 7, bold: true, color: C.dim, align: 'right' });
    }
    return doc;
  }

  return {
    ZONES: ZONES, R_IN: R_IN, R_OUT: R_OUT,
    batRunsOf: batRunsOf, wagonOf: wagonOf, buildModel: buildModel, howOutShort: howOutShort,
    drawWagonWheel: drawWagonWheel, buildExcel: buildExcel, buildPdf: buildPdf, pdfSafe: pdfSafe,
    oversToBalls: oversToBalls, clockText: clockText, dayPart: dayPart, dateText: dateText,
    _internal: { zoneRange: zoneRange, polar: polar, shotPoint: shotPoint }
  };
});
