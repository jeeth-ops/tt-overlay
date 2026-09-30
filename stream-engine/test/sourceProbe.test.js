// The source probe's analysis — pure functions, no ffmpeg needed. The same
// functions run against real ffmpeg in test/pipelineSimulation.test.js.
//
// Run: node stream-engine/test/sourceProbe.test.js
const assert = require('assert');
const sp = require('../sourceProbe');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// Synthetic frame logs: `n` frames delivered at `arrive` fps, stamped at
// `stamp` fps, with a repeated frame every `dupEvery` (0 = none).
function frames({ n = 300, arrive = 60, stamp = arrive, dupEvery = 0, dropAt = [] } = {}) {
  const out = [];
  let content = 0;
  for (let i = 0; i < n; i++) {
    if (dropAt.includes(i)) continue;
    const repeated = dupEvery && i % dupEvery === dupEvery - 1;
    if (!repeated) content++;
    out.push({ wallMs: 1000 + (i * 1000) / arrive, pts: i / stamp, checksum: `C${content}`, scan: 'P' });
  }
  return out;
}

console.log('\nparsing what ffmpeg says');

test('the dshow stream line gives the NEGOTIATED format, field order included', () => {
  const t = "[info] Input #0, dshow, from 'video=AVMATRIX USB Capture Video':\n[info]   Stream #0:0: Video: rawvideo (YUY2 / 0x32595559), yuyv422(tv, bt709, top first), 1920x1080, 60.0002 fps, 60 tbr, 10000k tbn\n[info] Stream mapping:";
  const v = sp.parseInputVideoStream(t);
  assert.deepStrictEqual([v.codec, v.fourcc, v.pixFmt, v.width, v.height, v.fps, v.fieldOrder], ['rawvideo', 'YUY2', 'yuyv422', 1920, 1080, 60.0002, 'tff']);
});

test('a webcam MJPEG line parses too', () => {
  const v = sp.parseInputVideoStream('[info]   Stream #0:0: Video: mjpeg (Baseline) (MJPG / 0x47504A4D), yuvj422p(pc, bt470bg/unknown/unknown), 1280x720, 30 fps, 30 tbr, 10000k tbn');
  assert.deepStrictEqual([v.codec, v.pixFmt, v.width, v.height, v.fps], ['mjpeg', 'yuvj422p', 1280, 720, 30]);
});

test('in the compositor the camera is input #2, not the overlay at #0', () => {
  const t = "[info] Input #0, image2pipe, from 'tcp://x':\n[info]   Stream #0:0: Video: png, rgba(pc), 1x1, 15 fps\n[info] Input #1, dshow, from 'audio=m':\n[info]   Stream #1:0: Audio: pcm_s16le, 48000 Hz, stereo, s16\n[info] Input #2, dshow, from 'video=c':\n[info]   Stream #2:0: Video: rawvideo (YUY2 / 0x32595559), yuyv422, 1920x1080, 50 fps\n[info] Stream mapping:";
  assert.strictEqual(sp.parseInputVideoStream(t, 2).width, 1920);
  assert.strictEqual(sp.parseInputAudioStream(t, 1).sampleRate, 48000);
});

test('showinfo lines give pts, scan flag and checksum', () => {
  const f = sp.parseShowinfoLine('[Parsed_showinfo_2 @ 0x1] [info] n:  12 pts: 1234 pts_time:0.2    duration: 1 duration_time:0.04 fmt:yuv420p cl:left sar:1/1 s:64x36 i:T iskey:1 type:I checksum:B72D7B81 plane_checksum:[A B C]');
  assert.deepStrictEqual(f, { n: 12, pts: 0.2, scan: 'T', checksum: 'B72D7B81' });
});

