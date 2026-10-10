// 🎯 Full Commentary: a wagon wheel for every over (the REAL
// cricket-scorecard.html in jsdom) — which matches get them (the MCA President
// Cup 2026, and every match from 10 Oct 2026 on — never an older one), what a
// wheel shows (each shot, where it went, off / leg), the over's ball-by-ball
// pips, the Fours / Sixes innings wheel, a finished match keeping its shots,
// and the page updating only what a new ball changed. Plus the server sending
// each ball's time.
//
//   node test/cricket/commentary-wagon-wheel-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const H = require('./server-harness.js');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function boot(){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', 'cricket-scorecard.html'), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://example.test/cricket-scorecard?room=M1', virtualConsole: vc,
    beforeParse(w){
      w.firebase = { initializeApp(){}, auth: () => ({ currentUser: null, onAuthStateChanged(cb){ setTimeout(() => cb(null), 30); }, signInWithPopup(){}, signOut(){} }), firestore: () => ({}) };
      w.firebase.auth.GoogleAuthProvider = function(){};
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){}, removeAllListeners(){} });
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      w.IntersectionObserver = w.IntersectionObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.ResizeObserver = w.ResizeObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.HTMLMediaElement.prototype.load = () => {};
      w.HTMLMediaElement.prototype.pause = () => {};
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.confirm = () => true; w.alert = () => {};
      w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  const w = dom.window;
  return { w, errors, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)],
    J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)) };
}

// ---- a match, ball by ball, in the live ballLog shape ----
const NEW = Date.parse('2026-10-11T10:00:00+05:30');   // after the cutoff
const OLD = Date.parse('2026-10-05T10:00:00+05:30');   // before it
const R = (zone, depth, x, y) => ({ zone, depth, hand: 'R', x, y });
function overs(t0){
  let t = t0;
  const b = (over, ballType, runs, o) => Object.assign({ innings: 1, battingTeam: 'A', over, ballType, runs, striker: 'Rohit', nonStriker: 'Ishan', bowler: 'Deepak', isWicket: false, timestamp: (t += 30000) }, o);
  return [
    // over 1: a single to cover, a dot, a four to deep mid-wicket, a six to long-on (only its region
    // was stored), a two nobody marked, bowled
    b('0.1', '1', 1, { shot: R('cover', 'inner', -0.3, 0.2) }), b('0.2', '0', 0), b('0.3', '4', 4, { shot: R('midwicket', 'deep', 0.7, 0.71) }),
    b('0.4', '6', 6, { shot: { zone: 'midon', depth: 'deep', hand: 'R' } }), b('0.5', '2', 2), b('0.6', 'W', 0, { isWicket: true, dismissal: 'bowled', dismissalType: 'Bowled', dismissedPlayer: 'Rohit' }),
    // over 2: a maiden
    ...[1, 2, 3, 4, 5, 6].map(i => b('1.' + i, '0', 0, { striker: 'Surya', bowler: 'Arshdeep' })),
    // over 3: a leg bye (marked) and five dots — runs, but none off the bat
    b('2.1', 'LB', 1, { striker: 'Surya', shot: R('fineleg', 'inner', 0.1, -0.3) }), ...[2, 3, 4, 5, 6].map(i => b('2.' + i, '0', 0, { striker: 'Surya' })),
    // over 4: a two nobody marked, five dots
    b('3.1', '2', 2, { striker: 'Surya', bowler: 'Arshdeep' }), ...[2, 3, 4, 5, 6].map(i => b('3.' + i, '0', 0, { striker: 'Surya', bowler: 'Arshdeep' })),
    // over 5 (being bowled): a right-hander's single to point, a left-hander's two to fine leg
    b('4.1', '1', 1, { striker: 'Surya', shot: R('point', 'inner', -0.4, -0.2) }),
    b('4.2', '2', 2, { striker: 'Tilak', shot: { zone: 'fineleg', depth: 'deep', hand: 'L' } })
  ];
}
function state(o){
  return Object.assign({ ballLog: overs(o.t0), inningsNumber: 1, isFinished: false, status: 'live', leagueName: 'ABC PREMIER LEAGUE',
    teamA: { name: 'Mumbai', short: 'MI' }, teamB: { name: 'Chennai', short: 'CSK' }, score: { runs: 20, wickets: 1, overs: 4, balls: 2 } }, o.s || {});
}

