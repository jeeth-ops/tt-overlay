// The Highlight Studio tests' match: real clips made by ffmpeg (a plain colour
// each, so a finished video's order can be read from its pictures; one sharp
// then blurred; one that is not a video at all; one gone from the CDN), served
// over HTTP the way R2 serves them, and the match, its league and its panel
// state to seed the in-memory MongoDB with.
//
//   const fx = await studioFixtures(TMP, { extra: 300 });
//   const { port } = await bootServer({ idTokens: fx.tokens, users: F.EMAIL_OF, seed: fx.seed });
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const F = require('./merge-fixtures.js');
const { ObjectId } = require('mongodb');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ff = (args) => spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });

const COLOURS = { red: 'ff2020', green: '20d040', blue: '2050ff', yellow: 'ffe020' };
const MATCH = 'm-studio-1', PRIVATE_MATCH = 'm-private-1';

async function studioFixtures(TMP, opts) {
  opts = opts || {};
  const CLIPS = path.join(TMP, 'served');
  fs.mkdirSync(CLIPS, { recursive: true });
  for (const [n, hex] of Object.entries(COLOURS)) {
    ff(['-f', 'lavfi', '-i', `color=c=0x${hex}:s=640x360:r=30:d=3.2`, '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3.2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(CLIPS, n + '.mp4')]);
    ff(['-f', 'lavfi', '-i', `color=c=0x${hex}:s=320x180`, '-frames:v', '1', path.join(CLIPS, n + '.jpg')]);
  }
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=330:r=48000:d=6',
    '-vf', "boxblur=enable='gte(t,3)':luma_radius=12:luma_power=3", '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(CLIPS, 'detail.mp4')]);
  fs.writeFileSync(path.join(CLIPS, 'corrupt.mp4'), require('crypto').randomBytes(40000));
  // a team logo: a round badge PNG (a data URL, as the panel stores it)
  const LOGO_FILE = path.join(TMP, 'logo.png');
  ff(['-f', 'lavfi', '-i', 'color=c=0x1e40af:s=96x96', '-vf', "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-48,Y-48),44),255,0)'", '-frames:v', '1', LOGO_FILE]);
  const LOGO = 'data:image/png;base64,' + fs.readFileSync(LOGO_FILE).toString('base64');

  const served = [];
  const clipServer = http.createServer((req, res) => {
    const f = path.join(CLIPS, path.basename(req.url.split('?')[0]));
    served.push(path.basename(req.url));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => clipServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${clipServer.address().port}/c/`;

  const ids = {};
  const tokens = {
    'work-token': { uid: F.USERS.work.uid, email: F.USERS.work.email },
    'owner-token': { uid: F.USERS.owner.uid, email: F.USERS.owner.email },
    'other-token': { uid: F.USERS.other.uid, email: F.USERS.other.email }
  };
  function clipDoc(name, over, ball, ev, extra) {
    const _id = new ObjectId();
    ids[name] = String(_id);
    const file = COLOURS[name] ? name : name === 'detail' || name === 'corrupt' || name === 'gone' ? name : 'red';
    return Object.assign({ _id, clipId: 'clip-' + name, matchId: MATCH, ownerUid: F.USERS.work.uid, eventType: ev, innings: 1, over, ballInOver: ball, battingTeam: 'A',
      strikerName: 'Harsh Mendon', strikerKey: F.pk('Harsh Mendon'), bowlerName: 'Yogesh Pawar', bowlerKey: F.pk('Yogesh Pawar'), runs: ev === 'SIX' ? 6 : ev === 'FOUR' ? 4 : 0,
      r2Key: `clips/${MATCH}/${name}.mp4`, r2Url: `${base}${file}.mp4`, r2PosterUrl: COLOURS[name] ? `${base}${name}.jpg` : null, r2UploadedAt: '2026-11-01T10:00:00Z',
      status: 'COMPLETE', r2Status: 'done', isHighlight: true, clipSeconds: name === 'detail' ? 6 : 3.2, createdAt: new Date(Date.UTC(2026, 10, 1, 10, over, ball)) }, extra || {});
  }
  const clips = [
    clipDoc('red', 1, 2, 'SIX'), clipDoc('green', 3, 4, 'FOUR'), clipDoc('blue', 5, 1, 'SIX'),
    clipDoc('yellow', 7, 2, 'WICKET', { dismissalType: 'Caught', fielderName: 'Sai Kumar', fielderKey: F.pk('Sai Kumar'), dismissedPlayerName: 'Rohit Patil', dismissedPlayerKey: F.pk('Rohit Patil'), strikerName: 'Rohit Patil', strikerKey: F.pk('Rohit Patil'), battingTeam: 'B', innings: 2, over: 2 }),
    clipDoc('detail', 9, 3, 'FOUR'),
    clipDoc('gone', 11, 1, 'FOUR'),          // not on the CDN any more (and no Drive copy)
    clipDoc('corrupt', 12, 5, 'SIX'),        // there, but not a video
    clipDoc('hidden', 2, 2, 'CLIP', { isHighlight: false })   // a commentary-only clip: never in the studio
  ];
  // a long list for the library (they are never rendered): later overs of innings 2
  for (let i = 0; i < (opts.extra || 0); i++) {
    const ev = ['SIX', 'FOUR', 'WICKET', 'FOUR'][i % 4];
    clips.push(clipDoc('x' + i, 20 + Math.floor(i / 6), 1 + (i % 6), ev, { innings: 2, battingTeam: 'B', strikerName: `Batter ${i % 11}`, strikerKey: F.pk(`Batter ${i % 11}`), r2PosterUrl: `${base}${['red', 'green', 'blue', 'yellow'][i % 4]}.jpg`, clipId: 'clip-x' + i }));
  }
  const elsewhere = Object.assign(clipDoc('red-elsewhere', 4, 4, 'SIX'), { matchId: 'another-match' });
  clips.push(elsewhere);

  async function seed(m) {
    const c = F.collections(m);
    await c.leagues.insertOne({ ownerUid: F.USERS.work.uid, leagueKey: 'mca', displayName: 'MCA President Cup 2026' });
    await c.leagues.insertOne({ ownerUid: F.USERS.owner.uid, leagueKey: 'mine', displayName: 'My Private Cup' });
    await c.records.insertOne({ matchId: MATCH, roomId: MATCH, ownerUid: F.USERS.work.uid, leagueKey: 'mca', matchTitle: 'Final', venue: 'Azad Maidan',
      teamA: { name: 'Gymkhana Sports Club', short: 'GSC', color: '#1e40af', logoUrl: LOGO }, teamB: { name: 'DY Patil', short: 'DYP', color: '#b91c1c', logoUrl: '' },
      battingCard: { A: [{ name: 'Harsh Mendon', runs: 64, balls: 34, fours: 5, sixes: 2 }], B: [{ name: 'Rohit Patil', runs: 12, balls: 15, fours: 1, sixes: 0 }] },
      bowlingCard: { A: [], B: [{ name: 'Yogesh Pawar', overs: '4', balls: 0, runs: 31, wickets: 1 }] },
      scoreA: { runs: 180, wickets: 4, overs: '20' }, scoreB: { runs: 150, wickets: 9, overs: '20' }, matchResultText: 'GSC won by 30 runs' });
    await c.records.insertOne({ matchId: PRIVATE_MATCH, roomId: PRIVATE_MATCH, ownerUid: F.USERS.owner.uid, leagueKey: 'mine', matchTitle: 'Private', teamA: { name: 'P1' }, teamB: { name: 'P2' } });
    await c.panelStates.insertOne({ matchId: MATCH, state: { teamA: { name: 'Gymkhana Sports Club', logoUrl: LOGO, logoStyle: 'circle', logoBg: '#ffd700' }, teamB: { name: 'DY Patil', logoUrl: '' } } });
    for (const d of clips) await c.clips.insertOne(d);
  }
  return { clipServer, served, ids, MATCH, PRIVATE_MATCH, tokens, LOGO, clips, elsewhere, seed, ffmpegPath };
}

// the video's colour at time t, read in a patch right of centre (where no tag is)
function colourAt(file, t, w, h) {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `crop=24:24:${Math.round(w * 0.74)}:${Math.round(h * 0.36)}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 20 });
  const px = r.stdout, n = px.length / 3;
  if (!n) return '?';
  const m = [0, 0, 0];
  for (let i = 0; i < px.length; i += 3) { m[0] += px[i]; m[1] += px[i + 1]; m[2] += px[i + 2]; }
  const [R, G, B] = m.map(v => v / n);
  if (R > 150 && G > 150 && B < 110) return 'yellow';
  if (R > 150 && G < 110 && B < 110) return 'red';
  if (G > 140 && R < 120 && B < 140) return 'green';
  if (B > 150 && R < 120) return 'blue';
  return `?(${Math.round(R)},${Math.round(G)},${Math.round(B)})`;
}
function probeFile(file) {
  const e = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr || '';
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(e), v = /Video:[^\n]*?\b(\d{3,4})x(\d{3,4})\b/.exec(e);
  return { duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]) : 0, w: v ? +v[1] : 0, h: v ? +v[2] : 0, audio: /Audio:/.test(e) };
}

module.exports = { studioFixtures, colourAt, probeFile, MATCH, PRIVATE_MATCH, COLOURS };
