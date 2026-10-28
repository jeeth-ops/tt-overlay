/* ================================================================
   🏐 VOLLEYBALL — the server side of the volleyball module.

   A sport of its own, sharing only plumbing with cricket:
     - its own MongoDB collections (vbTournaments, vbTeams, vbPlayers,
       vbMatches, vbEvents, vbClips, vbReports, vbAudit) — a cricket
       query can never see a volleyball row, nor the other way round;
     - its own Socket.IO namespace (/volleyball), so not one volleyball
       update can reach a cricket room, overlay or panel;
     - its own clip ingest (/api/volleyball/clips/ingest) and storage
       prefix (volleyball/… on R2).
   Shared, unchanged: Firebase sign-in and the creator / owner email
   lists (passed in by server.js), the R2 / Drive clients, ffmpeg.

   THE SOURCE OF TRUTH is vbEvents: one document per event (toss, rally,
   time-out …), unique per (matchId, eventId) and per (matchId, seq). The
   score, sets, server, rotation, statistics, standings and the PDF are
   all derived from it by volleyball-engine.js — so a retried request
   never scores twice, a correction is just another event, and anything
   derived can always be rebuilt.

   WHO MAY DO WHAT
     - Write anything: a signed-in (verified Firebase ID token) authorised
       creator account that owns the tournament, or the owner account.
     - Score a live match: the above, on the ONE device holding the
       match's controller lease (claimed, kept alive by heartbeat, taken
       over only explicitly — the other device is told at once).
     - A locked match takes no scoring and no edits until unlocked.
     - Read: public tournaments — anyone; private ones — their creator
       and the owner (the overlay of a private match needs its key).
   ================================================================ */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const E = require('./volleyball-engine.js');
const Stats = require('./volleyball-stats.js');
const Standings = require('./volleyball-standings.js');
const Report = require('./volleyball-report.js');
const G = require('./volleyball-graphics.js');

const LEASE_TTL_MS = 30 * 1000;            // a controller silent this long can be replaced without "take over"
const LEDGER_CACHE_MAX = 300;
const CLIP_RETRY_INTERVAL_MS = 15 * 1000;
const CLIP_MAX_RETRIES = 12;
const REPORT_MAX_ATTEMPTS = 5;
const MAX_LOGO_BYTES = 600 * 1024;
const MAX_PHOTO_BYTES = 400 * 1024;        // a player's portrait for the starting six and the player card
const CLIP_PRE_ROLL_SEC = 7;               // what the panel asks the local clip engine for
const CLIP_POST_ROLL_SEC = 3;

