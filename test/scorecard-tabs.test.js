// cricket-scorecard.html — the match sections tab bar (Scorecard · Info ·
// Squads · Commentary · Clips · Summary · Insights · MVP), on the REAL page
// with data from the REAL panel.
//
// A short match (3 overs a side, toss, squads with captain / wicketkeeper /
// left-handers, boundaries, a wide, caught / bowled / lbw) is scored on
// cricket-panel.html in jsdom. What the panel broadcasts (its live state, mid
// chase and at the end), its saved match record and its deliveries (mapped
// by the server's own mapBallForPublic) are then fed to the scorecard page in
// Chromium, live (socket) and as a finished match (?history=1). Checked:
//   • the Scorecard tab is the page exactly as before: #wrap's HTML and its
//     pixels are identical to the same page with the tabs code taken out
//   • every tab opens its own section, the score header stays, ?tab= is kept
//     in the link (reload, invalid value, Scorecard has none), arrow keys
//   • Info / Squads / Summary / Insights / MVP show the match's real
//     figures (compared with the record and the deliveries), nothing invented
//     (officials and a missing tournament say "not recorded")
//   • Summary: one innings at a time with a switcher — total, state, extras,
//     the chase (target, need, balls left, required rate), runs per over,
//     progression, where the runs came from, top performers, partnerships,
//     fall of wickets, key moments — and an innings comparison
//   • MVP: the points and the real figures, never the sum behind the points
//   • Clips: the match's public clips (the same list the Highlights card
//     loads — no second request) by innings / team / category / player /
//     search, sorted, paged, played in the page's own clip player; an
//     unready clip cannot be played, a clip with no innings is not guessed
//     into one; loading, failure (with retry) and empty states
//   • Commentary is the page's own full commentary inline; "Watch Full
//     Commentary" on the Scorecard tab still opens it full screen
//   • a live update redraws the open tab; empty states before the first ball
//     and for an imported scorecard; no sideways scroll on a 390 px phone
//
// Run:  NODE_PATH=$(npm root -g) node test/scorecard-tabs.test.js   (needs jsdom + playwright)
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { chromium } = require('playwright');
const H = require('./cricket/server-harness.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out', 'scorecard-tabs');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, msg, d) => { if (c) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 400) : '')); } };
const head = (t) => console.log('\n' + t);

