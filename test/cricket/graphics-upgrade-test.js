// 🎨 The broadcast graphics upgrade, in a real Chromium:
//
//   A. TEAM LOGOS IN THEIR OWN TRUE SHAPE (cricket-overlay.html logoKit) — a
//      tall shield, a wide wordmark, a round emblem saved on BLACK as a JPEG
//      (what a panel on Safari used to write), a crest saved on WHITE, a
//      coloured tile, a dark logo, a crest in a sea of empty margin, an SVG
//      with no size of its own, and a logo that will not load:
//      - each is read once: see-through margin trimmed, a plain black /
//        white ground keyed back out from the edges in (its corners really
//        see-through), a coloured tile kept whole, a dark logo given a light
//        backing, a broken one shown as the team's initials;
//      - in every badge the box takes the logo's own proportions (never a
//        fixed circle or square): no border-radius, no plate, no crop, the
//        picture drawn at its own aspect (object-fit: contain);
//      - the score bar's caps, the summary / stat cards and the full-screen
//        graphics (Playing XI hero, the toss coin, the Match Intro ring).
//   B. THE MANUAL BATTING / BOWLING CARDS — the identity column in the
//      team's colour + the data panel: every figure in its column, Economy
//      ALWAYS last, the batters at the crease / the bowler on lit, TOP /
//      BEST, a name too long written as initials + surname, white type
//      readable on white / yellow / neon / black team colours; the entrance
//      in its layers and order, no bounce; the masks let go once settled;
//      the exit; shown again and again in quick succession → one card.
//   C. THE SCORE BAR'S LAYERED ENTRANCE / EXIT — the line of light first,
//      the caps and the band in order, the text after; the exit the other
//      way; no bounce; it never leaves the foot of the picture; on and off
//      in quick succession → it ends in the right state, all text whole.
//   D. BOTH PANELS' LOGO UPLOAD — a logo keeps its transparency (WEBP, or a
//      PNG on a browser that cannot write WEBP — never a JPEG with a black
//      ground), at up to 256 px, within its size budget.
//
// Run:  NODE_PATH=$(npm root -g) node test/cricket/graphics-upgrade-test.js
//       (needs playwright + a chromium, and gsap: npm install --no-save gsap)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const ok = (name, v, info) => eq(name + (v ? '' : ` (${JSON.stringify(info)})`), !!v, true);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tryResolve = (p) => { try { return require.resolve(p); } catch(e){ return null; } };
const GSAP = tryResolve('gsap/dist/gsap.min.js');
const SOCKET = `window.__h={};window.io=function(){const s={on:(e,f)=>{(window.__h[e]=window.__h[e]||[]).push(f);return s},emit:()=>s,connected:true,disconnect(){},io:{on(){}}};setTimeout(()=>(window.__h.connect||[]).forEach(f=>f()),0);return s};window.__emit=(e,d)=>(window.__h[e]||[]).forEach(f=>f(d));`;

async function openOverlay(browser, opts = {}){
  const ctx = await browser.newContext({ viewport: { width: opts.w || 1920, height: opts.h || 1080 }, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if(u.hostname === 'cdnjs.cloudflare.com' && GSAP) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(GSAP) });
    if(u.hostname !== 'overlay.test') return route.fulfill({ status: 404, body: '' });
    if(u.pathname === '/socket.io/socket.io.js') return route.fulfill({ contentType: 'text/javascript', body: SOCKET });
    const f = path.join(ROOT, decodeURIComponent(u.pathname));
    if(f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ path: f });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://overlay.test/cricket-overlay.html?room=GFXUP&debug=1');
  if(!(await page.evaluate(() => !!window.gsap))) throw new Error('gsap did not load — npm install --no-save gsap');
  await page.evaluate(LOGO_MAKER);
  return { ctx, page, errors, emit: (ev, d) => page.evaluate(([ev, d]) => window.__emit(ev, d), [ev, d]) };
}
// the test logos, drawn in the page (window.__L)
const LOGO_MAKER = `(() => {
  const mk = (w, h, draw, type, q) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); return c.toDataURL(type || 'image/png', q); };
  const shield = (x, w, h, ox = 0, oy = 0) => {
    x.save(); x.translate(ox, oy);
    x.beginPath(); x.moveTo(w * .5, h * .04); x.lineTo(w * .94, h * .18); x.lineTo(w * .88, h * .62); x.quadraticCurveTo(w * .78, h * .86, w * .5, h * .97); x.quadraticCurveTo(w * .22, h * .86, w * .12, h * .62); x.lineTo(w * .06, h * .18); x.closePath();
    x.fillStyle = '#c8102e'; x.fill(); x.lineWidth = w * .05; x.strokeStyle = '#f5c518'; x.stroke();
    x.fillStyle = '#fff'; x.font = '900 ' + (h * .28) + 'px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('YCC', w * .5, h * .5);
    x.restore();
  };
  window.__L = {
    shield: mk(180, 220, (x, w, h) => shield(x, w, h)),
    wide: mk(360, 120, (x, w, h) => { x.fillStyle = '#1d4ed8'; x.beginPath(); x.roundRect(4, 14, w - 8, h - 28, 40); x.fill(); x.fillStyle = '#fff'; x.font = '900 64px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('ROYALS', w / 2, h / 2 + 2); }),
    blackjpg: mk(128, 128, (x, w, h) => { x.fillStyle = '#000'; x.fillRect(0, 0, w, h); x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.fillStyle = '#0e7a3e'; x.fill(); x.lineWidth = 6; x.strokeStyle = '#fff'; x.stroke(); x.fillStyle = '#fff'; x.font = '900 34px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('MIG', 64, 66); }, 'image/jpeg', 0.72),
    whitejpg: mk(160, 160, (x, w, h) => { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); shield(x, 120, 140, 20, 10); }, 'image/jpeg', 0.8),
    tile: mk(140, 140, (x, w, h) => { x.fillStyle = '#7c3aed'; x.fillRect(0, 0, w, h); x.fillStyle = '#fde047'; x.font = '900 60px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('PSC', 70, 74); }),
    dark: mk(240, 150, (x, w, h) => { x.fillStyle = '#0b1020'; x.font = '900 86px serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('DYP', w / 2, h / 2); }),
    padded: mk(400, 400, (x) => { shield(x, 120, 150, 140, 125); }),
    svg: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#fc0"/></svg>'),
    broken: 'data:image/png;base64,AAAA'
  };
})()`;

