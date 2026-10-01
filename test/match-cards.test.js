// score-tournament.html — the Matches tab's match cards, on the REAL page.
//
// Loads the actual file through Playwright with the tournament API stubbed
// by a fixture covering every state a saved record can be in, and checks:
//   • each state renders the right badge / result / scores (nothing invented)
//   • a logo that fails to load falls back to the team's initials
//   • operator-entered colour / logo / name values can't inject markup or CSS
//   • no horizontal overflow at phone width
//   • a card is a real link: keyboard reachable, Enter navigates, focus ring
//   • hover lifts the card (pointer devices); reduced motion leaves it still
//   • light + dark screenshots for review (test/out/)
//
// Run:  NODE_PATH=$(npm root -g) node test/match-cards.test.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

const LOGO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#0a7"/><text x="20" y="25" font-size="13" text-anchor="middle" fill="#fff">PSC</text></svg>');
const FIXTURE = {
  success: true, displayName: 'Kanga League 2026',
  live: { roomId: 'ROOM-LIVE', matchId: 'm-live', matches: [{ roomId: 'ROOM-LIVE', matchId: 'm-live' }, { roomId: 'ROOM-2', matchId: 'm-live2' }] },
  matches: [
    { matchId: 'm-done', roomId: 'R-OLD', matchNo: 1, format: 'T20', venue: 'D Y Patil Cricket Stadium', savedAt: '2026-09-28T10:00:00Z',
      teamA: { name: 'DY Patil', short: 'DYP', color: '#1d4ed8', logoUrl: 'https://invalid.example/missing.png' },
      teamB: { name: 'New Hind Sports Club', short: 'NHSC', color: '#dc2626', logoUrl: '' },
      scoreA: { runs: 237, wickets: 10, overs: '50.0' }, scoreB: { runs: 241, wickets: 4, overs: '44.3' }, winningTeam: 'B' },
    { matchId: 'm-draw', matchTitle: 'Semi Final', format: 'Test', venue: 'Wankhede', savedAt: '2026-09-29T10:00:00Z',
      teamA: { name: 'Alpha', short: 'ALP', color: 'red;background:url(//evil)' }, teamB: { name: 'Beta', short: 'BET', color: 'rgb(20, 120, 60)' },
      scoreA: { runs: 300, wickets: 9, overs: '90.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' }, winningTeam: 'DRAW' },
    { matchId: 'm-tie', savedAt: '2026-09-30T08:00:00Z',
      teamA: { name: '<img src=x onerror=alert(1)>', short: '' }, teamB: { name: 'A Team With An Extremely Long Name Cricket Club Mumbai', short: '' },
      scoreA: { runs: 150, wickets: 8 }, scoreB: { runs: 150, wickets: 10 }, winningTeam: 'TIE' },
    { matchId: 'm-live', roomId: 'ROOM-LIVE', matchNo: 4, format: 'T20', venue: 'Police Gymkhana', savedAt: '2026-10-01T09:00:00Z',
      teamA: { name: 'Parel Sports Club', short: 'PSC', color: '#059669', logoUrl: LOGO }, teamB: { name: 'Young Comrade CC', short: 'YCC', color: '#7c3aed', logoUrl: 'javascript:alert(1)' },
      scoreA: { runs: 89, wickets: 7, overs: '14.2' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' }, winningTeam: null },
    { matchId: 'm-live2', roomId: 'ROOM-2', format: 'T10', venue: 'Oval', savedAt: '2026-10-01T09:30:00Z',
      teamA: { name: 'Gamma', short: 'GAM' }, teamB: { name: 'Delta', short: 'DEL' },
      scoreA: { runs: 40, wickets: 1, overs: '4.0' }, scoreB: { runs: 0, wickets: 0, overs: '0.0' }, winningTeam: null },
    { matchId: 'm-stumps', roomId: 'R-ST', format: 'Test', dayStatus: 'STUMPS', dayNumber: 2, savedAt: '2026-10-01T07:00:00Z',
      teamA: { name: 'Eps', short: 'EPS' }, teamB: { name: 'Zeta', short: 'ZET' },
      scoreA: { runs: 410, wickets: 10, overs: '120.4' }, scoreB: { runs: 55, wickets: 2, overs: '20.0' }, winningTeam: null },
  ],
  pointsTable: [], leaderboards: { topRuns: [], topWickets: [] },
};

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
async function openPage(browser, { width, height, theme, reduced = false, hasTouch = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? 'reduce' : 'no-preference', hasTouch, colorScheme: theme });
  await ctx.addInitScript((t) => { try { localStorage.setItem('scorvix-theme', t); } catch (e) {} }, theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.host !== 'test.local') return route.abort();
    if (u.pathname.startsWith('/api/public/tournament/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(FIXTURE) });
    if (u.pathname.startsWith('/score/tournament/')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(ROOT, 'score-tournament.html')) });
    if (u.pathname.startsWith('/cricket-scorecard')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>dest</title>' });
    const f = path.join(ROOT, u.pathname);
    if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://test.local/score/tournament/TOK');
  await page.waitForSelector('.mcard');
  await page.waitForTimeout(700);
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const fails = [];
  const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };

  // ---- desktop, light: content + safety ----
  {
    const { ctx, page, errors } = await openPage(browser, { width: 1280, height: 1000, theme: 'light' });
    const cards = await page.$$eval('.mcard', (els) => els.map((e) => ({
      id: e.dataset.gotoMatch || null, href: e.getAttribute('href'), featured: e.classList.contains('featured'),
      group: e.closest('.mc-group').getAttribute('aria-label'),
      status: e.querySelector('.mc-status').textContent.trim(),
      result: e.querySelector('.mc-result').textContent.trim(),
      scores: [...e.querySelectorAll('.mc-tscore')].map((s) => s.textContent.trim()),
      winner: [...e.querySelectorAll('.mc-team')].map((t) => t.classList.contains('winner') ? 'W' : t.classList.contains('loser') ? 'L' : '-').join(''),
      label: e.querySelector('.mc-label').textContent.trim(),
      style: e.getAttribute('style') || '', aria: e.getAttribute('aria-label'),
    })));
    const by = Object.fromEntries(cards.map((c) => [c.id, c]));
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    check(cards.length === 6, `6 cards, one per match (got ${cards.length}) — the live match is not duplicated`);
    check(by['m-live'].featured && by['m-live'].group === 'Live' && by['m-live'].status === 'Live', 'live match is the featured card under Live');
    check(by['m-live'].href === '/cricket-scorecard?room=ROOM-LIVE', 'live card links to the live room');
    check(by['m-live'].scores[0] === '89-714.2 ov' && by['m-live'].scores[1] === 'Yet to bat', `live scores from data, unbatted side says "Yet to bat" (${by['m-live'].scores.join(' | ')})`);
    check(by['m-live2'].group === 'In Progress' && by['m-live2'].status === 'Live', 'a second live room also carries the LIVE badge');
    check(by['m-stumps'].status === 'In Progress' && by['m-stumps'].result === 'Stumps — Day 2', 'Test at stumps says "Stumps — Day 2"');
    check(by['m-done'].group === 'Completed' && by['m-done'].winner === 'LW' && by['m-done'].result === 'NHSC won', 'completed: winner/loser marked, result from data');
    check(by['m-done'].href === '/cricket-scorecard?token=TOK&match=m-done&history=1', 'completed card links to the saved scorecard');
    check(by['m-done'].label.startsWith('Match 1'), 'match number shown when the record has one');
    check(by['m-draw'].label.startsWith('Semi Final') && by['m-draw'].result === 'Match Drawn' && by['m-draw'].scores[1] === '—', 'draw: title used, side that never batted shows —');
    check(by['m-tie'].result === 'Match Tied' && by['m-tie'].label === '', 'tie: no match number invented when the record has none');
    check(!/evil|url\(/.test(by['m-draw'].style) && /--cb:rgb\(20, 120, 60\)/.test(by['m-draw'].style), 'unsafe colour dropped, valid rgb() colour kept');
    check(await page.$('img[src^="javascript"]') === null, 'javascript: logo URL never reaches an <img>');
    check(await page.$('.mc-tname img') === null && (await page.textContent('[data-goto-match="m-tie"] .mc-tname b')).includes('<img'), 'team name is escaped text, not markup');
    const brokenFallback = await page.$eval('[data-goto-match="m-done"] .mc-team .mc-logo', (l) => l.classList.contains('no-img') && getComputedStyle(l.querySelector('.mc-ini')).display !== 'none' && l.querySelector('.mc-ini').textContent);
    check(brokenFallback === 'DYP', `broken logo URL falls back to initials (${brokenFallback})`);
    const goodLogo = await page.$eval('[data-goto-match="m-live"] .mc-logo img', (i) => ({ ok: i.complete && i.naturalWidth > 0, fit: getComputedStyle(i).objectFit }));
    check(goodLogo.ok && goodLogo.fit === 'contain', 'real logo renders with object-fit: contain');
    check(/Parel|PSC/.test(by['m-live'].aria) && /89 for 7 in 14.2 overs/.test(by['m-live'].aria) && /yet to bat/.test(by['m-live'].aria), 'screen-reader label carries teams, status and score');
    check((await page.textContent('#matches-card')).includes('No fixtures scheduled yet.'), 'upcoming: honest empty state');

    // hover lift (pointer:fine)
    const card = await page.$('[data-goto-match="m-done"]');
    // Re-hover until the pointer is really over it — a late layout shift
    // (a logo or font settling) can move the card out from under it.
    for (let i = 0; i < 3 && !(await card.evaluate((e) => e.matches(':hover'))); i++) { await card.hover(); await page.waitForTimeout(150); }
    await page.waitForTimeout(400);
    const lifted = await card.evaluate((e) => getComputedStyle(e).transform);
    const ty = lifted === 'none' ? 0 : Number(lifted.replace(/[^\d.,-]/g, '').split(',')[5]);
    check(ty <= -2.5, `hover lifts the card (${lifted})`);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(OUT, 'match-cards-desktop-light.png'), fullPage: true });

    // keyboard: Tab reaches a card, focus ring shows, Enter navigates
    await page.focus('[data-goto-match="m-done"]');
    const ring = await page.$eval('[data-goto-match="m-done"]', (e) => getComputedStyle(e).outlineStyle + ' ' + getComputedStyle(e).outlineWidth);
    check(/solid 2px/.test(ring), `keyboard focus ring visible (${ring})`);
    await Promise.all([page.waitForURL('**/cricket-scorecard**', { timeout: 3000 }).catch(() => {}), page.keyboard.press('Enter')]);
    check(page.url() === 'http://test.local/cricket-scorecard?token=TOK&match=m-done&history=1', `Enter opens the match (${page.url()})`);
    await ctx.close();
  }

  // ---- mouse click navigates with the press-down state ----
  {
    const { ctx, page } = await openPage(browser, { width: 1280, height: 900, theme: 'dark' });
    await page.screenshot({ path: path.join(OUT, 'match-cards-desktop-dark.png'), fullPage: true });
    const nav = page.waitForURL('**/cricket-scorecard?room=ROOM-LIVE', { timeout: 3000 }).then(() => true).catch(() => false);
    await page.click('[data-goto-match="m-live"]');
    check(await nav, 'click on the live card opens the live room');
    await ctx.close();
  }

  // ---- phones: no overflow, touch target size ----
  for (const [w, theme] of [[360, 'dark'], [390, 'light']]) {
    const { ctx, page } = await openPage(browser, { width: w, height: 800, theme, hasTouch: true });
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      over: [...document.querySelectorAll('.mcard *')].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).length,
      minH: Math.min(...[...document.querySelectorAll('.mcard')].map((e) => e.getBoundingClientRect().height)),
    }));
    check(m.sw <= m.cw && m.over === 0, `${w}px: no horizontal overflow (scrollWidth ${m.sw}, clientWidth ${m.cw}, ${m.over} elements past the edge)`);
    check(m.minH >= 44, `${w}px: every card is a ≥44px touch target (smallest ${Math.round(m.minH)}px)`);
    await page.screenshot({ path: path.join(OUT, `match-cards-${w}-${theme}.png`), fullPage: true });
    await ctx.close();
  }

  // ---- reduced motion: no lift ----
  {
    const { ctx, page } = await openPage(browser, { width: 1280, height: 900, theme: 'light', reduced: true });
    const card = await page.$('[data-goto-match="m-done"]');
    await card.hover(); await page.waitForTimeout(200);
    const t = await card.evaluate((e) => getComputedStyle(e).transform);
    check(t === 'none', `reduced motion: hover leaves the card still (${t})`);
    await ctx.close();
  }

  await browser.close();
  console.log('');
  console.log(fails.length ? `✗ ${fails.length} failed` : '✓ match cards: all states, safety, layout and interaction checks pass');
  process.exit(fails.length ? 1 : 0);
})();
