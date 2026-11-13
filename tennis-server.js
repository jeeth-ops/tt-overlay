/* ================================================================
   🎾 TENNIS — the server side of the lawn-tennis module.

   A sport of its own (and never table tennis, whose tt-* pages are a
   different module), sharing only plumbing with the other sports:
     - its own MongoDB collections (tnTournaments, tnPlayers, tnMatches,
       tnEvents, tnClips, tnReports, tnAudit) — a cricket or volleyball
       query can never see a tennis row, nor the other way round;
     - its own Socket.IO namespace (/tennis, events tn:*), so not one
       tennis update can reach another sport's room, overlay or panel;
     - its own clip ingest (/api/tennis/clips/ingest), storage prefix
       (tennis/… on R2) and local clipper (the Tennis Clipper).
   Shared, unchanged: Firebase sign-in and the creator / owner lists
   (passed in by server.js), the R2 / Drive clients, ffmpeg, and the
   dependency-free PDF writer (volleyball-pdf.js, read only).

   THE SOURCE OF TRUTH is tnEvents: one document per event (toss, start,
   point, fault, let …), unique per (matchId, eventId) and per (matchId,
   seq). The score, server, sets, statistics, standings, the draw's
   progress and the PDF are all derived from it by tennis-engine.js — so
   a retried request never scores twice, a correction is just another
   event, and anything derived can always be rebuilt.

   WHO MAY DO WHAT
     - Write anything: a signed-in (verified Firebase ID token) authorised
       creator account that owns the tournament, or the owner account.
     - Score a live match: the above, on the ONE device holding the
       match's controller lease (claimed, kept alive, taken over only
       explicitly — the other device is told at once).
     - A locked match takes no scoring and no edits until unlocked.
     - Read: public tournaments — anyone; private ones — their creator and
       the owner (the overlay of a private match carries its match key).
   ================================================================ */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const E = require('./tennis-engine.js');
const Stats = require('./tennis-stats.js');
const Draw = require('./tennis-draw.js');
const G = require('./tennis-graphics.js');
const Report = require('./tennis-report.js');

const LEASE_TTL_MS = 30 * 1000;
const LEDGER_CACHE_MAX = 300;
const CLIP_RETRY_INTERVAL_MS = 15 * 1000;
const CLIP_MAX_RETRIES = 12;
const REPORT_MAX_ATTEMPTS = 5;
const MAX_LOGO_BYTES = 600 * 1024;
const MAX_PHOTO_BYTES = 400 * 1024;
// a point's clip: the rally before the press + how it ended (the volleyball
// workflow's 7 s + 3 s); a tournament may set its own window
const CLIP_PRE_ROLL_SEC = 7;
const CLIP_POST_ROLL_SEC = 3;
const CATEGORIES = { men: "Men's", women: "Women's", mixed: 'Mixed', open: 'Open', boys: 'Boys', girls: 'Girls', veterans: 'Veterans', custom: 'Custom' };
const SURFACES = { hard: 'Hard court', clay: 'Clay court', grass: 'Grass court', synthetic: 'Synthetic court', carpet: 'Carpet', other: 'Other' };
const DRAW_TYPES = { knockout: 'Knockout', round_robin: 'Round robin', groups_knockout: 'Groups → knockout', custom: 'Custom' };

function newId(prefix) { return prefix + crypto.randomBytes(8).toString('hex'); }
function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 120); }
function keyOf(name) { return str(name, 200).toLowerCase().replace(/\s+/g, ' '); }
function color(v, d) { return /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : (d || '#0f766e'); }
function idOk(v) { return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(v); }
function safeId(v) { return String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120); }
function sha(v) { return crypto.createHash('sha256').update(String(v || '')).digest('hex'); }
function sameSecret(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clean(doc) { if (!doc) return doc; const o = Object.assign({}, doc); delete o._id; return o; }
function pick(v, allowed, d) { return Object.prototype.hasOwnProperty.call(allowed, v) ? v : d; }
// a name without case, accents or punctuation, as words
function tokens(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
}
// "Roger Federer", "roger  federer", "Federer, Roger", "R. Federer" — the same person, probably
function similarNames(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta.join(' ') === tb.join(' ')) return true;
  if (ta.slice().sort().join(' ') === tb.slice().sort().join(' ')) return true;
  const la = ta[ta.length - 1], lb = tb[tb.length - 1];
  if (la === lb && ta.length > 1 && tb.length > 1 && ta[0][0] === tb[0][0] && (ta[0].length === 1 || tb[0].length === 1)) return true;
  return false;
}

