// ================================================================
// 🎬 NATIVE PROGRAM FEED PIPELINE — replaces the gdigrab-based
// "render camera+overlay in a browser window, screen-capture that
// window" approach with a real native pipeline that never screen/
// window-captures anything:
//
//   CAMERA (dshow, opened ONCE)
//   + OVERLAY (Chrome DevTools Protocol screencast — see
//     overlayBridge.js — reads frames straight from Chromium's
//     renderer, never from the OS screen)
//         ↓
//   COMPOSITOR (one ffmpeg process; opens the camera exactly once)
//         ↓ relays the composited frames out its own stdout,
//           uncompressed (rawvideo/NUT — cheap, no extra GPU
//           session, nothing ever displays this directly)
//         ├──→ RECORDER-ENCODER (its own NVENC session) → master.mp4
//         └──→ LIVE-ENCODER (its own NVENC session) → RTMPS → YouTube
//
// WHY THIS SHAPE, SPECIFICALLY: a physical camera (unlike a browser
// window, which is a shareable OS surface) can normally only be opened
// by ONE process at a time — so recording and streaming can no longer
// each independently open the camera the way they each independently
// gdigrab'd the old Live Output window. Routing both through ONE
// compositor's relay, with each consumer holding its own encoder
// session downstream, keeps the hard requirement intact: a YouTube
// reconnect/crash never touches the recorder, and vice versa, because
// neither one talks to the other directly, only to the compositor's
// relay (and Node actively drains that relay — see attachRelayConsumer
// below — so a stalled consumer can never block the compositor itself,
// which is the well-known failure mode of ffmpeg's own multi-output
// muxing sharing one process).
//
// The compositor is reference-counted (ensureCompositorRunning /
// releaseCompositorIfUnused): it starts the moment EITHER recording or
// streaming needs it, and only stops once NEITHER does — mirroring the
// same pattern cricket-panel.html already uses for the old Live Output
// window (ensureLiveOutputWindow/releaseLiveOutputWindowIfUnused).
// ================================================================
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { OverlayBridge, available: overlayBridgeAvailable } = require('./overlayBridge');

// Modest, steady rate for the overlay input — a scoreboard doesn't need
// full 30fps of its own repaint cadence; this just needs to be fast
// enough that a score change reaches the program feed without a
// noticeable delay. See overlayBridge.js's header comment for why this
// is a STEADY re-emit rate, not tied to how often the page actually
// repaints.
const OVERLAY_FPS = 15;

