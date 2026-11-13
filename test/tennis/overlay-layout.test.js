/* 📐 Every tennis graphic, one by one, in Chromium at 1920×1080 against the
   REAL server — singles with a very long name against a very short one,
   doubles pairs, portraits and a wide tournament logo:

     • every full-screen scene (all 17, each in the match state it is for:
       before the toss, after it, in play, at a break point, in a tie-break,
       after a set, at match point, at the end) — every word inside the
       1920×1080 frame, no word cut short or hidden, every picture loaded and
       not stretched; it comes in (entrance played) and goes (the bug back)
     • the score bug in singles and in doubles: names, sets, games, points,
       the server's dot, Love / 15 / 30 / 40 / AD and tie-break numbers
     • every lower third (all 8, the scrolling ticker included) and every
       call-out (all 12, set by hand)
     • a picture of each in test/out/tennis/layout-*.png

     NODE_PATH=$(npm root -g) node test/tennis/overlay-layout.test.js
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./browser-harness.js');
const { connectTn } = require('./tn-socket.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 700) : '')); }
}
const head = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a wide logo (3:1) — it must keep its proportions wherever it is shown
function wideLogo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-logo-'));
  const f = path.join(dir, 'logo.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0b3d2e:s=600x200', '-vf', "geq=r='if(lt(X,200),215,30)':g='if(lt(X,200),245,120)':b='if(lt(X,200),72,90)'", '-frames:v', '1', f]);
  return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
}

// Everything visible inside a layer: text outside the frame, text cut short
// or hidden by its box, pictures not loaded or stretched.
const INSPECT = (sel) => {
  const root = document.querySelector(sel);
  const out = { texts: 0, outside: [], cut: [], badImg: [], imgs: 0 };
  if (!root) return out;
  const visible = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false; } return true; };
  for (const el of root.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (own) {
      out.texts++;
      if (r.left < -1 || r.top < -1 || r.right > 1921 || r.bottom > 1081) out.outside.push(own.slice(0, 40) + ' @' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(','));
      const cs = getComputedStyle(el);
      const hides = cs.overflow !== 'visible' || cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none');
      if (hides && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 3)) out.cut.push(own.slice(0, 40) + ' ' + el.scrollWidth + '>' + el.clientWidth + '/' + el.scrollHeight + '>' + el.clientHeight);
    }
    if (el.tagName === 'IMG') {
      out.imgs++;
      if (!el.complete || !el.naturalWidth) { out.badImg.push('not loaded: ' + el.getAttribute('src').slice(0, 60)); continue; }
      const fit = getComputedStyle(el).objectFit;
      if (fit !== 'cover' && fit !== 'contain' && fit !== 'scale-down') {
        const ra = r.width / r.height, na = el.naturalWidth / el.naturalHeight;
        if (Math.abs(ra - na) / na > 0.04) out.badImg.push('stretched ' + ra.toFixed(2) + ' vs ' + na.toFixed(2));
      }
    }
  }
  return out;
};

(async () => {
  const h = await H.start();
  try {
    const mk = async (name, country, color, withPhoto) => (await h.api('POST', '/api/tennis/players', { json: { name, force: true, country, color, ranking: { value: 17, label: 'ATP' }, photo: withPhoto ? H.photo(color.replace('#', '0x')) : undefined } })).json.player;
    const L1 = await mk('Maximilian-Alexander Oberhofer-Lindqvist', 'AUT', '#1d4ed8', true);
    const S1 = await mk('Jo Li', 'CHN', '#be123c', true);
    const D1 = await mk('Konstantinos Papadopoulos-Ioannidis', 'GRE', '#0f766e', false), D2 = await mk('Wu Yi', 'CHN', '#0f766e', true);
    const D3 = await mk('Bartholomew Featherstonehaugh', 'GBR', '#b45309', true), D4 = await mk('Al Bo', 'BRA', '#b45309', false);
    const T = (await h.api('POST', '/api/tennis/tournaments', { json: { name: 'Maharashtra State Open Tennis Championships 2026', venue: 'Mahalunge Balewadi Tennis Complex', city: 'Pune', surface: 'hard', visibility: 'public', courts: ['Centre Court'], logo: wideLogo(), startDate: '2026-11-10', endDate: '2026-11-17' } })).json.tournament;
    ok('the tournament takes a wide logo', !!(T && T.logo), T && T.logo);
    const M = (await h.api('POST', `/api/tennis/tournaments/${T.tournamentId}/matches`, { json: { format: 'singles', sideA: { playerIds: [L1.playerId], seed: 3 }, sideB: { playerIds: [S1.playerId], seed: 14 }, court: 'Centre Court', stage: { type: 'knockout', round: 'Semi-final' }, rules: { bestOf: 3 } } })).json.match;
    const DM = (await h.api('POST', `/api/tennis/tournaments/${T.tournamentId}/matches`, { json: { format: 'doubles', sideA: { playerIds: [D1.playerId, D2.playerId] }, sideB: { playerIds: [D3.playerId, D4.playerId] }, court: 'Centre Court', stage: { type: 'knockout', round: 'Final' }, rules: { bestOf: 3, noAd: true, finalSet: 'matchTiebreak' } } })).json.match;
    const sock = await connectTn(h.port, { idToken: 'tok-work' });
    const ctl = async (match) => {
      await sock.emitAck('tn:join', { matchId: match.matchId });
      const lease = (await h.api('POST', `/api/tennis/matches/${match.matchId}/lease`, { json: { deviceId: 'lay' + match.matchId.slice(-4) } })).json.leaseToken;
      let n = 0;
      return {
        ev: (e) => sock.emitAck('tn:event', { matchId: match.matchId, leaseToken: lease, event: Object.assign({ eventId: 'ly' + (++n) + 'x' + match.matchId.slice(-5), at: Date.now() }, e) }),
        gfx: (cmd) => sock.emitAck('tn:graphic', Object.assign({ matchId: match.matchId, reqId: 'lq' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }, cmd))
      };
    };
    const S = await ctl(M);
    const pts = async (c, side, n, extra) => { for (let i = 0; i < n; i++) { const r = await c.ev(Object.assign({ type: 'POINT', winner: side }, extra || {})); if (!r.ok) throw new Error('point refused: ' + r.error); } };
    const game = (c, side) => pts(c, side, 4);

    const open = async (match) => {
      const page = await h.open('/tennis-overlay?match=' + match.matchId, { viewport: { width: 1920, height: 1080 }, who: null });
      await page.waitForSelector('body.ready', { timeout: 15000 });
      await page.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;inset:0;z-index:-1;background:linear-gradient(160deg,#4a7a5a,#1f3d2c)'; document.body.prepend(d); });
      return page;
    };
    const state = (page) => page.evaluate(() => window.__tnOverlay.C.state);
    const waitState = async (page, want, ms) => { const end = Date.now() + (ms || 9000); let s; while (Date.now() < end) { s = await state(page); if (want.includes(s)) return s; await sleep(60); } return s; };
    const checked = [];
    // take a scene, check it in place, take a picture, send it away
    async function scene(page, c, name, data, label) {
      const r = await c.gfx({ action: 'take', scene: name, data: data || {}, durationSec: null });
      if (!r.ok) { ok(`${label || name}: taken to air`, false, r.error); return; }
      const inState = await waitState(page, ['GRAPHIC_VISIBLE'], 10000);
      await sleep(250);
      const x = await page.evaluate(INSPECT, '#gfx');
      const sc = await page.evaluate(() => window.__tnOverlay.C.scene && window.__tnOverlay.C.scene.scene);
      await h.shot(page, 'layout-' + (label || name).replace(/[^a-z0-9]+/gi, '-').toLowerCase());
      ok(`${label || name}: in, with every word inside the frame, none cut short, pictures whole`, inState === 'GRAPHIC_VISIBLE' && sc === name && x.texts >= 2 && !x.outside.length && !x.cut.length && !x.badImg.length, { inState, sc, texts: x.texts, outside: x.outside.slice(0, 3), cut: x.cut.slice(0, 3), badImg: x.badImg });
      await c.gfx({ action: 'live' });
      const back = await waitState(page, ['OVERLAY_VISIBLE'], 10000);
      ok(`${label || name}: out — the bug back, nothing left behind`, back === 'OVERLAY_VISIBLE' && await page.evaluate(() => !document.getElementById('gfx').firstChild), back);
      checked.push(name);
    }
    async function lower(page, c, kind, data, label) {
      const r = await c.gfx({ action: 'lower', kind, data: data || {}, durationSec: null });
      if (!r.ok) { ok(`lower third ${label || kind}: on air`, false, r.error); return; }
      await sleep(kind === 'ticker' ? 1400 : 1500);
      const sel = kind === 'ticker' ? '#ticker' : '#lower';
      const x = await page.evaluate(INSPECT, sel);
      const shown = await page.evaluate((s) => { const el = document.querySelector(s); return !!el && parseFloat(getComputedStyle(el).opacity) > 0.9 && el.textContent.trim().length > 0; }, sel);
      await h.shot(page, 'layout-lower-' + (label || kind));
      if (kind === 'ticker') {
        const runs = await page.evaluate(() => document.getAnimations().some((a) => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('#ticker')));
        ok('lower third ticker (scrolling information): up, its text moving along, inside the frame', shown && runs && !x.badImg.length, { shown, runs });
      } else ok(`lower third ${label || kind}: up, every word inside the frame and whole`, shown && x.texts > 0 && !x.outside.length && !x.cut.length && !x.badImg.length, { shown, texts: x.texts, outside: x.outside.slice(0, 3), cut: x.cut.slice(0, 3), badImg: x.badImg });
      await c.gfx({ action: 'lower-off' });
      await sleep(900);
    }
    async function moment(page, c, kind, side, label) {
      const r = await c.gfx({ action: 'moment', kind, side, data: kind === 'BREAK_POINT' ? { count: 2 } : kind === 'SET_WON' ? { set: 1, games: { A: 7, B: 6 }, tb: { A: 7, B: 4 } } : kind === 'ACE' ? { speed: 211 } : {}, durationSec: 6 });
      if (!r.ok) { ok(`call-out ${kind}: on air`, false, r.error); return; }
      await sleep(1100);
      const x = await page.evaluate(INSPECT, '#moment');
      const txt = await page.evaluate(() => document.getElementById('moment').textContent.trim());
      await h.shot(page, 'layout-callout-' + (label || kind).toLowerCase());
      ok(`call-out ${label || kind}: "${txt.replace(/\s+/g, ' ').slice(0, 50)}" — inside the frame, whole`, txt.length > 0 && !x.outside.length && !x.cut.length, { outside: x.outside, cut: x.cut });
      await c.gfx({ action: 'moment-off' });
      await sleep(700);
    }
    const bug = (page) => page.evaluate(() => ({ rows: Array.from(document.querySelectorAll('#bug .brow')).map((r) => ({ nm: r.querySelector('.nm').textContent.trim(), sets: Array.from(r.querySelectorAll('.sets > span')).map((x) => x.textContent), pts: r.querySelector('.pts').textContent, srv: r.classList.contains('srv') })), x: null }));
    const bugOk = (page) => page.evaluate(INSPECT, '#bug');

    head('1 · SINGLES — before the toss');
    const page = await open(M);
    await waitState(page, ['OVERLAY_VISIBLE'], 8000);
    let b = await bug(page), bx = await bugOk(page);
    ok('the bug, before play: the very long name and the very short one, inside the frame, whole', /Oberhofer-Lindqvist/.test(b.rows[0].nm) && /Li/.test(b.rows[1].nm) && !bx.outside.length && !bx.cut.length && !bx.badImg.length, { b, bx });
    await h.shot(page, 'layout-bug-singles-pre');
    await scene(page, S, 'intro');
    await scene(page, S, 'compare');
    await scene(page, S, 'player', { playerId: L1.playerId }, 'player-long-name');
    await scene(page, S, 'player', { playerId: S1.playerId }, 'player-short-name');
    await scene(page, S, 'tournament');
    await scene(page, S, 'upcoming', { matchId: DM.matchId });

    head('2 · SINGLES — the toss, the first server, the start');
    await S.ev({ type: 'TOSS', winner: 'B', choice: 'receive', firstServe: 'A', left: 'A' });
    await scene(page, S, 'toss');
    await scene(page, S, 'server');
    await S.ev({ type: 'START', server: L1.playerId, left: 'A' });
    await scene(page, S, 'start');

    head('3 · SINGLES — in play');
    await pts(S, 'A', 1); await pts(S, 'B', 1); await pts(S, 'A', 1);   // 30-15
    await sleep(700);
    b = await bug(page);
    ok('the bug follows the points: 30-15, the server marked', b.rows[0].pts === '30' && b.rows[1].pts === '15' && b.rows[0].srv && !b.rows[1].srv, b);
    await pts(S, 'B', 2);   // 30-40: a break point for Li
    await pts(S, 'A', 1);   // deuce
    await pts(S, 'A', 1);   // advantage Oberhofer-Lindqvist
    await sleep(700);
    b = await bug(page);
    ok('advantage: AD for the server, 40 for the receiver', b.rows[0].pts === 'AD' && b.rows[1].pts === '40', b);
    await pts(S, 'B', 1); await pts(S, 'B', 1);   // deuce, then advantage Li — a break point
    await scene(page, S, 'breakPoint', { side: 'B' });
    await pts(S, 'B', 1);   // the break: 0-1
    await scene(page, S, 'setScore');
    await scene(page, S, 'playerStats', { playerId: S1.playerId });
    await scene(page, S, 'stats');

    head('4 · SINGLES — lower thirds and call-outs');
    await lower(page, S, 'player', { playerId: L1.playerId });
    await lower(page, S, 'profile', { playerId: S1.playerId });
    await lower(page, S, 'serve', { playerId: L1.playerId });
    await lower(page, S, 'stat', { playerId: S1.playerId, stat: 'aces' });
    await lower(page, S, 'tournament');
    await lower(page, S, 'match');
    await lower(page, S, 'announce', { title: 'Rain delay', text: 'Play will resume on Centre Court at 4:30 pm once the covers are removed' });
    await lower(page, S, 'ticker', { text: 'Up next on Centre Court: the men’s doubles final · Tickets for finals day are sold out · Follow every point live on AllSportsLive' });
    for (const k of ['ACE', 'DOUBLE_FAULT', 'BREAK_POINT', 'BREAK', 'GAME_POINT', 'DEUCE', 'SET_POINT', 'MATCH_POINT', 'SET_WON', 'TIEBREAK', 'TIEBREAK_WON', 'MATCH_WON']) await moment(page, S, k, k === 'DEUCE' || k === 'TIEBREAK' ? undefined : 'A');

    head('5 · SINGLES — a tie-break, the set, match point, the result');
    for (const s of 'ABABABABABA') await game(S, s);   // from 0-1: 6-6
    await sleep(600);
    b = await bug(page);
    ok('6-6: the tie-break — numbers, not 15/30/40', /Tie-break/.test(await page.textContent('#bhR')) && b.rows[0].pts === '0' && b.rows[1].pts === '0', { right: await page.textContent('#bhR'), b });
    await pts(S, 'A', 3); await pts(S, 'B', 1);
    await sleep(600);
    b = await bug(page);
    ok('…3-1 in the tie-break shown as 3 and 1', b.rows[0].pts === '3' && b.rows[1].pts === '1', b);
    await scene(page, S, 'tiebreak');
    await pts(S, 'A', 4);   // 7-1: the set, 7-6
    await sleep(600);
    b = await bug(page);
    ok('the set won 7-6: the tie-break score beside it (sup), a new set begun', b.rows[0].sets[0].startsWith('7') && b.rows[1].sets[0].startsWith('6'), b);
    await scene(page, S, 'setWinner', { set: 1 });
    for (let i = 0; i < 5; i++) await game(S, 'A');
    await pts(S, 'A', 3);   // 5-0 40-0: three match points
    await scene(page, S, 'matchPoint', { side: 'A' });
    await pts(S, 'A', 1);   // the match
    await sleep(800);
    await scene(page, S, 'result');

    head('6 · DOUBLES — the pairs on the bug and their graphics');
    const D = await ctl(DM);
    const dpage = await open(DM);
    await waitState(dpage, ['OVERLAY_VISIBLE'], 8000);
    await D.ev({ type: 'TOSS', winner: 'A', choice: 'serve', firstServe: 'A', left: 'A' });
    await D.ev({ type: 'START', server: D1.playerId, order: [D1.playerId, D3.playerId, D2.playerId, D4.playerId], receive: { A: { deuce: D1.playerId, ad: D2.playerId }, B: { deuce: D3.playerId, ad: D4.playerId } } });
    await pts(D, 'B', 1); await pts(D, 'A', 2);   // 30-15
    await sleep(700);
    b = await bug(dpage); bx = await bugOk(dpage);
    ok('the doubles bug: both pairs by surname, inside the frame, whole', /Papadopoulos-Ioannidis \/ Yi/.test(b.rows[0].nm) && /Featherstonehaugh \/ Bo/.test(b.rows[1].nm) && !bx.outside.length && !bx.cut.length, { b, bx });
    await h.shot(dpage, 'layout-bug-doubles');
    await scene(dpage, D, 'teams');
    await scene(dpage, D, 'intro', null, 'intro-doubles');
    await scene(dpage, D, 'setScore', null, 'setScore-doubles');
    await scene(dpage, D, 'player', { playerId: D3.playerId }, 'player-doubles');
    await lower(dpage, D, 'match', null, 'match-doubles');
    await moment(dpage, D, 'BREAK', 'B', 'BREAK-doubles');

    const all = ['intro', 'teams', 'player', 'compare', 'toss', 'server', 'start', 'tournament', 'setScore', 'setWinner', 'tiebreak', 'breakPoint', 'matchPoint', 'playerStats', 'stats', 'result', 'upcoming'];
    ok('every one of the 17 scenes was checked', all.every((k) => checked.includes(k)), all.filter((k) => !checked.includes(k)));
    ok('no page errors', h.pageErrors.length === 0, h.pageErrors);
    await sock.close();
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e.stack || e));
  } finally {
    await h.browser.close();
  }
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})();
