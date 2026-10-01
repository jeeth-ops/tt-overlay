// END-TO-END: the REAL Compositor (probe → plan → filter graph → NUT relay →
// RelayConsumer) and the REAL recorder arguments, with the only substitution
// being the camera itself: every `-f dshow -i video=…` is rewritten to a
// real-time lavfi source that behaves like a specific device. No mocks of
// our own code, real ffmpeg for every process.
//
// Each simulated source writes its OWN frame number into the picture (luma =
// 16 + 4 × (n mod 50), inside TV range so nothing clips), so after compositing, relaying, encoding and muxing we can
// read back, frame by frame, WHICH camera frame the master recording shows.
// Smooth = every step the same size. Judder = mixed steps.
//
// Needs an ffmpeg with libx264 + lavfi (the Windows "full" build or any
// Linux static build). Skipped when none is found:
//   FFMPEG_PATH=/path/to/ffmpeg node test/pipelineSimulation.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH
  || ['../bin/ffmpeg.exe', '../ffmpeg.exe', '../bin/ffmpeg'].map((p) => require('path').join(__dirname, p)).find((p) => require('fs').existsSync(p))
  || 'ffmpeg';
if (spawnSync(FFMPEG, ['-hide_banner', '-version']).status !== 0) {
  console.log(`pipelineSimulation: no ffmpeg at "${FFMPEG}" — skipped (set FFMPEG_PATH)`);
  process.exit(0);
}
const np = require('../nativePipeline');
const sp = require('../sourceProbe');
const { verifyMedia } = require('../verifyMedia');

const W = 640, H = 360;
const cam = (r) => `color=black:s=${W}x${H}:r=${r},format=yuv420p,geq=lum='16+4*mod(N\\,50)':cb=128:cr=128,noise=alls=4:allf=t+u`;
// What each "device" really does.
const DEVICES = {
  'Laptop Webcam':           { src: `${cam(30)},realtime`, advertised: 30 },
  'AVMATRIX honest 60':      { src: `${cam(60)},realtime`, advertised: 60.0002 },
  // A 50 Hz (PAL) Sony behind a card that only offers 60: the card repeats 1 frame in 6.
  'AVMATRIX + Sony 50 (repeat)': { src: `${cam(50)},fps=60,realtime`, advertised: 60.0002, contentFps: 50 },
  // FIELD: the operator's UC2018 on 720x480 carrying a 25p Sony — each camera
  // frame held over 2-3 of the card's 60 slots.
  'AVMATRIX + Sony 25p (held)': { src: `${cam(25)},fps=60,realtime`, advertised: 60.0002, contentFps: 25 },
  // 50 real frames a second, STAMPED as if they were 60.
  'AVMATRIX dishonest stamps':   { src: `${cam(50)},realtime,setpts=N/60/TB`, advertised: 60.0002, contentFps: 50 },
};

function listOptionsText(fps) {
  return `[dshow @ 0] DirectShow video device options (from video devices)\n[dshow @ 0]  Pin "Capture"\n[dshow @ 0]   pixel_format=yuyv422  min s=${W}x${H} fps=${fps} max s=${W}x${H} fps=${fps}\n`;
}

