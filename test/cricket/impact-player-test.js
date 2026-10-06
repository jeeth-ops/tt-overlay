// 🔁 IMPACT PLAYER — one substitute per team, every rule checked before the
// operator can confirm, on BOTH panels:
//   • only at the start of an innings, the end of an over, the fall of a
//     wicket or when a batter retires (never mid-over, never in a Super Over)
//   • one per team; up to 5 named substitutes; not-out batters can't go off;
//     mid-over the current bowler can't go off
//   • the replaced player can't bat, bowl or field again; the Impact Player can
//   • only 11 may bat once a side has used its Impact Player
//   • Undo reverses the substitution (even before the first ball)
//   • the saved match record carries impactPlayers; the overlay gets an
//     IMPACT_PLAYER event
//
//   node test/cricket/impact-player-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function boot(file){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const emits = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=IP', virtualConsole: vc,
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
    }
  });
  const w = dom.window;
  return { w, errors, emits, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)], J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)),
    text: (s) => { const el = w.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; } };
}
const click = (P, sel) => { const el = typeof sel === 'string' ? P.$(sel) : sel; if(!el) throw new Error('no element ' + sel); el.dispatchEvent(new P.w.Event('click', { bubbles: true })); };

const BAT = ['Rohit','Ishan','Surya','Tilak','Hardik','Tim','Krunal','Piyush','Jasprit','Akash','Arjun'];
const BOWL = [['Raj','r1'],['Mukesh','m1'],['Aman','a9'],['Kabir','k2'],['Dev','d3'],['Om','o4'],['Sam','s5'],['Karan','c6'],['Rahul','h7'],['Pant','k1'],['Jadeja','j8']];
function setup(P, enabled){
  P.E(`
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A';
    state.impactPlayerEnabled = ${!!enabled};
    document.getElementById('match-id').value = 'IP';
    state.teamA.players = ${JSON.stringify(BAT)}.map((n, i) => ({ id: 'a' + i, name: n, isXI: true }))
      .concat([{ id: 'ipa', name: 'Impact Bat', isXI: false, impactSub: true }, { id: 'ipa2', name: 'Spare Bat', isXI: false, impactSub: true }, { id: 'bench', name: 'Bench Guy', isXI: false }]);
    state.teamB.players = ${JSON.stringify(BOWL)}.map(([n, id]) => ({ id, name: n, isXI: true }))
      .concat([{ id: 'ipb', name: 'Impact Bowl', isXI: false, impactSub: true }]);
    state.striker    = { name:'Rohit', id:'a0', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Raj', id:'r1', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = [];
    window.__toasts = [];
    if(!window.__toastHooked){ const _t = toast; toast = function(m){ window.__toasts.push(String(m)); return _t.apply(this, arguments); }; window.__toastHooked = true; }
    renderPanel(); renderSquadUI();
  `);
  P.emits.length = 0;
}
const names = (P, expr) => P.J(`(${expr}).map(p => p.name)`);
const lastToast = (P) => P.J('window.__toasts.slice(-1)[0] || ""');
const outBtn = (P, name) => P.$$('#ip-body [data-ip-out]').find(b => b.textContent.includes(name));
const inBtn = (P, name) => P.$$('#ip-body [data-ip-in]').find(b => b.textContent.includes(name));
function pick(P, team, outName, inName){
  click(P, '#lc-impact-btn');
  click(P, `#ip-teams [data-ip-team="${team}"]`);
  if(outName){ const b = outBtn(P, outName); if(b) click(P, b); }
  if(inName){ const b = inBtn(P, inName); if(b) click(P, b); }
}
function nextOver(P, name, id){ P.E(`closeNewOverModal(); setLiveBowler(${JSON.stringify(name)}, ${JSON.stringify(id)}); renderPanel();`); }