function newId(prefix) { return prefix + crypto.randomBytes(8).toString('hex'); }
function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 120); }
function keyOf(name) { return str(name, 200).toLowerCase().replace(/\s+/g, ' '); }
function color(v, d) { return /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : (d || '#1f3a8a'); }
function idOk(v) { return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(v); }
function safeId(v) { return String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120); }
function sha(v) { return crypto.createHash('sha256').update(String(v || '')).digest('hex'); }
function sameSecret(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clean(doc) {
  if (!doc) return doc;
  const o = Object.assign({}, doc);
  delete o._id;
  return o;
}

module.exports = function setupVolleyball(deps) {
  const { app, io, express } = deps;
  const auth = deps.auth;
  const log = deps.log || ((...a) => console.log('[volleyball]', ...a));
  const CLIPS_DIR = deps.clipsDir;
  let C = null;            // collections, once the database is there
  let ready = null;

  /* ------------------------------------------------------------ database */
  async function init() {
    const db = deps.getDb();
    if (!db) return null;
    const c = {
      tournaments: db.collection('vbTournaments'),
      teams: db.collection('vbTeams'),
      players: db.collection('vbPlayers'),
      matches: db.collection('vbMatches'),
      events: db.collection('vbEvents'),
      clips: db.collection('vbClips'),
      reports: db.collection('vbReports'),
      audit: db.collection('vbAudit')
    };
    await c.tournaments.createIndex({ tournamentId: 1 }, { unique: true });
    await c.tournaments.createIndex({ ownerUid: 1, updatedAt: -1 });
    await c.teams.createIndex({ teamId: 1 }, { unique: true });
    await c.teams.createIndex({ ownerUid: 1, nameKey: 1 });
    await c.players.createIndex({ playerId: 1 }, { unique: true });
    await c.players.createIndex({ ownerUid: 1, nameKey: 1 });
    await c.matches.createIndex({ matchId: 1 }, { unique: true });
    await c.matches.createIndex({ tournamentId: 1, scheduledAt: 1 });
    // a generated fixture exists once per tournament, however often "generate"
    // is pressed — and only a generated one has a key: a partial index (the
    // first version's compound SPARSE index still indexed a hand-made match's
    // missing key as null, so a tournament could hold only one of those)
    try { await c.matches.dropIndex('tournamentId_1_fixtureKey_1'); } catch (e) { /* not there (a new database, or already replaced) */ }
    await c.matches.createIndex({ tournamentId: 1, fixtureKey: 1 }, { name: 'tournament_fixture_once', unique: true, partialFilterExpression: { fixtureKey: { $type: 'string' } } });
    await c.matches.createIndex({ 'teamA.teamId': 1, completedAt: -1 });
    await c.matches.createIndex({ 'teamB.teamId': 1, completedAt: -1 });
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
  function dbDown(res) { return res.status(503).json({ success: false, retry: true, error: 'The volleyball database is not available right now' }); }

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
      if (!user.isCreator) return res.status(403).json({ success: false, code: 'NOT_AUTHORISED', error: 'Your account is not authorised to manage volleyball tournaments' });
      req.vbUser = user;
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
  function canView(user, t) { return !!t && !t.archived && (visibilityOf(t) === 'public' || canManage(user, t)) || (!!t && t.archived && canManage(user, t)); }

  async function audit(c, entry) {
    try { await c.audit.insertOne(Object.assign({ at: Date.now() }, entry)); }
    catch (e) { log('audit write error', e.message || e); }
  }
  const byOf = (user, extra) => Object.assign({ uid: user ? user.uid : null, email: user ? user.email : null }, extra || {});

  /* ------------------------------------------------------------ teams + players */
  function cleanLogo(input, maxBytes) {
    if (input == null || input === '') return null;
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(input));
    if (!m) return undefined;              // undefined = "invalid", null = "none"
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length || bytes.length > (maxBytes || MAX_LOGO_BYTES)) return undefined;
    return { type: m[1], data: m[2], bytes: bytes.length };
  }
  const photoUrl = (p) => (p && p.photoV ? `/api/volleyball/players/${p.playerId}/photo?v=${p.photoV}` : null);
  function publicTeam(t, opts) {
    if (!t) return null;
    return {
      teamId: t.teamId, name: t.name, shortName: t.shortName || '', colors: t.colors || {}, city: t.city || '',
      logo: t.logo ? `/api/volleyball/teams/${t.teamId}/logo?v=${t.logoV || 1}` : null,
      players: (t.players || []).filter((p) => p.active !== false || (opts && opts.all)).map((p) => ({
        playerId: p.playerId, name: p.name, number: p.number, role: p.role || '', libero: !!p.libero, captain: !!p.captain, active: p.active !== false, photo: photoUrl(p)
      })),
      updatedAt: t.updatedAt || 0
    };
  }
  // The portraits of a match's two squads, from the teams' current rosters
  // (a photo added during a match shows at once) — { playerId: url }.
  async function photosOf(c, m) {
    const ids = [m && m.teamA && m.teamA.teamId, m && m.teamB && m.teamB.teamId].filter(Boolean);
    if (!ids.length) return {};
    const teams = await c.teams.find({ teamId: { $in: ids } }).toArray();
    const out = {};
    teams.forEach((t) => (t.players || []).forEach((p) => { const u = photoUrl(p); if (u) out[p.playerId] = u; }));
    return out;
  }
  function teamSnapshot(t) {
    return { teamId: t.teamId, name: t.name, shortName: t.shortName || abbr(t.name), colors: Object.assign({}, t.colors || {}), logoV: t.logo ? (t.logoV || 1) : 0 };
  }
  function abbr(name) {
    const w = String(name || '').trim().split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w.map((x) => x[0]).join('') : String(name || '')).slice(0, 3).toUpperCase() || 'TBD';
  }
  function squadOf(t) {
    return (t.players || []).filter((p) => p.active !== false).map((p) => ({
      playerId: p.playerId, number: p.number, name: p.name, role: p.role || '', libero: !!p.libero, captain: !!p.captain
    }));
  }
  // Roster entries: an existing playerId keeps its identity (renames
  // follow it everywhere); a new name becomes a new player.
  async function resolveRoster(c, user, input, prevPlayers) {
    const prev = new Map((prevPlayers || []).map((p) => [p.playerId, p]));
    const out = [], seenIds = new Set(), errors = [];
    for (const raw of (Array.isArray(input) ? input : []).slice(0, 40)) {
      if (!raw || typeof raw !== 'object') continue;
      const name = str(raw.name, 60);
      if (!name) continue;
      let playerId = idOk(raw.playerId) ? raw.playerId : null;
      if (playerId && !prev.has(playerId)) {
        // an existing player from another of my teams?
        const known = await c.players.findOne({ playerId });
        if (!known || (known.ownerUid !== user.uid && !user.isOwner)) playerId = null;
      }
      if (!playerId) {
        playerId = newId('vbp');
        await c.players.insertOne({ playerId, ownerUid: user.uid, name, nameKey: keyOf(name), createdAt: Date.now(), updatedAt: Date.now() });
      } else {
        await c.players.updateOne({ playerId }, { $set: { name, nameKey: keyOf(name), updatedAt: Date.now() } });
      }
      if (seenIds.has(playerId)) continue;
      seenIds.add(playerId);
      const number = str(raw.number, 3).replace(/[^0-9]/g, '');
      out.push({ playerId, name, number, role: E.ROLES[raw.role] ? raw.role : (raw.libero ? 'L' : ''), libero: !!raw.libero, captain: !!raw.captain, active: raw.active !== false });
    }
    // a portrait belongs to the player (vbPlayers), whichever team they are in
    if (out.length) {
      const docs = await c.players.find({ playerId: { $in: out.map((p) => p.playerId) } }).toArray();
      const pv = new Map(docs.filter((d) => d.photoV).map((d) => [d.playerId, d.photoV]));
      out.forEach((p) => { if (pv.has(p.playerId)) p.photoV = pv.get(p.playerId); });
    }
    const numbers = new Map();
    out.filter((p) => p.active && p.number !== '').forEach((p) => {
      if (numbers.has(p.number)) errors.push(`Jersey #${p.number} is used by both ${numbers.get(p.number)} and ${p.name}`);
      numbers.set(p.number, p.name);
    });
    if (out.filter((p) => p.captain).length > 1) errors.push('Only one captain per team');
    return { players: out, errors };
  }

  app.get('/api/volleyball/teams/:teamId/logo', openRoute(async (req, res, user, c) => {
    const t = await c.teams.findOne({ teamId: String(req.params.teamId) });
    if (!t || !t.logo || !t.logo.data) return res.status(404).end();
    res.set('Content-Type', t.logo.type);
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.send(Buffer.from(t.logo.data, 'base64'));
  }));

  // A player's portrait — only ever one the team's manager uploaded; a
  // player without one gets a designed card with their number, never a
  // stand-in picture.
  app.get('/api/volleyball/players/:playerId/photo', openRoute(async (req, res, user, c) => {
    const p = await c.players.findOne({ playerId: String(req.params.playerId) });
    if (!p || !p.photo || !p.photo.data) return res.status(404).end();
    res.set('Content-Type', p.photo.type);
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.send(Buffer.from(p.photo.data, 'base64'));
  }));
  app.put('/api/volleyball/teams/:teamId/players/:playerId/photo', requireCreator(async (req, res, user, c) => {
    const t = await c.teams.findOne({ teamId: String(req.params.teamId) });
    if (!t) return res.status(404).json({ success: false, error: 'No such team' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your team' });
    const pid = String(req.params.playerId);
    if (!(t.players || []).some((p) => p.playerId === pid)) return res.status(404).json({ success: false, error: 'That player is not in this team' });
    const photo = cleanLogo(req.body && req.body.photo, MAX_PHOTO_BYTES);
    if (photo === undefined) return res.status(400).json({ success: false, error: 'The photo must be a PNG, JPEG or WebP under 400 KB' });
    const doc = await c.players.findOne({ playerId: pid });
    if (!doc) return res.status(404).json({ success: false, error: 'No such player' });
    const photoV = photo ? (doc.photoV || 0) + 1 : 0;
    await c.players.updateOne({ playerId: pid }, { $set: { photo, photoV, updatedAt: Date.now() } });
    // every roster the player is in shows the new portrait
    const teams = await c.teams.find({ 'players.playerId': pid }).toArray();
    for (const tm of teams) {
      const players = (tm.players || []).map((p) => (p.playerId === pid ? Object.assign({}, p, { photoV }) : p));
      await c.teams.updateOne({ teamId: tm.teamId }, { $set: { players, updatedAt: Date.now() } });
      await announceTeamMatches(c, tm.teamId);
    }
    await audit(c, { action: photo ? 'player.photo' : 'player.photo.remove', teamId: t.teamId, by: byOf(user), details: { playerId: pid, bytes: photo ? photo.bytes : 0 } });
    res.json({ success: true, photo: photo ? `/api/volleyball/players/${pid}/photo?v=${photoV}` : null });
  }));
  // the overlays of a team's coming and running matches pick up a new look
  async function announceTeamMatches(c, teamId) {
    const ms = await c.matches.find({ $or: [{ 'teamA.teamId': teamId }, { 'teamB.teamId': teamId }], status: { $in: ['scheduled', 'live'] } }).toArray();
    ms.forEach((m) => broadcastMatchDoc(m));
  }

  app.post('/api/volleyball/teams', requireCreator(async (req, res, user, c) => {
    const b = req.body || {};
    const name = str(b.name, 60);
    if (!name) return res.status(400).json({ success: false, error: 'Team name required' });
    const logo = cleanLogo(b.logo);
    if (logo === undefined) return res.status(400).json({ success: false, error: 'The logo must be a PNG, JPEG or WebP under 600 KB' });
    const r = await resolveRoster(c, user, b.players, []);
    if (r.errors.length) return res.status(400).json({ success: false, error: r.errors[0] });
    const now = Date.now();
    const doc = {
      teamId: newId('vbteam'), ownerUid: user.uid, createdBy: user.email, name, nameKey: keyOf(name), shortName: str(b.shortName, 4).toUpperCase() || abbr(name),
      city: str(b.city, 60), colors: { primary: color(b.colors && b.colors.primary, '#1f3a8a'), secondary: color(b.colors && b.colors.secondary, '#0a1136'), text: color(b.colors && b.colors.text, '#ffffff') },
      logo, logoV: logo ? 1 : 0, players: r.players, createdAt: now, updatedAt: now
    };
    await c.teams.insertOne(doc);
    await audit(c, { action: 'team.create', teamId: doc.teamId, by: byOf(user), details: { name } });
    res.json({ success: true, team: publicTeam(doc, { all: true }) });
  }));

  app.put('/api/volleyball/teams/:teamId', requireCreator(async (req, res, user, c) => {
    const t = await c.teams.findOne({ teamId: String(req.params.teamId) });
    if (!t) return res.status(404).json({ success: false, error: 'No such team' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your team' });
    const b = req.body || {};
    const set = { updatedAt: Date.now() };
    if (b.name != null) { const n = str(b.name, 60); if (!n) return res.status(400).json({ success: false, error: 'Team name required' }); set.name = n; set.nameKey = keyOf(n); }
    if (b.shortName != null) set.shortName = str(b.shortName, 4).toUpperCase() || abbr(set.name || t.name);
    if (b.city != null) set.city = str(b.city, 60);
    if (b.colors) set.colors = { primary: color(b.colors.primary, t.colors.primary), secondary: color(b.colors.secondary, t.colors.secondary), text: color(b.colors.text, t.colors.text) };
    if (b.logo !== undefined) {
      const logo = cleanLogo(b.logo);
      if (logo === undefined) return res.status(400).json({ success: false, error: 'The logo must be a PNG, JPEG or WebP under 600 KB' });
      set.logo = logo; set.logoV = (t.logoV || 0) + 1;
    }
    if (b.players) {
      const r = await resolveRoster(c, user, b.players, t.players);
      if (r.errors.length) return res.status(400).json({ success: false, error: r.errors[0] });
      // a player who has played keeps their identity: removing them only
      // marks them inactive in the roster, their history stays theirs
      const kept = new Set(r.players.map((p) => p.playerId));
      (t.players || []).forEach((p) => { if (!kept.has(p.playerId)) r.players.push(Object.assign({}, p, { active: false })); });
      set.players = r.players;
    }
    await c.teams.updateOne({ teamId: t.teamId }, { $set: set });
    const next = Object.assign({}, t, set);
    // matches not started yet follow the team's new look and roster
    const snap = teamSnapshot(next);
    for (const side of ['A', 'B']) {
      const upd = { [`team${side}`]: snap, updatedAt: Date.now() };
      if (b.players) upd[`squads.${side}`] = squadOf(next);
      await c.matches.updateMany({ [`team${side}.teamId`]: t.teamId, status: 'scheduled' }, { $set: upd });
      // a match being played keeps its squad, but its graphics show the
      // team's new name, colours and logo at once
      await c.matches.updateMany({ [`team${side}.teamId`]: t.teamId, status: 'live' }, { $set: { [`team${side}`]: snap, updatedAt: Date.now() } });
    }
    await announceTeamMatches(c, t.teamId);
    await audit(c, { action: 'team.update', teamId: t.teamId, by: byOf(user), details: { fields: Object.keys(set) } });
    res.json({ success: true, team: publicTeam(next, { all: true }) });
  }));

  app.get('/api/volleyball/players/search', requireCreator(async (req, res, user, c) => {
    const q = keyOf(req.query.q || '');
    const all = await c.players.find(user.isOwner && req.query.all ? {} : { ownerUid: user.uid }).sort({ updatedAt: -1 }).limit(500).toArray();
    const list = all.filter((p) => !q || p.nameKey.includes(q)).slice(0, 30).map((p) => ({ playerId: p.playerId, name: p.name }));
    res.json({ success: true, players: list });
  }));

  /* ------------------------------------------------------------ tournaments */
  function cleanFormat(f, teamIds) {
    f = f && typeof f === 'object' ? f : {};
    const type = ['league', 'groups', 'knockout', 'groups_knockout', 'custom'].includes(f.type) ? f.type : 'league';
    const valid = new Set(teamIds || []);
    const groups = (Array.isArray(f.groups) ? f.groups : []).slice(0, 12).map((g, i) => ({
      name: str(g && g.name, 12) || String.fromCharCode(65 + i),
      teamIds: (Array.isArray(g && g.teamIds) ? g.teamIds : []).filter((id) => valid.has(id))
    })).filter((g) => g.teamIds.length);
    return { type, double: !!f.double, groups, qualifiersPerGroup: Math.max(1, Math.min(8, num(f.qualifiersPerGroup, 2))), thirdPlace: !!f.thirdPlace };
  }
  function publicTournament(t, user) {
    const manage = canManage(user, t);
    return {
      tournamentId: t.tournamentId, sport: 'volleyball', name: t.name, description: t.description || '', venue: t.venue || '', city: t.city || '',
      startDate: t.startDate || '', endDate: t.endDate || '', timezone: t.timezone || 'Asia/Kolkata',
      logo: t.logo ? `/api/volleyball/tournaments/${t.tournamentId}/logo?v=${t.logoV || 1}` : null,
      organizer: t.organizer || '', visibility: visibilityOf(t), status: t.status || 'upcoming', completedAt: t.completedAt || null,
      format: t.format, rules: t.rules, pointsPolicy: t.pointsPolicy, tiebreakers: t.tiebreakers, rulesLocked: !!t.rulesLocked,
      teamIds: t.teamIds || [], createdAt: t.createdAt, updatedAt: t.updatedAt, broadcast: G.normalizeStyle(t.broadcast),
      canManage: manage, createdBy: manage ? t.createdBy : undefined, archived: manage ? !!t.archived : undefined,
      driveFolderId: manage ? t.driveFolderId || null : undefined
    };
  }
  app.get('/api/volleyball/tournaments/:tid/logo', openRoute(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t || !t.logo) return res.status(404).end();
    if (!canView(user, t)) {
      // a private tournament's overlay shows its logo with the match key
      const m = req.query.match && req.query.key ? await c.matches.findOne({ matchId: String(req.query.match), tournamentId: t.tournamentId }) : null;
      if (!m || !sameSecret(req.query.key, m.overlayKey)) return res.status(404).end();
    }
    res.set('Content-Type', t.logo.type);
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.send(Buffer.from(t.logo.data, 'base64'));
  }));

  async function tournamentFromBody(c, user, b, prev) {
    const out = {};
    if (!prev || b.name != null) {
      const name = str(b.name, 80);
      if (!name) return { error: 'Tournament name required' };
      out.name = name; out.nameKey = keyOf(name);
    }
    ['description:600', 'venue:120', 'city:60', 'organizer:80'].forEach((f) => {
      const [k, n] = f.split(':');
      if (b[k] != null) out[k] = str(b[k], Number(n));
    });
    ['startDate', 'endDate'].forEach((k) => { if (b[k] != null) out[k] = /^\d{4}-\d{2}-\d{2}$/.test(String(b[k])) ? String(b[k]) : ''; });
    if (out.startDate && out.endDate && out.endDate < out.startDate) return { error: 'The end date is before the start date' };
    if (b.timezone != null) out.timezone = /^[A-Za-z_]+\/[A-Za-z_]+$/.test(String(b.timezone)) ? String(b.timezone) : 'Asia/Kolkata';
    if (b.visibility === 'public' || b.visibility === 'private') out.visibility = b.visibility;
    if (b.logo !== undefined) {
      const logo = cleanLogo(b.logo);
      if (logo === undefined) return { error: 'The logo must be a PNG, JPEG or WebP under 600 KB' };
      out.logo = logo; out.logoV = ((prev && prev.logoV) || 0) + 1;
    }
    if (b.teamIds != null) {
      const ids = [...new Set((Array.isArray(b.teamIds) ? b.teamIds : []).filter(idOk))].slice(0, 64);
      const teams = ids.length ? await c.teams.find({ teamId: { $in: ids } }).toArray() : [];
      const mine = teams.filter((t) => user.isOwner || t.ownerUid === user.uid).map((t) => t.teamId);
      out.teamIds = ids.filter((id) => mine.includes(id));
    }
    const teamIds = out.teamIds || (prev && prev.teamIds) || [];
    if (b.format != null) out.format = cleanFormat(b.format, teamIds);
    else if (out.teamIds && prev && prev.format) out.format = cleanFormat(prev.format, teamIds);
    const rulesChange = b.rules != null || b.pointsPolicy != null || b.tiebreakers != null;
    if (rulesChange && prev && prev.rulesLocked) {
      // a competition's rules are fixed once it has started: matches already
      // played were played under them, and silently changing them would
      // change those results
      if (b.rules != null && JSON.stringify(E.normalizeRules(b.rules)) !== JSON.stringify(prev.rules)) return { error: 'Matches have started — the scoring rules of this tournament can no longer change', code: 'RULES_LOCKED' };
    }
    if (b.rules != null) out.rules = E.normalizeRules(b.rules);
    if (b.pointsPolicy != null) out.pointsPolicy = Standings.normalizePolicy(b.pointsPolicy);
    if (b.tiebreakers != null) out.tiebreakers = Standings.normalizeTiebreakers(b.tiebreakers);
    if (b.driveFolder != null) {
      const m = /folders\/([A-Za-z0-9_-]+)/.exec(String(b.driveFolder)) || /^([A-Za-z0-9_-]{10,})$/.exec(String(b.driveFolder).trim());
      out.driveFolderId = m ? m[1] : null;
    }
    return { set: out };
  }

  app.post('/api/volleyball/tournaments', requireCreator(async (req, res, user, c) => {
    const r = await tournamentFromBody(c, user, req.body || {}, null);
    if (r.error) return res.status(400).json({ success: false, code: r.code, error: r.error });
    const now = Date.now();
    const doc = Object.assign({
      tournamentId: newId('vbt'), ownerUid: user.uid, createdBy: user.email, sport: 'volleyball',
      rules: E.normalizeRules({}), pointsPolicy: Standings.normalizePolicy(), tiebreakers: Standings.DEFAULT_TIEBREAKERS.slice(),
      format: cleanFormat({}, []), teamIds: [], status: 'upcoming', rulesLocked: false, timezone: 'Asia/Kolkata', createdAt: now, updatedAt: now
    }, r.set);
    await c.tournaments.insertOne(doc);
    await audit(c, { action: 'tournament.create', tournamentId: doc.tournamentId, by: byOf(user), details: { name: doc.name, visibility: visibilityOf(doc) } });
    invalidateDirectory();
    res.json({ success: true, tournament: publicTournament(doc, user) });
  }));

  // The broadcast look of every match of the tournament (colours, type,
  // backdrop, motion, times on screen): saved here, and the overlays on air
  // follow it at once.
  app.put('/api/volleyball/tournaments/:tid/broadcast', requireCreator(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t) return res.status(404).json({ success: false, error: 'No such tournament' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your tournament' });
    const b = req.body && typeof req.body.style === 'object' ? req.body.style : null;
    if (!b) return res.status(400).json({ success: false, error: 'No broadcast settings sent' });
    const style = G.normalizeStyle(Object.assign({}, G.normalizeStyle(t.broadcast), b));
    await c.tournaments.updateOne({ tournamentId: t.tournamentId }, { $set: { broadcast: style, updatedAt: Date.now() } });
    await audit(c, { action: 'tournament.broadcast', tournamentId: t.tournamentId, by: byOf(user), details: { style } });
    nsp.to(troom(t.tournamentId)).emit('vb:style', { tournamentId: t.tournamentId, style });
    res.json({ success: true, style });
  }));

  app.put('/api/volleyball/tournaments/:tid', requireCreator(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t) return res.status(404).json({ success: false, error: 'No such tournament' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your tournament' });
    const b = req.body || {};
    const r = await tournamentFromBody(c, user, b, t);
    if (r.error) return res.status(r.code === 'RULES_LOCKED' ? 409 : 400).json({ success: false, code: r.code, error: r.error });
    if (b.status === 'completed' || b.status === 'ongoing' || b.status === 'upcoming') { r.set.status = b.status; r.set.completedAt = b.status === 'completed' ? Date.now() : null; }
    if (b.archived === true || b.archived === false) r.set.archived = b.archived;
    r.set.updatedAt = Date.now();
    await c.tournaments.updateOne({ tournamentId: t.tournamentId }, { $set: r.set });
    // scheduled matches take the tournament's rules until they start
    if (r.set.rules) await c.matches.updateMany({ tournamentId: t.tournamentId, status: 'scheduled' }, { $set: { rules: r.set.rules } });
    await audit(c, { action: 'tournament.update', tournamentId: t.tournamentId, by: byOf(user), details: { fields: Object.keys(r.set) } });
    invalidateDirectory(); invalidateStandings(t.tournamentId);
    res.json({ success: true, tournament: publicTournament(Object.assign({}, t, r.set), user) });
  }));

  // My tournaments and teams (the dashboard).
  app.get('/api/volleyball/mine', requireCreator(async (req, res, user, c) => {
    const q = user.isOwner && req.query.all === '1' ? {} : { ownerUid: user.uid };
    const [ts, teams] = await Promise.all([
      c.tournaments.find(q).sort({ updatedAt: -1 }).limit(200).toArray(),
      c.teams.find(q).sort({ updatedAt: -1 }).limit(400).toArray()
    ]);
    res.json({ success: true, user: { email: user.email, isOwner: user.isOwner }, tournaments: ts.map((t) => publicTournament(t, user)), teams: teams.map((t) => publicTeam(t, { all: true })) });
  }));

  // A tournament page: details, teams, fixtures / results, standings.
  app.get('/api/volleyball/tournaments/:tid', openRoute(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t || !canView(user, t)) return res.status(404).json({ success: false, error: 'Tournament not found' });
    const [teams, matches] = await Promise.all([
      c.teams.find({ teamId: { $in: t.teamIds || [] } }).toArray(),
      c.matches.find({ tournamentId: t.tournamentId }).sort({ scheduledAt: 1 }).toArray()
    ]);
    const manage = canManage(user, t);
    res.json({
      success: true,
      tournament: publicTournament(t, user),
      teams: (t.teamIds || []).map((id) => teams.find((x) => x.teamId === id)).filter(Boolean).map((x) => publicTeam(x, { all: manage })),
      matches: matches.map((m) => publicMatch(m, manage)),
      standings: standingsOf(t, teams, matches)
    });
  }));

  app.get('/api/volleyball/public/tournaments', openRoute(async (req, res, user, c) => {
    const ownerView = !!(user && user.isOwner);
    if (!ownerView && directoryCache && directoryCache.at > Date.now() - 15000) return res.json(directoryCache.payload);
    const ts = await c.tournaments.find({}).sort({ updatedAt: -1 }).limit(300).toArray();
    const list = [];
    for (const t of ts) {
      if (t.archived) continue;
      const vis = visibilityOf(t);
      if (vis !== 'public' && !ownerView) continue;
      const ms = await c.matches.find({ tournamentId: t.tournamentId }).toArray();
      const live = ms.filter((m) => m.status === 'live').length;
      const done = ms.filter((m) => m.status === 'completed').length;
      list.push({
        tournamentId: t.tournamentId, sport: 'volleyball', name: t.name, venue: t.venue || '', city: t.city || '',
        startDate: t.startDate || '', endDate: t.endDate || '',
        logo: t.logo ? `/api/volleyball/tournaments/${t.tournamentId}/logo?v=${t.logoV || 1}` : null,
        status: t.status === 'completed' ? 'completed' : live ? 'live' : done ? 'ongoing' : 'upcoming',
        teams: (t.teamIds || []).length, matchCount: done, liveCount: live, updatedAt: t.updatedAt || 0,
        url: `/volleyball/tournament/${t.tournamentId}`,
        ...(ownerView ? { visibility: vis, createdBy: t.createdBy || null } : {})
      });
    }
    const payload = { success: true, tournaments: list, ownerView };
    if (!ownerView) directoryCache = { at: Date.now(), payload };
    res.json(payload);
  }));
  let directoryCache = null;
  function invalidateDirectory() { directoryCache = null; }

  /* ------------------------------------------------------------ standings */
  const standingsCache = new Map();
  function invalidateStandings(tid) { standingsCache.delete(tid); }
  function standingsOf(t, teams, matches) {
    const groups = t.format && Array.isArray(t.format.groups) && t.format.groups.length && (t.format.type === 'groups' || t.format.type === 'groups_knockout') ? t.format.groups : null;
    if (t.format && t.format.type === 'knockout') return { policy: Standings.normalizePolicy(t.pointsPolicy), tiebreakers: Standings.normalizeTiebreakers(t.tiebreakers), groups: [], knockoutOnly: true };
    const byId = new Map(teams.map((x) => [x.teamId, x]));
    const list = (t.teamIds || []).map((id) => byId.get(id)).filter(Boolean).map((x) => ({
      teamId: x.teamId, name: x.name, shortName: x.shortName, colors: x.colors, logo: x.logo ? `/api/volleyball/teams/${x.teamId}/logo?v=${x.logoV || 1}` : null
    }));
    return Standings.compute({ teams: list, matches, groups, policy: t.pointsPolicy, tiebreakers: t.tiebreakers });
  }
  app.get('/api/volleyball/tournaments/:tid/standings', openRoute(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t || !canView(user, t)) return res.status(404).json({ success: false, error: 'Tournament not found' });
    const [teams, matches] = await Promise.all([c.teams.find({ teamId: { $in: t.teamIds || [] } }).toArray(), c.matches.find({ tournamentId: t.tournamentId }).toArray()]);
    res.json({ success: true, standings: standingsOf(t, teams, matches) });
  }));
  // The same table for one match's overlay, which cannot sign in (the
  // overlay of a private tournament carries its match key instead).
  app.get('/api/volleyball/matches/:mid/standings', openRoute(async (req, res, user, c) => {
    const a = await matchAccess(c, user, req.params.mid, req.query.key);
    if (!a.m || !a.t) return res.status(404).json({ success: false, error: 'Match not found' });
    const [teams, matches] = await Promise.all([c.teams.find({ teamId: { $in: a.t.teamIds || [] } }).toArray(), c.matches.find({ tournamentId: a.t.tournamentId }).toArray()]);
    res.json({ success: true, tournament: { tournamentId: a.t.tournamentId, name: a.t.name }, standings: standingsOf(a.t, teams, matches) });
  }));

  /* ------------------------------------------------------------ matches */
  function publicMatch(m, manage) {
    if (!m) return null;
    const o = {
      matchId: m.matchId, tournamentId: m.tournamentId, matchNo: m.matchNo || null, title: m.title || '',
      stage: m.stage || null, fixtureKey: m.fixtureKey || null, source: m.source || null,
      teamA: m.teamA ? withLogo(m.teamA) : null, teamB: m.teamB ? withLogo(m.teamB) : null,
      scheduledAt: m.scheduledAt || null, venue: m.venue || '', notes: m.notes || '',
      rules: m.rules, status: m.status, locked: !!m.locked, lockReason: m.locked ? m.lockReason || '' : '',
      summary: m.summary || null, result: m.result || null, eventSeq: m.eventSeq || 0,
      startedAt: m.startedAt || null, completedAt: m.completedAt || null,
      report: m.report ? { status: m.report.status, version: m.report.version || 0, generatedAt: m.report.generatedAt || null, stale: !!m.report.stale, url: m.report.status === 'ready' || m.report.version ? `/api/volleyball/matches/${m.matchId}/report.pdf` : null } : null,
      lease: publicLease(m.lease), squads: m.squads || { A: [], B: [] }, graphic: G.publicState(airOf(m), Date.now())
    };
    if (manage) { o.clipToken = m.clipToken; o.overlayKey = m.overlayKey; o.canManage = true; o.clipper = publicClipper(m.clipper); }
    return o;
  }
  function withLogo(s) { return Object.assign({}, s, { logo: s.logoV ? `/api/volleyball/teams/${s.teamId}/logo?v=${s.logoV}` : null }); }
  function publicLease(l) {
    if (!l) return null;
    return { deviceId: l.deviceId, email: l.email, since: l.since, heartbeatAt: l.heartbeatAt, active: l.heartbeatAt > Date.now() - LEASE_TTL_MS };
  }

  async function nextMatchNo(c, tid) {
    const last = await c.matches.find({ tournamentId: tid }).sort({ matchNo: -1 }).limit(1).toArray();
    return ((last[0] && last[0].matchNo) || 0) + 1;
  }
  async function newMatchDoc(c, t, o) {
    const now = Date.now();
    const doc = {
      matchId: newId('vbm'), tournamentId: t.tournamentId, ownerUid: t.ownerUid, matchNo: await nextMatchNo(c, t.tournamentId),
      title: str(o.title, 80), stage: o.stage || { type: 'league' }, source: o.source || null,
      teamA: o.teamA ? teamSnapshot(o.teamA) : null, teamB: o.teamB ? teamSnapshot(o.teamB) : null,
      squads: { A: o.teamA ? squadOf(o.teamA) : [], B: o.teamB ? squadOf(o.teamB) : [] },
      scheduledAt: o.scheduledAt || null, venue: str(o.venue || t.venue, 120), notes: str(o.notes, 400),
      rules: E.normalizeRules(o.rules || t.rules), status: 'scheduled', locked: !!o.locked, lease: null,
      eventSeq: 0, summary: null, result: null, report: null,
      clipToken: crypto.randomBytes(18).toString('hex'), overlayKey: crypto.randomBytes(9).toString('hex'),
      createdAt: now, updatedAt: now
    };
    // a hand-made match has no fixture key at all (the driver would store an undefined one as null)
    if (o.fixtureKey) doc.fixtureKey = o.fixtureKey;
    return doc;
  }
  function cleanStage(s) {
    s = s && typeof s === 'object' ? s : {};
    const type = ['league', 'group', 'knockout', 'friendly'].includes(s.type) ? s.type : 'league';
    return { type, group: type === 'group' ? str(s.group, 12) : '', round: str(s.round, 40), roundIndex: num(s.roundIndex, null) };
  }

  app.post('/api/volleyball/tournaments/:tid/matches', requireCreator(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t) return res.status(404).json({ success: false, error: 'No such tournament' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your tournament' });
    const b = req.body || {};
    if (!idOk(b.teamA) || !idOk(b.teamB)) return res.status(400).json({ success: false, error: 'Choose both teams' });
    if (b.teamA === b.teamB) return res.status(400).json({ success: false, error: 'A team cannot play itself' });
    const [A, B] = await Promise.all([c.teams.findOne({ teamId: b.teamA }), c.teams.findOne({ teamId: b.teamB })]);
    if (!A || !B) return res.status(400).json({ success: false, error: 'Unknown team' });
    if (!(t.teamIds || []).includes(A.teamId) || !(t.teamIds || []).includes(B.teamId)) return res.status(400).json({ success: false, error: 'Both teams must be part of this tournament' });
    const doc = await newMatchDoc(c, t, { teamA: A, teamB: B, stage: cleanStage(b.stage), scheduledAt: num(b.scheduledAt, null), venue: b.venue, notes: b.notes, title: b.title, locked: b.locked });
    await c.matches.insertOne(doc);
    await audit(c, { action: 'match.create', tournamentId: t.tournamentId, matchId: doc.matchId, by: byOf(user), details: { teamA: A.name, teamB: B.name, scheduledAt: doc.scheduledAt } });
    invalidateStandings(t.tournamentId); invalidateDirectory();
    res.json({ success: true, match: publicMatch(doc, true) });
  }));

  // Fixtures: round robin (single / double, per group) or a seeded knockout.
  // Generating again never duplicates: each fixture has a stable key.
  app.post('/api/volleyball/tournaments/:tid/fixtures', requireCreator(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t) return res.status(404).json({ success: false, error: 'No such tournament' });
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your tournament' });
    const b = req.body || {};
    const kind = b.kind || (t.format && t.format.type) || 'league';
    const teams = await c.teams.find({ teamId: { $in: t.teamIds || [] } }).toArray();
    const byId = new Map(teams.map((x) => [x.teamId, x]));
    const start = num(b.startAt, null), gapMs = Math.max(0, num(b.gapMinutes, 90)) * 60000, perDay = Math.max(1, num(b.matchesPerDay, 6));
    let planned = [];
    if (kind === 'league' || kind === 'groups' || kind === 'groups_knockout' || kind === 'double') {
      const groups = (kind === 'groups' || kind === 'groups_knockout') && t.format.groups && t.format.groups.length ? t.format.groups : [{ name: '', teamIds: t.teamIds || [] }];
      groups.forEach((g) => {
        Standings.roundRobin(g.teamIds, { double: !!(t.format && t.format.double) || kind === 'double' }).forEach((f) => {
          const pair = [f.home, f.away].sort().join('|');
          const leg = f.round > (g.teamIds.length - (g.teamIds.length % 2 ? 0 : 1)) ? 2 : 1;
          planned.push({ key: `RR:${g.name || 'L'}:${pair}:${leg}`, A: f.home, B: f.away, round: f.round, stage: g.name ? { type: 'group', group: g.name, round: 'Round ' + f.round, roundIndex: f.round } : { type: 'league', round: 'Round ' + f.round, roundIndex: f.round } });
        });
      });
    } else if (kind === 'knockout') {
      let seeds = Array.isArray(b.seeds) && b.seeds.length ? b.seeds.filter((id) => byId.has(id)) : (t.teamIds || []).slice();
      if (b.fromStandings) {
        const all = await c.matches.find({ tournamentId: t.tournamentId }).toArray();
        const st = standingsOf(t, teams, all);
        seeds = Standings.seedsFromGroups(st.groups, (t.format && t.format.qualifiersPerGroup) || 2);
      }
      Standings.knockout(seeds, { thirdPlace: !!(t.format && t.format.thirdPlace) || !!b.thirdPlace }).forEach((k) => {
        planned.push({ key: k.key, A: k.A.teamId || null, B: k.B.teamId || null, round: 100 + k.round, source: { A: k.A.teamId ? null : k.A, B: k.B.teamId ? null : k.B },
          stage: { type: 'knockout', round: k.roundLabel, roundIndex: k.round } });
      });
    } else return res.status(400).json({ success: false, error: 'Unknown fixture kind' });
    if (!planned.length) return res.status(400).json({ success: false, error: 'Add at least two teams first' });
    planned.sort((x, y) => x.round - y.round);
    let created = 0, existing = 0, i = 0;
    for (const p of planned) {
      const exists = await c.matches.findOne({ tournamentId: t.tournamentId, fixtureKey: p.key });
      if (exists) { existing++; continue; }
      const scheduledAt = start ? start + Math.floor(i / perDay) * 86400000 + (i % perDay) * gapMs : null;
      const doc = await newMatchDoc(c, t, { teamA: p.A ? byId.get(p.A) : null, teamB: p.B ? byId.get(p.B) : null, stage: p.stage, fixtureKey: p.key, scheduledAt,
        source: p.source && (p.source.A || p.source.B) ? { A: p.source.A || null, B: p.source.B || null } : null });
      try { await c.matches.insertOne(doc); created++; i++; }
      catch (e) { if (e && e.code === 11000) existing++; else throw e; }
    }
    await audit(c, { action: 'fixtures.generate', tournamentId: t.tournamentId, by: byOf(user), details: { kind, created, existing } });
    invalidateStandings(t.tournamentId); invalidateDirectory();
    res.json({ success: true, created, existing });
  }));

  async function loadMatch(c, matchId) { return c.matches.findOne({ matchId: String(matchId || '') }); }
  async function tournamentOf(c, m) { return m ? c.tournaments.findOne({ tournamentId: m.tournamentId }) : null; }

  // Viewer access to one match: its tournament's visibility, or the
  // overlay key of a private match (the overlay cannot sign in).
  async function matchAccess(c, user, matchId, key) {
    const m = await loadMatch(c, matchId);
    if (!m) return { status: 404 };
    const t = await tournamentOf(c, m);
    const manage = canManage(user, t);
    if (!manage && !canView(user, t) && !(key && sameSecret(key, m.overlayKey))) return { status: 404 };
    return { m, t, manage };
  }

  app.get('/api/volleyball/matches/:mid', openRoute(async (req, res, user, c) => {
    const a = await matchAccess(c, user, req.params.mid, req.query.key);
    if (!a.m) return res.status(404).json({ success: false, error: 'Match not found' });
    const graphic = await currentAir(c, a.m);
    const out = { success: true, match: Object.assign(publicMatch(a.m, a.manage), { graphic: G.publicState(graphic, Date.now()) }), tournament: publicTournament(a.t, user), photos: await photosOf(c, a.m) };
    if (req.query.timeline === '1') {
      const L = await getLedger(c, a.m);
      out.timeline = publicTimeline(L, a.manage);
      out.summary = E.summary(L.setup, L.state);
      out.invalid = L.invalid.map((x) => ({ eventId: x.eventId, seq: x.seq, error: x.invalid.error }));
    }
    res.json(out);
  }));

  app.put('/api/volleyball/matches/:mid', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'No such match' });
    const t = await tournamentOf(c, m);
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your match' });
    if (m.locked) return res.status(423).json({ success: false, code: 'MATCH_LOCKED', error: 'This match is locked — unlock it first' });
    const b = req.body || {};
    const set = { updatedAt: Date.now() };
    if (b.scheduledAt !== undefined) set.scheduledAt = num(b.scheduledAt, null);
    if (b.venue != null) set.venue = str(b.venue, 120);
    if (b.notes != null) set.notes = str(b.notes, 400);
    if (b.title != null) set.title = str(b.title, 80);
    if (b.stage) set.stage = cleanStage(b.stage);
    if (m.status === 'scheduled') {
      if (b.rules) set.rules = E.normalizeRules(b.rules);
      for (const side of ['A', 'B']) {
        if (b['team' + side] && idOk(b['team' + side])) {
          const tm = await c.teams.findOne({ teamId: b['team' + side] });
          if (!tm || !(t.teamIds || []).includes(tm.teamId)) return res.status(400).json({ success: false, error: 'That team is not in this tournament' });
          set['team' + side] = teamSnapshot(tm);
          set['squads.' + side] = squadOf(tm);
        }
      }
    }
    // The squads: who is registered for this match, liberos, captain.
    if (b.squads) {
      const cur = Object.assign({}, m, set);
      for (const side of ['A', 'B']) {
        if (!Array.isArray(b.squads[side])) continue;
        const team = await c.teams.findOne({ teamId: cur['team' + side] && cur['team' + side].teamId });
        if (!team) continue;
        const roster = new Map((team.players || []).map((p) => [p.playerId, p]));
        const picked = [];
        b.squads[side].forEach((s) => {
          const p = s && roster.get(s.playerId);
          if (!p || picked.some((x) => x.playerId === p.playerId)) return;
          picked.push({ playerId: p.playerId, number: str(s.number != null ? s.number : p.number, 3).replace(/[^0-9]/g, ''), name: p.name, role: E.ROLES[s.role] ? s.role : p.role || '', libero: !!s.libero, captain: !!s.captain });
        });
        const max = (cur.rules || E.normalizeRules({})).maxLiberos;
        if (picked.filter((p) => p.libero).length > max) return res.status(400).json({ success: false, error: `At most ${max} libero(s) per team` });
        if (picked.filter((p) => p.captain).length > 1) return res.status(400).json({ success: false, error: 'One captain per team' });
        if (m.status !== 'scheduled') {
          // once started, players can be added but never taken away — the
          // ledger may already name them
          const before = new Set((m.squads[side] || []).map((p) => p.playerId));
          const after = new Set(picked.map((p) => p.playerId));
          if ([...before].some((id) => !after.has(id))) return res.status(409).json({ success: false, error: 'The match has started — players can be added to a squad, not removed' });
          const libsBefore = (m.squads[side] || []).filter((p) => p.libero).map((p) => p.playerId).sort().join();
          const libsAfter = picked.filter((p) => p.libero).map((p) => p.playerId).sort().join();
          if (libsBefore !== libsAfter) return res.status(409).json({ success: false, error: 'The match has started — the liberos can no longer change' });
        }
        set['squads.' + side] = picked;
      }
    }
    await c.matches.updateOne({ matchId: m.matchId }, { $set: set });
    dropLedger(m.matchId);
    await audit(c, { action: 'match.update', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { fields: Object.keys(set) } });
    const next = await loadMatch(c, m.matchId);
    broadcastMatchDoc(next);
    res.json({ success: true, match: publicMatch(next, true) });
  }));

  app.delete('/api/volleyball/matches/:mid', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'No such match' });
    const t = await tournamentOf(c, m);
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your match' });
    if (m.locked) return res.status(423).json({ success: false, code: 'MATCH_LOCKED', error: 'This match is locked — unlock it first' });
    if (m.status !== 'scheduled' || (m.eventSeq || 0) > 0) return res.status(409).json({ success: false, error: 'A match that has started is never deleted — mark it abandoned instead' });
    await c.matches.deleteOne({ matchId: m.matchId });
    await audit(c, { action: 'match.delete', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { teamA: m.teamA && m.teamA.name, teamB: m.teamB && m.teamB.name } });
    invalidateStandings(m.tournamentId); invalidateDirectory();
    res.json({ success: true });
  }));

  // 🔒 Lock / unlock (enforced here, for every write path).
  app.post('/api/volleyball/matches/:mid/lock', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'No such match' });
    const t = await tournamentOf(c, m);
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your match' });
    const locked = !!(req.body && req.body.locked);
    const set = locked ? { locked: true, lockedAt: Date.now(), lockedBy: user.email, lockReason: str(req.body.reason, 200) } : { locked: false, lockReason: '', unlockedAt: Date.now(), unlockedBy: user.email };
    await c.matches.updateOne({ matchId: m.matchId }, { $set: set });
    await audit(c, { action: locked ? 'match.lock' : 'match.unlock', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { reason: set.lockReason || '' } });
    const next = await loadMatch(c, m.matchId);
    broadcastMatchDoc(next);
    res.json({ success: true, match: publicMatch(next, true) });
  }));

  /* ------------------------------------------------------------ controller lease */
  async function claimLease(c, user, m, deviceId, force) {
    if (m.locked) return { status: 423, body: { success: false, code: 'MATCH_LOCKED', error: 'This match is locked — unlock it to score it' } };
    const now = Date.now(), cur = m.lease;
    const active = cur && cur.heartbeatAt > now - LEASE_TTL_MS;
    if (active && cur.deviceId !== deviceId && !force) {
      return { status: 409, body: { success: false, code: 'LEASE_HELD', error: `${cur.email || 'Another device'} is scoring this match right now`, holder: publicLease(cur) } };
    }
    const token = crypto.randomBytes(24).toString('hex');
    const lease = { deviceId, tokenHash: sha(token), uid: user.uid, email: user.email, since: now, heartbeatAt: now };
    // only if nobody changed the lease since we looked
    const filter = cur ? { matchId: m.matchId, 'lease.tokenHash': cur.tokenHash } : { matchId: m.matchId, lease: null };
    const r = await c.matches.updateOne(filter, { $set: { lease } });
    if (!r.matchedCount) return { status: 409, body: { success: false, code: 'LEASE_RACE', error: 'Another device took control at the same moment — try again' } };
    leaseBeats.set(m.matchId, now);
    await audit(c, { action: cur && cur.deviceId !== deviceId ? (active ? 'lease.takeover' : 'lease.claim-expired') : 'lease.claim', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user, { deviceId }), details: cur ? { previous: cur.email, previousDevice: cur.deviceId } : {} });
    nsp.to(room(m.matchId)).emit('vb:lease', { matchId: m.matchId, lease: publicLease(lease) });
    return { status: 200, body: { success: true, leaseToken: token, lease: publicLease(lease) } };
  }
  const leaseBeats = new Map();   // matchId -> last heartbeat persisted
  function leaseOk(m, token) { return !!(m && m.lease && token && sameSecret(sha(token), m.lease.tokenHash)); }
  async function beat(c, m) {
    const now = Date.now();
    const last = leaseBeats.get(m.matchId) || 0;
    if (now - last < 10000) return;
    leaseBeats.set(m.matchId, now);
    await c.matches.updateOne({ matchId: m.matchId, 'lease.tokenHash': m.lease.tokenHash }, { $set: { 'lease.heartbeatAt': now } }).catch(() => {});
  }
  app.post('/api/volleyball/matches/:mid/lease', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'No such match' });
    const t = await tournamentOf(c, m);
    if (!canManage(user, t)) return res.status(403).json({ success: false, error: 'Not your match' });
    const deviceId = str(req.body && req.body.deviceId, 64);
    if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId required' });
    const r = await claimLease(c, user, m, deviceId, !!(req.body && req.body.force));
    res.status(r.status).json(r.body);
  }));
  app.delete('/api/volleyball/matches/:mid/lease', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false });
    if (!leaseOk(m, req.get('x-vb-lease'))) return res.status(403).json({ success: false, error: 'Only the device in control can release it' });
    await c.matches.updateOne({ matchId: m.matchId, 'lease.tokenHash': m.lease.tokenHash }, { $set: { lease: null } });
    await audit(c, { action: 'lease.release', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user, { deviceId: m.lease.deviceId }) });
    nsp.to(room(m.matchId)).emit('vb:lease', { matchId: m.matchId, lease: null });
    res.json({ success: true });
  }));

  /* ------------------------------------------------------------ the ledger */
  const ledgers = new Map();      // matchId -> { ledger, setupKey }
  function setupOf(m) {
    const side = (s) => ({ teamId: m['team' + s] ? m['team' + s].teamId : null, name: m['team' + s] ? m['team' + s].name : 'Team ' + s, shortName: m['team' + s] ? m['team' + s].shortName : s, players: (m.squads && m.squads[s]) || [] });
    return { teams: { A: side('A'), B: side('B') }, rules: m.rules };
  }
  function dropLedger(matchId) { ledgers.delete(matchId); }
  async function getLedger(c, m) {
    const setupKey = sha(JSON.stringify(setupOf(m)));
    const hit = ledgers.get(m.matchId);
    if (hit && hit.setupKey === setupKey && hit.ledger.seq === (m.eventSeq || 0)) {
      ledgers.delete(m.matchId); ledgers.set(m.matchId, hit);   // LRU
      return hit.ledger;
    }
    const rows = await c.events.find({ matchId: m.matchId }).sort({ seq: 1 }).toArray();
    const L = new E.Ledger(setupOf(m), rows.map(dbEventToEvent));
    ledgers.set(m.matchId, { ledger: L, setupKey });
    while (ledgers.size > LEDGER_CACHE_MAX) ledgers.delete(ledgers.keys().next().value);
    return L;
  }
  function dbEventToEvent(r) { const o = clean(r); delete o.matchId; return o; }
  // Who pressed a button is for the match's managers (and the audit), not
  // for every viewer of a public scorecard.
  function publicTimeline(L, manage) {
    return manage ? L.timeline : L.timeline.map((e) => { if (!e.by) return e; const o = Object.assign({}, e); delete o.by; return o; });
  }
  function publicEvent(ev) { if (!ev) return null; const o = Object.assign({}, ev); delete o.by; delete o.matchId; return o; }

  // Only the fields each event type may carry — nothing else is stored.
  function sanitizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = String(raw.type || '');
    if (!E.EVENT_TYPES.includes(type)) return null;
    if (!idOk(raw.eventId)) return null;
    const ev = { eventId: raw.eventId, type, at: num(raw.at, null) };
    const team = (v) => (v === 'A' || v === 'B' ? v : undefined);
    const pid = (v) => (idOk(v) ? v : undefined);
    const ids = (v, n) => (Array.isArray(v) ? v.filter(idOk).slice(0, n || 6) : undefined);
    const put = (k, v) => { if (v !== undefined && v !== null && v !== '') ev[k] = v; };
    const players = (p) => {
      if (!p || typeof p !== 'object') return undefined;
      const o = {};
      ['attacker', 'assist', 'receiver', 'errorBy'].forEach((k) => { if (pid(p[k])) o[k] = p[k]; });
      ['blockers', 'diggers'].forEach((k) => { const a = ids(p[k], 3); if (a && a.length) o[k] = a; });
      return Object.keys(o).length ? o : undefined;
    };
    const actions = (a) => (Array.isArray(a) ? a.slice(0, 40).map((x) => x && ({ type: str(x.type, 16).toUpperCase(), team: team(x.team), playerId: pid(x.playerId), result: str(x.result, 16).toLowerCase() })).filter((x) => x && x.team && x.playerId) : undefined);
    switch (type) {
      case 'TOSS': put('set', num(raw.set, 1)); put('winner', team(raw.winner)); put('choice', ['serve', 'receive', 'court'].includes(raw.choice) ? raw.choice : undefined); put('firstServe', team(raw.firstServe)); put('leftSide', team(raw.leftSide)); put('captainA', pid(raw.captainA)); put('captainB', pid(raw.captainB)); break;
      case 'LINEUP': case 'LINEUP_CORRECTION': put('set', num(raw.set, undefined)); put('team', team(raw.team)); put('positions', Array.isArray(raw.positions) ? raw.positions.slice(0, 6).map((x) => (idOk(x) ? x : '')) : undefined); put('scope', raw.scope === 'starting' ? 'starting' : undefined); put('reason', str(raw.reason, 200)); break;
      case 'SET_START': put('set', num(raw.set, undefined)); break;
      case 'RALLY': put('winner', team(raw.winner)); put('outcome', E.OUTCOMES[raw.outcome] ? raw.outcome : 'GENERAL'); put('players', players(raw.players)); put('actions', actions(raw.actions)); put('note', str(raw.note, 200)); break;
      case 'REPLAY': put('reason', E.REPLAY_REASONS[raw.reason] ? raw.reason : 'DOUBLE_FAULT'); break;
      case 'TIMEOUT': put('team', team(raw.team)); break;
      case 'SUBSTITUTION': put('team', team(raw.team)); put('pairs', Array.isArray(raw.pairs) ? raw.pairs.slice(0, 6).map((p) => ({ out: pid(p && p.out) || '', in: pid(p && p.in) || '' })) : undefined); if (raw.exceptional) ev.exceptional = true; put('reason', str(raw.reason, 200)); break;
      case 'LIBERO': put('team', team(raw.team)); put('libero', pid(raw.libero)); put('replaces', pid(raw.replaces)); put('returning', pid(raw.returning)); put('action', raw.action === 'out' ? 'out' : 'in'); break;
      case 'SERVE_CORRECTION': put('team', team(raw.team)); put('reason', str(raw.reason, 200)); break;
      case 'ROTATE': put('team', team(raw.team)); put('direction', raw.direction === -1 ? -1 : 1); put('reason', str(raw.reason, 200)); break;
      case 'SANCTION': put('team', team(raw.team)); put('playerId', pid(raw.playerId)); put('kind', E.SANCTIONS[raw.kind] ? raw.kind : undefined); put('reason', str(raw.reason, 200)); break;
      case 'NOTE': put('text', str(raw.text, 500)); break;
      case 'FORFEIT': put('team', team(raw.team)); put('reason', str(raw.reason, 200)); break;
      case 'ABANDON': put('reason', str(raw.reason, 200)); break;
      case 'UNDO': case 'REDO': put('target', idOk(raw.target) ? raw.target : undefined); put('reason', str(raw.reason, 200)); break;
      case 'VOID': put('target', idOk(raw.target) ? raw.target : undefined); put('reason', str(raw.reason, 200)); break;
      case 'CORRECT': {
        put('target', idOk(raw.target) ? raw.target : undefined); put('reason', str(raw.reason, 200));
        const p = raw.patch && typeof raw.patch === 'object' ? raw.patch : {};
        const patch = {};
        if (team(p.winner)) patch.winner = p.winner;
        if (E.OUTCOMES[p.outcome]) patch.outcome = p.outcome;
        if (p.players !== undefined) patch.players = players(p.players) || null;
        if (p.actions !== undefined) patch.actions = actions(p.actions) || [];
        if (p.note != null) patch.note = str(p.note, 200);
        ev.patch = patch;
        if (raw.attribution === true) ev.attribution = true;   // who earned the point — see isAttribution in the engine
        break;
      }
    }
    if (raw.override && typeof raw.override === 'object' && str(raw.override.reason, 200)) ev.override = { reason: str(raw.override.reason, 200) };
    return ev;
  }

  // Per match, one write at a time — the order events reach the ledger is
  // the order they were accepted.
  const chains = new Map();
  function serial(matchId, fn) {
    const prev = chains.get(matchId) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    chains.set(matchId, tail);
    tail.then(() => { if (chains.get(matchId) === tail) chains.delete(matchId); });
    return run;
  }

  const CORRECTION_TYPES = new Set(['VOID', 'CORRECT', 'LINEUP_CORRECTION', 'SERVE_CORRECTION', 'ROTATE', 'FORFEIT', 'ABANDON']);

  // THE write path, for the socket and REST alike.
  async function submitEvent(c, user, matchId, rawEvent, leaseToken) {
    return serial(String(matchId), async () => {
      const m = await loadMatch(c, matchId);
      if (!m) return { ok: false, status: 404, code: 'NO_MATCH', error: 'No such match' };
      const t = await tournamentOf(c, m);
      if (!canManage(user, t)) return { ok: false, status: 403, code: 'NOT_AUTHORISED', error: 'Not your match' };
      const ev = sanitizeEvent(rawEvent);
      if (!ev) return { ok: false, status: 400, code: 'INVALID_EVENT', error: 'That event is not valid' };
      if (!m.teamA || !m.teamB) return { ok: false, status: 409, code: 'TEAMS_TBD', error: 'Both teams must be known before the match starts' };
      const L = await getLedger(c, m);
      // the same press again (a retry whose answer was lost): already recorded —
      // answered as such even if control or the lock changed since
      if (L.has(ev.eventId)) return { ok: true, duplicate: true, seq: L.seq, summary: E.summary(L.setup, L.state) };
      if (m.locked) return { ok: false, status: 423, code: 'MATCH_LOCKED', error: 'This match is locked' };
      if (!leaseOk(m, leaseToken)) return { ok: false, status: 409, code: 'LEASE_REQUIRED', error: 'This device is not in control of the match — take control first', lease: publicLease(m.lease) };
      if (m.status === 'completed' && E.META[ev.type] && !ev.reason) {
        return { ok: false, status: 400, code: 'REASON_REQUIRED', error: 'The match is complete — give a reason for changing it' };
      }
      ev.by = { uid: user.uid, email: user.email, deviceId: m.lease.deviceId };
      ev.receivedAt = Date.now();
      if (!ev.at || Math.abs(ev.at - ev.receivedAt) > 6 * 3600 * 1000) ev.at = ev.receivedAt;
      const chk = L.check(ev);
      if (!chk.ok) {
        if (chk.duplicate) return { ok: true, duplicate: true, seq: L.seq, summary: E.summary(L.setup, L.state) };
        return { ok: false, status: 409, code: chk.code, error: chk.error, overridable: !!chk.overridable };
      }
      const stored = Object.assign({ matchId: m.matchId }, chk.pending.event);
      try {
        await c.events.insertOne(stored);
      } catch (e) {
        if (e && e.code === 11000) {
          // another writer got there first (or this exact event already landed): reload and answer from the database
          dropLedger(m.matchId);
          const again = await c.events.findOne({ matchId: m.matchId, eventId: ev.eventId });
          const fresh = await getLedger(c, await loadMatch(c, m.matchId));
          if (again) return { ok: true, duplicate: true, seq: fresh.seq, summary: E.summary(fresh.setup, fresh.state) };
          return { ok: false, status: 409, code: 'CONFLICT', error: 'The match changed on another device — refreshed, please try again', retry: true };
        }
        throw e;
      }
      L.commit(chk.pending);
      const summary = E.summary(L.setup, L.state);
      const prevStatus = m.status;
      const status = L.state.status === 'completed' ? 'completed' : L.state.status === 'abandoned' ? 'abandoned' : 'live';
      const set = { eventSeq: L.seq, summary, status, updatedAt: Date.now(), lastEventAt: ev.receivedAt, result: L.state.status === 'completed' ? L.state.result : null };
      if (!m.startedAt) set.startedAt = ev.receivedAt;
      if (status === 'completed' && prevStatus !== 'completed') set.completedAt = Date.now();
      // the PDF of a match that changed after it was made is marked out of date
      // (and remade once the match is complete again)
      if (status !== 'completed' && prevStatus === 'completed') { set.completedAt = null; set.reopenedAt = Date.now(); if (m.report) set['report.stale'] = true; }
      if (status === 'completed' && prevStatus === 'completed' && m.report && m.report.sourceSeq !== L.seq) set['report.stale'] = true;
      await c.matches.updateOne({ matchId: m.matchId }, { $set: set });
      await beat(c, m);
      if (prevStatus === 'scheduled') {
        await c.tournaments.updateOne({ tournamentId: m.tournamentId }, { $set: { rulesLocked: true, status: t.status === 'completed' ? 'completed' : 'ongoing', updatedAt: Date.now() } });
        await audit(c, { action: 'match.start', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user) });
      }
      if (CORRECTION_TYPES.has(ev.type) || ev.override || (ev.type === 'UNDO' && prevStatus === 'completed')) {
        await audit(c, { action: 'event.' + ev.type.toLowerCase(), tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { eventId: ev.eventId, target: ev.target || null, reason: ev.reason || (ev.override && ev.override.reason) || null, patch: ev.patch || null } });
      }
      if (status !== 'completed' && prevStatus === 'completed') await audit(c, { action: 'match.reopen', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { by: ev.type } });
      const entry = L.timeline[L.timeline.length - 1];
      const pubEntry = Object.assign({}, entry); delete pubEntry.by;
      nsp.to(room(m.matchId)).emit('vb:update', { matchId: m.matchId, seq: L.seq, status, summary, entry: pubEntry, event: publicEvent(chk.pending.event), full: !!E.META[ev.type] || !!CORRECTION_TYPES.has(ev.type), at: Date.now() });
      if (m.graphic && m.graphic.scene === 'timeout') afterEventAir(c, m.matchId);
      if (prevStatus !== status || status === 'completed') {
        invalidateStandings(m.tournamentId); invalidateDirectory();
      }
      if (status === 'completed') {
        const done = await loadMatch(c, m.matchId);
        if (prevStatus !== 'completed') await audit(c, { action: 'match.complete', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { result: done.result } });
        afterCompletion(c, done).catch((e) => log('after-completion error', e.message || e));
      }
      return { ok: true, seq: L.seq, summary, entry, status, event: publicEvent(chk.pending.event) };
    });
  }

  app.post('/api/volleyball/matches/:mid/events', requireCreator(async (req, res, user, c) => {
    const r = await submitEvent(c, user, req.params.mid, req.body && req.body.event, req.get('x-vb-lease') || (req.body && req.body.leaseToken));
    res.status(r.ok ? 200 : (r.status || 400)).json(Object.assign({ success: r.ok }, r));
  }));

  app.get('/api/volleyball/matches/:mid/timeline', openRoute(async (req, res, user, c) => {
    const a = await matchAccess(c, user, req.params.mid, req.query.key);
    if (!a.m) return res.status(404).json({ success: false, error: 'Match not found' });
    const L = await getLedger(c, a.m);
    res.json({ success: true, seq: L.seq, timeline: publicTimeline(L, a.manage), summary: E.summary(L.setup, L.state), invalid: L.invalid.map((x) => ({ eventId: x.eventId, seq: x.seq, error: x.invalid.error })) });
  }));

  /* ------------------------------------------------------------ statistics */
  const statsCache = new Map();   // `${matchId}:${seq}:${setupKey}` -> stats
  async function statsOf(c, m) {
    const L = await getLedger(c, m);
    const k = `${m.matchId}:${L.seq}:${ledgers.get(m.matchId) ? ledgers.get(m.matchId).setupKey : ''}`;
    if (statsCache.has(k)) return statsCache.get(k);
    const s = Stats.compute({ state: L.state, timeline: L.timeline, setup: L.setup });
    statsCache.set(k, s);
    while (statsCache.size > 500) statsCache.delete(statsCache.keys().next().value);
    return s;
  }
  app.get('/api/volleyball/matches/:mid/stats', openRoute(async (req, res, user, c) => {
    const a = await matchAccess(c, user, req.params.mid, req.query.key);
    if (!a.m) return res.status(404).json({ success: false, error: 'Match not found' });
    const s = await statsOf(c, a.m);
    const counts = await clipCountsByPlayer(c, a.m);
    res.json({ success: true, stats: s, clipCounts: counts });
  }));

  // Tournament leaderboards: summed from every completed match's ledger.
  app.get('/api/volleyball/tournaments/:tid/stats', openRoute(async (req, res, user, c) => {
    const t = await c.tournaments.findOne({ tournamentId: String(req.params.tid) });
    if (!t || !canView(user, t)) return res.status(404).json({ success: false, error: 'Tournament not found' });
    const ms = await c.matches.find({ tournamentId: t.tournamentId, status: { $in: ['completed', 'live'] } }).toArray();
    const totals = {};
    for (const m of ms) {
      const s = await statsOf(c, m);
      Object.values(s.players).forEach((p) => {
        const sideTeam = m['team' + p.team];
        const o = totals[p.playerId] = totals[p.playerId] || { playerId: p.playerId, name: p.name, number: p.number, teamId: sideTeam ? sideTeam.teamId : null, teamName: sideTeam ? sideTeam.name : '', matches: 0, sets: 0, points: 0, kills: 0, attackErrors: 0, attempts: 0, aces: 0, serviceErrors: 0, blocks: 0, soloBlocks: 0, blockAssists: 0, assists: 0, digs: 0, receptions: 0, receptionErrors: 0 };
        if (p.setsPlayed) o.matches += 1;
        o.sets += p.setsPlayed; o.points += p.points; o.kills += p.attack.kills; o.attackErrors += p.attack.errors; o.attempts += p.attack.attempts;
        o.aces += p.serve.aces; o.serviceErrors += p.serve.errors; o.blocks += p.block.points; o.soloBlocks += p.block.solo; o.blockAssists += p.block.assists;
        o.assists += p.assists; o.digs += p.digs; o.receptions += p.reception.attempts; o.receptionErrors += p.reception.errors;
      });
    }
    const list = Object.values(totals).filter((p) => p.matches > 0).map((p) => Object.assign(p, {
      points: Math.round(p.points * 100) / 100, blocks: Math.round(p.blocks * 100) / 100,
      efficiency: p.attempts ? Math.round((p.kills - p.attackErrors) / p.attempts * 100) / 100 : null
    }));
    res.json({ success: true, players: list, matches: ms.length });
  }));

  /* ------------------------------------------------------------ history / head-to-head */
  async function visibleMatches(c, user, query) {
    const ms = await c.matches.find(Object.assign({ status: 'completed' }, query)).sort({ completedAt: -1 }).limit(200).toArray();
    const tIds = [...new Set(ms.map((m) => m.tournamentId))];
    const ts = tIds.length ? await c.tournaments.find({ tournamentId: { $in: tIds } }).toArray() : [];
    const tById = new Map(ts.map((t) => [t.tournamentId, t]));
    return ms.filter((m) => canView(user, tById.get(m.tournamentId))).map((m) => Object.assign(publicMatch(m, false), { tournamentName: (tById.get(m.tournamentId) || {}).name || '' }));
  }
  app.get('/api/volleyball/teams/:teamId/history', openRoute(async (req, res, user, c) => {
    const id = String(req.params.teamId);
    const team = await c.teams.findOne({ teamId: id });
    if (!team) return res.status(404).json({ success: false, error: 'Team not found' });
    const list = await visibleMatches(c, user, { $or: [{ 'teamA.teamId': id }, { 'teamB.teamId': id }] });
    const tid = req.query.tournamentId ? String(req.query.tournamentId) : null;
    const rec = (arr) => {
      const r = { played: arr.length, won: 0, lost: 0, setsWon: 0, setsLost: 0 };
      arr.forEach((m) => {
        const side = m.teamA.teamId === id ? 'A' : 'B';
        if (m.result && m.result.winner === side) r.won++; else r.lost++;
        r.setsWon += m.result ? m.result.sets[side] : 0;
        r.setsLost += m.result ? m.result.sets[side === 'A' ? 'B' : 'A'] : 0;
      });
      return r;
    };
    res.json({ success: true, team: publicTeam(team), matches: list, allTime: rec(list), tournament: tid ? rec(list.filter((m) => m.tournamentId === tid)) : null });
  }));
  app.get('/api/volleyball/h2h', openRoute(async (req, res, user, c) => {
    const a = String(req.query.teamA || ''), b = String(req.query.teamB || '');
    if (!idOk(a) || !idOk(b)) return res.status(400).json({ success: false, error: 'Choose two teams' });
    const list = await visibleMatches(c, user, { $or: [{ 'teamA.teamId': a, 'teamB.teamId': b }, { 'teamA.teamId': b, 'teamB.teamId': a }] });
    const wins = { [a]: 0, [b]: 0 }, sets = { [a]: 0, [b]: 0 }, points = { [a]: 0, [b]: 0 };
    list.forEach((m) => {
      const sideOf = (id) => (m.teamA.teamId === id ? 'A' : 'B');
      if (m.result) {
        wins[m.result.winner === sideOf(a) ? a : b] += 1;
        sets[a] += m.result.sets[sideOf(a)]; sets[b] += m.result.sets[sideOf(b)];
        (m.result.setScores || []).forEach((s) => { points[a] += s[sideOf(a)]; points[b] += s[sideOf(b)]; });
      }
    });
    res.json({ success: true, matches: list, wins, sets, points });
  }));
  app.get('/api/volleyball/players/:playerId/history', openRoute(async (req, res, user, c) => {
    const pid = String(req.params.playerId);
    if (!idOk(pid)) return res.status(400).json({ success: false });
    const ms = await c.matches.find({ status: { $in: ['completed', 'live'] }, $or: [{ 'squads.A.playerId': pid }, { 'squads.B.playerId': pid }] }).sort({ completedAt: -1 }).limit(100).toArray();
    const tIds = [...new Set(ms.map((m) => m.tournamentId))];
    const ts = tIds.length ? await c.tournaments.find({ tournamentId: { $in: tIds } }).toArray() : [];
    const tById = new Map(ts.map((t) => [t.tournamentId, t]));
    const rows = [];
    for (const m of ms) {
      const t = tById.get(m.tournamentId);
      if (!canView(user, t)) continue;
      const s = await statsOf(c, m);
      const p = s.players[pid];
      if (!p) continue;
      rows.push({ match: publicMatch(m, false), tournamentName: t.name, stats: p });
    }
    const player = await c.players.findOne({ playerId: pid });
    res.json({ success: true, player: player ? { playerId: pid, name: player.name } : { playerId: pid }, matches: rows });
  }));

  /* ------------------------------------------------------------ audit */
  app.get('/api/volleyball/matches/:mid/audit', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false });
    const [entries, events] = await Promise.all([
      c.audit.find({ matchId: m.matchId }).sort({ at: -1 }).limit(500).toArray(),
      c.events.find({ matchId: m.matchId }).sort({ seq: -1 }).limit(1000).toArray()
    ]);
    res.json({ success: true, audit: entries.map(clean), events: events.map(dbEventToEvent) });
  }));

  /* ------------------------------------------------------------ completion: report, knockout */
  async function afterCompletion(c, m) {
    await propagateKnockout(c, m);
    scheduleReport(m.matchId, 'completed');
  }
  async function propagateKnockout(c, m) {
    if (!m.fixtureKey || !m.result) return;
    const key = m.fixtureKey;
    const winSide = m.result.winner, loseSide = winSide === 'A' ? 'B' : 'A';
    const deps2 = await c.matches.find({ tournamentId: m.tournamentId, $or: [{ 'source.A.winnerOf': key }, { 'source.B.winnerOf': key }, { 'source.A.loserOf': key }, { 'source.B.loserOf': key }] }).toArray();
    for (const d of deps2) {
      const set = {};
      for (const side of ['A', 'B']) {
        const src = d.source && d.source[side];
        if (!src) continue;
        const from = src.winnerOf === key ? winSide : src.loserOf === key ? loseSide : null;
        if (!from) continue;
        const teamId = m['team' + from].teamId;
        if (d['team' + side] && d['team' + side].teamId === teamId) continue;
        if (d.status !== 'scheduled') {
          await audit(c, { action: 'knockout.conflict', tournamentId: m.tournamentId, matchId: d.matchId, details: { from: m.matchId, expected: teamId, has: d['team' + side] && d['team' + side].teamId } });
          continue;
        }
        const team = await c.teams.findOne({ teamId });
        if (!team) continue;
        set['team' + side] = teamSnapshot(team);
        set['squads.' + side] = squadOf(team);
      }
      if (Object.keys(set).length) {
        set.updatedAt = Date.now();
        await c.matches.updateOne({ matchId: d.matchId }, { $set: set });
        await audit(c, { action: 'knockout.advance', tournamentId: m.tournamentId, matchId: d.matchId, details: { from: m.matchId } });
      }
    }
  }

  // 📄 PDF reports — one job at a time, never blocking scoring.
  const reportQueue = [];
  const reportQueued = new Set();
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
  async function readLogo(c, teamId) {
    if (!teamId) return null;
    const t = await c.teams.findOne({ teamId });
    return t && t.logo && t.logo.data ? Buffer.from(t.logo.data, 'base64') : null;
  }
  async function generateReport(matchId, reason) {
    const c = await col();
    if (!c) return;
    const m = await loadMatch(c, matchId);
    if (!m || m.status !== 'completed') return;
    if (m.report && m.report.status === 'ready' && m.report.sourceSeq === m.eventSeq && reason !== 'regenerate') return;   // already current
    const version = ((m.report && m.report.version) || 0) + 1;
    // (a whole object when there is none yet — a field of a null `report` cannot be set)
    await c.matches.updateOne({ matchId }, { $set: m.report ? { 'report.status': 'generating', 'report.startedAt': Date.now() } : { report: { status: 'generating', startedAt: Date.now(), version: 0, attempts: 0 } } });
    nsp.to(room(matchId)).emit('vb:report', { matchId, status: 'generating' });
    try {
      const t = await tournamentOf(c, m);
      const L = await getLedger(c, m);
      const stats = await statsOf(c, m);
      const [logoA, logoB, tLogo] = await Promise.all([readLogo(c, m.teamA.teamId), readLogo(c, m.teamB.teamId), Promise.resolve(t && t.logo ? Buffer.from(t.logo.data, 'base64') : null)]);
      const pdf = Report.build({ match: m, tournament: t, ledger: L, stats, logos: { A: logoA, B: logoB, tournament: tLogo }, version, ffmpegPath: deps.ffmpegPath, generatedAt: Date.now() });
      let storage = 'db', url = null, r2Key = null;
      const r2 = deps.r2 && deps.r2();
      if (r2 && r2.client && r2.bucket) {
        r2Key = `volleyball/${m.tournamentId}/${m.matchId}/report-v${version}.pdf`;
        await r2.client.send(new r2.PutObjectCommand({ Bucket: r2.bucket, Key: r2Key, Body: pdf, ContentLength: pdf.length, ContentType: 'application/pdf', CacheControl: 'public, max-age=31536000, immutable' }));
        storage = 'r2'; url = r2.publicUrl ? `${r2.publicUrl}/${r2Key}` : null;
      }
      await c.reports.insertOne({ matchId, tournamentId: m.tournamentId, version, sourceSeq: m.eventSeq, bytes: pdf.length, storage, r2Key, url, data: storage === 'db' ? pdf.toString('base64') : null, reason: reason || 'completed', createdAt: Date.now() });
      await c.matches.updateOne({ matchId }, { $set: { report: { status: 'ready', version, sourceSeq: m.eventSeq, generatedAt: Date.now(), bytes: pdf.length, stale: false, attempts: 0 } } });
      await audit(c, { action: version > 1 ? 'report.regenerate' : 'report.generate', tournamentId: m.tournamentId, matchId, details: { version, bytes: pdf.length, storage, reason } });
      nsp.to(room(matchId)).emit('vb:report', { matchId, status: 'ready', version });
      log(`report v${version} ready for ${matchId} (${pdf.length} bytes, ${storage})`);
    } catch (e) {
      const attempts = ((m.report && m.report.attempts) || 0) + 1;
      await c.matches.updateOne({ matchId }, { $set: { report: Object.assign({}, m.report || { version: 0 }, { status: 'failed', error: String(e.message || e).slice(0, 300), attempts, failedAt: Date.now() }) } });
      nsp.to(room(matchId)).emit('vb:report', { matchId, status: 'failed' });
      log('report generation failed', matchId, e.stack || e);
    }
  }
  // Retry failed / missed reports (a restart mid-generation, R2 down).
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

  app.post('/api/volleyball/matches/:mid/report', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false });
    if (m.status !== 'completed') return res.status(409).json({ success: false, error: 'The report is made when the match is complete' });
    if (m.report) await c.matches.updateOne({ matchId: m.matchId }, { $set: { 'report.attempts': 0 } });
    await audit(c, { action: 'report.request', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user) });
    scheduleReport(m.matchId, 'regenerate');
    res.json({ success: true, status: 'queued' });
  }));
  app.get('/api/volleyball/matches/:mid/report.pdf', openRoute(async (req, res, user, c) => {
    const a = await matchAccess(c, user, req.params.mid, req.query.key);
    if (!a.m) return res.status(404).json({ success: false, error: 'Match not found' });
    const q = req.query.v ? { matchId: a.m.matchId, version: num(req.query.v, 0) } : { matchId: a.m.matchId };
    const rows = await c.reports.find(q).sort({ version: -1 }).limit(1).toArray();
    const r = rows[0];
    if (!r) return res.status(404).json({ success: false, error: a.m.status === 'completed' ? 'The report is being prepared — try again in a moment' : 'The report is made when the match is complete', status: a.m.report ? a.m.report.status : null });
    const name = `${(a.m.teamA && a.m.teamA.name) || 'A'} vs ${(a.m.teamB && a.m.teamB.name) || 'B'} - match report v${r.version}.pdf`.replace(/[^\w .()-]+/g, '');
    if (r.storage === 'r2' && r.url) return res.redirect(302, r.url);
    if (r.storage === 'r2' && r.r2Key && deps.r2 && deps.r2()) {
      const r2 = deps.r2();
      const obj = await r2.client.send(new r2.GetObjectCommand({ Bucket: r2.bucket, Key: r.r2Key }));
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
      return res.send(Buffer.from(await obj.Body.transformToByteArray()));
    }
    if (!r.data) return res.status(404).json({ success: false, error: 'Report file missing' });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
    res.set('Cache-Control', 'no-cache');
    res.send(Buffer.from(r.data, 'base64'));
  }));

  /* ------------------------------------------------------------ clips */
  // The status a person reads, from the most authoritative thing we know.
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
  // How the point was won, as the operator recorded it — the clip's
  // attribution. 'team' = decided: a team point, no player. pending = no
  // one has said yet (it can be assigned later).
  const OPP_ERRORS = { SERVICE_ERROR: 1, ATTACK_ERROR: 1, OPP_ERROR: 1, NET_FAULT: 1, FOUR_HITS: 1, DOUBLE_CONTACT: 1, BALL_OUT: 1, ROTATION_FAULT: 1, PENALTY: 1 };
  function attributionOf(entry) {
    if (!entry || entry.type !== 'RALLY') return { type: null, playerId: null, pending: false };
    const o = entry.outcome, p = entry.players || {};
    const server = entry.rallyServer && entry.rallyServer.team === entry.team ? entry.rallyServer.playerId : null;
    if (o === 'ACE' || o === 'RECEPTION_ERROR') return { type: 'ace', playerId: server || null, pending: false };
    if (o === 'ATTACK_KILL') return { type: 'kill', playerId: p.attacker || null, pending: false };
    if (o === 'BLOCK') return { type: 'block', playerId: (p.blockers || [])[0] || null, pending: false };
    if (OPP_ERRORS[o]) return { type: 'opp_error', playerId: null, pending: false };
    if (p.attacker) return { type: 'kill', playerId: p.attacker, pending: false };
    const decided = !!(entry.corrected && entry.corrected.length);
    return { type: decided ? 'team' : null, playerId: null, pending: !decided };
  }
  function publicClip(clip, entry, participants, m) {
    const sq = (t, id) => (m && m.squads && (m.squads[t] || []).find((x) => x.playerId === id)) || null;
    const team = entry ? entry.team : clip.team || null;
    return {
      clipId: clip.clipId, matchId: clip.matchId, eventId: clip.eventId, status: clip.status, displayStatus: displayStatus(clip),
      local: clip.local || null,
      set: entry && entry.after ? entry.after.set : clip.set || null,
      pointNo: entry ? entry.pointNo || null : clip.pointNo || null,
      team: entry ? entry.team : clip.team || null,
      outcome: entry ? entry.outcome : null,
      scoreAtTrigger: clip.scoreAtTrigger || null,
      scoreNow: entry && entry.after ? entry.after.score : null,
      eventVoided: !!(entry && entry.voided),
      requested: { preRollSec: clip.preRollSec || null, postRollSec: clip.postRollSec || null },
      actual: { durationSec: clip.durationSec || null, preRollSec: clip.actualPreRollSec != null ? clip.actualPreRollSec : null, partialPreRoll: !!clip.partialPreRoll },
      playbackUrl: clip.r2Url && clip.r2Status === 'uploaded' ? clip.r2Url : null,
      watchUrl: clip.r2Url || clip.filePath ? `/api/volleyball/clips/${clip.clipId}/video` : null,
      posterUrl: clip.posterUrl || null,
      r2Status: clip.r2Status || null, driveStatus: clip.driveStatus || null, driveUrl: clip.driveUrl || null,
      players: (participants || []).map((p) => { const x = sq(p.team, p.playerId); return Object.assign({}, p, { name: x ? x.name : null, number: x && x.number != null ? String(x.number) : null }); }),
      attribution: attributionOf(entry),
      teamId: team && m && m['team' + team] ? m['team' + team].teamId || null : null,
      teamName: team && m && m['team' + team] ? m['team' + team].name || null : null,
      engine: clip.engine || null, source: clip.source || null, cutOffline: !!clip.cutOffline,
      eventTimestamp: clip.eventTimestamp || null, windowStart: clip.windowStart || null, windowEnd: clip.windowEnd || null,
      createdAt: clip.createdAt || null, error: clip.error || null
    };
  }
  // A clip belongs to the players its POINT is about (derived from the
  // rally as corrected now), plus anyone the operator linked by hand,
  // minus anyone they unlinked.
  function clipPlayers(clip, entry) {
    const derived = Stats.rallyParticipants(entry).map((p) => ({ playerId: p.playerId, team: p.team, role: p.role, source: 'point' }));
    const manual = (clip.links || []).map((l) => ({ playerId: l.playerId, team: l.team || null, role: l.role || 'linked', source: 'manual' }));
    const excluded = new Set(clip.unlinked || []);
    const seen = new Set();
    return derived.concat(manual).filter((p) => { if (excluded.has(p.playerId) || seen.has(p.playerId)) return false; seen.add(p.playerId); return true; });
  }
  async function clipsOf(c, m, opts) {
    const L = await getLedger(c, m);
    const byEvent = new Map(L.timeline.filter((e) => e.type === 'RALLY').map((e) => [e.eventId, e]));
    const clips = await c.clips.find({ matchId: m.matchId, deleted: { $ne: true } }).sort({ createdAt: 1 }).limit(opts && opts.limit ? opts.limit : 2000).toArray();
    return clips.map((cl) => {
      const entry = byEvent.get(cl.eventId) || null;
      return publicClip(cl, entry, clipPlayers(cl, entry), m);
    });
  }
  async function clipCountsByPlayer(c, m) {
    const list = await clipsOf(c, m);
    const counts = {};
    list.filter((x) => !x.eventVoided).forEach((x) => x.players.forEach((p) => { counts[p.playerId] = (counts[p.playerId] || 0) + 1; }));
    return counts;
  }
  app.get('/api/volleyball/matches/:mid/clips', openRoute(async (req, res, user, c) => {
    const a = await matchAccess(c, user, req.params.mid, req.query.key);
    if (!a.m) return res.status(404).json({ success: false, error: 'Match not found' });
    let list = await clipsOf(c, a.m);
    if (req.query.playerId) {
      const pid = String(req.query.playerId);
      list = list.filter((x) => !x.eventVoided && x.players.some((p) => p.playerId === pid));
    }
    if (req.query.eventId) list = list.filter((x) => x.eventId === String(req.query.eventId));
    res.json({ success: true, clips: list });
  }));

  async function clipWithAccess(c, user, clipId, key) {
    const clip = await c.clips.findOne({ clipId: safeId(clipId) });
    if (!clip) return { status: 404 };
    const a = await matchAccess(c, user, clip.matchId, key || null);
    if (!a.m) return { status: 404 };
    return Object.assign({ clip }, a);
  }

  // The panel / clipper registers each point's clip as soon as the local
  // engine accepted it (or says, honestly, that no clip could be made).
  app.post('/api/volleyball/matches/:mid/clips', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false });
    const b = req.body || {};
    const clipId = safeId(b.clipId);
    if (!clipId.startsWith(m.matchId + '_') || !idOk(b.eventId)) return res.status(400).json({ success: false, error: 'clipId must belong to this match, with its point event' });
    const status = b.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'REQUESTED';
    const local = { status: str(b.localStatus || (status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'WAITING_FOR_POSTROLL'), 32), error: str(b.error, 300) || null, at: Date.now(), engine: str(b.engine, 32) || null };
    const error = status === 'UNAVAILABLE' ? str(b.error, 300) || 'No clip engine was reachable' : null;
    const timing = { eventTimestamp: num(b.t0, Date.now()), preRollSec: num(b.preRollSec, CLIP_PRE_ROLL_SEC), postRollSec: num(b.postRollSec, CLIP_POST_ROLL_SEC), sourceSessionId: str(b.sourceSessionId, 80) || null };
    // The same point can be registered by two devices: the scoring panel
    // (which may have no clip engine — a phone) and the Clipper on the PC
    // that records. "Could not clip it here" never overwrites a clip that
    // is actually being made elsewhere; a real request upgrades it.
    const prev = await c.clips.findOne({ clipId });
    if (!prev) {
      try {
        await c.clips.insertOne(Object.assign({
          clipId, matchId: m.matchId, tournamentId: m.tournamentId, eventId: b.eventId, status, error, local,
          scoreAtTrigger: b.scoreAtTrigger && typeof b.scoreAtTrigger === 'object' ? { A: num(b.scoreAtTrigger.A, 0), B: num(b.scoreAtTrigger.B, 0), set: num(b.scoreAtTrigger.set, null) } : null,
          team: b.team === 'A' || b.team === 'B' ? b.team : null,
          createdAt: Date.now(), retryCount: 0, r2Status: 'pending', driveStatus: 'pending'
        }, timing));
      } catch (e) { if (!(e && e.code === 11000)) throw e; }   // the other device got there first — fine
    } else if (prev.eventId !== b.eventId) {
      return res.status(409).json({ success: false, error: 'That clip belongs to another point' });
    } else if (status === 'REQUESTED' && prev.status === 'UNAVAILABLE') {
      await c.clips.updateOne({ clipId, status: 'UNAVAILABLE' }, { $set: Object.assign({ status: 'REQUESTED', error: null, local }, timing) });
    } else if (status === prev.status && status === 'UNAVAILABLE') {
      await c.clips.updateOne({ clipId, status: 'UNAVAILABLE' }, { $set: { error, local } });
    }
    const doc = await c.clips.findOne({ clipId });
    emitClip(m.matchId, doc);
    res.json({ success: true, clip: { clipId, status: doc.status, displayStatus: displayStatus(doc) } });
  }));
  // Local progress relayed from the operator's PC (the website cannot see it).
  app.post('/api/volleyball/clips/:clipId/local', requireCreator(async (req, res, user, c) => {
    const a = await clipWithAccess(c, user, req.params.clipId);
    if (!a.clip) return res.status(404).json({ success: false });
    if (!a.manage) return res.status(403).json({ success: false });
    const local = { status: str(req.body && req.body.status, 32), error: str(req.body && req.body.error, 300) || null, at: Date.now() };
    await c.clips.updateOne({ clipId: a.clip.clipId }, { $set: { local } });
    emitClip(a.m.matchId, Object.assign({}, a.clip, { local }));
    res.json({ success: true });
  }));
  // Link / unlink players by hand ("this clip also shows the setter").
  app.post('/api/volleyball/clips/:clipId/players', requireCreator(async (req, res, user, c) => {
    const a = await clipWithAccess(c, user, req.params.clipId);
    if (!a.clip) return res.status(404).json({ success: false });
    if (!a.manage) return res.status(403).json({ success: false });
    const squad = new Map([...(a.m.squads.A || []).map((p) => [p.playerId, 'A']), ...(a.m.squads.B || []).map((p) => [p.playerId, 'B'])]);
    const b = req.body || {};
    const links = (Array.isArray(b.links) ? b.links : []).filter((l) => l && squad.has(l.playerId)).slice(0, 12)
      .map((l) => ({ playerId: l.playerId, team: squad.get(l.playerId), role: ['attacker', 'server', 'blocker', 'defender', 'setter', 'receiver', 'linked'].includes(l.role) ? l.role : 'linked' }));
    const unlinked = (Array.isArray(b.unlinked) ? b.unlinked : []).filter((id) => squad.has(id)).slice(0, 12);
    await c.clips.updateOne({ clipId: a.clip.clipId }, { $set: { links, unlinked, linksUpdatedAt: Date.now() } });
    await audit(c, { action: 'clip.links', tournamentId: a.m.tournamentId, matchId: a.m.matchId, by: byOf(user), details: { clipId: a.clip.clipId, links, unlinked, before: { links: a.clip.links || [], unlinked: a.clip.unlinked || [] } } });
    const doc = await c.clips.findOne({ clipId: a.clip.clipId });
    emitClip(a.m.matchId, doc);
    res.json({ success: true });
  }));
  app.post('/api/volleyball/clips/:clipId/retry', requireCreator(async (req, res, user, c) => {
    const a = await clipWithAccess(c, user, req.params.clipId);
    if (!a.clip) return res.status(404).json({ success: false });
    if (!a.manage) return res.status(403).json({ success: false });
    await c.clips.updateOne({ clipId: a.clip.clipId }, { $set: { retryCount: 0, lastRetryAt: 0, status: a.clip.status === 'FAILED_PERMANENT' ? 'RETRY_PENDING' : a.clip.status } });
    await audit(c, { action: 'clip.retry', tournamentId: a.m.tournamentId, matchId: a.m.matchId, by: byOf(user), details: { clipId: a.clip.clipId } });
    // asked for by a person: now, not after the automatic back-off (the
    // sweep waits ~10 s after a clip arrives before its first retry)
    if (a.clip.filePath && fs.existsSync(a.clip.filePath)) setImmediate(() => finishClip(c, a.clip.clipId).catch((e) => log('clip retry error', a.clip.clipId, e.message || e)));
    else setImmediate(() => clipSweep().catch(() => {}));
    res.json({ success: true });
  }));
  // Polled by the Stream Engine / Clipper Helper after forwarding a clip.
  app.get('/api/volleyball/clips/status/:clipId', openRoute(async (req, res, user, c) => {
    const clip = await c.clips.findOne({ clipId: safeId(req.params.clipId) });
    if (!clip) return res.status(404).json({ success: false, error: 'No clip job with that clipId' });
    if (clip.deleted) return res.json({ success: true, clipId: clip.clipId, status: 'DELETED', deleted: true, r2Status: 'uploaded', driveStatus: 'uploaded' });
    // the local engine treats COMPLETE as "both legs done"; a leg that is
    // not configured is done as far as it is concerned
    const leg = (s) => (s === 'not_configured' ? 'uploaded' : s);
    res.json({ success: true, clipId: clip.clipId, status: clip.status === 'SERVER_ONLY' ? 'COMPLETE' : clip.status, r2Status: leg(clip.r2Status), driveStatus: leg(clip.driveStatus), r2Url: clip.r2Url || null, driveUrl: clip.driveUrl || null, retryCount: clip.retryCount || 0 });
  }));
  app.get('/api/volleyball/clips/:clipId/video', openRoute(async (req, res, user, c) => {
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

  /* ---------- the clipping session: which device clips this match ----------
     One device at a time cuts this match's point clips — the PC that
     records (the scoring panel itself, or the Clipper page on that PC,
     with the Clipper Helper next to vMix). It says so here and keeps
     saying how it is doing every few seconds, so every other device can
     show it ("Clipper READY on the vMix PC" on a phone that scores) and a
     second device never clips the same points from another recording. */
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
      counts: { processing: int0(k.processing), failed: int0(k.failed), upload: int0(k.upload), offline: int0(k.offline), done: int0(k.done), unassigned: int0(k.unassigned) },
      online: typeof s.online === 'boolean' ? s.online : null, window: s.window && typeof s.window === 'object' ? { pre: num(s.window.pre, null), post: num(s.window.post, null) } : null
    };
  }
  function publicClipper(k, now) {
    if (!k) return null;
    now = now || Date.now();
    return { sessionId: k.sessionId, label: k.label || 'Clipper', startedAt: k.startedAt || null, lastSeenAt: k.lastSeenAt || null, stoppedAt: k.stoppedAt || null,
      live: !k.stoppedAt && now - (k.lastSeenAt || 0) < CLIPPER_LIVE_MS, status: k.status || null, takenFrom: k.takenFrom || null };
  }
  function emitClipper(m) { nsp.to(room(m.matchId)).emit('vb:clipper', { matchId: m.matchId, clipper: publicClipper(m.clipper) }); }
  app.get('/api/volleyball/matches/:mid/clipper', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'Match not found' });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false });
    res.json({ success: true, clipper: publicClipper(m.clipper) });
  }));
  app.post('/api/volleyball/matches/:mid/clipper', requireCreator(async (req, res, user, c) => {
    const m = await loadMatch(c, req.params.mid);
    if (!m) return res.status(404).json({ success: false, error: 'Match not found' });
    if (!canManage(user, await tournamentOf(c, m))) return res.status(403).json({ success: false });
    const b = req.body || {};
    const sid = safeId(b.sessionId).slice(0, 64);
    if (!sid) return res.status(400).json({ success: false, error: 'sessionId required' });
    const now = Date.now();
    const cur = m.clipper || null;
    const live = !!cur && !cur.stoppedAt && now - (cur.lastSeenAt || 0) < CLIPPER_LIVE_MS;
    const mine = !!cur && cur.sessionId === sid;
    if (b.action === 'start') {
      if (live && !mine && !b.force) return res.status(409).json({ success: false, code: 'CLIPPER_ELSEWHERE', error: `${cur.label || 'Another device'} is clipping this match`, clipper: publicClipper(cur, now) });
      const next = {
        sessionId: sid, label: str(b.label, 60) || 'Clipper', deviceId: str(b.deviceId, 64) || null,
        startedAt: mine && !cur.stoppedAt ? cur.startedAt : now, lastSeenAt: now, stoppedAt: null,
        status: cleanClipperStatus(b.status), takenFrom: live && !mine ? cur.label || 'another device' : null
      };
      await c.matches.updateOne({ matchId: m.matchId }, { $set: { clipper: next } });
      if (!mine || (cur && cur.stoppedAt)) await audit(c, { action: 'clipper.start', tournamentId: m.tournamentId, matchId: m.matchId, by: byOf(user), details: { label: next.label, takenFrom: next.takenFrom } });
      m.clipper = next; emitClipper(m);
      return res.json({ success: true, clipper: publicClipper(next, now) });
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

  // 🎬 THE INGEST — the local clip engine sends the finished point clip.
  // Checked against the match's own clip token (only a device that was
  // given it by a signed-in manager can add clips), stored on disk BEFORE
  // the answer, uploaded afterwards.
  app.post('/api/volleyball/clips/ingest', express.raw({ type: '*/*', limit: '80mb' }), async (req, res) => {
    const c = await col();
    if (!c) return dbDown(res);
    const matchId = safeId(req.query.matchId);
    const clipId = safeId(req.query.clipId);
    if (!matchId || !clipId || !clipId.startsWith(matchId + '_')) return res.status(400).json({ success: false, error: 'matchId and a clipId of that match are required' });
    if (!req.body || !req.body.length) return res.status(400).json({ success: false, error: 'Empty clip body' });
    let meta = {}, clipMeta = {};
    try { meta = JSON.parse(req.headers['x-ball-meta'] || '{}') || {}; } catch (e) { meta = {}; }
    try { clipMeta = JSON.parse(req.headers['x-clip-meta'] || '{}') || {}; } catch (e) { clipMeta = {}; }
    const m = await loadMatch(c, matchId);
    if (!m) return res.status(404).json({ success: false, error: 'No such volleyball match' });
    if (!sameSecret(meta.vbClipToken, m.clipToken)) return res.status(403).json({ success: false, error: 'This clip does not carry the match’s clip token' });
    const existing = await c.clips.findOne({ clipId });
    if (existing && existing.deleted) return res.json({ success: true, clipId, status: 'DELETED', deleted: true });
    const dir = path.join(CLIPS_DIR, 'volleyball', matchId);
    const file = path.join(dir, `${clipId}.mp4`);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(file, req.body);
    } catch (e) {
      return res.status(500).json({ success: false, clipId, error: 'Could not store the clip: ' + (e.message || e) });
    }
    const eventId = idOk(meta.eventId) ? meta.eventId : (existing && existing.eventId) || null;
    const durationSec = await probeDuration(file);
    // the Clipper Helper sends everything in X-Ball-Meta (one header — see
    // clipper-helper/server.js); the Stream Engine's X-Clip-Meta still works
    const cm = (k) => (clipMeta[k] != null ? clipMeta[k] : meta[k]);
    const reqPre = num(cm('preRollSec'), CLIP_PRE_ROLL_SEC);
    const actualPre = cm('actualPreRollSec') != null ? num(cm('actualPreRollSec'), null) : null;
    const recName = str(String(meta.sourceRecording || '').split(/[\\/]/).pop(), 120) || null;   // a file name, never a path
    const set = {
      filePath: file, status: 'LOCAL_RECEIVED', lastReceivedAt: Date.now(), retryCount: 0, bytes: req.body.length,
      durationSec, actualPreRollSec: actualPre, partialPreRoll: actualPre != null ? actualPre < reqPre - 0.5 : !!cm('partialPreRoll'),
      windowStart: num(cm('windowStart'), null), windowEnd: num(cm('windowEnd'), null),
      source: recName || meta.sourceStartSec != null ? { recording: recName, startSec: num(meta.sourceStartSec, null), endSec: num(meta.sourceEndSec, null) } : null,
      engine: meta.engine === 'clipper-helper' ? 'clipper-helper' : (existing && existing.engine) || 'stream-engine',
      cutOffline: !!meta.cutOffline,
      r2Status: existing && existing.r2Status === 'uploaded' ? 'uploaded' : 'pending',
      driveStatus: existing && existing.driveStatus === 'uploaded' ? 'uploaded' : 'pending'
    };
    await c.clips.updateOne({ clipId }, {
      $set: set,
      $unset: { error: '' },
      $setOnInsert: {
        clipId, matchId, tournamentId: m.tournamentId, eventId, createdAt: Date.now(),
        eventTimestamp: num(req.query.timestamp, num(meta.t0, null)), preRollSec: reqPre, postRollSec: num(cm('postRollSec'), CLIP_POST_ROLL_SEC),
        scoreAtTrigger: meta.score && typeof meta.score === 'object' ? { A: num(meta.score.A, 0), B: num(meta.score.B, 0), set: num(meta.set, null) } : null,
        team: meta.team === 'A' || meta.team === 'B' ? meta.team : null, sourceSessionId: str(meta.sourceSessionId || clipMeta.sessionId, 80) || null
      }
    }, { upsert: true });
    res.json({ success: true, clipId, status: 'LOCAL_RECEIVED', durationSec });
    finishClip(c, clipId).catch((e) => log('clip finish error', clipId, e.message || e));
  });

  function probeDuration(file) {
    return new Promise((resolve) => {
      if (!deps.ffmpegPath) return resolve(null);
      let err = '';
      let p;
      try { p = spawn(deps.ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { return resolve(null); }
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 8000);
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', () => { clearTimeout(timer); resolve(null); });
      p.on('close', () => {
        clearTimeout(timer);
        const mm = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
        resolve(mm ? Math.round((+mm[1] * 3600 + +mm[2] * 60 + +mm[3]) * 100) / 100 : null);
      });
    });
  }

  async function clipKey(c, clip) {
    const m = await loadMatch(c, clip.matchId);
    let set = 0, pointNo = 0;
    if (m) {
      const L = await getLedger(c, m);
      const e = L.timeline.find((x) => x.eventId === clip.eventId);
      if (e && e.after) { set = e.after.set || 0; pointNo = e.pointNo || 0; }
    }
    return `volleyball/${clip.tournamentId}/${clip.matchId}/set-${set}/point-${pointNo}-${clip.clipId}.mp4`;
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
  async function uploadPosterR2(c, clip, posterPath) {
    const r2 = deps.r2 && deps.r2();
    if (!r2 || !r2.client || !r2.bucket || !posterPath) return;
    try {
      const key = (clip.r2Key || await clipKey(c, clip)).replace(/\.mp4$/, '.jpg');
      const body = await fs.promises.readFile(posterPath);
      await r2.client.send(new r2.PutObjectCommand({ Bucket: r2.bucket, Key: key, Body: body, ContentLength: body.length, ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000, immutable' }));
      if (r2.publicUrl) await c.clips.updateOne({ clipId: clip.clipId }, { $set: { posterUrl: `${r2.publicUrl}/${key}` } });
    } catch (e) { /* a poster is best effort */ }
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
  // Uploads whatever is configured; the server's copy goes only when every
  // configured destination has it. With no cloud storage at all the clip
  // stays here (SERVER_ONLY) — never deleted, never reported as uploaded.
  async function finishClip(c, clipId) {
    let clip = await c.clips.findOne({ clipId });
    if (!clip || !clip.filePath || !fs.existsSync(clip.filePath)) return;
    if (!clip.optimizedAt && deps.clipMedia) {
      const poster = `${clip.filePath}.poster.jpg`;
      const o = await deps.clipMedia.optimizeClipFile(clip.filePath, { ffmpegPath: deps.ffmpegPath, posterPath: poster, log: () => {} }).catch(() => ({}));
      await c.clips.updateOne({ clipId }, { $set: { optimizedAt: Date.now() } });
      if (o && o.posterPath) { await uploadPosterR2(c, clip, o.posterPath); fs.unlink(o.posterPath, () => {}); }
    }
    clip = await c.clips.findOne({ clipId });
    const [r2, drive] = await Promise.all([uploadClipR2(c, clip), uploadClipDrive(c, clip)]);
    const legs = [r2, drive];
    let status;
    if (legs.every((x) => x === 'not_configured')) status = 'SERVER_ONLY';
    else if (legs.some((x) => x === 'failed')) status = 'RETRY_PENDING';
    else status = 'COMPLETE';
    await c.clips.updateOne({ clipId }, { $set: { status } });
    const done = await c.clips.findOne({ clipId });
    if (status === 'COMPLETE' && legs.includes('uploaded')) {
      fs.unlink(clip.filePath, () => {});
      await c.clips.updateOne({ clipId }, { $set: { filePath: null } });
    }
    emitClip(clip.matchId, done);
  }
  async function clipSweep() {
    const c = C;
    if (!c) return;
    const due = await c.clips.find({ status: { $in: ['RETRY_PENDING', 'LOCAL_RECEIVED'] }, retryCount: { $lt: CLIP_MAX_RETRIES } }).limit(20).toArray();
    for (const clip of due) {
      const last = Math.max(clip.lastRetryAt || 0, clip.lastReceivedAt || 0);
      if (Date.now() < last + Math.min(10000 * Math.pow(1.6, clip.retryCount || 0), 15 * 60000)) continue;
      if (!clip.filePath || !fs.existsSync(clip.filePath)) {
        await c.clips.updateOne({ clipId: clip.clipId }, { $set: { status: 'NEEDS_REUPLOAD', error: 'The website’s copy is gone — the clip engine will send it again' } });
        continue;
      }
      await c.clips.updateOne({ clipId: clip.clipId }, { $set: { lastRetryAt: Date.now() }, $inc: { retryCount: 1 } });
      await finishClip(c, clip.clipId);
      const after = await c.clips.findOne({ clipId: clip.clipId });
      if (after.status === 'RETRY_PENDING' && (after.retryCount || 0) >= CLIP_MAX_RETRIES) {
        await c.clips.updateOne({ clipId: clip.clipId }, { $set: { status: 'FAILED_PERMANENT', error: `Upload failed ${after.retryCount} times (R2 ${after.r2Status}, Drive ${after.driveStatus}) — the file is kept` } });
      }
    }
  }
  setInterval(() => { clipSweep().catch((e) => log('clip sweep error', e.message || e)); }, CLIP_RETRY_INTERVAL_MS).unref();

  /* ------------------------------------------------------------ meta / config */
  app.get('/api/volleyball/config', (req, res) => {
    res.json({
      success: true, rules: E.normalizeRules({}), outcomes: E.OUTCOMES, sanctions: E.SANCTIONS, roles: E.ROLES, replayReasons: E.REPLAY_REASONS,
      policies: Standings.POLICIES, criteria: Standings.CRITERIA, tiebreakPresets: Standings.TIEBREAK_PRESETS,
      clip: { preRollSec: CLIP_PRE_ROLL_SEC, postRollSec: CLIP_POST_ROLL_SEC }, leaseTtlMs: LEASE_TTL_MS
    });
  });
  // Clock for devices that must agree on WHEN a point was pressed (a
  // clipper on another PC turns the press time into its own clock).
  app.get('/api/volleyball/time', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ now: Date.now() }); });

  /* ------------------------------------------------------------ pages */
  const page = (file) => (req, res) => deps.sendHtmlNoCache(res, path.join(deps.rootDir, file));
  app.get('/volleyball', page('volleyball.html'));
  app.get('/volleyball-templates', page('volleyball-templates.html'));
  app.get('/volleyball-panel', page('volleyball-panel.html'));
  app.get('/volleyball-overlay', page('volleyball-overlay.html'));
  app.get('/volleyball-clipper', page('volleyball-clipper.html'));
  app.get('/volleyball-live-output', page('volleyball-live-output.html'));
  app.get('/volleyball/tournament/:tid', page('volleyball-tournament.html'));
  app.get('/volleyball/match/:mid', page('volleyball-scorecard.html'));

  /* ------------------------------------------------------------ sockets */
  const nsp = io.of('/volleyball');
  const room = (matchId) => 'm:' + matchId;
  function emitClip(matchId, doc) {
    if (!doc) return;
    nsp.to(room(matchId)).emit('vb:clip', { matchId, clip: { clipId: doc.clipId, eventId: doc.eventId, status: doc.status, displayStatus: displayStatus(doc), local: doc.local || null, durationSec: doc.durationSec || null, partialPreRoll: !!doc.partialPreRoll } });
  }
  function broadcastMatchDoc(m) {
    if (!m) return;
    nsp.to(room(m.matchId)).emit('vb:match', { matchId: m.matchId, match: publicMatch(m, false) });
  }
  const troom = (tournamentId) => 't:' + tournamentId;

  /* ---------- on-air graphics (see volleyball-graphics.js) ----------
     One state per match, kept on the match: an overlay that reloads, a
     vMix that restarts, or this server coming back up all pick up what is
     on air. The server ends a timed graphic itself (a timer, and on every
     read for one that ran out while it was down); commands for one match
     run one after another, and one aimed at a graphic that has since been
     replaced is refused as stale. */
  let airSeq = Date.now();                 // only ever goes up — across restarts too
  const nextAirSeq = () => ++airSeq;
  const airTimers = new Map();             // matchId -> the timer that ends the timed graphic on air
  const airChains = new Map();             // matchId -> its queue of graphic commands
  function airSerial(matchId, fn) {
    const run = (airChains.get(matchId) || Promise.resolve()).then(fn, fn);
    const tail = run.then(() => {}, () => {});
    airChains.set(matchId, tail);
    tail.then(() => { if (airChains.get(matchId) === tail) airChains.delete(matchId); });
    return run;
  }
  // the state as saved (one from before this kind of state existed is simply "nothing on air")
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
    nsp.to(room(m.matchId)).emit('vb:graphic', { matchId: m.matchId, graphic: G.publicState(next, Date.now()) });
    return next;
  }
  function armAir(c, matchId, g) {
    clearTimeout(airTimers.get(matchId));
    airTimers.delete(matchId);
    if (!g || !g.scene || g.expiresAt == null) return;
    const timer = setTimeout(() => {
      airTimers.delete(matchId);
      airSerial(matchId, async () => {
        const m = await loadMatch(c, matchId);
        const cur = airOf(m);
        if (!m || cur.id !== g.id || cur.seq !== g.seq) return;   // stopped, replaced or changed since
        const ended = G.settle(cur, Date.now(), nextAirSeq);
        if (ended) await setAir(c, m, ended); else armAir(c, matchId, cur);
      }).catch((e) => log('graphic timer error', e.message || e));
    }, Math.max(0, g.expiresAt - Date.now()) + 15);
    if (timer.unref) timer.unref();
    airTimers.set(matchId, timer);
  }
  // what is on air now — a timed graphic that ran out is ended (and said so)
  async function currentAir(c, m) {
    const cur = airOf(m);
    if (!cur.scene || cur.expiresAt == null) return cur;
    if (Date.now() < cur.expiresAt) { if (!airTimers.has(m.matchId)) armAir(c, m.matchId, cur); return cur; }
    return airSerial(m.matchId, async () => {
      const fresh = await loadMatch(c, m.matchId);
      const now = airOf(fresh);
      const ended = G.settle(now, Date.now(), nextAirSeq);
      return ended ? setAir(c, fresh, ended) : now;
    });
  }
  // what a graphic needs from the match, checked before it goes on air
  async function sceneContext(c, m, t, scene) {
    const L = await getLedger(c, m);
    const ctx = { m, t, L, st: L.state, s: E.summary(L.setup, L.state) };
    if (scene === 'standings') {
      const [teams, matches] = await Promise.all([c.teams.find({ teamId: { $in: t.teamIds || [] } }).toArray(), c.matches.find({ tournamentId: t.tournamentId }).toArray()]);
      ctx.standings = standingsOf(t, teams, matches);
    }
    return ctx;
  }
  // { error } when the match has nothing true to show yet, else { data } as it will be shown
  function sceneCheck(scene, data, ctx) {
    const { m, st, s, L } = ctx;
    const name = (side) => (m['team' + side] && m['team' + side].name) || 'Team ' + side;
    if (!m.teamA || !m.teamB) return { error: 'Both teams must be known first' };
    const started = st.sets.length > 0;
    switch (scene) {
      case 'intro': return { data: {} };
      case 'toss': {
        const last = st.rules.bestOf;
        const set = data.set || (last > 1 && st.tosses[last] && (s.nextDeciding || s.deciding || st.sets.length >= last) ? last : 1);
        if (!st.tosses[set]) return { error: set === 1 ? 'No toss recorded yet — record the toss in the panel first' : 'The deciding-set toss is not recorded yet' };
        return { data: { set } };
      }
      case 'lineup': {
        const set = data.set || (s.status === 'in_set' ? s.set : (s.nextSet || st.sets.length || 1));
        const lu = st.lineups[set] || {};
        const want = data.team ? [data.team] : ['A', 'B'];
        const missing = want.filter((x) => !(Array.isArray(lu[x]) && lu[x].length === 6));
        if (missing.length) return { error: `${missing.map(name).join(' and ')}: no starting six saved for set ${set} yet` };
        return { data: data.team ? { set, team: data.team } : { set } };
      }
      case 'setStart': {
        if (s.status === 'completed' || s.status === 'abandoned') return { error: 'The match is over' };
        const set = s.status === 'in_set' ? s.set : (s.nextSet || 1);
        if (data.set && data.set !== set) return { error: `Set ${set} is the one being played next` };
        return { data: { set } };
      }
      case 'rotation':
        if (s.status !== 'in_set' || !s.positions) return { error: 'The rotation shows while a set is being played' };
        return { data: {} };
      case 'timeout': {
        if (s.status !== 'in_set') return { error: 'No time-out is running' };
        const to = G.runningTimeout(L.timeline, st.rules, Date.now());
        if (!to) return { error: 'No time-out is running' };
        return { data: { team: to.team || null, technical: !!to.technical, at: to.at }, untilAt: to.endsAt };
      }
      case 'playerStat': {
        const all = [].concat((m.squads && m.squads.A) || [], (m.squads && m.squads.B) || []);
        if (!data.playerId || !all.some((p) => p.playerId === data.playerId)) return { error: 'Choose a player from either squad' };
        return { data: { playerId: data.playerId } };
      }
      case 'setSummary': {
        const done = st.sets.filter((x) => x.status === 'completed');
        if (!done.length) return { error: 'No set has finished yet' };
        const set = data.set || done[done.length - 1].number;
        if (!done.some((x) => x.number === set)) return { error: `Set ${set} has not finished` };
        return { data: { set } };
      }
      case 'final':
      case 'scorecard':
        if (!started) return { error: 'The match has not started yet' };
        return { data: {} };
      case 'standings': {
        const sd = ctx.standings;
        const groups = sd && !sd.knockoutOnly ? (sd.groups || []).filter((g) => g.rows && g.rows.length) : [];
        if (!groups.length) return { error: sd && sd.knockoutOnly ? 'A knockout tournament has no points table' : 'No points table for this tournament' };
        const ids = [m.teamA.teamId, m.teamB.teamId];
        const g = (data.group && groups.find((x) => x.name === data.group)) || groups.find((x) => x.rows.some((r) => ids.includes(r.teamId))) || groups[0];
        return { data: g.name ? { group: g.name } : {} };
      }
      default: return { error: 'Unknown graphic' };
    }
  }
  // After a scoring event: a time-out graphic goes when play is back on
  // (or the time-out was undone) — the live score returns for the rally.
  function afterEventAir(c, matchId) {
    return airSerial(matchId, async () => {
      const m = await loadMatch(c, matchId);
      const cur = airOf(m);
      if (!m || cur.scene !== 'timeout') return;
      const L = await getLedger(c, m);
      if (L.state.status === 'in_set' && G.runningTimeout(L.timeline, L.state.rules, Date.now())) return;
      const r = G.applyCommand(cur, { action: 'stop', id: cur.id, reason: 'play-resumed' }, { nextSeq: nextAirSeq }, Date.now());
      if (r.ok && r.next) await setAir(c, m, r.next);
    }).catch((e) => log('graphic after-event error', e.message || e));
  }
  // timed graphics of matches whose timer this process never armed (a restart)
  async function graphicSweep() {
    const c = await col();
    if (!c) return;
    const ms = await c.matches.find({ 'graphic.expiresAt': { $gt: 0 } }).toArray();
    for (const m of ms) await currentAir(c, m).catch(() => {});
  }
  setTimeout(() => { graphicSweep().catch(() => {}); }, 3000).unref();
  setInterval(() => { graphicSweep().catch((e) => log('graphic sweep error', e.message || e)); }, 60 * 1000).unref();

  nsp.on('connection', (socket) => {
    socket.data.user = null;
    const authed = (async () => {
      const tok = socket.handshake.auth && socket.handshake.auth.idToken;
      if (!tok) return null;
      const d = await auth.verifyIdTokenFull(tok);
      socket.data.user = d && d.uid ? userOf(d) : null;
      return socket.data.user;
    })().catch(() => null);
    const ack = (fn) => (typeof fn === 'function' ? fn : () => {});

    socket.on('vb:auth', async (d, fn) => {
      const reply = ack(fn);
      try {
        const dec = await auth.verifyIdTokenFull(d && d.idToken);
        socket.data.user = dec && dec.uid ? userOf(dec) : socket.data.user;
        reply({ ok: !!socket.data.user });
      } catch (e) { reply({ ok: false }); }
    });

    socket.on('vb:join', async (d, fn) => {
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
        reply({ ok: true, match: Object.assign(publicMatch(a.m, a.manage), { graphic }), summary: E.summary(L.setup, L.state), seq: L.seq, timeline: d && d.timeline ? publicTimeline(L, a.manage) : undefined,
          events: a.manage && d && d.events ? L.events.map(publicEvent) : undefined, graphic, style: G.normalizeStyle(a.t && a.t.broadcast), photos: await photosOf(c, a.m), now: Date.now() });
      } catch (e) { log('join error', e.message || e); reply({ ok: false, error: 'join-failed' }); }
    });

    socket.on('vb:sync', async (d, fn) => {
      const reply = ack(fn);
      try {
        await authed;
        const c = await col();
        const a = await matchAccess(c, socket.data.user, d && d.matchId, d && d.key);
        if (!a.m) return reply({ ok: false, error: 'not-found' });
        const L = await getLedger(c, a.m);
        const graphic = G.publicState(await currentAir(c, a.m), Date.now());
        reply({ ok: true, match: Object.assign(publicMatch(a.m, a.manage), { graphic }), seq: L.seq, summary: E.summary(L.setup, L.state), timeline: publicTimeline(L, a.manage),
          events: a.manage ? L.events.map(publicEvent) : undefined, graphic, style: G.normalizeStyle(a.t && a.t.broadcast), invalid: L.invalid.map((x) => ({ eventId: x.eventId, error: x.invalid.error })), now: Date.now() });
      } catch (e) { reply({ ok: false, error: 'sync-failed' }); }
    });

    socket.on('vb:event', async (d, fn) => {
      const reply = ack(fn);
      try {
        const user = await authed || socket.data.user;
        if (!user || !user.isCreator) return reply({ ok: false, code: 'LOGIN_REQUIRED', error: 'Sign in with an authorised account' });
        const c = await col();
        if (!c) return reply({ ok: false, code: 'DB', error: 'The database is not available', retry: true });
        reply(await submitEvent(c, user, d && d.matchId, d && d.event, d && d.leaseToken));
      } catch (e) {
        log('event error', e.stack || e);
        reply({ ok: false, code: 'SERVER', error: 'Not saved — try again', retry: true });
      }
    });

    socket.on('vb:lease:heartbeat', async (d, fn) => {
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

    // take / stop / live / clean / next / duration — see applyCommand in volleyball-graphics.js
    socket.on('vb:graphic', async (d, fn) => {
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
        const r = await airSerial(m0.matchId, async () => {
          const m = await loadMatch(c, m0.matchId);
          let cur = airOf(m);
          const ended = G.settle(cur, Date.now(), nextAirSeq);
          if (ended) cur = await setAir(c, m, ended);
          const scene = (!d.action || d.action === 'take') && G.SCENES[d.scene] ? d.scene : null;
          const ctx = scene ? await sceneContext(c, m, t, scene) : null;
          const out = G.applyCommand(cur, d, { style: t && t.broadcast, nextSeq: nextAirSeq, check: ctx ? (sc, data) => sceneCheck(sc, data, ctx) : null }, Date.now());
          if (out.ok && out.next) cur = await setAir(c, m, out.next);
          return Object.assign({}, out, { graphic: G.publicState(cur, Date.now()) });
        });
        reply(r.ok ? { ok: true, same: !!r.same, graphic: r.graphic } : { ok: false, error: r.error, stale: !!r.stale, graphic: r.graphic });
      } catch (e) { log('graphic error', e.stack || e); reply({ ok: false, error: 'Could not change the graphic — try again' }); }
    });
  });

  return {
    col, submitEvent, getLedger, scheduleReport, generateReport, clipSweep, reportSweep, statsOf,
    _test: { sanitizeEvent, displayStatus, LEASE_TTL_MS }
  };
};
