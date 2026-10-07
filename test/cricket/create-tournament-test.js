// 🏆 Create Tournament — run against BOTH real panels (cricket-panel.html =
// Clipper, cricket-panel3.html = Stream Engine) in jsdom, plus the real
// server route/helpers and the website pieces that show it:
//   • ＋ Create Tournament button + modal (name, logo, dates, venue, format,
//     teams, live preview, checklist) with field-by-field validation
//   • Create → POST /api/league/:name/info, tournament selected, summary card
//   • 409 (already exists) keeps the modal open and says so
//   • "+ New Tournament…" in the dropdown opens the same modal
//   • a fixture scheduled in it starts from the tournament's format/venue
//   • server: info cleaned + saved, public link minted at once, caches dropped
//   • index card chips + tournament page hero + quiet auto-refresh
//
//   node test/cricket/create-tournament-test.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const H = require('./server-harness');

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function fakeServer(){
  const srv = { leagues: {}, infoPosts: [], records: [] };
  srv.fetch = (url, opts) => {
    url = String(url);
    const method = (opts && opts.method) || 'GET';
    let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch(e) {}
    const json = (o, status) => Promise.resolve({ ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
    let m;
    if(/\/api\/teams(\?|$)/.test(url) && method === 'GET') return json({ success: true, teams: [{ teamId: 't_dyp', name: 'D Y Patil', short: 'DYP', color: '#0ea5e9', logoUrl: '', players: [] }] });
    if((m = /\/api\/league\/([^/?]+)\/info/.exec(url)) && method === 'POST'){
      const name = decodeURIComponent(m[1]);
      srv.infoPosts.push({ name, body, url });
      const k = name.toLowerCase();
      if(body.create && srv.leagues[k]) return json({ success: false, code: 'TOURNAMENT_EXISTS', error: `"${name}" already exists — pick it from the list` }, 409);
      srv.leagues[k] = { name, info: body.info, token: (srv.leagues[k] && srv.leagues[k].token) || 'tok' + (Object.keys(srv.leagues).length + 1) };
      return json({ success: true, created: true, token: srv.leagues[k].token, url: `/score/tournament/${srv.leagues[k].token}`, displayName: name, info: body.info });
    }
    if(/\/api\/leagues(\?|$)/.test(url)) return json({ success: true, leagues: Object.values(srv.leagues).map(l => l.name) });
    if((m = /\/api\/league\/([^/?]+)(\?|$)/.exec(url)) && method === 'GET'){
      const l = srv.leagues[decodeURIComponent(m[1]).toLowerCase()];
      return json({ success: true, matches: srv.records, completed: false, info: l ? l.info : null, token: l ? l.token : null });
    }
    return json({ success: false });
  };
  return srv;
}

function bootPanel(file, srv){
  let html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://example.test/cricket-panel?uid=U1', virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){} });
      w.fetch = srv.fetch;
      w.firebase = undefined;
      w.alert = () => {};
      w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('no camera')) } });
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLMediaElement.prototype.pause = () => {};
      w.crypto = w.crypto || {};
      let n = 0;
      w.crypto.randomUUID = () => 'uuid-' + (++n);
      w.AbortSignal.timeout = w.AbortSignal.timeout || (() => undefined);
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  const E = (c) => dom.window.eval(c);
  E(`(function(){ const t = toast; window.__toasts = []; toast = function(m){ window.__toasts.push(String(m)); try{ return t.apply(this, arguments); }catch(e){} }; })()`);
  E(`compressImageToDataURL = async () => ${JSON.stringify(LOGO)};`);
  return { w: dom.window, E, errors, $: (s) => dom.window.document.querySelector(s), $$: (s) => [...dom.window.document.querySelectorAll(s)] };
}
const click = (P, el) => el.dispatchEvent(new P.w.Event('click', { bubbles: true }));
const typeIn = (P, el, v) => { el.value = v; el.dispatchEvent(new P.w.Event('input', { bubbles: true })); };
const key = (P, el, k) => el.dispatchEvent(new P.w.KeyboardEvent('keydown', { key: k, bubbles: true }));

