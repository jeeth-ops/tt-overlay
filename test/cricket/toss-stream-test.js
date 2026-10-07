// 🪙 Toss shows the teams by name; 📺 the YouTube link gets a small tick
// once the public scorecard can play it — both panels.
//
//   node test/cricket/toss-stream-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function boot(file){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8').replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole(); const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const sock = { connected: true, h: {} };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=TS', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(ev, fn){ sock.h[ev] = fn; }, emit(ev, p, ack){ if(typeof ack === 'function') ack({ ok: true }); }, get connected(){ return sock.connected; }, disconnect(){}, io: { on(){} } });
      w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
      w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.HTMLMediaElement.prototype.play = () => Promise.resolve(); w.HTMLMediaElement.prototype.pause = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
      w.scrollTo = () => {};
    }
  });
  const w = dom.window;
  return { w, errors, sock, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s) };
}
const typeIn = (P, sel, v) => { const el = P.$(sel); el.value = v; el.dispatchEvent(new P.w.Event('input', { bubbles: true })); };
(async () => {
  for(const file of ['cricket-panel.html', 'cricket-panel3.html']){
    const L = s => `${file}: ${s}`;
    console.log(`\n######## ${file} ########`);
    const P = boot(file);
    await sleep(80);
    const opts = () => [...P.$('#toss-winner').options].map(o => o.textContent);
    P.E(`state.teamA.name = 'Mumbai Indians'; state.teamB.name = 'Royal Challengers'; renderPanel();`);
    eq(L('toss lists the teams by name'), opts(), ['— Not held yet —', 'Mumbai Indians', 'Royal Challengers']);
    typeIn(P, '#teamB-name', 'DY Patil');
    eq(L('…and follows a renamed team at once'), opts()[2], 'DY Patil');
    P.E(`state.teamA.name = ''; renderPanel();`);
    eq(L('a team with no name yet shows as Team A'), opts()[1], 'Team A');
    eq(L('the choice itself is still A / B underneath'), [...P.$('#toss-winner').options].map(o => o.value), ['', 'A', 'B']);

    const st = () => ({ tick: !P.$('#stream-url-tick').hidden, wait: P.$('#stream-url-tick').classList.contains('wait'), note: P.$('#stream-url-status').hidden ? '' : P.$('#stream-url-status').textContent });
    P.E(`if(!socket) socket = io(); state.streamUrl = ''; document.getElementById('stream-url').value = ''; renderStreamUrlStatus();`);
    eq(L('no link → nothing shown'), st(), { tick: false, wait: false, note: '' });
    typeIn(P, '#stream-url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    eq(L('a YouTube link → green tick, "on the scorecard"'), st(), { tick: true, wait: false, note: '✓ Video link added — it is on the scorecard' });
    eq(L('…and the link is in the state sent to the scorecard'), P.E('state.streamUrl'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    typeIn(P, '#stream-url', 'youtu.be/dQw4w9WgXcQ');
    eq(L('short links and live links count too'), [st().tick, (typeIn(P, '#stream-url', 'https://youtube.com/live/abcdefghijk?si=x'), st().tick)], [true, true]);
    typeIn(P, '#stream-url', 'https://facebook.com/some/video');
    eq(L('not a YouTube video → a clear warning, no tick'), st(), { tick: false, wait: false, note: '⚠ Not a YouTube video link — the scorecard cannot play this' });
    P.sock.connected = false;
    typeIn(P, '#stream-url', 'https://youtu.be/dQw4w9WgXcQ');
    eq(L('offline → amber tick, goes when back online'), st(), { tick: true, wait: true, note: '✓ Link saved — it goes to the scorecard when the panel is back online' });
    P.sock.connected = true;
    if(P.sock.h.connect) P.sock.h.connect();
    eq(L('back online → green'), [st().tick, st().wait], [true, false]);
    eq(L('no script errors'), P.errors.filter(e => !/getContext|Not implemented/.test(e)), []);
  }
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
