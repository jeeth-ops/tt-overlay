// score-tournament.html — where a match row takes you.
//
// A match still being played has no saved result, so its snapshot is by
// definition incomplete. Clicking such a row used to open history mode, which
// showed the second innings at 0-0 under the caption "Match Completed" —
// while the Watch Live button directly above it opened the same match fine.
//
// So: a live row must go to the live room, and a finished row (or one with no
// room recorded) must go to the snapshot.
//
// Run:  node test/match-routing.test.js     (needs playwright + a chromium)
const { chromium } = require('playwright');
const fs = require('fs');
const src = fs.readFileSync('/home/user/tt-overlay/score-tournament.html','utf8');
const css = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
const grab = (n)=>{ const i=src.indexOf(`function ${n}(`); const j=src.indexOf('\n}',i)+2; return src.slice(i,j); };
const helpers = ['escapeHtml','teamLabel','resultText','winnerSide','matchDate','initials','safeTeamColor','safeLogoUrl','teamInitials','inkOn','teamLogoHtml','hasBatted','scoreText','oversText','matchStatusOf','matchCardHtml','liveRoomCardHtml'].map(grab).join('\n')
  + "\nconst MATCH_STATUS_LABEL = { live:'Live', progress:'In Progress', done:'Completed', abandoned:'Abandoned', upcoming:'Upcoming' };\nconst PIN_ICON = '';";
const start = src.indexOf('  // 🏏 Every match is its own card');
const end = src.indexOf('  const pt = data.pointsTable', start);
const body = src.slice(start, end);

const DATA = {
  displayName:'Kanga League', live:{ roomId:'ROOM-PSC-YCC', matchId:'m-live' },
  matches:[
    { matchId:'m-live', roomId:'ROOM-PSC-YCC', teamA:{short:'Psc',name:'Parel SC'}, teamB:{short:'YCC',name:'Young Comrade CC'},
      venue:'Police Gymkhana', savedAt:Date.parse('2026-09-30'),
      scoreA:{runs:89,wickets:7}, scoreB:{runs:0,wickets:0}, winningTeam:null },
    { matchId:'m-done', roomId:'ROOM-OLD', teamA:{short:'DYP',name:'DY Patil'}, teamB:{short:'NHSC',name:'New Hind'},
      venue:'D Y Patil', savedAt:Date.parse('2026-09-28'),
      scoreA:{runs:237,wickets:10}, scoreB:{runs:241,wickets:4}, winningTeam:'DRAW' },
    // in progress but no room recorded -> snapshot is the only option
    { matchId:'m-noroom', teamA:{short:'AAA',name:'Alpha'}, teamB:{short:'BBB',name:'Beta'},
      venue:'Ground', savedAt:Date.parse('2026-09-29'),
      scoreA:{runs:50,wickets:2}, scoreB:{runs:0,wickets:0}, winningTeam:null },
  ],
};
const js = `
${helpers}
const data = ${JSON.stringify(DATA)};
const matches = data.matches || [];
const finished = matches.filter(m => m.winningTeam);
const inProgress = matches.filter(m => !m.winningTeam);
const isLive = true;
const token = 'TESTTOKEN';
${body}
document.getElementById('out').innerHTML = matchesPanel;
window.__nav = [];
document.querySelectorAll('[data-goto-match]').forEach(row => row.addEventListener('click', (e) => {
  e.preventDefault();
  const room = row.dataset.gotoRoom;
  window.__nav.push(room
    ? '/cricket-scorecard?room=' + encodeURIComponent(room)
    : '/cricket-scorecard?token=' + encodeURIComponent(token) + '&match=' + encodeURIComponent(row.dataset.gotoMatch) + '&history=1');
}));
`;
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const p=await b.newPage({viewport:{width:1200,height:900}});
  await p.setContent(`<!doctype html><html data-theme="light"><head><style>${css}</style></head><body><div id="wrap"><div id="out"></div></div></body></html>`);
  await p.addScriptTag({ content: js });
  await p.waitForTimeout(300);
  const rows = await p.$$('[data-goto-match]');
  let fails=[];
  for (const r of rows) {
    const id = await r.getAttribute('data-goto-match');
    await r.click();
    const nav = (await p.evaluate(()=>window.__nav)).slice(-1)[0];
    const want = id==='m-live' ? '/cricket-scorecard?room=ROOM-PSC-YCC'
               : id==='m-done' ? '/cricket-scorecard?token=TESTTOKEN&match=m-done&history=1'
               : '/cricket-scorecard?token=TESTTOKEN&match=m-noroom&history=1';
    const href = await r.getAttribute('href');
    const ok = nav===want && href===want;
    console.log(`  ${ok?'✓':'✗'} ${id.padEnd(10)} -> ${nav}  (href ${href})`);
    if(!ok) fails.push(`${id}: got ${nav} / href ${href}, want ${want}`);
  }
  console.log('');
  console.log(fails.length ? '✗ '+fails.join('; ') : '✓ live match opens the live room; finished and room-less matches open the snapshot');
  await b.close(); process.exit(fails.length?1:0);
})();
