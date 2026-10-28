// ================================================================
// 🏐 VOLLEYBALL CLIPPER — its own program on the PC that records (vMix).
//
//   vMix recording → Volleyball Clipper → point clip → website → R2 + Drive
//
// A separate program from the Cricket Clipper (clipper-helper/,
// ClipperHelper.exe) — on purpose, so installing, building, starting or
// stopping one can never touch the other:
//
//                     CRICKET                    VOLLEYBALL (this)
//   program           ClipperHelper.exe          VolleyballClipper.exe
//   port              localhost:5005             localhost:5007
//   Start/Stop link   asl-clipper://             asl-vb-clipper://
//   launcher          clipper-launch.vbs         volleyball-clipper-launch.vbs
//   settings          config.json                volleyball-clipper-config.json
//   clip queue        clip-jobs.json             volleyball-clip-jobs.json
//   clips folder      <recording>\Clips          <recording>\VolleyballClips
//   log               clipper-log.txt            volleyball-clipper-log.txt
//
// Every file name differs, so the two can even sit in one folder without
// overwriting each other — but each belongs in its own folder.
//
// What it does: one volleyball point = one clip. The panel (or the Clipper
// page) sends the point the moment it is scored; the clip is the rally
// before the press and the end of it — PRE_ROLL + POST_ROLL seconds (7 + 3
// = 10 s by default, volleyball-clipper-config.json) — cut from vMix's own
// recording while vMix is still writing it, filed under the set and the
// players who earned the point, then uploaded to the website's volleyball
// ingest (offline: kept here and sent once, when the internet is back).
//
// The pipeline — the recording-file anchor, the wait for the footage, the
// ffmpeg cut and its checks, the offline-first upload queue — is the
// Cricket Clipper's proven one (v5.2), copied here and reduced to points.
// Nothing is shared with it at run time: no file, no port, no process.
// ================================================================

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, exec } = require('child_process');
const { Fmp4Index } = require('./vb-fmp4');
const files = require('./vb-organizer');

const APP_NAME = 'Volleyball Clipper';
const EXE_NAME = 'VolleyballClipper.exe';
const HELPER_VERSION = '1.0';

// When bundled by pkg into VolleyballClipper.exe, __dirname points inside
// a virtual snapshot, not the real folder the .exe sits in.
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

// ffmpeg.exe next to VolleyballClipper.exe; falls back to the bundled copy.
const localFfmpeg = path.join(BASE_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
let ffmpegPath = process.env.FFMPEG_PATH || localFfmpeg;
if (!fs.existsSync(ffmpegPath)) {
  try { ffmpegPath = require('@ffmpeg-installer/ffmpeg').path; } catch (_) { /* reported at startup */ }
}

process.on('uncaughtException', (err) => {
  console.log('❌ Unexpected error (Volleyball Clipper kept running):', (err && err.stack) || err);
});
process.on('unhandledRejection', (err) => {
  console.log('❌ Unexpected async error (Volleyball Clipper kept running):', (err && err.stack) || err);
});

// ----------------------------------------------------------------
// ⚙️ SETTINGS (volleyball-clipper-config.json next to the exe) + session.
// ----------------------------------------------------------------
const CONFIG_PATH = path.join(BASE_DIR, 'volleyball-clipper-config.json');
let config = {
  port: 5007,
  // The file vMix records to — or just its folder. Whichever media file in
  // that folder is being written right now is used (resolveActiveRecording).
  vmixRecordingFile: 'C:\\Users\\YOUR_NAME\\Videos\\vMix',
  // Blank = "<recording folder>\VolleyballClips".
  clipsFolder: '',
  // The website's address (only its origin is used). The panel fills it in.
  mainServerUrl: '',
  // One point's clip: the rally before the press + how it ended.
  // 7 s before + 3 s after = 10 s (the cut starts 3 s after the point).
  preRollSeconds: 7,
  postRollSeconds: 3,
};
try {
  if (fs.existsSync(CONFIG_PATH)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  else fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
} catch (err) {
  console.log('⚠️  Could not read volleyball-clipper-config.json, using defaults:', err.message);
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (err) { console.log('⚠️  Could not write volleyball-clipper-config.json:', err.message); }
}

// "https://site.com/volleyball-panel?match=x" -> "https://site.com"
function toOrigin(url) {
  try { return new URL(String(url).trim()).origin; } catch (_) { return ''; }
}
// The website this clipper syncs to (the panel's value wins; setup is the fallback).
function websiteOrigin() {
  return session.mainServerUrl || toOrigin(config.mainServerUrl) || '';
}

const STATE_PATH = path.join(BASE_DIR, 'volleyball-clipper-state.json');
const session = {
  matchId: null,
  matchLabel: null,
  tournamentId: null,
  tournamentName: null,
  mainServerUrl: toOrigin(config.mainServerUrl),
  recordingStartedAt: null,
};
try { Object.assign(session, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))); } catch (_) { /* first run */ }
function saveSession() {
  fs.writeFile(STATE_PATH, JSON.stringify(session, null, 2), () => {});
}

