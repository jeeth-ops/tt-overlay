// 📑 MATCH REPORTS — the scorecard Excel and the PDF match report, with
// wagon wheels (both teams + the top scorer), built by /match-report.js:
//   • the inlined copies in both panels match the module (--sync rewrites them)
//   • the model: totals add up, fall of wickets + partnerships, minutes,
//     start/end time, bowler dots/wides/no balls, best performers, the worm
//   • the wagon wheel: runs by region, off/leg split, left-handers mirrored,
//     super over and byes left out, the top scorer's own wheel
//   • the real Excel + PDF files (when exceljs / jspdf are installed — set
//     MR_LIBS=<dir holding node_modules> to point at them)
//   • both panels: the Session card, Excel / PDF / Both buttons, and the
//     automatic download the moment the match ends (once, after the last
//     wagon wheel is placed, never for an old match just opened)
//
//   node test/cricket/match-report-test.js           run
//   node test/cricket/match-report-test.js --sync    re-inline the module into the panels
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'match-report.js'), 'utf8');
const M = require('../../match-report.js');
const { makeMatch } = require('./match-report-fixture.js');
const PANELS = ['cricket-panel.html', 'cricket-panel3.html'];
const BEGIN = '/* MATCH-REPORT:BEGIN', END = '/* MATCH-REPORT:END */';
function split(html){
  const b = html.indexOf(BEGIN), e = html.indexOf(END);
  if(b < 0 || e < 0) return null;
  const headEnd = html.indexOf('*/', b) + 2;
  return { before: html.slice(0, headEnd), inner: html.slice(headEnd, e), after: html.slice(e) };
}
if(process.argv.includes('--sync')){
  PANELS.forEach(f => {
    const p = path.join(ROOT, f), parts = split(fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, parts.before + '\n' + SRC + parts.after);
    console.log('synced', f);
  });
  process.exit(0);
}

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
function lib(name){
  for(const d of [process.env.MR_LIBS, ROOT].filter(Boolean)){
    try{ return require(require.resolve(name, { paths: [d] })); }catch(e){ /* next */ }
  }
  return null;
}

