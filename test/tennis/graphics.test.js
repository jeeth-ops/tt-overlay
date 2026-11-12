/* 🎬 Tennis on-air rules (pure — tennis-graphics.js):
     scenes (one at a time, the bug leaves first, time on screen from the
     end of the entrance, the same press twice is one entrance, a stale stop
     is refused, an automatic scene never replaces the operator's), lower
     thirds beside the bug (a scene takes the screen from them), call-outs
     put on air once per event (never replayed: repeats, reconnects, after
     they ended), timers settling, the live bug Automatic / Manual, the
     automatic call-out an event earns (and only when it arises).

     node test/tennis/graphics.test.js
*/
'use strict';
const G = require('../../tennis-graphics.js');
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, expected: b }); }
function head(t) { console.log('\n=== ' + t + ' ==='); }
let seq = 100;
const opts = (extra) => Object.assign({ nextSeq: () => ++seq }, extra || {});
const T0 = 1700000000000;

head('SCENES');
{
  let cur = G.idle();
  const r = G.applyCommand(cur, { action: 'take', scene: 'intro' }, opts(), T0);
  ok('a scene goes on air', r.ok && r.next.scene === 'intro');
  eq('ready after the bug leaves + its entrance', r.next.readyAt - T0, G.BAR_OUT_MS + G.SCENES.intro.enterMs);
  eq('its time on screen counts from then', r.next.expiresAt - r.next.readyAt, 15000);
  cur = r.next;
  const same = G.applyCommand(cur, { action: 'take', scene: 'intro' }, opts(), T0 + 100);
  ok('the same scene again: no second entrance', same.ok && same.same && !same.next);
  const r2 = G.applyCommand(cur, { action: 'take', scene: 'toss', durationSec: null }, opts(), T0 + 200);
  ok('another scene replaces it (held)', r2.ok && r2.next.scene === 'toss' && r2.next.expiresAt === null && r2.next.endedScene === 'intro');
  eq('from a scene only the old scene has to leave', r2.next.readyAt - (T0 + 200), G.GFX_OUT_MS + G.SCENES.toss.enterMs);
  const stale = G.applyCommand(r2.next, { action: 'stop', id: cur.id }, opts(), T0 + 300);
  ok('a stop aimed at the graphic that was replaced is refused as stale', !stale.ok && stale.stale);
  const stop = G.applyCommand(r2.next, { action: 'stop', id: r2.next.id }, opts(), T0 + 300);
  ok('stop: back to the live score', stop.ok && !stop.next.scene && stop.next.endedScene === 'toss');
  const auto = G.applyCommand(r2.next, { action: 'take', scene: 'setWinner', auto: true }, opts(), T0 + 400);
  ok('an automatic scene never takes the screen from the operator\'s', auto.ok && !auto.next && auto.skipped);
  const bad = G.applyCommand(G.idle(), { action: 'take', scene: 'nope' }, opts(), T0);
  ok('unknown scene refused', !bad.ok);
  const chk = G.applyCommand(G.idle(), { action: 'take', scene: 'toss' }, opts({ check: () => ({ error: 'No toss recorded yet' }) }), T0);
  ok('the server\'s check can refuse with its reason', !chk.ok && chk.error === 'No toss recorded yet');
  const t = G.applyCommand(G.idle(), { action: 'take', scene: 'intro', durationSec: 9999 }, opts(), T0);
  ok('a silly time on screen is refused', !t.ok && t.error === G.BAD_TIME);
}

