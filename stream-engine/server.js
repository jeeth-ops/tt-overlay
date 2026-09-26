// ================================================================
// 🎥 AllSportsLive Stream Engine — LOCAL companion service, NATIVE
// CAPTURE ARCHITECTURE.
//
// Runs on the OPERATOR'S OWN PC, next to the Cricket Panel browser tab.
// NEVER deployed to Render.
//
// ⛔ THE OLD ARCHITECTURE (removed):
//   Camera+overlay window → browser getDisplayMedia() → MediaRecorder
//   (software VP8/WebM encode) → HTTP POST chunks → this process pipes
//   the raw bytes into ffmpeg's stdin.
//   That made the BROWSER the video encoder and the video transport —
//   exactly what a professional broadcast engine (vMix included) never
//   does, and it was the root cause of two real corruption bugs (see
//   git history / README "Root cause" section from the previous fix
//   pass) as well as the deeper architectural ceiling: browser DOM
//   rendering, tab throttling and JS-timer jitter are not a hardware
//   media clock.
//
// ✅ THE NEW ARCHITECTURE (this file):
//   live-output.html (camera <video> + cricket-overlay.html iframe,
//   UNCHANGED — it already composites camera+overlay into one rendered
//   window using the browser's own DOM/GPU compositor, exactly like an
//   OBS/vMix "Browser Source") is captured NATIVELY, at the OS level,
//   by ffmpeg itself:
//     - VIDEO: Windows GDI screen/window capture (`-f gdigrab
//       -i title=<window>`) reads that window's rendered pixels
//       directly — no browser video encode, no Blob, no WebM, no HTTP
//       chunk relay. ffmpeg owns capture timing end-to-end.
//     - AUDIO: the mic/capture-card device is opened directly by
//       ffmpeg (`-f dshow -i audio=<device>`) — the browser no longer
//       captures or relays production audio at all.
//   Two fully independent native ffmpeg processes each do their own
//   capture of the SAME window + SAME audio device (screen/window
//   capture is a shared OS resource, not an exclusive hardware device —
//   see stream-engine/README.md for why this is the safer design than
//   one process fanning out over a tee muxer/named pipe):
//     1. RECORDER  — gdigrab+dshow → NVENC (fixed high quality) →
//        StreamEngineData/Recordings/<matchId>/master.mp4. Completely
//        independent of YouTube/network — nothing about the live push
//        (ABR restarts, reconnects, crashes) ever touches this process.
//     2. LIVE ENCODER — gdigrab+dshow → NVENC (ABR-adaptive
//        bitrate/resolution) → YouTube RTMPS.
//   Clips are cut STRICTLY from master.mp4 (unchanged from the previous
//   fix pass — see cutLocalClip below) and forwarded to server.js's
//   EXISTING /api/clips/ingest → EXISTING Cloudflare/Drive/Mongo
//   pipeline (untouched).
//
// The browser's ONLY remaining jobs anywhere in this pipeline are:
//   (a) rendering camera+overlay pixels on screen for native capture to
//       read (live-output.html — an unavoidable "browser as a graphics
//       renderer" role, the same one OBS/vMix's own embedded-Chromium
//       Browser Source plays; NOT a video-transport role), and
//   (b) the Cricket Panel's controls/settings/status/clip-list UI,
//       talking to this engine over plain JSON HTTP.
// The browser never encodes video, never creates a video chunk, never
// POSTs video bytes anywhere, and is never the clip source.
//
// Render/server.js only ever receives: (a) short finished clip files
// via the existing /api/clips/ingest (small, ~20s files, not the
// continuous stream), and (b) score/control data via socket.io, exactly
// as before. The continuous 1080p YouTube feed never touches Render.
// ================================================================
const express = require('express');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

// 🗂️ LOCAL CLIP ORGANISER — reused, not reimplemented.
//
// clipper-helper/clipOrganizer.js already turns one freshly-cut clip into
// the broadcast-style tree the operator expects:
//
//     <Match>/Highlights/{4,6,Wickets,...}/   or  <Match>/Normal/
//     <Match>/Batsmen/<Player>/<1st-Innings>/
//     <Match>/Bowlers/<Player>/<1st-Innings>/
//     <Match>/metadata/<clipId>.json
//
// and it does so under two rules that are exactly what is wanted here:
// every decision comes from the event's OWN stored metadata (so it is
// identical offline), and there is ONE physical clip with hard links for
// the player views (so a 20s MP4 is not copied three times).
//
// The Stream Engine used to drop its clips flat into <matchId>/<clipId>.mp4
// with none of that, purely because this module lived next to the OTHER
// local helper. Requiring it here is what closes that gap without writing
// a second, divergent copy of the same rules.
//
// Loaded defensively: an operator who only copied stream-engine/ still gets
// working clips (flat, as before), just without the tree.
let clipOrganizer = null;
{
    // Resolved explicitly so the log can print the EXACT path that was
    // checked. The first version of this just said "not found", which is
    // the same message whether the file is genuinely missing, in the wrong
    // folder, or present but failing to load — and that is not enough to
    // fix it from a console line.
    const organizerPath = path.join(__dirname, '..', 'clipper-helper', 'clipOrganizer.js');
    try {
        clipOrganizer = require(organizerPath);
        console.log(`[stream-engine] \u2713 clip organiser loaded — clips will be filed into Highlights / Batsmen / Bowlers folders (${organizerPath})`);
    } catch (e) {
        const exists = fs.existsSync(organizerPath);
        console.log('[stream-engine] \u26a0 clip organiser NOT loaded — clips will be saved flat (no player/team tree).');
        console.log(`[stream-engine]   Looked for : ${organizerPath}`);
        console.log(`[stream-engine]   File there?: ${exists ? 'YES' : 'NO'}`);
        if (!exists) {
            console.log('[stream-engine]   Fix: the clipper-helper folder must sit NEXT TO stream-engine, not inside it:');
            console.log(`[stream-engine]        ${path.join(__dirname, '..')}\\clipper-helper\\clipOrganizer.js`);
        } else {
            // The file is there but would not load — a truncated/partial copy,
            // or an older Node. The real error is the only useful thing here.
            console.log(`[stream-engine]   The file IS there but failed to load: ${e.message}`);
        }
    }
}

const PORT = process.env.STREAM_ENGINE_PORT || 5006;
const CONFIG_FILE = path.join(__dirname, 'config.local.json'); // gitignored — never committed

// ----------------------------------------------------------------
// 🖥️ PLATFORM — native capture (gdigrab + dshow) is a Windows-specific
// ffmpeg capability, matching this engine's actual deployment target
// (the operator's Windows PC — see README/NVENC requirements below).
// macOS would need avfoundation, Linux would need x11grab/pulse/alsa —
// not implemented here. This is reported honestly via /status rather
// than silently attempting gdigrab/dshow and failing with a confusing
// ffmpeg error.
// ----------------------------------------------------------------
const NATIVE_CAPTURE_SUPPORTED = process.platform === 'win32';

// ----------------------------------------------------------------
// 🧪 NATIVE PROGRAM FEED (opt-in) — the new camera+overlay compositor
// pipeline (see nativePipeline.js/overlayBridge.js): native dshow camera
// capture + the overlay pulled via Chrome DevTools Protocol screencast
// (not screen/window capture at all), replacing gdigrab entirely for
// the actual program feed. This has NOT been field-verified the way the
// gdigrab path has (many rounds of real-hardware fixes — see this
// file's own history/README) — it was built and syntax-checked in an
// environment with no Windows machine, GPU, or camera to test against.
// Defaults OFF so the existing, working gdigrab path remains what
// actually runs unless explicitly opted into — set
// NATIVE_PROGRAM_FEED=true to try the new pipeline. GET /status reports
// which one is active. See stream-engine/README.md.
// ----------------------------------------------------------------
const NATIVE_PROGRAM_FEED = process.env.NATIVE_PROGRAM_FEED === 'true';
const nativePipeline = NATIVE_PROGRAM_FEED ? require('./nativePipeline') : null;
const { makeRepeatSuppressingLogger, setProcessPriority } = require('./nativePipeline');

// Set once a shutdown starts: every auto-restart/retry path checks it so
// a stop never turns into a restart loop.
let shuttingDown = false;

// ----------------------------------------------------------------
// 📁 WHERE RECORDINGS/CLIPS ACTUALLY LIVE — defaults to stream-engine's
// own folder (StreamEngineData/ right next to server.js), but set
// STREAM_ENGINE_DATA_ROOT to move it anywhere: a different drive, or
// just out from under wherever stream-engine itself happens to be
// installed. 🩹 CONFIRMED IN THE FIELD: installed under Downloads (a
// folder Windows/OneDrive commonly backs up/syncs by default), the
// master.mp4 recording — a large file under constant, rapid, active
// writes — got intermittently locked by that sync, surfacing as
// "Error opening output file" on the NEXT segment. Pointing this
// somewhere OneDrive doesn't touch (e.g. a folder directly on C:\, or a
// separate drive) avoids that class of failure entirely, and as a bonus
// lets the operator choose a drive with more free space for a full
// match's recording independent of wherever stream-engine itself sits.
// Operator-set via the panel's "Recordings Folder" field (POST
// /set-data-root below) persists into the same gitignored CONFIG_FILE
// the Stream URL/Key already use, so it survives a Stream Engine restart
// without needing the STREAM_ENGINE_DATA_ROOT env var edited by hand.
// The env var still wins if BOTH are set — it's the more explicit,
// deliberate override. Read directly here (loadConfig() isn't defined
// until further down) — same file, same shape, just an early raw read.
function readPersistedDataRoot() {
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return (cfg && typeof cfg.dataRoot === 'string' && cfg.dataRoot.trim()) ? cfg.dataRoot.trim() : null;
    } catch (e) {
        return null; // no config file yet, or unreadable — fall through to the default
    }
}
const DATA_ROOT_OVERRIDE = process.env.STREAM_ENGINE_DATA_ROOT || readPersistedDataRoot();
const DATA_ROOT = DATA_ROOT_OVERRIDE
    ? path.join(DATA_ROOT_OVERRIDE, 'StreamEngineData')
    : path.join(__dirname, 'StreamEngineData');

// ----------------------------------------------------------------
// ffmpeg/ffprobe resolution — the operator should never need to install
// ffmpeg system-wide or configure PATH by hand. Order of preference:
//   1. BUNDLED — stream-engine/bin/ffmpeg.exe (+ ffprobe.exe) shipped
//      alongside this app (see bin/README.md for exactly what to put
//      there; not committed to git — multi-hundred-MB binaries don't
//      belong in a repo). This is the intended path for a real install.
//   2. FFMPEG_PATH / FFPROBE_PATH env var — an explicit override for
//      development/testing against a different build.
//   3. a system `ffmpeg`/`ffprobe` already on PATH — last resort.
// Whichever wins, this must be a FULL build with hardware encoders —
// the minimal @ffmpeg-installer/ffmpeg npm package used elsewhere in
// this repo for clip cutting is built WITHOUT them and will NOT work
// here; relying on it here would silently mean "no NVENC ever". If
// nothing above has NVENC, /status reports that honestly rather than
// quietly falling back to CPU encoding.
// ----------------------------------------------------------------
function bundledBinPath(name) {
    return path.join(__dirname, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
}
function resolveFfmpegPath() {
    const bundled = bundledBinPath('ffmpeg');
    if (fs.existsSync(bundled)) return bundled;
    if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
    return 'ffmpeg'; // resolved via PATH by child_process
}
function resolveFfprobePath() {
    const bundled = bundledBinPath('ffprobe');
    if (fs.existsSync(bundled)) return bundled;
    if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) return process.env.FFPROBE_PATH;
    return 'ffprobe';
}
function resolvedBinSource(name, resolvedPath) {
    if (resolvedPath === bundledBinPath(name)) return 'bundled';
    if (resolvedPath === process.env[`${name.toUpperCase()}_PATH`]) return `${name.toUpperCase()}_PATH env var`;
    return 'system PATH';
}
const FFMPEG_PATH = resolveFfmpegPath();
const FFPROBE_PATH = resolveFfprobePath();
const FFMPEG_SOURCE = resolvedBinSource('ffmpeg', FFMPEG_PATH);
const FFPROBE_SOURCE = resolvedBinSource('ffprobe', FFPROBE_PATH);

// 🩹 CONFIRMED IN THE FIELD: on Windows, spawning a console-subsystem
// child process (ffmpeg.exe, powershell.exe) without windowsHide flashes
// a REAL, VISIBLE console window on screen for every single call — easy
// to mistake for a crash/spam bug. This was always true here, but used
// to be rare enough (ffmpeg only spawned at Go Live/Recording Start) to
// go unnoticed; it stopped being rare once /capture-preview and
// /program-feed-health started getting polled every ~2s by the panel's
// native preview (see startNativePreviewPolling in cricket-panel.html),
// which turned an occasional flash into a constant flood of popping
// ffmpeg console windows. Centralizing every ffmpeg spawn through these
// two wrappers means windowsHide is never something a new call site can
// forget to set (see resolveWindowTitle's own powershell spawn above
// for the same fix applied to that one manually).
//
// Every long-lived child is also registered in `childProcesses` (and its
// PID in CHILD_PIDS_FILE) so /status can report exactly what is running,
// shutdown can wait for / kill all of them, and a crashed previous run's
// orphans are reaped at the next startup (see reapOrphanedChildren).
const childProcesses = new Map(); // pid -> { proc, role, startedAt }
function spawnFfmpeg(args, opts = {}, role = 'ffmpeg') {
    const proc = spawn(FFMPEG_PATH, args, { ...opts, windowsHide: true });
    trackChild(proc, role);
    return proc;
}
function trackChild(proc, role) {
    if (!proc || !proc.pid) return;
    const pid = proc.pid;
    childProcesses.set(pid, { proc, role, startedAt: Date.now() });
    persistChildPidsSoon();
    proc.once('exit', () => {
        childProcesses.delete(pid);
        persistChildPidsSoon();
    });
}
// PIDs of every live child, written (debounced) so the NEXT run can reap
// them if this process dies without a clean shutdown — an ffmpeg left
// holding the camera/NVENC would otherwise make the next match's
// Recording/Go Live fail with "device busy".
const CHILD_PIDS_FILE = path.join(DATA_ROOT, 'child-pids.local.json');
let childPidsTimer = null;
function persistChildPidsSoon() {
    if (childPidsTimer) return;
    childPidsTimer = setTimeout(() => {
        childPidsTimer = null;
        const body = JSON.stringify({ ffmpegPath: FFMPEG_PATH, pids: [...childProcesses.keys()] });
        fs.mkdir(DATA_ROOT, { recursive: true }, () => fs.writeFile(CHILD_PIDS_FILE, body, () => {}));
    }, 1000);
}
function processIsAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Runs once at startup. Only kills a PID that is (still) an ffmpeg
// executable — never something that merely reused the PID.
function reapOrphanedChildren() {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(CHILD_PIDS_FILE, 'utf8')); } catch (e) { return; }
    const pids = (saved.pids || []).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid && processIsAlive(pid));
    if (!pids.length) return;
    const isOurFfmpeg = (exePath) => {
        if (!exePath) return false;
        const want = path.basename(saved.ffmpegPath || FFMPEG_PATH).toLowerCase().replace(/\.exe$/, '');
        return path.basename(exePath).toLowerCase().replace(/\.exe$/, '') === want;
    };
    const kill = (victims) => {
        for (const pid of victims) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ } }
        if (victims.length) console.log(`[startup] Cleaned up ${victims.length} ffmpeg process(es) left running by a previous Stream Engine session`);
    };
    if (process.platform === 'win32') {
        const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
        const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        ps.stdout.on('data', (d) => { out += d; });
        ps.on('error', () => {});
        ps.on('close', () => {
            const victims = out.split(/\r?\n/).map((l) => l.trim().split('|')).filter(([pid, exe]) => pid && isOurFfmpeg(exe)).map(([pid]) => Number(pid));
            kill(victims);
        });
    } else {
        kill(pids.filter((pid) => { try { return isOurFfmpeg(fs.readlinkSync(`/proc/${pid}/exe`)); } catch (e) { return false; } }));
    }
}
function spawnFfmpegSync(args, opts = {}) {
    return spawnSync(FFMPEG_PATH, args, { ...opts, windowsHide: true });
}
function spawnFfprobeSync(args, opts = {}) {
    return spawnSync(FFPROBE_PATH, args, { ...opts, windowsHide: true });
}

// ----------------------------------------------------------------
// 🔎 FFPROBE AVAILABILITY + FILE-INTEGRITY CHECK — ffprobe ships in the
// same "full" build as ffmpeg (see bin/README.md), so a missing ffprobe
// almost always means the bundled/pointed-at build is incomplete or the
// wrong one. Also used after a recording segment or clip finishes
// writing to catch a corrupted/incomplete MP4 (e.g. the process was
// killed mid-write, or the disk filled up partway through) BEFORE it's
// reported to the operator/uploaded as if it were a good file — a
// truncated/broken MP4 often still exists as a non-empty file on disk,
// so file size alone can't catch this.
// ----------------------------------------------------------------
let ffprobeAvailableCache = null;
function ffprobeAvailable() {
    if (ffprobeAvailableCache !== null) return ffprobeAvailableCache;
    try {
        const res = spawnFfprobeSync(['-version'], { encoding: 'utf8', timeout: 5000 });
        ffprobeAvailableCache = !res.error;
    } catch (e) {
        ffprobeAvailableCache = false;
    }
    return ffprobeAvailableCache;
}

// Verifies a finished MP4 actually has a valid, playable video stream
// with a real duration — not just "the file exists and is non-empty".
// Best-effort: if ffprobe itself isn't available, this can't verify
// anything and says so explicitly rather than silently assuming the
// file is fine. Asynchronous — used by the clip engine, which runs while
// the relay (~90 MB/s at 1080p) is flowing through this process; the old
// spawnSync version stalled the whole program feed once per clip.
function verifyMediaFileAsync(filePath, timeoutMs = 20000) {
    if (!ffprobeAvailable()) return Promise.resolve({ ok: null, reason: 'ffprobe not available — cannot verify file integrity (see bin/README.md)' });
    return new Promise((resolve) => {
        let st;
        try { st = fs.statSync(filePath); } catch (e) { return resolve({ ok: false, reason: 'file missing or empty' }); }
        if (!st.size) return resolve({ ok: false, reason: 'file missing or empty' });
        let out = '', err = '';
        const proc = spawn(FFPROBE_PATH, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', filePath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
        proc.stdout.on('data', (d) => { out += d; });
        proc.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
        proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: `ffprobe could not run: ${e.message}` }); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) return resolve({ ok: false, reason: `ffprobe could not read the file — likely corrupted/incomplete (${err.trim().slice(0, 200) || `exit ${code}`})` });
            try {
                const parsed = JSON.parse(out || '{}');
                const stream = (parsed.streams || [])[0];
                const durationSec = parseFloat(parsed.format && parsed.format.duration);
                if (!stream || !stream.width || !stream.height) return resolve({ ok: false, reason: 'no valid video stream found — likely corrupted/incomplete' });
                if (!Number.isFinite(durationSec) || durationSec <= 0) return resolve({ ok: false, reason: 'zero/invalid duration — likely truncated mid-write (crash or disk-full)' });
                resolve({ ok: true, width: stream.width, height: stream.height, durationSec });
            } catch (e) {
                resolve({ ok: false, reason: `verification threw: ${e.message}` });
            }
        });
    });
}

// Conservative low-disk threshold — below this, a recording/clip write
// in progress is at real risk of failing mid-write (a truncated/
// corrupted MP4 — see verifyMediaFile above) rather than failing
// cleanly, so it's worth warning well before the disk is actually full.
const LOW_DISK_WARNING_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveConfig(cfg) {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) { console.log('config save error:', e.message); }
}

// Matches are used to build folder/file names and gdigrab/dshow argv
// strings — never trust user input directly there.
function safeMatchId(id) {
    return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

// Stream key + stream URL live ONLY here: in-memory + this local
// gitignored file. The key is never returned in full by any endpoint
// (see /status below) and never passes through
// server.js/Render/Mongo/Socket.IO/localStorage — the panel POSTs it
// straight to this localhost process.
//
// The stream URL is NOT hardcoded to YouTube's endpoint — the operator
// enters it (and the key) in the panel, exactly as YouTube Studio (or
// any other RTMP(S)-based platform) shows them, and it's used verbatim.
// It's just a server address (no credentials embedded in the normal
// case), so unlike the key it's safe to echo back in full via /status.
let streamKey = loadConfig().streamKey || null;
let streamUrl = loadConfig().streamUrl || null;

function maskKey(key) {
    if (!key) return null;
    if (key.length <= 4) return '••••';
    return '••••••••' + key.slice(-4);
}

// Accepts only rtmp(s):// URLs — this is a live-video push destination,
// not a generic URL field. Doesn't assume any specific host: the
// operator can point this at YouTube, or any other RTMP(S) ingest.
function isValidRtmpUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /^rtmps?:\/\/[^\s]+$/i.test(url.trim());
}

// Joins the operator-provided "Stream URL" + "Stream Key" exactly the
// way YouTube/Twitch/Facebook's own two-field RTMP(S) forms do: server
// URL (no trailing slash) + '/' + key. The stream URL is used exactly
// as entered — no fixed YouTube endpoint is assumed here.
function buildDestinationUrl(url, key) {
    return `${url.replace(/\/+$/, '')}/${key}`;
}