// Rewrites dshow inputs to the simulated device; serves -list_options.
function makeSpawn(deviceName) {
  const dev = DEVICES[deviceName];
  return (args, opts = {}) => {
    if (args.includes('-list_options')) {
      const p = spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(listOptionsText(dev.advertised))})`], opts);
      return p;
    }
    const out = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-f' && args[i + 1] === 'dshow') {
        // swallow this input's dshow-only options up to and including -i
        let j = i + 2; const keep = [];
        while (args[j] !== '-i') {
          if (['-rtbufsize', '-video_size', '-framerate'].includes(args[j])) j += 2;
          else { keep.push(args[j], args[j + 1]); j += 2; }
        }
        const target = args[j + 1];
        if (target.startsWith('video=')) out.push(...keep, '-f', 'lavfi', '-i', dev.src);
        else out.push(...keep, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000,arealtime');
        i = j + 1;
        continue;
      }
      out.push(a);
    }
    return spawn(FFMPEG, out, { windowsHide: true, ...opts });
  };
}

// Read back a media file: per-frame pts and the camera frame number it shows.
function readBack(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', file, '-map', '0:v', '-vf', 'crop=64:64:0:0,showinfo', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const frames = [];
  for (const line of r.stderr.split('\n')) {
    const m = /pts_time:([\d.]+).*mean:\[(\d+)/.exec(line);
    if (m) frames.push({ t: Number(m[1]), idx: Math.round((Number(m[2]) - 16) / 4) });
  }
  const a = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-map', '0:a', '-f', 'null', '-'], { encoding: 'utf8' });
  const at = /time=(\d+):(\d+):([\d.]+)/g; let m, audioSec = null;
  while ((m = at.exec(a.stderr))) audioSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return { frames, audioSec };
}

function steps(frames) {
  const h = {};
  for (let i = 1; i < frames.length; i++) { let d = frames[i].idx - frames[i - 1].idx; if (d < 0) d += 50; h[d] = (h[d] || 0) + 1; }
  return h;
}

async function scenario({ device, programFps, recordSec = 20, legacy = false }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'se-sim-'));
  const logs = [];
  const comp = new np.Compositor({ spawnFfmpeg: makeSpawn(device), execPath: null, overlayUrl: 'http://127.0.0.1:1/none', width: W, height: H, fps: programFps, log: (l) => logs.push(l) });
  comp.captureTarget = { fps: programFps };
  if (legacy) comp.sourcePlan = { chain: typeof legacy === 'string' ? legacy : `fps=${programFps}`, timestamps: 'wallclock', cadence: '?', notes: [], deliveredFps: DEVICES[device].advertised };
  comp.addRef('recorder');
  const started = await comp.ensureRunning({ cameraDeviceName: device, audioDeviceName: 'mic' });
  assert.ok(started.ok, started.error);
  // The compositor needs a few seconds before its first relay byte (ffmpeg
  // probes each input); attach the way a recorder in production would —
  // to a feed that is actually flowing.
  for (let i = 0; i < 300 && !comp.relay.lastDataAt; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1000));
  const outFile = path.join(tmp, 'master.mp4');
  const rec = spawn(FFMPEG, np.buildRecorderEncoderArgs({ width: W, height: H, fps: programFps, bitrateKbps: 1500, outFile, useNvenc: false, relayFps: comp.fps }), { stdio: ['pipe', 'ignore', 'pipe'] });
  rec.stdin.on('error', () => {});
  let outTime = 0; rec.stderr.on('data', (d) => { const m = /out_time_us=(\d+)/g; let x; while ((x = m.exec(String(d)))) outTime = Number(x[1]) / 1e6; });
  comp.attachRelayConsumer(rec, 'recorder');
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, recordSec * 1000));
  const capture = comp.captureStatus();
  comp.detachRelayConsumer(rec, { end: true });
  await new Promise((r) => rec.on('close', r));
  const wallSec = (Date.now() - t0) / 1000;
  await comp.stop();
  const rb = readBack(outFile);
  const verify = await verifyMedia({ ffmpegPath: FFMPEG, file: outFile });
  const last = rb.frames[rb.frames.length - 1];
  const fileSec = last ? last.t + 1 / programFps : 0;
  if (process.env.SIM_KEEP) console.log('kept', outFile); else fs.rmSync(tmp, { recursive: true, force: true });
  return { device, programFps, legacy, verify, plan: comp.sourcePlan, capture, wallSec, fileSec, frames: rb.frames.length, audioSec: rb.audioSec, steps: steps(rb.frames.slice(5)), logs };
}

function fmtSteps(h) { return Object.entries(h).map(([k, v]) => `${k}×${v}`).join(' '); }
function oddSteps(h) { return Object.entries(h).filter(([k]) => Number(k) % 2 === 1).reduce((a, [, v]) => a + v, 0); }
function smoothShare(h, want) { const tot = Object.values(h).reduce((a, b) => a + b, 0); return tot ? (h[want] || 0) / tot : 0; }

(async () => {
  let pass = 0, fail = 0;
  const only = process.env.SIM_ONLY;
  const results = [];
  const run = async (name, cfg, check) => {
    if (only && !name.includes(only) && !cfg.device.includes(only)) return;
    const r = await scenario(cfg);
    results.push(r);
    const line = `${cfg.device} → ${cfg.programFps}p${cfg.legacy ? ' [OLD chain]' : ''}: chain "${(r.plan && r.plan.chain) || 'passthrough'}" ts=${r.plan && r.plan.timestamps} | A/V ${(r.verify.audio && r.verify.video) ? (r.verify.audio.durationSec - r.verify.video.durationSec).toFixed(3) : '?'}s | recorded ${r.fileSec.toFixed(2)}s of ${r.wallSec.toFixed(2)}s wall (${(r.fileSec / r.wallSec).toFixed(3)}×), audio ${r.audioSec}s | camera steps ${fmtSteps(r.steps)} | meter ${r.capture.live.window ? `${r.capture.live.window.arrivalFps} fps arriving, ${r.capture.live.window.contentFps} unique, ts ${r.capture.live.window.timestampHonesty}×` : '—'}`;
    try { check(r); console.log(`  ✓ ${name}\n      ${line}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${line}\n      ${e.message}`); fail++; if (process.env.SIM_VERBOSE) console.log(r.logs.join('\n')); }
  };
  // Duration: file vs wall, allowing for the recorder's own ~1 s start-up.
  const realTime = (r) => {
    const bad = r.verify.checks.filter((c) => !c.ok);
    assert.ok(!bad.length, `file check: ${bad.map((c) => `${c.check}: ${c.detail}`).join('; ')}`);
    realTimeOnly(r);
  };
  const realTimeOnly = (r) => assert.ok(Math.abs(r.fileSec - r.wallSec) <= 1.5 + 0.02 * r.wallSec, `file ${r.fileSec.toFixed(2)}s vs ${r.wallSec.toFixed(2)}s real — speed is wrong`);

  console.log('\nCONTROL');
  await run('laptop webcam 30 → 30p: smooth, real time', { device: 'Laptop Webcam', programFps: 30 }, (r) => {
    realTime(r); assert.ok(smoothShare(r.steps, 1) > 0.98, 'webcam cadence');
  });
  console.log('\nAVMATRIX 60 → 30p');
  await run('OLD chain (fps=30) — reported for comparison', { device: 'AVMATRIX honest 60', programFps: 30, legacy: true }, (r) => {
    // An ODD step on a 2:1 decimation means the neighbouring camera frame was
    // shown — the fps filter's knife edge. How often depends on real
    // timestamp jitter (0.3–1.5% of frames on this Linux box, 39% at ±2 ms in
    // test/decimationCadence.test.js), so it is REPORTED here, and asserted
    // deterministically there.
    realTime(r);
  });
  await run('NEW chain (framestep=2) — every other camera frame, exactly', { device: 'AVMATRIX honest 60', programFps: 30 }, (r) => {
    realTime(r); assert.ok(/framestep=2/.test(r.plan.chain)); assert.ok(smoothShare(r.steps, 2) > 0.98, fmtSteps(r.steps));
    assert.ok(oddSteps(r.steps) <= 1, `a count-based 2:1 decimation cannot pick a neighbour: ${fmtSteps(r.steps)}`);
  });
  console.log('\nSony 50 Hz behind a 60-only card (card repeats 1 frame in 6)');
  await run('program 50p — repeats removed, the camera\'s own 50 fps restored', { device: 'AVMATRIX + Sony 50 (repeat)', programFps: 50 }, (r) => {
    realTime(r); assert.ok(/decimate=cycle=6/.test(r.plan.chain), r.plan.chain); assert.ok(smoothShare(r.steps, 1) > 0.97, fmtSteps(r.steps));
  });
  await run('program 25p — clean 2:1 of the real 50', { device: 'AVMATRIX + Sony 50 (repeat)', programFps: 25 }, (r) => {
    realTime(r); assert.ok(smoothShare(r.steps, 2) > 0.97, fmtSteps(r.steps));
  });
  await run('program 30p — CANNOT be smooth, and the plan says so', { device: 'AVMATRIX + Sony 50 (repeat)', programFps: 30 }, (r) => {
    realTime(r); assert.strictEqual(r.plan.cadence, 'judder'); assert.deepStrictEqual(r.plan.smoothRates, [25, 50]);
  });
  console.log('\nFIELD: Sony 25p held over a 60-slot card (the operator\'s UC2018 at 720x480)');
  await run('program 25p — repeats dropped, re-timed at the measured 25 fps, every camera frame once', { device: 'AVMATRIX + Sony 25p (held)', programFps: 25 }, (r) => {
    realTime(r); assert.ok(/dejitter@25fps/.test(sp.chainLabel(r.plan.chain)), r.plan.chain); assert.strictEqual(r.plan.cadence, 'clean');
    assert.ok(smoothShare(r.steps, 1) > 0.95, fmtSteps(r.steps));
  });
  await run('OLD chain (fps=25) on the same held source — reported for comparison', { device: 'AVMATRIX + Sony 25p (held)', programFps: 25, legacy: 'fps=25' }, (r) => { realTime(r); });
  console.log('\nA card that stamps 50 real frames as 60');
  await run('probe catches the stamps; the program clock keeps the file real-time', { device: 'AVMATRIX dishonest stamps', programFps: 50 }, (r) => {
    assert.ok(/nominal/.test(r.plan.deviceTimestamps), r.plan.deviceTimestamps); realTime(r);
  });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (process.env.SIM_JSON) fs.writeFileSync(process.env.SIM_JSON, JSON.stringify(results.map(({ logs, ...r }) => r), null, 2));
  process.exit(fail ? 1 : 0);
})();
