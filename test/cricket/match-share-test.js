/* 🟢 WHATSAPP MATCH SHARE — end to end, on the REAL server.js
   (test/server-boot.js: in-memory MongoDB) and the REAL panels in Chromium
   (cricket-panel.html = Clipper, cricket-panel3.html = Stream Engine), with
   anonymous viewers opening every link the way a WhatsApp reader would.

     • the 🟢 button sits right beside 📱 Phone Remote
     • the links are the site's own routes for THIS match:
         tournament match  /score/tournament/<its token>/match/<its id>
         single match      /score/match/<its id>
         live scorecard    /cricket-scorecard?room=<Match ID>
         website           https://allsportslivestreams.com/
       plus the match's video link from Match Setup; the website confirms each
       one (it knows the match, the room shows it)
     • the card: 1080×1350 and 1080×1080 PNGs in every style; both QR codes
       decode (jsQR): WATCH LIVE → the video link (MATCH CENTRE → the match's
       page when there is no video), LIVE SCORECARD → the scorecard; the 16:9
       YouTube thumbnail (1280×720, no codes)
     • the message: the video, scorecard and website links — no "Follow the
       match" — nothing "undefined"; a removed link blocks
       sharing until put back; Open WhatsApp = wa.me with the edited message +
       the card downloaded (named Team-A-vs-Team-B-AllSportsLive-Match-Card.png)
       and says the image must be attached by hand; Share = the PNG file + the
       message; Copy
     • the card follows the match (venue edited in Match Setup, the start time)
     • before the match: a viewer of either link sees "This match hasn't
       started yet" (never the server's placeholder teams or an error), an
       upcoming fixture's link shows its teams and date, and the same page shows
       the scorecard by itself once the first ball is bowled
     • "Connect this match" from the share window; a room showing another match
       blocks sharing; an out-of-date website copy is brought up to date; a
       private tournament is refused with how to make it public
     • the YouTube title (≤ 100 characters) and description (the website match
       link, the Instagram profile link only when ticked — any profile), copied
     • Create New Match opens the share by itself (unless turned off)
     • phone width: one column, no sideways scroll

     npm install --no-save jsqr pngjs qrcodejs   (qrcodejs stands in for the CDN copy the panels load)
     NODE_PATH=$(npm root -g) node test/cricket/match-share-test.js
*/
const fs = require('fs');
const path = require('path');
const { bootServer, request } = require('../server-boot.js');
const { chromium } = require('playwright');
const jsQR = require('jsqr');
const { PNG } = require('pngjs');
const QRJS = fs.readFileSync(require.resolve('qrcodejs/qrcode.min.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, what, extra) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${what}${!c && extra != null ? '  :: ' + String(extra).slice(0, 300) : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const FIREBASE_STUB = `window.firebase = { initializeApp: function(){ return {}; }, auth: function(){ return { currentUser: null,
  onAuthStateChanged: function(cb){ setTimeout(function(){ cb(null); }, 0); return function(){}; }, signOut: function(){ return Promise.resolve(); } }; } };`;
const LOGO = (bg, fg, txt) => `(() => { const c = document.createElement('canvas'); c.width = c.height = 200; const x = c.getContext('2d'); x.fillStyle = '${bg}'; x.beginPath(); x.arc(100, 100, 96, 0, Math.PI * 2); x.fill(); x.fillStyle = '${fg}'; x.font = '900 64px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('${txt}', 100, 104); return c.toDataURL('image/png'); })()`;

// Every QR code on the card, left to right: find one, white it out, look again.
function decodeAll(buf){
  const png = PNG.sync.read(buf);
  const W = png.width, H = png.height, y0 = Math.round(H * 0.5), h = H - y0;
  const data = new Uint8ClampedArray(W * h * 4);
  for(let y = 0; y < h; y++) for(let x = 0; x < W; x++){ const si = ((y0 + y) * W + x) * 4, di = (y * W + x) * 4; data[di] = png.data[si]; data[di + 1] = png.data[si + 1]; data[di + 2] = png.data[si + 2]; data[di + 3] = 255; }
  const found = [];
  for(let n = 0; n < 3; n++){
    const r = jsQR(data, W, h);
    if(!r) break;
    const xs = [r.location.topLeftCorner.x, r.location.topRightCorner.x, r.location.bottomLeftCorner.x, r.location.bottomRightCorner.x];
    const ys = [r.location.topLeftCorner.y, r.location.topRightCorner.y, r.location.bottomLeftCorner.y, r.location.bottomRightCorner.y];
    found.push({ x: Math.min(...xs), text: r.data });
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 24), x1 = Math.min(W, Math.ceil(Math.max(...xs)) + 24);
    const yA = Math.max(0, Math.floor(Math.min(...ys)) - 24), yB = Math.min(h, Math.ceil(Math.max(...ys)) + 24);
    for(let y = yA; y < yB; y++) for(let x = x0; x < x1; x++){ const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 255; }
  }
  return { size: [W, H], codes: found.sort((a, b) => a.x - b.x).map(f => f.text) };
}

(async () => {
  const { port, mem } = await bootServer({ users: { owner: 'workallsportslive@gmail.com', priv: 'chhayajeeth@gmail.com' } });
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  async function newContext(opts){
    const c = await browser.newContext(Object.assign({ viewport: { width: 1440, height: 920 }, acceptDownloads: true }, opts || {}));
    await c.route('**/*', (r) => {
      const u = r.request().url();
      if(/cdnjs\.cloudflare\.com\/ajax\/libs\/qrcodejs/.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: QRJS });
      if(/gstatic\.com\/firebasejs\/.*firebase-app-compat/.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: FIREBASE_STUB });
      if(/fonts\.(googleapis|gstatic)\.com/.test(u) || u.startsWith(base)) return r.continue();
      return r.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    });
    return c;
  }
  async function panel(file, uid, setup){
    const c = await newContext();
    const p = await c.newPage();
    p.on('dialog', d => d.accept());
    p.__errors = [];
    p.on('pageerror', e => p.__errors.push(e.message));
    await p.goto(`${base}/${file}?uid=${uid}`);
    await p.waitForFunction(() => typeof state !== 'undefined' && document.getElementById('ms-share-btn') && typeof socket !== 'undefined', null, { timeout: 20000 });
    // (cricket-panel3 takes the room's state when it connects to a match with no ball
    //  bowled yet — its operators connect first, then set the match up; so do we there)
    const connectFirst = file === 'cricket-panel3';
    const doConnect = async () => { await p.click('#connect-btn'); await p.waitForFunction((r) => socket && socket.connected && String(socket.io.opts.query.uid) === r, setup.room, { timeout: 15000 }); await sleep(2200); };
    if(!connectFirst) await p.evaluate(setup.fn, setup.arg);
    if(setup.room){
      await p.fill('#match-id', setup.room);
      if(setup.connect) await doConnect();
    }
    if(connectFirst){ await p.evaluate(setup.fn, setup.arg); await sleep(setup.connect ? 2200 : 300); }
    p.__setup = setup;
    return p;
  }
  // "Connect this match" pressed in the share window; on cricket-panel3 the details are entered again after it
  async function connectFromShare(p, file){
    await p.click('[data-connect-now]');
    await p.waitForFunction((r) => socket && socket.connected && String(socket.io.opts.query.uid) === r, p.__setup.room, { timeout: 15000 });
    if(file === 'cricket-panel3'){ await sleep(1500); await p.evaluate(p.__setup.fn, p.__setup.arg); await sleep(1200); await p.evaluate(() => window.__matchShare.refresh()); }
  }
  async function share(p){
    await p.click('#ms-share-btn');
    await p.waitForFunction(() => { const m = window.__matchShare; const c = m && m.checks; return m && m.file && c && !['match', 'scorecard'].some(k => c[k] && c[k].level === 'wait'); }, null, { timeout: 25000 });
    await sleep(300);
    return p.evaluate(() => ({ links: window.__matchShare.links, checks: window.__matchShare.checks, blockers: window.__matchShare.blockers(), msg: document.getElementById('msx-msg').value, tmid: state.tournamentMatchId }));
  }
  const cardPng = async (p) => Buffer.from((await p.evaluate(() => document.getElementById('msx-card').toDataURL('image/png'))).split(',')[1], 'base64');
  async function viewer(url, waitFor){
    const c = await newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true });
    const v = await c.newPage();
    await v.goto(url);
    let txt = '';
    for(let i = 0; i < 40; i++){ await sleep(250); txt = await v.evaluate(() => document.body.innerText).catch(() => ''); if(waitFor && waitFor.test(txt)) break; }
    await c.close();
    return txt.replace(/\s+/g, ' ');
  }
  const missing = (text, l) => ['video', 'scorecard', 'website'].filter(k => (k !== 'video' || l.video) && !text.includes(l[k]));
  const tourSetup = (tour, room, names, extra, connect) => ({ room, connect: connect !== false, arg: { tour, names, extra: extra || {} }, fn: async ({ tour, names, extra }) => {
    state.matchMode = 'tournament'; state.leagueName = tour; state.matchLeague = tour;
    state.teamA.name = names[0]; state.teamA.short = names[2]; state.teamA.color = '#0b4ea2';
    state.teamB.name = names[1]; state.teamB.short = names[3]; state.teamB.color = '#c8102e';
    state.venue = 'Wankhede Stadium, Mumbai'; state.matchDate = '2026-11-14'; state.matchTime = '19:30'; state.format = 'T20'; state.matchNo = extra.no || 12; state.matchStage = extra.stage || 'semi';
    state.streamUrl = extra.video || '';
    saveLocal(); pushState(true); autoSyncMatchSnapshot();   // what an edit in Match Setup does
  } });

  for(const [file, tag] of [['cricket-panel', 'P1'], ['cricket-panel3', 'P3']]){
    console.log(`\n######## ${file} ########`);
    const TOUR = `Kanga League ${tag}`;
    const tr = await request(port, 'POST', `/api/league/${encodeURIComponent(TOUR)}/info?uid=owner`, { create: true, info: { season: '2026', shortName: 'KL' } });
    const TOKEN = tr.json && tr.json.token;
    ok(!!TOKEN, 'a public tournament on the real server');

    // ---- A. a tournament match, connected ----
    const VIDEO = 'https://www.youtube.com/watch?v=Kl8vT2xYq0A';
    const pa = await panel(file, 'owner', tourSetup(TOUR, `${tag}-M12`, ['Mumbai Indians', 'Royal Challengers Bengaluru', 'MI', 'RCB'], { video: VIDEO }));
    await pa.evaluate((l) => { state.teamA.logoUrl = eval(l[0]); state.teamB.logoUrl = eval(l[1]); saveLocal(); }, [LOGO('#0b4ea2', '#f5c451', 'MI'), LOGO('#111111', '#c8102e', 'RCB')]);
    ok(await pa.evaluate(() => { const b = document.getElementById('ms-share-btn'); return !!b.previousElementSibling && b.previousElementSibling.id === 'cr-remote-btn'; }), 'the WhatsApp Match Share button sits right beside Phone Remote');
    const A = await share(pa);
    ok(A.links.match === `${base}/score/tournament/${TOKEN}/match/${A.tmid}`, 'tournament match link = /score/tournament/<token>/match/<this match id>', A.links.match);
    ok(A.links.scorecard === `${base}/cricket-scorecard?room=${tag}-M12`, 'scorecard link = the live scorecard of this match\'s room', A.links.scorecard);
    ok(A.links.website === 'https://allsportslivestreams.com/', 'website link');
    ok(A.links.video === VIDEO && A.checks.video.level === 'ok', 'the video link = the one typed in Match Setup (a YouTube video)', A.links.video);
    ok(A.checks.match.level === 'ok' && A.checks.scorecard.level === 'ok' && A.checks.website.level === 'ok', 'the website confirms the match page, the scorecard and the website', JSON.stringify(A.checks));
    ok(A.checks.origin && A.checks.origin.level === 'warn', 'links on another host than allsportslivestreams.com are pointed out');
    ok(missing(A.msg, A.links).length === 0 && !/undefined|null|NaN/.test(A.msg), 'the message has the video, scorecard and website links and nothing "undefined"', A.msg);
    ok(A.msg.includes('▶️ *WATCH LIVE:*\n' + VIDEO), 'the message: ▶️ WATCH LIVE with the panel\'s video link', A.msg);
    ok(!/FOLLOW THE MATCH/i.test(A.msg) && !A.msg.includes(A.links.match), 'no "Follow the match" link in the message any more', A.msg);
    const dA = decodeAll(await cardPng(pa));
    ok(dA.size.join('x') === '1080x1350' && dA.codes[0] === VIDEO && dA.codes[1] === A.links.scorecard, 'portrait card 1080×1350: WATCH LIVE QR → the video link, Live Scorecard QR → scorecard link', JSON.stringify(dA));
    ok(/Mumbai Indians/i.test(await viewer(A.links.match, /Mumbai Indians/i)), 'a viewer of the match\'s own page (the YouTube description\'s link) lands on this match');
    ok(/Mumbai Indians/i.test(await viewer(dA.codes[1], /Mumbai Indians/i)), 'a viewer scanning the scorecard QR lands on its live scorecard');
    // every style and size: a 1080-wide PNG whose two codes still scan
    for(const size of ['portrait', 'square']) for(const theme of ['dark', 'light', 'team']){
      await pa.click(`.msx-seg[data-pref="size"] button[data-v="${size}"]`); await pa.click(`.msx-seg[data-pref="theme"] button[data-v="${theme}"]`);
      await sleep(1400);
      const d = decodeAll(await cardPng(pa));
      ok(d.size.join('x') === (size === 'square' ? '1080x1080' : '1080x1350') && d.codes[0] === VIDEO && d.codes[1] === A.links.scorecard, `${size} / ${theme}: ${d.size.join('×')}, both QR codes scan`, JSON.stringify(d));
    }
    // the YouTube thumbnail: 16:9, no codes on it
    await pa.click('.msx-seg[data-pref="size"] button[data-v="thumb"]'); await sleep(1600);
    const dT = decodeAll(await cardPng(pa));
    ok(dT.size.join('x') === '1280x720' && dT.codes.length === 0, 'YouTube thumbnail: 1280×720, no QR codes on it', JSON.stringify(dT));
    ok((await pa.evaluate(() => window.__matchShare.filename())) === 'Mumbai-Indians-vs-Royal-Challengers-Bengaluru-AllSportsLive-YouTube-Thumbnail.png', '…named Team-A-vs-Team-B-AllSportsLive-YouTube-Thumbnail.png');
    await pa.click('.msx-seg[data-pref="qr"] button[data-v="right"]'); await pa.click('.msx-seg[data-pref="size"] button[data-v="portrait"]'); await sleep(1400);
    const dR = decodeAll(await cardPng(pa));
    ok(dR.codes[0] === VIDEO && dR.codes[1] === A.links.scorecard, 'QR codes both on the right: still Watch Live then Live Scorecard, both scan', JSON.stringify(dR));
    await pa.click('.msx-seg[data-pref="qr"] button[data-v="split"]'); await pa.click('.msx-seg[data-pref="theme"] button[data-v="dark"]'); await sleep(900);
    ok(await pa.evaluate(() => JSON.parse(localStorage.getItem('asl-match-share-prefs')).theme === 'dark'), 'design choices are remembered');

    // ---- the message ----
    await pa.evaluate(() => { const t = document.getElementById('msx-msg'); t.value = t.value.replace(window.__matchShare.links.scorecard, ''); t.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(150);
    let st = await pa.evaluate(() => ({ b: window.__matchShare.blockers(), wa: document.getElementById('msx-wa').disabled, restore: !document.getElementById('msx-restore').hidden }));
    ok(st.wa && st.restore && st.b.some(x => /compulsory link/.test(x)), 'a removed compulsory link blocks sharing and offers to put it back', JSON.stringify(st));
    await pa.click('#msx-restore'); await sleep(150);
    ok((await pa.evaluate(() => window.__matchShare.blockers())).length === 0, 'Put the links back → sharing allowed again');
    await pa.evaluate(() => { const t = document.getElementById('msx-msg'); t.value = '🔥 BIG SEMI FINAL TONIGHT!\n\n' + t.value; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await pa.evaluate(() => { window.__opened = null; window.open = (u) => { window.__opened = u; return {}; }; });
    const [dl] = await Promise.all([pa.waitForEvent('download', { timeout: 8000 }), pa.click('#msx-wa')]);
    const opened = await pa.evaluate(() => window.__opened);
    const waText = opened && decodeURIComponent(opened.split('?text=')[1] || '');
    ok(/^https:\/\/wa\.me\/\?text=/.test(opened || '') && waText.startsWith('🔥 BIG SEMI FINAL TONIGHT!') && missing(waText, A.links).length === 0, 'Open WhatsApp: wa.me with the edited message and its links', opened);
    ok(dl.suggestedFilename() === 'Mumbai-Indians-vs-Royal-Challengers-Bengaluru-AllSportsLive-Match-Card.png', '…the card downloaded as Team-A-vs-Team-B-AllSportsLive-Match-Card.png', dl.suggestedFilename());
    const dlFile = path.join(require('os').tmpdir(), `ms-${tag}-${Date.now()}.png`); await dl.saveAs(dlFile);
    const dd = decodeAll(fs.readFileSync(dlFile)); fs.unlinkSync(dlFile);
    ok(dd.size.join('x') === '1080x1350' && dd.codes[0] === VIDEO && dd.codes[1] === A.links.scorecard, '…the downloaded PNG is the preview: 1080×1350, both QR codes scan', JSON.stringify(dd));
    ok(/attach it in WhatsApp/.test(await pa.evaluate(() => document.getElementById('msx-done').textContent)), '…and it says the image has to be attached by hand');
    await pa.evaluate(() => { window.__shared = null; navigator.canShare = (d) => !!(d && d.files && d.files.length); navigator.share = async (d) => { window.__shared = { files: d.files.map(f => ({ name: f.name, type: f.type, size: f.size })), text: d.text }; }; window.__matchShare.refresh(); });
    await pa.waitForFunction(() => !document.getElementById('msx-share').disabled, null, { timeout: 8000 }).catch(() => {});
    await pa.click('#msx-share'); await sleep(300);
    const shared = await pa.evaluate(() => window.__shared);
    ok(shared && shared.files.length === 1 && shared.files[0].type === 'image/png' && shared.files[0].size > 50000 && missing(shared.text, A.links).length === 0, 'Share image + message: the PNG card as a file + the message with its links', JSON.stringify(shared && shared.files));
    await pa.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await pa.click('#msx-copy'); await sleep(200);
    ok(missing(await pa.evaluate(() => navigator.clipboard.readText()), A.links).length === 0, 'Copy message: its links');

    // ---- the YouTube title + description ----
    await pa.click('.msx-seg[data-pref="tab"] button[data-v="yt"]'); await sleep(200);
    let yt = await pa.evaluate(() => ({ pane: getComputedStyle(document.querySelector('.msx-pane[data-pane="yt"]')).display, wa: getComputedStyle(document.querySelector('.msx-pane[data-pane="wa"]')).display,
      t: document.getElementById('msx-yt-title').value, d: document.getElementById('msx-yt-desc').value, count: document.getElementById('msx-yt-count').textContent }));
    ok(yt.pane === 'block' && yt.wa === 'none', 'the YouTube tab: its own pane beside the WhatsApp message', JSON.stringify(yt).slice(0, 120));
    ok(yt.t.length <= 100 && /Mumbai Indians vs Royal Challengers Bengaluru/.test(yt.t) && /Kanga League/.test(yt.t) && yt.count === `${yt.t.length}/100`, 'title: both teams and the tournament, within YouTube\'s 100 characters (counted)', yt.t);
    ok(yt.d.includes(A.links.match) && yt.d.includes('https://allsportslivestreams.com/') && /Wankhede Stadium/.test(yt.d) && /#Cricket/.test(yt.d) && !/undefined|null/.test(yt.d), 'description: the match details, the website match link, the website and hashtags', yt.d);
    ok(!/instagram/i.test(yt.d), '…no Instagram link until it is ticked');
    await pa.click('[data-pref-tg="insta"]'); await sleep(1200);
    yt = await pa.evaluate(() => ({ d: document.getElementById('msx-yt-desc').value, f: !document.getElementById('msx-yt-insta').hidden }));
    ok(yt.f && yt.d.includes('📸 Instagram: https://www.instagram.com/all.sports.live/'), 'Instagram ticked → the AllSportsLive profile link in the description, and a field to change it', yt.d);
    await pa.fill('#msx-yt-insta', 'https://www.instagram.com/kanga.league/'); await sleep(300);
    yt = await pa.evaluate(() => ({ d: document.getElementById('msx-yt-desc').value, p: JSON.parse(localStorage.getItem('asl-match-share-prefs')).instaUrl }));
    ok(yt.d.includes('📸 Instagram: https://www.instagram.com/kanga.league/') && yt.p === 'https://www.instagram.com/kanga.league/', 'any profile link typed there goes in instead (and is remembered)', yt.d);
    await pa.fill('#msx-yt-insta', 'not a link'); await sleep(300);
    yt = await pa.evaluate(() => ({ d: document.getElementById('msx-yt-desc').value, note: document.getElementById('msx-yt-note').textContent }));
    ok(!/📸 Instagram/.test(yt.d) && /not an Instagram profile link/.test(yt.note), 'a line that is not an Instagram link is left out, and said so', yt.note);
    await pa.fill('#msx-yt-insta', 'https://www.instagram.com/all.sports.live/'); await pa.click('[data-pref-tg="insta"]'); await sleep(800);
    await pa.click('#msx-yt-copy-title'); await sleep(150);
    ok((await pa.evaluate(() => navigator.clipboard.readText())) === (await pa.evaluate(() => document.getElementById('msx-yt-title').value.trim())), 'Copy title');
    await pa.click('#msx-yt-copy-desc'); await sleep(150);
    ok((await pa.evaluate(() => navigator.clipboard.readText())).includes(A.links.match), 'Copy description: with the website match link');
    const [tdl] = await Promise.all([pa.waitForEvent('download', { timeout: 10000 }), pa.click('#msx-yt-thumb')]);
    ok(/YouTube-Thumbnail\.png$/.test(tdl.suggestedFilename()), '🖼 YouTube thumbnail: the 16:9 card is drawn and downloaded', tdl.suggestedFilename());
    const tFile = path.join(require('os').tmpdir(), `ms-t-${tag}-${Date.now()}.png`); await tdl.saveAs(tFile);
    const tt = decodeAll(fs.readFileSync(tFile)); fs.unlinkSync(tFile);
    ok(tt.size.join('x') === '1280x720', '…1280×720', JSON.stringify(tt.size));
    await pa.click('.msx-seg[data-pref="size"] button[data-v="portrait"]'); await pa.click('.msx-seg[data-pref="tab"] button[data-v="wa"]'); await sleep(1200);

    // ---- the card follows the match ----
    await pa.click('#msx-reset');
    await pa.evaluate(() => { const v = document.getElementById('venue'); v.value = 'Brabourne Stadium, Mumbai'; v.dispatchEvent(new Event('input', { bubbles: true })); v.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(2200);
    st = await pa.evaluate(() => ({ info: window.__matchShare.info.venue, msg: document.getElementById('msx-msg').value }));
    ok(st.info === 'Brabourne Stadium, Mumbai' && /Brabourne Stadium/.test(st.msg), 'venue edited in Match Setup → the card and the message follow', st.info);
    await pa.fill('#msx-time', '20:00'); await pa.dispatchEvent('#msx-time', 'change'); await sleep(1500);
    st = await pa.evaluate(() => ({ t: state.matchTime, msg: document.getElementById('msx-msg').value }));
    ok(st.t === '20:00' && /⏰ Time: 8:00 PM/.test(st.msg), 'the start time is entered once, kept with the match, and shown', st.t);

    // ---- B. a single match, connected ----
    const pb = await panel(file, 'owner', { room: `${tag}-S77`, connect: true, arg: null, fn: async () => {
      state.matchMode = 'single'; state.leagueName = ''; state.matchLeague = '';
      state.teamA.name = 'Parel SC'; state.teamA.short = 'PSC'; state.teamB.name = 'Young Comrade CC'; state.teamB.short = 'YCC';
      state.venue = 'Police Gymkhana'; state.matchDate = '2026-11-21'; state.matchTime = ''; state.format = 'ODI'; saveLocal(); pushState(true); autoSyncMatchSnapshot();
    } });
    const B = await share(pb);
    ok(B.links.match === `${base}/score/match/${B.tmid}`, 'single match link = /score/match/<this match id>', B.links.match);
    ok(B.checks.match.level === 'ok' && B.checks.scorecard.level === 'ok', 'the website confirms both', JSON.stringify(B.checks));
    ok(!/TOURNAMENT/.test(B.msg) && !/⏰/.test(B.msg), 'no tournament and no start time: those lines are left out, never "undefined"', B.msg);
    ok(!B.links.video && !/WATCH LIVE/.test(B.msg) && B.blockers.length === 0, 'no video link yet: no WATCH LIVE line, and sharing is not held back for it', B.msg);
    const dB = decodeAll(await cardPng(pb));
    ok(dB.codes[0] === B.links.match && dB.codes[1] === B.links.scorecard, '…the card\'s first code is then the MATCH CENTRE (the match\'s own page)', JSON.stringify(dB));
    ok(/Parel SC/i.test(await viewer(B.links.match, /Parel SC/i)), 'a viewer of the single match link lands on this match');

    // ---- C. a tournament match before Connect ----
    const pc = await panel(file, 'owner', tourSetup(TOUR, `${tag}-M13`, ['Delhi Capitals', 'Gujarat Titans', 'DC', 'GT'], { no: 13, stage: 'final' }, false));
    const C = await share(pc);
    ok(C.checks.match.level === 'warn' && C.checks.scorecard.level === 'warn' && C.blockers.length === 0, 'before Connect: both links "once it is live", sharing still allowed', JSON.stringify(C.checks));
    const vC1 = await viewer(C.links.match, /hasn't started|Could not/i);
    ok(/hasn't started yet/.test(vC1) && !/Could not load/.test(vC1), 'a viewer of the match link before the match: "This match hasn\'t started yet"', vC1.slice(0, 200));
    const vC2 = await viewer(C.links.scorecard, /hasn't started|India/i);
    ok(/hasn't started yet/.test(vC2) && !/India|Australia/.test(vC2), 'a viewer of the scorecard link before the match: the same, no placeholder teams', vC2.slice(0, 200));
    await connectFromShare(pc, file);
    await pc.waitForFunction(() => { const c = window.__matchShare.checks; return c && c.match && c.scorecard && c.match.level === 'ok' && c.scorecard.level === 'ok'; }, null, { timeout: 20000 }).catch(() => {});
    ok(await pc.evaluate(() => { const c = window.__matchShare.checks; return c.match.level === 'ok' && c.scorecard.level === 'ok' && /Delhi Capitals/.test(c.scorecard.text); }), '"Connect this match" from the share window → both links confirmed, showing this match');
    // an upcoming fixture of the tournament
    await request(port, 'POST', `/api/league/${encodeURIComponent(TOUR)}/match?uid=owner`, { matchId: `fx-${tag}`, upcoming: true, scheduledDate: '2026-11-28', teamA: { name: 'Chennai Super Kings', short: 'CSK' }, teamB: { name: 'Kolkata Knight Riders', short: 'KKR' }, format: 'T20' });
    const vF = await viewer(`${base}/score/tournament/${TOKEN}/match/fx-${tag}`, /hasn't started|Completed|Could/i);
    ok(/hasn't started yet/.test(vF) && /Chennai Super Kings vs Kolkata Knight Riders/.test(vF) && /28/.test(vF), 'an upcoming fixture\'s link: waiting card with its teams and date', vF.slice(0, 200));

    // ---- C2. a single match set up but not started → the scorecard by itself once a ball is bowled ----
    const pg = await panel(file, 'owner', { room: `${tag}-S88`, connect: false, arg: null, fn: async () => {
      state.matchMode = 'single'; state.leagueName = ''; state.matchLeague = '';
      state.teamA.name = 'Shivaji Park Gymkhana'; state.teamA.short = 'SPG'; state.teamB.name = 'Dadar Union'; state.teamB.short = 'DU'; saveLocal();   // (not synced: the website's copy is out of date)
    } });
    const G = await share(pg);
    ok(G.checks.match.level === 'ok' && /Shivaji Park Gymkhana/.test(G.checks.match.text), 'an out-of-date copy on the website is brought up to date by itself, then confirmed', JSON.stringify(G.checks.match));
    const vc = await newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true });
    const vg = await vc.newPage(); await vg.goto(G.links.match);
    await vg.waitForFunction(() => /hasn't started yet/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    ok(/hasn't started yet.*Shivaji Park Gymkhana vs Dadar Union/.test(await vg.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))), 'a viewer sees "This match hasn\'t started yet" with the teams');
    await connectFromShare(pg, file);
    await sleep(1500);
    await pg.evaluate(() => { document.querySelector('[data-ball="4"]').click(); });
    await sleep(400);
    await pg.evaluate(() => { const s = document.getElementById('ww-skip'); const o = document.getElementById('ww-overlay'); if(s && o && o.classList.contains('show')) s.click(); });
    await vg.waitForFunction(() => !/hasn't started yet/.test(document.body.innerText) && /Shivaji Park/i.test(document.body.innerText), null, { timeout: 50000 }).catch(() => {});
    const g1 = await vg.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    ok(!/hasn't started yet/.test(g1) && /Shivaji Park/i.test(g1), '…and once the first ball is bowled the same page shows the scorecard by itself', g1.slice(0, 200));
    await vc.close();

    // ---- D. the room shows another match ----
    await pc.fill('#match-id', `${tag}-M12`); await pc.evaluate(() => document.getElementById('msx-recheck').click());
    await pc.waitForFunction(() => { const c = window.__matchShare.checks; return c && c.scorecard && c.scorecard.level === 'bad'; }, null, { timeout: 15000 }).catch(() => {});
    const D = await pc.evaluate(() => ({ c: window.__matchShare.checks, b: window.__matchShare.blockers(), wa: document.getElementById('msx-wa').disabled }));
    ok(D.c.scorecard.level === 'bad' && D.wa && D.b.some(x => /another match/.test(x)), 'a Match ID whose room shows another match → sharing blocked, "press Connect"', JSON.stringify(D.c.scorecard));

    // ---- E. a private tournament ----
    const SECRET = `Secret Cup ${tag}`;
    await request(port, 'POST', `/api/league/${encodeURIComponent(SECRET)}/info?uid=priv`, { create: true, info: {} });
    const pe = await panel(file, 'priv', { room: `${tag}-SEC`, connect: true, arg: SECRET, fn: async (t) => {
      state.matchMode = 'tournament'; state.leagueName = t; state.matchLeague = t; state.teamA.name = 'Alpha XI'; state.teamB.name = 'Beta XI'; saveLocal(); pushState(true);
    } });
    const E = await share(pe);
    ok(E.checks.match.level === 'bad' && /private/.test(E.checks.match.text) && /public/.test(E.checks.match.fix || ''), 'a private tournament: its match page refused, with how to make it public', JSON.stringify(E.checks.match));
    ok(!E.blockers.some(x => /private/.test(x)), '…the WhatsApp message does not carry that page, so it is not held back by it', JSON.stringify(E.blockers));
    const eYt = await pe.evaluate(() => ({ d: document.getElementById('msx-yt-desc').value, note: document.getElementById('msx-yt-note').textContent }));
    ok(!eYt.d.includes(E.links.match) && eYt.d.includes(E.links.scorecard) && /private/.test(eYt.note), '…and the YouTube description uses the live scorecard instead, saying why', eYt.note);

    // ---- E2. Create New Match opens the share by itself ----
    await pb.evaluate(() => window.__matchShare.close());
    // (the button sits in Match Type, folded away here: pressed the way a click does it)
    await pb.evaluate(() => document.getElementById('new-match-btn').click()); await sleep(400);
    await pb.evaluate(() => document.getElementById('newmatch-start').click());
    await pb.waitForFunction(() => window.__matchShare.isOpen, null, { timeout: 8000 }).catch(() => {});
    ok(await pb.evaluate(() => window.__matchShare.isOpen && document.getElementById('msx').classList.contains('show')), 'Create New Match → the share opens by itself, card and messages ready');
    await pb.evaluate(() => window.__matchShare.close());
    await pb.click('[data-pref-tg="autoOpen"]').catch(() => {});
    await pb.evaluate(() => { const i = document.querySelector('[data-pref-tg="autoOpen"]'); if(i && i.checked){ i.checked = false; i.dispatchEvent(new Event('change', { bubbles: true })); } });
    ok(await pb.evaluate(() => window.__matchShare.afterNewMatch() === false && !window.__matchShare.isOpen), '…unless "Open after Create New Match" is turned off');

    // ---- F. phone width ----
    await pa.setViewportSize({ width: 390, height: 844 }); await sleep(900);
    const lay = await pa.evaluate(() => { const ov = document.querySelector('.msx'), sh = document.querySelector('.msx-sheet'); return { overflowX: ov.scrollWidth > innerWidth + 1 || sh.scrollWidth > sh.clientWidth + 1, foot: getComputedStyle(document.querySelector('.msx-foot')).position, previewW: Math.round(document.getElementById('msx-card').getBoundingClientRect().width) }; });
    ok(!lay.overflowX && lay.foot === 'sticky' && lay.previewW >= 340, 'phone width: one column, no sideways scroll, the card fills the width, actions stay at hand', JSON.stringify(lay));

    const errs = [pa, pb, pc, pg, pe].flatMap(p => p.__errors);
    ok(errs.length === 0, 'no page errors in the panel', errs.slice(0, 3).join(' | '));
    for(const p of [pa, pb, pc, pg, pe]) await p.context().close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e && e.stack ? e.stack.slice(0, 900) : e); process.exit(1); });