// ----------------------------------------------------------------
// 🔎 NVENC AVAILABILITY CHECK — required before GO LIVE ever runs.
// Never defaults to libx264 if this comes back false; /go-live refuses
// to start instead.
// ----------------------------------------------------------------
let nvencCheckCache = null; // { available, checkedAt, detail }
function checkNvenc() {
    // A positive result can't change while this process runs, so it's
    // kept for good — re-probing every 30s (a blocking ffmpeg spawn on
    // every /status poll) stalled the event loop, and with it the relay.
    if (nvencCheckCache && (nvencCheckCache.available || Date.now() - nvencCheckCache.checkedAt < 30000)) return nvencCheckCache;
    let available = false, detail = '';
    try {
        const res = spawnFfmpegSync(['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
        if (res.error) {
            detail = `ffmpeg not found (${res.error.message}) — set FFMPEG_PATH to a full/NVIDIA ffmpeg build`;
        } else {
            const out = (res.stdout || '') + (res.stderr || '');
            available = /h264_nvenc/.test(out);
            detail = available ? 'h264_nvenc encoder found' : 'ffmpeg found but no h264_nvenc encoder — this build lacks NVIDIA support, or no compatible GPU/driver present';
        }
    } catch (e) {
        detail = e.message;
    }
    nvencCheckCache = { available, checkedAt: Date.now(), detail };
    return nvencCheckCache;
}

// ----------------------------------------------------------------
// 🔎 libx264 RUNTIME CHECK — CPU fallback path for the recorder/clip
// cutter if NVENC genuinely isn't usable on this machine. checkNvenc()
// above only confirms h264_nvenc is LISTED in this ffmpeg build; this
// actually runs a throwaway 0.1s encode, since a listed encoder can
// still crash the moment real work is asked of it.
// ----------------------------------------------------------------
let libx264CheckCache = null; // cached for the process lifetime — this doesn't change while running
function checkLibx264() {
    if (libx264CheckCache !== null) return libx264CheckCache;
    try {
        const res = spawnFfmpegSync([
            '-hide_banner', '-loglevel', 'error', '-y',
            // 256x256, not something tiny like 64x64 — hardware encoders
            // (see checkNvencRuntime below) reject frames smaller than
            // their minimum supported dimension with a real encode
            // error, which would show up here as a false "this machine
            // can't encode" even though it can. 256x256 is safely above
            // every known encoder's minimum while still being a
            // near-instant throwaway test.
            '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2',
            '-c:v', 'libx264', '-preset', 'ultrafast',
            '-f', 'null', '-',
        ], { timeout: 8000 });
        libx264CheckCache = !res.error && res.status === 0;
    } catch (e) {
        libx264CheckCache = false;
    }
    console.log(libx264CheckCache
        ? '[stream-engine] libx264 runtime check: ✅ working (only used as a last resort if NVENC is unavailable)'
        : '[stream-engine] libx264 runtime check: ❌ crashes on this machine — fine, NVENC is preferred anyway');
    return libx264CheckCache;
}

// checkNvenc() above only greps -encoders (fast, used for the /go-live
// preflight so a missing NVENC build is rejected instantly) — that can
// still be a false positive if the build lists h264_nvenc but it
// crashes/fails to init on this machine. This actually runs a throwaway
// encode, so the recorder/live-encoder/clip cutter can trust "NVENC
// available" here means it truly works, not just that it's compiled in.
let nvencRuntimeCheckCache = null;
function checkNvencRuntime() {
    if (nvencRuntimeCheckCache !== null) return nvencRuntimeCheckCache;
    if (!checkNvenc().available) { nvencRuntimeCheckCache = false; return false; }
    try {
        const res = spawnFfmpegSync([
            '-hide_banner', '-loglevel', 'error', '-y',
            // 🩹 256x256, NOT 64x64 — confirmed on real hardware
            // (NVIDIA RTX 3050 Laptop GPU) that NVENC rejects anything
            // below its minimum encode dimension with
            // "InitializeEncoder failed: invalid param (8): Frame
            // Dimension less than the minimum supported value", which
            // made this check report "NVENC not usable" on a GPU that
            // works completely fine — a false negative from the test
            // itself, not a real driver/GPU problem. 256x256 is safely
            // above every known NVENC generation's minimum while still
            // being a near-instant throwaway test.
            '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2',
            '-c:v', 'h264_nvenc', '-preset', 'p4',
            '-f', 'null', '-',
        ], { timeout: 8000 });
        nvencRuntimeCheckCache = !res.error && res.status === 0;
    } catch (e) {
        nvencRuntimeCheckCache = false;
    }
    console.log(nvencRuntimeCheckCache
        ? '[stream-engine] NVENC runtime check: ✅ working — the recorder and live encoder both use the GPU'
        : '[stream-engine] NVENC runtime check: ❌ not usable right now — falling back to libx264 (CPU)');
    return nvencRuntimeCheckCache;
}

// ----------------------------------------------------------------
// 🔎 GPU SCALE RUNTIME CHECK — item 5/42's GPU-first requirement for
// the crop/scale step between capture and encode. Prefers CUDA/NPP
// (hwupload_cuda + scale_npp, feeding NVENC hardware frames directly —
// no GPU->CPU->GPU round trip) over CPU swscale, but ONLY if a real
// throwaway encode through that exact filter chain actually works on
// this machine's ffmpeg build/driver — never assumed just because NVENC
// itself is available (scale_npp/hwupload_cuda need libnpp support
// specifically, which not every "NVENC-capable" ffmpeg build includes).
// Falls back to CPU swscale (still cheap — cropping/scaling a screen
// capture is not the expensive stage; ENCODING is, and that stays on
// the GPU either way) with a clearly logged reason, never silently.
// ----------------------------------------------------------------
let gpuScaleCheckCache = null;
function checkGpuScaleRuntime() {
    if (gpuScaleCheckCache !== null) return gpuScaleCheckCache;
    if (!checkNvencRuntime()) { gpuScaleCheckCache = false; return false; }
    try {
        const res = spawnFfmpegSync([
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=0.2',
            '-vf', 'hwupload_cuda,scale_npp=640:360',
            '-c:v', 'h264_nvenc', '-preset', 'p4',
            '-f', 'null', '-',
        ], { timeout: 8000 });
        gpuScaleCheckCache = !res.error && res.status === 0;
    } catch (e) {
        gpuScaleCheckCache = false;
    }
    console.log(gpuScaleCheckCache
        ? '[stream-engine] GPU scale runtime check: ✅ hwupload_cuda/scale_npp available — capture scaling runs on GPU'
        : '[stream-engine] GPU scale runtime check: ❌ not available on this ffmpeg/GPU build — using CPU swscale for the crop/scale step (encoding itself still runs on the GPU via NVENC)');
    return gpuScaleCheckCache;
}

// ----------------------------------------------------------------
// 🔎 NVENC "-tune ll" RUNTIME CHECK — buildLiveEncoderArgs (the Go Live
// path only; the recorder/clip cutter never pass -tune) adds '-tune ll'
// for low-latency mode, but checkNvencRuntime() above only ever tested
// '-preset p4' on its own. A build compiled against an older NVENC SDK
// (exactly the kind of "GPU scale not available on this ffmpeg/GPU
// build" ffmpeg seen in the field here) can happily pass that check yet
// have no '-tune' AVOption on h264_nvenc at all — so this was passing
// the preflight, then dying the instant Go Live actually spawned ffmpeg
// with "Unrecognized option 'tune'." / "Error splitting the argument
// list: Option not found", which isFatalError() then (see the
// FATAL_ERROR_PATTERN this failure now matches) correctly surfaces as
// crashed instead of spinning in the reconnect loop forever. Tested
// here, once, up front, so a build that can't take -tune simply never
// gets asked to.
// ----------------------------------------------------------------
let nvencTuneCheckCache = null;
function checkNvencTuneRuntime() {
    if (nvencTuneCheckCache !== null) return nvencTuneCheckCache;
    if (!checkNvencRuntime()) { nvencTuneCheckCache = false; return false; }
    try {
        const res = spawnFfmpegSync([
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2',
            '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll',
            '-f', 'null', '-',
        ], { timeout: 8000 });
        nvencTuneCheckCache = !res.error && res.status === 0;
    } catch (e) {
        nvencTuneCheckCache = false;
    }
    console.log(nvencTuneCheckCache
        ? '[stream-engine] NVENC "-tune ll" runtime check: ✅ supported — live encoder uses low-latency tuning'
        : '[stream-engine] NVENC "-tune ll" runtime check: ❌ not supported on this ffmpeg/NVENC build — live encoder will omit -tune');
    return nvencTuneCheckCache;
}

// ----------------------------------------------------------------
// 🔎 CFR FLAG RUNTIME CHECK — confirmed in the field: this ffmpeg build
// rejects the older global '-vsync cfr' outright with "Unrecognized
// option 'vsync'." (a genuinely different build than whatever the
// original '-vsync over -fps_mode for broad compatibility' comment was
// written against — evidently this one dropped the legacy alias and
// only understands the newer per-stream '-fps_mode cfr'). Same
// "don't guess, test once at startup" approach as checkNvencTuneRuntime
// above: try the modern flag first (it's been in ffmpeg since 5.1, long
// enough that a build new enough to have DROPPED '-vsync' certainly
// has it), fall back to the legacy one only if that itself somehow
// isn't recognized either.
// ----------------------------------------------------------------
let cfrFlagCache = null;
function cfrFlagArgs() {
    if (cfrFlagCache !== null) return cfrFlagCache;
    try {
        const res = spawnFfmpegSync([
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
            '-fps_mode', 'cfr',
            '-f', 'null', '-',
        ], { timeout: 8000 });
        cfrFlagCache = (!res.error && res.status === 0) ? ['-fps_mode', 'cfr'] : ['-vsync', 'cfr'];
    } catch (e) {
        cfrFlagCache = ['-vsync', 'cfr'];
    }
    console.log(`[stream-engine] CFR flag runtime check: using "${cfrFlagCache.join(' ')}" (whichever this ffmpeg build actually recognizes)`);
    return cfrFlagCache;
}

// Cached like checkNvenc: this used to spawn `ffmpeg -version`
// synchronously on EVERY /status poll for the whole match.
let ffmpegAvailableCache = null; // { ok, checkedAt }
function ffmpegAvailable() {
    if (ffmpegAvailableCache && (ffmpegAvailableCache.ok || Date.now() - ffmpegAvailableCache.checkedAt < 30000)) return ffmpegAvailableCache.ok;
    const res = spawnFfmpegSync(['-version'], { encoding: 'utf8', timeout: 5000 });
    ffmpegAvailableCache = { ok: !res.error, checkedAt: Date.now() };
    return ffmpegAvailableCache.ok;
}

// ----------------------------------------------------------------
// 🎙️📷 NATIVE DEVICE ENUMERATION — replaces the browser's own
// navigator.mediaDevices.enumerateDevices()/getUserMedia() for
// PRODUCTION audio AND (see listVideoDevices below, added for the
// native camera+overlay compositor) video: ffmpeg's dshow demuxer lists
// Windows capture devices the exact same way `ffmpeg -list_devices true
// -f dshow -i dummy` does from the command line (device names appear in
// quotes in stderr). One shared enumeration/cache for both — audio and
// video device lists come out of the SAME ffmpeg call, so listing both
// separately would just mean spawning it twice for identical output.
// GET /audio-devices populates the panel's microphone dropdown from
// this instead of a browser permission prompt — the browser no longer
// needs microphone access for the production audio pipeline at all.
// ----------------------------------------------------------------
let dshowDeviceCache = null; // { audio, video, checkedAt } — only ever set on a SUCCESSFUL (non-empty) listing, see below
function listDshowDevices() {
    if (!NATIVE_CAPTURE_SUPPORTED) return { audio: [], video: [], detail: `Native device listing needs Windows (dshow) — this process is running on ${process.platform}` };
    if (dshowDeviceCache && Date.now() - dshowDeviceCache.checkedAt < 15000) return { audio: dshowDeviceCache.audio, video: dshowDeviceCache.video, detail: null };
    try {
        // 🩹 Confirmed on real hardware: a machine with several virtual
        // audio devices installed (e.g. vMix's own virtual audio driver
        // — "vMix Audio - Bus C/D/E/F/G", "16Ch", etc. alongside a real
        // mic) can take noticeably longer than a bare machine to enumerate
        // every DirectShow device. The previous 8s timeout could cut
        // ffmpeg off mid-enumeration, silently returning zero devices
        // even though real ones exist — 20s gives real-world device
        // counts like this real headroom.
        const res = spawnFfmpegSync(['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8', timeout: 20000 });
        const out = (res.stdout || '') + (res.stderr || '');
        const audio = [];
        const video = [];
        // 🩹 ffmpeg changed this output format across versions — confirmed
        // on real hardware running ffmpeg 9.0.1: there is no longer a
        // "DirectShow audio/video devices" section header line at all;
        // instead every device line ends with an inline "(audio)" or
        // "(video)" tag, e.g. [in#0 @ ...] "Microphone (AVMATRIX USB
        // Capture Audio)" (audio). The OLD section-header format (ffmpeg
        // <9: a "DirectShow audio/video devices" heading, then bare
        // quoted names underneath, no inline tag) still exists on older
        // builds. Try the new inline-tag format FIRST since it's
        // unambiguous per-line; only fall back to the old section-based
        // parsing if that finds nothing, so both ffmpeg generations work.
        for (const line of out.split('\n')) {
            const audioMatch = /"([^"]+)"\s*\(audio\)/i.exec(line);
            if (audioMatch) audio.push(audioMatch[1]);
            const videoMatch = /"([^"]+)"\s*\(video\)/i.exec(line);
            if (videoMatch) video.push(videoMatch[1]);
        }
        if (!audio.length && !video.length) {
            let section = null; // 'audio' | 'video' | null
            for (const line of out.split('\n')) {
                if (/DirectShow audio devices/i.test(line)) { section = 'audio'; continue; }
                if (/DirectShow video devices/i.test(line)) { section = 'video'; continue; }
                if (section) {
                    const m = /"([^"]+)"/.exec(line);
                    if (m) (section === 'audio' ? audio : video).push(m[1]);
                }
            }
        }
        // Never cache an empty result — a timeout, a transient driver
        // hiccup, or ffmpeg being killed mid-enumeration would otherwise
        // "lock in" a false negative for 15s, so a real device is missed
        // even if the operator immediately clicks Refresh again.
        if (audio.length || video.length) dshowDeviceCache = { audio, video, checkedAt: Date.now() };
        if (!audio.length && !video.length && res.error) {
            return { audio: [], video: [], detail: `Device enumeration didn't finish in time (${res.error.code === 'ETIMEDOUT' ? 'timed out' : res.error.message}) — click Refresh Device List to try again` };
        }
        return { audio, video, detail: (audio.length || video.length) ? null : 'ffmpeg ran but reported no DirectShow devices — check Windows sound/camera settings' };
    } catch (e) {
        return { audio: [], video: [], detail: e.message };
    }
}
function listAudioDevices() {
    const { audio, detail } = listDshowDevices();
    return { devices: audio, detail: audio.length ? null : detail };
}
// 🎥 Native camera enumeration for the camera+overlay compositor (see
// buildCompositorArgs) — this is the dshow device NAME ffmpeg opens
// directly (`-f dshow -i video="<name>"`), NOT a browser getUserMedia
// deviceId (those are profile-scoped and meaningless here — see the
// same lesson learned the hard way for the old gdigrab-window capture
// window's camera, documented in live-output.html's own comments).
function listVideoDevices() {
    const { video, detail } = listDshowDevices();
    return { devices: video, detail: video.length ? null : detail };
}

// ----------------------------------------------------------------
// 🌐 NETWORK REACHABILITY — a pre-flight check that this PC can
// actually open a connection to the stream destination's host before
// GO LIVE commits to it (catches "no internet", DNS failures, and a
// firewalled outbound port before ffmpeg wastes time retrying).
// Scheme-aware: rtmps:// gets a real TLS handshake (port 443 by
// default, WITH certificate hostname verification — the same check
// ffmpeg's own TLS stack effectively performs, so a mismatched
// hostname/cert here means the real stream would fail too); plain
// rtmp:// only gets a TCP connect (port 1935 by default) since there's
// no TLS/cert involved for that scheme. An explicit port in the URL
// always wins over these defaults.
// Cached briefly like the NVENC check, keyed by host+port so switching
// Stream URL re-checks the new destination.
// ----------------------------------------------------------------
let networkCheckCache = null; // { host, available, checkedAt, detail }
function checkNetwork(url) {
    return new Promise((resolve) => {
        let parsed;
        try { parsed = new URL(url); } catch (e) {
            return resolve({ available: false, detail: 'Invalid Stream URL' });
        }
        const host = parsed.hostname;
        const isTls = parsed.protocol === 'rtmps:';
        const port = parsed.port ? Number(parsed.port) : (isTls ? 443 : 1935);
        const cacheKey = `${host}:${port}`;
        if (networkCheckCache && networkCheckCache.key === cacheKey && Date.now() - networkCheckCache.checkedAt < 15000) {
            return resolve(networkCheckCache);
        }
        const onOk = () => {
            socket.destroy();
            const result = { key: cacheKey, host, available: true, checkedAt: Date.now(), detail: `Reached ${host}:${port}` };
            networkCheckCache = result;
            resolve(result);
        };
        const fail = (detail) => {
            socket.destroy();
            const result = { key: cacheKey, host, available: false, checkedAt: Date.now(), detail };
            networkCheckCache = result;
            resolve(result);
        };
        // rtmps:// verifies the certificate hostname (default
        // rejectUnauthorized), same as a real RTMPS push would — so a
        // hostname/cert mismatch is surfaced here, not discovered only
        // after GO LIVE. rtmp:// is plain TCP, no TLS involved.
        const socket = isTls
            ? tls.connect({ host, port, servername: host, timeout: 4000 }, onOk)
            : net.connect({ host, port, timeout: 4000 }, onOk);
        socket.on('timeout', () => fail(`Timed out reaching ${host}:${port}`));
        socket.on('error', (err) => fail(`Could not reach ${host}:${port} — ${err.message}`));
    });
}

// ----------------------------------------------------------------
// 🖥️ CPU / GPU UTILIZATION — cross-platform system CPU load (works on
// Windows, unlike os.loadavg() which is always [0,0,0] there), sampled
// as a delta between successive /health polls, plus best-effort GPU
// utilization via nvidia-smi. Purely informational — confirms the GPU
// is actually doing the heavy work (item 36/42's "don't just claim
// GPU-first, verify it"), not the CPU.
// ----------------------------------------------------------------
let lastCpuSample = null; // { idle, total }
function readCpuUtilization() {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
        for (const t of Object.values(cpu.times)) total += t;
        idle += cpu.times.idle;
    }
    if (!lastCpuSample) {
        lastCpuSample = { idle, total };
        return null; // no delta yet on the very first sample
    }
    const idleDelta = idle - lastCpuSample.idle;
    const totalDelta = total - lastCpuSample.total;
    lastCpuSample = { idle, total };
    if (totalDelta <= 0) return null;
    return Math.round((1 - idleDelta / totalDelta) * 100);
}
// Returns the most recent sample immediately and refreshes it in the
// background (at most every 5s). The old version ran nvidia-smi with
// spawnSync (up to 2s) on every /health poll, freezing the event loop —
// and therefore the relay feeding the recorder and live encoder.
let gpuSample = null;
let gpuSampleInFlight = false;
let gpuSampleAt = 0;
function readGpuUtilization() {
    if (!gpuSampleInFlight && Date.now() - gpuSampleAt > 5000 && gpuSample !== false) {
        gpuSampleInFlight = true;
        gpuSampleAt = Date.now();
        let out = '';
        let proc;
        try {
            proc = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,utilization.memory,utilization.encoder,utilization.decoder,memory.used,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) { gpuSampleInFlight = false; gpuSample = false; return null; }
        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 3000);
        proc.stdout.on('data', (d) => { out += d; });
        proc.on('error', () => { clearTimeout(timer); gpuSampleInFlight = false; gpuSample = false; }); // no nvidia-smi on this machine — stop trying
        proc.on('close', () => {
            clearTimeout(timer);
            gpuSampleInFlight = false;
            const [gpuPct, memPct, encPct, decPct, vramUsedMb, vramTotalMb] = out.trim().split(',').map((v) => parseFloat(v.trim()));
            if (!Number.isNaN(gpuPct)) gpuSample = { gpuPercent: gpuPct, gpuMemPercent: memPct, encoderPercent: encPct, decoderPercent: decPct, vramUsedMb, vramTotalMb, sampledAt: Date.now() };
        });
    }
    return gpuSample || null;
}

// ================================================================
// 📐 RESOLUTION / FPS PRESETS — operator picks a resolution (480p/720p/
// 1080p) and fps (30/60) in the panel; these map to actual pixel
// dimensions and a sane default CBR bitrate for that combo (standard
// YouTube Live recommendations). bitrateKbps can still be overridden
// explicitly if the panel sends one, but the table means a sensible
// value is always used even if it doesn't.
// ================================================================
const RESOLUTIONS = {
    '480p':  { width: 854,  height: 480 },
    '720p':  { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
};
const DEFAULT_BITRATE_KBPS = {
    '480p':  { 30: 2000,  60: 2500 },
    '720p':  { 30: 3500,  60: 5500 },
    '1080p': { 30: 6000,  60: 12000 },
};

// ================================================================
// 🪟 CAPTURE TARGET — the window ffmpeg's gdigrab reads from is
// live-output.html (UNCHANGED — see its own header comment), opened by
// the panel with document.title set to exactly this string so gdigrab's
// `-i title=...` can find it unambiguously. gdigrab captures the WHOLE
// window (including the OS title bar/borders, since there is no browser
// API to open a fully chromeless popup) — CAPTURE_CROP below strips a
// configurable margin before scaling to the target output resolution.
// Screen/window capture is a shared OS read (not an exclusive hardware
// device like a capture card), so two independent ffmpeg processes
// (recorder + live encoder) each capturing this same window is safe —
// see README "Why two processes, not one" for the reasoning.
// ================================================================
function windowTitleFor(matchId) {
    return `AllSportsLive-LiveOutput-${safeMatchId(matchId)}`;
}

// 🩹 EXACT WINDOW TITLE RESOLUTION — confirmed on real hardware: Chrome
// (like every major browser) appends " - Google Chrome" to a window's
// actual OS-level title bar text, on top of whatever document.title the
// page set — a window whose document.title is exactly
// "AllSportsLive-LiveOutput-<matchId>" really shows up to Windows as
// "AllSportsLive-LiveOutput-<matchId> - Google Chrome" (or " - Microsoft
// Edge", etc., depending on the browser). There is no web-page API to
// suppress this. gdigrab's own `-i title=...` needs the FULL, exact
// current title to find the window reliably — passing just the prefix
// worked once by pure timing luck (caught mid-launch, before the
// browser's own chrome finished attaching) and then consistently failed
// afterward, which is exactly the "works once, then can't find window"
// behavior seen in testing.
//
// Rather than guess every browser's suffix format, this asks Windows
// itself for the real, current title of whatever window matches our
// prefix and hands ffmpeg that EXACT string. If resolution fails
// (PowerShell unavailable, or no matching window), falls back to the
// bare prefix — gdigrab then still gets a sensible attempt and its own
// real error surfaces normally.
//
// 🩹 CONFIRMED ON REAL HARDWARE — this used to walk Get-Process and read
// each process's .MainWindowTitle, which looked reasonable but is the
// wrong tool for a browser: Chrome runs every top-level window it owns
// (the operator's normal multi-tab browser window AND this Live Output
// popup) under the SAME browser process, and .NET's MainWindowTitle
// only ever reports ONE window's title per process — effectively
// whichever window last had the OS's attention, not necessarily this
// popup. That made the lookup pass only when Live Output happened to be
// the frontmost/most-recently-focused Chrome window at the exact moment
// Preview/Go Live was clicked, and silently fall back to the bare
// prefix (which gdigrab then can't find either — "Can't find window")
// the rest of the time, even with Live Output genuinely open on screen.
// EnumWindows walks every visible top-level window system-wide
// regardless of which process "owns" it for MainWindowTitle purposes,
// so it finds the popup whether or not it currently has focus.
// -EncodedCommand (base64 UTF-16LE) avoids all cmd/PowerShell quoting
// pitfalls for the prefix string.
const ENUM_WINDOWS_PS_TEMPLATE = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class TTOverlayWin32 {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
"@
$found = $null
$callback = {
    param($hWnd, $lParam)
    if ([TTOverlayWin32]::IsWindowVisible($hWnd)) {
        $len = [TTOverlayWin32]::GetWindowTextLength($hWnd)
        if ($len -gt 0) {
            $sb = New-Object System.Text.StringBuilder ($len + 1)
            [TTOverlayWin32]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
            $title = $sb.ToString()
            if ($title -like '*__PREFIX__*') { $script:found = $title }
        }
    }
    return $true
}
[TTOverlayWin32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
if ($found) { Write-Output $found }
`;

// 🩹 CONFIRMED IN THE FIELD: restarting stream-engine.js (e.g. to pick
// up a code/flag change) does NOT close a dedicated capture window it
// previously launched — that's a completely separate OS process, and
// the new Node process has no memory of it (captureWindow.proc resets
// to null on every restart). If the operator then triggers another
// launch, Chrome/Edge's single-instance-per-user-data-dir lock means
// the "new" launch can just get absorbed into the ALREADY-RUNNING old
// window/process instead of actually starting a fresh one — so a flag
// change (like the DirectCompositionVideoOverlays fix) silently never
// takes effect until that stale process is gone, which looked exactly
// like "I redeployed and restarted but it's still broken." This finds
// any visible window whose title matches this match's expected prefix
// and force-closes its OWNING PROCESS — scoped to the exact
// "AllSportsLive-LiveOutput-<matchId>" title, so it can never touch the
// operator's regular browser windows/tabs, which have their own,
// different titles.
const CLOSE_WINDOW_BY_TITLE_PS_TEMPLATE = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class TTOverlayWin32Close {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
"@
$procIds = New-Object 'System.Collections.Generic.List[uint32]'
$callback = {
    param($hWnd, $lParam)
    if ([TTOverlayWin32Close]::IsWindowVisible($hWnd)) {
        $len = [TTOverlayWin32Close]::GetWindowTextLength($hWnd)
        if ($len -gt 0) {
            $sb = New-Object System.Text.StringBuilder ($len + 1)
            [TTOverlayWin32Close]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
            $title = $sb.ToString()
            if ($title -like '*__PREFIX__*') {
                [uint32]$procId = 0
                [TTOverlayWin32Close]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
                if ($procId -ne 0) { $procIds.Add($procId) }
            }
        }
    }
    return $true
}
[TTOverlayWin32Close]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
foreach ($procId in $procIds) {
    try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
}
`;
function closeStaleCaptureWindowByTitle(matchId) {
    if (!NATIVE_CAPTURE_SUPPORTED) return;
    const prefix = windowTitleFor(matchId);
    try {
        const script = CLOSE_WINDOW_BY_TITLE_PS_TEMPLATE.replace('__PREFIX__', prefix);
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 5000, windowsHide: true });
    } catch (e) {
        console.log(`[stream-engine] closeStaleCaptureWindowByTitle: powershell lookup threw (${e.message}) — a stale window/process for "${prefix}" may still be running`);
    }
}

// 🩹 CONFIRMED IN THE FIELD: closeStaleCaptureWindowByTitle above only
// finds a stale process if its window has ALREADY set a matching title
// — a process that crashed/got stuck BEFORE live-output.html's script
// ran far enough to set document.title (a bad launch, an early JS
// error, a page that never finished loading) is invisible to that
// title search entirely, yet still holds Chrome/Edge's single-instance
// lock on CAPTURE_PROFILE_DIR — so every subsequent launch attempt gets
// silently forwarded to that stuck process and exits almost instantly
// (code=0, no error) instead of actually starting fresh, no matter how
// many times the operator retries. This is a much stronger guarantee:
// it kills ANY process (titled or not, visible or not, however stuck)
// whose command line references our exact isolated profile directory —
// nothing else on the operator's PC would ever have that exact argument,
// so this can never touch their regular browser. A short sleep after
// the kill loop (inside the SAME script, not a separate JS-level delay)
// gives Windows a moment to fully release the process's handles/lock
// before this function returns and launchCaptureWindow spawns the next
// one.
function closeStaleCaptureWindowByProfile() {
    if (!NATIVE_CAPTURE_SUPPORTED) return;
    try {
        const escapedProfileDir = CAPTURE_PROFILE_DIR.replace(/'/g, "''");
        const script = `
$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*--user-data-dir=${escapedProfileDir}*' } | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Milliseconds 400
`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 8000, windowsHide: true });
    } catch (e) {
        console.log(`[stream-engine] closeStaleCaptureWindowByProfile: powershell threw (${e.message}) — a stuck process on the capture profile may still be holding its single-instance lock`);
    }
}
// 🩹 Short-TTL cache, keyed by matchId — resolveWindowTitle() is now
// called far more often than it used to be (the native preview image +
// program-feed health badge in the panel poll /capture-preview and
// /program-feed-health every ~2s, and BOTH call this), and each call
// spawns a real powershell.exe process (up to 5s). Without this cache
// that's two fresh PowerShell spawns every 2 seconds, indefinitely,
// for as long as Live Studio is open — needless CPU/process overhead,
// and (worse, confirmed in the field) a VISIBLE flashing console window
// stealing focus repeatedly right when the operator might be trying to
// click "Allow" on the camera permission prompt. The window's exact
// title barely ever changes within a few seconds of real time, so a
// short cache costs nothing operationally.
const windowTitleCache = new Map(); // matchId -> { title, resolvedAt }
const WINDOW_TITLE_CACHE_TTL_MS = 4000;

function resolveWindowTitle(matchId) {
    const cached = windowTitleCache.get(matchId);
    if (cached && Date.now() - cached.resolvedAt < WINDOW_TITLE_CACHE_TTL_MS) return cached.title;

    const prefix = windowTitleFor(matchId);
    let title;
    try {
        const script = ENUM_WINDOWS_PS_TEMPLATE.replace('__PREFIX__', prefix);
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const res = spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
        ], {
            encoding: 'utf8', timeout: 5000,
            // 🩹 CONFIRMED IN THE FIELD: without this, every single call
            // here flashes a real, visible "Windows PowerShell" console
            // window on screen (Node's child_process shows a console for
            // a console-subsystem child unless told not to) — easy to
            // mistake for a crash/spam bug when it's actually just this
            // lookup running normally, especially now that it runs every
            // few seconds while Live Studio is open (see the cache above).
            windowsHide: true,
        });
        title = (res.stdout || '').trim();
        if (!title) {
            const reason = res.error ? res.error.message : (res.stderr || '').trim().slice(0, 300) || 'no visible window title matched';
            console.log(`[stream-engine] resolveWindowTitle: could not resolve exact title for "${prefix}" (${reason}) — falling back to bare prefix; gdigrab will likely report "Can't find window" if the Live Output window isn't actually open`);
        }
        title = title || prefix;
    } catch (e) {
        console.log(`[stream-engine] resolveWindowTitle: powershell lookup threw (${e.message}) — falling back to bare prefix for "${prefix}"`);
        title = prefix;
    }
    windowTitleCache.set(matchId, { title, resolvedAt: Date.now() });
    return title;
}

// Configurable because exact OS title-bar/border pixel height varies by
// Windows version, display scaling (DPI) and theme — values here are a
// reasonable Windows 10/11 @100% DPI default; GET/POST /capture-config
// lets the operator tune them, and GET /capture-preview (below) lets
// them SEE the effect before going live, since this is exactly the kind
// of platform detail that can't be verified without the real machine.
let captureConfig = Object.assign(
    { cropTop: 32, cropBottom: 0, cropLeft: 0, cropRight: 0 },
    loadConfig().captureConfig || {}
);
function saveCaptureConfig() { saveConfig({ ...loadConfig(), captureConfig }); }

function cropScaleFilter(width, height, useGpuScale) {
    const { cropTop, cropBottom, cropLeft, cropRight } = captureConfig;
    const needsCrop = cropTop || cropBottom || cropLeft || cropRight;
    const cropExpr = needsCrop
        ? `crop=iw-${cropLeft + cropRight}:ih-${cropTop + cropBottom}:${cropLeft}:${cropTop},`
        : '';
    // GPU path: crop stays on CPU (cheap — just a pointer/stride
    // adjustment, not real pixel work) then uploads once to the GPU for
    // scaling + encode, avoiding a GPU->CPU->GPU round trip for the
    // actual resize. CPU fallback: plain swscale, still cheap relative
    // to the encode stage that follows (which is GPU either way via
    // NVENC) — see checkGpuScaleRuntime.
    return useGpuScale
        ? `${cropExpr}hwupload_cuda,scale_npp=${width}:${height}`
        : `${cropExpr}scale=${width}:${height}:flags=lanczos`;
}

// ================================================================
// 🩺 PROGRAM FEED HEALTH CHECK — samples the SAME gdigrab capture that
// feeds the recorder/live encoder/preview and asks: are these actually
// valid pixels? A window gdigrab can technically "find" (so it never
// hits WINDOW_NOT_FOUND_PATTERN below) can still hand back a completely
// black or completely white surface — e.g. a GPU-composited Chromium
// window BitBlt can't read correctly (see launchCaptureWindow further
// down), or a camera permission prompt covering the frame — and neither
// of those look like an ffmpeg *error* at all: ffmpeg happily encodes
// and streams the wrong picture. This runs a short, real capture
// through ffmpeg's own battle-tested blackdetect/freezedetect analysis
// filters (no hand-rolled pixel math) so a blank feed is caught and
// refused BEFORE it reaches YouTube or master.mp4 — see /go-live and
// monitorProgramFeedHealth below for where this actually gates/watches.
//
// "White" detection reuses blackdetect on a negated copy of the same
// frames (negate flips near-white pixels to near-black) rather than a
// second hand-rolled threshold check — one well-tested filter, run
// twice in the same filter graph, at fixed positions 0 (original —
// real black) and 2 (post-negate — real white).
// ================================================================
const HEALTH_CHECK_DURATION_SEC = 1.4;
const HEALTH_CHECK_BLACK_PIX_TH = 0.10;
const HEALTH_CHECK_MIN_BAD_DURATION = 0.9; // must be black/white for nearly the WHOLE sample, not just a transient flash/cut, to fail the gate

function sumNamedFilterDurations(stderr, filterInstanceName, metricName) {
    const re = new RegExp(`\\[${filterInstanceName} @[^\\]]*\\][^\\n]*${metricName}:\\s*([\\d.]+)`, 'g');
    let total = 0;
    let m;
    while ((m = re.exec(stderr))) total += parseFloat(m[1]);
    return total;
}

function parseHealthCheckStderr(stderr) {
    // Matched by the EXPLICIT filter@name given in runProgramFeedHealthCheck
    // (feedblack/feedwhite/feedfreeze) — not by ffmpeg's default
    // "Parsed_<filter>_<N>" positional auto-numbering, which shifts
    // depending on how many filter stages (crop, scale) come before these
    // in the graph and is therefore not a safe thing to infer from.
    const blackDuration = sumNamedFilterDurations(stderr, 'feedblack', 'black_duration');
    const whiteDuration = sumNamedFilterDurations(stderr, 'feedwhite', 'black_duration');
    const frozen = /\[feedfreeze @[^\]]*\][^\n]*freeze_start|lavfi\.freezedetect\.freeze_start/.test(stderr);
    return {
        black: blackDuration >= Math.min(HEALTH_CHECK_MIN_BAD_DURATION, HEALTH_CHECK_DURATION_SEC * 0.7),
        white: whiteDuration >= Math.min(HEALTH_CHECK_MIN_BAD_DURATION, HEALTH_CHECK_DURATION_SEC * 0.7),
        frozen,
    };
}

