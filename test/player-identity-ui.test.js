// 🧬 Player Merge & Management in the browser — the REAL /admin page (Owner
// Control Center → Tournaments) against the REAL server.js (in-memory
// MongoDB), clicked through in Chromium:
//
//   • the button: chhayajeeth@gmail.com only, and only once the server says
//     so (a refused /access keeps it hidden); everyone else: Access Denied
//   • the dashboard: player records, potential duplicates, the tournament
//     selector, the Duplicates list
//   • search with a spelling mistake; Rohit Sharma → his likely duplicates
//     (High / Review required) → tick both → compare side by side → master
//     P102 → Preview Merge: the impact counts, the career numbers before /
//     after, the leaderboards → Confirm stays off until the warnings are
//     confirmed and the master ID is typed → the stages the server reports
//     → verified → the master's numbers in the workspace
//   • History → Details → Roll back → every document as before
//   • Correct Player Name: Virat Kohlii → Virat Kohli, same Player ID
//   • phone width and the light theme: nothing wider than the screen
//
//   NODE_PATH=$(npm root -g) node test/player-identity-ui.test.js   (SHOTS=<dir> saves pictures)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { bootServer } = require('./server-boot.js');
const { idTokens, TOK, seed } = require('./player-identity-fixtures.js');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const SHOTS = process.env.SHOTS || '';
if(SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const FAKE_FIREBASE = `(function(){
  if (window.firebase) return;
  var u = window.__fakeUser || null;
  var cur = u ? { email: u.email, uid: u.uid, displayName: null, getIdToken: function(){ return Promise.resolve(u.token); } } : null;
  var authObj = { currentUser: cur, onAuthStateChanged: function(cb){ setTimeout(function(){ cb(cur); }, 0); return function(){}; },
    signInWithPopup: function(){ return Promise.reject({ code: 'x' }); }, signOut: function(){ return Promise.resolve(); }, setPersistence: function(){ return Promise.resolve(); } };
  var auth = function(){ return authObj; };
  auth.GoogleAuthProvider = function(){ this.setCustomParameters = function(){}; };
  auth.Auth = { Persistence: { LOCAL: 'local' } };
  window.firebase = { initializeApp: function(){ return {}; }, auth: auth };
})();`;

(async () => {
  const { port, mem } = await bootServer({ idTokens, users: { U1: 'chhayajeeth@gmail.com' }, seed });
  const C = (n) => mem.collection(n);
  const snap = async () => {
    const out = {};
    for(const n of ['players', 'teams', 'matchRecords', 'balls', 'clips', 'matchPanelStates', 'importedCommentary', 'playerTombstones']) out[n] = JSON.stringify((await C(n).find({}).toArray()).map(d => { const { _id, ...rest } = d; return [String(_id), rest]; }).sort((a, b) => a[0].localeCompare(b[0])));
    return out;
  };
  const original = await snap();
  const browser = await chromium.launch();
  async function open(who, opts){
    opts = opts || {};
    const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, colorScheme: opts.light ? 'light' : 'dark' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    const user = who ? { email: idTokens[who].email, uid: idTokens[who].uid, token: who } : null;
    await page.addInitScript(([u, light]) => { window.__fakeUser = u; try { if (light) localStorage.setItem('adminTheme', 'light'); } catch (e) {} }, [user, !!opts.light]);
    await page.route('https://www.gstatic.com/**', r => r.fulfill({ contentType: 'application/javascript', body: FAKE_FIREBASE }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('https://fonts.gstatic.com/**', r => r.abort());
    if(opts.denyAccess) await page.route('**/api/player-identity/access', r => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Access Denied' }) }));
    await page.goto(`http://127.0.0.1:${port}/admin`);
    if(opts.light) await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    return { ctx, page, errors };
  }
  const shot = async (page, name) => { if(SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); };
  const until = async (page, fn, arg, ms) => { try { await page.waitForFunction(fn, arg, { timeout: ms || 8000 }); return true; } catch (e) { return false; } };
  const text = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

  console.log('\n######## Who sees it ########');
  {
    const O = await open(TOK.creator);
    await until(O.page, () => /Access Denied/.test(document.body.textContent));
    eq('workallsportslive@gmail.com: the Owner Control Center itself says Access Denied; no Player Merge button', [await O.page.evaluate(() => /Access Denied/.test(document.body.textContent)), await O.page.evaluate(() => { const b = document.getElementById('pidOpenBtn'); return !!(b && !b.hidden && b.offsetParent); })], [true, false]);
    await O.ctx.close();
    const D = await open(TOK.owner, { denyAccess: true });
    await until(D.page, () => document.getElementById('app').classList.contains('ready'));
    await D.page.click('.nav-item[data-panel="cricket"]');
    await D.page.waitForTimeout(800);
    eq('the owner, but the server refuses /access: the button stays hidden', await D.page.evaluate(() => document.getElementById('pidOpenBtn').hidden), true);
    await D.ctx.close();
  }

  console.log('\n######## The owner: dashboard and search ########');
  const O = await open(TOK.owner);
  const P = O.page;
  await until(P, () => document.getElementById('app').classList.contains('ready'));
  await P.click('.nav-item[data-panel="cricket"]');
  eq('Tournaments → the 🧬 Player Merge & Management button, beside Merge Tournaments', await until(P, () => { const b = document.getElementById('pidOpenBtn'); return b && !b.hidden && b.offsetParent; }), true);
  await P.click('#pidOpenBtn');
  await until(P, () => document.querySelectorAll('#pidStats .stat-card').length === 4 && document.querySelectorAll('#pidList .pid-row').length > 0);
  await P.waitForTimeout(800);
  eq('opens inside Tournaments: heading, 4 counters, the tournament selector, the list', [await text(P, '#pidView h2'), await P.evaluate(() => [...document.querySelectorAll('#pidLeague option')].map(o => o.textContent.split(' · ')[0])), await P.evaluate(() => document.getElementById('tournExplorerView').style.display)],
    ['Player Merge & Management', ['All tournaments', 'Summer Cup', 'Winter League'], 'none']);
  eq('the counters: player records and potential duplicates', await P.evaluate(() => [...document.querySelectorAll('#pidStats .val')].map(v => Number(v.textContent))).then(v => [v[0] >= 14, v[1] >= 3]), [true, true]);
  await shot(P, '1-dashboard');
  await P.click('[data-pid-tab="dups"]');
  await P.waitForTimeout(300);
  eq('Duplicates: the Rohit Sharma group (High), Amit Patil / Amit Patel not offered', await P.evaluate(() => { const g = [...document.querySelectorAll('.pid-group')].find(x => /Rohit Sharmma/.test(x.textContent)); return [!!g, g && /High/.test(g.textContent), [...document.querySelectorAll('.pid-group')].some(x => /Amit Patil/.test(x.textContent) && /Amit Patel/.test(x.textContent))]; }), [true, true, false]);
  await P.fill('#pidQ', 'sharmma');
  await until(P, () => document.querySelector('[data-pid-tab="search"]').classList.contains('on') && document.querySelector('#pidList .pid-row .pid-nm') && /Sharmma/.test(document.querySelector('#pidList .pid-row .pid-nm').textContent));
  eq('search “sharmma” (a misspelling): Rohit Sharmma first', await text(P, '#pidList .pid-row .pid-nm'), 'Rohit Sharmma');
  await P.fill('#pidQ', 'Rohit Sharma');
  await until(P, () => document.querySelector('#pidList .pid-row .pid-nm') && document.querySelector('#pidList .pid-row .pid-nm').textContent === 'Rohit Sharma');
  await P.click('#pidList .pid-row[data-pid="P102"]');
  await until(P, () => document.querySelectorAll('.pid-cand').length >= 2);
  eq('Rohit Sharma (P102): his likely duplicates with their level — Rohit Sharmma High, R. Sharma Review required',
    await P.evaluate(() => [...document.querySelectorAll('.pid-cand')].slice(0, 2).map(c => [c.querySelector('.pid-nm').textContent.replace(/\s+/g, ' ').trim(), c.querySelector('.pid-lv').textContent])),
    [['Rohit Sharmma P219', 'High'], ['R. Sharma P347', 'Review required']]);

  console.log('\n######## Compare, choose the master, preview ########');
  await P.click('.pid-cand input[data-pick="P219"]');
  await until(P, () => document.querySelector('.pid-compare'));
  await P.click('.pid-cand input[data-pick="P347"]');
  await until(P, () => document.querySelectorAll('.pid-compare thead th').length === 4);
  eq('the comparison: three records side by side, the master P102 chosen, the runs of each', await P.evaluate(() => [
    [...document.querySelectorAll('.pid-compare thead .col-name')].map(x => x.textContent), document.querySelector('input[name="pidMaster"]:checked').value,
    [...[...document.querySelectorAll('.pid-compare tbody tr')].find(tr => tr.firstElementChild.textContent === 'Runs').children].slice(1).map(td => td.textContent.trim())]),
    [['Rohit Sharma', 'Rohit Sharmma', 'R. Sharma'], 'P102', ['102', '80', '12']]);
  await shot(P, '2-compare');
  await P.click('#pidPreview');
  await until(P, () => document.querySelector('.pid-modal .pm-impact'), null, 15000);
  const impact = await P.evaluate(() => Object.fromEntries([...document.querySelectorAll('.pm-impact div')].map(d => [d.querySelector('span').textContent, Number(d.querySelector('b').textContent)])));
  eq('the preview: teams, tournaments, matches, deliveries, clips, profiles removed', [impact.Teams, impact.Tournaments, impact.Matches, impact.Deliveries, impact['Clip records'], impact['Profiles removed']], [2, 2, 5, 2, 3, 2]);
  eq('…the career numbers after: 194 runs, 4 wickets (recalculated, shown in the After column)', await P.evaluate(() => { const rows = [...document.querySelectorAll('.pm-box table tbody tr')]; const get = (l) => rows.find(r => r.firstElementChild.textContent === l).lastElementChild.textContent; return [get('Runs'), get('Wickets'), get('Matches')]; }), ['194', '4', '5']);
  eq('…the leaderboards: Summer Cup → one Rohit Sharma, 182', await P.evaluate(() => /Summer Cup[\s\S]*#1 Rohit Sharma 182/.test(document.querySelector('.pid-modal').textContent)), true);
  eq('Confirm stays off: the warning not confirmed, the master ID not typed', await P.evaluate(() => document.getElementById('pmGo').disabled), true);
  await P.check('#pmAck');
  eq('…warning confirmed, ID not typed: still off', await P.evaluate(() => document.getElementById('pmGo').disabled), true);
  await P.fill('#pmType', 'P219');
  eq('…the wrong ID typed: still off', await P.evaluate(() => document.getElementById('pmGo').disabled), true);
  await P.fill('#pmType', 'P102');
  eq('…the master ID typed: on', await P.evaluate(() => document.getElementById('pmGo').disabled), false);
  eq('nothing written until now', (await snap()).matchRecords === original.matchRecords, true);
  await shot(P, '3-preview');

  console.log('\n######## Run it ########');
  await P.click('#pmGo');
  await until(P, () => document.querySelector('#pmResult .pid-result'), null, 20000);
  eq('every stage the server reported, done in order', await P.evaluate(() => [...document.querySelectorAll('.pid-stage')].map(s => [s.querySelector('b').textContent, s.classList.contains('done')])),
    [['scanning', true], ['backing up', true], ['migrating', true], ['recalculating', true], ['verifying', true], ['cleaning up', true]]);
  eq('…the result and the verification, all ✓', await P.evaluate(() => [document.querySelector('#pmResult .pid-result').classList.contains('ok'), document.querySelectorAll('.pid-checks .no').length, document.querySelectorAll('.pid-checks .ok').length >= 8]), [true, 0, true]);
  await shot(P, '4-done');
  await P.click('#pmClose');
  await until(P, () => document.querySelector('.pid-subject h3') && /Rohit Sharma/.test(document.querySelector('.pid-subject h3').textContent) && !document.querySelector('.modal-backdrop'));
  await P.waitForTimeout(400);
  eq('the workspace: P102, now with 5 matches; Rohit Sharmma / R. Sharma no longer in the list', [await P.evaluate(() => document.querySelector('.pid-subject .pid-id').textContent), await P.evaluate(() => /\bP219\b|\bP347\b/.test(document.getElementById('pidList').textContent))], ['P102', false]);
  eq('in the database: P219 and P347 gone, every scorecard says Rohit Sharma', [await C('players').countDocuments({ playerId: { $in: ['P219', 'P347'] } }), (await C('matchRecords').findOne({ matchId: 'm1' })).battingCard.A[0].name], [0, 'Rohit Sharma']);

  console.log('\n######## History and roll back ########');
  await P.click('[data-pid-tab="history"]');
  await until(P, () => document.querySelectorAll('.pid-hrow').length >= 1);
  eq('History: the merge, completed, with Roll back', await P.evaluate(() => { const r = document.querySelector('.pid-hrow'); return [/Rohit Sharmma, R\. Sharma → Rohit Sharma/.test(r.textContent), /Completed/.test(r.textContent), !!r.querySelector('[data-rollback]')]; }), [true, true, true]);
  await P.click('.pid-hrow [data-op]');
  await until(P, () => document.querySelector('.pid-modal .pid-checks'));
  eq('Details: the stages and the verification', await P.evaluate(() => [document.querySelectorAll('.pid-modal .pid-stage.done').length >= 6, document.querySelectorAll('.pid-modal .pid-checks .ok').length >= 8]), [true, true]);
  await shot(P, '5-history-details');
  await P.click('#opRollback');
  await until(P, () => document.getElementById('rbGo'));
  await P.click('#rbGo');
  await until(P, () => !document.getElementById('rbGo') && document.querySelector('.pid-hrow') && /Rolled back/.test(document.querySelector('.pid-hrow').textContent), null, 15000);
  eq('rolled back: every document exactly as before the merge', JSON.stringify(await snap()) === JSON.stringify(original), true);

  console.log('\n######## Correct Player Name ########');
  await P.click('[data-pid-tab="search"]');
  await P.fill('#pidQ', 'Virat');
  await until(P, () => document.querySelector('#pidList .pid-row[data-pid="V1"]'));
  await P.click('#pidList .pid-row[data-pid="V1"]');
  await until(P, () => document.querySelector('[data-pid-mode="rename"]'));
  await P.click('[data-pid-mode="rename"]');
  await P.fill('#pidRename', 'Virat Kohli');
  await P.click('#pidRenamePreview');
  await until(P, () => document.getElementById('pmGo'));
  eq('the preview: Virat Kohlii → Virat Kohli, same ID V1; nothing to type, Confirm on', await P.evaluate(() => [/Virat Kohlii/.test(document.querySelector('.pm-flow').textContent), /V1/.test(document.querySelector('.pm-pill.master').textContent), !!document.getElementById('pmType'), document.getElementById('pmGo').disabled]), [true, true, false, false]);
  await P.click('#pmGo');
  await until(P, () => document.querySelector('#pmResult .pid-result'), null, 20000);
  eq('done: the profile and the scorecard say Virat Kohli, still V1', [await P.evaluate(() => document.querySelector('#pmResult .pid-result').classList.contains('ok')), (await C('players').findOne({ playerId: 'V1' })).displayName, (await C('matchRecords').findOne({ matchId: 'm1' })).battingCard.A[1].name], [true, 'Virat Kohli', 'Virat Kohli']);
  await P.click('#pmClose');
  eq('no script errors on the page', O.errors, []);
  await O.ctx.close();

  console.log('\n######## Phone width, light theme ########');
  for(const [label, opts] of [['phone 390px (dark)', { viewport: { width: 390, height: 844 } }], ['laptop 1280px (light)', { viewport: { width: 1280, height: 800 }, light: true }]]){
    const X = await open(TOK.owner, opts);
    await until(X.page, () => document.getElementById('app').classList.contains('ready'));
    await X.page.evaluate(() => window.openPlayerIdentity({}));
    await until(X.page, () => document.querySelectorAll('#pidList .pid-row').length > 0);
    await X.page.fill('#pidQ', 'Rohit Sharma');
    await until(X.page, () => document.querySelector('#pidList .pid-row[data-pid="P102"]'));
    await X.page.click('#pidList .pid-row[data-pid="P102"]');
    await until(X.page, () => document.querySelectorAll('.pid-cand').length >= 2);
    await X.page.click('.pid-cand input[data-pick="P219"]');
    await until(X.page, () => document.querySelector('.pid-compare'));
    eq(`${label}: the page is no wider than the screen (the comparison scrolls inside its box)`, await noOverflow(X.page), true);
    await shot(X.page, '6-' + label.replace(/[^a-z0-9]+/gi, '-'));
    await X.page.click('#pidPreview');
    await until(X.page, () => document.querySelector('.pid-modal .pm-impact'), null, 15000);
    eq(`${label}: the preview fits too`, await noOverflow(X.page), true);
    await shot(X.page, '7-' + label.replace(/[^a-z0-9]+/gi, '-') + '-preview');
    eq(`${label}: no script errors`, X.errors, []);
    await X.ctx.close();
  }

  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