head('LOWER THIRDS');
{
  const r = G.applyCommand(G.idle(), { action: 'lower', kind: 'player', data: { playerId: 'p1' } }, opts(), T0);
  ok('a lower third beside the bug', r.ok && r.next.lower && r.next.lower.kind === 'player' && !r.next.scene);
  const again = G.applyCommand(r.next, { action: 'lower', kind: 'player', data: { playerId: 'p1' } }, opts(), T0 + 50);
  ok('the same lower third again: unchanged', again.ok && again.same);
  const sc = G.applyCommand(r.next, { action: 'take', scene: 'stats' }, opts(), T0 + 100);
  ok('a scene takes the screen from it', sc.ok && sc.next.lower === null);
  const refused = G.applyCommand(sc.next, { action: 'lower', kind: 'announce', data: { text: 'x' } }, opts(), T0 + 200);
  ok('no lower third over a full-screen graphic', !refused.ok);
  const off = G.applyCommand(r.next, { action: 'lower-off' }, opts(), T0 + 300);
  ok('lower third off', off.ok && off.next.lower === null);
  const tk = G.applyCommand(G.idle(), { action: 'lower', kind: 'ticker', data: { text: 'Next on court 1: …' } }, opts(), T0);
  ok('a ticker is held until taken off', tk.ok && tk.next.lower.expiresAt === null);
}

head('CALL-OUTS — once per event');
{
  const r = G.applyCommand(G.idle(), { action: 'moment', kind: 'ACE', side: 'A', eventId: 'ev1', auto: true }, opts(), T0);
  ok('an ACE call-out', r.ok && r.next.moment.kind === 'ACE' && r.next.moment.id === 'm:ev1:ACE');
  const rep = G.applyCommand(r.next, { action: 'moment', kind: 'ACE', side: 'A', eventId: 'ev1', auto: true }, opts(), T0 + 100);
  ok('the same event again (a repeat, a reconnect): not replayed', rep.ok && rep.same && !rep.next);
  const ended = G.settle(r.next, T0 + 60000, () => ++seq);
  ok('it ends by itself', ended && ended.moment === null);
  const after = G.applyCommand(ended, { action: 'moment', kind: 'ACE', side: 'A', eventId: 'ev1', auto: true }, opts(), T0 + 61000);
  ok('… and even after it ended, the same event never plays it again', after.ok && after.same);
  const sc = G.applyCommand(G.idle(), { action: 'take', scene: 'intro' }, opts(), T0);
  const autoOver = G.applyCommand(sc.next, { action: 'moment', kind: 'ACE', eventId: 'ev2', auto: true }, opts(), T0 + 10);
  ok('no automatic call-out over a full-screen graphic', autoOver.ok && autoOver.skipped && !autoOver.next);
  const manual = G.applyCommand(G.idle(), { action: 'moment', kind: 'MATCH_POINT', side: 'B' }, opts(), T0);
  ok('a call-out by hand', manual.ok && manual.next.moment.kind === 'MATCH_POINT' && !manual.next.moment.eventId);
  const off = G.applyCommand(r.next, { action: 'moment-off', eventId: 'ev1' }, opts(), T0 + 10);
  ok('an undone point takes its call-out off air', off.ok && off.next.moment === null);
  const other = G.applyCommand(r.next, { action: 'moment-off', eventId: 'zzz' }, opts(), T0 + 10);
  ok('… but not someone else\'s', other.ok && !other.next);
}

head('TIMERS AND THE LIVE BUG');
{
  const r = G.applyCommand(G.idle(), { action: 'take', scene: 'tiebreak' }, opts(), T0);
  ok('not expired before its time', G.settle(r.next, r.next.expiresAt - 1, () => ++seq) === null);
  const s = G.settle(r.next, r.next.expiresAt, () => ++seq);
  ok('expired: off air', s && !s.scene && s.reason === 'expired');
  eq('nextExpiry', G.nextExpiry(r.next), r.next.expiresAt);
  const m = G.applyCommand(G.idle(), { action: 'live-mode', mode: 'manual' }, opts(), T0);
  eq('manual starts from the tournament layout', m.next.live, { mode: 'manual', layout: 'bug' });
  const off = G.applyCommand(m.next, { action: 'live-off' }, opts(), T0);
  eq('live off: no bug', G.liveLayout(off.next, {}, null), null);
  const onBar = G.applyCommand(off.next, { action: 'live-on', layout: 'bar' }, opts(), T0);
  eq('the wide bar by hand', G.liveLayout(onBar.next, {}, null), 'bar');
  eq('an output fixed to graphics never shows the bug', G.liveLayout(G.idle(), {}, 'graphics'), null);
  const cl = G.applyCommand(G.applyCommand(G.idle(), { action: 'lower', kind: 'match' }, opts(), T0).next, { action: 'clean' }, opts(), T0);
  ok('hide everything: no bug, no lower third, no call-out', cl.next.clean && !cl.next.lower && !cl.next.moment && G.liveLayout(cl.next, {}, null) === null);
  const back = G.applyCommand(cl.next, { action: 'live' }, opts(), T0);
  ok('restore: the bug is back', !back.next.clean && G.liveLayout(back.next, {}, null) === 'bug');
}

