/* ================================================================
   🎬 VOLLEYBALL CLIPPER — the browser side of the SAME local Clipper
   Helper the Cricket Panel uses (clipper-helper/: ClipperHelper.exe next
   to vMix on the PC that records). Nothing here records, cuts or uploads:
   the helper cuts each clip from vMix's own recording file and syncs it;
   this file only tells it which match, which points, and who earned them.

     ▶ Start Clipper   the Clipper Launcher's asl-clipper:// link starts the
                       helper hidden (set up once per PC — the same launcher
                       as cricket); the website link and THIS match are
                       handed to it, and the match's clipping session is
                       claimed on the website (one device clips a match)
     every point       one clip job, "<matchId>_<the point's eventId>": the
                       moment of the press, the rally before it and the end
                       of it (the helper's volleyball window, 15 s + 3 s) —
                       queued here first, so a helper that is restarting
                       still gets it, and never twice
     who earned it     sent to the helper whenever the point's attribution
                       changes (or the point is undone), so the clip is
                       filed under the player on this PC; on the website the
                       clip follows the point itself
     READY             only when the helper answers, is set up for THIS
                       match, and a recording is being written right now

   Timing: a press made on this PC is sent with this PC's clock — the clock
   the helper maps onto the recording (its wall-clock ↔ file-time anchor,
   see clipper-helper/server.js). A point scored on ANOTHER device arrives
   stamped on the server's clock and is converted with this page's measured
   offset (VB.clock) before it is sent.
   ================================================================ */
