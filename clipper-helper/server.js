// ================================================================
// 🎥 Clipper Helper — runs locally on the operator's PC, next to vMix.
//
// v3.0 — PRODUCTION-RELIABILITY REWRITE
// ------------------------------------------------------------------
// This version changes two things on purpose, and nothing else about
// how the panel talks to this helper (same port, same endpoints:
// /recording-start, /clip, /set-folder, /set-token, /status):
//
// 1) EXACT CLIP WINDOW: every clip is now 15s BEFORE the trigger + 3s
//    AFTER it = 18 seconds total, instead of the old 10s/10s/20s.
//
// 2) CUTTING IS NOW 100% LOCAL AND FULLY DECOUPLED FROM UPLOADING.
//    The old version cut the clip AND THEN awaited the network upload
//    to the main server before moving on to the next queued job — so
//    if the website was slow, asleep, or unreachable for a stretch
//    mid-match, that single stuck `fetch()` call blocked the ENTIRE
//    queue and every clip after it silently stopped getting cut, even
//    though cutting itself has nothing to do with the network. That
//    was the root cause of the "fetching… / failed to fetch" mid-match
//    stall. Now there are two independent queues:
//       CUT QUEUE    — local disk + ffmpeg only, never touches the
//                      network, never blocks on it.
//       UPLOAD QUEUE — network only, runs in the background; however
//                      slow or broken it is, it can never delay the
//                      next clip's cut.
//    On top of that: every fetch() now has a hard timeout (so it can
//    never hang forever), every response body is always fully drained
//    (an undrained body can leak the underlying connection — over a
//    6-7 hour match with hundreds of requests this is exactly the kind
//    of slow leak that eventually makes fetch itself start failing),
//    and every cut goes through a hard-kill watchdog + on-disk
//    validation (file exists, non-zero size, ~18s duration) with
//    automatic retry before anything is ever logged as failed.
//
// Still exactly the same idea as before: vMix records locally, this
// watches that recording, cuts an 18s clip on FOUR/SIX/WICKET/etc.,
// and hands it off to the main server (which uploads to R2 + Drive
// and links it to the batter/bowler) — falling back to direct Drive
// upload only if the main server can't be reached.
// ================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

// When bundled by pkg into ClipperHelper.exe, __dirname points inside a
// virtual snapshot, not the real folder the .exe sits in — so config.json,
// clips, and ffmpeg.exe next to the .exe wouldn't be found. process.pkg
// only exists when running as the packaged .exe, so we detect that and use
// the real exe folder instead.
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

// ffmpeg.exe ships as a plain file next to ClipperHelper.exe (NOT bundled
// inside it — pkg can't reliably pack native ffmpeg binaries). Falls back
// to the npm-installed copy when just running "node server.js" locally.
const localFfmpeg = path.join(BASE_DIR, 'ffmpeg.exe');
const ffmpegPath = fs.existsSync(localFfmpeg)
  ? localFfmpeg
  : require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
// NOTE: we deliberately do NOT depend on a separate ffprobe.exe (only
// ffmpeg.exe ships in this package). Clip validation below reads the
// "Duration:" line out of `ffmpeg -i <file>` instead of using ffprobe —
// same binary we already have, one less thing to install/ship/break.

// 🛡️ CRASH-PROOFING: if any one clip/upload throws something unexpected
// (a bad ffmpeg edge case, a weird network error, a malformed response
// from the main server, etc.), Node's default behaviour is to crash the
// ENTIRE process. For this helper that means every event AFTER the bad
// one silently fails too — the exe window looks fine and open, but
// nothing is listening on port 5005 anymore, until someone notices and
// restarts it. Catching these here means one bad clip only ever costs
// that one clip, never the rest of the match.
process.on('uncaughtException', (err) => {
  console.log('❌ Unexpected error (helper kept running):', err && err.message || err);
});
process.on('unhandledRejection', (err) => {
  console.log('❌ Unexpected async error (helper kept running):', err && err.message || err);
});

const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
let config = {
  port: 5005,
  vmixRecordingFile: 'C:\\Users\\YOUR_NAME\\Videos\\match-recording.mp4',
  // Leave blank to auto-use "<recording folder>\Clips" — see getClipsDir()
  // below. Set this only if you want clips saved somewhere else entirely.
  clipsFolder: '',
  // Where the finished clip gets sent so it can be uploaded to Cloudflare
  // R2 + Google Drive and linked to the batter/bowler for the scorecard.
  // This should be your website's own address (the same one the panel
  // itself opens in the browser) — NOT localhost, since it's the panel's
  // server this helper is talking to, not itself.
  mainServerUrl: 'https://YOUR-SITE.example.com'
};
try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } else {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }
} catch (err) {
  console.log('⚠️  Could not read config.json, using defaults:', err.message);
}

// ----------------------------------------------------------------
// 🎯 EXACT CLIP TIMING — the one place these numbers live.
// ----------------------------------------------------------------
const EVENT_BEFORE_SECONDS = 15;   // footage kept BEFORE the trigger
const EVENT_AFTER_SECONDS = 3;     // wait this long AFTER the trigger before cutting, so that footage actually exists on disk
const CLIP_DURATION_SECONDS = EVENT_BEFORE_SECONDS + EVENT_AFTER_SECONDS; // 18
const CUT_EOF_MARGIN_SECONDS = 1;  // stay this far behind the live edge of a still-growing file so ffmpeg never grabs a frame vMix hasn't finished flushing yet
const SEEK_FROM_EOF_SECONDS = CLIP_DURATION_SECONDS + CUT_EOF_MARGIN_SECONDS; // 19

