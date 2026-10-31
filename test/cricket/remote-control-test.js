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
     • GRAPHICS: every graphics card of the panel is on the phone with every
       one of its controls; score bug / stat card / summary / milestone /
       Match Intro go on and off air through the panel's own controls, the
       overlay is told, the phone shows the real ON AIR state, an ON AIR
       graphic needs a second tap to come off, "On air now" takes it off
     • CLIPPER: "Clip Done!" only once the laptop's clipper reports the file
       saved, matched by clip id (two clips at once, a failed one), Clip Now
     • MATCH: teams, batting/bowling, the bowler card; a laptop confirm() is
       asked on the phone; Run Out / Penalty open the panel's own popups

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

// The laptop's local Clipper / Stream Engine, standing in: keeps the clip
// jobs it is asked for, and reports them as the real ones do.
function makeEngine(){
  const jobs = new Map();
  return { jobs, set(clipId, status, extra){ const j = jobs.get(clipId); if(j) Object.assign(j, { status, localSaved: /SAVED|COMPLETE|SENT/.test(status) }, extra || {}); } };
}
function stubs(w, calls, engine){
  w.fetch = (url, opts) => {
    const u = new URL(String(url), base);
    let body = null;
    try{ body = opts && opts.body ? JSON.parse(opts.body) : null; }catch(e){}
    const local = (u.hostname === '127.0.0.1' && u.port === '5006') || (u.hostname === 'localhost' && u.port === '5005');
    calls.push({ url: String(url), path: u.pathname, local, body });
    let out = { success: true, ok: true, recordingActive: true, recording: true, jobs: [] };
    if(local && engine){
      if(u.pathname === '/clip' && body && body.clipId){
        if(!engine.jobs.has(body.clipId)) engine.jobs.set(body.clipId, { clipId: body.clipId, eventType: body.eventType, t0: body.timestamp, matchId: body.matchId, status: 'CUTTING' });
        out = { success: true, clipId: body.clipId };
      } else if(u.pathname.startsWith('/clip-jobs/')){
        const j = engine.jobs.get(decodeURIComponent(u.pathname.slice('/clip-jobs/'.length)));
        out = j ? { success: true, job: { ...j } } : { success: false, error: 'not found' };
      } else if(u.pathname === '/clip-jobs'){
        out = { success: true, jobs: [...engine.jobs.values()].map(j => ({ ...j })) };
      } else if(u.pathname === '/status'){
        out = { success: true, ffmpegAvailable: true, recording: { state: 'recording' }, recordingActive: true };
      }
    }
    const res = { ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(out))) };
    res.clone = () => ({ json: () => Promise.resolve(JSON.parse(JSON.stringify(out))) });
    return Promise.resolve(res);
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
  const engine = makeEngine();
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: `${base}/${file.replace('.html', '')}`, virtualConsole: vc,
    beforeParse(w){ stubs(w, calls, engine); Object.entries(opts.storage || {}).forEach(([k, v]) => w.localStorage.setItem(k, v)); } });
  const w = dom.window;
  await until(() => w.document.readyState === 'complete', 4000);
  w.eval(hostJs);       // <script src="/cricket-remote-host.js"> at the end of <body>
  const E = (c) => w.eval(c);
  E(`document.getElementById('match-id').value = ${JSON.stringify(room)}; document.getElementById('connect-btn').click();`);
  await until(() => E('!!(socket && socket.connected)'), 6000);
  await sleep(1400);   // the panel's first-connect hydration window
  if(opts.seed === false) return { dom, w, E, calls, engine, errors, $: (s) => w.document.querySelector(s), close: () => { try{ w.close(); }catch(e){} } };
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
  return { dom, w, E, calls, engine, errors, $: (s) => w.document.querySelector(s), close: () => { try{ w.close(); }catch(e){} },
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
    notes: () => [...w.document.querySelectorAll('#notes .note')].filter(n => !n.classList.contains('out')).map(n => n.textContent.replace(/\s+/g, ' ').trim()),
    sec: (id) => w.document.querySelector(`[data-sec-card="${id}"]`),
    secButton: (id, re) => { const c = w.document.querySelector(`[data-sec-card="${id}"]`); return c && [...c.querySelectorAll('button[data-op]')].find(b => re.test(b.textContent)); },
    onAir: () => [...w.document.querySelectorAll('#oa-list .oa-row span')].map(x => x.textContent),
    close: () => { try{ w.close(); }catch(e){} } };
}

