// ================================================================
// 🎥 AllSportsLive Stream Engine — LOCAL companion service (Part 2)
//
// Runs on the OPERATOR'S OWN PC, next to the Cricket Panel browser tab.
// NEVER deployed to Render. Its one job: take the locally-composited
// "Camera + Cricket Overlay" video the panel is already capturing,
// encode it with the GPU (NVENC) and push it to YouTube over RTMPS.
//
//     Camera + Audio (browser) → THIS PROCESS (localhost) →
//     NVIDIA NVENC → YouTube RTMPS
//
// Render/server.js is never in this path — see PART2_REPORT.md for the
// exact data/video flow. This file only talks to:
//   - the Cricket Panel, over localhost HTTP (ingest video, report health)
//   - a local ffmpeg binary (spawned as a child process)
//   - YouTube's RTMPS ingest endpoint (outbound only, from ffmpeg)
// It never talks to Render, MongoDB, or Socket.IO.
// ================================================================
const express = require('express');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// Stream key lives ONLY here: in-memory + this local gitignored file.
// It is never returned in full by any endpoint (see /status below) and
// never passes through server.js/Render/Mongo/Socket.IO/localStorage —
// the panel POSTs it straight to this localhost process.
let streamKey = loadConfig().streamKey || null;

function maskKey(key) {
    if (!key) return null;
    if (key.length <= 4) return '••••';
    return '••••••••' + key.slice(-4);
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

function buildFfmpegArgs({ resolution, fps, bitrateKbps, streamKey }) {
    const [w, h] = (resolution || '1920x1080').split('x').map(Number);
    const gop = Math.round((fps || 30) * 2); // 2-second keyframe interval
    return [
        '-hide_banner', '-loglevel', 'warning',
        '-i', 'pipe:0',
        '-c:v', 'h264_nvenc',
        '-preset', 'p4',
        '-rc', 'cbr',
        '-b:v', `${bitrateKbps || 10000}k`,
        '-maxrate', `${bitrateKbps || 10000}k`,
        '-bufsize', `${(bitrateKbps || 10000) * 2}k`,
        '-g', String(gop),
        '-keyint_min', String(gop),
        '-vf', `scale=${w}:${h}`,
        '-r', String(fps || 30),
        '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
        '-f', 'flv',
        '-progress', 'pipe:2', '-nostats',
        `rtmps://a.rtmps.youtube.com/live2/${streamKey}`,
    ];
}

function startEncoder({ resolution, fps, bitrateKbps }) {
    if (engine.state === 'live' || engine.state === 'starting') {
        return { ok: false, error: 'Already live — stop the current stream first' };
    }
    if (!streamKey) return { ok: false, error: 'No YouTube stream key set' };
    const nvenc = checkNvenc();
    if (!nvenc.available) {
        return { ok: false, error: `NVENC not available (${nvenc.detail}) — refusing to fall back to CPU encoding` };
    }

    resetMetrics();
    engine.settings = { resolution: resolution || '1920x1080', fps: fps || 30, bitrateKbps: bitrateKbps || 10000 };
    engine.state = 'starting';
    engine.desiredLive = true;
    engine.lastError = null;

    const args = buildFfmpegArgs({ ...engine.settings, streamKey });
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

function ingestChunk(buf) {
    if (engine.state !== 'live' || !engine.proc || !engine.proc.stdin.writable) return { ok: false, error: 'Encoder not live' };
    try {
        engine.proc.stdin.write(buf);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
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

app.get('/status', (req, res) => {
    const nvenc = checkNvenc();
    res.json({
        success: true,
        ffmpegAvailable: ffmpegAvailable(),
        ffmpegPath: FFMPEG_PATH,
        nvencAvailable: nvenc.available,
        nvencDetail: nvenc.detail,
        streamKeySet: !!streamKey,
        streamKeyMasked: maskKey(streamKey),
        encoderState: engine.state,
    });
});

app.post('/set-stream-key', (req, res) => {
    const key = (req.body && req.body.streamKey || '').trim();
    if (!key) return res.status(400).json({ success: false, error: 'streamKey required' });
    streamKey = key;
    saveConfig({ ...loadConfig(), streamKey: key });
    // Never echo the real key back — only a masked confirmation.
    res.json({ success: true, streamKeyMasked: maskKey(streamKey) });
});

app.post('/go-live', (req, res) => {
    const { resolution, fps, bitrateKbps } = req.body || {};
    const result = startEncoder({ resolution, fps, bitrateKbps });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, state: engine.state });
});

app.post('/ingest', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
    const result = ingestChunk(req.body);
    if (!result.ok) return res.status(409).json({ success: false, error: result.error });
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
        durationSec: engine.startedAt && (engine.state === 'live' || engine.state === 'stopping')
            ? Math.round((Date.now() - engine.startedAt) / 1000)
            : (engine.metrics.outTimeSec || 0),
        lastError: engine.lastError,
        restartCount: engine.restarts.length,
    });
});

app.listen(PORT, '127.0.0.1', () => {
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
