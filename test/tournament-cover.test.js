// score-tournament.html — the tournament's cover: its picture (the thumbnail
// its homepage card shows) edge to edge behind its name, on the REAL page
// through Playwright — the tournament API stubbed, the picture served from a
// stand-in CDN. Checks that
//   • the picture runs edge to edge (laptop and phone) and nothing leaves the
//     screen sideways; the name is the page's one <h1>
//   • the picture stays vivid: away from the words its pixels are exactly as
//     they are without the shade — no filter, no dimming; and the words read
//     on it (contrast measured off the screen, dark theme and light)
//   • the page wears the picture's own colours (thumb.palette) in both
//     themes — the tabs, the season line — with real contrast; the greens
//     and reds that mean won / lost / live stay the portal's own
//   • without a picture, or when it cannot load: the homepage card's poster
//     (its colours, its sport's ground) — and it stays through the re-draws
//   • the quiet 20 s re-draw keeps the same picture (no blink, no entrance
//     again); a new picture or a new crop replaces it
//   • a name or a picture link from the database is text / ignored, never
//     markup; the page still works when /tournament-art.js cannot load
//   • phone: the picture whole on top (16:9), the words under it
//   • light + dark screenshots for review (test/out/)
//
// Run:  NODE_PATH=$(npm root -g) node test/tournament-cover.test.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const PICTURE = fs.readFileSync(path.join(ROOT, 'assets/home/sport-cricket-720.webp'));   // a ground under floodlights, 720 × 405

const fails = [];
const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };

const bat = (name, runs, balls, fours, sixes) => ({ name, runs, balls, fours, sixes });
const bowl = (name, wickets) => ({ name, overs: '4.0', runs: 30, wickets });
const MATCHES = [
  { matchId: 'm1', roomId: 'R1', matchNo: 1, format: 'T20', savedAt: '2026-10-11T10:00:00Z', winningTeam: 'A',
    teamA: { name: 'Dr DY Patil Sports Academy', short: 'DYP' }, teamB: { name: 'New Cricket Club', short: 'NCC' },
    scoreA: { runs: 181, wickets: 5, overs: '20.0' }, scoreB: { runs: 160, wickets: 9, overs: '20.0' },
    battingCard: { A: [bat('Aarav Patil', 84, 52, 8, 4), bat('Rohan Iyer', 41, 30, 3, 2)], B: [bat('Kabir Rao', 62, 45, 6, 1)] },
    bowlingCard: { A: [bowl('Kunal Shetty', 4)], B: [bowl('Neel More', 2)] } },
  { matchId: 'm2', roomId: 'R2', matchNo: 2, format: 'T20', savedAt: '2026-10-12T10:00:00Z', winningTeam: 'B',
    teamA: { name: 'Parel Sports Club', short: 'PSC' }, teamB: { name: 'Dr DY Patil Sports Academy', short: 'DYP' },
    scoreA: { runs: 140, wickets: 10, overs: '18.4' }, scoreB: { runs: 141, wickets: 3, overs: '16.2' },
    battingCard: { A: [bat('Om Desai', 55, 40, 5, 2)], B: [bat('Aarav Patil', 71, 39, 6, 5)] },
    bowlingCard: { A: [bowl('Yash Pawar', 2)], B: [bowl('Kunal Shetty', 3)] } },
];
const PIC = 'https://cdn.asl.test/tournament-thumbs/0123456789abcdef01234567.webp';
// the picture's own colours, as the server reads them off it
const PALETTE = ['#377339', '#ac996d'];
const fixture = (o = {}) => Object.assign({
  success: true, displayName: 'MCA President Cup 2026 - 27 (A & B Division)', sport: 'cricket',
  info: { season: '2026 - 27', startDate: '2026-10-10', venue: 'D Y Patil University Ground', city: 'Navi Mumbai', format: 'T20', organizer: 'Mumbai Cricket Association' },
  live: { roomId: null, matchId: null, matches: [] }, matches: MATCHES, pointsTable: [],
  leaderboards: { topRuns: [{ name: 'Aarav Patil', runs: 155, balls: 91, highScore: 84, sixes: 9, fours: 14, strikeRate: 170.33 }], topWickets: [{ name: 'Kunal Shetty', wickets: 7, overs: 8, economy: 7.5 }] },
  thumb: { url: PIC, x: 50, y: 40, w: 720, h: 405, palette: PALETTE },
}, o);

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
async function openPage(browser, { width, height, theme, data, picture = 'ok', artJs = true }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await ctx.addInitScript((t) => { try { localStorage.setItem('scorvix-theme', t); } catch (e) {} }, theme);
  const page = await ctx.newPage();
  const state = { data, picture, pictures: 0 };
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.host === 'cdn.asl.test') {
      state.pictures++;
      return state.picture === 'ok' ? route.fulfill({ contentType: 'image/webp', body: PICTURE }) : route.fulfill({ status: 404, body: '' });
    }
    if (u.host !== 'test.local') return route.abort();
    if (u.pathname === '/api/public/tournament/TOK') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.data) });
    if (u.pathname.startsWith('/score/tournament/')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(ROOT, 'score-tournament.html')) });
    if (u.pathname === '/tournament-art.js' && !artJs) return route.fulfill({ status: 404, body: '' });
    const f = path.join(ROOT, u.pathname);
    if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://test.local/score/tournament/TOK');
  await page.waitForSelector('#tourney-hero .tcover-media > *');
  await page.waitForFunction(() => { const i = document.querySelector('.tcover-media > img'); return !i || i.complete; });
  await page.waitForTimeout(1400);   // the entrance has played
  // switches for the pixel checks: the shade off / the words off (their glow kept)
  await page.addStyleTag({ content: 'html.t-no-shade .tcover-media::after{ display:none !important; } html.t-ghost .tcover-body *{ color:transparent !important; } html.t-ghost .tcover-body .th-fact, html.t-ghost .tcover-body .tstat-chip{ visibility:hidden !important; }' });
  return { ctx, page, state, errors };
}
const flag = (page, cls, on) => page.evaluate(([c, v]) => document.documentElement.classList.toggle(c, v), [cls, on]);
const quietRedraw = (page) => page.evaluate(async () => { await refreshPortal('TOK'); });