test('the LAST idet summary wins (ffmpeg prints a zeroed one while configuring)', () => {
  const t = 'Multi frame detection: TFF:     0 BFF:     0 Progressive:     0 Undetermined:     0\n...\nMulti frame detection: TFF:   100 BFF:     2 Progressive:     3 Undetermined:     1';
  assert.deepStrictEqual(sp.parseIdet(t), { tff: 100, bff: 2, progressive: 3, undetermined: 1 });
});

console.log('\nmeasuring the source');

test('an honest 60 fps device: 60 arriving, 60 unique, stamps = real time', () => {
  const a = sp.analyseFrames(frames({ arrive: 60 }));
  assert.strictEqual(a.deliveredRate, 60); assert.strictEqual(a.contentRate, 60);
  assert.strictEqual(a.timestampHonesty, 1); assert.strictEqual(a.duplicates.count, 0);
});

test('a 60-only card carrying a 50 Hz camera: 1 repeat in 6 → 50 fps content', () => {
  const a = sp.analyseFrames(frames({ arrive: 60, dupEvery: 6, n: 600 }));
  assert.strictEqual(a.duplicates.cycle, 6);
  assert.strictEqual(a.contentRate, 50);
});

test('a card stamping 50 real frames as 60 → 0.833× — the "plays fast" signature', () => {
  const a = sp.analyseFrames(frames({ arrive: 50, stamp: 60 }));
  assert.ok(Math.abs(a.timestampHonesty - 0.833) < 0.01, String(a.timestampHonesty));
  assert.strictEqual(a.deliveredRate, 50);
});

test('frames missing from the timeline are counted as capture drops', () => {
  const a = sp.analyseFrames(frames({ arrive: 60, dropAt: [100, 101, 200] }));
  assert.strictEqual(a.missingFrames, 3); assert.strictEqual(a.gaps, 2);
});

test('a static picture is reported as such, not as "all frames repeated"', () => {
  const f = frames({ arrive: 30 }).map((x) => ({ ...x, checksum: 'SAME' }));
  const a = sp.analyseFrames(f);
  assert.strictEqual(a.duplicates.staticContent, true); assert.strictEqual(a.duplicates.cycle, null);
});

test('interlace: consistent TFF combing = interlaced; mixed orders = progressive', () => {
  assert.strictEqual(sp.scanVerdict({ tff: 180, bff: 3, progressive: 10, undetermined: 5 }).mode, 'interlaced');
  assert.strictEqual(sp.scanVerdict({ tff: 224, bff: 107, progressive: 0, undetermined: 0 }).mode, 'progressive');
  assert.strictEqual(sp.scanVerdict({ tff: 2, bff: 1, progressive: 200, undetermined: 0 }).mode, 'progressive');
});

console.log('\nthe normalization plan');

const plan = (opts, programFps, scan = { mode: 'progressive' }) => sp.planNormalization(sp.analyseFrames(frames(opts)), scan, { programFps });

test('60 → 30: framestep=2 (by count), never fps=30', () => {
  const p = plan({ arrive: 60 }, 30);
  assert.strictEqual(p.chain, 'framestep=2'); assert.strictEqual(p.cadence, 'clean');
});

test('webcam 30 → 30: passthrough', () => {
  assert.strictEqual(plan({ arrive: 30 }, 30).chain, '');
});

test('50 Hz camera behind a 60 card → 50p: remove the repeats, nothing else', () => {
  const p = plan({ arrive: 60, dupEvery: 6, n: 600 }, 50);
  assert.strictEqual(p.chain, 'decimate=cycle=6'); assert.strictEqual(p.cadence, 'clean');
});

test('… → 25p: repeats removed, then an even 2:1', () => {
  assert.strictEqual(plan({ arrive: 60, dupEvery: 6, n: 600 }, 25).chain, 'decimate=cycle=6,framestep=2');
});

test('… → 30p: flagged as JUDDER with the smooth alternatives (the old "use 30p" advice was wrong for a PAL camera)', () => {
  const p = plan({ arrive: 60, dupEvery: 6, n: 600 }, 30);
  assert.strictEqual(p.cadence, 'judder'); assert.deepStrictEqual(p.smoothRates, [25, 50]);
});

