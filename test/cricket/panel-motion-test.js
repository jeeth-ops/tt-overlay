// 🎚️ The interaction layer (cricket-motion.css / cricket-motion.js) and the
// visual refresh (cricket-polish.css) in BOTH panels, each on its own, in
// Chromium against the real server:
//
// - with the motion layer alone nothing looks different at rest: every
//   visible control keeps its box, colours, radius, font, shadow (read
//   against the panel with the layer switched off), at 1366 x 768, 1440 x 900,
//   1600 x 900 and 1920 x 1080 and in the light theme, no sideways scroll —
//   only the new sound switch, and the quick-nav naming the section in view;
// - with the refresh too: every button keeps its own colours, shape, font
//   and height; the header and quick-nav are glass; the timing chips are a
//   segmented control whose highlight sits on the choice and slides to the
//   next one; cards share one radius; nothing overflows, overlaps or is cut
//   off at any of those sizes;
// - strike changes slide the batters past each other; the score rolls like
//   an odometer (its text always what the panel wrote); a wicket glows the
//   score; a batter's 50 and a bowler's five-for burst gold; the over's balls
//   gather when it ends;
// - a button waiting on the server: spinner, ✓ / ✕, its second click held
//   back (a save) — a scoring key never;
// - cards fold and unfold (remembered; the quick-nav unfolds its target),
//   the live cards never; off-screen cards are not drawn (only safe ones);
//   the quick-nav line follows; the key sound is off until turned on (then
//   remembered); a toast pushes the one it replaces up;
// - every modal opens (fading in, the box rising) and is fully shown, closes
//   (fading out) and is gone — and while it fades out a scoring click goes
//   straight through it and is scored;
// - rapid scoring: every tap is a ball, none lost or doubled; a tap is scored
//   within the same frame as before; Undo still undoes one ball;
// - a number that changed settles in once (and only the latest of a fast run
//   plays); an unchanged re-render plays nothing;
// - the player dropdown drops open; buttons release smoothly (their resting
//   look unchanged); reduced motion: nothing moves;
// - a long session (hundreds of balls, modals opened again and again): no
//   listeners or nodes pile up; no page errors.
//
//   NODE_PATH=$(npm root -g) node test/cricket/panel-motion-test.js
const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));
const { chromium } = require('playwright');
const { bootServer } = require('../server-boot.js');

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 700) : '')); }
}
const SETUP = `
  state.format = 'T20'; state.battingTeam = 'A';
  state.wagonWheelOn = false;   // (the shot picker after every run is the panel's own question — off here, so taps reach the keys)
  state.striker    = { name:'Harsh Mendon', id:'p1', runs:0, balls:0, fours:0, sixes:0 };
  state.nonStriker = { name:'Rohit Patil', id:'p2', runs:0, balls:0, fours:0, sixes:0 };
  state.bowler     = { name:'Yogesh Pawar', id:'p9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
  renderPanel(); true`;
const LOOK = `(() => {
  const props = ['backgroundColor','backgroundImage','color','borderTopColor','borderTopWidth','borderRadius','fontSize','fontWeight','boxShadow','opacity','transform','filter'];
  const keyOf = (el) => { const p = []; for (let e = el; e && e !== document.body; e = e.parentElement) { if (e.id) { p.unshift('#' + e.id); break; } let i = 1; for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++; p.unshift(e.tagName.toLowerCase() + ':' + i); } return p.join('>'); };
  const out = {};
  for (const el of document.querySelectorAll('button, select, input, textarea, .card, .pro-dd-trigger, .switch, .dot')) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); const o = { box: [r.x + scrollX, r.y + scrollY, r.width, r.height].map(v => Math.round(v)) };
    for (const k of props) o[k] = cs[k];
    o.chip = el.getAttribute('role') === 'radio' && !!el.closest('.cm-seg');
    o.tag = el.tagName;
    out[keyOf(el)] = o;
  }
  return out;
})()`;