function syncSuite(){
  console.log('\n######## inlined copies ########');
  PANELS.forEach(f => {
    const parts = split(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    eq(`${f}: carries match-report.js unchanged`, !!parts && parts.inner === '\n' + SRC, true);
  });
}

function modelSuite(){
  console.log('\n######## the model ########');
  const snap = makeMatch({ seed: 7 });
  const m = M.buildModel(snap);
  eq('two innings, in order', m.innings.map(i => [i.no, i.team]), [[1, 'A'], [2, 'B']]);
  m.innings.forEach(inn => {
    const L = s => `inn ${inn.no}: ${s}`;
    eq(L('batting runs + extras = the total'), sum(inn.batting, b => b.runs) + inn.extras.total, inn.runs);
    eq(L('bowlers\' runs + byes + leg byes + penalties = the total'), sum(inn.bowling, w => w.runs) + inn.extras.b + inn.extras.lb + inn.extras.pen, inn.runs);
    const raw = snap.innings.find(i => i.no === inn.no);
    eq(L('wickets credited to bowlers'), sum(inn.bowling, w => w.wickets), raw.batting.filter(b => b.out && b.dismissalType !== 'Run Out').length);
    eq(L('one fall of wicket per wicket, named in order'), [inn.fow.length, inn.fow.map(f => f.name)],
      [inn.wickets, snap.balls.filter(b => b.innings === inn.no && b.isWicket).map(b => b.dismissedPlayer)]);
    eq(L('partnerships at each wicket add up to the score at the last one'), sum(inn.fow, f => f.partnership), inn.fow.length ? inn.fow[inn.fow.length - 1].runs : 0);
    eq(L('every partnership spell adds up to the total'), sum(inn.partnerships, p => p.runs), inn.runs);
    eq(L('minutes batted for every batter'), inn.batting.every(b => Number.isInteger(b.mins) && b.mins >= 0), true);
    const ib = snap.balls.filter(b => b.innings === inn.no);
    eq(L('start / end time from the first / last ball'), [inn.start, inn.end, /^\d{1,2}:\d\d (AM|PM)$/.test(inn.startText), inn.minutes],
      [ib[0].timestamp, ib[ib.length - 1].timestamp, true, Math.round((ib[ib.length - 1].timestamp - ib[0].timestamp) / 60000)]);
    eq(L('wides / no balls / dots per bowler from the deliveries'), inn.bowling.map(w => [w.wd, w.nb]),
      inn.bowling.map(w => [ib.filter(b => b.bowler === w.name && b.ballType === 'Wd').length, ib.filter(b => b.bowler === w.name && b.ballType === 'Nb').length]));
    eq(L('dots = legal balls that cost nothing'), inn.bowling.map(w => w.dots),
      inn.bowling.map(w => ib.filter(b => b.bowler === w.name && !['Wd', 'Nb'].includes(b.ballType) && !b.bowlerFacts.runs).length));
    eq(L('the worm ends on the total, over by over'), [inn.worm[inn.worm.length - 1].runs, inn.worm.every((p, i) => !i || p.over > inn.worm[i - 1].over)], [inn.runs, true]);
    eq(L('top scorer / best bowler picked'), [inn.topBat, inn.topBowl],
      [inn.batting.slice().sort((a, b) => b.runs - a.runs || a.balls - b.balls)[0].name, inn.bowling.slice().sort((a, b) => b.wickets - a.wickets || a.runs - b.runs)[0].name]);
  });
  eq('captain and keeper marked', [m.innings[0].batting.find(b => b.name === 'Karsh Kothari').captain, m.innings[0].batting.find(b => b.name === 'Suraj Shinde').keeper], [true, true]);
  eq('batting hand shown', m.innings[0].batting.find(b => b.name === 'Harsh Rane').hand, 'LHB');
  eq('match details', [m.meta.dateText, m.meta.dayPart, m.meta.toss, m.meta.result], ['27 Sep 2026', 'Afternoon', 'New Hind Sporting Club won the toss and chose to field', snap.result.text]);
  eq('best batters by runs, best bowlers by wickets', [m.best.batters.every((b, i, a) => !i || a[i - 1].runs >= b.runs), m.best.bowlers.every((b, i, a) => !i || a[i - 1].wickets >= b.wickets), m.best.batters.length, m.best.bowlers.length], [true, true, 3, 3]);
  eq('a player of the match', !!(m.star && m.star.name && m.star.teamName), true);
  eq('match in numbers', [m.numbers.A.runs, m.numbers.B.runs, m.numbers.A.fours], [m.innings[0].runs, m.innings[1].runs, sum(m.innings[0].batting, b => b.fours)]);

  console.log('\n=== wagon wheel ===');
  ['A', 'B'].forEach(k => {
    const w = m.wagon[k];
    eq(`${k}: region runs, shot runs, off + leg all agree`, [sum(w.list, z => z.runs), sum(w.shots, s => s.runs), w.offRuns + w.legRuns], [w.runs, w.runs, w.runs]);
    const batBalls = snap.balls.filter(b => b.battingTeam === k && M.batRunsOf(b) > 0);
    eq(`${k}: placed / scoring shots counted`, [w.mapped, w.scoringShots], [batBalls.filter(b => b.shot).length, batBalls.length]);
    eq(`${k}: fours and sixes`, [w.fours, w.sixes], [w.shots.filter(s => s.four).length, w.shots.filter(s => s.six).length]);
    eq(`${k}: percentages`, [w.offPct + w.legPct, w.top && w.top.runs === Math.max(...w.list.map(z => z.runs))], [100, true]);
  });
  const lefty = snap.balls.find(b => b.shot && b.shot.hand === 'L');
  const wl = M.wagonOf([lefty], { team: lefty.battingTeam });
  eq('a left-hander\'s shot is mirrored into the team\'s right-handed view', [wl.shots[0].x, wl.shots[0].y], [-lefty.shot.x * 100, lefty.shot.y * 100]);
  const own = M.wagonOf([lefty], { batter: lefty.striker, hand: 'L' });
  eq('…and drawn as played on the batter\'s own wheel', own.shots[0].x, lefty.shot.x * 100);
  eq('…and still counted in their own region', wl.zones[lefty.shot.zone].runs, M.batRunsOf(lefty));
  const star = m.wagon.star;
  eq('the top scorer gets their own wheel', [star.name, star.wheel.runs, star.hand], [m.best.batters[0].name, sum(snap.balls.filter(b => b.striker === star.name && b.shot), b => M.batRunsOf(b)), snap.hands[star.name]]);
  const extra = [...snap.balls, { innings: 3, battingTeam: 'A', ballType: '6', runs: 6, striker: 'Aman Khan', superOverId: 'so1', phase: 'SUPER_OVER', shot: { zone: 'midwicket', depth: 'deep', hand: 'R', x: 0.7, y: 0.7 } },
    { innings: 1, battingTeam: 'A', ballType: 'LB', runs: 2, striker: 'Aman Khan', shot: { zone: 'fineleg', depth: 'inner', hand: 'R', x: 0.1, y: -0.3 } }];
  eq('super over and leg byes stay off the wheel', M.wagonOf(extra, { team: 'A' }).runs, m.wagon.A.runs);
  eq('runs off the bat', [M.batRunsOf({ ballType: '4', runs: 4 }), M.batRunsOf({ ballType: 'Nb', runs: 5, nbRunsAs: 'bat' }), M.batRunsOf({ ballType: 'Nb', runs: 3, nbRunsAs: 'bye' }), M.batRunsOf({ ballType: 'LB', runs: 2 }), M.batRunsOf({ ballType: 'OT', runs: 5 })], [4, 4, 0, 0, 5]);
  eq('a region-only shot lands inside its region', (() => { const p = M._internal.shotPoint({ zone: 'cover', depth: 'deep' }, 'R'); const a = (Math.atan2(p[0], -p[1]) * 180 / Math.PI + 360) % 360; return a > 225 && a < 270; })(), true);
  eq('how out, in the scoresheet\'s words', [
    M.howOutShort({ out: true, dismissalType: 'Caught', howOut: 'c & b Raj' }), M.howOutShort({ out: true, dismissalType: 'Caught', howOut: 'c X b Raj' }),
    M.howOutShort({ out: true, dismissalType: 'Run Out' }), M.howOutShort({ out: false, howOut: 'retired hurt' }), M.howOutShort({ out: false, howOut: 'not out' }),
    M.howOutShort({ out: true, howOut: 'lbw b Raj' })], ['CAUGHT & BOWLED', 'CAUGHT', 'RUN OUT', 'RETIRED HURT', 'NOT OUT', 'LBW']);
  const none = M.buildModel(makeMatch({ seed: 3, shots: false }));
  eq('no shots marked → empty wheels, no top-scorer wheel', [none.wagon.mapped, none.wagon.star, none.wagon.scoringShots > 0], [0, null, true]);
  return { snap, m, none };
}

async function filesSuite(ctx){
  const ExcelJS = lib('exceljs'), jspdf = lib('jspdf');
  console.log('\n######## the files ########');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const imgs = { A: { dataUrl: png, width: 440, height: 536 }, B: { dataUrl: png, width: 440, height: 536 }, star: { dataUrl: png, width: 440, height: 536 } };
  if(!ExcelJS){ console.log('  SKIP  Excel checks — exceljs not installed (set MR_LIBS)'); }
  else {
    const wb = M.buildExcel(ExcelJS, ctx.m, imgs);
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await wb.xlsx.writeBuffer());
    eq('XLSX: two sheets — Scorecard and Wagon Wheel', back.worksheets.map(w => w.name), ['Scorecard', 'Wagon Wheel']);
    const ws = back.getWorksheet('Scorecard');
    const rows = [];
    ws.eachRow((r, n) => rows.push({ n, v: r.values.slice(1).map(x => x && typeof x === 'object' && 'formula' in x ? { f: x.formula, r: x.result } : x) }));
    const heads = rows.filter(r => r.v[1] === 'Batsmen ' || r.v[1] === 'Batsmen');
    eq('XLSX: the paper sheet\'s batting + bowling columns, once per innings', heads.map(r => r.v.slice(0, 19)), ctx.m.innings.map(() =>
      ['No', 'Batsmen', 'How out', 'Bowler', 'Runs', 'Balls', 'Mins', "4's", "6's", undefined, 'No', 'Bowlers', 'TYPE', 'OVER', 'MAIDEN', 'RUNS', 'WKT', 'NB', 'WB']));
    const first = rows.find(r => r.n === heads[0].n + 1).v;
    const b1 = ctx.m.innings[0].batting[0];
    eq('XLSX: a batting row', [first[0], first[1], first[2], first[4], first[5], first[7], first[8]], [1, b1.name.toUpperCase(), b1.howOut, b1.runs, b1.balls, b1.fours, b1.sixes]);
    const totals = rows.filter(r => r.v[11] === 'TOTAL');
    eq('XLSX: bowling TOTAL rows sum the column (formula + value)', totals.map(r => [typeof r.v[15].f, r.v[15].r]), ctx.m.innings.map(i => ['string', i.runs]));
    const tot = rows.filter(r => r.v[3] === 'Total');
    eq('XLSX: Total = batters + extras', tot.map(r => r.v[4].r), ctx.m.innings.map(i => i.runs));
    eq('XLSX: extras block (B, LB, Wd, Nb) and Wickets / Total Min', [rows.some(r => /^LB - \d+$/.test(r.v[1] || '')), rows.filter(r => r.v[3] === 'Wickets').map(r => r.v[4]), rows.some(r => r.v[3] === 'Total Min')],
      [true, ctx.m.innings.map(i => i.wickets), true]);
    const fowH = rows.filter(r => r.v[3] === 'Name of Batsmen Out');
    eq('XLSX: fall of wicket table', fowH.map(r => r.v.slice(0, 5)), ctx.m.innings.map(() => ['No', 'Runs', 'Over No', 'Name of Batsmen Out', 'Partnership']));
    eq('XLSX: header — teams, date, ground, toss, result', [rows[0].v[0], rows.some(r => r.v.includes('27 Sep 2026')), rows.some(r => r.v.includes(ctx.m.meta.venue)), rows.some(r => r.v.includes(ctx.m.meta.result))],
      [`${ctx.m.teams.A.name}  vs  ${ctx.m.teams.B.name}`.toUpperCase(), true, true, true]);
    const ww = back.getWorksheet('Wagon Wheel');
    const regionRows = [];
    ww.eachRow(r => { const v = r.values; [2, 12].forEach(c => { if(M.ZONES.some(z => z.name === v[c])) regionRows.push({ c, runs: v[c + 1] }); }); });
    eq('XLSX: wagon wheel — 8 regions per team + top scorer', regionRows.length, 24);
    eq('XLSX: …team A regions add up to its mapped runs', regionRows.filter(r => r.c === 2).reduce((s, x) => s + x.runs, 0), ctx.m.wagon.A.runs);
    eq('XLSX: the three wheel pictures are in', ww.getImages().length, 3);
    const wb2 = M.buildExcel(ExcelJS, ctx.none, {});
    const back2 = new ExcelJS.Workbook();
    await back2.xlsx.load(await wb2.xlsx.writeBuffer());
    eq('XLSX: a match without wagon wheel shots still builds', back2.worksheets.length, 2);
  }
  if(!jspdf){ console.log('  SKIP  PDF checks — jspdf not installed (set MR_LIBS)'); }
  else {
    const doc = M.buildPdf(jspdf.jsPDF, ctx.m, imgs);
    const buf = Buffer.from(doc.output('arraybuffer'));
    eq('PDF: summary + wagon wheels + one page per innings + squads', doc.getNumberOfPages(), 3 + ctx.m.innings.length);
    eq('PDF: a real PDF file', buf.slice(0, 5).toString(), '%PDF-');
    const seen = { logos: 0, texts: [] };
    function Spy(o){ const d = new jspdf.jsPDF(o); const ai = d.addImage.bind(d), tx = d.text.bind(d);
      d.addImage = function(){ if(arguments[6] === 'brand') seen.logos++; return ai.apply(null, arguments); };
      d.text = function(t){ seen.texts.push(String(t)); return tx.apply(null, arguments); };
      return d; }
    const sd = M.buildPdf(Spy, ctx.m, imgs);
    eq('PDF: the All Sports Live logo + name on every page', [seen.logos, seen.texts.filter(t => t === 'ALL SPORTS LIVE').length], [sd.getNumberOfPages(), sd.getNumberOfPages()]);
    eq('PDF: officials are the two captains only', [seen.texts.filter(t => t === 'Captain').length, seen.texts.some(t => /Umpire|Scorer/.test(t))], [2, false]);
    const odd = M.buildModel(Object.assign(makeMatch({ seed: 5 }), {}));
    odd.innings[0].batting[0].name = 'राहुल “Rocket” Sharma';
    let ok = true; try{ M.buildPdf(jspdf.jsPDF, odd, {}).output('arraybuffer'); }catch(e){ ok = false; }
    eq('PDF: names outside the PDF font never break it', ok, true);
    eq('PDF: …and come out readable', M.pdfSafe('राहुल “Rocket” Sharma — c †Raj'), ' "Rocket" Sharma - c Raj');
    eq('PDF: a match without wagon wheel shots still builds', M.buildPdf(jspdf.jsPDF, ctx.none, {}).getNumberOfPages(), 3 + ctx.none.innings.length);
  }
}

