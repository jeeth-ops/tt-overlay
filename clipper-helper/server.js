// ================================================================
// 🎥 Clipper Helper — runs locally on the operator's PC, next to vMix.
//
//   vMix local recording → Clipper → local clip → website → R2 + Drive
//
// The ONLY video source is vMix's own local recording file. Never
// YouTube, browser chunks, R2 or Drive.
//
// v4.0 — what changed and why (the "10–12 clips work, then clips go
// missing / fetch errors / nothing until restart" failure):
//
//  1. EXACT, PER-CLIP TIMING. v3 cut "the last 19s of the file at the
//     moment the job ran". With a serial queue, a clip that had to wait
//     behind another one was cut from the wrong moment. Now every job
//     freezes its own window at the press (T0−15s → T0+3s) and that
//     window is mapped onto the recording's own timeline via an anchor
//     (see RecordingSource), then cut with an exact -ss/-t. Queue delay
//     can no longer change which footage a clip contains.
//  2. WAIT FOR THE FOOTAGE. Cutting starts 3s after the press, and only
//     once the recording has actually been written up to T0+3s (vMix
//     writes the file in fragments, so the newest second or two appears
//     on disk slightly later). No more short/empty clips from cutting
//     ahead of the file.
//  3. NO FALSE "DUPLICATES". v3 dropped any second press of the same
//     type inside the same 2-second bucket — back-to-back presses were
//     silently lost. Each press is now its own job, keyed by its exact
//     millisecond timestamp; only a genuine re-send of the SAME press
//     (same clipId) is de-duplicated.
//  4. ONE BAD CLIP CAN'T STALL THE QUEUE. v3's watchdog "abandoned" a
//     slow job but left its ffmpeg running and its retries going, so
//     abandoned cuts piled up and competed with every later cut. Every
//     ffmpeg is now killed on timeout; a failed cut is retried later
//     from the BACK of the queue (never blocking the next clip), and a
//     job that still fails is marked FAILED loudly — the queue moves on.
//  5. UPLOADS THAT CAN ACTUALLY FINISH. v3 gave each upload 20 seconds
//     in total — a 15–30 MB clip on a normal upload link needs longer,
//     so uploads timed out, fell back, and eventually "failed". Uploads
//     now stream the file and only time out on inactivity, retry with
//     backoff for hours, survive a restart, and never run twice for the
//     same clip (no direct-to-Drive fallback creating duplicates — the
//     website uploads to R2 and Drive independently and retries each).
//  6. NOTHING DEPENDS ON "START RECORDING" HAVING BEEN PRESSED IN THIS
//     SESSION. v3 rejected every clip after a helper restart until the
//     operator pressed Start Recording again. The recording file is the
//     source of truth; state (match, website URL) is persisted.
//  7. ALWAYS THE RIGHT RECORDING FILE. v3 used the configured file path
//     whenever it existed — even if vMix had started writing a NEWER
//     file (timestamped names), so it could keep cutting from a stale
//     recording. The file that is actually growing now always wins, and
//     every clip remembers the file that was recording at its press.
// ================================================================

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, exec } = require('child_process');
const { Fmp4Index } = require('./fmp4');

// When bundled by pkg into ClipperHelper.exe, __dirname points inside a
// virtual snapshot, not the real folder the .exe sits in.
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

// ffmpeg.exe ships next to ClipperHelper.exe; falls back to the npm copy.
const localFfmpeg = path.join(BASE_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
let ffmpegPath = process.env.FFMPEG_PATH || localFfmpeg;
if (!fs.existsSync(ffmpegPath)) {
  try { ffmpegPath = require('@ffmpeg-installer/ffmpeg').path; } catch (_) { /* reported at startup */ }
}

process.on('uncaughtException', (err) => {
  console.log('❌ Unexpected error (helper kept running):', (err && err.stack) || err);
});
process.on('unhandledRejection', (err) => {
  console.log('❌ Unexpected async error (helper kept running):', (err && err.stack) || err);
});

// ----------------------------------------------------------------
// ⚙️ CONFIG (config.json next to the exe) + persisted session state.
// ----------------------------------------------------------------
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
let config = {
  port: 5005,
  // The file vMix records to — or just its folder. Whichever media file
  // in that folder is currently being written is used (see resolveActiveRecording).
  vmixRecordingFile: 'C:\\Users\\YOUR_NAME\\Videos\\match-recording.mp4',
  // Blank = "<recording folder>\Clips".
  clipsFolder: '',
  // Your website's address. Only its origin is used (https://site.com),
  // so a pasted panel URL like https://site.com/cricket-panel still works.
  mainServerUrl: 'https://YOUR-SITE.example.com',
};
try {
  if (fs.existsSync(CONFIG_PATH)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  else fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
} catch (err) {
  console.log('⚠️  Could not read config.json, using defaults:', err.message);
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (err) { console.log('⚠️  Could not write config.json:', err.message); }
}

// "https://site.com/cricket-panel/" -> "https://site.com"
function toOrigin(url) {
  try { return new URL(String(url).trim()).origin; } catch (_) { return ''; }
}

const STATE_PATH = path.join(BASE_DIR, 'helper-state.json');
const session = {
  matchId: null,
  mainServerUrl: toOrigin(config.mainServerUrl),
  recordingStartedAt: null,
  driveFolderId: null,
  driveFolderName: null,
};
try { Object.assign(session, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))); } catch (_) { /* first run */ }
function saveSession() {
  fs.writeFile(STATE_PATH, JSON.stringify(session, null, 2), () => {});
}

// ----------------------------------------------------------------
// 🎯 CLIP WINDOW — the one place these numbers live.
// ----------------------------------------------------------------
const PRE_ROLL_SECONDS = 15;   // footage kept BEFORE the press
const POST_ROLL_SECONDS = 3;   // footage kept AFTER the press (and the wait before cutting)
const CLIP_SECONDS = PRE_ROLL_SECONDS + POST_ROLL_SECONDS; // 18

