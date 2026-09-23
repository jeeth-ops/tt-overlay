// ================================================================
// 👥 PLAYER HELPER — a second person on a phone picks player NAMES for
// the operator (new batsman, bowler, caught by, keeper, …). The phone
// never controls scoring: its answer only appears in the operator's
// Player Helper tab, and the operator applies it in the panel.
//
//   operator  /player-helper?room=<roomId>   (knows the room, like the panel)
//   phone     /ph/<token>                    (random token → one match room)
//
// Isolation:
// • Phones use their own Socket.IO namespace (/player-helper) and never
//   join the match room, so they never receive the panel's full state.
// • A token maps to exactly one match room; answers go only to that
//   room's operators.
// Identity:
// • The phone gets names plus an opaque per-link ref (HMAC of token +
//   player id). No player/team/DB ids are ever sent to it. A submit is
//   resolved back to the exact player (id + team) from the CURRENT state,
//   and only among players valid for that request — two players with the
//   same name stay two different players.
// ================================================================
const crypto = require('crypto');

const REQUESTS = {
  STRIKER:           { label: 'Striker',            side: 'bat',  pick: 'available' },
  NON_STRIKER:       { label: 'Non-Striker',        side: 'bat',  pick: 'available' },
  NEW_BATSMAN:       { label: 'New Batsman',        side: 'bat',  pick: 'incoming' },
  BOWLER:            { label: 'Bowler',             side: 'bowl', pick: 'all' },
  NEW_BOWLER:        { label: 'New Bowler',         side: 'bowl', pick: 'all' },
  DISMISSED_BATSMAN: { label: 'Dismissed Batsman',  side: 'bat',  pick: 'atCrease' },
  CAUGHT_BY:         { label: 'Caught By',          side: 'bowl', pick: 'all' },
  FIELDER:           { label: 'Fielder (Run Out)',  side: 'bowl', pick: 'all' },
  WICKETKEEPER:      { label: 'Wicketkeeper',       side: 'bowl', pick: 'keeper' },
};
const ORDER = ['NEW_BATSMAN', 'NEW_BOWLER', 'CAUGHT_BY', 'WICKETKEEPER', 'FIELDER', 'DISMISSED_BATSMAN', 'STRIKER', 'NON_STRIKER', 'BOWLER'];

