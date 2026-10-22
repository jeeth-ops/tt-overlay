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
//   • players' 3 taps: the phone plays the real screens on one loop — the
//     finger lands on Watch Live, the video icon by the name, the six's play
//     and Download; the right screen is in front at each tap; the loop's end
//     is its start; it runs only on screen; a step jumps there; reduced
//     motion shows each step's still; phones get the step tabs under it
//   • broadcast graphics: the TV plays the real overlay clip (local WebM +
//     MP4, muted, loop, poster, nothing loaded before it is shown) only on
//     screen; the step lights up with the clip's time, labels over the score
//     bar one by one, a step seeks there; reduced motion: no autoplay, a step
//     shows its own frame
//   • phones: no match setup in Try it yourself (a Reset in the panel
//     instead); a living background — floodlight beams, dust, glows — that
//     moves only by transform/opacity, and stays still under reduced motion
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
  const api = new Function([H.grabConst('LIVE_STREAM_FRESH_MS'), H.grab('isUpcomingRecord'), H.grab('youTubeVideoId'), H.grab('tournamentStreams'), 'return { youTubeVideoId, tournamentStreams };'].join('\n'))();
  const NOW = Date.parse('2026-10-22T12:00:00Z');
  const fresh = (matchId) => ({ matchId, roomId: 'r-' + matchId, startedAt: NOW - 60 * 1000 });     // the panel pinged a minute ago
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
  const st = api.tournamentStreams(matches, [fresh('m3')], 3, null, NOW);
  eq('the match being scored now first, then the newest; one per video, at most 3', st.map((s) => s.videoId), ['AAAAAAAAAA3', 'AAAAAAAAAA2', 'AAAAAAAAAA7']);
  eq('… each with its title, label, time and live flag — and nothing else', st[0], { videoId: 'AAAAAAAAAA3', title: 'BOR vs Andheri Lions', label: 'Match 4', at: '2026-09-20T10:00:00Z', live: true });
  eq('a stage name wins over the match number', st[1].label, 'Semi Final');
  eq('a fixture not started is left out, unless it is live', [api.tournamentStreams([matches[5]], [], 3, null, NOW).length, api.tournamentStreams([matches[5]], [fresh('m6')], 3, null, NOW).map((s) => s.live)], [0, [true]]);
  eq('no matches / no links: none', [api.tournamentStreams(null, null), api.tournamentStreams([matches[4]], [])], [[], []]);
  const stale = [{ matchId: 'm3', roomId: 'r3', startedAt: NOW - 26 * 24 * 3600 * 1000 }, { matchId: 'm1', roomId: 'r1' }];
  eq('"live" only while the panel keeps pinging: a weeks-old or undated pointer is not live', api.tournamentStreams(matches, stale, 5, null, NOW).map((s) => s.videoId + (s.live ? ':live' : '')),
    ['AAAAAAAAAA2', 'AAAAAAAAAA7', 'AAAAAAAAAA1', 'AAAAAAAAAA3']);
  eq('a video the owner took off is skipped — and the next one takes its place', api.tournamentStreams(matches, [fresh('m3')], 3, new Set(['AAAAAAAAAA2']), NOW).map((s) => s.videoId),
    ['AAAAAAAAAA3', 'AAAAAAAAAA7', 'AAAAAAAAAA1']);
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
// Firebase stood in for: signed out, or (owner: true) signed in as chhayajeeth@gmail.com
const firebaseStub = (owner) => `(function(){ var user = ${owner ? `{ uid: 'u-owner', email: 'chhayajeeth@gmail.com', displayName: 'Jeeth', getIdToken: function(){ return Promise.resolve('test-owner-token'); } }` : 'null'};
  window.firebase = { initializeApp(){ return {}; }, auth: Object.assign(function(){ return { currentUser: user,
  onAuthStateChanged(cb){ setTimeout(function(){ cb(user); }, 0); return function(){}; }, signOut(){ return Promise.resolve(); },
  getRedirectResult(){ return Promise.resolve({}); }, signInWithPopup(){ return Promise.reject(new Error('no')); } }; }, { GoogleAuthProvider: function(){} }),
  firestore(){ return { collection(){ return { add(){ return Promise.resolve(); } }; } }; } }; })();`;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf', '.ico': 'image/x-icon' };
let gsapJs = null;
try { gsapJs = fs.readFileSync(require.resolve('gsap/dist/gsap.min.js')); } catch (e) { /* the page falls back to CSS */ }