module.exports = function setupTennis(deps) {
  const { app, io, express } = deps;
  const auth = deps.auth;
  const log = deps.log || ((...a) => console.log('[tennis]', ...a));
  const CLIPS_DIR = deps.clipsDir;
  let C = null;
  let ready = null;

  /* ------------------------------------------------------------ database */
  async function init() {
    const db = deps.getDb();
    if (!db) return null;
    const c = {
      tournaments: db.collection('tnTournaments'),
      players: db.collection('tnPlayers'),
      matches: db.collection('tnMatches'),
      events: db.collection('tnEvents'),
      clips: db.collection('tnClips'),
      reports: db.collection('tnReports'),
      audit: db.collection('tnAudit')
    };
    await c.tournaments.createIndex({ tournamentId: 1 }, { unique: true });
    await c.tournaments.createIndex({ ownerUid: 1, updatedAt: -1 });
    await c.players.createIndex({ playerId: 1 }, { unique: true });
    await c.players.createIndex({ ownerUid: 1, nameKey: 1 });
    await c.matches.createIndex({ matchId: 1 }, { unique: true });
    await c.matches.createIndex({ tournamentId: 1, scheduledAt: 1 });
    // a generated draw match exists once per tournament, however often "generate" is pressed
    await c.matches.createIndex({ tournamentId: 1, fixtureKey: 1 }, { name: 'tn_fixture_once', unique: true, partialFilterExpression: { fixtureKey: { $type: 'string' } } });
    await c.matches.createIndex({ 'sides.A.players.playerId': 1 });
    await c.matches.createIndex({ 'sides.B.players.playerId': 1 });
    // THE idempotency guarantees: one row per event, one event per sequence number
    await c.events.createIndex({ matchId: 1, eventId: 1 }, { unique: true });
    await c.events.createIndex({ matchId: 1, seq: 1 }, { unique: true });
    await c.clips.createIndex({ clipId: 1 }, { unique: true });
    await c.clips.createIndex({ matchId: 1, createdAt: 1 });
    await c.clips.createIndex({ matchId: 1, eventId: 1 });
    await c.clips.createIndex({ status: 1, retryCount: 1 });
    await c.reports.createIndex({ matchId: 1, version: 1 }, { unique: true });
    await c.audit.createIndex({ matchId: 1, at: -1 });
    await c.audit.createIndex({ tournamentId: 1, at: -1 });
    C = c;
    log('collections ready');
    return c;
  }
  async function col() {
    if (C) return C;
    await deps.whenMongoReady();
    if (!ready) ready = init().catch((e) => { log('init error:', e.message || e); ready = null; return null; });
    return ready;
  }
  function dbDown(res) { return res.status(503).json({ success: false, retry: true, error: 'The tennis database is not available right now' }); }

  /* ------------------------------------------------------------ identity */
  async function identify(req) {
    const token = auth.extractIdToken(req);
    if (!token) return null;
    const d = await auth.verifyIdTokenFull(token);
    if (!d || !d.uid) return null;
    return userOf(d);
  }
  function userOf(d) {
    const email = String(d.email || '').toLowerCase();
    const isOwner = !!email && d.email_verified !== false && email === String(auth.ownerEmail()).toLowerCase();
    return { uid: d.uid, email, isOwner, isCreator: isOwner || (d.email_verified !== false && auth.isCreatorEmail(email)) };
  }
  function requireCreator(handler) {
    return async (req, res) => {
      const user = await identify(req);
      if (!user) return res.status(401).json({ success: false, code: 'LOGIN_REQUIRED', error: 'Sign in with an authorised account' });
      if (!user.isCreator) return res.status(403).json({ success: false, code: 'NOT_AUTHORISED', error: 'Your account is not authorised to manage tennis tournaments' });
      const c = await col();
      if (!c) return dbDown(res);
      try { await handler(req, res, user, c); }
      catch (e) { log('route error', req.method, req.path, e.stack || e); if (!res.headersSent) res.status(500).json({ success: false, error: 'Something went wrong — nothing was half-saved; try again' }); }
    };
  }
  function openRoute(handler) {
    return async (req, res) => {
      const c = await col();
      if (!c) return dbDown(res);
      try { await handler(req, res, await identify(req).catch(() => null), c); }
      catch (e) { log('route error', req.method, req.path, e.stack || e); if (!res.headersSent) res.status(500).json({ success: false, error: 'Could not load that right now' }); }
    };
  }
  function canManage(user, doc) { return !!(user && user.isCreator && doc && (user.isOwner || doc.ownerUid === user.uid)); }
  function visibilityOf(t) {
    if (t && (t.visibility === 'public' || t.visibility === 'private')) return t.visibility;
    return auth.isPrivateCreatorEmail(t && t.createdBy) ? 'private' : 'public';
  }
  function canView(user, t) { return !!t && ((!t.archived && visibilityOf(t) === 'public') || canManage(user, t)); }
  async function audit(c, entry) {
    try { await c.audit.insertOne(Object.assign({ at: Date.now() }, entry)); }
    catch (e) { log('audit write error', e.message || e); }
  }
  const byOf = (user, extra) => Object.assign({ uid: user ? user.uid : null, email: user ? user.email : null }, extra || {});

  /* ------------------------------------------------------------ pictures */
  function cleanImage(input, maxBytes) {
    if (input == null || input === '') return null;
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(input));
    if (!m) return undefined;                // undefined = "invalid", null = "none"
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length || bytes.length > (maxBytes || MAX_LOGO_BYTES)) return undefined;
    return { type: m[1], data: m[2], bytes: bytes.length };
  }
  const photoUrl = (p) => (p && p.photoV ? `/api/tennis/players/${p.playerId}/photo?v=${p.photoV}` : null);

  /* ------------------------------------------------------------ players
     A player is one identity across every match and tournament: renames
     follow the id everywhere, history stays with it, and a new player is
     only made after the account was shown the players it already has
     with a similar name ("R. Federer" is probably "Roger Federer"). */
  function publicPlayer(p, opts) {
    if (!p) return null;
    const o = {
      playerId: p.playerId, name: p.name, short: p.short || E.shortName(p.name), country: p.country || '', club: p.club || '',
      gender: p.gender || '', hand: p.hand || '', backhand: p.backhand || '', color: p.color || null,
      ranking: p.ranking && p.ranking.value ? { value: p.ranking.value, label: p.ranking.label || '' } : null,
      achievements: (p.achievements || []).filter((a) => a && a.verified).map((a) => a.text),
      photo: photoUrl(p), updatedAt: p.updatedAt || 0
    };
    if (opts && opts.manage) { o.allAchievements = p.achievements || []; o.archived = !!p.archived; o.bio = p.bio || ''; o.dob = p.dob || ''; }
    else if (p.bio) o.bio = p.bio;
    return o;
  }
  function playerFromBody(b, prev) {
    const set = {};
    if (!prev || b.name != null) {
      const name = str(b.name, 60);
      if (!name) return { error: 'Player name required' };
      set.name = name; set.nameKey = keyOf(name);
    }
    if (b.short != null) set.short = str(b.short, 24);
    if (b.country != null) set.country = str(b.country, 32).toUpperCase().replace(/[^A-Z ]/g, '').slice(0, 32);
    if (b.club != null) set.club = str(b.club, 60);
    if (b.gender != null) set.gender = b.gender === 'M' || b.gender === 'F' ? b.gender : '';
    if (b.hand != null) set.hand = b.hand === 'R' || b.hand === 'L' ? b.hand : '';
    if (b.backhand != null) set.backhand = b.backhand === '1H' || b.backhand === '2H' ? b.backhand : '';
    if (b.dob != null) set.dob = /^\d{4}-\d{2}-\d{2}$/.test(String(b.dob)) ? String(b.dob) : '';
    if (b.bio != null) set.bio = str(b.bio, 400);
    if (b.color !== undefined) set.color = b.color ? color(b.color, null) : null;
    if (b.ranking !== undefined) {
      const r = b.ranking && typeof b.ranking === 'object' ? b.ranking : null;
      const v = r ? Math.round(num(r.value, 0)) : 0;
      set.ranking = v > 0 && v < 100000 ? { value: v, label: str(r.label, 40) } : null;
    }
    if (b.achievements !== undefined) {
      set.achievements = (Array.isArray(b.achievements) ? b.achievements : []).slice(0, 12).map((a) => (typeof a === 'string' ? { text: str(a, 100), verified: false } : { text: str(a && a.text, 100), verified: !!(a && a.verified) })).filter((a) => a.text);
    }
    return { set };
  }
  async function similarPlayers(c, user, name, exceptId) {
    const mine = await c.players.find(user.isOwner ? {} : { ownerUid: user.uid }).project({ playerId: 1, name: 1, country: 1, club: 1, photoV: 1, archived: 1 }).limit(5000).toArray();
    return mine.filter((p) => p.playerId !== exceptId && !p.archived && similarNames(p.name, name)).slice(0, 8).map((p) => ({ playerId: p.playerId, name: p.name, country: p.country || '', club: p.club || '', photo: photoUrl(p) }));
  }
  app.post('/api/tennis/players', requireCreator(async (req, res, user, c) => {
    const b = req.body || {};
    const r = playerFromBody(b, null);
    if (r.error) return res.status(400).json({ success: false, error: r.error });
    // never a second record of the same person just because the name was typed differently
    if (!b.force) {
      const dupes = await similarPlayers(c, user, r.set.name, null);
      if (dupes.length) return res.status(409).json({ success: false, code: 'POSSIBLE_DUPLICATE', error: `A player named like “${r.set.name}” already exists — use that player, or create a new one anyway`, candidates: dupes });
    }
    const photo = cleanImage(b.photo, MAX_PHOTO_BYTES);
    if (photo === undefined) return res.status(400).json({ success: false, error: 'The photo must be a PNG, JPEG or WebP under 400 KB' });
    const now = Date.now();
    const doc = Object.assign({ playerId: newId('tnp'), ownerUid: user.uid, createdBy: user.email, photo, photoV: photo ? 1 : 0, archived: false, createdAt: now, updatedAt: now }, r.set);
    await c.players.insertOne(doc);
    await audit(c, { action: 'player.create', by: byOf(user), details: { playerId: doc.playerId, name: doc.name, forced: !!b.force } });
    res.json({ success: true, player: publicPlayer(doc, { manage: true }) });
  }));
  app.put('/api/tennis/players/:pid', requireCreator(async (req, res, user, c) => {
    const p = await c.players.findOne({ playerId: String(req.params.pid) });
    if (!p) return res.status(404).json({ success: false, error: 'No such player' });
    if (!canManage(user, p)) return res.status(403).json({ success: false, error: 'Not your player' });
    const b = req.body || {};
    const r = playerFromBody(b, p);
    if (r.error) return res.status(400).json({ success: false, error: r.error });
    if (b.archived === true || b.archived === false) r.set.archived = b.archived;
    r.set.updatedAt = Date.now();
    await c.players.updateOne({ playerId: p.playerId }, { $set: r.set });
    const next = Object.assign({}, p, r.set);
    // matches not started follow the new name / country / club; a match in
    // play or played keeps what was entered for it (the record of THAT match)
    await refreshPlayerInMatches(c, next, ['scheduled', 'ready']);
    await audit(c, { action: 'player.update', by: byOf(user), details: { playerId: p.playerId, fields: Object.keys(r.set) } });
    res.json({ success: true, player: publicPlayer(next, { manage: true }) });
  }));
  app.put('/api/tennis/players/:pid/photo', requireCreator(async (req, res, user, c) => {
    const p = await c.players.findOne({ playerId: String(req.params.pid) });
    if (!p) return res.status(404).json({ success: false, error: 'No such player' });
    if (!canManage(user, p)) return res.status(403).json({ success: false, error: 'Not your player' });
    const photo = cleanImage(req.body && req.body.photo, MAX_PHOTO_BYTES);
    if (photo === undefined) return res.status(400).json({ success: false, error: 'The photo must be a PNG, JPEG or WebP under 400 KB' });
    const photoV = photo ? (p.photoV || 0) + 1 : 0;
    await c.players.updateOne({ playerId: p.playerId }, { $set: { photo, photoV, updatedAt: Date.now() } });
    // a portrait shows at once — in every match (it is the player's, not the match's)
    await refreshPlayerInMatches(c, Object.assign({}, p, { photo, photoV }), ['scheduled', 'ready', 'live', 'paused', 'suspended']);
    await audit(c, { action: photo ? 'player.photo' : 'player.photo.remove', by: byOf(user), details: { playerId: p.playerId, bytes: photo ? photo.bytes : 0 } });
    res.json({ success: true, photo: photo ? `/api/tennis/players/${p.playerId}/photo?v=${photoV}` : null });
  }));
  app.get('/api/tennis/players/:pid/photo', openRoute(async (req, res, user, c) => {
    const p = await c.players.findOne({ playerId: String(req.params.pid) });
    if (!p || !p.photo || !p.photo.data) return res.status(404).end();
    res.set('Content-Type', p.photo.type);
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.send(Buffer.from(p.photo.data, 'base64'));
  }));
  app.get('/api/tennis/players/search', requireCreator(async (req, res, user, c) => {
    const q = tokens(req.query.q || '').join(' ');
    const all = await c.players.find(user.isOwner && req.query.all ? {} : { ownerUid: user.uid }).sort({ updatedAt: -1 }).limit(2000).toArray();
    const list = all.filter((p) => !p.archived && (!q || tokens(p.name).join(' ').includes(q) || similarNames(p.name, req.query.q || ''))).slice(0, 40).map((p) => publicPlayer(p));
    res.json({ success: true, players: list });
  }));
  // A player's public page: profile + the matches the viewer may see.
  app.get('/api/tennis/players/:pid', openRoute(async (req, res, user, c) => {
    const pid = String(req.params.pid);
    if (!idOk(pid)) return res.status(400).json({ success: false });
    const p = await c.players.findOne({ playerId: pid });
    if (!p) return res.status(404).json({ success: false, error: 'Player not found' });
    const ms = await c.matches.find({ $or: [{ 'sides.A.players.playerId': pid }, { 'sides.B.players.playerId': pid }] }).sort({ scheduledAt: -1, createdAt: -1 }).limit(150).toArray();
    const tIds = [...new Set(ms.map((m) => m.tournamentId))];
    const ts = tIds.length ? await c.tournaments.find({ tournamentId: { $in: tIds } }).toArray() : [];
    const tById = new Map(ts.map((t) => [t.tournamentId, t]));
    const visible = ms.filter((m) => canView(user, tById.get(m.tournamentId)));
    if (!visible.length && !canManage(user, p)) return res.status(404).json({ success: false, error: 'Player not found' });
    const rec = { played: 0, won: 0, lost: 0 };
    const matches = [];
    for (const m of visible) {
      const side = (m.sides.A.players || []).some((x) => x.playerId === pid) ? 'A' : 'B';
      if (m.status === 'completed' && m.result && m.result.winner) { rec.played++; if (m.result.winner === side) rec.won++; else rec.lost++; }
      const row = { match: publicMatch(m, false), side, tournamentName: (tById.get(m.tournamentId) || {}).name || '' };
      if (m.status === 'completed' || m.status === 'live') {
        const s = await statsOf(c, m).catch(() => null);
        if (s) row.stats = s.format === 'doubles' ? s.players[pid] || null : s.sides[side];
      }
      matches.push(row);
    }
    res.json({ success: true, player: publicPlayer(p, { manage: canManage(user, p) }), record: rec, matches });
  }));
  // head to head of two players (singles), from the matches the viewer may see
  app.get('/api/tennis/h2h', openRoute(async (req, res, user, c) => {
    const a = String(req.query.a || ''), b = String(req.query.b || '');
    if (!idOk(a) || !idOk(b) || a === b) return res.status(400).json({ success: false, error: 'Choose two players' });
    const ms = await c.matches.find({ status: 'completed', format: 'singles', $or: [{ 'sides.A.players.playerId': a, 'sides.B.players.playerId': b }, { 'sides.A.players.playerId': b, 'sides.B.players.playerId': a }] }).sort({ completedAt: -1 }).limit(100).toArray();
    const tIds = [...new Set(ms.map((m) => m.tournamentId))];
    const ts = tIds.length ? await c.tournaments.find({ tournamentId: { $in: tIds } }).toArray() : [];
    const tById = new Map(ts.map((t) => [t.tournamentId, t]));
    const list = ms.filter((m) => canView(user, tById.get(m.tournamentId)));
    const wins = { [a]: 0, [b]: 0 };
    list.forEach((m) => { if (m.result && m.result.winner) { const w = m.sides[m.result.winner].players[0].playerId; if (wins[w] != null) wins[w]++; } });
    res.json({ success: true, wins, matches: list.map((m) => publicMatch(m, false)) });
  }));
  async function refreshPlayerInMatches(c, p, statuses) {
    const ms = await c.matches.find({ status: { $in: statuses }, $or: [{ 'sides.A.players.playerId': p.playerId }, { 'sides.B.players.playerId': p.playerId }] }).toArray();
    for (const m of ms) {
      const set = { updatedAt: Date.now() };
      ['A', 'B'].forEach((s) => {
        const side = m.sides[s];
        if (!side || !(side.players || []).some((x) => x.playerId === p.playerId)) return;
        const started = !['scheduled', 'ready'].includes(m.status);
        const players = side.players.map((x) => (x.playerId === p.playerId ? Object.assign({}, x, started ? { photoV: p.photoV || 0 } : snapPlayer(p, x.seed)) : x));
        set['sides.' + s + '.players'] = players;
        if (!started && !side.customName) set['sides.' + s + '.name'] = sideName(m.format, players);
      });
      await c.matches.updateOne({ matchId: m.matchId }, { $set: set });
      dropLedger(m.matchId);
      broadcastMatchDoc(await loadMatch(c, m.matchId));
    }
  }

  /* ------------------------------------------------------------ tournaments + events (draws) */
  function snapPlayer(p, seed) {
    return { playerId: p.playerId, name: p.name, short: p.short || E.shortName(p.name), country: p.country || '', club: p.club || '', photoV: p.photoV || 0, color: p.color || null, ranking: p.ranking && p.ranking.value ? { value: p.ranking.value, label: p.ranking.label || '' } : null, seed: seed || null };
  }
  function sideName(format, players) {
    if (format !== 'doubles') return players[0] ? players[0].name : 'To be decided';
    const s = players.map((p) => E.surname(p.name)).filter(Boolean);
    return s.length ? s.join(' / ') : 'To be decided';
  }
  function cleanRules(r) { return E.normalizeRules(r || {}); }
  function cleanClipWindow(w, d) {
    w = w && typeof w === 'object' ? w : {};
    const pre = Math.round(num(w.preRollSec, (d && d.preRollSec) || CLIP_PRE_ROLL_SEC));
    const post = Math.round(num(w.postRollSec, (d && d.postRollSec) || CLIP_POST_ROLL_SEC));
    return { preRollSec: Math.max(1, Math.min(30, pre)), postRollSec: Math.max(1, Math.min(15, post)) };
  }
  function publicEvent(ev, players) {
    const byId = players || new Map();
    return {
      eventId: ev.eventId, name: ev.name, format: ev.format, category: ev.category, categoryLabel: CATEGORIES[ev.category] || '',
      drawType: ev.drawType, rules: ev.rules, rulesLocked: !!ev.rulesLocked, thirdPlace: !!ev.thirdPlace, qualifiersPerGroup: ev.qualifiersPerGroup || 2,
      groups: ev.groups || [], drawSize: ev.drawSize || null, lines: ev.lines || null, randomUnseeded: !!ev.randomUnseeded,
      entries: (ev.entries || []).map((en) => ({
        entryId: en.entryId, seed: en.seed || null, name: en.name || '', club: en.club || '', withdrawn: !!en.withdrawn,
        players: (en.playerIds || []).map((id) => { const p = byId.get(id); return p ? publicPlayer(p) : { playerId: id, name: 'Unknown player' }; })
      }))
    };
  }
  function publicTournament(t, user) {
    const manage = canManage(user, t);
    return {
      tournamentId: t.tournamentId, sport: 'tennis', name: t.name, description: t.description || '', venue: t.venue || '', city: t.city || '',
      startDate: t.startDate || '', endDate: t.endDate || '', timezone: t.timezone || 'Asia/Kolkata', surface: t.surface || 'hard', courts: t.courts || [],
      logo: t.logo ? `/api/tennis/tournaments/${t.tournamentId}/logo?v=${t.logoV || 1}` : null,
      organizer: t.organizer || '', visibility: visibilityOf(t), status: t.status || 'upcoming', completedAt: t.completedAt || null,
      broadcast: G.normalizeStyle(t.broadcast), clip: cleanClipWindow(t.clip), createdAt: t.createdAt, updatedAt: t.updatedAt,
      canManage: manage, createdBy: manage ? t.createdBy : undefined, archived: manage ? !!t.archived : undefined, driveFolderId: manage ? t.driveFolderId || null : undefined
    };
  }
  async function playersMap(c, ids) {
    const list = ids.length ? await c.players.find({ playerId: { $in: [...new Set(ids)] } }).toArray() : [];
    return new Map(list.map((p) => [p.playerId, p]));
  }
  function eventPlayerIds(t) { return [].concat(...(t.events || []).map((ev) => [].concat(...(ev.entries || []).map((en) => en.playerIds || [])))); }

  app.get('/api/tennis/tournaments/:tid/logo', openRoute(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t || !t.logo) return res.status(404).end();
    if (!canView(user, t)) {
      const m = req.query.match && req.query.key ? await c.matches.findOne({ matchId: String(req.query.match), tournamentId: t.tournamentId }) : null;
      if (!m || !sameSecret(req.query.key, m.overlayKey)) return res.status(404).end();
    }
    res.set('Content-Type', t.logo.type);
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.send(Buffer.from(t.logo.data, 'base64'));
  }));

  function tournamentFromBody(b, prev) {
    const out = {};
    if (!prev || b.name != null) {
      const name = str(b.name, 80);
      if (!name) return { error: 'Tournament name required' };
      out.name = name; out.nameKey = keyOf(name);
    }
    ['description:600', 'venue:120', 'city:60', 'organizer:80'].forEach((f) => { const [k, n] = f.split(':'); if (b[k] != null) out[k] = str(b[k], Number(n)); });
    ['startDate', 'endDate'].forEach((k) => { if (b[k] != null) out[k] = /^\d{4}-\d{2}-\d{2}$/.test(String(b[k])) ? String(b[k]) : ''; });
    if (out.startDate && out.endDate && out.endDate < out.startDate) return { error: 'The end date is before the start date' };
    if (b.timezone != null) out.timezone = /^[A-Za-z_]+\/[A-Za-z_]+$/.test(String(b.timezone)) ? String(b.timezone) : 'Asia/Kolkata';
    if (b.visibility === 'public' || b.visibility === 'private') out.visibility = b.visibility;
    if (b.surface != null) out.surface = pick(b.surface, SURFACES, 'hard');
    if (b.courts != null) out.courts = (Array.isArray(b.courts) ? b.courts : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 30);
    if (b.clip != null) out.clip = cleanClipWindow(b.clip);
    if (b.logo !== undefined) {
      const logo = cleanImage(b.logo);
      if (logo === undefined) return { error: 'The logo must be a PNG, JPEG or WebP under 600 KB' };
      out.logo = logo; out.logoV = ((prev && prev.logoV) || 0) + 1;
    }
    if (b.driveFolder != null) {
      const m = /folders\/([A-Za-z0-9_-]+)/.exec(String(b.driveFolder)) || /^([A-Za-z0-9_-]{10,})$/.exec(String(b.driveFolder).trim());
      out.driveFolderId = m ? m[1] : null;
    }
    return { set: out };
  }
  app.post('/api/tennis/tournaments', requireCreator(async (req, res, user, c) => {
    const r = tournamentFromBody(req.body || {}, null);
    if (r.error) return res.status(400).json({ success: false, error: r.error });
    const now = Date.now();
    const doc = Object.assign({ tournamentId: newId('tnt'), ownerUid: user.uid, createdBy: user.email, sport: 'tennis', events: [], status: 'upcoming', surface: 'hard', courts: [], timezone: 'Asia/Kolkata', createdAt: now, updatedAt: now }, r.set);
    await c.tournaments.insertOne(doc);
    await audit(c, { action: 'tournament.create', tournamentId: doc.tournamentId, by: byOf(user), details: { name: doc.name, visibility: visibilityOf(doc) } });
    invalidateDirectory();
    res.json({ success: true, tournament: publicTournament(doc, user) });
  }));
  app.put('/api/tennis/tournaments/:tid', requireCreator(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t) return res.status(404).json({ success: false, error: 'No such tournament' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your tournament' });
    const b = req.body || {};
    const r = tournamentFromBody(b, t);
    if (r.error) return res.status(400).json({ success: false, error: r.error });
    if (['completed', 'ongoing', 'upcoming'].includes(b.status)) { r.set.status = b.status; r.set.completedAt = b.status === 'completed' ? Date.now() : null; }
    if (b.archived === true || b.archived === false) r.set.archived = b.archived;
    r.set.updatedAt = Date.now();
    await c.tournaments.updateOne({ tournamentId: t.tournamentId }, { $set: r.set });
    await audit(c, { action: 'tournament.update', tournamentId: t.tournamentId, by: byOf(user), details: { fields: Object.keys(r.set) } });
    invalidateDirectory();
    res.json({ success: true, tournament: publicTournament(Object.assign({}, t, r.set), user) });
  }));
  // The broadcast look of every match of the tournament; overlays on air follow at once.
  app.put('/api/tennis/tournaments/:tid/broadcast', requireCreator(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t) return res.status(404).json({ success: false, error: 'No such tournament' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your tournament' });
    const b = req.body && typeof req.body.style === 'object' ? req.body.style : null;
    if (!b) return res.status(400).json({ success: false, error: 'No broadcast settings sent' });
    const prev = G.normalizeStyle(t.broadcast);
    const style = G.normalizeStyle(Object.assign({}, prev, b, { moments: Object.assign({}, prev.moments, b.moments || {}), autoScenes: Object.assign({}, prev.autoScenes, b.autoScenes || {}) }));
    await c.tournaments.updateOne({ tournamentId: t.tournamentId }, { $set: { broadcast: style, updatedAt: Date.now() } });
    await audit(c, { action: 'tournament.broadcast', tournamentId: t.tournamentId, by: byOf(user), details: { style } });
    nsp.to(troom(t.tournamentId)).emit('tn:style', { tournamentId: t.tournamentId, style });
    res.json({ success: true, style });
  }));

  // An event = one draw of the tournament (Men's Singles, Mixed Doubles …).
  async function eventFromBody(c, user, b, prev, t) {
    const out = prev ? Object.assign({}, prev) : { eventId: newId('tne'), entries: [], groups: [], createdAt: Date.now() };
    if (!prev || b.name != null) { const n = str(b.name, 60); if (!n) return { error: 'Name the event (e.g. Men’s Singles)' }; out.name = n; }
    const started = prev && (await c.matches.countDocuments({ tournamentId: t.tournamentId, eventId: prev.eventId, eventSeq: { $gt: 0 } })) > 0;
    if (b.format != null) {
      const f = b.format === 'doubles' ? 'doubles' : 'singles';
      if (started && f !== prev.format) return { error: 'Matches of this event have started — it can no longer change between singles and doubles' };
      out.format = f;
    }
    if (!out.format) out.format = 'singles';
    if (b.category != null) out.category = pick(b.category, CATEGORIES, 'open');
    if (!out.category) out.category = 'open';
    if (b.drawType != null) out.drawType = pick(b.drawType, DRAW_TYPES, 'knockout');
    if (!out.drawType) out.drawType = 'knockout';
    if (b.rules != null) {
      const rules = cleanRules(b.rules);
      if (started && prev.rules && JSON.stringify(rules) !== JSON.stringify(prev.rules)) return { error: 'Matches of this event have started — its scoring format can no longer change', code: 'RULES_LOCKED' };
      out.rules = rules;
    }
    if (!out.rules) out.rules = cleanRules({});
    out.rulesLocked = !!started;
    if (b.thirdPlace != null) out.thirdPlace = !!b.thirdPlace;
    if (b.randomUnseeded != null) out.randomUnseeded = !!b.randomUnseeded;
    if (b.qualifiersPerGroup != null) out.qualifiersPerGroup = Math.max(1, Math.min(8, Math.round(num(b.qualifiersPerGroup, 2))));
    if (b.entries != null) {
      const need = out.format === 'doubles' ? 2 : 1;
      const raw = (Array.isArray(b.entries) ? b.entries : []).slice(0, 256);
      const ids = [].concat(...raw.map((x) => (x && Array.isArray(x.playerIds) ? x.playerIds : []))).filter(idOk);
      const pm = await playersMap(c, ids);
      const prevById = new Map((prev ? prev.entries : []).map((x) => [x.entryId, x]));
      const seenPlayers = new Set(), seenSeeds = new Set(), entries = [];
      for (const x of raw) {
        if (!x || !Array.isArray(x.playerIds)) continue;
        const pids = x.playerIds.filter(idOk).slice(0, need);
        if (pids.length !== need) return { error: out.format === 'doubles' ? 'Every doubles entry needs two players' : 'Every entry needs its player' };
        for (const id of pids) {
          const p = pm.get(id);
          if (!p || (!user.isOwner && p.ownerUid !== user.uid)) return { error: 'An entry names a player who is not in your player list' };
          if (seenPlayers.has(id)) return { error: `${p.name} is entered twice in this event` };
          seenPlayers.add(id);
        }
        const seed = x.seed ? Math.round(num(x.seed, 0)) : 0;
        if (seed) { if (seed < 1 || seed > 64) return { error: 'Seeds run from 1 to 64' }; if (seenSeeds.has(seed)) return { error: `Seed ${seed} is given twice` }; seenSeeds.add(seed); }
        const entryId = x.entryId && prevById.has(x.entryId) ? x.entryId : newId('tnx');
        entries.push({ entryId, playerIds: pids, seed: seed || null, name: str(x.name, 60), club: str(x.club, 60), withdrawn: !!x.withdrawn });
      }
      // an entry that has played stays (its matches name it): removing marks it withdrawn
      if (prev) for (const old of prev.entries) {
        if (entries.some((e) => e.entryId === old.entryId)) continue;
        const used = await c.matches.countDocuments({ tournamentId: t.tournamentId, eventId: prev.eventId, $or: [{ 'sides.A.entryId': old.entryId }, { 'sides.B.entryId': old.entryId }], eventSeq: { $gt: 0 } });
        if (used) entries.push(Object.assign({}, old, { withdrawn: true }));
      }
      out.entries = entries;
    }
    if (b.groups != null) {
      const valid = new Set(out.entries.map((e) => e.entryId));
      out.groups = (Array.isArray(b.groups) ? b.groups : []).slice(0, 16).map((g, i) => ({ name: str(g && g.name, 12) || String.fromCharCode(65 + i), entryIds: (Array.isArray(g && g.entryIds) ? g.entryIds : []).filter((id) => valid.has(id)) })).filter((g) => g.entryIds.length);
    }
    out.updatedAt = Date.now();
    return { event: out };
  }
  app.post('/api/tennis/tournaments/:tid/events', requireCreator(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t) return res.status(404).json({ success: false, error: 'No such tournament' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your tournament' });
    if ((t.events || []).length >= 24) return res.status(400).json({ success: false, error: 'A tournament has at most 24 events' });
    const r = await eventFromBody(c, user, req.body || {}, null, t);
    if (r.error) return res.status(400).json({ success: false, error: r.error });
    await c.tournaments.updateOne({ tournamentId: t.tournamentId }, { $push: { events: r.event }, $set: { updatedAt: Date.now() } });
    await audit(c, { action: 'event.create', tournamentId: t.tournamentId, by: byOf(user), details: { eventId: r.event.eventId, name: r.event.name } });
    const pm = await playersMap(c, [].concat(...r.event.entries.map((e) => e.playerIds)));
    res.json({ success: true, event: publicEvent(r.event, pm) });
  }));
  app.put('/api/tennis/tournaments/:tid/events/:eid', requireCreator(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t) return res.status(404).json({ success: false, error: 'No such tournament' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your tournament' });
    const prev = (t.events || []).find((e) => e.eventId === String(req.params.eid));
    if (!prev) return res.status(404).json({ success: false, error: 'No such event' });
    const r = await eventFromBody(c, user, req.body || {}, prev, t);
    if (r.error) return res.status(r.code === 'RULES_LOCKED' ? 409 : 400).json({ success: false, code: r.code, error: r.error });
    await c.tournaments.updateOne({ tournamentId: t.tournamentId, 'events.eventId': prev.eventId }, { $set: { 'events.$': r.event, updatedAt: Date.now() } });
    // the event's unstarted matches take its scoring format
    if (req.body && req.body.rules != null) await c.matches.updateMany({ tournamentId: t.tournamentId, eventId: prev.eventId, status: { $in: ['scheduled', 'ready'] }, eventSeq: 0 }, { $set: { rules: r.event.rules } });
    await audit(c, { action: 'event.update', tournamentId: t.tournamentId, by: byOf(user), details: { eventId: prev.eventId, fields: Object.keys(req.body || {}) } });
    const pm = await playersMap(c, [].concat(...r.event.entries.map((e) => e.playerIds)));
    res.json({ success: true, event: publicEvent(r.event, pm) });
  }));
  app.delete('/api/tennis/tournaments/:tid/events/:eid', requireCreator(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t) return res.status(404).json({ success: false, error: 'No such tournament' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your tournament' });
    const eid = String(req.params.eid);
    if (await c.matches.countDocuments({ tournamentId: t.tournamentId, eventId: eid })) return res.status(409).json({ success: false, error: 'This event has matches — delete its unplayed matches first (played matches are kept for the record)' });
    await c.tournaments.updateOne({ tournamentId: t.tournamentId }, { $pull: { events: { eventId: eid } }, $set: { updatedAt: Date.now() } });
    await audit(c, { action: 'event.delete', tournamentId: t.tournamentId, by: byOf(user), details: { eventId: eid } });
    res.json({ success: true });
  }));

  /* ---------- generating the draw ----------
     Knockout: the bracket (byes to the top seeds) — round 1 with its
     players, later rounds waiting for the winners; groups: every pair
     once; groups → knockout: the groups now, the knockout from the final
     standings later. Generating again never duplicates (stable keys). */
  app.post('/api/tennis/tournaments/:tid/events/:eid/draw', requireCreator(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t) return res.status(404).json({ success: false, error: 'No such tournament' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your tournament' });
    const ev = (t.events || []).find((e) => e.eventId === String(req.params.eid));
    if (!ev) return res.status(404).json({ success: false, error: 'No such event' });
    const b = req.body || {};
    const stage = b.stage === 'knockout' || ev.drawType === 'knockout' ? 'knockout' : 'groups';
    const entries = (ev.entries || []).filter((e) => !e.withdrawn);
    const byEntry = new Map(entries.map((e) => [e.entryId, e]));
    const pm = await playersMap(c, [].concat(...entries.map((e) => e.playerIds)));
    const start = num(b.startAt, null), gapMs = Math.max(0, num(b.gapMinutes, 75)) * 60000, perDay = Math.max(1, num(b.matchesPerDay, 8));
    const planned = [];
    if (stage === 'knockout') {
      let seeds = entries;
      if (ev.drawType === 'groups_knockout') {
        const st = await eventStandings(c, t, ev);
        if (!st.groups.length || st.groups.some((g) => g.rows.some((r) => r.played < g.rows.length - 1))) {
          if (!b.force) return res.status(409).json({ success: false, code: 'GROUPS_NOT_DONE', error: 'Not every group match is complete — finish the groups first (or generate anyway)' });
        }
        seeds = Draw.seedsFromGroups(st.groups, ev.qualifiersPerGroup || 2);
      }
      if (seeds.length < 2) return res.status(400).json({ success: false, error: 'Add at least two entries first' });
      const k = Draw.knockout(seeds, { thirdPlace: !!ev.thirdPlace, random: ev.randomUnseeded ? t.tournamentId + ':' + ev.eventId : false, prefix: ev.eventId });
      k.matches.forEach((m) => planned.push({ key: m.key, round: m.round, stage: { type: 'knockout', round: m.roundLabel, roundIndex: m.round, slot: m.slot }, A: m.A, B: m.B }));
      await c.tournaments.updateOne({ tournamentId: t.tournamentId, 'events.eventId': ev.eventId }, { $set: { 'events.$.lines': k.lines, 'events.$.drawSize': k.size, updatedAt: Date.now() } });
    } else {
      const groups = ev.groups && ev.groups.length ? ev.groups : [{ name: '', entryIds: entries.map((e) => e.entryId) }];
      groups.forEach((g) => {
        Draw.roundRobin(g.entryIds.filter((id) => byEntry.has(id))).forEach((f) => {
          const pair = [f.A, f.B].sort().join('|');
          planned.push({ key: `${ev.eventId}:RR:${g.name || 'L'}:${pair}`, round: f.round, stage: { type: 'group', group: g.name || '', round: (g.name ? 'Group ' + g.name + ' · ' : '') + 'Round ' + f.round, roundIndex: f.round }, A: { entryId: f.A }, B: { entryId: f.B } });
        });
      });
    }
    if (!planned.length) return res.status(400).json({ success: false, error: 'Add at least two entries first' });
    planned.sort((x, y) => x.round - y.round);
    let created = 0, existing = 0, i = 0;
    for (const p of planned) {
      if (await c.matches.findOne({ tournamentId: t.tournamentId, fixtureKey: p.key })) { existing++; continue; }
      const side = (x) => (x && x.entryId && byEntry.has(x.entryId) ? sideFromEntry(ev, byEntry.get(x.entryId), pm) : null);
      const src = (x) => (x && (x.winnerOf || x.loserOf) ? { winnerOf: x.winnerOf || null, loserOf: x.loserOf || null } : null);
      const scheduledAt = start ? start + Math.floor(i / perDay) * 86400000 + (i % perDay) * gapMs : null;
      const doc = await newMatchDoc(c, t, ev, { sideA: side(p.A), sideB: side(p.B), stage: p.stage, fixtureKey: p.key, scheduledAt, source: src(p.A) || src(p.B) ? { A: src(p.A), B: src(p.B) } : null });
      try { await c.matches.insertOne(doc); created++; i++; }
      catch (e) { if (e && e.code === 11000) existing++; else throw e; }
    }
    await audit(c, { action: 'draw.generate', tournamentId: t.tournamentId, by: byOf(user), details: { eventId: ev.eventId, stage, created, existing } });
    invalidateDirectory();
    res.json({ success: true, created, existing });
  }));
  function sideFromEntry(ev, en, pm) {
    const players = en.playerIds.map((id) => pm.get(id)).filter(Boolean).map((p) => snapPlayer(p, en.seed));
    return { entryId: en.entryId, name: en.name || sideName(ev.format, players), customName: !!en.name, seed: en.seed || null, players, color: (players[0] && players[0].color) || null };
  }
  async function eventStandings(c, t, ev) {
    const ms = await c.matches.find({ tournamentId: t.tournamentId, eventId: ev.eventId, 'stage.type': 'group' }).toArray();
    const entries = (ev.entries || []).filter((e) => !e.withdrawn);
    const groups = ev.groups && ev.groups.length ? ev.groups : (ev.drawType === 'round_robin' || ev.drawType === 'groups_knockout' ? [{ name: '', entryIds: entries.map((e) => e.entryId) }] : []);
    return {
      groups: groups.map((g) => {
        const ents = g.entryIds.map((id) => entries.find((e) => e.entryId === id)).filter(Boolean);
        const gms = ms.filter((m) => (m.stage.group || '') === (g.name || ''));
        return { name: g.name, rows: Draw.standings(ents.map((e) => ({ entryId: e.entryId, seed: e.seed })), gms) };
      })
    };
  }

  // My tournaments and players (the dashboard).
  app.get('/api/tennis/mine', requireCreator(async (req, res, user, c) => {
    const q = user.isOwner && req.query.all === '1' ? {} : { ownerUid: user.uid };
    const [ts, players] = await Promise.all([
      c.tournaments.find(q).sort({ updatedAt: -1 }).limit(200).toArray(),
      c.players.find(q).sort({ updatedAt: -1 }).limit(2000).toArray()
    ]);
    const counts = {};
    if (ts.length) {
      const ms = await c.matches.find({ tournamentId: { $in: ts.map((t) => t.tournamentId) } }).project({ tournamentId: 1, status: 1 }).toArray();
      ms.forEach((m) => { const k = counts[m.tournamentId] = counts[m.tournamentId] || { matches: 0, live: 0, completed: 0 }; k.matches++; if (m.status === 'live') k.live++; if (m.status === 'completed') k.completed++; });
    }
    res.json({ success: true, user: { email: user.email, isOwner: user.isOwner }, tournaments: ts.map((t) => Object.assign(publicTournament(t, user), { events: (t.events || []).map((e) => ({ eventId: e.eventId, name: e.name, format: e.format, entries: (e.entries || []).length })), counts: counts[t.tournamentId] || { matches: 0, live: 0, completed: 0 } })), players: players.map((p) => publicPlayer(p, { manage: true })) });
  }));

  // A tournament page: details, events with their draws, matches, standings.
  app.get('/api/tennis/tournaments/:tid', openRoute(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t || !canView(user, t)) return res.status(404).json({ success: false, error: 'Tournament not found' });
    const [ms, pm] = await Promise.all([c.matches.find({ tournamentId: t.tournamentId }).sort({ scheduledAt: 1, matchNo: 1 }).toArray(), playersMap(c, eventPlayerIds(t))]);
    const manage = canManage(user, t);
    const events = [];
    for (const ev of t.events || []) {
      const st = ev.drawType === 'knockout' ? { groups: [] } : await eventStandings(c, t, ev);
      events.push(Object.assign(publicEvent(ev, pm), { standings: st.groups }));
    }
    res.json({ success: true, tournament: publicTournament(t, user), events, matches: ms.map((m) => publicMatch(m, manage)) });
  }));
  app.get('/api/tennis/public/tournaments', openRoute(async (req, res, user, c) => {
    const ownerView = !!(user && user.isOwner);
    if (!ownerView && directoryCache && directoryCache.at > Date.now() - 15000) return res.json(directoryCache.payload);
    const ts = await c.tournaments.find({}).sort({ updatedAt: -1 }).limit(300).toArray();
    const ms = ts.length ? await c.matches.find({ tournamentId: { $in: ts.map((t) => t.tournamentId) } }).project({ tournamentId: 1, status: 1 }).toArray() : [];
    const list = [];
    for (const t of ts) {
      if (t.archived) continue;
      const vis = visibilityOf(t);
      if (vis !== 'public' && !ownerView) continue;
      const mine = ms.filter((m) => m.tournamentId === t.tournamentId);
      const live = mine.filter((m) => m.status === 'live' || m.status === 'paused').length, done = mine.filter((m) => m.status === 'completed').length;
      list.push({
        tournamentId: t.tournamentId, sport: 'tennis', name: t.name, venue: t.venue || '', city: t.city || '', surface: t.surface || 'hard',
        startDate: t.startDate || '', endDate: t.endDate || '', logo: t.logo ? `/api/tennis/tournaments/${t.tournamentId}/logo?v=${t.logoV || 1}` : null,
        status: t.status === 'completed' ? 'completed' : live ? 'live' : done ? 'ongoing' : 'upcoming',
        events: (t.events || []).length, matchCount: done, liveCount: live, upcomingCount: mine.filter((m) => m.status === 'scheduled' || m.status === 'ready').length,
        updatedAt: t.updatedAt || 0, url: `/tennis/tournament/${t.tournamentId}`,
        ...(ownerView ? { visibility: vis, createdBy: t.createdBy || null } : {})
      });
    }
    const payload = { success: true, tournaments: list, ownerView };
    if (!ownerView) directoryCache = { at: Date.now(), payload };
    res.json(payload);
  }));
  let directoryCache = null;
  function invalidateDirectory() { directoryCache = null; }

  /* ------------------------------------------------------------ matches */
  function withPhotos(side) {
    if (!side) return null;
    return Object.assign({}, side, { players: (side.players || []).map((p) => Object.assign({}, p, { photo: p.photoV ? `/api/tennis/players/${p.playerId}/photo?v=${p.photoV}` : null })) });
  }
  function publicMatch(m, manage) {
    if (!m) return null;
    const o = {
      matchId: m.matchId, tournamentId: m.tournamentId, eventId: m.eventId || null, eventName: m.eventName || '', matchNo: m.matchNo || null, title: m.title || '',
      stage: m.stage || null, fixtureKey: m.fixtureKey || null, source: m.source || null, format: m.format, category: m.category || 'open',
      sides: { A: withPhotos(m.sides && m.sides.A), B: withPhotos(m.sides && m.sides.B) },
      scheduledAt: m.scheduledAt || null, venue: m.venue || '', court: m.court || '', surface: m.surface || 'hard', notes: m.notes || '',
      officials: m.officials || {}, broadcastInfo: m.broadcastInfo || {}, rules: m.rules, status: m.status, locked: !!m.locked, lockReason: m.locked ? m.lockReason || '' : '',
      summary: m.summary || null, result: m.result || null, eventSeq: m.eventSeq || 0, startedAt: m.startedAt || null, completedAt: m.completedAt || null,
      tracking: m.tracking || defaultTracking(), clip: cleanClipWindow(m.clip),
      report: m.report ? { status: m.report.status, version: m.report.version || 0, generatedAt: m.report.generatedAt || null, stale: !!m.report.stale, url: m.report.status === 'ready' || m.report.version ? `/api/tennis/matches/${m.matchId}/report.pdf` : null } : null,
      lease: publicLease(m.lease), graphic: G.publicState(airOf(m), Date.now())
    };
    if (manage) { o.clipToken = m.clipToken; o.overlayKey = m.overlayKey; o.canManage = true; o.clipper = publicClipper(m.clipper); }
    return o;
  }
  function defaultTracking() { return { serve: true, outcomes: true, net: false, shots: false, speed: false }; }
  function publicLease(l) {
    if (!l) return null;
    return { deviceId: l.deviceId, email: l.email, since: l.since, heartbeatAt: l.heartbeatAt, active: l.heartbeatAt > Date.now() - LEASE_TTL_MS };
  }
  async function nextMatchNo(c, tid) {
    const last = await c.matches.find({ tournamentId: tid }).sort({ matchNo: -1 }).limit(1).toArray();
    return ((last[0] && last[0].matchNo) || 0) + 1;
  }
  async function newMatchDoc(c, t, ev, o) {
    const now = Date.now();
    const format = ev ? ev.format : (o.format === 'doubles' ? 'doubles' : 'singles');
    const doc = {
      matchId: newId('tnm'), tournamentId: t.tournamentId, eventId: ev ? ev.eventId : null, eventName: ev ? ev.name : '', ownerUid: t.ownerUid,
      matchNo: await nextMatchNo(c, t.tournamentId), title: str(o.title, 80), stage: o.stage || { type: 'friendly' }, source: o.source || null,
      format, category: ev ? ev.category : pick(o.category, CATEGORIES, 'open'),
      sides: { A: o.sideA || null, B: o.sideB || null },
      scheduledAt: o.scheduledAt || null, venue: str(o.venue || t.venue, 120), court: str(o.court, 40), surface: pick(o.surface, SURFACES, t.surface || 'hard'),
      notes: str(o.notes, 400), officials: o.officials || {}, broadcastInfo: o.broadcastInfo || {},
      rules: cleanRules(o.rules || (ev && ev.rules) || {}), status: 'scheduled', locked: !!o.locked, lease: null,
      eventSeq: 0, summary: null, result: null, report: null, tracking: defaultTracking(), clip: cleanClipWindow(o.clip, t.clip),
      clipToken: crypto.randomBytes(18).toString('hex'), overlayKey: crypto.randomBytes(9).toString('hex'),
      createdAt: now, updatedAt: now
    };
    if (o.fixtureKey) doc.fixtureKey = o.fixtureKey;
    return doc;
  }
  function cleanStage(s) {
    s = s && typeof s === 'object' ? s : {};
    const type = ['knockout', 'group', 'friendly', 'exhibition', 'qualifying'].includes(s.type) ? s.type : 'friendly';
    return { type, group: type === 'group' ? str(s.group, 12) : '', round: str(s.round, 40), roundIndex: num(s.roundIndex, null) };
  }
  function cleanOfficials(o) { o = o && typeof o === 'object' ? o : {}; return { umpire: str(o.umpire, 60), referee: str(o.referee, 60), lineJudges: str(o.lineJudges, 120) }; }
  function cleanBroadcastInfo(o) { o = o && typeof o === 'object' ? o : {}; const url = str(o.url, 300); return { channel: str(o.channel, 60), url: /^https?:\/\//i.test(url) ? url : '' }; }
  // A side from players named directly (a match outside a draw): singles one, doubles two.
  async function sideFromPlayers(c, user, format, b) {
    if (!b) return { side: null };
    const need = format === 'doubles' ? 2 : 1;
    const ids = (Array.isArray(b.playerIds) ? b.playerIds : []).filter(idOk);
    if (!ids.length) return { side: null };
    if (ids.length !== need) return { error: format === 'doubles' ? 'A doubles side has two players' : 'A singles side has one player' };
    const pm = await playersMap(c, ids);
    const players = [];
    for (const id of ids) {
      const p = pm.get(id);
      if (!p || (!user.isOwner && p.ownerUid !== user.uid)) return { error: 'Choose players from your player list' };
      players.push(snapPlayer(p, b.seed));
    }
    return { side: { entryId: null, name: str(b.name, 60) || sideName(format, players), customName: !!str(b.name, 60), seed: b.seed ? Math.round(num(b.seed, 0)) || null : null, players, color: color(b.color, (players[0] && players[0].color) || null) } };
  }
  app.post('/api/tennis/tournaments/:tid/matches', requireCreator(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t) return res.status(404).json({ success: false, error: 'No such tournament' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your tournament' });
    const b = req.body || {};
    const ev = b.eventId ? (t.events || []).find((e) => e.eventId === b.eventId) : null;
    if (b.eventId && !ev) return res.status(400).json({ success: false, error: 'No such event in this tournament' });
    const format = ev ? ev.format : (b.format === 'doubles' ? 'doubles' : 'singles');
    let A = null, B = null;
    if (ev && (b.entryA || b.entryB)) {
      const byEntry = new Map((ev.entries || []).map((e) => [e.entryId, e]));
      if ((b.entryA && !byEntry.has(b.entryA)) || (b.entryB && !byEntry.has(b.entryB))) return res.status(400).json({ success: false, error: 'Unknown entry' });
      if (b.entryA && b.entryA === b.entryB) return res.status(400).json({ success: false, error: 'An entry cannot play itself' });
      const pm = await playersMap(c, [].concat(...(ev.entries || []).map((e) => e.playerIds)));
      A = b.entryA ? sideFromEntry(ev, byEntry.get(b.entryA), pm) : null;
      B = b.entryB ? sideFromEntry(ev, byEntry.get(b.entryB), pm) : null;
    } else {
      const ra = await sideFromPlayers(c, user, format, b.sideA), rb = await sideFromPlayers(c, user, format, b.sideB);
      if (ra.error || rb.error) return res.status(400).json({ success: false, error: ra.error || rb.error });
      A = ra.side; B = rb.side;
    }
    if (A && B && A.players.some((p) => B.players.some((q) => q.playerId === p.playerId))) return res.status(400).json({ success: false, error: 'A player cannot be on both sides' });
    const doc = await newMatchDoc(c, t, ev, { format, category: b.category, sideA: A, sideB: B, stage: cleanStage(b.stage), scheduledAt: num(b.scheduledAt, null), venue: b.venue, court: b.court, surface: b.surface || t.surface, notes: b.notes, title: b.title, rules: b.rules, officials: cleanOfficials(b.officials), broadcastInfo: cleanBroadcastInfo(b.broadcastInfo), locked: b.locked, clip: b.clip });
    await c.matches.insertOne(doc);
    await audit(c, { action: 'match.create', tournamentId: t.tournamentId, matchId: doc.matchId, by: byOf(user), details: { A: A && A.name, B: B && B.name, format } });
    invalidateDirectory();
    res.json({ success: true, match: publicMatch(doc, true) });
  }));

  async function loadMatch(c, matchId) { return c.matches.findOne({ matchId: String(matchId || '') }); }
  async function tournamentOf(c, m) { return m ? c.tournaments.findOne({ tournamentId: m.tournamentId }) : null; }
  async function matchAccess(c, user, matchId, key) {
    const m = await loadMatch(c, matchId);
    if (!m) return { status: 404 };
    const t = await tournamentOf(c, m);
    const manage = canManage(user, t);
    if (!manage && !canView(user, t) && !(key && sameSecret(key, m.overlayKey))) return { status: 404 };
    return { m, t, manage };
  }
  app.get('/api/tennis/matches/:mid', openRoute(async (req, res, user, c) => {
    const a = await matchAccess(c, user, req.params.mid, req.query.key);
    if (!a.m) return res.status(404).json({ success: false, error: 'Match not found' });
    const graphic = await currentAir(c, a.m);
    const out = { success: true, match: Object.assign(publicMatch(a.m, a.manage), { graphic: G.publicState(graphic, Date.now()) }), tournament: publicTournament(a.t, user) };
    if (req.query.timeline === '1') {
      const L = await getLedger(c, a.m);
      out.timeline = publicTimeline(L, a.manage);
      out.summary = E.summary(L.setup, L.state);
    }
    res.json(out);
  }));
  app.put('/api/tennis/matches/:mid', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'No such match' });
    const t = await tournamentOf(c, m);
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your match' });
    if (m.locked) return res.status(423).json({ success: false, code: 'MATCH_LOCKED', error: 'This match is locked — unlock it first' });
    const b = req.body || {};
    const set = { updatedAt: Date.now() };
    if (b.scheduledAt !== undefined) set.scheduledAt = num(b.scheduledAt, null);
    ['venue:120', 'notes:400', 'title:80', 'court:40'].forEach((f) => { const [k, n] = f.split(':'); if (b[k] != null) set[k] = str(b[k], Number(n)); });
    if (b.surface != null) set.surface = pick(b.surface, SURFACES, m.surface || 'hard');
    if (b.stage) set.stage = cleanStage(b.stage);
    if (b.officials) set.officials = cleanOfficials(b.officials);
    if (b.broadcastInfo) set.broadcastInfo = cleanBroadcastInfo(b.broadcastInfo);
    if (b.clip) set.clip = cleanClipWindow(b.clip);
    if (b.tracking && typeof b.tracking === 'object') set.tracking = Object.assign(defaultTracking(), m.tracking || {}, ['serve', 'outcomes', 'net', 'shots', 'speed'].reduce((o, k) => { if (b.tracking[k] != null) o[k] = !!b.tracking[k]; return o; }, {}));
    const notStarted = (m.eventSeq || 0) === 0 || (m.summary && m.summary.status === 'pregame');
    if (b.rules) {
      if (!notStarted || m.status === 'live' || (m.summary && m.summary.status !== 'pregame')) return res.status(409).json({ success: false, code: 'RULES_LOCKED', error: 'The match has started — its scoring format can no longer change' });
      set.rules = cleanRules(b.rules);
    }
    // the players: only before the first point (a toss may stand)
    if (b.sideA !== undefined || b.sideB !== undefined || b.format) {
      if (m.summary && m.summary.status && m.summary.status !== 'pregame') return res.status(409).json({ success: false, error: 'The match has started — the players can no longer change' });
      const format = b.format === 'doubles' || b.format === 'singles' ? (m.eventId ? m.format : b.format) : m.format;
      set.format = format;
      for (const s of ['A', 'B']) {
        const v = b['side' + s];
        if (v === undefined) continue;
        const r = await sideFromPlayers(c, user, format, v);
        if (r.error) return res.status(400).json({ success: false, error: r.error });
        set['sides.' + s] = r.side;
      }
      const A2 = set['sides.A'] !== undefined ? set['sides.A'] : m.sides.A, B2 = set['sides.B'] !== undefined ? set['sides.B'] : m.sides.B;
      if (A2 && B2 && A2.players.some((p) => B2.players.some((q) => q.playerId === p.playerId))) return res.status(400).json({ success: false, error: 'A player cannot be on both sides' });
    }
    await c.matches.updateOne({ matchId: m.matchId }, { $set: set });
    dropLedger(m.matchId);
    await audit(c, { action: 'match.update', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { fields: Object.keys(set) } });
    const next = await loadMatch(c, m.matchId);
    broadcastMatchDoc(next);
    res.json({ success: true, match: publicMatch(next, true) });
  }));
  app.delete('/api/tennis/matches/:mid', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'No such match' });
    const t = await tournamentOf(c, m);
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your match' });
    if (m.locked) return res.status(423).json({ success: false, code: 'MATCH_LOCKED', error: 'This match is locked — unlock it first' });
    if ((m.eventSeq || 0) > 0) return res.status(409).json({ success: false, error: 'A match that has been started is never deleted — mark it abandoned instead' });
    await c.matches.deleteOne({ matchId: m.matchId });
    await audit(c, { action: 'match.delete', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { A: m.sides.A && m.sides.A.name, B: m.sides.B && m.sides.B.name } });
    invalidateDirectory();
    res.json({ success: true });
  }));
  app.post('/api/tennis/matches/:mid/lock', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'No such match' });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false, error: 'Not your match' });
    const locked = !!(req.body && req.body.locked);
    const set = locked ? { locked: true, lockedAt: Date.now(), lockedBy: user.email, lockReason: str(req.body.reason, 200) } : { locked: false, lockReason: '', unlockedAt: Date.now(), unlockedBy: user.email };
    await c.matches.updateOne({ matchId: m.matchId }, { $set: set });
    await audit(c, { action: locked ? 'match.lock' : 'match.unlock', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { reason: set.lockReason || '' } });
    const next = await loadMatch(c, m.matchId);
    broadcastMatchDoc(next);
    res.json({ success: true, match: publicMatch(next, true) });
  }));

  /* ------------------------------------------------------------ controller lease */
  const leaseBeats = new Map();
  async function claimLease(c, user, m, deviceId, force) {
    if (m.locked) return { status: 423, body: { success: false, code: 'MATCH_LOCKED', error: 'This match is locked — unlock it to score it' } };
    const now = Date.now(), cur = m.lease;
    const active = cur && cur.heartbeatAt > now - LEASE_TTL_MS;
    if (active && cur.deviceId !== deviceId && !force) return { status: 409, body: { success: false, code: 'LEASE_HELD', error: `${cur.email || 'Another device'} is scoring this match right now`, holder: publicLease(cur) } };
    const token = crypto.randomBytes(24).toString('hex');
    const lease = { deviceId, tokenHash: sha(token), uid: user.uid, email: user.email, since: now, heartbeatAt: now };
    const filter = cur ? { matchId: m.matchId, 'lease.tokenHash': cur.tokenHash } : { matchId: m.matchId, lease: null };
    const r = await c.matches.updateOne(filter, { $set: { lease } });
    if (!r.matchedCount) return { status: 409, body: { success: false, code: 'LEASE_RACE', error: 'Another device took control at the same moment — try again' } };
    leaseBeats.set(m.matchId, now);
    await audit(c, { action: cur && cur.deviceId !== deviceId ? (active ? 'lease.takeover' : 'lease.claim-expired') : 'lease.claim', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user, { deviceId }), details: cur ? { previous: cur.email, previousDevice: cur.deviceId } : {} });
    nsp.to(room(m.matchId)).emit('tn:lease', { matchId: m.matchId, lease: publicLease(lease) });
    return { status: 200, body: { success: true, leaseToken: token, lease: publicLease(lease) } };
  }
  function leaseOk(m, token) { return !!(m && m.lease && token && sameSecret(sha(token), m.lease.tokenHash)); }
  async function beat(c, m) {
    const now = Date.now();
    if (now - (leaseBeats.get(m.matchId) || 0) < 10000) return;
    leaseBeats.set(m.matchId, now);
    await c.matches.updateOne({ matchId: m.matchId, 'lease.tokenHash': m.lease.tokenHash }, { $set: { 'lease.heartbeatAt': now } }).catch(() => {});
  }
  app.post('/api/tennis/matches/:mid/lease', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'No such match' });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false, error: 'Not your match' });
    const deviceId = str(req.body && req.body.deviceId, 64);
    if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId required' });
    const r = await claimLease(c, user, m, deviceId, !!(req.body && req.body.force));
    res.status(r.status).json(r.body);
  }));
  app.delete('/api/tennis/matches/:mid/lease', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false });
    if (!leaseOk(m, req.get('x-tn-lease'))) return res.status(403).json({ success: false, error: 'Only the device in control can release it' });
    await c.matches.updateOne({ matchId: m.matchId, 'lease.tokenHash': m.lease.tokenHash }, { $set: { lease: null } });
    await audit(c, { action: 'lease.release', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user, { deviceId: m.lease.deviceId }) });
    nsp.to(room(m.matchId)).emit('tn:lease', { matchId: m.matchId, lease: null });
    res.json({ success: true });
  }));

  /* ------------------------------------------------------------ the ledger */
  const ledgers = new Map();
  function setupOf(m) {
    const side = (s) => {
      const x = m.sides && m.sides[s];
      return { name: x ? x.name : (s === 'A' ? 'Player A' : 'Player B'), players: x ? (x.players || []).map((p) => ({ playerId: p.playerId, name: p.name, short: p.short, country: p.country })) : [] };
    };
    return { format: m.format, rules: m.rules, sides: { A: side('A'), B: side('B') } };
  }
  function dropLedger(matchId) { ledgers.delete(matchId); }
  async function getLedger(c, m) {
    const setupKey = sha(JSON.stringify(setupOf(m)));
    const hit = ledgers.get(m.matchId);
    if (hit && hit.setupKey === setupKey && hit.ledger.seq === (m.eventSeq || 0)) {
      ledgers.delete(m.matchId); ledgers.set(m.matchId, hit);
      return hit.ledger;
    }
    const rows = await c.events.find({ matchId: m.matchId }).sort({ seq: 1 }).toArray();
    const L = new E.Ledger(setupOf(m), rows.map(dbEventToEvent));
    ledgers.set(m.matchId, { ledger: L, setupKey });
    while (ledgers.size > LEDGER_CACHE_MAX) ledgers.delete(ledgers.keys().next().value);
    return L;
  }
  function dbEventToEvent(r) { const o = clean(r); delete o.matchId; return o; }
  function publicTimeline(L, manage) {
    return manage ? L.timeline : L.timeline.map((e) => { if (!e.by) return e; const o = Object.assign({}, e); delete o.by; return o; });
  }
  function publicEv(ev) { if (!ev) return null; const o = Object.assign({}, ev); delete o.by; delete o.matchId; return o; }

  // Only the fields each event type may carry — nothing else is stored.
  function sanitizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = String(raw.type || '');
    if (!E.EVENT_TYPES.includes(type)) return null;
    if (!idOk(raw.eventId)) return null;
    const ev = { eventId: raw.eventId, type, at: num(raw.at, null) };
    const side = (v) => (v === 'A' || v === 'B' ? v : undefined);
    const pid = (v) => (idOk(v) ? v : undefined);
    const put = (k, v) => { if (v !== undefined && v !== null && v !== '') ev[k] = v; };
    const order = (v) => (Array.isArray(v) ? v.slice(0, 4).map((x) => (idOk(x) ? x : '')) : undefined);
    const receive = (v) => {
      if (!v || typeof v !== 'object') return undefined;
      const o = {};
      ['A', 'B'].forEach((s) => { if (v[s] && typeof v[s] === 'object') o[s] = { deuce: pid(v[s].deuce) || '', ad: pid(v[s].ad) || '' }; });
      return Object.keys(o).length ? o : undefined;
    };
    const pointFields = (src, dst) => {
      const p = (k, v) => { if (v !== undefined && v !== null && v !== '') dst[k] = v; };
      p('winner', side(src.winner));
      if (src.kind != null) p('kind', E.KINDS[src.kind] ? src.kind : undefined);
      p('player', pid(src.player));
      if (src.serve === 1 || src.serve === 2) dst.serve = src.serve;
      p('receiver', pid(src.receiver));
      p('net', side(src.net));
      if (src.stroke != null) p('stroke', E.STROKES[src.stroke] ? src.stroke : undefined);
      if (src.rally != null && Number.isFinite(Number(src.rally))) dst.rally = Math.max(0, Math.min(999, Math.round(Number(src.rally))));
      if (src.loc && typeof src.loc === 'object' && Number.isFinite(Number(src.loc.x)) && Number.isFinite(Number(src.loc.y))) dst.loc = { x: Math.max(-20, Math.min(20, Number(src.loc.x))), y: Math.max(-12, Math.min(12, Number(src.loc.y))) };
      if (src.speed != null && Number.isFinite(Number(src.speed)) && Number(src.speed) > 0 && Number(src.speed) < 300) dst.speed = Math.round(Number(src.speed));
      if (src.serveDir != null) p('serveDir', E.SERVE_DIRS[src.serveDir] ? src.serveDir : undefined);
      if (src.note != null) p('note', str(src.note, 200));
    };
    switch (type) {
      case 'TOSS': put('winner', side(raw.winner)); put('choice', ['serve', 'receive', 'end', 'defer'].includes(raw.choice) ? raw.choice : undefined); put('firstServe', side(raw.firstServe)); put('left', side(raw.left)); break;
      case 'START': put('server', pid(raw.server)); put('order', order(raw.order)); put('receive', receive(raw.receive)); put('left', side(raw.left)); break;
      case 'POINT': pointFields(raw, ev); break;
      case 'FAULT': if (raw.foot) ev.foot = true; if (raw.speed != null && Number(raw.speed) > 0 && Number(raw.speed) < 300) ev.speed = Math.round(Number(raw.speed)); if (E.SERVE_DIRS[raw.serveDir]) ev.serveDir = raw.serveDir; break;
      case 'LET': break;
      case 'SET_ORDER': put('order', order(raw.order)); put('receive', receive(raw.receive)); break;
      case 'SERVE_CORRECTION': put('server', pid(raw.server)); put('order', order(raw.order)); put('receive', receive(raw.receive)); put('reason', str(raw.reason, 200)); break;
      case 'ENDS': put('left', side(raw.left)); put('reason', str(raw.reason, 200)); break;
      case 'PAUSE': case 'SUSPEND': put('kind', E.INTERRUPTIONS[raw.kind] ? raw.kind : 'OTHER'); put('reason', str(raw.reason, 200)); put('side', side(raw.side)); break;
      case 'RESUME': break;
      case 'RETIRE': case 'WALKOVER': case 'DEFAULT': put('side', side(raw.side)); put('reason', str(raw.reason, 200)); break;
      case 'ABANDON': put('reason', str(raw.reason, 200)); break;
      case 'MANUAL_STAT': put('playerId', pid(raw.playerId)); put('key', E.MANUAL_STATS[raw.key] ? raw.key : undefined); ev.value = raw.value === null ? null : num(raw.value, null); break;
      case 'NOTE': put('text', str(raw.text, 500)); break;
      case 'UNDO': case 'REDO': case 'VOID': put('target', idOk(raw.target) ? raw.target : undefined); put('reason', str(raw.reason, 200)); break;
      case 'CORRECT': {
        put('target', idOk(raw.target) ? raw.target : undefined); put('reason', str(raw.reason, 200));
        const p = raw.patch && typeof raw.patch === 'object' ? raw.patch : {};
        const patch = {};
        pointFields(p, patch);
        // a detail may be cleared (null): "no player", "generic point"
        ['kind', 'player', 'stroke', 'net', 'rally', 'loc', 'speed', 'serveDir', 'note', 'receiver', 'serve'].forEach((k) => { if (p[k] === null) patch[k] = null; });
        ev.patch = patch;
        break;
      }
    }
    return ev;
  }

  const chains = new Map();
  function serial(matchId, fn) {
    const run = (chains.get(matchId) || Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    chains.set(matchId, tail);
    tail.then(() => { if (chains.get(matchId) === tail) chains.delete(matchId); });
    return run;
  }
  const CORRECTION_TYPES = new Set(['VOID', 'CORRECT', 'SERVE_CORRECTION', 'RETIRE', 'WALKOVER', 'DEFAULT', 'ABANDON']);
  function statusFor(state) {
    switch (state.status) {
      case 'pregame': return state.toss ? 'ready' : 'scheduled';
      case 'in_play': return 'live';
      case 'paused': return 'paused';
      case 'suspended': return 'suspended';
      case 'completed': return 'completed';
      case 'abandoned': return 'abandoned';
    }
    return 'live';
  }

  // THE write path, for the socket and REST alike.
  async function submitEvent(c, user, matchId, rawEvent, leaseToken) {
    return serial(String(matchId), async () => {
      const m = await loadMatch(c, matchId);
      if (!m) return { ok: false, status: 404, code: 'NO_MATCH', error: 'No such match' };
      const t = await tournamentOf(c, m);
      if (!canManage(user, t)) return { ok: false, status: 403, code: 'NOT_AUTHORISED', error: 'Not your match' };
      const ev = sanitizeEvent(rawEvent);
      if (!ev) return { ok: false, status: 400, code: 'INVALID_EVENT', error: 'That event is not valid' };
      const L = await getLedger(c, m);
      if (L.has(ev.eventId)) return { ok: true, duplicate: true, seq: L.seq, summary: E.summary(L.setup, L.state) };
      if (m.locked) return { ok: false, status: 423, code: 'MATCH_LOCKED', error: 'This match is locked' };
      if (!leaseOk(m, leaseToken)) return { ok: false, status: 409, code: 'LEASE_REQUIRED', error: 'This device is not in control of the match — take control first', lease: publicLease(m.lease) };
      if ((m.status === 'completed' || m.status === 'abandoned') && E.META[ev.type] && !ev.reason) {
        return { ok: false, status: 400, code: 'REASON_REQUIRED', error: 'The match is over — give a reason for changing it' };
      }
      ev.by = { uid: user.uid, email: user.email, deviceId: m.lease.deviceId };
      ev.receivedAt = Date.now();
      if (!ev.at || Math.abs(ev.at - ev.receivedAt) > 6 * 3600 * 1000) ev.at = ev.receivedAt;
      const chk = L.check(ev);
      if (!chk.ok) {
        if (chk.duplicate) return { ok: true, duplicate: true, seq: L.seq, summary: E.summary(L.setup, L.state) };
        return { ok: false, status: 409, code: chk.code, error: chk.error };
      }
      const stored = Object.assign({ matchId: m.matchId }, chk.pending.event);
      try { await c.events.insertOne(stored); }
      catch (e) {
        if (e && e.code === 11000) {
          dropLedger(m.matchId);
          const again = await c.events.findOne({ matchId: m.matchId, eventId: ev.eventId });
          const fresh = await getLedger(c, await loadMatch(c, m.matchId));
          if (again) return { ok: true, duplicate: true, seq: fresh.seq, summary: E.summary(fresh.setup, fresh.state) };
          return { ok: false, status: 409, code: 'CONFLICT', error: 'The match changed on another device — refreshed, please try again', retry: true };
        }
        dropLedger(m.matchId);
        throw e;
      }
      const before = E.summary(L.setup, L.state);
      L.commit(chk.pending);
      const summary = E.summary(L.setup, L.state);
      const prevStatus = m.status;
      const status = statusFor(L.state);
      const set = { eventSeq: L.seq, summary, status, updatedAt: Date.now(), lastEventAt: ev.receivedAt, result: L.state.result && L.state.status === 'completed' ? L.state.result : (L.state.status === 'abandoned' ? L.state.result : null) };
      if (!m.startedAt && L.state.startedAt) set.startedAt = L.state.startedAt;
      if (!L.state.startedAt && m.startedAt) set.startedAt = null;
      if (status === 'completed' && prevStatus !== 'completed') set.completedAt = Date.now();
      if (status !== 'completed' && prevStatus === 'completed') { set.completedAt = null; set.reopenedAt = Date.now(); if (m.report) set['report.stale'] = true; }
      if (status === 'completed' && prevStatus === 'completed' && m.report && m.report.sourceSeq !== L.seq) set['report.stale'] = true;
      await c.matches.updateOne({ matchId: m.matchId }, { $set: set });
      await beat(c, m);
      if ((prevStatus === 'scheduled' || prevStatus === 'ready') && status !== 'scheduled' && status !== 'ready') {
        await c.tournaments.updateOne({ tournamentId: m.tournamentId }, { $set: { status: t.status === 'completed' ? 'completed' : 'ongoing', updatedAt: Date.now() } });
        if (m.eventId) await c.tournaments.updateOne({ tournamentId: m.tournamentId, 'events.eventId': m.eventId }, { $set: { 'events.$.rulesLocked': true } });
        await audit(c, { action: 'match.start', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user) });
      }
      if (CORRECTION_TYPES.has(ev.type) || (ev.type === 'UNDO' && (prevStatus === 'completed' || prevStatus === 'abandoned'))) {
        await audit(c, { action: 'event.' + ev.type.toLowerCase(), tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { eventId: ev.eventId, target: ev.target || null, reason: ev.reason || null, patch: ev.patch || null, side: ev.side || null } });
      }
      if (status !== 'completed' && prevStatus === 'completed') await audit(c, { action: 'match.reopen', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { by: ev.type } });
      const entry = L.timeline[L.timeline.length - 1];
      const pubEntry = Object.assign({}, entry); delete pubEntry.by;
      // the entry the event changed (an undone or corrected point), for the panels and the overlay —
      // the ledger names the target of an Undo / Redo (the device may not have)
      const stamped = chk.pending.event;
      const touched = stamped.target ? L.entry(stamped.target) : null;
      const pubTouched = touched ? Object.assign({}, touched) : null;
      if (pubTouched) delete pubTouched.by;
      const full = !!E.META[ev.type] && chk.pending.mode === 'full';
      nsp.to(room(m.matchId)).emit('tn:update', { matchId: m.matchId, seq: L.seq, status, summary, entry: pubEntry, touched: pubTouched, event: publicEv(chk.pending.event), full, at: Date.now() });
      afterEventAir(c, m.matchId, stamped, entry, touched, before, summary).catch((e) => log('graphic after-event error', e.message || e));
      if (prevStatus !== status) invalidateDirectory();
      if (status === 'completed' && prevStatus !== 'completed') {
        const done = await loadMatch(c, m.matchId);
        await audit(c, { action: 'match.complete', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { result: done.result } });
        afterCompletion(c, done).catch((e) => log('after-completion error', e.message || e));
      }
      if (status !== 'completed' && prevStatus === 'completed') afterReopen(c, await loadMatch(c, m.matchId)).catch((e) => log('after-reopen error', e.message || e));
      return { ok: true, seq: L.seq, summary, entry: pubEntry, status, event: publicEv(chk.pending.event) };
    });
  }
  app.post('/api/tennis/matches/:mid/events', requireCreator(async (req, res, user, c) => {
    const r = await submitEvent(c, user, req.params.mid, req.body && req.body.event, req.get('x-tn-lease') || (req.body && req.body.leaseToken));
    res.status(r.ok ? 200 : (r.status || 400)).json(Object.assign({ success: r.ok }, r));
  }));
  app.get('/api/tennis/matches/:mid/timeline', openRoute(async (req, res, user, c) => {
    const a = await matchAccess(c, user, req.params.mid, req.query.key);
    if (!a.m) return res.status(404).json({ success: false, error: 'Match not found' });
    const L = await getLedger(c, a.m);
    res.json({ success: true, seq: L.seq, timeline: publicTimeline(L, a.manage), summary: E.summary(L.setup, L.state), setup: L.setup });
  }));

  /* ------------------------------------------------------------ statistics */
  const statsCache = new Map();
  async function statsOf(c, m) {
    const L = await getLedger(c, m);
    const k = `${m.matchId}:${L.seq}:${ledgers.get(m.matchId) ? ledgers.get(m.matchId).setupKey : ''}`;
    if (statsCache.has(k)) return statsCache.get(k);
    const s = Stats.compute({ setup: L.setup, state: L.state, timeline: L.timeline });
    statsCache.set(k, s);
    while (statsCache.size > 500) statsCache.delete(statsCache.keys().next().value);
    return s;
  }
  app.get('/api/tennis/matches/:mid/stats', openRoute(async (req, res, user, c) => {
    const a = await matchAccess(c, user, req.params.mid, req.query.key);
    if (!a.m) return res.status(404).json({ success: false, error: 'Match not found' });
    res.json({ success: true, stats: await statsOf(c, a.m), clipCounts: await clipCountsByPlayer(c, a.m) });
  }));
  // Tournament leaderboards: summed from the matches' ledgers.
  app.get('/api/tennis/tournaments/:tid/stats', openRoute(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t || !canView(user, t)) return res.status(404).json({ success: false, error: 'Tournament not found' });
    const ms = await c.matches.find({ tournamentId: t.tournamentId, status: { $in: ['completed', 'live', 'paused', 'suspended'] } }).toArray();
    const totals = {};
    for (const m of ms) {
      const s = await statsOf(c, m);
      ['A', 'B'].forEach((side) => (m.sides[side] ? m.sides[side].players : []).forEach((p) => {
        const o = totals[p.playerId] = totals[p.playerId] || { playerId: p.playerId, name: p.name, country: p.country || '', matches: 0, won: 0, aces: 0, doubleFaults: 0, winners: null, unforcedErrors: null, bpConverted: 0, bpChances: 0, servicePoints: 0, servicePointsWon: 0, returnPoints: 0, returnPointsWon: 0 };
        const src = s.format === 'doubles' ? s.players[p.playerId] : s.sides[side];
        if (!src) return;
        o.matches += 1;
        if (m.status === 'completed' && m.result && m.result.winner === side) o.won++;
        o.aces += src.serve.aces; o.doubleFaults += src.serve.doubleFaults;
        o.servicePoints += src.serve.points; o.servicePointsWon += src.serve.won;
        o.returnPoints += src.ret.points; o.returnPointsWon += src.ret.won;
        o.bpConverted += src.ret.bpConverted; o.bpChances += src.ret.bpChances;
        if (src.winners != null) o.winners = (o.winners || 0) + src.winners;
        if (src.unforcedErrors != null) o.unforcedErrors = (o.unforcedErrors || 0) + src.unforcedErrors;
      }));
    }
    res.json({ success: true, players: Object.values(totals), matches: ms.length });
  }));

  /* ------------------------------------------------------------ audit */
  app.get('/api/tennis/matches/:mid/audit', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false });
    const [entries, events] = await Promise.all([c.audit.find({ matchId: m.matchId }).sort({ at: -1 }).limit(500).toArray(), c.events.find({ matchId: m.matchId }).sort({ seq: -1 }).limit(1500).toArray()]);
    res.json({ success: true, audit: entries.map(clean), events: events.map(dbEventToEvent) });
  }));

  /* ------------------------------------------------------------ completion: the draw moves on, the report */
  async function afterCompletion(c, m) {
    await propagateDraw(c, m);
    scheduleReport(m.matchId, 'completed');
  }
  // Only a match that has REALLY been completed (the server's own replay of
  // its events says who won) puts its winner into the next round — and
  // only into a match that has not started. A reopened match takes its
  // winner back out of a match that has not started.
  async function propagateDraw(c, m) {
    if (!m.fixtureKey || !m.result || !m.result.winner || m.status !== 'completed') return;
    const key = m.fixtureKey, win = m.result.winner, lose = win === 'A' ? 'B' : 'A';
    const deps2 = await c.matches.find({ tournamentId: m.tournamentId, $or: [{ 'source.A.winnerOf': key }, { 'source.B.winnerOf': key }, { 'source.A.loserOf': key }, { 'source.B.loserOf': key }] }).toArray();
    for (const d of deps2) {
      const set = {};
      for (const s of ['A', 'B']) {
        const src = d.source && d.source[s];
        if (!src) continue;
        const from = src.winnerOf === key ? win : src.loserOf === key ? lose : null;
        if (!from || !m.sides[from]) continue;
        const want = m.sides[from];
        if (d.sides[s] && d.sides[s].entryId === want.entryId) continue;
        if ((d.eventSeq || 0) > 0) {
          await audit(c, { action: 'draw.conflict', tournamentId: m.tournamentId, matchId: d.matchId, details: { from: m.matchId, expected: want.entryId, has: d.sides[s] && d.sides[s].entryId } });
          continue;
        }
        set['sides.' + s] = Object.assign({}, want, { players: want.players.map((p) => Object.assign({}, p)) });
        set['filledFrom.' + s] = { matchId: m.matchId, seq: m.eventSeq };
      }
      if (Object.keys(set).length) {
        set.updatedAt = Date.now();
        // only while it has not started — checked in the write itself
        const r = await c.matches.updateOne({ matchId: d.matchId, eventSeq: 0 }, { $set: set });
        if (r.matchedCount) { await audit(c, { action: 'draw.advance', tournamentId: m.tournamentId, matchId: d.matchId, details: { from: m.matchId, sides: Object.keys(set).filter((k) => k.startsWith('sides.')) } }); dropLedger(d.matchId); broadcastMatchDoc(await loadMatch(c, d.matchId)); }
      }
    }
  }
  async function afterReopen(c, m) {
    if (!m || !m.fixtureKey) return;
    const deps2 = await c.matches.find({ tournamentId: m.tournamentId, $or: [{ 'filledFrom.A.matchId': m.matchId }, { 'filledFrom.B.matchId': m.matchId }] }).toArray();
    for (const d of deps2) {
      const set = {};
      ['A', 'B'].forEach((s) => { if (d.filledFrom && d.filledFrom[s] && d.filledFrom[s].matchId === m.matchId) { set['sides.' + s] = null; set['filledFrom.' + s] = null; } });
      if (!Object.keys(set).length) continue;
      const r = await c.matches.updateOne({ matchId: d.matchId, eventSeq: 0 }, { $set: Object.assign(set, { updatedAt: Date.now() }) });
      if (r.matchedCount) { await audit(c, { action: 'draw.withdraw', tournamentId: m.tournamentId, matchId: d.matchId, details: { reopened: m.matchId } }); dropLedger(d.matchId); broadcastMatchDoc(await loadMatch(c, d.matchId)); }
      else await audit(c, { action: 'draw.conflict', tournamentId: m.tournamentId, matchId: d.matchId, details: { reopened: m.matchId, note: 'the next match has started — check it' } });
    }
  }

  // 📄 PDF reports — one job at a time, never blocking scoring.
  const reportQueue = [], reportQueued = new Set();
  let reportBusy = false;
  function scheduleReport(matchId, reason) {
    if (reportQueued.has(matchId)) return;
    reportQueued.add(matchId);
    reportQueue.push({ matchId, reason });
    setImmediate(pumpReports);
  }
  async function pumpReports() {
    if (reportBusy) return;
    const job = reportQueue.shift();
    if (!job) return;
    reportQueued.delete(job.matchId);
    reportBusy = true;
    try { await generateReport(job.matchId, job.reason); }
    catch (e) { log('report error', job.matchId, e.message || e); }
    finally { reportBusy = false; setImmediate(pumpReports); }
  }
  async function playerPhoto(c, pid) {
    const p = await c.players.findOne({ playerId: pid });
    return p && p.photo && p.photo.data ? Buffer.from(p.photo.data, 'base64') : null;
  }
  async function generateReport(matchId, reason) {
    const c = await col();
    if (!c) return;
    const m = await loadMatch(c, matchId);
    if (!m || m.status !== 'completed') return;
    if (m.report && m.report.status === 'ready' && m.report.sourceSeq === m.eventSeq && reason !== 'regenerate') return;
    const version = ((m.report && m.report.version) || 0) + 1;
    await c.matches.updateOne({ matchId }, { $set: m.report ? { 'report.status': 'generating', 'report.startedAt': Date.now() } : { report: { status: 'generating', startedAt: Date.now(), version: 0, attempts: 0 } } });
    nsp.to(room(matchId)).emit('tn:report', { matchId, status: 'generating' });
    try {
      const t = await tournamentOf(c, m);
      const L = await getLedger(c, m);
      const stats = await statsOf(c, m);
      const photos = {};
      for (const s of ['A', 'B']) for (const p of (m.sides[s] ? m.sides[s].players : [])) photos[p.playerId] = await playerPhoto(c, p.playerId);
      const pdf = Report.build({ match: m, tournament: t, ledger: L, stats, photos, logo: t && t.logo ? Buffer.from(t.logo.data, 'base64') : null, version, ffmpegPath: deps.ffmpegPath, generatedAt: Date.now() });
      let storage = 'db', url = null, r2Key = null;
      const r2 = deps.r2 && deps.r2();
      if (r2 && r2.client && r2.bucket) {
        r2Key = `tennis/${m.tournamentId}/${m.matchId}/report-v${version}.pdf`;
        await r2.client.send(new r2.PutObjectCommand({ Bucket: r2.bucket, Key: r2Key, Body: pdf, ContentLength: pdf.length, ContentType: 'application/pdf', CacheControl: 'public, max-age=31536000, immutable' }));
        storage = 'r2'; url = r2.publicUrl ? `${r2.publicUrl}/${r2Key}` : null;
      }
      await c.reports.insertOne({ matchId, tournamentId: m.tournamentId, version, sourceSeq: m.eventSeq, bytes: pdf.length, storage, r2Key, url, data: storage === 'db' ? pdf.toString('base64') : null, reason: reason || 'completed', createdAt: Date.now() });
      await c.matches.updateOne({ matchId }, { $set: { report: { status: 'ready', version, sourceSeq: m.eventSeq, generatedAt: Date.now(), bytes: pdf.length, stale: false, attempts: 0 } } });
      await audit(c, { action: version > 1 ? 'report.regenerate' : 'report.generate', tournamentId: m.tournamentId, matchId, details: { version, bytes: pdf.length, storage, reason } });
      nsp.to(room(matchId)).emit('tn:report', { matchId, status: 'ready', version });
      log(`report v${version} ready for ${matchId} (${pdf.length} bytes, ${storage})`);
    } catch (e) {
      const attempts = ((m.report && m.report.attempts) || 0) + 1;
      await c.matches.updateOne({ matchId }, { $set: { report: Object.assign({}, m.report || { version: 0 }, { status: 'failed', error: String(e.message || e).slice(0, 300), attempts, failedAt: Date.now() }) } });
      nsp.to(room(matchId)).emit('tn:report', { matchId, status: 'failed' });
      log('report generation failed', matchId, e.stack || e);
    }
  }
  async function reportSweep() {
    const c = C;
    if (!c) return;
    try {
      const due = await c.matches.find({ status: 'completed', $or: [{ report: null }, { 'report.status': 'failed' }, { 'report.status': 'generating' }, { 'report.stale': true }] }).limit(10).toArray();
      due.forEach((m) => {
        const r = m.report || {};
        if (r.status === 'failed' && (r.attempts || 0) >= REPORT_MAX_ATTEMPTS) return;
        if (r.status === 'generating' && Date.now() - (r.startedAt || 0) < 120000) return;
        scheduleReport(m.matchId, r.stale ? 'corrected' : 'sweep');
      });
    } catch (e) { log('report sweep error', e.message || e); }
  }
  setInterval(reportSweep, 60 * 1000).unref();
  app.post('/api/tennis/matches/:mid/report', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false });
    if (m.status !== 'completed') return res.status(409).json({ success: false, error: 'The scorecard PDF is made when the match is complete' });
    if (m.report) await c.matches.updateOne({ matchId: m.matchId }, { $set: { 'report.attempts': 0 } });
    await audit(c, { action: 'report.request', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user) });
    scheduleReport(m.matchId, 'regenerate');
    res.json({ success: true, status: 'queued' });
  }));
  app.get('/api/tennis/matches/:mid/report.pdf', openRoute(async (req, res, user, c) => {
    const a = await matchAccess(c, user, req.params.mid, req.query.key);
    if (!a.m) return res.status(404).json({ success: false, error: 'Match not found' });
    const q = req.query.v ? { matchId: a.m.matchId, version: num(req.query.v, 0) } : { matchId: a.m.matchId };
    const rows = await c.reports.find(q).sort({ version: -1 }).limit(1).toArray();
    const r = rows[0];
    if (!r) return res.status(404).json({ success: false, error: a.m.status === 'completed' ? 'The scorecard is being prepared — try again in a moment' : 'The scorecard PDF is made when the match is complete', status: a.m.report ? a.m.report.status : null });
    const name = `${(a.m.sides.A && a.m.sides.A.name) || 'A'} vs ${(a.m.sides.B && a.m.sides.B.name) || 'B'} - tennis scorecard v${r.version}.pdf`.replace(/[^\w .()-]+/g, '');
    if (r.storage === 'r2' && r.url) return res.redirect(302, r.url);
    if (r.storage === 'r2' && r.r2Key && deps.r2 && deps.r2()) {
      const r2 = deps.r2();
      const obj = await r2.client.send(new r2.GetObjectCommand({ Bucket: r2.bucket, Key: r.r2Key }));
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
      return res.send(Buffer.from(await obj.Body.transformToByteArray()));
    }
    if (!r.data) return res.status(404).json({ success: false, error: 'Scorecard file missing' });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
    res.set('Cache-Control', 'no-cache');
    res.send(Buffer.from(r.data, 'base64'));
  }));

  /* ------------------------------------------------------------ clips
     A point's clip: "<matchId>_<the point's eventId>"; a clip pressed by
     hand (a celebration, a moment between points): "<matchId>_clip-<id>",
     with the kind and the player the operator chose. Every clip keeps the
     set, game and point it belongs to, and the score at the press. */
  function displayStatus(clip) {
    if (clip.deleted) return 'Deleted';
    const s = clip.status;
    if (s === 'COMPLETE') return 'Upload complete';
    if (s === 'SERVER_ONLY') return 'Saved on the website (no cloud storage set up)';
    if (s === 'FAILED_PERMANENT') return 'Failed';
    if (s === 'RETRY_PENDING' || s === 'NEEDS_REUPLOAD') return 'Upload pending';
    if (s === 'LOCAL_RECEIVED' || s === 'UPLOADING') return 'Uploading';
    const l = clip.local && clip.local.status;
    if (l === 'WAITING_FOR_POSTROLL') return 'Waiting for post-roll';
    if (l === 'CUTTING' || l === 'PROCESSING') return 'Processing';
    if (l === 'LOCAL_SAVED' || l === 'LOCAL_ONLY') return 'Saved locally';
    if (l === 'FORWARDING') return 'Uploading';
    if (l === 'RETRY_PENDING') return 'Upload pending';
    if (l === 'FAILED_PERMANENT') return 'Failed';
    if (s === 'UNAVAILABLE') return 'Unavailable';
    if (s === 'REQUESTED') return 'Waiting for post-roll';
    return 'Pending';
  }
  function clipPlayers(clip, entry, setup) {
    const derived = entry ? Stats.pointParticipants(setup, entry).map((p) => ({ playerId: p.playerId, side: p.side, role: p.role, source: 'point' })) : [];
    const chosen = clip.playerId ? [{ playerId: clip.playerId, side: clip.side || null, role: 'chosen', source: 'manual' }] : [];
    const manual = (clip.links || []).map((l) => ({ playerId: l.playerId, side: l.side || null, role: l.role || 'linked', source: 'manual' }));
    const excluded = new Set(clip.unlinked || []);
    const seen = new Set();
    return chosen.concat(derived, manual).filter((p) => { if (excluded.has(p.playerId) || seen.has(p.playerId)) return false; seen.add(p.playerId); return true; });
  }
  function publicClip(clip, entry, m, setup) {
    const pl = new Map([].concat((m.sides.A ? m.sides.A.players : []), (m.sides.B ? m.sides.B.players : [])).map((p) => [p.playerId, p]));
    return {
      clipId: clip.clipId, matchId: clip.matchId, eventId: clip.eventId || null, status: clip.status, displayStatus: displayStatus(clip), local: clip.local || null,
      kind: clip.kind || (entry ? Stats.clipKindOf(entry) : 'MANUAL'), kindLabel: Stats.CLIP_KINDS[clip.kind || (entry ? Stats.clipKindOf(entry) : 'MANUAL')] || 'Clip',
      set: clip.set || (entry && entry.before ? entry.before.set : null), game: clip.game || (entry && entry.before ? entry.before.game : null), pointNo: clip.pointNo || (entry ? entry.pointNo || null : null),
      side: entry ? entry.side : clip.side || null, pointKind: entry ? entry.kind : null,
      scoreAtTrigger: clip.scoreAtTrigger || null, eventVoided: !!(entry && entry.voided),
      requested: { preRollSec: clip.preRollSec || null, postRollSec: clip.postRollSec || null },
      actual: { durationSec: clip.durationSec || null, preRollSec: clip.actualPreRollSec != null ? clip.actualPreRollSec : null, partialPreRoll: !!clip.partialPreRoll },
      playbackUrl: clip.r2Url && clip.r2Status === 'uploaded' ? clip.r2Url : null,
      watchUrl: clip.r2Url || clip.filePath ? `/api/tennis/clips/${clip.clipId}/video` : null,
      posterUrl: clip.posterUrl || null, r2Status: clip.r2Status || null, driveStatus: clip.driveStatus || null, driveUrl: clip.driveUrl || null,
      players: clipPlayers(clip, entry, setup).map((p) => { const x = pl.get(p.playerId); return Object.assign({}, p, { name: x ? x.name : null }); }),
      engine: clip.engine || null, source: clip.source || null, cutOffline: !!clip.cutOffline, eventTimestamp: clip.eventTimestamp || null,
      createdAt: clip.createdAt || null, error: clip.error || null
    };
  }
  async function clipsOf(c, m) {
    const L = await getLedger(c, m);
    const byEvent = new Map(L.timeline.filter((e) => e.type === 'POINT').map((e) => [e.eventId, e]));
    const clips = await c.clips.find({ matchId: m.matchId, deleted: { $ne: true } }).sort({ createdAt: 1 }).limit(3000).toArray();
    return clips.map((cl) => publicClip(cl, cl.eventId ? byEvent.get(cl.eventId) || null : null, m, L.setup));
  }
  async function clipCountsByPlayer(c, m) {
    const list = await clipsOf(c, m);
    const counts = {};
    list.filter((x) => !x.eventVoided).forEach((x) => x.players.filter((p) => p.role !== 'error').forEach((p) => { counts[p.playerId] = (counts[p.playerId] || 0) + 1; }));
    return counts;
  }
  app.get('/api/tennis/matches/:mid/clips', openRoute(async (req, res, user, c) => {
    const a = await matchAccess(c, user, req.params.mid, req.query.key);
    if (!a.m) return res.status(404).json({ success: false, error: 'Match not found' });
    let list = await clipsOf(c, a.m);
    if (req.query.playerId) { const pid = String(req.query.playerId); list = list.filter((x) => !x.eventVoided && x.players.some((p) => p.playerId === pid && p.role !== 'error')); }
    if (req.query.eventId) list = list.filter((x) => x.eventId === String(req.query.eventId));
    if (req.query.kind) list = list.filter((x) => x.kind === String(req.query.kind));
    res.json({ success: true, clips: list });
  }));
  async function clipWithAccess(c, user, clipId, key) {
    const clip = await c.clips.findOne({ clipId: safeId(clipId) });
    if (!clip) return { status: 404 };
    const a = await matchAccess(c, user, clip.matchId, key || null);
    if (!a.m) return { status: 404 };
    return Object.assign({ clip }, a);
  }
  // The panel / clipper registers a clip as soon as the local clipper took it.
  app.post('/api/tennis/matches/:mid/clips', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false });
    const b = req.body || {};
    const clipId = safeId(b.clipId);
    if (!clipId.startsWith(m.matchId + '_')) return res.status(400).json({ success: false, error: 'clipId must belong to this match' });
    const eventId = idOk(b.eventId) ? b.eventId : null;
    if (!eventId && !/_clip-[A-Za-z0-9-]+$/.test(clipId)) return res.status(400).json({ success: false, error: 'A point clip names its point; a clip by hand is <match>_clip-<id>' });
    const status = b.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'REQUESTED';
    const local = { status: str(b.localStatus || (status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'WAITING_FOR_POSTROLL'), 32), error: str(b.error, 300) || null, at: Date.now(), engine: str(b.engine, 32) || null };
    const error = status === 'UNAVAILABLE' ? str(b.error, 300) || 'No clip engine was reachable' : null;
    const win = cleanClipWindow({ preRollSec: b.preRollSec, postRollSec: b.postRollSec }, m.clip);
    const timing = { eventTimestamp: num(b.t0, Date.now()), preRollSec: win.preRollSec, postRollSec: win.postRollSec, sourceSessionId: str(b.sourceSessionId, 80) || null };
    const kind = Stats.CLIP_KINDS[b.kind] ? b.kind : null;
    const squad = new Map([].concat((m.sides.A ? m.sides.A.players.map((p) => [p.playerId, 'A']) : []), (m.sides.B ? m.sides.B.players.map((p) => [p.playerId, 'B']) : [])));
    const playerId = b.playerId && squad.has(b.playerId) ? b.playerId : null;
    const sc = b.scoreAtTrigger && typeof b.scoreAtTrigger === 'object' ? b.scoreAtTrigger : null;
    const prev = await c.clips.findOne({ clipId });
    if (!prev) {
      try {
        await c.clips.insertOne(Object.assign({
          clipId, matchId: m.matchId, tournamentId: m.tournamentId, eventId, status, error, local, kind, playerId, side: playerId ? squad.get(playerId) : (b.side === 'A' || b.side === 'B' ? b.side : null),
          set: num(b.set, null), game: num(b.game, null), pointNo: num(b.pointNo, null),
          scoreAtTrigger: sc ? { sets: str(sc.sets, 40), games: str(sc.games, 20), points: str(sc.points, 20), set: num(sc.set, null) } : null,
          createdAt: Date.now(), retryCount: 0, r2Status: 'pending', driveStatus: 'pending'
        }, timing));
      } catch (e) { if (!(e && e.code === 11000)) throw e; }
    } else if (prev.eventId !== eventId) {
      return res.status(409).json({ success: false, error: 'That clip belongs to another point' });
    } else if (status === 'REQUESTED' && prev.status === 'UNAVAILABLE') {
      await c.clips.updateOne({ clipId, status: 'UNAVAILABLE' }, { $set: Object.assign({ status: 'REQUESTED', error: null, local }, timing) });
    } else if (status === prev.status && status === 'UNAVAILABLE') {
      await c.clips.updateOne({ clipId, status: 'UNAVAILABLE' }, { $set: { error, local } });
    }
    if (prev && (kind || playerId)) await c.clips.updateOne({ clipId }, { $set: Object.assign({}, kind ? { kind } : {}, playerId ? { playerId, side: squad.get(playerId) } : {}) });
    const doc = await c.clips.findOne({ clipId });
    emitClip(m.matchId, doc);
    res.json({ success: true, clip: { clipId, status: doc.status, displayStatus: displayStatus(doc) } });
  }));
  app.post('/api/tennis/clips/:clipId/local', requireCreator(async (req, res, user, c) => {
    const a = await clipWithAccess(c, user, req.params.clipId);
    if (!a.clip) return res.status(404).json({ success: false });
    if (!a.manage) return res.status(403).json({ success: false });
    const local = { status: str(req.body && req.body.status, 32), error: str(req.body && req.body.error, 300) || null, at: Date.now() };
    await c.clips.updateOne({ clipId: a.clip.clipId }, { $set: { local } });
    emitClip(a.m.matchId, Object.assign({}, a.clip, { local }));
    res.json({ success: true });
  }));
  // Link / unlink players by hand, or change the clip's kind.
  app.post('/api/tennis/clips/:clipId/players', requireCreator(async (req, res, user, c) => {
    const a = await clipWithAccess(c, user, req.params.clipId);
    if (!a.clip) return res.status(404).json({ success: false });
    if (!a.manage) return res.status(403).json({ success: false });
    const squad = new Map([].concat((a.m.sides.A ? a.m.sides.A.players.map((p) => [p.playerId, 'A']) : []), (a.m.sides.B ? a.m.sides.B.players.map((p) => [p.playerId, 'B']) : [])));
    const b = req.body || {};
    const links = (Array.isArray(b.links) ? b.links : []).filter((l) => l && squad.has(l.playerId)).slice(0, 8).map((l) => ({ playerId: l.playerId, side: squad.get(l.playerId), role: ['winner', 'ace', 'serve', 'won', 'linked', 'celebration'].includes(l.role) ? l.role : 'linked' }));
    const unlinked = (Array.isArray(b.unlinked) ? b.unlinked : []).filter((id) => squad.has(id)).slice(0, 8);
    const set = { links, unlinked, linksUpdatedAt: Date.now() };
    if (b.kind && Stats.CLIP_KINDS[b.kind]) set.kind = b.kind;
    await c.clips.updateOne({ clipId: a.clip.clipId }, { $set: set });
    await audit(c, { action: 'clip.links', tournamentId: a.m.tournamentId, matchId: a.m.matchId, by: byOf(user), details: { clipId: a.clip.clipId, links, unlinked, kind: set.kind || null } });
    emitClip(a.m.matchId, await c.clips.findOne({ clipId: a.clip.clipId }));
    res.json({ success: true });
  }));
  app.delete('/api/tennis/clips/:clipId', requireCreator(async (req, res, user, c) => {
    const a = await clipWithAccess(c, user, req.params.clipId);
    if (!a.clip) return res.status(404).json({ success: false });
    if (!a.manage) return res.status(403).json({ success: false });
    await c.clips.updateOne({ clipId: a.clip.clipId }, { $set: { deleted: true, deletedAt: Date.now(), deletedBy: user.email } });
    if (a.clip.filePath) fs.unlink(a.clip.filePath, () => {});
    const r2 = deps.r2 && deps.r2();
    if (r2 && r2.client && a.clip.r2Key) r2.client.send(new r2.DeleteObjectCommand({ Bucket: r2.bucket, Key: a.clip.r2Key })).catch(() => {});
    await audit(c, { action: 'clip.delete', tournamentId: a.m.tournamentId, matchId: a.m.matchId, by: byOf(user), details: { clipId: a.clip.clipId } });
    emitClip(a.m.matchId, Object.assign({}, a.clip, { deleted: true }));
    res.json({ success: true });
  }));
  app.post('/api/tennis/clips/:clipId/retry', requireCreator(async (req, res, user, c) => {
    const a = await clipWithAccess(c, user, req.params.clipId);
    if (!a.clip) return res.status(404).json({ success: false });
    if (!a.manage) return res.status(403).json({ success: false });
    await c.clips.updateOne({ clipId: a.clip.clipId }, { $set: { retryCount: 0, lastRetryAt: 0, status: a.clip.status === 'FAILED_PERMANENT' ? 'RETRY_PENDING' : a.clip.status } });
    await audit(c, { action: 'clip.retry', tournamentId: a.m.tournamentId, matchId: a.m.matchId, by: byOf(user), details: { clipId: a.clip.clipId } });
    if (a.clip.filePath && fs.existsSync(a.clip.filePath)) setImmediate(() => finishClip(c, a.clip.clipId).catch((e) => log('clip retry error', e.message || e)));
    else setImmediate(() => clipSweep().catch(() => {}));
    res.json({ success: true });
  }));
  app.get('/api/tennis/clips/status/:clipId', openRoute(async (req, res, user, c) => {
    const clip = await c.clips.findOne({ clipId: safeId(req.params.clipId) });
    if (!clip) return res.status(404).json({ success: false, error: 'No clip job with that clipId' });
    if (clip.deleted) return res.json({ success: true, clipId: clip.clipId, status: 'DELETED', deleted: true, r2Status: 'uploaded', driveStatus: 'uploaded' });
    const leg = (s) => (s === 'not_configured' ? 'uploaded' : s);
    res.json({ success: true, clipId: clip.clipId, status: clip.status === 'SERVER_ONLY' ? 'COMPLETE' : clip.status, r2Status: leg(clip.r2Status), driveStatus: leg(clip.driveStatus), r2Url: clip.r2Url || null, driveUrl: clip.driveUrl || null, retryCount: clip.retryCount || 0 });
  }));
  app.get('/api/tennis/clips/:clipId/video', openRoute(async (req, res, user, c) => {
    const a = await clipWithAccess(c, user, req.params.clipId, req.query.key);
    if (!a.clip || a.clip.deleted) return res.status(404).end();
    if (a.clip.r2Url && a.clip.r2Status === 'uploaded') return res.redirect(302, a.clip.r2Url);
    if (a.clip.filePath && fs.existsSync(a.clip.filePath)) {
      res.set('Content-Type', 'video/mp4');
      if (req.query.download) res.set('Content-Disposition', `attachment; filename="${a.clip.clipId}.mp4"`);
      return res.sendFile(path.resolve(a.clip.filePath), { acceptRanges: true });
    }
    if (a.clip.driveUrl) return res.redirect(302, a.clip.driveUrl);
    res.status(404).json({ success: false, error: 'This clip is not available yet' });
  }));

  /* ---------- the clipping session: which device clips this match ---------- */
  const CLIPPER_LIVE_MS = 45000;
  const CLIPPER_STATES = ['STARTING', 'READY', 'PROCESSING', 'WARNING', 'STOPPED'];
  const int0 = (v) => Math.max(0, Math.min(100000, Math.round(num(v, 0))));
  function cleanClipperStatus(s) {
    s = s && typeof s === 'object' ? s : {};
    const r = s.recording && typeof s.recording === 'object' ? s.recording : {};
    const k = s.counts && typeof s.counts === 'object' ? s.counts : {};
    return {
      state: CLIPPER_STATES.includes(s.state) ? s.state : 'STARTING', text: str(s.text, 160),
      recording: { file: str(String(r.file || '').split(/[\\/]/).pop(), 120) || null, seconds: r.seconds == null ? null : int0(r.seconds), growing: !!r.growing },
      counts: { processing: int0(k.processing), failed: int0(k.failed), upload: int0(k.upload), offline: int0(k.offline), done: int0(k.done) },
      online: typeof s.online === 'boolean' ? s.online : null, window: s.window && typeof s.window === 'object' ? { pre: num(s.window.pre, null), post: num(s.window.post, null) } : null
    };
  }
  function publicClipper(k, now) {
    if (!k) return null;
    now = now || Date.now();
    return { sessionId: k.sessionId, label: k.label || 'Clipper', startedAt: k.startedAt || null, lastSeenAt: k.lastSeenAt || null, stoppedAt: k.stoppedAt || null,
      live: !k.stoppedAt && now - (k.lastSeenAt || 0) < CLIPPER_LIVE_MS, status: k.status || null, takenFrom: k.takenFrom || null };
  }
  function emitClipper(m) { nsp.to(room(m.matchId)).emit('tn:clipper', { matchId: m.matchId, clipper: publicClipper(m.clipper) }); }
  app.get('/api/tennis/matches/:mid/clipper', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'Match not found' });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false });
    res.json({ success: true, clipper: publicClipper(m.clipper), clip: cleanClipWindow(m.clip) });
  }));
  app.post('/api/tennis/matches/:mid/clipper', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'Match not found' });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false });
    const b = req.body || {};
    const sid = safeId(b.sessionId).slice(0, 64);
    if (!sid) return res.status(400).json({ success: false, error: 'sessionId required' });
    const now = Date.now(), cur = m.clipper || null;
    const live = !!cur && !cur.stoppedAt && now - (cur.lastSeenAt || 0) < CLIPPER_LIVE_MS;
    const mine = !!cur && cur.sessionId === sid;
    if (b.action === 'start') {
      if (live && !mine && !b.force) return res.status(409).json({ success: false, code: 'CLIPPER_ELSEWHERE', error: `${cur.label || 'Another device'} is clipping this match`, clipper: publicClipper(cur, now) });
      const next = { sessionId: sid, label: str(b.label, 60) || 'Clipper', deviceId: str(b.deviceId, 64) || null, startedAt: mine && !cur.stoppedAt ? cur.startedAt : now, lastSeenAt: now, stoppedAt: null, status: cleanClipperStatus(b.status), takenFrom: live && !mine ? cur.label || 'another device' : null };
      await c.matches.updateOne({ matchId: m.matchId }, { $set: { clipper: next } });
      if (!mine || (cur && cur.stoppedAt)) await audit(c, { action: 'clipper.start', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { label: next.label, takenFrom: next.takenFrom } });
      m.clipper = next; emitClipper(m);
      return res.json({ success: true, clipper: publicClipper(next, now), clip: cleanClipWindow(m.clip) });
    }
    if (b.action === 'beat') {
      if (!mine || cur.stoppedAt) return res.status(409).json({ success: false, code: 'CLIPPER_LOST', error: cur && !cur.stoppedAt ? `${cur.label || 'Another device'} is clipping this match now` : 'Clipping was stopped', clipper: publicClipper(cur, now) });
      const status = cleanClipperStatus(b.status);
      await c.matches.updateOne({ matchId: m.matchId, 'clipper.sessionId': sid }, { $set: { 'clipper.lastSeenAt': now, 'clipper.status': status } });
      m.clipper = Object.assign({}, cur, { lastSeenAt: now, status });
      emitClipper(m);
      return res.json({ success: true, clipper: publicClipper(m.clipper, now) });
    }
    if (b.action === 'stop') {
      if (!mine) return res.json({ success: true, clipper: publicClipper(cur, now) });
      const status = Object.assign(cleanClipperStatus(b.status), { state: 'STOPPED' });
      await c.matches.updateOne({ matchId: m.matchId, 'clipper.sessionId': sid }, { $set: { 'clipper.stoppedAt': now, 'clipper.lastSeenAt': now, 'clipper.status': status } });
      await audit(c, { action: 'clipper.stop', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { label: cur.label } });
      m.clipper = Object.assign({}, cur, { stoppedAt: now, lastSeenAt: now, status });
      emitClipper(m);
      return res.json({ success: true, clipper: publicClipper(m.clipper, now) });
    }
    res.status(400).json({ success: false, error: 'Unknown action' });
  }));

  // 🎬 THE INGEST — the Tennis Clipper sends the finished clip. Checked
  // against the match's own clip token, stored on disk BEFORE the answer,
  // uploaded afterwards.
  app.post('/api/tennis/clips/ingest', express.raw({ type: '*/*', limit: '80mb' }), async (req, res) => {
    const c = await col();
    if (!c) return dbDown(res);
    const matchId = safeId(req.query.matchId), clipId = safeId(req.query.clipId);
    if (!matchId || !clipId || !clipId.startsWith(matchId + '_')) return res.status(400).json({ success: false, error: 'matchId and a clipId of that match are required' });
    if (!req.body || !req.body.length) return res.status(400).json({ success: false, error: 'Empty clip body' });
    let meta = {};
    try { meta = JSON.parse(req.headers['x-point-meta'] || '{}') || {}; } catch (e) { meta = {}; }
    const m = await loadMatch(c, matchId);
    if (!m) return res.status(404).json({ success: false, error: 'No such tennis match' });
    if (!sameSecret(meta.tnClipToken, m.clipToken)) return res.status(403).json({ success: false, error: 'This clip does not carry the match’s clip token' });
    const existing = await c.clips.findOne({ clipId });
    if (existing && existing.deleted) return res.json({ success: true, clipId, status: 'DELETED', deleted: true });
    const dir = path.join(CLIPS_DIR, 'tennis', matchId);
    const file = path.join(dir, `${clipId}.mp4`);
    try { await fs.promises.mkdir(dir, { recursive: true }); await fs.promises.writeFile(file, req.body); }
    catch (e) { return res.status(500).json({ success: false, clipId, error: 'Could not store the clip: ' + (e.message || e) }); }
    const eventId = idOk(meta.eventId) ? meta.eventId : (existing && existing.eventId) || null;
    // a point's clip follows its point (its kind, its players come from the ledger); only a clip
    // pressed by hand keeps its own kind and the player chosen for it — a player of this match
    const squad = new Map([].concat((m.sides.A ? m.sides.A.players.map((p) => [p.playerId, 'A']) : []), (m.sides.B ? m.sides.B.players.map((p) => [p.playerId, 'B']) : [])));
    const handKind = !eventId && Stats.CLIP_KINDS[meta.kind] ? meta.kind : null;
    const handPlayer = !eventId && idOk(meta.playerId) && squad.has(meta.playerId) ? meta.playerId : null;
    const durationSec = await probeDuration(file);
    const reqPre = num(meta.preRollSec, CLIP_PRE_ROLL_SEC);
    const actualPre = meta.actualPreRollSec != null ? num(meta.actualPreRollSec, null) : null;
    const recName = str(String(meta.sourceRecording || '').split(/[\\/]/).pop(), 120) || null;
    await c.clips.updateOne({ clipId }, {
      $set: {
        filePath: file, status: 'LOCAL_RECEIVED', lastReceivedAt: Date.now(), retryCount: 0, bytes: req.body.length, durationSec,
        actualPreRollSec: actualPre, partialPreRoll: actualPre != null ? actualPre < reqPre - 0.5 : !!meta.partialPreRoll,
        source: recName || meta.sourceStartSec != null ? { recording: recName, startSec: num(meta.sourceStartSec, null), endSec: num(meta.sourceEndSec, null) } : null,
        engine: meta.engine === 'tennis-clipper' ? 'tennis-clipper' : (existing && existing.engine) || 'tennis-clipper', cutOffline: !!meta.cutOffline,
        r2Status: existing && existing.r2Status === 'uploaded' ? 'uploaded' : 'pending', driveStatus: existing && existing.driveStatus === 'uploaded' ? 'uploaded' : 'pending'
      },
      $unset: { error: '' },
      $setOnInsert: {
        clipId, matchId, tournamentId: m.tournamentId, eventId, createdAt: Date.now(), kind: handKind,
        eventTimestamp: num(req.query.timestamp, num(meta.t0, null)), preRollSec: reqPre, postRollSec: num(meta.postRollSec, CLIP_POST_ROLL_SEC),
        set: num(meta.set, null), game: num(meta.game, null), pointNo: num(meta.pointNo, null),
        playerId: handPlayer, side: handPlayer ? squad.get(handPlayer) : null, sourceSessionId: str(meta.sourceSessionId, 80) || null
      }
    }, { upsert: true });
    res.json({ success: true, clipId, status: 'LOCAL_RECEIVED', durationSec });
    finishClip(c, clipId).catch((e) => log('clip finish error', clipId, e.message || e));
  });
  function probeDuration(file) {
    return new Promise((resolve) => {
      if (!deps.ffmpegPath) return resolve(null);
      let err = '', p;
      try { p = spawn(deps.ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { return resolve(null); }
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 8000);
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', () => { clearTimeout(timer); resolve(null); });
      p.on('close', () => { clearTimeout(timer); const mm = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err); resolve(mm ? Math.round((+mm[1] * 3600 + +mm[2] * 60 + +mm[3]) * 100) / 100 : null); });
    });
  }
  async function clipKey(c, clip) {
    let set = clip.set || 0, game = clip.game || 0, pointNo = clip.pointNo || 0;
    const m = await loadMatch(c, clip.matchId);
    if (m && clip.eventId) {
      const L = await getLedger(c, m);
      const e = L.entry(clip.eventId);
      if (e && e.before) { set = e.before.set || set; game = e.before.game || game; pointNo = e.pointNo || pointNo; }
    }
    return `tennis/${clip.tournamentId}/${clip.matchId}/set-${set}/game-${game}/point-${pointNo}-${clip.clipId}.mp4`;
  }
  async function uploadClipR2(c, clip) {
    const r2 = deps.r2 && deps.r2();
    if (!r2 || !r2.client || !r2.bucket) { await c.clips.updateOne({ clipId: clip.clipId }, { $set: { r2Status: 'not_configured' } }); return 'not_configured'; }
    if (clip.r2Status === 'uploaded') return 'uploaded';
    const key = clip.r2Key || await clipKey(c, clip);
    try {
      const body = await fs.promises.readFile(clip.filePath);
      await r2.client.send(new r2.PutObjectCommand({ Bucket: r2.bucket, Key: key, Body: body, ContentLength: body.length, ContentType: 'video/mp4', CacheControl: 'public, max-age=31536000, immutable' }));
    } catch (e) {
      await c.clips.updateOne({ clipId: clip.clipId }, { $set: { r2Status: 'failed', r2Key: key, r2Error: String(e.message || e).slice(0, 300) } });
      return 'failed';
    }
    await c.clips.updateOne({ clipId: clip.clipId }, { $set: { r2Status: 'uploaded', r2Key: key, r2Url: r2.publicUrl ? `${r2.publicUrl}/${key}` : null, r2UploadedAt: Date.now() }, $unset: { r2Error: '' } });
    return 'uploaded';
  }
  async function uploadClipDrive(c, clip) {
    const drive = deps.drive && deps.drive();
    const t = await c.tournaments.findOne({ tournamentId: clip.tournamentId });
    if (!drive || !t || !t.driveFolderId) { await c.clips.updateOne({ clipId: clip.clipId }, { $set: { driveStatus: 'not_configured' } }); return 'not_configured'; }
    if (clip.driveStatus === 'uploaded') return 'uploaded';
    try {
      const name = `${clip.clipId}.mp4`;
      if (clip.driveStatus === 'failed') {
        const found = await drive.files.list({ q: `name = '${name}' and '${t.driveFolderId}' in parents and trashed = false`, fields: 'files(id, webViewLink)', pageSize: 1 });
        const f = found.data && found.data.files && found.data.files[0];
        if (f) { await c.clips.updateOne({ clipId: clip.clipId }, { $set: { driveStatus: 'uploaded', driveFileId: f.id, driveUrl: f.webViewLink } }); return 'uploaded'; }
      }
      const r = await drive.files.create({ requestBody: { name, parents: [t.driveFolderId] }, media: { mimeType: 'video/mp4', body: fs.createReadStream(clip.filePath) }, fields: 'id, webViewLink' });
      await c.clips.updateOne({ clipId: clip.clipId }, { $set: { driveStatus: 'uploaded', driveFileId: r.data.id, driveUrl: r.data.webViewLink }, $unset: { driveError: '' } });
      return 'uploaded';
    } catch (e) {
      await c.clips.updateOne({ clipId: clip.clipId }, { $set: { driveStatus: 'failed', driveError: String(e.message || e).slice(0, 300) } });
      return 'failed';
    }
  }
  async function finishClip(c, clipId) {
    let clip = await c.clips.findOne({ clipId });
    if (!clip || !clip.filePath || !fs.existsSync(clip.filePath)) return;
    if (!clip.optimizedAt && deps.clipMedia) {
      const poster = `${clip.filePath}.poster.jpg`;
      const o = await deps.clipMedia.optimizeClipFile(clip.filePath, { ffmpegPath: deps.ffmpegPath, posterPath: poster, log: () => {} }).catch(() => ({}));
      await c.clips.updateOne({ clipId }, { $set: { optimizedAt: Date.now() } });
      if (o && o.posterPath) fs.unlink(o.posterPath, () => {});
    }
    clip = await c.clips.findOne({ clipId });
    const legs = await Promise.all([uploadClipR2(c, clip), uploadClipDrive(c, clip)]);
    let status;
    if (legs.every((x) => x === 'not_configured')) status = 'SERVER_ONLY';
    else if (legs.some((x) => x === 'failed')) status = 'RETRY_PENDING';
    else status = 'COMPLETE';
    await c.clips.updateOne({ clipId }, { $set: { status } });
    if (status === 'COMPLETE' && legs.includes('uploaded')) { fs.unlink(clip.filePath, () => {}); await c.clips.updateOne({ clipId }, { $set: { filePath: null } }); }
    emitClip(clip.matchId, await c.clips.findOne({ clipId }));
  }
  async function clipSweep() {
    const c = C;
    if (!c) return;
    const due = await c.clips.find({ status: { $in: ['RETRY_PENDING', 'LOCAL_RECEIVED'] }, retryCount: { $lt: CLIP_MAX_RETRIES } }).limit(20).toArray();
    for (const clip of due) {
      const last = Math.max(clip.lastRetryAt || 0, clip.lastReceivedAt || 0);
      if (Date.now() < last + Math.min(10000 * Math.pow(1.6, clip.retryCount || 0), 15 * 60000)) continue;
      if (!clip.filePath || !fs.existsSync(clip.filePath)) { await c.clips.updateOne({ clipId: clip.clipId }, { $set: { status: 'NEEDS_REUPLOAD', error: 'The website’s copy is gone — the Tennis Clipper will send it again' } }); continue; }
      await c.clips.updateOne({ clipId: clip.clipId }, { $set: { lastRetryAt: Date.now() }, $inc: { retryCount: 1 } });
      await finishClip(c, clip.clipId);
      const after = await c.clips.findOne({ clipId: clip.clipId });
      if (after.status === 'RETRY_PENDING' && (after.retryCount || 0) >= CLIP_MAX_RETRIES) await c.clips.updateOne({ clipId: clip.clipId }, { $set: { status: 'FAILED_PERMANENT', error: `Upload failed ${after.retryCount} times — the file is kept` } });
    }
  }
  setInterval(() => { clipSweep().catch((e) => log('clip sweep error', e.message || e)); }, CLIP_RETRY_INTERVAL_MS).unref();

  /* ------------------------------------------------------------ meta / config */
  app.get('/api/tennis/config', (req, res) => {
    res.json({
      success: true, rules: E.normalizeRules({}), presets: E.PRESETS, finalSet: E.FINAL_SET, kinds: E.KINDS, strokes: E.STROKES, serveDirs: E.SERVE_DIRS,
      interruptions: E.INTERRUPTIONS, manualStats: E.MANUAL_STATS, categories: CATEGORIES, surfaces: SURFACES, drawTypes: DRAW_TYPES,
      scenes: G.SCENES, lowers: G.LOWERS, moments: G.MOMENTS, clipKinds: Stats.CLIP_KINDS,
      clip: { preRollSec: CLIP_PRE_ROLL_SEC, postRollSec: CLIP_POST_ROLL_SEC }, leaseTtlMs: LEASE_TTL_MS
    });
  });
  app.get('/api/tennis/time', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ now: Date.now() }); });

  /* ------------------------------------------------------------ pages */
  const page = (file) => (req, res) => deps.sendHtmlNoCache(res, path.join(deps.rootDir, file));
  app.get('/tennis', page('tennis.html'));
  app.get('/tennis-templates', page('tennis-templates.html'));
  app.get('/tennis-panel', page('tennis-panel.html'));
  app.get('/tennis-remote', page('tennis-remote.html'));
  app.get('/tennis-overlay', page('tennis-overlay.html'));
  app.get('/tennis-clipper', page('tennis-clipper.html'));
  app.get('/tennis/tournament/:tid', page('tennis-tournament.html'));
  app.get('/tennis/match/:mid', page('tennis-scorecard.html'));
  app.get('/tennis/player/:pid', page('tennis-player.html'));

  /* ------------------------------------------------------------ sockets */
  const nsp = io.of('/tennis');
  const room = (matchId) => 'm:' + matchId;
  const troom = (tournamentId) => 't:' + tournamentId;
  function emitClip(matchId, doc) {
    if (!doc) return;
    // (the moment, kind, player and window too — what the public clip list shows — so the device
    // clipping on the vMix PC can cut a clip another device asked for: the phone remote's "clip that")
    nsp.to(room(matchId)).emit('tn:clip', { matchId, clip: { clipId: doc.clipId, eventId: doc.eventId || null, status: doc.status, displayStatus: displayStatus(doc), local: doc.local || null, durationSec: doc.durationSec || null, partialPreRoll: !!doc.partialPreRoll, deleted: !!doc.deleted, kind: doc.kind || null,
      t0: doc.eventTimestamp || null, playerId: doc.playerId || null, side: doc.side || null, set: doc.set || null, game: doc.game || null, pointNo: doc.pointNo || null, preRollSec: doc.preRollSec || null, postRollSec: doc.postRollSec || null } });
  }
  function broadcastMatchDoc(m) {
    if (!m) return;
    nsp.to(room(m.matchId)).emit('tn:match', { matchId: m.matchId, match: publicMatch(m, false) });
  }

  /* ---------- on-air graphics (see tennis-graphics.js) ---------- */
  let airSeq = Date.now();
  const nextAirSeq = () => ++airSeq;
  const airTimers = new Map();
  const airChains = new Map();
  function airSerial(matchId, fn) {
    const run = (airChains.get(matchId) || Promise.resolve()).then(fn, fn);
    const tail = run.then(() => {}, () => {});
    airChains.set(matchId, tail);
    tail.then(() => { if (airChains.get(matchId) === tail) airChains.delete(matchId); });
    return run;
  }
  function airOf(m) {
    const g = m && m.graphic;
    if (!g || typeof g !== 'object' || typeof g.seq !== 'number') return G.idle();
    if (g.seq > airSeq) airSeq = g.seq;
    return g;
  }
  async function setAir(c, m, next) {
    await c.matches.updateOne({ matchId: m.matchId }, { $set: { graphic: next } });
    m.graphic = next;
    armAir(c, m.matchId, next);
    nsp.to(room(m.matchId)).emit('tn:graphic', { matchId: m.matchId, graphic: G.publicState(next, Date.now()) });
    return next;
  }
  function armAir(c, matchId, g) {
    clearTimeout(airTimers.get(matchId));
    airTimers.delete(matchId);
    const at = G.nextExpiry(g);
    if (at == null) return;
    const timer = setTimeout(() => {
      airTimers.delete(matchId);
      airSerial(matchId, async () => {
        const m = await loadMatch(c, matchId);
        const cur = airOf(m);
        if (!m || cur.seq !== g.seq) return;
        const ended = G.settle(cur, Date.now(), nextAirSeq);
        if (ended) await setAir(c, m, ended); else armAir(c, matchId, cur);
      }).catch((e) => log('graphic timer error', e.message || e));
    }, Math.max(0, at - Date.now()) + 15);
    if (timer.unref) timer.unref();
    airTimers.set(matchId, timer);
  }
  async function currentAir(c, m) {
    const cur = airOf(m);
    const at = G.nextExpiry(cur);
    if (at == null) return cur;
    if (Date.now() < at) { if (!airTimers.has(m.matchId)) armAir(c, m.matchId, cur); return cur; }
    return airSerial(m.matchId, async () => {
      const fresh = await loadMatch(c, m.matchId);
      const now = airOf(fresh);
      const ended = G.settle(now, Date.now(), nextAirSeq);
      return ended ? setAir(c, fresh, ended) : now;
    });
  }
  // what a graphic needs from the match, checked before it goes on air
  async function sceneContext(c, m, t) {
    const L = await getLedger(c, m);
    return { m, t, L, st: L.state, s: E.summary(L.setup, L.state) };
  }
  function sceneCheck(scene, data, ctx) {
    const { m, st, s } = ctx;
    const both = !!(m.sides.A && m.sides.B);
    const all = [].concat(m.sides.A ? m.sides.A.players : [], m.sides.B ? m.sides.B.players : []);
    const lowerKind = scene.indexOf('lower:') === 0 ? scene.slice(6) : null;
    if (lowerKind) {
      if (['player', 'profile', 'serve', 'stat'].includes(lowerKind) && !all.some((p) => p.playerId === data.playerId)) return { error: 'Choose a player of this match' };
      if (lowerKind === 'announce' && !data.text && !data.title) return { error: 'Write the announcement first' };
      if (lowerKind === 'ticker' && !data.text) return { error: 'Write the ticker text first' };
      return { data };
    }
    switch (scene) {
      case 'intro': case 'compare': case 'start': case 'tournament': case 'upcoming':
        if (!both && scene !== 'tournament' && scene !== 'upcoming') return { error: 'Both sides must be known first' };
        if (scene === 'compare' && m.format === 'doubles') return { error: 'The player comparison is for singles — use the doubles teams graphic' };
        return { data };
      case 'teams':
        if (m.format !== 'doubles') return { error: 'The doubles teams graphic is for doubles' };
        if (!both) return { error: 'Both teams must be known first' };
        return { data };
      case 'player': case 'playerStats':
        if (!all.some((p) => p.playerId === data.playerId)) return { error: 'Choose a player of this match' };
        if (scene === 'playerStats' && !(st.pointNo > 0)) return { error: 'No points have been played yet' };
        return { data };
      case 'toss':
        if (!st.toss) return { error: 'No toss recorded yet — record the toss in the panel first' };
        return { data };
      case 'server':
        if (!st.rotation && !st.toss) return { error: 'Record the toss or start the match first' };
        return { data };
      case 'setScore':
        if (!st.sets.length) return { error: 'The match has not started yet' };
        return { data };
      case 'setWinner': {
        const done = st.sets.filter((x) => x.winner);
        if (!done.length) return { error: 'No set has finished yet' };
        const set = data.set || done[done.length - 1].n;
        if (!done.some((x) => x.n === set)) return { error: `Set ${set} has not finished` };
        return { data: { set } };
      }
      case 'tiebreak':
        if (!s.tiebreak) return { error: 'No tie-break is being played' };
        return { data };
      case 'breakPoint': case 'matchPoint': {
        const h = s.headline;
        const want = scene === 'breakPoint' ? (x) => x && (x.break) : (x) => x && x.match;
        const side = data.side || (h && h.side !== 'both' ? h.side : null);
        const pr = s.pressure || {};
        const who = side ? (want(pr[side]) ? side : null) : (want(pr.A) ? 'A' : want(pr.B) ? 'B' : null);
        if (!who) return { error: scene === 'breakPoint' ? 'It is not a break point right now' : 'It is not a match point right now' };
        return { data: { side: who } };
      }
      case 'stats': case 'result':
        if (!(st.pointNo > 0) && !(st.result)) return { error: 'The match has not started yet' };
        if (scene === 'result' && st.status !== 'completed') return { error: 'The match is not over yet' };
        return { data };
      default: return { error: 'Unknown graphic' };
    }
  }
  // After a scoring event: its call-out (once — its id is the event's), an
  // undone point's call-out off air, and the automatic scenes the
  // tournament asked for. Never over what the operator put up.
  async function afterEventAir(c, matchId, ev, entry, touched, before, after) {
    return airSerial(matchId, async () => {
      const m = await loadMatch(c, matchId);
      if (!m) return;
      const t = await tournamentOf(c, m);
      const style = G.normalizeStyle(t && t.broadcast);
      let cur = airOf(m);
      const ended = G.settle(cur, Date.now(), nextAirSeq);
      if (ended) cur = await setAir(c, m, ended);
      if ((ev.type === 'UNDO' || ev.type === 'VOID' || ev.type === 'CORRECT') && ev.target && cur.moment && cur.moment.eventId === ev.target) {
        const r = G.applyCommand(cur, { action: 'moment-off', eventId: ev.target }, { style, nextSeq: nextAirSeq }, Date.now());
        if (r.ok && r.next) cur = await setAir(c, m, r.next);
      }
      if (E.META[ev.type] || !entry) return;
      const mo = G.momentFor(entry, before, after, style);
      if (mo) {
        const r = G.applyCommand(cur, Object.assign({ action: 'moment', eventId: ev.eventId, auto: true }, mo), { style, nextSeq: nextAirSeq }, Date.now());
        if (r.ok && r.next) cur = await setAir(c, m, r.next);
      }
      // an automatic scene the tournament asked for: a few seconds later (the
      // call-out first), only if that point still counts, never over the operator's
      const fx = entry.effects || [];
      let scene = null, data = {};
      if (style.autoScenes.result && fx.some((x) => x.type === 'MATCH_WON' && x.reason === 'played')) scene = 'result';
      else if (style.autoScenes.setWinner && fx.some((x) => x.type === 'SET_WON')) { scene = 'setWinner'; data = { set: fx.find((x) => x.type === 'SET_WON').set }; }
      if (!scene) return;
      const t2 = setTimeout(() => {
        airSerial(matchId, async () => {
          const m2 = await loadMatch(c, matchId);
          if (!m2) return;
          const L = await getLedger(c, m2);
          const e2 = L.entry(ev.eventId);
          if (!e2 || e2.voided || e2.invalid) return;           // undone in the meantime
          const r = G.applyCommand(airOf(m2), { action: 'take', scene, data, auto: true }, { style, nextSeq: nextAirSeq }, Date.now());
          if (r.ok && r.next) await setAir(c, m2, r.next);
        }).catch((e) => log('auto scene error', e.message || e));
      }, AUTO_SCENE_DELAY_MS);
      if (t2.unref) t2.unref();
    });
  }
  const AUTO_SCENE_DELAY_MS = 3500;
  async function graphicSweep() {
    const c = await col();
    if (!c) return;
    const ms = await c.matches.find({ $or: [{ 'graphic.expiresAt': { $gt: 0 } }, { 'graphic.lower.expiresAt': { $gt: 0 } }, { 'graphic.moment.expiresAt': { $gt: 0 } }] }).toArray();
    for (const m of ms) await currentAir(c, m).catch(() => {});
  }
  setTimeout(() => { graphicSweep().catch(() => {}); }, 3000).unref();
  setInterval(() => { graphicSweep().catch((e) => log('graphic sweep error', e.message || e)); }, 60 * 1000).unref();

  /* 📡 THE OUTPUTS — every overlay showing a match says what it shows. */
  const outputs = new Map(), outputEmits = new Map();
  const OUTPUT_STATES = ['IDLE', 'OVERLAY_ENTERING', 'OVERLAY_VISIBLE', 'OVERLAY_EXITING', 'GRAPHIC_ENTERING', 'GRAPHIC_VISIBLE', 'GRAPHIC_EXITING', 'OVERLAY_RETURNING'];
  function publicOutputs(matchId) {
    const m = outputs.get(matchId);
    if (!m) return [];
    const now = Date.now();
    return [...m.values()].filter((o) => now - o.at < 40000);
  }
  function emitOutputs(matchId) {
    if (outputEmits.has(matchId)) return;
    outputEmits.set(matchId, setTimeout(() => { outputEmits.delete(matchId); nsp.to(room(matchId)).emit('tn:outputs', { matchId, outputs: publicOutputs(matchId), now: Date.now() }); }, 60));
  }

  nsp.on('connection', (socket) => {
    socket.on('tn:output', (d) => {
      d = d && typeof d === 'object' ? d : {};
      const matchId = safeId(d.matchId);
      if (!matchId || !socket.rooms.has(room(matchId))) return;
      const idx = (v) => (v == null ? null : safeId(v).slice(0, 40) || null);
      const o = {
        outputId: idx(d.outputId) || socket.id.slice(0, 12), monitor: d.monitor === true,
        layoutParam: ['bug', 'bar', 'graphics'].includes(d.layoutParam) ? d.layoutParam : null,
        state: OUTPUT_STATES.includes(d.state) ? d.state : 'IDLE', graphicId: idx(d.graphicId), scene: G.SCENES[d.scene] ? d.scene : null,
        layout: d.layout === 'bug' || d.layout === 'bar' ? d.layout : null, lowerId: idx(d.lowerId), momentId: d.momentId ? str(d.momentId, 100) : null,
        failed: d.failed && typeof d.failed === 'object' ? { id: idx(d.failed.id), error: str(d.failed.error, 160) } : null,
        airSeq: num(d.airSeq, null), at: Date.now()
      };
      let m = outputs.get(matchId);
      if (!m) outputs.set(matchId, m = new Map());
      m.set(socket.id, o);
      (socket.data.outputs = socket.data.outputs || new Set()).add(matchId);
      emitOutputs(matchId);
    });
    socket.on('disconnect', () => {
      for (const mid of socket.data.outputs || []) {
        const m = outputs.get(mid);
        if (m && m.delete(socket.id)) { if (!m.size) outputs.delete(mid); emitOutputs(mid); }
      }
    });
    socket.data.user = null;
    const authed = (async () => {
      const tok = socket.handshake.auth && socket.handshake.auth.idToken;
      if (!tok) return null;
      const d = await auth.verifyIdTokenFull(tok);
      socket.data.user = d && d.uid ? userOf(d) : null;
      return socket.data.user;
    })().catch(() => null);
    const ack = (fn) => (typeof fn === 'function' ? fn : () => {});
    socket.on('tn:auth', async (d, fn) => {
      const reply = ack(fn);
      try { const dec = await auth.verifyIdTokenFull(d && d.idToken); socket.data.user = dec && dec.uid ? userOf(dec) : socket.data.user; reply({ ok: !!socket.data.user }); }
      catch (e) { reply({ ok: false }); }
    });
    socket.on('tn:join', async (d, fn) => {
      const reply = ack(fn);
      try {
        await authed;
        const c = await col();
        if (!c) return reply({ ok: false, error: 'db-unavailable' });
        const a = await matchAccess(c, socket.data.user, d && d.matchId, d && d.key);
        if (!a.m) return reply({ ok: false, error: 'not-found' });
        socket.join(room(a.m.matchId));
        if (a.t) socket.join(troom(a.t.tournamentId));
        const L = await getLedger(c, a.m);
        const graphic = G.publicState(await currentAir(c, a.m), Date.now());
        const tl = d && d.timeline ? publicTimeline(L, a.manage) : d && d.recent ? publicTimeline(L, a.manage).slice(-Math.max(1, Math.min(200, Number(d.recent) || 30))) : undefined;
        reply({ ok: true, match: Object.assign(publicMatch(a.m, a.manage), { graphic }), summary: E.summary(L.setup, L.state), seq: L.seq, timeline: tl,
          events: a.manage && d && d.events ? L.events.map(publicEv) : undefined, graphic, style: G.normalizeStyle(a.t && a.t.broadcast), tournament: publicTournament(a.t, socket.data.user), now: Date.now(),
          outputs: a.manage ? publicOutputs(a.m.matchId) : undefined });
      } catch (e) { log('join error', e.message || e); reply({ ok: false, error: 'join-failed' }); }
    });
    socket.on('tn:sync', async (d, fn) => {
      const reply = ack(fn);
      try {
        await authed;
        const c = await col();
        const a = await matchAccess(c, socket.data.user, d && d.matchId, d && d.key);
        if (!a.m) return reply({ ok: false, error: 'not-found' });
        const L = await getLedger(c, a.m);
        const graphic = G.publicState(await currentAir(c, a.m), Date.now());
        const tl = d && d.recent ? publicTimeline(L, a.manage).slice(-Math.max(1, Math.min(200, Number(d.recent) || 30))) : publicTimeline(L, a.manage);
        reply({ ok: true, match: Object.assign(publicMatch(a.m, a.manage), { graphic }), seq: L.seq, summary: E.summary(L.setup, L.state), timeline: tl,
          events: a.manage ? L.events.map(publicEv) : undefined, graphic, style: G.normalizeStyle(a.t && a.t.broadcast), now: Date.now() });
      } catch (e) { reply({ ok: false, error: 'sync-failed' }); }
    });
    socket.on('tn:event', async (d, fn) => {
      const reply = ack(fn);
      try {
        const user = await authed || socket.data.user;
        if (!user || !user.isCreator) return reply({ ok: false, code: 'LOGIN_REQUIRED', error: 'Sign in with an authorised account' });
        const c = await col();
        if (!c) return reply({ ok: false, code: 'DB', error: 'The database is not available', retry: true });
        reply(await submitEvent(c, user, d && d.matchId, d && d.event, d && d.leaseToken));
      } catch (e) { log('event error', e.stack || e); reply({ ok: false, code: 'SERVER', error: 'Not saved — try again', retry: true }); }
    });
    socket.on('tn:lease:heartbeat', async (d, fn) => {
      const reply = ack(fn);
      try {
        const c = await col();
        const m = c && await loadMatch(c, d && d.matchId);
        if (!m) return reply({ ok: false });
        if (!leaseOk(m, d && d.leaseToken)) return reply({ ok: false, lost: true, lease: publicLease(m.lease) });
        await beat(c, m);
        reply({ ok: true, lease: publicLease(m.lease) });
      } catch (e) { reply({ ok: false }); }
    });
    // take / stop / live / clean / duration / live-* / lower / lower-off / moment / moment-off
    socket.on('tn:graphic', async (d, fn) => {
      const reply = ack(fn);
      try {
        const user = await authed || socket.data.user;
        const c = await col();
        if (!c) return reply({ ok: false, error: 'db-unavailable' });
        d = d && typeof d === 'object' ? d : {};
        const m0 = await loadMatch(c, d.matchId);
        if (!m0) return reply({ ok: false, error: 'not-found' });
        const t = await tournamentOf(c, m0);
        if (!canManage(user, t)) return reply({ ok: false, error: 'not-authorised' });
        const cmd = Object.assign({}, d);
        delete cmd.auto;                          // only the server takes things on air "automatically"
        const r = await airSerial(m0.matchId, async () => {
          const m = await loadMatch(c, m0.matchId);
          let cur = airOf(m);
          const ended = G.settle(cur, Date.now(), nextAirSeq);
          if (ended) cur = await setAir(c, m, ended);
          const needs = (!cmd.action || cmd.action === 'take') && G.SCENES[cmd.scene] ? cmd.scene : cmd.action === 'lower' && G.LOWERS[cmd.kind] ? 'lower:' + cmd.kind : null;
          const ctx = needs ? await sceneContext(c, m, t) : null;
          const out = G.applyCommand(cur, cmd, { style: t && t.broadcast, nextSeq: nextAirSeq, check: ctx ? (sc, data) => sceneCheck(sc, data, ctx) : null }, Date.now());
          if (out.ok && out.next) cur = await setAir(c, m, out.next);
          return Object.assign({}, out, { graphic: G.publicState(cur, Date.now()) });
        });
        reply(r.ok ? { ok: true, same: !!r.same, graphic: r.graphic } : { ok: false, error: r.error, stale: !!r.stale, graphic: r.graphic });
      } catch (e) { log('graphic error', e.stack || e); reply({ ok: false, error: 'Could not change the graphic — try again' }); }
    });
  });

  return {
    col, submitEvent, getLedger, scheduleReport, generateReport, clipSweep, reportSweep, statsOf,
    _test: { sanitizeEvent, displayStatus, similarNames, LEASE_TTL_MS }
  };
};
