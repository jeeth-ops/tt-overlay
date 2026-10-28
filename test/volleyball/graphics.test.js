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

head('THE LIVE OVERLAY — Automatic, or Manual: exactly what the operator took');
const bar = G.normalizeStyle({ layout: 'bar' }), corner = G.normalizeStyle({ layout: 'compact' });
eq('a new match: automatic', G.idle().live, { mode: 'auto', layout: null });
eq('a state saved before there was a live overlay state is automatic', G.liveOf({ seq: 3, scene: null }), { mode: 'auto', layout: null });
ok('automatic shows the tournament\'s layout', G.liveLayout(G.idle(), bar, null) === 'bar' && G.liveLayout(G.idle(), corner, null) === 'compact');
ok('…an output with its own ?layout= shows that one, "graphics" shows none', G.liveLayout(G.idle(), bar, 'compact') === 'compact' && G.liveLayout(G.idle(), bar, 'graphics') === null);
ok('…and "hide everything" shows none', G.liveLayout(Object.assign(G.idle(), { clean: true }), bar, null) === null);
r = G.applyCommand({ seq: 5, id: null, scene: null, clean: false }, { action: 'take', scene: 'toss' }, opts(), T0);
eq('a command on an older state carries the live overlay\'s state on', r.next.live, { mode: 'auto', layout: null });

r = G.applyCommand(G.idle(), { action: 'live-on', layout: 'compact' }, opts({ style: bar }), T0);
const mCorner = r.next;
ok('TAKE ON AIR the corner bug: manual, the corner bug — the tournament\'s bar is replaced', r.ok && mCorner.live.mode === 'manual' && mCorner.live.layout === 'compact' && G.liveLayout(mCorner, bar, null) === 'compact', mCorner);
ok('…an output kept to the score bar (?layout=bar) shows nothing: they are alternatives', G.liveLayout(mCorner, bar, 'bar') === null && G.liveLayout(mCorner, bar, 'compact') === 'compact');
r = G.applyCommand(mCorner, { action: 'live-on', layout: 'compact' }, opts({ style: bar }), T0 + 100);
ok('…pressed again: nothing changes (no second entrance)', r.ok && r.same && r.next === null, r);
r = G.applyCommand(mCorner, { action: 'live-on', layout: 'bar' }, opts({ style: bar }), T0 + 200);
const mBar = r.next;
ok('taking the score bar on air replaces the corner bug', r.ok && mBar.live.layout === 'bar' && G.liveLayout(mBar, corner, null) === 'bar', mBar);
r = G.applyCommand(mBar, { action: 'live-off', layout: 'compact' }, opts({ style: bar }), T0 + 300);
ok('TAKE OFF AIR the one that is not on air changes nothing', r.ok && r.same && r.next === null, r);
r = G.applyCommand(mBar, { action: 'live-off', layout: 'bar' }, opts({ style: bar }), T0 + 400);
const mOff = r.next;
ok('TAKE OFF AIR the score bar: manual, nothing', r.ok && mOff.live.mode === 'manual' && mOff.live.layout === null && G.liveLayout(mOff, bar, null) === null && G.liveLayout(mOff, bar, 'bar') === null, mOff);
r = G.applyCommand(mOff, { action: 'take', scene: 'intro', durationSec: 8 }, opts({ style: bar }), T0 + 1000);
const gOverOff = r.next;
eq('…a graphic taken then needs no bar to leave first', gOverOff.readyAt, T0 + 1000 + S.intro.enterMs);
const gEnded = G.settle(gOverOff, gOverOff.expiresAt, () => ++seq);
ok('…when its time is up, nothing comes back (the bar stays off)', gEnded && gEnded.scene === null && G.liveLayout(gEnded, bar, null) === null && gEnded.live.mode === 'manual', gEnded);
r = G.applyCommand(G.applyCommand(mOff, { action: 'take', scene: 'toss' }, opts({ style: bar }), T0).next, { action: 'stop' }, opts({ style: bar }), T0 + 5000);
ok('…nor when it is dismissed', r.ok && r.next.scene === null && G.liveLayout(r.next, bar, null) === null, r.next);