// ----------------------------------------------------------------
// 🔁 Retry / timeout / validation tuning.
// ----------------------------------------------------------------
const RETRY_FFMPEG_ATTEMPTS = 4;
const RETRY_FFMPEG_DELAY_MS = [1000, 2000, 4000];
const FFMPEG_TIMEOUT_MS = 30000;          // a real 18s cut takes a couple seconds — 30s means it's actually stuck, so we kill it and retry instead of hanging forever
const QUEUE_JOB_WATCHDOG_MS = 60000;      // absolute ceiling on ONE cut job (all attempts + validation combined) — guarantees the cut queue can never freeze on a single bad job

const MIN_CLIP_BYTES = 20 * 1024;                    // floor beneath which a file can't realistically be a real ~18s clip
const VALIDATION_DURATION_TOLERANCE_SECONDS = 3;     // accept 15s–21s as "close enough" to 18s

const DEDUPE_WINDOW_SECONDS = 2; // two /clip calls for the same event type within this window are treated as one event, not two clips

const FETCH_TIMEOUT_MS = 20000;
const RETRY_UPLOAD_ATTEMPTS = 3;
const RETRY_UPLOAD_DELAY_MS = [1000, 3000, 6000]; // backs off a bit more each time

// ----------------------------------------------------------------
// 📁 Where clips get saved. If the operator hasn't set clipsFolder,
// fall back to "<recording folder>\Clips" (not a folder next to the
// .exe) — recomputed fresh each time in case the recording path is
// changed via /setup mid-session.
// ----------------------------------------------------------------
function getClipsDir() {
  const folder = (config.clipsFolder || '').trim();
  if (folder) {
    return path.isAbsolute(folder) ? folder : path.join(BASE_DIR, folder);
  }
  const recordingDir = path.dirname(config.vmixRecordingFile || '.');
  return path.join(recordingDir, 'Clips');
}

// ----------------------------------------------------------------
// State — all in memory, reset every time the operator restarts the
// app (that's fine, they set the folder + start recording fresh each
// match anyway).
// ----------------------------------------------------------------
let recordingStartedAt = null;   // Date.now() ms, when panel said recording began
let driveAccessToken = null;     // token forwarded from the panel's Connect Google Drive
let driveFolderId = null;        // folder the operator picked
let driveFolderName = null;
let currentMatchId = null;       // which match this session's clips belong to
// Where finished clips are sent so the main server can upload them to
// Cloudflare R2 + Drive and link them to the batter/bowler. The panel
// sends its own origin here on every /recording-start call, so this
// always stays correct even if config.json's default is out of date.
let mainServerUrl = (config.mainServerUrl || '').replace(/\/+$/, '');

// Small helper: wait ms, then resolve — used between retry attempts.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----------------------------------------------------------------
// 🧵🎬 CUT QUEUE — local disk + ffmpeg only. Every /clip event goes in
// here and is cut ONE AT A TIME, in order. This queue NEVER makes a
// network call, so it can never be stalled by the website being slow
// or unreachable — see the v3.0 note at the top of the file.
// ----------------------------------------------------------------
const clipQueue = [];
let queueRunning = false;

// ----------------------------------------------------------------
// ☁️ UPLOAD QUEUE — network only, runs completely independently of the
// cut queue above. A clip lands here only after it's already safely
// cut + validated on disk, so however slow/broken the network is,
// cutting the NEXT clip is never affected.
// ----------------------------------------------------------------
const uploadQueue = [];
let uploadQueueRunning = false;

// ----------------------------------------------------------------
// 🙅 Duplicate-event guard — two /clip calls for the same event type
// within a couple seconds of each other (a double-press, a panel
// retry, a flaky double network send) are the SAME real-world event,
// not two different highlights. Without this they'd produce two
// near-identical clips and waste a cut-slot during a busy over.
// ----------------------------------------------------------------
const recentEventKeys = new Map(); // "TYPE_secondsBucket" -> queued-at ms
function isDuplicateEvent(safeLabel, eventTime) {
  const now = Date.now();
  for (const [k, t] of recentEventKeys) {
    if (now - t > 30000) recentEventKeys.delete(k); // prune old entries so this map never grows unbounded over a 6-7hr match
  }
  const key = `${safeLabel}_${Math.round(eventTime / (DEDUPE_WINDOW_SECONDS * 1000))}`;
  if (recentEventKeys.has(key)) return true;
  recentEventKeys.set(key, now);
  return false;
}

// ----------------------------------------------------------------
// 📋 Failed-clips log — a clip only ever ends up here after EVERY
// retry has been exhausted. This is the "nothing is ever silently
// cancelled" guarantee: even in the worst case, the operator (or the
// panel) has a permanent, on-disk record of exactly which clip failed
// and why, instead of it just quietly vanishing.
// ----------------------------------------------------------------
const FAILED_LOG_PATH = path.join(BASE_DIR, 'failed-clips.json');
function recordFailedClip(entry) {
  let list = [];
  try {
    if (fs.existsSync(FAILED_LOG_PATH)) list = JSON.parse(fs.readFileSync(FAILED_LOG_PATH, 'utf8'));
  } catch (_) { list = []; }
  list.push({ ...entry, failedAt: new Date().toISOString() });
  try { fs.writeFileSync(FAILED_LOG_PATH, JSON.stringify(list, null, 2)); } catch (_) {}
  console.log(`🆘 Logged to failed-clips.json so it's never silently lost: ${entry.fileName || entry.eventType}`);
}