const RELAY_CONTAINER_ARGS = ['-f', 'nut', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', '44100'];

// 🎯 AUTO-DETECT CAMERA MODE — the vMix-style piece: instead of a
// hardcoded -video_size/-framerate that only happened to be right for
// one specific capture card (twice confirmed wrong in the field for the
// AVMATRIX USB card — see git history), ask the device itself what it
// actually supports (`ffmpeg -f dshow -list_options true -i video=...`,
// the same command used to hand-diagnose this earlier) and pick a real,
// device-confirmed mode automatically. Runs once per Compositor
// lifetime (cached on the instance), not on every retry.
//
// Parses lines like:
//   pixel_format=yuyv422  min s=960x540 fps=60.0002 max s=960x540 fps=60.0002
//   vcodec=mjpeg  min s=1920x1080 fps=29.9700 max s=1920x1080 fps=29.9700
// NOTE: min===max on most fixed-mode capture cards (confirmed on the
// AVMATRIX — its EVERY mode is fixed, not a range); when they differ,
// this clamps the desired target fps into the device's actual [min,max].
const DSHOW_MODE_LINE = /(?:vcodec|pixel_format)=(\S+)\s+min\s+s=(\d+)x(\d+)\s+fps=([\d.]+)\s+max\s+s=(\d+)x(\d+)\s+fps=([\d.]+)/g;

function parseDshowVideoModes(listOptionsOutput) {
    const modes = [];
    let m;
    DSHOW_MODE_LINE.lastIndex = 0;
    while ((m = DSHOW_MODE_LINE.exec(listOptionsOutput))) {
        const [, , minW, minH, minFps, , , maxFps] = m;
        // vcodec=<name> means a compressed format (mjpeg etc) — far
        // lighter over USB than a raw pixel_format at the same
        // resolution, so this is worth knowing when choosing.
        const compressed = listOptionsOutput.slice(m.index, m.index + 6) === 'vcodec';
        modes.push({
            compressed,
            width: Number(minW), height: Number(minH),
            minFps: Number(minFps), maxFps: Number(maxFps),
        });
    }
    return modes;
}

// Safety ceiling for RAW (uncompressed) modes only — this is what
// overran the real-time buffer at 1920x1080@60 on the AVMATRIX card
// (~250 MB/s, confirmed in the field). Compressed (vcodec=) modes are
// assumed safe regardless of resolution since onboard compression does
// the heavy lifting before it ever reaches USB.
const RAW_BANDWIDTH_CAP_BYTES_PER_SEC = 40 * 1024 * 1024;

function pickCameraMode(listOptionsOutput, targetWidth, targetHeight, targetFps) {
    const modes = parseDshowVideoModes(listOptionsOutput);
    if (!modes.length) return null;
    const targetArea = targetWidth * targetHeight;
    const scored = modes.map((mode) => {
        const fps = Math.min(mode.maxFps, Math.max(mode.minFps, targetFps));
        const rawBytesPerSec = mode.width * mode.height * 2 * fps; // ~2 bytes/px is the common packed-4:2:2/YUYV case
        const safe = mode.compressed || rawBytesPerSec <= RAW_BANDWIDTH_CAP_BYTES_PER_SEC;
        return { ...mode, fps, area: mode.width * mode.height, safe };
    });
    const safeModes = scored.filter((m) => m.safe);
    const pool = safeModes.length ? safeModes : scored; // nothing "safe"? better a working overshoot than no camera at all
    // Prefer compressed modes outright, then the mode whose resolution is
    // closest to the target without exceeding it, then the closest
    // overall if none fit under the target.
    pool.sort((a, b) => {
        if (a.compressed !== b.compressed) return a.compressed ? -1 : 1;
        const aFits = a.area <= targetArea, bFits = b.area <= targetArea;
        if (aFits !== bFits) return aFits ? -1 : 1;
        return Math.abs(a.area - targetArea) - Math.abs(b.area - targetArea);
    });
    return pool[0];
}

function buildCompositorArgs({ cameraDeviceName, audioDeviceName, width, height, fps, previewPath, cameraVideoSize, cameraFramerate }) {
    const filterComplex =
        `[0:v]scale=${width}:${height}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p[cam];` +
        `[2:v]scale=${width}:${height},format=rgba[ovl];` +
        `[cam][ovl]overlay=0:0:format=auto,format=yuv420p,split=2[vout1][vout2]`;
    const args = [
        '-hide_banner', '-loglevel', 'warning',
        // Input 0: camera (video only). Input 1: mic/capture-card audio
        // (separate dshow input, NOT combined as one "video=X:audio=Y"
        // graph) — 🩹 CONFIRMED IN THE FIELD: the combined syntax failed
        // with a generic "Error opening input files: I/O error" the
        // moment video and audio came from two independent physical
        // devices (a very common real setup — separate camera + mic/
        // capture-card), which ffmpeg's dshow demuxer doesn't reliably
        // bind together as one graph. Two independent dshow inputs is
        // the more robust, standard approach and works the same whether
        // the devices are physically the same hardware or not. Opened
        // ONCE (both), natively — no browser, no screen/window capture
        // anywhere in this path.
        // 🩹 A hardcoded -video_size/-framerate here was wrong twice in
        // the field (AVMATRIX USB card: forcing an unsupported combo
        // failed outright with "Could not set video options" / I/O
        // error; forcing NOTHING let ffmpeg's dshow demuxer default to
        // its heaviest mode, 1920x1080@~60 raw/uncompressed, ~250 MB/s
        // over USB — reliably overran the real-time buffer). cameraMode
        // is resolved by probeCameraMode() below FROM THE DEVICE ITSELF
        // (ffmpeg -f dshow -list_options true), the same command used to
        // hand-diagnose this — no more guessing per device.
        '-f', 'dshow', '-rtbufsize', '512M',
        ...(cameraVideoSize ? ['-video_size', cameraVideoSize] : []),
        ...(cameraFramerate ? ['-framerate', String(cameraFramerate)] : []),
        '-i', `video=${cameraDeviceName}`,
        // Its own -rtbufsize too — confirmed in the field alongside the
        // video buffer overrun above: ffmpeg's dshow default (~2.9 MB) is
        // small enough that the audio input dropped frames right along
        // with the video one once the pipeline fell behind.
        '-f', 'dshow', '-rtbufsize', '64M', '-i', `audio=${audioDeviceName}`,
        // Input 2: the overlay — a continuous stream of complete PNG
        // files written back-to-back to this process's own stdin by
        // overlayBridge.js's pipeTo() (image2pipe's png demuxer can tell
        // consecutive PNGs apart on its own; no extra framing needed).
        '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(OVERLAY_FPS), '-thread_queue_size', '512', '-i', 'pipe:0',
        '-filter_complex', filterComplex,
    ];
    // Output 1: the relay — always present. Nothing ever displays this
    // directly, so it's deliberately NOT re-encoded here (that would
    // cost a second NVENC session AND a lossy compress pass for
    // something no one watches) — plain rawvideo/NUT, decoded once more
    // downstream by whichever consumer(s) actually need it.
    args.push('-map', '[vout1]', '-map', '1:a', ...RELAY_CONTAINER_ARGS, 'pipe:1');
    // Output 2: a cheap, low-frame-rate JPEG snapshot written to a local
    // file, overwritten in place — this is what GET /capture-preview
    // (see server.js) serves as the "Program Preview". It's a REAL
    // consumer of the same [vout2] composited stream (camera+overlay
    // together), not a re-capture of anything — satisfies "the preview
    // must show the real program frame" without needing a live pull
    // from the relay pipe on every request.
    if (previewPath) {
        // 🩹 CONFIRMED IN THE FIELD: '-vf fps=2' here fails outright —
        // "Simple and complex filtering cannot be used together for the
        // same stream" — because [vout2] is already fed from
        // -filter_complex above; ffmpeg won't also bolt a plain -vf onto
        // it. '-r' is an output frame-rate option (not a filter), so it
        // works on a complex-filtergraph-sourced stream the same way.
        args.push('-map', '[vout2]', '-an', '-r', '2', '-update', '1', '-y', previewPath);
    }
    return args;
}

function buildRecorderEncoderArgs({ width, height, fps, bitrateKbps, outFile, useNvenc }) {
    const videoArgs = useNvenc
        ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-b:v', `${bitrateKbps}k`, '-maxrate', `${Math.round(bitrateKbps * 1.3)}k`]
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${bitrateKbps}k`];
    return [
        '-hide_banner', '-loglevel', 'warning',
        '-f', 'nut', '-thread_queue_size', '1024', '-i', 'pipe:0',
        '-r', String(fps),
        ...videoArgs,
        // Short (2s) GOP + fragmented MP4 — same crash-safety reasoning
        // as the old gdigrab-based recorder: at most ~2s of footage is
        // ever at risk if this process is killed, and the file stays
        // playable up to the last flushed fragment rather than becoming
        // a zero-byte/unplayable file on an abrupt stop.
        '-g', String(fps * 2), '-keyint_min', String(fps * 2),
        '-af', 'aresample=async=1:first_pts=0',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-flush_packets', '1',
        '-max_muxing_queue_size', '4096',
        '-f', 'mp4', outFile,
    ];
}

function buildLiveEncoderArgs({ width, height, fps, bitrateKbps, keyframeIntervalSec, destinationUrl, useTune }) {
    const gop = Math.round(fps * keyframeIntervalSec);
    return [
        '-hide_banner', '-loglevel', 'warning',
        '-f', 'nut', '-thread_queue_size', '1024', '-i', 'pipe:0',
        // The relay carries the RECORDER's fixed resolution regardless
        // of the operator's selected/ABR-adjusted STREAMING resolution
        // — this scales down (or up) to whatever this encoder was asked
        // to actually push.
        '-vf', `scale=${width}:${height}:flags=lanczos`,
        '-r', String(fps),
        '-c:v', 'h264_nvenc',
        '-preset', 'p4', ...(useTune ? ['-tune', 'll'] : []),
        '-rc', 'cbr',
        '-b:v', `${bitrateKbps}k`,
        '-maxrate', `${bitrateKbps}k`,
        '-bufsize', `${bitrateKbps * 2}k`,
        '-g', String(gop), '-keyint_min', String(gop),
        '-bf', '0',
        '-af', 'aresample=async=1:first_pts=0',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
        '-max_muxing_queue_size', '4096',
        '-f', 'flv',
        '-progress', 'pipe:2', '-nostats',
        destinationUrl,
    ];
}

// ----------------------------------------------------------------
// 🔗 COMPOSITOR — ref-counted (see this file's header comment). One
// instance total; started by whichever of recording/streaming asks for
// it first, released once neither still wants it.
// ----------------------------------------------------------------
class Compositor extends EventEmitter {
    constructor({ spawnFfmpeg, spawnFfmpegSync, execPath, overlayUrl, width, height, fps, previewPath }) {
        super();
        this.spawnFfmpeg = spawnFfmpeg;
        this.spawnFfmpegSync = spawnFfmpegSync;
        this.execPath = execPath;
        this.overlayUrl = overlayUrl;
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.previewPath = previewPath;
        this.proc = null;
        this.overlay = null;
        this.stopOverlayPipe = null;
        this.state = 'idle'; // idle | starting | running | stopping | crashed
        this.refs = new Set(); // 'recorder' | 'live' — who currently needs this compositor running
        this.consumers = new Set(); // attached relay consumers (see attachRelayConsumer)
        this.lastError = null;
        this.startedAt = null;
        this.cameraMode = null; // resolved once by probeCameraMode(), cached for this instance's lifetime
    }

    addRef(who) {
        this.refs.add(who);
    }
    removeRef(who) {
        this.refs.delete(who);
        if (this.refs.size === 0) this.stop();
    }

    // 🎯 vMix-style auto-detect: ask this exact camera what it actually
    // supports and pick a real mode, instead of a hardcoded guess that's
    // only ever right for one specific capture card. Best-effort — a
    // device this can't probe/parse (webcams often don't even print a
    // options list the same way, or list none at all) just falls back to
    // no constraint, same as before probing existed.
    probeCameraMode(cameraDeviceName) {
        if (!this.spawnFfmpegSync) return null;
        try {
            const res = this.spawnFfmpegSync(
                ['-hide_banner', '-f', 'dshow', '-list_options', 'true', '-i', `video=${cameraDeviceName}`],
                { encoding: 'utf8', timeout: 8000 }
            );
            const output = `${res.stdout || ''}${res.stderr || ''}`;
            const mode = pickCameraMode(output, this.width, this.height, this.fps);
            if (mode) {
                console.log(`[compositor] camera mode auto-detected: ${mode.width}x${mode.height}@${mode.fps}${mode.compressed ? ' (compressed)' : ' (raw)'}`);
            } else {
                console.log('[compositor] could not auto-detect a camera mode from -list_options output — opening unconstrained');
            }
            return mode;
        } catch (e) {
            console.log(`[compositor] camera mode probe failed (${e.message}) — opening unconstrained`);
            return null;
        }
    }

    async ensureRunning({ cameraDeviceName, audioDeviceName }) {
        if (this.state === 'running' || this.state === 'starting') return { ok: true };
        if (!overlayBridgeAvailable()) {
            return { ok: false, error: "puppeteer-core is not installed — run 'npm install' in stream-engine/ (see package.json)" };
        }
        this.state = 'starting';
        this.lastError = null;
        if (this.cameraMode === null) this.cameraMode = this.probeCameraMode(cameraDeviceName) || false; // false = "probed, nothing usable" so we don't re-probe every retry
        try {
            this.overlay = new OverlayBridge({ execPath: this.execPath, url: this.overlayUrl, width: this.width, height: this.height });
            await this.overlay.start();
        } catch (e) {
            this.state = 'crashed';
            this.lastError = `Overlay bridge failed to start: ${e.message}`;
            return { ok: false, error: this.lastError };
        }

        const args = buildCompositorArgs({
            cameraDeviceName, audioDeviceName, width: this.width, height: this.height, fps: this.fps, previewPath: this.previewPath,
            cameraVideoSize: this.cameraMode ? `${this.cameraMode.width}x${this.cameraMode.height}` : null,
            cameraFramerate: this.cameraMode ? this.cameraMode.fps : null,
        });
        let proc;
        try {
            proc = this.spawnFfmpeg(args, { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            this.state = 'crashed';
            this.lastError = `Could not launch compositor: ${e.message}`;
            try { await this.overlay.stop(); } catch (e2) { /* best effort */ }
            return { ok: false, error: this.lastError };
        }
        this.proc = proc;
        this.state = 'running';
        this.startedAt = Date.now();
        proc.stdin.on('error', () => {}); // the overlay bridge writes here — a write after the process is gone is harmless

        this.stopOverlayPipe = this.overlay.pipeTo(proc.stdin, OVERLAY_FPS);

        // 🩹 CONFIRMED IN THE FIELD — a serious one: the relay is a NUT
        // container, which (like most streaming containers) writes its
        // main header — stream count, codec/dimensions, everything a
        // demuxer needs just to START interpreting the bytes — ONCE, at
        // the very beginning. ANY consumer whose stdin gets attached
        // after that header has already gone out (recorder starting
        // after live, live starting after recording, or even the FIRST
        // consumer — its own ffmpeg process takes a moment to spawn
        // after ensureCompositor returns, and the compositor's stdout
        // can easily start flowing before that) never sees it, and its
        // own `-f nut -i pipe:0` has nothing valid to lock onto — no
        // error, it just never produces output. This is what silently
        // broke both the live encoder (RTMPS "connected", YouTube "no
        // data") and the recorder (master.mp4 never created at all)
        // even though everything upstream reported healthy.
        // Fix: cache the relay's own early bytes (comfortably more than
        // the header needs) and replay them to EVERY newly-attached
        // consumer before switching them to the live feed — see
        // attachRelayConsumer below. Missing whatever real frames fell
        // between "end of the cached header" and "now" is fine and
        // intended: a consumer just joining doesn't want the past, it
        // wants a valid stream to decode from this point forward.
        this.relayHeaderBuffer = [];
        this.relayHeaderBufferBytes = 0;
        const RELAY_HEADER_CAP_BYTES = 256 * 1024; // NUT's main header is a tiny fraction of this — generous headroom, still trivial memory

        // 🔗 Fan the relay out to every attached consumer. Node drains
        // proc.stdout as fast as its event loop runs regardless of
        // whether any consumer is currently ready for more — this is
        // what guarantees a stalled/slow consumer (e.g. the live
        // encoder mid-reconnect) can NEVER apply backpressure back onto
        // the compositor's own stdout write, which is the standard
        // failure mode of sharing one ffmpeg process across multiple
        // outputs. A write() that returns false just means Node queued
        // it in that consumer's own memory buffer — acceptable for
        // short stalls; a consumer that falls far enough behind is the
        // consumer's own problem to recover from, never the
        // compositor's or the OTHER consumer's.
        proc.stdout.on('data', (chunk) => {
            if (this.relayHeaderBufferBytes < RELAY_HEADER_CAP_BYTES) {
                this.relayHeaderBuffer.push(chunk);
                this.relayHeaderBufferBytes += chunk.length;
            }
            for (const consumer of this.consumers) {
                if (consumer.stdin && consumer.stdin.writable) {
                    try { consumer.stdin.write(chunk); } catch (e) { /* consumer gone — attachRelayConsumer's caller is responsible for detaching */ }
                }
            }
        });

        let stderrBuf = '';
        proc.stderr.on('data', (chunk) => {
            stderrBuf += chunk.toString();
            let idx;
            while ((idx = stderrBuf.indexOf('\n')) >= 0) {
                const line = stderrBuf.slice(0, idx).trim();
                stderrBuf = stderrBuf.slice(idx + 1);
                if (!line) continue;
                // 🩹 Log every line, not just the ones this regex thinks
                // are "the" error — a generic summary line (e.g. "Error
                // opening input files: I/O error") is what ffmpeg prints
                // LAST, after the actually-specific diagnostic lines
                // (which device/input failed and why) that only storing
                // the regex-matched line would silently discard. Full
                // context up front beats a second debugging round-trip.
                console.log(`[compositor] ${line}`);
                if (/error|failed|cannot|invalid|no space/i.test(line)) this.lastError = line;
            }
        });

        proc.on('exit', (code, signal) => {
            if (this.proc !== proc) return;
            console.log(`[nativePipeline] compositor exited (code=${code}, signal=${signal})`);
            this.proc = null;
            const wasRunning = this.state === 'running';
            this.state = 'idle';
            try { if (this.stopOverlayPipe) this.stopOverlayPipe(); } catch (e) {}
            try { if (this.overlay) this.overlay.stop().catch(() => {}); } catch (e) {}
            if (wasRunning && this.refs.size > 0) {
                // Something still wants this running (recorder and/or
                // live) and it died unexpectedly — surface it as an
                // error on the affected consumers rather than silently
                // going dark; server.js's recorder/live-encoder exit
                // handlers own the actual retry/backoff decision.
                this.emit('unexpected-exit', { code, signal, lastError: this.lastError });
            }
        });
        proc.on('error', (err) => {
            this.state = 'crashed';
            this.lastError = err.message;
        });

        return { ok: true };
    }

    // Registers a downstream process's stdin as a relay consumer. The
    // caller is responsible for detaching (removeRelayConsumer) once
    // that process exits — an un-detached dead stdin is just silently
    // skipped by the write() try/catch above, but detaching promptly
    // avoids that overhead piling up across many restarts.
    //
    // Replays the cached relay-header bytes (see the stdout 'data'
    // handler above) BEFORE adding this consumer to the live fan-out —
    // this is what makes it safe to attach at any time, not just at the
    // exact moment the compositor starts. Without this, this consumer's
    // own `-f nut -i pipe:0` would never see NUT's main header and would
    // silently never produce output — the actual root cause behind both
    // the "YouTube: no data" and "master.mp4 missing" symptoms.
    attachRelayConsumer(proc) {
        for (const chunk of this.relayHeaderBuffer) {
            if (proc.stdin && proc.stdin.writable) {
                try { proc.stdin.write(chunk); } catch (e) { return; } // gone already — nothing to attach
            }
        }
        this.consumers.add(proc);
    }
    removeRelayConsumer(proc) {
        this.consumers.delete(proc);
    }

    stop() {
        if (!this.proc) { this.state = 'idle'; return; }
        this.state = 'stopping';
        try { this.proc.stdin.write('q'); } catch (e) {}
        const proc = this.proc;
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 4000);
    }
}

module.exports = {
    Compositor,
    buildCompositorArgs,
    buildRecorderEncoderArgs,
    buildLiveEncoderArgs,
    overlayBridgeAvailable,
    OVERLAY_FPS,
    parseDshowVideoModes,
    pickCameraMode,
};
