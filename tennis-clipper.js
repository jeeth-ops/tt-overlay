/* ================================================================
   🎬 TENNIS CLIPPER — the browser side of the TENNIS Clipper
   (tennis-clipper-helper/: TennisClipper.exe next to vMix on the PC that
   records, localhost:5009). Its own program — never the Cricket Clipper
   (:5005, asl-clipper://) nor the Volleyball Clipper (:5007,
   asl-vb-clipper://), which nothing here ever calls, starts or stops, and
   whose recording folders it never assumes: the Tennis Clipper has its own
   setup (its own vMix recording folder, its own TennisClips folder).

     ▶ Start Clipper   the Tennis Clipper Launcher's asl-tn-clipper:// link
                       starts TennisClipper.exe hidden (set up once per PC);
                       the website and THIS match are handed to it, and the
                       match's clipping session is claimed on the website
     every point       one clip job "<matchId>_<the point's eventId>": the
                       press, the rally before it and the end of it (the
                       tournament's window — 7 s + 3 s by default) — queued
                       here first, so a Clipper that is restarting still gets
                       it, and never twice
     a clip by hand    "<matchId>_clip-<id>": a celebration, a moment between
                       points — with its kind and the player chosen
     who it is about   sent to the Clipper whenever the point's classification
                       changes (or the point is undone), so the clip is filed
                       under the player; on the website it follows the point
     READY             only when the Clipper answers, is set up for THIS
                       match, and a recording is being written right now

   Scoring never waits for any of this: a point is counted first; its clip
   job is queued after it.
   ================================================================ */