async function openHome(browser, { width = 1440, height = 900, reduced = false, list = TOURNAMENTS, owner = false, picks = { added: [], hidden: [] }, admin = null, listFail = 0, listDelay = 0, url = '/' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, timezoneId: 'Asia/Kolkata', reducedMotion: reduced ? 'reduce' : 'no-preference', isMobile: width < 800, hasTouch: width < 800 });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date('2026-10-22T12:00:00+05:30') });
  const errors = [], offsite = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  const state = { list, picks, adminCalls: [], listCalls: 0, listFail, imageHits: {} };
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'site.test') {
      if (u.pathname === '/api/public/tournaments') {
        state.listCalls++;
        if (listDelay) await sleep(listDelay);
        if (state.listFail > 0) { state.listFail--; return route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"tournaments":[]}' }); }
        // the owner's own view also lists what was taken off
        const ownerView = route.request().headers()['authorization'] === 'Bearer test-owner-token';
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, tournaments: state.list, streamPicks: ownerView ? state.picks : { added: state.picks.added } }) });
      }
      if (u.pathname.startsWith('/api/admin/streams') || u.pathname.startsWith('/api/admin/tournaments/')) {
        const r = route.request(), type = r.headers()['content-type'] || '', raw = r.postDataBuffer();
        const call = { method: r.method(), path: u.pathname, query: Object.fromEntries(u.searchParams), auth: r.headers()['authorization'] || null, type,
          bytes: raw || null, body: /json/.test(type) && raw && raw.length ? JSON.parse(raw.toString()) : {} };
        state.adminCalls.push(call);
        const out = admin ? admin(call, state) : { status: 200, json: { success: true } };
        return route.fulfill({ status: out.status, contentType: 'application/json', body: JSON.stringify(out.json) });
      }
      if (u.pathname === '/api/get-sports') return route.fulfill({ contentType: 'application/json', body: '[]' });
      const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
      if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        const body = fs.readFileSync(f), type = MIME[path.extname(f)] || 'application/octet-stream';
        const m = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers()['range'] || '');
        if (m) {   // byte ranges, as express.static serves them: a video can seek
          const start = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
          return route.fulfill({ status: 206, headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1) });
        }
        return route.fulfill({ headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes' }, body });
      }
      return route.fulfill({ status: 404, body: '' });
    }
    if (u.hostname === 'www.gstatic.com' && /firebase-app-compat/.test(u.pathname)) return route.fulfill({ contentType: 'application/javascript', body: firebaseStub(owner) });
    if (u.hostname === 'www.gstatic.com') return route.fulfill({ contentType: 'application/javascript', body: '' });
    if (u.hostname === 'cdnjs.cloudflare.com' && gsapJs) return route.fulfill({ contentType: 'application/javascript', body: gsapJs });
    if (u.hostname === 'cdn.asl.test') {   // where the owner's thumbnails live (R2)
      state.imageHits[u.pathname] = (state.imageHits[u.pathname] || 0) + 1;
      return /broken/.test(u.pathname) ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ contentType: 'image/jpeg', body: fs.readFileSync(path.join(ROOT, 'assets/home/og-image.jpg')) });
    }
    if (u.hostname === 'i.ytimg.com') return route.fulfill({ contentType: 'image/webp', body: fs.readFileSync(path.join(ROOT, 'assets/home/broadcast-tv-poster.webp')) });
    if (route.request().resourceType() === 'image') offsite.push(u.href);
    return route.abort();
  });
  await page.goto('http://site.test' + url);
  if (!listDelay) await page.waitForFunction(() => document.querySelectorAll('.tournament-card:not(.is-skeleton)').length > 0 || document.getElementById('tournaments-empty').style.display === 'block');
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
    eq('seven feature rows, each with words and a picture (the broadcast row: 4 steps beside its TV)', await page.$$eval('.feat-row', (r) => r.map((x) => x.id + ':' + (x.querySelectorAll('.feat-points li, .tv-step').length) + ':' + (x.querySelectorAll('.feat-media img, .feat-media video').length > 0))),
      ['feat-clips:3:true', 'feat-highlights:3:true', 'feat-report:3:true', 'feat-scoreboard:3:true', 'feat-tournament:3:true', 'feat-broadcast:4:true', 'feat-led:3:true']);
    eq('the flow: four steps, in order — titles only', [await page.$$eval('.flow-step h3', (h) => h.map((x) => x.textContent)), await page.$$eval('.flow-step p', (p) => p.length)],
      [['Ball scored', 'Clip cut automatically', 'Highlights ready', 'PDF report at the final ball'], 0]);
    eq('the hero line: short, no "on its own", no PDF part', await page.textContent('.hero > p'), 'Ball-by-ball scoring and HD streaming with TV-style graphics. Every 4, 6 and wicket becomes an HD clip, and any player\'s highlights are one tap away.');
    eq('the report row: the new heading, no paragraph under it', await page.$eval('#feat-report .feat-copy', (c) => [c.querySelector('h3').textContent, c.querySelectorAll(':scope > p').length]),
      ['A stunning, professional match report for every match', 0]);
    eq('the broadcast row: no paragraph under the heading', await page.$eval('#feat-broadcast .feat-copy', (c) => c.querySelectorAll(':scope > p').length), 0);
    eq('three sports', await page.$$eval('.sport-tile h3', (h) => h.map((x) => x.textContent.replace(/^\W+/, ''))), ['Cricket', 'Table Tennis', 'Football']);
    const imgs = await page.$$eval('main img, section img', (list) => list.filter((i) => !i.closest('#hero-section') && !i.closest('#tournaments-grid') && !i.closest('#streamsGrid') && !i.closest('#walk'))
      .map((i) => ({ src: i.getAttribute('src'), srcset: i.getAttribute('srcset') || '', lazy: i.getAttribute('loading'), dec: i.getAttribute('decoding'), w: i.getAttribute('width'), h: i.getAttribute('height'), alt: i.getAttribute('alt') })));
    eq('every product picture: a local WebP, lazy, async, sized, described', imgs.filter((i) => !(/^\/assets\/home\/[\w-]+\.webp$/.test(i.src) && i.lazy === 'lazy' && i.dec === 'async' && +i.w > 0 && +i.h > 0 && i.alt && i.alt.length > 10)).map((i) => i.src), []);
    eq('… all 11 of them (8 in the feature rows, 3 sport tiles)', imgs.length, 11);
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

  console.log('\n=== latest streams: the owner\'s tools ===');
  {
    // A stand-in for the owner-only /api/admin/streams routes, with the same
    // rules as server.js (test/homepage-streams-server.test.js checks the
    // real ones): only the owner's token, a YouTube link, hide / restore.
    const removedFrom = {};
    let failNext = false;
    const admin = (call, state) => {
      if (call.auth !== 'Bearer test-owner-token') return { status: 403, json: { success: false, error: 'Access Denied' } };
      if (failNext) { failNext = false; return { status: 500, json: { success: false, error: 'Could not remove the video' } }; }
      const m = /^\/api\/admin\/streams(?:\/([A-Za-z0-9_-]{11})\/(hide|restore))?$/.exec(call.path);
      if (!m) return { status: 404, json: { success: false } };
      if (!m[1]) {
        const id = (String(call.body.url || '').match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/) || [])[1];
        if (!id) return { status: 400, json: { success: false, error: 'Paste a YouTube video link (youtube.com/watch?v=… or youtu.be/…)' } };
        state.picks.added.unshift({ videoId: id, title: call.body.title || 'From YouTube', label: call.body.label || '', tournament: '', at: Date.now() });
        return { status: 200, json: { success: true } };
      }
      const id = m[1];
      if (m[2] === 'hide') {
        const added = state.picks.added.find((a) => a.videoId === id);
        state.picks.added = state.picks.added.filter((a) => a.videoId !== id);
        state.list = state.list.map((t) => {
          const hit = (t.streams || []).find((x) => x.videoId === id);
          if (hit) (removedFrom[id] = removedFrom[id] || []).push({ token: t.token, stream: hit });
          return Object.assign({}, t, { streams: (t.streams || []).filter((x) => x.videoId !== id) });
        });
        state.picks.hidden.unshift({ videoId: id, title: added ? added.title : call.body.title, label: added ? added.label : call.body.label, tournament: added ? '' : call.body.tournament, at: Date.now(), wasAdded: !!added });
      } else {
        const h = state.picks.hidden.find((x) => x.videoId === id);
        state.picks.hidden = state.picks.hidden.filter((x) => x.videoId !== id);
        if (h && h.wasAdded) state.picks.added.unshift({ videoId: id, title: h.title, label: h.label, tournament: '', at: Date.now() });
        else (removedFrom[id] || []).forEach((r) => { state.list = state.list.map((t) => (t.token === r.token ? Object.assign({}, t, { streams: [...t.streams, r.stream] }) : t)); });
      }
      return { status: 200, json: { success: true } };
    };
    const signedOut = await openHome(browser);
    eq('signed out: no owner tools, no remove buttons', [await signedOut.page.$eval('#streamsOwner', (b) => b.hidden), await signedOut.page.$$eval('.stream-remove', (b) => b.length)], [true, 0]);
    await signedOut.ctx.close();

    const { ctx, page, errors, state } = await openHome(browser, { owner: true, admin, picks: { added: [], hidden: [] } });
    await page.waitForFunction(() => !document.getElementById('streamsOwner').hidden);
    const order = () => page.$$eval('#streamsGrid .stream-card', (c) => c.map((x) => x.querySelector('[data-yt]').dataset.yt));
    const note = () => page.$eval('#soNote', (n) => [n.className, n.textContent]);
    eq('the owner: the toolbar, a ✕ on every card, nothing removed yet', [await page.isVisible('#soAddToggle'), await page.$$eval('.stream-remove', (b) => b.length), await page.isHidden('#soHiddenToggle')], [true, 5, true]);
    eq('… and the owner\'s list was fetched with the owner\'s token', state.adminCalls.length, 0);

    await page.click('#soAddToggle');
    eq('＋ Add YouTube video opens the form, the link box focused', [await page.isVisible('#soAddForm'), await page.evaluate(() => document.activeElement.id)], [true, 'soUrl']);
    await page.fill('#soUrl', 'https://vimeo.com/12345');
    await page.click('#soAddForm button[type="submit"]');
    await page.waitForFunction(() => /^✕/.test(document.getElementById('soNote').textContent));
    eq('a link that is not a YouTube video: the server\'s reason, the form stays open', [await note(), await page.isVisible('#soAddForm')],
      [['so-note err', '✕ Paste a YouTube video link (youtube.com/watch?v=… or youtu.be/…)'], true]);
    await page.fill('#soUrl', 'https://youtu.be/NEWVIDEO001');
    await page.fill('#soTitle', 'Grand <b>Final</b>');
    await page.fill('#soLabel', 'Final · 26 Oct');
    await page.click('#soAddForm button[type="submit"]');
    await page.waitForFunction(() => /^✓/.test(document.getElementById('soNote').textContent));
    const addCall = state.adminCalls[state.adminCalls.length - 1];
    eq('add: the owner\'s token, the link, the title and the line', [addCall.path, addCall.auth, addCall.body], ['/api/admin/streams', 'Bearer test-owner-token', { url: 'https://youtu.be/NEWVIDEO001', title: 'Grand <b>Final</b>', label: 'Final · 26 Oct' }]);
    eq('… the video shows straight after the live ones; the form closes, emptied', [await order(), await page.isHidden('#soAddForm'), await page.inputValue('#soUrl'), (await note())[1]],
      [['vidAAAAAAA1', 'vidAAAAAAA5', 'NEWVIDEO001', 'vidAAAAAAA2', 'vidAAAAAAA3', 'vidAAAAAAA4'], true, '', '✓ Added to Latest streams']);
    eq('… its card: the title as text, the line under it', await page.$eval('[data-yt="NEWVIDEO001"]', (b) => { const c = b.closest('.stream-card'); return [c.querySelector('h3').textContent, [...c.querySelectorAll('.stream-meta p')].map((p) => p.textContent), !!c.querySelector('h3 b')]; }),
      ['Grand <b>Final</b>', ['Final · 26 Oct'], false]);

    await page.click('.stream-remove[data-stream-hide="vidAAAAAAA2"]');
    await page.waitForFunction(() => !document.querySelector('[data-yt="vidAAAAAAA2"]'));
    const hideCall = state.adminCalls[state.adminCalls.length - 1];
    eq('✕ on a match\'s video: removed, with its title and where it came from', [hideCall.path, hideCall.auth, hideCall.body],
      ['/api/admin/streams/vidAAAAAAA2/hide', 'Bearer test-owner-token', { title: 'BAB vs MAM', label: 'Match 28', tournament: 'Western Suburbs Premier League' }]);
    eq('… gone from the cards; "Removed videos (1)" appears', [await order(), await page.textContent('#soHiddenToggle')], [['vidAAAAAAA1', 'vidAAAAAAA5', 'NEWVIDEO001', 'vidAAAAAAA3', 'vidAAAAAAA4'], 'Removed videos (1)']);
    await page.click('#soHiddenToggle');
    eq('the removed list: its thumbnail, title and where it came from, with Restore', await page.$$eval('#soHiddenList .so-row', (r) => r.map((x) => [x.querySelector('img').getAttribute('src'), x.querySelector('b').textContent, x.querySelector('span').textContent, x.querySelector('button').textContent])),
      [['https://i.ytimg.com/vi/vidAAAAAAA2/mqdefault.jpg', 'BAB vs MAM', 'Western Suburbs Premier League · Match 28', 'Restore']]);
    await page.click('[data-stream-restore="vidAAAAAAA2"]');
    await page.waitForFunction(() => !!document.querySelector('[data-yt="vidAAAAAAA2"]'));
    eq('Restore: the card is back, nothing left under removed', [state.adminCalls[state.adminCalls.length - 1].path, await order(), await page.isHidden('#soHiddenToggle')],
      ['/api/admin/streams/vidAAAAAAA2/restore', ['vidAAAAAAA1', 'vidAAAAAAA5', 'NEWVIDEO001', 'vidAAAAAAA2', 'vidAAAAAAA3', 'vidAAAAAAA4'], true]);
    await page.click('.stream-remove[data-stream-hide="NEWVIDEO001"]');
    await page.waitForFunction(() => !document.querySelector('[data-yt="NEWVIDEO001"]'));
    await page.click('#soHiddenToggle');
    await page.click('[data-stream-restore="NEWVIDEO001"]');
    await page.waitForFunction(() => !!document.querySelector('[data-yt="NEWVIDEO001"]'));
    eq('an added video: removed and put back the same way', (await order()).includes('NEWVIDEO001'), true);
    failNext = true;
    await page.click('.stream-remove[data-stream-hide="vidAAAAAAA3"]');
    await page.waitForFunction(() => /^✕/.test(document.getElementById('soNote').textContent));
    eq('the server says no: the card stays and is usable, the reason is shown', [(await order()).includes('vidAAAAAAA3'), await page.$eval('[data-yt="vidAAAAAAA3"]', (b) => b.closest('.stream-card').classList.contains('is-busy')), (await note())[1]],
      [true, false, '✕ Could not remove the video']);
    eq('no page errors', errors, []);
    if (SHOTS) { await page.evaluate(() => document.getElementById('streams').scrollIntoView()); await page.screenshot({ path: path.join(SHOTS, 'home-streams-owner.png') }); }
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

  console.log('\n=== players: the 3-taps phone ===');
  {
    // where each tap lands, as a fraction of the screen picture it taps (the
    // shots are 430px pages): Watch Live, the video icon on Aarav Patil's
    // row, the six's play button in the clips, Download in the player
    const TAPS = [[3.06, '.ws-a img', 0.5, 0.91228, 'Watch Live'], [7.5, '.ws-b img', 0.89535, 0.69578, 'the video icon by the name'],
      [9.41, '.ws-c img', 0.8186, 0.62077, 'the six\'s play button'], [13.36, '.ws-d > img', 0.84791, 904 / 932, 'Download']];
    const at = (page, t) => page.evaluate((t) => document.getElementById('walk').getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = t * 1000; }), t);
    const look = (page) => page.evaluate(() => {
      const r = (sel) => { const b = document.querySelector('#walk ' + sel).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      const op = (sel) => +getComputedStyle(document.querySelector('#walk ' + sel)).opacity;
      return { view: r('.wp-view'), a: r('.ws-a img'), b: r('.ws-b'), c: r('.ws-c'), dot: r('.ws-dot'), row: r('.ws-row'), bImg: r('.ws-b img'),
        dOp: op('.ws-d'), dimOp: op('.ws-dim'), rowOp: op('.ws-row'), fingerOp: op('.ws-finger'), step: document.getElementById('walk').dataset.step };
    });
    const onTarget = (page, sel, fx, fy) => page.evaluate(({ sel, fx, fy }) => {
      const im = document.querySelector('#walk ' + sel).getBoundingClientRect(), d = document.querySelector('#walk .ws-dot').getBoundingClientRect();
      return Math.hypot(d.left + d.width / 2 - (im.left + fx * im.width), d.top + d.height / 2 - (im.top + fy * im.height));
    }, { sel, fx, fy });
    const near = (a, b) => Math.abs(a - b) < 1;

    const { ctx, page, errors } = await openHome(browser);
    eq('three steps: open the match, find your name, watch & download', await page.$$eval('.walk-step h3 button', (b) => b.map((x) => x.textContent)), ['Open your match', 'Find your name', 'Watch & download']);
    eq('step 2 says where the video icon is', await page.textContent('.walk-step:nth-child(2) p'), 'On the scorecard, tap the video icon next to your name.');
    eq('the phone is one described picture', await page.$eval('.walk-phone', (f) => [f.getAttribute('role'), /Watch Live/.test(f.getAttribute('aria-label')) && /video icon/.test(f.getAttribute('aria-label')) && /Download/.test(f.getAttribute('aria-label'))]), ['img', true]);
    const frames = await page.$$eval('#walk img', (l) => l.map((i) => ({ src: i.getAttribute('src'), lazy: i.getAttribute('loading'), dec: i.getAttribute('decoding'), w: +i.getAttribute('width'), h: +i.getAttribute('height'), alt: i.getAttribute('alt') })));
    eq('its five screens: local WebP, lazy, async, sized, silent (the phone carries the words)', frames.map((f) => [f.src, f.lazy === 'lazy' && f.dec === 'async' && f.w > 0 && f.h > 0 && f.alt === '']),
      [['/assets/home/walk-tournament.webp', true], ['/assets/home/walk-scorecard.webp', true], ['/assets/home/walk-clips.webp', true], ['/assets/home/walk-player.webp', true], ['/assets/home/walk-six.webp', true]]);
    const idle = await page.evaluate(() => { const a = document.getElementById('walk').getAnimations({ subtree: true }).filter((x) => !(x instanceof CSSTransition)); return [a.length >= 20, [...new Set(a.map((x) => x.playState))], Math.max(...a.map((x) => x.currentTime))]; });
    eq('off screen: built, paused at the start', idle, [true, ['paused'], 0]);
    await page.evaluate(() => window.scrollTo(0, document.querySelector('.walk-phone').getBoundingClientRect().top + scrollY - 60));
    await page.waitForFunction(() => [...document.querySelectorAll('#walk img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
    await page.waitForTimeout(700);
    const run = await page.evaluate(() => { const a = document.getElementById('walk').getAnimations({ subtree: true }).filter((x) => !(x instanceof CSSTransition)); return [[...new Set(a.map((x) => x.playState))], a[0].currentTime > 300]; });
    eq('on screen: it plays', run, [['running'], true]);
    eq('… every screen\'s file is the size the page says', await page.$$eval('#walk img', (l) => l.every((i) => i.naturalWidth === +i.getAttribute('width') && i.naturalHeight === +i.getAttribute('height'))), true);

    for (const [t, sel, fx, fy, what] of TAPS) {
      await at(page, t);
      eq(`${t}s: the finger is on ${what}`, [(await onTarget(page, sel, fx, fy)) < 1.5, (await look(page)).fingerOp], [true, 1]);
    }
    await at(page, 3.06);
    let v = await look(page);
    eq('tap 1: the tournament page, scrolled to the live match; the scorecard still off to the side', [v.a.b > v.view.b, v.b.l >= v.view.r - 1, v.dOp], [true, true, 0]);
    await at(page, 7.5);
    v = await look(page);
    eq('tap 2: the scorecard in front, the name\'s row lit, the clips not up yet', [near(v.b.l, v.view.l), v.rowOp, v.c.t >= v.view.b - 1, v.dimOp], [true, 1, true, 0]);
    eq('… the lit row is Aarav Patil\'s, the tapped icon inside it', [near(v.row.t, v.bImg.t + 0.6468 * v.bImg.h), near(v.row.b, v.bImg.t + 0.7145 * v.bImg.h), v.dot.t + v.dot.h / 2 > v.row.t && v.dot.t + v.dot.h / 2 < v.row.b && v.dot.l + v.dot.w / 2 < v.row.r], [true, true, true]);
    await at(page, 9.41);
    v = await look(page);
    eq('tap 3: the clips up over the dimmed scorecard, the player not yet', [near(v.c.b, v.view.b), v.dimOp, v.dOp], [true, 1, 0]);
    await at(page, 13.36);
    v = await look(page);
    eq('tap 4: the player in front', [v.dOp], [1]);
    await at(page, 0);
    const start = await look(page);
    await at(page, 15.995);
    const end = await look(page);
    eq('the loop\'s end is its start: the tournament page at the top, nothing over it', [near(start.a.t, start.view.t), near(end.a.t, end.view.t), start.dOp, end.dOp < 0.02, start.b.l >= start.view.r - 1, end.b.l >= end.view.r - 1, start.fingerOp, end.fingerOp < 0.02],
      [true, true, 0, true, true, true, 0, true]);
    // the steps follow the phone, and a step jumps there
    await page.evaluate(() => document.getElementById('walk').getAnimations({ subtree: true }).forEach((a) => { a.currentTime = 0; a.play(); }));
    await page.waitForTimeout(400);
    const lit = () => page.evaluate(() => [document.getElementById('walk').dataset.step, [...document.querySelectorAll('.walk-step')].map((s) => s.classList.contains('is-on') ? 1 : 0).join(''), [...document.querySelectorAll('.walk-step button')].map((b) => b.getAttribute('aria-current') || '-').join(',')]);
    eq('playing step 1: step 1 lit', await lit(), ['1', '100', 'step,-,-']);
    await page.click('.walk-step:nth-child(3) button');
    await page.waitForTimeout(200);
    eq('tap step 3: the phone jumps to the clip, step 3 lit', [await lit(), Math.round((await page.evaluate(() => document.querySelector('#walk .ws-d').getAnimations()[0].currentTime)) / 1000)], [['3', '001', '-,-,step'], 9]);
    await page.click('.walk-step:nth-child(2) button');
    await page.waitForTimeout(200);
    eq('tap step 2: back to the scorecard', (await lit())[0], '2');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    eq('scrolled away: it waits', await page.evaluate(() => [...new Set(document.getElementById('walk').getAnimations({ subtree: true }).filter((x) => !(x instanceof CSSTransition)).map((x) => x.playState))]), ['paused']);
    eq('no page errors', errors, []);
    await ctx.close();

    // reduced motion: nothing moves; each step shows its own still
    const rm = await openHome(browser, { reduced: true });
    await rm.page.evaluate(() => document.querySelector('.walk-phone').scrollIntoView({ block: 'center' }));
    await rm.page.waitForFunction(() => [...document.querySelectorAll('#walk img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
    eq('reduced motion: still, nothing animated', await rm.page.evaluate(() => [document.getElementById('walk').classList.contains('is-static'), document.getElementById('walk').getAnimations({ subtree: true }).filter((x) => !(x instanceof CSSTransition)).length]), [true, 0]);
    v = await look(rm.page);
    eq('… it opens on step 2: the scorecard at the name, the row lit, the finger on the video icon', [v.step, near(v.b.l, v.view.l), v.rowOp, (await onTarget(rm.page, '.ws-b img', 0.89535, 0.69578)) < 1.5], ['2', true, 1, true]);
    await rm.page.click('.walk-step:nth-child(1) button');
    eq('… step 1: the tournament page at the live match, the finger on Watch Live', [(await look(rm.page)).step, (await onTarget(rm.page, '.ws-a img', 0.5, 0.91228)) < 1.5], ['1', true]);
    await rm.page.click('.walk-step:nth-child(3) button');
    v = await look(rm.page);
    eq('… step 3: the player, no finger', [v.step, v.dOp, v.fingerOp], ['3', 1, 0]);
    await rm.ctx.close();

    // a phone: the step tabs in one row right under it, the step's sentence as a caption
    const ph = await openHome(browser, { width: 390, height: 844 });
    await ph.page.evaluate(() => window.scrollTo(0, document.querySelector('.walk-phone').getBoundingClientRect().top + scrollY - 20));
    await ph.page.waitForTimeout(500);
    const g = await ph.page.evaluate(() => { const b = (e) => e.getBoundingClientRect(); const s = [...document.querySelectorAll('.walk-step')].map(b), p = b(document.querySelector('.walk-phone')), c = document.querySelector('.walk-cap');
      return { row: new Set(s.map((x) => Math.round(x.top))).size, under: s[0].top > p.bottom, fits: b(c).bottom - p.top <= innerHeight, cap: c.textContent, para: getComputedStyle(document.querySelector('.walk-step p')).position }; });
    eq('390px: three tabs in one row under the phone; phone, tabs and caption fit one screen', [g.row, g.under, g.fits], [1, true, true]);
    eq('… the caption is the lit step\'s sentence; the steps\' own sentences stay for screen readers', [g.cap, g.para], ['Tap your tournament, then the match you played.', 'absolute']);
    await ph.page.click('.walk-step:nth-child(3) button');
    eq('… tap a tab: its sentence', await ph.page.textContent('.walk-cap'), 'Your 4s, 6s and wickets play right there — save any of them in HD in one tap.');
    if (SHOTS) await ph.page.screenshot({ path: path.join(SHOTS, 'home-walk-390.png') });
    eq('390px: no page errors', ph.errors, []);
    await ph.ctx.close();
  }

  console.log('\n=== broadcast graphics: the overlay on a TV ===');
  {
    const tvState = (page) => page.evaluate(() => { const v = document.getElementById('tvVideo');
      return { paused: v.paused, t: v.currentTime, src: (v.currentSrc || '').split('/').pop(), lit: [...document.querySelectorAll('#tvSteps .tv-step')].map((s) => s.classList.contains('is-on') ? 1 : 0).join(''),
        labels: [...document.querySelectorAll('#tvDemo .tv-co')].map((l) => l.classList.contains('is-on') ? 1 : 0).join(''), current: [...document.querySelectorAll('#tvSteps button')].map((b) => b.getAttribute('aria-current') || '-').join(',') }; });
    const seek = (page, t) => page.evaluate((t) => new Promise((res) => { const v = document.getElementById('tvVideo'); v.pause(); v.addEventListener('seeked', () => setTimeout(res, 50), { once: true }); v.currentTime = t; }), t);
    const { ctx, page, errors } = await openHome(browser);
    eq('four steps: the score bar, 4 · 6 · wicket, player stats, the points table', await page.$$eval('#tvSteps .tv-step', (l) => l.map((x) => [x.querySelector('b').textContent, Number(x.dataset.at)])),
      [['Live score bar', 0], ['FOUR, SIX & WICKET', 6.2], ['Player stats', 24.8], ['Points table', 29.3]]);
    const vid = await page.$eval('#tvVideo', (v) => ({ muted: v.muted, loop: v.loop, inline: v.hasAttribute('playsinline'), preload: v.getAttribute('preload'), poster: v.getAttribute('poster'), label: v.getAttribute('aria-label').length > 40,
      sources: [...v.querySelectorAll('source')].map((x) => [x.getAttribute('src'), x.getAttribute('type')]) }));
    eq('the clip: muted, looping, inline, nothing loaded until shown, a poster first, described', [vid.muted, vid.loop, vid.inline, vid.preload, vid.poster, vid.label], [true, true, true, 'none', '/assets/home/broadcast-tv-poster.webp', true]);
    eq('… WebM (VP9) first, MP4 for the rest — both here, both small', [vid.sources, vid.sources.map(([src]) => fs.existsSync(path.join(ROOT, src)) && fs.statSync(path.join(ROOT, src)).size < 1.5e6), fs.existsSync(path.join(ROOT, vid.poster))],
      [[['/assets/home/broadcast-tv.webm', 'video/webm; codecs="vp9"'], ['/assets/home/broadcast-tv.mp4', 'video/mp4']], [true, true], true]);
    eq('off screen: not playing', (await tvState(page)).paused, true);
    await page.evaluate(() => window.scrollTo(0, document.getElementById('feat-broadcast').getBoundingClientRect().top + scrollY - 60));
    await page.waitForFunction(() => { const v = document.getElementById('tvVideo'); return !v.paused && v.currentTime > 2.7; }, null, { timeout: 15000 });
    let st = await tvState(page);
    eq('on screen it plays, from the start: step 1 lit, the score bar labelled one by one', [st.src, st.lit, st.labels.startsWith('11'), st.current], ['broadcast-tv.webm', '1000', true, 'step,-,-,-']);
    for (const [t, lit, labels, what] of [[3.2, '1000', '1100', 'two labels so far'], [5, '1000', '1111', 'all four labels'], [8.2, '0100', '0000', 'the FOUR: step 2, labels gone'],
      [26.5, '0010', '0000', 'the batter\'s card: step 3'], [32, '0001', '0000', 'the points table: step 4']]) {
      await seek(page, t);
      st = await tvState(page);
      eq(`${t}s: ${what}`, [st.lit, st.labels], [lit, labels]);
    }
    await page.evaluate(() => document.getElementById('tvVideo').play());
    await page.click('#tvSteps .tv-step:nth-child(3) button');
    await page.waitForTimeout(400);
    st = await tvState(page);
    eq('tap step 3: the clip jumps to the player card and plays on', [st.lit, st.t >= 24.8 && st.t < 26.5, st.paused, st.current], ['0010', true, false, '-,-,step,-']);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    eq('scrolled away: it pauses', (await tvState(page)).paused, true);
    eq('no page errors', errors, []);
    await ctx.close();

    const rm = await openHome(browser, { reduced: true });
    await rm.page.evaluate(() => window.scrollTo(0, document.getElementById('feat-broadcast').getBoundingClientRect().top + scrollY - 60));
    await rm.page.waitForTimeout(900);
    eq('reduced motion: on screen, still the poster — it never plays by itself', (await tvState(rm.page)).paused, true);
    await rm.page.click('#tvSteps .tv-step:nth-child(2) button');
    await rm.page.waitForFunction(() => document.getElementById('tvVideo').currentTime > 8, null, { timeout: 15000 });
    await rm.page.waitForTimeout(200);
    st = await tvState(rm.page);
    eq('… tap step 2: that step\'s own frame (the FOUR), still paused', [+st.t.toFixed(2), st.lit, st.paused], [8.2, '0100', true]);
    await rm.page.click('#tvSteps .tv-step:nth-child(1) button');
    await rm.page.waitForFunction(() => Math.abs(document.getElementById('tvVideo').currentTime - 5.5) < 0.01, null, { timeout: 15000 });
    await rm.page.waitForTimeout(200);
    st = await tvState(rm.page);
    eq('… tap step 1: the score bar with all its labels', [st.lit, st.labels], ['1000', '1111']);
    await rm.ctx.close();
  }

  console.log('\n=== phones: Try it yourself, the background ===');
  {
    const look = (page) => page.evaluate(() => {
      const cs = (sel) => getComputedStyle(document.querySelector(sel));
      const moving = [...document.querySelectorAll('.bg-m *, .ambient-blob')].flatMap((e) => e.getAnimations()).filter((a) => a.playState === 'running');
      const props = [...new Set(moving.flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p)))))].sort();
      return { setup: cs('#hiSetup').display, panelReset: cs('#hiResetPanelBtn').display, bgM: cs('.bg-m').display, grain: cs('.grain-overlay').display,
        blobFilter: cs('.ambient-blob.b1').filter, moving: moving.length, props, beams: document.querySelectorAll('.bg-m-beam').length, dust: document.querySelectorAll('.bg-m-p').length };
    });
    const desk = await openHome(browser);
    let v = await look(desk.page);
    eq('desktop: Match setup as before, no extra Reset; the video background, blurred blobs, no phone graphics', [v.setup, v.panelReset, v.bgM, v.grain, v.blobFilter], ['block', 'none', 'none', 'block', 'blur(90px)']);
    await desk.ctx.close();
    const ph = await openHome(browser, { width: 390, height: 844 });
    v = await look(ph.page);
    eq('390px: no Match setup; Reset sits in the panel', [v.setup, v.panelReset], ['none', 'block']);
    eq('390px: the living background — two beams, ten specks of dust, glows without a blur filter, no grain', [v.bgM, v.beams, v.dust, v.blobFilter, v.grain], ['block', 2, 10, 'none', 'none']);
    eq('… all of it moving, by transform and opacity only', [v.moving, v.props], [15, ['opacity', 'transform']]);
    // the panel's Reset brings a finished innings back
    await ph.page.evaluate(() => document.getElementById('hiEditor').scrollIntoView({ block: 'center' }));
    for (const x of ['6', '4', 'W']) await ph.page.click(x === 'W' ? '#hiOutcomeGrid [data-outcome="wicket"]' : `#hiOutcomeGrid [data-value="${x}"]`);
    await ph.page.waitForTimeout(150);
    const before = await ph.page.textContent('[data-du="score"]');
    await ph.page.click('#hiResetPanelBtn');
    await ph.page.waitForTimeout(150);
    eq('… the panel\'s Reset starts the match again', [before !== await ph.page.textContent('[data-du="score"]'), await ph.page.isDisabled('#hiUndoBtn')], [true, true]);
    eq('the innings-over line no longer points into Match setup', await ph.page.textContent('#hiInningsOver'), 'Innings complete — tap Reset to bowl another.');
    eq('390px: no page errors', ph.errors, []);
    await ph.ctx.close();
    const prm = await openHome(browser, { width: 390, height: 844, reduced: true });
    v = await look(prm.page);
    eq('390px, reduced motion: the same picture, nothing moving', [v.bgM, v.moving], ['block', 0]);
    await prm.ctx.close();
  }

  console.log('\n=== tournaments: sport tabs, the 16:9 row ===');
  {
    const TH = (n, o) => Object.assign({ url: `https://cdn.asl.test/tournament-thumbs/${n}.jpg`, x: 50, y: 50, w: 1200, h: 630 }, o);
    const list = TOURNAMENTS.map((t) => t.token === 't1' ? Object.assign({}, t, { thumb: TH('wspl', { y: 30 }) })
      : t.token === 't3' ? Object.assign({}, t, { thumb: TH('broken') })
      : t.token === 't7' ? Object.assign({}, t, { thumb: TH('portrait', { w: 645, h: 1398, y: 20 }) })
      : t.token === 't5' ? Object.assign({}, t, { info: Object.assign({ shortName: 'NMDT' }, t.info) }) : t).concat([
      TT({ token: 'tt1', name: 'City Open', sport: 'tabletennis', status: 'live', matchCount: 6, info: { season: '2026', city: 'Mumbai' } }),
      TT({ token: 'tt2', name: 'Thane TT Masters', sport: 'tabletennis', status: 'completed', matchCount: 12, info: null }),
      TT({ token: 't1b', name: 'Western Suburbs Premier League — Women', status: 'upcoming', matchCount: 0, upcomingCount: 4, info: { startDate: '2026-11-20' } })]);
    const row = (page) => page.evaluate(() => ({
      tabs: [...document.querySelectorAll('.sport-tab')].map((t) => [t.dataset.sport, t.getAttribute('aria-selected'), t.querySelector('[data-count]').textContent]),
      title: document.getElementById('tournamentsRowTitle').textContent, search: location.search,
      cards: [...document.querySelectorAll('#tournaments-grid .tournament-card h3')].map((h) => h.textContent) }));
    const { ctx, page, errors, state } = await openHome(browser, { list });
    let r = await row(page);
    eq('three sport tabs with their counts; Cricket chosen, nothing in the URL', [r.tabs, r.search, r.title], [[['cricket', 'true', '8'], ['football', 'false', '1'], ['tabletennis', 'false', '2']], '', 'Cricket tournaments 8']);
    eq('… the cricket row: cricket only, live first', r.cards, ['Western Suburbs Premier League', 'Weekend Box Cricket Smash', 'Thane Corporate Cup', 'MCA President Cup 2026 - 27', 'Navi Mumbai Diwali Trophy', 'Western Suburbs Premier League — Women', 'Pune Monsoon Bash', 'Kanga League 2026']);
    const card = (token) => page.$eval(`#tournaments-grid a[data-token="${token}"]`, (a) => {
      const m = a.querySelector('.tc-media'), b = m.getBoundingClientRect(), img = m.querySelector(':scope > img'), art = m.querySelector('.tc-art');
      return { href: a.getAttribute('href'), ratio: +(b.width / b.height).toFixed(3), img: img ? [img.getAttribute('src'), img.style.objectPosition, getComputedStyle(img).objectFit, img.loading] : null,
        art: art ? [art.querySelector('.tc-art-mono').textContent, art.querySelector('.tc-art-sport').textContent] : null, meta: a.querySelector('.tc-meta').textContent, sub: (a.querySelector('.tc-sub') || {}).textContent || '' };
    });
    let c = await card('t1');
    eq('a thumbnail: in a 16:9 frame, filled (cover, never stretched), centred where the owner set it, loaded lazily', [c.ratio, c.img], [1.778, ['https://cdn.asl.test/tournament-thumbs/wspl.jpg', '50% 30%', 'cover', 'lazy']]);
    eq('… the card opens that tournament by its token; the lines under the name', [c.href, c.meta, c.sub], ['/score/tournament/t1', 'Cricket · Season 3 · Mumbai', '28 matches · 1 Sept – 31 Oct']);
    c = await card('t7');
    eq('a portrait thumbnail: the same 16:9 frame, cropped where set', [c.ratio, c.img.slice(1, 3)], [1.778, ['50% 20%', 'cover']]);
    c = await card('t6');
    eq('no thumbnail: the designed picture — initials, its sport — in the same frame', [c.ratio, c.img, c.art], [1.778, null, ['WBCS', 'Cricket']]);
    eq('… the initials of the first four words; a short name the operator set wins', [(await card('t1b')).art, (await card('t5')).art], [['WSPL', 'Cricket'], ['NMDT', 'Cricket']]);
    await page.evaluate(() => document.querySelector('#tournaments-grid a[data-token="t3"]').scrollIntoView({ inline: 'center', block: 'nearest' }));
    await page.waitForFunction(() => !!document.querySelector('#tournaments-grid a[data-token="t3"] .tc-art'), null, { timeout: 5000 });
    await page.waitForTimeout(300);
    c = await card('t3');
    eq('a thumbnail that fails to load: the designed picture instead, asked for once', [c.ratio, c.img, c.art, state.imageHits['/tournament-thumbs/broken.jpg']], [1.778, null, ['PMB', 'Cricket'], 1]);
    eq('two tournaments with almost the same name open their own pages', [(await card('t1')).href, (await card('t1b')).href], ['/score/tournament/t1', '/score/tournament/t1b']);
    eq('an upcoming one says when it starts', (await card('t1b')).sub, 'Starts 20 Nov · 4 fixtures');
    eq('a long name stays within two lines', await page.$eval('#tournaments-grid a[data-token="t1b"] h3', (h) => h.getBoundingClientRect().height <= parseFloat(getComputedStyle(h).lineHeight) * 2 + 1), true);
    const calls = state.listCalls;
    await page.click('#sportTab-tabletennis');
    r = await row(page);
    eq('Table Tennis: its own tournaments, the URL says so', [r.tabs.map((t) => t[1]), r.cards, r.title, r.search], [['false', 'false', 'true'], ['City Open', 'Thane TT Masters'], 'Table Tennis tournaments 2', '?sport=table-tennis']);
    eq('… the table tennis picture', (await card('tt2')).art, ['TTM', 'Table Tennis']);
    await page.click('#sportTab-football');
    r = await row(page);
    eq('Football: only the football one', [r.cards, r.search], [['Football Friendly'], '?sport=football']);
    eq('… switching sports asks the server for nothing', state.listCalls, calls);
    await page.goBack();
    eq('Back: Table Tennis again', [(await row(page)).search, (await row(page)).cards], ['?sport=table-tennis', ['City Open', 'Thane TT Masters']]);
    await page.goBack();
    eq('Back again: Cricket', [(await row(page)).search, (await row(page)).tabs[0][1]], ['', 'true']);
    await page.goForward();
    eq('Forward: Table Tennis', (await row(page)).tabs[2][1], 'true');
    await page.focus('#sportTab-tabletennis');
    await page.keyboard.press('ArrowRight');
    eq('the arrow keys move between the tabs (and wrap)', [await page.evaluate(() => document.activeElement.id), (await row(page)).tabs[0][1]], ['sportTab-cricket', 'true']);
    // the row scrolls on its own, never the page
    const nav = () => page.evaluate(() => ({ shown: !document.getElementById('tcNav').hidden, prev: document.getElementById('tcPrev').disabled, next: document.getElementById('tcNext').disabled,
      left: document.getElementById('tournaments-grid').scrollLeft, pageX: window.scrollX, docW: document.documentElement.scrollWidth, winW: innerWidth }));
    await page.evaluate(() => document.getElementById('tournaments').scrollIntoView());
    await page.evaluate(() => { document.getElementById('tournaments-grid').scrollLeft = 0; });
    await page.waitForTimeout(150);
    let n = await nav();
    eq('more cards than fit: the arrows show, Previous off at the start', [n.shown, n.prev, n.next], [true, true, false]);
    await page.click('#tcNext');
    await page.waitForFunction(() => document.getElementById('tournaments-grid').scrollLeft > 100, null, { timeout: 5000 });
    await page.waitForTimeout(700);
    n = await nav();
    eq('Next moves the row by the cards in view — the page itself stays put', [n.left > 600, n.prev, n.pageX, n.docW <= n.winW], [true, false, 0, true]);
    await page.click('#tcPrev');
    await page.waitForFunction(() => document.getElementById('tournaments-grid').scrollLeft < 2, null, { timeout: 5000 });
    eq('Previous goes back to the start', (await nav()).left < 2, true);
    eq('the cards snap to their start', await page.$eval('#tournaments-grid', (g) => [getComputedStyle(g).scrollSnapType, getComputedStyle(g.querySelector('.tournament-card')).scrollSnapAlign]), ['x mandatory', 'start']);
    eq('no page errors', errors, []);
    await ctx.close();

    // straight to a sport by its link; a sport with nothing in it
    const tt = await openHome(browser, { list, url: '/?sport=table-tennis#tournaments' });
    eq('opened with ?sport=table-tennis: that tab and its row', [(await row(tt.page)).tabs[2][1], (await row(tt.page)).cards], ['true', ['City Open', 'Thane TT Masters']]);
    await tt.ctx.close();
    const none = await openHome(browser, { list: list.filter((t) => t.sport !== 'football'), url: '/?sport=football' });
    eq('a sport with no tournaments: says so, the tabs stay', await none.page.evaluate(() => [document.getElementById('tournaments-empty').style.display, document.getElementById('tournamentsEmptyText').textContent,
      document.getElementById('tournaments-grid').hidden, document.querySelectorAll('.sport-tab').length]), ['block', 'No football tournaments right now.', true, 3]);
    await none.ctx.close();

    // loading, and a list that will not load
    const slow = await openHome(browser, { list, listDelay: 1500 });
    eq('loading: placeholder cards in the same 16:9 shape', await slow.page.evaluate(() => [document.getElementById('tournaments-grid').getAttribute('aria-busy'), [...document.querySelectorAll('#tournaments-grid .is-skeleton .tc-media')].map((m) => +(m.getBoundingClientRect().width / m.getBoundingClientRect().height).toFixed(3))]),
      ['true', [1.778, 1.778, 1.778, 1.778, 1.778]]);
    await slow.page.waitForFunction(() => document.querySelectorAll('.tournament-card:not(.is-skeleton)').length > 0, null, { timeout: 8000 });
    eq('… then the real cards', [await slow.page.evaluate(() => document.getElementById('tournaments-grid').hasAttribute('aria-busy')), (await cards(slow.page)).length], [false, 8]);
    await slow.ctx.close();
    // both loads at start (the page's own, and the one after sign-in state) fail
    const down = await openHome(browser, { list, listFail: 2 });
    await down.page.waitForFunction(() => document.getElementById('tournaments-empty').style.display === 'block', null, { timeout: 8000 });
    eq('the list fails to load: says so and offers Try again — no endless spinner', await down.page.evaluate(() => [document.getElementById('tournamentsEmptyText').textContent, document.getElementById('tournamentsRetry').hidden]),
      ['Could not load the tournaments right now.', false]);
    await down.page.click('#tournamentsRetry');
    await down.page.waitForFunction(() => document.querySelectorAll('.tournament-card:not(.is-skeleton)').length > 0, null, { timeout: 8000 });
    eq('… Try again brings the cards', [(await cards(down.page)).length, await down.page.evaluate(() => document.getElementById('tournamentsRetry').hidden)], [8, true]);
    await down.ctx.close();
  }

  console.log('\n=== the owner\'s thumbnails ===');
  {
    // A stand-in for the owner-only thumbnail routes with server.js's rules
    // (test/tournament-thumbnails-server.test.js checks the real ones): the
    // owner's token only, the version the edit started from, the picture.
    const plan = { next: null }, uploads = [];
    let seq = 0;
    const admin = (call, state) => {
      if (call.auth !== 'Bearer test-owner-token') return { status: 403, json: { success: false, error: 'Access Denied' } };
      const m = /^\/api\/admin\/tournaments\/([^/]+)\/([^/]+)\/thumbnail(\/focus)?$/.exec(call.path);
      const t = m && state.list.find((x) => x.ownerUid === decodeURIComponent(m[1]) && x.leagueKey === decodeURIComponent(m[2]));
      if (!t) return { status: 404, json: { success: false, error: 'Tournament not found' } };
      if (plan.next) { const out = plan.next(t); plan.next = null; return out; }
      const expect = Number(call.method === 'POST' ? call.body.expect : call.query.expect);
      if (expect !== (t.thumbV || 0)) return { status: 409, json: { success: false, code: 'THUMB_CHANGED', error: 'This thumbnail was just changed somewhere else — showing the newest one now', thumb: t.thumb || null, thumbV: t.thumbV || 0 } };
      if (call.method === 'PUT') {
        uploads.push(call);
        t.thumb = { url: `https://cdn.asl.test/tournament-thumbs/up${++seq}.webp`, x: Number(call.query.x), y: Number(call.query.y), w: 1200, h: 630 };
      } else if (call.method === 'POST') t.thumb = Object.assign({}, t.thumb, { x: call.body.x, y: call.body.y });
      else t.thumb = null;
      t.thumbV = expect + 1;
      return { status: 200, json: { success: true, thumb: t.thumb, thumbV: t.thumbV } };
    };
    const own = (o) => Object.assign({ ownerUid: 'u-work', createdBy: 'workallsportslive@gmail.com', isPrivate: false, thumbV: 0, thumb: null }, o);
    const list = [own(TT({ token: 'o1', leagueKey: 'pub cup', name: 'Pub Cup', status: 'live' })),
      own(TT({ token: 'o2', leagueKey: 'dyp t20', name: 'DY Patil T20', status: 'ongoing', thumbV: 3, thumb: { url: 'https://cdn.asl.test/tournament-thumbs/dyp.jpg', x: 50, y: 50, w: 1200, h: 630 } }))];
    const pic = (p, mimeType = 'image/jpeg', name = 'pic.jpg') => ({ name, mimeType, buffer: fs.readFileSync(path.join(ROOT, p)) });
    const ed = (page) => page.evaluate(() => {
      const v = (id) => { const e = document.getElementById(id); return e.hidden ? null : e.textContent.trim(); };
      const img = document.getElementById('mtImg'), f = document.getElementById('mtFrame').getBoundingClientRect();
      return { img: img.hidden ? null : [img.getAttribute('src').slice(0, 5), img.style.objectPosition], art: !document.getElementById('mtArt').hidden, ratio: +(f.width / f.height).toFixed(3),
        pick: document.querySelector('#mtPick span').textContent, remove: v('mtRemove'), cancel: v('mtCancel'), save: v('mtSave'), status: document.getElementById('mtStatus').textContent };
    });
    const manage = async (page, token) => { await page.evaluate((tok) => document.querySelector(`#tournaments-grid a[data-token="${tok}"] [data-manage-btn]`).click(), token); await page.waitForTimeout(150); };
    const { ctx, page, errors, state } = await openHome(browser, { owner: true, list, admin });
    await page.waitForFunction(() => document.querySelectorAll('[data-manage-btn]').length === 2, null, { timeout: 8000 });
    await manage(page, 'o1');
    let e = await ed(page);
    eq('Manage → the thumbnail panel: the designed picture in the 16:9 frame, one button', [e.ratio, e.art, e.img, e.pick, e.remove, e.cancel, e.save], [1.778, true, null, 'Choose image', null, null, null]);
    await page.setInputFiles('#mtFile', pic('assets/home/walk-six.webp', 'image/gif', 'anim.gif'));
    eq('a GIF: refused here, nothing sent', [(await ed(page)).status, uploads.length], ['✕ Pick a JPG, PNG or WebP picture', 0]);
    await page.setInputFiles('#mtFile', pic('logo.png', 'image/png', 'logo.png'));
    await page.waitForFunction(() => /too small/.test(document.getElementById('mtStatus').textContent), null, { timeout: 5000 });
    eq('a picture too small for a sharp card: says so, nothing sent', [(await ed(page)).status, uploads.length], ['✕ That picture is too small for a sharp card — it needs at least 480 × 270', 0]);
    await page.setInputFiles('#mtFile', pic('assets/home/og-image.jpg'));
    await page.waitForFunction(() => !document.getElementById('mtSave').hidden && document.getElementById('mtImg').naturalWidth > 0, null, { timeout: 8000 });
    e = await ed(page);
    eq('a landscape JPEG: previewed in the card\'s frame, centred; Save / Cancel', [e.img, e.ratio, e.save, e.cancel, e.remove, e.status], [['blob:', '50% 50%'], 1.778, 'Save thumbnail', 'Cancel', null, 'Drag the picture to choose what the card shows, then save.']);
    const box = await page.$eval('#mtFrame', (f) => { const b = f.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x - 80, box.y, { steps: 6 });
    await page.mouse.up();
    eq('drag it left: the frame shows its right side (it is wider than 16:9 — only sideways moves)', (await ed(page)).img[1], '100% 50%');
    await page.click('#mtSave');
    await page.waitForFunction(() => /saved/.test(document.getElementById('mtStatus').textContent), null, { timeout: 8000 });
    const up = uploads[0];
    eq('Save: one upload — resized in the browser to WebP, with the owner\'s token, the version it started from and the position',
      [uploads.length, up.method, up.type, up.bytes.slice(0, 4).toString() + up.bytes.slice(8, 12).toString(), up.auth, up.query], [1, 'PUT', 'image/webp', 'RIFFWEBP', 'Bearer test-owner-token', { expect: '0', x: '100', y: '50' }]);
    eq('… the card shows the new picture at once', await page.$eval('#tournaments-grid a[data-token="o1"] .tc-media > img', (i) => [i.getAttribute('src'), i.style.objectPosition]), ['https://cdn.asl.test/tournament-thumbs/up1.webp', '100% 50%']);
    e = await ed(page);
    eq('… the panel: the saved picture, Replace / Remove', [e.status, e.pick, e.remove, e.save], ['✓ Thumbnail saved — the card shows it now', 'Replace image', 'Remove', null]);
    // a portrait picture: up and down (arrow keys)
    await page.setInputFiles('#mtFile', pic('assets/home/walk-player.webp', 'image/webp', 'tall.webp'));
    await page.waitForFunction(() => !document.getElementById('mtSave').hidden && document.getElementById('mtImg').naturalWidth > 0 && /^blob/.test(document.getElementById('mtImg').src), null, { timeout: 8000 });
    await page.focus('#mtFrame');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    eq('a portrait picture: the arrow keys move it up and down (2 a press, 10 with Shift)', (await ed(page)).img[1], '50% 34%');
    plan.next = () => ({ status: 500, json: { success: false, error: 'Could not save the thumbnail — the old one is unchanged' } });
    await page.click('#mtSave');
    await page.waitForFunction(() => /✕/.test(document.getElementById('mtStatus').textContent), null, { timeout: 8000 });
    eq('the server fails: says so, the card keeps its picture, the new one can be saved again', [(await ed(page)).status, await page.$eval('#tournaments-grid a[data-token="o1"] .tc-media > img', (i) => i.getAttribute('src')), (await ed(page)).save],
      ['✕ Could not save the thumbnail — the old one is unchanged', 'https://cdn.asl.test/tournament-thumbs/up1.webp', 'Save thumbnail']);
    await page.click('#mtCancel');
    e = await ed(page);
    eq('Cancel: back to the saved picture and position', [e.img, e.save, e.remove], [['https', '100% 50%'], null, 'Remove']);
    // remove: two presses
    await page.click('#mtRemove');
    eq('Remove asks for a second press', [(await ed(page)).remove, uploads.length, state.adminCalls.filter((x) => x.method === 'DELETE').length], ['Press again to remove', 1, 0]);
    await page.click('#mtRemove');
    await page.waitForFunction(() => /Removed/.test(document.getElementById('mtStatus').textContent), null, { timeout: 8000 });
    const del = state.adminCalls.filter((x) => x.method === 'DELETE');
    eq('… removed: one DELETE from version 1, the card shows its designed picture again', [del.length, del[0].query, await page.$eval('#tournaments-grid a[data-token="o1"] .tc-media', (m) => [!!m.querySelector(':scope > img'), !!m.querySelector('.tc-art')]), (await ed(page)).art],
      [1, { expect: '1' }, [false, true], true]);
    await page.click('#manage-modal .manage-btn.secondary');
    // a position-only change, and a stale one
    await manage(page, 'o2');
    await page.focus('#mtFrame');
    await page.waitForFunction(() => document.getElementById('mtImg').naturalWidth > 0, null, { timeout: 8000 });
    await page.keyboard.press('ArrowRight');
    eq('a saved picture moved: Save position', [(await ed(page)).save, (await ed(page)).img[1]], ['Save position', '52% 50%']);
    await page.click('#mtSave');
    await page.waitForFunction(() => /Position saved/.test(document.getElementById('mtStatus').textContent), null, { timeout: 8000 });
    const focusCall = state.adminCalls.filter((x) => /\/focus$/.test(x.path)).pop();
    eq('… sent as a position, from version 3', [focusCall.method, focusCall.body], ['POST', { x: 52, y: 50, expect: 3 }]);
    list[1].thumbV = 9;   // another tab saved a newer picture meanwhile
    list[1].thumb = { url: 'https://cdn.asl.test/tournament-thumbs/newer.jpg', x: 10, y: 50, w: 1200, h: 630 };
    await page.keyboard.press('ArrowRight');
    await page.click('#mtSave');
    await page.waitForFunction(() => /changed somewhere else/.test(document.getElementById('mtStatus').textContent), null, { timeout: 8000 });
    e = await ed(page);
    eq('an edit from an older version: refused, the newest picture shows, the edit is dropped', [e.img[1], e.save, await page.$eval('#tournaments-grid a[data-token="o2"] .tc-media > img', (i) => i.getAttribute('src'))],
      ['10% 50%', null, 'https://cdn.asl.test/tournament-thumbs/newer.jpg']);
    eq('no page errors', errors, []);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'home-thumb-editor.png') });
    await ctx.close();
    // anyone else: no Manage, so no thumbnail controls at all
    const visitor = await openHome(browser, { list, admin });
    eq('a visitor: no Manage on the cards, nothing sent', [await visitor.page.$$eval('[data-manage-btn]', (b) => b.length), visitor.state.adminCalls.length], [0, 0]);
    await visitor.ctx.close();
  }

  console.log('\n=== no sideways scrolling, every width ===');
  for (const [w, h] of [[320, 640], [360, 740], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]]) {
    const { ctx, page, errors } = await openHome(browser, { width: w, height: h });
    const r = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.hero-ctas, .hero-usps, .flow-step, .feat-copy, .feat-media, .feat-media img, .reel-chip, .shot-phone, .shot-card, .walk-phone, .walk-step, .walk-cap, .tv, .tv-step, .tv-co b, .hi-editor, .sport-tile, .sport-tabs, .sport-tab, .tc-head, .tournament-tools, .stream-card, .channel-card').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width && getComputedStyle(el).display !== 'none' && (b.left < -0.5 || b.right > innerWidth + 0.5)) out.push(el.className.split(' ')[0] + ' ' + Math.round(b.left) + '..' + Math.round(b.right));
      });
      return { html: document.documentElement.scrollWidth, iw: innerWidth, out };
    });
    eq(`${w}px: the page is no wider than the screen, nothing of the new sections off it`, [r.html <= r.iw, r.out], [true, []]);
    const tc = await page.evaluate(() => { const g = document.getElementById('tournaments-grid'), first = g.querySelector('.tournament-card').getBoundingClientRect();
      return { ratios: [...new Set([...g.querySelectorAll('.tc-media')].map((m) => (m.getBoundingClientRect().width / m.getBoundingClientRect().height).toFixed(3)))],
        inView: +(g.clientWidth / first.width).toFixed(1), label: [...document.querySelectorAll('.sport-tab span:not(.sport-tab-count)')].every((s) => s.scrollWidth <= s.clientWidth + 1) }; });
    eq(`${w}px: every card picture 16:9; ${w < 600 ? 'one card and a part of the next' : 'several cards'} in view; the tab names fit`, [tc.ratios, w < 600 ? tc.inView > 1 && tc.inView < 1.5 : tc.inView > 2, tc.label], [['1.778'], true, true]);
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