async function safeDelete(p) {
  try { await fs.promises.unlink(p); } catch (_) {}
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic CORS so the panel (running on a different origin, the website)
// can call this local helper from the browser.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ----------------------------------------------------------------
// GET/POST /setup — a simple point-and-click page so the operator
// never has to open config.json in Notepad. Two fields only (the
// ones that actually change per-operator): the vMix recording file,
// and the website URL. Saves straight back to config.json on disk
// so it's remembered next time the exe is started.
// ----------------------------------------------------------------
function setupPageHtml(message) {
  const recordingFile = (config.vmixRecordingFile || '').replace(/"/g, '&quot;');
  const websiteUrl = (config.mainServerUrl || '').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Clipper Helper — Setup</title>
<style>
  body{ font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif; background:#0b0f1a; color:#f2f4f8; padding:0; margin:0; }
  .wrap{ max-width:480px; margin:40px auto; padding:0 20px; }
  h1{ font-size:18px; margin-bottom:4px; }
  p.sub{ color:#8892a6; font-size:13px; margin-top:0; }
  label{ display:block; font-size:12px; color:#8892a6; margin:16px 0 6px; }
  input[type=text]{ width:100%; box-sizing:border-box; padding:10px; border-radius:7px; border:1px solid #232c42; background:#182034; color:#f2f4f8; font-size:14px; }
  button{ margin-top:20px; width:100%; padding:12px; border-radius:8px; border:none; background:#ff7a00; color:#12100c; font-weight:700; font-size:14px; cursor:pointer; }
  button:hover{ background:#ff8a1f; }
  .msg{ margin-top:14px; padding:10px 12px; border-radius:7px; font-size:13px; }
  .msg.ok{ background:rgba(34,197,94,.15); color:#22c55e; border:1px solid #22c55e; }
  .status{ margin-top:24px; font-size:12px; color:#8892a6; }
</style></head>
<body><div class="wrap">
  <h1>🎥 Clipper Helper — Setup</h1>
  <p class="sub">Yeh 2 cheez bharo aur Save dabao — config.json khud ban jayega.</p>
  ${message ? `<div class="msg ok">${message}</div>` : ''}
  <form method="POST" action="/setup">
    <label>vMix Recording File — vMix jis folder/file me record karta hai, uska poora path</label>
    <input type="text" name="recordingFile" value="${recordingFile}" placeholder="C:\\Users\\YOUR_NAME\\Videos\\match-recording.mp4">
    <label>Website URL — panel jis website par khulta hai</label>
    <input type="text" name="websiteUrl" value="${websiteUrl}" placeholder="https://yourscoreapp.onrender.com">
    <button type="submit">💾 Save</button>
  </form>
  <div class="status">Port: ${config.port} · Clips folder: ${getClipsDir()} · Iss window ko match khatam hone tak khula rakho.</div>
</div></body></html>`;
}

app.get('/setup', (req, res) => {
  res.send(setupPageHtml(null));
});

app.post('/setup', (req, res) => {
  const { recordingFile, websiteUrl } = req.body || {};
  if (recordingFile !== undefined) config.vmixRecordingFile = String(recordingFile).trim();
  if (websiteUrl !== undefined) {
    config.mainServerUrl = String(websiteUrl).trim();
    mainServerUrl = config.mainServerUrl.replace(/\/+$/, '');
  }
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log('💾 Setup saved via /setup page:', { vmixRecordingFile: config.vmixRecordingFile, mainServerUrl: config.mainServerUrl });
  } catch (err) {
    console.log('⚠️  Could not write config.json:', err.message);
  }
  res.send(setupPageHtml('✅ Saved! Ab is tab ko band karke match shuru kar sakte ho.'));
});

// ----------------------------------------------------------------
// GET /status — panel/operator can check this in a browser to see
// current state.
// ----------------------------------------------------------------
app.get('/status', async (req, res) => {
  let failedClipsCount = 0;
  try {
    if (fs.existsSync(FAILED_LOG_PATH)) failedClipsCount = JSON.parse(await fs.promises.readFile(FAILED_LOG_PATH, 'utf8')).length;
  } catch (_) { /* leave at 0 */ }

  res.json({
    running: true,
    recordingStartedAt,
    matchId: currentMatchId,
    mainServerUrl: mainServerUrl || null,
    driveConnected: !!(driveAccessToken && driveFolderId),
    driveFolderName,
    vmixRecordingFile: config.vmixRecordingFile,
    currentRecordingFile: await resolveRecordingFileOnce(),
    clipsDir: getClipsDir(),
    clipTiming: { beforeSeconds: EVENT_BEFORE_SECONDS, afterSeconds: EVENT_AFTER_SECONDS, durationSeconds: CLIP_DURATION_SECONDS },
    cutQueueLength: clipQueue.length,
    uploadQueueLength: uploadQueue.length,
    failedClipsCount
  });
});

// ----------------------------------------------------------------
// GET /failed-clips — anything that exhausted every retry ends up
// here, permanently, until manually cleared. This is the visible half
// of the "nothing is ever silently cancelled" guarantee.
// ----------------------------------------------------------------
app.get('/failed-clips', async (req, res) => {
  try {
    if (!fs.existsSync(FAILED_LOG_PATH)) return res.json({ failedClips: [] });
    const list = JSON.parse(await fs.promises.readFile(FAILED_LOG_PATH, 'utf8'));
    res.json({ failedClips: list });
  } catch (err) {
    res.json({ failedClips: [], error: err.message });
  }
});

// ----------------------------------------------------------------
// POST /recording-start — panel calls this when the operator clicks
// "🔴 Start Recording". We just remember the timestamp for /status.
// ----------------------------------------------------------------
app.post('/recording-start', (req, res) => {
  recordingStartedAt = (req.body && req.body.startedAt) || Date.now();
  if (req.body && req.body.matchId) currentMatchId = String(req.body.matchId);
  // The panel passes its own address (location.origin) here every time —
  // always trust the freshest one over whatever config.json had.
  if (req.body && req.body.mainServerUrl) mainServerUrl = String(req.body.mainServerUrl).replace(/\/+$/, '');
  console.log('🔴 Recording marked as started at', new Date(recordingStartedAt).toLocaleTimeString(), currentMatchId ? `(match ${currentMatchId})` : '');
  res.json({ success: true });
});

// ----------------------------------------------------------------
// POST /set-folder — panel calls this right after the operator does
// "Connect Google Drive". Body carries BOTH the folder id AND the
// access token, so this helper can upload directly with no service
// account.
// ----------------------------------------------------------------
app.post('/set-folder', (req, res) => {
  const { folderId, folderName, accessToken } = req.body || {};
  if (!folderId) return res.json({ success: false, error: 'No folderId provided' });

  driveFolderId = folderId;
  driveFolderName = folderName || driveFolderName || 'Selected folder';
  if (accessToken) driveAccessToken = accessToken;

  console.log(`📁 Drive folder set: ${driveFolderName} (${driveFolderId}) — token ${accessToken ? 'received' : 'NOT received, uploads will fail until it is'}`);
  res.json({ success: true });
});

// Optional: panel can silently refresh just the token (access tokens
// expire ~1hr) without re-picking the folder.
app.post('/set-token', (req, res) => {
  const { accessToken } = req.body || {};
  if (!accessToken) return res.json({ success: false, error: 'No accessToken provided' });
  driveAccessToken = accessToken;
  res.json({ success: true });
});

// ----------------------------------------------------------------
// Finds the actual recording file to cut from. vMix requires a
// timestamp in its filename format, so the exact file name changes
// every time recording starts — instead of expecting one fixed name,
// we look in the configured folder and always use the most recently
// modified .mp4 file. If vmixRecordingFile itself exists exactly as
// given, that's used directly (still supported for setups where it
// really is fixed).
// ----------------------------------------------------------------
async function resolveRecordingFileOnce() {
  if (fs.existsSync(config.vmixRecordingFile)) {
    return config.vmixRecordingFile;
  }
  const dir = path.dirname(config.vmixRecordingFile);
  try {
    const names = await fs.promises.readdir(dir);
    const mp4Names = names.filter(f => f.toLowerCase().endsWith('.mp4'));
    if (!mp4Names.length) return null;
    const withStats = await Promise.all(mp4Names.map(async (f) => {
      const full = path.join(dir, f);
      const st = await fs.promises.stat(full);
      return { full, mtime: st.mtimeMs, birthtime: st.birthtimeMs || st.ctimeMs || 0 };
    }));
    // Sort by mtime first (most-recently-written file wins); birthtime as
    // a tiebreaker for the rare case two files share an mtime tick.
    withStats.sort((a, b) => (b.mtime - a.mtime) || (b.birthtime - a.birthtime));
    return withStats[0].full;
  } catch (err) {
    return null; // dir missing, permissions issue, etc. — treated as "not found yet"
  }
}

// 🔁 RETRY: the recording file can genuinely not exist yet for a brief
// moment right after vMix is told to record, or a folder scan can lose
// a race with vMix mid-write. Recheck a few times over a few seconds
// before actually giving up.
const RETRY_FIND_FILE_ATTEMPTS = 6;
const RETRY_FIND_FILE_DELAY_MS = 1500;
async function resolveRecordingFile() {
  for (let attempt = 1; attempt <= RETRY_FIND_FILE_ATTEMPTS; attempt++) {
    const found = await resolveRecordingFileOnce();
    if (found) return found;
    if (attempt < RETRY_FIND_FILE_ATTEMPTS) {
      console.log(`⏳ Recording file not found yet (attempt ${attempt}/${RETRY_FIND_FILE_ATTEMPTS}) — retrying in ${RETRY_FIND_FILE_DELAY_MS / 1000}s...`);
      await sleep(RETRY_FIND_FILE_DELAY_MS);
    }
  }
  return null;
}

// ----------------------------------------------------------------
// POST /clip — panel calls this on FOUR / SIX / WICKET / WIDE-4 /
// WIDE-6 / NO-BALL-4 / NO-BALL-6 / LEG-BYE-4 / manual trigger — any
// eventType at all is accepted generically here, the helper doesn't
// special-case which ones exist. Acknowledged instantly; the actual
// cut happens in the background queue below.
// ----------------------------------------------------------------
app.post('/clip', (req, res) => {
  const { eventType, timestamp, matchId, ballMeta } = req.body || {};
  if (matchId) currentMatchId = String(matchId);

  if (!recordingStartedAt) {
    console.log('⚠️  Clip requested but recording was never marked as started — skipping.');
    return res.json({ success: false, error: 'recording not started' });
  }

  const eventTime = timestamp || Date.now();
  const safeLabel = (eventType || 'CLIP').toUpperCase();

  if (isDuplicateEvent(safeLabel, eventTime)) {
    console.log(`⏭️  Duplicate ${safeLabel} event ignored (same event already queued within ${DEDUPE_WINDOW_SECONDS}s)`);
    return res.json({ success: true, duplicate: true });
  }

  res.json({ success: true }); // acknowledge immediately — the actual work happens in the queue below
  console.log(`📥 Queued ${safeLabel} (cut queue length now ${clipQueue.length + 1})`);
  clipQueue.push({ eventType: safeLabel, eventTime, matchId, ballMeta });
  runQueue();
});

// ----------------------------------------------------------------
// 🧵🎬 CUT QUEUE runner — drains clipQueue ONE JOB AT A TIME, purely
// local (ffmpeg + disk, zero network). Every job also runs inside a
// hard watchdog (see withWatchdog) so the queue can never freeze on
// one stuck job, no matter what goes wrong inside it.
// ----------------------------------------------------------------
async function runQueue() {
  if (queueRunning) return; // already draining — this job will be picked up in its turn
  queueRunning = true;
  try {
    while (clipQueue.length) {
      const job = clipQueue[0];
      // Wait until EVENT_AFTER_SECONDS have actually elapsed since the
      // event, so that footage exists on disk to cut. Waiting here
      // (inside the queue loop) rather than via a bare setTimeout means
      // a burst of quick events still each get their own proper wait,
      // in order, without blocking the server from accepting more
      // incoming /clip calls in the meantime (they just join the queue).
      const waitMs = Math.max(0, (job.eventTime + EVENT_AFTER_SECONDS * 1000) - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      await withWatchdog(() => cutClipNow(job), QUEUE_JOB_WATCHDOG_MS, job);
      clipQueue.shift();
    }
  } finally {
    queueRunning = false;
  }
}

// Hard ceiling on one job. If cutClipNow (including all its internal
// ffmpeg retries) somehow doesn't resolve within timeoutMs — an
// unforeseen hang this file's other protections didn't catch — this
// logs it as failed and lets the queue move on anyway, instead of the
// rest of the match's clips silently never getting cut.
function withWatchdog(fn, timeoutMs, job) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      console.log(`🆘 Job watchdog fired — a clip job ran past ${timeoutMs / 1000}s and was abandoned so the queue keeps moving: ${job.eventType} @ ${new Date(job.eventTime).toISOString()}`);
      recordFailedClip({ eventType: job.eventType, eventTime: job.eventTime, matchId: job.matchId, ballMeta: job.ballMeta, reason: 'job watchdog timeout — took too long and was abandoned' });
      resolve();
    }, timeoutMs);
    fn().then(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    }).catch((err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      console.log('❌ Unexpected error processing queued clip (continuing with the rest):', err && err.message || err);
      resolve();
    });
  });
}

// Runs one ffmpeg cut, wrapped in a Promise so it can be awaited/retried,
// with its own hard timeout+kill — a hung/zombie ffmpeg process (Windows
// file-lock edge case, a corrupt frame it can't get past, etc.) is killed
// outright rather than left running and blocking this job forever.
function runFfmpegCut(recordingFile, outputPath, seekFromEofSeconds, durationSeconds) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const command = ffmpeg(recordingFile)
      .inputOptions(['-sseof', `-${seekFromEofSeconds}`])
      .outputOptions(['-y']) // never let ffmpeg sit waiting on an interactive overwrite prompt that nothing will ever answer
      .setDuration(durationSeconds)
      .output(outputPath);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { command.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s and was killed`));
    }, FFMPEG_TIMEOUT_MS);

    command.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    command.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    command.run();
  });
}

// Reads the "Duration: HH:MM:SS.xx" line out of `ffmpeg -i <file>`
// (ffmpeg always prints this to stderr, even without an output — no
// separate ffprobe.exe needed, since this package only ships ffmpeg.exe).
function probeDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-i', filePath, '-hide_banner'], (err, stdout, stderr) => {
      const out = (stderr || '') + (stdout || '');
      const match = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) return reject(new Error(err ? (err.message || 'ffmpeg -i failed') : 'no Duration line — file may be corrupt/unreadable'));
      const hours = parseInt(match[1], 10), mins = parseInt(match[2], 10), secs = parseFloat(match[3]);
      resolve(hours * 3600 + mins * 60 + secs);
    });
  });
}