(async () => {
  const P = boot();
  await sleep(200);
  const show = (st) => { P.E(`latestState = ${JSON.stringify(st)}; commentaryPageOpen = true; renderCommentaryPage(latestState);`); };
  const on = () => P.$('#commentary-page').classList.contains('ow-on');
  const blockOf = (title) => P.$$('.cm3-block').find(b => (b.querySelector('.cm-eoo-title, .cp-ov-title') || {}).textContent === title);
  const chips = (blk) => [...blk.querySelectorAll('.ow-chip')].map(c => c.textContent.trim().replace(/\s+/g, ' '));

  console.log('\n=== Which matches get wagon wheels ===');
  show(state({ t0: NEW }));
  eq('a match started after 10 Oct 2026 (any tournament): a wheel for every over', [on(), P.$$('.cm3-block').length], [true, 5]);
  show(state({ t0: OLD }));
  eq('an older match of another tournament: none — the page exactly as before', [on(), P.$$('.cm3-block').length, P.$$('.cm3-wheel').length], [false, 0, 0]);
  eq('… still over by over: innings head, new bowler, the over\'s head, then its balls', [...P.$('#commentary-page-body').children].slice(0, 4).map(e => e.className.split(' ')[0]), ['cm2-innings-head', 'cm2-new-bowl', 'cm2-over-head', 'cm2-row']);
  show(state({ t0: OLD, s: { leagueName: 'MCA PRESIDENT CUP 2026 - 27 (A & B DIVISION )' } }));
  eq('the MCA President Cup 2026: every match, its first (older) one too', on(), true);
  show(state({ t0: OLD, s: { leagueName: '', matchLeague: 'MCA President\'s Cup 2026-27' } }));
  eq('… however its name is written (the live match\'s own tournament)', on(), true);
  const noShots = state({ t0: NEW }); noShots.ballLog.forEach(b => delete b.shot);
  show(noShots);
  eq('a new match scored with the wagon wheel off: nothing to draw, no wheels', on(), false);
  // a finished match: its tournament comes from the saved record
  P.E(`latestState = null; finalTournamentName = 'MCA PRESIDENT CUP 2026 - 27 (A & B DIVISION )';
       finalCommentaryState = { ballLog: ${JSON.stringify(overs(OLD))}, inningsNumber: 1, isFinished: true };
       renderCommentaryPage(commentaryState());`);
  eq('a finished MCA President Cup match: wheels', on(), true);
  P.E(`finalTournamentName = 'OLD CUP 2025'; renderCommentaryPage(commentaryState());`);
  eq('a finished older match of another tournament: none', on(), false);
  P.E(`finalTournamentName = ''; finalCommentaryState = null;`);

  console.log('\n=== What an over\'s wheel shows ===');
  show(state({ t0: NEW }));
  const o1 = blockOf('END OF OVER 1');
  eq('a chip per marked shot, oldest first: runs + where (the unmarked 2 is not guessed)', chips(o1), ['1Cover', '4Deep mid-wicket', '6Long-on']);
  eq('a single, a four and a six: white, blue and purple lines', ['s1', 's4', 's6'].map(k => o1.querySelectorAll('.ow-line.ow-' + k).length), [1, 1, 1]);
  eq('the six flies (a curve); the four runs along the ground', [/Q/.test(o1.querySelector('.ow-line.ow-s6').getAttribute('d')), /Q/.test(o1.querySelector('.ow-line.ow-s4').getAttribute('d'))], [true, false]);
  const ends = [...o1.querySelectorAll('.ow-end')].map(g => g.getAttribute('transform').match(/-?[\d.]+/g).map(Number));
  eq('a four ends on the rope (radius 100)', Math.round(Math.hypot(...ends[1])), 100);
  eq('a six with only its region stored: the middle of long-on, on the rope', ends[2], [38.3, 92.4]);
  eq('runs off / leg side (cover = off; mid-wicket and long-on = leg)', [...o1.querySelectorAll('.ow-sides b')].map(b => b.textContent), ['1', '10']);
  eq('every shot by right-handers: OFF on the left, LEG on the right', [...o1.querySelectorAll('.ow-side')].map(t => t.textContent + '@' + t.getAttribute('x')), ['OFF@-110', 'LEG@110']);
  eq('a screen reader hears it too', o1.querySelector('.ow-svg').getAttribute('aria-label'), 'Over 1 wagon wheel: 1 to cover, 4 to deep mid-wicket, 6 to long-on');
  eq('a maiden: an empty field that says so', [blockOf('END OF OVER 2').classList.contains('ow-none'), blockOf('END OF OVER 2').querySelector('.ow-pilltx').textContent], [true, 'Maiden over']);
  eq('only a leg bye: no runs off the bat', blockOf('END OF OVER 3').querySelector('.ow-pilltx').textContent, 'No runs off the bat');
  eq('a two nobody marked: says so, never guesses', blockOf('END OF OVER 4').querySelector('.ow-pilltx').textContent, 'Shots not marked');
  const live = blockOf('Over 5 (in progress)');
  eq('the over being bowled: its own wheel, as a strip (is-live)', [live.classList.contains('is-live'), chips(live)], [true, ['1Point', '2Fine leg']]);
  const lefty = [...live.querySelectorAll('.ow-end')].map(g => Number(g.getAttribute('transform').match(/-?[\d.]+/)[0]));
  eq('a left-hander\'s fine leg is on the other side of the field', [lefty[0] < 0, lefty[1] < 0], [true, true]);
  eq('right- and left-handers in one over: no OFF / LEG labels', live.querySelectorAll('.ow-side').length, 0);
  eq('the newest shot of a live match draws itself in (only that one)', [...P.$$('.ow-line.ow-fresh')].map(p => p.getAttribute('data-ball')), ['4.2']);
  eq('each row, chip and line knows its ball (laptop: point at one, it lights up)', [!!live.querySelector('.cm2-row[data-ball="4.1"]'), !!live.querySelector('.ow-chip[data-ball="4.1"]'), !!live.querySelector('.ow-line[data-ball="4.1"]')], [true, true, true]);
  eq('the wheel sits between the over\'s card and its balls', [...o1.children].map(e => e.className.split(' ')[0]), ['cm2-new-bowl', 'cm-eoo', 'cm3-wheel', 'cm3-rows']);

  console.log('\n=== The over card ===');
  eq('END OF OVER: the over ball by ball (oldest first) and the run rate after it', [[...o1.querySelectorAll('.cm-pip')].map(p => p.textContent), o1.querySelector('.cm-eoo-crr').textContent],
    [['1', '0', '4', '6', '2', 'W'], '· CRR 13.00']);
  eq('the over being bowled: its balls so far', [...live.querySelectorAll('.cm-pip')].map(p => p.textContent), ['1', '2']);
  eq('the small Commentary card keeps its plain over card', P.$('#commentary-feed .cm-eoo') ? P.$('#commentary-feed .cm-eoo .cm-pip') : null, null);

  console.log('\n=== Fours / Sixes filter ===');
  P.E(`commentaryTypeFilter = 'fours'; renderCommentaryPage(latestState);`);
  eq('one wheel for the innings: every four, counted by place', [P.$$('.cm3-block').length, P.$('.cm3-block .ow-kick b').textContent, chips(P.$('.cm3-block'))], [1, 'All fours', ['1×Deep mid-wicket']]);
  P.E(`commentaryTypeFilter = 'wickets'; renderCommentaryPage(latestState);`);
  eq('wickets have no direction: no wheel, and the page keeps its usual width', [P.$$('.cm3-block').length, on()], [0, false]);
  P.E(`commentaryTypeFilter = 'all';`);

  console.log('\n=== A new ball only rebuilds what it changed ===');
  show(state({ t0: NEW }));
  const before = [...P.$('#commentary-page-body').children];
  P.E(`renderCommentaryPage(latestState);`);
  const same = [...P.$('#commentary-page-body').children];
  eq('nothing changed: every element stays the same element', same.length === before.length && same.every((e, i) => e === before[i]), true);
  P.E(`latestState.ballLog.push(Object.assign({}, latestState.ballLog[latestState.ballLog.length - 1], { over: '4.3', ballType: '4', runs: 4, timestamp: Date.now(),
       shot: { zone: 'cover', depth: 'deep', hand: 'R', x: -0.8, y: 0.6 } })); renderCommentaryPage(latestState);`);
  const after = [...P.$('#commentary-page-body').children];
  eq('a new ball: only the over being bowled is rebuilt (with the new four on its wheel)',
    [after.length, after[1] !== before[1], after.slice(2).every((e, i) => e === before[i + 2]), chips(after[1])], [before.length, true, true, ['1Point', '2Fine leg', '4Deep cover']]);
  // a shot marked a few seconds after its ball still reaches the page
  const k1 = P.E(`commentaryPageKey(latestState)`);
  P.E(`delete latestState.ballLog[latestState.ballLog.length - 1].shot;`);
  const k0 = P.E(`commentaryPageKey(latestState)`);
  eq('a shot marked after its ball changes what the page is keyed on', k0 !== k1, true);

  console.log('\n=== WATCH REPLAY ===');
  P.E(`window.__opened = []; openVideoModal = (id) => window.__opened.push(id);
       commentaryClipMap = { '1.0.3': { clipId: 'c-four', ready: true, playbackUrl: '/v.mp4', posterUrl: '' } };
       renderCommentaryPage(latestState);`);
  P.$('.cm-replay-btn[data-clip-id="c-four"]').click();
  P.E(`renderCommentaryPage(latestState); renderCommentaryPage(latestState);`);
  P.$('.cm-replay-btn[data-clip-id="c-four"]').click();
  eq('one tap = the clip opens once, however many times the page was redrawn', P.J('window.__opened'), ['c-four', 'c-four']);

  console.log('\n=== A finished match keeps its shots ===');
  const entry = P.J(`publicBallToLogEntry({ innings: 1, over: 3, ballInOver: 2, ballType: 'NB', runs: 5, striker: 'A', bowler: 'B', battingTeam: 'A', isWicket: false,
    boundary: true, nbRunsAs: 'bat', shot: { zone: 'cover', depth: 'deep', hand: 'R', x: -0.7, y: 0.7 }, timestamp: 1791777600000 })`);
  eq('the public ball keeps where it went, when, and the no-ball detail', [entry.shot.zone, entry.timestamp, entry.boundary, entry.nbRunsAs, entry.over], ['cover', 1791777600000, true, 'bat', 3.2]);
  eq('… so its line reads as it did live', P.E(`commentaryLine(${JSON.stringify({ ballType: '4', runs: 4, striker: 'A', bowler: 'B', shot: { zone: 'cover', depth: 'deep' } })}).text`), 'FOUR! A finds the boundary through the covers off B');
  const mapBall = new Function(H.grabConst('SHOT_ZONES') + H.grab('sanitizeShot') + H.grab('normalizeKindForPublic') + H.grab('mapBallForPublic') + '; return mapBallForPublic;')();
  eq('SERVER: the public ball log carries when each ball was bowled', mapBall({ innings: 1, over: 0, ballInOver: 1, kind: '4', runs: 4, timestamp: 1791777600000 }).timestamp, 1791777600000);
  eq('SERVER: … and nothing when it was never stored', 'timestamp' in mapBall({ innings: 1, over: 0, ballInOver: 1, kind: '4', runs: 4 }), false);

  eq('no script errors', P.errors, []);
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
