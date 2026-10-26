/* 🏐 The volleyball overlay's layout with awkward names, in Chromium at
   1920×1080: every on-air graphic is waited for by ITS OWN id (two scenes
   can share a look), then checked — inside the frame, clear of the score
   bar or corner bug, and no team or player name cut short with an
   ellipsis — for long names, short names and everything between.

     NODE_PATH=$(npm root -g) node test/volleyball/overlay-layout.test.js
   Screenshots: test/out/volleyball/layout-*.png
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { bootServer } = require('../server-boot.js');
const { connectVb } = require('./vb-socket.js');

const OUT = path.join(__dirname, '..', 'out', 'volleyball');
fs.mkdirSync(OUT, { recursive: true });
let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function call(port, method, url, { json, token, headers } = {}) {
  return new Promise((resolve, reject) => {
    const body = json ? Buffer.from(JSON.stringify(json)) : null;
    const h = Object.assign({}, body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}, token ? { Authorization: 'Bearer ' + token } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const U = { uid: 'u-work', email: 'workallsportslive@gmail.com', email_verified: true };
// [team A, team B] — the long one is longer than any real team name we have seen
const PAIRS = [
  [{ name: 'Mumbai Thunderbolts Volleyball Club', short: 'MTV' }, { name: 'Goa Waves', short: 'GOA' }],
  [{ name: 'Pune Panthers', short: 'PUN' }, { name: 'Kolkata Thunder', short: 'KOL' }],
  [{ name: 'Hyderabad Black Hawks', short: 'HBH' }, { name: 'Calicut Heroes', short: 'CAL' }]
];

(async () => {
  const { port } = await bootServer({ idTokens: { tok: U }, users: { 'u-work': U.email } });
  const api = (m, u, o) => call(port, m, u, Object.assign({ token: 'tok' }, o || {}));
  const browser = await chromium.launch();
  const errors = [];
  try {
    for (const [pi, [ta, tb]] of PAIRS.entries()) {
      console.log(`\n${ta.name} v ${tb.name}`);
      const mk = (t) => api('POST', '/api/volleyball/teams', { json: { name: t.name, shortName: t.short, colors: { primary: pi === 1 ? '#f5c518' : '#c81e1e', secondary: '#0a1136', text: pi === 1 ? '#111111' : '#ffffff' },
        players: Array.from({ length: 8 }, (_, i) => ({ name: i === 3 ? 'Venkatasubramanian Raghunathan' : `${t.short} Player ${i + 1}`, number: String(i + 1), role: ['S', 'OH', 'OH', 'MB', 'MB', 'OPP', 'DS', 'L'][i], libero: i === 7, captain: i === 0 })) } }).then((r) => r.json.team);
      const A = await mk(ta), B = await mk(tb);
      const T = (await api('POST', '/api/volleyball/tournaments', { json: { name: pi === 0 ? 'All India Inter-University Volleyball Championship 2026' : 'Layout Cup ' + pi, teamIds: [A.teamId, B.teamId] } })).json.tournament;
      const M = (await api('POST', `/api/volleyball/tournaments/${T.tournamentId}/matches`, { json: { teamA: A.teamId, teamB: B.teamId } })).json.match;
      const lease = (await api('POST', `/api/volleyball/matches/${M.matchId}/lease`, { json: { deviceId: 'd' } })).json.leaseToken;
      let n = 0;
      const ev = (e) => api('POST', `/api/volleyball/matches/${M.matchId}/events`, { json: { event: Object.assign({ eventId: 'e' + (++n), at: Date.now() }, e) }, headers: { 'x-vb-lease': lease } }).then((r) => r.json);
      const six = (t) => t.players.filter((p) => !p.libero).slice(0, 6).map((p) => p.playerId);
      await ev({ type: 'TOSS', winner: 'B', choice: 'receive', leftSide: 'B' });
      // a long, close match: five sets, the deciding one 16-14
      for (let set = 1; set <= 5; set++) {
        await ev({ type: 'LINEUP', team: 'A', set, positions: six(A) });
        await ev({ type: 'LINEUP', team: 'B', set, positions: six(B) });
        if (set === 5) await ev({ type: 'TOSS', set: 5, winner: 'A', choice: 'serve', leftSide: 'A' });
        await ev({ type: 'SET_START', set });
        const winner = set % 2 ? 'A' : 'B';
        for (let i = 0; i < 80; i++) {
          const r = await ev({ type: 'RALLY', winner: i % 3 === 2 ? (winner === 'A' ? 'B' : 'A') : winner, outcome: i % 4 === 0 ? 'ATTACK_KILL' : 'GENERAL',
            players: i % 4 === 0 ? { attacker: (i % 3 === 2 ? (winner === 'A' ? B : A) : (winner === 'A' ? A : B)).players[3].playerId } : undefined });
          if (!r.success || r.summary.status !== 'in_set') break;
        }
      }
      const done = (await api('GET', `/api/volleyball/matches/${M.matchId}`)).json.match;
      ok('the match went the distance (3–2)', done.status === 'completed' && done.result && done.result.sets.A + done.result.sets.B === 5, done.result);

      const gfx = await connectVb(port, { idToken: 'tok' });
      for (const layout of ['bar', 'compact']) {
        const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
        const page = await ctx.newPage();
        await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(`http://127.0.0.1:${port}/volleyball-overlay?match=${M.matchId}${layout === 'compact' ? '&layout=compact' : ''}`);
        await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 15000 });
        await page.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;inset:0;z-index:-1;background:radial-gradient(ellipse at 50% 120%,#d9a066,#8a5a2b 35%,#2f4f2f 70%,#16261a)'; document.body.prepend(d); });
        // a name is cut when its text, measured at its own font, is wider than its box
        // (scrollWidth is rounded: a 0.4 px overflow still shows an ellipsis)
        const clipped = () => page.evaluate(() => {
          const m = document.createElement('span');
          m.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;white-space:nowrap';
          document.body.appendChild(m);
          const out = [];
          document.querySelectorAll('#gfx .scene.on [data-fit], #gfx .scene.on .pnm, #na span, #nb span, .crow .cn').forEach((e) => {
            if (!e.offsetParent || !e.textContent.trim()) return;
            const cs = getComputedStyle(e);
            ['fontFamily', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant', 'letterSpacing', 'textTransform', 'fontSize'].forEach((k) => { m.style[k] = cs[k]; });
            m.textContent = e.textContent;
            const need = m.getBoundingClientRect().width, box = e.getBoundingClientRect().width;
            if (need > box + 0.25) out.push(`${e.textContent.trim()} (${need.toFixed(1)} > ${box.toFixed(1)})`);
          });
          m.remove();
          return out;
        });
        const scenes = layout === 'bar'
          ? [['scorebug'], ['intro'], ['lineup', { set: 5 }], ['toss', { set: 5 }], ['toss', { set: 1 }], ['setSummary', { set: 5 }], ['final'], ['standings'], ['playerStat', { playerId: A.players[3].playerId }]]
          : [['scorebug'], ['lineup'], ['final'], ['playerStat', { playerId: B.players[3].playerId }]];
        for (const [scene, data] of scenes) {
          const r = await gfx.emitAck('vb:graphic', { matchId: M.matchId, scene, data: data || {} });
          const id = r.graphic.id;
          if (scene === 'scorebug') { await page.waitForFunction(() => !document.querySelector('#gfx .scene'), null, { timeout: 8000 }).catch(() => {}); }
          else {
            const on = await page.waitForFunction((gid) => { const o = window.__vbOverlay; const el = document.querySelector('#gfx .scene.on'); return o && o.onAir && o.onAir.id === gid && el && !el.nextElementSibling; }, id, { timeout: 8000 }).then(() => true, () => false);
            ok(`${layout} · ${scene}${data && data.set ? ' (set ' + data.set + ')' : ''}: on air`, on);
            await sleep(1400);   // entrance finished
          }
          const geo = await page.evaluate(() => {
            const r = (q) => { const e = document.querySelector(q); if (!e || getComputedStyle(e).display === 'none') return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
            return { g: r('#gfx .scene.on'), bar: document.body.classList.contains('hide-bar') ? null : r('#wrap'), pill: document.querySelector('#pill.show') ? r('#pill') : null, corner: document.body.classList.contains('hide-bar') ? null : r('#corner') };
          });
          const over = (a, b) => !!(a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
          const inside = !geo.g || (geo.g.x >= 0 && geo.g.y >= 0 && geo.g.x + geo.g.w <= 1920 && geo.g.y + geo.g.h <= 1080);
          ok(`${layout} · ${scene}: inside the frame, clear of the ${layout === 'bar' ? 'score bar' : 'corner bug'}`, inside && !over(geo.g, geo.bar) && !over(geo.g, geo.pill) && !over(geo.g, geo.corner), geo);
          if (pi === 0 && layout === 'bar' && scene === 'intro') {
            // the check itself must see a cut name: a deliberately too-narrow one is reported
            await page.evaluate(() => { const b = document.createElement('b'); b.id = 'probe'; b.dataset.fit = '30'; b.textContent = 'Mumbai Thunderbolts'; b.style.cssText = 'display:block;width:120px;font-size:30px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'; document.querySelector('#gfx .scene.on').appendChild(b); });
            const probe = await clipped();
            ok('the "cut name" check itself catches a cut name', probe.some((x) => x.startsWith('Mumbai Thunderbolts')), probe);
            await page.evaluate(() => document.getElementById('probe').remove());
          }
          const cut = await clipped();
          ok(`${layout} · ${scene}: no name cut short`, cut.length === 0, cut);
          await page.screenshot({ path: path.join(OUT, `layout-${pi}-${layout}-${scene}${data && data.set ? '-s' + data.set : ''}.png`) });
        }
        await ctx.close();
      }
      await gfx.close();
    }
    ok('no uncaught page error', errors.length === 0, errors);
  } catch (e) {
    fails.push('crashed: ' + (e.stack || e));
    console.log(e.stack || e);
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ':\n  - ' + fails.join('\n  - ') : ''}`);
  process.exit(fails.length ? 1 : 0);
})();
