/* 🏐 The volleyball overlay's layout with awkward names, in Chromium at
   1920×1080: every on-air graphic is waited for by ITS OWN id (two scenes
   can share a look), then checked — everything inside the frame, the score
   bar (or corner bug) off air under it, and no team or player name cut
   short — for long names, short names and everything between. A graphic
   the finished match has nothing true for (set start, rotation, time-out)
   is refused by the server with its reason.

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
// a name is cut when its text, measured at its own font, is wider than its
// box (scrollWidth is rounded: a 0.4 px overflow still shows an ellipsis) —
// or, for a two-line name, when it needs more than its two lines
const CLIPPED = () => {
  const m = document.createElement('span');
  m.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;white-space:nowrap';
  document.body.appendChild(m);
  const width = (e, text) => {
    const cs = getComputedStyle(e);
    ['fontFamily', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant', 'letterSpacing', 'textTransform', 'fontSize'].forEach((k) => { m.style[k] = cs[k]; });
    m.textContent = text;
    return m.getBoundingClientRect().width;
  };
  const out = [];
  const seen = (e) => e.offsetParent && e.textContent.trim() && getComputedStyle(e).visibility !== 'hidden';
  document.querySelectorAll('#gfx .scene [data-fit], #na span, #nb span, .crow .cn, .ptag').forEach((e) => {
    if (!seen(e)) return;
    const need = width(e, e.textContent), box = e.getBoundingClientRect().width;
    if (need > box + 0.25) out.push(`${e.textContent.trim()} (${need.toFixed(1)} > ${box.toFixed(1)})`);
  });
  document.querySelectorAll('#gfx .scene [data-fit2]').forEach((e) => {
    if (!seen(e)) return;
    const lh = parseFloat(getComputedStyle(e).lineHeight), box = e.clientWidth;
    const words = e.textContent.split(/\s+/).filter(Boolean);
    if (e.offsetHeight > Math.ceil(lh * 2) + 1 || words.some((w) => width(e, w) > box + 0.25)) out.push(`${e.textContent.trim()} (two lines: ${e.offsetHeight} > ${Math.ceil(lh * 2)})`);
  });
  m.remove();
  return out;
};
// every visible box of the graphic inside the 1920 × 1080 frame
const OUTSIDE = () => {
  const out = [];
  document.querySelectorAll('#gfx .scene *').forEach((e) => {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(e).visibility === 'hidden') return;
    if (r.left < -0.5 || r.top < -0.5 || r.right > 1920.5 || r.bottom > 1080.5) out.push(`${e.className || e.tagName} [${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}]`);
  });
  return out.slice(0, 6);
};

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
      const M = (await api('POST', `/api/volleyball/tournaments/${T.tournamentId}/matches`, { json: { teamA: A.teamId, teamB: B.teamId, venue: pi === 0 ? 'Shree Shiv Chhatrapati Sports Complex, Balewadi, Pune' : 'Hall ' + pi } })).json.match;
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
      for (const sc of ['setStart', 'rotation', 'timeout']) {
        const r = await gfx.emitAck('vb:graphic', { matchId: M.matchId, action: 'take', scene: sc });
        ok(`${sc}: refused for a finished match, with the reason`, !r.ok && typeof r.error === 'string' && r.error.length > 8, r);
      }
      for (const layout of ['bar', 'compact']) {
        await gfx.emitAck('vb:graphic', { matchId: M.matchId, action: 'live' });   // the last pass's held graphic off air
        const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
        const page = await ctx.newPage();
        await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(`http://127.0.0.1:${port}/volleyball-overlay?match=${M.matchId}${layout === 'compact' ? '&layout=compact' : ''}`);
        await page.waitForFunction(() => window.__vbOverlay && window.__vbOverlay.state === 'OVERLAY_VISIBLE', null, { timeout: 15000 });
        await page.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:-1;background:radial-gradient(ellipse at 50% 120%,#d9a066,#8a5a2b 35%,#2f4f2f 70%,#16261a)'; document.body.prepend(d); });
        const scenes = layout === 'bar'
          ? [['scorebug'], ['intro'], ['toss', { set: 1 }], ['toss', { set: 5 }], ['lineup', { set: 5, team: 'A' }], ['lineup', { set: 1, team: 'B' }], ['playerStat', { playerId: A.players[3].playerId }], ['setSummary', { set: 5 }], ['final'], ['scorecard'], ['standings']]
          : [['scorebug'], ['lineup', { set: 5, team: 'B' }], ['final'], ['playerStat', { playerId: B.players[3].playerId }]];
        for (const [scene, data] of scenes) {
          const label = `${layout} · ${scene}${data && data.set ? ' (set ' + data.set + ')' : ''}${data && data.team ? ' ' + data.team : ''}`;
          if (scene === 'scorebug') {
            await gfx.emitAck('vb:graphic', { matchId: M.matchId, action: 'live' });
            await page.waitForFunction(() => window.__vbOverlay.state === 'OVERLAY_VISIBLE', null, { timeout: 12000 }).catch(() => {});
            await sleep(600);
            const geo = await page.evaluate((lay) => { const e = document.querySelector(lay === 'bar' ? '#bar' : '#corner'); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom }; }, layout);
            ok(`${label}: inside the frame`, geo.x >= 0 && geo.y >= 0 && geo.r <= 1920 && geo.b <= 1080, geo);
          } else {
            const r = await gfx.emitAck('vb:graphic', { matchId: M.matchId, action: 'take', scene, data: data || {}, durationSec: 'hold' });
            const on = r.ok && await page.waitForFunction((gid) => { const o = window.__vbOverlay; return o && o.state === 'GRAPHIC_VISIBLE' && o.onAir && o.onAir.id === gid; }, r.graphic.id, { timeout: 15000 }).then(() => true, () => false);
            ok(`${label}: on air`, on, r.error);
            if (!on) continue;
            await sleep(300);
            const out = await page.evaluate(OUTSIDE);
            ok(`${label}: inside the frame`, out.length === 0, out);
            const barOff = await page.evaluate(() => ['#stage', '#pill', '#corner', '#tagL', '#tagR'].every((q) => { const e = document.querySelector(q); return !e || getComputedStyle(e).visibility === 'hidden' || getComputedStyle(e).display === 'none'; }));
            ok(`${label}: the ${layout === 'bar' ? 'score bar' : 'corner bug'} is off air under it`, barOff);
          }
          if (pi === 0 && layout === 'bar' && scene === 'intro') {
            // the check itself must see a cut name: a deliberately too-narrow one is reported
            await page.evaluate(() => { const b = document.createElement('b'); b.id = 'probe'; b.dataset.fit = '30'; b.textContent = 'Mumbai Thunderbolts'; b.style.cssText = 'display:block;position:absolute;left:100px;top:100px;width:120px;font-size:30px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'; document.querySelector('#gfx .scene').appendChild(b); });
            const probe = await page.evaluate(CLIPPED);
            ok('the "cut name" check itself catches a cut name', probe.some((x) => x.startsWith('Mumbai Thunderbolts')), probe);
            await page.evaluate(() => document.getElementById('probe').remove());
          }
          if (layout === 'bar' && scene === 'intro') {
            const al = await page.evaluate(() => ['.iteam.L', '.iteam.R'].map((s) => { const t = document.querySelector(s); return { plate: Math.round(t.querySelector('.plate').getBoundingClientRect().top), size: t.querySelector('.iname').style.fontSize, lines: Math.round(t.querySelector('.iname').offsetHeight / parseFloat(getComputedStyle(t.querySelector('.iname')).lineHeight)) }; }));
            ok(`${label}: both crests at one height, both names one size (${al.map((x) => x.lines).join(' + ')} lines)`, al[0].plate === al[1].plate && al[0].size === al[1].size, al);
          }
          // a heading that takes two lines pushes nothing into what is under it
          const clash = { intro: ['.ihead .iht', '.iln.t'], standings: ['.thead', '.trows'] }[scene];
          if (clash) {
            const gap = await page.evaluate((c) => { const a = document.querySelector('#gfx .scene ' + c[0]), b = document.querySelector('#gfx .scene ' + c[1]); return a && b ? Math.round(b.getBoundingClientRect().top - a.getBoundingClientRect().bottom) : null; }, clash);
            ok(`${label}: the heading clear of what follows it (${gap}px)`, gap !== null && gap >= 12, gap);
          }
          const cut = await page.evaluate(CLIPPED);
          ok(`${label}: no name cut short`, cut.length === 0, cut);
          await page.screenshot({ path: path.join(OUT, `layout-${pi}-${layout}-${scene}${data && data.set ? '-s' + data.set : ''}${data && data.team ? '-' + data.team : ''}.png`) });
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
