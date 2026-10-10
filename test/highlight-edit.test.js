// 🎬 The pro edit of a downloaded highlights video (highlight-edit.js, and its
// wiring in server.js): real ffmpeg (the server's own @ffmpeg-installer build),
// small generated clips.
//
// - each clip's tag says the right thing (SIX / FOUR / WICKET / a HIGHLIGHT);
// - the title card says who and what, with the player's team and figures
//   (runs, balls, fours, sixes / wickets, overs) — scorecard and tournament;
// - the finished video: title card + clips + end card, every frame on time
//   (no gap or jolt at any join), one continuous soundtrack, 720p / 1080p;
// - the transition: the band covers the whole frame at every cut, and it is
//   silent — the title and end cards have no sound, and at a cut there is
//   nothing but the clips' own sound, kept at its own level to its ends;
// - the viewer's options: 9:16 (Reels) — every frame on time, the wheel only
//   ever under the picture — and the animated wagon wheel — from the
//   delivery's own shot, and in 16:9 never over the middle of the picture
//   (where the batter, the bowler and the ball are);
// - an edited clip is cached and reused by the next video;
// - the server job: collecting → editing → ready (edited), and when the edit
//   fails, the plain joined video instead — a download never fails over it.
//
//   node test/highlight-edit.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./cricket/server-harness.js');
const { createHighlightEditor, cardForClip, wheelFor } = require('../highlight-edit.js');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

