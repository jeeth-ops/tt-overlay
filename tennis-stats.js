/* ================================================================
   📊 TENNIS STATISTICS — what the match's own timeline says, never more.

   Every figure is counted from the points as recorded (and as corrected
   since): a point undone does not count, a reclassified point counts as
   it now reads. Where the operator did not record something, the figure
   is UNAVAILABLE (null) — never a zero that looks like a fact:
     - first / second serve figures need the serve number of a point (the
       panel's serve tracking, a fault, a double fault) — only the points
       whose serve is known are counted, and `coverage` says how many;
     - winners and errors need classified points ("how was it won?");
     - net points need the net marked; rally length, serve speed need
       them entered (a speed may also come from a manual entry).
   Always known from the score alone: points won, service and return
   points, service games, break points, tie-breaks, sets, streaks.

   compute({ setup, state, timeline }) → { sides, players, available,
     coverage, games (the game-by-game log), sets, duration }
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tennis-engine.js'));
  else root.TennisStats = factory(root.TennisEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  var other = function (s) { return s === 'A' ? 'B' : 'A'; };
  var GENERIC = { POINT: 1, OTHER: 1, PENALTY: 1 };

  function serveBlock() {
    return { points: 0, won: 0, known: 0, firstIn: 0, firstWon: 0, secondPoints: 0, secondWon: 0, aces: 0, doubleFaults: 0, serviceWinners: 0, faults: 0, footFaults: 0, dirs: { WIDE: 0, BODY: 0, T: 0 }, dirAces: { WIDE: 0, BODY: 0, T: 0 }, dirKnown: 0,
      games: 0, gamesWon: 0, bpFaced: 0, bpSaved: 0, speeds: { first: [], second: [], all: [] } };
  }
  function returnBlock() { return { points: 0, won: 0, known: 0, firstPoints: 0, firstWon: 0, secondPoints: 0, secondWon: 0, games: 0, gamesWon: 0, bpChances: 0, bpConverted: 0, returnWinners: 0 }; }
  function sideBlock() {
    return { pointsWon: 0, pointsPlayed: 0, serve: serveBlock(), ret: returnBlock(), winners: 0, unforcedErrors: 0, forcedErrors: 0, forcedErrorsDrawn: 0,
      net: { points: 0, won: 0 }, gamesWon: 0, setsWon: 0, tiebreaks: { played: 0, won: 0 }, matchTiebreak: null,
      streak: { points: 0, games: 0 }, rally: { total: 0, n: 0 }, byKind: {} };
  }
  function playerBlock(p, side) {
    return { playerId: p.playerId, name: p.name, side: side, pointsWon: 0, serve: serveBlock(), ret: returnBlock(), winners: 0, unforcedErrors: 0, forcedErrors: 0, net: { points: 0, won: 0 }, byKind: {} };
  }
  function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : null; }
  function avg(list) { return list.length ? Math.round(list.reduce(function (x, y) { return x + y; }, 0) / list.length) : null; }
  function max(list) { return list.length ? Math.max.apply(null, list) : null; }

  function compute(input) {
    var ns = E.normalizeSetup(input.setup);
    var state = input.state;
    var tl = (input.timeline || []).filter(function (e) { return e && !e.voided && !e.invalid; });
    var sides = { A: sideBlock(), B: sideBlock() };
    var players = {};
    ['A', 'B'].forEach(function (s) { ns.sides[s].players.forEach(function (p) { players[p.playerId] = playerBlock(p, s); }); });
    var cov = { points: 0, serveKnown: 0, classified: 0, net: 0, rally: 0, speed: 0 };
    var games = [], curGame = null, sets = {};
    var run = { side: null, n: 0 }, grun = { side: null, n: 0 };
    var interruptedMs = 0, openStop = null;

    function gameKey(e) { return e.before.set + ':' + e.before.game; }
    tl.forEach(function (e) {
      if (e.type === 'PAUSE' || e.type === 'SUSPEND') { if (e.at) openStop = e.at; return; }
      if (e.type === 'RESUME') { if (openStop && e.at) interruptedMs += Math.max(0, e.at - openStop); openStop = null; return; }
      if (e.type === 'FAULT') {
        if (e.serverSide) { sides[e.serverSide].serve.faults++; if (players[e.server]) players[e.server].serve.faults++; }
        if (e.serverSide && e.foot) { sides[e.serverSide].serve.footFaults++; if (players[e.server]) players[e.server].serve.footFaults++; }
        if (e.speed) { var sp = sides[e.serverSide].serve.speeds; sp.all.push(e.speed); sp.first.push(e.speed); cov.speed++; if (players[e.server]) { players[e.server].serve.speeds.all.push(e.speed); players[e.server].serve.speeds.first.push(e.speed); } }
        return;
      }
      if (e.type !== 'POINT' || !e.before) return;
      cov.points++;
      var w = e.side, srv = e.serverSide, rcv = other(srv);
      var sv = sides[srv], rt = sides[rcv];
      var P = players[e.server], R = players[e.receiver];
      sides.A.pointsPlayed++; sides.B.pointsPlayed++;
      sides[w].pointsWon++;
      // the game log
      var key = gameKey(e);
      if (!curGame || curGame.key !== key) {
        curGame = { key: key, set: e.before.set, n: e.before.game, server: e.server, serverSide: srv, tiebreak: !!e.before.tiebreak, mtb: !!e.before.mtb, points: [], winner: null, break: false, games: null };
        games.push(curGame);
      }
      var after = e.after || e.before;
      curGame.points.push({ w: w, kind: e.kind, server: e.server, score: E.gameDisplay(after.points, !!e.before.tiebreak), serve: e.serve, bp: !!(e.pressure && e.pressure[rcv] && e.pressure[rcv].break), sp: !!(e.pressure && ((e.pressure.A && e.pressure.A.set) || (e.pressure.B && e.pressure.B.set))), mp: !!(e.pressure && ((e.pressure.A && e.pressure.A.match) || (e.pressure.B && e.pressure.B.match))), eventId: e.eventId });
      var gw = (e.effects || []).filter(function (x) { return x.type === 'GAME_WON' || (x.type === 'TIEBREAK_WON' && x.mtb); })[0];
      if (gw) { curGame.winner = gw.side; curGame.break = !!gw.break; curGame.games = gw.games || null; }
      // the set's points
      var st = sets[e.before.set] = sets[e.before.set] || { set: e.before.set, points: { A: 0, B: 0 } };
      st.points[w]++;
      // serving and returning
      sv.serve.points++; rt.ret.points++;
      if (w === srv) sv.serve.won++; else rt.ret.won++;
      if (P) { P.serve.points++; if (w === srv) P.serve.won++; }
      if (R) { R.ret.points++; if (w !== srv) R.ret.won++; }
      if (e.serve === 1 || e.serve === 2) {
        cov.serveKnown++;
        sv.serve.known++; rt.ret.known++;
        if (P) P.serve.known++;
        if (R) R.ret.known++;
        if (e.serve === 1) {
          sv.serve.firstIn++; rt.ret.firstPoints++;
          if (w === srv) sv.serve.firstWon++; else rt.ret.firstWon++;
          if (P) { P.serve.firstIn++; if (w === srv) P.serve.firstWon++; }
          if (R) { R.ret.firstPoints++; if (w !== srv) R.ret.firstWon++; }
        } else if (e.kind !== 'DOUBLE_FAULT') {
          // a second-serve point that was played (a double fault was not a second serve "in")
          sv.serve.secondPoints++; rt.ret.secondPoints++;
          if (w === srv) sv.serve.secondWon++; else rt.ret.secondWon++;
          if (P) { P.serve.secondPoints++; if (w === srv) P.serve.secondWon++; }
          if (R) { R.ret.secondPoints++; if (w !== srv) R.ret.secondWon++; }
        } else {
          sv.serve.secondPoints++; rt.ret.secondPoints++; rt.ret.secondWon++;
          if (P) P.serve.secondPoints++;
          if (R) { R.ret.secondPoints++; R.ret.secondWon++; }
        }
      }
      if (e.speed) {
        cov.speed++;
        var spd = sv.serve.speeds; spd.all.push(e.speed); (e.serve === 2 ? spd.second : spd.first).push(e.speed);
        if (P) { P.serve.speeds.all.push(e.speed); (e.serve === 2 ? P.serve.speeds.second : P.serve.speeds.first).push(e.speed); }
      }
      // break points (a game point for the receivers), from the moment before the point
      if (e.pressure && e.pressure[rcv] && e.pressure[rcv].break) {
        sv.serve.bpFaced++; rt.ret.bpChances++;
        if (P) P.serve.bpFaced++;
        if (R) R.ret.bpChances++;
        if (w === srv) { sv.serve.bpSaved++; if (P) P.serve.bpSaved++; }
        else { rt.ret.bpConverted++; if (R) R.ret.bpConverted++; }
      }
      // how it was won
      var k = e.kind || 'POINT';
      sides[w].byKind[k] = (sides[w].byKind[k] || 0) + 1;
      if (!GENERIC[k]) cov.classified++;
      var named = e.playerNamed && players[e.player] ? players[e.player] : null;
      if (named) named.byKind[k] = (named.byKind[k] || 0) + 1;
      // the serve's direction, where shot tracking recorded it
      if (e.serveDir && sv.serve.dirs[e.serveDir] != null) {
        sv.serve.dirs[e.serveDir]++; sv.serve.dirKnown++;
        if (P) { P.serve.dirs[e.serveDir]++; P.serve.dirKnown++; }
        if (k === 'ACE') { sv.serve.dirAces[e.serveDir]++; if (P) P.serve.dirAces[e.serveDir]++; }
      }
      if (k === 'ACE') { sv.serve.aces++; if (P) P.serve.aces++; }
      else if (k === 'DOUBLE_FAULT') { sv.serve.doubleFaults++; if (P) P.serve.doubleFaults++; if (e.foot) { sv.serve.footFaults++; if (P) P.serve.footFaults++; } }
      else if (k === 'SERVICE_WINNER') { sv.serve.serviceWinners++; if (P) P.serve.serviceWinners++; }
      else if (E.KINDS[k] && E.KINDS[k].winner) {
        sides[w].winners++; if (named) named.winners++;
        if (k === 'RETURN_WINNER') { rt.ret.returnWinners++; if (R) R.ret.returnWinners++; }
      } else if (k === 'UNFORCED_ERROR') { sides[other(w)].unforcedErrors++; if (named) named.unforcedErrors++; }
      else if (k === 'FORCED_ERROR') { sides[other(w)].forcedErrors++; sides[w].forcedErrorsDrawn++; if (named) named.forcedErrors++; }
      // the net
      if (e.net === 'A' || e.net === 'B') {
        cov.net++;
        sides[e.net].net.points++; if (w === e.net) sides[e.net].net.won++;
        var np = ns.format === 'doubles' ? (e.playerNamed && players[e.player] && players[e.player].side === e.net ? players[e.player] : null) : players[ns.sides[e.net].ids[0]];
        if (np) { np.net.points++; if (w === e.net) np.net.won++; }
      }
      if (e.rally != null) { cov.rally++; sides.A.rally.total += e.rally; sides.A.rally.n++; sides.B.rally.total += e.rally; sides.B.rally.n++; }
      // streaks
      if (run.side === w) run.n++; else { run.side = w; run.n = 1; }
      if (run.n > sides[w].streak.points) sides[w].streak.points = run.n;
      if (players[ns.sides[w].ids[0]] && ns.format !== 'doubles') players[ns.sides[w].ids[0]].pointsWon++;
      if (ns.format === 'doubles' && P && w === srv) { /* doubles: points won belong to the team */ }
      // games, sets, tie-breaks
      (e.effects || []).forEach(function (x) {
        if (x.type === 'GAME_WON' && !x.tiebreak) {
          sides[x.server].serve.games++; sides[other(x.server)].ret.games++;
          if (P) P.serve.games++;
          if (x.side === x.server) { sides[x.server].serve.gamesWon++; if (P) P.serve.gamesWon++; }
          else sides[x.side].ret.gamesWon++;
        }
        if (x.type === 'GAME_WON' || (x.type === 'TIEBREAK_WON' && x.mtb)) {
          if (grun.side === x.side) grun.n++; else { grun.side = x.side; grun.n = 1; }
          if (grun.n > sides[x.side].streak.games) sides[x.side].streak.games = grun.n;
        }
        if (x.type === 'TIEBREAK_WON') {
          if (x.mtb) { sides.A.matchTiebreak = { won: x.side === 'A', points: x.points }; sides.B.matchTiebreak = { won: x.side === 'B', points: x.points }; }
          else { sides.A.tiebreaks.played++; sides.B.tiebreaks.played++; sides[x.side].tiebreaks.won++; }
        }
      });
    });

    // games and sets won, from the score
    (state && state.sets ? state.sets : []).forEach(function (s) {
      if (s.rule && s.rule.type === 'mtb') return;
      sides.A.gamesWon += s.games.A; sides.B.gamesWon += s.games.B;
    });
    if (state) { sides.A.setsWon = state.setsWon.A; sides.B.setsWon = state.setsWon.B; }

    var available = {
      serve: cov.serveKnown > 0,
      outcomes: cov.classified > 0,
      net: cov.net > 0,
      rally: cov.rally > 0,
      speed: cov.speed > 0 || hasManualSpeed(state)
    };
    function finishServe(b, manual) {
      var sp = b.speeds;
      var out = {
        points: b.points, won: b.won, wonPct: pct(b.won, b.points),
        aces: b.aces, doubleFaults: b.doubleFaults, serviceWinners: b.serviceWinners, footFaults: b.footFaults,
        // serve directions: not recorded (null) unless shot tracking named at least one
        directions: b.dirKnown ? { recorded: b.dirKnown, wide: b.dirs.WIDE, body: b.dirs.BODY, t: b.dirs.T, acesWide: b.dirAces.WIDE, acesBody: b.dirAces.BODY, acesT: b.dirAces.T } : null,
        firstIn: available.serve ? b.firstIn : null, firstServes: available.serve ? b.known : null,
        firstPct: available.serve ? pct(b.firstIn, b.known) : null,
        firstWon: available.serve ? b.firstWon : null, firstWonPct: available.serve ? pct(b.firstWon, b.firstIn) : null,
        secondPoints: available.serve ? b.secondPoints : null, secondWon: available.serve ? b.secondWon : null, secondWonPct: available.serve ? pct(b.secondWon, b.secondPoints) : null,
        games: b.games, gamesWon: b.gamesWon, gamesWonPct: pct(b.gamesWon, b.games),
        bpFaced: b.bpFaced, bpSaved: b.bpSaved, bpSavedPct: pct(b.bpSaved, b.bpFaced),
        fastestKmh: manual && manual.fastestServeKmh != null ? Math.max(manual.fastestServeKmh, max(sp.all) || 0) : max(sp.all),
        avgFirstKmh: manual && manual.avgFirstServeKmh != null ? manual.avgFirstServeKmh : avg(sp.first),
        avgSecondKmh: manual && manual.avgSecondServeKmh != null ? manual.avgSecondServeKmh : avg(sp.second),
        coverage: b.points ? { known: b.known, of: b.points } : null
      };
      return out;
    }
    function finishReturn(b) {
      return {
        points: b.points, won: b.won, wonPct: pct(b.won, b.points),
        firstPoints: available.serve ? b.firstPoints : null, firstWon: available.serve ? b.firstWon : null, firstWonPct: available.serve ? pct(b.firstWon, b.firstPoints) : null,
        secondPoints: available.serve ? b.secondPoints : null, secondWon: available.serve ? b.secondWon : null, secondWonPct: available.serve ? pct(b.secondWon, b.secondPoints) : null,
        games: b.games, gamesWon: b.gamesWon, gamesWonPct: pct(b.gamesWon, b.games),
        bpChances: b.bpChances, bpConverted: b.bpConverted, bpConvertedPct: pct(b.bpConverted, b.bpChances),
        returnWinners: available.outcomes ? b.returnWinners : null
      };
    }
    var manualOfSide = function (s) {
      // a side's manual figures: the best of its players' (singles: the player's own)
      var m = {};
      ns.sides[s].ids.forEach(function (id) {
        var x = state && state.manual && state.manual[id];
        if (!x) return;
        if (x.fastestServeKmh != null) m.fastestServeKmh = Math.max(m.fastestServeKmh || 0, x.fastestServeKmh);
        if (x.avgFirstServeKmh != null && ns.format !== 'doubles') m.avgFirstServeKmh = x.avgFirstServeKmh;
        if (x.avgSecondServeKmh != null && ns.format !== 'doubles') m.avgSecondServeKmh = x.avgSecondServeKmh;
      });
      return m;
    };
    var outSides = {};
    ['A', 'B'].forEach(function (s) {
      var b = sides[s];
      outSides[s] = {
        pointsWon: b.pointsWon, pointsPlayed: b.pointsPlayed, pointsWonPct: pct(b.pointsWon, b.pointsPlayed),
        serve: finishServe(b.serve, manualOfSide(s)), ret: finishReturn(b.ret),
        winners: available.outcomes ? b.winners : null,
        unforcedErrors: available.outcomes ? b.unforcedErrors : null,
        forcedErrors: available.outcomes ? b.forcedErrors : null,
        net: available.net ? { points: b.net.points, won: b.net.won, wonPct: pct(b.net.won, b.net.points) } : null,
        gamesWon: b.gamesWon, setsWon: b.setsWon,
        tiebreaks: { played: b.tiebreaks.played, won: b.tiebreaks.won }, matchTiebreak: b.matchTiebreak,
        streak: b.streak, avgRally: available.rally && b.rally.n ? Math.round(b.rally.total / b.rally.n * 10) / 10 : null,
        byKind: b.byKind,
        totalPoints: b.pointsWon
      };
    });
    var outPlayers = {};
    Object.keys(players).forEach(function (id) {
      var p = players[id];
      var man = state && state.manual && state.manual[id];
      outPlayers[id] = {
        playerId: id, name: p.name, side: p.side,
        pointsWon: ns.format !== 'doubles' ? outSides[p.side].pointsWon : null,
        serve: finishServe(p.serve, man), ret: finishReturn(p.ret),
        winners: available.outcomes ? p.winners : null, unforcedErrors: available.outcomes ? p.unforcedErrors : null, forcedErrors: available.outcomes ? p.forcedErrors : null,
        net: available.net ? { points: p.net.points, won: p.net.won, wonPct: pct(p.net.won, p.net.points) } : null,
        byKind: p.byKind
      };
    });
    var setList = Object.keys(sets).map(function (k) { return sets[k]; }).sort(function (a, b) { return a.set - b.set; });
    var duration = null;
    if (state && state.startedAt) {
      var end = state.endedAt || state.lastEventAt || null;
      if (end) duration = { totalMs: Math.max(0, end - state.startedAt), playingMs: Math.max(0, end - state.startedAt - interruptedMs) };
    }
    return { format: ns.format, sides: outSides, players: outPlayers, available: available, coverage: cov, games: games, sets: setList, duration: duration };
  }
  function hasManualSpeed(state) {
    if (!state || !state.manual) return false;
    return Object.keys(state.manual).some(function (id) { var m = state.manual[id]; return m && (m.fastestServeKmh != null || m.avgFirstServeKmh != null || m.avgSecondServeKmh != null); });
  }

  // Who a point is about — its clip, its highlight — with the part each
  // played: the server of an ace / service winner / double fault, the
  // player who hit a winner or made the error, and whoever won it.
  function pointParticipants(setup, entry) {
    if (!entry || entry.type !== 'POINT') return [];
    var ns = E.normalizeSetup(setup);
    var out = [], seen = {};
    var add = function (id, role) { if (!id || seen[id + role]) return; var s = E.sideOf(ns, id); if (!s) return; seen[id + role] = 1; out.push({ playerId: id, side: s, role: role }); };
    var k = entry.kind || 'POINT', K = E.KINDS[k] || E.KINDS.POINT;
    if (k === 'ACE') add(entry.server, 'ace');
    else if (k === 'SERVICE_WINNER') add(entry.server, 'serve');
    else if (k === 'DOUBLE_FAULT') add(entry.server, 'error');
    else if (K.winner && entry.player && entry.playerNamed) add(entry.player, 'winner');
    else if (K.error && entry.player && entry.playerNamed) add(entry.player, 'error');
    // the point's winner(s): in singles the player; in doubles the named player, else the team
    if (ns.format !== 'doubles') add(ns.sides[entry.side].ids[0], 'won');
    else if (entry.player && entry.playerNamed && E.sideOf(ns, entry.player) === entry.side) add(entry.player, 'won');
    else ns.sides[entry.side].ids.forEach(function (id) { add(id, 'won'); });
    return out;
  }
  // the clip's kind, in the operator's words
  var CLIP_KINDS = {
    ACE: 'Ace', WINNER: 'Winner', LONG_RALLY: 'Long rally', BREAK_POINT: 'Break point', MATCH_POINT: 'Match point', SET_POINT: 'Set point',
    DOUBLE_FAULT: 'Double fault', RETURN: 'Return', NET_POINT: 'Net point', CELEBRATION: 'Celebration', POINT: 'Point', MANUAL: 'Manual clip'
  };
  // the clip kind a point earns by itself (the operator can still say otherwise)
  function clipKindOf(entry) {
    if (!entry || entry.type !== 'POINT') return 'MANUAL';
    var p = entry.pressure || {}, hit = function (k) { return (p.A && p.A[k]) || (p.B && p.B[k]); };
    if (hit('match')) return 'MATCH_POINT';
    if (hit('set')) return 'SET_POINT';
    if ((p.A && p.A.break) || (p.B && p.B.break)) return 'BREAK_POINT';
    if (entry.kind === 'ACE') return 'ACE';
    if (entry.kind === 'DOUBLE_FAULT') return 'DOUBLE_FAULT';
    if (entry.kind === 'RETURN_WINNER') return 'RETURN';
    if (E.KINDS[entry.kind] && E.KINDS[entry.kind].winner) return 'WINNER';
    if (entry.net) return 'NET_POINT';
    if (entry.rally != null && entry.rally >= 12) return 'LONG_RALLY';
    return 'POINT';
  }

  return { compute: compute, pointParticipants: pointParticipants, clipKindOf: clipKindOf, CLIP_KINDS: CLIP_KINDS };
});
