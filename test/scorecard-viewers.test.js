// 👁 WATCHING NOW on the match scorecard (cricket-scorecard.html): how many
// people have this match's scorecard open, live, beside Visit Website.
// The REAL server.js (booted here, in-memory MongoDB) and the real page in
// Chromium:
//   • the server counts each viewer once (one id per browser — two tabs are
//     one person), forgets one that checked out or went quiet for 50 s, keeps
//     every match's count apart, and refuses a made-up id;
//   • the page shows the count beside Visit Website, updates it as people
//     come and go, and checks out when it is closed;
//   • both themes, laptop and phone (on a phone the Visit button is hidden
//     and the count stays, compact).
//
//   node test/scorecard-viewers.test.js        (SHOTS=<dir> also saves screenshots)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { bootServer, request } = require('./server-boot.js');

const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const FIREBASE_STUB = `window.firebase = { initializeApp: function(){ return {}; }, auth: function(){ return { currentUser: null,
  onAuthStateChanged: function(cb){ setTimeout(function(){ cb(null); }, 0); return function(){}; }, signOut: function(){ return Promise.resolve(); } }; } };`;

(async () => {
  const { port, url } = await bootServer();
  const ping = (match, viewer, leave) => request(port, 'POST', `/api/scorecard-viewers/${match}?viewer=${viewer}${leave ? '&leave=1' : ''}`);

  console.log('\n=== the server: who is watching ===');
  let r = await ping('VW-M1', 'vAAAAAAAA1');
  eq('the first viewer: 1 watching, never cached', [r.status, r.json && r.json.watching, r.headers['cache-control']], [200, 1, 'no-store']);
  r = await ping('VW-M1', 'vBBBBBBBB2');
  eq('a second viewer: 2', r.json.watching, 2);
  r = await ping('VW-M1', 'vAAAAAAAA1');
  eq('the first one checking in again (or a second tab of the same browser): still 2', r.json.watching, 2);
  r = await ping('VW-M2', 'vCCCCCCCC3');
  eq('another match keeps its own count: 1', r.json.watching, 1);
  r = await ping('VW-M1', 'vAAAAAAAA1', true);
  eq('the first viewer closes the page: 1', r.json.watching, 1);
  r = await ping('VW-M1', 'vAAAAAAAA1', true);
  eq('checking out twice changes nothing', r.json.watching, 1);
  const bad = await Promise.all([ping('VW-M1', 'x'), ping('VW-M1', 'has%20space%20id%20xx'), request(port, 'POST', '/api/scorecard-viewers/VW-M1'), ping('%24%24%24', 'vDDDDDDDD4')]);
  eq('a made-up / missing id, or no match: refused, and counted nowhere', bad.map(x => x.status), [400, 400, 400, 400]);
  eq('…the count is untouched by them', (await ping('VW-M1', 'vBBBBBBBB2')).json.watching, 1);
  // a viewer not heard from for 50 s has gone (the server's own clock, moved on)
  const realNow = Date.now;
  Date.now = () => realNow() + 51000;
  r = await ping('VW-M1', 'vEEEEEEEE5');
  eq('51 s later only a viewer who just checked in is counted', r.json.watching, 1);
  r = await ping('VW-M2', 'vCCCCCCCC3');
  eq('…and the other match\'s viewer, checking in again, counts again', r.json.watching, 1);
  Date.now = realNow;

  console.log('\n=== the page: beside Visit Website, live ===');
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const ROOM = 'VW-LIVE-' + Date.now().toString(36);
  async function viewer(opts){
    const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, colorScheme: opts.theme || 'dark', deviceScaleFactor: 1 });
    await ctx.addInitScript((t) => { try { localStorage.setItem('allsportslive-scorecard-theme', t); } catch (e) {} }, opts.theme || 'dark');
    // only the test server; Firebase (sign-in, not used here) is stood in for
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if(u.hostname === '127.0.0.1') return route.continue();
      if(u.hostname === 'www.gstatic.com' && /firebase-app-compat/.test(u.pathname)) return route.fulfill({ contentType: 'application/javascript', body: FIREBASE_STUB });
      if(u.hostname === 'www.gstatic.com' && /firebasejs/.test(u.pathname)) return route.fulfill({ contentType: 'application/javascript', body: '' });
      return route.abort();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url(`/cricket-scorecard?room=${ROOM}`));
    await page.waitForFunction(() => { const p = document.getElementById('watch-pill'); return p && !p.hidden; }, null, { timeout: 10000 });
    return { ctx, page, errors };
  }
  const pill = (page) => page.evaluate(() => {
    const p = document.getElementById('watch-pill');
    const prev = p.previousElementSibling;
    return { shown: !p.hidden && getComputedStyle(p).display !== 'none', count: document.getElementById('watch-count').textContent,
      label: getComputedStyle(p.querySelector('.watch-lbl')).display !== 'none' ? p.querySelector('.watch-lbl').textContent : '',
      title: p.title, afterVisit: !!prev && prev.classList.contains('visit-btn') };
  });
  const A = await viewer({});
  let p = await pill(A.page);
  eq('one viewer: "1 watching", right after the Visit Website button', [p.shown, p.count, p.label, p.afterVisit, p.title], [true, '1', 'watching', true, '1 person is watching this scorecard right now']);
  const B = await viewer({ theme: 'light' });
  await A.page.evaluate(() => watchCheckIn());
  await A.page.waitForFunction(() => document.getElementById('watch-count').textContent === '2', null, { timeout: 5000 });
  p = await pill(A.page);
  eq('a second person opens it: the first page shows 2', [p.count, p.title], ['2', '2 people are watching this scorecard right now']);
  const B2 = await B.ctx.newPage();
  await B2.goto(url(`/cricket-scorecard?room=${ROOM}`));
  await B2.waitForFunction(() => { const p = document.getElementById('watch-pill'); return p && !p.hidden; }, null, { timeout: 10000 });
  await A.page.evaluate(() => watchCheckIn());
  await sleep(300);
  eq('the second person opens it in another tab too: still 2 (one browser, one person)', (await pill(A.page)).count, '2');
  await B2.close({ runBeforeUnload: true });
  await B.page.close({ runBeforeUnload: true });
  await sleep(400);
  await A.page.evaluate(() => watchCheckIn());
  await A.page.waitForFunction(() => document.getElementById('watch-count').textContent === '1', null, { timeout: 5000 });
  eq('they close the scorecard: the first page is back to 1 at its next check-in', (await pill(A.page)).count, '1');
  const C = await viewer({ viewport: { width: 390, height: 844 }, theme: 'light' });
  p = await pill(C.page);
  const visitShown = await C.page.evaluate(() => getComputedStyle(document.querySelector('.visit-btn')).display !== 'none');
  eq('a phone: the count shows, compact (no word), the Visit button hidden as before', [p.shown, p.count, p.label, visitShown], [true, '2', '', false]);
  const fits = await C.page.evaluate(() => { const r = document.getElementById('watch-pill').getBoundingClientRect(); return r.right <= innerWidth && r.left >= 0 && document.documentElement.scrollWidth <= innerWidth; });
  eq('…inside the screen, no sideways scroll', fits, true);
  // readable in both themes: the number against the pill's own background
  const contrast = (page) => page.evaluate(() => {
    const lum = (c) => { const m = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
    const fg = getComputedStyle(document.getElementById('watch-count')).color;
    let el = document.getElementById('watch-pill'), bg = 'rgba(0, 0, 0, 0)';
    while(el && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)){ bg = getComputedStyle(el).backgroundColor; el = el.parentElement; }
    const a = lum(fg), b = lum(bg);
    return { theme: document.documentElement.getAttribute('data-theme') || 'dark', ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10 };
  });
  const cDark = await contrast(A.page), cLight = await contrast(C.page);
  eq('the count is clearly readable in both themes (contrast ≥ 7:1)', [cDark.ratio >= 7, cLight.ratio >= 7, cLight.theme], [true, true, 'light']);
  const nonWatchErrors = [...A.errors, ...C.errors].filter(e => /watch/i.test(e));
  eq('no page error from the count', nonWatchErrors, []);

  if(process.env.SHOTS){
    fs.mkdirSync(process.env.SHOTS, { recursive: true });
    await A.page.screenshot({ path: path.join(process.env.SHOTS, 'watch-desktop-dark.png'), clip: { x: 0, y: 0, width: 1440, height: 64 } });
    await C.page.screenshot({ path: path.join(process.env.SHOTS, 'watch-phone-light.png'), clip: { x: 0, y: 0, width: 390, height: 64 } });
    const D = await viewer({ theme: 'light' });
    await D.page.screenshot({ path: path.join(process.env.SHOTS, 'watch-desktop-light.png'), clip: { x: 0, y: 0, width: 1440, height: 64 } });
    const E = await viewer({ viewport: { width: 390, height: 844 }, theme: 'dark' });
    await E.page.screenshot({ path: path.join(process.env.SHOTS, 'watch-phone-dark.png'), clip: { x: 0, y: 0, width: 390, height: 64 } });
  }
  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