async function suite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file);
  await sleep(80);
  const L = s => `${label}: ${s}`;

  eq(L('the 🔁 Impact Player button is on the live console'), !!P.$('#lc-impact-btn'), true);
  eq(L('Match Setup has the Impact Player rule switch'), !!P.$('#ms-impact'), true);

  // ---- rule off ----
  setup(P, false);
  click(P, '#lc-impact-btn');
  eq(L('TEST 1: rule off — the modal says so and Confirm stays disabled'), [P.$('#ip-overlay').classList.contains('show'), /rule is off/.test(P.text('#ip-when')), P.$('#ip-confirm').disabled], [true, true, true]);
  eq(L('TEST 1b: rule off — the ⬆ IP squad buttons are hidden for ordinary players'), P.$$('#squadA-list .squad-ip').filter(b => !b.hidden).map(b => b.closest('.squad-player-row').dataset.id), ['ipa', 'ipa2']);
  click(P, '#ip-body [data-ip-enable]');
  eq(L('TEST 2: "Turn the rule on" in the modal switches it on (and the Match Setup switch follows)'), [P.J('state.impactPlayerEnabled'), P.$('#ms-impact').checked], [true, true]);
  P.E(`closeImpactModal()`);

  // ---- squad roles ----
  setup(P, true);
  eq(L('TEST 3: named substitutes are NOT selectable to bat, bowl or field before they come on'),
    [names(P, `eligibleBatters('A')`).includes('Impact Bat'), names(P, `eligibleBowlersForNext('B')`).includes('Impact Bowl')],
    [false, false]);
  const ipRow = (id) => P.$(`#squadA-list .squad-player-row[data-id="${id}"] .squad-ip`);
  click(P, ipRow('bench'));
  eq(L('TEST 4: ⬆ IP on a squad row makes that player an impact substitute (and takes him out of the XI)'), P.J(`state.teamA.players.find(p => p.id === 'bench')`).impactSub && P.J(`state.teamA.players.find(p => p.id === 'bench')`).isXI === false, true);
  P.E(`state.teamA.players.find(p => p.id === 'a10').impactSub = true; state.teamA.players.find(p => p.id === 'a9').impactSub = true; renderSquadUI();`);
  const before = P.J(`state.teamA.players.filter(p => p.impactSub).length`);
  click(P, `#squadA-list .squad-player-row[data-id="a8"] .squad-ip`);
  eq(L('TEST 5: at most 5 impact substitutes per side'), [before, P.J(`state.teamA.players.filter(p => p.impactSub).length`), /At most 5/.test(lastToast(P))], [5, 5, true]);
  P.E(`['a9','a10'].forEach(id => { const p = state.teamA.players.find(x => x.id === id); p.impactSub = false; p.isXI = true; }); const b = state.teamA.players.find(x => x.id === 'bench'); b.impactSub = false; renderSquadUI();`);

  // ---- windows ----
  pick(P, 'A', 'Hardik', 'Impact Bat');
  eq(L('TEST 6: at 0.0 (start of the innings) it is allowed'), [/Allowed now/.test(P.text('#ip-when')), /start of the innings/.test(P.text('#ip-when'))], [true, true]);
  eq(L('TEST 7: not-out batters at the crease cannot be chosen to go off'), [outBtn(P, 'Rohit').disabled, outBtn(P, 'Ishan').disabled, outBtn(P, 'Hardik').disabled], [true, true, false]);
  eq(L('TEST 8: a not-yet-on substitute and the bench are not in the "goes off" list'), [!!outBtn(P, 'Impact Bat'), !!outBtn(P, 'Bench Guy')], [false, false]);
  eq(L('TEST 9: Confirm is enabled only once both players are picked — and names them'), [P.$('#ip-confirm').disabled, P.$('#ip-confirm').textContent], [false, 'Confirm: ⬆ Impact Bat ⬇ Hardik']);
  eq(L('TEST 9b: the three steps show ✓ team / ⬇ Hardik / ⬆ Impact Bat'), P.$$('#ip-body .ip-step.done').map(e => e.textContent.replace(/^✓/, '').trim()), ['Mumbai Indians', '⬇ Hardik', '⬆ Impact Bat'].map((x, i) => i === 0 ? P.J('state.teamA.name') : x));
  eq(L('TEST 9c: live status under each name (batting / yet to bat)'), [/batting 0 \(0\)/.test(outBtn(P, 'Rohit').textContent), /yet to bat/.test(outBtn(P, 'Hardik').textContent)], [true, true]);
  eq(L('TEST 9d: "comes on" lists the named substitutes, the squad outside the XI, then every other team player who has not played yet (not the one going off, not the batters at the crease)'),
    P.$$('#ip-body [data-ip-in]').map(b => b.firstChild.textContent.trim()), ['⬆ Impact Bat', '⬆ Spare Bat', '⬆ Bench Guy', ...['Surya','Tilak','Tim','Krunal','Piyush','Jasprit','Akash','Arjun'].map(n => '⬆ ' + n)]);
  eq(L('TEST 9e: the three groups are labelled'), P.$$('#ip-body .ip-g').map(e => e.textContent), ['Named substitutes', 'From the squad (not in the XI)', 'Rest of the team (ticked in the XI)']);
  P.E(`closeImpactModal()`);

  P.E(`recordBall('1'); recordBall('0');`);
  pick(P, 'A', 'Hardik', 'Impact Bat');
  eq(L('TEST 10: mid-over (0.2) it is NOT allowed — Confirm disabled, reason shown'), [/Not now/.test(P.text('#ip-when')), /0\.2 is in progress/.test(P.text('#ip-when')), P.$('#ip-confirm').disabled], [true, true, true]);
  P.E(`confirmImpactPlayer()`);
  eq(L('TEST 11: forcing Confirm mid-over changes nothing'), [P.J('state.impactLog.length'), P.J(`state.teamA.players.find(p => p.id === 'a4').isXI`)], [0, true]);
  P.E(`closeImpactModal()`);

  // a wicket mid-over opens the window
  P.E(`recordBall('W', { dismissalType: 'Bowled' }); sendInNewBatsman('Surya', 'a2');`);
  pick(P, 'B', 'Raj', 'Impact Bowl');
  eq(L('TEST 12: at the fall of a wicket (0.3) it is allowed'), /fall of a wicket/.test(P.text('#ip-when')), true);
  eq(L('TEST 13: mid-over (after a wicket) the bowler of this over cannot go off'), [outBtn(P, 'Raj').disabled, /bowling this over/.test(outBtn(P, 'Raj').textContent)], [true, true]);
  eq(L('TEST 14: … and the note says the Impact Player cannot bowl the rest of this over'), /cannot bowl the rest of this over/.test(P.text('#ip-body')), true);
  P.E(`closeImpactModal()`);

  // batting side brings its Impact Player on at the wicket
  const hist0 = P.J('history.length');
  pick(P, 'A', 'Hardik', 'Impact Bat');
  click(P, '#ip-confirm');
  const A = P.J('state.teamA.players');
  const hard = A.find(p => p.id === 'a4'), imp = A.find(p => p.id === 'ipa');
  eq(L('TEST 15: confirmed — Hardik out of the XI (replaced), Impact Bat in the XI'), [hard.isXI, !!hard.impactOut, imp.isXI, !!imp.impactIn], [false, true, true, true]);
  eq(L('TEST 16: the log entry'), (() => { const e = P.J('state.impactLog[0]'); return [e.team, e.inName, e.outName, e.overLabel, e.innings, e.battingSide]; })(), ['A', 'Impact Bat', 'Hardik', '0.3', 1, true]);
  eq(L('TEST 17: the Impact Player can bat; the replaced player cannot'), [names(P, `eligibleBatters('A')`).includes('Impact Bat'), names(P, `eligibleBatters('A')`).includes('Hardik')], [true, false]);
  eq(L('TEST 18: the overlay gets an IMPACT_PLAYER event'), P.emits.filter(e => e.ev === 'cricketEvent').map(e => e.payload.event.kind).slice(-1), ['IMPACT_PLAYER']);
  eq(L('TEST 19: one Undo step was recorded'), P.J('history.length'), hist0 + 1);
  eq(L('TEST 20: the squad row shows "⬆ IP · 0.3" / "⬇ replaced" and the XI tick is locked'),
    [P.$('#squadA-list .squad-player-row[data-id="ipa"] .squad-ip').textContent, P.$('#squadA-list .squad-player-row[data-id="a4"] .squad-ip').textContent, P.$('#squadA-list .squad-player-row[data-id="a4"] input[type=checkbox]').disabled],
    ['⬆ IP · 0.3', '⬇ replaced', true]);
  click(P, '#squadA-list .squad-player-row[data-id="a4"] .remove-player-btn');
  eq(L('TEST 21: a player in the substitution cannot be removed from the squad'), [P.J(`state.teamA.players.some(p => p.id === 'a4')`), /Undo it first/.test(lastToast(P))], [true, true]);

  // one per team
  pick(P, 'A');
  eq(L('TEST 22: a second Impact Player for the same side is refused'), [/already used its Impact Player/.test(P.text('#ip-body')), P.$('#ip-confirm').disabled], [true, true]);
  P.E(`closeImpactModal()`);
  P.E(`ipState = { team: 'A', outKey: 'a5', inKey: 'ipa2' }; confirmImpactPlayer(); closeImpactModal();`);
  eq(L('TEST 23: forcing it changes nothing'), [P.J('state.impactLog.length'), P.J(`state.teamA.players.find(p => p.id === 'a5').isXI`)], [1, true]);
  eq(L('TEST 24: the rule cannot be switched off once an Impact Player has come on'), (() => { const cb = P.$('#ms-impact'); cb.checked = false; cb.dispatchEvent(new P.w.Event('change', { bubbles: true })); return [P.J('state.impactPlayerEnabled'), cb.checked]; })(), [true, true]);

  // bowling side at the end of the over
  P.E(`['0','1','0'].forEach(k => recordBall(k));`);
  eq(L('over 1 complete'), P.J('[state.score.overs, state.score.balls]'), [1, 0]);
  pick(P, 'B', 'Mukesh', 'Impact Bowl');
  eq(L('TEST 25: at the end of an over it is allowed'), /end of over 1/.test(P.text('#ip-when')), true);
  eq(L('TEST 26: at the end of the over Raj (who bowled) can be replaced — shows his figures'), [outBtn(P, 'Raj').disabled, /bowled 1\.0-0-\d+-1/.test(outBtn(P, 'Raj').textContent)], [false, true]);
  click(P, '#ip-confirm');
  eq(L('TEST 27: the bowling side substitution — Impact Bowl can bowl, Mukesh cannot'), [names(P, `eligibleBowlersForNext('B')`).includes('Impact Bowl'), names(P, `eligibleBowlersForNext('B')`).includes('Mukesh')], [true, false]);
  eq(L('TEST 28: … and Mukesh is no longer a fielder (catch / run out lists)'), [names(P, 'fieldingSidePlayers()').includes('Mukesh'), names(P, 'fieldingSidePlayers()').includes('Impact Bowl')], [false, true]);
  nextOver(P, 'Impact Bowl', 'ipb');
  P.E(`recordBall('4')`);
  eq(L('TEST 29: the Impact Player bowls and is credited'), P.J(`state.bowler.name`), 'Impact Bowl');

  // record
  const rec = P.J('buildMatchRecordForLeague()');
  eq(L('TEST 30: the saved match record carries impactPlayers'), (rec.impactPlayers || []).map(e => [e.team, e.inName, e.outName, e.overLabel]), [['A', 'Impact Bat', 'Hardik', '0.3'], ['B', 'Impact Bowl', 'Mukesh', '1.0']]);
  eq(L('TEST 31: … and the squads keep the impact flags'), [rec.squadA.players.find(p => p.id === 'ipa').impactIn, rec.squadA.players.find(p => p.id === 'a4').impactOut], [true, true]);

  // Undo
  P.E(`ballOutbox = []`);
  const logAll = P.J('state.ballLog.length');
  click(P, '#undo-btn'); await sleep(20); // the 4
  eq(L('TEST 32: Undo #1 takes back the last ball'), [P.J('state.ballLog.length'), P.J('state.impactLog.length')], [logAll - 1, 2]);
  click(P, '#undo-btn'); await sleep(20); // the substitution (it was the step before that ball)
  eq(L('TEST 33a: Undo #2 reverses the bowling-side substitution only (no ball removed)'),
    [P.J('state.impactLog.length'), P.J('state.ballLog.length'), P.J(`state.teamB.players.find(p => p.id === 'm1').isXI`), P.J(`!!state.teamB.players.find(p => p.id === 'ipb').impactIn`), /Impact Player substitution undone/.test(lastToast(P))],
    [1, logAll - 1, true, false, true]);

  // ---- pick from the squad / add a new name right in the modal ----
  setup(P, true);
  P.E(`state.teamB.players = state.teamB.players.filter(p => p.id !== 'ipb')`); // no named substitute at all
  pick(P, 'B', 'Jadeja');
  eq(L('TEST 33b: no substitute named — the rest of the team is offered (not Jadeja going off, not Raj bowling) and "+ Add" is there'),
    [!!P.$('#ip-new-name'), !!inBtn(P, 'Mukesh'), !!inBtn(P, 'Jadeja'), !!inBtn(P, 'Raj')], [true, true, false, false]);
  P.$('#ip-new-name').value = 'Jadeja';
  click(P, '#ip-body [data-ip-add]'); await sleep(30);
  eq(L('TEST 33c: typing the player going off is refused'), [/is the player going off/.test(lastToast(P)), P.J(`state.teamB.players.filter(p => p.name === 'Jadeja').length`)], [true, 1]);
  P.$('#ip-new-name').value = 'raj';
  click(P, '#ip-body [data-ip-add]'); await sleep(30);
  eq(L('TEST 33c2: typing a player who has bowled is refused'), /already batted or bowled/.test(lastToast(P)), true);
  P.$('#ip-new-name').value = 'mukesh';
  click(P, '#ip-body [data-ip-add]'); await sleep(30);
  eq(L('TEST 33c3: typing a team player who has not played selects him, with a note'), [inBtn(P, 'Mukesh').className.includes(' on'), /ticked in the Playing XI — pick him only if/.test(P.text('#ip-body')), P.J(`state.teamB.players.filter(p => p.name === 'Mukesh').length`)], [true, true, 1]);
  P.$('#ip-new-name').value = '  Shivam   Mavi ';
  click(P, '#ip-body [data-ip-add]'); await sleep(30);
  const added = P.J(`state.teamB.players.find(p => p.name === 'Shivam Mavi') || null`);
  eq(L('TEST 33d: + Add puts the new player in the squad (not the XI) and selects him'), [!!added, added && added.isXI, !!(inBtn(P, 'Shivam Mavi') || {}).className && inBtn(P, 'Shivam Mavi').className.includes(' on')], [true, false, true]);
  P.$('#ip-new-name').value = 'shivam mavi';
  P.$('#ip-new-name').dispatchEvent(new P.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(30);
  eq(L('TEST 33e: adding the same name again (Enter key) does not duplicate him'), P.J(`state.teamB.players.filter(p => p.name.toLowerCase() === 'shivam mavi').length`), 1);
  click(P, '#ip-confirm');
  const sm = P.J(`state.teamB.players.find(p => p.name === 'Shivam Mavi')`);
  eq(L('TEST 33f: confirmed — he is in the XI as the Impact Player, Jadeja is out'), [sm.isXI, !!sm.impactIn, !!sm.impactSub, P.J(`state.teamB.players.find(p => p.id === 'j8').isXI`), P.J('state.impactLog[0].inName')], [true, true, true, false, 'Shivam Mavi']);
  // a squad player (not named ⬆ IP) chosen directly
  pick(P, 'A', 'Hardik', 'Bench Guy');
  click(P, '#ip-confirm');
  const bg = P.J(`state.teamA.players.find(p => p.id === 'bench')`);
  eq(L('TEST 33g: a squad player picked straight from the modal comes on (named as the substitute)'), [bg.isXI, !!bg.impactIn, !!bg.impactSub, P.J('state.impactLog.length')], [true, true, true, 2]);

  // ---- before the first ball + Undo with an empty ball log ----
  setup(P, true);
  pick(P, 'B', 'Jadeja', 'Impact Bowl');
  click(P, '#ip-confirm');
  eq(L('TEST 33: before the first ball'), P.J('state.impactLog.length'), 1);
  click(P, '#undo-btn'); await sleep(20);
  eq(L('TEST 34: Undo works even with no ball bowled yet'), [P.J('state.impactLog.length'), P.J(`state.teamB.players.find(p => p.id === 'j8').isXI`)], [0, true]);

  // ---- retirement window ----
  setup(P, true);
  P.E(`recordBall('1'); recordBall('1');`);
  P.E(`retireBatsmanHurt('striker');`);
  pick(P, 'A', 'Rohit', 'Impact Bat');
  eq(L('TEST 35: when a batter retires (mid-over) it is allowed'), /batter retiring/.test(P.text('#ip-when')), true);
  P.E(`closeImpactModal()`);

  // ---- Super Over ----
  setup(P, true);
  P.E(`state.phase = 'SUPER_OVER'`);
  pick(P, 'A', 'Hardik', 'Impact Bat');
  eq(L('TEST 36: never during a Super Over'), [/Super Over/.test(P.text('#ip-when')), P.$('#ip-confirm').disabled], [true, true]);
  P.E(`closeImpactModal(); state.phase = 'REGULATION'`);

  // ---- only 11 may bat ----
  setup(P, true);
  pick(P, 'A', 'Hardik', 'Impact Bat');
  click(P, '#ip-confirm');
  P.E(`state.battingCard.A = ['Surya','Tilak','Tim','Krunal','Piyush','Jasprit','Akash','Arjun','Spare'].map((n, i) => ({ name: n, id: 'x' + i, runs: 0, balls: 1, out: true }));`);
  eq(L('TEST 37: with 11 batted (9 out + 2 at the crease) nobody new can bat — not even the Impact Player'),
    names(P, `eligibleBatters('A')`).filter(n => !['Rohit','Ishan','Surya','Tilak','Tim','Krunal','Piyush','Jasprit','Akash','Arjun','Spare'].includes(n)), []);
  P.E(`state.battingCard.A = state.battingCard.A.slice(0, 8)`);
  eq(L('TEST 38: with 10 batted the Impact Player can still come in'), names(P, `eligibleBatters('A')`).includes('Impact Bat'), true);

  // ---- a replaced player who had batted: the IP can still bat ----
  setup(P, true);
  P.E(`recordBall('W', { dismissalType: 'Bowled' }); sendInNewBatsman('Surya', 'a2');`);
  pick(P, 'A', 'Rohit', 'Impact Bat');
  eq(L('TEST 39: replacing a dismissed batter is allowed and the note explains only 11 may bat'), [outBtn(P, 'Rohit').disabled, /out 0 \(1\)/.test(outBtn(P, 'Rohit').textContent), /only 11 players may bat/.test(P.text('#ip-body'))], [false, true, true]);
  click(P, '#ip-confirm');
  eq(L('TEST 40: … and the Impact Player can still bat'), names(P, `eligibleBatters('A')`).includes('Impact Bat'), true);

  // ---- the next match starts from the starting XI ----
  const snap = P.J('squadSnapshotOf(state.teamA)');
  eq(L('TEST 41: the saved squad marks who came on / went off'), [snap.players.find(p => p.id === 'ipa').impactIn, snap.players.find(p => p.id === 'a0').impactOut], [true, true]);

  eq(L('no script errors'), P.errors, []);
  P.w.close();
}