test('a measured 50i source (25 frames, TFF) → field-rate deinterlace to 50p, no rate filter', () => {
  const p = plan({ arrive: 25 }, 50, { mode: 'interlaced', fieldOrder: 'tff' });
  assert.strictEqual(p.chain, 'yadif=mode=send_field:parity=tff:deint=all');
});

test('dishonest device stamps are reported, and the program clock is used', () => {
  const p = plan({ arrive: 50, stamp: 60 }, 50);
  assert.ok(/nominal/.test(p.deviceTimestamps)); assert.strictEqual(p.timestamps, 'wallclock');
});

test('unmeasured: "50i" selected on a 60 fps card is NOT deinterlaced', () => {
  const p = sp.planFromAdvertised({ deviceFps: 60.0002, programFps: 50, interlacedSelected: true });
  assert.ok(!/yadif/.test(p.chain)); assert.strictEqual(p.cadence, 'judder');
});

test('unmeasured: a device that really runs at 25 with 50i selected IS deinterlaced', () => {
  const p = sp.planFromAdvertised({ deviceFps: 25, programFps: 50, interlacedSelected: true });
  assert.ok(/yadif/.test(p.chain)); assert.strictEqual(p.cadence, 'clean');
});

test('the FIELD case: a 25 fps camera held over a 60 fps grid is NOT "1 in 2" — it is 25 fps of motion', () => {
  // 60 slots/s, each of 25 unique frames held 2 or 3 slots (pattern 3,2,3,2,2…)
  const f = []; let content = 0, slot = 0;
  for (let i = 0; i < 360; i++) { const c = Math.floor((i * 25) / 60); f.push({ wallMs: 1000 + i * 1000 / 60, pts: i / 60, checksum: `C${c}`, scan: 'P' }); }
  const a = sp.analyseFrames(f);
  assert.strictEqual(a.duplicates.cycle, null, `reported a clean cycle of ${a.duplicates.cycle}`);
  assert.strictEqual(a.contentRate, 25);
  const p = sp.planNormalization(a, { mode: 'progressive' }, { programFps: 30 });
  assert.strictEqual(p.cadence, 'judder'); assert.deepStrictEqual(p.smoothRates, [25]);
  assert.strictEqual(sp.planNormalization(a, { mode: 'progressive' }, { programFps: 25 }).cadence, 'clean');
});

test('the FIELD case: 1080p raw delivering 10 of 60 fps is a DELIVERY failure with the MB/s named', () => {
  const r = sp.buildReport({ label: 'avm', device: 'avm', frames: frames({ arrive: 10, stamp: 60 }), programFps: 30,
    stderrText: '[info]   Stream #0:0: Video: rawvideo (YUY2 / 0x32595559), yuyv422, 1920x1080, 60 fps, 60 tbr, 10000k tbn' });
  const d = r.stages.find((x) => x.stage === 'DELIVERY');
  assert.strictEqual(d.status, 'fail'); assert.ok(/41 MB\/s/.test(d.detail), d.detail);
  assert.strictEqual(r.firstProblem.stage, 'DELIVERY');
});

console.log('\ncontrol vs problem');

test('the comparison names the FIRST stage where the control is fine and the problem source is not', () => {
  const mk = (label, opts, program) => sp.buildReport({ label, device: label, stderrText: '', frames: frames(opts), programFps: program });
  const a = mk('webcam', { arrive: 30 }, 30);
  const b = mk('avmatrix', { arrive: 60, dupEvery: 6, n: 600 }, 30);
  const c = sp.compareReports(a, b);
  assert.strictEqual(c.firstDivergence.stage, 'CONTENT');
  assert.ok(/repeats 1 frame in 6/.test(c.firstDivergence.problem));
  assert.strictEqual(a.health === 'FAIL', false);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
