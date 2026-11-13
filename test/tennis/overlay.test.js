/* 🎬 The tennis overlay (tennis-overlay.html) in Chromium at 1920×1080,
   against the REAL server (in-memory MongoDB, test tokens) — what vMix /
   OBS would show, frame by frame (every animation frame is sampled):

     • vMix safety: a transparent page on a fixed 1920×1080 canvas; no
       color-mix / :has / container queries / flex gap
     • the score bug follows the match point by point: the points, the
       games, the server's dot, the pressure tag
     • a call-out plays ONCE: an ace shows once however often the air state
       is sent again; it goes by itself; an undone ace's call-out goes at
       once; a reload in the middle of one does not play it again
     • a full-screen scene never sits on the bug: the bug leaves first; when
       the scene ends the bug comes back ONCE with the score as it is NOW
       (points scored meanwhile included)
     • rapid takes: only ever one scene mounted, the last one wins; the same
       take again changes nothing
     • a timed scene goes by itself; a reload in the middle of a scene shows
       it as it is — never the bug first, never its entrance again
     • a lower third comes and goes, and never sits under a scene
     • layouts: the wide bar (never the bug), graphics only (never either);
       what each output shows is reported to the server, a preview monitor
       flagged as one
     • no page errors; nothing left animating once things settle

     NODE_PATH=$(npm root -g) node test/tennis/overlay.test.js
   Screenshots: test/out/tennis/overlay-*.png
*/
const fs = require('fs');
const path = require('path');
const H = require('./browser-harness.js');
const { connectTn } = require('./tn-socket.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
const head = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every animation frame: how visible the bug, the bar, a scene, a lower
// third and a call-out are (opacity down the tree × the clip-path wipes),
// how many scenes are mounted, the controller's state and the points shown.
const SAMPLER = `(() => {
  if (window.__sampling) return; window.__sampling = true; window.__frames = [];
  const go = () => {
    const $ = (s) => document.querySelector(s);
    const op = (el) => { if (!el) return 0; let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return 0; o *= parseFloat(cs.opacity); } return o; };
    const clip = (el) => { const c = el ? getComputedStyle(el).clipPath : ''; const m = /inset\\(([^)]*)\\)/.exec(c || ''); if (!m) return 1; const v = m[1].split(' round ')[0].trim().split(/\\s+/); const r = v.length > 1 ? v[1] : v[0]; return /%$/.test(r) ? Math.max(0, 1 - parseFloat(r) / 100) : 1; };
    const tick = () => {
      const C = window.__tnOverlay && window.__tnOverlay.C;
      const bug = $('#bug'), host = $('#gfx'), bar = $('#bar'), low = $('#lower'), mo = $('#moment');
      const rows = bug ? Array.from(bug.querySelectorAll('.brow')) : [];
      const plate = bug && bug.querySelector('.bplate');
      const bugV = bug && op(bug) > 0 ? Math.max(op(plate) * clip(plate), ...rows.map(op), 0) : 0;
      const barV = bar && op(bar) > 0 ? Math.max(op(bar.querySelector('.bp')), op(bar.querySelector('.sd.a')), 0) : 0;
      const gfxEls = host && host.firstChild ? Array.from(host.querySelectorAll('.backdrop,.top,.half,.team,.card,.prof,.tbl,.sett,.foot,.vs,.press')) : [];
      const bd = host && host.querySelector('.backdrop');
      const moEl = mo && mo.querySelector('.mo');
      window.__frames.push({ t: Math.round(performance.now()), bug: +bugV.toFixed(3), bar: +barV.toFixed(3), gfx: gfxEls.length ? +Math.max(...gfxEls.map(op)).toFixed(3) : 0, bd: bd ? +op(bd).toFixed(3) : 0,
        mounted: host ? host.children.length : 0, lower: low && low.firstChild ? +op(low.firstChild).toFixed(3) : 0, moment: moEl ? +(op(moEl) * clip(moEl)).toFixed(3) : 0,
        momentText: moEl ? moEl.textContent : '', state: C ? C.state : null, scene: C && C.scene ? C.scene.scene : null,
        pts: rows.map((r) => ((r.querySelector('.pts') || {}).textContent || '')).join('|') });
      if (window.__frames.length > 30000) window.__frames.splice(0, 10000);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();`;

// how many times a layer came up (from not visible to visible) in a run of frames
const appearances = (frames, k, th) => { let n = 0, on = false; for (const f of frames) { const v = f[k] > (th || 0.02); if (v && !on) n++; on = v; } return n; };

(async () => {
  const h = await H.start();
  const pages = [];
  try {
    const { m, P, t } = await h.seed({ photos: false });
    const MID = m.matchId;
    const lease = (await h.api('POST', `/api/tennis/matches/${MID}/lease`, { json: { deviceId: 'panel' } })).json.leaseToken;
    const sock = await connectTn(h.port, { idToken: 'tok-work' });
    await sock.emitAck('tn:join', { matchId: MID });
    let n = 0;
    const send = async (ev) => { const r = await sock.emitAck('tn:event', { matchId: MID, leaseToken: lease, event: Object.assign({ eventId: 'ov' + (++n) + 'x' + Date.now().toString(36), at: Date.now() }, ev) }); return r; };
    const gfx = (cmd) => sock.emitAck('tn:graphic', Object.assign({ matchId: MID, reqId: 'rq' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }, cmd));
    await send({ type: 'TOSS', winner: 'A', choice: 'serve', firstServe: 'A', left: 'A' });
    await send({ type: 'START', server: P.a.playerId, left: 'A' });

    const open = async (q, o) => {
      const page = await h.open('/tennis-overlay?match=' + MID + (q || ''), Object.assign({ viewport: { width: 1920, height: 1080 }, who: null }, o || {}));
      await page.addInitScript(SAMPLER);
      await page.evaluate(SAMPLER);
      await page.waitForSelector('body.ready', { timeout: 15000 });
      pages.push(page);
      return page;
    };
    const frames = (page, since) => page.evaluate((s) => window.__frames.filter((f) => f.t >= s), since || 0);
    const now = (page) => page.evaluate(() => Math.round(performance.now()));
    const state = (page) => page.evaluate(() => window.__tnOverlay.C.state);
    const waitState = async (page, want, ms) => { const until = Date.now() + (ms || 8000); let s; while (Date.now() < until) { s = await state(page); if (want.includes(s)) return s; await sleep(60); } return s; };

    head('1 · vMIX SAFETY — a transparent page on a 1920×1080 canvas');
    const page = await open('');
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'tennis-overlay.html'), 'utf8');
    const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || []).join('\n');
    ok('no color-mix, :has() or container queries in its CSS (older vMix browsers)', !/color-mix\(|:has\(|@container/.test(css));
    const flexGap = (css.match(/[^{}]+\{[^{}]*\}/g) || []).filter((rule) => /display\s*:\s*(inline-)?flex/.test(rule) && /(^|[;{\s])(row-|column-)?gap\s*:/.test(rule));
    ok('no flex gap', flexGap.length === 0, flexGap.slice(0, 3));
    const look = await page.evaluate(() => ({ html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor, fit: [document.getElementById('fit').offsetWidth, document.getElementById('fit').offsetHeight] }));
    ok('the page itself is transparent (the overlay sits on the camera)', /rgba\(0, 0, 0, 0\)|transparent/.test(look.html) && /rgba\(0, 0, 0, 0\)|transparent/.test(look.body), look);
    ok('…on a fixed 1920 × 1080 canvas', look.fit[0] === 1920 && look.fit[1] === 1080, look.fit);

    head('2 · THE SCORE BUG FOLLOWS THE MATCH');
    ok('the bug comes in once the match is on', await waitState(page, ['OVERLAY_VISIBLE']) === 'OVERLAY_VISIBLE');
    await send({ type: 'POINT', winner: 'A', serve: 1 });
    await send({ type: 'POINT', winner: 'A', serve: 1 });
    await sleep(900);
    let bug = await page.evaluate(() => ({ rows: Array.from(document.querySelectorAll('#bug .brow')).map((r) => ({ name: r.querySelector('.nm').textContent, pts: r.querySelector('.pts').textContent, srv: r.classList.contains('srv') })), right: document.getElementById('bhR').textContent }));
    ok('names, points 30-0, the server marked, "Set 1"', bug.rows[0].name.includes('Alcaraz') && bug.rows[1].name.includes('Sinner') && bug.rows[0].pts === '30' && bug.rows[1].pts === '0' && bug.rows[0].srv && !bug.rows[1].srv && bug.right === 'Set 1', bug);
    await h.shot(page, 'overlay-bug-30-0');

    head('3 · A CALL-OUT PLAYS ONCE');
    let mark = await now(page);
    const ace = await send({ type: 'POINT', winner: 'A', serve: 1, kind: 'ACE', speed: 204 });
    await sleep(1200);
    let f = await frames(page, mark);
    ok('an ace: "Ace" called out beside the bug, with the server’s name and the speed', f.some((x) => x.moment > 0.9 && /Ace/.test(x.momentText) && /Alcaraz/.test(x.momentText) && /204/.test(x.momentText)), f.filter((x) => x.moment > 0).slice(-1));
    await h.shot(page, 'overlay-callout-ace');
    // the air state sent again and again (another output's report, a lower third command that changes nothing …)
    for (let i = 0; i < 3; i++) await gfx({ action: 'lower-off' });
    await sleep(4500);
    f = await frames(page, mark);
    ok('…shown exactly once however often the air state is sent again, then gone by itself (4 s)', appearances(f, 'moment') === 1 && f[f.length - 1].moment === 0, { n: appearances(f, 'moment'), last: f[f.length - 1].moment });
    ok('…the points moved on underneath it (40-0)', f[f.length - 1].pts === '40|0', f[f.length - 1].pts);

    mark = await now(page);
    const ace2 = await send({ type: 'POINT', winner: 'A', serve: 1, kind: 'ACE' });   // game A — and its call-out
    await sleep(900);
    const und = await send({ type: 'UNDO', target: ace2.event ? ace2.event.eventId : undefined });
    await sleep(1400);
    f = await frames(page, mark);
    const upAt = f.findIndex((x) => x.moment > 0.5), goneAt = f.findIndex((x, i) => i > upAt && x.moment === 0);
    ok('an ace undone: its call-out goes at once (well before its 4 s), the score back to 40-0', und.ok && upAt >= 0 && goneAt > upAt && f[goneAt].t - f[upAt].t < 2600 && f[f.length - 1].pts === '40|0', { und: und.ok, upAt, goneAt, ms: goneAt > 0 ? f[goneAt].t - f[upAt].t : null, pts: f[f.length - 1].pts });

    // a reload in the middle of a call-out
    await send({ type: 'FAULT' });
    await send({ type: 'POINT', winner: 'B', serve: 2, kind: 'DOUBLE_FAULT' });
    await sleep(1500);
    await page.reload();
    await page.waitForSelector('body.ready', { timeout: 15000 });
    await sleep(3200);
    f = await frames(page, 0);
    ok('a reload in the middle of a call-out (a double fault) does not play it again', f.length > 20 && appearances(f, 'moment') === 0, { n: appearances(f, 'moment'), frames: f.length });
    ok('…and the bug is back with the score as it is (40-15)', f[f.length - 1].bug > 0.9 && f[f.length - 1].pts === '40|15', f[f.length - 1]);

    head('4 · A FULL-SCREEN SCENE NEVER SITS ON THE BUG');
    mark = await now(page);
    let r = await gfx({ action: 'take', scene: 'setScore', durationSec: null });
    ok('the set score is taken to air', r.ok, r);
    ok('…it comes up', await waitState(page, ['GRAPHIC_VISIBLE'], 8000) === 'GRAPHIC_VISIBLE');
    await h.shot(page, 'overlay-scene-setscore');
    // two points while the scene is up (the bug is not on screen)
    await send({ type: 'POINT', winner: 'A', serve: 1 });   // game A: 1-0
    await send({ type: 'POINT', winner: 'B', serve: 1 });   // B serving now: 0-15
    await sleep(600);
    r = await gfx({ action: 'live' });
    ok('back to live', r.ok, r);
    await waitState(page, ['OVERLAY_VISIBLE'], 8000);
    await sleep(500);
    f = await frames(page, mark);
    const overlap = f.filter((x) => x.gfx > 0.02 && (x.bug > 0.02 || x.bar > 0.02));
    ok('not one frame with the scene and the bug both on screen', overlap.length === 0, overlap.slice(0, 3));
    const gfxFirst = f.findIndex((x) => x.gfx > 0.02), bugGone = f.findIndex((x) => x.bug <= 0.02);
    ok('…the bug left first, then the scene came in', bugGone >= 0 && gfxFirst > bugGone, { bugGone, gfxFirst });
    const after = f.slice(f.findIndex((x, i) => i > gfxFirst && x.gfx <= 0.02));
    const back = after.find((x) => x.bug > 0.02);
    ok('when the scene ended the bug came back ONCE, already showing the score as it is now (0-15, games 1-0)', appearances(after, 'bug') === 1 && back && back.pts === '0|15', { n: appearances(after, 'bug'), first: back && back.pts });

    head('5 · RAPID TAKES — one scene at a time, the last one wins');
    mark = await now(page);
    await Promise.all([gfx({ action: 'take', scene: 'intro', durationSec: null }), sleep(40).then(() => gfx({ action: 'take', scene: 'stats', durationSec: null })), sleep(80).then(() => gfx({ action: 'take', scene: 'setScore', durationSec: null }))]);
    await sleep(3500);
    await waitState(page, ['GRAPHIC_VISIBLE'], 6000);
    f = await frames(page, mark);
    ok('never more than one scene mounted', Math.max(...f.map((x) => x.mounted)) <= 1, Math.max(...f.map((x) => x.mounted)));
    ok('…the last take is the one on air', f[f.length - 1].scene === 'setScore' && f[f.length - 1].gfx > 0.9, f[f.length - 1]);
    ok('…and still never with the bug', f.filter((x) => x.gfx > 0.02 && x.bug > 0.02).length === 0);
    mark = await now(page);
    r = await gfx({ action: 'take', scene: 'setScore', durationSec: null });
    await sleep(1500);
    f = await frames(page, mark);
    ok('the same take again changes nothing (no exit, no new entrance)', r.ok && r.same === true && f.every((x) => x.gfx > 0.9 && x.scene === 'setScore'), { r: { ok: r.ok, same: r.same }, min: Math.min(...f.map((x) => x.gfx)) });

    head('6 · A TIMED SCENE GOES BY ITSELF');
    await gfx({ action: 'live' });
    await waitState(page, ['OVERLAY_VISIBLE'], 8000);
    mark = await now(page);
    r = await gfx({ action: 'take', scene: 'stats', durationSec: 2 });
    ok('the statistics, for 2 s', r.ok, r);
    await waitState(page, ['GRAPHIC_VISIBLE'], 8000);
    await h.shot(page, 'overlay-scene-stats');
    const shownAt = Date.now();
    const s6 = await waitState(page, ['OVERLAY_VISIBLE'], 12000);
    f = await frames(page, mark);
    ok('…it ended on its own and the bug came back, once', s6 === 'OVERLAY_VISIBLE' && Date.now() - shownAt < 9000 && appearances(f.slice(f.findIndex((x) => x.gfx > 0.02)), 'bug') === 1, { s6, ms: Date.now() - shownAt });

    head('7 · A RELOAD IN THE MIDDLE OF A SCENE — shown as it is');
    r = await gfx({ action: 'take', scene: 'intro', durationSec: null });
    await waitState(page, ['GRAPHIC_VISIBLE'], 8000);
    await sleep(800);
    await page.reload();
    await page.waitForSelector('body.ready', { timeout: 15000 });
    await waitState(page, ['GRAPHIC_VISIBLE'], 8000);
    await sleep(700);
    f = await frames(page, 0);
    const firstUp = f.find((x) => x.gfx > 0.02);
    ok('after the reload: never the bug before the scene', f.every((x) => x.bug <= 0.02), f.filter((x) => x.bug > 0.02).slice(0, 2));
    ok('…and the scene is up as it was, not played in again (its first frame already whole)', firstUp && firstUp.bd > 0.9 && firstUp.gfx > 0.9, firstUp);
    await h.shot(page, 'overlay-scene-intro-after-reload');

    head('8 · A LOWER THIRD — in, out, never under a scene');
    await gfx({ action: 'live' });
    await waitState(page, ['OVERLAY_VISIBLE'], 8000);
    mark = await now(page);
    r = await gfx({ action: 'lower', kind: 'player', data: { playerId: P.a.playerId } });
    await sleep(1600);
    const lowText = await page.evaluate(() => document.getElementById('lower').textContent);
    ok('the player’s lower third comes in, with the player’s name', r.ok && /Alcaraz/.test(lowText), { r: r.ok, lowText: lowText.slice(0, 80) });
    await h.shot(page, 'overlay-lower-player');
    r = await gfx({ action: 'take', scene: 'setScore', durationSec: null });
    await waitState(page, ['GRAPHIC_VISIBLE'], 8000);
    f = await frames(page, mark);
    ok('a scene taken over it: the lower third leaves first — never both on screen', f.filter((x) => x.lower > 0.02 && x.gfx > 0.02).length === 0 && f[f.length - 1].lower === 0, f.filter((x) => x.lower > 0.02 && x.gfx > 0.02).slice(0, 2));
    await gfx({ action: 'live' });
    await waitState(page, ['OVERLAY_VISIBLE'], 8000);
    r = await gfx({ action: 'lower', kind: 'player', data: { playerId: P.b.playerId } });
    await sleep(1400);
    r = await gfx({ action: 'lower-off' });
    await sleep(1200);
    ok('…and Hide takes it off', r.ok && await page.evaluate(() => !document.getElementById('lower').firstChild), r);

    head('9 · LAYOUTS, AND WHAT EACH OUTPUT SAYS IT SHOWS');
    const barPage = await open('&layout=bar');
    const gfxPage = await open('&layout=graphics');
    const monPage = await open('&monitor=1');
    await sleep(2200);
    let fb = await frames(barPage, 0), fg = await frames(gfxPage, 0);
    ok('&layout=bar: the wide bar, never the corner bug', fb[fb.length - 1].bar > 0.9 && fb.every((x) => x.bug <= 0.02), fb[fb.length - 1]);
    await h.shot(barPage, 'overlay-layout-bar');
    ok('&layout=graphics: neither the bug nor the bar', fg.every((x) => x.bug <= 0.02 && x.bar <= 0.02));
    r = await gfx({ action: 'take', scene: 'setScore', durationSec: null });
    for (const pg of [gfxPage, page, monPage]) await waitState(pg, ['GRAPHIC_VISIBLE'], 10000);
    await waitState(barPage, ['IDLE'], 8000);
    fg = await frames(gfxPage, 0); fb = await frames(barPage, 0);
    ok('…but the scenes, yes', fg[fg.length - 1].gfx > 0.9, fg[fg.length - 1]);
    ok('the bar-only page takes its bar off for the scene (a scene is for the other outputs) — never both', fb.filter((x) => x.gfx > 0.02 && x.bar > 0.02).length === 0 && fb[fb.length - 1].bar <= 0.02 && fb[fb.length - 1].gfx === 0, fb[fb.length - 1]);
    await sleep(400);
    const j = await sock.emitAck('tn:join', { matchId: MID });
    const outs = j.outputs || [];
    const shows = outs.filter((o) => !o.monitor && o.layoutParam !== 'bar');
    ok('the server lists what every output shows: the scene on air, on the airSeq it was told', outs.length === 4 && shows.length === 2 && shows.every((o) => o.state === 'GRAPHIC_VISIBLE' && o.scene === 'setScore' && o.airSeq === r.graphic.seq), outs.map((o) => [o.layoutParam, o.state, o.scene, o.monitor, o.airSeq]));
    ok('…the bar-only output says it shows nothing right now', outs.some((o) => o.layoutParam === 'bar' && o.state === 'IDLE' && !o.layout), outs.filter((o) => o.layoutParam === 'bar'));
    ok('…the preview monitor is flagged as one (not counted as on air)', outs.filter((o) => o.monitor).length === 1, outs.map((o) => o.monitor));
    await gfx({ action: 'live' });
    await waitState(page, ['OVERLAY_VISIBLE'], 8000);
    await sleep(1500);

    head('10 · CLEAN');
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.effect && a.effect.target ? a.effect.target.className || a.effect.target.id : '?'));
    ok('nothing left animating once things settle', running.length === 0, running);
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
