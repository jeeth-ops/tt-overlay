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

  return {
    BOWLER_CREDITED: BOWLER_CREDITED,
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
