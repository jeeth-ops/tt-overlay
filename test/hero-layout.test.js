// cricket-scorecard.html — match header layout guard.
//
// Asserts that nothing in the header ever overlaps or clips anything else,
// across every cricket format, every phase of a match, and every width the
// page is used at. Overlap is measured from real bounding boxes; clipping is
// measured as scrollWidth exceeding clientWidth. Nothing here is eyeballed.
//
// This exists because the header's three columns are content-sized: a long
// result ("... WON BY 1 WICKET WITH 3 BALLS REMAINING") used to take the whole
// middle track and squeeze a team column to 40px, silently cutting its score
// away. That reads fine for "YCC WON" and loses the scores for a Test.
//
// Run:  node test/hero-layout.test.js     (needs playwright + a chromium)
//
// If a state is added to the header (a new format, a new phase), add it to
// STATES below — the point of this file is that the guard grows with the UI.
const { chromium } = require('playwright');
const shim = `window.io=function(){const h={};const s={on:(e,f)=>{(h[e]=h[e]||[]).push(f);return s},emit:()=>{},connected:true};return s};`;

const STATES = [
  { id:'t20-live',        fmt:'T20',  a:'MUMBAI INDIANS', b:'CHENNAI SK', pa:'', centre:'182-4', overs:'(17.2 ov)', tag:'CHENNAI SK BATTING' },
  { id:'t20-long-names',  fmt:'T20',  a:'D Y PATIL SPORTS ACADEMY RED', b:'NEW HIND SPORTING CLUB MUMBAI', pa:'', centre:'182-4', overs:'(17.2 ov)', tag:'BATTING' },
  { id:'odi-chase',       fmt:'ODI',  a:'INDIA', b:'AUSTRALIA', pa:'331-4 (50.0 ov)', centre:'289-6', overs:'(44.3 ov)', tag:'NEED 43 IN 33 BALLS' },
  { id:'test-both-inns',  fmt:'Test', a:'DY PATIL SA', b:'NEW HIND SC', pa:'237-10 & 189-4d (61.0 ov)', pb:'241-4 & 96-2 (30.1 ov)', centre:'96-2', overs:'(30.1 ov)', tag:'TRAIL BY 89 RUNS' },
  { id:'hundred',         fmt:'The Hundred', a:'OVAL INVINCIBLES', b:'SOUTHERN BRAVE', pa:'', centre:'128-5', overs:'(84 balls)', tag:'BATTING' },
  { id:'t10',             fmt:'T10',  a:'DECCAN GLADIATORS', b:'NORTHERN WARRIORS', pa:'', centre:'96-3', overs:'(7.4 ov)', tag:'BATTING' },
  { id:'final-short',     fmt:'T20',  a:'PSC', b:'YCC', pa:'89-7 (20.0 ov)', pb:'92-3 (17.1 ov)', final:'YCC WON BY 7 WICKETS', note:'' },
  { id:'final-long',      fmt:'Test', a:'D Y PATIL SPORTS ACADEMY', b:'NEW HIND SPORTING CLUB', pa:'237-10 & 189-4d', pb:'241-4 & 186-9', final:'NEW HIND SPORTING CLUB WON BY 1 WICKET WITH 3 BALLS REMAINING', note:'NEW HIND SC took the 1st-innings lead by 4 runs' },
  { id:'final-drawn',     fmt:'Test', a:'DY PATIL SA', b:'NEW HIND SC', pa:'237-10 (36.4 ov)', pb:'241-4 (41.1 ov)', final:'MATCH DRAWN', note:'NEW HIND SC took the 1st-innings lead by 4 runs' },
  { id:'super-over',      fmt:'T20',  a:'RAJASTHAN ROYALS', b:'KOLKATA KNIGHT RIDERS', pa:'175-8 (20.0 ov)', pb:'175-6 (20.0 ov)', centre:'12-1', overs:'(0.4 ov)', tag:'SUPER OVER' },
];
const WIDTHS = [1920, 1440, 1200, 1000, 900, 768, 600, 480, 390, 360, 320];

