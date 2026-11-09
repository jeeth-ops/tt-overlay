// 🎛️ The Highlight Studio page (highlight-studio.html + highlight-thumbs.js),
// in a real browser against the REAL server (in-memory MongoDB, the firebase
// stub's tokens) and real clips:
//
// - signed out: the sign-in gate, nothing of the match;
// - the library: 300+ clips as a virtual list (a few dozen rows in the page,
//   never hundreds), the filters (event, team, player, innings, search),
//   select / range-select / select all shown, a clip still uploading not
//   selectable, an on-demand preview (no video until asked);
// - the timeline: the clips in the order picked, reordered with the arrows
//   and by dragging the grip, the engine's own lengths (title card + clips +
//   end card), the project's counts;
// - the render: a real job — its real stages on the dashboard, 100% only once
//   ready, the video downloadable with the clips in the timeline's order;
//   a refresh mid-render picks the same job back up; cancel;
// - the thumbnails: both modes, three designs each, both shapes — the frames
//   from the clip (sharpest first) or an uploaded photo, the QA shown, the
//   downloads at full size with their proper names, kept after a reload;
// - a phone: the three tabs, nothing wider than the screen;
// - no page errors anywhere.
//
//   node test/highlight-studio-ui.test.js        (SHOTS=dir to keep screenshots)
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-studio-ui-'));
process.env.TMPDIR = TMP;
process.env.HIGHLIGHT_PARALLEL = '2';
const { chromium } = require('playwright');
const { bootServer } = require('./server-boot.js');
const F = require('./merge-fixtures.js');
const { studioFixtures, colourAt, probeFile, MATCH } = require('./highlight-studio-fixtures.js');
const SHOTS = process.env.SHOTS || '';

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 600) : '')); }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const jpegSize = (buf) => { // the frame size in a JPEG's SOF marker
  for(let i = 2; i < buf.length - 9;){
    if(buf[i] !== 0xff){ i++; continue; }
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if(m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
};

(async () => {
  const fx = await studioFixtures(TMP, { extra: 320 });
  const { ids } = fx;
  const { port } = await bootServer({ idTokens: fx.tokens, users: F.EMAIL_OF, seed: fx.seed });
  const URL0 = `http://127.0.0.1:${port}/highlight-studio?matchId=${MATCH}`;
  const browser = await chromium.launch();
  const errors = [];
  async function newPage(opts){
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }, opts || {}));
    await ctx.route(/gstatic\.com/, r => r.abort());          // no Firebase SDK offline: the test signs in with a token
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if(m.type() === 'error' && !/gstatic|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    return { ctx, page };
  }
  const shot = async (page, name) => { if(SHOTS){ fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };

  console.log('\n=== Signed out ===');
  let { ctx, page } = await newPage();
  await page.goto(URL0);
  await page.waitForSelector('#gate:not(.hidden)');
  ok('the sign-in gate, nothing of the match', await page.isVisible('#gate-title') && !(await page.isVisible('#wrap')) && /Sign in/.test(await page.textContent('#gate-title')));
  await ctx.close();

  console.log('\n=== The library ===');
  ({ ctx, page } = await newPage());
  await ctx.addInitScript(() => { window.__studioToken = 'work-token'; });
  await page.goto(URL0);
  await page.waitForSelector('#wrap:not(.hidden)');
  await page.waitForFunction(() => document.querySelectorAll('#lib .clip').length > 0);
  const total = 7 + 320;
  const search = async (q) => { await page.fill('#f-q', q); await page.waitForTimeout(260); };
  ok('every visible clip of the match is in the library (not the commentary-only one, not another match\'s)', (await page.textContent('#lib-count')).includes(`${total} of ${total}`), await page.textContent('#lib-count'));
  let rows = await page.$$eval('#lib .clip', els => els.length);
  ok('… as a virtual list: a few dozen rows in the page, not hundreds', rows > 5 && rows < 40, rows);
  ok('… posters load lazily', await page.$$eval('#lib .clip img', els => els.every(i => i.loading === 'lazy')));
  await page.$eval('#lib', el => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => [...document.querySelectorAll('#lib .clip .num')].some(n => /#327\b/.test(n.textContent)));
  rows = await page.$$eval('#lib .clip', els => els.length);
  ok('scrolled to the end: the last clip is there, still only a few dozen rows', rows < 40, rows);
  await page.$eval('#lib', el => { el.scrollTop = 0; });
  await page.click('#f-ev .chip[data-v="SIX"]');
  const sixes = fx.clips.filter(c => c.matchId === MATCH && c.isHighlight !== false && c.eventType === 'SIX').length;
  ok('filter: sixes', (await page.textContent('#lib-count')).startsWith(`${sixes} of`), [await page.textContent('#lib-count'), sixes]);
  await page.click('#f-ev .chip[data-v=""]');
  await search('Rohit');
  await page.waitForFunction(() => /^1 of/.test(document.querySelector('#lib-count').textContent));
  ok('search: a player\'s name (the wicket of Rohit Patil)', (await page.textContent('#lib .clip .l2')).includes('Rohit Patil'));
  await search('');
  await page.selectOption('#f-inn', '2');
  ok('filter: the second innings', (await page.textContent('#lib-count')).startsWith(`${1 + 320} of`), await page.textContent('#lib-count'));
  await page.selectOption('#f-inn', '');
  await page.selectOption('#f-player', F.pk('Sai Kumar'));
  ok('filter: a fielder\'s clips', (await page.textContent('#lib-count')).startsWith('1 of'), await page.textContent('#lib-count'));
  await page.selectOption('#f-player', '');
  await page.waitForFunction(() => /^327 of/.test(document.querySelector('#lib-count').textContent));
  // pick: blue, red, yellow (2nd innings, so search it), green — the operator's order
  const pickByOver = async (ob) => { await search(ob); await page.waitForFunction((o) => [...document.querySelectorAll('#lib .clip .ob')].some(x => x.textContent === o), ob); await page.click(`#lib .clip:has(.ob:text-is("${ob}"))`); };
  await pickByOver('5.1'); await pickByOver('1.2');
  ok('two clips, both Harsh Mendon\'s: the video is about him (picked from the clips — his name on the title card)',
    (await page.$eval('#subject', x => x.value)) === `player:${F.pk('Harsh Mendon')}` && await page.isVisible('#subject-auto'), await page.$eval('#subject', x => x.value));
  await pickByOver('2.2');
  ok('… and with another player\'s wicket among them: the whole match', (await page.$eval('#subject', x => x.value)) === 'full');
  await pickByOver('3.4');
  await search('');
  const tlOrder = () => page.$$eval('#tl li[data-id]', els => els.map(e => e.dataset.id));
  ok('the timeline: in the order they were picked', JSON.stringify(await tlOrder()) === JSON.stringify(['blue', 'red', 'yellow', 'green'].map(n => ids[n])));
  ok('… numbered in the library too', await page.$eval(`#lib .clip:has(.ob:text-is("5.1")) .order`, e => e.textContent) === '1');
  await shot(page, 'studio-desktop');

  console.log('\n=== The timeline and the project ===');
  await page.click(`#tl li[data-id="${ids.green}"] [data-up]`);
  ok('↑ moves a clip earlier', JSON.stringify(await tlOrder()) === JSON.stringify(['blue', 'red', 'green', 'yellow'].map(n => ids[n])));
  // drag yellow's grip above blue
  const grip = await page.$(`#tl li[data-id="${ids.yellow}"] [data-grip]`), first = await page.$(`#tl li[data-id="${ids.blue}"]`);
  const g = await grip.boundingBox(), f0 = await first.boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, f0.y + 4, { steps: 8 }); await page.mouse.up();
  ok('dragging the grip reorders', JSON.stringify(await tlOrder()) === JSON.stringify(['yellow', 'blue', 'red', 'green'].map(n => ids[n])), await tlOrder());
  await page.click(`#tl li[data-id="${ids.yellow}"] [data-down]`);
  const ORDER = ['blue', 'yellow', 'red', 'green'];
  ok('↓ moves it back down', JSON.stringify(await tlOrder()) === JSON.stringify(ORDER.map(n => ids[n])));
  const summary = await page.evaluate(() => ['s-n', 's-six', 's-four', 's-wkt', 's-src', 's-est'].map(id => document.getElementById(id).textContent));
  ok('the project: 4 clips — 2 sixes, 1 four, 1 wicket; 13 s of footage, ≈ 19 s of video (the 4.8 s opening + clips cut to the grid + the 3.2 s end card)',
    JSON.stringify(summary) === JSON.stringify(['4', '2', '1', '1', '13s', '≈ 19s']), summary);
  ok('the strip: title card, the four clips, end card', await page.$$eval('#strip > div', els => els.map(e => e.className).join(',')) === 'in,SIX,WICKET,SIX,FOUR,out');

  console.log('\n=== Render ===');
  await page.click('#fmt button[data-v="16:9"]');
  await page.click('#render');
  await page.waitForSelector('#dash:not(.hidden)');
  ok('render: the button is off while it runs (no second submission)', await page.isDisabled('#render'));
  // refresh mid-render: the same job comes back
  await page.waitForFunction(() => /Rendering|Collecting|Validating|Preparing/.test(document.querySelector('#d-stages').textContent));
  const jobBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('asl-studio:m-studio-1')).job.jobId);
  await page.reload();
  await page.waitForSelector('#dash:not(.hidden)');
  const jobAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('asl-studio:m-studio-1')).job.jobId);
  ok('a refresh mid-render picks the same job back up (and the timeline is still there)', jobBefore === jobAfter && JSON.stringify(await tlOrder()) === JSON.stringify(ORDER.map(n => ids[n])));
  let sawPct = [], sawActive = false;
  for(const end = Date.now() + 180000; Date.now() < end;){
    const st = await page.evaluate(() => ({ pct: document.querySelector('#d-pct').textContent, active: document.querySelectorAll('#d-stages li.active').length, done: document.querySelectorAll('#d-stages li.done').length, ready: !!document.querySelector('#d-result .okbox') }));
    sawPct.push(st.pct); if(st.active) sawActive = true;
    if(st.ready) break;
    await wait(150);
  }
  ok('the dashboard showed stages running, then all done', sawActive && await page.$$eval('#d-stages li', els => els.every(e => e.classList.contains('done'))));
  ok('never 100% before it was ready', !sawPct.slice(0, -1).includes('100%') && (await page.textContent('#d-pct')) === '100%', sawPct.slice(-5));
  ok('ready: every clip included, and the elapsed time shown', /4 clips, every one included/.test(await page.textContent('#d-result')) && /elapsed/.test(await page.textContent('#d-time')));
  const href = await page.getAttribute('#d-result a.btn.primary', 'href');
  const dl = await page.evaluate(async (h) => { const r = await fetch(h); const b = await r.arrayBuffer(); return { status: r.status, type: r.headers.get('content-type'), bytes: Array.from(new Uint8Array(b)) }; }, href);
  const out = path.join(TMP, 'studio.mp4');
  fs.writeFileSync(out, Buffer.from(dl.bytes));
  const info = probeFile(out);
  ok('the video downloads: an MP4 with picture and sound', dl.status === 200 && dl.type === 'video/mp4' && info.w === 1280 && info.audio, [dl.status, dl.type, info]);
  const seg = 80 / 30, intro = 144 / 30;   // each 3.2 s clip and the opening, in frames at 30 fps
  const seen = ORDER.map((n, i) => colourAt(out, intro + seg * i + seg / 2, 1280, 720));
  ok('… with the clips in the timeline\'s order (blue, yellow, red, green)', JSON.stringify(seen) === JSON.stringify(ORDER), seen);
  ok('the project says it is ready; the render is in Recent renders', (await page.textContent('#s-status')) === 'Ready to download' && /Download/.test(await page.textContent('#recent')));
  await shot(page, 'studio-ready');

  console.log('\n=== Cancel ===');
  await page.click('#fmt button[data-v="9:16"]');
  await page.click('#render');
  await page.waitForFunction(() => !document.querySelector('#d-cancel').classList.contains('hidden'));
  await page.click('#d-cancel');
  await page.waitForFunction(() => /Cancelled/.test(document.querySelector('#d-msg').textContent), null, { timeout: 30000 });
  ok('cancelled: says so, and a new render can start', /Cancelled/.test(await page.textContent('#d-result')) && !(await page.isDisabled('#render')));

  console.log('\n=== Thumbnails ===');
  await page.click('#fmt button[data-v="16:9"]');
  ok('the right column shows one pane at a time: timeline & export now, the thumbnails behind their switch', await page.isVisible('#render') && !(await page.isVisible('#vars')));
  await page.selectOption('#subject', `player:${F.pk('Harsh Mendon')}`);
  await page.click('#panes button[data-p="thumbs"]');
  // (the title card's words for him come from the server: the thumbnails follow)
  await page.waitForFunction(() => [...document.querySelectorAll('#hl-pick option')].some(o => o.textContent === '64 OFF 34'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#frames .frame img').length === 6, null, { timeout: 60000 });
  ok('with player photo: six stills from a clip of his, the sharpest first and picked', await page.$$eval('#frames .frame', els => els.findIndex(e => e.classList.contains('on'))) === 0);
  await page.waitForFunction(() => document.querySelectorAll('#vars .var').length === 3);
  ok('three designs, named', JSON.stringify(await page.$$eval('#vars .var b', els => els.map(e => e.textContent))) === JSON.stringify(['Variation 1 – Cinematic Player Poster', 'Variation 2 – Dynamic Action', 'Variation 3 – Premium Broadcast']));
  const pv = await page.evaluate(() => [document.getElementById('pv-l'), document.getElementById('pv-p')].map(c => [c.width, c.height]));
  ok('both shapes previewed (16:9 and 9:16)', JSON.stringify(pv) === JSON.stringify([[960, 540], [540, 960]]), pv);
  ok('the checks are shown, all passed', /1920 x 1080/.test(await page.textContent('#qa-l')) && !(await page.$('#qa-l .error')) && !(await page.$('#qa-p .error')));
  ok('the headline from what the clips are, and his figures among the suggestions; a new subject gets its own headline', (await page.$$eval('#hl-pick option', o => o.map(x => x.textContent))).includes('64 OFF 34') && (await page.$eval('#hl-pick', s => s.value)) === 'BATTING HIGHLIGHTS', [await page.$eval('#hl-pick', s => s.value), await page.$$eval('#hl-pick option', o => o.map(x => x.textContent))]);
  await page.click('#vars .var[data-v="2"]');
  await page.waitForFunction(() => document.querySelector('#vars .var[data-v="2"]').classList.contains('on'));
  ok('pick Variation 2: selected', await page.$eval('#vars .var[data-v="2"]', e => e.classList.contains('on')) && /Variation 2 – Dynamic Action/.test(await page.textContent('#pv-l-name')));
  await page.fill('#hl-text', 'Power hitting');
  await page.waitForTimeout(100);
  let [d1] = await Promise.all([page.waitForEvent('download'), page.click('#dl-l')]);
  let buf = fs.readFileSync(await d1.path());
  ok('download 16:9: AllSportsLive_HarshMendon_WithPhoto_Variation2_16x9.jpg, a 1920 x 1080 JPEG', d1.suggestedFilename() === 'AllSportsLive_HarshMendon_WithPhoto_Variation2_16x9.jpg' && JSON.stringify(jpegSize(buf)) === JSON.stringify({ h: 1080, w: 1920 }), [d1.suggestedFilename(), jpegSize(buf)]);
  [d1] = await Promise.all([page.waitForEvent('download'), page.click('#dl-p')]);
  buf = fs.readFileSync(await d1.path());
  ok('download 9:16: …_Variation2_9x16.jpg, 1080 x 1920', d1.suggestedFilename() === 'AllSportsLive_HarshMendon_WithPhoto_Variation2_9x16.jpg' && JSON.stringify(jpegSize(buf)) === JSON.stringify({ h: 1920, w: 1080 }), [d1.suggestedFilename(), jpegSize(buf)]);
  await page.click('.mode[data-mode="graphic"]');
  await page.waitForFunction(() => /Cinematic Stadium/.test(document.querySelector('#vars').textContent));
  ok('without player photo: its own three designs', JSON.stringify(await page.$$eval('#vars .var b', els => els.map(e => e.textContent))) === JSON.stringify(['Variation 1 – Cinematic Stadium', 'Variation 2 – Dynamic Cricket Graphic', 'Variation 3 – Premium Minimal']));
  ok('… and its check: no photo, no person', /no photo, no person, no silhouette/.test(await page.textContent('#qa-l')) && !(await page.isVisible('#photo-tools')));
  await page.click('#vars .var[data-v="3"]');
  await page.waitForFunction(() => document.querySelector('#vars .var[data-v="3"]').classList.contains('on'));
  [d1] = await Promise.all([page.waitForEvent('download'), page.click('#dl-l')]);
  ok('download: …_NoPhoto_Variation3_16x9.jpg', d1.suggestedFilename() === 'AllSportsLive_HarshMendon_NoPhoto_Variation3_16x9.jpg', d1.suggestedFilename());
  await page.click('#auto');
  await page.waitForFunction(() => !!document.querySelector('#vars .var .auto'));
  ok('Auto select: a choice, with the reason, and the operator still picks', /Auto: /.test(await page.textContent('#auto-why')) && !!(await page.$('#vars .var .auto')));
  // the six designs look different from each other (not one template recoloured): their pictures differ a lot
  const diffs = await page.evaluate(async () => {
    const T = window.HighlightThumbs, cs = [];
    const d = { subject: 'player', first: 'Harsh', last: 'Mendon', headline: '2 SIXES', kicker: 'X', line: 'A vs B', stats: [{ value: '64', label: 'RUNS' }], kind: 'SIX', teams: [{ name: 'GSC', short: 'GSC', color: '#1e40af', logo: null }] };
    const img = await T.prepareImage(document.querySelector('#frames .frame img').src);
    for(const mode of ['photo', 'graphic']) for(const v of [1, 2, 3]){
      const c = T.render({ mode, variation: v, format: '16:9', data: d, photo: Object.assign(img, { focusX: 0.5, focusY: 0.5, zoom: 1 }), seed: 1, scale: 0.1 }).canvas;
      cs.push(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
    }
    const out = [];
    for(let a = 0; a < cs.length; a++) for(let b = a + 1; b < cs.length; b++){ let s = 0; for(let i = 0; i < cs[a].length; i += 4) s += Math.abs(cs[a][i] - cs[b][i]) + Math.abs(cs[a][i + 1] - cs[b][i + 1]) + Math.abs(cs[a][i + 2] - cs[b][i + 2]); out.push(s / (cs[a].length / 4) / 3); }
    return out;
  });
  ok('the six designs are each unlike the others (mean pixel difference > 20 of 255 for every pair)', diffs.every(x => x > 20), diffs.map(x => Math.round(x)));
  // an uploaded photo
  const upl = path.join(TMP, 'upload.jpg');
  require('child_process').spawnSync(fx.ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080', '-frames:v', '1', upl]);
  await page.setInputFiles('#upload', upl);
  await page.waitForFunction(() => document.querySelector('.mode[data-mode="photo"]').classList.contains('on'));
  ok('upload a photo: the photo mode uses it (no frame picked)', !(await page.$('#frames .frame.on')));
  await shot(page, 'studio-thumbs');
  // reload: the thumbnails, the choices and the photo are still here
  await page.reload();
  await page.waitForSelector('#wrap:not(.hidden)');
  await page.click('#panes button[data-p="thumbs"]');
  await page.waitForFunction(() => document.querySelectorAll('#saved .it').length >= 3);
  ok('after a reload: the saved thumbnails are still here (this device)', (await page.$$eval('#saved .it', els => els.length)) === 3);
  ok('… and each is kept on the server too', (await page.$$eval('#saved .it .badge-srv', els => els.length)) === 3);
  ok('… and the project too (the timeline, the subject)', JSON.stringify(await tlOrder()) === JSON.stringify(ORDER.map(n => ids[n])) && (await page.$eval('#subject', s => s.value)) === `player:${F.pk('Harsh Mendon')}`);
  await ctx.close();

  // another device (a fresh browser: nothing stored locally): the server's copies
  ({ ctx, page } = await newPage());
  await ctx.addInitScript(() => { window.__studioToken = 'work-token'; });
  await page.goto(URL0);
  await page.waitForSelector('#wrap:not(.hidden)');
  await page.click('#panes button[data-p="thumbs"]');
  await page.waitForFunction(() => document.querySelectorAll('#saved .it').length >= 3);
  ok('on another device: the three thumbnails, from the server', (await page.$$eval('#saved .it .badge-srv', els => els.length)) === 3 && (await page.$$eval('#saved .it .badge-dev', els => els.length)) === 0);
  const [d2] = await Promise.all([page.waitForEvent('download'), page.click('#saved .it [data-dl]')]);
  const b2 = fs.readFileSync(await d2.path());
  ok('… and they download whole from there (a full-size JPEG, its own name)', /^AllSportsLive_.*_(16x9|9x16)\.jpg$/.test(d2.suggestedFilename()) && !!jpegSize(b2) && [1920, 1080].includes(jpegSize(b2).w), [d2.suggestedFilename(), jpegSize(b2)]);
  await ctx.close();

  console.log('\n=== A phone ===');
  ({ ctx, page } = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }));
  await ctx.addInitScript(() => { window.__studioToken = 'work-token'; });
  await page.goto(URL0);
  await page.waitForSelector('#wrap:not(.hidden)');
  ok('three tabs', await page.isVisible('#tabs') && (await page.$$eval('.tab', t => t.length)) === 3);
  const wide = async () => page.evaluate(() => document.documentElement.scrollWidth);
  ok('the library tab: nothing wider than the screen', await wide() <= 390, await wide());
  await shot(page, 'studio-phone-library');
  await page.click('.tab[data-tab="timeline"]');
  ok('the timeline tab: nothing wider than the screen', await wide() <= 390, await wide());
  await page.click('.tab[data-tab="thumbs"]');
  await page.waitForTimeout(500);
  ok('the thumbnails tab: nothing wider than the screen', await wide() <= 390, await wide());
  await shot(page, 'studio-phone-thumbs');
  await ctx.close();

  ok('no page errors', errors.length === 0, errors);
  await browser.close();
  fx.clipServer.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {} process.exit(1); });
