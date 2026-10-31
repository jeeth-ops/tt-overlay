// ================================================================
// 📱 PHONE REMOTE — a phone scores the live match THROUGH the laptop.
//
//   laptop  cricket-panel / cricket-panel3   (cricket-remote-host.js)
//   phone   /cricket-remote?pair=<token>     (cricket-remote.html)
//
// The phone never scores by itself and never touches video. Every press is
// a COMMAND that travels phone → server → the laptop panel that paired it;
// the laptop presses its OWN button (the same click handler, the same
// recordBall(), the same triggerClip() to its local Clipper / Stream
// Engine, the same updateCricketScore to the overlay) and answers with the
// result. So the score, the overlay, the clip — cut from the laptop's own
// recording, with its own timing, names and upload — are exactly what a
// press on the laptop gives.
//
// Isolation: its own Socket.IO namespace (/cricket-remote). Phones never
// join the match room, so they never receive the panel's full state — only
// the short summary the laptop publishes for them.
//
// Pairing:
// • The laptop (a panel holding the match — the match-lock key when the
//   match is locked) asks for a QR. The QR carries a PAIR token: signed,
//   one match + one laptop, single use, 10 minutes.
// • Scanning it gives the phone a SESSION token (signed, 24 hours) kept on
//   the phone, so a reload or a dropped connection rejoins by itself.
// • "Disconnect phones" on the laptop bumps the laptop's epoch: every
//   token issued before it stops working at once — also after a server
//   restart, since the laptop states its epoch every time it registers.
// ================================================================
const crypto = require('crypto');

const PAIR_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CMD_TIMEOUT_MS = 8000;
const MAX_PART_BYTES = 200 * 1024;
const MAX_PARTS = 64;