const COVERAGE_WAIT_MAX_MS = 30000;   // max extra wait for the recording to reach T0+3s on disk
const CUT_TIMEOUT_MS = 120000;        // one ffmpeg cut; killed after this
// A temporary problem (recording briefly locked, disk busy, ffmpeg hiccup)
// gets ~2 minutes of retries before a clip is given up — the footage stays
// in the recording, so there is no reason to fail fast.
const CUT_MAX_ATTEMPTS = 6;
const CUT_RETRY_DELAYS_MS = [3000, 8000, 15000, 30000, 60000];
const UPLOAD_IDLE_TIMEOUT_MS = 60000; // no bytes moving for this long = dead connection
const UPLOAD_BACKOFF_MS = [5000, 15000, 30000, 60000, 120000, 300000]; // then every 5 min
const UPLOAD_MAX_ATTEMPTS = 60;       // ≈ 4–5 hours of retrying
const STATUS_POLL_WINDOW_MS = 12 * 60 * 60 * 1000; // follow R2/Drive progress for up to 12 hours per clip
// How fast a finished R2/Drive upload turns into a ✓ on the panel. The
// whole batch is polled in parallel (see statusPollTick), so a shorter
// interval costs one small request per in-flight clip, not per clip × wait.
const STATUS_POLL_INTERVAL_MS = 2000;
const STATUS_POLL_BATCH = 12; // in-flight clips followed per tick

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getClipsDir() {
  const folder = (config.clipsFolder || '').trim();
  if (folder) return path.isAbsolute(folder) ? folder : path.join(BASE_DIR, folder);
  return path.join(recordingDir(), 'Clips');
}
function recordingDir() {
  const p = config.vmixRecordingFile || '.';
  try { if (fs.statSync(p).isDirectory()) return p; } catch (_) { /* not there (yet) */ }
  return path.dirname(p);
}

// ----------------------------------------------------------------
// 🛠️ ffmpeg helpers — every process is tracked, bounded and killed.
// ----------------------------------------------------------------
const children = new Set();
function runFfmpeg(args, { timeoutMs, lowPriority = false, collectStderr = true } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, stderr: err.message, timedOut: false });
    }
    children.add(proc);
    if (lowPriority) { try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {} }
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch (_) {} }, timeoutMs) : null;
    proc.stderr.on('data', (d) => { if (collectStderr) stderr = (stderr + d).slice(-16000); });
    const done = (code) => { clearTimeout(timer); children.delete(proc); resolve({ code, stderr, timedOut }); };
    proc.on('error', (err) => { stderr += err.message; done(-1); });
    proc.on('close', (code) => done(code));
  });
}

// Duration of a media file (works on a file vMix is still writing, as
// long as vMix writes a streamable format — fragmented MP4, MOV/MKV
// written in fragments, etc.). Reads the "Duration:" line of ffmpeg -i.
async function probeDuration(filePath) {
  const r = await runFfmpeg(['-hide_banner', '-nostdin', '-i', filePath], { timeoutMs: 60000 });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr);
  if (!m) {
    const reason = /moov atom not found/i.test(r.stderr)
      ? 'recording is not readable while vMix is recording (MP4 index is only written at the end) — see README: use a fragmented/streamable recording format'
      : (r.timedOut ? 'probe timed out' : (r.stderr.trim().split('\n').pop() || 'no Duration line'));
    return { ok: false, reason };
  }
  return { ok: true, seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
}

// ≤1080p, quality-based with a bitrate ceiling: an 18 s clip stays ~10–15 MB
// (fast to upload, under the website's 60 MB limit, quick first play).
const SCALE_ARGS = ['-vf', "scale=-2:'min(1080,ih)'"];
let videoEncoderArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '6M', '-bufsize', '12M', '-pix_fmt', 'yuv420p'];
async function detectEncoder() {
  const r = await new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return resolve(''); }
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out));
  });
  if (!/\blibx264\b/.test(r)) {
    videoEncoderArgs = ['-c:v', 'mpeg4', '-q:v', '3'];
    console.log('⚠️  This ffmpeg has no libx264 — clips will be encoded with mpeg4 (larger files). A full ffmpeg build is recommended.');
  }
}

// ----------------------------------------------------------------
// 📼 RECORDING SOURCE — finds the file vMix is writing and keeps a
// wall-clock ↔ file-time anchor for it.
//
// anchor = wall-clock time of the file's 0:00. Each probe gives
// (probe time − file duration); the file's written end can only LAG real
// time (encoder + fragment buffering), never lead it, so the minimum of
// recent samples is the tightest estimate. A sliding 3-minute window
// follows any slow clock drift across a 6–7 hour match. For a file that
// is no longer growing, its last-modified time stands in for "now".
// ----------------------------------------------------------------
const MEDIA_EXT = new Set(['.mp4', '.mov', '.mkv', '.ts', '.m4v', '.mts', '.m2ts']);
const ANCHOR_WINDOW_MS = 3 * 60 * 1000;
const sources = new Map(); // filePath -> { samples: [[wall, anchor]], anchor, durationSec, probedAt, size, sizeChangedAt, lastError, probing }
let activeRecording = null; // { file, size, mtimeMs, growing }
let recordingError = null;

function isClipFileName(name) {
  return /\.(part|src)\.mp4$/i.test(name) || /_\d{12,}\.mp4$/i.test(name);
}

async function resolveActiveRecording() {
  const candidates = [];
  const configured = config.vmixRecordingFile;
  const dir = recordingDir();
  const clipsDir = path.resolve(getClipsDir());
  try {
    for (const name of await fs.promises.readdir(dir)) {
      if (!MEDIA_EXT.has(path.extname(name).toLowerCase()) || isClipFileName(name)) continue;
      const full = path.join(dir, name);
      if (path.resolve(path.dirname(full)) === clipsDir) continue;
      candidates.push(full);
    }
  } catch (_) { /* folder missing — handled below */ }
  if (configured && !candidates.includes(configured) && fs.existsSync(configured) && !fs.statSync(configured).isDirectory()) candidates.push(configured);
  let best = null;
  for (const full of candidates) {
    try {
      const st = await fs.promises.stat(full);
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, size: st.size, mtimeMs: st.mtimeMs };
    } catch (_) { /* vanished */ }
  }
  if (!best) {
    activeRecording = null;
    recordingError = `No recording file found in ${dir} — is vMix recording, and is the recording path in Setup correct?`;
    return null;
  }
  const src = sourceFor(best.file);
  if (src.size !== best.size) { src.size = best.size; src.sizeChangedAt = Date.now(); }
  best.growing = Date.now() - (src.sizeChangedAt || 0) < 15000;
  activeRecording = best;
  recordingError = null;
  return best;
}

function sourceFor(file) {
  let s = sources.get(file);
  if (!s) {
    s = { samples: [], anchor: null, durationSec: 0, probedAt: 0, size: null, sizeChangedAt: 0, lastError: null, probing: null, idx: new Fmp4Index(file) };
    sources.set(file, s);
  }
  return s;
}

