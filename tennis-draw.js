/* ================================================================
   🏆 TENNIS DRAWS — knockout brackets, round-robin groups, and the
   standings of a group. Players (singles) or pairs (doubles) are
   ENTRIES: { entryId, seed?, name }. Pure functions — the server stores
   what they plan; nothing here reads a database or a clock.

   KNOCKOUT. The draw is the next power of two at or above the number of
   entries. Seeds take the standard lines (1 at the top, 2 at the bottom,
   3 and 4 in the other quarters, …) and BYES go to the top seeds, so a
   bye is never against another bye and a seed never meets a seed early.
   Unseeded entries fill the remaining lines in the order given (or drawn
   at random from a reproducible seed). Every match has a stable key
   (KO:<round>:<n>), so generating again never creates a match twice, and
   a later match names where its players come from (the winner of KO:1:3)
   — the server fills it only from a match that has REALLY been completed.

   ROUND ROBIN. Everyone plays everyone in the group once. Standings
   (ITF / ATP round-robin practice): matches won; two tied — who won
   their match; three or more — percentage of sets won, then of games
   won, then (down to two) their match, then the seeding.
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TennisDraw = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function nextPow2(n) { var p = 2; while (p < n) p *= 2; return p; }
  // the standard bracket order of ranks — seed 1 on the first line, seed 2
  // on the last, 1 meets 4 and 2 meets 3 in the semi-finals: for 8 entries
  // [1, 8, 5, 4, 3, 6, 7, 2]
  function seedOrder(size) {
    var s = [1, 2];
    if (size <= 2) return s.slice(0, Math.max(1, size));
    while (s.length < size) {
      var n = s.length * 2, next = [];
      for (var i = 0; i < s.length; i++) {
        if (i % 2 === 0) next.push(s[i], n + 1 - s[i]);
        else next.push(n + 1 - s[i], s[i]);
      }
      s = next;
    }
    return s;
  }
  function roundLabel(entrantsInRound) {
    if (entrantsInRound === 2) return 'Final';
    if (entrantsInRound === 4) return 'Semi-final';
    if (entrantsInRound === 8) return 'Quarter-final';
    return 'Round of ' + entrantsInRound;
  }
  // a reproducible shuffle (mulberry32 from a string)
  function rng(seedText) {
    var h = 1779033703 ^ String(seedText || 'draw').length;
    for (var i = 0; i < String(seedText || 'draw').length; i++) { h = Math.imul(h ^ String(seedText).charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
    var a = h >>> 0;
    return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  // Entries in draw order: seeds by their number, then the rest.
  function ranked(entries, opts) {
    opts = opts || {};
    var list = (entries || []).filter(function (e) { return e && e.entryId; });
    var seeded = list.filter(function (e) { return Number(e.seed) > 0; }).sort(function (a, b) { return Number(a.seed) - Number(b.seed); });
    var rest = list.filter(function (e) { return !(Number(e.seed) > 0); });
    if (opts.random) {
      var r = rng(opts.random === true ? 'draw' : opts.random);
      for (var i = rest.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = rest[i]; rest[i] = rest[j]; rest[j] = t; }
    }
    return seeded.concat(rest);
  }

  /* knockout(entries, { thirdPlace, random, prefix }) →
       { size, rounds, lines: [entry | null (bye)], matches: [ { key, round, roundIndex, roundLabel, slot,
         A: { entryId } | { winnerOf } | { loserOf }, B: …, bye: entryId? } ] } */
  function knockout(entries, opts) {
    opts = opts || {};
    var list = ranked(entries, opts);
    if (list.length < 2) return { size: 0, rounds: 0, lines: [], matches: [] };
    var size = nextPow2(list.length);
    var order = seedOrder(size);
    var lines = order.map(function (rank) { return list[rank - 1] || null; });
    var rounds = Math.round(Math.log(size) / Math.LN2);
    var pre = opts.prefix ? opts.prefix + ':' : '';
    var matches = [];
    // what fills each slot of the next round: an entry (a bye) or the winner of a match
    var feed = [];
    for (var i = 0; i < size; i += 2) {
      var a = lines[i], b = lines[i + 1], slot = i / 2 + 1;
      var key = pre + 'KO:1:' + slot;
      if (a && b) {
        matches.push({ key: key, round: 1, roundIndex: 1, roundLabel: roundLabel(size), slot: slot, A: { entryId: a.entryId }, B: { entryId: b.entryId } });
        feed.push({ winnerOf: key });
      } else {
        // a bye: the entry goes straight through (no match is made for it)
        var through = a || b;
        feed.push(through ? { entryId: through.entryId, bye: true } : null);
      }
    }
    for (var r = 2; r <= rounds; r++) {
      var next = [];
      for (var k = 0; k < feed.length; k += 2) {
        var s2 = k / 2 + 1, key2 = pre + 'KO:' + r + ':' + s2;
        var fa = feed[k], fb = feed[k + 1];
        matches.push({ key: key2, round: r, roundIndex: r, roundLabel: roundLabel(size / Math.pow(2, r - 1)), slot: s2,
          A: fa ? (fa.entryId ? { entryId: fa.entryId } : { winnerOf: fa.winnerOf }) : null,
          B: fb ? (fb.entryId ? { entryId: fb.entryId } : { winnerOf: fb.winnerOf }) : null });
        next.push({ winnerOf: key2 });
      }
      feed = next;
    }
    if (opts.thirdPlace && rounds >= 2) {
      var semis = matches.filter(function (m) { return m.round === rounds - 1; });
      if (semis.length === 2) matches.push({ key: pre + 'KO:3RD', round: rounds, roundIndex: rounds, roundLabel: 'Third place', slot: 2, A: { loserOf: semis[0].key }, B: { loserOf: semis[1].key }, thirdPlace: true });
    }
    return { size: size, rounds: rounds, lines: lines.map(function (e) { return e ? { entryId: e.entryId, seed: e.seed || null } : null; }), matches: matches };
  }

  // Round robin (the circle method): every pair once.
  function roundRobin(ids) {
    var list = (ids || []).slice();
    if (list.length < 2) return [];
    if (list.length % 2) list.push(null);
    var n = list.length, out = [];
    for (var r = 0; r < n - 1; r++) {
      for (var i = 0; i < n / 2; i++) {
        var a = list[i], b = list[n - 1 - i];
        if (a && b) out.push({ round: r + 1, A: r % 2 ? b : a, B: r % 2 ? a : b });
      }
      list.splice(1, 0, list.pop());
    }
    return out;
  }

  /* standings(entries, matches) — matches: { sides: { A: { entryId }, B }, status, result } of ONE group.
     → rows sorted: { entryId, played, won, lost, setsWon, setsLost, gamesWon, gamesLost, setPct, gamePct, rank, tied } */
  function standings(entries, matches) {
    var rows = {};
    (entries || []).forEach(function (e, i) { rows[e.entryId] = { entryId: e.entryId, seed: e.seed || null, order: i, played: 0, won: 0, lost: 0, setsWon: 0, setsLost: 0, gamesWon: 0, gamesLost: 0, walkovers: 0, retirements: 0 }; });
    var h2h = {};
    (matches || []).forEach(function (m) {
      if (!m || m.status !== 'completed' || !m.result || !m.result.winner) return;
      var a = m.sides && m.sides.A && m.sides.A.entryId, b = m.sides && m.sides.B && m.sides.B.entryId;
      if (!rows[a] || !rows[b]) return;
      var res = m.result, wSide = res.winner, w = wSide === 'A' ? a : b, l = wSide === 'A' ? b : a;
      [a, b].forEach(function (id) { rows[id].played++; });
      rows[w].won++; rows[l].lost++;
      h2h[w + '>' + l] = true;
      if (res.reason === 'walkover') { rows[l].walkovers++; return; }
      if (res.reason === 'retired') rows[l].retirements++;
      rows[a].setsWon += res.sets.A; rows[a].setsLost += res.sets.B;
      rows[b].setsWon += res.sets.B; rows[b].setsLost += res.sets.A;
      (res.scores || []).forEach(function (s) {
        // a match tie-break counts as one game (1-0) in game totals
        var ga = s.mtb ? (s.winner === 'A' ? 1 : 0) : s.A, gb = s.mtb ? (s.winner === 'B' ? 1 : 0) : s.B;
        rows[a].gamesWon += ga; rows[a].gamesLost += gb;
        rows[b].gamesWon += gb; rows[b].gamesLost += ga;
      });
    });
    var list = Object.keys(rows).map(function (k) {
      var r = rows[k];
      r.setPct = r.setsWon + r.setsLost ? r.setsWon / (r.setsWon + r.setsLost) : 0;
      r.gamePct = r.gamesWon + r.gamesLost ? r.gamesWon / (r.gamesWon + r.gamesLost) : 0;
      return r;
    });
    var beat = function (x, y) { return !!h2h[x.entryId + '>' + y.entryId]; };
    function order(group) {
      if (group.length < 2) return group;
      if (group.length === 2) {
        var p = group[0], q = group[1];
        if (beat(p, q)) return [p, q];
        if (beat(q, p)) return [q, p];
        p.tied = q.tied = true;
        return group.sort(bySeed);
      }
      // three or more: sets %, then games %; whoever is separated is placed, the rest go round again
      var crits = [function (r) { return r.setPct; }, function (r) { return r.gamePct; }];
      for (var c = 0; c < crits.length; c++) {
        var f = crits[c];
        var vals = group.map(f);
        if (vals.some(function (v) { return Math.abs(v - vals[0]) > 1e-9; })) {
          var buckets = {};
          group.forEach(function (r) { var k = f(r).toFixed(9); (buckets[k] = buckets[k] || []).push(r); });
          return Object.keys(buckets).sort(function (x, y) { return Number(y) - Number(x); }).reduce(function (acc, k) { return acc.concat(order(buckets[k])); }, []);
        }
      }
      group.forEach(function (r) { r.tied = true; });
      return group.sort(bySeed);
    }
    function bySeed(x, y) { return (x.seed || 999) - (y.seed || 999) || x.order - y.order; }
    var byWins = {};
    list.forEach(function (r) { (byWins[r.won] = byWins[r.won] || []).push(r); });
    var out = Object.keys(byWins).sort(function (x, y) { return Number(y) - Number(x); }).reduce(function (acc, k) { return acc.concat(order(byWins[k])); }, []);
    out.forEach(function (r, i) { r.rank = i + 1; r.setPct = Math.round(r.setPct * 1000) / 10; r.gamePct = Math.round(r.gamePct * 1000) / 10; delete r.order; });
    return out;
  }

  // Groups → knockout: the group winners first, then the runners-up …
  // ranked so a group's winner meets another group's runner-up (A1 v B2).
  function seedsFromGroups(groupStandings, perGroup) {
    var n = Math.max(1, perGroup || 2), out = [];
    for (var pos = 0; pos < n; pos++) {
      (groupStandings || []).forEach(function (g) { var r = g.rows && g.rows[pos]; if (r) out.push({ entryId: r.entryId, seed: out.length + 1, from: (g.name || '') + (pos + 1) }); });
    }
    return out;
  }

  return { nextPow2: nextPow2, seedOrder: seedOrder, roundLabel: roundLabel, ranked: ranked, knockout: knockout, roundRobin: roundRobin, standings: standings, seedsFromGroups: seedsFromGroups };
});