/* ---------------- 1. a match on the real panel ---------------- */
function bootPanel() {
  const html = fs.readFileSync(path.join(ROOT, 'cricket-panel.html'), 'utf8').replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole(); const errors = []; vc.on('jsdomError', (e) => errors.push(e.message));
  const emits = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=TABS1', virtualConsole: vc, beforeParse(w) {
    w.io = () => ({ on() {}, emit(ev, payload, ack) { emits.push({ ev, payload }); if (typeof ack === 'function') ack({ ok: true }); }, connected: true, disconnect() {}, io: { on() {} } });
    w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
    w.alert = () => {}; w.confirm = () => true;
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
    w.HTMLMediaElement.prototype.play = () => Promise.resolve(); w.HTMLMediaElement.prototype.pause = () => {};
    w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
    w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
    w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
    w.scrollTo = () => {};
  } });
  const w = dom.window;
  return { w, errors, emits, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s), J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)) };
}
async function playMatch() {
  const P = bootPanel();
  await sleep(80);
  const click = (sel) => P.$(sel).dispatchEvent(new P.w.Event('click', { bubbles: true }));
  let bowlers = [], overNo = 0;
  const nextOver = () => { if (P.$('#newover-modal-overlay').classList.contains('show')) { overNo++; const [n, id] = bowlers[overNo % bowlers.length]; P.E(`closeNewOverModal(); setLiveBowler(${JSON.stringify(n)}, ${JSON.stringify(id)}); renderPanel();`); } };
  const ball = (k) => { P.E(k === 'Wd' ? `recordBall('Wd', { extraRuns: 1 })` : `recordBall(${JSON.stringify(k)})`); nextOver(); };
  const out = (type, fielder) => {
    P.E('openWicketModal()');
    [...P.w.document.querySelectorAll('#wd-types [data-wd-type]')].find((b) => b.dataset.wdType === type).dispatchEvent(new P.w.Event('click', { bubbles: true }));
    if (fielder) P.E(`wdSetFielder(${JSON.stringify(fielder)}); renderWicketDetails();`);
    click('#wd-confirm');
    if (P.$('#newbat-modal-overlay').classList.contains('show')) {
      const sel = P.$('#newbat-modal-select'); const next = [...sel.options].map((x) => x.value).filter(Boolean)[0];
      if (next) { sel.value = next; sel.dispatchEvent(new P.w.Event('change', { bubbles: true })); }
      click('#newbat-modal-submit');
    }
    nextOver();
  };
  const A = ['Rohit Sharma', 'Ishan Kishan', 'Suryakumar Yadav', 'Tilak Varma', 'Hardik Pandya', 'Tim David', 'Krunal Pandya', 'Piyush Chawla', 'Jasprit Bumrah', 'Akash Madhwal', 'Gerald Coetzee', 'Nehal Wadhera'];
  const B = ['Ruturaj Gaikwad', 'Devon Conway', 'Ajinkya Rahane', 'Shivam Dube', 'Moeen Ali', 'Ravindra Jadeja', 'MS Dhoni', 'Deepak Chahar', 'Tushar Deshpande', 'Matheesha Pathirana', 'Maheesh Theekshana', 'Shardul Thakur'];
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'Custom'; state.customOvers = 3; state.battingTeam = 'A';
    state.venue = 'Wankhede Stadium, Mumbai'; state.matchDate = '2026-10-28'; state.matchNo = 7; state.matchStage = 'League'; state.matchTitle = 'Mumbai Indians vs Chennai Super Kings';
    document.getElementById('match-id').value = 'TABS1';
    state.teamA.name = 'Mumbai Indians'; state.teamA.short = 'MI'; state.teamA.color = '#004ba0';
    state.teamB.name = 'Chennai Super Kings'; state.teamB.short = 'CSK'; state.teamB.color = '#f9cd05';
    state.teamA.players = ${JSON.stringify(A)}.map((n, i) => ({ id: 'a' + (i + 1), name: n, isXI: i < 11, ...(i === 3 || i === 6 ? { hand: 'L' } : {}) }));
    state.teamB.players = ${JSON.stringify(B)}.map((n, i) => ({ id: 'b' + (i + 1), name: n, isXI: i < 11, ...(i === 1 || i === 5 ? { hand: 'L' } : {}) }));
    state.teamA.captainId = 'a5'; state.teamA.wkId = 'a2'; state.teamB.captainId = 'b1'; state.teamB.wkId = 'b7';
    state.toss = { winner: 'B', decision: 'BOWL' };
    state.striker    = { name:'Rohit Sharma', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan Kishan', id:'a2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Deepak Chahar', id:'b8', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = []; pendingWicketDelivery = null;
    renderPanel();
  `);
  const pre = P.J('state');
  bowlers = [['Deepak Chahar', 'b8'], ['Matheesha Pathirana', 'b10']]; overNo = 0;
  ['1', '4', '0', '6', 'Wd', '1', '2'].forEach(ball); out('Caught', 'b4');
  ['4', '1', '0', '1'].forEach(ball); out('Bowled');
  ['6', '2', '1', '4', '0', '1'].forEach(ball);
  click('#next-innings-btn');
  P.E(`
    state.striker    = { name:'Ruturaj Gaikwad', id:'b1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Devon Conway', id:'b2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Jasprit Bumrah', id:'a9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    renderPanel();
  `);
  bowlers = [['Jasprit Bumrah', 'a9'], ['Hardik Pandya', 'a5']]; overNo = 0;
  ['1', '0', '4', '2', '1', '0'].forEach(ball); out('LBW');
  ['6', '1'].forEach(ball);
  const live = P.J('state');
  ['4', '0', '1', '2', '6', '1', '4', '6'].forEach(ball);
  const final = P.J('state');
  const record = P.J('buildMatchRecordForLeague()');
  const deliveries = P.emits.filter((e) => e.ev === 'logBall').map((e) => e.payload);
  const api = H.build({ balls: H.coll([]), clips: H.coll([]), records: H.coll([]), rooms: {}, emits: [], audits: [] }, ['personName', 'playerKey', 'normalizeKindForPublic', 'sanitizeShot', 'buildBallFromCorrection', 'mapBallForPublic'], []);
  const balls = deliveries.map((d, i) => api.mapBallForPublic(Object.assign({ timestamp: 1790000000000 + i * 30000 }, d, { striker: api.personName(d.striker), nonStriker: api.personName(d.nonStriker), bowler: api.personName(d.bowler) })));
  return { pre, live, final, record, balls, panelErrors: P.errors.filter((e) => !/Could not parse CSS|Not implemented/.test(e)) };
}

// A short Test on the real panel: India declare, Australia declare, India
// declare again, Australia chase the lead down in the 4th innings.
async function playTest() {
  const P = bootPanel();
  await sleep(80);
  const click = (sel) => P.$(sel).dispatchEvent(new P.w.Event('click', { bubbles: true }));
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'Test'; state.battingTeam = 'A';
    document.getElementById('match-id').value = 'TABS1';
    state.teamA.name = 'India'; state.teamA.short = 'IND'; state.teamA.color = '#1f6fd1';
    state.teamB.name = 'Australia'; state.teamB.short = 'AUS'; state.teamB.color = '#f2c200';
    state.teamA.players = ['Rohit Sharma','Shubman Gill','Virat Kohli','Rishabh Pant','Ravindra Jadeja','R Ashwin','Jasprit Bumrah','Mohammed Siraj','Mohammed Shami','Kuldeep Yadav','Axar Patel'].map((n, i) => ({ id: 'ta' + i, name: n, isXI: true }));
    state.teamB.players = ['David Warner','Usman Khawaja','Marnus Labuschagne','Steve Smith','Travis Head','Alex Carey','Pat Cummins','Mitchell Starc','Nathan Lyon','Josh Hazlewood','Cameron Green'].map((n, i) => ({ id: 'tb' + i, name: n, isXI: true }));
    state.toss = { winner: 'A', decision: 'BAT' };
    history = []; ballOutbox = []; pendingWicketDelivery = null;
    renderPanel();
  `);
  const innings = (bat, bowl, kinds, declare) => {
    P.E(`state.striker = { name:${JSON.stringify(bat[0][0])}, id:${JSON.stringify(bat[0][1])}, runs:0, balls:0, fours:0, sixes:0 };
      state.nonStriker = { name:${JSON.stringify(bat[1][0])}, id:${JSON.stringify(bat[1][1])}, runs:0, balls:0, fours:0, sixes:0 };
      state.bowler = { name:${JSON.stringify(bowl[0][0])}, id:${JSON.stringify(bowl[0][1])}, overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
      renderPanel();`);
    let o = 0;
    kinds.forEach((k) => { P.E(`recordBall(${JSON.stringify(k)})`); if (P.$('#newover-modal-overlay').classList.contains('show')) { o++; const [n, id] = bowl[o % bowl.length]; P.E(`closeNewOverModal(); setLiveBowler(${JSON.stringify(n)}, ${JSON.stringify(id)}); renderPanel();`); } });
    if (declare) { click('#declare-btn'); click('#next-innings-btn'); }
  };
  const IND = [['Rohit Sharma', 'ta0'], ['Shubman Gill', 'ta1']], AUS = [['David Warner', 'tb0'], ['Usman Khawaja', 'tb1']];
  const AUSB = [['Mitchell Starc', 'tb7'], ['Pat Cummins', 'tb6']], INDB = [['Jasprit Bumrah', 'ta6'], ['Mohammed Siraj', 'ta7']];
  innings(IND, AUSB, ['4', '1', '0', '6', '1', '1', '2', '4', '0', '1', '1', '0'], true);   // 21
  innings(AUS, INDB, ['1', '4', '0', '0', '1', '2', '1', '0', '0', '6', '0', '1'], true);   // 16
  innings(IND, AUSB, ['4', '4', '1', '0', '1', '1'], true);                                 // 11
  innings(AUS, INDB, ['6', '4', '1', '2', '4'], false);                                     // 17 — the lead was 16
  const final = P.J('state');
  const record = P.J('buildMatchRecordForLeague()');
  const deliveries = P.emits.filter((e) => e.ev === 'logBall').map((e) => e.payload);
  const api = H.build({ balls: H.coll([]), clips: H.coll([]), records: H.coll([]), rooms: {}, emits: [], audits: [] }, ['personName', 'playerKey', 'normalizeKindForPublic', 'sanitizeShot', 'buildBallFromCorrection', 'mapBallForPublic'], []);
  const balls = deliveries.map((d, i) => api.mapBallForPublic(Object.assign({ timestamp: 1790000000000 + i * 30000 }, d, { striker: api.personName(d.striker), nonStriker: api.personName(d.nonStriker), bowler: api.personName(d.bowler) })));
  return { final, record, balls, panelErrors: P.errors.filter((e) => !/Could not parse CSS|Not implemented/.test(e)) };
}

/* ---------------- 2. the scorecard page in Chromium ---------------- */
const FIREBASE = 'function deep(){return new Proxy(function(){},{get:(t,k)=>k===Symbol.toPrimitive?(()=>0):(k==="then"?undefined:deep()),apply:()=>deep()})};const __auth=new Proxy({currentUser:null,onAuthStateChanged(cb){setTimeout(()=>cb(null),0);return ()=>{}}},{get:(t,k)=>k in t?t[k]:deep()});window.firebase=new Proxy({initializeApp(){},apps:[],auth:Object.assign(()=>__auth,{GoogleAuthProvider:function(){}})},{get:(t,k)=>k in t?t[k]:deep()});';
const SOCKET = 'window.io=function(){const h={};const s={on:(e,f)=>{(h[e]=h[e]||[]).push(f);return s},emit:()=>{},connected:true,removeAllListeners(){},disconnect(){}};window.__fire=(e,p)=>(h[e]||[]).forEach(f=>f(p));return s};';
const PAGE = fs.readFileSync(path.join(ROOT, 'cricket-scorecard.html'), 'utf8');
// the same page with the tabs code (its <style> and its <script>) taken out
const PAGE_WITHOUT_TABS = PAGE.replace(/<style id="sc-tabs-style">[\s\S]*?<\/style>/, '').replace(/<script>\s*\/\*\s*=+\s*\n\s*🧭 MATCH SECTIONS[\s\S]*?<\/script>/, '');

async function open(browser, { url, vp, fixtures, record, balls, html, scheme, clips, clipsStatus, clipsDelay }) {
  const ctx = await browser.newContext({ viewport: vp || { width: 1280, height: 900 }, reducedMotion: 'reduce', colorScheme: scheme || 'dark' });
  await ctx.addInitScript(FIREBASE + SOCKET);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.host !== 'test.local') return route.fulfill({ status: 404, body: '' });
    if (u.pathname === '/api/public/match/TABS1') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, match: record || fixtures.record }) });
    if (u.pathname === '/api/public/match/TABS1/balls') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, balls: balls || fixtures.balls }) });
    if (u.pathname === '/api/clips/match/TABS1') {
      (fixtures.clipCalls = fixtures.clipCalls || []).push(u.search);
      if (clipsDelay) await sleep(clipsDelay);
      if (clipsStatus) return route.fulfill({ status: clipsStatus, contentType: 'application/json', body: '{"success":false}' });
      const all = clips || fixtures.clips || [];
      const skip = Number(u.searchParams.get('skip')) || 0, limit = Number(u.searchParams.get('limit')) || 50;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, clips: all.slice(skip, skip + limit) }) });
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"success":false}' });
    if (u.pathname === '/cricket-scorecard.html') return route.fulfill({ contentType: 'text/html', body: html || PAGE });
    const f = path.join(ROOT, u.pathname);
    if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(url);
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}
// The clips the server's /api/clips/match/:id hands out (serializeClip's
// shape) for this match's fours, sixes and wickets — plus one still
// uploading and one old clip cut before innings was stored.
function clipsFor(balls) {
  const out = [];
  balls.forEach((b, i) => {
    const t = b.ballType === '6' ? 'SIX' : b.ballType === '4' ? 'FOUR' : b.isWicket ? 'WICKET' : null;
    if (!t) return;
    const ov = b.over, bl = b.ballInOver;
    const d = b.dismissal || {};
    out.push({ clipId: 'c' + i, matchId: 'TABS1', eventType: t, isHighlight: true, dismissalType: t === 'WICKET' ? (d.type || null) : null, over: ov, ballInOver: bl, innings: b.innings || 1, runs: b.runs,
      battingTeam: (b.innings || 1) === 1 ? 'A' : 'B', striker: b.striker, bowler: b.bowler, nonStriker: b.nonStriker || null, fielder: d.fielder || null, dismissedPlayer: t === 'WICKET' ? (d.batter || b.striker) : null,
      ready: true, status: 'COMPLETE', watchUrl: `/api/clips/c${i}/watch`, playbackUrl: '/bg-video.mp4', posterUrl: out.length % 2 ? '/logo.png' : null, downloadUrl: `/api/clips/c${i}/download`, createdAt: new Date(1790000000000 + i * 30000).toISOString(), duration: 10 });
  });
  const last = out[out.length - 1];
  Object.assign(last, { ready: false, status: 'UPLOADING', playbackUrl: null });
  const old = Object.assign({}, out[0], { clipId: 'cold', over: 2, ballInOver: 7, createdAt: new Date(1780000000000).toISOString() });
  delete old.innings;
  out.push(old);
  return out;
}
const fire = (page, state) => page.evaluate((s) => window.__fire('liveCricketScore', s), state);
const LIVE = 'http://test.local/cricket-scorecard.html?room=TABS1';
const FINAL = 'http://test.local/cricket-scorecard.html?room=TABS1&history=1';
const shown = (page, sel) => page.$eval(sel, (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)).catch(() => false);
const txt = (page, sel) => page.$eval(sel, (e) => (e.innerText || e.textContent).replace(/\s+/g, ' ').trim()).catch(() => '');
async function tab(page, id) { await page.click(`#sct-tab-${id}`); await page.waitForTimeout(250); }