(function () {
  'use strict';
  var HELPER = 'http://localhost:5005';          // the local helper (clipper-helper/) — cricket uses the same one
  var LINK = 'asl-clipper://';                   // the Clipper Launcher (clipper-helper/install-clipper-launcher.bat)
  var OUTBOX_MAX_AGE_MS = 8 * 60 * 60 * 1000;    // like the Cricket Panel's clip outbox
  var BEAT_MS = 10000;
  var RECORDING_STALE_MS = 15000;                // the helper's own "still growing" rule

  // How a point was won, for the operator — the same words everywhere.
  var TYPES = { kill: 'Kill', ace: 'Ace', block: 'Block', opp_error: 'Opponent error', team: 'Team point' };
  var OPP_ERRORS = { SERVICE_ERROR: 1, ATTACK_ERROR: 1, OPP_ERROR: 1, NET_FAULT: 1, FOUR_HITS: 1, DOUBLE_CONTACT: 1, BALL_OUT: 1, ROTATION_FAULT: 1, PENALTY: 1 };
  // a helper job's state, in the words the website keeps for a clip being made elsewhere
  var LOCAL_FOR = { WAITING: 'WAITING_FOR_POSTROLL', CUTTING: 'CUTTING', CUT_RETRY: 'CUTTING', CUT_FAILED: 'FAILED_PERMANENT', LOCAL_SAVED: 'LOCAL_SAVED', OFFLINE_PENDING: 'RETRY_PENDING', SENDING: 'FORWARDING', SENT: 'FORWARDING', SYNC_RETRY: 'RETRY_PENDING' };

  // The attribution a rally entry carries now (after corrections): its type,
  // and the players credited with it. pending = nobody has said yet.
  function attributionOf(entry, playerOf) {
    var none = { type: null, players: [], pending: false, voided: false };
    if (!entry || entry.type !== 'RALLY') return none;
    var p = entry.players || {}, o = entry.outcome, team = entry.team;
    var out = { type: null, players: [], pending: false, voided: !!entry.voided };
    var add = function (t, id, role) { if (!id) return; var x = playerOf ? playerOf(t, id) : null; out.players.push({ playerId: id, team: t, role: role, name: x ? x.name : null, number: x && x.number != null ? String(x.number) : null }); };
    var server = entry.rallyServer && entry.rallyServer.team === team ? entry.rallyServer.playerId : null;
    if (o === 'ACE' || o === 'RECEPTION_ERROR') { out.type = 'ace'; add(team, server, 'server'); }
    else if (o === 'ATTACK_KILL') { out.type = 'kill'; add(team, p.attacker, 'attacker'); }
    else if (o === 'BLOCK') { out.type = 'block'; (p.blockers || []).slice(0, 3).forEach(function (b) { add(team, b, 'blocker'); }); }
    else if (OPP_ERRORS[o]) out.type = 'opp_error';
    else if (p.attacker) { out.type = 'kill'; add(team, p.attacker, 'attacker'); }
    else if (entry.corrected && entry.corrected.length) out.type = 'team';
    else out.pending = true;
    return out;
  }

  function timeout(ms) {
    if (window.AbortSignal && AbortSignal.timeout) return AbortSignal.timeout(ms);
    var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal;
  }
  function helperGet(path, ms) {
    return fetch(HELPER + path, { signal: timeout(ms || 2500), cache: 'no-store' }).then(function (r) { return r.json(); });
  }
  function helperPost(path, body, ms) {
    return fetch(HELPER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: timeout(ms || 5000) })
      .then(function (r) { return r.json().then(function (j) { return Object.assign({ httpOk: r.ok }, j); }); });
  }
  function launch(action) {
    var a = document.createElement('a');
    a.href = LINK + action; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function deviceLabel() {
    var ua = navigator.userAgent || '';
    var os = /Windows/.test(ua) ? 'Windows PC' : /Mac OS X/.test(ua) && !/Mobile/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Linux/.test(ua) ? 'Linux PC' : 'this device';
    return os;
  }

  /* ---------------------------------------------------------------
     o: { matchId, getMatch(), getTournament(), getTimeline(), playerOf(team, id),
          role: 'panel' | 'clipper', label, onChange(), toast(msg, kind) }
     --------------------------------------------------------------- */
  function create(o) {
    var KEY = 'vb_clipper:' + o.matchId, OUT = 'vb_clip_out:' + o.matchId, SENT = 'vb_clip_sent:' + o.matchId;
    var C = {
      helper: { alive: null, status: null, at: 0, jobsAt: 0 },
      session: VB.store.get(KEY, null),          // { id, on } — this device clips this match
      owner: (o.getMatch() && o.getMatch().clipper) || null,   // the website's word on who clips
      jobs: new Map(), clips: new Map(),
      outbox: VB.store.get(OUT, []), sent: VB.store.get(SENT, {}),
      busy: null, notice: null, lastBeat: 0, lastStart: 0, startedFor: null, launchedAt: 0, relayed: {}
    };
    var toast = o.toast || function () {};
    var changed = function () { try { o.onChange && o.onChange(); } catch (e) { console.error(e); } };
    var saveSession = function () { if (C.session && C.session.on) VB.store.set(KEY, C.session); else VB.store.del(KEY); };
    var saveOutbox = function () { if (C.outbox.length) VB.store.set(OUT, C.outbox.slice(-400)); else VB.store.del(OUT); };
    var saveSent = function () { VB.store.set(SENT, C.sent); };

    function mine() {
      return !!(C.session && C.session.on && C.owner && C.owner.sessionId === C.session.id && !C.owner.stoppedAt);
    }
    function on() { return !!(C.session && C.session.on); }
    function match() { return o.getMatch() || {}; }
    function teamName(t) { var x = match()['team' + t]; return x ? x.name : 'Team ' + t; }

    /* ---------- the helper ---------- */
    async function ping() {
      try {
        var s = await helperGet('/status', 2500);
        C.helper = Object.assign(C.helper, { alive: true, status: s, at: Date.now() });
      } catch (e) {
        C.helper = Object.assign(C.helper, { alive: false, at: Date.now() });
      }
      return C.helper.alive;
    }
    async function loadJobs() {
      if (!C.helper.alive) return;
      try {
        var r = await helperGet('/clip-jobs?limit=80&matchId=' + encodeURIComponent(o.matchId), 3000);
        var next = new Map();
        ((r && r.jobs) || []).forEach(function (j) { next.set(j.clipId, j); });
        C.jobs = next; C.helper.jobsAt = Date.now();
        // every other device (a phone that scores) sees how each clip is doing here
        if (mine()) next.forEach(function (j, id) {
          var st = LOCAL_FOR[j.syncStatus];
          if (!st || C.relayed[id] === st || j.sport !== 'volleyball') return;
          C.relayed[id] = st;
          VB.api('POST', '/api/volleyball/clips/' + encodeURIComponent(id) + '/local', { status: st, error: j.error || null });
        });
      } catch (e) { /* the next round */ }
    }
    // the helper set up for THIS match: website link + match + sport
    async function claimHelper(force) {
      var s = C.helper.status;
      if (!s) return false;
      if (!force && s.matchId === o.matchId && s.sport === 'volleyball' && s.mainServerUrl === location.origin) return true;
      if (!force && Date.now() - C.lastStart < 20000) return false;
      C.lastStart = Date.now();
      var m = match(), t = o.getTournament ? o.getTournament() : null;
      try {
        if (!s.mainServerUrl && /^https?:$/.test(location.protocol)) await helperPost('/setup', { websiteUrl: location.origin }, 3000);
        await helperPost('/recording-start', {
          startedAt: Date.now(), matchId: o.matchId, mainServerUrl: location.origin, sport: 'volleyball',
          matchLabel: (m.teamA ? m.teamA.name : 'Team A') + ' v ' + (m.teamB ? m.teamB.name : 'Team B'),
          tournamentId: m.tournamentId || null, tournamentName: (t && t.name) || null
        }, 4000);
        C.startedFor = o.matchId;
        await ping();
        return true;
      } catch (e) { return false; }
    }

    /* ---------- the website's clipping session ---------- */
    function statusForServer() {
      var md = model();
      var s = C.helper.status || {};
      var k = md.counts;
      return { state: md.state === 'STARTING' ? 'STARTING' : md.state, text: md.text,
        recording: { file: s.currentRecordingFile ? String(s.currentRecordingFile).split(/[\\/]/).pop() : null, seconds: s.recordingSeconds, growing: !!s.recordingGrowing },
        counts: { processing: k.processing, failed: k.failed, upload: k.upload, offline: k.offline, done: k.done, unassigned: k.unassigned },
        online: typeof s.online === 'boolean' ? s.online : null, window: md.window ? { pre: md.window.pre, post: md.window.post } : null };
    }
    async function claimSession(force) {
      var r = await VB.api('POST', '/api/volleyball/matches/' + o.matchId + '/clipper', { action: 'start', sessionId: C.session.id, label: o.label || deviceLabel(), deviceId: VB.deviceId(), force: !!force, status: statusForServer() });
      if (r.ok) { C.owner = r.json.clipper; C.lastBeat = Date.now(); return { ok: true }; }
      return { ok: false, status: r.status, code: r.json && r.json.code, owner: r.json && r.json.clipper, error: r.json && r.json.error };
    }
    async function beat() {
      if (!on() || Date.now() - C.lastBeat < BEAT_MS) return;
      C.lastBeat = Date.now();
      var r = await VB.api('POST', '/api/volleyball/matches/' + o.matchId + '/clipper', { action: 'beat', sessionId: C.session.id, status: statusForServer() });
      if (r.ok) { C.owner = r.json.clipper; return; }
      if (r.status === 409) lose(r.json && r.json.clipper);
    }
    function lose(owner) {
      C.owner = owner || C.owner;
      C.session = null; saveSession();
      C.notice = owner && owner.live ? 'Clipping moved to ' + (owner.label || 'another device') + ' — this device stopped sending clips.' : 'Clipping was stopped on another device.';
      toast('🎬 ' + C.notice, 'err');
      changed();
    }
    function onClipper(d) {
      if (!d || d.matchId !== o.matchId) return;
      C.owner = d.clipper;
      if (on() && C.owner && C.owner.sessionId !== C.session.id && C.owner.live) lose(C.owner);
      else changed();
    }

    /* ---------- Start / Stop ---------- */
    // Call straight from the click (the launcher link must be the operator's own click).
    async function start(opts) {
      opts = opts || {};
      if (C.busy) return;
      C.notice = null;
      var known = C.helper.alive && Date.now() - C.helper.at < 10000;
      if (!known) { launch('start'); C.launchedAt = Date.now(); }
      C.busy = 'starting'; changed();
      var until = Date.now() + 45000, up = known;
      while (!up && Date.now() < until) { if (await ping()) { up = true; break; } await new Promise(function (r) { setTimeout(r, 700); }); }
      if (!up) {
        C.busy = null;
        C.notice = 'The Clipper app did not start on this PC. First time here? Set up the Clipper Launcher once (below). Already did? Look in clipper-log.txt next to ClipperHelper.exe.';
        changed(); return;
      }
      if (!C.helper.status || C.helper.status.volleyball !== true) {
        C.busy = null;
        C.notice = 'This PC’s Clipper app is an older version that does not know volleyball points — update ClipperHelper.exe (clipper-helper: npm run build), then start it again.';
        changed(); return;
      }
      C.session = { id: (C.session && C.session.id) || 'clp-' + VB.uid().slice(0, 18), on: true };
      saveSession();
      var r = await claimSession(!!opts.force);
      if (!r.ok && r.code === 'CLIPPER_ELSEWHERE') {
        C.busy = null;
        var who = (r.owner && r.owner.label) || 'another device';
        var yes = await VB.confirm('Clip this match here instead?', who + ' is clipping this match right now (seen ' + VB.ago(r.owner && r.owner.lastSeenAt) + '). Only one device clips a match, so the same point is never cut twice from two recordings. Moving it here stops ' + who + ' from sending clips.', 'Clip here');
        if (!yes) { C.session = null; saveSession(); changed(); return; }
        C.busy = 'starting';
        r = await claimSession(true);
      }
      if (!r.ok) { C.busy = null; C.session = null; saveSession(); C.notice = (r.error || 'The website did not accept the clipping session') + (r.status === 0 ? '' : ''); changed(); return; }
      await claimHelper(true);
      await loadJobs();
      C.busy = null;
      flush();
      changed();
      toast(model().state === 'READY' ? '🎬 Clipper READY — every point is clipped from the vMix recording' : '🎬 Clipper on — ' + model().text);
    }
    async function stop() {
      if (!on() || C.busy) return;
      C.busy = 'stopping'; changed();
      var st = statusForServer();
      await VB.api('POST', '/api/volleyball/matches/' + o.matchId + '/clipper', { action: 'stop', sessionId: C.session.id, status: st });
      C.session = null; saveSession();
      C.busy = null;
      var k = model().counts;
      C.notice = k.processing ? k.processing + ' clip' + (k.processing === 1 ? ' is' : 's are') + ' still being made — they finish in the background. No new points are clipped until you start again.' : 'Clipping stopped. Clips already made are kept; no new points are clipped until you start again.';
      changed();
    }
    // The helper app itself (like the Cricket Panel's Stop): only on request.
    async function quitApp() {
      var pending = Array.from(C.jobs.values()).filter(function (j) { return ['WAITING', 'CUTTING', 'CUT_RETRY', 'LOCAL_SAVED', 'OFFLINE_PENDING', 'SENDING', 'SENT', 'SYNC_RETRY'].indexOf(j.syncStatus) >= 0; }).length;
      var ok = await VB.confirm('Quit the Clipper app on this PC?', pending ? pending + ' clip' + (pending === 1 ? ' is' : 's are') + ' not finished yet — they wait on this PC and carry on the next time the Clipper starts (nothing is lost or cut twice).' : 'No clips are waiting. vMix keeps recording; only clipping stops.', 'Quit Clipper', true);
      if (!ok) return;
      launch('stop');
      setTimeout(function () { ping().then(changed); }, 2500);
    }

    /* ---------- points ---------- */
    function pointMeta(ev, entry) {
      var m = match(), t = o.getTournament ? o.getTournament() : null;
      var team = (entry && entry.team) || ev.winner;
      var tm = m['team' + team] || {};
      var a = attributionOf(entry, o.playerOf);
      var after = entry && entry.after ? entry.after : null;
      return {
        eventId: ev.eventId, set: after ? after.set : null, pointNo: entry ? entry.pointNo || null : null, team: team,
        teamId: tm.teamId || null, teamName: tm.name || null, teamShort: tm.shortName || null,
        teamNames: { A: m.teamA ? m.teamA.name : null, B: m.teamB ? m.teamB.name : null },
        score: after ? after.score : null, outcome: entry ? entry.outcome : ev.outcome || null,
        attribution: a.type, players: a.players, vbClipToken: m.clipToken || null, at: ev.at || null,
        tournamentName: (t && t.name) || null
      };
    }
    function queue(item) {
      C.outbox = C.outbox.filter(function (x) { return !(x.k === item.k && x.clipId === item.clipId); });
      C.outbox.push(item); saveOutbox();
    }
    // A point scored (here: localAt is this PC's clock; remote: converted from the server's)
    function point(ev, entry, localAt) {
      if (!ev || ev.type !== 'RALLY' || !mine()) return false;
      var clipId = o.matchId + '_' + ev.eventId;
      if (C.jobs.has(clipId) || C.outbox.some(function (x) { return x.k === 'clip' && x.clipId === clipId; })) return true;   // already on its way
      var meta = pointMeta(ev, entry);
      var t0 = Math.round(localAt != null ? localAt : (ev.at || Date.now()) - VB.clock.offset);
      var m = match(), t = o.getTournament ? o.getTournament() : null;
      queue({ k: 'clip', clipId: clipId, at: Date.now(), body: {
        sport: 'volleyball', matchId: o.matchId, clipId: clipId, timestamp: t0, sessionId: C.session.id, point: meta,
        matchLabel: (m.teamA ? m.teamA.name : 'Team A') + ' v ' + (m.teamB ? m.teamB.name : 'Team B'), tournamentId: m.tournamentId || null, tournamentName: (t && t.name) || null
      } });
      C.sent[clipId] = JSON.stringify([meta.attribution, meta.players.map(function (x) { return x.playerId; }), false]); saveSent();
      C.lastPointAt = Date.now();
      // the website hears that this point's clip is on its way (another
      // device shows it; the clip itself arrives from the helper)
      var win = model().window || { pre: 15, post: 3 };
      VB.api('POST', '/api/volleyball/matches/' + o.matchId + '/clips', { clipId: clipId, eventId: ev.eventId, status: 'REQUESTED', localStatus: 'WAITING_FOR_POSTROLL', t0: ev.at, preRollSec: win.pre, postRollSec: win.post, team: meta.team, scoreAtTrigger: meta.score ? { set: meta.set, A: meta.score.A, B: meta.score.B } : null, engine: 'clipper-helper', sourceSessionId: C.session.id });
      flush();
      changed();
      return true;
    }
    // A point scored on another device, as the match feed tells it.
    function remotePoint(ev, entry) {
      if (!ev || ev.type !== 'RALLY') return false;
      if (Date.now() - ((ev.at || 0) - VB.clock.offset) > 30 * 60000) return false;   // too old for the recording to matter
      return point(ev, entry, null);
    }
    // The timeline changed: tell the helper about any point whose
    // attribution (or undone state) is not what it last heard.
    function reconcile() {
      if (!mine()) return;
      var tl = o.getTimeline() || [];
      var byId = {};
      tl.forEach(function (e) { if (e.type === 'RALLY') byId[e.eventId] = e; });
      var moved = false;
      Object.keys(C.sent).forEach(function (clipId) {
        var eid = clipId.slice(o.matchId.length + 1);
        var e = byId[eid];
        if (!e) return;
        var a = attributionOf(e, o.playerOf);
        var sig = JSON.stringify([a.type, a.players.map(function (x) { return x.playerId; }), !!e.voided]);
        if (sig === C.sent[clipId]) return;
        C.sent[clipId] = sig;
        queue({ k: 'meta', clipId: clipId, at: Date.now(), body: { clipId: clipId, sport: 'volleyball', point: { attribution: a.type, players: a.players, outcome: e.outcome, voided: !!e.voided } } });
        moved = true;
      });
      if (moved) { saveSent(); flush(); }
      // keep the record small: only points still in the timeline
      if (Object.keys(C.sent).length > 600) { var keep = {}; Object.keys(C.sent).slice(-400).forEach(function (k) { keep[k] = C.sent[k]; }); C.sent = keep; saveSent(); }
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
          if (it.k === 'meta' && C.outbox.some(function (x) { return x.k === 'clip' && x.clipId === it.clipId; })) continue;   // its press first
          var r = null;
          try { r = await helperPost(it.k === 'clip' ? '/clip' : '/clip-meta', it.body, 5000); } catch (e) { r = null; }
          if (!r) { C.helper.alive = false; break; }            // the helper is not answering — keep everything, try again soon
          if (r.success || (r.httpOk === false && /required|must/.test(r.error || ''))) {
            C.outbox = C.outbox.filter(function (x) { return x !== it; });
            if (it.k === 'clip' && r.success && r.recordingActive === false) C.noFootage = Date.now();
          } else break;
        }
        saveOutbox();
      } finally { flushing = false; }
      changed();
    }
    async function retry(clipId) {
      try { var r = await helperPost('/clip-retry', { clipId: clipId }, 4000); toast(r.success ? '🔁 Trying that clip again' : (r.error || 'Could not retry'), r.success ? '' : 'err'); }
      catch (e) { toast('The Clipper app is not answering on this PC', 'err'); }
      await loadJobs(); changed();
    }

    /* ---------- the website's clips (every device sees these) ---------- */
    async function loadClips() {
      var r = await VB.api('GET', '/api/volleyball/matches/' + o.matchId + '/clips');
      if (r.ok) { var next = new Map(); (r.json.clips || []).forEach(function (c) { next.set(c.eventId, c); }); C.clips = next; C.clipsAt = Date.now(); changed(); }
    }
    function onClip(d) {
      if (!d || d.matchId !== o.matchId || !d.clip) return;
      C.clips.set(d.clip.eventId, Object.assign(C.clips.get(d.clip.eventId) || {}, d.clip));
      changed();
      clearTimeout(C.clipsTimer); C.clipsTimer = setTimeout(loadClips, 1500);   // the full record (players, attribution, playback)
    }

    /* ---------- the state, as the operator reads it ---------- */
    function counts() {
      var k = { processing: 0, failed: 0, upload: 0, offline: 0, done: 0, unassigned: 0, queued: 0 };
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
      var tl = o.getTimeline ? o.getTimeline() || [] : [];
      tl.forEach(function (e) { if (e.type === 'RALLY' && !e.voided && !e.invalid && attributionOf(e).pending && (C.jobs.has(o.matchId + '_' + e.eventId) || C.clips.has(e.eventId))) k.unassigned++; });
      return k;
    }
    function model() {
      var s = C.helper.status || {};
      var k = counts();
      var win = s.volleyballClipTiming ? { pre: s.volleyballClipTiming.beforeSeconds, post: s.volleyballClipTiming.afterSeconds } : null;
      var checks = [];
      var helperOk = C.helper.alive === true && Date.now() - C.helper.at < 12000;
      var rec = s.currentRecordingFile ? String(s.currentRecordingFile).split(/[\\/]/).pop() : null;
      var recOk = helperOk && !!rec && !!s.recordingGrowing && !s.recordingError && s.recordingSeconds != null;
      var matchOk = helperOk && s.matchId === o.matchId && s.sport === 'volleyball';
      var siteOk = helperOk && s.mainServerUrl === location.origin;
      checks.push({ ok: helperOk && s.volleyball === true, label: 'Clipper app on this PC', detail: helperOk ? (s.volleyball === true ? 'Running (v' + (s.helperVersion || '?') + ')' : 'Running, but an older version — update ClipperHelper.exe') : 'Not running — ▶ Start Clipper' });
      checks.push({ ok: matchOk, label: 'This match', detail: matchOk ? teamName('A') + ' v ' + teamName('B') : helperOk ? (s.matchId && s.matchId !== o.matchId ? 'The Clipper is set up for another match — Start Clipper sets it to this one' : 'Not handed over yet') : '—' });
      checks.push({ ok: recOk && !s.recordingAmbiguous, label: 'vMix recording', detail: !helperOk ? '—' : s.recordingError ? s.recordingError : !rec ? 'No recording found — check the recording folder in Clipper setup' : !s.recordingGrowing ? rec + ' is not being written — start Record in vMix' : s.recordingAmbiguous ? 'More than one file is being written (' + s.recordingAmbiguous.join(', ') + ') — clips use ' + rec + '; stop the other recording' : rec + ' · ' + Math.round((s.recordingSeconds || 0) / 60) + ' min recorded' });
      checks.push({ ok: siteOk, label: 'Website link', detail: siteOk ? location.host : helperOk ? 'Set when clipping starts' : '—' });
      var owner = C.owner && C.owner.live ? C.owner : null;
      var elsewhere = owner && (!C.session || owner.sessionId !== C.session.id);
      var state, text;
      if (C.busy === 'starting') { state = 'STARTING'; text = 'Starting the Clipper…'; }
      else if (C.busy === 'stopping') { state = 'STARTING'; text = 'Stopping…'; }
      else if (!on() || !mine()) {
        if (elsewhere) { state = owner.status && owner.status.state ? owner.status.state : 'READY'; text = (owner.label || 'Another device') + ' is clipping' + (owner.status && owner.status.text ? ' — ' + owner.status.text : ''); }
        else { state = 'STOPPED'; text = 'Clipping is off — points are not clipped'; }
      } else if (!checks[0].ok) { state = 'WARNING'; text = helperOk ? 'Update the Clipper app on this PC' : 'The Clipper app is not running on this PC'; }
      else if (!checks[2].ok) { state = 'WARNING'; text = !rec ? 'No vMix recording found' : !s.recordingGrowing ? 'vMix is not recording' : s.recordingAmbiguous ? 'Two recordings are being written' : 'The recording cannot be read'; }
      else if (!matchOk || !siteOk) { state = 'WARNING'; text = 'Setting the Clipper up for this match…'; }
      else if (k.failed) { state = 'WARNING'; text = k.failed + ' clip' + (k.failed === 1 ? '' : 's') + ' could not be cut — retry'; }
      else if (k.processing) { state = 'PROCESSING'; text = k.processing + ' clip' + (k.processing === 1 ? '' : 's') + ' being made'; }
      else { state = 'READY'; text = 'Recording detected · ' + (win ? win.pre + ' s before + ' + win.post + ' s after each point' : 'every point is clipped'); }
      return { state: state, text: text, checks: checks, counts: k, window: win, owner: owner, elsewhere: !!elsewhere, mine: mine(), on: on(), notice: C.notice, recording: rec,
        online: typeof s.online === 'boolean' ? s.online : null, outbox: C.outbox.length };
    }

    // One clip, as a row: the point, the team, who earned it, the state.
    function clipRow(e) {
      var clipId = o.matchId + '_' + e.eventId;
      var j = C.jobs.get(clipId), sc = C.clips.get(e.eventId) || null;
      var queued = C.outbox.some(function (x) { return x.k === 'clip' && x.clipId === clipId; });
      var a = attributionOf(e, o.playerOf);
      var st = clipState(j, sc, queued, e);
      var snap = e.after || e.before || null;   // an undone point has no "after": its set from before it
      return { eventId: e.eventId, clipId: clipId, set: snap ? snap.set : null, pointNo: e.pointNo || null, score: e.after ? e.after.score : null, team: e.team,
        attribution: a, state: st, seconds: (j && j.clipSeconds) || (sc && sc.actual && sc.actual.durationSec) || null,
        partial: !!((j && j.window && j.window.partialPreRoll) || (sc && sc.actual && sc.actual.partialPreRoll)), lead: j && j.window ? j.window.actualPreRollSec : sc && sc.actual ? sc.actual.preRollSec : null,
        watchUrl: sc && sc.watchUrl ? sc.watchUrl : null, error: (j && j.error) || (sc && sc.error) || null, voided: !!e.voided, local: !!j };
    }
    // QUEUED → WAITING_FOR_VIDEO → CUTTING → READY (saved, uploading or uploaded) | FAILED; an undone point's clip is kept and marked
    function clipState(j, sc, queued, e) {
      if (e && e.voided) return { k: 'CANCELLED', text: 'Point undone — clip kept', cls: 'mute' };
      if (j) {
        var s = j.syncStatus;
        if (s === 'WAITING') return { k: 'WAITING_FOR_VIDEO', text: 'Waiting for the footage', cls: 'wait' };
        if (s === 'CUTTING') return { k: 'CUTTING', text: 'Cutting', cls: 'wait' };
        if (s === 'CUT_RETRY') return { k: 'CUTTING', text: 'Cut retry queued', cls: 'wait' };
        if (s === 'CUT_FAILED') return { k: 'FAILED', text: 'Could not be cut', cls: 'bad', retry: true };
        if (s === 'OFFLINE_PENDING') return { k: 'UPLOAD_PENDING', text: 'Saved on this PC · waiting for internet', cls: 'ok' };
        if (s === 'SYNC_COMPLETE') return { k: 'READY', text: j.deletedOnWebsite ? 'Deleted on the website' : 'Ready · uploaded', cls: 'ok' };
        return { k: 'UPLOAD_PENDING', text: 'Saved on this PC · uploading', cls: 'ok' };
      }
      if (queued) return { k: 'QUEUED', text: C.helper.alive ? 'Queued' : 'Queued — waiting for the Clipper app', cls: 'wait' };
      if (sc) {
        var d = sc.displayStatus || '';
        if (/complete|Saved on the website/i.test(d)) return { k: 'READY', text: 'Ready', cls: 'ok' };
        if (/Failed/.test(d)) return { k: 'FAILED', text: 'Upload failed', cls: 'bad', serverRetry: true };
        if (/Uploading|pending/i.test(d)) return { k: 'UPLOAD_PENDING', text: d, cls: 'ok' };
        if (/Saved locally/.test(d)) return { k: 'UPLOAD_PENDING', text: 'Saved on the Clipper PC', cls: 'ok' };
        if (/Processing/.test(d)) return { k: 'CUTTING', text: 'Cutting', cls: 'wait' };
        if (/post-roll|Pending/i.test(d)) return { k: 'WAITING_FOR_VIDEO', text: 'Waiting for the footage', cls: 'wait' };
        if (/Unavailable/.test(d)) return { k: 'FAILED', text: 'No clip', cls: 'bad' };
        return { k: 'QUEUED', text: d || 'Pending', cls: 'wait' };
      }
      return null;
    }
    function recent(limit) {
      var tl = (o.getTimeline() || []).filter(function (e) { return e.type === 'RALLY' && !e.invalid; });
      var rows = [];
      for (var i = tl.length - 1; i >= 0 && rows.length < (limit || 40); i--) {
        var r = clipRow(tl[i]);
        if (r.state) rows.push(r);
      }
      return rows;
    }

    /* ---------- the loop ---------- */
    var lastJobs = 0, lastClips = 0, timer = null;
    async function tick() {
      clearTimeout(timer);
      try {
        await ping();
        if (C.helper.alive && on() && mine()) {
          if (C.helper.status.matchId !== o.matchId || C.helper.status.sport !== 'volleyball' || C.helper.status.mainServerUrl !== location.origin) await claimHelper(false);
          if (C.outbox.length) await flush();
        }
        var active = counts().processing > 0 || C.outbox.length > 0;
        if (C.helper.alive && (Date.now() - lastJobs > (active ? 2000 : 6000))) { lastJobs = Date.now(); await loadJobs(); }
        if (Date.now() - lastClips > 20000) { lastClips = Date.now(); loadClips(); }
        if (on()) await beat();
        if (on() && !mine() && C.owner && C.owner.sessionId === C.session.id && C.owner.stoppedAt) lose(null);
      } catch (e) { console.error(e); }
      changed();
      timer = setTimeout(tick, on() || C.busy ? 2500 : 8000);
    }
    // a reload in the middle of a match: this device was clipping it — carry on
    async function resume() {
      await ping();
      if (on()) {
        var r = await claimSession(false);
        if (!r.ok && r.code === 'CLIPPER_ELSEWHERE') lose(r.owner);
        else if (r.ok && C.helper.alive) await claimHelper(false);
      }
      loadClips();
      tick();
    }
    if (o.socket) { o.socket.on('vb:clipper', onClipper); o.socket.on('vb:clip', onClip); }
    resume();

    return {
      state: C, model: model, start: start, stop: stop, quitApp: quitApp, point: point, remotePoint: remotePoint, reconcile: reconcile,
      retry: retry, recent: recent, refresh: function () { lastJobs = 0; lastClips = 0; tick(); }, loadClips: loadClips,
      row: function (eventId) { var e = (o.getTimeline() || []).filter(function (x) { return x.eventId === eventId; })[0]; return e ? clipRow(e) : null; },
      setupUrl: HELPER + '/setup', mine: mine, on: on
    };
  }

  /* ---------------------------------------------------------------
     The view, shared by the scoring panel's Clipper sheet and the Clipper
     page: the state in one word, what was checked, the clips. Technical
     detail (ffmpeg, paths, ids) stays in the helper's own log.
     opts: { teamOf(t), short(name), canAssign, onAssign(eventId), onPlay(eventId), matchId }
     --------------------------------------------------------------- */
  var WORD = { READY: ['ok', 'READY'], PROCESSING: ['wait', 'PROCESSING'], WARNING: ['bad', 'WARNING'], STOPPED: ['off', 'STOPPED'], STARTING: ['wait', 'STARTING'] };
  var esc = function (v) { return VB.esc(v); };
  function chip(ctl) {
    var md = ctl.model();
    var w = WORD[md.state] || WORD.STOPPED;
    var extra = md.elsewhere ? ' · ' + esc((md.owner && md.owner.label) || 'another PC') : md.counts.unassigned ? ' · ' + md.counts.unassigned + ' to assign' : '';
    return '<button class="chip clp ' + w[0] + '" id="clpChip" title="' + esc(md.text) + '"><span class="dot ' + (w[0] === 'off' ? '' : w[0]) + '"></span>🎬 Clipper · ' + w[1] + '<span class="clpx">' + extra + '</span></button>';
  }
  function paint(ctl, el, opts) {
    opts = opts || {};
    var md = ctl.model();
    var w = WORD[md.state] || WORD.STOPPED;
    var k = md.counts;
    var rows = ctl.recent(30);
    var short = opts.short || function (n) { return n || ''; };
    var team = function (t) { return (opts.teamOf && opts.teamOf(t)) || { name: t }; };
    var typeOf = function (a) { return a.pending ? '' : TYPES[a.type] || ''; };
    var active = md.on && md.mine;
    var who = function (r) {
      var a = r.attribution;
      if (r.voided) return '<span class="muted">—</span>';
      if (a.players.length) return esc(a.players.map(function (x) { return '#' + (x.number || '?') + ' ' + short(x.name || ''); }).join(' + ')) + '<small> · ' + esc(typeOf(a)) + '</small>';
      if (a.pending) return opts.canAssign ? '<button class="btn xs" data-assign="' + esc(r.eventId) + '">Assign player</button>' : '<span class="muted">Not assigned yet</span>';
      return '<span class="muted">' + esc(typeOf(a)) + '</span>' + (opts.canAssign ? ' <button class="btn xs ghost" data-assign="' + esc(r.eventId) + '">Change</button>' : '');
    };
    var startLabel = md.state === 'STARTING' ? 'Starting…' : md.elsewhere ? 'Clip on this PC instead' : '▶ Start Clipper';
    el.innerHTML = '<div class="clphead ' + w[0] + '"><span class="clpword">' + w[1] + '</span><div class="grow"><b>' + esc(md.text) + '</b>'
      + '<div class="small muted">' + (md.window ? 'Each point: ' + md.window.pre + ' s of the rally before the press + ' + md.window.post + ' s after · ' : '') + 'cut from the vMix recording on the PC that records</div></div>'
      + (active ? '<button class="btn" id="clpStop">Stop clipping</button>' : '<button class="btn primary" id="clpStart"' + (md.state === 'STARTING' ? ' disabled' : '') + '>' + startLabel + '</button>') + '</div>'
      + (md.notice ? '<div class="banner warn" style="margin-top:10px">' + esc(md.notice) + '</div>' : '')
      + (md.elsewhere ? '<p class="small muted" style="margin-top:10px">Clipping runs on <b>' + esc(md.owner.label || 'another device') + '</b> (seen ' + esc(VB.ago(md.owner.lastSeenAt)) + '). Points scored anywhere are clipped there.</p>' : '')
      + '<div class="clpchecks">' + md.checks.map(function (c) { return '<div class="' + (c.ok ? 'ok' : active ? 'bad' : '') + '"><i>' + (c.ok ? '✓' : active ? '!' : '·') + '</i><b>' + esc(c.label) + '</b><span>' + esc(c.detail) + '</span></div>'; }).join('') + '</div>'
      + '<div class="clpcounts small"><span><b>' + k.done + '</b> uploaded</span><span><b>' + k.upload + '</b> saved · uploading' + (k.offline ? ' (' + k.offline + ' waiting for internet)' : '') + '</span><span><b>' + k.processing + '</b> being made</span>'
      + (k.failed ? '<span class="bad"><b>' + k.failed + '</b> could not be cut</span>' : '') + (k.unassigned ? '<span><b>' + k.unassigned + '</b> to assign</span>' : '') + '</div>'
      + '<h4 style="margin:14px 0 6px">Recent point clips</h4><div class="clprows">'
      + (rows.length ? rows.map(function (r) {
        var t = team(r.team);
        return '<div class="clprow' + (r.voided ? ' void' : '') + '" data-ev="' + esc(r.eventId) + '">'
          + '<span class="pt"><b>S' + (r.set || '?') + ' · ' + (r.score ? r.score.A + '–' + r.score.B : r.voided ? 'undone' : '') + '</b><small>' + (r.voided ? 'No longer counts' : 'Point ' + (r.pointNo || '?')) + '</small></span>'
          + '<span class="tmn"><span class="tm" style="background:' + esc(VB.teamColor(t)) + '"></span>' + esc(t.shortName || t.name) + '</span>'
          + '<span class="whoc ellipsis">' + who(r) + '</span>'
          + '<span class="dur">' + (r.seconds ? Number(r.seconds).toFixed(1) + ' s' : '') + (r.partial ? '<small title="The recording had only ' + (r.lead != null ? r.lead : '?') + ' s before this point">short lead-in</small>' : '') + '</span>'
          + '<span class="clipst ' + r.state.cls + '" title="' + esc(r.error || r.state.text) + '">' + esc(r.state.text) + '</span>'
          + '<span class="acts">' + (r.watchUrl ? '<button class="btn xs" data-play="' + esc(r.eventId) + '" title="Play">▶</button>' : '') + (r.state.retry ? '<button class="btn xs" data-retry="' + esc(r.clipId) + '">Retry</button>' : '') + (r.state.serverRetry ? '<button class="btn xs" data-sretry="' + esc(r.clipId) + '">Retry upload</button>' : '') + '</span></div>';
      }).join('') : '<div class="muted small">No point clips yet — they appear here as points are scored.</div>') + '</div>'
      + '<details class="clpfirst"><summary>First time on this PC, or something not working?</summary><ol class="small">'
      + '<li>The Clipper is the same app the Cricket Panel uses (<b>ClipperHelper.exe</b>, next to vMix). Get the <a href="/clipper-launcher.zip">Clipper Launcher</a>, unzip it into the ClipperHelper folder and run <code>install-clipper-launcher.bat</code> once — then <b>▶ Start Clipper</b> works from here.</li>'
      + '<li>Once per PC, tell it where vMix records: <a href="' + esc(ctl.setupUrl) + '" target="_blank" rel="noopener">open Clipper setup</a> → the vMix recording folder (the file being written is found by itself) → Save. A PC set up for cricket already has it.</li>'
      + '<li>vMix must record an MP4 (it is read while it is being written). Start <b>Record</b> in vMix — READY shows only once the recording is really growing.</li>'
      + (opts.matchId ? '<li>Scoring on a phone or tablet? Open the <a href="/volleyball-clipper?match=' + esc(opts.matchId) + '" target="_blank" rel="noopener">Clipper page</a> on the vMix PC — it clips the points scored on the phone.</li>' : '')
      + '</ol>' + (active ? '<button class="btn xs ghost" id="clpQuit">Quit the Clipper app on this PC</button>' : '') + '</details>';
    var q = function (s) { return el.querySelector(s); };
    if (q('#clpStart')) q('#clpStart').onclick = function () { ctl.start(); };
    if (q('#clpStop')) q('#clpStop').onclick = function () { VB.confirm('Stop clipping this match?', 'Points after this are not clipped until you start again. Clips already made are kept, and any still being made finish in the background.', 'Stop clipping').then(function (y) { if (y) ctl.stop(); }); };
    if (q('#clpQuit')) q('#clpQuit').onclick = function () { ctl.quitApp(); };
    VB.$$('[data-assign]', el).forEach(function (b) { b.onclick = function () { if (opts.onAssign) opts.onAssign(b.dataset.assign); }; });
    VB.$$('[data-retry]', el).forEach(function (b) { b.onclick = function () { ctl.retry(b.dataset.retry); }; });
    VB.$$('[data-sretry]', el).forEach(function (b) { b.onclick = function () { VB.api('POST', '/api/volleyball/clips/' + encodeURIComponent(b.dataset.sretry) + '/retry', {}).then(function (r) { VB.toast(r.ok ? 'Upload retried' : (r.json.error || 'Could not retry'), r.ok ? '' : 'err'); ctl.loadClips(); }); }; });
    VB.$$('[data-play]', el).forEach(function (b) { b.onclick = function () { if (opts.onPlay) opts.onPlay(b.dataset.play); }; });
  }
  // A point's clip, played in a sheet (the website's own authorised link).
  function play(ctl, eventId, teamOf) {
    var r = ctl.row(eventId);
    if (!r || !r.watchUrl) return;
    var t = teamOf ? teamOf(r.team) : { name: r.team };
    VB.sheet('<h3>Set ' + (r.set || '?') + ' · point ' + (r.pointNo || '?') + ' · ' + esc(t.name) + '</h3><video class="clpvid" src="' + esc(r.watchUrl) + '" controls autoplay playsinline></video>'
      + '<div class="foot"><a class="btn" href="' + esc(r.watchUrl + (r.watchUrl.indexOf('?') >= 0 ? '&' : '?') + 'download=1') + '" download>Download</a><button class="btn" data-close>Close</button></div>', { wide: true });
  }

  window.VBClipper = { create: create, attributionOf: attributionOf, TYPES: TYPES, HELPER: HELPER, chip: chip, paint: paint, play: play };
})();