async function scorecard(){
  console.log('\n######## SCORECARD — cricket-scorecard.html ########');
  let html = fs.readFileSync(path.join(__dirname, '..', '..', 'cricket-scorecard.html'), 'utf8').replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole(); const errors = []; vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-scorecard?room=IP', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){}, io: { on(){} } });
      w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      w.firebase = { initializeApp(){}, auth: () => ({ currentUser: null, onAuthStateChanged(){}, signInWithPopup(){}, signOut(){} }), firestore: () => ({}) };
      w.firebase.auth.GoogleAuthProvider = function(){};
      w.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      w.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} };
      w.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
      w.scrollTo = () => {};
    } });
  await sleep(300);
  const w = dom.window;
  w.eval(`scImpactLog = impactListOf({ impactPlayers: [{ team: 'A', inId: 'ipa', inName: 'Naman Dhir', outId: 'a4', outName: 'Hardik', overLabel: '7.0' }] })`);
  eq('SCORECARD: the Impact Player gets a "⬆ IP" badge (came on for …)', /role-ipin[^>]*came on for Hardik at 7\.0[^>]*>⬆ IP</.test(w.eval(`roleBadgesHtml({ name: 'Naman Dhir', id: 'ipa' })`)), true);
  eq('SCORECARD: the replaced player gets a "⬇ SUB" badge', /role-ipout[^>]*>⬇ SUB</.test(w.eval(`roleBadgesHtml({ name: 'Hardik' })`)), true);
  eq('SCORECARD: everyone else — no badge', w.eval(`roleBadgesHtml({ name: 'Rohit', id: 'a0' })`), '');
  eq('SCORECARD: live state (impactLog) is read too', w.eval(`impactListOf({ impactLog: [1] }).length`), 1);
  eq('SCORECARD: no script errors', errors, []);
  w.close();
}

(async () => {
  await suite('cricket-panel.html', 'CLIPPER');
  await suite('cricket-panel3.html', 'STREAM ENGINE');
  await scorecard();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
