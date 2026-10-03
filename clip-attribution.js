/* ================================================================
   🎯 CLIP ATTRIBUTION — the ONE rule for "which delivery, which players
   does this clip belong to".

   A clip belongs to the delivery that created it, never to whatever the
   live match state looks like when the clip finishes cutting, uploading
   or syncing. Everything here is a pure function of an immutable DELIVERY
   SNAPSHOT taken before the delivery mutated anything (strike rotation,
   over completion, new batsman, next bowler). Nothing in this file ever
   reads live state.

   Used, unchanged, by:
     - server.js (require)            — clip ↔ ball linking, clip ownership
     - cricket-panel.html  (inlined)  — Clipper Helper panel
     - cricket-panel3.html (inlined)  — Stream Engine panel
   The panels carry an inlined copy between the CLIP-ATTRIBUTION markers
   (a panel must keep scoring even if a separate script failed to load);
   test/clip-attribution.test.js fails if any copy drifts from this file.
   Edit THIS file, then run:  node test/clip-attribution.test.js --sync
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClipAttribution = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Dismissals credited to the bowler (Laws 32-39). Run Out / Retired /
  // Obstructing etc. are not.
  var BOWLER_CREDITED = ['Bowled', 'Caught', 'LBW', 'Stumped', 'Hit Wicket'];
  // The only dismissal where the NON-striker can be the one given out.
  var RUN_OUT = 'Run Out';

  function str(v) {
    if (v == null) return null;
    if (typeof v === 'object') return typeof v.name === 'string' ? (v.name.trim() || null) : null;
    var s = String(v).trim();
    return s || null;
  }
  function idOf(v) {
    if (v == null || v === '') return null;
    return String(v);
  }
  function nameKey(v) {
    var s = str(v);
    return s ? s.toLowerCase().replace(/\s+/g, ' ') : null;
  }
  function freeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.keys(o).forEach(function (k) { freeze(o[k]); });
      Object.freeze(o);
    }
    return o;
  }

  // Same player? Ids decide when both sides have one; names otherwise.
  function samePlayer(aId, aName, bId, bName) {
    aId = idOf(aId); bId = idOf(bId);
    if (aId && bId) return aId === bId;
    var a = nameKey(aName), b = nameKey(bName);
    return !!(a && b && a === b);
  }

  // Where the delivery about to be bowled sits, from the COMPLETED count
  // the score holds right now. A legal delivery is ball (balls + 1); the
  // one that reaches ballsPerOver completes the over and is labelled with
  // the over it was bowled in (12.6), never the next over's 13.0. A Wide /
  // No Ball is not a legal delivery and keeps the current position.
  function nextDeliveryPosition(score, ballsPerOver, isLegal) {
    var bpo = Number(ballsPerOver) > 0 ? Number(ballsPerOver) : 6;
    var overs = Math.max(0, Number(score && score.overs) || 0);
    var balls = Math.max(0, Number(score && score.balls) || 0);
    if (!isLegal) return { over: overs, ballInOver: balls, legal: false, completesOver: false };
    var n = balls + 1;
    return { over: overs, ballInOver: n, legal: true, completesOver: n >= bpo };
  }

  // The position of a delivery AFTER it has been applied to the score:
  // used where the score has already moved on (addLegalBall rolled
  // 12.5 → 13.0 for the 6th ball of over 12).
  function appliedDeliveryPosition(scoreAfter, ballsPerOver, overCompleted) {
    var bpo = Number(ballsPerOver) > 0 ? Number(ballsPerOver) : 6;
    var overs = Number(scoreAfter && scoreAfter.overs) || 0;
    var balls = Number(scoreAfter && scoreAfter.balls) || 0;
    if (overCompleted) return { over: Math.max(0, overs - 1), ballInOver: bpo };
    return { over: overs, ballInOver: balls };
  }

  // 📸 The immutable delivery snapshot. Take it BEFORE the delivery is
  // applied. Players are copied by value (name + id) — never a reference
  // to a live batter object that the next state change will reuse.
  function buildDeliverySnapshot(input) {
    input = input || {};
    var p = function (x) { return { id: idOf(x && x.id), name: str(x) || str(x && x.name) }; };
    var striker = p(input.striker), nonStriker = p(input.nonStriker), bowler = p(input.bowler);
    var battingTeam = input.battingTeam || null;
    return freeze({
      deliveryId: input.deliveryId ? String(input.deliveryId) : null,
      matchId: input.matchId || null,
      innings: input.innings == null ? null : Number(input.innings),
      phase: input.phase || null,
      over: input.over == null ? null : Number(input.over),
      ballInOver: input.ballInOver == null ? null : Number(input.ballInOver),
      legal: input.legal == null ? null : !!input.legal,
      battingTeam: battingTeam,
      bowlingTeam: input.bowlingTeam || (battingTeam === 'A' ? 'B' : battingTeam === 'B' ? 'A' : null),
      strikerId: striker.id, strikerName: striker.name,
      nonStrikerId: nonStriker.id, nonStrikerName: nonStriker.name,
      bowlerId: bowler.id, bowlerName: bowler.name,
      timestamp: input.timestamp == null ? null : Number(input.timestamp)
    });
  }

  // Is the crease in `live` still the one the snapshot was taken from?
  // Used to refuse a wicket whose modal was opened before the state moved
  // on (another device scored, a delayed sync arrived, an undo ran).
  function creaseMatches(snapshot, live) {
    if (!snapshot || !live) return true;
    var s = live.striker || {}, n = live.nonStriker || {};
    var strikerOk = !snapshot.strikerName && !snapshot.strikerId ? true : samePlayer(snapshot.strikerId, snapshot.strikerName, s.id, s.name);
    var nonOk = !snapshot.nonStrikerName && !snapshot.nonStrikerId ? true : samePlayer(snapshot.nonStrikerId, snapshot.nonStrikerName, n.id, n.name);
    return strikerOk && nonOk;
  }

  // 🏏 WHO IS OUT. Every dismissal but Run Out is the delivery's striker.
  // A Run Out names its batter explicitly (frozen at confirmation as an id
  // and name); the legacy 'striker'/'nonStriker' position is only a
  // fallback, and is resolved against the SNAPSHOT's crease — never the
  // live one, which may already have rotated.
  function resolveDismissedPlayer(snapshot, dismissal) {
    if (!snapshot || !dismissal) return null;
    var type = dismissal.type || dismissal.dismissalType || 'Bowled';
    var atStriker = { id: snapshot.strikerId, name: snapshot.strikerName, end: 'striker' };
    var atNon = { id: snapshot.nonStrikerId, name: snapshot.nonStrikerName, end: 'nonStriker' };
    if (type !== RUN_OUT) return atStriker;
    var pid = idOf(dismissal.dismissedPlayerId || dismissal.batterId);
    var pname = str(dismissal.dismissedPlayerName || dismissal.batter);
    if (pid || pname) {
      if (samePlayer(pid, pname, atStriker.id, atStriker.name)) return atStriker;
      if (samePlayer(pid, pname, atNon.id, atNon.name)) return atNon;
      // Named, but not one of the two at the crease for this delivery:
      // keep exactly what was named rather than substitute anyone.
      return { id: pid, name: pname, end: null };
    }
    if (dismissal.runOutWho === 'nonStriker') return atNon;
    return atStriker;
  }

  function eventTypeFor(event) {
    var et = String((event && (event.clipType || event.eventType)) || '').toUpperCase();
    if (et) return et;
    var kind = event && event.kind;
    if (kind === 'W' || kind === 'WdW' || kind === 'NbW') return 'WICKET';
    if (kind === '4') return 'FOUR';
    if (kind === '6') return 'SIX';
    return 'CLIP';
  }

  // 🎯 THE resolver. Who owns this clip, from the delivery snapshot only.
  //   FOUR / SIX / boundary extra / any other clip → batsman = striker
  //   WICKET → batsman = dismissed player (striker, or the named Run Out
  //            batter), bowler = delivery bowler, fielder = as entered
  function resolveClipParticipants(snapshot, event) {
    snapshot = snapshot || {};
    event = event || {};
    var clipType = eventTypeFor(event);
    var d = event.dismissal || null;
    var isWicket = clipType === 'WICKET' && !!d && !/retired/i.test(String(d.type || ''));
    var dismissed = isWicket ? resolveDismissedPlayer(snapshot, d) : null;
    var type = isWicket ? (d.type || 'Bowled') : null;
    var batsman = dismissed || { id: snapshot.strikerId, name: snapshot.strikerName };
    return freeze({
      deliveryId: snapshot.deliveryId || null,
      innings: snapshot.innings, over: snapshot.over, ballInOver: snapshot.ballInOver,
      battingTeam: snapshot.battingTeam || null, bowlingTeam: snapshot.bowlingTeam || null,
      clipType: clipType,
      batsmanId: batsman.id || null, batsmanName: batsman.name || null,
      strikerId: snapshot.strikerId || null, strikerName: snapshot.strikerName || null,
      nonStrikerId: snapshot.nonStrikerId || null, nonStrikerName: snapshot.nonStrikerName || null,
      bowlerId: snapshot.bowlerId || null, bowlerName: snapshot.bowlerName || null,
      dismissalType: type,
      dismissedPlayerId: dismissed ? (dismissed.id || null) : null,
      dismissedPlayerName: dismissed ? (dismissed.name || null) : null,
      dismissedEnd: dismissed ? (dismissed.end || null) : null,
      fielderId: isWicket ? (idOf(d.fielderId) || null) : null,
      fielderName: isWicket ? (str(d.fielder || d.fielderName) || null) : null,
      bowlerCredited: isWicket ? BOWLER_CREDITED.indexOf(type) !== -1 : false
    });
  }

  // The ballMeta every clip request / clip-meta / classification carries:
  // the shape the helper, the Stream Engine and the website already read
  // (striker/nonStriker/bowler + ids + dismissal), plus the explicit
  // owner fields (deliveryId, batsman*, dismissedPlayer*).
  function clipBallMeta(participants, extra) {
    var c = participants || {};
    var meta = {
      deliveryId: c.deliveryId || null,
      innings: c.innings, over: c.over, ballInOver: c.ballInOver,
      battingTeam: c.battingTeam || null, bowlingTeam: c.bowlingTeam || null,
      striker: c.strikerName || null, nonStriker: c.nonStrikerName || null, bowler: c.bowlerName || null,
      strikerId: c.strikerId || null, nonStrikerId: c.nonStrikerId || null, bowlerId: c.bowlerId || null,
      batsman: c.batsmanName || null, batsmanId: c.batsmanId || null,
      dismissedPlayer: c.dismissedPlayerName || null, dismissedPlayerId: c.dismissedPlayerId || null,
      dismissal: c.dismissalType ? {
        type: c.dismissalType,
        fielder: c.fielderName || null, fielderId: c.fielderId || null,
        batter: c.dismissedPlayerName || null, batterId: c.dismissedPlayerId || null
      } : null
    };
    if (extra) Object.keys(extra).forEach(function (k) { meta[k] = extra[k]; });
    return meta;
  }

  // Owner of an already-stored clip / ballMeta / clip doc, for readers
  // that only have the stored fields. A wicket clip belongs to the batter
  // who was given out; legacy docs with no dismissed player fall back to
  // the striker (correct for every dismissal but a non-striker Run Out).
  function clipOwner(meta) {
    meta = meta || {};
    var et = String(meta.eventType || meta.clipType || '').toUpperCase();
    var d = meta.dismissal || null;
    var dismissedName = str(meta.dismissedPlayer || meta.dismissedPlayerName || (d && d.batter));
    var dismissedId = idOf(meta.dismissedPlayerId || (d && d.batterId));
    var strikerName = str(meta.striker || meta.strikerName);
    var strikerId = idOf(meta.strikerId);
    if (et === 'WICKET' && (dismissedName || dismissedId)) return { name: dismissedName || null, id: dismissedId || null, role: 'dismissed' };
    return { name: strikerName || null, id: strikerId || null, role: 'striker' };
  }

  // Is a stored ball row the SAME delivery an event's ballMeta describes?
  // deliveryId decides when both have one. Otherwise over/ball alone is
  // not enough (a Wide shares its over.ball with the ball before it), so
  // the striker must agree too, and a wicket event needs a wicket ball.
  function sameDelivery(ball, ballMeta, eventType) {
    if (!ball || !ballMeta) return false;
    var did = ballMeta.deliveryId || ballMeta.ballUid || null;
    if (did && ball.ballUid) return String(ball.ballUid) === String(did);
    if (ballMeta.innings != null && ball.innings != null && Number(ballMeta.innings) !== Number(ball.innings)) return false;
    if (ballMeta.over != null && Number(ballMeta.over) !== Number(ball.over)) return false;
    if (ballMeta.ballInOver != null && Number(ballMeta.ballInOver) !== Number(ball.ballInOver)) return false;
    if ((ballMeta.strikerId || str(ballMeta.striker)) && (ball.strikerId || str(ball.striker))) {
      if (!samePlayer(ballMeta.strikerId, ballMeta.striker, ball.strikerId, ball.striker)) return false;
    }
    if (String(eventType || '').toUpperCase() === 'WICKET' && !ball.dismissal) return false;
    return true;
  }

  // 🎬 What a clip of this delivery IS, from the stored ball row
  // ({ kind, runs, dismissal }) — the same buckets the live panel uses when
  // it cuts or classifies a clip (describeBallOutcome). Used when an owner
  // correction changes the delivery, so its clip follows (4 → 6, 6 → W…).
  function clipEventForBall(ball) {
    ball = ball || {};
    var kind = String(ball.kind == null ? '' : ball.kind);
    var runs = Number(ball.runs) || 0;
    var d = ball.dismissal || null;
    if (d && !/retired/i.test(String(d.type || ''))) {
      var on = kind === 'Wd' ? ' (Wide)' : kind === 'Nb' ? ' (No Ball)' : '';
      return { eventType: 'WICKET', outcomeLabel: 'WICKET — ' + (d.type || 'Out') + on, defaultHighlight: true };
    }
    var plural = function (n) { return n === 1 ? '' : 's'; };
    switch (kind) {
      case '4': return { eventType: 'FOUR', outcomeLabel: 'FOUR', defaultHighlight: true };
      case '6': return { eventType: 'SIX', outcomeLabel: 'SIX', defaultHighlight: true };
      case '0': return { eventType: 'CLIP', outcomeLabel: 'Dot ball', defaultHighlight: false };
      case 'Wd': {
        var x = Math.max(0, runs - 1);
        if (x >= 6) return { eventType: 'SIX', outcomeLabel: 'Wide 6', defaultHighlight: true };
        if (x === 4) return { eventType: 'FOUR', outcomeLabel: 'Wide 4', defaultHighlight: true };
        return { eventType: 'CLIP', outcomeLabel: x ? 'Wide +' + x : 'Wide', defaultHighlight: false };
      }
      case 'Nb': {
        var bat = Math.max(0, runs - 1);
        if (bat === 6) return { eventType: 'SIX', outcomeLabel: 'No Ball 6', defaultHighlight: true };
        if (bat === 4) return { eventType: 'FOUR', outcomeLabel: 'No Ball 4', defaultHighlight: true };
        return { eventType: 'CLIP', outcomeLabel: bat ? 'No Ball +' + bat : 'No Ball', defaultHighlight: false };
      }
      case 'B': return { eventType: 'CLIP', outcomeLabel: 'Bye ' + runs, defaultHighlight: runs === 4 };
      case 'LB': return { eventType: 'CLIP', outcomeLabel: 'Leg Bye ' + runs, defaultHighlight: runs === 4 };
      case 'OT':
        if (runs >= 6) return { eventType: 'SIX', outcomeLabel: 'Overthrow ' + runs, defaultHighlight: true };
        if (runs >= 4) return { eventType: 'FOUR', outcomeLabel: 'Overthrow ' + runs, defaultHighlight: true };
        return { eventType: 'CLIP', outcomeLabel: 'Overthrow ' + runs, defaultHighlight: false };
      default:
        return { eventType: 'CLIP', outcomeLabel: runs + ' run' + plural(runs), defaultHighlight: false };
    }
  }

  // 🛠 An owner correction of a past delivery, applied to a LIVE panel's
  // own state. The server already rebuilt the authoritative record from
  // the ball log; the panel holds running totals of its own (the live
  // scorecard reads them), so it receives the correction as per-player
  // DIFFERENCES computed by the server's scoring rules and adds them in.
  // Never recomputes anything itself and never touches who is at the
  // crease or who is bowling now — only the figures that delivery fed.
  //
  // Idempotent by ev.id (kept in state.appliedCorrections, which travels
  // with the state between devices), so a re-delivered event, a second
  // device or a reconnect replay can never apply it twice.
  //
  // ev: { id, innings, battingTeam, deliveryId, overLabel, legalChanged,
  //       before: {…ball}, after: {…ball},
  //       delta: { team: { runs, wickets, extras: { wd, nb, b, lb } },
  //                batting: [{ name, runs, balls, fours, sixes, outBefore, outAfter, howOut, dismissalType, fielderName, bowlerName }],
  //                bowling: [{ name, balls, runs, wickets }] } }
  // Returns { applied, duplicate, warnings: [] }.
  function applyDeliveryCorrection(state, ev, opts) {
    var res = { applied: false, duplicate: false, warnings: [] };
    if (!state || !ev || !ev.id) return res;
    opts = opts || {};
    var bpo = Number(opts.ballsPerOver) > 0 ? Number(opts.ballsPerOver) : 6;
    if (!Array.isArray(state.appliedCorrections)) state.appliedCorrections = [];
    if (state.appliedCorrections.indexOf(ev.id) !== -1) { res.duplicate = true; return res; }
    var label = ev.overLabel ? 'ball ' + ev.overLabel : 'an earlier ball';
    if (ev.legalChanged) {
      // A legal ball became a Wide/No Ball (or back): every later ball's
      // position in its over moves. That cannot be patched into running
      // totals safely — the record is right; the panel needs a reload.
      res.warnings.push('The correction to ' + label + ' changed whether it was a legal ball. The website scorecard is updated; reload this panel before scoring on.');
      state.appliedCorrections.push(ev.id);
      return res;
    }
    var inn = Number(ev.innings) || 1;
    var bt = ev.battingTeam === 'B' ? 'B' : 'A';
    var bowlT = bt === 'A' ? 'B' : 'A';
    var d = ev.delta || {};
    var team = d.team || {};
    var isCurrent = Number(state.inningsNumber || 1) === inn && state.battingTeam === bt;
    var same = function (a, b) { return !!(nameKey(a) && nameKey(a) === nameKey(b)); };
    var findRow = function (list, name) {
      list = Array.isArray(list) ? list : [];
      for (var i = list.length - 1; i >= 0; i--) {
        if (same(list[i].name, name) && (list[i].inningsNo == null || Number(list[i].inningsNo) === inn)) return list[i];
      }
      return null;
    };
    var add = function (obj, k, v) { if (v) obj[k] = Math.max(0, (Number(obj[k]) || 0) + v); };

    // Team total / wickets.
    if (team.runs || team.wickets) {
      if (isCurrent && state.score) { add(state.score, 'runs', team.runs); add(state.score, 'wickets', team.wickets); }
      else {
        var arch = (state.inningsArchive || []).filter(function (a) { return Number(a.no) === inn; })[0];
        if (arch) { add(arch, 'runs', team.runs); add(arch, 'wickets', team.wickets); }
      }
    }
    if (team.extras && state.extras && state.extras[bt]) {
      Object.keys(team.extras).forEach(function (k) { add(state.extras[bt], k, team.extras[k]); });
    }

    // Batting figures — the live tile when that batter is at the crease in
    // this innings, otherwise their scorecard row.
    (d.batting || []).forEach(function (r) {
      var tile = null;
      if (isCurrent && state.striker && same(state.striker.name, r.name)) tile = state.striker;
      else if (isCurrent && state.nonStriker && same(state.nonStriker.name, r.name)) tile = state.nonStriker;
      var row = tile || findRow(state.battingCard && state.battingCard[bt], r.name);
      var moves = r.runs || r.balls || r.fours || r.sixes;
      if (!row) { if (moves) res.warnings.push(r.name + "'s batting figures for " + label + ' are not on this panel — check the batting card.'); }
      else { add(row, 'runs', r.runs); add(row, 'balls', r.balls); add(row, 'fours', r.fours); add(row, 'sixes', r.sixes); }
      if (r.outBefore !== r.outAfter) {
        res.warnings.push('The batter given out on ' + label + ' changed (' + r.name + (r.outAfter ? ' is now out' : ' is no longer out') + '). Check the batting card and who is at the crease.');
      } else if (r.outAfter && row && row.out) {
        if (r.howOut) row.howOut = r.howOut;
        if (r.dismissalType) row.dismissalType = r.dismissalType;
        row.fielderName = r.fielderName || null;
        row.bowlerName = r.bowlerName || null;
      }
    });

    // Bowling figures — the live bowler tile or the bowler's card row.
    (d.bowling || []).forEach(function (r) {
      var tile = isCurrent && state.bowler && same(state.bowler.name, r.name) ? state.bowler : null;
      var row = tile || findRow(state.bowlingCard && state.bowlingCard[bowlT], r.name);
      if (!row) { if (r.balls || r.runs || r.wickets) res.warnings.push(r.name + "'s bowling figures for " + label + ' are not on this panel — check the bowling card.'); return; }
      add(row, 'runs', r.runs);
      add(row, 'wickets', r.wickets);
      if (r.balls) {
        var total = Math.max(0, (Number(row.overs) || 0) * bpo + (Number(row.balls) || 0) + r.balls);
        row.overs = Math.floor(total / bpo); row.balls = total % bpo;
      }
    });
    if (team.wickets) res.warnings.push('A wicket was added or removed on ' + label + ' — check the fall of wickets and the batters at the crease.');

    // The panel's own ball log row for that delivery.
    var a = ev.after || {};
    var log = Array.isArray(state.ballLog) ? state.ballLog : [];
    var entry = null;
    for (var i = log.length - 1; i >= 0 && !entry; i--) {
      var e = log[i];
      if (ev.deliveryId && e.deliveryId === ev.deliveryId) entry = e;
      else if (!ev.deliveryId && Number(e.innings || 1) === inn && e.over === ev.overLabel && ev.before && same(e.striker, ev.before.striker)) entry = e;
    }
    if (entry) {
      var dis = a.dismissal || null;
      entry.ballType = a.kind === 'Wd' && dis ? 'WdW' : a.kind === 'Nb' && dis ? 'NbW' : a.kind;
      if (typeof a.runs === 'number') entry.runs = a.runs;
      entry.striker = a.striker || entry.striker;
      entry.nonStriker = a.nonStriker || entry.nonStriker;
      entry.bowler = a.bowler || entry.bowler;
      entry.isWicket = !!dis;
      entry.dismissalType = dis ? (dis.type || null) : null;
      entry.fielderName = dis ? (dis.fielder || null) : null;
      entry.dismissedPlayer = dis ? (dis.batter || null) : null;
      entry.correctedAt = Date.now();
    }

    state.appliedCorrections.push(ev.id);
    if (state.appliedCorrections.length > 200) state.appliedCorrections = state.appliedCorrections.slice(-200);
    res.applied = true;
    return res;
  }

  return {
    BOWLER_CREDITED: BOWLER_CREDITED,
    clipEventForBall: clipEventForBall,
    applyDeliveryCorrection: applyDeliveryCorrection,
    samePlayer: samePlayer,
    nextDeliveryPosition: nextDeliveryPosition,
    appliedDeliveryPosition: appliedDeliveryPosition,
    buildDeliverySnapshot: buildDeliverySnapshot,
    creaseMatches: creaseMatches,
    resolveDismissedPlayer: resolveDismissedPlayer,
    resolveClipParticipants: resolveClipParticipants,
    clipBallMeta: clipBallMeta,
    clipOwner: clipOwner,
    sameDelivery: sameDelivery
  };
});
