// 🏠 The homepage (index.html) — the REAL page in Chromium, the tournament
// list stubbed:
//   • the product sections in order, every picture a local WebP that exists,
//     sized and lazy, nothing loaded from another site but YouTube thumbnails
//   • share + search tags: canonical, og:image, Twitter card, valid JSON-LD
//     (Organization with both contacts and the channels, WebSite)
//   • tournaments: live first, then ongoing, upcoming, completed; search,
//     city (typed differently, still one city) and dates (now / this week /
//     this month / upcoming / finished) — alone, together and with the status
//     chips; the count, Clear, and the empty state
//   • latest streams: from the tournaments' YouTube links, live first, newest,
//     no repeats, at most 6; play loads the youtube-nocookie player in place;
//     a refresh never removes a video someone is watching
//   • the WhatsApp card: both contacts (wa.me with the message typed in),
//     opened from the button and from the hero, closed by Escape / elsewhere
//   • no sideways scrolling from 320px to 1440px, the flow chain at rest
//     under reduced motion
// Plus the server half: youTubeVideoId / tournamentStreams, taken out of
// server.js by name.
//
//   NODE_PATH=$(npm root -g) node test/homepage.test.js        (SHOTS=<dir> saves pictures)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const H = require('./cricket/server-harness');

const ROOT = path.join(__dirname, '..');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
function eq(name, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ---------------- server: the latest streams of a tournament ---------------- */
{
  console.log('\n=== server: latest streams ===');
  const api = new Function([H.grab('isUpcomingRecord'), H.grab('youTubeVideoId'), H.grab('tournamentStreams'), 'return { youTubeVideoId, tournamentStreams };'].join('\n'))();
  eq('a video id from every link shape the panel accepts',
    ['https://www.youtube.com/watch?v=AbCdEfGhI_1', 'https://youtube.com/watch?feature=share&v=AbCdEfGhI-2&t=3', 'https://youtu.be/AbCdEfGhI_3?si=x', 'https://www.youtube.com/live/AbCdEfGhI_4?si=y',
      'https://youtube.com/shorts/AbCdEfGhI_5', 'https://www.youtube.com/embed/AbCdEfGhI_6', '  https://youtu.be/AbCdEfGhI_7  '].map(api.youTubeVideoId),
    ['AbCdEfGhI_1', 'AbCdEfGhI-2', 'AbCdEfGhI_3', 'AbCdEfGhI_4', 'AbCdEfGhI_5', 'AbCdEfGhI_6', 'AbCdEfGhI_7']);
  eq('anything else: no id', ['', null, 'https://vimeo.com/123', 'https://www.youtube.com/@allsportslive', 'youtube.com/watch?v=short', 'not a link'].map(api.youTubeVideoId), ['', '', '', '', '', '']);
  const T = (id, url, at, o) => Object.assign({ matchId: id, streamUrl: url, savedAt: at, teamA: { name: 'Borivali Royals', short: 'BOR' }, teamB: { name: 'Andheri Lions', short: '' }, matchNo: 4 }, o);
  const matches = [
    T('m1', 'https://youtu.be/AAAAAAAAAA1', '2026-10-01T10:00:00Z'),
    T('m2', 'https://youtu.be/AAAAAAAAAA2', '2026-10-05T10:00:00Z', { matchTitle: 'Semi Final' }),
    T('m3', 'https://youtu.be/AAAAAAAAAA3', '2026-09-20T10:00:00Z'),                 // live, older save
    T('m4', 'https://www.youtube.com/watch?v=AAAAAAAAAA2', '2026-10-06T10:00:00Z'),   // the same video again
    T('m5', '', '2026-10-07T10:00:00Z'),                                              // no link
    T('m6', 'https://youtu.be/AAAAAAAAAA6', null, { upcoming: true }),                // a fixture not started
    T('m7', 'https://youtu.be/AAAAAAAAAA7', '2026-10-03T10:00:00Z'),
  ];
  const st = api.tournamentStreams(matches, [{ matchId: 'm3', roomId: 'r3' }]);
  eq('the match being scored now first, then the newest; one per video, at most 3', st.map((s) => s.videoId), ['AAAAAAAAAA3', 'AAAAAAAAAA2', 'AAAAAAAAAA7']);
  eq('… each with its title, label, time and live flag — and nothing else', st[0], { videoId: 'AAAAAAAAAA3', title: 'BOR vs Andheri Lions', label: 'Match 4', at: '2026-09-20T10:00:00Z', live: true });
  eq('a stage name wins over the match number', st[1].label, 'Semi Final');
  eq('a fixture not started is left out, unless it is live', [api.tournamentStreams([matches[5]], []).length, api.tournamentStreams([matches[5]], [{ matchId: 'm6' }]).map((s) => s.live)], [0, [true]]);
  eq('no matches / no links: none', [api.tournamentStreams(null, null), api.tournamentStreams([matches[4]], [])], [[], []]);
}

/* ---------------- the page ---------------- */
const TT = (o) => Object.assign({ sport: 'cricket', matchCount: 12, upcomingCount: 0, updatedAt: 0, streams: [] }, o);
const S = (videoId, title, label, at, live) => ({ videoId, title, label, at, live });
// the server's order: live first, then the most recently updated
const TOURNAMENTS = [
  TT({ token: 't1', name: 'Western Suburbs Premier League', status: 'live', matchCount: 28, info: { shortName: 'WSPL', season: 'Season 3', startDate: '2026-09-01', endDate: '2026-10-31', venue: 'Shivaji Park', city: 'Mumbai', teamCount: 8, format: 'T20', overs: 20 },
    streams: [S('vidAAAAAAA1', 'BOR vs ANL', 'Match 29', '2026-10-22T09:30:00.000Z', true), S('vidAAAAAAA2', 'BAB vs MAM', 'Match 28', '2026-10-20T09:30:00.000Z', false)] }),
  TT({ token: 't6', name: 'Weekend Box Cricket Smash', status: 'live', matchCount: 5, info: null,
    streams: [S('vidAAAAAAA5', 'Strikers vs Titans', 'Match 5', '2026-10-22T08:00:00.000Z', true)] }),
  TT({ token: 't3', name: 'Pune Monsoon Bash', status: 'completed', matchCount: 15, info: { startDate: '2026-07-01', endDate: '2026-07-30', venue: 'PYC Gymkhana', city: 'Pune', teamCount: 6, format: 'T20', overs: 20 },
    streams: [S('vidAAAAAAA4', 'PSC vs DCC', 'Final', '2026-07-30T09:30:00.000Z', false), S('vidAAAAAAA2', 'dup', '', '2026-07-01T09:30:00.000Z', false)] }),
  TT({ token: 't2', name: 'Thane Corporate Cup', status: 'ongoing', matchCount: 9, info: { season: '2026', startDate: '2026-10-05', endDate: '2026-11-15', venue: 'Dadoji Konddev Stadium', city: 'Thane', teamCount: 12, format: 'T10', overs: 10 },
    streams: [S('vidAAAAAAA3', 'TCS vs INF', 'Match 9', '2026-10-19T09:30:00.000Z', false)] }),
  TT({ token: 't5', name: 'Navi Mumbai Diwali Trophy', status: 'upcoming', matchCount: 0, upcomingCount: 6, info: { startDate: '2026-11-08', endDate: '2026-11-16', venue: 'DY Patil Ground', city: 'Navi Mumbai', teamCount: 8, format: 'T20', overs: 20 } }),
  TT({ token: 't4', name: 'Kanga League 2026', status: 'completed', matchCount: 40, info: { startDate: '2026-06-01', endDate: '2026-08-30', venue: 'Azad Maidan', city: 'Mumbai', teamCount: 16, format: 'Custom', overs: 30 } }),
  TT({ token: 't7', name: 'MCA President Cup 2026 - 27', status: 'ongoing', matchCount: 21, info: { season: '2026-27', startDate: '2026-10-10', endDate: '2027-01-31', venue: 'Cross Maidan', city: ' mumbai ', teamCount: 24, format: 'Custom', overs: 25 } }),
  TT({ token: 'tf', name: 'Football Friendly', sport: 'football', status: 'live' }),
];
const FIREBASE_STUB = `window.firebase = { initializeApp(){ return {}; }, auth: Object.assign(function(){ return { currentUser: null,
  onAuthStateChanged(cb){ setTimeout(function(){ cb(null); }, 0); return function(){}; }, signOut(){ return Promise.resolve(); },
  getRedirectResult(){ return Promise.resolve({}); }, signInWithPopup(){ return Promise.reject(new Error('no')); } }; }, { GoogleAuthProvider: function(){} }),
  firestore(){ return { collection(){ return { add(){ return Promise.resolve(); } }; } }; } };`;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.ico': 'image/x-icon' };
let gsapJs = null;
try { gsapJs = fs.readFileSync(require.resolve('gsap/dist/gsap.min.js')); } catch (e) { /* the page falls back to CSS */ }

async function openHome(browser, { width = 1440, height = 900, reduced = false, list = TOURNAMENTS } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, timezoneId: 'Asia/Kolkata', reducedMotion: reduced ? 'reduce' : 'no-preference', isMobile: width < 800, hasTouch: width < 800 });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date('2026-10-22T12:00:00+05:30') });
  const errors = [], offsite = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  const state = { list };
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'site.test') {
      if (u.pathname === '/api/public/tournaments') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, tournaments: state.list }) });
      if (u.pathname === '/api/get-sports') return route.fulfill({ contentType: 'application/json', body: '[]' });
      const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
      if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
      return route.fulfill({ status: 404, body: '' });
    }
    if (u.hostname === 'www.gstatic.com' && /firebase-app-compat/.test(u.pathname)) return route.fulfill({ contentType: 'application/javascript', body: FIREBASE_STUB });
    if (u.hostname === 'www.gstatic.com') return route.fulfill({ contentType: 'application/javascript', body: '' });
    if (u.hostname === 'cdnjs.cloudflare.com' && gsapJs) return route.fulfill({ contentType: 'application/javascript', body: gsapJs });
    if (u.hostname === 'i.ytimg.com') return route.fulfill({ contentType: 'image/webp', body: fs.readFileSync(path.join(ROOT, 'assets/home/broadcast-640.webp')) });
    if (route.request().resourceType() === 'image') offsite.push(u.href);
    return route.abort();
  });
  await page.goto('http://site.test/');
  await page.waitForFunction(() => document.querySelectorAll('.tournament-card').length > 0 || document.getElementById('tournaments-empty').style.display === 'block');
  await page.addStyleTag({ content: 'html{scroll-behavior:auto !important}' });
  return { ctx, page, errors, offsite, state };
}
const cards = (page) => page.$$eval('.tournament-card h3', (h) => h.map((x) => x.textContent));
const statuses = (page) => page.$$eval('.tournament-card', (c) => c.map((x) => (x.className.match(/status-(\w+)/) || [])[1]));
async function search(page, text) { await page.fill('#tournamentSearch', text); await page.waitForTimeout(260); }

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

  console.log('\n=== the page: sections, pictures, tags ===');
  {
    const { ctx, page, errors, offsite } = await openHome(browser);
    eq('sections in order', await page.$$eval('body > section', (s) => s.map((x) => x.id)),
      ['hero-section', 'statsBar', 'how-it-flows', 'features', 'sports-multi', 'how-it-works', 'tournaments', 'streams', 'sports']);
    eq('the hero leads with what is different', [await page.textContent('.hero h1'), await page.getAttribute('.hero .cta-btn', 'href'), await page.$$eval('.hero-usps a', (a) => a.map((x) => x.getAttribute('href')))],
      ['Every Ball Live. Highlights Instantly.', '#tournaments', ['#feat-clips', '#feat-highlights', '#feat-report', '#feat-broadcast', '#feat-tournament']]);
    eq('… and every chip lands on its section', await page.$$eval('.hero-usps a', (a) => a.every((x) => !!document.querySelector(x.getAttribute('href')))), true);
    eq('seven feature rows, each with words and a picture', await page.$$eval('.feat-row', (r) => r.map((x) => x.id + ':' + (x.querySelectorAll('.feat-points li').length) + ':' + (x.querySelectorAll('.feat-media img, .feat-media video').length > 0))),
      ['feat-clips:3:true', 'feat-highlights:3:true', 'feat-report:3:true', 'feat-scoreboard:3:true', 'feat-tournament:3:true', 'feat-broadcast:3:true', 'feat-led:3:true']);
    eq('the flow: four steps, in order', await page.$$eval('.flow-step h3', (h) => h.map((x) => x.textContent)), ['Ball scored', 'Clip cut automatically', 'Highlights ready', 'PDF report at the final ball']);
    eq('three sports', await page.$$eval('.sport-tile h3', (h) => h.map((x) => x.textContent.replace(/^\W+/, ''))), ['Cricket', 'Table Tennis', 'Football']);
    const imgs = await page.$$eval('main img, section img', (list) => list.filter((i) => !i.closest('#hero-section') && !i.closest('#tournaments-grid') && !i.closest('#streamsGrid'))
      .map((i) => ({ src: i.getAttribute('src'), srcset: i.getAttribute('srcset') || '', lazy: i.getAttribute('loading'), dec: i.getAttribute('decoding'), w: i.getAttribute('width'), h: i.getAttribute('height'), alt: i.getAttribute('alt') })));
    eq('every product picture: a local WebP, lazy, async, sized, described', imgs.filter((i) => !(/^\/assets\/home\/[\w-]+\.webp$/.test(i.src) && i.lazy === 'lazy' && i.dec === 'async' && +i.w > 0 && +i.h > 0 && i.alt && i.alt.length > 10)).map((i) => i.src), []);
    eq('… all 13 of them (10 in the feature rows, 3 sport tiles)', imgs.length, 13);
    const refs = [...new Set((HTML.match(/\/assets\/home\/[\w.-]+/g) || []))];
    eq('every /assets/home file the page names exists', refs.filter((r) => !fs.existsSync(path.join(ROOT, r))), []);
    eq('nothing comes from Wikimedia any more', /wikimedia/i.test(HTML), false);
    eq('owner sport tiles use the local pictures', await page.$$eval('.sport-card-bg', (b) => b.map((x) => x.style.backgroundImage.replace(/^url\("?|"?\)$/g, ''))),
      ['/assets/home/sport-tt-720.webp', '/assets/home/sport-cricket-720.webp', '/assets/home/sport-football-720.webp']);
    eq('the reel: muted, inline, loads nothing until shown, poster first', await page.$eval('#reelVideo', (v) => [v.muted, v.hasAttribute('playsinline'), v.getAttribute('preload'), v.getAttribute('poster'), v.querySelector('source').getAttribute('src')]),
      [true, true, 'none', '/assets/home/reel-title-360.webp', '/assets/home/highlight-reel.mp4']);
    eq('the sample report downloads (never navigates)', await page.$eval('#feat-report .feat-link', (a) => [a.getAttribute('href'), a.hasAttribute('download')]), ['/assets/home/sample-match-report.pdf', true]);

    const head = await page.evaluate(() => ({
      canonical: (document.querySelector('link[rel="canonical"]') || {}).href,
      ogUrl: document.querySelector('meta[property="og:url"]').content, ogImage: document.querySelector('meta[property="og:image"]').content,
      ogW: document.querySelector('meta[property="og:image:width"]').content, ogH: document.querySelector('meta[property="og:image:height"]').content,
      tw: document.querySelector('meta[name="twitter:card"]').content, twImage: document.querySelector('meta[name="twitter:image"]').content,
      title: document.title, desc: document.querySelector('meta[name="description"]').content.length,
      ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent),
    }));
    eq('canonical + og:url: the site root', [head.canonical, head.ogUrl], ['https://allsportslivestreams.com/', 'https://allsportslivestreams.com/']);
    eq('og:image / twitter:image: absolute, 1200×630, the file exists', [head.ogImage, head.twImage, head.ogW, head.ogH, head.tw, fs.existsSync(path.join(ROOT, 'assets/home/og-image.jpg'))],
      ['https://allsportslivestreams.com/assets/home/og-image.jpg', 'https://allsportslivestreams.com/assets/home/og-image.jpg', '1200', '630', 'summary_large_image', true]);
    const ogSize = (() => { const b = fs.readFileSync(path.join(ROOT, 'assets/home/og-image.jpg')); for (let i = 2; i < b.length;) { if (b[i] !== 0xff) break; const m = b[i + 1], len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + len; } return null; })();
    eq('… and the picture really is 1200×630', ogSize, [1200, 630]);
    eq('a title and a description for search results', [/Instant Highlights/.test(head.title), head.desc > 120 && head.desc < 260], [true, true]);
    let ld = null; try { ld = JSON.parse(head.ld[0]); } catch (e) { /* stays null */ }
    const org = ld && ld['@graph'].find((n) => n['@type'] === 'Organization'), site = ld && ld['@graph'].find((n) => n['@type'] === 'WebSite');
    eq('JSON-LD: an Organization with the channels and both contacts, and the WebSite', [!!org, org && org.sameAs, org && org.contactPoint.map((c) => c.telephone), site && site.url, site && site.publisher['@id'] === org['@id']],
      [true, ['https://www.youtube.com/@allsportslive', 'https://www.instagram.com/all.sports.live'], ['+91-79001-57214', '+91-83569-93593'], 'https://allsportslivestreams.com/', true]);
    eq('sitemap.xml exists for the robots.txt line', [fs.existsSync(path.join(ROOT, 'sitemap.xml')), /<loc>https:\/\/allsportslivestreams\.com\/<\/loc>/.test(fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8'))], [true, true]);
    eq('no picture from another site (YouTube thumbnails aside)', offsite, []);
    eq('no page errors', errors, []);
    await ctx.close();
  }

  console.log('\n=== tournaments: live first, search, city, dates ===');
  {
    const { ctx, page, errors } = await openHome(browser);
    const ORDER = { live: 0, ongoing: 1, upcoming: 2, completed: 3 };
    const st = await statuses(page);
    eq('cricket only, live first, then ongoing, upcoming, completed', [st.length, st.every((s, i) => i === 0 || ORDER[s] >= ORDER[st[i - 1]])], [7, true]);
    eq('… the server\'s own order kept inside each group', await cards(page), ['Western Suburbs Premier League', 'Weekend Box Cricket Smash', 'Thane Corporate Cup', 'MCA President Cup 2026 - 27', 'Navi Mumbai Diwali Trophy', 'Pune Monsoon Bash', 'Kanga League 2026']);
    eq('no filter: no count line', (await page.textContent('#tournamentsCount')).trim(), '');
    eq('the city menu: from the tournaments, one entry per city however it was typed', await page.$$eval('#tournamentCity option', (o) => o.map((x) => x.textContent)),
      ['All cities', 'Mumbai (3)', 'Navi Mumbai (1)', 'Pune (1)', 'Thane (1)']);
    await search(page, 'pune');
    eq('search "pune": by name / city', await cards(page), ['Pune Monsoon Bash']);
    eq('… the count says so, with Clear', (await page.textContent('#tournamentsCount')).replace(/\s+/g, ' ').trim(), 'Showing 1 of 7 tournamentsClear');
    await search(page, '  SHIVAJI   park ');
    eq('search by venue, any case and spacing', await cards(page), ['Western Suburbs Premier League']);
    await search(page, 'mumbai 2026');
    eq('every word must match (name, season, city…)', await cards(page), ['MCA President Cup 2026 - 27', 'Kanga League 2026']);
    await search(page, 'zzz nothing');
    eq('nothing matches: the empty state says so and offers to clear', await page.evaluate(() => [document.getElementById('tournaments-empty').style.display, document.getElementById('tournamentsEmptyText').textContent, document.getElementById('tournamentsEmptyClear').hidden]),
      ['block', 'No tournaments match your search.', false]);
    await page.click('#tournamentsEmptyClear');
    eq('… Clear brings everything back and empties the box', [(await cards(page)).length, await page.inputValue('#tournamentSearch')], [7, '']);
    await page.selectOption('#tournamentCity', 'mumbai');
    eq('city Mumbai: three, live first', await cards(page), ['Western Suburbs Premier League', 'MCA President Cup 2026 - 27', 'Kanga League 2026']);
    await page.selectOption('#tournamentCity', '');
    const when = async (v) => { await page.selectOption('#tournamentWhen', v); return cards(page); };
    eq('happening now (22 Oct): live / ongoing, or dates around today', await when('now'), ['Western Suburbs Premier League', 'Weekend Box Cricket Smash', 'Thane Corporate Cup', 'MCA President Cup 2026 - 27']);
    eq('this week (19–25 Oct): dates overlapping it, or live without dates', await when('week'), ['Western Suburbs Premier League', 'Weekend Box Cricket Smash', 'Thane Corporate Cup', 'MCA President Cup 2026 - 27']);
    eq('this month (October)', await when('month'), ['Western Suburbs Premier League', 'Weekend Box Cricket Smash', 'Thane Corporate Cup', 'MCA President Cup 2026 - 27']);
    eq('upcoming: starts after today', await when('upcoming'), ['Navi Mumbai Diwali Trophy']);
    eq('finished', await when('past'), ['Pune Monsoon Bash', 'Kanga League 2026']);
    await page.selectOption('#tournamentCity', 'mumbai');
    eq('finished + Mumbai', await cards(page), ['Kanga League 2026']);
    await page.click('[data-tt-clear]');
    eq('Clear resets search, city and dates', [await page.inputValue('#tournamentCity'), await page.inputValue('#tournamentWhen'), (await cards(page)).length], ['', '', 7]);
    await page.click('.tournament-filter-btn[data-filter="completed"]');
    await search(page, 'kanga');
    eq('with the Completed chip: the search narrows the completed ones, the count is of them', [await cards(page), (await page.textContent('#tournamentsCount')).replace(/\s+/g, ' ').trim()], [['Kanga League 2026'], 'Showing 1 of 2 tournamentsClear']);
    await page.click('[data-tt-clear]');
    await page.click('.tournament-filter-btn[data-filter="live"]');
    eq('the Live chip: both live ones', await cards(page), ['Western Suburbs Premier League', 'Weekend Box Cricket Smash']);
    await page.click('.tournament-filter-btn[data-filter="all"]');
    eq('a single city: no city menu', await page.evaluate(() => { renderCityOptions([{ info: { city: 'Pune' } }, { info: { city: 'pune ' } }]); const h = document.getElementById('tournamentCity').hidden; renderTournaments(); return [h, document.getElementById('tournamentCity').hidden]; }), [true, false]);
    eq('no page errors', errors, []);
    await ctx.close();
  }

  console.log('\n=== latest streams ===');
  {
    const { ctx, page, errors, state } = await openHome(browser);
    const streams = () => page.$$eval('#streamsGrid .stream-card', (c) => c.map((x) => [x.querySelector('h3').textContent, !!x.querySelector('.stream-badge.live'), (x.querySelector('[data-yt]') || {}).dataset ? x.querySelector('[data-yt]') && x.querySelector('[data-yt]').dataset.yt : null]));
    eq('from the tournaments: live first, then the newest; a video once', await streams(),
      [['BOR vs ANL', true, 'vidAAAAAAA1'], ['Strikers vs Titans', true, 'vidAAAAAAA5'], ['BAB vs MAM', false, 'vidAAAAAAA2'], ['TCS vs INF', false, 'vidAAAAAAA3'], ['PSC vs DCC', false, 'vidAAAAAAA4']]);
    eq('each card: the tournament, the thumbnail, a YouTube link', await page.$eval('#streamsGrid .stream-card', (c) => [c.querySelectorAll('p')[0].textContent, c.querySelector('img').getAttribute('src'), c.querySelector('a').href, c.querySelector('a').target]),
      ['Western Suburbs Premier League', 'https://i.ytimg.com/vi/vidAAAAAAA1/hqdefault.jpg', 'https://www.youtube.com/watch?v=vidAAAAAAA1', '_blank']);
    await page.click('#streamsGrid [data-yt="vidAAAAAAA2"]');
    eq('play: the youtube-nocookie player takes the thumbnail\'s place', await page.$$eval('#streamsGrid iframe', (f) => f.map((x) => [x.src, x.allowFullscreen])),
      [['https://www.youtube-nocookie.com/embed/vidAAAAAAA2?autoplay=1&rel=0&modestbranding=1&playsinline=1', true]]);
    state.list = TOURNAMENTS.map((t) => (t.token === 't1' ? Object.assign({}, t, { streams: [S('vidAAAAAAA9', 'NEW vs ONE', 'Match 30', '2026-10-22T11:00:00.000Z', true)] }) : t));
    await page.evaluate(() => loadTournaments(true));
    await page.waitForTimeout(300);
    eq('a refresh with new streams leaves the playing video alone', await page.$$eval('#streamsGrid iframe', (f) => f.length), 1);
    state.list = TOURNAMENTS.map((t) => Object.assign({}, t, { streams: [] }));
    await page.evaluate(() => { document.querySelector('#streamsGrid iframe').parentElement.remove(); return loadTournaments(true); });
    await page.waitForTimeout(300);
    eq('no links on any match: no stream cards, the channel cards stay', [await page.$eval('#streamsGrid', (g) => g.hidden), await page.$$eval('.channel-card', (c) => c.map((x) => x.href))],
      [true, ['https://www.youtube.com/@allsportslive?sub_confirmation=1', 'https://www.instagram.com/all.sports.live']]);
    eq('no page errors', errors, []);
    await ctx.close();
  }

  console.log('\n=== WhatsApp ===');
  {
    const { ctx, page, errors } = await openHome(browser, { width: 390, height: 844 });
    eq('the button is on screen, the card closed', [await page.isVisible('#waBtn'), await page.isHidden('#waMenu'), await page.getAttribute('#waBtn', 'aria-expanded')], [true, true, 'false']);
    await page.click('#waBtn');
    const links = await page.$$eval('#waMenu a', (a) => a.map((x) => [x.querySelector('b').textContent, x.href.split('?')[0], decodeURIComponent(x.href.split('text=')[1] || ''), x.target, x.rel]));
    eq('open: both contacts, each a WhatsApp chat with the message typed in', [await page.isVisible('#waMenu'), await page.getAttribute('#waBtn', 'aria-expanded'), links],
      [true, 'true', [['Deepak Roy', 'https://wa.me/917900157214', "Hi All Sports Live! I'd like live scoring & streaming for my tournament.", '_blank', 'noopener noreferrer'],
        ['Vinit Karkera', 'https://wa.me/918356993593', "Hi All Sports Live! I'd like live scoring & streaming for my tournament.", '_blank', 'noopener noreferrer']]]);
    eq('… and the first contact has the focus', await page.evaluate(() => document.activeElement && document.activeElement.textContent.includes('Deepak Roy')), true);
    const r = await page.$eval('#waMenu', (m) => { const b = m.getBoundingClientRect(); return [b.left >= 0, b.right <= innerWidth, b.top >= 0, b.bottom <= innerHeight]; });
    eq('the card fits on a 390px phone', r, [true, true, true, true]);
    await page.keyboard.press('Escape');
    eq('Escape closes it, focus back on the button', [await page.isHidden('#waMenu'), await page.evaluate(() => document.activeElement.id)], [true, 'waBtn']);
    await page.click('.hero [data-wa-open]');
    eq('"Get it for your tournament" opens it too', await page.isVisible('#waMenu'), true);
    await page.mouse.click(30, 300);
    eq('a tap elsewhere closes it', await page.isHidden('#waMenu'), true);
    eq('no page errors', errors, []);
    if (SHOTS) { await page.click('#waBtn'); await page.screenshot({ path: path.join(SHOTS, 'home-whatsapp-390.png') }); }
    await ctx.close();
  }

  console.log('\n=== no sideways scrolling, every width ===');
  for (const [w, h] of [[320, 640], [390, 844], [768, 1024], [1024, 768], [1440, 900]]) {
    const { ctx, page, errors } = await openHome(browser, { width: w, height: h });
    const r = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.hero-ctas, .hero-usps, .flow-step, .feat-copy, .feat-media, .feat-media img, .reel-chip, .shot-phone, .shot-card, .sport-tile, .tournament-tools, .stream-card, .channel-card').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width && getComputedStyle(el).display !== 'none' && (b.left < -0.5 || b.right > innerWidth + 0.5)) out.push(el.className.split(' ')[0] + ' ' + Math.round(b.left) + '..' + Math.round(b.right));
      });
      return { html: document.documentElement.scrollWidth, iw: innerWidth, out };
    });
    eq(`${w}px: the page is no wider than the screen, nothing of the new sections off it`, [r.html <= r.iw, r.out], [true, []]);
    eq(`${w}px: no page errors`, errors, []);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `home-${w}.png`), fullPage: true, clip: { x: 0, y: 0, width: w, height: Math.min(16000, await page.evaluate(() => document.documentElement.scrollHeight)) } });
    await ctx.close();
  }

  console.log('\n=== the flow chain ===');
  {
    const { ctx, page } = await openHome(browser, { reduced: true });
    eq('reduced motion: no ball running, every step lit', await page.evaluate(() => [getComputedStyle(document.querySelector('.flow-runner')).animationName,
      [...document.querySelectorAll('.flow-glow')].map((g) => getComputedStyle(g).opacity)]), ['none', ['1', '1', '1', '1']]);
    eq('reduced motion: the reel never plays (its poster shows)', await page.evaluate(() => { const v = document.getElementById('reelVideo'); v.scrollIntoView(); return new Promise((r) => setTimeout(() => r(v.paused), 400)); }), true);
    await ctx.close();
    const m = await openHome(browser);
    await m.page.evaluate(() => window.scrollTo(0, 0));
    await m.page.waitForTimeout(200);
    eq('off screen the chain waits', await m.page.evaluate(() => document.getElementById('flowWrap').classList.contains('is-playing')), false);
    await m.page.evaluate(() => document.getElementById('flowWrap').scrollIntoView({ block: 'center' }));
    await m.page.waitForTimeout(300);
    eq('on screen it runs', await m.page.evaluate(() => [document.getElementById('flowWrap').classList.contains('is-playing'), getComputedStyle(document.querySelector('.flow-runner')).animationPlayState]), [true, 'running']);
    await m.ctx.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