r = G.applyCommand(G.idle(), { action: 'take', scene: 'standings', durationSec: 'hold' }, opts({ style: bar }), T0);
const tbl = r.next;
r = G.applyCommand(tbl, { action: 'live-off', layout: 'bar' }, opts({ style: bar }), T0 + 2000);
ok('TAKE OFF AIR under a graphic: the graphic stays on air', r.ok && r.next.scene === 'standings' && r.next.id === tbl.id && r.next.live.layout === null, r.next);
r = G.applyCommand(r.next, { action: 'stop', id: tbl.id }, opts({ style: bar }), T0 + 4000);
ok('…and when it goes, the score bar does not come back', r.ok && r.next.scene === null && G.liveLayout(r.next, bar, null) === null, r.next);
r = G.applyCommand(tbl, { action: 'live-on', layout: 'compact' }, opts({ style: bar }), T0 + 2000);
ok('TAKE ON AIR while a graphic is up: the graphic gives the screen back at once', r.ok && r.next.scene === null && r.next.endedId === tbl.id && r.next.live.layout === 'compact', r.next);

r = G.applyCommand(mCorner, { action: 'clean' }, opts({ style: bar }), T0 + 100);
const hid = r.next;
ok('HIDE EVERYTHING: nothing shows, the operator\'s choice is kept', hid.clean && G.liveLayout(hid, bar, null) === null && hid.live.layout === 'compact', hid);
ok('…a timer of a graphic that was on air cannot bring anything back', G.settle(hid, T0 + 999999, () => ++seq) === null);
r = G.applyCommand(hid, { action: 'live' }, opts({ style: bar }), T0 + 200);
ok('RESTORE LIVE OVERLAY: exactly the one taken before (the corner bug, manual)', r.ok && !r.next.clean && G.liveLayout(r.next, bar, null) === 'compact' && r.next.live.mode === 'manual', r.next);
r = G.applyCommand(hid, { action: 'live-on', layout: 'bar' }, opts({ style: bar }), T0 + 200);
ok('…or TAKE ON AIR from hidden: shows that one', r.ok && !r.next.clean && G.liveLayout(r.next, bar, null) === 'bar', r.next);
r = G.applyCommand(mOff, { action: 'live' }, opts({ style: corner }), T0 + 500);
ok('RESTORE with nothing taken: the tournament\'s layout comes back (it always shows something)', r.ok && r.next.live.mode === 'manual' && G.liveLayout(r.next, corner, null) === 'compact', r.next);
r = G.applyCommand(G.idle(), { action: 'live' }, opts({ style: bar }), T0);
ok('…already showing: nothing changes', r.ok && r.next === null);

r = G.applyCommand(G.idle(), { action: 'live-mode', mode: 'manual' }, opts({ style: corner }), T0);
ok('AUTOMATIC → MANUAL: what shows keeps showing (no flash)', r.ok && r.next.live.mode === 'manual' && r.next.live.layout === 'compact' && G.liveLayout(r.next, corner, null) === G.liveLayout(G.idle(), corner, null), r.next);
r = G.applyCommand(mOff, { action: 'live-mode', mode: 'auto' }, opts({ style: bar }), T0);
ok('MANUAL → AUTOMATIC: the tournament\'s layout again, and back after every graphic', r.ok && r.next.live.mode === 'auto' && G.liveLayout(r.next, bar, null) === 'bar', r.next);
r = G.applyCommand(mOff, { action: 'live-mode', mode: 'manual' }, opts({ style: bar }), T0);
ok('…the mode it is already in changes nothing', r.ok && r.same && r.next === null);
r = G.applyCommand(G.idle(), { action: 'live-mode', mode: 'sometimes' }, opts(), T0);
ok('…an unknown mode is refused', !r.ok && /Automatic or Manual/.test(r.error), r);
r = G.applyCommand(G.idle(), { action: 'live-on', layout: 'ticker' }, opts(), T0);
ok('…an unknown layout is refused', !r.ok && r.error === 'Unknown layout', r);
r = G.applyCommand(Object.assign({}, intro, { live: { mode: 'manual', layout: 'bar' } }), { action: 'stop', id: intro.id }, opts(), T0 + 100);
ok('the manual choice survives a graphic\'s stop, replace and expiry', r.next.live.layout === 'bar' && G.settle(Object.assign({}, intro, { live: { mode: 'manual', layout: 'bar' } }), intro.expiresAt, () => ++seq).live.layout === 'bar');

