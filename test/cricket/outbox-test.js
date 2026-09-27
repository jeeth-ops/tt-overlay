/* THE BALL OUTBOX — the fix for "the internet dropped and those
   deliveries never made it into the permanent log".

   Boots the real cricket-panel.html in jsdom with a socket we can take
   offline and bring back, and a localStorage that actually persists, and
   checks the promise the outbox makes: a delivery is on disk before it is
   sent, it is re-sent until the server acknowledges it, and it is only
   forgotten once the server says it is stored.

   node test/cricket/outbox-test.js
*/
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
function eq(name, a, b){
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if(A === B){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${A} expected ${B}`); }
}

// A socket we drive by hand: it records what was emitted, and only
// acknowledges a 'logBall' when we tell it to (the server being reachable).
const sent = [];
const handlers = {};
const socketStub = {
  connected: false,
  serverUp: false,
  on(ev, fn){ handlers[ev] = fn; },
  emit(ev, data, ack){
    sent.push({ ev, data });
    if(ev === 'logBall' && typeof ack === 'function' && this.serverUp) ack({ ok: true, ballUid: data.ballUid });
  },
  disconnect(){}
};

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'cricket-panel.html'), 'utf8')
  .replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://example.test/cricket-panel?room=OUTBOXTEST',
  virtualConsole: vc,
  beforeParse(w){
    w.io = () => socketStub;
    w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
    w.alert = () => {}; w.confirm = () => true;
    w.crypto = w.crypto || {};
    if(!w.crypto.randomUUID) w.crypto.randomUUID = () => 'uuid-' + Math.random().toString(36).slice(2);
  }
});
const w = dom.window;
w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
const E = (code) => w.eval(code);
const outbox = () => JSON.parse(w.localStorage.getItem('cricket-ball-outbox') || '[]');

// The panel is wired to the stub socket, and the match is ready to score.
w.__sock = socketStub;
E(`socket = window.__sock;`);
E(`
  state = mergeWithDefaults(null);
  state.striker    = { name:'Striker', id:'p1', runs:0, balls:0, fours:0, sixes:0 };
  state.nonStriker = { name:'NonStriker', id:'p2', runs:0, balls:0, fours:0, sixes:0 };
  state.bowler     = { name:'Bowler', id:'p9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
  history = [];
  ballOutbox = [];
  saveBallOutbox();
  document.getElementById('match-id').value = 'OUTBOXTEST';
`);

console.log('\n=== SCORING WITH THE LINE DOWN ===');
socketStub.connected = false; socketStub.serverUp = false;
E(`recordBall('4'); recordBall('1'); recordBall('W', { dismissalType:'Bowled' });`);
eq('every delivery is written to disk, connection or not', outbox().length, 3);
eq('nothing was emitted while offline', sent.filter(s => s.ev === 'logBall').length, 0);
eq('each one carries its own id', new Set(outbox().map(b => b.uid)).size, 3);
eq('the delivery itself is stored, not just a marker', outbox()[0].payload.kind, '4');

console.log('\n=== A RELOAD MID-OUTAGE ===');
const persisted = w.localStorage.getItem('cricket-ball-outbox');
E(`ballOutbox = loadBallOutbox();`);
eq('the queue comes back off disk', E('ballOutbox.length'), 3);
eq('nothing was rewritten by loading it', w.localStorage.getItem('cricket-ball-outbox'), persisted);

console.log('\n=== THE LINE COMES BACK, SERVER STILL SILENT ===');
socketStub.connected = true; socketStub.serverUp = false;
E(`flushBallOutbox();`);
eq('all three are sent', sent.filter(s => s.ev === 'logBall').length, 3);
eq('every one carries a ballUid for the server to dedupe on', sent.filter(s => s.ev === 'logBall').every(s => !!s.data.ballUid), true);
eq('none is dropped without a receipt', outbox().length, 3);

console.log('\n=== THE SERVER ANSWERS ===');
socketStub.serverUp = true;
E(`ballOutbox.forEach(b => b.sentAt = 0); flushBallOutbox();`); // past the ack timeout
eq('acknowledged deliveries leave the queue', outbox().length, 0);
eq('they were re-sent rather than forgotten', sent.filter(s => s.ev === 'logBall').length, 6);
const uids = sent.filter(s => s.ev === 'logBall').map(s => s.data.ballUid);
eq('a re-send reuses the same id, so it can never become a second ball', new Set(uids).size, 3);

console.log('\n=== SCORING WHILE CONNECTED ===');
E(`recordBall('6');`);
eq('a ball sent and acknowledged straight away never lingers', outbox().length, 0);
eq('and it did go out', sent.filter(s => s.ev === 'logBall').length, 7);

console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
process.exit(fail ? 1 : 0);
