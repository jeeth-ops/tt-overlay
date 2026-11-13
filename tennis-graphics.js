/* ================================================================
   🎬 TENNIS BROADCAST GRAPHICS — what is on air, and for how long.
   Pure functions: no database and no clock of their own (`now` is passed
   in). The server is the one authority (tennis-server.js keeps the state
   on the match and ends timed graphics itself); the overlay and the panel
   load the same file for the scene list, the labels and the timing, so
   all of them agree.

   A match has ONE on-air state, in four layers:
     live    the score bug ('bug' — the corner score bug of a tennis
             broadcast — or 'bar', a wide lower bar): 'auto' = back after
             every graphic; 'manual' = exactly what the operator took on
             air (or none), which no point and no timer brings back.
     scene   a standalone graphic that takes the screen (match intro,
             player cards, toss, set winner, match result, statistics …):
             the score bug leaves first, the graphic comes in, its time on
             screen counts from the end of its entrance.
     lower   a lower third (a player's name, a statistic, an announcement,
             a scrolling ticker) — alongside the score bug; a scene takes
             the screen from it.
     moment  a short call-out on the score bug — ACE, DOUBLE FAULT, BREAK
             POINT, BREAK OF SERVE, SET POINT, MATCH POINT, SET / MATCH /
             TIE-BREAK WON … — put on air ONCE per event that earned it
             (its id is the event's), automatically when the tournament
             says so (per kind), or by hand. A repeated update, a
             reconnect, a reload never plays it a second time.
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TennisGraphics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BAR_OUT_MS = 650;      // the score bug leaves before a scene comes in
  var GFX_OUT_MS = 650;      // a scene leaves before the next one comes in
  var MAX_SEC = 600;

  // group: where the panel lists it. def: seconds on screen when the
  // operator does not say (null = until dismissed). enterMs: its entrance
  // at normal speed (the overlay's choreography fits in it).
  var SCENES = {
    intro:       { label: 'Match introduction', group: 'pre', enterMs: 2400, def: 15 },
    teams:       { label: 'Doubles teams', group: 'pre', enterMs: 2200, def: 12 },
    player:      { label: 'Player introduction', group: 'pre', enterMs: 1900, def: 10 },
    compare:     { label: 'Player comparison', group: 'pre', enterMs: 2100, def: 14 },
    toss:        { label: 'Toss result', group: 'pre', enterMs: 1600, def: 8 },
    server:      { label: 'First server', group: 'pre', enterMs: 1400, def: 6 },
    start:       { label: 'Match starting', group: 'pre', enterMs: 1700, def: 6 },
    tournament:  { label: 'Tournament', group: 'pre', enterMs: 1900, def: 12 },
    setScore:    { label: 'Set score', group: 'play', enterMs: 1600, def: 10 },
    setWinner:   { label: 'Set winner', group: 'play', enterMs: 1900, def: 10 },
    tiebreak:    { label: 'Tie-break', group: 'play', enterMs: 1400, def: 6 },
    breakPoint:  { label: 'Break point', group: 'play', enterMs: 1200, def: 5 },
    matchPoint:  { label: 'Match point', group: 'play', enterMs: 1300, def: 5 },
    playerStats: { label: 'Player statistics', group: 'play', enterMs: 1900, def: 12 },
    stats:       { label: 'Match statistics', group: 'after', enterMs: 2000, def: 15 },
    result:      { label: 'Match result', group: 'after', enterMs: 2400, def: null },
    upcoming:    { label: 'Upcoming match', group: 'after', enterMs: 1900, def: 12 }
  };
  var ORDER = ['intro', 'teams', 'player', 'compare', 'toss', 'server', 'start', 'tournament', 'setScore', 'setWinner', 'tiebreak', 'breakPoint', 'matchPoint', 'playerStats', 'stats', 'result', 'upcoming'];
  var GROUPS = { pre: 'Before the match', play: 'During play', after: 'After a set / the match' };
  var LOWERS = {
    player:     { label: 'Player name', def: 8 },
    profile:    { label: 'Player introduction', def: 10 },
    serve:      { label: 'Serve information', def: 8 },
    stat:       { label: 'Player statistic', def: 8 },
    tournament: { label: 'Tournament information', def: 8 },
    match:      { label: 'Match details', def: 8 },
    announce:   { label: 'Announcement', def: 8 },
    ticker:     { label: 'Scrolling information', def: null }
  };
  // the priority order (one call-out per event: the biggest thing it did)
  var MOMENTS = {
    MATCH_WON:    { label: 'Match won', def: 8, auto: true },
    SET_WON:      { label: 'Set won', def: 5, auto: true },
    TIEBREAK_WON: { label: 'Tie-break won', def: 5, auto: true },
    BREAK:        { label: 'Break of serve', def: 4, auto: true },
    ACE:          { label: 'Ace', def: 4, auto: true },
    DOUBLE_FAULT: { label: 'Double fault', def: 4, auto: true },
    TIEBREAK:     { label: 'Tie-break', def: 4, auto: true },
    MATCH_POINT:  { label: 'Match point', def: 5, auto: true },
    SET_POINT:    { label: 'Set point', def: 5, auto: true },
    BREAK_POINT:  { label: 'Break point', def: 5, auto: true },
    GAME_POINT:   { label: 'Game point', def: 3, auto: false },
    DEUCE:        { label: 'Deuce', def: 3, auto: false }
  };
  var MOMENT_ORDER = Object.keys(MOMENTS);

  /* ---------- the look, shared by every match of a tournament ---------- */
  var FONTS = {
    barlow: { label: 'Barlow Condensed', family: 'Barlow Condensed', css: 'Barlow+Condensed:ital,wght@0,500;0,600;0,700;0,800;1,700;1,800' },
    oswald: { label: 'Oswald', family: 'Oswald', css: 'Oswald:wght@500;600;700' },
    saira: { label: 'Saira Condensed', family: 'Saira Condensed', css: 'Saira+Condensed:wght@500;600;700;800' },
    inter: { label: 'Inter', family: 'Inter', css: 'Inter:wght@500;600;700;800;900' }
  };
  var SPEEDS = { 0.8: 'Snappy', 1: 'Standard', 1.25: 'Calm' };
  var LAYOUTS = { bug: 'Corner score bug', bar: 'Wide score bar' };
  var STYLE_DEFAULTS = {
    accent: '#c8f031', base: '#0b1f17', font: 'barlow', speed: 1, layout: 'bug', position: 'tl',
    names: 'auto', flags: true, seeds: true, surfaceTint: true, setHistory: true, pressureTag: true,
    moments: null,          // { KIND: true|false } — null = each kind's own default
    autoScenes: { setWinner: false, result: false },
    durations: {}
  };

  function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 120); }
  function hex(v, d) { var s = String(v || '').trim(); return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : d; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function parseDuration(v) {
    if (v === null || v === 'hold' || v === 0 || v === '0') return null;
    var n = Math.round(Number(v));
    return isFinite(n) && n >= 1 && n <= MAX_SEC ? n : undefined;
  }
  var BAD_TIME = 'Time on screen must be 1–' + MAX_SEC + ' seconds, or Hold';

  function normalizeStyle(s) {
    s = s && typeof s === 'object' ? s : {};
    var d = STYLE_DEFAULTS;
    var speed = Number(s.speed);
    var durations = {};
    var src = s.durations && typeof s.durations === 'object' ? s.durations : {};
    ORDER.concat(Object.keys(LOWERS)).forEach(function (k) {
      if (!has(src, k)) return;
      var v = parseDuration(src[k]);
      if (v !== undefined) durations[k] = v;
    });
    var moments = {};
    MOMENT_ORDER.forEach(function (k) { moments[k] = s.moments && has(s.moments, k) ? !!s.moments[k] : MOMENTS[k].auto; });
    var as = s.autoScenes && typeof s.autoScenes === 'object' ? s.autoScenes : {};
    return {
      accent: hex(s.accent, d.accent), base: hex(s.base, d.base),
      font: has(FONTS, s.font) ? s.font : d.font,
      speed: SPEEDS[speed] ? speed : d.speed,
      layout: has(LAYOUTS, s.layout) ? s.layout : d.layout,
      position: s.position === 'tr' || s.position === 'bl' || s.position === 'br' ? s.position : 'tl',
      names: s.names === 'short' || s.names === 'full' ? s.names : 'auto',
      flags: s.flags !== false, seeds: s.seeds !== false, surfaceTint: s.surfaceTint !== false,
      setHistory: s.setHistory !== false, pressureTag: s.pressureTag !== false,
      autoMoments: s.autoMoments !== false,
      moments: moments,
      autoScenes: { setWinner: !!as.setWinner, result: !!as.result },
      durations: durations
    };
  }
  function defaultDuration(scene, style) {
    var st = style && style.durations ? style.durations : {};
    if (has(st, scene)) return st[scene];
    return SCENES[scene] ? SCENES[scene].def : LOWERS[scene] ? LOWERS[scene].def : null;
  }

  /* ---------- what each graphic may be asked to show ---------- */
  function cleanData(scene, d) {
    d = d && typeof d === 'object' ? d : {};
    var out = {};
    var set = Math.round(Number(d.set));
    if ((scene === 'setWinner' || scene === 'setScore') && set >= 1 && set <= 7) out.set = set;
    if ((scene === 'player' || scene === 'playerStats') && d.playerId) out.playerId = str(d.playerId, 64);
    if (scene === 'upcoming' && d.matchId) out.matchId = str(d.matchId, 64);
    if (scene === 'breakPoint' || scene === 'matchPoint' || scene === 'tiebreak') { if (d.side === 'A' || d.side === 'B') out.side = d.side; }
    return out;
  }
  function cleanLower(kind, d) {
    d = d && typeof d === 'object' ? d : {};
    var out = {};
    if (d.playerId) out.playerId = str(d.playerId, 64);
    if (d.side === 'A' || d.side === 'B') out.side = d.side;
    if (d.stat) out.stat = str(d.stat, 32);
    if (d.title) out.title = str(d.title, 80);
    if (d.text) out.text = str(d.text, kind === 'ticker' ? 400 : 160);
    return out;
  }
  function sameData(a, b) {
    var ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
    if (ka.join() !== kb.join()) return false;
    for (var i = 0; i < ka.length; i++) if (String(a[ka[i]]) !== String(b[ka[i]])) return false;
    return true;
  }

  /* ---------- the on-air state ---------- */
  function idle(seq) { return { seq: seq || 0, id: null, scene: null, clean: false, live: { mode: 'auto', layout: null }, lower: null, moment: null, reason: 'idle' }; }
  function liveOf(cur) {
    var l = cur && cur.live && typeof cur.live === 'object' ? cur.live : {};
    var mode = l.mode === 'manual' ? 'manual' : 'auto';
    return { mode: mode, layout: mode === 'manual' && has(LAYOUTS, l.layout) ? l.layout : null };
  }
  function carry(prev, o) {
    o.live = liveOf(prev);
    o.lower = prev && prev.lower ? prev.lower : null;
    o.moment = prev && prev.moment ? prev.moment : null;
    // the last call-out ever put on air — so the same event never plays it again
    if (prev && prev.lastMoment) o.lastMoment = prev.lastMoment;
    return o;
  }
  function offAir(prev, seq, reason, clean) {
    var o = carry(prev, { seq: seq, id: null, scene: null, clean: !!clean, reason: reason, endedId: prev && prev.scene ? prev.id : null, endedScene: prev && prev.scene ? prev.scene : null });
    if (clean) { o.lower = null; o.moment = null; }
    return o;
  }
  // Which live layout an output shows now — 'bug', 'bar' or null (none).
  function liveLayout(cur, style, urlLayout) {
    if (urlLayout === 'graphics' || (cur && cur.clean)) return null;
    var lv = liveOf(cur);
    if (lv.mode === 'auto') return urlLayout || normalizeStyle(style).layout;
    if (!lv.layout) return null;
    return !urlLayout || urlLayout === lv.layout ? lv.layout : null;
  }
  function timedOut(x, now) { return !!x && x.expiresAt != null && now >= x.expiresAt; }

  /* One command against the state on air (pure: `cur` is never changed).
       { action: 'take', scene, data, durationSec?, reqId? }  a scene on air (replaces any)
       { action: 'stop', id? }       the scene off — the live score returns
       { action: 'live' }            nothing but the live score (also ends "hide everything")
       { action: 'clean' }           hide everything
       { action: 'duration', id?, durationSec }
       { action: 'live-mode', mode } / { action: 'live-on', layout } / { action: 'live-off' }
       { action: 'lower', kind, data, durationSec? } / { action: 'lower-off', id? }
       { action: 'moment', kind, side?, playerId?, data?, eventId? } / { action: 'moment-off', id? }
     opts: { style, nextSeq(), check(scene, data) → { error } | { data } }
     → { ok, next (null: nothing changes), error, stale, same } */
  function applyCommand(cur, cmd, opts, now) {
    cur = cur && typeof cur === 'object' ? cur : idle();
    cmd = cmd && typeof cmd === 'object' ? cmd : {};
    opts = opts || {};
    var style = normalizeStyle(opts.style);
    var seq = function () { return opts.nextSeq ? opts.nextSeq() : (cur.seq || 0) + 1; };
    var on = cur.scene ? cur : null;
    var aimed = function () { return on && (!cmd.id || cmd.id === on.id); };
    var k = style.speed;
    var action = cmd.action || 'take';

    if (action === 'take') {
      var def = SCENES[cmd.scene];
      if (!def) return { ok: false, next: null, error: 'Unknown graphic' };
      var reqId = str(cmd.reqId, 64) || null;
      if (on && reqId && on.reqId === reqId) return { ok: true, next: null, same: true };
      var data = cleanData(cmd.scene, cmd.data);
      var chk = opts.check ? opts.check(cmd.scene, data) : null;
      if (chk && chk.error) return { ok: false, next: null, error: chk.error };
      if (chk && chk.data) data = chk.data;
      var dur = cmd.durationSec === undefined ? defaultDuration(cmd.scene, style) : parseDuration(cmd.durationSec);
      if (dur === undefined) return { ok: false, next: null, error: BAD_TIME };
      if (on && on.scene === cmd.scene && sameData(on.data, data)) {
        if (cmd.durationSec === undefined || dur === on.durationSec) return { ok: true, next: null, same: true };
        return applyCommand(cur, { action: 'duration', id: on.id, durationSec: cmd.durationSec }, opts, now);
      }
      // an automatic scene never takes the screen from one the operator put up
      if (cmd.auto && on && !on.auto) return { ok: true, next: null, same: true, skipped: true };
      var s = seq();
      var g = carry(cur, {
        seq: s, id: 'g' + s.toString(36), scene: cmd.scene, data: data, startedAt: now,
        readyAt: now + Math.round(((on ? GFX_OUT_MS : liveLayout(cur, style, null) ? BAR_OUT_MS : 0) + def.enterMs) * k),
        durationSec: dur, expiresAt: null, speed: k, clean: false, reqId: reqId, auto: !!cmd.auto,
        endedId: on ? on.id : null, endedScene: on ? on.scene : null, reason: 'take'
      });
      g.expiresAt = dur == null ? null : g.readyAt + dur * 1000;
      g.lower = null; g.moment = null;      // a scene takes the whole screen
      return { ok: true, next: g };
    }
    if (action === 'stop') {
      if (!on) return { ok: true, next: null };
      if (!aimed()) return { ok: false, next: null, stale: true, error: 'Another graphic is on air now' };
      return { ok: true, next: offAir(on, seq(), str(cmd.reason, 24) || 'stopped', false) };
    }
    if (action === 'live') {
      var lvR = liveOf(cur);
      var pick = lvR.mode === 'manual' && !lvR.layout;
      if (!on && !cur.clean && !pick) return { ok: true, next: null };
      var back = offAir(on || cur, seq(), 'live', false);
      back.live = pick ? { mode: 'manual', layout: style.layout } : lvR;
      return { ok: true, next: back };
    }
    if (action === 'clean') {
      if (!on && cur.clean) return { ok: true, next: null };
      return { ok: true, next: offAir(on || cur, seq(), 'clean', true) };
    }
    if (action === 'duration') {
      if (!aimed()) return { ok: false, next: null, stale: true, error: 'That graphic is not on air' };
      var d2 = parseDuration(cmd.durationSec);
      if (d2 === undefined) return { ok: false, next: null, error: BAD_TIME };
      var g2 = Object.assign({}, on, { seq: seq(), durationSec: d2, reason: 'duration' });
      g2.expiresAt = d2 == null ? null : Math.max(now, on.readyAt) + d2 * 1000;
      return { ok: true, next: g2 };
    }
    if (action === 'live-mode') {
      var mode = cmd.mode === 'manual' || cmd.mode === 'auto' ? cmd.mode : null;
      if (!mode) return { ok: false, next: null, error: 'Choose Automatic or Manual' };
      if (liveOf(cur).mode === mode) return { ok: true, next: null, same: true };
      return { ok: true, next: Object.assign({}, cur, { seq: seq(), live: mode === 'manual' ? { mode: 'manual', layout: style.layout } : { mode: 'auto', layout: null }, reason: 'live-mode' }) };
    }
    if (action === 'live-on') {
      var lay = has(LAYOUTS, cmd.layout) ? cmd.layout : null;
      if (!lay) return { ok: false, next: null, error: 'Unknown layout' };
      var lvOn = liveOf(cur);
      if (!on && !cur.clean && lvOn.mode === 'manual' && lvOn.layout === lay) return { ok: true, next: null, same: true };
      var shown = on ? offAir(on, seq(), 'live-on', false) : Object.assign({}, cur, { seq: seq(), clean: false, reason: 'live-on' });
      shown.live = { mode: 'manual', layout: lay };
      return { ok: true, next: shown };
    }
    if (action === 'live-off') {
      var lvOff = liveOf(cur);
      var showing = lvOff.mode === 'manual' ? lvOff.layout : style.layout;
      if (!showing) return { ok: true, next: null, same: true };
      return { ok: true, next: Object.assign({}, cur, { seq: seq(), live: { mode: 'manual', layout: null }, reason: 'live-off' }) };
    }
    if (action === 'lower') {
      var L = LOWERS[cmd.kind];
      if (!L) return { ok: false, next: null, error: 'Unknown lower third' };
      if (on) return { ok: false, next: null, error: 'Take the full-screen graphic off air first' };
      var ld = cleanLower(cmd.kind, cmd.data);
      var lchk = opts.check ? opts.check('lower:' + cmd.kind, ld) : null;
      if (lchk && lchk.error) return { ok: false, next: null, error: lchk.error };
      if (lchk && lchk.data) ld = lchk.data;
      var ldur = cmd.durationSec === undefined ? defaultDuration(cmd.kind, style) : parseDuration(cmd.durationSec);
      if (ldur === undefined) return { ok: false, next: null, error: BAD_TIME };
      var cl = cur.lower;
      if (cl && cl.kind === cmd.kind && sameData(cl.data, ld) && !timedOut(cl, now)) return { ok: true, next: null, same: true };
      var ls = seq();
      var lw = { id: 'l' + ls.toString(36), kind: cmd.kind, data: ld, startedAt: now, durationSec: ldur, expiresAt: ldur == null ? null : now + Math.round(900 * k) + ldur * 1000 };
      return { ok: true, next: Object.assign({}, cur, { seq: ls, lower: lw, clean: false, reason: 'lower' }) };
    }
    if (action === 'lower-off') {
      if (!cur.lower) return { ok: true, next: null };
      if (cmd.id && cmd.id !== cur.lower.id) return { ok: false, next: null, stale: true, error: 'Another lower third is on air now' };
      return { ok: true, next: Object.assign({}, cur, { seq: seq(), lower: null, reason: 'lower-off' }) };
    }
    if (action === 'moment') {
      var M = MOMENTS[cmd.kind];
      if (!M) return { ok: false, next: null, error: 'Unknown call-out' };
      // the same event never plays its call-out twice
      var mid = cmd.eventId ? 'm:' + str(cmd.eventId, 80) + ':' + cmd.kind : null;
      if (mid && cur.moment && cur.moment.id === mid) return { ok: true, next: null, same: true };
      if (mid && cur.lastMoment === mid) return { ok: true, next: null, same: true };
      if (on && cmd.auto) return { ok: true, next: null, skipped: true };
      if (on) return { ok: false, next: null, error: 'A full-screen graphic is on air' };
      var ms = seq();
      var mo = {
        id: mid || 'mm' + ms.toString(36), kind: cmd.kind, side: cmd.side === 'A' || cmd.side === 'B' ? cmd.side : null,
        playerId: cmd.playerId ? str(cmd.playerId, 64) : null, data: cmd.data && typeof cmd.data === 'object' ? JSON.parse(JSON.stringify(cmd.data)) : {},
        eventId: cmd.eventId ? str(cmd.eventId, 80) : null, auto: !!cmd.auto, startedAt: now, expiresAt: now + Math.round((cmd.durationSec ? Math.min(30, Number(cmd.durationSec)) : M.def) * 1000)
      };
      return { ok: true, next: Object.assign({}, cur, { seq: ms, moment: mo, lastMoment: mo.id, reason: 'moment' }) };
    }
    if (action === 'moment-off') {
      if (!cur.moment) return { ok: true, next: null };
      if (cmd.id && cmd.id !== cur.moment.id) return { ok: true, next: null, same: true };
      if (cmd.eventId && cur.moment.eventId !== cmd.eventId) return { ok: true, next: null, same: true };
      return { ok: true, next: Object.assign({}, cur, { seq: seq(), moment: null, reason: 'moment-off' }) };
    }
    return { ok: false, next: null, error: 'Unknown command' };
  }
  // Timed layers whose time is up are off air (the server's timers do this
  // as it happens; this catches one that ran out while it was down).
  function settle(cur, now, nextSeq) {
    if (!cur) return null;
    var next = null;
    var seq = function () { return nextSeq ? nextSeq() : (cur.seq || 0) + 1; };
    if (cur.scene && timedOut(cur, now)) next = offAir(cur, seq(), 'expired', false);
    var base = next || cur;
    if (base.lower && timedOut(base.lower, now)) next = Object.assign({}, base, { seq: next ? next.seq : seq(), lower: null, reason: next ? next.reason : 'expired' });
    base = next || cur;
    if (base.moment && timedOut(base.moment, now)) next = Object.assign({}, base, { seq: next ? next.seq : seq(), moment: null, reason: next ? next.reason : 'expired' });
    return next;
  }
  // the earliest moment something on air runs out (for the server's timer)
  function nextExpiry(cur) {
    var t = [];
    if (cur && cur.scene && cur.expiresAt != null) t.push(cur.expiresAt);
    if (cur && cur.lower && cur.lower.expiresAt != null) t.push(cur.lower.expiresAt);
    if (cur && cur.moment && cur.moment.expiresAt != null) t.push(cur.moment.expiresAt);
    return t.length ? Math.min.apply(null, t) : null;
  }

  /* ---------- the automatic call-out for one scoring event ----------
     From the timeline entry (its effects) and the summary before / after
     it: the single biggest thing that happened, if the tournament wants
     that kind on air. → { kind, side, playerId, data } | null */
  function momentFor(entry, before, after, style) {
    if (!entry || entry.voided || entry.invalid) return null;
    var st = normalizeStyle(style);
    if (!st.autoMoments) return null;
    var fx = entry.effects || [];
    var find = function (t) { for (var i = 0; i < fx.length; i++) if (fx[i].type === t) return fx[i]; return null; };
    var cands = [];
    var x;
    if ((x = find('MATCH_WON')) && x.reason === 'played') cands.push({ kind: 'MATCH_WON', side: x.side });
    if ((x = find('SET_WON'))) cands.push({ kind: 'SET_WON', side: x.side, data: { set: x.set, games: x.games, tb: x.tb } });
    if ((x = find('TIEBREAK_WON')) && !x.mtb) cands.push({ kind: 'TIEBREAK_WON', side: x.side, data: { points: x.points } });
    if ((x = find('BREAK'))) cands.push({ kind: 'BREAK', side: x.side, data: { games: x.games } });
    if ((x = find('ACE'))) cands.push({ kind: 'ACE', side: x.side, playerId: x.player, data: entry.speed ? { speed: entry.speed } : {} });
    if ((x = find('DOUBLE_FAULT'))) cands.push({ kind: 'DOUBLE_FAULT', side: x.side, playerId: x.player });
    if (find('TIEBREAK_START') || (find('SET_BREAK') && find('SET_BREAK').matchTiebreak)) cands.push({ kind: 'TIEBREAK', data: { mtb: !!(find('SET_BREAK') && find('SET_BREAK').matchTiebreak) } });
    // pressure: only when it ARISES (not again on each point while it lasts)
    var h = after && after.headline, hb = before && before.headline;
    if (h && entry.type === 'POINT' && !(hb && hb.kind === h.kind && hb.side === h.side)) {
      var pk = { match: 'MATCH_POINT', set: 'SET_POINT', break: 'BREAK_POINT', game: 'GAME_POINT' }[h.kind];
      if (pk) cands.push({ kind: pk, side: h.side === 'both' ? null : h.side, data: { count: h.count, deciding: !!h.deciding, alsoBreak: !!h.alsoBreak } });
    }
    if (entry.type === 'POINT' && after && after.deuce && !(before && before.deuce)) cands.push({ kind: 'DEUCE' });
    cands.sort(function (a, b) { return MOMENT_ORDER.indexOf(a.kind) - MOMENT_ORDER.indexOf(b.kind); });
    for (var i = 0; i < cands.length; i++) if (st.moments[cands[i].kind]) return cands[i];
    return null;
  }

  /* ---------- what the outputs really show ----------
     Every overlay showing the match tells the server what it draws
     (tn:output); the panels say ON AIR only once a programme output — not
     a monitor — has it up, never because a button was pressed. */
  var OUTPUT_FRESH_MS = 45000;
  var LIVE_NAMES = { bug: 'Score bug', bar: 'Score bar' };
  var MOVING = /ENTERING|EXITING|RETURNING/;
  var CHECK = 'check the overlay in vMix / OBS';
  function settledOn(x, g) { return typeof x.airSeq === 'number' && typeof g.seq === 'number' && x.airSeq >= g.seq && !MOVING.test(x.state); }
  function ableFor(o, lay) { return o.filter(function (x) { return x.layoutParam !== 'graphics' && (!x.layoutParam || x.layoutParam === lay); }); }
  function stuck(n, g, now) { return n.o.length > 0 && now > (g.readyAt || g.startedAt || 0) + 3000 && n.o.every(function (x) { return settledOn(x, g); }); }
  function readOutputs(outputs, cur, now) {
    var g = cur || {};
    var o = (outputs || []).filter(function (x) { return x && !x.monitor && now - (x.at || 0) < OUTPUT_FRESH_MS; });
    var liveUp = function (lay) { return o.filter(function (x) { return x.state === 'OVERLAY_VISIBLE' && x.layout === lay; }).length; };
    return {
      o: o,
      up: g.scene ? o.filter(function (x) { return x.state === 'GRAPHIC_VISIBLE' && x.graphicId === g.id; }) : [],
      failed: g.scene ? o.filter(function (x) { return x.failed && x.failed.id === g.id; })[0] || null : null,
      moving: o.filter(function (x) { return MOVING.test(x.state); }),
      live: { bug: liveUp('bug'), bar: liveUp('bar') },
      lower: g.lower ? o.filter(function (x) { return x.lowerId === g.lower.id; }).length : 0
    };
  }
  function airSummary(cur, style, outputs, now, label) {
    var g = cur || {}, n = readOutputs(outputs, g, now);
    var lv = liveOf(g), choice = liveLayout(g, style, null);
    var name = label || (g.scene && SCENES[g.scene] ? SCENES[g.scene].label : 'The graphic');
    var none = 'No overlay output is connected — add the overlay link to vMix to see it';
    if (g.scene) {
      var left = g.expiresAt != null ? Math.max(0, Math.ceil((g.expiresAt - now) / 1000)) : null;
      var when = left != null ? left + ' s left' : 'held until dismissed';
      if (n.failed && !n.up.length) return { k: 'bad', t: name + ' could not be shown', d: (n.failed.failed && n.failed.failed.error) || 'The overlay could not draw it' };
      if (!n.o.length) return { k: 'warn', t: name + ' is on air', d: none + ' · ' + when };
      if (n.up.length) return { k: 'on', t: name + ' is on air', d: when + ' · the score bug has stepped off' + (choice ? ' and returns with the latest score' : '') };
      if (stuck(n, g, now)) return { k: 'bad', t: name + ' is not showing', d: 'Taken to air, but no output has it up — ' + CHECK };
      return { k: 'move', t: 'Transition in progress', d: name + ' is coming to air' };
    }
    if (n.moving.length) return { k: 'move', t: 'Transition in progress', d: '' };
    if (g.clean) return { k: 'warn', t: 'Everything is hidden', d: 'Nothing shows on the overlay until you restore it' };
    var lower = g.lower ? ' · ' + (LOWERS[g.lower.kind] ? LOWERS[g.lower.kind].label : 'Lower third') + ' up' : '';
    if (n.live.bug || n.live.bar) return { k: 'live', t: LIVE_NAMES[n.live.bug ? 'bug' : 'bar'] + ' is on air', d: (lv.mode === 'auto' ? 'Automatic' : 'Manual') + ' · follows every point' + lower };
    if (!choice) return { k: 'idle', t: 'The score bug is off air', d: 'Manual — take it on air when you want it' + lower };
    if (!n.o.length) return { k: 'warn', t: LIVE_NAMES[choice] + ' is on air', d: none };
    var able = ableFor(n.o, choice);
    if (!able.length) return { k: 'warn', t: LIVE_NAMES[choice] + ' is on no output', d: 'Every connected output is graphics only' };
    if (able.every(function (x) { return settledOn(x, g); })) return { k: 'bad', t: LIVE_NAMES[choice] + ' is not showing', d: 'No output has it up — ' + CHECK };
    return { k: 'move', t: 'Transition in progress', d: LIVE_NAMES[choice] + ' is coming to air' };
  }
  function sceneCard(sc, cur, outputs, now) {
    var g = cur || {}, n = readOutputs(outputs, g, now);
    if (g.scene === sc) {
      var why = n.failed ? (n.failed.failed && n.failed.failed.error) || 'The overlay could not draw it' : '';
      if (n.failed && !n.up.length) return { k: 'failed', word: 'Failed to display', why: why };
      if (n.up.length) return n.failed ? { k: 'on', word: '● ON AIR · failed on one output', why: why, warn: true } : { k: 'on', word: '● ON AIR' };
      if (!n.o.length) return { k: 'on', word: '● ON AIR · no output', warn: true };
      return stuck(n, g, now) ? { k: 'failed', word: 'Not showing', why: 'No output has it up — ' + CHECK } : { k: 'taking', word: 'Taking to air…' };
    }
    if (n.o.some(function (x) { return x.scene === sc && /^GRAPHIC_/.test(x.state); })) return { k: 'exiting', word: 'Leaving…' };
    return null;
  }
  function publicState(cur, now) {
    var g = Object.assign({}, cur || idle());
    delete g.reqId;
    g.serverNow = now;
    if (g.scene) g.label = SCENES[g.scene] ? SCENES[g.scene].label : g.scene;
    g.timing = { barOutMs: BAR_OUT_MS, gfxOutMs: GFX_OUT_MS, enterMs: g.scene && SCENES[g.scene] ? SCENES[g.scene].enterMs : 0 };
    return g;
  }

  return {
    SCENES: SCENES, ORDER: ORDER, GROUPS: GROUPS, LOWERS: LOWERS, MOMENTS: MOMENTS, MOMENT_ORDER: MOMENT_ORDER,
    FONTS: FONTS, SPEEDS: SPEEDS, LAYOUTS: LAYOUTS, STYLE_DEFAULTS: STYLE_DEFAULTS,
    BAR_OUT_MS: BAR_OUT_MS, GFX_OUT_MS: GFX_OUT_MS, MAX_SEC: MAX_SEC, BAD_TIME: BAD_TIME,
    normalizeStyle: normalizeStyle, defaultDuration: defaultDuration, parseDuration: parseDuration, cleanData: cleanData, cleanLower: cleanLower,
    applyCommand: applyCommand, settle: settle, nextExpiry: nextExpiry, idle: idle, liveOf: liveOf, liveLayout: liveLayout, momentFor: momentFor,
    readOutputs: readOutputs, airSummary: airSummary, sceneCard: sceneCard, publicState: publicState, LIVE_NAMES: LIVE_NAMES, OUTPUT_FRESH_MS: OUTPUT_FRESH_MS
  };
});