function runProgramFeedHealthCheck({ windowTitle, width, height, fps }) {
    return new Promise((resolve) => {
        if (!NATIVE_CAPTURE_SUPPORTED) return resolve({ ok: true, skipped: true, reason: 'not Windows' });
        // CPU-simple crop/scale (useGpuScale=false) — this is a 1.4s
        // throwaway diagnostic sample, not the real encode path; no need
        // to exercise the GPU scale path here (same reasoning as
        // /capture-preview's useGpuScale=false).
        //
        // 🩹 Each analysis filter is given an explicit name via ffmpeg's
        // `filter@name` syntax (feedblack/feedwhite/feedfreeze) instead of
        // being left to ffmpeg's default "Parsed_<filter>_<N>" auto-
        // numbering. That default numbers filters by their position in
        // the WHOLE graph — including cropScaleFilter's own crop/scale
        // steps ahead of these, which shifts depending on captureConfig
        // (crop is skipped entirely when its margins are all 0) — so
        // inferring "the two blackdetect instances, in ascending order"
        // from whichever ones happen to log is NOT reliable: if only the
        // WHITE check (the one after negate) trips, it can be the only
        // one present, and would get misread as the black check. Explicit
        // names remove the ambiguity entirely — see parseHealthCheckStderr.
        const filter = `${cropScaleFilter(width, height, false)},blackdetect@feedblack=d=0.2:pix_th=${HEALTH_CHECK_BLACK_PIX_TH},negate,blackdetect@feedwhite=d=0.2:pix_th=${HEALTH_CHECK_BLACK_PIX_TH},freezedetect@feedfreeze=n=0.004:d=0.5`;
        const args = [
            '-hide_banner', '-loglevel', 'info', '-nostats',
            '-f', 'gdigrab', '-framerate', String(Math.min(Number(fps) || 30, 15)),
            '-t', String(HEALTH_CHECK_DURATION_SEC),
            '-i', `title=${windowTitle}`,
            '-vf', filter,
            '-an', '-f', 'null', '-',
        ];
        const proc = spawnFfmpeg(args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ } }, (HEALTH_CHECK_DURATION_SEC + 5) * 1000);
        proc.on('exit', (code) => {
            clearTimeout(timer);
            if (WINDOW_NOT_FOUND_PATTERN.test(stderr)) {
                return resolve({ ok: false, error: 'Live Output window not found — open it before checking the program feed', black: false, white: false, frozen: false });
            }
            if (code !== 0) {
                return resolve({ ok: false, error: `Could not sample the program feed (ffmpeg exit ${code}): ${stderr.slice(-300) || 'no output'}`, black: false, white: false, frozen: false });
            }
            const { black, white, frozen } = parseHealthCheckStderr(stderr);
            resolve({ ok: !black && !white, black, white, frozen, checkedAt: Date.now() });
        });
        proc.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message, black: false, white: false, frozen: false }); });
    });
}

// ================================================================
// 🪟 DEDICATED CAPTURE WINDOW — launches live-output.html in its OWN,
// isolated Chromium process instead of a window.open() popup out of the
// operator's regular Cricket Panel browser tab.
//
// ROOT CAUSE THIS FIXES: gdigrab captures via classic Windows GDI
// BitBlt, which reads a window's on-screen bitmap. A normal GPU-
// accelerated Chromium window composites through DirectComposition —
// the real pixels live in a swapchain BitBlt cannot read — so BitBlt
// gets back whatever's behind/around that swapchain, typically a solid
// white or black rectangle, even though a human looking at the SAME
// window on screen sees it rendering perfectly correctly (a human sees
// the real GPU compositor's output; gdigrab does not — this is a known
// Chromium/GDI incompatibility, not a bug in this file's crop/scale
// math). window.open() out of an already-running browser process can
// never fix this: Chromium flags only take effect when a NEW process
// launches, and the operator's regular browser tab already launched
// with GPU compositing on. That's why the popup-chrome fix and the
// maximized-window-border fix already in this file (see
// resolveWindowTitle/captureConfig's history above) each fixed a real,
// separate bug but did not fully eliminate white/black capture reports.
//
// THE FIX: spawn a SEPARATE Chromium process — its own --user-data-dir
// so it never shares/inherits the operator's normal browsing session —
// with --disable-gpu, forcing Chromium onto a plain, GDI-readable
// surface for this window specifically. Same idea vMix's own embedded-
// Chromium Browser Input documents ("disable GPU") when a capture path
// needs to read a browser surface's pixels directly. The page itself
// (camera <video> + cricket-overlay.html <iframe>) is unchanged.
//
// window.open() popup mode is kept as a FALLBACK only (see
// ensureLiveOutputWindow in cricket-panel.html) for non-Windows/dev use
// and machines where Chrome/Edge can't be found at their usual install
// paths — GPU compositing stays on in that path, so the health check
// above and the native preview exist specifically to catch it if it
// happens there, rather than silently going live with a bad picture.
// ================================================================
function resolveCaptureBrowserExecutable() {
    if (process.env.CAPTURE_BROWSER_PATH && fs.existsSync(process.env.CAPTURE_BROWSER_PATH)) return process.env.CAPTURE_BROWSER_PATH;
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';
    const candidates = [
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        localAppData && path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ }
    }
    return null;
}

// Isolated, PERSISTENT profile dir (not a fresh temp dir per launch) so
// the one-time camera getUserMedia() permission grant survives across
// restarts — a fresh/temp profile would re-prompt for camera permission
// on every single launch, and that permission bar covering the frame is
// itself exactly the kind of "looks blank/wrong to gdigrab" situation
// this whole feature exists to catch.
const CAPTURE_PROFILE_DIR = path.join(DATA_ROOT, 'CaptureBrowserProfile');

const captureWindow = {
    proc: null,
    matchId: null,
    launchedAt: null,
    execPath: null,
    lastCameraEndedAt: null,
    lastCameraEndedReason: null,
};

function launchCaptureWindow({ matchId, videoDeviceId, videoLabel, origin, width, height }) {
    if (captureWindow.proc && captureWindow.matchId === matchId) return { ok: true, alreadyRunning: true };
    if (captureWindow.proc) closeCaptureWindow(); // switching matches — release the old one first
    if (!NATIVE_CAPTURE_SUPPORTED) return { ok: false, error: `Dedicated capture window launch needs Windows — this process is running on ${process.platform}` };
    const execPath = resolveCaptureBrowserExecutable();
    if (!execPath) return { ok: false, error: 'Could not find Chrome or Edge on this PC (checked the usual install paths) — set the CAPTURE_BROWSER_PATH environment variable to its full .exe path, or use the fallback popup window' };
    if (!origin) return { ok: false, error: "origin required (the Cricket Panel's own page URL) — cannot build the Live Output URL" };
    try { fs.mkdirSync(CAPTURE_PROFILE_DIR, { recursive: true }); } catch (e) { /* best effort — Chromium will still create it */ }

    // 🩹 See both functions' own header comments: this process has no
    // memory of a capture window a PREVIOUS stream-engine run may have
    // launched (captureWindow.proc resets to null on every restart) —
    // without this, a stale/stuck process can silently absorb this
    // "launch" via Chrome/Edge's single-instance-per-profile lock instead
    // of a real new process actually starting, so a flag/code change
    // never takes effect no matter how many times the operator retries.
    // Profile-based first (catches a process too stuck/crashed to have
    // ever set a matching window title at all — the case that made the
    // title-only version insufficient); title-based second as a backstop
    // for anything the profile-dir match somehow missed. Always run
    // both, not just when captureWindow.proc looks set.
    closeStaleCaptureWindowByProfile();
    closeStaleCaptureWindowByTitle(matchId);

    // 🩹 videoDeviceId is passed through for the popup-fallback path
    // (same browser profile as the panel, so it's valid there) but is
    // USELESS to this dedicated window: Chrome/Edge salts getUserMedia
    // deviceIds per browser profile (a privacy measure), and this window
    // launches into its OWN isolated CAPTURE_PROFILE_DIR profile — the
    // panel's deviceId does not exist there, so passing it alone throws
    // OverconstrainedError ("Could not open camera:" with a blank
    // message — confirmed in the field). videoLabel (the human-readable
    // device name, NOT profile-scoped) is what live-output.html actually
    // uses to pick the right camera in this profile — see its own
    // startCamera().
    const url = `${String(origin).replace(/\/+$/, '')}/live-output.html?room=${encodeURIComponent(matchId)}&video=${encodeURIComponent(videoDeviceId || '')}&videoLabel=${encodeURIComponent(videoLabel || '')}`;
    const w = Math.max(1280, Number(width) || 1920);
    const h = Math.max(720, Number(height) || 1080);
    const args = [
        `--app=${url}`,
        `--user-data-dir=${CAPTURE_PROFILE_DIR}`,
        '--window-position=0,0',
        `--window-size=${w},${h}`,
        // 🩹 Forces Chromium off DirectComposition/GPU compositing for
        // this window so gdigrab's GDI BitBlt can actually read its
        // pixels — see this section's header comment for the full
        // reasoning. These three flags are deliberately redundant with
        // each other (different Chromium versions honor different ones)
        // rather than betting on exactly one.
        '--disable-gpu',
        '--disable-gpu-compositing',
        '--disable-software-rasterizer',
        // 🩹 CONFIRMED IN THE FIELD: even with GPU compositing fully
        // disabled above, a live <video> element (the camera feed) can
        // STILL render through a SEPARATE DirectComposition "video
        // overlay" swapchain — a distinct fast-path Chromium uses
        // specifically to present live video efficiently, independent
        // of the general page compositor --disable-gpu controls. gdigrab
        // (GDI BitBlt) cannot read that swapchain either, so the operator
        // sees the real camera feed in the window itself (it renders
        // correctly on screen) while /capture-preview and the actual
        // recorded/streamed picture come back blank/gray exactly where
        // the <video> element is — the overlay graphics around it can
        // still be readable since those aren't going through this same
        // path. DirectCompositionVideoOverlays forces <video> back onto
        // the normal compositor surface, which BitBlt CAN read.
        // CalculateNativeWinOcclusion: Chromium pauses/throttles a
        // window's rendering when it THINKS another window occludes it
        // — gdigrab still reads whatever's on screen regardless, so that
        // mismatch alone can look like a frozen/stale program feed even
        // though nothing actually failed. (Chromium only honors the
        // LAST --disable-features flag if passed more than once, so both
        // names are combined into this single flag, not two separate ones.)
        '--disable-features=CalculateNativeWinOcclusion,DirectCompositionVideoOverlays',
        // No user ever clicks this window (it's launched headless-ish,
        // programmatically) — without this, Chromium's autoplay policy
        // can block the camera <video> from playing at all.
        '--autoplay-policy=no-user-gesture-required',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--disable-infobars',
        '--noerrdialogs',
    ];
    let proc;
    try {
        // stderr piped (not 'ignore') so an immediate/unexpected exit
        // (e.g. still getting single-instance-forwarded despite the
        // cleanup above, or a genuine Chromium startup error) actually
        // says why instead of just "exited (code=0)" with no explanation.
        proc = spawn(execPath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
    } catch (e) {
        return { ok: false, error: `Could not launch capture browser: ${e.message}` };
    }
    captureWindow.proc = proc;
    captureWindow.matchId = matchId;
    captureWindow.launchedAt = Date.now();
    captureWindow.execPath = execPath;
    captureWindow.lastCameraEndedAt = null;
    captureWindow.lastCameraEndedReason = null;
    let captureWindowStderr = '';
    if (proc.stderr) proc.stderr.on('data', (d) => { captureWindowStderr += d; if (captureWindowStderr.length > 4000) captureWindowStderr = captureWindowStderr.slice(-4000); });
    proc.on('exit', (code, signal) => {
        if (captureWindow.proc !== proc) return; // already superseded/closed
        const elapsedMs = Date.now() - captureWindow.launchedAt;
        // 🩹 An exit within ~2s of launch, with code 0, is the exact
        // signature of Chrome/Edge's single-instance forwarding (it
        // handed the URL to an already-running process on this profile
        // and quit immediately) rather than a real crash — flagged
        // explicitly here since "code=0" alone reads as a clean, boring
        // exit and hides that this is actually a launch that never
        // really happened.
        const suspectedSingleInstanceForward = code === 0 && elapsedMs < 2000;
        console.log(`[stream-engine] dedicated capture window exited (code=${code}, signal=${signal}, ${elapsedMs}ms after launch)${suspectedSingleInstanceForward ? ' — likely single-instance-forwarded to an already-running process rather than a real crash; report this if it keeps happening after closeStaleCaptureWindowByProfile' : ''}${captureWindowStderr ? `\n[stream-engine] capture window stderr:\n${captureWindowStderr}` : ''}`);
        captureWindow.proc = null;
    });
    proc.on('error', (err) => {
        console.log('[stream-engine] dedicated capture window spawn error:', err.message);
        if (captureWindow.proc === proc) captureWindow.proc = null;
    });
    return { ok: true, execPath };
}

function closeCaptureWindow() {
    if (!captureWindow.proc) return { ok: true, alreadyIdle: true };
    try { captureWindow.proc.kill(); } catch (e) { /* already gone */ }
    captureWindow.proc = null;
    captureWindow.matchId = null;
    return { ok: true };
}

// Native capture inputs shared by BOTH the recorder and the live
// encoder — video from gdigrab (the Live Output window, real OS-level
// screen capture, hardware/OS-clocked, never a browser video encode)
// and audio from dshow (the mic/capture-card device, opened directly by
// ffmpeg — the browser is never in the audio path either).
// -use_wallclock_as_timestamps on BOTH inputs locks them to the same
// real-world clock so ffmpeg's own A/V sync is correct even though
// they're two independent native capture streams; -thread_queue_size
// gives each input's demuxer thread headroom against momentary stalls.
function buildCaptureInputArgs({ windowTitle, fps, audioDeviceName }) {
    return [
        '-f', 'gdigrab', '-framerate', String(fps),
        '-thread_queue_size', '1024',
        '-use_wallclock_as_timestamps', '1',
        '-i', `title=${windowTitle}`,
        '-f', 'dshow',
        '-thread_queue_size', '1024',
        '-use_wallclock_as_timestamps', '1',
        '-i', `audio=${audioDeviceName}`,
    ];
}

// gdigrab's own stderr text when the target window doesn't exist (Live
// Output was never opened, was closed, or its title doesn't match) —
// this is a FATAL, operator-actionable problem ("open Live Output"),
// never a network blip, so it must never enter the unlimited-backoff
// reconnect loop meant for real internet drops. 🩹 Confirmed on real
// hardware: gdigrab's ACTUAL message is "Can't find window '<title>',
// aborting." — the older patterns below never matched that wording, so
// a genuinely missing/closed Live Output window was silently going
// through scheduleReconnect() (endless "Reconnecting…") instead of
// ever surfacing as crashed with an actionable reason.
const WINDOW_NOT_FOUND_PATTERN = /Can.t find window|Failed to find window|Unable to find window|window not found/i;

// ----------------------------------------------------------------
// 🛑 GRACEFUL FFMPEG STOP — sends the interactive 'q' keypress ffmpeg
// reads from its own stdin to close cleanly (flush the last GOP, write
// a valid moov/trailer, end the RTMP stream properly) rather than a
// hard kill. This is the standard, correct way to stop ffmpeg on
// Windows: Node's child_process.kill() sends real POSIX signals only on
// POSIX platforms — on Windows, any signal name Node is asked for is
// translated to an unconditional TerminateProcess, which is exactly the
// abrupt kill this avoids for the normal Stop path (a SIGKILL fallback
// timer still exists below for a process that doesn't exit in time).
// ----------------------------------------------------------------
// Stops a child and resolves once it has really exited: 'q' is the
// keypress ffmpeg reads on stdin (legacy gdigrab processes); 'eof' ends
// stdin, which is how a native relay consumer (whose stdin IS its video
// input) finishes cleanly. SIGKILL only if it hasn't exited in time —
// and that kill timer is cleared on exit so nothing lingers afterwards.
function stopChildProcess(proc, { mode = 'q', timeoutMs = 5000 } = {}) {
    return new Promise((resolve) => {
        if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ } }, timeoutMs);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
        try {
            if (mode === 'q') proc.stdin.write('q');
            else proc.stdin.end();
        } catch (e) {
            try { proc.kill('SIGKILL'); } catch (e2) { /* already gone */ }
        }
    });
}
function gracefulStop(proc, killTimeoutMs = 5000) {
    return stopChildProcess(proc, { mode: 'q', timeoutMs: killTimeoutMs });
}
// 🧪 NATIVE PIPELINE variant — the recorder-encoder/live-encoder's own
// stdin is the compositor's RELAY INPUT, so writing 'q' would corrupt
// that stream instead of stopping it. The relay only ever writes whole
// packets (see nativePipeline.js), so closing stdin here ends the input
// exactly on a packet boundary: ffmpeg finishes normally and writes
// proper trailers — no "Invalid buffer size … Error submitting packet"
// on every stop.
function gracefulStopByClosingStdin(proc, killTimeoutMs = 5000) {
    return stopChildProcess(proc, { mode: 'eof', timeoutMs: killTimeoutMs });
}

// ----------------------------------------------------------------
// 📜 ffmpeg stderr handling shared by the recorder and live encoder.
// Both run with `-progress pipe:2`: those key=value lines are PARSED
// (real "is it still writing?" signal + clip timing) and never printed —
// printing them flooded the console with ~25 lines/second for the whole
// match, and on Windows a console that can't keep up (or is paused by a
// click in QuickEdit mode) blocks the process writing to it.
// ----------------------------------------------------------------
const PROGRESS_LINE_RE = /^(frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time_us|out_time_ms|out_time|dup_frames|drop_frames|speed|progress)=/;
// ffmpeg notices that are expected in this pipeline and tell the
// operator nothing actionable.
const BENIGN_FFMPEG_LINE_RE = /Guessed Channel Layout|deprecated pixel format used|VBV maxrate specified, but no bufsize/i;
function createLineReader(onLine) {
    let buf = '';
    return (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.search(/[\r\n]/)) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line) onLine(line);
        }
        if (buf.length > 8192) buf = buf.slice(-8192); // never let a newline-less stream grow without bound
    };
}
// out_time_us from a progress line, in seconds (null for anything else / "N/A").
function progressOutTimeSec(line) {
    const m = /^out_time_us=(\d+)/.exec(line);
    return m ? Number(m[1]) / 1e6 : null;
}

// ================================================================
// 🎬 ENCODER STATE MACHINE (YouTube live push) — single stream at a
// time, never duplicated.
// idle -> starting -> live -> stopping -> idle
//                   -> reconnecting -> (backoff retry) -> starting   [network blip — see ABR section below]
//                   -> crashed -> (bounded auto-restart) -> starting  [fatal/config error, not network]
// ================================================================
const MAX_AUTO_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
// Capped exponential backoff for NETWORK-flavored disconnects specifically
// (see isFatalError below) — unlike MAX_AUTO_RESTARTS above, this never
// gives up on its own: an operator's internet flapping for a while is
// exactly the case this exists to survive, so retries continue for as
// long as the operator wants to be live (only an explicit Stop ends it).
const RECONNECT_BACKOFF_MS = [2000, 4000, 8000, 15000];

const engine = {
    state: 'idle',           // idle | starting | live | reconnecting | stopping | crashed
    proc: null,              // the ffmpeg child process (native gdigrab+dshow capture -> NVENC -> RTMPS)
    matchId: null,           // set at /go-live — used to build the gdigrab window title on every (re)start
    audioDeviceName: null,   // native dshow audio device name for this session
    cameraDeviceName: null,  // native dshow camera device name — only used when NATIVE_PROGRAM_FEED is on
    mainServerUrl: null,     // origin used to build the overlay URL for the native compositor — only used when NATIVE_PROGRAM_FEED is on
    desiredLive: false,      // operator's intent — drives whether a crash should auto-restart
    startedAt: null,
    restarts: [],            // timestamps of recent fatal-error auto-restarts, for the bounded-retry window
    lastError: null,
    settings: null,          // {resolution, fps, bitrateKbps, keyframeIntervalSec} — CURRENT actual encode settings (may be stepped down from targetResolution by ABR)
    targetResolution: null,  // the resolution the OPERATOR selected — never silently changed except by an enabled Automatic Resolution Fallback
    qualityMode: 'adaptive', // 'manual' (exactly the selected resolution/bitrate, no automatic changes) | 'adaptive'
    autoResolutionFallback: false,
    rung: 'high',            // 'high' | 'medium' | 'low' | 'low-fps' — current position on the bitrate ladder for engine.settings.resolution
    sessionLadder: null,     // per-resolution {high,medium,low} kbps for THIS session — scaled from abr.ladder if the operator supplied a custom bitrate at Go Live
    adapting: false,         // true while an ABR-triggered hot-restart (stop+go-live) is in flight
    opToken: 0,              // bumped by the operator-facing /go-live and /stop routes; an in-flight ABR restart checks this so an operator action always wins the race
    lastRestartAt: 0,        // Date.now() of the last ABR hot-restart — rate-limits how often we thrash the encoder
    reconnect: { attempts: 0, nextAttemptAt: null },
    network: {
        state: 'stable',       // stable | weak | critical | reconnecting
        protectionActive: false,
        protectionMessage: null,
        uploadEstimateKbps: null, // DERIVED estimate from sustained clean throughput — see sampleNetworkHealth. Not a dedicated bandwidth probe.
        weakSince: null,
        criticalSince: null,
        stableSince: null,
    },
    metrics: { bitrateKbps: null, fps: null, droppedFrames: null, totalFrames: null, outTimeSec: null, speed: null },
    lastProgramFeedHealth: null, // {ok, black, white, frozen, checkedAt} — see runProgramFeedHealthCheck/monitorProgramFeedHealth
};

function resetMetrics() {
    engine.metrics = { bitrateKbps: null, fps: null, droppedFrames: null, totalFrames: null, outTimeSec: null, speed: null };
    // A fresh ffmpeg process's frame/drop counters in -progress start
    // over from 0 — without resetting these too, sampleNetworkHealth's
    // very first post-restart tick would diff the OLD process's last
    // known totals against the NEW process's near-zero ones (Math.max
    // clamps stop it going negative, but it still falsely reads as a
    // perfect zero-drop tick instead of "no data yet").
    lastDroppedFramesSample = null;
    lastTotalFramesSample = null;
}

// Parses ffmpeg's `-progress pipe:2`-style key=value lines (we route
// -progress to a pipe and read it) — see buildLiveEncoderArgs.
function parseProgressLine(line) {
    const m = /^(\w+)=(.*)$/.exec(line.trim());
    if (!m) return;
    const [, key, value] = m;
    if (key === 'bitrate') {
        const num = parseFloat(value);
        if (!Number.isNaN(num)) engine.metrics.bitrateKbps = Math.round(num);
    } else if (key === 'fps') {
        const num = parseFloat(value);
        if (!Number.isNaN(num)) engine.metrics.fps = num;
    } else if (key === 'frame') {
        const num = parseInt(value, 10);
        if (!Number.isNaN(num)) engine.metrics.totalFrames = num;
    } else if (key === 'drop_frames') {
        const num = parseInt(value, 10);
        if (!Number.isNaN(num)) engine.metrics.droppedFrames = num;
    } else if (key === 'out_time_ms') {
        const num = parseInt(value, 10);
        if (!Number.isNaN(num)) engine.metrics.outTimeSec = Math.round(num / 1000000);
    } else if (key === 'speed') {
        // e.g. "0.98x" — ffmpeg's own real-time factor. Sustained <1.0x
        // means capture+encode+network together can't keep up with real
        // time; this is now the PRIMARY congestion signal (see
        // sampleNetworkHealth) since native capture has no Node-side
        // stdin pipe to measure backpressure on anymore.
        const num = parseFloat(value.replace('x', ''));
        if (!Number.isNaN(num)) engine.metrics.speed = num;
    }
}

function buildLiveEncoderArgs({ windowTitle, audioDeviceName, width, height, fps, bitrateKbps, keyframeIntervalSec, destinationUrl }) {
    const gop = Math.round(fps * keyframeIntervalSec);
    const useGpuScale = checkGpuScaleRuntime();
    return [
        '-hide_banner', '-loglevel', 'warning',
        ...buildCaptureInputArgs({ windowTitle, fps, audioDeviceName }),
        '-map', '0:v', '-map', '1:a',
        '-vf', cropScaleFilter(width, height, useGpuScale),
        '-r', String(fps),
        // Force true CFR regardless of any capture jitter — never VFR.
        // Whichever of '-fps_mode cfr' / '-vsync cfr' this ffmpeg build
        // actually recognizes — see cfrFlagArgs(); builds differ on this.
        ...cfrFlagArgs(),
        '-c:v', 'h264_nvenc',
        // p4 = balanced speed/quality; tune ll = NVENC's low-latency mode
        // (skips B-frames and extra lookahead that add encode latency —
        // matters for a LIVE stream, where every extra ms of encoder
        // buffering is a second the broadcast falls further behind).
        // Only added when checkNvencTuneRuntime() has actually confirmed
        // this ffmpeg/NVENC build accepts '-tune' on h264_nvenc — some
        // builds don't, and asking for it anyway makes ffmpeg exit
        // instantly with "Unrecognized option 'tune'." on every single
        // Go Live attempt (see checkNvencTuneRuntime's comment).
        '-preset', 'p4', ...(checkNvencTuneRuntime() ? ['-tune', 'll'] : []),
        '-rc', 'cbr',
        '-b:v', `${bitrateKbps}k`,
        '-maxrate', `${bitrateKbps}k`,
        '-bufsize', `${bitrateKbps * 2}k`,
        '-g', String(gop),
        '-keyint_min', String(gop),
        // -bf 0: no B-frames — YouTube's RTMP(S) ingest doesn't need them
        // and they add reordering latency; also keeps every GOP a simple
        // IPPP... structure.
        '-bf', '0',
        '-af', 'aresample=async=1:first_pts=0',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
        '-max_muxing_queue_size', '4096',
        '-flvflags', 'no_duration_filesize', // RTMP isn't seekable — avoids "Failed to update header with correct duration/filesize" on every stop
        '-f', 'flv',
        '-progress', 'pipe:2', '-nostats',
        destinationUrl,
    ];
}

// ================================================================
// 📶 ADAPTIVE BITRATE (ABR) — keeps the operator's SELECTED resolution
// live through a fluctuating/unstable connection instead of disconnecting.
// All numbers below are runtime-configurable (POST /adaptive-config)
// specifically so a different streaming provider's own limits don't
// require editing this file.
//
// Mechanism: ffmpeg's CLI doesn't expose changing NVENC's target bitrate
// on a running process, so "adaptive bitrate" here means a fast, rate-
// limited hot-restart (stop this ffmpeg, immediately start a new one
// with the new -b:v/resolution/fps) — the SAME technique the panel's
// manual "Lower Quality Now" button uses. Because the live encoder now
// does its OWN native capture (no shared byte-stream with the
// recorder), a restart is just "kill this process, spawn a fresh one" —
// the recorder is a fully separate process and is never touched by
// this. Local recording/clips are entirely unaffected.
// ================================================================
const RESOLUTION_ORDER = ['1080p', '720p', '480p'];

// kbps rungs per resolution. "High" doubles as DEFAULT_BITRATE_KBPS's
// 30fps ceiling for that resolution; "Medium"/"Low" are the step-down
// targets when the network can't sustain High.
const ABR_LADDER_DEFAULTS = {
    '1080p': { high: 5000, medium: 3500, low: 2200 },
    '720p':  { high: 3000, medium: 2000, low: 1200 },
    '480p':  { high: 1500, medium: 1000, low: 700 },
};

let abr = {
    ladder: JSON.parse(JSON.stringify(ABR_LADDER_DEFAULTS)),
    safetyFactor: 0.75,      // never target the full detected/sustained throughput — keep headroom for jitter
    emergencyFps: 15,        // last lever BEFORE resolution fallback — reduce fps at the floor bitrate for the current resolution
    holdWeakSec: 10,         // mild congestion sustained this long -> step bitrate down one rung
    holdCriticalSec: 45,     // severe congestion, already at the bitrate floor, sustained this long -> fps cut, then (if enabled) resolution fallback
    holdStableUpSec: 45,     // clean signal sustained this long -> step bitrate/resolution back up, one rung at a time
    minRestartIntervalMs: 8000, // rate-limits hot-restarts so a noisy connection can't thrash the encoder every tick
};

