// score-tournament.html — the Player Highlights modal (leaderboard video icon).
//
// Server: the compile's clip selection (selectTournamentHighlightClips, taken
// out of server.js by name) — every category, and one match only.
//
// Page: the REAL page through Playwright, tournament API stubbed with a
// six-match fixture, and checks that
//   • the numbers come from the saved scorecards (runs, SR, best, 50s/100s,
//     bowling) and agree with them — with ONE clip request, none per match
//   • the form charts: a column per match, DNB / did-not-bowl, the best labelled
//   • the filters (match × type) show the right clips and the download bar
//     cuts exactly that: { category, match } reach the compile endpoint
//   • a match row downloads / shows that match; a chart bar shows its clips
//   • a clip opens the player; Escape closes the player, then the modal
//   • data from the database is text, never markup
//   • one-match player: numbers, no one-bar chart; failed clip load: retry
//   • phone width: nothing leaves the screen; light + dark screenshots
//
// Run:  NODE_PATH=$(npm root -g) node test/player-highlights.test.js
//       PP_ASSETS=<dir with fonts/*.woff2 + posters/*.jpg> for real fonts and
//       posters in the screenshots (optional — inline SVG posters otherwise).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const ASSETS = process.env.PP_ASSETS || '';

const fails = [];
const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };

/* ---------------- server: what one compile includes ---------------- */
{
  const H = require('./cricket/server-harness');
  const api = new Function([H.grab('personName'), H.grab('playerKey'), H.grab('clipBatterKey'), H.grab('selectTournamentHighlightClips'),
    'return { selectTournamentHighlightClips };'].join('\n'))();
  const pk = 'harsh rane';
  const C = (id, matchId, eventType, o) => Object.assign({ id, matchId, eventType, strikerKey: null, bowlerKey: null, dismissedPlayerKey: null }, o);
  const clips = [
    C('s1', 'R1', 'SIX', { strikerKey: pk }), C('s2', 'R2', 'SIX', { strikerKey: pk }),
    C('f1', 'R1', 'FOUR', { strikerKey: pk }), C('f2', 'R2', 'FOUR', { strikerKey: pk }),
    C('d1', 'R2', 'WICKET', { strikerKey: pk, dismissedPlayerKey: pk }),
    C('ns', 'R2', 'WICKET', { strikerKey: pk, dismissedPlayerKey: 'other batter' }), // the non-striker was out
    C('w1', 'R1', 'WICKET', { strikerKey: 'opp', bowlerKey: pk, dismissedPlayerKey: 'opp' }),
    C('c1', 'R2', 'SIX', { strikerKey: 'opp', bowlerKey: pk }),                      // a six he conceded
    C('o1', 'R1', 'CLIP', { strikerKey: pk }), C('o2', 'R2', 'CLIP', { strikerKey: 'opp', bowlerKey: pk }),
  ];
  const ids = (cat, m) => api.selectTournamentHighlightClips(clips, pk, cat, m).map((c) => c.id).join(',');
  console.log('\n=== server: compile selection ===');
  check(ids('sixes') === 's1,s2' && ids('fours') === 'f1,f2', `sixes / fours are his own (${ids('sixes')} | ${ids('fours')})`);
  check(ids('dismissals') === 'd1', `dismissals: only when HE was out (${ids('dismissals')})`);
  check(ids('wickets') === 'w1', `wickets: the ones he took (${ids('wickets')})`);
  check(ids('other') === 'o1,o2', `other: his clips that aren't a 4, 6 or wicket (${ids('other')})`);
  check(ids('all') === 's1,s2,f1,f2,d1,w1,o1,o2', `all: everything of his, never a six he conceded (${ids('all')})`);
  check(ids('sixes', 'R2') === 's2' && ids('all', 'R1') === 's1,f1,w1,o1', `one match only (${ids('sixes', 'R2')} | ${ids('all', 'R1')})`);
  check(ids('all', 'R9') === '', 'a match with nothing of his: nothing');
}

