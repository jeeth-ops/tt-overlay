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
//                   -> reconnecting -> (backoff retry) -> starting   [network blip — see ABR section below]
//                   -> crashed -> (bounded auto-restart) -> starting  [fatal/config error, not network]
// ----------------------------------------------------------------
const MAX_AUTO_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
// Capped exponential backoff for NETWORK-flavored disconnects specifically
// (see isFatalError below) — unlike MAX_AUTO_RESTARTS above, this never
// gives up on its own: an operator's internet flapping for a while is
// exactly the case Part 2 exists to survive, so retries continue for as
// long as the operator wants to be live (only an explicit Stop ends it).
const RECONNECT_BACKOFF_MS = [2000, 4000, 8000, 15000];

const engine = {
    state: 'idle',           // idle | starting | live | reconnecting | stopping | crashed
    proc: null,              // the ffmpeg child process
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
    metrics: { bitrateKbps: null, fps: null, droppedFrames: null, totalFrames: null, outTimeSec: null },
};

function resetMetrics() {
    engine.metrics = { bitrateKbps: null, fps: null, droppedFrames: null, totalFrames: null, outTimeSec: null };
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
    } else if (key === 'frame') {
        const num = parseInt(value, 10);
        if (!Number.isNaN(num)) engine.metrics.totalFrames = num;
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

// ================================================================
// 🎞️ LOCAL FULL-MATCH MASTER RECORDING — separate from both the live
// YouTube push (Part 2) and the short rolling clip buffer (Part 3,
// localBuffer.js). This is the actual "the whole match, saved on this
// laptop as a real MP4" deliverable: continuously fed the SAME final
// camera+overlay program bytes every other consumer gets (see /ingest),
// muxed the entire time the operator has Recording running, completely
// independent of the live stream's network/bitrate — a bad connection
// degrades the LIVE STREAM only; this keeps recording at its own fixed
// quality regardless. Lives under its own directory, well outside
// localBuffer's per-match buffer/ folder (which IS deleted ~90s after
// Recording stops) — this must never be touched by that cleanup.
// ================================================================
const RECORDING_ROOT = path.join(__dirname, 'StreamEngineData', 'Recordings');
try { fs.mkdirSync(RECORDING_ROOT, { recursive: true }); } catch (e) { /* created lazily per-match anyway */ }
// Deliberately independent of the live-stream ABR ladder (stream-engine's
// adaptive bitrate section, further below) — this is a fixed local
// recording quality, never adapted to network conditions.
const RECORDING_BITRATE_KBPS = { '480p': 2500, '720p': 5000, '1080p': 8000 };

function recorderDir(matchId) {
    return path.join(RECORDING_ROOT, localBuffer.safeMatchId(matchId));
}

const recorder = {
    state: 'idle',            // idle | starting | recording | stopping | crashed
    proc: null,
    matchId: null,
    desiredRecording: false,
    startedAt: null,          // when the CURRENT segment started (not the whole match, if it had to restart)
    segmentIndex: 0,
    segmentPath: null,
    segments: [],             // [{path, startedAt}] — normally just one; more than one only if a crash forced a new file (see below)
    settings: null,           // {resolution, width, height, fps, bitrateKbps}
    restarts: [],
    lastError: null,
    priming: false,           // true while this segment's header chunk is being piped in — see startRecorder
    pendingChunks: [],        // live chunks queued during priming so they land AFTER the header, never interleaved before it
};

function buildRecorderArgs({ width, height, fps, bitrateKbps, outFile }) {
    return [
        '-hide_banner', '-loglevel', 'warning',
        '-i', 'pipe:0',
        // Deliberately libx264 (CPU), not NVENC: this runs ALONGSIDE the
        // live push's own NVENC session, and consumer GPUs commonly cap
        // concurrent NVENC sessions at 1-3 — recording isn't
        // latency-sensitive, so a CPU encode here never competes with
        // the live stream's hardware encoder for that limited resource.
        '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${bitrateKbps}k`,
        '-vf', `scale=${width}:${height}`, '-r', String(fps),
        // A short (2s) GOP — same convention as the live encoder above —
        // is what actually makes the crash-safety below real: fragments
        // close (and flush to disk) on every keyframe, so at most ~2s of
        // footage is ever at risk if the process is killed. libx264's own
        // default keyint (250 frames, ~8s at 30fps) would leave a much
        // bigger unflushed/unplayable window mid-recording.
        '-g', String(fps * 2), '-keyint_min', String(fps * 2),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
        // Fragmented MP4: writes a valid, playable file incrementally as
        // it records (a moof+mdat per GOP) instead of one index (moov)
        // written only at a clean close — so a laptop crash, a killed
        // process, or an abrupt Stream Engine stop leaves a real,
        // playable MP4 up to the last flushed fragment, never a
        // zero-byte or "moov atom not found" unplayable file.
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-flush_packets', '1',
        '-f', 'mp4',
        outFile,
    ];
}

function startRecorder(matchId, { resolution, fps } = {}) {
    if (recorder.state === 'recording' || recorder.state === 'starting') {
        if (recorder.matchId === matchId) return { ok: true, alreadyRecording: true };
        return { ok: false, error: `Already recording match "${recorder.matchId}" — stop that first` };
    }
    const resKey = RESOLUTIONS[resolution] ? resolution : '1080p';
    const fpsNum = [30, 60].includes(Number(fps)) ? Number(fps) : 30;
    const { width, height } = RESOLUTIONS[resKey];
    const bitrateKbps = RECORDING_BITRATE_KBPS[resKey];

    const dir = recorderDir(matchId);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: `Could not create recording folder: ${e.message}` }; }

    recorder.matchId = matchId;
    recorder.desiredRecording = true;
    recorder.settings = { resolution: resKey, width, height, fps: fpsNum, bitrateKbps };
    recorder.segmentIndex += recorder.segments.length ? 1 : 0;
    const fileName = recorder.segments.length === 0 ? 'master.mp4' : `master_part${recorder.segments.length + 1}.mp4`;
    const outFile = path.join(dir, fileName);
    recorder.segmentPath = outFile;
    recorder.state = 'starting';
    recorder.startedAt = Date.now();
    recorder.lastError = null;

    const args = buildRecorderArgs({ width, height, fps: fpsNum, bitrateKbps, outFile });
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    recorder.proc = proc;
    recorder.state = 'recording';
    recorder.segments.push({ path: outFile, startedAt: recorder.startedAt });

    // Prime this BRAND NEW ffmpeg process with the session's header
    // chunk before any live /ingest bytes reach it — a fresh process
    // reading from pipe:0 needs the EBML/Segment/Tracks header to
    // decode anything at all; without this, a recording started after
    // the capture already began (or restarted after a crash) would
    // receive only bare Clusters and produce an empty/broken file. Live
    // chunks arriving during this async write are queued, never
    // interleaved before the header.
    recorder.priming = true;
    recorder.pendingChunks = [];
    const headerFile = localBuffer.getHeaderChunkFile(matchId);
    const flushPending = () => {
        recorder.priming = false;
        const pending = recorder.pendingChunks;
        recorder.pendingChunks = [];
        for (const buf of pending) {
            try { if (proc.stdin.writable) proc.stdin.write(buf); } catch (e) { /* proc likely already gone */ }
        }
    };
    if (headerFile) {
        const hs = fs.createReadStream(headerFile);
        hs.on('error', flushPending); // missing header is unusual but not fatal — just start from live chunks
        hs.pipe(proc.stdin, { end: false });
        hs.on('close', flushPending);
    } else {
        flushPending();
    }

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        let idx;
        while ((idx = stderrBuf.indexOf('\n')) >= 0) {
            const line = stderrBuf.slice(0, idx);
            stderrBuf = stderrBuf.slice(idx + 1);
            if (/error|failed|invalid/i.test(line)) recorder.lastError = line.trim();
        }
    });

    proc.on('exit', (code, signal) => {
        const wasDesired = recorder.desiredRecording;
        console.log(`[stream-engine] recorder ffmpeg exited (code=${code}, signal=${signal}); desiredRecording=${wasDesired}`);
        recorder.proc = null;
        if (!wasDesired) { recorder.state = 'idle'; return; }

        // Unexpected exit while the operator still wants to be
        // recording — never silently stop capturing the match. Start a
        // NEW segment file (fragmented MP4 can't simply be appended to
        // after the process that owns it exits) rather than giving up;
        // every segment individually stays under RECORDING_ROOT and
        // stays playable on its own.
        recorder.state = 'crashed';
        recorder.lastError = recorder.lastError || `recorder ffmpeg exited unexpectedly (code=${code}, signal=${signal})`;
        const now = Date.now();
        recorder.restarts = recorder.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
        if (recorder.restarts.length >= MAX_AUTO_RESTARTS) {
            console.log('[stream-engine] recorder: max auto-restarts hit — local recording stopped, operator must press Start Recording again');
            recorder.desiredRecording = false;
            return;
        }
        recorder.restarts.push(now);
        console.log(`[stream-engine] recorder: auto-restarting into a new segment (attempt ${recorder.restarts.length}/${MAX_AUTO_RESTARTS})…`);
        setTimeout(() => {
            if (recorder.desiredRecording) startRecorder(recorder.matchId, { resolution: recorder.settings.resolution, fps: recorder.settings.fps });
        }, 1000);
    });

    proc.on('error', (err) => {
        console.log('[stream-engine] recorder ffmpeg spawn error:', err.message);
        recorder.lastError = err.message;
        recorder.state = 'crashed';
    });

    return { ok: true };
}