// A custom bitrate typed into the panel becomes this resolution's "High"
// for the session — Medium/Low scale with it proportionally, so an
// operator working against a provider with different limits than the
// defaults above still gets sane step-down targets instead of the
// hardcoded numbers.
function buildSessionLadder(resKey, customBitrateKbps) {
    const scale = Number(customBitrateKbps) > 0 ? Number(customBitrateKbps) / abr.ladder[resKey].high : 1;
    const out = {};
    for (const r of RESOLUTION_ORDER) {
        out[r] = {
            high: Math.max(300, Math.round(abr.ladder[r].high * scale)),
            medium: Math.max(250, Math.round(abr.ladder[r].medium * scale)),
            low: Math.max(200, Math.round(abr.ladder[r].low * scale)),
        };
    }
    return out;
}

function stepResolutionDown(current) {
    const idx = RESOLUTION_ORDER.indexOf(current);
    if (idx === -1 || idx === RESOLUTION_ORDER.length - 1) return null;
    return RESOLUTION_ORDER[idx + 1];
}
function stepResolutionUp(current, target) {
    const idxCur = RESOLUTION_ORDER.indexOf(current);
    const idxTarget = RESOLUTION_ORDER.indexOf(target);
    if (idxCur <= idxTarget) return null; // already at or above the operator's selected tier
    return RESOLUTION_ORDER[idxCur - 1];
}

function setProtection(active) {
    const net = engine.network;
    net.protectionActive = active;
    if (!active) { net.protectionMessage = null; return; }
    if (!engine.settings) return;
    net.protectionMessage = engine.settings.resolution === engine.targetResolution
        ? `${engine.targetResolution} selected — internet bandwidth too low — stream protection active (bitrate held at the floor for this resolution${!engine.autoResolutionFallback ? '; enable Automatic Resolution Fallback to drop resolution instead' : ''})`
        : `${engine.targetResolution} selected, streaming at ${engine.settings.resolution} due to sustained low bandwidth — stream protection active`;
}

// Classifies current network health from signals ffmpeg's own
// -progress output actually gives us: how far the achieved output
// bitrate is below target, how many frames ffmpeg itself had to drop,
// and ffmpeg's own real-time factor (`speed=`) — sustained <1.0x means
// capture+encode+network together can't keep up with real time, the
// same signal OBS's own "dropped frames due to network" detection
// relies on. (Node-side stdin backpressure no longer exists as a signal
// here — native capture means ffmpeg pulls frames itself; there is no
// pipe from this process into it anymore.) No dedicated bandwidth probe
// exists — uploadEstimateKbps is a DERIVED figure, not a measured one.
let lastDroppedFramesSample = null;
let lastTotalFramesSample = null;
function sampleNetworkHealth() {
    const target = engine.settings ? engine.settings.bitrateKbps : null;
    const actual = engine.metrics.bitrateKbps;
    const ratio = (target && actual != null) ? actual / target : 1;
    const speed = engine.metrics.speed;

    const dropped = engine.metrics.droppedFrames;
    const totalFrames = engine.metrics.totalFrames;
    let droppedDeltaPct = 0;
    if (dropped != null && totalFrames != null && lastDroppedFramesSample != null && lastTotalFramesSample != null) {
        const dDropped = Math.max(0, dropped - lastDroppedFramesSample);
        const dTotal = Math.max(1, totalFrames - lastTotalFramesSample);
        droppedDeltaPct = (dDropped / dTotal) * 100;
    }
    lastDroppedFramesSample = dropped;
    lastTotalFramesSample = totalFrames;

    let severity = 'stable';
    if ((speed != null && speed < 0.6) || ratio < 0.4 || droppedDeltaPct > 5) severity = 'severe';
    else if ((speed != null && speed < 0.92) || ratio < 0.8 || droppedDeltaPct > 1) severity = 'mild';

    // If we're cleanly sustaining `actual` kbps while only using
    // `safetyFactor` of the real pipe (by design), the implied ceiling is
    // actual/safetyFactor. Only meaningful once the signal is clean.
    const uploadEstimateKbps = actual != null ? Math.round(actual / abr.safetyFactor) : null;

    return { severity, ratio, droppedDeltaPct, speed, uploadEstimateKbps };
}

// Hot-restarts the encoder at `next` = {rung, resolution, fps, bitrateKbps}.
// Guarded by opToken so an operator Stop/Go-Live that happens while this
// is in flight always wins — we never revive a stream the operator just
// asked to stop.
async function applyRestart(next) {
    if (engine.adapting || engine.state !== 'live') return;
    engine.adapting = true;
    engine.lastRestartAt = Date.now();
    const myToken = engine.opToken;
    const keyframeIntervalSec = (engine.settings && engine.settings.keyframeIntervalSec) || 2;
    console.log(`[stream-engine] ABR: adapting -> ${next.resolution} @ ${next.fps}fps, ${next.bitrateKbps}kbps (rung=${next.rung})`);

    stopEncoder({ forRestart: true });
    const waitStart = Date.now();
    while (engine.state !== 'idle' && Date.now() - waitStart < 6500) {
        await new Promise((r) => setTimeout(r, 150));
    }

    if (engine.opToken !== myToken || shuttingDown) { engine.adapting = false; return; } // operator acted while we were restarting — defer to them (their Stop already released the compositor ref)

    engine.desiredLive = true; // stopEncoder() cleared this — this restart is US, not the operator stopping
    const result = await startEncoder({ resolution: next.resolution, fps: next.fps, bitrateKbps: next.bitrateKbps, keyframeIntervalSec });
    engine.adapting = false;
    if (result.ok) {
        engine.rung = next.rung;
    } else {
        // Never leave the stream down after a failed adapt: fall into the
        // normal reconnect loop at the new settings.
        console.log('[stream-engine] ABR restart failed:', result.error, '— reconnecting');
        engine.settings = resolveEncodeSettings({ ...next, keyframeIntervalSec });
        engine.desiredLive = true;
        engine.lastError = result.error;
        scheduleReconnect();
    }
}

// The ABR control loop — ticks every ABR_TICK_MS while live. Priority
// order: keep the connection alive > keep the selected resolution >
// reduce bitrate > reduce fps (emergency) > resolution fallback (only
// if enabled and genuinely necessary). Decreases react fast (no hold
// needed once truly "severe"); increases require a sustained clean
// signal (holdStableUpSec) so the stream doesn't oscillate on every
// brief improvement.
function abrTick() {
    if (engine.state !== 'live' || engine.adapting || !engine.settings) return;

    const now = Date.now();
    const sample = sampleNetworkHealth();
    const net = engine.network;

    if (sample.severity === 'severe') {
        net.criticalSince = net.criticalSince || now;
        net.weakSince = null;
        net.stableSince = null;
    } else if (sample.severity === 'mild') {
        net.weakSince = net.weakSince || now;
        net.criticalSince = null;
        net.stableSince = null;
    } else {
        net.stableSince = net.stableSince || now;
        net.weakSince = null;
        net.criticalSince = null;
    }
    net.state = sample.severity === 'severe' ? 'critical' : sample.severity;
    net.uploadEstimateKbps = sample.uploadEstimateKbps;

    if (engine.qualityMode === 'manual') return; // manual = exactly the operator's picked settings, never auto-adjusted

    if (now - engine.lastRestartAt < abr.minRestartIntervalMs) return; // rate-limit hot-restarts

    const ladder = (engine.sessionLadder || abr.ladder)[engine.settings.resolution];
    const criticalHeldSec = net.criticalSince ? (now - net.criticalSince) / 1000 : 0;
    const weakHeldSec = net.weakSince ? (now - net.weakSince) / 1000 : 0;
    const stableHeldSec = net.stableSince ? (now - net.stableSince) / 1000 : 0;

    // --- DECREASE (fast) ---
    if (sample.severity === 'severe' || weakHeldSec >= abr.holdWeakSec) {
        const isSevere = sample.severity === 'severe';
        if (!isSevere) net.weakSince = now; // only mildly weak — restart its own hold so we step at most once per hold window, not every tick

        if (engine.rung === 'high') { applyRestart({ rung: 'medium', resolution: engine.settings.resolution, fps: engine.settings.fps, bitrateKbps: ladder.medium }); return; }
        if (engine.rung === 'medium') { applyRestart({ rung: 'low', resolution: engine.settings.resolution, fps: engine.settings.fps, bitrateKbps: ladder.low }); return; }

        if (!isSevere) return; // already at the bitrate floor and only mildly weak — hold here, nothing more to do

        // From here: severity is genuinely severe AND we're already at the floor bitrate for this resolution.
        if (engine.rung === 'low') {
            if (criticalHeldSec >= abr.holdCriticalSec) { applyRestart({ rung: 'low-fps', resolution: engine.settings.resolution, fps: abr.emergencyFps, bitrateKbps: ladder.low }); return; }
            setProtection(true);
            return;
        }
        if (engine.rung === 'low-fps') {
            if (criticalHeldSec >= abr.holdCriticalSec && engine.autoResolutionFallback) {
                const next = stepResolutionDown(engine.settings.resolution);
                if (next) { applyRestart({ rung: 'medium', resolution: next, fps: 30, bitrateKbps: (engine.sessionLadder || abr.ladder)[next].medium }); return; }
            }
            setProtection(true);
            return;
        }
        return;
    }

    // --- INCREASE (gradual, only after a sustained clean signal) ---
    if (sample.severity === 'stable' && stableHeldSec >= abr.holdStableUpSec) {
        setProtection(false);
        net.stableSince = now; // restart the hold so climbing back up is also gradual, one rung per hold window
        if (engine.rung === 'low-fps') { applyRestart({ rung: 'low', resolution: engine.settings.resolution, fps: 30, bitrateKbps: ladder.low }); return; }
        if (engine.rung === 'low') { applyRestart({ rung: 'medium', resolution: engine.settings.resolution, fps: engine.settings.fps, bitrateKbps: ladder.medium }); return; }
        if (engine.rung === 'medium') { applyRestart({ rung: 'high', resolution: engine.settings.resolution, fps: engine.settings.fps, bitrateKbps: ladder.high }); return; }
        if (engine.rung === 'high' && engine.autoResolutionFallback && engine.settings.resolution !== engine.targetResolution) {
            const next = stepResolutionUp(engine.settings.resolution, engine.targetResolution);
            if (next) { applyRestart({ rung: 'medium', resolution: next, fps: 30, bitrateKbps: (engine.sessionLadder || abr.ladder)[next].medium }); }
        }
    }
}

// Fatal/config errors (bad args, no NVENC, missing filter, or the Live
// Output window not being open) should NOT retry forever — those need
// the operator to fix something. Everything else observed on an
// unexpected ffmpeg exit is treated as a network blip and gets the
// unlimited-backoff reconnect loop below, because a live sports stream
// should never just give up over a few dropped packets or a brief
// internet outage.
// "no space left"/"disk full" added so a disk-full crash (recorder/clip
// cutting — the only things that write local files) is classified as
// fatal/operator-actionable instead of silently falling into the
// network-blip reconnect loop, which would just keep retrying against a
// still-full disk.
// 🩹 CONFIRMED IN THE FIELD: "unable to open"/"no such file"/"i/o error"
// are exactly the signatures a temporarily-disconnected camera or
// capture-card driver hiccup produces (see nativePipeline.js's own
// history of real dshow failures) — classifying those as FATAL meant a
// camera unplug permanently killed the stream after 3 retries within 5
// minutes, requiring the operator to press Go Live again by hand, even
// though physically reconnecting the camera would have fixed it on its
// own. A lost input should behave exactly like a lost network
// connection: keep retrying with backoff, resume automatically the
// moment it's available again, never give up on its own. Removed from
// this pattern — genuinely permanent config errors (wrong ffmpeg flags,
// no NVENC-capable device at all, wrong permissions, out of disk) stay
// fatal; a device that's merely unavailable RIGHT NOW does not.
// 🛠 ROOT-CAUSE FIX (YouTube stopping for good after an internet outage).
//
// When the connection drops mid-push, ffmpeg's RTMP muxer almost always
// fails with one of:
//
//     av_interleaved_write_frame(): Invalid argument
//     Error writing trailer of rtmps://...: Invalid argument
//     av_interleaved_write_frame(): Broken pipe
//     rtmp://... Input/output error
//
// FATAL_ERROR_PATTERN contained a bare `invalid argument`, so the FIRST
// two matched it. That routed a plain network drop into the "config or
// hardware problem" branch, which is deliberately bounded: three
// restarts inside five minutes and then `engine.desiredLive = false` --
// the stream gives up permanently and only a manual Go Live brings it
// back. On a venue connection that dips more than three times, the
// stream was dead for the rest of the match with the operator watching.
//
// Network failures are now classified FIRST and always win. A dropped
// connection can therefore only ever reach scheduleReconnect(), which
// retries at capped backoff for as long as the operator wants to be
// live and never gives up on its own -- the vMix-like behaviour that was
// intended all along. The bounded branch is kept for what it was
// actually meant for: a missing encoder, a full disk, a bad argument in
// the command line -- things retrying genuinely cannot fix.
const NETWORK_ERROR_PATTERN = new RegExp([
    // ffmpeg's own write/muxer failures when the far end goes away
    'av_interleaved_write_frame',
    'error writing trailer',
    'error muxing a packet',
    'broken pipe',
    'connection reset',
    'connection refused',
    'connection timed out',
    'input/output error',
    'end of file',
    'network is unreachable',
    'no route to host',
    'temporary failure in name resolution',
    'failed to resolve hostname',
    'name or service not known',
    // librtmp / rtmp-specific
    'rtmp',
    'writen, rtmp send error',
    'unable to open resource',
    'cannot open connection',
    'handshake failed',
    // socket-level
    'econnreset', 'econnrefused', 'etimedout', 'ehostunreach', 'enetunreach', 'epipe', 'enotfound', 'eai_again',
    'socket hang up',
    'timed out',
].join('|'), 'i');
const FATAL_ERROR_PATTERN = /unrecognized option|no such filter|cannot find a matching stream|no nvenc capable devices|permission denied|unknown encoder|no space left|disk full/i;
// A genuine config/hardware fault -- NEVER a network blip. Anything that
// looks even slightly like the connection going away is excluded here, so
// it falls through to the unlimited reconnect path instead.
function isFatalError(message) {
    if (!message) return false;
    if (NETWORK_ERROR_PATTERN.test(message)) return false; // network always wins
    return FATAL_ERROR_PATTERN.test(message) || WINDOW_NOT_FOUND_PATTERN.test(message);
}

// Network-flavored disconnect: keep retrying at capped exponential
// backoff for as long as the operator wants to be live (engine.desiredLive)
// — never gives up on its own. Local recording/clips are untouched by any
// of this — the recorder is a fully separate process with its own
// independent native capture.
function scheduleReconnect() {
    engine.state = 'reconnecting';
    engine.network.state = 'reconnecting';
    const backoff = RECONNECT_BACKOFF_MS[Math.min(engine.reconnect.attempts, RECONNECT_BACKOFF_MS.length - 1)];
    engine.reconnect.attempts += 1;
    engine.reconnect.nextAttemptAt = Date.now() + backoff;
    console.log(`[stream-engine] Live stream interrupted (${engine.lastError}) — reconnecting in ${backoff / 1000}s (attempt ${engine.reconnect.attempts}); recording is unaffected`);
    setTimeout(async () => {
        if (!engine.desiredLive || shuttingDown) return; // operator pressed Stop while we were waiting to retry
        const result = await startEncoder(engine.settings, { fromReconnect: true });
        if (!result.ok) {
            engine.lastError = result.error;
            // Logged so a repeatedly-failing reconnect is visible rather
            // than looking like silence.
            console.log(`[stream-engine] Reconnect attempt failed (${result.error}) — will keep trying; recording is unaffected`);
            scheduleReconnect();
        }
    }, backoff);
}

// 🛠 SECOND PATH THAT KILLED THE STREAM FOR GOOD.
//
// The two compositor failures below used to clear engine.desiredLive --
// the operator's INTENT to be live -- on any failure. That is right when
// the operator has just pressed Go Live and nothing is running yet: the
// start failed, they get the error, and the engine should not sit there
// pretending it is trying.
//
// It is badly wrong during a RECONNECT. scheduleReconnect() calls this,
// and its next scheduled attempt begins with
// `if (!engine.desiredLive) return;`. So if the compositor happened to be
// mid-restart (its own watchdog restarts it after 10s without video --
// exactly the sort of thing that happens while a connection is flapping),
// one failed attach cleared the intent and the ENTIRE reconnect loop went
// silent. Same symptom as the misclassified network error: the stream
// never came back, with nothing in the log saying it had stopped trying.
//
// `opts.fromReconnect` keeps the intent intact for retry-driven calls, so
// only the operator -- or a genuinely fatal fault -- can end a live push.
async function startEncoder({ resolution, fps, bitrateKbps, keyframeIntervalSec }, opts) {
    const fromReconnect = !!(opts && opts.fromReconnect);
    if (engine.state === 'live' || engine.state === 'starting') {
        return { ok: false, error: 'Already live — stop the current stream first' };
    }
    if (!NATIVE_CAPTURE_SUPPORTED) return { ok: false, error: `Native capture (gdigrab/dshow) requires Windows — this process is running on ${process.platform}` };
    if (!streamUrl) return { ok: false, error: 'No Stream URL set' };
    if (!isValidRtmpUrl(streamUrl)) return { ok: false, error: 'Stream URL must start with rtmp:// or rtmps://' };
    if (!streamKey) return { ok: false, error: 'No Stream Key set' };
    if (!engine.matchId) return { ok: false, error: 'No matchId — Go Live must be started from the Cricket Panel with a match selected' };
    if (!engine.audioDeviceName) return { ok: false, error: 'No audio device selected — pick one under Live Studio first' };
    if (NATIVE_PROGRAM_FEED && !engine.cameraDeviceName) return { ok: false, error: 'No camera device selected — pick one under Live Studio first' };
    const nvenc = checkNvenc();
    if (!nvenc.available) {
        return { ok: false, error: `NVENC not available (${nvenc.detail}) — refusing to fall back to CPU encoding` };
    }

    resetMetrics();
    const resolved = resolveEncodeSettings({ resolution, fps, bitrateKbps, keyframeIntervalSec });
    engine.settings = resolved;
    engine.state = 'starting';
    engine.desiredLive = true;
    engine.lastError = null;

    // The destination (Stream URL + Stream Key) is built fresh from
    // current config, never logged, never included in engine.settings
    // (which /health exposes) — only passed straight to ffmpeg's argv.
    const destinationUrl = buildDestinationUrl(streamUrl, streamKey);

    let proc;
    if (NATIVE_PROGRAM_FEED) {
        // See nativePipeline.js's header comment: camera+overlay
        // compositor (opened once, shared with the recorder if that's
        // also running) relays to THIS process, which holds its own
        // independent NVENC session and pushes RTMPS — a network
        // problem here can never touch the recorder, and vice versa.
        const compResult = await ensureCompositor({ matchId: engine.matchId, mainServerUrl: engine.mainServerUrl, cameraDeviceName: engine.cameraDeviceName, audioDeviceName: engine.audioDeviceName, who: 'live' });
        if (!compResult.ok) {
            engine.state = 'idle';
            // A reconnect must keep trying: the compositor may simply be
            // mid-restart and back in a second.
            if (!fromReconnect) engine.desiredLive = false;
            return { ok: false, error: compResult.error };
        }
        engine.holdsCompositorRef = true;
        const args = nativePipeline.buildLiveEncoderArgs({ ...resolved, destinationUrl, useTune: checkNvencTuneRuntime() });
        proc = spawnFfmpeg(args, { stdio: ['pipe', 'ignore', 'pipe'] }, 'live-encoder');
        // Joins the running relay at its next packet — never restarts the
        // compositor and never disturbs the recorder (see nativePipeline.js).
        const attachResult = compositor ? compositor.attachRelayConsumer(proc, 'live') : { ok: false, error: 'Native compositor stopped while the live encoder was starting' };
        if (!attachResult.ok) {
            try { proc.kill('SIGKILL'); } catch (e) {}
            engine.state = 'idle';
            if (!fromReconnect) engine.desiredLive = false;
            releaseLiveCompositorRef();
            return { ok: false, error: attachResult.error || 'Could not attach to the native compositor relay' };
        }
    } else {
        const windowTitle = resolveWindowTitle(engine.matchId);
        const args = buildLiveEncoderArgs({ windowTitle, audioDeviceName: engine.audioDeviceName, ...resolved, destinationUrl });
        proc = spawnFfmpeg(args, { stdio: ['pipe', 'ignore', 'pipe'] }, 'live-encoder');
    }
    setProcessPriority(proc, os.constants.priority.PRIORITY_ABOVE_NORMAL);
    engine.proc = proc;
    engine.startedAt = Date.now();
    if (!engine.adapting && engine.reconnect.attempts === 0) console.log(`[stream-engine] Live stream started — ${resolved.resolution} ${resolved.fps}fps @ ${resolved.bitrateKbps}kbps`);
    engine.lastProgressAdvanceAt = null;
    engine.lastOutTimeSec = 0;
    engine.state = 'live';
    proc.stdin.on('error', () => {}); // legacy path: stdin is only ever used for the graceful 'q' stop (see gracefulStop); native path: this IS the compositor's relay input — a write after it's already gone is harmless either way

    const logLiveLine = makeRepeatSuppressingLogger('[live-encoder]');
    proc.stderr.on('data', createLineReader((line) => {
        if (PROGRESS_LINE_RE.test(line)) {
            parseProgressLine(line);
            const outSec = progressOutTimeSec(line);
            if (outSec !== null && outSec > engine.lastOutTimeSec) {
                engine.lastOutTimeSec = outSec;
                engine.lastProgressAdvanceAt = Date.now();
            }
            return;
        }
        // 🩹 A line matching a known FATAL pattern (e.g. "Unrecognized
        // option 'tune'.") is the one line worth keeping — ffmpeg
        // reliably follows it with a generic wrap-up line ("Error
        // splitting the argument list: Option not found") that also
        // matches the plain /error/ test below but explains nothing
        // on its own. The old code kept whichever matching line came
        // LAST, so that generic follow-up always won and silently
        // buried the actionable reason — which then also meant
        // isFatalError(engine.lastError) came back false and a real,
        // permanent config error (wrong option) was misclassified as
        // a network blip and retried forever instead of surfacing as
        // crashed. Once a fatal line is captured, don't let a later
        // non-fatal "error/failed" line overwrite it.
        if (isFatalError(line)) {
            engine.lastError = line;
        } else if (!isFatalError(engine.lastError) && /error|failed|refused|denied/i.test(line)) {
            engine.lastError = line;
        }
        // Every non-progress line is shown (repeats collapsed) — ffmpeg
        // usually prints the underlying OS reason next to a failure.
        if (!BENIGN_FFMPEG_LINE_RE.test(line)) logLiveLine(line);
    }));

    // Once this process has survived a few seconds without exiting, treat
    // the connection as genuinely re-established and reset the reconnect
    // attempt counter — otherwise a stream that's been flapping for an
    // hour would keep reporting attempt #40 forever even after it's fine.
    const stabilizeTimer = setTimeout(() => {
        if (engine.proc !== proc) return;
        engine.reconnect.attempts = 0;
        // Also clear the BOUNDED fatal-restart tally. It exists to stop a
        // genuine config fault (no encoder, full disk) looping forever, and
        // a push that has been healthy for five seconds is evidence there
        // is no such fault. Without this, three unrelated hiccups spread
        // across a long match could still add up and stop the stream for
        // good -- the same "gives up mid-match" failure this is meant to
        // prevent. The recorder already resets its own tally this way.
        engine.restarts = [];
    }, 5000);

    proc.on('exit', (code, signal) => {
        // Same defensive guard as the recorder below — a stale process's
        // own exit must never clobber a newer one already tracked in
        // engine.proc.
        if (engine.proc !== proc) return;
        clearTimeout(stabilizeTimer);
        const wasDesired = engine.desiredLive && !shuttingDown;
        engine.proc = null;
        if (compositor) compositor.detachRelayConsumer(proc); // defensive cleanup even on a path that didn't go through stopEncoder (e.g. a genuine crash) — no-op/harmless in legacy mode

        if (!wasDesired) {
            // Operator pressed STOP (or this is our own ABR hot-restart
            // stopping the old process on purpose) — the expected, graceful path.
            engine.state = 'idle';
            if (!engine.adapting && !shuttingDown) console.log('[stream-engine] Live stream stopped.');
            return;
        }
        console.log(`[stream-engine] Live encoder exited unexpectedly (code=${code}, signal=${signal})${engine.lastError ? ` — ${engine.lastError}` : ''}`);

        const errMsg = engine.lastError || `ffmpeg exited unexpectedly (code=${code}, signal=${signal})`;
        engine.lastError = errMsg;

        if (isFatalError(errMsg)) {
            // A config/hardware/"window not found" problem, not the
            // network — retrying forever won't fix it, so this keeps a
            // bounded auto-restart safety net (in case it was transient,
            // e.g. the window reappearing a moment later) and eventually
            // surfaces 'crashed' for the operator to act on.
            engine.state = 'crashed';
            const now = Date.now();
            engine.restarts = engine.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
            if (engine.restarts.length >= MAX_AUTO_RESTARTS) {
                console.log('[stream-engine] Fatal-looking error, max auto-restarts hit — giving up until operator presses Go Live again');
                engine.desiredLive = false;
                return;
            }
            engine.restarts.push(now);
            const attempt = engine.restarts.length;
            console.log(`[stream-engine] Auto-restarting encoder after fatal-looking error (attempt ${attempt}/${MAX_AUTO_RESTARTS})…`);
            setTimeout(async () => {
                if (engine.desiredLive && !shuttingDown) await startEncoder(engine.settings, { fromReconnect: true }).catch((e) => console.log('[stream-engine] fatal-error auto-restart threw:', e.message));
            }, Math.min(2000 * attempt, 8000));
            return;
        }

        // Everything else (connection reset, broken pipe, timeout, i/o
        // error, etc.) is treated as the internet going up and down —
        // never let a live sports stream just give up over this.
        scheduleReconnect();
    });

    proc.on('error', (err) => {
        // A spawn failure never emits 'exit' — without this the stream
        // would silently stay down while the operator still wants it live.
        console.log('[stream-engine] live encoder ffmpeg spawn error:', err.message);
        engine.lastError = err.message;
        if (engine.proc !== proc || proc.pid) return; // only a failed spawn (no pid) — any other error is followed by a normal 'exit'
        engine.proc = null;
        if (compositor) compositor.detachRelayConsumer(proc);
        if (engine.desiredLive && !shuttingDown) scheduleReconnect();
        else engine.state = 'crashed';
    });

    return { ok: true };
}

function releaseLiveCompositorRef() {
    if (!engine.holdsCompositorRef) return;
    engine.holdsCompositorRef = false;
    releaseCompositor('live');
}

// forRestart: an ABR hot-restart stops and immediately restarts the
// encoder — it keeps its compositor ref so the camera/compositor aren't
// torn down and relaunched in between when nothing else holds one.
function stopEncoder({ forRestart = false } = {}) {
    engine.desiredLive = false;
    if (!engine.proc) {
        engine.state = 'idle';
        // Stop pressed while a reconnect was pending: nothing is running,
        // but the compositor ref from the last attempt must still be
        // released, or the camera would stay open after Stop.
        if (NATIVE_PROGRAM_FEED && !forRestart) releaseLiveCompositorRef();
        return { ok: true, alreadyIdle: true };
    }
    engine.state = 'stopping';
    if (NATIVE_PROGRAM_FEED) {
        if (compositor) compositor.detachRelayConsumer(engine.proc);
        gracefulStopByClosingStdin(engine.proc);
        if (!forRestart) releaseLiveCompositorRef();
    } else {
        gracefulStop(engine.proc);
    }
    return { ok: true };
}