function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function setup({ app, io, getRoomState, getCollection }) {
  const links = new Map();        // token -> roomId
  const tokenOfRoom = new Map();  // roomId -> token
  const results = new Map();      // roomId -> [result] (newest last, max 40)
  const requests = new Map();     // roomId -> { type, at } | null
  const lastView = new Map();     // roomId -> json sent to phones
  const ns = io.of('/player-helper');

  const safeRoom = (r) => String(r || '').replace(/^room-/, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);

  async function tokenForRoom(roomId) {
    if (tokenOfRoom.has(roomId)) return tokenOfRoom.get(roomId);
    const coll = getCollection();
    if (coll) {
      const doc = await coll.findOne({ roomId }).catch(() => null);
      if (doc) { links.set(doc.token, roomId); tokenOfRoom.set(roomId, doc.token); return doc.token; }
    }
    const token = crypto.randomBytes(12).toString('base64url');
    links.set(token, roomId); tokenOfRoom.set(roomId, token);
    if (coll) await coll.insertOne({ token, roomId, createdAt: Date.now() }).catch(() => {});
    return token;
  }
  async function roomForToken(token) {
    token = String(token || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!token) return null;
    if (links.has(token)) return links.get(token);
    const coll = getCollection();
    if (coll) {
      const doc = await coll.findOne({ token }).catch(() => null);
      if (doc) { links.set(token, doc.roomId); tokenOfRoom.set(doc.roomId, token); return doc.roomId; }
    }
    return null;
  }

  // ---- player lists from the panel's own state (the source of truth) ----
  function teamPlayers(cs, key) {
    const t = cs[key === 'A' ? 'teamA' : 'teamB'] || {};
    const roster = (t.players || []).filter((p) => p && p.name && p.isXI !== false).map((p) => ({ id: String(p.id || 'name:' + norm(p.name)), name: String(p.name) }));
    if (roster.length) return roster;
    // No squad entered: fall back to every name this side has used so far.
    const seen = new Map();
    const add = (p) => { if (p && p.name && !seen.has(norm(p.name))) seen.set(norm(p.name), { id: String(p.id || 'name:' + norm(p.name)), name: String(p.name) }); };
    const batting = cs.battingTeam === key;
    ((cs.battingCard || {})[key] || []).forEach(add);
    ((cs.bowlingCard || {})[key] || []).forEach(add);
    if (batting) { add(cs.striker); add(cs.nonStriker); } else add(cs.bowler);
    return [...seen.values()];
  }
  function outThisInnings(cs, key) {
    const inn = cs.inningsNumber || 1;
    const out = new Set();
    ((cs.battingCard || {})[key] || []).forEach((b) => {
      if (b && (b.inningsNo || 1) === inn && b.out && !b.retiredHurt) { out.add(norm(b.name)); if (b.id) out.add('id:' + b.id); }
    });
    return out;
  }
  const isOut = (set, p) => set.has(norm(p.name)) || set.has('id:' + p.id);
  const sameAs = (p, q) => q && q.name && ((q.id && String(q.id) === p.id) || norm(q.name) === norm(p.name));

  function listFor(cs, type) {
    const r = REQUESTS[type];
    const bat = cs.battingTeam === 'B' ? 'B' : 'A';
    const key = r.side === 'bat' ? bat : (bat === 'A' ? 'B' : 'A');
    let list = teamPlayers(cs, key);
    let note = null;
    if (r.pick === 'available' || r.pick === 'incoming') {
      const out = outThisInnings(cs, key);
      list = list.filter((p) => !isOut(out, p));
      if (r.pick === 'incoming') list = list.filter((p) => !sameAs(p, cs.striker) && !sameAs(p, cs.nonStriker));
    } else if (r.pick === 'atCrease') {
      list = list.filter((p) => sameAs(p, cs.striker) || sameAs(p, cs.nonStriker));
      if (!list.length) list = [cs.striker, cs.nonStriker].filter((p) => p && p.name).map((p) => ({ id: String(p.id || 'name:' + norm(p.name)), name: String(p.name) }));
    } else if (r.pick === 'keeper') {
      const t = cs[key === 'A' ? 'teamA' : 'teamB'] || {};
      const wk = list.filter((p) => t.wkId && p.id === String(t.wkId));
      if (wk.length) list = wk; else note = 'Wicketkeeper not marked in the squad — all players shown';
    }
    return { key, list, note };
  }

  const refOf = (token, key, id) => crypto.createHmac('sha256', token).update(key + ':' + id).digest('base64url').slice(0, 12);

  function teamCard(cs, key) {
    const t = cs[key === 'A' ? 'teamA' : 'teamB'] || {};
    return { name: t.name || '', short: t.short || '', color: /^#[0-9a-f]{3,8}$/i.test(t.color || '') ? t.color : '', logo: typeof t.logoUrl === 'string' && /^(data:image\/|https:\/\/)/.test(t.logoUrl) ? t.logoUrl : '' };
  }

  // What a phone sees: names, team cards, request lists. Nothing else.
  function mobileView(roomId, token, cs) {
    if (!cs || !cs.teamA || !cs.teamB) return { ready: false };
    const bat = cs.battingTeam === 'B' ? 'B' : 'A';
    const bowl = bat === 'A' ? 'B' : 'A';
    const lists = {};
    for (const type of ORDER) {
      const { key, list, note } = listFor(cs, type);
      lists[type] = { label: REQUESTS[type].label, team: key === bat ? 'batting' : 'bowling', note, players: list.map((p) => ({ ref: refOf(token, key, p.id), name: p.name })) };
    }
    const req = requests.get(roomId);
    return {
      ready: true,
      match: `${teamCard(cs, 'A').name || 'Team A'} vs ${teamCard(cs, 'B').name || 'Team B'}`,
      innings: cs.inningsNumber || 1,
      batting: teamCard(cs, bat),
      bowling: teamCard(cs, bowl),
      order: ORDER,
      lists,
      request: req ? { type: req.type, label: REQUESTS[req.type].label, at: req.at } : null,
    };
  }

  async function pushView(roomId) {
    const token = tokenOfRoom.get(roomId);
    if (!token) return;
    const phones = ns.adapter.rooms.get('ph:' + roomId);
    if (!phones || !phones.size) return;
    const state = await getRoomState('room-' + roomId);
    const view = mobileView(roomId, token, state && state.cricketState);
    const json = JSON.stringify(view);
    if (lastView.get(roomId) === json) return; // nothing a phone can see changed
    lastView.set(roomId, json);
    ns.to('ph:' + roomId).emit('view', view);
  }

  // Called by server.js on every cricket state update of a room.
  function onCricketUpdate(room) {
    const roomId = safeRoom(room);
    if (tokenOfRoom.has(roomId)) pushView(roomId).catch(() => {});
  }

  // ---- HTTP ----
  app.post('/api/player-helper/link', async (req, res) => {
    const roomId = safeRoom(req.body && req.body.roomId);
    if (!roomId) return res.status(400).json({ success: false, error: 'roomId required' });
    const token = await tokenForRoom(roomId);
    res.json({ success: true, token, path: `/ph/${token}` });
  });

  // ---- Socket.IO (/player-helper) ----
  ns.on('connection', async (socket) => {
    // Namespace params travel in `auth` (a page's namespaces share one
    // connection, so `query` would be the first namespace's); query kept as fallback.
    const q = Object.assign({}, socket.handshake.query || {}, socket.handshake.auth || {});
    if (q.role === 'operator') {
      const roomId = safeRoom(q.room);
      if (!roomId) return socket.disconnect(true);
      socket.join('op:' + roomId);
      const token = await tokenForRoom(roomId);
      const req = requests.get(roomId);
      socket.emit('operatorInit', { token, path: `/ph/${token}`, results: results.get(roomId) || [], request: req ? { type: req.type, label: REQUESTS[req.type].label, at: req.at } : null, phones: (ns.adapter.rooms.get('ph:' + roomId) || new Set()).size });
      socket.on('setRequest', async (data) => {
        const type = data && REQUESTS[data.type] ? data.type : null;
        requests.set(roomId, type ? { type, at: Date.now() } : null);
        const r = requests.get(roomId);
        ns.to('op:' + roomId).emit('request', r ? { type: r.type, label: REQUESTS[r.type].label, at: r.at } : null);
        lastView.delete(roomId);
        await pushView(roomId).catch(() => {});
      });
      socket.on('clearResults', () => { results.set(roomId, []); ns.to('op:' + roomId).emit('results', []); });
      return;
    }

    // Phone
    const token = String(q.t || '').replace(/[^A-Za-z0-9_-]/g, '');
    const roomId = await roomForToken(token);
    if (!roomId) { socket.emit('invalid', { error: 'This link is not valid anymore. Ask the operator for a new one.' }); return socket.disconnect(true); }
    socket.join('ph:' + roomId);
    const state = await getRoomState('room-' + roomId);
    const view = mobileView(roomId, token, state && state.cricketState);
    socket.emit('view', view);
    const notifyCount = () => ns.to('op:' + roomId).emit('phones', (ns.adapter.rooms.get('ph:' + roomId) || new Set()).size);
    notifyCount();
    socket.on('disconnect', () => setTimeout(notifyCount, 50));

    const seenNonces = new Set();
    socket.on('submit', async (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const type = data && REQUESTS[data.type] ? data.type : null;
        if (!type) return reply({ ok: false, error: 'Unknown request' });
        const nonce = String((data && data.nonce) || '').slice(0, 40);
        if (nonce && seenNonces.has(nonce)) return reply({ ok: true, duplicate: true });
        const st = await getRoomState('room-' + roomId);
        const cs = st && st.cricketState;
        if (!cs) return reply({ ok: false, error: 'Match not available' });
        const { key, list } = listFor(cs, type);
        const player = list.find((p) => refOf(token, key, p.id) === String(data.ref || ''));
        if (!player) return reply({ ok: false, error: 'That player is not available for this selection anymore — the list was updated, please choose again.' });
        if (nonce) { seenNonces.add(nonce); if (seenNonces.size > 200) seenNonces.clear(); }
        const team = teamCard(cs, key);
        const result = {
          id: crypto.randomBytes(6).toString('hex'),
          type, label: REQUESTS[type].label,
          name: player.name,
          playerId: player.id,             // operator side only — for exact mapping
          teamKey: key, teamName: team.name, teamShort: team.short, teamColor: team.color,
          innings: cs.inningsNumber || 1,
          at: Date.now(),
        };
        const arr = results.get(roomId) || [];
        arr.push(result);
        while (arr.length > 40) arr.shift();
        results.set(roomId, arr);
        ns.to('op:' + roomId).emit('result', result);
        const req = requests.get(roomId);
        if (req && req.type === type) { requests.set(roomId, null); ns.to('op:' + roomId).emit('request', null); lastView.delete(roomId); pushView(roomId).catch(() => {}); }
        reply({ ok: true, name: player.name, label: REQUESTS[type].label });
      } catch (e) {
        reply({ ok: false, error: 'Could not send — please try again' });
      }
    });
  });

  return { onCricketUpdate };
}

module.exports = { setup, REQUESTS };
