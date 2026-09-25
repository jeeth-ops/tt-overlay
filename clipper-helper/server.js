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
const organizer = require('./clipOrganizer');

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
  // The clip window, in seconds. 15 before + 5 after the press = 20 s.
  preRollSeconds: 15,
  postRollSeconds: 5,
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
// The website this helper syncs to (session value wins — the panel sends
// it on every "Start Recording" — with config.json as the fallback).
function websiteOrigin() {
  return session.mainServerUrl || toOrigin(config.mainServerUrl) || '';
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
// 15 s before the press + 5 s after it = a 20 s clip. Both are
// overridable in config.json for a venue that wants a different window;
// the cut, the wait for the footage and everything downstream read these
// two numbers only, so they always agree.
// ----------------------------------------------------------------
const PRE_ROLL_SECONDS = clampSeconds(config.preRollSeconds, 15, 1, 120);   // footage kept BEFORE the press
const POST_ROLL_SECONDS = clampSeconds(config.postRollSeconds, 5, 1, 60);   // footage kept AFTER the press (and the wait before cutting)
const CLIP_SECONDS = PRE_ROLL_SECONDS + POST_ROLL_SECONDS; // 20
function clampSeconds(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

const COVERAGE_WAIT_MAX_MS = 30000;   // max extra wait for the recording to reach T0+3s on disk
const CUT_TIMEOUT_MS = 120000;        // one ffmpeg cut; killed after this
// A temporary problem (recording briefly locked, disk busy, ffmpeg hiccup)
// gets ~2 minutes of retries before a clip is given up — the footage stays
// in the recording, so there is no reason to fail fast.
const CUT_MAX_ATTEMPTS = 6;
const CUT_RETRY_DELAYS_MS = [3000, 8000, 15000, 30000, 60000];
const UPLOAD_IDLE_TIMEOUT_MS = 60000; // no bytes moving for this long = dead connection
// A reset connection is usually retryable immediately — the old first step
// of 5s (then 15s, 30s, 60s) meant a clip that only needed one more try sat
// idle for minutes across a few failures. Fast at first, then backs off the
// same way for the genuinely-down case.
const UPLOAD_BACKOFF_MS = [2000, 5000, 10000, 20000, 45000, 90000, 180000, 300000]; // then every 5 min
// 🛟 A clip that exists on this disk is NEVER given up on. The old build
// stopped after 60 attempts and marked the clip FAILED — which, on a
// laptop that was simply offline for a few hours, permanently abandoned
// perfectly good clips that only needed the internet to come back. There
// is no attempt limit any more: sync retries with a capped backoff for as
// long as the clip is unsynced, and only a MISSING/never-cut local file
// is a real failure.
const SYNC_MAX_BACKOFF_MS = 5 * 60 * 1000;
// Connectivity probe cadence. Offline: one tiny request every 10 s (the
// ONE network call made while offline — nothing else is attempted, so R2,
// Drive and the website are never hammered). Online: a refresh every 30 s.
const NET_PROBE_OFFLINE_MS = 10000;
const NET_PROBE_ONLINE_MS = 30000;
const NET_PROBE_TIMEOUT_MS = 8000;
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
// ffmpeg's scratch space (.part/.src pieces). Kept in its own folder so
// the organised tree beside the master recording only ever contains real,
// finished, properly-named clips.
function getWorkDir() {
  return path.join(getClipsDir(), '_work');
}
// Is this path inside the Clips tree? (Used so a clip is never mistaken
// for the master recording — the tree is now several folders deep.)
function insideClipsDir(file) {
  const root = path.resolve(getClipsDir()) + path.sep;
  return (path.resolve(file) + path.sep).startsWith(root);
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
  try {
    for (const name of await fs.promises.readdir(dir)) {
      if (!MEDIA_EXT.has(path.extname(name).toLowerCase()) || isClipFileName(name)) continue;
      const full = path.join(dir, name);
      if (insideClipsDir(full)) continue; // a clip (anywhere in the Clips tree) is never the master recording
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
// 🌐 CONNECTIVITY — the ONLY thing in this helper that ever asks whether
// the internet exists, and it is asked by the SYNC side only. Cutting a
// clip, naming it and filing it never consult this: Stage A (local clip)
// is complete before Stage B (cloud sync) is even considered.
//
// Offline means exactly one tiny request every 10 s (GET <website>/api/ping,
// which is a few bytes and touches no database) and nothing else — no
// upload attempts to burn, no R2/Drive traffic, no retry budget consumed.
// The moment it answers, every pending clip is resumed from the stage it
// had reached, in order.
// ----------------------------------------------------------------
const net = {
  online: null,        // null = not probed yet
  lastOkAt: 0,
  lastCheckAt: 0,
  lastError: null,
  probing: null,
  wentOfflineAt: 0,
};

function probeInternet(force = false) {
  if (net.probing) return net.probing;
  const server = websiteOrigin();
  if (!server) {
    net.online = false;
    net.lastError = 'website URL not set — open the Setup page';
    return Promise.resolve(false);
  }
  const due = net.online ? NET_PROBE_ONLINE_MS : NET_PROBE_OFFLINE_MS;
  if (!force && net.lastCheckAt && Date.now() - net.lastCheckAt < due) return Promise.resolve(!!net.online);
  net.probing = (async () => {
    net.lastCheckAt = Date.now();
    // ANY HTTP answer proves the website is reachable — /api/ping is the
    // cheap dedicated endpoint, but an older deploy answering 404 is just
    // as good a proof of connectivity.
    const r = await getJson(`${server}/api/ping`, NET_PROBE_TIMEOUT_MS);
    const ok = !!(r && r.status);
    setOnline(ok, ok ? null : 'no answer from the website');
    return ok;
  })().finally(() => { net.probing = null; });
  return net.probing;
}

function setOnline(ok, reason) {
  const was = net.online;
  net.online = ok;
  net.lastError = ok ? null : (reason || net.lastError);
  if (ok) net.lastOkAt = Date.now();
  if (was === ok) return;
  if (ok) {
    const pending = [...jobs.values()].filter(isUnsynced).length;
    console.log(`🌐 INTERNET DETECTED${was === false ? ` after ${Math.round((Date.now() - (net.wentOfflineAt || Date.now())) / 1000)}s offline` : ''} — ${pending} clip(s) pending sync`);
    resumePendingSync('internet is back');
  } else {
    net.wentOfflineAt = Date.now();
    const pending = [...jobs.values()].filter(isUnsynced).length;
    console.log(`📴 No internet (${net.lastError || 'unreachable'}) — clips keep being cut and saved locally${pending ? `; ${pending} waiting to sync` : ''}`);
  }
}

// Every clip whose cloud sync has not finished yet (and whose local file
// is the safe copy in the meantime).
function isUnsynced(job) {
  return !['SYNC_COMPLETE', 'CUT_FAILED'].includes(job.status);
}

function resumePendingSync(why) {
  let n = 0;
  for (const job of jobs.values()) {
    if (!SYNCABLE.includes(job.status)) continue;
    // Being offline never counted as a real failure — give every clip a
    // clean slate the moment the connection is back.
    job.syncAttempts = 0;
    job.nextUploadAt = null;
    queueSync(job);
    n++;
  }
  if (n) console.log(`🔄 Resuming sync of ${n} pending clip(s) — ${why}`);
  return n;
}

// Reachability is also learned for free from real traffic: a successful
// upload proves we are online, a DNS/connect error proves we are not
// (an HTTP error answer does NOT — that is the website talking to us).
const OFFLINE_ERROR_RE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|ECONNRESET|socket hang up|network|timed out|no progress for/i;
function noteNetworkOutcome(ok, error) {
  if (ok) return setOnline(true, null);
  if (error && OFFLINE_ERROR_RE.test(String(error))) probeInternet(true).catch(() => {});
}

setInterval(() => { probeInternet().catch(() => {}); }, NET_PROBE_OFFLINE_MS);

// ----------------------------------------------------------------
// 🗂️ CLIP JOBS — one per HIGHLIGHTS/FOUR/SIX/WICKET press, and the
// persistent record of BOTH stages. Written to clip-jobs.json (atomically,
// and before a press is even acknowledged), so internet loss, an app
// restart and a laptop restart all resume exactly where they left off.
//
//  STAGE A (local, never needs the network):
//    WAITING → CUTTING → LOCAL_SAVED        (CUT_RETRY → CUT_FAILED)
//  STAGE B (cloud, only ever waits for the internet):
//    LOCAL_SAVED → OFFLINE_PENDING (no internet)
//               → SENDING → SENT → (R2 ✓, Drive ✓ reported by the website)
//               → WEBSITE_UPDATE → SYNC_COMPLETE
//    SYNC_RETRY / WEBSITE_RETRY while a stage is failing — never FAILED:
//    a clip that exists on this disk is retried for as long as it takes.
//
// A job also IS the queue record: every id needed to put the clip back on
// the exact ball it came from (match/tournament/innings/over/ball/event/
// striker/non-striker/bowler + the R2 and Drive destinations) is stored
// here at the moment of the press, so a clip that syncs hours later still
// lands in the same place it would have landed instantly.
// ----------------------------------------------------------------
// Stage A states (the clip is not on disk yet).
const CUT_STATES = ['WAITING', 'CUTTING', 'CUT_RETRY'];
// Stage B states (the clip IS on disk; only the cloud is outstanding).
const SYNCABLE = ['LOCAL_SAVED', 'OFFLINE_PENDING', 'SENDING', 'SENT', 'SYNC_RETRY', 'WEBSITE_UPDATE', 'WEBSITE_RETRY'];
// Old (pre-offline-queue) statuses found in an existing clip-jobs.json.
const LEGACY_STATUS = { UPLOADING: 'SENDING', UPLOAD_RETRY: 'SYNC_RETRY', UPLOADED: 'SENT', COMPLETE: 'SYNC_COMPLETE', FAILED: 'SYNC_RETRY' };
// What the operator sees — the exact vocabulary of the sync pipeline, so a
// clip that was cut perfectly and is only waiting for the internet never
// reads as a failure.
const STATUS_TEXT = {
  WAITING: 'WAITING FOR FOOTAGE',
  CUTTING: 'CUTTING LOCALLY',
  CUT_RETRY: 'CUT RETRY QUEUED',
  CUT_FAILED: 'CLIP COULD NOT BE CUT',
  LOCAL_SAVED: 'CLIP SAVED LOCALLY',
  OFFLINE_PENDING: 'UPLOAD PENDING - OFFLINE',
  SENDING: 'UPLOADING TO R2',
  SENT: 'R2 / DRIVE IN PROGRESS',
  SYNC_RETRY: 'R2 RETRY QUEUED',
  WEBSITE_UPDATE: 'UPDATING WEBSITE',
  WEBSITE_RETRY: 'WEBSITE UPDATE RETRY QUEUED',
  SYNC_COMPLETE: 'SYNC COMPLETE',
};
const JOBS_PATH = path.join(BASE_DIR, 'clip-jobs.json');
const jobs = new Map();
try {
  for (const j of JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'))) jobs.set(j.clipId, j);
} catch (_) { /* first run */ }

// 🏷️ Ball metadata that arrived before its own press did (an out-of-order
// panel outbox flush, or a press the helper never received). Persisted, so
// a restart still applies it to the clip when the press shows up.
const ORPHAN_META_PATH = path.join(BASE_DIR, 'clip-meta-pending.json');
const orphanMeta = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(ORPHAN_META_PATH, 'utf8'));
  for (const [k, v] of Object.entries(raw || {})) orphanMeta.set(k, v);
} catch (_) { /* first run */ }
function saveOrphanMeta() {
  // Anything older than 12 hours belongs to a match that is long over.
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [k, v] of orphanMeta) if (Number(v && v.receivedAt) && v.receivedAt < cutoff) orphanMeta.delete(k);
  fs.writeFile(ORPHAN_META_PATH, JSON.stringify(Object.fromEntries(orphanMeta)), () => {});
}

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
  return all.filter((j, i) => i >= all.length - 300 || !['SYNC_COMPLETE', 'CUT_FAILED'].includes(j.status));
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
    if (['SYNC_COMPLETE', 'CUT_FAILED'].includes(j.status)) jobs.delete(id);
  }
}

function buildClipId(matchId, eventType, t0) {
  return `${String(matchId || 'match').replace(/[^a-zA-Z0-9_-]/g, '')}_${String(eventType || 'CLIP').toUpperCase().replace(/[^A-Z0-9-]/g, '')}_${t0}`;
}

// ----------------------------------------------------------------
// 🧾 THE EVENT, AS THE PRESS SAW IT — everything the queue record needs
// to (a) file the clip locally and (b) later attach it, unchanged, to the
// exact ball it came from. Built from what the panel sent with the press
// (and refined once by /clip-meta when the scorer enters the outcome);
// never from anything that has to be fetched.
// ----------------------------------------------------------------
const str = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') return typeof v.name === 'string' ? (v.name.trim() || null) : null;
  const s = String(v).trim();
  return s || null;
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Merges a ballMeta/clipMeta payload into a job, keeping whatever is
// already known when the new payload is silent about it (a press-time
// snapshot must never be wiped by a later, partial update).
function applyEventMeta(job, payload) {
  const m = payload || {};
  const ball = m.ballMeta && typeof m.ballMeta === 'object' ? m.ballMeta : m;
  const pick = (next, prev) => (next === null || next === undefined ? (prev === undefined ? null : prev) : next);

  job.tournamentId = pick(str(m.tournamentId || m.tournament), job.tournamentId);
  job.tournamentName = pick(str(m.tournamentName || m.tournament), job.tournamentName);
  job.tournamentMatchId = pick(str(m.tournamentMatchId), job.tournamentMatchId);
  job.matchLabel = pick(str(m.matchLabel), job.matchLabel);
  job.eventId = pick(str(m.eventId || ball.eventId || ball.ballId), job.eventId);
  job.innings = pick(num(ball.innings), job.innings);
  job.over = pick(num(ball.over), job.over);
  job.ballInOver = pick(num(ball.ballInOver), job.ballInOver);
  job.runs = pick(num(ball.runs), job.runs);
  job.battingTeam = pick(str(ball.battingTeam), job.battingTeam);
  job.bowlingTeam = pick(str(ball.bowlingTeam), job.bowlingTeam);
  job.battingTeamId = pick(str(ball.battingTeamId), job.battingTeamId);
  job.bowlingTeamId = pick(str(ball.bowlingTeamId), job.bowlingTeamId);
  job.strikerName = pick(str(ball.striker), job.strikerName);
  job.nonStrikerName = pick(str(ball.nonStriker), job.nonStrikerName);
  job.bowlerName = pick(str(ball.bowler), job.bowlerName);
  job.strikerId = pick(str(ball.strikerId), job.strikerId);
  job.nonStrikerId = pick(str(ball.nonStrikerId), job.nonStrikerId);
  job.bowlerId = pick(str(ball.bowlerId), job.bowlerId);
  job.dismissal = pick(ball.dismissal || null, job.dismissal);
  job.outcomeLabel = pick(str(m.outcomeLabel), job.outcomeLabel);
  if (m.isHighlight === true || m.isHighlight === false) job.isHighlight = m.isHighlight;
  if (m.eventType) {
    const et = String(m.eventType).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    // The trigger's own type is kept in eventType (it is part of clipId and
    // must never change); a re-classified outcome lands in outcomeType.
    if (et) job.outcomeType = et;
  }
  job.ballLabel = organizer.ballLabel(job) || job.ballLabel || null;
  job.playerIds = [job.strikerId, job.nonStrikerId, job.bowlerId].filter(Boolean);
  return job;
}

// The ballMeta the website already understands (unchanged shape — this is
// what links the clip to the canonical ball and the real players), plus
// the ids the offline queue carries.
function ballMetaFor(job) {
  return {
    innings: job.innings ?? undefined,
    over: job.over ?? undefined,
    ballInOver: job.ballInOver ?? undefined,
    runs: job.runs ?? undefined,
    battingTeam: job.battingTeam || undefined,
    bowlingTeam: job.bowlingTeam || undefined,
    striker: job.strikerName || undefined,
    nonStriker: job.nonStrikerName || undefined,
    bowler: job.bowlerName || undefined,
    strikerId: job.strikerId || null,
    nonStrikerId: job.nonStrikerId || null,
    bowlerId: job.bowlerId || null,
    dismissal: job.dismissal || null,
  };
}

// The offline-sync envelope: the clip's identity and destination exactly
// as it was decided at the press, whatever happened in between.
function clipMetaFor(job) {
  return {
    clipId: job.clipId,
    matchId: job.matchId,
    tournamentId: job.tournamentId || null,
    tournamentName: job.tournamentName || null,
    tournamentMatchId: job.tournamentMatchId || null,
    matchLabel: job.matchLabel || null,
    eventId: job.eventId || null,
    eventType: job.eventType,
    outcomeType: job.outcomeType || job.eventType,
    outcomeLabel: job.outcomeLabel || null,
    isHighlight: job.isHighlight === true || job.isHighlight === false ? job.isHighlight : null,
    innings: job.innings ?? null,
    over: job.over ?? null,
    ballInOver: job.ballInOver ?? null,
    ballLabel: job.ballLabel || null,
    battingTeam: job.battingTeam || null,
    bowlingTeam: job.bowlingTeam || null,
    battingTeamId: job.battingTeamId || null,
    bowlingTeamId: job.bowlingTeamId || null,
    strikerId: job.strikerId || null,
    nonStrikerId: job.nonStrikerId || null,
    bowlerId: job.bowlerId || null,
    playerIds: job.playerIds || [],
    strikerName: job.strikerName || null,
    nonStrikerName: job.nonStrikerName || null,
    bowlerName: job.bowlerName || null,
    timestamp: job.t0,
    clipStart: job.window && job.window.startWall,
    clipEnd: job.window && job.window.endWall,
    clipSeconds: job.clipSeconds || null,
    filename: job.filename || null,
    localFilePath: job.localFilePath || job.localPath || null,
    cutOffline: !!job.cutOffline,
    createdAt: job.createdAt,
    cutAt: job.savedAt || null,
  };
}

// The destinations, decided locally and stored with the job, so an offline
// clip's target is the SAME string the online path would have used:
//   R2    matches/<matchId>/clips/<clipId>.mp4   (server.js uploadClipToR2)
//   Drive <this match's connected folder>/<clipId>.mp4 (uploadClipToDrive)
function destinationsFor(job) {
  return {
    r2Destination: `matches/${job.matchId}/clips/${job.clipId}.mp4`,
    driveDestination: {
      folderId: session.driveFolderId || null,
      folderName: session.driveFolderName || null,
      fileName: `${job.clipId}.mp4`,
    },
  };
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
      if (!job || !CUT_STATES.includes(job.status)) continue;
      // 🛟 Already cut (a restart, or a duplicate enqueue) — NEVER cut the
      // same event twice just because the app came back.
      if (job.localPath && fs.existsSync(job.localPath)) { adoptExistingClip(job); continue; }
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

  // ffmpeg works entirely inside the scratch folder; the finished clip is
  // then filed into the organised tree by finalizeLocalClip() below.
  const clipsDir = getWorkDir();
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
  update(job, { localPath: outFile, clipSeconds: Number(check.seconds.toFixed(1)), savedAt: Date.now(), error: null });
  await finalizeLocalClip(job);
}

// ----------------------------------------------------------------
// 💾 STAGE A COMPLETE — the clip exists. File it into the organised tree
// beside the master recording, write its metadata next to it, and only
// THEN hand it to the (completely separate) sync queue.
//
// Nothing in here touches the network: the folders, the category, the
// filename and the batsman/bowler views are all decided from the event
// metadata that arrived with the press. Offline, this runs exactly as it
// does online.
// ----------------------------------------------------------------
async function finalizeLocalClip(job) {
  // Was this clip made with no connection? Taken at the moment it was
  // actually saved (the press may have happened a few seconds earlier,
  // before the connection dropped) — and set again if its sync ends up
  // waiting for the internet. Purely informational: it is what lets the
  // website (and the operator) see which clips came from an offline spell.
  if (net.online === false) job.cutOffline = true;
  await organizeClipFiles(job);
  const where = job.localPath;
  console.log(`💾 [${job.eventType}] ${job.clipId}: CLIP SAVED LOCALLY (${job.clipSeconds || '?'}s) → ${where}`);
  for (const l of job.links || []) {
    if (l.mode !== 'failed') console.log(`   ↳ ${l.role === 'batsman' ? '🏏' : '🎯'} ${l.playerName}: ${l.path}${l.mode === 'copy' ? ' (copy — this filesystem has no hard links)' : ''}`);
  }
  update(job, { status: 'LOCAL_SAVED', error: null, ...destinationsFor(job) });
  queueSync(job);
}

// Puts (or re-puts) the one physical clip where its metadata says it
// belongs, with hard links in the batsman's and bowler's folders.
// Idempotent, so it is safe to call again when the outcome arrives — the
// clip is MOVED and re-linked, never re-cut.
async function organizeClipFiles(job) {
  if (!job.localPath || !fs.existsSync(job.localPath)) return false;
  try {
    const placed = await organizer.placeClip({
      clipsRoot: getClipsDir(),
      currentPath: job.localPath,
      meta: {
        eventType: job.outcomeType || job.eventType,
        outcomeLabel: job.outcomeLabel,
        isHighlight: job.isHighlight,
        matchId: job.matchId, matchLabel: job.matchLabel,
        tournamentId: job.tournamentId, tournamentName: job.tournamentName,
        tournamentMatchId: job.tournamentMatchId,
        innings: job.innings, over: job.over, ballInOver: job.ballInOver,
        strikerName: job.strikerName, strikerId: job.strikerId,
        bowlerName: job.bowlerName, bowlerId: job.bowlerId,
        t0: job.t0,
      },
      previous: { primary: job.localPath, links: job.links || [] },
    });
    update(job, {
      localPath: placed.primary,
      localFilePath: placed.primary,
      filename: placed.filename,
      links: placed.links,
      matchRoot: placed.matchRoot,
      highlightCategory: placed.category,
      isHighlight: placed.isHighlight,
      organizedAt: Date.now(),
    });
    await organizer.writeClipMetadata(placed.matchRoot, clipMetaFor(job));
    return true;
  } catch (err) {
    // The clip itself is safe where it is — filing it is a browsing
    // convenience, and is retried the next time metadata arrives.
    console.log(`⚠️  [${job.eventType}] ${job.clipId}: could not file the clip into its folders (${err.message}) — the clip is still saved at ${job.localPath}`);
    return false;
  }
}

// A clip whose file is already on disk (restart, or a duplicate enqueue):
// adopt it instead of cutting it again.
function adoptExistingClip(job) {
  console.log(`♻️  [${job.eventType}] ${job.clipId}: already cut — reusing ${job.localPath} (no re-cut)`);
  update(job, { status: 'LOCAL_SAVED', error: null, ...destinationsFor(job) });
  queueSync(job);
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
  update(job, { status: 'CUT_FAILED', error: reason, failedAt: Date.now() });
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
// ☁️ STAGE B — CLOUD SYNC QUEUE. Network only, and completely separate
// from Stage A: a clip is already cut, named and filed on this disk
// before anything here runs, so nothing in this section can ever be a
// prerequisite for making a clip.
//
// The website holds the R2 and Drive credentials (the operator's laptop
// deliberately does not), so one POST of the finished clip drives both
// legs there — /api/clips/ingest → R2 + Drive, each retried independently
// — and this queue follows them and then writes the event attachment.
// Every step is keyed by the clip's stable clipId, so re-running any of
// them can only ever update the SAME R2 object, the SAME Drive file and
// the SAME database record:
//
//   verify local file → (R2 already there? skip the bytes)
//   → send clip → R2 ✓ → Drive ✓ → attach/update the website → SYNC COMPLETE
//
// A stage that fails is the ONLY stage retried: an R2 object that already
// landed is never uploaded twice, and a Drive failure never re-sends
// anything to R2 or re-cuts the clip.
// ----------------------------------------------------------------
const syncQueue = [];
let syncRunning = 0;
// Controlled concurrency — the laptop, the venue uplink, the website, R2
// and Drive all stay comfortable even when 25 offline clips arrive at
// once. On a venue uplink that is the bottleneck, more parallel uploads
// just split the same bandwidth, so each clip's connection stays open
// longer and is that much likelier to be reset mid-body.
const UPLOAD_CONCURRENCY = Math.max(1, parseInt(process.env.UPLOAD_CONCURRENCY, 10) || 2);

function queueSync(job) {
  if (!syncQueue.includes(job.clipId)) syncQueue.push(job.clipId);
  pumpSync();
}
// Kept as an alias so nothing that used the old name breaks.
const queueUpload = queueSync;

function pumpSync() {
  while (syncRunning < UPLOAD_CONCURRENCY && syncQueue.length) {
    const job = jobs.get(syncQueue.shift());
    if (!job || !SYNCABLE.includes(job.status)) continue;
    syncRunning++;
    syncJob(job)
      .catch((err) => onSyncFailure(job, `unexpected: ${err.message}`))
      .finally(() => { syncRunning--; pumpSync(); });
  }
}

// The local clip is the thing being synced, so it is checked first, every
// time — and a missing file is NEVER a reason to cut the event again.
function verifyLocalFile(job) {
  if (job.localPath && fs.existsSync(job.localPath)) return true;
  // The batsman/bowler folders hold hard links to the same bytes: if the
  // primary copy was moved or deleted by hand, one of those IS the clip.
  for (const l of job.links || []) {
    if (l && l.path && fs.existsSync(l.path)) {
      update(job, { localPath: l.path, localFilePath: l.path });
      return true;
    }
  }
  return false;
}

// Offline is a WAITING state, not a failure: no attempt is spent, no
// request is made, and the clip sits safely on disk until the connectivity
// probe (or the next restart) says the internet is back.
function markOfflinePending(job, reason) {
  job.cutOffline = true; // this clip's sync waited for the connection
  if (job.status !== 'OFFLINE_PENDING') {
    console.log(`📦 [${job.eventType}] ${job.clipId}: UPLOAD PENDING - OFFLINE (clip is safe at ${job.localPath})`);
  }
  update(job, { status: 'OFFLINE_PENDING', error: reason || net.lastError || 'no internet', nextUploadAt: null });
}

async function syncJob(job) {
  const server = websiteOrigin();
  const matchId = job.matchId || session.matchId;

  // 1️⃣ Verify the local file exists.
  if (!verifyLocalFile(job)) {
    console.log(`❌ [${job.eventType}] ${job.clipId}: local clip file is gone — cannot sync (the event is NOT re-cut)`);
    update(job, { status: 'CUT_FAILED', error: 'local clip file is missing — cannot sync' });
    return;
  }
  if (!server || !matchId) {
    update(job, { status: 'OFFLINE_PENDING', error: !server ? 'website URL not set — open the Setup page' : 'no match id for this clip', nextUploadAt: Date.now() + 30000 });
    later(() => queueSync(job), 30000);
    return;
  }

  // 2️⃣ Internet? If not, stop here — nothing is attempted or wasted.
  if (net.online === null) await probeInternet(true).catch(() => {});
  if (net.online === false) return markOfflinePending(job);

  job.syncAttempts = (job.syncAttempts || 0) + 1;
  job.retryCount = job.syncAttempts; // the queue record's own counter

  // 3️⃣ What does the website ALREADY have for this clipId? This is the
  // idempotency check: it decides whether the bytes still need sending at
  // all, and which leg is outstanding.
  const remote = await getJson(`${server}/api/clips/status/${encodeURIComponent(job.clipId)}`, 12000);
  if (!remote) { // no answer at all = the network, not the website
    noteNetworkOutcome(false, 'website unreachable');
    if (net.online === false) return markOfflinePending(job);
    return onSyncFailure(job, 'website unreachable');
  }
  noteNetworkOutcome(true);
  const doc = remote.status === 200 && remote.json && remote.json.success ? remote.json : null;
  const r2Done = !!doc && doc.r2Status === 'uploaded';
  const driveDone = !!doc && doc.driveStatus === 'uploaded';
  update(job, {
    r2Status: doc ? doc.r2Status || 'pending' : job.r2Status || 'pending',
    driveStatus: doc ? doc.driveStatus || 'pending' : job.driveStatus || 'pending',
    serverStatus: doc ? doc.status : null,
    r2Key: (doc && doc.r2Key) || job.r2Key || null,
    r2Url: (doc && doc.r2Url) || job.r2Url || null,
    driveFileId: (doc && doc.driveFileId) || job.driveFileId || null,
    driveUrl: (doc && doc.driveUrl) || job.driveUrl || null,
  });

  // 4️⃣ Both uploads already done → only the website attachment is left.
  if (r2Done && driveDone) return websiteStage(job, server);

  // 5️⃣ Send the clip, unless R2 already has it and the website still has
  // a usable copy for the Drive leg — in that case the Drive leg alone is
  // retried (by the website's own sweep) and we just follow it.
  const websiteLostItsCopy = !doc || doc.status === 'NEEDS_REUPLOAD' || doc.status === 'FAILED_PERMANENT';
  if (r2Done && !websiteLostItsCopy) {
    console.log(`⏭️  [${job.eventType}] ${job.clipId}: R2 already has this clip — not uploading it again; waiting on Drive only`);
    update(job, { status: 'SENT', uploadedAt: job.uploadedAt || Date.now(), error: null });
    return;
  }
  if (r2Done) console.log(`🔁 [${job.eventType}] ${job.clipId}: R2 ✓ already — re-sending the local clip so the DRIVE leg can finish (R2 is not uploaded twice)`);

  update(job, { status: 'SENDING', error: null });
  const qs = new URLSearchParams({ matchId, eventType: job.eventType, timestamp: String(job.t0), clipId: job.clipId });
  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(job.localPath).size; } catch (_) { /* reported by postFile */ }
  const startedAt = Date.now();
  console.log(`⬆️  [${job.eventType}] ${job.clipId}: UPLOADING TO R2 (via the website) — attempt ${job.syncAttempts}`);
  const r = await postFile(`${server}/api/clips/ingest?${qs}`, job.localPath, {
    // Unchanged header the website already links clips by…
    'X-Ball-Meta': headerJson(ballMetaFor(job)),
    // …plus the offline queue's own record of the event and its ids.
    'X-Clip-Meta': headerJson(clipMetaFor(job)),
  });
  const stats = uploadStats(sizeBytes, startedAt);
  if (!r.ok) {
    noteNetworkOutcome(false, r.error);
    if (net.online === false) return markOfflinePending(job);
    return onSyncFailure(job, r.error, stats);
  }
  noteNetworkOutcome(true);
  console.log(`📤 [${job.eventType}] ${job.clipId}: received by website (${stats}) — R2 + Drive uploads running there`);
  update(job, { status: 'SENT', uploadedAt: Date.now(), r2Status: job.r2Status === 'uploaded' ? 'uploaded' : 'pending', driveStatus: job.driveStatus === 'uploaded' ? 'uploaded' : 'pending', error: null });
}

// 📌 THE LAST STAGE — tell the website exactly which event this clip
// belongs to, using the ids captured at the press: tournament → match →
// innings → over → ball → event → striker/non-striker/bowler. Idempotent
// (keyed by clipId), so running it twice updates the same record and can
// never create a duplicate clip, event or player attachment.
async function websiteStage(job, server) {
  update(job, { status: 'WEBSITE_UPDATE', error: null });
  console.log(`🗄️  [${job.eventType}] ${job.clipId}: R2 ✓ · Drive ✓ · UPDATING WEBSITE (${job.ballLabel || 'ball ?'} ${job.outcomeLabel || job.eventType}${job.strikerName ? ` · ${job.strikerName}` : ''}${job.bowlerName ? ` vs ${job.bowlerName}` : ''})`);
  const r = await postJson(`${server}/api/clips/attach`, { clipMeta: clipMetaFor(job), ballMeta: ballMetaFor(job) });
  if (!r.ok) {
    noteNetworkOutcome(false, r.error);
    if (net.online === false) return markOfflinePending(job);
    const delay = syncBackoffMs(job.websiteAttempts = (job.websiteAttempts || 0) + 1);
    console.log(`⚠️  [${job.eventType}] ${job.clipId}: WEBSITE UPDATE RETRY QUEUED (${r.error}) — in ${Math.round(delay / 1000)}s; R2 + Drive stay done`);
    update(job, { status: 'WEBSITE_RETRY', error: r.error, nextUploadAt: Date.now() + delay });
    later(() => queueSync(job), delay);
    return;
  }
  noteNetworkOutcome(true);
  update(job, { status: 'SYNC_COMPLETE', websiteStatus: 'updated', syncedAt: Date.now(), error: null, attachedTo: r.json && r.json.attachedTo ? r.json.attachedTo : null });
  console.log(`✅ [${job.eventType}] ${job.clipId}: SYNC COMPLETE — local ✓ · R2 ✓ · Drive ✓ · website ✓`);
}

// 🔤 JSON safe to put in an HTTP header. Node (rightly) refuses a header
// value containing anything outside Latin-1, so a single accented player
// name — "Shivam Dubé", "Ángel", any Devanagari spelling — used to make
// the whole upload throw before a byte left the laptop (the clip stayed
// safe locally and retried forever, but never actually synced). Escaping
// non-ASCII as \uXXXX keeps it valid JSON that JSON.parse turns straight
// back into the original name on the website, with no server change.
function headerJson(obj) {
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// "6.5MB in 12.3s = 4.2 Mbps" — the one line that tells a dropped connection
// apart from a starved one.
function uploadStats(sizeBytes, startedAt) {
  const secs = Math.max(0.1, (Date.now() - startedAt) / 1000);
  const mb = sizeBytes / (1024 * 1024);
  const mbps = (sizeBytes * 8) / secs / 1e6;
  return `${mb.toFixed(1)}MB in ${secs.toFixed(1)}s = ${mbps.toFixed(1)} Mbps`;
}

// Fast at first (most failures that recover, recover at once), then capped
// at 5 minutes — and it never stops: the clip is on this disk, so there is
// always something worth retrying.
function syncBackoffMs(attempt) {
  return UPLOAD_BACKOFF_MS[Math.min(Math.max(1, attempt), UPLOAD_BACKOFF_MS.length) - 1] || SYNC_MAX_BACKOFF_MS;
}

function onSyncFailure(job, reason, stats) {
  if (stats) console.log(`   ↳ died after ${stats}`);
  const delay = syncBackoffMs(job.syncAttempts || 1);
  // Which stage is being retried — so the operator sees "R2 retry" (or
  // "DRIVE retry", or "WEBSITE UPDATE retry") and never "clip failed" for a
  // clip that was cut perfectly.
  const stage = job.r2Status !== 'uploaded' ? 'R2' : job.driveStatus !== 'uploaded' ? 'DRIVE' : 'WEBSITE UPDATE';
  console.log(`⚠️  [${job.eventType}] ${job.clipId}: ${stage} RETRY QUEUED (${reason}) — next try in ${Math.round(delay / 1000)}s; the clip itself is safe at ${job.localPath}`);
  update(job, { status: 'SYNC_RETRY', error: reason, nextUploadAt: Date.now() + delay });
  later(() => queueSync(job), delay);
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

// Small JSON POST (the website-attachment stage). Same shape of answer as
// postFile: { ok, json } or { ok:false, error }.
function postJson(url, body, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad website URL' }); }
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const lib = u.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; resolve(res); } };
    const req = lib.request(u, {
      method: 'POST',
      agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (text.length < 8000) text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* non-JSON answer */ }
        if (res.statusCode >= 200 && res.statusCode < 300) finish({ ok: true, json });
        else finish({ ok: false, error: `website answered HTTP ${res.statusCode}${text ? `: ${text.slice(0, 150)}` : ''}`, json });
      });
      res.on('error', (e) => finish({ ok: false, error: e.message }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`no answer in ${timeoutMs / 1000}s`)); });
    req.on('error', (e) => finish({ ok: false, error: e.message }));
    req.end(payload);
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
  if (!r) { noteNetworkOutcome(false, 'status poll got no answer'); return; }
  noteNetworkOutcome(true);
  if (r.status !== 200 || !r.json || !r.json.success) return;
  const d = r.json;

  // Remembered before the patch so each leg is announced EXACTLY once,
  // on the tick it actually changes — never re-logged on later polls.
  const prevR2 = job.r2Status;
  const prevDrive = job.driveStatus;

  const patch = {
    r2Status: d.r2Status || job.r2Status,
    driveStatus: d.driveStatus || job.driveStatus,
    serverStatus: d.status,
    r2Key: d.r2Key || job.r2Key || null,
    r2Url: d.r2Url || job.r2Url || null,
    driveFileId: d.driveFileId || job.driveFileId || null,
    driveUrl: d.driveUrl || job.driveUrl || null,
  };

  // 📣 Per-leg progress, so R2 and Drive each announce themselves the
  // moment they land (and a failing leg says WHY, so it can be fixed
  // rather than just silently retried).
  if (patch.r2Status === 'uploaded' && prevR2 !== 'uploaded') console.log(`☁️  [${job.eventType}] ${job.clipId}: R2 COMPLETE`);
  if (patch.driveStatus === 'uploaded' && prevDrive !== 'uploaded') console.log(`📁 [${job.eventType}] ${job.clipId}: DRIVE COMPLETE`);
  if (patch.r2Status === 'failed' && prevR2 !== 'failed') console.log(`⚠️  [${job.eventType}] ${job.clipId}: R2 RETRY QUEUED — ${d.r2Error || 'no reason reported'}`);
  if (patch.driveStatus === 'failed' && prevDrive !== 'failed') console.log(`⚠️  [${job.eventType}] ${job.clipId}: DRIVE RETRY QUEUED — ${d.driveError || 'no reason reported'}`);

  if (d.status === 'NEEDS_REUPLOAD') {
    // The website restarted and lost its temporary copy before R2/Drive
    // finished. Our local copy is the source of truth — send it again
    // (never re-cut, and R2 is skipped if it already has the object).
    if (verifyLocalFile(job)) {
      console.log(`🔁 [${job.eventType}] ${job.clipId}: website lost its copy — re-sending the local clip`);
      update(job, { ...patch, status: 'SYNC_RETRY', syncAttempts: 0, error: 'website restarted — re-sending clip', nextUploadAt: Date.now() });
      queueSync(job);
      return;
    }
    update(job, { ...patch, status: 'CUT_FAILED', error: 'website lost its copy and the local clip file is missing' });
    return;
  }

  // ✅ Both legs done → the final stage: attach/update the clip on the
  // website against the exact event it came from.
  const bothDone = patch.r2Status === 'uploaded' && patch.driveStatus === 'uploaded';
  // Drive gave up but the clip plays from R2: treat Drive as a best-effort
  // backup (exactly as before) and still finish the website attachment.
  const driveGaveUp = d.status === 'FAILED_PERMANENT' && patch.r2Status === 'uploaded';
  if (bothDone || driveGaveUp) {
    update(job, { ...patch, driveBackupFailed: !!driveGaveUp && patch.driveStatus !== 'uploaded' });
    if (['SENT', 'SYNC_RETRY'].includes(job.status)) queueSync(job); // → websiteStage()
    return;
  }
  if (d.status === 'FAILED_PERMANENT') {
    // R2 itself never landed — keep retrying from here (the clip is local
    // and safe, so this is never a permanent failure for us).
    update(job, { ...patch, status: 'SYNC_RETRY', error: d.permanentFailureReason || 'website could not upload to R2/Drive' });
    if (!job.nextUploadAt || job.nextUploadAt < Date.now()) {
      const delay = syncBackoffMs((job.syncAttempts || 1) + 1);
      update(job, { nextUploadAt: Date.now() + delay });
      later(() => queueSync(job), delay);
    }
    return;
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
    // SENT = the website has the clip and is finishing R2/Drive; a clip
    // whose leg is retrying there is still followed, since it can recover.
    if (net.online === false) return; // offline: nothing to ask, nothing to hammer
    const due = [...jobs.values()]
      .filter((j) => ['SENT', 'SYNC_RETRY'].includes(j.status) && j.uploadedAt && Date.now() - j.uploadedAt < STATUS_POLL_WINDOW_MS)
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

function pendingCount() {
  return [...jobs.values()].filter((j) => SYNCABLE.includes(j.status)).length;
}
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
    Internet: ${net.online === false ? `<span class="bad">offline — clips are still cut and saved locally${pendingCount() ? `, ${pendingCount()} waiting to sync` : ''}</span>` : net.online ? '<span class="good">connected</span>' : 'checking…'}<br>
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

// The panel reads this. `status` is the real state machine; `statusText` is
// the operator-facing line ("CLIP SAVED LOCALLY", "UPLOAD PENDING -
// OFFLINE", "SYNC COMPLETE"), and `legacyStatus` keeps an older panel
// build working unchanged.
const LEGACY_VIEW = {
  WAITING: 'WAITING', CUTTING: 'CUTTING', CUT_RETRY: 'CUT_RETRY', CUT_FAILED: 'FAILED',
  LOCAL_SAVED: 'LOCAL_SAVED', OFFLINE_PENDING: 'UPLOAD_RETRY', SENDING: 'UPLOADING',
  SENT: 'UPLOADED', SYNC_RETRY: 'UPLOAD_RETRY', WEBSITE_UPDATE: 'UPLOADED',
  WEBSITE_RETRY: 'UPLOAD_RETRY', SYNC_COMPLETE: 'COMPLETE',
};
function jobView(j) {
  const localSaved = !!(j.localPath && ['LOCAL_SAVED', 'OFFLINE_PENDING', 'SENDING', 'SENT', 'SYNC_RETRY', 'WEBSITE_UPDATE', 'WEBSITE_RETRY', 'SYNC_COMPLETE'].includes(j.status));
  return {
    clipId: j.clipId, matchId: j.matchId, eventType: j.eventType, t0: j.t0,
    status: LEGACY_VIEW[j.status] || j.status,   // what older panels understand
    syncStatus: j.status,                       // the real state
    statusText: STATUS_TEXT[j.status] || j.status,
    offline: j.status === 'OFFLINE_PENDING',
    localSaved,
    error: j.error || null,
    cutAttempts: j.cutAttempts || 0,
    uploadAttempts: j.syncAttempts || j.uploadAttempts || 0,
    retryCount: j.retryCount || 0,
    nextUploadAt: j.nextUploadAt || null,
    clipSeconds: j.clipSeconds || null,
    localPath: j.localPath || null,
    filename: j.filename || null,
    links: (j.links || []).map((l) => ({ role: l.role, playerName: l.playerName, path: l.path, mode: l.mode })),
    highlightCategory: j.highlightCategory || null,
    isHighlight: j.isHighlight === true || j.isHighlight === false ? j.isHighlight : null,
    ball: { innings: j.innings ?? null, over: j.over ?? null, ballInOver: j.ballInOver ?? null, label: j.ballLabel || null },
    outcomeLabel: j.outcomeLabel || null,
    striker: j.strikerName || null, bowler: j.bowlerName || null,
    strikerId: j.strikerId || null, bowlerId: j.bowlerId || null,
    r2Status: j.r2Status || null, driveStatus: j.driveStatus || null,
    websiteStatus: j.status === 'SYNC_COMPLETE' ? 'updated' : (j.websiteStatus || 'pending'),
    driveBackupFailed: !!j.driveBackupFailed,
    createdAt: j.createdAt, updatedAt: j.updatedAt, syncedAt: j.syncedAt || null,
  };
}

app.get('/status', async (req, res) => {
  const rec = activeRecording;
  const src = rec ? sourceFor(rec.file) : null;
  const all = [...jobs.values()];
  const count = (...s) => all.filter((j) => s.includes(j.status)).length;
  res.json({
    running: true,
    version: 5,
    matchId: session.matchId,
    mainServerUrl: websiteOrigin() || null,
    recordingStartedAt: session.recordingStartedAt,
    vmixRecordingFile: config.vmixRecordingFile,
    vmixRecordingFolder: recordingDir(),
    currentRecordingFile: rec ? rec.file : null,
    recordingGrowing: !!(rec && rec.growing),
    recordingSeconds: src ? Math.round(src.durationSec) : null,
    recordingError: recordingError || (src && src.lastError) || null,
    clipsDir: getClipsDir(),
    matchClipsFolder: session.matchId ? organizer.matchRootFor(getClipsDir(), matchMetaFromSession()) : null,
    clipTiming: { beforeSeconds: PRE_ROLL_SECONDS, afterSeconds: POST_ROLL_SECONDS, durationSeconds: CLIP_SECONDS },
    // 🌐 Local clipping never depends on this; only syncing does.
    online: net.online,
    onlineCheckedAt: net.lastCheckAt || null,
    onlineError: net.online ? null : net.lastError,
    driveConnected: !!session.driveFolderId,
    driveFolderName: session.driveFolderName,
    cutQueueLength: cutQueue.length + (cutRunning ? 1 : 0),
    uploadQueueLength: syncQueue.length + syncRunning,
    pendingSyncCount: all.filter(isUnsynced).length,
    offlinePendingCount: count('OFFLINE_PENDING'),
    syncedCount: count('SYNC_COMPLETE'),
    clipsOk: all.filter((j) => j.localPath && isUnsynced(j)).length + count('SYNC_COMPLETE'),
    failedClipsCount: count('CUT_FAILED'),
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
  // Only clips that could not be CUT are failures. A clip waiting for the
  // internet is not failed — see /clip-jobs (status OFFLINE_PENDING).
  res.json({ failedClips: [...jobs.values()].filter((j) => j.status === 'CUT_FAILED').map(jobView) });
});

// The match this recording belongs to, as the panel described it — used
// only for naming the LOCAL folder tree (the cloud destination keeps using
// the website's own R2/Drive structure, keyed by matchId).
function matchMetaFromSession() {
  return {
    matchId: session.matchId,
    matchLabel: session.matchLabel || null,
    tournamentId: session.tournamentId || null,
    tournamentName: session.tournamentName || session.tournamentId || null,
    tournamentMatchId: session.tournamentMatchId || null,
  };
}

app.post('/recording-start', async (req, res) => {
  const b = req.body || {};
  session.recordingStartedAt = Number(b.startedAt) || Date.now();
  if (b.matchId) session.matchId = String(b.matchId);
  if (b.matchLabel !== undefined) session.matchLabel = str(b.matchLabel);
  if (b.tournamentId !== undefined || b.tournament !== undefined) session.tournamentId = str(b.tournamentId || b.tournament);
  if (b.tournamentName !== undefined || b.tournament !== undefined) session.tournamentName = str(b.tournamentName || b.tournament);
  if (b.tournamentMatchId !== undefined) session.tournamentMatchId = str(b.tournamentMatchId);
  const origin = toOrigin(b.mainServerUrl);
  if (origin) session.mainServerUrl = origin;
  saveSession();
  console.log(`🔴 Recording session started${session.matchId ? ` (match ${session.matchId})` : ''} — website ${session.mainServerUrl || 'not set'}`);
  // 🗂️ Create this match's clip folders NOW, beside the master recording,
  // so they exist before the first ball — with or without internet.
  let clipsFolder = null;
  if (session.matchId) {
    try {
      clipsFolder = await organizer.ensureMatchTree(getClipsDir(), matchMetaFromSession());
      console.log(`🗂️  Clip folders ready: ${clipsFolder}`);
    } catch (err) {
      console.log(`⚠️  Could not create the clip folders (${err.message}) — they are retried on the first clip`);
    }
  }
  probeInternet(true).catch(() => {});
  res.json({ success: true, vmixControlled: false, clipsFolder, online: net.online });
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
    const sameFolderAsBefore = session.driveFolderId === folderId;
    session.driveFolderId = folderId;
    session.driveFolderName = folderName || session.driveFolderName || 'Selected folder';
    saveSession();
    // Always announced in this window, the same way the recording session
    // is, so the operator can SEE Drive is live here and not only in the
    // browser panel. Reconnecting the SAME folder must still say something:
    // helper-state.json remembers the last folder across restarts, so the
    // usual case (operator reconnects the folder they always use) would
    // otherwise print nothing at all — exactly when they're looking for
    // confirmation. The panel also re-sends a fresh Google token every
    // 45 min, which lands here too and is worth seeing as a liveness tick.
    console.log(sameFolderAsBefore
      ? `📁 Google Drive re-connected (fresh token) — clips upload to "${session.driveFolderName}"`
      : `📁 Google Drive connected — clips upload to "${session.driveFolderName}"`);
  }
  res.json({ success: true });
});
app.post('/set-token', (req, res) => res.json({ success: true }));

// POST /clip { eventType, timestamp, matchId, ballMeta, clipMeta?, clipId? }
// Acknowledged immediately; T0 (the press) is frozen into the job, and the
// whole event — match, tournament, innings, over, ball, players and their
// IDs — is written to disk with it BEFORE the answer is sent. Nothing here
// touches the network: this is the entry point of Stage A.
app.post('/clip', async (req, res) => {
  const b = req.body || {};
  const t0 = Number(b.timestamp) || Date.now();
  const eventType = String(b.eventType || 'CLIP').toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'CLIP';
  const matchId = String(b.matchId || session.matchId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
  if (matchId !== session.matchId) { session.matchId = matchId; saveSession(); }
  const clipId = b.clipId ? String(b.clipId).replace(/[^a-zA-Z0-9_-]/g, '') : buildClipId(matchId, eventType, t0);

  const existing = jobs.get(clipId);
  if (existing) {
    // A genuine re-send of the SAME press (the panel's outbox). Never a
    // second clip — but any metadata it carries is still worth keeping.
    if (b.ballMeta || b.clipMeta) applyLateMeta(existing, { ...(b.clipMeta || {}), ballMeta: b.ballMeta || (b.clipMeta && b.clipMeta.ballMeta) || null });
    return res.json({ success: true, clipId, duplicate: true, status: existing.status, statusText: STATUS_TEXT[existing.status] || existing.status });
  }

  const job = {
    clipId, matchId, eventType, t0,
    // Frozen at the press — the ONLY timing this clip ever uses.
    window: { startWall: t0 - PRE_ROLL_SECONDS * 1000, endWall: t0 + POST_ROLL_SECONDS * 1000 },
    clipStart: t0 - PRE_ROLL_SECONDS * 1000,
    clipEnd: t0 + POST_ROLL_SECONDS * 1000,
    timestamp: t0,
    // The persistent queue record's event fields (filled from the press).
    tournamentId: session.tournamentId || null,
    tournamentName: session.tournamentName || null,
    tournamentMatchId: session.tournamentMatchId || null,
    matchLabel: session.matchLabel || null,
    eventId: null, innings: null, over: null, ballInOver: null, ballLabel: null,
    battingTeam: null, bowlingTeam: null, battingTeamId: null, bowlingTeamId: null,
    strikerName: null, nonStrikerName: null, bowlerName: null,
    strikerId: null, nonStrikerId: null, bowlerId: null, playerIds: [],
    outcomeLabel: null, outcomeType: eventType, isHighlight: null, dismissal: null,
    // Local + cloud state.
    localPath: null, localFilePath: null, filename: null, links: [],
    r2Status: 'pending', driveStatus: 'pending', websiteStatus: 'pending',
    cutOffline: net.online === false,
    status: 'WAITING', retryCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
  };
  applyEventMeta(job, { ...(b.clipMeta || {}), ballMeta: b.ballMeta || (b.clipMeta && b.clipMeta.ballMeta) || null, eventType: undefined });
  Object.assign(job, destinationsFor(job));
  job.sourceFile = activeRecording && activeRecording.growing ? activeRecording.file : null;
  jobs.set(clipId, job);
  // Any metadata that arrived before this press did (out-of-order outbox).
  const early = orphanMeta.get(clipId);
  if (early) { orphanMeta.delete(clipId); applyEventMeta(job, early); saveOrphanMeta(); }
  pruneJobs();
  flushJobsNow(); // a press is written to disk before it's acknowledged — a crash right after can't lose it
  scheduleCut(job);
  console.log(`📥 [${eventType}] ${clipId}${job.ballLabel ? ` ball ${job.ballLabel}` : ''} at ${new Date(t0).toLocaleTimeString()} — cutting ${PRE_ROLL_SECONDS}s before → ${POST_ROLL_SECONDS}s after${net.online === false ? ' (OFFLINE — local cut and local folders work exactly the same)' : ''}`);
  // recordingActive:false lets the panel warn the operator right away
  // that vMix isn't recording (the clip would have no footage).
  res.json({ success: true, clipId, status: job.status, statusText: STATUS_TEXT[job.status], recordingActive: !!job.sourceFile, online: net.online });
  // Create the folder tree for this match in the background (offline-safe).
  organizer.ensureMatchTree(getClipsDir(), { ...matchMetaFromSession(), ...job }).catch(() => {});
  if (!job.sourceFile) resolveActiveRecording().then((rec) => { if (rec && !job.sourceFile) job.sourceFile = rec.file; }).catch(() => {});
});

// POST /clip-meta { clipId, matchId, ballMeta, outcomeLabel, eventType, isHighlight, eventId }
//
// The scorer's answer, delivered LOCALLY (localhost) — so it works with no
// internet at all. A HIGHLIGHTS press is cut before the ball's outcome is
// known; this is how the helper learns the real over/ball, the outcome and
// the batsman/bowler for that press, and it is what lets the clip be filed
// under Highlights/<category>/, Batsmen/<striker>/ and Bowlers/<bowler>/
// with its proper 08.4_SIX_… name while still offline.
//
// Idempotent: the same answer can be delivered any number of times. The
// clip is MOVED/re-linked, never re-cut, and its clipId never changes — so
// the cloud destination and the website record stay exactly the same.
app.post('/clip-meta', async (req, res) => {
  const b = req.body || {};
  const clipId = String(b.clipId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clipId) return res.status(400).json({ success: false, error: 'clipId required' });
  const job = jobs.get(clipId);
  if (!job) {
    // Arrived before the press itself (an out-of-order outbox flush):
    // remember it, persistently, and apply it when the job appears.
    orphanMeta.set(clipId, { ...b, receivedAt: Date.now() });
    saveOrphanMeta();
    return res.json({ success: true, clipId, pending: true });
  }
  await applyLateMeta(job, b);
  res.json({
    success: true, clipId, status: job.status, statusText: STATUS_TEXT[job.status] || job.status,
    filename: job.filename || null, localPath: job.localPath || null,
    highlightCategory: job.highlightCategory || null,
    links: (job.links || []).map((l) => ({ role: l.role, playerName: l.playerName, path: l.path })),
  });
});

// Applies metadata to an existing job: update the record, re-file the
// clip if it is already cut, and make sure the website eventually hears
// about the corrected event (a clip already synced is re-attached, never
// re-uploaded).
async function applyLateMeta(job, payload) {
  const before = { ball: job.ballLabel, highlight: job.isHighlight, outcome: job.outcomeLabel, striker: job.strikerName, bowler: job.bowlerName };
  applyEventMeta(job, payload);
  update(job, destinationsFor(job));
  const changed = before.ball !== job.ballLabel || before.highlight !== job.isHighlight || before.outcome !== job.outcomeLabel || before.striker !== job.strikerName || before.bowler !== job.bowlerName;
  if (job.localPath && fs.existsSync(job.localPath)) {
    await organizeClipFiles(job);
    console.log(`🏷️  [${job.eventType}] ${job.clipId}: ${job.ballLabel || 'ball ?'} ${job.outcomeLabel || ''}${job.isHighlight === false ? ' (kept out of Highlights)' : ''} → ${job.filename}`);
  }
  // Already synced, and the event details have since changed: re-run the
  // website attachment only (no upload, no re-cut, same records).
  if (changed && job.status === 'SYNC_COMPLETE') {
    update(job, { status: 'WEBSITE_UPDATE', error: null });
    queueSync(job);
  }
  persistJobs();
  return job;
}

// 🔁 "Try now" — re-checks the internet and resumes every pending clip.
// Handy for the operator (and for tests); the queue does this by itself
// anyway, on every connectivity change.
app.post('/sync-now', async (req, res) => {
  const online = await probeInternet(true).catch(() => false);
  const resumed = resumePendingSync('asked to sync now');
  res.json({ success: true, online, resumed, pending: [...jobs.values()].filter(isUnsynced).length });
});

// ----------------------------------------------------------------
// 🔄 STARTUP RECOVERY — the persistent queue is read from disk and every
// unfinished clip carries on from the stage it had reached. Nothing is
// ever re-cut because the app (or the laptop) restarted: if the clip file
// is on disk, that clip is done with Stage A for good.
//
// Also imports v3's "cut but never uploaded" clips so none are lost.
// ----------------------------------------------------------------
function resumeJobs() {
  let cuts = 0, ups = 0, adopted = 0, gone = 0;
  for (const job of jobs.values()) {
    // Old status names from a previous build.
    if (LEGACY_STATUS[job.status]) job.status = LEGACY_STATUS[job.status];
    if (job.localPath && !job.localFilePath) job.localFilePath = job.localPath;
    const fileThere = verifyLocalFile(job);

    if (job.status === 'SYNC_COMPLETE') continue;
    if (CUT_STATES.includes(job.status)) {
      if (fileThere) {
        // ✅ Already cut before the restart — adopt it, never cut again.
        job.status = 'LOCAL_SAVED';
        Object.assign(job, destinationsFor(job));
        queueSync(job);
        adopted++; ups++;
        continue;
      }
      job.cutAttempts = Math.min(job.cutAttempts || 0, CUT_MAX_ATTEMPTS - 1);
      job.status = 'WAITING';
      scheduleCut(job);
      cuts++;
      continue;
    }
    if (SYNCABLE.includes(job.status)) {
      if (!fileThere) {
        job.status = 'CUT_FAILED';
        job.error = 'local clip file is missing (deleted or moved away) — nothing was re-cut';
        gone++;
        continue;
      }
      // Being offline never counts against a clip: it starts with a clean
      // slate and simply waits for the connectivity probe.
      job.syncAttempts = 0;
      job.status = 'LOCAL_SAVED';
      Object.assign(job, destinationsFor(job));
      queueSync(job);
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
          const job = { clipId, matchId: e.matchId, eventType: String(e.eventType || 'CLIP').toUpperCase(), t0: e.eventTime, localPath: e.outputPath, localFilePath: e.outputPath, status: 'LOCAL_SAVED', createdAt: Date.now(), updatedAt: Date.now() };
          applyEventMeta(job, { ballMeta: e.ballMeta || null });
          Object.assign(job, destinationsFor(job));
          jobs.set(clipId, job);
          queueSync(job);
          ups++;
        }
      } else left.push(e);
    }
    fs.writeFileSync(v3Log, JSON.stringify(left, null, 2));
  } catch (_) { /* no v3 log */ }
  persistJobs();
  if (cuts || ups) {
    console.log(`🔄 Resumed from last run: ${cuts} clip(s) still to cut, ${ups} waiting to sync${adopted ? ` (${adopted} already cut — reused as-is, NOT re-cut)` : ''}${gone ? `, ${gone} whose local file is gone` : ''}`);
  }
  // Decide online/offline once at startup so the first clip's status line
  // is honest, then let the queue do its thing.
  probeInternet(true).catch(() => {});
}

// Leftover .part/.src files can only come from a cut interrupted by a restart.
function sweepPartFiles() {
  for (const dir of [getWorkDir(), getClipsDir()]) {
    fs.readdir(dir, (err, names) => {
      if (err) return;
      for (const n of names) if (/\.(part|src)\.mp4$|\.list\.txt$/.test(n)) fs.unlink(path.join(dir, n), () => {});
    });
  }
}

// 🧹 STALL SWEEP — a safety net under every timer above. Any clip that is
// cut but unsynced and has had no movement for 10 minutes is put back in
// the sync queue (and the connection is re-checked first). Nothing is
// re-cut and nothing already uploaded is uploaded again — this only makes
// sure a clip can never be left sitting in a stage nobody is driving,
// whatever went wrong (a missed poll, a lost timer, a website that never
// finished a leg, a connection that came back without being noticed).
const STALL_AFTER_MS = 10 * 60 * 1000;
setInterval(async () => {
  const stalled = [...jobs.values()].filter((j) => SYNCABLE.includes(j.status) && Date.now() - (j.updatedAt || 0) > STALL_AFTER_MS && !syncQueue.includes(j.clipId));
  if (!stalled.length) return;
  await probeInternet(true).catch(() => {});
  if (net.online === false) return; // still offline — they are already marked pending
  console.log(`🧹 ${stalled.length} clip(s) had not moved for ${STALL_AFTER_MS / 60000} min — re-queuing their sync`);
  for (const job of stalled) { job.syncAttempts = 0; queueSync(job); }
}, 2 * 60 * 1000);

// 🩺 One line every 10 minutes: proof over a 6–7 hour match that queues,
// processes and memory stay flat.
setInterval(() => {
  const all = [...jobs.values()];
  const count = (s) => all.filter((j) => j.status === s).length;
  const src = activeRecording ? sourceFor(activeRecording.file) : null;
  console.log(`[health] recording ${activeRecording ? `${path.basename(activeRecording.file)} ${src ? Math.round(src.durationSec / 60) : '?'}min${activeRecording.growing ? '' : ' (not growing)'}` : 'none'} | internet ${net.online === false ? 'OFFLINE' : net.online ? 'ok' : '?'} | cut queue ${cutQueue.length} | sync queue ${syncQueue.length + syncRunning} | offline-pending ${count('OFFLINE_PENDING')} | synced ${count('SYNC_COMPLETE')} | cut-failed ${count('CUT_FAILED')} | ffmpeg ${children.size} | mem ${Math.round(process.memoryUsage().rss / 1048576)}MB`);
}, 10 * 60 * 1000);

const server = app.listen(config.port, () => {
  console.log('================================================');
  console.log(`🎥 Clipper Helper v5.0 (offline-first) running at http://localhost:${config.port}`);
  console.log(`👉 Setup page: http://localhost:${config.port}/setup`);
  console.log(`Using ffmpeg: ${ffmpegPath}`);
  console.log(`Clip window: ${PRE_ROLL_SECONDS}s before + ${POST_ROLL_SECONDS}s after the press = ${CLIP_SECONDS}s`);
  console.log(`Clips folder: ${getClipsDir()} (organised per match: Highlights / Normal / Batsmen / Bowlers)`);
  console.log('Clips are cut, named and filed locally with NO internet; R2 + Drive + website sync happens whenever the connection is there.');
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