function resolveEncodeSettings({ resolution, fps, bitrateKbps, keyframeIntervalSec }) {
    const resKey = RESOLUTIONS[resolution] ? resolution : '1080p';
    const fpsNum = [30, 60].includes(Number(fps)) ? Number(fps) : 30;
    const { width, height } = RESOLUTIONS[resKey];
    const kbps = Number(bitrateKbps) > 0 ? Number(bitrateKbps) : DEFAULT_BITRATE_KBPS[resKey][fpsNum];
    const gopSec = Number(keyframeIntervalSec) > 0 ? Number(keyframeIntervalSec) : 2;
    return { width, height, fps: fpsNum, bitrateKbps: kbps, keyframeIntervalSec: gopSec, resolution: resKey };
}

// ================================================================
// 🎞️ LOCAL FULL-MATCH MASTER RECORDING — a fully independent native
// ffmpeg process (its own gdigrab+dshow capture, its own NVENC session)
// from the live YouTube push above. Nothing about the live push
// (reconnects, ABR restarts, crashes) can EVER affect this process —
// they don't share a byte-stream, a pipe, or any other coupling; they
// are simply two separate ffmpeg invocations both reading the same
// on-screen window and the same audio device, which is a safe thing to
// do twice (see the header comment's "Why two processes" note) unlike
// opening an exclusive hardware capture-card device twice.
// Fixed quality regardless of network — a bad connection degrades the
// LIVE STREAM only; this keeps recording at its own resolution/bitrate
// the whole time Recording is running.
// ================================================================
const RECORDING_ROOT = path.join(DATA_ROOT, 'Recordings');
try { fs.mkdirSync(RECORDING_ROOT, { recursive: true }); } catch (e) { /* created lazily per-match anyway */ }
// Real, final MP4 clip files — cut STRICTLY from RECORDING_ROOT's
// master.mp4 (see cutLocalClip/findRecordingSegmentFor below), never
// from YouTube, HLS, or any browser-side source.
// 🩹 Operator ask, confirmed reasonable: clips should land in the SAME
// per-match folder as master.mp4, not a separate Clips/ tree — one place
// to look for everything from a given match. RECORDING_ROOT itself, not
// a sibling.
const CLIPS_ROOT = RECORDING_ROOT;
// Deliberately independent of the live-stream ABR ladder — this is a
// fixed local recording quality, never adapted to network conditions.
const RECORDING_BITRATE_KBPS = { '480p': 2500, '720p': 5000, '1080p': 8000 };

function recorderDir(matchId) {
    return path.join(RECORDING_ROOT, safeMatchId(matchId));
}

// ================================================================
// 🧪 NATIVE PIPELINE WIRING (opt-in — see NATIVE_PROGRAM_FEED above).
// ONE Compositor instance shared by the recorder and live encoder
// below — created on first use for whichever match asks for it first,
// torn down once neither recording nor streaming needs it any more
// (see Compositor.addRef/removeRef in nativePipeline.js). Matches the
// same reference-counting pattern cricket-panel.html already uses for
// the old Live Output window (ensureLiveOutputWindow/
// releaseLiveOutputWindowIfUnused) — the same idea, one level down.
// ================================================================
let compositor = null; // the single Compositor instance for whichever match is currently active
let compositorStopping = null; // promise while a released compositor is still shutting down (camera not yet free)

// Only ONE match's compositor can sensibly run at a time (mirrors the
// recorder's own existing "already recording a different match" guard
// below) — a genuine multi-match-simultaneously native pipeline isn't
// implemented; the operator stops the previous match first, same as today.
async function ensureCompositor({ matchId, mainServerUrl, cameraDeviceName, audioDeviceName, who }) {
    // A compositor that was just released may still hold the camera for
    // a moment — starting a new one before it has exited fails with
    // "device busy" (an exclusive dshow device can only be opened once).
    if (compositorStopping) await compositorStopping;
    if (shuttingDown) return { ok: false, error: 'Stream Engine is shutting down' };
    if (compositor && compositor.matchId !== matchId) {
        return { ok: false, error: `Native compositor already running for a different match ("${compositor.matchId}") — stop that first` };
    }
    if (!compositor) {
        if (!mainServerUrl) return { ok: false, error: 'mainServerUrl required to build the overlay URL for the native compositor' };
        const execPath = resolveCaptureBrowserExecutable();
        if (!execPath) return { ok: false, error: 'Could not find Chrome or Edge on this PC for the overlay renderer (see resolveCaptureBrowserExecutable) — set CAPTURE_BROWSER_PATH to its full .exe path' };
        const { width, height } = RESOLUTIONS[recorder.settings ? recorder.settings.resolution : '1080p'] || RESOLUTIONS['1080p'];
        compositor = new nativePipeline.Compositor({
            spawnFfmpeg,
            execPath,
            overlayUrl: `${String(mainServerUrl).replace(/\/+$/, '')}/cricket-overlay?room=${encodeURIComponent(matchId)}`,
            width, height, fps: 30,
        });
        compositor.matchId = matchId;
    }
    const comp = compositor;
    const hadRef = comp.refs.has(who); // a retry by a holder that still wants the feed keeps its ref on failure (the compositor keeps self-healing)
    comp.addRef(who); // before awaiting, so a concurrent release can't stop it out from under this start
    const result = await comp.ensureRunning({ cameraDeviceName, audioDeviceName });
    if (!result.ok) {
        if (!hadRef && comp === compositor) releaseCompositor(who);
        return result;
    }
    if (comp !== compositor) return { ok: false, error: 'Native compositor was stopped while starting' };
    return { ok: true };
}
function releaseCompositor(who) {
    if (!compositor) return;
    if (compositor.removeRef(who) > 0) return;
    const comp = compositor;
    compositor = null;
    const stopping = comp.stop().finally(() => { if (compositorStopping === stopping) compositorStopping = null; });
    compositorStopping = stopping;
}

const recorder = {
    state: 'idle',            // idle | starting | recording | stopping | crashed
    proc: null,
    matchId: null,
    audioDeviceName: null,
    cameraDeviceName: null,    // native dshow device name — only used when NATIVE_PROGRAM_FEED is on
    mainServerUrl: null,       // origin used to build the overlay URL for the native compositor — only used when NATIVE_PROGRAM_FEED is on
    desiredRecording: false,
    startedAt: null,          // when the CURRENT segment started (not the whole match, if it had to restart)
    segmentPath: null,
    segments: [],             // [{path, startedAt}] — normally just one; more than one only if a crash forced a new file (see below)
    settings: null,           // {resolution, width, height, fps, bitrateKbps}
    restarts: [],             // recent unexpected-exit restarts (drives backoff; cleared once a segment runs stably)
    totalRestarts: 0,
    lastError: null,
    lastProgramFeedHealth: null, // {ok, black, white, frozen, checkedAt} — see runProgramFeedHealthCheck/monitorProgramFeedHealth
    holdsCompositorRef: false,
    currentSegment: null,     // the segment the running process is writing
    lastProgressAdvanceAt: null, // last time ffmpeg's reported output time moved forward
    lastSizeBytes: null,
    lastSizeChangeAt: null,
};

// 🎯 WALL CLOCK → RECORDING TIMELINE. Each segment keeps an anchor: the
// wall-clock moment its file time 0 corresponds to, derived from the
// recorder's own -progress reports (anchor = now − out_time). The minimum
// over the last minute is used — out_time can only lag real time, never
// lead it, so the minimum is the tightest estimate, and the sliding
// window follows any slow clock drift over a 7-hour match. The old
// mapping used the moment the ffmpeg process was SPAWNED, which is
// seconds earlier than its first frame: every clip window landed late,
// and its end ran past what had been written — short clips.
const ANCHOR_WINDOW_MS = 60000;
function noteRecorderProgress(seg, outTimeSec) {
    const now = Date.now();
    if (outTimeSec > (seg.outTimeSec || 0)) {
        seg.outTimeSec = outTimeSec;
        seg.lastProgressWall = now;
        recorder.lastProgressAdvanceAt = now;
    }
    if (outTimeSec <= 0) return;
    const samples = seg.anchorSamples;
    samples.push([now, now - outTimeSec * 1000]);
    while (samples.length && now - samples[0][0] > ANCHOR_WINDOW_MS) samples.shift();
    let min = Infinity;
    for (const [, a] of samples) if (a < min) min = a;
    seg.anchorMs = Math.round(min);
}
// Seconds into `seg`'s own file for a wall-clock instant.
function segmentTimeFor(seg, wallMs) {
    const base = seg.anchorMs != null ? seg.anchorMs : seg.startedAt;
    return (wallMs - base) / 1000;
}

function buildRecorderArgs({ windowTitle, audioDeviceName, width, height, fps, bitrateKbps, outFile }) {
    // GPU (NVENC) preferred over CPU (libx264) by operator request — the
    // recorder shares the same GPU-encode approach as the live push
    // rather than load the CPU at all. Only falls back to libx264 if
    // this machine genuinely has no working NVENC, checked with a real
    // throwaway encode (checkNvencRuntime), not just that the build
    // lists it — CPU-only laptops still need a working recorder either way.
    const useNvenc = checkNvencRuntime();
    if (!useNvenc) checkLibx264(); // NVENC unusable — log whether the CPU fallback itself is expected to work
    const useGpuScale = checkGpuScaleRuntime();
    const videoArgs = useNvenc
        ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-b:v', `${bitrateKbps}k`, '-maxrate', `${Math.round(bitrateKbps * 1.3)}k`]
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${bitrateKbps}k`];
    return [
        '-hide_banner', '-loglevel', 'warning',
        ...buildCaptureInputArgs({ windowTitle, fps, audioDeviceName }),
        '-map', '0:v', '-map', '1:a',
        '-vf', cropScaleFilter(width, height, useNvenc && useGpuScale),
        '-r', String(fps),
        ...cfrFlagArgs(),
        ...videoArgs,
        // A short (2s) GOP is what actually makes the crash-safety below
        // real: fragments close (and flush to disk) on every keyframe,
        // so at most ~2s of footage is ever at risk if the process is
        // killed. libx264's own default keyint (250 frames, ~8s at
        // 30fps) would leave a much bigger unflushed/unplayable window.
        '-g', String(fps * 2), '-keyint_min', String(fps * 2),
        '-af', 'aresample=async=1:first_pts=0',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
        // Fragmented MP4: writes a valid, playable file incrementally as
        // it records (a moof+mdat per GOP) instead of one index (moov)
        // written only at a clean close — so a laptop crash, a killed
        // process, or an abrupt Stream Engine stop leaves a real,
        // playable MP4 up to the last flushed fragment, never a
        // zero-byte or "moov atom not found" unplayable file.
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-flush_packets', '1',
        '-max_muxing_queue_size', '4096',
        // Parsed, never printed — see noteRecorderProgress/superviseRecorder.
        '-progress', 'pipe:2', '-nostats',
        '-f', 'mp4',
        outFile,
    ];
}

// isRetry: an automatic restart after the recorder exited unexpectedly.
// A failed retry keeps the operator's intent (desiredRecording) and just
// schedules the next attempt — it never silently turns recording off.
async function startRecorder(matchId, { resolution, fps, audioDeviceName, cameraDeviceName, mainServerUrl } = {}, { isRetry = false } = {}) {
    if (recorder.state === 'recording' || recorder.state === 'starting') {
        if (recorder.matchId === matchId) return { ok: true, alreadyRecording: true };
        return { ok: false, error: `Already recording match "${recorder.matchId}" — stop that first` };
    }
    if (shuttingDown) return { ok: false, error: 'Stream Engine is shutting down' };
    if (!NATIVE_CAPTURE_SUPPORTED) return { ok: false, error: `Native capture (gdigrab/dshow) requires Windows — this process is running on ${process.platform}` };
    if (!audioDeviceName) return { ok: false, error: 'No audio device selected — pick one under Live Studio first' };
    if (NATIVE_PROGRAM_FEED && !cameraDeviceName) return { ok: false, error: 'No camera device selected — pick one under Live Studio first' };
    const resKey = RESOLUTIONS[resolution] ? resolution : '1080p';
    const fpsNum = [30, 60].includes(Number(fps)) ? Number(fps) : 30;
    const { width, height } = RESOLUTIONS[resKey];
    const bitrateKbps = RECORDING_BITRATE_KBPS[resKey];

    const fail = (error) => {
        recorder.state = isRetry ? 'crashed' : 'idle';
        recorder.lastError = error;
        if (isRetry && recorder.desiredRecording && !shuttingDown) {
            scheduleRecorderRestart(`restart attempt failed: ${error}`);
        } else {
            recorder.desiredRecording = false;
            if (NATIVE_PROGRAM_FEED) releaseRecorderCompositorRef();
        }
        return { ok: false, error };
    };

    const dir = recorderDir(matchId);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return fail(`Could not create recording folder: ${e.message}`); }

    // 🩹 A recording that runs out of disk mid-write doesn't fail
    // cleanly — it leaves a truncated/corrupted MP4 (see verifyMediaFile)
    // that looks like a real file until someone tries to play it, often
    // hours into a match. Refuse to even START recording below a hard
    // floor, and log a clear warning below LOW_DISK_WARNING_BYTES so the
    // operator can free space before it becomes a real problem instead
    // of discovering it after the match.
    const freeBytes = diskFreeBytes(RECORDING_ROOT);
    const HARD_DISK_FLOOR_BYTES = 300 * 1024 * 1024; // 300MB — not even enough for a few seconds of buffering headroom
    if (freeBytes != null && freeBytes < HARD_DISK_FLOOR_BYTES) {
        return fail(`Only ${(freeBytes / 1024 / 1024).toFixed(0)}MB free on the recording drive — free up disk space before starting recording`);
    }
    if (freeBytes != null && freeBytes < LOW_DISK_WARNING_BYTES) {
        console.log(`[stream-engine] ⚠ LOW DISK SPACE: only ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)}GB free on the recording drive — recording is starting anyway, but free up space soon`);
    }

    recorder.matchId = matchId;
    recorder.audioDeviceName = audioDeviceName;
    recorder.cameraDeviceName = cameraDeviceName || recorder.cameraDeviceName;
    recorder.mainServerUrl = mainServerUrl || recorder.mainServerUrl;
    recorder.desiredRecording = true;
    recorder.settings = { resolution: resKey, width, height, fps: fpsNum, bitrateKbps };
    // Never reuse a name: after a Stream Engine restart the in-memory
    // segment list is empty while master.mp4 from earlier in the same
    // match is still on disk — ffmpeg would then stop to ask "Overwrite?
    // [y/N]" on stdin (hanging, or reading relay bytes as the answer).
    const segmentName = (n) => (n === 1 ? 'master.mp4' : `master_part${n}.mp4`);
    let partNo = recorder.segments.length + 1;
    while (fs.existsSync(path.join(dir, segmentName(partNo)))) partNo++;
    const outFile = path.join(dir, segmentName(partNo));
    recorder.segmentPath = outFile;
    recorder.state = 'starting';
    recorder.startedAt = Date.now();
    recorder.lastError = null;

    let proc;
    if (NATIVE_PROGRAM_FEED) {
        // See nativePipeline.js's header comment for the full shape:
        // camera+overlay compositor (opened once, shared with the live
        // encoder if that's also running) relays to THIS process, which
        // holds its own independent NVENC session and writes master.mp4.
        const compResult = await ensureCompositor({ matchId, mainServerUrl: recorder.mainServerUrl, cameraDeviceName: recorder.cameraDeviceName, audioDeviceName, who: 'recorder' });
        if (!compResult.ok) return fail(compResult.error);
        recorder.holdsCompositorRef = true;
        if (!recorder.desiredRecording || shuttingDown) return fail('Recording was stopped while starting');
        const useNvenc = checkNvencRuntime();
        if (!useNvenc) checkLibx264();
        const args = nativePipeline.buildRecorderEncoderArgs({ width, height, fps: fpsNum, bitrateKbps, outFile, useNvenc });
        proc = spawnFfmpeg(args, { stdio: ['pipe', 'ignore', 'pipe'] }, 'recorder');
        // Joins the running relay at its next packet — the live encoder
        // (if running) is never disturbed (see nativePipeline.js).
        const attachResult = compositor ? compositor.attachRelayConsumer(proc, 'recorder') : { ok: false, error: 'Native compositor stopped while the recorder was starting' };
        if (!attachResult.ok) {
            try { proc.kill('SIGKILL'); } catch (e) {}
            return fail(attachResult.error || 'Could not attach to the native compositor relay');
        }
    } else {
        const windowTitle = resolveWindowTitle(matchId);
        const args = buildRecorderArgs({ windowTitle, audioDeviceName, width, height, fps: fpsNum, bitrateKbps, outFile });
        proc = spawnFfmpeg(args, { stdio: ['pipe', 'ignore', 'pipe'] }, 'recorder');
    }
    setProcessPriority(proc, os.constants.priority.PRIORITY_ABOVE_NORMAL);
    recorder.proc = proc;
    recorder.state = 'recording';
    const seg = { path: outFile, startedAt: recorder.startedAt, anchorMs: null, outTimeSec: 0 };
    Object.defineProperty(seg, 'anchorSamples', { value: [], enumerable: false }); // internal — kept out of /recording-info's JSON
    recorder.segments.push(seg);
    recorder.currentSegment = seg;
    recorder.lastProgressAdvanceAt = null;
    recorder.lastSizeBytes = null;
    recorder.lastSizeChangeAt = null;
    if (!isRetry) console.log(`[stream-engine] Recording started → ${outFile}`);
    proc.stdin.on('error', () => {}); // legacy path: stdin is only ever used for the graceful 'q' stop (see gracefulStop); native path: this IS the compositor's relay input

    const logRecorderLine = makeRepeatSuppressingLogger('[recorder]');
    proc.stderr.on('data', createLineReader((line) => {
        if (PROGRESS_LINE_RE.test(line)) {
            const outSec = progressOutTimeSec(line);
            if (outSec !== null) noteRecorderProgress(seg, outSec);
            return;
        }
        // Same reasoning as the live encoder's stderr handler above —
        // keep a specific FATAL-pattern line (e.g. "Can't find
        // window") over a later generic "error/failed/invalid" line
        // that would otherwise silently overwrite it with something
        // less actionable.
        if (isFatalError(line)) {
            recorder.lastError = line;
        } else if (!isFatalError(recorder.lastError) && /error|failed|invalid/i.test(line)) {
            recorder.lastError = line;
        }
        if (!BENIGN_FFMPEG_LINE_RE.test(line)) logRecorderLine(line);
    }));

    let exitHandled = false;
    const onGone = (code, signal, spawnError) => {
        // A stale/superseded process's own exit must never clobber a
        // NEWER recording that's since taken over recorder.proc — only
        // the process CURRENTLY tracked gets to mutate shared state.
        if (exitHandled || recorder.proc !== proc) return;
        exitHandled = true;
        const wasDesired = recorder.desiredRecording && !shuttingDown;
        recorder.proc = null;
        recorder.currentSegment = null;
        if (compositor) compositor.detachRelayConsumer(proc); // no-op/harmless in legacy mode (compositor is always null there)
        if (!wasDesired) {
            recorder.state = 'idle';
            if (!shuttingDown) console.log(`[stream-engine] Recording stopped — saved ${outFile}`);
            if (NATIVE_PROGRAM_FEED && !recorder.desiredRecording) releaseRecorderCompositorRef();
            return;
        }
        // Unexpected exit while the operator still wants to be
        // recording — never silently stop capturing the match. Start a
        // NEW segment file (fragmented MP4 can't simply be appended to
        // after the process that owns it exits); every segment stays
        // playable on its own, up to its last flushed fragment.
        recorder.state = 'crashed';
        recorder.lastError = recorder.lastError || (spawnError ? `recorder ffmpeg could not start: ${spawnError.message}` : `recorder ffmpeg exited unexpectedly (code=${code}, signal=${signal})`);
        // Note: this does NOT release the compositor — it's still needed
        // for the retry (and the compositor self-heals if it died too).
        scheduleRecorderRestart(recorder.lastError);
    };
    proc.on('exit', (code, signal) => onGone(code, signal, null));
    // A spawn failure never emits 'exit' — without this, recording would
    // silently stay stopped.
    proc.on('error', (err) => { recorder.lastError = err.message; if (!proc.pid) onGone(null, null, err); });

    return { ok: true };
}

// 🩹 Recording must never stop on its own; only "Stop Recording" ends it.
// Backoff grows per consecutive failure (capped at 15s — Windows/
// antivirus can hold a just-closed file for a moment) and resets once a
// segment has run stably (see superviseRecorder), so a recovery hours
// into a match isn't penalized for one much earlier.
function scheduleRecorderRestart(reason) {
    if (recorder.restartTimer || shuttingDown || !recorder.desiredRecording) return;
    recorder.restarts.push(Date.now());
    recorder.totalRestarts++;
    const attempt = recorder.restarts.length;
    const retryDelayMs = Math.min(1500 * attempt, 15000);
    console.log(`[stream-engine] Recorder stopped unexpectedly (${reason}) — continuing in a new segment in ${(retryDelayMs / 1000).toFixed(1)}s (attempt ${attempt}); streaming is unaffected`);
    recorder.restartTimer = setTimeout(() => {
        recorder.restartTimer = null;
        if (!recorder.desiredRecording || shuttingDown) return;
        startRecorder(recorder.matchId, { resolution: recorder.settings.resolution, fps: recorder.settings.fps, audioDeviceName: recorder.audioDeviceName, cameraDeviceName: recorder.cameraDeviceName, mainServerUrl: recorder.mainServerUrl }, { isRetry: true })
            .then((r) => { if (r.ok) console.log(`[stream-engine] Recorder resumed → ${recorder.segmentPath}`); })
            .catch((e) => { console.log('[stream-engine] recorder auto-restart threw:', e.message); scheduleRecorderRestart(e.message); });
    }, retryDelayMs);
}

function releaseRecorderCompositorRef() {
    if (!recorder.holdsCompositorRef) return;
    recorder.holdsCompositorRef = false;
    releaseCompositor('recorder');
}

function stopRecorder() {
    recorder.desiredRecording = false;
    if (recorder.restartTimer) { clearTimeout(recorder.restartTimer); recorder.restartTimer = null; }
    if (!recorder.proc) {
        recorder.state = 'idle';
        if (NATIVE_PROGRAM_FEED) releaseRecorderCompositorRef(); // Stop pressed during a restart backoff — still free the camera
        return { ok: true, alreadyIdle: true };
    }
    recorder.state = 'stopping';
    const proc = recorder.proc;
    if (NATIVE_PROGRAM_FEED) {
        if (compositor) compositor.detachRelayConsumer(proc); // stop feeding before closing stdin — ends exactly on a packet boundary
        gracefulStopByClosingStdin(proc);
        releaseRecorderCompositorRef();
    } else {
        gracefulStop(proc);
    }
    return { ok: true };
}

function resetRecorderForNewMatch() {
    recorder.segments = [];
    recorder.restarts = [];
    recorder.totalRestarts = 0;
}

// Best-effort free disk space for the recordings volume — Node 18.15+
// has fs.statfs; older Node just reports null rather than failing here.
function diskFreeBytes(dir) {
    try {
        if (typeof fs.statfsSync !== 'function') return null;
        const s = fs.statfsSync(dir);
        return s.bavail * s.bsize;
    } catch (e) { return null; }
}

// ================================================================
// 🎬 CLIP ENGINE — forwards finished clips to the EXISTING
// /api/clips/ingest on server.js — same endpoint ClipperHelper.exe
// always posted to, same Cloudflare/Drive/Mongo pipeline, untouched.
// ================================================================
// 🎯 EXACT CLIP TIMING — non-negotiable. T0 is the click/event moment
// (the panel captures it and sends it as `timestamp`, already frozen
// against the finalized ball's own metadata — see triggerClip() in
// cricket-panel.html). The clip is T0-15s through T0+5s (~20s total).
// The post-roll 5 seconds are an ACTUAL WAIT before cutting — the
// master recording simply doesn't have footage from the future yet.
// T0 itself is captured once and never recalculated after the wait.
const CLIP_PRE_ROLL_SEC = 15;
const CLIP_POST_ROLL_SEC = 5;
// Caps the CLIP's width only (never upscales) — the live/master
// recording keep their full selected resolution; this only shrinks the
// short highlight clip that gets uploaded over the operator's own
// upload bandwidth, which is the actual bottleneck for "clip takes a
// long time to upload" on a typical home connection.
const CLIP_MAX_WIDTH = 1280;

const recordingMatches = {}; // matchId -> { mainServerUrl, tournamentId } — set by /recording-start, used to resolve where a clip forwards to
const clipWorker = {
    state: 'idle', // idle | cutting | uploading — derived from the clip queue (see refreshClipWorkerState)
    lastError: null,
    cloudflareConnected: true, // optimistic until a forward attempt actually fails
    queued: 0,
    activeCuts: 0,
};
// ================================================================
// 🎬 PERSISTENT CLIP JOBS — one per accepted FOUR/SIX/WICKET event,
// never silently canceled once created (see acceptClipEvent below).
// Kept in memory for live status (the panel polls GET /clip-jobs/:clipId)
// AND persisted to disk so a restart doesn't erase the operator's view
// of what was in flight.
//
// Lifecycle: WAITING_FOR_POSTROLL -> CUTTING -> LOCAL_SAVED ->
//            FORWARDING -> COMPLETE
//                        -> RETRY_PENDING (Render reachable, R2/Drive
//                           still finishing — polled from server.js)
//                        -> FAILED_PERMANENT (loud, never silent —
//                           local .mp4 is always kept in the
//                           match's recording folder)
// ================================================================
const CLIP_JOBS_FILE = path.join(__dirname, 'clip-jobs.local.json');
const clipJobs = new Map(); // clipId -> job
function loadClipJobs() {
    try {
        const raw = JSON.parse(fs.readFileSync(CLIP_JOBS_FILE, 'utf8'));
        for (const job of raw) clipJobs.set(job.clipId, job);
    } catch (e) { /* first run, or file doesn't exist yet — nothing to load */ }
}
// Debounced, asynchronous, one write in flight at a time. This used to
// be a synchronous writeFileSync of up to 200 jobs on EVERY status
// change — several per clip, plus one every 3s per clip being polled —
// i.e. repeated blocking disk I/O on the thread that also pumps the
// ~90 MB/s relay to the recorder and live encoder.
const CLIP_JOBS_KEEP_IN_MEMORY = 300;
let clipJobsPersistTimer = null;
let clipJobsWriting = false;
let clipJobsDirty = false;
function serializeClipJobs() {
    return JSON.stringify([...clipJobs.values()].slice(-200));
}
function persistClipJobs() {
    clipJobsDirty = true;
    if (clipJobsPersistTimer || clipJobsWriting) return;
    clipJobsPersistTimer = setTimeout(() => {
        clipJobsPersistTimer = null;
        clipJobsDirty = false;
        clipJobsWriting = true;
        fs.writeFile(CLIP_JOBS_FILE, serializeClipJobs(), () => {
            clipJobsWriting = false;
            if (clipJobsDirty) persistClipJobs();
        });
    }, 1000);
}
function flushClipJobsSync() {
    if (clipJobsPersistTimer) { clearTimeout(clipJobsPersistTimer); clipJobsPersistTimer = null; }
    try { fs.writeFileSync(CLIP_JOBS_FILE, serializeClipJobs()); } catch (e) { /* best effort */ }
}
// Finished jobs beyond the most recent CLIP_JOBS_KEEP_IN_MEMORY are
// dropped from memory so a long match can't grow this map forever.
function pruneClipJobs() {
    if (clipJobs.size <= CLIP_JOBS_KEEP_IN_MEMORY) return;
    for (const [id, job] of clipJobs) {
        if (clipJobs.size <= CLIP_JOBS_KEEP_IN_MEMORY) break;
        if (job.status === 'COMPLETE' || job.status === 'FAILED_PERMANENT') clipJobs.delete(id);
    }
}
function updateJob(clipId, patch) {
    const job = clipJobs.get(clipId);
    if (!job) return;
    Object.assign(job, patch, { updatedAt: Date.now() });
    persistClipJobs();
}
function buildClipId(matchId, eventType, timestamp) {
    return `${safeMatchId(matchId)}_${String(eventType || 'CLIP').toUpperCase()}_${timestamp}`;
}
loadClipJobs();
// 🩹 RESTART RECOVERY: a job still sitting in WAITING_FOR_POSTROLL or
// CUTTING when this process last exited is marked LOUDLY as failed
// instead of silently vanishing — every OTHER job (already
// LOCAL_SAVED/FORWARDING/RETRY_PENDING, whose .mp4 already exists on
// disk) is untouched and keeps being retried normally.
for (const job of clipJobs.values()) {
    if (job.status === 'WAITING_FOR_POSTROLL' || job.status === 'CUTTING') {
        job.status = 'FAILED_PERMANENT';
        job.error = 'Stream Engine restarted before this clip could be cut.';
    }
}
persistClipJobs();

// 🔁 RETRY QUEUE — a clip that cuts fine locally but can't reach
// server.js right now (network blip, Render redeploying, etc.) is
// NEVER discarded. It stays queued and is retried with backoff; the
// local .mp4 is never deleted (clips are kept locally next to master.mp4);
// the retry only stops once server.js has confirmed it received
// the bytes.
const RETRY_QUEUE_FILE = path.join(__dirname, 'retry-queue.local.json');
let retryQueue = [];
try { retryQueue = JSON.parse(fs.readFileSync(RETRY_QUEUE_FILE, 'utf8')); } catch (e) { retryQueue = []; }
function persistRetryQueue() {
    try { fs.writeFileSync(RETRY_QUEUE_FILE, JSON.stringify(retryQueue)); } catch (e) { /* best effort */ }
}

function postFileToServer(mainServerUrl, matchId, eventType, timestamp, ballMeta, filePath, clipId) {
    return new Promise((resolve) => {
        let url;
        try { url = new URL(`/api/clips/ingest?matchId=${encodeURIComponent(matchId)}&eventType=${encodeURIComponent(eventType)}&timestamp=${timestamp}&clipId=${encodeURIComponent(clipId)}`, mainServerUrl); }
        catch (e) { return resolve({ ok: false, error: 'Invalid mainServerUrl' }); }

        let stat;
        try { stat = fs.statSync(filePath); } catch (e) { return resolve({ ok: false, error: 'Clip file missing: ' + e.message }); }

        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'video/mp4',
                'Content-Length': stat.size,
                'X-Ball-Meta': JSON.stringify(ballMeta || {}),
            },
            timeout: 20000,
        }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, body });
                else resolve({ ok: false, error: `server.js responded ${res.statusCode}: ${body.slice(0, 200)}` });
            });
        });
        req.on('error', (err) => resolve({ ok: false, error: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout reaching server.js' }); });
        fs.createReadStream(filePath).pipe(req);
    });
}

// 🔎 POST-FORWARD POLLING — once server.js has ACK'd receipt of the
// file (LOCAL_RECEIVED), R2 + Drive uploads continue there in the
// background and can take a while (or fail and retry there too). This
// is what lets the panel's live status actually reach COMPLETE / show a
// real failure reason, instead of the operator only ever seeing
// "forwarded" and nothing else.
const RENDER_POLL_INTERVAL_MS = 3000;
const RENDER_POLL_MAX_MS = 5 * 60 * 1000; // give up polling after 5 min — server.js's OWN retry sweep keeps going regardless; this just stops this process polling forever
async function pollRenderStatus(job) {
    const deadline = Date.now() + RENDER_POLL_MAX_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, RENDER_POLL_INTERVAL_MS));
        let url;
        try { url = new URL(`/api/clips/status/${encodeURIComponent(job.clipId)}`, job.mainServerUrl); }
        catch (e) { return; }
        const lib = url.protocol === 'https:' ? https : http;
        const body = await new Promise((resolve) => {
            const req = lib.request(url, { method: 'GET', timeout: 5000 }, (res) => {
                let b = ''; res.on('data', (d) => b += d); res.on('end', () => resolve({ code: res.statusCode, body: b }));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
        });
        if (!body || body.code !== 200) continue; // Render/Mongo briefly unreachable — just try again next tick
        let data;
        try { data = JSON.parse(body.body); } catch (e) { continue; }
        if (!data.success) continue;
        updateJob(job.clipId, { status: data.status, r2Status: data.r2Status, driveStatus: data.driveStatus, r2Url: data.r2Url || null, driveUrl: data.driveUrl || null, renderRetryCount: data.retryCount });
        if (data.status === 'COMPLETE') {
            // Render has confirmed BOTH R2 and Drive have this clip. The
            // local copy is KEPT on purpose (operator request): every clip
            // stays in the match's recording folder next to master.mp4.
            console.log(`✅ [CLIP] clipId=${job.clipId} — uploaded to R2 + Drive; local copy kept at ${job.localPath}`);
            return;
        }
        if (data.status === 'FAILED_PERMANENT') return; // done — stop polling; local file is deliberately left in place
    }
}

// 🛠 ROOT-CAUSE FIX (clips stranded by an internet outage longer than
// ~16 minutes).
//
// This used to stop after MAX_RETRY_ATTEMPTS = 20. With the 5s * 1.5^n
// backoff capped at 60s, those 20 attempts are spent in about 15.7
// MINUTES — after which the clip was marked FAILED_PERMANENT and never
// retried again, even though the file was sitting right there on disk and
// the internet came back ten minutes later.
//
// For a 3-hour match on a venue connection that is the wrong behaviour in
// the most damaging way possible: every clip cut during an outage is
// silently abandoned, and the operator finds out afterwards.
//
// The rule now distinguishes the two genuinely different failures:
//
//   • CONNECTIVITY (no internet, DNS fails, host unreachable, timeout):
//     never give up. The local file exists and the upload WILL succeed
//     once the line is back, so keep retrying at a steady interval
//     forever. An outage of any length is survivable.
//
//   • REJECTION (the server answered, and said no — 4xx): that will not
//     fix itself by waiting, so the old attempt limit still applies.
//
// Plus: the moment ANY upload succeeds, the whole queue is flushed at
// once (see flushRetryQueueNow) rather than each clip waiting out its own
// backoff — which is what makes a backlog clear "fatafat" the instant the
// connection returns, instead of trickling out one per minute.
const MAX_RETRY_ATTEMPTS = 20;          // applies to REJECTIONS only (see above)
const OFFLINE_RETRY_INTERVAL_MS = 30000; // steady re-probe while the line is down
// A failure that waiting can actually fix. postFileToServer surfaces the
// underlying socket/DNS error text, so match on that rather than trying to
// enumerate every Node error code.
function isConnectivityFailure(errorText) {
    const e = String(errorText || '').toLowerCase();
    return /enotfound|eai_again|econnrefused|econnreset|etimedout|ehostunreach|enetunreach|epipe|socket hang up|timeout|network|getaddrinfo|request to .* failed|fetch failed/.test(e);
}
function scheduleRetry(entry) {
    const attempt = (entry.attempts || 0);
    // While the line is down, stop escalating the backoff: a steady probe
    // means the backlog starts clearing within seconds of it returning.
    const delayMs = entry.offline
        ? OFFLINE_RETRY_INTERVAL_MS
        : Math.min(5000 * Math.pow(1.5, attempt), 60000);
    entry.timer = setTimeout(() => processRetryEntry(entry), delayMs);
}
// Connectivity is back — retry EVERY queued clip immediately instead of
// letting each one wait out its own timer. Cancelling the pending timer
// first is what stops a clip being retried twice concurrently.
let flushingRetryQueue = false;
function flushRetryQueueNow(reason) {
    if (flushingRetryQueue || !retryQueue.length) return;
    flushingRetryQueue = true;
    const pending = retryQueue.slice();
    console.log(`[stream-engine] 📤 Connection is back (${reason}) — flushing ${pending.length} queued clip(s) now`);
    pending.forEach((entry) => {
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
        entry.offline = false;
        processRetryEntry(entry);
    });
    // Released on the next tick: processRetryEntry is async, and this flag
    // only needs to stop the SAME success re-entering the flush.
    setTimeout(() => { flushingRetryQueue = false; }, 1000);
}
async function processRetryEntry(entry) {
    if (!fs.existsSync(entry.filePath)) {
        retryQueue = retryQueue.filter((e) => e !== entry);
        persistRetryQueue();
        if (entry.clipId) updateJob(entry.clipId, { status: 'FAILED_PERMANENT', error: 'Local clip file was removed before it could be forwarded' });
        return; // was cleaned up (e.g. manually) — nothing left to retry
    }
    entry.attempts = (entry.attempts || 0) + 1;
    entry.timer = null;
    if (entry.clipId) updateJob(entry.clipId, { status: 'RETRY_PENDING', forwardAttempts: entry.attempts });
    const result = await postFileToServer(entry.mainServerUrl, entry.matchId, entry.eventType, entry.timestamp, entry.ballMeta, entry.filePath, entry.clipId);
    if (result.ok) {
        clipWorker.cloudflareConnected = true;
        retryQueue = retryQueue.filter((e) => e !== entry);
        persistRetryQueue();
        console.log(`[stream-engine] Retry succeeded for queued clip: ${entry.matchId}/${entry.eventType}`);
        if (entry.clipId) {
            updateJob(entry.clipId, { status: 'FORWARDING' });
            const job = clipJobs.get(entry.clipId);
            if (job) pollRenderStatus(job);
        }
        // This upload proved the line is back — clear the rest of the
        // backlog at once rather than one-per-backoff.
        flushRetryQueueNow('a queued clip uploaded');
    } else {
        clipWorker.cloudflareConnected = false;
        clipWorker.lastError = result.error;
        const offline = isConnectivityFailure(result.error);
        entry.offline = offline;
        if (offline) {
            // No internet. The file is on disk and the upload will work as
            // soon as the line is back, so this NEVER becomes permanent —
            // it just keeps probing. Logged once per 10 attempts so a long
            // outage doesn't flood the console during a match.
            if (entry.attempts === 1 || entry.attempts % 10 === 0) {
                console.log(`[stream-engine] ⏸ Offline — ${retryQueue.length} clip(s) waiting to upload; will keep retrying every ${OFFLINE_RETRY_INTERVAL_MS / 1000}s and send them all the moment the connection returns (attempt ${entry.attempts}: ${result.error})`);
            }
            if (entry.clipId) updateJob(entry.clipId, { status: 'RETRY_PENDING', error: `Waiting for internet — clip is saved locally at ${entry.filePath} and will upload automatically` });
            persistRetryQueue();
            scheduleRetry(entry);
            return;
        }
        // The server answered and refused. Waiting will not change that, so
        // the original attempt limit still applies.
        if (entry.attempts >= MAX_RETRY_ATTEMPTS) {
            console.log(`[stream-engine] Giving up on queued clip after ${entry.attempts} attempts (kept locally at ${entry.filePath}): ${result.error}`);
            if (entry.clipId) updateJob(entry.clipId, { status: 'FAILED_PERMANENT', error: `Could not reach Render after ${entry.attempts} attempts: ${result.error} (local file kept at ${entry.filePath})` });
            return; // stays in the queue file/disk for manual recovery, just stops auto-retrying
        }
        persistRetryQueue();
        scheduleRetry(entry);
    }
}
// Resume any clips that were still queued from a previous run of this process.
retryQueue.forEach((entry) => scheduleRetry(entry));

// 🔒 CLIP SOURCE = LOCAL MASTER RECORDING, STRICTLY — non-negotiable.
// Clips are cut by seeking directly into the actual recorder segment
// file on disk — never YouTube, never HLS, never a browser blob/chunk,
// never R2/Drive.
//
// Finds which recorder segment (normally just one; more than one only
// if the recorder itself had to restart mid-match) covers an event: the
// latest segment whose timeline had already started at T0.
function findRecordingSegmentFor(eventTimestamp) {
    const segs = recorder.segments;
    for (let i = segs.length - 1; i >= 0; i--) {
        const base = segs[i].anchorMs != null ? segs[i].anchorMs : segs[i].startedAt;
        if (eventTimestamp >= base) return segs[i];
    }
    return segs[0] || null;
}

function clipsDirFor(matchId) {
    const dir = path.join(CLIPS_ROOT, safeMatchId(matchId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// fMP4 fragments are closed (and written) on each keyframe — 2s GOP — so
// footage up to out_time can still be ~2s from being on disk.
const CLIP_FLUSH_MARGIN_SEC = 2.5;
const CLIP_COVERAGE_WAIT_MS = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits until the segment being recorded has actually written the clip's
// last second. The fixed 5s post-roll alone wasn't enough: encoder +
// fragment latency meant the tail of the window often wasn't on disk yet
// when the cut ran, and ffmpeg simply stopped at end-of-file — ~10-15s
// clips instead of 20s, most visibly for back-to-back requests.
async function waitForSegmentCoverage(seg, endSec) {
    const deadline = Date.now() + CLIP_COVERAGE_WAIT_MS;
    while (Date.now() < deadline && !shuttingDown) {
        if (recorder.currentSegment !== seg) return; // segment already finished — what's in it is final
        if ((seg.outTimeSec || 0) >= endSec + CLIP_FLUSH_MARGIN_SEC) return;
        await sleep(250);
    }
}

// Cuts ONE job's window from the recording. Everything it needs comes
// from the job's own frozen `window` — nothing shared, nothing another
// request can overwrite. Returns { ok, outFile } or { ok:false, error, retryable }.
async function cutLocalClip(job) {
    const { clipId, matchId } = job;
    const win = job.window;
    const seg = findRecordingSegmentFor(win.t0);
    if (!seg) {
        return { ok: false, retryable: false, error: `No local master recording available for match "${matchId}" yet — press "Start Recording" first and confirm the recorder is actually running (see /status).` };
    }
    if (!fs.existsSync(seg.path)) {
        return { ok: false, retryable: false, error: `Local master recording file is missing on disk: ${seg.path}` };
    }

    const startSec = segmentTimeFor(seg, win.startWall);
    const endSec = segmentTimeFor(seg, win.endWall);
    if (endSec <= 0) return { ok: false, retryable: false, error: 'This moment is before the start of the recording segment — nothing to cut.' };
    await waitForSegmentCoverage(seg, endSec);
    if (shuttingDown) return { ok: false, retryable: false, error: 'Stream Engine shut down before this clip could be cut.' };

    const fromSec = Math.max(0, startSec);
    // A finished segment can't supply more than it holds (e.g. recording
    // stopped a second after the event) — cut what exists instead of failing.
    const availableEndSec = recorder.currentSegment === seg ? endSec : Math.min(endSec, Math.max(seg.outTimeSec || endSec, fromSec + 1));
    const durationSec = Math.max(1, availableEndSec - fromSec);

    // Deterministic, clipId-based filename — the SAME name server.js's
    // R2 key/Drive filename are derived from. Written to a .part file
    // first and renamed only once verified, so a half-written or failed
    // cut can never be mistaken for (or uploaded as) a finished clip.
    const outFile = path.join(clipsDirFor(matchId), `${clipId}.mp4`);
    const partFile = path.join(clipsDirFor(matchId), `${clipId}.part.mp4`);

    console.log(`[CLIP RANGE] clipId=${clipId} source=${path.basename(seg.path)} file=${fromSec.toFixed(1)}s→${(fromSec + durationSec).toFixed(1)}s (T0-${win.preRollSec}s → T0+${win.postRollSec}s, ${durationSec.toFixed(1)}s)`);

    try {
        await cutFromMasterFile({ clipId, masterFile: seg.path, fromSec, durationSec, outFile: partFile });
    } catch (e) {
        fs.unlink(partFile, () => {});
        return { ok: false, retryable: true, error: e.message };
    }

    // 🩹 A clip whose ffmpeg process exited 0 can still be a corrupted/
    // truncated file — verify it has a valid, playable video stream
    // (asynchronously — see verifyMediaFileAsync) before calling it done.
    const verify = await verifyMediaFileAsync(partFile);
    if (verify.ok === false) {
        fs.unlink(partFile, () => {});
        return { ok: false, retryable: true, error: `Clip file failed integrity check: ${verify.reason}` };
    }
    // Still short although the recording has more by now? The tail wasn't
    // flushed yet — cut again rather than deliver a clipped clip.
    if (verify.ok && verify.durationSec < durationSec - 2 && recorder.currentSegment === seg && (job.cutAttempts || 1) < CLIP_MAX_CUT_ATTEMPTS) {
        fs.unlink(partFile, () => {});
        return { ok: false, retryable: true, error: `Clip came out ${verify.durationSec.toFixed(1)}s instead of ${durationSec.toFixed(1)}s (recording tail not flushed yet)` };
    }
    try {
        await renameWithRetry(partFile, outFile);
    } catch (e) {
        fs.unlink(partFile, () => {});
        return { ok: false, retryable: true, error: `Could not finalize clip file: ${e.message}` };
    }

    console.log(`[CLIP CREATED] clipId=${clipId} localPath=${outFile}${verify.ok === null ? ' (integrity NOT verified — ffprobe unavailable, see bin/README.md)' : ` (verified: ${verify.durationSec.toFixed(1)}s, ${verify.width}x${verify.height})`}`);
    return { ok: true, outFile, durationSec: verify.durationSec || null };
}

// Windows (antivirus, indexer) can hold a just-written file for a moment.
async function renameWithRetry(from, to, attempts = 5) {
    for (let i = 0; ; i++) {
        try {
            await fs.promises.rename(from, to);
            return;
        } catch (e) {
            if (i >= attempts - 1) throw e;
            await sleep(300 * (i + 1));
        }
    }
}

// Seeks directly into the local master.mp4 with -ss BEFORE -i (fast
// input-side seek) and re-encodes only the ~20s window that's needed.
//
// 🔒 GPU SAFETY NET — the recorder and the live encoder each hold their
// own NVENC session the whole time they're running; some GPUs cap
// concurrent sessions. If NVENC refuses, the SAME cut is retried once on
// the CPU (libx264). Recording and the live stream never share this path.
//
// Every cut is a separate, bounded process: BELOW_NORMAL priority (so it
// can never starve real-time capture/encode), killed if it runs longer
// than CLIP_CUT_TIMEOUT_MS, and tracked in activeClipCuts so shutdown
// can stop it.
const CLIP_CUT_TIMEOUT_MS = 120000;
const activeClipCuts = new Map(); // clipId -> ffmpeg proc
async function cutFromMasterFile({ clipId, masterFile, fromSec, durationSec, outFile }) {
    const attempt = (useNvenc) => new Promise((resolve, reject) => {
        const args = [
            '-hide_banner', '-loglevel', 'warning', '-nostats', '-y',
            '-ss', fromSec.toFixed(3), '-i', masterFile, '-t', durationSec.toFixed(3),
            '-vf', `scale='min(iw,${CLIP_MAX_WIDTH})':-2`,
            // NVENC doesn't take -crf; '-rc vbr -cq N' is its equivalent
            // "quality, not fixed bitrate" mode (b:v 0 tells it not to
            // also cap by bitrate).
            ...(useNvenc
                ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26', '-b:v', '0']
                : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26']),
            '-c:a', 'aac', '-b:a', '128k',
            outFile,
        ];
        const proc = spawnFfmpeg(args, { stdio: ['ignore', 'ignore', 'pipe'] }, 'clip-cut');
        setProcessPriority(proc, os.constants.priority.PRIORITY_BELOW_NORMAL);
        activeClipCuts.set(clipId, proc);
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch (e) {} }, CLIP_CUT_TIMEOUT_MS);
        proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
        proc.on('error', (err) => { clearTimeout(timer); activeClipCuts.delete(clipId); reject(err); });
        proc.on('exit', (code, signal) => {
            clearTimeout(timer);
            activeClipCuts.delete(clipId);
            if (code === 0) return resolve();
            if (timedOut) return reject(new Error(`clip cut timed out after ${CLIP_CUT_TIMEOUT_MS / 1000}s and was stopped`));
            reject(new Error(`ffmpeg clip cut (${useNvenc ? 'NVENC' : 'CPU'}) exited ${code ?? signal}: ${stderr.trim().slice(-400)}`));
        });
    });

    const preferNvenc = checkNvencRuntime();
    try {
        await attempt(preferNvenc);
    } catch (e) {
        if (!preferNvenc || shuttingDown || /timed out/.test(e.message)) throw e; // CPU attempt already, or a stuck read — the job-level retry handles it
        console.log(`[stream-engine] Clip cut failed on NVENC (likely the GPU's concurrent-session limit while recording+live are running), retrying on CPU: ${e.message.split('\n')[0]}`);
        await attempt(false);
    }
}

