// 🎬 The pro edit of a downloaded highlights video (highlight-edit.js, and its
// wiring in server.js): real ffmpeg (the server's own @ffmpeg-installer build),
// small generated clips.
//
// - each clip's tag says the right thing (SIX / FOUR / WICKET / a HIGHLIGHT);
// - the title card says who and what (scorecard and tournament downloads);
// - the finished video: title card + clips + end card, every frame on time
//   (no gap or jolt at any join), one continuous soundtrack, 720p / 1080p;
// - the transition: the band covers the whole frame at every cut;
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
const { createHighlightEditor, cardForClip } = require('../highlight-edit.js');
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
  const titleCode = [H.grabConst('PRO_PILL'), H.grabConst('PRO_KIND'), H.grabConst('proVs'), H.grabConst('SINGLE_MATCHES_LEAGUE_KEY'), H.grab('personName'), H.grab('playerKey'),
    H.grab('proCountsLine'), H.grab('proPlayerName'), H.grab('proMatchContext', 'async function '), H.grab('proTitleForMatchCompile', 'async function '),
    'return { proCountsLine, proPlayerName, proTitleForMatchCompile };'].join('\n');
  const records = H.coll([{ matchId: 'm-1', roomId: 'room-1', ownerUid: 'u1', leagueKey: 'mca', matchTitle: 'League Match',
    teamA: { name: 'Parel Sporting Club', short: 'PSC' }, teamB: { name: 'MIG Cricket Club', short: 'MIG' } }]);
  const leagues = H.coll([{ ownerUid: 'u1', leagueKey: 'mca', displayName: 'MCA President Cup 2026' }]);
  const T = new Function('matchRecordsCollection', 'leaguesCollection', titleCode)(records, leagues);
  const clipsX = [{ eventType: 'SIX', strikerKey: 'harsh rane', strikerName: 'Harsh Rane' }, { eventType: 'SIX' }, { eventType: 'FOUR' }, { eventType: 'WICKET', bowlerKey: 'alim', bowlerName: 'Alim' }];
  eq('what is in the video, counted', T.proCountsLine(clipsX), '2 SIXES  ·  1 FOUR  ·  1 WICKET');
  eq('a player\'s name as the clips spell it', [T.proPlayerName(clipsX, 'harsh rane'), T.proPlayerName(clipsX, 'alim')], ['Harsh Rane', 'Alim']);
  eq('a player\'s sixes in one match: tournament · match / name / ALL SIXES / counts · teams',
    await T.proTitleForMatchCompile({ type: 'player', playerKey: 'Harsh Rane', category: 'sixes' }, 'room-1', clipsX.slice(0, 2)),
    { kicker: 'MCA President Cup 2026  ·  League Match', title: 'Harsh Rane', pill: 'ALL SIXES', meta: '2 SIXES  ·  PSC vs MIG', kind: 'SIX' });
  eq('a team\'s fours', (await T.proTitleForMatchCompile({ type: 'fours', team: 'B' }, 'room-1', [{ eventType: 'FOUR' }])).title, 'MIG Cricket Club');
  eq('the whole match', await T.proTitleForMatchCompile({ type: 'full' }, 'room-1', clipsX),
    { kicker: 'MCA President Cup 2026  ·  League Match', title: 'Parel Sporting Club vs MIG Cricket Club', pill: 'FULL MATCH HIGHLIGHTS', meta: '2 SIXES  ·  1 FOUR  ·  1 WICKET  ·  PSC vs MIG', kind: 'BRAND' });
  eq('a match the database does not know: still a title', (await T.proTitleForMatchCompile({ type: 'wickets' }, 'nope', [{ eventType: 'WICKET' }])).pill, 'ALL WICKETS');

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
  const title = { kicker: 'MCA President Cup 2026', title: 'Harsh Rane', pill: 'All highlights', meta: '1 six · 1 four · 1 wicket', kind: 'SIX' };
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
  eq('at every cut the band covers the frame (dark navy, not the bright picture)', lumas.every(l => l < 45), true);
  eq('… and between cuts the clip itself shows', lumaAt(out, cuts[0] + 1.5) > 60, true);
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

  console.log('\n=== The server job ===');
  const jobCode = [H.grabConst('HIGHLIGHT_PRO_ON'), H.grabConst('HIGHLIGHT_PRO_MAX_CLIPS'), H.grab('setCompileJob'), H.grab('chronologicalClipOrder'), H.grab('dedupeClipsById'),
    H.grab('concatClipsToFile'), H.grab('getHighlightEditor'), H.grab('proClipKey'), H.grab('runCompileJob', 'async function '),
    'return { runCompileJob };'].join('\n');
  const fluent = require('fluent-ffmpeg'); fluent.setFfmpegPath(ffmpegPath);
  const files = { c1: clipA, c2: clipB };
  function makeJob(editor){
    const compileJobs = new Map();
    const deps = {
      process: { env: {} }, fs, path, ffmpeg: fluent, ffmpegInstallerPath: ffmpegPath, HIGHLIGHTS_TMP_DIR: path.join(tmp, 'jobs'),
      createHighlightEditor: () => editor, cardForClip, compileJobs, highlightEditor: null, console: { log: () => {} },
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

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
