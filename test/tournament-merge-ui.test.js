// 🔀 Merge Tournaments — the REAL page (tournament-merge.html) in Chromium,
// talking to the REAL server.js (in-memory MongoDB, stand-in Firebase), with
// the browser's Firebase SDK replaced by a stand-in that signs in a chosen
// test account.
//
//   J  signed out → "Sign in"; another account → "Access restricted" and no
//      tournament data is ever requested; the homepage's Merge button only
//      for the two accounts
//   the full wizard as workallsportslive@gmail.com: pick the two
//      tournaments (sheet + search) → analyze → player IDs (Jeeth's two IDs,
//      PLAYER_A recommended; a similar name that must be reviewed) → review
//      → type the name → merge → real progress → "Merged" → history
//   the database afterwards: 3 matches, Jeeth on PLAYER_A everywhere, the
//      similar-named player left alone
//   phone width (light theme): nothing leaves the screen, bottom sheet;
//   keyboard: the picker opens/closes with focus kept
//   screenshots in test/out/merge-*.png
//
// Run:  NODE_PATH=$(npm root -g) node test/tournament-merge-ui.test.js
//       MERGE_FONTS=<dir with fonts.css + fonts/> for the real web fonts in
//       the screenshots (optional; Inter is used from the system otherwise)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { bootServer } = require('./merge-server-boot.js');
const F = require('./merge-fixtures.js');
const { P, USERS } = F;

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const FONTS = process.env.MERGE_FONTS || '';

const fails = [];
let passes = 0;
const check = (ok, msg) => { if (ok) passes++; else fails.push(msg); console.log(`  ${ok ? '✓' : '✗'} ${msg}`); };
const section = (t) => console.log('\n' + t);

