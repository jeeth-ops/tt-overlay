// 📷 Import Scorecard — the REAL page (scorecard-import.html) in Chromium,
// talking to the REAL server.js (in-memory MongoDB, stand-in Firebase), with
// photos read by the real SDK from a stand-in Messages API.
//
//   access   signed out → "Sign in"; another account → "Access restricted"
//            and no tournament data is ever requested
//   entry    the home page's Tournament Controls and the tournament page link
//            the owner (only) to the import for that tournament
//   Claude   match details (from the tournament, confirmed) → photos (add,
//            the same one twice, re-order, viewer) → read → teams proposed
//            and confirmed → the scorecard: names first + last, sums checked
//            live, a wrong figure flagged and fixed, rows added and removed →
//            commentary partial → players: the same-name player from another
//            team asked, a new player given a name of his own → the review
//            (points table, leaderboards) → saved → the six checks →
//            the database → the public scorecard page
//   typed    phone width, light theme, no reader on the server: the figures
//            typed into the empty rows, the page reloaded half-way (nothing
//            lost), saved; nothing ever wider than the screen
//   screenshots in test/out/scorecard-import-*.png
//
// Run:  NODE_PATH=$(npm root -g) node test/scorecard-import-ui.test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { startFakeAnthropic } = require('./fake-anthropic.js');
const FX = require('./scorecard-import-fixtures.js');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

const fails = [];
let passes = 0;
const check = (ok, msg) => { if (ok) passes++; else fails.push(msg); console.log(`  ${ok ? '✓' : '✗'} ${msg}`); };
const section = (t) => console.log('\n' + t);

const FAKE_FIREBASE = `(function(){
  if (window.firebase) return;
  var u = window.__fakeUser || null;
  var cur = u ? { email: u.email, uid: u.uid, displayName: null, getIdToken: function(){ return Promise.resolve(u.token); } } : null;
  var authObj = {
    currentUser: cur,
    onAuthStateChanged: function(cb){ setTimeout(function(){ cb(cur); }, 0); return function(){}; },
    signInWithPopup: function(){ window.__signInClicked = true; return Promise.reject({ code: 'auth/popup-closed-by-user', message: 'closed' }); },
    signInWithRedirect: function(){ return Promise.resolve(); },
    getRedirectResult: function(){ return Promise.resolve({ user: null }); },
    signOut: function(){ return Promise.resolve(); },
    setPersistence: function(){ return Promise.resolve(); }
  };
  var auth = function(){ return authObj; };
  auth.GoogleAuthProvider = function(){ this.setCustomParameters = function(){}; this.addScope = function(){}; };
  auth.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session' } };
  var doc = { get: function(){ return Promise.resolve({ exists: false, data: function(){ return {}; } }); }, set: function(){ return Promise.resolve(); }, onSnapshot: function(){ return function(){}; } };
  window.firebase = { initializeApp: function(){ return {}; }, auth: auth, firestore: function(){ return { collection: function(){ return { doc: function(){ return doc; } }; } }; } };
})();`;
const FAKE_GSAP = `(function(){ var c = { to: function(){ return c; }, from: function(){ return c; }, fromTo: function(){ return c; }, set: function(){ return c; }, add: function(){ return c; }, play: function(){ return c; }, pause: function(){ return c; }, kill: function(){ return c; } };
  window.gsap = { to: function(){ return c; }, from: function(){ return c; }, fromTo: function(){ return c; }, set: function(){ return c; }, timeline: function(){ return c; }, registerPlugin: function(){}, utils: { toArray: function(x){ return Array.from(document.querySelectorAll(x)); } }, ticker: { add: function(){}, remove: function(){} }, matchMedia: function(){ return { add: function(){} }; } };
  window.ScrollTrigger = { create: function(){ return {}; }, refresh: function(){}, batch: function(){} }; })();`;
const USERS = { owner: { email: 'chhayajeeth@gmail.com', uid: 'u-owner', token: 'tok-owner' }, work: { email: 'workallsportslive@gmail.com', uid: 'u-work', token: 'tok-work' } };