async function panelSuite(file, label){
  console.log(`\n######## ${label} — ${file} ########`);
  const srv = fakeServer();
  const P = bootPanel(file, srv);
  await sleep(60);
  const open = () => P.$('#tc-overlay').classList.contains('show');

  console.log('\n=== Playing XI is gone from Match Setup ===');
  eq(`${label}: no Playing XI section`, [!!P.$('#ms-xi-A'), !!P.$('#ms-xi-B'), P.$$('[id^="ms-xi"]').length], [false, false, 0]);

  console.log('\n=== Button + modal ===');
  eq(`${label}: ＋ Create Tournament button is there`, [!!P.$('#tc-create-btn'), /Create Tournament/.test(P.$('#tc-create-btn').textContent)], [true, true]);
  click(P, P.$('#tc-create-btn'));
  await sleep(40);
  eq(`${label}: modal opens in create mode`, [open(), P.$('#tc-title').textContent, P.$('#tc-save').textContent, P.$('#tc-name').disabled], [true, '🏆 Create Tournament', 'Create Tournament', false]);
  eq(`${label}: empty name → Create is off`, P.$('#tc-save').disabled, true);
  typeIn(P, P.$('#tc-name'), 'PL');
  eq(`${label}: too short a name is refused`, [P.$('#tc-name-err').textContent, P.$('#tc-save').disabled], ['At least 3 characters', true]);
  typeIn(P, P.$('#tc-name'), '  Premier   League  ');
  eq(`${label}: a good name → Create is on`, [P.$('#tc-name-err').textContent, P.$('#tc-save').disabled], ['', false]);
  eq(`${label}: live preview shows the name`, P.$('#tc-preview .tc-pv-name').textContent, 'Premier League');

  console.log('\n=== Details ===');
  typeIn(P, P.$('#tc-short'), 'SPL');
  typeIn(P, P.$('#tc-season'), '2026');
  typeIn(P, P.$('#tc-start'), '2026-11-10');
  typeIn(P, P.$('#tc-end'), '2026-11-01');
  eq(`${label}: end before start is refused`, [P.$('#tc-date-err').textContent, P.$('#tc-save').disabled], ['The end date is before the start date', true]);
  typeIn(P, P.$('#tc-end'), '2026-11-20');
  typeIn(P, P.$('#tc-venue'), 'Wankhede');
  typeIn(P, P.$('#tc-city'), 'Mumbai');
  typeIn(P, P.$('#tc-organizer'), 'Scorvix Club');
  typeIn(P, P.$('#tc-desc'), 'Ten-over league <b>open</b> to all');
  eq(`${label}: preview follows dates, venue, sub line`, [P.$('#tc-preview .tc-pv-sub').textContent, /10 Nov 2026 – 20 Nov 2026/.test(P.$('#tc-preview').textContent), /Wankhede, Mumbai/.test(P.$('#tc-preview').textContent)], ['SPL · 2026', true, true]);
  const chipBefore = P.$('[data-tc-format="Custom"]');
  P.$('#tc-desc').dispatchEvent(new P.w.Event('change', { bubbles: true }));
  eq(`${label}: leaving a field (blur/change) does not redraw the chips under the click`, P.$('[data-tc-format="Custom"]') === chipBefore, true);
  click(P, P.$('[data-tc-format="Custom"]'));
  eq(`${label}: Custom format shows overs box`, [P.$('#tc-overs-wrap').hidden, P.$('[data-tc-format="Custom"]').classList.contains('on')], [false, true]);
  typeIn(P, P.$('#tc-overs'), '0');
  eq(`${label}: overs must be 1–100`, [P.$('#tc-date-err').textContent, P.$('#tc-save').disabled], ['Overs: 1 to 100', true]);
  typeIn(P, P.$('#tc-overs'), '10');
  eq(`${label}: valid overs → Create is on`, P.$('#tc-save').disabled, false);

  const logoFile = new P.w.File(['x'], 'logo.png', { type: 'image/png' });
  Object.defineProperty(P.$('#tc-logo-file'), 'files', { value: [logoFile], configurable: true });
  P.$('#tc-logo-file').dispatchEvent(new P.w.Event('change'));
  await sleep(20);
  eq(`${label}: logo upload previews`, [P.$('#tc-logo').classList.contains('has'), P.$('#tc-logo-remove').hidden, P.E('tc.logoUrl') === LOGO], [true, false, true]);

  console.log('\n=== Teams ===');
  eq(`${label}: saved teams are suggested`, P.$$('#tc-sugg [data-tc-pick]').map(b => b.getAttribute('data-tc-pick')), ['D Y Patil']);
  click(P, P.$('[data-tc-pick="D Y Patil"]'));
  typeIn(P, P.$('#tc-team-input'), 'Mumbai  Warriors');
  key(P, P.$('#tc-team-input'), 'Enter');
  typeIn(P, P.$('#tc-team-input'), 'Lions');
  click(P, P.$('#tc-team-add'));
  typeIn(P, P.$('#tc-team-input'), 'lions');
  key(P, P.$('#tc-team-input'), 'Enter');
  eq(`${label}: teams added (no duplicates)`, P.E('tc.teams.map(t => [t.name, t.teamId])'), [['D Y Patil', 't_dyp'], ['Mumbai Warriors', null], ['Lions', null]]);
  click(P, P.$('[data-tc-del="2"]'));
  eq(`${label}: a team can be removed`, [P.E('tc.teams.length'), P.$('#tc-teams-n').textContent], [2, '— 2 added']);
  eq(`${label}: checklist all ticked`, P.$$('#tc-check li').map(li => li.className), ['', '', '', '', '']);

  console.log('\n=== Create ===');
  click(P, P.$('#tc-save'));
  await sleep(80);
  const post = srv.infoPosts.slice(-1)[0];
  eq(`${label}: POST /api/league/:name/info with create + details`, post && [post.name, /uid=U1/.test(post.url), post.body.create, post.body.info.shortName, post.body.info.season, post.body.info.startDate, post.body.info.endDate, post.body.info.venue, post.body.info.city, post.body.info.organizer, post.body.info.format, post.body.info.overs, post.body.info.logoUrl === LOGO, post.body.info.teams.map(t => t.name)],
    ['Premier League', true, true, 'SPL', '2026', '2026-11-10', '2026-11-20', 'Wankhede', 'Mumbai', 'Scorvix Club', 'Custom', 10, true, ['D Y Patil', 'Mumbai Warriors']]);
  eq(`${label}: done view with the public link`, [P.$('#tc-form').hidden, P.$('#tc-done').hidden, P.$('#tc-done-url') && P.$('#tc-done-url').value, !!P.$('[data-tc-schedule]')], [true, false, 'https://example.test/score/tournament/tok1', true]);
  eq(`${label}: tournament is selected in the panel`, [P.E('state.leagueName'), P.E('state.matchMode'), P.$('#tournament-select').value], ['Premier League', 'tournament', 'Premier League']);
  await sleep(40);
  eq(`${label}: summary card shows it`, [P.$('#tc-summary').hidden, P.$('#tc-summary .tc-sum-name').textContent, /10 Nov 2026 – 20 Nov 2026/.test(P.$('#tc-summary').textContent), /Wankhede, Mumbai/.test(P.$('#tc-summary').textContent), P.$('#tc-summary a') && P.$('#tc-summary a').getAttribute('href')],
    [false, 'Premier League', true, true, '/score/tournament/tok1']);
  eq(`${label}: toast says it is live`, P.w.__toasts.slice(-1)[0], '🏆 Premier League created — live on the website');

  console.log('\n=== Schedule first match uses the tournament ===');
  click(P, P.$('[data-tc-schedule]'));
  await sleep(120);
  eq(`${label}: Upcoming Match opens for this tournament`, [open(), P.$('#um-overlay').classList.contains('show'), P.$('#um-kicker').textContent], [false, true, 'Premier League']);
  eq(`${label}: fixture starts with the tournament's format + overs + venue`, [P.E('umFmt.format'), P.E('umFmt.customOvers'), P.$('#um-venue').value], ['Custom', 10, 'Wankhede, Mumbai']);
  P.E(`closeUpcomingModal && closeUpcomingModal()`);
  P.$('#um-overlay').classList.remove('show');

  console.log('\n=== Already exists ===');
  click(P, P.$('#tc-create-btn'));
  await sleep(30);
  typeIn(P, P.$('#tc-name'), 'premier league');
  eq(`${label}: a name already in the list is refused before saving`, [P.$('#tc-name-err').textContent, P.$('#tc-save').disabled], ['"premier league" already exists — pick it from the list', true]);
  srv.leagues['other cup'] = { name: 'Other Cup', info: {}, token: 'tokX' };
  typeIn(P, P.$('#tc-name'), 'Other Cup');
  const n = srv.infoPosts.length;
  click(P, P.$('#tc-save'));
  await sleep(60);
  eq(`${label}: server 409 keeps the modal open and says why`, [srv.infoPosts.length, open(), P.$('#tc-name-err').textContent, P.$('#tc-form').hidden, P.E('state.leagueName')], [n + 1, true, '"Other Cup" already exists — pick it from the list', false, 'Premier League']);
  key(P, P.w.document.body, 'Escape');
  eq(`${label}: Esc closes`, open(), false);

  console.log('\n=== Edit ===');
  click(P, P.$('#tc-summary [data-tc-edit]'));
  await sleep(30);
  eq(`${label}: Edit opens with saved details, name locked`, [open(), P.$('#tc-title').textContent, P.$('#tc-name').value, P.$('#tc-name').disabled, P.$('#tc-venue').value, P.E('tc.teams.length')], [true, '✏️ Edit Tournament', 'Premier League', true, 'Wankhede', 2]);
  typeIn(P, P.$('#tc-venue'), 'Brabourne');
  click(P, P.$('#tc-save'));
  await sleep(60);
  const ep = srv.infoPosts.slice(-1)[0];
  eq(`${label}: edit saves without create`, [ep.name, ep.body.create, ep.body.info.venue], ['Premier League', false, 'Brabourne']);
  eq(`${label}: summary follows the edit`, /Brabourne, Mumbai/.test(P.$('#tc-summary').textContent), true);
  click(P, P.$('[data-tc-close]'));

  console.log('\n=== Dropdown "+ New Tournament…" ===');
  const sel = P.$('#tournament-select');
  sel.value = '__new__';
  sel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  await sleep(30);
  eq(`${label}: opens the Create Tournament modal, keeps the current pick`, [open(), P.$('#tc-title').textContent, sel.value, P.E('state.leagueName')], [true, '🏆 Create Tournament', 'Premier League', 'Premier League']);
  click(P, P.$('#tc-cancel'));

  console.log('\n=== Server info loads on select ===');
  srv.leagues['old cup'] = { name: 'Old Cup', info: { venue: 'Eden', city: 'Kolkata', startDate: '2026-12-01', endDate: '' }, token: 'tokOld' };
  P.E(`addKnownTournament('Old Cup'); refreshLeagueUI();`);
  sel.value = 'Old Cup';
  sel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  await sleep(80);
  eq(`${label}: picking a tournament shows its saved details`, [P.$('#tc-summary .tc-sum-name').textContent, /1 Dec 2026/.test(P.$('#tc-summary').textContent), /Eden, Kolkata/.test(P.$('#tc-summary').textContent)], ['Old Cup', true, true]);

  console.log('\n=== Logged out ===');
  P.E(`window.history.replaceState(null, '', '/cricket-panel'); try{ localStorage.removeItem('scorvix_uid'); }catch(e){}`);
  click(P, P.$('#tc-create-btn'));
  await sleep(30);
  typeIn(P, P.$('#tc-name'), 'Night Cup');
  const n2 = srv.infoPosts.length;
  click(P, P.$('#tc-save'));
  await sleep(30);
  eq(`${label}: no account → nothing sent, asks to log in`, [srv.infoPosts.length, P.w.__toasts.slice(-1)[0], open()], [n2, '⚠️ Log in first — tournaments are saved to your account', true]);

  eq(`${label}: no script errors`, P.errors, []);
}