const PANEL_FAILED = { P3: 'FAILED_PERMANENT', P1: 'CUT_FAILED' };
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
  await until(() => P.text('#conn-t') === 'Connected', 8000);
  eq(T('phone: paired straight from the QR, no login — Connected'), P.text('#conn-t'), 'Connected');
  eq(T('phone: the pair token leaves the address bar (a reload uses the saved pairing)'), [P.w.location.search, !!P.w.localStorage.getItem('cricketRemoteSession')], ['', true]);
  await until(() => L.E('window.__crRemote.phones.length') === 1, 4000);
  eq(T('laptop: 1 phone connected, shown on the button'), [L.E('window.__crRemote.phones.length'), L.$('#cr-remote-btn .cr-n').textContent], [1, '1']);
  await until(() => P.text('#runs') === '60/2', 4000);
  eq(T('phone shows the laptop\'s match: score, overs, batters, bowler'), [P.text('#runs'), P.text('#overs'), P.text('#p-s'), P.text('#p-ns'), P.text('#p-b'), P.text('#bat-name')],
    ['60/2', '12.1 / 20 ov', 'Harsh Rane 10 (8)', 'Sahil Gode 5 (6)', '🎯 Jamshed Alam 2.1-0-12-0', 'Kanga Kings']);
  ok(T('header: match, Match ID, laptop / clipper / graphics status'), /KK vs SS/.test(P.text('#mt-title')) && P.text('#mt-sub').includes(ROOM) && P.$('#ch-laptop').classList.contains('on') && P.$('#ch-gfx').classList.contains('on'),
    [P.text('#mt-title'), P.text('#mt-sub'), P.$('#ch-laptop').className, P.$('#ch-gfx').className].join(' | '));
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

  console.log('\n=== "Clip Done!" — only when the laptop has the clip ===');
  const fourId = fourClip && fourClip.body && fourClip.body.clipId;
  await until(() => P.notes().some(n => /FOUR clip/.test(n)), 4000);
  ok(T('phone: a clip note slides in at the top — the laptop is cutting the FOUR'), P.notes().some(n => /(Generating|Cutting) clip/.test(n) && /FOUR clip/.test(n)), JSON.stringify(P.notes()));
  await sleep(1600);
  ok(T('…and it does NOT say "Clip Done!" while the laptop is still cutting'), !P.notes().some(n => /Clip Done/.test(n)), JSON.stringify(P.notes()));
  L.engine.set(fourId, 'LOCAL_SAVED');
  await until(() => P.notes().some(n => /Clip Done/.test(n)), 5000);
  ok(T('the laptop\'s clipper reports the file saved → "🎬 Clip Done!" for the FOUR'), P.notes().some(n => /Clip Done/.test(n) && /FOUR clip/.test(n)), JSON.stringify(P.notes()));

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
  const sixId = clips(L, 'SIX')[0].body.clipId;
  // the single changed ends
  await until(() => /Sahil Gode/.test(P.text('#p-s')), 3000);
  eq(T('phone: strike changed after the single'), P.text('#p-s'), 'Sahil Gode 5 (6)');
  if(L.$('#ww-overlay').classList.contains('show')) L.$('#ww-skip').click();

  console.log('\n=== Laptop and phone at the same time ===');
  L.$('[data-ball="2"]').click();     // the laptop operator scores
  if(L.E('typeof maybePromptNewBowler') === 'function') L.E('maybePromptNewBowler()');
  await until(() => P.text('#runs') === '73/2', 3000);
  eq(T('a ball scored ON THE LAPTOP shows on the phone'), [P.text('#runs'), P.text('#overs')], ['73/2', '12.5 / 20 ov']);
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
  // two clips at once (the SIX still cutting, the WICKET just asked for) — each keeps its own note
  const wktId = clips(L, 'WICKET')[0].body.clipId;
  await until(() => P.notes().some(n => /WICKET clip/.test(n)) && P.notes().some(n => /SIX clip/.test(n)), 4000);
  ok(T('two clips at once: a note each (SIX, WICKET), both still cutting'), P.notes().filter(n => /(Generating|Cutting) clip/.test(n)).length >= 2, JSON.stringify(P.notes()));
  L.engine.set(wktId, PANEL_FAILED[tag], { error: 'Disk full on the laptop' });
  await until(() => P.notes().some(n => /Clip failed/.test(n)), 5000);
  ok(T('the WICKET clip fails on the laptop → "Clip failed" with the reason; the SIX is still cutting'),
    P.notes().some(n => /Clip failed/.test(n) && /Disk full/.test(n)) && P.notes().some(n => /SIX clip/.test(n) && /(Generating|Cutting)/.test(n)) && !P.notes().some(n => /Clip Done/.test(n) && /SIX/.test(n)), JSON.stringify(P.notes()));
  L.engine.set(sixId, 'LOCAL_SAVED');
  await until(() => P.notes().some(n => /Clip Done/.test(n) && /SIX clip/.test(n)), 5000);
  ok(T('…then the SIX is saved → "Clip Done!" for the SIX (not mixed up with the WICKET)'), P.notes().some(n => /Clip Done/.test(n) && /SIX clip/.test(n)), JSON.stringify(P.notes()));
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
  const bowlIn = P.$$('#sheet-body input[type=text]').find(i => /#newover-modal-input$/.test(i.dataset.ref));
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
  eq(T('phone shows 73/3 (13.0) and the new bowler'), [P.text('#runs'), P.text('#overs'), P.text('#p-b')], ['73/3', '13.0 / 20 ov', '🎯 Shubham Mane 0.0-0-0-0']);

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

  console.log('\n=== GRAPHICS: every graphics card of the laptop panel, live ===');
  const want = ['scorebug', 'bcg', 'statcards', 'summary', 'milestones', 'tournament'].concat(tag === 'P3' ? ['playercards'] : []);
  await until(() => want.every(id => P.sec(id)), 4000);
  const gfxIds = P.$$('#gfx-secs [data-sec-card]').map(e => e.dataset.secCard);
  ok(T('the Graphics tab has every graphics card of the panel: ' + want.join(', ')), want.every(id => gfxIds.includes(id)), JSON.stringify(gfxIds));
  ok(T('…named as on the laptop (Broadcast Graphics, Summary Graphics, …)'), /Broadcast Graphics/.test(P.sec('bcg').textContent) && /Summary Graphics/.test(P.sec('summary').textContent) && /Milestone/.test(P.sec('milestones').textContent));
  for(const id of want){
    const counts = L.E(`(() => {
      const id = ${JSON.stringify(id)};
      const roots = window.__crRemote.sectionRoots(id).filter(Boolean);
      const ex = window.__crRemote.sectionExclude(id);
      const vis = (el, root) => { for(let n = el; n; n = n.parentElement){ if(ex.includes(n)) return false; if(!(n.tagName === 'SELECT' && n._proDD)){ if(n.hidden) return false; const cs = getComputedStyle(n); if(cs.display === 'none' || cs.visibility === 'hidden') return false; } if(n === root) return true; } return true; };
      const seen = new Set(); let n = 0;
      roots.forEach(root => [root, ...root.querySelectorAll('*')].forEach(el => {
        if(!el.matches('button, input, select, textarea') || seen.has(el)) return;
        seen.add(el);
        if(el.closest('.pro-dd') || (el.tagName === 'INPUT' && /^(hidden|password|file|color)$/.test(el.type))) return;
        if(el.tagName === 'SELECT' && el._proDD){ if((el._proDD.wrap && !vis(el._proDD.wrap, root)) || !vis(el.parentElement, root)) return; n++; return; }
        if(!vis(el, root) || (el.tagName === 'BUTTON' && !el.textContent.trim())) return;
        n++;
      }));
      const sec = window.__crRemote.readSection(id);
      const m = ((sec && sec.items) || []).reduce((a, it) => a + (it.k === 'seg' ? it.opts.length : ['b', 'tg', 's', 'i'].includes(it.k) ? 1 : 0), 0);
      return [n, m];
    })()`);
    ok(T(`"${id}": all ${counts[0]} controls the laptop shows in it are on the phone`), counts[0] > 0 && counts[1] === counts[0], `laptop ${counts[0]} · phone ${counts[1]}`);
  }

  console.log('\n=== Score bug: the real state, both ways ===');
  const sbBtn = () => P.sec('scorebug') && P.sec('scorebug').querySelector('.tg');
  ok(T('score bug switch: ON AIR on the phone, and in "On air now"'), sbBtn() && sbBtn().classList.contains('on') && /ON AIR/.test(sbBtn().textContent) && P.onAir().some(x => /Scorecard/.test(x)), P.onAir().join(','));
  const ovSeen = [];
  overlay.on('liveCricketScore', (st) => { if(st && 'visible' in st) ovSeen.push('visible:' + st.visible); });
  ['cricketPlayerStat', 'cricketHidePlayerStat', 'cricketEvent', 'cricketInningsSummary', 'cricketHideInningsSummary', 'cricketGraphicState'].forEach(ev => overlay.on(ev, (d) => ovSeen.push(ev + (ev === 'cricketGraphicState' ? ':' + ((d && d.mode) || 'off') : ''))));
  P.tap(sbBtn());
  await until(() => L.E('state.visible') === false, 3000);
  eq(T('phone switch → the laptop\'s own switch turns the score bug off'), [L.E('state.visible'), L.$('#visible-toggle').checked], [false, false]);
  await until(() => ovSeen.includes('visible:false'), 3000);
  ok(T('…the overlay is told'), ovSeen.includes('visible:false'));
  await until(() => sbBtn() && !sbBtn().classList.contains('on') && !P.onAir().some(x => /Scorecard/.test(x)), 3000);
  ok(T('…the phone shows it OFF AIR and drops it from "On air now"'), sbBtn() && !sbBtn().classList.contains('on') && /OFF AIR/.test(sbBtn().textContent) && !P.onAir().some(x => /Scorecard/.test(x)));
  L.$('#visible-toggle').click();
  await until(() => sbBtn() && sbBtn().classList.contains('on'), 4000);
  ok(T('switched back ON on the laptop → the phone shows ON AIR again'), sbBtn() && sbBtn().classList.contains('on') && P.onAir().some(x => /Scorecard/.test(x)));

  console.log('\n=== Stat card on, then off from "On air now" ===');
  const psBtn = () => P.secButton('statcards', /Player Stat Card/i);
  ok(T('the Player Stat Card switch is on the phone'), !!psBtn());
  P.tap(psBtn());
  await until(() => L.$('#player-stat-toggle').checked, 3000);
  eq(T('phone → the laptop\'s Player Stat Card switch is on'), [L.$('#player-stat-toggle').checked, !!L.E('state.showPlayerStatCard')], [true, true]);
  await until(() => ovSeen.includes('cricketPlayerStat'), 3000);
  ok(T('…the overlay got the player card'), ovSeen.includes('cricketPlayerStat'));
  await until(() => P.onAir().some(x => /Player stat card/.test(x)), 3000);
  ok(T('…"On air now" lists it'), P.onAir().some(x => /Player stat card/.test(x)), P.onAir().join(','));
  const offBtn = [...P.$$('#oa-list .oa-row')].find(r => /Player stat card/.test(r.textContent)).querySelector('button');
  P.tap(offBtn);
  await until(() => !L.$('#player-stat-toggle').checked, 3000);
  await until(() => ovSeen.includes('cricketHidePlayerStat'), 3000);
  ok(T('TAKE OFF → the laptop switch is off, the overlay hides the card'), !L.$('#player-stat-toggle').checked && ovSeen.includes('cricketHidePlayerStat'));
  await until(() => !P.onAir().some(x => /Player stat card/.test(x)), 3000);
  ok(T('…and it leaves "On air now"'), !P.onAir().some(x => /Player stat card/.test(x)));

  console.log('\n=== Summary + milestone graphics ===');
  P.tap(P.secButton('summary', /^Show Now$/));
  await until(() => ovSeen.includes('cricketInningsSummary'), 3000);
  ok(T('Innings Summary "Show Now" from the phone → on the overlay'), ovSeen.includes('cricketInningsSummary'));
  P.tap(P.secButton('summary', /^Hide Now$/));
  await until(() => ovSeen.includes('cricketHideInningsSummary'), 3000);
  ok(T('"Hide Now" → off the overlay'), ovSeen.includes('cricketHideInningsSummary'));
  P.tap(P.secButton('milestones', /Drinks Break/));
  await until(() => ovSeen.includes('cricketEvent'), 3000);
  ok(T('"Drinks Break" from the phone → the overlay plays it'), ovSeen.includes('cricketEvent'));
  await until(() => /Last sent to the overlay/.test(P.text('#gfxlog')), 3000);
  ok(T('the phone confirms what the laptop last sent to the overlay'), /Last sent to the overlay: .+📱/.test(P.text('#gfxlog')), P.text('#gfxlog'));

  console.log('\n=== Broadcast Graphics: Match Intro on and off air ===');
  const introTile = () => P.secButton('bcg', /MATCH INTRO/);
  ok(T('MATCH INTRO tile, OFF'), introTile() && !introTile().classList.contains('on'));
  P.tap(introTile());
  await until(() => L.$('#bcg-intro-btn').classList.contains('on'), 4000);
  ok(T('phone → the laptop runs its own Match Intro (the server holds it ON AIR)'), L.$('#bcg-intro-btn').classList.contains('on'));
  await until(() => ovSeen.some(x => /^cricketGraphicState:(?!off)/.test(x)), 3000);
  ok(T('…the overlay is told'), ovSeen.some(x => /^cricketGraphicState:(?!off)/.test(x)), ovSeen.join(','));
  await until(() => introTile() && introTile().classList.contains('on') && P.onAir().some(x => /MATCH INTRO/.test(x)), 4000);
  ok(T('…the phone tile shows ON AIR, and "On air now" lists it'), introTile() && introTile().classList.contains('on') && /ON AIR/.test(introTile().textContent));
  P.tap(introTile());
  await sleep(700);
  ok(T('one tap on an ON AIR graphic does nothing but ask — no accidental off air'), L.$('#bcg-intro-btn').classList.contains('on') && /TAP TO TAKE OFF/.test(introTile().textContent));
  P.tap(introTile());
  await until(() => !L.$('#bcg-intro-btn').classList.contains('on'), 4000);
  ok(T('the second tap takes it off air on the laptop'), !L.$('#bcg-intro-btn').classList.contains('on'));
  await until(() => introTile() && !introTile().classList.contains('on') && !P.onAir().some(x => /MATCH INTRO/.test(x)), 4000);
  ok(T('…and the phone follows'), introTile() && !introTile().classList.contains('on'));

  console.log('\n=== A control added to a panel card later + a laptop confirm() ===');
  L.E(`(() => { const b = document.createElement('button'); b.className = 'full small'; b.id = 'test-confirm-btn'; b.textContent = 'Test Confirm Graphic';
    b.addEventListener('click', () => { if(confirm('Really put the test graphic on air?')) window.__confirmed = (window.__confirmed || 0) + 1; });
    document.getElementById('card-milestone-trigger').appendChild(b); })()`);
  await until(() => P.secButton('milestones', /Test Confirm Graphic/), 4000);
  ok(T('a new button in a graphics card shows up on the phone by itself'), !!P.secButton('milestones', /Test Confirm Graphic/));
  P.tap(P.secButton('milestones', /Test Confirm Graphic/));
  await until(() => /Really put the test graphic on air/.test(P.text('#sheet-body')) && P.$('#sheet').classList.contains('show'), 4000);
  ok(T('the laptop\'s confirm() is asked ON THE PHONE (the laptop is never stuck on a dialog)'), /Really put the test graphic/.test(P.text('#sheet-body')) && !L.E('window.__confirmed'));
  P.tap(P.sheetButton(/^Cancel$/));
  await sleep(500);
  ok(T('Cancel → nothing happens on the laptop'), !L.E('window.__confirmed'));
  await until(() => !P.$('#sheet').classList.contains('show'), 2000);
  P.tap(P.secButton('milestones', /Test Confirm Graphic/));
  await until(() => P.$('#sheet').classList.contains('show') && P.sheetButton(/^Confirm$/), 4000);
  P.tap(P.sheetButton(/^Confirm$/));
  await until(() => L.E('window.__confirmed') === 1, 4000);
  eq(T('Confirm → done on the laptop, once'), L.E('window.__confirmed'), 1);
  L.E(`document.getElementById('test-confirm-btn').remove()`);

  console.log('\n=== CLIPPER tab ===');
  ok(T('clipper status: ' + (tag === 'P3' ? 'Stream Engine' : 'Clipper Helper') + ', recording state'), new RegExp(tag === 'P3' ? 'Stream Engine' : 'Clipper Helper').test(P.text('#cstat')) && /Recording/.test(P.text('#cstat')), P.text('#cstat'));
  const jobsTxt = P.$$('#jobs .job').map(j => j.textContent.replace(/\s+/g, ' '));
  ok(T('clip activity: the FOUR (saved), SIX (saved), WICKET (failed) pressed on the phone'),
    jobsTxt.some(t => /FOUR/.test(t) && /Saved/.test(t) && /📱/.test(t)) && jobsTxt.some(t => /SIX/.test(t) && /Saved/.test(t)) && jobsTxt.some(t => /WICKET/.test(t) && /Disk full/.test(t)), JSON.stringify(jobsTxt));
  L.calls.length = 0;
  P.tap(P.$('#clip-now'));
  await until(() => clips(L, 'HIGHLIGHT').length, 4000);
  eq(T('Clip Now → the laptop cuts a HIGHLIGHT from its recording'), clips(L, 'HIGHLIGHT').length, 1);
  await until(() => P.notes().some(n => /Highlight clip/.test(n)), 4000);
  ok(T('…with its own note'), P.notes().some(n => /Highlight clip/.test(n) && /(Generating|Cutting)/.test(n)), JSON.stringify(P.notes()));
  L.engine.set(clips(L, 'HIGHLIGHT')[0].body.clipId, 'LOCAL_SAVED');
  await until(() => P.notes().some(n => /Clip Done/.test(n) && /Highlight/.test(n)), 5000);
  ok(T('…"Clip Done!" once the laptop saved it'), P.notes().some(n => /Clip Done/.test(n) && /Highlight/.test(n)), JSON.stringify(P.notes()));
  if(L.$('#hl-prompts .hl-prompt')) L.E('answerOldestHighlightPrompt(false)');
  ok(T('the recording card of the laptop is on the phone (Drive / folder settings stay on the laptop)'), !!P.sec('recording') && !/Connect Google Drive|Choose Folder/.test(P.sec('recording').textContent), P.sec('recording') ? '' : 'no recording card');

  console.log('\n=== MATCH tab ===');
  ok(T('teams, Match ID, batting and bowling of this innings'), /Kanga Kings/.test(P.text('#minfo')) && /Shivaji Strikers/.test(P.text('#minfo')) && P.text('#minfo').includes(ROOM)
    && /Rohan Raje/.test(P.text('#bat-tbl')) && /Harsh Rane/.test(P.text('#bat-tbl')) && /Shubham Mane/.test(P.text('#bowl-tbl')), [P.text('#minfo'), P.text('#bat-tbl'), P.text('#bowl-tbl')].join(' | ').slice(0, 300));
  const matchIds = P.$$('#match-secs [data-sec-card]').map(e => e.dataset.secCard);
  ok(T('the panel\'s match controls: at the crease, bowler, new batsman, match events'), ['crease', 'bowler', 'newbat', 'events'].every(id => matchIds.includes(id)), JSON.stringify(matchIds));
  P.tap(P.$('#a-bowler'));
  await until(() => /Bowler/.test(P.text('#sheet-body')) && P.$('#sheet').classList.contains('show'), 3000);
  ok(T('"Bowler" on the scoring screen opens the laptop\'s bowler card in a sheet'), /Set \/ Change Bowler/.test(P.text('#sheet-body')), P.text('#sheet-body').slice(0, 160));
  P.tap(P.$('#sheet-hide'));
  await until(() => !P.$('#sheet').classList.contains('show'), 2000);

  console.log('\n=== Run Out and Penalty: the panel\'s own popups ===');
  P.tap(P.$('#a-runout'));
  await until(() => L.$('#wd-overlay').classList.contains('show'), 3000);
  ok(T('Run Out → the laptop\'s Wicket Details, Run Out already chosen'), L.$('#wd-overlay').classList.contains('show') && L.$('#wd-types [data-wd-type="Run Out"]').classList.contains('on'));
  await until(() => P.sheetButton(/^Run Out$/) && P.sheetButton(/^Run Out$/).classList.contains('on'), 3000);
  ok(T('…the phone shows it chosen'), P.sheetButton(/^Run Out$/) && P.sheetButton(/^Run Out$/).classList.contains('on'));
  P.tap(P.sheetButton(/^Cancel$/));
  await until(() => !L.$('#wd-overlay').classList.contains('show'), 3000);
  ok(T('Cancel on the phone → nothing recorded'), score(L) === '73/3 (13.0)' && !L.$('#wd-overlay').classList.contains('show'), score(L));
  if(!P.$('#a-penalty').disabled){
    P.tap(P.$('#a-penalty'));
    await until(() => L.$('#penalty-modal-overlay').classList.contains('show'), 3000);
    await until(() => /Penalty/i.test(P.text('#sheet-body')), 3000);
    ok(T('Penalty → the laptop\'s Penalty Runs popup, on the phone too'), L.$('#penalty-modal-overlay').classList.contains('show') && /Penalty/i.test(P.text('#sheet-body')));
    P.tap(P.sheetButton(/Cancel/));
    await until(() => !L.$('#penalty-modal-overlay').classList.contains('show'), 3000);
    ok(T('…cancelled from the phone'), !L.$('#penalty-modal-overlay').classList.contains('show'));
  }

  console.log('\n=== The same command twice / a stale Undo ===');
  const session = P.w.localStorage.getItem('cricketRemoteSession');
  const raw = P.w.io('/cricket-remote', { forceNew: true });
  const ack = (ev, d) => new Promise((resolve) => raw.timeout(9000).emit(ev, d, (err, r) => resolve(err ? { err: String(err) } : r)));
  await until(() => raw.connected, 4000);
  const j = await ack('remote:join', { session, label: 'Test' });
  eq(T('the saved session rejoins (a reload / a dropped line)'), [j.ok, j.matchId], [true, ROOM]);
  ok(T('…and gets the laptop\'s latest at once: score, graphics cards, on-air list, clips'), j.parts && j.parts.score && j.parts.score.runs === L.E('state.score.runs') && j.parts['sec:bcg'] && Array.isArray(j.parts.onair) && j.parts.clips);
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

  console.log('\n=== Rapid taps: 1, 2, 1 without waiting ===');
  if(L.$('#ww-overlay').classList.contains('show')) L.$('#ww-skip').click();
  const n0 = L.E('state.ballLog.length'), r0 = L.E('state.score.runs');
  ['1', '2', '1'].forEach(v => P.tap(P.$(`#pad [data-ball="${v}"]`)));
  await until(() => L.E('state.ballLog.length') === n0 + 3, 8000);
  await sleep(600);
  eq(T('three quick taps → exactly three balls, in order, +4 runs'), [L.E('state.ballLog.length') - n0, L.E('state.score.runs') - r0, L.E('state.ballLog.slice(-3).map(e => e.ballType).join(",")')], [3, 4, '1,2,1']);
  await until(() => P.text('#runs') === `${L.E('state.score.runs')}/3`, 3000);
  ok(T('…the phone ends on the laptop\'s score'), P.text('#runs') === `${L.E('state.score.runs')}/3`, P.text('#runs'));
  if(L.$('#ww-overlay').classList.contains('show')) L.$('#ww-skip').click();

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
  await until(() => P2.text('#conn-t') === 'Connected', 8000);
  ok(T('a second phone pairs with the new code'), P2.text('#conn-t') === 'Connected');
  const laptopStorage = L.storage();
  L.close();
  await until(() => /offline/.test(P2.text('#conn-t')), 6000);
  eq(T('laptop closed → phone shows "Laptop offline" (and says so under the header)'), [P2.text('#conn-t'), P2.$('#netbar').classList.contains('show')], ['Laptop offline', true]);
  P2.tap(P2.$('#pad [data-ball="4"]'));
  await until(() => P2.$$('#toasts .toast').some(t => /offline/i.test(t.textContent)), 4000);
  ok(T('a press is refused with "Laptop is offline — nothing was scored"'), P2.$$('#toasts .toast').some(t => /Laptop is offline — nothing was scored/.test(t.textContent)));

  console.log('\n=== The laptop comes back (browser reopened on the same match) ===');
  const L2 = await bootLaptop(file, ROOM, { storage: laptopStorage, seed: false });
  await until(() => P2.text('#conn-t') === 'Connected', 8000);
  eq(T('the phone is live again by itself — no new QR needed'), P2.text('#conn-t'), 'Connected');
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
  ok('server serves the phone page at /cricket-remote', /Scorvix Remote/.test(await get(port, '/cricket-remote')));
  ok('…and the laptop script', /PHONE REMOTE/.test(await get(port, '/cricket-remote-host.js')));
  await suite('cricket-panel3.html');
  await suite('cricket-panel.html');
  await lockSuite(mem);
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