// ----------------------------------------------------------------
// ✅ CLIP VALIDATION — checked after every cut attempt, before it's
// ever treated as a success: file exists, non-zero (meaningfully
// sized) file, video actually readable, duration close to the
// expected 18s. Anything that fails gets deleted and retried.
// ----------------------------------------------------------------
async function validateClip(outputPath) {
  let stat;
  try { stat = await fs.promises.stat(outputPath); } catch (err) { return { ok: false, reason: 'file missing after cut' }; }
  if (!stat.size || stat.size < MIN_CLIP_BYTES) return { ok: false, reason: `file too small (${stat.size || 0} bytes) — likely a failed/empty cut` };

  let duration;
  try { duration = await probeDurationSeconds(outputPath); } catch (err) { return { ok: false, reason: `unreadable/corrupt video: ${err.message}` }; }

  const min = CLIP_DURATION_SECONDS - VALIDATION_DURATION_TOLERANCE_SECONDS;
  const max = CLIP_DURATION_SECONDS + VALIDATION_DURATION_TOLERANCE_SECONDS;
  if (duration < min || duration > max) {
    return { ok: false, reason: `unexpected duration ${duration.toFixed(1)}s (expected ~${CLIP_DURATION_SECONDS}s, accepted ${min}-${max}s)` };
  }
  return { ok: true, duration };
}