function b64(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function unb64(s) { try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); } catch (e) { return null; } }
function sameStr(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const okId = (v, min, max) => typeof v === 'string' && new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`).test(v);

function setup({ io, safeMatchId, getMatchLock, lockTokenMatches, getSecret, whenReady }) {
  const ns = io.of('/cricket-remote');
  const hosts = new Map();          // `${room}|${hostId}` -> host
  const usedPairs = new Map();      // pair nonce -> expiry
  let fallbackSecret = null;

  async function secret() {
    if (whenReady) await whenReady();
    const s = getSecret && getSecret();
    if (s) return crypto.createHash('sha256').update('cricket-remote:' + s).digest();
    if (!fallbackSecret) fallbackSecret = crypto.randomBytes(32);   // no database: tokens last until a restart
    return fallbackSecret;
  }
  async function sign(payload) {
    const body = b64(payload);
    return body + '.' + crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  }
  async function verify(token, type) {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac || body.length > 600) return null;
    const want = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
    if (!sameStr(mac, want)) return null;
    const p = unb64(body);
    if (!p || p.t !== type || !(p.x > Date.now())) return null;
    return p;
  }

  const keyOf = (room, hostId) => room + '|' + hostId;
  const phoneRoom = (key) => 'ph:' + key;
  function hostOf(key) {
    if (!hosts.has(key)) hosts.set(key, { key, sockets: new Map(), epoch: null, lockToken: null, parts: {}, phones: new Map() });
    return hosts.get(key);
  }
  // the panel tab that registered last answers the commands
  function liveHostSocket(h) {
    let best = null;
    for (const [id, at] of h.sockets) { const s = ns.sockets.get(id); if (s && (!best || at > best.at)) best = { s, at }; }
    return best && best.s;
  }
  function phoneList(h) { return [...h.phones.values()].map(p => ({ sid: p.sid, label: p.label, at: p.at })); }
  function tellHost(h) { for (const id of h.sockets.keys()) { const s = ns.sockets.get(id); if (s) s.emit('remoteHost:phones', phoneList(h)); } }
  function tellPhones(h) { ns.to(phoneRoom(h.key)).emit('remote:host', { online: h.sockets.size > 0 }); }
  function kickPhones(h, reason) {
    ns.to(phoneRoom(h.key)).emit('remote:revoked', { reason });
    for (const id of h.phones.keys()) { const s = ns.sockets.get(id); if (s) { s.leave(phoneRoom(h.key)); s.data.phone = null; } }
    h.phones.clear();
    tellHost(h);
  }
  async function lockStillHeld(room, token) {
    if (!getMatchLock) return true;
    try {
      const lock = await getMatchLock(room);
      return !lock || lockTokenMatches(lock, token);
    } catch (e) { return true; }   // a database hiccup never stops scoring
  }

  ns.on('connection', (socket) => {
    // ---------------- laptop panel ----------------
    socket.on('remoteHost:register', async (d, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const room = safeMatchId(String((d && d.matchId) || '').replace(/^room-/, '')).slice(0, 80);
        const hostId = d && d.hostId, epoch = Number(d && d.epoch);
        if (!room || !okId(hostId, 8, 64) || !Number.isSafeInteger(epoch) || epoch < 1) return reply({ ok: false, error: 'bad-request' });
        const lockToken = typeof (d && d.lockToken) === 'string' ? d.lockToken.slice(0, 128) : null;
        if (whenReady) await whenReady();
        if (!(await lockStillHeld(room, lockToken))) return reply({ ok: false, error: 'match-locked' });
        // one socket hosts one match at a time
        const prev = socket.data.host;
        if (prev && prev !== keyOf(room, hostId)) {
          const ph = hosts.get(prev);
          if (ph) { ph.sockets.delete(socket.id); if (!ph.sockets.size) tellPhones(ph); }
        }
        const key = keyOf(room, hostId);
        const h = hostOf(key);
        h.room = room; h.hostId = hostId; h.lockToken = lockToken;
        if (h.epoch !== epoch) {
          // the laptop states its epoch: phones paired under any other one are out
          for (const [id, p] of h.phones) if (p.epoch !== epoch) { const s = ns.sockets.get(id); if (s) { s.emit('remote:revoked', { reason: 'revoked' }); s.leave(phoneRoom(key)); s.data.phone = null; } h.phones.delete(id); }
          h.epoch = epoch;
        }
        h.sockets.set(socket.id, Date.now());
        socket.data.host = key;
        tellPhones(h);
        reply({ ok: true, phones: phoneList(h) });
      } catch (e) { reply({ ok: false, error: 'server-error' }); }
    });

    socket.on('remoteHost:pair', async (d, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const h = socket.data.host && hosts.get(socket.data.host);
      if (!h || !h.sockets.has(socket.id)) return reply({ ok: false, error: 'not-registered' });
      if (!(await lockStillHeld(h.room, h.lockToken))) return reply({ ok: false, error: 'match-locked' });
      const expiresAt = Date.now() + PAIR_TTL_MS;
      const token = await sign({ t: 'p', r: h.room, h: h.hostId, e: h.epoch, n: crypto.randomBytes(9).toString('base64url'), x: expiresAt });
      reply({ ok: true, token, expiresAt });
    });

    socket.on('remoteHost:revokeAll', (d, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const h = socket.data.host && hosts.get(socket.data.host);
      if (!h || !h.sockets.has(socket.id)) return reply({ ok: false, error: 'not-registered' });
      kickPhones(h, 'revoked');
      reply({ ok: true });   // the laptop re-registers with its new epoch next
    });

    // What the phones show, in named parts (score, modal, clips, sec:bcg, …):
    // kept here so a phone that (re)joins gets all of it at once.
    socket.on('remoteHost:part', (d) => {
      const h = socket.data.host && hosts.get(socket.data.host);
      if (!h || !h.sockets.has(socket.id) || !d || typeof d.k !== 'string' || !/^[a-z][a-z0-9:_-]{0,39}$/i.test(d.k)) return;
      let size = 0;
      try { size = JSON.stringify(d.v === undefined ? null : d.v).length; } catch (e) { return; }
      if (size > MAX_PART_BYTES) return;
      if (d.v == null) delete h.parts[d.k];
      else if (h.parts[d.k] !== undefined || Object.keys(h.parts).length < MAX_PARTS) h.parts[d.k] = d.v;
      else return;
      ns.to(phoneRoom(h.key)).emit('remote:part', { k: d.k, v: d.v == null ? null : d.v });
    });

    socket.on('remoteHost:toast', (d) => {
      const h = socket.data.host && hosts.get(socket.data.host);
      if (!h || !h.sockets.has(socket.id) || !d || typeof d.text !== 'string') return;
      ns.to(phoneRoom(h.key)).emit('remote:toast', { text: d.text.slice(0, 300), at: Date.now() });
    });

    // ---------------- phone ----------------
    socket.on('remote:join', async (d, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        let tok = null, session = null;
        if (d && d.pair) {
          const p = await verify(d.pair, 'p');
          if (!p) return reply({ ok: false, error: 'expired', message: 'This QR code has expired — show a new one on the laptop and scan again.' });
          const now = Date.now();
          for (const [n, x] of usedPairs) if (x < now) usedPairs.delete(n);
          if (usedPairs.has(p.n)) return reply({ ok: false, error: 'used', message: 'This QR code was already scanned. Show a new one on the laptop.' });
          usedPairs.set(p.n, p.x);
          tok = { t: 's', r: p.r, h: p.h, e: p.e, s: crypto.randomBytes(9).toString('base64url'), x: now + SESSION_TTL_MS };
          session = await sign(tok);
        } else if (d && d.session) {
          tok = await verify(d.session, 's');
          if (!tok) return reply({ ok: false, error: 'expired', message: 'This phone is no longer paired. Scan the QR code on the laptop again.' });
          session = d.session;
        } else {
          return reply({ ok: false, error: 'bad-request', message: 'Scan the QR code on the laptop to pair this phone.' });
        }
        const key = keyOf(tok.r, tok.h);
        const h = hostOf(key);
        h.room = h.room || tok.r; h.hostId = h.hostId || tok.h;
        if (h.epoch != null && h.epoch !== tok.e) return reply({ ok: false, error: 'revoked', message: 'The laptop disconnected this phone. Scan the QR code again.' });
        if (socket.data.phone && socket.data.phone.key !== key) { const old = hosts.get(socket.data.phone.key); if (old) { old.phones.delete(socket.id); tellHost(old); } socket.leave(phoneRoom(socket.data.phone.key)); }
        const label = String((d && d.label) || 'Phone').replace(/[^\w .,'()-]/g, '').slice(0, 40) || 'Phone';
        socket.data.phone = { key, room: tok.r, epoch: tok.e, sid: tok.s, label, recent: [] };
        socket.join(phoneRoom(key));
        h.phones.set(socket.id, { sid: tok.s, label, epoch: tok.e, at: Date.now() });
        tellHost(h);
        reply({ ok: true, session, matchId: tok.r, hostOnline: h.sockets.size > 0, parts: h.parts });
      } catch (e) { reply({ ok: false, error: 'server-error', message: 'Could not pair — try again.' }); }
    });

    socket.on('remote:cmd', async (d, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const ph = socket.data.phone;
      if (!ph) return reply({ ok: false, error: 'not-paired', message: 'This phone is not paired — scan the QR code on the laptop.' });
      if (!d || !okId(d.cmdId, 6, 64) || !d.cmd || typeof d.cmd !== 'object') return reply({ ok: false, error: 'bad-request' });
      let size = 0;
      try { size = JSON.stringify(d.cmd).length; } catch (e) { size = Infinity; }
      if (size > 4096) return reply({ ok: false, error: 'bad-request' });
      // flood guard: 15 commands in any 3 seconds
      const now = Date.now();
      ph.recent = ph.recent.filter(t => now - t < 3000);
      if (ph.recent.length >= 15) return reply({ ok: false, error: 'slow-down', message: 'Too many taps — wait a moment.' });
      ph.recent.push(now);
      const h = hosts.get(ph.key);
      if (!h || h.epoch == null || !h.sockets.size) return reply({ ok: false, error: 'laptop-offline', message: 'Laptop is offline — nothing was scored.' });
      if (h.epoch !== ph.epoch) { socket.data.phone = null; return reply({ ok: false, error: 'revoked', message: 'The laptop disconnected this phone. Scan the QR code again.' }); }
      const hs = liveHostSocket(h);
      if (!hs) return reply({ ok: false, error: 'laptop-offline', message: 'Laptop is offline — nothing was scored.' });
      if (!(await lockStillHeld(h.room, h.lockToken))) return reply({ ok: false, error: 'match-locked', message: 'This match moved to another laptop — nothing was scored.' });
      hs.timeout(CMD_TIMEOUT_MS).emit('remote:cmd', { cmdId: d.cmdId, cmd: d.cmd, from: { sid: ph.sid, label: ph.label } }, (err, res) => {
        if (err) return reply({ ok: false, error: 'timeout', retry: true, message: 'The laptop did not answer in time.' });
        reply(res && typeof res === 'object' ? res : { ok: false, error: 'bad-reply' });
      });
    });

    socket.on('disconnect', () => {
      if (socket.data.host) {
        const h = hosts.get(socket.data.host);
        if (h) { h.sockets.delete(socket.id); if (!h.sockets.size) tellPhones(h); }
      }
      if (socket.data.phone) {
        const h = hosts.get(socket.data.phone.key);
        if (h) { h.phones.delete(socket.id); tellHost(h); }
      }
      for (const key of [socket.data.host, socket.data.phone && socket.data.phone.key]) {
        const h = key && hosts.get(key);
        if (h && !h.sockets.size && !h.phones.size) hosts.delete(key);
      }
    });
  });

  return { hosts, verify, sign };
}

module.exports = { setup, PAIR_TTL_MS, SESSION_TTL_MS };