// Probes one recording file (never two probes of the same file at once).
function probeSource(file) {
  const src = sourceFor(file);
  if (src.probing) return src.probing;
  src.probing = (async () => {
    let st;
    try { st = await fs.promises.stat(file); } catch (e) { src.lastError = 'recording file not found'; return src; }
    if (src.size !== st.size) { src.size = st.size; src.sizeChangedAt = Date.now(); }
    const growing = Date.now() - src.sizeChangedAt < 15000;
    const wall = Date.now();
    let r = null;
    // Fast path: fragmented MP4 index (reads only what was written since
    // the last probe). Falls back to ffmpeg for any other format.
    if (src.idx.supported !== false) {
      try {
        await src.idx.refresh();
        if (src.idx.supported) r = { ok: true, seconds: src.idx.durationSec };
      } catch (e) { /* e.g. file briefly locked — ffmpeg fallback below, retried next tick */ }
    }
    if (!r) r = await probeDuration(file);
    if (!r.ok) { src.lastError = r.reason; return src; }
    src.lastError = null;
    src.durationSec = r.seconds;
    src.probedAt = wall;
    // A finished file's end is its last write, not "now".
    const endWall = growing ? wall : st.mtimeMs;
    src.samples.push([wall, endWall - r.seconds * 1000]);
    while (src.samples.length > 1 && wall - src.samples[0][0] > ANCHOR_WINDOW_MS) src.samples.shift();
    let min = Infinity;
    for (const [, a] of src.samples) if (a < min) min = a;
    src.anchor = min;
    return src;
  })().finally(() => { src.probing = null; });
  return src.probing;
}

// Background: keep the active recording's anchor fresh (every 5s).
async function sourceTick() {
  try {
    const rec = await resolveActiveRecording();
    if (rec && (rec.growing || !sourceFor(rec.file).anchor)) await probeSource(rec.file);
  } catch (err) {
    console.log('⚠️  Recording check error (will retry):', err.message);
  }
}
setInterval(sourceTick, 5000);

// ----------------------------------------------------------------
// 🗂️ CLIP JOBS — one per HIGHLIGHTS/FOUR/SIX/WICKET press. Persisted
// (clip-jobs.json) so a restart resumes cuts and uploads.
//
// status: WAITING → CUTTING → LOCAL_SAVED → UPLOADING → UPLOADED
//         (→ R2/Drive progress from the website) → COMPLETE
//         CUT_RETRY / UPLOAD_RETRY on failure, FAILED when out of attempts.
// ----------------------------------------------------------------
const JOBS_PATH = path.join(BASE_DIR, 'clip-jobs.json');
const jobs = new Map();
try {
  for (const j of JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'))) jobs.set(j.clipId, j);
} catch (_) { /* first run */ }

let jobsSaveTimer = null;
let jobsWriting = false;
let jobsDirty = false;
function persistJobs() {
  jobsDirty = true;
  if (jobsSaveTimer || jobsWriting) return;
  jobsSaveTimer = setTimeout(() => {
    jobsSaveTimer = null;
    jobsDirty = false;
    jobsWriting = true;
    // Keep every unfinished job + the most recent 300 overall.
    const keep = jobsToKeep();
    const tmp = JOBS_PATH + '.tmp';
    fs.writeFile(tmp, JSON.stringify(keep), (err) => {
      const finish = () => { jobsWriting = false; if (jobsDirty) persistJobs(); };
      if (err) return finish();
      fs.rename(tmp, JOBS_PATH, (err2) => { if (err2) fs.writeFile(JOBS_PATH, JSON.stringify(keep), finish); else finish(); });
    });
  }, 500);
}
function jobsToKeep() {
  const all = [...jobs.values()];
  return all.filter((j, i) => i >= all.length - 300 || !['COMPLETE', 'FAILED'].includes(j.status));
}
function flushJobsNow() {
  try { fs.writeFileSync(JOBS_PATH, JSON.stringify(jobsToKeep())); } catch (_) { persistJobs(); }
}
function update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  persistJobs();
}
function pruneJobs() {
  if (jobs.size <= 500) return;
  for (const [id, j] of jobs) {
    if (jobs.size <= 400) break;
    if (['COMPLETE', 'FAILED'].includes(j.status)) jobs.delete(id);
  }
}

function buildClipId(matchId, eventType, t0) {
  return `${String(matchId || 'match').replace(/[^a-zA-Z0-9_-]/g, '')}_${String(eventType || 'CLIP').toUpperCase().replace(/[^A-Z0-9-]/g, '')}_${t0}`;
}

// ----------------------------------------------------------------
// ✂️ CUT QUEUE — local disk + ffmpeg only, one cut at a time (vMix is on
// this PC too), strictly independent of the network.
// ----------------------------------------------------------------
const cutQueue = [];
let cutRunning = false;
const timers = new Set();
function later(fn, ms) {
  const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
  timers.add(t);
}

function scheduleCut(job) {
  const dueAt = job.t0 + POST_ROLL_SECONDS * 1000;
  later(() => enqueueCut(job.clipId), Math.max(0, dueAt - Date.now()));
}
function enqueueCut(clipId) {
  if (!cutQueue.includes(clipId)) cutQueue.push(clipId);
  pumpCuts();
}
async function pumpCuts() {
  if (cutRunning) return;
  cutRunning = true;
  try {
    while (cutQueue.length) {
      const job = jobs.get(cutQueue.shift());
      if (!job || !['WAITING', 'CUT_RETRY', 'CUTTING'].includes(job.status)) continue;
      try {
        await cutJob(job);
      } catch (err) {
        onCutFailure(job, `unexpected: ${err.message}`);
      }
    }
  } finally {
    cutRunning = false;
  }
}

