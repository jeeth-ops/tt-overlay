// ================================================================
// 🎥 AllSportsLive Stream Engine — LOCAL companion service (Parts 2 & 3)
//
// Runs on the OPERATOR'S OWN PC, next to the Cricket Panel browser tab.
// NEVER deployed to Render. Two jobs, fed by the SAME incoming browser
// capture (one MediaRecorder, no duplicate encoders):
//
//   1. (Part 2) Encode it with the GPU (NVENC) and push it to YouTube:
//        Camera + Audio (browser) → THIS PROCESS → NVIDIA NVENC → YouTube RTMPS
//
//   2. (Part 3) ALSO write it into a local rolling buffer (localBuffer.js)
//      that the EXISTING clipper logic in cricket-panel.html now reads
//      from instead of vMix's recording file:
//        Camera + Audio (browser) → THIS PROCESS → local buffer
//        → /clip cuts a highlight (same pre/post-roll as Part 1)
//        → forwarded to server.js's EXISTING /api/clips/ingest
//        → EXISTING Cloudflare/Drive/Mongo pipeline (untouched)
//
// This process implements the SAME local HTTP contract
// (/status, /recording-start, /recording-stop, /clip) the panel
// already calls for ClipperHelper.exe — so recordBall()/
// triggerWicketClip() in cricket-panel.html needed ZERO changes to
// their clip-triggering logic; only the URL they point at changed
// (see LOCAL_ENGINE_URL in cricket-panel.html). vMix is never in this
// loop at all.
//
// Render/server.js only ever receives: (a) short finished clip files
// via the existing /api/clips/ingest (same as the old ClipperHelper.exe
// path — small, ~20s files, not the continuous stream), and (b) score/
// control data via socket.io, exactly as before. The continuous 1080p
// YouTube feed never touches Render.
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
const localBuffer = require('./localBuffer');

const PORT = process.env.STREAM_ENGINE_PORT || 5006;
const CONFIG_FILE = path.join(__dirname, 'config.local.json'); // gitignored — never committed

