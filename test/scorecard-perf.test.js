// cricket-scorecard.html — performance guards. A full T20 (both innings,
// ~240 deliveries, long commentary, ~60 clips) is scored on the REAL panel in
// jsdom, then the REAL scorecard runs in Chromium on a desktop and on a phone
// profile (390 px, CPU slowed 4x). Each check guards a measured fix:
//   • nothing animates on the main thread while the page sits idle (live
//     dots, the highlights shimmer and the momentum marker animate transform /
//     opacity only) — a throttled phone stays near idle
//   • a live ball lays the page out a handful of times, not 20+ (the momentum
//     marker used to slide by its left offset, re-laying out every frame)
//   • the "value changed" pop forces no synchronous layout; on a phone it
//     scales only (no main-thread colour animation)
//   • opening a match asks for its clip list once (no duplicate pages)
//   • switching tabs 15 times leaks no listeners, nodes or heap
// Thresholds are generous (several times the measured values) so the test
// flags regressions, not machine noise.
//
// Run:  NODE_PATH=$(npm root -g) node test/scorecard-perf.test.js   (needs jsdom + playwright)
const fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const H = require('./cricket/server-harness.js');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, msg, d) => { if (c) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 400) : '')); } };
const head = (t) => console.log('\n' + t);

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

function rng(seed){ let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
async function playT20() {
  const P = bootPanel();
  await sleep(80);
  const rnd = rng(42);
  const click = (sel) => P.$(sel).dispatchEvent(new P.w.Event('click', { bubbles: true }));
  let bowlers = [], overNo = 0;
  const nextOver = () => { if (P.$('#newover-modal-overlay').classList.contains('show')) { overNo++; const [n, id] = bowlers[overNo % bowlers.length]; P.E(`closeNewOverModal(); setLiveBowler(${JSON.stringify(n)}, ${JSON.stringify(id)}); renderPanel();`); } };
  const ball = (k) => { P.E(k === 'Wd' ? `recordBall('Wd', { extraRuns: 0 })` : `recordBall(${JSON.stringify(k)})`); nextOver(); };
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
  const A = ['Rohit Sharma', 'Ishan Kishan', 'Suryakumar Yadav', 'Tilak Varma', 'Hardik Pandya', 'Tim David', 'Krunal Pandya', 'Piyush Chawla', 'Jasprit Bumrah', 'Akash Madhwal', 'Gerald Coetzee'];
  const B = ['Ruturaj Gaikwad', 'Devon Conway', 'Ajinkya Rahane', 'Shivam Dube', 'Moeen Ali', 'Ravindra Jadeja', 'MS Dhoni', 'Deepak Chahar', 'Tushar Deshpande', 'Matheesha Pathirana', 'Maheesh Theekshana'];
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A'; state.wagonWheelOn = false;
    state.venue = 'Wankhede Stadium, Mumbai'; state.matchDate = '2026-10-28'; state.matchNo = 7;
    document.getElementById('match-id').value = 'PERF1';
    state.teamA.name = 'Mumbai Indians'; state.teamA.short = 'MI'; state.teamA.color = '#004ba0';
    state.teamB.name = 'Chennai Super Kings'; state.teamB.short = 'CSK'; state.teamB.color = '#f9cd05';
    state.teamA.players = ${JSON.stringify(A)}.map((n, i) => ({ id: 'a' + (i + 1), name: n, isXI: true }));
    state.teamB.players = ${JSON.stringify(B)}.map((n, i) => ({ id: 'b' + (i + 1), name: n, isXI: true }));
    state.toss = { winner: 'B', decision: 'BOWL' };
    state.striker    = { name:'Rohit Sharma', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan Kishan', id:'a2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Deepak Chahar', id:'b8', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = []; pendingWicketDelivery = null;
    renderPanel();
  `);
  const play = (balls, wkts, fielders) => {
    let w = 0;
    for (let i = 0; i < balls; i++) {
      const done = P.J('(isInningsOver() || (state.milestonesHit && state.milestonesHit["match-result"])) ? 1 : 0');
      if (done) break;
      const r = rnd();
      if (w < wkts && r < 0.05) { w++; out(['Caught', 'Bowled', 'LBW', 'Caught'][w % 4], ['Caught'].includes(['Caught', 'Bowled', 'LBW', 'Caught'][w % 4]) ? fielders[w % fielders.length] : null); }
      else ball(r < 0.08 ? 'Wd' : r < 0.42 ? '0' : r < 0.70 ? '1' : r < 0.80 ? '2' : r < 0.82 ? '3' : r < 0.93 ? '4' : '6');
      if (cb) cb();
    }
  };
  let cb = null;
  bowlers = [['Deepak Chahar', 'b8'], ['Matheesha Pathirana', 'b10'], ['Tushar Deshpande', 'b9'], ['Ravindra Jadeja', 'b6'], ['Maheesh Theekshana', 'b11']]; overNo = 0;
  play(400, 7, ['b4', 'b2', 'b7']);
  click('#next-innings-btn');
  P.E(`
    state.striker    = { name:'Ruturaj Gaikwad', id:'b1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Devon Conway', id:'b2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Jasprit Bumrah', id:'a9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    renderPanel();
  `);
  bowlers = [['Jasprit Bumrah', 'a9'], ['Hardik Pandya', 'a5'], ['Gerald Coetzee', 'a11'], ['Akash Madhwal', 'a10'], ['Piyush Chawla', 'a8']]; overNo = 0;
  const states = [];
  let n = 0;
  cb = () => { n++; if (n > 60 && states.length < 60) states.push(P.J('state')); };
  play(400, 5, ['a4', 'a3', 'a6']);
  const final = P.J('state');
  const record = P.J('buildMatchRecordForLeague()');
  const deliveries = P.emits.filter((e) => e.ev === 'logBall').map((e) => e.payload);
  const api = H.build({ balls: H.coll([]), clips: H.coll([]), records: H.coll([]), rooms: {}, emits: [], audits: [] }, ['personName', 'playerKey', 'normalizeKindForPublic', 'sanitizeShot', 'buildBallFromCorrection', 'mapBallForPublic'], []);
  const balls = deliveries.map((d, i) => api.mapBallForPublic(Object.assign({ timestamp: 1790000000000 + i * 30000 }, d, { striker: api.personName(d.striker), nonStriker: api.personName(d.nonStriker), bowler: api.personName(d.bowler) })));
  const clips = [];
  balls.forEach((b, i) => {
    const t = b.ballType === '6' ? 'SIX' : b.ballType === '4' ? 'FOUR' : b.isWicket ? 'WICKET' : null;
    if (!t) return;
    clips.push({ clipId: 'c' + i, matchId: 'PERF1', eventType: t, isHighlight: true, dismissalType: t === 'WICKET' ? ((b.dismissal || {}).type || null) : null, over: b.over, ballInOver: b.ballInOver, innings: b.innings || 1,
      battingTeam: (b.innings || 1) === 1 ? 'A' : 'B', striker: b.striker, bowler: b.bowler, fielder: (b.dismissal || {}).fielder || null, dismissedPlayer: t === 'WICKET' ? ((b.dismissal || {}).batter || b.striker) : null,
      ready: true, status: 'COMPLETE', playbackUrl: '/bg-video.mp4', posterUrl: clips.length % 2 ? '/logo.png' : null, downloadUrl: '/api/clips/c' + i + '/download', createdAt: new Date(1790000000000 + i * 30000).toISOString(), duration: 10 });
  });
  return { states, record, balls, clips, panelErrors: P.errors.filter((e) => !/Could not parse CSS|Not implemented/.test(e)) };
}

/* ---------------- the scorecard in Chromium ---------------- */
const FIREBASE = 'function deep(){return new Proxy(function(){},{get:(t,k)=>k===Symbol.toPrimitive?(()=>0):(k==="then"?undefined:deep()),apply:()=>deep()})};const __auth=new Proxy({currentUser:null,onAuthStateChanged(cb){setTimeout(()=>cb(null),0);return ()=>{}}},{get:(t,k)=>k in t?t[k]:deep()});window.firebase=new Proxy({initializeApp(){},apps:[],auth:Object.assign(()=>__auth,{GoogleAuthProvider:function(){}})},{get:(t,k)=>k in t?t[k]:deep()});';
const SOCKET = 'window.io=function(){const h={};const s={on:(e,f)=>{(h[e]=h[e]||[]).push(f);return s},emit:()=>{},connected:true,removeAllListeners(){},disconnect(){}};window.__fire=(e,p)=>(h[e]||[]).forEach(f=>f(p));return s};';
const PAGE = fs.readFileSync(path.join(ROOT, 'cricket-scorecard.html'), 'utf8');
async function open(browser, fx, { phone, url }) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(FIREBASE + SOCKET);
  const page = await ctx.newPage();
  const errors = [], api = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.host !== 'test.local') return route.fulfill({ status: 404, body: '' });
    if (u.pathname.startsWith('/api/')) api.push(u.pathname + u.search);
    if (u.pathname === '/api/public/match/PERF1') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, match: fx.record }) });
    if (u.pathname === '/api/public/match/PERF1/balls') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, balls: fx.balls }) });
    if (u.pathname === '/api/clips/match/PERF1') { const skip = Number(u.searchParams.get('skip')) || 0, limit = Number(u.searchParams.get('limit')) || 50; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, clips: fx.clips.slice(skip, skip + limit) }) }); }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"success":false}' });
    if (u.pathname === '/cricket-scorecard.html') return route.fulfill({ contentType: 'text/html', body: PAGE });
    const f = path.join(ROOT, u.pathname);
    if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: '' });
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (phone) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(url || 'http://test.local/cricket-scorecard.html?room=PERF1');
  if (/history=1/.test(url || '')) return { ctx, page, cdp, errors, api };   // a finished match opens no socket
  await page.waitForFunction(() => typeof window.__fire === 'function');
  // every live state sits in the page; an update is parsed from JSON, as the socket does
  await page.evaluate((all) => { window.__states = all; }, fx.states.map((x) => JSON.stringify(x)));
  return { ctx, page, cdp, errors, api };
}
const metrics = async (cdp) => { const { metrics: m } = await cdp.send('Performance.getMetrics'); const o = {}; m.forEach((x) => { o[x.name] = x.value; }); return o; };
const fire = (page, i) => page.evaluate((i) => window.__fire('liveCricketScore', JSON.parse(window.__states[i])), i);
// every animation running now, and whether it touches anything but transform / opacity
const mainThreadAnims = (page) => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => {
  const props = [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((x) => !['offset', 'easing', 'composite', 'computedOffset'].includes(x))))];
  const t = a.effect.target; const el = t && t.nodeType === 1 ? t : null;
  return { name: a.animationName || a.transitionProperty || a.constructor.name, el: el ? (el.id || el.className || el.tagName) + (a.effect.pseudoElement || '') : '?', props };
}).filter((a) => a.props.some((p) => p !== 'transform' && p !== 'opacity')));

(async () => {
  head('THE MATCH — a full T20 scored on the real panel');
  const fx = await playT20();
  ok(fx.panelErrors.length === 0 && fx.balls.length > 200 && fx.states.length >= 40 && fx.clips.length > 30, `${fx.balls.length} deliveries, ${fx.clips.length} clips, ${fx.states.length} live states to replay`, fx.panelErrors);
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

  for (const phone of [false, true]) {
    const P = phone ? 'phone (390 px, CPU 4x slower)' : 'desktop (1440 px)';
    head(`LIVE — ${P}`);
    const { ctx, page, cdp, errors } = await open(browser, fx, { phone });
    await fire(page, 0); await sleep(1200); await fire(page, 1); await sleep(3000);
    const idleAnims = await mainThreadAnims(page);
    ok(idleAnims.length === 0, 'idle: nothing animates on the main thread (live dots, shimmer, marker: transform / opacity only)', idleAnims);
    const i0 = await metrics(cdp), t0 = Date.now(); await sleep(8000); const i1 = await metrics(cdp);
    const idleCpu = (i1.TaskDuration - i0.TaskDuration) / ((Date.now() - t0) / 1000) * 100;
    ok(idleCpu < 5, `idle: the page uses ${Math.round(idleCpu * 10) / 10}% of the CPU with nothing happening (< 5%; was ~28-49% on this phone profile)`);
    const m0 = await metrics(cdp);
    for (let i = 2; i < 22; i++) { await fire(page, i); await sleep(900); }
    const m1 = await metrics(cdp);
    const layouts = (m1.LayoutCount - m0.LayoutCount) / 20, ms = (m1.TaskDuration - m0.TaskDuration) * 1000 / 20;
    ok(layouts <= 6, `a live ball lays the page out ${Math.round(layouts * 10) / 10} times (≤ 6; was 20-25 on the phone profile)`);
    ok(ms < (phone ? 600 : 120), `main-thread time per ball: ${Math.round(ms)} ms (< ${phone ? 600 : 120}; measured ~370 / ~58, was ~766 / ~64)`);
    // the value pop: restarted without a forced layout; on a phone, a scale only
    const pop = await page.evaluate(() => { const el = document.querySelector('.val-pop') || document.getElementById('main-score'); const cs = getComputedStyle(el); return { name: cs.animationName }; });
    ok(phone ? pop.name === 'valPopScale' : pop.name === 'valPop', `the "value changed" pop is ${phone ? 'a scale only on a phone' : 'the full pop on a desktop'} (${pop.name})`);
    const marker = await page.evaluate(() => { const m = document.getElementById('momentum-marker'); return { left: m.style.left, transform: m.style.transform, transition: getComputedStyle(m).transitionProperty }; });
    ok(!marker.left && /translateX\(/.test(marker.transform) && marker.transition === 'transform', 'the momentum marker slides by transform, not by left', marker);
    // tabs: 15 rounds, no leaks
    const ids = await page.$$eval('#sc-tabs [data-tab]', (b) => b.map((x) => x.dataset.tab));
    for (const id of ids.concat(['scorecard'])) { await page.evaluate((id) => document.getElementById('sct-tab-' + id).click(), id); await sleep(60); }
    await cdp.send('HeapProfiler.collectGarbage'); await sleep(300);
    const h0 = await metrics(cdp);
    for (let r = 0; r < 15; r++) for (const id of ids.concat(['scorecard'])) { await page.evaluate((id) => document.getElementById('sct-tab-' + id).click(), id); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))); }
    await cdp.send('HeapProfiler.collectGarbage'); await sleep(300);
    const h1 = await metrics(cdp);
    ok(h1.JSEventListeners - h0.JSEventListeners <= 0 && h1.Nodes - h0.Nodes <= 50 && (h1.JSHeapUsedSize - h0.JSHeapUsedSize) < 2 * 1048576,
      `15 rounds of every tab: no listener, node or heap growth (${h1.JSEventListeners - h0.JSEventListeners} listeners, ${h1.Nodes - h0.Nodes} nodes, ${Math.round((h1.JSHeapUsedSize - h0.JSHeapUsedSize) / 1024)} KB)`);
    const sections = await page.evaluate(() => ({ off: document.getElementById('wrap').classList.contains('sct-off'), marked: [...document.getElementById('wrap').children].filter((c) => c.classList.contains('sct-sec')).length, attr: document.documentElement.dataset.scTab }));
    ok(!sections.off && sections.marked > 5 && sections.attr === 'scorecard', 'tabs hide the Scorecard sections by a class on #wrap (only those sections re-styled)', sections);
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  head('OPENING A FINISHED MATCH');
  {
    const { ctx, page, errors, api } = await open(browser, fx, { url: 'http://test.local/cricket-scorecard.html?room=PERF1&history=1' });
    await sleep(3500);
    const lists = api.filter((u) => u.startsWith('/api/clips/match/PERF1'));
    const dup = lists.filter((u, i) => lists.indexOf(u) !== i);
    ok(lists.length > 0 && dup.length === 0, `the clip list is asked for once — ${lists.length} page request(s), no duplicates (was the whole list 3 times over)`, lists);
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