head('THE CALL-OUT AN EVENT EARNS');
{
  const e = (effects, extra) => Object.assign({ type: 'POINT', effects }, extra || {});
  eq('an ace', G.momentFor(e([{ type: 'ACE', side: 'A', player: 'p1' }, { type: 'POINT_WON', side: 'A' }], { speed: 201 }), {}, {}, {}), { kind: 'ACE', side: 'A', playerId: 'p1', data: { speed: 201 } });
  eq('a double fault that breaks: the break', G.momentFor(e([{ type: 'DOUBLE_FAULT', side: 'B', player: 'p2' }, { type: 'GAME_WON', side: 'A', break: true }, { type: 'BREAK', side: 'A', games: { A: 3, B: 2 } }]), {}, {}, {}).kind, 'BREAK');
  eq('a set won', G.momentFor(e([{ type: 'GAME_WON', side: 'A' }, { type: 'SET_WON', side: 'A', set: 1, games: { A: 6, B: 4 } }]), {}, {}, {}).kind, 'SET_WON');
  eq('a match won', G.momentFor(e([{ type: 'SET_WON', side: 'B', set: 2 }, { type: 'MATCH_WON', side: 'B', reason: 'played' }]), {}, {}, {}).kind, 'MATCH_WON');
  const bp = { headline: { kind: 'break', side: 'B', count: 3 } };
  eq('break point when it arises (0-40)', G.momentFor(e([{ type: 'POINT_WON', side: 'B' }]), { headline: null }, bp, {}), { kind: 'BREAK_POINT', side: 'B', data: { count: 3, deciding: false, alsoBreak: false } });
  eq('… not again at 15-40 (the bug\'s tag keeps the count)', G.momentFor(e([{ type: 'POINT_WON', side: 'A' }]), bp, { headline: { kind: 'break', side: 'B', count: 2 } }, {}), null);
  eq('the tournament turned aces off', G.momentFor(e([{ type: 'ACE', side: 'A', player: 'p1' }]), {}, {}, { moments: { ACE: false } }), null);
  eq('no call-outs at all', G.momentFor(e([{ type: 'ACE', side: 'A' }]), {}, {}, { autoMoments: false }), null);
  eq('game point is off by default', G.momentFor(e([{ type: 'POINT_WON', side: 'A' }]), {}, { headline: { kind: 'game', side: 'A', count: 1 } }, {}), null);
  eq('a voided entry earns nothing', G.momentFor(e([{ type: 'ACE', side: 'A' }], { voided: true }), {}, {}, {}), null);
}

head('STYLE');
{
  const s = G.normalizeStyle({ accent: 'red', layout: 'bar', moments: { ACE: false }, speed: 3 });
  ok('bad colour → default; layout kept; speed back to standard', s.accent === G.STYLE_DEFAULTS.accent && s.layout === 'bar' && s.speed === 1);
  ok('per-kind call-outs', s.moments.ACE === false && s.moments.BREAK === true && s.moments.GAME_POINT === false);
  eq('durations kept only when valid', G.normalizeStyle({ durations: { intro: 20, toss: 'x', player: 'hold' } }).durations, { intro: 20, player: null });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