// ----------------------------------------------------------------
// ffmpeg resolution — prefer an explicitly configured NVENC-capable
// build over the minimal one @ffmpeg-installer/ffmpeg ships (that
// package's binaries are built WITHOUT hardware encoders, so relying
// on it here would silently mean "no NVENC ever". Order of preference:
//   1. FFMPEG_PATH env var (operator points this at a full/NVIDIA build,
//      e.g. the gyan.dev "full" Windows build)
//   2. a system `ffmpeg` already on PATH
// There is deliberately no fallback to a bundled minimal ffmpeg here —
// if neither of the above has NVENC, /status reports it honestly as
// unavailable instead of quietly encoding on the CPU.
// ----------------------------------------------------------------
function resolveFfmpegPath() {
    if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
    return 'ffmpeg'; // resolved via PATH by child_process
}
const FFMPEG_PATH = resolveFfmpegPath();

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveConfig(cfg) {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) { console.log('config save error:', e.message); }
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
    if (nvencCheckCache && Date.now() - nvencCheckCache.checkedAt < 30000) return nvencCheckCache;
    let available = false, detail = '';
    try {
        const res = spawnSync(FFMPEG_PATH, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
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

function ffmpegAvailable() {
    const res = spawnSync(FFMPEG_PATH, ['-version'], { encoding: 'utf8', timeout: 5000 });
    return !res.error;
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
// 🖥️ CPU UTILIZATION — cross-platform (works on Windows, unlike
// os.loadavg() which is always [0,0,0] there) system CPU load, sampled
// as a delta between successive /health polls. Purely informational,
// same spirit as readGpuUtilization() below: confirms NVENC is doing
// the work, not the CPU.
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

// ----------------------------------------------------------------
// 🎬 ENCODER STATE MACHINE — single stream at a time, never duplicated.
// idle -> starting -> live -> stopping -> idle
//                   -> crashed -> (auto-restart) -> starting
// ----------------------------------------------------------------
const MAX_AUTO_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;

const engine = {
    state: 'idle',           // idle | starting | live | stopping | crashed
    proc: null,              // the ffmpeg child process
    desiredLive: false,      // operator's intent — drives whether a crash should auto-restart
    startedAt: null,
    restarts: [],            // timestamps of recent auto-restarts, for the bounded-retry window
    lastError: null,
    settings: null,          // {resolution, fps, bitrateKbps}
    metrics: { bitrateKbps: null, fps: null, droppedFrames: null, outTimeSec: null },
};

function resetMetrics() {
    engine.metrics = { bitrateKbps: null, fps: null, droppedFrames: null, outTimeSec: null };
}

// Parses ffmpeg's `-progress pipe:2`-style key=value lines (we route
// -progress to a pipe and read it) — see buildFfmpegArgs.
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
    } else if (key === 'drop_frames') {
        const num = parseInt(value, 10);
        if (!Number.isNaN(num)) engine.metrics.droppedFrames = num;
    } else if (key === 'out_time_ms') {
        const num = parseInt(value, 10);
        if (!Number.isNaN(num)) engine.metrics.outTimeSec = Math.round(num / 1000000);
    }
}

// ----------------------------------------------------------------
// 📐 RESOLUTION / FPS PRESETS — operator picks a resolution (480p/720p/
// 1080p) and fps (30/60) in the panel; these map to actual pixel
// dimensions and a sane default CBR bitrate for that combo (standard
// YouTube Live recommendations). bitrateKbps can still be overridden
// explicitly if the panel sends one, but the table means a sensible
// value is always used even if it doesn't.
// ----------------------------------------------------------------
const RESOLUTIONS = {
    '480p':  { width: 854,  height: 480 },
    '720p':  { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
};
const DEFAULT_BITRATE_KBPS = {
    '480p':  { 30: 2000,  60: 2500 },
    '720p':  { 30: 3500,  60: 5500 },
    '1080p': { 30: 6000,  60: 12000 }, // 1080p30 default kept close to the original ~10Mbps spec; adjustable
};

function resolveEncodeSettings({ resolution, fps, bitrateKbps, keyframeIntervalSec }) {
    const resKey = RESOLUTIONS[resolution] ? resolution : '1080p';
    const fpsNum = [30, 60].includes(Number(fps)) ? Number(fps) : 30;
    const { width, height } = RESOLUTIONS[resKey];
    const kbps = Number(bitrateKbps) > 0 ? Number(bitrateKbps) : DEFAULT_BITRATE_KBPS[resKey][fpsNum];
    // Configurable so future presets (1080p60, different bitrate/GOP)
    // don't need new code paths — just different values sent here.
    const gopSec = Number(keyframeIntervalSec) > 0 ? Number(keyframeIntervalSec) : 2;
    // 'resolution' (not 'resolutionLabel') on purpose — engine.settings is
    // fed straight back into startEncoder() on an auto-restart (see the
    // ffmpeg exit handler), so this needs to round-trip through
    // resolveEncodeSettings a second time using the SAME key it reads.
    return { width, height, fps: fpsNum, bitrateKbps: kbps, keyframeIntervalSec: gopSec, resolution: resKey };
}

function buildFfmpegArgs({ width, height, fps, bitrateKbps, keyframeIntervalSec, destinationUrl }) {
    const gop = Math.round(fps * keyframeIntervalSec);
    return [
        '-hide_banner', '-loglevel', 'warning',
        '-i', 'pipe:0',
        '-c:v', 'h264_nvenc',
        // p4 = balanced speed/quality; tune ll = NVENC's low-latency mode
        // (skips B-frames and extra lookahead that add encode latency —
        // matters for a LIVE stream, where every extra ms of encoder
        // buffering is a second the broadcast falls further behind).
        '-preset', 'p4', '-tune', 'll',
        '-rc', 'cbr',
        '-b:v', `${bitrateKbps}k`,
        '-maxrate', `${bitrateKbps}k`,
        '-bufsize', `${bitrateKbps * 2}k`,
        '-g', String(gop),
        '-keyint_min', String(gop),
        '-vf', `scale=${width}:${height}`,
        '-r', String(fps),
        '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
        '-f', 'flv',
        '-progress', 'pipe:2', '-nostats',
        destinationUrl,
    ];
}

function startEncoder({ resolution, fps, bitrateKbps, keyframeIntervalSec }) {
    if (engine.state === 'live' || engine.state === 'starting') {
        return { ok: false, error: 'Already live — stop the current stream first' };
    }
    if (!streamUrl) return { ok: false, error: 'No Stream URL set' };
    if (!isValidRtmpUrl(streamUrl)) return { ok: false, error: 'Stream URL must start with rtmp:// or rtmps://' };
    if (!streamKey) return { ok: false, error: 'No Stream Key set' };
    const nvenc = checkNvenc();
    if (!nvenc.available) {
        return { ok: false, error: `NVENC not available (${nvenc.detail}) — refusing to fall back to CPU encoding` };
    }

    resetMetrics();
    encoderBackpressured = false;
    const resolved = resolveEncodeSettings({ resolution, fps, bitrateKbps, keyframeIntervalSec });
    engine.settings = resolved;
    engine.state = 'starting';
    engine.desiredLive = true;
    engine.lastError = null;

    // The destination (Stream URL + Stream Key) is built fresh from
    // current config, never logged, never included in engine.settings
    // (which /health exposes) — only passed straight to ffmpeg's argv.
    const destinationUrl = buildDestinationUrl(streamUrl, streamKey);
    const args = buildFfmpegArgs({ ...resolved, destinationUrl });
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    engine.proc = proc;
    engine.startedAt = Date.now();
    engine.state = 'live';

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        let idx;
        while ((idx = stderrBuf.indexOf('\n')) >= 0) {
            const line = stderrBuf.slice(0, idx);
            stderrBuf = stderrBuf.slice(idx + 1);
            parseProgressLine(line);
            if (/error|failed|refused|denied/i.test(line)) engine.lastError = line.trim();
        }
    });

    proc.on('exit', (code, signal) => {
        const wasDesired = engine.desiredLive;
        console.log(`[stream-engine] ffmpeg exited (code=${code}, signal=${signal}); desiredLive=${wasDesired}`);
        engine.proc = null;

        if (!wasDesired) {
            // Operator pressed STOP — this is the expected, graceful path.
            engine.state = 'idle';
            return;
        }

        // Unexpected exit while we still wanted to be live — this is a
        // crash. Never let it take down the Stream Engine process itself
        // (we're inside an event handler, nothing here throws upward),
        // and never let the Cricket Panel crash either — it just sees
        // state:'crashed' via /health and shows an error.
        engine.state = 'crashed';
        engine.lastError = engine.lastError || `ffmpeg exited unexpectedly (code=${code}, signal=${signal})`;

        const now = Date.now();
        engine.restarts = engine.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
        if (engine.restarts.length >= MAX_AUTO_RESTARTS) {
            console.log('[stream-engine] Max auto-restarts hit — giving up until operator presses Go Live again');
            engine.desiredLive = false;
            return;
        }
        engine.restarts.push(now);
        const attempt = engine.restarts.length;
        console.log(`[stream-engine] Auto-restarting encoder (attempt ${attempt}/${MAX_AUTO_RESTARTS})…`);
        setTimeout(() => {
            if (engine.desiredLive) startEncoder(engine.settings);
        }, Math.min(2000 * attempt, 8000)); // simple backoff
    });

    proc.on('error', (err) => {
        console.log('[stream-engine] ffmpeg spawn error:', err.message);
        engine.lastError = err.message;
        engine.state = 'crashed';
    });

    return { ok: true };
}

