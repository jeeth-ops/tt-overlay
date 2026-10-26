// The /volleyball Socket.IO namespace over HTTP long-polling, for tests that
// talk to the REAL server.js — like test/socketio-polling-client.js, but for
// a namespace and with the handshake `auth` payload (the ID token).
//
//   const s = await connectVb(port, { idToken: 'tok' });
//   const reply = await s.emitAck('vb:join', { matchId });
//   s.on('vb:update', fn); await s.close();
const http = require('http');
const NSP = '/volleyball';

function connectVb(port, auth) {
  let sid = null, closed = false, nextAck = 0, connected = null;
  const acks = new Map(), listeners = {};
  const request = (method, body) => new Promise((resolve, reject) => {
    const q = new URLSearchParams({ EIO: '4', transport: 'polling' });
    if (sid) q.set('sid', sid);
    q.set('t', Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    const headers = body != null ? { 'Content-Type': 'text/plain;charset=UTF-8', 'Content-Length': Buffer.byteLength(body) } : {};
    const r = http.request({ host: '127.0.0.1', port, method, path: '/socket.io/?' + q.toString(), headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
  const send = (pkt) => request('POST', pkt);
  function handle(packet) {
    if (packet === '2') { send('3').catch(() => {}); return; }
    if (packet[0] !== '4') return;
    const type = packet[1];
    let rest = packet.slice(2);
    if (!rest.startsWith(NSP + ',')) return;     // another namespace (never ours)
    rest = rest.slice(NSP.length + 1);
    if (type === '0') { if (connected) connected.resolve(); return; }
    if (type === '4') { if (connected) connected.reject(new Error('connect refused: ' + rest)); return; }
    const m = /^(\d*)(\[[\s\S]*)$/.exec(rest);
    if (!m) return;
    const args = JSON.parse(m[2]);
    if (type === '2') (listeners[args[0]] || []).forEach((fn) => fn(...args.slice(1)));
    else if (type === '3') {
      const fn = acks.get(Number(m[1]));
      if (fn) { acks.delete(Number(m[1])); fn(...args); }
    }
  }
  async function pollLoop() {
    while (!closed) {
      let r;
      try { r = await request('GET'); } catch (e) { if (closed) return; await new Promise((res) => setTimeout(res, 50)); continue; }
      if (r.status !== 200) return;
      r.body.split('\x1e').filter(Boolean).forEach(handle);
    }
  }
  return (async () => {
    const open = await request('GET');
    const first = open.body.split('\x1e')[0];
    if (open.status !== 200 || first[0] !== '0') throw new Error('engine.io open failed: ' + open.status);
    sid = JSON.parse(first.slice(1)).sid;
    connected = {};
    const ready = new Promise((resolve, reject) => { connected.resolve = resolve; connected.reject = reject; });
    pollLoop();
    await send('40' + NSP + ',' + JSON.stringify(auth || {}));
    await ready;
    return {
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      emitAck(ev, ...args) {
        const id = nextAck++;
        return new Promise((resolve) => { acks.set(id, (...res) => resolve(res.length > 1 ? res : res[0])); send('42' + NSP + ',' + id + JSON.stringify([ev, ...args])); });
      },
      async close() { closed = true; try { await send('41' + NSP + ','); await send('1'); } catch (e) { /* gone */ } }
    };
  })();
}

module.exports = { connectVb };
