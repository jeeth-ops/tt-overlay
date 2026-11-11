// 🎛️ The Highlight Studio's server side (server.js + highlight-edit.js): the
// REAL server booted (in-memory MongoDB, a firebase-admin stub), real clips
// made by ffmpeg and served over HTTP the way R2 serves them.
//
// - only a signed-in creator account opens it (401 signed out, 403 any other
//   account); a private creator's match is not shown to the others;
// - the match and its visible clips, in ball order, with each team's logo
//   look (Sticker / Circle and its colour, from the panel);
// - the title card's words and an honest headline from what the clips are;
// - stills from a clip for a thumbnail: the sharpest first, cached;
// - a custom video: the operator's clips in the operator's ORDER (checked in
//   the finished video's own pictures), every stage reported, ready only once
//   checked, downloadable more than once;
// - strict: a selected clip that cannot be loaded, or cannot be played, fails
//   the job and is named — never a video quietly missing a clip;
// - cancel stops the ffmpegs and leaves no file behind; the same request twice
//   is one job; more studio jobs than allowed at once → busy;
// - the scorecard's own downloads (the old compile route) are unchanged.
//
//   node test/highlight-studio-server.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, execSync } = require('child_process');

// everything this server writes goes in a folder of its own
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-studio-test-'));
process.env.TMPDIR = TMP;
process.env.HIGHLIGHT_PARALLEL = '2';
const { bootServer, request } = require('./server-boot.js');
const F = require('./merge-fixtures.js');
const { studioFixtures, colourAt, probeFile, MATCH, PRIVATE_MATCH, MATCH2, SINGLE_MATCH } = require('./highlight-studio-fixtures.js');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
const AUTH = { Authorization: 'Bearer work-token' };