(async () => {
  const { port } = await bootServer();
  const browser = await chromium.launch();
  for(const P of ['cricket-panel', 'cricket-panel3']){
    console.log(`\n=== ${P} ===`);
    const errors = [];
    const open = async (opts) => {
      const ctx = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 768 } }, opts || {}));
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if(u.hostname !== '127.0.0.1') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
        const layers = (opts && opts.layers) || 'all';
        const off = layers === 'none' ? /cricket-(motion|polish)\./ : layers === 'motion' ? /cricket-polish\./ : null;
        if(off && off.test(u.pathname)) return route.fulfill({ status: 200, contentType: /\.css$/.test(u.pathname) ? 'text/css' : 'text/javascript', body: '' });
        // (requests the busy-button checks make: one slow, one failing)
        if(u.pathname === '/__cm_slow') return new Promise(r => setTimeout(r, 700)).then(() => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, pad: 'x'.repeat(40) }) }));
        if(u.pathname === '/__cm_fail') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' });
        return route.continue();
      });
      await page.goto(`http://127.0.0.1:${port}/${P}?room=MO${Math.random().toString(36).slice(2, 7)}`);
      await page.waitForFunction(() => typeof renderPanel === 'function' && typeof state === 'object' && document.readyState === 'complete');
      await page.evaluate((opts && opts.setup) || SETUP);
      if(opts && opts.theme) await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), opts.theme);
      await page.mouse.move(1, 1);
      await page.waitForTimeout(700);
      return { ctx, page };
    };

    // ---- at rest, motion layer alone: the same panel, with and without it
    // (allowed: the new sound switch; the quick-nav naming the section in view)
    const allowed = (k, p) => k === '#cm-sound-btn' || (k.startsWith('#quick-nav') && p === 'color') || p === 'chip' || p === 'tag';
    const diff = (la, lb, tag) => { const out = []; for(const k of new Set([...Object.keys(la), ...Object.keys(lb)])){ if(!la[k] || !lb[k]){ if(!allowed(k)) out.push([tag, k, la[k] ? 'gone' : 'new']); continue; } for(const p of Object.keys(la[k])) if(!allowed(k, p) && JSON.stringify(la[k][p]) !== JSON.stringify(lb[k][p])) out.push([tag, k, p, la[k][p], lb[k][p]]); } return out; };
    const layout = (page) => page.evaluate(() => {
      const out = [];
      if(document.documentElement.scrollWidth > innerWidth) out.push('sideways scroll ' + document.documentElement.scrollWidth);
      const hdr = ['header h1', ...[...document.querySelectorAll('#conn-row > *')].map((e, i) => `#conn-row > :nth-child(${i + 1})`)].map(s => document.querySelector(s)).filter(e => e && e.offsetParent !== null && e.getBoundingClientRect().width).map(e => e.getBoundingClientRect());
      for(let i = 1; i < hdr.length; i++) if(hdr[i].left < hdr[i - 1].right - 0.5 && hdr[i].top < hdr[i - 1].bottom - 1) out.push('header overlap ' + i);
      for(const b of document.querySelectorAll('button')){
        const r = b.getBoundingClientRect(); if(!r.width || b.offsetParent === null || b.closest('#quick-nav, .wicket-modal-overlay, .tc-overlay, .ww-overlay')) continue;
        if(r.right > innerWidth + 0.5) out.push('cut off: ' + (b.id || b.textContent.trim().slice(0, 24)));
      }
      // buttons side by side never overlap
      for(const p of new Set([...document.querySelectorAll('button')].map(b => b.parentElement))){
        const bs = [...p.children].filter(x => x.tagName === 'BUTTON' && x.offsetParent !== null).map(x => [x, x.getBoundingClientRect()]).filter(([, r]) => r.width);
        for(let i = 0; i < bs.length; i++) for(let j = i + 1; j < bs.length; j++){ const [x, a] = bs[i], [y, b] = bs[j]; const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); if(ix > 1 && iy > 1) out.push('overlap: ' + (x.id || x.textContent.trim().slice(0, 16)) + ' / ' + (y.id || y.textContent.trim().slice(0, 16))); }
      }
      return out;
    });
    const bad = [], pbad = [], lay = [];
    let polishLook = null;
    for(const [w, h, theme] of [[1366, 768], [1440, 900], [1600, 900], [1920, 1080], [1366, 768, 'light']]){
      const a = await open({ viewport: { width: w, height: h }, layers: 'none', theme }), b = await open({ viewport: { width: w, height: h }, layers: 'motion', theme }), c = await open({ viewport: { width: w, height: h }, layers: 'all', theme });
      const tag = `${w}${theme ? ' ' + theme : ''}`;
      const [la, lb, lc] = [await a.page.evaluate(LOOK), await b.page.evaluate(LOOK), await c.page.evaluate(LOOK)];
      bad.push(...diff(la, lb, tag));
      if(await b.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) bad.push([tag, 'sideways scroll']);
      // the refresh: every button keeps its own colours, shape, font and height (its width may give a few px to the cards' new room)
      for(const k of Object.keys(la)){
        const x = la[k], y = lc[k]; if(!y || x.tag !== 'BUTTON' || k === '#cm-sound-btn' || k.startsWith('#quick-nav')) continue;
        const props = y.chip ? ['fontSize', 'fontWeight'] : ['backgroundColor', 'backgroundImage', 'color', 'borderRadius', 'fontSize', 'fontWeight'];
        for(const p of props) if(x[p] !== y[p]) pbad.push([tag, k, p, x[p], y[p]]);
        if(Math.abs(x.box[3] - y.box[3]) > 1) pbad.push([tag, k, 'height', x.box[3], y.box[3]]);
        if(Math.abs(x.box[2] - y.box[2]) > 6) pbad.push([tag, k, 'width', x.box[2], y.box[2]]);
      }
      const l = await layout(c.page); if(l.length) lay.push([tag, l.slice(0, 6)]);
      if(!polishLook) polishLook = await c.page.evaluate(() => {
        const hs = getComputedStyle(document.querySelector('header')), qs = getComputedStyle(document.getElementById('quick-nav'));
        const alpha = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if(!m) return /color\(/.test(c) ? Number((c.match(/\/\s*([\d.]+)/) || [0, 1])[1]) : 1; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; };
        const cards = [...document.querySelectorAll('.card')].filter(c => c.offsetParent !== null);
        const segs = [...document.querySelectorAll('.cm-seg')].filter(g => g.offsetParent !== null).map(g => { const on = g.querySelector(':scope > [role=radio][aria-checked="true"]'), pill = g.querySelector(':scope > .cm-seg-pill'); const a = on.getBoundingClientRect(), b = pill.getBoundingClientRect(); return Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height)); });
        return { hdrBlur: /blur/.test(hs.backdropFilter || hs.webkitBackdropFilter || ''), hdrAlpha: alpha(hs.backgroundColor), qnBlur: /blur/.test(qs.backdropFilter || qs.webkitBackdropFilter || ''), qnAlpha: alpha(qs.backgroundColor),
          radius14: cards.filter(c => getComputedStyle(c).borderRadius === '14px').length, cards: cards.length, segs };
      });
      if(w === 1366 && !theme) ok(`at rest, ${Object.keys(lb).length} controls compared`, Object.keys(lb).length > 100, Object.keys(lb).length);
      await a.ctx.close(); await b.ctx.close(); await c.ctx.close();
    }
    ok('motion layer alone, at rest: every control keeps its box, colours, radius, font and shadow at 1366, 1440, 1600, 1920 and in the light theme — no sideways scroll (only the sound switch and the quick-nav\'s section are new)', !bad.length, bad.slice(0, 8));
    ok('with the refresh: every button keeps its own colours, shape, font and height', !pbad.length, pbad.slice(0, 8));
    ok('with the refresh: nothing overflows, overlaps or is cut off — 1366, 1440, 1600, 1920, light theme', !lay.length, lay);
    ok('the refresh: the header and the quick-nav are frosted glass (translucent, blurred)', polishLook.hdrBlur && polishLook.qnBlur && polishLook.hdrAlpha < 1 && polishLook.qnAlpha < 1, polishLook);
    ok('the refresh: the cards share one corner radius', polishLook.radius14 >= polishLook.cards * 0.8, polishLook);
    ok(`the refresh: the timing chips are segmented, the highlight on each one's choice (${polishLook.segs.length} groups)`, polishLook.segs.length >= 3 && polishLook.segs.every(d => d <= 1.5), polishLook.segs);

    const { ctx, page } = await open();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => { await cdp.send('HeapProfiler.collectGarbage'); const m = (await cdp.send('Performance.getMetrics')).metrics; const g = (n) => (m.find(x => x.name === n) || {}).value; return { nodes: g('Nodes'), listeners: g('JSEventListeners'), heapMB: Math.round(g('JSHeapUsedSize') / 1e5) / 10 }; };
    ok('the layer is loaded once (stylesheet + script)', await page.evaluate(() => !!window.__cricketMotion && [...document.styleSheets].some(s => /cricket-motion\.css/.test(s.href || ''))));

    // ---- every modal: opens shown, closes gone
    const modalBad = [], openMid = [];
    const overlays = await page.$$eval('.wicket-modal-overlay[id], .tc-overlay[id], .ww-overlay[id]', els => els.map(e => e.id));
    for(const id of overlays){
      const st = await page.evaluate(async (id) => {
        const ov = document.getElementById(id), box = ov.querySelector(':scope > .wicket-modal, :scope > .tc-modal');
        ov.classList.add('show');
        getComputedStyle(ov).opacity;                  // (the fade starts with the first style the browser works out)
        // (it takes its start time from a frame and moves on with them; the team card's own
        //  opening animation starts a frame later) — part-way through after 3 or 6 frames
        let mid = 1;
        for(let f = 1; f <= 6; f++){ await new Promise(r => requestAnimationFrame(r)); const o = Number(getComputedStyle(ov).opacity); if((f === 3 || f === 6) && o > 0 && o < 1){ mid = o; break; } if(f === 6) mid = o; }
        await new Promise(r => setTimeout(r, 380));
        const cs = getComputedStyle(ov), bs = box && getComputedStyle(box);
        const shown = { op: Number(cs.opacity), disp: cs.display, box: bs ? [Number(bs.opacity), bs.scale, bs.translate] : null, pe: cs.pointerEvents };
        ov.classList.remove('show');
        await new Promise(r => setTimeout(r, 40));
        const fading = { disp: getComputedStyle(ov).display, pe: getComputedStyle(ov).pointerEvents };
        await new Promise(r => setTimeout(r, 380));
        return { mid, shown, fading, gone: getComputedStyle(ov).display };
      }, id);
      if(!(st.shown.op === 1 && st.shown.disp !== 'none' && st.shown.pe !== 'none' && (!st.shown.box || (st.shown.box[0] === 1 && /^(none|1)$/.test(st.shown.box[1]))) && st.fading.pe === 'none' && st.gone === 'none')) modalBad.push([id, st]);
      openMid.push(st.mid);
    }
    ok(`all ${overlays.length} modals: fully shown once open, fading out without catching clicks, then gone`, overlays.length > 15 && !modalBad.length, modalBad.slice(0, 3));
    ok('… and they open with a fade (part-way through a few frames in)', openMid.every(x => x > 0 && x < 1), openMid);

    // ---- a scoring tap straight through a modal that is fading out
    const closeAll = () => page.evaluate(async () => { document.querySelectorAll('.wicket-modal-overlay.show, .tc-overlay.show, .ww-overlay.show').forEach(o => o.classList.remove('show')); await new Promise(r => setTimeout(r, 320)); });
    const ballBtn = (b) => page.$eval(`[data-ball="${b}"]`, e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.$eval('[data-ball="1"]', e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
    let at = await ballBtn('1');
    const runs0 = await page.evaluate(() => state.score.runs);
    await page.evaluate(() => { const o = document.getElementById('retired-modal-overlay'); o.classList.add('show'); });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('retired-modal-overlay').classList.remove('show'));
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(50);
    ok('a scoring tap while a modal fades out goes straight through and is scored', (await page.evaluate(() => state.score.runs)) === runs0 + 1, [runs0, await page.evaluate(() => state.score.runs)]);

    // ---- rapid taps: every one a ball, each scored at once
    await page.waitForTimeout(300);
    at = await ballBtn('1');
    const b0 = await page.evaluate(() => ({ runs: state.score.runs, legal: state.score.overs * 6 + state.score.balls }));
    for(let i = 0; i < 4; i++){ await page.mouse.click(at.x, at.y); await page.waitForTimeout(60); }
    const b1 = await page.evaluate(() => ({ runs: state.score.runs, legal: state.score.overs * 6 + state.score.balls }));
    ok('four rapid taps on 1: four balls, four runs — none lost, none doubled', b1.runs - b0.runs === 4 && b1.legal - b0.legal === 4, [b0, b1]);
    const syncMs = await page.evaluate(() => { const b = document.querySelector('[data-ball="0"]'); const t0 = performance.now(); b.click(); return Math.round((performance.now() - t0) * 10) / 10; });
    const scoredNow = await page.evaluate(() => state.score.overs * 6 + state.score.balls);
    ok(`a tap is scored inside its own click (${syncMs} ms of script, no waiting on an animation)`, scoredNow === b1.legal + 1, [scoredNow, b1.legal]);
    const undo = await page.evaluate(() => { const before = state.score.overs * 6 + state.score.balls; const u = document.querySelector('#lc-undo-btn, #undo-btn, [onclick*="undoLastBall"]'); if(u) u.click(); else if(typeof undoLastBall === 'function') undoLastBall(); return [before, state.score.overs * 6 + state.score.balls]; });
    ok('Undo still takes back exactly one ball', undo[1] === undo[0] - 1, undo);

    // ---- a changed number settles in; an unchanged re-render plays nothing
    await page.waitForTimeout(400);
    const tick = await page.evaluate(async () => {
      const el = document.getElementById('disp-crr');
      const n0 = el.getAnimations().length;
      renderPanel();                                   // same numbers again
      await new Promise(r => setTimeout(r, 0));
      const n1 = el.getAnimations().length;
      document.querySelector('[data-ball="2"]').click();
      await new Promise(r => setTimeout(r, 0));
      const a = el.getAnimations();
      return { n0, n1, after: a.length, playing: a[0] && a[0].playState, text: el.textContent };
    });
    ok('a number that changed (the run rate) settles in once; the same number re-rendered plays nothing', tick.n0 === 0 && tick.n1 === 0 && tick.after === 1 && tick.playing === 'running', tick);
    const burst = await page.evaluate(async () => { const el = document.getElementById('disp-overs'); for(let i = 0; i < 3; i++){ document.querySelector('[data-ball="0"]').click(); await new Promise(r => setTimeout(r, 0)); } return el.getAnimations().length; });
    ok('… a fast run of balls plays only the latest (never a queue)', burst <= 1, burst);

    // ---- the keys, on a fresh match (so no over ends in the middle): a ring out of the key that
    //      scored, in its colour; two for a FOUR / SIX; the keyboard shows its key; Undo drops back
    {
      const K = await open(), kp = K.page;
      await kp.$eval('[data-ball="1"]', e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await kp.waitForTimeout(300);
      const kAt = await kp.$eval('[data-ball="1"]', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await kp.mouse.click(kAt.x, kAt.y);
      await kp.waitForTimeout(60);
      const ring1 = await kp.evaluate(() => { const rs = [...document.querySelectorAll('.cm-ring')].filter(r => r.getAnimations().some(a => a.playState === 'running')); const k = document.querySelector('[data-ball="1"]').getBoundingClientRect(); const r = rs[0] && rs[0].getBoundingClientRect(); return { n: rs.length, pe: rs[0] && getComputedStyle(rs[0]).pointerEvents, over: r ? Math.abs(r.left + r.width / 2 - (k.left + k.width / 2)) < 2 && Math.abs(r.top + r.height / 2 - (k.top + k.height / 2)) < 2 : false, runs: state.score.runs }; });
      ok('a scored key sends one ring out from itself, never in the way of the next tap (and the run is scored)', ring1.n === 1 && ring1.pe === 'none' && ring1.over && ring1.runs === 1, ring1);
      await kp.waitForTimeout(500);
      const four = await kp.evaluate(async () => { const b = document.querySelector('[data-ball="4"]'); const want = getComputedStyle(b).getPropertyValue('--k').trim(); const runs = state.score.runs; b.click(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rs = [...document.querySelectorAll('.cm-ring')].filter(r => r.getAnimations().length), o = document.getElementById('over-preview');
        return { n: rs.length, colours: rs.map(r => r.style.getPropertyValue('--cm-c')), want, runs: state.score.runs - runs, pips: o.children.length, pop: o.lastElementChild ? o.lastElementChild.getAnimations().length : -1 }; });
      ok('a FOUR: two rings in the key\'s own green, four runs scored', four.n === 2 && four.colours.every(c => c === four.want) && /#22c55e/i.test(four.want) && four.runs === 4, four);
      ok('… and the ball pops into "this over" (the second pip)', four.pips === 2 && four.pop === 1, four);
      await kp.waitForTimeout(600);
      await kp.evaluate(() => { if(document.activeElement) document.activeElement.blur(); });
      const kb0 = await kp.evaluate(() => state.score.runs);
      await kp.keyboard.press('2');
      await kp.waitForTimeout(40);
      const kb = await kp.evaluate(() => { const b = document.querySelector('[data-ball="2"]'); return { dip: b.getAnimations().map(a => a.effect.getKeyframes()[0].scale), rings: [...document.querySelectorAll('.cm-ring')].filter(r => r.getAnimations().length).length, runs: state.score.runs }; });
      ok('the keyboard: "2" is scored by the panel, and its key dips on screen with a ring (the operator sees which key took it)', kb.runs === kb0 + 2 && kb.dip.includes('0.95') && kb.rings >= 1, [kb0, kb]);
      await kp.waitForTimeout(500);
      const und = await kp.evaluate(async () => { const el = document.getElementById('disp-overs'); const before = state.score.runs; document.getElementById('undo-btn').click(); await new Promise(r => setTimeout(r, 0)); const a = el.getAnimations()[0]; return { tr: a ? a.effect.getKeyframes()[0].translate : null, runs: before - state.score.runs, undoDip: document.getElementById('undo-btn').getAnimations().length }; });
      ok('Undo (one ball back): the number that went back drops in from above — a rise comes from below', und.tr && /-3px/.test(und.tr) && und.runs === 2, und);
      if(P === 'cricket-panel3'){
        await kp.waitForTimeout(500);
        const pop = await kp.evaluate(async () => { const el = document.getElementById('disp-score'); document.querySelector('[data-ball="6"]').click(); await new Promise(r => setTimeout(r, 0)); const a = el.getAnimations()[0]; return a ? a.effect.getKeyframes().map(k => k.scale) : null; });
        ok('a SIX pops the score', pop && pop.includes('1.09'), pop);
      }
      {
        await kp.waitForTimeout(500);
        const sc = await kp.evaluate(async () => { document.querySelector('[data-ball="1"]').click(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const n0 = [...document.querySelectorAll('.cm-ring')].filter(r => r.getAnimations().length).length; window.scrollBy(0, 40); await new Promise(r => setTimeout(r, 120)); return [n0, [...document.querySelectorAll('.cm-ring')].filter(r => r.getAnimations().length).length]; });
        ok('a ring goes the moment the page scrolls (it never hangs where the key was)', sc[0] >= 1 && sc[1] === 0, sc);
      }
      await K.ctx.close();
    }

    // ---- the crease, the odometer, the moments (a fresh match: a batter on 48, a bowler on 4 wickets)
    {
      const NAME = P === 'cricket-panel' ? 'lc-striker-name' : 'live-striker-name';
      const M = await open({ setup: SETUP.replace("id:'p1', runs:0, balls:0, fours:0, sixes:0", "id:'p1', runs:48, balls:30, fours:4, sixes:2").replace("runs:0, wickets:0, runsThisOver:0", "runs:0, wickets:4, runsThisOver:0") }), mp = M.page;
      await mp.$eval(P === 'cricket-panel' ? '#live-console' : '#card-live-players', e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await mp.waitForTimeout(400);
      const sw = await mp.evaluate(async (NAME) => {
        const st = window.__cricketMotion, s0 = st.swaps;
        document.querySelector('[data-ball="1"]').click();
        await new Promise(r => setTimeout(r, 0));
        const kf = document.getElementById(NAME).getAnimations().map(a => a.effect.getKeyframes()[0].translate).filter(Boolean);
        return { swaps: st.swaps - s0, slide: kf.some(t => !/^0px( 0px)?$/.test(t)), odo: document.querySelectorAll('#disp-score .cm-odo').length, text: document.getElementById('disp-score').textContent, want: `${state.score.runs}-${state.score.wickets}`, striker: document.getElementById(NAME).textContent };
      }, NAME);
      ok('a single changes strike: the two batters slide past each other into their places', sw.swaps === 1 && sw.slide && /Rohit/.test(sw.striker), sw);
      ok('… and the score rolls like an odometer — its text always exactly what the panel wrote', sw.odo >= 1 && sw.text === sw.want, sw);
      await mp.waitForTimeout(700);
      const plain = await mp.$eval('#disp-score', e => ({ spans: e.querySelectorAll('*').length, text: e.textContent }));
      ok('… then it is plain text again', plain.spans === 0 && plain.text === sw.want, plain);
      await mp.evaluate(() => document.querySelector('[data-ball="1"]').click());      // (Harsh back on strike)
      await mp.waitForTimeout(600);
      const fifty = await mp.evaluate(async () => { const st = window.__cricketMotion, b0 = st.bursts; document.querySelector('[data-ball="2"]').click(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return { bursts: st.bursts - b0, rings: [...document.querySelectorAll('.cm-ring')].filter(r => r.getAnimations().length).length, runs: state.striker.runs }; });
      ok('a batter reaching 50: a gold burst round his row', fifty.bursts === 1 && fifty.rings >= 3 && fifty.runs === 50, fifty);
      await mp.waitForTimeout(1200);
      const wkt = await mp.evaluate(async () => { const st = window.__cricketMotion, b0 = st.bursts; recordBall('W', { dismissalType: 'Bowled' }); await new Promise(r => setTimeout(r, 0));
        const el = document.getElementById('disp-score'); return { glow: el.getAnimations().some(a => a.effect.getKeyframes().some(k => k.textShadow && /26px/.test(k.textShadow))), bursts: st.bursts - b0, wickets: state.score.wickets, bw: state.bowler.wickets }; });
      ok('a wicket glows the score red; the bowler\'s fifth wicket bursts gold', wkt.glow && wkt.wickets === 1 && wkt.bw === 5 && wkt.bursts === 1, wkt);
      await M.ctx.close();
    }
    // ---- the over ends: its balls gather and go
    {
      const O = await open(), op = O.page;
      await op.$eval('#over-preview', e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await op.waitForTimeout(300);
      for(let i = 0; i < 5; i++){ await op.evaluate(() => document.querySelector('[data-ball="0"]').click()); await op.waitForTimeout(150); }
      const g = await op.evaluate(async () => { const st = window.__cricketMotion, g0 = st.gathers; document.querySelector('[data-ball="0"]').click(); await new Promise(r => setTimeout(r, 30)); const w = document.querySelector('.cm-gather'); return { gathers: st.gathers - g0, pips: w ? w.children.length : 0, moving: w ? [...w.children].every(d => d.getAnimations().length === 1) : false, left: document.getElementById('over-preview').children.length }; });
      ok('the over ends: its six balls gather into the first and go (copies — the strip itself is the panel\'s)', g.gathers === 1 && g.pips === 6 && g.moving && g.left === 0, g);
      await op.waitForTimeout(900);
      ok('… and are gone', (await op.$$eval('.cm-gather', e => e.length)) === 0);
      await O.ctx.close();
    }
    // ---- buttons waiting on the server
    {
      const B = await open(), bp = B.page;
      await bp.evaluate(() => {
        const host = document.getElementById('card-session');
        window.__hits = {};
        const mk = (id, label, url) => { const b = document.createElement('button'); b.type = 'button'; b.id = id; b.className = 'small'; b.textContent = label; window.__hits[id] = 0; b.addEventListener('click', () => { window.__hits[id]++; fetch(url).catch(() => {}); }); host.appendChild(b); };
        mk('t-save', 'Save test', '/__cm_slow'); mk('t-go', 'Go test', '/__cm_fail');
      });
      await bp.$eval('#t-save', b => b.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await bp.waitForTimeout(200);
      await bp.click('#t-save');
      await bp.waitForTimeout(80);
      const s1 = await bp.$$eval('.cm-spin', e => e.length);
      await bp.waitForTimeout(260);
      const s2 = await bp.evaluate(() => ({ spin: document.querySelectorAll('.cm-spin').length, busy: document.getElementById('t-save').getAttribute('aria-busy') }));
      await bp.click('#t-save');
      const again = await bp.evaluate(() => ({ hits: window.__hits['t-save'], blocked: window.__cricketMotion.blocked }));
      await bp.waitForTimeout(700);
      const s3 = await bp.evaluate(() => ({ spin: document.querySelectorAll('.cm-spin').length, ok: document.querySelectorAll('.cm-done.ok').length, busy: document.getElementById('t-save').getAttribute('aria-busy') }));
      ok('a save that waits on the server: a spinner after a moment (none for a quick one), then ✓', s1 === 0 && s2.spin === 1 && s2.busy === 'true' && s3.spin === 0 && s3.ok === 1 && s3.busy === null, [s1, s2, s3]);
      ok('… and its second click while it waits is held back (one request, not two)', again.hits === 1 && again.blocked === 1, again);
      await bp.click('#t-go');
      await bp.waitForTimeout(250);
      const f = await bp.evaluate(() => ({ bad: document.querySelectorAll('.cm-done.bad').length }));
      await bp.click('#t-go');
      ok('a request that fails: ✕ at once; a button that is not a save is never held back', f.bad === 1 && (await bp.evaluate(() => window.__hits['t-go'])) === 2, f);
      // a scoring key whose click also starts a request: never a spinner, never held back
      await bp.evaluate(() => { document.querySelector('[data-ball="1"]').addEventListener('click', () => { fetch('/__cm_slow').catch(() => {}); }); });
      await bp.$eval('[data-ball="1"]', e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await bp.waitForTimeout(200);
      const at1 = await bp.$eval('[data-ball="1"]', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      const k0 = await bp.evaluate(() => ({ legal: state.score.overs * 6 + state.score.balls, blocked: window.__cricketMotion.blocked }));
      for(let i = 0; i < 3; i++){ await bp.mouse.click(at1.x, at1.y); await bp.waitForTimeout(60); }
      await bp.waitForTimeout(350);
      const k1 = await bp.evaluate(() => ({ legal: state.score.overs * 6 + state.score.balls, blocked: window.__cricketMotion.blocked, spin: document.querySelectorAll('.cm-spin').length }));
      ok('a scoring key whose tap also talks to the server: every tap a ball, no spinner, nothing held back', k1.legal - k0.legal === 3 && k1.blocked === k0.blocked && k1.spin === 0, [k0, k1]);
      await B.ctx.close();
    }
    // ---- folding cards, the quick-nav line, off-screen cards, the key sound, toasts, the segmented chips
    {
      const F = await open(), fp = F.page;
      const cfg = await fp.evaluate(() => JSON.parse(document.getElementById('cricket-motion-config').textContent));
      const mustStayOpen = P === 'cricket-panel' ? ['card-new-batsman', 'card-bowler'] : ['card-score', 'card-ball-outcome', 'card-new-batsman', 'card-bowler', 'card-live-players'];
      const liveFold = await fp.evaluate((ids) => ids.filter(id => { const c = document.getElementById(id); return !c || c.classList.contains('cm-foldable'); }), mustStayOpen);
      ok('the live scoring cards never fold', liveFold.length === 0 && mustStayOpen.every(id => cfg.liveCards.includes(id)), liveFold);
      await fp.$eval('#card-session > h2', h => h.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await fp.waitForTimeout(300);
      const h0 = await fp.$eval('#card-session', c => c.offsetHeight);
      await fp.click('#card-session > h2', { position: { x: 12, y: 6 } });
      await fp.waitForTimeout(120);
      const mid = await fp.$eval('#card-session', c => c.offsetHeight);
      await fp.waitForTimeout(600);
      const f1 = await fp.$eval('#card-session', c => ({ folded: c.classList.contains('cm-folded'), h: c.offsetHeight, hidden: [...c.children].filter(x => x.tagName !== 'H2').every(x => getComputedStyle(x).display === 'none'), h2h: c.querySelector(':scope > h2').offsetHeight }));
      ok(`a card folds to its heading, smoothly (${h0} → ${mid} → ${f1.h} px)`, f1.folded && f1.hidden && f1.h < f1.h2h + 50 && mid < h0 && mid > f1.h, [h0, mid, f1]);
      await fp.reload();
      await fp.waitForFunction(() => typeof renderPanel === 'function' && document.readyState === 'complete');
      await fp.waitForTimeout(500);
      ok('… and stays folded after a reload (this laptop remembers)', await fp.$eval('#card-session', c => c.classList.contains('cm-folded')));
      await fp.click('#quick-nav [data-target="card-session"]');
      await fp.waitForTimeout(1100);
      const q = await fp.evaluate(() => { const c = document.getElementById('card-session'), b = document.querySelector('#quick-nav [data-target="card-session"]'), ind = document.querySelector('#quick-nav .cm-qn-ind'); const br = b.getBoundingClientRect(), ir = ind.getBoundingClientRect(); return { folded: c.classList.contains('cm-folded'), on: b.classList.contains('cm-qn-on'), dl: Math.round(Math.abs(br.left - ir.left)), dw: Math.round(Math.abs(br.width - ir.width)), op: getComputedStyle(ind).opacity }; });
      ok('the quick-nav unfolds the card it jumps to, and its line slides under that button', !q.folded && q.on && q.dl <= 2 && q.dw <= 2 && q.op === '1', q);
      await fp.evaluate(() => window.scrollTo(0, 0));
      await fp.waitForTimeout(600);
      const q2 = await fp.evaluate(() => { const on = document.querySelector('#quick-nav .cm-qn-on'); return on ? on.getAttribute('data-target') : null; });
      ok('… and follows the page back to the top', q2 && q2 !== 'card-session', q2);
      await fp.waitForFunction(() => document.querySelectorAll('.card.cm-cv').length >= 3, null, { timeout: 20000 }).catch(() => {});
      const cv = await fp.evaluate((no) => ({ n: document.querySelectorAll('.card.cm-cv').length, bad: no.filter(id => { const c = document.getElementById(id); return c && c.classList.contains('cm-cv'); }), squads: document.getElementById('card-team-squads').classList.contains('cm-cv') }), [...cfg.liveCards, ...cfg.drawAlways]);
      ok(`off-screen cards are not drawn until near (${cv.n} of them) — never the live, recording or Stream Engine cards, nor the numbered squad lists`, cv.n >= 3 && !cv.bad.length && !cv.squads, cv);
      // the key sound: off until it is turned on, then remembered
      const tap = () => fp.evaluate(() => { document.querySelectorAll('.wicket-modal-overlay.show').forEach(o => o.classList.remove('show')); document.querySelector('[data-ball="0"]').click(); return window.__cricketMotion.sounds; });
      const snd0 = await fp.evaluate(() => ({ pressed: document.getElementById('cm-sound-btn').getAttribute('aria-pressed'), n: window.__cricketMotion.sounds }));
      const snd1 = await tap();
      await fp.click('#cm-sound-btn');
      const snd2 = await tap();
      const pressed = await fp.$eval('#cm-sound-btn', b => b.getAttribute('aria-pressed'));
      await fp.reload();
      await fp.waitForFunction(() => typeof renderPanel === 'function' && document.readyState === 'complete');
      const kept = await fp.$eval('#cm-sound-btn', b => b.getAttribute('aria-pressed'));
      ok('the key sound: off by default (a tap is silent), on with its switch (a tap clicks), remembered', snd0.pressed === 'false' && snd1 === snd0.n && pressed === 'true' && snd2 >= snd1 + 2 && kept === 'true', [snd0, snd1, pressed, snd2, kept]);
      await fp.click('#cm-sound-btn');
      // a toast that replaces another
      const tg = await fp.evaluate(async () => { toast('First message', 3000); await new Promise(r => setTimeout(r, 400)); toast('Second message', 3000); await new Promise(r => setTimeout(r, 60)); const g = [...document.querySelectorAll('.cm-toast-ghost')]; return { n: g.length, text: g[0] && g[0].textContent, now: document.getElementById('toast').textContent }; });
      ok('a toast that replaces another pushes the old one up as it goes', tg.n === 1 && tg.text === 'First message' && tg.now === 'Second message', tg);
      // the segmented chips: the panel takes the pick, the highlight slides to it
      await fp.$eval('#bcg-intro-dur', e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await fp.waitForTimeout(300);
      await fp.click('#bcg-intro-dur [data-v="30"]');
      await fp.waitForTimeout(80);
      const segMid = await fp.evaluate(() => { const g = document.getElementById('bcg-intro-dur'), on = g.querySelector('[aria-checked="true"]'), pill = g.querySelector('.cm-seg-pill'); return Math.round(Math.abs(on.getBoundingClientRect().left - pill.getBoundingClientRect().left)); });
      await fp.waitForTimeout(500);
      const seg = await fp.evaluate(() => { const g = document.getElementById('bcg-intro-dur'), on = g.querySelector('[aria-checked="true"]'), pill = g.querySelector('.cm-seg-pill'); const a = on.getBoundingClientRect(), b = pill.getBoundingClientRect(); return { v: on.dataset.v, d: Math.max(Math.abs(a.left - b.left), Math.abs(a.width - b.width)) }; });
      ok('a timing chip picked: the panel takes it, and the highlight slides onto it (on its way after 80 ms, there after 600)', seg.v === '30' && seg.d <= 1.5 && segMid > 3, [segMid, seg]);
      await F.ctx.close();
    }

    // ---- buttons release smoothly; the dropdown drops open
    const btn = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector('header button, #quick-nav button')); return [cs.transitionProperty, cs.transitionDuration]; });
    ok('buttons: transform, colours and shadow fade (the release is smooth, not a snap)', /transform/.test(btn[0]) && /background-color/.test(btn[0]) && /border-color/.test(btn[0]) && parseFloat(btn[1]) >= 0.12, btn);
    await closeAll();
    const trig = await page.$('.pro-dd-trigger');
    if(trig){
      await trig.scrollIntoViewIfNeeded(); await trig.click();
      const dd = await page.evaluate(() => { const p = document.querySelector('.pro-dd-panel'); return p ? { anims: p.getAnimations().map(a => a.animationName), shown: getComputedStyle(p).display } : null; });
      ok('the player dropdown drops open from its field', dd && dd.anims.includes('cmDrop') && dd.shown !== 'none', dd);
      await page.keyboard.press('Escape'); await page.mouse.click(5, 300);
    }

    // ---- a long session: hundreds of balls, modals again and again
    await page.waitForTimeout(500);
    const m0 = await metrics();
    await page.evaluate(async () => {
      for(let i = 0; i < 300; i++){
        const k = ['0', '1', '2', '1'][i % 4];
        recordBall(k);
        if(state.score.balls === 0) state.bowler = { name:'Yogesh Pawar', id:'p9', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
        if(i % 25 === 0){ const o = document.getElementById('extras-modal-overlay'); o.classList.add('show'); await new Promise(r => setTimeout(r, 10)); o.classList.remove('show'); }
        if(i % 10 === 0) await new Promise(r => setTimeout(r, 0));
      }
      document.querySelectorAll('.wicket-modal-overlay.show').forEach(o => o.classList.remove('show'));
      renderPanel();
    });
    await page.waitForTimeout(800);
    const m1 = await metrics();
    ok(`a long session (300 more balls, modals opened again and again): listeners stay put, no runaway nodes (${m0.listeners} → ${m1.listeners} listeners, ${m0.nodes} → ${m1.nodes} nodes, ${m0.heapMB} → ${m1.heapMB} MB)`,
      m1.listeners - m0.listeners <= 10 && m1.nodes - m0.nodes < 3000, [m0, m1]);
    await ctx.close();

    // ---- reduced motion: nothing moves
    const r = await open({ reducedMotion: 'reduce' });
    const rm = await r.page.evaluate(async () => {
      const ov = document.getElementById('extras-modal-overlay'); ov.classList.add('show');
      await new Promise(res => setTimeout(res, 30));
      const op = Number(getComputedStyle(ov).opacity);
      ov.classList.remove('show');
      document.querySelector('[data-ball="1"]').click(); await new Promise(res => setTimeout(res, 0));
      await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
      const h2 = document.querySelector('#card-session > h2'); h2.click(); const foldNow = document.getElementById('card-session').classList.contains('cm-folded'); h2.click();
      return { op, gone: getComputedStyle(ov).display, tick: document.getElementById('disp-crr').getAnimations().length, btn: getComputedStyle(document.querySelector('header button')).transitionDuration, rings: document.querySelectorAll('.cm-ring').length, odo: document.querySelectorAll('#disp-score .cm-odo').length, foldNow };
    });
    ok('reduced motion: modals at once, no number animation or odometer, no rings, a card folds at once, buttons change state at once', rm.op === 1 && rm.gone === 'none' && rm.tick === 0 && rm.rings === 0 && rm.odo === 0 && rm.foldNow && /^0s/.test(rm.btn), rm);
    await r.ctx.close();
    ok(`${P}: no page errors`, errors.length === 0, errors);
  }
  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