// ----------------------------------------------------------------
// 🎬 Cuts ONE clip, purely locally: resolve the recording file, cut
// with ffmpeg, validate, retry on failure. On success, hands the clip
// off to the (separate, non-blocking) upload queue and returns
// immediately — this function NEVER makes a network call itself.
// ----------------------------------------------------------------
async function cutClipNow(job) {
  const { eventType, eventTime, matchId, ballMeta } = job;
  const safeLabel = eventType || 'CLIP';
  const fileName = `${safeLabel}_${new Date(eventTime).toISOString().replace(/[:.]/g, '-')}.mp4`;

  const clipsDir = getClipsDir();
  try { await fs.promises.mkdir(clipsDir, { recursive: true }); } catch (_) {}
  const outputPath = path.join(clipsDir, fileName);

  // A file already sitting here for this exact event means it was
  // already cut (e.g. a watchdog fired late after the real job actually
  // finished) — don't burn a cut-slot re-doing it.
  if (fs.existsSync(outputPath)) {
    console.log(`⏭️  Skipping — a clip already exists for this exact event: ${fileName}`);
    return;
  }

  // resolveRecordingFile() itself retries for several seconds if the
  // file genuinely isn't there yet.
  const recordingFile = await resolveRecordingFile();
  if (!recordingFile) {
    console.log(`⚠️  No recording file found in: ${path.dirname(config.vmixRecordingFile)} — this clip could not be cut.`);
    recordFailedClip({ eventType: safeLabel, eventTime, matchId, ballMeta, reason: 'recording file not found' });
    return;
  }

  // Non-blocking staleness warning only — if recording was paused for a
  // few seconds this is normal and shouldn't stop the clip attempt.
  try {
    const st = await fs.promises.stat(recordingFile);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > 5 * 60 * 1000) {
      console.log(`⚠️  Recording file hasn't changed in ${(ageMs / 1000).toFixed(0)}s — it may have stopped growing. Cutting from it anyway: ${recordingFile}`);
    }
  } catch (_) {}

  // 🎯 Grab the last ~19s of whatever's ON DISK right now, via ffmpeg's
  // own "-sseof" (seek relative to end-of-file), then keep 18s of that —
  // NOT by calculating a start time from `recordingStartedAt`. Any gap
  // between clicking "Start Recording" in the panel and vMix actually
  // starting would shift every clip by that same amount; since we
  // already wait EVENT_AFTER_SECONDS for the "after" half of the event
  // to land on disk, "the last ~19s on disk right now" reliably centers
  // the event correctly regardless of any recording-start sync error.
  console.log(`✂️  Cutting ${safeLabel} clip: last ~${CLIP_DURATION_SECONDS}s of the recording (${EVENT_BEFORE_SECONDS}s before / ${EVENT_AFTER_SECONDS}s after)`);

  let lastError = null;
  for (let attempt = 1; attempt <= RETRY_FFMPEG_ATTEMPTS; attempt++) {
    try {
      await runFfmpegCut(recordingFile, outputPath, SEEK_FROM_EOF_SECONDS, CLIP_DURATION_SECONDS);
      const validation = await validateClip(outputPath);
      if (validation.ok) {
        console.log(`✅ Clip cut + validated (${validation.duration.toFixed(1)}s): ${fileName}`);
        lastError = null;
        break;
      }
      lastError = new Error(validation.reason);
      console.log(`⚠️  Cut attempt ${attempt}/${RETRY_FFMPEG_ATTEMPTS} produced an invalid clip (${fileName}): ${validation.reason} — deleting and retrying`);
      await safeDelete(outputPath);
    } catch (err) {
      lastError = err;
      console.log(`⚠️  ffmpeg cut attempt ${attempt}/${RETRY_FFMPEG_ATTEMPTS} failed for ${fileName}:`, err.message || String(err));
      await safeDelete(outputPath);
    }
    if (lastError && attempt < RETRY_FFMPEG_ATTEMPTS) await sleep(RETRY_FFMPEG_DELAY_MS[attempt - 1] || 4000);
  }

  if (lastError) {
    console.log(`❌ Clip cut failed after ${RETRY_FFMPEG_ATTEMPTS} attempts (${fileName}):`, lastError.message);
    recordFailedClip({ eventType: safeLabel, eventTime, matchId, ballMeta, fileName, reason: `cut/validation: ${lastError.message}` });
    return;
  }

  // Hand off to the upload queue and return immediately. Uploading is a
  // network concern and — per the whole point of this rewrite — must
  // NEVER be able to stall the cutting of the next clip.
  uploadQueue.push({ outputPath, fileName, eventType: safeLabel, eventTime, matchId, ballMeta });
  runUploadQueue();
}