/* ---------------- page fixture ---------------- */
const T = {
  DYP: { name: 'D Y Patil SA', short: 'DYP', color: '#1e3a8a' }, PSC: { name: 'Parel Sports Club', short: 'PSC', color: '#059669' },
  NHSC: { name: 'New Hind SC', short: 'NHSC', color: '#d4a20f' }, SPY: { name: 'Shivaji Park Youngsters', short: 'SPY', color: '#dc2626' },
  MCC: { name: 'Matunga CC', short: 'MCC', color: '#7c3aed' },
};
const HR = 'HARSH RANE';
const bat = (name, runs, balls, fours, sixes, out = true) => ({ name, runs, balls, fours, sixes, out, howOut: out ? 'b X' : 'not out' });
const bowl = (name, overs, balls, runs, wickets, maidens = 0) => ({ name, overs, balls, runs, wickets, maidens });
// Harsh bats for DYP in every match (side A or B), bowls in five.
const M = (n, room, a, b, win, hrSide, hrBat, hrBowl, extra = {}) => {
  const card = { A: [bat('Opp Opener', 20, 18, 2, 0)], B: [bat('Opp Opener', 20, 18, 2, 0)] };
  const bcard = { A: [bowl('Opp Bowler', 4, 0, 30, 1)], B: [bowl('Opp Bowler', 4, 0, 30, 1)] };
  if (hrBat) card[hrSide].push(hrBat);
  if (hrBowl) bcard[hrSide].push(hrBowl);
  return Object.assign({ matchId: 'm' + n, roomId: room, matchNo: n, format: 'T20', venue: 'Oval Maidan', savedAt: `2026-09-${String(10 + n).padStart(2, '0')}T10:00:00Z`,
    teamA: T[a], teamB: T[b], scoreA: { runs: 180, wickets: 6, overs: '20.0' }, scoreB: { runs: 170, wickets: 8, overs: '20.0' },
    winningTeam: win, battingCard: card, bowlingCard: bcard }, extra);
};
const MATCHES = [
  M(1, 'ROOM-1', 'DYP', 'PSC', 'A', 'A', bat(HR, 34, 22, 3, 2), bowl(HR, 2, 0, 18, 1)),
  M(2, 'ROOM-2', 'NHSC', 'DYP', 'B', 'B', bat(HR, 116, 65, 15, 4, false), bowl(HR, 3, 0, 21, 2)),
  M(3, 'ROOM-3', 'DYP', 'SPY', 'B', 'A', bat(HR, 8, 11, 1, 0), bowl(HR, 4, 0, 35, 0)),
  M(4, 'ROOM-4', 'MCC', 'DYP', 'B', 'B', bat(HR, 52, 31, 6, 2), null),
  M(5, 'ROOM-5', 'DYP', 'PSC', 'A', 'A', bat(HR, 71, 40, 7, 3), bowl(HR, 3, 0, 24, 3), { matchTitle: 'Semi Final' }),
  M(6, 'ROOM-6', 'DYP', 'NHSC', 'B', 'A', null, bowl(HR, 4, 0, 30, 1), { matchTitle: 'Final' }),
  // someone who only played one match, and a name full of markup
  M(7, 'ROOM-7', 'SPY', 'MCC', 'A', 'A', bat('ONE MATCH MAN', 41, 25, 5, 1), null),
];
const LB = {
  topRuns: [
    { name: HR, innings: 5, runs: 281, balls: 169, fours: 32, sixes: 11, highScore: 116, average: '56.20', strikeRate: '166.27' },
    { name: 'ONE MATCH MAN', innings: 1, runs: 41, balls: 25, fours: 5, sixes: 1, highScore: 41, average: '41.00', strikeRate: '164.00' },
    { name: 'Opp Opener', innings: 7, runs: 140, balls: 126, fours: 14, sixes: 0, highScore: 20, average: '20.00', strikeRate: '111.11' },
  ],
  topWickets: [
    { name: 'Opp Bowler', innings: 7, overs: 28, runs: 210, wickets: 7, bestFigures: '1/30', economy: '7.50' },
    { name: HR, innings: 5, overs: 16, runs: 128, wickets: 7, bestFigures: '3/24', economy: '8.00' },
  ],
};
const FIXTURE = { success: true, displayName: 'Kanga League 2026', live: { roomId: null, matchId: null, matches: [] }, matches: MATCHES, pointsTable: [], leaderboards: LB };

