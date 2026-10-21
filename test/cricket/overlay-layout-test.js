// cricket-overlay.html — the score bar's geometry and the chase panel, in a
// real Chromium, measured from the rendered page (bounding boxes, not CSS).
//
//   • The bar fits every output it is used at — 1920x1080, 1920x1280 (the
//     Stream Engine's layout for a 720x480 programme), 1536x864, 1366x768,
//     1280x720 (the Stream Engine's capture window is the laptop screen, at
//     least this), 854x480: every text on it on screen, none cut by its box,
//     none on top of another text or a logo / ball pip / badge — in every
//     state the panel sends (first innings, chase, last over, last ball,
//     target reached, all out, scores level, Super Over, Test, free hit, an
//     empty crease, innings break, result, long names and team names).
//   • The chase panel says what the state says: the real target, NEED x FROM
//     y BALLS, the required rate, FINAL OVER / LAST BALL, TARGET REACHED,
//     ALL OUT, SCORES LEVEL — and nothing for a target that is not this
//     innings' (a 1st innings, a Super Over's 1st innings) or once the
//     result is up.
//   • A figure losing a digit (120 balls -> 99) moves nothing beside it.
//   • Frame by frame through the things that move the bar — its entrance
//     with long names, a score going 9 -> 10 -> 100, a new batter and bowler,
//     five updates in 250 ms, a FOUR / WICKET graphic with scores arriving
//     under it, the innings changing, the chase ending, a resize — no frame
//     has two texts on top of each other, a text off the screen or cut by
//     its box (the score's rolling digits are cut by their own column: that
//     is the odometer, not a defect).
//   • The innings-break strip keeps its full size when a webfont finishes
//     loading during its reveal; TOSS and the team record fit a 480p output.
//
// Run:  NODE_PATH=$(npm root -g) node test/cricket/overlay-layout-test.js
//       (needs playwright + a chromium. gsap and the webfonts are served from
//        node_modules when they are installed — npm install --no-save
//        gsap@3.12.5 @fontsource/inter @fontsource/manrope @fontsource/anton —
//        and fetched from their CDNs otherwise)
//       SHOTS=<dir> also saves a picture of the bar in every state and size.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const SHOTS = process.env.SHOTS || '';
if(SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// ---------- the page: the repo's files, a stand-in socket, local gsap/fonts when present ----------
const tryResolve = (p) => { try { return require.resolve(p); } catch(e){ return null; } };
const GSAP = tryResolve('gsap/dist/gsap.min.js');
const fontFiles = {};
const fontCss = (() => {
  const out = [];
  for(const [fam, pkg, weights] of [['Inter', 'inter', [500, 600, 700, 800, 900]], ['Manrope', 'manrope', [600, 700, 800]], ['Anton', 'anton', [400]]]){
    const dir = tryResolve(`@fontsource/${pkg}/package.json`);
    if(!dir) return null;
    for(const wt of weights) for(const sub of ['latin', 'latin-ext']){
      const f = path.join(path.dirname(dir), 'files', `${pkg}-${sub}-${wt}-normal.woff2`);
      if(!fs.existsSync(f)) continue;
      fontFiles[path.basename(f)] = f;
      out.push(`@font-face{font-family:'${fam}';font-style:normal;font-weight:${wt};font-display:block;src:url(/__font/${path.basename(f)}) format('woff2');}`);
    }
  }
  return out.join('\n');
})();
const SOCKET = `window.__h={};window.io=function(){const s={on:(e,f)=>{(window.__h[e]=window.__h[e]||[]).push(f);return s},emit:()=>s,connected:true,disconnect(){},io:{on(){}}};setTimeout(()=>(window.__h.connect||[]).forEach(f=>f()),0);return s};window.__emit=(e,d)=>(window.__h[e]||[]).forEach(f=>f(d));`;
async function open(browser, w, h){
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if(u.hostname === 'cdnjs.cloudflare.com' && GSAP) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(GSAP) });
    if(u.hostname === 'fonts.googleapis.com' && fontCss) return route.fulfill({ contentType: 'text/css', body: fontCss });
    if(u.hostname !== 'overlay.test') return route.continue();
    if(u.pathname === '/socket.io/socket.io.js') return route.fulfill({ contentType: 'text/javascript', body: SOCKET });
    if(u.pathname.startsWith('/__font/')) return route.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(fontFiles[path.basename(u.pathname)]) });
    const f = path.join(ROOT, decodeURIComponent(u.pathname));
    if(f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ path: f });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://overlay.test/cricket-overlay.html?room=LAYOUT');
  await page.evaluate(() => document.fonts.ready);
  if(!(await page.evaluate(() => !!window.gsap))) throw new Error('gsap did not load — install it (npm install --no-save gsap@3.12.5) or allow cdnjs.cloudflare.com');
  await page.evaluate(`window.__audit = ${audit}`);
  return { ctx, page, errors, emit: (ev, d) => page.evaluate(([ev, d]) => window.__emit(ev, d), [ev, d]) };
}

