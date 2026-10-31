/* 📱 PHONE REMOTE — end to end, on the REAL server.js (test/server-boot.js:
   in-memory MongoDB), the REAL laptop panels (cricket-panel3.html =
   Stream Engine, cricket-panel.html = Clipper) and the REAL phone page
   (cricket-remote.html), all three in jsdom and talking over the real
   Socket.IO client the server itself serves. Only the laptop's local
   clipper (127.0.0.1:5006 / localhost:5005) is a stand-in that records
   what it is asked to cut.

     • the laptop shows a QR → the phone opens it → paired, no login
     • 4 / 6 / WICKET / Wide / Undo pressed ON THE PHONE are scored by the
       laptop panel's own buttons: the laptop's score, the overlay (a plain
       room listener) and the phone all agree, and the laptop's clipper is
       asked for the FOUR / SIX / WICKET clip — the phone never cuts video
     • the laptop's popups (Wicket Details, New Batsman, extras, wagon
       wheel) are answered from the phone through the panel's own controls
     • the laptop scoring by itself shows on the phone
     • the same command id twice is done once; a stale Undo is refused
     • a used QR / a forged session / an unpaired socket cannot score
     • "Disconnect all phones" ends the pairing; laptop closed → "offline"
     • a locked match's laptop needs its key to start the remote

     npm install --no-save jsdom
     node test/cricket/remote-control-test.js
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');
const { bootServer } = require('../server-boot.js');
const { connect } = require('../socketio-polling-client.js');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const ok = (name, cond, detail) => eq(name + (cond ? '' : (detail ? ' — ' + detail : '')), !!cond, true);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms){ const end = Date.now() + (ms || 6000); let v; while(Date.now() < end){ try{ v = fn(); if(v) return v; }catch(e){} await sleep(40); } return v; }
const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
function get(port, p){
  return new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); }).on('error', reject));
}

let base = '', ioClientJs = '';
const hostJs = read('cricket-remote-host.js');

function stubs(w, calls){
  w.fetch = (url, opts) => {
    const u = new URL(String(url), base);
    let body = null;
    try{ body = opts && opts.body ? JSON.parse(opts.body) : null; }catch(e){}
    const local = (u.hostname === '127.0.0.1' && u.port === '5006') || (u.hostname === 'localhost' && u.port === '5005');
    calls.push({ url: String(url), path: u.pathname, local, body });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, ok: true, recordingActive: true, recording: true, jobs: [] }) });
  };
  Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
  w.firebase = undefined; w.alert = () => {}; w.confirm = () => true;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
  w.HTMLMediaElement.prototype.play = () => Promise.resolve(); w.HTMLMediaElement.prototype.pause = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
  w.scrollTo = () => {}; w.open = () => null;
  if(!w.crypto.randomUUID) w.crypto.randomUUID = () => 'u' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  w.eval(ioClientJs);   // the real Socket.IO client, as served by server.js
}

async function bootLaptop(file, room, opts){
  opts = opts || {};
  let html = read(file).replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const calls = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: `${base}/${file.replace('.html', '')}`, virtualConsole: vc,
    beforeParse(w){ stubs(w, calls); Object.entries(opts.storage || {}).forEach(([k, v]) => w.localStorage.setItem(k, v)); } });
  const w = dom.window;
  await until(() => w.document.readyState === 'complete', 4000);
  w.eval(hostJs);       // <script src="/cricket-remote-host.js"> at the end of <body>
  const E = (c) => w.eval(c);
  E(`document.getElementById('match-id').value = ${JSON.stringify(room)}; document.getElementById('connect-btn').click();`);
  await until(() => E('!!(socket && socket.connected)'), 6000);
  await sleep(1400);   // the panel's first-connect hydration window
  if(opts.seed === false) return { dom, w, E, calls, errors, $: (s) => w.document.querySelector(s), close: () => { try{ w.close(); }catch(e){} } };
  // a match in progress (seeded after Connect: switching to a new Match ID starts a fresh match)
  E(`
    state.format = 'T20'; state.oversPerInnings = 20; state.battingTeam = 'A'; state.inningsNumber = 1;
    state.teamA.name = 'Kanga Kings'; state.teamA.short = 'KK'; state.teamB.name = 'Shivaji Strikers'; state.teamB.short = 'SS';
    state.striker    = { name:'Harsh Rane', id:null, runs:10, balls:8, fours:1, sixes:0 };
    state.nonStriker = { name:'Sahil Gode', id:null, runs:5, balls:6, fours:0, sixes:0 };
    state.bowler     = { name:'Jamshed Alam', id:null, overs:2, balls:1, maidens:0, runs:12, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    state.score = { runs: 60, wickets: 2, overs: 12, balls: 1 };
    state.thisOver = ['1'];
    history = [];
    pushState(true, true);
  `);
  await sleep(300);
  return { dom, w, E, calls, errors, $: (s) => w.document.querySelector(s), close: () => { try{ w.close(); }catch(e){} },
    storage: () => { const o = {}; for(let i = 0; i < w.localStorage.length; i++){ const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; } };
}

async function bootPhone(url){
  let html = read('cricket-remote.html').replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  let vibrations = 0;
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url, virtualConsole: vc,
    beforeParse(w){
      if(!w.crypto.randomUUID) w.crypto.randomUUID = () => 'u' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      Object.defineProperty(w.navigator, 'vibrate', { value: () => { vibrations++; return true; } });
      w.eval(ioClientJs);
    } });
  const w = dom.window;
  const $ = (s) => w.document.querySelector(s);
  return { dom, w, $, $$: (s) => [...w.document.querySelectorAll(s)], errors, vibrations: () => vibrations,
    text: (s) => { const el = $(s); if(!el) return ''; const parts = el.children.length && el.classList.contains('prow') ? [...el.children].map(c => c.textContent) : [el.textContent]; return parts.join(' ').replace(/\s+/g, ' ').trim(); },
    tap: (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    sheetButton: (re) => [...w.document.querySelectorAll('#sheet-body button')].find(b => re.test(b.textContent)),
    close: () => { try{ w.close(); }catch(e){} } };
}

const clips = (L, type) => L.calls.filter(c => c.local && /\/clip$/.test(c.path) && (!type || (c.body && c.body.eventType === type)));
const last = (L) => JSON.parse(L.E('JSON.stringify((state.ballLog || []).slice(-1)[0] || null)'));
const score = (L) => L.E('state.score.runs + "/" + state.score.wickets + " (" + state.score.overs + "." + state.score.balls + ")"');

async function pairPhone(L){
  L.$('#cr-remote-btn').click();
  const link = await until(() => L.$('#cr-link').value, 6000);
  return link;
}

async function suite(file, opts){
  const tag = file === 'cricket-panel3.html' ? 'P3' : 'P1';
  const T = (s) => `${tag}: ${s}`;
  const ROOM = 'RMT' + tag + Math.random().toString(36).slice(2, 6).toUpperCase();
  console.log(`\n######## ${file} — the phone scores through this laptop ########`);
  const L = await bootLaptop(file, ROOM);
  ok(T('laptop panel up and connected to the match'), L.E('socket.connected') && L.E('currentMatchId()') === ROOM);
  ok(T('the 📱 Phone Remote button sits next to Connect'), L.$('#connect-btn').nextElementSibling && L.$('#connect-btn').nextElementSibling.id === 'cr-remote-btn');
  // an overlay: a plain listener in the match room
  const overlay = await connect(Number(base.split(':').pop()), { room: 'room-' + ROOM });
  const seen = [];
  overlay.on('liveCricketScore', (s) => { if(s && s.score) seen.push(s.score.runs + '/' + s.score.wickets); });

  console.log('\n=== Pairing by QR ===');
  const link = await pairPhone(L);
  ok(T('QR link for THIS match: /cricket-remote?pair=…'), /\/cricket-remote\?pair=[\w.%-]+$/.test(link || ''), link);
  ok(T('the QR is drawn (or the link shown) in the pairing window'), L.$('#cr-remote-overlay').classList.contains('show'));
  const P = await bootPhone(link);
  await until(() => /Live/.test(P.text('#conn')), 8000);
  eq(T('phone: paired straight from the QR, no login — 🟢 Live'), P.text('#conn'), '🟢 Live · laptop connected');
  eq(T('phone: the pair token leaves the address bar (a reload uses the saved pairing)'), [P.w.location.search, !!P.w.localStorage.getItem('cricketRemoteSession')], ['', true]);
  await until(() => L.E('window.__crRemote.phones.length') === 1, 4000);
  eq(T('laptop: 1 phone connected, shown on the button'), [L.E('window.__crRemote.phones.length'), L.$('#cr-remote-btn .cr-n').textContent], [1, '1']);
  await until(() => P.text('#runs') === '60/2', 4000);
  eq(T('phone shows the laptop\'s match: score, overs, batters, bowler'), [P.text('#runs'), P.text('#overs'), P.text('#p-s'), P.text('#p-ns'), P.text('#p-b'), P.text('#bat-name')],
    ['60/2', '12.1 (20)', 'Harsh Rane 10 (8)', 'Sahil Gode 5 (6)', '🎯 Jamshed Alam 2.1-0-12-0', 'Kanga Kings']);
  L.$('#cr-close').click();

  console.log('\n=== FOUR pressed on the phone ===');
  L.calls.length = 0;
  P.tap(P.$('#pad [data-ball="4"]'));
  await until(() => L.E('state.score.runs') === 64, 4000);
  eq(T('laptop scored it with its own engine: 64/2, ball 12.2'), score(L), '64/2 (12.2)');
  eq(T('laptop ball log: a 4 by Harsh Rane off Jamshed Alam'), (() => { const e = last(L); return [e.ballType, e.runs, e.striker, e.bowler]; })(), ['4', 4, 'Harsh Rane', 'Jamshed Alam']);
  await until(() => clips(L, 'FOUR').length, 3000);
  eq(T('the LAPTOP\'s clipper is asked for the FOUR clip (once)'), clips(L, 'FOUR').length, 1);
  const fourClip = clips(L, 'FOUR')[0];
  ok(T('…with this match id and the ball\'s own players (the laptop\'s naming/timing)'), fourClip && fourClip.body && fourClip.body.matchId === ROOM && JSON.stringify(fourClip.body).includes('Harsh Rane'), JSON.stringify(fourClip && fourClip.body).slice(0, 200));
  await until(() => seen.includes('64/2'), 4000);
  ok(T('the overlay (room listener) got 64/2'), seen.includes('64/2'), JSON.stringify(seen));
  await until(() => P.text('#runs') === '64/2', 3000);
  eq(T('phone shows 64/2 and the 4 in this over'), [P.text('#runs'), P.$$('#pips .pip').map(p => p.textContent).slice(-1)[0]], ['64/2', '4']);
  ok(T('phone: confirmed (vibration + nothing left to send)'), P.vibrations() > 0 && P.text('#queue') === '');

  console.log('\n=== The wagon wheel that follows, answered on the phone ===');
  await until(() => /Where did it go/.test(P.text('#sheet-body')), 3000);
  ok(T('phone shows the laptop\'s "Where did it go?" with the field'), /Where did it go/.test(P.text('#sheet-body')) && P.$('#sheet-body svg#ww') && P.$$('#sheet-body .wwz').length === 16);
  const svg = P.$('#sheet-body svg#ww');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 224, height: 224, right: 224, bottom: 224 });
  // straight down the ground below the bowler = long-on/long-off side: x≈+20, y≈+90 (field units)
  svg.dispatchEvent(new P.w.MouseEvent('click', { bubbles: true, clientX: 112 + 20, clientY: 112 + 90 }));
  await until(() => last(L).shot, 3000);
  const shot = last(L).shot;
  eq(T('the tap lands on the laptop\'s delivery as the panel stores it (deep, a region)'), [!!shot, shot && shot.depth, shot && typeof shot.zone], [true, 'deep', 'string']);
  await until(() => !L.$('#ww-overlay').classList.contains('show'), 2000);

  console.log('\n=== SIX, then another ball while the wheel is still up ===');
  L.calls.length = 0;
  P.tap(P.$('#pad [data-ball="6"]'));
  await until(() => L.E('state.score.runs') === 70, 4000);
  await until(() => L.$('#ww-overlay').classList.contains('show'), 2000);
  await until(() => P.$('#sheet').classList.contains('show') && P.$('#sheet').classList.contains('soft'), 3000);
  ok(T('phone: the wheel never holds up the next ball — "Hide" puts it away'), P.$('#sheet').classList.contains('soft'));
  P.tap(P.$('#sheet-hide'));
  await until(() => !P.$('#sheet').classList.contains('show'), 2000);
  ok(T('…hidden on the phone, the pad is free'), !P.$('#sheet').classList.contains('show'));
  P.tap(P.$('#pad [data-ball="1"]'));
  await until(() => L.E('state.score.runs') === 71, 4000);
  eq(T('6 then 1: 71/2 (12.4) — the open wheel is skipped, as Esc does'), score(L), '71/2 (12.4)');
  await until(() => clips(L, 'SIX').length, 3000);
  eq(T('SIX clip asked of the laptop clipper; no clip for the single'), [clips(L, 'SIX').length, clips(L).filter(c => c.body && /FOUR|WICKET/.test(c.body.eventType)).length], [1, 0]);
  // the single changed ends
  await until(() => /Sahil Gode/.test(P.text('#p-s')), 3000);
  eq(T('phone: strike changed after the single'), P.text('#p-s'), 'Sahil Gode 5 (6)');
  if(L.$('#ww-overlay').classList.contains('show')) L.$('#ww-skip').click();

  console.log('\n=== Laptop and phone at the same time ===');
  L.$('[data-ball="2"]').click();     // the laptop operator scores
  if(L.E('typeof maybePromptNewBowler') === 'function') L.E('maybePromptNewBowler()');
  await until(() => P.text('#runs') === '73/2', 3000);
  eq(T('a ball scored ON THE LAPTOP shows on the phone'), [P.text('#runs'), P.text('#overs')], ['73/2', '12.5 (20)']);
  await until(() => L.$('#ww-overlay').classList.contains('show'), 1500);
  if(L.$('#ww-overlay').classList.contains('show')) L.$('#ww-skip').click();
  await sleep(400);

  console.log('\n=== WICKET from the phone: Wicket Details + New Batsman answered on the phone ===');
  L.calls.length = 0;
  P.tap(P.$('#pad [data-ball="W"]'));
  await until(() => L.$('#wd-overlay').classList.contains('show'), 3000);
  ok(T('laptop opened its own Wicket Details'), L.$('#wd-overlay').classList.contains('show'));
  await until(() => clips(L, 'WICKET').length, 3000);
  eq(T('the WICKET clip is asked of the laptop clipper at the press, as on the laptop'), clips(L, 'WICKET').length, 1);
  await until(() => P.sheetButton(/^Bowled/), 3000);
  ok(T('phone shows the same popup: out types, CONFIRM switched off until a type is chosen'), P.sheetButton(/^Bowled/) && P.sheetButton(/CONFIRM WICKET/) && P.sheetButton(/CONFIRM WICKET/).disabled);
  P.tap(P.sheetButton(/^Bowled/));
  await until(() => P.sheetButton(/CONFIRM WICKET/) && !P.sheetButton(/CONFIRM WICKET/).disabled, 3000);
  ok(T('choosing Bowled on the phone switches CONFIRM on (the panel\'s own rules)'), P.sheetButton(/^Bowled/).classList.contains('on') && !P.sheetButton(/CONFIRM WICKET/).disabled);
  P.tap(P.sheetButton(/CONFIRM WICKET/));
  await until(() => L.E('state.score.wickets') === 3, 3000);
  eq(T('laptop recorded the wicket — the 6th ball: 73/3 (13.0)'), [score(L), last(L).ballType, last(L).striker], ['73/3 (13.0)', 'W', 'Sahil Gode']);
  await until(() => L.$('#newbat-modal-overlay').classList.contains('show'), 2000);
  await until(() => /coming in/.test(P.text('#sheet-body')), 3000);
  ok(T('the New Batsman question follows on the phone'), /coming in/.test(P.text('#sheet-body')));
  const nameIn = [...P.w.document.querySelectorAll('#sheet-body input[type=text]')][0];
  ok(T('…with the name box (no squad entered)'), !!nameIn);
  nameIn.value = 'Rohan Raje';
  nameIn.dispatchEvent(new P.w.Event('input', { bubbles: true }));
  await until(() => L.$('#newbat-modal-input').value === 'Rohan Raje', 3000);
  eq(T('typing on the phone fills the laptop\'s box'), L.$('#newbat-modal-input').value, 'Rohan Raje');
  const submit = P.sheetButton(/Send|Confirm|In|Done|Set/i);
  P.tap([...P.w.document.querySelectorAll('#sheet-body button.primary')].slice(-1)[0] || submit);
  await until(() => !L.$('#newbat-modal-overlay').classList.contains('show'), 3000);
  const crease = L.E('[state.striker.name, state.nonStriker.name].join(" & ")');
  ok(T('Rohan Raje is in (seated by the panel itself)'), /Rohan Raje/.test(crease), crease);
  // the over is complete: the laptop asks for the next bowler
  await until(() => L.$('#newover-modal-overlay').classList.contains('show'), 3000);
  await until(() => /bowling next/.test(P.text('#sheet-body')), 3000);
  ok(T('end of the over: "who\'s bowling next?" on the phone'), /bowling next/.test(P.text('#sheet-body')));
  const bowlIn = P.$$('#sheet-body input[type=text]').find(i => i.dataset.ref === '#newover-modal-input');
  if(bowlIn){
    bowlIn.value = 'Shubham Mane';
    bowlIn.dispatchEvent(new P.w.Event('input', { bubbles: true }));
    await until(() => L.$('#newover-modal-input').value === 'Shubham Mane', 3000);
    P.tap([...P.w.document.querySelectorAll('#sheet-body button.primary')].slice(-1)[0]);
  }
  await until(() => !L.$('#newover-modal-overlay').classList.contains('show'), 3000);
  eq(T('new bowler set from the phone'), L.E('state.bowler.name'), 'Shubham Mane');
  // the panel then offers the new batter's card for the broadcast — the phone gets that too
  await until(() => P.sheetButton(/^Skip$/) && /BATSMAN CARD/i.test(P.text('#sheet-body')), 3000);
  ok(T('"SHOW BATSMAN CARD?" for Rohan Raje is offered on the phone'), /BATSMAN CARD/i.test(P.text('#sheet-body')) && /Rohan Raje/.test(P.text('#sheet-body')));
  if(P.sheetButton(/^Skip$/)) P.tap(P.sheetButton(/^Skip$/));
  // …and the new bowler's card after it (the panel queues them)
  await until(() => /BOWLER CARD/i.test(P.text('#sheet-body')), 3000);
  ok(T('…then "SHOW BOWLER CARD?" for Shubham Mane'), /BOWLER CARD/i.test(P.text('#sheet-body')) && /Shubham Mane/.test(P.text('#sheet-body')));
  if(P.sheetButton(/^Skip$/)) P.tap(P.sheetButton(/^Skip$/));
  await until(() => !P.$('#sheet').classList.contains('show'), 3000);
  ok(T('phone: popup gone once answered'), !P.$('#sheet').classList.contains('show'), P.text('#sheet-body').slice(0, 120) + ' | laptop open: ' + L.E(`[...document.querySelectorAll('[id$="overlay"].show')].map(e => e.id).join(',')`));
  await until(() => P.text('#runs') === '73/3', 3000);
  eq(T('phone shows 73/3 (13.0) and the new bowler'), [P.text('#runs'), P.text('#overs'), P.text('#p-b')], ['73/3', '13.0 (20)', '🎯 Shubham Mane 0.0-0-0-0']);

  console.log('\n=== Wide from the phone (the extras picker answered on the phone) ===');
  P.tap(P.$('#pad [data-ball="Wd"]'));
  await until(() => L.$('#extras-modal-overlay').classList.contains('show'), 3000);
  await until(() => P.sheetButton(/WD \+ 0/), 3000);
  ok(T('phone shows the Wide picker'), !!P.sheetButton(/WD \+ 0/));
  P.tap(P.sheetButton(/WD \+ 0/));
  await until(() => L.E('state.score.runs') === 74, 3000);
  eq(T('wide recorded: 74/3, still 13.0'), [score(L), last(L).ballType], ['74/3 (13.0)', 'Wd']);

  console.log('\n=== Undo from the phone ===');
  await until(() => P.text('#runs') === '74/3', 3000);
  await sleep(400);
  P.tap(P.$('#t-undo'));
  await until(() => L.E('state.score.runs') === 73, 4000);
  eq(T('the wide is undone on the laptop'), [score(L), last(L).ballType], ['73/3 (13.0)', 'W']);
  await until(() => P.text('#runs') === '73/3', 3000);
  eq(T('…and the phone shows it'), P.text('#runs'), '73/3');

  console.log('\n=== The same command twice / a stale Undo ===');
  const session = P.w.localStorage.getItem('cricketRemoteSession');
  const raw = P.w.io('/cricket-remote', { forceNew: true });
  const ack = (ev, d) => new Promise((resolve) => raw.timeout(9000).emit(ev, d, (err, r) => resolve(err ? { err: String(err) } : r)));
  await until(() => raw.connected, 4000);
  const j = await ack('remote:join', { session, label: 'Test' });
  eq(T('the saved session rejoins (a reload / a dropped line)'), [j.ok, j.matchId], [true, ROOM]);
  const a1 = await ack('remote:cmd', { cmdId: 'dup-cmd-0001', cmd: { t: 'ball', v: '0' } });
  const a2 = await ack('remote:cmd', { cmdId: 'dup-cmd-0001', cmd: { t: 'ball', v: '0' } });
  await sleep(300);
  eq(T('a dot ball sent twice with one id is scored once (13.1)'), [a1.ok, a2.ok, !!a2.duplicate, score(L)], [true, true, true, '73/3 (13.1)']);
  if(L.$('#ww-overlay').classList.contains('show')) L.$('#ww-skip').click();
  const stale = await ack('remote:cmd', { cmdId: 'stale-undo-01', cmd: { t: 'undo', last: { id: 'not-the-last-ball', n: 1 } } });
  eq(T('an Undo for a ball that is no longer the last one is refused — nothing undone'), [stale.ok, stale.error, score(L)], [false, 'changed', '73/3 (13.1)']);
  // a press while a popup is open on the laptop
  L.$('[data-ball="W"]').click();
  const busy = await ack('remote:cmd', { cmdId: 'busy-ball-01', cmd: { t: 'ball', v: '4' } });
  eq(T('a ball pressed while Wicket Details is open is refused (finish the popup first)'), [busy.ok, busy.error, score(L)], [false, 'modal-open', '73/3 (13.1)']);
  L.E('cancelWicketDetails()');

  console.log('\n=== Who may score ===');
  const used = await ack('remote:join', { pair: decodeURIComponent(link.split('pair=')[1]) });
  eq(T('the QR code works once'), [used.ok, used.error], [false, 'used']);
  const forged = await ack('remote:join', { session: session.slice(0, -4) + 'AAAA' });
  eq(T('a forged session is refused'), [forged.ok, forged.error], [false, 'expired']);
  const stranger = P.w.io('/cricket-remote', { forceNew: true });
  await until(() => stranger.connected, 4000);
  const sx = await new Promise((resolve) => stranger.timeout(5000).emit('remote:cmd', { cmdId: 'stranger-0001', cmd: { t: 'ball', v: '6' } }, (e, r) => resolve(r)));
  eq(T('an unpaired socket cannot score'), [sx.ok, sx.error, score(L)], [false, 'not-paired', '73/3 (13.1)']);
  const hijack = await new Promise((resolve) => stranger.timeout(5000).emit('remoteHost:pair', {}, (e, r) => resolve(r)));
  eq(T('…nor make QR codes for someone else\'s laptop'), [hijack.ok, hijack.error], [false, 'not-registered']);
  stranger.disconnect();

  console.log('\n=== Disconnect all phones ===');
  L.$('#cr-remote-btn').click();
  L.$('#cr-revoke').click();
  await until(() => /Disconnected by the laptop/.test(P.text('#gate-h')), 4000);
  eq(T('the phone is told and stops'), P.text('#gate-h'), 'Disconnected by the laptop');
  await sleep(500);
  const after = await ack('remote:join', { session, label: 'Test' });
  eq(T('its saved session no longer works'), [after.ok, after.error], [false, 'revoked']);
  const newLink = await until(() => { const v = L.$('#cr-link').value; return v && v !== link ? v : null; }, 5000);
  ok(T('a fresh QR code is ready for the next phone'), !!newLink);
  L.$('#cr-close').click();
  raw.disconnect();

  console.log('\n=== Laptop goes away ===');
  const P2 = await bootPhone(newLink);
  await until(() => /Live/.test(P2.text('#conn')), 8000);
  ok(T('a second phone pairs with the new code'), /Live/.test(P2.text('#conn')));
  const laptopStorage = L.storage();
  L.close();
  await until(() => /offline/.test(P2.text('#conn')), 6000);
  eq(T('laptop closed → phone shows 🔴 Laptop offline'), P2.text('#conn'), '🔴 Laptop offline');
  P2.tap(P2.$('#pad [data-ball="4"]'));
  await until(() => P2.$$('#toasts .toast').some(t => /offline/i.test(t.textContent)), 4000);
  ok(T('a press is refused with "Laptop is offline — nothing was scored"'), P2.$$('#toasts .toast').some(t => /Laptop is offline — nothing was scored/.test(t.textContent)));

  console.log('\n=== The laptop comes back (browser reopened on the same match) ===');
  const L2 = await bootLaptop(file, ROOM, { storage: laptopStorage, seed: false });
  await until(() => /Live/.test(P2.text('#conn')), 8000);
  eq(T('the phone is live again by itself — no new QR needed'), P2.text('#conn'), '🟢 Live · laptop connected');
  const before2 = L2.E('state.score.runs');
  P2.tap(P2.$('#pad [data-ball="4"]'));
  await until(() => L2.E('state.score.runs') === before2 + 4, 5000);
  eq(T('…and scores: +4 on the laptop'), L2.E('state.score.runs') - before2, 4);
  await until(() => clips(L2, 'FOUR').length, 3000);
  eq(T('…with the FOUR clip from the laptop clipper'), clips(L2, 'FOUR').length, 1);
  L2.close();

  eq(T('no script errors on the laptop or the phones'), [...L.errors, ...L2.errors, ...P.errors, ...P2.errors].filter(e => !/Not implemented|getContext|navigation/i.test(e)), []);
  P.close(); P2.close();
  await overlay.close();
}

async function lockSuite(mem){
  console.log('\n######## A locked match ########');
  const room = 'RMTLOCK' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const crypto = require('crypto');
  // the lock as server.js stores it: only a hash of the laptop's key
  await mem.collection('matchLocks').insertOne({ roomId: room, matchId: null, codeHmac: 'x' + room, holder: { tokenHash: crypto.createHash('sha256').update('the-real-key').digest('hex'), deviceId: 'dv1', at: Date.now() }, createdAt: Date.now() });
  const L = await bootLaptop('cricket-panel3.html', room);
  await sleep(1200);
  L.$('#cr-remote-btn').click();
  await until(() => /locked/.test(L.$('#cr-status').textContent), 4000);
  ok('LOCK: a laptop without the match key cannot start the phone remote', /locked with a code/.test(L.$('#cr-status').textContent) && !L.$('#cr-link').value, L.$('#cr-status').textContent);
  L.close();
}

(async () => {
  const { port, mem } = await bootServer();
  base = `http://127.0.0.1:${port}`;
  ioClientJs = await get(port, '/socket.io/socket.io.js');
  ok('server serves the phone page at /cricket-remote', /Scoring Remote/.test(await get(port, '/cricket-remote')));
  ok('…and the laptop script', /PHONE REMOTE/.test(await get(port, '/cricket-remote-host.js')));
  await suite('cricket-panel3.html');
  await suite('cricket-panel.html');
  await lockSuite(mem);
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