function stopEncoder() {
    engine.desiredLive = false;
    if (!engine.proc) { engine.state = 'idle'; return { ok: true, alreadyIdle: true }; }
    engine.state = 'stopping';
    // Ask ffmpeg to end the stream cleanly (closing stdin = end of input,
    // ffmpeg flushes and exits on its own) rather than SIGKILL, so YouTube
    // sees a proper stream end instead of a hard cut.
    try { engine.proc.stdin.end(); } catch (e) { /* already closed */ }
    // Safety timeout: force-kill if it hasn't exited on its own shortly.
    const proc = engine.proc;
    setTimeout(() => {
        if (engine.proc === proc) {
            try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
        }
    }, 5000);
    return { ok: true };
}

// 🔒 BACKPRESSURE — if the encoder can't keep up (underpowered machine,
// a slow moment, NVENC briefly stalling) Node's stdin.write() buffers
// internally and its return value goes false. Piling MORE chunks on
// top of an already-backed-up pipe only grows that buffer without
// bound and makes the LIVE stream fall further and further behind
// real time — for a live broadcast, a skipped frame is far better than
// ever-growing latency. So: once backpressured, incoming chunks are
// dropped (not queued) until the encoder catches up and drains.
let encoderBackpressured = false;
function ingestChunk(buf) {
    if (engine.state !== 'live' || !engine.proc || !engine.proc.stdin.writable) return { ok: false, error: 'Encoder not live' };
    if (encoderBackpressured) return { ok: false, error: 'Encoder backpressured — dropping frame to protect live latency', dropped: true };
    try {
        const stillOk = engine.proc.stdin.write(buf);
        if (!stillOk) {
            encoderBackpressured = true;
            engine.proc.stdin.once('drain', () => { encoderBackpressured = false; });
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ================================================================
// 🎬 PART 3 — CLIP ENGINE (reads from localBuffer.js, the vMix-free
// local recording/buffer; forwards finished clips to the EXISTING
// /api/clips/ingest on server.js — same endpoint ClipperHelper.exe
// always posted to, same Cloudflare/Drive/Mongo pipeline, untouched).
// ================================================================
// 🎯 EXACT CLIP TIMING — non-negotiable. T0 is the click/event moment
// (the panel captures it and sends it as `timestamp`, already frozen
// against the finalized ball's own metadata — see triggerClip() in
// cricket-panel.html). The clip is T0-15s through T0+5s (~20s total).
// The post-roll 5 seconds are an ACTUAL WAIT before cutting — the
// buffer simply doesn't have footage from the future yet, so cutting
// immediately (the previous behavior) silently produced a clip missing
// its whole post-roll. T0 itself is captured once and never
// recalculated after the wait.
const CLIP_PRE_ROLL_SEC = 15;
const CLIP_POST_ROLL_SEC = 5;

const recordingMatches = {}; // matchId -> { mainServerUrl, tournamentId } — set by /recording-start
const clipWorker = {
    state: 'idle', // idle | cutting | uploading
    lastError: null,
    cloudflareConnected: true, // optimistic until a forward attempt actually fails
};
// ================================================================
// 🎬 PERSISTENT CLIP JOBS — one per accepted FOUR/SIX/WICKET event,
// never silently canceled once created (see requestClip below). Kept
// in memory for live status (the panel polls GET /clip-jobs/:clipId)
// AND persisted to disk so a restart doesn't erase the operator's view
// of what was in flight — though see the CUTTING-recovery note below
// for the one thing a restart genuinely cannot get back.
//
// Lifecycle: WAITING_FOR_POSTROLL -> CUTTING -> LOCAL_SAVED ->
//            FORWARDING -> COMPLETE
//                        -> RETRY_PENDING (Render reachable, R2/Drive
//                           still finishing — polled from server.js)
//                        -> FAILED_PERMANENT (loud, never silent —
//                           local .mp4 is kept either way until
//                           server.js confirms both R2 AND Drive)
// ================================================================
const CLIP_JOBS_FILE = path.join(__dirname, 'clip-jobs.local.json');
const clipJobs = new Map(); // clipId -> job
function loadClipJobs() {
    try {
        const raw = JSON.parse(fs.readFileSync(CLIP_JOBS_FILE, 'utf8'));
        for (const job of raw) clipJobs.set(job.clipId, job);
    } catch (e) { /* first run, or file doesn't exist yet — nothing to load */ }
}
function persistClipJobs() {
    try { fs.writeFileSync(CLIP_JOBS_FILE, JSON.stringify([...clipJobs.values()].slice(-200))); } catch (e) { /* best effort */ }
}
function updateJob(clipId, patch) {
    const job = clipJobs.get(clipId);
    if (!job) return;
    Object.assign(job, patch, { updatedAt: Date.now() });
    persistClipJobs();
}
function buildClipId(matchId, eventType, timestamp) {
    return `${localBuffer.safeMatchId(matchId)}_${String(eventType || 'CLIP').toUpperCase()}_${timestamp}`;
}
loadClipJobs();
// 🩹 RESTART RECOVERY: a job still sitting in WAITING_FOR_POSTROLL or
// CUTTING when this process last exited had its source footage only in
// RAM (localBuffer's chunks are never persisted to survive a restart —
// only the finished, already-cut .mp4 is durable). That specific 20s
// window is genuinely unrecoverable after a crash/restart — but the
// job is marked LOUDLY as failed instead of vanishing silently, and
// every OTHER job (already LOCAL_SAVED/FORWARDING/RETRY_PENDING, whose
// .mp4 already exists on disk) is untouched and keeps being retried
// normally by the logic further down.
for (const job of clipJobs.values()) {
    if (job.status === 'WAITING_FOR_POSTROLL' || job.status === 'CUTTING') {
        job.status = 'FAILED_PERMANENT';
        job.error = 'Stream Engine restarted before this clip could be cut — its source footage only ever existed in memory and could not survive the restart.';
    }
}
persistClipJobs();

// 🔁 RETRY QUEUE — a clip that cuts fine locally but can't reach
// server.js right now (network blip, Render redeploying, etc.) is
// NEVER discarded. It stays queued and is retried with backoff; the
// local .mp4 is only deleted once server.js has confirmed it received
// the bytes (mirrors finalizeClip()'s own "don't delete on upload
// failure" rule on the server side — same philosophy, this end of the
// pipe).
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
// background and can take a while (or fail and retry there too — see
// the retry sweep in server.js). This is what lets the panel's live
// status actually reach COMPLETE / show a real failure reason, instead
// of the operator only ever seeing "forwarded" and nothing else.
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
            // Render has confirmed BOTH R2 and Drive now have this clip —
            // only NOW is the operator's own local copy redundant. Never
            // deleted any earlier than this (see the "never delete
            // prematurely" note where this file was created).
            if (job.localPath) fs.unlink(job.localPath, (err) => { if (!err) console.log(`🧹 [CLIP] clipId=${job.clipId} — local copy removed (R2 + Drive both confirmed)`); });
            return;
        }
        if (data.status === 'FAILED_PERMANENT') return; // done — stop polling; local file is deliberately left in place
    }
}

