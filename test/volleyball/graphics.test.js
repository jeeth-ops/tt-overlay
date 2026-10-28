/* 🎬 Volleyball broadcast graphics — the on-air rules (volleyball-graphics.js),
   pure: one graphic at a time, the score bar leaves first, a finite time on
   screen counts from the end of the entrance, a replaced or stopped graphic
   is never ended by a late command, the starting six of both teams hands
   over from team one to team two, the broadcast look is validated.

     node test/volleyball/graphics.test.js
*/
const G = require('../../volleyball-graphics.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, expected: b }); }
function head(t) { console.log('\n=== ' + t + ' ==='); }

let seq = 100;
const opts = (extra) => Object.assign({ nextSeq: () => ++seq }, extra || {});
const T0 = 1000000;
const S = G.SCENES;

head('TAKE: the bar leaves, the graphic comes in, its time counts from then');
let r = G.applyCommand(G.idle(), { action: 'take', scene: 'toss', data: { set: 1 } }, opts(), T0);
ok('a graphic goes on air', r.ok && r.next && r.next.scene === 'toss', r);
const toss = r.next;
eq('ready after the bar has left and the entrance is over', toss.readyAt, T0 + G.BAR_OUT_MS + S.toss.enterMs);
eq('the default time on screen (10 s) counts from then', toss.expiresAt, toss.readyAt + 10000);
ok('an id of its own', /^g[0-9a-z]+$/.test(toss.id), toss.id);
eq('its data as asked', toss.data, { set: 1 });

r = G.applyCommand(toss, { action: 'take', scene: 'toss', data: { set: 1 } }, opts(), T0 + 500);
ok('the same graphic pressed again stays up — no second entrance', r.ok && r.same && r.next === null, r);
r = G.applyCommand(Object.assign({}, toss, { reqId: 'press-1' }), { action: 'take', scene: 'intro', reqId: 'press-1' }, opts(), T0 + 500);
ok('a retried press (same request id) changes nothing', r.ok && r.same && r.next === null, r);

r = G.applyCommand(toss, { action: 'take', scene: 'standings' }, opts(), T0 + 3000);
const st = r.next;
ok('a new graphic replaces the one on air', r.ok && st.scene === 'standings' && st.endedId === toss.id && st.endedScene === 'toss', st);
eq('…only the old graphic has to leave first (the bar is already off)', st.readyAt, T0 + 3000 + G.GFX_OUT_MS + S.standings.enterMs);
eq('…the points table: 20 s by default', st.expiresAt, st.readyAt + 20000);

head('STOP / LIVE / CLEAN — and stale commands');
r = G.applyCommand(st, { action: 'stop', id: toss.id }, opts(), T0 + 4000);
ok('a stop aimed at the replaced graphic is refused as stale', !r.ok && r.stale && r.next === null, r);
r = G.applyCommand(st, { action: 'stop', id: st.id }, opts(), T0 + 4000);
ok('a stop aimed at the graphic on air ends it', r.ok && r.next.scene === null && r.next.endedId === st.id && r.next.reason === 'stopped' && !r.next.clean, r.next);
const off = r.next;
r = G.applyCommand(off, { action: 'stop' }, opts(), T0 + 4100);
ok('stopping when nothing is on air changes nothing', r.ok && r.next === null, r);
r = G.applyCommand(st, { action: 'clean' }, opts(), T0 + 4000);
ok('"hide everything": the graphic goes and the bar stays off', r.ok && r.next.scene === null && r.next.clean === true && r.next.endedId === st.id, r.next);
const clean = r.next;
r = G.applyCommand(clean, { action: 'take', scene: 'intro' }, opts(), T0 + 5000);
eq('from a hidden bar a graphic comes straight in', r.next.readyAt, T0 + 5000 + S.intro.enterMs);
ok('…and when it ends the live score returns (no longer hidden)', r.next.clean === false);
r = G.applyCommand(clean, { action: 'live' }, opts(), T0 + 5000);
ok('"live" brings the score bar back', r.ok && r.next.scene === null && r.next.clean === false, r.next);

head('TIMED or HOLD — the server ends a timed graphic, never a held one');
r = G.applyCommand(G.idle(), { action: 'take', scene: 'final', durationSec: null }, opts(), T0);
ok('the match result holds until dismissed by default', r.next.durationSec === null && r.next.expiresAt === null, r.next);
ok('…settle never ends a held graphic', G.settle(r.next, T0 + 3600e3, () => ++seq) === null);
const intro = G.applyCommand(G.idle(), { action: 'take', scene: 'intro', durationSec: 8 }, opts(), T0).next;
ok('a timed graphic is still up just before its time', G.settle(intro, intro.expiresAt - 1, () => ++seq) === null);
const ended = G.settle(intro, intro.expiresAt, () => ++seq);
ok('…and off air at its time (reason "expired")', ended && ended.scene === null && ended.reason === 'expired' && ended.endedId === intro.id, ended);
r = G.applyCommand(intro, { action: 'duration', id: intro.id, durationSec: 30 }, opts(), T0 + 500);
eq('a new time while it is still coming in counts from the end of the entrance', r.next.expiresAt, intro.readyAt + 30000);
r = G.applyCommand(intro, { action: 'duration', id: intro.id, durationSec: 5 }, opts(), intro.readyAt + 6000);
eq('…once it is up, from now', r.next.expiresAt, intro.readyAt + 6000 + 5000);
r = G.applyCommand(intro, { action: 'duration', id: intro.id, durationSec: 'hold' }, opts(), T0 + 500);
ok('…or Hold: no end at all', r.next.expiresAt === null && r.next.durationSec === null, r.next);
r = G.applyCommand(intro, { action: 'duration', id: intro.id, durationSec: 9999 }, opts(), T0 + 500);
ok('an impossible time is refused', !r.ok && r.error === G.BAD_TIME, r);
r = G.applyCommand(G.idle(), { action: 'take', scene: 'intro', durationSec: -3 }, opts(), T0);
ok('…when taking too', !r.ok && r.error === G.BAD_TIME, r);
r = G.applyCommand(intro, { action: 'take', scene: 'intro', durationSec: 20 }, opts(), T0 + 500);
ok('pressing the graphic on air again with a new time only changes its time', r.ok && r.next.id === intro.id && r.next.expiresAt === intro.readyAt + 20000, r.next);

head('STARTING SIX OF BOTH TEAMS — team one, then team two');
const both = G.applyCommand(G.idle(), { action: 'take', scene: 'lineup', data: { set: 1 }, durationSec: 12 }, opts(), T0).next;
eq('team two takes over after team one\'s 12 s', both.swapAt, both.readyAt + 12000);
eq('…and has its own 12 s once it is in', both.expiresAt, both.swapAt + G.LINEUP_SWAP_MS + 12000);
eq('team up before the swap: the first', G.lineupTeamAt(both, both.swapAt - 1, ['A', 'B']), 'A');
eq('…after it: the second', G.lineupTeamAt(both, both.swapAt, ['A', 'B']), 'B');
r = G.applyCommand(both, { action: 'next', id: both.id }, opts(), both.readyAt + 2000);
eq('NEXT TEAM swaps now', r.next.swapAt, both.readyAt + 2000);
eq('…and team two still gets its full time', r.next.expiresAt, both.readyAt + 2000 + G.LINEUP_SWAP_MS + 12000);
const swapped = r.next;
r = G.applyCommand(swapped, { action: 'next', id: both.id }, opts(), both.readyAt + 3000);
ok('…once team two is up, NEXT TEAM changes nothing', r.ok && r.next === null, r);
const held = G.applyCommand(G.idle(), { action: 'take', scene: 'lineup', data: { set: 2 }, durationSec: null }, opts(), T0).next;
ok('held: team one stays until NEXT TEAM', held.swapAt === null && held.expiresAt === null, held);
r = G.applyCommand(held, { action: 'next' }, opts(), T0 + 500);
eq('…NEXT TEAM during its entrance swaps once it is in', r.next.swapAt, held.readyAt);
ok('…and team two holds too', r.next.expiresAt === null);
const one = G.applyCommand(G.idle(), { action: 'take', scene: 'lineup', data: { set: 1, team: 'B' } }, opts(), T0).next;
ok('one team: no swap', one.swapAt === null && one.expiresAt === one.readyAt + 12000 && G.lineupTeamAt(one, T0 + 99e3, ['A', 'B']) === 'B', one);
r = G.applyCommand(one, { action: 'next' }, opts(), T0 + 500);
ok('…NEXT TEAM is refused', !r.ok && r.stale, r);

head('WHAT THE MATCH HAS TO SHOW');
r = G.applyCommand(G.idle(), { action: 'take', scene: 'toss' }, opts({ check: () => ({ error: 'No toss recorded yet' }) }), T0);
ok('a graphic with nothing true to show is refused with the reason', !r.ok && r.error === 'No toss recorded yet' && r.next === null, r);
r = G.applyCommand(G.idle(), { action: 'take', scene: 'toss' }, opts({ check: () => ({ data: { set: 5 } }) }), T0);
eq('…the server decides what it shows (the deciding-set toss)', r.next.data, { set: 5 });
r = G.applyCommand(G.idle(), { action: 'take', scene: 'timeout' }, opts({ check: () => ({ data: { team: 'A' }, untilAt: T0 + 30000 }) }), T0);
eq('a time-out graphic ends with the time-out', r.next.expiresAt, T0 + 30000);
r = G.applyCommand(G.idle(), { action: 'take', scene: 'timeout' }, opts({ check: () => ({ data: { team: 'A' }, untilAt: T0 + 1000 }) }), T0);
eq('…but is up at least 3 s once in', r.next.expiresAt, r.next.readyAt + 3000);
r = G.applyCommand(G.idle(), { action: 'take', scene: 'confetti' }, opts(), T0);
ok('an unknown graphic is refused', !r.ok && r.error === 'Unknown graphic', r);
eq('data is cut down to what the graphic uses', G.cleanData('lineup', { set: '2', team: 'B', evil: '<script>', set2: 9 }), { set: 2, team: 'B' });
eq('…a player card keeps only its player', G.cleanData('playerStat', { playerId: 'vbp1', name: 'x' }), { playerId: 'vbp1' });

head('THE OLDER PANELS\' COMMANDS');
r = G.applyCommand(st, { scene: 'scorebug' }, opts(), T0 + 4000);
ok('{ scene: scorebug } = the live score', r.ok && r.next.scene === null && !r.next.clean, r.next);
r = G.applyCommand(G.idle(), { scene: 'none' }, opts(), T0);
ok('{ scene: none } = hide everything', r.ok && r.next.clean === true, r.next);
r = G.applyCommand(G.idle(), { scene: 'intro', durationSec: 0 }, opts(), T0);
ok('{ scene: intro } = take it (its default time)', r.ok && r.next.scene === 'intro' && r.next.expiresAt === r.next.readyAt + 15000, r.next);

head('THE BROADCAST LOOK');
const d = G.normalizeStyle(null);
ok('defaults', d.accent === '#ffd60a' && d.backdrop === 'scrim' && d.speed === 1 && d.font === 'barlow' && d.layout === 'bar' && d.pointTags === true, d);
const bad = G.normalizeStyle({ accent: 'red', base: '#12345', backdrop: 'video', dim: 7, font: 'comic', speed: 3, plates: 'x', names: 'y', layout: 'top', durations: { intro: 0, toss: 'hold', final: 45, standings: -2, nope: 3 } });
ok('anything invalid falls back to the default', bad.accent === '#ffd60a' && bad.base === '#0a1136' && bad.backdrop === 'scrim' && bad.dim === 0.95 && bad.font === 'barlow' && bad.speed === 1 && bad.plates === 'auto' && bad.names === 'auto' && bad.layout === 'bar', bad);
eq('…times on screen: hold, seconds, nothing invalid kept', bad.durations, { intro: null, toss: null, final: 45 });
const calm = G.normalizeStyle({ speed: 1.25, durations: { toss: 6 } });
r = G.applyCommand(G.idle(), { action: 'take', scene: 'toss' }, opts({ style: calm }), T0);
eq('a calm motion speed stretches the entrance', r.next.readyAt, T0 + Math.round((G.BAR_OUT_MS + S.toss.enterMs) * 1.25));
eq('…and the tournament\'s own time on screen is used', r.next.expiresAt, r.next.readyAt + 6000);

head('THE TIME-OUT BEING TAKEN');
const rules = { timeoutSeconds: 30 };
const tl = [{ type: 'SET_START', at: 1000 }, { type: 'RALLY', at: 5000 }, { type: 'TIMEOUT', team: 'B', at: 10000 }];
eq('a time-out with no rally after it, inside its 30 s', G.runningTimeout(tl, rules, 20000), { team: 'B', technical: false, at: 10000, endsAt: 40000, seconds: 30 });
ok('…over after its 30 s', G.runningTimeout(tl, rules, 40000) === null);
ok('…over once the next rally is played', G.runningTimeout(tl.concat([{ type: 'RALLY', at: 15000 }]), rules, 20000) === null);
ok('…an undone (voided) time-out is no time-out', G.runningTimeout([tl[0], tl[1], Object.assign({}, tl[2], { voided: true })], rules, 20000) === null);
const tech = G.runningTimeout([{ type: 'SET_START', at: 1000 }, { type: 'RALLY', at: 5000, effects: [{ type: 'TECHNICAL_TIMEOUT', at: 8 }] }], rules, 20000);
ok('a technical time-out called by the last rally (60 s)', tech && tech.technical && tech.endsAt === 65000 && tech.team === null, tech);

head('WHAT THE OVERLAY IS TOLD');
const pub = G.publicState(Object.assign({}, toss, { reqId: 'secret-press' }), T0 + 10);
ok('the press id stays on the server', !('reqId' in pub));
ok('the server clock and the timing go with it', pub.serverNow === T0 + 10 && pub.timing.barOutMs === G.BAR_OUT_MS && pub.timing.enterMs === S.toss.enterMs && pub.label === 'Coin toss', pub);
ok('every scene has a label, a group and an entrance', G.ORDER.every((k) => S[k] && S[k].label && G.GROUPS[S[k].group] && S[k].enterMs > 0) && G.ORDER.length === Object.keys(S).length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