head('WHAT THE OUTPUTS SAY — ON AIR is read from them');
const NOW = 5000000;
const out = (o) => Object.assign({ outputId: 'o' + Math.random(), monitor: false, layoutParam: null, state: 'IDLE', graphicId: null, scene: null, layout: null, failed: null, at: NOW - 1000 }, o);
const onTbl = Object.assign({}, tbl, { expiresAt: null });
let n = G.readOutputs([out({ state: 'GRAPHIC_VISIBLE', graphicId: tbl.id, scene: 'standings' }), out({ monitor: true, state: 'GRAPHIC_VISIBLE', graphicId: tbl.id }), out({ state: 'GRAPHIC_VISIBLE', graphicId: tbl.id, at: NOW - 60000 })], onTbl, NOW);
ok('a studio monitor and an output not heard of for 45 s are not counted', n.o.length === 1 && n.up.length === 1, n);
let sum = G.airSummary(onTbl, bar, [], NOW, 'Points table');
ok('a graphic with no output connected: on air (the server\'s word) — and said that nothing shows it', sum.k === 'warn' && /is on air/.test(sum.t) && /No overlay output/.test(sum.d), sum);
sum = G.airSummary(onTbl, bar, [out({ state: 'OVERLAY_EXITING', layout: 'bar' })], NOW, 'Points table');
ok('…an output still taking the bar off: "Transition in progress", not ON AIR', sum.k === 'move' && /Transition/.test(sum.t), sum);
eq('…its card says Taking to air', G.sceneCard('standings', onTbl, [out({ state: 'GRAPHIC_ENTERING', graphicId: tbl.id, scene: 'standings' })], NOW).k, 'taking');
sum = G.airSummary(onTbl, bar, [out({ state: 'GRAPHIC_VISIBLE', graphicId: tbl.id, scene: 'standings' })], NOW, 'Points table');
ok('…ON AIR once an output has it up', sum.k === 'on' && sum.t === 'Points table is on air' && /held until dismissed/.test(sum.d), sum);
eq('…and its card says ● ON AIR', G.sceneCard('standings', onTbl, [out({ state: 'GRAPHIC_VISIBLE', graphicId: tbl.id, scene: 'standings' })], NOW).word, '● ON AIR');
const failedOut = out({ state: 'IDLE', failed: { id: tbl.id, error: 'No table for a knockout' } });
sum = G.airSummary(onTbl, bar, [failedOut], NOW, 'Points table');
ok('a graphic an output could not draw: "could not be shown", with the reason', sum.k === 'bad' && /could not be shown/.test(sum.t) && sum.d === 'No table for a knockout', sum);
eq('…its card says Failed to display', G.sceneCard('standings', onTbl, [failedOut], NOW), { k: 'failed', word: 'Failed to display', why: 'No table for a knockout' });
eq('the graphic being replaced says Leaving… while an output still has it', G.sceneCard('toss', onTbl, [out({ state: 'GRAPHIC_EXITING', graphicId: 'gold', scene: 'toss' })], NOW).k, 'exiting');
ok('…a graphic neither on air nor leaving has no on-air state', G.sceneCard('intro', onTbl, [out({ state: 'GRAPHIC_VISIBLE', graphicId: tbl.id, scene: 'standings' })], NOW) === null);
sum = G.airSummary(G.idle(), bar, [out({ state: 'OVERLAY_VISIBLE', layout: 'bar' })], NOW);
ok('the score bar up on an output: "Live score bar is on air · Automatic"', sum.k === 'live' && sum.t === 'Live score bar is on air' && /^Automatic/.test(sum.d), sum);
sum = G.airSummary(mOff, bar, [out({ state: 'IDLE' })], NOW);
ok('manual, nothing taken: "No graphic is on air"', sum.k === 'idle' && /off \(Manual\)/.test(sum.d), sum);
sum = G.airSummary(hid, bar, [out({ state: 'IDLE' })], NOW);
ok('hidden: "Everything is hidden"', sum.k === 'warn' && sum.t === 'Everything is hidden', sum);
let lc = G.liveCard('bar', G.idle(), bar, [out({ state: 'OVERLAY_VISIBLE', layout: 'bar' })], NOW);
ok('LIVE CARDS: the score bar up → ● ON AIR (chosen)', lc.k === 'on' && lc.chosen && lc.word === '● ON AIR', lc);
lc = G.liveCard('compact', G.idle(), bar, [out({ state: 'OVERLAY_VISIBLE', layout: 'bar' })], NOW);
ok('…the corner bug → OFF AIR (not chosen)', lc.k === 'off' && !lc.chosen && lc.word === 'OFF AIR', lc);
lc = G.liveCard('bar', onTbl, bar, [out({ state: 'GRAPHIC_VISIBLE', graphicId: tbl.id })], NOW, 'Points table');
ok('…under a graphic: STEPPED OFF · back after it', lc.k === 'off' && lc.chosen && lc.word === 'STEPPED OFF · back after Points table', lc);
lc = G.liveCard('compact', hid, bar, [], NOW);
ok('…hidden: HIDDEN', lc.word === 'HIDDEN · everything is hidden', lc);
lc = G.liveCard('compact', mCorner, bar, [out({ state: 'OVERLAY_ENTERING', layout: 'compact' })], NOW);
ok('…taken but not up yet: Coming to air (never ON AIR before the output says so)', lc.k === 'move' && lc.word === 'Coming to air…', lc);
lc = G.liveCard('compact', mCorner, bar, [], NOW);
ok('…taken with no output at all: ON AIR · no output (warned)', lc.k === 'on' && lc.warn && /no output/.test(lc.word), lc);