async function cutJob(job) {
  job.cutAttempts = (job.cutAttempts || 0) + 1;
  update(job, { status: 'CUTTING', cutAttempts: job.cutAttempts, error: null });

  // The file that was recording when the button was pressed.
  if (!job.sourceFile || !fs.existsSync(job.sourceFile)) {
    const rec = await resolveActiveRecording();
    if (!rec) return onCutFailure(job, recordingError || 'no recording file');
    job.sourceFile = rec.file;
  }
  let src = await probeSource(job.sourceFile);
  if (src.anchor == null) return onCutFailure(job, `cannot read recording: ${src.lastError || 'unknown'}`);

  // Wait (max COVERAGE_WAIT_MAX_MS) until the recording has actually
  // been written up to T0+3s.
  let startSec = (job.window.startWall - src.anchor) / 1000;
  let endSec = (job.window.endWall - src.anchor) / 1000;
  const waitUntil = Date.now() + COVERAGE_WAIT_MAX_MS;
  while (src.durationSec < endSec && Date.now() < waitUntil) {
    const stillGrowing = Date.now() - src.sizeChangedAt < 15000;
    if (!stillGrowing) break; // recording stopped — cut what exists
    await sleep(500);
    src = await probeSource(job.sourceFile);
    startSec = (job.window.startWall - src.anchor) / 1000;
    endSec = (job.window.endWall - src.anchor) / 1000;
  }
  if (endSec <= 0) return onCutFailure(job, 'this moment is before the start of the recording', { final: true });
  const recordingStopped = Date.now() - src.sizeChangedAt >= 15000;
  if (recordingStopped && startSec >= src.durationSec - 1) {
    // Pressed within seconds of vMix starting a NEW file (the helper still
    // pointed at the old one): switch to the file that is recording now.
    const rec = await resolveActiveRecording();
    if (rec && rec.file !== job.sourceFile && rec.growing) {
      console.log(`↪️  [${job.eventType}] ${job.clipId}: moment is after ${path.basename(job.sourceFile)} ended — using ${path.basename(rec.file)}`);
      job.sourceFile = rec.file;
      job.cutAttempts = Math.max(0, (job.cutAttempts || 1) - 1);
      return cutJob(job);
    }
  }
  if (recordingStopped && startSec >= src.durationSec - 1) {
    return onCutFailure(job, `vMix was not recording at the time of this press (${path.basename(job.sourceFile)} ends ${Math.round(startSec - src.durationSec + PRE_ROLL_SECONDS)}s before it)`, { final: true });
  }
  const fromSec = Math.max(0, startSec);
  const toSec = Math.min(endSec, src.durationSec);
  const duration = toSec - fromSec;
  if (duration < 1) return onCutFailure(job, `recording has no footage for this moment yet (recorded up to ${src.durationSec.toFixed(1)}s, needed ${endSec.toFixed(1)}s)`);

  // The pieces this clip is made of. Normally one. If vMix finished this
  // file mid-clip and moved on to a new one (Stop/Start, or split
  // recording), the rest of the moment is taken from the new file.
  const segments = [{ src, file: job.sourceFile, from: fromSec, to: toSec }];
  if (recordingStopped && endSec > src.durationSec + 0.5) {
    const rec = await resolveActiveRecording();
    if (rec && rec.file !== job.sourceFile) {
      const nxt = await probeSource(rec.file);
      if (nxt.anchor != null) {
        const aEndWall = src.anchor + src.durationSec * 1000;             // where this file's footage stops
        const bFrom = Math.max(0, (Math.max(job.window.startWall, aEndWall) - nxt.anchor) / 1000);
        const bTo = Math.min((job.window.endWall - nxt.anchor) / 1000, nxt.durationSec);
        if (bTo - bFrom >= 0.5) segments.push({ src: nxt, file: rec.file, from: bFrom, to: bTo });
      }
    }
  }
  if (segments.length > 1 && segments[0].to - segments[0].from < 0.3) segments.shift(); // nothing worth joining
  const expected = segments.reduce((a, g) => a + (g.to - g.from), 0);

  const clipsDir = getClipsDir();
  await fs.promises.mkdir(clipsDir, { recursive: true });
  const outFile = path.join(clipsDir, `${job.clipId}.mp4`);
  const partFile = path.join(clipsDir, `${job.clipId}.part.mp4`);
  console.log(`✂️  [${job.eventType}] ${job.clipId}: cutting ${segments.map((g) => `${path.basename(g.file)} ${g.from.toFixed(1)}s → ${g.to.toFixed(1)}s`).join(' + ')} (${expected.toFixed(1)}s)`);

  const temps = [];
  const cleanup = () => { for (const t of temps) fs.unlink(t, () => {}); };
  const pieces = [];
  for (let i = 0; i < segments.length; i++) {
    const g = segments[i];
    const out = segments.length === 1 ? partFile : path.join(clipsDir, `${job.clipId}.p${i}.part.mp4`);
    if (out !== partFile) temps.push(out);
    const r = await cutSegment(job, g, out, clipsDir, i);
    if (r.code !== 0) {
      cleanup(); fs.unlink(partFile, () => {});
      return onCutFailure(job, r.timedOut ? `ffmpeg cut timed out after ${CUT_TIMEOUT_MS / 1000}s (killed)` : `ffmpeg: ${r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
    }
    pieces.push(out);
  }
  if (pieces.length > 1) {
    // Same encoder settings for every piece, so they join without re-encoding.
    const list = path.join(clipsDir, `${job.clipId}.list.txt`);
    temps.push(list);
    await fs.promises.writeFile(list, pieces.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const r = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', partFile], { timeoutMs: CUT_TIMEOUT_MS, lowPriority: true });
    cleanup();
    if (r.code !== 0) { fs.unlink(partFile, () => {}); return onCutFailure(job, `could not join the two recording files: ${r.stderr.trim().split('\n').pop()}`); }
  }
  const duration2 = expected;

  // ✅ Validate: real, readable video of the expected length.
  let size = 0;
  try { size = (await fs.promises.stat(partFile)).size; } catch (_) { /* missing */ }
  const check = size > 20 * 1024 ? await probeDuration(partFile) : { ok: false, reason: `file too small (${size} bytes)` };
  if (!check.ok || check.seconds < duration2 - 1.5) {
    fs.unlink(partFile, () => {});
    return onCutFailure(job, check.ok ? `clip came out ${check.seconds.toFixed(1)}s instead of ${duration2.toFixed(1)}s` : `invalid clip: ${check.reason}`);
  }
  try {
    await renameWithRetry(partFile, outFile);
  } catch (err) {
    fs.unlink(partFile, () => {});
    return onCutFailure(job, `could not save clip: ${err.message}`);
  }
  console.log(`💾 [${job.eventType}] ${job.clipId}: saved locally (${check.seconds.toFixed(1)}s) → ${outFile}`);
  update(job, { status: 'LOCAL_SAVED', localPath: outFile, clipSeconds: Number(check.seconds.toFixed(1)), savedAt: Date.now(), error: null });
  queueUpload(job);
}

// Cuts one piece [g.from, g.to] (seconds of g.file) to `out`. fMP4
// recordings: only the fragments around the moment are copied to a small
// <clipId>.src.mp4 first, so the cost does not grow with the match length.
async function cutSegment(job, g, out, clipsDir, i) {
  let input = g.file;
  let seek = g.from;
  const segFile = path.join(clipsDir, `${job.clipId}.${i}.src.mp4`);
  if (g.src.idx && g.src.idx.supported) {
    try {
      const seg = await g.src.idx.extract(g.from, g.to, segFile);
      input = segFile;
      seek = Math.max(0, g.from - seg.startSec);
    } catch (e) {
      fs.unlink(segFile, () => {});
      console.log(`⚠️  [${job.eventType}] ${job.clipId}: fast extract failed (${e.message}) — cutting from the full recording`);
    }
  }
  const r = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', seek.toFixed(3), '-i', input, '-t', (g.to - g.from).toFixed(3),
    '-map', '0:v:0', '-map', '0:a:0?',
    ...SCALE_ARGS,
    ...videoEncoderArgs,
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    out,
  ], { timeoutMs: CUT_TIMEOUT_MS, lowPriority: true });
  if (input === segFile) fs.unlink(segFile, () => {});
  return r;
}

function onCutFailure(job, reason, { final = false } = {}) {
  if (!final && (job.cutAttempts || 0) < CUT_MAX_ATTEMPTS) {
    const delay = CUT_RETRY_DELAYS_MS[Math.min((job.cutAttempts || 1) - 1, CUT_RETRY_DELAYS_MS.length - 1)];
    console.log(`⚠️  [${job.eventType}] ${job.clipId}: ${reason} — retrying in ${delay / 1000}s (other clips continue)`);
    update(job, { status: 'CUT_RETRY', error: reason });
    later(() => enqueueCut(job.clipId), delay);
    return;
  }
  console.log(`❌ [${job.eventType}] ${job.clipId}: clip could not be cut — ${reason}`);
  update(job, { status: 'FAILED', error: reason, failedAt: Date.now() });
}

async function renameWithRetry(from, to, attempts = 6) {
  for (let i = 0; ; i++) {
    try { await fs.promises.rename(from, to); return; } catch (err) {
      if (i >= attempts - 1) throw err;
      await sleep(300 * (i + 1)); // antivirus/indexer can hold a just-written file briefly
    }
  }
}

// ----------------------------------------------------------------
// ☁️ UPLOAD QUEUE — network only, independent of cutting. Sends each
// clip ONCE (per successful acknowledgement) to the website, which
// uploads it to Cloudflare R2 and Google Drive as two independent,
// separately-retried legs and links it to the ball/players.
// ----------------------------------------------------------------
const uploadQueue = [];
let uploadsRunning = 0;
// 3 clips in flight at once: a burst of presses (a big over) clears to the
// website noticeably sooner than at 2, without swamping a typical venue
// uplink the way a much higher number would.
const UPLOAD_CONCURRENCY = 3;

function queueUpload(job) {
  if (!uploadQueue.includes(job.clipId)) uploadQueue.push(job.clipId);
  pumpUploads();
}
function pumpUploads() {
  while (uploadsRunning < UPLOAD_CONCURRENCY && uploadQueue.length) {
    const job = jobs.get(uploadQueue.shift());
    if (!job || !['LOCAL_SAVED', 'UPLOAD_RETRY'].includes(job.status)) continue;
    uploadsRunning++;
    uploadJob(job)
      .catch((err) => onUploadFailure(job, `unexpected: ${err.message}`))
      .finally(() => { uploadsRunning--; pumpUploads(); });
  }
}

async function uploadJob(job) {
  const server = session.mainServerUrl || toOrigin(config.mainServerUrl);
  const matchId = job.matchId || session.matchId;
  if (!server || !matchId) {
    // Not an upload failure (nothing was sent): wait for Setup / a match id
    // without using up attempts, checking every 30 s.
    update(job, { status: 'UPLOAD_RETRY', error: !server ? 'website URL not set — open the Setup page' : 'no match id for this clip', nextUploadAt: Date.now() + 30000 });
    later(() => queueUpload(job), 30000);
    return;
  }
  if (!job.localPath || !fs.existsSync(job.localPath)) {
    update(job, { status: 'FAILED', error: 'local clip file is missing — cannot upload' });
    return;
  }
  job.uploadAttempts = (job.uploadAttempts || 0) + 1;
  update(job, { status: 'UPLOADING', uploadAttempts: job.uploadAttempts, error: null });
  const qs = new URLSearchParams({ matchId, eventType: job.eventType, timestamp: String(job.t0), clipId: job.clipId });
  const r = await postFile(`${server}/api/clips/ingest?${qs}`, job.localPath, { 'X-Ball-Meta': JSON.stringify(job.ballMeta || {}) });
  if (!r.ok) return onUploadFailure(job, r.error);
  console.log(`📤 [${job.eventType}] ${job.clipId}: received by website — R2 + Drive uploads running there`);
  update(job, { status: 'UPLOADED', uploadedAt: Date.now(), r2Status: 'pending', driveStatus: 'pending', error: null });
}

function onUploadFailure(job, reason) {
  const attempts = job.uploadAttempts || 0;
  if (attempts >= UPLOAD_MAX_ATTEMPTS) {
    console.log(`❌ [${job.eventType}] ${job.clipId}: upload gave up after ${attempts} attempts — clip is safe at ${job.localPath}`);
    update(job, { status: 'FAILED', error: `upload failed: ${reason}` });
    return;
  }
  const delay = UPLOAD_BACKOFF_MS[Math.min(attempts, UPLOAD_BACKOFF_MS.length) - 1] || UPLOAD_BACKOFF_MS[0];
  console.log(`⚠️  [${job.eventType}] ${job.clipId}: upload failed (${reason}) — retry ${attempts + 1} in ${Math.round(delay / 1000)}s; clip is safe locally`);
  update(job, { status: 'UPLOAD_RETRY', error: reason, nextUploadAt: Date.now() + delay });
  later(() => queueUpload(job), delay);
}

// Streams a file as the request body. Times out only when nothing moves
// for UPLOAD_IDLE_TIMEOUT_MS — a big clip on a slow link is fine.
function postFile(url, filePath, extraHeaders) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad website URL' }); }
    let size;
    try { size = fs.statSync(filePath).size; } catch (e) { return resolve({ ok: false, error: 'clip file missing' }); }
    const lib = u.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; resolve(res); } };
    const req = lib.request(u, {
      method: 'POST',
      agent: false, // one fresh connection per upload — nothing pooled can go stale over a 7-hour match
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': size, ...extraHeaders },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 4000) body += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) finish({ ok: true, body });
        else finish({ ok: false, error: `website answered HTTP ${res.statusCode}${body ? `: ${body.slice(0, 150)}` : ''}` });
      });
      res.on('error', (e) => finish({ ok: false, error: e.message }));
    });
    req.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => { req.destroy(new Error(`no progress for ${UPLOAD_IDLE_TIMEOUT_MS / 1000}s`)); });
    req.on('error', (e) => finish({ ok: false, error: e.message }));
    const stream = fs.createReadStream(filePath);
    stream.on('error', (e) => { req.destroy(e); finish({ ok: false, error: `read error: ${e.message}` }); });
    stream.pipe(req);
  });
}

function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 20000) body += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (_) { resolve({ status: res.statusCode, json: null }); } });
      res.on('error', () => resolve(null));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });
}

// 🔎 Follows each uploaded clip's R2 and Drive legs on the website (for
// the panel's status list) until both are done, it failed permanently,
// or an hour has passed. One loop for all clips; a few at a time.
// Polls one clip and applies whatever the website now reports. Split out
// of the tick below so a whole batch can be polled in PARALLEL — the old
// sequential `await` inside the loop meant 6 clips × a slow round-trip
// could take longer than the tick interval itself, which is what let two
// ticks overlap and log the same "in R2 + Drive" line twice.
async function pollOneClipStatus(server, job) {
  job.lastPolledAt = Date.now();
  const r = await getJson(`${server}/api/clips/status/${encodeURIComponent(job.clipId)}`);
  if (!r || r.status !== 200 || !r.json || !r.json.success) return;
  const d = r.json;

  // Remembered before the patch so each leg is announced EXACTLY once,
  // on the tick it actually changes — never re-logged on later polls.
  const prevR2 = job.r2Status;
  const prevDrive = job.driveStatus;
  const wasComplete = job.status === 'COMPLETE';

  const patch = { r2Status: d.r2Status || job.r2Status, driveStatus: d.driveStatus || job.driveStatus, serverStatus: d.status };

  // 📣 Per-leg progress in this window, so R2 and Drive each announce
  // themselves the moment they land instead of only a combined line at
  // the very end (and a failing leg says WHY, so it can be fixed rather
  // than just silently retried).
  if (patch.r2Status === 'uploaded' && prevR2 !== 'uploaded') {
    console.log(`☁️  [${job.eventType}] ${job.clipId}: R2 ✓`);
  }
  if (patch.driveStatus === 'uploaded' && prevDrive !== 'uploaded') {
    console.log(`📁 [${job.eventType}] ${job.clipId}: Google Drive ✓`);
  }
  if (patch.r2Status === 'failed' && prevR2 !== 'failed') {
    console.log(`⚠️  [${job.eventType}] ${job.clipId}: R2 upload failed — ${d.r2Error || 'no reason reported'} (retrying)`);
  }
  if (patch.driveStatus === 'failed' && prevDrive !== 'failed') {
    console.log(`⚠️  [${job.eventType}] ${job.clipId}: Google Drive upload failed — ${d.driveError || 'no reason reported'} (retrying)`);
  }

  if (d.status === 'COMPLETE') {
    Object.assign(patch, { status: 'COMPLETE', serverFailed: false, driveBackupFailed: false, error: null });
    if (!wasComplete) console.log(`✅ [${job.eventType}] ${job.clipId}: in R2 + Drive`);
  } else if (d.status === 'NEEDS_REUPLOAD') {
    // The website restarted and lost its temporary copy before R2/Drive
    // finished. Our local copy is the source of truth — send it again.
    if (job.localPath && fs.existsSync(job.localPath)) {
      console.log(`🔁 [${job.eventType}] ${job.clipId}: website lost its copy — re-sending the local clip`);
      Object.assign(patch, { status: 'UPLOAD_RETRY', serverFailed: false, uploadAttempts: 0, error: 'website restarted — re-sending clip', nextUploadAt: Date.now() });
      update(job, patch);
      job.uploadAttempts = 0;
      queueUpload(job);
      return;
    }
    Object.assign(patch, { status: 'FAILED', serverFailed: false, error: 'website lost its copy and the local clip file is missing' });
  } else if (d.status === 'FAILED_PERMANENT') {
    if (d.r2Status === 'uploaded') {
      // Clip plays from R2 — only the Drive backup copy is missing.
      Object.assign(patch, { status: 'COMPLETE', serverFailed: true, driveBackupFailed: true, error: null });
    } else {
      Object.assign(patch, { status: 'FAILED', serverFailed: true, error: d.permanentFailureReason || 'website could not upload to R2/Drive' });
    }
  }
  update(job, patch);
}

// 🔎 Follows each uploaded clip's R2 and Drive legs on the website (for
// the panel's status list) until both are done, it failed permanently,
// or the poll window closes. One loop for all clips, polled in parallel.
let statusPollRunning = false;
async function statusPollTick() {
  // 🔒 Re-entrancy guard: a slow round-trip used to let the next interval
  // fire while this tick was still awaiting, so the SAME clip got polled
  // (and its completion logged) twice. One tick at a time, always.
  if (statusPollRunning) return;
  const server = session.mainServerUrl || toOrigin(config.mainServerUrl);
  if (!server) return;
  statusPollRunning = true;
  try {
    // UPLOADED = website still finishing R2/Drive. A website-side failure
    // (serverFailed) is still followed, since the website can recover it.
    const due = [...jobs.values()]
      .filter((j) => (j.status === 'UPLOADED' || (j.status === 'FAILED' && j.serverFailed)) && Date.now() - (j.uploadedAt || 0) < STATUS_POLL_WINDOW_MS)
      .sort((a, b) => (a.lastPolledAt || 0) - (b.lastPolledAt || 0));
    await Promise.all(due.slice(0, STATUS_POLL_BATCH).map((job) => pollOneClipStatus(server, job).catch(() => {})));
  } finally {
    statusPollRunning = false;
  }
}
setInterval(() => { statusPollTick().catch(() => {}); }, STATUS_POLL_INTERVAL_MS);

// ----------------------------------------------------------------
// 🌐 HTTP API (panel ↔ helper). Same endpoints as v3, plus /clip-jobs.
// ----------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome (Private/Local Network Access): an https:// panel calling
  // http://localhost needs this on the preflight, or the request fails
  // as a generic "Failed to fetch".
  res.header('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function setupPageHtml(message) {
  const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const src = activeRecording ? sourceFor(activeRecording.file) : null;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Clipper Helper — Setup</title>
<style>
  body{ font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif; background:#0b0f1a; color:#f2f4f8; margin:0; }
  .wrap{ max-width:520px; margin:40px auto; padding:0 20px; }
  h1{ font-size:18px; margin-bottom:4px; } p.sub{ color:#8892a6; font-size:13px; margin-top:0; }
  label{ display:block; font-size:12px; color:#8892a6; margin:16px 0 6px; }
  input[type=text]{ width:100%; box-sizing:border-box; padding:10px; border-radius:7px; border:1px solid #232c42; background:#182034; color:#f2f4f8; font-size:14px; }
  button{ margin-top:20px; width:100%; padding:12px; border-radius:8px; border:none; background:#ff7a00; color:#12100c; font-weight:700; font-size:14px; cursor:pointer; }
  .msg{ margin-top:14px; padding:10px 12px; border-radius:7px; font-size:13px; background:rgba(34,197,94,.15); color:#22c55e; border:1px solid #22c55e; }
  .status{ margin-top:24px; font-size:12px; color:#8892a6; line-height:1.7; }
  .bad{ color:#f87171; } .good{ color:#22c55e; }
</style></head>
<body><div class="wrap">
  <h1>🎥 Clipper Helper — Setup</h1>
  <p class="sub">Yeh 2 cheez bharo aur Save dabao — config.json khud ban jayega.</p>
  ${message ? `<div class="msg">${message}</div>` : ''}
  <form method="POST" action="/setup">
    <label>vMix Recording — vMix jis file (ya folder) me record karta hai, uska poora path</label>
    <input type="text" name="recordingFile" value="${esc(config.vmixRecordingFile)}" placeholder="D:\\ClipperRecording\\recording.mp4">
    <label>Website URL — panel jis website par khulta hai</label>
    <input type="text" name="websiteUrl" value="${esc(config.mainServerUrl)}" placeholder="https://allsportslivestreams.com">
    <button type="submit">💾 Save</button>
  </form>
  <div class="status">
    Recording: ${activeRecording ? `<span class="good">${esc(activeRecording.file)}</span> ${activeRecording.growing ? '(recording ✅)' : '(not growing — vMix not recording right now)'}` : `<span class="bad">${esc(recordingError || 'not found yet')}</span>`}<br>
    ${src && src.lastError ? `<span class="bad">Recording read error: ${esc(src.lastError)}</span><br>` : ''}
    Clips folder: ${esc(getClipsDir())}<br>
    Website: ${esc(session.mainServerUrl || toOrigin(config.mainServerUrl) || 'not set')} · Port ${config.port}<br>
    Iss window ko match khatam hone tak khula rakho.
  </div>
</div></body></html>`;
}

app.get('/setup', async (req, res) => {
  await resolveActiveRecording().catch(() => {});
  res.send(setupPageHtml(null));
});
app.post('/setup', async (req, res) => {
  const { recordingFile, websiteUrl } = req.body || {};
  if (recordingFile !== undefined) config.vmixRecordingFile = String(recordingFile).trim().replace(/^"|"$/g, '');
  if (websiteUrl !== undefined) {
    config.mainServerUrl = String(websiteUrl).trim();
    const origin = toOrigin(config.mainServerUrl);
    if (origin) { session.mainServerUrl = origin; saveSession(); }
  }
  saveConfig();
  console.log('💾 Setup saved:', { vmixRecordingFile: config.vmixRecordingFile, website: toOrigin(config.mainServerUrl) });
  await resolveActiveRecording().catch(() => {});
  res.send(setupPageHtml('✅ Saved! Ab is tab ko band karke match shuru kar sakte ho.'));
});

function jobView(j) {
  return {
    clipId: j.clipId, matchId: j.matchId, eventType: j.eventType, t0: j.t0,
    status: j.status, error: j.error || null,
    cutAttempts: j.cutAttempts || 0, uploadAttempts: j.uploadAttempts || 0,
    nextUploadAt: j.nextUploadAt || null,
    clipSeconds: j.clipSeconds || null, localPath: j.localPath || null,
    r2Status: j.r2Status || null, driveStatus: j.driveStatus || null,
    driveBackupFailed: !!j.driveBackupFailed,
    createdAt: j.createdAt, updatedAt: j.updatedAt,
  };
}

app.get('/status', async (req, res) => {
  const rec = activeRecording;
  const src = rec ? sourceFor(rec.file) : null;
  const all = [...jobs.values()];
  res.json({
    running: true,
    version: 4,
    matchId: session.matchId,
    mainServerUrl: session.mainServerUrl || toOrigin(config.mainServerUrl) || null,
    recordingStartedAt: session.recordingStartedAt,
    vmixRecordingFile: config.vmixRecordingFile,
    vmixRecordingFolder: recordingDir(),
    currentRecordingFile: rec ? rec.file : null,
    recordingGrowing: !!(rec && rec.growing),
    recordingSeconds: src ? Math.round(src.durationSec) : null,
    recordingError: recordingError || (src && src.lastError) || null,
    clipsDir: getClipsDir(),
    clipTiming: { beforeSeconds: PRE_ROLL_SECONDS, afterSeconds: POST_ROLL_SECONDS, durationSeconds: CLIP_SECONDS },
    driveConnected: !!session.driveFolderId,
    driveFolderName: session.driveFolderName,
    cutQueueLength: cutQueue.length + (cutRunning ? 1 : 0),
    uploadQueueLength: uploadQueue.length + uploadsRunning,
    clipsOk: all.filter((j) => ['LOCAL_SAVED', 'UPLOADING', 'UPLOADED', 'UPLOAD_RETRY', 'COMPLETE'].includes(j.status)).length,
    failedClipsCount: all.filter((j) => j.status === 'FAILED').length,
    ffmpegChildren: children.size,
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
  });
});

// Newest first — the panel's live status list.
app.get('/clip-jobs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const list = [...jobs.values()]
    .filter((j) => !req.query.matchId || j.matchId === req.query.matchId)
    .sort((a, b) => b.t0 - a.t0).slice(0, limit).map(jobView);
  res.json({ success: true, jobs: list });
});
app.get('/clip-jobs/:clipId', (req, res) => {
  const j = jobs.get(req.params.clipId);
  if (!j) return res.status(404).json({ success: false, error: 'No clip job with that clipId' });
  res.json({ success: true, job: jobView(j) });
});
app.get('/failed-clips', (req, res) => {
  res.json({ failedClips: [...jobs.values()].filter((j) => j.status === 'FAILED').map(jobView) });
});

app.post('/recording-start', (req, res) => {
  const b = req.body || {};
  session.recordingStartedAt = Number(b.startedAt) || Date.now();
  if (b.matchId) session.matchId = String(b.matchId);
  const origin = toOrigin(b.mainServerUrl);
  if (origin) session.mainServerUrl = origin;
  saveSession();
  console.log(`🔴 Recording session started${session.matchId ? ` (match ${session.matchId})` : ''} — website ${session.mainServerUrl || 'not set'}`);
  res.json({ success: true, vmixControlled: false });
});
app.post('/recording-stop', (req, res) => {
  console.log('⏹  Recording session stopped (clips already requested are still cut and uploaded)');
  res.json({ success: true, vmixControlled: false });
});

// Kept for the panel's "Connect Google Drive" flow. Drive uploads are
// done by the website (independently of R2); this only shows in /status.
app.post('/set-folder', (req, res) => {
  const { folderId, folderName } = req.body || {};
  if (folderId) {
    const changed = session.driveFolderId !== folderId;
    session.driveFolderId = folderId;
    session.driveFolderName = folderName || session.driveFolderName || 'Selected folder';
    saveSession();
    // Announced in this window the same way the recording session is, so
    // the operator can SEE Drive is connected here and not only in the
    // browser panel. A silent refresh of the same folder (the panel
    // re-sends a fresh Google token every 45 min) isn't re-announced.
    if (changed) console.log(`📁 Google Drive connected — clips upload to "${session.driveFolderName}"`);
  }
  res.json({ success: true });
});
app.post('/set-token', (req, res) => res.json({ success: true }));

// POST /clip { eventType, timestamp, matchId, ballMeta, clipId? }
// Acknowledged immediately; T0 (the press) is frozen into the job.
app.post('/clip', async (req, res) => {
  const b = req.body || {};
  const t0 = Number(b.timestamp) || Date.now();
  const eventType = String(b.eventType || 'CLIP').toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'CLIP';
  const matchId = String(b.matchId || session.matchId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
  if (matchId !== session.matchId) { session.matchId = matchId; saveSession(); }
  const clipId = b.clipId ? String(b.clipId).replace(/[^a-zA-Z0-9_-]/g, '') : buildClipId(matchId, eventType, t0);

  const existing = jobs.get(clipId);
  if (existing) return res.json({ success: true, clipId, duplicate: true, status: existing.status });

  const job = {
    clipId, matchId, eventType, t0,
    // Frozen at the press — the ONLY timing this clip ever uses.
    window: { startWall: t0 - PRE_ROLL_SECONDS * 1000, endWall: t0 + POST_ROLL_SECONDS * 1000 },
    ballMeta: b.ballMeta || null,
    sourceFile: activeRecording && activeRecording.growing ? activeRecording.file : null,
    status: 'WAITING', createdAt: Date.now(), updatedAt: Date.now(),
  };
  jobs.set(clipId, job);
  pruneJobs();
  flushJobsNow(); // a press is written to disk before it's acknowledged — a crash right after can't lose it
  scheduleCut(job);
  console.log(`📥 [${eventType}] ${clipId} at ${new Date(t0).toLocaleTimeString()} — cutting ${PRE_ROLL_SECONDS}s before → ${POST_ROLL_SECONDS}s after`);
  // recordingActive:false lets the panel warn the operator right away
  // that vMix isn't recording (the clip would have no footage).
  res.json({ success: true, clipId, status: job.status, recordingActive: !!job.sourceFile });
  if (!job.sourceFile) resolveActiveRecording().then((rec) => { if (rec && !job.sourceFile) job.sourceFile = rec.file; }).catch(() => {});
});

// ----------------------------------------------------------------
// 🔄 STARTUP RECOVERY — resume whatever the last run left unfinished,
// and import v3's "cut but never uploaded" clips so none are lost.
// ----------------------------------------------------------------
function resumeJobs() {
  let cuts = 0, ups = 0;
  for (const job of jobs.values()) {
    if (['WAITING', 'CUTTING', 'CUT_RETRY'].includes(job.status)) {
      job.cutAttempts = Math.min(job.cutAttempts || 0, CUT_MAX_ATTEMPTS - 1);
      job.status = 'WAITING';
      scheduleCut(job);
      cuts++;
    } else if (['LOCAL_SAVED', 'UPLOADING', 'UPLOAD_RETRY'].includes(job.status)) {
      job.status = 'UPLOAD_RETRY';
      queueUpload(job);
      ups++;
    }
  }
  const v3Log = path.join(BASE_DIR, 'failed-clips.json');
  try {
    const list = JSON.parse(fs.readFileSync(v3Log, 'utf8'));
    const left = [];
    for (const e of list) {
      if (e.outputPath && fs.existsSync(e.outputPath) && e.matchId && e.eventTime) {
        const clipId = buildClipId(e.matchId, e.eventType, e.eventTime);
        if (!jobs.has(clipId)) {
          jobs.set(clipId, { clipId, matchId: e.matchId, eventType: String(e.eventType || 'CLIP').toUpperCase(), t0: e.eventTime, ballMeta: e.ballMeta || null, localPath: e.outputPath, status: 'UPLOAD_RETRY', createdAt: Date.now(), updatedAt: Date.now() });
          queueUpload(jobs.get(clipId));
          ups++;
        }
      } else left.push(e);
    }
    fs.writeFileSync(v3Log, JSON.stringify(left, null, 2));
  } catch (_) { /* no v3 log */ }
  persistJobs();
  if (cuts || ups) console.log(`🔄 Resumed from last run: ${cuts} clip(s) to cut, ${ups} to upload`);
}

// Leftover .part/.src files can only come from a cut interrupted by a restart.
function sweepPartFiles() {
  fs.readdir(getClipsDir(), (err, names) => {
    if (err) return;
    for (const n of names) if (/\.(part|src)\.mp4$|\.list\.txt$/.test(n)) fs.unlink(path.join(getClipsDir(), n), () => {});
  });
}

// 🩺 One line every 10 minutes: proof over a 6–7 hour match that queues,
// processes and memory stay flat.
setInterval(() => {
  const all = [...jobs.values()];
  const count = (s) => all.filter((j) => j.status === s).length;
  const src = activeRecording ? sourceFor(activeRecording.file) : null;
  console.log(`[health] recording ${activeRecording ? `${path.basename(activeRecording.file)} ${src ? Math.round(src.durationSec / 60) : '?'}min${activeRecording.growing ? '' : ' (not growing)'}` : 'none'} | cut queue ${cutQueue.length} | uploads ${uploadQueue.length + uploadsRunning} | done ${count('COMPLETE') + count('UPLOADED')} | failed ${count('FAILED')} | ffmpeg ${children.size} | mem ${Math.round(process.memoryUsage().rss / 1048576)}MB`);
}, 10 * 60 * 1000);

const server = app.listen(config.port, () => {
  console.log('================================================');
  console.log(`🎥 Clipper Helper v4.2 running at http://localhost:${config.port}`);
  console.log(`👉 Setup page: http://localhost:${config.port}/setup`);
  console.log(`Using ffmpeg: ${ffmpegPath}`);
  console.log(`Clip window: ${PRE_ROLL_SECONDS}s before + ${POST_ROLL_SECONDS}s after the press = ${CLIP_SECONDS}s`);
  console.log(`Clips folder: ${getClipsDir()}`);
  console.log(`Website: ${session.mainServerUrl || toOrigin(config.mainServerUrl) || 'not set — open the Setup page'}`);
  if (!fs.existsSync(ffmpegPath)) {
    console.log('⚠️  WARNING: ffmpeg.exe not found — clips cannot be cut. Put ffmpeg.exe in the SAME folder as ClipperHelper.exe.');
  }
  console.log('Keep this window open during the match.');
  console.log('================================================');
  detectEncoder().catch(() => {});
  sourceTick();
  sweepPartFiles();
  resumeJobs();
  if (!process.env.CLIPPER_NO_BROWSER) {
    const setupUrl = `http://localhost:${config.port}/setup`;
    const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${opener} ${setupUrl}`, () => {});
  }
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.log(`❌ Port ${config.port} is already in use — is another Clipper Helper window already open? Close it and start this one again.`);
  else console.log('❌ Server error:', err.message);
});

// Clean exit: stop every ffmpeg this helper started, save state.
function shutdown() {
  for (const t of timers) clearTimeout(t);
  for (const p of children) { try { p.kill('SIGKILL'); } catch (_) {} }
  flushJobsNow();
  console.log('Clipper Helper stopped — unfinished clips resume next time it starts.');
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, shutdown); } catch (_) { /* not on this platform */ }
}
