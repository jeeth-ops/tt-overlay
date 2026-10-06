// CONFIRM WICKET → the same data everywhere. A whole innings of dismissals
// is entered through the Wicket Details screen on BOTH panels, then the
// panel's own scorecard is compared with
//   • the server's rebuild of the same deliveries (what the tournament
//     pages and a reloaded scorecard read), and
//   • what the public scorecard page actually renders from the panel.
//
//   node test/cricket/wicket-e2e-test.js
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
function deep(){ return new Proxy(function(){}, { get: (t, k) => k === Symbol.toPrimitive ? (() => 0) : (k === 'then' ? undefined : deep()), apply: () => deep() }); }
function boot(file, url, extra){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const emits = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url, virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(ev, payload, ack){ emits.push({ ev, payload }); if(typeof ack === 'function') ack({ ok: true }); }, connected: true, disconnect(){}, io: { on(){} } });
      w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
      w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLMediaElement.prototype.pause = () => {};
      w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
      w.IntersectionObserver = w.IntersectionObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.ResizeObserver = w.ResizeObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.scrollTo = () => {};
      if(extra) extra(w);
    }
  });
  const w = dom.window;
  return { w, errors, emits, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s), J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)),
    text: (s) => { const el = w.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; } };
}
const click = (P, sel) => { const el = P.$(sel); if(!el) throw new Error('no element ' + sel); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const clickType = (P, t) => { const el = [...P.w.document.querySelectorAll('#wd-types [data-wd-type]')].find(b => b.dataset.wdType === t); if(!el) throw new Error('no out type ' + t); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };
const change = (P, sel, v) => { const el = P.$(sel); el.value = v; el.dispatchEvent(new P.w.Event('change', { bubbles: true })); };

const BOWLERS = [['Mukesh', 'm1'], ['Raj', 'r1']];
let overNo = 0;
// The over ended → the next bowler (as the operator would pick in the prompt).
function nextOverIfDue(P){
  if(P.$('#newover-modal-overlay').classList.contains('show')){
    overNo++;
    const [n, id] = BOWLERS[overNo % 2];
    P.E(`closeNewOverModal(); setLiveBowler(${JSON.stringify(n)}, ${JSON.stringify(id)}); renderPanel();`);
  }
}
function ball(P, k, meta){ P.E(`recordBall(${JSON.stringify(k)}${meta ? ', ' + JSON.stringify(meta) : ''})`); nextOverIfDue(P); }
// Every answer on the Wicket Details screen, then CONFIRM WICKET.
function out(P, o){
  P.E('openWicketModal()');
  clickType(P, o.type);
  if(o.delivery) click(P, `[data-wd-delivery="${o.delivery}"]`);
  if(o.wide){ P.$('#wd-wide-check').checked = true; P.$('#wd-wide-check').dispatchEvent(new P.w.Event('change', { bubbles: true })); }
  if(o.by) click(P, `[data-wd-stumpby="${o.by}"]`);
  if(o.who) click(P, `[data-wd-who="${o.who}"]`);
  if(o.fielder) P.E(`wdSetFielder(${JSON.stringify(o.fielder)}); renderWicketDetails();`);
  if(o.runs != null) click(P, `[data-wd-runs="${o.runs}"]`);
  if(!P.$('#wd-sec-newbat').hidden){
    const next = [...P.$('#wd-newbat-select').options].map(x => x.value).filter(Boolean)[0];
    change(P, '#wd-newbat-select', next);
  }
  if(!P.$('#wd-sec-strike').hidden) click(P, `[data-wd-strike="${P.E('wdPredictNewOnStrike()') ? 'new' : 'survivor'}"]`);
  const blocked = P.$('#wd-confirm').disabled ? P.text('#wd-preview') : '';
  click(P, '#wd-confirm');
  nextOverIfDue(P);
  return blocked;
}

// The server stores a delivery like this (socket 'logBall' in server.js).
function toDbDoc(api, d, i){
  const nm = x => api.personName(x);
  return {
    _id: new H.ObjectId(), matchId: 'E2E', ownerUid: 'u1', ballUid: d.ballUid || ('b' + i),
    innings: d.innings, over: d.over, ballInOver: d.ballInOver, kind: d.kind, runs: d.runs, battingTeam: d.battingTeam,
    striker: nm(d.striker), strikerKey: api.playerKey(nm(d.striker)), nonStriker: nm(d.nonStriker), nonStrikerKey: api.playerKey(nm(d.nonStriker)),
    bowler: nm(d.bowler), bowlerKey: api.playerKey(nm(d.bowler)),
    dismissal: d.dismissal ? { type: d.dismissal.type || 'Out', fielder: nm(d.dismissal.fielder), batter: nm(d.dismissal.batter) || null,
      batterId: d.dismissal.batterId ? String(d.dismissal.batterId) : null, fielderId: d.dismissal.fielderId ? String(d.dismissal.fielderId) : null,
      ...(d.dismissal.subtype ? { subtype: String(d.dismissal.subtype) } : {}) } : null,
    strikerId: d.strikerId || null, nonStrikerId: d.nonStrikerId || null, bowlerId: d.bowlerId || null,
    score: d.score, timestamp: d.timestamp || i
  };
}
const squash = s => String(s || '').replace(/[\s()]+/g, '');

async function suite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file, 'https://example.test/cricket-panel?room=E2E');
  await sleep(80);
  const L = (s) => `${label}: ${s}`;
  overNo = 0;
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A';
    document.getElementById('match-id').value = 'E2E';
    state.teamA.players = ['Rohit','Ishan','Surya','Tilak','Hardik','Tim','Krunal','Piyush','Jasprit','Akash','Arjun'].map((n, i) => ({ id: 'a' + (i + 1), name: n, isXI: true }));
    state.teamB.players = [{ id:'m1', name:'Mukesh', isXI:true }, { id:'r1', name:'Raj', isXI:true }, { id:'f1', name:'Jadeja', isXI:true }, { id:'k1', name:'Pant', isXI:true }];
    state.teamB.wkId = 'k1';
    state.striker    = { name:'Rohit', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan', id:'a2', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Mukesh', id:'m1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = []; pendingWicketDelivery = null;
    renderPanel();
  `);

  const blocked = [];
  const W = (o) => { const b = out(P, o); if(b) blocked.push(`${o.type}: ${b}`); };
  ball(P, '1'); ball(P, '4');
  W({ type: 'Hit Wicket' });                                          // striker
  ball(P, '2');
  W({ type: 'Caught', fielder: 'f1' });
  W({ type: 'Bowled', who: 'nonStriker' });                           // the non-striker was the one facing
  ball(P, '1'); ball(P, '0');
  W({ type: 'Run Out (Mankaded)' });                                  // by the bowler (default)
  ball(P, '6');
  W({ type: 'Run Out (Mankaded)', who: 'striker', by: 'keeper' });    // the striker was backing up; keeper ran him out
  W({ type: 'Stumped', wide: true });                                 // keeper, +1 wide
  ball(P, 'Wd', { extraRuns: 1 });
  W({ type: 'Run Out', delivery: 'noball', who: 'nonStriker', runs: 1, fielder: 'f1' });
  ball(P, 'Nb', { runsOffBat: 4 }); ball(P, 'B', { runs: 2 }); ball(P, 'LB', { runs: 1 });
  W({ type: 'Caught & Bowled' });
  W({ type: 'Caught Behind' });
  ball(P, '3');
  W({ type: 'LBW', who: 'nonStriker' });
  eq(L('every wicket could be confirmed'), blocked, []);
  eq(L('10 wickets on the panel — all out'), P.J('[state.score.wickets, isAllOut()]'), [10, true]);

  const rec = P.J('buildMatchRecordForLeague()');
  const deliveries = P.emits.filter(e => e.ev === 'logBall').map(e => e.payload);
  const api = H.build({ balls: H.coll([]), clips: H.coll([]), records: H.coll([]), rooms: {}, emits: [], audits: [] },
    ['personName', 'playerKey', 'deriveBallFacts', 'isSuperOverBall', 'buildLiveCardsFromBallsArray'], []);
  const cards = api.buildLiveCardsFromBallsArray(deliveries.map((d, i) => toDbDoc(api, d, i)));

  const notOut = s => (!s || /^not out$/i.test(s)) ? 'not out' : s;
  const panelBat = (rec.battingCard.A || []).map(b => [b.name, b.runs, b.balls, notOut(b.out ? b.howOut : '')]);
  const serverBat = (cards.battingCard.A || []).map(b => [b.name, b.runs, b.balls, notOut(b.out ? b.howOut : '')]);
  const byName = rows => rows.slice().sort((a, b) => a[0].localeCompare(b[0]));
  eq(L('batting: panel = server (runs, balls, how out — every batter)'), byName(serverBat), byName(panelBat));
  const how = Object.fromEntries(panelBat.map(r => [r[0], r[3]]));
  eq(L('the dismissals read right'), ['Rohit','Ishan','Surya','Tilak','Hardik','Tim','Krunal','Piyush','Jasprit','Arjun','Akash'].map(n => how[n]),
    ['b Mukesh', 'hit wkt b Mukesh', 'c Jadeja b Mukesh', 'run out (Raj) — mankaded', 'run out (Pant) — mankaded', 'st Pant b Raj (Wd)', 'c & b Raj', 'run out (Jadeja) (Nb)', 'c †Pant b Mukesh', 'lbw b Mukesh', 'not out']);
  eq(L('the 10 dismissed are the 10 the scorer chose'), panelBat.filter(r => r[3] !== 'not out').length, 10);

  const live = P.J('state.bowler');
  const panelBowl = (rec.bowlingCard.B || []).concat(live && live.name && !(rec.bowlingCard.B || []).some(b => b.name === live.name) ? [live] : [])
    .map(b => [b.name, (b.overs || 0) * 6 + (b.balls || 0), b.runs, b.wickets, b.dots, b.noBalls, b.wides]);
  const serverBowl = (cards.bowlingCard.B || []).map(b => [b.name, (b.overs || 0) * 6 + (b.balls || 0), b.runs, b.wickets, b.dots, b.noBalls, b.wides]);
  eq(L('bowling: panel = server (balls, runs, wickets, 0s, NB, WD)'), byName(serverBowl), byName(panelBowl));
  eq(L('team total: panel = server'), [cards.scoreA.runs, cards.scoreA.wickets, cards.scoreA.overs], [P.E('state.score.runs'), P.E('state.score.wickets'), P.E('fmtOvers(state.score.overs, state.score.balls)')]);
  eq(L('Mankads are not the bowler’s wickets, never a ball faced'), [deliveries.filter(d => d.kind === 'OUT').length, deliveries.filter(d => d.kind === 'OUT').every(d => !d.bowler)], [2, true]);
  const mk2 = deliveries.filter(d => d.kind === 'OUT')[1];
  eq(L('Mankad of the batter shown on strike: stored as the non-striker, run out by the keeper'), [mk2.dismissal.batter, mk2.nonStriker, mk2.dismissal.fielder], [P.J(`state.ballLog.filter(b => b.ballType === 'OUT')[1].dismissedName || state.ballLog.filter(b => b.ballType === 'OUT')[1].dismissedPlayerName || ''`) || mk2.dismissal.batter, mk2.dismissal.batter, 'Pant']);

  // The public scorecard page, fed exactly what the panel broadcasts.
  const S = boot('cricket-scorecard.html', 'https://example.test/cricket-scorecard.html?room=E2E', w => { w.firebase = deep(); });
  await sleep(80);
  S.E(`latestState = ${JSON.stringify(P.J('state'))}; render();`);
  const rows = [...S.w.document.querySelectorAll('#batting-table-body tr')].map(tr => {
    const td = tr.querySelector('td'); const ho = td.querySelector('.howout'); const no = td.querySelector('.not-out-tag');
    return [td.childNodes[0].textContent.trim(), Number(tr.children[1].textContent), Number(tr.children[2].textContent), squash(ho ? ho.textContent : no ? 'not out' : '')];
  });
  const panelLive = panelBat.map(r => [r[0], r[1], r[2], squash(r[3])]);
  eq(L('scorecard page shows the panel’s batting card'), byName(rows), byName(panelLive));
  const brows = [...S.w.document.querySelectorAll('#bowling-table-body tr')].map(tr => [tr.children[0].textContent.trim(), tr.children[3].textContent.trim(), tr.children[4].textContent.trim()]);
  eq(L('scorecard page shows the panel’s bowling figures'), byName(brows), byName(panelBowl.map(b => [b[0], String(b[2]), String(b[3])])));
  eq(L('no script errors'), P.errors.concat(S.errors).filter(e => !/Could not parse CSS|Not implemented/.test(e)), []);
}

(async () => {
  await suite('cricket-panel.html', 'Clipper panel');
  await suite('cricket-panel3.html', 'Stream Engine panel');
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
