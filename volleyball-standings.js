/* ================================================================
   🏆 VOLLEYBALL STANDINGS + FIXTURES — pure functions, no database.

   STANDINGS: only COMPLETED league / group matches count (a scheduled,
   live or abandoned one never does), each match once, teams by their
   stable teamId — never by name.

   Match points are the competition's choice (`policy`). The default is
   the common 3-2-1-0 convention (FIVB Volleyball Nations League and most
   national leagues): a 3-0 or 3-1 win is 3 points, a 3-2 win 2, a 2-3
   loss 1, a 0-3 or 1-3 loss 0. "Straight" below means the deciding set
   was not needed; "decider" that it was — so the same policy works for a
   best of three (2-0 / 2-1).

   Ties are broken by the competition's ordered list of criteria; the
   default is FIVB's: matches won → match points → set ratio → point
   ratio → head-to-head among the teams still tied.
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VolleyballStandings = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var POLICIES = {
    '3-2-1-0': { label: '3-0 / 3-1 win: 3 · 3-2 win: 2 · 2-3 loss: 1 · 1-3 / 0-3 loss: 0', winStraight: 3, winDecider: 2, loseDecider: 1, loseStraight: 0 },
    '2-1': { label: 'Win: 2 · Loss: 1', winStraight: 2, winDecider: 2, loseDecider: 1, loseStraight: 1 },
    '1-0': { label: 'Win: 1 · Loss: 0', winStraight: 1, winDecider: 1, loseDecider: 0, loseStraight: 0 }
  };
  var DEFAULT_POLICY = '3-2-1-0';
  var CRITERIA = {
    wins: 'Matches won', matchPoints: 'Match points', setRatio: 'Set ratio', pointRatio: 'Point ratio',
    headToHead: 'Head-to-head', setsWon: 'Sets won', pointsWon: 'Points won', setDiff: 'Set difference', pointDiff: 'Point difference'
  };
  var DEFAULT_TIEBREAKERS = ['wins', 'matchPoints', 'setRatio', 'pointRatio', 'headToHead'];
  var TIEBREAK_PRESETS = {
    fivb: { label: 'FIVB: wins → match points → set ratio → point ratio → head-to-head', list: DEFAULT_TIEBREAKERS },
    points: { label: 'League: match points → wins → set ratio → point ratio → head-to-head', list: ['matchPoints', 'wins', 'setRatio', 'pointRatio', 'headToHead'] }
  };

  function normalizePolicy(p) {
    if (typeof p === 'string' && POLICIES[p]) return Object.assign({ key: p }, POLICIES[p]);
    if (p && typeof p === 'object') {
      if (p.key && POLICIES[p.key] && p.winStraight == null) return Object.assign({ key: p.key }, POLICIES[p.key]);
      var n = function (v, d) { var x = Number(v); return isFinite(x) ? Math.max(-10, Math.min(10, x)) : d; };
      return { key: 'custom', label: 'Custom', winStraight: n(p.winStraight, 3), winDecider: n(p.winDecider, 2), loseDecider: n(p.loseDecider, 1), loseStraight: n(p.loseStraight, 0), forfeitLoser: n(p.forfeitLoser, 0) };
    }
    return Object.assign({ key: DEFAULT_POLICY }, POLICIES[DEFAULT_POLICY]);
  }
  function normalizeTiebreakers(list) {
    var out = (Array.isArray(list) ? list : DEFAULT_TIEBREAKERS).filter(function (c, i, a) { return CRITERIA[c] && a.indexOf(c) === i; });
    return out.length ? out : DEFAULT_TIEBREAKERS.slice();
  }

  function ratio(a, b) { return b > 0 ? a / b : (a > 0 ? Infinity : 0); }

  // One completed match → what it gives each side.
  function matchFacts(m, policy) {
    var r = m.result;
    if (!r || (r.winner !== 'A' && r.winner !== 'B')) return null;
    var sA = r.sets ? Number(r.sets.A) || 0 : 0, sB = r.sets ? Number(r.sets.B) || 0 : 0;
    var pA = 0, pB = 0;
    (r.setScores || []).forEach(function (s) { pA += Number(s.A) || 0; pB += Number(s.B) || 0; });
    var setsToWin = Math.max(sA, sB);
    var decider = Math.min(sA, sB) === setsToWin - 1 && setsToWin > 1;
    var win = r.winner, lose = win === 'A' ? 'B' : 'A';
    var mp = {};
    mp[win] = decider ? policy.winDecider : policy.winStraight;
    // a team that forfeits never earns the loser's point some policies give
    mp[lose] = r.forfeit && r.forfeit === lose ? (policy.forfeitLoser != null ? policy.forfeitLoser : 0)
      : (decider ? policy.loseDecider : policy.loseStraight);
    return { A: { sets: sA, setsAgainst: sB, pts: pA, ptsAgainst: pB, mp: mp.A, won: win === 'A' }, B: { sets: sB, setsAgainst: sA, pts: pB, ptsAgainst: pA, mp: mp.B, won: win === 'B' }, label: win === 'A' ? sA + '-' + sB : sB + '-' + sA };
  }

  function blankRow(team) {
    return {
      teamId: team.teamId, name: team.name || '', shortName: team.shortName || '', logo: team.logo || null, colors: team.colors || null,
      played: 0, won: 0, lost: 0, matchPoints: 0,
      setsWon: 0, setsLost: 0, setRatio: 0, pointsWon: 0, pointsLost: 0, pointRatio: 0,
      setDiff: 0, pointDiff: 0, results: {}, form: [], decidedBy: null
    };
  }

  function tableOf(teams, matches, policy) {
    var rows = {};
    teams.forEach(function (t) { rows[t.teamId] = blankRow(t); });
    var seen = {};
    matches.forEach(function (m) {
      if (!m || m.status !== 'completed' || seen[m.matchId]) return;
      var a = m.teamA && m.teamA.teamId, b = m.teamB && m.teamB.teamId;
      if (!rows[a] || !rows[b]) return;
      var f = matchFacts(m, policy);
      if (!f) return;
      seen[m.matchId] = 1;
      [[a, f.A], [b, f.B]].forEach(function (x) {
        var row = rows[x[0]], s = x[1];
        row.played += 1;
        if (s.won) row.won += 1; else row.lost += 1;
        row.matchPoints += s.mp;
        row.setsWon += s.sets; row.setsLost += s.setsAgainst;
        row.pointsWon += s.pts; row.pointsLost += s.ptsAgainst;
        var key = s.sets + '-' + s.setsAgainst;
        row.results[key] = (row.results[key] || 0) + 1;
        row.form.push({ matchId: m.matchId, result: s.won ? 'W' : 'L', score: key, at: m.completedAt || m.scheduledAt || 0 });
      });
    });
    Object.keys(rows).forEach(function (id) {
      var r = rows[id];
      r.setRatio = ratio(r.setsWon, r.setsLost);
      r.pointRatio = ratio(r.pointsWon, r.pointsLost);
      r.setDiff = r.setsWon - r.setsLost;
      r.pointDiff = r.pointsWon - r.pointsLost;
      r.form.sort(function (x, y) { return (x.at || 0) - (y.at || 0); });
      r.form = r.form.slice(-5).map(function (x) { return x.result; });
    });
    return rows;
  }

  // Sorts rows by the criteria in order; teams still level after a
  // criterion are split by the next one. Head-to-head builds a mini-table
  // from the matches among exactly the teams still tied.
  function rank(rows, criteria, matches, policy) {
    function partition(list, key) {
      var groups = [];
      list.slice().sort(function (x, y) { return key(y) - key(x); }).forEach(function (r) {
        var g = groups[groups.length - 1];
        if (g && key(g[0]) === key(r)) g.push(r); else groups.push([r]);
      });
      return groups;
    }
    // depth > 0: these teams were level on everything before `crit[0]`, so
    // whatever separates them now is shown as the tie-break that decided it.
    function go(list, crit, depth) {
      if (list.length <= 1 || !crit.length) {
        return list.slice().sort(function (x, y) { return String(x.name).localeCompare(String(y.name)); });
      }
      var c = crit[0], rest = crit.slice(1);
      if (c === 'headToHead') {
        var ids = {};
        list.forEach(function (r) { ids[r.teamId] = 1; });
        var mini = tableOf(list.map(function (r) { return { teamId: r.teamId, name: r.name }; }),
          matches.filter(function (m) { return m && m.teamA && m.teamB && ids[m.teamA.teamId] && ids[m.teamB.teamId]; }), policy);
        var keys = ['won', 'matchPoints', 'setRatio', 'pointRatio'];
        var step = function (lst, i) {
          if (lst.length <= 1 || i >= keys.length) return go(lst, rest, depth + 1);
          var out = [];
          partition(lst, function (r) { return mini[r.teamId][keys[i]]; }).forEach(function (g) {
            if (g.length === 1 && lst.length > 1) g[0].decidedBy = 'headToHead';
            out = out.concat(step(g, i + 1));
          });
          return out;
        };
        return step(list, 0);
      }
      var key = function (r) { return c === 'wins' ? r.won : r[c]; };
      var out = [];
      partition(list, key).forEach(function (g) {
        if (g.length === 1 && list.length > 1 && depth > 0) g[0].decidedBy = c;
        out = out.concat(go(g, rest, depth + 1));
      });
      return out;
    }
    rows.forEach(function (r) { r.decidedBy = null; });
    return go(rows, criteria, 0);
  }

  /* compute({ teams: [{teamId, name, group?}], matches, groups?: [{name, teamIds}],
                policy, tiebreakers }) →
       { policy, tiebreakers, groups: [{ name, rows: [...ranked] }] } */
  function compute(opts) {
    var policy = normalizePolicy(opts.policy);
    var tiebreakers = normalizeTiebreakers(opts.tiebreakers);
    var teams = opts.teams || [];
    var matches = (opts.matches || []).filter(function (m) {
      var st = m && m.stage && m.stage.type;
      return st !== 'knockout';  // knockout games have a bracket, not a table
    });
    var groups = Array.isArray(opts.groups) && opts.groups.length ? opts.groups : [{ name: '', teamIds: teams.map(function (t) { return t.teamId; }) }];
    var byId = {};
    teams.forEach(function (t) { byId[t.teamId] = t; });
    return {
      policy: policy,
      tiebreakers: tiebreakers,
      groups: groups.map(function (g) {
        var gTeams = (g.teamIds || []).map(function (id) { return byId[id]; }).filter(Boolean);
        var ids = {};
        gTeams.forEach(function (t) { ids[t.teamId] = 1; });
        var gm = matches.filter(function (m) {
          if (!m.teamA || !m.teamB || !ids[m.teamA.teamId] || !ids[m.teamB.teamId]) return false;
          return !g.name || !m.stage || !m.stage.group || m.stage.group === g.name;
        });
        var rows = tableOf(gTeams, gm, policy);
        var ranked = rank(Object.keys(rows).map(function (k) { return rows[k]; }), tiebreakers, gm, policy);
        ranked.forEach(function (r, i) { r.position = i + 1; });
        return { name: g.name || '', rows: ranked };
      })
    };
  }

  function fmtRatio(v) { return v === Infinity ? 'MAX' : (Math.round(v * 1000) / 1000).toFixed(3); }

  /* ================= FIXTURES =================
     Round robin by the circle method: every team meets every other once
     (twice, home and away swapped, for a double round robin), at most one
     match per team per round; an odd number of teams gives one team a
     bye each round. */
  function roundRobin(teamIds, opts) {
    opts = opts || {};
    var ids = teamIds.slice();
    if (ids.length < 2) return [];
    if (ids.length % 2) ids.push(null);
    var n = ids.length, rounds = n - 1, half = n / 2, out = [];
    var arr = ids.slice();
    var home = {};
    for (var r = 0; r < rounds; r++) {
      for (var i = 0; i < half; i++) {
        var a = arr[i], b = arr[n - 1 - i];
        if (a == null || b == null) continue;
        // home goes to whichever side has had fewer home games so far (a
        // tie alternates), so every team gets an even share
        var ha = home[a] || 0, hb = home[b] || 0;
        var aHome = ha !== hb ? ha < hb : (r + i) % 2 === 0;
        var h = aHome ? a : b;
        home[h] = (home[h] || 0) + 1;
        out.push({ round: r + 1, home: h, away: aHome ? b : a });
      }
      arr.splice(1, 0, arr.pop());   // rotate all but the first
    }
    if (opts.double) {
      out.slice().forEach(function (f) { out.push({ round: f.round + rounds, home: f.away, away: f.home }); });
    }
    return out;
  }

  // Standard seeded bracket order (1 v 16, 8 v 9, …) for a power-of-two size.
  function bracketOrder(size) {
    var order = [1];
    while (order.length < size) {
      var next = [], m = order.length * 2 + 1;
      order.forEach(function (s) { next.push(s, m - s); });
      order = next;
    }
    return order;
  }
  function roundLabel(fromEnd) {
    return fromEnd === 0 ? 'Final' : fromEnd === 1 ? 'Semi-final' : fromEnd === 2 ? 'Quarter-final' : 'Round of ' + Math.pow(2, fromEnd + 1);
  }
  /* knockout(seeds) — seeds in seed order (best first). Returns every
     match of the bracket with a stable key; a later round names the
     earlier matches its teams come from. Byes (seeds beyond the field)
     put the team straight into round 2. */
  function knockout(seeds, opts) {
    opts = opts || {};
    var n = seeds.length;
    if (n < 2) return [];
    var size = 1;
    while (size < n) size *= 2;
    var rounds = Math.log(size) / Math.log(2);
    var order = bracketOrder(size);
    var out = [];
    var prev = [];   // per slot of the previous round: { team } or { winnerOf }
    for (var i = 0; i < size; i += 2) {
      var s1 = order[i], s2 = order[i + 1];
      var t1 = s1 <= n ? seeds[s1 - 1] : null, t2 = s2 <= n ? seeds[s2 - 1] : null;
      if (t1 && t2) {
        var key = 'KO:R1:M' + (i / 2 + 1);
        out.push({ key: key, round: 1, roundLabel: roundLabel(rounds - 1), A: { teamId: t1, seed: s1 }, B: { teamId: t2, seed: s2 } });
        prev.push({ winnerOf: key });
      } else {
        prev.push({ teamId: t1 || t2, seed: t1 ? s1 : s2, bye: true });
      }
    }
    for (var r = 2; r <= rounds; r++) {
      var cur = [];
      for (var j = 0; j < prev.length; j += 2) {
        var k2 = 'KO:R' + r + ':M' + (j / 2 + 1);
        out.push({ key: k2, round: r, roundLabel: roundLabel(rounds - r), A: prev[j], B: prev[j + 1] });
        cur.push({ winnerOf: k2 });
      }
      if (r === rounds && opts.thirdPlace && prev.length === 2 && prev[0].winnerOf && prev[1].winnerOf) {
        out.push({ key: 'KO:3RD', round: r, roundLabel: 'Third place', A: { loserOf: prev[0].winnerOf }, B: { loserOf: prev[1].winnerOf } });
      }
      prev = cur;
    }
    return out;
  }
  // League → knockout: group winners meet runners-up of another group.
  function seedsFromGroups(groupTables, perGroup) {
    var take = Math.max(1, perGroup || 2);
    var seeds = [];
    for (var place = 0; place < take; place++) {
      var tier = [];
      groupTables.forEach(function (g) { if (g.rows[place]) tier.push(g.rows[place]); });
      tier.sort(function (a, b) { return (b.won - a.won) || (b.matchPoints - a.matchPoints) || (b.setRatio - a.setRatio) || (b.pointRatio - a.pointRatio); });
      tier.forEach(function (r) { seeds.push(r.teamId); });
    }
    return seeds;
  }

  return {
    POLICIES: POLICIES, DEFAULT_POLICY: DEFAULT_POLICY, CRITERIA: CRITERIA,
    DEFAULT_TIEBREAKERS: DEFAULT_TIEBREAKERS, TIEBREAK_PRESETS: TIEBREAK_PRESETS,
    normalizePolicy: normalizePolicy, normalizeTiebreakers: normalizeTiebreakers,
    matchFacts: matchFacts, compute: compute, fmtRatio: fmtRatio,
    roundRobin: roundRobin, knockout: knockout, bracketOrder: bracketOrder, roundLabel: roundLabel, seedsFromGroups: seedsFromGroups
  };
});
