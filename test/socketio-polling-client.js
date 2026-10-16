// A minimal Socket.IO v4 client over HTTP long-polling, for tests that talk to
// the REAL server.js (this repo has no socket.io-client package). Speaks just
// enough of the Engine.IO v4 / Socket.IO v5 protocol: open, connect to the
// default namespace, emit (with an ack), receive events, answer pings, close.
//
//   const s = await connect(port, { room: 'room-M1' });
//   const reply = await s.emitAck('logBall', payload);
//   s.on('someEvent', fn); await s.close();
const http = require('http');

function connect(port, query){
  const base = Object.assign({ EIO: '4', transport: 'polling' }, query || {});
  let sid = null, closed = false, nextAck = 0, connected = null;
  const acks = new Map();
  const listeners = {};
  const request = (method, body) => new Promise((resolve, reject) => {
    const q = new URLSearchParams(base);
    if(sid) q.set('sid', sid);
    q.set('t', Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    const headers = body != null ? { 'Content-Type': 'text/plain;charset=UTF-8', 'Content-Length': Buffer.byteLength(body) } : {};
    const r = http.request({ host: '127.0.0.1', port, method, path: '/socket.io/?' + q.toString(), headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if(body != null) r.write(body);
    r.end();
  });
  const send = (pkt) => request('POST', pkt);
  function handle(packet){
    if(packet === '2'){ send('3').catch(() => {}); return; }      // ping → pong
    if(packet[0] !== '4') return;                                  // only socket.io messages below
    const type = packet[1], rest = packet.slice(2);
    if(type === '0'){ if(connected) connected.resolve(); return; } // namespace connected
    if(type === '4'){ if(connected) connected.reject(new Error('connect refused: ' + rest)); return; }
    const m = /^(\d*)(\[[\s\S]*)$/.exec(rest);
    if(!m) return;
    const args = JSON.parse(m[2]);
    if(type === '2') (listeners[args[0]] || []).forEach(fn => fn(...args.slice(1)));
    else if(type === '3'){
      const fn = acks.get(Number(m[1]));
      if(fn){ acks.delete(Number(m[1])); fn(...args); }
    }
  }
  async function pollLoop(){
    while(!closed){
      let r;
      try { r = await request('GET'); } catch(e){ if(closed) return; await new Promise(res => setTimeout(res, 50)); continue; }
      if(r.status !== 200) return;
      r.body.split('\x1e').filter(Boolean).forEach(handle);
    }
  }
  return (async () => {
    const open = await request('GET');
    const first = open.body.split('\x1e')[0];
    if(open.status !== 200 || first[0] !== '0') throw new Error('engine.io open failed: ' + open.status + ' ' + open.body.slice(0, 120));
    sid = JSON.parse(first.slice(1)).sid;
    connected = {};
    const ready = new Promise((resolve, reject) => { connected.resolve = resolve; connected.reject = reject; });
    pollLoop();
    await send('40');
    await ready;
    return {
      on(ev, fn){ (listeners[ev] = listeners[ev] || []).push(fn); },
      emit(ev, ...args){ return send('42' + JSON.stringify([ev, ...args])); },
      emitAck(ev, ...args){
        const id = nextAck++;
        return new Promise((resolve) => { acks.set(id, (...res) => resolve(res.length > 1 ? res : res[0])); send('42' + id + JSON.stringify([ev, ...args])); });
      },
      async close(){ closed = true; try { await send('1'); } catch(e){} }
    };
  })();
}

module.exports = { connect };