const apply = (st) => {
  const root=document.documentElement;
  root.style.setProperty('--team-a-color','#8c1d2b');
  root.style.setProperty('--team-b-color','#123a6b');
  const hero=document.getElementById('hero');
  const A=document.getElementById('team-block-a'), B=document.getElementById('team-block-b');
  A.style.setProperty('--team-color','#8c1d2b'); B.style.setProperty('--team-color','#123a6b');
  document.getElementById('name-a').textContent=st.a;
  document.getElementById('name-b').textContent=st.b;
  document.getElementById('short-a').textContent=st.a.split(' ').map(w=>w[0]).join('').slice(0,4);
  document.getElementById('short-b').textContent=st.b.split(' ').map(w=>w[0]).join('').slice(0,4);
  document.getElementById('logo-a').textContent='A';
  document.getElementById('logo-b').textContent='B';
  const pa=document.getElementById('prev-score-a'), pb=document.getElementById('prev-score-b');
  pa.style.display = st.pa ? '' : 'none'; if(st.pa) pa.textContent=st.pa;
  pb.style.display = st.pb ? '' : 'none'; if(st.pb) pb.textContent=st.pb;
  const ms=document.getElementById('main-score'), mo=document.getElementById('main-overs'), bt=document.getElementById('batting-tag');
  if(st.final){
    hero.classList.add('hero-final');
    ms.className='result-margin'; ms.textContent=st.final;
    ms.style.setProperty('--result-color','#128a4a');
    mo.style.display='none';
    bt.className='result-note'; bt.textContent=st.note||'';
  } else {
    hero.classList.remove('hero-final');
    ms.className='tabnum'; ms.textContent=st.centre;
    mo.style.display=''; mo.textContent=st.overs;
    bt.className=''; bt.textContent=st.tag||'';
  }
};

const measure = () => {
  const r = (sel) => { const e=document.querySelector(sel); if(!e) return null;
    const b=e.getBoundingClientRect(); return b.width&&b.height?{x:b.x,y:b.y,w:b.width,h:b.height,r:b.right,b:b.bottom}:null; };
  const over = (p,q) => { if(!p||!q) return 0;
    const ox=Math.min(p.r,q.r)-Math.max(p.x,q.x), oy=Math.min(p.b,q.b)-Math.max(p.y,q.y);
    return (ox>1&&oy>1)?Math.round(ox*oy):0; };
  const logoA=r('#logo-a'), nameA=r('#team-block-a .team-name-block'),
        logoB=r('#logo-b'), nameB=r('#team-block-b .team-name-block'),
        blkA=r('#team-block-a'), blkB=r('#team-block-b'), mid=r('#score-center');
  const clipped = (sel) => { const e=document.querySelector(sel); if(!e||!e.offsetParent) return false;
    return e.scrollWidth > e.clientWidth + 2; };
  return {
    pairs: {
      'logoA/nameA': over(logoA,nameA), 'logoB/nameB': over(logoB,nameB),
      'blockA/centre': over(blkA,mid), 'centre/blockB': over(mid,blkB),
      'blockA/blockB': over(blkA,blkB),
    },
    scoreClipped: clipped('#prev-score-a') || clipped('#prev-score-b'),
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
};

(async () => {
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const fails = [];
  for (const w of WIDTHS) {
    const ctx = await b.newContext({ viewport:{ width:w, height:900 } });
    const p = await ctx.newPage();
    await p.route('**/socket.io/socket.io.js', r=>r.fulfill({contentType:'application/javascript',body:shim}));
    await p.route('**/api/**', r=>r.fulfill({contentType:'application/json',body:'{"success":false}'}));
    await p.goto('file:///home/user/tt-overlay/cricket-scorecard.html?room=demo',{waitUntil:'domcontentloaded'});
    await p.waitForTimeout(700);
    for (const st of STATES) {
      await p.evaluate(apply, st);
      await p.waitForTimeout(120);
      const m = await p.evaluate(measure);
      for (const [k,v] of Object.entries(m.pairs)) if(v) fails.push(`${w}px  ${st.id.padEnd(15)} ${k} overlap ${v}px²`);
      if (m.scoreClipped) fails.push(`${w}px  ${st.id.padEnd(15)} score text is clipped`);
      if (m.pageOverflow) fails.push(`${w}px  ${st.id.padEnd(15)} page overflows horizontally`);
    }
    await ctx.close();
    process.stdout.write(`  ${w}px checked\n`);
  }
  console.log('');
  if (fails.length) { console.log(`✗ ${fails.length} problem(s):`); fails.forEach(f=>console.log('   '+f)); }
  else console.log(`✓ no overlap in ${STATES.length} match states x ${WIDTHS.length} widths (${STATES.length*WIDTHS.length} combinations)`);
  await b.close();
  process.exit(fails.length?1:0);
})();