// ----------------------------------------------------------------
// fetch() with a hard timeout — Node's built-in fetch has NO default
// timeout, so a main server that's asleep/hanging (not erroring, just
// never responding) would otherwise hang this call forever. That, in
// the old single-queue design, is exactly what "stuck on fetching"
// looked like. AbortController below guarantees every attempt gives up
// after FETCH_TIMEOUT_MS no matter what the other end does.
// ----------------------------------------------------------------
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------
// ☁️🧵 UPLOAD QUEUE runner — drains uploadQueue one job at a time,
// completely independent of the cut queue above. Even if every job in
// here is slow or timing out, the cut queue keeps cutting clips on
// schedule the whole time.
// ----------------------------------------------------------------
async function runUploadQueue() {
  if (uploadQueueRunning) return;
  uploadQueueRunning = true;
  try {
    while (uploadQueue.length) {
      const job = uploadQueue[0];
      try {
        await processUploadJob(job);
      } catch (err) {
        console.log('❌ Unexpected error in upload queue (continuing):', err && err.message || err);
      }
      uploadQueue.shift();
    }
  } finally {
    uploadQueueRunning = false;
  }
}

async function processUploadJob(job) {
  const { outputPath, fileName, eventType, eventTime, matchId, ballMeta } = job;
  const sentToServer = await sendClipToMainServer(outputPath, fileName, eventType, eventTime, ballMeta);
  if (sentToServer) return;
  console.log(`⚠️  Could not reach main server — falling back to direct Drive upload for ${fileName}`);
  const sentToDrive = await uploadClipToDrive(outputPath, fileName);
  if (!sentToDrive) {
    // Both paths exhausted every retry — the .mp4 itself is still safe
    // on disk in the Clips folder either way, so this is "not yet
    // uploaded anywhere", not "lost". Logged so it's easy to find and
    // re-upload by hand, and it's auto-retried on the helper's next
    // startup (see retryPreviouslyFailedClips below).
    recordFailedClip({ eventType, eventTime, matchId, ballMeta, fileName, outputPath, reason: 'cut succeeded but both main-server and Drive uploads failed' });
  }
}