// ---------- the measurement: runs in the page ----------
// Every visible text under `roots` (glyph boxes from Range rects; the middle
// 70% of each line's height, the rest being the font's own leading), and:
//   OFFSCREEN  — a text, or one of the `icons`, past the edge of the screen
//   CLIPPED    — a text cut by a box that clips it (overflow) — unless that
//                box is one of the `masks` (a deliberate mask: the odometer)
//   CLIP-PATH  — a text cut by a clip-path polygon (the caps' slanted ends)
//   OVERLAP    — two texts on top of each other (the parts of them on screen)
//   ON-ICON    — a text on a logo / pip / badge it is not part of
function audit(o){
  const { roots, icons = '', masks = [], minOpacity = 0.04, clipPath = true } = o;
  const vw = innerWidth, vh = innerHeight, out = [], tol = 1;
  const shown = (el) => {
    let op = 1;
    for(let e = el; e && e.nodeType === 1; e = e.parentElement){
      const cs = getComputedStyle(e);
      if(cs.display === 'none' || cs.visibility === 'hidden') return false;
      op *= parseFloat(cs.opacity);
      if(op < minOpacity) return false;
    }
    return true;
  };
  const name = (el) => el.id ? '#' + el.id : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  const where = (el) => { const p = []; for(let e = el; e && p.length < 3; e = e.parentElement){ p.unshift(name(e)); if(e.id) break; } return p.join(' > '); };
  const core = (r) => { const s = r.height * 0.15; return { l: r.left, r: r.right, t: r.top + s, b: r.bottom - s }; };
  const hit = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > tol && Math.min(a.b, b.b) - Math.max(a.t, b.t) > tol;
  const texts = [];
  for(const sel of roots) for(const root of document.querySelectorAll(sel)){
    if(!shown(root)) continue;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for(let n; (n = walk.nextNode());){
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if(!t || !shown(n.parentElement)) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      const lines = [...r.getClientRects()].filter(x => x.width > 0.5 && x.height > 0.5);
      if(!lines.length) continue;
      const clips = [];
      for(let a = n.parentElement; a && a !== document.body; a = a.parentElement){
        const cs = getComputedStyle(a);
        if(cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clips.push(a.getBoundingClientRect());
      }
      const vis = lines.map(L => clips.reduce((v, c) => ({ left: Math.max(v.left, c.left), top: Math.max(v.top, c.top), right: Math.min(v.right, c.right), bottom: Math.min(v.bottom, c.bottom) }), { left: L.left, top: L.top, right: L.right, bottom: L.bottom }))
        .filter(v => v.right - v.left > 0.5 && v.bottom - v.top > 0.5).map(v => ({ ...v, height: v.bottom - v.top }));
      texts.push({ el: n.parentElement, t: t.slice(0, 40), lines, vis, box: r.getBoundingClientRect() });
    }
  }
  for(const x of texts){
    const b = x.box;
    if(b.left < -tol || b.right > vw + tol || b.top < -tol || b.bottom > vh + tol) out.push(`OFFSCREEN "${x.t}" (${where(x.el)})`);
    for(let a = x.el; a && a !== document.body; a = a.parentElement){
      const cs = getComputedStyle(a), ar = a.getBoundingClientRect();
      if((cs.overflowX !== 'visible' || cs.overflowY !== 'visible') && !masks.some(m => a.matches(m))){
        // (its own scale on each axis: the bar's entrance scales the middle band in x only)
        const kx = ar.width / (a.offsetWidth || ar.width || 1), ky = ar.height / (a.offsetHeight || ar.height || 1);
        const box = { l: ar.left + a.clientLeft * kx, t: ar.top + a.clientTop * ky, r: ar.left + (a.clientLeft + a.clientWidth) * kx, b: ar.top + (a.clientTop + a.clientHeight) * ky };
        if(x.lines.some(L => { const c = core(L); return L.left < box.l - tol || L.right > box.r + tol || c.t < box.t - tol || c.b > box.b + tol; })){
          out.push(`CLIPPED "${x.t}" (${where(x.el)}) by ${name(a)}`); break;
        }
      }
      const m = clipPath && /^polygon\((.*)\)$/.exec(cs.clipPath || '');
      if(m && cs.transform === 'none'){
        const v = (s, ref) => s.endsWith('%') ? parseFloat(s) / 100 * ref : parseFloat(s);
        const pts = m[1].split(',').map(p => { const [px, py] = p.trim().split(/\s+/); return [ar.left + v(px, ar.width), ar.top + v(py, ar.height)]; });
        const inside = (X, Y) => { let c = false; for(let i = 0, j = pts.length - 1; i < pts.length; j = i++){ const [xi, yi] = pts[i], [xj, yj] = pts[j]; if(((yi > Y) !== (yj > Y)) && (X < (xj - xi) * (Y - yi) / (yj - yi) + xi)) c = !c; } return c; };
        if(x.lines.some(L => { const c = core(L); return ![[c.l + tol, c.t], [c.r - tol, c.t], [c.l + tol, c.b], [c.r - tol, c.b]].every(([X, Y]) => inside(X, Y)); })){
          out.push(`CLIP-PATH "${x.t}" (${where(x.el)}) by ${name(a)}`); break;
        }
      }
    }
  }
  for(let i = 0; i < texts.length; i++) for(let j = i + 1; j < texts.length; j++){
    const A = texts[i], B = texts[j];
    if(A.el === B.el || A.el.contains(B.el) || B.el.contains(A.el)) continue;
    if(A.vis.some(a => B.vis.some(b => hit(core(a), core(b))))) out.push(`OVERLAP "${A.t}" (${where(A.el)}) x "${B.t}" (${where(B.el)})`);
  }
  if(icons) for(const ic of document.querySelectorAll(icons)){
    if(!shown(ic)) continue;
    const r = ic.getBoundingClientRect();
    if(r.width < 1 || r.height < 1) continue;
    if(r.left < -tol || r.right > vw + tol) out.push(`OFFSCREEN ${where(ic)}`);
    for(const x of texts) if(!ic.contains(x.el) && !x.el.contains(ic) && x.vis.some(L => hit(core(L), { l: r.left, r: r.right, t: r.top, b: r.bottom }))) out.push(`ON-ICON "${x.t}" (${where(x.el)}) x ${where(ic)}`);
  }
  return [...new Set(out)];
}
const BAR = { roots: ['#scorecard'], icons: '#scorecard .cap-logo, #thisover-row .pip, #overs-badge, #so-badge, #test-day-badge, #res-badge, #ch-plate', masks: ['.digit-col'] };
// frame by frame the caps' entrance / side-swap animate their clip-path on purpose (a reveal)
const BAR_MOVING = { ...BAR, clipPath: false };
const EVENT = { roots: ['#event-stage'], minOpacity: 0.04, clipPath: false };

// ---------- the states ----------
const LOGO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#fc0"/></svg>');
const TA = { name: 'Royal Strikers XI', short: 'RSX', color: '#1d4ed8', logoUrl: '' };
const TB = { name: 'Parel Sporting Club', short: 'PSC', color: '#b91c1c', logoUrl: '' };
const LONG_A = { name: 'Dr. D Y Patil Sports Academy Cricket Club Red', short: 'DYPSA', color: '#0f766e', logoUrl: LOGO };
const LONG_B = { name: 'New Hind Sporting Club Mumbai Gymkhana', short: 'NHSCM', color: '#fde047', logoUrl: LOGO };
const LONG1 = { name: 'Mohammed Abdul Rahman Siddiqui', id: 'l1', runs: 104, balls: 61 };
const LONG2 = { name: 'Venkatasubramanian Raghunathan', id: 'l2', runs: 99, balls: 88 };
const LONGB = { name: 'Christopher Fitzgerald-Montgomery', id: 'lb', overs: 9, balls: 5, runs: 47, wickets: 3 };
const pl = (name, id, runs, balls) => ({ name, id, runs, balls });
const bw = (name, id, overs, balls, runs, wickets) => ({ name, id, overs, balls, runs, wickets });
function st(o){
  return Object.assign({ visible: true, format: 'T20', oversPerInnings: 20, phase: 'REGULATION', inningsNumber: 1, battingTeam: 'A', teamA: TA, teamB: TB, theme: {},
    score: { runs: 0, wickets: 0, overs: 0, balls: 0 }, striker: pl('Rohit', 's1', 0, 0), nonStriker: pl('Virat', 's2', 0, 0), bowler: bw('Ankit', 'b1', 0, 0, 0, 0),
    thisOver: [], milestonesHit: {}, target: null, inningsArchive: [], dismissedThisInnings: { A: [], B: [] } }, o);
}
const chase = (o) => st(Object.assign({ inningsNumber: 2, battingTeam: 'B', target: 142, inningsArchive: [{ no: 1, team: 'A', runs: 141, wickets: 6, overs: '20.0' }] }, o));
const sc = (runs, wickets, overs, balls) => ({ runs, wickets, overs, balls });
const ODI1 = [{ no: 1, team: 'A', runs: 286, wickets: 7, overs: '50.0' }];
const TEST3 = [{ no: 1, team: 'A', runs: 237, wickets: 10, overs: '70.1' }, { no: 2, team: 'B', runs: 241, wickets: 10, overs: '80.0' }, { no: 3, team: 'A', runs: 290, wickets: 10, overs: '88.2' }];
const S = {
  'first innings': st({ score: sc(87, 2, 11, 3), striker: pl('Rohit', 's1', 45, 30), nonStriker: pl('Virat', 's2', 32, 25), bowler: bw('Ankit', 'b1', 2, 3, 18, 1), thisOver: ['1', '0', '4'] }),
  'first innings, long names, 9 deliveries': st({ teamA: LONG_A, teamB: LONG_B, format: 'ODI', oversPerInnings: 50, score: sc(312, 9, 49, 5), striker: LONG1, nonStriker: LONG2, bowler: LONGB, thisOver: ['Wd', '1', 'Nb4', 'W', '0', 'LB1', '6', 'Wd2', 'B4'] }),
  'chase starts': chase({ striker: pl('Himesh', 'p1', 0, 0), nonStriker: pl('Raj', 'p2', 0, 0), bowler: bw('Ankit Sharma', 'b9', 0, 0, 0, 0) }),
  'chase (the screenshot)': chase({ score: sc(20, 0, 0, 4), striker: pl('Himesh', 'p1', 20, 4), nonStriker: pl('Raj', 'p2', 0, 0), bowler: bw('Ankit Sharma', 'b9', 0, 4, 20, 0), thisOver: ['4', '6', '4', '6'] }),
  'chase, long names, light team colour': chase({ teamA: LONG_A, teamB: LONG_B, format: 'ODI', oversPerInnings: 50, target: 287, inningsArchive: ODI1, score: sc(203, 8, 43, 2), striker: LONG1, nonStriker: LONG2, bowler: LONGB, thisOver: ['Wd', '1', 'Nb4', 'W', '0', 'LB1', '6', 'Wd2'] }),
  'chase, final over': chase({ score: sc(128, 6, 19, 0), striker: pl('Jadeja', 'p1', 30, 18), nonStriker: pl('Pandya', 'p2', 22, 12), bowler: bw('Starc', 'b9', 3, 0, 31, 2) }),
  'chase, last ball': chase({ score: sc(137, 7, 19, 5), striker: pl('Jadeja', 'p1', 38, 20), nonStriker: pl('Bumrah', 'p2', 1, 2), bowler: bw('Starc', 'b9', 3, 5, 40, 3), thisOver: ['1', '2', 'W', '4', '1'] }),
  'chase, 1 run needed': chase({ score: sc(141, 6, 18, 2), striker: pl('Pandya', 'p1', 50, 20), nonStriker: pl('Karthik', 'p2', 11, 5), bowler: bw('Rabada', 'b9', 3, 2, 33, 1), thisOver: ['1', '1'] }),
  'chase, free hit': chase({ freeHit: true, score: sc(98, 4, 15, 3), striker: pl('Pant', 'p1', 40, 22), nonStriker: pl('Iyer', 'p2', 30, 25), bowler: bw('Archer', 'b9', 2, 3, 25, 1), thisOver: ['1', 'Nb', '4'] }),
  'chase, empty crease, no bowler yet': chase({ score: sc(66, 3, 9, 1), striker: pl('Gill', 'p1', 12, 10), nonStriker: pl('Shaw', 'p2', 30, 22), bowler: { name: '', id: '' }, dismissedThisInnings: { A: [], B: ['p1'] }, thisOver: ['W'] }),
  'chase, target reached (result not called yet)': chase({ score: sc(145, 4, 18, 4), striker: pl('Pandya', 'p1', 55, 22), nonStriker: pl('Karthik', 'p2', 11, 5), bowler: bw('Rabada', 'b9', 3, 4, 37, 1), thisOver: ['1', '1', '6', '4'] }),
  'chase, all out (result not called yet)': chase({ score: sc(120, 10, 18, 1), striker: pl('Bumrah', 'p1', 2, 4), nonStriker: pl('Shami', 'p2', 1, 3), dismissedThisInnings: { A: [], B: ['p1'] }, bowler: bw('Rabada', 'b9', 3, 1, 21, 4), thisOver: ['W'] }),
  'chase, scores level after the last ball': chase({ score: sc(141, 7, 20, 0), striker: pl('Jadeja', 'p1', 38, 20), nonStriker: pl('Bumrah', 'p2', 1, 2), bowler: bw('Starc', 'b9', 4, 0, 40, 3), thisOver: ['1', '2', 'W', '4', '1', '1'] }),
  'Test, 4th innings chase': st({ format: 'Test', oversPerInnings: null, dayNumber: 5, inningsNumber: 4, battingTeam: 'B', target: 287, inningsArchive: TEST3, score: sc(167, 4, 51, 2), striker: pl('Pujara', 'p1', 60, 160), nonStriker: pl('Rahane', 'p2', 40, 90), bowler: bw('Lyon', 'b9', 20, 2, 61, 2), thisOver: ['0', '0'] }),
  'Test, day badge, no chase': st({ format: 'Test', oversPerInnings: null, dayNumber: 3, inningsNumber: 3, inningsArchive: TEST3.slice(0, 2), score: sc(156, 4, 51, 2), striker: pl('Pujara', 'p1', 60, 160), nonStriker: pl('Rahane', 'p2', 40, 90), bowler: bw('Lyon', 'b9', 20, 2, 61, 2), thisOver: ['0', '0'] }),
  'Super Over chase': chase({ phase: 'SUPER_OVER', superOver: { number: 1, inningsIndex: 1 }, target: 12, score: sc(5, 1, 0, 3), striker: pl('Russell', 'p1', 5, 2), nonStriker: pl('Narine', 'p2', 0, 0), bowler: bw('Boult', 'b9', 0, 3, 5, 1), thisOver: ['4', 'W', '1'] }),
  'Super Over 1st innings, regulation target still in the state': chase({ phase: 'SUPER_OVER', superOver: { number: 1, inningsIndex: 0 }, score: sc(9, 1, 0, 4), striker: pl('Russell', 'p1', 9, 3), nonStriker: pl('Narine', 'p2', 0, 1), bowler: bw('Boult', 'b9', 0, 4, 9, 1), thisOver: ['4', '4', 'W', '1'] }),
  '1st innings, a target still in the state': st({ target: 142, score: sc(30, 1, 4, 0) }),
  'innings break': st({ score: sc(141, 6, 20, 0), milestonesHit: { 'innings-complete': true } }),
  'chase won': chase({ score: sc(143, 5, 19, 2), milestonesHit: { 'match-result': true }, matchResultText: 'PSC WON BY 5 WICKETS', matchWinnerKey: 'B' }),
  'tied, Super Over to follow': chase({ score: sc(141, 8, 20, 0), superOverReady: true })
};
const SIZES = [[1920, 1080], [1920, 1280], [1536, 864], [1366, 768], [1280, 720], [854, 480]];

// what the chase panel says (null: not up)
const chaseText = (page) => page.evaluate(() => {
  const seg = document.getElementById('crr-seg');
  if(seg.style.display === 'none') return null;
  const t = (id) => { const e = document.getElementById(id); return e && !e.hidden && e.offsetParent ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
  const visibleText = (id) => { const e = document.getElementById(id); return e && !e.hidden ? [...e.children].filter(c => !c.hidden).map(c => c.textContent.trim()).join(' ') : null; };
  return { target: t('ch-target'), line: t('ch-state') || visibleText('ch-eq'), rate: visibleText('ch-rate') || null };
});

async function barMatrix(browser){
  console.log('\n######## The bar fits every output, in every state ########');
  for(const [w, h] of SIZES){
    const O = await open(browser, w, h);
    let bad = [];
    for(const [id, s] of Object.entries(S)){
      await O.emit('liveCricketScore', s);
      await O.page.waitForTimeout(900);
      const issues = await O.page.evaluate((o) => window.__audit(o), BAR);
      const bar = await O.page.evaluate(() => { const r = document.getElementById('top-row').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; });
      if(bar[0] < 0 || bar[1] > w) issues.push(`BAR ${bar[0]}..${bar[1]} wider than ${w}`);
      if(issues.length) bad.push({ state: id, issues: issues.slice(0, 4) });
      if(SHOTS){
        const b = await O.page.evaluate(() => { const r = document.getElementById('scorecard').getBoundingClientRect(); return { y: r.y, h: r.height }; });
        await O.page.screenshot({ path: path.join(SHOTS, `bar-${w}x${h}-${id.replace(/[^a-z0-9]+/gi, '-')}.png`), clip: { x: 0, y: Math.max(0, b.y - 30), width: w, height: Math.min(h - Math.max(0, b.y - 30), b.h + 40) } });
      }
    }
    eq(`${w}x${h}: all ${Object.keys(S).length} states — nothing off screen, cut, or on top of anything else`, bad, []);
    eq(`${w}x${h}: no script errors`, O.errors, []);
    await O.ctx.close();
  }
  // the long names as the very first state after the page loads — measured
  // through the bar's entrance (the middle band at scaleX 0), this used to
  // leave the names at full size and the right-hand cap off the screen
  for(const [w, h] of [[1920, 1080], [1280, 720]]){
    const O = await open(browser, w, h);
    await O.emit('liveCricketScore', S['chase, long names, light team colour']);
    await O.page.waitForTimeout(1500);
    const capR = await O.page.evaluate(() => Math.round(document.getElementById('cap-right').getBoundingClientRect().right));
    eq(`${w}x${h}: long names as the first state — the bar ends on the screen, everything fits`, [capR <= w, await O.page.evaluate((o) => window.__audit(o), BAR)], [true, []]);
    await O.ctx.close();
  }
}

async function chasePanel(browser){
  console.log('\n######## The chase panel says what the state says ########');
  const O = await open(browser, 1920, 1080);
  const say = async (id) => { await O.emit('liveCricketScore', S[id]); await O.page.waitForTimeout(700); return chaseText(O.page); };
  eq('the screenshot: the real target (122 was the runs needed, under a TARGET label)', await say('chase (the screenshot)'), { target: '142', line: 'NEED 122 FROM 116 BALLS', rate: 'REQ. RATE 6.31' });
  eq('the chase starts', await say('chase starts'), { target: '142', line: 'NEED 142 FROM 120 BALLS', rate: 'REQ. RATE 7.10' });
  eq('final over: tagged', await say('chase, final over'), { target: '142', line: 'NEED 14 FROM 6 BALLS', rate: 'REQ. RATE 14.00 FINAL OVER' });
  eq('last ball: BALL, singular, tagged', await say('chase, last ball'), { target: '142', line: 'NEED 5 FROM 1 BALL', rate: 'REQ. RATE 30.00 LAST BALL' });
  eq('one run needed', await say('chase, 1 run needed'), { target: '142', line: 'NEED 1 FROM 10 BALLS', rate: 'REQ. RATE 0.60' });
  eq('three-digit figures (ODI)', await say('chase, long names, light team colour'), { target: '287', line: 'NEED 84 FROM 40 BALLS', rate: 'REQ. RATE 12.60' });
  eq('past the target before the result: TARGET REACHED, never "need 0"', await say('chase, target reached (result not called yet)'), { target: '142', line: 'TARGET REACHED', rate: '8 BALLS TO SPARE' });
  eq('all out before the result: ALL OUT, never a "need" that cannot happen', await say('chase, all out (result not called yet)'), { target: '142', line: 'ALL OUT', rate: null });
  eq('balls used up one short: SCORES LEVEL', await say('chase, scores level after the last ball'), { target: '142', line: 'SCORES LEVEL', rate: null });
  eq('Test 4th innings: runs and wickets left, no balls or rate', await say('Test, 4th innings chase'), { target: '287', line: 'NEED 120 RUNS', rate: 'WICKETS LEFT 6' });
  eq('Super Over chase: its own target, no FINAL OVER tag (the whole thing is one over)', await say('Super Over chase'), { target: '12', line: 'NEED 7 FROM 3 BALLS', rate: 'REQ. RATE 14.00' });
  eq('a target from another innings is never shown — Super Over 1st innings', await say('Super Over 1st innings, regulation target still in the state'), null);
  eq('… or a 1st innings', await say('1st innings, a target still in the state'), null);
  eq('first innings: no chase panel', await say('first innings'), null);
  eq('the result is up: the chase panel goes with the live strip', await say('chase won'), null);
  eq('a tie to be settled by a Super Over: no stale "need 1 off 0"', await say('tied, Super Over to follow'), null);
  eq('the required rate lives in the chase panel only — the line under the score is CRR', await O.page.evaluate(() => document.getElementById('score-rate-line').textContent.replace(/\s+/g, ' ').trim()), 'CRR 7.05');

  // a figure losing a digit moves nothing beside it
  const base = { striker: pl('Himesh', 'p1', 60, 40), nonStriker: pl('Raj', 'p2', 30, 30), bowler: bw('Ankit Sharma', 'b9', 3, 2, 30, 1) };
  const geo = () => O.page.evaluate(() => ['ch-plate', 'crr-seg', 'batters-seg', 'bowler-seg', 'striker-name'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; }).concat([getComputedStyle(document.getElementById('striker-name')).fontSize]));
  await O.emit('liveCricketScore', chase({ target: 250, ...base, score: sc(150, 1, 0, 0) }));
  await O.page.waitForTimeout(700);
  const g1 = await geo();
  await O.emit('liveCricketScore', chase({ target: 250, ...base, score: sc(151, 1, 3, 3) }));
  await O.page.waitForTimeout(700);
  const g2 = await geo();
  eq('need 100 -> 99 and balls 120 -> 99: the plate, the segments and the names stay put', g2, g1);

  // names: full while they fit; the scorecard form (initials + surname) when one cannot
  await O.emit('liveCricketScore', S['first innings, long names, 9 deliveries']);
  await O.page.waitForTimeout(800);
  eq('long names that fit their segments: shown in full', await O.page.evaluate(() => ['striker-name', 'nonstriker-name', 'bowler-name-val'].map(id => document.getElementById(id).textContent)), [LONG1.name, LONG2.name, LONGB.name]);
  await O.emit('liveCricketScore', S['chase, long names, light team colour']);
  await O.page.waitForTimeout(800);
  eq('with the chase panel beside them: initials + surname, one shared size',
    await O.page.evaluate(() => { const els = ['striker-name', 'nonstriker-name', 'bowler-name-val'].map(id => document.getElementById(id)); return [els.map(e => e.textContent), new Set(els.map(e => getComputedStyle(e).fontSize)).size]; }),
    [['MAR Siddiqui', 'V Raghunathan', 'C Fitzgerald-Montgomery'], 1]);
  eq('the score on a light team colour is in dark ink, not white', await O.page.evaluate(() => getComputedStyle(document.getElementById('score-value')).color), 'rgb(20, 17, 10)');
  eq('no script errors', O.errors, []);
  await O.ctx.close();
}

async function frames(browser){
  console.log('\n######## Frame by frame: nothing collides while it moves ########');
  const p = (o) => chase(Object.assign({ striker: pl('Himesh', 'p1', 9, 7), nonStriker: pl('Raj', 'p2', 0, 0), bowler: bw('Ankit Sharma', 'b9', 1, 3, 9, 0) }, o));
  const FOUR = { kind: 'FOUR', sub: 'Himesh', data: { batter: { name: 'Himesh', runs: 13, balls: 8 }, bowler: 'Ankit Sharma', batTeam: { name: 'Parel Sporting Club', short: 'PSC', color: '#b91c1c' }, bowlTeam: { name: 'Royal Strikers XI', short: 'RSX', color: '#1d4ed8' } } };
  const WICKET = { kind: 'WICKET', sub: LONG1.name, data: { batter: { name: LONG1.name, runs: 104, balls: 61 }, howOut: 'c ' + LONGB.name + ' b Venkatasubramanian', score: '203/9', batTeam: { name: 'Parel Sporting Club', short: 'PSC', color: '#b91c1c' } } };
  const SCENES = [
    ['the entrance, long names as the first state', 1800, async (O) => { await O.emit('liveCricketScore', S['chase, long names, light team colour']); }],
    ['score / need / balls changing digits: 9 -> 10 -> 100', 2600, async (O) => {
      await O.emit('liveCricketScore', p({ score: sc(9, 0, 1, 3), thisOver: ['1', '4', '4'] })); await O.page.waitForTimeout(900);
      await O.emit('liveCricketScore', p({ score: sc(10, 0, 1, 4), thisOver: ['1', '4', '4', '1'] })); await O.page.waitForTimeout(500);
      await O.emit('liveCricketScore', p({ target: 250, score: sc(100, 0, 13, 4), striker: pl('Himesh', 'p1', 99, 60), thisOver: ['1'] })); await O.page.waitForTimeout(500);
      await O.emit('liveCricketScore', p({ target: 250, score: sc(101, 0, 13, 5), striker: pl('Himesh', 'p1', 100, 61), thisOver: ['1', '1'] }));
    }],
    ['a new batter and bowler with long names, strike changed', 1800, async (O) => {
      await O.emit('liveCricketScore', p({ score: sc(30, 1, 4, 0), striker: pl('Raj', 'p2', 3, 5), nonStriker: LONG2, bowler: { ...LONGB, overs: 0, balls: 0, runs: 0, wickets: 0 } }));
    }],
    ['five updates within 250 ms', 1800, async (O) => {
      for(let i = 0; i < 5; i++){ await O.emit('liveCricketScore', p({ score: sc(40 + i * 4, 1, 5, i + 1), thisOver: Array(i + 1).fill('4') })); await O.page.waitForTimeout(50); }
    }],
    ['FOUR, then a WICKET queued behind it, scores arriving under both', 9000, async (O) => {
      await O.emit('cricketEvent', FOUR); await O.page.waitForTimeout(300);
      await O.emit('liveCricketScore', p({ score: sc(66, 1, 6, 1), striker: pl('Himesh', 'p1', 13, 8), thisOver: ['4'] }));
      await O.page.waitForTimeout(4300);
      await O.emit('cricketEvent', WICKET);
      await O.emit('liveCricketScore', p({ score: sc(66, 2, 6, 2), thisOver: ['4', 'W'] }));
    }],
    ['the chase ending: one run needed -> reached -> result', 2600, async (O) => {
      await O.emit('liveCricketScore', S['chase, 1 run needed']); await O.page.waitForTimeout(800);
      await O.emit('liveCricketScore', S['chase, target reached (result not called yet)']); await O.page.waitForTimeout(800);
      await O.emit('liveCricketScore', S['chase won']);
    }],
    ['the innings changing: 1st innings -> break -> chase', 2800, async (O) => {
      await O.emit('liveCricketScore', S['first innings']); await O.page.waitForTimeout(800);
      await O.emit('liveCricketScore', S['innings break']); await O.page.waitForTimeout(1200);
      await O.emit('liveCricketScore', S['chase starts']);
    }],
    ['free hit on and off', 1800, async (O) => {
      await O.emit('liveCricketScore', S['chase, free hit']); await O.page.waitForTimeout(700);
      await O.emit('liveCricketScore', { ...S['chase, free hit'], freeHit: false });
    }],
    ['the output resized mid-chase', 1200, async (O, w, h) => {
      await O.page.setViewportSize({ width: Math.round(w * 0.7), height: Math.round(h * 0.7) }); await O.page.waitForTimeout(400);
      await O.page.setViewportSize({ width: w, height: h });
    }]
  ];
  for(const [w, h] of [[1920, 1080], [854, 480]]){
    const O = await open(browser, w, h);
    for(const [name, ms, run] of SCENES){
      await O.page.evaluate(([BAR, EV]) => {
        window.__found = new Set(); window.__frames = 0; window.__sampling = true;
        const tick = () => {
          if(!window.__sampling) return;
          window.__frames++;
          for(const o of [BAR, EV]) for(const i of window.__audit(o)) window.__found.add(i);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, [BAR_MOVING, EVENT]);
      await run(O, w, h);
      await O.page.waitForTimeout(ms);
      const r = await O.page.evaluate(() => { window.__sampling = false; return { frames: window.__frames, issues: [...window.__found].slice(0, 6) }; });
      eq(`${w}x${h}: ${name} — ${r.frames > 20 ? 'every frame' : r.frames + ' frames (too few?)'} clean`, r.issues, []);
    }
    eq(`${w}x${h}: no script errors`, O.errors, []);
    await O.ctx.close();
  }
}

async function stripsAndCards(browser){
  console.log('\n######## The innings-break strip; TOSS and the team record on a small output ########');
  {
    const O = await open(browser, 1920, 1080);
    await O.emit('liveCricketScore', S['innings break']);
    await O.page.waitForTimeout(1600);
    eq('the break strip at full size — a webfont arriving during its reveal no longer shrinks it and drops the rate',
      await O.page.evaluate(() => { const seg = document.getElementById('break-seg'); return [seg.style.getPropertyValue('--es'), seg.className.includes('narrow'), document.getElementById('break-rrr').textContent, getComputedStyle(document.getElementById('break-item-b')).display]; }),
      ['1', false, '7.10', 'flex']);
    await O.ctx.close();
  }
  const toss = { team: { name: LONG_A.name, short: 'DYP', color: '#0f766e', logoUrl: '' }, decision: 'BAT', decisionText: 'ELECTED TO BAT FIRST' };
  const teamStat = { teamName: LONG_B.name, teamShort: 'NHS', teamColor: '#fde047', teamLogo: '', matches: 7, won: 5, lost: 2, tied: 0, winPct: 71, highest: 211, avgScore: 168 };
  for(const [w, h] of [[854, 480], [1280, 720], [1920, 1080]]){
    for(const [ev, d, id] of [['cricketToss', toss, 'toss-card'], ['cricketTeamStat', teamStat, 'team-stat-card']]){
      const O = await open(browser, w, h);
      await O.emit('liveCricketScore', S['first innings']);
      await O.page.waitForTimeout(1200);
      await O.emit(ev, d);
      await O.page.waitForTimeout(1800);
      const r = await O.page.evaluate((id) => {
        const c = document.getElementById(id).getBoundingClientRect(), b = document.getElementById('top-row').getBoundingClientRect();
        return { onScreen: c.top >= 0 && c.left >= 0 && c.right <= innerWidth && c.bottom <= innerHeight, clearOfBar: c.bottom <= b.top };
      }, id);
      const issues = await O.page.evaluate((id) => window.__audit({ roots: ['#' + id], minOpacity: 0.15 }), id);
      eq(`${w}x${h}: ${id} — on the screen, clear of the score bar, nothing cut or overlapping`, [r, issues], [{ onScreen: true, clearOfBar: true }, []]);
      await O.ctx.close();
    }
  }
}

(async () => {
  console.log(`(gsap: ${GSAP ? 'node_modules' : 'CDN'}; fonts: ${fontCss ? 'node_modules' : 'Google Fonts'})`);
  const browser = await chromium.launch();
  try {
    await barMatrix(browser);
    await chasePanel(browser);
    await frames(browser);
    await stripsAndCards(browser);
  } finally {
    await browser.close();
  }
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