// ================================================================
// 🎬 CLIP JOB QUEUE — every accepted event becomes its own job with an
// immutable window (T0, start, end) frozen at acceptance. Jobs wait for
// their own post-roll independently, then enter a FIFO cut queue served
// by at most CLIP_MAX_CONCURRENT_CUTS workers. A failed cut is cleaned
// up and retried with backoff (up to CLIP_MAX_CUT_ATTEMPTS) WITHOUT
// holding a worker, so the next clip always proceeds; a job that still
// fails is marked FAILED_PERMANENT loudly and the queue moves on.
// Uploads run after the worker is released — a slow upload never delays
// the next cut. Nothing here touches the recorder, the live encoder or
// the compositor.
// ================================================================
const CLIP_MAX_CONCURRENT_CUTS = 2;
const CLIP_MAX_CUT_ATTEMPTS = 3;
const CLIP_CUT_RETRY_DELAYS_MS = [3000, 8000];
const clipCutQueue = [];            // clipIds whose post-roll is over, waiting for a worker
const clipTimers = new Set();       // post-roll/retry timers (cleared on shutdown)
let clipCutsRunning = 0;
let clipUploadsInFlight = 0;
const clipStats = { cut: 0, failed: 0, retried: 0 };

function refreshClipWorkerState() {
    clipWorker.state = clipCutsRunning > 0 ? 'cutting' : clipUploadsInFlight > 0 ? 'uploading' : 'idle';
    clipWorker.queued = clipCutQueue.length;
    clipWorker.activeCuts = clipCutsRunning;
}
function clipTimer(fn, ms) {
    const t = setTimeout(() => { clipTimers.delete(t); fn(); }, ms);
    clipTimers.add(t);
}
function enqueueClipCut(clipId) {
    if (shuttingDown || clipCutQueue.includes(clipId)) return;
    clipCutQueue.push(clipId);
    pumpClipQueue();
}
function pumpClipQueue() {
    while (!shuttingDown && clipCutsRunning < CLIP_MAX_CONCURRENT_CUTS && clipCutQueue.length) {
        const clipId = clipCutQueue.shift();
        clipCutsRunning++;
        refreshClipWorkerState();
        runClipCut(clipId)
            .catch((e) => console.log(`[CLIP ERROR] clipId=${clipId} unexpected: ${e.message}`))
            .finally(() => {
                clipCutsRunning--;
                refreshClipWorkerState();
                pumpClipQueue();
            });
    }
    refreshClipWorkerState();
}

async function runClipCut(clipId) {
    const job = clipJobs.get(clipId);
    if (!job) return;
    job.cutAttempts = (job.cutAttempts || 0) + 1;
    updateJob(clipId, { status: 'CUTTING', cutAttempts: job.cutAttempts });
    console.log(`[CLIP CUT] clipId=${clipId} cutting now${job.cutAttempts > 1 ? ` (attempt ${job.cutAttempts}/${CLIP_MAX_CUT_ATTEMPTS})` : ''}`);
    const cutResult = await cutLocalClip(job).catch((e) => ({ ok: false, retryable: true, error: e.message }));
    if (!cutResult.ok) {
        if (cutResult.retryable && job.cutAttempts < CLIP_MAX_CUT_ATTEMPTS && !shuttingDown) {
            const delay = CLIP_CUT_RETRY_DELAYS_MS[Math.min(job.cutAttempts - 1, CLIP_CUT_RETRY_DELAYS_MS.length - 1)];
            clipStats.retried++;
            updateJob(clipId, { status: 'CUTTING', error: cutResult.error });
            console.log(`[CLIP RETRY] clipId=${clipId} ${cutResult.error.split('\n')[0]} — retrying in ${delay / 1000}s; other clips continue`);
            clipTimer(() => enqueueClipCut(clipId), delay);
            return;
        }
        clipStats.failed++;
        clipWorker.lastError = cutResult.error;
        updateJob(clipId, { status: 'FAILED_PERMANENT', error: cutResult.error });
        console.log(`[CLIP ERROR] clipId=${clipId} cutting failed: ${cutResult.error.split('\n')[0]}`);
        return;
    }
    clipStats.cut++;
    // 🗂️ File the clip into the player/team/highlight tree NOW — before any
    // upload is attempted, and never conditional on one succeeding. This is
    // the step that has to survive a dead internet connection: the operator
    // gets the organised tree on disk either way, and the upload queue is a
    // separate, later concern.
    const organised = await organiseClipLocally(job, cutResult.outFile);
    const localPath = organised.path;
    updateJob(clipId, {
        status: 'LOCAL_SAVED',
        localPath,
        organised: organised.info || null,
        error: null,
        clipDurationSec: cutResult.durationSec
    });
    // Upload runs detached from the cut worker.
    clipUploadsInFlight++;
    refreshClipWorkerState();
    forwardClip(job, localPath)
        .catch((e) => console.log(`[CLIP ERROR] clipId=${clipId} forward threw: ${e.message}`))
        .finally(() => { clipUploadsInFlight--; refreshClipWorkerState(); });
}

// Maps a Stream Engine clip job onto the organiser's meta shape and files
// the clip. Returns the path the clip now lives at (the organiser MOVES the
// physical file), or the original path if organising was skipped or failed
// — a clip is never lost because the tidying step had a problem.
async function organiseClipLocally(job, outFile) {
    if (!clipOrganizer) return { path: outFile, info: null };
    const bm = job.ballMeta || {};
    const meta = {
        clipId: job.clipId,
        matchId: job.matchId,
        eventType: job.eventType,
        t0: job.timestamp,
        // Everything below comes from the ball's OWN snapshot, taken when the
        // event happened — never from whoever is on strike now. That is what
        // stops a last-ball six being filed under the next over's batsman.
        tournament: bm.tournament || bm.leagueName || null,
        matchName: bm.matchName || bm.match || null,
        innings: bm.innings,
        over: bm.over,
        ballInOver: bm.ballInOver,
        strikerName: bm.striker || bm.strikerName || null,
        strikerId: bm.strikerId || null,
        bowlerName: bm.bowler || bm.bowlerName || null,
        bowlerId: bm.bowlerId || null,
        battingTeam: bm.battingTeam || null,
        outcome: bm.outcome || bm.ballOutcome || null,
        // undefined (not false) means "no operator decision yet", which lets
        // the organiser apply its own default for the event type.
        isHighlight: typeof bm.isHighlight === 'boolean' ? bm.isHighlight : undefined,
    };
    try {
        const result = await clipOrganizer.placeClip({
            clipsRoot: CLIPS_ROOT,
            currentPath: outFile,
            meta,
            previous: job.organised || null,
        });
        // The event itself, on disk next to the clips — the local answer to
        // "which ball, which players, which IDs" with no database needed.
        await clipOrganizer.writeClipMetadata(result.matchRoot, { ...job, ...meta, localPath: result.primary });
        console.log(`🗂️ [CLIP FILED] clipId=${job.clipId} -> ${result.isHighlight ? `Highlights/${result.category}` : 'Normal'}${result.links.length ? ` (+${result.links.length} player folder${result.links.length === 1 ? '' : 's'})` : ''}`);
        return { path: result.primary, info: { primary: result.primary, links: result.links, category: result.category, isHighlight: result.isHighlight, matchRoot: result.matchRoot } };
    } catch (e) {
        // Organising is a convenience on top of a clip that already exists.
        // If it fails, keep the clip exactly where it is and carry on.
        console.log(`[stream-engine] could not file clip ${job.clipId} into the player/team tree (${e.message}) — the clip itself is safe at ${outFile}`);
        return { path: outFile, info: null };
    }
}

async function forwardClip(job, outFile) {
    const { clipId, matchId, eventType, timestamp, ballMeta, mainServerUrl } = job;
    updateJob(clipId, { status: 'FORWARDING' });
    const forwardResult = await postFileToServer(mainServerUrl, matchId, eventType, timestamp, ballMeta, outFile, clipId);
    if (forwardResult.ok) {
        clipWorker.cloudflareConnected = true;
        updateJob(clipId, { status: 'RETRY_PENDING' }); // becomes COMPLETE once polling confirms both uploads
        pollRenderStatus(job);
        return;
    }
    clipWorker.cloudflareConnected = false;
    clipWorker.lastError = forwardResult.error;
    updateJob(clipId, { status: 'RETRY_PENDING', error: forwardResult.error });
    const entry = { clipId, matchId, eventType, timestamp, ballMeta, filePath: outFile, mainServerUrl, attempts: 0 };
    retryQueue.push(entry);
    persistRetryQueue();
    scheduleRetry(entry);
}

