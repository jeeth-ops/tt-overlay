// 🎚️ The interaction layer (cricket-motion.css / cricket-motion.js) in BOTH
// panels, each on its own, in Chromium against the real server:
//
// - at rest nothing looks different: every visible control keeps its box,
//   colours, radius, font, shadow (read against the panel with the layer
//   switched off), at 1366 x 768, 1440 x 900, 1600 x 900 and 1920 x 1080, and
//   there is no sideways scroll;
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
        if(opts && opts.noMotion && /cricket-motion\./.test(u.pathname)) return route.fulfill({ status: 200, contentType: /\.css$/.test(u.pathname) ? 'text/css' : 'text/javascript', body: '' });
        return route.continue();
      });
      await page.goto(`http://127.0.0.1:${port}/${P}?room=MO${Math.random().toString(36).slice(2, 7)}`);
      await page.waitForFunction(() => typeof renderPanel === 'function' && typeof state === 'object' && document.readyState === 'complete');
      await page.evaluate(SETUP);
      if(opts && opts.theme) await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), opts.theme);
      await page.mouse.move(1, 1);
      await page.waitForTimeout(700);
      return { ctx, page };
    };

    // ---- at rest: the same panel, with and without the layer
    const bad = [];
    for(const [w, h] of [[1366, 768], [1440, 900], [1600, 900], [1920, 1080]]){
      const a = await open({ viewport: { width: w, height: h }, noMotion: true }), b = await open({ viewport: { width: w, height: h } });
      const [la, lb] = [await a.page.evaluate(LOOK), await b.page.evaluate(LOOK)];
      const hs = await b.page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      for(const k of new Set([...Object.keys(la), ...Object.keys(lb)])){
        if(!la[k] || !lb[k]){ bad.push([w, k, la[k] ? 'gone' : 'new']); continue; }
        for(const p of Object.keys(la[k])) if(JSON.stringify(la[k][p]) !== JSON.stringify(lb[k][p])) bad.push([w, k, p, la[k][p], lb[k][p]]);
      }
      if(hs) bad.push([w, 'sideways scroll']);
      if(w === 1366) ok(`at rest, ${Object.keys(lb).length} controls compared`, Object.keys(lb).length > 100, Object.keys(lb).length);
      await a.ctx.close(); await b.ctx.close();
    }
    ok('at rest: every control keeps its box, colours, radius, font and shadow at 1366, 1440, 1600 and 1920 wide — and no sideways scroll', !bad.length, bad.slice(0, 8));
    {
      const a = await open({ noMotion: true, theme: 'light' }), b = await open({ theme: 'light' });
      const [la, lb] = [await a.page.evaluate(LOOK), await b.page.evaluate(LOOK)];
      const lbad = [];
      for(const k of new Set([...Object.keys(la), ...Object.keys(lb)])){
        if(!la[k] || !lb[k]){ lbad.push([k, la[k] ? 'gone' : 'new']); continue; }
        for(const p of Object.keys(la[k])) if(JSON.stringify(la[k][p]) !== JSON.stringify(lb[k][p])) lbad.push([k, p, la[k][p], lb[k][p]]);
      }
      ok(`… and in the light theme too (${Object.keys(lb).length} controls)`, !lbad.length && await b.page.evaluate(() => document.documentElement.getAttribute('data-theme') === 'light'), lbad.slice(0, 8));
      await a.ctx.close(); await b.ctx.close();
    }

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
      return { op, gone: getComputedStyle(ov).display, tick: document.getElementById('disp-crr').getAnimations().length, btn: getComputedStyle(document.querySelector('header button')).transitionDuration };
    });
    ok('reduced motion: modals at once, no number animation, buttons change state at once', rm.op === 1 && rm.gone === 'none' && rm.tick === 0 && /^0s/.test(rm.btn), rm);
    await r.ctx.close();
    ok(`${P}: no page errors`, errors.length === 0, errors);
  }
  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