// ----------------------------------------------------------------
// Sends the finished clip to the main website server as raw bytes, so
// IT can upload to Cloudflare R2 + Drive and link the clip to the real
// batter/bowler for the scorecard. Returns true only on a confirmed
// success.
// ----------------------------------------------------------------
async function sendClipToMainServer(filePath, fileName, eventType, eventTime, ballMeta) {
  if (!mainServerUrl) {
    console.log('⚠️  No mainServerUrl configured (set it in config.json or have the panel send it) — skipping.');
    return false;
  }
  if (!currentMatchId) {
    console.log('⚠️  No matchId known yet for this session — skipping main-server upload.');
    return false;
  }

  // fs.promises.readFile (NOT readFileSync) — reads off the libuv thread
  // pool instead of blocking Node's single main thread, so the HTTP
  // server stays free to accept the NEXT /clip request the whole time a
  // multi-MB clip file is being read into memory here.
  let fileBuffer;
  try {
    fileBuffer = await fs.promises.readFile(filePath);
  } catch (err) {
    console.log(`❌ Could not read clip file to send (${fileName}):`, err.message || String(err));
    return false;
  }

  const qs = new URLSearchParams({
    matchId: currentMatchId,
    eventType,
    timestamp: String(eventTime)
  });
  const headers = { 'Content-Type': 'video/mp4' };
  if (ballMeta) headers['X-Ball-Meta'] = JSON.stringify(ballMeta);

  for (let attempt = 1; attempt <= RETRY_UPLOAD_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetchWithTimeout(`${mainServerUrl}/api/clips/ingest?${qs.toString()}`, {
        method: 'POST',
        headers,
        body: fileBuffer
      }, FETCH_TIMEOUT_MS);
    } catch (err) {
      const timedOut = err && err.name === 'AbortError';
      console.log(`❌ Could not reach main server (${fileName}), attempt ${attempt}/${RETRY_UPLOAD_ATTEMPTS}:`, timedOut ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : (err.message || String(err)));
      if (attempt < RETRY_UPLOAD_ATTEMPTS) await sleep(RETRY_UPLOAD_DELAY_MS[attempt - 1]);
      continue;
    }

    // Always fully drain the response body, on EVERY branch, even when
    // we don't care about its content. An unconsumed body can keep the
    // underlying connection from being released back to Node's
    // connection pool — over a 6-7 hour match with hundreds of requests
    // that's exactly the kind of slow leak that eventually makes fetch
    // itself start throwing generic "fetch failed" errors that look
    // like the network is down when it isn't.
    try { await response.arrayBuffer(); } catch (_) {}

    if (!response.ok) {
      console.log(`❌ Main server rejected clip (${fileName}), attempt ${attempt}/${RETRY_UPLOAD_ATTEMPTS}: HTTP ${response.status}`);
      if (attempt < RETRY_UPLOAD_ATTEMPTS) await sleep(RETRY_UPLOAD_DELAY_MS[attempt - 1]);
      continue;
    }

    console.log(`📤 Sent to main server: ${fileName}`);
    return true;
  }
  return false;
}