// 🔒 DUPLICATE EVENT/CLIP PREVENTION — clipId IS the dedupe key (it's
// deterministic from matchId+eventType+timestamp — see buildClipId), so
// the same request twice is one job, while two different presses (even
// milliseconds apart) are two independent jobs with their own windows.
function acceptClipEvent({ matchId, eventType, timestamp, ballMeta, mainServerUrl, clipId }) {
    const t0 = Number(timestamp);
    if (!Number.isFinite(t0) || t0 <= 0) return { success: false, error: 'timestamp must be a millisecond epoch number' };
    clipId = clipId || buildClipId(matchId, eventType, t0);
    console.log(`[CLIP EVENT] clipId=${clipId} eventType=${eventType} matchId=${matchId} T0=${t0}`);

    const existing = clipJobs.get(clipId);
    if (existing) return { success: true, clipId, status: existing.status, duplicate: true };

    const rec = recordingMatches[matchId];
    const resolvedMainServerUrl = mainServerUrl || (rec && rec.mainServerUrl);
    if (!resolvedMainServerUrl) {
        return { success: false, error: 'No recording session for this match — start recording first' };
    }

    const job = {
        clipId, matchId, eventType, timestamp: t0, ballMeta: ballMeta || null,
        mainServerUrl: resolvedMainServerUrl,
        // Frozen at acceptance — the ONLY timing the cut ever uses.
        window: Object.freeze({
            t0,
            startWall: t0 - CLIP_PRE_ROLL_SEC * 1000,
            endWall: t0 + CLIP_POST_ROLL_SEC * 1000,
            preRollSec: CLIP_PRE_ROLL_SEC,
            postRollSec: CLIP_POST_ROLL_SEC,
        }),
        status: 'WAITING_FOR_POSTROLL',
        createdAt: Date.now(), updatedAt: Date.now(),
        r2Status: 'pending', driveStatus: 'pending',
    };
    clipJobs.set(clipId, job);
    pruneClipJobs();
    persistClipJobs();

    const waitMs = Math.max(0, job.window.endWall - Date.now());
    console.log(`[CLIP WAIT] clipId=${clipId} waiting ${waitMs}ms for post-roll`);
    clipTimer(() => enqueueClipCut(clipId), waitMs);

    return { success: true, clipId, status: 'WAITING_FOR_POSTROLL' };
}

// ================================================================
// HTTP API — localhost only, control/monitoring plane. The panel's
// origin is whatever page it's served from (Render), so CORS is opened
// for any origin but this server only ever binds to 127.0.0.1 (see
// app.listen below) — it is not reachable from outside the operator's
// own PC. No video bytes ever cross this API in either direction
// anymore — see /go-live, /recording-start, /clip below; there is no
// /ingest route.
// ================================================================
const app = express();
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    // 🔒 Chrome's Private Network Access policy: the panel's own page is
    // served over HTTPS from a public host (Render), and this server only
    // ever binds to 127.0.0.1 — a "private" address in PNA terms. Chrome
    // now sends a CORS preflight (even for a plain <img src> GET, not just
    // fetch/XHR) before ANY subresource request that crosses from a public
    // page to a private/loopback address, and silently fails the whole
    // request ("(failed)", 0 bytes, no error visible to this server at
    // all) unless that preflight response carries this header. Confirmed
    // in the field: /status and /program-feed-health (plain fetch calls)
    // still worked without it, but <img src> loads of /capture-preview
    // (the native preview image) did not — this is why.
    res.header('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});
app.use(express.json());

app.get('/status', async (req, res) => {
    const nvenc = checkNvenc();
    // Only check network reachability once a Stream URL is actually
    // configured — there's nothing to reach otherwise, and this keeps
    // /status cheap (and side-effect-free network-wise) before setup.
    const network = streamUrl && isValidRtmpUrl(streamUrl) ? await checkNetwork(streamUrl) : { available: false, detail: 'No Stream URL set' };
    res.json({
        success: true,
        platform: process.platform,
        nativeCaptureSupported: NATIVE_CAPTURE_SUPPORTED,
        ffmpegAvailable: ffmpegAvailable(),
        ffmpegPath: FFMPEG_PATH,
        ffmpegSource: FFMPEG_SOURCE, // 'bundled' | 'FFMPEG_PATH env var' | 'system PATH' — see bin/README.md
        ffprobeAvailable: ffprobeAvailable(),
        ffprobePath: FFPROBE_PATH,
        ffprobeSource: FFPROBE_SOURCE,
        nativeProgramFeed: NATIVE_PROGRAM_FEED,
        dataRoot: DATA_ROOT, // the folder actually in use THIS run — see /set-data-root
        dataRootPending: (() => {
            const saved = loadConfig().dataRoot;
            const active = DATA_ROOT_OVERRIDE || null;
            return (saved && saved !== active) ? saved : null; // set only when a saved choice hasn't taken effect yet (needs a restart)
        })(),
        overlayBridgeAvailable: NATIVE_PROGRAM_FEED ? nativePipeline.overlayBridgeAvailable() : null,
        compositor: NATIVE_PROGRAM_FEED ? {
            state: compositor ? compositor.state : 'idle',
            matchId: compositor ? compositor.matchId : null,
            refs: compositor ? [...compositor.refs] : [],
            lastError: compositor ? compositor.lastError : null,
            relay: compositor ? compositor.stats() : null,
        } : null,
        resources: resourceSnapshot(),
        nvencAvailable: nvenc.available,
        nvencDetail: nvenc.detail,
        gpuScaleAvailable: NATIVE_CAPTURE_SUPPORTED ? checkGpuScaleRuntime() : false,
        // Stream URL is not a secret (no credentials embedded in the
        // normal case) — safe to echo back in full, unlike the key.
        streamUrl: streamUrl || null,
        streamUrlSet: !!streamUrl && isValidRtmpUrl(streamUrl),
        streamKeySet: !!streamKey,
        streamKeyMasked: maskKey(streamKey),
        networkOk: network.available,
        networkDetail: network.detail,
        encoderState: engine.state,
        clipWorkerState: clipWorker.state,
        cloudflareConnected: clipWorker.cloudflareConnected,
        clipWorkerLastError: clipWorker.lastError,
        clipQueue: { queued: clipCutQueue.length, cutting: clipCutsRunning, uploading: clipUploadsInFlight, ...clipStats },
        retryQueueLength: retryQueue.length,
        captureConfig,
        // Local full-match master recording — independent of streaming.
        recorder: {
            state: recorder.state,
            matchId: recorder.matchId,
            settings: recorder.settings,
            segmentPath: recorder.segmentPath,
            segmentCount: recorder.segments.length,
            durationSec: recorder.startedAt && (recorder.state === 'recording' || recorder.state === 'stopping')
                ? Math.round((Date.now() - recorder.startedAt) / 1000)
                : null,
            sizeBytes: (() => { try { return recorder.segmentPath ? fs.statSync(recorder.segmentPath).size : null; } catch (e) { return null; } })(),
            diskFreeBytes: diskFreeBytes(RECORDING_ROOT),
            lastError: recorder.lastError,
            restartCount: recorder.totalRestarts,
            writtenSec: recorder.currentSegment ? Math.round(recorder.currentSegment.outTimeSec || 0) : null,
            lastWriteAgoMs: recorder.lastProgressAdvanceAt ? Date.now() - recorder.lastProgressAdvanceAt : null,
            programFeedHealth: recorder.lastProgramFeedHealth || null,
        },
        captureWindow: {
            running: !!captureWindow.proc,
            matchId: captureWindow.matchId,
            launchedAt: captureWindow.launchedAt,
            lastCameraEndedAt: captureWindow.lastCameraEndedAt,
            lastCameraEndedReason: captureWindow.lastCameraEndedReason,
        },
    });
});

// Native audio device list (dshow) — populates the panel's microphone
// dropdown.
app.get('/audio-devices', (req, res) => {
    const { devices, detail } = listAudioDevices();
    res.json({ success: true, platform: process.platform, devices, detail });
});
// Native camera device list (dshow) — populates the panel's camera
// dropdown for the native camera+overlay compositor. Names, not
// getUserMedia deviceIds (see listVideoDevices' own comment).
app.get('/video-devices', (req, res) => {
    const { devices, detail } = listVideoDevices();
    res.json({ success: true, platform: process.platform, devices, detail });
});

app.get('/capture-config', (req, res) => res.json({ success: true, captureConfig }));
app.post('/capture-config', (req, res) => {
    const body = req.body || {};
    for (const k of ['cropTop', 'cropBottom', 'cropLeft', 'cropRight']) {
        if (Number.isFinite(Number(body[k])) && Number(body[k]) >= 0) captureConfig[k] = Number(body[k]);
    }
    saveCaptureConfig();
    res.json({ success: true, captureConfig });
});

// 🩺 PROGRAM FEED HEALTH — on-demand version of the same check /go-live
// runs automatically. The panel polls this while Live Studio is open
// (BEFORE Go Live is even pressed) so a black/white/frozen feed shows
// up as a clear warning badge next to the native preview, not just as a
// refusal at the moment of going live.
app.get('/program-feed-health', async (req, res) => {
    const matchId = safeMatchId(req.query.matchId);
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
    if (!NATIVE_CAPTURE_SUPPORTED) return res.json({ success: true, ok: true, skipped: true, reason: `Native capture requires Windows — this process is running on ${process.platform}` });

    if (NATIVE_PROGRAM_FEED) {
        // See /go-live's own comment for the same simplified check — a
        // real blackdetect/freezedetect pass against the compositor's
        // output is a known gap, not yet built for the native pipeline.
        if (!compositor || compositor.state !== 'running') return res.json({ success: true, ok: true, skipped: true, reason: 'Compositor not running yet' });
        if (!compositor.previewJpeg) return res.json({ success: true, ok: false, error: 'No preview frame yet' });
        const ageMs = Date.now() - compositor.previewAt;
        const ok = compositor.previewJpeg.length >= 500 && ageMs <= 5000;
        return res.json({ success: true, ok, black: false, white: false, frozen: !ok && ageMs > 5000, checkedAt: Date.now() });
    }

    const windowTitle = resolveWindowTitle(matchId);
    const { width, height } = RESOLUTIONS['720p']; // cheap sample resolution — same reasoning as /capture-preview; this is a diagnostic, not the real encode
    const health = await runProgramFeedHealthCheck({ windowTitle, width, height, fps: 15 });
    res.json({ success: true, ...health });
});

// 🪟 DEDICATED CAPTURE WINDOW — see launchCaptureWindow's header comment
// above for the full root-cause reasoning. The panel calls /launch
// instead of window.open() to get Live Output rendering in a GPU-
// compositing-disabled Chromium process gdigrab can actually read.
app.post('/capture-window/launch', (req, res) => {
    const body = req.body || {};
    const matchId = safeMatchId(body.matchId);
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
    const result = launchCaptureWindow({ matchId, videoDeviceId: body.videoDeviceId, videoLabel: body.videoLabel, origin: body.origin, width: body.width, height: body.height });
    res.json({ success: result.ok, ...result });
});
app.post('/capture-window/close', (req, res) => {
    res.json({ success: true, ...closeCaptureWindow() });
});
app.get('/capture-window/status', (req, res) => {
    res.json({
        success: true,
        running: !!captureWindow.proc,
        matchId: captureWindow.matchId,
        launchedAt: captureWindow.launchedAt,
        execPath: captureWindow.execPath,
        lastCameraEndedAt: captureWindow.lastCameraEndedAt,
        lastCameraEndedReason: captureWindow.lastCameraEndedReason,
    });
});
// live-output.html POSTs here directly (see its own header comment) so
// camera-ended/no-signal detection works the same way whether it's
// running as this dedicated capture window (no window.opener at all —
// it's a separate process) or the window.open() popup fallback. Purely
// informational: this engine has no independent way to know the camera
// died other than the page itself reporting it.
app.post('/capture-window/camera-ended', (req, res) => {
    captureWindow.lastCameraEndedAt = Date.now();
    captureWindow.lastCameraEndedReason = (req.body && req.body.reason) || 'camera ended';
    console.log(`[stream-engine] Live Output reported: ${captureWindow.lastCameraEndedReason}`);
    res.json({ success: true });
});

// 🖼️ CAPTURE PREVIEW — grabs exactly one frame of the real program feed
// so the operator can SEE it before going live.
//
// Native pipeline: serves the compositor's latest JPEG snapshot from
// memory (see the preview output in nativePipeline.js) — a REAL consumer
// of the same composited camera+overlay stream, not a re-capture.
//
// Legacy (gdigrab): grabs exactly one frame from the target window, so
// the operator can SEE the crop margin (captureConfig) and confirm
// gdigrab is actually finding the Live Output window BEFORE going live
// — exact OS title-bar/DPI pixel dimensions can't be verified without
// the real machine, hence this endpoint.
// 🖥️ LIVE PROGRAM MONITOR — a real multipart/x-mixed-replace MJPEG stream
// of the composited camera+overlay feed.
//
// WHY THIS EXISTS: the panel used to show the program feed by re-requesting
// GET /capture-preview (one still JPEG) on a timer. At the interval it
// actually ran, that is a photo that changes every few seconds — you cannot
// tell from it whether the feed is live, whether the camera is in focus, or
// whether framing is right, which is the whole job of a program monitor.
//
// multipart/x-mixed-replace is the oldest and most reliable way to put real
// motion into a plain <img>: ONE connection, the browser swaps each part in
// as it arrives, no polling, no JS decode, no MediaSource, no WebRTC.
//
// SAFETY: this is a passive subscriber to frames the compositor already
// produces for the in-memory preview. It starts nothing, it never
// back-pressures the compositor (a viewer that cannot keep up has frames
// DROPPED, never queued — see `busy` below), and if the socket dies the
// subscription is torn down. It therefore cannot affect the recording or
// the YouTube push, which is the property that matters most here.
// 🎬 POST /clip-meta — the operator's Highlights decision, and the ball's
// real identity, arriving AFTER the clip was already cut.
//
// WHY THIS EXISTS: a clip is cut the instant the event happens, but at that
// moment the panel does not yet know the ball's true over/ball number or
// whether the operator wants it in the Highlights — the scorer enters the
// outcome a moment later. clipper-helper has always had this endpoint; the
// Stream Engine did not, which is exactly why the Highlights prompt could
// not work on the Stream Engine panel: there was nowhere to send the answer.
//
// Re-filing is safe and idempotent. placeClip() takes the clip's PREVIOUS
// placement and removes the paths it no longer belongs at, so answering YES
// moves it from Normal/ into Highlights/<category>/ (and re-links the player
// folders) without ever leaving a stale duplicate behind. Answering the same
// way twice is a no-op.
//
// Entirely local: no network, so the operator's decision is never lost to a
// dead connection. The cloud classification is a separate, queued concern.
app.post('/clip-meta', async (req, res) => {
    const body = req.body || {};
    const clipId = String(body.clipId || '');
    if (!clipId) return res.status(400).json({ success: false, error: 'clipId required' });
    const job = clipJobs.get(clipId);
    if (!job) return res.status(404).json({ success: false, error: `No clip job known for clipId ${clipId}` });

    // Merge the corrected ball identity + the decision onto the job's own
    // metadata. The panel's ballMeta is authoritative for the ball; the
    // decision is authoritative for the Highlights classification.
    job.ballMeta = { ...(job.ballMeta || {}), ...(body.ballMeta || {}) };
    if (body.outcomeLabel) job.ballMeta.outcome = body.outcomeLabel;
    if (typeof body.isHighlight === 'boolean') job.ballMeta.isHighlight = body.isHighlight;
    if (body.eventType) job.eventType = body.eventType;

    const currentPath = job.localPath || (job.organised && job.organised.primary) || null;
    if (!currentPath || !fs.existsSync(currentPath)) {
        // The decision still counts — it is recorded on the job, so whenever
        // the clip does land it will be filed correctly.
        updateJob(clipId, { ballMeta: job.ballMeta, highlightDecision: body.isHighlight === true ? 'YES' : body.isHighlight === false ? 'NO' : 'ASK' });
        return res.json({ success: true, refiled: false, note: 'Clip file not on disk yet — the decision is stored and will be applied when it is cut' });
    }

    const organised = await organiseClipLocally({ ...job, localPath: currentPath }, currentPath);
    updateJob(clipId, {
        localPath: organised.path,
        organised: organised.info || null,
        ballMeta: job.ballMeta,
        highlightDecision: body.isHighlight === true ? 'YES' : body.isHighlight === false ? 'NO' : 'ASK'
    });
    res.json({
        success: true,
        refiled: true,
        localPath: organised.path,
        isHighlight: organised.info ? organised.info.isHighlight : null,
        category: organised.info ? organised.info.category : null
    });
});

app.get('/capture-preview/stream', (req, res) => {
    const matchId = safeMatchId(req.query.matchId);
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
    if (!NATIVE_PROGRAM_FEED) return res.status(400).json({ success: false, error: 'The live preview stream needs the native program feed (NATIVE_PROGRAM_FEED=true)' });
    if (!compositor) return res.status(404).json({ success: false, error: 'No compositor running — start the preview, recording or go live first' });

    const BOUNDARY = 'aslframe';
    res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Connection': 'close',
        // This response never ends on its own; proxies must not buffer it.
        'X-Accel-Buffering': 'no',
    });

    let busy = false;
    const send = (jpeg) => {
        // Drop rather than queue: if the previous frame has not finished
        // going out, this viewer is slower than the feed and the correct
        // thing for a LIVE monitor is to skip ahead, not to fall behind.
        if (busy || res.writableEnded) return;
        busy = true;
        res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg, () => { busy = false; });
        res.write('\r\n');
    };

    if (compositor.previewJpeg) send(compositor.previewJpeg); // paint immediately, don't wait for the next frame
    const unsubscribe = compositor.onPreviewFrame(send);
    const done = () => { try { unsubscribe(); } catch (e) {} };
    req.on('close', done);
    req.on('error', done);
    res.on('error', done);
});

app.get('/capture-preview', (req, res) => {
    const matchId = safeMatchId(req.query.matchId);
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
    if (!NATIVE_CAPTURE_SUPPORTED) return res.status(400).json({ success: false, error: `Native capture requires Windows — this process is running on ${process.platform}` });

    if (NATIVE_PROGRAM_FEED) {
        // Served from memory (see nativePipeline.js MpjpegParser) — no
        // preview file on disk for anything to lock.
        if (!compositor || !compositor.previewJpeg) {
            return res.status(404).json({ success: false, error: 'No native program preview yet — start recording or go live first so the compositor is running' });
        }
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'no-store');
        return res.send(compositor.previewJpeg);
    }

    const windowTitle = resolveWindowTitle(matchId);
    const useGpuScale = false; // the preview is a single throwaway frame — always CPU-simple, no need to exercise the GPU path here
    const { width, height } = RESOLUTIONS['720p'];
    // 🩹 Confirmed in the field: this ffmpeg build's mjpeg encoder fails
    // to even open ("Could not open encoder before EOF" / error -22
    // Invalid argument) no matter what pixel format is forced ahead of
    // it (yuvj420p included) — something about this specific build's
    // mjpeg/JPEG code path (full-range YUV, chroma subsampling) is
    // broken, not just the format negotiation. PNG sidesteps that whole
    // category: it's a straightforward RGB codec with no YUV range
    // conversion involved at all. 'format=rgba' is a plain channel
    // reorder from gdigrab's native bgra (core, universally-supported
    // swscale functionality, unlike the JPEG range math) so it should
    // work even on a stripped-down build like this one.
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'gdigrab', '-framerate', '5', '-i', `title=${windowTitle}`,
        '-frames:v', '1',
        '-vf', `${cropScaleFilter(width, height, useGpuScale)},format=rgba`,
        '-f', 'image2', '-vcodec', 'png',
        'pipe:1',
    ];
    const proc = spawnFfmpeg(args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('exit', (code) => {
        if (code === 0 && chunks.length) {
            res.set('Content-Type', 'image/png');
            res.send(Buffer.concat(chunks));
        } else {
            res.status(500).json({ success: false, error: `Could not capture window "${windowTitle}" — is the Live Output window open? ffmpeg: ${stderr.slice(-400) || 'no output'}` });
        }
    });
    proc.on('error', (err) => res.status(500).json({ success: false, error: err.message }));
});

// 🖼️ NATIVE PREVIEW-ONLY START/STOP — lets the operator see the real
// composited camera+overlay feed BEFORE committing to Recording or Go
// Live, the same way the legacy dedicated capture window already worked
// independently of recording/streaming. Ref-counted through the SAME
// ensureCompositor/releaseCompositor ('preview' as its own `who`) as the
// recorder and live encoder — opening a preview while already recording/
// live just adds another ref onto the one running compositor, no
// restart; closing the preview while a recording or the live encoder
// still needs it (see releaseCompositor) leaves the compositor running.
app.post('/native-preview/start', async (req, res) => {
    if (!NATIVE_PROGRAM_FEED) return res.status(400).json({ success: false, error: 'Native program feed is not enabled on this Stream Engine' });
    const body = req.body || {};
    const matchId = safeMatchId(body.matchId);
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
    if (!body.cameraDeviceName) return res.status(400).json({ success: false, error: 'cameraDeviceName required' });
    if (!body.audioDeviceName) return res.status(400).json({ success: false, error: 'audioDeviceName required' });
    if (!body.mainServerUrl) return res.status(400).json({ success: false, error: 'mainServerUrl required' });
    const result = await ensureCompositor({ matchId, mainServerUrl: body.mainServerUrl, cameraDeviceName: body.cameraDeviceName, audioDeviceName: body.audioDeviceName, who: 'preview' });
    res.json(result);
});
app.post('/native-preview/stop', (req, res) => {
    if (NATIVE_PROGRAM_FEED) releaseCompositor('preview');
    res.json({ success: true });
});

// ----------------------------------------------------------------
// 🎬 ClipperHelper.exe-COMPATIBLE ENDPOINTS
//
// cricket-panel.html's recordBall()/triggerWicketClip() code was built
// against ClipperHelper.exe's contract: /recording-start, /recording-
// stop, /clip. That JS is unchanged in shape — only the URL it's
// pointed at, and the recording-start payload's audioDeviceName, changed.
// ----------------------------------------------------------------
app.post('/recording-start', async (req, res) => {
    const matchId = safeMatchId(req.body && req.body.matchId);
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
    const mainServerUrl = (req.body && req.body.mainServerUrl) || null;
    const tournamentId = (req.body && req.body.tournamentId) || null;
    const resolution = (req.body && req.body.recordingResolution) || '1080p';
    const fps = (req.body && req.body.recordingFps) || 30;
    const audioDeviceName = (req.body && req.body.audioDeviceName) || null;
    const cameraDeviceName = (req.body && req.body.cameraDeviceName) || null; // only used when NATIVE_PROGRAM_FEED is on

    recordingMatches[matchId] = { mainServerUrl, tournamentId };
    console.log(`🔴 [clip engine] Recording session registered for match ${matchId}`);

    // A previous match's recorder left running (operator forgot to press
    // Stop, or a previous Stream Engine session never got a clean
    // shutdown) must never permanently block starting today's match —
    // that just turned into a real "nothing records / nothing goes
    // live" outage. Stop it first; the exit-guard on the recorder's own
    // proc.on('exit') (see startRecorder) makes this race-safe even
    // though the old process may still be shutting down when the new
    // one starts.
    if (recorder.matchId && recorder.matchId !== matchId && recorder.state !== 'idle') {
        console.log(`[stream-engine] Switching local recording from match "${recorder.matchId}" to "${matchId}" — stopping the old one first`);
        stopRecorder();
    }
    if (recorder.matchId !== matchId) resetRecorderForNewMatch();
    const recResult = await startRecorder(matchId, { resolution, fps, audioDeviceName, cameraDeviceName, mainServerUrl });
    if (!recResult.ok) {
        console.log(`⚠️  [master recording] could not start local master recording for ${matchId}: ${recResult.error}`);
    }

    res.json({ success: true, vmixControlled: false, masterRecording: recResult.ok ? { ok: true, path: recorder.segmentPath } : { ok: false, error: recResult.error } });
});

app.post('/recording-stop', (req, res) => {
    const matchId = safeMatchId(req.body && req.body.matchId);
    if (matchId) delete recordingMatches[matchId];
    if (matchId && recorder.matchId === matchId) stopRecorder();
    res.json({ success: true, vmixControlled: false });
});

// Serves the operator the folder path (not the file contents — these
// can be multi-GB) so a panel button can show/copy it for "Open
// Recording Folder" without this engine needing a native file-manager
// integration.
app.get('/recording-info', (req, res) => {
    const matchId = safeMatchId(req.query.matchId);
    const dir = matchId ? recorderDir(matchId) : RECORDING_ROOT;
    let sizeBytes = null;
    try {
        sizeBytes = recorder.segments.reduce((sum, s) => {
            try { return sum + fs.statSync(s.path).size; } catch (e) { return sum; }
        }, 0);
    } catch (e) { /* best effort */ }
    res.json({
        success: true,
        folder: dir,
        segments: recorder.segments,
        totalSizeBytes: sizeBytes,
        diskFreeBytes: diskFreeBytes(RECORDING_ROOT),
    });
});

// Legacy ClipperHelper contract also had /set-folder. This engine does
// NOT upload to Drive/R2 itself — it forwards the finished clip to
// server.js's existing /api/clips/ingest, which already knows the
// match's Drive folder. Kept as a harmless no-op so nothing breaks if
// older UI still calls it.
app.post('/set-folder', (req, res) => {
    res.json({ success: true, note: 'no-op — this engine forwards clips to server.js, which handles Drive/R2 folder routing itself' });
});

// The actual clip trigger — same payload shape recordBall()/
// triggerWicketClip() already send: {eventType, timestamp, matchId,
// ballMeta}, plus an optional clipId. Responds the instant the event is
// ACCEPTED (job created, T0 frozen) — never waits for the post-roll or
// the cut/upload.
app.post('/clip', (req, res) => {
    const { eventType, timestamp, matchId, ballMeta, clipId } = req.body || {};
    if (!matchId || !eventType || !timestamp) {
        return res.status(400).json({ success: false, error: 'matchId, eventType and timestamp are required' });
    }
    const result = acceptClipEvent({ matchId: safeMatchId(matchId), eventType, timestamp, ballMeta, clipId });
    if (!result.success) return res.status(409).json(result);
    res.json(result);
});