function download(port, url){
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      const out = [];
      res.on('data', d => out.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(out), headers: res.headers }));
    });
  });
}
// ffmpegs running now (as themselves or under nice)
const ffmpegList = () => execSync('ps -ww -eo etimes,args', { encoding: 'utf8' }).split('\n').map(l => l.trim()).filter(l => l.includes(ffmpegPath) && !/^\d+\s+(\/bin\/)?(ba)?sh /.test(l));
const ffmpegs = () => ffmpegList().length;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const fx = await studioFixtures(TMP, { tournament: true });
  const { ids, served, clipServer } = fx;
  const { port } = await bootServer({ idTokens: fx.tokens, users: F.EMAIL_OF, seed: fx.seed });
  const LOGO = fx.LOGO;
  const api = (method, url, body, headers) => request(port, method, url, body, headers);

  console.log('\n=== Who can open it ===');
  let r = await api('GET', `/api/highlights/studio/${MATCH}`);
  ok('signed out: 401, asked to sign in', r.status === 401 && r.json.signIn === true, r.status);
  r = await api('GET', `/api/highlights/studio/${MATCH}`, null, { Authorization: 'Bearer other-token' });
  ok('another account: 403', r.status === 403, r.status);
  r = await api('GET', `/api/highlights/studio/${PRIVATE_MATCH}`, null, AUTH);
  ok('a private creator\'s match is not shown to another creator (404)', r.status === 404, r.status);
  r = await api('GET', `/api/highlights/studio/${PRIVATE_MATCH}`, null, { Authorization: 'Bearer owner-token' });
  ok('… and is to its own creator', r.status === 200, r.status);
  r = await api('POST', '/api/highlights/compile', { matchId: MATCH, type: 'custom', clipIds: [ids.red] });
  ok('a studio render signed out: 401 (never an anonymous 400-clip job)', r.status === 401, r.status);

  console.log('\n=== The match and its clips ===');
  r = await api('GET', `/api/highlights/studio/${MATCH}`, null, AUTH);
  const m = r.json || {};
  ok('the match: teams, tournament, venue, result', r.status === 200 && m.match.teams.A.short === 'GSC' && m.match.teams.B.name === 'DY Patil'
    && m.match.tournament === 'MCA President Cup 2026' && m.match.venue === 'Azad Maidan' && m.match.result === 'GSC won by 30 runs', m.match);
  ok('each team\'s logo look from the panel (A: circle on gold; B: no logo, the default)', m.match.teams.A.logo === LOGO && m.match.teams.A.logoStyle === 'circle'
    && m.match.teams.A.logoBg === '#ffd700' && m.match.teams.B.logo === '' && m.match.teams.B.logoStyle === 'sticker', [m.match.teams.A.logoStyle, m.match.teams.A.logoBg]);
  ok('the visible clips of this match only, in ball order', JSON.stringify(m.clips.map(c => c.clipId)) === JSON.stringify(['red', 'green', 'blue', 'detail', 'gone', 'corrupt', 'yellow'].map(n => ids[n])),
    m.clips.map(c => c.over + '.' + c.ballInOver));
  ok('… each with its player keys (for the filters)', m.clips[6].keys.fielder === F.pk('Sai Kumar') && m.clips[0].keys.striker === F.pk('Harsh Mendon'), m.clips[6].keys);

  console.log('\n=== Title and headline ===');
  r = await api('POST', '/api/highlights/title', { matchId: MATCH, clipIds: [ids.red, ids.blue], subject: { type: 'player', playerKey: F.pk('Harsh Mendon'), category: 'sixes' } }, AUTH);
  ok('a player\'s two sixes: "2 SIXES", his figures from the scorecard', r.status === 200 && r.json.headline === '2 SIXES' && r.json.title.title === 'Mendon'
    && r.json.title.first === 'Harsh' && r.json.title.stats[0].value === '64' && r.json.counts.sixes === 2, r.json && [r.json.headline, r.json.title && r.json.title.stats]);
  r = await api('POST', '/api/highlights/title', { matchId: MATCH, clipIds: [ids.red, ids.green, ids.yellow], subject: { type: 'full' } }, AUTH);
  ok('a mixed reel of the match: "MATCH HIGHLIGHTS", the two teams', r.json.headline === 'MATCH HIGHLIGHTS' && r.json.title.title === 'GSC vs DYP' && r.json.counts.wickets === 1, r.json && r.json.headline);
  r = await api('POST', '/api/highlights/title', { matchId: MATCH, clipIds: [ids.red, ids.red] }, AUTH);
  ok('a clip twice: refused', r.status === 400, r.status);
  r = await api('POST', '/api/highlights/title', { matchId: MATCH, clipIds: [ids.red, String(fx.elsewhere._id)] }, AUTH);
  ok('a clip of another match: refused', r.status === 400 && /not this match/.test(r.json.error), r.json);

  console.log('\n=== Stills for a thumbnail ===');
  let t0 = Date.now();
  r = await api('GET', `/api/highlights/frames/${ids.detail}?n=4`, null, AUTH);
  const first = Date.now() - t0;
  const fr = (r.json && r.json.frames) || [];
  ok('four stills, real JPEGs at the clip\'s size', r.status === 200 && fr.length === 4 && fr.every(f => /^data:image\/jpeg;base64,/.test(f.dataUrl) && f.w === 640 && f.h === 360), r.json && r.json.error);
  ok('the sharp ones first (the clip is blurred from 3 s)', fr.length === 4 && fr[0].t < 3 && fr[1].t < 3 && fr[2].t > 3 && fr[3].t > 3 && fr[0].score > fr[3].score * 2, fr.map(f => [f.t, f.score]));
  t0 = Date.now();
  const again = await api('GET', `/api/highlights/frames/${ids.detail}?n=4`, null, AUTH);
  ok('asked again: from the cache (no new download), the same stills', again.json.frames.length === 4 && again.json.frames[0].dataUrl === fr[0].dataUrl && served.filter(x => x === 'detail.mp4').length === 1,
    { first, again: Date.now() - t0 });
  r = await api('GET', `/api/highlights/frames/${ids.gone}`, null, AUTH);
  ok('a clip that cannot be loaded: an error saying so', r.status === 500 && /could not be loaded/.test(r.json.error), r.json);

  console.log('\n=== A custom video, in the operator\'s order ===');
  const order = ['blue', 'red', 'yellow', 'green'];
  r = await api('POST', '/api/highlights/compile', { matchId: MATCH, type: 'custom', clipIds: order.map(n => ids[n]), subject: { type: 'full' }, format: '16:9' }, AUTH);
  ok('started', r.status === 200 && !!r.json.jobId, r.json);
  const jobId = r.json.jobId;
  const dup = await api('POST', '/api/highlights/compile', { matchId: MATCH, type: 'custom', clipIds: order.map(n => ids[n]), subject: { type: 'full' }, format: '16:9' }, AUTH);
  ok('the same request again while it runs: the same job (no second render)', dup.json.jobId === jobId && dup.json.existing === true, dup.json);
  const stages = [];
  let st = null, sawPartial = false;
  for(const end = Date.now() + 180000; Date.now() < end;){
    st = (await api('GET', `/api/highlights/compile/${jobId}/status`)).json;
    if(st.stage && stages[stages.length - 1] !== st.stage) stages.push(st.stage);
    if(st.stage === 'clips' && st.stageDone > 0 && st.stageDone < st.stageTotal) sawPartial = true;
    if(['ready', 'error', 'cancelled'].includes(st.status)) break;
    if(st.progress >= 100 && st.status !== 'ready') { ok('never 100% before it is ready', false, st); break; }
    await wait(20);
  }
  ok('ready', st.status === 'ready' && st.edited === true, st);
  ok('the stages it really went through, in order', ['collect', 'clips', 'encode', 'ready'].every((s, i, a) => stages.indexOf(s) >= 0 && (i === 0 || stages.indexOf(s) > stages.indexOf(a[i - 1]))), stages);
  const sm = st.stageMap || {};
  ok('… and each stage\'s own count, every one finished: collected 4, probed 4, made the title card, 4 clips, the end card, encoded, checked',
    ['collect', 'probe', 'assets', 'intro', 'clips', 'outro', 'encode', 'validate'].every(k => sm[k] && sm[k].done === sm[k].total && sm[k].end) && sm.collect.total === 4 && sm.probe.total === 4 && sm.clips.total === 4, sm);
  ok('… with the clips counted as they were made', sawPartial || st.total === 4, stages);
  ok('the job says what it made: all 4 clips, none skipped, its size and how long it took', st.included === 4 && st.skipped === 0 && st.total === 4 && /1280x720 30 fps/.test(st.profile) && st.renderSec > 0 && st.elapsedMs > 0, st);
  const dl = await download(port, `/api/highlights/compile/${jobId}/download?name=AllSportsLive_Test`);
  const outFile = path.join(TMP, 'out.mp4');
  fs.writeFileSync(outFile, dl.body);
  const info = probeFile(outFile);
  ok('downloaded: an MP4 with picture and sound, 1280x720', dl.status === 200 && /AllSportsLive_Test\.mp4/.test(dl.headers['content-disposition']) && info.w === 1280 && info.h === 720 && info.audio, [dl.status, info]);
  // the opening, each 3.2 s clip (80 frames at 30 fps) and the end card: the engine's own lengths, as the studio is told them
  const intro = m.edit.intro, seg = 80 / 30, outro = m.edit.outro;
  ok('the studio is told the engine\'s own lengths (the opening 4.8 s, the end card 3.2 s)', intro === 4.8 && outro === 3.2, m.edit);
  ok('the opening + 4 clips + end card: as long as its parts', Math.abs(info.duration - (intro + seg * 4 + outro)) < 0.3, info.duration);
  const seen = order.map((n, i) => colourAt(outFile, intro + seg * i + seg / 2, 1280, 720));
  ok('the clips in the operator\'s order (blue, red, yellow, green — not ball order)', JSON.stringify(seen) === JSON.stringify(order), seen);
  const dl2 = await download(port, `/api/highlights/compile/${jobId}/download`);
  ok('a studio video can be downloaded again', dl2.status === 200 && dl2.body.length === dl.body.length, dl2.status);
  const left = fs.readdirSync(path.join(TMP, 'scorvix-highlights')).filter(n => n.startsWith(jobId));
  ok('only the finished video is left (its clips and work folder are gone)', JSON.stringify(left) === JSON.stringify([jobId + '.mp4']), left);

  console.log('\n=== Strict: never a video quietly missing a clip ===');
  r = await api('POST', '/api/highlights/compile', { matchId: MATCH, type: 'custom', clipIds: [ids.red, ids.gone, ids.green], subject: { type: 'full' } }, AUTH);
  for(let i = 0; i < 300; i++){ st = (await api('GET', `/api/highlights/compile/${r.json.jobId}/status`)).json; if(['ready', 'error', 'cancelled'].includes(st.status)) break; await wait(100); }
  ok('a clip that cannot be loaded: the job fails, naming it', st.status === 'error' && st.missing.length === 1 && st.missing[0].clipId === ids.gone && /FOUR 11\.1/.test(st.error), st);
  r = await api('POST', '/api/highlights/compile', { matchId: MATCH, type: 'custom', clipIds: [ids.red, ids.corrupt], subject: { type: 'full' } }, AUTH);
  for(let i = 0; i < 300; i++){ st = (await api('GET', `/api/highlights/compile/${r.json.jobId}/status`)).json; if(['ready', 'error', 'cancelled'].includes(st.status)) break; await wait(100); }
  ok('a clip that is not a video: the job fails, naming it (and no plain join instead)', st.status === 'error' && st.missing.length === 1 && st.missing[0].clipId === ids.corrupt && !st.edited && /could not be played/.test(st.error), st);
  const dlBad = await download(port, `/api/highlights/compile/${r.json.jobId}/download`);
  ok('… and there is nothing to download', dlBad.status === 404, dlBad.status);

  console.log('\n=== Cancel, and how many at once ===');
  const long = ['red', 'green', 'blue', 'yellow', 'detail'].map(n => ids[n]);
  r = await api('POST', '/api/highlights/compile', { matchId: MATCH, type: 'custom', clipIds: long, subject: { type: 'full' }, wheel: false, format: '9:16' }, AUTH);
  const cj = r.json.jobId;
  const r2 = await api('POST', '/api/highlights/compile', { matchId: MATCH, type: 'custom', clipIds: long.slice().reverse(), subject: { type: 'full' }, format: '9:16' }, AUTH);
  const r3 = await api('POST', '/api/highlights/compile', { matchId: MATCH, type: 'custom', clipIds: long.slice(1), subject: { type: 'full' }, format: '9:16' }, AUTH);
  ok('a third studio video while two are being made: busy (429), says why', r3.status === 429 && r3.json.busy === true, [r3.status, r3.json]);
  for(let i = 0; i < 600; i++){ st = (await api('GET', `/api/highlights/compile/${cj}/status`)).json; if(st.stage === 'clips' || ['ready', 'error'].includes(st.status)) break; await wait(50); }
  const other = await api('POST', `/api/highlights/compile/${cj}/cancel`, {}, { Authorization: 'Bearer owner-token' });
  ok('the owner may cancel anyone\'s; the canceller is checked', other.status === 200, other.status);
  const c2 = await api('POST', `/api/highlights/compile/${r2.json.jobId}/cancel`, {}, AUTH);
  ok('cancelled: both', c2.json.status === 'cancelled', c2.json);
  await wait(1500);
  st = (await api('GET', `/api/highlights/compile/${cj}/status`)).json;
  ok('a cancelled job stays cancelled (its last steps do not bring it back)', st.status === 'cancelled', st.status);
  // (this server's ffmpegs only: their files are in this test's own folder)
  const own = () => ffmpegList().filter(l => l.includes(TMP) && /\.part\.mkv|intro\.mkv|outro\.mkv|\.mp4\.part/.test(l));
  ok('… its own ffmpegs (its clips, title and end cards, the video) stopped at once', own().length === 0, own().map(l => l.slice(-200)));
  // (its folder goes as soon as its last ffmpeg has been stopped)
  const leftOf = () => fs.readdirSync(path.join(TMP, 'scorvix-highlights')).filter(n => n.startsWith(cj) || n.startsWith(r2.json.jobId));
  for(const end = Date.now() + 5000; Date.now() < end && leftOf().length;) await wait(100);
  ok('… and nothing of it left on disk (no half-written video)', leftOf().length === 0, leftOf());
  const segDir = path.join(TMP, 'scorvix-highlights', 'pro-cache', 'segments');
  ok('… nor a half-made segment in the cache', fs.readdirSync(segDir).filter(n => /\.part\.mkv$/.test(n)).length === 0, fs.readdirSync(segDir));
  // (the transition frames it had started are shared — made once for every
  // video — so they are finished and kept; then nothing at all runs)
  const mine = () => ffmpegList().filter(l => l.includes(TMP));
  for(const end = Date.now() + 30000; Date.now() < end && mine().length > 0;) await wait(200);
  ok('… and the CPU is free again soon after (none of its ffmpegs left at all)', mine().length === 0, mine().map(l => l.slice(-200)));
  const notMine = await api('POST', `/api/highlights/compile/${jobId}/cancel`, {}, { Authorization: 'Bearer other-token' });
  ok('cancel by an account that cannot use the studio: refused', notMine.status === 403, notMine.status);

  console.log('\n=== Thumbnails kept on the server (any device) ===');
  const jpg = path.join(TMP, 'thumb.jpg'), jpgP = path.join(TMP, 'thumb-p.jpg');
  spawnSync(ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080', '-frames:v', '1', '-q:v', '3', jpg]);
  spawnSync(ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920', '-frames:v', '1', '-q:v', '3', jpgP]);
  const jbuf = fs.readFileSync(jpg), pbuf = fs.readFileSync(jpgP);
  const postRaw = (url, buf, type, headers) => new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port, method: 'POST', path: url, headers: Object.assign({ 'Content-Type': type, 'Content-Length': buf.length }, headers || {}) }, (res) => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.status || res.statusCode, json: j }); });
    });
    rq.end(buf);
  });
  const tq = (o) => '?' + new URLSearchParams(Object.assign({ subject: 'full', mode: 'photo', variation: '2', format: '16:9', name: 'AllSportsLive_GscVsDyp_WithPhoto_Variation2_16x9.jpg', headline: 'MATCH HIGHLIGHTS' }, o || {})).toString();
  let tr = await postRaw(`/api/highlights/thumbs/${MATCH}${tq()}`, jbuf, 'image/jpeg');
  ok('signed out: a thumbnail cannot be kept (401)', tr.status === 401, tr.status);
  tr = await postRaw(`/api/highlights/thumbs/${MATCH}${tq()}`, jbuf, 'image/jpeg', AUTH);
  ok('kept: its token, its address, its size; stored in the database here (no R2 in this test)', tr.status === 200 && /^[0-9a-f]{32}$/.test(tr.json.thumb.token) && tr.json.thumb.width === 1920 && tr.json.thumb.height === 1080 && tr.json.thumb.storage === 'db', tr.json);
  const tok = tr.json.thumb.token;
  tr = await postRaw(`/api/highlights/thumbs/${MATCH}${tq({ format: '9:16' })}`, jbuf, 'image/jpeg', AUTH);
  ok('a "9:16" that is not 1080 x 1920: refused, saying why', tr.status === 400 && /1080 x 1920/.test(tr.json.error), tr.json);
  tr = await postRaw(`/api/highlights/thumbs/${MATCH}${tq({ format: '9:16' })}`, Buffer.from('not a picture at all'), 'image/jpeg', AUTH);
  ok('not a JPEG: refused', tr.status === 400 && /JPEG/.test(tr.json.error), tr.json);
  tr = await postRaw(`/api/highlights/thumbs/${MATCH}${tq({ format: '9:16' })}`, pbuf, 'image/jpeg', AUTH);
  ok('its 9:16 too', tr.status === 200 && tr.json.thumb.width === 1080, tr.json);
  tr = await postRaw(`/api/highlights/thumbs/${MATCH}${tq({ headline: 'POWER HITTING' })}`, jbuf, 'image/jpeg', AUTH);
  ok('saved again (same subject, design and shape): the same one, replaced', tr.status === 200 && tr.json.thumb.token === tok && tr.json.thumb.headline === 'POWER HITTING', tr.json);
  let tl = await api('GET', `/api/highlights/thumbs/${MATCH}`, null, AUTH);
  ok('the list: the two, newest first, without their pictures', tl.status === 200 && tl.json.thumbs.length === 2 && tl.json.thumbs[0].token === tok && !('data' in tl.json.thumbs[0]), tl.json);
  const tf = await download(port, `/api/highlights/thumbs/file/${tok}.jpg?download=1`);
  ok('its picture: the very bytes, as a JPEG download with its name', tf.status === 200 && tf.headers['content-type'] === 'image/jpeg' && tf.body.equals(jbuf) && /Variation2_16x9\.jpg/.test(tf.headers['content-disposition']), [tf.status, tf.headers['content-type']]);
  const guess = await download(port, `/api/highlights/thumbs/file/${'0'.repeat(32)}.jpg`);
  ok('a guessed address: nothing', guess.status === 404, guess.status);
  tl = await api('GET', `/api/highlights/thumbs/${PRIVATE_MATCH}`, null, AUTH);
  ok('a private creator\'s match: not listed to another creator', tl.status === 404, tl.status);
  tl = await api('DELETE', `/api/highlights/thumbs/${MATCH}/${tok}`, null, AUTH);
  const after = await download(port, `/api/highlights/thumbs/file/${tok}.jpg`);
  const remaining = await api('GET', `/api/highlights/thumbs/${MATCH}`, null, AUTH);
  ok('deleted: gone from the list and its address', tl.status === 200 && after.status === 404 && remaining.json.thumbs.length === 1, [tl.status, after.status, remaining.json.thumbs.length]);

  console.log('\n=== The whole tournament: a player over every match of it ===');
  r = await api('GET', `/api/highlights/studio/${MATCH}`, null, AUTH);
  ok('the match on its own: its own clips only, and the tournament it is part of (both matches, in order)', r.status === 200 && r.json.scope === 'match' && r.json.clips.every(c => c.matchId === MATCH) && r.json.tournament && r.json.tournament.name === 'MCA President Cup 2026'
    && JSON.stringify(r.json.tournament.matches.map(m => m.key)) === JSON.stringify([MATCH, MATCH2]), r.json.tournament);
  const tt = await api('GET', `/api/highlights/studio/${MATCH}?scope=tournament`, null, AUTH);
  const tclips = tt.json.clips || [];
  ok('scope=tournament: every match\'s clips — this match\'s, then the semi-final\'s', tt.status === 200 && tt.json.scope === 'tournament' && tclips.some(c => c.clipId === ids.blue) && tclips.some(c => c.clipId === ids['t2-six'])
    && !tclips.some(c => c.matchId !== MATCH && c.matchId !== MATCH2) && tclips.findIndex(c => c.matchId === MATCH2) > tclips.map(c => c.matchId).lastIndexOf(MATCH), tclips.map(c => c.matchId).slice(-5));
  const t2 = tclips.find(c => c.clipId === ids['t2-six']);
  ok('… each clip names its match and its batting side\'s team (the semi-final\'s A is GSC)', t2 && t2.matchLabel === 'GSC vs SPG · Semi-final' && t2.team && t2.team.name === 'Gymkhana Sports Club', t2);
  ok('… and every team of the tournament, with its colour and badge', JSON.stringify(tt.json.tournament.teams.map(x => x.short)) === JSON.stringify(['GSC', 'DYP', 'SPG']) && tt.json.tournament.teams[0].logo === LOGO, tt.json.tournament.teams.map(x => x.short));
  r = await api('GET', `/api/highlights/studio/${SINGLE_MATCH}?scope=tournament`, null, AUTH);
  const single = await api('GET', `/api/highlights/studio/${SINGLE_MATCH}`, null, AUTH);
  ok('a single match: no tournament to take clips from', r.status === 400 && single.status === 200 && single.json.tournament === null, [r.status, r.json.error, single.json.tournament]);
  const HARSH = F.pk('Harsh Mendon');
  r = await api('POST', '/api/highlights/title', { matchId: MATCH, scope: 'tournament', clipIds: [ids['t2-six'], ids.blue, ids['t2-four']], subject: { type: 'player', playerKey: HARSH, category: 'boundaries' } }, AUTH);
  let T = (r.json && r.json.title) || {};
  ok('his title card over the tournament: both matches\' figures added up (64 off 34 + 30 off 20 = 94 off 54; 5 sixes, 6 fours)', r.status === 200 && r.json.scope === 'tournament' && T.first === 'Harsh' && T.title === 'Mendon' && T.kicker === 'MCA President Cup 2026'
    && JSON.stringify(T.stats) === JSON.stringify([{ value: '94', label: 'RUNS', sub: '54 BALLS' }, { value: '5', label: 'SIXES' }, { value: '6', label: 'FOURS' }, { value: '174.1', label: 'STRIKE RATE' }]), T);
  ok('… the matches he played, and against whom', T.line === '2 MATCHES  ·  vs DYP, SPG' && T.matches === 2, T.line);
  r = await api('POST', '/api/highlights/title', { matchId: MATCH, scope: 'tournament', clipIds: [ids.blue, ids['t2-sai']], subject: { type: 'player', playerKey: HARSH, category: 'all' } }, AUTH);
  T = (r.json && r.json.title) || {};
  ok('… batting and bowling: his semi-final wicket counts too (1 for 14 off 2 overs)', JSON.stringify(T.stats) === JSON.stringify([{ value: '94', label: 'RUNS', sub: '54 BALLS' }, { value: '5', label: 'SIXES' }, { value: '1', label: 'WICKET', sub: '14 RUNS' }, { value: '2.0', label: 'OVERS' }]), T.stats);
  r = await api('POST', '/api/highlights/title', { matchId: MATCH, scope: 'tournament', clipIds: [ids.blue, ids['t2-six']], subject: { type: 'team', teamName: 'Gymkhana Sports Club' } }, AUTH);
  T = (r.json && r.json.title) || {};
  ok('a team over the tournament: its matches, runs, sixes, fours (from the scorecards)', T.title === 'Gymkhana Sports Club' && JSON.stringify(T.stats) === JSON.stringify([{ value: '2', label: 'MATCHES' }, { value: '340', label: 'RUNS' }, { value: '5', label: 'SIXES' }, { value: '6', label: 'FOURS' }]) && T.team && T.team.short === 'GSC', T);
  r = await api('POST', '/api/highlights/title', { matchId: MATCH, scope: 'tournament', clipIds: [ids.blue, ids['t2-six']], subject: { type: 'full' } }, AUTH);
  T = (r.json && r.json.title) || {};
  ok('the whole tournament: its name, its matches, every six and four of it', T.title === 'MCA President Cup 2026' && JSON.stringify(T.stats) === JSON.stringify([{ value: '2', label: 'MATCHES' }, { value: '6', label: 'SIXES' }, { value: '9', label: 'FOURS' }]) && Array.isArray(T.teams) && !T.teams.length, T);
  r = await api('POST', '/api/highlights/title', { matchId: MATCH, clipIds: [ids.blue, ids['t2-six']], subject: { type: 'full' } }, AUTH);
  const r4 = await api('POST', '/api/highlights/title', { matchId: MATCH, scope: 'tournament', clipIds: [ids.blue, ids['red-elsewhere']], subject: { type: 'full' } }, AUTH);
  ok('one match\'s video still takes only its clips; a tournament\'s, only its matches\' (never another\'s)', r.status === 400 && /not this match/.test(r.json.error) && r4.status === 400 && /not this tournament/.test(r4.json.error) && JSON.stringify(r4.json.missing) === JSON.stringify([ids['red-elsewhere']]), [r.json, r4.json]);
  const torder = ['t2-six', 'blue', 't2-four'];
  r = await api('POST', '/api/highlights/compile', { matchId: MATCH, scope: 'tournament', type: 'custom', clipIds: torder.map(n => ids[n]), subject: { type: 'player', playerKey: HARSH, category: 'boundaries' }, format: '16:9' }, AUTH);
  ok('a tournament video starts', r.status === 200 && !!r.json.jobId, r.json);
  for(let i = 0; i < 1800; i++){ st = (await api('GET', `/api/highlights/compile/${r.json.jobId}/status`)).json; if(['ready', 'error'].includes(st.status)) break; await wait(100); }
  ok('… ready, every clip in', st.status === 'ready' && st.included === 3, st);
  const tdl = await download(port, `/api/highlights/compile/${r.json.jobId}/download`);
  const tout = path.join(TMP, 'tournament.mp4');
  fs.writeFileSync(tout, tdl.body);
  const tseen = torder.map((n, i) => colourAt(tout, m.edit.intro + (80 / 30) * i + 40 / 30, 1280, 720));
  ok('… the semi-final\'s SIX, then the final\'s SIX, then the semi-final\'s FOUR — in the operator\'s order, across the two matches', JSON.stringify(tseen) === JSON.stringify(['green', 'blue', 'yellow']), tseen);

  console.log('\n=== The scorecard\'s own downloads, unchanged ===');
  r = await api('POST', '/api/highlights/compile', { matchId: MATCH, type: 'full' });
  ok('no sign-in needed, as before', r.status === 200 && !!r.json.jobId, r.json);
  for(let i = 0; i < 1200; i++){ st = (await api('GET', `/api/highlights/compile/${r.json.jobId}/status`)).json; if(['ready', 'error'].includes(st.status)) break; await wait(100); }
  ok('ready, edited, the playable clips in (the missing and broken ones skipped, as before)', st.status === 'ready' && st.edited === true && st.included === 5 && st.skipped === 2, st);
  const dl3 = await download(port, `/api/highlights/compile/${r.json.jobId}/download`);
  await wait(300);
  const gone = await api('GET', `/api/highlights/compile/${r.json.jobId}/status`);
  ok('downloaded once, then cleaned up (as before)', dl3.status === 200 && dl3.body.length > 100000 && gone.status === 404, [dl3.status, gone.status]);

  clipServer.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {} process.exit(1); });
