// cricket-scorecard.html — the match sections tab bar (Scorecard · Info ·
// Squads · Commentary · Summary · Insights · MVP), on the REAL page with
// data from the REAL panel.
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

/* ---------------- 2. the scorecard page in Chromium ---------------- */
const FIREBASE = 'function deep(){return new Proxy(function(){},{get:(t,k)=>k===Symbol.toPrimitive?(()=>0):(k==="then"?undefined:deep()),apply:()=>deep()})};const __auth=new Proxy({currentUser:null,onAuthStateChanged(cb){setTimeout(()=>cb(null),0);return ()=>{}}},{get:(t,k)=>k in t?t[k]:deep()});window.firebase=new Proxy({initializeApp(){},apps:[],auth:Object.assign(()=>__auth,{GoogleAuthProvider:function(){}})},{get:(t,k)=>k in t?t[k]:deep()});';
const SOCKET = 'window.io=function(){const h={};const s={on:(e,f)=>{(h[e]=h[e]||[]).push(f);return s},emit:()=>{},connected:true,removeAllListeners(){},disconnect(){}};window.__fire=(e,p)=>(h[e]||[]).forEach(f=>f(p));return s};';
const PAGE = fs.readFileSync(path.join(ROOT, 'cricket-scorecard.html'), 'utf8');
// the same page with the tabs code (its <style> and its <script>) taken out
const PAGE_WITHOUT_TABS = PAGE.replace(/<style id="sc-tabs-style">[\s\S]*?<\/style>/, '').replace(/<script>\s*\/\*\s*=+\s*\n\s*🧭 MATCH SECTIONS[\s\S]*?<\/script>/, '');