// ---- both panels -----------------------------------------------------------
function boot(file){
  let html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/cricket-panel?room=MR', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(ev, payload, ack){ if(typeof ack === 'function') ack({ ok: true }); }, connected: true, disconnect(){}, io: { on(){} } });
      w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
      w.firebase = { initializeApp(){}, auth: () => ({ currentUser: null, onAuthStateChanged(){}, signInWithPopup(){}, signOut(){} }), firestore: () => ({}) };
      w.firebase.auth.GoogleAuthProvider = function(){};
      w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLMediaElement.prototype.pause = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null; // jsdom has no canvas
      w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
      w.IntersectionObserver = w.IntersectionObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.ResizeObserver = w.ResizeObserver || class { observe(){} unobserve(){} disconnect(){} };
      w.scrollTo = () => {};
    }
  });
  const w = dom.window;
  return { w, errors, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s), J: (x) => JSON.parse(w.eval(`JSON.stringify(${x})`)),
    text: (s) => { const el = w.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; } };
}
const click = (P, sel) => P.$(sel).dispatchEvent(new P.w.Event('click', { bubbles: true }));
const BAT = ['Rohit Sharma', 'Ishan', 'Surya', 'Tilak', 'Hardik', 'Tim', 'Krunal', 'Piyush', 'Jasprit', 'Akash', 'Arjun'];
const BOWL = ['Raj', 'Mukesh', 'Aman', 'Kabir', 'Dev', 'Om', 'Sam', 'Karan', 'Rahul', 'Pant', 'Jadeja'];
function setup(P){
  P.E(`
    closeWagonWheel();
    state = mergeWithDefaults(null);
    state.format = 'T20'; state.battingTeam = 'A'; state.venue = 'Wankhede'; state.matchDate = '2026-10-05';
    state.teamA.name = 'Mumbai Indians'; state.teamA.short = 'MI'; state.teamB.name = 'Royal Challengers'; state.teamB.short = 'RCB';
    document.getElementById('match-id').value = 'MR';
    state.teamA.players = ${JSON.stringify(BAT)}.map((n, i) => ({ id: 'a' + i, name: n, isXI: true }));
    state.teamB.players = ${JSON.stringify(BOWL)}.map((n, i) => ({ id: 'b' + i, name: n, isXI: true }));
    state.teamA.captainId = 'a0';
    state.striker    = { name:'Rohit Sharma', id:'a0', runs:0, balls:0, fours:0, sixes:0 };
    state.nonStriker = { name:'Ishan', id:'a1', runs:0, balls:0, fours:0, sixes:0 };
    state.bowler = { name:'Raj', id:'b0', overs:0, balls:0, maidens:0, runs:0, wickets:0, runsThisOver:0, wicketsThisOver:0 };
    history = []; ballOutbox = [];
    try{ localStorage.removeItem('scorvix-reports-done'); localStorage.removeItem('scorvix-reports-auto'); }catch(e){}
    mrPrevResult = false; mrLast = null; mrCardSig = '';
    renderPanel(); renderMatchReportsCard();
  `);
  // the libraries and the downloads, captured
  P.E(`
    window.__dl = [];
    window.ExcelJS = {};
    window.jspdf = { jsPDF: function(){} };
    MatchReport.buildExcel = (X, m, imgs) => ({ m, imgs });
    MatchReport.buildPdf = (J, m) => ({ output: () => new Blob(['%PDF']) , m });
    xlDownload = async (wb, name) => { window.__dl.push(['xlsx', name, wb.m.innings.length]); };
    mrSaveBlob = (blob, name) => { window.__dl.push(['pdf', name]); };
  `);
}
const at = (deg, r) => [r * Math.sin(deg * Math.PI / 180), -r * Math.cos(deg * Math.PI / 180)];
const pickAt = (P, deg, r) => { const [x, y] = at(deg, r); return P.J(`wwPickAt(${x}, ${y})`); };