head('AN OUTPUT THAT NEVER SHOWS IT — said, never "Taking to air…" for ever');
const late = Object.assign({}, onTbl, { readyAt: NOW - 6000 });
const caught = (o) => out(Object.assign({ airSeq: late.seq }, o));
eq('a graphic every output has heard of, well past its entrance, that none has up: "Not showing"', G.sceneCard('standings', late, [caught({ state: 'OVERLAY_VISIBLE', layout: 'bar' })], NOW).word, 'Not showing');
ok('…and the line says so (not "Transition in progress")', G.airSummary(late, bar, [caught({ state: 'IDLE' })], NOW, 'Points table').k === 'bad' && /is not showing/.test(G.airSummary(late, bar, [caught({ state: 'IDLE' })], NOW, 'Points table').t));
eq('…an output that has not heard of it yet: still taking', G.sceneCard('standings', late, [out({ state: 'IDLE', airSeq: late.seq - 1 })], NOW).k, 'taking');
eq('…one still in a transition: still taking', G.sceneCard('standings', late, [caught({ state: 'OVERLAY_EXITING', layout: 'bar' })], NOW).k, 'taking');
eq('…inside its entrance: still taking', G.sceneCard('standings', Object.assign({}, late, { readyAt: NOW - 500 }), [caught({ state: 'IDLE' })], NOW).k, 'taking');
lc = G.liveCard('bar', G.idle(), bar, [out({ state: 'IDLE', airSeq: 0 })], NOW);
ok('a live layout every output has heard of and none shows: "Not showing" (not "Coming to air…")', lc.k === 'off' && lc.chosen && /^Not showing/.test(lc.word), lc);
lc = G.liveCard('bar', G.idle(), bar, [out({ state: 'IDLE', layoutParam: 'graphics', airSeq: 0 })], NOW);
ok('…every output graphics only: "On no output"', lc.k === 'off' && /graphics only/.test(lc.word), lc);
ok('…the line too', /on no output/.test(G.airSummary(G.idle(), bar, [out({ state: 'IDLE', layoutParam: 'graphics', airSeq: 0 })], NOW).t));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