(function () {
  'use strict';
  var HELPER = 'http://localhost:5009';            // the Tennis Clipper — never cricket's :5005, never volleyball's :5007
  var LINK = 'asl-tn-clipper://';                  // its launcher (install-tennis-clipper-launcher.bat)
  var OUTBOX_MAX_AGE_MS = 8 * 60 * 60 * 1000;
  var BEAT_MS = 10000;
  var LOCAL_FOR = { WAITING: 'WAITING_FOR_POSTROLL', CUTTING: 'CUTTING', CUT_RETRY: 'CUTTING', CUT_FAILED: 'FAILED_PERMANENT', LOCAL_SAVED: 'LOCAL_SAVED', OFFLINE_PENDING: 'RETRY_PENDING', SENDING: 'FORWARDING', SENT: 'FORWARDING', SYNC_RETRY: 'RETRY_PENDING' };
  var TS = function () { return window.TennisStats; };

  function timeout(ms) {
    if (window.AbortSignal && AbortSignal.timeout) return AbortSignal.timeout(ms);
    var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal;
  }
  // The Tennis Clipper says who it is — never act on anything else that answers.
  function isTennisClipper(s) { return !!s && s.app === 'tennis-clipper' && s.tennis === true; }
  function helperGet(p, ms) { return fetch(HELPER + p, { signal: timeout(ms || 2500), cache: 'no-store' }).then(function (r) { return r.json(); }); }
  function helperPost(p, body, ms) {
    return fetch(HELPER + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: timeout(ms || 5000) })
      .then(function (r) { return r.json().then(function (j) { return Object.assign({ httpOk: r.ok }, j); }); });
  }
  function launch(action) { var a = document.createElement('a'); a.href = LINK + action; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); }
  function deviceLabel() {
    var ua = navigator.userAgent || '';
    return /Windows/.test(ua) ? 'Windows PC' : /Mac OS X/.test(ua) && !/Mobile/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Linux/.test(ua) ? 'Linux PC' : 'this device';
  }

  /* o: { matchId, getMatch(), getTournament(), getTimeline(), getSetup(), role, label, onChange(), toast(), socket } */
  function create(o) {
    var KEY = 'tn_clipper:' + o.matchId, OUT = 'tn_clip_out:' + o.matchId, SENT = 'tn_clip_sent:' + o.matchId;
    var C = {
      helper: { alive: null, status: null, at: 0 },
      session: TN.store.get(KEY, null), owner: (o.getMatch() && o.getMatch().clipper) || null,
      jobs: new Map(), clips: new Map(), byClip: new Map(), outbox: TN.store.get(OUT, []), sent: TN.store.get(SENT, {}),
      busy: null, notice: null, lastBeat: 0, lastStart: 0
    };
    var toast = o.toast || function () {};
    var changed = function () { try { o.onChange && o.onChange(); } catch (e) { console.error(e); } };
    var saveSession = function () { if (C.session && C.session.on) TN.store.set(KEY, C.session); else TN.store.del(KEY); };
    var saveOutbox = function () { if (C.outbox.length) TN.store.set(OUT, C.outbox.slice(-500)); else TN.store.del(OUT); };
    var saveSent = function () { TN.store.set(SENT, C.sent); };
    function mine() { return !!(C.session && C.session.on && C.owner && C.owner.sessionId === C.session.id && !C.owner.stoppedAt); }
    function on() { return !!(C.session && C.session.on); }
    function match() { return o.getMatch() || {}; }
    function sideName(s) { var x = match().sides && match().sides[s]; return x ? x.name : 'Side ' + s; }
    function windowOf() { var w = match().clip || {}; return { pre: w.preRollSec || 7, post: w.postRollSec || 3 }; }

    /* ---------- the Clipper program ---------- */
    async function ping() {
      try { var s = await helperGet('/status', 2500); C.helper = Object.assign(C.helper, { alive: true, status: s, at: Date.now() }); }
      catch (e) { C.helper = Object.assign(C.helper, { alive: false, at: Date.now() }); }
      return C.helper.alive;
    }
    async function loadJobs() {
      if (!C.helper.alive) return;
      try {
        var r = await helperGet('/clip-jobs?limit=120&matchId=' + encodeURIComponent(o.matchId), 3000);
        var next = new Map();
        ((r && r.jobs) || []).forEach(function (j) { next.set(j.clipId, j); });
        C.jobs = next;
        if (mine()) next.forEach(function (j, id) {
          var st = LOCAL_FOR[j.syncStatus];
          if (!st || C.sent['rel:' + id] === st || j.sport !== 'tennis') return;
          C.sent['rel:' + id] = st;
          TN.api('POST', '/api/tennis/clips/' + encodeURIComponent(id) + '/local', { status: st, error: j.error || null });
        });
      } catch (e) { /* the next round */ }
    }
    async function claimHelper(force) {
      var s = C.helper.status;
      if (!s) return false;
      if (!force && s.matchId === o.matchId && s.sport === 'tennis' && s.mainServerUrl === location.origin) return true;
      if (!force && Date.now() - C.lastStart < 20000) return false;
      C.lastStart = Date.now();
      var m = match(), t = o.getTournament ? o.getTournament() : null;
      try {
        if (!s.mainServerUrl && /^https?:$/.test(location.protocol)) await helperPost('/setup', { websiteUrl: location.origin }, 3000);
        var w = windowOf();
        await helperPost('/recording-start', { startedAt: Date.now(), matchId: o.matchId, mainServerUrl: location.origin, sport: 'tennis', matchLabel: sideName('A') + ' v ' + sideName('B'), tournamentId: m.tournamentId || null, tournamentName: (t && t.name) || null, preRollSec: w.pre, postRollSec: w.post }, 4000);
        await ping();
        return true;
      } catch (e) { return false; }
    }

    /* ---------- the website's clipping session ---------- */
    function statusForServer() {
      var md = model(), s = C.helper.status || {}, k = md.counts;
      return { state: md.state, text: md.text, recording: { file: s.currentRecordingFile ? String(s.currentRecordingFile).split(/[\\/]/).pop() : null, seconds: s.recordingSeconds, growing: !!s.recordingGrowing },
        counts: { processing: k.processing, failed: k.failed, upload: k.upload, offline: k.offline, done: k.done }, online: typeof s.online === 'boolean' ? s.online : null, window: md.window };
    }
    async function claimSession(force) {
      var r = await TN.api('POST', '/api/tennis/matches/' + o.matchId + '/clipper', { action: 'start', sessionId: C.session.id, label: o.label || deviceLabel(), deviceId: TN.deviceId(), force: !!force, status: statusForServer() });
      if (r.ok) { C.owner = r.json.clipper; C.lastBeat = Date.now(); return { ok: true }; }
      return { ok: false, status: r.status, code: r.json && r.json.code, owner: r.json && r.json.clipper, error: r.json && r.json.error };
    }
    async function beat() {
      if (!on() || Date.now() - C.lastBeat < BEAT_MS) return;
      C.lastBeat = Date.now();
      var r = await TN.api('POST', '/api/tennis/matches/' + o.matchId + '/clipper', { action: 'beat', sessionId: C.session.id, status: statusForServer() });
      if (r.ok) { C.owner = r.json.clipper; return; }
      if (r.status === 409) lose(r.json && r.json.clipper);
    }
    function lose(owner) {
      C.owner = owner || C.owner; C.session = null; saveSession();
      C.notice = owner && owner.live ? 'Clipping moved to ' + (owner.label || 'another device') + ' — this device stopped sending clips.' : 'Clipping was stopped on another device.';
      toast('🎬 ' + C.notice, 'err'); changed();
    }
    function onClipper(d) {
      if (!d || d.matchId !== o.matchId) return;
      C.owner = d.clipper;
      if (on() && C.owner && C.owner.sessionId !== C.session.id && C.owner.live) lose(C.owner); else changed();
    }

    /* ---------- Start / Stop (from the operator's own click) ---------- */
    async function start(opts) {
      opts = opts || {};
      if (C.busy) return;
      C.notice = null;
      var known = C.helper.alive && Date.now() - C.helper.at < 10000;
      if (!known) launch('start');
      C.busy = 'starting'; changed();
      var until = Date.now() + 45000, up = known;
      while (!up && Date.now() < until) { if (await ping()) { up = true; break; } await new Promise(function (r) { setTimeout(r, 700); }); }
      if (!up) { C.busy = null; C.notice = 'The Tennis Clipper did not start on this PC. First time here? Set up the Tennis Clipper Launcher once (below). Already did? Look in tennis-clipper-log.txt next to TennisClipper.exe.'; changed(); return; }
      if (!isTennisClipper(C.helper.status)) { C.busy = null; C.notice = 'Something other than the Tennis Clipper answers on this PC’s port 5009 — close it, then start the Tennis Clipper (TennisClipper.exe) again.'; changed(); return; }
      C.session = { id: (C.session && C.session.id) || 'clp-' + TN.uid().slice(0, 18), on: true };
      saveSession();
      var r = await claimSession(!!opts.force);
      if (!r.ok && r.code === 'CLIPPER_ELSEWHERE') {
        C.busy = null;
        var who = (r.owner && r.owner.label) || 'another device';
        var yes = await TN.confirm('Clip this match here instead?', who + ' is clipping this match right now. Only one device clips a match, so a point is never cut twice from two recordings. Moving it here stops ' + who + ' from sending clips.', 'Clip here');
        if (!yes) { C.session = null; saveSession(); changed(); return; }
        C.busy = 'starting';
        r = await claimSession(true);
      }
      if (!r.ok) { C.busy = null; C.session = null; saveSession(); C.notice = r.error || 'The website did not accept the clipping session'; changed(); return; }
      await claimHelper(true);
      await loadJobs();
      C.busy = null;
      flush(); changed();
      toast(model().state === 'READY' ? '🎬 Clipper READY — every point is clipped from the vMix recording' : '🎬 Clipper on — ' + model().text);
    }
    async function stop() {
      if (!on() || C.busy) return;
      C.busy = 'stopping'; changed();
      await TN.api('POST', '/api/tennis/matches/' + o.matchId + '/clipper', { action: 'stop', sessionId: C.session.id, status: statusForServer() });
      C.session = null; saveSession(); C.busy = null;
      var k = model().counts;
      C.notice = k.processing ? k.processing + ' clip' + (k.processing === 1 ? ' is' : 's are') + ' still being made — they finish in the background.' : 'Clipping stopped. Clips already made are kept; no new points are clipped until you start again.';
      changed();
    }
    async function quitApp() {
      var ok = await TN.confirm('Quit the Tennis Clipper on this PC?', 'Clips not finished yet wait on this PC and carry on the next time it starts (nothing is lost or cut twice). The Cricket and Volleyball Clippers are not affected.', 'Quit Tennis Clipper', true);
      if (!ok) return;
      try { await helperPost('/quit', {}, 3000); } catch (e) { /* the launcher below */ }
      var until = Date.now() + 4000;
      while (Date.now() < until) { await new Promise(function (r) { setTimeout(r, 400); }); if (!(await ping())) break; }
      if (C.helper.alive) { launch('stop'); setTimeout(function () { ping().then(changed); }, 2500); }
      changed();
    }

    /* ---------- what a point is about ---------- */
    function attributionOf(entry) {
      var setup = o.getSetup ? o.getSetup() : null;
      if (!entry || entry.type !== 'POINT' || !setup || !TS()) return { kind: 'POINT', players: [], voided: !!(entry && entry.voided) };
      var ps = TS().pointParticipants(setup, entry);
      return { kind: TS().clipKindOf(entry), players: ps.map(function (p) { var x = setup.byId[p.playerId]; return { playerId: p.playerId, side: p.side, role: p.role, name: x ? x.player.name : null }; }), voided: !!entry.voided };
    }
    function pointMeta(ev, entry) {
      var m = match(), t = o.getTournament ? o.getTournament() : null, a = attributionOf(entry);
      var b = entry && entry.before ? entry.before : null, af = entry && entry.after ? entry.after : null;
      var w = windowOf();
      return {
        eventId: ev.eventId, set: b ? b.set : null, game: b ? b.game : null, pointNo: entry ? entry.pointNo || null : null, side: entry ? entry.side : ev.winner,
        sideName: sideName(entry ? entry.side : ev.winner), sides: { A: sideName('A'), B: sideName('B') },
        score: af ? { games: af.games, points: af.points, sets: af.setsWon, tiebreak: !!af.tiebreak } : null, kind: a.kind, pointKind: entry ? entry.kind : ev.kind || null,
        players: a.players, tnClipToken: m.clipToken || null, at: ev.at || null, tournamentName: (t && t.name) || null, preRollSec: w.pre, postRollSec: w.post
      };
    }
    function queue(item) {
      C.outbox = C.outbox.filter(function (x) { return !(x.k === item.k && x.clipId === item.clipId); });
      C.outbox.push(item); saveOutbox();
    }
    function point(ev, entry, localAt) {
      if (!ev || ev.type !== 'POINT' || !mine()) return false;
      var clipId = o.matchId + '_' + ev.eventId;
      if (C.jobs.has(clipId) || C.outbox.some(function (x) { return x.k === 'clip' && x.clipId === clipId; })) return true;
      var meta = pointMeta(ev, entry);
      var t0 = Math.round(localAt != null ? localAt : (ev.at || Date.now()) - TN.clock.offset);
      var m = match(), t = o.getTournament ? o.getTournament() : null;
      queue({ k: 'clip', clipId: clipId, at: Date.now(), body: { sport: 'tennis', matchId: o.matchId, clipId: clipId, timestamp: t0, sessionId: C.session.id, point: meta,
        matchLabel: sideName('A') + ' v ' + sideName('B'), tournamentId: m.tournamentId || null, tournamentName: (t && t.name) || null } });
      C.sent[clipId] = JSON.stringify([meta.kind, meta.players.map(function (x) { return x.playerId + ':' + x.role; }), false]); saveSent();
      TN.api('POST', '/api/tennis/matches/' + o.matchId + '/clips', { clipId: clipId, eventId: ev.eventId, status: 'REQUESTED', localStatus: 'WAITING_FOR_POSTROLL', t0: ev.at, preRollSec: meta.preRollSec, postRollSec: meta.postRollSec, engine: 'tennis-clipper', sourceSessionId: C.session.id, set: meta.set, game: meta.game, pointNo: meta.pointNo });
      flush(); changed();
      return true;
    }
    function remotePoint(ev, entry) {
      if (!ev || ev.type !== 'POINT') return false;
      if (Date.now() - ((ev.at || 0) - TN.clock.offset) > 30 * 60000) return false;
      return point(ev, entry, null);
    }
    // a clip by hand: a celebration, a moment between points
    function manual(x) {
      x = x || {};
      if (!mine()) { toast('Start the Tennis Clipper on this PC first (or on the vMix PC’s Clipper page)', 'err'); return false; }
      var clipId = o.matchId + '_clip-' + TN.uid().replace(/[^a-z0-9]/gi, '').slice(0, 16);
      var tl = o.getTimeline() || [];
      var last = null;
      for (var i = tl.length - 1; i >= 0; i--) if (tl[i].type === 'POINT' && !tl[i].voided) { last = tl[i]; break; }
      var snap = last && last.after ? last.after : null;
      var w = windowOf(), m = match(), t = o.getTournament ? o.getTournament() : null, now = Date.now();
      var meta = { eventId: null, kind: x.kind || 'MANUAL', set: snap ? snap.set : null, game: snap ? snap.game : null, pointNo: snap ? snap.pointNo : null, side: x.side || null,
        sideName: x.side ? sideName(x.side) : null, sides: { A: sideName('A'), B: sideName('B') }, players: x.playerId ? [{ playerId: x.playerId, side: x.side || null, role: 'chosen' }] : [],
        playerId: x.playerId || null, tnClipToken: m.clipToken || null, at: Math.round(now + TN.clock.offset), preRollSec: w.pre, postRollSec: w.post, tournamentName: (t && t.name) || null };
      queue({ k: 'clip', clipId: clipId, at: now, body: { sport: 'tennis', matchId: o.matchId, clipId: clipId, timestamp: now, sessionId: C.session.id, point: meta, matchLabel: sideName('A') + ' v ' + sideName('B'), tournamentId: m.tournamentId || null, tournamentName: meta.tournamentName } });
      var sc = snap ? { sets: snap.setsWon.A + '-' + snap.setsWon.B, games: snap.games.A + '-' + snap.games.B, points: snap.points.A + '-' + snap.points.B, set: snap.set } : null;
      TN.api('POST', '/api/tennis/matches/' + o.matchId + '/clips', { clipId: clipId, kind: meta.kind, playerId: x.playerId || undefined, side: x.side || undefined, status: 'REQUESTED', localStatus: 'WAITING_FOR_POSTROLL', t0: meta.at, preRollSec: w.pre, postRollSec: w.post, engine: 'tennis-clipper', sourceSessionId: C.session.id, scoreAtTrigger: sc, set: meta.set, game: meta.game, pointNo: meta.pointNo });
      toast('🎬 ' + (TS() ? TS().CLIP_KINDS[meta.kind] : meta.kind) + ' clip on its way');
      flush(); changed();
      return true;
    }
    // the timeline changed: tell the Clipper about any point whose kind / players / undone state moved
    function reconcile() {
      if (!mine()) return;
      var byId = {};
      (o.getTimeline() || []).forEach(function (e) { if (e.type === 'POINT') byId[e.eventId] = e; });
      var moved = false;
      Object.keys(C.sent).forEach(function (clipId) {
        if (clipId.indexOf('rel:') === 0) return;
        var e = byId[clipId.slice(o.matchId.length + 1)];
        if (!e) return;
        var a = attributionOf(e);
        var sig = JSON.stringify([a.kind, a.players.map(function (x) { return x.playerId + ':' + x.role; }), !!e.voided]);
        if (sig === C.sent[clipId]) return;
        C.sent[clipId] = sig;
        queue({ k: 'meta', clipId: clipId, at: Date.now(), body: { clipId: clipId, sport: 'tennis', point: { kind: a.kind, players: a.players, voided: !!e.voided } } });
        moved = true;
      });
      if (moved) { saveSent(); flush(); }
    }
    var flushing = false;
    async function flush() {
      if (flushing || !C.outbox.length) return;
      flushing = true;
      try {
        var now = Date.now();
        C.outbox = C.outbox.filter(function (x) { return now - x.at < OUTBOX_MAX_AGE_MS; });
        var list = C.outbox.slice();
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          if (it.k === 'meta' && C.outbox.some(function (x) { return x.k === 'clip' && x.clipId === it.clipId; })) continue;
          var r = null;
          try { r = await helperPost(it.k === 'clip' ? '/clip' : '/clip-meta', it.body, 5000); } catch (e) { r = null; }
          if (!r) { C.helper.alive = false; break; }              // not answering: keep everything, try again soon
          if (r.success || (r.httpOk === false && /required|must/.test(r.error || ''))) C.outbox = C.outbox.filter(function (x) { return x !== it; });
          else break;
        }
        saveOutbox();
      } finally { flushing = false; }
      changed();
    }
    async function retry(clipId) {
      try { var r = await helperPost('/clip-retry', { clipId: clipId }, 4000); toast(r.success ? '🔁 Trying that clip again' : (r.error || 'Could not retry'), r.success ? '' : 'err'); }
      catch (e) { toast('The Tennis Clipper is not answering on this PC', 'err'); }
      await loadJobs(); changed();
    }

    /* ---------- the website's clips ---------- */
    async function loadClips() {
      var r = await TN.api('GET', '/api/tennis/matches/' + o.matchId + '/clips');
      if (r.ok) {
        var next = new Map(), byClip = new Map();
        (r.json.clips || []).forEach(function (c) { if (c.eventId) next.set(c.eventId, c); byClip.set(c.clipId, c); });
        C.clips = next; C.byClip = byClip; changed();
      }
    }
    function onClip(d) {
      if (!d || d.matchId !== o.matchId || !d.clip) return;
      if (d.clip.eventId) C.clips.set(d.clip.eventId, Object.assign(C.clips.get(d.clip.eventId) || {}, d.clip));
      C.byClip.set(d.clip.clipId, Object.assign(C.byClip.get(d.clip.clipId) || {}, d.clip));
      changed();
      clearTimeout(C.clipsTimer); C.clipsTimer = setTimeout(loadClips, 1500);
    }

    /* ---------- the state, as the operator reads it ---------- */
    function counts() {
      var k = { processing: 0, failed: 0, upload: 0, offline: 0, done: 0, queued: 0 };
      C.outbox.forEach(function (x) { if (x.k === 'clip') k.queued++; });
      C.jobs.forEach(function (j) {
        var s = j.syncStatus;
        if (s === 'WAITING' || s === 'CUTTING' || s === 'CUT_RETRY') k.processing++;
        else if (s === 'CUT_FAILED') k.failed++;
        else if (s === 'OFFLINE_PENDING') { k.offline++; k.upload++; }
        else if (s === 'SYNC_COMPLETE') k.done++;
        else k.upload++;
      });
      k.processing += k.queued;
      return k;
    }
    function model() {
      var s = C.helper.status || {}, k = counts();
      var win = s.tennisClipTiming ? { pre: s.tennisClipTiming.beforeSeconds, post: s.tennisClipTiming.afterSeconds } : windowOf();
      var helperOk = C.helper.alive === true && Date.now() - C.helper.at < 12000;
      var rec = s.currentRecordingFile ? String(s.currentRecordingFile).split(/[\\/]/).pop() : null;
      var recOk = helperOk && !!rec && !!s.recordingGrowing && !s.recordingError;
      var matchOk = helperOk && s.matchId === o.matchId && s.sport === 'tennis';
      var siteOk = helperOk && s.mainServerUrl === location.origin;
      var checks = [
        { ok: helperOk && isTennisClipper(s), label: 'Tennis Clipper on this PC', detail: helperOk ? (isTennisClipper(s) ? 'Running (TennisClipper v' + (s.helperVersion || '?') + ')' : 'Something else answers on port 5009') : 'Not running — ▶ Start Clipper' },
        { ok: matchOk, label: 'This match', detail: matchOk ? sideName('A') + ' v ' + sideName('B') : helperOk ? (s.matchId && s.matchId !== o.matchId ? 'Set up for another match — Start Clipper sets it to this one' : 'Not handed over yet') : '—' },
        { ok: recOk, label: 'vMix recording (the tennis recording folder)', detail: !helperOk ? '—' : s.recordingError ? s.recordingError : !rec ? 'No recording found — check the Tennis Clipper’s own recording folder' : !s.recordingGrowing ? rec + ' is not being written — start Record in vMix' : rec + ' · ' + Math.round((s.recordingSeconds || 0) / 60) + ' min recorded' },
        { ok: siteOk, label: 'Website link', detail: siteOk ? location.host : helperOk ? 'Set when clipping starts' : '—' }
      ];
      var owner = C.owner && C.owner.live ? C.owner : null;
      var elsewhere = owner && (!C.session || owner.sessionId !== C.session.id);
      var state, text;
      if (C.busy === 'starting') { state = 'STARTING'; text = 'Starting the Tennis Clipper…'; }
      else if (C.busy === 'stopping') { state = 'STARTING'; text = 'Stopping…'; }
      else if (!on() || !mine()) {
        if (elsewhere) { state = owner.status && owner.status.state ? owner.status.state : 'READY'; text = (owner.label || 'Another device') + ' is clipping' + (owner.status && owner.status.text ? ' — ' + owner.status.text : ''); }
        else { state = 'STOPPED'; text = 'Clipping is off — points are not clipped'; }
      } else if (!checks[0].ok) { state = 'WARNING'; text = helperOk ? 'This is not the Tennis Clipper' : 'The Tennis Clipper is not running on this PC'; }
      else if (!checks[2].ok) { state = 'WARNING'; text = !rec ? 'No vMix recording found' : !s.recordingGrowing ? 'vMix is not recording' : 'The recording cannot be read'; }
      else if (!matchOk || !siteOk) { state = 'WARNING'; text = 'Setting the Clipper up for this match…'; }
      else if (k.failed) { state = 'WARNING'; text = k.failed + ' clip' + (k.failed === 1 ? '' : 's') + ' could not be cut — retry'; }
      else if (k.processing) { state = 'PROCESSING'; text = k.processing + ' clip' + (k.processing === 1 ? '' : 's') + ' being made'; }
      else { state = 'READY'; text = 'Recording detected · ' + win.pre + ' s before + ' + win.post + ' s after each point'; }
      return { state: state, text: text, checks: checks, counts: k, window: win, owner: owner, elsewhere: !!elsewhere, mine: mine(), on: on(), notice: C.notice, outbox: C.outbox.length };
    }
    function clipState(j, sc, queued, voided) {
      if (voided) return { k: 'CANCELLED', text: 'Point undone — clip kept', cls: 'mute' };
      if (j) {
        var s = j.syncStatus;
        if (s === 'WAITING') return { k: 'WAITING', text: 'Waiting for the footage', cls: 'wait' };
        if (s === 'CUTTING' || s === 'CUT_RETRY') return { k: 'CUTTING', text: 'Cutting', cls: 'wait' };
        if (s === 'CUT_FAILED') return { k: 'FAILED', text: 'Could not be cut', cls: 'bad', retry: true };
        if (s === 'OFFLINE_PENDING') return { k: 'UPLOAD', text: 'Saved on this PC · waiting for internet', cls: 'ok' };
        if (s === 'SYNC_COMPLETE') return { k: 'READY', text: 'Ready · uploaded', cls: 'ok' };
        return { k: 'UPLOAD', text: 'Saved on this PC · uploading', cls: 'ok' };
      }
      if (queued) return { k: 'QUEUED', text: C.helper.alive ? 'Queued' : 'Queued — waiting for the Clipper', cls: 'wait' };
      if (sc) {
        var d = sc.displayStatus || '';
        if (/complete|Saved on the website/i.test(d)) return { k: 'READY', text: 'Ready', cls: 'ok' };
        if (/Failed/.test(d)) return { k: 'FAILED', text: 'Upload failed', cls: 'bad', serverRetry: true };
        if (/Uploading|pending/i.test(d)) return { k: 'UPLOAD', text: d, cls: 'ok' };
        if (/Saved locally/.test(d)) return { k: 'UPLOAD', text: 'Saved on the Clipper PC', cls: 'ok' };
        if (/Processing/.test(d)) return { k: 'CUTTING', text: 'Cutting', cls: 'wait' };
        if (/post-roll|Pending/i.test(d)) return { k: 'WAITING', text: 'Waiting for the footage', cls: 'wait' };
        if (/Unavailable/.test(d)) return { k: 'FAILED', text: 'No clip', cls: 'bad' };
        return { k: 'QUEUED', text: d || 'Pending', cls: 'wait' };
      }
      return null;
    }
    function clipRow(e) {
      var clipId = o.matchId + '_' + e.eventId;
      var j = C.jobs.get(clipId), sc = C.clips.get(e.eventId) || null;
      var queued = C.outbox.some(function (x) { return x.k === 'clip' && x.clipId === clipId; });
      var a = attributionOf(e);
      var snap = e.after || e.before || null;
      return { eventId: e.eventId, clipId: clipId, set: snap ? snap.set : null, game: e.before ? e.before.game : null, pointNo: e.pointNo || null, side: e.side, kind: a.kind, players: a.players,
        score: e.after ? e.after : null, state: clipState(j, sc, queued, !!e.voided), seconds: (j && j.clipSeconds) || (sc && sc.actual && sc.actual.durationSec) || null,
        watchUrl: sc && sc.watchUrl ? sc.watchUrl : null, error: (j && j.error) || (sc && sc.error) || null, voided: !!e.voided };
    }
    function recent(limit) {
      var tl = (o.getTimeline() || []).filter(function (e) { return e.type === 'POINT' && !e.invalid; });
      var rows = [];
      for (var i = tl.length - 1; i >= 0 && rows.length < (limit || 40); i--) { var r = clipRow(tl[i]); if (r.state) rows.push(r); }
      return rows;
    }
    function manualRows() {
      var rows = [];
      C.byClip.forEach(function (c) { if (!c.eventId) rows.push(c); });
      C.outbox.forEach(function (x) { if (x.k === 'clip' && /_clip-/.test(x.clipId) && !C.byClip.has(x.clipId)) rows.push({ clipId: x.clipId, kind: x.body.point.kind, displayStatus: 'Queued', players: x.body.point.players }); });
      return rows.slice(-20).reverse();
    }

    /* ---------- the loop ---------- */
    var lastJobs = 0, lastClips = 0, timer = null;
    async function tick() {
      clearTimeout(timer);
      try {
        await ping();
        if (C.helper.alive && on() && mine()) {
          var s = C.helper.status || {};
          if (s.matchId !== o.matchId || s.sport !== 'tennis' || s.mainServerUrl !== location.origin) await claimHelper(false);
          if (C.outbox.length) await flush();
        }
        var active = counts().processing > 0 || C.outbox.length > 0;
        if (C.helper.alive && Date.now() - lastJobs > (active ? 2000 : 6000)) { lastJobs = Date.now(); await loadJobs(); }
        if (Date.now() - lastClips > 20000) { lastClips = Date.now(); loadClips(); }
        if (on()) await beat();
        if (on() && !mine() && C.owner && C.session && C.owner.sessionId === C.session.id && C.owner.stoppedAt) lose(null);
      } catch (e) { console.error(e); }
      changed();
      timer = setTimeout(tick, on() || C.busy ? 2500 : 8000);
    }
    async function resume() {
      await ping();
      if (on()) {
        var r = await claimSession(false);
        if (!r.ok && r.code === 'CLIPPER_ELSEWHERE') lose(r.owner);
        else if (r.ok && C.helper.alive) await claimHelper(false);
      }
      loadClips(); tick();
    }
    if (o.socket) { o.socket.on('tn:clipper', onClipper); o.socket.on('tn:clip', onClip); }
    resume();

    return {
      state: C, model: model, start: start, stop: stop, quitApp: quitApp, point: point, remotePoint: remotePoint, manual: manual, reconcile: reconcile,
      retry: retry, recent: recent, manualRows: manualRows, refresh: function () { lastJobs = 0; lastClips = 0; tick(); }, loadClips: loadClips,
      row: function (eventId) { var e = (o.getTimeline() || []).filter(function (x) { return x.eventId === eventId; })[0]; return e ? clipRow(e) : null; },
      setupUrl: HELPER + '/setup', mine: mine, on: on
    };
  }

  /* ---------- the view: the panel's Clips tab and the Clipper page ---------- */
  var WORD = { READY: ['ok', 'READY'], PROCESSING: ['wait', 'PROCESSING'], WARNING: ['bad', 'WARNING'], STOPPED: ['off', 'STOPPED'], STARTING: ['wait', 'STARTING'] };
  var esc = function (v) { return TN.esc(v); };
  function chip(ctl) {
    var md = ctl.model(), w = WORD[md.state] || WORD.STOPPED;
    return '<button class="chip ' + (w[0] === 'ok' ? 'on' : w[0] === 'bad' ? 'bad' : w[0] === 'wait' ? 'warn' : '') + '" id="clpChip" title="' + esc(md.text) + '"><span class="dot ' + (w[0] === 'off' ? '' : w[0]) + '"></span>🎬 Clipper · ' + w[1] + (md.elsewhere ? ' · ' + esc((md.owner && md.owner.label) || 'another PC') : '') + '</button>';
  }
  function who(r) {
    if (r.voided) return '<span class="muted">—</span>';
    var credited = (r.players || []).filter(function (p) { return p.role !== 'won'; })[0] || (r.players || [])[0];
    return (credited && credited.name ? esc(credited.name) + ' · ' : '') + '<span class="muted">' + esc(window.TennisStats ? window.TennisStats.CLIP_KINDS[r.kind] || r.kind : r.kind) + '</span>';
  }
  function paint(ctl, el, opts) {
    opts = opts || {};
    var md = ctl.model(), w = WORD[md.state] || WORD.STOPPED, k = md.counts;
    var rows = ctl.recent(30), manual = ctl.manualRows();
    var active = md.on && md.mine;
    var helpOpen = !!(el.querySelector('.clpfirst') && el.querySelector('.clpfirst').open);
    var startLabel = md.state === 'STARTING' ? 'Starting…' : md.elsewhere ? 'Clip on this PC instead' : '▶ Start Clipper';
    el.innerHTML = '<div class="clphead ' + w[0] + '"><span class="clpword">' + w[1] + '</span><div class="grow"><b>' + esc(md.text) + '</b>'
      + '<div class="small muted">Each point: ' + md.window.pre + ' s of the rally before the press + ' + md.window.post + ' s after · cut from the vMix recording on the PC that records</div></div>'
      + (active ? '<button class="btn" id="clpStop">Stop clipping</button>' : '<button class="btn primary" id="clpStart"' + (md.state === 'STARTING' ? ' disabled' : '') + '>' + startLabel + '</button>') + '</div>'
      + (md.notice ? '<div class="banner warn" style="margin-top:10px">' + esc(md.notice) + '</div>' : '')
      + '<div class="clpchecks">' + md.checks.map(function (c) { return '<div class="' + (c.ok ? 'ok' : active ? 'bad' : '') + '"><i>' + (c.ok ? '✓' : active ? '!' : '·') + '</i><b>' + esc(c.label) + '</b><span>' + esc(c.detail) + '</span></div>'; }).join('') + '</div>'
      + '<div class="clpcounts small"><span><b>' + k.done + '</b> uploaded</span><span><b>' + k.upload + '</b> saved · uploading' + (k.offline ? ' (' + k.offline + ' waiting for internet)' : '') + '</span><span><b>' + k.processing + '</b> being made</span>' + (k.failed ? '<span class="bad"><b>' + k.failed + '</b> could not be cut</span>' : '') + '</div>'
      + '<h4 style="margin:14px 0 6px">Recent point clips</h4><div class="clprows">'
      + (rows.length ? rows.map(function (r) {
        return '<div class="clprow' + (r.voided ? ' void' : '') + '"><span class="pt"><b>S' + (r.set || '?') + ' G' + (r.game || '?') + '</b><small>' + (r.voided ? 'No longer counts' : 'Point ' + (r.pointNo || '?')) + '</small></span>'
          + '<span class="tmn"><span class="tm" style="background:' + (r.side === 'A' ? 'var(--ca)' : 'var(--cb)') + '"></span>' + esc(r.side ? (r.side === 'A' ? 'A' : 'B') : '') + '</span>'
          + '<span class="whoc ellipsis">' + who(r) + '</span><span class="dur">' + (r.seconds ? Number(r.seconds).toFixed(1) + ' s' : '') + '</span>'
          + '<span class="clipst ' + r.state.cls + '" title="' + esc(r.error || r.state.text) + '">' + esc(r.state.text) + '</span>'
          + '<span class="acts">' + (r.watchUrl ? '<button class="btn xs" data-play="' + esc(r.eventId) + '">▶</button>' : '') + (r.state.retry ? '<button class="btn xs" data-retry="' + esc(r.clipId) + '">Retry</button>' : '') + (r.state.serverRetry ? '<button class="btn xs" data-sretry="' + esc(r.clipId) + '">Retry upload</button>' : '') + '</span></div>';
      }).join('') : '<div class="muted small">No point clips yet — they appear here as points are scored.</div>') + '</div>'
      + (manual.length ? '<h4 style="margin:14px 0 6px">Clips by hand</h4><div class="clprows">' + manual.map(function (c) { return '<div class="clprow"><span class="pt"><b>' + esc(c.kindLabel || (window.TennisStats ? window.TennisStats.CLIP_KINDS[c.kind] : c.kind) || 'Clip') + '</b><small>' + esc(c.set ? 'S' + c.set + (c.game ? ' G' + c.game : '') : '') + '</small></span><span class="tmn"></span><span class="whoc ellipsis">' + esc(((c.players || [])[0] && (c.players || [])[0].name) || '') + '</span><span class="dur">' + (c.actual && c.actual.durationSec ? Number(c.actual.durationSec).toFixed(1) + ' s' : '') + '</span><span class="clipst wait">' + esc(c.displayStatus || 'Queued') + '</span><span class="acts">' + (c.watchUrl ? '<a class="btn xs" href="' + esc(c.watchUrl) + '" target="_blank" rel="noopener">▶</a>' : '') + '</span></div>'; }).join('') + '</div>' : '')
      + '<details class="clpfirst"' + (helpOpen ? ' open' : '') + '><summary>First time on this PC, or something not working?</summary><ol class="small">'
      + '<li>Tennis has its <b>own</b> Clipper program, <b>TennisClipper.exe</b> (next to vMix) — separate from the Cricket Clipper and the Volleyball Clipper, which it never starts, stops or changes. Keep it in its own folder, get the <a href="/tennis-clipper-launcher.zip">Tennis Clipper Launcher</a>, unzip it there and run <code>install-tennis-clipper-launcher.bat</code> once — then <b>▶ Start Clipper</b> works from here.</li>'
      + '<li>Once per PC, tell it where vMix records <b>tennis</b>: <a href="' + esc(ctl.setupUrl) + '" target="_blank" rel="noopener">open Tennis Clipper setup</a> → the vMix recording folder → Save. It never borrows the cricket or volleyball folder.</li>'
      + '<li>vMix must record an MP4 (it is read while it is being written). Start <b>Record</b> in vMix — READY shows only once the recording is really growing.</li>'
      + (opts.matchId ? '<li>Scoring on a phone? Open the <a href="/tennis-clipper?match=' + esc(opts.matchId) + '" target="_blank" rel="noopener">Clipper page</a> on the vMix PC — it clips the points scored on the phone.</li>' : '')
      + '</ol>' + (active ? '<button class="btn xs ghost" id="clpQuit">Quit the Tennis Clipper on this PC</button>' : '') + '</details>';
    var q = function (s) { return el.querySelector(s); };
    if (q('#clpStart')) q('#clpStart').onclick = function () { ctl.start(); };
    if (q('#clpStop')) q('#clpStop').onclick = function () { TN.confirm('Stop clipping this match?', 'Points after this are not clipped until you start again. Clips already made are kept.', 'Stop clipping').then(function (y) { if (y) ctl.stop(); }); };
    if (q('#clpQuit')) q('#clpQuit').onclick = function () { ctl.quitApp(); };
    TN.$$('[data-retry]', el).forEach(function (b) { b.onclick = function () { ctl.retry(b.dataset.retry); }; });
    TN.$$('[data-sretry]', el).forEach(function (b) { b.onclick = function () { TN.api('POST', '/api/tennis/clips/' + encodeURIComponent(b.dataset.sretry) + '/retry', {}).then(function (r) { TN.toast(r.ok ? 'Upload retried' : (r.json.error || 'Could not retry'), r.ok ? '' : 'err'); ctl.loadClips(); }); }; });
    TN.$$('[data-play]', el).forEach(function (b) { b.onclick = function () { if (opts.onPlay) opts.onPlay(b.dataset.play); }; });
  }
  function play(ctl, eventId) {
    var list = ctl.recent(40).filter(function (r) { return r.watchUrl && !r.voided; }).reverse();
    var i = list.map(function (r) { return r.eventId; }).indexOf(eventId);
    if (i < 0) return;
    TN.playClips(list.map(function (r) {
      return { sources: [r.watchUrl], download: r.watchUrl + (r.watchUrl.indexOf('?') >= 0 ? '&' : '?') + 'download=1',
        title: 'Set ' + (r.set || '?') + ' · game ' + (r.game || '?') + ' · ' + (window.TennisStats ? window.TennisStats.CLIP_KINDS[r.kind] || '' : ''),
        sub: ['Point ' + (r.pointNo || '?'), (r.players[0] && r.players[0].name) || '', r.seconds ? Number(r.seconds).toFixed(1) + ' s' : ''].filter(Boolean).join(' · ') };
    }), i);
  }

  window.TNClipper = { create: create, chip: chip, paint: paint, play: play, HELPER: HELPER, LINK: LINK, isTennisClipper: isTennisClipper };
})();