async function newPage(browser, who, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1360, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce', hasTouch: !!opts.touch, isMobile: !!opts.touch });
    const page = await ctx.newPage();
    page.__errors = [];
    page.__requests = [];
    page.on('pageerror', (e) => page.__errors.push(String(e && e.message || e)));
    page.on('request', (r) => page.__requests.push(r.url()));
    await page.addInitScript(([u, theme]) => {
        window.__fakeUser = u;
        try { if (theme) localStorage.setItem('scorvix-theme', theme); } catch (e) {}
    }, [who ? USERS[who] : null, opts.theme || 'dark']);
    await page.route('https://www.gstatic.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_FIREBASE }));
    await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_GSAP }));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await page.route('**/socket.io/**', (r) => r.abort());
    return page;
}
const txt = async (page, sel) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `scorecard-import-${name}.png`), fullPage: true });
// clientWidth: a phone browser widens innerWidth to whatever overflows, so it cannot tell
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
async function pick(page, sel, files) {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]);
    await fc.setFiles(files);
}
const file = (name, seed) => ({ name, mimeType: 'image/png', buffer: FX.png(seed, 30, 40) });

(async () => {
    const fake = await startFakeAnthropic(async (body) => { await new Promise(r => setTimeout(r, 600)); return FX.fakeClaude(body); });
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ANTHROPIC_BASE_URL = fake.url;
    const { bootServer } = require('./merge-server-boot.js');
    const { port, c, mem } = await bootServer(FX.seed);
    const base = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
    const allErrors = [];

    // ------------------------------------------------------------------
    section('access');
    let page = await newPage(browser, null);
    await page.goto(base + '/import-scorecard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#signinBtn', { timeout: 10000 });
    check(/Sign in to continue/.test(await txt(page, '#view')), 'signed out: asked to sign in');
    await page.click('#signinBtn');
    check(await page.evaluate(() => !!window.__signInClicked), 'the button starts Google sign-in');
    allErrors.push(...page.__errors); await page.context().close();
    page = await newPage(browser, 'work');
    await page.goto(base + `/import-scorecard?owner=${FX.W}&league=${encodeURIComponent(FX.LEAGUE)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.gate .glyph.red', { timeout: 10000 });
    check(/Access restricted/.test(await txt(page, '#view')), 'workallsportslive@gmail.com: "Access restricted"');
    check(!page.__requests.some(u => /scorecard-import\/(tournaments|drafts|config)/.test(u)), '…and no tournament or import data is ever requested');
    allErrors.push(...page.__errors); await page.context().close();

    section('entry points');
    page = await newPage(browser, 'owner');
    await page.goto(base + '/score/tournament/tokM', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#matches-card .mc-import', { timeout: 15000 });
    check(await page.getAttribute('#matches-card .mc-import', 'href') === '/import-scorecard?token=tokM', 'tournament page: "Import scorecard" by the matches, for this tournament');
    allErrors.push(...page.__errors); await page.context().close();
    page = await newPage(browser, 'work');
    await page.goto(base + '/score/tournament/tokM', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#matches-card .mc-head', { timeout: 15000 });
    await page.waitForTimeout(800);
    check(!(await page.$('#matches-card .mc-import')), '…not shown to any other account');
    await page.context().close();
    page = await newPage(browser, 'owner');
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const manage = await page.waitForSelector('[data-manage-btn]', { timeout: 15000 }).catch(() => null);
    if (manage) {
        await page.evaluate(() => { const b = [...document.querySelectorAll('.tournament-card')].find(c => /MCA CUP/.test(c.textContent)); b.querySelector('[data-manage-btn]').click(); });
        await page.waitForSelector('#manage-modal.open', { timeout: 5000 });
        const href = await page.getAttribute('#manage-import-link', 'href');
        check(href === `/import-scorecard?owner=${FX.W}&league=${encodeURIComponent(FX.LEAGUE)}` && await page.isVisible('#manage-import-link'), 'home page → Tournament Controls → "Import scorecard from photos" for that tournament');
    } else check(false, 'home page shows the owner\'s Manage button');
    allErrors.push(...page.__errors); await page.context().close();

    // ------------------------------------------------------------------
    section('the Claude flow (desktop, dark)');
    page = await newPage(browser, 'owner');
    await page.goto(base + `/import-scorecard?owner=${FX.W}&league=${encodeURIComponent(FX.LEAGUE)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tSlot .tsel h3', { timeout: 15000 });
    check(await txt(page, '#tSlot h3') === 'MCA CUP', 'the tournament from the link');
    check(await page.getAttribute('[data-fmt="Custom"]', 'aria-pressed') === 'true' && await page.inputValue('#mOvers') === '10' && await page.inputValue('#mVenue') === 'DY Patil Ground', 'format and venue start from the tournament\'s own');
    check(await page.isDisabled('#abNext') && /date/i.test(await txt(page, '#abHint')), 'cannot start without the date');
    await page.fill('#mDate', '2026-10-12');
    check(await page.isDisabled('#abNext') && /right/i.test(await txt(page, '#abHint')), '…nor without confirming the details');
    await page.check('#mConfirm');
    await page.fill('#mTitle', 'Match 2');
    check(!(await page.isChecked('#mConfirm')) === false, 'an optional field does not undo the confirmation');
    await page.fill('#mVenue', 'DY Patil Ground ');
    check(!(await page.isChecked('#mConfirm')), 'changing the venue asks for the confirmation again');
    await page.fill('#mVenue', 'DY Patil Ground');
    await page.check('#mConfirm');
    await shot(page, '01-match');
    await page.click('#abNext');
    await page.waitForSelector('#grid-scorecard-1', { timeout: 10000 });
    check(/draft=sci_/.test(page.url()), 'the import has its own address (a reload continues it)');

    await pick(page, '[data-add="scorecard"][data-inn="1"]', [file('bat.png', 1), file('bowl.png', 2)]);
    await page.waitForFunction(() => document.querySelectorAll('#grid-scorecard-1 .ph[data-id]').length === 2, null, { timeout: 15000 });
    await pick(page, '[data-add="scorecard"][data-inn="2"]', [file('inn2.png', 3)]);
    await page.waitForFunction(() => document.querySelectorAll('#grid-scorecard-2 .ph[data-id]').length === 1, null, { timeout: 15000 });
    await page.click('details.opt summary');
    await pick(page, '[data-add="commentary"][data-inn="1"]', [file('cm.png', 4)]);
    await page.waitForFunction(() => document.querySelectorAll('#grid-commentary-1 .ph[data-id]').length === 1, null, { timeout: 15000 });
    await pick(page, '[data-add="scorecard"][data-inn="2"]', [file('again.png', 3)]);
    await page.waitForFunction(() => [...document.querySelectorAll('.toast.err')].some(t => /already added/.test(t.textContent)), null, { timeout: 8000 });
    check(await page.$$eval('#grid-scorecard-2 .ph[data-id]', x => x.length) === 1, 'the same photo twice: refused, said so');
    check(await page.$$eval('#grid-scorecard-1 .ph .no', x => x.map(n => n.textContent).join()) === '1,2' && await page.$$eval('#grid-scorecard-2 .ph .no', x => x.map(n => n.textContent).join()) === '3', 'photos numbered in reading order');
    const first = await page.getAttribute('#grid-scorecard-1 .ph[data-id]', 'data-id');
    await page.click('#grid-scorecard-1 .ph:nth-child(2) [data-ph="left"]');
    await page.waitForFunction((id) => document.querySelector('#grid-scorecard-1 .ph[data-id]').dataset.id !== id, first, { timeout: 8000 });
    await page.click('#grid-scorecard-1 .ph:nth-child(2) [data-ph="left"]');
    await page.waitForFunction((id) => document.querySelector('#grid-scorecard-1 .ph[data-id]').dataset.id === id, first, { timeout: 8000 });
    check(true, 'a photo moved earlier and back');
    await page.waitForFunction(() => [...document.querySelectorAll('.ph img[data-photo-id]')].every(i => i.complete && i.naturalWidth > 0), null, { timeout: 8000 });
    check(true, 'every thumbnail loads (fetched with the sign-in)');
    await page.click('#grid-scorecard-1 .ph img');
    await page.waitForSelector('#lb.open');
    const t1 = await txt(page, '#lbTitle');
    await page.keyboard.press('ArrowRight');
    check(/Photo 1/.test(t1) && /Photo 2/.test(await txt(page, '#lbTitle')), 'the photo viewer, with ← →');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    check(/Read with Claude/.test(await txt(page, '#readerBox')), 'reading with Claude offered (the server has a key)');
    await shot(page, '02-photos');
    await page.click('[data-read="claude"]');
    await page.waitForSelector('.reading', { timeout: 5000 });
    check(/Claude is reading/.test(await txt(page, '.reading')), 'reading: the photos being scanned');
    await shot(page, '03-reading');
    await page.waitForSelector('#teamCards .tcard[data-side] [data-confirm]', { timeout: 30000 });

    check(/“DY Patil SA”/.test(await txt(page, '.tcard[data-side="A"]')) && /DY PATIL SA/.test(await txt(page, '.tcard[data-side="A"] h3')), 'teams: "DY Patil SA" from the photos → the tournament\'s DY PATIL SA');
    check(await page.isDisabled('#abNext'), 'cannot go on before both teams are confirmed');
    await shot(page, '04-teams');
    for (const side of ['A', 'B']) {
        await page.click(`.tcard[data-side="${side}"] [data-confirm]`);
        await page.waitForFunction((s) => { const b = document.querySelector(`.tcard[data-side="${s}"] [data-confirm]`); return b && b.classList.contains('on'); }, side, { timeout: 8000 });
    }
    check(!(await page.isDisabled('#abNext')), 'both confirmed');
    await page.click('#abNext');

    await page.waitForSelector('#batTable tbody tr[data-key]:not([data-ghost])', { timeout: 10000 });
    await page.waitForTimeout(400);
    const names = await page.$$eval('#batTable tbody tr:not([data-ghost]) input.nm', x => x.map(i => i.value));
    check(names.join() === 'Jeeth Suvarna,Harsh Rane,Suraj Patil', 'names first + last: Jeeth Suvarna, Harsh Rane');
    check(/Printed “Jeeth Kumar Suvarna”/.test(await txt(page, '#batTable tbody tr:first-child')), 'the printed full name shown under it');
    check(await page.$eval('#batTable tbody tr:nth-child(2) [data-f="balls"]', i => i.classList.contains('lc')), 'a value the reader was unsure of is highlighted');
    check(/✓ matches the total/.test(await txt(page, '#sumBat')) && /DY PATIL SA won by 25 runs/i.test(await txt(page, '#resAuto')), 'sums check out; the result from the totals');
    await shot(page, '05-scorecard');
    await page.fill('#batTable tbody tr:nth-child(2) [data-f="runs"]', '66');
    await page.waitForTimeout(350);
    check(await page.$eval('[data-path="total.runs"]', i => i.classList.contains('bad')) && /1 thing to fix/.test(await txt(page, '#scTop')), 'a wrong figure: the total is flagged at once');
    await page.fill('#batTable tbody tr:nth-child(2) [data-f="runs"]', '60');
    await page.waitForTimeout(350);
    check(!(await page.$('#innBox input.bad')) && /adds up/.test(await txt(page, '#scTop')), 'fixed: nothing flagged');
    await page.fill('#batTable tbody tr[data-ghost] input.nm', 'Extra Batter');
    await page.waitForTimeout(250);
    check(await page.$$eval('#batTable tbody tr[data-key]:not([data-ghost])', x => x.length) === 4 && await page.$$eval('#batTable tbody tr[data-ghost]', x => x.length) === 1 && await page.evaluate(() => document.activeElement && document.activeElement.value === 'Extra Batter'), 'typing in the empty row adds a batter (and keeps typing there)');
    const menus = await page.$$('#batTable tbody tr:not([data-ghost]) [data-menu]');
    await menus[menus.length - 1].click();
    await page.waitForSelector('#sheet.open');
    await page.click('#sheetBody [data-m="delete"]');
    await page.waitForTimeout(450);
    check(await page.$$eval('#batTable tbody tr[data-key]:not([data-ghost])', x => x.length) === 3, 'and the row menu deletes it');
    await page.click('#innTabs [data-inn="1"]');
    await page.waitForTimeout(250);
    check(/PAREL SPORTING CLUB/.test(await txt(page, '.inn-head')) && /85\/2/.test(await txt(page, '#innScore')), '2nd innings tab');
    check(/1st innings · 4 balls/.test(await txt(page, '#cmBox')) && /partial/.test(await txt(page, '#cmBox')), 'commentary: 4 balls, shown as partial');
    await shot(page, '06-scorecard-2nd');
    await page.click('#abNext');

    await page.waitForSelector('#plBox .pl', { timeout: 10000 });
    await page.waitForTimeout(300);
    check(await page.getAttribute('[data-filter="todo"]', 'aria-pressed') === 'true' && await page.$$eval('#plBox .pl', x => x.length) === 1, 'players: only the one that needs a decision is shown first');
    check(/played for THANE CC/.test(await txt(page, '#plBox .pl')) && /p-surajp/.test(await txt(page, '#plBox .pl')), 'Suraj Patil: a SURAJ PATIL (p-surajp) plays for THANE CC — asked, not merged');
    check(await page.isDisabled('#abNext'), 'cannot go on until decided');
    await shot(page, '07-players');
    await page.locator('#plBox .pl').first().locator('input[value="new"]').check({ force: true });
    await page.waitForSelector('[data-use-name]', { timeout: 8000 });
    check(/already another player's name/.test(await txt(page, '#plBox .pl')), 'a new player called "Suraj Patil": refused, the name is taken');
    await page.click('[data-use-name]');
    await page.waitForFunction(() => !document.querySelector('#abNext').disabled, null, { timeout: 8000 });
    check(true, 'given a name of his own: everyone is matched');
    await page.click('[data-filter="all"]');
    await page.waitForTimeout(200);
    const allTxt = await txt(page, '#plBox');
    check(/Jeeth Suvarna/.test(allTxt) && /ID PLAYER_A/.test(allTxt) && /ID p-harsh/.test(allTxt), 'everyone else kept his player ID (Jeeth → PLAYER_A)');
    await shot(page, '08-players-all');
    await page.click('#abNext');

    await page.waitForSelector('#finalOk', { timeout: 10000 });
    const rv = await txt(page, '#view');
    check(/DYP WON BY 25 RUNS/.test(rv) && /1 → 2/.test(rv) && /Mon, 12 Oct, 2026/.test(rv) && /photos say “12 Oct 2026”/.test(rv), 'the review: result, 1 → 2 matches, the date (and what the photos say)');
    check(await page.$$eval('table.mini tr.after', x => x.length) === 2, 'the points table before and after for both teams');
    check(await page.isDisabled('#abNext'), 'Save stays off until the final check is ticked');
    await shot(page, '09-review');
    await page.check('#finalOk');
    await page.click('#abNext');
    await page.waitForSelector('.result h2', { timeout: 20000 });
    check(await txt(page, '.result h2') === 'Match saved' && await page.$$eval('.checks li.ok', x => x.length) === 6 && !(await page.$('.checks li.bad')), 'saved: all six checks passed');
    await shot(page, '10-done');
    const matchUrl = await page.getAttribute('.result a.btn.primary', 'href');
    allErrors.push(...page.__errors);

    const rec = await c.records.findOne({ 'importSource.kind': 'scorecard' });
    check(rec && rec.battingCard.A[0].id === 'PLAYER_A' && rec.battingCard.A[2].name === 'Suraj A. Patil' && rec.matchTitle === 'Match 2' && rec.importSource.reader === 'claude', 'the database: Jeeth on PLAYER_A, the new Suraj, the title, read by Claude');
    check(await mem.collection('importedCommentary').countDocuments({}) === 1 && await c.balls.countDocuments({ matchId: rec.matchId }) === 0, 'commentary stored for display; no deliveries');

    const sp = await newPage(browser, null);
    await sp.goto(base + matchUrl, { waitUntil: 'domcontentloaded' });
    await sp.waitForFunction(() => /25 runs/i.test((document.getElementById('main-score') || {}).textContent || ''), null, { timeout: 15000 });
    check(await sp.$eval('#chip-imported', el => getComputedStyle(el).display !== 'none'), 'the scorecard page: "Scorecard import" shown, the result there');
    await sp.screenshot({ path: path.join(OUT, 'scorecard-import-11-public.png'), fullPage: true });
    allErrors.push(...sp.__errors.map(e => 'scorecard page: ' + e));
    await sp.context().close();
    await page.context().close();

    // ------------------------------------------------------------------
    section('typed in (phone, light, no reader on the server)');
    delete process.env.ANTHROPIC_API_KEY;
    page = await newPage(browser, 'owner', { viewport: { width: 390, height: 844 }, theme: 'light', touch: true });
    await page.goto(base + '/import-scorecard?token=tokM', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tSlot .tsel h3', { timeout: 15000 });
    check(await txt(page, '#tSlot h3') === 'MCA CUP', 'the tournament from its page link (?token=)');
    check(await fits(page), 'phone: the match step fits the screen');
    await page.fill('#mDate', '2026-10-13');
    await page.check('#mConfirm');
    await shot(page, 'p1-match');
    await page.click('#abNext');
    await page.waitForSelector('#readerBox [data-read]', { timeout: 10000 });
    check(!(await page.$('[data-read="claude"]')) && await page.$('[data-read="browser"]') && /switched off on the server/.test(await txt(page, '#readerBox')), 'no key on the server: read in the browser, or type');
    await pick(page, '[data-add="scorecard"][data-inn="1"]', [file('p1.png', 21)]);
    await page.waitForFunction(() => document.querySelectorAll('#grid-scorecard-1 .ph[data-id]').length === 1, null, { timeout: 15000 });
    check(await fits(page), 'phone: the photos step fits');
    await shot(page, 'p2-photos');
    await page.click('[data-read="manual"]');
    await page.waitForSelector('#teamCards .tcard[data-side] [data-choose]', { timeout: 10000 });
    for (const [side, name] of [['A', 'DY PATIL SA'], ['B', 'PAREL SPORTING CLUB']]) {
        await page.click(`.tcard[data-side="${side}"] [data-choose]`);
        await page.waitForSelector('#sheet.open .pick');
        await page.locator('#sheetBody .pick', { hasText: name }).first().click();
        await page.waitForSelector(`.tcard[data-side="${side}"] [data-confirm]:not([disabled])`, { timeout: 8000 });
        await page.click(`.tcard[data-side="${side}"] [data-confirm]`);
        await page.waitForFunction((s) => { const b = document.querySelector(`.tcard[data-side="${s}"] [data-confirm]`); return b && b.classList.contains('on'); }, side, { timeout: 8000 });
    }
    check(await fits(page), 'phone: the teams step fits');
    await shot(page, 'p3-teams');
    await page.click('#abNext');
    await page.waitForSelector('#batTable tbody tr[data-ghost]', { timeout: 10000 });
    async function typeRow(table, cells) {
        const g = `#${table} tbody tr[data-ghost]`;
        await page.fill(`${g} input.nm`, cells.name);
        const row = page.locator(`#${table} tbody tr[data-key]:not([data-ghost])`).last();
        for (const [f, v] of Object.entries(cells)) if (f !== 'name') await row.locator(`[data-f="${f}"]`).fill(String(v));
    }
    async function typeInnings(bat, bowl, extras, total) {
        for (const r of bat) await typeRow('batTable', r);
        for (const r of bowl) await typeRow('bowlTable', r);
        for (const [k, v] of Object.entries(extras)) await page.fill(`[data-path="extras.${k}"]`, String(v));
        for (const [k, v] of Object.entries(total)) await page.fill(`[data-path="total.${k}"]`, String(v));
    }
    await typeInnings(
        [{ name: 'Jeeth Suvarna', dismissal: 'c Rohit Shukla b Garv Jain', runs: 40, balls: 30, fours: 4, sixes: 1 }, { name: 'Harsh Rane', dismissal: 'not out', runs: 30, balls: 30, fours: 2, sixes: 0 }],
        [{ name: 'Garv Jain', overs: '5', maidens: 0, runs: 40, wickets: 1 }, { name: 'Rohit Shukla', overs: '5', maidens: 0, runs: 35, wickets: 0 }],
        { total: 5, wides: 5, noBalls: 0, byes: 0, legByes: 0, penalty: 0 }, { runs: 75, wickets: 1, overs: '10' });
    await page.waitForTimeout(1300);
    check(/✓ matches the total/.test(await txt(page, '#sumBat')) && /Bowlers: 10 overs ✓/.test(await txt(page, '#sumBowl')), 'typed 1st innings adds up');
    // reload half-way: everything typed is still there
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#batTable tbody tr[data-key]:not([data-ghost])', { timeout: 15000 });
    check(await page.$$eval('#batTable tbody tr:not([data-ghost]) input.nm', x => x.map(i => i.value).join()) === 'Jeeth Suvarna,Harsh Rane' && await page.inputValue('[data-path="total.runs"]') === '75', 'reloaded half-way: back on the scorecard, nothing lost');
    await page.click('#innTabs [data-inn="1"]');
    await page.waitForTimeout(250);
    await typeInnings(
        [{ name: 'Rohit Shukla', dismissal: 'b Alim Shaikh', runs: 20, balls: 25, fours: 2, sixes: 0 }, { name: 'Garv Jain', dismissal: 'not out', runs: 30, balls: 35, fours: 3, sixes: 0 }],
        [{ name: 'Alim Shaikh', overs: '5', maidens: 0, runs: 30, wickets: 1 }, { name: 'Jeeth Suvarna', overs: '5', maidens: 0, runs: 22, wickets: 0 }],
        { total: 2, wides: 2, noBalls: 0, byes: 0, legByes: 0, penalty: 0 }, { runs: 52, wickets: 1, overs: '10' });
    await page.waitForTimeout(500);
    check(/adds up/.test(await txt(page, '#scTop')) && /DY PATIL SA won by 23 runs/i.test(await txt(page, '#resAuto')), 'typed 2nd innings: adds up, DY PATIL SA won by 23 runs');
    check(await fits(page), 'phone: the scorecard editor fits (its tables scroll inside themselves)');
    await shot(page, 'p4-scorecard');
    await page.click('#abNext');
    await page.waitForSelector('#plBox .pl', { timeout: 10000 });
    await page.waitForTimeout(400);
    check(!(await page.isDisabled('#abNext')) && !/Your decision/.test(await txt(page, '.filters')), 'players: every typed name matched to its player on its own');
    check(await fits(page), 'phone: the players step fits');
    await shot(page, 'p5-players');
    await page.click('#abNext');
    await page.waitForSelector('#finalOk', { timeout: 10000 });
    check(await fits(page), 'phone: the review fits');
    await shot(page, 'p6-review');
    await page.check('#finalOk');
    await page.click('#abNext');
    await page.waitForSelector('.result h2', { timeout: 20000 });
    check(await txt(page, '.result h2') === 'Match saved' && await page.$$eval('.checks li.ok', x => x.length) === 6, 'saved, every check passed');
    await shot(page, 'p7-done');
    const typed = await c.records.findOne({ matchDate: '2026-10-13' });
    check(typed && typed.importSource.reader === 'manual' && typed.battingCard.A[0].id === 'PLAYER_A' && typed.resultText === 'DYP WON BY 23 RUNS', 'the database: typed in, Jeeth on PLAYER_A, DYP won by 23 runs');
    check(await c.records.countDocuments({ leagueKey: FX.LEAGUE }) === 3, 'the tournament has three matches');
    allErrors.push(...page.__errors);
    await page.context().close();

    section('page errors');
    check(!allErrors.length, allErrors.length ? 'no page errors: ' + allErrors.slice(0, 3).join(' | ') : 'no page errors anywhere');

    await browser.close();
    await fake.close();
    console.log(`\n${passes} passed, ${fails.length} failed`);
    if (fails.length) { console.log('\nFAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