// ----------------------------------------------------------------
// Uploads a finished clip straight to the Google Drive REST API using
// the operator's OAuth token — plain HTTP (Node's built-in fetch), no
// googleapis SDK. FALLBACK ONLY — used when the main server can't be
// reached, since the main server normally handles Drive (and R2)
// uploads itself.
// ----------------------------------------------------------------
async function uploadClipToDrive(filePath, fileName) {
  if (!driveAccessToken || !driveFolderId) {
    console.log(`⚠️  Clip saved locally but not uploaded — Drive not connected yet: ${filePath}`);
    console.log('   (Click "Connect Google Drive" in the panel, then it will auto-sync here.)');
    return false;
  }

  let fileBuffer;
  try {
    fileBuffer = await fs.promises.readFile(filePath);
  } catch (err) {
    console.log(`❌ Could not read clip file to upload (${fileName}):`, err.message || String(err));
    return false;
  }

  const metadata = { name: fileName, parents: [driveFolderId] };

  for (let attempt = 1; attempt <= RETRY_UPLOAD_ATTEMPTS; attempt++) {
    const boundary = 'clipperhelper' + Date.now();
    const bodyStart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: video/mp4\r\n\r\n`
    );
    const bodyEnd = Buffer.from(`\r\n--${boundary}--`);
    const multipartBody = Buffer.concat([bodyStart, fileBuffer, bodyEnd]);

    let response;
    try {
      response = await fetchWithTimeout(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${driveAccessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
          },
          body: multipartBody
        },
        FETCH_TIMEOUT_MS
      );
    } catch (err) {
      const timedOut = err && err.name === 'AbortError';
      console.log(`❌ Drive upload error (${fileName}), attempt ${attempt}/${RETRY_UPLOAD_ATTEMPTS}:`, timedOut ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : (err.message || String(err)));
      if (attempt < RETRY_UPLOAD_ATTEMPTS) await sleep(RETRY_UPLOAD_DELAY_MS[attempt - 1]);
      continue;
    }

    let result = {};
    try { result = await response.json(); } catch (_) {}

    if (!response.ok) {
      const msg = (result.error && result.error.message) || JSON.stringify(result);
      if (response.status === 401) {
        // Token expired — retrying won't help until the panel refreshes
        // it via /set-token, so stop immediately instead of burning
        // through retries.
        console.log(`❌ Upload failed — Drive login expired. Click "Connect Google Drive" in the panel again. (${fileName})`);
        return false;
      }
      console.log(`❌ Drive upload error (${fileName}), attempt ${attempt}/${RETRY_UPLOAD_ATTEMPTS}:`, msg);
      if (attempt < RETRY_UPLOAD_ATTEMPTS) await sleep(RETRY_UPLOAD_DELAY_MS[attempt - 1]);
      continue;
    }

    console.log(`☁️  Uploaded to Drive: ${fileName} → ${result.webViewLink}`);
    return true;
  }
  return false;
}

// ----------------------------------------------------------------
// 🔄 Startup recovery — any clip that was cut successfully last
// session but never made it to the main server or Drive (e.g. the
// website was down, or the PC's internet dropped) gets requeued onto
// the upload queue on startup, using the exact same upload path as a
// normal clip. The .mp4 is safe on disk either way, so the operator
// never has to remember to manually re-send anything.
// ----------------------------------------------------------------
async function retryPreviouslyFailedClips() {
  if (!fs.existsSync(FAILED_LOG_PATH)) return;
  let list;
  try {
    list = JSON.parse(await fs.promises.readFile(FAILED_LOG_PATH, 'utf8'));
  } catch (_) {
    return;
  }
  const stillPending = [];
  let requeued = 0;
  for (const entry of list) {
    const hasFile = entry.outputPath && fs.existsSync(entry.outputPath);
    // Only worth auto-retrying the "cut succeeded, upload failed" case —
    // a missing recording file or a genuine cut/validation failure needs
    // the operator's attention, not a silent retry loop.
    if (!hasFile || entry.reason !== 'cut succeeded but both main-server and Drive uploads failed') {
      stillPending.push(entry);
      continue;
    }
    uploadQueue.push({ outputPath: entry.outputPath, fileName: entry.fileName, eventType: entry.eventType, eventTime: entry.eventTime, matchId: entry.matchId, ballMeta: entry.ballMeta });
    requeued++;
  }
  // Rewrite the log now with just the genuinely-stuck ones; anything
  // requeued above will re-log itself if it fails again.
  try { await fs.promises.writeFile(FAILED_LOG_PATH, JSON.stringify(stillPending, null, 2)); } catch (_) {}
  if (requeued) {
    console.log(`🔄 Requeued ${requeued} clip(s) left over from last session for upload`);
    runUploadQueue();
  }
}

app.listen(config.port, () => {
  console.log('================================================');
  console.log(`🎥 Clipper Helper running at http://localhost:${config.port}`);
  console.log(`👉 Setup page (no more editing config.json by hand): http://localhost:${config.port}/setup`);
  console.log(`Using ffmpeg: ${ffmpegPath}`);
  console.log(`Clip window: ${EVENT_BEFORE_SECONDS}s before + ${EVENT_AFTER_SECONDS}s after = ${CLIP_DURATION_SECONDS}s total`);
  console.log(`Clips folder: ${getClipsDir()}`);
  if (!fs.existsSync(ffmpegPath)) {
    console.log('⚠️  WARNING: ffmpeg.exe not found at that path — clips will fail to cut.');
    console.log('   Make sure ffmpeg.exe sits in the SAME folder as ClipperHelper.exe.');
  }
  console.log('Keep this window open during the match.');
  console.log('================================================');

  // Pop the Setup page open automatically EVERY time the exe starts —
  // gives the operator visible confirmation the helper is up before
  // they start the match, instead of only ever seeing it once.
  const setupUrl = `http://localhost:${config.port}/setup`;
  const opener = process.platform === 'win32' ? 'start ""'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  exec(`${opener} ${setupUrl}`, () => {});

  retryPreviouslyFailedClips().catch((err) => {
    console.log('⚠️  Startup recovery pass hit an error (not fatal):', err && err.message || err);
  });
});
