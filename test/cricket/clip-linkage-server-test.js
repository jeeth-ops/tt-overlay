/* The website side of clip attribution: the REAL computeClipLinkage /
   findCanonicalBall / clipBatterKey out of server.js (extracted by name,
   never a copy), run against an in-memory ball log, so we see exactly
   which player a clip ends up credited to once it reaches MongoDB.

     node test/cricket/clip-linkage-server-test.js
*/
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

function grab(name, prefix){
  const start = src.indexOf((prefix || 'function ') + name);
  if(start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for(let j = i; j < src.length; j++){
    if(src[j] === '{') depth++;
    else if(src[j] === '}'){ depth--; if(depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}

// A tiny stand-in for the Mongo collection: find(query).sort().limit().toArray() and findOne(query).
function fakeCollection(docs){
  const match = (d, q) => Object.keys(q).every(k => d[k] === q[k]);
  return {
    findOne: async (q) => docs.find(d => match(d, q)) || null,
    find: (q) => {
      let rows = docs.filter(d => match(d, q));
      const cur = {
        sort: (s) => { const k = Object.keys(s)[0]; rows = rows.slice().sort((a, b) => (a[k] - b[k]) * s[k]); return cur; },
        limit: (n) => { rows = rows.slice(0, n); return cur; },
        toArray: async () => rows,
        next: async () => rows[0] || null,
      };
      return cur;
    }
  };
}

function build(balls){
  const code = [
    grab('personName'), grab('playerKey'),
    grab('findCanonicalBall', 'async function '),
    grab('computeClipLinkage', 'async function '),
    grab('clipBatterKey'),
    'return { computeClipLinkage, findCanonicalBall, clipBatterKey };'
  ].join('\n');
  const deps = {
    ballsCollection: fakeCollection(balls),
    ClipAttribution: require('../../clip-attribution.js'),
    resolveOwnerUidForMatch: async () => null,       // no owner → ids pass through as sent
    resolvePlayerIdExplicit: async (o, id) => id || null,
    resolvePlayerId: async () => null,
  };
  return new Function(...Object.keys(deps), code)(...Object.values(deps));
}

const key = n => n ? String(n).toLowerCase().replace(/\s+/g, ' ').trim() : null;
const row = (o) => Object.assign({
  matchId: 'M', innings: 1, battingTeam: 'A', runs: 0, kind: '0',
  striker: 'Player A', strikerKey: key('Player A'), strikerId: 'pA',
  nonStriker: 'Player B', nonStrikerKey: key('Player B'), nonStrikerId: 'pB',
  bowler: 'Bowler One', bowlerKey: key('Bowler One'), bowlerId: 'b1',
  dismissal: null, timestamp: 1
}, o);

(async () => {
  console.log('\n=== 12.6 run out of the NON-striker: clip belongs to B ===');
  {
    const balls = [row({ ballUid: 'd126', over: 12, ballInOver: 6, kind: 'W', dismissal: { type: 'Run Out', batter: 'Player B', batterId: 'pB' }, dismissedPlayerKey: key('Player B'), dismissedPlayerId: 'pB', timestamp: 10 })];
    const api = build(balls);
    const link = await api.computeClipLinkage('M', { deliveryId: 'd126', innings: 1, over: 12, ballInOver: 6, striker: 'Player A', strikerId: 'pA' }, null, 'WICKET');
    eq('linked to the canonical delivery', link.linkedToCanonicalBall, true);
    eq('dismissed player = B', [link.dismissedPlayerName, link.dismissedPlayerKey, link.dismissedPlayerId], ['Player B', key('Player B'), 'pB']);
    eq('striker of the delivery stays A, bowler b1', [link.strikerName, link.bowlerName], ['Player A', 'Bowler One']);
    eq('clip owner (batting side) = B', api.clipBatterKey({ eventType: 'WICKET', ...link }), key('Player B'));
    eq('deliveryId recorded', link.deliveryId, 'd126');
  }

  console.log('\n=== 12.6 run out of the STRIKER: clip belongs to A ===');
  {
    const balls = [row({ ballUid: 'd126', over: 12, ballInOver: 6, kind: 'W', dismissal: { type: 'Run Out', batter: 'Player A', batterId: 'pA' }, dismissedPlayerKey: key('Player A'), timestamp: 10 }),
      // the next over has begun: B now on strike, new bowler, new batter C
      row({ ballUid: 'd131', over: 13, ballInOver: 1, striker: 'Player B', strikerKey: key('Player B'), strikerId: 'pB', nonStriker: 'Player C', nonStrikerKey: key('Player C'), bowler: 'Bowler Two', bowlerKey: key('Bowler Two'), timestamp: 20 })];
    const api = build(balls);
    const link = await api.computeClipLinkage('M', { deliveryId: 'd126', innings: 1, over: 12, ballInOver: 6, striker: 'Player A' }, null, 'WICKET');
    eq('dismissed A, bowler b1 — not the next over\'s B / Bowler Two', [link.dismissedPlayerName, link.bowlerName, link.over, link.ballInOver], ['Player A', 'Bowler One', 12, 6]);
  }

  console.log('\n=== Wide after a wicket shares 12.5 — the wicket clip must NOT take the new batter ===');
  {
    const balls = [
      row({ over: 12, ballInOver: 5, kind: 'W', dismissal: { type: 'Bowled', batter: 'Player A' }, timestamp: 10 }),
      row({ over: 12, ballInOver: 5, kind: 'Wd', runs: 1, striker: 'Player C', strikerKey: key('Player C'), strikerId: 'pC', timestamp: 20 }),
    ];
    const api = build(balls);
    // an older clip with no deliveryId — only over/ball + its own striker
    const link = await api.computeClipLinkage('M', { innings: 1, over: 12, ballInOver: 5, striker: 'Player A', strikerId: 'pA' }, null, 'WICKET');
    eq('linked to the wicket ball, not the newer Wide', [link.strikerName, link.dismissalType, link.dismissedPlayerName], ['Player A', 'Bowled', 'Player A']);
  }

  console.log('\n=== no matching ball yet (offline): the clip keeps its own frozen identity ===');
  {
    const api = build([row({ ballUid: 'other', over: 12, ballInOver: 6, striker: 'Player B', strikerKey: key('Player B'), strikerId: 'pB', timestamp: 5 })]);
    const link = await api.computeClipLinkage('M', {
      deliveryId: 'd126', innings: 1, over: 12, ballInOver: 6, striker: 'Player A', strikerId: 'pA', bowler: 'Bowler One', bowlerId: 'b1',
      dismissal: { type: 'Run Out', batter: 'Player B', batterId: 'pB' }, dismissedPlayer: 'Player B', dismissedPlayerId: 'pB'
    }, null, 'WICKET');
    eq('not linked to a different delivery at the same over.ball', link.linkedToCanonicalBall, false);
    eq('identity from the clip itself', [link.strikerName, link.dismissedPlayerName, link.dismissedPlayerId, link.bowlerName], ['Player A', 'Player B', 'pB', 'Bowler One']);
  }

  console.log('\n=== legacy rows (no dismissal.batter) ===');
  {
    const api = build([row({ over: 3, ballInOver: 2, kind: 'W', dismissal: { type: 'Caught', fielder: 'Fielder X' }, timestamp: 1 })]);
    const link = await api.computeClipLinkage('M', { innings: 1, over: 3, ballInOver: 2 }, null, 'WICKET');
    eq('non-run-out → the striker', link.dismissedPlayerName, 'Player A');
    eq('legacy wicket clip doc with no dismissedPlayerKey → striker', api.clipBatterKey({ eventType: 'WICKET', strikerKey: key('Player A') }), key('Player A'));
  }

  console.log('\n=== FOUR / SIX ownership is the striker ===');
  {
    const api = build([row({ ballUid: 'd6', over: 12, ballInOver: 6, kind: '6', runs: 6, timestamp: 1 })]);
    const link = await api.computeClipLinkage('M', { deliveryId: 'd6', over: 12, ballInOver: 6, innings: 1 }, null, 'SIX');
    eq('SIX → A, no dismissed player', [link.strikerName, link.dismissedPlayerName], ['Player A', null]);
    eq('owner key', api.clipBatterKey({ eventType: 'SIX', ...link }), key('Player A'));
  }

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})();
