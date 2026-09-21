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
        const res = spawnSync(FFMPEG_PATH, [
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
        const res = spawnSync(FFMPEG_PATH, [
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
        const res = spawnSync(FFMPEG_PATH, [
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
        const res = spawnSync(FFMPEG_PATH, [
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
        const res = spawnSync(FFMPEG_PATH, [
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

function ffmpegAvailable() {
    const res = spawnSync(FFMPEG_PATH, ['-version'], { encoding: 'utf8', timeout: 5000 });
    return !res.error;
}

// ----------------------------------------------------------------
// 🎙️ NATIVE AUDIO DEVICE ENUMERATION — replaces the browser's own
// navigator.mediaDevices.enumerateDevices()/getUserMedia() for
// PRODUCTION audio: ffmpeg's dshow demuxer lists Windows audio capture
// devices the exact same way `ffmpeg -list_devices true -f dshow -i
// dummy` does from the command line (device names appear in quotes in
// stderr, sectioned under "DirectShow audio devices"). The panel calls
// GET /audio-devices to populate its microphone dropdown from this list
// instead of a browser permission prompt — the browser no longer needs
// microphone access for the production audio pipeline at all.
// ----------------------------------------------------------------
let audioDeviceCache = null; // { devices, checkedAt } — only ever set on a SUCCESSFUL (non-empty) listing, see below
function listAudioDevices() {
    if (!NATIVE_CAPTURE_SUPPORTED) return { devices: [], detail: `Native audio device listing needs Windows (dshow) — this process is running on ${process.platform}` };
    if (audioDeviceCache && Date.now() - audioDeviceCache.checkedAt < 15000) return { devices: audioDeviceCache.devices, detail: null };
    try {
        // 🩹 Confirmed on real hardware: a machine with several virtual
        // audio devices installed (e.g. vMix's own virtual audio driver
        // — "vMix Audio - Bus C/D/E/F/G", "16Ch", etc. alongside a real
        // mic) can take noticeably longer than a bare machine to enumerate
        // every DirectShow device. The previous 8s timeout could cut
        // ffmpeg off mid-enumeration, silently returning zero devices
        // even though real ones exist — 20s gives real-world device
        // counts like this real headroom.
        const res = spawnSync(FFMPEG_PATH, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8', timeout: 20000 });
        const out = (res.stdout || '') + (res.stderr || '');
        const devices = [];
        // 🩹 ffmpeg changed this output format across versions — confirmed
        // on real hardware running ffmpeg 9.0.1: there is no longer a
        // "DirectShow audio devices" section header line at all; instead
        // every device line ends with an inline "(audio)" or "(video)"
        // tag, e.g. [in#0 @ ...] "Microphone (AVMATRIX USB Capture Audio)"
        // (audio). The OLD section-header format (ffmpeg <9: a
        // "DirectShow audio devices" heading, then bare quoted names
        // underneath, no inline tag) still exists on older builds. Try
        // the new inline-tag format FIRST since it's unambiguous
        // per-line; only fall back to the old section-based parsing if
        // that finds nothing, so both ffmpeg generations work.
        for (const line of out.split('\n')) {
            const inlineMatch = /"([^"]+)"\s*\(audio\)/i.exec(line);
            if (inlineMatch) devices.push(inlineMatch[1]);
        }
        if (!devices.length) {
            let inAudioSection = false;
            for (const line of out.split('\n')) {
                if (/DirectShow audio devices/i.test(line)) { inAudioSection = true; continue; }
                if (/DirectShow video devices/i.test(line)) { inAudioSection = false; continue; }
                if (inAudioSection) {
                    const m = /"([^"]+)"/.exec(line);
                    if (m) devices.push(m[1]);
                }
            }
        }
        // Never cache an empty result — a timeout, a transient driver
        // hiccup, or ffmpeg being killed mid-enumeration would otherwise
        // "lock in" a false negative for 15s, so a real device is missed
        // even if the operator immediately clicks Refresh again.
        if (devices.length) audioDeviceCache = { devices, checkedAt: Date.now() };
        if (!devices.length && res.error) {
            return { devices: [], detail: `Device enumeration didn't finish in time (${res.error.code === 'ETIMEDOUT' ? 'timed out' : res.error.message}) — click Refresh Device List to try again` };
        }
        return { devices, detail: devices.length ? null : 'ffmpeg ran but reported no DirectShow audio devices — check Windows sound settings' };
    } catch (e) {
        return { devices: [], detail: e.message };
    }
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
function readGpuUtilization() {
    try {
        const res = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu,utilization.memory,utilization.encoder,utilization.decoder,memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2000 });
        if (res.error || !res.stdout) return null;
        const [gpuPct, memPct, encPct, decPct, vramUsedMb, vramTotalMb] = res.stdout.trim().split(',').map((s) => parseFloat(s.trim()));
        if (Number.isNaN(gpuPct)) return null;
        return { gpuPercent: gpuPct, gpuMemPercent: memPct, encoderPercent: encPct, decoderPercent: decPct, vramUsedMb, vramTotalMb };
    } catch (e) { return null; }
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
function resolveWindowTitle(matchId) {
    const prefix = windowTitleFor(matchId);
    try {
        const script = ENUM_WINDOWS_PS_TEMPLATE.replace('__PREFIX__', prefix);
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const res = spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
        ], { encoding: 'utf8', timeout: 5000 });
        const title = (res.stdout || '').trim();
        if (!title) {
            const reason = res.error ? res.error.message : (res.stderr || '').trim().slice(0, 300) || 'no visible window title matched';
            console.log(`[stream-engine] resolveWindowTitle: could not resolve exact title for "${prefix}" (${reason}) — falling back to bare prefix; gdigrab will likely report "Can't find window" if the Live Output window isn't actually open`);
        }
        return title || prefix;
    } catch (e) {
        console.log(`[stream-engine] resolveWindowTitle: powershell lookup threw (${e.message}) — falling back to bare prefix for "${prefix}"`);
        return prefix;
    }
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
        const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
const CAPTURE_PROFILE_DIR = path.join(__dirname, 'StreamEngineData', 'CaptureBrowserProfile');

const captureWindow = {
    proc: null,
    matchId: null,
    launchedAt: null,
    execPath: null,
    lastCameraEndedAt: null,
    lastCameraEndedReason: null,
};

function launchCaptureWindow({ matchId, videoDeviceId, origin, width, height }) {
    if (captureWindow.proc && captureWindow.matchId === matchId) return { ok: true, alreadyRunning: true };
    if (captureWindow.proc) closeCaptureWindow(); // switching matches — release the old one first
    if (!NATIVE_CAPTURE_SUPPORTED) return { ok: false, error: `Dedicated capture window launch needs Windows — this process is running on ${process.platform}` };
    const execPath = resolveCaptureBrowserExecutable();
    if (!execPath) return { ok: false, error: 'Could not find Chrome or Edge on this PC (checked the usual install paths) — set the CAPTURE_BROWSER_PATH environment variable to its full .exe path, or use the fallback popup window' };
    if (!origin) return { ok: false, error: "origin required (the Cricket Panel's own page URL) — cannot build the Live Output URL" };
    try { fs.mkdirSync(CAPTURE_PROFILE_DIR, { recursive: true }); } catch (e) { /* best effort — Chromium will still create it */ }

    const url = `${String(origin).replace(/\/+$/, '')}/live-output.html?room=${encodeURIComponent(matchId)}&video=${encodeURIComponent(videoDeviceId || '')}`;
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
        // Chromium pauses/throttles a window's rendering when it THINKS
        // another window occludes it — gdigrab still reads whatever's
        // on screen regardless, so that mismatch alone can look like a
        // frozen/stale program feed even though nothing actually failed.
        '--disable-features=CalculateNativeWinOcclusion',
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
        proc = spawn(execPath, args, { stdio: 'ignore', detached: false });
    } catch (e) {
        return { ok: false, error: `Could not launch capture browser: ${e.message}` };
    }
    captureWindow.proc = proc;
    captureWindow.matchId = matchId;
    captureWindow.launchedAt = Date.now();
    captureWindow.execPath = execPath;
    captureWindow.lastCameraEndedAt = null;
    captureWindow.lastCameraEndedReason = null;
    proc.on('exit', (code, signal) => {
        if (captureWindow.proc !== proc) return; // already superseded/closed
        console.log(`[stream-engine] dedicated capture window exited (code=${code}, signal=${signal})`);
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
function gracefulStop(proc, killTimeoutMs = 5000) {
    if (!proc) return;
    try { proc.stdin.write('q'); } catch (e) { /* already gone */ }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ } }, killTimeoutMs);
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
const FATAL_ERROR_PATTERN = /unrecognized option|no such filter|cannot find a matching stream|invalid argument|no nvenc capable devices|unable to open|permission denied|no such file|unknown encoder/i;
function isFatalError(message) {
    return !!message && (FATAL_ERROR_PATTERN.test(message) || WINDOW_NOT_FOUND_PATTERN.test(message));
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
    if (!NATIVE_CAPTURE_SUPPORTED) return { ok: false, error: `Native capture (gdigrab/dshow) requires Windows — this process is running on ${process.platform}` };
    if (!streamUrl) return { ok: false, error: 'No Stream URL set' };
    if (!isValidRtmpUrl(streamUrl)) return { ok: false, error: 'Stream URL must start with rtmp:// or rtmps://' };
    if (!streamKey) return { ok: false, error: 'No Stream Key set' };
    if (!engine.matchId) return { ok: false, error: 'No matchId — Go Live must be started from the Cricket Panel with a match selected' };
    if (!engine.audioDeviceName) return { ok: false, error: 'No audio device selected — pick one under Live Studio first' };
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
    const windowTitle = resolveWindowTitle(engine.matchId);
    const args = buildLiveEncoderArgs({ windowTitle, audioDeviceName: engine.audioDeviceName, ...resolved, destinationUrl });
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    engine.proc = proc;
    engine.startedAt = Date.now();
    engine.state = 'live';
    proc.stdin.on('error', () => {}); // stdin is only ever used for the graceful 'q' stop (see gracefulStop) — a write after it's already gone is harmless

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        let idx;
        while ((idx = stderrBuf.indexOf('\n')) >= 0) {
            const line = stderrBuf.slice(0, idx).trim();
            stderrBuf = stderrBuf.slice(idx + 1);
            parseProgressLine(line);
            if (!line) continue;
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
        }
    });

    // Once this process has survived a few seconds without exiting, treat
    // the connection as genuinely re-established and reset the reconnect
    // attempt counter — otherwise a stream that's been flapping for an
    // hour would keep reporting attempt #40 forever even after it's fine.
    const stabilizeTimer = setTimeout(() => {
        if (engine.proc === proc) engine.reconnect.attempts = 0;
    }, 5000);

    proc.on('exit', (code, signal) => {
        // Same defensive guard as the recorder below — a stale process's
        // own exit must never clobber a newer one already tracked in
        // engine.proc.
        if (engine.proc !== proc) return;
        clearTimeout(stabilizeTimer);
        const wasDesired = engine.desiredLive;
        console.log(`[stream-engine] live encoder ffmpeg exited (code=${code}, signal=${signal}); desiredLive=${wasDesired}`);
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
            setTimeout(() => {
                if (engine.desiredLive) startEncoder(engine.settings);
            }, Math.min(2000 * attempt, 8000));
            return;
        }

        // Everything else (connection reset, broken pipe, timeout, i/o
        // error, etc.) is treated as the internet going up and down —
        // never let a live sports stream just give up over this.
        scheduleReconnect();
    });

    proc.on('error', (err) => {
        console.log('[stream-engine] live encoder ffmpeg spawn error:', err.message);
        engine.lastError = err.message;
        engine.state = 'crashed';
    });

    return { ok: true };
}

function stopEncoder() {
    engine.desiredLive = false;
    if (!engine.proc) { engine.state = 'idle'; return { ok: true, alreadyIdle: true }; }
    engine.state = 'stopping';
    gracefulStop(engine.proc);
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
const RECORDING_ROOT = path.join(__dirname, 'StreamEngineData', 'Recordings');
try { fs.mkdirSync(RECORDING_ROOT, { recursive: true }); } catch (e) { /* created lazily per-match anyway */ }
// Real, final MP4 clip files — cut STRICTLY from RECORDING_ROOT's
// master.mp4 (see cutLocalClip/findRecordingSegmentFor below), never
// from YouTube, HLS, or any browser-side source. Sits alongside
// Recordings/ under the same StreamEngineData root.
const CLIPS_ROOT = path.join(__dirname, 'StreamEngineData', 'Clips');
try { fs.mkdirSync(CLIPS_ROOT, { recursive: true }); } catch (e) { /* created lazily per-match anyway */ }
// Deliberately independent of the live-stream ABR ladder — this is a
// fixed local recording quality, never adapted to network conditions.
const RECORDING_BITRATE_KBPS = { '480p': 2500, '720p': 5000, '1080p': 8000 };

function recorderDir(matchId) {
    return path.join(RECORDING_ROOT, safeMatchId(matchId));
}

const recorder = {
    state: 'idle',            // idle | starting | recording | stopping | crashed
    proc: null,
    matchId: null,
    audioDeviceName: null,
    desiredRecording: false,
    startedAt: null,          // when the CURRENT segment started (not the whole match, if it had to restart)
    segmentPath: null,
    segments: [],             // [{path, startedAt}] — normally just one; more than one only if a crash forced a new file (see below)
    settings: null,           // {resolution, width, height, fps, bitrateKbps}
    restarts: [],
    lastError: null,
    lastProgramFeedHealth: null, // {ok, black, white, frozen, checkedAt} — see runProgramFeedHealthCheck/monitorProgramFeedHealth
};

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
        '-f', 'mp4',
        outFile,
    ];
}

function startRecorder(matchId, { resolution, fps, audioDeviceName } = {}) {
    if (recorder.state === 'recording' || recorder.state === 'starting') {
        if (recorder.matchId === matchId) return { ok: true, alreadyRecording: true };
        return { ok: false, error: `Already recording match "${recorder.matchId}" — stop that first` };
    }
    if (!NATIVE_CAPTURE_SUPPORTED) return { ok: false, error: `Native capture (gdigrab/dshow) requires Windows — this process is running on ${process.platform}` };
    if (!audioDeviceName) return { ok: false, error: 'No audio device selected — pick one under Live Studio first' };
    const resKey = RESOLUTIONS[resolution] ? resolution : '1080p';
    const fpsNum = [30, 60].includes(Number(fps)) ? Number(fps) : 30;
    const { width, height } = RESOLUTIONS[resKey];
    const bitrateKbps = RECORDING_BITRATE_KBPS[resKey];

    const dir = recorderDir(matchId);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: `Could not create recording folder: ${e.message}` }; }

    recorder.matchId = matchId;
    recorder.audioDeviceName = audioDeviceName;
    recorder.desiredRecording = true;
    recorder.settings = { resolution: resKey, width, height, fps: fpsNum, bitrateKbps };
    const fileName = recorder.segments.length === 0 ? 'master.mp4' : `master_part${recorder.segments.length + 1}.mp4`;
    const outFile = path.join(dir, fileName);
    recorder.segmentPath = outFile;
    recorder.state = 'starting';
    recorder.startedAt = Date.now();
    recorder.lastError = null;

    const windowTitle = resolveWindowTitle(matchId);
    const args = buildRecorderArgs({ windowTitle, audioDeviceName, width, height, fps: fpsNum, bitrateKbps, outFile });
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    recorder.proc = proc;
    recorder.state = 'recording';
    recorder.segments.push({ path: outFile, startedAt: recorder.startedAt });
    proc.stdin.on('error', () => {}); // stdin is only ever used for the graceful 'q' stop (see gracefulStop)

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        let idx;
        while ((idx = stderrBuf.indexOf('\n')) >= 0) {
            const line = stderrBuf.slice(0, idx).trim();
            stderrBuf = stderrBuf.slice(idx + 1);
            if (!line) continue;
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
        }
    });

    proc.on('exit', (code, signal) => {
        // A stale/superseded process's own exit must never clobber a
        // NEWER recording that's since taken over recorder.proc (e.g.
        // this exact process was stopped by /recording-start switching
        // to a different match while it was still shutting down) — only
        // the process CURRENTLY tracked gets to mutate shared state.
        if (recorder.proc !== proc) return;
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
            if (recorder.desiredRecording) startRecorder(recorder.matchId, { resolution: recorder.settings.resolution, fps: recorder.settings.fps, audioDeviceName: recorder.audioDeviceName });
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
    gracefulStop(recorder.proc);
    return { ok: true };
}

function resetRecorderForNewMatch() {
    recorder.segments = [];
    recorder.restarts = [];
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
    state: 'idle', // idle | cutting | uploading
    lastError: null,
    cloudflareConnected: true, // optimistic until a forward attempt actually fails
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
// local .mp4 is only deleted once server.js has confirmed it received
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
            // Render has confirmed BOTH R2 and Drive now have this clip —
            // only NOW is the operator's own local copy redundant. Never
            // deleted any earlier than this.
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

// 🔒 CLIP SOURCE = LOCAL MASTER RECORDING, STRICTLY — non-negotiable.
// Clips are cut by seeking directly into the actual recorder segment
// file on disk — the exact same bytes YouTube's audience and the local
// master both came from — never YouTube, never HLS, never a browser
// blob/chunk, never R2/Drive.
//
// Finds which recorder segment (normally just one; more than one only
// if the recorder itself crash-restarted mid-match) covers a given
// event time, by each segment's own startedAt window.
function findRecordingSegmentFor(eventTimestamp) {
    const segs = recorder.segments;
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const next = segs[i + 1];
        const segEndMs = next ? next.startedAt : Date.now();
        if (eventTimestamp >= seg.startedAt && eventTimestamp <= segEndMs) return seg;
    }
    return segs.length ? segs[segs.length - 1] : null; // still-active last segment as a fallback
}

function clipsDirFor(matchId) {
    const dir = path.join(CLIPS_ROOT, safeMatchId(matchId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function cutLocalClip({ clipId, matchId, eventTimestamp }) {
    const seg = findRecordingSegmentFor(eventTimestamp);
    if (!seg) {
        return { ok: false, error: `No local master recording available for match "${matchId}" yet — press "Start Recording" first and confirm the recorder is actually running (see /status).` };
    }
    if (!fs.existsSync(seg.path)) {
        return { ok: false, error: `Local master recording file is missing on disk: ${seg.path}` };
    }

    const offsetSec = (eventTimestamp - seg.startedAt) / 1000;
    const fromSec = Math.max(0, offsetSec - CLIP_PRE_ROLL_SEC);
    const durationSec = CLIP_PRE_ROLL_SEC + CLIP_POST_ROLL_SEC;

    // Deterministic, clipId-based filename (not Date.now()-based) — a
    // job re-run for the exact same event never leaves multiple .mp4s
    // behind, and this is the SAME name server.js's R2 key/Drive
    // filename are derived from, so the whole pipeline refers to one
    // clip by one identity end to end.
    const outFile = path.join(clipsDirFor(matchId), `${clipId}.mp4`);

    console.log(`[CLIP RANGE] clipId=${clipId} source=${path.basename(seg.path)} start=T0-${CLIP_PRE_ROLL_SEC}s end=T0+${CLIP_POST_ROLL_SEC}s`);

    await cutFromMasterFile({ masterFile: seg.path, fromSec, durationSec, outFile });

    console.log(`[CLIP CREATED] clipId=${clipId} localPath=${outFile}`);
    return { ok: true, outFile };
}

// Seeks directly into the local master.mp4 with -ss BEFORE -i (fast
// input-side seek — reads/decodes only from the nearest preceding
// keyframe onward, never the whole multi-hour recording) and re-encodes
// only the ~20s window that's actually needed. Because the master is
// recorded with a fixed 2s GOP, a clip's true start is at most ~2s
// later than requested in the worst case — a normal, expected trade-off
// for fast seeking into a live-recorded file, not a bug.
//
// 🔒 CONCURRENT-CLIP GPU SAFETY NET — clips are cut independently and in
// PARALLEL (a clip never waits in a queue behind another clip — one
// slow/stuck cut must never delay or block a different one). The
// recorder and the live encoder also each hold their own NVENC session
// the whole time they're running. Some GPUs (older GeForce cards
// especially) cap how many concurrent NVENC sessions are allowed at
// once — if two clips land at almost the same moment while
// Recording+Live are both also running, that cap can be hit and the
// GPU encode for one of the clips fails outright. Rather than let that
// clip come back as a hard failure, this retries the SAME cut once on
// the CPU (libx264) before giving up — slower for that one clip, but it
// still gets made instead of being lost. Recording and the live stream
// are never affected either way (they don't share this retry path).
async function cutFromMasterFile({ masterFile, fromSec, durationSec, outFile }) {
    const attempt = (useNvenc) => new Promise((resolve, reject) => {
        const args = [
            '-hide_banner', '-loglevel', 'warning', '-y',
            '-ss', String(fromSec), '-i', masterFile, '-t', String(durationSec),
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
        const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg clip cut (${useNvenc ? 'NVENC' : 'CPU'}) exited ${code}: ${stderr.slice(-500)}`)));
        proc.on('error', reject);
    });

    const preferNvenc = checkNvencRuntime();
    try {
        await attempt(preferNvenc);
    } catch (e) {
        if (!preferNvenc) throw e; // was already the CPU attempt — nothing left to fall back to
        console.log(`[stream-engine] Clip cut failed on NVENC (likely a concurrent-session limit — another clip/the recorder/the live encoder is using the GPU right now), retrying on CPU: ${e.message}`);
        await attempt(false);
    }
}

// ================================================================
// 🎬 THE JOB, END TO END — runs once, ~CLIP_POST_ROLL_SEC after the
// event, and is NEVER canceled/re-triggered by anything that happens
// on the panel afterward. A failure at ANY stage moves the job to
// RETRY_PENDING/FAILED_PERMANENT — it never just disappears.
// ================================================================
async function runClipJob(clipId) {
    const job = clipJobs.get(clipId);
    if (!job) return; // shouldn't happen — created synchronously in acceptClipEvent below
    const { matchId, eventType, timestamp, ballMeta, mainServerUrl } = job;

    updateJob(clipId, { status: 'CUTTING' });
    clipWorker.state = 'cutting';
    console.log(`[CLIP WAIT] clipId=${clipId} post-roll wait complete — cutting now`);
    const cutResult = await cutLocalClip({ clipId, matchId, eventTimestamp: timestamp }).catch((e) => ({ ok: false, error: e.message }));
    if (!cutResult.ok) {
        clipWorker.state = 'idle';
        clipWorker.lastError = cutResult.error;
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
        updateJob(clipId, { status: 'RETRY_PENDING' }); // becomes COMPLETE once polling confirms both uploads
        pollRenderStatus(job);
        return;
    }
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

    const waitMs = Math.max(0, (timestamp + CLIP_POST_ROLL_SEC * 1000) - Date.now());
    console.log(`[CLIP WAIT] clipId=${clipId} waiting ${waitMs}ms for post-roll`);
    setTimeout(() => runClipJob(clipId), waitMs);

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
            restartCount: recorder.restarts.length,
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
// dropdown. Video device enumeration is intentionally NOT offered here:
// the "camera" ffmpeg captures is the Live Output window (see
// windowTitleFor), not a raw camera device — live-output.html still
// picks the actual camera via the browser's own getUserMedia for its
// on-screen preview/composite, unchanged.
app.get('/audio-devices', (req, res) => {
    const { devices, detail } = listAudioDevices();
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
    const result = launchCaptureWindow({ matchId, videoDeviceId: body.videoDeviceId, origin: body.origin, width: body.width, height: body.height });
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

// 🖼️ CAPTURE PREVIEW — grabs exactly one frame from the target window
// and returns it as a JPEG, so the operator can SEE the crop margin
// (captureConfig) and confirm gdigrab is actually finding the Live
// Output window BEFORE going live. This exists specifically because
// exact OS title-bar/DPI pixel dimensions can't be verified without the
// real machine — this endpoint lets the operator verify it themselves.
app.get('/capture-preview', (req, res) => {
    const matchId = safeMatchId(req.query.matchId);
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
    if (!NATIVE_CAPTURE_SUPPORTED) return res.status(400).json({ success: false, error: `Native capture requires Windows — this process is running on ${process.platform}` });
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
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

// ----------------------------------------------------------------
// 🎬 ClipperHelper.exe-COMPATIBLE ENDPOINTS
//
// cricket-panel.html's recordBall()/triggerWicketClip() code was built
// against ClipperHelper.exe's contract: /recording-start, /recording-
// stop, /clip. That JS is unchanged in shape — only the URL it's
// pointed at, and the recording-start payload's audioDeviceName, changed.
// ----------------------------------------------------------------
app.post('/recording-start', (req, res) => {
    const matchId = safeMatchId(req.body && req.body.matchId);
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
    const mainServerUrl = (req.body && req.body.mainServerUrl) || null;
    const tournamentId = (req.body && req.body.tournamentId) || null;
    const resolution = (req.body && req.body.recordingResolution) || '1080p';
    const fps = (req.body && req.body.recordingFps) || 30;
    const audioDeviceName = (req.body && req.body.audioDeviceName) || null;

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
    const recResult = startRecorder(matchId, { resolution, fps, audioDeviceName });
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

app.post('/go-live', async (req, res) => {
    const { resolution, fps, bitrateKbps, keyframeIntervalSec, qualityMode, autoResolutionFallback, matchId, audioDeviceName, skipProgramFeedHealthCheck } = req.body || {};
    engine.opToken++; // a fresh operator-initiated Go Live always wins over any stale in-flight ABR restart

    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required — select a match in the panel first' });
    if (!audioDeviceName) return res.status(400).json({ success: false, error: 'audioDeviceName required — pick a microphone/capture-card audio device under Live Studio first' });
    engine.matchId = safeMatchId(matchId);
    engine.audioDeviceName = audioDeviceName;

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
    if (NATIVE_CAPTURE_SUPPORTED && !skipProgramFeedHealthCheck) {
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
            retryQueueLength: retryQueue.length,
        },
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
}
setInterval(() => { monitorProgramFeedHealth().catch((e) => console.log('[stream-engine] monitorProgramFeedHealth error (kept running):', e.message)); }, PROGRAM_FEED_MONITOR_INTERVAL_MS);

// 🛟 Safety-net clip-file sweep — catches a clip whose normal "delete
// once Render confirms COMPLETE" path (pollRenderStatus above) never
// got the chance to run. A generous 24h default: never the everyday
// cleanup mechanism, just a backstop against a truly abandoned file.
function sweepOldClipFiles(maxAgeMs) {
    fs.readdir(CLIPS_ROOT, (err, matchDirs) => {
        if (err) return;
        matchDirs.forEach((matchId) => {
            const dir = path.join(CLIPS_ROOT, matchId);
            fs.readdir(dir, (err2, files) => {
                if (err2) return;
                files.forEach((f) => {
                    const filePath = path.join(dir, f);
                    fs.stat(filePath, (statErr, stats) => {
                        if (statErr || !stats.isFile()) return;
                        if (Date.now() - stats.mtimeMs > maxAgeMs) {
                            // Never sweep a file a live job still references.
                            const stillTracked = [...clipJobs.values()].some((j) => j.localPath === filePath && j.status !== 'FAILED_PERMANENT');
                            if (!stillTracked) fs.unlink(filePath, () => {});
                        }
                    });
                });
            });
        });
    });
}
const ORPHAN_CLIP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
setTimeout(() => sweepOldClipFiles(ORPHAN_CLIP_FILE_MAX_AGE_MS), 90 * 1000);
setInterval(() => sweepOldClipFiles(ORPHAN_CLIP_FILE_MAX_AGE_MS), 60 * 60 * 1000);

const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`🎥 AllSportsLive Stream Engine (native capture) running at http://127.0.0.1:${PORT} (localhost only)`);
    console.log(`   Platform: ${process.platform}${NATIVE_CAPTURE_SUPPORTED ? '' : ' — ⚠️ native capture (gdigrab/dshow) needs Windows; this engine cannot capture on this OS'}`);
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
// (recorder OR live encoder OR a clip-cut in flight) when this engine is
// stopped/restarted, e.g. by the operator, a crash-recovery script, or
// the OS.
// ----------------------------------------------------------------
let shuttingDown = false;
function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[stream-engine] ${signal} received — shutting down gracefully`);
    engine.desiredLive = false;   // don't let the exit handler try to auto-restart
    recorder.desiredRecording = false;
    if (engine.proc) gracefulStop(engine.proc, 3000);
    if (recorder.proc) gracefulStop(recorder.proc, 3000);
    if (captureWindow.proc) closeCaptureWindow(); // never leave the dedicated capture browser process orphaned
    server.close(() => {
        console.log('[stream-engine] HTTP server closed, exiting');
        process.exit(0);
    });
    // Don't hang forever waiting for connections to drain.
    setTimeout(() => process.exit(0), 5000);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