const NAMES = ['Rohit Sharma', 'Yashasvi Jaiswal', 'Mohammed Abdul Rahman Siddiqui', 'Suryakumar Yadav', 'Rishabh Pant', 'Hardik Pandya', 'Ravindra Jadeja', 'Axar Patel', 'Kuldeep Yadav', 'Jasprit Bumrah', 'Mohammed Siraj'];
function card(kind, team, opp, extra){
  const batters = NAMES.map((n, i) => ({ id: 'p' + i, name: n, runs: [9, 2, 64, 13, 11, 0, 31, 11, 4, 6, 7][i], balls: 10 + i, fours: 1, sixes: 0, sr: '100.0',
    status: i === 0 ? 'striker' : i === 1 ? 'nonStriker' : i === 10 ? 'notout' : 'out', howOut: 'c Pant b Bumrah' }));
  const bowlers = ['Mohammed Abdul Rahman Siddiqui', 'Aman Khan', 'Karsh Kothari', 'Shubham Mane', 'Alim Shaikh'].map((n, i) => ({ id: 'b' + i, name: n, overs: '4.0', maidens: i === 3 ? 1 : 0, runs: [31, 38, 29, 34, 22][i], wickets: [2, 1, 3, 2, 1][i], econ: ['7.75', '9.50', '7.25', '8.50', '5.50'][i], dots: 9, wides: 1, noBalls: 0, current: i === 1 }));
  return { kind, inningsNo: 1, label: '1ST INNINGS', live: true, batting: kind === 'bat' ? team : opp, bowling: kind === 'bat' ? opp : team,
    info: { tournament: 'Padmakar Talim Shield 2026-27', venue: 'D Y Patil University Ground', date: '2026-11-08' },
    batters: kind === 'bat' ? batters : [], bowlers: kind === 'bat' ? [] : bowlers, groups: kind === 'bat' ? [] : [{ label: 'DID NOT BOWL', names: ['Harsh Rane', 'Om Lokhande'] }],
    total: { runs: 167, wickets: 9, overs: '19.5', target: null, extrasTotal: 9, extras: { wd: 4, b: 1, lb: 4 } },
    fow: kind === 'bat' ? [{ wkt: 1, runs: 41, over: '2.5' }, { wkt: 2, runs: 90, over: '7.5' }] : [], ...(extra || {}) };
}
let SEQ = 1;
const gfx = (mode, data, extra) => ({ seq: SEQ++, gid: 'g-' + mode + Math.random().toString(36).slice(2, 7), rev: 1, mode, startedAt: Date.now(), serverNow: Date.now(), data, ...(extra || {}) });
const scCard = (data) => gfx('scorecard', data, { card: { durationSec: null, readyAt: Date.now() + 1400, expiresAt: null } });
const barState = (o) => Object.assign({ visible: true, format: 'T20', oversPerInnings: 20, phase: 'REGULATION', inningsNumber: 1, battingTeam: 'A',
  teamA: { name: 'Goregaon Sports Club', short: 'GSC', color: '#e8590c', logoUrl: '' }, teamB: { name: 'DY Patil Sports Academy', short: 'DYP', color: '#8b1e2b', logoUrl: '' }, theme: {},
  score: { runs: 167, wickets: 9, overs: 19, balls: 5 }, striker: { name: 'Harsh Mendon', id: 's1', runs: 9, balls: 9 }, nonStriker: { name: 'Shivansh Singh', id: 's2', runs: 2, balls: 1 },
  bowler: { name: 'Yogesh Pawar', id: 'b1', overs: 0, balls: 5, runs: 9, wickets: 0 }, thisOver: [], milestonesHit: {}, target: null, inningsArchive: [], dismissedThisInnings: { A: [], B: [] } }, o || {});

