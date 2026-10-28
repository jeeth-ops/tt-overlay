/* ================================================================
   🏐 VOLLEYBALL ENGINE — indoor six-a-side volleyball, as an event ledger.

   Baseline: FIVB Official Volleyball Rules 2025–2028
     https://www.fivb.com/wp-content/uploads/2025/01/FIVB-Volleyball_Rules2025_2028-EN.pdf
   Every number that a competition may change (best of, set points, the
   deciding set, time-outs, substitutions, liberos …) lives in `rules`,
   frozen with the match; normalizeRules() says which of them differ from
   the FIVB defaults so a custom competition is never mistaken for an
   official one.

   THE MODEL. A match is nothing but its ordered list of events (toss,
   line-ups, rallies, time-outs, substitutions, libero replacements …).
   The score, the server, both rotations, the sets, the counters — all of
   it is derived by replaying that list. Nothing is ever stored that could
   disagree with it, so:
     - resuming a match on another laptop = replaying its events;
     - Undo / a correction of an earlier rally = a NEW event (UNDO, VOID,
       CORRECT) that the replay honours — the original stays in the
       ledger for the audit trail, and every later score, server and
       rotation is recomputed from it;
     - a duplicate request can never score twice: every event carries its
       own eventId, minted once by the device that pressed the button.

   Used by:
     - volleyball-server.js  (authoritative: validates and stores events)
     - volleyball-panel.html (the same rules, for instant feedback)
     - volleyball-stats.js   (player/team statistics from the timeline)
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VolleyballEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TEAMS = ['A', 'B'];
  function other(t) { return t === 'A' ? 'B' : 'A'; }
  function isTeam(t) { return t === 'A' || t === 'B'; }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function int(v, d, lo, hi) {
    var n = Math.round(num(v, d));
    if (lo != null && n < lo) n = lo;
    if (hi != null && n > hi) n = hi;
    return n;
  }

  /* ---------- court positions ----------
     positions[team] is an array of six playerIds; index 0 is Position I
     (back right — the server), 1 = II (front right), 2 = III (front
     centre), 3 = IV (front left), 4 = V (back left), 5 = VI (back centre).
     A player's ROLE (setter, outside hitter …) is a different thing and
     never changes because of where the rotation has put them. */
  var POSITION_NAMES = ['I', 'II', 'III', 'IV', 'V', 'VI'];
  var FRONT_ROW = [1, 2, 3];
  var BACK_ROW = [0, 4, 5];
  function isBackRow(idx) { return idx === 0 || idx === 4 || idx === 5; }
  // Clockwise rotation when a team gains the service (FIVB 7.6.1):
  // II→I, I→VI, VI→V, V→IV, IV→III, III→II — so new[i] = old[(i + 1) % 6].
  function rotateClockwise(pos) {
    return [pos[1], pos[2], pos[3], pos[4], pos[5], pos[0]];
  }
  // The inverse — only ever used by an explicit, audited ROTATE correction.
  function rotateBack(pos) {
    return [pos[5], pos[0], pos[1], pos[2], pos[3], pos[4]];
  }

  /* ---------- rules ---------- */
  var DEFAULT_RULES = {
    ruleset: 'FIVB 2025-2028',
    bestOf: 5,                 // first to 3 sets
    setPoints: 25,             // sets 1-4
    decidingSetPoints: 15,     // set 5 (the last possible set)
    winBy: 2,                  // a set needs a two-point lead …
    pointCap: null,            // … with no ceiling (a competition may set one)
    decidingSetToss: true,     // fresh toss before the deciding set (FIVB 7.1)
    decidingSetSwitchAt: 8,    // courts change when the leader reaches 8 (FIVB 18.2.2)
    timeoutsPerSet: 2,         // FIVB 15.4
    timeoutSeconds: 30,
    substitutionsPerSet: 6,    // FIVB 15.6
    liberoEnabled: true,
    maxLiberos: 2,             // FIVB 19.1
    liberoCanServe: false,     // FIVB 19.3.1.3: the libero may not serve, block or attempt to block
    technicalTimeoutsAt: []    // some competitions still use them (e.g. [8, 16]); not in the FIVB rules
  };
  var RULE_FIELDS = Object.keys(DEFAULT_RULES);

  function normalizeRules(input) {
    var r = input && typeof input === 'object' ? input : {};
    var bestOf = int(r.bestOf, DEFAULT_RULES.bestOf, 1, 7);
    if (bestOf % 2 === 0) bestOf += 1;            // always odd: someone must win
    var setPoints = int(r.setPoints, DEFAULT_RULES.setPoints, 5, 99);
    var decidingSetPoints = int(r.decidingSetPoints, DEFAULT_RULES.decidingSetPoints, 5, 99);
    var winBy = int(r.winBy, DEFAULT_RULES.winBy, 1, 5);
    var cap = r.pointCap == null || r.pointCap === '' || r.pointCap === 0 ? null : int(r.pointCap, null, 1, 199);
    if (cap != null && cap <= Math.max(setPoints, decidingSetPoints)) cap = null; // a cap below the target is no cap at all
    var switchAt = r.decidingSetSwitchAt == null ? DEFAULT_RULES.decidingSetSwitchAt
      : (r.decidingSetSwitchAt === false || r.decidingSetSwitchAt === 0 ? null : int(r.decidingSetSwitchAt, 8, 1, 98));
    if (switchAt != null && switchAt >= decidingSetPoints) switchAt = Math.ceil(decidingSetPoints / 2);
    var tta = Array.isArray(r.technicalTimeoutsAt) ? r.technicalTimeoutsAt.map(function (x) { return int(x, 0, 1, 98); })
      .filter(function (x, i, a) { return x > 0 && x < setPoints && a.indexOf(x) === i; }).sort(function (a, b) { return a - b; }) : [];
    var out = {
      ruleset: String(r.ruleset || DEFAULT_RULES.ruleset).slice(0, 60),
      bestOf: bestOf,
      setPoints: setPoints,
      decidingSetPoints: bestOf >= 3 ? decidingSetPoints : setPoints,
      winBy: winBy,
      pointCap: cap,
      decidingSetToss: r.decidingSetToss == null ? true : !!r.decidingSetToss,
      decidingSetSwitchAt: switchAt,
      timeoutsPerSet: int(r.timeoutsPerSet, DEFAULT_RULES.timeoutsPerSet, 0, 6),
      timeoutSeconds: int(r.timeoutSeconds, DEFAULT_RULES.timeoutSeconds, 10, 180),
      substitutionsPerSet: int(r.substitutionsPerSet, DEFAULT_RULES.substitutionsPerSet, 0, 18),
      liberoEnabled: r.liberoEnabled == null ? true : !!r.liberoEnabled,
      maxLiberos: int(r.maxLiberos, DEFAULT_RULES.maxLiberos, 0, 2),
      liberoCanServe: !!r.liberoCanServe,
      technicalTimeoutsAt: tta
    };
    // Which choices differ from the FIVB defaults — shown wherever the
    // rules are shown, so a custom competition is always labelled as one.
    var custom = [];
    ['bestOf', 'setPoints', 'decidingSetPoints', 'winBy', 'pointCap', 'decidingSetToss', 'decidingSetSwitchAt',
      'timeoutsPerSet', 'timeoutSeconds', 'substitutionsPerSet', 'liberoEnabled', 'maxLiberos', 'liberoCanServe'].forEach(function (k) {
      if (k === 'decidingSetPoints' && out.bestOf < 3) return;
      if (JSON.stringify(out[k]) !== JSON.stringify(DEFAULT_RULES[k])) custom.push(k);
    });
    if (out.technicalTimeoutsAt.length) custom.push('technicalTimeoutsAt');
    out.custom = custom;
    out.official = custom.length === 0;
    return out;
  }

  function setsToWin(rules) { return Math.floor(rules.bestOf / 2) + 1; }
  function isDecidingSet(rules, n) { return rules.bestOf >= 3 && n === rules.bestOf; }
  function setTarget(rules, n) { return isDecidingSet(rules, n) ? rules.decidingSetPoints : rules.setPoints; }

  // THE set-winning rule: the target reached with a lead of at least winBy
  // (FIVB 6.2: 25 points and two clear — 25-24 goes on, 26-24 ends it; no
  // ceiling). A competition cap ends the set at the cap regardless.
  function isSetWon(pts, oppPts, target, winBy, cap) {
    if (cap != null && pts >= cap && pts > oppPts) return true;
    return pts >= target && pts - oppPts >= (winBy || 2);
  }

  /* ---------- rally outcomes ----------
     `fault` is the team that lost the rally by its own error; `credit` the
     player field a statistic may be credited to. A point is never turned
     into a kill (or anything else) unless the operator said so. */
  var OUTCOMES = {
    GENERAL:         { label: 'Point',                 short: 'PT',  category: 'general' },
    ATTACK_KILL:     { label: 'Attack kill',           short: 'K',   category: 'attack' },
    BLOCK:           { label: 'Block point',           short: 'BLK', category: 'block' },
    ACE:             { label: 'Service ace',           short: 'ACE', category: 'serve', servingWins: true },
    RECEPTION_ERROR: { label: 'Reception error',       short: 'RE',  category: 'serve', servingWins: true, fault: 'loser' },
    SERVICE_ERROR:   { label: 'Service error',         short: 'SE',  category: 'opponentError', servingLoses: true, fault: 'loser' },
    ATTACK_ERROR:    { label: 'Attack error',          short: 'AE',  category: 'opponentError', fault: 'loser' },
    OPP_ERROR:       { label: 'Opponent error',        short: 'OE',  category: 'opponentError', fault: 'loser' },
    NET_FAULT:       { label: 'Net fault',             short: 'NET', category: 'opponentError', fault: 'loser' },
    FOUR_HITS:       { label: 'Four hits',             short: '4H',  category: 'opponentError', fault: 'loser' },
    DOUBLE_CONTACT:  { label: 'Double contact',        short: 'DC',  category: 'opponentError', fault: 'loser' },
    BALL_OUT:        { label: 'Ball out',              short: 'OUT', category: 'opponentError', fault: 'loser' },
    BALL_IN:         { label: 'Ball in',               short: 'IN',  category: 'general' },
    ROTATION_FAULT:  { label: 'Rotation / position fault', short: 'ROT', category: 'opponentError', fault: 'loser' },
    PENALTY:         { label: 'Penalty',               short: 'PEN', category: 'penalty', fault: 'loser' }
  };
  var REPLAY_REASONS = { DOUBLE_FAULT: 'Double fault', REFEREE: 'Referee decision', INTERFERENCE: 'Outside interference', OTHER: 'Replayed' };
  var SANCTIONS = {
    WARNING: { label: 'Warning (yellow card)', point: false },
    PENALTY: { label: 'Penalty (red card)', point: true },
    EXPULSION: { label: 'Expulsion', point: false, barSet: true },
    DISQUALIFICATION: { label: 'Disqualification', point: false, barMatch: true },
    DELAY_WARNING: { label: 'Delay warning', point: false },
    DELAY_PENALTY: { label: 'Delay penalty', point: true }
  };
  var ROLES = {
    S: 'Setter', OH: 'Outside hitter', OPP: 'Opposite hitter', MB: 'Middle blocker',
    L: 'Libero', DS: 'Defensive specialist', U: 'Universal / other'
  };
  var META = { UNDO: 1, REDO: 1, VOID: 1, CORRECT: 1 };
  var BASE_TYPES = ['TOSS', 'LINEUP', 'SET_START', 'RALLY', 'REPLAY', 'TIMEOUT', 'SUBSTITUTION', 'LIBERO',
    'LINEUP_CORRECTION', 'SERVE_CORRECTION', 'ROTATE', 'SANCTION', 'NOTE', 'FORFEIT', 'ABANDON'];
  var EVENT_TYPES = BASE_TYPES.concat(Object.keys(META));

  /* ---------- the match setup ----------
     setup = { teams: { A: { teamId, name, shortName, players: [ { playerId,
     number, name, role, libero } ] }, B: … }, rules } — the two squads as
     they were registered for THIS match (a later roster edit never
     rewrites a played match). */
  function normalizeSetup(setup) {
    setup = setup || {};
    var rules = normalizeRules(setup.rules);
    var teams = {};
    TEAMS.forEach(function (t) {
      var src = (setup.teams && setup.teams[t]) || {};
      var byId = {}, liberos = [], order = [];
      (Array.isArray(src.players) ? src.players : []).forEach(function (p) {
        if (!p || !p.playerId || byId[p.playerId]) return;
        var id = String(p.playerId);
        byId[id] = { playerId: id, number: p.number == null ? '' : String(p.number), name: String(p.name || ''), role: p.role || '', libero: !!p.libero, captain: !!p.captain };
        order.push(id);
        if (p.libero && rules.liberoEnabled && liberos.length < Math.max(rules.maxLiberos, 0)) liberos.push(id);
      });
      teams[t] = { teamId: src.teamId || null, name: String(src.name || (t === 'A' ? 'Team A' : 'Team B')), shortName: String(src.shortName || ''), byId: byId, order: order, liberos: liberos };
    });
    return { rules: rules, teams: teams };
  }

  function createState(nsetup) {
    return {
      rules: nsetup.rules,
      status: 'pregame',        // pregame | in_set | set_break | completed | abandoned
      tosses: {},               // set number -> toss record (1 and, when played, the deciding set)
      lineups: {},              // set number -> { A: [6], B: [6] } as submitted
      sets: [],
      setsWon: { A: 0, B: 0 },
      serving: null,
      positions: { A: null, B: null },
      libero: { A: null, B: null },   // { liberoId, replaced } while a libero is on court
      leftSide: null,                 // which team is on the scorer's left right now
      barred: { A: {}, B: {} },       // playerId -> reason (disqualified / exceptional sub / expelled for a set)
      rallies: 0,                     // every rally played, replays included
      winner: null,
      result: null,
      forfeit: null,
      abandoned: null,
      notes: 0,
      lastEventAt: null
    };
  }

  function currentSet(state) {
    var s = state.sets[state.sets.length - 1];
    return s || null;
  }

  function score(state) {
    var s = currentSet(state);
    return s ? { A: s.points.A, B: s.points.B } : { A: 0, B: 0 };
  }

  function serverOf(state) {
    if (state.status !== 'in_set' || !isTeam(state.serving) || !state.positions[state.serving]) return null;
    return { team: state.serving, playerId: state.positions[state.serving][0] };
  }

  function fail(code, error, overridable) {
    return { ok: false, code: code, error: error, overridable: !!overridable };
  }

  function playerOf(ns, team, id) {
    return id && ns.teams[team] && ns.teams[team].byId[id] ? ns.teams[team].byId[id] : null;
  }
  function label(ns, team, id) {
    var p = playerOf(ns, team, id);
    if (!p) return String(id || '?');
    return (p.number !== '' ? '#' + p.number + ' ' : '') + (p.name || id);
  }
  function isLibero(ns, team, id) { return ns.teams[team].liberos.indexOf(id) >= 0; }

  /* ---------- the rally ---------- */
  function checkRallyPlayers(ns, state, ev, winner, outcome) {
    var loser = other(winner);
    var p = ev.players && typeof ev.players === 'object' ? ev.players : {};
    var problems = [];
    function must(team, id, what) {
      if (!id) return;
      if (!playerOf(ns, team, id)) problems.push(fail('INVALID_PLAYER', what + ' is not in ' + ns.teams[team].name + "'s squad for this match"));
    }
    // Which side each named player has to be on, for this outcome.
    var attackerTeam = outcome === 'ATTACK_ERROR' || outcome === 'BLOCK' ? loser : winner;
    must(attackerTeam, p.attacker, 'The attacker');
    must(winner, p.assist, 'The setter (assist)');
    (Array.isArray(p.blockers) ? p.blockers : []).forEach(function (b) { must(winner, b, 'A blocker'); });
    (Array.isArray(p.diggers) ? p.diggers : []).forEach(function (d) { must(winner, d, 'A digger'); });
    // the player at fault is always on the side that lost the rally
    must(loser, p.errorBy, 'The player at fault');
    if (p.receiver) must(loser, p.receiver, 'The receiver');
    (Array.isArray(ev.actions) ? ev.actions : []).forEach(function (a) {
      if (a && isTeam(a.team)) must(a.team, a.playerId, 'A player in the rally detail');
    });
    if (problems.length) return problems[0];
    // FIVB 19.3.1.3 — a libero may not block or attempt to block. Flagged:
    // recorded only with an explicit override (the referee let it stand).
    var libBlock = (Array.isArray(p.blockers) ? p.blockers : []).filter(function (b) { return isLibero(ns, winner, b); });
    if (libBlock.length) {
      return fail('LIBERO_BLOCK', label(ns, winner, libBlock[0]) + ' is a libero — a libero may not block (FIVB 19.3.1.3)', true);
    }
    return null;
  }

  function completeSet(state, set, winner, at, effects) {
    set.winner = winner;
    set.status = 'completed';
    set.endedAt = at || set.endedAt || null;
    state.setsWon[winner] += 1;
    state.libero = { A: null, B: null };
    effects.push({ type: 'SET_WON', team: winner, set: set.number, score: { A: set.points.A, B: set.points.B } });
    if (state.setsWon[winner] >= setsToWin(state.rules)) {
      state.status = 'completed';
      state.winner = winner;
      state.serving = null;
      state.result = resultOf(state);
      effects.push({ type: 'MATCH_WON', team: winner, sets: { A: state.setsWon.A, B: state.setsWon.B } });
    } else {
      state.status = 'set_break';
      state.serving = null;
    }
  }

  function resultOf(state) {
    return {
      winner: state.winner,
      sets: { A: state.setsWon.A, B: state.setsWon.B },
      setScores: state.sets.filter(function (s) { return s.status === 'completed'; }).map(function (s) {
        return { set: s.number, A: s.points.A, B: s.points.B, winner: s.winner, forfeit: !!s.forfeit };
      }),
      forfeit: state.forfeit ? state.forfeit.team : null
    };
  }

  // After a rotation: a libero who would now be in the front row must
  // leave, replaced by the player he/she replaced (FIVB 19.3.2).
  function liberoRotationCheck(ns, state, team, effects) {
    var lib = state.libero[team];
    if (!lib) return;
    var idx = state.positions[team].indexOf(lib.liberoId);
    if (idx >= 0 && !isBackRow(idx)) {
      state.positions[team][idx] = lib.replaced;
      state.libero[team] = null;
      effects.push({ type: 'LIBERO_AUTO_EXIT', team: team, libero: lib.liberoId, returning: lib.replaced, position: POSITION_NAMES[idx] });
    }
  }

  function awardPoint(ns, state, winner, at, effects) {
    var set = currentSet(state);
    var serving = state.serving;
    set.points[winner] += 1;
    set.rallies += 1;
    state.rallies += 1;
    var target = set.target;
    if (isSetWon(set.points[winner], set.points[other(winner)], target, state.rules.winBy, state.rules.pointCap)) {
      completeSet(state, set, winner, at, effects);
      return;
    }
    if (winner !== serving) {
      // Side-out: the receiving team won the rally — it gains the service
      // and rotates one position clockwise before serving (FIVB 7.6.1).
      state.serving = winner;
      state.positions[winner] = rotateClockwise(state.positions[winner]);
      set.rotations[winner] += 1;
      effects.push({ type: 'SIDE_OUT', team: winner });
      liberoRotationCheck(ns, state, winner, effects);
    }
    // Deciding set: courts change once, when the leading team reaches 8.
    var sw = state.rules.decidingSetSwitchAt;
    if (set.deciding && sw && !set.sideSwitched && Math.max(set.points.A, set.points.B) >= sw) {
      set.sideSwitched = true;
      set.sideSwitchAt = { A: set.points.A, B: set.points.B };
      state.leftSide = other(state.leftSide);
      effects.push({ type: 'CHANGE_COURTS', set: set.number, score: { A: set.points.A, B: set.points.B } });
    }
    // Technical time-outs (competition option only).
    if (!set.deciding && state.rules.technicalTimeoutsAt.length) {
      var lead = Math.max(set.points.A, set.points.B);
      if (state.rules.technicalTimeoutsAt.indexOf(lead) >= 0 && set.ttos.indexOf(lead) < 0 && set.points[winner] === lead) {
        set.ttos.push(lead);
        effects.push({ type: 'TECHNICAL_TIMEOUT', at: lead });
      }
    }
  }

  /* ---------- substitutions (FIVB 15.5-15.7) ---------- */
  function subStateOf(set, team) { return set.subState[team]; }
  function checkSubPair(ns, state, set, team, out, inn, exceptional, seenOut, seenIn) {
    var pos = state.positions[team];
    if (!out || !inn) return fail('SUB_INVALID', 'Choose the player going out and the player coming in');
    if (!playerOf(ns, team, out)) return fail('INVALID_PLAYER', 'The player going out is not in the squad');
    if (!playerOf(ns, team, inn)) return fail('INVALID_PLAYER', 'The player coming in is not in the squad');
    if (seenOut[out] || seenIn[inn]) return fail('SUB_INVALID', 'The same player is listed twice in one substitution');
    if (pos.indexOf(out) < 0) {
      var lib = state.libero[team];
      if (lib && lib.replaced === out) return fail('SUB_LIBERO_REPLACED', label(ns, team, out) + ' is off court while the libero replaces him/her — bring the libero out first');
      return fail('SUB_NOT_ON_COURT', label(ns, team, out) + ' is not on court');
    }
    if (isLibero(ns, team, out) || isLibero(ns, team, inn)) return fail('SUB_LIBERO', 'A libero is never part of a regular substitution — use the libero replacement');
    if (pos.indexOf(inn) >= 0) return fail('SUB_ALREADY_ON_COURT', label(ns, team, inn) + ' is already on court');
    if (state.barred[team][inn]) return fail('SUB_BARRED', label(ns, team, inn) + ' may not play: ' + state.barred[team][inn]);
    if (exceptional) return null;
    var ss = subStateOf(set, team);
    if (ss.starters.indexOf(out) >= 0) {
      // FIVB 15.6.1: a starting player may leave once and re-enter once.
      if (ss.starterBack[out]) return fail('SUB_ILLEGAL', label(ns, team, out) + ' has already left and re-entered this set — a starting player may leave the game only once (FIVB 15.6.1)', true);
      if (ss.starters.indexOf(inn) >= 0) return fail('SUB_ILLEGAL', label(ns, team, inn) + ' is a starting player and can only return for the substitute who replaced him/her (FIVB 15.6.1)', true);
      if (ss.subEntered[inn] || ss.subLeft[inn]) return fail('SUB_ILLEGAL', label(ns, team, inn) + ' has already played this set — a substitute enters only once per set (FIVB 15.6.2)', true);
      return null;
    }
    // `out` is a substitute: only the starter he/she replaced may come back for him/her.
    var starter = ss.subEntered[out];
    if (!starter) return fail('SUB_ILLEGAL', label(ns, team, out) + ' did not enter by a substitution this set', true);
    if (inn !== starter) return fail('SUB_ILLEGAL', label(ns, team, out) + ' can only be replaced by ' + label(ns, team, starter) + ', the starting player he/she replaced (FIVB 15.6.2)', true);
    if (ss.starterBack[starter]) return fail('SUB_ILLEGAL', label(ns, team, starter) + ' has already re-entered once this set (FIVB 15.6.1)', true);
    return null;
  }

  /* ---------- applying one event ---------- */
  function apply(ns, state, ev) {
    var effects = [];
    var t = ev.type;
    var over = state.status === 'completed' || state.status === 'abandoned';
    var at = num(ev.at, null);
    var ov = ev.override && ev.override.reason ? ev.override : null;
    if (over && t !== 'NOTE') return fail('MATCH_OVER', state.status === 'abandoned' ? 'The match was abandoned' : 'The match is over');
    var set = currentSet(state);
    var res;
    switch (t) {
      case 'TOSS': {
        var n = int(ev.set, 1, 1, 9);
        if (n === 1) {
          if (state.sets.length) return fail('TOSS_NOT_DUE', 'The first-set toss is made before the match starts');
        } else {
          if (!state.rules.decidingSetToss || !isDecidingSet(state.rules, n)) return fail('TOSS_NOT_DUE', 'A new toss is made only before the deciding set');
          if (state.status !== 'set_break' || state.sets.length !== n - 1) return fail('TOSS_NOT_DUE', 'The deciding-set toss is made after set ' + (n - 1) + ' has finished');
        }
        if (!isTeam(ev.winner)) return fail('TOSS_INVALID', 'Choose the team that won the toss');
        var choice = ev.choice;
        if (choice !== 'serve' && choice !== 'receive' && choice !== 'court') return fail('TOSS_INVALID', 'The toss winner chooses to serve, to receive, or the side of the court');
        var firstServe = choice === 'serve' ? ev.winner : choice === 'receive' ? other(ev.winner) : ev.firstServe;
        if (!isTeam(firstServe)) return fail('TOSS_INVALID', 'Choose which team serves first (the other team chose it)');
        if (ev.firstServe && isTeam(ev.firstServe) && ev.firstServe !== firstServe) return fail('TOSS_INVALID', 'The first server does not match the toss choice');
        var leftSide = isTeam(ev.leftSide) ? ev.leftSide : 'A';
        state.tosses[n] = { set: n, winner: ev.winner, choice: choice, firstServe: firstServe, leftSide: leftSide, at: at, captainA: ev.captainA || null, captainB: ev.captainB || null };
        effects.push({ type: 'TOSS', set: n, winner: ev.winner, choice: choice });
        return { ok: true, effects: effects };
      }
      case 'LINEUP': {
        if (!isTeam(ev.team)) return fail('INVALID_TEAM', 'Choose a team');
        if (state.status === 'in_set') return fail('SET_IN_PROGRESS', 'The set is in progress — use a substitution or a line-up correction');
        var ln = int(ev.set, state.sets.length + 1, 1, 9);
        if (ln !== state.sets.length + 1) return fail('LINEUP_WRONG_SET', 'The line-up given is for set ' + ln + ' but set ' + (state.sets.length + 1) + ' is next');
        var lp = Array.isArray(ev.positions) ? ev.positions.map(String) : [];
        res = checkSix(ns, state, ev.team, lp);
        if (res) return res;
        state.lineups[ln] = state.lineups[ln] || {};
        state.lineups[ln][ev.team] = lp.slice();
        effects.push({ type: 'LINEUP', team: ev.team, set: ln });
        return { ok: true, effects: effects };
      }
      case 'SET_START': {
        if (state.status === 'in_set') return fail('SET_IN_PROGRESS', 'Set ' + set.number + ' is still in progress');
        var sn = state.sets.length + 1;
        if (ev.set != null && int(ev.set, sn) !== sn) return fail('SET_WRONG', 'Set ' + sn + ' is next');
        if (sn > state.rules.bestOf) return fail('MATCH_OVER', 'All sets have been played');
        var deciding = isDecidingSet(state.rules, sn);
        if (sn === 1 && !state.tosses[1]) return fail('TOSS_REQUIRED', 'Record the toss before the first set');
        if (deciding && state.rules.decidingSetToss && !state.tosses[sn]) return fail('TOSS_REQUIRED', 'Record the new toss for the deciding set');
        var lu = state.lineups[sn] || {};
        if (!lu.A || !lu.B) return fail('LINEUP_REQUIRED', 'Both starting line-ups for set ' + sn + ' are needed (' + (!lu.A ? ns.teams.A.name : ns.teams.B.name) + ' is missing)');
        // A line-up may name a player disqualified after it was submitted.
        for (var ti = 0; ti < 2; ti++) {
          var tm = TEAMS[ti];
          for (var k = 0; k < 6; k++) if (state.barred[tm][lu[tm][k]]) return fail('LINEUP_BARRED', label(ns, tm, lu[tm][k]) + ' may not play: ' + state.barred[tm][lu[tm][k]]);
        }
        var prev = state.sets[state.sets.length - 1];
        var tossNow = sn === 1 ? state.tosses[1] : (deciding && state.rules.decidingSetToss ? state.tosses[sn] : null);
        // FIVB 12.1: the toss decides the first service of set 1 and of the
        // deciding set; every other set starts with the service of the team
        // that did not serve first in the previous set.
        var fs = tossNow ? tossNow.firstServe : other(prev.firstServe);
        // FIVB 18.2.1: courts change after each set; the deciding set's
        // courts come from its own toss.
        var ls = tossNow ? tossNow.leftSide : other(prev.leftSideAtStart);
        var ns6 = { A: lu.A.slice(), B: lu.B.slice() };
        state.sets.push({
          number: sn, deciding: deciding, target: setTarget(state.rules, sn),
          points: { A: 0, B: 0 }, rallies: 0, replays: 0,
          firstServe: fs, leftSideAtStart: ls, sideSwitched: false, sideSwitchAt: null,
          lineup: { A: lu.A.slice(), B: lu.B.slice() },
          rotations: { A: 0, B: 0 },
          timeouts: { A: [], B: [] }, ttos: [],
          subs: { A: [], B: [] }, subCount: { A: 0, B: 0 },
          subState: { A: newSubState(lu.A), B: newSubState(lu.B) },
          liberoReplacements: { A: 0, B: 0 },
          lastSubRally: { A: -1, B: -1 }, lastLiberoRally: { A: -1, B: -1 },
          startedAt: at, endedAt: null, winner: null, status: 'in_progress'
        });
        state.positions = ns6;
        state.libero = { A: null, B: null };
        state.serving = fs;
        state.leftSide = ls;
        state.status = 'in_set';
        // an expulsion lasts for the set it was given in
        TEAMS.forEach(function (tt) {
          Object.keys(state.barred[tt]).forEach(function (pid) { if (/for the set/.test(state.barred[tt][pid])) delete state.barred[tt][pid]; });
        });
        effects.push({ type: 'SET_START', set: sn, firstServe: fs });
        return { ok: true, effects: effects };
      }
      case 'RALLY': {
        if (state.status !== 'in_set') return fail('NO_SET_IN_PROGRESS', state.status === 'set_break' ? 'Set ' + set.number + ' is over — start the next set' : 'Start the set first');
        if (!isTeam(ev.winner)) return fail('INVALID_TEAM', 'Choose the team that won the rally');
        var outcome = OUTCOMES[ev.outcome] ? ev.outcome : 'GENERAL';
        var def = OUTCOMES[outcome];
        if (def.servingWins && ev.winner !== state.serving) return fail('OUTCOME_SERVING', def.label + ' can only win the rally for the serving team (' + ns.teams[state.serving].name + ')');
        if (def.servingLoses && ev.winner === state.serving) return fail('OUTCOME_SERVING', 'A service error gives the point to the receiving team (' + ns.teams[other(state.serving)].name + ')');
        res = checkRallyPlayers(ns, state, ev, ev.winner, outcome);
        if (res && !(res.overridable && ov)) return res;
        awardPoint(ns, state, ev.winner, at, effects);
        return { ok: true, effects: effects, overridden: res ? res.code : null };
      }
      case 'REPLAY': {
        if (state.status !== 'in_set') return fail('NO_SET_IN_PROGRESS', 'No set is in progress');
        // FIVB 6.1.2.2 / 17.3: a replayed rally gives no point and keeps the server.
        set.rallies += 1;
        set.replays += 1;
        state.rallies += 1;
        effects.push({ type: 'REPLAY' });
        return { ok: true, effects: effects };
      }
      case 'TIMEOUT': {
        if (state.status !== 'in_set') return fail('NO_SET_IN_PROGRESS', 'A time-out is taken during a set');
        if (!isTeam(ev.team)) return fail('INVALID_TEAM', 'Choose a team');
        if (set.timeouts[ev.team].length >= state.rules.timeoutsPerSet && !ov) {
          return fail('TIMEOUT_LIMIT', ns.teams[ev.team].name + ' has used all ' + state.rules.timeoutsPerSet + ' time-outs this set', true);
        }
        set.timeouts[ev.team].push({ at: at, score: { A: set.points.A, B: set.points.B }, rally: set.rallies });
        effects.push({ type: 'TIMEOUT', team: ev.team, seconds: state.rules.timeoutSeconds });
        return { ok: true, effects: effects };
      }
      case 'SUBSTITUTION': {
        if (state.status !== 'in_set') return fail('NO_SET_IN_PROGRESS', 'Substitutions are made during a set (between sets, submit the next line-up)');
        if (!isTeam(ev.team)) return fail('INVALID_TEAM', 'Choose a team');
        var team = ev.team;
        var pairs = Array.isArray(ev.pairs) ? ev.pairs : (ev.out || ev.in ? [{ out: ev.out, in: ev.in }] : []);
        pairs = pairs.map(function (p) { return { out: p && p.out ? String(p.out) : '', in: p && p.in ? String(p.in) : '' }; });
        if (!pairs.length) return fail('SUB_INVALID', 'Choose the players to substitute');
        var exceptional = !!ev.exceptional;
        var seenOut = {}, seenIn = {}, soft = null;
        for (var i = 0; i < pairs.length; i++) {
          var pr = checkSubPair(ns, state, set, team, pairs[i].out, pairs[i].in, exceptional, seenOut, seenIn);
          if (pr) { if (pr.overridable && ov) soft = soft || pr; else return pr; }
          seenOut[pairs[i].out] = 1; seenIn[pairs[i].in] = 1;
        }
        if (!exceptional && set.subCount[team] + pairs.length > state.rules.substitutionsPerSet) {
          var lim = fail('SUB_LIMIT', ns.teams[team].name + ' has ' + Math.max(0, state.rules.substitutionsPerSet - set.subCount[team]) + ' substitution(s) left this set (FIVB 15.6: ' + state.rules.substitutionsPerSet + ' per set)', true);
          if (!ov) return lim; soft = soft || lim;
        }
        // FIVB 16.1.3: a second substitution request by the same team in the
        // same interruption (no rally completed in between) is improper.
        if (set.lastSubRally[team] === set.rallies && !exceptional) {
          var si = fail('SAME_INTERRUPTION', ns.teams[team].name + ' already made a substitution request in this interruption — a rally must be played first (FIVB 16.1)', true);
          if (!ov) return si; soft = soft || si;
        }
        var ss = subStateOf(set, team);
        pairs.forEach(function (p) {
          var idx = state.positions[team].indexOf(p.out);
          state.positions[team][idx] = p.in;
          if (exceptional) {
            // FIVB 15.7: the injured / ill player may not re-enter the match.
            state.barred[team][p.out] = 'replaced by an exceptional substitution (FIVB 15.7)';
          } else if (ss.starters.indexOf(p.out) >= 0) {
            ss.starterOut[p.out] = true;
            ss.subEntered[p.in] = p.out;
          } else if (ss.subEntered[p.out]) {
            ss.subLeft[p.out] = true;
            ss.starterBack[p.in] = true;
            delete ss.subEntered[p.out];
          }
        });
        set.subs[team].push({ pairs: pairs, exceptional: exceptional, at: at, score: { A: set.points.A, B: set.points.B }, rally: set.rallies, overridden: soft ? soft.code : null });
        if (!exceptional) {
          set.subCount[team] += pairs.length;
          set.lastSubRally[team] = set.rallies;
        }
        effects.push({ type: 'SUBSTITUTION', team: team, pairs: pairs, exceptional: exceptional });
        return { ok: true, effects: effects, overridden: soft ? soft.code : null };
      }
      case 'LIBERO': {
        if (state.status !== 'in_set') return fail('NO_SET_IN_PROGRESS', 'Libero replacements happen during a set');
        if (!state.rules.liberoEnabled) return fail('LIBERO_DISABLED', 'This competition plays without liberos');
        if (!isTeam(ev.team)) return fail('INVALID_TEAM', 'Choose a team');
        var lt = ev.team;
        var lib = ev.libero ? String(ev.libero) : '';
        if (!isLibero(ns, lt, lib)) return fail('LIBERO_NOT_DESIGNATED', label(ns, lt, lib) + ' is not a designated libero of ' + ns.teams[lt].name);
        var cur = state.libero[lt];
        var soft2 = null;
        if (set.lastLiberoRally[lt] === set.rallies) {
          // FIVB 19.3.2.3: a completed rally between two libero replacements.
          var lr = fail('LIBERO_NO_RALLY_BETWEEN', 'There must be a completed rally between two libero replacements (FIVB 19.3.2.3)', true);
          if (!ov) return lr; soft2 = lr;
        }
        if (ev.action === 'out') {
          if (!cur || cur.liberoId !== lib) return fail('LIBERO_NOT_ON_COURT', label(ns, lt, lib) + ' is not on court');
          var ret = ev.returning ? String(ev.returning) : cur.replaced;
          if (ret !== cur.replaced) return fail('LIBERO_WRONG_RETURN', 'The libero can only be replaced by the player he/she replaced (' + label(ns, lt, cur.replaced) + ')');
          var oi = state.positions[lt].indexOf(lib);
          state.positions[lt][oi] = ret;
          state.libero[lt] = null;
          set.lastLiberoRally[lt] = set.rallies;
          effects.push({ type: 'LIBERO_OUT', team: lt, libero: lib, returning: ret });
          return { ok: true, effects: effects, overridden: soft2 ? soft2.code : null };
        }
        var rep = ev.replaces ? String(ev.replaces) : '';
        if (state.positions[lt].indexOf(lib) >= 0) return fail('LIBERO_ALREADY_ON_COURT', label(ns, lt, lib) + ' is already on court');
        var ri = state.positions[lt].indexOf(rep);
        if (ri < 0) return fail('LIBERO_INVALID', label(ns, lt, rep) + ' is not on court');
        var swap = !!(cur && cur.liberoId === rep);
        if (cur && !swap) return fail('LIBERO_ALREADY_ON_COURT', 'A libero (' + label(ns, lt, cur.liberoId) + ') is already on court — only the second libero may replace him/her');
        if (!isBackRow(ri)) return fail('LIBERO_FRONT_ROW', 'A libero may replace only a back-row player (positions I, V, VI) — ' + label(ns, lt, rep) + ' is in position ' + POSITION_NAMES[ri]);
        if (ri === 0 && state.serving === lt && !state.rules.liberoCanServe) return fail('LIBERO_SERVE', label(ns, lt, rep) + ' is about to serve — a libero may not serve (FIVB 19.3.1.3)');
        state.positions[lt][ri] = lib;
        state.libero[lt] = { liberoId: lib, replaced: swap ? cur.replaced : rep };
        set.liberoReplacements[lt] += 1;
        set.lastLiberoRally[lt] = set.rallies;
        effects.push({ type: 'LIBERO_IN', team: lt, libero: lib, replaces: rep, position: POSITION_NAMES[ri] });
        return { ok: true, effects: effects, overridden: soft2 ? soft2.code : null };
      }
      case 'LINEUP_CORRECTION': {
        // An authorised fix of the players on court (a line-up entered in
        // the wrong order, a substitution the scorer missed). Never counts
        // as a substitution; always carries its reason for the audit.
        if (state.status !== 'in_set') return fail('NO_SET_IN_PROGRESS', 'No set is in progress');
        if (!isTeam(ev.team)) return fail('INVALID_TEAM', 'Choose a team');
        if (!ev.reason) return fail('REASON_REQUIRED', 'Give a reason for the correction');
        var cp = Array.isArray(ev.positions) ? ev.positions.map(String) : [];
        if (state.libero[ev.team]) return fail('LIBERO_ON_COURT', 'Bring the libero out before correcting the line-up');
        res = checkSix(ns, state, ev.team, cp);
        if (res) return res;
        state.positions[ev.team] = cp.slice();
        if (ev.scope === 'starting') {
          if (set.rallies > 0 && !ov) return fail('LINEUP_STARTED', 'Rallies have been played — correct the current positions instead', true);
          set.lineup[ev.team] = cp.slice();
          set.subState[ev.team] = newSubState(cp);
        }
        effects.push({ type: 'LINEUP_CORRECTION', team: ev.team });
        return { ok: true, effects: effects };
      }
      case 'SERVE_CORRECTION': {
        if (state.status !== 'in_set') return fail('NO_SET_IN_PROGRESS', 'No set is in progress');
        if (!isTeam(ev.team)) return fail('INVALID_TEAM', 'Choose a team');
        if (!ev.reason) return fail('REASON_REQUIRED', 'Give a reason for the correction');
        if (state.libero[ev.team] && state.positions[ev.team][0] === state.libero[ev.team].liberoId && !state.rules.liberoCanServe) {
          return fail('LIBERO_SERVE', 'The libero is in position I — bring him/her out first');
        }
        state.serving = ev.team;
        if (set.rallies === 0) set.firstServe = ev.team;
        effects.push({ type: 'SERVE_CORRECTION', team: ev.team });
        return { ok: true, effects: effects };
      }
      case 'ROTATE': {
        if (state.status !== 'in_set') return fail('NO_SET_IN_PROGRESS', 'No set is in progress');
        if (!isTeam(ev.team)) return fail('INVALID_TEAM', 'Choose a team');
        if (!ev.reason) return fail('REASON_REQUIRED', 'Give a reason for the correction');
        state.positions[ev.team] = ev.direction === -1 ? rotateBack(state.positions[ev.team]) : rotateClockwise(state.positions[ev.team]);
        liberoRotationCheck(ns, state, ev.team, effects);
        effects.push({ type: 'ROTATE', team: ev.team, direction: ev.direction === -1 ? -1 : 1 });
        return { ok: true, effects: effects };
      }
      case 'SANCTION': {
        if (!isTeam(ev.team)) return fail('INVALID_TEAM', 'Choose a team');
        var sk = SANCTIONS[ev.kind];
        if (!sk) return fail('SANCTION_INVALID', 'Choose the sanction');
        if (ev.playerId && !playerOf(ns, ev.team, String(ev.playerId))) return fail('INVALID_PLAYER', 'That player is not in the squad');
        if (sk.point && state.status !== 'in_set') return fail('NO_SET_IN_PROGRESS', 'A penalty point is given during a set');
        if (sk.barMatch && ev.playerId) state.barred[ev.team][String(ev.playerId)] = 'disqualified for the match';
        if (sk.barSet && ev.playerId) state.barred[ev.team][String(ev.playerId)] = 'expelled for the set';
        effects.push({ type: 'SANCTION', team: ev.team, kind: ev.kind, playerId: ev.playerId || null });
        // FIVB 6.1.3 / 16.2: a penalty is a point AND the service for the opponent.
        if (sk.point) awardPoint(ns, state, other(ev.team), at, effects);
        if ((sk.barMatch || sk.barSet) && ev.playerId && state.status === 'in_set' && state.positions[ev.team].indexOf(String(ev.playerId)) >= 0) {
          effects.push({ type: 'MUST_REPLACE', team: ev.team, playerId: String(ev.playerId) });
        }
        return { ok: true, effects: effects };
      }
      case 'NOTE': {
        state.notes += 1;
        return { ok: true, effects: effects };
      }
      case 'FORFEIT': {
        // FIVB 6.4: a team declared in default or incomplete loses; the
        // opponent is given the points, or the points and the sets, needed
        // to win — the defaulting team keeps the points and sets it has.
        if (!isTeam(ev.team)) return fail('INVALID_TEAM', 'Choose the team that forfeits');
        var loserT = ev.team, winT = other(loserT);
        if (state.status === 'in_set') {
          var tgt = set.target;
          set.points[winT] = Math.max(tgt, set.points[loserT] + state.rules.winBy, set.points[winT]);
          set.forfeit = true;
          completeSetQuiet(state, set, winT, at);
        }
        while (state.setsWon[winT] < setsToWin(state.rules)) {
          var fn = state.sets.length + 1;
          var fpts = { A: 0, B: 0 };
          fpts[winT] = setTarget(state.rules, fn);
          state.sets.push({ number: fn, deciding: isDecidingSet(state.rules, fn), target: setTarget(state.rules, fn), points: fpts, rallies: 0, replays: 0,
            firstServe: null, leftSideAtStart: null, sideSwitched: false, lineup: null, rotations: { A: 0, B: 0 }, timeouts: { A: [], B: [] }, ttos: [],
            subs: { A: [], B: [] }, subCount: { A: 0, B: 0 }, subState: null, liberoReplacements: { A: 0, B: 0 },
            lastSubRally: { A: -1, B: -1 }, lastLiberoRally: { A: -1, B: -1 }, startedAt: at, endedAt: at, winner: winT, status: 'completed', forfeit: true });
          state.setsWon[winT] += 1;
        }
        state.status = 'completed';
        state.winner = winT;
        state.serving = null;
        state.libero = { A: null, B: null };
        state.forfeit = { team: loserT, reason: ev.reason || '' };
        state.result = resultOf(state);
        effects.push({ type: 'FORFEIT', team: loserT });
        effects.push({ type: 'MATCH_WON', team: winT, sets: { A: state.setsWon.A, B: state.setsWon.B } });
        return { ok: true, effects: effects };
      }
      case 'ABANDON': {
        state.status = 'abandoned';
        state.abandoned = { reason: ev.reason || '', at: at };
        state.serving = null;
        effects.push({ type: 'ABANDON' });
        return { ok: true, effects: effects };
      }
      default:
        return fail('UNKNOWN_EVENT', 'Unknown event type ' + t);
    }
  }

  // apply() + the one bookkeeping field every successful event touches —
  // the single entry point for replay() and Ledger.check() alike, so the
  // incremental state and a full replay can never drift apart.
  function applyEvent(ns, state, ev) {
    var r = apply(ns, state, ev);
    if (r.ok && ev.at) state.lastEventAt = ev.at;
    return r;
  }

  function completeSetQuiet(state, set, winner, at) {
    set.winner = winner; set.status = 'completed'; set.endedAt = at || null;
    state.setsWon[winner] += 1;
  }

  function newSubState(starters) {
    return { starters: starters.slice(), starterOut: {}, starterBack: {}, subEntered: {}, subLeft: {} };
  }

  function checkSix(ns, state, team, list) {
    if (list.length !== 6) return fail('LINEUP_INVALID', 'A line-up has exactly six players');
    var seen = {};
    for (var i = 0; i < 6; i++) {
      var id = list[i];
      if (!id) return fail('LINEUP_INVALID', 'Position ' + POSITION_NAMES[i] + ' is empty');
      if (seen[id]) return fail('LINEUP_INVALID', label(ns, team, id) + ' is listed twice');
      seen[id] = 1;
      if (!playerOf(ns, team, id)) return fail('INVALID_PLAYER', 'A player in the line-up is not in ' + ns.teams[team].name + "'s squad");
      if (isLibero(ns, team, id)) return fail('LINEUP_LIBERO', label(ns, team, id) + ' is a libero — the libero is not part of the starting six (FIVB 19.3.2)');
      if (state.barred[team][id]) return fail('LINEUP_BARRED', label(ns, team, id) + ' may not play: ' + state.barred[team][id]);
    }
    return null;
  }

  /* ---------- the ledger ----------
     Meta events change which base events count and what they say:
       UNDO { target }      — the latest event that counts no longer does
       REDO { target }      — the UNDO `target` is taken back
       VOID { target, reason }    — an earlier event no longer counts
       CORRECT { target, patch, reason } — a RALLY (or other event) reads
                                  differently: winner / outcome / players
     They never remove anything: the original stays, marked. */
  function bySeq(a, b) { return (num(a.seq, 0) - num(b.seq, 0)) || (num(a.at, 0) - num(b.at, 0)); }

  function resolveMeta(events) {
    var byId = {}, voidedBy = {}, patches = {};
    events.forEach(function (ev) { if (ev && ev.eventId) byId[ev.eventId] = ev; });
    events.forEach(function (ev) {
      if (!ev || !META[ev.type]) return;
      var target = byId[ev.target];
      if (!target) return;
      if (ev.type === 'UNDO' || ev.type === 'VOID') {
        // an original event, or a correction (undoing a correction reverts it)
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

  var PATCHABLE = { winner: 1, outcome: 1, players: 1, actions: 1, note: 1, team: 1, reason: 1, kind: 1, playerId: 1 };
  function effectiveEvent(ev, patchEvents) {
    if (!patchEvents || !patchEvents.length) return ev;
    var out = clone(ev);
    patchEvents.forEach(function (c) {
      var p = c.patch || {};
      Object.keys(p).forEach(function (k) { if (PATCHABLE[k]) out[k] = clone(p[k]); });
    });
    out.corrected = patchEvents.map(function (c) { return c.eventId; });
    return out;
  }

  function snapshot(state) {
    var s = currentSet(state);
    return {
      set: s ? s.number : 0,
      score: s ? { A: s.points.A, B: s.points.B } : { A: 0, B: 0 },
      setsWon: { A: state.setsWon.A, B: state.setsWon.B },
      server: serverOf(state),
      status: state.status
    };
  }

  // Replays the ledger. Returns the state, a timeline entry per event
  // (with the score / server before and after it), and every event that
  // no longer applies (a correction that changed what came after it).
  function replay(setup, events, opts) {
    var ns = setup && setup.teams && setup.teams.A && setup.teams.A.byId ? setup : normalizeSetup(setup);
    var list = (events || []).filter(Boolean).slice().sort(bySeq);
    var meta = resolveMeta(list);
    var state = createState(ns);
    var timeline = [], invalid = [];
    list.forEach(function (ev) {
      var entry = { eventId: ev.eventId, seq: ev.seq, type: ev.type, at: ev.at || null, by: ev.by || null };
      if (META[ev.type]) {
        entry.target = ev.target || null;
        entry.reason = ev.reason || null;
        if (ev.type === 'CORRECT') entry.patch = ev.patch || null;
        entry.voided = !!meta.voidedBy[ev.eventId];
        timeline.push(entry);
        return;
      }
      var before = snapshot(state);
      entry.before = before;
      if (meta.voidedBy[ev.eventId]) {
        entry.voided = true;
        entry.voidedBy = meta.voidedBy[ev.eventId];
        describe(ns, entry, ev);
        timeline.push(entry);
        return;
      }
      var eff = effectiveEvent(ev, meta.patches[ev.eventId]);
      if (eff.corrected) entry.corrected = eff.corrected;
      describe(ns, entry, eff);
      var r = applyEvent(ns, state, eff);
      if (!r.ok) {
        entry.invalid = { code: r.code, error: r.error };
        invalid.push(entry);
      } else {
        entry.effects = r.effects;
        if (r.overridden) entry.overridden = r.overridden;
      }
      entry.after = snapshot(state);
      if (ev.type === 'RALLY' && r.ok) rallyFacts(entry, before, eff.winner);
      timeline.push(entry);
    });
    return { state: state, timeline: timeline, invalid: invalid, setup: ns };
  }

  // Who served the rally, the point's number in its set (A+B after it —
  // the set just won still being the current set) and whether it was a
  // side-out.
  function rallyFacts(entry, before, winner) {
    entry.rallyServer = before.server;
    entry.pointNo = entry.after.score.A + entry.after.score.B;
    entry.sideOut = before.server ? before.server.team !== winner : false;
  }

  function describe(ns, entry, ev) {
    switch (ev.type) {
      case 'RALLY':
        entry.team = ev.winner;
        entry.outcome = OUTCOMES[ev.outcome] ? ev.outcome : 'GENERAL';
        entry.players = ev.players ? clone(ev.players) : null;
        if (ev.actions) entry.actions = clone(ev.actions);
        break;
      case 'TIMEOUT': case 'LINEUP': case 'LINEUP_CORRECTION': case 'SERVE_CORRECTION': case 'ROTATE':
        entry.team = ev.team; if (ev.reason) entry.reason = ev.reason;
        if (ev.positions) entry.positions = clone(ev.positions);
        if (ev.set) entry.set = ev.set;
        break;
      case 'SUBSTITUTION':
        entry.team = ev.team;
        entry.pairs = Array.isArray(ev.pairs) ? clone(ev.pairs) : [{ out: ev.out, in: ev.in }];
        entry.exceptional = !!ev.exceptional;
        break;
      case 'LIBERO':
        entry.team = ev.team; entry.libero = ev.libero; entry.action = ev.action === 'out' ? 'out' : 'in';
        entry.replaces = ev.replaces || null; entry.returning = ev.returning || null;
        break;
      case 'SANCTION':
        entry.team = ev.team; entry.kind = ev.kind; entry.playerId = ev.playerId || null; entry.reason = ev.reason || null;
        break;
      case 'TOSS':
        entry.toss = { set: ev.set || 1, winner: ev.winner, choice: ev.choice, firstServe: ev.firstServe || null, leftSide: ev.leftSide || null };
        break;
      case 'NOTE':
        entry.note = String(ev.text || ev.note || '').slice(0, 500);
        break;
      case 'FORFEIT': case 'ABANDON':
        entry.team = ev.team || null; entry.reason = ev.reason || null;
        break;
      case 'REPLAY':
        entry.reason = ev.reason || 'DOUBLE_FAULT';
        break;
    }
    if (ev.override) entry.override = clone(ev.override);
  }

  // The newest event Undo would take back: the latest base event (or
  // correction) that still counts. Null when there is nothing to undo.
  function lastUndoable(events) {
    var list = (events || []).filter(Boolean).slice().sort(bySeq);
    var meta = resolveMeta(list);
    for (var i = list.length - 1; i >= 0; i--) {
      var ev = list[i];
      if (meta.voidedBy[ev.eventId]) continue;
      if (ev.type === 'UNDO' || ev.type === 'REDO' || ev.type === 'VOID') continue;
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
      if (ev.type === 'REDO' || ev.type === 'VOID') continue;
      if (ev.type === 'UNDO') continue;
      return null; // something new was recorded after the last undo
    }
    return null;
  }

  /* ---------- Ledger: the live, incremental form of replay() ----------
     The server keeps one per match. A new rally is checked against a copy
     of the current state (fast — no replay); a meta event is checked by a
     full replay and refused if it would make any later event invalid
     (e.g. a corrected rally that would have ended the set earlier than the
     rallies already recorded in it). */
  function Ledger(setup, events) {
    this.setup = normalizeSetup(setup);
    this.rebuild(events || []);
  }
  Ledger.prototype.rebuild = function (events) {
    this.events = (events || []).filter(Boolean).slice().sort(bySeq);
    var r = replay(this.setup, this.events);
    this.state = r.state;
    this.timeline = r.timeline;
    this.invalid = r.invalid;
    this.seq = this.events.length ? num(this.events[this.events.length - 1].seq, this.events.length) : 0;
    this.ids = {};
    for (var i = 0; i < this.events.length; i++) this.ids[this.events[i].eventId] = this.events[i];
    return this;
  };
  Ledger.prototype.has = function (eventId) { return !!this.ids[eventId]; };
  // { ok, code, error, overridable, pending } — never changes the ledger.
  Ledger.prototype.check = function (ev) {
    if (!ev || typeof ev !== 'object') return fail('INVALID_EVENT', 'No event');
    if (EVENT_TYPES.indexOf(ev.type) < 0) return fail('UNKNOWN_EVENT', 'Unknown event type ' + ev.type);
    if (!ev.eventId) return fail('INVALID_EVENT', 'An event needs its eventId');
    // The same press sent twice (a retry, a reconnect) is the same event:
    // the caller answers it with what was already stored, never again.
    if (this.ids[ev.eventId]) return { ok: false, code: 'DUPLICATE', duplicate: true, error: 'Already recorded', existing: this.ids[ev.eventId] };
    var seq = this.seq + 1;
    var stamped = Object.assign({}, ev, { seq: seq });
    if (META[ev.type]) {
      var m = this.checkMeta(stamped);
      if (m) return m;
      var all = this.events.concat([stamped]);
      var r = replay(this.setup, all);
      var before = {};
      this.invalid.forEach(function (x) { before[x.eventId] = 1; });
      var broken = r.invalid.filter(function (x) { return !before[x.eventId]; });
      if (broken.length) {
        var b = broken[0];
        return fail('CORRECTION_CONFLICT', 'This change would make a later event impossible: ' + (b.type === 'RALLY' ? 'rally' : b.type.toLowerCase().replace(/_/g, ' ')) + ' #' + b.seq + ' — ' + b.invalid.error + '. Undo back to that point instead.');
      }
      return { ok: true, pending: { event: stamped, full: r } };
    }
    var st = clone(this.state);
    var res = applyEvent(this.setup, st, stamped);
    if (!res.ok) return res;
    return { ok: true, pending: { event: stamped, state: st, effects: res.effects, overridden: res.overridden || null } };
  };
  Ledger.prototype.checkMeta = function (ev) {
    var target = this.ids[ev.target];
    if (ev.type === 'UNDO') {
      var last = lastUndoable(this.events);
      if (!last) return fail('NOTHING_TO_UNDO', 'Nothing to undo');
      if (ev.target && ev.target !== last.eventId) return fail('UNDO_NOT_LAST', 'Only the latest event can be undone — correct earlier events instead');
      ev.target = last.eventId;
      return null;
    }
    if (ev.type === 'REDO') {
      var u = lastRedoable(this.events);
      if (!u) return fail('NOTHING_TO_REDO', 'Nothing to redo');
      if (ev.target && ev.target !== u.eventId) return fail('REDO_NOT_LAST', 'Only the latest undo can be redone');
      ev.target = u.eventId;
      return null;
    }
    if (!target) return fail('TARGET_MISSING', 'That event is not part of this match');
    if (!ev.reason) return fail('REASON_REQUIRED', 'Give a reason for the correction');
    var meta = resolveMeta(this.events);
    if (meta.voidedBy[target.eventId]) return fail('TARGET_VOIDED', 'That event no longer counts');
    if (ev.type === 'VOID') {
      if (target.type === 'UNDO' || target.type === 'REDO' || target.type === 'VOID') return fail('TARGET_INVALID', 'Use Redo to take back an undo');
      return null;
    }
    if (ev.type === 'CORRECT') {
      if (META[target.type]) return fail('TARGET_INVALID', 'Only an original event can be corrected');
      var p = ev.patch && typeof ev.patch === 'object' ? ev.patch : null;
      if (!p || !Object.keys(p).some(function (k) { return PATCHABLE[k]; })) return fail('PATCH_INVALID', 'Nothing to correct');
      if (p.winner != null && !isTeam(p.winner)) return fail('PATCH_INVALID', 'Choose the team that won the rally');
      if (p.outcome != null && !OUTCOMES[p.outcome]) return fail('PATCH_INVALID', 'Unknown rally outcome');
      // the corrected rally must itself be valid where it stands (on top
      // of any correction it already had)
      var probe = clone(effectiveEvent(target, meta.patches[target.eventId]));
      Object.keys(p).forEach(function (k) { if (PATCHABLE[k]) probe[k] = clone(p[k]); });
      if (probe.type === 'RALLY') {
        var rr = replay(this.setup, this.events.filter(function (e) { return bySeq(e, target) < 0; }));
        var cr = apply(this.setup, rr.state, probe);
        if (!cr.ok && !(cr.overridable && probe.override)) return cr;
      }
      return null;
    }
    return null;
  };
  // Applies a checked event (after the server has stored it).
  Ledger.prototype.commit = function (pending) {
    var ev = pending.event;
    this.events.push(ev);
    this.ids[ev.eventId] = ev;
    this.seq = num(ev.seq, this.seq + 1);
    if (pending.full) {
      this.state = pending.full.state;
      this.timeline = pending.full.timeline;
      this.invalid = pending.full.invalid;
      return this;
    }
    var before = snapshot(this.state);
    this.state = pending.state;
    var entry = { eventId: ev.eventId, seq: ev.seq, type: ev.type, at: ev.at || null, by: ev.by || null, before: before };
    describe(this.setup, entry, ev);
    entry.effects = pending.effects;
    if (pending.overridden) entry.overridden = pending.overridden;
    entry.after = snapshot(this.state);
    if (ev.type === 'RALLY') rallyFacts(entry, before, ev.winner);
    this.timeline.push(entry);
    return this;
  };

  /* ---------- what the panel, overlay and website show ---------- */
  function summary(setupOrNs, state) {
    var ns = setupOrNs && setupOrNs.teams && setupOrNs.teams.A && setupOrNs.teams.A.byId ? setupOrNs : normalizeSetup(setupOrNs);
    var s = currentSet(state);
    var rules = state.rules;
    var srv = serverOf(state);
    var pts = s ? { A: s.points.A, B: s.points.B } : { A: 0, B: 0 };
    var setPoint = null, matchPoint = null;
    if (state.status === 'in_set' && s) {
      TEAMS.forEach(function (t) {
        if (isSetWon(pts[t] + 1, pts[other(t)], s.target, rules.winBy, rules.pointCap)) {
          if (state.setsWon[t] + 1 >= setsToWin(rules)) matchPoint = t; else setPoint = t;
        }
      });
    }
    function person(team, id) {
      var p = playerOf(ns, team, id);
      return p ? { playerId: p.playerId, number: p.number, name: p.name, role: p.role, libero: p.libero } : (id ? { playerId: id, number: '', name: '' } : null);
    }
    return {
      status: state.status,
      set: s ? s.number : 0,
      nextSet: state.status === 'set_break' || state.status === 'pregame' ? state.sets.length + 1 : null,
      deciding: s ? !!s.deciding : false,
      nextDeciding: isDecidingSet(rules, state.sets.length + 1),
      target: s ? s.target : setTarget(rules, 1),
      points: pts,
      setsWon: { A: state.setsWon.A, B: state.setsWon.B },
      setsToWin: setsToWin(rules),
      bestOf: rules.bestOf,
      sets: state.sets.map(function (x) { return { set: x.number, A: x.points.A, B: x.points.B, winner: x.winner, status: x.status, forfeit: !!x.forfeit, deciding: !!x.deciding }; }),
      // when each set began and ended (the events' own times), who served first, who started on the left
      setInfo: state.sets.map(function (x) { return { set: x.number, startedAt: x.startedAt || null, endedAt: x.endedAt || null, firstServe: x.firstServe || null, leftSide: x.leftSideAtStart || null }; }),
      serving: state.status === 'in_set' ? state.serving : null,
      server: srv ? person(srv.team, srv.playerId) : null,
      leftSide: state.leftSide,
      setPoint: setPoint,
      matchPoint: matchPoint,
      sideSwitched: s ? !!s.sideSwitched : false,
      timeoutsLeft: s && state.status === 'in_set' ? { A: Math.max(0, rules.timeoutsPerSet - s.timeouts.A.length), B: Math.max(0, rules.timeoutsPerSet - s.timeouts.B.length) } : { A: rules.timeoutsPerSet, B: rules.timeoutsPerSet },
      subsLeft: s && state.status === 'in_set' ? { A: Math.max(0, rules.substitutionsPerSet - s.subCount.A), B: Math.max(0, rules.substitutionsPerSet - s.subCount.B) } : { A: rules.substitutionsPerSet, B: rules.substitutionsPerSet },
      positions: state.positions.A && state.positions.B ? {
        A: state.positions.A.map(function (id) { return person('A', id); }),
        B: state.positions.B.map(function (id) { return person('B', id); })
      } : null,
      libero: { A: state.libero.A ? clone(state.libero.A) : null, B: state.libero.B ? clone(state.libero.B) : null },
      toss: state.tosses[1] ? clone(state.tosses[1]) : null,
      decidingToss: state.tosses[rules.bestOf] && rules.bestOf > 1 ? clone(state.tosses[rules.bestOf]) : null,
      lineupsReady: (function () { var l = state.lineups[state.sets.length + 1] || {}; return { A: !!l.A, B: !!l.B }; })(),
      winner: state.winner,
      result: state.result ? clone(state.result) : null,
      forfeit: state.forfeit ? clone(state.forfeit) : null,
      abandoned: state.abandoned ? clone(state.abandoned) : null,
      rallies: state.rallies
    };
  }

  return {
    TEAMS: TEAMS, other: other, POSITION_NAMES: POSITION_NAMES, FRONT_ROW: FRONT_ROW, BACK_ROW: BACK_ROW,
    DEFAULT_RULES: DEFAULT_RULES, RULE_FIELDS: RULE_FIELDS, OUTCOMES: OUTCOMES, SANCTIONS: SANCTIONS,
    REPLAY_REASONS: REPLAY_REASONS, ROLES: ROLES, EVENT_TYPES: EVENT_TYPES, META: META,
    normalizeRules: normalizeRules, normalizeSetup: normalizeSetup, setsToWin: setsToWin,
    isDecidingSet: isDecidingSet, setTarget: setTarget, isSetWon: isSetWon,
    rotateClockwise: rotateClockwise, isBackRow: isBackRow,
    replay: replay, lastUndoable: lastUndoable, lastRedoable: lastRedoable,
    Ledger: Ledger, summary: summary, serverOf: serverOf, score: score, clone: clone
  };
});
