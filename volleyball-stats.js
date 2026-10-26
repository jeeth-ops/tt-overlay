/* ================================================================
   📊 VOLLEYBALL STATISTICS — every number is derived from the match's
   event timeline (volleyball-engine.js replay), never stored on its own,
   so an undo, a corrected rally or a reopened match can never leave a
   total behind: recompute and it is right again.

   What counts as what (shown on the scorecard and in the PDF):
     Attack kill      a rally classified ATTACK_KILL (or BALL_IN) with the
                      attacker named. A team point alone is never a kill.
     Attack error     ATTACK_ERROR with the attacker named, or a BLOCK point
                      with the blocked attacker named.
     Attack attempts  kills + errors + attacks recorded "in play" in the
                      rally detail.
     Attack eff.      (kills − errors) ÷ attempts — shown as a percentage,
                      "–" when there were no attempts.
     Service          one attempt per rally served (the server is the player
                      in position I — a fact of the rotation, not a guess);
                      aces = ACE and RECEPTION_ERROR rallies; errors =
                      SERVICE_ERROR rallies.
     Blocks           a block point with one blocker is a solo block (1
                      point); with n blockers each gets a block assist worth
                      1/n — so the team's block points always add up.
     Points           kills + aces + block points.
     Assists, digs,   only what the operator recorded (the assist / digger
     receptions       on the rally, or the rally detail). Unknown stays
                      unknown.
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./volleyball-engine.js'));
  else root.VolleyballStats = factory(root.VolleyballEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  var SERVE_POINT = { ACE: 1, RECEPTION_ERROR: 1 };
  var FAULT_KEY = {
    NET_FAULT: 'net', FOUR_HITS: 'ballHandling', DOUBLE_CONTACT: 'ballHandling', BALL_OUT: 'out',
    OPP_ERROR: 'other', ROTATION_FAULT: 'rotation', PENALTY: 'penalty'
  };

  function round2(n) { return Math.round(n * 100) / 100; }
  function blankPlayer(team, p) {
    return {
      playerId: p.playerId, team: team, number: p.number, name: p.name, role: p.role || '', libero: !!p.libero, captain: !!p.captain,
      setsPlayed: 0, setsStarted: 0, sets: [],
      points: 0,
      attack: { attempts: 0, kills: 0, errors: 0, blocked: 0, inPlay: 0, efficiency: null },
      serve: { attempts: 0, aces: 0, errors: 0 },
      block: { solo: 0, assists: 0, points: 0 },
      assists: 0, digs: 0,
      reception: { attempts: 0, ok: 0, errors: 0 },
      faults: { net: 0, ballHandling: 0, out: 0, rotation: 0, other: 0, penalty: 0 },
      subs: { in: 0, out: 0 }, liberoEntries: 0,
      sanctions: []
    };
  }
  function blankTeam() {
    return {
      points: 0, setsWon: 0, setsLost: 0,
      byCategory: { attack: 0, block: 0, serve: 0, opponentError: 0, penalty: 0, general: 0 },
      sideOutPoints: 0, breakPoints: 0, longestRun: 0,
      serve: { attempts: 0, aces: 0, errors: 0 },
      attack: { kills: 0, errors: 0, attempts: 0 },
      blockPoints: 0,
      errorsCommitted: 0,
      timeouts: 0, substitutions: 0, liberoReplacements: 0, rallies: 0, replays: 0
    };
  }

  // Which players a rally is ABOUT, with their part in it — the same rule
  // decides whose video icon shows the rally's clip and who a statistic is
  // credited to. Derived from the rally as it reads NOW (corrections
  // included), so a fixed attribution moves the clip with it.
  function rallyParticipants(entry) {
    var out = [];
    if (!entry || entry.type !== 'RALLY' || entry.voided || entry.invalid) return out;
    var p = entry.players || {}, win = entry.team, lose = E.other(win), o = entry.outcome;
    function add(team, id, role) { if (id) out.push({ team: team, playerId: String(id), role: role }); }
    if (o === 'ATTACK_ERROR') add(lose, p.attacker, 'attacker');
    else if (o === 'BLOCK') add(lose, p.attacker, 'blocked attacker');
    else add(win, p.attacker, 'attacker');
    (p.blockers || []).forEach(function (b) { add(win, b, 'blocker'); });
    add(win, p.assist, 'setter');
    (p.diggers || []).forEach(function (d) { add(win, d, 'defender'); });
    if ((SERVE_POINT[o] || o === 'SERVICE_ERROR') && entry.rallyServer) add(entry.rallyServer.team, entry.rallyServer.playerId, 'server');
    add(lose, p.receiver, 'receiver');
    add(lose, p.errorBy, o === 'SERVICE_ERROR' ? 'server' : 'at fault');
    (entry.actions || []).forEach(function (a) {
      if (a && a.playerId && (a.team === 'A' || a.team === 'B')) add(a.team, a.playerId, String(a.type || 'action').toLowerCase());
    });
    // one entry per player (the first part named wins)
    var seen = {};
    return out.filter(function (x) { var k = x.team + ':' + x.playerId; if (seen[k]) return false; seen[k] = 1; return true; });
  }

  function compute(replayResult) {
    var ns = replayResult.setup;
    var state = replayResult.state;
    var timeline = replayResult.timeline || [];
    var players = {};
    ['A', 'B'].forEach(function (t) {
      ns.teams[t].order.forEach(function (id) { players[id] = blankPlayer(t, ns.teams[t].byId[id]); });
    });
    function P(id) { return id && players[id] ? players[id] : null; }
    var teams = { A: blankTeam(), B: blankTeam() };
    var bySet = {};
    function setTeam(n, t) {
      bySet[n] = bySet[n] || { set: n, A: blankTeam(), B: blankTeam() };
      return bySet[n][t];
    }
    var run = { team: null, n: 0 };

    // who was on court in which set
    state.sets.forEach(function (s) {
      if (!s.lineup) return;
      ['A', 'B'].forEach(function (t) {
        var onCourt = {};
        s.lineup[t].forEach(function (id) { onCourt[id] = 1; var pl = P(id); if (pl) pl.setsStarted += 1; });
        s.subs[t].forEach(function (sub) { sub.pairs.forEach(function (pr) { onCourt[pr.in] = 1; }); });
        Object.keys(onCourt).forEach(function (id) { var pl = P(id); if (pl) { pl.setsPlayed += 1; pl.sets.push(s.number); } });
      });
    });

    timeline.forEach(function (e) {
      if (e.voided || e.invalid || !e.after) return;
      var n = e.after.set || (e.before && e.before.set) || 0;
      if (e.type === 'RALLY') {
        var win = e.team, lose = E.other(win), o = e.outcome || 'GENERAL';
        var def = E.OUTCOMES[o] || E.OUTCOMES.GENERAL;
        var p = e.players || {};
        var ts = [teams[win], setTeam(n, win)];
        ts.forEach(function (x) {
          x.points += 1;
          x.byCategory[def.category] += 1;
          if (e.sideOut) x.sideOutPoints += 1; else x.breakPoints += 1;
        });
        [teams.A, teams.B, setTeam(n, 'A'), setTeam(n, 'B')].forEach(function (x) { x.rallies += 1; });
        // runs
        if (run.team === win) run.n += 1; else { run.team = win; run.n = 1; }
        if (run.n > teams[win].longestRun) teams[win].longestRun = run.n;
        // service — the rally's server (from the rotation)
        var srv = e.rallyServer;
        if (srv && o !== 'PENALTY') {
          var sp = P(srv.playerId);
          [teams[srv.team], setTeam(n, srv.team)].forEach(function (x) { x.serve.attempts += 1; });
          if (sp) sp.serve.attempts += 1;
          if (SERVE_POINT[o]) {
            if (sp) sp.serve.aces += 1;
            [teams[srv.team], setTeam(n, srv.team)].forEach(function (x) { x.serve.aces += 1; });
          }
          if (o === 'SERVICE_ERROR') {
            if (sp) sp.serve.errors += 1;
            [teams[srv.team], setTeam(n, srv.team)].forEach(function (x) { x.serve.errors += 1; });
          }
        }
        if (def.fault === 'loser') [teams[lose], setTeam(n, lose)].forEach(function (x) { x.errorsCommitted += 1; });
        // attack
        var atk = P(p.attacker);
        if ((o === 'ATTACK_KILL' || o === 'BALL_IN') && atk && atk.team === win) {
          atk.attack.kills += 1;
          [teams[win], setTeam(n, win)].forEach(function (x) { x.attack.kills += 1; });
        }
        if (o === 'ATTACK_ERROR' && atk && atk.team === lose) {
          atk.attack.errors += 1;
          [teams[lose], setTeam(n, lose)].forEach(function (x) { x.attack.errors += 1; });
        }
        if (o === 'BLOCK' && atk && atk.team === lose) {
          atk.attack.errors += 1; atk.attack.blocked += 1;
          [teams[lose], setTeam(n, lose)].forEach(function (x) { x.attack.errors += 1; });
        }
        // block
        if (o === 'BLOCK') {
          var bl = (p.blockers || []).map(P).filter(function (x) { return x && x.team === win; });
          if (bl.length === 1) { bl[0].block.solo += 1; bl[0].block.points += 1; }
          else bl.forEach(function (b) { b.block.assists += 1; b.block.points += 1 / bl.length; });
          [teams[win], setTeam(n, win)].forEach(function (x) { x.blockPoints += 1; });
        }
        // assist, digs, reception, faults
        var as = P(p.assist);
        if (as && as.team === win && (o === 'ATTACK_KILL' || o === 'BALL_IN')) as.assists += 1;
        (p.diggers || []).forEach(function (d) { var dp = P(d); if (dp && dp.team === win) dp.digs += 1; });
        var rcv = P(p.receiver) || (o === 'RECEPTION_ERROR' ? P(p.errorBy) : null);
        if (rcv && rcv.team === lose && SERVE_POINT[o]) { rcv.reception.errors += 1; rcv.reception.attempts += 1; }
        var fk = FAULT_KEY[o];
        var eb = P(p.errorBy);
        if (fk && eb && eb.team === lose) eb.faults[fk] += 1;
        // the rally detail (optional, per touch)
        (e.actions || []).forEach(function (a) {
          var ap = a && P(a.playerId);
          if (!ap) return;
          var type = String(a.type || '').toUpperCase(), res = String(a.result || '').toLowerCase();
          if (type === 'ATTACK' && res !== 'kill' && res !== 'error') ap.attack.inPlay += 1;
          else if (type === 'DIG') ap.digs += 1;
          else if (type === 'RECEPTION') { ap.reception.attempts += 1; if (res === 'error') ap.reception.errors += 1; else ap.reception.ok += 1; }
          else if (type === 'SET' && res === 'assist' && !(as && as.playerId === ap.playerId)) ap.assists += 1;
        });
      } else if (e.type === 'REPLAY') {
        [teams.A, teams.B, setTeam(n, 'A'), setTeam(n, 'B')].forEach(function (x) { x.replays += 1; x.rallies += 1; });
      } else if (e.type === 'TIMEOUT') {
        [teams[e.team], setTeam(n, e.team)].forEach(function (x) { x.timeouts += 1; });
      } else if (e.type === 'SUBSTITUTION') {
        (e.pairs || []).forEach(function (pr) {
          var po = P(pr.out), pi = P(pr.in);
          if (po) po.subs.out += 1;
          if (pi) pi.subs.in += 1;
        });
        if (!e.exceptional) [teams[e.team], setTeam(n, e.team)].forEach(function (x) { x.substitutions += (e.pairs || []).length; });
      } else if (e.type === 'LIBERO') {
        if (e.action !== 'out') {
          var lp = P(e.libero);
          if (lp) { lp.liberoEntries += 1; if (lp.sets.indexOf(n) < 0) { lp.sets.push(n); lp.setsPlayed += 1; } }
          [teams[e.team], setTeam(n, e.team)].forEach(function (x) { x.liberoReplacements += 1; });
        }
      } else if (e.type === 'SANCTION') {
        var sp2 = P(e.playerId);
        if (sp2) sp2.sanctions.push(e.kind);
        if (E.SANCTIONS[e.kind] && E.SANCTIONS[e.kind].point) {
          var gets = E.other(e.team);
          [teams[gets], setTeam(n, gets)].forEach(function (x) { x.points += 1; x.byCategory.penalty += 1; });
          [teams[e.team], setTeam(n, e.team)].forEach(function (x) { x.errorsCommitted += 1; });
          if (sp2) sp2.faults.penalty += 1;
          if (run.team === gets) run.n += 1; else { run.team = gets; run.n = 1; }
          if (run.n > teams[gets].longestRun) teams[gets].longestRun = run.n;
        }
      }
      if (e.effects && e.effects.some(function (x) { return x.type === 'SET_WON'; })) run = { team: null, n: 0 };
    });

    // forfeited sets carry points that no rally scored
    state.sets.forEach(function (s) {
      if (!s.forfeit) return;
      ['A', 'B'].forEach(function (t) {
        var scored = bySet[s.number] ? bySet[s.number][t].points : 0;
        var extra = s.points[t] - scored;
        if (extra > 0) { teams[t].points += extra; setTeam(s.number, t).points += extra; setTeam(s.number, t).byCategory.general += extra; teams[t].byCategory.general += extra; }
      });
    });
    teams.A.setsWon = state.setsWon.A; teams.A.setsLost = state.setsWon.B;
    teams.B.setsWon = state.setsWon.B; teams.B.setsLost = state.setsWon.A;

    Object.keys(players).forEach(function (id) {
      var pl = players[id];
      pl.attack.attempts = pl.attack.kills + pl.attack.errors + pl.attack.inPlay;
      pl.attack.efficiency = pl.attack.attempts ? round2((pl.attack.kills - pl.attack.errors) / pl.attack.attempts) : null;
      pl.block.points = round2(pl.block.points);
      pl.points = round2(pl.attack.kills + pl.serve.aces + pl.block.points);
      teams[pl.team].attack.attempts += pl.attack.attempts;
    });
    ['A', 'B'].forEach(function (t) {
      // attempts from the teams' named attackers only (an unnamed kill is a team point, not an attempt we can see)
      teams[t].attack.efficiency = teams[t].attack.attempts ? round2((teams[t].attack.kills - teams[t].attack.errors) / teams[t].attack.attempts) : null;
    });
    return {
      players: players,
      teams: teams,
      bySet: Object.keys(bySet).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return bySet[k]; })
    };
  }

  function pct(v) { return v == null ? '–' : Math.round(v * 100) + '%'; }

  return { compute: compute, rallyParticipants: rallyParticipants, pct: pct };
});