function stopRecorder() {
    recorder.desiredRecording = false;
    if (!recorder.proc) { recorder.state = 'idle'; return { ok: true, alreadyIdle: true }; }
    recorder.state = 'stopping';
    // End stdin (not SIGKILL) so ffmpeg flushes its last fragment and
    // closes the MP4 cleanly — never chop off the last few seconds.
    try { recorder.proc.stdin.end(); } catch (e) { /* already closed */ }
    const proc = recorder.proc;
    setTimeout(() => { if (recorder.proc === proc) { try { proc.kill('SIGKILL'); } catch (e) {} } }, 5000);
    return { ok: true };
}

function resetRecorderForNewMatch() {
    recorder.segments = [];
    recorder.segmentIndex = 0;
    recorder.restarts = [];
}

// Never drop frames from the master recording the way the live push
// (deliberately) drops under backpressure — losing a moment from the
// permanent match record is worse than a brief memory bump while a CPU
// encode catches up. Node's stream internally buffers when write()
// returns false; this just tracks how long that's been true so an
// operator can see a real, sustained problem instead of one silently
// growing forever.
let recorderBackpressureSince = null;
function recorderIngestChunk(buf) {
    if (recorder.state !== 'recording' || !recorder.proc || !recorder.proc.stdin.writable) return;
    if (recorder.priming) { recorder.pendingChunks.push(buf); return; } // hold until the header chunk (see startRecorder) has been written first
    try {
        const stillOk = recorder.proc.stdin.write(buf);
        if (!stillOk && !recorderBackpressureSince) {
            recorderBackpressureSince = Date.now();
            recorder.proc.stdin.once('drain', () => { recorderBackpressureSince = null; });
        }
    } catch (e) { recorder.lastError = e.message; }
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

// ================================================================
// 📶 ADAPTIVE BITRATE (ABR) — keeps the operator's SELECTED resolution
// live through a fluctuating/unstable connection instead of disconnecting.
// All numbers below are runtime-configurable (POST /adaptive-config)
// specifically so a different streaming provider's own limits don't
// require editing this file. See stream-engine/README.md for the
// intended behavior this implements.
//
// Mechanism: ffmpeg's CLI doesn't expose changing NVENC's target bitrate
// on a running process, so "adaptive bitrate" here means a fast, rate
// limited hot-restart (stop this ffmpeg, immediately start a new one with
// the new -b:v/resolution/fps) — the SAME technique the panel's manual
// "Lower Quality Now" button uses. The browser capture (MediaRecorder →
// /ingest) never stops or reopens the camera for this — see /ingest and
// localBuffer.js — so it's a ~1-2s hiccup in the OUTPUT push, not a
// dropped stream, and local recording/clips are entirely unaffected.
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
    safetyFactor: 0.75,      // never target the full detected/sustained throughput — keep headroom for jitter (spec section 9)
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

// Classifies current network health from signals we can actually observe
// from a local ffmpeg subprocess: whether Node's write() into ffmpeg's
// stdin is backpressured (ffmpeg isn't reading fast enough — it can't,
// because its RTMP write to the network is itself blocked/slow, which is
// the actual "network can't keep up" signal here), how far the achieved
// output bitrate is below target, and how many frames ffmpeg itself had
// to drop. No dedicated bandwidth probe exists — uploadEstimateKbps is a
// DERIVED figure (see below), not a measured one.
let lastDroppedFramesSample = null;
let lastTotalFramesSample = null;
let backpressureSince = null;
function sampleNetworkHealth() {
    const target = engine.settings ? engine.settings.bitrateKbps : null;
    const actual = engine.metrics.bitrateKbps;
    const ratio = (target && actual != null) ? actual / target : 1;

    if (encoderBackpressured) {
        if (!backpressureSince) backpressureSince = Date.now();
    } else {
        backpressureSince = null;
    }
    const backpressuredMs = backpressureSince ? Date.now() - backpressureSince : 0;

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
    if (backpressuredMs > 3000 || ratio < 0.4 || droppedDeltaPct > 5) severity = 'severe';
    else if (backpressuredMs > 0 || ratio < 0.8 || droppedDeltaPct > 1) severity = 'mild';

    // If we're cleanly sustaining `actual` kbps while only using
    // `safetyFactor` of the real pipe (by design), the implied ceiling is
    // actual/safetyFactor. Only meaningful once the signal is clean.
    const uploadEstimateKbps = actual != null ? Math.round(actual / abr.safetyFactor) : null;

    return { severity, ratio, droppedDeltaPct, backpressuredMs, uploadEstimateKbps };
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

    stopEncoder();
    const waitStart = Date.now();
    while (engine.state !== 'idle' && Date.now() - waitStart < 6500) {
        await new Promise((r) => setTimeout(r, 150));
    }

    if (engine.opToken !== myToken) { engine.adapting = false; return; } // operator acted while we were restarting — defer to them

    engine.desiredLive = true; // stopEncoder() cleared this — this restart is US, not the operator stopping
    const result = startEncoder({ resolution: next.resolution, fps: next.fps, bitrateKbps: next.bitrateKbps, keyframeIntervalSec });
    if (result.ok) {
        engine.rung = next.rung;
    } else {
        console.log('[stream-engine] ABR restart failed:', result.error);
    }
    engine.adapting = false;
}

// The ABR control loop — ticks every ABR_TICK_MS while live. Priority
// order (spec section 10): keep the connection alive > keep the selected
// resolution > reduce bitrate > reduce fps (emergency) > resolution
// fallback (only if enabled and genuinely necessary). Decreases react
// fast (no hold needed once truly "severe"); increases require a
// sustained clean signal (holdStableUpSec) so the stream doesn't
// oscillate on every brief improvement.
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

// Fatal/config errors (bad args, no NVENC, missing filter) should NOT
// retry forever — those need the operator to fix something. Everything
// else observed on an unexpected ffmpeg exit is treated as a network
// blip and gets the unlimited-backoff reconnect loop below, because a
// live sports stream should never just give up over a few dropped
// packets or a brief internet outage.
const FATAL_ERROR_PATTERN = /unrecognized option|no such filter|cannot find a matching stream|invalid argument|no nvenc capable devices|unable to open|permission denied|no such file|unknown encoder/i;
function isFatalError(message) {
    return !!message && FATAL_ERROR_PATTERN.test(message);
}

// Network-flavored disconnect: keep retrying at capped exponential
// backoff for as long as the operator wants to be live (engine.desiredLive)
// — never gives up on its own. Local recording/clips are untouched by any
// of this (see /ingest — localBuffer gets every chunk regardless of
// engine.state).
function scheduleReconnect() {
    engine.state = 'reconnecting';
    engine.network.state = 'reconnecting';
    const backoff = RECONNECT_BACKOFF_MS[Math.min(engine.reconnect.attempts, RECONNECT_BACKOFF_MS.length - 1)];
    engine.reconnect.attempts += 1;
    engine.reconnect.nextAttemptAt = Date.now() + backoff;
    console.log(`[stream-engine] Network disconnect (${engine.lastError}) — reconnecting in ${backoff}ms (attempt ${engine.reconnect.attempts})…`);
    setTimeout(() => {
        if (!engine.desiredLive) return; // operator pressed Stop while we were waiting to retry
        const result = startEncoder(engine.settings);
        if (!result.ok) {
            engine.lastError = result.error;
            scheduleReconnect();
        }
    }, backoff);
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

    // Once this process has survived a few seconds without exiting, treat
    // the connection as genuinely re-established and reset the reconnect
    // attempt counter — otherwise a stream that's been flapping for an
    // hour would keep reporting attempt #40 forever even after it's fine.
    const stabilizeTimer = setTimeout(() => {
        if (engine.proc === proc) engine.reconnect.attempts = 0;
    }, 5000);

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
        clearTimeout(stabilizeTimer);
        const wasDesired = engine.desiredLive;
        console.log(`[stream-engine] ffmpeg exited (code=${code}, signal=${signal}); desiredLive=${wasDesired}`);
        engine.proc = null;

        if (!wasDesired) {
            // Operator pressed STOP (or this is our own ABR hot-restart
            // stopping the old process on purpose) — the expected, graceful path.
            engine.state = 'idle';
            return;
        }

        const errMsg = engine.lastError || `ffmpeg exited unexpectedly (code=${code}, signal=${signal})`;
        engine.lastError = errMsg;

        if (isFatalError(errMsg)) {
            // A config/hardware problem, not the network — retrying
            // forever won't fix it, so this keeps the original bounded
            // auto-restart safety net and eventually surfaces 'crashed'
            // for the operator to act on.
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
            setTimeout(() => {
                if (engine.desiredLive) startEncoder(engine.settings);
            }, Math.min(2000 * attempt, 8000));
            return;
        }

        // Everything else (connection reset, broken pipe, timeout, i/o
        // error, etc.) is treated as the internet going up and down —
        // never let a live sports stream just give up over this. Local
        // recording keeps running throughout (see /ingest).
        scheduleReconnect();
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
    // Deterministic, clipId-based filename (not Date.now()-based) — a
    // job re-run for the exact same event never leaves multiple .mp4s
    // behind, and this is the SAME name server.js's R2 key/Drive
    // filename are derived from (see buildClipId there), so the whole
    // pipeline refers to one clip by one identity end to end.
    const outFile = path.join(dirs.clipsDir, `${clipId}.mp4`);

    console.log(`[CLIP RANGE] clipId=${clipId} start=T0-${CLIP_PRE_ROLL_SEC}s end=T0+${CLIP_POST_ROLL_SEC}s`);

    // Pin every chunk this cut needs BEFORE starting to read any of
    // them, and hold the pin for the whole cut (finally, below) — a cut
    // isn't instant (ffmpeg spawn + piping several chunks can take a
    // few seconds), and without this, one of these exact chunks could
    // age past RETENTION_SEC and get deleted by pruneOldChunks (still
    // running on every /ingest of a NEW chunk in parallel) partway
    // through — an ENOENT reading a chunk file that existed when the
    // clip started. See pinChunksByIndex/pruneOldChunks in localBuffer.js.
    const stitchIndices = toStitch.map((c) => c.index);
    localBuffer.pinChunksByIndex(matchId, stitchIndices);
    try {
        await cutFromStitchedChunks({ toStitch, trimStartSec, outFile });
    } finally {
        localBuffer.unpinChunksByIndex(matchId, stitchIndices);
    }

    console.log(`[CLIP CREATED] clipId=${clipId} localPath=${outFile}`);
    return { ok: true, outFile };
}

async function cutFromStitchedChunks({ toStitch, trimStartSec, outFile }) {

    // Feed the covering chunks straight into ffmpeg's stdin as one
    // continuous byte stream, and seek AFTER -i (decode-order, not an
    // index/Cues seek) rather than writing an intermediate "stitched"
    // file to disk and reopening it with -ss BEFORE -i. The previous
    // approach relied on ffmpeg's Matroska seek index on a file that was
    // never a real single recording (just independent MediaRecorder
    // blobs concatenated after the fact) — on some encode paths
    // (confirmed with an H.264-in-WebM capture-card feed) that index is
    // unreliable and pre-seeking into it corrupts the output ("Invalid
    // data found when processing input" / garbled video). Piping bytes
    // and seeking by decoding forward from the start avoids trusting
    // that index at all — this is the exact same "continuous pipe
    // decode" mechanism already proven reliable for the live NVENC push
    // (see ingestChunk/buildFfmpegArgs above), just applied to clip
    // cutting instead of a live RTMP push.
    await new Promise((resolve, reject) => {
        const args = [
            '-hide_banner', '-loglevel', 'warning', '-y',
            '-i', 'pipe:0',
            '-ss', String(trimStartSec), '-t', String(CLIP_PRE_ROLL_SEC + CLIP_POST_ROLL_SEC),
            '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'veryfast',
            outFile,
        ];
        const proc = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg trim exited ${code}: ${stderr.slice(-500)}`)));
        proc.on('error', reject);

        (async () => {
            for (const c of toStitch) {
                await new Promise((res2, rej2) => {
                    const rs = fs.createReadStream(c.file);
                    rs.on('error', rej2);
                    rs.on('end', res2);
                    rs.pipe(proc.stdin, { end: false });
                });
            }
            proc.stdin.end();
        })().catch(reject);
    });
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
        // Local full-match master recording — see the LOCAL FULL-MATCH
        // MASTER RECORDING section above. Independent of streaming.
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
            restartCount: recorder.restarts.length,
        },
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
    const resolution = (req.body && req.body.recordingResolution) || '1080p';
    const fps = (req.body && req.body.recordingFps) || 30;

    // attachRecording (not startSession) — reuses any buffer already
    // capturing this match's footage (e.g. streaming was already live
    // before Recording was clicked), preserving its real header/chunks
    // instead of replacing it with an empty one. See localBuffer.js.
    localBuffer.attachRecording(matchId, { tournamentId, mainServerUrl });
    recordingMatches[matchId] = { mainServerUrl, tournamentId };
    console.log(`🔴 [clip engine] Local buffer recording started for match ${matchId}`);

    if (recorder.matchId !== matchId) resetRecorderForNewMatch();
    const recResult = startRecorder(matchId, { resolution, fps });
    if (!recResult.ok) {
        console.log(`⚠️  [master recording] could not start local master recording for ${matchId}: ${recResult.error}`);
    }

    // No vMix here — "vmixControlled" from the old ClipperHelper contract
    // doesn't apply; kept as false for any old UI text checking it.
    res.json({ success: true, vmixControlled: false, masterRecording: recResult.ok ? { ok: true, path: recorder.segmentPath } : { ok: false, error: recResult.error } });
});

app.post('/recording-stop', (req, res) => {
    const matchId = localBuffer.safeMatchId(req.body && req.body.matchId);
    const session = matchId ? localBuffer.stopSession(matchId) : null;
    // Keep the buffer on disk for a short grace period in case a clip
    // request for the last few seconds of the match is still in flight
    // (mirrors Part 1's RECORDING_CLEANUP_DELAY_MS reasoning), then
    // delete it — this runs on the operator's own laptop disk, so it
    // must not accumulate match after match. This ONLY deletes the
    // short-lived clip buffer (buffer/matches/<id>/) — the persistent
    // master.mp4 recording lives entirely outside that folder (see
    // RECORDING_ROOT) and is never touched by this cleanup.
    if (matchId) {
        setTimeout(() => localBuffer.deleteMatchMedia(matchId), 90 * 1000);
        delete recordingMatches[matchId];
    }
    if (matchId && recorder.matchId === matchId) stopRecorder();
    res.json({ success: true, vmixControlled: false, hadSession: !!session });
});

// Serves the operator the folder path (not the file contents — these
// can be multi-GB) so a panel button can show/copy it for "Open
// Recording Folder" without this engine needing a native file-manager
// integration.
app.get('/recording-info', (req, res) => {
    const matchId = localBuffer.safeMatchId(req.query.matchId);
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
    const { resolution, fps, bitrateKbps, keyframeIntervalSec, qualityMode, autoResolutionFallback } = req.body || {};
    engine.opToken++; // a fresh operator-initiated Go Live always wins over any stale in-flight ABR restart

    const resKey = RESOLUTIONS[resolution] ? resolution : '1080p';
    const fpsNum = [30, 60].includes(Number(fps)) ? Number(fps) : 30;
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

    const result = startEncoder({ resolution: resKey, fps: fpsNum, bitrateKbps: startBitrateKbps, keyframeIntervalSec });
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

    // Third independent fan-out of the SAME bytes (one capture, three
    // consumers — see the LOCAL FULL-MATCH MASTER RECORDING section
    // above): the continuous local master.mp4. Never gated on the live
    // push's state — a dead/reconnecting YouTube stream must not affect
    // this at all.
    recorderIngestChunk(req.body);

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

// 📶 ABR control loop — see the ABR section above buildFfmpegArgs/startEncoder
// for the full mechanism. No-ops instantly whenever the encoder isn't live.
const ABR_TICK_MS = 2000;
setInterval(abrTick, ABR_TICK_MS);

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