/* ---- colour arithmetic (WCAG) ---- */
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(String(h).trim().slice(i, i + 2), 16));
const cssRgb = (s) => (String(s).match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hue = (c) => { const [r, g, b] = c.map((v) => v / 255); const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min; if (!d) return 0; return 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4); };
const hueGap = (a, b) => { const d = Math.abs(hue(a) - hue(b)) % 360; return Math.min(d, 360 - d); };

/* ---- pixels: screenshots decoded by the browser itself ---- */
let decoder;
const pixelsOf = (png) => decoder.evaluate(async (b64) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  return Array.from(x.getImageData(0, 0, c.width, c.height).data);
}, png.toString('base64'));
const clipOf = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
// how far apart two shots of the same place are, 0–255 per channel on average
async function meanDiff(a, b) {
  const p = await pixelsOf(a), q = await pixelsOf(b);
  let sum = 0, n = 0;
  for (let i = 0; i < p.length; i += 4) { sum += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]); n += 3; }
  return sum / n;
}
// the contrast the words get on the backdrop behind them: the 10th
// percentile over every pixel there (90% of it reads at least this well);
// opacity: the words' own (the colour they actually show is mixed in)
async function backdropContrast(page, rects, text, opacity = 1) {
  const ratios = [];
  for (const r of rects) {
    const p = await pixelsOf(await page.screenshot({ clip: clipOf(r) }));
    for (let i = 0; i < p.length; i += 4) {
      const bg = [p[i], p[i + 1], p[i + 2]];
      ratios.push(contrast(text.map((v, k) => v * opacity + bg[k] * (1 - opacity)), bg));
    }
  }
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length * 0.1)] || 0;
}
// the line boxes a piece of text actually covers (not its whole block)
const textRects = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()].filter((q) => q.width > 2 && q.height > 2).map((q) => ({ x: q.x, y: q.y, width: q.width, height: q.height })); }, sel);

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  decoder = await browser.newPage();

  /* ================= laptop, dark: the picture ================= */
  console.log('\n=== laptop 1440, dark: the picture ===');
  let { ctx, page, state, errors } = await openPage(browser, { width: 1440, height: 900, theme: 'dark', data: fixture() });
  const lay = await page.evaluate(() => {
    const cover = document.querySelector('.tcover'), img = document.querySelector('.tcover-media > img'), r = cover.getBoundingClientRect();
    const cs = getComputedStyle(img);
    return { left: r.left, width: r.width, top: r.top, height: r.height, vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
      src: img.currentSrc || img.src, pos: cs.objectPosition, fit: cs.objectFit, filter: cs.filter, opacity: cs.opacity, natural: img.naturalWidth,
      h1: document.querySelectorAll('h1').length, h1Text: document.querySelector('h1#tourney-name').textContent, label: cover.getAttribute('aria-label'),
      inWrap: !!cover.closest('#wrap'), mediaHidden: document.querySelector('.tcover-media').getAttribute('aria-hidden'), alt: img.getAttribute('alt') };
  });
  check(lay.left === 0 && Math.abs(lay.width - lay.vw) < 1 && !lay.inWrap, `edge to edge: the cover spans the whole window (${lay.left}, ${lay.width} of ${lay.vw}), outside the page column`);
  check(lay.sw <= lay.vw, `nothing leaves the screen sideways (${lay.sw} ≤ ${lay.vw})`);
  check(lay.height >= 400 && lay.height <= 580, `a real cover, not a strip: ${lay.height}px tall`);
  check(lay.src === PIC && lay.natural === 720, 'the tournament\'s own picture, loaded');
  check(lay.fit === 'cover' && lay.pos === '50% 40%', `filled, centred where the owner set it (${lay.fit}, ${lay.pos})`);
  check(lay.filter === 'none' && lay.opacity === '1', `never dimmed or blurred (filter ${lay.filter}, opacity ${lay.opacity})`);
  check(lay.h1 === 1 && lay.h1Text === 'MCA President Cup 2026 - 27 (A & B Division)' && lay.label === lay.h1Text, 'the name is the page\'s one <h1>, and names the cover');
  check(lay.mediaHidden === 'true' && lay.alt === '', 'the picture is decoration for a screen reader (its name is read once, from the <h1>)');

  // vivid: away from the words, the shade leaves the picture exactly as it is
  const away = clipOf({ x: lay.width * 0.66, y: lay.top + lay.height * 0.22, width: lay.width * 0.3, height: lay.height * 0.32 });
  let shaded = await page.screenshot({ clip: away });
  await flag(page, 't-no-shade', true);
  let bare = await page.screenshot({ clip: away });
  await flag(page, 't-no-shade', false);
  let d = await meanDiff(shaded, bare);
  check(d < 1, `vivid: right of the words, the picture is untouched by the shade (mean difference ${d.toFixed(2)}/255)`);
  // and the shade is really there behind the words
  const words = clipOf({ x: 24, y: lay.top + lay.height * 0.45, width: 300, height: lay.height * 0.3 });
  shaded = await page.screenshot({ clip: words });
  await flag(page, 't-no-shade', true);
  bare = await page.screenshot({ clip: words });
  await flag(page, 't-no-shade', false);
  d = await meanDiff(shaded, bare);
  check(d > 8, `… behind the words it is shaded into the page (mean difference ${d.toFixed(1)}/255)`);

  // the words read on it — measured off the screen, their glow included
  const readable = async (theme) => {
    const text = cssRgb(await page.evaluate(() => getComputedStyle(document.getElementById('tourney-name')).color));
    const look = cssRgb(await page.evaluate(() => getComputedStyle(document.querySelector('.tcover .th-sub')).color));
    const meta = cssRgb(await page.evaluate(() => getComputedStyle(document.getElementById('tourney-meta')).color));
    const metaOpacity = Number(await page.evaluate(() => getComputedStyle(document.getElementById('tourney-meta')).opacity));
    const rects = { name: await textRects(page, '#tourney-name'), sub: await textRects(page, '.tcover .th-sub'), meta: await textRects(page, '#tourney-meta') };
    await flag(page, 't-ghost', true);
    const c = { name: await backdropContrast(page, rects.name, text), sub: await backdropContrast(page, rects.sub, look), meta: await backdropContrast(page, rects.meta, meta, metaOpacity) };
    await flag(page, 't-ghost', false);
    check(c.name >= 4.5, `${theme}: the name reads on the picture — ${c.name.toFixed(2)}:1 (large text, needs 3; 4.5 asked)`);
    check(c.sub >= 4.5, `${theme}: the season line, in the tournament's colour, reads — ${c.sub.toFixed(2)}:1`);
    check(c.meta >= 4.5, `${theme}: the match count reads — ${c.meta.toFixed(2)}:1`);
  };
  await readable('dark');

  // the page wears the picture's colours, with real contrast
  const looks = async () => page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    const tab = document.querySelector('.tab-btn.active'), ind = document.getElementById('tab-indicator');
    return { look: v('--look'), ink: v('--look-ink'), a: v('--look-a'), b: v('--look-b'), panel: v('--panel'), accent: v('--accent'), live: v('--live'),
      tabInk: getComputedStyle(tab).color, tabBg: getComputedStyle(ind).backgroundColor, theme: document.documentElement.dataset.theme };
  });
  let L = await looks();
  check(hueGap(hexRgb(L.look), hexRgb(PALETTE[0])) < 12 && hueGap(hexRgb(L.b), hexRgb(PALETTE[1])) < 12, `dark: the page in the picture's own colours (${L.look} from ${PALETTE[0]}, glow ${L.b} from ${PALETTE[1]})`);
  check(contrast(hexRgb(L.look), hexRgb(L.panel)) >= 4.5 && contrast(hexRgb(L.ink), hexRgb(L.look)) >= 4.5,
    `dark: in that colour, words read on a card (${contrast(hexRgb(L.look), hexRgb(L.panel)).toFixed(2)}:1) and the tab label on it (${contrast(hexRgb(L.ink), hexRgb(L.look)).toFixed(2)}:1)`);
  check(cssRgb(L.tabBg).join() === hexRgb(L.look).join() && cssRgb(L.tabInk).join() === hexRgb(L.ink).join(), 'dark: the active tab wears it');
  check(L.accent === '#22c55e' && L.live === '#ef4444', 'dark: won / live keep the portal\'s green and red');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await page.screenshot({ path: path.join(OUT, 'tournament-cover-dark.png') });

  /* ---- the theme switch ---- */
  console.log('\n=== laptop 1440, switched to light ===');
  await page.click('#theme-toggle');
  await page.waitForTimeout(400);
  const darkLook = L.look;
  L = await looks();
  check(L.theme === 'light' && L.look !== darkLook && hueGap(hexRgb(L.look), hexRgb(PALETTE[0])) < 12, `the switch brings the light shade of the same colour (${darkLook} → ${L.look})`);
  check(contrast(hexRgb(L.look), hexRgb(L.panel)) >= 4.5 && contrast(hexRgb(L.ink), hexRgb(L.look)) >= 4.5,
    `light: words in it read on a card (${contrast(hexRgb(L.look), hexRgb(L.panel)).toFixed(2)}:1), the tab label on it (${contrast(hexRgb(L.ink), hexRgb(L.look)).toFixed(2)}:1)`);
  check(L.accent === '#128a4a' && L.live === '#d92b2b', 'light: won / live keep the portal\'s green and red');
  shaded = await page.screenshot({ clip: away });
  await flag(page, 't-no-shade', true);
  bare = await page.screenshot({ clip: away });
  await flag(page, 't-no-shade', false);
  d = await meanDiff(shaded, bare);
  check(d < 1, `light: the picture is just as vivid right of the words (${d.toFixed(2)}/255)`);
  await readable('light');
  await page.screenshot({ path: path.join(OUT, 'tournament-cover-light.png') });

  /* ---- the quiet re-draw ---- */
  console.log('\n=== the 20 s re-draw ===');
  await page.evaluate(() => { document.querySelector('.tcover-media > img').dataset.mark = 'kept'; });
  const seen = state.pictures;
  state.data = fixture({ info: Object.assign({}, fixture().info, { city: 'Mumbai' }) });
  await quietRedraw(page);
  let after = await page.evaluate(() => ({ mark: (document.querySelector('.tcover-media > img') || {}).dataset, isNew: document.querySelector('.tcover').classList.contains('is-new'), facts: document.querySelector('.tcover .th-facts').textContent }));
  check(after.mark && after.mark.mark === 'kept' && !after.isNew && state.pictures === seen, 'the same picture stays on screen — not reloaded, no entrance again');
  check(/Mumbai/.test(after.facts) && !/Navi Mumbai/.test(after.facts), 'the words on it are the new ones');
  const anims = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('.tcover')).length);
  check(anims === 0, `nothing in it moves once it is up (${anims} running animations)`);
  state.data = fixture({ thumb: Object.assign({}, fixture().thumb, { y: 70 }) });
  await quietRedraw(page);
  after = await page.evaluate(() => { const i = document.querySelector('.tcover-media > img'); return { mark: i.dataset.mark, pos: getComputedStyle(i).objectPosition, n: document.querySelectorAll('.tcover-media > *').length }; });
  check(after.mark === undefined && after.pos === '50% 70%' && after.n === 1, `the owner moved the crop: the picture follows (${after.pos})`);
  state.data = fixture({ thumb: Object.assign({}, fixture().thumb, { url: PIC.replace('0123', '9999') }) });
  await quietRedraw(page);
  after = await page.evaluate(() => ({ src: document.querySelector('.tcover-media > img').src, n: document.querySelectorAll('.tcover-media > *').length }));
  check(after.src === PIC.replace('0123', '9999') && after.n === 1, 'a new picture replaces it');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();

  /* ================= no picture: the card's poster ================= */
  console.log('\n=== no picture: the poster ===');
  ({ ctx, page, errors } = await openPage(browser, { width: 1440, height: 900, theme: 'dark', data: fixture({ thumb: null }) }));
  let poster = await page.evaluate(() => {
    const art = document.querySelector('.tcover-media > .tc-art');
    return art && { cls: art.className, a: art.style.getPropertyValue('--a'), want: tournamentPalette('TOK')[0], mono: getComputedStyle(art.querySelector('.tc-art-mono')).display,
      copy: getComputedStyle(art.querySelector('.tc-art-copy')).display, look: getComputedStyle(document.documentElement).getPropertyValue('--look').trim(), img: !!document.querySelector('.tcover-media img') };
  });
  check(!!poster && /tc-art--cricket/.test(poster.cls) && !poster.img, 'the homepage card\'s poster: its sport\'s ground');
  check(!!poster && poster.a === poster.want && hueGap(hexRgb(poster.look), cssRgb(poster.want)) < 12, `… in its own colours, and the page in the same ones (${poster.want} → ${poster.look})`);
  check(!!poster && poster.mono === 'none' && poster.copy === 'none', 'on a laptop its crest and its words stay off — the name is right there');
  await page.screenshot({ path: path.join(OUT, 'tournament-cover-poster-dark.png') });
  await ctx.close();

  console.log('\n=== a picture that cannot load ===');
  ({ ctx, page, state, errors } = await openPage(browser, { width: 1440, height: 900, theme: 'light', data: fixture(), picture: 'gone' }));
  poster = await page.evaluate(() => ({ art: !!document.querySelector('.tcover-media > .tc-art'), img: !!document.querySelector('.tcover-media img') }));
  check(poster.art && !poster.img, 'the poster takes its place — never a broken picture');
  state.data = fixture({ info: Object.assign({}, fixture().info, { city: 'Mumbai' }) });
  await quietRedraw(page);
  poster = await page.evaluate(() => ({ art: !!document.querySelector('.tcover-media > .tc-art'), img: !!document.querySelector('.tcover-media img'), n: document.querySelectorAll('.tcover-media > *').length }));
  check(poster.art && !poster.img && poster.n === 1, '… and stays through the quiet re-draw');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();

  /* ================= what the database says is text ================= */
  console.log('\n=== safety ===');
  const evilName = '<img src=x onerror="window.__pwned=1">Cup " onmouseover="window.__pwned=2';
  for (const [what, url] of [['javascript:', 'javascript:window.__pwned=3'], ['plain http', 'http://cdn.asl.test/a.webp'], ['a quote in it', PIC + '" onerror="window.__pwned=4']]) {
    ({ ctx, page, errors } = await openPage(browser, { width: 1024, height: 768, theme: 'dark', data: fixture({ displayName: evilName, thumb: { url, x: 50, y: 50, palette: ['#ff0000'] } }) }));
    const s = await page.evaluate(() => ({ pwned: window.__pwned, h1: document.getElementById('tourney-name').textContent, inH1: document.querySelectorAll('#tourney-name *').length,
      label: document.querySelector('.tcover').getAttribute('aria-label'), img: !!document.querySelector('.tcover-media img'), art: !!document.querySelector('.tcover-media > .tc-art') }));
    check(s.pwned === undefined && s.h1 === evilName && s.inH1 === 0 && s.label === evilName, `${what} link: the name is shown as text, in the heading and its label`);
    check(!s.img && s.art, `${what} link: not loaded — the poster instead`);
    await ctx.close();
  }
  ({ ctx, page, errors } = await openPage(browser, { width: 1024, height: 768, theme: 'dark', data: fixture(), artJs: false }));
  const noArt = await page.evaluate(() => ({ name: document.getElementById('tourney-name').textContent, img: !!document.querySelector('.tcover-media > img'), look: getComputedStyle(document.documentElement).getPropertyValue('--look').trim(), tabs: document.querySelectorAll('.tab-btn').length }));
  check(noArt.name.startsWith('MCA') && noArt.img && noArt.tabs >= 3 && errors.length === 0, `/tournament-art.js missing: the page still works — picture, name, tabs (look falls back to ${noArt.look || 'the accent'})`);
  await ctx.close();

  /* ================= phones ================= */
  for (const [w, h, theme] of [[390, 844, 'dark'], [390, 844, 'light'], [320, 640, 'dark']]) {
    console.log(`\n=== phone ${w}, ${theme} ===`);
    ({ ctx, page, errors } = await openPage(browser, { width: w, height: h, theme, data: fixture() }));
    const ph = await page.evaluate(() => {
      const m = document.querySelector('.tcover-media').getBoundingClientRect(), t = document.getElementById('tourney-name').getBoundingClientRect();
      const out = [...document.querySelectorAll('.tcover-body *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.left < -0.5 || r.right > document.documentElement.clientWidth + 0.5); }).map((el) => el.className || el.tagName);
      return { mx: m.left, mw: m.width, mh: m.height, mb: m.bottom, tt: t.top, tl: t.left, tw: t.width, vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, out };
    });
    check(ph.mx === 0 && Math.abs(ph.mw - ph.vw) < 1 && Math.abs(ph.mh - ph.mw * 9 / 16) < 1.5, `the picture whole, edge to edge, 16:9 (${ph.mw} × ${ph.mh.toFixed(1)})`);
    check(ph.tt > ph.mb - 50 && ph.tl >= 10, `the name under it (its top ${Math.round(ph.tt)}, the picture ends at ${Math.round(ph.mb)})`);
    check(ph.tw >= ph.vw - 30, `… across the whole width, not squeezed into a laptop's column (${Math.round(ph.tw)} of ${ph.vw})`);
    check(ph.sw <= ph.vw && ph.out.length === 0, `nothing leaves the screen sideways (${ph.sw} ≤ ${ph.vw}${ph.out.length ? '; out: ' + ph.out.join(', ') : ''})`);
    if (w === 390) {
      const text = cssRgb(await page.evaluate(() => getComputedStyle(document.getElementById('tourney-name')).color));
      const rects = await textRects(page, '#tourney-name');
      await flag(page, 't-ghost', true);
      const c = await backdropContrast(page, rects, text);
      await flag(page, 't-ghost', false);
      check(c >= 4.5, `the name reads where it meets the picture — ${c.toFixed(2)}:1`);
      await page.screenshot({ path: path.join(OUT, `tournament-cover-phone-${theme}.png`) });
    }
    check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
    await ctx.close();
  }
  ({ ctx, page, errors } = await openPage(browser, { width: 390, height: 844, theme: 'dark', data: fixture({ thumb: null }) }));
  poster = await page.evaluate(() => ({ mono: getComputedStyle(document.querySelector('.tcover-media .tc-art-mono')).display, copy: getComputedStyle(document.querySelector('.tcover-media .tc-art-copy')).display }));
  check(poster.mono === 'grid' && poster.copy === 'none', 'phone, no picture: the poster shows its crest (the words are under it)');
  await ctx.close();

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
