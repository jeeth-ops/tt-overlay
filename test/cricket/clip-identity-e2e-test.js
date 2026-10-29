/* 🆔 EVERY DELIVERY PLAYS ITS OWN CLIP — even when deliveries share an over.ball.

   A Wide or a No Ball keeps the over.ball of the ball before it, so two
   different deliveries can both read 19.1 (a FOUR, then a No Ball) or 19.5
   (a wicket, then a Wide + Run Out). Each has its own clip, and nothing may
   ever show one delivery's clip on the other.

   End to end, nothing stood in for but the camera:
     • the REAL cricket-panel.html (jsdom) scores the last over — FOUR then
       NO BALL, FOUR then WIDE, a second WIDE, another NO BALL, singles, a
       caught WICKET at 19.5 and then a WIDE + RUN OUT also at 19.5 — and
       sends its deliveries over the real socket, its clip requests to a
       stand-in Clipper helper and its classifications to the real server;
     • that helper cuts each clip as a real MP4 of its OWN colour and sends
       it the way the real one does (/api/clips/ingest, then /api/clips/attach)
       — some late (after the classify), one twice, one with a stale
       press-time ballMeta after it had been classified;
     • the REAL server.js (in-memory MongoDB, a stand-in R2 bucket);
     • the scorecard in Chromium: finished and live, every WATCH REPLAY
       played and the colour of the frame on screen read back; Highlights;
       the owner's Attach / Replace on one of the two 19.5 deliveries (and
       then the other); a reload and a fresh visit; older clips that name no
       delivery, linked by the migration only when one delivery fits.

     NODE_PATH=$(npm root -g) node test/cricket/clip-identity-e2e-test.js
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const head = (t) => console.log('\n######## ' + t + ' ########');
const ROOT = path.join(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-identity-'));

// ---- the stand-in R2 bucket (installed before server.js loads) ----
const bucket = new Map();           // key -> Buffer
class Cmd { constructor(input){ this.input = input; } }
class PutObjectCommand extends Cmd {}
class DeleteObjectCommand extends Cmd {}
class GetObjectCommand extends Cmd {}
class S3Client {
  async send(cmd){
    const k = cmd.input.Key;
    if(cmd instanceof PutObjectCommand){ bucket.set(k, Buffer.from(cmd.input.Body)); return {}; }
    if(cmd instanceof DeleteObjectCommand){ bucket.delete(k); return {}; }
    const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e;
  }
}
const s3Path = require.resolve('@aws-sdk/client-s3');
require.cache[s3Path] = { id: s3Path, filename: s3Path, loaded: true, exports: { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } };
const R2_HOST = 'clips.example.test';
Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET_NAME: 'clips', R2_PUBLIC_URL: `https://${R2_HOST}` });

const { bootServer } = require('../server-boot.js');
const { connect } = require('../socketio-polling-client.js');
const { chromium } = require('playwright');
const OWNER = { email: 'chhayajeeth@gmail.com', uid: 'owner' };

function call(port, method, url, { json, raw, headers } = {}){
  return new Promise((resolve, reject) => {
    const body = raw || (json ? Buffer.from(JSON.stringify(json)) : null);
    const h = Object.assign({}, json ? { 'Content-Type': 'application/json' } : raw ? { 'Content-Type': 'video/mp4' } : {}, body ? { 'Content-Length': body.length } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch(e){} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if(body) r.write(body);
    r.end();
  });
}

// ---- every clip is a real video of its own colour ----
const PALETTE = { red: [255, 0, 0], green: [0, 200, 0], blue: [0, 0, 255], yellow: [255, 255, 0], magenta: [255, 0, 255], cyan: [0, 255, 255],
  orange: [255, 128, 0], purple: [128, 0, 255], white: [255, 255, 255], pink: [255, 120, 190], lime: [150, 255, 0], navy: [0, 0, 110], teal: [0, 128, 128], brown: [120, 60, 0] };
const COLOURS = Object.keys(PALETTE);
function makeVideo(colour){
  const f = path.join(TMP, colour + '.mp4');
  if(!fs.existsSync(f)){
    const hex = PALETTE[colour].map(v => v.toString(16).padStart(2, '0')).join('');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=160x90:d=2:r=10`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', f]);
  }
  return f;
}
const nearest = (rgb) => COLOURS.map(c => [c, PALETTE[c].reduce((s, v, i) => s + (v - rgb[i]) ** 2, 0)]).sort((a, b) => a[1] - b[1])[0][0];
// the colour of a picture's middle (a PNG screenshot, or a video's first frame)
function colourOf(file){
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'crop=8:8:(iw-8)/2:(ih-8)/2,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return nearest([raw[0], raw[1], raw[2]]);
}
function colourOfBytes(buf, ext){
  const f = path.join(TMP, 'probe-' + Math.random().toString(36).slice(2) + ext);
  fs.writeFileSync(f, buf);
  try { return colourOf(f); } finally { fs.unlinkSync(f); }
}

// ---- the real panel in jsdom, its socket and its fetches bridged ----
function bootPanel(port, M, helper){
  const { JSDOM, VirtualConsole } = require('jsdom');
  const html = fs.readFileSync(path.join(ROOT, 'cricket-panel.html'), 'utf8').replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole(); const errors = []; vc.on('jsdomError', (e) => errors.push(e.message));
  let conn = null; const queue = [];
  const socketLike = {
    on(){}, connected: true, disconnect(){}, io: { on(){} },
    emit(ev, payload, ack){
      if(ev !== 'logBall' && ev !== 'updateCricketScore') { if(typeof ack === 'function') ack({ ok: true }); return; }
      const go = async () => {
        if(ev === 'logBall'){ const r = await conn.emitAck('logBall', payload); if(typeof ack === 'function') ack(r); }
        else conn.emit('updateCricketScore', payload);
      };
      queue.push(go);
    }
  };
  // one socket message at a time, in the order the panel sent them
  (async function pump(){ for(;;){ const job = queue.shift(); if(job){ try { await job(); } catch(e){ errors.push('bridge: ' + e.message); } } else await sleep(15); } })();
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: `https://example.test/cricket-panel?room=${M}`, virtualConsole: vc, beforeParse(w){
    w.io = () => socketLike;
    w.fetch = async (url, opts) => {
      const u = String(url);
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      const resp = (status, j) => ({ ok: status < 400, status, json: async () => j });
      if(u === 'http://localhost:5005/clip') return resp(200, helper.clip(body));
      if(u === 'http://localhost:5005/clip-meta') return resp(200, helper.meta(body));
      if(u.startsWith('http://localhost:5005')) return resp(404, { success: false });
      if(u === '/api/clips/classify'){ const r = await call(port, 'POST', '/api/clips/classify', { json: body }); return resp(r.status, r.json); }
      return resp(404, { success: false });
    };
    w.alert = () => {}; w.confirm = () => true;
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
    Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
    w.HTMLMediaElement.prototype.play = () => Promise.resolve(); w.HTMLMediaElement.prototype.pause = () => {};
    w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
    w.IntersectionObserver = w.IntersectionObserver || class { observe(){} unobserve(){} disconnect(){} };
    w.ResizeObserver = w.ResizeObserver || class { observe(){} unobserve(){} disconnect(){} };
    w.scrollTo = () => {};
  } });
  const w = dom.window;
  return { w, errors, setConn: (c) => { conn = c; }, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s), J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)) };
}

(async () => {
  const { port, mem } = await bootServer({ idTokens: { 'owner-token': OWNER } });
  const M = 'CLIPID' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const owner = { Authorization: 'Bearer owner-token' };

  // ---- the stand-in Clipper helper: cuts each request as its own colour ----
  const requests = [];                    // { clipId, eventType, timestamp, ballMeta, colour }
  const latestMeta = {};                  // clipId -> the newest /clip-meta from the panel
  const late = new Set();                 // clip ids sent after their classify
  let colourNo = 0;
  const ingest = async (r) => {
    const bytes = fs.readFileSync(makeVideo(r.colour));
    const q = `/api/clips/ingest?matchId=${r.matchId}&eventType=${r.eventType}&timestamp=${r.timestamp}&clipId=${r.clipId}`;
    await call(port, 'POST', q, { raw: bytes, headers: { 'X-Ball-Meta': JSON.stringify(r.ballMeta || {}) } });
    // the helper's last stage: the clip's place in the match, from what it knows now
    const m = latestMeta[r.clipId];
    await call(port, 'POST', '/api/clips/attach', { json: { clipMeta: Object.assign({ matchId: r.matchId, clipId: r.clipId, eventType: r.eventType, timestamp: r.timestamp }, m ? { outcomeType: m.eventType, outcomeLabel: m.outcomeLabel, isHighlight: m.isHighlight } : {}), ballMeta: (m && m.ballMeta) || r.ballMeta } });
  };
  const helper = {
    clip(body){
      const r = Object.assign({}, body, { colour: COLOURS[colourNo++ % COLOURS.length] });
      requests.push(r);
      setTimeout(() => ingest(r).catch(e => console.log('ingest', e.message)), late.has('next') ? 7000 : 250);
      if(late.has('next')){ late.delete('next'); late.add(r.clipId); }
      return { success: true, recordingActive: true };
    },
    meta(body){ latestMeta[body.clipId] = body; return { success: true }; }
  };

  const P = bootPanel(port, M, helper);
  P.setConn(await connect(port, { uid: M }));
  await sleep(100);
  const click = (sel) => { const el = P.$(sel); if(!el) throw new Error('no ' + sel); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
  const A = ['Prince Badiani', 'Karsh Kothari', 'Alim Shaikh', 'Rahul Mehta', 'Sahil Gode', 'Yogesh Pawar', 'Iqbal Abdullah', 'Shubham Mane', 'Harsh Rane', 'Aman Khan', 'Atharva Kale'];
  const B = ['Mubasshir Zakir Shaikh', 'Viraj Jadhav', 'Jugraj Mehta', 'Het Patel', 'Ridhay Khandare', 'Parshad Bodke', 'Nikhil Giri', 'Abhinab Saha', 'Aditya Parab', 'Tanay Rao', 'Omkar Sawant'];
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A'; state.wagonWheelOn = false;
    document.getElementById('match-id').value = ${JSON.stringify(M)};
    state.teamA.name = 'Dr. D.Y Patil Sports Academy'; state.teamA.short = 'DYP';
    state.teamB.name = 'New Hind Sporting Club'; state.teamB.short = 'NHSC';
    state.teamA.players = ${JSON.stringify(A)}.map((n, i) => ({ id: 'a' + (i + 1), name: n, isXI: true }));
    state.teamB.players = ${JSON.stringify(B)}.map((n, i) => ({ id: 'b' + (i + 1), name: n, isXI: true }));
    state.striker    = { name:'Prince Badiani', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Karsh Kothari', id:'a2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Mubasshir Zakir Shaikh', id:'b1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    state.score.overs = 19; state.score.balls = 0; state.score.runs = 230; state.score.wickets = 4;
    history = []; ballOutbox = []; pendingWicketDelivery = null;
    renderPanel();
  `);
  // One step of the over: what it records, and which clip requests it made.
  const steps = [];
  const step = async (label, fn, { highlight = false, delayed = false } = {}) => {
    const before = requests.length;
    if(delayed) late.add('next');
    if(highlight) P.E('pressHighlight()');
    await sleep(40);
    fn();
    if(P.$('#hl-prompts .hl-prompt')) P.E('answerOldestHighlightPrompt(true)');
    const d = P.J('state.ballLog[state.ballLog.length - 1]');
    steps.push({ label, deliveryId: d.deliveryId, over: d.over, ballType: d.ballType, striker: d.striker, clips: requests.slice(before).map(r => r.clipId) });
    await sleep(60);
  };
  const out = (o) => {
    P.E('openWicketModal()');
    [...P.w.document.querySelectorAll('#wd-types [data-wd-type]')].find(b => b.dataset.wdType === o.type).dispatchEvent(new P.w.Event('click', { bubbles: true }));
    if(o.delivery) click(`[data-wd-delivery="${o.delivery}"]`);
    if(o.who) click(`[data-wd-who="${o.who}"]`);
    if(o.fielder) P.E(`wdSetFielder(${JSON.stringify(o.fielder)}); renderWicketDetails();`);
    if(o.type === 'Run Out') click('[data-wd-crossed="no"]');
    click('#wd-confirm');
    if(P.$('#newbat-modal-overlay').classList.contains('show')){
      const sel = P.$('#newbat-modal-select'); const next = [...sel.options].map(x => x.value).filter(Boolean)[0];
      if(next){ sel.value = next; sel.dispatchEvent(new P.w.Event('change', { bubbles: true })); }
      click('#newbat-modal-submit');
    }
  };

  head('1. The last over, scored on the real panel');
  await step('FOUR', () => P.E(`recordBall('4')`));
  await step('NO BALL after the FOUR', () => P.E(`recordBall('Nb', { runsOffBat: 0 })`), { highlight: true });
  await step('FOUR', () => P.E(`recordBall('4')`));
  await step('WIDE after the FOUR', () => P.E(`recordBall('Wd', { extraRuns: 0 })`), { highlight: true });
  await step('a second WIDE (its clip uploads late)', () => P.E(`recordBall('Wd', { extraRuns: 0 })`), { highlight: true, delayed: true });
  await step('NO BALL straight after', () => P.E(`recordBall('Nb', { runsOffBat: 0 })`), { highlight: true });
  await step('single', () => P.E(`recordBall('1')`));
  await step('single to long-on', () => P.E(`recordBall('1')`));
  await step('WICKET — caught', () => out({ type: 'Caught', fielder: 'b2' }));
  await step('WIDE + RUN OUT (its clip uploads late)', () => out({ type: 'Run Out', delivery: 'wide', who: 'striker', fielder: 'b3' }), { delayed: true });
  const S = (label) => steps.find(s => s.label === label);
  const labels = steps.map(s => `${s.over} ${s.ballType}`);
  eq('the deliveries as the panel numbered them: a FOUR and a No Ball both 19.1, a FOUR and two Wides and a No Ball all 19.2, two wickets both 19.5',
    labels, ['19.1 4', '19.1 Nb', '19.2 4', '19.2 Wd', '19.2 Wd', '19.2 Nb', '19.3 1', '19.4 1', '19.5 W', '19.5 WdW']);
  eq('every delivery has its own id', new Set(steps.map(s => s.deliveryId)).size === steps.length && steps.every(s => !!s.deliveryId), true);
  eq('each FOUR, each Wide / No Ball the operator clipped and each wicket made exactly one clip request', steps.map(s => s.clips.length), [1, 1, 1, 1, 1, 1, 0, 0, 1, 1]);

  // the helper sends one clip twice (a retry after a lost answer)
  const first = requests[0];
  await sleep(500);
  await ingest(first);
  // wait for every clip: received, on R2, classified
  const expected = new Map();             // clipId -> deliveryId
  steps.forEach(s => s.clips.forEach(c => expected.set(c, s.deliveryId)));
  const docs = async () => mem.collection('clips').find({ matchId: M }).toArray();
  const ready = async () => { const d = await docs(); return d.length === expected.size && d.every(c => c.r2Status === 'uploaded' && c.deliveryId); };
  for(let i = 0; i < 200 && !(await ready()); i++) await sleep(100);
  // …and a stale press-time attach for the late wicket clip, after it was classified
  const w2 = requests.find(r => r.clipId === S('WIDE + RUN OUT (its clip uploads late)').clips[0]);
  await call(port, 'POST', '/api/clips/attach', { json: { clipMeta: { matchId: M, clipId: w2.clipId, eventType: 'WICKET', timestamp: w2.timestamp }, ballMeta: w2.ballMeta } });

  head('2. In the database: every clip names ITS delivery');
  const balls = await mem.collection('balls').find({ matchId: M }).toArray();
  eq('the ten deliveries are stored once each, under the ids the panel minted', [balls.length, steps.every(s => balls.some(b => b.ballUid === s.deliveryId))], [10, true]);
  const all = await docs();
  eq('one clip record per clip — the clip sent twice is still one', all.length, expected.size);
  eq('every clip names the delivery it was cut for (FOUR ≠ No Ball at 19.1; FOUR ≠ Wide ≠ Wide ≠ No Ball at 19.2; caught ≠ Wide + Run Out at 19.5)',
    all.map(c => [c.clipId, c.deliveryId]).sort(), [...expected.entries()].sort());
  const byClip = (id) => all.find(c => c.clipId === id);
  const ballOf = (s) => balls.find(b => b.ballUid === s.deliveryId);
  const wk1 = byClip(S('WICKET — caught').clips[0]), wk2 = byClip(w2.clipId);
  eq('…the two 19.5 wicket clips: the caught batter and the run-out batter, each on its own delivery',
    [wk1.over, wk1.ballInOver, wk1.dismissedPlayerName, wk1.dismissalType, wk2.over, wk2.ballInOver, wk2.dismissedPlayerName, wk2.dismissalType],
    [19, 5, ballOf(S('WICKET — caught')).dismissal.batter, 'Caught', 19, 5, ballOf(S('WIDE + RUN OUT (its clip uploads late)')).dismissal.batter, 'Run Out']);
  eq('the late uploads and the stale attach did not move a clip onto a neighbour', [byClip(w2.clipId).deliveryId, byClip(S('a second WIDE (its clip uploads late)').clips[0]).deliveryId],
    [S('WIDE + RUN OUT (its clip uploads late)').deliveryId, S('a second WIDE (its clip uploads late)').deliveryId]);
  const colourOfClip = (id) => requests.find(r => r.clipId === id).colour;
  eq('on R2, each clip\'s video is the one cut for it (its own colour)', all.map(c => [c.clipId, colourOfBytes(bucket.get(`matches/${M}/clips/${c.clipId}.mp4`), '.mp4')]).sort(),
    all.map(c => [c.clipId, colourOfClip(c.clipId)]).sort());
  const pub = await call(port, 'GET', `/api/clips/match/${M}?includeHidden=1`);
  const api = (pub.json && pub.json.clips) || [];
  eq('the clips API names each clip\'s delivery', api.map(c => [c.clipId, c.deliveryId]).sort(), all.map(c => [String(c._id), c.deliveryId]).sort());
  const docId = (clipId) => String(byClip(clipId)._id);

  // a finished match: its record, as the panel saves it
  const record = P.J('buildMatchRecordForLeague()');
  await mem.collection('matchRecords').insertOne(Object.assign({}, record, { matchId: M, roomId: M, leagueKey: '__single_matches__', ownerUid: 'owner', winningTeam: 'A', matchResultText: 'Dr. D.Y Patil Sports Academy won' }));
  const pubBalls = (await call(port, 'GET', `/api/public/match/${M}/balls`)).json.balls;
  eq('the public ball log carries each delivery\'s id', pubBalls.map(b => b.deliveryId).sort(), steps.map(s => s.deliveryId).sort());

  // ---- the scorecard in Chromium ----
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const stub = (user) => `(function(){ var u = ${user ? `{ uid: 'owner', email: '${OWNER.email}', getIdToken: function(){ return Promise.resolve('owner-token'); } }` : 'null'};
    function deep(){ return new Proxy(function(){}, { get: function(t, k){ return k === Symbol.toPrimitive ? function(){ return 0; } : (k === 'then' ? undefined : deep()); }, apply: function(){ return deep(); } }); }
    var auth = new Proxy({ currentUser: u, onAuthStateChanged: function(cb){ setTimeout(function(){ cb(u); }, 0); return function(){}; }, signOut: function(){ return Promise.resolve(); } }, { get: function(t, k){ return k in t ? t[k] : deep(); } });
    window.firebase = new Proxy({ initializeApp: function(){}, apps: [], auth: Object.assign(function(){ return auth; }, { GoogleAuthProvider: function(){} }) }, { get: function(t, k){ return k in t ? t[k] : deep(); } }); })();`;
  const r2Served = [];
  const open = async (url, { user = null, ctx = null } = {}) => {
    const c = ctx || await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await c.addInitScript(stub(user));
    const page = await c.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if(u.hostname === R2_HOST){
        const key = decodeURIComponent(u.pathname.slice(1)), b = bucket.get(key);
        if(!b) return route.fulfill({ status: 404, body: '' });
        r2Served.push(key);
        return route.fulfill({ status: 200, body: b, headers: { 'Content-Type': key.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4', 'Accept-Ranges': 'none' } });
      }
      if(u.hostname !== '127.0.0.1') return route.fulfill({ status: 404, body: '' });
      return route.continue();
    });
    page.on('dialog', d => d.accept());
    await page.goto(`http://127.0.0.1:${port}${url}`);
    return { ctx: c, page, errors };
  };
  // every commentary row: its over.ball, its line and the clip its WATCH REPLAY plays
  const rows = (page) => page.$$eval('#commentary-feed .cm-line', els => els.map(el => ({ over: el.querySelector('.cm-over').textContent.trim(), text: el.querySelector('.cm-text').textContent.trim(), clip: (el.querySelector('.cm-replay-btn') || {}).dataset ? el.querySelector('.cm-replay-btn').dataset.clipId : null })));
  // waits for the commentary to show n rows with b WATCH REPLAY buttons (what it shows, if it never does)
  const waitRows = async (page, n, b) => {
    try {
      await page.waitForFunction(([n, b]) => (n == null || document.querySelectorAll('#commentary-feed .cm-line').length === n) && document.querySelectorAll('#commentary-feed .cm-replay-btn').length === b, [n, b], { timeout: 20000 });
    } catch(e){
      console.log('  (the commentary shows)', JSON.stringify(await rows(page)), await page.evaluate(() => (document.getElementById('commentary-card') || {}).style && document.getElementById('commentary-card').style.display));
      throw e;
    }
  };
  const want = (extra) => steps.slice().reverse().map(s => (extra && extra[s.deliveryId] !== undefined) ? extra[s.deliveryId] : (s.clips[0] ? docId(s.clips[0]) : null));
  // play one row's replay; the colour actually on screen
  const playRow = async (page, i) => {
    await page.locator('#commentary-feed .cm-line').nth(i).locator('.cm-replay-btn').click();
    await page.waitForFunction(() => { const v = document.getElementById('vm-video'); return v && v.readyState >= 2 && v.currentTime > 0.05; }, null, { timeout: 15000 });
    const src = await page.evaluate(() => document.getElementById('vm-video').currentSrc);
    const shot = path.join(TMP, 'frame.png');
    await page.evaluate(() => document.getElementById('vm-video').pause());
    await (await page.$('#vm-video')).screenshot({ path: shot });
    const colour = colourOf(shot);
    await page.evaluate(() => closeVideoModal());
    await sleep(150);
    return { src, colour };
  };
  const checkPlayback = async (page, label, colourFor) => {
    const list = await rows(page);
    const got = [], exp = [];
    for(let i = 0; i < list.length; i++){
      if(!list[i].clip) continue;
      const p = await playRow(page, i);
      const doc = (await docs()).find(c => String(c._id) === list[i].clip);
      got.push([list[i].over, p.colour, p.src.endsWith(`/clips/${doc.clipId}.mp4`)]);
      exp.push([list[i].over, colourFor(doc), true]);
    }
    eq(label, got, exp);
  };

  head('3. The finished match: every WATCH REPLAY plays its own delivery\'s clip');
  let v = await open(`/cricket-scorecard.html?room=${M}&history=1`);
  await waitRows(v.page, steps.length, 8);
  let r = await rows(v.page);
  eq('each row\'s WATCH REPLAY is that delivery\'s clip (newest first) — 19.5 Wide + Run Out, 19.5 caught, … 19.1 No Ball, 19.1 FOUR',
    r.map(x => [x.over, x.clip]), steps.slice().reverse().map((s, i) => [r[i].over, s.clips[0] ? docId(s.clips[0]) : null]));
  eq('…the two rows numbered 19.5 play two different clips; so do the two numbered 19.1', [r[0].over, r[1].over, r[0].clip !== r[1].clip, r[8].over, r[9].over, r[8].clip !== r[9].clip], ['19.5', '19.5', true, '19.1', '19.1', true]);
  await checkPlayback(v.page, 'played in the browser: every replay shows the colour of its own delivery\'s video (and comes from that clip\'s own R2 object)', (doc) => colourOfClip(doc.clipId));
  await v.page.evaluate(() => document.getElementById('highlights-card').scrollIntoView());
  await v.page.waitForFunction(() => typeof hlClips !== 'undefined' && hlClips.length > 0, null, { timeout: 15000 });
  const hl = await v.page.evaluate(() => hlClips.map(c => [c.clipId, c.eventType]));
  eq('Highlights: both 19.5 wickets are there, as two cards (never folded into one)', hl.filter(x => x[1] === 'WICKET').map(x => x[0]).sort(), [wk1, wk2].map(c => String(c._id)).sort());
  eq('…and both 19.1 / 19.2 FOURs', hl.filter(x => x[1] === 'FOUR').length, 2);
  eq('no page errors', v.errors, []);
  await v.ctx.close();

  head('4. Live: the same mapping from the panel\'s own state');
  v = await open(`/cricket-scorecard.html?room=${M}`);
  P.E('pushState(true, true)');
  await waitRows(v.page, steps.length, 8);
  r = await rows(v.page);
  eq('live commentary: each row\'s WATCH REPLAY is that delivery\'s clip', r.map(x => x.clip), want());
  await checkPlayback(v.page, 'live: every replay plays its own delivery\'s video', (doc) => colourOfClip(doc.clipId));
  eq('no page errors', v.errors, []);
  await v.ctx.close();

  head('5. The owner replaces ONE of the two 19.5 clips — the other stays');
  const ro = S('WIDE + RUN OUT (its clip uploads late)'), ct = S('WICKET — caught');
  v = await open(`/cricket-scorecard.html?room=${M}&history=1`, { user: true });
  await v.page.waitForFunction(() => typeof isOwner !== 'undefined' && isOwner === true, null, { timeout: 15000 });
  await v.page.evaluate(() => openOwnerPanel({ fresh: true }));     // Edit Scorecard, as the owner opens it
  await v.page.waitForFunction(() => deliveryListCache && deliveryListCache.balls.length > 0, null, { timeout: 15000 });
  const listed = await v.page.evaluate((ids) => ids.map(id => { const b = deliveryListCache.balls.find(x => x.ballUid === id); const c = deliveryListCache.clipMap.get(b.ballId); return c ? String(c.clipId) : null; }), steps.map(s => s.deliveryId));
  eq('Edit deliveries: each row\'s clip is its own (the 19.5 pair and the 19.1 / 19.2 groups apart)', listed, steps.map(s => s.clips[0] ? docId(s.clips[0]) : null));
  const replace = async (s, colour) => {
    const prior = new Set((await docs()).map(c => c.clipId));
    await v.page.evaluate((id) => { const b = deliveryListCache.balls.find(x => x.ballUid === id); openAttachClipForm(deliveryListCache.matchId, b); }, s.deliveryId);
    await v.page.selectOption('#attachEventType', 'WICKET');
    await v.page.setInputFiles('#attachFile', makeVideo(colour));
    await v.page.click('#confirm-save-btn');
    await v.page.waitForFunction(() => !document.getElementById('confirm-modal-backdrop').classList.contains('open'), null, { timeout: 20000 });
    // done once the delivery has exactly one clip, a new one, on R2
    for(let i = 0; i < 150; i++){ const d = (await docs()).filter(c => c.deliveryId === s.deliveryId); if(d.length === 1 && !prior.has(d[0].clipId) && d[0].r2Status === 'uploaded') break; await sleep(100); }
  };
  const snap = async () => (await docs()).map(c => ({ id: String(c._id), clipId: c.clipId, deliveryId: c.deliveryId, r2: `matches/${M}/clips/${c.clipId}.mp4` }));
  const beforeRep = await snap();
  await replace(ro, 'brown');
  let afterRep = await snap();
  const roNow = afterRep.filter(c => c.deliveryId === ro.deliveryId), ctNow = afterRep.filter(c => c.deliveryId === ct.deliveryId);
  eq('replaced: the Wide + Run Out delivery has ONE clip, the new one (brown)', [roNow.length, roNow[0] && roNow[0].clipId !== w2.clipId, roNow[0] && colourOfBytes(bucket.get(roNow[0].r2), '.mp4')], [1, true, 'brown']);
  eq('…its old clip is deleted for good', [!!(await mem.collection('deletedClips').findOne({ clipId: w2.clipId })), afterRep.some(c => c.clipId === w2.clipId)], [true, false]);
  eq('…the caught wicket at 19.5 is untouched: same clip, same video', [ctNow.map(c => c.id), colourOfBytes(bucket.get(ctNow[0].r2), '.mp4')], [beforeRep.filter(c => c.deliveryId === ct.deliveryId).map(c => c.id), colourOfClip(wk1.clipId)]);
  eq('…and every other delivery keeps its clip', afterRep.filter(c => c.deliveryId !== ro.deliveryId).map(c => c.id).sort(), beforeRep.filter(c => c.deliveryId !== ro.deliveryId).map(c => c.id).sort());
  const roNew = roNow[0];
  await replace(ct, 'navy');
  afterRep = await snap();
  const ct2 = afterRep.filter(c => c.deliveryId === ct.deliveryId), ro2 = afterRep.filter(c => c.deliveryId === ro.deliveryId);
  eq('then the caught wicket\'s clip replaced: it plays navy, and the Wide + Run Out keeps the brown one it was given', [ct2.length, colourOfBytes(bucket.get(ct2[0].r2), '.mp4'), ro2.map(c => c.id), colourOfBytes(bucket.get(ro2[0].r2), '.mp4')],
    [1, 'navy', [roNew.id], 'brown']);
  eq('no page errors', v.errors, []);
  await v.ctx.close();
  const colourNow = (doc) => doc.clipId === roNew.clipId ? 'brown' : doc.deliveryId === ct.deliveryId ? 'navy' : colourOfClip(doc.clipId);
  // an older scorecard (or a hand-made request) naming only "19.5": two deliveries are 19.5 — refused, nothing touched
  const n0 = (await docs()).length;
  const amb = await call(port, 'POST', `/api/admin/clips/attach/upload?matchId=${M}&eventType=CLIP&innings=1&over=19&ballInOver=5&replace=true`, { raw: fs.readFileSync(makeVideo('white')), headers: owner });
  eq('an attach / replace that names only the over.ball 19.5 (two deliveries) is refused, and changes nothing', [amb.status, amb.json && amb.json.code, (await docs()).length], [409, 'AMBIGUOUS_DELIVERY', n0]);
  // the owner's clip correction moving a clip to another over.ball: it names the delivery there, not the old one
  const f2 = byClip(S('WIDE after the FOUR').clips[0]);
  const mv = await call(port, 'PUT', `/api/admin/clips/${f2._id}`, { json: { over: 19, ballInOver: 3, eventType: 'CLIP', strikerName: ballOf(S('single')).striker }, headers: owner });
  eq('a clip corrected to 19.3 names the 19.3 delivery (the only one there it fits)', [mv.status, (await mem.collection('clips').findOne({ _id: f2._id })).deliveryId], [200, S('single').deliveryId]);
  await call(port, 'PUT', `/api/admin/clips/${f2._id}`, { json: { deliveryId: S('WIDE after the FOUR').deliveryId, over: 19, ballInOver: 2 }, headers: owner });
  eq('…and put back by naming its delivery', (await mem.collection('clips').findOne({ _id: f2._id })).deliveryId, S('WIDE after the FOUR').deliveryId);

  head('6. A reload, and opening the match afresh: the mapping holds');
  const current = (await docs());
  const wantNow = () => steps.slice().reverse().map(s => { const c = current.find(x => x.deliveryId === s.deliveryId); return c ? String(c._id) : null; });
  v = await open(`/cricket-scorecard.html?room=${M}&history=1`);
  await waitRows(v.page, null, 8);
  await v.page.reload();
  await waitRows(v.page, null, 8);
  r = await rows(v.page);
  eq('after a reload: each row\'s replay is its delivery\'s clip, the replaced ones included', r.map(x => x.clip), wantNow());
  await checkPlayback(v.page, '…and plays it (navy on the caught wicket, brown on the Wide + Run Out, every other delivery its own)', colourNow);
  await v.ctx.close();
  v = await open(`/cricket-scorecard.html?room=${M}&history=1`);
  await waitRows(v.page, null, 8);
  eq('opened afresh (a new visitor): the same', (await rows(v.page)).map(x => x.clip), wantNow());
  await v.ctx.close();

  head('7. Older clips that name no delivery (from before deliveryId)');
  const old = Date.now() - 60 * 60 * 1000;
  const legacy = (clipId, o) => Object.assign({ clipId, matchId: M, innings: 1, over: 19, battingTeam: 'A', isHighlight: true, status: 'COMPLETE', r2Status: 'uploaded', driveStatus: 'failed',
    r2Url: `https://${R2_HOST}/matches/${M}/clips/${clipId}.mp4`, r2Key: `matches/${M}/clips/${clipId}.mp4`, createdAt: old }, o);
  const s3 = S('single');
  const rSingle = ballOf(s3);
  bucket.set(`matches/${M}/clips/${M}_CLIP_LEGACY1.mp4`, fs.readFileSync(makeVideo('teal')));
  await mem.collection('clips').insertOne(legacy(`${M}_CLIP_LEGACY1`, { eventType: 'CLIP', ballInOver: 3, strikerName: rSingle.striker, strikerKey: rSingle.strikerKey }));
  await mem.collection('clips').insertOne(legacy(`${M}_WICKET_LEGACY2`, { eventType: 'WICKET', ballInOver: 5 }));       // names no batter: both 19.5 wickets fit it
  await mem.collection('clips').insertOne(legacy(`${M}_FOUR_LEGACY3`, { eventType: 'FOUR', ballInOver: 2, strikerName: ballOf(S('WIDE after the FOUR')).striker }));  // 19.2: one FOUR among four deliveries
  const notOwner = await call(port, 'POST', '/api/admin/clips/backfill-deliveries');
  const bf = await call(port, 'POST', '/api/admin/clips/backfill-deliveries', { headers: owner });
  const L = async (id) => mem.collection('clips').findOne({ clipId: id });
  eq('the migration is the owner\'s only', notOwner.status === 401 || notOwner.status === 403, true);
  eq('linked only where ONE delivery fits: the 19.3 clip → the 19.3 single; the 19.2 FOUR clip → the 19.2 FOUR (not a Wide or the No Ball)',
    [(await L(`${M}_CLIP_LEGACY1`)).deliveryId, (await L(`${M}_FOUR_LEGACY3`)).deliveryId], [s3.deliveryId, steps[2].deliveryId]);
  eq('…a wicket clip both 19.5 wickets fit is left alone (marked, never guessed)', [(await L(`${M}_WICKET_LEGACY2`)).deliveryId || null, (await L(`${M}_WICKET_LEGACY2`)).deliveryBackfill], [null, 'ambiguous']);
  eq('…the counts', [bf.json.linked, bf.json.ambiguous], [2, 1]);
  const again = await call(port, 'POST', '/api/admin/clips/backfill-deliveries', { headers: owner });
  eq('run again: nothing left to do (every clip looked at once)', [again.json.linked, again.json.ambiguous, again.json.none], [0, 0, 0]);
  v = await open(`/cricket-scorecard.html?room=${M}&history=1`);
  await waitRows(v.page, null, 9);
  r = await rows(v.page);
  const latestDocs = await docs();
  const ownClip = (s) => { const c = latestDocs.filter(x => x.deliveryId === s.deliveryId && !/LEGACY3/.test(x.clipId)); return c.length ? String(c[0]._id) : null; };
  eq('the scorecard: the 19.3 single now plays its old clip; the 19.5 rows keep their own (the ambiguous one shows on neither)',
    [r[3].over, r[3].clip, r[0].clip, r[1].clip], ['19.3', String((await L(`${M}_CLIP_LEGACY1`))._id), ownClip(ro), ownClip(ct)]);
  eq('no page errors', v.errors, []);
  await v.ctx.close();

  await browser.close();
  eq('the panel: no script errors', P.errors.filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
  fs.rmSync(path.join(ROOT, 'clips', M), { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
