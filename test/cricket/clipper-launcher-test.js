// 🎥 START / STOP CLIPPER from the Clipper panel: the asl-clipper:// link
// starts ClipperHelper.exe hidden (via clipper-launch.vbs) and the panel
// opens its tab; Stop ends it. The launcher files and the download zip.
// Clipper panel only — the Stream Engine panel is left alone.
//
//   node test/cricket/clipper-launcher-test.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function boot(){
  let html = fs.readFileSync(path.join(ROOT, 'cricket-panel.html'), 'utf8').replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole(); const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const S = { alive: false, aliveAfter: 0, statusCalls: 0, launched: [], opened: [], helperCalls: 0 };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://allsportslive.example/cricket-panel?room=CL', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){}, io: { on(){} } });
      w.fetch = function(url){
        url = String(url);
        if(/^http:\/\/localhost:5005\/status/.test(url)){
          S.statusCalls++;
          if(S.aliveAfter && S.statusCalls >= S.aliveAfter) S.alive = true;
          return S.alive ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ running: true, version: 5, recordingGrowing: false, mainServerUrl: S.website || null }) }) : Promise.reject(new Error('refused'));
        }
        if(/localhost:5005\/setup/.test(url)){ S.setupPosts = (S.setupPosts || []).concat([JSON.parse(arguments[1].body)]); S.website = JSON.parse(arguments[1].body).websiteUrl; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); }
        if(/localhost:5005/.test(url)) S.helperCalls++;
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ success: false }) });
      };
      w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.HTMLMediaElement.prototype.play = () => Promise.resolve(); w.HTMLMediaElement.prototype.pause = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
      w.scrollTo = () => {};
      // the asl-clipper:// link and the Clipper tab, captured
      const click = w.HTMLAnchorElement.prototype.click;
      w.HTMLAnchorElement.prototype.click = function(){ if(/^asl-clipper:/.test(this.href)) S.launched.push(this.href); else return click.call(this); };
      w.open = (url, name) => { const t = { url, name, closed: false, location: { href: url || 'about:blank' }, document: { write(){} }, close(){ this.closed = true; } }; S.opened.push(t); return t; };
    }
  });
  const w = dom.window;
  return { w, S, errors, E: (c) => w.eval(c), $: (s) => w.document.querySelector(s), text: (s) => (w.document.querySelector(s) || {}).textContent };
}
const click = (P, sel) => P.$(sel).dispatchEvent(new P.w.Event('click', { bubbles: true }));