let pass = 0, fail = 0;
function eq(name, a, b){
  if(JSON.stringify(a) === JSON.stringify(b)){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}
const ff = (args) => { const r = spawnSync(ffmpegPath, ['-hide_banner', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return r.stderr || ''; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-edit-test-'));
// A clip like the clipper's: H.264 + AAC (or no sound at all).
function makeClip(name, { w = 640, h = 360, fps = 30, sec = 3.2, tone = 440, audio = true } = {}){
  const f = path.join(tmp, name);
  ff(['-y', '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=${fps}:d=${sec}`, ...(audio ? ['-f', 'lavfi', '-i', `sine=f=${tone}:r=48000:d=${sec}`] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-b:a', '128k'] : []), '-shortest', f]);
  return f;
}
// Every frame's time, and the decoded audio, of a finished video.
function frameTimes(file){
  return ff(['-i', file, '-map', '0:v', '-vf', 'showinfo', '-f', 'null', '-']).split('\n').filter(l => /pts_time/.test(l)).map(l => Number(/pts_time:([\d.]+)/.exec(l)[1]));
}
function audioRuns(file){
  const r = ff(['-i', file, '-map', '0:a', '-af', 'ashowinfo', '-f', 'null', '-']).split('\n').filter(l => /ashowinfo/.test(l) && /pts_time/.test(l))
    .map(l => ({ t: Number(/pts_time:([\d.]+)/.exec(l)[1]), n: Number(/nb_samples:(\d+)/.exec(l)[1]) }));
  let gaps = 0;
  for(let i = 1; i < r.length; i++){ if(Math.abs(r[i].t - (r[i - 1].t + r[i - 1].n / 48000)) > 0.0006) gaps++; }
  return { end: r.length ? r[r.length - 1].t + r[r.length - 1].n / 48000 : 0, gaps };
}
// Mean and peak loudness (dB) of a stretch of a file's sound.
function level(file, t, d){
  const e = ff(['-ss', String(t), '-t', String(d), '-i', file, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-']);
  const mean = /mean_volume: (-?[\d.]+|-inf) dB/.exec(e), max = /max_volume: (-?[\d.]+|-inf) dB/.exec(e);
  const n = (m) => (!m || m[1] === '-inf') ? -120 : Number(m[1]);
  return { mean: n(mean), max: n(max) };
}
// How different two videos are in one region at time t (mean |difference|
// of the luma, 0-255). crop: 'w:h:x:y' (expressions of iw / ih allowed).
function regionDiff(a, b, t, crop){
  const e = ff(['-ss', String(t), '-i', a, '-ss', String(t), '-i', b, '-filter_complex',
    `[0:v]crop=${crop},format=yuv420p[x];[1:v]crop=${crop},format=yuv420p[y];[x][y]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG`, '-frames:v', '1', '-f', 'null', '-']);
  const m = /YAVG=([\d.]+)/.exec(e);
  return m ? Number(m[1]) : NaN;
}
// Mean brightness of the frame at time t (the band is dark navy, the test
// pattern is bright): proof the band covers the frame at a cut.
function lumaAt(file, t){
  const m = /YAVG=([\d.]+)/.exec(ff(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']));
  return m ? Number(m[1]) : NaN;
}

(async () => {
  console.log('\n=== What a clip\'s tag says ===');
  eq('a SIX: the batter, the over and the bowler', cardForClip({ eventType: 'SIX', strikerName: 'Harsh Rane', bowlerName: 'Alim Shaikh', over: 12, ballInOver: 4 }),
    { kind: 'SIX', label: 'SIX', title: 'HARSH RANE', sub: '12.4 OV  ·  OFF ALIM SHAIKH' });
  eq('a FOUR', cardForClip({ eventType: 'FOUR', strikerName: 'Sai', bowlerName: 'Omkar', over: 0, ballInOver: 1 }).sub, '0.1 OV  ·  OFF OMKAR');
  eq('a catch: who was out, who caught it, who bowled it', cardForClip({ eventType: 'WICKET', strikerName: 'Sai', dismissedPlayerName: 'Rushil Parkar', bowlerName: 'Alim Shaikh', fielderName: 'Karsh Kothari', dismissalType: 'Caught', over: 5, ballInOver: 2 }),
    { kind: 'WICKET', label: 'WICKET', title: 'RUSHIL PARKAR', sub: 'CAUGHT KARSH KOTHARI · BOWLED ALIM SHAIKH  ·  5.2 OV' });
  eq('caught and bowled', cardForClip({ eventType: 'WICKET', strikerName: 'X', bowlerName: 'Alim', fielderName: 'Alim', dismissalType: 'Caught', over: 1, ballInOver: 1 }).sub, 'CAUGHT & BOWLED ALIM  ·  1.1 OV');
  eq('bowled / lbw / run out', ['Bowled', 'LBW', 'Run Out'].map(t => cardForClip({ eventType: 'WICKET', strikerName: 'X', bowlerName: 'Alim', fielderName: 'Dev', dismissalType: t, over: 3, ballInOver: 6 }).sub),
    ['BOWLED ALIM  ·  3.6 OV', 'LBW · ALIM  ·  3.6 OV', 'RUN OUT · DEV  ·  3.6 OV']);
  eq('a HIGHLIGHTS-button clip: its outcome is the label', cardForClip({ eventType: 'CLIP', outcomeLabel: 'Wide +4', strikerName: 'Sai', bowlerName: 'Om', over: 7, ballInOver: 1 }),
    { kind: 'HIGHLIGHT', label: 'WIDE +4', title: 'SAI', sub: '7.1 OV  ·  BOWLER OM' });
  eq('text is one clean line (no control characters), never empty', cardForClip({ eventType: 'SIX', strikerName: 'A\nB\u0007C' }).title, 'A B C');

  console.log('\n=== The title card (server.js) ===');
  const titleCode = [H.grabConst('PRO_PILL'), H.grabConst('PRO_KIND'), H.grabConst('proVs'), H.grabConst('proPlural'), H.grabConst('SINGLE_MATCHES_LEAGUE_KEY'), H.grab('personName'), H.grab('playerKey'),
    H.grab('proCountsLine'), H.grab('proPlayerName'), H.grab('proSplitName'), H.grab('proTeam'), H.grab('proPlayerFigures'), H.grab('proStatCells'), H.grab('proTeamCells'),
    H.grab('proMatchContext', 'async function '), H.grab('proTitleForMatchCompile', 'async function '),
    'return { proCountsLine, proPlayerName, proSplitName, proPlayerFigures, proStatCells, proTitleForMatchCompile };'].join('\n');
  const badgeA = 'data:image/png;base64,iVBORw0KGgo=';
  const match1 = { matchId: 'm-1', roomId: 'room-1', ownerUid: 'u1', leagueKey: 'mca', matchTitle: 'League Match', matchResultText: 'PSC won by 16 runs',
    teamA: { name: 'Parel Sporting Club', short: 'PSC', color: '#1d4ed8', logoUrl: badgeA }, teamB: { name: 'MIG Cricket Club', short: 'MIG', logoUrl: 'https://example.com/mig.png' },
    battingCard: { A: [{ name: 'Harsh Rane', runs: 45, balls: 23, fours: 2, sixes: 3 }], B: [{ name: 'Alim', runs: 4, balls: 6, fours: 1, sixes: 0 }] },
    bowlingCard: { A: [{ name: 'Harsh Rane', overs: 1, balls: 0, runs: 12, wickets: 0 }], B: [{ name: 'Alim', overs: 4, balls: 0, runs: 22, wickets: 3 }] },
    scoreA: { runs: 156, wickets: 7, overs: '20.0' }, scoreB: { runs: 140, wickets: 9, overs: '19.4' } };
  const records = H.coll([match1]);
  const leagues = H.coll([{ ownerUid: 'u1', leagueKey: 'mca', displayName: 'MCA President Cup 2026' }]);
  const T = new Function('matchRecordsCollection', 'leaguesCollection', titleCode)(records, leagues);
  const clipsX = [{ eventType: 'SIX', strikerKey: 'harsh rane', strikerName: 'Harsh Rane' }, { eventType: 'SIX' }, { eventType: 'FOUR' }, { eventType: 'WICKET', bowlerKey: 'alim', bowlerName: 'Alim' }];
  eq('what is in the video, counted', T.proCountsLine(clipsX), '2 SIXES  ·  1 FOUR  ·  1 WICKET');
  eq('a player\'s name as the clips spell it', [T.proPlayerName(clipsX, 'harsh rane'), T.proPlayerName(clipsX, 'alim')], ['Harsh Rane', 'Alim']);
  eq('the name on the card: first name small, surname big (one word: just big)', [T.proSplitName('Aadit Bahutule'), T.proSplitName('M S Dhoni'), T.proSplitName('Sai'), T.proSplitName('Rohit Sharma Jr')],
    [{ first: 'Aadit', title: 'Bahutule' }, { first: 'M S', title: 'Dhoni' }, { first: '', title: 'Sai' }, { first: 'Rohit', title: 'Sharma Jr' }]);
  eq('a player\'s sixes in one match: tournament / match / name / ALL SIXES / their batting figures / their team with its badge',
    await T.proTitleForMatchCompile({ type: 'player', playerKey: 'Harsh Rane', category: 'sixes' }, 'room-1', clipsX.slice(0, 2)),
    { kicker: 'MCA President Cup 2026', line: 'PSC vs MIG  ·  League Match', first: 'Harsh', title: 'Rane', pill: 'ALL SIXES', meta: '2 SIXES',
      stats: [{ value: '45', label: 'RUNS', sub: '23 BALLS' }, { value: '3', label: 'SIXES' }, { value: '2', label: 'FOURS' }, { value: '195.7', label: 'STRIKE RATE' }],
      team: { name: 'Parel Sporting Club', short: 'PSC', color: '#1d4ed8', logo: badgeA }, kind: 'SIX' });
  const wk = await T.proTitleForMatchCompile({ type: 'player', playerKey: 'Alim', category: 'wickets' }, 'room-1', clipsX.slice(3));
  eq('a bowler\'s wickets: their bowling figures, their team (a badge given as a link is never fetched)', [wk.title, wk.pill, wk.stats, wk.team],
    ['Alim', 'WICKETS', [{ value: '3', label: 'WICKETS', sub: '22 RUNS' }, { value: '4.0', label: 'OVERS' }, { value: '5.50', label: 'ECONOMY' }], { name: 'MIG Cricket Club', short: 'MIG', color: '', logo: '' }]);
  eq('all of an all-rounder\'s clips: some of both', (await T.proTitleForMatchCompile({ type: 'player', playerKey: 'Alim', category: 'all' }, 'room-1', clipsX.slice(3))).stats,
    [{ value: '4', label: 'RUNS', sub: '6 BALLS' }, { value: '0', label: 'SIXES' }, { value: '3', label: 'WICKETS', sub: '22 RUNS' }, { value: '4.0', label: 'OVERS' }]);
  const fours = await T.proTitleForMatchCompile({ type: 'fours', team: 'B' }, 'room-1', [{ eventType: 'FOUR' }]);
  eq('a team\'s fours: the team, its innings, its badge', [fours.title, fours.stats[0], fours.team && fours.team.name], ['MIG Cricket Club', { value: '140/9', label: 'SCORE', sub: '19.4 OVERS' }, 'MIG Cricket Club']);
  eq('the whole match: both teams (and their badges), the result, both scores', await T.proTitleForMatchCompile({ type: 'full' }, 'room-1', clipsX),
    { kicker: 'MCA President Cup 2026', line: 'League Match  ·  PSC won by 16 runs', title: 'PSC vs MIG', pill: 'FULL MATCH HIGHLIGHTS',
      meta: '2 SIXES  ·  1 FOUR  ·  1 WICKET', stats: [{ value: '156/7', label: 'PSC', sub: '20.0 OVERS' }, { value: '140/9', label: 'MIG', sub: '19.4 OVERS' }],
      teams: [{ name: 'Parel Sporting Club', short: 'PSC', color: '#1d4ed8', logo: badgeA }, { name: 'MIG Cricket Club', short: 'MIG', color: '', logo: '' }], kind: 'BRAND' });
  const lost = await T.proTitleForMatchCompile({ type: 'wickets' }, 'nope', [{ eventType: 'WICKET' }]);
  eq('a match the database does not know: still a title, just no figures', [lost.pill, lost.stats, lost.team], ['ALL WICKETS', [], null]);
  const match2 = { teamA: { name: 'Thane Tigers' }, teamB: { name: 'Parel Sporting Club', short: 'PSC' }, battingCard: { B: [{ name: 'harsh  rane', runs: 12, balls: 10, fours: 1, sixes: 1 }] } };
  const tf = T.proPlayerFigures([match1, match2], 'harsh rane');
  eq('a tournament: the figures add up over the matches the player played, the team is the latest',
    [tf.matches, tf.bat, tf.team.name, T.proStatCells(tf, 'boundaries')[0]], [2, { runs: 57, balls: 33, fours: 3, sixes: 4 }, 'Parel Sporting Club', { value: '57', label: 'RUNS', sub: '33 BALLS' }]);

  console.log('\n=== The download options and the wheel data (server.js) ===');
  const optCode = [H.grabConst('SHOT_ZONES'), H.grab('sanitizeShot'), H.grab('proOptionsFrom'), H.grab('proWheelData', 'async function '), 'return { proOptionsFrom, proWheelData };'].join('\n');
  const balls = H.coll([
    { matchId: 'm-1', ballUid: 'u1', innings: 1, over: 12, ballInOver: 4, kind: '6', runs: 6, shot: { zone: 'midwicket', depth: 'deep', hand: 'R', x: 0.62, y: 0.55 } },
    { matchId: 'm-1', ballUid: 'u2', innings: 1, over: 14, ballInOver: 1, kind: '4', runs: 4 },
    { matchId: 'm-1', innings: 1, over: 17, ballInOver: 3, kind: 'W', runs: 0, dismissal: { type: 'Caught' }, shot: { zone: 'midon', depth: 'deep', hand: 'R', x: 0.25, y: 0.78 }, timestamp: 2 },
    { matchId: 'm-1', innings: 1, over: 17, ballInOver: 3, kind: 'Wd', runs: 1, timestamp: 3 }
  ]);
  const O = new Function('ballsCollection', optCode)(balls);
  eq('options: 9:16 and the wheel when asked; 16:9 and no wheel otherwise', [O.proOptionsFrom({ format: '9:16', wheel: true }), O.proOptionsFrom({}), O.proOptionsFrom({ format: 'square', wheel: 'yes' }), O.proOptionsFrom({ wheel: 'true' })],
    [{ format: '9:16', wheel: true }, { format: '16:9', wheel: false }, { format: '16:9', wheel: false }, { format: '16:9', wheel: true }]);
  const wd = await O.proWheelData([{ _id: 'c1', matchId: 'm-1', deliveryId: 'u1', eventType: 'SIX' }, { _id: 'c2', matchId: 'm-1', deliveryId: 'u2', eventType: 'FOUR' },
    { _id: 'c3', matchId: 'm-1', innings: 1, over: 17, ballInOver: 3, eventType: 'WICKET' }, { _id: 'c4', matchId: 'm-1', deliveryId: 'gone', eventType: 'SIX' }]);
  eq('each clip gets ITS delivery\'s shot: by its delivery id; an older clip by over.ball and only a delivery of its kind (never the wide after the wicket)',
    [wd.get('c1'), wd.get('c2'), wd.get('c3'), wd.has('c4')],
    [{ event: 'SIX', runs: 6, how: '', shot: { zone: 'midwicket', depth: 'deep', hand: 'R', x: 0.62, y: 0.55 } }, { event: 'FOUR', runs: 4, how: '', shot: null },
      { event: 'WICKET', runs: 0, how: 'Caught', shot: { zone: 'midon', depth: 'deep', hand: 'R', x: 0.25, y: 0.78 } }, false]);
  eq('what the wheel draws: a six to the rope, a catch where it was taken, a bowled at the stumps, a four with no shot marked — none',
    [wheelFor(wd.get('c1')), wheelFor(wd.get('c3')), wheelFor({ event: 'WICKET', how: 'Bowled' }), wheelFor(wd.get('c2')), wheelFor({ event: 'CLIP', runs: 2, shot: { zone: 'cover', depth: 'inner', hand: 'R', x: -0.3, y: 0.1 } }).label],
    [{ kind: 'SIX', end: [74.8, 66.4], label: 'SIX  ·  DEEP MID-WICKET', mark: '6' }, { kind: 'WICKET', end: [25, 78], label: 'CAUGHT  ·  LONG-ON', mark: 'W' },
      { kind: 'WICKET', end: null, label: 'BOWLED', mark: 'W' }, null, '2 RUNS  ·  COVER']);

  console.log('\n=== The finished video ===');
  const clipA = makeClip('a.mp4', { tone: 330 }), clipB = makeClip('b.mp4', { tone: 440, sec: 2.9 }), clipC = makeClip('c.mp4', { audio: false, fps: 25, sec: 2.7 });
  const cacheDir = path.join(tmp, 'cache'), workDir = path.join(tmp, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  const ed = createHighlightEditor({ ffmpegPath, cacheDir, threads: 2 });
  const clips = [
    { file: clipA, clipKey: 'a|1', card: cardForClip({ eventType: 'SIX', strikerName: 'Harsh Rane', bowlerName: 'Alim', over: 1, ballInOver: 2 }) },
    { file: clipB, clipKey: 'b|1', card: cardForClip({ eventType: 'FOUR', strikerName: 'Sai', bowlerName: 'Om', over: 2, ballInOver: 3 }) },
    { file: clipC, clipKey: 'c|1', card: cardForClip({ eventType: 'WICKET', dismissedPlayerName: 'Dev', bowlerName: 'Om', dismissalType: 'Bowled', over: 4, ballInOver: 1 }) }
  ];
  const badgeFile = path.join(tmp, 'badge.png');
  ff(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=96x96', '-frames:v', '1', badgeFile]);
  const title = { kicker: 'MCA President Cup 2026', line: 'PSC vs MIG  ·  League Match', first: 'Harsh', title: 'Rane', pill: 'All highlights', meta: '1 six · 1 four · 1 wicket',
    stats: [{ value: '45', label: 'Runs', sub: '23 balls' }, { value: '3', label: 'Sixes' }, { value: '2', label: 'Fours' }, { value: '195.7', label: 'Strike rate' }],
    team: { name: 'Parel Sporting Club', short: 'PSC', color: '#1d4ed8', logo: 'data:image/png;base64,' + fs.readFileSync(badgeFile).toString('base64') }, kind: 'SIX' };
  const out = path.join(tmp, 'out.mp4');
  const steps = [];
  let t0 = Date.now();
  const r = await ed.renderHighlight({ clips, title, out, workDir, onProgress: (f, m) => steps.push([f, m]) });
  const firstMs = Date.now() - t0;
  eq('720p for small clips, 30 fps (a 25 fps clip among 30 fps ones is brought to 30)', r.profile.key, '1280x720p30');
  const info = ff(['-i', out]);
  eq('one H.264 video + one AAC sound track, faststart MP4', [/Video: h264/.test(info), /Audio: aac/.test(info), /1280x720/.test(info)], [true, true, true]);
  const times = frameTimes(out);
  // title card + each clip cut down to whole 16-frame spans (0.533 s — whole AAC frames too) + end card
  const cardF = ed.cardFrames(r.profile);
  const clipF = await Promise.all(clips.map(async c => ed.framesOf(await ed.probe(c.file), r.profile)));
  const expected = cardF.intro + clipF.reduce((n, f) => n + f, 0) + cardF.outro;
  eq('every frame there: title card, the three clips (cut to the grid), end card', [times.length, clipF.every(f => f % 16 === 0)], [expected, true]);
  const steps30 = times.slice(1).map((t, i) => t - times[i]);
  eq('every frame exactly 1/30 s after the last — no gap or jolt at any join', steps30.every(d => Math.abs(d - 1 / 30) < 0.002), true);
  const a = audioRuns(out);
  eq('one unbroken soundtrack, as long as the picture (a clip with no sound gets silence)', [a.gaps, Math.abs(a.end - expected / 30) < 0.03], [0, true]);
  const cuts = [];
  let at = cardF.intro;
  cuts.push(at / 30);
  clipF.forEach(f => { at += f; cuts.push(at / 30); });
  const lumas = cuts.map(t => lumaAt(out, t - 0.017));
  eq('at every cut the band covers the frame (dark navy, not the bright picture)', lumas.every(l => l < 50), true);
  eq('… and between cuts the clip itself shows', lumaAt(out, cuts[0] + 1.5) > 60, true);
  // The sound: the clips' own, nothing added (no whoosh), kept to their ends.
  const src = level(clipA, 1.0, 1.0);
  const lv = { intro: level(out, 0.1, cuts[0] - 0.2), mid: level(out, cuts[0] + 1.0, 1.0), cut: level(out, cuts[1] - 0.3, 0.6), end: level(out, cuts[1] - 0.3, 0.15),
    silentClip: level(out, cuts[2] + 0.4, (clipF[2] / 30) - 0.8), outro: level(out, cuts[3] + 0.05, cardF.outro / 30 - 0.1) };
  eq('the title card, the clip with no sound and the end card are silent', [lv.intro.mean < -70, lv.silentClip.mean < -70, lv.outro.mean < -70], [true, true, true]);
  eq('a clip\'s sound is its own, at its own level', Math.abs(lv.mid.mean - src.mean) < 1, true);
  eq('across a cut: nothing louder than the clips themselves (no transition sound)', lv.cut.max <= Math.max(src.max, level(clipB, 1.0, 1.0).max) + 1, true);
  eq('… and a clip keeps its full sound right up to the cut (only a click-guard fade)', Math.abs(lv.end.mean - src.mean) < 1.5, true);
  eq('progress runs forwards to the end, with words', [steps.every((s, i) => i === 0 || s[0] >= steps[i - 1][0]), steps[steps.length - 1][0], /Editing clip 1 of 3/.test(steps.map(s => s[1]).join('|'))], [true, 1, true]);

  console.log('\n=== Cached clips ===');
  const segFiles = fs.readdirSync(path.join(cacheDir, 'segments')).filter(n => /\.mkv$/.test(n) && !/\.part\./.test(n));
  eq('each edited clip is kept for the next video', segFiles.length, 3);
  t0 = Date.now();
  const out2 = path.join(tmp, 'out2.mp4');
  await ed.renderHighlight({ clips: [clips[1], clips[0]], title, out: out2, workDir, onProgress: () => {} });
  const secondMs = Date.now() - t0;
  eq('a later video with those clips reuses them (no new segment, much faster)', [fs.readdirSync(path.join(cacheDir, 'segments')).filter(n => /\.mkv$/.test(n)).length, secondMs < firstMs * 0.75], [3, true]);
  const changed = [{ ...clips[0], card: cardForClip({ eventType: 'SIX', strikerName: 'Someone Else', over: 1, ballInOver: 2 }) }];
  await ed.renderHighlight({ clips: changed, title, out: path.join(tmp, 'out3.mp4'), workDir, onProgress: () => {} });
  eq('a clip re-labelled (another player) is edited again, never shown with the old tag', fs.readdirSync(path.join(cacheDir, 'segments')).filter(n => /\.mkv$/.test(n)).length, 4);

  console.log('\n=== With the wagon wheel (16:9) ===');
  // clips as long as a real one's tail: the wheel draws WHEEL_LEAD s before the end
  const longA = makeClip('la.mp4', { sec: 9, tone: 330 }), longB = makeClip('lb.mp4', { sec: 9, tone: 440 });
  const wheelClips = [
    { file: longA, clipKey: 'la|1', card: cardForClip({ eventType: 'SIX', strikerName: 'Harsh Rane', bowlerName: 'Alim', over: 1, ballInOver: 2 }), wheel: wd.get('c1') },
    { file: longB, clipKey: 'lb|1', card: cardForClip({ eventType: 'WICKET', dismissedPlayerName: 'Dev', bowlerName: 'Om', dismissalType: 'Caught', over: 4, ballInOver: 1 }), wheel: wd.get('c3') }
  ];
  const plain = path.join(tmp, 'plain.mp4'), wheeled = path.join(tmp, 'wheeled.mp4');
  await ed.renderHighlight({ clips: wheelClips, title, out: plain, workDir, onProgress: () => {} });
  const rw = await ed.renderHighlight({ clips: wheelClips, title, out: wheeled, workDir, wheel: true, onProgress: () => {} });
  const p16 = rw.profile, nA = ed.framesOf(await ed.probe(longA), p16), introEnd = ed.cardFrames(p16).intro / 30, endA = introEnd + nA / 30;
  const shotAt = endA - ed.layout.wheelLead, late = endA - 0.6, early = introEnd + 1.0;
  const wp = ed.layout.wheelPlace(p16, { cw: p16.w, ch: p16.h, y: 0 });
  const corner = `${wp.D}:${wp.D}:${wp.x}:${wp.y}`;
  eq('the wheel is in the top left corner, there only once the shot is over (not while the tag shows, not before)',
    [regionDiff(plain, wheeled, early, corner) < 1.5, regionDiff(plain, wheeled, shotAt - 0.8, corner) < 1.5, regionDiff(plain, wheeled, late, corner) > 8], [true, true, true]);
  eq('… and never over the middle of the picture, where the batter, the bowler and the ball are',
    regionDiff(plain, wheeled, late, 'iw*0.6:ih*0.6:iw*0.2:ih*0.2') < 1.5, true);
  const tw = frameTimes(wheeled);
  eq('every frame there and on time, as without the wheel', [tw.length, tw.slice(1).every((t, i) => Math.abs(t - tw[i] - 1 / 30) < 0.002)], [frameTimes(plain).length, true]);

  console.log('\n=== 9:16 (Reels) ===');
  const reel = path.join(tmp, 'reel.mp4');
  const rr = await ed.renderHighlight({ clips: wheelClips, title, out: reel, workDir, format: '9:16', wheel: true, onProgress: () => {} });
  const pr = rr.profile, rinfo = ff(['-i', reel]);
  eq('stood on end: 720 x 1280, 30 fps, H.264 + AAC', [pr.key, rr.format, /720x1280/.test(rinfo), /Audio: aac/.test(rinfo)], ['720x1280p30', '9:16', true, true]);
  const tr = frameTimes(reel), ar = audioRuns(reel);
  const expR = ed.cardFrames(pr).intro + (await Promise.all(wheelClips.map(async c => ed.framesOf(await ed.probe(c.file), pr)))).reduce((n, f) => n + f, 0) + ed.cardFrames(pr).outro;
  eq('every frame there and on time, one unbroken soundtrack', [tr.length, tr.slice(1).every((t, i) => Math.abs(t - tr[i] - 1 / 30) < 0.002), ar.gaps, Math.abs(ar.end - expR / 30) < 0.03], [expR, true, 0, true]);
  const box = ed.layout.portraitBox(pr, true), wr = ed.layout.wheelPlace(pr, box);
  eq('the whole 16:9 picture across the width, the wheel wholly under it, inside the frame',
    [box.cw, box.ch, wr.y >= box.y + box.ch, wr.y + wr.D + wr.labelSize * 1.3 + 2 * wr.lb <= pr.h], [720, 406, true, true]);
  eq('without the wheel the picture sits in the middle (to the even pixel)', Math.abs(ed.layout.portraitBox(pr, false).y - (1280 - 406) / 2) <= 1, true);

  console.log('\n=== The server job ===');
  const jobCode = [H.grabConst('HIGHLIGHT_PRO_ON'), H.grabConst('HIGHLIGHT_PRO_MAX_CLIPS'), H.grabConst('SHOT_ZONES'), H.grab('setCompileJob'), H.grab('chronologicalClipOrder'), H.grab('dedupeClipsById'),
    H.grab('concatClipsToFile'), H.grab('getHighlightEditor'), H.grab('proClipKey'), H.grab('sanitizeShot'), H.grab('proWheelData', 'async function '), H.grab('runCompileJob', 'async function '),
    'return { runCompileJob };'].join('\n');
  const fluent = require('fluent-ffmpeg'); fluent.setFfmpegPath(ffmpegPath);
  const files = { c1: clipA, c2: clipB };
  function makeJob(editor){
    const compileJobs = new Map();
    const deps = {
      process: { env: {} }, fs, path, ffmpeg: fluent, ffmpegInstallerPath: ffmpegPath, HIGHLIGHTS_TMP_DIR: path.join(tmp, 'jobs'),
      createHighlightEditor: () => editor, cardForClip, compileJobs, highlightEditor: null, console: { log: () => {} }, ballsCollection: balls,
      downloadClipToTemp: async (clip, dir, i) => { await new Promise(r => setTimeout(r, 60)); const f = path.join(dir, `clip_${i}.mp4`); fs.copyFileSync(files[clip.clipId], f); return f; }
    };
    fs.mkdirSync(deps.HIGHLIGHTS_TMP_DIR, { recursive: true });
    const api = new Function(...Object.keys(deps), jobCode)(...Object.values(deps));
    return { compileJobs, run: api.runCompileJob };
  }
  const docs = [{ _id: 'x2', clipId: 'c2', eventType: 'FOUR', strikerName: 'Sai', over: 2, ballInOver: 1, innings: 1 }, { _id: 'x1', clipId: 'c1', eventType: 'SIX', strikerName: 'Harsh', over: 1, ballInOver: 1, innings: 1 }];
  const seen = [];
  const watching = (J, id) => { const iv = setInterval(() => { const j = J.compileJobs.get(id); if(j && seen[seen.length - 1] !== j.status) seen.push(j.status); }, 15); return () => clearInterval(iv); };
  let J = makeJob(ed);
  J.compileJobs.set('job1', { status: 'queued', progress: 0, createdAt: Date.now() });
  let stop = watching(J, 'job1');
  await J.run('job1', docs, { makeTitle: async (cl) => ({ title: 'Test', pill: 'All', meta: `${cl.length} clips`, kind: 'BRAND' }) });
  stop();
  let job = J.compileJobs.get('job1');
  if(seen[seen.length - 1] !== job.status) seen.push(job.status);
  eq('a download with the edit: collecting → editing → ready, marked edited', [seen.filter(x => x !== 'queued'), job.status, job.edited, job.included], [['collecting', 'editing', 'ready'], 'ready', true, 2]);
  eq('… and its video is there, with the title card in front', [fs.existsSync(job.outFile), frameTimes(job.outFile).length > 2 * 80], [true, true]);

  const broken = { queueLength: () => 0, renderHighlight: async () => { throw new Error('ffmpeg exploded'); } };
  J = makeJob(broken);
  J.compileJobs.set('job2', { status: 'queued', progress: 0, createdAt: Date.now() });
  await J.run('job2', docs, { title: { title: 'X' } });
  job = J.compileJobs.get('job2');
  eq('the edit fails: the plain joined video instead (never a failed download)', [job.status, !!job.edited, fs.existsSync(job.outFile)], ['ready', false, true]);
  J = makeJob(broken);
  J.compileJobs.set('job3', { status: 'queued', progress: 0, createdAt: Date.now() });
  await J.run('job3', docs);
  job = J.compileJobs.get('job3');
  eq('the zip / no-edit path is untouched: joined plain', [job.status, !!job.edited], ['ready', false]);

  let asked = null;
  const spy = { queueLength: () => 0, renderHighlight: async (a) => { asked = a; fs.copyFileSync(clipA, a.out); return {}; } };
  J = makeJob(spy);
  J.compileJobs.set('job4', { status: 'queued', progress: 0, createdAt: Date.now() });
  await J.run('job4', [{ ...docs[1], matchId: 'm-1', deliveryId: 'u1' }, { ...docs[0], matchId: 'm-1', deliveryId: 'u2' }], { title: { title: 'X' }, format: '9:16', wheel: true });
  job = J.compileJobs.get('job4');
  eq('9:16 + wheel asked: the editor gets them, each clip with its delivery\'s shot; the job says what it made',
    [asked.format, asked.wheel, asked.clips.map(c => c.wheel && c.wheel.event), asked.clips[0].wheel.shot.zone, job.format, job.wheel], ['9:16', true, ['SIX', 'FOUR'], 'midwicket', '9:16', true]);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
