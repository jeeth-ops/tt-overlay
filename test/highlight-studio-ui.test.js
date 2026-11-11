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
// - the studio's shell: every section opens and closes (one at a time, the
//   sidebar's indicator on it), the inspector follows the section, the
//   player opens and closes and lets go of its video, the 16:9 / 9:16
//   preview switch never stretches a picture;
// - big projects: 300+ clips selected, reversed, scrolled — timed, rows kept
//   (not rebuilt), the order right; a clip dragged onto the sequence track,
//   a block dragged along it;
// - panels opened and closed again and again, a long session: the page's
//   DOM nodes, listeners and memory stay put;
// - the studio while a render runs: still answers at once;
// - 1366 x 768, 1600 x 900, 1920 x 1080 and resizing between them: nothing
//   cut off, nothing overlapping, no sideways scroll;
// - a phone: the sections in a bottom bar, nothing wider than the screen;
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
const { studioFixtures, colourAt, probeFile, MATCH, MATCH2 } = require('./highlight-studio-fixtures.js');
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
  const fx = await studioFixtures(TMP, { extra: 320, tournament: true });
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
  const nav = async (page, sec) => { await page.click(`.nav[data-sec="${sec}"]`); await page.waitForFunction((s) => document.querySelector(`.sec[data-sec="${s}"]`).classList.contains('on'), sec); };
  const frameTime = (page, fn) => page.evaluate(async (src) => {   // a click's cost: its handler and the frame after it
    const t0 = performance.now(); (0, eval)(src)();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round(performance.now() - t0);
  }, fn.toString());
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
    (await page.$eval('#subject', x => x.value)) === `player:${F.pk('Harsh Mendon')}` && !(await page.$eval('#subject-auto', e => e.classList.contains('hidden'))), await page.$eval('#subject', x => x.value));
  await pickByOver('2.2');
  ok('… and with another player\'s wicket among them: the whole match', (await page.$eval('#subject', x => x.value)) === 'full');
  await pickByOver('3.4');
  await search('');
  const tlOrder = () => page.$$eval('#tl li[data-id]', els => els.map(e => e.dataset.id));
  ok('the timeline: in the order they were picked', JSON.stringify(await tlOrder()) === JSON.stringify(['blue', 'red', 'yellow', 'green'].map(n => ids[n])));
  ok('… numbered in the library too', await page.$eval(`#lib .clip:has(.ob:text-is("5.1")) .order`, e => e.textContent) === '1');
  await shot(page, 'studio-desktop');

  // a row in the timeline is kept, not rebuilt, when the order changes (FLIP moves it)
  await page.evaluate((id) => { window.__row = document.querySelector(`#tl li[data-id="${id}"]`); }, ids.red);
  console.log('\n=== The timeline and the project ===');
  await nav(page, 'timeline');
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
  ok('… the rows were moved, never rebuilt (the same element after three reorders)', await page.evaluate((id) => window.__row === document.querySelector(`#tl li[data-id="${id}"]`) && window.__row.isConnected, ids.red));
  ok('each row says when it starts in the video (after the opening)', (await page.$eval(`#tl li[data-id="${ids.blue}"] .at`, e => e.textContent)) === '0:04');
  ok('the sequence track: title, the four blocks in order, end', JSON.stringify(await page.$$eval('#blocks > .blk', els => els.map(e => e.dataset.id || e.className.split(' ').pop()))) === JSON.stringify(['in', ...ORDER.map(n => ids[n]), 'out']));
  const summary = await page.evaluate(() => ['s-n', 's-six', 's-four', 's-wkt', 's-src', 's-est'].map(id => document.getElementById(id).textContent));
  ok('the project: 4 clips — 2 sixes, 1 four, 1 wicket; 13 s of footage, ≈ 19 s of video (the 4.8 s opening + clips cut to the grid + the 3.2 s end card)',
    JSON.stringify(summary) === JSON.stringify(['4', '2', '1', '1', '13s', '≈ 19s']), summary);
  ok('the strip: title card, the four clips, end card', await page.$$eval('#strip > div', els => els.map(e => e.className).join(',')) === 'in,SIX,WICKET,SIX,FOUR,out');

  console.log('\n=== Render ===');
  await nav(page, 'export');
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
  ok('a refresh mid-render picks the same job back up (and the timeline is still there, the export centre open again)', jobBefore === jobAfter && JSON.stringify(await tlOrder()) === JSON.stringify(ORDER.map(n => ids[n])) && await page.isVisible('#render'));
  // the studio while the render runs: it still answers at once
  await page.waitForFunction(() => !document.getElementById('pane-live').classList.contains('hidden'));
  ok('while it renders: the header says so (and leads back to it)', /Rendering/.test(await page.textContent('#pane-live')) && await page.isVisible('#pane-live'));
  const busy = [];
  for (const sec of ['clips', 'timeline', 'thumbs', 'overview', 'export']) busy.push(await frameTime(page, `() => document.querySelector('.nav[data-sec="${sec}"]').click()`));
  await nav(page, 'clips');
  const pickOb = await page.$eval('#lib .clip:not(.sel):not(.na) .ob', e => e.textContent);
  const tSel = await frameTime(page, `() => document.querySelector('#lib .clip:not(.sel):not(.na) .meta').click()`);
  const five = (await tlOrder()).length;
  ok('… sections open and a clip is picked within a frame or two while the render runs', Math.max(...busy, tSel) < 120 && five === 5, { sections: busy, select: tSel, five });
  // put it back as it was (the render's own list is the job's, not the page's)
  await page.click(`#lib .clip.sel:has(.ob:text-is("${pickOb}")) .meta`);
  ok('… and the timeline is the four clips again', JSON.stringify(await tlOrder()) === JSON.stringify(ORDER.map(n => ids[n])), await tlOrder());
  await nav(page, 'export');
  let sawPct = [], sawActive = false, shotLive = false;
  for(const end = Date.now() + 180000; Date.now() < end;){
    const st = await page.evaluate(() => ({ pct: document.querySelector('#d-pct').textContent, active: document.querySelectorAll('#d-stages li.active').length, done: document.querySelectorAll('#d-stages li.done').length, ready: !!document.querySelector('#d-result .okbox') }));
    sawPct.push(st.pct); if(st.active) sawActive = true;
    if(st.active && st.done >= 4 && !shotLive){ shotLive = true; await shot(page, 'studio-rendering'); }
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
  ok('the project says it is ready; the render is in Completed Highlights', (await page.textContent('#s-status')) === 'Ready to download' && /Download/.test(await page.textContent('#recent')) && (await page.textContent('#nav-done')) === '1');
  // watch it in the page: the player streams it with byte ranges (it can be seeked)
  await page.click('#d-result [data-watch]');
  await page.waitForFunction(() => document.querySelector('#player').classList.contains('on'));
  const vsrc = await page.$eval('#pl-video', v => v.getAttribute('src'));
  const range = await page.evaluate(async (u) => { const r = await fetch(u, { headers: { Range: 'bytes=0-99' } }); return { status: r.status, len: (await r.arrayBuffer()).byteLength, type: r.headers.get('content-type') }; }, vsrc);
  ok('watch it here: the player opens with the video, served in ranges (206)', /inline=1/.test(vsrc) && range.status === 206 && range.len === 100 && /video\/mp4/.test(range.type), [vsrc, range]);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#player').classList.contains('hidden'));
  ok('… Esc closes it and lets go of the video', !(await page.$eval('#pl-video', v => v.hasAttribute('src'))));
  const again = await page.evaluate(async (h) => (await fetch(h)).status, href);
  ok('… and the video is still there to download after it was watched', again === 200);
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
  ok('one section at a time: the export centre now, the thumbnails not drawn behind it', await page.isVisible('#render') && !(await page.isVisible('#vars')) && (await page.$$eval('.sec.on', e => e.length)) === 1);
  await nav(page, 'intro');
  await page.selectOption('#subject', `player:${F.pk('Harsh Mendon')}`);
  await page.waitForFunction(() => /Mendon/.test(document.querySelector('#io-card').textContent), null, { timeout: 30000 });
  ok('intro & outro: the title card\'s words, from the server (his name, his figures)', /Harsh/.test(await page.textContent('#io-card .nm')) && /64/.test(await page.textContent('#io-card .sts')) && (await page.textContent('#io-in')) === '4.8 s');
  await nav(page, 'thumbs');
  // (the title card's words for him come from the server: the thumbnails follow)
  await page.waitForFunction(() => [...document.querySelectorAll('#hl-pick option')].some(o => o.textContent === '64 OFF 34'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#frames .frame img').length === 6, null, { timeout: 60000 });
  ok('with player photo: six stills from a clip of his, the sharpest first and picked', await page.$$eval('#frames .frame', els => els.findIndex(e => e.classList.contains('on'))) === 0);
  await page.waitForFunction(() => document.querySelectorAll('#vars .var').length === 3);
  ok('three designs, named', JSON.stringify(await page.$$eval('#vars .var b', els => els.map(e => e.textContent))) === JSON.stringify(['Variation 1 – Cinematic Player Poster', 'Variation 2 – Dynamic Action', 'Variation 3 – Premium Broadcast']));
  // the shape in view is drawn at once, the other one a frame later
  await page.waitForFunction(() => document.getElementById('pv-l').width === 960 && document.getElementById('pv-p').height === 960, null, { timeout: 5000 }).catch(() => {});
  const pv = await page.evaluate(() => [document.getElementById('pv-l'), document.getElementById('pv-p')].map(c => [c.width, c.height]));
  ok('both shapes previewed (16:9 and 9:16)', JSON.stringify(pv) === JSON.stringify([[960, 540], [540, 960]]), pv);
  // the shape switch: one at a time, crossfaded, never stretched
  const boxOf = (id) => page.$eval(id, c => { const r = c.getBoundingClientRect(); return { w: r.width, h: r.height, on: !c.classList.contains('off') }; });
  let L0 = await boxOf('#pv-l');
  await page.click('#pv-shape button[data-v="9:16"]');
  await page.waitForTimeout(450);
  let P0 = await boxOf('#pv-p'), L1 = await boxOf('#pv-l');
  ok('the 16:9 / 9:16 switch: one shown at a time, each at its own shape (never stretched)', L0.on && Math.abs(L0.w / L0.h - 16 / 9) < 0.02 && P0.on && !L1.on && Math.abs(P0.w / P0.h - 9 / 16) < 0.02 && (await page.isVisible('#qa-p')) && !(await page.isVisible('#qa-l')), [L0, P0, L1]);
  await page.click('#pv-shape button[data-v="16:9"]');
  ok('the checks are shown, all passed', /1920 x 1080/.test(await page.textContent('#qa-l')) && !(await page.$('#qa-l .error')) && !(await page.$('#qa-p .error')));
  ok('the headline from what the clips are, and his figures among the suggestions; a new subject gets its own headline', (await page.$$eval('#hl-pick option', o => o.map(x => x.textContent))).includes('64 OFF 34') && (await page.$eval('#hl-pick', s => s.value)) === 'BATTING HIGHLIGHTS', [await page.$eval('#hl-pick', s => s.value), await page.$$eval('#hl-pick option', o => o.map(x => x.textContent))]);
  await page.click('#vars .var[data-v="2"]');
  await page.waitForFunction(() => document.querySelector('#vars .var[data-v="2"]').classList.contains('on'));
  ok('pick Variation 2: selected', await page.$eval('#vars .var[data-v="2"]', e => e.classList.contains('on')) && /Variation 2 – Dynamic Action/.test(await page.textContent('#pv-l-name')));
  // every variation, both modes: the big preview follows at once (the old picture until the new one is drawn — never blank)
  const sample = () => page.evaluate(() => { const c = document.getElementById('pv-l'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0, lit = 0; for (let i = 0; i < d.length; i += 4 * 97) { s += d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7; if (d[i] + d[i + 1] + d[i + 2] > 30) lit++; } return { s, lit }; });
  const seenVar = [];
  for (const v of [1, 2, 3]) { const t = await frameTime(page, `() => document.querySelector('#vars .var[data-v="${v}"]').click()`); const sm = await sample(); seenVar.push({ v, t, name: (await page.textContent('#pv-l-name')).split('– ')[1], ...sm }); }
  ok('… all three variations: each its own picture, none blank, each drawn within a frame or two', new Set(seenVar.map(x => x.s)).size === 3 && seenVar.every(x => x.lit > 50) && seenVar.every(x => x.t < 200), seenVar);
  const engine = await page.evaluate(() => { const d = thumbData(), out = []; for (const f of ['16:9', '9:16']) { const t0 = performance.now(); HighlightThumbs.render({ mode: 'photo', variation: 1, format: f, data: d, photo: photoObj(), seed: 1, scale: 0.5 }); out.push(Math.round(performance.now() - t0)); } return out; });
  ok(`(the thumbnail engine draws a preview in ${engine.join(' / ')} ms — 16:9 / 9:16 at half size, its checks included)`, engine.every(x => x < 250), engine);
  await page.click('#vars .var[data-v="2"]');
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
  await nav(page, 'thumbs');
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
  await nav(page, 'thumbs');
  await page.waitForFunction(() => document.querySelectorAll('#saved .it').length >= 3);
  ok('on another device: the three thumbnails, from the server', (await page.$$eval('#saved .it .badge-srv', els => els.length)) === 3 && (await page.$$eval('#saved .it .badge-dev', els => els.length)) === 0);
  const [d2] = await Promise.all([page.waitForEvent('download'), page.click('#saved .it [data-dl]')]);
  const b2 = fs.readFileSync(await d2.path());
  ok('… and they download whole from there (a full-size JPEG, its own name)', /^AllSportsLive_.*_(16x9|9x16)\.jpg$/.test(d2.suggestedFilename()) && !!jpegSize(b2) && [1920, 1080].includes(jpegSize(b2).w), [d2.suggestedFilename(), jpegSize(b2)]);
  await ctx.close();

  console.log('\n=== The whole tournament: a player over every match of it ===');
  ({ ctx, page } = await newPage());
  await ctx.addInitScript(() => { window.__studioToken = 'work-token'; });
  await page.goto(URL0);
  await page.waitForSelector('#wrap:not(.hidden)');
  ok('a match of a tournament offers the whole tournament (this match chosen)', await page.isVisible('#scope-seg') && /Whole tournament · 2 matches/.test(await page.textContent('#scope-t')) && await page.$eval('#scope-seg [data-v="match"]', b => b.classList.contains('on')));
  await page.click('#scope-t');
  await page.waitForURL(/scope=tournament/);
  await page.waitForSelector('#wrap:not(.hidden)');
  await page.waitForFunction(() => document.querySelectorAll('#lib .clip').length > 0);
  const ttotal = total + 3;
  ok('the whole tournament: every match\'s clips in the library (this match\'s and the semi-final\'s), the tournament at the top', (await page.textContent('#lib-count')).includes(`${ttotal} of ${ttotal}`) && /MCA President Cup 2026 · whole tournament/.test(await page.textContent('#m-title')) && await page.$eval('#scope-t', b => b.classList.contains('on')), [await page.textContent('#lib-count'), await page.textContent('#m-title')]);
  await page.selectOption('#f-match', MATCH2);
  ok('… a match filter: the semi-final\'s three clips, each naming its match', (await page.textContent('#lib-count')).startsWith('3 of') && await page.$$eval('#lib .clip .l3', els => els.length === 3 && els.every(e => /GSC vs SPG · Semi-final/.test(e.textContent))), await page.textContent('#lib-count'));
  await page.click('#lib .clip:has(.ob:text-is("4.1")) .meta');                 // his SIX in the semi-final (green)
  await page.selectOption('#f-match', '');
  await search('5.1');
  await page.waitForFunction(() => [...document.querySelectorAll('#lib .clip .ob')].some(x => x.textContent === '5.1'));
  await page.click('#lib .clip:has(.ob:text-is("5.1")) .meta');                 // his SIX in the final (blue)
  await search('');
  ok('two SIXES of his, from two matches: the video is about him, in the order picked', (await page.$eval('#subject', x => x.value)) === `player:${F.pk('Harsh Mendon')}` && JSON.stringify(await tlOrder()) === JSON.stringify([ids['t2-six'], ids.blue]), await tlOrder());
  await nav(page, 'intro');
  await page.waitForFunction(() => /94/.test(document.querySelector('#io-card').textContent), null, { timeout: 30000 });
  ok('his title card: the tournament, his figures over both matches (94 off 54 balls), "2 MATCHES"', /MCA President Cup 2026/.test(await page.textContent('#io-card .k')) && /94/.test(await page.textContent('#io-card .sts')) && /54 BALLS/.test(await page.textContent('#io-card .sts')) && /2 MATCHES/.test(await page.textContent('#io-card .ln')),
    [await page.textContent('#io-card .k'), await page.textContent('#io-card .sts'), await page.textContent('#io-card .ln')]);
  await nav(page, 'thumbs');
  await page.waitForFunction(() => [...document.querySelectorAll('#hl-pick option')].some(o => o.textContent === '94 OFF 54'), null, { timeout: 30000 }).catch(() => {});
  ok('… the thumbnails say the same ("94 OFF 54" among the headlines)', (await page.$$eval('#hl-pick option', o => o.map(x => x.textContent))).includes('94 OFF 54'), await page.$$eval('#hl-pick option', o => o.map(x => x.textContent)));
  await nav(page, 'export');
  await page.click('#render');
  await page.waitForSelector('#dash:not(.hidden)');
  for(const end = Date.now() + 180000; Date.now() < end;){ if(await page.$('#d-result .okbox')) break; await wait(200); }
  const thref = await page.getAttribute('#d-result a.btn.primary', 'href');
  const tdl = await page.evaluate(async (h) => { const r = await fetch(h); const b = await r.arrayBuffer(); return { status: r.status, bytes: Array.from(new Uint8Array(b)) }; }, thref);
  const tout = path.join(TMP, 'studio-tournament.mp4');
  fs.writeFileSync(tout, Buffer.from(tdl.bytes));
  const tseen = [0, 1].map(i => colourAt(tout, 144 / 30 + (80 / 30) * i + 40 / 30, 1280, 720));
  ok('the tournament video: his SIX from the semi-final, then his SIX from the final', tdl.status === 200 && JSON.stringify(tseen) === JSON.stringify(['green', 'blue']), tseen);
  ok('… named for the tournament', /AllSportsLive_HarshMendon_Tournament_Highlights/.test(thref), thref);
  const projs = await page.evaluate((m) => [localStorage.getItem(`asl-studio:${m}:tournament`), localStorage.getItem(`asl-studio:${m}`)].map(x => JSON.parse(x || 'null')), MATCH);
  ok('the tournament is a project of its own (the match\'s own project is not touched)', !!projs[0] && projs[0].sel.length === 2 && (!projs[1] || projs[1].sel.length === 0), projs.map(p => p && p.sel));
  await nav(page, 'clips');
  await page.click('#scope-seg [data-v="match"]');
  await page.waitForURL((u) => !/scope=tournament/.test(String(u)));
  await page.waitForSelector('#wrap:not(.hidden)');
  await page.waitForFunction(() => document.querySelectorAll('#lib .clip').length > 0);
  ok('… and back to this match: its own clips again, its own (empty) timeline', (await page.textContent('#lib-count')).includes(`${total} of ${total}`) && !(await page.isVisible('#f-match')) && (await tlOrder()).length === 0, [await page.textContent('#lib-count'), await tlOrder()]);
  await ctx.close();

  console.log('\n=== Big projects, panels, memory (1366 x 768) ===');
  ({ ctx, page } = await newPage({ viewport: { width: 1366, height: 768 } }));
  await ctx.addInitScript(() => { window.__studioToken = 'work-token'; });
  await page.goto(URL0);
  await page.waitForSelector('#wrap:not(.hidden)');
  await page.waitForFunction(() => document.querySelectorAll('#lib .clip').length > 0);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => { await cdp.send('HeapProfiler.collectGarbage'); const m = (await cdp.send('Performance.getMetrics')).metrics; const g = (n) => (m.find(x => x.name === n) || {}).value; return { nodes: g('Nodes'), listeners: g('JSEventListeners'), heapMB: Math.round(g('JSHeapUsedSize') / 1e5) / 10 }; };
  const overflow = () => page.evaluate(() => {
    const out = [];
    if (document.documentElement.scrollWidth > innerWidth) out.push('page ' + document.documentElement.scrollWidth);
    const sec = document.querySelector('.sec.on'); if (sec && sec.scrollWidth > sec.clientWidth + 1) out.push(sec.dataset.sec + ' ' + sec.scrollWidth + '>' + sec.clientWidth);
    // the header's parts never overlap, and nothing in it is cut off
    const parts = ['.brand', '.hdr-proj', '#save-state', '#hdr-preview', '#hdr-export'].map(s => document.querySelector(s)).filter(e => e && e.offsetParent).map(e => e.getBoundingClientRect());
    for (let i = 1; i < parts.length; i++) if (parts[i].left < parts[i - 1].right - 0.5) out.push('header overlap ' + i);
    if (parts.some(r => r.right > innerWidth + 0.5)) out.push('header cut off');
    // every visible button of the section is inside the window
    for (const b of document.querySelectorAll('.sec.on .sec-h button, .sec.on .go-card button, #side .nav')) { const r = b.getBoundingClientRect(); if (b.offsetParent && (r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5)) out.push('cut off: ' + (b.id || b.textContent.trim().slice(0, 20))); }
    return out;
  });
  // every section opens, one at a time, with the indicator on it and the inspector following
  const SECS = ['overview', 'clips', 'timeline', 'graphics', 'intro', 'thumbs', 'export', 'renders'];
  const CTXS = { overview: 'teams', clips: 'clip', timeline: 'clip', graphics: 'teams', intro: 'teams', thumbs: 'thumb', export: 'render', renders: 'render' };
  const secTimes = [], secBad = [];
  for (const sec of SECS) {
    secTimes.push(await frameTime(page, `() => document.querySelector('.nav[data-sec="${sec}"]').click()`));
    await page.waitForTimeout(380);
    const st = await page.evaluate((s) => {
      const on = [...document.querySelectorAll('.sec')].filter(x => x.offsetParent).map(x => x.dataset.sec);
      const b = document.querySelector(`.nav[data-sec="${s}"]`), ind = document.getElementById('side-ind');
      const ib = ind.getBoundingClientRect(), bb = b.getBoundingClientRect();
      const ctx = [...document.querySelectorAll('.ictx')].filter(x => x.offsetParent).map(x => x.dataset.ctx);
      return { on, current: b.getAttribute('aria-current'), indOn: Math.abs(ib.top - bb.top) < 2, ctx, hash: location.hash };
    }, sec);
    if (!(st.on.length === 1 && st.on[0] === sec && st.current === 'page' && st.indOn && st.ctx.length === 1 && st.ctx[0] === CTXS[sec] && st.hash === '#' + sec)) secBad.push([sec, st]);
    const of = await overflow(); if (of.length) secBad.push([sec, of]);
  }
  ok('every section opens alone — the sidebar indicator slides onto it, the inspector shows its context, the address keeps it', !secBad.length, secBad);
  ok('… each within a frame or two (handler + the frame after it)', Math.max(...secTimes) < 100, secTimes);
  ok('1366 x 768: every section — nothing cut off, nothing overlapping, no sideways scroll', !secBad.some(x => Array.isArray(x[1])), secBad);
  ok('keys: 2 opens the library, 5 the intro & outro', await (async () => { await page.keyboard.press('5'); const a = await page.$eval('.sec.on', e => e.dataset.sec); await page.keyboard.press('2'); const b = await page.$eval('.sec.on', e => e.dataset.sec); return a === 'intro' && b === 'clips'; })());
  // 100+ clips: select all 327 shown
  const tAll = await frameTime(page, `() => document.getElementById('sel-all').click()`);
  const big = await page.evaluate(() => ({ tl: document.querySelectorAll('#tl li[data-id]').length, blocks: document.querySelectorAll('#blocks .blk[data-id]').length, n: document.getElementById('s-n').textContent, lib: document.querySelectorAll('#lib .clip').length, badge: document.getElementById('nav-n').textContent }));
  ok(`select all: ${total} clips in the timeline and on the track at once (${tAll} ms), the library still a few dozen rows`, big.tl === total && big.blocks === total && big.n === String(total) && big.lib < 40 && big.badge === String(total) && tAll < 400, [tAll, big]);
  await page.waitForTimeout(500);
  ok('… the selected counter counts to it', (await page.textContent('#sel-count')) === String(total));
  // reorder them all, twice
  await nav(page, 'timeline');
  const firstId = await page.$eval('#tl li[data-id]', e => e.dataset.id);
  await page.evaluate(() => { window.__keep = [...document.querySelectorAll('#tl li[data-id]')]; });
  const tRev = await frameTime(page, `() => document.getElementById('tl-rev').click()`);
  const afterRev = await page.evaluate(() => ({ last: [...document.querySelectorAll('#tl li[data-id]')].pop().dataset.id, pos: document.querySelector('#tl li[data-id] .pos').textContent, same: window.__keep.every(li => li.isConnected), blocksLast: [...document.querySelectorAll('#blocks .blk[data-id]')].pop().dataset.id }));
  const tSort = await frameTime(page, `() => document.getElementById('tl-sort').click()`);
  const afterSort = await page.$eval('#tl li[data-id]', e => e.dataset.id);
  ok(`reverse ${total} clips (${tRev} ms) and back to match order (${tSort} ms): every row moved, none rebuilt; the track follows`, afterRev.last === firstId && afterRev.pos === '1' && afterRev.same && afterRev.blocksLast === firstId && afterSort === firstId && tRev < 400 && tSort < 400, [tRev, tSort, afterRev]);
  // scroll the timeline and the track
  const tScroll = await page.evaluate(async () => {
    const tl = document.getElementById('tl'), tr = document.getElementById('track'), t0 = performance.now();
    for (let i = 0; i <= 20; i++) { tl.scrollTop = tl.scrollHeight * i / 20; tr.scrollLeft = tr.scrollWidth * i / 20; await new Promise(r => requestAnimationFrame(r)); }
    return { ms: Math.round(performance.now() - t0), bottom: Math.abs(tl.scrollTop + tl.clientHeight - tl.scrollHeight) < 2, right: tr.scrollLeft > 0 };
  });
  ok('scroll the timeline and the track end to end (21 frames)', tScroll.bottom && tScroll.right && tScroll.ms < 21 * 50, tScroll);
  // the track: drag a block along it
  await nav(page, 'clips');
  await page.click('#sel-none');
  for (const ob of ['1.2', '3.4', '5.1']) await page.click(`#lib .clip:has(.ob:text-is("${ob}")) .meta`);
  const order3 = await page.$$eval('#blocks .blk[data-id]', els => els.map(e => e.dataset.id));
  ok('three picked: three blocks on the track, in that order', JSON.stringify(order3) === JSON.stringify([ids.red, ids.green, ids.blue]), order3);
  const bb = async (id) => (await page.$(`#blocks .blk[data-id="${id}"]`)).boundingBox();
  let b3 = await bb(ids.blue), b1 = await bb(ids.red);
  await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2); await page.mouse.down();
  await page.mouse.move(b1.x + 3, b1.y + b1.height / 2, { steps: 10 });
  ok('… dragging a block shows where it will drop', await page.$eval('#tk-drop', e => e.classList.contains('on')));
  await page.mouse.up();
  ok('… and drops it there (blue first)', JSON.stringify(await page.$$eval('#blocks .blk[data-id]', els => els.map(e => e.dataset.id))) === JSON.stringify([ids.blue, ids.red, ids.green]));
  // drag a clip from the library onto the track, between two blocks
  await search('Rohit');
  await page.waitForFunction(() => document.querySelectorAll('#lib .clip').length === 1);
  const row = await (await page.$('#lib .clip .meta')).boundingBox();
  b1 = await bb(ids.red);
  await page.mouse.move(row.x + 40, row.y + 10); await page.mouse.down();
  await page.mouse.move(b1.x + 3, b1.y + b1.height / 2, { steps: 12 });
  ok('drag a clip from the library: the track lights up for the drop', await page.$eval('#track', e => e.classList.contains('drop-ok')) && !!(await page.$('.drag-ghost')));
  await page.mouse.up();
  ok('… and the clip is placed where it was dropped (2nd), not just added at the end', JSON.stringify(await tlOrder()) === JSON.stringify([ids.blue, ids.yellow, ids.red, ids.green]), await tlOrder());
  await search('');
  // the keyboard in the library: arrows move, space picks
  await page.focus('#lib');
  await page.keyboard.press('End'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown'); await page.keyboard.press(' ');
  ok('keyboard: End, ↑, ↓, space picks the last clip', (await tlOrder()).length === 5 && await page.$eval('#lib .clip.cur', (e, n) => e.dataset.i === String(n - 1), total));
  await page.keyboard.press(' ');
  await page.$eval('#lib', el => { el.scrollTop = 0; });
  await page.waitForFunction(() => [...document.querySelectorAll('#lib .clip .ob')].some(x => x.textContent === '1.2'));
  // the inspector: the clip in focus
  ok('the inspector shows the clip in focus (batter, its place in the video)', /Batter/.test(await page.textContent('#i-clip')) && /Not in the timeline|#\d/.test(await page.textContent('#i-clip')));
  // the player: on demand, its own controls, closes clean
  ok('no video in the page before one is asked for', !(await page.$eval('#pl-video', v => v.hasAttribute('src'))) && await page.$$eval('video[src]', v => v.length) === 0);
  await page.hover(`#lib .clip:has(.ob:text-is("1.2"))`);
  await page.click(`#lib .clip:has(.ob:text-is("1.2")) [data-play]`);
  await page.waitForFunction(() => document.querySelector('#player').classList.contains('on'));
  await page.waitForTimeout(400); await shot(page, 'studio-player');
  ok('preview a clip: the player opens with that clip, its own controls', (await page.$eval('#pl-video', v => v.getAttribute('src'))).endsWith('red.mp4') && /SIX · 1\.2/.test(await page.textContent('#pl-title')) && await page.isVisible('#pl-seek') && await page.isVisible('#pl-play') && !(await page.$eval('#pl-video', v => v.controls)));
  await page.click('#pl-close');
  await page.waitForFunction(() => document.querySelector('#player').classList.contains('hidden'));
  ok('… closing it lets go of the video', !(await page.$eval('#pl-video', v => v.hasAttribute('src'))));
  await page.click('#hdr-preview');
  await page.waitForFunction(() => document.querySelector('#player').classList.contains('on'));
  const seq1 = await page.textContent('#pl-seq');
  await page.click('#pl-next');
  const seq2 = await page.textContent('#pl-seq');
  const head = await page.evaluate(() => ({ on: document.getElementById('playhead').classList.contains('on'), playing: document.querySelector('#blocks .blk.playing') && document.querySelector('#blocks .blk.playing').dataset.id }));
  ok('Preview (header): the timeline\'s clips one after another, the track\'s playhead on the one playing', seq1 === 'Clip 1 of 4' && seq2 === 'Clip 2 of 4' && head.on && head.playing === ids.yellow, [seq1, seq2, head]);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#player').classList.contains('hidden'));
  ok('… Esc closes it, the playhead goes', !(await page.$eval('#playhead', e => e.classList.contains('on'))));
  // again and again: sections, the inspector drawer, the player — nothing piles up
  await page.click('#sel-none');
  const m0 = await metrics();
  for (let k = 0; k < 6; k++) {
    for (const sec of SECS) await page.evaluate((s) => document.querySelector(`.nav[data-sec="${s}"]`).click(), sec);
    await page.evaluate(() => document.getElementById('sel-all').click());
    await page.evaluate(() => document.getElementById('tl-rev').click());
    await page.evaluate(() => document.getElementById('sel-none').click());
    await page.evaluate(() => document.querySelector('.nav[data-sec="clips"]').click());
    await page.evaluate(async () => { for (let i = 0; i < 4; i++) { document.querySelector('#lib .clip [data-play]').click(); await new Promise(r => setTimeout(r, 40)); document.getElementById('pl-close').click(); await new Promise(r => setTimeout(r, 340)); } });
  }
  await page.waitForTimeout(600);
  const m1 = await metrics();
  ok(`opened and closed again and again (48 sections, 24 players, 6 × ${total} clips picked and dropped): DOM nodes, listeners and memory stay put`,
    m1.nodes - m0.nodes < 400 && m1.listeners - m0.listeners < 40 && m1.heapMB - m0.heapMB < 6, [m0, m1]);
  // resizing: 1366 → 1100 (the inspector becomes a drawer) → 1600 → 1920
  const sizes = [[1100, 800], [1600, 900], [1920, 1080], [1366, 768]];
  const resBad = [];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(450);
    for (const sec of ['clips', 'timeline', 'thumbs', 'export']) { await page.evaluate((s) => document.querySelector(`.nav[data-sec="${s}"]`).click(), sec); await page.waitForTimeout(120); const of = await overflow(); if (of.length) resBad.push([w, sec, of]); }
    if (w < 1280) {
      ok('1100 wide: the inspector is a drawer, shut until asked', !(await page.isVisible('#insp')) && await page.isVisible('#insp-toggle'));
      await page.click('#insp-toggle'); await page.waitForTimeout(520);
      const open = await page.$eval('#insp', e => { const r = e.getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left < innerWidth - 100 && getComputedStyle(e).visibility === 'visible'; });
      await page.click('#insp-close'); await page.waitForTimeout(520);
      ok('… it slides in and out', open && !(await page.isVisible('#insp')));
    }
    if (w === 1920) await shot(page, 'studio-1920');
  }
  ok('resized to 1100, 1600, 1920 and back: nothing cut off or overlapping, no sideways scroll', !resBad.length, resBad);
  ok('the sidebar folds and unfolds (and remembers)', await (async () => { await page.setViewportSize({ width: 1600, height: 900 }); await page.waitForTimeout(300); const a = await page.$eval('#wrap', e => e.classList.contains('compact')); await page.click('#side-toggle'); await page.waitForTimeout(400); const b = await page.$eval('#wrap', e => e.classList.contains('compact')); const pref = await page.evaluate(() => JSON.parse(localStorage.getItem('asl-studio-ui')).compact); return a !== b && pref === b; })());
  await ctx.close();

  console.log('\n=== Reduced motion ===');
  ({ ctx, page } = await newPage({ reducedMotion: 'reduce' }));
  await ctx.addInitScript(() => { window.__studioToken = 'work-token'; });
  await page.goto(URL0 + '#timeline');
  await page.waitForSelector('#wrap:not(.hidden)');
  const rm = await page.evaluate(() => { const s = document.querySelector('.sec.on'); return { sec: s.dataset.sec, anim: parseFloat(getComputedStyle(s).animationDuration), tr: parseFloat(getComputedStyle(document.querySelector('.nav')).transitionDuration) }; });
  ok('reduced motion: the page opens where the address says, and nothing slides or fades', rm.sec === 'timeline' && rm.anim < 0.01 && rm.tr < 0.01, rm);
  await ctx.close();

  console.log('\n=== A phone ===');
  ({ ctx, page } = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }));
  await ctx.addInitScript(() => { window.__studioToken = 'work-token'; });
  await page.goto(URL0);
  await page.waitForSelector('#wrap:not(.hidden)');
  const bar = await page.$eval('#side', e => { const r = e.getBoundingClientRect(); return { bottom: Math.round(r.bottom), h: Math.round(r.height), n: e.querySelectorAll('.nav').length }; });
  ok('the sections in a bottom bar', bar.n === 8 && bar.bottom === 844 && bar.h < 80, bar);
  const wide = async () => page.evaluate(() => document.documentElement.scrollWidth);
  const phoneBad = [];
  for (const sec of ['clips', 'timeline', 'thumbs', 'export', 'overview']) {
    await page.evaluate((s) => document.querySelector(`.nav[data-sec="${s}"]`).click(), sec);
    await page.waitForTimeout(sec === 'thumbs' ? 800 : 300);
    const w = await wide(), inner = await page.$eval('.sec.on', e => e.scrollWidth - e.clientWidth);
    if (w > 390 || inner > 1) phoneBad.push([sec, w, inner]);
    if (sec === 'clips') await shot(page, 'studio-phone-library');
    if (sec === 'thumbs') await shot(page, 'studio-phone-thumbs');
  }
  ok('every section: nothing wider than the screen', !phoneBad.length, phoneBad);
  await ctx.close();

  ok('no page errors', errors.length === 0, errors);
  await browser.close();
  fx.clipServer.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {} process.exit(1); });