// ---- server ----------------------------------------------------------------
function routeBody(src, marker){
  const start = src.indexOf(marker);
  if(start < 0) throw new Error('route not found: ' + marker);
  const arrow = src.indexOf('async (req, res) =>', start);
  let i = src.indexOf('{', arrow), depth = 0;
  for(let j = i; j < src.length; j++){
    if(src[j] === '{') depth++;
    else if(src[j] === '}'){ depth--; if(depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced route');
}
function leaguesColl(docs){
  const m = (d, q) => Object.keys(q).every(k => q[k] === null ? d[k] == null : d[k] === q[k]);
  return {
    docs,
    findOne: async (q) => { const d = docs.find(x => m(x, q)); return d ? JSON.parse(JSON.stringify(d)) : null; },
    updateOne: async (q, u, o) => {
      let d = docs.find(x => m(x, q));
      if(!d && o && o.upsert){ d = { ...q, ...(u.$setOnInsert || {}) }; docs.push(d); }
      if(d && u.$set) Object.assign(d, JSON.parse(JSON.stringify(u.$set)));
      return { matchedCount: d ? 1 : 0 };
    }
  };
}
async function serverSuite(){
  console.log('\n######## SERVER — /api/league/:name/info ########');
  const src = H.src.replace(/\r\n/g, '\n');
  const sanitize = new Function(H.grabConst('TOURNAMENT_FORMATS') + H.grab('sanitizeTournamentInfo') + '; return sanitizeTournamentInfo;')();
  const s = sanitize({ shortName: 'SPL-LONG-NAME-OVER-16', season: '2026', startDate: '2026-11-10', endDate: '2026-11-01', venue: 'W'.repeat(200), format: 'Hundred', overs: 500,
    logoUrl: 'javascript:alert(1)', color: 'red', description: 'line\u0000two',
    teams: [{ name: 'Lions', short: 'lio', color: '#ff0000', teamId: 't1' }, { name: 'lions' }, { name: '' }, { name: 'Tigers', logoUrl: LOGO }] });
  eq('SERVER: info is cleaned (caps, dates, format, logo, colour, teams)', [s.shortName.length, s.startDate, s.endDate, s.venue.length, s.format, s.overs, s.logoUrl, s.color, s.description, s.teams.map(t => [t.name, t.short, t.color, t.teamId, !!t.logoUrl])],
    [16, '2026-11-10', '2026-11-10', 80, 'T20', null, '', '', 'line two', [['Lions', 'LIO', '#ff0000', 't1', false], ['Tigers', '', '', null, true]]]);
  eq('SERVER: an image logo is kept', sanitize({ logoUrl: LOGO, format: 'Custom', overs: 12 }).logoUrl === LOGO && sanitize({ format: 'Custom', overs: 12 }).overs === 12, true);
  const summary = new Function(H.grab('tournamentInfoSummary') + '; return tournamentInfoSummary;')();
  eq('SERVER: list summary is light (no logo / description)', summary(s), { shortName: s.shortName, season: '2026', startDate: '2026-11-10', endDate: '2026-11-10', venue: s.venue, city: '', format: 'T20', overs: null, teamCount: 2 });

  const world = { leagues: leaguesColl([]), invalidated: [], tokenN: 0 };
  const ensure = new Function('leaguesCollection', 'SINGLE_MATCHES_LEAGUE_KEY', 'generatePublicToken', H.grab('ensureLeaguePublicToken', 'async function ') + '; return ensureLeaguePublicToken;')(world.leagues, '__single__', () => 'T' + (++world.tokenN));
  const body = routeBody(src, "app.post('/api/league/:name/info'");
  const route = new Function('leagueKeyFor', 'ownerUidFrom', 'SINGLE_MATCHES_LEAGUE_KEY', 'leaguesCollection', 'sanitizeTournamentInfo', 'ensureLeaguePublicToken', 'invalidateTournamentCaches', 'console',
    'return async (req, res) => ' + body)(
    (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ') || null, (req) => req.uid || null, '__single__', world.leagues, sanitize, ensure,
    (t) => world.invalidated.push(t), { log(){} });
  const call = async (req) => { const out = { status: 200 }; await route(req, { status(c){ out.status = c; return this; }, json(o){ out.body = o; return this; } }); return out; };

  const r1 = await call({ params: { name: 'Premier League' }, uid: 'U1', creatorEmail: 'chhayajeeth@gmail.com', body: { create: true, info: { venue: 'Wankhede', format: 'ODI', teams: [{ name: 'Lions' }] } } });
  const doc = world.leagues.docs[0];
  eq('SERVER: create saves the tournament + details', [r1.status, r1.body.success, r1.body.created, doc.leagueKey, doc.displayName, doc.sport, doc.info.venue, doc.info.format, doc.createdBy, typeof doc.createdAt], [200, true, true, 'premier league', 'Premier League', 'cricket', 'Wankhede', 'ODI', 'chhayajeeth@gmail.com', 'number']);
  eq('SERVER: public link minted at once + caches dropped', [r1.body.token, r1.body.url, doc.publicToken, world.invalidated], ['T1', '/score/tournament/T1', 'T1', ['T1']]);
  const r2 = await call({ params: { name: 'premier  league' }, uid: 'U1', body: { create: true, info: {} } });
  eq('SERVER: creating the same name again → 409, nothing changed', [r2.status, r2.body.code, world.leagues.docs.length, doc.info.venue], [409, 'TOURNAMENT_EXISTS', 1, 'Wankhede']);
  const r3 = await call({ params: { name: 'Premier League' }, uid: 'U1', body: { info: { venue: 'Brabourne' } } });
  eq('SERVER: edit keeps the same link + creator', [r3.status, r3.body.created, r3.body.token, world.leagues.docs[0].info.venue, world.leagues.docs[0].createdBy, world.tokenN], [200, false, 'T1', 'Brabourne', 'chhayajeeth@gmail.com', 1]);
  const r4 = await call({ params: { name: 'X Cup' }, body: { create: true, info: {} } });
  eq('SERVER: no account → 401, nothing saved', [r4.status, world.leagues.docs.length], [401, 1]);
  const r5 = await call({ params: { name: '__single__' }, uid: 'U1', body: { create: true, info: {} } });
  eq('SERVER: reserved name refused', [r5.status, world.leagues.docs.length], [400, 1]);
  const r6 = await call({ params: { name: 'Other' }, uid: 'U2', body: { create: true, info: {} } });
  eq('SERVER: same-looking names under another account are separate', [r6.status, world.leagues.docs.length, world.leagues.docs[1].ownerUid], [200, 2, 'U2']);

  console.log('\n=== Matches + fixtures publish at once ===');
  world.leagues.docs.push({ ownerUid: 'U1', leagueKey: 'old cup', displayName: 'Old Cup' });
  eq('SERVER: an old tournament without a link gets one on its next save', [await ensure('U1', 'old cup'), world.leagues.docs[2].publicToken, await ensure('U1', 'old cup')], ['T3', 'T3', 'T3']);
  eq('SERVER: single matches never get a tournament link', await ensure('U1', '__single__'), null);
  const saveRoute = routeBody(src, "app.post('/api/league/:name/match'");
  eq('SERVER: match / fixture save publishes + drops caches', /invalidateTournamentCaches\(await ensureLeaguePublicToken\(ownerUid, leagueKey\)\)/.test(saveRoute), true);
  const delRoute = routeBody(src, "app.delete('/api/league/:name/match/:matchId'");
  eq('SERVER: deleting a match drops the caches too', /invalidateTournamentCaches\(/.test(delRoute), true);
  const inval = new Function('publicTournamentCache', 'let publicTournamentsListCache = { x: 1 };' + H.grab('invalidateTournamentCaches') + '; invalidateTournamentCaches("T1"); return publicTournamentsListCache;');
  const cache = new Map([['T1', {}], ['T2', {}]]);
  eq('SERVER: invalidate clears the list + that tournament only', [inval(cache), [...cache.keys()]], [null, ['T2']]);
  const bigParser = src.indexOf("app.use('/api/league/:name/info', express.json({ limit: '3mb' }));");
  eq('SERVER: a tournament with logos fits (own 3mb body limit, parsed before the global one)', bigParser > 0 && bigParser < src.indexOf('app.use(express.json());'), true);
  eq('SERVER: an oversized team logo is dropped', sanitize({ teams: [{ name: 'Big', logoUrl: 'data:image/png;base64,' + 'A'.repeat(50000) }] }).teams[0].logoUrl, '');
  const getRoute = routeBody(src, "app.get('/api/league/:name'");
  eq('SERVER: GET league returns info + token for the panel', /res\.json\(\{[^}]*\binfo\b[^}]*\btoken\b/.test(getRoute), true);
  const list = src.slice(src.indexOf("app.get('/api/public/tournaments'"), src.indexOf("app.get('/api/public/tournaments'") + 9000);
  eq('SERVER: public list carries info summary + upcoming count', [/upcomingCount:/.test(list), /tournamentInfoSummary\(doc\.info\)/.test(list)], [true, true]);
}

// ---- website ---------------------------------------------------------------
function fnText(src, name){
  const start = src.indexOf('function ' + name + '(');
  if(start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
  for(let j = i; j < src.length; j++){
    if(src[j] === '{') depth++;
    else if(src[j] === '}'){ depth--; if(depth === 0) return src.slice(start, j + 1); }
  }
}
async function websiteSuite(){
  console.log('\n######## WEBSITE — index + tournament page ########');
  const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const chips = new Function(fnText(idx, 'tkEscape') + fnText(idx, 'tournamentInfoChips') + '; return tournamentInfoChips;')();
  const html = chips({ upcomingCount: 2, info: { startDate: '2026-11-10', endDate: '2026-11-20', venue: 'Wankhede', city: 'Mumbai<script>', teamCount: 6, format: 'Custom', overs: 10 } });
  eq('INDEX: card chips — dates, venue, teams, format, upcoming (escaped)', [/📅 10 Nov – 20 Nov/.test(html), /📍 Wankhede, Mumbai&lt;script&gt;/.test(html), /👥 6 teams/.test(html), /🏏 Custom · 10 ov/.test(html), /⏳ 2 upcoming/.test(html), /<script>/.test(html)], [true, true, true, true, true, false]);
  eq('INDEX: no info → no extra chips', chips({ matchCount: 3 }), '');
  eq('INDEX: card name is escaped now', /<h3>\$\{tkEscape\(t\.name\)\}<\/h3>/.test(idx), true);
  eq('INDEX: quiet auto-refresh every 20s + on tab return', [/setInterval\(\(\) => \{ if \(!document\.hidden\) loadTournaments\(true\); \}, 20000\)/.test(idx), /visibilitychange', \(\) => \{ if \(!document\.hidden\) loadTournaments\(true\)/.test(idx)], [true, true]);
  // loadTournaments(quiet) only re-draws on a change
  const lt = new Function('fetch', 'auth', 'counter', 'let allTournaments = []; let tournamentFilter = "all";' + idx.slice(idx.indexOf('let tournamentsSig = null;'), idx.indexOf('// ===== Stats bar')) +
    '; function renderTournaments(){ counter.n++; } function renderTicker(){} function renderStatsBar(){} return { loadTournaments, get list(){ return allTournaments; } };');
  let payload = { tournaments: [{ name: 'A', matchCount: 1 }] };
  const counter = { n: 0 };
  let down = false;
  const T = lt(async () => { if(down) throw new Error('offline'); return { json: async () => JSON.parse(JSON.stringify(payload)) }; }, { currentUser: null }, counter);
  await T.loadTournaments();
  await T.loadTournaments(true);
  eq('INDEX: same data → no re-draw', counter.n, 1);
  payload = { tournaments: [{ name: 'A', matchCount: 1 }, { name: 'New Cup', matchCount: 0, upcomingCount: 1 }] };
  await T.loadTournaments(true);
  eq('INDEX: a new tournament → re-drawn', [counter.n, T.list.length], [2, 2]);
  down = true;
  await T.loadTournaments(true);
  eq('INDEX: offline quiet check keeps what is on screen', [counter.n, T.list.length], [2, 2]);

  const st = fs.readFileSync(path.join(__dirname, '..', '..', 'score-tournament.html'), 'utf8');
  const hero = new Function(fnText(st, 'escapeHtml') + fnText(st, 'safeLogo') + fnText(st, 'infoDate') + fnText(st, 'tourneyInfoHtml') + '; return tourneyInfoHtml;')();
  const h = hero({ shortName: 'SPL', season: '2026', startDate: '2026-11-10', endDate: '2026-11-20', venue: 'Wankhede', city: 'Mumbai', format: 'T20', organizer: 'Club <x>', description: 'About us', logoUrl: LOGO,
    teams: [{ name: 'Lions', color: '#ff0000' }, { name: 'Tigers', logoUrl: 'javascript:alert(1)' }] });
  eq('PAGE: hero shows logo, season, dates, venue, organiser, about, teams', [/<img class="th-logo"/.test(h.logo), h.sub, /📅 10 Nov 2026 – 20 Nov 2026/.test(h.facts), /📍 Wankhede, Mumbai/.test(h.facts), /🏆 Club &lt;x&gt;/.test(h.facts), /About us/.test(h.about), (h.teams.match(/class="th-team"/g) || []).length, /javascript:/.test(h.teams)],
    [true, '<div class="th-sub">SPL · 2026</div>', true, true, true, true, 2, false]);
  eq('PAGE: no logo → short-name badge', /th-logo-txt[^>]*>SPL</.test(hero({ shortName: 'SPL' }).logo), true);
  eq('PAGE: no info → nothing extra', hero(null), { logo: '', sub: '', facts: '', about: '', teams: '' });
  // refreshPortal: re-draws only on a change, quietly, and never while hidden
  const rp = new Function('apiFetch', 'document', 'window', 'renderPortal', 'Event',
    st.slice(st.indexOf('let portalSig ='), st.indexOf('function startPortalRefresh')) + '; return { refreshPortal, portalSignature, set sig(v){ portalSig = v; } };');
  let data = { success: true, displayName: 'SPL', matches: [{ matchId: 'a' }] };
  const renders = [];
  const doc = { hidden: false, getElementById: () => ({ querySelector: () => null, querySelectorAll: () => [] }) };
  const R = rp(async () => ({ json: async () => JSON.parse(JSON.stringify(data)) }), doc, { scrollY: 0, scrollTo(){} }, (d, t, o) => renders.push([d.matches.length, o && o.quiet]), function(){});
  R.sig = R.portalSignature(data);
  await R.refreshPortal('tok');
  eq('PAGE: same data → no re-draw', renders.length, 0);
  data = { ...data, matches: [{ matchId: 'a' }, { matchId: 'f1', upcoming: true }] };
  doc.hidden = true;
  await R.refreshPortal('tok');
  eq('PAGE: hidden tab → no check', renders.length, 0);
  doc.hidden = false;
  await R.refreshPortal('tok');
  eq('PAGE: a new fixture → quiet re-draw', renders, [[2, true]]);
  eq('PAGE: auto-refresh wired after the first load', /portalSig = portalSignature\(data\); renderPortal\(data, token\); startPortalRefresh\(token\);/.test(st), true);
}

(async () => {
  await panelSuite('cricket-panel.html', 'CLIPPER');
  await panelSuite('cricket-panel3.html', 'ENGINE');
  await serverSuite();
  await websiteSuite();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