// ================= A. LOGOS =================
async function logos(browser){
  console.log('\n######## A. Team logos in their own true shape (logoKit) ########');
  const O = await openOverlay(browser);
  const info = await O.page.evaluate(async () => {
    const out = {};
    for(const [k, u] of Object.entries(window.__L)){ const i = await logoKit.warm(u); out[k] = i && { kind: i.kind, ar: i.ar && +i.ar.toFixed(2), keyed: !!i.keyed, backing: !!i.backing, blob: !!i.blob }; }
    return out;
  });
  eq('a transparent tall shield → drawn anew (trimmed): its own 0.78 : 1', [info.shield.kind, info.shield.ar], ['cut', 0.78]);
  eq('a wide wordmark → drawn anew at its own width', [info.wide.kind, info.wide.ar > 3], ['cut', true]);
  eq('a round emblem saved on BLACK as a JPEG → the black ground keyed out (a round logo, 1 : 1)', [info.blackjpg.kind, info.blackjpg.keyed, info.blackjpg.ar], ['cut', true, 1]);
  eq('a crest saved on WHITE as a JPEG → the white ground keyed out (the crest\'s own shape)', [info.whitejpg.kind, info.whitejpg.keyed, info.whitejpg.ar < 0.9], ['cut', true, true]);
  eq('a coloured tile (its own square design) → kept whole as the picture it is', [info.tile.kind, info.tile.ar], ['tile', 1]);
  eq('a dark logo → a light backing in its own outline (it reads on the dark graphics)', [info.dark.kind, info.dark.backing], ['cut', true]);
  eq('a crest with lots of empty margin → trimmed to the crest (the same shape as the shield)', [info.padded.kind, Math.abs(info.padded.ar - info.shield.ar) < 0.05], ['cut', true]);
  eq('an SVG with no size of its own → drawn, round', [info.svg.kind, info.svg.ar], ['cut', 1]);
  eq('a logo that will not load → nothing to show (initials are used)', info.broken.kind, 'none');
  // the keyed corners are really see-through, the emblem itself opaque
  const px = await O.page.evaluate(async () => {
    const i = logoKit.info(window.__L.blackjpg);
    const img = new Image(); img.src = i.src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const a = (fx, fy) => x.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data[3];
    // (the drawn picture has a margin round the logo for its shadow: the logo spans px .. 1-px of it)
    const m = i.px / (1 + 2 * i.px);
    return { corner: a(m + 0.01, m + 0.01), centre: a(0.5, 0.5) };
  });
  eq('…its corners: no black left (see-through); its middle: the emblem, solid', [px.corner < 40, px.centre], [true, 255]);

  // every badge: the logo's own box, no circle / plate / crop
  const boxes = await O.page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;display:flex;flex-wrap:wrap;gap:30px;padding:30px;background:#111;z-index:999';
    document.body.appendChild(host);
    const out = {};
    for(const [k, u] of Object.entries(window.__L)){
      for(const cls of ['sc-badge', 'stat-badge', 'ms-badge']){
        const b = document.createElement('div'); b.className = cls; b.textContent = 'TM';
        host.appendChild(b);
        setBadge(b, u, 'TM');
      }
    }
    await new Promise(r => setTimeout(r, 200));
    for(const [k, u] of Object.entries(window.__L)){
      const i = logoKit.info(u);
      out[k] = [...host.querySelectorAll('div')].filter(b => b.__lgUrl === u).map(b => {
        const r = b.getBoundingClientRect(), cs = getComputedStyle(b), art = b.querySelector('img.lg-art');
        const ar = art && art.getBoundingClientRect();
        return { lg: b.classList.contains('lg'), tile: b.classList.contains('lg-tile'), ratio: +(r.width / r.height).toFixed(2), want: i && i.ar ? +i.ar.toFixed(2) : null,
          radius: cs.borderTopLeftRadius, bg: cs.backgroundImage, overflow: cs.overflow, fit: art ? getComputedStyle(art).objectFit : null,
          artRatio: art && art.naturalWidth ? +(ar.width / ar.height).toFixed(2) : null, artNatural: art && art.naturalWidth ? +(art.naturalWidth / art.naturalHeight).toFixed(2) : null,
          artRadius: art ? getComputedStyle(art).borderTopLeftRadius : null, text: b.textContent };
      });
    }
    host.remove();
    return out;
  });
  const shaped = Object.entries(boxes).filter(([k]) => k !== 'broken');
  eq('in every badge (cards, stat cards, match summary) a logo is in its own box: no border-radius, no plate behind it, nothing clipped',
    shaped.filter(([, bs]) => bs.some(b => !b.lg || b.radius !== '0px' || b.bg !== 'none' || b.overflow !== 'visible')).map(([k]) => k), []);
  eq('…the box takes the logo\'s own proportions (tall shield tall, wordmark wide, round emblem square — within 6%)',
    shaped.filter(([, bs]) => bs.some(b => Math.abs(b.ratio - b.want) / b.want > 0.06)).map(([k, bs]) => k + ':' + bs.map(b => b.ratio + '/' + b.want)), []);
  eq('…the picture is drawn at its own aspect (object-fit: contain, the art box = the picture) — never stretched or squeezed',
    shaped.filter(([, bs]) => bs.some(b => b.fit !== 'contain' || Math.abs(b.artRatio - b.artNatural) / b.artNatural > 0.03)).map(([k]) => k), []);
  eq('…a tile keeps its rectangle with rounded corners (the logo\'s own design, whole); a logo drawn anew has none',
    [boxes.tile.every(b => b.tile && parseFloat(b.artRadius) > 0), boxes.shield.every(b => !b.tile && b.artRadius === '0px')], [true, true]);
  eq('…a logo that will not load: the team\'s initials, as with no logo', boxes.broken.map(b => [b.lg, b.text]), [[false, 'TM'], [false, 'TM'], [false, 'TM']]);

  // the score bar's caps
  await O.emit('liveCricketScore', barState({ teamA: { name: 'Goregaon Sports Club', short: 'GSC', color: '#e8590c', logoUrl: await O.page.evaluate(() => window.__L.shield) },
    teamB: { name: 'MIG Cricket Club', short: 'MIG', color: '#0b1f4d', logoUrl: await O.page.evaluate(() => window.__L.blackjpg) } }));
  await sleep(1800);
  const caps = await O.page.evaluate(() => ['logo-left', 'logo-right'].map(id => { const e = document.getElementById(id), r = e.getBoundingClientRect(), a = e.querySelector('img.lg-art');
    return { lg: e.classList.contains('lg'), ratio: +(r.width / r.height).toFixed(2), radius: getComputedStyle(e).borderTopLeftRadius, art: !!(a && a.complete && a.naturalWidth), noLogo: e.closest('.cap').classList.contains('no-logo') }; }));
  eq('SCORE BAR: both caps show their logo in its own shape — the shield tall, the (keyed) emblem round — no circle cut',
    caps.map(c => [c.lg, c.radius, c.art, c.noLogo]), [[true, '0px', true, false], [true, '0px', true, false]]);
  eq('…the shield\'s box is as tall as the shield (0.78 : 1), the emblem\'s square', caps.map(c => c.ratio), [0.78, 1]);
  await O.emit('liveCricketScore', barState({ teamB: { name: 'MIG Cricket Club', short: 'MIG', color: '#0b1f4d', logoUrl: await O.page.evaluate(() => window.__L.broken) } }));
  await sleep(700);
  eq('…a logo that will not load: the cap gives its room to the name (as with no logo)', await O.page.evaluate(() => document.getElementById('cap-right').classList.contains('no-logo')), true);

  // the full-screen graphics: the Playing XI hero, the toss coin, the Match Intro's ring
  const L = await O.page.evaluate(() => window.__L);
  const tA = { name: 'Mumbai Indians', short: 'MI', color: '#004ba0', logoUrl: L.wide, players: NAMES.map((n, i) => ({ id: 'a' + i, name: n })) };
  const tB = { name: 'Chennai Super Kings', short: 'CSK', color: '#f9cd05', logoUrl: L.blackjpg, players: NAMES.map((n, i) => ({ id: 'b' + i, name: n })) };
  const plate = (sel) => O.page.evaluate((sel) => [...document.querySelectorAll(sel)].map(p => { const art = p.matches('.lg') ? p : p.querySelector('.lg'); const cs = getComputedStyle(p);
    return { cls: [...p.classList].filter(c => /^pl-|^lg$|^mono$/.test(c)).join(' '), plate: cs.backgroundImage !== 'none' ? 'disc' : 'none', round: cs.borderTopLeftRadius === '50%' || parseFloat(cs.borderTopLeftRadius) > 20,
      art: !!(art && art.querySelector('img.lg-art')) }; }), sel);
  await O.emit('cricketGraphicState', gfx('playingXI', { teams: [tA, tB], info: { tournament: 'T20 League' } }, { xi: { swapAt: Date.now() + 11500, endAt: Date.now() + 23900 } }));
  await sleep(1500);
  eq('PLAYING XI: each team\'s hero logo (one page per team) in its own shape, on no white disc', await plate('#bcg .xi-logo .bcg-plate'), [{ cls: 'pl-hero', plate: 'none', round: true, art: true }, { cls: 'pl-hero', plate: 'none', round: true, art: true }]);
  await O.emit('cricketGraphicState', gfx('toss', { teamA: tA, teamB: tB, winner: 'B', decision: 'BOWL', info: {} }, { toss: { durationSec: null, readyAt: Date.now() + 2200, expiresAt: null } }));
  await sleep(1600);
  eq('TOSS: the coin stays a disc (it is a coin) — the logo whole inside it, its black ground gone', await plate('#bcg .bcg-scene:not([data-leaving]) .toss-coin .bcg-plate'), [{ cls: 'pl-coin', plate: 'disc', round: true, art: true }]);
  eq('…in the fixture strip each logo is its own box (no disc)', (await plate('#bcg .bcg-scene:not([data-leaving]) .toss-fix .bcg-plate')).map(p => [p.cls, p.plate]), [['pl-flow lg', 'none'], ['pl-flow lg', 'none']]);
  await O.emit('cricketGraphicState', gfx('matchIntro', { teamA: tA, teamB: tB, info: {} }, { intro: { readyAt: Date.now() + 7200, durationSec: null, expiresAt: null } }));
  await sleep(1600);
  eq('MATCH INTRO: each logo inside its ring, on no white disc', (await plate('#bcg .bcg-scene:not([data-leaving]) .ar-frame .bcg-plate')).map(p => [p.cls, p.plate, p.art]), [['pl-ring', 'none', true], ['pl-ring', 'none', true]]);
  eq('A: no script errors', O.errors, []);
  await O.ctx.close();
}