// ----------------------------------------------------------------
// 🎯 THE POINT'S WINDOW — the one place these numbers live.
// ----------------------------------------------------------------
function clampSeconds(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
const PRE_ROLL_SECONDS = clampSeconds(config.preRollSeconds, 7, 1, 120);   // the rally before the press
const POST_ROLL_SECONDS = clampSeconds(config.postRollSeconds, 3, 1, 60);  // after the press (and the wait before cutting)
const CLIP_SECONDS = PRE_ROLL_SECONDS + POST_ROLL_SECONDS;                // 10

const COVERAGE_WAIT_MAX_MS = 30000;   // max extra wait for the recording to reach T0+post on disk
const CUT_TIMEOUT_MS = 120000;        // one ffmpeg cut; killed after this
const CUT_MAX_ATTEMPTS = 6;
const CUT_RETRY_DELAYS_MS = [3000, 8000, 15000, 30000, 60000];
const UPLOAD_IDLE_TIMEOUT_MS = 60000; // no bytes moving for this long = dead connection
const UPLOAD_BACKOFF_MS = [2000, 5000, 10000, 20000, 45000, 90000, 180000, 300000]; // then every 5 min
const SYNC_MAX_BACKOFF_MS = 5 * 60 * 1000;
const NET_PROBE_OFFLINE_MS = 10000;
const NET_PROBE_ONLINE_MS = 30000;
const NET_PROBE_TIMEOUT_MS = 8000;
const STATUS_POLL_WINDOW_MS = 12 * 60 * 60 * 1000;
const STATUS_POLL_INTERVAL_MS = 2000;
const STATUS_POLL_BATCH = 12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every repeating timer of this program, so Stop ends all of them.
let stopping = false;   // set once by shutdown(): nothing new is started after it
const intervals = new Set();
function every(fn, ms) { const t = setInterval(fn, ms); intervals.add(t); return t; }

function recordingDir() {
  const p = config.vmixRecordingFile || '.';
  try { if (fs.statSync(p).isDirectory()) return p; } catch (_) { /* not there (yet) */ }
  return path.dirname(p);
}
function getClipsDir() {
  const folder = (config.clipsFolder || '').trim();
  if (folder) return path.isAbsolute(folder) ? folder : path.join(BASE_DIR, folder);
  return path.join(recordingDir(), 'VolleyballClips');
}
// ffmpeg's scratch space — the organised tree only ever holds finished clips.
function getWorkDir() {
  return path.join(getClipsDir(), '_work');
}
function insideClipsDir(file) {
  const root = path.resolve(getClipsDir()) + path.sep;
  return (path.resolve(file) + path.sep).startsWith(root);
}

// ----------------------------------------------------------------
// 🛠️ ffmpeg — every process this program starts is tracked, bounded and
// killed (on a timeout, and on Stop). Never anyone else's.
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

// Duration of a media file (works on a file vMix is still writing, as long
// as it is a streamable format — fragmented MP4 and the like).
async function probeDuration(filePath) {
  const r = await runFfmpeg(['-hide_banner', '-nostdin', '-i', filePath], { timeoutMs: 60000 });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr);
  if (!m) {
    const reason = /moov atom not found/i.test(r.stderr)
      ? 'recording is not readable while vMix is recording (MP4 index is only written at the end) — use a fragmented/streamable recording format'
      : (r.timedOut ? 'probe timed out' : (r.stderr.trim().split('\n').pop() || 'no Duration line'));
    return { ok: false, reason };
  }
  return { ok: true, seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
}

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
// 📼 THE RECORDING — the file vMix is writing, and a wall-clock ↔
// file-time anchor for it (min over 3 min of probe time − duration: the
// written end can only lag real time, never lead it).
// ----------------------------------------------------------------
const MEDIA_EXT = new Set(['.mp4', '.mov', '.mkv', '.ts', '.m4v', '.mts', '.m2ts']);
const ANCHOR_WINDOW_MS = 3 * 60 * 1000;
const sources = new Map();
let activeRecording = null; // { file, size, mtimeMs, growing }
let recordingError = null;
// More than one media file being written at once (a second recording, ISO
// files): the newest is still used, and the panel is told.
let recordingAmbiguous = null;

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
      if (insideClipsDir(full)) continue;
      candidates.push(full);
    }
  } catch (_) { /* folder missing — handled below */ }
  if (configured && !candidates.includes(configured) && fs.existsSync(configured) && !fs.statSync(configured).isDirectory()) candidates.push(configured);
  let best = null;
  const writing = [];
  for (const full of candidates) {
    try {
      const st = await fs.promises.stat(full);
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, size: st.size, mtimeMs: st.mtimeMs };
      if (Date.now() - st.mtimeMs < 15000) writing.push(path.basename(full));
    } catch (_) { /* vanished */ }
  }
  recordingAmbiguous = writing.length > 1 ? writing.slice(0, 5) : null;
  if (!best) {
    activeRecording = null;
    recordingError = `No recording file found in ${dir} — is vMix recording, and is the recording folder in Setup correct?`;
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
    if (src.idx.supported !== false) {
      try {
        await src.idx.refresh();
        if (src.idx.supported) r = { ok: true, seconds: src.idx.durationSec };
      } catch (e) { /* e.g. briefly locked — ffmpeg fallback below */ }
    }
    if (!r) r = await probeDuration(file);
    if (!r.ok) { src.lastError = r.reason; return src; }
    src.lastError = null;
    src.durationSec = r.seconds;
    src.probedAt = wall;
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

async function sourceTick() {
  try {
    const rec = await resolveActiveRecording();
    if (rec && (rec.growing || !sourceFor(rec.file).anchor)) await probeSource(rec.file);
  } catch (err) {
    console.log('⚠️  Recording check error (will retry):', err.message);
  }
}
every(sourceTick, 5000);

// ----------------------------------------------------------------
// 🌐 CONNECTIVITY — asked by the upload side only; cutting never waits
// for it. Offline: one tiny GET <website>/api/ping every 10 s, nothing else.
// ----------------------------------------------------------------
const net = { online: null, lastOkAt: 0, lastCheckAt: 0, lastError: null, probing: null, wentOfflineAt: 0 };

function probeInternet(force = false) {
  if (net.probing) return net.probing;
  const server = websiteOrigin();
  if (!server) {
    net.online = false;
    net.lastError = 'website URL not set — start the Clipper from the volleyball panel';
    return Promise.resolve(false);
  }
  const due = net.online ? NET_PROBE_ONLINE_MS : NET_PROBE_OFFLINE_MS;
  if (!force && net.lastCheckAt && Date.now() - net.lastCheckAt < due) return Promise.resolve(!!net.online);
  net.probing = (async () => {
    net.lastCheckAt = Date.now();
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
    console.log(`🌐 INTERNET DETECTED${was === false ? ` after ${Math.round((Date.now() - (net.wentOfflineAt || Date.now())) / 1000)}s offline` : ''} — ${pending} clip(s) pending upload`);
    resumePendingSync('internet is back');
  } else {
    net.wentOfflineAt = Date.now();
    const pending = [...jobs.values()].filter(isUnsynced).length;
    console.log(`📴 No internet (${net.lastError || 'unreachable'}) — point clips keep being cut and saved locally${pending ? `; ${pending} waiting to upload` : ''}`);
  }
}

function isUnsynced(job) {
  return !['SYNC_COMPLETE', 'CUT_FAILED'].includes(job.status);
}

function resumePendingSync(why) {
  let n = 0;
  for (const job of jobs.values()) {
    if (!SYNCABLE.includes(job.status)) continue;
    job.syncAttempts = 0;
    job.nextUploadAt = null;
    queueSync(job);
    n++;
  }
  if (n) console.log(`🔄 Resuming upload of ${n} pending clip(s) — ${why}`);
  return n;
}

const OFFLINE_ERROR_RE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|ECONNRESET|socket hang up|network|timed out|no progress for/i;
function noteNetworkOutcome(ok, error) {
  if (ok) return setOnline(true, null);
  if (error && OFFLINE_ERROR_RE.test(String(error))) probeInternet(true).catch(() => {});
}

every(() => { probeInternet().catch(() => {}); }, NET_PROBE_OFFLINE_MS);

// ----------------------------------------------------------------
// 🗂️ POINT CLIP JOBS — one per point, written to volleyball-clip-jobs.json
// (before a press is even acknowledged), so a lost connection, a restart
// of this program or of the PC all resume exactly where they were.
//
//  STAGE A (local, never needs the network):
//    WAITING → CUTTING → LOCAL_SAVED        (CUT_RETRY → CUT_FAILED)
//  STAGE B (upload, only ever waits for the internet):
//    LOCAL_SAVED → OFFLINE_PENDING → SENDING → SENT → SYNC_COMPLETE
//    (SYNC_RETRY while it is failing — a clip on this disk is never given up)
// ----------------------------------------------------------------
const CUT_STATES = ['WAITING', 'CUTTING', 'CUT_RETRY'];
const SYNCABLE = ['LOCAL_SAVED', 'OFFLINE_PENDING', 'SENDING', 'SENT', 'SYNC_RETRY'];
const STATUS_TEXT = {
  WAITING: 'WAITING FOR FOOTAGE',
  CUTTING: 'CUTTING LOCALLY',
  CUT_RETRY: 'CUT RETRY QUEUED',
  CUT_FAILED: 'CLIP COULD NOT BE CUT',
  LOCAL_SAVED: 'CLIP SAVED LOCALLY',
  OFFLINE_PENDING: 'UPLOAD PENDING - OFFLINE',
  SENDING: 'UPLOADING',
  SENT: 'R2 / DRIVE IN PROGRESS',
  SYNC_RETRY: 'UPLOAD RETRY QUEUED',
  SYNC_COMPLETE: 'SYNC COMPLETE',
};
const JOBS_PATH = path.join(BASE_DIR, 'volleyball-clip-jobs.json');
const jobs = new Map();
try {
  for (const j of JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'))) if (j && j.clipId) jobs.set(j.clipId, j);
} catch (_) { /* first run */ }

// 🏷️ "Who earned it" that arrived before its own press did (an out-of-order
// outbox). Persisted, so a restart still applies it when the press arrives.
const ORPHAN_META_PATH = path.join(BASE_DIR, 'volleyball-clip-meta-pending.json');
const orphanMeta = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(ORPHAN_META_PATH, 'utf8'));
  for (const [k, v] of Object.entries(raw || {})) orphanMeta.set(k, v);
} catch (_) { /* first run */ }
function saveOrphanMeta() {
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

// ----------------------------------------------------------------
// 🏐 THE POINT, as the panel described it at the press — and, once the
// scorer says so, who earned it (sent to /clip-meta). Everything the clip
// needs travels with the press, so it works with no internet at all. The
// point's eventId is the clip's identity on the website; it never changes.
// ----------------------------------------------------------------
const str = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') return typeof v.name === 'string' ? (v.name.trim() || null) : null;
  const s = String(v).trim();
  return s || null;
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const ATTRIBUTIONS = ['kill', 'ace', 'block', 'opp_error', 'team'];
const idPart = (v, max) => { const s = String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, max || 64); return s || null; };
const text = (v, max) => { const s = str(v); return s ? s.replace(/[\u0000-\u001f]/g, ' ').slice(0, max || 80) : null; };
function cleanPoint(p) {
  p = p && typeof p === 'object' ? p : {};
  const team = p.team === 'A' || p.team === 'B' ? p.team : null;
  const players = (Array.isArray(p.players) ? p.players : []).slice(0, 4).map((x) => (x && typeof x === 'object' ? {
    playerId: idPart(x.playerId), name: text(x.name), number: x.number != null && x.number !== '' ? String(x.number).slice(0, 4) : null,
    team: x.team === 'A' || x.team === 'B' ? x.team : team, role: text(x.role, 24),
  } : null)).filter((x) => x && x.playerId);
  const names = p.teamNames && typeof p.teamNames === 'object' ? p.teamNames : {};
  return {
    eventId: idPart(p.eventId), set: num(p.set), pointNo: num(p.pointNo), team,
    teamId: idPart(p.teamId), teamName: text(p.teamName), teamShort: text(p.teamShort, 12),
    teamNames: { A: text(names.A), B: text(names.B) },
    score: p.score && typeof p.score === 'object' ? { A: num(p.score.A), B: num(p.score.B) } : null,
    outcome: idPart(p.outcome, 32), attribution: ATTRIBUTIONS.includes(p.attribution) ? p.attribution : null,
    players, vbClipToken: idPart(p.vbClipToken, 96), at: num(p.at),
  };
}
// opts.authoritative (the scorer's attribution): its answer REPLACES the
// earlier one — a different player, or "team point" taking a name off.
// A re-sent press never wipes what is already known.
function applyPointMeta(job, payload, opts) {
  const next = cleanPoint(payload);
  const prev = job.point || {};
  const keep = (k) => (next[k] === null || next[k] === undefined ? (prev[k] === undefined ? null : prev[k]) : next[k]);
  const point = {};
  for (const k of ['set', 'pointNo', 'team', 'teamId', 'teamName', 'teamShort', 'score', 'outcome', 'vbClipToken', 'at']) point[k] = keep(k);
  point.eventId = prev.eventId || next.eventId || null;
  point.teamNames = { A: next.teamNames.A || (prev.teamNames && prev.teamNames.A) || null, B: next.teamNames.B || (prev.teamNames && prev.teamNames.B) || null };
  const answered = !!(opts && opts.authoritative) && payload && Object.prototype.hasOwnProperty.call(payload, 'attribution');
  point.attribution = answered ? next.attribution : next.attribution || prev.attribution || null;
  point.players = answered ? next.players : (next.players.length ? next.players : prev.players || []);
  if (payload && typeof payload.voided === 'boolean') point.voided = payload.voided;
  else if (prev.voided) point.voided = true;
  job.point = point;
  job.eventId = point.eventId;
  job.playerIds = point.players.map((x) => x.playerId);
  return job;
}
// What the website's volleyball ingest reads (one header — numbers, ids
// and the recording's file NAME only; never a local path).
function pointHeaderMeta(job) {
  const p = job.point || {};
  return {
    sport: 'volleyball', engine: 'volleyball-clipper', vbClipToken: p.vbClipToken || null, eventId: p.eventId || null,
    set: p.set, pointNo: p.pointNo, team: p.team, score: p.score, t0: job.t0,
    preRollSec: job.preRollSec, postRollSec: job.postRollSec,
    actualPreRollSec: job.actualPreRollSec != null ? job.actualPreRollSec : null, partialPreRoll: !!job.partialPreRoll,
    windowStart: job.window ? job.window.startWall : null, windowEnd: job.window ? job.window.endWall : null,
    durationSec: job.clipSeconds || null, cutOffline: !!job.cutOffline,
    sourceRecording: job.sourceRecording || null, sourceStartSec: job.sourceStartSec != null ? job.sourceStartSec : null, sourceEndSec: job.sourceEndSec != null ? job.sourceEndSec : null,
  };
}
// The website decides the R2 key (by set and point) and the Drive copy.
function destinationsFor(job) {
  return { r2Destination: null, driveDestination: { folderId: null, folderName: null, fileName: `${job.clipId}.mp4` } };
}

// ----------------------------------------------------------------
// ✂️ CUT QUEUE — local disk + ffmpeg only, one cut at a time (vMix runs on
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
  const dueAt = job.window && job.window.endWall ? job.window.endWall : job.t0 + POST_ROLL_SECONDS * 1000;
  later(() => enqueueCut(job.clipId), Math.max(0, dueAt - Date.now()));
}
function enqueueCut(clipId) {
  if (stopping) return;
  if (!cutQueue.includes(clipId)) cutQueue.push(clipId);
  pumpCuts();
}
async function pumpCuts() {
  if (cutRunning) return;
  cutRunning = true;
  try {
    while (cutQueue.length && !stopping) {
      const job = jobs.get(cutQueue.shift());
      if (!job || !CUT_STATES.includes(job.status)) continue;
      // Already cut (a restart, or a duplicate enqueue) — never cut a point twice.
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

  // The file that was recording when the point was scored.
  if (!job.sourceFile || !fs.existsSync(job.sourceFile)) {
    const rec = await resolveActiveRecording();
    if (!rec) return onCutFailure(job, recordingError || 'no recording file');
    job.sourceFile = rec.file;
  }
  let src = await probeSource(job.sourceFile);
  if (src.anchor == null) return onCutFailure(job, `cannot read recording: ${src.lastError || 'unknown'}`);

  // Wait (max COVERAGE_WAIT_MAX_MS) until the recording really reaches T0+post.
  let startSec = (job.window.startWall - src.anchor) / 1000;
  let endSec = (job.window.endWall - src.anchor) / 1000;
  const waitUntil = Date.now() + COVERAGE_WAIT_MAX_MS;
  while (src.durationSec < endSec && Date.now() < waitUntil && !stopping) {
    const stillGrowing = Date.now() - src.sizeChangedAt < 15000;
    if (!stillGrowing) break; // recording stopped — cut what exists
    await sleep(500);
    src = await probeSource(job.sourceFile);
    startSec = (job.window.startWall - src.anchor) / 1000;
    endSec = (job.window.endWall - src.anchor) / 1000;
  }
  if (stopping) return update(job, { status: 'WAITING', error: null });   // carries on next start
  if (endSec <= 0) return onCutFailure(job, 'this moment is before the start of the recording', { final: true });
  const recordingStopped = Date.now() - src.sizeChangedAt >= 15000;
  if (recordingStopped && startSec >= src.durationSec - 1) {
    // Scored within seconds of vMix starting a NEW file: use the file that is recording now.
    const rec = await resolveActiveRecording();
    if (rec && rec.file !== job.sourceFile && rec.growing) {
      console.log(`↪️  [POINT] ${job.clipId}: moment is after ${path.basename(job.sourceFile)} ended — using ${path.basename(rec.file)}`);
      job.sourceFile = rec.file;
      job.cutAttempts = Math.max(0, (job.cutAttempts || 1) - 1);
      return cutJob(job);
    }
  }
  if (recordingStopped && startSec >= src.durationSec - 1) {
    return onCutFailure(job, `vMix was not recording at the time of this point (${path.basename(job.sourceFile)} ends ${Math.round(startSec - src.durationSec + PRE_ROLL_SECONDS)}s before it)`, { final: true });
  }
  const fromSec = Math.max(0, startSec);
  const toSec = Math.min(endSec, src.durationSec);
  const duration = toSec - fromSec;
  // How much of the requested lead-in the recording really had (a point
  // seconds after vMix started has less) — reported, never padded.
  const pressSec = (job.t0 - src.anchor) / 1000;
  const actualPreRollSec = Number(Math.max(0, Math.min(pressSec, toSec) - fromSec).toFixed(1));
  const requestedPre = (job.t0 - job.window.startWall) / 1000;
  if (duration < 1) return onCutFailure(job, `recording has no footage for this moment yet (recorded up to ${src.durationSec.toFixed(1)}s, needed ${endSec.toFixed(1)}s)`);

  // Normally one piece. If vMix finished this file mid-clip and moved on to
  // a new one, the rest of the moment is taken from the new file.
  const segments = [{ src, file: job.sourceFile, from: fromSec, to: toSec }];
  if (recordingStopped && endSec > src.durationSec + 0.5) {
    const rec = await resolveActiveRecording();
    if (rec && rec.file !== job.sourceFile) {
      const nxt = await probeSource(rec.file);
      if (nxt.anchor != null) {
        const aEndWall = src.anchor + src.durationSec * 1000;
        const bFrom = Math.max(0, (Math.max(job.window.startWall, aEndWall) - nxt.anchor) / 1000);
        const bTo = Math.min((job.window.endWall - nxt.anchor) / 1000, nxt.durationSec);
        if (bTo - bFrom >= 0.5) segments.push({ src: nxt, file: rec.file, from: bFrom, to: bTo });
      }
    }
  }
  if (segments.length > 1 && segments[0].to - segments[0].from < 0.3) segments.shift();
  const expected = segments.reduce((a, g) => a + (g.to - g.from), 0);

  const clipsDir = getWorkDir();
  await fs.promises.mkdir(clipsDir, { recursive: true });
  const outFile = path.join(clipsDir, `${job.clipId}.mp4`);
  const partFile = path.join(clipsDir, `${job.clipId}.part.mp4`);
  console.log(`✂️  [POINT] ${job.clipId}: cutting ${segments.map((g) => `${path.basename(g.file)} ${g.from.toFixed(1)}s → ${g.to.toFixed(1)}s`).join(' + ')} (${expected.toFixed(1)}s)`);

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
      if (stopping) return update(job, { status: 'WAITING', error: null });
      return onCutFailure(job, r.timedOut ? `ffmpeg cut timed out after ${CUT_TIMEOUT_MS / 1000}s (killed)` : `ffmpeg: ${r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
    }
    pieces.push(out);
  }
  if (pieces.length > 1) {
    const list = path.join(clipsDir, `${job.clipId}.list.txt`);
    temps.push(list);
    await fs.promises.writeFile(list, pieces.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const r = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', partFile], { timeoutMs: CUT_TIMEOUT_MS, lowPriority: true });
    cleanup();
    if (r.code !== 0) { fs.unlink(partFile, () => {}); return onCutFailure(job, `could not join the two recording files: ${r.stderr.trim().split('\n').pop()}`); }
  }

  // ✅ Validate: real, readable video of the expected length.
  let size = 0;
  try { size = (await fs.promises.stat(partFile)).size; } catch (_) { /* missing */ }
  const check = size > 20 * 1024 ? await probeDuration(partFile) : { ok: false, reason: `file too small (${size} bytes)` };
  if (!check.ok || check.seconds < expected - 1.5) {
    fs.unlink(partFile, () => {});
    return onCutFailure(job, check.ok ? `clip came out ${check.seconds.toFixed(1)}s instead of ${expected.toFixed(1)}s` : `invalid clip: ${check.reason}`);
  }
  try {
    await renameWithRetry(partFile, outFile);
  } catch (err) {
    fs.unlink(partFile, () => {});
    return onCutFailure(job, `could not save clip: ${err.message}`);
  }
  update(job, {
    localPath: outFile, clipSeconds: Number(check.seconds.toFixed(1)), savedAt: Date.now(), error: null,
    // which recording, and which part of it, this clip is
    sourceRecording: path.basename(segments[0].file), sourceStartSec: Number(segments[0].from.toFixed(2)), sourceEndSec: Number(segments[segments.length - 1].to.toFixed(2)),
    actualPreRollSec, partialPreRoll: actualPreRollSec < requestedPre - 0.5,
  });
  await finalizeLocalClip(job);
}

// 💾 STAGE A COMPLETE — the clip exists. File it under its set and players,
// write its metadata beside it, and only THEN hand it to the upload queue.
async function finalizeLocalClip(job) {
  if (net.online === false) job.cutOffline = true;
  await organizeClipFiles(job);
  console.log(`💾 [POINT] ${job.clipId}: CLIP SAVED LOCALLY (${job.clipSeconds || '?'}s) → ${job.localPath}`);
  for (const l of job.links || []) {
    if (l.mode !== 'failed') console.log(`   ↳ 🏐 ${l.playerName || l.playerId}: ${l.path}${l.mode === 'copy' ? ' (copy — this filesystem has no hard links)' : ''}`);
  }
  update(job, { status: 'LOCAL_SAVED', error: null, ...destinationsFor(job) });
  queueSync(job);
}

// Set-N/<point>.mp4 + the credited players' folders (see vb-organizer.js).
// Idempotent: re-run when the attribution arrives — moved/re-linked, never re-cut.
async function organizeClipFiles(job) {
  if (!job.localPath || !fs.existsSync(job.localPath)) return false;
  try {
    const p = job.point || {};
    const placed = await files.placePointClip({
      clipsRoot: getClipsDir(),
      currentPath: job.localPath,
      meta: {
        point: p, teamNames: p.teamNames || {},
        matchId: job.matchId, matchLabel: job.matchLabel,
        tournamentId: job.tournamentId, tournamentName: job.tournamentName, tournamentMatchId: null,
      },
      previous: { primary: job.localPath, links: job.links || [] },
    });
    update(job, {
      localPath: placed.primary, localFilePath: placed.primary, filename: placed.filename, links: placed.links,
      matchRoot: placed.matchRoot, highlightCategory: placed.category, organizedAt: Date.now(),
    });
    await files.writeClipMetadata(placed.matchRoot, pointClipMetaFor(job));
    return true;
  } catch (err) {
    console.log(`⚠️  [POINT] ${job.clipId}: could not file the clip into its folders (${err.message}) — the clip is still saved at ${job.localPath}`);
    return false;
  }
}
// The point's own record beside its clip (no token, no local paths).
function pointClipMetaFor(job) {
  const p = Object.assign({}, job.point || {});
  delete p.vbClipToken;
  return {
    clipId: job.clipId, sport: 'volleyball', matchId: job.matchId, tournamentId: job.tournamentId || null, tournamentName: job.tournamentName || null,
    matchLabel: job.matchLabel || null, point: p, timestamp: job.t0,
    window: job.window || null, preRollSec: job.preRollSec, postRollSec: job.postRollSec, actualPreRollSec: job.actualPreRollSec != null ? job.actualPreRollSec : null,
    clipSeconds: job.clipSeconds || null, sourceRecording: job.sourceRecording || null, sourceStartSec: job.sourceStartSec != null ? job.sourceStartSec : null,
    filename: job.filename || null, cutOffline: !!job.cutOffline, createdAt: job.createdAt, cutAt: job.savedAt || null,
  };
}

function adoptExistingClip(job) {
  console.log(`♻️  [POINT] ${job.clipId}: already cut — reusing ${job.localPath} (no re-cut)`);
  update(job, { status: 'LOCAL_SAVED', error: null, ...destinationsFor(job) });
  queueSync(job);
}

// Cuts one piece [g.from, g.to] of g.file. fMP4: only the fragments around
// the moment are copied out first, so the cost does not grow with the match.
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
      console.log(`⚠️  [POINT] ${job.clipId}: fast extract failed (${e.message}) — cutting from the full recording`);
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
    console.log(`⚠️  [POINT] ${job.clipId}: ${reason} — retrying in ${delay / 1000}s (other clips continue)`);
    update(job, { status: 'CUT_RETRY', error: reason });
    later(() => enqueueCut(job.clipId), delay);
    return;
  }
  console.log(`❌ [POINT] ${job.clipId}: clip could not be cut — ${reason}`);
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
// ☁️ STAGE B — UPLOAD QUEUE. Network only, completely separate from
// Stage A. The website holds the R2 and Drive credentials: one POST of the
// finished clip to its volleyball ingest drives both, keyed by the clip's
// stable clipId, so a retry can only ever update the SAME records.
// ----------------------------------------------------------------
const syncQueue = [];
let syncRunning = 0;
const UPLOAD_CONCURRENCY = Math.max(1, parseInt(process.env.UPLOAD_CONCURRENCY, 10) || 2);
const syncInFlight = new Set();

function queueSync(job) {
  if (stopping) return;
  if (!syncQueue.includes(job.clipId)) syncQueue.push(job.clipId);
  pumpSync();
}
function pumpSync() {
  while (syncRunning < UPLOAD_CONCURRENCY && syncQueue.length && !stopping) {
    const job = jobs.get(syncQueue.shift());
    if (!job || !SYNCABLE.includes(job.status) || syncInFlight.has(job.clipId)) continue;
    syncRunning++;
    syncInFlight.add(job.clipId);
    syncJob(job)
      .catch((err) => onSyncFailure(job, `unexpected: ${err.message}`))
      .finally(() => { syncInFlight.delete(job.clipId); syncRunning--; pumpSync(); });
  }
}

function verifyLocalFile(job) {
  if (job.localPath && fs.existsSync(job.localPath)) return true;
  // The players' folders hold hard links to the same bytes.
  for (const l of job.links || []) {
    if (l && l.path && fs.existsSync(l.path)) {
      update(job, { localPath: l.path, localFilePath: l.path });
      return true;
    }
  }
  return false;
}

function markOfflinePending(job, reason) {
  job.cutOffline = true;
  if (job.status !== 'OFFLINE_PENDING') {
    console.log(`📦 [POINT] ${job.clipId}: UPLOAD PENDING - OFFLINE (clip is safe at ${job.localPath})`);
  }
  update(job, { status: 'OFFLINE_PENDING', error: reason || net.lastError || 'no internet', nextUploadAt: null });
}

const STATUS_PATH = '/api/volleyball/clips/status/';
const INGEST_PATH = '/api/volleyball/clips/ingest';

async function syncJob(job) {
  const server = websiteOrigin();
  const matchId = job.matchId || session.matchId;
  if (!verifyLocalFile(job)) {
    console.log(`❌ [POINT] ${job.clipId}: local clip file is gone — cannot upload (the point is NOT re-cut)`);
    update(job, { status: 'CUT_FAILED', error: 'local clip file is missing — cannot upload' });
    return;
  }
  if (!server || !matchId) {
    update(job, { status: 'OFFLINE_PENDING', error: !server ? 'website URL not set — start the Clipper from the volleyball panel' : 'no match id for this clip', nextUploadAt: Date.now() + 30000 });
    later(() => queueSync(job), 30000);
    return;
  }
  if (net.online === null) await probeInternet(true).catch(() => {});
  if (net.online === false) return markOfflinePending(job);

  job.syncAttempts = (job.syncAttempts || 0) + 1;
  job.retryCount = job.syncAttempts;

  // What does the website ALREADY have for this clipId? (skipped the very
  // first time — nothing can be there yet)
  const neverSent = !job.uploadedAt && (job.syncAttempts || 0) <= 1;
  const remote = neverSent ? { status: 404, json: null } : await getJson(`${server}${STATUS_PATH}${encodeURIComponent(job.clipId)}`, 12000);
  if (!remote) {
    noteNetworkOutcome(false, 'website unreachable');
    if (net.online === false) return markOfflinePending(job);
    return onSyncFailure(job, 'website unreachable');
  }
  if (!neverSent) noteNetworkOutcome(true);
  const doc = remote.status === 200 && remote.json && remote.json.success ? remote.json : null;
  if (doc && doc.deleted) return markDeletedOnWebsite(job);
  const r2Done = !!doc && doc.r2Status === 'uploaded';
  const driveDone = !!doc && doc.driveStatus === 'uploaded';
  update(job, {
    r2Status: doc ? doc.r2Status || 'pending' : job.r2Status || 'pending',
    driveStatus: doc ? doc.driveStatus || 'pending' : job.driveStatus || 'pending',
    serverStatus: doc ? doc.status : null,
  });
  if (r2Done && driveDone) return markComplete(job);
  const websiteLostItsCopy = !doc || doc.status === 'NEEDS_REUPLOAD' || doc.status === 'FAILED_PERMANENT';
  if (r2Done && !websiteLostItsCopy) {
    update(job, { status: 'SENT', uploadedAt: job.uploadedAt || Date.now(), error: null });
    return;
  }

  update(job, { status: 'SENDING', error: null });
  const qs = new URLSearchParams({ matchId, eventType: 'POINT', timestamp: String(job.t0), clipId: job.clipId });
  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(job.localPath).size; } catch (_) { /* reported by postFile */ }
  const startedAt = Date.now();
  const chunked = (job.syncAttempts || 1) % 2 === 0;
  console.log(`⬆️  [POINT] ${job.clipId}: UPLOADING (via the website) — attempt ${job.syncAttempts}${chunked ? ' (chunked)' : ''}`);
  // ONE header, numbers and ids only (a local path in a header is what a
  // WAF in front of the website rejects).
  const r = await postFile(`${server}${INGEST_PATH}?${qs}`, job.localPath, { 'X-Ball-Meta': headerJson(pointHeaderMeta(job)) }, { chunked });
  const stats = uploadStats(sizeBytes, startedAt);
  if (!r.ok) {
    noteNetworkOutcome(false, r.error);
    if (net.online === false) return markOfflinePending(job);
    return onSyncFailure(job, r.error, stats, r.phases);
  }
  noteNetworkOutcome(true);
  if (/"deleted"\s*:\s*true/.test(r.body || '')) return markDeletedOnWebsite(job);
  console.log(`📤 [POINT] ${job.clipId}: received by the website (${stats} · ${r.phases}) — R2 + Drive uploads running there`);
  update(job, { status: 'SENT', uploadedAt: Date.now(), r2Status: job.r2Status === 'uploaded' ? 'uploaded' : 'pending', driveStatus: job.driveStatus === 'uploaded' ? 'uploaded' : 'pending', error: null });
}

// The clip was linked to its point when the website received it (and
// follows the point's attribution there) — nothing more to attach.
function markComplete(job) {
  update(job, { status: 'SYNC_COMPLETE', websiteStatus: 'updated', syncedAt: Date.now(), error: null });
  console.log(`✅ [POINT] ${job.clipId}: SYNC COMPLETE — local ✓ · R2 ✓ · Drive ✓ · website ✓`);
}
function markDeletedOnWebsite(job) {
  if (job.deletedOnWebsite && job.status === 'SYNC_COMPLETE') return;
  console.log(`🗑️  [POINT] ${job.clipId}: deleted on the website — not sent again`);
  update(job, { status: 'SYNC_COMPLETE', deletedOnWebsite: true, websiteStatus: 'deleted', error: null, nextUploadAt: null });
}

const HELPER_UA = `VolleyballClipper/${HELPER_VERSION} (local vMix point clipper; +https://github.com/jeeth-ops/tt-overlay)`;
const BASE_HEADERS = { 'User-Agent': HELPER_UA, 'Accept': 'application/json' };

// JSON safe in an HTTP header (non-ASCII names as \uXXXX).
function headerJson(obj) {
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function uploadStats(sizeBytes, startedAt) {
  const secs = Math.max(0.1, (Date.now() - startedAt) / 1000);
  const mb = sizeBytes / (1024 * 1024);
  const mbps = (sizeBytes * 8) / secs / 1e6;
  return `${mb.toFixed(1)}MB in ${secs.toFixed(1)}s = ${mbps.toFixed(1)} Mbps`;
}
function syncBackoffMs(attempt) {
  return UPLOAD_BACKOFF_MS[Math.min(Math.max(1, attempt), UPLOAD_BACKOFF_MS.length) - 1] || SYNC_MAX_BACKOFF_MS;
}
function onSyncFailure(job, reason, stats, phases) {
  if (phases) console.log(`   ↳ ${phases}`);
  else if (stats) console.log(`   ↳ died after ${stats}`);
  const delay = syncBackoffMs(job.syncAttempts || 1);
  console.log(`⚠️  [POINT] ${job.clipId}: UPLOAD RETRY QUEUED (${reason}) — next try in ${Math.round(delay / 1000)}s; the clip itself is safe at ${job.localPath}`);
  update(job, { status: 'SYNC_RETRY', error: reason, nextUploadAt: Date.now() + delay });
  later(() => queueSync(job), delay);
}

// Streams a file as the request body; times out only when nothing moves.
function postFile(url, filePath, extraHeaders, { chunked = false } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad website URL' }); }
    let size;
    try { size = fs.statSync(filePath).size; } catch (e) { return resolve({ ok: false, error: 'clip file missing' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const lengthHeaders = chunked ? {} : { 'Content-Length': size };
    const t0 = Date.now();
    const t = { connected: null, sent: null };
    let sentBytes = 0;
    let settled = false;
    const phases = () => {
      const conn = t.connected ? t.connected - t0 : null;
      const send = t.sent && t.connected ? t.sent - t.connected : null;
      const wait = t.sent ? Date.now() - t.sent : null;
      return `connect ${conn == null ? '—' : conn + 'ms'} · body ${send == null ? 'NOT SENT' : `${(sentBytes / 1024).toFixed(0)}KB in ${send}ms`} · reply wait ${wait == null ? '—' : (wait / 1000).toFixed(1) + 's'}${chunked ? ' · chunked' : ''}`;
    };
    const finish = (res) => { if (!settled) { settled = true; resolve({ ...res, phases: phases() }); } };
    const req = lib.request(u, {
      method: 'POST',
      agent: false,
      headers: { ...BASE_HEADERS, 'Content-Type': 'video/mp4', ...lengthHeaders, ...extraHeaders },
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
    req.on('socket', (sock) => {
      if (sock.connecting) sock.once('connect', () => { t.connected = Date.now(); });
      else t.connected = Date.now();
    });
    req.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => { req.destroy(new Error(`no progress for ${UPLOAD_IDLE_TIMEOUT_MS / 1000}s`)); });
    req.on('error', (e) => finish({ ok: false, error: e.message }));
    const stream = fs.createReadStream(filePath);
    stream.on('data', (c) => { sentBytes += c.length; });
    stream.on('end', () => { t.sent = Date.now(); });
    stream.on('error', (e) => { req.destroy(e); finish({ ok: false, error: `read error: ${e.message}` }); });
    stream.pipe(req);
  });
}

function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { agent: false, headers: BASE_HEADERS }, (res) => {
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

// Follows each uploaded clip's R2 and Drive legs on the website until both
// are done (or the poll window closes). One loop for all clips, in parallel.
async function pollOneClipStatus(server, job) {
  job.lastPolledAt = Date.now();
  const r = await getJson(`${server}${STATUS_PATH}${encodeURIComponent(job.clipId)}`);
  if (!r) { noteNetworkOutcome(false, 'status poll got no answer'); return; }
  noteNetworkOutcome(true);
  if (r.status !== 200 || !r.json || !r.json.success) return;
  const d = r.json;
  if (d.deleted) { markDeletedOnWebsite(job); return; }
  const prevR2 = job.r2Status;
  const prevDrive = job.driveStatus;
  const patch = { r2Status: d.r2Status || job.r2Status, driveStatus: d.driveStatus || job.driveStatus, serverStatus: d.status };
  if (patch.r2Status === 'uploaded' && prevR2 !== 'uploaded') console.log(`☁️  [POINT] ${job.clipId}: R2 COMPLETE`);
  if (patch.driveStatus === 'uploaded' && prevDrive !== 'uploaded') console.log(`📁 [POINT] ${job.clipId}: DRIVE COMPLETE`);
  if (d.status === 'NEEDS_REUPLOAD') {
    if (verifyLocalFile(job)) {
      console.log(`🔁 [POINT] ${job.clipId}: website lost its copy — re-sending the local clip`);
      update(job, { ...patch, status: 'SYNC_RETRY', syncAttempts: 0, error: 'website restarted — re-sending clip', nextUploadAt: Date.now() });
      queueSync(job);
      return;
    }
    update(job, { ...patch, status: 'CUT_FAILED', error: 'website lost its copy and the local clip file is missing' });
    return;
  }
  // (a leg the website has not set up counts as done — its status route says so)
  const bothDone = patch.r2Status === 'uploaded' && patch.driveStatus === 'uploaded';
  const driveGaveUp = d.status === 'FAILED_PERMANENT' && patch.r2Status === 'uploaded';
  if (bothDone || driveGaveUp) {
    update(job, { ...patch, driveBackupFailed: !!driveGaveUp && patch.driveStatus !== 'uploaded' });
    if (['SENT', 'SYNC_RETRY'].includes(job.status)) markComplete(job);
    return;
  }
  if (d.status === 'FAILED_PERMANENT') {
    update(job, { ...patch, status: 'SYNC_RETRY', error: d.permanentFailureReason || 'website could not store the clip' });
    if (!job.nextUploadAt || job.nextUploadAt < Date.now()) {
      const delay = syncBackoffMs((job.syncAttempts || 1) + 1);
      update(job, { nextUploadAt: Date.now() + delay });
      later(() => queueSync(job), delay);
    }
    return;
  }
  update(job, patch);
}

let statusPollRunning = false;
async function statusPollTick() {
  if (statusPollRunning || stopping) return;
  const server = websiteOrigin();
  if (!server) return;
  statusPollRunning = true;
  try {
    if (net.online === false) return;
    const due = [...jobs.values()]
      .filter((j) => ['SENT', 'SYNC_RETRY'].includes(j.status) && j.uploadedAt && Date.now() - j.uploadedAt < STATUS_POLL_WINDOW_MS)
      .sort((a, b) => (a.lastPolledAt || 0) - (b.lastPolledAt || 0));
    await Promise.all(due.slice(0, STATUS_POLL_BATCH).map((job) => pollOneClipStatus(server, job).catch(() => {})));
  } finally {
    statusPollRunning = false;
  }
}
every(() => { statusPollTick().catch(() => {}); }, STATUS_POLL_INTERVAL_MS);

// ----------------------------------------------------------------
// 🌐 HTTP API (volleyball panel / Clipper page ↔ this program), localhost.
// ----------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome (Private/Local Network Access): an https:// panel calling http://localhost.
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
<html><head><meta charset="UTF-8"><title>Volleyball Clipper — Setup</title>
<style>
  body{ font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif; background:#0b0f1a; color:#f2f4f8; margin:0; }
  .wrap{ max-width:540px; margin:40px auto; padding:0 20px; }
  h1{ font-size:18px; margin-bottom:4px; } p.sub{ color:#8892a6; font-size:13px; margin-top:0; }
  label{ display:block; font-size:12px; color:#8892a6; margin:16px 0 6px; }
  input[type=text]{ width:100%; box-sizing:border-box; padding:10px; border-radius:7px; border:1px solid #232c42; background:#182034; color:#f2f4f8; font-size:14px; }
  button{ margin-top:20px; width:100%; padding:12px; border-radius:8px; border:none; background:#22c55e; color:#06120a; font-weight:700; font-size:14px; cursor:pointer; }
  .msg{ margin-top:14px; padding:10px 12px; border-radius:7px; font-size:13px; background:rgba(34,197,94,.15); color:#22c55e; border:1px solid #22c55e; }
  .status{ margin-top:24px; font-size:12px; color:#8892a6; line-height:1.7; }
  .bad{ color:#f87171; } .good{ color:#22c55e; }
</style></head>
<body><div class="wrap">
  <h1>🏐 Volleyball Clipper — Setup</h1>
  <p class="sub">Ye VOLLEYBALL ka Clipper hai (cricket ka Clipper alag program hai). vMix recording ka folder bharo aur Save dabao.</p>
  ${message ? `<div class="msg">${message}</div>` : ''}
  <form method="POST" action="/setup">
    <label>vMix Recording — vMix jis folder (ya file) me record karta hai, uska poora path</label>
    <input type="text" name="recordingFile" value="${esc(config.vmixRecordingFile)}" placeholder="D:\\vMix Recordings">
    <label>Website URL — volleyball panel jis website par khulta hai (panel khud bhar deta hai)</label>
    <input type="text" name="websiteUrl" value="${esc(config.mainServerUrl || session.mainServerUrl)}" placeholder="https://allsportslivestreams.com">
    <button type="submit">💾 Save</button>
  </form>
  <div class="status">
    Recording: ${activeRecording ? `<span class="good">${esc(activeRecording.file)}</span> ${activeRecording.growing ? '(recording ✅)' : '(not growing — vMix not recording right now)'}` : `<span class="bad">${esc(recordingError || 'not found yet')}</span>`}<br>
    ${src && src.lastError ? `<span class="bad">Recording read error: ${esc(src.lastError)}</span><br>` : ''}
    Each point: ${PRE_ROLL_SECONDS} s before + ${POST_ROLL_SECONDS} s after = ${CLIP_SECONDS} s<br>
    Volleyball clips folder: ${esc(getClipsDir())}<br>
    Internet: ${net.online === false ? `<span class="bad">offline — clips are still cut and saved locally${pendingCount() ? `, ${pendingCount()} waiting to upload` : ''}</span>` : net.online ? '<span class="good">connected</span>' : 'checking…'}<br>
    Website: ${esc(websiteOrigin() || 'not set')} · Port ${config.port} · ${EXE_NAME} v${HELPER_VERSION}
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
  res.send(setupPageHtml('✅ Saved! Ab is tab ko band karke volleyball match shuru kar sakte ho.'));
});

function pointView(p) {
  if (!p) return null;
  const v = Object.assign({}, p);
  delete v.vbClipToken;
  return v;
}
function jobView(j) {
  const localSaved = !!(j.localPath && ['LOCAL_SAVED', 'OFFLINE_PENDING', 'SENDING', 'SENT', 'SYNC_RETRY', 'SYNC_COMPLETE'].includes(j.status));
  return {
    clipId: j.clipId, matchId: j.matchId, eventType: 'POINT', t0: j.t0, sport: 'volleyball',
    status: j.status, syncStatus: j.status, statusText: STATUS_TEXT[j.status] || j.status,
    offline: j.status === 'OFFLINE_PENDING',
    localSaved,
    error: j.error || null,
    cutAttempts: j.cutAttempts || 0,
    uploadAttempts: j.syncAttempts || 0,
    retryCount: j.retryCount || 0,
    nextUploadAt: j.nextUploadAt || null,
    clipSeconds: j.clipSeconds || null,
    localPath: j.localPath || null,
    filename: j.filename || null,
    links: (j.links || []).map((l) => ({ role: l.role, playerName: l.playerName, playerId: l.playerId || null, path: l.path, mode: l.mode })),
    highlightCategory: j.highlightCategory || null,
    r2Status: j.r2Status || null, driveStatus: j.driveStatus || null,
    websiteStatus: j.deletedOnWebsite ? 'deleted' : j.status === 'SYNC_COMPLETE' ? 'updated' : (j.websiteStatus || 'pending'),
    driveBackupFailed: !!j.driveBackupFailed,
    deletedOnWebsite: !!j.deletedOnWebsite,
    createdAt: j.createdAt, updatedAt: j.updatedAt, syncedAt: j.syncedAt || null,
    point: pointView(j.point),
    window: { preRollSec: j.preRollSec, postRollSec: j.postRollSec, actualPreRollSec: j.actualPreRollSec != null ? j.actualPreRollSec : null, partialPreRoll: !!j.partialPreRoll },
    sourceRecording: j.sourceRecording || null,
  };
}

app.get('/status', async (req, res) => {
  const rec = activeRecording;
  const src = rec ? sourceFor(rec.file) : null;
  const all = [...jobs.values()];
  const count = (...s) => all.filter((j) => s.includes(j.status)).length;
  const timing = { beforeSeconds: PRE_ROLL_SECONDS, afterSeconds: POST_ROLL_SECONDS, durationSeconds: CLIP_SECONDS };
  res.json({
    running: true,
    app: 'volleyball-clipper',      // not the Cricket Clipper (that one answers on :5005)
    exe: EXE_NAME,
    helperVersion: HELPER_VERSION,
    volleyball: true,
    sport: 'volleyball',
    version: 5,
    matchId: session.matchId,
    matchLabel: session.matchLabel || null,
    mainServerUrl: websiteOrigin() || null,
    recordingStartedAt: session.recordingStartedAt,
    vmixRecordingFile: config.vmixRecordingFile,
    vmixRecordingFolder: recordingDir(),
    currentRecordingFile: rec ? rec.file : null,
    recordingGrowing: !!(rec && rec.growing),
    recordingSeconds: src ? Math.round(src.durationSec) : null,
    recordingError: recordingError || (src && src.lastError) || null,
    recordingAmbiguous: recordingAmbiguous,
    recordingModifiedAt: rec ? rec.mtimeMs : null,
    clipsDir: getClipsDir(),
    matchClipsFolder: session.matchId ? files.matchRootFor(getClipsDir(), matchMetaFromSession()) : null,
    clipTiming: timing,
    volleyballClipTiming: timing,
    online: net.online,
    onlineCheckedAt: net.lastCheckAt || null,
    onlineError: net.online ? null : net.lastError,
    cutQueueLength: cutQueue.length + (cutRunning ? 1 : 0),
    uploadQueueLength: syncQueue.length + syncRunning,
    pendingSyncCount: all.filter(isUnsynced).length,
    offlinePendingCount: count('OFFLINE_PENDING'),
    syncedCount: count('SYNC_COMPLETE'),
    clipsOk: all.filter((j) => j.localPath && isUnsynced(j)).length + count('SYNC_COMPLETE'),
    failedClipsCount: count('CUT_FAILED'),
    ffmpegChildren: children.size,
    pid: process.pid,
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
  });
});

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
  res.json({ failedClips: [...jobs.values()].filter((j) => j.status === 'CUT_FAILED').map(jobView) });
});

function matchMetaFromSession() {
  return {
    matchId: session.matchId,
    matchLabel: session.matchLabel || null,
    tournamentId: session.tournamentId || null,
    tournamentName: session.tournamentName || session.tournamentId || null,
  };
}

const NOT_CRICKET = 'This is the Volleyball Clipper — cricket clips are cut by the Cricket Clipper (ClipperHelper.exe on port 5005)';

// The volleyball panel hands over THIS match and the website when clipping starts.
app.post('/recording-start', async (req, res) => {
  const b = req.body || {};
  if (b.sport && b.sport !== 'volleyball') return res.status(400).json({ success: false, error: NOT_CRICKET });
  session.recordingStartedAt = Number(b.startedAt) || Date.now();
  if (b.matchId) session.matchId = idPart(b.matchId, 80);
  if (b.matchLabel !== undefined) session.matchLabel = text(b.matchLabel, 120);
  if (b.tournamentId !== undefined) session.tournamentId = text(b.tournamentId);
  if (b.tournamentName !== undefined) session.tournamentName = text(b.tournamentName);
  const origin = toOrigin(b.mainServerUrl);
  if (origin) session.mainServerUrl = origin;
  saveSession();
  console.log(`🔴 Volleyball clipping started${session.matchId ? ` (match ${session.matchId})` : ''} — website ${session.mainServerUrl || 'not set'}`);
  let clipsFolder = null;
  if (session.matchId) {
    try {
      clipsFolder = await files.ensurePointTree(getClipsDir(), matchMetaFromSession());
      console.log(`🗂️  Clip folders ready: ${clipsFolder}`);
    } catch (err) {
      console.log(`⚠️  Could not create the clip folders (${err.message}) — they are retried on the first clip`);
    }
  }
  probeInternet(true).catch(() => {});
  res.json({ success: true, clipsFolder, online: net.online, matchId: session.matchId, sport: 'volleyball' });
});
app.post('/recording-stop', (req, res) => {
  console.log('⏹  Volleyball clipping session stopped (points already sent are still cut and uploaded)');
  res.json({ success: true });
});

// POST /clip { sport:'volleyball', matchId, timestamp, clipId?, point:{ eventId, set,
// pointNo, team, score, … }, matchLabel?, tournamentId?, tournamentName? }
//
// One point = one clip. The clipId is "<matchId>_<the point's eventId>", so
// the same point arriving twice (the panel's outbox re-sending it, the
// Clipper page relaying it, a reconnect) is the SAME job, never a second cut.
// The window is frozen at the press. Written to disk before it is answered.
app.post('/clip', async (req, res) => {
  const b = req.body || {};
  if (b.sport !== 'volleyball') return res.status(400).json({ success: false, error: NOT_CRICKET });
  const matchId = idPart(b.matchId, 80);
  const point = cleanPoint(b.point);
  if (!matchId || !point.eventId) return res.status(400).json({ success: false, error: 'matchId and the point’s eventId are required' });
  const clipId = `${matchId}_${point.eventId}`;
  if (b.clipId && String(b.clipId) !== clipId) return res.status(400).json({ success: false, error: 'a point clip’s clipId is <matchId>_<eventId>' });
  const existing = jobs.get(clipId);
  if (existing) {
    applyPointMeta(existing, b.point);
    persistJobs();
    return res.json({ success: true, clipId, duplicate: true, status: existing.status, statusText: STATUS_TEXT[existing.status] || existing.status, recordingActive: !!existing.sourceFile, online: net.online });
  }
  const now = Date.now();
  let t0 = Number(b.timestamp);
  if (!Number.isFinite(t0) || t0 > now + 60000 || t0 < now - 12 * 60 * 60 * 1000) t0 = now;
  t0 = Math.round(t0);
  const job = {
    clipId, matchId, sport: 'volleyball', eventType: 'POINT', t0,
    preRollSec: PRE_ROLL_SECONDS, postRollSec: POST_ROLL_SECONDS,
    window: { startWall: t0 - PRE_ROLL_SECONDS * 1000, endWall: t0 + POST_ROLL_SECONDS * 1000 },
    clipStart: t0 - PRE_ROLL_SECONDS * 1000, clipEnd: t0 + POST_ROLL_SECONDS * 1000, timestamp: t0,
    tournamentId: text(b.tournamentId), tournamentName: text(b.tournamentName), matchLabel: text(b.matchLabel, 120),
    eventId: null, playerIds: [], sessionId: idPart(b.sessionId),
    localPath: null, localFilePath: null, filename: null, links: [],
    r2Status: 'pending', driveStatus: 'pending', websiteStatus: 'pending',
    cutOffline: net.online === false,
    status: 'WAITING', retryCount: 0, createdAt: now, updatedAt: now,
  };
  applyPointMeta(job, b.point);
  Object.assign(job, destinationsFor(job));
  job.sourceFile = activeRecording && activeRecording.growing ? activeRecording.file : null;
  jobs.set(clipId, job);
  const early = orphanMeta.get(clipId);   // the attribution arrived before the press did
  if (early) { orphanMeta.delete(clipId); applyPointMeta(job, early.point || early, { authoritative: true }); saveOrphanMeta(); }
  pruneJobs();
  flushJobsNow();   // on disk before it is acknowledged
  scheduleCut(job);
  const p = job.point;
  console.log(`📥 [POINT] ${clipId}: set ${p.set || '?'} point ${p.pointNo || '?'} to ${p.teamShort || p.teamName || p.team || '?'}${p.score ? ` (${p.score.A}-${p.score.B})` : ''} at ${new Date(t0).toLocaleTimeString()} — cutting ${PRE_ROLL_SECONDS}s before → ${POST_ROLL_SECONDS}s after${net.online === false ? ' (OFFLINE — cut and filed locally all the same)' : ''}`);
  res.json({ success: true, clipId, status: job.status, statusText: STATUS_TEXT[job.status], recordingActive: !!job.sourceFile, online: net.online, window: { preRollSec: PRE_ROLL_SECONDS, postRollSec: POST_ROLL_SECONDS } });
  files.ensurePointTree(getClipsDir(), { ...matchMetaFromSession(), matchId: job.matchId, matchLabel: job.matchLabel || session.matchLabel, tournamentName: job.tournamentName || session.tournamentName, tournamentId: job.tournamentId || session.tournamentId }).catch(() => {});
  if (!job.sourceFile) resolveActiveRecording().then((rec) => { if (rec && rec.growing && !job.sourceFile) job.sourceFile = rec.file; }).catch(() => {});
});

// The scorer's answer to "who earned this point?" (or a corrected one, or
// the point undone): re-file the clip under its players — the same file,
// never a re-cut. The website follows the point itself.
async function applyPointLate(job, payload) {
  const before = JSON.stringify([job.point && job.point.attribution, (job.point && job.point.players || []).map((x) => x.playerId), job.point && job.point.voided]);
  applyPointMeta(job, payload, { authoritative: true });
  const after = JSON.stringify([job.point.attribution, job.point.players.map((x) => x.playerId), job.point.voided]);
  if (before !== after && job.localPath && fs.existsSync(job.localPath)) {
    await organizeClipFiles(job);
    console.log(`🏷️  [POINT] ${job.clipId}: ${job.point.players.length ? job.point.players.map((x) => `#${x.number || '?'} ${x.name || x.playerId}`).join(', ') : 'team point (no player)'} → ${job.filename}`);
  }
  persistJobs();
  return job;
}
app.post('/clip-meta', async (req, res) => {
  const b = req.body || {};
  const clipId = String(b.clipId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clipId) return res.status(400).json({ success: false, error: 'clipId required' });
  const job = jobs.get(clipId);
  if (!job) {
    // Arrived before the press itself: remembered, applied when it shows up.
    orphanMeta.set(clipId, { ...b, receivedAt: Date.now() });
    saveOrphanMeta();
    return res.json({ success: true, clipId, pending: true });
  }
  await applyPointLate(job, b.point || b);
  res.json({ success: true, clipId, status: job.status, statusText: STATUS_TEXT[job.status] || job.status, filename: job.filename || null, point: pointView(job.point) });
});

// 🔁 A clip that could not be cut: try the SAME job again (same clipId,
// same frozen window — never a second clip). Only a failed job is touched.
app.post('/clip-retry', (req, res) => {
  const clipId = String((req.body && req.body.clipId) || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const job = jobs.get(clipId);
  if (!job) return res.status(404).json({ success: false, error: 'No clip job with that clipId' });
  if (job.status !== 'CUT_FAILED') return res.json({ success: true, clipId, status: job.status, statusText: STATUS_TEXT[job.status] || job.status, unchanged: true });
  if (job.localPath && fs.existsSync(job.localPath)) { adoptExistingClip(job); return res.json({ success: true, clipId, status: job.status }); }
  console.log(`🔁 [POINT] ${job.clipId}: retrying the cut (asked from the panel)`);
  update(job, { status: 'WAITING', cutAttempts: 0, error: null, failedAt: null });
  enqueueCut(job.clipId);
  res.json({ success: true, clipId, status: job.status, statusText: STATUS_TEXT[job.status] });
});

app.post('/sync-now', async (req, res) => {
  const online = await probeInternet(true).catch(() => false);
  const resumed = resumePendingSync('asked to sync now');
  res.json({ success: true, online, resumed, pending: [...jobs.values()].filter(isUnsynced).length });
});

// ⏹ STOP THIS PROGRAM — the volleyball panel's "Quit the Volleyball Clipper on this PC".
// This program ends ITSELF: its timers, its own ffmpeg processes and its
// port, the queue saved first. Nothing else on the PC is touched — not the
// Cricket Clipper, not vMix, not any other ffmpeg. A browser may ask only
// from the website this Clipper is set up for; the launcher
// (volleyball-clipper-launch.vbs, no Origin) always may.
app.post('/quit', (req, res) => {
  const origin = req.get('origin');
  if (origin && origin !== websiteOrigin()) return res.status(403).json({ success: false, error: 'Only the website this Clipper is set up for can stop it' });
  const unfinished = [...jobs.values()].filter(isUnsynced).length;
  res.json({ success: true, stopping: true, unfinished, pid: process.pid });
  setTimeout(() => shutdown('stopped from the panel'), 150);
});

// ----------------------------------------------------------------
// 🔄 STARTUP RECOVERY — every unfinished clip carries on from the stage it
// had reached; nothing is ever re-cut because the program restarted.
// ----------------------------------------------------------------
const OLD_PRESS_MS = 3 * 60 * 60 * 1000;
function resumeJobs() {
  let cuts = 0, ups = 0, adopted = 0, gone = 0, stale = 0;
  for (const job of jobs.values()) {
    if (job.localPath && !job.localFilePath) job.localFilePath = job.localPath;
    const fileThere = verifyLocalFile(job);
    if (job.status === 'SYNC_COMPLETE' || job.status === 'CUT_FAILED') continue;
    if (CUT_STATES.includes(job.status)) {
      if (!fileThere && Date.now() - (job.t0 || 0) > OLD_PRESS_MS) {
        job.status = 'CUT_FAILED';
        job.error = 'from an earlier session — that part of the recording is no longer available';
        stale++;
        continue;
      }
      if (fileThere) {
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
      job.syncAttempts = 0;
      job.status = 'LOCAL_SAVED';
      Object.assign(job, destinationsFor(job));
      queueSync(job);
      ups++;
    }
  }
  persistJobs();
  if (cuts || ups || stale) {
    console.log(`🔄 Resumed from last run: ${cuts} clip(s) still to cut, ${ups} waiting to upload${adopted ? ` (${adopted} already cut — reused as-is, NOT re-cut)` : ''}${gone ? `, ${gone} whose local file is gone` : ''}${stale ? `, ${stale} old point(s) from an earlier session closed` : ''}`);
  }
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

// 🧹 A clip cut but not moving for 10 minutes goes back in the upload queue.
const STALL_AFTER_MS = 10 * 60 * 1000;
every(async () => {
  if (stopping) return;
  const stalled = [...jobs.values()].filter((j) => SYNCABLE.includes(j.status) && Date.now() - (j.updatedAt || 0) > STALL_AFTER_MS && !syncQueue.includes(j.clipId));
  if (!stalled.length) return;
  await probeInternet(true).catch(() => {});
  if (net.online === false) return;
  console.log(`🧹 ${stalled.length} clip(s) had not moved for ${STALL_AFTER_MS / 60000} min — re-queuing their upload`);
  for (const job of stalled) { job.syncAttempts = 0; queueSync(job); }
}, 2 * 60 * 1000);

// 🩺 One line every 10 minutes.
every(() => {
  const all = [...jobs.values()];
  const count = (s) => all.filter((j) => j.status === s).length;
  const src = activeRecording ? sourceFor(activeRecording.file) : null;
  console.log(`[health] recording ${activeRecording ? `${path.basename(activeRecording.file)} ${src ? Math.round(src.durationSec / 60) : '?'}min${activeRecording.growing ? '' : ' (not growing)'}` : 'none'} | internet ${net.online === false ? 'OFFLINE' : net.online ? 'ok' : '?'} | cut queue ${cutQueue.length} | upload queue ${syncQueue.length + syncRunning} | offline-pending ${count('OFFLINE_PENDING')} | synced ${count('SYNC_COMPLETE')} | cut-failed ${count('CUT_FAILED')} | ffmpeg ${children.size} | mem ${Math.round(process.memoryUsage().rss / 1048576)}MB`);
}, 10 * 60 * 1000);

// A Cricket Clipper in this same folder means the two were mixed up —
// they still work (no file of one has the other's name), but say so.
if (fs.existsSync(path.join(BASE_DIR, 'ClipperHelper.exe')) || fs.existsSync(path.join(BASE_DIR, 'clipper-launch.vbs'))) {
  console.log('⚠️  This folder also has the CRICKET Clipper (ClipperHelper.exe / clipper-launch.vbs). Keep the Volleyball Clipper in its own folder.');
}

let listening = false;   // only the copy that opened the port owns the queue files
const server = app.listen(config.port, () => {
  listening = true;
  console.log('================================================');
  console.log(`🏐 ${APP_NAME} v${HELPER_VERSION} running at http://localhost:${config.port} (pid ${process.pid})`);
  console.log(`👉 Setup page: http://localhost:${config.port}/setup`);
  console.log(`Using ffmpeg: ${ffmpegPath}`);
  console.log(`Each point: ${PRE_ROLL_SECONDS}s of the rally before the press + ${POST_ROLL_SECONDS}s after = ${CLIP_SECONDS}s`);
  console.log(`Volleyball clips folder: ${getClipsDir()}`);
  console.log('Clips are cut and filed locally with NO internet; the upload happens whenever the connection is there.');
  console.log(`Website: ${websiteOrigin() || 'not set — start the Clipper from the volleyball panel'}`);
  if (!fs.existsSync(ffmpegPath)) {
    console.log(`⚠️  WARNING: ffmpeg not found — clips cannot be cut. Put ffmpeg.exe in the SAME folder as ${EXE_NAME}.`);
  }
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
  // Never linger without a port (a second copy, or something else on 5007):
  // a background program nobody can reach or stop is worse than none.
  if (err.code === 'EADDRINUSE') console.log(`❌ Port ${config.port} is already in use — is the Volleyball Clipper already running? This copy is closing.`);
  else console.log('❌ Server error:', err.message);
  shutdown('could not open its port', 1);
});

// ⏹ Clean exit: every timer, every ffmpeg THIS program started, the port;
// the queue saved. Unfinished clips carry on the next time it starts.
function shutdown(why, code = 0) {
  if (stopping) return;
  stopping = true;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  for (const t of intervals) clearInterval(t);
  intervals.clear();
  clearTimeout(jobsSaveTimer);
  for (const p of children) { try { p.kill('SIGKILL'); } catch (_) {} }
  // a copy that never got the port (one was already running) leaves that
  // one's queue file alone
  if (listening) flushJobsNow();
  console.log(`⏹  ${APP_NAME} stopped${why ? ` (${why})` : ''} — unfinished clips resume next time it starts.`);
  try { server.close(); } catch (_) { /* not listening */ }
  setTimeout(() => process.exit(code), 50);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => shutdown(`signal ${sig}`)); } catch (_) { /* not on this platform */ }
}