// pixels of #wrap, compared in the browser
async function pixelDiff(page, a, b) {
  return page.evaluate(async ([x, y]) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + src; });
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { size: [ia.width, ia.height, ib.width, ib.height] };
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height; const g = c.getContext('2d');
    g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, c.width, c.height).data;
    g.clearRect(0, 0, c.width, c.height); g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    // (row 0 is skipped: #wrap starts at a fractional y — the brand bar is 55.75 px — so its first
    // pixel row is shared with the tab bar's bottom border, which the empty box does not have)
    for (let i = c.width * 4; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 2 || Math.abs(da[i + 1] - db[i + 1]) > 2 || Math.abs(da[i + 2] - db[i + 2]) > 2) { n++; const p = i / 4, x = p % c.width, y = Math.floor(p / c.width); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return n ? { diff: n, px: da.length / 4, box: [x0, y0, x1, y1] } : { diff: 0, px: da.length / 4 };
  }, [a.toString('base64'), b.toString('base64')]);
}

(async () => {
  head('THE MATCH — scored on the real panel');
  const fx = await playMatch();
  ok(fx.panelErrors.length === 0, 'the panel scored the whole match without a script error', fx.panelErrors);
  ok(fx.record.resultText === 'CSK WON BY 9 WICKETS' && fx.balls.length > 30, `result "${fx.record.resultText}", ${fx.balls.length} deliveries`);

  fx.clips = clipsFor(fx.balls);
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  // the fixed background behind the translucent cards is not part of the scorecard: one flat colour in both
  // (and the highlight cards drawn in full: off screen they are content-visibility:auto, whose
  // placeholder size depends on whether the browser has drawn them yet — the same in both pages)
  const hideWash = '#ambient-wash,#logo-wash{display:none!important} html,body{background:#0b0e14!important;background-image:none!important} .clip-row.hl-card{content-visibility:visible!important}';

  head('SCORECARD TAB — the page exactly as before');
  for (const [mode, url, vp] of [['live', LIVE, { width: 1280, height: 900 }], ['finished', FINAL, { width: 1280, height: 900 }], ['live', LIVE, { width: 390, height: 844 }]]) {
    const a = await open(browser, { url, vp, fixtures: fx });
    const b = await open(browser, { url, vp, fixtures: fx, html: PAGE_WITHOUT_TABS });
    // both pages fully settled — the clips list loaded and drawn, its poster frames loaded — before they are compared
    for (const x of [a, b]) { if (mode === 'live') await fire(x.page, fx.live); await x.page.waitForTimeout(900); await x.page.waitForFunction(() => window.__hlDiagFinal && document.querySelectorAll('#highlights-list .hl-card, #highlights-list .empty-state').length > 0 && [...document.images].every((i) => i.complete), null, { timeout: 10000 }).catch(() => {}); await x.page.waitForTimeout(400); await x.page.addStyleTag({ content: hideWash }); await x.page.waitForTimeout(100); }
    // (each Scorecard section carries the tab bar's marker class "sct-sec" — what the tab bar hides by — and nothing else differs)
    const htmlA = await a.page.evaluate(() => { const w = document.getElementById('wrap').cloneNode(true); const p = w.querySelector('#sc-panels'); if (p) p.remove(); [...w.children].forEach((c) => { c.classList.remove('sct-sec'); if (!c.getAttribute('class')) c.removeAttribute('class'); }); return w.innerHTML; });
    const htmlB = await b.page.evaluate(() => document.getElementById('wrap').innerHTML);
    ok(htmlA === htmlB, `${mode} ${vp.width}px: #wrap holds exactly the same HTML as the page without the tabs code`, htmlA === htmlB ? undefined : [htmlA.length, htmlB.length]);
    // the only layout change: #wrap starts lower by the bar's height. The page without the tabs gets an
    // empty box of that height in the same place, so both are drawn at the same spot (gradients are
    // dithered by where they land on the page) — then every pixel of #wrap must match.
    const navH = await a.page.$eval('#sc-tabs', (e) => e.getBoundingClientRect().height);
    await b.page.evaluate((h) => { const d = document.createElement('div'); d.style.height = h + 'px'; document.getElementById('wrap').before(d); }, navH);
    await b.page.waitForTimeout(150);
    const pa = await a.page.locator('#wrap').screenshot(), pb = await b.page.locator('#wrap').screenshot();
    const d = await pixelDiff(a.page, pa, pb);
    ok(d.diff === 0, `${mode} ${vp.width}px: …and looks exactly the same (pixel for pixel)`, d);
    const disp = (pg) => pg.evaluate(() => [...document.getElementById('wrap').children].filter((c) => c.id !== 'sc-panels').map((c) => (c.id || c.className.replace(/\s*\bsct-sec\b/, '')) + ':' + getComputedStyle(c).display + ':' + Math.round(c.getBoundingClientRect().height)));
    const da = await disp(a.page), db = await disp(b.page);
    ok(JSON.stringify(da) === JSON.stringify(db), `${mode} ${vp.width}px: every section of the scorecard shown / hidden exactly as without the tabs`, da.map((x, i) => x === db[i] ? null : [x, db[i]]).filter(Boolean));
    ok(a.errors.length === 0 && b.errors.length === 0, `${mode} ${vp.width}px: no page errors`, a.errors.concat(b.errors));
    await a.ctx.close(); await b.ctx.close();
  }

  head('THE TAB BAR — sections, the link, the keyboard');
  {
    const { ctx, page, errors } = await open(browser, { url: LIVE, fixtures: fx });
    await fire(page, fx.live); await page.waitForTimeout(600);
    const tabs = await page.$$eval('#sc-tabs [role="tab"]', (b) => b.map((x) => [x.dataset.tab, x.textContent.trim(), x.getAttribute('aria-selected')]));
    ok(JSON.stringify(tabs.map((t) => t[0])) === JSON.stringify(['scorecard', 'info', 'squads', 'commentary', 'clips', 'summary', 'insights', 'mvp']), 'eight tabs in order, Scorecard selected first', tabs);
    ok(tabs[0][2] === 'true' && !new URL(page.url()).searchParams.has('tab'), 'Scorecard is selected and the link carries no ?tab=');
    const barTop = await page.$eval('#sc-tabs', (e) => e.getBoundingClientRect().top), brand = await page.$eval('#brandbar', (e) => e.getBoundingClientRect().bottom);
    ok(Math.abs(barTop - brand) < 1.5, 'the bar sits right under the brand bar');
    for (const id of ['info', 'squads', 'commentary', 'clips', 'summary', 'insights', 'mvp']) {
      await tab(page, id);
      const st = await page.evaluate((id) => ({ sel: document.getElementById('sct-tab-' + id).getAttribute('aria-selected'), panel: !document.getElementById('sct-p-' + id).hidden,
        others: [...document.querySelectorAll('.sct-panel')].filter((p) => p.id !== 'sct-p-' + id).every((p) => p.hidden),
        hero: !!document.getElementById('hero-row').offsetHeight, tables: getComputedStyle(document.getElementById('tables-grid')).display, tabParam: new URL(location.href).searchParams.get('tab') }), id);
      ok(st.sel === 'true' && st.panel && st.others && st.hero && st.tables === 'none' && st.tabParam === id, `${id}: its own section only, the score header stays, the link says ?tab=${id}`, st);
    }
    await tab(page, 'scorecard');
    ok(!new URL(page.url()).searchParams.has('tab') && (await shown(page, '#tables-grid')) && (await page.$eval('#sc-panels', (e) => getComputedStyle(e).display)) === 'none', 'back to Scorecard: the full page again, ?tab= removed');
    await page.focus('#sct-tab-scorecard'); await page.keyboard.press('ArrowRight');
    ok((await page.$eval('#sct-tab-info', (e) => e.getAttribute('aria-selected'))) === 'true' && (await page.evaluate(() => document.activeElement.id)) === 'sct-tab-info', '→ moves to the next tab (and focus with it)');
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    ok((await page.$eval('#sct-tab-mvp', (e) => e.getAttribute('aria-selected'))) === 'true', '← from the first tab wraps to the last');
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
    const r = await open(browser, { url: LIVE + '&tab=summary', fixtures: fx });
    await fire(r.page, fx.live); await r.page.waitForTimeout(600);
    ok((await r.page.$eval('#sct-tab-summary', (e) => e.getAttribute('aria-selected'))) === 'true' && !(await r.page.$eval('#sct-p-summary', (e) => e.hidden)), 'a link with ?tab=summary (shared or reloaded) opens Summary');
    await r.ctx.close();
    const bad = await open(browser, { url: LIVE + '&tab=nonsense', fixtures: fx });
    await bad.page.waitForTimeout(300);
    ok((await bad.page.$eval('#sct-tab-scorecard', (e) => e.getAttribute('aria-selected'))) === 'true' && !new URL(bad.page.url()).searchParams.has('tab') && new URL(bad.page.url()).searchParams.get('room') === 'TABS1', 'an unknown ?tab= opens the Scorecard and is dropped from the link (room kept)');
    await bad.ctx.close();
  }

  // expected figures, straight from the record and the deliveries
  const rec = fx.record;
  const catches = {}; fx.balls.forEach((b) => { if (b.dismissal && b.dismissal.type === 'Caught' && b.dismissal.fielder) catches[b.dismissal.fielder] = (catches[b.dismissal.fielder] || 0) + 1; });
  const imp = {};
  ['A', 'B'].forEach((k) => { (rec.battingCard[k] || []).forEach((r) => { imp[r.name] = (imp[r.name] || 0) + (r.runs || 0); }); (rec.bowlingCard[k] || []).forEach((r) => { imp[r.name] = (imp[r.name] || 0) + 20 * (r.wickets || 0); }); });
  Object.entries(catches).forEach(([n, c]) => { imp[n] = (imp[n] || 0) + 10 * c; });
  const mvp = Object.entries(imp).sort((a, b) => b[1] - a[1])[0];
  const fours = fx.balls.filter((b) => b.ballType === '4').length, sixes = fx.balls.filter((b) => b.ballType === '6').length;

  for (const mode of ['finished', 'live (final ball)']) {
    head(`SECTIONS — ${mode} match`);
    const { ctx, page, errors } = await open(browser, { url: mode === 'finished' ? FINAL : LIVE, fixtures: fx });
    if (mode !== 'finished') await fire(page, fx.final);
    await page.waitForTimeout(900);
    await tab(page, 'info');
    const info = await txt(page, '#sct-p-info');
    ok(/Mumbai Indians vs Chennai Super Kings/.test(info) && /3 overs a side/.test(info) && /28 Oct/.test(info) && /Wankhede Stadium, Mumbai/.test(info) && /Match 7/.test(info) && /League/.test(info),
      'Info: teams, format (3 overs a side), date, venue, match no., stage — from the match');
    ok(/Chennai Super Kings won the toss and chose to bowl first/.test(info), 'Info: the toss as recorded');
    ok(/Umpires and match officials are not recorded/i.test(info) && /Tournament Not recorded/i.test(info), 'Info: officials and tournament were never recorded — it says so, nothing made up');
    ok(/CSK WON BY 9 WICKETS/i.test(info) && /MI 36\/2 \(3\.0 ov\)/.test(info) && /CSK 39\/1 \(2\.5 ov\)/.test(info), 'Info: result and both scores');
    await page.screenshot({ path: path.join(OUT, `${mode.split(' ')[0]}-info.png`), fullPage: true });

    await tab(page, 'squads');
    const sq = await page.evaluate(() => [...document.querySelectorAll('#sct-p-squads .card')].map((c) => ({ team: c.querySelector('h3').textContent.trim(), xi: c.querySelectorAll('.sct-pl:not(.bench)').length, bench: [...c.querySelectorAll('.sct-pl.bench .nm')].map((n) => n.textContent.trim()),
      c: [...c.querySelectorAll('.sct-pl')].filter((r) => r.querySelector('.role-c')).map((r) => r.querySelector('.nm').childNodes[0].textContent.trim()),
      wk: [...c.querySelectorAll('.sct-pl')].filter((r) => r.querySelector('.role-wk')).map((r) => r.querySelector('.nm').childNodes[0].textContent.trim()),
      lhb: c.querySelectorAll('.role-lhb').length, ishan: (([...c.querySelectorAll('.sct-pl')].find((r) => /Ishan Kishan/.test(r.textContent)) || {}).textContent || '') })));
    ok(sq.length === 2 && sq[0].xi === 11 && sq[1].xi === 11 && sq[0].bench.join() === 'Nehal Wadhera' && sq[1].bench.join() === 'Shardul Thakur', 'Squads: both Playing XIs (11 each) and the bench', sq.map((x) => [x.team, x.xi, x.bench]));
    ok(sq[0].c.join() === 'Hardik Pandya' && sq[0].wk.join() === 'Ishan Kishan' && sq[1].c.join() === 'Ruturaj Gaikwad' && sq[1].wk.join() === 'MS Dhoni' && sq[0].lhb === 2 && sq[1].lhb === 2, 'Squads: captain, wicketkeeper and left-handers as the scorer set them', sq.map((x) => [x.c, x.wk, x.lhb]));
    ok(/22\*\s*\(9\)/.test(sq[0].ishan), 'Squads: a player\'s figures from this match (Ishan Kishan 22* (9))', sq[0].ishan);
    await page.screenshot({ path: path.join(OUT, `${mode.split(' ')[0]}-squads.png`), fullPage: true });

    await tab(page, 'summary');
    const segs = await page.$$eval('#sct-p-summary [data-sum-inn]', (b) => b.map((x) => [x.dataset.sumInn, x.getAttribute('aria-selected'), x.innerText.replace(/\s+/g, ' ').trim()]));
    ok(segs.length === 2 && /1st innings MI 36\/2 \(3\.0\)/i.test(segs[0][2]) && /2nd innings CSK 39\/1 \(2\.5\)/i.test(segs[1][2]), 'Summary: an innings switcher with both innings and their totals (36/2, 39/1)', segs);
    ok((segs.find((x) => x[1] === 'true') || [])[0] === '1', 'Summary: a match that is already over opens on the 1st innings', segs);
    const pick = async (no) => { await page.click(`#sct-p-summary [data-sum-inn="${no}"]`); await page.waitForTimeout(250); return txt(page, '#sct-p-summary .sct-sumbody'); };
    const s1 = await pick(1);
    const exA = rec.extras.A || {};
    ok(/1st innings Mumbai Indians 36\/2 3\.0 ov/i.test(s1) && /Overs complete/i.test(s1) && new RegExp(`Extras ${(exA.wd || 0) + (exA.nb || 0) + (exA.b || 0) + (exA.lb || 0)} \\(wd ${exA.wd || 0}`).test(s1), `Summary 1st innings: total, overs, "Overs complete", extras as recorded (wd ${exA.wd})`, s1.slice(0, 260));
    const p1 = (rec.partnerships['1'] || [])[0];
    ok(p1 && s1.includes(`${p1.batters.join(' & ')} ${p1.runs} (${p1.balls})`), `Summary 1st innings: partnerships — the 1st-wicket stand ${p1 && p1.runs} (${p1 && p1.balls}) as saved`);
    ok(/Rohit Sharma c Shivam Dube b Deepak Chahar/.test(s1) && /Suryakumar Yadav b Deepak Chahar/.test(s1) && !/Devon Conway lbw/.test(s1), 'Summary 1st innings: its own key moments only, each wicket named as on the scorecard');
    const r1 = fx.balls.filter((b) => (b.innings || 1) === 1);
    const f1 = r1.filter((b) => b.ballType === '4').length, x1 = r1.filter((b) => b.ballType === '6').length;
    ok(new RegExp(`Boundaries ${f1 + x1} ${f1} four${f1 === 1 ? '' : 's'} · ${x1} six${x1 === 1 ? '' : 'es'}`, 'i').test(s1) && new RegExp(`Boundaries ${f1 * 4 + x1 * 6} ${Math.round((f1 * 4 + x1 * 6) / 36 * 100)}%`).test(s1), `Summary 1st innings: ${f1} fours, ${x1} sixes — ${f1 * 4 + x1 * 6} of the 36 runs in boundaries (from the deliveries)`, s1.slice(0, 600));
    ok((await page.$$('#sct-p-summary .sct-sumbody svg path')).length >= 1 && (await page.$$('#sct-p-summary .sct-sumbody [data-tip]')).length >= 3, 'Summary 1st innings: runs-per-over bars and progression, each over readable on hover');
    ok(!/Target/.test(s1), 'Summary 1st innings: no chase block in a 1st innings');
    const s2 = await pick(2);
    ok(/2nd innings Chennai Super Kings 39\/1 2\.5 ov/i.test(s2) && /Target reached/i.test(s2) && /Target 37/i.test(s2) && /Chased down with 9 wickets and 1 ball to spare/.test(s2), 'Summary 2nd innings: 39/1, target 37, "Chased down with 9 wickets and 1 ball to spare"', s2.slice(0, 300));
    ok(/Devon Conway lbw b Jasprit Bumrah/.test(s2) && !/Rohit Sharma c Shivam/.test(s2), 'Summary 2nd innings: switching shows that innings\' key moments');
    ok((await page.$$('#sct-p-summary .sct-sumbody polyline')).length === 2, 'Summary 2nd innings: progression measured against the 1st innings (two lines + the target)');
    const cmp = await txt(page, '#sct-p-summary');
    ok(/Innings comparison/i.test(cmp) && /36 Runs 39/i.test(cmp) && /2 Wickets lost 1/i.test(cmp) && /12\.00 Run rate 13\.76/i.test(cmp), 'Summary: innings comparison — runs 36 v 39, wickets 2 v 1, run rate 12.00 v 13.76', cmp.slice(-600));
    ok(new URL(page.url()).searchParams.get('tab') === 'summary', 'switching innings keeps the Summary tab (and its link)');
    await page.screenshot({ path: path.join(OUT, `${mode.split(' ')[0]}-summary-2nd.png`), fullPage: true });
    await pick(1);
    await page.screenshot({ path: path.join(OUT, `${mode.split(' ')[0]}-summary-1st.png`), fullPage: true });

    await tab(page, 'insights');
    const ins = await txt(page, '#sct-p-insights');
    ok(new RegExp(`Boundaries ${fours + sixes} ${fours} fours · ${sixes} sixes`, 'i').test(ins), `Insights: ${fours + sixes} boundaries (${fours} fours, ${sixes} sixes) — counted from the deliveries`);
    ok((await page.$$('#sct-p-insights svg polyline')).length === 2 && /RR 12\.00/.test(ins) && /RR 13\.76/.test(ins), 'Insights: run-rate comparison for both innings (worm, RR 12.00 v 13.76)');
    ok(/Scoring breakdown/.test(ins) && /Batting analysis/.test(ins) && /Bowling analysis/.test(ins) && /Phases/.test(ins), 'Insights: scoring breakdown, phases, batting and bowling analysis');
    await page.screenshot({ path: path.join(OUT, `${mode.split(' ')[0]}-insights.png`), fullPage: true });

    await tab(page, 'mvp');
    const top = await txt(page, '.sct-mvp-name b'), pts = await txt(page, '.sct-mvp-pts b');
    ok(top === mvp[0] && Number(pts) === mvp[1], `MVP: ${mvp[0]} (${mvp[1]} points) — worked out independently from the record`, [top, pts]);
    const stats = await txt(page, '.sct-mvp-stats'), facts = await txt(page, '.sct-mvp-facts'), mvpAll = await txt(page, '#sct-p-mvp');
    ok(/Bowling 2\/22 2\.0 overs · econ 11\.00/i.test(stats) && !/Batting/i.test(stats), 'MVP: the real figures in one block per discipline — bowling 2/22, 2.0 overs, econ 11.00 (he did not bat)', stats);
    ok(/Best bowling of the match/i.test(facts) && /18 ahead of Ishan Kishan/i.test(await txt(page, '.sct-mvp-pts')), 'MVP: what sets him apart (best bowling of the match) and the lead (18 ahead of Ishan Kishan)', [facts, await txt(page, '.sct-mvp-pts')]);
    ok(!/×|= \d+ points|per wicket|per catch|per run/i.test(mvpAll) && !/[\u{1F300}-\u{1FAFF}]/u.test(mvpAll), 'MVP: points shown straight — no formula, no multipliers, no emoji', mvpAll.slice(0, 300));
    ok(/40 MVP points/i.test(await txt(page, '.sct-mvp-pts')), 'MVP: "40 MVP points"');
    ok((await page.$$('.sct-rank')).length >= 5, 'MVP: the standings list');
    await page.screenshot({ path: path.join(OUT, `${mode.split(' ')[0]}-mvp.png`), fullPage: true });

    await tab(page, 'commentary');
    const cm = await page.evaluate(() => ({ inHost: document.getElementById('commentary-page').parentElement.id, cover: document.documentElement.classList.contains('cm-open'),
      backdrop: document.getElementById('commentary-page-backdrop').classList.contains('open'), rows: document.querySelectorAll('#commentary-page-body [data-ball], #commentary-page-body .cm2-row, #commentary-page-body .cm-row').length,
      wrapVisible: getComputedStyle(document.getElementById('wrap')).visibility }));
    ok(cm.inHost === 'sc-cm-host' && !cm.cover && !cm.backdrop && cm.wrapVisible === 'visible' && cm.rows > 20, 'Commentary: the page\'s own full commentary, inline in the tab (no overlay)', cm);
    await page.waitForTimeout(500);
    ok(!(await page.evaluate(() => document.documentElement.classList.contains('cm-open'))), '…and it never covers the page afterwards either');
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    ok(await page.evaluate(() => document.getElementById('commentary-page').parentElement.id === 'sc-cm-host' && commentaryPageOpen), '…Escape does not close it (it is a tab, not an overlay)');
    await page.screenshot({ path: path.join(OUT, `${mode.split(' ')[0]}-commentary.png`), fullPage: true });
    await tab(page, 'scorecard');
    const back = await page.evaluate(() => ({ parent: document.getElementById('commentary-page').parentElement.tagName, open: commentaryPageOpen }));
    ok(back.parent === 'BODY' && !back.open, 'leaving Commentary puts the page back where it was, closed');
    if (await shown(page, '#commentary-open-btn')) {
      await page.click('#commentary-open-btn'); await page.waitForTimeout(500);
      const fsOpen = await page.evaluate(() => ({ open: document.getElementById('commentary-page').classList.contains('open'), cover: document.documentElement.classList.contains('cm-open'), backdrop: document.getElementById('commentary-page-backdrop').classList.contains('open') }));
      ok(fsOpen.open && fsOpen.cover && fsOpen.backdrop, '"Watch Full Commentary" on the Scorecard tab still opens it full screen, as before', fsOpen);
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
      ok(!(await page.evaluate(() => commentaryPageOpen || document.documentElement.classList.contains('cm-open'))), '…and Escape closes it, as before');
    } else ok(false, 'the Watch Full Commentary button is on the Scorecard tab');
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  head('LIVE — the open tab follows the score');
  {
    const { ctx, page, errors } = await open(browser, { url: LIVE + '&tab=summary', fixtures: fx });
    await fire(page, fx.live); await page.waitForTimeout(700);
    const before = await txt(page, '#sct-p-summary');
    ok(/CSK need 22 runs off 9 balls/.test(before) && /15\/1/.test(before) && /In progress/i.test(before), 'mid-chase: "CSK need 22 runs off 9 balls", 15/1, the innings in play shown "In progress"');
    ok(/Target 37/i.test(before) && /Need 22/i.test(before) && /Balls left 9/i.test(before) && /Required RR 14\.67/i.test(before), '…with the chase: target 37, need 22, 9 balls left, required rate 14.67', before.slice(0, 400));
    ok(await shown(page, '#sct-tab-commentary .sct-live'), 'a live match shows the live dot on Commentary');
    await fire(page, fx.final); await page.waitForTimeout(500);
    const after = await txt(page, '#sct-p-summary');
    ok(/CSK WON BY 9 WICKETS/i.test(after) && /39\/1/.test(after) && !/need 22/.test(after) && /Chased down/.test(after), 'the next update redraws Summary: 39/1 and the result, still on the innings that was followed');
    ok(!(await shown(page, '#sct-tab-commentary .sct-live')), '…and the live dot goes once there is a result');
    await tab(page, 'commentary');
    const n1 = await page.$$eval('#commentary-page-body [data-ball]', (e) => e.length).catch(() => 0);
    await fire(page, fx.live); await page.waitForTimeout(400); await fire(page, fx.final); await page.waitForTimeout(500);
    const n2 = await page.$$eval('#commentary-page-body [data-ball]', (e) => e.length).catch(() => 0);
    ok(n1 > 0 && n2 === n1, 'Commentary stays current inline while updates arrive', [n1, n2]);
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  head('CLIPS — the match\'s public clips');
  {
    const cIn = (n) => fx.clips.filter((c) => c.innings === n);
    fx.clipCalls = [];
    const { ctx, page, errors } = await open(browser, { url: FINAL, fixtures: fx });
    await page.waitForTimeout(1200);
    const calls0 = fx.clipCalls.length;
    await tab(page, 'clips'); await page.waitForTimeout(400);
    ok(fx.clipCalls.length === calls0 && calls0 >= 1, 'opening Clips asks the server for nothing new — it is the list the Highlights card already loaded', [calls0, fx.clipCalls.length]);
    const seg = await page.$$eval('#sct-p-clips [data-cl-inn]', (b) => b.map((x) => [x.dataset.clInn, x.getAttribute('aria-selected'), x.innerText.replace(/\s+/g, ' ').trim()]));
    ok(seg.length === 3 && /1st innings · MI/i.test(seg[0][2]) && new RegExp(`${cIn(1).length} clips`).test(seg[0][2]) && /2nd innings · CSK/i.test(seg[1][2]) && /All innings/i.test(seg[2][2]) && seg[0][1] === 'true', 'Clips: 1st / 2nd innings / All, with counts; a finished match opens on the 1st', seg);
    const cards = () => page.$$eval('#sct-p-clips .scl-card', (b) => b.map((x) => ({ id: x.dataset.clipId, dis: x.disabled, t: x.innerText.replace(/\s+/g, ' ').trim() })));
    let cs = await cards();
    ok(cs.length === cIn(1).length && cs.every((c) => cIn(1).some((x) => x.clipId === c.id)), `Clips 1st innings: exactly its ${cIn(1).length} clips`, cs.map((c) => c.id));
    const c0 = cIn(1)[0];
    ok(cs[0].id === c0.clipId && new RegExp(`Ov ${c0.over}\\.${c0.ballInOver}`).test(cs[0].t) && /MI · 1st innings/i.test(cs[0].t) && /Four · 4 runs/i.test(cs[0].t), 'a card: the player, team, innings, over.ball and what happened', cs[0].t);
    ok(await page.$$eval('#sct-p-clips .scl-card img', (i) => i.length) === cIn(1).filter((c) => c.posterUrl).length && await page.$$eval('#sct-p-clips .scl-fallback', (i) => i.length) === cIn(1).filter((c) => !c.posterUrl).length, 'real poster frames where the clip has one, the designed fallback (no fake thumbnail) where not');
    ok(/1 older clip with no innings recorded is under All innings/i.test(await txt(page, '#sct-p-clips')), 'the old clip with no innings is not put in an innings — it says where it is');
    ok((await page.$$('#sct-p-clips [data-delete-clip], #sct-p-clips [data-edit-clip]')).length === 0, 'no owner edit / delete controls in the viewer\'s Clips tab');
    // category
    await page.click('#sct-p-clips [data-cl-type="SIX"]'); await page.waitForTimeout(200);
    cs = await cards();
    ok(cs.length === cIn(1).filter((c) => c.eventType === 'SIX').length && cs.every((c) => /Six · 6 runs/i.test(c.t)), 'category 6s: only the sixes of the innings', cs.map((c) => c.t));
    await page.click('#sct-p-clips [data-cl-type=""]'); await page.waitForTimeout(200);
    // team: in MI's innings, CSK's clips are its bowlers' / fielders' wickets
    await page.click('#sct-p-clips [data-cl-team="B"]'); await page.waitForTimeout(200);
    cs = await cards();
    ok(cs.length === cIn(1).filter((c) => c.eventType === 'WICKET').length && cs.every((c) => /Wicket/.test(c.t)), 'team CSK in the 1st innings: its wickets (the clips its players earned)', cs.map((c) => c.t));
    await page.click('#sct-p-clips [data-cl-team=""]'); await page.waitForTimeout(200);
    // player
    await page.selectOption('#sct-p-clips [data-cl-player]', 'Deepak Chahar'); await page.waitForTimeout(250);
    cs = await cards();
    const dc = cIn(1).filter((c) => [c.striker, c.bowler, c.fielder, c.dismissedPlayer].includes('Deepak Chahar'));
    ok(cs.length === dc.length && cs.length > 0, `player Deepak Chahar: his ${dc.length} clips of the innings`, cs.map((c) => c.t));
    await page.selectOption('#sct-p-clips [data-cl-player]', ''); await page.waitForTimeout(200);
    // search, typed
    await page.fill('#sct-p-clips [data-cl-q]', 'rohi'); await page.waitForTimeout(350);
    cs = await cards();
    const rs = cIn(1).filter((c) => [c.striker, c.bowler, c.fielder, c.dismissedPlayer].some((n) => /rohi/i.test(n || '')));
    ok(cs.length === rs.length && cs.length > 0 && (await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-cl-q]'))), `search "rohi": Rohit Sharma's ${rs.length} clips, the box keeps its focus while typing`, cs.length);
    await page.fill('#sct-p-clips [data-cl-q]', 'zzz'); await page.waitForTimeout(350);
    ok(/No clips match these filters/.test(await txt(page, '#sct-p-clips')), 'a search with nothing: "No clips match these filters" with a way back');
    await page.click('#sct-p-clips [data-cl-clear]'); await page.waitForTimeout(250);
    cs = await cards();
    ok(cs.length === cIn(1).length, '"Clear filters" brings every clip of the innings back', [cs.length, await txt(page, '#sct-p-clips')]);
    // sort
    await page.selectOption('#sct-p-clips [data-cl-sort]', 'latest'); await page.waitForTimeout(250);
    cs = await cards();
    const newest = cIn(1).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    ok(cs[0].id === newest.clipId, 'sort "Latest clip first"', [cs[0].id, newest.clipId]);
    await page.selectOption('#sct-p-clips [data-cl-sort]', 'over'); await page.waitForTimeout(200);
    // 2nd innings: the unready clip
    await page.click('#sct-p-clips [data-cl-inn="2"]'); await page.waitForTimeout(250);
    cs = await cards();
    ok(cs.length === cIn(2).length && cs.filter((c) => c.dis).length === 1 && /Uploading…/.test(cs.find((c) => c.dis).t), 'Clips 2nd innings: its clips; the one still uploading says so and cannot be played', cs.map((c) => [c.id, c.dis]));
    // All innings: the old clip, unassigned
    await page.click('#sct-p-clips [data-cl-inn="all"]'); await page.waitForTimeout(250);
    ok((await cards()).length === Math.min(12, fx.clips.length) && new RegExp(`^${fx.clips.length} clips$`).test(await txt(page, '#sct-p-clips .scl-count')), `All innings: ${fx.clips.length} clips, the first 12 shown`);
    if (await page.$('#sct-p-clips [data-cl-more]')) { await page.click('#sct-p-clips [data-cl-more]'); await page.waitForTimeout(250); }
    cs = await cards();
    ok(cs.length === fx.clips.length && /innings not recorded/i.test((cs.find((c) => c.id === 'cold') || {}).t || '') && /shown here, not guessed into an innings/.test(await txt(page, '#sct-p-clips')), 'All innings: every clip; the old one reads "innings not recorded"', cs.length);
    // play, and come back to the same filters
    await page.click('#sct-p-clips [data-cl-type="FOUR"]'); await page.waitForTimeout(200);
    const first = (await cards())[0];
    await page.click(`#sct-p-clips .scl-card[data-clip-id="${first.id}"]`); await page.waitForTimeout(700);
    const vm = await page.evaluate(() => ({ open: document.getElementById('video-modal-backdrop').classList.contains('open'), title: document.getElementById('video-modal-title').textContent, src: document.querySelector('#video-modal-backdrop video') && document.querySelector('#video-modal-backdrop video').getAttribute('src') }));
    ok(vm.open && /Four/.test(vm.title) && /bg-video\.mp4/.test(vm.src || ''), 'tapping a clip plays it in the page\'s own clip player (its CDN link)', vm);
    await page.screenshot({ path: path.join(OUT, 'clips-playing.png') });
    await page.keyboard.press('Escape'); await page.waitForTimeout(500);
    const kept = await page.evaluate(() => ({ open: document.getElementById('video-modal-backdrop').classList.contains('open'), inn: (document.querySelector('#sct-p-clips [data-cl-inn][aria-selected="true"]') || {}).dataset, type: (document.querySelector('#sct-p-clips .scl-chip.on[data-cl-type]') || {}).dataset }));
    ok(!kept.open && kept.inn && kept.inn.clInn === 'all' && kept.type && kept.type.clType === 'FOUR', 'closing the player returns to the list with the same innings and filters', kept);
    await page.click('#sct-p-clips [data-cl-type=""]'); await page.click('#sct-p-clips [data-cl-inn="1"]'); await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'clips.png'), fullPage: true });
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();

    // paging: a long list shows 12 at a time
    const many = fx.clips.concat(Array.from({ length: 15 }, (_, i) => Object.assign({}, fx.clips[0], { clipId: 'g' + i, eventType: 'CLIP', over: null, ballInOver: null, outcome: 'Fielding highlight', createdAt: new Date(1791000000000 + i).toISOString() })));
    const pg = await open(browser, { url: FINAL + '&tab=clips', fixtures: fx, clips: many });
    await pg.page.waitForTimeout(1200);
    const n1 = many.filter((c) => c.innings === 1).length;
    ok((await pg.page.$$('#sct-p-clips .scl-card')).length === 12 && /Show 12 more · 12 left|Show \d+ more · \d+ left/.test(await txt(pg.page, '#sct-p-clips .scl-more')), `paging: 12 of the innings' ${n1} clips, then "Show more"`);
    await pg.page.click('#sct-p-clips [data-cl-more]'); await pg.page.waitForTimeout(250);
    ok((await pg.page.$$('#sct-p-clips .scl-card')).length === Math.min(24, n1), '"Show more" adds the next 12');
    await pg.ctx.close();

    // still loading, failed (and retry), none at all, imported
    const ld = await open(browser, { url: FINAL + '&tab=clips', fixtures: fx, clipsDelay: 2500 });
    await ld.page.waitForTimeout(700);
    ok((await ld.page.$$('#sct-p-clips .scl-skel')).length > 0, 'while the clips load: placeholder cards (aria-busy), no "no clips" yet');
    await ld.page.waitForTimeout(2600);
    ok((await ld.page.$$('#sct-p-clips .scl-card')).length === cIn(1).length, '…then the clips, on their own');
    await ld.ctx.close();
    fx.clipCalls = [];
    const er = await open(browser, { url: FINAL + '&tab=clips', fixtures: fx, clipsStatus: 500 });
    await er.page.waitForTimeout(1200);
    ok(/The clips could not be loaded/.test(await txt(er.page, '#sct-p-clips')), 'the server failing: "The clips could not be loaded" with Try again');
    const before = fx.clipCalls.length;
    await er.page.click('#sct-p-clips [data-cl-retry]'); await er.page.waitForTimeout(600);
    ok(fx.clipCalls.length > before, '…Try again asks again');
    await er.ctx.close();
    const no = await open(browser, { url: FINAL + '&tab=clips', fixtures: fx, clips: [] });
    await no.page.waitForTimeout(1200);
    ok(/No clips for this match yet/.test(await txt(no.page, '#sct-p-clips')), 'a match with no clips says so');
    await no.ctx.close();
    const lv = await open(browser, { url: LIVE + '&tab=clips', fixtures: fx });
    await fire(lv.page, fx.live); await lv.page.waitForTimeout(1200);
    ok((await lv.page.$eval('#sct-p-clips [data-cl-inn][aria-selected="true"]', (e) => e.dataset.clInn).catch(() => '')) === '2', 'live: Clips opens on the innings in play');
    ok(lv.errors.length === 0, 'no page errors', lv.errors);
    await lv.ctx.close();
  }

  head('A TEST MATCH — four innings, each with its own team and number');
  {
    const tx = await playTest();
    ok(tx.panelErrors.length === 0 && tx.final.inningsNumber === 4 && tx.final.target === 17, `the panel played a 4-innings Test (4th-innings target ${tx.final.target}, "${tx.record.resultText || tx.final.matchResultText || ''}")`, [tx.panelErrors, tx.final.inningsNumber, tx.final.target]);
    const tfx = { record: tx.record, balls: tx.balls, clips: [] };
    for (const mode of ['finished', 'live']) {
      const { ctx, page, errors } = await open(browser, { url: (mode === 'finished' ? FINAL : LIVE) + '&tab=summary', fixtures: tfx });
      if (mode === 'live') await fire(page, tx.final);
      await page.waitForTimeout(1000);
      const segs = await page.$$eval('#sct-p-summary [data-sum-inn]', (b) => b.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
      ok(segs.length === 4 && /1st innings IND 21\/0d/i.test(segs[0]) && /2nd innings AUS 16\/0d/i.test(segs[1]) && /3rd innings IND 11\/0d/i.test(segs[2]) && /4th innings AUS 17\/0/i.test(segs[3]), `${mode}: the switcher has all four innings, each with its team and total (declarations marked d)`, segs);
      await page.click('#sct-p-summary [data-sum-inn="3"]'); await page.waitForTimeout(250);
      const t3 = await txt(page, '#sct-p-summary .sct-sumbody');
      ok(/3rd innings India 11\/0d/i.test(t3) && /Declared/i.test(t3) && !/Target/.test(t3), `${mode}: the 3rd innings is India's second, declared`, t3.slice(0, 200));
      await page.click('#sct-p-summary [data-sum-inn="4"]'); await page.waitForTimeout(250);
      const t4 = await txt(page, '#sct-p-summary .sct-sumbody');
      ok(/4th innings Australia 17\/0/i.test(t4) && /Target 17/i.test(t4) && /Chased down with 10 wickets to spare/.test(t4) && !/in \d+ overs/.test(t4), `${mode}: the 4th innings chases the lead — target 17 (21 + 11 − 16 + 1), no overs limit in a Test`, t4.slice(0, 300));
      const tbl = await page.$$eval('#sct-p-summary table th', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
      ok(tbl.length === 5 && /IND 1st/i.test(tbl[1]) && /AUS 4th/i.test(tbl[4]), `${mode}: four innings compared in one table`, tbl);
      ok(errors.length === 0, `${mode}: no page errors`, errors);
      if (mode === 'finished') await page.screenshot({ path: path.join(OUT, 'test-match-summary.png'), fullPage: true });
      await ctx.close();
    }
  }

  head('EMPTY STATES');
  {
    const { ctx, page, errors } = await open(browser, { url: LIVE, fixtures: fx });
    await fire(page, fx.pre); await page.waitForTimeout(600);
    for (const [id, re] of [['summary', /builds up as the match is played/], ['insights', /appear once the first ball is bowled/], ['mvp', /No MVP yet/]]) {
      await tab(page, id);
      ok(re.test(await txt(page, '#sct-p-' + id)), `before the first ball, ${id} says what will appear (no made-up figures)`);
    }
    await tab(page, 'squads');
    ok((await page.$$('#sct-p-squads .sct-pl')).length === 24, 'Squads are there before the first ball');
    await tab(page, 'commentary');
    ok(/Commentary will appear here once the innings begins/.test(await txt(page, '#sct-p-commentary')), 'Commentary: the page\'s own "will appear here" line');
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
    const imported = Object.assign({}, fx.record, { importSource: 'photo', squadA: null, squadB: null });
    const im = await open(browser, { url: FINAL + '&tab=insights', fixtures: fx, record: imported, balls: [] });
    await im.page.waitForTimeout(900);
    ok(/imported from a scorecard/.test(await txt(im.page, '#sct-p-insights')), 'an imported scorecard (no deliveries): Insights says why there is nothing ball-by-ball');
    await tab(im.page, 'summary');
    const isum = await txt(im.page, '#sct-p-summary');
    ok(/Dot balls — no ball-by-ball record/i.test(isum) && !/NaN|undefined/.test(isum), '…Summary claims nothing ball-by-ball for it (dot balls: no record), no broken numbers', isum.slice(0, 400));
    await tab(im.page, 'clips');
    ok(/imported from a scorecard/.test(await txt(im.page, '#sct-p-clips')), '…and Clips says an imported match has none');
    await tab(im.page, 'squads');
    ok(/players who batted or bowled/.test(await txt(im.page, '#sct-p-squads')) && (await im.page.$$('#sct-p-squads .sct-pl')).length > 0, '…and with no squad saved, Squads lists who batted or bowled and says so');
    ok(im.errors.length === 0, 'no page errors', im.errors);
    await im.ctx.close();
  }

  head('PHONE (390 px) — every tab fits');
  {
    const { ctx, page, errors } = await open(browser, { url: FINAL, vp: { width: 390, height: 844 }, fixtures: fx });
    await page.waitForTimeout(900);
    const bar = await page.$eval('#sc-tabs .sct-track', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
    ok(bar.sw > bar.cw, 'the tab bar scrolls sideways inside itself on a phone', bar);
    for (const id of ['scorecard', 'info', 'squads', 'commentary', 'clips', 'summary', 'insights', 'mvp']) {
      await tab(page, id);
      await page.waitForTimeout(500);   // the bar scrolls the chosen tab into view (smoothly)
      const r = await page.evaluate((id) => { const b = document.getElementById('sct-tab-' + id).getBoundingClientRect(); return { over: document.documentElement.scrollWidth - innerWidth, inView: b.left >= -1 && b.right <= innerWidth + 1 }; }, id);
      ok(r.over <= 0 && r.inView, `${id}: no sideways scroll on the page, its tab in view`, r);
      await page.screenshot({ path: path.join(OUT, `phone-${id}.png`), fullPage: true });
    }
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