// ================= B. MANUAL CARDS =================
async function manualCards(browser){
  console.log('\n######## B. The manual batting / bowling cards ########');
  const O = await openOverlay(browser);
  const L = await O.page.evaluate(() => window.__L);
  const team = { name: 'Goregaon Sports Club', short: 'GSC', color: '#e8590c', logoUrl: L.shield };
  const opp = { name: 'DY Patil Sports Academy', short: 'DYP', color: '#8b1e2b', logoUrl: L.blackjpg };
  const read = () => O.page.evaluate(() => {
    const s = document.querySelector('#bcg .bcg-scene[data-mode="scorecard"]:not([data-leaving])');
    if(!s) return null;
    const t = (q) => { const e = s.querySelector(q); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
    return { kind: s.dataset.kind, head: [...s.querySelectorAll('.mc-th span')].map(e => e.textContent), rows: [...s.querySelectorAll('.mc-tr:not(.mc-th)')].map(r => ({ cells: [...r.children].map(c => c.textContent.trim()), live: r.classList.contains('live'), top: r.classList.contains('top'), tag: (r.querySelector('.mc-nm') || {}).dataset ? r.querySelector('.mc-nm').dataset.tag || '' : '', title: r.querySelector('.mc-nm').title })),
      kicker: t('.mc-kicker'), team: t('.mc-team'), total: t('.mc-total'), overs: t('.mc-overs'), moving: !!s.querySelector('.mc-sheet.moving'), logo: !!s.querySelector('.mc-logo .bcg-plate.lg img.lg-art') };
  });
  await O.emit('cricketGraphicState', scCard(card('bat', team, opp)));
  await sleep(2600);
  let c = await read();
  eq('BAT CARD: the identity column — innings, team, total, overs · run rate, the logo in its own shape', [c.kicker, c.team, c.total, c.overs, c.logo], ['BATTING · 1ST INNINGS', 'Goregaon Sports Club', '167/9', '19.5 OV · RR 8.42', true]);
  eq('…the table: BATTER, R B 4s 6s SR — each row name, how out, then its figures in that order', [c.head, c.rows[2].cells], [['BATTER', '', 'R', 'B', '4s', '6s', 'SR'], ['Mohammed Abdul Rahman Siddiqui', 'c Pant b Bumrah', '64', '12', '1', '0', '100.0']]);
  eq('…the two at the crease lit (the striker starred), the top scorer tagged TOP', [c.rows.filter(r => r.live).map(r => r.cells[0]), c.rows.filter(r => r.top).map(r => [r.cells[0], r.tag])], [['Rohit Sharma *', 'Yashasvi Jaiswal'], [['Mohammed Abdul Rahman Siddiqui', 'TOP']]]);
  eq('…settled: the masks have let go (nothing clipped at rest)', c.moving, false);
  await O.emit('cricketGraphicState', scCard(card('bowl', team, opp)));
  await sleep(2600);
  c = await read();
  eq('BOWL CARD: BOWLER O M R W 0s NB WD ECON — Economy is the LAST column', c.head, ['BOWLER', 'O', 'M', 'R', 'W', '0s', 'NB', 'WD', 'ECON']);
  eq('…every row ends with its economy, wickets in the W column', c.rows.map(r => [r.cells[4], r.cells[8]]), [['2', '7.75'], ['1', '9.50'], ['3', '7.25'], ['2', '8.50'], ['1', '5.50']]);
  eq('…the bowler on lit, the best figures tagged BEST', [c.rows.filter(r => r.live).map(r => r.cells[0]), c.rows.filter(r => r.top).map(r => [r.cells[0], r.tag])], [['Aman Khan *'], [['Karsh Kothari', 'BEST']]]);
  eq('…a name too long for the row is written initials + surname (its full name kept as the title); the others as they are',
    [c.rows[0].cells[0], c.rows[0].title, c.rows[1].cells[0], c.rows[1].title], ['MAR Siddiqui', 'Mohammed Abdul Rahman Siddiqui', 'Aman Khan *', '']);
  // the entrance: layers in order, no bounce
  const ent = await O.page.evaluate(() => {
    const tl = window.__overlayDebug.bcg.scene.tl;
    const first = (sel) => { const t = tl.getChildren(true, true, false).filter(x => x.targets && x.targets().some(e => e.matches && e.matches(sel))); return t.length ? +Math.min(...t.map(x => x.startTime())).toFixed(2) : null; };
    const eases = tl.getChildren(true, true, false).map(x => String(x.vars.ease || '')).filter(e => /back|elastic|bounce/i.test(e));
    return { bg: first('.mc-id-bg'), glass: first('.mc-data-bg'), logo: first('.mc-logo .bcg-plate'), kicker: first('.mc-kicker'), team: first('.mc-team'), total: first('.mc-total .mc-dg'), rows: first('.mc-tr:not(.mc-th)'), sum: first('.mc-sum'), eases };
  });
  ok('…its entrance in layers: the column\'s colour, then the glass, the logo, the heading, the rows, the total, what is under the rows',
    ent.bg < ent.glass && ent.glass < ent.logo && ent.logo < ent.kicker && ent.kicker < ent.team && ent.team < ent.rows && ent.rows < ent.total && ent.total < ent.sum, ent);
  eq('…no bounce, elastic or back easing anywhere in it', ent.eases, []);
  // the colours: white type readable on any team colour
  const tones = [];
  for(const color of ['#ffffff', '#fde047', '#00ff00', '#ff00ff', '#000000', '#0b1f4d']){
    await O.emit('cricketGraphicState', scCard(card('bat', { ...team, color }, opp)));
    await sleep(900);
    tones.push(await O.page.evaluate((color) => {
      const sh = document.querySelector('#bcg .bcg-scene:not([data-leaving]) .mc-sheet');
      const lum = (v) => { const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(sh.style.getPropertyValue(v)); return m ? (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) / 255 : -1; };
      return [color, +lum('--m-a32').toFixed(2), +lum('--m-mid').toFixed(2), +lum('--m-top').toFixed(2)];
    }, color));
  }
  eq('…on a white, yellow, neon green, magenta, black or navy team the column under the name and the total is deep enough for white type (lum ≤ 0.31)',
    tones.filter(([, a, m]) => a > 0.31 || m > 0.31 || a < 0 || m < 0), []);
  eq('…a black team\'s column is lifted toward steel (never a black hole)', tones.find(t => t[0] === '#000000')[3] >= 0.12, true);
  // shown again and again → one card, the newest
  await O.emit('cricketGraphicState', scCard(card('bat', team, opp)));
  await sleep(250);
  await O.emit('cricketGraphicState', scCard(card('bowl', team, opp)));
  await sleep(250);
  await O.emit('cricketGraphicState', scCard(card('bat', team, opp)));
  await sleep(3200);
  eq('BAT → BOWL → BAT within half a second: one card on air (the last), the others gone', await O.page.evaluate(() => [...document.querySelectorAll('#bcg .bcg-scene')].map(s => s.dataset.kind + (s.dataset.leaving ? ':leaving' : ''))), ['bat']);
  // off air: the exit, the other way round
  await O.emit('cricketGraphicState', { seq: SEQ++, gid: null, mode: null, data: null, serverNow: Date.now() });
  await sleep(120);
  const ex = await O.page.evaluate(() => {
    const s = document.querySelector('#bcg .bcg-scene[data-leaving]');
    if(!s) return null;
    const tx = (sel) => { const e = s.querySelector(sel); return e ? new DOMMatrix(getComputedStyle(e).transform).m41 : null; };
    return { glassOut: tx('.mc-data-bg'), colOut: tx('.mc-id-bg') };
  });
  await sleep(1200);
  eq('…hidden: the exit plays (the rows go first, the glass and the column after) and the card is gone', [!!ex, await O.page.evaluate(() => document.querySelectorAll('#bcg .bcg-scene').length)], [true, 0]);
  eq('B: no script errors', O.errors, []);
  await O.ctx.close();
  // reduced motion: a plain fade, settled at once
  const R = await openOverlay(browser, { reduced: true });
  await R.emit('cricketGraphicState', scCard(card('bat', team, opp)));
  await sleep(1200);
  eq('reduced motion: the card fades in, nothing left masked', await R.page.evaluate(() => { const s = document.querySelector('#bcg .bcg-scene'); return [!!s, !!(s && s.querySelector('.mc-sheet.moving'))]; }), [true, false]);
  await R.ctx.close();
}

// ================= C. THE SCORE BAR =================
async function bar(browser){
  console.log('\n######## C. The score bar\'s layered entrance / exit ########');
  const O = await openOverlay(browser);
  const bottomGap = () => O.page.evaluate(() => innerHeight - document.getElementById('scorecard').getBoundingClientRect().bottom);
  await O.emit('liveCricketScore', barState());
  await sleep(60);
  const ent = await O.page.evaluate(() => {
    const kids = barEntryTl.getChildren(true, true, false);
    const at = (sel) => { const t = kids.filter(x => x.targets().some(e => e.matches && e.matches(sel))); return t.length ? +Math.min(...t.map(x => x.startTime())).toFixed(2) : null; };
    return { guide: at('#sb-guide'), capL: at('#cap-left'), mid: at('#mid-row'), capR: at('#cap-right'), logo: at('.cap-logo'), score: at('#score-row > *'), batters: at('#batters-seg .brow'), bowler: at('#bowler-line > *'),
      eases: kids.map(x => String(x.vars.ease || '')).filter(e => /back|elastic|bounce/i.test(e)), origin: getComputedStyle(document.getElementById('mid-row')).transformOrigin };
  });
  ok('ENTRANCE: the line of light first, then the batting side\'s cap, the band, the bowling side\'s cap — then the logos, the score, the batters, the bowler',
    ent.guide === 0 && ent.guide < ent.capL && ent.capL < ent.mid && ent.mid < ent.capR && ent.capR < ent.logo && ent.logo <= ent.score + 0.1 && ent.score < ent.batters && ent.batters < ent.bowler, ent);
  eq('…the band grows out of the batting side\'s cap (from its left edge); no bounce, elastic or back easing', [ent.origin.split(' ')[0], ent.eases], ['0px', []]);
  const gaps = [];
  for(let i = 0; i < 8; i++){ gaps.push(Math.round(await bottomGap())); await sleep(150); }
  eq('…all the way through it the bar stays at the foot of the picture (2.2% clear of the bottom edge)', [...new Set(gaps)], [Math.round(1080 * 0.022)]);
  await sleep(600);
  const rest = () => O.page.evaluate(() => ({ bar: +getComputedStyle(document.getElementById('scorecard')).opacity, text: BAR_EXIT_TEXT.flatMap(s => [...document.querySelectorAll(s)]).filter(e => getComputedStyle(e).display !== 'none' && +getComputedStyle(e).opacity < 0.99).map(e => e.id || e.className),
    capL: getComputedStyle(document.getElementById('cap-left')).clipPath.replace(/\b0px\b/g, '0%'), mid: getComputedStyle(document.getElementById('mid-row')).transform, guide: +getComputedStyle(document.getElementById('sb-guide')).opacity }));
  let r = await rest();
  eq('…settled: on air, every text whole, the caps open, the band full, the line gone', [r.bar, r.text, r.capL, r.mid, r.guide], [1, [], 'polygon(0% 0%, 100% 0%, 82% 100%, 0% 100%)', 'matrix(1, 0, 0, 1, 0, 0)', 0]);
  await O.emit('liveCricketScore', barState({ visible: false }));
  await sleep(60);
  const ex = await O.page.evaluate(() => {
    const kids = barExitTl.getChildren(true, true, false);
    const at = (sel) => { const t = kids.filter(x => x.targets().some(e => e.matches && e.matches(sel))); return t.length ? +Math.min(...t.map(x => x.startTime())).toFixed(2) : null; };
    return { text: at('#bowler-seg'), capR: at('#cap-right'), mid: at('#mid-row'), capL: at('#cap-left'), fade: at('#scorecard') };
  });
  ok('EXIT: the text first, then the bowling side\'s cap, the band, the batting side\'s cap, a last fade', ex.text === 0 && ex.text < ex.capR && ex.capR < ex.mid && ex.mid < ex.capL && ex.capL < ex.fade, ex);
  await sleep(900);
  r = await rest();
  eq('…off air, its text put back unseen (whatever brings it back finds it whole)', [r.bar, r.text], [0, []]);
  // on / off / on in quick succession
  await O.emit('liveCricketScore', barState());
  await sleep(150);
  await O.emit('liveCricketScore', barState({ visible: false }));
  await sleep(120);
  await O.emit('liveCricketScore', barState());
  await sleep(2000);
  r = await rest();
  eq('ON → OFF → ON within 300 ms: on air, every text whole, the shapes complete', [r.bar, r.text, r.capL, r.mid], [1, [], 'polygon(0% 0%, 100% 0%, 82% 100%, 0% 100%)', 'matrix(1, 0, 0, 1, 0, 0)']);
  await O.emit('liveCricketScore', barState({ visible: false }));
  await sleep(100);
  await O.emit('liveCricketScore', barState());
  await sleep(80);
  await O.emit('liveCricketScore', barState({ visible: false }));
  await sleep(1300);
  r = await rest();
  eq('OFF → ON → OFF: off air', r.bar, 0);
  eq('C: no script errors', O.errors, []);
  await O.ctx.close();
}

// ================= D. BOTH PANELS' LOGO UPLOAD =================
async function panels(browser){
  console.log('\n######## D. Both panels: a logo upload keeps its transparency ########');
  const { bootServer } = require('../server-boot.js');
  const { port } = await bootServer();
  for(const p of ['cricket-panel', 'cricket-panel3']){
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', (route) => { const u = new URL(route.request().url()); if(u.hostname === '127.0.0.1') return route.continue(); return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }); });
    await page.goto(`http://127.0.0.1:${port}/${p}?room=GU${Math.random().toString(36).slice(2, 7)}`);
    await page.waitForFunction(() => typeof compressImageToDataURL === 'function' && document.getElementById('teamA-logo-file'));
    // a transparent 800 px crest, as a file
    const png = Buffer.from(await page.evaluate(() => new Promise(res => { const c = document.createElement('canvas'); c.width = c.height = 800; const x = c.getContext('2d'); x.beginPath(); x.arc(400, 400, 330, 0, 7); x.fillStyle = '#c8102e'; x.fill(); c.toBlob(b => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(b); }, 'image/png'); })), 'base64');
    const check = (url) => page.evaluate((url) => new Promise(res => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); res([url.slice(5, url.indexOf(';')), Math.max(i.width, i.height), x.getImageData(0, 0, 1, 1).data[3], url.length]); }; i.src = url; }), url);
    await page.setInputFiles('#teamA-logo-file', { name: 'crest.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => /^data:image\//.test(state.teamA.logoUrl || ''), null, { timeout: 8000 });
    let [type, size, alpha, len] = await check(await page.evaluate(() => state.teamA.logoUrl));
    eq(`${p}: TEAM LOGO upload → a WEBP that keeps its see-through corners, 256 px, within 36000`, [type, size, alpha, len <= 36000], ['image/webp', 256, 0, true]);
    // a browser that cannot write WEBP (Safari): the fallback keeps the transparency — a PNG, never a JPEG
    await page.evaluate(() => { const o = HTMLCanvasElement.prototype.toDataURL; HTMLCanvasElement.prototype.toDataURL = function(t, q){ return o.call(this, t === 'image/webp' ? 'image/png' : t, q); }; state.teamA.logoUrl = ''; });
    await page.setInputFiles('#teamA-logo-file', { name: 'crest.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => /^data:image\//.test(state.teamA.logoUrl || ''), null, { timeout: 8000 });
    [type, size, alpha, len] = await check(await page.evaluate(() => state.teamA.logoUrl));
    eq(`${p}: …on a browser with no WEBP (Safari) → a PNG, the corners still see-through (no black square)`, [type, alpha, len <= 36000], ['image/png', 0, true]);
    const opaque = await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = c.height = 300; const x = c.getContext('2d'); x.fillStyle = '#123'; x.fillRect(0, 0, 300, 300);
      const b = await new Promise(r => c.toBlob(r, 'image/jpeg')); const u = await compressImageToDataURL(new File([b], 'p.jpg', { type: 'image/jpeg' }), 256, 0.86, 36000); return u.slice(5, u.indexOf(';')); });
    eq(`${p}: …a picture with nothing see-through may still go as a JPEG there`, opaque, 'image/jpeg');
    eq(`${p}: no script errors`, errors, []);
    await ctx.close();
  }
}

(async () => {
  console.log(`(gsap: ${GSAP ? 'node_modules' : 'CDN'})`);
  const browser = await chromium.launch();
  try {
    await logos(browser);
    await manualCards(browser);
    await bar(browser);
    await panels(browser);
  } finally {
    await browser.close();
  }
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