async function open(browser, { url, vp, fixtures, record, balls, html, scheme }) {
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

  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  // the fixed background behind the translucent cards is not part of the scorecard: one flat colour in both
  const hideWash = '#ambient-wash,#logo-wash{display:none!important} html,body{background:#0b0e14!important;background-image:none!important}';

  head('SCORECARD TAB — the page exactly as before');
  for (const [mode, url, vp] of [['live', LIVE, { width: 1280, height: 900 }], ['finished', FINAL, { width: 1280, height: 900 }], ['live', LIVE, { width: 390, height: 844 }]]) {
    const a = await open(browser, { url, vp, fixtures: fx });
    const b = await open(browser, { url, vp, fixtures: fx, html: PAGE_WITHOUT_TABS });
    for (const x of [a, b]) { if (mode === 'live') await fire(x.page, fx.live); await x.page.waitForTimeout(900); await x.page.addStyleTag({ content: hideWash }); await x.page.waitForTimeout(100); }
    const htmlA = await a.page.evaluate(() => { const w = document.getElementById('wrap').cloneNode(true); const p = w.querySelector('#sc-panels'); if (p) p.remove(); return w.innerHTML; });
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
    const disp = (pg) => pg.evaluate(() => [...document.getElementById('wrap').children].filter((c) => c.id !== 'sc-panels').map((c) => (c.id || c.className) + ':' + getComputedStyle(c).display));
    const da = await disp(a.page), db = await disp(b.page);
    ok(JSON.stringify(da) === JSON.stringify(db), `${mode} ${vp.width}px: every section of the scorecard shown / hidden exactly as without the tabs`, [da, db]);
    ok(a.errors.length === 0 && b.errors.length === 0, `${mode} ${vp.width}px: no page errors`, a.errors.concat(b.errors));
    await a.ctx.close(); await b.ctx.close();
  }

  head('THE TAB BAR — sections, the link, the keyboard');
  {
    const { ctx, page, errors } = await open(browser, { url: LIVE, fixtures: fx });
    await fire(page, fx.live); await page.waitForTimeout(600);
    const tabs = await page.$$eval('#sc-tabs [role="tab"]', (b) => b.map((x) => [x.dataset.tab, x.textContent.trim(), x.getAttribute('aria-selected')]));
    ok(JSON.stringify(tabs.map((t) => t[0])) === JSON.stringify(['scorecard', 'info', 'squads', 'commentary', 'summary', 'insights', 'mvp']), 'seven tabs in order, Scorecard selected first', tabs);
    ok(tabs[0][2] === 'true' && !new URL(page.url()).searchParams.has('tab'), 'Scorecard is selected and the link carries no ?tab=');
    const barTop = await page.$eval('#sc-tabs', (e) => e.getBoundingClientRect().top), brand = await page.$eval('#brandbar', (e) => e.getBoundingClientRect().bottom);
    ok(Math.abs(barTop - brand) < 1.5, 'the bar sits right under the brand bar');
    for (const id of ['info', 'squads', 'commentary', 'summary', 'insights', 'mvp']) {
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
    const sum = await txt(page, '#sct-p-summary');
    ok(/1st innings · Mumbai Indians 36\/2/.test(sum) && /2nd innings · Chennai Super Kings 39\/1/.test(sum), 'Summary: both innings with the totals of the record (36/2, 39/1)');
    const p1 = (rec.partnerships['1'] || [])[0];
    ok(p1 && sum.includes(`${p1.batters.join(' & ')} ${p1.runs} (${p1.balls})`), `Summary: partnerships — the 1st-wicket stand ${p1 && p1.runs} (${p1 && p1.balls}) as saved`);
    ok(/Rohit Sharma c Shivam Dube b Deepak Chahar/.test(sum) && /Suryakumar Yadav b Deepak Chahar/.test(sum) && /Devon Conway lbw b Jasprit Bumrah/.test(sum), 'Summary: key moments name every wicket the way the scorecard does');
    ok(/Biggest over/.test(sum) && /Fall of wickets/.test(sum), 'Summary: fall of wickets and the biggest over');
    await page.screenshot({ path: path.join(OUT, `${mode.split(' ')[0]}-summary.png`), fullPage: true });

    await tab(page, 'insights');
    const ins = await txt(page, '#sct-p-insights');
    ok(new RegExp(`Boundaries ${fours + sixes} ${fours} fours · ${sixes} sixes`, 'i').test(ins), `Insights: ${fours + sixes} boundaries (${fours} fours, ${sixes} sixes) — counted from the deliveries`);
    ok((await page.$$('#sct-p-insights svg polyline')).length === 2 && /RR 12\.00/.test(ins) && /RR 13\.76/.test(ins), 'Insights: run-rate comparison for both innings (worm, RR 12.00 v 13.76)');
    ok(/Scoring breakdown/.test(ins) && /Batting analysis/.test(ins) && /Bowling analysis/.test(ins) && /Phases/.test(ins), 'Insights: scoring breakdown, phases, batting and bowling analysis');
    await page.screenshot({ path: path.join(OUT, `${mode.split(' ')[0]}-insights.png`), fullPage: true });

    await tab(page, 'mvp');
    const top = await txt(page, '.sct-mvp-name b'), pts = await txt(page, '.sct-mvp-pts b');
    ok(top === mvp[0] && Number(pts) === mvp[1], `MVP: ${mvp[0]} (${mvp[1]} points) — worked out independently from the record`, [top, pts]);
    ok(/2 wkts × 20 = 40/.test(await txt(page, '.sct-calc')) && /economy 11\.00/.test(await txt(page, '.sct-why')), 'MVP: the calculation and the figures behind it are shown');
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
    ok(/CSK need 22 runs off 9 balls/.test(before) && /15\/1/.test(before) && /Batting/.test(before), 'mid-chase: "CSK need 22 runs off 9 balls", 15/1, the innings marked Batting');
    ok(await shown(page, '#sct-tab-commentary .sct-live'), 'a live match shows the live dot on Commentary');
    await fire(page, fx.final); await page.waitForTimeout(500);
    const after = await txt(page, '#sct-p-summary');
    ok(/CSK WON BY 9 WICKETS/i.test(after) && /39\/1/.test(after) && !/need 22/.test(after), 'the next update redraws Summary: 39/1 and the result');
    ok(!(await shown(page, '#sct-tab-commentary .sct-live')), '…and the live dot goes once there is a result');
    await tab(page, 'commentary');
    const n1 = await page.$$eval('#commentary-page-body [data-ball]', (e) => e.length).catch(() => 0);
    await fire(page, fx.live); await page.waitForTimeout(400); await fire(page, fx.final); await page.waitForTimeout(500);
    const n2 = await page.$$eval('#commentary-page-body [data-ball]', (e) => e.length).catch(() => 0);
    ok(n1 > 0 && n2 === n1, 'Commentary stays current inline while updates arrive', [n1, n2]);
    ok(errors.length === 0, 'no page errors', errors);
    await ctx.close();
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
    for (const id of ['scorecard', 'info', 'squads', 'commentary', 'summary', 'insights', 'mvp']) {
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