// the browser's Firebase SDK, replaced: window.__fakeUser decides who is signed in
const FAKE_FIREBASE = `(function(){
  if (window.firebase) return;
  var u = window.__fakeUser || null;
  var cur = u ? { email: u.email, uid: u.uid, displayName: u.name || null, getIdToken: function(){ return Promise.resolve(u.token); } } : null;
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

async function newPage(browser, port, who, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, deviceScaleFactor: opts.dpr || 1, reducedMotion: 'reduce', hasTouch: !!opts.touch, isMobile: !!opts.touch });
    const page = await ctx.newPage();
    const user = who ? { email: USERS[who].email, uid: USERS[who].uid, token: 'tok-' + who } : null;
    await page.addInitScript(([u, theme]) => {
        window.__fakeUser = u;
        try { if (theme) localStorage.setItem('scorvix-theme', theme); } catch (e) {}
    }, [user, opts.theme || 'dark']);
    await page.route('https://www.gstatic.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_FIREBASE }));
    await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_GSAP }));
    await page.route('https://fonts.googleapis.com/**', (r) => {
        if (FONTS && fs.existsSync(path.join(FONTS, 'fonts.css'))) return r.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(FONTS, 'fonts.css'), 'utf8') });
        return r.fulfill({ contentType: 'text/css', body: '' });
    });
    await page.route('http://test.local/__fonts/**', (r) => {
        const f = path.join(FONTS, 'fonts', path.basename(new URL(r.request().url()).pathname));
        return fs.existsSync(f) ? r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(f) }) : r.abort();
    });
    await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
    const apiCalls = [];
    page.on('request', (rq) => { const u = rq.url(); if (u.includes('/api/tournament-merge/')) apiCalls.push(rq.method() + ' ' + u.replace(/^https?:\/\/[^/]+/, '')); });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    return { ctx, page, apiCalls, errors };
}

const W = USERS.work.uid;
async function seed(c) {
    const RS = (j, rahul) => ({ name: 'Royal Strikers', short: 'RS', teamId: 'team-rs', players: [j, rahul || P('Rahul Patil', 'p-rahul'), P('Amit Shah', 'p-amit'), P('Kunal Rao', 'p-kunal'), P('Sameer Khan', 'p-sameer')], bowlers: [j, P('Sameer Khan', 'p-sameer')] });
    const TX = () => ({ name: 'Thunder XI', short: 'TX', teamId: 'team-tx', players: [P('Vikram Singh', 'p-vikram'), P('Nikhil Jain', 'p-nikhil'), P('Arjun Mehta', 'p-arjun'), P('Dev Sharma', 'p-dev'), P('Om Prakash', 'p-om')] });
    const BH = () => ({ name: 'Blue Hawks', short: 'BH', teamId: 'team-bh', players: [P('Harsh Vora', 'p-harsh'), P('Ishan Roy', 'p-ishan'), P('Manav Das', 'p-manav'), P('Yash Pal', 'p-yash'), P('Zaid Ali', 'p-zaid')] });
    await F.addProfile(c, W, 'PLAYER_A', 'Jeeth');
    await F.addProfile(c, W, 'p-rahul-2', 'Rahul Patel');
    for (const p of [...RS(P('x', 'x')).players.slice(1), ...TX().players, ...BH().players]) await F.addProfile(c, W, p.id, p.name);
    const infoTeams = [RS(P('x', 'x')), TX(), BH()].map(t => ({ name: t.name, short: t.short, color: '#2563eb', teamId: t.teamId, logoUrl: '' }));
    await F.addLeague(c, { ownerUid: W, leagueKey: 'summer cup 2026', name: 'Summer Cup 2026', token: 'tokD', teams: infoTeams });
    await F.addLeague(c, { ownerUid: W, leagueKey: 'summer cup 2026 b', name: 'Summer Cup 2026 B', token: 'tokS', teams: infoTeams.slice(0, 2) });
    await F.addLeague(c, { ownerUid: W, leagueKey: 'monsoon league', name: 'Monsoon League', token: 'tokM' });
    await F.addMatch(c, { ownerUid: W, leagueKey: 'summer cup 2026', matchId: 'm-d1', roomId: 'room-d1', teamA: RS(P('Jeeth', 'PLAYER_A')), teamB: TX(), seed: 0, date: '2026-10-01', matchNo: 1 });
    await F.addMatch(c, { ownerUid: W, leagueKey: 'summer cup 2026', matchId: 'm-d2', roomId: 'room-d2', teamA: BH(), teamB: RS(P('Jeeth', 'PLAYER_A')), seed: 4, date: '2026-10-02', matchNo: 2 });
    await F.addMatch(c, { ownerUid: W, leagueKey: 'summer cup 2026 b', matchId: 'm-s1', roomId: 'room-s1', teamA: RS(P('Jeeth', 'PLAYER_B'), P('Rahul Patel', 'p-rahul-2')), teamB: TX(), seed: 9, date: '2026-10-03', matchNo: 1 });
    await F.addMatch(c, { ownerUid: W, leagueKey: 'monsoon league', matchId: 'm-m1', roomId: 'room-m1', teamA: TX(), teamB: BH(), seed: 7, date: '2026-08-01' });
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

(async () => {
    const { port, c, mem } = await bootServer(seed);
    const base = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

    // ---------------------------------------------------------------
    section('J: who sees what');
    {
        const { ctx, page, apiCalls, errors } = await newPage(browser, port, null);
        await page.goto(base + '/merge-tournaments');
        await page.waitForSelector('#signinBtn', { timeout: 8000 });
        check(await page.isVisible('text=Sign in to continue'), 'signed out → "Sign in to continue"');
        await page.click('#signinBtn');
        check(await page.evaluate(() => window.__signInClicked === true), 'the button starts Google sign-in');
        check(!apiCalls.length, 'no merge API call while signed out');
        check(!errors.length, 'no script errors (' + errors.join('; ') + ')');
        await ctx.close();
    }
    {
        const { ctx, page, apiCalls } = await newPage(browser, port, 'other');
        await page.goto(base + '/merge-tournaments');
        await page.waitForSelector('text=Access restricted', { timeout: 8000 });
        check(true, 'another account → "Access restricted"');
        check(apiCalls.length === 1 && /\/access$/.test(apiCalls[0]), 'it only asked who it is — no tournament data requested (' + apiCalls.join(', ') + ')');
        check(!(await page.isVisible('#historyBtn')), 'no history button');
        await page.screenshot({ path: path.join(OUT, 'merge-access-denied.png') });
        await ctx.close();
    }
    for (const [who, visible] of [['work', true], ['owner', true], ['vinit', false], ['other', false], [null, false]]) {
        const { ctx, page } = await newPage(browser, port, who);
        await page.goto(base + '/');
        await page.waitForTimeout(400);
        const shown = await page.evaluate(() => { const b = document.getElementById('merge-tournaments-btn'); return !!b && getComputedStyle(b).display !== 'none'; });
        check(shown === visible, `homepage Merge button ${visible ? 'shown' : 'hidden'} for ${who ? USERS[who].email : 'a signed-out visitor'}`);
        await ctx.close();
    }

    // ---------------------------------------------------------------
    section('The full wizard (workallsportslive@gmail.com, desktop, dark)');
    {
        const { ctx, page, errors } = await newPage(browser, port, 'work');
        await page.goto(base + '/merge-tournaments');
        await page.waitForSelector('.empty-slot', { timeout: 8000 });
        check((await page.$$('.empty-slot')).length === 2, 'step 1: two empty slots (keep / merge from)');
        check(await page.getAttribute('#stepper li[data-step="select"]', 'aria-current') === 'step', 'stepper on step 1');
        check(await page.isDisabled('#abNext'), '"Analyze merge" disabled until both are chosen');
        await page.click('.slot.keep .empty-slot');
        await page.waitForSelector('#sheet.open .pick');
        check((await page.$$('#sheet .pick')).length === 3, 'picker lists the account\'s 3 tournaments');
        await page.fill('#sheetQ', 'b');
        await page.waitForTimeout(50);
        const filtered = await page.$$eval('#sheet .pick b', (els) => els.map(e => e.textContent));
        check(filtered.length === 1 && filtered[0] === 'Summer Cup 2026 B', 'search filters the list');
        await page.fill('#sheetQ', '');
        await page.click('#sheet .pick:has(b:text-is("Summer Cup 2026"))');
        await page.waitForSelector('.slot.keep .tcard h3:text-is("Summer Cup 2026")');
        await page.waitForSelector('.slot.keep .stats dd');
        const stats = await page.$$eval('.slot.keep .stats dd', (els) => els.map(e => e.textContent));
        check(stats.join(',') === '2,3,15', 'destination card: 2 matches, 3 teams, 15 players (' + stats.join(',') + ')');
        check(await page.isVisible('.slot.keep .leaders li'), 'top of the table / leaders shown');
        await page.click('.slot.from .empty-slot');
        await page.waitForSelector('#sheet.open .pick');
        check(await page.isDisabled('#sheet .pick:has(b:text-is("Summer Cup 2026"))'), 'the destination cannot also be picked as the source');
        await page.click('#sheet .pick:has(b:text-is("Summer Cup 2026 B"))');
        await page.waitForSelector('.slot.from .tcard h3:text-is("Summer Cup 2026 B")');
        await page.waitForFunction(() => !document.getElementById('abNext').disabled);
        await page.waitForTimeout(450);
        await page.screenshot({ path: path.join(OUT, 'merge-1-select.png'), fullPage: true });
        check(true, 'screenshot merge-1-select.png');

        await page.click('#abNext');
        await page.waitForSelector('details.acc', { timeout: 8000 });
        check(await page.getAttribute('#stepper li[data-step="preview"]', 'aria-current') === 'step', 'step 2: preview');
        const kpis = await page.$$eval('.kpi .to', (els) => els.map(e => e.textContent));
        check(kpis[0] === '3', 'preview: 3 matches afterwards (' + kpis.join(',') + ')');
        const titles = await page.$$eval('details.acc summary b', (els) => els.map(e => e.textContent));
        check(['Matches', 'Teams', 'Players & IDs', 'Points table', 'Leaderboards', 'Scorecards & ball-by-ball', 'Clips & links', 'Settings', 'Conflicts & warnings'].every(t => titles.includes(t)), 'every preview section is there');
        await page.click('details.acc:has(summary b:text-is("Points table")) summary');
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(OUT, 'merge-2-preview.png'), fullPage: true });
        check(true, 'screenshot merge-2-preview.png');

        await page.click('#abNext');
        await page.waitForSelector('.pair');
        check(await page.getAttribute('#stepper li[data-step="players"]', 'aria-current') === 'step', 'step 3: players');
        const cards = await page.$$('.pair');
        check(cards.length === 2, 'two player cards (Jeeth; Rahul Patil / Rahul Patel)');
        const jeeth = page.locator('.pair:has(h4:text-is("Jeeth"))').first();
        const codes = await jeeth.locator('.pid code').allTextContents();
        check(codes.includes('PLAYER_A') && codes.includes('PLAYER_B'), 'Jeeth: both IDs shown');
        check(await jeeth.locator('input[value="dest"]').isChecked(), 'PLAYER_A (destination) pre-selected as recommended');
        check(await jeeth.locator('.choice:has(input[value="dest"]) .chip:text("Recommended")').count() === 1, '"Recommended" badge on it');
        check((await jeeth.locator('.who').first().textContent()).includes('2 matches'), 'match counts shown (destination: 2 matches)');
        const rahul = page.locator('.pair:has(h4:text-is("Rahul Patel"))').first();
        check((await rahul.getAttribute('class')).includes('need'), 'similar name → outlined, must be reviewed');
        check(!(await rahul.locator('input:checked').count()), '… with nothing pre-selected');
        check(await page.isDisabled('#abNext'), 'continue disabled until it is answered');
        await page.screenshot({ path: path.join(OUT, 'merge-3-players.png'), fullPage: true });
        check(true, 'screenshot merge-3-players.png');
        // the user may keep the other ID too — switch and back
        await jeeth.locator('.choice:has(input[value="source"])').click();
        check(await jeeth.locator('input[value="source"]').isChecked() && (await jeeth.locator('.who').nth(1).getAttribute('class')).includes('kept'), 'the source ID can be chosen instead (its card is marked kept)');
        await jeeth.locator('.choice:has(input[value="dest"])').click();
        await rahul.locator('.choice:has(input[value="different"])').click();
        check(!(await page.isDisabled('#abNext')), 'answered → continue enabled');

        await page.click('#abNext');
        await page.waitForSelector('#typed', { timeout: 8000 });
        check(await page.getAttribute('#stepper li[data-step="review"]', 'aria-current') === 'step', 'step 4: review & confirm');
        const recon = await page.locator('.list li').allTextContents();
        check(recon.some(t => /Jeeth/.test(t) && /PLAYER_A/.test(t)) && recon.some(t => /Rahul/.test(t) && /different players/i.test(t)), 'identity reconciliation summarised');
        check(await page.isDisabled('#abNext'), 'merge disabled until confirmed');
        await page.fill('#typed', 'Summer Cup 2026');
        await page.check('#understood');
        check(await page.isDisabled('#abNext'), 'a wrong name keeps it disabled');
        await page.fill('#typed', 'summer cup 2026 b');
        check(!(await page.isDisabled('#abNext')), 'exact name (any case) + checkbox → enabled');
        await page.screenshot({ path: path.join(OUT, 'merge-4-review.png'), fullPage: true });
        check(true, 'screenshot merge-4-review.png');

        await page.click('#abNext');
        await page.waitForSelector('#progBar', { timeout: 8000 });
        check(true, 'progress screen shown');
        await page.waitForSelector('.result h2', { timeout: 15000 });
        const h2 = await page.textContent('.result h2');
        check(h2 === 'Merged', 'result: "Merged"');
        const okChecks = await page.$$eval('.checks li.ok', (els) => els.length);
        const badChecks = await page.$$eval('.checks li.bad', (els) => els.length);
        check(okChecks >= 9 && badChecks === 0, `every verification check shown as passed (${okChecks})`);
        check(await page.getAttribute('.result a.btn.primary', 'href') === '/score/tournament/tokD', '"Open Summer Cup 2026" links to its public page');
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(OUT, 'merge-5-done.png'), fullPage: true });
        check(true, 'screenshot merge-5-done.png');

        // the database after the merge
        const finalD = await c.records.find({ ownerUid: W, leagueKey: 'summer cup 2026' }).toArray();
        check(finalD.length === 3, 'database: 3 matches in Summer Cup 2026');
        check(!(await c.leagues.findOne({ ownerUid: W, leagueKey: 'summer cup 2026 b' })), 'database: source removed');
        const s1 = finalD.find(r => r.matchId === 'm-s1');
        check(!JSON.stringify(s1).includes('PLAYER_B') && JSON.stringify(s1).includes('PLAYER_A'), 'database: Jeeth is PLAYER_A in the moved match');
        check(JSON.stringify(s1).includes('Rahul Patel') && JSON.stringify(s1).includes('p-rahul-2'), 'database: Rahul Patel (reviewed as different) untouched');

        await page.click('#historyBtn');
        await page.waitForSelector('#sheet.open .history-item');
        const hist = await page.textContent('#sheet .history-item');
        check(/Summer Cup 2026 B/.test(hist) && /completed/.test(hist), 'history sheet lists the merge');
        await page.screenshot({ path: path.join(OUT, 'merge-6-history.png') });
        check(/undo player changes/.test(hist), 'history: the merge offers to undo its player changes');

        // a wrong "same player" choice: undo the player changes from history
        await page.click('#sheet .history-item');
        await page.waitForSelector('#undoPlayersBox [data-act="undo-players"]');
        check(/Jeeth/.test(await page.textContent('#undoPlayersBox')), 'the result screen lists the players that were made one');
        await page.screenshot({ path: path.join(OUT, 'merge-7-undo-offer.png'), fullPage: true });
        let asked = '';
        page.once('dialog', (d) => { asked = d.message(); d.accept(); });
        await page.click('#undoPlayersBox [data-act="undo-players"]');
        await page.waitForSelector('.result .notice.green', { timeout: 8000 });
        check(/matches stay merged/.test(asked), 'asks first (the matches stay merged)');
        check(/Player changes undone/.test(await page.textContent('.result .notice.green')) && !(await page.$('#undoPlayersBox')), 'result: "Player changes undone", button gone');
        const s1b = await c.records.findOne({ matchId: 'm-s1' });
        check(s1b.leagueKey === 'summer cup 2026' && JSON.stringify(s1b).includes('PLAYER_B'), 'database: the moved match has its own player ID back, still in Summer Cup 2026');
        await page.screenshot({ path: path.join(OUT, 'merge-8-undone.png'), fullPage: true });
        check(!errors.length, 'no script errors (' + errors.join('; ') + ')');
        await ctx.close();
    }

    // ---------------------------------------------------------------
    section('Phone width, light theme, keyboard');
    {
        const { ctx, page, errors } = await newPage(browser, port, 'owner', { viewport: { width: 390, height: 844 }, dpr: 2, theme: 'light', touch: true });
        await page.goto(base + '/merge-tournaments');
        await page.waitForSelector('.empty-slot', { timeout: 8000 });
        check(await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'light', 'light theme followed (scorvix-theme)');
        check(await noOverflow(page), 'step 1 fits the phone width');
        await page.screenshot({ path: path.join(OUT, 'merge-phone-1-select.png') });
        await page.click('.slot.keep .empty-slot');
        await page.waitForSelector('#sheet.open .pick');
        await page.waitForTimeout(450);
        const box = await page.locator('#sheet').boundingBox();
        check(box && Math.round(box.y + box.height) >= 843 && box.width >= 389, 'picker is a bottom sheet on a phone');
        await page.screenshot({ path: path.join(OUT, 'merge-phone-2-sheet.png') });
        // the owner sees every creator's tournaments
        const names = await page.$$eval('#sheet .pick b', (els) => els.map(e => e.textContent));
        check(names.includes('Monsoon League') && names.includes('Summer Cup 2026'), 'the owner sees workallsportslive@gmail.com\'s tournaments too');
        await page.click('#sheet .pick:has(b:text-is("Monsoon League"))');
        await page.waitForSelector('.slot.keep .tcard h3');
        check(await noOverflow(page), 'a chosen tournament card fits too');
        await page.screenshot({ path: path.join(OUT, 'merge-phone-3-card.png'), fullPage: true });
        check(!errors.length, 'no script errors (' + errors.join('; ') + ')');
        await ctx.close();
    }
    {
        const { ctx, page } = await newPage(browser, port, 'work');
        await page.goto(base + '/merge-tournaments');
        await page.waitForSelector('.empty-slot', { timeout: 8000 });
        await page.focus('.slot.keep .empty-slot');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#sheet.open');
        const focused = await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'sheetQ', null, { timeout: 2000 }).then(() => true, () => false);
        check(focused, 'keyboard: Enter opens the picker, focus in its search');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(450);
        check(await page.evaluate(() => document.getElementById('sheet').hidden && document.activeElement.classList.contains('empty-slot')), 'Escape closes it, focus returns');
        const labelled = await page.$$eval('button', (bs) => bs.filter(b => b.offsetParent !== null).every(b => (b.getAttribute('aria-label') || b.textContent || '').trim().length > 0));
        check(labelled, 'every visible button has a name');
        await ctx.close();
    }

    // ---------------------------------------------------------------
    section('A player ID another account holds (the production failure)');
    const pickBoth = async (page, keep, from) => {
        await page.goto(base + '/merge-tournaments');
        await page.waitForSelector('.empty-slot', { timeout: 8000 });
        await page.click('.slot.keep .empty-slot');
        await page.waitForSelector('#sheet.open .pick');
        await page.click(`#sheet .pick:has(b:text-is("${keep}"))`);
        await page.waitForSelector(`.slot.keep .tcard h3:text-is("${keep}")`);
        await page.click('.slot.from .empty-slot');
        await page.waitForSelector('#sheet.open .pick');
        await page.click(`#sheet .pick:has(b:text-is("${from}"))`);
        await page.waitForSelector(`.slot.from .tcard h3:text-is("${from}")`);
        await page.waitForFunction(() => !document.getElementById('abNext').disabled);
        await page.click('#abNext');
        await page.waitForSelector('details.acc', { timeout: 8000 });
    };
    const confirmAndMerge = async (page, typed) => {
        await page.waitForSelector('#typed', { timeout: 8000 });
        await page.fill('#typed', typed);
        await page.check('#understood');
        await page.click('#abNext');
        await page.waitForSelector('#progBar', { timeout: 8000 });
    };
    const team = (name, short, id, players) => ({ name, short, teamId: id, players, bowlers: players.slice(-2) });
    const TX = () => team('Thunder XI', 'TX', 'team-tx', [P('Vikram Singh', 'p-vikram'), P('Nikhil Jain', 'p-nikhil'), P('Arjun Mehta', 'p-arjun'), P('Dev Sharma', 'p-dev'), P('Om Prakash', 'p-om')]);
    const BH = () => team('Blue Hawks', 'BH', 'team-bh', [P('Harsh Vora', 'p-harsh'), P('Ishan Roy', 'p-ishan'), P('Manav Das', 'p-manav'), P('Yash Pal', 'p-yash'), P('Zaid Ali', 'p-zaid')]);
    {
        // the destination's Jeeth carries an ID whose profile is in the
        // owner's account: keeping it stopped the merge half way (E11000)
        const FOREIGN = '8b2afad7e813';
        const RS = (j) => team('Royal Strikers', 'RS', 'team-rs', [j, P('Rahul Patil', 'p-rahul'), P('Amit Shah', 'p-amit'), P('Kunal Rao', 'p-kunal'), P('Sameer Khan', 'p-sameer')]);
        await F.addProfile(c, USERS.owner.uid, FOREIGN, 'Jeeth');
        await F.addLeague(c, { ownerUid: W, leagueKey: 'mca president cup 2026-27', name: 'MCA President Cup 2026-27', token: 'tokMcaD' });
        await F.addLeague(c, { ownerUid: W, leagueKey: 'mca president cup 2026', name: 'MCA President Cup 2026', token: 'tokMcaS' });
        await F.addMatch(c, { ownerUid: W, leagueKey: 'mca president cup 2026-27', matchId: 'm-mca-d1', roomId: 'room-mca-d1', teamA: RS(P('Jeeth', FOREIGN)), teamB: TX(), seed: 2, date: '2026-10-05', matchNo: 1 });
        await F.addMatch(c, { ownerUid: W, leagueKey: 'mca president cup 2026-27', matchId: 'm-mca-d2', roomId: 'room-mca-d2', teamA: BH(), teamB: RS(P('Jeeth', FOREIGN)), seed: 6, date: '2026-10-06', matchNo: 2 });
        await F.addMatch(c, { ownerUid: W, leagueKey: 'mca president cup 2026', matchId: 'm-mca-s1', roomId: 'room-mca-s1', teamA: RS(P('Jeeth', 'PLAYER_A')), teamB: TX(), seed: 8, date: '2026-10-07', matchNo: 1 });
        const foreignBefore = JSON.stringify(await c.players.findOne({ playerId: FOREIGN }));
        const { ctx, page, errors } = await newPage(browser, port, 'work');
        await pickBoth(page, 'MCA President Cup 2026-27', 'MCA President Cup 2026');
        await page.click('#abNext');
        await page.waitForSelector('.pair');
        const jeeth = page.locator('.pair:has(h4:text-is("Jeeth"))').first();
        const destChoice = (await jeeth.locator('.choice:has(input[value="dest"])').textContent()) || '';
        check(await jeeth.locator('input[value="dest"]').isDisabled() && destChoice.includes(FOREIGN) && /another account/.test(destChoice), `keeping ${FOREIGN} is disabled, the reason shown`);
        check(await jeeth.locator('input[value="source"]').isChecked() && await jeeth.locator('.choice:has(input[value="source"]) .chip:text("Recommended")').count() === 1, 'this account\'s PLAYER_A is pre-selected as recommended');
        await page.screenshot({ path: path.join(OUT, 'merge-other-account-id.png'), fullPage: true });
        await page.click('#abNext');
        await confirmAndMerge(page, 'MCA President Cup 2026');
        await page.waitForSelector('.result h2', { timeout: 15000 });
        check(await page.textContent('.result h2') === 'Merged', 'result: "Merged"');
        const finalD = await c.records.find({ ownerUid: W, leagueKey: 'mca president cup 2026-27' }).toArray();
        check(finalD.length === 3 && !JSON.stringify(finalD).includes(FOREIGN) && finalD.every(r => JSON.stringify(r).includes('PLAYER_A')), 'database: 3 matches, Jeeth is PLAYER_A in every one');
        check(JSON.stringify(await c.players.findOne({ playerId: FOREIGN })) === foreignBefore, 'database: the other account\'s profile untouched');
        check(!errors.length, 'no script errors (' + errors.join('; ') + ')');
        await ctx.close();
    }
    {
        // a merge failing half way: the page follows the automatic rollback
        // to its end instead of stopping on "failed" with a stale Roll back
        await F.addLeague(c, { ownerUid: W, leagueKey: 'autumn cup', name: 'Autumn Cup', token: 'tokAD' });
        await F.addLeague(c, { ownerUid: W, leagueKey: 'autumn cup b', name: 'Autumn Cup B', token: 'tokAS' });
        await F.addMatch(c, { ownerUid: W, leagueKey: 'autumn cup', matchId: 'm-au-d1', roomId: 'room-au-d1', teamA: TX(), teamB: BH(), seed: 1, date: '2026-10-08', matchNo: 1 });
        await F.addMatch(c, { ownerUid: W, leagueKey: 'autumn cup b', matchId: 'm-au-s1', roomId: 'room-au-s1', teamA: BH(), teamB: TX(), seed: 3, date: '2026-10-09', matchNo: 1 });
        const recsBefore = JSON.stringify(await c.records.find({ leagueKey: { $in: ['autumn cup', 'autumn cup b'] } }).toArray());
        const { ctx, page, errors } = await newPage(browser, port, 'work');
        await pickBoth(page, 'Autumn Cup', 'Autumn Cup B');
        await page.click('#abNext');
        // the move fails once; every write of the rollback after it is slow
        let slow = false;
        const replaceOne = c.records.replaceOne;
        c.records.replaceOne = async function (...args) { if (slow) await new Promise(r => setTimeout(r, 1500)); return replaceOne.apply(this, args); };
        mem.fail('matchRecords', 'replaceOne', { times: 1, when: () => { slow = true; return true; } });
        await confirmAndMerge(page, 'Autumn Cup B');
        const followed = await page.waitForFunction(() => /rolling back/i.test((document.getElementById('progChip') || {}).textContent || ''), null, { timeout: 8000 }).then(() => true, () => false);
        check(followed, 'while it rolls back, the progress screen says so');
        await page.waitForSelector('.result h2', { timeout: 15000 });
        c.records.replaceOne = replaceOne;
        mem.clearFaults();
        const h2 = await page.textContent('.result h2');
        check(h2 === 'Merge undone — nothing changed' && !(await page.$('[data-act="rollback"]')), 'result: "Merge undone — nothing changed", no stale Roll back button (' + h2 + ')');
        check(JSON.stringify(await c.records.find({ leagueKey: { $in: ['autumn cup', 'autumn cup b'] } }).toArray()) === recsBefore, 'database: both tournaments exactly as before');
        check(!errors.length, 'no script errors (' + errors.join('; ') + ')');
        await ctx.close();
    }

    await browser.close();
    console.log(`\n${passes} passed, ${fails.length} failed`);
    if (fails.length) { console.log('\nFAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