// 🎬 LIVE CLIP STATUS — polled by the panel to render the full per-clip
// progress UI (T0 captured -> waiting -> cutting -> local saved ->
// uploading -> R2 -> Drive -> complete).
app.get('/clip-jobs', (req, res) => {
    const jobs = [...clipJobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
    res.json({ success: true, jobs });
});
app.get('/clip-jobs/:clipId', (req, res) => {
    const job = clipJobs.get(req.params.clipId);
    if (!job) return res.status(404).json({ success: false, error: 'No clip job with that clipId' });
    res.json({ success: true, job });
});

// Accepts BOTH the Stream URL and Stream Key together — the operator
// configures whichever platform's RTMP(S) endpoint they were given
// (YouTube Studio → Go Live, or any other), never a fixed hardcoded
// YouTube URL. Either field can be updated independently (omit the
// other to leave it unchanged).
app.post('/set-youtube-config', (req, res) => {
    const body = req.body || {};
    const newUrl = typeof body.streamUrl === 'string' ? body.streamUrl.trim() : undefined;
    const newKey = typeof body.streamKey === 'string' ? body.streamKey.trim() : undefined;

    if (newUrl !== undefined) {
        if (!isValidRtmpUrl(newUrl)) return res.status(400).json({ success: false, error: 'Stream URL must start with rtmp:// or rtmps://' });
        streamUrl = newUrl;
    }
    if (newKey !== undefined) {
        if (!newKey) return res.status(400).json({ success: false, error: 'Stream Key cannot be empty' });
        streamKey = newKey;
    }
    if (newUrl === undefined && newKey === undefined) {
        return res.status(400).json({ success: false, error: 'streamUrl and/or streamKey required' });
    }

    saveConfig({ ...loadConfig(), streamUrl, streamKey });
    res.json({ success: true, streamUrl, streamKeyMasked: maskKey(streamKey) });
});

// 📁 Lets the operator move recordings/clips out from under wherever
// stream-engine itself is installed (see DATA_ROOT's own comment near
// the top of this file — Downloads + OneDrive sync is the confirmed
// real-world trigger). Only validates and persists the choice; it does
// NOT hot-swap DATA_ROOT for the current process — an active recording
// mid-write is not something to redirect out from under itself. Takes
// effect on the next Stream Engine restart, same as NATIVE_PROGRAM_FEED
// and every other env-var-level setting.
app.post('/set-data-root', (req, res) => {
    const newPath = (req.body && typeof req.body.path === 'string') ? req.body.path.trim() : '';
    if (!newPath) return res.status(400).json({ success: false, error: 'path required' });
    try {
        fs.mkdirSync(newPath, { recursive: true });
        const probe = path.join(newPath, '.stream-engine-write-test');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
    } catch (e) {
        return res.status(400).json({ success: false, error: `Could not use this folder: ${e.message}` });
    }
    saveConfig({ ...loadConfig(), dataRoot: newPath });
    res.json({ success: true, path: newPath, restartRequired: true, current: DATA_ROOT });
});

// 📁 IN-PANEL FOLDER BROWSER — a browser can't hand this page a real OS
// path from a native picker dialog (no web API exposes one, deliberately,
// for security), but the Stream Engine itself is a local process with
// full filesystem access — so it lists folders FOR the panel to render
// as a clickable browser instead. No `path` query = list this PC's
// drives (Windows) as the starting points; with `path`, lists that
// folder's immediate subfolders only (never files — nothing here is
// ever read, only enumerated, and only directories are returned).
app.get('/browse-folders', (req, res) => {
    const reqPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (!reqPath) {
        if (process.platform !== 'win32') return res.json({ success: true, path: '', entries: [{ name: '/', path: '/' }] });
        const drives = [];
        for (let code = 65; code <= 90; code++) { // A-Z
            const letter = String.fromCharCode(code);
            const drivePath = `${letter}:\\`;
            try { if (fs.existsSync(drivePath)) drives.push({ name: drivePath, path: drivePath }); } catch (e) { /* inaccessible drive — skip */ }
        }
        return res.json({ success: true, path: '', entries: drives });
    }
    let items;
    try {
        items = fs.readdirSync(reqPath, { withFileTypes: true });
    } catch (e) {
        return res.status(400).json({ success: false, error: `Could not open this folder: ${e.message}` });
    }
    const entries = items
        .filter((it) => it.isDirectory())
        .map((it) => ({ name: it.name, path: path.join(reqPath, it.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(reqPath);
    res.json({ success: true, path: reqPath, parent: parent !== reqPath ? parent : null, entries });
});

app.post('/go-live', async (req, res) => {
    const { resolution, fps, bitrateKbps, keyframeIntervalSec, qualityMode, autoResolutionFallback, matchId, audioDeviceName, cameraDeviceName, mainServerUrl, skipProgramFeedHealthCheck } = req.body || {};
    engine.opToken++; // a fresh operator-initiated Go Live always wins over any stale in-flight ABR restart

    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required — select a match in the panel first' });
    if (!audioDeviceName) return res.status(400).json({ success: false, error: 'audioDeviceName required — pick a microphone/capture-card audio device under Live Studio first' });
    if (NATIVE_PROGRAM_FEED && !cameraDeviceName) return res.status(400).json({ success: false, error: 'cameraDeviceName required — pick a camera under Live Studio first' });
    engine.matchId = safeMatchId(matchId);
    engine.audioDeviceName = audioDeviceName;
    if (cameraDeviceName) engine.cameraDeviceName = cameraDeviceName;
    if (mainServerUrl) engine.mainServerUrl = mainServerUrl;

    const resKey = RESOLUTIONS[resolution] ? resolution : '1080p';
    const fpsNum = [30, 60].includes(Number(fps)) ? Number(fps) : 30;

    // 🩺 GO LIVE SEQUENCE, steps "validate frames / validate FPS" — BEFORE
    // ever touching the encoder or RTMPS: sample the exact gdigrab window
    // the live encoder is about to open. If THIS comes back solid black,
    // solid white, or frozen, so would YouTube — refuse to start rather
    // than silently pushing a bad picture live (see runProgramFeedHealthCheck
    // above). skipProgramFeedHealthCheck exists only as an explicit,
    // operator-acknowledged override (the panel only ever sends it after
    // showing the failure and the operator choosing "Go Live Anyway") —
    // never set by default.
    if (NATIVE_CAPTURE_SUPPORTED && !NATIVE_PROGRAM_FEED && !skipProgramFeedHealthCheck) {
        const { width, height } = RESOLUTIONS[resKey];
        const windowTitle = resolveWindowTitle(engine.matchId);
        const health = await runProgramFeedHealthCheck({ windowTitle, width, height, fps: fpsNum });
        engine.lastProgramFeedHealth = health;
        if (!health.ok) {
            const reason = health.error
                ? health.error
                : health.black
                    ? 'PROGRAM OUTPUT ERROR — the final video feed is solid BLACK (camera/overlay not rendering, or the capture window is not readable right now).'
                    : health.white
                        ? 'PROGRAM OUTPUT ERROR — the final video feed is solid WHITE (this is the classic GPU-composited/blank-window gdigrab bug — open Live Output as the dedicated capture window, not a regular browser tab).'
                        : 'PROGRAM OUTPUT ERROR — the final video feed is not producing valid frames.';
            console.log(`[stream-engine] Go Live refused — program feed health check failed: ${reason}`);
            return res.status(409).json({ success: false, error: reason, programFeedHealth: health });
        }
    }
    // 🧪 Native pipeline equivalent — the gdigrab-based blackdetect/
    // freezedetect check above doesn't apply here (there's no window to
    // sample). This is a deliberately simplified proxy for now: if the
    // compositor is already running (e.g. because recording started
    // first) and its preview snapshot exists and is fresh, frames are
    // genuinely flowing through camera+overlay+compositor right now. It
    // does NOT detect an all-black/all-white frame the way the legacy
    // check does — a real blackdetect/freezedetect pass against the
    // compositor's own output is a known gap, not yet built.
    if (NATIVE_PROGRAM_FEED && compositor && compositor.state === 'running' && compositor.previewJpeg && !skipProgramFeedHealthCheck) {
        const size = compositor.previewJpeg.length;
        const ageMs = Date.now() - compositor.previewAt;
        if (size < 500 || ageMs > 5000) {
            const reason = `PROGRAM OUTPUT ERROR — the compositor's preview frame is ${size < 500 ? 'suspiciously small' : `${Math.round(ageMs / 1000)}s old`} — camera/overlay may not be producing valid frames.`;
            console.log(`[stream-engine] Go Live refused — native program feed check failed: ${reason}`);
            return res.status(409).json({ success: false, error: reason });
        }
    } // no preview frame yet — the compositor may have just started; don't block on this alone

    engine.targetResolution = resKey;
    engine.qualityMode = qualityMode === 'manual' ? 'manual' : 'adaptive';
    engine.autoResolutionFallback = !!autoResolutionFallback;
    engine.rung = 'high';
    engine.reconnect = { attempts: 0, nextAttemptAt: null };
    engine.network = { state: 'stable', protectionActive: false, protectionMessage: null, uploadEstimateKbps: null, weakSince: null, criticalSince: null, stableSince: null };
    engine.sessionLadder = buildSessionLadder(resKey, bitrateKbps);

    // Manual mode streams at exactly what was picked (or the provider's
    // recommended default for that resolution/fps if left blank).
    // Adaptive mode starts at this resolution's ladder ceiling and lets
    // the ABR loop react to real conditions from there.
    const startBitrateKbps = engine.qualityMode === 'manual'
        ? (Number(bitrateKbps) > 0 ? Number(bitrateKbps) : DEFAULT_BITRATE_KBPS[resKey][fpsNum])
        : engine.sessionLadder[resKey].high;

    const result = await startEncoder({ resolution: resKey, fps: fpsNum, bitrateKbps: startBitrateKbps, keyframeIntervalSec });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, state: engine.state });
});

app.post('/stop', (req, res) => {
    engine.opToken++; // wins any race against an in-flight ABR restart — Stop always means stop
    const result = stopEncoder();
    res.json({ success: true, ...result });
});

// Runtime tuning for the ABR ladder/thresholds — lets an operator match
// a different streaming provider's own bitrate limits, or retune the
// hysteresis timings, without restarting this process. Values outside
// sane bounds are ignored rather than rejected outright, so a bad field
// in the request body doesn't take down the others.
app.get('/adaptive-config', (req, res) => res.json({ success: true, abr }));
app.post('/adaptive-config', (req, res) => {
    const body = req.body || {};
    if (body.ladder && typeof body.ladder === 'object') {
        for (const r of RESOLUTION_ORDER) {
            if (body.ladder[r]) abr.ladder[r] = { ...abr.ladder[r], ...body.ladder[r] };
        }
    }
    if (Number(body.safetyFactor) > 0 && Number(body.safetyFactor) <= 1) abr.safetyFactor = Number(body.safetyFactor);
    if (Number(body.emergencyFps) > 0) abr.emergencyFps = Number(body.emergencyFps);
    if (Number(body.holdWeakSec) > 0) abr.holdWeakSec = Number(body.holdWeakSec);
    if (Number(body.holdCriticalSec) > 0) abr.holdCriticalSec = Number(body.holdCriticalSec);
    if (Number(body.holdStableUpSec) > 0) abr.holdStableUpSec = Number(body.holdStableUpSec);
    if (Number(body.minRestartIntervalMs) >= 2000) abr.minRestartIntervalMs = Number(body.minRestartIntervalMs);
    res.json({ success: true, abr });
});

app.get('/health', (req, res) => {
    res.json({
        success: true,
        state: engine.state,
        desiredLive: engine.desiredLive,
        adapting: engine.adapting,
        settings: engine.settings,
        targetResolution: engine.targetResolution,
        qualityMode: engine.qualityMode,
        autoResolutionFallback: engine.autoResolutionFallback,
        rung: engine.rung,
        network: engine.network,
        reconnect: engine.reconnect,
        metrics: {
            ...engine.metrics,
            droppedFramesPct: (engine.metrics.droppedFrames != null && engine.metrics.totalFrames)
                ? Math.round((engine.metrics.droppedFrames / engine.metrics.totalFrames) * 1000) / 10
                : null,
        },
        encoder: {
            hardware: 'NVENC',
            hardwareAccelerated: checkNvencRuntime(),
            gpuScaleAccelerated: checkGpuScaleRuntime(),
        },
        gpu: readGpuUtilization(),
        cpuPercent: readCpuUtilization(),
        durationSec: engine.startedAt && (engine.state === 'live' || engine.state === 'stopping')
            ? Math.round((Date.now() - engine.startedAt) / 1000)
            : (engine.metrics.outTimeSec || 0),
        lastError: engine.lastError,
        restartCount: engine.restarts.length,
        // ⚠ Sampled roughly every 30s while live (see monitorProgramFeedHealth
        // below) — not per-frame. null until the first sample lands.
        programFeedHealth: engine.lastProgramFeedHealth || null,
        captureWindow: {
            running: !!captureWindow.proc,
            lastCameraEndedAt: captureWindow.lastCameraEndedAt,
            lastCameraEndedReason: captureWindow.lastCameraEndedReason,
        },
        clipEngine: {
            clipWorkerState: clipWorker.state,
            cloudflareConnected: clipWorker.cloudflareConnected,
            lastError: clipWorker.lastError,
            queued: clipCutQueue.length,
            cutting: clipCutsRunning,
            uploading: clipUploadsInFlight,
            ...clipStats,
            retryQueueLength: retryQueue.length,
        },
        resources: resourceSnapshot(),
    });
});

// 📶 ABR control loop — see the ABR section above buildLiveEncoderArgs
// for the full mechanism. No-ops instantly whenever the encoder isn't live.
const ABR_TICK_MS = 2000;
setInterval(abrTick, ABR_TICK_MS);

// 🩺 ONGOING PROGRAM FEED MONITORING (item 14 — "diagnostics/protection,
// not an expensive analysis of every pixel forever"). Runs the same
// black/white/freeze sample runProgramFeedHealthCheck used as the Go
// Live gate, but on a slow 30s cadence and only while there's something
// to watch (live and/or recording) — cheap enough to run indefinitely,
// frequent enough to catch a feed that goes bad mid-match (camera
// unplugged and replugged into a dead port, a Windows update popup
// stealing the capture window's focus/paint, etc.) well before the
// operator notices from the stream itself. Never auto-stops anything —
// see item 14/33: this surfaces a warning via /health for the panel to
// show, it does not make the decision to pull the stream.
const PROGRAM_FEED_MONITOR_INTERVAL_MS = 30000;
async function monitorProgramFeedHealth() {
    if (!NATIVE_CAPTURE_SUPPORTED) return;
    // The native pipeline doesn't have a gdigrab window to sample this
    // way — GET /program-feed-health covers the (simplified) equivalent
    // check for it on demand; a periodic background version of that is
    // a known gap, not yet built.
    if (NATIVE_PROGRAM_FEED) return;
    if (engine.state === 'live' && engine.matchId && engine.settings) {
        const windowTitle = resolveWindowTitle(engine.matchId);
        const health = await runProgramFeedHealthCheck({ windowTitle, width: engine.settings.width, height: engine.settings.height, fps: engine.settings.fps });
        engine.lastProgramFeedHealth = health;
        if (health.black || health.white || health.frozen) {
            console.log(`[stream-engine] ⚠ PROGRAM FEED WARNING (live): ${health.black ? 'BLACK' : health.white ? 'WHITE' : 'FROZEN'} — YouTube may be receiving a bad picture right now`);
        }
    }
    if (recorder.state === 'recording' && recorder.matchId && recorder.settings) {
        const windowTitle = resolveWindowTitle(recorder.matchId);
        const health = await runProgramFeedHealthCheck({ windowTitle, width: recorder.settings.width, height: recorder.settings.height, fps: recorder.settings.fps });
        recorder.lastProgramFeedHealth = health;
        if (health.black || health.white || health.frozen) {
            console.log(`[stream-engine] ⚠ PROGRAM FEED WARNING (recording): ${health.black ? 'BLACK' : health.white ? 'WHITE' : 'FROZEN'} — master.mp4 may be recording a bad picture right now`);
        }
    }
    // Disk can fill up mid-match, not just at recording start (see the
    // hard-floor check in startRecorder) — check on the same cadence so
    // the operator gets a warning well before a write actually fails and
    // leaves a truncated/corrupted master.mp4.
    if (recorder.state === 'recording') {
        const freeBytes = diskFreeBytes(RECORDING_ROOT);
        if (freeBytes != null && freeBytes < LOW_DISK_WARNING_BYTES) {
            console.log(`[stream-engine] ⚠ LOW DISK SPACE: only ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)}GB free on the recording drive while recording is active`);
        }
    }
}
setInterval(() => { monitorProgramFeedHealth().catch((e) => console.log('[stream-engine] monitorProgramFeedHealth error (kept running):', e.message)); }, PROGRAM_FEED_MONITOR_INTERVAL_MS);

// 🗂️ No automatic deletion of anything in the recordings folder. Clips
// are kept locally next to master.mp4 (operator request). The old 24h
// "orphan clip" sweep is gone: clips share their folder with the match
// recording, so it also deleted any master.mp4 older than a day.

// ================================================================
// 🩺 SUPERVISOR — "the process is alive" is not proof that anything is
// being written. Every 5s this checks each subsystem against its OWN
// progress signal and restarts only the one that stopped moving:
//   - recorder: ffmpeg's reported output time and the segment file's
//     size must keep advancing while the program feed is flowing;
//   - live encoder: its reported output time must keep advancing;
//   - compositor: its own watchdog (nativePipeline.js) — no relay data.
// A stalled recorder continues in a new segment; the stream, the
// compositor and the clip queue are never touched by that.
// ================================================================
const SUPERVISOR_TICK_MS = 5000;
const RECORDER_STALL_MS = 30000;      // no new output time for this long = stuck
const RECORDER_FILE_STALL_MS = 45000; // file size unchanged for this long = stuck (fMP4 grows every ~2s)
const LIVE_STALL_MS = 30000;
const RECORDER_STABLE_RESET_MS = 60000;
const HEALTH_LOG_INTERVAL_MS = 10 * 60 * 1000;

function programFeedFlowing() {
    if (!NATIVE_PROGRAM_FEED) return true; // legacy: each process captures on its own
    return !!(compositor && compositor.state === 'running' && compositor.relay.lastDataAt && Date.now() - compositor.relay.lastDataAt < 5000);
}

function superviseRecorder(now) {
    if (recorder.state !== 'recording' || !recorder.proc || !recorder.currentSegment) return;
    const seg = recorder.currentSegment;
    fs.stat(seg.path, (err, st) => {
        if (err || recorder.currentSegment !== seg) return;
        if (st.size !== recorder.lastSizeBytes) { recorder.lastSizeBytes = st.size; recorder.lastSizeChangeAt = Date.now(); }
    });
    if (recorder.restarts.length && now - recorder.startedAt > RECORDER_STABLE_RESET_MS && recorder.lastProgressAdvanceAt && now - recorder.lastProgressAdvanceAt < 5000) {
        recorder.restarts = []; // this segment is healthy — the next failure starts from the shortest backoff again
    }
    if (!programFeedFlowing()) return; // nothing to write — the compositor's own watchdog handles the source
    const progressAgo = now - (recorder.lastProgressAdvanceAt || recorder.startedAt);
    const sizeAgo = now - (recorder.lastSizeChangeAt || recorder.startedAt);
    let reason = null;
    if (progressAgo > RECORDER_STALL_MS) reason = `no new video encoded for ${Math.round(progressAgo / 1000)}s`;
    else if (sizeAgo > RECORDER_FILE_STALL_MS) reason = `${path.basename(seg.path)} has not grown for ${Math.round(sizeAgo / 1000)}s`;
    if (!reason) return;
    console.log(`[stream-engine] ⚠ Recorder stalled (${reason}) while the program feed is live — restarting only the recorder`);
    recorder.lastError = `stalled — ${reason}`;
    try { recorder.proc.kill('SIGKILL'); } catch (e) { /* already gone */ } // exit handler continues in a new segment
}

function superviseLive(now) {
    if (engine.state !== 'live' || !engine.proc || !engine.startedAt) return;
    if (!programFeedFlowing()) return;
    const ago = now - (engine.lastProgressAdvanceAt || engine.startedAt);
    if (ago <= LIVE_STALL_MS) return;
    console.log(`[stream-engine] ⚠ Live encoder stalled (no output for ${Math.round(ago / 1000)}s) — reconnecting the stream; recording is unaffected`);
    engine.lastError = `live encoder stalled — no output for ${Math.round(ago / 1000)}s`;
    try { engine.proc.kill('SIGKILL'); } catch (e) { /* already gone */ } // exit handler → reconnect with backoff
}

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s % 60).padStart(2, '0')}s`;
}
function resourceSnapshot() {
    const mem = process.memoryUsage();
    const roles = {};
    for (const { role } of childProcesses.values()) roles[role] = (roles[role] || 0) + 1;
    return {
        uptimeSec: Math.round(process.uptime()),
        rssMB: Math.round(mem.rss / 1048576),
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
        externalMB: Math.round((mem.external + (mem.arrayBuffers || 0)) / 1048576),
        childProcesses: childProcesses.size,
        childRoles: roles,
        clipJobsInMemory: clipJobs.size,
        clipTimersPending: clipTimers.size,
        retryQueueLength: retryQueue.length,
    };
}
// One compact line every 10 minutes while anything is running, so a
// 6–7 hour run leaves a readable record that memory, process count and
// queues stayed flat.
let lastHealthLogAt = Date.now();
function logHealthLine(now) {
    if (now - lastHealthLogAt < HEALTH_LOG_INTERVAL_MS) return;
    const active = recorder.state === 'recording' || engine.state === 'live' || engine.state === 'reconnecting' || compositor;
    if (!active) return;
    lastHealthLogAt = now;
    const r = resourceSnapshot();
    const parts = [`up ${formatDuration(r.uptimeSec * 1000)}`, `rss ${r.rssMB}MB`, `ffmpeg/child procs ${r.childProcesses} (${Object.entries(r.childRoles).map(([k, v]) => `${k}${v > 1 ? '×' + v : ''}`).join(', ') || 'none'})`];
    if (recorder.state === 'recording' && recorder.currentSegment) parts.push(`recording ${formatDuration((recorder.currentSegment.outTimeSec || 0) * 1000)} in ${path.basename(recorder.currentSegment.path)} (restarts ${recorder.totalRestarts})`);
    if (engine.state !== 'idle') parts.push(`live ${engine.state}${engine.metrics.speed != null ? ` ${engine.metrics.speed}x` : ''}`);
    if (compositor) {
        const st = compositor.stats();
        parts.push(`relay ${st.relayMBps}MB/s → ${st.consumers.map((c) => `${c.who}:${c.state}${c.unitsSkipped ? ` (skipped ${c.unitsSkipped})` : ''}`).join(', ') || 'no consumers'}`);
    }
    parts.push(`clips ${clipStats.cut} ok / ${clipStats.failed} failed, queue ${clipCutQueue.length}`);
    console.log(`[health] ${parts.join(' | ')}`);
}

setInterval(() => {
    if (shuttingDown) return;
    const now = Date.now();
    try { superviseRecorder(now); } catch (e) { console.log('[stream-engine] recorder supervisor error:', e.message); }
    try { superviseLive(now); } catch (e) { console.log('[stream-engine] live supervisor error:', e.message); }
    try { logHealthLine(now); } catch (e) { /* diagnostics only */ }
}, SUPERVISOR_TICK_MS);

// 🖱️ Windows console QuickEdit: a single click inside this console
// window puts it in "Select" mode, and from then on every console write
// BLOCKS until a key is pressed — freezing this whole process (and with
// it the relay feeding the recorder and live encoder) mid-match. Turn
// QuickEdit off for this console window only; text can still be copied
// via the window menu (Edit → Mark).
function disableConsoleQuickEdit() {
    if (process.platform !== 'win32' || !process.stdin.isTTY) return;
    const script = [
        "$sig = '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetStdHandle(int h); [DllImport(\"kernel32.dll\")] public static extern bool GetConsoleMode(IntPtr h, out uint m); [DllImport(\"kernel32.dll\")] public static extern bool SetConsoleMode(IntPtr h, uint m);'",
        '$k = Add-Type -MemberDefinition $sig -Name QuickEdit -Namespace AllSportsLive -PassThru',
        '$h = $k::GetStdHandle(-10); $m = 0',
        'if ($k::GetConsoleMode($h, [ref]$m)) { [void]$k::SetConsoleMode($h, (($m -band (-bnot 0x40)) -bor 0x80)) }',
    ].join('; ');
    try {
        // stdin inherited = same console (see libuv: no CREATE_NO_WINDOW when a stdio handle is inherited)
        const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: ['inherit', 'ignore', 'ignore'], windowsHide: true });
        ps.on('error', () => {});
    } catch (e) { /* best effort */ }
}

// Leftover *.part.mp4 files can only come from a cut interrupted by a
// previous run ending — nothing is cutting yet at startup.
function sweepPartialClipFiles() {
    fs.readdir(CLIPS_ROOT, (err, dirs) => {
        if (err) return;
        for (const d of dirs) {
            fs.readdir(path.join(CLIPS_ROOT, d), (err2, files) => {
                if (err2) return;
                for (const f of files) if (f.endsWith('.part.mp4')) fs.unlink(path.join(CLIPS_ROOT, d, f), () => {});
            });
        }
    });
}

const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`🎥 AllSportsLive Stream Engine (native capture) running at http://127.0.0.1:${PORT} (localhost only)`);
    console.log(`   Platform: ${process.platform}${NATIVE_CAPTURE_SUPPORTED ? '' : ' — ⚠️ native capture (gdigrab/dshow) needs Windows; this engine cannot capture on this OS'}`);
    console.log(`   ffmpeg: ${FFMPEG_PATH} (${FFMPEG_SOURCE})${FFMPEG_SOURCE !== 'bundled' ? ' — see stream-engine/bin/README.md to bundle ffmpeg instead of relying on this' : ''}`);
    console.log(`   ffprobe: ${ffprobeAvailable() ? `${FFPROBE_PATH} (${FFPROBE_SOURCE})` : '❌ NOT available — clip/recording integrity checks are disabled (see stream-engine/bin/README.md)'}`);
    if (!ffmpegAvailable()) {
        console.log(`   ⚠️ ffmpeg itself could not be run at all (${FFMPEG_PATH}) — nothing here will work until this is fixed. See stream-engine/bin/README.md.`);
    }
    const nvenc = checkNvenc();
    console.log(`   NVENC: ${nvenc.available ? '✅ available' : '❌ NOT available — ' + nvenc.detail}`);
    reapOrphanedChildren();
    disableConsoleQuickEdit();
    sweepPartialClipFiles();
    // Run the one-time capability probes NOW, while nothing is streaming:
    // each is a short blocking test encode, and running them lazily at
    // the first Go Live/Recording froze the event loop while the relay
    // for the other one was already flowing.
    setImmediate(() => {
        if (!nvenc.available) return;
        checkNvencRuntime();
        checkNvencTuneRuntime();
        checkGpuScaleRuntime(); // also read by /status and /health
        if (!NATIVE_PROGRAM_FEED) cfrFlagArgs();
    });
});

process.on('uncaughtException', (err) => {
    // The engine's whole job is to keep streaming even when ffmpeg has
    // problems — an uncaught exception here must not kill this process
    // out from under a live broadcast. Log and keep running.
    console.log('[stream-engine] uncaughtException (kept running):', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.log('[stream-engine] unhandledRejection (kept running):', reason && reason.stack ? reason.stack : reason);
});

// ----------------------------------------------------------------
// 🛑 GRACEFUL SHUTDOWN — ordered, awaited, and bounded:
//   1. mark shuttingDown (every auto-restart/retry path checks it),
//   2. end the live encoder and recorder on a packet boundary and WAIT
//      for them to exit (MP4/FLV properly finalized),
//   3. stop clip cuts and pending clip timers,
//   4. stop the compositor ('q' → camera released by ffmpeg itself) and
//      the overlay's Chromium,
//   5. kill anything still alive, clear the PID file, exit.
// A hard deadline guarantees the process never hangs. Closing the
// console window (SIGHUP on Windows) gets a faster path because Windows
// terminates the process a few seconds later regardless.
// ----------------------------------------------------------------
function killAllChildren() {
    for (const { proc } of childProcesses.values()) { try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ } }
}
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    const fast = signal === 'SIGHUP';
    const deadline = setTimeout(() => {
        console.log('[stream-engine] Shutdown took too long — forcing remaining processes to stop');
        killAllChildren();
        process.exit(0);
    }, fast ? 4000 : 12000);
    console.log(`[stream-engine] ${signal} received — stopping stream, recording and background jobs…`);
    engine.opToken++;
    engine.desiredLive = false;
    recorder.desiredRecording = false;
    if (recorder.restartTimer) { clearTimeout(recorder.restartTimer); recorder.restartTimer = null; }
    for (const t of clipTimers) clearTimeout(t);
    clipTimers.clear();
    clipCutQueue.length = 0;

    const waits = [];
    const stopTimeout = fast ? 1500 : 5000;
    for (const proc of [engine.proc, recorder.proc]) {
        if (!proc) continue;
        if (NATIVE_PROGRAM_FEED) {
            if (compositor) compositor.detachRelayConsumer(proc);
            waits.push(gracefulStopByClosingStdin(proc, stopTimeout));
        } else {
            waits.push(gracefulStop(proc, stopTimeout));
        }
    }
    for (const proc of activeClipCuts.values()) { try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ } }
    await Promise.all(waits);
    if (recorder.segmentPath && waits.length) console.log(`[stream-engine] Recording finalized — ${recorder.segmentPath}`);

    if (compositor) {
        const comp = compositor;
        compositor = null;
        await comp.stop({ timeoutMs: fast ? 1000 : 3000 });
    }
    if (compositorStopping) await compositorStopping;
    if (captureWindow.proc) closeCaptureWindow(); // never leave the dedicated capture browser process orphaned
    flushClipJobsSync();
    killAllChildren();
    try { fs.writeFileSync(CHILD_PIDS_FILE, JSON.stringify({ ffmpegPath: FFMPEG_PATH, pids: [] })); } catch (e) { /* best effort */ }
    clearTimeout(deadline);
    server.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    console.log('[stream-engine] Stopped cleanly — no ffmpeg processes left running.');
    process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => { gracefulShutdown(sig).catch((e) => { console.log('[stream-engine] shutdown error:', e.message); killAllChildren(); process.exit(1); }); }); } catch (e) { /* signal not supported on this platform */ }
}
// Last line of defence for ANY exit path (including a fatal crash):
// never leave an ffmpeg holding the camera/NVENC behind.
process.on('exit', killAllChildren);
