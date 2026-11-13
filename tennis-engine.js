/* ================================================================
   🎾 TENNIS ENGINE — lawn tennis, singles and doubles, as an event ledger.

   Baseline: the ITF Rules of Tennis — scoring in a game and a set
   (Rules 5–6), the tie-break game, the order of service and of receiving
   in doubles (Rules 14–15), the change of ends (Rule 10), lets (Rule 22)
   and Appendix V: No-Ad scoring with the deciding point, short sets, the
   match tie-break in place of the final set. Every number a competition
   may change lives in `rules`, frozen with the match, and
   normalizeRules() says which of them differ from the ITF defaults so a
   custom format is never mistaken for the standard one.

   NOTHING HERE IS VOLLEYBALL'S (or cricket's). It shares only the
   ledger *pattern* of the volleyball module: a match is its ordered list
   of events and everything shown is derived from that list.

   THE MODEL. Events: the toss, the start (first server, the doubles
   serving and receiving order, which end each side starts at), every
   point, every first-serve fault and let, the doubles order at a new set,
   status changes (pause, suspend, resume, retire, walkover, default,
   abandon), corrections. The score, the server and receiver, the court
   the point is served from, the ends, tie-breaks, sets, the result — all
   derived. A retried request can never score twice: every event carries
   its own eventId, minted once by the device that pressed the button.

   UNDO WITHOUT COPYING THE MATCH. check() validates an event without
   changing anything. commit() then records only what the event is about
   to change — the current game, the current set's line, a few counters:
   a fixed handful of fields, never the match — and applies it. Undo of
   the latest event puts those back (O(1)); Redo applies it again. Only a
   correction of an EARLIER event (VOID, or a CORRECT that changes who won
   a point) replays the ledger, and is refused if it would make any later
   event impossible.

   Used by:
     - tennis-server.js  (authoritative: validates and stores events)
     - tennis-panel.html / tennis-remote.html (the same rules, instantly)
     - tennis-stats.js   (statistics from the timeline)
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TennisEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIDES = ['A', 'B'];
  function other(s) { return s === 'A' ? 'B' : 'A'; }
  function isSide(s) { return s === 'A' || s === 'B'; }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function int(v, d, lo, hi) {
    var n = Math.round(num(v, d));
    if (!isFinite(n)) n = d;
    if (lo != null && n < lo) n = lo;
    if (hi != null && n > hi) n = hi;
    return n;
  }
  function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 120); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  /* =================================================================
     RULES
     ================================================================= */
  var FINAL_SET = {
    standard: 'Played like the other sets',
    advantage: 'Advantage set (no tie-break)',
    tiebreak: 'A tie-break with its own target',
    matchTiebreak: 'A match tie-break instead of the set'
  };
  var DEFAULT_RULES = {
    ruleset: 'ITF Rules of Tennis',
    bestOf: 3,               // first to 2 sets
    gamesPerSet: 6,          // a set is won with 6 games …
    setMargin: 2,            // … and a two-game lead (7-5) …
    tiebreakAt: 6,           // … or by a tie-break at 6-all (null = advantage sets)
    tiebreakPoints: 7,       // first to 7 points …
    tiebreakMargin: 2,       // … two clear (1 = sudden death at the last point)
    finalSet: 'standard',    // the deciding set — see FINAL_SET
    finalTiebreakAt: null,   // finalSet 'tiebreak': the tie-break at n-all (e.g. 6, or 12)
    finalTiebreakPoints: null, // finalSet 'tiebreak' / 'matchTiebreak': its target (10)
    noAd: false,             // No-Ad: at deuce the next point (the deciding point) wins the game
    lets: true               // a let on serve is replayed (false = the no-let rule: in play)
  };

  // A tie-break at n-all — never below one game short of a set (a 6-game
  // set with a tie-break at 4-all would end 5-4, which no format means).
  function tiebreakAtOf(v, games, required) {
    if (v === undefined) return games;
    if (!required && (v === null || v === false || v === 'none' || v === '' || v === 0 || v === '0')) return null;
    var n = int(v, games, 1, 30);
    return n < games - 1 ? games : n;
  }

  function normalizeRules(input) {
    var r = input && typeof input === 'object' ? input : {};
    var bestOf = int(r.bestOf, DEFAULT_RULES.bestOf, 1, 7);
    if (bestOf % 2 === 0) bestOf += 1;                 // always odd: someone must win
    var games = int(r.gamesPerSet, DEFAULT_RULES.gamesPerSet, 1, 12);
    var tbAt = tiebreakAtOf(has(r, 'tiebreakAt') ? r.tiebreakAt : undefined, games, false);
    var finalSet = has(FINAL_SET, r.finalSet) ? r.finalSet : 'standard';
    var out = {
      ruleset: str(r.ruleset || DEFAULT_RULES.ruleset, 60),
      bestOf: bestOf,
      gamesPerSet: games,
      setMargin: String(r.setMargin) === '1' ? 1 : 2,
      tiebreakAt: tbAt,
      tiebreakPoints: int(r.tiebreakPoints, DEFAULT_RULES.tiebreakPoints, 3, 21),
      tiebreakMargin: String(r.tiebreakMargin) === '1' ? 1 : 2,
      finalSet: finalSet,
      finalTiebreakAt: finalSet === 'tiebreak' ? tiebreakAtOf(r.finalTiebreakAt == null ? (tbAt == null ? games : tbAt) : r.finalTiebreakAt, games, true) : null,
      finalTiebreakPoints: finalSet === 'tiebreak' || finalSet === 'matchTiebreak' ? int(r.finalTiebreakPoints, 10, 3, 21) : null,
      noAd: !!r.noAd,
      lets: r.lets == null ? true : !!r.lets
    };
    // Which choices differ from the ITF defaults — shown wherever the rules
    // are shown, so a custom format is always labelled as one.
    var custom = [];
    ['bestOf', 'gamesPerSet', 'setMargin', 'tiebreakAt', 'tiebreakPoints', 'tiebreakMargin', 'finalSet', 'noAd', 'lets'].forEach(function (k) {
      if (JSON.stringify(out[k]) !== JSON.stringify(DEFAULT_RULES[k])) custom.push(k);
    });
    out.custom = custom;
    // best of 3 / 5 with nothing else changed is the standard format
    out.official = custom.filter(function (k) { return k !== 'bestOf'; }).length === 0;
    out.label = rulesLabel(out);
    return out;
  }

  function rulesLabel(r) {
    var parts = [];
    parts.push(r.bestOf === 1 ? (r.finalSet === 'matchTiebreak' ? 'Match tie-break' : 'One set') : 'Best of ' + r.bestOf + ' sets');
    if (!(r.bestOf === 1 && r.finalSet === 'matchTiebreak')) {
      if (r.gamesPerSet !== 6) parts.push('sets to ' + r.gamesPerSet + ' games');
      if (r.setMargin === 1) parts.push('no two-game margin');
      parts.push(r.tiebreakAt == null ? 'advantage sets' : 'tie-break at ' + r.tiebreakAt + '-all' + (r.tiebreakPoints !== 7 ? ' to ' + r.tiebreakPoints : '') + (r.tiebreakMargin === 1 ? ' (sudden death)' : ''));
    }
    if (r.finalSet === 'matchTiebreak') { if (r.bestOf > 1) parts.push((r.bestOf === 3 ? 'third' : 'deciding') + ' set: ' + r.finalTiebreakPoints + '-point match tie-break'); else parts.push('first to ' + r.finalTiebreakPoints); }
    else if (r.finalSet === 'advantage') parts.push((r.bestOf === 1 ? 'the' : 'final') + ' set: advantage, no tie-break');
    else if (r.finalSet === 'tiebreak') parts.push((r.bestOf === 1 ? 'the' : 'final') + ' set: ' + r.finalTiebreakPoints + '-point tie-break at ' + r.finalTiebreakAt + '-all');
    if (r.noAd) parts.push('No-Ad');
    if (!r.lets) parts.push('no-let');
    return parts.join(' · ');
  }

  // Ready-made formats for the match / tournament set-up (the panel and
  // the dashboard offer these; anything else is "custom").
  var PRESETS = {
    bo3: { label: 'Best of 3 sets', rules: { bestOf: 3 } },
    bo3mtb: { label: 'Best of 3 · match tie-break for the 3rd set', rules: { bestOf: 3, finalSet: 'matchTiebreak', finalTiebreakPoints: 10 } },
    doubles: { label: 'Doubles · No-Ad · match tie-break', rules: { bestOf: 3, noAd: true, finalSet: 'matchTiebreak', finalTiebreakPoints: 10 } },
    bo5: { label: 'Best of 5 sets', rules: { bestOf: 5 } },
    slam: { label: 'Best of 5 · 10-point tie-break at 6-all in the 5th', rules: { bestOf: 5, finalSet: 'tiebreak', finalTiebreakAt: 6, finalTiebreakPoints: 10 } },
    oneSet: { label: 'One set · tie-break at 6-all', rules: { bestOf: 1 } },
    proSet: { label: 'Pro set · first to 8 · tie-break at 8-all', rules: { bestOf: 1, gamesPerSet: 8, tiebreakAt: 8 } },
    shortSets: { label: 'Short sets · first to 4 · tie-break at 4-all · match tie-break', rules: { bestOf: 3, gamesPerSet: 4, tiebreakAt: 4, finalSet: 'matchTiebreak', finalTiebreakPoints: 10 } },
    fast4: { label: 'FAST4 · first to 4 · No-Ad · 5-point tie-break at 3-all · no-let', rules: { bestOf: 3, gamesPerSet: 4, tiebreakAt: 3, tiebreakPoints: 5, tiebreakMargin: 1, noAd: true, lets: false } },
    advantage: { label: 'Best of 3 · advantage sets (no tie-break)', rules: { bestOf: 3, tiebreakAt: null } },
    mtbOnly: { label: 'Match tie-break only (first to 10)', rules: { bestOf: 1, finalSet: 'matchTiebreak', finalTiebreakPoints: 10 } }
  };
  function presetOf(rules) {
    var n = normalizeRules(rules);
    var keys = Object.keys(PRESETS);
    for (var i = 0; i < keys.length; i++) {
      var p = normalizeRules(PRESETS[keys[i]].rules);
      if (JSON.stringify(Object.assign({}, p, { ruleset: '' })) === JSON.stringify(Object.assign({}, n, { ruleset: '' }))) return keys[i];
    }
    return 'custom';
  }

  function setsToWin(rules) { return Math.floor(rules.bestOf / 2) + 1; }
  // How set n is played: a normal set, or a match tie-break in its place.
  function setRule(rules, n) {
    var final = n === rules.bestOf;
    if (final && rules.finalSet === 'matchTiebreak') return { type: 'mtb', points: rules.finalTiebreakPoints, margin: 2, final: true };
    var r = { type: 'set', games: rules.gamesPerSet, margin: rules.setMargin, tiebreakAt: rules.tiebreakAt, tbPoints: rules.tiebreakPoints, tbMargin: rules.tiebreakMargin, final: final };
    if (final && rules.finalSet === 'advantage') r.tiebreakAt = null;
    if (final && rules.finalSet === 'tiebreak') { r.tiebreakAt = rules.finalTiebreakAt; r.tbPoints = rules.finalTiebreakPoints; r.tbMargin = 2; }
    return r;
  }

  // THE game-winning rule. A standard game: four points and two clear
  // (40-40 is deuce; advantage; game) — or, No-Ad, the deciding point at
  // deuce wins it. A tie-break: its target with its margin.
  function gameWon(p, o, noAd) { return p >= 4 && (noAd ? p > o : p - o >= 2); }
  function tbWon(p, o, target, margin) { return p >= target && p - o >= margin; }
  // THE set-winning rule (a tie-break game wins the set by itself).
  function setWonByGames(games, side, rule) { var a = games[side], b = games[other(side)]; return a >= rule.games && a - b >= rule.margin; }

  /* =================================================================
     POINTS — how a point was won. `wins` fixes the side the point must go
     to; `by` says whose player a statistic is credited to (the server,
     the point's winner, or the player of the losing side who erred).
     ================================================================= */
  var KINDS = {
    POINT:          { label: 'Point', short: 'PT', group: 'general', by: 'winner' },
    ACE:            { label: 'Ace', short: 'ACE', group: 'serve', by: 'server', wins: 'server' },
    SERVICE_WINNER: { label: 'Service winner', short: 'SW', group: 'serve', by: 'server', wins: 'server' },
    DOUBLE_FAULT:   { label: 'Double fault', short: 'DF', group: 'serve', by: 'server', wins: 'receiver', error: true },
    WINNER:         { label: 'Winner', short: 'W', group: 'winner', by: 'winner', winner: true },
    RETURN_WINNER:  { label: 'Return winner', short: 'RW', group: 'winner', by: 'winner', wins: 'receiver', winner: true },
    PASSING_WINNER: { label: 'Passing shot', short: 'PS', group: 'winner', by: 'winner', winner: true },
    VOLLEY_WINNER:  { label: 'Volley winner', short: 'VW', group: 'winner', by: 'winner', winner: true },
    SMASH_WINNER:   { label: 'Smash winner', short: 'SM', group: 'winner', by: 'winner', winner: true },
    DROP_WINNER:    { label: 'Drop shot winner', short: 'DS', group: 'winner', by: 'winner', winner: true },
    FORCED_ERROR:   { label: 'Forced error', short: 'FE', group: 'error', by: 'loser', error: true },
    UNFORCED_ERROR: { label: 'Unforced error', short: 'UE', group: 'error', by: 'loser', error: true },
    PENALTY:        { label: 'Point penalty', short: 'PEN', group: 'other', by: 'loser' },
    OTHER:          { label: 'Other', short: 'OTH', group: 'other', by: 'winner' }
  };
  var STROKES = { FH: 'Forehand', BH: 'Backhand', VOLLEY: 'Volley', HALF_VOLLEY: 'Half-volley', SMASH: 'Smash', DROP: 'Drop shot', LOB: 'Lob', SERVE: 'Serve', RETURN: 'Return', OTHER: 'Other' };
  var SERVE_DIRS = { WIDE: 'Wide', BODY: 'Body', T: 'Down the T' };
  var DIR_WORDS = { WIDE: 'out wide', BODY: 'into the body', T: 'down the T' };   // as the commentary says it
  var INTERRUPTIONS = { MEDICAL: 'Medical time-out', TOILET: 'Toilet / change of attire break', EQUIPMENT: 'Equipment', RAIN: 'Rain', LIGHT: 'Bad light', DARKNESS: 'Darkness', HEAT: 'Heat', OTHER: 'Other' };
  var MANUAL_STATS = { fastestServeKmh: 'Fastest serve (km/h)', avgFirstServeKmh: 'Average 1st serve (km/h)', avgSecondServeKmh: 'Average 2nd serve (km/h)' };

  var META = { UNDO: 1, REDO: 1, VOID: 1, CORRECT: 1 };
  var BASE_TYPES = ['TOSS', 'START', 'POINT', 'FAULT', 'LET', 'SET_ORDER', 'SERVE_CORRECTION', 'ENDS',
    'PAUSE', 'SUSPEND', 'RESUME', 'RETIRE', 'WALKOVER', 'DEFAULT', 'ABANDON', 'MANUAL_STAT', 'NOTE'];
  var EVENT_TYPES = BASE_TYPES.concat(Object.keys(META));
  var STATUS_TYPES = { PAUSE: 1, SUSPEND: 1, RESUME: 1, RETIRE: 1, WALKOVER: 1, DEFAULT: 1, ABANDON: 1 };
  // what a CORRECT of a point may change without moving the score
  var DETAIL_FIELDS = { kind: 1, player: 1, stroke: 1, net: 1, rally: 1, loc: 1, speed: 1, serveDir: 1, note: 1, serve: 1, receiver: 1, foot: 1 };
  var PATCHABLE = Object.assign({ winner: 1 }, DETAIL_FIELDS);

  /* =================================================================
     THE MATCH SET-UP
     setup = { format: 'singles' | 'doubles', rules,
               sides: { A: { name, short, players: [ { playerId, name, short, country } ] }, B: … } }
     — the players as entered for THIS match (a later profile edit never
     rewrites a played match).
     ================================================================= */
  function shortName(name) {
    var w = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (w.length < 2) return w[0] || '';
    return w[0][0].toUpperCase() + '. ' + w.slice(1).join(' ');
  }
  function surname(name) { var w = String(name || '').trim().split(/\s+/).filter(Boolean); return w.length ? w[w.length - 1] : ''; }
  function normalizeSetup(setup) {
    setup = setup || {};
    var rules = normalizeRules(setup.rules);
    var format = setup.format === 'doubles' ? 'doubles' : 'singles';
    var need = format === 'doubles' ? 2 : 1;
    var sides = {}, byId = {};
    SIDES.forEach(function (s) {
      var src = (setup.sides && setup.sides[s]) || {};
      var players = [];
      (Array.isArray(src.players) ? src.players : []).forEach(function (p) {
        if (!p || !p.playerId || byId[p.playerId] || players.length >= need) return;
        var id = String(p.playerId);
        var q = { playerId: id, name: String(p.name || ''), short: String(p.short || shortName(p.name)), country: String(p.country || '') };
        players.push(q);
        byId[id] = { side: s, player: q };
      });
      var auto = format === 'doubles' ? players.map(function (p) { return surname(p.name); }).filter(Boolean).join(' / ') : (players[0] ? players[0].name : '');
      sides[s] = {
        name: String(src.name || auto || (s === 'A' ? 'Player A' : 'Player B')),
        short: String(src.short || (format === 'doubles' ? players.map(function (p) { return surname(p.name).slice(0, 3).toUpperCase(); }).join('/') : (players[0] ? surname(players[0].name) : s))),
        players: players, ids: players.map(function (p) { return p.playerId; })
      };
    });
    return { rules: rules, format: format, need: need, sides: sides, byId: byId, ready: sides.A.players.length === need && sides.B.players.length === need };
  }
  function nsOf(setup) { return setup && setup.sides && setup.byId && setup.rules && setup.rules.label ? setup : normalizeSetup(setup); }
  function sideOf(ns, playerId) { var x = playerId && ns.byId[playerId]; return x ? x.side : null; }
  function playerOf(ns, playerId) { var x = playerId && ns.byId[playerId]; return x ? x.player : null; }
  function nameOf(ns, playerId) { var p = playerOf(ns, playerId); return p ? p.name : ''; }
  function partner(ns, playerId) { var s = sideOf(ns, playerId); if (!s) return null; var ids = ns.sides[s].ids; return ids[0] === playerId ? ids[1] || null : ids[0]; }

  /* =================================================================
     STATE
     ================================================================= */
  function createState(ns) {
    return {
      rules: ns.rules,
      status: 'pregame',        // pregame | in_play | paused | suspended | completed | abandoned
      interruption: null,       // { type, kind, reason, at } while paused / suspended
      toss: null,
      sets: [],                 // { n, games: {A,B}, tb: {A,B} | null, winner, rule, startedAt, endedAt, firstServer }
      setsWon: { A: 0, B: 0 },
      game: null,               // { points: {A,B}, tiebreak, mtb, target, margin, turn, n }
      turn: 0,                  // games begun in the match (a tie-break is one) — whose turn it is to serve
      rotation: null,           // { order: [playerIds], base } — the server of turn t is order[(t − base) mod n]
      receive: null,            // doubles: { A: { deuce, ad }, B: { deuce, ad } } — who receives in which court
      left: null,               // the side at the left end (the chair umpire's left)
      serve: 1,                 // the coming serve: first, or second after a fault
      lets: 0,                  // lets on this serve (information only)
      pointNo: 0,               // points played in the match
      gameNo: 0,                // games completed in the match
      betweenSets: false,       // a set has ended; the next set's first point is still to come
      winner: null,
      result: null,
      startedAt: null,
      endedAt: null,
      manual: {},               // MANUAL_STAT: playerId -> { key: value }
      lastEventAt: null
    };
  }
  function curSet(state) { return state.sets[state.sets.length - 1] || null; }
  function live(state) { return state.status === 'in_play'; }
  function playing(state) { return state.status === 'in_play' || state.status === 'paused' || state.status === 'suspended'; }

  // the server of turn t, and of the coming point (in a tie-break the
  // serve changes after the first point, then every two points — the
  // rotation carries on as in the set)
  function serverAt(state, turn) {
    var r = state.rotation;
    if (!r || !r.order || !r.order.length) return null;
    var n = r.order.length;
    return r.order[(((turn - r.base) % n) + n) % n];
  }
  function pointTurn(state) {
    var g = state.game;
    if (!g) return state.turn;
    if (!g.tiebreak) return g.turn;
    var k = g.points.A + g.points.B;
    return g.turn + Math.floor((k + 1) / 2);
  }
  function currentServer(state) { return state.game ? serverAt(state, pointTurn(state)) : null; }
  // every point of a game (tie-break included) is served alternately from
  // the right (deuce) and left (ad) court, starting from the right
  function courtOf(state) { var g = state.game; if (!g) return null; return (g.points.A + g.points.B) % 2 === 0 ? 'deuce' : 'ad'; }
  function currentReceiver(ns, state) {
    var srv = currentServer(state);
    if (!srv) return null;
    var side = other(sideOf(ns, srv));
    if (ns.format !== 'doubles') return ns.sides[side].ids[0] || null;
    var rc = state.receive && state.receive[side];
    if (!rc) return ns.sides[side].ids[0] || null;
    return courtOf(state) === 'deuce' ? rc.deuce : rc.ad;
  }
  // who served the game that is being / was just played (a tie-break: its first server)
  function gameServer(state) { return state.game ? serverAt(state, state.game.turn) : null; }

  function newGame(state) {
    var set = curSet(state), rule = set.rule;
    var tb = rule.type === 'mtb' || (rule.tiebreakAt != null && set.games.A === rule.tiebreakAt && set.games.B === rule.tiebreakAt);
    state.game = {
      points: { A: 0, B: 0 }, tiebreak: tb, mtb: rule.type === 'mtb',
      target: tb ? (rule.type === 'mtb' ? rule.points : rule.tbPoints) : null,
      margin: tb ? (rule.type === 'mtb' ? rule.margin : rule.tbMargin) : null,
      turn: state.turn, n: set.games.A + set.games.B + 1
    };
  }
  function newSet(state, n) {
    state.sets.push({ n: n, games: { A: 0, B: 0 }, tb: null, winner: null, rule: setRule(state.rules, n), startedAt: null, endedAt: null, firstServer: null });
    newGame(state);
  }

  function fail(code, error, extra) { return Object.assign({ ok: false, code: code, error: error }, extra || {}); }
  function sideName(ns, s) { return ns.sides[s] ? ns.sides[s].name : s; }

  /* =================================================================
     VALIDATION — every reason an event cannot be recorded, checked
     before anything changes (mutate() below never fails).
     ================================================================= */
  function notPlaying(state) {
    if (state.status === 'pregame') return fail('NOT_STARTED', 'The match has not started — start it first');
    if (state.status === 'paused') return fail('PAUSED', 'Play is paused — resume the match first');
    if (state.status === 'suspended') return fail('SUSPENDED', 'The match is suspended — resume it first');
    if (state.status === 'completed') return fail('MATCH_OVER', 'The match is over');
    if (state.status === 'abandoned') return fail('MATCH_OVER', 'The match was abandoned');
    return fail('NOT_IN_PLAY', 'The match is not in play');
  }
  // A doubles order: four players, the teams alternating; receive: each
  // team's deuce-court and ad-court player.
  function checkOrder(ns, order, teamFirst) {
    var n = ns.format === 'doubles' ? 4 : 2;
    if (!Array.isArray(order) || order.length !== n) return fail('ORDER_INVALID', ns.format === 'doubles' ? 'Give the order of service of all four players' : 'Give both players');
    var seen = {};
    for (var i = 0; i < n; i++) {
      var id = order[i], s = sideOf(ns, id);
      if (!s) return fail('INVALID_PLAYER', 'A player in the order of service is not in this match');
      if (seen[id]) return fail('ORDER_INVALID', nameOf(ns, id) + ' is listed twice in the order of service');
      seen[id] = 1;
      if (s !== (i % 2 === 0 ? sideOf(ns, order[0]) : other(sideOf(ns, order[0])))) return fail('ORDER_INVALID', 'The order of service must alternate between the two sides');
    }
    if (teamFirst && sideOf(ns, order[0]) !== teamFirst) return fail('ORDER_INVALID', sideName(ns, teamFirst) + ' are due to serve first in this set');
    return null;
  }
  function checkReceive(ns, receive) {
    if (ns.format !== 'doubles') return null;
    if (!receive || typeof receive !== 'object') return fail('RECEIVE_INVALID', 'Say which player of each team receives in the deuce court');
    for (var i = 0; i < 2; i++) {
      var s = SIDES[i], rc = receive[s];
      if (!rc || !rc.deuce || !rc.ad || rc.deuce === rc.ad || sideOf(ns, rc.deuce) !== s || sideOf(ns, rc.ad) !== s) return fail('RECEIVE_INVALID', sideName(ns, s) + ': choose who receives in the deuce court and who in the ad court');
    }
    return null;
  }
  function singlesOrder(ns, server) { var s = sideOf(ns, server); return [server, ns.sides[other(s)].ids[0]]; }
  function defaultReceive(ns) {
    if (ns.format !== 'doubles') return null;
    return { A: { deuce: ns.sides.A.ids[0], ad: ns.sides.A.ids[1] }, B: { deuce: ns.sides.B.ids[0], ad: ns.sides.B.ids[1] } };
  }
  // The team due to serve the first game of the coming set (the serve
  // alternates by side every game, across sets too — a tie-break counts as
  // one game, served by its first server).
  function teamDue(ns, state) { return sideOf(ns, serverAt(state, state.turn)); }
  function kindOf(ev) { return has(KINDS, ev.kind) ? ev.kind : 'POINT'; }

  function validate(ns, state, ev) {
    var t = ev.type;
    if (EVENT_TYPES.indexOf(t) < 0) return fail('UNKNOWN_EVENT', 'Unknown event type ' + t);
    if (META[t]) return fail('INVALID_EVENT', 'Corrections go through the ledger');
    switch (t) {
      case 'TOSS': {
        if (state.status !== 'pregame') return fail('ALREADY_STARTED', 'The toss is recorded before the match starts');
        if (!isSide(ev.winner)) return fail('INVALID_EVENT', 'Who won the toss?');
        if (['serve', 'receive', 'end', 'defer'].indexOf(ev.choice) < 0) return fail('INVALID_EVENT', 'What did the toss winner choose?');
        if (!isSide(ev.firstServe)) return fail('INVALID_EVENT', 'Who serves first?');
        if (ev.choice === 'serve' && ev.firstServe !== ev.winner) return fail('TOSS_INVALID', sideName(ns, ev.winner) + ' chose to serve — they serve first');
        if (ev.choice === 'receive' && ev.firstServe === ev.winner) return fail('TOSS_INVALID', sideName(ns, ev.winner) + ' chose to receive — ' + sideName(ns, other(ev.winner)) + ' serve first');
        if (ev.left != null && !isSide(ev.left)) return fail('INVALID_EVENT', 'Which side starts at the left end?');
        return null;
      }
      case 'START': {
        if (state.status !== 'pregame') return fail('ALREADY_STARTED', 'The match has already started');
        if (!ns.ready) return fail('PLAYERS_MISSING', ns.format === 'doubles' ? 'Both teams need their two players before the match starts' : 'Both players must be known before the match starts');
        if (!sideOf(ns, ev.server)) return fail('INVALID_PLAYER', 'Choose who serves first');
        if (ns.format === 'doubles') {
          var bad = checkOrder(ns, ev.order, null);
          if (bad) return bad;
          if (ev.order[0] !== ev.server) return fail('ORDER_INVALID', 'The first server opens the order of service');
          var badR = checkReceive(ns, ev.receive || defaultReceive(ns));
          if (badR) return badR;
        }
        if (ev.left != null && !isSide(ev.left)) return fail('INVALID_EVENT', 'Which side starts at the left end?');
        return null;
      }
      case 'POINT': {
        if (!live(state)) return notPlaying(state);
        if (!isSide(ev.winner)) return fail('INVALID_EVENT', 'Who won the point?');
        var kind = kindOf(ev), k = KINDS[kind];
        var srv = currentServer(state), srvSide = sideOf(ns, srv);
        if (k.wins === 'server' && ev.winner !== srvSide) return fail('KIND_MISMATCH', k.label + ': the point goes to the server — ' + sideName(ns, srvSide));
        if (k.wins === 'receiver' && ev.winner === srvSide) return fail('KIND_MISMATCH', k.label + ': the point goes to the receiver — ' + sideName(ns, other(srvSide)));
        if (ev.player != null) {
          var ps = sideOf(ns, ev.player);
          if (!ps) return fail('INVALID_PLAYER', 'That player is not in this match');
          var want = k.by === 'server' ? srvSide : k.by === 'loser' ? other(ev.winner) : ev.winner;
          if (ps !== want) return fail('INVALID_PLAYER', nameOf(ns, ev.player) + ' is on the wrong side for a ' + k.label.toLowerCase());
          if (k.by === 'server' && ev.player !== srv) return fail('INVALID_PLAYER', nameOf(ns, srv) + ' is serving, not ' + nameOf(ns, ev.player));
        }
        if (ev.serve != null && ev.serve !== 1 && ev.serve !== 2) return fail('INVALID_EVENT', 'A point is played on the first or the second serve');
        if (ev.serve === 1 && state.serve === 2) return fail('SERVE_MISMATCH', 'A first serve fault was recorded — this point is on the second serve');
        if (kind === 'DOUBLE_FAULT' && ev.serve === 1) return fail('SERVE_MISMATCH', 'A double fault is the second serve');
        if (ev.receiver != null) {
          // the deciding point (No-Ad): the receivers choose who receives it
          if (sideOf(ns, ev.receiver) !== other(srvSide)) return fail('INVALID_PLAYER', 'The receiver is a player of the receiving side');
        }
        if (ev.net != null && !isSide(ev.net)) return fail('INVALID_EVENT', 'Which side came to the net?');
        return null;
      }
      case 'FAULT': {
        if (!live(state)) return notPlaying(state);
        if (state.serve !== 1) return fail('SECOND_SERVE', 'That was the second serve — a fault now is a double fault');
        return null;
      }
      case 'LET': {
        if (!live(state)) return notPlaying(state);
        if (!state.rules.lets) return fail('NO_LET', 'This match is played with the no-let rule — a serve that touches the net is in play');
        return null;
      }
      case 'SET_ORDER': {
        if (ns.format !== 'doubles') return fail('DOUBLES_ONLY', 'Only doubles teams choose their order at a new set');
        if (!live(state) || !state.betweenSets) return fail('NOT_SET_BREAK', 'The order of service can change only before the first point of a new set');
        var b = checkOrder(ns, ev.order, teamDue(ns, state));
        if (b) return b;
        return checkReceive(ns, ev.receive || state.receive);
      }
      case 'SERVE_CORRECTION': {
        if (!playing(state)) return state.status === 'pregame' ? fail('NOT_STARTED', 'Set the first server when the match starts') : notPlaying(state);
        if (!str(ev.reason, 200)) return fail('REASON_REQUIRED', 'Give a reason for correcting the server');
        var ord = ns.format === 'doubles' ? ev.order : (ev.order || (ev.server ? singlesOrder(ns, ev.server) : null));
        var bo = checkOrder(ns, ord, null);
        if (bo) return bo;
        if (ns.format === 'doubles' && ev.receive != null) return checkReceive(ns, ev.receive);
        return null;
      }
      case 'ENDS': {
        if (state.status === 'completed' || state.status === 'abandoned') return notPlaying(state);
        if (ev.left != null && !isSide(ev.left)) return fail('INVALID_EVENT', 'Which side is at the left end?');
        return null;
      }
      case 'PAUSE': case 'SUSPEND': {
        if (!live(state)) return notPlaying(state);
        return null;
      }
      case 'RESUME': {
        if (state.status !== 'paused' && state.status !== 'suspended') return fail('NOT_INTERRUPTED', 'The match is not paused or suspended');
        return null;
      }
      case 'RETIRE': {
        if (!playing(state)) return state.status === 'pregame' ? fail('NOT_STARTED', 'Before the first point, a player who cannot play gives a walkover') : notPlaying(state);
        if (!isSide(ev.side)) return fail('INVALID_EVENT', 'Who retired?');
        return null;
      }
      case 'WALKOVER': {
        if (state.status !== 'pregame') return fail('ALREADY_STARTED', 'Once play has begun, a player who stops retires');
        if (!isSide(ev.side)) return fail('INVALID_EVENT', 'Who gives the walkover (did not play)?');
        return null;
      }
      case 'DEFAULT': {
        if (state.status === 'completed' || state.status === 'abandoned') return notPlaying(state);
        if (!isSide(ev.side)) return fail('INVALID_EVENT', 'Who was defaulted?');
        if (!str(ev.reason, 200)) return fail('REASON_REQUIRED', 'Give the reason for the default');
        return null;
      }
      case 'ABANDON': {
        if (state.status === 'completed' || state.status === 'abandoned') return notPlaying(state);
        if (!str(ev.reason, 200)) return fail('REASON_REQUIRED', 'Give the reason the match was abandoned');
        return null;
      }
      case 'MANUAL_STAT': {
        if (!sideOf(ns, ev.playerId)) return fail('INVALID_PLAYER', 'That player is not in this match');
        if (!has(MANUAL_STATS, ev.key)) return fail('INVALID_EVENT', 'Unknown statistic');
        if (ev.value !== null && !(isFinite(Number(ev.value)) && Number(ev.value) >= 0 && Number(ev.value) <= 300)) return fail('INVALID_EVENT', 'A serve speed is 0–300 km/h');
        return null;
      }
      case 'NOTE': return null;
    }
    return null;
  }

  /* =================================================================
     MUTATION — applies a validated event. Returns the effects (what the
     graphics, the commentary and the clips react to).
     ================================================================= */
  function flipEnds(state) { state.left = other(state.left || 'A'); }

  function mutate(ns, state, ev) {
    var effects = [];
    var at = num(ev.at, null);
    switch (ev.type) {
      case 'TOSS':
        state.toss = { winner: ev.winner, choice: ev.choice, firstServe: ev.firstServe, left: isSide(ev.left) ? ev.left : null, at: at };
        if (isSide(ev.left)) state.left = ev.left;
        effects.push({ type: 'TOSS', side: ev.winner, choice: ev.choice, firstServe: ev.firstServe });
        break;
      case 'START': {
        state.status = 'in_play';
        state.startedAt = at;
        state.rotation = { order: ns.format === 'doubles' ? ev.order.slice() : singlesOrder(ns, ev.server), base: 0 };
        state.receive = ns.format === 'doubles' ? clone(ev.receive || defaultReceive(ns)) : null;
        state.left = isSide(ev.left) ? ev.left : (state.left || 'A');
        state.turn = 0;
        newSet(state, 1);
        effects.push({ type: 'MATCH_START', server: ev.server, side: sideOf(ns, ev.server) });
        break;
      }
      case 'POINT': playPoint(ns, state, ev, at, effects); break;
      case 'FAULT':
        state.serve = 2; state.lets = 0;
        effects.push({ type: 'FAULT', server: currentServer(state), foot: !!ev.foot });
        break;
      case 'LET':
        state.lets += 1;
        effects.push({ type: 'LET', server: currentServer(state), serve: state.serve });
        break;
      case 'SET_ORDER':
        state.rotation = { order: ev.order.slice(), base: state.turn };
        state.receive = clone(ev.receive || state.receive);
        effects.push({ type: 'SET_ORDER', set: curSet(state).n });
        break;
      case 'SERVE_CORRECTION': {
        var ord = ns.format === 'doubles' ? ev.order : (ev.order || singlesOrder(ns, ev.server));
        // the corrected order serves from the coming point on (points
        // already played stand — ITF Rule 27)
        state.rotation = { order: ord.slice(), base: state.game ? pointTurn(state) : state.turn };
        if (ns.format === 'doubles' && ev.receive) state.receive = clone(ev.receive);
        effects.push({ type: 'SERVER_CORRECTED', server: currentServer(state) });
        break;
      }
      case 'ENDS':
        if (isSide(ev.left)) state.left = ev.left; else flipEnds(state);
        effects.push({ type: 'CHANGE_ENDS', manual: true, left: state.left });
        break;
      case 'PAUSE': case 'SUSPEND':
        state.status = ev.type === 'PAUSE' ? 'paused' : 'suspended';
        state.interruption = { type: ev.type, kind: has(INTERRUPTIONS, ev.kind) ? ev.kind : 'OTHER', reason: str(ev.reason, 200), side: isSide(ev.side) ? ev.side : null, at: at };
        effects.push({ type: ev.type, kind: state.interruption.kind });
        break;
      case 'RESUME':
        effects.push({ type: 'RESUME', after: state.interruption ? state.interruption.type : null, since: state.interruption ? state.interruption.at : null });
        state.status = 'in_play';
        state.interruption = null;
        break;
      case 'RETIRE': case 'DEFAULT': case 'WALKOVER':
        finish(state, other(ev.side), ev.type === 'RETIRE' ? 'retired' : ev.type === 'DEFAULT' ? 'default' : 'walkover', ev.side, at, str(ev.reason, 200));
        effects.push({ type: 'MATCH_WON', side: other(ev.side), reason: state.result.reason, by: ev.side });
        break;
      case 'ABANDON':
        state.status = 'abandoned';
        state.endedAt = at;
        state.game = null;
        state.interruption = null;
        state.result = resultOf(state, 'abandoned', null, str(ev.reason, 200));
        effects.push({ type: 'ABANDONED' });
        break;
      case 'MANUAL_STAT': {
        var m = state.manual[ev.playerId] = Object.assign({}, state.manual[ev.playerId] || {});
        if (ev.value === null) delete m[ev.key]; else m[ev.key] = Math.round(Number(ev.value) * 10) / 10;
        break;
      }
      case 'NOTE': break;
    }
    if (at) state.lastEventAt = at;
    return effects;
  }

  function playPoint(ns, state, ev, at, effects) {
    var g = state.game, set = curSet(state);
    var w = ev.winner, l = other(w);
    var server = currentServer(state);
    if (!set.firstServer) set.firstServer = gameServer(state);
    if (!set.startedAt && at) set.startedAt = at;
    state.betweenSets = false;
    g.points[w] += 1;
    state.pointNo += 1;
    state.serve = 1; state.lets = 0;
    kindEffects(kindOf(ev), server, w).forEach(function (x) { effects.push(x); });
    effects.push({ type: 'POINT_WON', side: w });
    var p = g.points[w], o = g.points[l];
    var won = g.tiebreak ? tbWon(p, o, g.target, g.margin) : gameWon(p, o, state.rules.noAd);
    if (won) return winGame(ns, state, w, at, effects);
    if (g.tiebreak) {
      // ends change after every six points of a tie-break
      if ((p + o) % 6 === 0) { flipEnds(state); effects.push({ type: 'CHANGE_ENDS', tiebreak: true, left: state.left }); }
    } else if (p >= 3 && o >= 3) {
      effects.push(p === o ? { type: state.rules.noAd ? 'DECIDING_POINT' : 'DEUCE' } : { type: 'ADVANTAGE', side: p > o ? w : l });
    }
  }

  // what the kind of a point itself announces (the graphics react to these)
  function kindEffects(kind, server, winner) {
    if (kind === 'ACE') return [{ type: 'ACE', player: server, side: winner }];
    if (kind === 'DOUBLE_FAULT') return [{ type: 'DOUBLE_FAULT', player: server, side: other(winner) }];
    return [];
  }

  function winGame(ns, state, w, at, effects) {
    var g = state.game, set = curSet(state);
    var srvSide = sideOf(ns, gameServer(state));
    var brk = !g.tiebreak && srvSide !== w;
    state.gameNo += 1;
    if (g.mtb) {
      state.turn = g.turn + 1;
      set.games[w] += 1;
      set.tb = { A: g.points.A, B: g.points.B };
      effects.push({ type: 'TIEBREAK_WON', side: w, points: clone(set.tb), mtb: true, set: set.n });
      return winSet(ns, state, w, at, effects);
    }
    set.games[w] += 1;
    if (g.tiebreak) set.tb = { A: g.points.A, B: g.points.B };
    effects.push({ type: 'GAME_WON', side: w, server: srvSide, break: brk, tiebreak: !!g.tiebreak, set: set.n, games: { A: set.games.A, B: set.games.B } });
    if (brk) effects.push({ type: 'BREAK', side: w, set: set.n, games: { A: set.games.A, B: set.games.B } });
    if (g.tiebreak) effects.push({ type: 'TIEBREAK_WON', side: w, points: clone(set.tb), set: set.n });
    state.turn = g.turn + 1;
    // ends change after every odd game of a set — a set's last game included
    // (a tie-break counts as one game), so an even set changes after the
    // first game of the next one instead (ITF Rule 10)
    var odd = (set.games.A + set.games.B) % 2 === 1;
    if (g.tiebreak || setWonByGames(set.games, w, set.rule)) {
      var over = state.setsWon[w] + 1 >= setsToWin(state.rules);
      if (odd && !over) { flipEnds(state); effects.push({ type: 'CHANGE_ENDS', left: state.left, setBreak: true }); }
      return winSet(ns, state, w, at, effects);
    }
    newGame(state);
    if (state.game.tiebreak) effects.push({ type: 'TIEBREAK_START', set: set.n, at: set.rule.tiebreakAt });
    if (odd) { flipEnds(state); effects.push({ type: 'CHANGE_ENDS', left: state.left }); }
  }

  function winSet(ns, state, w, at, effects) {
    var set = curSet(state);
    set.winner = w;
    set.endedAt = at;
    state.setsWon[w] += 1;
    effects.push({ type: 'SET_WON', side: w, set: set.n, games: { A: set.games.A, B: set.games.B }, tb: set.tb ? clone(set.tb) : null, mtb: set.rule.type === 'mtb' });
    if (state.setsWon[w] >= setsToWin(state.rules)) {
      finish(state, w, 'played', null, at, '');
      effects.push({ type: 'MATCH_WON', side: w, sets: { A: state.setsWon.A, B: state.setsWon.B }, reason: 'played' });
      return;
    }
    newSet(state, set.n + 1);
    state.betweenSets = true;
    effects.push({ type: 'SET_BREAK', next: set.n + 1, matchTiebreak: curSet(state).rule.type === 'mtb' });
  }

  function finish(state, winner, reason, by, at, note) {
    state.status = 'completed';
    state.winner = winner;
    state.endedAt = at;
    state.interruption = null;
    state.result = resultOf(state, reason, by, note);
    state.game = null;
    state.betweenSets = false;
  }

  function resultOf(state, reason, by, note) {
    var scores = state.sets.filter(function (s) { return s.winner || s.games.A + s.games.B > 0 || (s.tb && s.tb.A + s.tb.B > 0); }).map(function (s) {
      return { set: s.n, A: s.games.A, B: s.games.B, tb: s.tb ? { A: s.tb.A, B: s.tb.B } : null, mtb: s.rule.type === 'mtb', winner: s.winner || null, complete: !!s.winner };
    });
    // a retirement mid-game: the game being played is part of the record
    var g = state.game;
    var openGame = reason !== 'played' && g && (g.points.A + g.points.B > 0) ? { A: g.points.A, B: g.points.B, tiebreak: !!g.tiebreak } : null;
    return { winner: state.winner || null, reason: reason, by: by || null, note: note || '', sets: { A: state.setsWon.A, B: state.setsWon.B }, scores: scores, openGame: openGame };
  }

  // validate + mutate (the replay's single entry point)
  function apply(ns, state, ev) {
    var bad = validate(ns, state, ev);
    if (bad) return bad;
    return { ok: true, effects: mutate(ns, state, ev) };
  }

  /* =================================================================
     REVERSIBLE APPLICATION — what an event is about to change, kept so
     Undo can put it back. Never the match: these fields, and the line of
     the set being played (the sets before it cannot change).
     ================================================================= */
  var HOT = ['status', 'interruption', 'toss', 'setsWon', 'game', 'turn', 'rotation', 'receive', 'left', 'serve', 'lets',
    'pointNo', 'gameNo', 'betweenSets', 'winner', 'result', 'startedAt', 'endedAt', 'lastEventAt'];
  function capture(state, ev) {
    var rec = { setsLen: state.sets.length, last: state.sets.length ? clone(state.sets[state.sets.length - 1]) : null };
    for (var i = 0; i < HOT.length; i++) {
      var k = HOT[i], v = state[k];
      rec[k] = v && typeof v === 'object' ? clone(v) : v;
    }
    if (ev && ev.type === 'MANUAL_STAT') rec.manual = clone(state.manual);
    return rec;
  }
  function restore(state, rec) {
    state.sets.length = rec.setsLen;
    if (rec.setsLen) state.sets[rec.setsLen - 1] = rec.last;
    for (var i = 0; i < HOT.length; i++) state[HOT[i]] = rec[HOT[i]];
    if (rec.manual) state.manual = rec.manual;
  }

  /* =================================================================
     WHAT THE NEXT POINT DECIDES — for each side: game, set, match; a break
     point is a game point for the receivers (never in a tie-break). count =
     how many in a row (0-40: three break points).
     ================================================================= */
  function chances(p, q, g, rules) {
    if (!g.tiebreak && rules.noAd) return p > q ? p - q : 1;
    var M = g.tiebreak ? g.margin : 2;
    return Math.max(1, p - q - M + 2);
  }
  function pressureOf(ns, state) {
    if (!playing(state) || !state.game) return null;
    var g = state.game, set = curSet(state), rules = state.rules;
    var srvSide = sideOf(ns, currentServer(state));
    var out = { A: null, B: null, deciding: false };
    SIDES.forEach(function (s) {
      var o = other(s), p = g.points[s], q = g.points[o];
      var winsGame = g.tiebreak ? tbWon(p + 1, q, g.target, g.margin) : gameWon(p + 1, q, rules.noAd);
      if (!winsGame) return;
      var winsSet = g.tiebreak || setWonByGames({ A: set.games.A + (s === 'A' ? 1 : 0), B: set.games.B + (s === 'B' ? 1 : 0) }, s, set.rule);
      out[s] = { game: true, set: winsSet, match: winsSet && state.setsWon[s] + 1 >= setsToWin(rules), break: !g.tiebreak && s !== srvSide, count: chances(p, q, g, rules) };
    });
    // the deciding point (No-Ad at deuce) / sudden death in a tie-break: both at once
    out.deciding = !!(out.A && out.B);
    return out;
  }
  var RANK = { match: 4, set: 3, break: 2, game: 1 };
  function pressureKind(x) { return !x ? null : x.match ? 'match' : x.set ? 'set' : x.break ? 'break' : 'game'; }
  // The one line a scoreboard shows: MATCH POINT > SET POINT > BREAK POINT > GAME POINT
  function headline(pr) {
    if (!pr) return null;
    var a = pressureKind(pr.A), b = pressureKind(pr.B);
    if (!a && !b) return null;
    var ra = a ? RANK[a] : 0, rb = b ? RANK[b] : 0;
    var side = ra === rb ? 'both' : ra > rb ? 'A' : 'B';
    var kind = ra >= rb ? a : b;
    var count = side === 'both' ? 1 : pr[side].count;
    return { kind: kind, side: side, count: count, deciding: !!pr.deciding, alsoBreak: side !== 'both' && kind !== 'break' && !!pr[side].break };
  }

  /* =================================================================
     SNAPSHOTS + DISPLAY
     ================================================================= */
  var CALL = ['0', '15', '30', '40'];
  // the points as a scoreboard shows them (each side's own cell)
  function gameDisplay(points, tiebreak) {
    var a = points.A, b = points.B;
    if (tiebreak) return { A: String(a), B: String(b) };
    if (a >= 3 && b >= 3) {
      if (a === b) return { A: '40', B: '40', deuce: true };
      return a > b ? { A: 'AD', B: '40', adv: 'A' } : { A: '40', B: 'AD', adv: 'B' };
    }
    return { A: CALL[Math.min(a, 3)], B: CALL[Math.min(b, 3)] };
  }
  var WORD = { '0': 'Love', '15': '15', '30': '30', '40': '40' };
  // The umpire's call, the server's score first: "30-15", "15-All", "Deuce",
  // "Advantage Federer", "Deciding point"; a tie-break "3-2 Federer" / "4-All".
  function callOf(ns, snap) {
    if (!snap || !snap.points) return '';
    var sv = snap.serverSide || 'A', rv = other(sv), p = snap.points;
    if (snap.tiebreak) {
      if (p.A === p.B) return p.A + '-All';
      var lead = p.A > p.B ? 'A' : 'B';
      return Math.max(p.A, p.B) + '-' + Math.min(p.A, p.B) + ' ' + sideName(ns, lead);
    }
    if (p.A >= 3 && p.B >= 3) {
      if (p.A === p.B) return ns.rules.noAd ? 'Deciding point' : 'Deuce';
      return 'Advantage ' + sideName(ns, p.A > p.B ? 'A' : 'B');
    }
    var d = gameDisplay(p, false);
    if (d[sv] === d[rv]) return (d[sv] === '0' ? 'Love' : d[sv]) + '-All';
    return WORD[d[sv]] + '-' + WORD[d[rv]];
  }
  function snapshot(ns, state) {
    var set = curSet(state), g = state.game;
    var srv = currentServer(state);
    return {
      status: state.status,
      set: set ? set.n : 0,
      games: set ? { A: set.games.A, B: set.games.B } : { A: 0, B: 0 },
      points: g ? { A: g.points.A, B: g.points.B } : { A: 0, B: 0 },
      tiebreak: !!(g && g.tiebreak), mtb: !!(g && g.mtb),
      setsWon: { A: state.setsWon.A, B: state.setsWon.B },
      server: srv, serverSide: sideOf(ns, srv),
      receiver: g ? currentReceiver(ns, state) : null,
      court: courtOf(state), serve: state.serve,
      game: g ? g.n : 0, left: state.left, pointNo: state.pointNo
    };
  }

  /* =================================================================
     THE LEDGER
     Meta events change which base events count and what they say:
       UNDO { target }    — the latest event that counts no longer does
       REDO { target }    — the UNDO `target` is taken back
       VOID { target, reason }           — an earlier event no longer counts
       CORRECT { target, patch, reason } — a point reads differently: who
                                won it (the score moves on from there), or only
                                how it was won (detail: kind, player, stroke …)
     They never remove anything: the original stays, marked.
     ================================================================= */
  function bySeq(a, b) { return (num(a.seq, 0) - num(b.seq, 0)) || (num(a.at, 0) - num(b.at, 0)); }
  // a CORRECT that changes only how a point was won (never the score) — it
  // is not something Undo takes back: classifying a point again changes it
  function isDetail(ev) {
    if (!ev || ev.type !== 'CORRECT') return false;
    var p = ev.patch && typeof ev.patch === 'object' ? ev.patch : {};
    var keys = Object.keys(p);
    return keys.length > 0 && keys.every(function (k) { return has(DETAIL_FIELDS, k); });
  }
  function resolveMeta(events) {
    var byId = {}, voidedBy = {}, patches = {};
    events.forEach(function (ev) { if (ev && ev.eventId) byId[ev.eventId] = ev; });
    events.forEach(function (ev) {
      if (!ev || !META[ev.type]) return;
      var target = byId[ev.target];
      if (!target) return;
      if (ev.type === 'UNDO' || ev.type === 'VOID') {
        var voidable = !META[target.type] || target.type === 'CORRECT';
        if (voidable && !voidedBy[ev.target]) voidedBy[ev.target] = ev.eventId;
      } else if (ev.type === 'REDO') {
        if (target.type === 'UNDO' && !voidedBy[target.eventId] && voidedBy[target.target] === target.eventId) {
          delete voidedBy[target.target];
          voidedBy[target.eventId] = ev.eventId;
        }
      }
    });
    events.forEach(function (ev) {
      if (!ev || ev.type !== 'CORRECT' || voidedBy[ev.eventId]) return;
      var target = byId[ev.target];
      if (!target || META[target.type]) return;
      (patches[ev.target] = patches[ev.target] || []).push(ev);
    });
    return { byId: byId, voidedBy: voidedBy, patches: patches };
  }
  function effectiveEvent(ev, patchEvents) {
    if (!patchEvents || !patchEvents.length) return ev;
    var out = clone(ev);
    patchEvents.forEach(function (c) {
      var p = c.patch || {};
      Object.keys(p).forEach(function (k) { if (has(PATCHABLE, k)) { if (p[k] === null) delete out[k]; else out[k] = clone(p[k]); } });
    });
    out.corrected = patchEvents.map(function (c) { return c.eventId; });
    return out;
  }

  // What a timeline entry says about its event (from the event as it now
  // reads, and the snapshot before it) — the same function for a fresh
  // event, a replay and a detail correction, so they always agree.
  function describe(ns, entry, ev) {
    var b = entry.before || {};
    delete entry.winner; delete entry.kind; delete entry.player; delete entry.stroke; delete entry.net; delete entry.rally;
    delete entry.loc; delete entry.speed; delete entry.serveDir; delete entry.note; delete entry.serve; delete entry.receiver; delete entry.foot;
    switch (ev.type) {
      case 'POINT': {
        var kind = kindOf(ev), k = KINDS[kind];
        entry.side = ev.winner;
        entry.kind = kind;
        entry.server = b.server || null;
        entry.serverSide = b.serverSide || null;
        entry.receiver = ev.receiver || b.receiver || null;
        entry.court = b.court || null;
        entry.serve = kind === 'DOUBLE_FAULT' ? 2 : (ev.serve === 1 || ev.serve === 2 ? ev.serve : (b.serve === 2 ? 2 : null));
        // who a statistic belongs to: the named player, else the only player who can be meant
        var pl = ev.player || null;
        if (!pl && k.by === 'server') pl = b.server || null;
        if (!pl && ns.format !== 'doubles') pl = ns.sides[k.by === 'loser' ? other(ev.winner) : ev.winner].ids[0] || null;
        entry.player = pl;
        entry.playerNamed = !!ev.player || k.by === 'server' || ns.format !== 'doubles';
        if (ev.stroke && has(STROKES, ev.stroke)) entry.stroke = ev.stroke;
        if (isSide(ev.net)) entry.net = ev.net;
        if (ev.rally != null && isFinite(Number(ev.rally))) entry.rally = int(ev.rally, 0, 0, 999);
        if (ev.loc && typeof ev.loc === 'object' && isFinite(Number(ev.loc.x)) && isFinite(Number(ev.loc.y))) entry.loc = { x: Math.round(Number(ev.loc.x) * 100) / 100, y: Math.round(Number(ev.loc.y) * 100) / 100 };
        if (ev.speed != null && isFinite(Number(ev.speed)) && Number(ev.speed) > 0) entry.speed = Math.round(Number(ev.speed));
        if (ev.serveDir && has(SERVE_DIRS, ev.serveDir)) entry.serveDir = ev.serveDir;
        if (ev.note) entry.note = str(ev.note, 200);
        // a double fault whose second fault was a foot fault
        if (kind === 'DOUBLE_FAULT' && ev.foot) entry.foot = true;
        break;
      }
      case 'FAULT': entry.server = b.server || null; entry.serverSide = b.serverSide || null; entry.foot = !!ev.foot; if (ev.serveDir && has(SERVE_DIRS, ev.serveDir)) entry.serveDir = ev.serveDir; if (ev.speed) entry.speed = Math.round(num(ev.speed, 0)); break;
      case 'LET': entry.server = b.server || null; entry.serverSide = b.serverSide || null; entry.serve = b.serve || 1; break;
      case 'TOSS': entry.toss = { winner: ev.winner, choice: ev.choice, firstServe: ev.firstServe, left: isSide(ev.left) ? ev.left : null }; break;
      case 'START': entry.server = ev.server; entry.serverSide = sideOf(ns, ev.server); if (ev.order) entry.order = ev.order.slice(); if (isSide(ev.left)) entry.leftSide = ev.left; break;
      case 'SET_ORDER': case 'SERVE_CORRECTION': entry.order = (ev.order || (ev.server ? singlesOrder(ns, ev.server) : [])).slice(); if (ev.reason) entry.reason = str(ev.reason, 200); break;
      case 'ENDS': entry.leftSide = isSide(ev.left) ? ev.left : null; if (ev.reason) entry.reason = str(ev.reason, 200); break;
      case 'PAUSE': case 'SUSPEND': entry.kind = has(INTERRUPTIONS, ev.kind) ? ev.kind : 'OTHER'; entry.reason = str(ev.reason, 200); if (isSide(ev.side)) entry.side = ev.side; break;
      case 'RETIRE': case 'WALKOVER': case 'DEFAULT': entry.side = ev.side; entry.reason = str(ev.reason, 200); break;
      case 'ABANDON': entry.reason = str(ev.reason, 200); break;
      case 'MANUAL_STAT': entry.playerId = ev.playerId; entry.key = ev.key; entry.value = ev.value === null ? null : Math.round(Number(ev.value) * 10) / 10; break;
      case 'NOTE': entry.note = str(ev.text || ev.note, 500); break;
    }
    if (ev.corrected) entry.corrected = ev.corrected.slice(); else delete entry.corrected;
  }

  function baseEntry(ev) { return { eventId: ev.eventId, seq: ev.seq, type: ev.type, at: ev.at || null, by: ev.by || null }; }
  function metaEntry(ev, voided) {
    var e = baseEntry(ev);
    e.target = ev.target || null;
    e.reason = ev.reason || null;
    if (ev.type === 'CORRECT') e.patch = ev.patch || null;
    e.voided = !!voided;
    return e;
  }
  // a base event applied to `state` → its timeline entry (+ the undo record)
  function applyEntry(ns, state, ev, entry) {
    entry.before = snapshot(ns, state);
    if (ev.type === 'POINT') entry.pressure = pressureOf(ns, state);
    describe(ns, entry, ev);
    var bad = validate(ns, state, ev);
    if (bad) { entry.invalid = { code: bad.code, error: bad.error }; entry.after = entry.before; return null; }
    var rec = capture(state, ev);
    entry.effects = mutate(ns, state, ev);
    entry.after = snapshot(ns, state);
    if (ev.type === 'POINT') { entry.pointNo = state.pointNo; entry.setNo = entry.before.set; entry.gameNo = entry.before.game; entry.tiebreak = entry.before.tiebreak; }
    return rec;
  }

  // Replays the ledger: the state, a timeline entry per event (with the
  // score before and after it), the undo stack, and every event that no
  // longer applies.
  function replay(setup, events) {
    var ns = nsOf(setup);
    var list = (events || []).filter(Boolean).slice().sort(bySeq);
    var meta = resolveMeta(list);
    var state = createState(ns);
    var timeline = [], invalid = [], stack = [];
    list.forEach(function (ev) {
      if (META[ev.type]) { timeline.push(metaEntry(ev, !!meta.voidedBy[ev.eventId])); return; }
      var entry = baseEntry(ev);
      if (meta.voidedBy[ev.eventId]) {
        entry.before = snapshot(ns, state);
        entry.voided = true;
        entry.voidedBy = meta.voidedBy[ev.eventId];
        describe(ns, entry, effectiveEvent(ev, meta.patches[ev.eventId]));
        entry.after = null;
        timeline.push(entry);
        return;
      }
      var rec = applyEntry(ns, state, effectiveEvent(ev, meta.patches[ev.eventId]), entry);
      if (entry.invalid) invalid.push(entry);
      else stack.push({ eventId: ev.eventId, rec: rec, idx: timeline.length });
      timeline.push(entry);
    });
    return { state: state, timeline: timeline, invalid: invalid, stack: stack, setup: ns, meta: meta };
  }

  // The newest event Undo takes back: the latest event that still counts —
  // a point, a fault, a let, a status change, a note, a correction of who
  // won a point. A classification (detail) is changed by classifying again.
  function lastUndoable(events) {
    var list = (events || []).filter(Boolean).slice().sort(bySeq);
    var meta = resolveMeta(list);
    for (var i = list.length - 1; i >= 0; i--) {
      var ev = list[i];
      if (meta.voidedBy[ev.eventId]) continue;
      if (ev.type === 'UNDO' || ev.type === 'REDO' || ev.type === 'VOID' || isDetail(ev)) continue;
      return ev;
    }
    return null;
  }
  // The UNDO that Redo would take back: only while nothing has been
  // recorded since it.
  function lastRedoable(events) {
    var list = (events || []).filter(Boolean).slice().sort(bySeq);
    var meta = resolveMeta(list);
    for (var i = list.length - 1; i >= 0; i--) {
      var ev = list[i];
      if (ev.type === 'UNDO' && !meta.voidedBy[ev.eventId]) return ev;
      if (ev.type === 'REDO' || ev.type === 'VOID' || isDetail(ev) || ev.type === 'UNDO') continue;
      return null;
    }
    return null;
  }

  /* ---------- Ledger: the live, incremental form of replay() ---------- */
  function Ledger(setup, events) {
    this.setup = nsOf(setup);
    this.rebuild(events || []);
  }
  Ledger.prototype.rebuild = function (events) {
    this.events = (events || []).filter(Boolean).slice().sort(bySeq);
    var r = replay(this.setup, this.events);
    this.adopt(r);
    this.seq = this.events.length ? num(this.events[this.events.length - 1].seq, this.events.length) : 0;
    this.ids = {};
    for (var i = 0; i < this.events.length; i++) this.ids[this.events[i].eventId] = this.events[i];
    return this;
  };
  Ledger.prototype.adopt = function (r) {
    this.state = r.state; this.timeline = r.timeline; this.invalid = r.invalid; this.stack = r.stack; this.meta = r.meta;
    this.index = {};
    for (var i = 0; i < this.timeline.length; i++) this.index[this.timeline[i].eventId] = i;
  };
  Ledger.prototype.has = function (eventId) { return !!this.ids[eventId]; };
  // lastUndoable / lastRedoable for this ledger, from its own marks: a scan
  // back from the newest event that stops at the first that counts
  Ledger.prototype.lastUndoable = function () {
    var v = this.meta.voidedBy;
    for (var i = this.events.length - 1; i >= 0; i--) {
      var ev = this.events[i];
      if (v[ev.eventId]) continue;
      if (ev.type === 'UNDO' || ev.type === 'REDO' || ev.type === 'VOID' || isDetail(ev)) continue;
      return ev;
    }
    return null;
  };
  Ledger.prototype.lastRedoable = function () {
    var v = this.meta.voidedBy;
    for (var i = this.events.length - 1; i >= 0; i--) {
      var ev = this.events[i];
      if (ev.type === 'UNDO' && !v[ev.eventId]) return ev;
      if (ev.type === 'REDO' || ev.type === 'VOID' || ev.type === 'UNDO' || isDetail(ev)) continue;
      return null;
    }
    return null;
  };
  Ledger.prototype.entry = function (eventId) { var i = this.index[eventId]; return i == null ? null : this.timeline[i]; };

  // { ok, code, error, pending } — never changes the ledger.
  Ledger.prototype.check = function (ev) {
    if (!ev || typeof ev !== 'object') return fail('INVALID_EVENT', 'No event');
    if (EVENT_TYPES.indexOf(ev.type) < 0) return fail('UNKNOWN_EVENT', 'Unknown event type ' + ev.type);
    if (!ev.eventId) return fail('INVALID_EVENT', 'An event needs its eventId');
    // The same press sent twice (a retry, a reconnect) is the same event:
    // the caller answers it with what was already stored, never again.
    if (this.ids[ev.eventId]) return { ok: false, code: 'DUPLICATE', duplicate: true, error: 'Already recorded', existing: this.ids[ev.eventId] };
    var stamped = Object.assign({}, ev, { seq: this.seq + 1 });
    delete stamped.corrected;
    if (META[ev.type]) return this.checkMeta(stamped);
    var bad = validate(this.setup, this.state, stamped);
    if (bad) return bad;
    return { ok: true, pending: { event: stamped, mode: 'base' } };
  };

  Ledger.prototype.checkMeta = function (ev) {
    var top = this.stack.length ? this.stack[this.stack.length - 1] : null;
    if (ev.type === 'UNDO') {
      var last = this.lastUndoable();
      if (!last) return fail('NOTHING_TO_UNDO', 'Nothing to undo');
      if (ev.target && ev.target !== last.eventId) return fail('UNDO_NOT_LAST', 'Only the latest event can be undone — correct earlier events instead');
      ev.target = last.eventId;
      // the latest applied event: put back what it changed, nothing else
      if (top && top.eventId === last.eventId) return { ok: true, pending: { event: ev, mode: 'undo' } };
      return this.checkFull(ev);
    }
    if (ev.type === 'REDO') {
      var u = this.lastRedoable();
      if (!u) return fail('NOTHING_TO_REDO', 'Nothing to redo');
      if (ev.target && ev.target !== u.eventId) return fail('REDO_NOT_LAST', 'Only the latest undo can be redone');
      ev.target = u.eventId;
      var x = this.ids[u.target];
      if (x && !META[x.type]) {
        var eff = effectiveEvent(x, this.meta.patches[x.eventId]);
        if (!validate(this.setup, this.state, eff)) return { ok: true, pending: { event: ev, mode: 'redo', redo: x } };
      }
      return this.checkFull(ev);
    }
    var target = this.ids[ev.target];
    if (!target) return fail('TARGET_MISSING', 'That event is not part of this match');
    if (!ev.reason) return fail('REASON_REQUIRED', 'Give a reason for the correction');
    if (this.meta.voidedBy[target.eventId]) return fail('TARGET_VOIDED', 'That event no longer counts');
    if (ev.type === 'VOID') {
      if (META[target.type] && target.type !== 'CORRECT') return fail('TARGET_INVALID', 'Use Redo to take back an undo');
      return this.checkFull(ev);
    }
    // CORRECT
    if (META[target.type]) return fail('TARGET_INVALID', 'Only an original event can be corrected');
    if (target.type !== 'POINT') return fail('TARGET_INVALID', 'Only a point can be corrected — undo or void other events');
    var p = ev.patch && typeof ev.patch === 'object' ? clone(ev.patch) : null;
    if (p) Object.keys(p).forEach(function (k) { if (!has(PATCHABLE, k)) delete p[k]; });
    if (!p || !Object.keys(p).length) return fail('PATCH_INVALID', 'Nothing to correct');
    if (has(p, 'winner') && !isSide(p.winner)) return fail('PATCH_INVALID', 'Choose who won the point');
    if (p.kind != null && !has(KINDS, p.kind)) return fail('PATCH_INVALID', 'Unknown kind of point');
    var entry = this.entry(target.eventId);
    // the corrected point must itself be valid where it stands
    var probe = clone(effectiveEvent(target, this.meta.patches[target.eventId]));
    delete probe.corrected;
    // naming the winner it already has changes nothing about the score
    if (has(p, 'winner') && p.winner === probe.winner && Object.keys(p).length > 1) delete p.winner;
    ev.patch = p;
    Object.keys(p).forEach(function (k) { if (p[k] === null) delete probe[k]; else probe[k] = clone(p[k]); });
    if (isDetail(ev) && entry && !entry.invalid && !entry.voided) {
      var bad = validatePointAt(this.setup, entry.before, probe);
      if (bad) return bad;
      return { ok: true, pending: { event: ev, mode: 'detail' } };
    }
    return this.checkFull(ev, function (r) {
      var e = r.timeline.filter(function (x) { return x.eventId === target.eventId; })[0];
      return e && e.invalid ? fail(e.invalid.code, e.invalid.error) : null;
    });
  };
  // A point's kind / player against the snapshot it was played at.
  function validatePointAt(ns, before, ev) {
    var kind = kindOf(ev), k = KINDS[kind];
    var srv = before.server, srvSide = before.serverSide;
    if (k.wins === 'server' && ev.winner !== srvSide) return fail('KIND_MISMATCH', k.label + ': the point goes to the server — ' + sideName(ns, srvSide));
    if (k.wins === 'receiver' && ev.winner === srvSide) return fail('KIND_MISMATCH', k.label + ': the point goes to the receiver — ' + sideName(ns, other(srvSide)));
    if (ev.player != null) {
      var ps = sideOf(ns, ev.player);
      if (!ps) return fail('INVALID_PLAYER', 'That player is not in this match');
      var want = k.by === 'server' ? srvSide : k.by === 'loser' ? other(ev.winner) : ev.winner;
      if (ps !== want) return fail('INVALID_PLAYER', nameOf(ns, ev.player) + ' is on the wrong side for a ' + k.label.toLowerCase());
      if (k.by === 'server' && ev.player !== srv) return fail('INVALID_PLAYER', nameOf(ns, srv) + ' was serving, not ' + nameOf(ns, ev.player));
    }
    if (ev.receiver != null && sideOf(ns, ev.receiver) !== other(srvSide)) return fail('INVALID_PLAYER', 'The receiver is a player of the receiving side');
    if (ev.net != null && !isSide(ev.net)) return fail('INVALID_EVENT', 'Which side came to the net?');
    if (kind === 'DOUBLE_FAULT' && ev.serve === 1) return fail('SERVE_MISMATCH', 'A double fault is the second serve');
    return null;
  }
  // A correction checked by replaying the whole ledger with it: refused if
  // any later event would no longer be possible.
  Ledger.prototype.checkFull = function (ev, extra) {
    var all = this.events.concat([ev]);
    var r = replay(this.setup, all);
    var before = {};
    this.invalid.forEach(function (x) { before[x.eventId] = 1; });
    var broken = r.invalid.filter(function (x) { return !before[x.eventId]; });
    if (broken.length) {
      var b = broken[0];
      return fail('CORRECTION_CONFLICT', 'This change would make a later event impossible: ' + b.type.toLowerCase().replace(/_/g, ' ') + ' #' + b.seq + ' — ' + b.invalid.error + '. Undo back to that point instead.');
    }
    if (extra) { var x = extra(r); if (x) return x; }
    return { ok: true, pending: { event: ev, mode: 'full', full: r } };
  };

  // Applies a checked event (after the server has stored it).
  Ledger.prototype.commit = function (pending) {
    var ev = pending.event;
    this.events.push(ev);
    this.ids[ev.eventId] = ev;
    this.seq = num(ev.seq, this.seq + 1);
    var mode = pending.mode;
    if (mode === 'full') { this.adopt(pending.full); return this; }
    if (mode === 'base') {
      var entry = baseEntry(ev);
      var rec = applyEntry(this.setup, this.state, ev, entry);
      this.stack.push({ eventId: ev.eventId, rec: rec, idx: this.timeline.length });
      this.index[ev.eventId] = this.timeline.length;
      this.timeline.push(entry);
      return this;
    }
    if (mode === 'undo') {
      var top = this.stack.pop();
      restore(this.state, top.rec);
      var e = this.timeline[top.idx];
      e.voided = true; e.voidedBy = ev.eventId; e.after = null;
      delete e.effects; delete e.pressure; delete e.pointNo; delete e.setNo; delete e.gameNo; delete e.tiebreak; delete e.invalid;
      this.meta.voidedBy[top.eventId] = ev.eventId;
      this.pushMeta(ev);
      return this;
    }
    if (mode === 'redo') {
      var undo = this.ids[ev.target], x = pending.redo;
      delete this.meta.voidedBy[x.eventId];
      this.meta.voidedBy[undo.eventId] = ev.eventId;
      var ue = this.entry(undo.eventId);
      if (ue) ue.voided = true;
      var xi = this.index[x.eventId];
      var fresh = baseEntry(x);
      var rec2 = applyEntry(this.setup, this.state, effectiveEvent(x, this.meta.patches[x.eventId]), fresh);
      this.timeline[xi] = fresh;
      this.stack.push({ eventId: x.eventId, rec: rec2, idx: xi });
      this.pushMeta(ev);
      return this;
    }
    if (mode === 'detail') {
      var tgt = this.ids[ev.target];
      (this.meta.patches[tgt.eventId] = this.meta.patches[tgt.eventId] || []).push(ev);
      var te = this.entry(tgt.eventId);
      describe(this.setup, te, effectiveEvent(tgt, this.meta.patches[tgt.eventId]));
      // the point's own announcement follows its new kind; the score's do not change
      if (te.effects) te.effects = kindEffects(te.kind, te.server, te.side).concat(te.effects.filter(function (x) { return x.type !== 'ACE' && x.type !== 'DOUBLE_FAULT'; }));
      this.pushMeta(ev);
      return this;
    }
    return this;
  };
  Ledger.prototype.pushMeta = function (ev) {
    this.index[ev.eventId] = this.timeline.length;
    this.timeline.push(metaEntry(ev, false));
  };
  // A fresh full replay — for tests and for a rebuild after a restart.
  Ledger.prototype.verify = function () { return replay(this.setup, this.events); };

  /* =================================================================
     WHAT THE PANEL, THE OVERLAY AND THE WEBSITE SHOW
     ================================================================= */
  function person(ns, id) { var p = playerOf(ns, id); return p ? { playerId: p.playerId, name: p.name, short: p.short, country: p.country, side: sideOf(ns, id) } : null; }
  function summary(setupOrNs, state) {
    var ns = nsOf(setupOrNs);
    var set = curSet(state), g = state.game, rules = state.rules;
    var srv = currentServer(state), rcv = g ? currentReceiver(ns, state) : null;
    var pr = pressureOf(ns, state);
    var disp = g ? gameDisplay(g.points, g.tiebreak) : { A: '0', B: '0' };
    var snap = snapshot(ns, state);
    var totals = { A: 0, B: 0 };
    state.sets.forEach(function (s) { totals.A += s.games.A; totals.B += s.games.B; });
    // Change of ends right now: 0-0 at the start of a game, after an odd
    // number of games in the set (or after a set that ended odd); in a
    // tie-break after every six points.
    var changeover = false;
    if (g && playing(state)) {
      var k = g.points.A + g.points.B;
      if (g.tiebreak) changeover = k > 0 && k % 6 === 0;
      else if (k === 0) {
        var gamesIn = set.games.A + set.games.B;
        if (gamesIn > 0) changeover = gamesIn % 2 === 1;
        else if (state.sets.length > 1) { var prev = state.sets[state.sets.length - 2]; changeover = (prev.games.A + prev.games.B) % 2 === 1; }
      }
    }
    return {
      status: state.status,
      format: ns.format,
      set: set ? set.n : 0,
      game: g ? g.n : 0,
      setsWon: { A: state.setsWon.A, B: state.setsWon.B },
      setsToWin: setsToWin(rules), bestOf: rules.bestOf,
      sets: state.sets.map(function (s) {
        return { set: s.n, A: s.games.A, B: s.games.B, tb: s.tb ? { A: s.tb.A, B: s.tb.B } : null, mtb: s.rule.type === 'mtb', winner: s.winner || null, status: s.winner ? 'completed' : 'in_progress', startedAt: s.startedAt || null, endedAt: s.endedAt || null };
      }),
      points: g ? { A: g.points.A, B: g.points.B } : { A: 0, B: 0 },
      display: { A: disp.A, B: disp.B },
      deuce: !!disp.deuce, advantage: disp.adv || null,
      tiebreak: !!(g && g.tiebreak), matchTiebreak: !!(g && g.mtb), tiebreakTarget: g && g.tiebreak ? g.target : null,
      call: g && playing(state) ? callOf(ns, snap) : '',
      serving: srv ? sideOf(ns, srv) : null,
      server: srv ? person(ns, srv) : null,
      receiver: rcv ? person(ns, rcv) : null,
      serve: state.serve, lets: state.lets,
      court: courtOf(state),
      left: state.left,
      changeover: changeover,
      betweenSets: !!state.betweenSets,
      pressure: pr,
      headline: headline(pr),
      rotation: state.rotation ? { order: state.rotation.order.map(function (id) { return person(ns, id); }), next: g ? serverAt(state, g.turn + 1) : null } : null,
      receive: state.receive ? clone(state.receive) : null,
      teamDue: state.betweenSets && ns.format === 'doubles' ? teamDue(ns, state) : null,
      interruption: state.interruption ? clone(state.interruption) : null,
      toss: state.toss ? clone(state.toss) : null,
      winner: state.winner,
      result: state.result ? clone(state.result) : null,
      totals: { games: totals },
      pointNo: state.pointNo,
      startedAt: state.startedAt, endedAt: state.endedAt,
      manual: clone(state.manual),
      rules: { label: rules.label, noAd: rules.noAd, lets: rules.lets, bestOf: rules.bestOf, official: rules.official }
    };
  }

  // "6-4 3-6 7-6(5)" from one side's view (default: the winner's)
  function scoreLine(result, from) {
    if (!result || !result.scores) return '';
    var me = isSide(from) ? from : (result.winner || 'A'), op = other(me);
    var parts = result.scores.map(function (s) {
      if (s.mtb && s.tb) return '[' + s.tb[me] + '-' + s.tb[op] + ']';
      var line = s.A + s.B === 0 && !s.tb ? '' : s[me] + '-' + s[op];
      if (s.tb) line += '(' + Math.min(s.tb.A, s.tb.B) + ')';
      return line;
    }).filter(Boolean);
    if (result.reason === 'retired') parts.push('ret.');
    if (result.reason === 'walkover') return 'w/o';
    if (result.reason === 'default') parts.push('def.');
    return parts.join(' ');
  }

  /* ---------- the point-by-point commentary ---------- */
  function commentary(setupOrNs, entry) {
    var ns = nsOf(setupOrNs);
    if (!entry || META[entry.type] || entry.invalid) return null;
    var n = function (s) { return sideName(ns, s); };
    var pn = function (id) { var p = playerOf(ns, id); return p ? p.name : ''; };
    var fx = entry.effects || [];
    var find = function (t) { return fx.filter(function (x) { return x.type === t; })[0] || null; };
    var after = entry.after || entry.before || {};
    var score = function () {
      if (!after.points) return '';
      if (after.status === 'completed') return '';
      return callOf(ns, after);
    };
    switch (entry.type) {
      case 'POINT': {
        var k = KINDS[entry.kind] || KINDS.POINT;
        var who = entry.player && entry.playerNamed ? pn(entry.player) : n(entry.side);
        var head;
        var dir = entry.serveDir && DIR_WORDS[entry.serveDir] ? ' ' + DIR_WORDS[entry.serveDir] : '';
        if (entry.kind === 'ACE') head = 'Ace by ' + pn(entry.server) + dir;
        else if (entry.kind === 'DOUBLE_FAULT') head = 'Double fault' + (entry.foot ? ' (foot fault)' : '') + ' — ' + pn(entry.server);
        else if (entry.kind === 'SERVICE_WINNER') head = 'Service winner — ' + pn(entry.server) + dir;
        else if (k.winner) head = k.label + ' by ' + who + (entry.stroke ? ' (' + STROKES[entry.stroke].toLowerCase() + ')' : '');
        else if (k.error) head = k.label + ' by ' + (entry.player && entry.playerNamed ? pn(entry.player) : n(other(entry.side))) + ' — point ' + n(entry.side);
        else head = 'Point ' + n(entry.side);
        var tail = [];
        var mw = find('MATCH_WON'), sw = find('SET_WON'), tw = find('TIEBREAK_WON'), gw = find('GAME_WON');
        if (mw) tail.push('Game, set and match ' + n(mw.side));
        else if (sw) tail.push((sw.mtb ? 'Match tie-break' : 'Set') + ' ' + n(sw.side) + ' ' + sw.games[sw.side] + '-' + sw.games[other(sw.side)] + (sw.tb && !sw.mtb ? '(' + Math.min(sw.tb.A, sw.tb.B) + ')' : sw.tb && sw.mtb ? ' [' + sw.tb[sw.side] + '-' + sw.tb[other(sw.side)] + ']' : ''));
        else if (tw) tail.push('Tie-break ' + n(tw.side));
        else if (gw) tail.push((gw.break ? 'Break of serve! ' : '') + 'Game ' + n(gw.side) + ' — ' + gw.games[gw.side] + '-' + gw.games[other(gw.side)] + (gw.games.A === gw.games.B ? '' : ' ' + n(gw.games.A > gw.games.B ? 'A' : 'B')));
        else { var sc = score(); if (sc) tail.push(sc); }
        if (find('TIEBREAK_START')) tail.push('Tie-break');
        return { text: head + (tail.length ? ' · ' + tail.join(' · ') : ''), tone: mw ? 'match' : sw ? 'set' : gw && gw.break ? 'break' : gw ? 'game' : entry.kind === 'ACE' ? 'ace' : entry.kind === 'DOUBLE_FAULT' ? 'df' : 'point', side: entry.side };
      }
      case 'FAULT': return { text: (entry.foot ? 'Foot fault' : 'Fault') + ' — second serve, ' + pn(entry.server), tone: 'fault', side: entry.serverSide };
      case 'LET': return { text: 'Let — ' + (entry.serve === 2 ? 'second' : 'first') + ' serve again', tone: 'let', side: entry.serverSide };
      case 'TOSS': return { text: n(entry.toss.winner) + ' won the toss and chose ' + ({ serve: 'to serve', receive: 'to receive', end: 'an end', defer: 'to let the opponent choose' })[entry.toss.choice] + ' · ' + n(entry.toss.firstServe) + ' to serve', tone: 'info' };
      case 'START': return { text: 'Play — ' + pn(entry.server) + ' to serve', tone: 'info', side: entry.serverSide };
      case 'SET_ORDER': return { text: 'Order of service for the new set: ' + entry.order.map(pn).join(', '), tone: 'info' };
      case 'SERVE_CORRECTION': return { text: 'Server corrected — ' + pn(entry.order[0]) + ' serves' + (entry.reason ? ' (' + entry.reason + ')' : ''), tone: 'info' };
      case 'ENDS': return { text: 'Change of ends', tone: 'info' };
      case 'PAUSE': return { text: 'Play paused — ' + INTERRUPTIONS[entry.kind] + (entry.reason ? ' (' + entry.reason + ')' : ''), tone: 'info' };
      case 'SUSPEND': return { text: 'Match suspended — ' + INTERRUPTIONS[entry.kind] + (entry.reason ? ' (' + entry.reason + ')' : ''), tone: 'info' };
      case 'RESUME': return { text: 'Play resumes', tone: 'info' };
      case 'RETIRE': return { text: n(entry.side) + ' retired' + (entry.reason ? ' (' + entry.reason + ')' : '') + ' — ' + n(other(entry.side)) + ' wins', tone: 'match', side: other(entry.side) };
      case 'WALKOVER': return { text: 'Walkover — ' + n(other(entry.side)) + ' advances', tone: 'match', side: other(entry.side) };
      case 'DEFAULT': return { text: n(entry.side) + ' defaulted (' + (entry.reason || '') + ') — ' + n(other(entry.side)) + ' wins', tone: 'match', side: other(entry.side) };
      case 'ABANDON': return { text: 'Match abandoned' + (entry.reason ? ' — ' + entry.reason : ''), tone: 'info' };
      case 'NOTE': return { text: entry.note || 'Note', tone: 'note' };
      case 'MANUAL_STAT': return { text: (MANUAL_STATS[entry.key] || entry.key) + ' · ' + pn(entry.playerId) + ': ' + (entry.value == null ? 'cleared' : entry.value), tone: 'note' };
    }
    return null;
  }

  return {
    SIDES: SIDES, other: other, isSide: isSide,
    DEFAULT_RULES: DEFAULT_RULES, FINAL_SET: FINAL_SET, PRESETS: PRESETS, KINDS: KINDS, STROKES: STROKES, SERVE_DIRS: SERVE_DIRS,
    INTERRUPTIONS: INTERRUPTIONS, MANUAL_STATS: MANUAL_STATS, EVENT_TYPES: EVENT_TYPES, META: META, STATUS_TYPES: STATUS_TYPES, DETAIL_FIELDS: DETAIL_FIELDS,
    normalizeRules: normalizeRules, rulesLabel: rulesLabel, presetOf: presetOf, setRule: setRule, setsToWin: setsToWin,
    gameWon: gameWon, tbWon: tbWon, normalizeSetup: normalizeSetup, shortName: shortName, surname: surname,
    replay: replay, lastUndoable: lastUndoable, lastRedoable: lastRedoable, isDetail: isDetail,
    Ledger: Ledger, summary: summary, snapshot: snapshot, gameDisplay: gameDisplay, callOf: callOf, scoreLine: scoreLine,
    pressureOf: pressureOf, headline: headline, commentary: commentary, currentServer: currentServer, currentReceiver: currentReceiver,
    sideOf: sideOf, partner: partner, defaultReceive: defaultReceive, singlesOrder: singlesOrder, teamDue: teamDue,
    clone: clone
  };
});