async function panelSuite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const P = boot(file);
  await sleep(80);
  const L = s => `${label}: ${s}`;
  setup(P);

  eq(L('Session card: Match Reports with Excel, PDF and Both'), [!!P.$('#mr-card'), P.text('#download-match-excel-btn'), P.text('#mr-pdf-btn'), P.text('#mr-both-btn')],
    [true, '📊 Excel Scorecard', '📄 PDF Report', '⬇️ Download Both (Excel + PDF)']);
  eq(L('auto-download is on by default; the tournament report is still there'), [P.$('#mr-auto').checked, !!P.$('#download-tournament-excel-btn'), /Export Match Excel Report/.test(P.w.document.body.innerHTML)], [true, true, false]);

  P.E(`recordBall('4')`); await sleep(5);
  pickAt(P, 250, 90);
  P.E(`closeWagonWheel(); recordBall('1')`); await sleep(5);
  P.E(`closeWagonWheel(); recordBall('0')`); await sleep(5);
  P.E(`setBatHand(state.striker, 'L'); recordBall('2')`); await sleep(5);
  pickAt(P, 248, 40); // a left-hander's mid-wicket is on the screen's left
  P.E(`closeWagonWheel(); mrCardSig = ''; renderMatchReportsCard();`);
  eq(L('the card counts placed wagon wheel shots'), P.text('#mr-ww'), '🎯 Wagon wheel: 2 of 3 scoring shots placed');

  const snap = P.J('mrSnapshot()');
  eq(L('snapshot: the innings on the panel, live batters and bowler included'), [snap.innings.length, snap.innings[0].batting.map(b => [b.name, b.runs, b.out]), snap.innings[0].bowling.map(b => [b.name, b.overs, b.runs])],
    [1, [['Rohit Sharma', 5, false], ['Ishan', 2, false]], [['Raj', '0.4', 7]]]);
  eq(L('snapshot: teams, captain, hands, date, venue'), [snap.teams.A.name, snap.teams.A.captain, snap.teams.A.players.length, snap.hands['Ishan'], snap.date, snap.venue], ['Mumbai Indians', 'Rohit Sharma', 11, 'L', '2026-10-05', 'Wankhede']);
  const model = P.J('MatchReport.buildModel(mrSnapshot())');
  eq(L('model: the wheel has both placed shots, the left-hander mirrored'), [model.wagon.A.mapped, model.wagon.A.runs, model.wagon.A.scoringShots, model.wagon.A.shots.map(s => s.hand)], [2, 6, 3, ['R', 'L']]);
  eq(L('model: cover four for the right-hander, mid-wicket two for the left-hander'), [model.wagon.A.zones.cover.runs, model.wagon.A.zones.midwicket.runs], [4, 2]);

  console.log('\n=== buttons ===');
  click(P, '#mr-both-btn'); await sleep(30);
  eq(L('Download Both → the Excel scorecard and the PDF report'), P.J('window.__dl'), [['xlsx', '2026-10-05_MI_vs_RCB_Scorecard.xlsx', 1], ['pdf', '2026-10-05_MI_vs_RCB_Match_Report.pdf']]);
  eq(L('…and says so on the card'), /^✓ Excel \+ PDF downloaded at /.test(P.text('#mr-last')), true);
  P.E('window.__dl = []');
  click(P, '#download-match-excel-btn'); await sleep(20);
  click(P, '#mr-pdf-btn'); await sleep(20);
  eq(L('Excel alone, PDF alone'), P.J('window.__dl.map(d => d[0])'), ['xlsx', 'pdf']);
  P.E('window.__dl = []; delete window.ExcelJS;');
  click(P, '#download-match-excel-btn'); await sleep(20);
  eq(L('no Excel library → a clear message, nothing half-made'), [P.J('window.__dl.length'), /Excel library failed to load/.test(P.w.document.body.textContent)], [0, true]);
  P.E('window.ExcelJS = {};');

  console.log('\n=== automatic, when the match ends ===');
  P.E(`window.__dl = []; state.milestonesHit['match-result'] = true; state.matchResultText = 'MI won by 5 runs'; state.matchWinnerKey = 'A'; mrWatch();`);
  await sleep(400);
  eq(L('not instantly — a moment for the last wagon wheel'), P.J('window.__dl.length'), 0);
  await sleep(1500);
  eq(L('then both reports download by themselves'), P.J('window.__dl.map(d => d[0])'), ['xlsx', 'pdf']);
  eq(L('…marked as automatic'), /\(auto, match over\)/.test(P.text('#mr-last')), true);
  P.E(`window.__dl = []; state.milestonesHit['match-result'] = false; mrWatch(); state.milestonesHit['match-result'] = true; mrWatch();`);
  await sleep(1800);
  eq(L('the same result never downloads twice'), P.J('window.__dl.length'), 0);

  P.E(`window.__dl = []; state.milestonesHit['match-result'] = false; mrWatch(); recordBall('2');`);
  await sleep(5);
  P.E(`state.milestonesHit['match-result'] = true; state.matchResultText = 'MI won by 7 runs'; mrWatch();`);
  await sleep(1900);
  eq(L('while the last ball\'s wagon wheel is open it waits…'), [P.$('#ww-overlay').classList.contains('show'), P.J('window.__dl.length')], [true, 0]);
  pickAt(P, 100, 70);
  await sleep(1900);
  eq(L('…and goes once it is placed, with that shot in it'), [P.J('window.__dl.map(d => d[0])'), P.J('MatchReport.buildModel(mrSnapshot()).wagon.A.mapped')], [['xlsx', 'pdf'], 3]);

  P.E(`window.__dl = []; state.milestonesHit['match-result'] = false; mrWatch();`);
  P.$('#mr-auto').checked = false; P.$('#mr-auto').dispatchEvent(new P.w.Event('change'));
  P.E(`state.milestonesHit['match-result'] = true; state.matchResultText = 'MI won by 9 runs'; mrWatch();`);
  await sleep(1900);
  eq(L('switch off → nothing downloads by itself'), [P.J(`localStorage.getItem('scorvix-reports-auto')`), P.J('window.__dl.length')], ['0', 0]);
  P.$('#mr-auto').checked = true; P.$('#mr-auto').dispatchEvent(new P.w.Event('change'));

  P.E(`window.__dl = []; mrPrevResult = null; state.matchResultText = 'MI won by 11 runs'; mrWatch(); mrWatch();`);
  await sleep(1900);
  eq(L('a match that was already over when the panel opened is not downloaded'), P.J('window.__dl.length'), 0);
  P.E(`window.__dl = []; state.milestonesHit['match-result'] = false; mrWatch();
    state.ballLog.forEach(b => { b.timestamp = Date.now() - 3600000; });
    state.milestonesHit['match-result'] = true; state.matchResultText = 'MI won by 12 runs'; mrWatch();`);
  await sleep(1900);
  eq(L('nor an old finished match loaded onto it'), P.J('window.__dl.length'), 0);

  eq(L('no script errors'), P.errors, []);
}

(async () => {
  syncSuite();
  const ctx = modelSuite();
  await filesSuite(ctx);
  for(const f of PANELS) await panelSuite(f, f.includes('3') ? 'ENGINE' : 'CLIPPER');
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