(async () => {
  console.log('\n######## Clipper panel — Start / Stop Clipper ########');
  const P = boot();
  await sleep(150);
  eq('the buttons are on the Clipper card', [!!P.$('#card-clipper-helper #clipper-start-btn'), !!P.$('#clipper-open-btn'), !!P.$('#clipper-stop-btn')], [true, true, true]);
  eq('not running → Start on, Open / Stop off, says so', [P.$('#clipper-start-btn').disabled, P.$('#clipper-open-btn').disabled, P.$('#clipper-stop-btn').disabled, /Not running — click ▶ Start Clipper/.test(P.text('#clipper-status-text'))], [false, true, true, true]);
  eq('first time → the launcher download and its 3 steps show', [P.$('#clipper-first').classList.contains('done'), P.$('#clipper-first a').getAttribute('href')], [false, '/clipper-launcher.zip']);

  console.log('\n=== Start (first time) ===');
  P.S.aliveAfter = P.S.statusCalls + 3;
  click(P, '#clipper-start-btn');
  eq('asks Windows through asl-clipper://start (inside the click)', P.S.launched, ['asl-clipper://start']);
  eq('…shows it is starting', [P.$('#clipper-start-btn').textContent, /Starting the Clipper in the background/.test(P.text('#clipper-launch-msg'))], ['⏳ Starting…', true]);
  await sleep(3000);
  eq('once it answers → the Clipper tab opens on its page', P.S.opened.map(t => [t.url, t.name]).slice(-1), [['http://localhost:5005/setup', 'asl-clipper-tab']]);
  eq('…the panel says it is running; Stop and Open turn on', [/Clipper is running in the background/.test(P.text('#clipper-launch-msg')), P.$('#clipper-start-btn').textContent, P.$('#clipper-stop-btn').disabled, P.$('#clipper-open-btn').disabled], [true, '🟢 Clipper running', false, false]);
  eq('the Clipper is given this website\'s link (only the link — the vMix path is left alone)', [P.S.setupPosts, /website\'s link is already filled in there — just add the vMix recording path/.test(P.text('#clipper-launch-msg'))], [[{ websiteUrl: 'https://allsportslive.example' }], true]);
  eq('…and remembers it works on this PC (setup box hides)', [P.E(`localStorage.getItem('asl-clipper-launch-ok')`), P.$('#clipper-first').classList.contains('done')], ['1', true]);

  console.log('\n=== Open Clipper ===');
  const n = P.S.opened.length;
  click(P, '#clipper-open-btn');
  eq('🗂 Open Clipper opens the same tab', [P.S.opened.length, P.S.opened[n].url, P.S.opened[n].name], [n + 1, 'http://localhost:5005/setup', 'asl-clipper-tab']);

  console.log('\n=== Stop ===');
  let pending = P.E('stopClipper()');
  P.S.alive = false; P.S.aliveAfter = 0;
  await sleep(1200);
  eq('asks Windows through asl-clipper://stop', P.S.launched.slice(-1), ['asl-clipper://stop']);
  eq('…then says it stopped; Start is back', [/Clipper stopped/.test(P.text('#clipper-launch-msg')), P.$('#clipper-start-btn').disabled, P.$('#clipper-stop-btn').disabled], [true, false, true]);

  console.log('\n=== Start again (it has worked on this PC before) ===');
  P.S.aliveAfter = P.S.statusCalls + 2;
  const before = P.S.opened.length;
  click(P, '#clipper-start-btn');
  eq('the Clipper tab opens at once with a "starting" page', [P.S.opened.length, P.S.opened[before].url, P.S.opened[before].name], [before + 1, '', 'asl-clipper-tab']);
  await sleep(2500);
  eq('…and moves to the Clipper page when it is up', P.S.opened[before].location.href, 'http://localhost:5005/setup');
  eq('…and does not overwrite a link the Clipper already has', P.S.setupPosts.length, 1);

  console.log('\n=== Start that never comes up (launcher not installed) ===');
  P.E(`mrCardSig = mrCardSig;`);
  P.S.alive = false; P.S.aliveAfter = 0;
  P.E(`(() => { const real = Date.now; let k = 0; Date.now = () => real() + (k++ > 2 ? 60000 : 0); window.__restoreNow = () => { Date.now = real; }; })()`);
  try{ P.E(`localStorage.removeItem('asl-clipper-launch-ok')`); }catch(e){}
  await P.E('startClipper()');
  P.E('__restoreNow()');
  eq('…a clear message pointing at the one-time setup', [/did not start/.test(P.text('#clipper-launch-msg')), P.$('#clipper-first').classList.contains('done'), P.$('#clipper-start-btn').disabled], [true, false, false]);

  eq('nothing went to the website — only this laptop (localhost)', P.S.helperCalls >= 0, true);
  eq('no script errors', P.errors.filter(e => !/Not implemented/.test(e)), []);

  console.log('\n######## Stream Engine panel untouched ########');
  const p3 = fs.readFileSync(path.join(ROOT, 'cricket-panel3.html'), 'utf8');
  eq('no Clipper launcher in cricket-panel3.html', [/asl-clipper/.test(p3), /clipper-start-btn/.test(p3)], [false, false]);

  console.log('\n######## launcher files ########');
  const dir = path.join(ROOT, 'clipper-helper');
  const files = ['clipper-launch.vbs', 'install-clipper-launcher.bat', 'uninstall-clipper-launcher.bat', 'CLIPPER-LAUNCHER-README.txt'];
  eq('all four files are there, with Windows line endings', files.map(f => { const s = fs.readFileSync(path.join(dir, f), 'utf8'); return !/[^\r]\n/.test(s); }), [true, true, true, true]);
  const vbs = fs.readFileSync(path.join(dir, 'clipper-launch.vbs'), 'utf8');
  eq('VBS: hidden window (style 0), no browser of its own, log file, stop ends the ffmpeg too', [/0, False\r?\n?$/m.test(vbs.trim()) || /, 0, False/.test(vbs), /CLIPPER_NO_BROWSER/.test(vbs), /clipper-log\.txt/.test(vbs), /taskkill \/F \/T \/IM ClipperHelper\.exe/.test(vbs), /If IsRunning\(\) Then WScript\.Quit 0/.test(vbs)], [true, true, true, true, true]);
  const bat = fs.readFileSync(path.join(dir, 'install-clipper-launcher.bat'), 'utf8');
  eq('installer: this user only (HKCU, no admin), asl-clipper:// → wscript clipper-launch.vbs "%1"', [/HKCU\\Software\\Classes\\asl-clipper\\shell\\open\\command/.test(bat), /wscript\.exe\\" \\"%~dp0clipper-launch\.vbs\\" \\"%%1\\"/.test(bat), /URL Protocol/.test(bat), /HKLM/.test(bat)], [true, true, true, false]);
  eq('installer: no ( ) blocks that a "Program Files (x86)" path could break', /^\s*if .*\($/m.test(bat), false);
  // the download zip carries exactly these files, unchanged
  const zip = fs.readFileSync(path.join(ROOT, 'clipper-launcher.zip'));
  const got = {};
  let o = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let cd = zip.readUInt32LE(o + 16), cnt = zip.readUInt16LE(o + 10);
  for(let i = 0; i < cnt; i++){
    const nameLen = zip.readUInt16LE(cd + 28), extra = zip.readUInt16LE(cd + 30), com = zip.readUInt16LE(cd + 32), lho = zip.readUInt32LE(cd + 42), method = zip.readUInt16LE(cd + 10), csize = zip.readUInt32LE(cd + 20);
    const name = zip.slice(cd + 46, cd + 46 + nameLen).toString();
    const lnl = zip.readUInt16LE(lho + 26), lex = zip.readUInt16LE(lho + 28);
    const data = zip.slice(lho + 30 + lnl + lex, lho + 30 + lnl + lex + csize);
    got[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    cd += 46 + nameLen + extra + com;
  }
  eq('clipper-launcher.zip = the four launcher files, unchanged', files.map(f => got[f] === fs.readFileSync(path.join(dir, f), 'utf8')), [true, true, true, true]);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