const MAX_RETRY_ATTEMPTS = 20; // ~ backoff up to a few minutes total, then give up but KEEP the local file for manual recovery
function scheduleRetry(entry) {
    const attempt = (entry.attempts || 0);
    const delayMs = Math.min(5000 * Math.pow(1.5, attempt), 60000);
    setTimeout(() => processRetryEntry(entry), delayMs);
}
async function processRetryEntry(entry) {
    if (!fs.existsSync(entry.filePath)) {
        retryQueue = retryQueue.filter((e) => e !== entry);
        persistRetryQueue();
        if (entry.clipId) updateJob(entry.clipId, { status: 'FAILED_PERMANENT', error: 'Local clip file was removed before it could be forwarded' });
        return; // was cleaned up (e.g. manually) — nothing left to retry
    }
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.clipId) updateJob(entry.clipId, { status: 'RETRY_PENDING', forwardAttempts: entry.attempts });
    const result = await postFileToServer(entry.mainServerUrl, entry.matchId, entry.eventType, entry.timestamp, entry.ballMeta, entry.filePath, entry.clipId);
    if (result.ok) {
        clipWorker.cloudflareConnected = true;
        retryQueue = retryQueue.filter((e) => e !== entry);
        persistRetryQueue();
        // NOT deleted here — Render has only just acknowledged RECEIPT
        // of the bytes, not that R2+Drive both confirmed storing them.
        // pollRenderStatus() below is what deletes this file, and only
        // once Render reports COMPLETE.
        console.log(`[stream-engine] Retry succeeded for queued clip: ${entry.matchId}/${entry.eventType}`);
        if (entry.clipId) {
            updateJob(entry.clipId, { status: 'FORWARDING' });
            const job = clipJobs.get(entry.clipId);
            if (job) pollRenderStatus(job);
        }
    } else {
        clipWorker.cloudflareConnected = false;
        clipWorker.lastError = result.error;
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

async function cutLocalClip({ clipId, matchId, eventType, eventTimestamp, ballMeta }) {
    const win = localBuffer.getClipWindow({ matchId, eventTimestamp, preRollSec: CLIP_PRE_ROLL_SEC, postRollSec: CLIP_POST_ROLL_SEC });
    if (win.error) return { ok: false, error: win.error };

    const { trimStartSec, toStitch, dirs } = win;
    const stitchedFile = path.join(dirs.tempDir, `_stitched_${Date.now()}.webm`);
    // Deterministic, clipId-based filename (not Date.now()-based) — a
    // job re-run for the exact same event never leaves multiple .mp4s
    // behind, and this is the SAME name server.js's R2 key/Drive
    // filename are derived from (see buildClipId there), so the whole
    // pipeline refers to one clip by one identity end to end.
    const outFile = path.join(dirs.clipsDir, `${clipId}.mp4`);

    console.log(`[CLIP RANGE] clipId=${clipId} start=T0-${CLIP_PRE_ROLL_SEC}s end=T0+${CLIP_POST_ROLL_SEC}s`);

    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(stitchedFile);
        out.on('error', reject);
        (async () => {
            for (const c of toStitch) {
                await new Promise((res2, rej2) => {
                    const rs = fs.createReadStream(c.file);
                    rs.on('error', rej2);
                    rs.on('end', res2);
                    rs.pipe(out, { end: false });
                });
            }
            out.end();
            resolve();
        })().catch(reject);
    });

    await new Promise((resolve, reject) => {
        const args = [
            '-hide_banner', '-loglevel', 'warning', '-y',
            '-i', stitchedFile,
            '-ss', String(trimStartSec), '-t', String(CLIP_PRE_ROLL_SEC + CLIP_POST_ROLL_SEC),
            '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'veryfast',
            outFile,
        ];
        const proc = spawn(FFMPEG_PATH, args);
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg trim exited ${code}: ${stderr.slice(-300)}`)));
        proc.on('error', reject);
    });

    fs.unlink(stitchedFile, () => {});
    console.log(`[CLIP CREATED] clipId=${clipId} localPath=${outFile}`);
    return { ok: true, outFile };
}

// ================================================================
// 🎬 THE JOB, END TO END — runs once, ~CLIP_POST_ROLL_SEC after the
// event, and is NEVER canceled/re-triggered by anything that happens
// on the panel afterward (over ending, batsman/bowler change, popup
// closing, a reconnect, another clip event — none of it touches this
// job; it owns its own frozen matchId/eventType/timestamp/ballMeta).
// A failure at ANY stage moves the job to RETRY_PENDING/
// FAILED_PERMANENT — it never just disappears (see updateJob calls).
// ================================================================
async function runClipJob(clipId) {
    const job = clipJobs.get(clipId);
    if (!job) return; // shouldn't happen — created synchronously in acceptClipEvent below
    const { matchId, eventType, timestamp, ballMeta, mainServerUrl } = job;

    updateJob(clipId, { status: 'CUTTING' });
    clipWorker.state = 'cutting';
    console.log(`[CLIP WAIT] clipId=${clipId} post-roll wait complete — cutting now`);
    const cutResult = await cutLocalClip({ clipId, matchId, eventType, eventTimestamp: timestamp, ballMeta }).catch((e) => ({ ok: false, error: e.message }));
    if (!cutResult.ok) {
        clipWorker.state = 'idle';
        clipWorker.lastError = cutResult.error;
        // FFmpeg/buffer failure — the job is RETAINED (not discarded),
        // exactly like an upload failure: it just has no local file to
        // retry from since cutting itself never produced one. Reported
        // loudly so the operator sees WHY, not just "clip failed".
        updateJob(clipId, { status: 'FAILED_PERMANENT', error: cutResult.error });
        console.log(`[CLIP ERROR] clipId=${clipId} cutting failed: ${cutResult.error}`);
        return;
    }
    updateJob(clipId, { status: 'LOCAL_SAVED', localPath: cutResult.outFile });

    clipWorker.state = 'uploading';
    updateJob(clipId, { status: 'FORWARDING' });
    const forwardResult = await postFileToServer(mainServerUrl, matchId, eventType, timestamp, ballMeta, cutResult.outFile, clipId);
    clipWorker.state = 'idle';

    if (forwardResult.ok) {
        clipWorker.cloudflareConnected = true;
        // The file is NOT deleted here — server.js only deletes its OWN
        // Render-disk copy once R2 AND Drive both confirm; deleting our
        // local one immediately on a bare "forwarded" ack would violate
        // "never delete the local clip prematurely" the moment server.js
        // still needed a retry. It's cleaned up by the local retention
        // sweep once server.js reports COMPLETE (see pollRenderStatus /
        // the sweep further down).
        updateJob(clipId, { status: 'RETRY_PENDING' }); // becomes COMPLETE once polling confirms both uploads
        pollRenderStatus(job);
        return;
    }
    // Render unreachable right now — the clip is NOT deleted. Queue it
    // for retry with backoff instead (restart-safe: retryQueue is
    // persisted to retry-queue.local.json and resumed on boot).
    clipWorker.cloudflareConnected = false;
    clipWorker.lastError = forwardResult.error;
    updateJob(clipId, { status: 'RETRY_PENDING', error: forwardResult.error });
    const entry = { clipId, matchId, eventType, timestamp, ballMeta, filePath: cutResult.outFile, mainServerUrl, attempts: 0 };
    retryQueue.push(entry);
    persistRetryQueue();
    scheduleRetry(entry);
}

// 🔒 DUPLICATE EVENT/CLIP PREVENTION — clipId IS the dedupe key (it's
// deterministic from matchId+eventType+timestamp — see buildClipId).
// Two requests for the exact same event arriving back-to-back (a
// double click, a client-side retry racing the original) — even
// genuinely concurrently — resolve to the SAME job, never a second
// job/cut/upload.
//
// This is also THE acceptance point for "once accepted, never
// canceled": the instant a job is created here it lives in `clipJobs`
// independent of any socket/HTTP connection, page reload, or anything
// else happening in the panel — runClipJob() above is scheduled via a
// plain setTimeout keyed to T0, not to this request's lifetime.
function acceptClipEvent({ matchId, eventType, timestamp, ballMeta, mainServerUrl, clipId }) {
    clipId = clipId || buildClipId(matchId, eventType, timestamp);
    console.log(`[CLIP EVENT] clipId=${clipId} eventType=${eventType} matchId=${matchId} T0=${timestamp}`);

    const existing = clipJobs.get(clipId);
    if (existing) return { success: true, clipId, status: existing.status, duplicate: true };

    const rec = recordingMatches[matchId];
    const resolvedMainServerUrl = mainServerUrl || (rec && rec.mainServerUrl);
    if (!resolvedMainServerUrl) {
        return { success: false, error: 'No recording session for this match — start recording first' };
    }

    const job = {
        clipId, matchId, eventType, timestamp, ballMeta: ballMeta || null,
        mainServerUrl: resolvedMainServerUrl,
        status: 'WAITING_FOR_POSTROLL',
        createdAt: Date.now(), updatedAt: Date.now(),
        r2Status: 'pending', driveStatus: 'pending',
    };
    clipJobs.set(clipId, job);
    persistClipJobs();

    // T0 is captured ABOVE (timestamp, already frozen by the panel at
    // click time) — this wait is post-roll only; T0 itself is never
    // recalculated after it elapses.
    const waitMs = Math.max(0, (timestamp + CLIP_POST_ROLL_SEC * 1000) - Date.now());
    console.log(`[CLIP WAIT] clipId=${clipId} waiting ${waitMs}ms for post-roll`);
    setTimeout(() => runClipJob(clipId), waitMs);

    return { success: true, clipId, status: 'WAITING_FOR_POSTROLL' };
}

// ================================================================
// HTTP API — localhost only. The panel's origin is whatever page it's
// served from (Render), so CORS is opened for any origin but this
// server only ever binds to 127.0.0.1 (see app.listen below) — it is
// not reachable from outside the operator's own PC.
// ================================================================
const app = express();
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
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
        ffmpegAvailable: ffmpegAvailable(),
        ffmpegPath: FFMPEG_PATH,
        nvencAvailable: nvenc.available,
        nvencDetail: nvenc.detail,
        // Stream URL is not a secret (no credentials embedded in the
        // normal case) — safe to echo back in full, unlike the key.
        streamUrl: streamUrl || null,
        streamUrlSet: !!streamUrl && isValidRtmpUrl(streamUrl),
        streamKeySet: !!streamKey,
        streamKeyMasked: maskKey(streamKey),
        networkOk: network.available,
        networkDetail: network.detail,
        encoderState: engine.state,
        // Part 3 — clip engine / local buffer readiness, for the panel's
        // CLIP ENGINE status card.
        recordingActive: localBuffer.activeSessionCount() > 0,
        bufferSessions: localBuffer.activeSessionCount(),
        bufferSessionsDetail: localBuffer.sessionsSummary(),
        clipWorkerState: clipWorker.state,
        cloudflareConnected: clipWorker.cloudflareConnected,
        clipWorkerLastError: clipWorker.lastError,
        retryQueueLength: retryQueue.length,
    });
});

// ----------------------------------------------------------------
// 🎬 ClipperHelper.exe-COMPATIBLE ENDPOINTS (Part 3)
//
// cricket-panel.html's recordBall()/triggerWicketClip() code was built
// against ClipperHelper.exe's contract: /recording-start, /recording-
// stop, /clip. That JS is UNCHANGED (see Part 3 report) — only the URL
// it's pointed at changed, from ClipperHelper.exe (vMix-dependent) to
// here. Implementing the same contract is what let the existing
// clipping rules survive untouched.
// ----------------------------------------------------------------
app.post('/recording-start', (req, res) => {
    const matchId = localBuffer.safeMatchId(req.body && req.body.matchId);
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
    const mainServerUrl = (req.body && req.body.mainServerUrl) || null;
    const tournamentId = (req.body && req.body.tournamentId) || null;

    // attachRecording (not startSession) — reuses any buffer already
    // capturing this match's footage (e.g. streaming was already live
    // before Recording was clicked), preserving its real header/chunks
    // instead of replacing it with an empty one. See localBuffer.js.
    localBuffer.attachRecording(matchId, { tournamentId, mainServerUrl });
    recordingMatches[matchId] = { mainServerUrl, tournamentId };
    console.log(`🔴 [clip engine] Local buffer recording started for match ${matchId}`);
    // No vMix here — "vmixControlled" from the old ClipperHelper contract
    // doesn't apply; kept as false for any old UI text checking it.
    res.json({ success: true, vmixControlled: false });
});

app.post('/recording-stop', (req, res) => {
    const matchId = localBuffer.safeMatchId(req.body && req.body.matchId);
    const session = matchId ? localBuffer.stopSession(matchId) : null;
    // Keep the buffer on disk for a short grace period in case a clip
    // request for the last few seconds of the match is still in flight
    // (mirrors Part 1's RECORDING_CLEANUP_DELAY_MS reasoning), then
    // delete it — this runs on the operator's own laptop disk, so it
    // must not accumulate match after match.
    if (matchId) {
        setTimeout(() => localBuffer.deleteMatchMedia(matchId), 90 * 1000);
        delete recordingMatches[matchId];
    }
    res.json({ success: true, vmixControlled: false, hadSession: !!session });
});

// Legacy ClipperHelper contract also had /set-folder (it did its OWN
// Drive upload locally, so it needed the folder+token). This engine
// does NOT upload to Drive/R2 itself — it forwards the finished clip to
// server.js's existing /api/clips/ingest, which already knows the
// match's Drive folder (via /api/set-drive-folder[-oauth], unchanged).
// Kept as a harmless no-op so nothing breaks if older UI still calls it.
app.post('/set-folder', (req, res) => {
    res.json({ success: true, note: 'no-op — this engine forwards clips to server.js, which handles Drive/R2 folder routing itself' });
});

// The actual clip trigger — same payload shape recordBall()/
// triggerWicketClip() already send: {eventType, timestamp, matchId,
// ballMeta}, plus an optional clipId (the panel generates one at T0 so
// its own UI can start polling /clip-jobs/:clipId immediately, without
// waiting for this response).
//
// Responds the instant the event is ACCEPTED (job created, T0 frozen)
// — never waits for the post-roll or the cut/upload, which is what
// makes the exact 5-second wait possible without hanging this request.
app.post('/clip', (req, res) => {
    const { eventType, timestamp, matchId, ballMeta, clipId } = req.body || {};
    if (!matchId || !eventType || !timestamp) {
        return res.status(400).json({ success: false, error: 'matchId, eventType and timestamp are required' });
    }
    const result = acceptClipEvent({ matchId: localBuffer.safeMatchId(matchId), eventType, timestamp, ballMeta, clipId });
    if (!result.success) return res.status(409).json(result);
    res.json(result);
});

// 🎬 LIVE CLIP STATUS — polled by the panel to render the full per-clip
// progress UI (T0 captured -> waiting -> cutting -> local saved ->
// uploading -> R2 -> Drive -> complete), and by nothing else — this
// engine is the operator's single source of truth for "what's
// happening with my clips" (it also polls server.js in the background
// for the eventual R2/Drive outcome — see pollRenderStatus).
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
    // Never echo the real key back — only a masked confirmation. The
    // URL isn't a secret, so it's echoed back in full for the panel to
    // confirm what was saved.
    res.json({ success: true, streamUrl, streamKeyMasked: maskKey(streamKey) });
});

app.post('/go-live', (req, res) => {
    const { resolution, fps, bitrateKbps, keyframeIntervalSec } = req.body || {};
    const result = startEncoder({ resolution, fps, bitrateKbps, keyframeIntervalSec });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, state: engine.state });
});

// The SAME incoming bytes feed BOTH consumers below — one MediaRecorder
// capture in the browser, never two, never a second encoder process
// spun up to duplicate the work. matchId/index also lazily buffer this
// into the local buffer (Part 3's clip source) via ensureSession — done
// unconditionally (not gated behind /recording-start having been called
// yet) so the buffer's very first chunk (the WebM header every later
// chunk needs) is never missed, even if Live Studio streaming starts
// the shared capture before "Start Recording" is clicked. It stays
// bounded to RETENTION_SEC either way, and actually cutting/forwarding
// a clip still requires /recording-start's mainServerUrl (see /clip) —
// this only ensures the footage is THERE if that's requested later.
// Whether or not any of this is true, if the NVENC encoder is live it
// still gets the same bytes for YouTube (Part 2) — the two are
// independent and either can run without the other.
app.post('/ingest', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
    const matchId = localBuffer.safeMatchId(req.query.matchId);
    const index = parseInt(req.query.index, 10);

    if (matchId && Number.isFinite(index)) {
        localBuffer.ensureSession(matchId);
        localBuffer.addChunk(matchId, index, req.body);
    }

    const encResult = ingestChunk(req.body);
    // Only treat this as an error if the encoder was SUPPOSED to be live
    // and genuinely isn't — if the operator is just recording for clips
    // (no YouTube stream running), 'Encoder not live' is expected, not
    // a failure worth surfacing to the panel as a dropped chunk.
    if (!encResult.ok && engine.desiredLive) {
        return res.status(409).json({ success: false, error: encResult.error });
    }
    res.json({ success: true });
});

app.post('/stop', (req, res) => {
    const result = stopEncoder();
    res.json({ success: true, ...result });
});

// Best-effort GPU utilization via nvidia-smi — purely informational for
// the Stream Health panel. Not required for streaming to work; if
// nvidia-smi isn't found (or this isn't an NVIDIA machine) this just
// comes back null and the panel shows "—" instead of a number.
function readGpuUtilization() {
    try {
        const res = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu,utilization.memory', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2000 });
        if (res.error || !res.stdout) return null;
        const [gpuPct, memPct] = res.stdout.trim().split(',').map((s) => parseInt(s.trim(), 10));
        if (Number.isNaN(gpuPct)) return null;
        return { gpuPercent: gpuPct, gpuMemPercent: memPct };
    } catch (e) { return null; }
}

app.get('/health', (req, res) => {
    res.json({
        success: true,
        state: engine.state,
        desiredLive: engine.desiredLive,
        settings: engine.settings,
        metrics: engine.metrics,
        gpu: readGpuUtilization(),
        cpuPercent: readCpuUtilization(),
        durationSec: engine.startedAt && (engine.state === 'live' || engine.state === 'stopping')
            ? Math.round((Date.now() - engine.startedAt) / 1000)
            : (engine.metrics.outTimeSec || 0),
        lastError: engine.lastError,
        restartCount: engine.restarts.length,
        clipEngine: {
            recordingActive: localBuffer.activeSessionCount() > 0,
            clipWorkerState: clipWorker.state,
            cloudflareConnected: clipWorker.cloudflareConnected,
            lastError: clipWorker.lastError,
            retryQueueLength: retryQueue.length,
        },
    });
});

// 🛟 Orphaned match-buffer sweep — same reasoning as Part 1's
// sweepOrphanedRecordings on server.js, scoped to this engine's local
// buffer/ directory so a crashed process or a missed /recording-stop
// can't leave footage sitting on the operator's laptop disk forever.
const ORPHAN_BUFFER_MAX_AGE_MS = 12 * 60 * 60 * 1000;
setTimeout(() => localBuffer.sweepOrphaned(ORPHAN_BUFFER_MAX_AGE_MS), 60 * 1000);
setInterval(() => localBuffer.sweepOrphaned(ORPHAN_BUFFER_MAX_AGE_MS), 60 * 60 * 1000);

// 🛟 Safety-net clip-file sweep — see sweepOldClipFiles' own comment.
// A generous 24h default: this only ever catches a clip whose normal
// "delete once Render confirms COMPLETE" path (pollRenderStatus above)
// never got the chance to run — never the everyday cleanup mechanism.
const ORPHAN_CLIP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
setTimeout(() => localBuffer.sweepOldClipFiles(ORPHAN_CLIP_FILE_MAX_AGE_MS), 90 * 1000);
setInterval(() => localBuffer.sweepOldClipFiles(ORPHAN_CLIP_FILE_MAX_AGE_MS), 60 * 60 * 1000);

const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`🎥 AllSportsLive Stream Engine running at http://127.0.0.1:${PORT} (localhost only)`);
    console.log(`   ffmpeg: ${FFMPEG_PATH}${process.env.FFMPEG_PATH ? ' (from FFMPEG_PATH)' : ' (from PATH — set FFMPEG_PATH to point at an NVENC-capable build if this is not one)'}`);
    const nvenc = checkNvenc();
    console.log(`   NVENC: ${nvenc.available ? '✅ available' : '❌ NOT available — ' + nvenc.detail}`);
});

process.on('uncaughtException', (err) => {
    // The engine's whole job is to keep streaming even when ffmpeg has
    // problems — an uncaught exception here must not kill this process
    // out from under a live broadcast. Log and keep running.
    console.log('[stream-engine] uncaughtException (kept running):', err);
});

// ----------------------------------------------------------------
// 🛑 GRACEFUL SHUTDOWN — never leave an orphaned ffmpeg process behind
// (encoder OR a clip-cut in flight) when this engine is stopped/
// restarted, e.g. by the operator, a crash-recovery script, or the OS.
// ----------------------------------------------------------------
let shuttingDown = false;
function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[stream-engine] ${signal} received — shutting down gracefully`);
    engine.desiredLive = false; // don't let the exit handler try to auto-restart
    if (engine.proc) {
        try { engine.proc.stdin.end(); } catch (e) { /* already closed */ }
        setTimeout(() => { try { engine.proc && engine.proc.kill('SIGKILL'); } catch (e) {} }, 3000);
    }
    server.close(() => {
        console.log('[stream-engine] HTTP server closed, exiting');
        process.exit(0);
    });
    // Don't hang forever waiting for connections to drain.
    setTimeout(() => process.exit(0), 5000);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
