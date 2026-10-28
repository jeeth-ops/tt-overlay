/* ================================================================
   🎬 VOLLEYBALL BROADCAST GRAPHICS — what is on air, and for how long.
   Pure functions: no database and no clock of their own (`now` is passed
   in). The server is the one authority (volleyball-server.js keeps the
   state on the match and ends a timed graphic itself); the overlay and
   the panels load the same file for the scene list, the labels and the
   timing, so all of them agree.

   A match has ONE on-air state:
     { seq, id, scene, data, startedAt, readyAt, durationSec, expiresAt,
       swapAt, speed, clean, reqId, endedId, endedScene, reason }
   scene null = the live score overlay is up (or, with clean, nothing).

   A standalone graphic takes the screen: the score bar leaves first
   (BAR_OUT_MS), the graphic comes in (its enterMs), and a finite time on
   screen counts only from then (readyAt) — a slow entrance never eats
   into it. When the graphic ends (dismissed, timed out, replaced by
   another) the overlay brings the live score back with its own entrance,
   showing the score as it is NOW.
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VolleyballGraphics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BAR_OUT_MS = 700;      // the score bar leaves before a graphic comes in
  var GFX_OUT_MS = 650;      // a graphic leaves before the next one comes in
  var LINEUP_SWAP_MS = 1500; // starting six: team one hands the screen to team two
  var MAX_SEC = 600;         // the longest finite time on screen

  // group: where the panels list it. def: seconds on screen when the
  // operator does not say (null = until dismissed). enterMs: how long its
  // entrance takes at normal speed — the overlay's choreography fits in it.
  var SCENES = {
    intro: { label: 'Match intro', group: 'pre', enterMs: 2100, def: 15 },
    toss: { label: 'Coin toss', group: 'pre', enterMs: 1900, def: 10 },
    lineup: { label: 'Starting six', group: 'pre', enterMs: 1800, def: 12 },
    setStart: { label: 'Set start', group: 'play', enterMs: 1400, def: 7 },
    rotation: { label: 'Rotation', group: 'play', enterMs: 1500, def: 12 },
    timeout: { label: 'Time-out', group: 'play', enterMs: 1300, def: null },
    playerStat: { label: 'Player card', group: 'play', enterMs: 1500, def: 10 },
    setSummary: { label: 'Set result', group: 'after', enterMs: 1700, def: 12 },
    final: { label: 'Match result', group: 'after', enterMs: 2100, def: null },
    scorecard: { label: 'Match statistics', group: 'after', enterMs: 1900, def: null },
    standings: { label: 'Points table', group: 'after', enterMs: 2000, def: 20 }
  };
  var ORDER = ['intro', 'toss', 'lineup', 'setStart', 'rotation', 'timeout', 'playerStat', 'setSummary', 'final', 'scorecard', 'standings'];
  var GROUPS = { pre: 'Before the match', play: 'During play', after: 'After a set / the match' };

  /* ---------- the look, shared by every match of a tournament ---------- */
  var FONTS = {
    barlow: { label: 'Barlow Condensed', family: 'Barlow Condensed', css: 'Barlow+Condensed:ital,wght@0,500;0,600;0,700;0,800;1,700;1,800' },
    oswald: { label: 'Oswald', family: 'Oswald', css: 'Oswald:wght@500;600;700' },
    saira: { label: 'Saira Condensed', family: 'Saira Condensed', css: 'Saira+Condensed:wght@500;600;700;800' },
    roboto: { label: 'Roboto Condensed', family: 'Roboto Condensed', css: 'Roboto+Condensed:ital,wght@0,500;0,600;0,700;0,800;1,700' }
  };
  var BACKDROPS = { scrim: 'Darkened picture', solid: 'Designed background (opaque)', clear: 'No background' };
  var SPEEDS = { 0.8: 'Snappy', 1: 'Standard', 1.25: 'Calm' };
  var STYLE_DEFAULTS = {
    accent: '#ffd60a', base: '#0a1136', backdrop: 'scrim', dim: 0.78, font: 'barlow', speed: 1,
    plates: 'auto', names: 'auto', pointTags: true, setHistory: true, layout: 'bar', durations: {}
  };

  function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 120); }
  function hex(v, d) { var s = String(v || '').trim(); return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : d; }
  function pick(v, allowed, d) { return Object.prototype.hasOwnProperty.call(allowed, v) ? v : d; }
  // seconds on screen: 1…600, or null = until dismissed; undefined = not a valid answer
  function parseDuration(v) {
    if (v === null || v === 'hold' || v === 0 || v === '0') return null;
    var n = Math.round(Number(v));
    return isFinite(n) && n >= 1 && n <= MAX_SEC ? n : undefined;
  }
  var BAD_TIME = 'Time on screen must be 1–' + MAX_SEC + ' seconds, or Hold';

  function normalizeStyle(s) {
    s = s && typeof s === 'object' ? s : {};
    var d = STYLE_DEFAULTS;
    var dim = Number(s.dim);
    var speed = Number(s.speed);
    var durations = {};
    var src = s.durations && typeof s.durations === 'object' ? s.durations : {};
    ORDER.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) return;
      var v = parseDuration(src[k]);
      if (v !== undefined) durations[k] = v;
    });
    return {
      accent: hex(s.accent, d.accent), base: hex(s.base, d.base),
      backdrop: pick(s.backdrop, BACKDROPS, d.backdrop),
      dim: isFinite(dim) ? Math.max(0.3, Math.min(0.95, Math.round(dim * 100) / 100)) : d.dim,
      font: pick(s.font, FONTS, d.font),
      speed: SPEEDS[speed] ? speed : d.speed,
      plates: s.plates === 'light' || s.plates === 'dark' ? s.plates : 'auto',
      names: s.names === 'short' || s.names === 'full' ? s.names : 'auto',
      pointTags: s.pointTags !== false, setHistory: s.setHistory !== false,
      layout: s.layout === 'compact' ? 'compact' : 'bar',
      durations: durations
    };
  }
  // seconds on screen for a graphic nobody gave a time to
  function defaultDuration(scene, style) {
    var st = style && style.durations ? style.durations : {};
    if (Object.prototype.hasOwnProperty.call(st, scene)) return st[scene];
    return SCENES[scene] ? SCENES[scene].def : null;
  }

  /* ---------- what each graphic may be asked to show ---------- */
  function cleanData(scene, d) {
    d = d && typeof d === 'object' ? d : {};
    var set = Math.round(Number(d.set));
    var out = {};
    if ((scene === 'toss' || scene === 'lineup' || scene === 'setStart' || scene === 'setSummary') && set >= 1 && set <= 9) out.set = set;
    if (scene === 'lineup' && (d.team === 'A' || d.team === 'B')) out.team = d.team;
    if (scene === 'playerStat') out.playerId = str(d.playerId, 64);
    if (scene === 'standings' && d.group != null && str(d.group, 12)) out.group = str(d.group, 12);
    return out;
  }
  function sameData(a, b) {
    var ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
    if (ka.join() !== kb.join()) return false;
    for (var i = 0; i < ka.length; i++) if (String(a[ka[i]]) !== String(b[ka[i]])) return false;
    return true;
  }

  /* ---------- the on-air state ---------- */
  function idle(seq) { return { seq: seq || 0, id: null, scene: null, clean: false, reason: 'idle' }; }
  function offAir(prev, seq, reason, clean) {
    return {
      seq: seq, id: null, scene: null, clean: !!clean, reason: reason,
      endedId: prev && prev.scene ? prev.id : null, endedScene: prev && prev.scene ? prev.scene : null
    };
  }
  // the two teams of a starting six: team one until swapAt, then team two
  function bothTeams(g) { return g.scene === 'lineup' && !g.data.team; }
  function lineupTimes(g, dur, now) {
    var swap = Math.round(LINEUP_SWAP_MS * g.speed);
    var swapped = g.swapAt != null && now >= g.swapAt;
    if (!swapped) {
      if (dur == null) return { swapAt: null, expiresAt: null };
      var swapAt = Math.max(now, g.readyAt) + dur * 1000;
      return { swapAt: swapAt, expiresAt: swapAt + swap + dur * 1000 };
    }
    return { swapAt: g.swapAt, expiresAt: dur == null ? null : Math.max(now, g.swapAt + swap) + dur * 1000 };
  }
  function timesFor(g, dur, now) {
    if (bothTeams(g)) return lineupTimes(g, dur, now);
    return { swapAt: null, expiresAt: dur == null ? null : Math.max(now, g.readyAt) + dur * 1000 };
  }

  /* One command against the state on air (pure: `cur` is never changed).
       { action: 'take', scene, data, durationSec?, reqId? }  a graphic on air (replaces any)
       { action: 'stop', id? }      the graphic off — the live score returns
       { action: 'live' }           nothing but the live score (also ends "hide everything")
       { action: 'clean' }          hide everything, the score bar too
       { action: 'next', id? }      starting six of both teams: team two now
       { action: 'duration', id?, durationSec }  a new time on screen, from now
     The older panels' { scene } is still understood (scorebug = live, none = clean).
     opts: { style, nextSeq(), check(scene, data) → { error } | { data, untilAt } }
     → { ok, next (the new state, or null when nothing changes), error, stale, same } */
  function applyCommand(cur, cmd, opts, now) {
    cur = cur && typeof cur === 'object' ? cur : idle();
    cmd = cmd && typeof cmd === 'object' ? cmd : {};
    opts = opts || {};
    var style = normalizeStyle(opts.style);
    var seq = function () { return opts.nextSeq ? opts.nextSeq() : (cur.seq || 0) + 1; };
    var on = cur.scene ? cur : null;
    var action = cmd.action;
    if (!action) {
      if (cmd.scene === 'scorebug') action = 'live';
      else if (cmd.scene === 'none') action = 'clean';
      else {
        action = 'take';
        cmd = { action: 'take', scene: cmd.scene, data: cmd.data, reqId: cmd.reqId, durationSec: Number(cmd.durationSec) > 0 ? cmd.durationSec : undefined };
      }
    }
    var aimed = function () { return on && (!cmd.id || cmd.id === on.id); };

    if (action === 'take') {
      var def = SCENES[cmd.scene];
      if (!def) return { ok: false, next: null, error: 'Unknown graphic' };
      var reqId = str(cmd.reqId, 64) || null;
      if (on && reqId && on.reqId === reqId) return { ok: true, next: null, same: true };   // the same press, retried
      var data = cleanData(cmd.scene, cmd.data);
      var chk = opts.check ? opts.check(cmd.scene, data) : null;
      if (chk && chk.error) return { ok: false, next: null, error: chk.error };
      if (chk && chk.data) data = chk.data;
      var dur = cmd.durationSec === undefined ? defaultDuration(cmd.scene, style) : parseDuration(cmd.durationSec);
      if (dur === undefined) return { ok: false, next: null, error: BAD_TIME };
      // the same graphic pressed again while it is up stays up — no second entrance
      if (on && on.scene === cmd.scene && sameData(on.data, data)) {
        if (cmd.durationSec === undefined || dur === on.durationSec) return { ok: true, next: null, same: true };
        return applyCommand(cur, { action: 'duration', id: on.id, durationSec: cmd.durationSec }, opts, now);
      }
      var k = style.speed;
      var s = seq();
      var g = {
        seq: s, id: 'g' + s.toString(36), scene: cmd.scene, data: data, startedAt: now,
        // from a graphic to a graphic (or from a hidden bar) only the old graphic has to leave
        readyAt: now + Math.round(((on ? GFX_OUT_MS : cur.clean ? 0 : BAR_OUT_MS) + def.enterMs) * k),
        durationSec: dur, expiresAt: null, swapAt: null, speed: k, clean: false, reqId: reqId,
        endedId: on ? on.id : null, endedScene: on ? on.scene : null, reason: 'take'
      };
      var t = timesFor(g, dur, now);
      g.swapAt = t.swapAt; g.expiresAt = t.expiresAt;
      // a graphic about a moment (a time-out) ends with it, unless told otherwise
      if (chk && chk.untilAt && cmd.durationSec === undefined) { g.expiresAt = Math.max(g.readyAt + 3000, chk.untilAt); g.durationSec = Math.round((g.expiresAt - g.readyAt) / 1000); g.until = true; }
      return { ok: true, next: g };
    }
    if (action === 'stop') {
      if (!on) return { ok: true, next: null };                 // already off air
      if (!aimed()) return { ok: false, next: null, stale: true, error: 'Another graphic is on air now' };
      return { ok: true, next: offAir(on, seq(), str(cmd.reason, 24) || 'stopped', false) };
    }
    if (action === 'live') {
      if (!on && !cur.clean) return { ok: true, next: null };
      return { ok: true, next: offAir(on, seq(), 'live', false) };
    }
    if (action === 'clean') {
      if (!on && cur.clean) return { ok: true, next: null };
      return { ok: true, next: offAir(on, seq(), 'clean', true) };
    }
    if (action === 'next') {
      if (!aimed() || !bothTeams(on)) return { ok: false, next: null, stale: true, error: 'The starting six of both teams is not on air' };
      if (on.swapAt != null && now >= on.swapAt) return { ok: true, next: null };   // team two is already up
      var swap = Math.round(LINEUP_SWAP_MS * on.speed);
      return { ok: true, next: Object.assign({}, on, { seq: seq(), swapAt: Math.max(now, on.readyAt), expiresAt: on.durationSec == null ? null : Math.max(now, on.readyAt) + swap + on.durationSec * 1000, reason: 'next' }) };
    }
    if (action === 'duration') {
      if (!aimed()) return { ok: false, next: null, stale: true, error: 'That graphic is not on air' };
      var d2 = parseDuration(cmd.durationSec);
      if (d2 === undefined) return { ok: false, next: null, error: BAD_TIME };
      var g2 = Object.assign({}, on, { seq: seq(), durationSec: d2, until: false, reason: 'duration' });
      var t2 = timesFor(g2, d2, now);
      g2.swapAt = t2.swapAt; g2.expiresAt = t2.expiresAt;
      return { ok: true, next: g2 };
    }
    return { ok: false, next: null, error: 'Unknown command' };
  }
  // A timed graphic whose time is up is off air (the server's timer does
  // this as it happens; this catches one that ran out while it was down).
  function settle(cur, now, nextSeq) {
    if (cur && cur.scene && cur.expiresAt != null && now >= cur.expiresAt) return offAir(cur, nextSeq ? nextSeq() : (cur.seq || 0) + 1, 'expired', false);
    return null;
  }
  // The time-out being taken right now, from the match timeline: the
  // latest one with no rally (or set start) after it, while its seconds
  // last — or a technical time-out (a competition option, 60 s) called by
  // the last rally. null when play is on.
  var TECHNICAL_SECONDS = 60;
  function runningTimeout(timeline, rules, now) {
    var secs = (rules && rules.timeoutSeconds) || 30;
    for (var i = (timeline || []).length - 1; i >= 0; i--) {
      var e = timeline[i];
      if (!e || e.voided || e.invalid) continue;
      if (e.type === 'RALLY') {
        var tto = (e.effects || []).filter(function (x) { return x && x.type === 'TECHNICAL_TIMEOUT'; })[0];
        if (!tto || !e.at) return null;
        var tEnd = e.at + TECHNICAL_SECONDS * 1000;
        return now < tEnd ? { team: null, technical: true, at: e.at, endsAt: tEnd, seconds: TECHNICAL_SECONDS, lead: tto.at } : null;
      }
      if (e.type === 'SET_START') return null;
      if (e.type === 'TIMEOUT') {
        if (!e.at) return null;
        var end = e.at + secs * 1000;
        return now < end ? { team: e.team, technical: false, at: e.at, endsAt: end, seconds: secs } : null;
      }
    }
    return null;
  }
  // which team of a starting six is up at `now` (the first, then the second)
  function lineupTeamAt(g, now, order) {
    if (!g || g.scene !== 'lineup') return null;
    if (g.data && g.data.team) return g.data.team;
    return g.swapAt != null && now >= g.swapAt ? order[1] : order[0];
  }
  function publicState(cur, now) {
    var g = Object.assign({}, cur || idle());
    delete g.reqId;
    g.serverNow = now;
    if (g.scene) g.label = SCENES[g.scene] ? SCENES[g.scene].label : g.scene;
    g.timing = { barOutMs: BAR_OUT_MS, gfxOutMs: GFX_OUT_MS, swapMs: LINEUP_SWAP_MS, enterMs: g.scene && SCENES[g.scene] ? SCENES[g.scene].enterMs : 0 };
    return g;
  }

  return {
    SCENES: SCENES, ORDER: ORDER, GROUPS: GROUPS, FONTS: FONTS, BACKDROPS: BACKDROPS, SPEEDS: SPEEDS, STYLE_DEFAULTS: STYLE_DEFAULTS,
    BAR_OUT_MS: BAR_OUT_MS, GFX_OUT_MS: GFX_OUT_MS, LINEUP_SWAP_MS: LINEUP_SWAP_MS, MAX_SEC: MAX_SEC, BAD_TIME: BAD_TIME,
    normalizeStyle: normalizeStyle, defaultDuration: defaultDuration, parseDuration: parseDuration, cleanData: cleanData,
    applyCommand: applyCommand, settle: settle, idle: idle, lineupTeamAt: lineupTeamAt, publicState: publicState,
    runningTimeout: runningTimeout, TECHNICAL_SECONDS: TECHNICAL_SECONDS
  };
});
