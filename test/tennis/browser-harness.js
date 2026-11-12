// The tennis browser suites' shared pieces: the REAL server.js (in-memory
// MongoDB, Firebase ID tokens mapped to test accounts), Chromium through
// the pre-installed Playwright, a stand-in for the browser's Firebase SDK
// (window.__fakeUser decides who is signed in), and seeding through the
// real API — players, a tournament, an event, matches.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { bootServer } = require('../server-boot.js');

const U = { work: { uid: 'u-work', email: 'workallsportslive@gmail.com' }, owner: { uid: 'u-owner', email: 'chhayajeeth@gmail.com' } };
const OUT = path.join(__dirname, '..', 'out', 'tennis');
fs.mkdirSync(OUT, { recursive: true });

const FAKE_FIREBASE = `(function(){
  if (window.firebase) return;
  var u = window.__fakeUser || null;
  var cur = u ? { email: u.email, uid: u.uid, getIdToken: function(){ return Promise.resolve(u.token); } } : null;
  var authObj = {
    currentUser: cur,
    onAuthStateChanged: function(cb){ setTimeout(function(){ cb(cur); }, 0); return function(){}; },
    onIdTokenChanged: function(cb){ setTimeout(function(){ cb(cur); }, 0); return function(){}; },
    signInWithPopup: function(){ window.__signInClicked = true; return Promise.reject({ code: 'auth/popup-closed-by-user' }); },
    signInWithRedirect: function(){ return Promise.resolve(); },
    getRedirectResult: function(){ return Promise.resolve({ user: null }); },
    signOut: function(){ return Promise.resolve(); }
  };
  var auth = function(){ return authObj; };
  auth.GoogleAuthProvider = function(){ this.setCustomParameters = function(){}; this.addScope = function(){}; };
  window.firebase = { apps: [], initializeApp: function(){ window.firebase.apps.push({}); return {}; }, auth: auth };
})();`;

function call(port, method, url, { json, token } = {}) {
  return new Promise((resolve, reject) => {
    const body = json ? Buffer.from(JSON.stringify(json)) : null;
    const h = Object.assign({}, json ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}, token ? { Authorization: 'Bearer ' + token } : {});
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let j = null; try { j = JSON.parse(buf.toString()); } catch (e) {} resolve({ status: res.statusCode, json: j, buf }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
function photo(hex) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-ph-'));
  const f = path.join(dir, 'p.jpg');
  // a portrait-ish picture: a coloured gradient with a lighter "face" disc
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${hex}:s=240x240`, '-vf', "geq=r='r(X,Y)*0.6+90*exp(-((X-120)^2+(Y-95)^2)/1800)':g='g(X,Y)*0.6+80*exp(-((X-120)^2+(Y-95)^2)/1800)':b='b(X,Y)*0.6+70*exp(-((X-120)^2+(Y-95)^2)/1800)'", '-frames:v', '1', f]);
  return 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');
}

async function start(opts) {
  opts = opts || {};
  const idTokens = {}, users = {};
  Object.keys(U).forEach((k) => { idTokens['tok-' + k] = Object.assign({ email_verified: true }, U[k]); users[U[k].uid] = U[k].email; });
  const { port, mem } = await bootServer({ idTokens, users });
  const base = `http://127.0.0.1:${port}`;
  const api = (m, u, o) => call(port, m, u, Object.assign({ token: 'tok-work' }, o || {}));
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const pageErrors = [];
  async function open(url, o) {
    o = o || {};
    const ctx = await browser.newContext({ viewport: o.viewport || { width: 1440, height: 900 }, deviceScaleFactor: o.scale || 1, colorScheme: o.scheme || 'dark', isMobile: !!o.mobile, hasTouch: !!o.mobile });
    const page = await ctx.newPage();
    const who = o.who === undefined ? 'work' : o.who;
    await page.addInitScript(([user, extra]) => {
      window.__fakeUser = user;
      try { Object.keys(extra || {}).forEach((k) => localStorage.setItem(k, extra[k])); } catch (e) { /* first load */ }
    }, [who ? { email: U[who].email, uid: U[who].uid, token: 'tok-' + who } : null, o.init || {}]);
    await page.route('https://www.gstatic.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_FIREBASE }));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await page.route('http://localhost:5009/**', (r) => (o.helper ? r.continue({ url: r.request().url().replace('localhost:5009', '127.0.0.1:' + o.helper) }) : r.abort()));
    page.on('pageerror', (e) => pageErrors.push(url.split('?')[0] + ': ' + String(e && e.stack || e)));
    await page.goto(base + url);
    return page;
  }
  const shot = (page, name, o) => page.screenshot(Object.assign({ path: path.join(OUT, name + '.png') }, o || {}));
  async function seed(spec) {
    spec = spec || {};
    const mk = async (name, extra) => (await api('POST', '/api/tennis/players', { json: Object.assign({ name, force: true }, extra || {}) })).json.player;
    const P = {
      a: await mk(spec.a || 'Carlos Alcaraz', { country: 'ESP', color: '#c2410c', ranking: { value: 2, label: 'ATP' }, photo: spec.photos === false ? undefined : photo('0xc2410c') }),
      b: await mk(spec.b || 'Jannik Sinner', { country: 'ITA', color: '#0f766e', ranking: { value: 1, label: 'ATP' }, photo: spec.photos === false ? undefined : photo('0x0f766e') }),
      c: await mk('Novak Djokovic', { country: 'SRB', color: '#1d4ed8' }),
      d: await mk('Alexander Zverev', { country: 'GER', color: '#7c3aed' })
    };
    const t = (await api('POST', '/api/tennis/tournaments', { json: { name: spec.tournament || 'Pune Open 2026', venue: 'Deccan Gymkhana', city: 'Pune', surface: spec.surface || 'hard', visibility: 'public', courts: ['Centre Court', 'Court 1'] } })).json.tournament;
    const m = (await api('POST', `/api/tennis/tournaments/${t.tournamentId}/matches`, { json: { format: 'singles', sideA: { playerIds: [P.a.playerId], seed: 2 }, sideB: { playerIds: [P.b.playerId], seed: 1 }, court: 'Centre Court', surface: spec.surface || 'hard', stage: { type: 'knockout', round: 'Final' }, rules: spec.rules || { bestOf: 3 }, officials: { umpire: 'Mohamed Lahyani' } } })).json.match;
    const dm = (await api('POST', `/api/tennis/tournaments/${t.tournamentId}/matches`, { json: { format: 'doubles', sideA: { playerIds: [P.a.playerId, P.c.playerId] }, sideB: { playerIds: [P.b.playerId, P.d.playerId] }, court: 'Court 1', rules: { bestOf: 3, noAd: true, finalSet: 'matchTiebreak' } } })).json.match;
    return { P, t, m, dm };
  }
  return { port, mem, base, api, browser, open, shot, seed, pageErrors, OUT, U };
}

module.exports = { start, call, OUT, U, FAKE_FIREBASE };