// Harsh's clips: 8 sixes, 14 fours, 3 dismissals, 5 wickets, 2 other (one still processing).
const svgPoster = (i) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 36"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${110 + i * 9},45%,38%)"/><stop offset="1" stop-color="hsl(${140 + i * 9},40%,22%)"/></linearGradient></defs><rect width="64" height="36" fill="url(#g)"/><rect x="28" y="8" width="8" height="22" fill="#d9c49a" opacity=".55"/></svg>`);
const posters = ASSETS && fs.existsSync(path.join(ASSETS, 'posters')) ? fs.readdirSync(path.join(ASSETS, 'posters')).filter((f) => f.endsWith('.jpg')).sort() : [];
let seq = 0;
const clip = (room, eventType, over, ball, o = {}) => {
  const i = seq++;
  return Object.assign({ clipId: `c${String(i).padStart(3, '0')}aa11bb22cc33dd44ee`, matchId: room, eventType, over, ballInOver: ball, innings: 1,
    striker: HR, bowler: 'Opp Bowler', ready: true, duration: 18, playbackUrl: `https://cdn.test/clip${i}.mp4`,
    posterUrl: posters.length ? `http://test.local/posters/${posters[i % posters.length]}` : (i % 5 === 4 ? null : svgPoster(i)),
    downloadUrl: `/api/clips/c${i}/download` }, o);
};
const CATS = {
  sixes: [clip('ROOM-1', 'SIX', 2, 1), clip('ROOM-1', 'SIX', 6, 3), clip('ROOM-2', 'SIX', 9, 2), clip('ROOM-2', 'SIX', 14, 5), clip('ROOM-2', 'SIX', 16, 6),
    clip('ROOM-4', 'SIX', 11, 4), clip('ROOM-5', 'SIX', 3, 2), clip('ROOM-5', 'SIX', 15, 1, { bowler: '<img src=x onerror=window.__xss=1>' })],
  fours: [0, 1, 1.2, 2.5, 4.3, 7.5, 9.4, 10.3, 11.3, 16.3].map((o, i) => clip('ROOM-2', 'FOUR', Math.floor(o), i % 6 + 1))
    .concat([clip('ROOM-1', 'FOUR', 1, 4), clip('ROOM-4', 'FOUR', 5, 2), clip('ROOM-5', 'FOUR', 8, 6), clip('ROOM-5', 'FOUR', 12, 2)]),
  dismissals: [clip('ROOM-1', 'WICKET', 7, 2, { dismissalType: 'Caught', bowler: 'Sufiyan Shaikh' }), clip('ROOM-3', 'WICKET', 3, 4, { dismissalType: 'Bowled' }),
    clip('ROOM-4', 'WICKET', 12, 1, { dismissalType: 'LBW' })],
  wickets: [clip('ROOM-1', 'WICKET', 15, 3, { striker: 'Opp Opener', dismissedPlayer: 'Opp Opener', dismissalType: 'Bowled', bowler: HR }),
    clip('ROOM-2', 'WICKET', 17, 2, { striker: 'Tail Ender', dismissedPlayer: 'Tail Ender', dismissalType: 'Caught', bowler: HR }),
    clip('ROOM-5', 'WICKET', 13, 1, { dismissedPlayer: 'Opp Opener', dismissalType: 'Stumped', bowler: HR }),
    clip('ROOM-5', 'WICKET', 13, 4, { dismissedPlayer: 'Opp No 3', dismissalType: 'LBW', bowler: HR }),
    clip('ROOM-6', 'WICKET', 18, 5, { dismissedPlayer: 'Opp No 4', dismissalType: 'Caught', bowler: HR })],
  other: [clip('ROOM-2', 'CLIP', 19, 6, { outcome: 'Wide +4', striker: 'Tail Ender', bowler: HR }), clip('ROOM-3', 'CLIP', 5, 1, { outcome: '2 runs', ready: false, playbackUrl: null })],
};
const COUNT = Object.values(CATS).reduce((s, a) => s + a.length, 0);

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };
async function openPage(browser, { width, height, theme, hasTouch = false, clipsFail = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch, colorScheme: theme, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => { try { localStorage.setItem('scorvix-theme', t); } catch (e) {} window.confirm = () => true; }, theme);
  const page = await ctx.newPage();
  const errors = [], requests = [], compiles = [], downloads = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.host === 'fonts.googleapis.com' && ASSETS && fs.existsSync(path.join(ASSETS, 'fonts.css'))) return route.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(ASSETS, 'fonts.css')) });
    if (u.host !== 'test.local') return route.abort();
    if (u.pathname.startsWith('/api/')) requests.push(u.pathname + u.search);
    if (u.pathname === '/api/public/tournament/TOK') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(FIXTURE) });
    if (u.pathname === '/api/public/tournament/TOK/player-clips') {
      if (clipsFail) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' });
      const name = u.searchParams.get('name');
      const cats = name === HR ? CATS : { sixes: [], fours: [], dismissals: [], wickets: [], other: [] };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, name, categories: cats, totalClips: name === HR ? COUNT : 0 }) });
    }
    if (u.pathname === '/api/public/tournament/TOK/highlights/compile') {
      compiles.push(JSON.parse(req.postData() || '{}'));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, jobId: 'job' + compiles.length }) });
    }
    if (/^\/api\/highlights\/compile\/[^/]+\/status$/.test(u.pathname)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, status: 'ready', progress: 100, included: 4 }) });
    if (/^\/api\/highlights\/compile\/[^/]+\/download$/.test(u.pathname)) { downloads.push(u.searchParams.get('name')); return route.fulfill({ status: 204, body: '' }); }
    if (u.pathname.startsWith('/score/tournament/')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(ROOT, 'score-tournament.html')) });
    if (u.pathname.startsWith('/posters/') && ASSETS) return route.fulfill({ contentType: 'image/jpeg', body: fs.readFileSync(path.join(ASSETS, 'posters', path.basename(u.pathname))) });
    if (u.pathname.startsWith('/__fonts/') && ASSETS) return route.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(path.join(ASSETS, 'fonts', path.basename(u.pathname))) });
    const f = path.join(ROOT, u.pathname);
    if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://test.local/score/tournament/TOK');
  await page.waitForSelector('.tab-btn[data-tab="leaderboards"]');
  await page.click('.tab-btn[data-tab="leaderboards"]');
  await page.waitForTimeout(400);
  return { ctx, page, errors, requests, compiles, downloads };
}
const openPlayer = async (page, name) => {
  await page.click(`.clip-btn[data-player="${name}"]`);
  await page.waitForSelector('#clip-modal-backdrop.open');
  await page.waitForSelector('#pp-hl-body .pp-grid, #pp-hl-body .pp-empty', { timeout: 5000 });
  await page.waitForTimeout(450);
};
const visible = (page) => page.$$eval('#pp-grid .pp-clip', (els) => els.filter((e) => !e.hidden).map((e) => e.dataset.t + '@' + e.dataset.m));

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

  // ---- desktop, dark: numbers, charts, filters, downloads ----
  {
    const { ctx, page, errors, requests, compiles, downloads } = await openPage(browser, { width: 1440, height: 1000, theme: 'dark' });
    await openPlayer(page, HR);
    console.log('\n=== page: desktop, dark ===');
    const hero = await page.evaluate(() => ({
      name: document.querySelector('.pp-name').textContent, tags: [...document.querySelectorAll('.pp-tag')].map((t) => t.textContent.trim()),
      honours: [...document.querySelectorAll('.pp-honour')].map((t) => t.textContent.trim()),
      groups: [...document.querySelectorAll('.pp-kgroup')].map((g) => [g.querySelector('.pp-kgroup-h').firstChild.textContent, ...[...g.querySelectorAll('.pp-klead, .pp-k')].map((k) => k.querySelector('span').textContent + '=' + k.querySelector('b').textContent)].join(' | ')),
      head: document.getElementById('pp-head-k').textContent, milestones: (document.querySelector('.pp-kgroup-h em') || {}).textContent,
    }));
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    check(hero.name === HR && hero.head === 'Kanga League 2026', `hero names the player, head the tournament (${hero.name} / ${hero.head})`);
    check(hero.tags.join(',') === 'D Y Patil SA,All-rounder,6 matches', `team, role and matches (${hero.tags.join(', ')})`);
    check(hero.honours.some((h) => /Orange Cap/.test(h)) && hero.honours.some((h) => /#2 wicket-taker/.test(h)), `honours from the leaderboard (${hero.honours.join(' / ')})`);
    check(hero.groups[0] === 'Batting | Runs=281 | Strike rate=166.3 | Highest=116* | Fours=32 | Sixes=11 | Innings=5', `batting from the scorecards: ${hero.groups[0]}`);
    check(hero.milestones === '1 hundred · 2 fifties', `milestones under the runs (${hero.milestones})`);
    check(hero.groups[1] === 'Bowling | Wickets=7 | Economy=8.00 | Overs=16 | Best=3/24 | Runs given=128', `bowling from the scorecards: ${hero.groups[1]}`);
    const clipCalls = requests.filter((r) => /player-clips|\/api\/clips\/player|\/match\//.test(r));
    check(clipCalls.length === 1 && /player-clips\?name=HARSH%20RANE/.test(clipCalls[0]), `ONE clip request, none per match (${clipCalls.join(' , ')})`);

    const charts = await page.$$eval('.pp-card', (cards) => cards.map((c) => ({
      title: c.querySelector('h4').textContent,
      cols: [...c.querySelectorAll('.pp-col')].map((x) => x.querySelector('.pp-none') ? x.querySelector('.pp-none').textContent : getComputedStyle(x).getPropertyValue('--v').trim().slice(0, 5)),
      caps: [...c.querySelectorAll('.pp-cap')].map((x) => x.textContent), x: [...c.querySelectorAll('.pp-xaxis span')].map((x) => x.textContent),
      big: (c.querySelector('.pp-mix-big b') || {}).textContent,
    })));
    const runs = charts.find((c) => c.title === 'Runs in each match'), wk = charts.find((c) => c.title === 'Wickets in each match'), mix = charts.find((c) => c.title === 'How the runs came');
    check(runs && runs.cols.length === 6 && runs.cols[5] === 'DNB' && runs.caps.join() === '116*', `runs chart: 6 matches, the final DNB, only the best labelled (${runs && runs.cols.join(' ')} · ${runs && runs.caps})`);
    check(runs && runs.x[0] === 'M1PSC' && runs.x[4] === 'SFPSC' && runs.x[5] === 'FinalNHSC', `x-axis: match label + opponent (${runs && runs.x.join(' | ')})`);
    check(wk && wk.cols[3] === '—' && wk.caps.join() === '3/24', `wickets chart: did-not-bowl shown, best labelled (${wk && wk.cols.join(' ')} · ${wk && wk.caps})`);
    check(mix && mix.big === '69%', `boundary share = (32×4 + 11×6) / 281 (${mix && mix.big})`);
    const barH = await page.$$eval('.pp-cols-runs .pp-bar', (b) => b.map((x) => Math.round(x.getBoundingClientRect().height)));
    check(barH[1] > barH[4] && barH[4] > barH[3] && barH[3] > barH[0] && barH[0] > barH[2], `bar heights follow the runs (${barH.join(',')})`);
    await page.screenshot({ path: path.join(OUT, 'player-highlights-1440-dark.png') });

    // filters
    const types = await page.$$eval('[data-pp-type]', (b) => b.map((x) => x.dataset.ppType + '=' + x.querySelector('.n').textContent));
    check(types.join(' ') === `all=${COUNT} six=8 four=14 wkt=5 out=3 other=2`, `type chips with counts (${types.join(' ')})`);
    const matchChips = await page.$$eval('[data-pp-match]', (b) => b.map((x) => x.textContent.trim()));
    check(matchChips[0].startsWith('Whole tournament') && matchChips.length === 7 && /^M2 · NHSC/.test(matchChips[2]), `match chips (${matchChips.join(' | ')})`);
    check((await visible(page)).length === COUNT && (await page.textContent('#pp-dl-t')) === `Download ${COUNT} clips`, 'everything shown, bar: download all');
    await page.click('[data-pp-type="six"]');
    let v = await visible(page);
    check(v.length === 8 && v.every((x) => x.startsWith('six@')), `Sixes → only the 8 sixes (${v.length})`);
    check((await page.textContent('#pp-dl-t')) === 'Download 8 sixes' && (await page.textContent('#pp-dl-s')).startsWith('Whole tournament'), 'bar follows: 8 sixes, whole tournament');
    await page.click('[data-pp-match="ROOM-2"]');
    v = await visible(page);
    check(v.length === 3 && v.every((x) => x === 'six@ROOM-2'), `+ M2 → M2's 3 sixes (${v.join(',')})`);
    check((await page.textContent('#pp-dl-s')).startsWith('M2 vs NHSC'), `bar scope: ${await page.textContent('#pp-dl-s')}`);
    check(await page.$eval('[data-pp-type="out"]', (b) => b.classList.contains('zero') && b.querySelector('.n').textContent === '0'), 'a type with none in this match shows 0, dimmed');
    await page.click('#pp-dl-btn');
    await page.waitForTimeout(600);
    check(JSON.stringify(compiles[0]) === JSON.stringify({ name: HR, category: 'sixes', match: 'ROOM-2' }), `bar download → ${JSON.stringify(compiles[0])}`);
    check(downloads[0] === 'HARSH_RANE_M2_vs_NHSC_Sixes', `file name: ${downloads[0]}`);
    await page.click('[data-pp-match="ROOM-3"]'); // no sixes there → type widens to all
    v = await visible(page);
    check(v.length === 2 && (await page.$eval('[data-pp-type="all"]', (b) => b.classList.contains('on'))), `M3 has no sixes → shows all of M3 (${v.join(',')})`);
    await page.click('[data-pp-type="out"]'); // M3 + Dismissals → M3 has one (Bowled)
    v = await visible(page);
    check(v.join() === 'out@ROOM-3', `M3 + Dismissals → its one dismissal (${v.join(',')})`);
    await page.click('[data-pp-match="ROOM-2"]'); // M2 has no dismissal → the match wins, type widens to all
    v = await visible(page);
    check(v.length === 15 && (await page.$eval('[data-pp-type="all"]', (b) => b.classList.contains('on'))), `M2 (not out) → all 15 of M2 (${v.length})`);
    await page.click('[data-pp-match="all"]');
    await page.click('[data-pp-type="all"]');
    await page.click('#pp-dl-btn');
    await page.waitForTimeout(600);
    check(JSON.stringify(compiles[1]) === JSON.stringify({ name: HR, category: 'all', match: undefined }) || JSON.stringify(compiles[1]) === JSON.stringify({ name: HR, category: 'all' }), `whole tournament, all → ${JSON.stringify(compiles[1])}`);
    check(downloads[1] === 'HARSH_RANE_Tournament_All_Highlights', `file name: ${downloads[1]}`);

    // match rows: per-match download + "show clips"
    const rows = await page.$$eval('.pp-match', (r) => r.map((x) => x.querySelector('.pp-m-txt b').textContent + ' ' + (x.querySelector('.pp-res') || {}).textContent + ' ' + [...x.querySelectorAll('.pp-line b')].map((b) => b.textContent).join('/') + ' ' + x.querySelector('.pp-m-act').textContent.trim()));
    check(rows[1] === 'vs NHSC Won 116*/2/21 15 clips' && rows[2] === 'vs SPY Lost 8/0/35 2 clips' && rows[5] === 'vs NHSC Lost 1/30 1 clip', `match rows (${rows.join(' | ')})`);
    await page.click('[data-pp-dl-match="ROOM-5"]');
    await page.waitForTimeout(600);
    check(JSON.stringify(compiles[2]) === JSON.stringify({ name: HR, category: 'all', match: 'ROOM-5' }) && downloads[2] === 'HARSH_RANE_Semi_Final_vs_PSC_All_Highlights', `match row ⬇ → ${JSON.stringify(compiles[2])} → ${downloads[2]}`);
    await page.click('.pp-cols-runs .pp-col[data-pp-col="ROOM-4"]');
    await page.waitForTimeout(700);
    v = await visible(page);
    const hlTop = await page.$eval('#pp-hl', (s) => s.getBoundingClientRect().top - document.getElementById('clip-modal-body').getBoundingClientRect().top);
    check(v.length === 3 && v.every((x) => x.endsWith('@ROOM-4')) && Math.abs(hlTop) < 40, `a chart bar shows that match's clips and scrolls to them (${v.length}, top ${Math.round(hlTop)})`);

    // tooltip
    await page.$eval('#clip-modal-body', (b) => { b.scrollTo({ top: 0, behavior: 'instant' }); });
    await page.waitForTimeout(300); // the smooth scroll to the clips has settled (a scroll hides the tooltip)
    await page.hover('.pp-cols-runs .pp-col[data-pp-col="ROOM-2"]');
    await page.waitForTimeout(250);
    const tip = await page.$eval('#pp-tip', (t) => ({ show: t.classList.contains('show'), text: [...t.children].map((c) => c.textContent).join(' / ') }));
    check(tip.show && /^116\* runs \/ 65 balls · 4s 15 · 6s 4 · SR 178\.5 \/ M2 vs NHSC · /.test(tip.text), `tooltip on hover (${tip.text})`);

    const otherSubs = await page.$$eval('#pp-grid .pp-clip[data-t="other"] .pp-meta span', (x) => x.map((e) => e.textContent));
    check(otherSubs.join(' | ') === 'Wide +4 · bowling to Tail Ender | 2 runs · off Opp Bowler', `"other" clips say what happened, from whose side (${otherSubs.join(' | ')})`);
    // safety + the player
    check(!(await page.evaluate(() => window.__xss)) && (await page.$('#pp-grid img[src="x"]')) === null, 'a bowler name with markup stays text');
    await page.click('[data-pp-match="all"]');
    await page.click('[data-pp-type="six"]');
    await page.click('#pp-grid .pp-clip:not([hidden])');
    await page.waitForSelector('#video-modal-backdrop.open');
    check((await page.textContent('#video-modal-title')) === 'HARSH RANE — Six · Over 2.1 vs PSC', `a clip opens the player (${await page.textContent('#video-modal-title')})`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    const afterEsc = await page.evaluate(() => [document.getElementById('video-modal-backdrop').classList.contains('open'), document.getElementById('clip-modal-backdrop').classList.contains('open')]);
    check(!afterEsc[0] && afterEsc[1], 'Escape closes the clip player first');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    check(!(await page.evaluate(() => document.getElementById('clip-modal-backdrop').classList.contains('open'))), 'a second Escape closes Player Highlights');
    check(errors.length === 0, `still no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await ctx.close();
  }

  // ---- light theme screenshots + the head swapping to the name on scroll ----
  {
    const { ctx, page, errors } = await openPage(browser, { width: 1280, height: 900, theme: 'light' });
    await openPlayer(page, HR);
    console.log('\n=== page: desktop, light ===');
    await page.screenshot({ path: path.join(OUT, 'player-highlights-1280-light.png') });
    await page.$eval('#clip-modal-body', (b) => { b.scrollTop = 700; });
    await page.waitForTimeout(400);
    check(await page.$eval('#pp-head', (h) => h.classList.contains('named')), 'scrolled past the hero → head shows the player\'s name');
    await page.screenshot({ path: path.join(OUT, 'player-highlights-1280-light-scrolled.png') });
    await page.click('#clip-modal-close');
    await page.waitForTimeout(350);
    check(await page.evaluate(() => document.activeElement && document.activeElement.matches('.clip-btn[data-player="HARSH RANE"]') && getComputedStyle(document.getElementById('wrap')).visibility === 'visible'),
      'closing gives focus back to the video icon, and the page is visible again');
    await page.click('.award-card[data-player="HARSH RANE"]');
    await page.waitForSelector('#clip-modal-backdrop.open');
    await page.waitForTimeout(400);
    check((await page.textContent('#clip-modal-title')) === HR && (await page.evaluate(() => getComputedStyle(document.getElementById('wrap')).visibility)) === 'hidden',
      'an award card opens the same Player Highlights; the page under it is hidden while open');
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await ctx.close();
  }

  // ---- phones ----
  for (const [w, theme] of [[390, 'dark'], [360, 'light']]) {
    const { ctx, page, errors } = await openPage(browser, { width: w, height: 800, theme, hasTouch: true });
    await openPlayer(page, HR);
    await page.mouse.move(w - 5, 795); // the tap that opened it isn't a hover
    console.log(`\n=== page: ${w}px, ${theme} ===`);
    const m = await page.evaluate(() => {
      const modal = document.getElementById('clip-modal').getBoundingClientRect();
      const body = document.getElementById('clip-modal-body');
      const outside = [...document.querySelectorAll('#clip-modal *')].filter((el) => {
        if (el.closest('.pp-chips, .pp-honours, .pp-tip') || el.matches('.pp-wm')) return false; // chip + honour rows scroll sideways; the watermark is clipped by its thumbnail
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > modal.right + 0.5 || r.left < modal.left - 0.5);
      }).map((el) => el.className || el.tagName);
      const cols = getComputedStyle(document.getElementById('pp-grid')).gridTemplateColumns.split(' ').length;
      const bar = document.getElementById('pp-dlbar').getBoundingClientRect();
      return { w: modal.width, outside: [...new Set(outside)].slice(0, 6), sw: body.scrollWidth, cw: body.clientWidth, cols, barBottom: Math.round(bar.bottom), vh: innerHeight };
    });
    check(m.w === w && m.outside.length === 0 && m.sw <= m.cw, `${w}px: full-screen sheet, nothing past its edges (${m.outside.join(', ') || 'none'}; scrollWidth ${m.sw}/${m.cw})`);
    check(m.cols === 2, `${w}px: two clips per row (${m.cols})`);
    check(m.barBottom <= m.vh && m.barBottom >= m.vh - 2, `${w}px: download bar pinned to the bottom (${m.barBottom}/${m.vh})`);
    await page.screenshot({ path: path.join(OUT, `player-highlights-${w}-${theme}.png`) });
    await page.$eval('#clip-modal-body', (b) => { b.scrollTop = document.getElementById('pp-hl').offsetTop - 10; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `player-highlights-${w}-${theme}-clips.png`) });
    check(errors.length === 0, `${w}px: no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await ctx.close();
  }

  // ---- one match, no clips; and a failed clip load ----
  {
    const { ctx, page, errors } = await openPage(browser, { width: 1280, height: 900, theme: 'dark' });
    await openPlayer(page, 'ONE MATCH MAN');
    console.log('\n=== page: one match / no clips / failed load ===');
    const r = await page.evaluate(() => ({ charts: [...document.querySelectorAll('.pp-card h4')].map((h) => h.textContent), empty: (document.querySelector('#pp-hl-body .pp-empty') || {}).textContent, bar: document.getElementById('pp-dl-t').textContent, btn: document.getElementById('pp-dl-btn').disabled, rows: document.querySelectorAll('.pp-match').length }));
    check(r.charts.join() === 'How the runs came' && r.rows === 1, `one match: numbers + scoring card, no one-bar chart (${r.charts.join(', ')})`);
    check(/No video clips for ONE MATCH MAN/.test(r.empty || '') && r.bar === 'No clips to download yet' && r.btn, `no clips: says so, download disabled (${r.bar})`);
    await page.screenshot({ path: path.join(OUT, 'player-highlights-one-match.png') });
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await ctx.close();
    const f = await openPage(browser, { width: 1280, height: 900, theme: 'dark', clipsFail: true });
    await openPlayer(f.page, HR);
    check(!!(await f.page.$('#pp-hl-body [data-pp-retry]')) && (await f.page.textContent('#pp-dl-t')) === 'Clips couldn’t load', 'a failed clip load offers Try again');
    await f.ctx.close();
  }

  await browser.close();
  console.log('');
  if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
  console.log('ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
